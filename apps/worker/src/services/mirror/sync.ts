/**
 * Pull-mirror sync orchestrator (SPEC-0009 §2.6 "Pull-mirror sync", milestone
 * M3) — the thin composition the outbound client (gitclient.ts) exists for.
 * One queue message = one sync; the initial population is always the import
 * flow (SPEC-0009 §2.6), whose machinery this module deliberately reuses: a
 * fetch window IS a receive, and a delta sync is just the smallest window.
 *
 * Flow (SPEC-0009 §2.6 steps 1-5):
 *
 *   1. load the mirror row + repo (row missing → done — a delete raced it);
 *      CAS `sync_state → 'syncing'` (re-guard over the enqueue guard: the
 *      mirror-sync API can race the cron producer); re-run the egress gate on
 *      the STORED URL (upstream re-validates every sync, mirror_pull.go
 *      :113-121).
 *   2. `fetchRefs` → diff vs the local tips (`planMirrorSync`) → commands:
 *      force-updates carry `old = current tip` (the `+` refspec), deletes
 *      only when `enable_prune`. No missing tips → prune-only sync, no fetch
 *      POST at all (§2.6 step 3).
 *   3. `fetchPack(wants = missing tips, haves = local tips)` → sideband-demux
 *      → the pack stream is fed — COMPOSED, never buffered — straight into a
 *      synthetic `git-receive-pack` request for the engine handler, exactly
 *      the import channel's stage-as-receive composition (src/repos/imports/
 *      pipeline.ts; the chunk pipeline there is the same machinery driven by
 *      a user upload instead of this outbound fetch). The engine's
 *      `finalizeReceive` IS the refs CAS: `old === current` per command, so a
 *      concurrent writer surfaces as "fetch first" (§2.6 step 4).
 *   4. settle D1: success → `last_sync_at = now`, `next_sync_at = now +
 *      interval` (0 → unscheduled), `sync_state='idle'`, clear `last_error`;
 *      the first sync that gives the still-empty repo refs also settles the
 *      repositories row (`is_empty=false` + the engine's HEAD branch — the
 *      import channel's settleDone shape); failure → sanitized `last_error`,
 *      `sync_state='idle'`, `next_sync_at` left DUE so the next cron retries
 *      — upstream's retry posture (mirror_pull.go:303-308).
 *
 * SKELETON SCOPE (honest gaps, each with its landing wave):
 *   - `repo_mirrors` and the repositories mirror columns landed with
 *     migration 0010 (the sixth raw-DDL sweep): the pinned §3.1 DDL is now
 *     the `repoMirrors` Drizzle table in src/db/schema.ts, and the row
 *     reads/writes below moved from raw D1 to Drizzle one-for-one. A D1 the
 *     migration has not been applied to yet (e.g. a remote pending
 *     db:migrate:remote) still surfaces as `skipped: "storage-pending"` —
 *     the sync never fakes a sync.
 *   - Webhook notify per ref delta (§2.7) and `setHead` fixup on dangling
 *     HEAD (§4.3.8) are not driven yet; the command list returned in the
 *     result IS the updates delta that wave needs.
 *   - The receive helpers below mirror pipeline.ts's private ones (command
 *     section, prepend, report-status parse, cell warm-up + the no-op
 *     execution-context stub — the R2-bind engine gap pipeline.ts documents).
 *     They collapse into imports from a shared module the moment pipeline.ts
 *     exports them; duplicated here now because this wave's file ownership is
 *     services/mirror/** only.
 *
 * WIRING (the cron + queue half — NOT registered in this wave; wrangler.jsonc
 * and src/index.ts are shared files owned by the orchestrator):
 *
 *   // wrangler.jsonc — queues.producers + consumers, triggers.crons:
 *   { "binding": "MIRROR_SYNC_QUEUE", "queue": "mirror-sync" }          // producer
 *   { "queue": "mirror-sync", "max_batch_size": 1, "max_concurrency": 1,
 *     "max_retries": 5 }                                                // consumer
 *   // crons: the 10-minute step form (upstream update_mirrors cadence,
 *   // tasks_basic.go:35) — spelled out here because a literal cron string
 *   // would terminate this comment.
 *
 *   // src/index.ts — default export gains:
 *   import { enqueueDueMirrorSyncs, handleMirrorSync, isMirrorSyncMessage } from "./services/mirror/sync";
 *   async scheduled(_ctrl: ScheduledController, env: Env, _ctx: ExecutionContext) {
 *     await enqueueDueMirrorSyncs(env, {});            // producer: SELECT due → CAS queued → sendBatch
 *   },
 *   // and in queue(...) BEFORE the repo-tasks fallback —
 *   if (batch.queue === "mirror-sync") {
 *     for (const m of batch.messages) {
 *       if (!isMirrorSyncMessage(m.body)) { m.ack(); continue; }
 *       try { await handleMirrorSync(env, { repoId: m.body.repoId }); m.ack(); }
 *       catch (e) { console.error(`[mirror-sync] ${m.id} retrying: ${e}`); m.retry(); }
 *     }
 *     return;
 *   }
 *   // Queue consumers get 15 min wall + the CPU limit per invocation
 *   // (AGENTS.md cron/queue rules) — the sync's fetch timeout bounds each
 *   // transfer inside it.
 */

import { and, eq, inArray, lte, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createDurableGit, type RefsResult } from "@cf-gitea/git-engine";

import { repoMirrors, repositories } from "../../db/schema";
import { authorize } from "../../git-http/authorize";
import { markGateCleared } from "../../git-http/gate";
import { parseHostPolicy, type HostPolicy } from "../../webhooks/ssrf";
import { engineName, type RepoRow } from "../../repos/service";
import {
  checkMirrorSource,
  fetchPack,
  fetchRefs,
  planMirrorSync,
  sanitizeUrl,
  SmartHttpError,
  type Advertisement,
  type FetchImpl,
} from "./gitclient";

const TE = new TextEncoder();
const TD = new TextDecoder();

// ---------------------------------------------------------------------------
// Env slice (structural, consumer.ts pattern) + queue message
// ---------------------------------------------------------------------------

/**
 * The bindings/vars a mirror sync touches. The generated `Env` satisfies this
 * structurally; the MIRROR_* vars are optional reads (absent = lax egress, no
 * KEK).
 */
export interface MirrorSyncEnv extends Env {
  /** `MIRROR_ALLOWED_HOST_LIST` (upstream MIGRATIONS_ALLOWED_HOSTS semantics,
   *  §4.1 — same list syntax as WEBHOOK_ALLOWED_HOST_LIST). */
  MIRROR_ALLOWED_HOST_LIST?: string;
  /** `lax` (default) | `strict`. */
  MIRROR_EGRESS_MODE?: string;
  /** AES-256-GCM KEK for `repo_mirrors.credentials_ciphertext` (§4.2,
   *  `wrangler secret put MIRROR_CREDENTIAL_KEY`). */
  MIRROR_CREDENTIAL_KEY?: string;
  /** Sync message queue — the producer side. The binding is live in the
   *  generated Env (required since the wrangler wiring landed); the runtime
   *  guard below stays as fail-closed defense. */
  MIRROR_SYNC_QUEUE: Queue;
}

/** The only thing a producer puts on MIRROR_SYNC_QUEUE (§2.6 scheduling). */
export interface MirrorSyncMessage {
  kind: "mirror-sync";
  repoId: string;
}

export function isMirrorSyncMessage(value: unknown): value is MirrorSyncMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as MirrorSyncMessage).kind === "mirror-sync" &&
    typeof (value as MirrorSyncMessage).repoId === "string"
  );
}

export interface MirrorSyncOptions {
  /** Test seam — NO real network in tests (the gitclient fetchImpl seam). */
  fetchImpl?: FetchImpl;
  /** Test clock for the settle arithmetic. */
  now?: Date;
}

export type MirrorSyncSkip =
  | "missing-row" // repo or mirror row gone (a delete raced the sync, §2.6 step 1)
  | "busy" // sync_state CAS lost — another sync/import owns the repo
  | "storage-pending" // repo_mirrors migration 0010 not applied to this D1
  | "egress-denied" // §4.1 re-check failed — recorded, retried by the cron
  | "no-changes"; // advertisement fully landed; nothing fetched

export interface MirrorSyncResult {
  ok: boolean;
  skipped?: MirrorSyncSkip;
  created?: number;
  updated?: number;
  deleted?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// repo_mirrors — the SPEC-0009 §3.1 DDL, now the Drizzle schema (the sixth
// raw-DDL sweep: migration 0010 landed the table this module's pinned-DDL
// comment used to describe, and the raw reads/writes below swapped to
// Drizzle one-for-one)
// ---------------------------------------------------------------------------

/**
 * The mirror row, as SPEC-0009 §3.1 (upstream Mirror, models/repo/mirror.go:
 * 23-38) landed it: `repoMirrors` in src/db/schema.ts + migration 0010 carry
 * the pinned contract verbatim — `interval_seconds` 28800 default,
 * `enable_prune` true, reserved `lfs_*`, sanitized `remote_address`,
 * AES-256-GCM `credentials_ciphertext`, the `idle|queued|syncing` CHECK,
 * `next_sync_at` 0 = unscheduled and the UNIQUE `repo_id` arbiter. This
 * narrow projection is what a sync reads; every write below is the sync-
 * state CAS (0 rows on a lost race, exactly the raw statements' contract).
 */
interface MirrorRow {
  id: number;
  repoId: string;
  intervalSeconds: number;
  enablePrune: boolean;
  remoteAddress: string;
  credentialsUsername: string | null;
  credentialsCiphertext: string | null;
  syncState: "idle" | "queued" | "syncing";
  nextSyncAt: number;
  lastSyncAt: number | null;
}

async function readMirrorRow(db: D1Database, repoId: string): Promise<MirrorRow | null> {
  const row = await drizzle(db).select().from(repoMirrors).where(eq(repoMirrors.repoId, repoId)).get();
  if (row === undefined) return null;
  return {
    id: row.id,
    repoId: row.repoId,
    intervalSeconds: row.intervalSeconds,
    enablePrune: row.enablePrune,
    remoteAddress: row.remoteAddress,
    credentialsUsername: row.credentialsUsername,
    credentialsCiphertext: row.credentialsCiphertext,
    syncState: row.syncState,
    nextSyncAt: row.nextSyncAt,
    lastSyncAt: row.lastSyncAt,
  };
}

/** §2.6 step 1 — CAS `idle|queued → syncing` (0 rows = someone else owns the
 *  repo). The WHERE guard is the whole lock: a racing sync/import loses here. */
async function claimMirrorRow(db: D1Database, repoId: string): Promise<boolean> {
  const claimed = await drizzle(db)
    .update(repoMirrors)
    .set({ syncState: "syncing", updatedAt: new Date() })
    .where(and(eq(repoMirrors.repoId, repoId), inArray(repoMirrors.syncState, ["idle", "queued"])))
    .returning({ repoId: repoMirrors.repoId })
    .all();
  return claimed.length > 0;
}

/** §2.6 step 5 — success settle (CAS'd on the claim so an abort/delete race
 *  can never resurrect the row state), plus the population settle: a sync
 *  that gave the still-empty repo its first refs flips the repositories row
 *  (the import channel's settleDone shape, imports/service.ts — is_empty +
 *  default_branch; status is NOT written because a mirror repo never leaves
 *  `ready`, unlike an import's `migrating`). Best-effort: the refs are
 *  already in the engine and the next sync's settle re-checks, so a failed
 *  flip here logs and self-heals instead of failing a landed sync. */
async function settleMirrorSuccess(env: MirrorSyncEnv, repo: RepoRow, mirror: MirrorRow, now: number): Promise<void> {
  await drizzle(env.DB)
    .update(repoMirrors)
    .set({
      lastSyncAt: now,
      nextSyncAt: mirror.intervalSeconds > 0 ? now + mirror.intervalSeconds : 0,
      syncState: "idle",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(eq(repoMirrors.repoId, repo.id), eq(repoMirrors.syncState, "syncing")));
  if (!repo.isEmpty) return; // steady state — already populated, nothing to flip
  try {
    await settlePopulatedRepo(env, repo);
  } catch (error) {
    console.error(
      `[mirror-sync] ${repo.ownerNamespace}/${repo.slug}: population settle failed (the next sync re-checks): ${errorText(error)}`,
    );
  }
}

/**
 * The population settle — the empty → populated transition. `listRefs` at
 * settle time is the verdict ("the engine now has refs"), NOT the plan's
 * command list: a source that legitimately advertises zero refs syncs to a
 * still-empty repo and must stay `is_empty` (upstream too keeps an empty
 * mirror empty). The `is_empty = true` guard in the UPDATE is the CAS — a
 * concurrent settle or user push can never be double-applied or overwritten.
 * The default branch is the engine's HEAD (the engine's first-receive
 * adoption set meta.head); when the DO head is unborn or non-branch
 * (tags-only source), it falls back to the alphabetically-first branch
 * (listRefs is name-ordered — the push-create settle's rule) and only
 * flips emptiness when no branch exists at all.
 */
async function settlePopulatedRepo(env: MirrorSyncEnv, repo: RepoRow): Promise<void> {
  const listed = await env.REPO.getByName(engineName(repo.ownerNamespace, repo.slug)).listRefs();
  if (listed.refs.length === 0) return; // a legitimately empty source — stays empty
  const firstBranch = listed.refs.find((r) => r.name.startsWith("refs/heads/"))?.name.slice("refs/heads/".length);
  const branch =
    listed.head !== null && listed.head.startsWith("refs/heads/")
      ? listed.head.slice("refs/heads/".length)
      : (firstBranch ?? null);
  await drizzle(env.DB)
    .update(repositories)
    .set({
      isEmpty: false,
      ...(branch !== null ? { defaultBranch: branch } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(repositories.id, repo.id), eq(repositories.isEmpty, true)));
}

/** §2.6 step 5 — failure settle: `last_error` (sanitized), back to idle,
 *  `next_sync_at` untouched (it stays due — the next cron retries). */
async function settleMirrorFailure(db: D1Database, repoId: string, errorText: string): Promise<void> {
  await drizzle(db)
    .update(repoMirrors)
    .set({ lastError: errorText.slice(0, 2000), syncState: "idle", updatedAt: new Date() })
    .where(and(eq(repoMirrors.repoId, repoId), eq(repoMirrors.syncState, "syncing")));
}

// ---------------------------------------------------------------------------
// Credentials (§4.2) — AES-256-GCM decryption of the stored ciphertext
// ---------------------------------------------------------------------------

/**
 * Decrypt `repo_mirrors.credentials_ciphertext` into the Authorization header
 * value. ENVELOPE CONTRACT (the PATCH/migrate wave that encrypts must adopt
 * this exact format — §4.2: AES-256-GCM keyed by the MIRROR_CREDENTIAL_KEY
 * KEK, AAD binding `(mirror_id, repo_id)` so a ciphertext cannot be moved
 * between rows):
 *
 *   ciphertext = base64( nonce[12] || AES-256-GCM(plaintext) )
 *   plaintext  = the full Authorization header value
 *              = "Basic base64(user:pass)" | "Bearer <token>"   (§2.2)
 */
export async function mirrorAuthHeader(env: MirrorSyncEnv, mirror: MirrorRow): Promise<string | null> {
  if (mirror.credentialsCiphertext === null) return null;
  const kek = env.MIRROR_CREDENTIAL_KEY;
  if (kek === undefined || kek === "") {
    // SPEC §5 credential test: "KEK absent → sync fails cleanly".
    throw new SmartHttpError("mirror credentials are stored but MIRROR_CREDENTIAL_KEY is not configured");
  }
  const raw = base64Decode(mirror.credentialsCiphertext);
  if (raw.length < 12 + 16) throw new SmartHttpError("mirror credential ciphertext is truncated");
  const key = await crypto.subtle.importKey("raw", base64Decode(kek), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: raw.slice(0, 12),
      additionalData: TE.encode(`${mirror.id}:${mirror.repoId}`),
      tagLength: 128,
    },
    key,
    raw.slice(12),
  );
  return TD.decode(plain);
}

function base64Decode(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// The engine handler + the internal receive composition (pipeline.ts shapes)
// ---------------------------------------------------------------------------

/**
 * The engine handler, constructed with the SAME shape as the entrypoint's
 * mount (src/index.ts: authorize + headless + namespaced). A
 * DurableGitHandler is a stateless function bundle over the shared bindings;
 * this second instance exists because src/index.ts does not export its one —
 * when the entrypoint ever exports it, this collapses to an import (same note
 * as the import channel's pipeline.ts).
 */
const engine = createDurableGit<Env>({ authorize, ui: false, namespaces: true });

const ZERO_OID = "0".repeat(40);
const RECEIVE_CT = "application/x-git-receive-pack-request";

/** Command section for a receive: caps ride the first command, like git. */
function commandSection(commands: { old: string; next: string; ref: string }[]): Uint8Array {
  let section = "";
  commands.forEach((cmd, i) => {
    const line = i === 0 ? `${cmd.old} ${cmd.next} ${cmd.ref}\0report-status` : `${cmd.old} ${cmd.next} ${cmd.ref}`;
    section += `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
  });
  section += "0000";
  return TE.encode(section);
}

/** Prefix + stream, read sequentially — the pack is NEVER buffered (AGENTS.md
 *  streaming rule). Unlike the import channel this composite carries NO
 *  content-length: the demuxed pack length is unknown until it lands, which
 *  steers the engine into its chunked multipart staging path (mod.ts
 *  stagePack hint = null → 16 MiB parts). */
function prependStream(prefix: Uint8Array, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let sentPrefix = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentPrefix) {
        sentPrefix = true;
        controller.enqueue(prefix);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Build the gate-cleared internal receive request (the trusted-internal
 *  pattern of the import channel: the consumer has already resolved the D1
 *  repo, run the egress gate and the sync-state CAS). */
function receiveRequest(repo: RepoRow, commands: { old: string; next: string; ref: string }[], packBody: ReadableStream<Uint8Array> | null): Request {
  const section = commandSection(commands);
  const body = packBody === null ? section : prependStream(section, packBody);
  const req = new Request(`https://mirror.internal/${engineName(repo.ownerNamespace, repo.slug)}.git/git-receive-pack`, {
    method: "POST",
    headers: {
      "content-type": RECEIVE_CT,
      "x-storage-key": repo.storageKey,
      ...(packBody === null ? { "content-length": String(section.length) } : {}),
    },
    body,
    ...(packBody === null ? {} : { duplex: "half" as const }),
  });
  markGateCleared(req);
  return req;
}

interface ReportStatus {
  unpackError: string | null;
  results: { ref: string; ok: boolean; message?: string }[];
}

/** Strict 4-hex pkt-line length (the engine's PktParser rules; the import
 *  channel carries the same local copy). */
function hex4(buf: Uint8Array, pos: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const c = buf[pos + i];
    if (c === undefined) throw new SmartHttpError("bad pkt-line length in report-status");
    let d: number;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
    else if (c >= 0x41 && c <= 0x5a) d = c - 0x37;
    else throw new SmartHttpError("bad pkt-line length in report-status");
    n = (n << 4) | d;
  }
  return n;
}

/** Parse the engine's report-status rendering — the receive verdict, i.e. the
 *  per-ref CAS outcome ("fetch first" = a concurrent writer won, §2.6 step 4).
 *  Mirrors pipeline.ts's private parser. */
function parseReportStatus(body: ArrayBuffer): ReportStatus {
  const bytes = new Uint8Array(body);
  const out: ReportStatus = { unpackError: null, results: [] };
  let pos = 0;
  for (;;) {
    if (pos + 4 > bytes.length) break;
    const len = hex4(bytes, pos);
    pos += 4;
    if (len === 0) break; // flush: end of report
    if (len < 4 || pos + len - 4 > bytes.length) throw new SmartHttpError("truncated report-status from the engine receive");
    const line = TD.decode(bytes.subarray(pos, pos + len - 4)).trimEnd();
    pos += len - 4;
    if (line.startsWith("unpack ")) {
      const messageText = line.slice("unpack ".length);
      if (messageText !== "ok") out.unpackError = messageText;
      continue;
    }
    if (line.startsWith("ok ")) {
      out.results.push({ ref: line.slice(3), ok: true });
    } else if (line.startsWith("ng ")) {
      const rest = line.slice(3);
      const sp = rest.indexOf(" ");
      out.results.push(
        sp === -1 ? { ref: rest, ok: false } : { ref: rest.slice(0, sp), ok: false, message: rest.slice(sp + 1) },
      );
    }
  }
  return out;
}

/**
 * Warm the repo cell with its advert (GET info/refs → the DO's fetch path) —
 * pipeline.ts's load-bearing engine-gap workaround: a cell whose FIRST
 * contact is a receive RPC never binds R2 (rpcBind derives from meta.repo,
 * set only by fetch), so a retry receive whose object lookups hit a recorded
 * pack needs the binding. Collapses into a shared import when pipeline.ts
 * exports its helper.
 */
async function warmCell(env: MirrorSyncEnv, repo: RepoRow): Promise<void> {
  const req = new Request(`https://mirror.internal/${engineName(repo.ownerNamespace, repo.slug)}.git/info/refs?service=git-receive-pack`);
  markGateCleared(req);
  await engine.fetch(req, env, NOOP_CTX);
}

/** Run one internal receive against the engine handler and translate the
 *  report-status verdict into errors (the refs CAS lives inside the engine's
 *  finalizeReceive — "fetch first" means a concurrent writer won, §2.6 step 4). */
async function runReceive(
  env: MirrorSyncEnv,
  repo: RepoRow,
  commands: { old: string; next: string; ref: string }[],
  packBody: ReadableStream<Uint8Array> | null,
): Promise<void> {
  await warmCell(env, repo);
  const response = await engine.fetch(receiveRequest(repo, commands, packBody), env, NOOP_CTX);
  const status = parseReportStatus(await response.arrayBuffer());
  if (status.unpackError !== null) {
    throw new SmartHttpError(`receive rejected: unpack ${status.unpackError}`);
  }
  const failed = status.results.filter((r) => !r.ok);
  if (failed.length > 0) {
    const detail = failed.map((r) => `${r.ref}: ${r.message ?? "rejected"}`).join("; ");
    throw new SmartHttpError(`receive rejected: ${detail}`);
  }
}

/**
 * The receive path only awaits its own work (options.onPush is unset on this
 * instance), so the consumer passes a no-op execution context. Duplication of
 * pipeline.ts's NOOP_CTX (module-private there) with the same honest runtime
 * stubs — the platform type requires the full modern surface.
 */
class NoopSpan {
  get isTraced(): boolean {
    return false;
  }
  spanContext(): TracingSpanContext {
    return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };
  }
  setAttribute(_key: string, _value: boolean | number | string): this {
    return this;
  }
  setAttributes(_attributes: Record<string, boolean | number | string | undefined>): this {
    return this;
  }
  recordException(
    _exception: string | { code: string | number; name?: string; message?: string; stack?: string },
  ): void {}
  updateName(_name: string): this {
    return this;
  }
  setStatus(_status: TracingSpanStatus): this {
    return this;
  }
  end(): void {}
}

/** ctx.exports is the runtime-built loopback over the entry module's own
 *  exports — nothing on this path reads it (pipeline.ts's never-hole, same
 *  deliberate assertion in place of fabricating a module namespace). */
const EXPORTS_HOLE = undefined as never;

const NOOP_CTX: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  abort: () => {},
  exports: EXPORTS_HOLE,
  props: undefined,
  tracing: {
    enterSpan: <T, A extends unknown[]>(_name: string, callback: (span: NoopSpan, ...args: A) => T, ...args: A): T =>
      callback(new NoopSpan(), ...args),
    startActiveSpan: <T, A extends unknown[]>(
      _name: string,
      callback: (span: NoopSpan, ...args: A) => T,
      ...args: A
    ): T => callback(new NoopSpan(), ...args),
    startSpan: (_name: string) => new NoopSpan(),
    getActiveSpan: () => undefined,
    Span: NoopSpan,
  },
};

// ---------------------------------------------------------------------------
// handleMirrorSync (§2.6) + the cron producer (§2.6 scheduling)
// ---------------------------------------------------------------------------

function mirrorEgressPolicy(env: MirrorSyncEnv): HostPolicy {
  const mode = env.MIRROR_EGRESS_MODE === "strict" ? "strict" : "lax";
  return parseHostPolicy(env.MIRROR_ALLOWED_HOST_LIST, mode);
}

/**
 * One pull-mirror sync (§2.6). Throwing is the RETRY signal for a queue
 * consumer; every terminal outcome (upstream failure posture, §2.6 step 5)
 * returns a result and leaves the mirror row due for the next cron.
 */
export async function handleMirrorSync(env: MirrorSyncEnv, options: MirrorSyncOptions & { repoId: string }): Promise<MirrorSyncResult> {
  const { repoId, fetchImpl, now: nowOpt } = options;
  const now = nowOpt ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);

  const repo = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (repo === undefined) return { ok: false, skipped: "missing-row" };

  let mirror: MirrorRow | null;
  try {
    mirror = await readMirrorRow(env.DB, repoId);
  } catch (error) {
    // No repo_mirrors table yet (migration 0010 not applied to this D1 —
    // e.g. a remote pending db:migrate:remote). Never fake a sync; report
    // and get out.
    return {
      ok: false,
      skipped: "storage-pending",
      error: `repo_mirrors storage unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (mirror === null) return { ok: false, skipped: "missing-row" };
  if (!(await claimMirrorRow(env.DB, repoId))) return { ok: false, skipped: "busy" };

  const fail = async (errorText: string): Promise<MirrorSyncResult> => {
    await settleMirrorFailure(env.DB, repoId, errorText);
    return { ok: false, error: errorText };
  };

  // §2.6 step 1 — egress re-check of the STORED URL on every sync (§4.1).
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(mirror.remoteAddress);
  } catch {
    return await fail(`stored mirror URL is invalid: ${JSON.stringify(mirror.remoteAddress)}`);
  }
  const policy = mirrorEgressPolicy(env);
  const gate = checkMirrorSource(sourceUrl, policy);
  if (!gate.allowed) return await fail(gate.reason);

  // Credentials decrypt once, in memory, never logged (§4.2). Failure here is
  // a clean sync failure (SPEC §5: KEK absent → sync fails cleanly).
  let authHeader: string | null;
  try {
    authHeader = await mirrorAuthHeader(env, mirror);
  } catch (error) {
    return await fail(errorText(error));
  }

  // §2.6 step 2 — advertise (v2, v0 fallback), diff vs current, plan.
  let advert: Advertisement;
  try {
    advert = await fetchRefs(sourceUrl.toString(), { fetchImpl, policy, authHeader: authHeader ?? undefined });
  } catch (error) {
    return await fail(errorText(error));
  }

  let refs: RefsResult;
  try {
    refs = await env.REPO.getByName(engineName(repo.ownerNamespace, repo.slug)).listRefs();
  } catch (error) {
    return await fail(`local ref listing failed: ${errorText(error)}`);
  }
  const plan = planMirrorSync(advert, refs.refs.map((r) => ({ name: r.name, target: r.target })), { prune: mirror.enablePrune });

  // Commands (§2.6 step 3): creates carry old = ZERO_OID, updates carry
  // old = current tip (force — the `+` refspec), deletes only when prune.
  const commands: { old: string; next: string; ref: string }[] = [];
  for (const create of plan.creates) commands.push({ old: ZERO_OID, next: create.oid, ref: create.ref });
  for (const update of plan.updates) commands.push({ old: update.old, next: update.oid, ref: update.ref });
  for (const del of plan.deletes) commands.push({ old: del.old, next: ZERO_OID, ref: del.ref });

  try {
    if (plan.wants.length === 0) {
      if (commands.length === 0) {
        await settleMirrorSuccess(env, repo, mirror, nowSec);
        return { ok: true, skipped: "no-changes", created: 0, updated: 0, deleted: 0 };
      }
      // Prune-only sync: a refs-only receive (deletes shape — no pack bytes),
      // the same receive the import channel's finalize rides.
      await runReceive(env, repo, commands, null);
    } else {
      // §2.6 step 3-4 — the fetch window: fetch → demux → stage-as-receive.
      // haves = every current local tip (bounded by gitclient.MAX_HAVES in
      // the client); a later window re-derives haves, so deltas stay deltas.
      const haves = refs.refs.map((r) => r.target);
      const fetched = await fetchPack(sourceUrl.toString(), plan.wants, haves, {
        fetchImpl,
        policy,
        advert,
        authHeader: authHeader ?? undefined,
        onProgress: (text) => console.log(`[mirror-sync] ${repo.ownerNamespace}/${repo.slug}: ${text.trimEnd()}`),
      });
      const acked = await fetched.ackedRefs;
      console.log(
        `[mirror-sync] ${repo.ownerNamespace}/${repo.slug}: ${plan.wants.length} want(s), ${acked.length} common oid(s), ` +
          `${commands.length} ref command(s)`,
      );
      await runReceive(env, repo, commands, fetched.packStream);
    }
  } catch (error) {
    return await fail(errorText(error));
  }

  // §2.6 step 5 — success settle. (Notification of the updates delta, §2.7,
  // lands with the webhook wave; `commands` above IS that delta.)
  await settleMirrorSuccess(env, repo, mirror, nowSec);
  return { ok: true, created: plan.creates.length, updated: plan.updates.length, deleted: plan.deletes.length };
}

/**
 * The cron producer (§2.6 scheduling): SELECT due mirrors
 * (`next_sync_at <= now AND next_sync_at != 0 AND sync_state = 'idle'`,
 * oldest-synced first, LIMIT 50 — upstream MirrorsIterate + PullLimit),
 * CAS each row `idle → queued`, then `sendBatch` (≤ 100 per call). Queue
 * redelivery is safe: handleMirrorSync re-checks every state.
 * Returns the number of syncs enqueued.
 */
export async function enqueueDueMirrorSyncs(env: MirrorSyncEnv, options: { now?: Date; limit?: number } = {}): Promise<number> {
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const limit = options.limit ?? 50;
  if (env.MIRROR_SYNC_QUEUE === undefined) {
    throw new SmartHttpError("MIRROR_SYNC_QUEUE is not bound (wrangler.jsonc — SPEC-0009 §3.3); the cron producer cannot enqueue");
  }
  const db = drizzle(env.DB);
  const due = await db
    .select({ repoId: repoMirrors.repoId })
    .from(repoMirrors)
    .where(and(lte(repoMirrors.nextSyncAt, now), ne(repoMirrors.nextSyncAt, 0), eq(repoMirrors.syncState, "idle")))
    .orderBy(sql`coalesce(${repoMirrors.lastSyncAt}, 0)`)
    .limit(limit);

  const messages: MirrorSyncMessage[] = [];
  for (const row of due) {
    // CAS wins the right to enqueue — no double-enqueue under contention.
    const claimed = await db
      .update(repoMirrors)
      .set({ syncState: "queued", updatedAt: new Date() })
      .where(and(eq(repoMirrors.repoId, row.repoId), eq(repoMirrors.syncState, "idle")))
      .returning({ repoId: repoMirrors.repoId })
      .all();
    if (claimed.length > 0) messages.push({ kind: "mirror-sync", repoId: row.repoId });
  }
  for (let i = 0; i < messages.length; i += 100) {
    await env.MIRROR_SYNC_QUEUE.sendBatch(messages.slice(i, i + 100).map((message) => ({ body: message })));
  }
  if (messages.length > 0) {
    console.log(`[mirror-sync] enqueued ${messages.length} sync(es) due at ${now}`);
  }
  return messages.length;
}

function errorText(error: unknown): string {
  if (error instanceof SmartHttpError) return error.message; // already sanitized (gitclient contract)
  return `mirror sync failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** Re-export for the future mirror-settings routes (the sanitizer's single
 *  source is gitclient). */
export { sanitizeUrl };
export type { MirrorRow };
