import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import {
  AvatarBase64Error,
  AvatarOriginTooLargeError,
  MAX_AVATAR_WIRE_BYTES,
  decodeStrictBase64,
  deleteAvatar,
  processAvatarImage,
  uploadAvatar,
  type AvatarTarget,
} from "../../services/avatars";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { orgDoerOf } from "../services/org-repos";
import type { OrgDoer } from "../services/org-repos";
import type { OrgRecord } from "../../services/orgs/orgs";
import { OrgService } from "../../services/orgs/orgs";
import { requireOrgOwnership, requireOrgVisible, resolveOrgForRequest } from "../services/orgs";
import { requireRepoAdmin, requireVisibleRepo } from "../services/repo-access";

/**
 * The six avatar ops of the remaining-API inventory's `wave-api-avatars`
 * batch (docs/compat/api-remaining-inventory.md Batch 4 — table-free over
 * the REPO_PACKS bucket, services/avatars.ts carries the storage + processor
 * ports and every upstream cite for them):
 *
 *   user: POST   /user/avatar                    (userUpdateAvatar)
 *         DELETE /user/avatar                    (userDeleteAvatar)
 *         — routers/api/v1/user/avatar.go; reqToken on the /user group
 *           (api.go:1204–1208) + rejectPublicOnly() (a SPEC-0002 API-layer
 *           gate, standing deferral like every /user family —
 *           routes/user-settings.ts header).
 *   org:  POST   /orgs/{org}/avatar              (orgUpdateAvatar)
 *         DELETE /orgs/{org}/avatar              (orgDeleteAvatar)
 *         — routers/api/v1/org/avatar.go; reqToken + reqOrgOwnership
 *           (api.go:1772–1776) over the orgAssignment context — the landed
 *           orgs.ts guard trio (307 rename redirect included).
 *   repo: POST   /repos/{owner}/{repo}/avatar    (repoUpdateAvatar)
 *         DELETE /repos/{owner}/{repo}/avatar    (repoDeleteAvatar)
 *         — routers/api/v1/repo/avatar.go; repoAssignment + reqAdmin +
 *           reqToken (api.go:1547–1551) → requireVisibleRepo (404) +
 *           requireRepoAdmin (403, upstream's exact reqAdmin message).
 *
 * Error arms (declared sets are EXACTLY the frozen contract's — 204 alone
 * for the user pair, {204,404} for org/repo):
 *   - 401 (requireAuth) / 403 (ownership, repo-admin) / 500 (the
 *     APIErrorInternal class) / 422 (the bind hook, schema-invalid bodies) /
 *     400 (hono's malformed-JSON reader, the landed /markdown-precedent
 *     divergence; base64 decode; origin cap) / 413 (wire cap) are all
 *     RUNTIME-ONLY codes the contract omits — the orchestrator-owned
 *     scripts/check-openapi.mjs RUNTIME_ONLY_RESPONSES class (documented
 *     there at integration).
 *   - base64 failure → 400 `illegal base64 data at input byte N` (the
 *     upstream ctx.APIError(400, err) text, user/avatar.go:33–37).
 *   - unknown/corrupt/oversized-dimension image → untyped throw → the landed
 *     500 `internal server error` convention (errors.ts header; upstream's
 *     APIErrorInternal blanks the message in prod the same way).
 *   - at-or-over the 262 144-byte origin cap → 400 (cf-gitea has no image
 *     pipeline; upstream resizes — the batch's documented divergence,
 *     services/avatars.ts header).
 *   - `MAX_AVATAR_WIRE_BYTES` guard middleware rejects an over-cap declared
 *     Content-Length BEFORE the body (or the zod validator) reads it.
 *
 * Body-bind corners (Go zero-value parity): the contract's body param is
 * optional and `image` is a plain optional string, so the declaration
 * matches; an absent image decodes as Go's zero value (`""` → the
 * unknown-format 500, exactly upstream's `{}` behavior), while a missing
 * JSON content-type (no body at all) reaches the handler as `{}` where Go's
 * bind EOFs with 422 — a corner divergence for already-broken requests,
 * recorded here since the declared doc must mirror the contract.
 */

const emptyResponse = { description: "empty" } as const;

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/** `#/definitions/UpdateUserAvatarOption` / `UpdateRepoAvatarOption` — an
 *  identical single optional `image` string (base64) in the vendored
 *  contract; `undefined` rides Go's zero-value bind (`""`). */
const avatarOptionSchema = z.object({
  image: z.string().optional().openapi({ description: "image must be base64 encoded" }),
});
type AvatarOption = z.infer<typeof avatarOptionSchema>;

/** The org/repo path params, verbatim from the contract. */
const orgParam = z.object({ org: z.string().min(1).openapi({ description: "name of the organization" }) });
const repoParams = z.object({
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
});

/** Body bind hook — upstream's Go bind answers malformed/invalid bodies with
 *  422 (routers/api/v1/api.go bind); the family's generic text stands in for
 *  Go's per-field message (the hooks-scopes convention). */
const avatarBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/**
 * The pre-body wire cap: a declared Content-Length beyond
 * MAX_AVATAR_WIRE_BYTES cannot carry an acceptable image (its base64 form is
 * ~350 KiB at most), so the request is rejected before ANY body byte is read
 * — the zod validator (which buffers the JSON) never runs (route middleware
 * precede the generated validators, @hono/zod-openapi's openapi()).
 */
function avatarWireCap(): MiddlewareHandler<ApiEnv> {
  return (c, next) => {
    const declared = c.req.header("content-length");
    const length = declared === undefined ? undefined : Number.parseInt(declared, 10);
    if (length !== undefined && Number.isFinite(length) && length > MAX_AVATAR_WIRE_BYTES) {
      throw new ApiError(413, `avatar request body exceeds the ${MAX_AVATAR_WIRE_BYTES} byte wire limit`);
    }
    return next();
  };
}

// ---------------------------------------------------------------------------
// Org-scope guard (the routes/orgs.ts + hooks-scopes.ts trio, restated —
// resolveOrg is private there and neither module is this wave's ownership)
// ---------------------------------------------------------------------------

/** Shared 404 for org-scoped misses (missing org, plain user under /orgs,
 *  invisible org — APIErrorNotFound, all indistinguishable upstream). */
function orgNotFound(): ApiError {
  return new ApiError(404, "not found");
}

/**
 * The renamed-org 307 as a thrown HTTPException carrying its prepared
 * response (services/context/context_response.go RedirectToUser) — the
 * declared response union stays {204,404}-shaped while giteaErrorHandler
 * passes the prepared 307 through untouched.
 */
function renamedOrgRedirect(location: string): HTTPException {
  return new HTTPException(307, {
    res: new Response(null, { status: 307, headers: { Location: location } }),
  });
}

/**
 * orgAssignment + reqOrgOwnership for the avatar pair: resolve the org (307
 * on rename, 404-shaped miss otherwise), require visibility, require
 * ownership (owner or site admin, else the exact upstream 403 message).
 */
async function requireOrgAvatarAccess(
  d1: D1Database,
  orgName: string,
  doer: OrgDoer & { id: number },
  requestPath: string,
  requestQuery: string,
): Promise<OrgRecord> {
  const resolved = await resolveOrgForRequest(d1, orgName, doer, requestPath, requestQuery);
  if (resolved.kind === "redirect") {
    throw renamedOrgRedirect(resolved.location);
  }
  if (resolved.kind === "missing") {
    throw orgNotFound();
  }
  const orgs = new OrgService(d1);
  await requireOrgVisible(orgs, resolved.org, doer);
  await requireOrgOwnership(orgs, resolved.org, doer);
  return resolved.org;
}

/** Doer slice for the org guards — requireAuth has resolved the caller. */
function authedDoer(c: Context<ApiEnv>): OrgDoer & { id: number } {
  return orgDoerOf(c.get("authUser"));
}

// ---------------------------------------------------------------------------
// The shared decode → process → store body (the three upstream POST handlers)
// ---------------------------------------------------------------------------

/**
 * user/avatar.go UpdateAvatar + org/avatar.go UpdateAvatar + repo/avatar.go
 * UpdateAvatar minus the response writing: strict StdEncoding decode (400),
 * the ProcessAvatarImage caps (origin over-cap 400; everything else the
 * untyped APIErrorInternal class), then the R2 store.
 */
async function storeAvatar(c: Context<ApiEnv>, target: AvatarTarget, form: AvatarOption): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = decodeStrictBase64(form.image ?? "");
  } catch (error) {
    if (error instanceof AvatarBase64Error) {
      throw new ApiError(400, error.message);
    }
    throw error;
  }
  let processed: ReturnType<typeof processAvatarImage>;
  try {
    processed = processAvatarImage(bytes);
  } catch (error) {
    if (error instanceof AvatarOriginTooLargeError) {
      throw new ApiError(400, error.message);
    }
    throw error; // upstream's APIErrorInternal arm → the landed 500 convention
  }
  await uploadAvatar({
    bucket: c.env.REPO_PACKS,
    d1: c.env.DB,
    target,
    data: processed.data,
    contentType: processed.contentType,
  });
}

// ---------------------------------------------------------------------------
// Route declarations — declared response sets are exactly the contract's
// ---------------------------------------------------------------------------

const userUpdateAvatarRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/user/avatar",
    middleware: [requireAuth, avatarWireCap()],
    tags: ["user"],
    summary: "Update Avatar",
    operationId: "userUpdateAvatar",
    request: { body: { content: { "application/json": { schema: avatarOptionSchema } } } },
    responses: { 204: emptyResponse },
  });

const userDeleteAvatarRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/user/avatar",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Delete Avatar",
    operationId: "userDeleteAvatar",
    responses: { 204: emptyResponse },
  });

const orgUpdateAvatarRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/orgs/{org}/avatar",
    middleware: [requireAuth, avatarWireCap()],
    tags: ["organization"],
    summary: "Update Avatar",
    operationId: "orgUpdateAvatar",
    request: {
      params: orgParam,
      body: { content: { "application/json": { schema: avatarOptionSchema } } },
    },
    responses: { 204: emptyResponse, 404: notFoundResponse },
  });

const orgDeleteAvatarRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/orgs/{org}/avatar",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Delete Avatar",
    operationId: "orgDeleteAvatar",
    request: { params: orgParam },
    responses: { 204: emptyResponse, 404: notFoundResponse },
  });

const repoUpdateAvatarRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/avatar",
    middleware: [requireAuth, avatarWireCap()],
    tags: ["repository"],
    summary: "Update avatar",
    operationId: "repoUpdateAvatar",
    request: {
      params: repoParams,
      body: { content: { "application/json": { schema: avatarOptionSchema } } },
    },
    responses: { 204: emptyResponse, 404: notFoundResponse },
  });

const repoDeleteAvatarRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/avatar",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete avatar",
    operationId: "repoDeleteAvatar",
    request: { params: repoParams },
    responses: { 204: emptyResponse, 404: notFoundResponse },
  });

// ---------------------------------------------------------------------------
// Registration — handlers
// ---------------------------------------------------------------------------

export function registerAvatarRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // POST /user/avatar — the doer IS the target (user/avatar.go:17–46); the
  // body-bind hook maps validator failures to upstream's bind 422.
  app.openapi(userUpdateAvatarRoute(requireAuth), async (c) => {
    const doer = authedDoer(c);
    await storeAvatar(c, { kind: "user", principalId: doer.id }, c.req.valid("json"));
    return c.body(null, 204);
  }, avatarBodyHook);

  // DELETE /user/avatar — no 404 arm exists upstream: a no-avatar doer still
  // 204s (user/avatar.go DeleteAvatar, services/user/avatar.go:46–69).
  app.openapi(userDeleteAvatarRoute(requireAuth), async (c) => {
    const doer = authedDoer(c);
    await deleteAvatar(c.env.REPO_PACKS, c.env.DB, { kind: "user", principalId: doer.id });
    return c.body(null, 204);
  });

  // POST/DELETE /orgs/{org}/avatar — org.AsUser() upstream (org/avatar.go:46,
  // :73): the org row IS the users row, so the same marker column + u_ key
  // namespace as the user pair, behind the ownership gates.
  app.openapi(orgUpdateAvatarRoute(requireAuth), async (c) => {
    const doer = authedDoer(c);
    const { org: orgName } = c.req.valid("param");
    const url = new URL(c.req.url);
    const org = await requireOrgAvatarAccess(
      c.env.DB,
      orgName,
      doer,
      c.req.path,
      url.search.startsWith("?") ? url.search.slice(1) : url.search,
    );
    await storeAvatar(c, { kind: "org", principalId: org.id }, c.req.valid("json"));
    return c.body(null, 204);
  }, avatarBodyHook);

  app.openapi(orgDeleteAvatarRoute(requireAuth), async (c) => {
    const doer = authedDoer(c);
    const { org: orgName } = c.req.valid("param");
    const org = await requireOrgAvatarAccess(c.env.DB, orgName, doer, c.req.path, "");
    await deleteAvatar(c.env.REPO_PACKS, c.env.DB, { kind: "org", principalId: org.id });
    return c.body(null, 204);
  });

  // POST/DELETE /repos/{owner}/{repo}/avatar — repoAssignment + reqAdmin +
  // reqToken (api.go:1547–1551): visibility 404 first, then the admin gate's
  // upstream 403 message; no archived gate exists on the upstream group.
  app.openapi(repoUpdateAvatarRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    await requireRepoAdmin(c, found);
    await storeAvatar(
      c,
      { kind: "repo", storageKey: found.repo.storageKey },
      c.req.valid("json"),
    );
    return c.body(null, 204);
  }, avatarBodyHook);

  app.openapi(repoDeleteAvatarRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    await requireRepoAdmin(c, found);
    await deleteAvatar(c.env.REPO_PACKS, c.env.DB, { kind: "repo", storageKey: found.repo.storageKey });
    return c.body(null, 204);
  });
}
