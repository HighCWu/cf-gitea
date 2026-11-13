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
 *      cron-registry task or a sync-queue producer, admin.go:161-191). The
 *      B-68 census split landed the list's PORTABLE members and classified
 *      the rest; the table now carries, in order:
 *        a. `delete_inactive_accounts` (dashboard.tmpl:14-17) — the ONE
 *           fixed-list member with a real cf-gitea substrate: the landed
 *           sweep (services/user-accounts.ts `deleteInactiveAccounts`, the
 *           upstream task body's port — DeleteInactiveUsers over
 *           GetInactiveUsers, adapted to status='prohibited' + the
 *           system-principal exclusion + the three ownership-skip guards).
 *           A real Run button POSTing `op=delete_inactive_accounts` to
 *           `/-/admin`, upstream's exact form target (dashboard.tmpl:12).
 *        b. The landed cron registry's RUNNABLE rows (`update_mirrors` et
 *           al. — the disclosed substitution: a future wrangler cron joins
 *           the registry in the same change and this table grows its row
 *           automatically; the loader is the monitor module's). Their POSTs
 *           dispatch through the monitor module's own
 *           `applyAdminMonitorCronForm` composed verbatim — run body + the
 *           recorded cron_state tick — so EVERY rendered button really
 *           executes (this closed the dead-control gap where five of the
 *           six rendered registry buttons answered task.unknown).
 *        c. The SSH resync pair (dashboard.tmpl:31-40) behind upstream's OWN
 *           conditional (`{{if and (not .SSH.Disabled)
 *           (not .SSH.StartBuiltinServer)}}`): workerd has no SSH daemon
 *           and no authorized_keys files — the platform-forced pair renders
 *           NOTHING, exactly like upstream's disabled-SSH posture; the
 *           conditional is encoded live (the flags above the render).
 *      The REMAINING ten members stand platform-forced / platform-rooted
 *      and render as the posture line under the table, NEVER as rows or
 *      buttons, each with its reason in the note text (no stored archives —
 *      streamed; no missing-git-dir state — cells materialize on access;
 *      no git binary for gc/fsck — the engine GC self-drives on alarms; no
 *      delegate hook files — the gate is in-process and the R2 githooks are
 *      user content; no LDAP-family sources for the external-user sync; no
 *      generated repo avatars — no generator exists; no branches/tags sync
 *      queues). Unknown or bodyless ops POSTed to /-/admin answer the
 *      task.unknown flash (upstream's cron.GetTask miss, admin.go:186-191).
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
 * monitor module's exported `loadAdminMonitorCron` — ONE registry copy (the
 * no-duplicate rule); since the usability F3 census (services/cron-state.ts)
 * grew that registry to the full seven-arm listing, this dashboard reads the
 * RUNNABLE subset of it: these rows carry run buttons, and only the arms
 * with a landed run body may render one (the dead-control rule; the monitor
 * cron page renders the FULL census, buttons only where runnable). The run
 * arm composes the monitor module's `applyAdminMonitorCronForm` — each
 * body the API's own POST arm serves (admin-degenerate.ts's CRON_RUN_BODIES
 * mirror), never a fetch to our own /api/v1 — plus, ahead of it, the B-68
 * fixed-list member's own sweep (services/user-accounts.ts
 * `deleteInactiveAccounts`; the dispatch order above).
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

import { deleteInactiveAccounts } from "../../services/user-accounts";
import type { UiContext } from "../ui-context";
import { BaseLayout, renderPage } from "../shell";
import { AdminFamilyNav } from "./admin-users";
import {
  applyAdminMonitorCronForm,
  loadAdminMonitorCron,
  type AdminMonitorCronEntry,
} from "./admin-monitor";

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
  // The B-68 PORTABLE member of the fixed list — its dashboard.tmpl:14-17 row
  // label (locale_en-US.json "admin.dashboard.delete_inactive_accounts").
  taskDeleteInactiveAccounts: "Delete all unactivated accounts",
  // The run POST's flash texts (admin.go:188-190 DashboardPost — "%s" is the
  // task's locale name / the raw op). The registry arms' flashes ride the
  // monitor module's composed dispatch (identical upstream strings).
  taskStarted: "Started Task: %s", // "admin.dashboard.task.started"
  taskUnknown: "Unknown task: %s", // "admin.dashboard.task.unknown"
  // cf-gitea additions — the honest-absence answers. maintenancePosture names
  // ONLY the STANDING members of the fixed list (the B-68 split — the SSH
  // pair is upstream's own conditional-hide, not a posture member; the
  // portable member is a real row): each with its one-line reason class.
  maintenancePosture:
    "The remaining fixed maintenance operations have no cf-gitea substrate and render here as this note, never as buttons: delete_repo_archives (archives stream, nothing is stored), delete_missing_repos and reinit_missing_repos (a repository's git store materializes on access — a record missing its git files cannot exist), git_gc_repos (no git binary — the engine's storage garbage collection self-drives on per-repository alarms), resync_all_hooks (push processing is the in-process gate — no hook files execute and the stored hook objects are user content, not the delegate scripts upstream restores), sync_external_users (only OAuth2 login sources exist — upstream's sync walks the LDAP-family sources alone), repo_health_check (no git fsck), delete_generated_repository_avatars (no repository-avatar generator exists), sync_repo_branches and sync_repo_tags (no branches/tags sync queues).",
  systemStatusPosture:
    "System status is not available: the Workers runtime exposes no Go runtime statistics (no goroutine count, no memory/heap/GC counters, no process uptime), so upstream's system status table has no cf-gitea source.",
} as const;

// ---------------------------------------------------------------------------
// The SSH posture (dashboard.tmpl:31's conditional —
// `{{if and (not .SSH.Disabled) (not .SSH.StartBuiltinServer)}}` around the
// resync_all_sshkeys / resync_all_sshprincipals rows). The B-68 rule for the
// platform-forced members: mirror upstream's OWN render-or-hide conditions.
// workerd exposes no SSH daemon and no authorized_keys files (the config
// page's recorded posture — "no SSH server — git smart-HTTP over HTTPS
// only"), which is exactly upstream's SSH.Disabled=true posture, so the
// pair's conditional evaluates FALSE and the rows never render — the same
// DOM a disabled-SSH upstream deployment produces. Typed `boolean` so the
// gate stays a live conditional (upstream's template arm), not a fold.
// ---------------------------------------------------------------------------

/** setting.SSH.Disabled — true: no SSH server exists on Workers. */
const SSH_DISABLED: boolean = true;
/** setting.SSH.StartBuiltinServer — no builtin server either. */
const SSH_START_BUILTIN_SERVER: boolean = false;
/** The template gate's evaluation: the resync pair renders only when BOTH
 *  flags are false — never on this platform. */
const SSH_RESYNC_ROWS_RENDER = !SSH_DISABLED && !SSH_START_BUILTIN_SERVER;

// ---------------------------------------------------------------------------
// The page data (§3.2 — the landed cron registry via the monitor module's
// loader; one registry copy, the module header)
// ---------------------------------------------------------------------------

/** The dashboard's render inputs: the maintenance table rows. */
export interface AdminDashboardData {
  maintenance: AdminMonitorCronEntry[];
}

/** The dashboard load — the landed registry's RUNNABLE subset (the monitor
 *  module's loader; the usability F3 census grew that registry to the full
 *  seven-arm listing, and these rows carry run buttons, so the runnable
 *  filter keeps this segment the bodies its POST can actually execute —
 *  never a dead control; the monitor cron page renders the FULL census
 *  through the same loader). prev is null until the first fire, execTimes 0
 *  — the admin-degenerate posture. The Promise signature is the wiring
 *  wave's loader convention (the async-migration plugs in without a
 *  call-site change). */
export function loadAdminDashboardData(now: Date): Promise<AdminDashboardData> {
  return Promise.resolve({ maintenance: loadAdminMonitorCron(now).entries.filter((entry) => entry.runnable) });
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
 * The run (DashboardPost's dispatch, admin.go:155-194 — the B-68 landing):
 *   - the fixed list's PORTABLE member `delete_inactive_accounts` runs the
 *     landed sweep (services/user-accounts.ts deleteInactiveAccounts — the
 *     upstream task body's port). Upstream fires the task fire-and-forget
 *     (`go task.RunWithUser`, admin.go:181-186) and answers the task.started
 *     flash regardless of the body's outcome — a failure surfaces in the
 *     server log only — so the awaited sweep is caught-and-logged, never a
 *     failure flash.
 *   - every other known task executes through the monitor module's registry
 *     dispatch (`applyAdminMonitorCronForm` composed verbatim): the exact
 *     body the landed `POST /admin/cron/{task}` serves for each runnable
 *     arm ("run = enqueue", the admin-degenerate posture) plus the
 *     cron_state tick a manual run records (upstream's ExecTimes counts
 *     run STARTS on the shared RunWithUser path — the dashboard trigger
 *     included, tasks.go:95-97). This closes the dead-control gap where the
 *     rendered registry rows' POSTs answered task.unknown — every rendered
 *     button now really executes (ADR-0008's accepted-input rule).
 *   - an unknown task (including upstream's two queue ops
 *     sync_repo_branches/sync_repo_tags, admin.go:161-175, whose producers
 *     have no cf-gitea queue, and the platform-forced fixed-list members —
 *     no run body exists to answer them) answers task.unknown WITHOUT
 *     running anything. A failed binding (`op` absent) funnels to the
 *     unknown arm (the binding-failure convention).
 */
export async function applyAdminDashboardForm(
  env: Env,
  form: AdminDashboardForm,
  options: { now?: Date } = {},
): Promise<AdminDashboardResult> {
  if (form.op === "delete_inactive_accounts") {
    await deleteInactiveAccounts(env, { now: options.now }).catch((error: unknown) => {
      // Upstream's log.Error arm (admin.go:184-185 — the goroutine logs,
      // the flash is already out): the sweep is best-effort, the POST
      // answer stays task.started.
      console.error("[admin-dashboard] delete_inactive_accounts:", error);
    });
    return {
      outcome: "applied",
      message: adminDashboardLocale.taskStarted.replace("%s", adminDashboardLocale.taskDeleteInactiveAccounts),
    };
  }
  // The landed registry arms (the six runnable census rows) — the monitor
  // module's dispatch composed verbatim; its flash texts are upstream's
  // identical task.started/task.unknown strings.
  return applyAdminMonitorCronForm(env, { op: form.op, from: "" }, options);
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
              {/* dashboard.tmpl:14-17 — the fixed list's FIRST row, the B-68
                  PORTABLE member: a real Run button (the DOM upstream renders;
                  the POST runs the landed sweep, applyAdminDashboardForm). */}
              <tr>
                <td>{adminDashboardLocale.taskDeleteInactiveAccounts}</td>
                <td class="tw-text-right">
                  <button type="submit" class="ui primary button" name="op" value="delete_inactive_accounts">
                    {adminDashboardLocale.operationRun}
                  </button>
                </td>
              </tr>
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
              {/* dashboard.tmpl:31-40 — the SSH resync pair behind
                  upstream's OWN conditional. The gate is FALSE on this
                  platform (no SSH daemon — the flags above), so the rows
                  never render: the same hide a disabled-SSH upstream
                  deployment produces, not a posture note. */}
              {SSH_RESYNC_ROWS_RENDER ? (
                <tr>
                  <td>{"Update the '.ssh/authorized_keys' file with Gitea SSH keys"}</td>
                  <td class="tw-text-right">
                    <button type="submit" class="ui primary button" name="op" value="resync_all_sshkeys">
                      {adminDashboardLocale.operationRun}
                    </button>
                  </td>
                </tr>
              ) : null}
              {SSH_RESYNC_ROWS_RENDER ? (
                <tr>
                  <td>{"Update the '.ssh/authorized_principals' file with Gitea SSH principals"}</td>
                  <td class="tw-text-right">
                    <button type="submit" class="ui primary button" name="op" value="resync_all_sshprincipals">
                      {adminDashboardLocale.operationRun}
                    </button>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </form>
        {/* The fixed-list posture (dashboard.tmpl:19-68's remaining rows have
            no cf-gitea substrate — the B-68 split; the portable member is a
            real row above and the SSH pair rides upstream's conditional-hide).
            A muted paragraph, never buttons. */}
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
