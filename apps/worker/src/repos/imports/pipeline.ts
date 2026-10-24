/**
 * Chunked import channel — the REPO_TASKS consumer side (SPEC-0003 §2.6
 * indexing pipeline). Owns three message kinds (see service.ts ImportMessage):
 *
 *   import-chunk  — index one uploaded chunk, then checkpoint D1; when the
 *                   last chunk lands, hand off to the finalize below.
 *   import-abort  — post-CAS cleanup: delete the import's temporary refs and
 *                   purge its R2 chunk prefix (queue-retried, so a chunk
 *                   receive holding the engine lease cannot block an abort).
 *   import-sweep  — heartbeat-timeout abandonment (§2.6 step 5).
 *
 * ARCHITECTURE CALL — chunk indexing is STAGE-AS-RECEIVE. A chunk IS a
 * push-equivalent (SPEC: "chunk ≤ 1 GiB — a chunk *is* a push from the
 * engine's perspective"), so instead of re-implementing the Worker-side scan
 * (walkPack/DeltaResolver/writeIdx are not exported through the vendored
 * engine's package boundary, and AGENTS.md forbids editing the engine), the
 * consumer synthesizes a `git-receive-pack` request and drives the engine's
 * own Worker-side receive flow (packages/git-engine mod.ts receivePack) in
 * process:
 *
 *   commands = [create refs/import/<importId>/chunk-<n> at the chunk's
 *              manifest tip]   (+ [delete stale temp ref] on resume)
 *   body     = command section + the R2 chunk object, streamed, never
 *              buffered
 *
 * The engine then verifies the pack trailer while staging (stagePack), runs
 * the two-pass scan + delta resolution + idx v2 write, copies the pack into
 * `repos/<storage_key>/packs/`, and — critically — makes its OWN connectivity
 * verdict the per-command outcome: finalizeReceive's validatePush rejects the
 * temp-ref create with ng "missing necessary objects" unless the pack's
 * anti-check passed and the tip is in the object index (control-plane.ts).
 * The report-status response is therefore the chunk verdict, and the temp ref
 * doubles as a durable progress marker. Temp refs point only at fully
 * connected tips and are deleted before the import's real refs land; the
 * engine has no non-receive ref-write RPC (no importFinalize /
 * commitApiChange equivalent), so both the per-chunk markers and the final
 * multi-ref commit ride receive leases — the documented engine gap for the
 * next wave (together with the pack_catalog 'staged→active' distinction the
 * SPEC sketches: here packs become active exactly when their chunk's temp ref
 * commits, and the catalog never carries a staged state).
 *
 * FINALIZE is one refs-only receive (command section, NO pack — the
 * deletes-only shape the engine already supports): all manifest refs as
 * zero-id creates in ONE finalizeReceive transaction (multi-ref CAS +
 * refs_version bump — the same atomic finalize shape as a push), plus the
 * temp-ref deletes. The engine's per-command `store.has(tip)` guard is the
 * finalize connectivity gate; deep reachability was already enforced per
 * chunk by each scan's anti-check. `setHead` (manifest.head) and the D1
 * settle (is_empty=false, default_branch, status='ready', state='done')
 * follow, in that order, mirroring the §2.5.2 engine-then-D1 handshake.
 *
 * Everything is idempotent under queue redelivery: chunk receives detect
 * their own committed temp refs via listRefs before re-running; finalize is
 * skipped when listRefs already shows every manifest ref at its tip; abort
 * cleanup deletes only what is still present; D1 transitions are CAS'd.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createDurableGit, type RefsResult } from "@cf-gitea/git-engine";

import { authorize } from "../../git-http/authorize";
import { markGateCleared } from "../../git-http/gate";
import { repositories } from "../../db/schema";
import type { RepoRow } from "../service";
import {
  CHUNK_REORDER_DELAY_SECONDS,
  ImportService,
  MAX_CHUNK_ATTEMPTS,
  chunkTempRef,
  importChunkR2Key,
  isImportMessage,
  parseManifestRow,
  type ImportManifest,
  type ImportMessage,
  type ImportRow,
} from "./service";

/** The combined engine name (namespaced mode) — mirrors src/repos/service.ts. */
function engineRepoName(repo: RepoRow): string {
  return `${repo.ownerNamespace}/${repo.slug}`;
}

/**
 * The engine handler, constructed once per isolate with the SAME shape as the
 * entrypoint's mount (src/index.ts: authorize + headless + namespaced). A
 * DurableGitHandler is a stateless function bundle over the shared bindings;
 * this second instance exists because src/index.ts does not export its one —
 * when the entrypoint ever exports it, this collapses to an import.
 */
const engine = createDurableGit<Env>({ authorize, ui: false, namespaces: true });

/** The receive path only awaits its own work (options.onPush is unset on this
 *  instance), so the consumer passes a no-op execution context instead of
 *  fabricating queue-message bookkeeping. The platform type requires the full
 *  modern surface (exports/props/tracing), so each unused member gets an
 *  honest runtime stub — no casts; nothing on the receive path reads them. */
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
 *  exports (its type names the real DO classes) — nothing on this path reads
 *  it, so the field is an explicit never-hole: the module's one deliberate
 *  assertion, in place of fabricating a fake module namespace. */
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

const ZERO_OID = "0".repeat(40);
const RECEIVE_CT = "application/x-git-receive-pack-request";

// ---------------------------------------------------------------------------
// Wire helpers (pkt-line command sections, streamed composite bodies,
// report-status parsing) — the exact shapes the engine's parsePushCommands /
// renderStatus produce and consume.
// ---------------------------------------------------------------------------

function pktLine(payload: string): string {
  return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
}

/** Command section for a receive: caps ride the first command, like git. */
function commandSection(commands: { old: string; next: string; ref: string }[], caps: string[]): Uint8Array {
  let section = "";
  commands.forEach((cmd, i) => {
    const line = i === 0 && caps.length > 0 ? `${cmd.old} ${cmd.next} ${cmd.ref}\0${caps.join(" ")}` : `${cmd.old} ${cmd.next} ${cmd.ref}`;
    section += pktLine(line);
  });
  section += "0000";
  return new TextEncoder().encode(section);
}

/** Prefix + stream, read sequentially — the pack is NEVER buffered
 *  (AGENTS.md streaming rule); the engine's known-length staging path needs
 *  the composite to yield exactly prefix.length + bodySize bytes. */
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

/** Build the gate-cleared internal receive request (the same trusted-internal
 *  pattern as the push-create DO warm-up: the consumer has already resolved
 *  the D1 repo and enforced the import state machine). */
function receiveRequest(
  repo: RepoRow,
  commands: { old: string; next: string; ref: string }[],
  packBody: ReadableStream<Uint8Array> | null,
  packBytes: number,
): Request {
  const section = commandSection(commands, ["report-status"]);
  const url = `https://import.internal/${repo.ownerNamespace}/${repo.slug}.git/git-receive-pack`;
  const body = packBody === null ? section : prependStream(section, packBody);
  const req = new Request(url, {
    method: "POST",
    headers: {
      "content-type": RECEIVE_CT,
      "content-length": String(section.length + packBytes),
      "x-storage-key": repo.storageKey,
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

/** Strict 4-hex pkt-line length (the engine's PktParser rules). */
function hex4(buf: Uint8Array, pos: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const c = buf[pos + i];
    if (c === undefined) throw new Error("bad pkt-line length in report-status");
    let d: number;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x57;
    else if (c >= 0x41 && c <= 0x5a) d = c - 0x37;
    else throw new Error("bad pkt-line length in report-status");
    n = (n << 4) | d;
  }
  return n;
}

/** Parse the engine's report-status rendering (pkt-line framed: "unpack ok",
 *  ok/ng lines, flush). An empty body means the report-status capability was
 *  not honored — a protocol violation for our internal receives. */
function parseReportStatus(body: ArrayBuffer): ReportStatus {
  const bytes = new Uint8Array(body);
  const out: ReportStatus = { unpackError: null, results: [] };
  let pos = 0;
  for (;;) {
    if (pos + 4 > bytes.length) break;
    const len = hex4(bytes, pos);
    pos += 4;
    if (len === 0) break; // flush: end of report
    if (len < 4 || pos + len - 4 > bytes.length) {
      throw new Error("truncated report-status from the engine receive");
    }
    // renderStatus payloads carry a trailing newline (pkt("unpack ok\n")) —
    // strip it so the "ok"/"unpack ok" comparisons hold.
    const line = new TextDecoder().decode(bytes.subarray(pos, pos + len - 4)).trimEnd();
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

async function listRefs(env: Env, repo: RepoRow): Promise<RefsResult> {
  return env.REPO.getByName(engineRepoName(repo)).listRefs();
}

/**
 * Warm the repo cell with its advert (GET info/refs → the DO's fetch path),
 * which is what persists meta.repo and binds the R2 pack backend. ENGINE GAP:
 * a cell whose FIRST contact is a receive RPC never binds R2 (rpcBind derives
 * from meta.repo, set only by fetch) — real git clients always advertise
 * before pushing, but the import consumer's receives are RPC-first, so this
 * warm-up is load-bearing: a retry receive whose object lookups HIT a
 * recorded pack needs r2KeyOf, which throws "no R2 backend bound for key
 * derivation" on an unbound cell. The engine should bind from the request's
 * resolved storage key inside rpcBind instead (next wave); until then every
 * consumer receive warms first.
 */
async function warmCell(env: Env, repo: RepoRow): Promise<void> {
  const req = new Request(
    `https://import.internal/${repo.ownerNamespace}/${repo.slug}.git/info/refs?service=git-receive-pack`,
  );
  markGateCleared(req);
  await engine.fetch(req, env, NOOP_CTX);
}

/** Paged list + batch delete of the import's R2 prefix (same discipline as
 *  the delete purge in src/repos/purge.ts; chunk count ≤ 200 keeps this far
 *  inside one invocation's budget). */
export async function purgeImportPrefix(env: Env, storageKey: string, importId: number): Promise<void> {
  const bucket = env.REPO_PACKS;
  if (!bucket) return;
  const prefix = `imports/${storageKey}/${importId}/`;
  let cursor: string | undefined;
  for (;;) {
    const listed = await bucket.list({ prefix, cursor });
    if (listed.objects.length > 0) await bucket.delete(listed.objects.map((o) => o.key));
    if (!listed.truncated) return;
    cursor = listed.cursor;
  }
}

// ---------------------------------------------------------------------------
// import-chunk
// ---------------------------------------------------------------------------

/**
 * Index one chunk (§2.6 pipeline step 1-2), stage-as-receive (see the module
 * doc). Returns true when the import reached a terminal state here (done or
 * failed); false means work remains (or was left to other messages).
 */
export async function indexChunk(env: Env, importId: number, repoId: string, chunkIndex: number): Promise<boolean> {
  const service = new ImportService(env.DB, { queue: env.REPO_TASKS });
  const row = await service.get(importId);
  if (row === null || row.repoId !== repoId) return false;
  if (row.state === "done" || row.state === "failed") return true; // redelivery after a terminal transition
  if (row.state !== "indexing") return false; // staged/finalizing: nothing to do here

  const repo = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (repo === undefined) {
    await service.markFailed(importId, `repository ${repoId} vanished mid-import`);
    return true;
  }
  const manifest = parseManifestRow(row);
  const chunk = manifest.chunks[chunkIndex];
  if (chunk === undefined) {
    await service.markFailed(importId, `manifest has no chunk ${chunkIndex}`);
    return true;
  }

  // Idempotency: a previous attempt's receive may have committed (temp ref at
  // the expected tip) with the checkpoint lost to a crash — adopt it.
  const tempRef = chunkTempRef(importId, chunkIndex);
  let existingTip: string | null;
  try {
    const refs = await listRefs(env, repo);
    existingTip = refs.refs.find((r) => r.name === tempRef)?.target ?? null;
  } catch (error) {
    console.error(`[imports] listRefs failed for ${engineRepoName(repo)}: ${errorMessage(error)}`);
    throw error; // transport-class: let the queue redeliver
  }
  if (existingTip === chunk.tip) {
    // The receive already committed this chunk (its checkpoint was lost to a
    // crash). The digest cross-check still applies: the manifest's pack must
    // be the one on disk before the chunk is adopted as done.
    const landed = await env.REPO_PACKS.head(
      `repos/${repo.storageKey}/packs/pack-${chunk.sha1}.pack`,
    );
    if (landed === null) {
      return await chunkFailed(
        env,
        service,
        importId,
        repoId,
        chunkIndex,
        `indexed pack digest differs from the manifest (expected pack-${chunk.sha1})`,
      );
    }
    await service.checkpointChunk(importId, chunkIndex, { status: "done" });
    return maybeFinalize(env, importId, repoId);
  }

  if ((chunk.attempts ?? 0) >= MAX_CHUNK_ATTEMPTS) {
    await service.markFailed(importId, `chunk ${chunkIndex} exceeded ${MAX_CHUNK_ATTEMPTS} attempts`);
    return true;
  }

  // The bytes must exist and match the manifest declaration before the
  // engine touches them.
  const key = importChunkR2Key(repo.storageKey, importId, chunkIndex);
  const obj = await env.REPO_PACKS.get(key);
  if (obj === null) {
    await service.markFailed(importId, `chunk ${chunkIndex} is not in storage (${key})`);
    return true;
  }
  if (obj.size !== chunk.bytes) {
    await service.markFailed(importId, `chunk ${chunkIndex} size mismatch: manifest ${chunk.bytes}, stored ${obj.size}`);
    return true;
  }

  // Resume shape: a temp ref from a crashed attempt at the WRONG tip is
  // deleted in the same receive that recreates it (commitPush applies the
  // delete before the create, so the create's zero-id CAS sees a clean ref).
  const commands: { old: string; next: string; ref: string }[] = [];
  if (existingTip !== null) commands.push({ old: existingTip, next: ZERO_OID, ref: tempRef });
  commands.push({ old: ZERO_OID, next: chunk.tip, ref: tempRef });

  // transport-class failures (DO/R2 hiccups) propagate: redelivery re-runs
  // the chunk from its manifest entry.
  await warmCell(env, repo);
  const res = await engine.fetch(receiveRequest(repo, commands, obj.body, obj.size), env, NOOP_CTX);
  const status = parseReportStatus(await res.arrayBuffer());
  const createResult = status.results[status.results.length - 1];

  if (status.unpackError !== null || createResult === undefined || !createResult.ok) {
    const reason =
      status.unpackError ??
      createResult?.message ??
      "no report-status verdict (engine returned an unexpected body)";
    return await chunkFailed(env, service, importId, repoId, chunkIndex, reason);
  }

  // Manifest-digest cross-check: the engine names the landed pack by its own
  // trailer hash — the pack the manifest declared must be the pack on disk.
  const packKey = `repos/${repo.storageKey}/packs/pack-${chunk.sha1}.pack`;
  const landed = await env.REPO_PACKS.head(packKey);
  if (landed === null) {
    return await chunkFailed(
      env,
      service,
      importId,
      repoId,
      chunkIndex,
      `indexed pack digest differs from the manifest (expected ${packKey})`,
    );
  }

  await service.checkpointChunk(importId, chunkIndex, { status: "done" });
  return maybeFinalize(env, importId, repoId);
}

/** Terminal chunk failure (§2.6 step 4): 'missing necessary objects' is the
 *  OUT-OF-ORDER verdict — queue batches are at-least-once and not strictly
 *  FIFO, so a chunk can run before its parents' chunks; that shape re-queues
 *  with a delay (bounded by attempts). Everything else fails the import. */
async function chunkFailed(
  env: Env,
  service: ImportService,
  importId: number,
  repoId: string,
  chunkIndex: number,
  reason: string,
): Promise<boolean> {
  const row = await service.get(importId);
  if (row === null || row.state !== "indexing") return false;
  const manifest = parseManifestRow(row);
  const chunk = manifest.chunks[chunkIndex];
  if (chunk === undefined) return false;

  if (reason.includes("missing necessary objects")) {
    const attempts = (chunk.attempts ?? 0) + 1;
    await service.checkpointChunk(importId, chunkIndex, {
      status: attempts >= MAX_CHUNK_ATTEMPTS ? "failed" : "pending",
      error: reason,
      attempts,
    });
    if (attempts >= MAX_CHUNK_ATTEMPTS) {
      await service.markFailed(importId, `chunk ${chunkIndex}: ${reason} (after ${attempts} attempts)`);
      return true;
    }
    if (env.REPO_TASKS) {
      await env.REPO_TASKS.send(
        { kind: "import-chunk", importId, repoId, chunk: chunkIndex },
        { delaySeconds: CHUNK_REORDER_DELAY_SECONDS },
      );
    }
    return false;
  }

  await service.checkpointChunk(importId, chunkIndex, { status: "failed", error: reason });
  await service.markFailed(importId, `chunk ${chunkIndex}: ${reason}`);
  return true;
}

/** All chunks done → the finalize hand-off (`indexing → finalizing`). */
async function maybeFinalize(env: Env, importId: number, repoId: string): Promise<boolean> {
  const service = new ImportService(env.DB, { queue: env.REPO_TASKS });
  const row = await service.get(importId);
  if (row === null || row.state !== "indexing") return false;
  const manifest = parseManifestRow(row);
  if (!manifest.chunks.every((c) => c.status === "done")) return false;
  if (!(await service.beginFinalizing(importId))) return false;
  return finalizeImport(env, importId, repoId);
}

// ---------------------------------------------------------------------------
// finalize (§2.6 pipeline step 3)
// ---------------------------------------------------------------------------

/**
 * Land every manifest ref in ONE multi-ref CAS, set HEAD, settle D1. The
 * receive is refs-only (no pack bytes): the finalizeReceive DO-side
 * `store.has(tip)` guard rejects any create whose tip is absent from the
 * object index, which — combined with the per-chunk anti-checks — is the
 * staged-packs connectivity gate.
 */
export async function finalizeImport(env: Env, importId: number, repoId: string): Promise<boolean> {
  const service = new ImportService(env.DB, { queue: env.REPO_TASKS });
  const row = await service.get(importId);
  if (row === null || row.repoId !== repoId) return false;
  if (row.state === "done") return true;
  if (row.state === "failed") return true;
  if (row.state !== "finalizing") return false;

  const repo = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (repo === undefined) {
    await service.markFailed(importId, `repository ${repoId} vanished mid-import`);
    return true;
  }
  const manifest = parseManifestRow(row);
  const stub = env.REPO.getByName(engineRepoName(repo));

  let refs: RefsResult;
  try {
    refs = await stub.listRefs();
  } catch (error) {
    console.error(`[imports] finalize listRefs failed for ${engineRepoName(repo)}: ${errorMessage(error)}`);
    throw error; // transport-class: redelivery
  }
  const current = new Map(refs.refs.map((r) => [r.name, r.target]));

  // Crash-recovery idempotency: every manifest ref already at its tip (and
  // every temp ref gone — the same receive that created them deleted the
  // temps) means a previous finalize committed; go straight to the settle.
  const manifestLanded = Object.entries(manifest.refs).every(([name, tip]) => current.get(name) === tip);
  const tempsLeft = refs.refs.filter((r) => r.name.startsWith(`refs/import/${importId}/`));
  if (!manifestLanded || tempsLeft.length > 0) {
    const commands: { old: string; next: string; ref: string }[] = [];
    for (const temp of tempsLeft) {
      commands.push({ old: temp.target, next: ZERO_OID, ref: temp.name });
    }
    for (const [name, tip] of Object.entries(manifest.refs)) {
      commands.push({ old: ZERO_OID, next: tip, ref: name });
    }

    let res: Response;
    try {
      await warmCell(env, repo);
      res = await engine.fetch(receiveRequest(repo, commands, null, 0), env, NOOP_CTX);
    } catch (error) {
      console.error(`[imports] finalize receive failed for ${engineRepoName(repo)}: ${errorMessage(error)}`);
      throw error; // transport-class: redelivery
    }
    const status = parseReportStatus(await res.arrayBuffer());
    const failed = status.unpackError !== null ? status.unpackError : status.results.filter((r) => !r.ok);
    const badText =
      typeof failed === "string"
        ? `unpack ${failed}`
        : failed.length > 0
          ? failed.map((r) => `${r.ref}: ${r.message ?? "rejected"}`).join("; ")
          : null;
    if (badText !== null) {
      // A non-temp create failing "fetch first" here means a concurrent push
      // raced the import (the gate's §4.9 409 closes this for D1 repos);
      // terminal per §2.6 step 4 — a retry start re-runs finalize, whose
      // listRefs probe above adopts the landed refs.
      await service.markFailed(importId, `finalize rejected: ${badText}`);
      return true;
    }
  }

  // Engine-then-D1 (§2.5.2 ordering): HEAD moves inside the DO first; D1 is
  // the metadata source of truth and records the same branch at settle.
  try {
    const head = await stub.setHead(manifest.head);
    if (head.tag !== "ok") {
      console.error(`[imports] setHead(${manifest.head}) rejected for ${engineRepoName(repo)}: ${head.tag}`);
    }
  } catch (error) {
    console.error(`[imports] setHead(${manifest.head}) failed for ${engineRepoName(repo)}: ${errorMessage(error)}`);
  }

  await service.settleDone(importId, manifest.head);
  console.log(
    `[imports] import ${importId} done: ${Object.keys(manifest.refs).length} refs, ${manifest.totalBytes} bytes from ${manifest.chunks.length} chunks`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// import-abort / import-sweep
// ---------------------------------------------------------------------------

/** Post-CAS abort cleanup: delete the import's temporary refs (a refs-only
 *  receive — the engine has no other ref-delete path) and purge the chunk
 *  prefix. Idempotent; queue redelivery re-runs both halves. */
export async function cleanupAbortedImport(env: Env, importId: number, repoId: string): Promise<void> {
  const repo = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (repo === undefined) return;
  try {
    const refs = await listRefs(env, repo);
    const temps = refs.refs.filter((r) => r.name.startsWith(`refs/import/${importId}/`));
    if (temps.length > 0) {
      const commands = temps.map((r) => ({ old: r.target, next: ZERO_OID, ref: r.name }));
      await warmCell(env, repo);
      const res = await engine.fetch(receiveRequest(repo, commands, null, 0), env, NOOP_CTX);
      const status = parseReportStatus(await res.arrayBuffer());
      const stillThere = status.results.some((r) => !r.ok && r.message !== undefined && r.message !== "fetch first");
      if (status.unpackError !== null || stillThere) {
        console.error(`[imports] abort ref cleanup for import ${importId}: ${JSON.stringify(status.results)}`);
      }
    }
  } catch (error) {
    // busy (a chunk receive holds the lease) or transport-class: the queue
    // redelivers the abort message until the lease frees; the R2 purge below
    // runs on every attempt (idempotent)
    console.error(`[imports] abort ${importId} ref cleanup deferred: ${errorMessage(error)}`);
    throw error;
  }
  await purgeImportPrefix(env, repo.storageKey, importId);
}

// ---------------------------------------------------------------------------
// REPO_TASKS dispatch (wired from src/repos/purge.ts)
// ---------------------------------------------------------------------------

export { isImportMessage };
export type { ImportMessage };

/**
 * One import message's work. Throwing is the RETRY signal (queue
 * redelivery); returning normally acks. Terminal outcomes (import failed /
 * done) return without throwing — a redelivery would no-op.
 */
export async function handleImportTask(env: Env, msg: ImportMessage): Promise<void> {
  switch (msg.kind) {
    case "import-chunk":
      await indexChunk(env, msg.importId, msg.repoId, msg.chunk ?? -1);
      return;
    case "import-abort":
      await cleanupAbortedImport(env, msg.importId, msg.repoId);
      return;
    case "import-sweep": {
      const service = new ImportService(env.DB);
      await service.sweepIfStale(msg.importId);
      return;
    }
  }
}

/** The manifest rows the consumer reads — re-exported for tests. */
export type { ImportManifest, ImportRow };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
