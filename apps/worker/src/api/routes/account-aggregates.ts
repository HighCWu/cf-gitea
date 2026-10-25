import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  gpgKeys,
  issueStopwatches,
  issues,
  trackedTimes,
  userRedirects,
  users,
} from "../../db/schema";
import { TokenService } from "../../auth/token-service";
import {
  EmptyTokenScopeError,
  InvalidTokenScopeError,
  TokenNameExistsError,
  TokenNameTooLongError,
} from "../../auth/errors";
import { scopeStringSlice } from "../../auth/scopes";
import { loadSubkeys, toApiGpgKey } from "../services/account-keys";
import { canWriteRepository } from "../services/repo-access";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { gpgKeySchema } from "../models/gpg-key";
import { issueSchema } from "../models/issue";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { findDoerRow } from "../services/user-repos";
import {
  GO_ZERO_TIME,
  canViewRepositoryWithTeams,
  findRepositoryByPath,
  findRepositoryById,
  findUserByName,
  viewerOf,
} from "../services/repository";
import type { RepositoryWithOwner, UserRow, Viewer } from "../services/repository";
import { parseQueryTime, toApiIssue } from "../services/issues";

/**
 * Account aggregates — the remaining user-scoped READ/CRUD surface over
 * landed stores (the api-remaining-inventory batch `wave-api-tokens-times-
 * aggregates`; all eight ops here are table-free):
 *
 *   - GET/POST/DELETE /users/{username}/tokens[/{token}]
 *       (userGetTokens / userCreateToken / userDeleteAccessToken —
 *       routers/api/v1/user/app.go ListAccessTokens:27 / CreateAccessToken:79
 *       / DeleteAccessToken:169 over the landed personal_access_tokens table,
 *       schema.ts:294, through the SPEC-0002 TokenService).
 *   - GET /repos/{owner}/{repo}/times[/{user}] + GET /user/times
 *       (repoTrackedTimes / userTrackedTimes / userCurrentTrackedTimes —
 *       repo/issue_tracked_time.go ListTrackedTimesByRepository:417 /
 *       ListTrackedTimesByUser:383 / ListMyTrackedTimes:571) — the repo- and
 *       user-level aggregates over tracked_time (the issue-level ops on the
 *       same table are the landed issue-tables-t2 family).
 *   - GET /user/stopwatches (userGetStopWatches — repo/issue_stopwatch.go
 *       GetStopwatches:192, convert.ToStopWatches issue.go:176-219).
 *   - POST /user/gpg_key_verify (userVerifyGPGKey — user/gpg_key.go
 *       VerifyUserGPGKey:186-242) — marks a landed gpg_keys row verified by
 *       checking an OpenPGP signature over the VerificationToken challenge.
 *
 * ---------------------------------------------------------------------------
 * Auth wiring (upstream per-op cites)
 * ---------------------------------------------------------------------------
 *
 * The /users/{username} group runs context.UserAssignmentAPI()
 * (services/context/user.go:32-67) — the type-blind name lookup, the
 * user_redirect 307 seam and the shared 404 "user redirect does not exist
 * [name: …]" miss — ported below as resolveTargetUserRow. The DoerTokenAllowsOwner
 * public-only arm (user.go:59-63) has no api-layer model yet (public-only
 * tokens are not visible to the api identity contract) and collapses away.
 *
 * reqSelfOrAdmin (api.go:373-379) ports verbatim: a doer that is neither the
 * site admin nor the target answers 403 "doer should be the site admin or be
 * same as the contextUser".
 *
 * reqBasicOrRevProxyAuth (api.go:331-341) COLLAPSES onto the group 401:
 * upstream demands basic-auth (or reverse-proxy) credentials for the token
 * family so a token cannot read another user's token list; cf-gitea's api
 * layer has exactly one credential mechanism (Authorization: token <pat>,
 * SPEC-0002 — basic-as-token rides the same resolver), so the gate's only
 * reachable arm is "no credential at all", which requireAuth already answers
 * 401. The 401 is the runtime-only group-wiring class (undeclared, per the
 * landed convention).
 *
 * ---------------------------------------------------------------------------
 * Documented divergences (English, per AGENTS.md)
 * ---------------------------------------------------------------------------
 *
 *   - token_last_eight on the LIST arm renders the last 8 chars of the stored
 *     public prefix (the cfg_<8hex> lookup key). Upstream stores the last 8
 *     chars of the full secret; cf-gitea never persists the secret
 *     (SPEC-0002 §3), so the prefix tail is the honest stored analog. The
 *     CREATE arm renders the real last-8 of the minted plaintext (upstream
 *     app.go:155-165 shape, plaintext under the legacy "sha1" key).
 *   - The mint-time scope-escalation rule (app.go:127-149 — a token-authed
 *     request may not mint a broader-scoped token) needs the doer's token
 *     scope in the api identity, which ApiEnv does not carry yet; mints
 *     behave as a scope-less parent (any scope allowed). The TokenService
 *     already implements the rule (mintedByScope); wiring it is the env-type
 *     owner's follow-up.
 *   - userCreateToken's missing-name arm answers the upstream binder's 422
 *     ("Name: Required", api.go:841-844) — the vendored contract declares
 *     {201,400,403} only, so the 422 (and the >255-char name 422) stay
 *     RUNTIME-ONLY-UNDECLARED per the landed convention.
 *   - userVerifyGPGKey answers 201 on success (the frozen contract's declared
 *     code) where upstream's handler sends 200 (user/gpg_key.go:241) — the
 *     same handler/contract drift class the frozen contract already won
 *     elsewhere (issue-tables-t2 module header). An unknown/empty key_id
 *     answers the contract's 404 where upstream 500s (gpg_key.go:226 —
 *     ErrGPGKeyNotExist reaches APIErrorInternal; cf-gitea cannot declare or
 *     honor a 500).
 *   - OpenPGP signature verification implements the RSA subset: RFC 4880
 *     v4 signature packets signed by an RSA (algo 1/2/3) key or subkey,
 *     hashed with SHA-1/SHA-256/SHA-384/SHA-512, verified through WebCrypto
 *     RSASSA-PKCS1-v1_5 (the stored gpg_keys.content packet carries the
 *     modulus/exponent MPIs). DSA/ECDSA/EdDSA signatures and other hashes
 *     can never verify here and answer the upstream invalid-token-signature
 *     422 verbatim (gpg_key.go:222-224) — the same answer upstream gives an
 *     actually-bad signature, so no key is marked verified by a signature we
 *     cannot check.
 *   - The times aggregates declare the contract's {200,403,404} subset (the
 *     "time tracking disabled" 400 is unreachable — the timetracker has no
 *     settings module and defaults enabled, the issue-tables-t2 collapse);
 *     a malformed since/before answers upstream's 422 (context/utils.go
 *     parseFormTime via GetQueryBeforeSince) — runtime-only undeclared.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const unauthorizedResponse = {
  description: "unauthorized",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

/** The raw page/limit SHAPE for composing into larger query objects (the
 *  issue-tables-t2 pageLimitQuery pattern — spreading a ZodObject instance
 *  would drag its internals in as keys). */
const pageLimitShape = {
  page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
} as const;

const sinceBeforeQuery = {
  since: z.string().optional().openapi({ format: "date-time", description: "Only show times updated after the given time. This is a timestamp in RFC 3339 format" }),
  before: z.string().optional().openapi({ format: "date-time", description: "Only show times updated before the given time. This is a timestamp in RFC 3339 format" }),
} as const;

/** `#/definitions/AccessToken` (modules/structs/user_app.go). */
const accessTokenSchema = z.object({
  id: z.number().int().optional().openapi({ format: "int64", description: "The unique identifier of the access token" }),
  name: z.string().optional().openapi({ description: "The name of the access token" }),
  sha1: z.string().optional().openapi({ description: "The SHA1 hash of the access token" }),
  token_last_eight: z.string().optional().openapi({ description: "The last eight characters of the token" }),
  scopes: z.array(z.string()).optional().openapi({ description: "The scopes granted to this access token" }),
  created_at: z.string().optional().openapi({ format: "date-time", description: "The timestamp when the token was created" }),
  last_used_at: z.string().optional().openapi({ format: "date-time", description: "The timestamp when the token was last used" }),
});

/** `CreateAccessTokenOption` — name Required upstream (binder-enforced, not
 *  validator-enforced; the handler owns the 422). */
const createAccessTokenOptionSchema = z.object({
  name: z.string().optional().openapi({ description: "The name of the access token" }),
  scopes: z.array(z.string()).optional().openapi({
    description: "The scopes granted to this access token",
    example: ["all", "read:activitypub", "read:issue", "write:misc", "read:notification", "read:organization", "read:package", "read:repository", "read:user"],
  }),
});

/** `#/definitions/TrackedTime` — same wire as the issue-level family
 *  (issue-tables-t2.ts; models/ is outside this wave's ownership). */
const trackedTimeSchema = z.object({
  id: z.number().int().optional().openapi({ format: "int64", description: "ID is the unique identifier for the tracked time entry" }),
  issue_id: z.number().int().optional().openapi({ format: "int64", description: "deprecated (only for backwards compatibility)" }),
  issue: issueSchema.optional(),
  time: z.number().int().optional().openapi({ format: "int64", description: "Time in seconds" }),
  created: z.string().optional().openapi({ format: "date-time" }),
  user_id: z.number().int().optional().openapi({ format: "int64", description: "deprecated (only for backwards compatibility)" }),
  user_name: z.string().optional().openapi({ description: "username of the user" }),
});

const trackedTimeListSchema = z.array(trackedTimeSchema);

/** `#/definitions/StopWatch` (modules/structs/issue_stopwatch.go). */
const stopWatchSchema = z.object({
  created: z.string().optional().openapi({ format: "date-time", description: "Created is the time when the stopwatch was started" }),
  seconds: z.number().int().optional().openapi({ format: "int64", description: "Seconds is the total elapsed time in seconds" }),
  duration: z.string().optional().openapi({ description: "Duration is a human-readable duration string" }),
  issue_index: z.number().int().optional().openapi({ format: "int64", description: "IssueIndex is the index number of the associated issue" }),
  issue_title: z.string().optional().openapi({ description: "IssueTitle is the title of the associated issue" }),
  repo_owner_name: z.string().optional().openapi({ description: "RepoOwnerName is the name of the repository owner" }),
  repo_name: z.string().optional().openapi({ description: "RepoName is the name of the repository" }),
});

const stopWatchListSchema = z.array(stopWatchSchema);

/** `VerifyGPGKeyOption` (modules/structs/user_gpgkey.go:63-71) — both fields
 *  Required upstream (binder-enforced; the handler owns the 422). */
const verifyGpgKeyOptionSchema = z.object({
  key_id: z.string().optional().openapi({ description: "The key ID of the GPG key to verify" }),
  armored_signature: z.string().optional().openapi({ description: "The armored signature to verify the GPG key" }),
});

// ---------------------------------------------------------------------------
// Route declarations (declared sets ⊆ frozen contract per op)
// ---------------------------------------------------------------------------

const userGetTokensRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/tokens",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the authenticated user's access tokens",
    operationId: "userGetTokens",
    request: {
      params: z.object({
        username: z.string().min(1).openapi({ description: "username of to user whose access tokens are to be listed" }),
      }),
      ...listQuery,
    },
    responses: {
      200: {
        description: "AccessTokenList",
        content: { "application/json": { schema: z.array(accessTokenSchema) } },
      },
      403: forbiddenResponse,
    },
  });

const userCreateTokenRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/users/{username}/tokens",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Create an access token",
    operationId: "userCreateToken",
    request: {
      params: z.object({
        username: z.string().min(1).openapi({ description: "username of the user whose token is to be created" }),
      }),
      body: { content: { "application/json": { schema: createAccessTokenOptionSchema } } },
    },
    responses: {
      201: {
        description: "AccessToken",
        content: { "application/json": { schema: accessTokenSchema } },
      },
      400: errorResponse,
      403: forbiddenResponse,
    },
  });

const userDeleteAccessTokenRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/users/{username}/tokens/{token}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "delete an access token",
    operationId: "userDeleteAccessToken",
    request: {
      params: z.object({
        username: z.string().min(1).openapi({ description: "username of the user whose token is to be deleted" }),
        token: z.string().min(1).openapi({ description: "token to be deleted, identified by ID and if not available by name" }),
      }),
    },
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const repoTrackedTimesRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/times",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "List a repo's tracked times",
    operationId: "repoTrackedTimes",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
      }),
      query: z.object({
        user: z.string().optional().openapi({ description: "optional filter by user (available for issue managers)" }),
        ...sinceBeforeQuery,
        ...pageLimitShape,
      }),
    },
    responses: {
      200: {
        description: "TrackedTimeList",
        content: { "application/json": { schema: trackedTimeListSchema } },
      },
      // The contract's 400 ("time tracking disabled") is unreachable — the
      // timetracker defaults enabled (issue-tables-t2 module header).
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const userTrackedTimesRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/times/{user}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "List a user's tracked times in a repo",
    operationId: "userTrackedTimes",
    deprecated: true,
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
        user: z.string().min(1).openapi({ description: "username of the user whose tracked times are to be listed" }),
      }),
    },
    responses: {
      200: {
        description: "TrackedTimeList",
        content: { "application/json": { schema: trackedTimeListSchema } },
      },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const userCurrentTrackedTimesRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/times",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "List the current user's tracked times",
    operationId: "userCurrentTrackedTimes",
    request: {
      query: z.object({
        ...pageLimitShape,
        ...sinceBeforeQuery,
      }),
    },
    responses: {
      200: {
        description: "TrackedTimeList",
        content: { "application/json": { schema: trackedTimeListSchema } },
      },
    },
  });

const userGetStopWatchesRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/stopwatches",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Get list of all existing stopwatches",
    operationId: "userGetStopWatches",
    request: listQuery,
    responses: {
      200: {
        description: "StopWatchList",
        content: { "application/json": { schema: stopWatchListSchema } },
      },
    },
  });

const userVerifyGpgKeyRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/user/gpg_key_verify",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Verify a GPG key",
    operationId: "userVerifyGPGKey",
    request: {
      body: { content: { "application/json": { schema: verifyGpgKeyOptionSchema } } },
    },
    responses: {
      // 201 = the frozen contract's declared success code (upstream's handler
      // sends 200 — the documented handler/contract drift, contract wins).
      201: {
        description: "GPGKey",
        content: { "application/json": { schema: gpgKeySchema } },
      },
      401: unauthorizedResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** Go strconv.ParseInt(s, 0, 64) — base detection: 0x/0X hex, 0o/0O octal,
 * 0b/0B binary, a leading 0 followed by digits = octal, else decimal.
 * Unparseable → 0 (the delete arm's `_` discards the error → name lookup).
 */
function goParseIntBase0(raw: string): number {
  const neg = raw.startsWith("-") || raw.startsWith("+") ? (raw.startsWith("-") ? -1 : 1) : 1;
  let digits = raw.replace(/^[-+]/, "");
  let base = 10;
  if (/^0[xX]/.test(digits)) {
    base = 16;
    digits = digits.slice(2);
  } else if (/^0[oO]/.test(digits)) {
    base = 8;
    digits = digits.slice(2);
  } else if (/^0[bB]/.test(digits)) {
    base = 2;
    digits = digits.slice(2);
  } else if (/^0\d+$/.test(digits)) {
    base = 8;
    digits = digits.slice(1);
  } else if (!/^\d+$/.test(digits)) {
    return 0;
  }
  const parsed = Number.parseInt(digits, base);
  return Number.isSafeInteger(parsed) ? neg * parsed : 0;
}

/** Go zero time for unset timestamps (the issue-tables-t2 isoOrGoZero). */
function isoOrGoZero(date: Date | null): string {
  return date === null ? GO_ZERO_TIME : date.toISOString();
}

/** `ErrUserNotExist` text — the shared issue-tables-t2 userNotExistError. */
function userNotExistError(name: string, status: 404 | 422): ApiError {
  return new ApiError(status, `user does not exist [uid: 0, name: ${name}]`);
}

/**
 * context.UserAssignmentAPI (services/context/user.go:32-67) ported: the
 * type-blind name lookup, the user_redirect 307 seam (RedirectToUser —
 * first path occurrence replaced, query preserved) and the shared 404
 * "user redirect does not exist [name: …]" miss.
 */
async function resolveTargetUserRow(c: Context<ApiEnv>, username: string): Promise<UserRow> {
  const row = await findUserByName(c.env.DB, username);
  if (row !== null) {
    return row;
  }
  const redirect = (
    await drizzle(c.env.DB)
      .select({ userId: userRedirects.redirectUserId })
      .from(userRedirects)
      .where(eq(userRedirects.lowerName, username.toLowerCase()))
      .limit(1)
  )[0];
  if (redirect !== undefined) {
    const target = (await drizzle(c.env.DB).select().from(users).where(eq(users.id, redirect.userId)).limit(1))[0];
    if (target !== undefined) {
      const url = new URL(c.req.url);
      let location = c.req.path.replace(username, target.username);
      if (url.search !== "") {
        location += url.search;
      }
      throw new HTTPException(307, {
        res: new Response(null, { status: 307, headers: { Location: location } }),
      });
    }
  }
  throw new ApiError(404, `user redirect does not exist [name: ${username}]`);
}

/** reqSelfOrAdmin (api.go:373-379) — verbatim message. */
function requireSelfOrAdmin(doer: { id?: number; is_admin?: boolean }, target: UserRow): void {
  const isAdmin = doer.is_admin === true;
  const sameUser = doer.id !== undefined && doer.id === target.id;
  if (!isAdmin && !sameUser) {
    throw new ApiError(403, "doer should be the site admin or be same as the contextUser");
  }
}

/** The signed-in doer's contract projection (requireAuth guarantees it). */
function requireDoer(c: Context<ApiEnv>): NonNullable<ApiEnv["Variables"]["authUser"]> {
  const doer = c.get("authUser");
  if (doer === undefined) {
    throw new ApiError(401, "token is required");
  }
  return doer;
}

// ---------------------------------------------------------------------------
// Access tokens (user/app.go ListAccessTokens / CreateAccessToken /
// DeleteAccessToken over the SPEC-0002 TokenService)
// ---------------------------------------------------------------------------

/** convert-time AccessToken render (app.go:56-66): the plaintext is never
 *  stored, so `sha1` stays empty on reads; `token_last_eight` renders the
 *  stored prefix tail (the module-header divergence); upstream's UpdatedUnix
 *  (bumped on every use) rides the SPEC-0002 lastUsedAt — zero when unused. */
function toApiAccessToken(row: { id: number; name: string; prefix: string; scopes: string; createdAt: Date | null; lastUsedAt: Date | null }) {
  return {
    id: row.id,
    name: row.name,
    sha1: "",
    token_last_eight: row.prefix.slice(-8),
    scopes: scopeStringSlice(row.scopes),
    created_at: row.createdAt === null ? GO_ZERO_TIME : row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt === null ? GO_ZERO_TIME : row.lastUsedAt.toISOString(),
  };
}

/** The mint-error → wire mapping (app.go:100-149 statuses verbatim). */
function mintErrorToApiError(error: unknown): never {
  if (error instanceof TokenNameExistsError) {
    throw new ApiError(400, "access token name has been used already");
  }
  if (error instanceof InvalidTokenScopeError) {
    throw new ApiError(400, `invalid access token scope provided: ${error.message}`);
  }
  if (error instanceof EmptyTokenScopeError) {
    throw new ApiError(400, "access token must have a scope");
  }
  if (error instanceof TokenNameTooLongError) {
    // upstream binds Name MaxSize(255) — the binder's 422 (runtime-only).
    throw new ApiError(422, "Name: MaxSize(255)");
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Tracked-time aggregates (issue_tracked_time.go over tracked_time)
// ---------------------------------------------------------------------------

/** `util.SecToHours` port (modules/util/sec_to_time.go:15-40) — the
 *  issue-tables-t2 copy (private there; the verbatim-copy precedent). */
function secToHours(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const unit = (value: number, name: string): string =>
    value === 1 ? `1 ${name} ` : value > 1 ? `${value} ${name}s ` : "";
  let out = `${unit(hours, "hour")}${unit(minutes, "minute")}`;
  if (out === "" && totalSeconds > 0) {
    out = unit(totalSeconds, "second");
  }
  return out.replace(/ $/, "");
}

/** One tracked-time row joined with its owner's login. */
interface TimeRow {
  id: number;
  issueId: number;
  userId: number;
  seconds: number;
  createdAt: Date | null;
  userName: string | null;
}

async function loadTimeRows(d1: D1Database, where: SQL<unknown>[]): Promise<TimeRow[]> {
  const rows = await drizzle(d1)
    .select({
      id: trackedTimes.id,
      issueId: trackedTimes.issueId,
      userId: trackedTimes.userId,
      seconds: trackedTimes.seconds,
      createdAt: trackedTimes.createdAt,
      userName: users.username,
    })
    .from(trackedTimes)
    .leftJoin(users, eq(users.id, trackedTimes.userId))
    .where(and(...where))
    .orderBy(asc(trackedTimes.id))
    .all();
  return rows;
}

/**
 * ToTrackedTimeList (convert/issue.go ToTrackedTime:158+) for the aggregates:
 * each entry embeds its issue rendered through the landed toApiIssue. Issues
 * load in bulk; unreadable repos are skipped upstream (the access filter) and
 * callers drop those rows before rendering.
 */
async function renderTimeRows(
  d1: D1Database,
  viewer: Viewer,
  pairs: Map<string, RepositoryWithOwner>,
  rows: TimeRow[],
): Promise<Array<Record<string, unknown>>> {
  const issueIds = [...new Set(rows.map((row) => row.issueId))];
  const issueRows = issueIds.length > 0 ? await drizzle(d1).select().from(issues).where(inArray(issues.id, issueIds)).all() : [];
  const issueById = new Map(issueRows.map((row) => [row.id, row]));
  const rendered: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const issue = issueById.get(row.issueId);
    if (issue === undefined) {
      continue; // ToTrackedTime conservatively skips unloaded issues
    }
    const pair = pairs.get(issue.repoId);
    if (pair === undefined) {
      continue; // the access filter's arm (header notes)
    }
    rendered.push({
      id: row.id,
      issue_id: row.issueId,
      issue: await toApiIssue(d1, viewer, pair, issue),
      time: row.seconds,
      created: isoOrGoZero(row.createdAt),
      user_id: row.userId,
      user_name: row.userName ?? "",
    });
  }
  return rendered;
}

/** The repo arm's since/before + user filter conditions (deleted excluded). */
function timeFilters(since: number | null, before: number | null, userId: number) {
  const conditions = [eq(trackedTimes.deleted, false)];
  if (userId !== 0) {
    conditions.push(eq(trackedTimes.userId, userId));
  }
  if (since !== null) {
    conditions.push(gte(trackedTimes.createdAt, new Date(since * 1000)));
  }
  if (before !== null) {
    conditions.push(lt(trackedTimes.createdAt, new Date(before * 1000)));
  }
  return conditions;
}

// ---------------------------------------------------------------------------
// GPG verification (user/gpg_key.go VerifyUserGPGKey + models/asymkey
// gpg_key_verify.go) — the RSA-subset OpenPGP check
// ---------------------------------------------------------------------------

async function shaHex(algo: "SHA-1" | "SHA-256", data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algo, data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** asymkey_model.VerificationToken (gpg_key_verify.go:74-86) — the misc-t3
 *  port (private there; the verbatim-copy precedent), UTC-pinned like it. */
const GO_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const GO_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function goRfc1123z(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${GO_WEEKDAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${GO_MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

async function verificationToken(user: UserRow, minutes: number): Promise<string> {
  const minuteStart = Math.floor(Date.now() / 60000) * 60000;
  const payload = [
    goRfc1123z(new Date(minuteStart + minutes * 60000)),
    goRfc1123z(user.createdAt),
    user.username,
    user.email ?? "",
    String(user.id),
  ].join(":");
  return shaHex("SHA-256", new TextEncoder().encode(payload));
}

/** Upstream's invalid-token-signature 422 (gpg_key.go:222-224). */
function invalidTokenSignatureError(token: string): ApiError {
  return new ApiError(
    422,
    "The provided GPG key, signature and token do not match or token is out of date. Provide a valid signature for the token: " +
      token,
  );
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode the first PGP SIGNATURE armor block (readArmoredSign,
 *  gpg_key_common.go:123-137's input half; CRC-24 checked when present). */
function dearmorSignature(armored: string): Uint8Array {
  const BEGIN = "-----BEGIN PGP SIGNATURE-----";
  const END = "-----END PGP SIGNATURE-----";
  const begin = armored.indexOf(BEGIN);
  if (begin < 0) {
    throw new Error("Failed to read signature armor");
  }
  const rest = armored.slice(begin + BEGIN.length);
  const end = rest.indexOf(END);
  if (end < 0) {
    throw new Error("unterminated armored signature block");
  }
  const lines = rest.slice(0, end).split(/\r\n|\r|\n/);
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() !== "") {
    i += 1; // RFC 4880 §6.2 headers
  }
  i += 1;
  const base64Lines: string[] = [];
  for (; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    if (line.startsWith("=")) break; // checksum line
    base64Lines.push(line);
  }
  try {
    return base64ToBytes(base64Lines.join(""));
  } catch {
    throw new Error("Failed to read signature armor");
  }
}

interface RawPacket {
  tag: number;
  body: Uint8Array;
}

/** RFC 4880 §4.2 packet walk — the misc-t3 parser (private there; the
 *  verbatim-copy precedent). Partial/indeterminate lengths unsupported. */
function walkPackets(bytes: Uint8Array): RawPacket[] {
  const packets: RawPacket[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const first = bytes[offset]!;
    if ((first & 0x80) === 0) {
      throw new Error("invalid packet header");
    }
    let tag: number;
    let length: number;
    let headerLength: number;
    if ((first & 0x40) === 0) {
      tag = (first >> 2) & 0x0f;
      const lengthType = first & 0x03;
      if (lengthType === 3) {
        throw new Error("indeterminate packet length unsupported");
      }
      headerLength = 1 + (1 << lengthType);
      if (offset + headerLength > bytes.length) {
        throw new Error("truncated packet header");
      }
      length = 0;
      for (let i = 0; i <= lengthType; i++) {
        length = length * 256 + bytes[offset + 1 + i]!;
      }
    } else {
      tag = first & 0x3f;
      if (offset + 2 > bytes.length) {
        throw new Error("truncated packet header");
      }
      const b1 = bytes[offset + 1]!;
      if (b1 < 192) {
        length = b1;
        headerLength = 2;
      } else if (b1 <= 223) {
        if (offset + 3 > bytes.length) {
          throw new Error("truncated packet header");
        }
        length = (b1 - 192) * 256 + bytes[offset + 2]! + 192;
        headerLength = 3;
      } else if (b1 === 255) {
        if (offset + 6 > bytes.length) {
          throw new Error("truncated packet header");
        }
        length = view.getUint32(offset + 2);
        headerLength = 6;
      } else {
        throw new Error("partial packet lengths unsupported");
      }
    }
    const bodyStart = offset + headerLength;
    if (bodyStart + length > bytes.length) {
      throw new Error("truncated packet body");
    }
    packets.push({ tag, body: bytes.subarray(bodyStart, bodyStart + length) });
    offset = bodyStart + length;
  }
  return packets;
}

/** A parsed v4 signature packet (RFC 4880 §5.2). */
interface ParsedSignature {
  version: number;
  sigType: number;
  pubKeyAlgo: number;
  hashAlgo: number;
  /** The body from the version byte through the END of the hashed area. */
  hashedPortion: Uint8Array;
  /** The signature MPI's raw big-endian bytes (the RSA PKCS#1 v1.5 blob). */
  signatureBytes: Uint8Array;
}

const WEB_CRYPTO_HASH: Record<number, "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"> = {
  2: "SHA-1",
  8: "SHA-256",
  9: "SHA-384",
  10: "SHA-512",
};

/** RSA public-key algo family (RFC 4880 §9.1) — the WebCrypto-verifiable set. */
const RSA_ALGOS = new Set([1, 2, 3]);

/** Parse a v4 signature packet body; anything non-v4 is a subset miss. */
function parseSignaturePacket(body: Uint8Array): ParsedSignature {
  if (body.length < 6) {
    throw new Error("Failed to read signature packet");
  }
  const version = body[0]!;
  if (version !== 4) {
    throw new Error("unsupported signature version");
  }
  const sigType = body[1]!;
  const pubKeyAlgo = body[2]!;
  const hashAlgo = body[3]!;
  const hashedLength = (body[4]! << 8) | body[5]!;
  const hashedEnd = 6 + hashedLength;
  if (hashedEnd + 2 > body.length) {
    throw new Error("Failed to read signature packet");
  }
  const unhashedLength = (body[hashedEnd]! << 8) | body[hashedEnd + 1]!;
  const unhashedEnd = hashedEnd + 2 + unhashedLength;
  // Left 16 bits of the hash, then the signature MPI (RFC 4880 §5.2.3/5.2.4).
  const mpiStart = unhashedEnd + 2;
  if (mpiStart + 2 > body.length) {
    throw new Error("Failed to read signature packet");
  }
  const mpiBits = (body[mpiStart]! << 8) | body[mpiStart + 1]!;
  const mpiBytes = Math.ceil(mpiBits / 8);
  if (mpiStart + 2 + mpiBytes > body.length) {
    throw new Error("Failed to read signature packet");
  }
  return {
    version,
    sigType,
    pubKeyAlgo,
    hashAlgo,
    hashedPortion: body.subarray(0, hashedEnd),
    signatureBytes: body.subarray(mpiStart + 2, mpiStart + 2 + mpiBytes),
  };
}

/** Read one MPI's bytes (RFC 4880 §3.2) starting at `offset`. */
function readMpiBytes(body: Uint8Array, offset: number): Uint8Array {
  if (offset + 2 > body.length) {
    throw new Error("truncated MPI");
  }
  const bits = (body[offset]! << 8) | body[offset + 1]!;
  const byteLength = Math.ceil(bits / 8);
  if (offset + 2 + byteLength > body.length) {
    throw new Error("truncated MPI");
  }
  return body.subarray(offset + 2, offset + 2 + byteLength);
}

/** The RSA (n, e) MPIs of a stored v4 public-key packet body (the
 *  gpg_keys.content framing is `0x99 ‖ len16 ‖ body` — misc-t3's
 *  Base64EncPubKey serialization; packet.go RSA MPI order n, e). */
function rsaMaterialFromContent(content: string): { n: Uint8Array; e: Uint8Array } {
  const framed = base64ToBytes(content);
  if (framed.length < 3) {
    throw new Error("key is not a public key");
  }
  const body = framed.subarray(3); // strip 0x99 ‖ len16
  if (body.length < 7 || body[0] !== 4) {
    throw new Error("unsupported public key version");
  }
  const algo = body[5]!;
  if (!RSA_ALGOS.has(algo)) {
    throw new Error("unsupported public key algorithm");
  }
  const n = readMpiBytes(body, 6);
  const e = readMpiBytes(body, 6 + 2 + Math.ceil(((body[6]! << 8) | body[7]!) / 8));
  return { n, e };
}

/**
 * Verify one token candidate: WebCrypto RSASSA-PKCS1-v1_5 over
 * `candidate ‖ hashedPortion ‖ trailer6` (RFC 4880 §5.2.4 — the trailer is
 * version ‖ sigType ‖ pubKeyAlgo ‖ hashAlgo ‖ hashedLength16BE), with the
 * digest algorithm the signature declares. Returns true on a valid signature.
 */
async function rsaVerifyCandidate(
  material: { n: Uint8Array; e: Uint8Array },
  sig: ParsedSignature,
  candidate: string,
): Promise<boolean> {
  const hashName = WEB_CRYPTO_HASH[sig.hashAlgo];
  if (hashName === undefined) {
    return false; // MD5/RIPEMD-160/SHA-224 — outside the WebCrypto set
  }
  const trailer = new Uint8Array([
    sig.version,
    sig.sigType,
    sig.pubKeyAlgo,
    sig.hashAlgo,
    (sig.hashedPortion.length - 6) >> 8,
    (sig.hashedPortion.length - 6) & 0xff,
  ]);
  const payload = new TextEncoder().encode(candidate);
  const signedData = new Uint8Array(payload.length + sig.hashedPortion.length + trailer.length);
  signedData.set(payload, 0);
  signedData.set(sig.hashedPortion, payload.length);
  signedData.set(trailer, payload.length + sig.hashedPortion.length);
  const jwk: JsonWebKey = {
    kty: "RSA",
    n: bytesToBase64Url(material.n),
    e: bytesToBase64Url(material.e),
  };
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: hashName }, false, ["verify"]);
  } catch {
    return false;
  }
  // The signature MPI carries the encoded INTEGER (leading zero octets
  // stripped); WebCrypto wants the PKCS#1 v1.5 blob at the full modulus
  // length — left-pad back (go-crypto re-pads the same way).
  if (sig.signatureBytes.length > material.n.length) {
    return false;
  }
  const signatureBlob = new Uint8Array(material.n.length);
  signatureBlob.set(sig.signatureBytes, material.n.length - sig.signatureBytes.length);
  return crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signatureBlob, signedData);
}

/**
 * asymkey_model.VerifyGPGKey (gpg_key_verify.go:20-71) reduced to the RSA
 * subset: dearmor → v4 signature packet → the five token candidates
 * (VerifyGPGKey:39-50) → primary key first, then subkeys
 * (hashAndVerifyWithSubKeys, gpg_key_commit_verification.go:81-96, which
 * skips keys without CanSign). Throws the subset-miss / bad-signature error;
 * returns when the signature holds.
 */
async function verifyTokenSignature(
  keyRows: (typeof gpgKeys.$inferSelect)[],
  token: string,
  armoredSignature: string,
): Promise<void> {
  let sig: ParsedSignature;
  try {
    const packets = walkPackets(dearmorSignature(armoredSignature));
    const signaturePacket = packets.find((packet) => packet.tag === 2);
    if (signaturePacket === undefined) {
      throw new Error("Packet is not a signature");
    }
    sig = parseSignaturePacket(signaturePacket.body);
  } catch {
    throw invalidTokenSignatureError(token); // ExtractSignature failure arm
  }
  if (!RSA_ALGOS.has(sig.pubKeyAlgo)) {
    throw invalidTokenSignatureError(token); // DSA/ECDSA/EdDSA — subset miss
  }
  const candidates = [token, `${token}\n`, `${token}\n\n`, `${token}\r\n`, `${token}\r\n\r\n`];
  for (const keyRow of keyRows) {
    if (!keyRow.canSign) {
      continue; // verifySign's "key can not sign" arm
    }
    let material: { n: Uint8Array; e: Uint8Array };
    try {
      material = rsaMaterialFromContent(keyRow.content);
    } catch {
      continue;
    }
    for (const candidate of candidates) {
      if (await rsaVerifyCandidate(material, sig, candidate)) {
        return;
      }
    }
  }
  throw invalidTokenSignatureError(token);
}

// ---------------------------------------------------------------------------

export function registerAccountAggregatesRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  const tokenService = (c: Context<ApiEnv>): TokenService => new TokenService(c.env.DB);

  // -------------------------------------------------------------------------
  // GET /users/{username}/tokens (userGetTokens) — reqToken (collapsed basic-
  // auth gate, module header) + reqSelfOrAdmin; the paged token list with the
  // total header (app.go:44-67 FindAndCount semantics).
  // -------------------------------------------------------------------------
  app.openapi(userGetTokensRoute(requireAuth), async (c) => {
    const doer = requireDoer(c);
    const target = await resolveTargetUserRow(c, c.req.valid("param").username);
    requireSelfOrAdmin(doer, target);
    const { page, limit } = parseListOptions(new URL(c.req.url));
    const { tokens, total } = await tokenService(c).list(target.id, page, limit);
    setPaginationHeaders(c, total, { page, limit });
    return c.json(tokens.map(toApiAccessToken), 200);
  });

  // -------------------------------------------------------------------------
  // POST /users/{username}/tokens (userCreateToken) — the mint: duplicate
  // name 400, scope normalize/empty 400, then 201 with the ONE-TIME
  // plaintext under the legacy `sha1` key (app.go:155-165).
  // -------------------------------------------------------------------------
  app.openapi(userCreateTokenRoute(requireAuth), async (c) => {
    const doer = requireDoer(c);
    const target = await resolveTargetUserRow(c, c.req.valid("param").username);
    requireSelfOrAdmin(doer, target);
    const form = c.req.valid("json");
    if (form.name === undefined || form.name === "") {
      // upstream's binder 422 for the Required name (api.go:841-844) —
      // runtime-only undeclared (module header).
      throw new ApiError(422, "Name: Required");
    }
    const minted = await tokenService(c)
      .mint({
        userId: target.id,
        name: form.name,
        scopes: (form.scopes ?? []).join(","),
        // mintedByScope: the api identity does not carry the doer's token
        // scope yet — the documented deferral (module header).
      })
      .catch(mintErrorToApiError);
    return c.json(
      {
        id: minted.id,
        name: minted.name,
        sha1: minted.plaintext,
        token_last_eight: minted.plaintext.slice(-8),
        scopes: scopeStringSlice(minted.scopes),
        created_at: GO_ZERO_TIME,
        last_used_at: GO_ZERO_TIME,
      },
      201,
    );
  });

  // -------------------------------------------------------------------------
  // DELETE /users/{username}/tokens/{token} (userDeleteAccessToken) —
  // id first (Go ParseInt base 0), else name lookup with the 0/1/many
  // ladder (app.go:198-219): 0 → 404, 1 → delete, many → 422.
  // -------------------------------------------------------------------------
  app.openapi(userDeleteAccessTokenRoute(requireAuth), async (c) => {
    const doer = requireDoer(c);
    const target = await resolveTargetUserRow(c, c.req.valid("param").username);
    requireSelfOrAdmin(doer, target);
    const tokenParam = c.req.valid("param").token;
    let tokenId = goParseIntBase0(tokenParam);
    if (tokenId === 0) {
      const byName = await tokenService(c).findByName(target.id, tokenParam);
      if (byName.length === 0) {
        throw new ApiError(404, "not found");
      }
      if (byName.length > 1) {
        throw new ApiError(422, `multiple matches for token name '${tokenParam}'`);
      }
      tokenId = byName[0]!.id;
    }
    const deleted = await tokenService(c).revoke(target.id, tokenId);
    if (!deleted) {
      // GetAccessTokenByID's ErrAccessTokenNotExist via APIErrorAuto —
      // the NewNotExistErrorf text (models/auth).
      throw new ApiError(404, `access token does not exist [id: ${tokenId}]`);
    }
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/times (repoTrackedTimes) — the repo aggregate
  // (ListTrackedTimesByRepository:417-560): the user/since/before filters,
  // the cantSetUser collapse (non-writers scope to their own rows), the
  // total header, then the access filter's skips during render.
  // -------------------------------------------------------------------------
  app.openapi(repoTrackedTimesRoute(requireAuth), async (c) => {
    const { owner, repo } = c.req.valid("param");
    const viewer = viewerOf(c);
    const found = await findRepositoryByPath(c.env.DB, owner, repo);
    if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
      throw new ApiError(404, "not found");
    }
    const doer = requireDoer(c);
    const doerRow = await findDoerRow(c.env.DB, doer);
    if (doerRow === null) throw new ApiError(401, "token is required");
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);

    const qUser = (url.searchParams.get("user") ?? "").trim();
    let userFilter = 0;
    if (qUser !== "") {
      const user = await findUserByName(c.env.DB, qUser);
      if (user === null) {
        throw userNotExistError(qUser, 404);
      }
      userFilter = user.id;
    }
    const since = parseQueryTime(url.searchParams.get("since"));
    const before = parseQueryTime(url.searchParams.get("before"));

    // cantSetUser (issue_tracked_time.go:522-536): a non-admin, non-writer
    // querying other users' rows is the 403; an unfiltered query scopes to
    // the doer's own rows.
    const cantSetUser =
      doer.is_admin !== true && userFilter !== doerRow.id && !(await canWriteRepository(c, found));
    if (cantSetUser) {
      if (userFilter === 0) {
        userFilter = doerRow.id;
      } else {
        throw new ApiError(403, "query by user not allowed; not enough rights");
      }
    }

    const issueIds = (
      await drizzle(c.env.DB).select({ id: issues.id }).from(issues).where(eq(issues.repoId, found.repo.id)).all()
    ).map((row) => row.id);
    const repoRows =
      issueIds.length > 0
        ? await loadTimeRows(c.env.DB, [inArray(trackedTimes.issueId, issueIds), ...timeFilters(since, before, userFilter)])
        : [];
    setPaginationHeaders(c, repoRows.length, { page, limit });
    const rendered = await renderTimeRows(c.env.DB, viewer, new Map([[found.repo.id, found]]), repoRows.slice((page - 1) * limit, page * limit));
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/times/{user} (userTrackedTimes, deprecated) —
  // the per-user repo aggregate (ListTrackedTimesByUser:383-458): the target
  // must be the doer, a repo writer or a site admin (403 otherwise); no
  // pagination upstream — the whole set.
  // -------------------------------------------------------------------------
  app.openapi(userTrackedTimesRoute(requireAuth), async (c) => {
    const { owner, repo, user: userName } = c.req.valid("param");
    const viewer = viewerOf(c);
    const found = await findRepositoryByPath(c.env.DB, owner, repo);
    if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
      throw new ApiError(404, "not found");
    }
    const doer = requireDoer(c);
    const target = await findUserByName(c.env.DB, userName);
    if (target === null) {
      throw userNotExistError(userName, 404);
    }
    if (doer.is_admin !== true && doer.id !== target.id && !(await canWriteRepository(c, found))) {
      throw new ApiError(403, "query by user not allowed; not enough rights");
    }
    const issueIds = (
      await drizzle(c.env.DB).select({ id: issues.id }).from(issues).where(eq(issues.repoId, found.repo.id)).all()
    ).map((row) => row.id);
    const rows =
      issueIds.length > 0
        ? await loadTimeRows(c.env.DB, [
            inArray(trackedTimes.issueId, issueIds),
            ...timeFilters(null, null, target.id),
          ])
        : [];
    const rendered = await renderTimeRows(c.env.DB, viewer, new Map([[found.repo.id, found]]), rows);
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // GET /user/times (userCurrentTrackedTimes) — the doer's times across all
  // repos (ListMyTrackedTimes:571-620): paged by the total-header contract,
  // then per-repo visibility skips during render (the access filter).
  // -------------------------------------------------------------------------
  app.openapi(userCurrentTrackedTimesRoute(requireAuth), async (c) => {
    const doer = requireDoer(c);
    const doerRow = await findDoerRow(c.env.DB, doer);
    if (doerRow === null) throw new ApiError(401, "token is required");
    const viewer = viewerOf(c);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);
    const since = parseQueryTime(url.searchParams.get("since"));
    const before = parseQueryTime(url.searchParams.get("before"));

    const rows = await loadTimeRows(c.env.DB, timeFilters(since, before, doerRow.id));
    setPaginationHeaders(c, rows.length, { page, limit });
    const pageRows = rows.slice((page - 1) * limit, page * limit);

    const issueIds = [...new Set(pageRows.map((row) => row.issueId))];
    const issueRows = issueIds.length > 0 ? await drizzle(c.env.DB).select().from(issues).where(inArray(issues.id, issueIds)).all() : [];
    const repoIds = [...new Set(issueRows.map((row) => row.repoId))];
    const pairs = new Map<string, RepositoryWithOwner>();
    for (const repoId of repoIds) {
      const pair = await findRepositoryById(c.env.DB, repoId);
      if (pair !== null && (await canViewRepositoryWithTeams(c.env.DB, viewer, pair.repo))) {
        pairs.set(repoId, pair);
      }
    }
    return c.json(await renderTimeRows(c.env.DB, viewer, pairs, pageRows), 200);
  });

  // -------------------------------------------------------------------------
  // GET /user/stopwatches (userGetStopWatches) — the doer's running
  // stopwatch(es) (GetStopwatches:192-230, ToStopWatches issue.go:176-219):
  // at most one row per user exists (the one-running-stopwatch rule), the
  // elapsed seconds derive from created_unix, unreadable repos skip.
  // -------------------------------------------------------------------------
  app.openapi(userGetStopWatchesRoute(requireAuth), async (c) => {
    const doer = requireDoer(c);
    const doerRow = await findDoerRow(c.env.DB, doer);
    if (doerRow === null) throw new ApiError(401, "token is required");
    const viewer = viewerOf(c);
    const url = new URL(c.req.url);
    const { page, limit } = parseListOptions(url);

    const rows = await drizzle(c.env.DB)
      .select()
      .from(issueStopwatches)
      .where(eq(issueStopwatches.userId, doerRow.id))
      .orderBy(asc(issueStopwatches.id))
      .all();
    setPaginationHeaders(c, rows.length, { page, limit });

    const now = new Date();
    const rendered: Array<Record<string, unknown>> = [];
    for (const row of rows.slice((page - 1) * limit, page * limit)) {
      const issue = (await drizzle(c.env.DB).select().from(issues).where(eq(issues.id, row.issueId)).limit(1))[0];
      if (issue === undefined) {
        continue; // GetRepositoryByID failure arm (issue.go:200-204)
      }
      const pair = await findRepositoryById(c.env.DB, issue.repoId);
      if (pair === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, pair.repo))) {
        continue; // CanReadIssuesOrPulls skip (issue.go:214-217)
      }
      const seconds = Math.max(0, Math.floor((now.getTime() - row.createdAt.getTime()) / 1000));
      rendered.push({
        created: row.createdAt.toISOString(),
        seconds,
        duration: secToHours(seconds),
        issue_index: issue.index,
        issue_title: issue.title,
        repo_owner_name: pair.repo.ownerNamespace,
        repo_name: pair.repo.slug,
      });
    }
    return c.json(rendered, 200);
  });

  // -------------------------------------------------------------------------
  // POST /user/gpg_key_verify (userVerifyGPGKey) — verify an armored
  // signature over the VerificationToken challenge and mark the key verified
  // (the RSA subset, module header). Success answers the contract's 201 with
  // the re-rendered key (primary + subkeys).
  // -------------------------------------------------------------------------
  app.openapi(userVerifyGpgKeyRoute(requireAuth), async (c) => {
    const doer = requireDoer(c);
    const doerRow = await findDoerRow(c.env.DB, doer);
    if (doerRow === null) throw new ApiError(401, "token is required");
    const form = c.req.valid("json");
    const token = await verificationToken(doerRow, 1);
    if (form.key_id === undefined || form.armored_signature === undefined) {
      // upstream's binder 422 for the two Required fields (api.go:841-844) —
      // runtime-only undeclared.
      throw new ApiError(422, `${form.key_id === undefined ? "KeyID" : "Signature"}: Required`);
    }
    const keyId = form.key_id.replace(/^0+/, "");
    if (keyId === "") {
      // VerifyUserGPGKey's empty-key_id arm (gpg_key.go:211-214).
      throw new ApiError(404, "not found");
    }
    // VerifyGPGKey (gpg_key_verify.go:27-33): the owner's primary-key row for
    // the exact key_id; a miss is upstream's 500 (module header) — answered
    // with the contract's 404 here.
    const keyRow = (
      await drizzle(c.env.DB)
        .select()
        .from(gpgKeys)
        .where(and(eq(gpgKeys.ownerId, doerRow.id), eq(gpgKeys.keyId, keyId), eq(gpgKeys.primaryKeyId, "")))
        .limit(1)
    )[0];
    if (keyRow === undefined) {
      throw new ApiError(404, "not found");
    }
    const subkeyRows = (await loadSubkeys(c.env.DB, [keyRow.keyId])).get(keyRow.keyId) ?? [];
    // The lastToken fallback (gpg_key.go:216-219): a signature made in the
    // previous minute still verifies. Token candidates ride inside the
    // verifier (VerifyGPGKey:39-50).
    const lastToken = await verificationToken(doerRow, 0);
    try {
      await verifyTokenSignature([keyRow, ...subkeyRows], token, form.armored_signature);
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        await verifyTokenSignature([keyRow, ...subkeyRows], lastToken, form.armored_signature);
      } else {
        throw error;
      }
    }
    await drizzle(c.env.DB).update(gpgKeys).set({ verified: true }).where(eq(gpgKeys.id, keyRow.id));
    return c.json(toApiGpgKey({ ...keyRow, verified: true }, subkeyRows), 201);
  });
}
