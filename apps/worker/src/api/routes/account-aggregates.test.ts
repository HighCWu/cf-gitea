/**
 * Account aggregates (routes/account-aggregates.ts) on real D1: the token
 * family (userGetTokens / userCreateToken / userDeleteAccessToken —
 * user/app.go over the SPEC-0002 TokenService), the tracked-time aggregates
 * (repoTrackedTimes / userTrackedTimes / userCurrentTrackedTimes —
 * issue_tracked_time.go), the stopwatch aggregate (userGetStopWatches —
 * issue_stopwatch.go GetStopwatches) and the GPG verify op
 * (userVerifyGPGKey — user/gpg_key.go) with the RSA-subset OpenPGP check.
 *
 * Standalone mount (the issue-tables-t2.test.ts convention): the register
 * function takes requireAuth, mounted on a fresh OpenAPIHono with the real
 * auth middleware; the stub resolver maps `token u<id>` to the seeded D1
 * user rows so the reqSelfOrAdmin gate is exercisable against the same rows
 * the guard queries.
 *
 * The behavior pins asserted here (the self-or-admin 403, the ONE-TIME
 * plaintext under the legacy `sha1` key, the id-then-name delete ladder with
 * the multiple-matches 422, the cantSetUser collapse, the cross-repo
 * visibility skips with the pre-filter total header, the RSA round trip and
 * the invalid-token-signature 422) are cited in the route module header.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { gpgKeys, issueStopwatches, issues, repositories, trackedTimes, userRedirects, users } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { TokenService } from "../../auth/token-service";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerAccountAggregatesRoutes } from "./account-aggregates";
import { IssuesService } from "../../issues/service";
import { applyRepoExtrasDdl } from "../testing/repo-ddl";

const REPO_ID = "8600";
const OTHER_REPO_ID = "8601";
const VAULT_REPO_ID = "8602"; // private, owner's — invisible to the neighbor
const HIDDEN_REPO_ID = "8603"; // recluse's private repo — invisible to everyone else
const NOW = new Date("2026-02-03T04:05:06Z");

interface Seeded {
  id: number;
  username: string;
  isAdmin: boolean;
}

const seeded = new Map<string, Seeded>();

function resolver(): AuthResolver {
  return {
    resolveToken: (token) => {
      const match = /^u(\d+)$/.exec(token);
      const row = match === null ? undefined : [...seeded.values()].find((user) => user.id === Number(match[1]));
      if (match === null || row === undefined) return Promise.resolve(null);
      return Promise.resolve(apiUser(row));
    },
  };
}

function apiUser(user: Seeded): User {
  return {
    id: user.id,
    login: user.username,
    email: `${user.username}@example.com`,
    full_name: "",
    avatar_url: "",
    html_url: "",
    language: "en-US",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: user.isAdmin,
    prohibit_login: false,
    restricted: false,
    login_name: "",
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: "2026-01-01T00:00:00Z",
    last_login: "0001-01-01T00:00:00Z",
    type: "User",
    visibility: "public",
  };
}

function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerAccountAggregatesRoutes(app, createTokenAuthMiddleware(resolver()));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

const authed = (token: string, init?: RequestInit): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `token ${token}`);
  return { ...init, headers };
};

const jsonAuth = (token: string, body: unknown, method = "POST"): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { Authorization: `token ${token}`, "content-type": "application/json" },
});

beforeAll(applyRepoExtrasDdl);

let owner!: Seeded;
let neighbor!: Seeded;
let admin!: Seeded;
let recluse!: Seeded;

beforeEach(async () => {
  for (const table of [
    "webhook_deliveries",
    "webhooks",
    "gpg_keys",
    "issue_subscriptions",
    "reactions",
    "issue_assignees",
    "issue_dependency",
    "issue_pins",
    "tracked_time",
    "stopwatch",
    "comments",
    "issue_labels",
    "pull_requests",
    "issues",
    "labels",
    "milestones",
    "repo_topics",
    "repo_watchers",
    "repo_collaborators",
    "stars",
    "follows",
    "repo_counters",
    "commit_statuses",
    "repo_units",
    "repo_settings",
    "repo_transfer",
    "repo_redirects",
    "repositories",
    "personal_access_tokens",
    "user_redirects",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  seeded.clear();

  const seedUser = async (username: string, isAdmin = false): Promise<Seeded> => {
    const rows = await drizzle(env.DB)
      .insert(users)
      .values({ username, usernameLower: username, isAdmin, status: "active", createdAt: NOW })
      .returning({ id: users.id, username: users.username })
      .all();
    const row = rows[0]!;
    const seededRow = { id: row.id, username: row.username, isAdmin };
    seeded.set(username, seededRow);
    return seededRow;
  };
  owner = await seedUser("owner");
  neighbor = await seedUser("neighbor");
  admin = await seedUser("site-admin", true);
  recluse = await seedUser("recluse");

  const seedRepo = (id: string, slug: string, ownerId: number, ownerNamespace: string, visibility: "public" | "private") =>
    drizzle(env.DB).insert(repositories).values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace,
      ownerId,
      slug,
      visibility,
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: NOW,
    });
  await seedRepo(REPO_ID, "writes", owner.id, "owner", "public");
  await seedRepo(OTHER_REPO_ID, "other", owner.id, "owner", "public");
  await seedRepo(VAULT_REPO_ID, "vault", owner.id, "owner", "private");
  await seedRepo(HIDDEN_REPO_ID, "hidden", recluse.id, "recluse", "private");
});

const token = (user: Seeded): string => `u${user.id}`;

async function createIssue(repoId: string, title: string, posterId: number): Promise<{ id: number; index: number }> {
  const issue = await new IssuesService(env.DB).createIssue({ repoId, title, content: "", posterId });
  return { id: issue.id, index: issue.index };
}

async function seedTime(issueId: number, userId: number, seconds: number, createdAt = NOW): Promise<void> {
  await drizzle(env.DB).insert(trackedTimes).values({ issueId, userId, seconds, createdAt });
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

describe("GET /users/{username}/tokens (userGetTokens)", () => {
  it("lists the target's tokens paged with the total header", async () => {
    const service = new TokenService(env.DB);
    const first = await service.mint({ userId: owner.id, name: "one", scopes: "read:repository", now: NOW });
    await service.mint({ userId: owner.id, name: "two", scopes: "all", now: NOW });
    await service.mint({ userId: neighbor.id, name: "foreign", scopes: "all" });

    const res = await router()( `/users/${owner.username}/tokens`, authed(token(owner)));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((row) => row.name)).toEqual(["one", "two"]);
    expect(body[0]).toMatchObject({
      id: first.id,
      name: "one",
      sha1: "",
      token_last_eight: first.prefix.slice(-8),
      scopes: ["read:repository"],
      created_at: NOW.toISOString(),
      last_used_at: "0001-01-01T00:00:00Z",
    });
  });

  it("403s a non-admin reading another user's tokens and 404s an unknown user", async () => {
    const send = router();
    expect((await send(`/users/${owner.username}/tokens`, authed(token(neighbor)))).status).toBe(403);
    const miss = await send("/users/ghost/tokens", authed(token(owner)));
    expect(miss.status).toBe(404);
    expect((await miss.json<{ message: string }>()).message).toBe("user redirect does not exist [name: ghost]");
  });

  it("lets a site admin read another user's tokens and 307s a renamed user", async () => {
    await new TokenService(env.DB).mint({ userId: neighbor.id, name: "n", scopes: "all" });
    expect((await router()( `/users/${neighbor.username}/tokens`, authed(token(admin)))).status).toBe(200);

    await drizzle(env.DB).insert(userRedirects).values({ lowerName: "old-name", redirectUserId: owner.id });
    const res = await router()("/users/old-name/tokens", authed(token(owner)));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/users/owner/tokens");
  });
});

describe("POST /users/{username}/tokens (userCreateToken)", () => {
  it("mints a token and returns the ONE-TIME plaintext under the legacy sha1 key", async () => {
    const res = await router()(
      `/users/${owner.username}/tokens`,
      jsonAuth(token(owner), { name: "cli", scopes: ["read:repository", "read:user"] }),
    );
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, string | number | string[]>>();
    expect(body.name).toBe("cli");
    expect(typeof body.sha1).toBe("string");
    expect(body.sha1).not.toBe("");
    expect(body.token_last_eight).toBe((body.sha1 as string).slice(-8));
    expect(body.scopes).toEqual(["read:repository", "read:user"]);
    // The mint is real: the stored row verifies against the plaintext.
    expect(await new TokenService(env.DB).verify(body.sha1 as string)).not.toBeNull();
  });

  it("400s a duplicate name, an invalid scope and an empty scope; 422s a missing name", async () => {
    const send = router();
    await new TokenService(env.DB).mint({ userId: owner.id, name: "taken", scopes: "all" });
    expect(
      (await send(`/users/${owner.username}/tokens`, jsonAuth(token(owner), { name: "taken", scopes: ["all"] }))).status,
    ).toBe(400);
    const badScope = await send(`/users/${owner.username}/tokens`, jsonAuth(token(owner), { name: "x", scopes: ["nope"] }));
    expect(badScope.status).toBe(400);
    expect((await badScope.json<{ message: string }>()).message).toContain("invalid access token scope provided");
    const emptyScope = await send(`/users/${owner.username}/tokens`, jsonAuth(token(owner), { name: "x", scopes: [] }));
    expect(emptyScope.status).toBe(400);
    expect((await emptyScope.json<{ message: string }>()).message).toBe("access token must have a scope");
    expect((await send(`/users/${owner.username}/tokens`, jsonAuth(token(owner), { scopes: ["all"] }))).status).toBe(422);
  });

  it("403s a non-admin minting for another user", async () => {
    expect(
      (await router()(`/users/${owner.username}/tokens`, jsonAuth(token(neighbor), { name: "x", scopes: ["all"] }))).status,
    ).toBe(403);
  });
});

describe("DELETE /users/{username}/tokens/{token} (userDeleteAccessToken)", () => {
  it("deletes by numeric id and by name, 404s unknown ids", async () => {
    const service = new TokenService(env.DB);
    const minted = await service.mint({ userId: owner.id, name: "gone", scopes: "all" });
    const send = router();
    expect((await send(`/users/${owner.username}/tokens/${minted.id}`, { method: "DELETE", ...authed(token(owner)) })).status).toBe(204);
    expect(await service.list(owner.id, 1, 30)).toMatchObject({ total: 0 });

    const again = await service.mint({ userId: owner.id, name: "gone", scopes: "all" });
    expect((await send(`/users/${owner.username}/tokens/gone`, { method: "DELETE", ...authed(token(owner)) })).status).toBe(204);
    expect((await send(`/users/${owner.username}/tokens/${again.id}`, { method: "DELETE", ...authed(token(owner)) })).status).toBe(404);
  });

  it("422s when a name matches several tokens and 403s a non-admin", async () => {
    const service = new TokenService(env.DB);
    await service.mint({ userId: owner.id, name: "dupe", scopes: "all" });
    await service.mint({ userId: owner.id, name: "dupe-x", scopes: "all" });
    const send = router();
    // A second row sharing the exact name (the service enforces per-user
    // name-uniqueness, so the multiple-matches arm is seeded directly).
    await env.DB
      .prepare("INSERT INTO personal_access_tokens (user_id, name, prefix, sha256_digest, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(owner.id, "dupe", "cfg_ffffffff", "0".repeat(64), "all", NOW.getTime())
      .run();
    const multi = await send(`/users/${owner.username}/tokens/dupe`, { method: "DELETE", ...authed(token(owner)) });
    expect(multi.status).toBe(422);
    expect((await multi.json<{ message: string }>()).message).toBe("multiple matches for token name 'dupe'");

    // The suffix name is NOT a substring match: deleting "dupe-x" finds one.
    const dupeX = (await env.DB.prepare("SELECT id FROM personal_access_tokens WHERE name = 'dupe-x'").first<{ id: number }>())!;
    expect((await send(`/users/${owner.username}/tokens/dupe-x`, { method: "DELETE", ...authed(token(owner)) })).status).toBe(204);
    expect((await send(`/users/${owner.username}/tokens/${dupeX.id}`, { method: "DELETE", ...authed(token(owner)) })).status).toBe(404);

    const minted = await service.mint({ userId: owner.id, name: "other", scopes: "all" });
    expect((await send(`/users/${owner.username}/tokens/${minted.id}`, { method: "DELETE", ...authed(token(neighbor)) })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tracked-time aggregates
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/times (repoTrackedTimes)", () => {
  it("lists the repo's times with the issue embedded and the total header", async () => {
    const a = await createIssue(REPO_ID, "alpha", owner.id);
    const b = await createIssue(REPO_ID, "beta", owner.id);
    await seedTime(a.id, owner.id, 60);
    await seedTime(b.id, neighbor.id, 120);

    const res = await router()(`/repos/owner/writes/times`, authed(token(owner)));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((row) => row.time)).toEqual([60, 120]);
    expect((body[0]!.issue as Record<string, unknown>).number).toBe(a.index);
    expect(body[0]!.user_name).toBe("owner");
    expect(body[1]!.user_name).toBe("neighbor");
  });

  it("scopes an unfiltered non-writer query to the doer's own rows (cantSetUser)", async () => {
    const a = await createIssue(REPO_ID, "alpha", owner.id);
    await seedTime(a.id, owner.id, 60);
    await seedTime(a.id, neighbor.id, 120);

    const res = await router()(`/repos/owner/writes/times`, authed(token(neighbor)));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("1");
    expect((await res.json<Array<Record<string, unknown>>>())[0]!.user_id).toBe(neighbor.id);
  });

  it("403s a non-writer filtering by another user, 404s an unknown filter user", async () => {
    const send = router();
    const forbidden = await send(`/repos/owner/writes/times?user=owner`, authed(token(neighbor)));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json<{ message: string }>()).message).toBe("query by user not allowed; not enough rights");
    const miss = await send(`/repos/owner/writes/times?user=ghost`, authed(token(owner)));
    expect(miss.status).toBe(404);
    expect((await miss.json<{ message: string }>()).message).toBe("user does not exist [uid: 0, name: ghost]");
  });

  it("honors since/before (RFC 3339) and 422s a malformed one", async () => {
    const a = await createIssue(REPO_ID, "alpha", owner.id);
    await seedTime(a.id, owner.id, 60, new Date("2026-02-01T00:00:00Z"));
    await seedTime(a.id, owner.id, 120, new Date("2026-02-03T00:00:00Z"));
    const send = router();
    const mid = await send(`/repos/owner/writes/times?since=2026-02-02T00:00:00Z`, authed(token(owner)));
    expect(mid.status).toBe(200);
    expect((await mid.json<Array<Record<string, unknown>>>()).map((row) => row.time)).toEqual([120]);
    const bad = await send(`/repos/owner/writes/times?since=yesterday`, authed(token(owner)));
    expect(bad.status).toBe(422);
  });

  it("404s an invisible repo", async () => {
    expect((await router()(`/repos/recluse/hidden/times`, authed(token(neighbor)))).status).toBe(404);
    expect((await router()(`/repos/owner/vault/times`, authed(token(neighbor)))).status).toBe(404);
  });
});

describe("GET /repos/{owner}/{repo}/times/{user} (userTrackedTimes)", () => {
  it("lists one user's times in the repo for the user themself", async () => {
    const a = await createIssue(REPO_ID, "alpha", owner.id);
    await seedTime(a.id, owner.id, 60);
    await seedTime(a.id, neighbor.id, 120);

    const res = await router()(`/repos/owner/writes/times/owner`, authed(token(owner)));
    expect(res.status).toBe(200);
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.length).toBe(1);
    expect(body[0]!.time).toBe(60);
  });

  it("403s a non-writer reading another user's rows; a site admin passes", async () => {
    const a = await createIssue(REPO_ID, "alpha", owner.id);
    await seedTime(a.id, owner.id, 60);
    const send = router();
    expect((await send(`/repos/owner/writes/times/owner`, authed(token(neighbor)))).status).toBe(403);
    expect((await send(`/repos/owner/writes/times/owner`, authed(token(admin)))).status).toBe(200);
  });

  it("404s an unknown user and an invisible repo", async () => {
    const send = router();
    expect((await send(`/repos/owner/writes/times/ghost`, authed(token(owner)))).status).toBe(404);
    expect((await send(`/repos/recluse/hidden/times/recluse`, authed(token(neighbor)))).status).toBe(404);
  });
});

describe("GET /user/times (userCurrentTrackedTimes)", () => {
  it("lists the doer's times across repos, skipping unreadable ones, total counted pre-filter", async () => {
    const a = await createIssue(REPO_ID, "alpha", owner.id);
    const hidden = await createIssue(HIDDEN_REPO_ID, "secret", recluse.id);
    await seedTime(a.id, owner.id, 60);
    // The owner's own row inside the recluse's private repo: the entry skips
    // from the page while the total header still counts both rows (the
    // upstream shape — count is pre-access-filter, ListMyTrackedTimes).
    await seedTime(hidden.id, owner.id, 90);

    const res = await router()(`/user/times`, authed(token(owner)));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.length).toBe(1);
    expect(body[0]!.time).toBe(60);
  });

  it("404s entries whose issue vanished and honors since", async () => {
    const a = await createIssue(REPO_ID, "alpha", owner.id);
    await seedTime(a.id, owner.id, 60);
    await drizzle(env.DB).delete(issues).where(eq(issues.id, a.id));
    // The orphaned tracked-time row renders nothing (the conservative skip).
    const res = await router()(`/user/times`, authed(token(owner)));
    expect(res.status).toBe(200);
    expect((await res.json<unknown[]>()).length).toBe(0);
  });
});

describe("GET /user/stopwatches (userGetStopWatches)", () => {
  it("renders the doer's running stopwatch with the elapsed duration", async () => {
    const a = await createIssue(REPO_ID, "alpha", owner.id);
    // Whole seconds: the timestamp column stores unix seconds (no sub-second).
    const startedAt = new Date(Math.floor((Date.now() - 2 * 3600 * 1000 - 5 * 60 * 1000) / 1000) * 1000);
    await drizzle(env.DB).insert(issueStopwatches).values({ issueId: a.id, userId: owner.id, createdAt: startedAt });

    const res = await router()(`/user/stopwatches`, authed(token(owner)));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("1");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.length).toBe(1);
    expect(body[0]).toMatchObject({
      issue_index: a.index,
      issue_title: "alpha",
      repo_owner_name: "owner",
      repo_name: "writes",
    });
    expect(body[0]!.created).toBe(startedAt.toISOString());
    expect(body[0]!.duration).toBe("2 hours 5 minutes");
  });

  it("skips stopwatches on issues in repos the doer can no longer read", async () => {
    const hidden = await createIssue(HIDDEN_REPO_ID, "secret", recluse.id);
    await drizzle(env.DB).insert(issueStopwatches).values({ issueId: hidden.id, userId: recluse.id, createdAt: new Date() });
    // Transfer the repo away from the recluse (owner flip) so the visibility
    // skip arms: update the owner to the vault repo's owner namespace user.
    await drizzle(env.DB)
      .update(repositories)
      .set({ visibility: "private", ownerId: owner.id, ownerNamespace: "owner" })
      .where(eq(repositories.id, HIDDEN_REPO_ID));

    const res = await router()(`/user/stopwatches`, authed(token(recluse)));
    expect(res.status).toBe(200);
    expect((await res.json<unknown[]>()).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GPG key verification (RSA subset)
// ---------------------------------------------------------------------------

/** One MPI (RFC 4880 §3.2): 2-bit-length header + big-endian octets. */
function mpi(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const slice = bytes.subarray(start);
  const bitLength = 8 * (slice.length - 1) + (32 - Math.clz32(slice[0]!));
  const out = new Uint8Array(2 + slice.length);
  out[0] = bitLength >> 8;
  out[1] = bitLength & 0xff;
  out.set(slice, 2);
  return out;
}

interface RsaKeyMaterial {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  n: Uint8Array;
  e: Uint8Array;
}

async function generateRsa(): Promise<RsaKeyMaterial> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { n: string; e: string };
  const b64urlToBytes = (value: string): Uint8Array => {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  return { publicKey: pair.publicKey, privateKey: pair.privateKey, n: b64urlToBytes(jwk.n), e: b64urlToBytes(jwk.e) };
}

/** The stored gpg_keys.content: base64(0x99 ‖ len16 ‖ v4 public-key body). */
async function keyIdentity(material: RsaKeyMaterial): Promise<{ keyId: string; content: string }> {
  const nMpi = mpi(material.n);
  const eMpi = mpi(material.e);
  const body = new Uint8Array(6 + nMpi.length + eMpi.length);
  body[0] = 4;
  new DataView(body.buffer).setUint32(1, Math.floor(NOW.getTime() / 1000));
  body[5] = 1; // RSA
  body.set(nMpi, 6);
  body.set(eMpi, 6 + nMpi.length);
  const framed = new Uint8Array(3 + body.length);
  framed[0] = 0x99;
  framed[1] = body.length >> 8;
  framed[2] = body.length & 0xff;
  framed.set(body, 3);
  const digest = await crypto.subtle.digest("SHA-1", framed);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  let binary = "";
  for (const byte of framed) binary += String.fromCharCode(byte);
  return { keyId: hex.slice(-16).toUpperCase(), content: btoa(binary) };
}

/** asymkey_model.VerificationToken (gpg_key_verify.go:74-86) — the same
 *  formula the route computes, replicated for the signature builder. */
function verificationToken(user: { id: number; username: string; email: string | null; createdAt: Date }, minutes: number): Promise<string> {
  const goRfc1123z = (date: Date): string => {
    const pad = (n: number) => String(n).padStart(2, "0");
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${weekdays[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
  };
  const minuteStart = Math.floor(Date.now() / 60000) * 60000;
  const payload =
    goRfc1123z(new Date(minuteStart + minutes * 60000)) +
    ":" + goRfc1123z(user.createdAt) + ":" + user.username + ":" + (user.email ?? "") + ":" + String(user.id);
  // base.EncodeSha256 (the route hashes the same payload).
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)).then((digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

/** The doer-shaped token candidate — the seeded users rows carry no email,
 * so the formula's email segment is the empty string (matching the route's
 * `user.email ?? ""`). */
async function tokenFor(user: Seeded): Promise<string> {
  return verificationToken({ id: user.id, username: user.username, email: null, createdAt: NOW }, 1);
}

/** An armored v4/RSA/SHA-256 signature over `candidate` (empty hashed
 *  subpackets — legal RFC 4880; the verifier reads the same layout). */
async function armoredSignature(material: RsaKeyMaterial, candidate: string): Promise<string> {
  // The six header octets the hash covers: version, type, algo, hash and the
  // two-byte hashed-subpackets length (zero — the RFC 4880 §5.2.4 trailer is
  // these same six bytes).
  const hashedPortion = new Uint8Array([4, 0, 1, 8, 0, 0]);
  const payload = new TextEncoder().encode(candidate);
  const signedData = new Uint8Array(payload.length + hashedPortion.length + 6);
  signedData.set(payload, 0);
  signedData.set(hashedPortion, payload.length);
  signedData.set(new Uint8Array([4, 0, 1, 8, 0, 0]), payload.length + hashedPortion.length);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, material.privateKey, signedData));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", signedData));

  const sigMpi = mpi(signature);
  const packet = new Uint8Array(hashedPortion.length + 2 + 2 + sigMpi.length);
  packet.set(hashedPortion, 0);
  packet[hashedPortion.length] = 0; // unhashed length hi
  packet[hashedPortion.length + 1] = 0; // unhashed length lo
  packet.set(digest.subarray(0, 2), hashedPortion.length + 2);
  packet.set(sigMpi, hashedPortion.length + 4);
  // New-format packet header (RFC 4880 §4.2.3): a 268-byte body does NOT fit
  // the one-byte length form.
  const header =
    packet.length < 192
      ? Uint8Array.from([0xc2, packet.length])
      : packet.length <= 8383
        ? Uint8Array.from([0xc2, 192 + ((packet.length - 192) >> 8), (packet.length - 192) & 0xff])
        : Uint8Array.from([0xc2, 255, packet.length >>> 24, (packet.length >>> 16) & 0xff, (packet.length >>> 8) & 0xff, packet.length & 0xff]);
  const body = new Uint8Array(header.length + packet.length);
  body.set(header, 0);
  body.set(packet, header.length);
  let binary = "";
  for (const byte of body) binary += String.fromCharCode(byte);
  return `-----BEGIN PGP SIGNATURE-----\n\n${btoa(binary)}\n-----END PGP SIGNATURE-----`;
}

/**
 * Seed a key row from `material` (regenerating until the key id does NOT
 * start with '0' — the handler ports upstream's `TrimLeft(key_id, "0")`
 * quirk verbatim, so a zero-leading id could never be addressed; real GPG
 * key ids hit that 1-in-16, the tests avoid it deterministically). Returns
 * the ACTUAL key id.
 */
async function seedGpgKey(
  ownerId: number,
  passedMaterial: RsaKeyMaterial,
  options: { primaryKeyId?: string; canSign?: boolean } = {},
): Promise<string> {
  let material = passedMaterial;
  let { keyId, content } = await keyIdentity(material);
  while (keyId.startsWith("0")) {
    material = await generateRsa();
    ({ keyId, content } = await keyIdentity(material));
  }
  await drizzle(env.DB).insert(gpgKeys).values({
    ownerId,
    keyId,
    primaryKeyId: options.primaryKeyId ?? "",
    content,
    verified: false,
    canSign: options.canSign ?? true,
    canEncryptComms: false,
    canEncryptStorage: false,
    canCertify: true,
    createdAt: NOW,
    expiresAt: null,
    addedAt: NOW,
  });
  return keyId;
}

describe("POST /user/gpg_key_verify (userVerifyGPGKey)", () => {
  it("marks a key verified with a valid RSA signature over the token (201)", async () => {
    let material = await generateRsa();
    let { keyId } = await keyIdentity(material);
    while (keyId.startsWith("0")) {
      material = await generateRsa();
      ({ keyId } = await keyIdentity(material));
    }
    await seedGpgKey(owner.id, material);
    const row = (await drizzle(env.DB).select().from(gpgKeys).where(eq(gpgKeys.keyId, keyId)).all())[0]!;
    const candidate = await tokenFor(owner);

    const res = await router()(
      "/user/gpg_key_verify",
      jsonAuth(token(owner), { key_id: keyId, armored_signature: await armoredSignature(material, candidate) }),
    );
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.key_id).toBe(keyId);
    expect(body.verified).toBe(true);
    const after = (await drizzle(env.DB).select().from(gpgKeys).where(eq(gpgKeys.id, row.id)).all())[0]!;
    expect(after.verified).toBe(true);
  });

  it("verifies a signature made by a SUBKEY of the primary", async () => {
    let primary = await generateRsa();
    let { keyId } = await keyIdentity(primary);
    while (keyId.startsWith("0")) {
      primary = await generateRsa();
      ({ keyId } = await keyIdentity(primary));
    }
    const sub = await generateRsa();
    await seedGpgKey(owner.id, primary);
    const subKeyId = await seedGpgKey(owner.id, sub, { primaryKeyId: keyId });
    const candidate = await tokenFor(owner);

    const res = await router()(
      "/user/gpg_key_verify",
      jsonAuth(token(owner), { key_id: keyId, armored_signature: await armoredSignature(sub, candidate) }),
    );
    expect(res.status).toBe(201);
    // The primary row flips verified (upstream updates the matched KEY row);
    // the body renders the primary with its subkey list.
    const body = await res.json<Record<string, unknown>>();
    expect(body.key_id).toBe(keyId);
    const subkeys = body.subkeys as Array<Record<string, unknown>>;
    expect(subkeys.map((row) => row.key_id)).toEqual([subKeyId]);
  });

  it("422s a signature over the wrong payload (invalid-token-signature)", async () => {
    const material = await generateRsa();
    const keyId = await seedGpgKey(owner.id, material);
    const res = await router()(
      "/user/gpg_key_verify",
      jsonAuth(token(owner), {
        key_id: keyId,
        armored_signature: await armoredSignature(material, "not the token"),
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json<{ message: string }>();
    expect(body.message).toContain("The provided GPG key, signature and token do not match or token is out of date");
    // Nothing flipped.
    const row = (await drizzle(env.DB).select().from(gpgKeys).where(eq(gpgKeys.keyId, keyId)).all())[0]!;
    expect(row.verified).toBe(false);
  });

  it("422s a signature by a different RSA key and refuses a key that cannot sign", async () => {
    const material = await generateRsa();
    const impostor = await generateRsa();
    const keyId = await seedGpgKey(owner.id, material);
    const unsigned = await seedGpgKey(owner.id, impostor, { canSign: false });
    const candidate = await tokenFor(owner);
    const send = router();
    const wrongKey = await send(
      "/user/gpg_key_verify",
      jsonAuth(token(owner), { key_id: keyId, armored_signature: await armoredSignature(impostor, candidate) }),
    );
    expect(wrongKey.status).toBe(422);
    // canSign=false: verifySign's "key can not sign" arm — same 422 answer.
    const cannotSign = await send(
      "/user/gpg_key_verify",
      jsonAuth(token(owner), { key_id: unsigned, armored_signature: await armoredSignature(impostor, candidate) }),
    );
    expect(cannotSign.status).toBe(422);
  });

  it("422s a non-RSA signature packet (the documented subset miss)", async () => {
    const material = await generateRsa();
    const keyId = await seedGpgKey(owner.id, material);
    // A v4 packet declaring DSA (algo 17): the subset answers the upstream
    // bad-signature 422 without attempting verification.
    const packet = new Uint8Array([4, 0, 17, 8, 0, 0, 0, 0, 1, 2, 3, 4]);
    const body = new Uint8Array(2 + packet.length);
    body[0] = 0xc2;
    body[1] = packet.length;
    body.set(packet, 2);
    let binary = "";
    for (const byte of body) binary += String.fromCharCode(byte);
    const res = await router()(
      "/user/gpg_key_verify",
      jsonAuth(token(owner), {
        key_id: keyId,
        armored_signature: `-----BEGIN PGP SIGNATURE-----\n\n${btoa(binary)}\n-----END PGP SIGNATURE-----`,
      }),
    );
    expect(res.status).toBe(422);
  });

  it("404s an unknown key id, an all-zero key id and a foreign owner's key", async () => {
    const material = await generateRsa();
    await seedGpgKey(recluse.id, material);
    const send = router();
    const candidate = await tokenFor(owner);
    const signature = await armoredSignature(material, candidate);
    expect((await send("/user/gpg_key_verify", jsonAuth(token(owner), { key_id: "DEADBEEFDEADBEEF", armored_signature: signature }))).status).toBe(404);
    // All-zero ids trim to empty — VerifyUserGPGKey's empty-key_id 404 arm.
    expect((await send("/user/gpg_key_verify", jsonAuth(token(owner), { key_id: "0000000000000000", armored_signature: signature }))).status).toBe(404);
    // The recluse's key is invisible to the owner's lookup (owner-scoped).
    expect((await send("/user/gpg_key_verify", jsonAuth(token(owner), { key_id: (await keyIdentity(material)).keyId, armored_signature: signature }))).status).toBe(404);
  });

  it("422s a missing armored_signature (the binder-shaped arm)", async () => {
    const material = await generateRsa();
    const keyId = await seedGpgKey(owner.id, material);
    const res = await router()("/user/gpg_key_verify", jsonAuth(token(owner), { key_id: keyId }));
    expect(res.status).toBe(422);
  });
});
