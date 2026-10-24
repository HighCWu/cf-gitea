/**
 * Chunked import channel — SPEC-0003 §2.6 (M5) test battery.
 *
 * Real D1 + real R2 + real engine DOs (workerd, @cloudflare/vitest-plugin).
 * The queue producer/consumer is exercised directly: the state machine
 * (service), the relay endpoints (SELF.fetch against the real router), and
 * the consumer pipeline (indexChunk driven per message, with REAL packs the
 * engine scans, indexes and finalizes through its own receive path).
 */

import { SELF, env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { REPO_SETTINGS_DDL_STATEMENTS } from "../../api/services/repo-settings";
import { mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { repoImports, repositories, users } from "../../db/schema";
import { RepoService } from "../service";
import { handleRepoTasks } from "../purge";
import { buildPack } from "../testing/git-pack";
import {
  CHUNK_SIZE_CAP_BYTES,
  ImportConflictError,
  ImportService,
  ManifestInvalidError,
  chunkTempRef,
  importChunkR2Key,
  parseManifestRow,
  validateManifest,
  type ImportManifest,
} from "./service";
import { cleanupAbortedImport, handleImportTask, indexChunk } from "./pipeline";

beforeAll(async () => {
  // The regression suite GETs the repo through the API; repoGet overlays the
  // batch-7 repo_settings raw store — no migration yet (SCHEMA GAP), so its
  // DDL-in-waiting is applied here (same bootstrap as api/testing/repo-ddl.ts).
  await applyAuthD1Migrations();
  for (const statement of REPO_SETTINGS_DDL_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  for (const table of [
    "repo_imports",
    "repo_units",
    "repo_transfer",
    "repo_redirects",
    "repo_counters",
    "repositories",
    "personal_access_tokens",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

// ---------------------------------------------------------------------------
// Pack fixtures: single-commit (the shared lifecycle helper) and hand-built
// packs whose second chunk deliberately references its parent from the first
// — the cross-chunk connectivity shape the channel exists for.
// ---------------------------------------------------------------------------

interface FixtureChunk {
  oid: string;
  pack: Uint8Array;
  sha1: string;
}

function hexBytes(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha1(bytes: Uint8Array): Promise<string> {
  return hexBytes(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)));
}

async function sha1Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

/** The pack trailer digest (= git's pack name) for a whole pack: SHA-1 over
 *  everything EXCEPT the trailing 20 bytes themselves. */
function trailerSha1(pack: Uint8Array): Promise<string> {
  return sha1(pack.subarray(0, pack.length - 20));
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function rawOid(oidHex: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = Number.parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

function concatArrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

interface RawObject {
  type: number;
  body: Uint8Array;
  oid: string;
}

async function hashObject(kind: string, body: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${kind} ${body.length}\0`);
  return sha1(concatArrays([header, body]));
}

async function blobObject(content: string): Promise<RawObject> {
  const body = new TextEncoder().encode(content);
  return { type: 3, body, oid: await hashObject("blob", body) };
}

async function treeObject(entries: { name: string; oid: string }[]): Promise<RawObject> {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(new TextEncoder().encode(`100644 ${entry.name}\0`));
    parts.push(rawOid(entry.oid));
  }
  const body = concatArrays(parts);
  return { type: 2, body, oid: await hashObject("tree", body) };
}

async function commitObject(
  treeOid: string,
  parents: string[],
  message: string,
  time: number,
): Promise<RawObject> {
  const parentLines = parents.map((p) => `parent ${p}\n`).join("");
  const body = new TextEncoder().encode(
    `tree ${treeOid}\n${parentLines}author Importer <import@example.com> ${time} +0000\n` +
      `committer Importer <import@example.com> ${time} +0000\n\n${message}\n`,
  );
  return { type: 1, body, oid: await hashObject("commit", body) };
}

/** A real git pack over exactly these objects — self-contained, or
 *  deliberately thin against objects an earlier chunk carries. */
async function packOf(objects: RawObject[]): Promise<{ pack: Uint8Array; sha1: string }> {
  const chunks: Uint8Array[] = [new TextEncoder().encode("PACK"), be32(2), be32(objects.length)];
  for (const object of objects) {
    chunks.push(objectHeader(object.type, object.body.length));
    chunks.push(await deflate(object.body));
  }
  const trailer = await sha1Bytes(concatArrays(chunks));
  chunks.push(trailer);
  return { pack: concatArrays(chunks), sha1: hexBytes(trailer) };
}

/** One commit's window pack (blob + tree + commit). */
async function commitPack(
  message: string,
  parents: string[],
  files: { name: string; content: string }[],
  time: number,
): Promise<FixtureChunk> {
  const blobs: RawObject[] = [];
  const treeEntries: { name: string; oid: string }[] = [];
  for (const file of files) {
    const blob = await blobObject(file.content);
    blobs.push(blob);
    treeEntries.push({ name: file.name, oid: blob.oid });
  }
  const tree = await treeObject(treeEntries);
  const commit = await commitObject(tree.oid, parents, message, time);
  const { pack, sha1 } = await packOf([blobs[0]!, tree, commit]);
  return { oid: commit.oid, pack, sha1 };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function importService(): ImportService {
  return new ImportService(env.DB);
}

async function seedRepo(
  name: string,
): Promise<{ repoId: string; storageKey: string; ownerId: number }> {
  // Tests that need two repos reuse the same owner (username_lower UNIQUE).
  const alice = await seedVerifiedUser({ username: "Alice" }).catch(async () => {
    const existing = await drizzle(env.DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, "alice"))
      .get();
    if (existing === undefined) throw new Error("alice seed failed");
    return { id: existing.id, username: "Alice" };
  });
  const repo = await new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry") }).create({
    owner: { id: alice.id, usernameLower: "alice" },
    name,
    isPrivate: false,
  });
  return { repoId: repo.id, storageKey: repo.storageKey, ownerId: alice.id };
}

async function mintWriteToken(userId: number): Promise<string> {
  return (await mintFor(userId, "w", "write:repository")).plaintext;
}

/** Stage one chunk (bytes + staged record) without the HTTP layer. */
async function stageChunk(importId: number, storageKey: string, n: number, chunk: FixtureChunk): Promise<void> {
  await env.REPO_PACKS.put(importChunkR2Key(storageKey, importId, n), chunk.pack);
  await importService().recordStagedChunk(importId, n, { bytes: chunk.pack.length, sha1: chunk.sha1 });
}

function manifestFor(head: string, refs: Record<string, string>, chunks: FixtureChunk[]): ImportManifest {
  return {
    head,
    refs,
    chunks: chunks.map((c, i) => ({ n: i, bytes: c.pack.length, sha1: c.sha1, tip: c.oid })),
    totalBytes: chunks.reduce((sum, c) => sum + c.pack.length, 0),
  };
}

/** A REPO_TASKS producer stub whose sends go nowhere — for tests that drive
 *  the redelivery path by hand instead of racing the live dev queue. */
function quietQueue(): Queue {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  return {
    send: () => Promise.resolve({ metadata }),
    sendBatch: () => Promise.resolve({ metadata }),
    metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
  };
}

function parseStaged(row: typeof repoImports.$inferSelect): Record<string, { bytes: number; sha1: string }> {
  if (row.staged === null) return {};
  return JSON.parse(row.staged) as Record<string, { bytes: number; sha1: string }>;
}

const API = "https://example.com/api/v1";

async function createImportViaApi(
  repoSlug: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await SELF.fetch(`${API}/repos/alice/${repoSlug}/imports`, {
    method: "POST",
    headers: { authorization: `token ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  return { status: res.status, body: await res.json<Record<string, unknown>>() };
}

// ---------------------------------------------------------------------------
// 1. State machine (service-level, real D1)
// ---------------------------------------------------------------------------

describe("import state machine (SPEC-0003 §2.6, §3.1)", () => {
  it("create flips the repo to migrating and the partial unique index arbitrates one active import", async () => {
    const { repoId } = await seedRepo("stated");
    const first = await importService().create(repoId);
    expect(first.row.state).toBe("staged");
    expect(first.importToken).toMatch(/^imp_[0-9a-f]{40}$/);
    expect(first.row.importTokenSha256).not.toContain(first.importToken); // only the digest is stored
    expect(first.chunkCap).toBe(CHUNK_SIZE_CAP_BYTES);
    expect((await new RepoService(env.DB).get(repoId))?.status).toBe("migrating");

    // One active import per repo — the status guard AND the partial unique
    // index both reject a second create.
    await expect(importService().create(repoId)).rejects.toBeInstanceOf(ImportConflictError);
  });

  it("refuses to import a non-empty or archived repo, and resets the status flip atomically", async () => {
    const { repoId } = await seedRepo("guarded");
    const repos = drizzle(env.DB);
    await repos.update(repositories).set({ isEmpty: false }).where(eq(repositories.id, repoId));
    await expect(importService().create(repoId)).rejects.toBeInstanceOf(ImportConflictError);
    expect((await new RepoService(env.DB).get(repoId))?.status).toBe("ready");

    await repos.update(repositories).set({ isEmpty: true, isArchived: true }).where(eq(repositories.id, repoId));
    await expect(importService().create(repoId)).rejects.toBeInstanceOf(ImportConflictError);
    expect((await new RepoService(env.DB).get(repoId))?.status).toBe("ready");
  });

  it("start validates the manifest against the staged uploads before touching state", async () => {
    const { repoId, storageKey } = await seedRepo("validated");
    const { row } = await importService().create(repoId);
    const chunk = await commitPack("c0", [], [{ name: "a.txt", content: "one" }], 1700000000);
    const good = manifestFor("main", { "refs/heads/main": chunk.oid }, [chunk]);

    // Nothing staged yet.
    await expect(importService().start(row.id, good)).rejects.toThrow(/has not been uploaded/);

    await stageChunk(row.id, storageKey, 0, chunk);

    // size mismatch
    await expect(
      importService().start(row.id, {
        ...good,
        chunks: [{ ...good.chunks[0]!, bytes: good.chunks[0]!.bytes + 1 }],
        totalBytes: good.totalBytes + 1,
      }),
    ).rejects.toThrow(/size mismatch/);
    // digest mismatch
    await expect(
      importService().start(row.id, {
        ...good,
        chunks: [{ ...good.chunks[0]!, sha1: "0".repeat(40) }],
      }),
    ).rejects.toThrow(/digest mismatch/);
    // head not among the refs
    await expect(importService().start(row.id, { ...good, head: "trunk" })).rejects.toThrow(
      /must name a branch/,
    );
    // chunk over the row's cap
    await expect(
      importService().start(row.id, {
        ...good,
        chunks: [{ ...good.chunks[0]!, bytes: CHUNK_SIZE_CAP_BYTES + 1 }],
        totalBytes: CHUNK_SIZE_CAP_BYTES + 1,
      }),
    ).rejects.toThrow(/size cap/);
    // non-contiguous chunk indexes
    await expect(
      importService().start(row.id, { ...good, chunks: [{ ...good.chunks[0]!, n: 3 }] }),
    ).rejects.toThrow(/contiguous/);

    // A rejected start never left 'staged'.
    expect((await importService().get(row.id))?.state).toBe("staged");

    const started = await importService().start(row.id, good);
    expect(started.pending).toEqual([0]);
    expect((await importService().get(row.id))?.state).toBe("indexing");
    // Resume: start again re-enqueues only the non-done chunks.
    await importService().checkpointChunk(row.id, 0, { status: "done" });
    expect((await importService().start(row.id, good)).pending).toEqual([]);
  });

  it("checkpoint is CAS-guarded on state='indexing' (an abort wins the race)", async () => {
    const { repoId } = await seedRepo("racy");
    const service = importService();
    const { row } = await service.create(repoId);
    const chunk = await commitPack("c0", [], [{ name: "a.txt", content: "x" }], 1700000001);
    await stageChunk(row.id, "unused-key", 0, chunk);
    await service.start(row.id, manifestFor("main", { "refs/heads/main": chunk.oid }, [chunk]));

    await service.abort(row.id);
    await expect(service.checkpointChunk(row.id, 0, { status: "done" })).rejects.toThrow(
      /state changed concurrently/,
    );
  });

  it("abort is CAS'd to terminal states and settles the repo back to ready-empty", async () => {
    const { repoId } = await seedRepo("abortable");
    const service = importService();
    const { row } = await service.create(repoId);
    const aborted = await service.abort(row.id);
    expect(aborted?.state).toBe("failed");
    expect(aborted?.error).toBe("aborted");
    const repo = (await new RepoService(env.DB).get(repoId))!;
    expect(repo.status).toBe("ready");
    expect(repo.isEmpty).toBe(true);
    expect(await service.abort(row.id)).toBeNull(); // terminal: 409 at the API layer
  });

  it("the sweep abandons imports silent beyond the heartbeat window", async () => {
    const { repoId } = await seedRepo("sweepable");
    const service = importService();
    const { row } = await service.create(repoId);
    expect(await service.sweepIfStale(row.id)).toBe(false); // fresh heartbeat

    await env.DB.prepare("UPDATE repo_imports SET heartbeat_at = unixepoch() - 90000 WHERE id = ?")
      .bind(row.id)
      .run();
    expect(await service.sweepIfStale(row.id)).toBe(true);
    const failed = await service.get(row.id);
    expect(failed?.state).toBe("failed");
    expect(failed?.error).toBe("heartbeat timeout");
    expect((await new RepoService(env.DB).get(repoId))?.status).toBe("ready");
  });

  it("settleDone flips is_empty/default_branch/status and the import in one batch", async () => {
    const { repoId } = await seedRepo("settleable");
    const service = importService();
    const { row } = await service.create(repoId);
    // The indexing→finalizing CAS refuses a staged row; drive the state the
    // way the consumer does (start flips it) — here via the row directly, so
    // the finalizing→done half stays the unit under test.
    await env.DB.prepare("UPDATE repo_imports SET state = 'finalizing' WHERE id = ?")
      .bind(row.id)
      .run();
    await expect(service.beginFinalizing(row.id)).resolves.toBe(false); // staged/finalizing CAS
    await service.settleDone(row.id, "trunk");
    const repo = (await new RepoService(env.DB).get(repoId))!;
    expect(repo.status).toBe("ready");
    expect(repo.isEmpty).toBe(false);
    expect(repo.defaultBranch).toBe("trunk");
    expect((await service.get(row.id))?.state).toBe("done");
  });

  it("GET /repos/{owner}/{repo} reflects the settle both ways: empty:true before, empty:false after (refs_version stays 0)", async () => {
    const { repoId } = await seedRepo("flagged");
    const service = importService();
    const { row } = await service.create(repoId);

    // Fresh (post-create, mid-import) repo renders empty like upstream.
    const before = await SELF.fetch(`${API}/repos/alice/flagged`);
    expect(before.status).toBe(200);
    expect((await before.json<Record<string, unknown>>()).empty).toBe(true);

    await env.DB.prepare("UPDATE repo_imports SET state = 'finalizing' WHERE id = ?")
      .bind(row.id)
      .run();
    await service.settleDone(row.id, "trunk");

    // Regression: the settle flips is_empty but refs_version is
    // observability-only and stays 0 — the API must read is_empty, or an
    // imported repo renders empty:true (and size:0) forever.
    const after = await SELF.fetch(`${API}/repos/alice/flagged`);
    expect(after.status).toBe(200);
    const body = await after.json<Record<string, unknown>>();
    expect(body.empty).toBe(false);
    expect(body.default_branch).toBe("trunk");
  });

  it("validateManifest is a pure contract over the staged record", () => {
    expect(() => validateManifest(null, CHUNK_SIZE_CAP_BYTES, {})).toThrow(ManifestInvalidError);
    expect(() => validateManifest({ head: "x" }, CHUNK_SIZE_CAP_BYTES, {})).toThrow(ManifestInvalidError);
  });
});

// ---------------------------------------------------------------------------
// 2. Relay endpoints (real router via SELF.fetch)
// ---------------------------------------------------------------------------

describe("import relay endpoints (SPEC-0003 §2.6)", () => {
  it("POST creates the import (owner-or-admin) and a second POST during an active import 409s", async () => {
    const { ownerId } = await seedRepo("relay");
    const token = await mintWriteToken(ownerId);

    const first = await createImportViaApi("relay", token);
    expect(first.status).toBe(201);
    expect(first.body.import_id).toBeTypeOf("number");
    expect(first.body.import_token).toMatch(/^imp_/);
    expect(first.body.chunk_size_cap).toBe(CHUNK_SIZE_CAP_BYTES);
    expect(String(first.body.upload)).toContain("/imports/");

    // §4.9's API-side 409: an active import blocks a second one.
    const second = await createImportViaApi("relay", token);
    expect(second.status).toBe(409);
  });

  it("401s anonymous, 403s non-owners, 404s invisible repos", async () => {
    const { ownerId } = await seedRepo("guardpost");
    const outsider = await seedVerifiedUser({ username: "Outsider" });
    const outsiderToken = await mintWriteToken(outsider.id);

    const anon = await SELF.fetch(`${API}/repos/alice/guardpost/imports`, { method: "POST" });
    expect(anon.status).toBe(401);

    // Public repo, non-owner → authenticated but not admin → 403.
    expect((await createImportViaApi("guardpost", outsiderToken)).status).toBe(403);

    // Private repo, non-owner → the 404 anti-enumeration.
    await drizzle(env.DB)
      .update(repositories)
      .set({ visibility: "private" })
      .where(eq(repositories.slug, "guardpost"));
    expect((await createImportViaApi("guardpost", outsiderToken)).status).toBe(404);

    void ownerId;
  });

  it("PUT streams the chunk into R2 under the SPEC key layout; caps and auth hold", async () => {
    const { ownerId, storageKey } = await seedRepo("streamed");
    const token = await mintWriteToken(ownerId);
    const created = await createImportViaApi("streamed", token);
    const importId = created.body.import_id as number;
    const importToken = created.body.import_token as string;
    const bytes = new TextEncoder().encode("fake-pack-bytes-for-the-relay");

    const put = await SELF.fetch(`${API}/repos/alice/streamed/imports/${importId}/chunks/0`, {
      method: "PUT",
      headers: {
        "x-import-token": importToken,
        "content-type": "application/octet-stream",
        "x-chunk-sha1": "1".repeat(40),
      },
      body: bytes,
    });
    expect(put.status).toBe(200);

    // Roundtrip: exact bytes at imports/<storage_key>/<import_id>/chunk-0000.pack.
    const stored = await env.REPO_PACKS.get(importChunkR2Key(storageKey, importId, 0));
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);

    const row = (await importService().get(importId))!;
    expect(parseStaged(row)).toEqual({ "0": { bytes: bytes.length, sha1: "1".repeat(40) } });

    // Wrong token → 401.
    const badToken = await SELF.fetch(`${API}/repos/alice/streamed/imports/${importId}/chunks/0`, {
      method: "PUT",
      headers: { "x-import-token": `imp_${"0".repeat(20)}`, "x-chunk-sha1": "1".repeat(40) },
      body: "abcd",
    });
    expect(badToken.status).toBe(401);

    // Out-of-range index → 400; missing digest header → 400.
    const badIndex = await SELF.fetch(`${API}/repos/alice/streamed/imports/${importId}/chunks/99999`, {
      method: "PUT",
      headers: { "x-import-token": importToken, "x-chunk-sha1": "1".repeat(40) },
      body: "abcd",
    });
    expect(badIndex.status).toBe(400);

    const noDigest = await SELF.fetch(`${API}/repos/alice/streamed/imports/${importId}/chunks/0`, {
      method: "PUT",
      headers: { "x-import-token": importToken },
      body: "abcd",
    });
    expect(noDigest.status).toBe(400);

    // No Content-Length (streamed body) → 411: the engine's known-length
    // staging path needs the declared size.
    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abcd"));
        controller.close();
      },
    });
    const noLength = await SELF.fetch(`${API}/repos/alice/streamed/imports/${importId}/chunks/0`, {
      method: "PUT",
      headers: { "x-import-token": importToken, "x-chunk-sha1": "1".repeat(40) },
      body: streamBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(noLength.status).toBe(411);

    // Size cap (the row's frozen chunk_cap, shrunk here to test the check).
    await env.DB.prepare("UPDATE repo_imports SET chunk_cap = 2 WHERE id = ?").bind(importId).run();
    const overCap = await SELF.fetch(`${API}/repos/alice/streamed/imports/${importId}/chunks/0`, {
      method: "PUT",
      headers: { "x-import-token": importToken, "x-chunk-sha1": "1".repeat(40) },
      body: "abcdef",
    });
    expect(overCap.status).toBe(413);

    // Uploads require an active import: abort, then PUT → 409.
    await importService().abort(importId);
    const dead = await SELF.fetch(`${API}/repos/alice/streamed/imports/${importId}/chunks/0`, {
      method: "PUT",
      headers: { "x-import-token": importToken, "x-chunk-sha1": "1".repeat(40) },
      body: "abcd",
    });
    expect(dead.status).toBe(409);
  });

  it("start reports queued chunks, GET exposes checkpoints, abort purges the prefix", async () => {
    const { ownerId, repoId, storageKey } = await seedRepo("lifecycle");
    const token = await mintWriteToken(ownerId);
    const created = await createImportViaApi("lifecycle", token);
    const importId = created.body.import_id as number;
    const chunk = await commitPack("c0", [], [{ name: "a.txt", content: "lifecycle" }], 1700000002);
    await stageChunk(importId, storageKey, 0, chunk);

    // Validation errors surface as the declared 400.
    const badStart = await SELF.fetch(`${API}/repos/alice/lifecycle/imports/${importId}/start`, {
      method: "POST",
      headers: { authorization: `token ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ head: "main", refs: {}, chunks: [] }),
    });
    expect(badStart.status).toBe(400);

    const start = await SELF.fetch(`${API}/repos/alice/lifecycle/imports/${importId}/start`, {
      method: "POST",
      headers: { authorization: `token ${token}`, "content-type": "application/json" },
      body: JSON.stringify(manifestFor("main", { "refs/heads/main": chunk.oid }, [chunk])),
    });
    expect(start.status).toBe(200);
    expect(((await start.json<{ queued_chunks: number[] }>())).queued_chunks).toEqual([0]);

    const status = await SELF.fetch(`${API}/repos/alice/lifecycle/imports/${importId}`, {
      headers: { authorization: `token ${token}` },
    });
    expect(status.status).toBe(200);
    const body = await status.json<{ state: string; manifest: { chunks: { status?: string }[] } | null }>();
    expect(body.state).toBe("indexing");
    expect(body.manifest?.chunks[0]?.status).toBe("pending");

    // Abort through the API: the D1 CAS + repo reset land synchronously; the
    // storage half (ref cleanup + R2 prefix purge) is the queued import-abort
    // message's work — driven here by hand for determinism.
    const abort = await SELF.fetch(`${API}/repos/alice/lifecycle/imports/${importId}/abort`, {
      method: "POST",
      headers: { authorization: `token ${token}` },
    });
    expect(abort.status).toBe(200);
    expect(((await abort.json<{ state: string }>())).state).toBe("failed");
    expect((await new RepoService(env.DB).get(repoId))?.status).toBe("ready");
    await handleImportTask(env, { kind: "import-abort", importId, repoId });
    expect(
      (await env.REPO_PACKS.list({ prefix: `imports/${storageKey}/${importId}/` })).objects,
    ).toHaveLength(0);

    // Abort after done → 409.
    const second = await createImportViaApi("lifecycle", token);
    const secondId = second.body.import_id as number;
    await env.DB.prepare("UPDATE repo_imports SET state = 'finalizing' WHERE id = ?")
      .bind(secondId)
      .run();
    await importService().settleDone(secondId, "main");
    const tooLate = await SELF.fetch(`${API}/repos/alice/lifecycle/imports/${secondId}/abort`, {
      method: "POST",
      headers: { authorization: `token ${token}` },
    });
    expect(tooLate.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// 3. Consumer pipeline — real packs through the engine's receive path
// ---------------------------------------------------------------------------

describe("import consumer pipeline (stage-as-receive, SPEC-0003 §2.6)", () => {
  it("indexes a real chunk, lands the pack under the storage key, finalizes the refs, and settles the repo", async () => {
    const { repoId, storageKey } = await seedRepo("single");
    const chunk = await buildPack(); // the shared single-commit fixture (blob+tree+commit)
    const fixture: FixtureChunk = { oid: chunk.oid, pack: chunk.pack, sha1: await trailerSha1(chunk.pack) };

    const service = importService();
    const { row } = await service.create(repoId);
    await stageChunk(row.id, storageKey, 0, fixture);
    await service.start(row.id, manifestFor("main", { "refs/heads/main": chunk.oid }, [fixture]));

    expect(await indexChunk(env, row.id, repoId, 0)).toBe(true);

    // The pack + idx landed under the D1 storage key (never a name prefix),
    // and the landed digest matches the manifest declaration.
    const packs = await env.REPO_PACKS.list({ prefix: `repos/${storageKey}/packs/` });
    expect(packs.objects.map((o) => o.key).sort()).toEqual(
      [
        `repos/${storageKey}/packs/pack-${fixture.sha1}.idx`,
        `repos/${storageKey}/packs/pack-${fixture.sha1}.pack`,
      ].sort(),
    );

    // Finalize landed the manifest ref and deleted the temporary marker.
    const refs = await env.REPO.getByName("alice/single").listRefs();
    expect(refs.refs).toEqual([{ name: "refs/heads/main", target: chunk.oid }]);
    expect(refs.head).toBe("refs/heads/main");
    expect(refs.refs.some((r) => r.name === chunkTempRef(row.id, 0))).toBe(false);

    // D1 settle: repo ready + non-empty + default branch from the manifest.
    const repo = (await new RepoService(env.DB).get(repoId))!;
    expect(repo.status).toBe("ready");
    expect(repo.isEmpty).toBe(false);
    expect(repo.defaultBranch).toBe("main");
    expect((await importService().get(row.id))?.state).toBe("done");

    // The repo clones (the advertisement carries the imported tip).
    const advert = await SELF.fetch("https://example.com/alice/single.git/info/refs?service=git-upload-pack");
    expect(advert.status).toBe(200);
    expect(await advert.text()).toContain(chunk.oid);
  });

  it("keeps out-of-order chunks honest: the child fails connectivity, re-queues, completes after its parent", async () => {
    const { repoId, storageKey } = await seedRepo("ordered");
    const parent = await commitPack("root", [], [{ name: "a.txt", content: "root" }], 1700000003);
    const child = await commitPack("child", [parent.oid], [{ name: "b.txt", content: "child" }], 1700000004);

    const service = importService();
    const { row } = await service.create(repoId);
    await stageChunk(row.id, storageKey, 0, parent);
    await stageChunk(row.id, storageKey, 1, child);
    await service.start(row.id, manifestFor("main", { "refs/heads/main": child.oid }, [parent, child]));

    // The requeue path (chunkFailed → REPO_TASKS.send) is real here, and the
    // dev queue redelivers quickly; shadow the producer so THIS test drives
    // the retry itself deterministically (fast redelivery is the production
    // recovery path — the pipeline is idempotent under it either way).
    const quietEnv = { ...env, REPO_TASKS: quietQueue() };

    // Child FIRST (queue batches are not strictly FIFO): its commit
    // references the parent, which is not indexed yet — the engine's verdict
    // is ng "missing necessary objects" and the consumer re-queues instead of
    // failing the import.
    expect(await indexChunk(quietEnv, row.id, repoId, 1)).toBe(false);
    const mid = (await importService().get(row.id))!;
    expect(mid.state).toBe("indexing");
    expect(parseManifestRow(mid).chunks[1]?.attempts).toBe(1);
    expect(parseManifestRow(mid).chunks[1]?.status).toBe("pending");

    // Parent lands, then the retried child completes and finalizes.
    expect(await indexChunk(quietEnv, row.id, repoId, 0)).toBe(false); // finalize waits for chunk 1
    expect(await indexChunk(quietEnv, row.id, repoId, 1)).toBe(true);

    const repo = (await new RepoService(env.DB).get(repoId))!;
    expect(repo.isEmpty).toBe(false);
    const refs = await env.REPO.getByName("alice/ordered").listRefs();
    expect(refs.refs).toEqual([{ name: "refs/heads/main", target: child.oid }]);
    expect((await importService().get(row.id))?.state).toBe("done");
  });

  it("fails the import on a genuinely broken chunk (missing bytes, digest drift)", async () => {
    const chunk = await commitPack("c0", [], [{ name: "a.txt", content: "x" }], 1700000005);
    const service = importService();

    // Bytes missing entirely (the staged record lies).
    const first = await seedRepo("broken");
    const { row } = await service.create(first.repoId);
    await service.recordStagedChunk(row.id, 0, { bytes: chunk.pack.length, sha1: chunk.sha1 });
    await service.start(row.id, manifestFor("main", { "refs/heads/main": chunk.oid }, [chunk]));
    expect(await indexChunk(env, row.id, first.repoId, 0)).toBe(true);
    const failed = (await service.get(row.id))!;
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("not in storage");

    // A lying manifest is rejected at start (staged digest cross-check)…
    const second = await seedRepo("drift");
    const { row: row2 } = await service.create(second.repoId);
    await stageChunk(row2.id, second.storageKey, 0, chunk);
    await expect(
      service.start(row2.id, {
        head: "main",
        refs: { "refs/heads/main": chunk.oid },
        chunks: [{ n: 0, bytes: chunk.pack.length, sha1: "f".repeat(40), tip: chunk.oid }],
        totalBytes: chunk.pack.length,
      }),
    ).rejects.toThrow(/digest mismatch/);

    // …and storage-side drift (the R2 object swapped after start) is caught
    // by the consumer's landed-digest cross-check: the reordered pack still
    // carries the tip, so the receive commits, but under a different pack
    // name than the manifest declared.
    const reordered = await packOf([
      await treeObject([{ name: "a.txt", oid: (await blobObject("x")).oid }]),
      await blobObject("x"),
      await commitObject(
        (await treeObject([{ name: "a.txt", oid: (await blobObject("x")).oid }])).oid,
        [],
        "c0",
        1700000005,
      ),
    ]);
    expect(reordered.sha1).not.toBe(chunk.sha1);
    await env.REPO_PACKS.put(importChunkR2Key(second.storageKey, row2.id, 0), reordered.pack);
    await service.start(row2.id, manifestFor("main", { "refs/heads/main": chunk.oid }, [chunk]));
    expect(await indexChunk(env, row2.id, second.repoId, 0)).toBe(true);
    const drifted = (await service.get(row2.id))!;
    expect(drifted.state).toBe("failed");
    expect(drifted.error).toContain("digest differs");
  });

  it("abort leaves no prefix and no temporary refs, and later chunk messages no-op", async () => {
    const { repoId, storageKey } = await seedRepo("abortcleanup");
    const chunk = await commitPack("c0", [], [{ name: "a.txt", content: "cleanup" }], 1700000006);
    const service = importService();
    const { row } = await service.create(repoId);
    await stageChunk(row.id, storageKey, 0, chunk);
    await service.start(row.id, manifestFor("main", { "refs/heads/main": chunk.oid }, [chunk]));

    await service.abort(row.id);
    await cleanupAbortedImport(env, row.id, repoId);
    expect(
      (await env.REPO_PACKS.list({ prefix: `imports/${storageKey}/${row.id}/` })).objects,
    ).toHaveLength(0);
    const refs = await env.REPO.getByName("alice/abortcleanup").listRefs();
    expect(refs.refs.filter((r) => r.name.startsWith(`refs/import/${row.id}/`))).toEqual([]);

    // A chunk message delivered after the abort is a no-op (state=failed):
    // the row stays failed and nothing new lands in R2.
    expect(await indexChunk(env, row.id, repoId, 0)).toBe(true);
    expect((await service.get(row.id))?.state).toBe("failed");
  });

  it("REPO_TASKS dispatch routes import and purge messages (ack semantics)", async () => {
    const { repoId, storageKey } = await seedRepo("dispatched");
    const chunk = await buildPack();
    const fixture: FixtureChunk = { oid: chunk.oid, pack: chunk.pack, sha1: await trailerSha1(chunk.pack) };
    const service = importService();
    const { row } = await service.create(repoId);
    await stageChunk(row.id, storageKey, 0, fixture);
    await service.start(row.id, manifestFor("main", { "refs/heads/main": chunk.oid }, [fixture]));

    const acked: string[] = [];
    const retried: string[] = [];
    const message = (id: string, body: unknown) => ({
      id,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {
        acked.push(id);
      },
      retry: () => {
        retried.push(id);
      },
    });
    const batch = {
      queue: "repo-tasks",
      messages: [
        message("chunk", { kind: "import-chunk", importId: row.id, repoId, chunk: 0 }),
        message("unknown-import", { kind: "import-chunk", importId: 424242, repoId, chunk: 0 }),
        message("purge", { storageKey: "r_nobody", engineNames: ["alice/ghost"] }),
        message("garbage", { hello: true }),
      ],
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
      retryAll: () => {
        retried.push("all");
      },
      ackAll: () => {
        acked.push("all");
      },
    };

    await handleRepoTasks(batch, env);
    expect(acked.sort()).toEqual(["chunk", "garbage", "purge", "unknown-import"]);
    expect(retried).toEqual([]);
    // The chunk message did the work end-to-end.
    expect((await service.get(row.id))?.state).toBe("done");
  });

  it("handleImportTask sweeps stale imports through the queue message shape", async () => {
    const { repoId } = await seedRepo("sweeptask");
    const service = importService();
    const { row } = await service.create(repoId);
    await env.DB.prepare("UPDATE repo_imports SET heartbeat_at = unixepoch() - 90000 WHERE id = ?")
      .bind(row.id)
      .run();
    await handleImportTask(env, { kind: "import-sweep", importId: row.id, repoId });
    expect((await service.get(row.id))?.state).toBe("failed");
  });
});
