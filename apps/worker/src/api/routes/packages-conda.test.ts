/**
 * The Conda registry ROUTE battery (SPEC-0016 §7's long-tail `conda` row)
 * on real D1 + the real REPO_PACKS binding — upstream
 * routers/api/packages/conda/conda.go at the pin, through the REAL mount
 * shape (the packages-terraform.test.ts precedent: index.ts mounts the
 * sub-app at /api/packages):
 *
 *  - the arms: PUT (201, the raw-body upload), repodata.json /
 *    current_repodata.json (200 application/json), the .bz2 repodata
 *    twins (200 application/x-bzip2 — the SAME body through the wall-3
 *    encoder, bz2-encode.ts, byte-decodable back to the plain render),
 *    the package download (200, the D-6 disposition, the sniffed
 *    application/x-bzip2, the HEAD ride, the GET-only bump);
 *  - the apiError family body: `{"reason": http.StatusText, "message"}`
 *    over application/json;charset=utf-8 — the 404-nil enumeration miss,
 *    the 400-nil foreign-filename upload, the corrupt-stream 500 (the
 *    prod-stripped message), the corrupt `.conda` container 500 (wall 2
 *    ADOPTED — the zip parse fires CondaArchiveError), the invalid-name
 *    400, the duplicate 409;
 *  - the chi walk: the channel-prefixed and NESTED-channel paths (the
 *    `(.*?/)?` optional wildcard), the empty/short paths' NotFound page;
 *  - the gates: anonymous write → 401 + the Basic challenge, anonymous read
 *    of a public owner → 200, a private owner's stranger 401, the size
 *    quota 403 with the admin bypass, PACKAGES_ENABLED=false → 404.
 *
 * The fixtures are the REAL system-bzip2 conda packages (bzip2 1.0.8 -9,
 * embedded base64 — the conda.test.ts authoring note).
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { packageVersions, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { mintFor } from "../../auth/testing/seeds";
import { bzip2Decompress } from "../../services/packages/bz2";
import { base64ToBytes } from "../../services/packages/distro-common";

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
});

const db = () => drizzle(env.DB);

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

async function seedUser(
  username: string,
  opts: { isAdmin?: boolean; visibility?: "public" | "limited" | "private" } = {},
): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: opts.isAdmin ?? false,
      status: "active",
      type: "user",
      visibility: opts.visibility ?? "public",
      createdAt: new Date("2026-11-01T12:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username, isAdmin: user.isAdmin };
}

async function token(user: SeededUser, scopes: string): Promise<string> {
  return (await mintFor(user.id, `pat-${scopes}`, scopes)).plaintext;
}

const authHeaders = (plaintext: string): Record<string, string> => ({
  Authorization: `token ${plaintext}`,
});

/** The REAL mount shape: index.ts mounts the sub-app at /api/packages. */
function protocol(overrides: Record<string, string> = {}) {
  const parent = new Hono<{ Bindings: Env }>();
  parent.route("/api/packages", createEcosystemProtocolRouter());
  const boundEnv = { ...env, ...overrides };
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://example.com${path}`, init), boundEnv);
}

/** numpy 1.26.0 / linux-64 — index.json + about.json, the full form. */
const F1_FULL = "QlpoOTFBWSZTWfWVxcoAAX//gsaQAiBQF//3PAFqCv//3+pAAAIIQAH8kTWyGiaTKT9U2T0hmkNE9IYmmh6h6QHqaG1ANIEwmk0aekZAAjIMBGjEBtA5hMAmAEwmE0wAACZNNAwkkTEmSehpMEYIDQA0aA0A002nUjzPS4YC6oIjSzMkhp0hCw4sDpJGJWDEi2TATiLqGQA5My2dzPFMjWhy/WLu9X46iMqPZGrPhHKcGVOXuuW1mt6heVGo+EiYPf5W9wGrCB+GSEYMKUoz81AKxytLYVJl6GRdkIRMybtOaJDtb90hPja6rESJddCTzJwrkSKrWhkjBrohxwEj1NeQ0IoYRAQyJDhFFnH2PmRBpI6XNOi88RbioNJ6KhEdPhq04MyHSRUikVwcOYQwtxRV+m2tVjPPOIsDhETPXMQLSRlq8noUloVocPUHQYX2zV13bGkNoq19/Vxisd9JMZB+KIbxv5buJsEdfIJwQYsGDvZ2aJILNcsgO39jJLJ0Q/fXeLAMmqF0KhakF46lHHpFIU4pMcPE8yHeXUEGQMYjhSYYlIep39Zloie4IiY8OWGcYJmjJdQJZgPBGVTzmHUEGez3CZEnvmzsJgx3I0sygbuJX43iqvM0h04wJgDzzOoryooJ0REkWSEAlcqUsMGSQCLfRoY6yKXxsJ7I8AnXDEIhEQXYB6wa0EdVyVS1vkJs1sA9oVNCDCw75a2ow2YldrlR/IuE00dtDjDlcD2ymyVKAP8XckU4UJD1lcXK";
/** zlib 1.2.13 / noarch — index.json only. */
const F2_MINIMAL = "QlpoOTFBWSZTWTXyhRMAALj7hsSQACBQBf+QIAj/d5/aAARAAAAIMADa0wlTUNA1ND1MmQ9QaGmmmjGoJVM0iepmk00xMAQ0BiAJKSNMQxG0Jk0GjRiGmFJ53cYc3RggIHhCQ11DXmm9ms2BEMEgcMXCEvIDuuPrxb2ltSwXmkAnAHOywG1KNoNQDtbUKQFG1YOcsvx5EjGigY0cWBAlqDRHpFrUChIpowWsIWKEK0LMSm/7jKVhyxJukafqIi6bIJWF+j9J3NHy51FC1JloNYuQTCBK3sJ5FVkzyJw8nhpuWJBoLuSKcKEga+UKJg==";
/** index.json name "NumPy" — the lowercase gate. */
const F3_BAD_NAME = "QlpoOTFBWSZTWUsa8WYAAKf/gsKQACBQBf+QAAFgCG9zn+pAAAAIMAC1UJUnpRptIYmTJkBpiZB7SgkoNQm1NDIAYgABoYAGjQ0YRk0GjTQGbTlKuqJRgkBOJzkIQzIsfYSrYmRkHCQPFQaehB9tF6LZLZuX2b+DCMLogPF9AxoRDkCuTy8ufMOCaknC+55QMqoQg4HDUYgjEIUry8K/poCan6NFDGSC8ofuZOrFNiazzjBxGPgSzCjsMzMJB/F3JFOFCQSxrxZg";
/** f1 truncated mid-stream — the corrupt-archive class. */
const F6_CORRUPT = "QlpoOTFBWSZTWfWVxcoAAX//gsaQAiBQF//3PAFqCv//3+pAAAIIQAH8kTWyGiaTKT9U2T0hmkNE9IYmmh6h6QHqaG1ANIEwmk0aekZAAjIMBGjEBtA5hMAmAEwmE0wAACZNNAwkkTEmSehpMEYIDQA0aA0A002n";

const fixtureBytes = (base64: string): Uint8Array => base64ToBytes(base64);

async function put(
  call: (path: string, init?: RequestInit) => Promise<Response>,
  user: string,
  path: string,
  bytes: Uint8Array,
  auth?: Record<string, string>,
): Promise<Response> {
  return call(`/api/packages/${user}/conda${path}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", ...(auth ?? {}) },
    body: bytes.slice() as unknown as BodyInit,
  });
}

// ---------------------------------------------------------------------------
// The endpoint round-trip
// ---------------------------------------------------------------------------

describe("conda routes (api.go:263-267)", () => {
  it("upload 201 → repodata 200 → download byte parity → the counter bump → HEAD rides", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();
    const auth = authHeaders(writer);
    const bytes = fixtureBytes(F1_FULL);

    const uploaded = await put(call, "alice", "/pkg.tar.bz2", bytes, auth);
    expect(uploaded.status).toBe(201);
    await uploaded.text();

    // The repodata (the default channel, the linux-64 subdir).
    const repodata = await call("/api/packages/alice/conda/linux-64/repodata.json", { headers: auth });
    expect(repodata.status).toBe(200);
    expect(repodata.headers.get("content-type")).toBe("application/json");
    const body = await repodata.text();
    expect(body.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(body) as { info: { subdir: string }; packages: Record<string, unknown> };
    expect(Object.keys(parsed)).toEqual(["info", "packages", "packages.conda", "removed"]);
    expect(parsed.info).toEqual({ subdir: "linux-64" });
    const entry = parsed.packages["numpy-1.26.0-py3h_0.tar.bz2"] as Record<string, unknown>;
    expect(Object.keys(entry)).toEqual([
      "name",
      "version",
      "noarch",
      "subdir",
      "timestamp",
      "build",
      "build_number",
      "depends",
      "license",
      "license_family",
      "md5",
      "sha256",
      "size",
    ]);
    expect(entry["name"]).toBe("numpy");
    expect(entry["md5"]).toBe("");

    // current_repodata.json shares the enumeration.
    const current = await call("/api/packages/alice/conda/linux-64/current_repodata.json", { headers: auth });
    expect(current.status).toBe(200);
    expect(await current.text()).toBe(body);

    // The package download: byte parity, the sniffed bzip2 type, the D-6
    // disposition shape.
    const download = await call("/api/packages/alice/conda/linux-64/numpy-1.26.0-py3h_0.tar.bz2", { headers: auth });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/x-bzip2");
    expect(download.headers.get("content-disposition")).toContain("numpy-1.26.0-py3h_0.tar.bz2");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(bytes);

    // The GET-only counter bump (one GET so far).
    const versions = await db().select().from(packageVersions).all();
    expect(versions[0]?.downloadCount).toBe(1);

    // HEAD rides the download walk with no body and no second bump.
    const head = await call("/api/packages/alice/conda/linux-64/numpy-1.26.0-py3h_0.tar.bz2", {
      method: "HEAD",
      headers: auth,
    });
    expect(head.status).toBe(200);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect((await db().select().from(packageVersions).all())[0]?.downloadCount).toBe(1);

    // HEAD rides the repodata walk too.
    const headRepo = await call("/api/packages/alice/conda/linux-64/repodata.json", { method: "HEAD", headers: auth });
    expect(headRepo.status).toBe(200);
    expect((await headRepo.arrayBuffer()).byteLength).toBe(0);
  });

  it("the channel arms: a channel-prefixed upload, a NESTED channel walk, and the per-channel repodata split", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();
    const auth = authHeaders(writer);

    const channeled = await put(call, "alice", "/mychannel/pkg.tar.bz2", fixtureBytes(F1_FULL), auth);
    expect(channeled.status).toBe(201);
    await channeled.text();
    const nested = await put(call, "alice", "/a/b/pkg.tar.bz2", fixtureBytes(F2_MINIMAL), auth);
    expect(nested.status).toBe(201);
    await nested.text();

    // The channel repodata walks: mychannel under one segment, a/b nested.
    const mine = await call("/api/packages/alice/conda/mychannel/linux-64/repodata.json", { headers: auth });
    expect(mine.status).toBe(200);
    expect(Object.keys((JSON.parse(await mine.text()) as { packages: Record<string, unknown> }).packages)).toEqual([
      "numpy-1.26.0-py3h_0.tar.bz2",
    ]);

    const deep = await call("/api/packages/alice/conda/a/b/noarch/repodata.json", { headers: auth });
    expect(deep.status).toBe(200);
    expect(Object.keys((JSON.parse(await deep.text()) as { packages: Record<string, unknown> }).packages)).toEqual([
      "zlib-1.2.13-h0.tar.bz2",
    ]);

    // The default-channel repodata misses both; the wrong subdir too.
    const emptyDefault = await call("/api/packages/alice/conda/linux-64/repodata.json", { headers: auth });
    expect(emptyDefault.status).toBe(404);
    expect(await emptyDefault.text()).toBe('{"reason":"Not Found","message":""}');
    const wrongSubdir = await call("/api/packages/alice/conda/mychannel/noarch/repodata.json", { headers: auth });
    expect(wrongSubdir.status).toBe(404);

    // The channel-prefixed DOWNLOAD rides the same walk.
    const download = await call("/api/packages/alice/conda/mychannel/linux-64/numpy-1.26.0-py3h_0.tar.bz2", {
      headers: auth,
    });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(fixtureBytes(F1_FULL));
  });

  it("the two-file enumeration sorts the map keys and splits nothing (.tar.bz2 only)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();
    const auth = authHeaders(writer);
    await put(call, "alice", "/zlib.tar.bz2", fixtureBytes(F2_MINIMAL), auth);
    await put(call, "alice", "/numpy.tar.bz2", fixtureBytes(F1_FULL), auth);
    // Two subdirs → each repodata carries its own file only.
    const noarch = JSON.parse(
      await (await call("/api/packages/alice/conda/noarch/repodata.json", { headers: auth })).text(),
    ) as { packages: Record<string, unknown>; "packages.conda": Record<string, unknown> };
    expect(Object.keys(noarch.packages)).toEqual(["zlib-1.2.13-h0.tar.bz2"]);
    expect(noarch["packages.conda"]).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The error-family arms
// ---------------------------------------------------------------------------

describe("conda route error arms", () => {
  it("the upload gates: foreign filename 400-nil, the corrupt .conda container 500, corrupt stream 500, invalid name 400, duplicate 409", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();
    const auth = authHeaders(writer);

    // A non-conda filename is the 400-nil (conda.go:191-194).
    const foreign = await put(call, "alice", "/pkg.zip", fixtureBytes(F1_FULL), auth);
    expect(foreign.status).toBe(400);
    expect(await foreign.text()).toBe('{"reason":"Bad Request","message":""}');

    // Wall 2 ADOPTED: the `.conda` container is PARSED, so bzip2 bytes
    // under a .conda name are a corrupt zip — the CondaArchiveError 500 arm
    // (upstream ParsePackageConda's zip-failure path; the prod-stripped
    // message). A missing info member would still be the 400 structure arm.
    const conda = await put(call, "alice", "/pkg.conda", fixtureBytes(F1_FULL), auth);
    expect(conda.status).toBe(500);
    expect(await conda.text()).toBe(
      '{"reason":"Internal Server Error","message":"internal server error"}',
    );

    // A corrupt stream is the 500 arm (the prod-stripped message).
    const corrupt = await put(call, "alice", "/broken.tar.bz2", fixtureBytes(F6_CORRUPT), auth);
    expect(corrupt.status).toBe(500);
    expect(await corrupt.text()).toBe(
      '{"reason":"Internal Server Error","message":"internal server error"}',
    );

    // The lowercase gate → the ErrInvalidName 400.
    const badName = await put(call, "alice", "/bad.tar.bz2", fixtureBytes(F3_BAD_NAME), auth);
    expect(badName.status).toBe(400);
    expect(await badName.text()).toBe('{"reason":"Bad Request","message":"package name is invalid"}');

    // The duplicate stored name is the 409.
    await put(call, "alice", "/first.tar.bz2", fixtureBytes(F1_FULL), auth);
    const again = await put(call, "alice", "/second.tar.bz2", fixtureBytes(F1_FULL), auth);
    expect(again.status).toBe(409);
    expect(await again.text()).toBe('{"reason":"Conflict","message":"package file already exists"}');

    // Nothing half-stored: only the one good upload's rows exist.
    expect(await db().select().from(packageVersions).all()).toHaveLength(1);
  });

  it("the .bz2 repodata twins answer the SAME body compressed (wall 3 adopted, conda.go:170-183); unknown filenames and short paths still ride the chi NotFound page", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();
    const auth = authHeaders(writer);
    await put(call, "alice", "/pkg.tar.bz2", fixtureBytes(F1_FULL), auth);

    // The .bz2 twins: 200 application/x-bzip2, decoding back to the exact
    // plain repodata render (the wall-3 encoder over the same body).
    for (const [jsonName, bz2Name] of [
      ["repodata.json", "repodata.json.bz2"],
      ["current_repodata.json", "current_repodata.json.bz2"],
    ] as const) {
      const plain = await call(`/api/packages/alice/conda/linux-64/${jsonName}`, { headers: auth });
      expect(plain.status).toBe(200);
      expect(plain.headers.get("content-type")).toBe("application/json");
      const compressed = await call(`/api/packages/alice/conda/linux-64/${bz2Name}`, { headers: auth });
      expect(compressed.status).toBe(200);
      expect(compressed.headers.get("content-type")).toBe("application/x-bzip2");
      const body = await compressed.arrayBuffer();
      expect(body.byteLength).toBeGreaterThan(0);
      const decoded = bzip2Decompress(new Uint8Array(body));
      expect(new TextDecoder().decode(decoded)).toBe(await plain.text());
    }

    // The empty-channel enumeration misses → the .bz2 twin 404-nil JSON
    // (the same apiError shape as the plain name).
    const miss = await call("/api/packages/alice/conda/noarch/repodata.json.bz2", { headers: auth });
    expect(miss.status).toBe(404);
    expect(miss.headers.get("content-type")).toBe("application/json;charset=utf-8");

    // A foreign filename in the download path — the same page.
    const stranger = await call("/api/packages/alice/conda/linux-64/something.txt", { headers: auth });
    expect(stranger.status).toBe(404);
    expect(await stranger.text()).toBe("404 page not found\n");

    // A single-segment GET matches no pattern; an EMPTY segment neither.
    const short = await call("/api/packages/alice/conda/pkg.tar.bz2", { headers: auth });
    expect(short.status).toBe(404);
    expect(await short.text()).toBe("404 page not found\n");
    const empty = await call("/api/packages/alice/conda/linux-64//repodata.json", { headers: auth });
    expect(empty.status).toBe(404);
    expect(await empty.text()).toBe("404 page not found\n");

    // A one-segment PUT is the empty-channel arm (the `(.*?/)?` optional
    // wildcard) — it works and lands under the bare name.
    const bare = await put(call, "alice", "/bare.tar.bz2", fixtureBytes(F2_MINIMAL), auth);
    expect(bare.status).toBe(201);
    await bare.text();
    const bareRepo = await call("/api/packages/alice/conda/noarch/repodata.json", { headers: auth });
    expect(bareRepo.status).toBe(200);
  });

  it("a PUT upload that uploads with a trailing-slash path answers the NotFound page", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();
    const trailing = await put(call, "alice", "/pkg.tar.bz2/", fixtureBytes(F1_FULL), authHeaders(writer));
    expect(trailing.status).toBe(404);
    expect(await trailing.text()).toBe("404 page not found\n");
  });
});

// ---------------------------------------------------------------------------
// Auth / quota / the family switch
// ---------------------------------------------------------------------------

describe("conda auth/quota arms", () => {
  it("an anonymous write is the 401 challenge; a PUBLIC owner's reads answer anonymously", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const call = protocol();

    const anonPut = await put(call, "alice", "/pkg.tar.bz2", fixtureBytes(F1_FULL));
    expect(anonPut.status).toBe(401);
    expect(anonPut.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await anonPut.text();

    await put(call, "alice", "/pkg.tar.bz2", fixtureBytes(F1_FULL), authHeaders(writer));
    const read = await call("/api/packages/alice/conda/linux-64/repodata.json");
    expect(read.status).toBe(200);
    await read.text();
    const download = await call("/api/packages/alice/conda/linux-64/numpy-1.26.0-py3h_0.tar.bz2");
    expect(download.status).toBe(200);
    await download.arrayBuffer();
  });

  it("a PRIVATE owner's conda paths are the stranger's 401 challenge, 200 for the owner's token", async () => {
    const stealth = await seedUser("stealth", { visibility: "private" });
    const writer = await token(stealth, "write:package");
    const call = protocol();
    await put(call, "stealth", "/pkg.tar.bz2", fixtureBytes(F1_FULL), authHeaders(writer));

    const stranger = await seedUser("stranger");
    const strangerToken = await token(stranger, "write:package");
    const denied = await call("/api/packages/stealth/conda/linux-64/repodata.json", {
      headers: authHeaders(strangerToken),
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await denied.text();

    const own = await call("/api/packages/stealth/conda/linux-64/repodata.json", { headers: authHeaders(writer) });
    expect(own.status).toBe(200);
    await own.text();
  });

  it("the size quota 403 with the admin bypass; PACKAGES_ENABLED=false 404s the family", async () => {
    const owner = await seedUser("alice");
    const admin = await seedUser("root", { isAdmin: true });
    const writer = await token(owner, "write:package");
    const adminWriter = await token(admin, "write:package");
    const capped = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "1" });

    const denied = await put(capped, "alice", "/pkg.tar.bz2", fixtureBytes(F1_FULL), authHeaders(writer));
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe('{"reason":"Forbidden","message":"maximum allowed package storage quota exceeded"}');

    const bypass = await put(capped, "root", "/pkg.tar.bz2", fixtureBytes(F1_FULL), authHeaders(adminWriter));
    expect(bypass.status).toBe(201);
    await bypass.text();

    const disabled = protocol({ PACKAGES_ENABLED: "false" });
    const dead = await put(disabled, "alice", "/pkg.tar.bz2", fixtureBytes(F1_FULL), authHeaders(writer));
    expect(dead.status).toBe(404);
    await dead.text();
  });
});
