/**
 * The git-lfs locks API (SPEC-0006 §2.7) — wire-faithful port of upstream
 * `services/lfs/locks.go` at pin `fc49368845` (handlers), with the shared
 * LFS auth pipeline of src/lfs/router.ts `authorizeLfs`.
 *
 * Route table (`routers/common/lfs.go:22-27`): the four registrations sit in
 * a group carrying `lfs.CheckAcceptMediaType`, so a MATCHED locks route 415s
 * before auth while a method mismatch (GET `locks/verify`, DELETE `locks`,
 * ...) falls to the family catch-all's plain-text 404 — the dispatcher in
 * router.ts models exactly that split via `parseLfsRoute`.
 *
 * Per-verb upstream arms (locks.go line refs):
 * - list   GET /locks          scope Read,  authenticate(requireSigned, !write)
 * - create POST /locks         scope Write, authenticate(requireSigned, write)
 * - verify POST /locks/verify  scope Read,  authenticate(requireSigned, write)
 *          — upstream's own asymmetry (locks.go:216 vs 221), ported as-is.
 * - unlock POST /locks/{lid}/unlock  scope Write, authenticate(requireSigned, write)
 *
 * All four REQUIRE a signed-in doer (`requireSigned=true`): anonymous
 * requests 401 even on public repos, with the route-specific message:
 * "You must have pull access to list locks" / "You must have push access to
 * {create,verify,delete} locks" + `WWW-Authenticate: Basic realm="gitea-lfs"`.
 * A `gdt_` deploy-key token signs in as the synthetic key user (upstream
 * mounts the family WITH `AllowDeployToken`, web.go:1777): list needs the
 * key's own repo at ANY mode, create/verify/unlock need mode >= 2 (verify is
 * a WRITE-authenticate route at the pin, locks.go:216 vs 221); a foreign
 * key's zero permission takes the same route-message 401 (no anonymous arm
 * for the key user). Doer attribution uses upstream's shared synthetic user
 * id -3 (`LFS_DEPLOY_KEY_DOER_ID`).
 * A known token lacking the scope category → `CheckRepoScopedToken` → plain
 * 403 "Forbidden\n" (`scopeForbidden`, unchanged). The no-grant arm is a 401
 * with the same route message (upstream's `authenticate` false arm) — the
 * §5.2 family divergence (challenge instead of the git-HTTP 404 mask).
 *
 * Response bytes: upstream's `ctx.JSON` sets `application/json;charset=utf-8`
 * AFTER the handlers set the LFS media type (so it wins) and its jsonv2
 * `MarshalWrite` emits compact JSON WITHOUT a trailing newline (verified
 * empirically against the pin's own encoder wrapper —
 * modules/json/jsonv2.go routes `Encoder.Encode` to the same `MarshalWrite`).
 * The two `writeStatus` arms (415 accept, 400 decode) DO use the LFS media
 * type, also without the newline. The unlock not-found and
 * not-owner-without-force arms are upstream's exact 500 (locks.go:311-318
 * maps EVERY `DeleteLFSLockByID` error to one message — there is no 404/403
 * arm at this pin).
 *
 * Paging (list + verify, locks.go:77-83/232-238): `cursor` is a PAGE number
 * over `limit`-sized pages ordered by id — cursor 0 and 1 alias the first
 * page (upstream quirk); `limit` caps at `LFS_LOCKS_PAGING_NUM` (50),
 * `limit <= 0` (incl. missing/non-numeric) means UNLIMITED; `next_cursor`
 * rides only when the page came back full. The list `?id=` arm answers a
 * Go `strconv` error text as `400 "bad request : " + err`; `?path=` answers
 * the single case-insensitive match or `{"locks":[]}`.
 */

import type { AuthUser } from "../auth/auth-context";
import {
  DEPLOY_TOKEN_PREFIX,
  needsDeployKeyLastUsedTouch,
  touchDeployKeyLastUsed,
  verifyDeployToken,
  type VerifiedDeployKey,
} from "../auth/deploy-token-service";
import { D1FailureLimiter } from "../auth/failure-limiter";
import { basicAuthTokenCandidate, parseAuthorizationHeader } from "../auth/httpauth";
import {
  limiterCheckFailOpen,
  limiterRecordFailureFailOpen,
  limiterResetFailOpen,
} from "../auth/middleware";
import { ScopeSet } from "../auth/scopes";
import { TokenService, type VerifiedAuth } from "../auth/token-service";
import {
  accountDisabled,
  ownerUnavailable,
  rateLimited,
  repositoryArchived,
  scopeForbidden,
} from "../git-http/respond";
import { LFS_MEDIA_TYPE, acceptsLfsMediaType } from "../services/lfs/batch";
import {
  goParseInt64,
  goParseInt64ErrorText,
  locksNextCursor,
  parseLocksPaging,
  toLfsLockWire,
  type LfsLockWire,
} from "../services/lfs/locks";
import type { LfsDeps, LfsRoute, ResolvedLfsRepo } from "./router";
import { LFS_DEPLOY_KEY_DOER_ID, decideLfsDeployKey, lfsNotFound, lfsRepoId, readBodyCapped } from "./router";

/**
 * Lock bodies are one path / one force flag (git-lfs sends ~50 bytes). The
 * family cap discipline (`readBodyCapped`) bounds hostile input; over-cap
 * answers the same `writeStatus(400)` arm as an undecodable body.
 */
export const LFS_LOCKS_BODY_MAX_BYTES = 64 * 1024;

/** Upstream `authenticate`'s access mode per verb (locks.go requireWrite). */
type LocksAccess = "read" | "write";
/** `CheckRepoScopedToken`'s level per verb (locks.go:62/151/216/284). */
type LocksScope = "read" | "write";
export type LfsLockVerb = "list" | "create" | "verify" | "unlock";

const LOCK_MESSAGES: Record<LfsLockVerb, string> = {
  list: "You must have pull access to list locks",
  create: "You must have push access to create locks",
  verify: "You must have push access to verify locks",
  unlock: "You must have push access to delete locks",
};

// ---------------------------------------------------------------------------
// Response shapers (ctx.JSON / writeStatusMessage clones — see header)
// ---------------------------------------------------------------------------

/** `ctx.JSON` (services/context/base.go:114-120): compact, no newline. */
function lockJson(status: number, body: string, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json;charset=utf-8", ...headers },
  });
}

/** 401 arm: gitea-lfs realm + the route-specific LFSLockError body. */
function lockChallenge(message: string): Response {
  return lockJson(401, JSON.stringify({ message }), {
    "www-authenticate": 'Basic realm="gitea-lfs"',
  });
}

/**
 * `writeStatusMessage` (server.go:530-540) — the LFS media type + status
 * text body, no trailing newline (the pin's Encoder wraps MarshalWrite).
 * Used by the 415 accept arm and the 400 decode arms.
 */
function lockWriteStatus(status: number, statusText: string): Response {
  return new Response(JSON.stringify({ message: statusText }), {
    status,
    headers: { "content-type": LFS_MEDIA_TYPE },
  });
}

// ---------------------------------------------------------------------------
// Auth — the §2.2 pipeline with the locks-specific failure bodies
// ---------------------------------------------------------------------------

/**
 * `authorizeLfsLocks` mirrors `authorizeLfs` (router.ts) decision-for-decision
 * — credential parse → failure limiter → deploy-key arm → token verify →
 * scope → account status → grants → write checks — with two locks-specific
 * overrides: the signed-in requirement (no anonymous-read pass,
 * `requireSigned`) and the 401 bodies, which carry the route-specific
 * pull/push messages instead of the generic "Unauthorized". The
 * disabled/owner-prohibited arms keep the family posture (§5.5:
 * accountDisabled/ownerUnavailable 403s).
 *
 * Success resolves the request's doer id: the verified user's id, or
 * upstream's shared synthetic key user (-3, `LFS_DEPLOY_KEY_DOER_ID`) for a
 * `gdt_` credential — locks ownership compares against it.
 */
export async function authorizeLfsLocks(input: {
  req: Request;
  env: Env;
  waitUntil: (promise: Promise<void>) => void;
  verb: LfsLockVerb;
  access: LocksAccess;
  scope: LocksScope;
  repo: ResolvedLfsRepo["repo"];
  owner: AuthUser | null;
  ownerVisibility: ResolvedLfsRepo["ownerVisibility"];
}): Promise<Response | { doerId: number }> {
  const { req, env, verb, access, scope, repo, owner } = input;
  const message = LOCK_MESSAGES[verb];

  const header = req.headers.get("authorization");
  const parsed = header === null ? null : parseAuthorizationHeader(header);
  // Two credential carriers, kept apart (mirrors authorizeLfs): the
  // deploy-token method parses ONLY the Basic header, so a `Bearer gdt_…`
  // rides the access-token arm and fails there.
  const bearerToken = parsed?.bearerToken?.token ?? null;
  const basicCandidate = parsed?.basicAuth ? basicAuthTokenCandidate(parsed.basicAuth) : null;
  const credential = bearerToken ?? basicCandidate;

  // requireSigned (locks.go:67/156/221/289): anonymous requests never pass —
  // a public repo's locks still 401 with the route message.
  if (credential === null) return lockChallenge(message);

  const ownerActive = owner !== null && owner.status === "active";
  const publiclyVisible = repo.visibility === "public" && ownerActive && input.ownerVisibility === "public";

  // Same limiter discipline as the family pipeline (SPEC-0002 §2.7): the
  // limiter calls fail open, verification below stays fail-closed.
  const now = new Date();
  const limiter = new D1FailureLimiter(env.DB);
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const verdict = await limiterCheckFailOpen(limiter, ip, now);
  if (verdict.blocked) return rateLimited(verdict.retryAfterSeconds);

  // Deploy-token arm — before the access-token verify, upstream's group
  // order on the LFS routes (web.go:131-133; the family mounts WITH
  // AllowDeployToken, web.go:1777). The `gdt_` prefix gate makes this a
  // no-op for every other credential; a miss falls through exactly like
  // upstream's "not a deploy token, let the other methods try"
  // (deploy_token.go:36).
  if (basicCandidate !== null && basicCandidate.startsWith(DEPLOY_TOKEN_PREFIX)) {
    let key: VerifiedDeployKey | null;
    try {
      key = await verifyDeployToken(env.DB, basicCandidate);
    } catch {
      // D1 unavailable mid-request: fail closed, never fail open.
      return new Response("internal server error\n", {
        status: 500,
        headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
      });
    }
    if (key !== null) {
      input.waitUntil(limiterResetFailOpen(limiter, ip));
      input.waitUntil(
        needsDeployKeyLastUsedTouch(key, now)
          ? touchDeployKeyLastUsed(env.DB, key.id, now)
          : Promise.resolve(),
      );
      // The synthetic key user carries no token status row; the family's
      // owner-unavailable posture (§5.5) still applies to every caller.
      if (owner !== null && owner.status === "prohibited") return ownerUnavailable();
      // No scope arm (the key carries no token scope — upstream
      // CheckRepoScopedToken skips the key user): the key row IS the grant.
      const decision = decideLfsDeployKey(access, repo, key);
      if (decision === "zero-perm") return lockChallenge(message);
      if (decision === "archived-write") return repositoryArchived();
      return { doerId: LFS_DEPLOY_KEY_DOER_ID };
    }
  }

  let verified: VerifiedAuth | null;
  try {
    verified = await new TokenService(env.DB).verify(credential, { now });
  } catch {
    return new Response("internal server error\n", {
      status: 500,
      headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }
  if (verified === null) {
    input.waitUntil(limiterRecordFailureFailOpen(limiter, ip, now));
    return lockChallenge(message);
  }

  input.waitUntil(limiterResetFailOpen(limiter, ip));
  input.waitUntil(
    new TokenService(env.DB).needsLastUsedTouch(verified.token, now)
      ? new TokenService(env.DB).touchLastUsed(verified.token.id, now)
      : Promise.resolve(),
  );

  // CheckRepoScopedToken (locks.go:62/151/216/284) → ctx.HTTPError(403).
  const scopeSet = ScopeSet.parseLenient(verified.token.scopes);
  const required = scope === "read" ? "read:repository" : "write:repository";
  if (!scopeSet.has(required)) return scopeForbidden();

  // Family posture (§5.5): disabled doer / prohibited owner → 403.
  if (verified.user.status === "prohibited") return accountDisabled();
  if (owner !== null && owner.status === "prohibited") return ownerUnavailable();

  // `authenticate` (requireSigned + access mode): the grant model is the
  // family's; the failure body is the route message (upstream's
  // authenticate-false arm).
  const isOwner = owner !== null && verified.user.id === owner.id;
  const isSiteAdmin = verified.user.isAdmin;
  const canRead =
    publiclyVisible ||
    isOwner ||
    isSiteAdmin ||
    (repo.visibility === "public" && ownerActive && input.ownerVisibility === "limited");
  const maskedByPublicOnly = scopeSet.publicOnly && !publiclyVisible;
  if (!canRead || maskedByPublicOnly) return lockChallenge(message);

  if (access === "write") {
    if (repo.isArchived) return repositoryArchived();
    if (!isOwner && !isSiteAdmin) return lockChallenge(message);
  }
  return { doerId: verified.user.id };
}

// ---------------------------------------------------------------------------
// Dispatcher + handlers
// ---------------------------------------------------------------------------

export async function handleLocks(
  req: Request,
  env: Env,
  waitUntil: (promise: Promise<void>) => void,
  lfs: LfsRoute,
  resolved: ResolvedLfsRepo,
  deps: LfsDeps,
): Promise<Response> {
  const route = lfs.lock;
  if (route === undefined) return lfsNotFound(); // hand-built route (defensive)

  // The locks group middleware (lfs.go:28): 415 before auth on matched
  // routes only (method mismatches never reach here — parse marks them
  // not-found → the plain-text catch-all).
  if (!acceptsLfsMediaType(req.headers.get("accept"))) {
    return lockWriteStatus(415, "Unsupported Media Type");
  }

  const { verb } = route;
  const access: LocksAccess = verb === "list" ? "read" : "write";
  const scope: LocksScope = verb === "create" || verb === "unlock" ? "write" : "read";
  const auth = await authorizeLfsLocks({
    req,
    env,
    waitUntil,
    verb,
    access,
    scope,
    repo: resolved.repo,
    owner: resolved.owner,
    ownerVisibility: resolved.ownerVisibility,
  });
  if (auth instanceof Response) return auth;
  const doerId = auth.doerId;

  const params = new URL(req.url).searchParams;
  switch (verb) {
    case "list":
      return handleLockList(params, resolved, deps);
    case "verify":
      return handleLockVerify(params, doerId, resolved, deps);
    case "create":
      return handleLockCreate(req, doerId, resolved, deps);
    case "unlock":
      return handleLockUnlock(req, route.lid ?? "", doerId, resolved, deps);
  }
}

/** Run a handler body; a thrown service error maps to its upstream 500 text. */
async function guarded(run: () => Promise<Response>, message: string): Promise<Response> {
  try {
    return await run();
  } catch {
    return lockJson(500, JSON.stringify({ message }));
  }
}

/** The `{"locks":[...]}` (+ optional `next_cursor`) 200 body. */
function lockListBody(locks: (LfsLockWire | null)[], next: string): string {
  return JSON.stringify({ locks, ...(next !== "" ? { next_cursor: next } : {}) });
}

/** `GetListLockHandler` (locks.go:48-132). */
function handleLockList(params: URLSearchParams, resolved: ResolvedLfsRepo, deps: LfsDeps): Promise<Response> {
  return guarded(async () => {
    const repoId = lfsRepoId(resolved.repo.id);

    // ?id= arm (locks.go:84-99): Go ParseInt error → 400 "bad request : …";
    // a missing lock answers `{"locks":[]}` (handleLockListOut's
    // IsErrLFSLockNotExist arm), a hit answers the single-item list.
    const idRaw = params.get("id") ?? "";
    if (idRaw !== "") {
      const parsed = goParseInt64(idRaw);
      if (parsed.errorClass !== null) {
        return lockJson(
          400,
          JSON.stringify({
            message: `bad request : ${goParseInt64ErrorText(idRaw, parsed.errorClass)}`,
          }),
        );
      }
      const lock = await deps.locks.getByIdAndRepo(Number(parsed.value), repoId);
      const wire = lock === null ? null : toLfsLockWire(lock);
      return lockJson(200, lockListBody(wire === null ? [] : [wire], ""));
    }

    // ?path= arm (locks.go:101-109): single case-insensitive match.
    const pathRaw = params.get("path") ?? "";
    if (pathRaw !== "") {
      const lock = await deps.locks.getByPath(repoId, pathRaw);
      const wire = lock === null ? null : toLfsLockWire(lock);
      return lockJson(200, lockListBody(wire === null ? [] : [wire], ""));
    }

    // Plain list (locks.go:111-131): paged, ordered by id.
    const { cursor, limit } = parseLocksPaging(params);
    const rows = await deps.locks.listPaged(repoId, cursor, limit);
    const next = locksNextCursor(cursor, limit, rows.length);
    return lockJson(200, lockListBody(rows.map(toLfsLockWire), next));
  }, "unable to list locks : Internal Server Error");
}

/**
 * `PostLockHandler` (locks.go:135-197): body decode failure → `writeStatus`
 * 400 (the LFS-media-type arm, NOT ctx.JSON); 201 with the created lock;
 * 409 "already created lock" with the EXISTING lock echoed
 * (CreateLFSLock returns the found row on conflict, locks.go:183-189).
 */
function handleLockCreate(
  req: Request,
  doerId: number,
  resolved: ResolvedLfsRepo,
  deps: LfsDeps,
): Promise<Response> {
  return guarded(async () => {
    let text: string;
    try {
      text = await readBodyCapped(req, LFS_LOCKS_BODY_MAX_BYTES);
    } catch {
      return lockWriteStatus(400, "Bad Request");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return lockWriteStatus(400, "Bad Request");
    }
    // Go decodes into `api.LFSLockRequest{Path string}`: a present-but-not-
    // string path is a v2 type error → the same 400 arm; an absent path
    // decodes as "" (upstream validates nothing — an empty-path lock is
    // creatable and then duplicates as 409).
    if (typeof parsed !== "object" || parsed === null) return lockWriteStatus(400, "Bad Request");
    const record = parsed as { path?: unknown };
    const rawPath = record.path === undefined ? "" : record.path;
    if (typeof rawPath !== "string") return lockWriteStatus(400, "Bad Request");

    const result = await deps.locks.create(lfsRepoId(resolved.repo.id), doerId, rawPath, deps.now());
    if ("conflict" in result) {
      const wire = toLfsLockWire(result.conflict);
      // LFSLockError.Lock is omitempty: a null lock drops the field.
      return lockJson(
        409,
        JSON.stringify({ message: "already created lock", ...(wire !== null ? { lock: wire } : {}) }),
      );
    }
    return lockJson(201, JSON.stringify({ lock: toLfsLockWire(result.created) }));
  }, "internal server error : Internal Server Error");
}

/** `VerifyLockHandler` (locks.go:200-265): same paging, ours/theirs split by owner. */
function handleLockVerify(
  params: URLSearchParams,
  doerId: number,
  resolved: ResolvedLfsRepo,
  deps: LfsDeps,
): Promise<Response> {
  return guarded(async () => {
    const { cursor, limit } = parseLocksPaging(params);
    const rows = await deps.locks.listPaged(lfsRepoId(resolved.repo.id), cursor, limit);
    const next = locksNextCursor(cursor, limit, rows.length);
    const ours: (LfsLockWire | null)[] = [];
    const theirs: (LfsLockWire | null)[] = [];
    for (const row of rows) {
      const wire = toLfsLockWire(row);
      if (row.ownerId === doerId) ours.push(wire);
      else theirs.push(wire);
    }
    return lockJson(200, JSON.stringify({ ours, theirs, ...(next !== "" ? { next_cursor: next } : {}) }));
  }, "unable to list locks : Internal Server Error");
}

/**
 * `UnLockHandler` (locks.go:268-320): `PathParamInt64` discards the parse
 * error (syntax → 0, range → clamp); the body decodes `LFSLockDeleteRequest`
 * (failure → the writeStatus 400 arm). Every `DeleteLFSLockByID` error —
 * not-found AND not-owner-without-force (lfs_lock.go:154-171) — maps to the
 * ONE upstream arm: 500 "unable to delete lock : Internal Server Error"
 * (locks.go:311-318). Success echoes the deleted lock: 200.
 */
function handleLockUnlock(
  req: Request,
  lidRaw: string,
  doerId: number,
  resolved: ResolvedLfsRepo,
  deps: LfsDeps,
): Promise<Response> {
  return guarded(async () => {
    const parsedLid = goParseInt64(lidRaw); // "" → syntax → 0, like Atoi/ParseInt discard
    const lockId = Number(parsedLid.value);

    let text: string;
    try {
      text = await readBodyCapped(req, LFS_LOCKS_BODY_MAX_BYTES);
    } catch {
      return lockWriteStatus(400, "Bad Request");
    }
    let parsed: unknown;
    try {
      parsed = text === "" ? {} : (JSON.parse(text) as unknown);
    } catch {
      return lockWriteStatus(400, "Bad Request");
    }
    let force = false;
    if (typeof parsed === "object" && parsed !== null && "force" in parsed) {
      const rawForce = (parsed as { force?: unknown }).force;
      if (typeof rawForce !== "boolean") return lockWriteStatus(400, "Bad Request");
      force = rawForce;
    }

    const lock = await deps.locks.getByIdAndRepo(lockId, lfsRepoId(resolved.repo.id));
    if (lock === null) return unlockInternalError();
    if (!force && lock.ownerId !== doerId) return unlockInternalError();
    await deps.locks.remove(lock.id, lock.repoId);
    return lockJson(200, JSON.stringify({ lock: toLfsLockWire(lock) }));
  }, "unable to delete lock : Internal Server Error");
}

function unlockInternalError(): Response {
  return lockJson(500, JSON.stringify({ message: "unable to delete lock : Internal Server Error" }));
}
