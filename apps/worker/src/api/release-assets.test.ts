/**
 * Tier-1 release-asset routes on real D1+R2 (SPEC-0004 §2.4 rows
 * repoListReleaseAttachments / repoCreateReleaseAttachment; upstream
 * routers/api/v1/repo/release_attachment.go over the landed `release_assets`
 * table + the REPO_PACKS bucket). Pins: the streaming upload contract of
 * services/release-assets.ts — octet-stream single-pass hash-and-forward,
 * multipart via the streaming RFC 7578 scanner (8 MiB R2 MPU parts), the
 * `repos/<storage_key>/release-assets/<release_id>/<uuid>-<name>` key layout
 * with the sanitized name segment, the sha256 row checksum, the 411
 * Content-Length requirement, the 413 threshold service-side, the upstream
 * name priority (query ?name= > multipart `name` field > part filename),
 * the release 404 rules (repo-scoped global id, tag rows, drafts), the 412
 * releases-unit gate, and the writer gate (403).
 *
 * The 512 MiB threshold itself is exercised at the service layer with the
 * `maxBytes` test seam — a 512 MiB transfer is not a unit-scale fixture.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { releaseAssets, repositories } from "../db/schema";
import { IssuesService } from "../issues/service";
import type { AuthResolver } from "./auth";
import { createOptionalTokenAuthMiddleware, createStubAuthResolver, createTokenAuthMiddleware, STUB_USER } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { registerReleaseAssetRoutes } from "./routes/release-assets";
import {
  AssetTooLargeError,
  MAX_RELEASE_ASSET_BYTES,
  releaseAssetKey,
  uploadReleaseAsset,
} from "./services/release-assets";
import { addOrUpdateCollaborator } from "./services/repo-collaborators";
import { saveRepoSettings } from "./services/repo-settings";

const TOKEN = "stub-token";
const TOKEN_READER = "collab-reader-token";
const ERROR_URL = "https://example.com/api/swagger";
const REPO_ID = "7401";
const REPO_PATH = "/repos/cf-gitea-stub/rel";
const auth = { Authorization: `token ${TOKEN}` };

function makeApp(): (path: string | Request, init?: RequestInit) => Promise<Response> {
  const resolver: AuthResolver = {
    resolveToken: (token) => {
      if (token === TOKEN) return createStubAuthResolver().resolveToken(token);
      if (token === TOKEN_READER) {
        return Promise.resolve({ ...STUB_USER, id: 2, login: "collab-reader", full_name: "Collab Reader" });
      }
      return Promise.resolve(null);
    },
  };
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerReleaseAssetRoutes(
    app,
    createTokenAuthMiddleware(resolver),
    createOptionalTokenAuthMiddleware(resolver),
  );
  return (path, init) =>
    Promise.resolve(app.fetch(typeof path === "string" ? new Request(`https://example.com${path}`, init) : path, env));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function storedBytes(key: string): Promise<Uint8Array> {
  const stored = await env.REPO_PACKS.get(key);
  if (stored === null) throw new Error(`missing R2 object: ${key}`);
  return new Uint8Array(await stored.arrayBuffer());
}

async function storedSize(key: string): Promise<number> {
  const head = await env.REPO_PACKS.head(key);
  if (head === null) throw new Error(`missing R2 object: ${key}`);
  return head.size;
}

/** A one-shot byte stream (typed; Blob.stream() is ReadableStream<any>). */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** The single row of a one-row result (test-failure when not exactly one). */
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row");
  return row;
}

/** Every object key under the test repo's asset prefix. */
async function listAssetKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.REPO_PACKS.list({ prefix: "repos/r_7401/release-assets/", cursor });
    for (const object of page.objects) keys.push(object.key);
    if (!page.truncated) return keys;
    cursor = page.cursor;
    if (cursor === undefined) return keys;
  }
}

/** Build a deterministic multipart/form-data body (RFC 7578 subset). */
function multipartBody(
  boundary: string,
  parts: { name: string; filename?: string; body: string }[],
): { bytes: Uint8Array; contentType: string } {
  const chunks: Uint8Array[] = [];
  const push = (text: string): void => {
    chunks.push(new TextEncoder().encode(text));
  };
  for (const part of parts) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${part.name}"`);
    if (part.filename !== undefined) push(`; filename="${part.filename}"`);
    push("\r\nContent-Type: application/octet-stream\r\n\r\n");
    push(part.body);
    push("\r\n");
  }
  push(`--${boundary}--\r\n`);
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType: `multipart/form-data; boundary=${boundary}` };
}

let releaseSeq = 0;

async function seedRelease(options: { isDraft?: boolean; isTag?: boolean } = {}): Promise<number> {
  const row = await new IssuesService(env.DB).createRelease({
    repoId: REPO_ID,
    publisherId: 1,
    tagName: options.isTag === true ? `tag-${releaseSeq}` : `v1.${releaseSeq}.0`,
    target: "main",
    title: `seed ${releaseSeq}`,
    note: "",
    isDraft: options.isDraft,
    isTag: options.isTag,
    now: new Date("2026-03-01T00:00:00Z"),
  });
  releaseSeq += 1;
  return row.id;
}

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  releaseSeq = 0;
  for (const table of [
    "release_assets",
    "releases",
    "repo_collaborators",
    "repo_settings",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (2, 'collab-reader', 'collab-reader', 0, 'active', 0)",
  ).run();
  await drizzle(env.DB).insert(repositories).values({
    id: REPO_ID,
    storageKey: "r_7401",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "rel",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await new IssuesService(env.DB).ensureRepoCounters(REPO_ID);
  await addOrUpdateCollaborator(env.DB, REPO_ID, 2, "read", new Date("2026-02-03T04:05:06Z"));
  for (const key of await listAssetKeys()) {
    await env.REPO_PACKS.delete(key);
  }
});

describe("POST /repos/{owner}/{repo}/releases/{id}/assets (repoCreateReleaseAttachment)", () => {
  it("uploads an octet-stream body to R2 and lands the D1 row with its checksum", async () => {
    const releaseId = await seedRelease();
    const payload = new TextEncoder().encode("release asset payload bytes\n");
    const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets?name=dist.zip`, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(payload.byteLength),
      },
      body: payload,
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.name).toBe("dist.zip");
    expect(body.size).toBe(payload.byteLength);
    expect(body.download_count).toBe(0);
    expect(body.id).toBeGreaterThan(0);
    expect(body.created_at).toBeTypeOf("string");
    expect(body.browser_download_url).toBe(`https://example.com/attachments/${String(body.uuid)}`);

    const row = only(await drizzle(env.DB).select().from(releaseAssets).all());
    expect(row.uuid).toBe(body.uuid);
    expect(row.checksumSha256).toBe(await sha256Hex(payload));
    expect(row.r2Key).toBe(releaseAssetKey("r_7401", releaseId, row.uuid, "dist.zip"));
    expect(row.r2Key).toMatch(/^repos\/r_7401\/release-assets\/\d+\/[0-9a-f-]{36}-dist\.zip$/);
    expect(await storedBytes(row.r2Key)).toEqual(payload);
    expect(await storedSize(row.r2Key)).toBe(payload.byteLength);
  });

  it("uploads a multipart file part (filename names the asset)", async () => {
    const releaseId = await seedRelease();
    const payload = "multipart bytes here";
    const { bytes, contentType } = multipartBody("compat-boundary-42", [
      { name: "attachment", filename: "binary v2.tar.gz", body: payload },
    ]);
    const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets`, {
      method: "POST",
      headers: { ...auth, "Content-Type": contentType, "Content-Length": String(bytes.byteLength) },
      body: bytes,
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.name).toBe("binary v2.tar.gz");

    const row = only(await drizzle(env.DB).select().from(releaseAssets).all());
    expect(new TextDecoder().decode(await storedBytes(row.r2Key))).toBe(payload);
    expect(row.size).toBe(payload.length);
    // the key segment is sanitized; the display name stays verbatim in D1
    expect(row.r2Key).toContain("binary_v2.tar.gz");
    expect(row.name).toBe("binary v2.tar.gz");
  });

  it("multipart `name` field overrides the part filename; query ?name= overrides both", async () => {
    const releaseId = await seedRelease();
    const withField = multipartBody("compat-boundary-42", [
      { name: "name", body: "from-field.zip" },
      { name: "attachment", filename: "original.bin", body: "field override bytes" },
    ]);
    const resField = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets`, {
      method: "POST",
      headers: { ...auth, "Content-Type": withField.contentType, "Content-Length": String(withField.bytes.byteLength) },
      body: withField.bytes,
    });
    expect(resField.status).toBe(201);
    expect((await resField.json<Record<string, unknown>>()).name).toBe("from-field.zip");

    const releaseId2 = await seedRelease();
    const withQuery = multipartBody("compat-boundary-42", [
      { name: "attachment", filename: "original.bin", body: "query override bytes" },
    ]);
    const resQuery = await makeApp()(`${REPO_PATH}/releases/${releaseId2}/assets?name=from-query`, {
      method: "POST",
      headers: { ...auth, "Content-Type": withQuery.contentType, "Content-Length": String(withQuery.bytes.byteLength) },
      body: withQuery.bytes,
    });
    expect(resQuery.status).toBe(201);
    expect((await resQuery.json<Record<string, unknown>>()).name).toBe("from-query");
  });

  it("400s when the name cannot be determined (octet-stream without ?name=)", async () => {
    const releaseId = await seedRelease();
    const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": "7" },
      body: "no name",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      message: "Could not determine name of attachment.",
      url: ERROR_URL,
    });
  });

  it("400s a multipart body without an attachment part", async () => {
    const releaseId = await seedRelease();
    const { bytes, contentType } = multipartBody("compat-boundary-42", [{ name: "name", body: "x.zip" }]);
    const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets`, {
      method: "POST",
      headers: { ...auth, "Content-Type": contentType, "Content-Length": String(bytes.byteLength) },
      body: bytes,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "no attachment file in request", url: ERROR_URL });
  });

  it("400s a malformed multipart body (boundary never found)", async () => {
    const releaseId = await seedRelease();
    const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "multipart/form-data; boundary=never", "Content-Length": "3" },
      body: "abc",
    });
    expect(res.status).toBe(400);
    expect((await res.json<Record<string, unknown>>()).message as string).toContain("malformed multipart body");
  });

  it("411s a stream upload without Content-Length (the relay-store requirement)", async () => {
    const releaseId = await seedRelease();
    const request = new Request(`https://example.com${REPO_PATH}/releases/${releaseId}/assets?name=x.bin`, {
      method: "POST",
      headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Blob(["chunked bytes"]).stream(),
      duplex: "half",
    } as RequestInit);
    const res = await makeApp()(request);
    expect(res.status).toBe(411);
  });

  it("401s an anonymous caller and 403s a read-mode collaborator", async () => {
    const releaseId = await seedRelease();
    const anon = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets?name=x`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: "x",
    });
    expect(anon.status).toBe(401);
    const reader = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets?name=x`, {
      method: "POST",
      headers: { Authorization: `token ${TOKEN_READER}`, "Content-Type": "application/octet-stream" },
      body: "x",
    });
    expect(reader.status).toBe(403);
    expect(await reader.json()).toEqual({
      message: "token does not have the required scope or the user does not have write access",
      url: ERROR_URL,
    });
  });

  it("404s an unknown release id and a tag-only record (repo-scoped global id)", async () => {
    const tagId = await seedRelease({ isTag: true });
    const post = (id: number | string) =>
      makeApp()(`${REPO_PATH}/releases/${id}/assets?name=x`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/octet-stream" },
        body: "x",
      });
    expect((await post(99999)).status).toBe(404);
    expect((await post(tagId)).status).toBe(404);
  });

  it("412s when the releases unit is disabled", async () => {
    const releaseId = await seedRelease();
    await saveRepoSettings(env.DB, REPO_ID, { hasReleases: false }, new Date());
    const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets?name=x`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream" },
      body: "x",
    });
    expect(res.status).toBe(412);
  });

  it("uploads a zero-byte asset (the no-parts MPU edge)", async () => {
    const releaseId = await seedRelease();
    const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets?name=empty.bin`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": "0" },
      body: new Uint8Array(0),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.size).toBe(0);
    const row = only(await drizzle(env.DB).select().from(releaseAssets).all());
    expect(await storedSize(row.r2Key)).toBe(0);
  });
});

describe("GET /repos/{owner}/{repo}/releases/{id}/assets (repoListReleaseAttachments)", () => {
  it("lists a release's assets in id order with the Attachment shape", async () => {
    const releaseId = await seedRelease();
    for (const name of ["beta.zip", "alpha.zip"]) {
      const body = new TextEncoder().encode(`bytes of ${name}`);
      const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets?name=${name}`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": String(body.byteLength) },
        body,
      });
      expect(res.status).toBe(201);
    }
    const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets`);
    expect(res.status).toBe(200);
    const list = await res.json<Record<string, unknown>[]>();
    expect(list.map((asset) => asset.name)).toEqual(["beta.zip", "alpha.zip"]);
    for (const asset of list) {
      expect(asset.size).toBe(`bytes of ${String(asset.name)}`.length);
      expect(asset.download_count).toBe(0);
      expect(asset.uuid).toBeTypeOf("string");
      expect(asset.browser_download_url).toBe(`https://example.com/attachments/${String(asset.uuid)}`);
      expect(asset.created_at).toBeTypeOf("string");
    }
  });

  it("200s an empty list for a release with no assets", async () => {
    const releaseId = await seedRelease();
    const res = await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("404s an unknown release id and 404s a draft without write access", async () => {
    const draftId = await seedRelease({ isDraft: true });
    expect((await makeApp()(`${REPO_PATH}/releases/99999/assets`)).status).toBe(404);
    expect((await makeApp()(`${REPO_PATH}/releases/${draftId}/assets`)).status).toBe(404);
    expect((await makeApp()(`${REPO_PATH}/releases/${draftId}/assets`, { headers: auth })).status).toBe(200);
  });

  it("412s when the releases unit is disabled", async () => {
    const releaseId = await seedRelease();
    await saveRepoSettings(env.DB, REPO_ID, { hasReleases: false }, new Date());
    expect((await makeApp()(`${REPO_PATH}/releases/${releaseId}/assets`)).status).toBe(412);
  });
});

describe("release-asset storage internals (SPEC-0005 §3.3)", () => {
  it("413s over the threshold and leaves no R2 object behind (raw path)", async () => {
    const releaseId = await seedRelease();
    await expect(
      uploadReleaseAsset({
        bucket: env.REPO_PACKS,
        d1: env.DB,
        repoId: REPO_ID,
        storageKey: "r_7401",
        releaseId,
        uploaderId: 1,
        name: "too-big.zip",
        content: streamOf(new Uint8Array(64).fill(7)),
        multipart: false,
        declaredLength: 64,
        maxBytes: 32,
      }),
    ).rejects.toBeInstanceOf(AssetTooLargeError);
    expect(await drizzle(env.DB).select().from(releaseAssets).all()).toHaveLength(0);
    expect(await listAssetKeys()).toHaveLength(0);
  });

  it("413s over the threshold and aborts the MPU (multipart path)", async () => {
    const releaseId = await seedRelease();
    await expect(
      uploadReleaseAsset({
        bucket: env.REPO_PACKS,
        d1: env.DB,
        repoId: REPO_ID,
        storageKey: "r_7401",
        releaseId,
        uploaderId: 1,
        name: "too-big.bin",
        content: streamOf(new Uint8Array(64).fill(9)),
        multipart: true,
        maxBytes: 32,
      }),
    ).rejects.toBeInstanceOf(AssetTooLargeError);
    expect(await drizzle(env.DB).select().from(releaseAssets).all()).toHaveLength(0);
    expect(await listAssetKeys()).toHaveLength(0);
  });

  it("rejects a lying Content-Length with a size mismatch (raw path)", async () => {
    const releaseId = await seedRelease();
    await expect(
      uploadReleaseAsset({
        bucket: env.REPO_PACKS,
        d1: env.DB,
        repoId: REPO_ID,
        storageKey: "r_7401",
        releaseId,
        uploaderId: 1,
        name: "lying.zip",
        content: streamOf(new Uint8Array(8).fill(1)),
        multipart: false,
        declaredLength: 100,
      }),
    ).rejects.toMatchObject({ name: "AssetSizeMismatchError" });
    expect(await drizzle(env.DB).select().from(releaseAssets).all()).toHaveLength(0);
    expect(await listAssetKeys()).toHaveLength(0);
  });

  it("builds the documented R2 key and sanitizes the name segment", () => {
    expect(releaseAssetKey("r_7401", 12, "018f3c4e-0000-7000-8000-000000000000", "dist (v2).zip")).toBe(
      "repos/r_7401/release-assets/12/018f3c4e-0000-7000-8000-000000000000-dist_v2_.zip",
    );
    expect(releaseAssetKey("r_7401", 12, "018f3c4e-0000-7000-8000-000000000000", "../../etc/passwd")).toBe(
      "repos/r_7401/release-assets/12/018f3c4e-0000-7000-8000-000000000000-.._etc_passwd",
    );
    expect(() => releaseAssetKey("../evil", 1, "u", "n")).toThrow();
    expect(MAX_RELEASE_ASSET_BYTES).toBe(512 * 1024 * 1024);
  });
});
