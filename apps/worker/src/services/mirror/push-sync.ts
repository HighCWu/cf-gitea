/**
 * Outbound push-mirror sync orchestrator (SPEC specs/push-mirror-outbound.md
 * §4) — the consumer half of the landed push-mirror CRUD + enqueue trigger
 * (8f0aa90). One `push-mirror-sync` queue message = one mirror row = one
 * HTTPS push of OUR refs to the REMOTE, as the client side of
 * git-receive-pack:
 *
 *   1. load repo + mirror row (either gone → `skipped: "missing-row"`, ack);
 *      re-claim `queued|idle → syncing` (lost → `skipped: "busy"`, ack) —
 *      the pull direction's exact two-step discipline (sync.ts claim
 *      shape), so producer races and queue redelivery are harmless.
 *   2. re-run the egress gate on the STORED url (§5.2 — upstream
 *      re-validates every sync, mirror_push.go:130-136); decrypt the sealed
 *      credentials (§5.1, the same §4.2 envelope mirrorAuthHeader reads).
 *   3. list OUR refs — an EMPTY local repo skips the sync entirely and
 *      settles success (§6.6 divergence guard: a mirror's first sync before
 *      the first push must never wipe the target, which upstream's git
 *      `--mirror` would do).
 *   4. `fetchReceiveRefs` (the remote's receive-pack advertisement, v0) →
 *      `planPushSync` (refset `refs/heads/*` + `refs/tags/*`, force via
 *      `old := remote tip`, prune always-on, `delete-refs`-gated) → commands.
 *      Nothing to do → settle success (last_update still advances — upstream
 *      records every attempt, mirror_push.go:110).
 *   5. objects needed (wants non-empty): loopback `git-upload-pack` against
 *      the engine's own serving surface — wants = our tips, haves = the
 *      remote's advertised oids (§2.4's REUSE verdict: the fetch negotiation
 *      algebra with the roles renamed, zero engine changes) — demuxed band 1
 *      IS the pack; `pushPack` streams command section + pack (never
 *      buffered) to the remote and parses report-status. Deletes-only syncs
 *      send no packfile (§2.2 step 3). Any `unpack` error or `ng` fails the
 *      sync into `last_error` (§6.3/6.5); `ng fetch first` is the
 *      advertisement→POST TOCTOU and self-heals at the next cadence (§6.4).
 *   6. settle (§4.4): success → `last_update = now`, `sync_state = 'idle'`,
 *      `next_sync_at = now + interval` (or 0 when commit-triggered only),
 *      `last_error = ''` — CAS'd on `sync_state = 'syncing'` so a delete
 *      racing the sync cannot resurrect the row; failure → `last_update =
 *      now` (upstream records attempts), `next_sync_at` LEFT DUE so the
 *      next cron sweeps retry, sanitized capped `last_error`. Terminal
 *      outcomes return (the consumer acks); only infrastructure failures
 *      throw → queue retry (max 5, then the drop-with-log posture
 *      wrangler.jsonc documents).
 *
 * WIRING (the consumer + producer arms — NOT registered in this wave; purge.ts
 * (src/repos/**) and src/index.ts are outside this wave's file ownership; the
 * orchestrator lands these three snippets, behavior identical to the landed
 * pull direction):
 *
 *   // src/repos/purge.ts handleRepoTasks — BEFORE the malformed-drop ACK,
 *   // beside the mirror-sync arm:
 *   import { handlePushMirrorSync, isPushMirrorSyncMessage } from "../services/mirror/push-sync";
 *   if (isPushMirrorSyncMessage(message.body)) {
 *     try {
 *       await handlePushMirrorSync(env, { repoId: message.body.repoId, pushMirrorId: message.body.pushMirrorId });
 *       message.ack();
 *     } catch (error) {
 *       console.error(`[repo-tasks] push-mirror-sync ${message.id} retrying: ${error}`);
 *       message.retry();
 *     }
 *     continue;
 *   }
 *
 *   // src/index.ts scheduled — beside enqueueDueMirrorSyncs:
 *   import { enqueueDuePushMirrorSyncs } from "./services/mirror/push-sync";
 *   await enqueueDuePushMirrorSyncs(env, {});   // SELECT+enqueue only (30 s cron CPU)
 *
 *   // src/index.ts onPush mount (line ~43) — the sync-on-commit producer
 *   // (SPEC §4.1 commit hook; upstream syncPushMirrorWithSyncOnCommit,
 *   // mirror_push.go:250-260), best-effort, never fails the push:
 *   onPush: (event, env) => {
 *     void enqueuePushMirrorSyncsOnCommit(env, event.repo); // enqueue helper: catches its own
 *     return handleUserPushEvent(env, event);
 *   },
 */

import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { RefsResult } from "@cf-gitea/git-engine";

import { findRepositoryByPath } from "../../api/services/repository";
import { pushMirrors, repositories } from "../../db/schema";
import { markGateCleared } from "../../git-http/gate";
import { engineName, type RepoRow } from "../../repos/service";
import {
  AGENT_CAP,
  PACK_MAX_BYTES,
  SmartHttpError,
  UPLOAD_PACK_REQUEST_CT,
  buildV0FetchBody,
  checkMirrorSource,
  demuxPackResponse,
  responseBodyBytes,
  type Advertisement,
  type FetchImpl,
  type PackResponseResult,
} from "./gitclient";
import {
  advertisesDeleteRefs,
  describeReportFailure,
  fetchReceiveRefs,
  planCommands,
  planPushSync,
  pushPack,
} from "./pushclient";
import { NOOP_CTX, SYNCING_SWEEP_AFTER_SEC, engine, mirrorAuthHeader, mirrorEgressPolicy, warmCell, type MirrorSyncEnv } from "./sync";

// ---------------------------------------------------------------------------
// Queue message + options + result
// ---------------------------------------------------------------------------

/** The only thing a producer puts on MIRROR_SYNC_QUEUE for this lane (§4.1:
 *  the API trigger enqueues one per mirror row; so do the cron producer and
 *  the commit hook). */
export interface PushMirrorSyncMessage {
  kind: "push-mirror-sync";
  repoId: string;
  pushMirrorId: number;
}

export function isPushMirrorSyncMessage(value: unknown): value is PushMirrorSyncMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as PushMirrorSyncMessage).kind === "push-mirror-sync" &&
    typeof (value as PushMirrorSyncMessage).repoId === "string" &&
    typeof (value as PushMirrorSyncMessage).pushMirrorId === "number"
  );
}

export interface PushMirrorSyncOptions {
  /** Test seam — NO real network in tests (the gitclient fetchImpl seam;
   *  the loopback legs ride the real engine). */
  fetchImpl?: FetchImpl;
  /** Test clock for the settle arithmetic. */
  now?: Date;
}

export type PushMirrorSyncSkip =
  | "missing-row" // repo or mirror row gone (a delete raced the sync, §6.11)
  | "busy" // sync_state CAS lost — another producer's message owns the mirror (§6.10)
  | "storage-pending" // push_mirrors migration not applied to this D1
  | "empty-local" // §6.6: our repo has no refs — never wipe the target
  | "no-changes"; // remote already identical (last_update still advances, §4.4)

export interface PushMirrorSyncResult {
  ok: boolean;
  skipped?: PushMirrorSyncSkip;
  created?: number;
  updated?: number;
  deleted?: number;
  /** Deletes dropped because the target lacks `delete-refs` (§6.2) — never
   *  silently pretended. */
  deletesSkipped?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// push_mirrors row (the narrow projection a sync reads/writes)
// ---------------------------------------------------------------------------

interface PushMirrorRow {
  id: number;
  repoId: string;
  remoteAddress: string;
  intervalSeconds: number;
  credentialsUsername: string | null;
  credentialsCiphertext: string | null;
  syncState: "idle" | "queued" | "syncing";
  nextSyncAt: number;
}

async function readPushMirrorRow(db: D1Database, repoId: string, pushMirrorId: number): Promise<PushMirrorRow | null> {
  const row = await drizzle(db)
    .select()
    .from(pushMirrors)
    .where(and(eq(pushMirrors.id, pushMirrorId), eq(pushMirrors.repoId, repoId)))
    .get();
  if (row === undefined) return null;
  return {
    id: row.id,
    repoId: row.repoId,
    remoteAddress: row.remoteAddress,
    intervalSeconds: row.intervalSeconds,
    credentialsUsername: row.credentialsUsername,
    credentialsCiphertext: row.credentialsCiphertext,
    syncState: row.syncState,
    nextSyncAt: row.nextSyncAt,
  };
}

/** §4.2 step 1 — CAS `idle|queued → syncing` (0 rows = another producer's
 *  message owns the mirror). The WHERE guard is the whole lock. The write
 *  stamps `last_update_unix` with the attempt START — upstream records every
 *  attempt (mirror_push.go:110) — and that stamp is the syncing-timeout
 *  sweep's staleness clock (the pull claim's `updated_at` shape, sync.ts):
 *  without it a consumer death after the claim would leave no in-state age
 *  to sweep on. */
async function claimPushMirrorRow(db: D1Database, row: PushMirrorRow, nowSec: number): Promise<boolean> {
  const claimed = await drizzle(db)
    .update(pushMirrors)
    .set({ syncState: "syncing", lastUpdateUnix: new Date(nowSec * 1000) })
    .where(and(eq(pushMirrors.id, row.id), eq(pushMirrors.repoId, row.repoId), ne(pushMirrors.syncState, "syncing")))
    .returning({ id: pushMirrors.id })
    .all();
  return claimed.length > 0;
}

/** §4.4 success settle (CAS'd on the claim so a delete racing the sync can
 *  never resurrect the row): `last_update = now` (upstream's
 *  UpdatePushMirrorSyncStatus), schedule advanced, error cleared. */
async function settlePushMirrorSuccess(db: D1Database, row: PushMirrorRow, nowSec: number): Promise<void> {
  await drizzle(db)
    .update(pushMirrors)
    .set({
      lastUpdateUnix: new Date(nowSec * 1000),
      nextSyncAt: row.intervalSeconds > 0 ? nowSec + row.intervalSeconds : 0,
      syncState: "idle",
      lastError: "",
    })
    .where(and(eq(pushMirrors.id, row.id), eq(pushMirrors.repoId, row.repoId), eq(pushMirrors.syncState, "syncing")));
}

/** §4.4 failure settle: `last_update = now` (upstream records attempts,
 *  mirror_push.go:110), sanitized error text, back to idle; `next_sync_at`
 *  left DUE (untouched) so the next cron sweeps retry — the pull direction's
 *  backoff posture. */
async function settlePushMirrorFailure(db: D1Database, row: PushMirrorRow, errorText: string, nowSec: number): Promise<void> {
  await drizzle(db)
    .update(pushMirrors)
    .set({
      lastUpdateUnix: new Date(nowSec * 1000),
      lastError: errorText.slice(0, 2000),
      syncState: "idle",
    })
    .where(and(eq(pushMirrors.id, row.id), eq(pushMirrors.repoId, row.repoId), eq(pushMirrors.syncState, "syncing")));
}

// ---------------------------------------------------------------------------
// The loopback upload-pack composition (§2.4 — the REUSE verdict)
// ---------------------------------------------------------------------------

/**
 * Pack `closure(our tips) − closure(remote's advertised oids)` by asking the
 * engine's OWN upload-pack surface for it: a synthetic v0 fetch whose wants
 * are our tips (always our advertised tips — the engine's advertisedOids
 * gate, protocol.ts, is satisfied) and whose haves are the REMOTE's
 * advertised oids (tips + peeled targets, ≤ MAX_HAVES — the client truncates
 * and the exclusion walk deliberately under-approximates, so truncation only
 * inflates the pack, never corrupts it). The demuxed band-1 stream IS the
 * pack we POST to the remote. Free side effects: the full-clone R2 cache
 * warms itself on the loopback MISS path, and all lease/GC/bookkeeping
 * behavior is the production serving path's. Zero vendored-engine changes.
 */
async function loopbackPack(env: MirrorSyncEnv, repo: RepoRow, wants: string[], haves: string[]): Promise<PackResponseResult> {
  await warmCell(env, repo);
  const body = buildV0FetchBody(wants, haves, ["multi_ack_detailed", "side-band-64k", "no-progress", AGENT_CAP]);
  const req = new Request(`https://mirror.internal/${engineName(repo.ownerNamespace, repo.slug)}.git/git-upload-pack`, {
    method: "POST",
    headers: { "content-type": UPLOAD_PACK_REQUEST_CT },
    body,
  });
  markGateCleared(req);
  const response = await engine.fetch(req, env, NOOP_CTX);
  if (!response.ok) throw new SmartHttpError(`loopback upload-pack failed: HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/x-git-upload-pack-result") {
    throw new SmartHttpError(`loopback upload-pack content-type is '${contentType ?? "none"}', expected 'application/x-git-upload-pack-result'`);
  }
  return demuxPackResponse(
    responseBodyBytes(response),
    { protocolVersion: 0, sideband: true },
    { onProgress: (text) => console.log(`[push-mirror-sync] ${repo.ownerNamespace}/${repo.slug}: ${text.trimEnd()}`) },
    { maxBytes: PACK_MAX_BYTES },
  );
}

// ---------------------------------------------------------------------------
// handlePushMirrorSync (§4.2)
// ---------------------------------------------------------------------------

function pushMirrorErrorText(error: unknown): string {
  if (error instanceof SmartHttpError) return error.message; // already sanitized (gitclient contract)
  return `push-mirror sync failed: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * One push-mirror sync (§4.2). Throwing is the RETRY signal for a queue
 * consumer; every terminal outcome (the upstream failure posture, §4.4)
 * returns a result and leaves the mirror row recorded (success advances the
 * schedule; failure leaves `next_sync_at` due for the next cron).
 */
export async function handlePushMirrorSync(
  env: MirrorSyncEnv,
  options: PushMirrorSyncOptions & { repoId: string; pushMirrorId: number },
): Promise<PushMirrorSyncResult> {
  const { repoId, pushMirrorId, fetchImpl, now: nowOpt } = options;
  const now = nowOpt ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);

  const repo = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (repo === undefined) return { ok: false, skipped: "missing-row" };

  let mirror: PushMirrorRow | null;
  try {
    mirror = await readPushMirrorRow(env.DB, repoId, pushMirrorId);
  } catch (error) {
    // No push_mirrors table yet (migration 0023/0032 not applied to this
    // D1 — e.g. a remote pending db:migrate:remote). Never fake a sync.
    return {
      ok: false,
      skipped: "storage-pending",
      error: `push_mirrors storage unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (mirror === null) return { ok: false, skipped: "missing-row" };
  if (!(await claimPushMirrorRow(env.DB, mirror, nowSec))) return { ok: false, skipped: "busy" };

  const fail = async (errorText: string): Promise<PushMirrorSyncResult> => {
    await settlePushMirrorFailure(env.DB, mirror, errorText, nowSec);
    return { ok: false, error: errorText };
  };

  // §4.2 step 2 — egress re-check of the STORED url on every sync (§5.2).
  let targetUrl: URL;
  try {
    targetUrl = new URL(mirror.remoteAddress);
  } catch {
    return await fail(`stored mirror URL is invalid: ${JSON.stringify(mirror.remoteAddress)}`);
  }
  const policy = mirrorEgressPolicy(env);
  const gate = checkMirrorSource(targetUrl, policy);
  if (!gate.allowed) return await fail(gate.reason);

  // Credentials decrypt once, in memory, never logged (§5.1). Failure here
  // is a clean sync failure (KEK absent / wrong AAD → fail cleanly).
  let authHeader: string | null;
  try {
    authHeader = await mirrorAuthHeader(env, mirror);
  } catch (error) {
    return await fail(pushMirrorErrorText(error));
  }

  // Our refs FIRST — the §6.6 empty-local guard skips the whole sync (no
  // advertisement fetch, no deletes) and settles success.
  let refs: RefsResult;
  try {
    refs = await env.REPO.getByName(engineName(repo.ownerNamespace, repo.slug)).listRefs();
  } catch (error) {
    return await fail(`local ref listing failed: ${pushMirrorErrorText(error)}`);
  }
  if (refs.refs.length === 0) {
    await settlePushMirrorSuccess(env.DB, mirror, nowSec);
    return { ok: true, skipped: "empty-local", created: 0, updated: 0, deleted: 0 };
  }

  // §4.2 step 3 — advertise (v0 only), diff vs our tips, plan.
  let advert: Advertisement;
  try {
    advert = await fetchReceiveRefs(targetUrl.toString(), { fetchImpl, policy, authHeader: authHeader ?? undefined });
  } catch (error) {
    return await fail(pushMirrorErrorText(error));
  }

  const allowDelete = advertisesDeleteRefs(advert);
  const plan = planPushSync(
    advert,
    refs.refs.map((r) => ({ name: r.name, target: r.target })),
    { allowDelete },
  );
  const commands = planCommands(plan);
  const deletesSkipped = plan.skippedDeletes.length;

  if (commands.length === 0) {
    // §4.4 no-op: the remote is already identical — last_update still
    // advances (upstream advances it on every sync attempt).
    await settlePushMirrorSuccess(env.DB, mirror, nowSec);
    return { ok: true, skipped: "no-changes", created: 0, updated: 0, deleted: 0, deletesSkipped };
  }

  try {
    // §4.2 step 4 — objects needed → loopback upload-pack → demux → the pack
    // streams straight into the POST (never buffered). Deletes-only requests
    // carry NO packfile (§2.2 step 3).
    let packStream: ReadableStream<Uint8Array> | null = null;
    if (plan.wants.length > 0) {
      const loopback = await loopbackPack(env, repo, plan.wants, plan.haves);
      const acked = await loopback.ackedRefs;
      console.log(
        `[push-mirror-sync] ${repo.ownerNamespace}/${repo.slug} → ${targetUrl.hostname}: ` +
          `${commands.length} command(s) (${plan.creates.length}c/${plan.updates.length}u/${plan.deletes.length}d), ` +
          `${plan.wants.length} want(s), ${acked.length} common oid(s)` +
          (deletesSkipped > 0 ? `, ${deletesSkipped} delete(s) skipped (no delete-refs)` : ""),
      );
      packStream = loopback.packStream;
    } else {
      console.log(
        `[push-mirror-sync] ${repo.ownerNamespace}/${repo.slug} → ${targetUrl.hostname}: ` +
          `${commands.length} delete-only command(s), no packfile`,
      );
    }
    const report = await pushPack(targetUrl.toString(), commands, packStream, {
      fetchImpl,
      policy,
      authHeader: authHeader ?? undefined,
    });
    // §4.2 step 5 — ANY unpack error or ng fails the sync wholesale (§6.3/6.5).
    if (report.unpackError !== null) {
      return await fail(`mirror target rejected the pack: unpack ${report.unpackError}`);
    }
    if (report.results.some((r) => !r.ok)) {
      return await fail(`mirror target push failed: ${describeReportFailure(report)}`);
    }
  } catch (error) {
    return await fail(pushMirrorErrorText(error));
  }

  // §4.4 success settle.
  await settlePushMirrorSuccess(env.DB, mirror, nowSec);
  return { ok: true, created: plan.creates.length, updated: plan.updates.length, deleted: plan.deletes.length, deletesSkipped };
}

// ---------------------------------------------------------------------------
// The cron producer (§4.1) + the sync-on-commit producer
// ---------------------------------------------------------------------------

/**
 * The stuck-syncing sweep, push half — the pull direction's exact shape
 * (sweepStaleSyncingPullRows, sync.ts; budget SYNCING_SWEEP_AFTER_SEC, the
 * receive lease's own TTL): CAS every `sync_state='syncing'` row whose claim
 * stamp is beyond the budget back to `idle`; the cron producer's
 * due-SELECT + `idle → queued` CAS below re-enqueues cron-due rows in the
 * SAME tick (a commit-hook-only row — interval 0, `next_sync_at` 0 — stays
 * idle until its next trigger, which is that lane's producer). Rows claimed
 * before the claim-stamp landed (a pre-deploy wedge: `syncing` with NULL
 * `last_update_unix`) are reclaimed unconditionally — under claim-stamping
 * code such a row cannot be mid-flight. The reclaim leaves
 * `last_update_unix` alone: the dead attempt's stamp is the diagnostic, and
 * a sweep is not an attempt (§4.4 settles stamp it). Returns the rows
 * reclaimed.
 */
async function sweepStaleSyncingPushRows(db: D1Database, staleBefore: Date): Promise<number> {
  const reclaimed = await drizzle(db)
    .update(pushMirrors)
    .set({ syncState: "idle" })
    .where(
      and(
        eq(pushMirrors.syncState, "syncing"),
        or(isNull(pushMirrors.lastUpdateUnix), lte(pushMirrors.lastUpdateUnix, staleBefore)),
      ),
    )
    .returning({ id: pushMirrors.id })
    .all();
  return reclaimed.length;
}

/**
 * The cron producer: first the stuck-syncing sweep (the availability-gap fix
 * brief — docs/research/sqlite-locked-2026-10-26.md §4/§5.3: a settle-step
 * error or a dead consumer used to wedge a row in `syncing` forever), then
 * SELECT due mirrors — `interval_seconds != 0 AND
 * next_sync_at <= now AND sync_state = 'idle'`, archived repos excluded by
 * the join, oldest-synced first, LIMIT 50 — upstream PushMirrorsIterate's
 * WHERE/ORDER/LIMIT shape (pushmirror.go:147-160). Rows never synced yet
 * (`next_sync_at = 0`, the 0023-era wake-up, §3.2) are due by the same
 * arithmetic — `0 <= now` — exactly upstream's, where `interval != 0` is the
 * scheduler's on/off switch. Each due row is CAS-claimed `idle → queued`
 * (no double-enqueue under contention), then `sendBatch` (≤ 100 per call).
 * Queue redelivery is safe: handlePushMirrorSync re-checks every state.
 * Returns the number of syncs enqueued. SELECT + enqueue only — the
 * sub-hour cron's 30 s CPU budget (AGENTS.md).
 */
export async function enqueueDuePushMirrorSyncs(
  env: MirrorSyncEnv,
  options: { now?: Date; limit?: number } = {},
): Promise<number> {
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const limit = options.limit ?? 50;
  if (env.MIRROR_SYNC_QUEUE === undefined) {
    throw new SmartHttpError("MIRROR_SYNC_QUEUE is not bound (wrangler.jsonc); the push-mirror cron producer cannot enqueue");
  }
  const db = drizzle(env.DB);
  // The sweep runs FIRST so a reclaimed row is due-selected and re-enqueued
  // in the same tick.
  const swept = await sweepStaleSyncingPushRows(env.DB, new Date((now - SYNCING_SWEEP_AFTER_SEC) * 1000));
  if (swept > 0) console.log(`[push-mirror-sync] syncing-timeout sweep reclaimed ${swept} stale syncing row(s) at ${now}`);
  const due = await db
    .select({ id: pushMirrors.id, repoId: pushMirrors.repoId })
    .from(pushMirrors)
    .innerJoin(repositories, eq(repositories.id, pushMirrors.repoId))
    .where(
      and(
        ne(pushMirrors.intervalSeconds, 0),
        lte(pushMirrors.nextSyncAt, now),
        eq(pushMirrors.syncState, "idle"),
        eq(repositories.isArchived, false),
      ),
    )
    .orderBy(sql`coalesce(${pushMirrors.lastUpdateUnix}, 0)`)
    .limit(limit);

  const messages: PushMirrorSyncMessage[] = [];
  for (const row of due) {
    // CAS wins the right to enqueue — no double-enqueue under contention
    // (the cron racing the API trigger or the commit hook).
    const claimed = await db
      .update(pushMirrors)
      .set({ syncState: "queued" })
      .where(and(eq(pushMirrors.id, row.id), eq(pushMirrors.repoId, row.repoId), eq(pushMirrors.syncState, "idle")))
      .returning({ id: pushMirrors.id })
      .all();
    if (claimed.length > 0) messages.push({ kind: "push-mirror-sync", repoId: row.repoId, pushMirrorId: row.id });
  }
  for (let i = 0; i < messages.length; i += 100) {
    await env.MIRROR_SYNC_QUEUE.sendBatch(messages.slice(i, i + 100).map((message) => ({ body: message })));
  }
  if (messages.length > 0) {
    console.log(`[push-mirror-sync] enqueued ${messages.length} sync(es) due at ${now}`);
  }
  return messages.length;
}

/**
 * The sync-on-commit producer (§4.1): every mirror of the repo with
 * `sync_on_commit = true` enqueues on every user push — upstream
 * `syncPushMirrorWithSyncOnCommit` → `GetPushMirrorsSyncedOnCommit`
 * (pushmirror.go:140-145, mirror_push.go:250-260). BEST-EFFORT by contract:
 * it never throws and never fails the push response (upstream's
 * AddPushMirrorToQueue is fire-and-forget) — every failure logs. `repoName`
 * is the engine combined name the onPush event carries (`owner/slug`).
 * Rows with `interval_seconds = 0` are commit-hook-ELIGIBLE (§7's state
 * battery) — eligibility here is `sync_on_commit` alone.
 */
export async function enqueuePushMirrorSyncsOnCommit(env: MirrorSyncEnv, repoName: string): Promise<number> {
  try {
    if (env.MIRROR_SYNC_QUEUE === undefined) return 0; // binding absent — best-effort no-op
    const slash = repoName.indexOf("/");
    if (slash <= 0) return 0;
    const pair = await findRepositoryByPath(env.DB, repoName.slice(0, slash).toLowerCase(), repoName.slice(slash + 1));
    if (pair === null) return 0;
    const rows = await drizzle(env.DB)
      .select({ id: pushMirrors.id, repoId: pushMirrors.repoId })
      .from(pushMirrors)
      .where(and(eq(pushMirrors.repoId, pair.repo.id), eq(pushMirrors.syncOnCommit, true)))
      .all();
    let enqueued = 0;
    for (const row of rows) {
      try {
        await env.MIRROR_SYNC_QUEUE.send({ kind: "push-mirror-sync", repoId: row.repoId, pushMirrorId: row.id });
        enqueued += 1;
      } catch (error) {
        console.error(
          `[push-mirror-sync] ${repoName}: commit-hook enqueue for mirror ${row.id} failed (the push stands): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return enqueued;
  } catch (error) {
    // The producer's setup half (repo resolution) failed — the push stands.
    console.error(
      `[push-mirror-sync] ${repoName}: commit-hook producer failed (the push stands): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
}
