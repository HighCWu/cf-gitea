import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { ReleaseAlreadyExistError } from "../../issues/errors";
import type { ReleaseRow } from "../../issues/service";
import { emitWebhookDeliveries, type HookEventType } from "../../issues/webhooks";
import type { WebhookDeliveryMessage } from "../../webhooks/consumer";
import { ActionType, recordAction } from "../services/activity-feeds";
import { issueErrorToApiError } from "../services/issues";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { tagRef, ZERO_OID } from "../services/engine";
import {
  createReleaseOptionSchema,
  editReleaseOptionSchema,
  releaseListSchema,
  releaseSchema,
} from "../models/release";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { canWriteRepository, requireVisibleRepo } from "../services/repo-access";
import { loadRepoSettings } from "../services/repo-settings";
import { toApiRepository, viewerOf, type RepositoryWithOwner } from "../services/repository";
import {
  assertDraftVisible,
  assertNotTagRecord,
  createReleaseWithGitTag,
  deleteRelease,
  editRelease,
  findLatestRelease,
  findReleaseByTag,
  findReleaseForRepoById,
  listReleases,
  toApiRelease,
} from "../services/releases";
import { emitRefWebhook, zeroCommitPushPayload } from "../services/tags";

/**
 * Tier-1 release routes (SPEC-0004 §2.4 rows repoListReleases /
 * repoCreateRelease / repoGetLatestRelease / repoGetReleaseByTag /
 * repoDeleteReleaseByTag / repoGetRelease / repoEditRelease /
 * repoDeleteRelease; upstream routers/api/v1/repo/release.go + release_tags.go
 * over the landed `releases` D1 table — writes ride the SPEC-0005
 * IssuesService.createRelease with its 409 semantics).
 *
 * Auth (upstream registration, api.go:1408–1428): the group is
 * `mustEnableUnit(TypeReleases)`; reads are anonymous-capable on public
 * repos, writes carry `reqToken + reqRepoWriter(TypeReleases)` — the writer
 * gate is services/repo-access.ts's (reduced matrix + collaborator rows).
 * DRAFTS are 404-hidden from callers without release-write access
 * (canAccessReleaseDraft).
 *
 * Declared responses mirror the vendored contract exactly. Runtime-only code
 * the handlers can emit (undeclared; the orchestrator-owned
 * RUNTIME_ONLY_RESPONSES tables are not extended by this batch, and no
 * scenario drives them):
 *   - every route of the family: 412 when the stored has_releases flag is
 *     false (upstream mustEnableUnit — the flag itself is only settable via
 *     repoEdit's has_releases);
 *   - POST/PATCH: 500 on an ARCHIVED repo — the release subtree registers NO
 *     route-level mustNotBeArchived (api.go:1408-1429, unlike topics/
 *     contents), so the 423 middleware never fires; the refusal is createTag's
 *     in-service MustNotBeArchived arm (services/release/release.go:75-78,
 *     reached by both CreateRelease release.go:187 and UpdateRelease
 *     release.go:269), which neither handler maps — ctx.APIErrorInternal →
 *     500 (release.go:285-287 / :379-382). Upstream's own vendored contract
 *     declares no 500 either; untyped here, the house 500 body.
 *
 * Engine boundary (the N2 wave + the UpdateRelease tag wave): creating AND
 * editing a release land the git tag through the shared tag-store service
 * (upstream CreateRelease → createTag for the create; UpdateRelease's
 * re-run of createTag, release.go:269, for the edit — publish-from-draft
 * lands the missing tag, a tag_name rename lands the NEW ref while the old
 * ref stays (upstream deletes tags only in DeleteReleaseByID, release.go:388),
 * and every published edit re-fills sha1/created/num_commits); DELETE does
 * not delete the ref (the API passes delTag=false).
 *
 * Webhook triggers (`release`, upstream services/webhook/notifier.go
 * sendReleaseHook:879 ← NewRelease:889 / UpdateRelease:893 / DeleteRelease:897,
 * callers services/release/release.go:198,363,366,437): every mutation emits
 * through emitWebhookDeliveries — see emitReleaseWebhook. Upstream gates ALL
 * three actions on `!rel.IsDraft` (release.go:198,358,435): drafts emit
 * nothing, including on delete. Action mapping: create → "published";
 * edit → "updated", EXCEPT an edit that CREATED the tag (isTagCreated — the
 * publish-from-draft whose tag was missing, or a rename onto a fresh name;
 * upstream reaches the same fork at release.go:361-367) and therefore maps
 * to "published"; delete → "deleted".
 *
 * Activity feeds (specs/activity-feeds.md §3.3): the publish_release
 * `action` row rides the same emitReleaseEvent seam — published only,
 * act_user = the release publisher (see emitReleaseEvent).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const conflictResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const releaseIdParams = {
  ...ownerRepoParams,
  id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the release to get" }),
} as const;

const tagParams = {
  ...ownerRepoParams,
  tag: z.string().min(1).openapi({ description: "tag name of the release to get" }),
} as const;

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Body bind hook: upstream's Go bind answers malformed bodies with 422. */
const releaseBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** Upstream `ctx.FormOptionalBool`: absent/"" = null; `true`/`1` = true;
 *  `false`/`0` = false; anything else = false-with-log (we mirror the parse,
 *  keep it total). */
function formOptionalBool(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === "") return null;
  return raw === "true" || raw === "1" || raw === "on";
}

/** Shared repo resolution + the releases-unit gate. */
async function requireReleasesRepo(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const found = await requireVisibleRepo(c, path);
  const settings = await loadRepoSettings(c.env.DB, found.repo.id);
  if (!settings.hasReleases) {
    // mustEnableUnit(TypeReleases) — runtime-only 412 (module header).
    throw new ApiError(412, "releases are disabled for this repo");
  }
  return found;
}

/** The release-write grant (reqRepoWriter(TypeReleases) reduced). */
async function requireReleaseWriter(c: Context<ApiEnv>, found: Awaited<ReturnType<typeof requireVisibleRepo>>): Promise<void> {
  if (await canWriteRepository(c, found)) {
    return;
  }
  throw new ApiError(403, "token does not have the required scope or the user does not have write access");
}

/** The single-release 404 (APIErrorNotFound at runtime). */
function releaseNotExist(): ApiError {
  return new ApiError(404, "not found");
}

/** GetRelease/EditRelease/DeleteRelease lookup with the upstream 404 rules:
 *  repo-scoped id, tag-only records invisible. */
async function requireReleaseById(c: Context<ApiEnv>, repoId: string, rawId: string): Promise<ReleaseRow> {
  const row = await findReleaseForRepoById(c.env.DB, repoId, pathId(rawId));
  if (row === null) {
    throw releaseNotExist();
  }
  assertNotTagRecord(row);
  return row;
}

// ---------------------------------------------------------------------------
// Webhook triggers (`release`) — the routes/issues.ts emit pattern: the
// delivery-row insert runs INLINE after the mutation committed (upstream
// CreateHookTask is synchronous too); only the Queue producer ({deliveryId}
// batch) hangs off the executionCtx-guarded waitUntil — in-process callers
// (tests via app.request) have no executionCtx, skip the enqueue, and leave
// the rows `pending`. Failures are logged, never propagated.
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

/** Fire one `release` webhook event (upstream sendReleaseHook:879). */
async function emitReleaseWebhook(
  c: Context<ApiEnv>,
  input: { repoId: string; ownerId: number | null; eventType: HookEventType; payload: unknown },
): Promise<void> {
  let execCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    execCtx = c.executionCtx;
  } catch {
    execCtx = undefined; // in-process caller (tests): no execution context
  }
  const queue = webhookDeliveryQueue(c.env);
  try {
    await emitWebhookDeliveries(c.env.DB, { ...input, refName: null }, {
      enqueue:
        queue !== null && execCtx !== undefined
          ? (deliveryIds) => {
              execCtx.waitUntil(
                queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(undefined, (error: unknown) => {
                  console.error(`[releases] delivery enqueue failed (${input.eventType}): ${errorMessage(error)}`);
                }),
              );
            }
          : undefined,
    });
  } catch (error) {
    console.error(`[releases] webhook fan-out failed (${input.eventType}): ${errorMessage(error)}`);
  }
}

/** The ReleasePayload wrapper (§2.7, modules/structs/hook.go:332). */
function releasePayload(
  action: string,
  apiRelease: Awaited<ReturnType<typeof toApiRelease>>,
  repository: unknown,
  sender: unknown,
): Record<string, unknown> {
  return { action, release: apiRelease, repository, sender };
}

/**
 * The post-mutation emit shared by the three write routes. `row` is the
 * release state the payload renders (post-edit for PATCH, the deleted row for
 * DELETE); drafts stay silent per the upstream `!rel.IsDraft` gate
 * (release.go:198,358,435).
 *
 * Activity-feed leg (specs/activity-feeds.md §3.3): ONLY the "published"
 * action records a row — upstream's actionNotifier has a NewRelease method
 * and no UpdateRelease/DeleteRelease ones (services/feed/notifier.go:458-477:
 * ActionPublishRelease, content = rel.Title, ref_name =
 * git.RefNameFromTag(rel.TagName).String() = `refs/tags/<tag>`). act_user is
 * the RELEASE PUBLISHER (rel.PublisherID), NOT the flipping doer — the
 * draft→published PATCH keeps the original publisher. Same caught-and-logged
 * posture as the webhook fan-out, awaited inline.
 */
async function emitReleaseEvent(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  row: ReleaseRow,
  action: string,
): Promise<void> {
  if (row.isDraft) {
    return; // upstream emits nothing for drafts (any action)
  }
  const repository = toApiRepository(viewerOf(c), found);
  await emitReleaseWebhook(c, {
    repoId: found.repo.id,
    ownerId: found.repo.ownerId,
    eventType: "release",
    payload: releasePayload(action, await toApiRelease(c.env.DB, viewerOf(c), found, row), repository, c.get("authUser")),
  });
  if (action !== "published") {
    return; // updated/deleted write no action upstream (no notifier method)
  }
  try {
    await recordAction(c.env.DB, {
      actUserId: row.publisherId,
      repoId: found.repo.id,
      opType: ActionType.PublishRelease,
      isPrivate: repository.private === true,
      content: row.title,
      refName: `refs/tags/${row.tagName}`,
    });
  } catch (error) {
    console.error(`[releases] action row failed (${action}): ${errorMessage(error)}`);
  }
}

const listReleasesRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/releases",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "List a repo's releases",
    operationId: "repoListReleases",
    request: {
      params: z.object(ownerRepoParams),
      query: z.object({
        draft: z
          .string()
          .optional()
          .openapi({ type: "boolean", description: "filter (exclude / include) drafts, if you don't have repo write access none will show" }),
        "pre-release": z
          .string()
          .optional()
          .openapi({ type: "boolean", description: "filter (exclude / include) pre-releases" }),
        tag_filter: z
          .string()
          .optional()
          .openapi({ description: 'filter releases by tag. supports "*" as a wildcard (for example: v1*, *beta, *rc*).' }),
        page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
        limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
      }),
    },
    responses: {
      200: { description: "ReleaseList", content: { "application/json": { schema: releaseListSchema } } },
      404: notFoundResponse,
    },
  });

const createReleaseRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/releases",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Create a release",
    operationId: "repoCreateRelease",
    request: {
      params: z.object(ownerRepoParams),
      body: { content: { "application/json": { schema: createReleaseOptionSchema } } },
    },
    responses: {
      201: { description: "Release", content: { "application/json": { schema: releaseSchema } } },
      404: notFoundResponse,
      409: conflictResponse,
      422: validationErrorResponse,
    },
  });

const getLatestReleaseRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/releases/latest",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Gets the most recent non-prerelease, non-draft release of a repository, sorted by created_at",
    operationId: "repoGetLatestRelease",
    request: { params: z.object(ownerRepoParams) },
    responses: {
      200: { description: "Release", content: { "application/json": { schema: releaseSchema } } },
      404: notFoundResponse,
    },
  });

const getReleaseByTagRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/releases/tags/{tag}",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a release by tag name",
    operationId: "repoGetReleaseByTag",
    request: { params: z.object(tagParams) },
    responses: {
      200: { description: "Release", content: { "application/json": { schema: releaseSchema } } },
      404: notFoundResponse,
    },
  });

const deleteReleaseByTagRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/releases/tags/{tag}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete a release by tag name",
    operationId: "repoDeleteReleaseByTag",
    request: { params: z.object(tagParams) },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const getReleaseRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/releases/{id}",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get a release",
    operationId: "repoGetRelease",
    request: { params: z.object(releaseIdParams) },
    responses: {
      200: { description: "Release", content: { "application/json": { schema: releaseSchema } } },
      404: notFoundResponse,
    },
  });

const editReleaseRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/releases/{id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Update a release",
    operationId: "repoEditRelease",
    request: {
      params: z.object(releaseIdParams),
      body: { content: { "application/json": { schema: editReleaseOptionSchema } } },
    },
    responses: {
      200: { description: "Release", content: { "application/json": { schema: releaseSchema } } },
      404: notFoundResponse,
    },
  });

const deleteReleaseRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/releases/{id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete a release",
    operationId: "repoDeleteRelease",
    request: { params: z.object(releaseIdParams) },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

export function registerReleaseRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(listReleasesRoute(optionalAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    const viewer = { origin: new URL(c.req.url).origin, requester: c.get("authUser") ?? null };
    const listOptions = parseListOptions(new URL(c.req.url));
    const query = c.req.valid("query");
    const canWrite = await canWriteRepository(c, found);
    const { items, total } = await listReleases(c.env.DB, found.repo.id, {
      includeDrafts: canWrite,
      isDraft: formOptionalBool(query.draft),
      isPrerelease: formOptionalBool(query["pre-release"]),
      tagFilter: (query.tag_filter ?? "").trim(),
      page: listOptions.page,
      limit: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const rendered = await Promise.all(items.map((row) => toApiRelease(c.env.DB, viewer, found, row)));
    return c.json(rendered, 200);
  });

  app.openapi(
    createReleaseRoute(requireAuth),
    async (c) => {
      const found = await requireReleasesRepo(c, c.req.valid("param"));
      await requireReleaseWriter(c, found);
      const requester = c.get("authUser");
      const viewer = { origin: new URL(c.req.url).origin, requester };
      const form = c.req.valid("json");

      // Upstream fail-fast: an empty repo has no commitish to tag (422).
      // Gate on is_empty — refs_version is observability-only and never
      // synced from the engine (REDEPLOY14's finding: every production repo
      // reads 0 there, so the old gate 422'd every API release create).
      if (found.repo.isEmpty) {
        throw new ApiError(422, "repo is empty");
      }

      let row: ReleaseRow;
      let tagCreated: boolean;
      let tagTip: string | undefined;
      try {
        // The create + git-tag sequence (upstream CreateRelease →
        // release_service.CreateRelease → createTag) — the shared service
        // call; a fresh tag_name lands refs/tags/<tag> from
        // target_commitish, an existing tag rides, a protected tag answers
        // 422 and an unresolvable target 404 "target not found".
        const created = await createReleaseWithGitTag({
          env: c.env,
          d1: c.env.DB,
          pair: found,
          publisherId: requester.id ?? 0,
          doer: requester,
          requestHost: new URL(c.req.url).hostname,
          tagName: form.tag_name,
          targetCommitish: form.target_commitish,
          tagMessage: form.tag_message,
          title: form.name ?? "",
          note: form.body ?? "",
          isDraft: form.draft === true,
          isPrerelease: form.prerelease === true,
        });
        row = created.row;
        tagCreated = created.tagCreated;
        tagTip = created.tagTip;
      } catch (error) {
        if (error instanceof ReleaseAlreadyExistError) {
          throw issueErrorToApiError(error); // the declared 409 (error-body)
        }
        throw error;
      }
      // The ref-webhook pair for a freshly created tag — upstream createTag
      // notifies the created ref exactly like the tags API does
      // (services/release/release.go:125-148 PushCommits + CreateRef); the
      // emission is the tags route's own helpers (byte-identical payloads).
      if (tagCreated && tagTip !== undefined) {
        const fullName = tagRef(form.tag_name);
        await emitRefWebhook(c, found, "push", zeroCommitPushPayload(c, found, fullName, ZERO_OID, tagTip), fullName);
        await emitRefWebhook(
          c,
          found,
          "create",
          {
            sha: tagTip,
            ref: form.tag_name,
            ref_type: "tag",
            repository: toApiRepository(viewerOf(c), found),
            sender: c.get("authUser") ?? null,
          },
          fullName,
        );
      }
      // Webhook: NewRelease (release.go:198) — drafts stay silent.
      await emitReleaseEvent(c, found, row, "published");
      return c.json(await toApiRelease(c.env.DB, viewer, found, row), 201);
    },
    releaseBodyHook,
  );

  app.openapi(getLatestReleaseRoute(optionalAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    const viewer = { origin: new URL(c.req.url).origin, requester: c.get("authUser") ?? null };
    const row = await findLatestRelease(c.env.DB, found.repo.id);
    if (row === null) {
      throw releaseNotExist();
    }
    return c.json(await toApiRelease(c.env.DB, viewer, found, row), 200);
  });

  app.openapi(getReleaseByTagRoute(optionalAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    const viewer = { origin: new URL(c.req.url).origin, requester: c.get("authUser") ?? null };
    const { tag } = c.req.valid("param");
    const row = await findReleaseByTag(c.env.DB, found.repo.id, tag);
    if (row === null) {
      throw releaseNotExist();
    }
    assertNotTagRecord(row);
    assertDraftVisible({ canWrite: await canWriteRepository(c, found) }, row);
    return c.json(await toApiRelease(c.env.DB, viewer, found, row), 200);
  });

  app.openapi(deleteReleaseByTagRoute(requireAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    await requireReleaseWriter(c, found);
    const { tag } = c.req.valid("param");
    const row = await findReleaseByTag(c.env.DB, found.repo.id, tag);
    if (row === null) {
      throw releaseNotExist();
    }
    assertNotTagRecord(row);
    await deleteRelease(c.env.DB, row);
    // Webhook: DeleteRelease (release.go:437) — drafts stay silent.
    await emitReleaseEvent(c, found, row, "deleted");
    return c.body(null, 204);
  });

  app.openapi(getReleaseRoute(optionalAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    const viewer = { origin: new URL(c.req.url).origin, requester: c.get("authUser") ?? null };
    const { id } = c.req.valid("param");
    const row = await requireReleaseById(c, found.repo.id, id);
    assertDraftVisible({ canWrite: await canWriteRepository(c, found) }, row);
    return c.json(await toApiRelease(c.env.DB, viewer, found, row), 200);
  });

  app.openapi(
    editReleaseRoute(requireAuth),
    async (c) => {
      const found = await requireReleasesRepo(c, c.req.valid("param"));
      await requireReleaseWriter(c, found);
      const viewer = { origin: new URL(c.req.url).origin, requester: c.get("authUser") };
      const requester = c.get("authUser");
      const { id } = c.req.valid("param");
      const row = await requireReleaseById(c, found.repo.id, id);
      const form = c.req.valid("json");
      // Upstream applies only the SET fields, and only non-empty strings
      // (len(form.X) > 0 guards); the flags are explicit tri-states — then
      // release_service.UpdateRelease re-runs createTag (the edit's tag arm:
      // a publish-from-draft lands the missing tag, a rename lands the new
      // ref, every published edit re-fills sha1/created/num_commits). The
      // tag-arm failures (the archived gate, protected tag, unresolvable
      // target, unreadable commit) propagate as untyped errors → the
      // handler's 500 "internal server error" — upstream EditRelease maps
      // NONE of UpdateRelease's outcomes (ctx.APIErrorInternal,
      // release.go:379-382).
      const updated = await editRelease({
        env: c.env,
        d1: c.env.DB,
        pair: found,
        doer: requester,
        requestHost: new URL(c.req.url).hostname,
        row,
        patch: {
          tagName: form.tag_name !== undefined && form.tag_name !== "" ? form.tag_name : undefined,
          target: form.target_commitish !== undefined && form.target_commitish !== "" ? form.target_commitish : undefined,
          title: form.name !== undefined && form.name !== "" ? form.name : undefined,
          note: form.body !== undefined && form.body !== "" ? form.body : undefined,
          isDraft: form.draft,
          isPrerelease: form.prerelease,
          now: new Date(),
        },
      });
      if (updated.row === null) {
        // Lost a concurrent rename/delete — the upstream UpdateRelease would
        // surface as an internal error; the re-read keeps the answer honest.
        // (The degraded concurrent path emits no webhook.)
        const fresh = await findReleaseForRepoById(c.env.DB, found.repo.id, row.id);
        if (fresh === null) {
          throw releaseNotExist();
        }
        return c.json(await toApiRelease(c.env.DB, viewer, found, fresh), 200);
      }
      // The ref-webhook pair when the edit landed a FRESH tag — upstream
      // createTag notifies the created ref exactly like the create path
      // (release.go:135-143 PushCommits + CreateRef). The edit-created tag is
      // always lightweight (msg="", release.go:269), so the ref tip IS the
      // filled commit sha1.
      if (updated.tagCreated) {
        const fullName = tagRef(updated.row.tagName);
        const tip = updated.row.sha1 ?? ZERO_OID;
        await emitRefWebhook(c, found, "push", zeroCommitPushPayload(c, found, fullName, ZERO_OID, tip), fullName);
        await emitRefWebhook(
          c,
          found,
          "create",
          {
            sha: tip,
            ref: updated.row.tagName,
            ref_type: "tag",
            repository: toApiRepository(viewerOf(c), found),
            sender: c.get("authUser") ?? null,
          },
          fullName,
        );
      }
      // Webhook: UpdateRelease ("updated", release.go:363) — except an edit
      // that CREATED the tag (isTagCreated), which upstream maps to
      // NewRelease/"published" (release.go:366); a draft result stays silent
      // (emitReleaseEvent's !IsDraft gate). isConvertedFromTag is unreachable
      // — tag-only records 404 above.
      await emitReleaseEvent(c, found, updated.row, updated.tagCreated ? "published" : "updated");
      return c.json(await toApiRelease(c.env.DB, viewer, found, updated.row), 200);
    },
    releaseBodyHook,
  );

  app.openapi(deleteReleaseRoute(requireAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    await requireReleaseWriter(c, found);
    const { id } = c.req.valid("param");
    const row = await requireReleaseById(c, found.repo.id, id);
    await deleteRelease(c.env.DB, row);
    // Webhook: DeleteRelease (release.go:437) — drafts stay silent.
    await emitReleaseEvent(c, found, row, "deleted");
    return c.body(null, 204);
  });
}
