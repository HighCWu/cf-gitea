/**
 * LFS HTTP route family — SPEC-0006 §2.1-§2.3 (M1 relay mode).
 *
 * Upstream registers the whole family under one group with `m.Any("/*",
 * NotFound)` (`routers/common/lfs.go:15-31`); cf-gitea mounts the identical
 * shapes at `/:owner/:repo(.git)?/info/lfs/*`. The branch is intercepted in
 * the SPEC-0003 gitHttpGate (before engine delegation). Repos WITHOUT a D1
 * row are served by THIS family too (the ledger L9 correction, 2026-11-02 —
 * the old engine passthrough retired): upstream's LFS handlers resolve the
 * repo themselves (`getAuthenticatedRepository`, `server.go:462-468`) and
 * never consult the redirect table (`GetRepositoryByOwnerAndName`,
 * `models/repo/repo.go:747-763`, has no LookupRedirect arm), so a
 * nonexistent OR renamed repo's old URL answers the same arms: the
 * batch/objects/verify family 404s with the LFS JSON envelope, the locks
 * family 401s with the route-specific message (locks.go:51-59 and its three
 * siblings).
 *
 * Wire parity notes (upstream pin `fc49368845`, services/lfs/server.go):
 * - Error responses outside the batch envelope carry the LFS media type and a
 *   JSON body `{"message": "<status text>"}` (`writeStatusMessage`). ALL
 *   family JSON bodies — writeStatus arms, the batch `{objects}` envelope,
 *   the upload/verify 200 `{"message":"OK"}` — are COMPACT with NO trailing
 *   newline: the pin's jsonv2 `MarshalWrite` appends nothing (verified
 *   empirically; the `\n` the family used to ship was a recorded cosmetic
 *   divergence, reconciled to match the locks family byte-for-byte).
 * - The 401 challenge is `WWW-Authenticate: Basic realm="gitea-lfs"` with that
 *   same JSON body (`requireAuth` → `writeStatus(401)`) — unlike the git-HTTP
 *   gate's plain-text `realm="Gitea"` challenge.
 * - Auth split (§2.2): nonexistent/renamed repo → 404 before any challenge on
 *   the batch/objects/verify routes (the repo-lookup arm runs inside each
 *   handler, after its own pre-repo validation — a bad oid still 422s first);
 *   no credentials / no access → 401 + realm (upstream challenges where
 *   git-HTTP 404-masks — documented divergence from SPEC-0003 §2.4, kept per
 *   §2.2); authenticated but lacking `read:`/`write:repository` → 403, with
 *   upstream's ORDER: authenticate (401) runs BEFORE the scope check (403),
 *   so a double failure challenges (the ledger L7 correction, 2026-11-02 —
 *   the locks family keeps its own scope-first order, which IS upstream's
 *   locks shape); a `gdt_` deploy-key token authenticates with the key's own
 *   repo at its mode (upstream mounts the family WITH `AllowDeployToken`,
 *   web.go:1777 — see `decideLfsDeployKey` below).
 * - Credentials: Basic + deploy-key token ONLY (upstream's group carries
 *   `AllowBasic` + `AllowDeployToken`, web.go:1777 — NOT AllowOAuth2; the
 *   `Bearer` arm in upstream's `parseToken` is the internal SSH JWT,
 *   `server.go:621-630`, which no external client can mint). A `Bearer`
 *   access token therefore reads as anonymous here (the ledger L8
 *   correction, 2026-11-02 — SPEC-0006 §2.3 always said Basic only).
 * - Batch: accept check 415 → decode 400 / unknown operation 400 → repo
 *   lookup 404 → auth (`upload` op writes, `download` reads) → object-count
 *   cap 413 (upstream's order, `server.go:214-222`; L10) → per-object
 *   results in a 200 envelope (object-level errors never fail the request);
 *   a missing/null `objects` key marshals `{"objects":null}` (L11).
 * - Upload: pointer-from-path validation → 422 (the size segment parses with
 *   Go strconv.ParseInt semantics and its NumError text — upstream's
 *   missing-return bug after that 422 is NOT replicated, documented at the
 *   handler; L12) → repo lookup 404 → write auth; relay uploads REQUIRE
 *   Content-Length (git-lfs basic always sends one) → 411 otherwise, because
 *   the store's streaming put enforces the declared size (SPEC-0006 §2.3);
 *   bytes present WITH a row for this repo skip the body check entirely —
 *   no size comparison, no re-hash, no row refresh (`NewLFSMetaObject` is
 *   insert-if-absent, `models/git/lfs.go:106-119`; the ledger L6 correction);
 *   bytes present without a row (or absent) are streamed through the
 *   single-pass hash-and-forward put, which proves sha256(content) == oid and
 *   deletes the object on mismatch → 422 with the upstream error strings;
 *   success inserts the row if absent (rows arise ONLY here — L5).
 * - Verify: decode 422 → pointer validation 422 → repo lookup 404 → write
 *   auth → HEAD-based verification (presign mode additionally requires the
 *   stored checksum); success flips `uploading → verified`, or adopts a
 *   missing row (§3.3 self-heal — our extension, covers a lost row write,
 *   §4.13).
 * - Download: pointer validation 422 → repo lookup 404 → read auth → row 404
 *   → relay stream with `Content-Type: application/octet-stream`, the parity
 *   header `X-Gitea-LFS-Content-Length`, upstream's `bytes=(\d+)-(\d*)` Range
 *   handling (206/416), and `Content-Disposition` from the base64url
 *   `{filename}` segment (decode failure ⇒ param ignored, never reflected).
 * - The catch-all is stdlib-shaped, like upstream's `m.Any("/*",
 *   http.NotFound)`: plain-text `404 page not found`, not the LFS JSON
 *   envelope (which only `writeStatusMessage`-issuing handlers use).
 * - Successes ride the same envelope: `writeStatus(200)` emits
 *   `{"message":"OK"}` with the LFS media type (upload + verify).
 *
 * Locks (`info/lfs/locks/*`, §2.7) are implemented per upstream
 * `services/lfs/locks.go`: the four group registrations (GET/POST `locks`,
 * POST `locks/verify`, POST `locks/{lid}/unlock`) run the group's
 * `CheckAcceptMediaType` (415), then the repo-missing 401 (route message —
 * locks.go:51-59 and siblings; L9), then per-verb auth (list/verify read,
 * create/unlock write — all REQUIRE a signed-in doer, `requireSigned`), then
 * the upstream arms: 401 with the route-specific "You must have pull/push
 * access to <verb> locks" JSON body + the gitea-lfs realm, 403 scope, 400
 * body-decode (`writeStatus`), 201 create / 200 list+verify+unlock / 409
 * duplicate with the existing lock echoed. Response content-type is
 * `application/json;charset=utf-8` with NO trailing newline — upstream's
 * `ctx.JSON` overrides the media-type header the handlers set and its
 * jsonv2 `MarshalWrite` emits compact bodies (both verified at the pin);
 * unlock's not-found and not-owner-without-force arms answer upstream's exact
 * 500 "unable to delete lock : Internal Server Error" (locks.go:311-318 maps
 * EVERY `DeleteLFSLockByID` error there — there is no 404/403 arm at this
 * pin). See src/lfs/locks.ts for the arm-by-arm citations.
 *
 * Config: upstream serves the subtree only when `LFS_START_SERVER` is on
 * (`lfsServerEnabled` parity). No config surface exists yet (`wrangler.jsonc`
 * is owned elsewhere), so LFS is unconditionally enabled; limits come from
 * the service defaults (§2.2 `LFS_MAX_BATCH_SIZE` 100, §4.6 512 MiB, §4.7
 * 10 GiB quota).
 */

import type { DurableGitHandler } from "@cf-gitea/git-engine";

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
// The gate consults the same repository-service grant fold as the git-HTTP
// ACL (SPEC-0007 §3.5 teams + SPEC-0005 collaborator row): one resolution,
// no drift.
import { doerRepoAccessMode } from "../api/services/repository";
import { readGrant, resolveRepository } from "../git-http/acl";
import {
  accountDisabled,
  ownerUnavailable,
  rateLimited,
  repositoryArchived,
  scopeForbidden,
} from "../git-http/respond";
import {
  acceptsLfsMediaType,
  BatchRequestError,
  DEFAULT_LFS_LIMITS,
  isValidPointerFields,
  LFS_MEDIA_TYPE,
  parseBatchRequest,
  shapeBatchResponse,
  type BatchShapingContext,
  type LfsLimits,
} from "../services/lfs/batch";
import { LfsLockService } from "../services/lfs/locks";
import { goParseInt64, goParseInt64ErrorText } from "../services/lfs/locks";
import { handleLocks } from "./locks";
import { LfsStateService, validateAdoptStat } from "../services/lfs/state";
import {
  createLfsStore,
  LfsHashMismatchError,
  LfsSizeMismatchError,
  lfsKey,
  lfsStoreConfigFromEnv,
  type LfsStore,
} from "../services/lfs/store";
import type { repositories } from "../db/schema";

type RepositoryRow = typeof repositories.$inferSelect;

// ---------------------------------------------------------------------------
// Route parsing
// ---------------------------------------------------------------------------

/** The LFS family sub-routes (SPEC-0006 §2.1 table). */
export type LfsRouteKind = "batch" | "upload" | "download" | "verify" | "locks" | "not-found";

/** The locks group's four registrations (`routers/common/lfs.go:22-27`). */
export type LfsLockVerb = "list" | "create" | "verify" | "unlock";

export interface LfsLocksSubRoute {
  verb: LfsLockVerb;
  /** `POST /locks/{lid}/unlock` raw path segment (Go ParseInt per handler). */
  lid: string | null;
}

export interface LfsRoute {
  /** Decoded owner path segment (request casing; D1 lookups fold case). */
  owner: string;
  /** Decoded repo segment with exactly one trailing `.git` trimmed (§2.1). */
  repo: string;
  kind: LfsRouteKind;
  /** `objects/{oid}` first segment, when present (raw — validated per handler). */
  oid: string | null;
  /**
   * `objects/{oid}/{arg}` second segment: the declared size for PUT (upload)
   * or the base64url filename for GET (download). Null on bare `objects/{oid}`.
   */
  arg: string | null;
  /**
   * Parsed locks sub-route when `kind === "locks"`; undefined for hand-built
   * routes (defensive — the dispatcher answers those with the catch-all).
   */
  lock?: LfsLocksSubRoute;
}

/**
 * Parse a repository-scoped pathname into an LFS route, or null when the path
 * is not under the `/:owner/:repo(.git)?/info/lfs` family (→ not ours; the
 * caller falls through). Shapes follow upstream's registrations
 * (`lfs.go:17-28`): POST objects/batch, PUT objects/{oid}/{size},
 * GET objects/{oid}[/{filename}], POST verify, locks/*, everything else (and
 * every method mismatch) is the `m.Any("/*", NotFound)` catch-all. Segment
 * handling mirrors the gate's parser (src/git-http/parse.ts): per-segment
 * decodeURIComponent, exactly one trailing `.git` trimmed, undecodable escapes
 * → not ours (the engine 404s them).
 */
export function parseLfsRoute(pathname: string, method: string): LfsRoute | null {
  const segments = pathname.split("/");
  // "/owner/repo/info/lfs[...]" → ["", owner, repo, "info", "lfs", ...rest]
  if (segments.length < 5) return null;
  const [empty, rawOwner, rawName, infoMarker, lfsMarker, ...rest] = segments;
  if (empty !== "" || rawOwner === undefined || rawName === undefined) return null;
  if (infoMarker !== "info" || lfsMarker !== "lfs") return null;

  let owner: string;
  let name: string;
  try {
    owner = decodeURIComponent(rawOwner);
    name = decodeURIComponent(rawName);
  } catch {
    return null;
  }
  const repo = name.endsWith(".git") ? name.slice(0, -4) : name;

  const tail = rest.join("/");
  let kind: LfsRouteKind = "not-found";
  let oid: string | null = null;
  let arg: string | null = null;
  let lock: LfsLocksSubRoute | undefined = undefined;

  if (tail === "objects/batch") {
    kind = method === "POST" ? "batch" : "not-found";
  } else if (tail === "verify") {
    kind = method === "POST" ? "verify" : "not-found";
  } else if (tail === "locks" || tail === "locks/") {
    // Group registrations `m.Get("/")` + `m.Post("/")` — chi matches both the
    // bare and the trailing-slash form; other methods hit the catch-all.
    if (method === "GET" || method === "POST") {
      kind = "locks";
      lock = { verb: method === "GET" ? "list" : "create", lid: null };
    }
  } else if (tail === "locks/verify") {
    if (method === "POST") {
      kind = "locks";
      lock = { verb: "verify", lid: null };
    }
  } else if (/^locks\/[^/]+\/unlock$/.test(tail)) {
    if (method === "POST") {
      kind = "locks";
      lock = { verb: "unlock", lid: tail.slice("locks/".length, tail.length - "/unlock".length) };
    }
  } else if (tail.startsWith("objects/") && tail.length > "objects/".length) {
    const value = tail.slice("objects/".length);
    const slash = value.indexOf("/");
    if (slash === -1) {
      // objects/{oid}: GET only (the PUT shape carries the size segment).
      if (method === "GET") {
        kind = "download";
        oid = value;
      }
    } else {
      const first = value.slice(0, slash);
      const second = value.slice(slash + 1);
      if (!second.includes("/")) {
        if (method === "PUT") {
          kind = "upload";
          oid = first;
          arg = second;
        } else if (method === "GET") {
          kind = "download";
          oid = first;
          arg = second;
        }
      }
    }
  }

  return { owner, repo, kind, oid, arg, lock };
}

// ---------------------------------------------------------------------------
// Response shapes (upstream writeStatusMessage / requireAuth)
// ---------------------------------------------------------------------------

/** Go `http.StatusText` for the statuses the family answers with. */
function statusText(status: number): string {
  switch (status) {
    case 200:
      return "OK";
    case 404:
      return "Not Found";
    case 411:
      return "Length Required";
    case 413:
      return "Request Entity Too Large";
    case 415:
      return "Unsupported Media Type";
    case 416:
      return "Requested Range Not Satisfiable";
    case 422:
      return "Unprocessable Entity";
    case 500:
      return "Internal Server Error";
    case 501:
      return "Not Implemented";
    default:
      return "Unknown";
  }
}

/**
 * `writeStatusMessage` (`server.go:530-540`): LFS media type + JSON message.
 * The body is COMPACT JSON WITHOUT a trailing newline — the pin's jsonv2
 * `MarshalWrite` appends nothing (verified empirically, Go 1.25), matching
 * the locks family's `lockWriteStatus` byte-for-byte (the family-wide
 * reconciliation of the `\n` divergence recorded at 7b589c7).
 */
export function lfsError(status: number, message?: string, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ message: message ?? statusText(status) }), {
    status,
    headers: { "content-type": LFS_MEDIA_TYPE, ...headers },
  });
}

/**
 * `requireAuth` (`server.go:632-635`): the gitea-lfs realm challenge. The body
 * is the JSON `writeStatus(401)` shape, not the git-HTTP plain text.
 */
export function lfsChallenge(): Response {
  return lfsError(401, "Unauthorized", { "www-authenticate": 'Basic realm="gitea-lfs"' });
}

/**
 * The §2.1 catch-all row — upstream registers `m.Any("/*", http.NotFound)`
 * (`lfs.go:29`), i.e. Go's stdlib plain-text 404, NOT the LFS JSON
 * `writeStatusMessage` shape (which only the handlers use).
 */
export function lfsNotFound(): Response {
  return new Response("404 page not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

// ---------------------------------------------------------------------------
// Auth — the §2.2 split, mirrored on the git-HTTP ACL pipeline
// ---------------------------------------------------------------------------

/** "upload" op ⇒ write, "download"/GET ⇒ read (§2.1 route table). */
export type LfsOp = "read" | "write";

/** The D1-resolved repo triple the gate's pipeline produces. */
export interface ResolvedLfsRepo {
  repo: RepositoryRow;
  owner: AuthUser | null;
  ownerVisibility: "public" | "limited" | "private";
}

/**
 * Decide an LFS request's authorization. Mirrors `authorizeGitHttp`
 * (credentials → failure limiter → token verify → scope → account status →
 * grants) with upstream's LFS outcomes: no-access challenges (401 + gitea-lfs
 * realm) instead of the git-HTTP 404 mask (SPEC-0006 §2.2 divergence note).
 * Returns true to serve, or the response to send.
 */
export async function authorizeLfs(input: {
  req: Request;
  env: Env;
  waitUntil: (promise: Promise<void>) => void;
  op: LfsOp;
  repo: RepositoryRow;
  owner: AuthUser | null;
  ownerVisibility: ResolvedLfsRepo["ownerVisibility"];
}): Promise<Response | true> {
  const { req, env, op, repo, owner } = input;

  const header = req.headers.get("authorization");
  const parsed = header === null ? null : parseAuthorizationHeader(header);
  // Basic is the ONLY external credential carrier on the LFS family (the
  // ledger L8 correction, 2026-11-02 — SPEC-0006 §2.3 said Basic all along):
  // upstream mounts the routes with `AllowBasic` + `AllowDeployToken`
  // (web.go:1777, NOT AllowOAuth2), and its `parseToken` Bearer arm carries
  // only the internal SSH JWT (`server.go:621-630`) which no external client
  // can mint. A `Bearer` header — access token or `gdt_` alike — is
  // therefore NOT a credential here: it reads as anonymous, exactly like
  // upstream's unauthenticated request.
  const basicCandidate = parsed?.basicAuth ? basicAuthTokenCandidate(parsed.basicAuth) : null;
  const credential = basicCandidate;

  const ownerActive = owner !== null && owner.status === "active";
  const publiclyVisible = repo.visibility === "public" && ownerActive && input.ownerVisibility === "public";

  if (credential === null) {
    // Anonymous: only reads of a publicly visible repo pass (§5 ACL matrix:
    // anonymous download ok, upload 401); everything else challenges.
    if (op === "read" && publiclyVisible) return true;
    return lfsChallenge();
  }

  // Credential path: same limiter discipline as the git-HTTP gate (SPEC-0002
  // §2.7) — anonymous requests have nothing to brute-force. The limiter's
  // calls fail open (ef2c049): a broken limiter must not 500 the request it
  // guards; verification below stays fail-closed.
  const now = new Date();
  const limiter = new D1FailureLimiter(env.DB);
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const verdict = await limiterCheckFailOpen(limiter, ip, now);
  if (verdict.blocked) return rateLimited(verdict.retryAfterSeconds);

  // Deploy-token arm — BEFORE the access-token verify, upstream's group order
  // on the LFS routes ("before Basic, which would try the token as a
  // password", web.go:131-133; the family mounts WITH AllowDeployToken,
  // web.go:1777). Upstream's VerifyDeployKeyToken prefix gate makes this a
  // no-op for every non-`gdt_` Basic credential, and a miss falls through to
  // the access-token arm exactly like upstream's "not a deploy token, let the
  // other methods try" (deploy_token.go:36).
  if (basicCandidate !== null && basicCandidate.startsWith(DEPLOY_TOKEN_PREFIX)) {
    let key: VerifiedDeployKey | null;
    try {
      key = await verifyDeployToken(env.DB, basicCandidate);
    } catch {
      // D1 unavailable mid-request: fail closed, never fail open (SPEC-0002 §4.5).
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
      const decision = decideLfsDeployKey(op, repo, key);
      if (decision === "zero-perm") return lfsChallenge();
      if (decision === "archived-write") return repositoryArchived();
      return true;
    }
    // Unknown `gdt_` value: fall through to the access-token arm (upstream
    // deploy_token.go:36); it cannot verify a deploy token either, so the
    // failure below records the limiter strike and challenges.
  }

  let verified: VerifiedAuth | null;
  try {
    verified = await new TokenService(env.DB).verify(credential, { now });
  } catch {
    // D1 unavailable mid-request: fail closed, never fail open (SPEC-0002 §4.5).
    return new Response("internal server error\n", {
      status: 500,
      headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }
  if (verified === null) {
    input.waitUntil(limiterRecordFailureFailOpen(limiter, ip, now));
    return lfsChallenge();
  }

  const scope = ScopeSet.parseLenient(verified.token.scopes);
  input.waitUntil(limiterResetFailOpen(limiter, ip));
  input.waitUntil(
    new TokenService(env.DB).needsLastUsedTouch(verified.token, now)
      ? new TokenService(env.DB).touchLastUsed(verified.token.id, now)
      : Promise.resolve(),
  );

  // Row 11 parity: disabled/prohibited doer; then upstream httpBase's
  // owner-status check (applies to every caller, owner included).
  if (verified.user.status === "prohibited") return accountDisabled();
  if (owner !== null && owner.status === "prohibited") return ownerUnavailable();

  // The doer's resolved grant over the repo — the SAME repository-service
  // fold the git-HTTP gate consumes (acl.ts:262-267): SPEC-0007 §3.5
  // org/team arms (the Owners-team bridge + covering teams) and the
  // SPEC-0005 active collaborator row; 'none' when the doer holds no grant.
  // Upstream parity: LFS `authenticate` consults the full
  // GetDoerRepoPermission fold (server.go:551-557), not a reduced
  // owner/admin ladder — a collaborator or org-team member who can git push
  // can git lfs push too.
  const teamMode = await doerRepoAccessMode(env.DB, { id: repo.id, ownerId: repo.ownerId }, verified.user.id);

  // Grant lines = the shared readGrant predicate (the git-HTTP matrix's own
  // grant lines — publiclyVisible, owner, site admin, the limited-owner
  // branch — plus the resolved grant at any mode >= read; SPEC-0010 §2.6's
  // one-copy discipline), except the failure outcome: upstream's LFS routes
  // challenge where git-HTTP 404s (§2.2) — the challenge is issued
  // regardless, so existence is not disclosed either way.
  const isOwner = owner !== null && verified.user.id === owner.id;
  const isSiteAdmin = verified.user.isAdmin;
  const canRead = readGrant({
    repoVisibility: repo.visibility,
    owner: owner === null ? null : { id: owner.id, status: owner.status },
    ownerVisibility: input.ownerVisibility,
    doer: { id: verified.user.id, isAdmin: verified.user.isAdmin },
    teamMode,
  });
  const maskedByPublicOnly = scope.publicOnly && !publiclyVisible;
  if (!canRead || maskedByPublicOnly) return lfsChallenge();

  if (op === "write") {
    // §4.11: archived repos refuse LFS writes (platform-consistent with the
    // git-HTTP row 10; reads unaffected).
    if (repo.isArchived) return repositoryArchived();
    // Write ranks at write/admin/owner mode on the resolved grant (the
    // git-HTTP matrix's teamWrites rank, access_mode.go:17-22) — an org team
    // OR the SPEC-0005 collaborator row — beside the owner + site-admin arms.
    const teamWrites = teamMode === "write" || teamMode === "admin" || teamMode === "owner";
    if (!isOwner && !isSiteAdmin && !teamWrites) return lfsChallenge();
  }

  // Row 7 parity — AFTER the grant arms (the ledger L7 correction,
  // 2026-11-02): upstream order is authenticate (requireAuth 401,
  // server.go:470-473) THEN CheckRepoScopedToken (403, server.go:475-483),
  // so a credential that both fails the grant and lacks the repository
  // scope CHALLENGES like upstream instead of 403ing first. (The locks
  // family keeps its scope-first order — that IS upstream's locks shape.)
  const required = op === "read" ? "read:repository" : "write:repository";
  if (!scope.has(required)) return scopeForbidden();
  return true;
}

/**
 * The deploy-key credential's decision on an LFS route — the shared seam both
 * family pipelines (`authorizeLfs`, `authorizeLfsLocks`) render. Upstream
 * mounts the LFS routes WITH `AllowDeployToken` (routers/web/web.go:1777 —
 * "Only add it to an auth group where a repo scoped credential makes
 * sense"), whose group adds `&DeployToken{}` before Basic (web.go:131-133):
 * a Basic `gdt_` credential resolves `ctx.Doer` to the synthetic key user,
 * whose ONLY permission is `getDeployKeyRepoPermission`
 * (models/perm/access/repo_permission.go:387-409) — the code unit of the
 * key's OWN repository at the key's mode. LFS `authenticate`
 * (services/lfs/server.go:544) then tests
 * `perm.CanAccess(Read|Write, unit.TypeCode)`:
 *
 * - the key's own repo (any stored mode — 1 and 2 both satisfy Read) on the
 *   family's READ routes (batch `download`, GET objects, locks list);
 * - the key's own repo at mode >= 2 on the WRITE routes (batch `upload`,
 *   PUT objects, verify, locks create/verify/unlock — locks verify is a
 *   WRITE-authenticate route at the pin, locks.go:216 vs 221 asymmetry);
 * - EVERYTHING else is the ZERO-permission arm ("the key belongs to another
 *   repository, so it grants nothing here" — a foreign repo, or a read-only
 *   key on a write route). Unlike the git-HTTP gate there is NO public/
 *   anonymous arm for the key user (`getDeployKeyRepoPermission` never loads
 *   the anonymous/everyone unit modes), so a foreign key 401s even on a
 *   public repo; the caller renders the family's challenge (existence not
 *   disclosed either way, §2.2).
 *
 * No scope arm and no public-only masking (the key carries no token scope —
 * upstream GetAccessScope returns "" for the key user, so
 * CheckRepoScopedToken skips): the key row IS the grant.
 */
export type LfsDeployKeyDecision = true | "zero-perm" | "archived-write";

export function decideLfsDeployKey(
  op: LfsOp,
  repo: RepositoryRow,
  key: VerifiedDeployKey,
): LfsDeployKeyDecision {
  if (key.repoId !== repo.id) return "zero-perm";
  if (op === "read") return true;
  if (key.mode < 2) return "zero-perm";
  if (repo.isArchived) return "archived-write";
  return true;
}

/**
 * Upstream `DeployKeyUserID` (models/user/user_system.go:51) — every deploy
 * key authenticates as ONE shared synthetic system user (id -3); the KEY's id
 * rides `ExtDoerData` (user_system.go:89-93) and never reaches
 * `ctx.Doer.ID`. Family handlers that attribute rows to the doer (locks
 * ownership) therefore see -3 for deploy-key requests: a lock created via a
 * `gdt_` token carries `owner_id = -3`, which wire-renders as `"lock":null`
 * (no users row — the landed service's nil-owner arm, mirroring upstream's
 * ToLFSLock nil return) and is unlockable by any write-armed key of the same
 * repo (owner match), exactly upstream's behavior.
 */
export const LFS_DEPLOY_KEY_DOER_ID = -3;

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface LfsDeps {
  state: LfsStateService;
  store: LfsStore;
  locks: LfsLockService;
  limits: LfsLimits;
  now: () => Date;
}

/**
 * Production deps: the store mode rides the `LFS_STORE_PRESIGN` env gate
 * (SPEC-0006 §6 as-built — the ledger L14 config wave, 2026-11-03). STRICT
 * polarity: ONLY the exact string "true" constructs `PresignLfsStore` over
 * `RelayLfsStore`, and even then only when the S3 credential triple
 * (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` secrets + `R2_ACCOUNT_ID`
 * var) is complete — an incomplete triple degrades to relay through the
 * §2.3 capability probe, never a throw (this constructor runs per request;
 * upstream's own degrade is the server.go:496-503 fall-through from the
 * ServeDirect link to the relayed one). Unset/anything else = relay,
 * fail-closed: upstream's `ServeDirect()` posture
 * (`modules/setting/storage.go:49,96-98`) translated to a wrangler var,
 * stricter than the old credentials-present auto-default. The vars are read
 * through `LfsStoreEnv` — the type `store.ts` owns — NOT the global `Env`,
 * so this compiles before the orchestrator folds the wrangler.jsonc hunk
 * and picks the declared vars up at `wrangler types`. The handlers stay
 * untouched behind the `LfsStore` capability interface (SPEC-0006 §2.3, §6):
 * a store without the presign capability answers the existing relay degrade.
 */
export function defaultLfsDeps(env: Env): LfsDeps {
  return {
    state: new LfsStateService(env.DB),
    store: createLfsStore(env.REPO_PACKS, lfsStoreConfigFromEnv(env)),
    locks: new LfsLockService(env.DB),
    limits: DEFAULT_LFS_LIMITS,
    now: () => new Date(),
  };
}

/**
 * The gate's LFS branch: resolve the repo, then dispatch to the family. A
 * D1-missing repo (never existed OR renamed — upstream's
 * `GetRepositoryByOwnerAndName`, `models/repo/repo.go:747-763`, never
 * consults the redirect table) is served by THIS family with the upstream
 * repo-missing arms: batch/objects/verify → 404 LFS JSON
 * (`server.go:462-468`), locks → 401 with the route message
 * (`locks.go:51-59` and siblings) — the ledger L9 correction (2026-11-02)
 * that retired the old engine passthrough and the row-13 301 redirect.
 * `engine` stays in the signature only because the gate's call site
 * (git-http/gate.ts) is shared with the non-LFS pipeline.
 */
export async function handleLfsGateBranch(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  engine: DurableGitHandler<Env>,
  lfs: LfsRoute,
): Promise<Response> {
  void engine;
  const resolved = await resolveRepository(env.DB, lfs.owner.toLowerCase(), lfs.repo.toLowerCase());
  return serveLfs(req, env, (p) => ctx.waitUntil(p), lfs, resolved, defaultLfsDeps(env));
}

/** Serve one LFS family request; `resolved === null` = repo missing/renamed. */
export async function serveLfs(
  req: Request,
  env: Env,
  waitUntil: (promise: Promise<void>) => void,
  lfs: LfsRoute,
  resolved: ResolvedLfsRepo | null,
  deps: LfsDeps,
): Promise<Response> {
  // Route-level decisions before auth (upstream: routing first; the §2.1
  // catch-all row carries no auth).
  if (lfs.kind === "not-found") return lfsNotFound();
  if (lfs.kind === "locks") return handleLocks(req, env, waitUntil, lfs, resolved, deps);

  try {
    switch (lfs.kind) {
      case "batch":
        return await handleBatch(req, env, waitUntil, lfs, resolved, deps);
      case "verify":
        return await handleVerify(req, env, waitUntil, lfs, resolved, deps);
      case "upload":
        return await handleUpload(req, env, waitUntil, lfs, resolved, deps);
      case "download":
        return await handleDownload(req, env, waitUntil, lfs, resolved, deps);
    }
  } catch (error) {
    // Store/D1 failures: upstream answers `writeStatus(500)` with the LFS JSON
    // shape (§2.3 verify notes) — never a raw crash page inside the family.
    console.error(
      `[lfs] ${lfs.owner}/${lfs.repo} ${lfs.kind}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return lfsError(500);
  }
  // Unreachable via parseLfsRoute (locks/not-found are answered above);
  // defensive tail for hand-built routes.
  return lfsNotFound();
}

// ---------------------------------------------------------------------------
// Batch (§2.2)
// ---------------------------------------------------------------------------

/**
 * Batch bodies are JSON envelopes, but the endpoint takes unauthenticated
 * input: cap the read instead of trusting the client (the per-batch object
 * cap alone cannot bound a hostile body). 10 MiB is orders of magnitude above
 * any legitimate batch (100 objects × ~200 B).
 */
export const LFS_BATCH_BODY_MAX_BYTES = 10 * 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds the batch cap");
    this.name = "BodyTooLargeError";
  }
}

/** Stream the request body to a string with a hard cap (AGENTS.md: never an
 *  unbounded `await req.text()`). Shared with the locks handlers (§2.7). */
export async function readBodyCapped(req: Request, cap: number): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number.parseInt(declared, 10) > cap) throw new BodyTooLargeError();
  if (req.body === null) return "";
  let total = 0;
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > cap) throw new BodyTooLargeError();
      controller.enqueue(chunk);
    },
  });
  return new Response(req.body.pipeThrough(counting)).text();
}

async function handleBatch(
  req: Request,
  env: Env,
  waitUntil: (promise: Promise<void>) => void,
  lfs: LfsRoute,
  resolved: ResolvedLfsRepo | null,
  deps: LfsDeps,
): Promise<Response> {
  // Upstream `CheckAcceptMediaType` (batch + verify only; §4.9).
  if (!acceptsLfsMediaType(req.headers.get("accept"))) return lfsError(415);

  let text: string;
  try {
    text = await readBodyCapped(req, LFS_BATCH_BODY_MAX_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return lfsError(413);
    throw error;
  }
  let request;
  try {
    request = parseBatchRequest(text);
  } catch (error) {
    if (error instanceof BatchRequestError) return lfsError(error.status, error.message);
    throw error;
  }

  // Upstream order (server.go:212-217): the repo lookup (404, LFS JSON) runs
  // after the decode/operation arms and before both auth and the batch cap —
  // a nonexistent or renamed repo 404s here (L9).
  if (resolved === null) return lfsError(404);

  // `upload` op mutates (rows + hrefs), `download` only reads (§2.1 table).
  const decision = await authorizeLfs({
    req,
    env,
    waitUntil,
    op: request.operation === "upload" ? "write" : "read",
    repo: resolved.repo,
    owner: resolved.owner,
    ownerVisibility: resolved.ownerVisibility,
  });
  if (decision !== true) return decision;

  // Upstream's object-count cap runs AFTER authentication (server.go:219-222;
  // the ledger L10 correction — it used to ride the pre-auth parse). The body
  // cap above stays pre-auth out of necessity: the endpoint takes
  // unauthenticated input and Workers must bound the read (documented
  // divergence — upstream decodes an unbounded body before auth too).
  if (deps.limits.maxBatchSize > 0 && (request.objects?.length ?? 0) > deps.limits.maxBatchSize) {
    return lfsError(413);
  }

  const objects = await shapeBatchResponse(request, shapingContext(req, lfs, resolved), {
    state: deps.state,
    store: deps.store,
    limits: deps.limits,
    now: deps.now(),
  });
  // `{"objects":null}` for a missing/null request key — upstream's
  // BatchResponse.Objects carries no omitempty, so its nil slice marshals as
  // null (shared.go:49-52; the ledger L11 correction). Compact body, no
  // trailing newline — the pin's jsonv2 `MarshalWrite` (same wire discipline
  // as `lfsError` / the locks family).
  return new Response(JSON.stringify({ objects: request.objects === null ? null : objects }), {
    status: 200,
    headers: { "content-type": LFS_MEDIA_TYPE },
  });
}

function shapingContext(req: Request, lfs: LfsRoute, resolved: ResolvedLfsRepo): BatchShapingContext {
  return {
    repoId: lfsRepoId(resolved.repo.id),
    storageKey: resolved.repo.storageKey,
    owner: lfs.owner,
    repo: lfs.repo,
    origin: new URL(req.url).origin,
    authHeader: req.headers.get("authorization"),
  };
}

/**
 * Numeric repo key for `lfs_objects.repo_id` — the landed state service is
 * typed `number` (DDL: INTEGER) while `repositories.id` is a uuid string.
 * Derived deterministically from the uuid's first 13 hex chars (52 bits,
 * float64-safe); v4-uuid collisions are improbable. TODO(drizzle migration):
 * make `lfs_objects.repo_id` a TEXT reference to `repositories.id` when the
 * table moves into schema.ts and drop this bridge.
 */
export function lfsRepoId(repoUuid: string): number {
  return Number.parseInt(repoUuid.replaceAll("-", "").slice(0, 13), 16);
}

// ---------------------------------------------------------------------------
// Upload (§2.3 relay PUT)
// ---------------------------------------------------------------------------

async function handleUpload(
  req: Request,
  env: Env,
  waitUntil: (promise: Promise<void>) => void,
  lfs: LfsRoute,
  resolved: ResolvedLfsRepo | null,
  deps: LfsDeps,
): Promise<Response> {
  // Pointer-from-path validation before auth (upstream order, server.go:309-321;
  // the ledger L12 correction, 2026-11-02): the size segment parses with Go
  // strconv.ParseInt(…, 10, 64) semantics and the failure arm answers 422 with
  // the Go NumError text; the IsValid arm answers writeStatus(422) — the bare
  // status text. Upstream FORGETS to return after the parse-failure 422 and
  // continues into auth + row insert with size 0 (the missing-return bug at
  // server.go:311-313); we do NOT replicate it — a failed parse is terminal
  // here (documented divergence, SPEC-0006 §2.3).
  const oid = lfs.oid ?? "";
  const rawSize = lfs.arg ?? "";
  const parsedSize = goParseInt64(rawSize);
  if (parsedSize.errorClass !== null) {
    return lfsError(422, goParseInt64ErrorText(rawSize, parsedSize.errorClass));
  }
  const size = Number(parsedSize.value);
  if (!isValidPointerFields(oid, size)) return lfsError(422); // "Unprocessable Entity"

  // Upstream getAuthenticatedRepository (server.go:462-468): the repo lookup
  // follows the pointer arms and precedes auth — a nonexistent or renamed
  // repo 404s with the LFS JSON envelope (L9).
  if (resolved === null) return lfsError(404);

  const decision = await authorizeLfs({
    req,
    env,
    waitUntil,
    op: "write",
    repo: resolved.repo,
    owner: resolved.owner,
    ownerVisibility: resolved.ownerVisibility,
  });
  if (decision !== true) return decision;

  // The store's streaming put needs a known length to enforce the declared
  // size (FixedLengthStream discipline); git-lfs basic always sends one →
  // 411 otherwise (SPEC-0006 §2.3).
  if (req.headers.get("content-length") === null) return lfsError(411);

  const repoId = lfsRepoId(resolved.repo.id);
  const key = lfsKey(resolved.repo.storageKey, oid);
  const now = deps.now();

  // Upstream skip (server.go:328-358): bytes present AND a row linked to this
  // repo → skip the body check ENTIRELY — no size comparison (against the URL
  // or the stat), no re-hash, and the row is NOT refreshed (the ledger L6
  // correction, 2026-11-02: the old re-hash-and-refresh arm diverged from both
  // upstream and SPEC-0006 §2.3's "row exists ⇒ skip"). Present without a row,
  // or bytes absent: stream the body through the hash-and-forward put — the
  // re-hash is the proof of possession (upstream hashes-only; our put lands
  // the same hash-verified bytes under the content-addressed key).
  const [row, stat] = await Promise.all([deps.state.get(repoId, oid), deps.store.head(key)]);
  if (row !== null && stat !== null) {
    return lfsError(200); // upstream writeStatus(200): LFS JSON {"message":"OK"}
  }

  try {
    await deps.store.put(key, req.body ?? new Uint8Array(0), { size, expectedSha256Hex: oid });
  } catch (error) {
    if (error instanceof LfsHashMismatchError || error instanceof LfsSizeMismatchError) {
      // The store already deleted the object (mismatch ⇒ no bytes left).
      return lfsError(422, error.message);
    }
    throw error;
  }
  // NewLFSMetaObject insert-if-absent (models/git/lfs.go:106-119): the row
  // arises HERE — upstream's only row creator (server.go:369; the ledger L5
  // correction) — and an existing row is never refreshed. A fresh row stays
  // `uploading` until verify (or adopt/sweep) promotes it (§3.3).
  await deps.state.insertUploadingIfAbsent(repoId, oid, size, now);
  return lfsError(200);
}

// ---------------------------------------------------------------------------
// Verify (§2.3)
// ---------------------------------------------------------------------------

async function handleVerify(
  req: Request,
  env: Env,
  waitUntil: (promise: Promise<void>) => void,
  lfs: LfsRoute,
  resolved: ResolvedLfsRepo | null,
  deps: LfsDeps,
): Promise<Response> {
  // Upstream `CheckAcceptMediaType` (§4.9).
  if (!acceptsLfsMediaType(req.headers.get("accept"))) return lfsError(415);

  // Upstream decodeJSON failure → 422 (not 400) on this route; bodies are
  // ~100 bytes — the cap only bounds hostile input.
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBodyCapped(req, 4096)) as unknown;
  } catch {
    return lfsError(422);
  }
  if (typeof parsed !== "object" || parsed === null) return lfsError(422);
  const pointer = parsed as { oid?: unknown; size?: unknown };
  if (typeof pointer.oid !== "string" || typeof pointer.size !== "number") return lfsError(422);
  const { oid, size } = pointer;
  if (!isValidPointerFields(oid, size)) return lfsError(422, "Oid or size are invalid");

  // Upstream getAuthenticatedMeta order (server.go:440-457): pointer
  // validation → repo lookup (404) → auth (L9).
  if (resolved === null) return lfsError(404);

  const decision = await authorizeLfs({
    req,
    env,
    waitUntil,
    op: "write",
    repo: resolved.repo,
    owner: resolved.owner,
    ownerVisibility: resolved.ownerVisibility,
  });
  if (decision !== true) return decision;

  const repoId = lfsRepoId(resolved.repo.id);
  const stat = await deps.store.head(lfsKey(resolved.repo.storageKey, oid));
  // Relay mode verifies existence + size; presign mode additionally requires
  // the stored checksum to equal the oid (§2.3 verify notes).
  if (!validateAdoptStat(stat, oid, size, { requireChecksum: deps.store.mode === "presign" })) {
    return lfsError(404);
  }

  // Flip `uploading → verified`; a missing row adopts (§3.3 self-heal for a
  // lost batch row write, §4.13).
  if (!(await deps.state.markVerified(repoId, oid, deps.now()))) {
    await deps.state.insertVerified(repoId, oid, size, deps.now());
  }
  return lfsError(200);
}

// ---------------------------------------------------------------------------
// Download (§2.3 relay GET)
// ---------------------------------------------------------------------------

interface ParsedRange {
  offset: number;
  /** Inclusive end byte (for Content-Range). */
  end: number;
  length: number;
}

/** Upstream `rangeHeaderRegexp` (`bytes=(\d+)-(\d*)`) + its status handling. */
function parseRange(header: string | null, size: number): ParsedRange | "unsatisfiable" | null {
  if (header === null) return null;
  const match = /^bytes=(\d+)-(\d*).*$/.exec(header);
  if (match === null) return null;
  const from = Number.parseInt(match[1] as string, 10);
  if (from >= size) return "unsatisfiable";
  let to = size - 1;
  const rawTo = match[2];
  if (rawTo !== undefined && rawTo !== "") {
    const candidate = Number.parseInt(rawTo, 10);
    if (candidate >= from && candidate < to) to = candidate;
  }
  return { offset: from, end: to, length: to + 1 - from };
}

/** base64url (no padding) segment decode; null ⇒ param ignored (§4.14). */
function decodeFilenameSegment(raw: string): string | null {
  if (raw === "" || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const padded = `${raw}${"=".repeat((4 - (raw.length % 4)) % 4)}`;
  try {
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** `mime.FormatMediaType(type, {filename})` equivalent (upstream
 *  `EncodeContentDispositionAttachment` / `EncodeContentDispositionInline`,
 *  content_disposition.go:38-44 over :47-54): quoted string for safe printable
 *  ascii, RFC 5987 `filename*` for anything else. Exported for the presign
 *  arms: upstream's ServeDirect URLs carry the SAME shape as the
 *  `response-content-disposition` query param (file.go:186-190 /
 *  download.go:46-54 / server.go:504-507 — all three presign
 *  `EncodeContentDispositionInline` via prepareServeDirectOptions,
 *  storage.go:66-82), so the callers pass `type: "inline"`. */
export function contentDisposition(filename: string, type: "attachment" | "inline" = "attachment"): string {
  if (/^[\x20-\x7e]+$/.test(filename) && !/["\\]/.test(filename)) {
    return `${type}; filename="${filename}"`;
  }
  const encoded = [...new TextEncoder().encode(filename)]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
  return `${type}; filename*=utf-8''${encoded}`;
}

async function handleDownload(
  req: Request,
  env: Env,
  waitUntil: (promise: Promise<void>) => void,
  lfs: LfsRoute,
  resolved: ResolvedLfsRepo | null,
  deps: LfsDeps,
): Promise<Response> {
  // `getAuthenticatedMeta` order (server.go:440-457): pointer validation (422)
  // → repo lookup (404, L9) → auth → row (404).
  const oid = lfs.oid ?? "";
  if (!isValidPointerFields(oid, 0)) return lfsError(422, "Oid or size are invalid");
  if (resolved === null) return lfsError(404);

  const decision = await authorizeLfs({
    req,
    env,
    waitUntil,
    op: "read",
    repo: resolved.repo,
    owner: resolved.owner,
    ownerVisibility: resolved.ownerVisibility,
  });
  if (decision !== true) return decision;

  const repoId = lfsRepoId(resolved.repo.id);
  const meta = await deps.state.get(repoId, oid);
  if (meta === null) return lfsError(404);

  const range = parseRange(req.headers.get("range"), meta.size);
  if (range === "unsatisfiable") return lfsError(416);

  const content = await deps.store.get(
    lfsKey(resolved.repo.storageKey, oid),
    range === null ? {} : { range: { offset: range.offset, length: range.length } },
  );
  if (content === null) return lfsError(404); // row but object gone (GC race)

  const servedLength = range === null ? meta.size : range.length;
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    // Parity header: protects the length against reverse proxies/compression
    // (server.go:172-173); carries the served byte count, range included.
    "x-gitea-lfs-content-length": String(servedLength),
    "content-length": String(servedLength),
    ...(range !== null
      ? {
          "content-range": `bytes ${range.offset}-${range.end}/${meta.size}`,
          "access-control-expose-headers": "Content-Range",
        }
      : {}),
  };
  if (lfs.arg !== null) {
    const filename = decodeFilenameSegment(lfs.arg);
    if (filename !== null) {
      headers["content-disposition"] = contentDisposition(filename);
      headers["access-control-expose-headers"] = "Content-Disposition";
    }
  }
  // FixedLengthStream makes the declared length authoritative for the
  // streamed body (a short R2 read fails the pipe instead of hanging).
  const body = content.body.pipeThrough(new FixedLengthStream(servedLength));
  return new Response(body, { status: range === null ? 200 : 206, headers });
}
