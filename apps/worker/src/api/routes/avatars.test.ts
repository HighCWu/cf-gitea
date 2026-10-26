/**
 * The six avatar ops on real D1 + R2 (batch 4 of the remaining-API
 * inventory — `wave-api-avatars`; behavior ports
 * gitea/routers/api/v1/{user,org,repo}/avatar.go over the REPO_PACKS bucket,
 * services/avatars.ts). Seeds `users` (orgs through the landed OrgService) +
 * `repositories` rows through Drizzle, mounts the module on a local
 * OpenAPIHono with the REAL auth middlewares (the orchestrator's
 * `registerAvatarRoutes(app, requireAuth)` one-liner seam — the `u<id>`
 * token scheme binds tokens to the seeded D1 rows), and asserts:
 *
 *   - the storage contract: POST lands `avatars/u_<id>` /
 *     `avatars/<storage_key>` objects carrying the sniffed image content
 *     type, flips `users.use_custom_avatar` for the user/org arms (orgs ARE
 *     user rows), overwrites on re-upload (the deterministic-key divergence),
 *     and DELETE clears marker + object with no 404 arm;
 *   - the caps: strict base64 (400, Go's CorruptInputError text), unknown
 *     format + oversized dimensions (the upstream APIErrorInternal class →
 *     the landed 500 convention), the 262 144-byte origin cap (400 — the
 *     no-resize divergence), the 512 KiB wire cap (413 BEFORE the body is
 *     read), the four accepted image formats sniffed correctly;
 *   - the gates: reqToken 401 on every arm, reqOrgOwnership's exact 403
 *     message and the org 404, reqAdmin's exact 403 message and the
 *     repo-assignment 404 (invisible = missing, anti-enumeration);
 *   - the contract declaration: every arm's operationId and response set
 *     against the frozen contract JSON (the per-arm check:api verification,
 *     run in-test because the router.ts registration is the orchestrator's).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repoCollaborators, repositories, users } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerAvatarRoutes } from "./avatars";
import { OrgService } from "../../services/orgs/orgs";
import { contract } from "../../compat/contract/frozen-contract";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["repo_collaborators", "repositories", "user_redirects", "org_members", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The avatars/ prefix of the shared bucket — the batch's whole key space.
  let cursor: string | undefined;
  do {
    const page = await env.REPO_PACKS.list({ prefix: "avatars/", cursor });
    for (const object of page.objects) {
      await env.REPO_PACKS.delete(object.key);
    }
    cursor = page.truncated === true ? page.cursor : undefined;
  } while (cursor !== undefined);
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

const ERROR_URL = "https://example.com/api/swagger";

// ---------------------------------------------------------------------------
// Image fixtures — header-complete bytes (the processor reads DecodeConfig
// headers only, exactly like upstream's image.DecodeConfig)
// ---------------------------------------------------------------------------

function pngBytes(width: number, height: number, pad = 0): Uint8Array {
  const bytes = new Uint8Array(33 + pad);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function gifBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(21);
  bytes.set([0xff, 0xd8, 0xff, 0xc0], 0); // SOI + SOF0
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 17); // SOF segment length
  bytes[6] = 8; // precision
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
}

function webpLossyBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  bytes.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
  bytes.set([0x9d, 0x01, 0x2a], 23); // start code
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Auth rig — the `u<id>` token scheme (orgs.test.ts's pattern)
// ---------------------------------------------------------------------------

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

const seededUsers = new Map<number, SeededUser>();

async function seedUser(username: string, isAdmin = false): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin });
  return { id: user.id, username: user.username, isAdmin };
}

/** API `User` projection the resolver returns (the auth middleware's shape). */
function apiUser(user: SeededUser): User {
  return {
    id: user.id,
    login: user.username,
    email: `${user.username.toLowerCase()}@example.com`,
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

const resolver: AuthResolver = {
  resolveToken(token) {
    const match = /^u(\d+)$/.exec(token);
    const user = match === null ? undefined : seededUsers.get(Number(match[1]));
    if (match === null || user === undefined) return Promise.resolve(null);
    return Promise.resolve(apiUser(user));
  },
};

const authHeaders = (userId: number): Record<string, string> => ({
  Authorization: `token u${userId}`,
  "Content-Type": "application/json",
});

/** Local mount of exactly the orchestrator one-liner's seam. */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerAvatarRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

const postAvatar = (path: string, userId: number, body: unknown): Promise<Response> =>
  router()(path, { method: "POST", headers: authHeaders(userId), body: JSON.stringify(body) });

const deleteAvatar = (path: string, userId: number): Promise<Response> =>
  router()(path, { method: "DELETE", headers: authHeaders(userId) });

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

async function userFlag(userId: number): Promise<boolean> {
  const rows = await db()
    .select({ flag: users.useCustomAvatar })
    .from(users)
    .where(eq(users.id, userId))
    .all();
  return rows[0]?.flag === true;
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

interface OrgSeed {
  orgId: number;
  owner: SeededUser;
  member: SeededUser;
  outsider: SeededUser;
  admin: SeededUser;
}

/** The standard org: an owner, a plain member, an outsider and a site admin. */
async function seedOrg(name = "acme"): Promise<OrgSeed> {
  const owner = await seedUser(`${name}-owner`);
  const member = await seedUser(`${name}-member`);
  const outsider = await seedUser("outsider");
  const admin = await seedUser("site-admin", true);
  const org = await new OrgService(env.DB).createOrg({
    name,
    ownerId: owner.id,
    visibility: "public",
    now: new Date("2026-01-02T00:00:00Z"),
  });
  await new OrgService(env.DB).addMember(org.id, member.id);
  return { orgId: org.id, owner, member, outsider, admin };
}

let repoSeq = 8700;

interface RepoSeed {
  slug: string;
  repoId: string;
  storageKey: string;
}

/** One repo owned by `ownerName` (public by default). */
async function seedRepo(
  ownerName: string,
  ownerId: number,
  options: {
    visibility?: "public" | "private";
    collaborator?: { userId: number; mode: "read" | "write" | "admin" };
  } = {},
): Promise<RepoSeed> {
  const repoId = String(repoSeq++);
  const slug = `avatar${repoId}`;
  const storageKey = `r_${repoId}`;
  await db().insert(repositories).values({
    id: repoId,
    storageKey,
    ownerNamespace: ownerName,
    ownerId,
    slug,
    visibility: options.visibility ?? "public",
    isArchived: false,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  if (options.collaborator !== undefined) {
    await db()
      .insert(repoCollaborators)
      .values({ repoId, userId: options.collaborator.userId, mode: options.collaborator.mode });
  }
  return { slug, repoId, storageKey };
}

// ---------------------------------------------------------------------------
// POST /user/avatar — storage contract + caps
// ---------------------------------------------------------------------------

describe("POST /user/avatar (userUpdateAvatar)", () => {
  it("stores a PNG at avatars/u_<id> with the sniffed content type and flips use_custom_avatar", async () => {
    const doer = await seedUser("doer");
    const res = await postAvatar("/user/avatar", doer.id, { image: b64(pngBytes(64, 64)) });
    expect(res.status).toBe(204);
    const stored = await env.REPO_PACKS.get(`avatars/u_${doer.id}`);
    expect(stored).not.toBeNull();
    expect(stored?.httpMetadata?.contentType).toBe("image/png");
    expect((await stored?.arrayBuffer())?.byteLength).toBe(33);
    expect(await userFlag(doer.id)).toBe(true);
  });

  it("sniffs gif, jpeg and webp headers into their content types", async () => {
    const doer = await seedUser("doer");
    for (const [bytes, type] of [
      [gifBytes(16, 16), "image/gif"],
      [jpegBytes(16, 16), "image/jpeg"],
      [webpLossyBytes(16, 16), "image/webp"],
    ] as const) {
      const res = await postAvatar("/user/avatar", doer.id, { image: b64(bytes) });
      expect(res.status).toBe(204);
      const stored = await env.REPO_PACKS.head(`avatars/u_${doer.id}`);
      expect(stored?.httpMetadata?.contentType).toBe(type);
    }
  });

  it("overwrites on re-upload (the deterministic-key divergence)", async () => {
    const doer = await seedUser("doer");
    await postAvatar("/user/avatar", doer.id, { image: b64(pngBytes(64, 64)) });
    const second = pngBytes(32, 48);
    const res = await postAvatar("/user/avatar", doer.id, { image: b64(second) });
    expect(res.status).toBe(204);
    const keys = (await env.REPO_PACKS.list({ prefix: `avatars/u_${doer.id}` })).objects;
    expect(keys).toHaveLength(1);
    expect((await env.REPO_PACKS.get(`avatars/u_${doer.id}`))?.size).toBe(second.length);
  });

  it("400s invalid base64 with Go's CorruptInputError text and stores nothing", async () => {
    const doer = await seedUser("doer");
    const res = await postAvatar("/user/avatar", doer.id, { image: "not*base64!!" });
    expect(res.status).toBe(400);
    expect(await jsonBody(res)).toEqual({ message: "illegal base64 data at input byte 3", url: ERROR_URL });
    expect(await env.REPO_PACKS.head(`avatars/u_${doer.id}`)).toBeNull();
    expect(await userFlag(doer.id)).toBe(false);
  });

  it("400s an unpadded final quantum like Go's strict StdEncoding", async () => {
    const doer = await seedUser("doer");
    const res = await postAvatar("/user/avatar", doer.id, { image: b64(pngBytes(1, 1)).slice(0, -2) });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).message).toMatch(/^illegal base64 data at input byte \d+$/);
  });

  it("500s an unknown image format (upstream's APIErrorInternal arm)", async () => {
    const doer = await seedUser("doer");
    const res = await postAvatar("/user/avatar", doer.id, { image: b64(new TextEncoder().encode("plain text bytes")) });
    expect(res.status).toBe(500);
    expect(await jsonBody(res)).toEqual({ message: "internal server error", url: ERROR_URL });
    expect(await env.REPO_PACKS.head(`avatars/u_${doer.id}`)).toBeNull();
  });

  it("500s dimensions over the 4096 caps", async () => {
    const doer = await seedUser("doer");
    const wide = await postAvatar("/user/avatar", doer.id, { image: b64(pngBytes(4097, 10)) });
    expect(wide.status).toBe(500);
    const tall = await postAvatar("/user/avatar", doer.id, { image: b64(pngBytes(10, 4097)) });
    expect(tall.status).toBe(500);
    expect(await env.REPO_PACKS.head(`avatars/u_${doer.id}`)).toBeNull();
  });

  it("400s at the 262144-byte origin cap (the no-resize divergence)", async () => {
    const doer = await seedUser("doer");
    const res = await postAvatar("/user/avatar", doer.id, { image: b64(pngBytes(1, 1, 300_000)) });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).message).toContain("262144");
    expect(await env.REPO_PACKS.head(`avatars/u_${doer.id}`)).toBeNull();
  });

  it("413s a declared over-cap body before reading it", async () => {
    const doer = await seedUser("doer");
    const res = await router()("/user/avatar", {
      method: "POST",
      headers: { ...authHeaders(doer.id), "Content-Length": "700000" },
      body: JSON.stringify({ image: "x".repeat(600_000) }),
    });
    expect(res.status).toBe(413);
    expect((await jsonBody(res)).message).toContain("wire limit");
  });

  it("binds the Go zero value for a missing image field (500 unknown format)", async () => {
    const doer = await seedUser("doer");
    const res = await postAvatar("/user/avatar", doer.id, {});
    expect(res.status).toBe(500);
  });

  it("maps bind failures to upstream statuses (400 malformed JSON, 422 bind)", async () => {
    const doer = await seedUser("doer");
    // Malformed JSON never reaches the bind: hono's reader 400s first — the
    // landed divergence (upstream bind 422s everything, api.go:841-844; the
    // /markdown RUNTIME_ONLY precedent).
    const malformed = await router()("/user/avatar", {
      method: "POST",
      headers: authHeaders(doer.id),
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect((await jsonBody(malformed)).message).toBe("Malformed JSON in request body");
    // A schema-invalid body (null image) goes through the bind hook's 422.
    const nullImage = await postAvatar("/user/avatar", doer.id, { image: null });
    expect(nullImage.status).toBe(422);
    expect(await jsonBody(nullImage)).toEqual({ message: "invalid request body", url: ERROR_URL });
  });

  it("401s anonymous callers (reqToken)", async () => {
    const res = await router()("/user/avatar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: b64(pngBytes(1, 1)) }),
    });
    expect(res.status).toBe(401);
  });
});

describe("DELETE /user/avatar (userDeleteAvatar)", () => {
  it("clears the marker and the object, and stays 204 when nothing is set", async () => {
    const doer = await seedUser("doer");
    await postAvatar("/user/avatar", doer.id, { image: b64(pngBytes(8, 8)) });
    expect(await env.REPO_PACKS.head(`avatars/u_${doer.id}`)).not.toBeNull();
    const first = await deleteAvatar("/user/avatar", doer.id);
    expect(first.status).toBe(204);
    expect(await env.REPO_PACKS.head(`avatars/u_${doer.id}`)).toBeNull();
    expect(await userFlag(doer.id)).toBe(false);
    // Upstream's no-404 arm: deleting an absent avatar still answers 204.
    const second = await deleteAvatar("/user/avatar", doer.id);
    expect(second.status).toBe(204);
  });

  it("401s anonymous callers", async () => {
    const res = await router()("/user/avatar", { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The org pair — org.AsUser() semantics behind reqOrgOwnership
// ---------------------------------------------------------------------------

describe("org avatar pair (orgUpdateAvatar / orgDeleteAvatar)", () => {
  it("stores under the org's users-row key and flips the org row's marker", async () => {
    const org = await seedOrg();
    const res = await postAvatar(`/orgs/acme/avatar`, org.owner.id, { image: b64(pngBytes(16, 16)) });
    expect(res.status).toBe(204);
    expect(await env.REPO_PACKS.head(`avatars/u_${org.orgId}`)).not.toBeNull();
    const flag = await db()
      .select({ flag: users.useCustomAvatar })
      .from(users)
      .where(eq(users.id, org.orgId))
      .all();
    expect(flag[0]?.flag).toBe(true);
  });

  it("403s a plain member with reqOrgOwnership's exact message", async () => {
    const org = await seedOrg();
    const res = await postAvatar(`/orgs/acme/avatar`, org.member.id, { image: b64(pngBytes(1, 1)) });
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({
      message: "Must be an organization owner",
      url: ERROR_URL,
    });
    expect(await env.REPO_PACKS.head(`avatars/u_${org.orgId}`)).toBeNull();
  });

  it("allows the site admin (reqOrgOwnership's admin arm)", async () => {
    const org = await seedOrg();
    const res = await postAvatar(`/orgs/acme/avatar`, org.admin.id, { image: b64(pngBytes(1, 1)) });
    expect(res.status).toBe(204);
  });

  it("404s an unknown org (indistinguishable from the other misses)", async () => {
    const org = await seedOrg();
    const res = await postAvatar(`/orgs/ghost/avatar`, org.owner.id, { image: b64(pngBytes(1, 1)) });
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("deletes by owner and 403s the member", async () => {
    const org = await seedOrg();
    await postAvatar(`/orgs/acme/avatar`, org.owner.id, { image: b64(pngBytes(8, 8)) });
    const denied = await deleteAvatar(`/orgs/acme/avatar`, org.member.id);
    expect(denied.status).toBe(403);
    expect(await env.REPO_PACKS.head(`avatars/u_${org.orgId}`)).not.toBeNull();
    const done = await deleteAvatar(`/orgs/acme/avatar`, org.owner.id);
    expect(done.status).toBe(204);
    expect(await env.REPO_PACKS.head(`avatars/u_${org.orgId}`)).toBeNull();
    const flag = await db()
      .select({ flag: users.useCustomAvatar })
      .from(users)
      .where(eq(users.id, org.orgId))
      .all();
    expect(flag[0]?.flag).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The repo pair — repoAssignment + reqAdmin
// ---------------------------------------------------------------------------

describe("repo avatar pair (repoUpdateAvatar / repoDeleteAvatar)", () => {
  it("stores under the repo storage key; key existence is the marker", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    const res = await postAvatar(`/repos/alice/${repo.slug}/avatar`, alice.id, { image: b64(pngBytes(16, 16)) });
    expect(res.status).toBe(204);
    const stored = await env.REPO_PACKS.head(`avatars/${repo.storageKey}`);
    expect(stored).not.toBeNull();
    expect(stored?.httpMetadata?.contentType).toBe("image/png");
  });

  it("403s a write collaborator with reqAdmin's exact message", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const repo = await seedRepo("alice", alice.id, { collaborator: { userId: bob.id, mode: "write" } });
    const res = await postAvatar(`/repos/alice/${repo.slug}/avatar`, bob.id, { image: b64(pngBytes(1, 1)) });
    expect(res.status).toBe(403);
    expect(await jsonBody(res)).toEqual({
      message: "user should be an owner or a collaborator with admin write of a repository",
      url: ERROR_URL,
    });
  });

  it("allows an admin-mode collaborator and the site admin", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const admin = await seedUser("site-admin", true);
    const repo = await seedRepo("alice", alice.id, { collaborator: { userId: bob.id, mode: "admin" } });
    expect((await postAvatar(`/repos/alice/${repo.slug}/avatar`, bob.id, { image: b64(pngBytes(1, 1)) })).status).toBe(204);
    expect((await postAvatar(`/repos/alice/${repo.slug}/avatar`, admin.id, { image: b64(pngBytes(1, 1)) })).status).toBe(204);
  });

  it("404s an invisible repo and an unknown repo (anti-enumeration)", async () => {
    const alice = await seedUser("alice");
    const outsider = await seedUser("outsider");
    const priv = await seedRepo("alice", alice.id, { visibility: "private" });
    const hidden = await postAvatar(`/repos/alice/${priv.slug}/avatar`, outsider.id, { image: b64(pngBytes(1, 1)) });
    expect(hidden.status).toBe(404);
    const missing = await postAvatar(`/repos/alice/ghost/avatar`, alice.id, { image: b64(pngBytes(1, 1)) });
    expect(missing.status).toBe(404);
    expect(await jsonBody(missing)).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("deletes the object by owner and 403s the write collaborator", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const repo = await seedRepo("alice", alice.id, { collaborator: { userId: bob.id, mode: "write" } });
    await postAvatar(`/repos/alice/${repo.slug}/avatar`, alice.id, { image: b64(pngBytes(8, 8)) });
    const denied = await deleteAvatar(`/repos/alice/${repo.slug}/avatar`, bob.id);
    expect(denied.status).toBe(403);
    expect(await env.REPO_PACKS.head(`avatars/${repo.storageKey}`)).not.toBeNull();
    const done = await deleteAvatar(`/repos/alice/${repo.slug}/avatar`, alice.id);
    expect(done.status).toBe(204);
    expect(await env.REPO_PACKS.head(`avatars/${repo.storageKey}`)).toBeNull();
    // No 404 arm: deleting an absent repo avatar still 204s (upstream
    // DeleteAvatar returns early when no avatar is set).
    const again = await deleteAvatar(`/repos/alice/${repo.slug}/avatar`, alice.id);
    expect(again.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Contract declaration — the per-arm check:api verification (run here because
// the router.ts registration is the orchestrator's)
// ---------------------------------------------------------------------------

describe("contract declaration", () => {
  const ARMS = [
    ["post", "/user/avatar"],
    ["delete", "/user/avatar"],
    ["post", "/orgs/{org}/avatar"],
    ["delete", "/orgs/{org}/avatar"],
    ["post", "/repos/{owner}/{repo}/avatar"],
    ["delete", "/repos/{owner}/{repo}/avatar"],
  ] as const;

  it("declares every arm with the contract's operationId and a response subset", () => {
    const app = new OpenAPIHono<ApiEnv>();
    registerAvatarRoutes(app, createTokenAuthMiddleware(resolver));
    const doc = app.getOpenAPIDocument({
      openapi: "3.0.3",
      info: { title: "Gitea API", version: "test" },
    });
    for (const [method, path] of ARMS) {
      const declared = doc.paths?.[path]?.[method];
      expect(declared, `${method.toUpperCase()} ${path}`).toBeDefined();
      const expected = contract.paths[path]?.[method];
      expect(expected, `contract ${method.toUpperCase()} ${path}`).toBeDefined();
      expect(declared?.operationId).toBe(expected?.operationId);
      const contractCodes = Object.keys(expected?.responses ?? {});
      for (const code of Object.keys(declared?.responses ?? {})) {
        expect(contractCodes, `${method.toUpperCase()} ${path} response ${code}`).toContain(code);
      }
    }
  });

  it("declares exactly the three contract avatar paths, six operations", () => {
    const app = new OpenAPIHono<ApiEnv>();
    registerAvatarRoutes(app, createTokenAuthMiddleware(resolver));
    const doc = app.getOpenAPIDocument({
      openapi: "3.0.3",
      info: { title: "Gitea API", version: "test" },
    });
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(
      ["/orgs/{org}/avatar", "/repos/{owner}/{repo}/avatar", "/user/avatar"].sort(),
    );
    const methods = Object.values(doc.paths ?? {}).flatMap((item) => Object.keys(item));
    expect(methods).toHaveLength(6);
  });
});
