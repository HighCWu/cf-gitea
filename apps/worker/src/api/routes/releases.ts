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
import type { ReleaseAssetRow } from "../services/release-assets";
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
  releasePublisherSender,
  toApiRelease,
  toReleaseChanges,
} from "../services/releases";
import { emitRefWebhook } from "../services/tags";
import { tagCreatePushPayload } from "./tags";

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
 *     in-service MustNotBeArchived arm (services/release/release.go:78-81,
 *     reached by both CreateRelease release.go:214 and UpdateRelease
 *     release.go:300), which neither handler maps — ctx.APIErrorInternal →
 *     500 (release.go:281-283 / :375-378). Upstream's own vendored contract
 *     declares no 500 either; untyped here, the house 500 body.
 *
 * Engine boundary (the N2 wave + the UpdateRelease tag wave): creating AND
 * editing a release land the git tag through the shared tag-store service
 * (upstream CreateRelease → createTag for the create; UpdateRelease's
 * re-run of createTag, release.go:300, for the edit — publish-from-draft
 * lands the missing tag, a tag_name rename lands the NEW ref while the old
 * ref stays (upstream deletes tags only in DeleteReleaseByID, release.go:413),
 * and every published edit re-fills sha1/created/num_commits); DELETE does
 * not delete the ref (the API passes delTag=false) and CONVERTS the row to
 * `is_tag = true` instead of dropping it (release.go:433-439 — a re-create
 * keeps the id, the tags-API delete finds the record, the R2 asset objects
 * are swept beside the rows; the ledger R2+R4 thread).
 *
 * Webhook triggers (`release`, upstream services/webhook/notifier.go
 * sendReleaseHook:889 ← NewRelease:907 / UpdateRelease:911 / DeleteRelease:915,
 * callers services/release/release.go:229,387,390,469): every mutation emits
 * through emitWebhookDeliveries — see emitReleaseWebhook. Upstream gates ALL
 * three actions on `!rel.IsDraft` (release.go:228,385,468): drafts emit
 * nothing, including on delete. Action mapping (SINCE 53aafd7ee1 the fork
 * keys on the OLD row's draft state, release.go:385-391): create →
 * "published"; edit → "updated" unless the edit PUBLISHED a draft or
 * converted a tag record (both → NewRelease/"published") — a tag-CREATING
 * rename between two published states is an "updated" now, the createTag
 * `created` flag no longer drives the fork; delete → "deleted". The
 * "updated" payload carries `changes` (ToReleaseChanges — the old title/
 * note/tag_name, convert/release.go:36-49). SENDER (also 53aafd7ee1):
 * sendReleaseHook now takes the DOER for ALL three actions (:889-905 —
 * NewRelease passes `doer` where it passed `rel.Publisher` before), so the
 * "published" sender is the publishing caller, not the stored publisher.
 * The latest-release POINTER (a5201dc427): create/edit move it through
 * UpdateLatestRelease (release.go:224/:322), delete unsets it (:441-443),
 * and the latest read is pointer-first (models/repo/release.go:345-356).
 * A real-release delete lands the `repository:release:remove` audit row
 * (release.go:465-467, 3f1b738f09).
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

/** Upstream `ctx.FormOptionalBool` (services/context/base_form.go:71-80):
 *  absent/"" = null; otherwise `strconv.ParseBool`'s set — "1","t","T",
 *  "TRUE","true","True" = true, "0","f","F","FALSE","false","False" and
 *  anything else = false (ParseBool's error is discarded upstream) — plus
 *  a case-insensitive "on" (strings.EqualFold). So `?draft=TRUE` filters
 *  IN and `?draft=yes` filters OUT, exactly upstream. */
function formOptionalBool(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === "") return null;
  const parseBoolTrue = raw === "1" || raw === "t" || raw === "T" || raw === "true" || raw === "TRUE" || raw === "True";
  return parseBoolTrue || raw.toLowerCase() === "on";
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
 * (release.go:228,385,468). `assets` preloads the attachment rows the
 * payload renders — the DELETE arm passes the rows deleteRelease read
 * before wiping them, because upstream's DeleteReleaseByID loads
 * Attachments in LoadAttributes BEFORE DeleteAttachmentsByRelease and the
 * notification still renders them (release.go:446-453). `changes` rides the
 * "updated" payload only (sendReleaseHook's Changes argument — nil on
 * published/deleted, ToReleaseChanges on updated, notifier.go:889-917).
 *
 * Activity-feed leg (specs/activity-feeds.md §3.3): ONLY the "published"
 * action records a row — upstream's actionNotifier has a NewRelease method
 * and no UpdateRelease/DeleteRelease ones (services/feed/notifier.go:
 * ActionPublishRelease, content = rel.Title, ref_name =
 * git.RefNameFromTag(rel.TagName).String() = `refs/tags/<tag>`). act_user is
 * the DOER since 53aafd7ee1 (`NewRelease(ctx, doer, rel)` — ActUserID:
 * doer.ID, feed/notifier.go; it was `rel.PublisherID` before), so the
 * publish-from-draft PATCH credits the flipping caller. Same
 * caught-and-logged posture as the webhook fan-out, awaited inline.
 *
 * Sender identity (R2-L7, UPDATED by 53aafd7ee1): sendReleaseHook's doer
 * argument IS the sender (convert.ToUser(ctx, doer, nil), notifier.go:901)
 * for ALL three actions now — NewRelease stopped passing `rel.Publisher`
 * (services/release/release.go:257 passes the doer like the other arms), so
 * every action renders the editing caller.
 */
async function emitReleaseEvent(
  c: Context<ApiEnv>,
  found: RepositoryWithOwner,
  row: ReleaseRow,
  action: string,
  options?: { assets?: ReleaseAssetRow[]; changes?: Record<string, { from: string }> },
): Promise<void> {
  if (row.isDraft) {
    return; // upstream emits nothing for drafts (any action)
  }
  const repository = toApiRepository(viewerOf(c), found);
  const payload: Record<string, unknown> = releasePayload(
    action,
    await toApiRelease(c.env.DB, viewerOf(c), found, row, options?.assets),
    repository,
    c.get("authUser"),
  );
  if (options?.changes !== undefined && action === "updated") {
    payload.changes = options.changes; // ReleasePayload.Changes, hook.go:337
  }
  await emitReleaseWebhook(c, {
    repoId: found.repo.id,
    ownerId: found.repo.ownerId,
    eventType: "release",
    payload,
  });
  if (action !== "published") {
    return; // updated/deleted write no action upstream (no notifier method)
  }
  const doer = c.get("authUser");
  try {
    await recordAction(c.env.DB, {
      actUserId: doer?.id ?? row.publisherId,
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
    summary: "Gets the release set as latest, else the most recent non-prerelease, non-draft release of a repository by created_at",
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
      // `ctx.FormString("tag_filter")` — the RAW query value (release.go:185);
      // upstream does NOT trim here (R16-c; the tag_filterCondition doc
      // covers the LIKE translation).
      tagFilter: query.tag_filter ?? "",
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
      let tagCommitSha: string | undefined;
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
          // GitHub's make_latest (a5201dc427): "true" pins the latest
          // pointer here, "false" keeps it, "" /"legacy" ride the date arms
          // (UpdateLatestRelease, release.go:224 — wasEligible false).
          makeLatest: form.make_latest ?? "",
        });
        row = created.row;
        tagCreated = created.tagCreated;
        tagCommitSha = created.tagCommitSha;
      } catch (error) {
        if (error instanceof ReleaseAlreadyExistError) {
          throw issueErrorToApiError(error); // the declared 409 (error-body)
        }
        throw error;
      }
      // The ref-webhook pair for a freshly created tag — upstream's
      // createTag emission (services/release/release.go:129-146): PushCommits
      // FIRST (:138) with head_commit = the tagged COMMIT (its
      // `commits.HeadCommit = CommitToPushCommit(commit)`, :134) and a
      // `compare/{zero}...{commit}` compare URL (:135), THEN CreateRef (:145)
      // whose `sha` is the COMMIT oid too (`commit.ID.String()` — the
      // release path's pre-peel resolution; R16-e: unlike the tags API
      // (tag.go — which rides the raw ref tip), createTag resolves
      // GetCommit(target) BEFORE writing, so BOTH events carry the peeled
      // commit, never the annotated tag object oid). The payload shape is
      // the §2.3 tag-create pair (tagCreatePushPayload — the tags route's
      // corrected builder, emitUserPushCreatedRef's exact shape). Both events
      // carry rel.Publisher as pusher/sender (:139, :145 — R2-L7); on a
      // create the publisher IS the requester (`PublisherID: doer.ID`,
      // release.go:274-275).
      if (tagCreated && tagCommitSha !== undefined) {
        const fullName = tagRef(row.tagName);
        await emitRefWebhook(
          c,
          found,
          "push",
          await tagCreatePushPayload(c, found, fullName, ZERO_OID, tagCommitSha, tagCommitSha, requester),
          fullName,
        );
        await emitRefWebhook(
          c,
          found,
          "create",
          {
            sha: tagCommitSha,
            ref: row.tagName,
            ref_type: "tag",
            repository: toApiRepository(viewerOf(c), found),
            sender: requester,
          },
          fullName,
        );
      }
      // Webhook: NewRelease (release.go:229) — drafts stay silent.
      await emitReleaseEvent(c, found, row, "published");
      return c.json(await toApiRelease(c.env.DB, viewer, found, row), 201);
    },
    releaseBodyHook,
  );

  app.openapi(getLatestReleaseRoute(optionalAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    const viewer = { origin: new URL(c.req.url).origin, requester: c.get("authUser") ?? null };
    // The pointer-first resolution (repo_model.GetLatestRelease,
    // models/repo/release.go:345-356 — release.go:113 passes the whole
    // Repository): the stored latest_release_id wins when it still passes
    // the stable-release condition, else the newest-by-date fallback.
    const row = await findLatestRelease(c.env.DB, found.repo);
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
    // DeleteReleaseByID(delTag=false): the row CONVERTS to is_tag=true (the
    // id survives a re-create; the tags-API delete finds it), the asset rows
    // + R2 objects + reactions go, the latest pointer is unset
    // (release.go:441-443), the audit row lands (release.go:465-467).
    // `assets` are the pre-wipe rows — the delete payload still renders them
    // (release.go:446-453).
    const requester = c.get("authUser");
    const { assets } = await deleteRelease(c.env, c.env.DB, {
      repo: found.repo,
      pair: found.repo,
      doer: { id: requester?.id ?? 0, username: requester?.username ?? "" },
      origin: "api",
      row,
    });
    // Webhook: DeleteRelease (release.go:469) — drafts stay silent.
    await emitReleaseEvent(c, found, row, "deleted", { assets });
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
      // release.go:375-378).
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
          // GitHub's make_latest (a5201dc427): the edit's pointer move rides
          // wasEligible = the PRE-edit row's CanBeLatest (release.go:322).
          makeLatest: form.make_latest ?? "",
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
      // The ref-webhook pair when the edit landed a FRESH tag — the same
      // createTag emission the create path runs (release.go:129-146, R16-e:
      // both events carry the PEELED COMMIT — the edit-created tag is
      // lightweight (msg="", release.go:300) so the tip IS the filled sha1,
      // and the payload shape is the §2.3 tag-create pair). Pusher/sender =
      // rel.Publisher (release.go:139/:145, R2-L7) — UNCHANGED by the edit:
      // a publish-from-draft (or rename) by a non-publisher still carries
      // the ORIGINAL publisher, not the editing caller (CreateNewTag binds
      // Publisher at insert, release.go:274-275; UpdateRelease never
      // re-binds).
      if (updated.tagCreated) {
        const fullName = tagRef(updated.row.tagName);
        const tip = updated.row.sha1 ?? ZERO_OID;
        const publisher = await releasePublisherSender(c.env.DB, updated.row.publisherId, viewerOf(c).origin);
        await emitRefWebhook(c, found, "push", await tagCreatePushPayload(c, found, fullName, ZERO_OID, tip, tip, publisher), fullName);
        await emitRefWebhook(
          c,
          found,
          "create",
          {
            sha: tip,
            ref: updated.row.tagName,
            ref_type: "tag",
            repository: toApiRepository(viewerOf(c), found),
            sender: publisher,
          },
          fullName,
        );
      }
      // Webhook: UpdateRelease's SINCE-53aafd7ee1 fork (release.go:385-391) —
      // "updated" (with the `changes` payload, ToReleaseChanges over the
      // PRE-edit row) for every published edit that neither converted a tag
      // record nor published a draft; "published" (NewRelease) for a
      // publish-from-draft. A tag-CREATING rename between two published
      // states is an "updated" now — the createTag `created` flag stopped
      // driving the fork (it still drives the ref-webhook pair above). A
      // draft result stays silent (emitReleaseEvent's !IsDraft gate);
      // isConvertedFromTag is unreachable — tag-only records 404 above.
      const changes = toReleaseChanges(updated.row, row);
      await emitReleaseEvent(c, found, updated.row, row.isDraft ? "published" : "updated", { changes });
      return c.json(await toApiRelease(c.env.DB, viewer, found, updated.row), 200);
    },
    releaseBodyHook,
  );

  app.openapi(deleteReleaseRoute(requireAuth), async (c) => {
    const found = await requireReleasesRepo(c, c.req.valid("param"));
    await requireReleaseWriter(c, found);
    const { id } = c.req.valid("param");
    const row = await requireReleaseById(c, found.repo.id, id);
    // DeleteReleaseByID(delTag=false) — the is_tag conversion + pointer
    // unset + audit row (see the by-tag arm's note); the payload carries the
    // pre-wipe assets.
    const requester = c.get("authUser");
    const { assets } = await deleteRelease(c.env, c.env.DB, {
      repo: found.repo,
      pair: found.repo,
      doer: { id: requester?.id ?? 0, username: requester?.username ?? "" },
      origin: "api",
      row,
    });
    // Webhook: DeleteRelease (release.go:469) — drafts stay silent.
    await emitReleaseEvent(c, found, row, "deleted", { assets });
    return c.body(null, 204);
  });
}
