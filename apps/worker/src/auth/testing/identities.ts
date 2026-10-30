/**
 * Multi-identity test rig — the capability the single-stub resolver lacks
 * (wave-36): minting N distinct authenticated identities per test and issuing
 * tokens that resolve to SPECIFIC ones, so permission-matrix arms
 * (stranger-vs-owner-vs-collaborator differentials, multi-user blocking,
 * cross-user visibility) are testable without hand-rolling a resolver per
 * suite (the src/api/collaborators.test.ts pattern, generalized).
 *
 * The rig rides the REAL token-resolution seam: `createIdentityAuthResolver`
 * returns the same `AuthResolver` interface `createApiRouter({ auth })` and
 * the `create*TokenAuthMiddleware` factories consume, so requests still flow
 * header-parse → middleware → `resolveToken` — nothing pre-seeds
 * `c.set("authUser")` or bypasses the chain. Issuance is real too:
 * `seedIdentity` mints through `TokenService` (a real `personal_access_tokens`
 * row), so the produced tokens are indistinguishable from production tokens
 * and remain usable if a suite mounts the real SPEC-0002 `resolveAuth`
 * instead. Resolution itself is the rig's token→identity map layered OVER the
 * default stub: map hits return the mapped identity, every other token
 * delegates to `createStubAuthResolver()` — with no map (or an unmapped
 * token) the behavior is byte-identical to the stock resolver, so adopting
 * suites keep their existing default-token calls working unchanged.
 *
 * Test infra only — never wire into production (same rule as
 * `createStubAuthResolver`).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";

import { STUB_USER, createStubAuthResolver, type AuthResolver } from "../../api/auth";
import type { User } from "../../api/models/user";
import { authUserToApiUser } from "../../api/services/user";
import type { AuthUser } from "../../auth/auth-context";
import { users } from "../../db/schema";
import { mintFor, seedVerifiedUser, type SeedUserOptions } from "./seeds";

/** D1 row of the `users` table (src/db/schema.ts). */
type UserRow = typeof users.$inferSelect;

/**
 * One minted test identity: the seeded D1 user plus a real plaintext token
 * and the contract `User` the rig resolver hands back for that token.
 */
export interface TestIdentity {
  /** The seeded `users` row id. */
  id: number;
  /** Display-cased username (the row's, so ownership checks see the real login). */
  username: string;
  /** Plaintext token — a REAL `TokenService.mint` result (persisted row). */
  token: string;
  /** The contract `User` resolved for `token` (see `identityUserFromRow`). */
  user: User;
}

export interface SeedIdentityOptions extends SeedUserOptions {
  /** Token name — defaults to `rig-<username>`. */
  tokenName?: string;
  /** Token scopes — defaults to `all` (identity arms don't exercise scope gates). */
  tokenScopes?: string;
}

/**
 * The contract-`User` projection the token-identity path applies: the
 * CANONICAL `authUserToApiUser` (api/services/user.ts) — the SAME converter
 * the production auth middlewares' `identityFrom` rides — rendered from the
 * `AuthUser` slice `rowToUser` (auth/token-service.ts) builds, mapped
 * literally from the row. Upstream converts the doer as
 * `ToUser(ctx.Doer, ctx.Doer)` (routers/api/v1/user/userGetCurrent), so the
 * self-viewer shape renders the row's real values through
 * `apiUserFromRow`'s authed arm (truthful is_admin/active/prohibit_login,
 * email, visibility, type, the username compat key, the row-derived URLs) —
 * the old convention-synced copy of the pre-canonical serializer is deleted
 * (it had already drifted: no `username` key, hardcoded "public"/"en-US"/
 * empty URLs while the canonical render grew row-derived values).
 *
 * `origin` is "" — the rig mints outside any request, so avatar/html render
 * the same relative shape the production helper produces when no origin is
 * known (`toApiUser`'s `origin ?? ""` arm, api/auth.ts).
 */
export function identityUserFromRow(row: UserRow): User {
  const authUser: AuthUser = {
    id: row.id,
    username: row.username,
    usernameLower: row.usernameLower,
    email: row.email,
    displayName: row.displayName,
    location: row.location,
    website: row.website,
    description: row.description,
    isAdmin: row.isAdmin,
    status: row.status,
    createdAt: row.createdAt,
    type: row.type,
    visibility: row.visibility,
    numStars: row.numStars,
  };
  return authUserToApiUser(authUser, "");
}

/**
 * Seed a real user row AND mint a real token for it, returning both plus the
 * contract `User` projected from the row. The mint goes through
 * `TokenService` exactly like `mintFor` (real `personal_access_tokens` row,
 * real token shape) — only the API-router resolution step is the rig map.
 */
export async function seedIdentity(options: SeedIdentityOptions): Promise<TestIdentity> {
  const seeded = await seedVerifiedUser(options);
  const tokenName = options.tokenName ?? `rig-${seeded.username}`;
  const minted = await mintFor(seeded.id, tokenName, options.tokenScopes ?? "all");
  const rows = await drizzle(env.DB).select().from(users).where(eq(users.id, seeded.id)).limit(1).all();
  const row = rows[0];
  if (row === undefined) throw new Error(`identity seed failed: user ${seeded.id} not found after insert`);
  return { id: row.id, username: row.username, token: minted.plaintext, user: identityUserFromRow(row) };
}

/**
 * The rig resolver: a token→identity map layered over the stock stub.
 *
 * - a mapped token resolves to its identity (the exact object passed in);
 * - every other token delegates to `createStubAuthResolver()` — i.e. ANY
 *   well-formed token still resolves STUB_USER, the default identity every
 *   existing suite assumes ("the token" = the stub);
 * - with no map (or an empty one) the resolver is behaviorally IDENTICAL to
 *   `createStubAuthResolver()` — the default path is untouched by
 *   construction (it literally delegates to it).
 */
export function createIdentityAuthResolver(identities: Record<string, User> = {}): AuthResolver {
  const fallback = createStubAuthResolver();
  const known = new Map(Object.entries(identities));
  return {
    resolveToken(token) {
      const mapped = known.get(token);
      return mapped !== undefined ? Promise.resolve(mapped) : fallback.resolveToken(token);
    },
  };
}

/** `Authorization` header value carrying an identity's token. */
export function tokenHeader(identity: Pick<TestIdentity, "token">): Record<string, string> {
  return { Authorization: `token ${identity.token}` };
}

/** The default stub identity, re-exported for rig consumers' assertions. */
export { STUB_USER };
