/**
 * The ADMIN DASHBOARD page — `/-/admin` — the bench-row module (MOUNTED at
 * e31c0cf, window-2c: the routes live in `index.ts` beside the admin gate —
 * the retired wiring HANDOFF is the mount record at the bottom of this
 * header). Sibling scope: `admin-monitor.tsx` (wave 61) owns the
 * `/-/admin/monitor/*` pages and "none of the dashboard/users/repos pages" —
 * this module is the dashboard half of the `/-/admin` family, the parity
 * survey's single ABSENT row (docs/compat/ui-parity-survey.md:467).
 *
 * ## Upstream surface (at the pin)
 *
 * `templates/admin/dashboard.tmpl` (82 lines) served by `admin.Dashboard`
 * (routers/web/admin/admin.go:135-152 — there is no dashboard.go at this pin,
 * the dashboard handlers live in admin.go) with the POST arm
 * `admin.DashboardPost` (admin.go:154-194). The routes
 * (routers/web/web.go:781-783):
 *
 *   GET  /-/admin                admin.Dashboard
 *   GET  /-/admin/system_status  admin.SystemStatus (the 5s-morph fragment)
 *   POST /-/admin                DashboardPost (the maintenance-op runner)
 *
 * behind `verifyAuthWithOptionsWeb(&VerifyOptions{SignInRequired: true,
 * AdminRequired: true})` (web.go:779) — anonymous → the login redirect, a
 * signed-in non-admin → the 404 shell. That gate is the ROUTE stage's posture
 * (the module trusts its inputs like every landed load function).
 *
 * ## Card-by-card mapping (upstream's three pieces → landed-or-absent seams)
 *
 * The handler's data pull is the whole story (admin.go:136-151): Title +
 * PageIsAdminDashboard, `NeedUpdate`/`RemoteVersion` from the update checker,
 * `SysStatus` from Go's runtime, `SSH` from settings. Each maps to:
 *
 *   1. The `.NeedUpdate` version-hint message (dashboard.tmpl:3-7) — NO
 *      SOURCE: there is no update checker in cf-gitea (no RemoteVersion
 *      poller; `admin.dashboard.update_checker` has no landed counter).
 *      Upstream renders the message only `{{if .NeedUpdate}}`; with no
 *      checker the guard's false arm is the only producible posture, so the
 *      message renders NOTHING (rendering it would fabricate a release
 *      comparison; rendering the table header would fabricate the check).
 *   2. Maintenance Operations (dashboard.tmpl:8-72) — upstream's fixed
 *      op-button list (delete_inactive_accounts … sync_repo_tags, each a
 *      cron-registry task or a sync-queue producer, admin.go:161-191) has an
 *      EMPTY intersection with the landed cron registry: `update_mirrors`
 *      alone (routes/admin-degenerate.ts:135-141, the mirror of wrangler
 *      jsonc `triggers.crons`; "run = enqueue"). The landed op is the table's
 *      LIVE row — a real Run button POSTing `op=update_mirrors` to
 *      `/-/admin`, upstream's exact form target (dashboard.tmpl:12) — driven
 *      through the landed producer `enqueueDueMirrorSyncs`, the same body the
 *      API's `POST /admin/cron/{task}` serves. Upstream's fixed list renders
 *      as the posture line under the table, NEVER as rows or buttons (no
 *      cron daemon beyond the wrangler trigger, no SSH host for the resync
 *      pair — dashboard.tmpl:31-40's own conditional arm — no filesystem
 *      health checker, no branches/tags sync queues). Documented divergence:
 *      the table carries the landed registry instead of the fixed list; a
 *      future wrangler cron joins the registry in the same change and this
 *      table grows its row automatically (the loader is the monitor module's).
 *   3. System Status (dashboard.tmpl:74-80 over admin/system_status.tmpl) —
 *      NO SOURCE: the dl is Go runtime introspection
 *      (`updateSystemStatus`, admin.go:71-125 — runtime.MemStats, heap/stack
 *      allocator counters, GC pauses, `runtime.NumGoroutine`, the process
 *      start-time uptime). The Workers runtime exposes none of it and no
 *      landed port approximates it, so the segment renders the
 *      honest-absence posture (the monitor trace page's pattern), never a
 *      zero-filled dl.
 *
 * The counts (users/orgs/repos) are NOT dashboard content at this pin — they
 * are the monitor/stats page (`MonitorStats`, admin.go:256-289), the sibling
 * module's landed `loadAdminMonitorStats`; duplicating them here would fork
 * the counters. The `GET /-/admin/system_status` fragment (web.go:782) stays
 * UNMOUNTED: its only consumer is system_status.tmpl:1's `data-fetch-url`
 * 5-second morph over the dl, and the dl does not render (card 3).
 *
 * ## Data (§3.2 — the landed seams, never a self-fetch)
 *
 * The maintenance row set IS the landed cron registry read through the
 * monitor module's exported `loadAdminMonitorCron` (admin-monitor.tsx:509) —
 * ONE registry copy (the no-duplicate rule; that module mirrors
 * admin-degenerate.ts's CRON_TASKS, which mirrors wrangler.jsonc). The run
 * arm is the landed producer `enqueueDueMirrorSyncs`
 * (services/mirror/sync.ts) directly — the API's own POST arm body
 * (admin-degenerate.ts:351), never a fetch to our own /api/v1.
 *
 * ## DOM contract (templates/admin/{layout_head,navbar,dashboard}.tmpl at the pin)
 *
 * layout_head's pageClass is the literal `admin dashboard` (dashboard.tmpl:1);
 * the layout is the fluid padded flex container wrapping the admin navbar +
 * `.flex-container-main` + `.admin-setting-content`. The navbar reduces to
 * the LANDED pages (the dead-link rule): the Maintenance `<details class="item"
 * open>` group (navbar.tmpl:5 — open while PageIsAdminDashboard) with the
 * Dashboard item active (self_check omitted — unlanded), and the Monitoring
 * group with the sibling monitor family's four live items (navbar.tmpl:106-124,
 * audit_logs omitted — no landed store). Every other upstream group (Identity
 * & Access, Code Assets, Integrations, Actions, Config, Notices) is omitted —
 * every one of its items is an unlanded page. The maintenance section is
 * `h4.ui.top.attached.header` over `.ui.attached.table.segment` with the run
 * form wrapping the `.ui.very.basic.table` (dashboard.tmpl:11-72), rows of
 * `<td>{op}</td><td class="tw-text-right">{Run button}</td>`; the Run button
 * renders the `admin.dashboard.operation_run` text and OMITS upstream's
 * octicon-play glyph (outside the generated icon allowlist — the button's
 * visible label is the locale string, so no stand-in glyph is needed; a
 * later allowlist extension adds it at this one-line site). The system-status
 * section keeps the header + segment pair (dashboard.tmpl:74-80) carrying the
 * posture paragraph. The flash banner is the no-JS POST answer (the
 * monitor cron page's convention; upstream redirects with a flash).
 *
 * ## Mount record (MOUNTED at e31c0cf — the routes are live)
 *
 * Route table (`index.ts`), shaped like the monitor cron pair:
 *
 *   GET /-/admin   the admin gate (session resolveUiSession → non-admin 404
 *                  shell, anonymous → the login 303 — web.go:779's posture)
 *                  → loadAdminDashboardData(new Date()) →
 *                  renderAdminDashboardPage({ ctx, data, flash: null })
 *   POST /-/admin  sameOriginGuard FIRST (ui/session.ts:441) → the admin gate
 *                  → parseAdminDashboardForm(readUrlEncodedForm(req),
 *                  ui/forms.ts:21) → applyAdminDashboardForm(env, form) →
 *                  re-render the fresh load at 200 with the flash (upstream
 *                  redirects back to /-/admin, admin.go:192; the no-JS
 *                  re-render is the keys-page convention — swap to a 303 if
 *                  the flash-queue lands)
 *
 * `GET /-/admin/system_status` is NOT mounted (the card-3 note). The navbar
 * is the admin family's ONE shared navbar (the mount window's F7 fold —
 * pages/admin-users.tsx AdminFamilyNav with `active="dashboard"`; the
 * AdminDashboardNav scaffolding copy was DELETED — the AdminMonitorNav
 * precedent). The survey row touched on landing is
 * docs/compat/ui-parity-survey.md:467.
 */

import type { Child } from "hono/jsx";

import { enqueueDueMirrorSyncs } from "../../services/mirror/sync";
import type { UiContext } from "../ui-context";
import { BaseLayout, renderPage } from "../shell";
import { AdminFamilyNav } from "./admin-users";
import { loadAdminMonitorCron, type AdminMonitorCronEntry } from "./admin-monitor";

// ---------------------------------------------------------------------------
// Page chrome + copy text (component-local, the adminMonitorLocale pattern —
// locale.ts is shared and not this wave's file; upstream locale keys cited,
// cf-gitea additions marked)
// ---------------------------------------------------------------------------

export const adminDashboardLocale = {
  /** The navbar menu header (navbar.tmpl:3). */
  settings: "Admin Settings", // "admin.settings"
  /** The maintenance group's summary (navbar.tmpl:5). */
  maintenance: "Maintenance", // "admin.maintenance"
  /** The nav item + the page Title (admin.go:137 — ctx.Tr "admin.dashboard"). */
  dashboard: "Dashboard", // "admin.dashboard"
  monitoring: "Monitoring", // "admin.monitor" (the nav summary)
  stats: "Stats", // "admin.monitor.stats" (the live sibling items)
  cron: "Cron Tasks", // "admin.monitor.cron"
  queues: "Queues", // "admin.monitor.queues"
  trace: "Trace", // "admin.monitor.trace"
  maintenanceOperations: "Maintenance Operations", // "admin.dashboard.maintenance_operations" (dashboard.tmpl:9)
  systemStatus: "System Status", // "admin.dashboard.system_status" (dashboard.tmpl:75)
  operationRun: "Run", // "admin.dashboard.operation_run" (the run button label)
  taskUpdateMirrors: "Update Mirrors", // "admin.dashboard.update_mirrors" (the row name)
  // The run POST's flash texts (admin.go:188-190 DashboardPost — "%s" is the
  // task's locale name / the raw op).
  taskStarted: "Started Task: %s", // "admin.dashboard.task.started"
  taskUnknown: "Unknown task: %s", // "admin.dashboard.task.unknown"
  // cf-gitea additions — the honest-absence answers (the module header's
  // cards 2 and 3).
  maintenancePosture:
    "Upstream's fixed maintenance list (delete_inactive_accounts, delete_repo_archives, delete_missing_repos, git_gc_repos, resync_all_sshkeys, resync_all_sshprincipals, resync_all_hooks, reinit_missing_repos, sync_external_users, repo_health_check, delete_generated_repository_avatars, sync_repo_branches, sync_repo_tags) has no cf-gitea substrate — no cron daemon beyond the wrangler trigger, no SSH host, no filesystem health checker, no branches/tags sync queues — so those operations render here as this note, never as buttons.",
  systemStatusPosture:
    "System status is not available: the Workers runtime exposes no Go runtime statistics (no goroutine count, no memory/heap/GC counters, no process uptime), so upstream's system status table has no cf-gitea source.",
} as const;

// ---------------------------------------------------------------------------
// The page data (§3.2 — the landed cron registry via the monitor module's
// loader; one registry copy, the module header)
// ---------------------------------------------------------------------------

/** The dashboard's render inputs: the maintenance table rows. */
export interface AdminDashboardData {
  maintenance: AdminMonitorCronEntry[];
}

/** The dashboard load — the landed registry (the monitor module's loader;
 *  prev is null until the first fire, execTimes 0 — the admin-degenerate
 *  posture). The Promise signature is the wiring wave's loader convention
 *  (the async-migration plugs in without a call-site change). */
export function loadAdminDashboardData(now: Date): Promise<AdminDashboardData> {
  return Promise.resolve({ maintenance: loadAdminMonitorCron(now).entries });
}

// ---------------------------------------------------------------------------
// The maintenance POST (upstream DashboardPost's cron arm, admin.go:154-194,
// reduced to the landed run body — the monitor cron form's mirror without the
// `from` field: upstream's dashboard form carries no from, cron.tmpl:34 does)
// ---------------------------------------------------------------------------

/** The parsed POST (dashboard.tmpl's per-row run button): `op` null = a
 *  failed binding — the arm this DOM never emits. */
export interface AdminDashboardForm {
  op: string | null;
}

export function parseAdminDashboardForm(params: URLSearchParams): AdminDashboardForm {
  const op = params.get("op") ?? "";
  return { op: op === "" ? null : op };
}

export type AdminDashboardResult =
  | { outcome: "applied"; message: string }
  | { outcome: "invalid"; message: string };

/** The row's rendered name (upstream resolves `admin.dashboard.{op}` through
 *  the task registry; the landed registry carries the one name). */
function taskDisplayName(name: string): string {
  return name === "update_mirrors" ? adminDashboardLocale.taskUpdateMirrors : name;
}

/**
 * The run (DashboardPost's default arm, admin.go:186-191): the known task
 * executes the EXACT body the landed `POST /admin/cron/{task}` serves —
 * `enqueueDueMirrorSyncs` ("run = enqueue", the admin-degenerate posture) —
 * and answers the task.started flash; an unknown task (including upstream's
 * two queue ops sync_repo_branches/sync_repo_tags, admin.go:161-175, whose
 * producers have no cf-gitea queue) answers task.unknown WITHOUT running
 * anything. A failed binding (`op` absent) funnels to the unknown arm
 * (the binding-failure convention).
 */
export async function applyAdminDashboardForm(
  env: Env,
  form: AdminDashboardForm,
  options: { now?: Date } = {},
): Promise<AdminDashboardResult> {
  if (form.op === null || form.op !== "update_mirrors") {
    return { outcome: "invalid", message: adminDashboardLocale.taskUnknown.replace("%s", form.op ?? "") };
  }
  await enqueueDueMirrorSyncs(env, { now: options.now });
  return { outcome: "applied", message: adminDashboardLocale.taskStarted.replace("%s", taskDisplayName(form.op)) };
}

// ---------------------------------------------------------------------------
// The admin navbar scaffolding (navbar.tmpl reduced to the landed pages —
// MOUNT SCAFFOLDING ONLY, the module header's handoff note)
// ---------------------------------------------------------------------------

// The layout's navbar is the SHARED AdminFamilyNav (pages/admin-users.tsx —
// the mount window's F7 fold; the module-local AdminDashboardNav copy was
// deleted): the Maintenance group opens with Dashboard active on this page,
// the other groups closed — navbar.tmpl's PageIsAdmin condition.

/** The layout shell (layout_head.tmpl verbatim around the content block):
 *  the `admin dashboard` pageClass, the fluid padded flex container, the
 *  navbar, then `.flex-container-main` wrapping `.admin-setting-content`
 *  (dashboard.tmpl:2). */
function AdminDashboardShell(props: { ctx: UiContext; title: string; children: Child }) {
  return (
    <BaseLayout ctx={props.ctx} title={props.title} pageClass="admin dashboard">
      <div class="ui container fluid padded flex-container">
        <AdminFamilyNav active="dashboard" />
        <div class="flex-container-main">
          <div class="admin-setting-content">{props.children}</div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The render (templates/admin/dashboard.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern). */
export function renderAdminDashboardPage(options: {
  ctx: UiContext;
  data: AdminDashboardData;
  flash: { kind: "positive" | "negative"; text: string } | null;
}): string {
  return renderPage(<AdminDashboardPage ctx={options.ctx} data={options.data} flash={options.flash} />);
}

/** The admin dashboard (§2.4.1 discriminator: `admin dashboard` — layout_head's
 *  pageClass, dashboard.tmpl:1). */
export function AdminDashboardPage(props: {
  ctx: UiContext;
  data: AdminDashboardData;
  flash: { kind: "positive" | "negative"; text: string } | null;
}) {
  return (
    <AdminDashboardShell ctx={props.ctx} title={adminDashboardLocale.dashboard}>
      {/* dashboard.tmpl:3-7's NeedUpdate message renders NOTHING — no update
          checker exists, the guard's false arm is the only posture (the module
          header, card 1). */}
      <h4 class="ui top attached header">{adminDashboardLocale.maintenanceOperations}</h4>
      <div class="ui attached table segment">
        {/* The run form (dashboard.tmpl:11-12) — the POST target is upstream's
            own `/-/admin`. The flash banner is the no-JS POST answer (the
            monitor cron page's convention). */}
        <form method="post" action="/-/admin">
          {props.flash !== null ? <div class={`ui ${props.flash.kind} message`}>{props.flash.text}</div> : null}
          <table class="ui very basic table tw-mt-0 tw-px-4">
            <tbody>
              {props.data.maintenance.map((entry) => (
                <tr>
                  <td>{taskDisplayName(entry.name)}</td>
                  <td class="tw-text-right">
                    {/* The run button (dashboard.tmpl:17's shape — name=op,
                        value={task}). octicon-play is outside the generated
                        icon allowlist; the label text IS the upstream string
                        (admin.dashboard.operation_run), so the glyph omits
                        without a stand-in (the module header's DOM note). */}
                    <button type="submit" class="ui primary button" name="op" value={entry.name}>
                      {adminDashboardLocale.operationRun}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </form>
        {/* The fixed-list posture (dashboard.tmpl:15-68's twelve-plus rows
            have no cf-gitea substrate — the module header, card 2). A muted
            paragraph, never buttons. */}
        <p class="tw-text-placeholder-text">{adminDashboardLocale.maintenancePosture}</p>
      </div>

      <h4 class="ui top attached header">{adminDashboardLocale.systemStatus}</h4>
      <div class="ui attached table segment">
        {/* system_status.tmpl's SysStatus dl renders NOTHING — Go runtime
            introspection with no Workers source (the module header, card 3);
            the segment carries the honest-absence note. */}
        <p class="tw-text-placeholder-text">{adminDashboardLocale.systemStatusPosture}</p>
      </div>
    </AdminDashboardShell>
  );
}
