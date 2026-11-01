/**
 * The ADMIN MONITOR family — `/-/admin/monitor/*` — the bench-row module
 * (wave 61; MOUNTED at e31c0cf, window-2c: the routes live in `index.ts` —
 * the retired wiring HANDOFF is the mount record at the bottom of this
 * header; the "no admin web surface" state below is the pre-mount record).
 * Sibling scope note at the two-stage landing: no admin web surface existed
 * then (`src/ui/pages/` had zero `admin-*` modules; the whole `/-/admin`
 * family was the parity survey's single ABSENT row,
 * docs/compat/ui-parity-survey.md:386), so this module carries the
 * monitor family alone and owns none of the dashboard/users/repos pages.
 *
 * ## Upstream surface (at the pin)
 *
 * The classic single `monitor.tmpl` dashboard no longer exists at the pin —
 * the monitor surface is the `/-/admin/monitor` route GROUP
 * (routers/web/web.go:796-813) of five navbar-linked sub-pages
 * (templates/admin/navbar.tmpl:106-124) inside the admin layout
 * (layout_head.tmpl: the `admin monitor` pageClass, `.ui.container.fluid
 * .padded.flex-container` wrapping the admin navbar + `.flex-container-main`;
 * every template opens `.admin-setting-content`):
 *
 *   GET /-/admin/monitor/stats       MonitorStats  (admin.go:256) —
 *         activities.GetStatistic().Counter JSON-marshalled into a sorted
 *         key/count table (stats.tmpl).
 *   GET /-/admin/monitor/cron        CronTasks     (admin.go:249) —
 *         cron.ListTasks() table with per-task run buttons POSTing
 *         `op=<name>&from=monitor` to the DASHBOARD route (cron.tmpl:7);
 *         DashboardPost (admin.go:154-194) runs the task and redirects back.
 *   GET /-/admin/monitor/queue       Queues        (queue.go:21-29) —
 *         queue.GetManager().ManagedQueues() table; the per-queue manage page
 *         (`/queue/{qid}`: set max workers, remove-all-items) hangs off it.
 *   GET /-/admin/monitor/stacktrace  Stacktrace    (stacktrace.go:23-40) —
 *         the trace page: "%d Goroutines, %d Processes" header over the
 *         process-manager stack list (+ the dev-only perftrace tab and the
 *         diagnosis-report download form, trace_tabs.tmpl).
 *   GET /-/admin/monitor/audit_logs  ViewAuditLogs — NOT ported (no landed
 *         audit-log store; the nav item is omitted — the dead-link rule).
 *
 * The whole group sits behind `verifyAuthWithOptionsWeb(&VerifyOptions{
 * SignInRequired: true, AdminRequired: true})` (web.go:779) — anonymous
 * → the login redirect, a signed-in non-admin → the 404 shell. That gate is
 * the ROUTE stage's posture (the module trusts its inputs like every landed
 * load function); upstream's admin settings navbar renders
 * `ctx.Locale.Tr "admin.settings"` as the menu header (navbar.tmpl:3).
 *
 * ## Data (§3.2 — the landed admin seams, never a self-fetch)
 *
 * What the landed backend can actually answer decided the family split below:
 *
 *   stats    COUNT queries over the landed D1 tables (Drizzle, the metadata
 *            source of truth) under upstream's exact counter key names — the
 *            landed-table subset of GetStatistic (models/activities/
 *            statistic.go:57-122). Omitted counters have NO landed table:
 *            Access (the ACL is computed, never stored), Branches/Tags (git
 *            refs live in the engine, R2 — no D1 rows), AuthSource (no
 *            external-auth store), UpdateTask (no update checker);
 *            IssueByLabel/IssueByRepository render upstream only behind the
 *            metrics settings (statistic.go:87,96) — the default-off arm.
 *   cron     the FULL landed arm census — `CRON_ARMS` (services/
 *            cron-state.ts, the usability F3 listing): one row per scheduled
 *            arm of the Worker's `scheduled` handler, mirroring
 *            handleScheduledCron's dispatch exactly (four arms on every
 *            10-minute step entry, six producer arms on the hourly entry;
 *            the census block comment holds the per-arm upstream twin cites
 *            and the three cf-gitea-extension names). The per-arm tick state —
 *            Previous Time / Executions / Result, upstream's TaskTableRow
 *            Prev/ExecTimes/Status triple — comes from the `cron_state`
 *            table (migration 0044), which the scheduled handler upserts per
 *            entry (services/cron-state.ts; upstream keeps the same state in
 *            process memory — tasks.go TaskTableRow — a luxury no Workers
 *            isolate has). TWO loaders serve it: `loadAdminMonitorCron(now)`
 *            is the SYNC census render (never-fired posture for every arm —
 *            the shape ui/index.ts's route call sites use until their
 *            two-line swap to `loadAdminMonitorCronRunState(db, now)`, which
 *            merges the recorded state; the swap is the disclosed
 *            integration — ui/index.ts is outside this module's ownership).
 *            The run arm is the landed RUN-CAPABLE subset — exactly
 *            admin-degenerate.ts's CRON_RUN_BODIES (five runnable arms:
 *            update_mirrors, update_push_mirrors, demo_sweep,
 *            delete_old_audit_events, cleanup_packages; "run = enqueue"):
 *            the button renders only there and the five still-bodyless
 *            actions-family census arms render an empty first cell (never a
 *            dead control); a manual run records its tick too (upstream
 *            ExecTimes counts run STARTS — tasks.go:95-97 — and RunWithUser
 *            serves both triggers). The API registry's CRON_RUN_BODIES and
 *            this module's dispatch map hold the same five names — extending
 *            run capability extends BOTH registries in one change (both
 *            modules' extension rules).
 *   queue    Cloudflare Queues expose no depth introspection and there is no
 *            in-process queue manager to enumerate — but the LANDED D1 state
 *            of the two queue-backed pipelines answers "number in queue" for
 *            them: the webhook delivery log's `pending|delivering` rows
 *            (SPEC-0005 §3.6, db/schema webhook_deliveries.state) and the
 *            pull-mirror producer's `queued|syncing` rows (SPEC-0009 §2.6,
 *            repo_mirrors.sync_state). The dead-letter queue
 *            (webhook-delivery-dlq, wrangler.jsonc consumers) has no landed
 *            counter at all — its row renders the `-` arm, queue.tmpl:27's
 *            own rendering for a countable-less depth (`{{if lt $sum 0}}-`).
 *   trace    NO source: the Workers runtime exposes no goroutine/process
 *            introspection and no landed port approximates the process
 *            manager. The page renders the honest-absence posture (below).
 *
 * ## DOM contract (templates/admin/*.tmpl at the pin)
 *
 * layout_head's pageClass is the literal `admin monitor` on every page. The
 * four pages render the layout verbatim: BaseLayout → the admin navbar
 * reduced to the monitor `<details class="item" open>` submenu
 * (navbar.tmpl:106-124, audit_logs omitted) → `.flex-container-main` →
 * `.admin-setting-content` with the template's `h4.ui.top.attached.header` +
 * `.ui.attached.table.segment` tables. stats.tmpl: two-column rows
 * (`<td width="200">{key}</td><td>{count}</td>`), header
 * `admin.dashboard.statistic` ("Summary"), keys sorted (admin.go:280-287).
 * cron.tmpl: the table lives INSIDE the run form (`method="post"`,
 * cron.tmpl:7-35) with the per-row `<button name="op" value="{name}"
 * title="Run">` glyph, columns Name/Schedule/Next Time/Previous
 * Time/Executions/Result, the Previous arm `-` until the first fire
 * (`{{if gt .Prev.Year 1}}`), the Result arm `—` while Status is empty and
 * the octicon-check / octicon-x pair (tooltip = the last message) when the
 * task HAS run (cron.tmpl:29), and the hidden `from=monitor`. queue.tmpl: reduced to the columns with landed
 * sources (Name/Type/Number in Queue — Exemplar Type and the worker counts
 * have no cf-gitea source) plus the per-queue Review link column and the
 * cf-gitea delivery-state breakdown segment; the links target the LANDED
 * manage page (the census gap-17 fold below). queue_manage.tmpl: the detail
 * table carries the same reduced columns; the remove-all-items form renders
 * ONLY on the one landed purge body (repo-tasks — the dead-control rule
 * narrows upstream's per-countable render); the DLQ's row is the
 * countable-less `-` arm (queue_manage.tmpl:29's own `{{if lt $sum 0}}`
 * posture); the Pool Settings form is OMITTED — no worker-pool knob, the
 * /set arm stays unclaimed. stacktrace.tmpl reduced to
 * the header + segment shape carrying the honest-absence note: no tabs, no
 * cancel `link-action`s, no diagnosis form (all dead without a source).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - audit_logs: omitted from the submenu AND the family — no landed audit
 *   store (the survey row's config/notices/auths/emails siblings are equally
 *   out of this module's scope).
 * - The cron run button POSTs the PAGE URL (`/-/admin/monitor/cron`), not
 *   upstream's dashboard target (`AppSubUrl + "/-/admin"`, cron.tmpl:7): the
 *   dashboard route is not landed and is a different family's mount. The POST
 *   answers upstream's DashboardPost posture reduced to the monitor arm: the
 *   flash message ("Started Task: %s" / "Unknown task: %s",
 *   admin.dashboard.task.*) re-renders the page (the no-JS hooks-page
 *   convention; upstream redirects back to monitor/cron with a flash).
 * - The run button renders ONLY on the run-capable rows (the five arms with
 *   landed run bodies — admin-degenerate.ts's CRON_RUN_BODIES posture):
 *   upstream renders one on every row because every registered task is
 *   runnable in its in-process scheduler; rendering ours for arms with no
 *   landed run body would POST into the task.unknown flash — the
 *   dead-control rule. The five actions-family census arms render an empty
 *   first cell.
 * - The Result cell renders upstream's THREE states from the recorded tick
 *   state: `—` while the arm never recorded (Status ""), the octicon-check
 *   after a completed tick ("finished"), the octicon-x with the stored
 *   one-liner as the tooltip after a failed entry ("error", cron.tmpl:29's
 *   data-tooltip-content arm — a plain attribute here, the Fomantic tooltip
 *   hydrates it client-side the same way). The manual run's tick rides the
 *   same store (upstream ExecTimes counts manual runs too, tasks.go:95-97).
 * - The delivery-state breakdown segment is a cf-gitea addition (marked in
 *   the locale block) — upstream's queue table has no per-state view, but the
 *   landed log carries the states and the depth number alone hides them.
 * - The trace page renders the note instead of goroutine/process counts and
 *   renders NONE of trace_tabs.tmpl: the perftrace tab is `!setting.IsProd`
 *   upstream (stacktrace.go:19) and has no source either; the diagnosis form
 *   POSTs an unlanded route. A rendered tab/form would be dead.
 * - The queue manage page's qid is the QUEUE NAME (upstream's numeric qid is
 *   the in-process registry id — no cf-gitea counterpart; the Cloudflare
 *   queue name is the landed identity, wrangler.jsonc's queues.producer).
 * - QueueSet's POST /{qid}/set stays UNCLAIMED: Cloudflare Queues expose no
 *   worker-pool knob (no Get/SetWorkerMaxNumber substrate), so the Pool
 *   Settings form renders nowhere and the route answers the engine's 404 —
 *   the queue-list's originally recorded posture for this arm.
 * - QueueRemoveAllItems lands for repo-tasks ONLY: its `queued|syncing` rows
 *   ARE the pipeline's in-flight set (a message dead-lettered into
 *   repo-tasks-dlq leaves its row stuck `queued` forever — repos/dlq.ts acks
 *   without touching D1, and the stuck-syncing sweep reclaims `syncing`
 *   only, mirror/sync.ts:846-853 — while the cron producer's due-SELECT
 *   reads `idle` rows alone), so the purge resets them to `idle` and the
 *   next tick re-enqueues the due ones: upstream's "remove all items to
 *   make it work again" (queue.go:71-74), depth back to 0. webhook-delivery
 *   gets NO purge arm: its queue items are the webhook_deliveries rows
 *   THEMSELVES (upstream's arm removes queue items while PRESERVING the
 *   hook_task log — ours cannot separate the two), and the pipeline
 *   self-heals (the DLQ sweep marks stuck rows failed,
 *   webhooks/consumer.ts:30-32). The DLQ answers the unknown-queue 404 too
 *   (known but unmanageable — no landed counter, no substrate); its GET
 *   detail still renders, the countable-less `-` arm with no form.
 * - self_check (web.go:785-786) and system_status (web.go:782) stay
 *   UNCLAIMED — the recorded postures stand: system_status's fragment has
 *   its only consumer in the 5s-morph dl the dashboard module does not
 *   render (pages/admin-dashboard.tsx card 3: "stays UNMOUNTED"); self_check
 *   's three checks (setting.StartupProblems, the DB collation pair,
 *   cache.Test) all have no cf-gitea source — no startup-problem store, D1/
 *   SQLite has no server-collation mismatch class (upstream's fix hints
 *   render only for MySQL/MSSQL, self_check.tmpl:21-25), no cache layer —
 *   so the page would assert "no problem found" without any check having
 *   run; the family navs already omit the item (the dead-link rule).
 *   perftrace and diagnosis stay unclaimed for the trace_tabs reason above.
 *
 * ## Mount record (MOUNTED at e31c0cf — the routes are live)
 *
 * Route table (`index.ts`): four GET claims in the
 * admin/monitor neighborhood, each shaped like the blocked-users pair minus
 * the POST (only cron has one):
 *
 *   GET /-/admin/monitor/stats    the admin gate (session resolveUiSession →
 *                                 non-admin 404 shell, anonymous → the login
 *                                 303 — verifyAuthWithOptionsWeb's posture)
 *                                 → loadAdminMonitorStats(db) →
 *                                 renderAdminMonitorStatsPage
 *   GET /-/admin/monitor/cron     gate → loadAdminMonitorCron(new Date()) →
 *                                 renderAdminMonitorCronPage({flash: null})
 *                                 (the SYNC census loader — the state-bearing
 *                                 swap to `await loadAdminMonitorCronRunState(
 *                                 c.env.DB, routeNow())` at both cron call
 *                                 sites is the disclosed ui/index.ts
 *                                 integration, outside this module's
 *                                 ownership; until it lands the page renders
 *                                 the full listing in the never-fired
 *                                 posture)
 *   POST /-/admin/monitor/cron    sameOriginGuard FIRST → gate →
 *                                 parseAdminMonitorCronForm(readUrlEncodedForm)
 *                                 → applyAdminMonitorCronForm(env, form) →
 *                                 re-render the fresh load at 200 with the
 *                                 flash (upstream redirects; the no-JS
 *                                 re-render is the keys-page convention —
 *                                 swap to a 303 if the flash-queue lands)
 *   GET /-/admin/monitor/queue    gate → loadAdminMonitorQueues(db) →
 *                                 renderAdminMonitorQueuePage
 *   GET /-/admin/monitor/stacktrace  gate → renderAdminMonitorTracePage
 *
 * The admin navbar is the admin family's ONE shared navbar (the mount
 * window's F7 fold — pages/admin-users.tsx AdminFamilyNav with the monitor
 * `active` values; the AdminMonitorNav scaffolding copy was DELETED — the
 * OrgSettingsBlockedNav precedent). Survey row touched on landing:
 * docs/compat/ui-parity-survey.md:386 (the `/-/admin/*` family row —
 * the monitor subset becomes PARTIAL).
 *
 * ## Queue-manage HANDOFF (census gap 17 — the claims are the ORCHESTRATOR's
 * fold; this module ships everything the fold wires, claim-ready)
 *
 * parseUiRoute's admin block, inside `tail[0] === "monitor"` AFTER the four
 * 2-segment arms (the literal `/queue` shadows the `{qid}` parse like
 * upstream's static-before-dynamic rule):
 *
 *     if (tail.length === 3 && tail[0] === "monitor" && tail[1] === "queue") {
 *       return { family: "admin-monitor-queue-manage", qid: tail[2] as string };
 *     }
 *     if (tail.length === 4 && tail[0] === "monitor" && tail[1] === "queue" && tail[2] === "remove-all-items") {
 *       return { family: "admin-monitor-queue-remove-all", qid: tail[3] as string };
 *     }
 *
 * (NO `/set` arm — the documented reduction above; the shape stays null →
 * the engine's 404.) Registrations beside adminMonitorCronSubmit, with the
 * module imports parseAdminMonitorQueueQid / loadAdminMonitorQueueDetail /
 * applyAdminMonitorQueueRemoveAllItems / renderAdminMonitorQueueManagePage:
 *
 *     async function adminMonitorQueueManage(c: Context<{ Bindings: Env }>, qidRaw: string): Promise<Response> {
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const qid = parseAdminMonitorQueueQid(qidRaw);
 *       const data = qid === null ? null : await loadAdminMonitorQueueDetail(c.env.DB, qid);
 *       if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404)); // upstream's nil-mq arm
 *       return p.respond(c.html(renderAdminMonitorQueueManagePage({ ctx: p.ctx, data, flash: null })));
 *     }
 *
 *     async function adminMonitorQueueRemoveAll(c: Context<{ Bindings: Env }>, qidRaw: string): Promise<Response> {
 *       const guard = sameOriginGuard(c.req.raw);
 *       if (guard !== null) return guard;
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const qid = parseAdminMonitorQueueQid(qidRaw);
 *       if (qid === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       const result = await applyAdminMonitorQueueRemoveAllItems(c.env.DB, qid);
 *       if (result.outcome === "unknown-queue") return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       const data = await loadAdminMonitorQueueDetail(c.env.DB, qid); // non-null in practice: the purge body proves registry membership
 *       if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       return p.respond(c.html(renderAdminMonitorQueueManagePage({ ctx: p.ctx, data, flash: { kind: "positive", text: result.message } })));
 *     }
 *
 *     uiRouter.get("/-/admin/monitor/queue/:qid", (c) => adminMonitorQueueManage(c, c.req.param("qid")));
 *     uiRouter.post("/-/admin/monitor/queue/:qid/remove-all-items", (c) => adminMonitorQueueRemoveAll(c, c.req.param("qid")));
 *
 * Pins that flip at the fold: index.test.ts's monitor-tail route pin (the
 * `/queue/{qid}` shape starts parsing); NOTHING in this module's tests pins
 * the new shape at the route level, so the fold breaks no test here. The
 * manage page renders the shared AdminFamilyNav with active="queue" —
 * upstream's QueueManage sets PageIsAdminMonitor (outside navbar.tmpl:107's
 * open-OR), leaving every item inactive and the group closed; the shared
 * nav's derived-open arm cannot express that posture without a new prop in
 * admin-users.tsx (outside this unit's ownership) — the divergence is
 * documented, not silent.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Child } from "hono/jsx";

import { enqueueDueAuditRetention } from "../../services/audit";
import { enqueueDueDemoSweeps } from "../../services/demo-sweep";
import { enqueueDueMirrorSyncs } from "../../services/mirror/sync";
import { enqueueDuePushMirrorSyncs } from "../../services/mirror/push-sync";
import { enqueueDuePackagesCleanup } from "../../services/packages/cleanup";
import { CRON_ARMS, listCronState, recordArmsSuccess, type CronStateRow } from "../../services/cron-state";
import {
  commitStatuses,
  comments,
  follows,
  issueAttachments,
  issues,
  labels,
  milestones,
  oauth2Applications,
  projectColumns,
  projects,
  publicKeys,
  releaseAssets,
  releases,
  repoMirrors,
  repoWatchers,
  repositories,
  stars,
  teams,
  users,
  webhookDeliveries,
  webhooks,
} from "../../db/schema";
import type { UiContext } from "../ui-context";
import { BaseLayout, Icon, renderPage } from "../shell";
import { AdminEmbeddedSvg, AdminFamilyNav } from "./admin-users";

// ---------------------------------------------------------------------------
// Page chrome + copy text (component-local, the orgSettingsBlockedLocale
// pattern — locale.ts is shared and not this wave's file; upstream locale
// keys cited, cf-gitea additions marked).
// ---------------------------------------------------------------------------

export const adminMonitorLocale = {
  /** The navbar menu header (navbar.tmpl:3) and the trace page's Title
   *  (stacktrace.go:17 — monitorTraceCommon sets `admin.monitor`). */
  settings: "Admin Settings", // "admin.settings"
  monitoring: "Monitoring", // "admin.monitor" — the submenu summary + trace Title
  stats: "Stats", // "admin.monitor.stats" — nav item + page Title
  cron: "Cron Tasks", // "admin.monitor.cron" — nav item + page Title
  queues: "Queues", // "admin.monitor.queues" — nav item + page Title
  trace: "Trace", // "admin.monitor.trace" — nav item
  // The stats table header (stats.tmpl:4) — "admin.dashboard.statistic".
  statistic: "Summary",
  // The cron table headers (cron.tmpl:12-17).
  name: "Name", // "admin.monitor.name"
  schedule: "Schedule", // "admin.monitor.schedule"
  next: "Next Time", // "admin.monitor.next"
  previous: "Previous Time", // "admin.monitor.previous"
  executeTimes: "Executions", // "admin.monitor.execute_times"
  lastResult: "Result", // "admin.monitor.last_execution_result"
  operationRun: "Run", // "admin.dashboard.operation_run" (the run button title)
  // The cron task name render (cron.tmpl:24 — `admin.dashboard.{Name}`).
  // Upstream's locale strings verbatim (options/locale/locale_en-US.json);
  // the three cf-gitea-extension arms (no upstream key exists) are marked.
  taskUpdateMirrors: "Update Mirrors", // "admin.dashboard.update_mirrors"
  taskUpdatePushMirrors: "Update Push Mirrors", // cf-gitea extension (update_mirrors's push twin)
  taskStopZombieTasks: "Stop actions zombie tasks", // "admin.dashboard.stop_zombie_tasks"
  taskStopEndlessTasks: "Stop actions endless tasks", // "admin.dashboard.stop_endless_tasks"
  taskDemoSweep: "Demo Sweep", // cf-gitea extension (SPEC-0014 — the producer's own log tag)
  taskDeleteOldAuditEvents: "Delete audit events older than the retention period", // "admin.dashboard.delete_old_audit_events"
  taskCleanupPackages: "Clean up expired packages", // "admin.dashboard.cleanup_packages"
  taskCleanupActions: "Clean up expired actions' resources", // "admin.dashboard.cleanup_actions"
  taskCancelAbandonedJobs: "Cancel actions abandoned jobs", // "admin.dashboard.cancel_abandoned_jobs"
  taskCleanupEphemeralRunners: "Clean up old ephemeral runners", // cf-gitea extension (no upstream key — upstream's own wrap text, cleanup.go:37)
  // The queue table headers (queue.tmpl:10-15, reduced to the sourced three).
  queueName: "Name", // "admin.monitor.queue.name"
  queueType: "Type", // "admin.monitor.queue.type"
  queueNumberInQueue: "Number in Queue", // "admin.monitor.queue.numberinqueue"
  // The queue manage page (queue_manage.tmpl; the census gap-17 fold).
  queueManageTitle: "Queue: %s", // "admin.monitor.queue" (queue.go:33 — %s = the queue name)
  queueReviewAdd: "Review / Add Workers", // "admin.monitor.queue.review_add" (queue.tmpl:28's link label)
  queueRemoveAll: "Remove all", // "admin.monitor.queue.settings.remove_all_items" (queue_manage.tmpl:34's button)
  queueRemoveAllDone: "All items in the queue have been removed.", // "admin.monitor.queue.settings.remove_all_items_done" (queue.go:87's flash)
  // cf-gitea addition — the manage page's reduction note (the module header's
  // adjudications: no set arm, webhook purge, DLQ purge).
  queueManageReductions:
    "Pool settings (worker counts) have no cf-gitea source: Cloudflare Queues grow and shrink without an in-process worker pool, so the settings form does not render. The webhook queue has no remove-all arm either: its queue items are the delivery log rows themselves, and upstream's purge preserves the log. The dead-letter queue has no landed counter (the - cell above) and no purge substrate.",
  // The run POST's flash texts (admin.go:188-190 DashboardPost — "%s" is the
  // task's locale name / the raw op).
  taskStarted: "Started Task: %s", // "admin.dashboard.task.started"
  taskUnknown: "Unknown task: %s", // "admin.dashboard.task.unknown"
  // cf-gitea additions — the honest-absence answers (the module header):
  // the trace page's source-less render and the queue section's landed
  // delivery-state breakdown title.
  traceUnavailable:
    "Trace data is not available: the Workers runtime exposes no goroutine or process introspection, so the upstream stacktrace list (runtime.NumGoroutine + the process manager) has no cf-gitea source.",
  deliveryStates: "Webhook delivery states",
} as const;

/** The monitor submenu's live items (the shared AdminFamilyNav's monitor
 *  `active` union — the AdminMonitorPage values verbatim). */
export type AdminMonitorPage = "stats" | "cron" | "queue" | "trace";

// ---------------------------------------------------------------------------
// The admin navbar (navbar.tmpl:106-124 — the F7 fold: the family's ONE
// shared navbar, pages/admin-users.tsx AdminFamilyNav; the module-local
// AdminMonitorNav copy was deleted). Upstream keeps the Monitoring details
// `open` only on monitor pages — which the `active` prop always is for this
// module's four pages, so the shared nav's derived-open arm reproduces the
// template here. The audit_logs item is OMITTED (no landed store — the
// dead-link rule).
// ---------------------------------------------------------------------------

/** The layout shell (layout_head.tmpl verbatim around the content block):
 *  the `admin monitor` pageClass, the fluid padded flex container, the
 *  family navbar, then `.flex-container-main` wrapping `.admin-setting-
 *  content` (every monitor template opens it, e.g. queue.tmpl:2). */
function AdminMonitorShell(props: {
  ctx: UiContext;
  title: string;
  active: AdminMonitorPage;
  children: Child;
}) {
  return (
    <BaseLayout ctx={props.ctx} title={props.title} pageClass="admin monitor">
      <div class="ui container fluid padded flex-container">
        <AdminFamilyNav active={props.active} />
        <div class="flex-container-main">
          <div class="admin-setting-content">{props.children}</div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// Stats (GET /-/admin/monitor/stats — stats.tmpl over GetStatistic's landed-
// table subset)
// ---------------------------------------------------------------------------

/** The stats table's render inputs: upstream's sorted `StatsKeys` +
 *  `StatsCounter` pair flattened into ordered [key, count] entries
 *  (admin.go:273-288). */
export interface AdminMonitorStatsData {
  stats: Array<[string, number]>;
}

/**
 * The landed-table subset of GetStatistic (models/activities/statistic.go)
 * under upstream's EXACT counter key names, sorted like MonitorStats's
 * `sort.Strings` (admin.go:287). Every count is a landed-table read through
 * Drizzle — the omissions are the counter fields with NO landed table (the
 * module header's list), never zeros standing in for them.
 */
export async function loadAdminMonitorStats(d1: D1Database): Promise<AdminMonitorStatsData> {
  const db = drizzle(d1);
  const [
    usersActive,
    usersNotActive,
    org,
    publicKey,
    repo,
    watch,
    star,
    issueRows,
    comment,
    oauth,
    follow,
    mirror,
    release,
    webhook,
    hookTask,
    milestone,
    label,
    team,
    project,
    projectColumn,
    attachmentRows,
    commitStatus,
  ] = await Promise.all([
    // UsersActive / UsersNotActive — CountUserFilter IsActive over USER rows
    // only (upstream counts user_table users; orgs are the separate Org
    // counter). The landed users.status enum folds upstream's IsActive +
    // ProhibitLogin (the admin-t2 conflation, its header's sixth deviation).
    db.select({ n: sql<number>`count(*)` }).from(users).where(and(eq(users.type, "user"), eq(users.status, "active"))).get(),
    db.select({ n: sql<number>`count(*)` }).from(users).where(and(eq(users.type, "user"), eq(users.status, "prohibited"))).get(),
    db.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.type, "org")).get(),
    db.select({ n: sql<number>`count(*)` }).from(publicKeys).get(),
    db.select({ n: sql<number>`count(*)` }).from(repositories).get(),
    db.select({ n: sql<number>`count(*)` }).from(repoWatchers).get(),
    db.select({ n: sql<number>`count(*)` }).from(stars).get(),
    // IssueOpen/IssueClosed — the is_closed GROUP BY (statistic.go:108-120),
    // one query; Issue = the sum (statistic.go:122).
    db.select({ closed: issues.isClosed, n: sql<number>`count(*)` }).from(issues).groupBy(issues.isClosed).all(),
    db.select({ n: sql<number>`count(*)` }).from(comments).get(),
    // Upstream hardcodes Oauth = 0 (statistic.go:104); the landed
    // oauth2_applications table can answer the real count — the same shape,
    // strictly more informative (the module header's divergence note).
    db.select({ n: sql<number>`count(*)` }).from(oauth2Applications).get(),
    db.select({ n: sql<number>`count(*)` }).from(follows).get(),
    db.select({ n: sql<number>`count(*)` }).from(repoMirrors).get(),
    db.select({ n: sql<number>`count(*)` }).from(releases).get(),
    db.select({ n: sql<number>`count(*)` }).from(webhooks).get(),
    // HookTask — upstream's hook_task delivery log; ours is
    // webhook_deliveries (SPEC-0005 §3.5-3.6's log, 1:1 concept).
    db.select({ n: sql<number>`count(*)` }).from(webhookDeliveries).get(),
    db.select({ n: sql<number>`count(*)` }).from(milestones).get(),
    db.select({ n: sql<number>`count(*)` }).from(labels).get(),
    db.select({ n: sql<number>`count(*)` }).from(teams).get(),
    db.select({ n: sql<number>`count(*)` }).from(projects).get(),
    db.select({ n: sql<number>`count(*)` }).from(projectColumns).get(),
    // Attachment — upstream's ONE attachments table serves issues AND
    // releases; SPEC-0005 split it (issue_attachments + release_assets), so
    // the counter is the sum.
    Promise.all([
      db.select({ n: sql<number>`count(*)` }).from(issueAttachments).get(),
      db.select({ n: sql<number>`count(*)` }).from(releaseAssets).get(),
    ]),
    db.select({ n: sql<number>`count(*)` }).from(commitStatuses).get(),
  ]);
  let issueOpen = 0;
  let issueClosed = 0;
  for (const row of issueRows) {
    if (row.closed) issueClosed += row.n;
    else issueOpen += row.n;
  }
  const stats: Array<[string, number]> = [
    ["Attachment", (attachmentRows[0]?.n ?? 0) + (attachmentRows[1]?.n ?? 0)],
    ["Comment", comment?.n ?? 0],
    ["CommitStatus", commitStatus?.n ?? 0],
    ["Follow", follow?.n ?? 0],
    ["HookTask", hookTask?.n ?? 0],
    ["Issue", issueOpen + issueClosed],
    ["IssueClosed", issueClosed],
    ["IssueOpen", issueOpen],
    ["Label", label?.n ?? 0],
    ["Milestone", milestone?.n ?? 0],
    ["Mirror", mirror?.n ?? 0],
    ["Oauth", oauth?.n ?? 0],
    ["Org", org?.n ?? 0],
    ["Project", project?.n ?? 0],
    ["ProjectColumn", projectColumn?.n ?? 0],
    ["PublicKey", publicKey?.n ?? 0],
    ["Release", release?.n ?? 0],
    ["Repo", repo?.n ?? 0],
    ["Star", star?.n ?? 0],
    ["Team", team?.n ?? 0],
    ["UsersActive", usersActive?.n ?? 0],
    ["UsersNotActive", usersNotActive?.n ?? 0],
    ["Watch", watch?.n ?? 0],
    ["Webhook", webhook?.n ?? 0],
  ];
  return { stats };
}

/** The stats page (stats.tmpl verbatim: the Summary header + the two-column
 *  `width="200"` key rows, keys already sorted by the loader). */
export function AdminMonitorStatsPage(props: { ctx: UiContext; data: AdminMonitorStatsData }) {
  return (
    <AdminMonitorShell ctx={props.ctx} title={adminMonitorLocale.stats} active="stats">
      <h4 class="ui top attached header">{adminMonitorLocale.statistic}</h4>
      <div class="ui attached table segment">
        <table class="ui very basic table unstackable">
          {props.data.stats.map(([key, count]) => (
            <tr>
              <td width="200">{key}</td>
              <td>{count}</td>
            </tr>
          ))}
        </table>
      </div>
    </AdminMonitorShell>
  );
}

export function renderAdminMonitorStatsPage(options: { ctx: UiContext; data: AdminMonitorStatsData }): string {
  return renderPage(<AdminMonitorStatsPage ctx={options.ctx} data={options.data} />);
}

// ---------------------------------------------------------------------------
// Cron (GET /-/admin/monitor/cron — cron.tmpl over the landed cron registry)
// ---------------------------------------------------------------------------

/** One rendered cron row — the landed arm's render inputs (the Cron struct
 *  render, modules/structs/cron.go's five fields, PLUS the recorded tick
 *  state upstream keeps in process memory): `prev` null = the never-fired
 *  arm (cron.tmpl:27 renders `-` while `.Prev.Year < 2`), `execTimes` 0 =
 *  no completed tick recorded, `result.status` "none" = the empty Status
 *  (cron.tmpl:29's `—`). */
export interface AdminMonitorCronEntry {
  /** The arm's registry name (CRON_ARMS — upstream's task name where a
   *  faithful twin exists; the run form's `op` value). */
  name: string;
  /** The wrangler-declared trigger expression — rendered verbatim. */
  spec: string;
  /** The next UTC firing; null only for a spec the parser families cannot
   *  read — the zero-time render, never a wrong time. */
  next: Date | null;
  /** The last COMPLETED tick (cron_state.last_success); null = never. */
  prev: Date | null;
  /** Completed ticks recorded for the arm (manual runs included). */
  execTimes: number;
  /** The Result cell's triple (cron.tmpl:29): "none" → the em dash,
   *  "finished" → the check glyph, "error" → the x glyph with the stored
   *  one-liner as the tooltip. */
  result: { status: "none" | "finished" | "error"; message: string | null; at: Date | null };
  /** Whether the run button renders (the landed run-capable subset — the
   *  module header's reduction; false rows render an empty first cell). */
  runnable: boolean;
}

/**
 * The minute-step subset of cron expressions (a star-slash-N minute field
 * followed by `* * * * *`) → the step in minutes. (admin-degenerate.ts's
 * private parser mirrored — both registries render the census's next-fire
 * triple from the same two landed spec families.)
 */
function minuteStepMinutes(spec: string): number | null {
  if (spec === "* * * * *") {
    return 1;
  }
  const match = /^\*\/(\d+) \* \* \* \*$/.exec(spec);
  if (match === null) {
    return null;
  }
  const step = Number.parseInt(match[1] ?? "", 10);
  return step >= 1 ? step : null;
}

/**
 * The exact-minute-hourly family (`M * * * *`, 0-59) → the minute. The
 * hourly entry's landed spec (`0 * * * *`) needs it — the minute-step
 * parser deliberately rejects it (never a wrong guess).
 */
function hourlyEntryMinute(spec: string): number | null {
  const match = /^(\d{1,2}) \* \* \* \*$/.exec(spec);
  if (match === null) {
    return null;
  }
  const minute = Number.parseInt(match[1] ?? "", 10);
  return minute >= 0 && minute <= 59 ? minute : null;
}

/** The next UTC firing of a minute-step spec after `from` (Cloudflare cron
 *  triggers fire at UTC minute boundaries; on a boundary the NEXT step is
 *  returned — admin-degenerate.ts's nextMinuteStepFire mirrored). */
function nextMinuteStepFire(stepMinutes: number, from: Date): Date {
  const next = new Date(from.getTime());
  next.setUTCSeconds(0, 0);
  const remainder = next.getUTCMinutes() % stepMinutes;
  next.setUTCMinutes(next.getUTCMinutes() + (remainder === 0 ? stepMinutes : stepMinutes - remainder));
  return next;
}

/** The next UTC firing of an exact-minute-hourly spec after `from` (the
 *  same boundary convention: ON the firing minute the NEXT hour returns). */
function nextHourlyFire(minute: number, from: Date): Date {
  const next = new Date(from.getTime());
  next.setUTCMinutes(minute, 0, 0);
  if (next.getTime() <= from.getTime()) {
    next.setUTCHours(next.getUTCHours() + 1);
  }
  return next;
}

/** The supported families' dispatch — null renders the zero time (never a
 *  wrong time, the parser's own posture for an unsupported future spec). */
function nextFireForSpec(spec: string, from: Date): Date | null {
  const step = minuteStepMinutes(spec);
  if (step !== null) {
    return nextMinuteStepFire(step, from);
  }
  const minute = hourlyEntryMinute(spec);
  if (minute !== null) {
    return nextHourlyFire(minute, from);
  }
  return null;
}

/**
 * The runnable arms' producer dispatch — admin-degenerate.ts's CRON_RUN_BODIES
 * mirrored verbatim, each value the scheduled dispatcher's EXACT producer call
 * (demo-sweep.ts handleScheduledCron — "run = enqueue", "crons enqueue,
 * consumers do the work"); the injected `now` rides the options object every
 * producer accepts. The run button renders ONLY for these arms (the set below
 * derives from this map, so the render gate and the apply dispatch can never
 * drift); the five actions-family census arms (stop_zombie_tasks,
 * cleanup_actions, stop_endless_tasks, cancel_abandoned_jobs,
 * cleanup_ephemeral_runners) stay absent — their producer modules live in
 * services/actions/** (an in-flight sibling's ownership), and a
 * listed-but-unrunnable arm's op answers the task.unknown flash exactly like
 * an unknown one — never a dead control. Extending run capability = extending
 * this map (and the API registry's CRON_RUN_BODIES) in one change.
 */
type CronRunBody = (env: Env, options: { now?: Date }) => Promise<number>;

const CRON_RUN_BODIES: Readonly<Record<string, CronRunBody>> = {
  update_mirrors: (env, options) => enqueueDueMirrorSyncs(env, { now: options.now }),
  update_push_mirrors: (env, options) => enqueueDuePushMirrorSyncs(env, { now: options.now }),
  demo_sweep: (env, options) => enqueueDueDemoSweeps(env, { now: options.now }),
  delete_old_audit_events: (env, options) => enqueueDueAuditRetention(env, { now: options.now }),
  cleanup_packages: (env, options) => enqueueDuePackagesCleanup(env, { now: options.now }),
};

/** The run-capable subset — the dispatch map's keys (never drifts apart). */
const RUNNABLE_CRON_ARMS: ReadonlySet<string> = new Set(Object.keys(CRON_RUN_BODIES));

/** The registry mirror's source — CRON_ARMS (services/cron-state.ts) is the
 *  single census (the scheduled handler's recorder keys the same names, so
 *  a monitor row and its tick row can never drift apart). */
const MONITOR_CRON_TASKS = CRON_ARMS;

/**
 * The landed cron task registry render — the FULL arm census (the module
 * header's F3 listing) in the never-fired posture: prev null, execTimes 0,
 * result "none". The tick state rides `loadAdminMonitorCronRunState`; this
 * sync loader is the shape ui/index.ts's route call sites use until their
 * two-line swap (the mount record).
 */
export function loadAdminMonitorCron(now: Date): { entries: AdminMonitorCronEntry[] } {
  return {
    entries: MONITOR_CRON_TASKS.map((task) => ({
      name: task.arm,
      spec: task.spec,
      next: nextFireForSpec(task.spec, now),
      prev: null,
      execTimes: 0,
      result: { status: "none", message: null, at: null },
      runnable: RUNNABLE_CRON_ARMS.has(task.arm),
    })),
  };
}

/**
 * The state-bearing loader (the route's swap target): the same census with
 * the `cron_state` rows merged over it — prev/Executions from the recorded
 * successes, the Result triple from the recorded error (a completed tick
 * after a failed one REPLACES the error posture: status follows the LAST
 * recorded tick, exactly upstream's single Status field). An arm without a
 * row keeps the never-fired posture (a fresh deployment, the golden
 * harness). One point scan of a ≤10-row table.
 */
export async function loadAdminMonitorCronRunState(
  db: D1Database,
  now: Date,
): Promise<{ entries: AdminMonitorCronEntry[] }> {
  const base = loadAdminMonitorCron(now);
  const state: Map<string, CronStateRow> = await listCronState(db);
  return {
    entries: base.entries.map((entry) => {
      const row = state.get(entry.name);
      if (row === undefined) {
        return entry;
      }
      // The last recorded tick decides the posture: a failure stamps the
      // error pair WITHOUT moving last_success (the store's granularity
      // note), so lastErrorUnix > lastSuccess ⇔ the error IS the last tick.
      const failedLast = row.lastErrorUnix !== null && (row.lastSuccess === null || row.lastErrorUnix > row.lastSuccess);
      return {
        ...entry,
        prev: row.lastSuccess,
        execTimes: row.runs,
        result: failedLast
          ? { status: "error", message: row.lastError, at: row.lastErrorUnix }
          : row.lastSuccess !== null
            ? { status: "finished", message: null, at: null }
            : { status: "none", message: null, at: null },
      };
    }),
  };
}

/** The task's rendered name (cron.tmpl:24 — the `admin.dashboard.{Name}`
 *  locale key; unknown names fall back to the raw op, DashboardPost's
 *  task.unknown arm carries the raw value too). */
function taskDisplayName(name: string): string {
  switch (name) {
    case "update_mirrors":
      return adminMonitorLocale.taskUpdateMirrors;
    case "update_push_mirrors":
      return adminMonitorLocale.taskUpdatePushMirrors;
    case "stop_zombie_tasks":
      return adminMonitorLocale.taskStopZombieTasks;
    case "stop_endless_tasks":
      return adminMonitorLocale.taskStopEndlessTasks;
    case "demo_sweep":
      return adminMonitorLocale.taskDemoSweep;
    case "delete_old_audit_events":
      return adminMonitorLocale.taskDeleteOldAuditEvents;
    case "cleanup_packages":
      return adminMonitorLocale.taskCleanupPackages;
    case "cleanup_actions":
      return adminMonitorLocale.taskCleanupActions;
    case "cancel_abandoned_jobs":
      return adminMonitorLocale.taskCancelAbandonedJobs;
    case "cleanup_ephemeral_runners":
      return adminMonitorLocale.taskCleanupEphemeralRunners;
    default:
      return name;
  }
}

/** Upstream `DateUtils.FullTime` — "Jan 01, 2006 20:33:44" (util_date.go:33),
 *  UTC hand-rolled (the formatTokenDate precedent). */
export function formatMonitorFullTime(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${months[date.getUTCMonth()]} ${pad(date.getUTCDate())}, ${date.getUTCFullYear()} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** The parsed cron POST (cron.tmpl's per-row run button + the hidden
 *  `from=monitor`, cron.tmpl:23,34): `op` null = a failed binding — the arm
 *  this DOM never emits. */
export interface AdminMonitorCronForm {
  op: string | null;
  from: string;
}

export function parseAdminMonitorCronForm(params: URLSearchParams): AdminMonitorCronForm {
  const op = params.get("op") ?? "";
  return { op: op === "" ? null : op, from: params.get("from") ?? "" };
}

export type AdminMonitorCronResult =
  | { outcome: "applied"; message: string }
  | { outcome: "invalid"; message: string };

/**
 * The cron run (upstream DashboardPost's task arm, admin.go:186-191,
 * reduced to the landed run bodies): the known task executes the EXACT body
 * the landed `POST /admin/cron/{task}` serves (the CRON_RUN_BODIES dispatch —
 * admin-degenerate.ts's registry mirrored, the API handler's lookup shape —
 * "run = enqueue", the admin-degenerate posture) and answers the
 * task.started flash; an unknown — or listed-but-unrunnable — task answers
 * task.unknown WITHOUT running anything (upstream's flash-error arm). A
 * failed binding (`op` absent) is the unknown arm's funnel (the
 * binding-failure convention).
 *
 * The manual run RECORDS ITS TICK (cron_state, the run arm's row):
 * upstream's ExecTimes counts run STARTS on the shared RunWithUser path —
 * the dashboard trigger included (tasks.go:95-97) — and the recorded
 * success clears any standing error, so the monitor's row reflects a
 * human-triggered run exactly like a scheduled one. The recording is
 * log-and-continue: a failed tick write never fails the run's flash (the
 * enqueue already happened; the scheduled handler's own tick will refresh
 * the row on the next entry).
 */
export async function applyAdminMonitorCronForm(
  env: Env,
  form: AdminMonitorCronForm,
  options: { now?: Date } = {},
): Promise<AdminMonitorCronResult> {
  // The run-capable gate (CRON_RUN_BODIES — the landed run bodies, the API
  // twin's handler lookup), NOT census membership: a listed-but-unrunnable
  // arm must answer task.unknown exactly like an unknown op (upstream's
  // flash-error arm), never run the wrong body.
  const op = form.op;
  if (op === null) {
    return { outcome: "invalid", message: adminMonitorLocale.taskUnknown.replace("%s", "") };
  }
  const run = CRON_RUN_BODIES[op];
  if (run === undefined) {
    return { outcome: "invalid", message: adminMonitorLocale.taskUnknown.replace("%s", op) };
  }
  await run(env, { now: options.now });
  const arm = CRON_ARMS.find((entry) => entry.arm === op);
  if (arm !== undefined) {
    await recordArmsSuccess(env.DB, [arm], options).catch((recordError: unknown) => {
      console.error("[cron-state] manual run tick not recorded", recordError);
    });
  }
  return { outcome: "applied", message: adminMonitorLocale.taskStarted.replace("%s", taskDisplayName(op)) };
}

/** The cron page (cron.tmpl verbatim: the table lives INSIDE the run form;
 *  the POST target is the PAGE URL — the module header's divergence note).
 *  `flash` is the no-JS POST answer banner (the hooks-page convention). */
export function AdminMonitorCronPage(props: {
  ctx: UiContext;
  data: { entries: AdminMonitorCronEntry[] };
  flash: { kind: "positive" | "negative"; text: string } | null;
}) {
  const pageLink = "/-/admin/monitor/cron";
  return (
    <AdminMonitorShell ctx={props.ctx} title={adminMonitorLocale.cron} active="cron">
      <h4 class="ui top attached header">{adminMonitorLocale.cron}</h4>
      <div class="ui attached table segment">
        <form method="post" action={pageLink}>
          {props.flash !== null ? <div class={`ui ${props.flash.kind} message`}>{props.flash.text}</div> : null}
          <table class="ui very basic table unstackable tw-mb-0">
            <thead>
              <tr>
                <th scope="col"></th>
                <th scope="col">{adminMonitorLocale.name}</th>
                <th scope="col">{adminMonitorLocale.schedule}</th>
                <th scope="col">{adminMonitorLocale.next}</th>
                <th scope="col">{adminMonitorLocale.previous}</th>
                <th scope="col">{adminMonitorLocale.executeTimes}</th>
                <th scope="col">{adminMonitorLocale.lastResult}</th>
              </tr>
            </thead>
            <tbody>
              {props.data.entries.map((entry) => (
                <tr>
                  <td>
                    {/* The run button (cron.tmpl:23) — ONLY on the
                        run-capable row (the module header's reduction: a
                        button for a bodyless arm would POST into
                        task.unknown — the dead-control rule); the other
                        rows render the empty first cell. octicon-triangle-
                        right is outside the generated icon allowlist —
                        octicon-clock is the documented stand-in (the
                        feeds-glyph convention). */}
                    {entry.runnable ? (
                      <button type="submit" class="ui primary button" name="op" value={entry.name} title={adminMonitorLocale.operationRun}>
                        <Icon name="octicon-clock" />
                      </button>
                    ) : null}
                  </td>
                  <td>{taskDisplayName(entry.name)}</td>
                  <td>{entry.spec}</td>
                  <td>{entry.next === null ? "-" : formatMonitorFullTime(entry.next)}</td>
                  {/* cron.tmpl:27 — `-` while Prev.Year < 2 (never fired). */}
                  <td>{entry.prev === null ? "-" : formatMonitorFullTime(entry.prev)}</td>
                  <td>{entry.execTimes}</td>
                  {/* cron.tmpl:29 — the em dash while Status is empty;
                      otherwise the check (finished) / x (error, tooltip =
                      the stored one-liner) glyph pair. octicon-check is
                      allowlisted; octicon-x rides the AdminEmbeddedSvg
                      arm (the admin-emails check/x cell precedent). */}
                  {entry.result.status === "none" ? (
                    <td>—</td>
                  ) : entry.result.status === "finished" ? (
                    <td>
                      <Icon name="octicon-check" />
                    </td>
                  ) : (
                    <td data-tooltip-content={entry.result.message ?? ""}>
                      <AdminEmbeddedSvg name="octicon-x" />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <input type="hidden" name="from" value="monitor" />
        </form>
      </div>
    </AdminMonitorShell>
  );
}

export function renderAdminMonitorCronPage(options: {
  ctx: UiContext;
  data: { entries: AdminMonitorCronEntry[] };
  flash: { kind: "positive" | "negative"; text: string } | null;
}): string {
  return renderPage(
    <AdminMonitorCronPage ctx={options.ctx} data={options.data} flash={options.flash} />,
  );
}

// ---------------------------------------------------------------------------
// Queues (GET /-/admin/monitor/queue — queue.tmpl reduced to the landed
// depth sources; the manage page/set-workers/remove-arms are not rendered)
// ---------------------------------------------------------------------------

/** One rendered queue row. `inQueue` null = no landed counter for the
 *  queue's depth — the `-` arm (queue.tmpl:27's own countable-less render). */
export interface AdminMonitorQueueRow {
  /** The Cloudflare Queue name (wrangler.jsonc queues.producer). */
  name: string;
  /** The queue driver type — upstream renders the Go driver ("level",
   *  "channel"); ours is cloudflare's managed queue for every row. */
  type: string;
  inQueue: number | null;
}

/** The queues page's render inputs: the queue rows plus the webhook delivery
 *  log's per-state breakdown (the cf-gitea segment — the module header). */
export interface AdminMonitorQueuesData {
  queues: AdminMonitorQueueRow[];
  deliveryStates: Array<[string, number]>;
}

/**
 * The landed depth sources over the landed queues (wrangler.jsonc
 * queues.producer + consumers):
 *
 *   webhook-delivery       in-flight = webhook_deliveries rows in
 *                          `pending|delivering` — a row exists per queued
 *                          message (§3.5 step 3) and leaves the in-flight set
 *                          exactly when the consumer records the outcome.
 *   repo-tasks             the mirror producer's arm: repo_mirrors rows in
 *                          `queued|syncing` (§2.6 — idle→queued at enqueue,
 *                          queued→syncing at claim, →idle on settle). The
 *                          queue also carries purge tombstones, whose state
 *                          lives in DO storage, not D1 — the counter covers
 *                          the mirror arm only (the module header's note).
 *   webhook-delivery-dlq   no landed counter (a poisoned message only lands
 *                          here after the outcome write failed — the D1 log
 *                          cannot see it) → the `-` arm.
 */
/** The landed depth scan shared by the list + detail loaders (ONE copy of
 *  the derivations — the no-duplicate rule): two grouped counts over the
 *  webhook delivery log and the pull-mirror producer's state machine. */
async function queueDepthByState(db: ReturnType<typeof drizzle>): Promise<{
  deliveryByState: Map<string, number>;
  mirrorByState: Map<string, number>;
}> {
  const [deliveryRows, mirrorRows] = await Promise.all([
    db.select({ state: webhookDeliveries.state, n: sql<number>`count(*)` }).from(webhookDeliveries).groupBy(webhookDeliveries.state).all(),
    db.select({ state: repoMirrors.syncState, n: sql<number>`count(*)` }).from(repoMirrors).groupBy(repoMirrors.syncState).all(),
  ]);
  return {
    deliveryByState: new Map(deliveryRows.map((row) => [row.state, row.n])),
    mirrorByState: new Map(mirrorRows.map((row) => [row.state, row.n])),
  };
}

/** The landed queue registry rows from the depth scan (the list's three rows
 *  AND the manage page's known names — one registry copy; the qid identity
 *  is the queue name, the module header's divergence note). */
function landedQueueRows(depth: {
  deliveryByState: Map<string, number>;
  mirrorByState: Map<string, number>;
}): AdminMonitorQueueRow[] {
  return [
    {
      name: "webhook-delivery",
      type: "cloudflare-queue",
      inQueue: (depth.deliveryByState.get("pending") ?? 0) + (depth.deliveryByState.get("delivering") ?? 0),
    },
    {
      name: "repo-tasks",
      type: "cloudflare-queue",
      inQueue: (depth.mirrorByState.get("queued") ?? 0) + (depth.mirrorByState.get("syncing") ?? 0),
    },
    { name: "webhook-delivery-dlq", type: "cloudflare-queue", inQueue: null },
  ];
}

export async function loadAdminMonitorQueues(d1: D1Database): Promise<AdminMonitorQueuesData> {
  const db = drizzle(d1);
  const depth = await queueDepthByState(db);
  // The schema enum's five states, rendered in lifecycle order, zeros
  // included (the log's full posture — the breakdown is the point).
  const deliveryStates: Array<[string, number]> = [
    ["pending", depth.deliveryByState.get("pending") ?? 0],
    ["delivering", depth.deliveryByState.get("delivering") ?? 0],
    ["delivered", depth.deliveryByState.get("delivered") ?? 0],
    ["skipped", depth.deliveryByState.get("skipped") ?? 0],
    ["failed", depth.deliveryByState.get("failed") ?? 0],
  ];
  return { queues: landedQueueRows(depth), deliveryStates };
}

/** The queues page (queue.tmpl reduced to the sourced columns plus the
 *  Review link column — queue.tmpl:28, every row links its manage page; all
 *  three detail pages render) plus the cf-gitea delivery-state segment. */
export function AdminMonitorQueuePage(props: { ctx: UiContext; data: AdminMonitorQueuesData }) {
  return (
    <AdminMonitorShell ctx={props.ctx} title={adminMonitorLocale.queues} active="queue">
      <h4 class="ui top attached header">{adminMonitorLocale.queues}</h4>
      <div class="ui attached table segment">
        <table class="ui very basic table unstackable">
          <thead>
            <tr>
              <th scope="col">{adminMonitorLocale.queueName}</th>
              <th scope="col">{adminMonitorLocale.queueType}</th>
              <th scope="col">{adminMonitorLocale.queueNumberInQueue}</th>
              {/* queue.tmpl:16's unnamed link column. */}
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {props.data.queues.map((queue) => (
              <tr>
                <td>{queue.name}</td>
                <td>{queue.type}</td>
                <td>{queue.inQueue === null ? "-" : queue.inQueue}</td>
                <td>
                  {/* queue.tmpl:28 — the Review link to the manage page
                      (`$.Link` = /-/admin/monitor/queue, the qid appended). */}
                  <a href={`/-/admin/monitor/queue/${queue.name}`} class="button">
                    {adminMonitorLocale.queueReviewAdd}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The cf-gitea addition — the landed log's per-state breakdown (the
          module header): the depth number alone hides the posture. */}
      <h4 class="ui top attached header">{adminMonitorLocale.deliveryStates}</h4>
      <div class="ui attached table segment">
        <table class="ui very basic table unstackable">
          {props.data.deliveryStates.map(([state, count]) => (
            <tr>
              <td width="200">{state}</td>
              <td>{count}</td>
            </tr>
          ))}
        </table>
      </div>
    </AdminMonitorShell>
  );
}

export function renderAdminMonitorQueuePage(options: { ctx: UiContext; data: AdminMonitorQueuesData }): string {
  return renderPage(<AdminMonitorQueuePage ctx={options.ctx} data={options.data} />);
}

// ---------------------------------------------------------------------------
// Queue manage (GET /-/admin/monitor/queue/{qid} + POST {qid}/remove-all-items
// — queue_manage.tmpl reduced; the /set arm has no landed substrate — the
// module header's adjudications. CLAIM-READY: the parse/registration recipe
// is the header's HANDOFF section — ui/index.ts is the orchestrator's fold.)
// ---------------------------------------------------------------------------

/** The manage page's render inputs: the registry row (the qid resolved) plus
 *  whether the remove-all-items form renders. */
export interface AdminMonitorQueueDetailData {
  queue: AdminMonitorQueueRow;
  /** A landed purge body exists for this queue (the dead-control rule
   *  narrows upstream's per-countable form render to the purgeable rows). */
  purgeable: boolean;
}

/**
 * The landed purge bodies — QueueRemoveAllItems's registry arm (queue.go:71),
 * one entry per queue whose in-flight set the D1 substrate can actually
 * clear; the render gate AND the apply dispatch derive from this map so they
 * can never drift (the CRON_RUN_BODIES posture). Exactly one landed body:
 *
 *   repo-tasks  reset `queued|syncing` → `idle` (the CAS shapes of
 *               services/mirror/sync.ts): a message dead-lettered into
 *               repo-tasks-dlq leaves its row stuck `queued` forever
 *               (repos/dlq.ts acks without touching D1) and only an idle
 *               row re-enters the cron producer's due-SELECT, so this reset
 *               IS the pipeline's "make it work again" arm — the next tick
 *               re-enqueues the due rows. `nextSyncAt` is untouched (the
 *               failure arm's posture: a due row retries on the next cron).
 *               The depth contract decides the WHERE: upstream counts base-
 *               queue items only and its purge shows 0 while on-the-fly
 *               items exist; our rendered depth counts queued+syncing, so
 *               the purge clears both.
 *
 * webhook-delivery and webhook-delivery-dlq stay absent — the module
 * header's adjudication (the delivery queue's items are the log rows;
 * upstream's purge preserves the log; the DLQ has no landed substrate).
 */
type QueuePurgeBody = (d1: D1Database) => Promise<void>;

const QUEUE_PURGE_BODIES: Readonly<Record<string, QueuePurgeBody>> = {
  "repo-tasks": (d1) =>
    drizzle(d1)
      .update(repoMirrors)
      .set({ syncState: "idle", updatedAt: new Date() })
      .where(inArray(repoMirrors.syncState, ["queued", "syncing"]))
      .run()
      .then(() => undefined),
};

/**
 * The manage page's qid path segment (the route passes the raw segment —
 * the orchestrator's fold). Decode failure → null, the engine's 404 funnel
 * (the org-members parse's posture).
 */
export function parseAdminMonitorQueueQid(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * QueueManage over the landed registry (queue.go:26): the qid resolves
 * against the SAME three rows the list renders (one registry copy —
 * landedQueueRows); an unknown name answers null → the route's 404
 * (upstream's nil GetManagedQueue arm, queue.go:29-32). The DLQ resolves
 * too — its detail renders the countable-less `-` arm with no form
 * (queue_manage.tmpl:29's own `{{if lt $sum 0}}` posture). Two point scans
 * of the same two grouped counts.
 */
export async function loadAdminMonitorQueueDetail(
  d1: D1Database,
  qid: string,
): Promise<AdminMonitorQueueDetailData | null> {
  const db = drizzle(d1);
  const depth = await queueDepthByState(db);
  const queue = landedQueueRows(depth).find((row) => row.name === qid);
  if (queue === undefined) {
    return null;
  }
  return { queue, purgeable: QUEUE_PURGE_BODIES[qid] !== undefined };
}

export type AdminMonitorQueueRemoveAllResult =
  | { outcome: "applied"; message: string }
  | { outcome: "unknown-queue" };

/**
 * QueueRemoveAllItems (queue.go:71-89) over the landed purge bodies: the
 * known-and-purgeable queue executes its body and answers the
 * remove_all_items_done flash; a queue with no landed purge body — the
 * webhook delivery queue, the DLQ, or any unknown name — answers
 * unknown-queue, which the route renders as upstream's nil-mq 404
 * (queue.go:77-80). The negative flash arm of the cron page has no
 * counterpart here: there is no producible invalid FORM (the button renders
 * only on purgeable rows), so every non-applied answer is a 404, never a
 * banner.
 */
export async function applyAdminMonitorQueueRemoveAllItems(
  d1: D1Database,
  qid: string,
): Promise<AdminMonitorQueueRemoveAllResult> {
  const purge = QUEUE_PURGE_BODIES[qid];
  if (purge === undefined) {
    return { outcome: "unknown-queue" };
  }
  await purge(d1);
  return { outcome: "applied", message: adminMonitorLocale.queueRemoveAllDone };
}

/** The manage page (queue_manage.tmpl reduced): the `Queue: %s` header
 *  (queue.go:33) over the sourced-columns detail table; the depth cell
 *  carries the remove-all-items form ONLY on a purgeable queue (upstream
 *  renders it for every countable queue, queue_manage.tmpl:33-35 — the
 *  dead-control rule narrows it), and the countable-less DLQ renders the
 *  `-` arm with no form (queue_manage.tmpl:29-31's own conditional). The
 *  Pool Settings section is OMITTED entirely (no worker-pool knob — the
 *  /set arm unclaimed). The reduction note is the cf-gitea posture line
 *  (the trace page's honest-absence convention); `flash` is the no-JS POST
 *  answer banner (always positive here — the unknown-queue arm is a 404). */
export function AdminMonitorQueueManagePage(props: {
  ctx: UiContext;
  data: AdminMonitorQueueDetailData;
  flash: { kind: "positive"; text: string } | null;
}) {
  const queue = props.data.queue;
  const title = adminMonitorLocale.queueManageTitle.replace("%s", queue.name);
  const manageLink = `/-/admin/monitor/queue/${queue.name}`;
  return (
    <AdminMonitorShell ctx={props.ctx} title={title} active="queue">
      <h4 class="ui top attached header">{title}</h4>
      {props.flash !== null ? <div class="ui positive message">{props.flash.text}</div> : null}
      <div class="ui attached table segment">
        <table class="ui very basic table">
          <thead>
            <tr>
              <th>{adminMonitorLocale.queueName}</th>
              <th>{adminMonitorLocale.queueType}</th>
              <th>{adminMonitorLocale.queueNumberInQueue}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{queue.name}</td>
              <td>{queue.type}</td>
              <td>
                {queue.inQueue === null ? (
                  // queue_manage.tmpl:29-31 — the countable-less render.
                  "-"
                ) : (
                  <>
                    {queue.inQueue}
                    {props.data.purgeable ? (
                      <form action={`${manageLink}/remove-all-items`} method="post" class="tw-inline-block tw-ml-4">
                        <button type="submit" class="ui tiny basic red button">
                          {adminMonitorLocale.queueRemoveAll}
                        </button>
                      </form>
                    ) : null}
                  </>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {/* The cf-gitea posture line (the module header's adjudications) —
          queue_manage.tmpl's second section keeps its segment+p shape with
          the dead Pool Settings header omitted. */}
      <div class="ui attached segment">
        <p>{adminMonitorLocale.queueManageReductions}</p>
      </div>
    </AdminMonitorShell>
  );
}

export function renderAdminMonitorQueueManagePage(options: {
  ctx: UiContext;
  data: AdminMonitorQueueDetailData;
  flash: { kind: "positive"; text: string } | null;
}): string {
  return renderPage(<AdminMonitorQueueManagePage ctx={options.ctx} data={options.data} flash={options.flash} />);
}

// ---------------------------------------------------------------------------
// Trace (GET /-/admin/monitor/stacktrace — stacktrace.tmpl's honest absence)
// ---------------------------------------------------------------------------

/**
 * The trace page (stacktrace.tmpl reduced): upstream renders "%d Goroutines,
 * %d Processes" over the process manager's stack list; the Workers runtime
 * exposes neither, so the page renders the header + segment shape carrying
 * the honest-absence note. NONE of trace_tabs.tmpl renders (the perftrace
 * tab is dev-only upstream AND source-less; the diagnosis form POSTs an
 * unlanded route; the process cancel `link-action`s have no source) — the
 * dead-control rule.
 */
export function AdminMonitorTracePage(props: { ctx: UiContext }) {
  return (
    <AdminMonitorShell ctx={props.ctx} title={adminMonitorLocale.monitoring} active="trace">
      <h4 class="ui top attached header">{adminMonitorLocale.trace}</h4>
      <div class="ui attached segment">
        <p>{adminMonitorLocale.traceUnavailable}</p>
      </div>
    </AdminMonitorShell>
  );
}

export function renderAdminMonitorTracePage(options: { ctx: UiContext }): string {
  return renderPage(<AdminMonitorTracePage ctx={options.ctx} />);
}
