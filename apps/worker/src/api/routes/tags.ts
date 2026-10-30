import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context, MiddlewareHandler } from "hono";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { releases } from "../../db/schema";
import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import {
  deleteApiRefError,
  engineCell,
  engineReads,
  refTipMap,
  tagRef,
  ZERO_OID,
} from "../services/engine";
import { annotatedTagSchema, createTagOptionSchema, tagSchema, type Tag } from "../models/git";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { assertNotArchived, canWriteRepository, requireVisibleRepo } from "../services/repo-access";
import { toApiRepository, viewerOf, type RepositoryWithOwner } from "../services/repository";
import { isTagControlAllowed, listProtectedTags } from "../../services/tag-protection";
import { emitRefWebhook, readTagData, renderAnnotatedTag, renderTag, resolveTagTarget, writeTagRef, zeroCommitPushPayload } from "../services/tags";

/**
 * Tier-1 tag routes (SPEC-0004 §2.4 rows repoListTags / repoCreateTag /
 * repoGetTag / repoDeleteTag / GetAnnotatedTag — 3 paths, 5 operations).
 * Reads resolve names from the engine refs table (targets + the peel cache
 * distinguish annotated from lightweight) and render the message/tagger arms
 * through the tags service's read side (services/tags.ts readTagData — the
 * engine's `readTag` RPC for annotated payloads, the commit read for
 * lightweight ones; residuals-v1.3.2 P3-11). Creation builds the tag object
 * Worker-side through the engine's canonical `serializeTag` and lands it via
 * putApiObjects + commitApiChange (the SPEC-0004 §3.4 commit-builder
 * mapping); deletion is deleteApiRef.
 *
 * Upstream behavior mirrored (routers/api/v1/repo/tag.go):
 *   - POST answers **200** with the Tag — the DECLARED surface: upstream's own
 *     swagger comment (tag.go:185-197) and the frozen contract
 *     (v1-swagger/v1-openapi3.generated.json, both checked by
 *     scripts/check-openapi.mjs) declare {200,404,405,409,422,423} — no 201.
 *     Upstream's RUNTIME drifts from its own declaration with
 *     http.StatusCreated (tag.go:230) — an upstream-internal divergence we do
 *     not copy (contract compatibility is the goal);
 *   - POST on an empty repo → **405**; a missing `target` → 404
 *     "target not found: …"; a duplicate tag → 409 "tag already exists";
 *   - DELETE refuses a tag that has a release attached with 409 "a tag
 *     attached to a release cannot be deleted directly" (the releases table
 *     lookup the release routes share);
 *   - GET /git/tags/{sha} is annotated tag OBJECTS only — lightweight tags
 *     (no peel on the refs row) and unknown oids → 404; a malformed param →
 *     the declared 400 "SHA not provided" family.
 *
 * The message arms render upstream's ToTag/ToAnnotatedTag fields
 * (services/convert/convert.go) through the service's renderTag /
 * renderAnnotatedTag: `message` = the annotated tag object's payload
 * (signature armor stripped engine-side, upstream parsePayloadSignature) or
 * the target commit's message for a lightweight tag (getTag's commit arm,
 * modules/git/repo_tag.go:213-219); `tagger` = the annotated tag's tagger
 * identity (ToCommitUser) on the AnnotatedTag surface only — the Tag schema
 * carries no tagger field. The former P3-11 deviation (message always "",
 * tagger null) is CLOSED by the engine's readTag RPC.
 *
 * WILDCARD ADDRESSABILITY — upstream DECLARES `{tag}` single-segment in its
 * swagger but registers the two name-addressed ops under chi catch-alls
 * (`m.Get("/*", repo.GetTag)` / `m.Delete("/*", ...)` —
 * routers/api/v1/api.go:1333-1338) reading the name with
 * `ctx.PathParam("*")` (tag.go:153/:269) — so tag names git allows that
 * contain slashes (`release/v1.2`) address correctly on upstream's wire.
 * Ours mirrors that runtime shape: the declared `{tag}` routes stay verbatim
 * (the frozen contract's shape — upstream's swagger text is identical), and
 * each has a plain-Hono `/repos/:owner/:repo/tags/*` sibling sharing the same
 * handler core. Slash-free names match the declared route (hono's param route
 * wins the shared prefix — probed on the branch-protections twin), so the two
 * arms never disagree. POST /tags (create) is body-addressed, not
 * path-addressed — a slash `tag_name` needs no wildcard. The sibling's tag
 * name cuts the path tail anchored on the `repos/{owner}/{repo}/tags` shape
 * scanned from the LEFT (mount-depth immune — hono keeps c.req.path
 * unstripped inside a .route()-mounted sub-app).
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

/** The wildcard siblings' Hono pattern — the runtime catch-all under the
 *  same prefix the declared `{tag}` route serves (module-header note). */
const WILDCARD_ROUTE = "/repos/:owner/:repo/tags/*";

// ---------------------------------------------------------------------------
// The name-addressed handler cores — shared by the declared {tag} routes and
// their wildcard siblings so the two addressability arms can never disagree
// (the branch-protections module's pattern). The repo gates stay in the
// wrappers (requireVisibleRepo in each — the wildcard's owner/repo decode
// exactly like the declared route's); the delete core carries the
// archived/empty/write gates so every arm gates identically.
// ---------------------------------------------------------------------------

/** repoGetTag's body — the refs-table lookup + the shared Tag render (the
 *  message/tagger arms ride the tags service's read side, readTagData). */
async function getTagByName(c: Context<ApiEnv>, pair: RepositoryWithOwner, tagName: string): Promise<Tag> {
  const tip = refTipMap(await engineReads(c.env, pair.repo).listRefs()).get(tagRef(tagName));
  if (tip === undefined) {
    throw new ApiError(404, "tag doesn't exist: " + tagName);
  }
  const data = await readTagData(c.env, pair.repo, tip);
  if (data.commitSha === null) {
    throw new ApiError(404, "tag doesn't exist: " + tagName);
  }
  return renderTag(tagName, tip, data.commitSha, data, pair, viewerOf(c).origin);
}

/** repoDeleteTag's body — gates, the release coupling, the CAS delete, and
 *  the push/delete webhook pair. */
async function deleteTagByName(c: Context<ApiEnv>, pair: RepositoryWithOwner, tagName: string): Promise<void> {
  assertNotArchived(pair);
  if (pair.repo.isEmpty) {
    throw new ApiError(405, "Git Repository is empty.");
  }
  if (!(await canWriteRepository(c, pair))) {
    throw new ApiError(403, "user should have a permission to write to the target branch");
  }
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
}

/**
 * The wildcard sibling's tag name — the decoded RAW tail after the canonical
 * prefix (hono's catch-all carries no param; upstream reads
 * ctx.PathParam("*"), tag.go:153/:269). The handler may see the FULL request
 * path (the worker mounts the api router at /api/v1 — hono keeps c.req.path
 * unstripped inside the sub-app), so the cut anchors on the
 * `repos/{owner}/{repo}/tags` shape found scanning from the LEFT: the real
 * family prefix always precedes the tag name, so the first match wins
 * whatever the mount depth (and a tag containing "repos"/"tags" as later
 * segments cannot hijack it). Decode mirrors hono's own param decode: one
 * decodeURIComponent pass, a malformed escape keeps the raw text.
 */
function tagNameOfTail(c: Context<ApiEnv>): string {
  const segments = c.req.path.split("/");
  let cut = -1;
  for (let i = 0; i + 3 < segments.length; i++) {
    if (segments[i] === "repos" && segments[i + 3] === "tags") {
      cut = i + 4;
      break;
    }
  }
  const tail = cut === -1 ? "" : segments.slice(cut).join("/");
  try {
    return decodeURIComponent(tail);
  } catch {
    return tail;
  }
}

/** The wildcard sibling's repo path — the labeled params (owner/repo decode
 *  exactly like the declared route's). */
function wildcardRepoPath(c: Context<ApiEnv, typeof WILDCARD_ROUTE>): { owner: string; repo: string } {
  const { owner, repo } = c.req.param();
  return { owner, repo };
}

// ---------------------------------------------------------------------------
// Webhook triggers — the emission helpers (emitRefWebhook /
// zeroCommitPushPayload and their queue probe) live in services/tags.ts so
// the release-create path fires the byte-identical payload pair; the
// delivery-row insert still runs INLINE after the ref mutation committed;
// only the Queue producer ({deliveryId} batch) hangs off the
// executionCtx-guarded waitUntil — in-process callers (tests via
// app.request) have no executionCtx, skip the enqueue, and leave the rows
// `pending`. Failures are logged, never propagated — a webhook miss can
// never fail the API write (§3.5's post-commit posture).
// ---------------------------------------------------------------------------

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
          const data = await readTagData(c.env, pair.repo, tip);
          return data.commitSha === null ? null : renderTag(tip.name, tip, data.commitSha, data, pair, viewer.origin);
        }),
      );
      return c.json(rendered.filter((tag) => tag !== null), 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/tags (repoCreateTag) — contract 200 (see the
  // header note: declared {200,...}, upstream runtime drifts to 201 tag.go:230)
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

      // Target resolution: explicit `target` (a branch/tag name, full ref, or
      // oid) or the default branch (CreateTag → GetTargetCommit) — the
      // shared tag-store service (services/tags.ts), one listRefs serving
      // the duplicate check below.
      const resolved = await resolveTagTarget(c.env, pair.repo, form.target);
      if (resolved.tag === "not-found") {
        throw new ApiError(404, `target not found: ${resolved.target}`);
      }
      const commitSha = resolved.commitSha;

      if (resolved.tips.has(tagRef(name))) {
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

      // The write itself — a message creates the ANNOTATED tag object
      // (serializeTag → putApiObjects → ref CAS); without one the tag is
      // lightweight (the shared tag-store service).
      const written = await writeTagRef(c.env, pair.repo, {
        name,
        commitSha,
        message: form.message,
        doer,
        requestHost: new URL(c.req.url).hostname,
      });
      if (written.tag === "invalid") {
        throw new ApiError(422, written.reason);
      }
      if (written.tag === "conflict") {
        throw written.error;
      }
      const newTarget = written.refTip;

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
      // The response renders what a subsequent GET of the same name would
      // serve: the message arm rides the same readTagData read side — for the
      // annotated create that is the tag object's own payload (== form's
      // message), for a lightweight create the target commit's message
      // (upstream GetTag(form.TagName) → ToTag, tag.go:225-230). A degraded
      // read degrades to the pre-P3-11 shape (message ""), never a 500.
      const newTip = newTarget === commitSha ? { target: newTarget } : { target: newTarget, peeled: commitSha };
      const data = await readTagData(c.env, pair.repo, newTip);
      return c.json(renderTag(name, newTip, commitSha, data, pair, viewer.origin), 200);
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
      return c.json(await getTagByName(c, pair, c.req.valid("param").tag), 200);
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
      await deleteTagByName(c, pair, c.req.valid("param").tag);
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // The wildcard siblings — GET/DELETE …/tags/* (the multi-segment tag names
  // git allows: `release/v1.2`). Upstream DECLARES {tag} in its swagger but
  // registers these two under chi catch-alls (`m.Get("/*", repo.GetTag)` /
  // `m.Delete("/*", ...)` — api.go:1333-1338) reading `ctx.PathParam("*")`
  // (tag.go:153/:269); ours mirrors the runtime shape with plain Hono routes
  // sharing the declared ops' cores. Plain routes (never app.openapi): they
  // must NOT appear in the generated spec — the frozen contract keeps the
  // single-segment {tag} declaration, which is upstream's own swagger text.
  // Registered AFTER the {tag} family: slash-free names match the declared
  // route (hono's param route wins the shared prefix — probed), so the two
  // arms never disagree.
  // -------------------------------------------------------------------------
  app.get(WILDCARD_ROUTE, optionalAuth, async (c) => {
    const pair = await requireVisibleRepo(c, wildcardRepoPath(c));
    return c.json(await getTagByName(c, pair, tagNameOfTail(c)), 200);
  });
  app.delete(WILDCARD_ROUTE, requireAuth, async (c) => {
    const pair = await requireVisibleRepo(c, wildcardRepoPath(c));
    await deleteTagByName(c, pair, tagNameOfTail(c));
    return c.body(null, 204);
  });

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
      // The message + tagger arms ride readTag (the annotated tag OBJECT at
      // this sha) — upstream ToAnnotatedTag's MessageUTF8 + ToCommitUser.
      const data = await readTagData(c.env, pair.repo, tip);
      return c.json(renderAnnotatedTag(tip.name, tip, tip.peeled, data, pair, viewerOf(c).origin), 200);
    },
  );
}
