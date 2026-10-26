/**
 * The ADMIN MONITOR family — `/-/admin/monitor/*` — the bench-row UNMOUNTED
 * module (wave 61, TWO-STAGE: this file ships the module only; `index.ts` is
 * orchestrator-held, so the routes ride the next window — the HANDOFF NOTE at
 * the bottom of this header). Sibling scope note: NO admin web surface is
 * landed at all (`src/ui/pages/` has zero `admin-*` modules — verified
 * 2026-10-26; the whole `/-/admin` family is the parity survey's single ABSENT
 * row, docs/compat/ui-parity-survey.md:386), so this module carries the
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
 *   cron     the static cron registry mirrored by the landed
 *            `GET /admin/cron` (routes/admin-degenerate.ts:129-149 — itself
 *            the mirror of wrangler.jsonc `triggers.crons`; admin-degenerate
 *            exports only the route registrar, so this module mirrors the one
 *            landed task under the same standing rule: a cron added to
 *            wrangler.jsonc lands in BOTH registries in the same change). The
 *            run arm is the landed service body the API's
 *            `POST /admin/cron/{task}` serves: `enqueueDueMirrorSyncs`
 *            (services/mirror/sync.ts:847 — "run = enqueue", the
 *            admin-degenerate posture).
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
 * (`{{if gt .Prev.Year 1}}`), the Result arm `—` while Status is empty, and
 * the hidden `from=monitor`. queue.tmpl reduced to the columns with landed
 * sources (Name/Type/Number in Queue — Exemplar Type and the worker counts
 * have no cf-gitea source; the per-queue Review link and manage page are not
 * rendered: no landed set-workers/remove-arms — the dead-control rule) plus
 * the cf-gitea delivery-state breakdown segment. stacktrace.tmpl reduced to
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
 * - The delivery-state breakdown segment is a cf-gitea addition (marked in
 *   the locale block) — upstream's queue table has no per-state view, but the
 *   landed log carries the states and the depth number alone hides them.
 * - The trace page renders the note instead of goroutine/process counts and
 *   renders NONE of trace_tabs.tmpl: the perftrace tab is `!setting.IsProd`
 *   upstream (stacktrace.go:19) and has no source either; the diagnosis form
 *   POSTs an unlanded route. A rendered tab/form would be dead.
 *
 * ## HANDOFF NOTE (the routes — this module has NO route)
 *
 * Route table (`index.ts` — orchestrator-held): four GET claims in the
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
 * The admin navbar belongs to the admin-family wave: AdminMonitorNav below is
 * MOUNT SCAFFOLDING ONLY (the OrgSettingsBlockedNav precedent) — the literal
 * navbar.tmpl DOM for the wrapper + header item + the monitor details block,
 * with the four live items. When the admin family lands its navbar, fold the
 * details block into it and DELETE this component. Survey row to touch on
 * landing: docs/compat/ui-parity-survey.md:386 (the `/-/admin/*` family row —
 * the monitor subset becomes PARTIAL).
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Child } from "hono/jsx";

import { enqueueDueMirrorSyncs } from "../../services/mirror/sync";
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
  taskUpdateMirrors: "Update Mirrors", // "admin.dashboard.update_mirrors"
  // The queue table headers (queue.tmpl:10-15, reduced to the sourced three).
  queueName: "Name", // "admin.monitor.queue.name"
  queueType: "Type", // "admin.monitor.queue.type"
  queueNumberInQueue: "Number in Queue", // "admin.monitor.queue.numberinqueue"
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

/** The monitor submenu's live items (the AdminMonitorNav `active` union). */
export type AdminMonitorPage = "stats" | "cron" | "queue" | "trace";

// ---------------------------------------------------------------------------
// The admin navbar scaffolding (navbar.tmpl:106-124 reduced — MOUNT
// SCAFFOLDING ONLY, the module header's handoff note)
// ---------------------------------------------------------------------------

/** The layout's navbar reduced to the monitor block: the vertical-menu
 *  wrapper + the `admin.settings` header item are the admin-family wave's
 *  replaceable scaffolding; the `<details class="item" open>` monitor
 *  submenu is the piece to fold into the landed navbar (upstream keeps the
 *  details `open` only on monitor pages — navbar.tmpl:106's condition —
 *  which a mounted `active` always is for this module's four pages). The
 *  audit_logs item is OMITTED (no landed store — the dead-link rule). */
export function AdminMonitorNav(props: { active: AdminMonitorPage }) {
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{adminMonitorLocale.settings}</div>
        <details class="item" open>
          <summary>{adminMonitorLocale.monitoring}</summary>
          <div class="menu">
            <a class={props.active === "stats" ? "active item" : "item"} href="/-/admin/monitor/stats">
              {adminMonitorLocale.stats}
            </a>
            <a class={props.active === "cron" ? "active item" : "item"} href="/-/admin/monitor/cron">
              {adminMonitorLocale.cron}
            </a>
            <a class={props.active === "queue" ? "active item" : "item"} href="/-/admin/monitor/queue">
              {adminMonitorLocale.queues}
            </a>
            <a class={props.active === "trace" ? "active item" : "item"} href="/-/admin/monitor/stacktrace">
              {adminMonitorLocale.trace}
            </a>
          </div>
        </details>
      </div>
    </div>
  );
}

/** The layout shell (layout_head.tmpl verbatim around the content block):
 *  the `admin monitor` pageClass, the fluid padded flex container, the
 *  monitor navbar, then `.flex-container-main` wrapping `.admin-setting-
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
        <AdminMonitorNav active={props.active} />
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

/** Go's zero time.Time as the cron registry's never-fired Prev/Next render
 *  (admin-degenerate.ts GO_ZERO_TIME — services/cron leaves task.Prev unset
 *  until the first fire). */
const GO_ZERO_TIME = "0001-01-01T00:00:00Z";

/** One rendered cron row — the landed registry's entry shape (the Cron
 *  struct render, modules/structs/cron.go's five fields): `prev` null = the
 *  never-fired arm (cron.tmpl:27 renders `-` while `.Prev.Year < 2`),
 *  `execTimes` 0 — the landed registry keeps no execution history (the
 *  admin-degenerate posture). */
export interface AdminMonitorCronEntry {
  /** Upstream's task name (services/cron tasks_basic.go register calls). */
  name: string;
  /** The wrangler-declared trigger expression — rendered verbatim. */
  spec: string;
  /** The next UTC firing; null only for a spec the minute-step parser cannot
   *  read — the zero-time render, never a wrong time. */
  next: Date | null;
  prev: Date | null;
  execTimes: number;
}

/**
 * The minute-step subset of cron expressions (a star-slash-N minute field
 * followed by `* * * * *`) → the step in minutes, or null for anything else
 * (admin-degenerate.ts's private parser mirrored — a future wrangler spec
 * lands in BOTH registries in the same change, the module header's rule).
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

/**
 * The landed cron task registry — the mirror of admin-degenerate.ts's
 * CRON_TASKS (itself the mirror of wrangler.jsonc `triggers.crons`; that
 * module exports only its route registrar, so the render table lives here).
 * Standing rule (both module headers): a cron added to wrangler.jsonc joins
 * the API registry and THIS table under its upstream task name in the same
 * change.
 */
const MONITOR_CRON_TASKS: Array<{ name: string; spec: string }> = [
  { name: "update_mirrors", spec: "*/10 * * * *" },
];

/** The cron table rows (the landed `GET /admin/cron` render — the API's
 *  toApiCron field mapping over the mirrored registry). */
export function loadAdminMonitorCron(now: Date): { entries: AdminMonitorCronEntry[] } {
  return {
    entries: MONITOR_CRON_TASKS.map((task) => {
      const step = minuteStepMinutes(task.spec);
      return {
        name: task.name,
        spec: task.spec,
        next: step === null ? new Date(GO_ZERO_TIME) : nextMinuteStepFire(step, now),
        prev: null,
        execTimes: 0,
      };
    }),
  };
}

/** The task's rendered name (cron.tmpl:24 — the `admin.dashboard.{Name}`
 *  locale key; unknown names fall back to the raw op, DashboardPost's
 *  task.unknown arm carries the raw value too). */
function taskDisplayName(name: string): string {
  return name === "update_mirrors" ? adminMonitorLocale.taskUpdateMirrors : name;
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
 * reduced to the landed run body): the known task executes the EXACT body
 * the landed `POST /admin/cron/{task}` serves — `enqueueDueMirrorSyncs`
 * ("run = enqueue", the admin-degenerate posture) — and answers the
 * task.started flash; an unknown task answers task.unknown WITHOUT running
 * anything (upstream's flash-error arm). A failed binding (`op` absent) is
 * the unknown arm's funnel (the binding-failure convention).
 */
export async function applyAdminMonitorCronForm(
  env: Env,
  form: AdminMonitorCronForm,
  options: { now?: Date } = {},
): Promise<AdminMonitorCronResult> {
  if (form.op === null || form.op !== "update_mirrors") {
    return { outcome: "invalid", message: adminMonitorLocale.taskUnknown.replace("%s", form.op ?? "") };
  }
  await enqueueDueMirrorSyncs(env, { now: options.now });
  return { outcome: "applied", message: adminMonitorLocale.taskStarted.replace("%s", taskDisplayName(form.op)) };
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
                <th></th>
                <th>{adminMonitorLocale.name}</th>
                <th>{adminMonitorLocale.schedule}</th>
                <th>{adminMonitorLocale.next}</th>
                <th>{adminMonitorLocale.previous}</th>
                <th>{adminMonitorLocale.executeTimes}</th>
                <th>{adminMonitorLocale.lastResult}</th>
              </tr>
            </thead>
            <tbody>
              {props.data.entries.map((entry) => (
                <tr>
                  <td>
                    {/* The run button (cron.tmpl:23). octicon-triangle-right
                        is outside the generated icon allowlist — octicon-clock
                        is the documented stand-in (the feeds-glyph convention;
                        a later allowlist extension swaps it per this one-line
                        site). NO other per-row controls: upstream's Result
                        glyph pair (cron.tmpl:29) renders only for a non-empty
                        Status, which the landed registry never sets. */}
                    <button type="submit" class="ui primary button" name="op" value={entry.name} title={adminMonitorLocale.operationRun}>
                      <Icon name="octicon-clock" />
                    </button>
                  </td>
                  <td>{taskDisplayName(entry.name)}</td>
                  <td>{entry.spec}</td>
                  <td>{entry.next === null ? "-" : formatMonitorFullTime(entry.next)}</td>
                  {/* cron.tmpl:27 — `-` while Prev.Year < 2 (never fired). */}
                  <td>{entry.prev === null ? "-" : formatMonitorFullTime(entry.prev)}</td>
                  <td>{entry.execTimes}</td>
                  {/* cron.tmpl:29 — the em dash while Status is empty. */}
                  <td>—</td>
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
export async function loadAdminMonitorQueues(d1: D1Database): Promise<AdminMonitorQueuesData> {
  const db = drizzle(d1);
  const [deliveryRows, mirrorRows] = await Promise.all([
    db.select({ state: webhookDeliveries.state, n: sql<number>`count(*)` }).from(webhookDeliveries).groupBy(webhookDeliveries.state).all(),
    db.select({ state: repoMirrors.syncState, n: sql<number>`count(*)` }).from(repoMirrors).groupBy(repoMirrors.syncState).all(),
  ]);
  const deliveryByState = new Map(deliveryRows.map((row) => [row.state, row.n]));
  const mirrorByState = new Map(mirrorRows.map((row) => [row.state, row.n]));
  // The schema enum's five states, rendered in lifecycle order, zeros
  // included (the log's full posture — the breakdown is the point).
  const deliveryStates: Array<[string, number]> = [
    ["pending", deliveryByState.get("pending") ?? 0],
    ["delivering", deliveryByState.get("delivering") ?? 0],
    ["delivered", deliveryByState.get("delivered") ?? 0],
    ["skipped", deliveryByState.get("skipped") ?? 0],
    ["failed", deliveryByState.get("failed") ?? 0],
  ];
  return {
    queues: [
      {
        name: "webhook-delivery",
        type: "cloudflare-queue",
        inQueue: (deliveryByState.get("pending") ?? 0) + (deliveryByState.get("delivering") ?? 0),
      },
      {
        name: "repo-tasks",
        type: "cloudflare-queue",
        inQueue: (mirrorByState.get("queued") ?? 0) + (mirrorByState.get("syncing") ?? 0),
      },
      { name: "webhook-delivery-dlq", type: "cloudflare-queue", inQueue: null },
    ],
    deliveryStates,
  };
}

/** The queues page (queue.tmpl reduced to the sourced columns — the module
 *  header's reduction list) plus the cf-gitea delivery-state segment. */
export function AdminMonitorQueuePage(props: { ctx: UiContext; data: AdminMonitorQueuesData }) {
  return (
    <AdminMonitorShell ctx={props.ctx} title={adminMonitorLocale.queues} active="queue">
      <h4 class="ui top attached header">{adminMonitorLocale.queues}</h4>
      <div class="ui attached table segment">
        <table class="ui very basic table unstackable">
          <thead>
            <tr>
              <th>{adminMonitorLocale.queueName}</th>
              <th>{adminMonitorLocale.queueType}</th>
              <th>{adminMonitorLocale.queueNumberInQueue}</th>
            </tr>
          </thead>
          <tbody>
            {props.data.queues.map((queue) => (
              <tr>
                <td>{queue.name}</td>
                <td>{queue.type}</td>
                <td>{queue.inQueue === null ? "-" : queue.inQueue}</td>
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
