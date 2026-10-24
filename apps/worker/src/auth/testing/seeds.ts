/**
 * Shared test seeds for the SPEC-0002 suites (real D1; migrations must
 * already be applied by the file's beforeAll).
 */

import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";

import type { MintedToken } from "../token-service";
import { TokenService } from "../token-service";
import { users } from "../../db/schema";

export interface SeedUserOptions {
  username?: string;
  isAdmin?: boolean;
  status?: "active" | "prohibited";
}

export async function seedVerifiedUser(options: SeedUserOptions = {}): Promise<{ id: number; username: string }> {
  const username = options.username ?? "Alice";
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: options.isAdmin ?? false,
      status: options.status ?? "active",
      createdAt: new Date(),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username };
}

export async function mintFor(
  userId: number,
  name: string,
  scopes = "all",
): Promise<MintedToken> {
  return new TokenService(env.DB).mint({ userId, name, scopes });
}

/** Basic header with the token as username and an empty password. */
export function basicTokenHeader(plaintext: string): string {
  return `Basic ${btoa(`${plaintext}:`)}`;
}

/** Basic header with `username:password` (arbitrary strings). */
export function basicHeader(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

/**
 * Clear all auth tables between tests. The vitest plugin's D1 state persists
 * across tests within a file (only schema from `beforeAll` migrations is
 * retained between files), so integration suites reset rows explicitly.
 */
export async function resetAuthTables(): Promise<void> {
  for (const table of ["personal_access_tokens", "auth_failures", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}
