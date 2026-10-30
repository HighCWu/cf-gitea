/**
 * Personal-access-token service — SPEC-0002 §2.1–2.3, §2.7, §3.
 *
 * D1 access goes through Drizzle only (AGENTS.md). Plaintext tokens are
 * never stored: minting returns the value exactly once; verification is a
 * one-row prefix lookup plus a timing-safe digest compare (one D1 read per
 * request, SPEC-0002 §4.4).
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import type { AuthToken, AuthUser } from "./auth-context";
import { sha256Hex, timingSafeDigestEqual } from "./digest";
import {
  EmptyTokenScopeError,
  InvalidTokenScopeError,
  TokenNameExistsError,
  TokenNameTooLongError,
  TokenPrefixCollisionError,
  TokenScopeEscalationError,
} from "./errors";
import { generateToken, tokenLookupPrefix, type GeneratedToken } from "./token-format";
import { enforcePublicOnlyFrom, InvalidScopeError, normalizeScope, ScopeSet } from "./scopes";
import { personalAccessTokens, users } from "../db/schema";

/** SPEC-0002 §4.4: token names are capped at 255 chars. */
export const MAX_TOKEN_NAME_LENGTH = 255;
/** SPEC-0002 §4.4: `last_used_at` is written at most once per 24 h per token. */
export const LAST_USED_THROTTLE_MS = 24 * 60 * 60 * 1000;
/** SPEC-0002 §4.5: prefix-unique violations are retried at most 3 times. */
const PREFIX_RETRY_LIMIT = 3;

export interface MintTokenInput {
  userId: number;
  name: string;
  /** Raw, comma-joined scope string (as assembled from the request body);
   *  normalized here before storage. */
  scopes: string;
  /** cf-gitea extension; null/undefined = never expires. */
  expiresAt?: Date | null;
  now?: Date;
  /** Normalized scope of the authenticating token, when the mint request is
   *  itself token-authenticated. Enables the upstream child-scope and
   *  public-only carry rules (gitea/routers/api/v1/user/app.go:132–149). */
  mintedByScope?: string | null;
}

export interface MintedToken extends AuthToken {
  /** Full opaque token value — returned exactly once, never persisted. */
  plaintext: string;
}

export interface VerifiedAuth {
  token: AuthToken;
  user: AuthUser;
}

export interface TokenPage {
  tokens: AuthToken[];
  total: number;
}

export class TokenService {
  private readonly db: DrizzleD1Database;
  /** Token source; injectable so tests can force prefix collisions. */
  private readonly generate: () => GeneratedToken;

  constructor(d1: D1Database, options?: { tokenGenerator?: () => GeneratedToken }) {
    this.db = drizzle(d1);
    this.generate = options?.tokenGenerator ?? generateToken;
  }

  /**
   * Mint a token. Order of checks mirrors upstream `CreateAccessToken`
   * (gitea/routers/api/v1/user/app.go:90–150) so the 400 precedence matches:
   * duplicate name, then scope normalization, then empty scope.
   */
  async mint(input: MintTokenInput): Promise<MintedToken> {
    const now = input.now ?? new Date();

    if (input.name.length > MAX_TOKEN_NAME_LENGTH) {
      throw new TokenNameTooLongError(MAX_TOKEN_NAME_LENGTH);
    }

    const duplicate = await this.db
      .select({ id: personalAccessTokens.id })
      .from(personalAccessTokens)
      .where(and(eq(personalAccessTokens.userId, input.userId), eq(personalAccessTokens.name, input.name)))
      .get();
    if (duplicate !== undefined) {
      throw new TokenNameExistsError();
    }

    let normalizedScope: string;
    try {
      normalizedScope = normalizeScope(input.scopes);
    } catch (error) {
      if (error instanceof InvalidScopeError) throw new InvalidTokenScopeError(error.message);
      throw error;
    }
    if (normalizedScope === "") {
      throw new EmptyTokenScopeError();
    }

    // A token-authenticated request may only mint child scopes it already
    // holds, and a public-only token cannot mint one that drops the
    // restriction (upstream CanCreateChildScope / EnforcePublicOnlyFrom).
    let finalScope = normalizedScope;
    if (input.mintedByScope != null) {
      const parent = ScopeSet.parse(input.mintedByScope);
      if (!parent.canCreateChildScope(normalizedScope)) {
        throw new TokenScopeEscalationError();
      }
      finalScope = enforcePublicOnlyFrom(normalizedScope, input.mintedByScope);
    }

    // Prefix collisions are retried on the unique constraint (SPEC-0002 §3).
    for (let attempt = 1; ; attempt++) {
      const generated = this.generate();
      const digestHex = await sha256Hex(generated.value);
      let row: typeof personalAccessTokens.$inferSelect | undefined;
      try {
        row = await this.db
          .insert(personalAccessTokens)
          .values({
            userId: input.userId,
            name: input.name,
            prefix: generated.prefix,
            sha256Digest: digestHex,
            scopes: finalScope,
            lastUsedAt: null,
            expiresAt: input.expiresAt ?? null,
            createdAt: now,
          })
          .returning()
          .get();
      } catch (error) {
        // Drizzle wraps driver errors (DrizzleQueryError.cause → D1Error), so
        // walk the cause chain looking for SQLite's unique-violation marker
        // ("UNIQUE constraint failed: personal_access_tokens.prefix").
        let text = error instanceof Error ? error.message : String(error);
        let cause: unknown = error;
        while (cause instanceof Error && cause.cause !== undefined) {
          cause = cause.cause;
          text += ` ${cause instanceof Error ? cause.message : String(cause)}`;
        }
        const isPrefixCollision = text.includes("UNIQUE constraint failed") && text.includes("personal_access_tokens.prefix");
        if (!isPrefixCollision || attempt >= PREFIX_RETRY_LIMIT) {
          if (isPrefixCollision) throw new TokenPrefixCollisionError();
          throw error;
        }
        continue;
      }
      if (row === undefined) throw new TokenPrefixCollisionError();
      return { ...rowToToken(row), plaintext: generated.value };
    }
  }

  /**
   * Verify a presented credential: prefix lookup → sha256 → timing-safe
   * compare → expiry check. Returns `null` for unknown, revoked, malformed
   * (too short) and expired credentials alike — all map to the same 401.
   */
  async verify(value: string, options?: { now?: Date }): Promise<VerifiedAuth | null> {
    const prefix = tokenLookupPrefix(value);
    if (prefix === null) return null;

    const digest = await sha256Hex(value);
    const row = await this.db
      .select({ token: personalAccessTokens, user: users })
      .from(personalAccessTokens)
      .innerJoin(users, eq(users.id, personalAccessTokens.userId))
      .where(eq(personalAccessTokens.prefix, prefix))
      .get();
    if (row === undefined) return null;

    // Timing-safe compare still runs against the looked-up digest when the
    // prefix exists (SPEC-0002 §4.1).
    if (!(await timingSafeDigestEqual(row.token.sha256Digest, digest))) return null;

    const now = options?.now ?? new Date();
    if (row.token.expiresAt !== null && row.token.expiresAt.getTime() <= now.getTime()) {
      return null; // expired ≡ unknown credential; no scope-leaking message
    }

    return { token: rowToToken(row.token), user: rowToUser(row.user) };
  }

  /** Paged token list for a user (upstream `FindAndCount` semantics). */
  async list(userId: number, page: number, pageSize: number): Promise<TokenPage> {
    const tokens = await this.db
      .select()
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, userId))
      .orderBy(asc(personalAccessTokens.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();
    const totalRow = await this.db
      .select({ value: sql<number>`count(*)` })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, userId))
      .get();
    return { tokens: tokens.map(rowToToken), total: totalRow?.value ?? 0 };
  }

  /** Revoke (delete) a token owned by the user; false = not found. */
  async revoke(userId: number, tokenId: number): Promise<boolean> {
    const result = await this.db
      .delete(personalAccessTokens)
      .where(and(eq(personalAccessTokens.id, tokenId), eq(personalAccessTokens.userId, userId)))
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** Tokens of a user carrying exactly this name (upstream name-based
   *  deletion lookup, user/app.go:198–219). */
  async findByName(userId: number, name: string): Promise<AuthToken[]> {
    const rows = await this.db
      .select()
      .from(personalAccessTokens)
      .where(and(eq(personalAccessTokens.userId, userId), eq(personalAccessTokens.name, name)))
      .all();
    return rows.map(rowToToken);
  }

  /** True when `last_used_at` should be refreshed now (24 h throttle). */
  needsLastUsedTouch(token: AuthToken, now: Date): boolean {
    return token.lastUsedAt === null || now.getTime() - token.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS;
  }

  /** Persist `last_used_at`; attach via `ctx.waitUntil` in request paths. */
  async touchLastUsed(tokenId: number, now: Date): Promise<void> {
    await this.db
      .update(personalAccessTokens)
      .set({ lastUsedAt: now })
      .where(eq(personalAccessTokens.id, tokenId))
      .run();
  }

  /** Case-insensitive user lookup (upstream `GetUserByName` → `lower_name`). */
  async getUserByName(username: string): Promise<AuthUser | null> {
    const row = await this.db
      .select()
      .from(users)
      .where(eq(users.usernameLower, username.toLowerCase()))
      .get();
    return row === undefined ? null : rowToUser(row);
  }

  /** User by id. */
  async getUserById(id: number): Promise<AuthUser | null> {
    const row = await this.db.select().from(users).where(eq(users.id, id)).get();
    return row === undefined ? null : rowToUser(row);
  }
}

export function rowToToken(row: typeof personalAccessTokens.$inferSelect): AuthToken {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}

export function rowToUser(row: typeof users.$inferSelect): AuthUser {
  return {
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
    // The render-relevant columns the api identity conversion renders the
    // contract `User` from (auth-context.ts note) — mapped WHERE THE ROW IS
    // IN HAND so the auth-shape User projection stays row-derived.
    type: row.type,
    visibility: row.visibility,
    numStars: row.numStars,
    lastLoginAt: row.lastLoginAt,
  };
}
