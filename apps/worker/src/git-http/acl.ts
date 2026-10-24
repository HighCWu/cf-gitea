/**
 * Git-HTTP ACL gate — SPEC-0003 §2.4 matrix over D1-resolved repositories.
 *
 * Pipeline stage order follows upstream `httpBase`
 * (gitea/routers/web/repo/githttp.go:62-261):
 *   credentials → failure limiter → token verify → scope check (row 7) →
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
  repositoryNotFound,
  scopeForbidden,
} from "./respond";
import { D1FailureLimiter } from "../auth/failure-limiter";
import { basicAuthTokenCandidate, parseAuthorizationHeader } from "../auth/httpauth";
import { ScopeSet } from "../auth/scopes";
import { TokenService, type VerifiedAuth } from "../auth/token-service";
import type { AuthUser } from "../auth/auth-context";
import { repositories, users } from "../db/schema";

type RepositoryRow = typeof repositories.$inferSelect;

/** repositories ⋈ users on the owner namespace, both sides case-folded
 *  (§2.1 item 4: `(owner, lower_name)` lookup; §4.5 case-insensitivity).
 *  LEFT JOIN so an orphaned repo row (owner user gone) resolves as
 *  "exists but invisible" instead of "missing" (which would pass through to
 *  the engine). */
export async function resolveRepository(
  d1: D1Database,
  ownerLower: string,
  repoLower: string,
): Promise<{ repo: RepositoryRow; owner: AuthUser | null } | null> {
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
    owner:
      owner === null
        ? null
        : {
            id: owner.id,
            username: owner.username,
            usernameLower: owner.usernameLower,
            email: owner.email,
            displayName: owner.displayName,
            isAdmin: owner.isAdmin,
            status: owner.status,
            createdAt: owner.createdAt,
          },
  };
}

export interface GitHttpAclInput {
  req: Request;
  env: Env;
  /** Background-work sink for limiter reset + `last_used_at` touch. */
  waitUntil: (promise: Promise<void>) => void;
  op: GitHttpOp;
  repo: RepositoryRow;
  owner: AuthUser | null;
}

/**
 * Decide the request against ACL matrix rows 1-14. Returns `true` to invoke
 * the engine, or the matrix Response to send instead. Never throws for
 * authz outcomes; D1 failures while verifying a credential fail closed (500,
 * SPEC-0002 §4.5 "never fail open").
 */
export async function authorizeGitHttp(input: GitHttpAclInput): Promise<Response | true> {
  const { req, env, op, repo, owner } = input;

  const header = req.headers.get("authorization");
  const parsed = header === null ? null : parseAuthorizationHeader(header);
  const credential =
    parsed?.bearerToken?.token ?? (parsed?.basicAuth ? basicAuthTokenCandidate(parsed.basicAuth) : null);

  if (credential !== null) {
    // Credential-testing path only; anonymous requests have nothing to
    // brute-force (mirrors SPEC-0002 resolveAuth).
    const now = new Date();
    const limiter = new D1FailureLimiter(env.DB);
    const ip =
      req.headers.get("cf-connecting-ip") ??
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "unknown";
    const verdict = await limiter.check(ip, now);
    if (verdict.blocked) return rateLimited(verdict.retryAfterSeconds);

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
      // (identity not established; §2.4 edge 4.14).
      input.waitUntil(limiter.recordFailure(ip, now));
      return basicChallenge();
    }

    const scope = ScopeSet.parseLenient(verified.token.scopes);
    input.waitUntil(limiter.reset(ip));
    input.waitUntil(
      new TokenService(env.DB).needsLastUsedTouch(verified.token, now)
        ? new TokenService(env.DB).touchLastUsed(verified.token.id, now)
        : Promise.resolve(),
    );
    return decide(op, repo, owner, verified.user, scope);
  }

  return decide(op, repo, owner, null, null);
}

/**
 * The matrix. `doer === null` is the anonymous doer; `scope === null` only
 * alongside it. See the table in SPEC-0003 §2.4 — rows marked M2 below need
 * columns/settings that land with the lifecycle migration.
 */
function decide(
  op: GitHttpOp,
  repo: RepositoryRow,
  owner: AuthUser | null,
  doer: AuthUser | null,
  scope: ScopeSet | null,
): Response | true {
  // M1 visibility model: repo `is_private` × owner status. The
  // `users.visibility` column (public/limited/private, SPEC-0003 §2.5.6) does
  // not exist yet, so every resolvable owner is treated as public — row 2's
  // "limited/private owner" branch arrives with M2.
  const publiclyVisible = repo.visibility === "public" && owner?.status === "active";

  if (doer === null) {
    // Row 1: anonymous fetch of a public repo under a public owner.
    if (op === "read" && publiclyVisible) return true;
    // Rows 2/3: everything else anonymous challenges. Row 4/5 (anonymous
    // unit-read on a private repo) needs the M2 `repo_units` table.
    return basicChallenge();
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

  // M1 grant model: no collaborator tables exist yet (SPEC-0005), so the
  // grant set is exactly { repo owner, site admin }. Rows 4/5/8's
  // read-only-collaborator variants extend this when collaboration lands.
  const isOwner = owner !== null && doer.id === owner.id;
  const isSiteAdmin = doer.isAdmin;

  // Row 9 (+ public-only masking, SPEC-0002 §4.1): no read grant on an
  // invisible repo → 404, existence hidden.
  const canRead = publiclyVisible || isOwner || isSiteAdmin;
  const maskedByPublicOnly = scope.publicOnly && !publiclyVisible;
  if (!canRead || maskedByPublicOnly) return repositoryNotFound();

  if (op === "write") {
    // Row 10: archived repos refuse pushes. `repositories.is_archived` lands
    // with the SPEC-0003 M2 lifecycle migration; the check site is kept here.
    // if (repo.isArchived) return repositoryArchived();
    // Row 8: visible but no write grant → 404 (write capability hidden).
    if (!isOwner && !isSiteAdmin) return repositoryNotFound();
  }

  return true;
}
