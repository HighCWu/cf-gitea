import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context, MiddlewareHandler } from "hono";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { releases } from "../../db/schema";
import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import {
  branchRef,
  commitApiChangeError,
  deleteApiRefError,
  engineCell,
  engineReads,
  refTipMap,
  tagRef,
  ZERO_OID,
} from "../services/engine";
import { toAnnotatedTag, toTag } from "../services/git-models";
import { annotatedTagSchema, createTagOptionSchema, tagSchema } from "../models/git";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { assertNotArchived, canWriteRepository, requireVisibleRepo } from "../services/repo-access";
import { toApiRepository, viewerOf, type RepositoryWithOwner } from "../services/repository";
import { isTagControlAllowed, listProtectedTags } from "../../services/tag-protection";
import { serializeTag } from "@cf-gitea/git-engine";
import { emitWebhookDeliveries, type HookEventType } from "../../issues/webhooks";
import type { WebhookDeliveryMessage } from "../../webhooks/consumer";

/**
 * Tier-1 tag routes (SPEC-0004 §2.4 rows repoListTags / repoCreateTag /
 * repoGetTag / repoDeleteTag / GetAnnotatedTag — 3 paths, 5 operations).
 * Reads render straight from the engine refs table (targets + the peel cache
 * distinguish annotated from lightweight without reading objects); creation
 * builds the tag object Worker-side through the engine's canonical
 * `serializeTag` and lands it via putApiObjects + commitApiChange (the
 * SPEC-0004 §3.4 commit-builder mapping); deletion is deleteApiRef.
 *
 * Upstream behavior mirrored (routers/api/v1/repo/tag.go):
 *   - POST answers **200** (not 201) with the Tag — the contract quirk;
 *   - POST on an empty repo → **405**; a missing `target` → 404
 *     "target not found: …"; a duplicate tag → 409 "tag already exists";
 *   - DELETE refuses a tag that has a release attached with 409 "a tag
 *     attached to a release cannot be deleted directly" (the releases table
 *     lookup the release routes share);
 *   - GET /git/tags/{sha} is annotated tag OBJECTS only — lightweight tags
 *     (no peel on the refs row) and unknown oids → 404; a malformed param →
 *     the declared 400 "SHA not provided" family.
 *
 * Documented deviation (services/git-models.ts toTag/toAnnotatedTag): the tag
 * message and tagger render "" / null — annotated-tag object bytes are
 * engine-resident and the landed public RPC surface exposes targets + the
 * peel cache only.
 *
 * Webhook fan-out (the `create`/`delete` ref events): the CREATE and DELETE
 * handlers emit through the landed emitWebhookDeliveries pipeline — the
 * API-side half of upstream's ref-family notifications, whose git-push and
 * mirror halves already emit via emitPushFamilyUpdates. Payloads are the
 * upstream renderers verbatim (services/webhook/notifier.go): CreatePayload
 * (CreateRef:821→:830 — ref = the SHORT tag name, ref_type "tag", sha = the
 * created ref's tip) and DeletePayload (DeleteRef:858→:870 — pusher_type
 * "user"). The sender is the authenticated API caller (upstream's `pusher`
 * doer); the repository renders with the caller's viewer, like every
 * api-routes emission. The annotated-tag `sha` is the TAG OBJECT oid — the
 * ref tip `Sha: refID` actually carries (the push path's semantics, identical
 * to what emitPushFamilyUpdates emits for a pushed annotated tag); upstream's
 * own API path passes the pre-peel target commit instead (release.go:136
 * resolves GetCommit(target) before CreateAnnotatedTag) — a quirk we do not
 * copy. Upstream's API tag create/delete additionally fire a zero-commit
 * `push` event around the create/delete pair (release.go:136-143 / :396-403,
 * always push first) — emitted here with the push family's zero-commit shape
 * (zeroCommitPushPayload below), so an API-written tag and a pushed tag
 * produce byte-identical `push` payloads.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
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

const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

interface TagTip {
  name: string;
  target: string;
  peeled?: string;
}

/** Tag refs sorted by name — the engine's list order is unspecified. */
async function sortedTags(c: Context<ApiEnv>, pair: { ownerNamespace: string; slug: string }): Promise<TagTip[]> {
  const refs = await engineReads(c.env, pair).listRefs();
  return (refs?.refs ?? [])
    .filter((ref) => ref.name.startsWith("refs/tags/"))
    .map((ref) => ({
      name: ref.name.slice("refs/tags/".length),
      target: ref.target,
      ...(ref.peeled === undefined ? {} : { peeled: ref.peeled }),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The peeled commit a tag points at (tag objects read via readCommit's peel). */
async function tagCommitSha(c: Context<ApiEnv>, pair: { ownerNamespace: string; slug: string }, tip: TagTip): Promise<string | null> {
  if (tip.peeled !== undefined) return tip.peeled;
  const commit = await engineReads(c.env, pair).readCommit(tip.target);
  return commit === null ? null : commit.oid;
}

/** True when a release row is attached to the tag (upstream release coupling). */
async function hasRelease(d1: D1Database, repoId: string, tagName: string): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ id: releases.id })
    .from(releases)
    .where(and(eq(releases.repoId, repoId), eq(releases.tagName, tagName)))
    .limit(1)
    .then((rows) => rows[0]);
  return row !== undefined;
}

// ---------------------------------------------------------------------------
// Webhook triggers — the routes/releases.ts emit pattern (the per-file twin
// of the branches route's helper; the api-routes emission family keeps its
// queue probe + error sink file-local): the delivery-row insert runs INLINE
// after the ref mutation committed; only the Queue producer ({deliveryId}
// batch) hangs off the executionCtx-guarded waitUntil — in-process callers
// (tests via app.request) have no executionCtx, skip the enqueue, and leave
// the rows `pending`. Failures are logged, never propagated — a webhook miss
// can never fail the API write (§3.5's post-commit posture).
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
 * Fan one committed tag ref write out as a `create`/`delete` event. `refName`
 * is the FULL ref, matching what the push family passes to the branch filter
 * (emitPushFamilyUpdates); the payload itself carries upstream's SHORT name.
 */
async function emitRefWebhook(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  eventType: Extract<HookEventType, "create" | "delete" | "push">,
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
                    console.error(`[tags] delivery enqueue failed (${eventType}): ${errorMessage(error)}`);
                  }),
                );
              }
            : undefined,
      },
    );
  } catch (error) {
    console.error(`[tags] webhook fan-out failed (${eventType}): ${errorMessage(error)}`);
  }
}

/**
 * The zero-commit `push` payload around an API tag write — the push family's
 * created/deleted-ref shape (services/webhooks-push.ts:260-272, upstream's
 * mirror path: SyncPushCommits → notifier.go:901-909 with an empty
 * PushCommits struct, mirror_pull.go:347): FULL ref, before/after oids,
 * compare_url the bare origin + "/" (AppURL + CompareURL ""), no commits,
 * head_commit null, and `pusher` AND `sender` the authenticated caller
 * (notifier.go:919-920 — both apiPusher). Upstream's git-push/release tag
 * paths additionally set head_commit + a composed compare URL for created
 * tags (push.go:123-136, release.go:131-134) — the landed family already
 * emits the mirror-path shape for pushed tags, and this stays byte-identical
 * with it (the documented family-level deviation, not a new one).
 */
function zeroCommitPushPayload(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  ref: string,
  before: string,
  after: string,
): Record<string, unknown> {
  const sender = c.get("authUser") ?? null;
  return {
    ref,
    before,
    after,
    compare_url: `${viewerOf(c).origin}/`,
    commits: [],
    total_commits: 0,
    head_commit: null,
    repository: toApiRepository(viewerOf(c), pair),
    pusher: sender,
    sender,
  };
}

export function registerTagRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/tags (repoListTags)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/tags",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "List a repository's tags",
      operationId: "repoListTags",
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
        200: { description: "TagList", content: { "application/json": { schema: z.array(tagSchema) } } },
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      const listOptions = parseListOptions(new URL(c.req.url));
      const tags = await sortedTags(c, pair.repo);
      setPaginationHeaders(c, tags.length, listOptions);
      const start = (listOptions.page - 1) * listOptions.limit;
      const page = tags.slice(start, start + listOptions.limit);
      const viewer = viewerOf(c);
      const rendered = await Promise.all(
        page.map(async (tip) => {
          const sha = await tagCommitSha(c, pair.repo, tip);
          return sha === null ? null : toTag(tip.name, tip, sha, pair, viewer.origin);
        }),
      );
      return c.json(rendered.filter((tag) => tag !== null), 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/tags (repoCreateTag) — 200 quirk
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/tags",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Create a tag",
      operationId: "repoCreateTag",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
        }),
        body: { content: { "application/json": { schema: createTagOptionSchema } } },
      },
      responses: {
        200: { description: "Tag", content: { "application/json": { schema: tagSchema } } },
        404: notFoundResponse,
        405: { description: "empty" },
        409: { description: "conflict" },
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(pair);
      if (pair.repo.isEmpty) {
        throw new ApiError(405, "Git Repository is empty.");
      }
      if (!(await canWriteRepository(c, pair))) {
        throw new ApiError(403, "user should have a permission to write to the target branch");
      }
      const form = c.req.valid("json");
      const name = form.tag_name;

      const reads = engineReads(c.env, pair.repo);
      const tips = refTipMap(await reads.listRefs());

      // Target resolution: explicit `target` (a branch/tag name, full ref, or
      // oid) or the default branch (CreateTag → GetTargetCommit).
      const explicit = form.target !== undefined && form.target !== "";
      const refParam = explicit ? (form.target as string) : pair.repo.defaultBranch;
      let commitSha: string;
      const tip = tips.get(branchRef(refParam)) ?? tips.get(tagRef(refParam)) ?? (explicit ? tips.get(refParam) : undefined);
      if (tip !== undefined) {
        const sha = await tagCommitSha(c, pair.repo, { name: refParam, target: tip.target, ...(tip.peeled === undefined ? {} : { peeled: tip.peeled }) });
        if (sha === null) throw new ApiError(404, `target not found: ${refParam}`);
        commitSha = sha;
      } else if (/^[0-9a-f]{40}$/.test(refParam)) {
        commitSha = refParam;
      } else {
        throw new ApiError(404, `target not found: ${refParam}`);
      }

      if (tips.has(tagRef(name))) {
        throw new ApiError(409, "tag already exists");
      }

      // Protected-tag enforcement on the create arm (upstream CreateTag →
      // release_service.CreateNewTag's IsUserAllowedToControlTag check,
      // services/release/release.go:87-102, answered 422 "user not allowed
      // to create protected tag", routers/api/v1/repo/tag.go:224-227 — the
      // check runs after the duplicate arm, exactly here). An unresolvable
      // viewer id evaluates as anonymous (0 — never allowlisted).
      const doer = c.get("authUser");
      if (!(await isTagControlAllowed(c.env.DB, await listProtectedTags(c.env.DB, pair.repo.id), name, doer?.id ?? 0))) {
        throw new ApiError(422, "user not allowed to create protected tag");
      }

      // A message creates the ANNOTATED tag object (serializeTag →
      // putApiObjects → ref CAS); without one the tag is lightweight.
      let newTarget = commitSha;
      if (form.message !== undefined && form.message !== "") {
        const doerRow = c.get("authUser");
        const now = Math.floor(Date.now() / 1000);
        const tag = serializeTag({
          object: commitSha,
          type: "commit",
          tag: name,
          tagger:
            doerRow === undefined
              ? null
              : {
                  name: doerRow.login ?? "gitea",
                  email:
                    doerRow.email === undefined || doerRow.email === ""
                      ? `${doerRow.login ?? "gitea"}@noreply.${new URL(c.req.url).hostname}`
                      : doerRow.email,
                  time: now,
                  tz: "+0000",
                },
          message: form.message,
        });
        const stored = await engineCell(c.env, pair.repo).putApiObjects([{ oid: tag.oid, type: tag.type, data: tag.data }]);
        if (stored.tag !== "ok") {
          throw new ApiError(422, stored.tag === "invalid" ? stored.reason : "tag object too large");
        }
        newTarget = tag.oid;
      }

      const result = await engineCell(c.env, pair.repo).commitApiChange({
        ref: tagRef(name),
        expectedOldOid: ZERO_OID,
        newOid: newTarget,
      });
      if (result.tag !== "committed") {
        if (result.tag === "invalid") {
          throw new ApiError(422, result.reason);
        }
        throw commitApiChangeError(result);
      }

      // Upstream's API tag create fires the zero-commit `push` event around
      // the `create` event (services/release/release.go:136-143 — PushCommits
      // :136 first, CreateRef :143; the mirror create path orders it the same
      // way, mirror_pull.go:347-352). Before = the zero oid (nothing existed),
      // after = the new ref tip — the TAG OBJECT oid for the annotated case,
      // exactly what the create payload below pins as `sha`.
      await emitRefWebhook(c, pair, "push", zeroCommitPushPayload(c, pair, tagRef(name), ZERO_OID, newTarget), tagRef(name));

      // Upstream CreateRef (notifier.go:821→:830): ref is the SHORT tag name
      // (never an oid — the annotated peel stays out of `ref`), ref_type
      // "tag", sha the created ref's tip — the TAG OBJECT oid for the
      // annotated case (newTarget), matching the push family's create
      // payloads for the same action; the sender is the authenticated caller.
      await emitRefWebhook(
        c,
        pair,
        "create",
        {
          sha: newTarget,
          ref: name,
          ref_type: "tag",
          repository: toApiRepository(viewerOf(c), pair),
          sender: c.get("authUser") ?? null,
        },
        tagRef(name),
      );

      const viewer = viewerOf(c);
      return c.json(
        toTag(
          name,
          newTarget === commitSha ? { target: newTarget } : { target: newTarget, peeled: commitSha },
          commitSha,
          pair,
          viewer.origin,
        ),
        200,
      );
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/tags/{tag} (repoGetTag)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/tags/{tag}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get an existing tag",
      operationId: "repoGetTag",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
          tag: z.string().min(1).openapi({ description: "name of tag" }),
        }),
      },
      responses: {
        200: { description: "Tag", content: { "application/json": { schema: tagSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      const tagName = c.req.valid("param").tag;
      const tip = refTipMap(await engineReads(c.env, pair.repo).listRefs()).get(tagRef(tagName));
      if (tip === undefined) {
        throw new ApiError(404, "tag doesn't exist: " + tagName);
      }
      const sha = await tagCommitSha(c, pair.repo, { name: tagName, target: tip.target, ...(tip.peeled === undefined ? {} : { peeled: tip.peeled }) });
      if (sha === null) {
        throw new ApiError(404, "tag doesn't exist: " + tagName);
      }
      return c.json(toTag(tagName, tip, sha, pair, viewerOf(c).origin), 200);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/tags/{tag} (repoDeleteTag) — 204
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/tags/{tag}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete an existing tag (must be an annotated tag)",
      operationId: "repoDeleteTag",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
          tag: z.string().min(1).openapi({ description: "name of tag" }),
        }),
      },
      responses: {
        204: { description: "empty" },
        404: notFoundResponse,
        405: { description: "empty" },
        409: validationErrorResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(pair);
      if (pair.repo.isEmpty) {
        throw new ApiError(405, "Git Repository is empty.");
      }
      if (!(await canWriteRepository(c, pair))) {
        throw new ApiError(403, "user should have a permission to write to the target branch");
      }
      const tagName = c.req.valid("param").tag;
      if ((await hasRelease(c.env.DB, pair.repo.id, tagName))) {
        throw new ApiError(409, "a tag attached to a release cannot be deleted directly");
      }
      const tip = refTipMap(await engineReads(c.env, pair.repo).listRefs()).get(tagRef(tagName));
      if (tip === undefined) {
        throw new ApiError(404, "not found");
      }
      // Protected-tag enforcement on the delete arm (upstream DeleteTag →
      // release_service.DeleteReleaseByID's IsUserAllowedToControlTag check,
      // services/release/release.go:376-390, answered 422 "user not allowed
      // to delete protected tag", routers/api/v1/repo/tag.go:282-285 — the
      // check runs after the existence arms, exactly here).
      const doer = c.get("authUser");
      if (!(await isTagControlAllowed(c.env.DB, await listProtectedTags(c.env.DB, pair.repo.id), tagName, doer?.id ?? 0))) {
        throw new ApiError(422, "user not allowed to delete protected tag");
      }
      const result = await engineCell(c.env, pair.repo).deleteApiRef({ ref: tagRef(tagName), expectedOid: tip.target });
      if (result.tag !== "deleted") {
        const error = deleteApiRefError(result);
        if (error !== null) throw error;
      }
      // Upstream's API tag delete fires the zero-commit `push` event too
      // (services/release/release.go:396-403 — PushCommits with
      // OldCommitID = the tag's sha and the empty NewCommitID, then
      // DeleteRef :403): before = the pre-delete ref tip, after = the zero
      // oid. Emission order push → delete matches upstream.
      if (result.tag === "deleted") {
        await emitRefWebhook(c, pair, "push", zeroCommitPushPayload(c, pair, tagRef(tagName), tip.target, ZERO_OID), tagRef(tagName));
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
            ref: tagName,
            ref_type: "tag",
            pusher_type: "user",
            repository: toApiRepository(viewerOf(c), pair),
            sender: c.get("authUser") ?? null,
          },
          tagRef(tagName),
        );
      }
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/git/tags/{sha} (GetAnnotatedTag) — annotated
  // tag objects only; lightweight tags peel nowhere → 404.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/git/tags/{sha}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Gets the tag object of an annotated tag (not lightweight tags)",
      operationId: "GetAnnotatedTag",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
          sha: z.string().min(1).openapi({ description: "sha of the tag. The Git SHA of the tag object, not the Git commit" }),
        }),
      },
      responses: {
        200: { description: "AnnotatedTag", content: { "application/json": { schema: annotatedTagSchema } } },
        400: validationErrorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      const sha = c.req.valid("param").sha;
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new ApiError(400, "SHA not provided");
      }
      const tags = await sortedTags(c, pair.repo);
      const tip = tags.find((tag) => tag.target === sha);
      if (tip === undefined || tip.peeled === undefined) {
        // unknown oid or a lightweight tag (no peel on the refs row)
        throw new ApiError(404, "not found");
      }
      return c.json(toAnnotatedTag(tip.name, tip, tip.peeled, pair, viewerOf(c).origin), 200);
    },
  );
}
