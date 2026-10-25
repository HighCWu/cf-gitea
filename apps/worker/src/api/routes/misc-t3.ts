import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { gpgKeyListSchema, gpgKeySchema } from "../models/gpg-key";
import { publicKeyListSchema, publicKeySchema } from "../models/public-key";
import { parseListOptions, setPaginationHeaders } from "../pagination";

/**
 * Tier-3 straggler batch — the `miscellaneous`/`user`-tagged ops the misc
 * wave deferred and the re-enumeration found honestly implementable with NO
 * schema changes (SPEC-0004 appendix A; zero new tables — in fact zero table
 * reads at all):
 *
 *   - GET /signing-key.gpg (getSigningKey): upstream serves the instance's
 *     default signing key (gitea/routers/api/v1/misc/signing.go:14-24 —
 *     `getSigningKey` reads `asymkey_service.PublicSigningKey`, and a blank
 *     key format answers `ctx.APIErrorNotFound("no signing key")`, i.e. a 404
 *     with the `{message, url}` JSON body). cf-gitea has NO signing-key
 *     configuration, so the format is always blank and the honest runtime
 *     answer is ALWAYS that 404 — never the contract's 200 text/plain. The
 *     vendored contract declares 200 ONLY, so the 404 is a documented
 *     runtime-only exception in scripts/check-openapi.mjs
 *     (RUNTIME_ONLY_RESPONSES — the orchestrator-granted entry). Upstream
 *     wires the route in the anonymous "Misc (public accessible)" group
 *     (routers/api/v1/api.go:1015) — no auth middleware here either.
 *   - GET /signing-key.pub (getSigningKeySSH): the SAME story one helper over —
 *     upstream's SigningKeySSH calls the identical getSigningKey helper with
 *     the SSH expected format (gitea/routers/api/v1/misc/signing.go:67,100), so
 *     the blank-format branch — and therefore the exact 404 message
 *     "no signing key" (signing.go:19-21) — matches /signing-key.gpg verbatim;
 *     only the contract's 200 description differs ("ssh public key"). The
 *     orchestrator-granted RUNTIME_ONLY_RESPONSES entry covers it the same
 *     way, and upstream wires it anonymously right next to .gpg (api.go:1016).
 *   - GET/DELETE /user/keys[/{id}] + GET/DELETE /user/gpg_keys[/{id}]
 *     (userCurrentListKeys / userCurrentGetKey / userCurrentDeleteKey /
 *     userCurrentListGPGKeys / userCurrentGetGPGKey /
 *     userCurrentDeleteGPGKey): the doer-scoped siblings of routes/identity.ts's
 *     `/users/{username}/keys|gpg_keys` empty-storage stubs. cf-gitea has no
 *     key storage (no public_key/gpg_key tables, no CRUD), so:
 *       - the lists render the contract's declared list shape as the EMPTY
 *         ARRAY with total 0 (upstream listPublicKeys/listGPGKeys over an
 *         empty key set — key.go:96-99 header family still emitted);
 *       - every id lookup is a miss → the upstream not-exist arms answer 404
 *         "not found" (key.go:187-193 GetPublicKey,
 *         key.go:291-296 DeletePublicKey via PublicKeyIsExternallyManaged's
 *         ErrNotExist, gpg_key.go:128-129 GetGPGKey,
 *         gpg_key.go:234-235 DeleteGPGKey);
 *       - `fingerprint` on GET /user/keys is accepted (declared param) and
 *         has nothing to filter — same note as identity.ts.
 *     Upstream wires the whole /user group reqToken'd
 *     (routers/api/v1/api.go:1217), so the declared 401 is the requireAuth
 *     answer; the declared 403 is `rejectPublicOnly()` (public-only tokens)
 *     and is UNREACHABLE — no public-only token grades exist (identity.ts's
 *     documented-unreachable-403 precedent).
 *
 * Re-enumerated and NOT shipped (with reasons, so the next wave does not
 * re-litigate; /signing-key.pub graduated out of this list once its
 * RUNTIME_ONLY_RESPONSES grant landed):
 *   - GET/POST/DELETE /users/{username}/tokens: upstream gates them with
 *     `reqSelfOrAdmin(), reqBasicOrRevProxyAuth()` (api.go:1070-1072) —
 *     basic-auth-only; the users schema stores no password credential, and
 *     the runtime 401 (anonymous basic) is undeclared.
 *   - GET /user/times + GET /user/stopwatches: the 0012 tables exist, but the
 *     contract declares 200 ONLY while upstream's rejectPublicOnly + reqToken
 *     wiring 401s anonymous callers — the runtime-only 401 has no granted
 *     exception entry.
 *   - /user/hooks: the contract declares {200}/{201}/{204} only (runtime 401
 *     undeclared), and creation needs user-vs-org hook ownership semantics
 *     our single webhooks table does not model.
 *   - /user/emails, /user/blocks, /user/applications/oauth2, /user/avatar,
 *     /user/teams, /users/{username}/activities/feeds: need tables/storage
 *     that do not exist (email_addresses, user_block, oauth2_application,
 *     avatar storage, teams, action feeds) — schema changes.
 *   - POST /user/keys, POST /user/gpg_keys, GET /user/gpg_key_token,
 *     POST /user/gpg_key_verify: creation/verification over the nonexistent
 *     key storage — no honest status to answer.
 *   - /user/actions/*, /user/projects*, /users/{username}/projects: deferred
 *     feature areas (Actions, projects — SPEC-0004 §2.6 tiering), not a
 *     table-free question.
 *   - GET /emoji, /nodeinfo, /.well-known/nodeinfo: re-verified ABSENT from
 *     the frozen contract at this pin (the misc wave's finding stands).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const unauthorizedResponse = {
  description: "unauthorized",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

/** Numeric-id path param, wire-string/contract-integer per the repo convention
 *  (routes/hook-delivery.ts): any wire value reaches the handler, where the
 *  zero-key miss renders the upstream not-exist 404 (non-numeric ids behave
 *  like upstream's PathParamInt64 → 0 → ErrNotExist). */
const keyIdParam = (description: string) =>
  ({
    params: z.object({
      id: z.string().min(1).openapi({ type: "integer", format: "int64", description }),
    }),
  }) as const;

// ---------------------------------------------------------------------------
// GET /signing-key.gpg (getSigningKey)
// ---------------------------------------------------------------------------

const signingKeyGpgRoute = createRoute({
  method: "get",
  path: "/signing-key.gpg",
  tags: ["miscellaneous"],
  summary: "Get default signing-key.gpg",
  operationId: "getSigningKey",
  responses: {
    200: {
      description: "GPG armored public key",
      content: { "text/plain": { schema: z.string() } },
    },
    // Runtime-only (check-openapi.mjs RUNTIME_ONLY_RESPONSES): the only
    // reachable status without a signing-key configuration — the contract
    // documents the 200 alone. Declared so the operation's served set mirrors
    // the contract plus the one documented exception.
    404: notFoundResponse,
  },
});

const signingKeyPubRoute = createRoute({
  method: "get",
  path: "/signing-key.pub",
  tags: ["miscellaneous"],
  summary: "Get default signing-key.pub",
  operationId: "getSigningKeySSH",
  responses: {
    200: {
      description: "ssh public key",
      content: { "text/plain": { schema: z.string() } },
    },
    // Runtime-only (check-openapi.mjs RUNTIME_ONLY_RESPONSES): same story as
    // /signing-key.gpg — SigningKeySSH feeds the SSH expected format into the
    // SAME getSigningKey helper (misc/signing.go:100), so without a
    // signing-key configuration the blank-format arm answers identically.
    404: notFoundResponse,
  },
});

// ---------------------------------------------------------------------------
// /user/keys + /user/gpg_keys (the doer-scoped key families)
// ---------------------------------------------------------------------------

const userCurrentListKeysRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/keys",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the authenticated user's public keys",
    operationId: "userCurrentListKeys",
    request: {
      ...listQuery,
      query: listQuery.query.extend({
        fingerprint: z.string().optional().openapi({ description: "fingerprint of the key" }),
      }),
    },
    responses: {
      200: {
        description: "PublicKeyList",
        content: { "application/json": { schema: publicKeyListSchema } },
      },
      401: unauthorizedResponse,
      403: forbiddenResponse,
    },
  });

const userCurrentGetKeyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/keys/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Get a public key",
    operationId: "userCurrentGetKey",
    request: keyIdParam("id of key to get"),
    responses: {
      200: {
        description: "PublicKey",
        content: { "application/json": { schema: publicKeySchema } },
      },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const userCurrentDeleteKeyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/user/keys/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Delete a public key",
    operationId: "userCurrentDeleteKey",
    request: keyIdParam("id of key to delete"),
    responses: {
      204: { description: "empty" },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const userCurrentListGpgKeysRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/gpg_keys",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the authenticated user's GPG keys",
    operationId: "userCurrentListGPGKeys",
    request: listQuery,
    responses: {
      200: {
        description: "GPGKeyList",
        content: { "application/json": { schema: gpgKeyListSchema } },
      },
      401: unauthorizedResponse,
      403: forbiddenResponse,
    },
  });

const userCurrentGetGpgKeyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/gpg_keys/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Get a GPG key",
    operationId: "userCurrentGetGPGKey",
    request: keyIdParam("id of key to display"),
    responses: {
      200: {
        description: "GPGKey",
        content: { "application/json": { schema: gpgKeySchema } },
      },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const userCurrentDeleteGpgKeyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/user/gpg_keys/{id}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Remove a GPG key",
    operationId: "userCurrentDeleteGPGKey",
    request: keyIdParam("id of key to delete"),
    responses: {
      204: { description: "empty" },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

/** Every id is a miss (zero keys exist): the upstream not-exist arms answer
 *  404 "not found" with the {message, url} body. */
function keyIdMiss(): never {
  throw new ApiError(404, "not found");
}

export function registerMiscT3Routes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
): void {
  // GET /signing-key.gpg — always the signing.go:14-24 no-key 404: cf-gitea
  // has no signing-key configuration, so PublicSigningKey's format is blank
  // and upstream's own handler answers APIErrorNotFound("no signing key").
  app.openapi(signingKeyGpgRoute, () => {
    throw new ApiError(404, "no signing key");
  });

  // GET /signing-key.pub — the same helper's same arm (SigningKeySSH at
  // signing.go:100), hence the verbatim message.
  app.openapi(signingKeyPubRoute, () => {
    throw new ApiError(404, "no signing key");
  });

  // The key lists — upstream's listing over an empty key set: `[]` with the
  // total-0 header family. The `fingerprint` filter has nothing to filter.
  app.openapi(userCurrentListKeysRoute(requireAuth), (c) => {
    const listOptions = parseListOptions(new URL(c.req.url));
    setPaginationHeaders(c, 0, listOptions);
    return c.json([], 200);
  });

  app.openapi(userCurrentListGpgKeysRoute(requireAuth), (c) => {
    const listOptions = parseListOptions(new URL(c.req.url));
    setPaginationHeaders(c, 0, listOptions);
    return c.json([], 200);
  });

  // The id-addressed items — every lookup misses (no storage).
  app.openapi(userCurrentGetKeyRoute(requireAuth), () => keyIdMiss());
  app.openapi(userCurrentDeleteKeyRoute(requireAuth), () => keyIdMiss());
  app.openapi(userCurrentGetGpgKeyRoute(requireAuth), () => keyIdMiss());
  app.openapi(userCurrentDeleteGpgKeyRoute(requireAuth), () => keyIdMiss());
}
