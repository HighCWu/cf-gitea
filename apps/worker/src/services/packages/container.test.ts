/**
 * The OCI container registry battery (SPEC-0016 §7 M6) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/container/* at the pin:
 *
 *  - the 401 handshake (container.go:116-130): the anonymous /v2/ ping
 *    answers the Bearer realm challenge; a private owner's path adds the
 *    Basic realm="Gitea Container Registry" twin; the access-denied arms
 *    answer the shared Gitea-Package-API challenge (api.go:51-61);
 *  - the token flow (auth.go): anonymous → the ghost JWT (userId -1),
 *    a scoped PAT → the HS256 mint, a non-package scope → 401;
 *  - the blob flow (container.go:236-488): POST → PATCH chunks (declared
 *    AND chunked/unknown-length bodies through the bounded spool) → PUT with
 *    digest verification + the mismatch/416/stream-upload arms, the session
 *    status probe, the abort, single-POST, cross-repo mount;
 *  - manifests (manifest.go): the tagged round-trip, the metadata parse, the
 *    BLOB_UNKNOWN/SIZE_INVALID/UNSUPPORTED/invalid-tag/MediaType arms, the
 *    overwrite re-push, delete-by-tag, the multi-arch index;
 *  - the tag list + catalog pagination, quota 403s, PACKAGES_ENABLED=false,
 *    and the expired-upload sweep.
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { packageBlobUploads, packageVersions, users } from "../../db/schema";
import { createContainerProtocolRouter } from "../../api/routes/packages-protocols";
import { mintFor } from "../../auth/testing/seeds";
import {
  cleanupExpiredContainerUploads,
  createContainerBlobUpload,
  resetContainerTokenCacheForTests,
  verifyContainerToken,
  CONTAINER_GHOST_USER_ID,
} from "./container";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "package_blob_uploads",
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
  // NOTE: system_keystore is deliberately NOT wiped — the module-level
  // signing-secret cache must stay consistent with the row.
  for (const prefix of ["packages/tmp/", "packages/blobs/", "packages/uploads/"]) {
    const listed = await env.REPO_PACKS.list({ prefix });
    await env.REPO_PACKS.delete(listed.objects.map((object) => object.key));
  }
  resetContainerTokenCacheForTests();
});

const db = () => drizzle(env.DB);

const OWNER = "containerowner";
const IMAGE = "app";

async function seedUser(
  username: string,
  opts: { isAdmin?: boolean; visibility?: "public" | "limited" | "private" } = {},
): Promise<{ id: number; username: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: opts.isAdmin ?? false,
      status: "active",
      type: "user",
      visibility: opts.visibility ?? "public",
      createdAt: new Date("2026-10-30T12:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username };
}

async function token(userId: number, scopes: string): Promise<string> {
  return (await mintFor(userId, `pat-${scopes.replace(/[^a-z]/g, "")}`, scopes)).plaintext;
}

/** The REAL mount shape: index.ts mounts the sub-app at /v2 (HANDOFF). */
function protocol(overrides: Record<string, string> = {}) {
  const parent = new Hono<{ Bindings: Env }>();
  parent.route("/v2", createContainerProtocolRouter());
  const boundEnv = { ...env, ...overrides };
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://example.com${path}`, init), boundEnv);
}

// ---------------------------------------------------------------------------
// OCI helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const sha256 = async (bytes: Uint8Array): Promise<string> => `sha256:${await sha256Hex(bytes)}`;

interface OciError {
  errors: { code: string; message: string }[];
}

async function readOciError(response: Response): Promise<OciError> {
  return response.json<OciError>();
}

/** Push a blob through the single-POST arm; returns its digest. */
async function pushBlob(
  call: (path: string, init?: RequestInit) => Promise<Response>,
  auth: Record<string, string>,
  bytes: Uint8Array,
  image = IMAGE,
  owner = OWNER,
): Promise<string> {
  const digest = await sha256(bytes);
  const response = await call(`/v2/${owner}/${image}/blobs/uploads/?digest=${digest}`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  expect(response.status).toBe(201);
  return digest;
}

/** The manifest document for a config + layers. */
async function buildManifest(
  configDigest: string,
  configSize: number,
  layers: { mediaType: string; digest: string; size: number }[],
  mediaType = "application/vnd.oci.image.manifest.v1+json",
): Promise<{ text: string; bytes: Uint8Array; digest: string }> {
  const text = JSON.stringify({
    schemaVersion: 2,
    mediaType,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: configDigest, size: configSize },
    layers,
  });
  const bytes = encoder.encode(text);
  return { text, bytes, digest: await sha256(bytes) };
}

/** The standard image config with OCI labels (the metadata-parse input). */
function imageConfigBytes(): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: {
        labels: {
          "org.opencontainers.image.description": "the test image",
          "org.opencontainers.image.licenses": "MIT",
          "org.opencontainers.image.url": "https://example.com/project",
        },
      },
      history: [
        { created_by: "#(nop) ADD file:abc in /" },
        { created_by: 'CMD ["/bin/sh"]' },
      ],
    }),
  );
}

const basicAuth = (plaintext: string): Record<string, string> => ({
  Authorization: `Basic ${btoa(`${plaintext}:`)}`,
});

const bearerAuth = (jwt: string): Record<string, string> => ({
  Authorization: `Bearer ${jwt}`,
});

/** Mint a PAT then exchange it at /v2/token for the container JWT. */
async function bearerFor(
  call: (path: string, init?: RequestInit) => Promise<Response>,
  pat: string,
): Promise<string> {
  const response = await call("/v2/token", { headers: basicAuth(pat) });
  expect(response.status).toBe(200);
  const body = await response.json<{ token: string }>();
  return body.token;
}

// ---------------------------------------------------------------------------
// The handshake + token flow
// ---------------------------------------------------------------------------

describe("container 401 handshake + token flow", () => {
  it("answers the anonymous /v2/ ping with the Bearer realm challenge (container.go:116-130)", async () => {
    const call = protocol();
    const response = await call("/v2/");
    expect(response.status).toBe(401);
    expect(response.headers.get("Docker-Distribution-Api-Version")).toBe("registry/2.0");
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="https://example.com/v2/token",service="container_registry",scope="*"',
    );
    const body = await readOciError(response);
    expect(body.errors[0]?.code).toBe("UNAUTHORIZED");
    expect(body.errors[0]?.message).toBe("");
  });

  it("accepts the ping on both slash shapes and with the ghost token", async () => {
    const call = protocol();
    const bare = await call("/v2");
    expect(bare.status).toBe(401); // no auth yet
    const tokenResponse = await call("/v2/token");
    expect(tokenResponse.status).toBe(200);
    const { token: ghost } = await tokenResponse.json<{ token: string }>();
    const claims = await verifyContainerToken(env.DB, ghost);
    expect(claims).not.toBeNull();
    expect(claims?.userId).toBe(CONTAINER_GHOST_USER_ID);
    expect(claims?.scope).toBe("");
    const ping = await call("/v2/", { headers: bearerAuth(ghost) });
    expect(ping.status).toBe(200);
    expect(ping.headers.get("Docker-Distribution-Api-Version")).toBe("registry/2.0");
  });

  it("rejects an invalid bearer at the auth layer (afterAuthCallback)", async () => {
    const call = protocol();
    const response = await call("/v2/", { headers: bearerAuth("not.a.jwt") });
    expect(response.status).toBe(401);
    expect((await readOciError(response)).errors[0]?.code).toBe("UNAUTHORIZED");
  });

  it("mints the ghost token for anonymous and the user token for a scoped PAT", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const pat = await token(user.id, "write:package");
    const jwt = await bearerFor(call, pat);
    const claims = await verifyContainerToken(env.DB, jwt);
    expect(claims?.userId).toBe(user.id);
    // The minted scope carries the package grant (auth.go GetAccessScope).
    expect(claims?.scope).toContain("write:package");
  });

  it("401s a PAT without a package scope at /token (container.go:165-176)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const pat = await token(user.id, "read:user");
    const response = await call("/v2/token", { headers: basicAuth(pat) });
    expect(response.status).toBe(401);
    expect((await readOciError(response)).errors[0]?.code).toBe("UNAUTHORIZED");
  });

  it("treats any package scope (read) as mintable and the token as pull-capable", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const pat = await token(user.id, "read:package");
    const jwt = await bearerFor(call, pat);
    const ping = await call("/v2/", { headers: bearerAuth(jwt) });
    expect(ping.status).toBe(200);
  });

  it("adds the Basic realm twin on a private owner's path (container.go:121-128)", async () => {
    const call = protocol();
    await seedUser(OWNER, { visibility: "private" });
    const response = await call(`/v2/${OWNER}/app/tags/list`, { headers: bearerAuth("bad.token.here") });
    expect(response.status).toBe(401);
    const challenges = response.headers.get("WWW-Authenticate");
    expect(challenges).toContain('Bearer realm="https://example.com/v2/token"');
    expect(challenges).toContain('Basic realm="Gitea Container Registry"');
    expect((await readOciError(response)).errors[0]?.code).toBe("UNAUTHORIZED");
  });

  it("answers an anonymous gated arm with the shared Gitea-Package-API challenge (api.go:51-61)", async () => {
    const call = protocol();
    await seedUser(OWNER, { visibility: "private" });
    const response = await call(`/v2/${OWNER}/app/tags/list`);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Basic realm="Gitea Package API"');
    expect(await response.text()).toContain("user should have specific permission");
  });

  it("serves a public owner's tags to the ghost token (anonymous pull)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    // The tag list requires the package to exist (container.go:738-745's
    // GetPackageByName gate — a never-pushed image answers NAME_UNKNOWN).
    const auth = basicAuth(await token(user.id, "write:package"));
    const configDigest = await pushBlob(call, auth, imageConfigBytes());
    const manifest = await buildManifest(configDigest, imageConfigBytes().byteLength, []);
    await call(`/v2/${OWNER}/${IMAGE}/manifests/latest`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: manifest.bytes,
    });
    const ghost = ((await (await call("/v2/token")).json<{ token: string }>())).token;
    const response = await call(`/v2/${OWNER}/${IMAGE}/tags/list`, { headers: bearerAuth(ghost) });
    expect(response.status).toBe(200);
    const body = await response.json<{ name: string; tags: string[] }>();
    expect(body.tags).toEqual(["latest"]);
  });

  it("keeps the POST /token stub a 404 (AuthenticateNotImplemented)", async () => {
    const call = protocol();
    const response = await call("/v2/token", { method: "POST" });
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The blob flow
// ---------------------------------------------------------------------------

describe("container blob uploads", () => {
  it("walks POST → PATCH chunks → PUT with digest verification (container.go:236-466)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));

    const created = await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/`, { method: "POST", headers: auth });
    expect(created.status).toBe(202);
    const location = created.headers.get("Location");
    const uuid = created.headers.get("Docker-Upload-Uuid");
    expect(location).toBe(`/v2/${OWNER}/${IMAGE}/blobs/uploads/${uuid}`);

    const chunk1 = encoder.encode("hello ");
    const chunk2 = encoder.encode("world");
    const patch1 = await call(location ?? "", {
      method: "PATCH",
      headers: { ...auth, "Content-Range": "0-5", "Content-Length": String(chunk1.byteLength) },
      body: chunk1,
    });
    expect(patch1.status).toBe(202);
    expect(patch1.headers.get("Range")).toBe("0-5");
    expect(patch1.headers.get("Docker-Upload-Uuid")).toBe(uuid);

    const patch2 = await call(location ?? "", {
      method: "PATCH",
      headers: { ...auth, "Content-Range": "6-10", "Content-Length": String(chunk2.byteLength) },
      body: chunk2,
    });
    expect(patch2.status).toBe(202);
    expect(patch2.headers.get("Range")).toBe("0-10");

    // The status probe (container.go:324-348).
    const status = await call(location ?? "", { method: "GET", headers: auth });
    expect(status.status).toBe(204);
    expect(status.headers.get("Range")).toBe("0-10");

    const whole = new Uint8Array([...chunk1, ...chunk2]);
    const digest = await sha256(whole);
    const finalized = await call(`${location}?digest=${digest}`, { method: "PUT", headers: auth });
    expect(finalized.status).toBe(201);
    expect(finalized.headers.get("Docker-Content-Digest")).toBe(digest);
    expect(finalized.headers.get("ETag")).toBe(`"${digest}"`);
    expect(finalized.headers.get("Location")).toBe(`/v2/${OWNER}/${IMAGE}/blobs/${digest}`);

    // The session is gone; the blob serves with byte parity.
    const statusGone = await call(location ?? "", { method: "GET", headers: auth });
    expect(statusGone.status).toBe(404);
    expect((await readOciError(statusGone)).errors[0]?.code).toBe("BLOB_UPLOAD_UNKNOWN");

    const head = await call(`/v2/${OWNER}/${IMAGE}/blobs/${digest}`, { method: "HEAD", headers: auth });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(head.headers.get("Content-Length")).toBe(String(whole.byteLength));
    expect(head.headers.get("Docker-Content-Digest")).toBe(digest);

    const got = await call(`/v2/${OWNER}/${IMAGE}/blobs/${digest}`, { headers: auth });
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(whole);

    // The staging file row: the internal _upload version carries the
    // sha256_<hash> file with its digest property (blob.go:135-160).
    const rows = await db()
      .select({ version: packageVersions })
      .from(packageVersions)
      .where(eq(packageVersions.isInternal, true))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version.lowerVersion).toBe("_upload");
  });

  it("answers a digest mismatch at PUT with DIGEST_INVALID and keeps the session", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const created = await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/`, { method: "POST", headers: auth });
    const location = created.headers.get("Location") ?? "";
    await call(location, {
      method: "PATCH",
      headers: { ...auth, "Content-Range": "0-4", "Content-Length": "5" },
      body: encoder.encode("hello"),
    });
    const other = await sha256(encoder.encode("other bytes"));
    const mismatch = await call(`${location}?digest=${other}`, { method: "PUT", headers: auth });
    expect(mismatch.status).toBe(400);
    expect((await readOciError(mismatch)).errors[0]?.code).toBe("DIGEST_INVALID");
    // The session survives (container.go returns before RemoveBlobUploadByID).
    const status = await call(location, { method: "GET", headers: auth });
    expect(status.status).toBe(204);
  });

  it("416s a Content-Range whose start is past the received bytes", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const created = await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/`, { method: "POST", headers: auth });
    const location = created.headers.get("Location") ?? "";
    const wrong = await call(location, {
      method: "PATCH",
      headers: { ...auth, "Content-Range": "5-9", "Content-Length": "5" },
      body: encoder.encode("abcde"),
    });
    expect(wrong.status).toBe(416);
    expect((await readOciError(wrong)).errors[0]?.code).toBe("BLOB_UPLOAD_INVALID");
  });

  it("rejects a stream upload after the first write (container.go:378-381)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const created = await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/`, { method: "POST", headers: auth });
    const location = created.headers.get("Location") ?? "";
    await call(location, {
      method: "PATCH",
      headers: { ...auth, "Content-Range": "0-0", "Content-Length": "1" },
      body: encoder.encode("x"),
    });
    const streamed = await call(location, {
      method: "PATCH",
      headers: { ...auth, "Content-Length": "1" },
      body: encoder.encode("y"),
    });
    expect(streamed.status).toBe(400);
    expect((await readOciError(streamed)).errors[0]?.message).toBe("Stream uploads after first write are not allowed");
  });

  it("spools a CHUNKED (unknown-length) PATCH through the bounded multipart arm", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const created = await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/`, { method: "POST", headers: auth });
    const location = created.headers.get("Location") ?? "";
    // A ReadableStream body with NO Content-Length declaration — the D-2
    // chunked shape spoolUnknownLength exists for.
    const chunk = encoder.encode("streamed chunk bytes");
    const patch = await call(location, {
      method: "PATCH",
      headers: { ...auth, "Content-Range": `0-${chunk.byteLength - 1}` },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
    });
    expect(patch.status).toBe(202);
    expect(patch.headers.get("Range")).toBe(`0-${chunk.byteLength - 1}`);
    const digest = await sha256(chunk);
    const finalized = await call(`${location}?digest=${digest}`, { method: "PUT", headers: auth });
    expect(finalized.status).toBe(201);
    const got = await call(`/v2/${OWNER}/${IMAGE}/blobs/${digest}`, { headers: auth });
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(chunk);
  });

  it("walks the single-POST arm and rejects a mismatched digest (container.go:269-308)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const bytes = encoder.encode("single post blob");
    const digest = await sha256(bytes);
    const ok = await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/?digest=${digest}`, {
      method: "POST",
      headers: auth,
      body: bytes,
    });
    expect(ok.status).toBe(201);
    expect(ok.headers.get("Docker-Content-Digest")).toBe(digest);
    const wrong = await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/?digest=${await sha256(encoder.encode("nope"))}`, {
      method: "POST",
      headers: auth,
      body: bytes,
    });
    expect(wrong.status).toBe(400);
    expect((await readOciError(wrong)).errors[0]?.code).toBe("DIGEST_INVALID");
  });

  it("aborts a session with DELETE (container.go:469-488)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const created = await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/`, { method: "POST", headers: auth });
    const location = created.headers.get("Location") ?? "";
    const aborted = await call(location, { method: "DELETE", headers: auth });
    expect(aborted.status).toBe(204);
    const gone = await call(location, { method: "GET", headers: auth });
    expect(gone.status).toBe(404);
    expect((await readOciError(gone)).errors[0]?.code).toBe("BLOB_UPLOAD_UNKNOWN");
  });

  it("mounts a blob cross-repo (container.go:239-267)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const bytes = encoder.encode("shared layer");
    const digest = await pushBlob(call, auth, bytes, "base");
    const mounted = await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/?mount=${digest}&from=${OWNER}/base`, {
      method: "POST",
      headers: auth,
    });
    expect(mounted.status).toBe(201);
    expect(mounted.headers.get("Docker-Content-Digest")).toBe(digest);
    const got = await call(`/v2/${OWNER}/${IMAGE}/blobs/${digest}`, { headers: auth });
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  });

  it("answers an unknown image name with NAME_INVALID (VerifyImageName)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const response = await call(`/v2/${OWNER}/Uppercase/blobs/uploads/`, { method: "POST", headers: auth });
    expect(response.status).toBe(400);
    expect((await readOciError(response)).errors[0]?.code).toBe("NAME_INVALID");
  });

  it("403s a blob save past the owner size quota with the bare status (apiError)", async () => {
    const call = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "10" });
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const bytes = encoder.encode("this blob is definitely larger than ten bytes");
    const digest = await sha256(bytes);
    const response = await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/?digest=${digest}`, {
      method: "POST",
      headers: auth,
      body: bytes,
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Docker-Distribution-Api-Version")).toBe("registry/2.0");
  });
});

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

describe("container manifests", () => {
  it("round-trips a tagged manifest with its metadata (manifest.go:100-159)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));

    const config = imageConfigBytes();
    const configDigest = await pushBlob(call, auth, config);
    const layer = encoder.encode("layer one");
    const layerDigest = await pushBlob(call, auth, layer);
    const manifest = await buildManifest(configDigest, config.byteLength, [
      { mediaType: "application/vnd.oci.image.layer.v1.tar", digest: layerDigest, size: layer.byteLength },
    ]);

    const put = await call(`/v2/${OWNER}/${IMAGE}/manifests/latest`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: manifest.bytes,
    });
    expect(put.status).toBe(201);
    expect(put.headers.get("Docker-Content-Digest")).toBe(manifest.digest);
    expect(put.headers.get("Location")).toBe(`/v2/${OWNER}/${IMAGE}/manifests/latest`);

    const got = await call(`/v2/${OWNER}/${IMAGE}/manifests/latest`, { headers: auth });
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("application/vnd.oci.image.manifest.v1+json");
    expect(got.headers.get("Docker-Content-Digest")).toBe(manifest.digest);
    expect(got.headers.get("ETag")).toBe(`"${manifest.digest}"`);
    expect(await got.text()).toBe(manifest.text);

    const head = await call(`/v2/${OWNER}/${IMAGE}/manifests/latest`, { method: "HEAD", headers: auth });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(manifest.bytes.byteLength));

    // By digest reference.
    const byDigest = await call(`/v2/${OWNER}/${IMAGE}/manifests/${manifest.digest}`, { headers: auth });
    expect(byDigest.status).toBe(200);
    expect(await byDigest.text()).toBe(manifest.text);

    // The metadata landed on the version (platform/labels/description).
    const versions = await db()
      .select()
      .from(packageVersions)
      .where(eq(packageVersions.isInternal, false))
      .all();
    expect(versions).toHaveLength(1);
    const metadata = JSON.parse(versions[0]?.metadataJson ?? "{}") as Record<string, unknown>;
    expect(metadata["type"]).toBe("oci");
    expect(metadata["platform"]).toBe("linux/amd64");
    expect(metadata["description"]).toBe("the test image");
    expect(metadata["license"]).toBe("MIT");
    expect(metadata["project_url"]).toBe("https://example.com/project");
    expect(metadata["layer_creation"]).toEqual(["ADD file:abc in /", 'CMD ["/bin/sh"]']);
    expect(metadata["is_tagged"]).toBe(true);
  });

  it("answers a missing layer with BLOB_UNKNOWN and a wrong layer size with SIZE_INVALID", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const config = imageConfigBytes();
    const configDigest = await pushBlob(call, auth, config);
    const ghostDigest = await sha256(encoder.encode("never pushed"));

    const missingLayer = await buildManifest(configDigest, config.byteLength, [
      { mediaType: "application/vnd.oci.image.layer.v1.tar", digest: ghostDigest, size: 5 },
    ]);
    const missing = await call(`/v2/${OWNER}/${IMAGE}/manifests/latest`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: missingLayer.bytes,
    });
    expect(missing.status).toBe(404);
    expect((await readOciError(missing)).errors[0]?.code).toBe("BLOB_UNKNOWN");

    const layer = encoder.encode("layer");
    const layerDigest = await pushBlob(call, auth, layer);
    const wrongSize = await buildManifest(configDigest, config.byteLength, [
      { mediaType: "application/vnd.oci.image.layer.v1.tar", digest: layerDigest, size: layer.byteLength + 1 },
    ]);
    const mismatched = await call(`/v2/${OWNER}/${IMAGE}/manifests/latest`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: wrongSize.bytes,
    });
    expect(mismatched.status).toBe(400);
    expect((await readOciError(mismatched)).errors[0]?.code).toBe("SIZE_INVALID");
  });

  it("answers an invalid tag, a bad schema version and an unrecognized media type per pin", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const manifest = await buildManifest(await sha256(encoder.encode("{}")), 2, []);

    const badTag = await call(`/v2/${OWNER}/${IMAGE}/manifests/bad!tag`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: manifest.bytes,
    });
    expect(badTag.status).toBe(400);
    expect((await readOciError(badTag)).errors[0]?.message).toBe("Tag is invalid");

    const oldSchema = encoder.encode(JSON.stringify({ schemaVersion: 1 }));
    const unsupported = await call(`/v2/${OWNER}/${IMAGE}/manifests/v1`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: oldSchema,
    });
    expect(unsupported.status).toBe(501);
    expect((await readOciError(unsupported)).errors[0]?.code).toBe("UNSUPPORTED");

    const badType = await call(`/v2/${OWNER}/${IMAGE}/manifests/whatever`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/weird.type" },
      // BOTH media types invalid → "MediaType not recognized" (a valid
      // document mediaType would proceed and answer BLOB_UNKNOWN for the
      // missing config, container.go:53-58 → :589-590).
      body: encoder.encode(
        JSON.stringify({ schemaVersion: 2, mediaType: "application/weird.type", config: { digest: "sha256:" + "0".repeat(64), size: 2 }, layers: [] }),
      ),
    });
    expect(badType.status).toBe(400);
    expect((await readOciError(badType)).errors[0]?.message).toBe("MediaType not recognized");
  });

  it("overwrites a tag by delete-and-recreate keeping the download count", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const configDigest = await pushBlob(call, auth, imageConfigBytes());
    const layerDigest = await pushBlob(call, auth, encoder.encode("layer"));
    const first = await buildManifest(configDigest, imageConfigBytes().byteLength, [
      { mediaType: "application/vnd.oci.image.layer.v1.tar", digest: layerDigest, size: 5 },
    ]);
    const put1 = await call(`/v2/${OWNER}/${IMAGE}/manifests/latest`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: first.bytes,
    });
    expect(put1.status).toBe(201);

    const second = encoder.encode("layer two");
    const secondDigest = await pushBlob(call, auth, second);
    const replacement = await buildManifest(configDigest, imageConfigBytes().byteLength, [
      { mediaType: "application/vnd.oci.image.layer.v1.tar", digest: secondDigest, size: second.byteLength },
    ]);
    const put2 = await call(`/v2/${OWNER}/${IMAGE}/manifests/latest`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: replacement.bytes,
    });
    expect(put2.status).toBe(201);
    expect(put2.headers.get("Docker-Content-Digest")).toBe(replacement.digest);

    const versions = await db().select().from(packageVersions).where(eq(packageVersions.isInternal, false)).all();
    expect(versions).toHaveLength(1);
    const got = await call(`/v2/${OWNER}/${IMAGE}/manifests/latest`, { headers: auth });
    expect(await got.text()).toBe(replacement.text);
  });

  it("deletes a manifest by tag (container.go:678-704)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const configDigest = await pushBlob(call, auth, imageConfigBytes());
    const manifest = await buildManifest(configDigest, imageConfigBytes().byteLength, []);
    await call(`/v2/${OWNER}/${IMAGE}/manifests/doomed`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: manifest.bytes,
    });
    const removed = await call(`/v2/${OWNER}/${IMAGE}/manifests/doomed`, { method: "DELETE", headers: auth });
    expect(removed.status).toBe(202);
    const gone = await call(`/v2/${OWNER}/${IMAGE}/manifests/doomed`, { headers: auth });
    expect(gone.status).toBe(404);
    expect((await readOciError(gone)).errors[0]?.code).toBe("MANIFEST_UNKNOWN");
    const missing = await call(`/v2/${OWNER}/${IMAGE}/manifests/neverwas`, { method: "DELETE", headers: auth });
    expect(missing.status).toBe(404);
  });

  it("builds and serves the multi-arch index (manifest.go:161-229)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const configDigest = await pushBlob(call, auth, imageConfigBytes());
    const amd64 = await buildManifest(configDigest, imageConfigBytes().byteLength, []);
    await call(`/v2/${OWNER}/${IMAGE}/manifests/${amd64.digest}`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: amd64.bytes,
    });
    const indexBytes = encoder.encode(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: amd64.digest,
            size: amd64.bytes.byteLength,
            platform: { os: "linux", architecture: "amd64" },
          },
        ],
      }),
    );
    const put = await call(`/v2/${OWNER}/${IMAGE}/manifests/multi`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.index.v1+json" },
      body: indexBytes,
    });
    expect(put.status).toBe(201);
    const got = await call(`/v2/${OWNER}/${IMAGE}/manifests/multi`, { headers: auth });
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("application/vnd.oci.image.index.v1+json");

    const versions = await db().select().from(packageVersions).where(eq(packageVersions.lowerVersion, "multi")).all();
    const metadata = JSON.parse(versions[0]?.metadataJson ?? "{}") as { manifests: { platform: string; size: number }[] };
    expect(metadata.manifests[0]?.platform).toBe("linux/amd64");
    expect(metadata.manifests[0]?.size).toBeGreaterThan(0);
  });

  it("answers a manifest over the 10 MiB cap with MANIFEST_INVALID 413", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const padding = "x".repeat(10 * 1024 * 1024 + 16);
    const oversized = encoder.encode(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", padding }));
    const response = await call(`/v2/${OWNER}/${IMAGE}/manifests/huge`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: oversized,
    });
    expect(response.status).toBe(413);
    expect((await readOciError(response)).errors[0]?.message).toBe("Manifest exceeds maximum size");
  });
});

// ---------------------------------------------------------------------------
// Tag list + catalog
// ---------------------------------------------------------------------------

describe("container tags + catalog", () => {
  async function seedTwoTags(): Promise<void> {
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const call = protocol();
    const configDigest = await pushBlob(call, auth, imageConfigBytes());
    for (const tag of ["alpha", "beta"]) {
      const manifest = await buildManifest(configDigest, imageConfigBytes().byteLength, []);
      await call(`/v2/${OWNER}/${IMAGE}/manifests/${tag}`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
        body: manifest.bytes,
      });
    }
  }

  it("lists tags sorted with the Link pagination header (container.go:735-778)", async () => {
    await seedTwoTags();
    const call = protocol();
    const user = (await db().select().from(users).where(eq(users.usernameLower, OWNER)).get()) ?? null;
    if (user === null) throw new Error("seed failed");
    const auth = basicAuth(await token(user.id, "read:package"));
    const all = await call(`/v2/${OWNER}/${IMAGE}/tags/list`, { headers: auth });
    expect(all.status).toBe(200);
    expect(await all.json<{ name: string; tags: string[] }>()).toEqual({
      name: `${OWNER}/${IMAGE}`,
      tags: ["alpha", "beta"],
    });
    const page = await call(`/v2/${OWNER}/${IMAGE}/tags/list?n=1`, { headers: auth });
    expect(page.headers.get("Link")).toBe(`</v2/${OWNER}/${IMAGE}/tags/list?n=1&last=alpha>; rel="next"`);
    expect((await page.json<{ tags: string[] }>()).tags).toEqual(["alpha"]);
    const rest = await call(`/v2/${OWNER}/${IMAGE}/tags/list?last=alpha`, { headers: auth });
    expect((await rest.json<{ tags: string[] }>()).tags).toEqual(["beta"]);
  });

  it("answers an unknown image with NAME_UNKNOWN (container.go:738-745)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "read:package"));
    const response = await call(`/v2/${OWNER}/ghostimage/tags/list`, { headers: auth });
    expect(response.status).toBe(404);
    expect((await readOciError(response)).errors[0]?.code).toBe("NAME_UNKNOWN");
  });

  it("lists the catalog with visibility filtering and the Link header (search.go:252-287)", async () => {
    await seedTwoTags();
    const call = protocol();
    const user = (await db().select().from(users).where(eq(users.usernameLower, OWNER)).get()) ?? null;
    if (user === null) throw new Error("seed failed");
    const auth = basicAuth(await token(user.id, "read:package"));
    const all = await call("/v2/_catalog", { headers: auth });
    expect(all.status).toBe(200);
    expect(await all.json<{ repositories: string[] }>()).toEqual({ repositories: [`${OWNER}/${IMAGE}`] });
    // A private second owner is invisible to another user's catalog.
    const hidden = await seedUser("hider", { visibility: "private" });
    const hiddenAuth = basicAuth(await token(hidden.id, "write:package"));
    const configDigest = await pushBlob(call, hiddenAuth, imageConfigBytes(), "secret", "hider");
    const manifest = await buildManifest(configDigest, imageConfigBytes().byteLength, []);
    await call(`/v2/hider/secret/manifests/latest`, {
      method: "PUT",
      headers: { ...hiddenAuth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: manifest.bytes,
    });
    const filtered = await call("/v2/_catalog", { headers: auth });
    expect((await filtered.json<{ repositories: string[] }>()).repositories).toEqual([`${OWNER}/${IMAGE}`]);
    // The owner sees both; n=1 pages with Link.
    const own = await call("/v2/_catalog", { headers: hiddenAuth });
    expect((await own.json<{ repositories: string[] }>()).repositories.sort()).toEqual([
      `${OWNER}/${IMAGE}`,
      "hider/secret",
    ]);
    const paged = await call("/v2/_catalog?n=1", { headers: hiddenAuth });
    expect(paged.headers.get("Link")).toContain("rel=\"next\"");
  });

  it("requires container auth for the catalog (ReqContainerAccess)", async () => {
    const call = protocol();
    const response = await call("/v2/_catalog");
    expect(response.status).toBe(401);
    expect((await readOciError(response)).errors[0]?.code).toBe("UNAUTHORIZED");
  });
});

// ---------------------------------------------------------------------------
// Gate + quota + cleanup odds
// ---------------------------------------------------------------------------

describe("container gates + cleanup", () => {
  it("keeps a write PAT on the read arms and a read PAT off the write arms", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const writeAuth = basicAuth(await token(user.id, "write:package"));
    const configDigest = await pushBlob(call, writeAuth, imageConfigBytes());
    const manifest = await buildManifest(configDigest, imageConfigBytes().byteLength, []);
    await call(`/v2/${OWNER}/${IMAGE}/manifests/latest`, {
      method: "PUT",
      headers: { ...writeAuth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: manifest.bytes,
    });
    const readAuth = basicAuth(await token(user.id, "read:package"));
    const pulled = await call(`/v2/${OWNER}/${IMAGE}/manifests/latest`, { headers: readAuth });
    expect(pulled.status).toBe(200);
    const denied = await call(`/v2/${OWNER}/${IMAGE}/manifests/other`, {
      method: "PUT",
      headers: readAuth,
      body: manifest.bytes,
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("WWW-Authenticate")).toBe('Basic realm="Gitea Package API"');
  });

  it("403s a manifest push past the owner count quota (CheckCountQuotaExceeded)", async () => {
    const call = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "0" });
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const configDigest = await pushBlob(call, auth, imageConfigBytes());
    const manifest = await buildManifest(configDigest, imageConfigBytes().byteLength, []);
    const response = await call(`/v2/${OWNER}/${IMAGE}/manifests/latest`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/vnd.oci.image.manifest.v1+json" },
      body: manifest.bytes,
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
  });

  it("404s the whole family when PACKAGES_ENABLED=false", async () => {
    const call = protocol({ PACKAGES_ENABLED: "false" });
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const response = await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/`, { method: "POST", headers: auth });
    expect(response.status).toBe(404);
  });

  it("sweeps expired upload sessions and their chunk objects (cleanup.go:19-31)", async () => {
    const call = protocol();
    const user = await seedUser(OWNER);
    const auth = basicAuth(await token(user.id, "write:package"));
    const created = await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/`, { method: "POST", headers: auth });
    const uuid = created.headers.get("Docker-Upload-Uuid") ?? "";
    await call(`/v2/${OWNER}/${IMAGE}/blobs/uploads/${uuid}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Range": "0-2", "Content-Length": "3" },
      body: encoder.encode("abc"),
    });
    const removed = await cleanupExpiredContainerUploads(env.DB, env.REPO_PACKS, 1000);
    expect(removed).toBe(0); // fresh session survives a 1 s window
    // Age the row past the window (updated_unix is the sweep's scan key).
    await db()
      .update(packageBlobUploads)
      .set({ updatedUnix: new Date(Date.now() - 60_000) })
      .where(eq(packageBlobUploads.id, uuid))
      .run();
    const swept = await cleanupExpiredContainerUploads(env.DB, env.REPO_PACKS, 1000);
    expect(swept).toBe(1);
    const row = await db().select().from(packageBlobUploads).where(eq(packageBlobUploads.id, uuid)).get();
    expect(row).toBeUndefined();
    const chunkObject = await env.REPO_PACKS.get(`packages/uploads/${uuid}/1`);
    expect(chunkObject).toBeNull();
  });

  it("creates sessions through the service seam with uuid ids (package_blob_upload.go:33-42)", async () => {
    const upload = await createContainerBlobUpload(env.DB);
    expect(upload.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(upload.bytesReceived).toBe(0);
    expect(upload.chunkCount).toBe(0);
  });
});
