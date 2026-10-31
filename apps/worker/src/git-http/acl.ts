/**
 * Git-HTTP ACL gate — SPEC-0003 §2.4 matrix over D1-resolved repositories.
 *
 * Pipeline stage order follows upstream `httpBase`
 * (gitea/routers/web/repo/githttp.go:62-261):
 *   credentials → failure limiter → deploy-token verify (upstream's
 *   DeployToken method, registered on the git routes before Basic,
 *   web.go:135-136) → token verify → scope check (row 7) →
 *   doer account status (row 11) → owner account status → repo grants
 *   (rows 8/9) → push-create (rows 15-20, SPEC-0003 M3).
 *
 * Conventions (SPEC-0003 §2.4, SPEC-0002 §2.6): unauthenticated → 401 Basic
 * challenge; authenticated-but-ungrantable on an invisible repo → 404
 * "Repository not found"; defective credential or missing scope → plain 403.
 *
 * Transitional M1 note: this layer runs ONLY when the repositories D1 row
 * exists. Rows missing from D1 pass through to the engine untouched (see
 * gate.ts, TODO(SPEC-0003 M3)) until repo lifecycle lands.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { GitHttpOp } from "./parse";
import {
  accountDisabled,
  basicChallenge,
  ownerUnavailable,
  rateLimited,
  repositoryArchived,
  repositoryNotFound,
  scopeForbidden,
} from "./respond";
import { D1FailureLimiter } from "../auth/failure-limiter";
import {
  limiterCheckFailOpen,
  limiterRecordFailureFailOpen,
  limiterResetFailOpen,
} from "../auth/middleware";
import { basicAuthTokenCandidate, parseAuthorizationHeader } from "../auth/httpauth";
import { oauth2FeatureEnabled } from "../services/oauth2/token";
import { ScopeSet } from "../auth/scopes";
import { TokenService, type VerifiedAuth } from "../auth/token-service";
import {
  DEPLOY_TOKEN_PREFIX,
  needsDeployKeyLastUsedTouch,
  touchDeployKeyLastUsed,
  verifyDeployToken,
  type VerifiedDeployKey,
} from "../auth/deploy-token-service";
import type { AuthUser } from "../auth/auth-context";
import type { TeamAccessMode } from "../db/schema";
import { repoUnits, repositories, users } from "../db/schema";
// The gate consults the same repository-service predicates as the API
// visibility layer (SPEC-0007 §3.5 + SPEC-0005): one grant resolution
// (org/team arms + the collaborator row), no drift.
import { doerRepoAccessMode } from "../api/services/repository";

type RepositoryRow = typeof repositories.$inferSelect;

/** repositories ⋈ users on the owner namespace, both sides case-folded
 *  (§2.1 item 4: `(owner, lower_name)` lookup; §4.5 case-insensitivity).
 *  LEFT JOIN so an orphaned repo row (owner user gone) resolves as
 *  "exists but invisible" instead of "missing" (which would pass through to
 *  the engine). Also returns the owner's `visibility` (SPEC-0003 §2.5.6,
 *  upstream VisibleType) — it lives on the joined users row, not on the
 *  SPEC-0002 AuthUser projection. */
export async function resolveRepository(
  d1: D1Database,
  ownerLower: string,
  repoLower: string,
): Promise<{ repo: RepositoryRow; owner: AuthUser | null; ownerVisibility: "public" | "limited" | "private" } | null> {
  const db = drizzle(d1);
  const row = await db
    .select({ repo: repositories, owner: users })
    .from(repositories)
    .leftJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(and(eq(repositories.ownerNamespace, ownerLower), eq(repositories.slug, repoLower)))
    .get();
  if (row === undefined) return null;
  const owner = row.owner;
  return {
    repo: row.repo,
    ownerVisibility: owner?.visibility ?? "private",
    owner:
      owner === null
        ? null
        : {
            id: owner.id,
            username: owner.username,
            usernameLower: owner.usernameLower,
            email: owner.email,
            displayName: owner.displayName,
            location: owner.location,
            website: owner.website,
            description: owner.description,
            isAdmin: owner.isAdmin,
            status: owner.status,
            createdAt: owner.createdAt,
          },
  };
}

/**
 * ACL rows 4/5: the code unit's anonymous access grant (SPEC-0003 §3.1,
 * upstream `RepoUnit.AnonymousAccessMode`). Only meaningful for private
 * repositories — a public repo is anonymous-readable anyway (row 1).
 */
export async function codeUnitAnonymousRead(d1: D1Database, repoId: string): Promise<boolean> {
  const db = drizzle(d1);
  const unit = await db
    .select({ anonymousAccessMode: repoUnits.anonymousAccessMode })
    .from(repoUnits)
    .where(and(eq(repoUnits.repoId, repoId), eq(repoUnits.type, "code")))
    .get();
  return unit?.anonymousAccessMode === "read";
}

/**
 * The request credential, if any: the bearer token, or the Basic password
 * (token-as-password, SPEC-0002 §2.5). Shared by the ACL matrix and the
 * push-create interceptor so both read credentials identically.
 */
export function requestCredential(req: Request): string | null {
  const header = req.headers.get("authorization");
  const parsed = header === null ? null : parseAuthorizationHeader(header);
  return parsed?.bearerToken?.token ?? (parsed?.basicAuth ? basicAuthTokenCandidate(parsed.basicAuth) : null);
}

/** Case-folded user lookup for the push-create namespace resolution (rows
 *  16-20: site-admin create into an existing active user's namespace). */
export async function userByUsernameLower(
  d1: D1Database,
  usernameLower: string,
): Promise<{ id: number; usernameLower: string; status: "active" | "prohibited" } | null> {
  const db = drizzle(d1);
  const row = await db
    .select({ id: users.id, usernameLower: users.usernameLower, status: users.status })
    .from(users)
    .where(eq(users.usernameLower, usernameLower))
    .get();
  return row ?? null;
}

export interface GitHttpAclInput {
  req: Request;
  env: Env;
  /** Background-work sink for limiter reset + `last_used_at` touch. */
  waitUntil: (promise: Promise<void>) => void;
  op: GitHttpOp;
  repo: RepositoryRow;
  owner: AuthUser | null;
  /** Owner visibility (§2.5.6); 'private' when the owner row is gone. */
  ownerVisibility: "public" | "limited" | "private";
  /** Rows 4/5: the private repo's code unit grants anonymous read. */
  unitAnonymousRead: boolean;
  /** The request targets an engine-shape ADMIN surface (PUT config, POST gc,
   *  DELETE root — the §2.1 widening's write rows). A deploy key reaches GIT
   *  DATA only — upstream's key user holds just the code+wiki units
   *  (repo_permission.go:404) and no admin API surface — so the
   *  deploy-token arm refuses these shapes regardless of mode. */
  engineAdmin?: boolean;
}

/**
 * Decide the request against ACL matrix rows 1-14. Returns `true` to invoke
 * the engine, or the matrix Response to send instead. Never throws for
 * authz outcomes; D1 failures while verifying a credential fail closed (500,
 * SPEC-0002 §4.5 "never fail open"). The failure limiter is the one
 * deliberate exception: its calls fail open (ef2c049) — brute-force
 * protection must not break the git transport it guards.
 */
export async function authorizeGitHttp(input: GitHttpAclInput): Promise<Response | true> {
  const { req, env, op, repo, owner } = input;

  const header = req.headers.get("authorization");
  const parsed = header === null ? null : parseAuthorizationHeader(header);
  // The two credential carriers, kept apart: a Bearer token and a Basic
  // candidate flow through different upstream methods. The deploy-token
  // method parses ONLY the Basic header (basic.go parseAuthBasic:44-68), so
  // a `Bearer gdt_…` is not a deploy credential; the Basic candidate (the
  // username when the password is empty/`x-oauth-basic`, else the password)
  // is what both the deploy-token and the access-token arms try.
  const bearerToken = parsed?.bearerToken?.token ?? null;
  const basicCandidate = parsed?.basicAuth ? basicAuthTokenCandidate(parsed.basicAuth) : null;
  // The access-token arm's candidate (Bearer preferred, else the Basic
  // candidate) — non-null exactly when at least one carrier is present,
  // which the guard below narrows.
  const credential = bearerToken ?? basicCandidate;

  if (credential !== null) {
    // Credential-testing path only; anonymous requests have nothing to
    // brute-force (mirrors SPEC-0002 resolveAuth).
    const now = new Date();
    const limiter = new D1FailureLimiter(env.DB);
    const ip =
      req.headers.get("cf-connecting-ip") ??
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    const verdict = await limiterCheckFailOpen(limiter, ip, now);
    if (verdict.blocked) return rateLimited(verdict.retryAfterSeconds);

    // Deploy-token arm — BEFORE the access-token verify, upstream's group
    // order on the git routes ("before Basic, which would try the token as
    // a password", web.go:135-136). Upstream's VerifyDeployKeyToken prefix
    // gate makes this a no-op for every non-`gdt_` Basic credential, and a
    // miss here falls through to the access-token arm exactly like
    // upstream's "not a deploy token, let the other methods try"
    // (deploy_token.go:36).
    if (basicCandidate !== null && basicCandidate.startsWith(DEPLOY_TOKEN_PREFIX)) {
      let key: VerifiedDeployKey | null;
      try {
        key = await verifyDeployToken(env.DB, basicCandidate);
      } catch {
        // D1 unavailable mid-request: git HTTP plain 500, never fail open.
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
        return decideDeployKey(op, repo, owner, input.ownerVisibility, input.engineAdmin === true, key);
      }
    }

    let verified: VerifiedAuth | null;
    try {
      verified = await new TokenService(env.DB).verify(credential, { now });
    } catch {
      // D1 unavailable mid-request: git HTTP plain 500, never fail open.
      return new Response("internal server error\n", {
        status: 500,
        headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" },
      });
    }
    if (verified === null) {
      // Unknown/revoked/expired/malformed credential → 401 challenge
      // (identity not established; §2.4 edge 4.14). Upstream answers the
      // failed-credential arm at the SAME challenge site (githttp.go:146-159
      // — !ctx.IsSigned), so the realm follows the OAuth2 switch here too.
      input.waitUntil(limiterRecordFailureFailOpen(limiter, ip, now));
      return basicChallenge(oauth2FeatureEnabled(env));
    }

    const scope = ScopeSet.parseLenient(verified.token.scopes);
    input.waitUntil(limiterResetFailOpen(limiter, ip));
    input.waitUntil(
      new TokenService(env.DB).needsLastUsedTouch(verified.token, now)
        ? new TokenService(env.DB).touchLastUsed(verified.token.id, now)
        : Promise.resolve(),
    );
    // SPEC-0007 §3.5 + SPEC-0005: the doer's resolved grant over the repo
    // (`max` of the Owners-team bridge + covering teams and the
    // `repo_collaborators` row's mode — the same repository-service
    // predicate the API visibility layer resolves; 'none' when the doer
    // holds no grant).
    const teamMode = await doerRepoAccessMode(env.DB, { id: repo.id, ownerId: repo.ownerId }, verified.user.id);
    return decide(op, repo, owner, input.ownerVisibility, input.unitAnonymousRead, verified.user, scope, teamMode, oauth2FeatureEnabled(env));
  }

  return decide(op, repo, owner, input.ownerVisibility, input.unitAnonymousRead, null, null, "none", oauth2FeatureEnabled(env));
}

/**
 * The read-grant predicate shared by the git-HTTP matrix and the UI page
 * resolution (SPEC-0010 §2.6 — exactly one copy, so page visibility and
 * git-HTTP visibility cannot drift): the gate's own grant lines
 * (`publiclyVisible`, isOwner, isSiteAdmin, the limited-owner branch) plus
 * the resolved grant (`teamMode`, the repository-service
 * `doerRepoAccessMode` fold — SPEC-0007 §3.5 org/team arms and, since
 * SPEC-0005, the active collaborator row's mode: any row grants read).
 * `doer === null` is the anonymous doer — matrix row 1's collapse verbatim.
 * Owner-account status is NOT part of this predicate: git-HTTP refuses a
 * prohibited owner separately (below, 403 shape) and pages treat a missing
 * or prohibited owner as invisible for every viewer (repo-view.ts, §4.8,
 * 404-shell shape) — the boolean refusal is the same on both surfaces.
 */
export function readGrant(input: {
  repoVisibility: "public" | "private";
  owner: { id: number; status: "active" | "prohibited" } | null;
  ownerVisibility: "public" | "limited" | "private";
  doer: { id: number; isAdmin: boolean } | null;
  teamMode?: TeamAccessMode | null;
}): boolean {
  const ownerActive = input.owner !== null && input.owner.status === "active";
  const repoPublic = input.repoVisibility === "public";
  const publiclyVisible = repoPublic && ownerActive && input.ownerVisibility === "public";
  if (input.doer === null) return publiclyVisible;
  const isOwner = input.owner !== null && input.doer.id === input.owner.id;
  const isSiteAdmin = input.doer.isAdmin;
  const teamGranted = input.teamMode !== undefined && input.teamMode !== null && input.teamMode !== "none";
  return (
    publiclyVisible ||
    isOwner ||
    isSiteAdmin ||
    teamGranted ||
    (repoPublic && ownerActive && input.ownerVisibility === "limited")
  );
}

/**
 * The matrix. `doer === null` is the anonymous doer; `scope === null` only
 * alongside it. `teamMode` is the authenticated doer's resolved grant
 * (SPEC-0007 §3.5 org/team arms + SPEC-0005 collaborator row, resolved by
 * `authorizeGitHttp` from the shared repository-service predicate) — 'none'
 * when anonymous. `oauth2Enabled` selects the 401 challenge's realm (the
 * pin's OAuth2 switch, githttp.go:146-159 — SPEC specs/oauth2-provider.md
 * §2.11's flip). See the table in SPEC-0003 §2.4.
 */
function decide(
  op: GitHttpOp,
  repo: RepositoryRow,
  owner: AuthUser | null,
  ownerVisibility: "public" | "limited" | "private",
  unitAnonymousRead: boolean,
  doer: AuthUser | null,
  scope: ScopeSet | null,
  teamMode: TeamAccessMode,
  oauth2Enabled: boolean,
): Response | true {
  // Visibility model (§2.5.6): repo `visibility` × owner `users.visibility`.
  // Row 1: public repo + active PUBLIC owner. Row 2's limited/private-owner
  // branches arrive with the M2 `users.visibility` column: a limited owner's
  // public repos are authenticated-only, a private owner's are owner/admin-only.
  const ownerShape = owner === null ? null : { id: owner.id, status: owner.status };
  const publiclyVisible = readGrant({
    repoVisibility: repo.visibility,
    owner: ownerShape,
    ownerVisibility,
    doer: null,
  });
  // Rows 4/5: an explicit anonymous-read grant on the private repo's code
  // unit (upstream git_smart_http_test.go:163-189) — read only, and still
  // requires a public, active owner.
  const anonymousUnitRead =
    op === "read" && unitAnonymousRead && owner !== null && owner.status === "active" && ownerVisibility === "public";

  if (doer === null) {
    if (anonymousUnitRead || (op === "read" && publiclyVisible)) return true;
    // Rows 2/3/5: every other anonymous request challenges — pushes always
    // need identity, and unit read never grants write (test :184). The
    // realm follows the pin's OAuth2 switch (githttp.go:146-159).
    return basicChallenge(oauth2Enabled);
  }

  // Row 7: known token lacking the repository-category scope for the op
  // (CheckRepoScopedToken, plain 403; write implies read via the bitmap).
  const required = op === "read" ? "read:repository" : "write:repository";
  if (scope === null || !scope.has(required)) return scopeForbidden();

  // Row 11: disabled/prohibited doer (checked after the scope, like upstream).
  if (doer.status === "prohibited") return accountDisabled();

  // Upstream httpBase also refuses when the repo's OWNER is inactive
  // (githttp.go:117-119) — applies to every caller, owner included.
  if (owner !== null && owner.status === "prohibited") return ownerUnavailable();

  // Grant lines: { repo owner, site admin } plus the resolved grant (the
  // SPEC-0007 §3.5 org arms — the Owners-team bridge + covering teams — and,
  // since SPEC-0005, the active `repo_collaborators` row: any mode grants
  // read; `teamMode` flows through the shared readGrant predicate). Row 8's
  // read-only-collaborator variant landed WITH the fold: a read-mode
  // collaborator passes canRead but not the teamWrites rank below.
  const isOwner = owner !== null && doer.id === owner.id;
  const isSiteAdmin = doer.isAdmin;

  // Row 9 (+ §2.5.6 visibility three-way): no read grant on an invisible
  // repo → 404, existence hidden. Limited owners expose their public repos
  // to any authenticated principal; private owners only to owner/admin.
  // The grant lines are the shared readGrant predicate (SPEC-0010 §2.6).
  const canRead = readGrant({
    repoVisibility: repo.visibility,
    owner: ownerShape,
    ownerVisibility,
    doer: { id: doer.id, isAdmin: doer.isAdmin },
    teamMode,
  });
  // Public-only tokens (SPEC-0002 §4.1) see exactly what anonymous visitors
  // could: a limited owner's public repo stays masked — and a team grant is
  // masked with it (anonymous-equivalent tokens hold no org grants).
  const maskedByPublicOnly = scope.publicOnly && !publiclyVisible;
  if (!canRead || maskedByPublicOnly) return repositoryNotFound();

  if (op === "write") {
    // Row 10: archived repos refuse pushes (upstream :124-128 message text);
    // clones keep working — the check only gates the write path.
    if (repo.isArchived) return repositoryArchived();
    // Row 8: visible but no write grant → 404 (write capability hidden).
    // Write ranks at write/admin/owner mode (access_mode.go:17–22 ranking)
    // on the resolved grant — an org team OR the SPEC-0005 collaborator row
    // (a read-mode collaborator stays read-only).
    const teamWrites = teamMode === "write" || teamMode === "admin" || teamMode === "owner";
    if (!isOwner && !isSiteAdmin && !teamWrites) return repositoryNotFound();
  }

  return true;
}

/**
 * The deploy-token decision — upstream's synthetic key user, whose ONLY
 * permission is getDeployKeyRepoPermission (repo_permission.go:387-409): the
 * code+wiki units of the key's OWN repository at the key's `mode`. The
 * matrix arms, in the landed order:
 *
 * - owner unavailable (githttp.go:117-119, every caller) → 403;
 * - an engine-shape admin surface, or a repo other than the key's → 404
 *   "Repository not found" — the zero-perm 404 (:197-200: the key "belongs
 *   to another repository, so it grants nothing here"), existence masked;
 * - READ: publicly visible (upstream's canAnonymousPull arm admits ANY
 *   signed-in doer's pull on a public repo with a public owner,
 *   :132-135 — the key user included) OR the key's own repo (mode 1 and 2
 *   both satisfy read). The key user deliberately does NOT take the
 *   authenticated-limited-owner read line the user matrix grants: upstream's
 *   key permission model has no such arm — a limited owner's public repo
 *   stays beyond a foreign key.
 * - WRITE: the key's own repo at mode >= 2 — mode 1 → 404 (row 8's
 *   write-capability masking, :197-199) — then the archived refusal (row
 *   10). The gate's mirror-readonly 403 still runs after the matrix
 *   (SPEC-0009 row 21).
 *
 * No scope arm (deploy keys carry no token scope — upstream GetAccessScope
 * returns "" for the key user, so CheckRepoScopedToken skips) and no
 * public-only masking (no scope to hold it): the key row IS the grant.
 */
function decideDeployKey(
  op: GitHttpOp,
  repo: RepositoryRow,
  owner: AuthUser | null,
  ownerVisibility: "public" | "limited" | "private",
  engineAdmin: boolean,
  key: VerifiedDeployKey,
): Response | true {
  if (owner !== null && owner.status === "prohibited") return ownerUnavailable();
  if (engineAdmin || owner === null) return repositoryNotFound();

  if (op === "read") {
    // Any signed-in doer's pull on a public repo with a public owner is
    // served (:132-135) — a foreign key included; the key's own repo at
    // mode >= read (both stored modes) covers everything else. A foreign
    // key on a private/limited-visible repo grants nothing → the 404.
    const publiclyVisible =
      repo.visibility === "public" && owner.status === "active" && ownerVisibility === "public";
    if (publiclyVisible || key.repoId === repo.id) return true;
    return repositoryNotFound();
  }

  // Write: the key's own repo at write mode — a foreign repo or a read-only
  // key takes the row-8 404 (write capability hidden), an own-repo write
  // takes the row-10 archived refusal first.
  if (key.repoId !== repo.id || key.mode < 2) return repositoryNotFound();
  if (repo.isArchived) return repositoryArchived();
  return true;
}
