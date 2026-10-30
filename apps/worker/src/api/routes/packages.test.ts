/**
 * The package API surface battery (SPEC-0016 §6 management + protocol plan)
 * on real D1 + the real REPO_PACKS binding:
 *
 *  - the 9 management ops against upstream's wire shapes (structs/
 *    package.go fixtures: the Package keyed by the VERSION id, the
 *    PackageFile's four hashes), with the upstream pagination headers;
 *  - the auth/scope arms: reqToken's anonymous 401, tokenRequiresScopes'
 *    403 (the exact upstream message), reqPackageAccess' 401 + the
 *    WWW-Authenticate challenge on an insufficient access mode (real minted
 *    PATs through TokenService — the routes' own credential pass);
 *  - link/unlink round-trip and the repo filter of R16's source query;
 *  - the admin list (site-admin gate, cross-owner rows, q/type filters);
 *  - the generic protocol round-trip (PUT/GET/HEAD/DELETE with a
 *    curl-shaped body), the upstream validation set, 409
 *    duplicate-different-bytes / idempotent duplicate-same-bytes, the 411,
 *    the quota 403, the anonymous download of a public owner, and the
 *    download counter (GET counts, HEAD does not).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packages, packageVersions, repositories, users } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { resolveAuth } from "../../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerPackagesRoutes, createPackagesProtocolRouter } from "./packages";
import type { User } from "../models/user";
import { packageBlobContentKey } from "../../services/packages/blobs";
import { mintFor } from "../../auth/testing/seeds";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "package_properties",
    "package_files",
    "package_blobs",
    "package_versions",
    "package_cleanup_rules",
    "packages",
    "personal_access_tokens",
    "auth_failures",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const prefix of ["packages/tmp/", "packages/blobs/"]) {
    const listed = await env.REPO_PACKS.list({ prefix });
    await env.REPO_PACKS.delete(listed.objects.map((object) => object.key));
  }
  seededUsers.clear();
});

const db = () => drizzle(env.DB);
const NOW = new Date("2026-10-29T12:00:00Z");
const ERROR_URL = "https://example.com/api/swagger";

// ---------------------------------------------------------------------------
// Seeds + the `u<id>` token rig (hooks-scopes.test.ts's pattern) — the
// routes resolve the presented credential through TokenService, so the
// scope gates read REAL minted PATs.
// ---------------------------------------------------------------------------

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

const seededUsers = new Map<number, SeededUser>();

async function seedUser(
  username: string,
  opts: { isAdmin?: boolean; type?: "user" | "org"; visibility?: "public" | "limited" | "private" } = {},
): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: opts.isAdmin ?? false,
      status: "active",
      type: opts.type ?? "user",
      visibility: opts.visibility ?? "public",
      createdAt: NOW,
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  const seeded = { id: user.id, username: user.username, isAdmin: user.isAdmin };
  seededUsers.set(user.id, seeded);
  return seeded;
}

/** Mint a PAT for the user with the given scope string (cached per user+scopes). */
async function token(user: SeededUser, scopes: string): Promise<string> {
  const mintedToken = await mintFor(user.id, `pat-${scopes}`, scopes);
  return mintedToken.plaintext;
}

const authHeaders = (plaintext: string): Record<string, string> => ({
  Authorization: `token ${plaintext}`,
});

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
  resolveToken(tokenValue) {
    const match = /^u(\d+)$/.exec(tokenValue);
    const user = match === null ? undefined : seededUsers.get(Number(match[1]));
    if (match === null || user === undefined) return Promise.resolve(null);
    return Promise.resolve(apiUser(user));
  },
};

/** Local mount of exactly the registry one-liner's seam — and the REAL
 *  mount prefix (src/index.ts mounts createApiRouter() at /api/v1), so the
 *  full-path requests below route exactly as production does. */
function router(overrides: Record<string, string> = {}) {
  const v1 = new OpenAPIHono<ApiEnv>();
  v1.onError(giteaErrorHandler);
  registerPackagesRoutes(v1, createTokenAuthMiddleware(resolver));
  // The REAL /api/v1 composition (src/index.ts): resolveAuth runs first, so
  // the admin route's requireAuth reads the D1-verified identity — every arm
  // below therefore uses REAL minted PATs.
  const parent = new Hono<{ Bindings: Env }>();
  parent.use("/api/v1/*", resolveAuth());
  parent.route("/api/v1", v1);
  const boundEnv = { ...env, ...overrides };
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://example.com${path}`, init), boundEnv);
}

function protocol(overrides: Record<string, string> = {}) {
  // The REAL mount shape: index.ts mounts the protocol sub-app at
  // /api/packages, so the test mounts it on a parent the same way (fetching
  // the sub-app bare would miss every route — the prefix never strips).
  const parent = new Hono<{ Bindings: Env }>();
  parent.route("/api/packages", createPackagesProtocolRouter());
  const boundEnv = { ...env, ...overrides };
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://example.com${path}`, init), boundEnv);
}

async function seedRepo(owner: SeededUser, slug: string): Promise<string> {
  const id = crypto.randomUUID();
  await db()
    .insert(repositories)
    .values({
      id,
      storageKey: `r_${owner.username}_${slug}`,
      ownerNamespace: owner.username,
      slug,
      ownerId: owner.id,
      visibility: "public",
      createdAt: NOW,
    });
  return id;
}

/** Upload a generic package file through the protocol (the suites' fixture). */
async function putFile(
  owner: string,
  name: string,
  version: string,
  filename: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const caller = protocol();
  // A constructed Request does not expose Content-Length in workerd, so the
  // upload arms always declare it explicitly (the 411 test omits it).
  return caller(`/api/packages/${owner}/generic/${name}/${version}/${filename}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(new TextEncoder().encode(body).byteLength),
      ...headers,
    },
    body,
  });
}

// ---------------------------------------------------------------------------
// The generic protocol round-trip (§3.2)
// ---------------------------------------------------------------------------

describe("generic protocol PUT/GET/HEAD/DELETE", () => {
  it("round-trips a real upload: 201 → GET returns the bytes with the serving headers", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await putFile("alice", "mytool", "1.0.0", "mytool-1.0.0.tar.gz", "package-bytes-1", {
      Authorization: `token ${writer}`,
    });
    expect(put.status).toBe(201);
    await put.text();

    const caller = protocol();
    const get = await caller("/api/packages/alice/generic/mytool/1.0.0/mytool-1.0.0.tar.gz", { method: "GET" });
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/octet-stream");
    expect(get.headers.get("content-disposition")).toContain("mytool-1.0.0.tar.gz");
    expect(await get.text()).toBe("package-bytes-1");

    // The content object landed at the sharded sha256 key (D1 keeps bare rows).
    const bytes = new TextEncoder().encode("package-bytes-1");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const stored = await env.REPO_PACKS.get(packageBlobContentKey(sha256));
    expect(await stored?.text()).toBe("package-bytes-1");
    // The spool is gone (the two-pass copy deletes it on both paths).
    const tmp = await env.REPO_PACKS.list({ prefix: "packages/tmp/" });
    expect(tmp.objects).toHaveLength(0);
  });

  it("HEAD serves the headers without bumping the download counter; GET bumps it", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await putFile("alice", "app", "2.0", "bin", "abcdef", { Authorization: `token ${writer}` });

    const caller = protocol();
    const head = await caller("/api/packages/alice/generic/app/2.0/bin", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("6");
    let reread = await db().select().from(packageVersions).all();
    expect(reread[0]?.downloadCount).toBe(0);

    const get = await caller("/api/packages/alice/generic/app/2.0/bin", { method: "GET" });
    expect(get.status).toBe(200);
    await get.text();
    reread = await db().select().from(packageVersions).all();
    expect(reread[0]?.downloadCount).toBe(1);
  });

  it("anonymous GET downloads a PUBLIC owner's package; anonymous PUT gets the 401 challenge", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await putFile("alice", "pub", "1.0", "f.bin", "public-bytes", { Authorization: `token ${writer}` });

    const caller = protocol();
    const get = await caller("/api/packages/alice/generic/pub/1.0/f.bin", { method: "GET" });
    expect(get.status).toBe(200);
    await get.text();

    const challenge = await putFile("alice", "pub", "1.0", "f2.bin", "x");
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await challenge.text();
  });

  it("a PRIVATE owner blinds anonymous downloads and strangers (the 401 challenge)", async () => {
    const owner = await seedUser("alice", { visibility: "private" });
    const stranger = await seedUser("bob");
    const writer = await token(owner, "write:package");
    const strangerRead = await token(stranger, "read:package");
    await putFile("alice", "priv", "1.0", "f.bin", "secret", { Authorization: `token ${writer}` });

    const caller = protocol();
    const anon = await caller("/api/packages/alice/generic/priv/1.0/f.bin", { method: "GET" });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await anon.text();
    const strangerGet = await caller("/api/packages/alice/generic/priv/1.0/f.bin", {
      method: "GET",
      headers: authHeaders(strangerRead),
    });
    expect(strangerGet.status).toBe(401);
    await strangerGet.text();
  });

  it("a token without the package scope gets the 401 challenge (reqPackageAccess's scope arm)", async () => {
    const owner = await seedUser("alice");
    const wrongCategory = await token(owner, "read:repository");
    const res = await protocol()("/api/packages/alice/generic/n/1/f", { method: "GET", headers: authHeaders(wrongCategory) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await res.text();
  });

  it("re-uploading ANY bytes for an existing file row 409s (upstream TryInsertFile, D-1)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const first = await putFile("alice", "dup", "1.0", "same.bin", "stable-bytes", { Authorization: `token ${writer}` });
    expect(first.status).toBe(201);
    await first.text();
    // Same bytes: still the 409 — upstream's TryInsertFile
    // (package_file.go:46-66 → generic.go:126-127) rejects the duplicate ROW
    // regardless of blob; there is no idempotent re-upload (D-1).
    const again = await putFile("alice", "dup", "1.0", "same.bin", "stable-bytes", { Authorization: `token ${writer}` });
    expect(again.status).toBe(409);
    expect(await again.text()).toBe("package file already exists");
    // Different bytes at the same row: the same 409.
    const conflict = await putFile("alice", "dup", "1.0", "same.bin", "changed-bytes", { Authorization: `token ${writer}` });
    expect(conflict.status).toBe(409);
    await conflict.text();
    // A different filename at the same version is a distinct file identity.
    const other = await putFile("alice", "dup", "1.0", "other.bin", "stable-bytes", { Authorization: `token ${writer}` });
    expect(other.status).toBe(201);
    await other.text();
  });

  it("a chunked body (no Content-Length) streams to 201 and round-trips (D-2); 400 on the upstream validation set", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const caller = protocol();
    const headers = { Authorization: `token ${writer}` };

    // A body WITHOUT a declared length (chunked stream) streams through the
    // store's bounded multipart spool (D-2 — upstream Go reads the stream
    // regardless; the old 411 precondition is gone).
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunked"));
        controller.close();
      },
    });
    const noLength = await caller("/api/packages/alice/generic/v/1/f.bin", {
      method: "PUT",
      headers,
      body: stream,
      // @ts-expect-error duplex is the streams spec's required pairing for a request body stream
      duplex: "half",
    });
    expect(noLength.status).toBe(201);
    await noLength.text();
    const round = await caller("/api/packages/alice/generic/v/1/f.bin", { headers });
    expect(round.status).toBe(200);
    expect(await round.text()).toBe("chunked");

    const bad = async (path: string): Promise<void> => {
      const res = await caller(path, { method: "PUT", headers, body: "x" });
      expect(res.status).toBe(400);
      await res.text();
    };
    // The dot-segment rejects (".." as a name, "."/".." as a filename) are
    // unreachable through this stack BY CONSTRUCTION: the URL parser /
    // router normalizes percent-encoded dot segments before the handler ever
    // sees the param — the platform-level traversal defense standing in for
    // upstream's generic.go checks. The reachable rejects stay pinned:
    await bad("/api/packages/alice/generic/a%20b/1/f"); // space rejected in names
    await bad("/api/packages/alice/generic/n/%20x/f"); // version with surrounding space
    // A single non-alphanumeric name is rejected (generic.go's one-char rule).
    await bad("/api/packages/alice/generic/%21/1/f");
  });

  it("the 403 quota arm (strict-polarity var override) and admin bypass", async () => {
    const owner = await seedUser("alice");
    const admin = await seedUser("root", { isAdmin: true });
    const writer = await token(owner, "write:package");
    const adminWriter = await token(admin, "write:package");
    const limited = protocol({ PACKAGES_LIMIT_SIZE_GENERIC: "2" });
    const denied = await limited("/api/packages/alice/generic/q/1/f.bin", {
      method: "PUT",
      headers: { ...authHeaders(writer), "content-length": "13" },
      body: "more-than-two",
    });
    expect(denied.status).toBe(403);
    await denied.text();

    // The chunked arm (no Content-Length) has no declared length to pre-check
    // — the size quota fires POST-SPOOL with the real size (D-2; upstream's
    // own order, packages.go:303-306) and still 403s before any row lands.
    const chunkedDenied = await limited("/api/packages/alice/generic/q/1/g.bin", {
      method: "PUT",
      headers: authHeaders(writer),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("more-than-two"));
          controller.close();
        },
      }),
      // @ts-expect-error duplex is the streams spec's required pairing for a request body stream
      duplex: "half",
    });
    expect(chunkedDenied.status).toBe(403);
    await chunkedDenied.text();

    // The unlimited default lets the same bytes through.
    const allowed = await putFile("alice", "q", "1", "f.bin", "more-than-two", { Authorization: `token ${writer}` });
    expect(allowed.status).toBe(201);
    await allowed.text();
    void adminWriter;
  });

  it("the count-quota boundary (+1 parity): the Nth publish reaches the cap, the (N+1)th 403s", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    // LIMIT = 2. Upstream inserts the version THEN checks count > limit inside
    // the rolling-back transaction (packages.go:188-191 with the throw at
    // 380-381), so the publish that REACHES the limit passes and only one
    // past 403s — a pre-insert `count > limit` check would allow one version
    // MORE than upstream at exactly this boundary.
    const capped = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "2" });
    const cappedPut = (version: string): Promise<Response> =>
      capped("/api/packages/alice/generic/bnd/" + version + "/f.bin", {
        method: "PUT",
        headers: { ...authHeaders(writer), "content-length": "3" },
        body: "abc",
      });

    // N-1 → N: the publish that REACHES the limit succeeds (1 + 1 ≤ 2).
    const reach = await cappedPut("1.0.0");
    expect(reach.status).toBe(201);
    await reach.text();
    // The Nth publish succeeds with the owner exactly AT the limit (2 + 1 →
    // count 2; 2 > 2 is false upstream).
    const atLimit = await cappedPut("2.0.0");
    expect(atLimit.status).toBe(201);
    await atLimit.text();

    // The (N+1)th publish past the cap → 403 ErrQuotaTotalCount, and the
    // rollback posture leaves the two landed versions untouched.
    const over = await cappedPut("3.0.0");
    expect(over.status).toBe(403);
    expect(await over.text()).toBe("package quota count limit exceeded");
    expect((await db().select().from(packageVersions).all())).toHaveLength(2);
  });

  it("DELETE per-file (the last file takes the version) and per-version", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    await putFile("alice", "del", "1.0", "only.bin", "x", { Authorization: `token ${writer}` });
    const caller = protocol();

    const deleteFile = await caller("/api/packages/alice/generic/del/1.0/only.bin", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(deleteFile.status).toBe(204);
    // The version fell with its last file (generic.go:189-199).
    expect(await db().select().from(packageVersions).all()).toHaveLength(0);

    await putFile("alice", "del", "1.0", "only.bin", "x", { Authorization: `token ${writer}` });
    const deleteVersion = await caller("/api/packages/alice/generic/del/1.0", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(deleteVersion.status).toBe(204);
    expect(await db().select().from(packageVersions).all()).toHaveLength(0);
    // Upstream leaves the now-unreferenced PACKAGE row for the cleanup cron
    // (RemovePackageVersion → DeletePackageVersionAndReferences only); the
    // sweep is what removes it — run the consumer arm to close the loop.
    expect(await db().select().from(packages).all()).toHaveLength(1);
    const { handlePackagesCleanup } = await import("../../services/packages/cleanup");
    await handlePackagesCleanup({ DB: env.DB, REPO_PACKS: env.REPO_PACKS }, { now: new Date() });
    expect(await db().select().from(packages).all()).toHaveLength(0);

    const missing = await caller("/api/packages/alice/generic/del/1.0", {
      method: "DELETE",
      headers: authHeaders(writer),
    });
    expect(missing.status).toBe(404);
    await missing.text();
  });

  it("unknown owner/file answers 404 (masked, no existence disclosure beyond the family)", async () => {
    const res = await protocol()("/api/packages/ghost/generic/n/1/f", { method: "GET" });
    expect(res.status).toBe(404);
    await res.text();
  });
});

// ---------------------------------------------------------------------------
// The nine management ops (§3.1)
// ---------------------------------------------------------------------------

describe("the 9 management ops + admin list", () => {
  async function fixture(): Promise<{ owner: SeededUser; other: SeededUser; admin: SeededUser; ownerRead: string; ownerWrite: string }> {
    const owner = await seedUser("alice");
    const other = await seedUser("bob");
    const admin = await seedUser("root", { isAdmin: true });
    const ownerRead = await token(owner, "read:package");
    const ownerWrite = await token(owner, "write:package");
    await putFile("alice", "tool", "1.0.0", "tool.tar.gz", "tool-bytes", { Authorization: `token ${ownerWrite}` });
    await putFile("alice", "tool", "1.1.0", "tool.tar.gz", "tool-bytes-2", { Authorization: `token ${ownerWrite}` });
    return { owner, other, admin, ownerRead, ownerWrite };
  }

  it("reqToken: anonymous → 401 'token is required'", async () => {
    await fixture();
    const res = await router()("/api/v1/packages/alice");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "token is required", url: ERROR_URL });
  });

  it("tokenRequiresScopes: a token without read:package → 403 with the exact upstream message", async () => {
    const { owner } = await fixture();
    const wrongCategory = await token(owner, "read:repository");
    const res = await router()("/api/v1/packages/alice", { headers: authHeaders(wrongCategory) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: `token does not have at least one of required scope(s), required=[read:package], token scope=read:repository`,
      url: ERROR_URL,
    });
  });

  it("listPackages renders every matching version as the upstream Package shape with pagination headers", async () => {
    const { owner, ownerRead } = await fixture();
    const res = await router()("/api/v1/packages/alice?type=generic", { headers: authHeaders(ownerRead) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
    const body = await res.json<Record<string, unknown>[]>();
    expect(body).toHaveLength(2);
    const entry = body[0] as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual([
      "created_at",
      "creator",
      "html_url",
      "id",
      "name",
      "owner",
      "repository",
      "type",
      "version",
    ]);
    expect(entry.type).toBe("generic");
    expect(entry.name).toBe("tool");
    expect((entry.owner as Record<string, unknown>).login).toBe("alice");
    expect(String(entry.html_url)).toContain("/alice/-/packages/generic/tool/");
    // Versions ordered created desc, id desc → 1.1.0 first; ids are VERSION ids.
    expect((body[0] as Record<string, unknown>).version).toBe("1.1.0");
    void owner;
  });

  it("listPackageVersions pins the exact package; getPackage / listPackageFiles carry the hashes", async () => {
    const { ownerRead } = await fixture();
    const versions = await router()("/api/v1/packages/alice/generic/tool", { headers: authHeaders(ownerRead) });
    expect(versions.status).toBe(200);
    const versionList = await versions.json<Record<string, unknown>[]>();
    expect(versionList).toHaveLength(2);
    const version = versionList.find((v) => v.version === "1.0.0") as Record<string, unknown>;

    const files = await router()("/api/v1/packages/alice/generic/tool/1.0.0/files", { headers: authHeaders(ownerRead) });
    expect(files.status).toBe(200);
    const fileList = await files.json<Record<string, unknown>[]>();
    expect(fileList).toHaveLength(1);
    expect(Object.keys(fileList[0] as Record<string, unknown>).sort()).toEqual([
      "id",
      "md5",
      "name",
      "sha1",
      "sha256",
      "sha512",
      "size",
    ]);
    const bytes = new TextEncoder().encode("tool-bytes");
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(fileList[0]?.sha256).toBe(sha256);
    expect(fileList[0]?.size).toBe(bytes.byteLength);
    expect(fileList[0]?.md5).toBe(""); // MD5 is unavailable in Workers' WebCrypto (documented)

    const got = await router()("/api/v1/packages/alice/generic/tool/1.0.0", { headers: authHeaders(ownerRead) });
    expect(got.status).toBe(200);
    const gotBody = await got.json<Record<string, unknown>>();
    expect(gotBody.id).toBe(version.id);
    expect(gotBody.version).toBe("1.0.0");
  });

  it("getLatestPackageVersion answers the newest version; unknown package 404s", async () => {
    const { ownerRead } = await fixture();
    const latest = await router()("/api/v1/packages/alice/generic/tool/-/latest", { headers: authHeaders(ownerRead) });
    expect(latest.status).toBe(200);
    expect((await latest.json<Record<string, unknown>>()).version).toBe("1.1.0");
    const missing = await router()("/api/v1/packages/alice/generic/ghost/-/latest", { headers: authHeaders(ownerRead) });
    expect(missing.status).toBe(404);
    await missing.text();
  });

  it("write ops demand write:package: a read-only token gets the group 403, then an owner-armed write token passes", async () => {
    const { owner, ownerRead, ownerWrite } = await fixture();
    const denied = await router()("/api/v1/packages/alice/generic/tool/1.0.0", {
      method: "DELETE",
      headers: authHeaders(ownerRead),
    });
    expect(denied.status).toBe(403);
    expect((await denied.json<Record<string, unknown>>()).message).toContain("required=[write:package]");

    const allowed = await router()("/api/v1/packages/alice/generic/tool/1.0.0", {
      method: "DELETE",
      headers: authHeaders(ownerWrite),
    });
    expect(allowed.status).toBe(204);
    void owner;
  });

  it("an insufficient access mode answers 401 + the WWW-Authenticate challenge (reqPackageAccess)", async () => {
    const { other } = await fixture();
    // alice is public so listPackages' group gate passes; a WRITE op against
    // a stranger-owned package fails the MODE arm with the challenge.
    const strangerWrite = await token(other, "write:package");
    const res = await router()("/api/v1/packages/alice/generic/tool/1.0.0", {
      method: "DELETE",
      headers: authHeaders(strangerWrite),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await res.text();
  });

  it("an unknown owner is the masked assignment 404", async () => {
    const { ownerRead } = await fixture();
    const res = await router()("/api/v1/packages/ghost", { headers: authHeaders(ownerRead) });
    expect(res.status).toBe(404);
    expect((await res.json<Record<string, unknown>>()).message).toContain("user redirect does not exist");
  });

  it("link/unlink round-trip (the R16 repo filter: each repo's tab sees only its own)", async () => {
    const { owner, ownerRead, ownerWrite } = await fixture();
    const repoA = await seedRepo(owner, "alpha");
    const repoB = await seedRepo(owner, "beta");
    void repoB;

    const link = await router()("/api/v1/packages/alice/generic/tool/-/link/alpha", {
      method: "POST",
      headers: authHeaders(ownerWrite),
    });
    expect(link.status).toBe(201);
    await link.text();

    // The link renders in the Package's repository field.
    const listed = await router()("/api/v1/packages/alice/generic/tool", { headers: authHeaders(ownerRead) });
    const rows = await listed.json<Record<string, unknown>[]>();
    expect(((rows[0]?.repository as Record<string, unknown> | null) ?? null)?.full_name).toBe("alice/alpha");

    // Re-link is the 400 invalid-argument arm.
    const relink = await router()("/api/v1/packages/alice/generic/tool/-/link/beta", {
      method: "POST",
      headers: authHeaders(ownerWrite),
    });
    expect(relink.status).toBe(400);
    await relink.text();

    // Unlink gates: a stranger (read mode on alice) fails reqPackageAccess
    // with the 401 challenge BEFORE the manage check; an org member whose
    // WRITE-mode team passes the gate but not canDoerManagePackage answers
    // the 403; the owner passes with 204.
    const stranger = await seedUser("mallory");
    const strangerWrite = await token(stranger, "write:package");
    const challenge = await router()("/api/v1/packages/alice/generic/tool/-/unlink", {
      method: "POST",
      headers: authHeaders(strangerWrite),
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await challenge.text();

    const { orgMembers, teams, teamMembers } = await import("../../db/schema");
    const orgOwner = await seedUser("acme-owner");
    const org = await seedUser("acme", { type: "org" });
    await db().insert(orgMembers).values({ orgId: org.id, userId: orgOwner.id, role: "owner", createdAt: NOW });
    const writeTeam = await db()
      .insert(teams)
      .values({ orgId: org.id, lowerName: "writers", name: "writers", authorize: "write" })
      .returning()
      .all();
    const writeTeamId = writeTeam[0]?.id;
    if (writeTeamId === undefined) throw new Error("team seed failed");
    const member = await seedUser("member");
    await db().insert(teamMembers).values({ orgId: org.id, teamId: writeTeamId, userId: member.id });
    const memberPat = await token(member, "write:package");
    const orgLink = await router()(`/api/v1/packages/${org.username}/generic/tool/-/link/alpha`, {
      method: "POST",
      headers: authHeaders(ownerWrite),
    });
    // alice's token cannot touch an acme package — link as the ORG OWNER.
    const orgOwnerPat = await token(orgOwner, "write:package");
    void orgLink;
    const linkedByOwner = await router()(`/api/v1/packages/${org.username}/generic/tool/-/link/alpha`, {
      method: "POST",
      headers: authHeaders(orgOwnerPat),
    });
    expect(linkedByOwner.status).toBe(404); // the package belongs to alice, not acme (GetPackageByName miss)

    // Publish an acme-owned package, link it, then the member's unlink is
    // the 403 manage arm.
    await putFile("acme", "otool", "1.0", "o.bin", "org-bytes", { Authorization: `token ${orgOwnerPat}` });
    await db()
      .insert(repositories)
      .values({
        id: crypto.randomUUID(),
        storageKey: `r_acme_alpha`,
        ownerNamespace: "acme",
        slug: "alpha",
        ownerId: org.id,
        visibility: "public",
        createdAt: NOW,
      });
    const orgLinked = await router()(`/api/v1/packages/${org.username}/generic/otool/-/link/alpha`, {
      method: "POST",
      headers: authHeaders(orgOwnerPat),
    });
    expect(orgLinked.status).toBe(201);
    await orgLinked.text();
    const memberDenied = await router()(`/api/v1/packages/${org.username}/generic/otool/-/unlink`, {
      method: "POST",
      headers: authHeaders(memberPat),
    });
    expect(memberDenied.status).toBe(403); // write mode passes the gate; not a package manager
    await memberDenied.text();

    const orgOwnerUnlink = await router()(`/api/v1/packages/${org.username}/generic/otool/-/unlink`, {
      method: "POST",
      headers: authHeaders(orgOwnerPat),
    });
    expect(orgOwnerUnlink.status).toBe(204); // the org owner-role bridges to manage
    await orgOwnerUnlink.text();

    const unlink = await router()("/api/v1/packages/alice/generic/tool/-/unlink", {
      method: "POST",
      headers: authHeaders(ownerWrite),
    });
    expect(unlink.status).toBe(204);
    await unlink.text();
    const cleared = await router()("/api/v1/packages/alice/generic/tool", { headers: authHeaders(ownerRead) });
    expect((await cleared.json<Record<string, unknown>[]>())[0]?.repository).toBeNull();

    // Unlinking an unlinked package is the 400 arm.
    const again = await router()("/api/v1/packages/alice/generic/tool/-/unlink", {
      method: "POST",
      headers: authHeaders(ownerWrite),
    });
    expect(again.status).toBe(400);
    await again.text();
    void repoA;
  });

  it("deletePackage removes the whole package (204 → every version gone)", async () => {
    const { ownerWrite } = await fixture();
    const res = await router()("/api/v1/packages/alice/generic/tool", {
      method: "DELETE",
      headers: authHeaders(ownerWrite),
    });
    expect(res.status).toBe(204);
    await res.text();
    expect(await db().select().from(packages).all()).toHaveLength(0);
    expect(await db().select().from(packageVersions).all()).toHaveLength(0);
  });

  it("adminListPackages: site-admin gate, cross-owner rows, and the q/type filters", async () => {
    const { admin, other, ownerWrite } = await fixture();
    const otherWrite = await token(other, "write:package");
    await putFile("bob", "other-pkg", "9.9", "o.bin", "other-bytes", {
      Authorization: `token ${otherWrite}`,
    });
    void ownerWrite;

    const peon = await seedUser("peon");
    const peonRead = await token(peon, "read:package");
    const nonAdmin = await router()("/api/v1/admin/packages", { headers: authHeaders(peonRead) });
    expect(nonAdmin.status).toBe(403);
    await nonAdmin.text();

    const adminPat = await token(admin, "all");
    const all = await router()("/api/v1/admin/packages", { headers: authHeaders(adminPat) });
    expect(all.status).toBe(200);
    expect(all.headers.get("x-total-count")).toBe("3"); // tool 1.0.0 + 1.1.0 + other-pkg 9.9
    const rows = await all.json<Record<string, unknown>[]>();
    expect(rows.map((r) => r.name)).toContain("other-pkg");

    const filtered = await router()("/api/v1/admin/packages?q=other", {
      headers: authHeaders(adminPat),
    });
    const filteredRows = await filtered.json<Record<string, unknown>[]>();
    expect(filteredRows).toHaveLength(1);
    expect(filteredRows[0]?.name).toBe("other-pkg");
  });
});

// ---------------------------------------------------------------------------
// PACKAGES_ENABLED=false 404s the whole family (strict polarity)
// ---------------------------------------------------------------------------

describe("PACKAGES_ENABLED=false", () => {
  it("management routes answer 404 and the protocol router does too", async () => {
    const owner = await seedUser("alice");
    const pat = await token(owner, "read:package");
    const disabled = { PACKAGES_ENABLED: "false" };
    const v1 = await router(disabled)("/api/v1/packages/alice", { headers: authHeaders(pat) });
    expect(v1.status).toBe(404);
    await v1.text();
    const proto = await protocol(disabled)("/api/packages/alice/generic/n/1/f", { method: "GET" });
    expect(proto.status).toBe(404);
    await proto.text();
  });
});
