/**
 * Chunked import channel — D1 state machine (SPEC-0003 §2.6/§3.1).
 *
 * Owns every `repo_imports` transition and the repo-side status flips that
 * bracket an import (`ready → migrating → ready`), all under CAS guards so
 * the single-threaded queue consumer, the API surface and a concurrent abort
 * can never interleave a partial transition:
 *
 *   - create:  one batch = [status flip WHERE ready+empty+unarchived,
 *             INSERT row]; the partial UNIQUE(repo_id WHERE active state)
 *             is the §2.6 "one active import per repo" arbitration point —
 *             the race loser's whole batch rolls back.
 *   - start:   manifest validation + `staged|indexing → indexing` CAS +
 *             one REPO_TASKS message per pending chunk (+ a 24 h sweep).
 *   - checkpoint: consumer-only, `WHERE state='indexing'` — 0 rows changed
 *             means an abort landed mid-chunk and the work is discarded.
 *   - settle:  `finalizing → done` in the same batch that flips the repo
 *             (`is_empty=false`, `default_branch`, `status='ready'`).
 *   - abort:   `staged|indexing|finalizing → failed` + repo back to `ready`
 *             (still empty); the caller purges the R2 chunk prefix.
 *
 * CHECKPOINT LOCATION (the SPEC §2.6 "DO is authoritative" note): the engine
 * exposes no importCheckpoint/importFinalize RPCs today (verified against
 * packages/git-engine dist-types), so the D1 row IS the authoritative
 * checkpoint store and the SPEC's "D1 mirrors DO for observability"
 * relationship is inverted for now. The queue's max_concurrency=1 +
 * max_batch_size=1 (wrangler.jsonc) provides the serialization the DO lease
 * would; the engine-gap consequences are cataloged in pipeline.ts.
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { repoImports, repositories } from "../../db/schema";

/** SPEC §2.6 limits (sized to keep DO catalog volume inside DO storage, T6). */
export const MAX_CHUNKS = 200;
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1024 * 1024;
export const MAX_REFS = 10_000;
/** Chunk cap: the engine's push quota with `MAX_PUSH_MB` unset
 * (packages/git-engine mod.ts DEFAULT_MAX_PUSH_MB — a chunk IS a push from
 * the engine's perspective). The Worker carries no MAX_PUSH_MB var today
 * (wrangler.jsonc); if one is added, this constant moves to an env read. */
export const CHUNK_SIZE_CAP_BYTES = 512 * 1024 * 1024;
/** A well-formed pack is ≥ 32 bytes (12-byte header + 20-byte trailer). */
export const MIN_CHUNK_BYTES = 32;
/** Heartbeat silence after which the sweep abandons an import (§2.6 step 5). */
export const HEARTBEAT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Requeue delay for a chunk whose connectivity failed purely on ORDER
 * (queue batches are at-least-once and may deliver out of order; an
 * out-of-order chunk's parents live in an earlier chunk that has not landed
 * yet). Bounded by the attempts counter in the manifest entry. */
export const CHUNK_REORDER_DELAY_SECONDS = 30;
export const MAX_CHUNK_ATTEMPTS = 10;

/** Minimum pack size the engine accepts (mod.ts stagePack: "pack too small"). */
export const RECEIVE_PACK_FLOOR_BYTES = 32;

// ---------------------------------------------------------------------------
// Manifest (the start-time contract; validated here, carried in D1 JSON)
// ---------------------------------------------------------------------------

export interface ImportManifestChunk {
  /** Chunk index, 0-based and contiguous across the array. */
  n: number;
  /** Declared pack size in bytes. */
  bytes: number;
  /** Pack trailer SHA-1 (hex) — what `git pack-objects` names the pack. */
  sha1: string;
  /** A 40-hex oid guaranteed to be IN this pack (the window's tip commit).
   *  The consumer creates `refs/import/<id>/chunk-<n>` at it, which makes the
   *  engine's own connectivity machinery the per-chunk verdict: the create
   *  only commits when the pack's anti-check passed AND the tip is indexed
   *  (control-plane.ts finalizeReceive store.has guard). */
  tip: string;
  /** Consumer checkpoint — present once the chunk has been attempted. */
  status?: "pending" | "done" | "failed";
  error?: string;
  attempts?: number;
}

export interface ImportManifest {
  /** Default branch adopted at settle (bare branch name, e.g. "main"). */
  head: string;
  /** Ref → 40-hex oid map (≤ MAX_REFS) — all created in ONE multi-ref CAS. */
  refs: Record<string, string>;
  chunks: ImportManifestChunk[];
  totalBytes: number;
}

/** Upload-time staged record (pre-manifest), one per relay PUT. */
export interface StagedChunk {
  bytes: number;
  sha1: string;
}

export type ImportRow = typeof repoImports.$inferSelect;

/** Where the R2 chunk objects live (SPEC §3.2; purge walks the storage-key
 *  prefix, so this nests under it). */
export function importChunkR2Key(storageKey: string, importId: number, chunk: number): string {
  return `imports/${storageKey}/${importId}/chunk-${String(chunk).padStart(4, "0")}.pack`;
}

/** The consumer's temporary per-chunk ref (deleted at finalize/abort). Under
 *  refs/import/ like upstream's own import namespace; validRefName-clean. */
export function chunkTempRef(importId: number, chunk: number): string {
  return `refs/import/${importId}/chunk-${chunk}`;
}

export function isImportToken(value: string): boolean {
  return /^imp_[0-9a-f]{40}$/.test(value);
}

/** sha256 hex of a token value — the only form ever stored (§3.1). */
export async function hashImportToken(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `imp_` + 160 bits of entropy, URL-safe (§3.1 "random, URL-safe"). */
function mintImportToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `imp_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// Errors (API layers map them)
// ---------------------------------------------------------------------------

export class ImportConflictError extends Error {
  constructor(messageText: string) {
    super(messageText);
    this.name = "ImportConflictError";
  }
}

export class ImportNotFoundError extends Error {
  constructor(public readonly importId: number) {
    super(`import not found: ${importId}`);
    this.name = "ImportNotFoundError";
  }
}

export class ManifestInvalidError extends Error {
  constructor(messageText: string) {
    super(messageText);
    this.name = "ManifestInvalidError";
  }
}

/** The `state='indexing'` CAS lost — an abort (or terminal transition) landed
 *  mid-operation. The consumer treats this as "discard work, ack". */
export class ImportStateLostError extends Error {
  constructor() {
    super("import state changed concurrently (aborted or settled)");
    this.name = "ImportStateLostError";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const OID_RE = /^[0-9a-f]{40}$/;
const BRANCH_RE = /^[^\s~^:?*[\\]+$/;

/**
 * Validate the start-time manifest (§2.6 "validates the manifest: chunk list,
 * sizes, ref → oid map, declared head"). Throws ManifestInvalidError with an
 * upstream-style message on the first violation. Semantic checks only — the
 * JSON shape is the route layer's zod schema; limits are enforced here
 * because they are contract, not parsing.
 */
export function validateManifest(
  manifest: unknown,
  chunkCap: number,
  staged: Record<string, StagedChunk>,
): ImportManifest {
  if (typeof manifest !== "object" || manifest === null) {
    throw new ManifestInvalidError("manifest must be a JSON object");
  }
  const m = manifest as Record<string, unknown>;

  const head = m.head;
  if (typeof head !== "string" || head.length === 0 || !BRANCH_RE.test(head) || head.startsWith("/") || head.endsWith("/")) {
    throw new ManifestInvalidError("manifest.head must be a bare branch name");
  }

  const refs = m.refs;
  if (typeof refs !== "object" || refs === null || Array.isArray(refs)) {
    throw new ManifestInvalidError("manifest.refs must be an object of ref → oid");
  }
  const refEntries = Object.entries(refs as Record<string, unknown>);
  if (refEntries.length === 0) throw new ManifestInvalidError("manifest.refs must not be empty");
  if (refEntries.length > MAX_REFS) {
    throw new ManifestInvalidError(`manifest.refs exceeds the ${MAX_REFS} ref cap`);
  }
  const refMap: Record<string, string> = {};
  for (const [name, oid] of refEntries) {
    if (typeof name !== "string" || !name.startsWith("refs/") || name.includes("..") || name.endsWith(".lock") || name.endsWith("/")) {
      throw new ManifestInvalidError(`invalid ref name in manifest.refs: ${name}`);
    }
    if (typeof oid !== "string" || !OID_RE.test(oid)) {
      throw new ManifestInvalidError(`invalid oid for ref ${name}`);
    }
    refMap[name] = oid;
  }
  if (refMap[`refs/heads/${head}`] === undefined) {
    throw new ManifestInvalidError(`manifest.head must name a branch declared in manifest.refs: ${head}`);
  }

  const rawChunks = m.chunks;
  if (!Array.isArray(rawChunks) || rawChunks.length === 0) {
    throw new ManifestInvalidError("manifest.chunks must be a non-empty array");
  }
  if (rawChunks.length > MAX_CHUNKS) {
    throw new ManifestInvalidError(`manifest.chunks exceeds the ${MAX_CHUNKS} chunk cap`);
  }
  let totalBytes = 0;
  const chunks: ImportManifestChunk[] = rawChunks.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new ManifestInvalidError(`manifest.chunks[${index}] must be an object`);
    }
    const c = raw as Record<string, unknown>;
    if (c.n !== index) {
      throw new ManifestInvalidError(`manifest.chunks must be contiguous and ordered: entry ${index} declares n=${String(c.n)}`);
    }
    if (typeof c.bytes !== "number" || !Number.isInteger(c.bytes) || c.bytes < RECEIVE_PACK_FLOOR_BYTES) {
      throw new ManifestInvalidError(`chunk ${index}: bytes must be an integer ≥ ${RECEIVE_PACK_FLOOR_BYTES}`);
    }
    if (c.bytes > chunkCap) {
      throw new ManifestInvalidError(`chunk ${index} exceeds the chunk size cap (${c.bytes} > ${chunkCap})`);
    }
    if (typeof c.sha1 !== "string" || !OID_RE.test(c.sha1)) {
      throw new ManifestInvalidError(`chunk ${index}: sha1 must be a 40-hex pack digest`);
    }
    if (typeof c.tip !== "string" || !OID_RE.test(c.tip)) {
      throw new ManifestInvalidError(`chunk ${index}: tip must be a 40-hex oid carried by the chunk`);
    }
    totalBytes += c.bytes;
    return { n: index, bytes: c.bytes, sha1: c.sha1, tip: c.tip, status: "pending" as const };
  });
  if (totalBytes > MAX_IMPORT_BYTES) {
    throw new ManifestInvalidError(`import exceeds the ${MAX_IMPORT_BYTES} byte cap`);
  }

  // Cross-checks against what the relay actually recorded: every manifest
  // chunk must have been uploaded, with the declared size and digest.
  for (const chunk of chunks) {
    const put = staged[String(chunk.n)];
    if (put === undefined) {
      throw new ManifestInvalidError(`chunk ${chunk.n} has not been uploaded`);
    }
    if (put.bytes !== chunk.bytes) {
      throw new ManifestInvalidError(
        `chunk ${chunk.n} size mismatch: manifest declares ${chunk.bytes}, uploaded ${put.bytes}`,
      );
    }
    if (put.sha1 !== chunk.sha1) {
      throw new ManifestInvalidError(
        `chunk ${chunk.n} digest mismatch: manifest declares ${chunk.sha1}, upload carried ${put.sha1}`,
      );
    }
  }

  const declaredTotal = m.totalBytes;
  if (declaredTotal !== undefined && (typeof declaredTotal !== "number" || declaredTotal !== totalBytes)) {
    throw new ManifestInvalidError(`manifest.totalBytes must equal the chunk sum (${totalBytes})`);
  }

  return { head, refs: refMap, chunks, totalBytes };
}

// ---------------------------------------------------------------------------
// Queue producer seam (mirrors RepoEngineDeps: tests run without a queue)
// ---------------------------------------------------------------------------

/** REPO_TASKS producer narrowed to the import message family. */
export interface ImportQueueProducer {
  send(message: Record<string, unknown>, options?: { delaySeconds?: number }): Promise<unknown>;
}

export interface ImportMessage {
  kind: "import-chunk" | "import-abort" | "import-sweep";
  importId: number;
  repoId: string;
  /** import-chunk only. */
  chunk?: number;
}

export function isImportMessage(value: unknown): value is ImportMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.kind === "import-chunk" || v.kind === "import-abort" || v.kind === "import-sweep") &&
    typeof v.importId === "number" &&
    typeof v.repoId === "string"
  );
}

/** Parse a manifest row payload; a corrupt blob surfaces as invalid (the
 *  import can only fail). */
export function parseManifestRow(row: ImportRow): ImportManifest {
  if (row.manifest === null) throw new ManifestInvalidError(`import ${row.id} has no manifest (never started)`);
  try {
    const parsed = JSON.parse(row.manifest) as ImportManifest;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.chunks)) {
      throw new Error("bad shape");
    }
    return parsed;
  } catch (error) {
    throw new ManifestInvalidError(
      `import ${row.id} manifest is corrupt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseStagedRow(row: ImportRow): Record<string, StagedChunk> {
  if (row.staged === null) return {};
  try {
    const parsed = JSON.parse(row.staged) as Record<string, StagedChunk>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface ImportServiceDeps {
  /** REPO_TASKS producer — chunk/abort/sweep fan-out. Optional so the pure
   *  state-machine tests (and the purge consumer's direct drives) run bare. */
  queue?: ImportQueueProducer;
}

export class ImportService {
  private readonly db: DrizzleD1Database;

  constructor(
    private readonly d1: D1Database,
    private readonly deps: ImportServiceDeps = {},
  ) {
    this.db = drizzle(d1);
  }

  async get(importId: number): Promise<ImportRow | null> {
    const row = await this.db.select().from(repoImports).where(eq(repoImports.id, importId)).get();
    return row ?? null;
  }

  async getByTokenHash(tokenSha256: string): Promise<ImportRow | null> {
    const row = await this.db
      .select()
      .from(repoImports)
      .where(eq(repoImports.importTokenSha256, tokenSha256))
      .get();
    return row ?? null;
  }

  /** The active (non-terminal) import for a repo, if any (§2.6: one at most —
   *  enforced by the partial unique index; this read powers the 409s). */
  async getActiveForRepo(repoId: string): Promise<ImportRow | null> {
    const row = await this.db
      .select()
      .from(repoImports)
      .where(
        and(
          eq(repoImports.repoId, repoId),
          inArray(repoImports.state, ["staged", "indexing", "finalizing"]),
        ),
      )
      .get();
    return row ?? null;
  }

  /**
   * §2.6 POST — create the import row and flip the repo to `status='migrating'`
   * in ONE batch. Guards are in the UPDATE's WHERE clause (empty, unarchived,
   * ready): a lost guard leaves the batch's INSERT unexecuted (D1 batches are
   * transactions — a failed statement rolls the pair back) and surfaces as a
   * conflict. The partial unique index is the second arbitration: a racing
   * create for the same repo loses on the INSERT and rolls back its status
   * flip. Returns the row and the ONE-TIME plaintext import token.
   */
  async create(
    repoId: string,
  ): Promise<{ row: ImportRow; importToken: string; chunkCap: number }> {
    const token = mintImportToken();
    const tokenSha = await hashImportToken(token);
    let changed: number;
    try {
      const results = await this.db.batch([
        this.db
          .update(repositories)
          .set({ status: "migrating", updatedAt: new Date() })
          .where(
            and(
              eq(repositories.id, repoId),
              eq(repositories.isEmpty, true),
              eq(repositories.isArchived, false),
              eq(repositories.status, "ready"),
            ),
          ),
        this.db.insert(repoImports).values({
          repoId,
          importTokenSha256: tokenSha,
          state: "staged",
          chunkCap: CHUNK_SIZE_CAP_BYTES,
          totalBytes: 0,
          staged: "{}",
          heartbeatAt: new Date(),
        }),
      ]);
      changed = results[0]?.meta.changes ?? 0;
    } catch {
      // The partial unique index rejected a second active import — the same
      // 409 the status guard produces, just via the other arbitration point.
      throw new ImportConflictError("repository already has an active import");
    }
    if (changed === 0) {
      throw new ImportConflictError(
        "repository is not importable: it must exist, be empty, unarchived and ready",
      );
    }
    const row = await this.getByTokenHash(tokenSha);
    if (row === null) throw new ImportNotFoundError(-1);
    return { row, importToken: token, chunkCap: row.chunkCap };
  }

  /**
   * §2.6 start — validate + CAS `staged|indexing → indexing` + fan out one
   * REPO_TASKS message per pending chunk (a resume after failure re-enqueues
   * only the missing/failed set). The manifest JSON is validated against the
   * staged-upload record BEFORE the CAS, so a rejected start costs no state.
   * Returns the pending chunk indexes (what was enqueued).
   */
  async start(
    importId: number,
    manifest: unknown,
  ): Promise<{ row: ImportRow; parsed: ImportManifest; pending: number[] }> {
    const row = await this.get(importId);
    if (row === null) throw new ImportNotFoundError(importId);
    if (row.state !== "staged" && row.state !== "indexing") {
      throw new ImportConflictError(`import is ${row.state}; start requires staged or indexing`);
    }
    const staged = parseStagedRow(row);
    const parsed = validateManifest(manifest, row.chunkCap, staged);

    // A resume must not wipe checkpoints: re-validation rebuilds the chunk
    // entries fresh, so carry over the previous manifest's per-chunk state
    // (status/attempts/error) for indexes that already have one.
    const previous = row.manifest === null ? null : parseManifestRow(row).chunks;
    for (const chunk of parsed.chunks) {
      const before = previous?.[chunk.n];
      if (before !== undefined) {
        chunk.status = before.status;
        chunk.attempts = before.attempts;
        chunk.error = before.error;
      }
    }

    // A failed chunk retries with its checkpoint reset; 'done' chunks never
    // re-run (§2.6: "retries only the missing/failed chunk set").
    const pending: number[] = [];
    for (const chunk of parsed.chunks) {
      if (chunk.status !== "done") pending.push(chunk.n);
    }

    const updated = await this.db
      .update(repoImports)
      .set({
        state: "indexing",
        manifest: JSON.stringify(parsed),
        totalBytes: parsed.totalBytes,
        error: null,
        heartbeatAt: new Date(),
      })
      .where(
        and(
          eq(repoImports.id, importId),
          inArray(repoImports.state, ["staged", "indexing"]),
        ),
      )
      .returning({ id: repoImports.id })
      .all();
    if (updated.length === 0) {
      throw new ImportConflictError(`import is no longer startable (state moved concurrently)`);
    }

    await this.enqueueChunkWork(row.repoId, importId, parsed, pending);
    if (pending.length > 0) {
      await this.scheduleSweep(row.repoId, importId);
    }
    const fresh = await this.get(importId);
    if (fresh === null) throw new ImportNotFoundError(importId);
    return { row: fresh, parsed, pending };
  }

  /** One REPO_TASKS message per pending chunk. A lost enqueue strands the
   *  chunk until the next start (the sweep eventually fails the import) —
   *  logged, never thrown into the API response (§2.5.5 notice pattern). */
  private async enqueueChunkWork(
    repoId: string,
    importId: number,
    manifest: ImportManifest,
    pending: number[],
  ): Promise<void> {
    if (this.deps.queue === undefined || pending.length === 0) return;
    for (const n of pending) {
      if (manifest.chunks[n] === undefined) continue;
      try {
        await this.deps.queue.send({ kind: "import-chunk", importId, repoId, chunk: n });
      } catch (error) {
        console.error(`[imports] chunk ${n} enqueue failed: ${errorMessage(error)}`);
      }
    }
  }

  private async scheduleSweep(repoId: string, importId: number): Promise<void> {
    if (this.deps.queue === undefined) return;
    try {
      await this.deps.queue.send(
        { kind: "import-sweep", importId, repoId },
        // one heartbeat-timeout check per import, 24 h out (§2.6 step 5); a
        // finished import makes it a no-op
        { delaySeconds: Math.ceil(HEARTBEAT_TIMEOUT_MS / 1000) },
      );
    } catch (error) {
      console.error(`[imports] sweep enqueue failed for import ${importId}: ${errorMessage(error)}`);
    }
  }

  /** Record a relay PUT (pre-manifest). CAS on the active states: a PUT that
   *  races an abort is a no-op (its bytes are purged with the prefix). */
  async recordStagedChunk(
    importId: number,
    chunk: number,
    stagedChunk: StagedChunk,
  ): Promise<ImportRow> {
    const row = await this.get(importId);
    if (row === null) throw new ImportNotFoundError(importId);
    const staged = parseStagedRow(row);
    staged[String(chunk)] = stagedChunk;
    const updated = await this.db
      .update(repoImports)
      .set({ staged: JSON.stringify(staged), heartbeatAt: new Date() })
      .where(and(eq(repoImports.id, importId), inArray(repoImports.state, ["staged", "indexing"])))
      .returning({ id: repoImports.id })
      .all();
    if (updated.length === 0) {
      throw new ImportConflictError(`import is ${row.state}; chunk uploads require staged or indexing`);
    }
    const fresh = await this.get(importId);
    if (fresh === null) throw new ImportNotFoundError(importId);
    return fresh;
  }

  /** Heartbeat + one chunk checkpoint (consumer-only). `WHERE state='indexing'`
   *  is the abort race guard: 0 rows changed ⇒ the import was aborted/settled
   *  mid-chunk and this work must be discarded. */
  async checkpointChunk(importId: number, chunk: number, patch: Partial<ImportManifestChunk>): Promise<void> {
    const row = await this.get(importId);
    if (row === null) throw new ImportNotFoundError(importId);
    const manifest = parseManifestRow(row);
    const entry = manifest.chunks[chunk];
    if (entry === undefined) throw new ManifestInvalidError(`manifest has no chunk ${chunk}`);
    Object.assign(entry, patch);
    const updated = await this.db
      .update(repoImports)
      .set({ manifest: JSON.stringify(manifest), heartbeatAt: new Date() })
      .where(and(eq(repoImports.id, importId), eq(repoImports.state, "indexing")))
      .returning({ id: repoImports.id })
      .all();
    if (updated.length === 0) throw new ImportStateLostError();
  }

  /** Terminal failure (§2.6 step 4): state='failed' + reason; the repo goes
   *  back to `ready` (still empty — receives must work again for the
   *  fallback script, and a retry start re-flips to migrating). Idempotent. */
  async markFailed(importId: number, errorText: string): Promise<void> {
    const row = await this.get(importId);
    if (row === null || row.state === "done" || row.state === "failed") return;
    await this.db.batch([
      this.db
        .update(repoImports)
        .set({ state: "failed", error: errorText.slice(0, 2000), heartbeatAt: new Date() })
        .where(
          and(
            eq(repoImports.id, importId),
            inArray(repoImports.state, ["staged", "indexing", "finalizing"]),
          ),
        ),
      this.db
        .update(repositories)
        .set({ status: "ready", updatedAt: new Date() })
        .where(and(eq(repositories.id, row.repoId), eq(repositories.status, "migrating"))),
    ]);
  }

  /**
   * §2.6 step 3 settle — `finalizing → done` in the same batch that flips the
   * repo row (`is_empty=false`, `default_branch=manifest.head`,
   * `status='ready'`). Both sides are CAS-guarded so a redelivery is a no-op.
   */
  async settleDone(importId: number, headBranch: string): Promise<void> {
    const row = await this.get(importId);
    if (row === null || row.state === "done") return;
    await this.db.batch([
      this.db
        .update(repoImports)
        .set({ state: "done", error: null, heartbeatAt: new Date() })
        .where(and(eq(repoImports.id, importId), eq(repoImports.state, "finalizing"))),
      this.db
        .update(repositories)
        .set({ isEmpty: false, defaultBranch: headBranch, status: "ready", updatedAt: new Date() })
        .where(and(eq(repositories.id, row.repoId), eq(repositories.status, "migrating"))),
    ]);
  }

  /** `indexing → finalizing` CAS for the finalize hand-off. False when the
   *  state moved (aborted/settled/already finalizing — callers re-read). */
  async beginFinalizing(importId: number): Promise<boolean> {
    const updated = await this.db
      .update(repoImports)
      .set({ state: "finalizing", heartbeatAt: new Date() })
      .where(and(eq(repoImports.id, importId), eq(repoImports.state, "indexing")))
      .returning({ id: repoImports.id })
      .all();
    return updated.length > 0;
  }

  /**
   * §2.6 abort — CAS `staged|indexing|finalizing → failed('aborted')` + repo
   * back to `ready` (still empty) in one batch; the caller purges the R2
   * prefix. False (409) for terminal states.
   */
  async abort(importId: number): Promise<ImportRow | null> {
    const row = await this.get(importId);
    if (row === null) throw new ImportNotFoundError(importId);
    if (row.state === "done" || row.state === "failed") return null;
    await this.db.batch([
      this.db
        .update(repoImports)
        .set({ state: "failed", error: "aborted", heartbeatAt: new Date() })
        .where(
          and(
            eq(repoImports.id, importId),
            inArray(repoImports.state, ["staged", "indexing", "finalizing"]),
          ),
        ),
      this.db
        .update(repositories)
        .set({ status: "ready", updatedAt: new Date() })
        .where(and(eq(repositories.id, row.repoId), eq(repositories.status, "migrating"))),
    ]);
    return (await this.get(importId)) ?? row;
  }

  /**
   * §2.6 step 5 heartbeat sweep — abandon an import whose consumer went
   * silent for 24 h. Returns true when this call performed the abandon.
   */
  async sweepIfStale(importId: number, now = Date.now()): Promise<boolean> {
    const row = await this.get(importId);
    if (row === null) return false;
    if (row.state !== "staged" && row.state !== "indexing") return false;
    const last = row.heartbeatAt?.getTime() ?? row.createdAt.getTime();
    if (now - last < HEARTBEAT_TIMEOUT_MS) return false;
    await this.markFailed(importId, "heartbeat timeout");
    return true;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
