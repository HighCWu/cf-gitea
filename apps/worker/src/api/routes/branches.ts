import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { repositories } from "../../db/schema";
import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import {
  branchRef,
  engineCell,
  engineReads,
  refTipMap,
  resolveNamedRef,
  tagRef,
  ZERO_OID,
  commitApiChangeError,
  deleteApiRefError,
} from "../services/engine";
import { toBranch, toPayloadCommit, usernamesByEmail } from "../services/git-models";
import {
  branchSchema,
  createBranchOptionSchema,
  renameBranchOptionSchema,
  updateBranchOptionSchema,
  type Branch,
} from "../models/git";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import {
  assertNotArchived,
  canWriteRepository,
  requireVisibleRepo,
} from "../services/repo-access";
import { toApiRepository, viewerOf, type RepositoryWithOwner } from "../services/repository";
import {
  canUserPush,
  compileRuleName,
  isUserMergeWhitelisted,
  listRepoRules,
  parseRuleConfig,
  principalAccessOf,
  ruleMatches,
  type PrincipalAccess,
  type ProtectedBranchRow,
} from "../../services/branch-protection";
import { emitWebhookDeliveries, type HookEventType } from "../../issues/webhooks";
import type { WebhookDeliveryMessage } from "../../webhooks/consumer";
import type { MiddlewareHandler } from "hono";

/**
 * Tier-1 branch routes (SPEC-0004 §2.4 rows repoListBranches /
 * repoCreateBranch / repoGetBranch / repoUpdateBranch / repoDeleteBranch /
 * repoRenameBranch — 2 paths, 6 operations). Data source: the engine's ref
 * table via the public RPC surface (services/engine.ts); every mutation is a
 * CAS ref landing (commitApiChange / deleteApiRef), so concurrent pushes and
 * API writes serialize on the same refs_version machinery a push uses.
 *
 * Upstream behavior mirrored (routers/api/v1/repo/branch.go):
 *   - empty repos answer 404 "Git Repository is empty." on the mutations and
 *     the single read; the LIST answers 200 [] (upstream IsEmpty short-circuit);
 *   - POST resolves the source ref old_ref_name > old_branch_name > default
 *     branch; duplicate branch / tag name / invalid refname are the 409 family;
 *   - PUT is the ref CAS: old_commit_id mismatch → 422
 *     "branch commit does not match [expected: …, given: …]", a non-fast-
 *     forward without force → 422 "Force push … need a confirm force parameter",
 *     a lost CAS → 409;
 *   - DELETE refuses the default branch with 403 "can not delete default or
 *     pull request target branch";
 *   - PATCH renames create-then-delete (the engine has no rename primitive);
 *     renaming the default branch updates meta.head via setHead + the D1
 *     default_branch column, admin-gated (upstream RenameBranch).
 *
 * Declared responses mirror the vendored contract exactly. RUNTIME-ONLY code
 * the handlers can still emit (undeclared; the orchestrator-owned
 * RUNTIME_ONLY_RESPONSES tables are not extended by this batch): 404 on the
 * branches LIST for an invisible repository (upstream repo-group middleware).
 *
 * Webhook fan-out (the `create`/`delete` ref events): the CREATE and DELETE
 * handlers emit through the landed emitWebhookDeliveries pipeline — the
 * API-side half of upstream's ref-family notifications, whose git-push and
 * mirror halves already emit via emitPushFamilyUpdates. Payloads are the
 * upstream renderers verbatim (services/webhook/notifier.go): CreatePayload
 * (CreateRef:821→:830 — sha = the created ref's tip, ref = the SHORT name,
 * ref_type "branch") and DeletePayload (DeleteRef:858→:870 — pusher_type
 * "user"). The sender is the authenticated API caller (upstream's `pusher`
 * doer); the repository renders with the caller's viewer, like every
 * api-routes emission. Upstream additionally fires DeleteRef+CreateRef on
 * branch RENAME (services/repository/branch.go:492-493) — the PATCH handler
 * emits that pair (delete first, upstream's order) after the whole rename
 * succeeded, with the shared tip as the create's sha.
 *
 * Branch render extras (SPEC-0013 §3.6 — the LIST and the single GET only;
 * POST keeps the family default render): the repo's rules load once per
 * request (listRepoRules) and every branch resolves its first-match rule
 * (GetFirstMatchProtectedBranchRule, protected_branch_list.go:92-98) against
 * the authenticated doer's access pair. Upstream is ToBranch — the pinned
 * submodule keeps it at services/convert/convert.go:67-118 (newer upstream
 * moves it to routers/api/v1/convert/branch.go): the no-rule arm renders
 * code-unit-write access for both flags (HasAccessUnit TypeCode write :73,
 * CanMaintainerWriteToBranch :82, UserCanPush/UserCanMerge :92-93 → our
 * PrincipalAccess.write); a matching rule renders CanUserPush (:116 → our
 * canUserPush) and IsUserMergeWhitelisted (:117 → our isUserMergeWhitelisted)
 * plus the rule name as effective_branch_protection_name. Upstream gates that
 * name on Permission.IsAdmin() (:106-108); SPEC-0013 §3.6 renders it for
 * every matched branch unconditionally — intentional divergence, noted here
 * for the SPEC's divergence log (git-models.ts toBranch's placeholder values
 * are overridden by this module on the two GET arms).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const conflictResponse = {
  description: "conflict",
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const repoArchivedResponse = {
  description: "repoArchivedError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const pageLimitQuery = {
  page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
} as const;

/** Body bind hook for the operations with a declared 422 (Go bind parity). */
const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** Upstream's empty-repo answer shared by the mutations and the single read. */
function assertNotEmpty(pair: { repo: { isEmpty: boolean } }): void {
  if (pair.repo.isEmpty) {
    throw new ApiError(404, "Git Repository is empty.");
  }
}

/** The protection-aware Branch fields this module renders (SPEC-0013 §3.6). */
type BranchRenderExtras = Pick<Branch, "user_can_push" | "user_can_merge" | "effective_branch_protection_name">;

/** Per-request rule context — loaded ONCE, evaluated per branch. */
interface BranchProtectionContext {
  /** The repo's rules in first-match order (listRepoRules). */
  rules: ProtectedBranchRow[];
  /** The authenticated doer's reduced ACL (anonymous → all false). */
  access: PrincipalAccess;
}

/**
 * The per-request load: the repo's rules once (listRepoRules, the
 * FindRepoProtectedBranchRules port) + the doer's access pair once
 * (principalAccessOf — the repositoryPermissions + collaboratorModeOf
 * composition). D1 reads stay per-request like every ACL decision (§4.7).
 */
async function loadBranchProtectionContext(c: Context<ApiEnv>, pair: RepositoryWithOwner): Promise<BranchProtectionContext> {
  const [rules, access] = await Promise.all([
    listRepoRules(c.env.DB, pair.repo.id),
    principalAccessOf(c.env.DB, pair.repo, viewerOf(c).requester),
  ]);
  return { rules, access };
}

/**
 * GetFirstMatchProtectedBranchRule (protected_branch_list.go:92-98) over the
 * request-loaded list — findRule's per-branch half without re-reading D1.
 */
function firstMatchRule(rules: ProtectedBranchRow[], branchName: string): ProtectedBranchRow | null {
  for (const rule of rules) {
    if (ruleMatches(compileRuleName(rule.ruleName), branchName)) {
      return rule;
    }
  }
  return null;
}

/**
 * ToBranch's protection split for ONE branch (services/convert/convert.go:
 * 67-118): no rule → the bp == nil arm's plain write-access flags (:92-93)
 * with an empty name; a rule → CanUserPush (:116) / IsUserMergeWhitelisted
 * (:117) over the rule config + the first-match rule's name.
 */
async function branchRenderExtras(d1: D1Database, context: BranchProtectionContext, branchName: string): Promise<BranchRenderExtras> {
  const rule = firstMatchRule(context.rules, branchName);
  if (rule === null) {
    return { user_can_push: context.access.write, user_can_merge: context.access.write, effective_branch_protection_name: "" };
  }
  const config = parseRuleConfig(rule.rules);
  return {
    user_can_push: await canUserPush(d1, config, context.access),
    user_can_merge: await isUserMergeWhitelisted(d1, config, context.access),
    effective_branch_protection_name: rule.ruleName,
  };
}

/** The rendered Branch for one ref tip (readCommit on the resolved target). */
async function renderBranch(
  c: Context<ApiEnv>,
  pair: Parameters<typeof toBranch>[3],
  branchName: string,
  target: string,
  extras?: BranchRenderExtras | Promise<BranchRenderExtras>,
) {
  const reads = engineReads(c.env, pair.repo);
  const commit = await reads.readCommit(target);
  if (commit === null) return null;
  const usernames = await usernamesByEmail(c.env.DB, [commit]);
  const viewer = viewerOf(c);
  const branch = toBranch(
    branchName,
    toPayloadCommit(commit, pair, usernames, viewer.origin),
    viewer,
    pair,
  );
  if (extras === undefined) return branch;
  return { ...branch, ...(await extras) };
}

// ---------------------------------------------------------------------------
// Webhook triggers — the routes/releases.ts emit pattern: the delivery-row
// insert runs INLINE after the ref mutation committed (upstream CreateHookTask
// is synchronous too); only the Queue producer ({deliveryId} batch) hangs off
// the executionCtx-guarded waitUntil — in-process callers (tests via
// app.request) have no executionCtx, skip the enqueue, and leave the rows
// `pending`. Failures are logged, never propagated — a webhook miss can never
// fail the API write (§3.5's post-commit posture).
// ---------------------------------------------------------------------------

/** The `WEBHOOK_DELIVERY` Queue producer, when the binding is wired. */
function webhookDeliveryQueue(
  env: ApiEnv["Bindings"],
): { sendBatch(messages: { body: WebhookDeliveryMessage }[]): Promise<unknown> } | null {
  const candidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  if (candidate === undefined || candidate === null) return null;
  const queue = candidate as { sendBatch?: (messages: { body: WebhookDeliveryMessage }[]) => Promise<unknown> };
  return typeof queue.sendBatch === "function" ? { sendBatch: queue.sendBatch.bind(queue) } : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fan one committed branch ref write out as a `create`/`delete` event (the
 * per-file twin of the tags route's helper — the api-routes emission family
 * keeps its queue probe + error sink file-local). `refName` is the FULL ref,
 * matching what the push family passes to the branch filter
 * (emitPushFamilyUpdates); the payload itself carries upstream's SHORT name.
 */
async function emitRefWebhook(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  eventType: Extract<HookEventType, "create" | "delete">,
  payload: unknown,
  refName: string,
): Promise<void> {
  let execCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    execCtx = c.executionCtx;
  } catch {
    execCtx = undefined; // in-process caller (tests): no execution context
  }
  const queue = webhookDeliveryQueue(c.env);
  try {
    await emitWebhookDeliveries(
      c.env.DB,
      { repoId: pair.repo.id, ownerId: pair.repo.ownerId, eventType, payload, refName },
      {
        enqueue:
          queue !== null && execCtx !== undefined
            ? (deliveryIds) => {
                execCtx.waitUntil(
                  queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(undefined, (error: unknown) => {
                    console.error(`[branches] delivery enqueue failed (${eventType}): ${errorMessage(error)}`);
                  }),
                );
              }
            : undefined,
      },
    );
  } catch (error) {
    console.error(`[branches] webhook fan-out failed (${eventType}): ${errorMessage(error)}`);
  }
}

export function registerBranchRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/branches (repoListBranches)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/branches",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "List a repository's branches",
      operationId: "repoListBranches",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
        }),
        query: z.object({
          page: pageLimitQuery.page,
          limit: pageLimitQuery.limit,
        }),
      },
      responses: {
        200: { description: "BranchList", content: { "application/json": { schema: z.array(branchSchema) } } },
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      const listOptions = parseListOptions(new URL(c.req.url));
      const refs = await engineReads(c.env, pair.repo).listRefs();
      const branches = (refs?.refs ?? [])
        .filter((ref) => ref.name.startsWith("refs/heads/"))
        .map((ref) => ({ name: ref.name.slice("refs/heads/".length), target: ref.target }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      setPaginationHeaders(c, branches.length, listOptions);
      const start = (listOptions.page - 1) * listOptions.limit;
      const page = branches.slice(start, start + listOptions.limit);
      // SPEC-0013 §3.6: one rule load + one access evaluation per request,
      // first-match evaluated per branch (extras start concurrently with the
      // per-branch commit reads).
      const protection = await loadBranchProtectionContext(c, pair);
      const rendered = await Promise.all(
        page.map((branch) => renderBranch(c, pair, branch.name, branch.target, branchRenderExtras(c.env.DB, protection, branch.name))),
      );
      return c.json(rendered.filter((branch) => branch !== null), 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/branches (repoCreateBranch) — 201
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/branches",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Create a branch",
      operationId: "repoCreateBranch",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
        }),
        body: { content: { "application/json": { schema: createBranchOptionSchema } } },
      },
      responses: {
        201: { description: "Branch", content: { "application/json": { schema: branchSchema } } },
        403: forbiddenResponse,
        404: notFoundResponse,
        409: conflictResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(pair);
      assertNotEmpty(pair);
      if (!(await canWriteRepository(c, pair))) {
        throw new ApiError(403, "user should have a permission to write to the target branch");
      }
      const form = c.req.valid("json");
      const newName = form.new_branch_name;

      const reads = engineReads(c.env, pair.repo);
      const tips = refTipMap(await reads.listRefs());

      // Source resolution: old_ref_name (any ref/oid) > old_branch_name >
      // default branch (CreateBranch handler order).
      let source: { target: string };
      if (form.old_ref_name !== undefined && form.old_ref_name !== "") {
        const resolved = resolveNamedRef(tips, form.old_ref_name, pair.repo.defaultBranch);
        if (resolved === null) throw new ApiError(500, `GetCommit: ${form.old_ref_name} does not exist`);
        source = resolved;
      } else {
        const oldName = form.old_branch_name !== undefined && form.old_branch_name !== "" ? form.old_branch_name : pair.repo.defaultBranch;
        const tip = tips.get(branchRef(oldName));
        if (tip === undefined) {
          throw new ApiError(404, "The old branch does not exist");
        }
        source = tip;
      }

      // Duplicate checks (upstream checkBranchName + ErrBranchAlreadyExists
      // family → the 409s): branch-exists, tag-name-collision, funny refnames.
      if (tips.has(branchRef(newName))) {
        throw new ApiError(409, "The branch already exists.");
      }
      if (tips.has(tagRef(newName))) {
        throw new ApiError(409, "The branch with the same tag already exists.");
      }

      const result = await engineCell(c.env, pair.repo).commitApiChange({
        ref: branchRef(newName),
        expectedOldOid: ZERO_OID,
        newOid: source.target,
      });
      if (result.tag !== "committed") {
        // invalid refnames are upstream's ErrBranchNameConflict → 409 family.
        if (result.tag === "invalid") {
          throw new ApiError(409, "The branch with the same name already exists.");
        }
        throw commitApiChangeError(result);
      }

      const branch = await renderBranch(c, pair, newName, source.target);
      if (branch === null) {
        throw new ApiError(500, "");
      }
      // Upstream CreateRef (notifier.go:821→:830): sha is the created ref's
      // tip, ref the SHORT branch name, ref_type "branch"; the sender is the
      // authenticated caller (upstream's `pusher` doer).
      await emitRefWebhook(
        c,
        pair,
        "create",
        {
          sha: source.target,
          ref: newName,
          ref_type: "branch",
          repository: toApiRepository(viewerOf(c), pair),
          sender: c.get("authUser") ?? null,
        },
        branchRef(newName),
      );
      return c.json(branch, 201);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/branches/{branch} (repoGetBranch)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/branches/{branch}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Retrieve a specific branch from a repository, including its effective branch protection",
      operationId: "repoGetBranch",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
          branch: z.string().min(1).openapi({ description: "branch to get" }),
        }),
      },
      responses: {
        200: { description: "Branch", content: { "application/json": { schema: branchSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      const branchName = c.req.valid("param").branch;
      const tip = refTipMap(await engineReads(c.env, pair.repo).listRefs()).get(branchRef(branchName));
      if (tip === undefined) {
        throw new ApiError(404, "not found");
      }
      const branch = await renderBranch(
        c,
        pair,
        branchName,
        tip.target,
        branchRenderExtras(c.env.DB, await loadBranchProtectionContext(c, pair), branchName),
      );
      if (branch === null) {
        throw new ApiError(404, "not found");
      }
      return c.json(branch, 200);
    },
  );

  // -------------------------------------------------------------------------
  // PUT /repos/{owner}/{repo}/branches/{branch} (repoUpdateBranch) — the
  // direct ref-CAS map (SPEC-0004 §2.4): 204, 409 on CAS mismatch.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "put",
      path: "/repos/{owner}/{repo}/branches/{branch}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Update a branch reference to a new commit",
      operationId: "repoUpdateBranch",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
          branch: z.string().min(1).openapi({ description: "name of the branch" }),
        }),
        body: { content: { "application/json": { schema: updateBranchOptionSchema } } },
      },
      responses: {
        204: { description: "empty" },
        403: forbiddenResponse,
        404: notFoundResponse,
        409: notFoundResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotEmpty(pair);
      if (!(await canWriteRepository(c, pair))) {
        throw new ApiError(403, "Must have write access");
      }
      const form = c.req.valid("json");
      const branchName = c.req.valid("param").branch;
      const reads = engineReads(c.env, pair.repo);
      const tips = refTipMap(await reads.listRefs());
      const tip = tips.get(branchRef(branchName));
      if (tip === undefined) {
        throw new ApiError(404, "not found");
      }

      // old_commit_id CAS pre-check (upstream ConvertToGitID compare → 422).
      if (form.old_commit_id !== undefined && form.old_commit_id !== "" && form.old_commit_id !== tip.target) {
        throw new ApiError(422, `branch commit does not match [expected: ${form.old_commit_id}, given: ${tip.target}]`);
      }

      // No-op when the branch already points at the target (upstream early
      // return); otherwise the force gate: a non-fast-forward move (merge
      // base below the current tip) needs the explicit force flag.
      if (form.new_commit_id !== tip.target) {
        const targetCommit = await reads.readCommit(form.new_commit_id);
        if (targetCommit === null) {
          throw new ApiError(422, `ConvertToGitID(new): ${form.new_commit_id} does not resolve to a commit`);
        }
        const base = await reads.mergeBase(form.new_commit_id, tip.target);
        const fastForward = base !== null && base.tag === "ok" && base.base === tip.target;
        if (!fastForward && form.force !== true) {
          throw new ApiError(422, `Force push ${branchName} need a confirm force parameter`);
        }
      }

      const result = await engineCell(c.env, pair.repo).commitApiChange({
        ref: branchRef(branchName),
        expectedOldOid: tip.target,
        newOid: form.new_commit_id,
      });
      if (result.tag !== "committed") {
        if (result.tag === "invalid") {
          throw new ApiError(422, result.reason);
        }
        throw commitApiChangeError(result);
      }
      return c.body(null, 204);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/branches/{branch} (repoDeleteBranch) — 204
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/branches/{branch}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete a specific branch from a repository",
      operationId: "repoDeleteBranch",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
          branch: z.string().min(1).openapi({ description: "branch to delete" }),
        }),
      },
      responses: {
        204: { description: "empty" },
        403: errorResponse,
        404: notFoundResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(pair);
      assertNotEmpty(pair);
      if (!(await canWriteRepository(c, pair))) {
        throw new ApiError(403, "user should have a permission to write to the target branch");
      }
      const branchName = c.req.valid("param").branch;
      if (branchName === pair.repo.defaultBranch) {
        throw new ApiError(403, "can not delete default or pull request target branch");
      }
      const reads = engineReads(c.env, pair.repo);
      const tip = refTipMap(await reads.listRefs()).get(branchRef(branchName));
      if (tip === undefined) {
        throw new ApiError(404, "not found");
      }
      const result = await engineCell(c.env, pair.repo).deleteApiRef({
        ref: branchRef(branchName),
        expectedOid: tip.target,
      });
      if (result.tag !== "deleted") {
        const error = deleteApiRefError(result);
        if (error !== null) throw error;
      }
      // Upstream DeleteRef (notifier.go:858→:870): pusher_type is always
      // "user" (api.PusherTypeUser). The idempotent already-absent arm
      // (deleteApiRefError's null) removed nothing — no event for it.
      if (result.tag === "deleted") {
        await emitRefWebhook(
          c,
          pair,
          "delete",
          {
            ref: branchName,
            ref_type: "branch",
            pusher_type: "user",
            repository: toApiRepository(viewerOf(c), pair),
            sender: c.get("authUser") ?? null,
          },
          branchRef(branchName),
        );
      }
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /repos/{owner}/{repo}/branches/{branch} (repoRenameBranch) — 204
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "patch",
      path: "/repos/{owner}/{repo}/branches/{branch}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Rename a branch",
      operationId: "repoRenameBranch",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
          branch: z.string().min(1).openapi({ description: "name of the branch" }),
        }),
        body: { content: { "application/json": { schema: renameBranchOptionSchema } } },
      },
      responses: {
        204: { description: "empty" },
        403: forbiddenResponse,
        404: notFoundResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(pair);
      assertNotEmpty(pair);
      if (!(await canWriteRepository(c, pair))) {
        throw new ApiError(403, "Must have write access");
      }
      const form = c.req.valid("json");
      const oldName = c.req.valid("param").branch;
      const newName = form.name;

      const reads = engineReads(c.env, pair.repo);
      const tips = refTipMap(await reads.listRefs());
      const tip = tips.get(branchRef(oldName));
      if (tip === undefined) {
        throw new ApiError(404, "Branch doesn't exist.");
      }
      if (oldName === newName || tips.has(branchRef(newName))) {
        throw new ApiError(422, "Cannot rename a branch using the same name or rename to a branch that already exists.");
      }

      const isDefault = oldName === pair.repo.defaultBranch;
      if (isDefault && !(await canWriteRepository(c, pair))) {
        throw new ApiError(403, "User must be a repo or site admin to rename default or protected branches.");
      }

      // Create-then-delete (no engine rename primitive): land the new ref,
      // then CAS-delete the old one. A transport failure between the two
      // leaves both refs — the next delete of the old name repairs it.
      const cell = engineCell(c.env, pair.repo);
      const created = await cell.commitApiChange({
        ref: branchRef(newName),
        expectedOldOid: ZERO_OID,
        newOid: tip.target,
      });
      if (created.tag !== "committed") {
        if (created.tag === "invalid") {
          throw new ApiError(422, created.reason);
        }
        throw commitApiChangeError(created);
      }
      const removed = await cell.deleteApiRef({ ref: branchRef(oldName), expectedOid: tip.target });
      if (removed.tag !== "deleted") {
        const error = deleteApiRefError(removed);
        if (error !== null) throw error;
      }

      if (isDefault) {
        const head = await cell.setHead(branchRef(newName));
        if (head.tag !== "ok") {
          throw new ApiError(500, "");
        }
        await drizzle(c.env.DB)
          .update(repositories)
          .set({ defaultBranch: newName })
          .where(eq(repositories.id, pair.repo.id));
      }

      // Webhook: upstream fires DeleteRef(from) → CreateRef(to, the shared
      // tip) on a rename (services/repository/branch.go:492-493) — the same
      // DeletePayload/CreatePayload shapes the DELETE/POST handlers emit, in
      // upstream's notification order (delete first), after the whole rename
      // (including the default-branch fixup) succeeded.
      await emitRefWebhook(
        c,
        pair,
        "delete",
        {
          ref: oldName,
          ref_type: "branch",
          pusher_type: "user",
          repository: toApiRepository(viewerOf(c), pair),
          sender: c.get("authUser") ?? null,
        },
        branchRef(oldName),
      );
      await emitRefWebhook(
        c,
        pair,
        "create",
        {
          sha: tip.target,
          ref: newName,
          ref_type: "branch",
          repository: toApiRepository(viewerOf(c), pair),
          sender: c.get("authUser") ?? null,
        },
        branchRef(newName),
      );
      return c.body(null, 204);
    },
    bindValidationHook,
  );
}
