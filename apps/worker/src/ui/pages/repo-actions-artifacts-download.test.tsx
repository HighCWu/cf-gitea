/**
 * The runs-artifact download + delete family's tests
 * (pages/repo-actions-artifacts-download.ts — upstream view.go:1183-1279 at
 * the pin, over seeded M1b rows): the attempt-query resolution's
 * error/absent arms, the legacy v1 zip-compose stream (entry names, gunzip
 * arms, CRC/data-descriptor/EFS fidelity, byte-exact contents over an
 * independent CRC + full central-directory parse), the v4 single-zip
 * pass-through (the ServeUserContentByFile header chain + the minimal
 * single-range arms), the family 404s (empty/unconfirmed/pending-deletion),
 * the attempt scoping, and the DELETE mark (status flips on confirmed rows
 * only, storage untouched — the retention sweep owns deletion).
 *
 * The route arms are unit-level by design: ui/index.ts (the mount) is
 * orchestrator-owned — the module's closing HANDOFF recipe carries the
 * registration, and the route-level fetch pins land with it.
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { actionArtifacts, actionRunAttempts, actionRuns, repositories } from "../../db/schema";
import { insertActionRun } from "../../services/actions/model";
import type { RepoRow } from "../ui-context";
import { buildRunArtifactDownload, deleteRunArtifact, goPathBase, resolveArtifactAttemptIdFromQuery } from "./repo-actions-artifacts-download";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000);
const WORKFLOW_ID = ".github/workflows/ci.yml";
const SHA = "ccccdddddddddddddddddddddddddddddddddddd";
const PAYLOAD = new TextEncoder().encode("jobs: {}\n");

let repo: RepoRow;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["action_artifacts", "action_run_attempts", "action_run_jobs", "action_runs", "action_runners", "action_tasks_versions", "repo_settings", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const artifacts = await env.REPO_PACKS.list({ prefix: "actions/artifacts/" });
  if (artifacts.objects.length > 0) await env.REPO_PACKS.delete(artifacts.objects.map((o) => o.key));

  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, is_empty, created_at) VALUES ('repo-demo', 'repo-demo', 'alice', 1, 'demo', 'main', 'public', 0, unixepoch())",
  ).run();
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-demo")).get();
  if (row === undefined) throw new Error("fixture repository missing");
  repo = row;
  await saveRepoSettings(env.DB, repo.id, { hasActions: true }, T0);
});

/** Seed one run through the M1a staged insert (run + attempt 1 + one job). */
async function seedRun(): Promise<{ runId: number; latestAttemptId: number }> {
  const { run, attempt } = await insertActionRun(
    env.DB,
    {
      repoId: repo.id,
      ownerId: 1,
      workflowId: WORKFLOW_ID,
      index: 1,
      triggerUserId: 1,
      ref: "refs/heads/main",
      commitSha: SHA,
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
    },
    [{ jobId: "build", workflowPayload: PAYLOAD }],
  );
  return { runId: run.id, latestAttemptId: attempt.id };
}

/** Seed one artifact row (the C4 arms' direct-row precedent) + its stored
 *  object; `content` rides storage verbatim (gzip rows pre-compressed by
 *  the caller, exactly what the v1 merge lands in R2). */
async function seedArtifact(opts: {
  runId: number;
  runAttemptId: number;
  name: string;
  path: string;
  content: Uint8Array;
  status?: number;
  encoding?: string;
  attemptIdOverride?: number;
}): Promise<{ id: number; storagePath: string }> {
  const storagePath = `actions/artifacts/${opts.runId}/${Math.floor(Math.random() * 1e9)}`;
  await env.REPO_PACKS.put(storagePath, opts.content);
  const rows = await drizzle(env.DB)
    .insert(actionArtifacts)
    .values({
      runId: opts.runId,
      runAttemptId: opts.attemptIdOverride ?? opts.runAttemptId,
      runnerId: 0,
      repoId: repo.id,
      ownerId: 1,
      commitSha: SHA,
      storagePath,
      fileSize: opts.content.length,
      fileCompressedSize: opts.content.length,
      contentEncodingOrType: opts.encoding ?? "",
      artifactPath: opts.path,
      artifactName: opts.name,
      status: opts.status ?? 2, // UploadConfirmed
      created: T0,
      updated: T0,
      expiredUnix: 0,
    })
    .returning({ id: actionArtifacts.id });
  return { id: rows[0]!.id, storagePath };
}

async function readBody(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

// --- the zip oracle (independent of the module's writer) ----------------------

/** Table-less bitwise CRC-32 — the reference the zip fields are checked
 *  against (the implementation's table shape is irrelevant to the oracle). */
function crc32Reference(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipOracleEntry {
  name: string;
  centralFlags: number;
  localFlags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  data: Uint8Array;
}

/** Full structural parse: EOCD → central directory → local headers → the
 *  stored run → data descriptor boundary; method-8 entries inflate through
 *  the platform inflater. Throws on any structural surprise. */
async function parseZipOracle(bytes: Uint8Array): Promise<ZipOracleEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number): number => view.getUint16(at, true);
  const u32 = (at: number): number => view.getUint32(at, true);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("oracle: no EOCD");
  const count = u16(eocd + 10);
  const cdSize = u32(eocd + 12);
  const cdOffset = u32(eocd + 16);
  if (eocd !== cdOffset + cdSize) throw new Error(`oracle: EOCD at ${eocd} but cd ends at ${cdOffset + cdSize}`);
  const decoder = new TextDecoder();
  const entries: ZipOracleEntry[] = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (u32(at) !== 0x02014b50) throw new Error("oracle: bad central signature");
    const flags = u16(at + 8);
    const method = u16(at + 10);
    const crc = u32(at + 16);
    const compressedSize = u32(at + 20);
    const uncompressedSize = u32(at + 24);
    const nameLength = u16(at + 28);
    const localOffset = u32(at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (u32(localOffset) !== 0x04034b50) throw new Error("oracle: bad local signature");
    const localFlags = u16(localOffset + 6);
    const localNameLength = u16(localOffset + 26);
    const localExtraLength = u16(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const stored = bytes.subarray(dataStart, dataStart + compressedSize);
    // The 12-byte data descriptor rides right after the stored bytes (flag
    // 0x8) — its crc field must repeat the central directory's.
    if ((localFlags & 0x8) !== 0) {
      const descriptorCrc = u32(dataStart + compressedSize);
      if (descriptorCrc !== crc) throw new Error("oracle: descriptor crc mismatch");
    }
    let data: Uint8Array = stored;
    if (method === 8) {
      data = new Uint8Array(
        await new Response(new Response(new Uint8Array(stored)).body!.pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer(),
      );
    } else if (method !== 0) {
      throw new Error(`oracle: unexpected method ${method}`);
    }
    entries.push({ name, centralFlags: flags, localFlags, method, crc32: crc, compressedSize, uncompressedSize, data });
    at += 46 + nameLength + u16(at + 30) + u16(at + 32);
  }
  return entries;
}

async function gzipOf(content: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await new Response(new Response(content.slice()).body!.pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  );
}

/** Seeds the standard two-row legacy family: a plain row + a gzip-on-store
 *  row (what the v1 merge stores for Content-Encoding: gzip uploads). */
async function seedLegacyFamily(runId: number, attemptId: number): Promise<{ plain: string; gzipped: string }> {
  const plain = await seedArtifact({
    runId,
    runAttemptId: attemptId,
    name: "dist",
    path: "a.txt",
    content: new TextEncoder().encode("hello a"),
  });
  const raw = new TextEncoder().encode("binary \u0000 payload");
  const gzipped = await seedArtifact({
    runId,
    runAttemptId: attemptId,
    name: "dist",
    path: "bin/c.dat",
    content: await gzipOf(raw),
    encoding: "gzip",
  });
  return { plain: plain.storagePath, gzipped: gzipped.storagePath };
}

// --- the tests ----------------------------------------------------------------

describe("resolveArtifactAttemptIdFromQuery (view.go:1180-1195)", () => {
  it("an absent parameter falls back to run.latestAttemptId; a number resolves the attempt row", async () => {
    const { runId, latestAttemptId } = await seedRun();
    const run = await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get();
    if (run === null || run === undefined) throw new Error("run missing");

    const absent = await resolveArtifactAttemptIdFromQuery(env.DB, run, "");
    expect(absent).toEqual({ outcome: "ok", runAttemptId: latestAttemptId });

    const explicit = await resolveArtifactAttemptIdFromQuery(env.DB, run, "1");
    expect(explicit).toEqual({ outcome: "ok", runAttemptId: latestAttemptId });
  });

  it("junk, zero, negative and unknown attempt numbers are the ServerError arms (not 404s)", async () => {
    const { runId } = await seedRun();
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;
    for (const query of ["junk", "0", "-1", "99"]) {
      expect(await resolveArtifactAttemptIdFromQuery(env.DB, run, query)).toEqual({ outcome: "error" });
    }
  });
});

describe("the GET download — the legacy zip-compose arm (view.go:1234-1278)", () => {
  it("composes the zip: attachment disposition, entry names, gunzip, byte-exact contents, crc fidelity", async () => {
    const { runId, latestAttemptId } = await seedRun();
    await seedLegacyFamily(runId, latestAttemptId);
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;

    const outcome = await buildRunArtifactDownload(env, run, "dist", "", null);
    if (outcome.outcome !== "ok") throw new Error(`expected ok, got ${outcome.outcome}`);
    const response = outcome.response;
    expect(response.status).toBe(200);
    // mime.FormatMediaType leaves token-safe names unquoted (Go's shape the
    // landed encoder mirrors).
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=dist.zip");
    expect(response.headers.get("content-type")).toBe("application/zip");

    const entries = await parseZipOracle(await readBody(response));
    expect(entries.map((entry) => entry.name)).toEqual(["a.txt", "bin/c.dat"]);
    expect(entries.map((entry) => new TextDecoder().decode(entry.data))).toEqual(["hello a", "binary \u0000 payload"]);
    for (const entry of entries) {
      expect(entry.method).toBe(8); // zipWriter.Create's Deflate default
      expect(entry.crc32).toBe(crc32Reference(entry.data));
      expect(entry.uncompressedSize).toBe(entry.data.length);
      expect(entry.centralFlags & 0x8).toBe(8); // the data-descriptor flag
      expect(entry.localFlags & 0x8).toBe(8);
    }
  });

  it("flags non-ASCII entry names with the EFS bit and decodes them as UTF-8", async () => {
    const { runId, latestAttemptId } = await seedRun();
    await seedArtifact({
      runId,
      runAttemptId: latestAttemptId,
      name: "dist",
      path: "ü/nö.txt",
      content: new TextEncoder().encode("unicode"),
    });
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;
    const outcome = await buildRunArtifactDownload(env, run, "dist", "", null);
    if (outcome.outcome !== "ok") throw new Error(`expected ok, got ${outcome.outcome}`);
    const entries = await parseZipOracle(await readBody(outcome.response));
    expect(entries.map((entry) => entry.name)).toEqual(["ü/nö.txt"]);
    expect(entries[0]!.centralFlags & 0x800).toBe(0x800);
    expect(entries[0]!.localFlags & 0x800).toBe(0x800);
  });

  it("streams (the body is a live ReadableStream, not a buffered artifact)", async () => {
    const { runId, latestAttemptId } = await seedRun();
    await seedLegacyFamily(runId, latestAttemptId);
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;
    const outcome = await buildRunArtifactDownload(env, run, "dist", "", null);
    if (outcome.outcome !== "ok") throw new Error(`expected ok, got ${outcome.outcome}`);
    expect(outcome.response.body).toBeInstanceOf(ReadableStream);
  });
});

describe("the GET download — the v4 arm (DownloadArtifactV4, artifacts.go:60-65)", () => {
  async function seedV4(size: number): Promise<{ runId: number; content: Uint8Array }> {
    const { runId, latestAttemptId } = await seedRun();
    const content = new Uint8Array(size);
    for (let i = 0; i < size; i++) content[i] = i * 7;
    await seedArtifact({
      runId,
      runAttemptId: latestAttemptId,
      name: "dist",
      path: "dist.zip",
      content,
      encoding: "application/zip", // the v4 marker: a content type contains "/"
    });
    return { runId, content };
  }

  it("serves the stored object verbatim with the ServeUserContentByFile header chain", async () => {
    const { runId, content } = await seedV4(64);
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;
    const outcome = await buildRunArtifactDownload(env, run, "dist", "", null);
    if (outcome.outcome !== "ok") throw new Error(`expected ok, got ${outcome.outcome}`);
    const response = outcome.response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe("inline; filename=dist.zip");
    expect(response.headers.get("content-length")).toBe("64");
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals allow-popups allow-downloads");
    expect(response.headers.get("last-modified")).toMatch(/GMT$/);
    expect(await readBody(response)).toEqual(content);
  });

  it("honors the minimal single range (206 + Content-Range) and the clamp arm", async () => {
    const { runId, content } = await seedV4(16);
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;

    const mid = await buildRunArtifactDownload(env, run, "dist", "", "bytes=2-5");
    if (mid.outcome !== "ok") throw new Error("expected ok");
    expect(mid.response.status).toBe(206);
    expect(mid.response.headers.get("content-range")).toBe("bytes 2-5/16");
    expect(mid.response.headers.get("content-length")).toBe("4");
    expect(await readBody(mid.response)).toEqual(content.slice(2, 6));

    const tail = await buildRunArtifactDownload(env, run, "dist", "", "bytes=10-");
    if (tail.outcome !== "ok") throw new Error("expected ok");
    expect(tail.response.status).toBe(206);
    expect(tail.response.headers.get("content-range")).toBe("bytes 10-15/16");
    expect(await readBody(tail.response)).toEqual(content.slice(10));

    const clamped = await buildRunArtifactDownload(env, run, "dist", "", "bytes=0-99999");
    if (clamped.outcome !== "ok") throw new Error("expected ok");
    expect(clamped.response.status).toBe(206);
    expect(clamped.response.headers.get("content-range")).toBe("bytes 0-15/16");
    expect(await readBody(clamped.response)).toEqual(content);
  });

  it("answers the 416/400 range-error arms with http.Error's plain-text bodies", async () => {
    const { runId } = await seedV4(16);
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;

    const startPast = await buildRunArtifactDownload(env, run, "dist", "", "bytes=999-");
    if (startPast.outcome !== "ok") throw new Error("expected ok");
    expect(startPast.response.status).toBe(416);
    expect(new TextDecoder().decode(await startPast.response.arrayBuffer())).toBe("invalid start range\n");

    const inverted = await buildRunArtifactDownload(env, run, "dist", "", "bytes=5-2");
    if (inverted.outcome !== "ok") throw new Error("expected ok");
    expect(inverted.response.status).toBe(400);
    expect(new TextDecoder().decode(await inverted.response.arrayBuffer())).toBe("invalid end range\n");

    const junk = await buildRunArtifactDownload(env, run, "dist", "", "bytes=junk");
    if (junk.outcome !== "ok") throw new Error("expected ok");
    expect(junk.response.status).toBe(416); // Go's ParseInt error rides the start arm
    expect(new TextDecoder().decode(await junk.response.arrayBuffer())).toBe("invalid start range\n");
  });

  it("serves the full body when the Range header is absent or not a bytes= range", async () => {
    const { runId, content } = await seedV4(16);
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;
    const nonsense = await buildRunArtifactDownload(env, run, "dist", "", "items=0-5");
    if (nonsense.outcome !== "ok") throw new Error("expected ok");
    expect(nonsense.response.status).toBe(200);
    expect(await readBody(nonsense.response)).toEqual(content);
  });
});

describe("the GET download — the family 404s (view.go:1209-1222)", () => {
  it("an unknown artifact name answers not-found", async () => {
    const { runId, latestAttemptId } = await seedRun();
    await seedLegacyFamily(runId, latestAttemptId);
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;
    expect(await buildRunArtifactDownload(env, run, "other", "", null)).toEqual({ outcome: "not-found" });
  });

  it("an unconfirmed or pending-deletion row reads as missing — even mixed into a confirmed family", async () => {
    const { runId, latestAttemptId } = await seedRun();
    await seedLegacyFamily(runId, latestAttemptId);
    await seedArtifact({ runId, runAttemptId: latestAttemptId, name: "dist", path: "p.txt", content: new Uint8Array(3), status: 5 });
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;
    expect(await buildRunArtifactDownload(env, run, "dist", "", null)).toEqual({ outcome: "not-found" });

    await seedArtifact({ runId, runAttemptId: latestAttemptId, name: "half", path: "q.txt", content: new Uint8Array(3), status: 1 });
    expect(await buildRunArtifactDownload(env, run, "half", "", null)).toEqual({ outcome: "not-found" });
  });

  it("the attempt query scopes the family: absent → latest attempt, 1 → attempt 1", async () => {
    const { runId, latestAttemptId } = await seedRun();
    await seedArtifact({
      runId,
      runAttemptId: latestAttemptId,
      name: "dist",
      path: "v1.txt",
      content: new TextEncoder().encode("attempt-one"),
    });
    // A rerun lands attempt 2: a new attempt row + the run's latest pointer
    // (the rerun service's write shape).
    const attemptRows = await drizzle(env.DB)
      .insert(actionRunAttempts)
      .values({ repoId: repo.id, runId, attempt: 2, status: 3, created: T0, updated: T0 })
      .returning({ id: actionRunAttempts.id });
    const attempt2Id = attemptRows[0]!.id;
    await drizzle(env.DB).update(actionRuns).set({ latestAttemptId: attempt2Id }).where(eq(actionRuns.id, runId));
    await seedArtifact({
      runId,
      runAttemptId: attempt2Id,
      name: "dist",
      path: "v2.txt",
      content: new TextEncoder().encode("attempt-two"),
    });
    const refreshed = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;

    const latest = await buildRunArtifactDownload(env, refreshed, "dist", "", null);
    if (latest.outcome !== "ok") throw new Error("expected ok");
    const latestEntries = await parseZipOracle(await readBody(latest.response));
    expect(latestEntries.map((entry) => entry.name)).toEqual(["v2.txt"]);

    const first = await buildRunArtifactDownload(env, refreshed, "dist", "1", null);
    if (first.outcome !== "ok") throw new Error("expected ok");
    const firstEntries = await parseZipOracle(await readBody(first.response));
    expect(firstEntries.map((entry) => entry.name)).toEqual(["v1.txt"]);

    // Attempt 2 explicitly resolves through its NUMBER, not its row id.
    const second = await buildRunArtifactDownload(env, refreshed, "dist", "2", null);
    if (second.outcome !== "ok") throw new Error("expected ok");
    const secondEntries = await parseZipOracle(await readBody(second.response));
    expect(secondEntries.map((entry) => entry.name)).toEqual(["v2.txt"]);
  });
});

describe("the DELETE mark (ArtifactsDeleteView, view.go:1183-1199)", () => {
  it("flips only the confirmed rows to PendingDeletion and answers ctx.JSON's {}", async () => {
    const { runId, latestAttemptId } = await seedRun();
    const seeded = await seedLegacyFamily(runId, latestAttemptId);
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;

    const outcome = await deleteRunArtifact(env.DB, run, "dist", "");
    if (outcome.outcome !== "ok") throw new Error("expected ok");
    expect(outcome.response.status).toBe(200);
    expect(outcome.response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(new TextDecoder().decode(await outcome.response.arrayBuffer())).toBe("{}");

    const rows = await drizzle(env.DB).select().from(actionArtifacts);
    expect(rows.map((row) => row.status)).toEqual([5, 5]); // both confirmed rows marked

    // Mark, never a hard delete: the storage survives for the retention sweep.
    for (const storagePath of [seeded.plain, seeded.gzipped]) {
      expect(await env.REPO_PACKS.get(storagePath)).not.toBeNull();
    }
  });

  it("leaves non-confirmed rows (expired, already-pending) untouched and gates on the attempt", async () => {
    const { runId, latestAttemptId } = await seedRun();
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;
    await seedArtifact({ runId, runAttemptId: latestAttemptId, name: "dist", path: "e.txt", content: new Uint8Array(3), status: 4 });
    await seedArtifact({ runId, runAttemptId: latestAttemptId, name: "dist", path: "p.txt", content: new Uint8Array(3), status: 5 });
    await seedArtifact({ runId, runAttemptId: latestAttemptId, name: "dist", path: "c.txt", content: new Uint8Array(3), status: 2 });

    const outcome = await deleteRunArtifact(env.DB, run, "dist", "");
    expect(outcome.outcome).toBe("ok");
    const byPath = new Map((await drizzle(env.DB).select().from(actionArtifacts)).map((row) => [row.artifactPath, row.status]));
    expect(byPath.get("e.txt")).toBe(4); // expired stays expired
    expect(byPath.get("p.txt")).toBe(5); // pending stays pending
    expect(byPath.get("c.txt")).toBe(5); // only the confirmed row flips
  });

  it("the ServerError arms: junk and unknown attempt numbers", async () => {
    const { runId } = await seedRun();
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;
    expect((await deleteRunArtifact(env.DB, run, "dist", "junk")).outcome).toBe("error");
    expect((await deleteRunArtifact(env.DB, run, "dist", "42")).outcome).toBe("error");
  });

  it("the marked artifact then downloads as missing (the cross-arm guard)", async () => {
    const { runId, latestAttemptId } = await seedRun();
    await seedLegacyFamily(runId, latestAttemptId);
    const run = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)).get())!;
    await deleteRunArtifact(env.DB, run, "dist", "");
    expect(await buildRunArtifactDownload(env, run, "dist", "", null)).toEqual({ outcome: "not-found" });
  });
});

describe("goPathBase (path.Base — the v4 disposition base)", () => {
  it("mirrors Go's path.Base", () => {
    expect(goPathBase("a/b.txt")).toBe("b.txt");
    expect(goPathBase("b.txt")).toBe("b.txt");
    expect(goPathBase("a/b/")).toBe("b");
    expect(goPathBase("/")).toBe("/");
    expect(goPathBase("")).toBe(".");
  });
});
