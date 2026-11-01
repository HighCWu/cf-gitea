/**
 * The migration status/retry/cancel arms — census gap #11's three endpoints
 * behind the landed migrate family (pages/repo-migrate.tsx, the POST /repo/
 * migrate page). Upstream at the pin:
 *
 *   GET  /{username}/{reponame}/-/migrate/status   web.go:1172-1174
 *        repo.MigrateStatus (routers/web/repo/migrate.go:271-309) — the
 *        migrating-page poller's JSON (repo-migrate.ts's initRepoMigration
 *        StatusChecker, a 2 s loop until status 4 reloads or 3 fails);
 *   POST /{username}/{reponame}/settings/migrate/retry   web.go:1281-1283
 *        repo.MigrateRetryPost (migrate.go:244-251) → task.RetryMigrateTask
 *        (services/task/task.go:138-159);
 *   POST /{username}/{reponame}/settings/migrate/cancel  web.go:1281-1283
 *        repo.MigrateCancelPost (migrate.go:253-268).
 *
 * ## The adjudication (the task-queue pin vs the landed substrate)
 *
 * Upstream's web migrate runs a QUEUED TASK (the `task` table,
 * structs.TaskStatus 0 queued / 1 running / 2 stopped "never used" / 3
 * failed / 4 finished — modules/structs/task.go:24-29): the repo is born
 * `status = RepositoryBeingMigrated`, its home renders migrating.tmpl
 * (view.go:178-202's checkHomeCodeViewable arm), and the task row IS the
 * status answer (GetMigratingTask, models/admin/task.go:175-184 — one row
 * per repo). The landed substrate has NO task table: the web form only
 * offers mirror=true (pages/repo-migrate.tsx's never-strand rule), the repo
 * is born ready+empty, and the population IS the one best-effort enqueued
 * mirror-sync whose retries are the §2.6 cron loop (services/mirror/sync.ts
 * — a failed sync leaves `next_sync_at` due; the next tick re-kicks). The
 * import arm (mirror=false, API-only) flips the repo `status='migrating'`
 * and keeps its own state machine on the `repo_imports` row (staged →
 * indexing → finalizing → done|failed, repos/imports/service.ts). Both
 * channels therefore CARRY the migration progress upstream's task row
 * carries, so the status arm answers from the RECORDS, not a task:
 *
 *   record resolution (the GetMigratingTask port — one record per repo):
 *     1. an ACTIVE import row (staged|indexing|finalizing — the partial
 *        unique index guarantees at most one) — the migration in flight
 *        (the repo row itself says 'migrating');
 *     2. else the LATEST terminal import row (done|failed, id DESC) — the
 *        most recent attempt's verdict must not be masked by the mirror
 *        channel's steady-state finished (a failed import reporting 4
 *        would be false);
 *     3. else the 1:1 mirror row (permanent for mirror repos) —
 *        `last_sync_at IS NULL` = the initial population pending,
 *        `last_sync_at` set = it landed (finished forever after; LATER
 *        sync failures are the mirror-sync channel's own state, visible on
 *        /settings/mirror, not the migration's);
 *     4. none → upstream's exact 404 err body.
 *
 *   status mapping (the wire ints ARE the contract — the vendored poller
 *   compares `data.status === 4` / `=== 3`, web_src/js/features/
 *   repo-migrate.ts:24-37):
 *     import  staged → 0 · indexing|finalizing → 1 · done → 4 ·
 *             failed → 3 (message = the row's error text)
 *     mirror  last_sync_at set → 4 · DIVERGENCE (documented below) →
 *             syncing → 1 · else 0 · the canceled sentinel (lastError
 *             === "canceled", cancelMigration's exact write) → 3.
 *
 * ## Documented divergences (each with its reason)
 *
 * 1. NO TERMINAL 3 FROM MIRROR FAILURES — upstream's failed task is
 *    terminal (manual retry); ours self-heals (sync.ts's failure leaves the
 *    row due; the cron retries). A pending self-retrying population IS
 *    queued/running — reporting 3 would be false and would stop the
 *    vendored poller while the population can still land. Only the admin's
 *    explicit give-up (cancelMigration's "canceled" sentinel) is terminal
 *    until retried — upstream's cancel→failed→retry loop, faithfully.
 *    (The sentinel string cannot collide with a real sync-failure text in
 *    practice: sync.ts stores fetch/git error messages, never the bare
 *    word; a collision would merely re-report 3 until the next sync
 *    overwrites it — the settle arms converge either way.)
 * 2. THE FAILED-MESSAGE GATE LOSES THE DOER ARM — upstream shows a failed
 *    task's message only to the task's doer or a repo admin
 *    (migrate.go:289-291: "a failure message can echo bytes the remote
 *    chose"); ours records no migration doer on either row, so the gate is
 *    ADMIN-ONLY (the repo-admin grant, canAdminRepo). Everyone else gets
 *    upstream's generic TrString("repo.migrate.migrating_failed_no_addr")
 *    = "Migration failed." (locale_en-US.json:1118).
 * 3. THE TRANSLATABLE-MESSAGE ARM IS PASSTHROUGH — upstream assumes a
 *    message starting with `{` is a TranslatableMessage JSON and localizes
 *    it (migrate.go:293-303); our error texts are plain server diagnostics
 *    (sync.ts's slice(0,2000) failure text, the import channel's
 *    errorMessage), never that JSON shape, so the module emits the stored
 *    text verbatim. Localizing foreign format keys would be dead code here.
 * 4. RETRY IS THE MIRROR ARM ONLY — upstream re-queues ANY non-queued/
 *    running task (task.go:143-159, INCLUDING finished — the button only
 *    shows on failed but the endpoint would re-run a finished migration).
 *    Ours: a pending population is re-due (`next_sync_at = now`, the
 *    sentinel/error cleared) + the one best-effort enqueue (the
 *    services/migrate.ts enqueue literal — a failed send self-heals at the
 *    next cron tick). An import row is NEVER re-queued: the terminal
 *    states' staged chunks are purged (pipeline.ts cleanupAbortedImport)
 *    and a browser settings POST has no chunk uploader to drive a fresh
 *    bootstrap — re-creating a row would strand it for the 24 h sweep (the
 *    never-strand rule), so import retries are a silent no-op success
 *    (upstream's queued/running arm is also a silent success;
 *    re-migration = re-POST /repo/migrate). A finished population is a
 *    no-op too (re-population is the mirror-sync schedule's job,
 *    /settings/mirror).
 * 5. RETRY WITHOUT A RECORD IS UPSTREAM'S 500 — task.RetryMigrateTask
 *    errors on GetMigratingTask's miss and the handler ServerErrors
 *    (migrate.go:245-249); the module returns the "missing" outcome and the
 *    fold's handler answers 500 (never reachable from the UI: the retry
 *    button renders only on the failed state, which implies a record).
 * 6. CANCEL BEST-EFFORT ON IN-FLIGHT WORK — upstream marks a running task
 *    failed('canceled') and the goroutine's finish write races it
 *    (migrate.go:260-266); ours: an active import goes through the
 *    channel's own CAS abort (ImportService.abort — failed('aborted') +
 *    the repo back to ready), a pending population is DESCHEDULED
 *    (`next_sync_at = 0` — the cron producer's scan excludes 0,
 *    sync.ts:884 — + the sentinel; CAS'd on `last_sync_at IS NULL` so a
 *    population that lands under the write wins honestly), and the already
 *    enqueued queue message may still drain and populate (the claim filter
 *    is syncState-only) — the same best-effort shape as upstream's race,
 *    not a stronger one. Every cancel path redirects onto the repo home
 *    (upstream's ctx.Redirect(ctx.Repo.Repository.Link()) in ALL arms,
 *    migrate.go:257/267 — including a missing record).
 * 7. THE SETTINGS BUTTONS DO NOT EXIST — upstream renders retry/cancel on
 *    the MIGRATING REPO HOME (migrating.tmpl:43/76 — the retry button and
 *    the cancel modal), NOT in the settings pages (no template under
 *    templates/repo/settings/ references either URL; the POSTs merely
 *    REGISTER under the settings path, web.go:1281-1283). The landed UI has
 *    no migrating-home rendering yet (the view.go:178-202 arm is a separate
 *    census row), so this module ships the endpoints with NO UI buttons —
 *    the migrating-home wave renders them against these URLs.
 * 8. THE GATES RIDE THE LANDED ROUTER — status: upstream
 *    `optSignIn, RepoAssignment, reqUnitCodeReader` (web.go:1170-1174);
 *    ours: resolveUiRequest's repo read grant (SPEC-0010 §2.6 — anonymous
 *    passes public repos; existence stays hidden for the rest; the
 *    unit-level refinement rides the landed repo-read grant at this pin,
 *    the mentions-in-repo gap sibling). retry/cancel: upstream
 *    `reqSignIn, RepoAssignment, reqRepoAdmin` inside the settings group
 *    (web.go:1278-1286); ours: the fold's sameOriginGuard + settingsGate
 *    (the settingsPage convention) — anonymous 303s onto login, non-admins
 *    404-shell.
 *
 * ## Arms (module-level; the fold owns the route registration)
 *
 * - resolveMigrationRecord → the record (or null);
 * - deriveMigrationStatus → the int + the raw failed message;
 * - migrateStatusPayload → the gate applied (the "Migration failed."
 *   substitution);
 * - migrateStatusResponse / migrateStatusNotFoundResponse → the exact
 *   upstream JSON bodies (Go marshals maps with SORTED keys —
 *   `{"message":...,"status":...}` — encoding/json's map key order);
 * - retryMigration → "requeued" | "noop" | "missing";
 * - cancelMigration → always (the caller redirects regardless).
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repoImports, repoMirrors } from "../../db/schema";
import { ImportNotFoundError, ImportService, type ImportRow } from "../../repos/imports/service";

/** Upstream structs.TaskStatus ints (task.go:24-29) — status 2 ("stopped")
 *  is commented "never used" upstream and is never emitted here either;
 *  the type carries only the four reachable values. */
export type MigrationTaskStatus = 0 | 1 | 3 | 4;

/** The migration record the status/retry/cancel arms answer from — the
 *  GetMigratingTask port's discriminated union (module header's resolution
 *  order: active import → terminal import → mirror → null). */
export type MigrationRecord =
  | { kind: "import"; row: ImportRow }
  | { kind: "mirror"; row: typeof repoMirrors.$inferSelect };

/** cancelMigration's terminal marker — the sentinel checked by
 *  deriveMigrationStatus (divergence 1). Exact-match by contract. */
export const MIGRATE_CANCEL_SENTINEL = "canceled";

/** The active import states (the partial unique index's WHERE — schema.ts
 *  repo_imports_active_uq). */
const ACTIVE_IMPORT_STATES = ["staged", "indexing", "finalizing"] as const;

/**
 * The repo's migration record, or null when no record exists (the caller
 * answers upstream's 404 err body / redirect arms). Resolution order in the
 * module header — active import, latest terminal import, mirror row.
 */
export async function resolveMigrationRecord(db: D1Database, repoId: string): Promise<MigrationRecord | null> {
  const active = await drizzle(db)
    .select()
    .from(repoImports)
    .where(and(eq(repoImports.repoId, repoId), inArray(repoImports.state, [...ACTIVE_IMPORT_STATES])))
    .get();
  if (active !== undefined) return { kind: "import", row: active };
  // The latest row of ANY state: the active states were excluded above, so
  // this is the newest terminal verdict (id DESC — createdAt has a 1 s
  // granularity; the autoincrement id is the monotonic tiebreak).
  const terminal = await drizzle(db)
    .select()
    .from(repoImports)
    .where(eq(repoImports.repoId, repoId))
    .orderBy(desc(repoImports.id))
    .get();
  if (terminal !== undefined) return { kind: "import", row: terminal };
  const mirror = await drizzle(db).select().from(repoMirrors).where(eq(repoMirrors.repoId, repoId)).get();
  if (mirror !== undefined) return { kind: "mirror", row: mirror };
  return null;
}

/** The derived status + the RAW failed message (no gate yet —
 *  migrateStatusPayload applies it). `failedMessage` is non-null only on
 *  the 3 arms; every other state carries upstream's empty message
 *  (queued/running/finished tasks store none). */
export function deriveMigrationStatus(record: MigrationRecord): {
  status: MigrationTaskStatus;
  failedMessage: string | null;
} {
  if (record.kind === "import") {
    switch (record.row.state) {
      case "staged":
        return { status: 0, failedMessage: null };
      case "indexing":
      case "finalizing":
        return { status: 1, failedMessage: null };
      case "done":
        return { status: 4, failedMessage: null };
      case "failed":
        return { status: 3, failedMessage: record.row.error ?? "" };
    }
  }
  const mirror = record.row;
  if (mirror.lastSyncAt !== null) return { status: 4, failedMessage: null };
  if (mirror.lastError === MIGRATE_CANCEL_SENTINEL) {
    return { status: 3, failedMessage: mirror.lastError };
  }
  return { status: mirror.syncState === "syncing" ? 1 : 0, failedMessage: null };
}

/** The generic failed-message text — upstream's
 *  TrString("repo.migrate.migrating_failed_no_addr") (locale_en-US.json:
 *  1118), the non-admin substitution arm (migrate.go:291-292). */
export const MIGRATE_FAILED_GENERIC = "Migration failed.";

/** The gate applied (divergence 2): a failed status echoes its message only
 *  to the repo admins; everyone else gets the generic text. Non-failed
 *  states carry "" either way (upstream stores no message on them). */
export function migrateStatusPayload(
  derived: { status: MigrationTaskStatus; failedMessage: string | null },
  canSeeFailure: boolean,
): { status: MigrationTaskStatus; message: string } {
  if (derived.failedMessage === null) return { status: derived.status, message: "" };
  return { status: derived.status, message: canSeeFailure ? derived.failedMessage : MIGRATE_FAILED_GENERIC };
}

/** The JSON headers — upstream's ctx.JSON content type (base.go's JSON
 *  writer) over the zero-option prod Cache-Control (base.go:114-120, the
 *  search-aux auxJsonHeaders posture MINUS the count header — ctx.JSON
 *  sets no X-Total-Count). */
function migrateJsonHeaders(): HeadersInit {
  return {
    "content-type": "application/json;charset=utf-8",
    "cache-control": "max-age=0, private, must-revalidate",
  };
}

/** The 200 body — Go's encoding/json marshals maps with SORTED keys, so the
 *  wire order is message-then-status (migrate.go:305-308's map). */
export function migrateStatusResponse(payload: { status: MigrationTaskStatus; message: string }): Response {
  return new Response(JSON.stringify({ message: payload.message, status: payload.status }), {
    status: 200,
    headers: migrateJsonHeaders(),
  });
}

/** The no-record body — migrate.go:274-278's exact map (the vendored
 *  poller treats any non-200 as keep-polling; the body is parity). */
export function migrateStatusNotFoundResponse(): Response {
  return new Response(JSON.stringify({ err: "task does not exist or you do not have access to this task" }), {
    status: 404,
    headers: migrateJsonHeaders(),
  });
}

/** The retry outcome — "missing" maps to upstream's ServerError 500
 *  (divergence 5); "requeued" and "noop" both answer ctx.JSONOK's
 *  `{"ok":true}` (context.go:243-245). */
export type MigrateRetryOutcome = "requeued" | "noop" | "missing";

/** The retry env slice — the enqueue rides MIRROR_SYNC_QUEUE only (the
 *  missing-queue runtime guard self-heals at the next cron tick, the
 *  services/migrate.ts posture). */
export type MigrateRetryEnv = Pick<Env, "MIRROR_SYNC_QUEUE">;

/**
 * task.RetryMigrateTask's port (task.go:138-159; divergences 4-5): a
 * pending mirror population is re-due NOW (`next_sync_at = now`, the
 * sentinel/error cleared — the CAS on `last_sync_at IS NULL` keeps a
 * population that lands under the write honest) and the one best-effort
 * sync is enqueued; every import state and a finished population are the
 * silent no-op success; no record is the "missing" outcome.
 */
export async function retryMigration(
  db: D1Database,
  env: MigrateRetryEnv,
  repo: { id: string; ownerNamespace: string; slug: string },
  now: Date,
): Promise<MigrateRetryOutcome> {
  const record = await resolveMigrationRecord(db, repo.id);
  if (record === null) return "missing";
  if (record.kind !== "mirror" || record.row.lastSyncAt !== null) return "noop";
  await drizzle(db)
    .update(repoMirrors)
    .set({
      nextSyncAt: Math.floor(now.getTime() / 1000),
      lastError: null,
      updatedAt: now,
    })
    .where(and(eq(repoMirrors.repoId, repo.id), isNull(repoMirrors.lastSyncAt)));
  // The services/migrate.ts enqueue literal (inlined — the route graph
  // must stay engine-free): best-effort, the row is due at `now` so a
  // failed send self-heals at the next cron tick.
  const queue = env.MIRROR_SYNC_QUEUE;
  if (queue) {
    try {
      await queue.send({ kind: "mirror-sync", repoId: repo.id });
    } catch (error) {
      console.error(
        `[migrate-status] retry enqueue failed for ${repo.ownerNamespace}/${repo.slug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return "requeued";
}

/** The JSONOK body — context.go:243-245's `{"ok":true}` dummy. */
export function migrateRetryOkResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: migrateJsonHeaders() });
}

/**
 * repo.MigrateCancelPost's port (migrate.go:253-268; divergence 6): an
 * active import goes through the channel's own CAS abort; a pending
 * population is descheduled + sentinel'd; every other state (no record,
 * terminal rows, a finished population) is a no-op — the caller redirects
 * onto the repo home in EVERY arm, exactly upstream.
 */
export async function cancelMigration(db: D1Database, repo: { id: string }, now: Date): Promise<void> {
  const record = await resolveMigrationRecord(db, repo.id);
  if (record === null) return;
  if (record.kind === "import") {
    if (record.row.state === "done" || record.row.state === "failed") return;
    // ImportService.abort: CAS staged|indexing|finalizing → failed('aborted')
    // + the repo row back to ready. The NotFound race (a settle landed
    // between the read and the abort) is upstream's task-already-finished
    // arm — the redirect answers either way.
    await new ImportService(db)
      .abort(record.row.id)
      .catch((error: unknown) => {
        if (error instanceof ImportNotFoundError) return null;
        throw error;
      });
    return;
  }
  const mirror = record.row;
  if (mirror.lastSyncAt !== null) return;
  // The deschedule + sentinel (CAS'd on last_sync_at IS NULL — a
  // population completing under this write leaves its own lastSyncAt and
  // the WHERE misses; the row converges to 4 honestly).
  await drizzle(db)
    .update(repoMirrors)
    .set({ nextSyncAt: 0, lastError: MIGRATE_CANCEL_SENTINEL, updatedAt: now })
    .where(and(eq(repoMirrors.repoId, repo.id), isNull(repoMirrors.lastSyncAt)));
}
