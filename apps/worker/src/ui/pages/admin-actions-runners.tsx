/**
 * The ADMIN actions RUNNERS page — `/-/admin/actions/runners` — the
 * ui-parity survey tick-19's instance-wide runner management arm (the ADMIN
 * scope of the shared four-scope runners builders, ported from the pin
 * fc4936884584a41931906553d96c2601d750e6ef; the repo twin is
 * pages/repo-settings-actions-runners.tsx, the org twin
 * pages/org-settings-actions-runners.tsx — this module reuses both twins'
 * scope-neutral exports and adds only the admin polarity).
 *
 * ## Upstream surface (VERIFIED at the pin)
 *
 *   - `routers/web/web.go:898-904` — the admin `/-/admin/actions` group:
 *     `m.Get("", misc.LocationRedirect("./actions/runners"))` (:899 — the
 *     bare literal 303s onto ./actions/runners, HANDOFF-only below),
 *     `addSettingsRunnersRoutes()` (:900 — web.go:506-513's shared group),
 *     `m.Post("/runners/bulk", shared_actions.RunnerBulkActionPost)` (:901
 *     — admin-only), `addSettingsVariablesRoutes()` (:902 — the variables
 *     module), `addSettingsScopedWorkflowsRoutes()` (:903 — NOT SERVED, the
 *     module header's reduction verdict), `m.Get("/job_queue", ...)` (:904 —
 *     the landed repo-actions-queue module's admin arm). The whole group
 *     sits behind `adminReq` (web.go:906's group closure — the shared
 *     adminPagePrologue's exact posture: anonymous → the login 303, a
 *     signed-in non-admin → the 404 shell).
 *   - `routers/web/shared/actions/runners.go` — the ADMIN arms:
 *     `getRunnersCtx` (:75-84 — OwnerID 0, RepoID 0, IsAdmin, tplAdminRunners
 *     "admin/actions", tplAdminRunnerEdit "admin/runners/edit", RedirectLink
 *     AppSubURL + "/-/admin/actions/runners/"), `Runners` (:102-155 — at
 *     the admin arm NEITHER scope id is set on FindRunnerOptions and
 *     WithAvailable stays FALSE, so the list is EVERY runner;
 *     GetOrCreateActiveRunnerToken(0, 0) — the GLOBAL token; AllowBulkActions
 *     = IsAdmin = TRUE), `RunnersEdit` (:158-216 — GetRunnerByID then
 *     EditableInContext(0,0)), `RunnersEditPost` (:224-262), `ResetRunnerRegistrationToken`
 *     (:264-281 — NewRunnerToken(0, 0)), `RunnerDeletePost` (:283-317),
 *     `RunnerUpdatePost` (:319-358 — the required `disabled` param),
 *     `RunnerBulkActionPost` (:360-430 — ids[] + action ∈
 *     delete/disable/enable, both junk arms answer BEFORE any write),
 *     `findActionsRunner`'s admin arm (:448-450 — the ID pin ONLY, no scope
 *     cond: any runner resolves).
 *   - `models/actions/runner.go` — `EditableInContext`'s admin arm
 *     (:162-169 — `ownerID == 0 && repoID == 0` returns TRUE: an admin edits
 *     EVERY runner, the twins' polarity inverted), `ToConds` (:232-277 —
 *     with both ids zero the scope branches never ride: no cond beyond the
 *     q LIKE), `ToOrders` (:301-318 — the shared status-rank ladder), the
 *     hard `DeleteRunner`.
 *   - Templates: `admin/actions.tmpl` (layout_head pageClass
 *     `admin actions`; the PageType "runners" arm renders
 *     shared/actions/runner_list.tmpl into `.admin-setting-content`) and
 *     `admin/runners/edit.tmpl` (tplAdminRunnerEdit — pageClass
 *     `admin runners`, rendering shared/actions/runner_edit). runner_list.tmpl
 *     admin-only extras: the `{{if .AllowBulkActions}}` checkbox column +
 *     bulk toolbar segment (runner_list.tmpl:38-53) and the
 *     `admin.total` count form ("Total: %d").
 *
 * ## Mount record (PRE-MOUNT — the routes 404 through the router until the
 * orchestrator executes the HANDOFF recipes; the tests pin the parse nulls)
 *
 *   GET  /-/admin/actions                                        → 303 ./actions/runners (recipe-only)
 *   GET  /-/admin/actions/runners                                → list
 *   GET  /-/admin/actions/runners/{id}                           → edit
 *   POST /-/admin/actions/runners/{id}                           → description
 *   POST /-/admin/actions/runners/{id}/update-runner             → flip
 *   POST /-/admin/actions/runners/{id}/delete                    → del
 *   POST /-/admin/actions/runners/reset_registration_token       → reset (global scope)
 *   POST /-/admin/actions/runners/bulk                           → bulk delete/disable/enable
 *
 * all behind the shared adminPagePrologue, the POSTs sameOriginGuard-first
 * (the family convention). The literal `reset_registration_token` and the
 * `bulk` tail claim ahead of the `{id}` combo (chi's static-first dispatch,
 * web.go:507-512's group order).
 *
 * ## Data (SPEC-0012 M1a's landed store — the twins' convention)
 *
 * The global registration-token block rides services/actions/model.ts:
 * `getOrCreateActiveRunnerToken` / `newRunnerToken` at (0, "") — the GLOBAL
 * scope (upstream's owner_id 0 + repo_id 0 pair). The list's sort ladder and
 * status model are the REPO twin's scope-neutral exports (`runnersOrderBy`,
 * `runnerStatusOf`, `runnerBelongsTo`); the find/writes mirror the ADMIN
 * arms above (no scope pin — the admin polarity). The bulk arm loops the
 * found runners exactly like upstream's transaction body (a missing id in
 * the list is skipped silently — Find returns only existing rows; an EMPTY
 * result set is a successful no-op).
 *
 * ## Documented reductions (§6 method — never dead controls; the twins'
 * reductions carry verbatim plus the admin-only ones)
 *
 * - The token-panel dropdown reduced inline (the repo twin's header shape —
 *   the token panel renders as the attached segment below the header); the
 *   reset as a plain 303 form POST (upstream's link-action + confirm modal).
 * - The 303 targets drop upstream's RedirectLink TRAILING SLASH (the twins'
 *   bare-list-URL convention; upstream's "/-/admin/actions/runners/" bytes
 *   never hit the wire).
 * - The bulk toolbar (runner_list.tmpl:38-53) is upstream's JS arm —
 *   `data-global-init="initRunnerBulkToolbar"`, a hidden `ids` input the
 *   script fills comma-joined, select-all wiring. Reduced to the
 *   admin-notices idiom (§3.1's ONE-form-wrapping-the-table): the list table
 *   + the toolbar sit inside ONE form posting `ids` (per-row checkboxes,
 *   name="ids", aria-label "Check/Uncheck: {name}") to /runners/bulk, with
 *   the three submit buttons (disable / enable / delete — delete red) each
 *   carrying name="action". The JS select-all checkbox is a dead control
 *   without its script and is OMITTED (the per-row checkboxes are the
 *   live surface); the delete button's confirm modal
 *   (data-modal-confirm-*) is JS too — the twins drop confirm modals.
 *   Upstream's FormStringInt64s semantics preserved exactly: the comma-list
 *   splits, empty entries skip, ANY junk entry voids the whole list (nil) →
 *   the "missing runner IDs" 400 (modules/base/tool.go:95-108 — the error
 *   return the `vals, _ :=` discards into the empty-arm).
 * - The 400 arms (missing `disabled` param, missing ids, invalid action)
 *   answer upstream's HTTPError body as the plain-text 400 (the repo twin's
 *   disabled-param arm's shape).
 * - The edit page's task list keeps the twins' posture: the Job cell renders
 *   the id as TEXT (the repo twin's GetRunJobLink reduction — its fold-back
 *   is that module's reported follow-up and this module inherits it).
 * - The NAVBAR is the module-local AdminActionsNav (below): the landed
 *   AdminFamilyNav's structure with the Actions group carrying this wave's
 *   landed Runners + Variables items beside Job queue. The shared nav's
 *   union cannot grow from this module (admin-users.tsx is outside the wave's
 *   ownership — the repo twin's mount-scaffolding precedent); the HANDOFF
 *   recipes carry the admin-users.tsx extension and the swap of BOTH this
 *   module's and the variables module's shells onto AdminFamilyShell (the
 *   repo twin's reported fold-back convention). The Scoped Workflows item
 *   stays OMITTED even here — its page is not served (the reduction below),
 *   the dead-link rule.
 * - SCOPED WORKFLOWS IS NOT SERVED (web.go:903's group arm): upstream's page
 *   rides the `action_scoped_workflow_source` store (models/actions/
 *   scoped_workflow.go — per-owner registered source repos with the
 *   WorkflowConfigs required/patterns JSON), the workflow-file parser
 *   (services/actions.LoadParsedScopedWorkflows over the source default
 *   branch) and the merge-gate integration. NONE of that substrate is landed
 *   (no table in the M1a migration 0041/0042, no parser service) — faking it
 *   would violate the feasibility discipline. The routes stay unclaimed
 *   (the engine's 404); the reduction is recorded in the orchestrator's
 *   survey copy.
 *
 * ## HANDOFF (the ui/index.ts mount — the orchestrator window's arms)
 *
 * The parse block sits in the ADMIN literal family (the `/-/admin` prefix —
 * beside the job-queue arm's shape, `tail` being the segments after
 * "/-/admin"):
 *
 * 1. Families (the admin family union, beside "admin-actions-job-queue"):
 *
 *     | "admin-actions-runners" // GET /-/admin/actions/runners
 *     | "admin-actions-runners-token-reset" // POST .../runners/reset_registration_token
 *     | "admin-actions-runners-edit" // GET+POST .../runners/{id} (page + description)
 *     | "admin-actions-runners-update" // POST .../runners/{id}/update-runner
 *     | "admin-actions-runners-delete" // POST .../runners/{id}/delete
 *     | "admin-actions-runners-bulk" // POST .../runners/bulk
 *
 * 2. Parse arms (inside the admin block, BEFORE the job_queue literal is
 *    fine — the tails are disjoint; static-first order):
 *
 *     if (tail.length === 3 && tail[0] === "actions" && tail[1] === "runners" && tail[2] === "bulk")
 *       return { family: "admin-actions-runners-bulk" };
 *     if (tail.length === 3 && tail[0] === "actions" && tail[1] === "runners" && tail[2] === "reset_registration_token")
 *       return { family: "admin-actions-runners-token-reset" };
 *     if (tail.length === 3 && tail[0] === "actions" && tail[1] === "runners" && /^\d+$/.test(tail[2]))
 *       return { family: "admin-actions-runners-edit", id: Number.parseInt(tail[2], 10) };
 *     if (tail.length === 4 && tail[0] === "actions" && tail[1] === "runners" && /^\d+$/.test(tail[2]) && tail[3] === "update-runner")
 *       return { family: "admin-actions-runners-update", id: Number.parseInt(tail[2], 10) };
 *     if (tail.length === 4 && tail[0] === "actions" && tail[1] === "runners" && /^\d+$/.test(tail[2]) && tail[3] === "delete")
 *       return { family: "admin-actions-runners-delete", id: Number.parseInt(tail[2], 10) };
 *     if (tail.length === 2 && tail[0] === "actions" && tail[1] === "runners")
 *       return { family: "admin-actions-runners" };
 *
 *    (the {id} combo AFTER the static tails; deeper tails stay unclaimed).
 *    The bare group literal (upstream's ./actions/runners LocationRedirect)
 *    rides recipe-only — no family needed:
 *
 *     if (tail.length === 1 && tail[0] === "actions") return { family: "admin-actions-redirect" };
 *
 *    (or an inline handler at the registration; the orchestrator's pick).
 * 3. Import:
 *
 *     import {
 *       loadAdminActionsRunnerEditPageData,
 *       loadAdminActionsRunnersPageData,
 *       parseAdminActionsRunnerBulkForm,
 *       parseAdminActionsRunnerDescriptionForm,
 *       parseAdminActionsRunnerDisabledForm,
 *       renderAdminActionsRunnerEditPage,
 *       renderAdminActionsRunnersPage,
 *       bulkAdminActionsRunners,
 *       deleteAdminActionsRunner,
 *       resetAdminActionsRunnerToken,
 *       setAdminActionsRunnerDisabled,
 *       updateAdminActionsRunnerDescription,
 *     } from "./pages/admin-actions-runners";
 *
 * 4. Handlers (the family prologue; writes sameOriginGuard-first; the list
 *    URL constant is "/-/admin/actions/runners"):
 *
 *     async function adminActionsRunnersPage(c: Context<{ Bindings: Env }>): Promise<Response> {
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const data = await loadAdminActionsRunnersPageData(c.env.DB, new URL(c.req.raw.url).searchParams);
 *       return p.respond(c.html(renderAdminActionsRunnersPage(p.ctx, data), 200));
 *     }
 *
 *     async function adminActionsRunnersTokenReset(c: Context<{ Bindings: Env }>): Promise<Response> {
 *       const guard = sameOriginGuard(c.req.raw);
 *       if (guard !== null) return guard;
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       await resetAdminActionsRunnerToken(c.env.DB);
 *       return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/runners" } }));
 *     }
 *
 *     async function adminActionsRunnerEditPage(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const data = await loadAdminActionsRunnerEditPageData(c.env.DB, runnerId, new URL(c.req.raw.url).searchParams);
 *       if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       return p.respond(c.html(renderAdminActionsRunnerEditPage(p.ctx, data), 200));
 *     }
 *
 *     async function adminActionsRunnerEditSubmit(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
 *       const guard = sameOriginGuard(c.req.raw);
 *       if (guard !== null) return guard;
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const form = parseAdminActionsRunnerDescriptionForm(await readUrlEncodedForm(c.req.raw));
 *       const outcome = await updateAdminActionsRunnerDescription(c.env.DB, runnerId, form.description);
 *       if (outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/runners" } }));
 *     }
 *
 *     async function adminActionsRunnerUpdate(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
 *       const guard = sameOriginGuard(c.req.raw);
 *       if (guard !== null) return guard;
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const form = parseAdminActionsRunnerDisabledForm(await readUrlEncodedForm(c.req.raw));
 *       if (form.disabled === null) {
 *         return p.respond(new Response("missing 'disabled' parameter\n", { status: 400, headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" } }));
 *       }
 *       const outcome = await setAdminActionsRunnerDisabled(c.env.DB, runnerId, form.disabled);
 *       if (outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       return p.respond(new Response(null, { status: 303, headers: { location: `/-/admin/actions/runners/${runnerId}` } }));
 *     }
 *
 *     async function adminActionsRunnerDelete(c: Context<{ Bindings: Env }>, runnerId: number): Promise<Response> {
 *       const guard = sameOriginGuard(c.req.raw);
 *       if (guard !== null) return guard;
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const outcome = await deleteAdminActionsRunner(c.env.DB, runnerId);
 *       if (outcome === "missing") return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/runners" } }));
 *     }
 *
 *     async function adminActionsRunnersBulk(c: Context<{ Bindings: Env }>): Promise<Response> {
 *       const guard = sameOriginGuard(c.req.raw);
 *       if (guard !== null) return guard;
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const form = parseAdminActionsRunnerBulkForm(await readUrlEncodedForm(c.req.raw));
 *       const outcome = await bulkAdminActionsRunners(c.env.DB, form);
 *       if (outcome === "invalid-ids") {
 *         return p.respond(new Response("missing runner IDs\n", { status: 400, headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" } }));
 *       }
 *       if (outcome === "invalid-action") {
 *         return p.respond(new Response("invalid action\n", { status: 400, headers: { "content-type": "text/plain;charset=utf-8", "x-content-type-options": "nosniff" } }));
 *       }
 *       return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/actions/runners" } }));
 *     }
 *
 * 5. Registrations (the static block, beside the job-queue lines — static
 *    literals before any dynamic arm; the POST-only shapes' GET twins answer
 *    the methodNotAllowed arm, the method-blind parse convention):
 *
 *     uiRouter.get("/-/admin/actions", (c) => /* 303, upstream LocationRedirect bytes * / p303(c, "./actions/runners"));
 *     uiRouter.get("/-/admin/actions/runners", (c) => adminActionsRunnersPage(c));
 *     uiRouter.get("/-/admin/actions/runners/:id{\\d+}", (c) => adminActionsRunnerEditPage(c, Number.parseInt(c.req.param("id"), 10)));
 *     uiRouter.post("/-/admin/actions/runners/reset_registration_token", (c) => adminActionsRunnersTokenReset(c));
 *     uiRouter.post("/-/admin/actions/runners/bulk", (c) => adminActionsRunnersBulk(c));
 *     uiRouter.post("/-/admin/actions/runners/:id{\\d+}", (c) => adminActionsRunnerEditSubmit(c, Number.parseInt(c.req.param("id"), 10)));
 *     uiRouter.get("/-/admin/actions/runners/reset_registration_token", () => methodNotAllowed("POST"));
 *     uiRouter.get("/-/admin/actions/runners/bulk", () => methodNotAllowed("POST"));
 *     uiRouter.post("/-/admin/actions/runners/:id{\\d+}/update-runner", (c) => adminActionsRunnerUpdate(c, Number.parseInt(c.req.param("id"), 10)));
 *     uiRouter.post("/-/admin/actions/runners/:id{\\d+}/delete", (c) => adminActionsRunnerDelete(c, Number.parseInt(c.req.param("id"), 10)));
 *     uiRouter.get("/-/admin/actions/runners/:id{\\d+}/update-runner", () => methodNotAllowed("POST"));
 *     uiRouter.get("/-/admin/actions/runners/:id{\\d+}/delete", () => methodNotAllowed("POST"));
 *
 *    (the bare /-/admin/actions GET answers 303 with the EXACT relative
 *    bytes "./actions/runners" behind the prologue — upstream
 *    misc.LocationRedirect, routers/web/misc/misc.go:76-80, StatusSeeOther;
 *    upstream mounts it INSIDE adminReq, so the prologue gates the redirect).
 * 6. The shared-nav extension (admin-users.tsx — the integrator fold, the
 *    C6 precedent's exact shape): `AdminFamilyNavActive` gains
 *    `"actions-runners" | "actions-variables"`, `adminFamilyLocale` gains
 *    `runners: "Runners"` ("actions.runners") and `variables: "Variables"`
 *    ("actions.variables"), AdminFamilyNav's Actions group gains the two
 *    items before Job queue, `actionsOpen` covers the two new members — then
 *    BOTH this module's and admin-actions-variables.tsx's renders swap the
 *    local AdminActionsNav + BaseLayout wrapper for AdminFamilyShell (delete
 *    the local nav, the repo twin's fold-back convention).
 * 7. The neighbor pins that flip at this window: pages/repo-actions-queue.test.tsx's
 *    `parseUiRoute("/-/admin/actions/runners")` null pin (repo-actions-queue.test.tsx:433)
 *    and admin-users.matrix.test.tsx:328-330's navbar not-contains pins
 *    (only if step 6 lands). This module's own unclaimed-route pins flip in
 *    the same window (the test header's note).
 */

import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRunJobs, actionRunners, actionTasks, repositories, users } from "../../db/schema";
import { getOrCreateActiveRunnerToken, newRunnerToken, type RunnerRow } from "../../services/actions/model";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { TimeSince } from "../components/file-list";
import { shortSha } from "../page-data";
import { actionsStatusLocaleText, actionsStatusToString } from "./repo-actions-queue";
import {
  parseRepoActionsRunnerDescriptionForm,
  parseRepoActionsRunnerDisabledForm,
  repoSettingsRunnersLocale,
  runnerBelongsTo,
  runnerStatusClass,
  runnerStatusLocaleText,
  runnerStatusOf,
  runnersOrderBy,
  RUNNERS_PAGE_SIZE,
  RUNNER_EDIT_TASKS_PAGE_SIZE,
  type RunnerBelongsTo,
  type RunnerTaskView,
  type RunnerView,
} from "./repo-settings-actions-runners";
import { AdminFamilyPagination, adminFamilyLocale } from "./admin-users";

// ---------------------------------------------------------------------------
// Locale (this module adds only the strings its pages cite beyond the shared
// repo twin's vocabulary — every string cites its upstream key)
// ---------------------------------------------------------------------------

export const adminActionsRunnersLocale = {
  edit_runner: "Edit Runner", // "actions.runners.edit_runner" (the edit page's Title, runners.go:167)
  total_count: "Total:", // "admin.total" = 'Total: %d' — the count renders beside it (runner_list.tmpl:4)
  selectRow: "Check/Uncheck", // "repo.issues.action_check" (the per-row checkbox's aria-label prefix, runner_list.tmpl:113)
} as const;

// ---------------------------------------------------------------------------
// The module-local admin navbar (the mount-scaffolding convention — the
// module header's nav note): the landed AdminFamilyNav's structure with the
// Actions group carrying this wave's Runners + Variables items beside Job
// queue. The Scoped Workflows item stays omitted (the page is not served —
// the dead-link rule). The HANDOFF's step 6 folds this into the shared nav.
// ---------------------------------------------------------------------------

export type AdminActionsNavActive = "actions-runners" | "actions-variables";

export function AdminActionsNav(props: { active: AdminActionsNavActive }) {
  const item = (href: string, label: string, active: boolean) => (
    <a class={active ? "active item" : "item"} href={href}>
      {label}
    </a>
  );
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{adminFamilyLocale.settings}</div>
        <details class="item">
          <summary>{adminFamilyLocale.maintenance}</summary>
          <div class="menu">{item("/-/admin", adminFamilyLocale.dashboard, false)}</div>
        </details>
        <details class="item">
          <summary>{adminFamilyLocale.identityAccess}</summary>
          <div class="menu">
            {item("/-/admin/orgs", adminFamilyLocale.organizations, false)}
            {item("/-/admin/users", adminFamilyLocale.userAccounts, false)}
            {item("/-/admin/badges", adminFamilyLocale.badges, false)}
            {item("/-/admin/emails", adminFamilyLocale.emails, false)}
          </div>
        </details>
        <details class="item">
          <summary>{adminFamilyLocale.assets}</summary>
          <div class="menu">
            {item("/-/admin/repos", adminFamilyLocale.repositories, false)}
          </div>
        </details>
        <details class="item">
          <summary>{adminFamilyLocale.integrations}</summary>
          <div class="menu">
            {item("/-/admin/applications", adminFamilyLocale.applications, false)}
            {item("/-/admin/hooks", adminFamilyLocale.hooks, false)}
          </div>
        </details>
        <details class="item">
          <summary>{adminFamilyLocale.configuration}</summary>
          <div class="menu">{item("/-/admin/config", adminFamilyLocale.configSummary, false)}</div>
        </details>
        {item("/-/admin/notices", adminFamilyLocale.notices, false)}
        {/* navbar.tmpl:73-89 — the Actions group with this wave's landed
            items (Runners :78-80, Variables :81-83) beside the C6 Job-queue
            item (:87-89). Scoped Workflows (:84-86) stays omitted — its page
            is not served (the module header's reduction; the dead-link
            rule). */}
        <details class="item" open>
          <summary>{adminFamilyLocale.actions}</summary>
          <div class="menu">
            {item("/-/admin/actions/runners", repoSettingsRunnersLocale.runner_title, props.active === "actions-runners")}
            {item("/-/admin/actions/variables", "Variables", props.active === "actions-variables")}
            {item("/-/admin/actions/job_queue", adminFamilyLocale.jobQueue, false)}
          </div>
        </details>
        <details class="item">
          <summary>{adminFamilyLocale.monitoring}</summary>
          <div class="menu">
            {item("/-/admin/monitor/stats", adminFamilyLocale.stats, false)}
            {item("/-/admin/monitor/cron", adminFamilyLocale.cron, false)}
            {item("/-/admin/monitor/queue", adminFamilyLocale.queues, false)}
            {item("/-/admin/monitor/stacktrace", adminFamilyLocale.trace, false)}
          </div>
        </details>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The list query (FindRunnerOptions.ToConds over the ADMIN scope — no scope
// cond: every runner lists)
// ---------------------------------------------------------------------------

export interface AdminActionsRunnersPageData {
  runners: RunnerView[];
  total: number;
  page: number;
  more: boolean;
  /** The echoed `?q=` (the search input's value arm). */
  query: string;
  /** The echoed `?sort=` (the SortArrow arm reads it). */
  sortType: string;
  /** The GLOBAL scope's active registration token (GetOrCreateActiveRunnerToken(0, 0) —
   *  reused while active; a reset mints the next). */
  registrationToken: string;
}

/**
 * Runners (runners.go:102-155) at the ADMIN scope: the list opts carry NO
 * RepoID/OwnerID and WithAvailable stays FALSE — ToConds' scope branches
 * never ride and EVERY runner lists (repo-scoped, owner-scoped, global,
 * foreign — the instance-wide census). q + sort + page over the shared
 * ladder, then GetOrCreateActiveRunnerToken(0, 0) — the bare GET CREATES the
 * global scope's first token exactly like upstream (runner_token.go:127-134).
 */
export async function loadAdminActionsRunnersPageData(
  d1: D1Database,
  search: URLSearchParams,
  now: Date = new Date(),
): Promise<AdminActionsRunnersPageData> {
  const page = Math.max(Number.parseInt(search.get("page") ?? "", 10) || 1, 1);
  const query = search.get("q") ?? "";
  const sortType = search.get("sort") ?? "";

  const conds = [];
  if (query !== "") {
    conds.push(like(actionRunners.name, `%${query}%`));
  }
  const db = drizzle(d1);
  const totalRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(actionRunners)
    .where(conds.length > 0 ? and(...conds) : undefined);
  const total = Number(totalRows[0]?.count ?? 0);

  const rows =
    total === 0
      ? []
      : await db
          .select()
          .from(actionRunners)
          .where(conds.length > 0 ? and(...conds) : undefined)
          .orderBy(...runnersOrderBy(sortType, now))
          .limit(RUNNERS_PAGE_SIZE)
          .offset((page - 1) * RUNNERS_PAGE_SIZE);

  // RunnerList.LoadAttributes' batched belongs-to enrichment — at the admin
  // scope EVERY scope kind can appear, so both lookups ride (the org twin's
  // batched shape).
  const repoIdRefs = [...new Set(rows.map((row) => row.repoId).filter((id) => id !== ""))];
  const ownerIds = [...new Set(rows.map((row) => row.ownerId).filter((id) => id !== 0))];
  const [repoRows, ownerRows] = await Promise.all([
    repoIdRefs.length > 0
      ? db
          .select({ id: repositories.id, ownerNamespace: repositories.ownerNamespace, slug: repositories.slug })
          .from(repositories)
          .where(inArray(repositories.id, repoIdRefs))
          .all()
      : Promise.resolve([] as { id: string; ownerNamespace: string; slug: string }[]),
    ownerIds.length > 0
      ? db.select({ id: users.id, username: users.username, type: users.type }).from(users).where(inArray(users.id, ownerIds)).all()
      : Promise.resolve([] as { id: number; username: string; type: "user" | "org" }[]),
  ]);
  const reposById = new Map(repoRows.map((row) => [row.id, row]));
  const ownersById = new Map(ownerRows.map((row) => [row.id, row]));

  const token = await getOrCreateActiveRunnerToken(d1, 0, "");

  return {
    runners: rows.map((row) => {
      const repoRow = reposById.get(row.repoId);
      const ownerRow = ownersById.get(row.ownerId);
      return {
        row,
        status: runnerStatusOf(row, now),
        belongsTo: runnerBelongsTo(row, {
          repoFullName: repoRow !== undefined ? `${repoRow.ownerNamespace}/${repoRow.slug}` : null,
          ownerName: ownerRow?.username ?? null,
          ownerType: ownerRow?.type ?? null,
        }),
        agentLabels: (JSON.parse(row.agentLabels) as string[]) ?? [],
      };
    }),
    total,
    page,
    more: page * RUNNERS_PAGE_SIZE < total,
    query,
    sortType,
    registrationToken: token.token,
  };
}

// ---------------------------------------------------------------------------
// The write arms (ResetRunnerRegistrationToken / RunnersEditPost /
// RunnerUpdatePost / RunnerDeletePost / RunnerBulkActionPost — the ADMIN
// polarity: findActionsRunner's ID-only arm + EditableInContext(0, 0) = true)
// ---------------------------------------------------------------------------

/**
 * findActionsRunner's ADMIN arm (runners.go:448-450 — the switch's empty
 * case): resolve by ID with NO scope pin — ANY runner resolves (a global,
 * an org's, another scope's repo runner). A stale/junk id is the "missing"
 * arm (upstream's ctx.NotFound).
 */
export async function findAdminRunner(d1: D1Database, runnerId: number): Promise<RunnerRow | null> {
  if (!Number.isInteger(runnerId) || runnerId <= 0) {
    return null;
  }
  const rows = await drizzle(d1).select().from(actionRunners).where(eq(actionRunners.id, runnerId)).limit(1);
  return rows[0] ?? null;
}

/** EditableInContext's admin arm (runner.go:162-165): `ownerID == 0 &&
 *  repoID == 0` returns TRUE unconditionally — an admin edits EVERY runner
 *  (the twins' scope pins inverted; every row carries the pencil). */
export function runnerEditableInAdmin(): boolean {
  return true;
}

/** ResetRunnerRegistrationToken (runners.go:264-281): NewRunnerToken at the
 *  GLOBAL scope (0, 0) — the deactivate+insert batch mints the fresh active
 *  token and answers its RAW string. */
export async function resetAdminActionsRunnerToken(d1: D1Database): Promise<string> {
  const row = await newRunnerToken(d1, 0, "");
  return row.token;
}

/** RunnerDeletePost (runners.go:283-317): the hard delete — "missing"
 *  covers a stale/junk id (upstream's findActionsRunner NotFound arm) and
 *  deletes nothing. NO scope guard: an admin deletes ANY runner. */
export async function deleteAdminActionsRunner(d1: D1Database, runnerId: number): Promise<"deleted" | "missing"> {
  const runner = await findAdminRunner(d1, runnerId);
  if (runner === null) {
    return "missing";
  }
  await drizzle(d1).delete(actionRunners).where(eq(actionRunners.id, runner.id));
  return "deleted";
}

/** RunnersEditPost (runners.go:224-262): the description overwrite
 *  (UpdateRunner's "description" col) at the admin polarity. */
export async function updateAdminActionsRunnerDescription(
  d1: D1Database,
  runnerId: number,
  description: string,
): Promise<"updated" | "missing"> {
  const runner = await findAdminRunner(d1, runnerId);
  if (runner === null) {
    return "missing";
  }
  await drizzle(d1)
    .update(actionRunners)
    .set({ description, updated: new Date() })
    .where(eq(actionRunners.id, runner.id));
  return "updated";
}

/** RunnerUpdatePost (runners.go:319-358): the required `disabled` flip
 *  (SetRunnerDisabled). "missing" for a stale/junk id; the caller answers
 *  400 when the param is absent (the missing-parameter arm). */
export async function setAdminActionsRunnerDisabled(
  d1: D1Database,
  runnerId: number,
  disabled: boolean,
): Promise<"updated" | "missing"> {
  const runner = await findAdminRunner(d1, runnerId);
  if (runner === null) {
    return "missing";
  }
  await drizzle(d1)
    .update(actionRunners)
    .set({ isDisabled: disabled, updated: new Date() })
    .where(eq(actionRunners.id, runner.id));
  return "updated";
}

// ---------------------------------------------------------------------------
// The bulk arm (RunnerBulkActionPost, runners.go:360-430)
// ---------------------------------------------------------------------------

/** The bulk POST body (upstream `ids` — FormStringInt64s' comma-list — and
 *  `action`). `ids: null` is the voided-parse arm: ANY junk entry nils the
 *  whole list upstream (modules/base/tool.go:95-108's error return the
 *  `vals, _ :=` discards), empty entries skip. */
export interface AdminActionsRunnerBulkForm {
  ids: number[] | null;
  action: string;
}

export function parseAdminActionsRunnerBulkForm(params: URLSearchParams): AdminActionsRunnerBulkForm {
  const raw = params.get("ids") ?? "";
  const parts = raw.split(",");
  const ids: number[] = [];
  for (const part of parts) {
    if (part === "") continue;
    if (!/^\d+$/.test(part)) {
      return { ids: null, action: params.get("action") ?? "" };
    }
    ids.push(Number.parseInt(part, 10));
  }
  return { ids: ids.length > 0 ? ids : null, action: params.get("action") ?? "" };
}

/** The bulk outcomes: the two junk arms answer BEFORE any write (upstream's
 *  400s); "applied" covers both the success and the empty-find no-op. */
export type AdminActionsRunnerBulkOutcome = "applied" | "invalid-ids" | "invalid-action";

/**
 * RunnerBulkActionPost (:360-430): the ids resolve through Find (missing ids
 * skip silently — an EMPTY find is a successful no-op), then the delete /
 * disable / enable loop. Upstream wraps the loop in one transaction; D1
 * batches what it can — the sequential loop is the documented seam (each
 * write is independent and idempotent, the partial-failure window upstream's
 * rollback closes).
 */
export async function bulkAdminActionsRunners(d1: D1Database, form: AdminActionsRunnerBulkForm): Promise<AdminActionsRunnerBulkOutcome> {
  if (form.ids === null || form.ids.length === 0) {
    return "invalid-ids";
  }
  if (form.action !== "delete" && form.action !== "disable" && form.action !== "enable") {
    return "invalid-action";
  }
  const runners = await drizzle(d1).select().from(actionRunners).where(inArray(actionRunners.id, form.ids));
  for (const runner of runners) {
    if (form.action === "delete") {
      await drizzle(d1).delete(actionRunners).where(eq(actionRunners.id, runner.id));
    } else {
      await drizzle(d1)
        .update(actionRunners)
        .set({ isDisabled: form.action === "disable", updated: new Date() })
        .where(eq(actionRunners.id, runner.id));
    }
  }
  return "applied";
}

// ---------------------------------------------------------------------------
// The form parsers (the shared scope-neutral readers — admin-named delegates
// to the repo twin's URLSearchParams readers)
// ---------------------------------------------------------------------------

export function parseAdminActionsRunnerDescriptionForm(params: URLSearchParams): { description: string } {
  return parseRepoActionsRunnerDescriptionForm(params);
}

export function parseAdminActionsRunnerDisabledForm(params: URLSearchParams): { disabled: boolean | null } {
  return parseRepoActionsRunnerDisabledForm(params);
}

// ---------------------------------------------------------------------------
// The edit page's recent tasks (RunnersEdit — FindTaskOptions over the
// runner, pageSize 30, `id DESC`) — the org twin's loader at the admin
// polarity (no scope find; the belongs-to enrichment spans every scope kind)
// ---------------------------------------------------------------------------

export interface AdminActionsRunnerEditPageData {
  runner: RunnerRow;
  runnerStatus: ReturnType<typeof runnerStatusOf>;
  agentLabels: string[];
  belongsTo: RunnerBelongsTo;
  tasks: RunnerTaskView[];
  page: number;
  more: boolean;
}

/**
 * RunnersEdit (runners.go:158-216) at the admin scope: the runner by ID
 * (EditableInContext(0,0) is vacuously true — null is the NotFound arm
 * alone) plus one page of its recent tasks with the job/repo attributes
 * loaded (TaskList.LoadAttributes' batched shape, the twins' loader).
 */
export async function loadAdminActionsRunnerEditPageData(
  d1: D1Database,
  runnerId: number,
  search: URLSearchParams,
  now: Date = new Date(),
): Promise<AdminActionsRunnerEditPageData | null> {
  const runner = await findAdminRunner(d1, runnerId);
  if (runner === null) {
    return null;
  }
  const page = Math.max(Number.parseInt(search.get("page") ?? "", 10) || 1, 1);
  const db = drizzle(d1);
  const taskConds = [eq(actionTasks.runnerId, runner.id)];
  const totalRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(actionTasks)
    .where(and(...taskConds));
  const total = Number(totalRows[0]?.count ?? 0);
  const taskRows =
    total === 0
      ? []
      : await db
          .select()
          .from(actionTasks)
          .where(and(...taskConds))
          .limit(RUNNER_EDIT_TASKS_PAGE_SIZE)
          .offset((page - 1) * RUNNER_EDIT_TASKS_PAGE_SIZE)
          .orderBy(desc(actionTasks.id));

  // TaskList.LoadAttributes (task_list.go:63-70): the jobs, then the repos
  // for the Repository/Commit cells (the twins' batched reads).
  const jobIds = [...new Set(taskRows.map((task) => task.jobId).filter((id) => id > 0))];
  const taskRepoIds = [...new Set(taskRows.map((task) => task.repoId))];
  const [jobRows, taskRepoRows] = await Promise.all([
    jobIds.length > 0
      ? db.select({ id: actionRunJobs.id, runId: actionRunJobs.runId }).from(actionRunJobs).where(inArray(actionRunJobs.id, jobIds)).all()
      : Promise.resolve([] as { id: number; runId: number }[]),
    taskRepoIds.length > 0
      ? db
          .select({ id: repositories.id, ownerNamespace: repositories.ownerNamespace, slug: repositories.slug })
          .from(repositories)
          .where(inArray(repositories.id, taskRepoIds))
          .all()
      : Promise.resolve([] as { id: string; ownerNamespace: string; slug: string }[]),
  ]);
  const jobsById = new Map(jobRows.map((row) => [row.id, row]));
  const taskReposById = new Map(taskRepoRows.map((row) => [row.id, row]));

  // The runner's OWN belongs-to enrichment (LoadAttributes runner.go:170-186).
  let repoFullName: string | null = null;
  let ownerName: string | null = null;
  let ownerType: "user" | "org" | null = null;
  if (runner.repoId !== "") {
    const repoRow = (
      await db
        .select({ ownerNamespace: repositories.ownerNamespace, slug: repositories.slug })
        .from(repositories)
        .where(eq(repositories.id, runner.repoId))
        .limit(1)
    )[0];
    repoFullName = repoRow !== undefined ? `${repoRow.ownerNamespace}/${repoRow.slug}` : null;
  } else if (runner.ownerId !== 0) {
    const ownerRow = (
      await db
        .select({ username: users.username, type: users.type })
        .from(users)
        .where(eq(users.id, runner.ownerId))
        .limit(1)
    )[0];
    ownerName = ownerRow?.username ?? null;
    ownerType = ownerRow?.type ?? null;
  }

  return {
    runner,
    runnerStatus: runnerStatusOf(runner, now),
    agentLabels: (JSON.parse(runner.agentLabels) as string[]) ?? [],
    belongsTo: runnerBelongsTo(runner, { repoFullName, ownerName, ownerType }),
    tasks: taskRows.map((task) => {
      const taskRepo = taskReposById.get(task.repoId);
      return {
        id: task.id,
        jobId: jobsById.has(task.jobId) ? task.jobId : null,
        status: task.status,
        repoLink: taskRepo !== undefined ? `/${taskRepo.ownerNamespace}/${taskRepo.slug}` : null,
        repoFullName: taskRepo !== undefined ? `${taskRepo.ownerNamespace}/${taskRepo.slug}` : null,
        commitSha: task.commitSha,
        stopped: task.stopped,
      };
    }),
    page,
    more: page * RUNNER_EDIT_TASKS_PAGE_SIZE < total,
  };
}

// ---------------------------------------------------------------------------
// The render — admin/actions.tmpl PageType "runners" over
// shared/actions/runner_list.tmpl, and admin/runners/edit.tmpl
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern — index.ts stays a
 *  pure-TS router module). */
export function renderAdminActionsRunnersPage(ctx: UiContext, data: AdminActionsRunnersPageData): string {
  return renderPage(<AdminActionsRunnersPage ctx={ctx} data={data} />);
}

/** The runners list page (§2.4.1 discriminator: `admin actions` —
 *  admin/actions.tmpl's layout_head dict; upstream's Title is
 *  `actions.actions`, runners.go:103). */
export function AdminActionsRunnersPage(props: { ctx: UiContext; data: AdminActionsRunnersPageData }) {
  const { ctx, data } = props;
  const base = "/-/admin/actions/runners";
  const pagerQuery = new URLSearchParams();
  if (data.query !== "") pagerQuery.set("q", data.query);
  if (data.sortType !== "") pagerQuery.set("sort", data.sortType);
  return (
    <BaseLayout ctx={ctx} title={repoSettingsRunnersLocale.actions} pageClass="admin actions">
      <div class="ui container fluid padded flex-container">
        <AdminActionsNav active="actions-runners" />
        <div class="flex-container-main">
          <div class="admin-setting-content">
            {/* runner_list.tmpl:3-37 — the header with the count in the
                admin.total form ("Total: %d") and the token panel (the
                dropdown reduced inline; the module header). */}
            <h4 class="ui top attached header">
              {repoSettingsRunnersLocale.runner_manage_panel} ({adminActionsRunnersLocale.total_count} {data.total})
            </h4>
            <div class="ui attached segment" id="runner-registration-token-panel">
              <div>
                <a href="https://docs.gitea.com/usage/actions/runner" target="_blank" rel="noopener noreferrer">
                  {repoSettingsRunnersLocale.new_notice}
                </a>
              </div>
              <div class="ui divider" />
              <div class="ui header">{repoSettingsRunnersLocale.registration_token}</div>
              <div class="ui action input">
                <input type="text" value={data.registrationToken} readonly aria-label={repoSettingsRunnersLocale.registration_token} />
                <button
                  type="button"
                  class="ui basic label button"
                  aria-label={repoSettingsRunnersLocale.copy}
                  data-clipboard-text={data.registrationToken}
                >
                  {repoSettingsRunnersLocale.copy}
                </button>
              </div>
              <div class="ui divider" />
              {/* The reset arm — upstream's link-action + confirm modal
                  reduced to the plain form (the twins' header). */}
              <form method="post" action={`${base}/reset_registration_token`}>
                <button type="submit" class="link-action">
                  {repoSettingsRunnersLocale.reset_registration_token}
                </button>
              </form>
            </div>
            {/* The search segment (runner_list.tmpl:33-37). */}
            <div class="ui attached segment">
              <form class="ui form ignore-dirty" id="user-list-search-form" action={base} method="get">
                <div class="ui small icon input">
                  <input name="q" value={data.query} placeholder={repoSettingsRunnersLocale.search_runners} />
                </div>
              </form>
            </div>
            {/* AllowBulkActions is TRUE at the admin scope
                (runners.go:155) — the bulk toolbar reduced to the
                admin-notices idiom: ONE form wrapping the table + the
                toolbar (the module header; the JS select-all and confirm
                modals omitted). */}
            {data.runners.length > 0 ? (
              <form method="post" action={`${base}/bulk`}>
                <div class="ui attached table segment">
                  <table class="ui very basic table unstackable">
                    <thead>
                      <tr>
                        {/* The AllowBulkActions checkbox column
                            (runner_list.tmpl:59-61); the select-all
                            checkbox is JS-wired upstream and stays
                            omitted (the module header). */}
                        <th class="tw-w-8" aria-label={adminActionsRunnersLocale.selectRow} />
                        {/* The sort headers' data-sortt attributes ride
                            verbatim (runner_list.tmpl:62-84). */}
                        <th data-sortt-asc="alphabetically" data-sortt-desc="reversealphabetically">
                          {repoSettingsRunnersLocale.runner_title}
                        </th>
                        <th data-sortt-asc="online" data-sortt-desc="offline">
                          {repoSettingsRunnersLocale.status}
                        </th>
                        <th data-sortt-asc="newest" data-sortt-desc="oldest">
                          {repoSettingsRunnersLocale.id}
                        </th>
                        <th>{repoSettingsRunnersLocale.version}</th>
                        <th>{repoSettingsRunnersLocale.owner_type}</th>
                        <th>{repoSettingsRunnersLocale.labels}</th>
                        <th>{repoSettingsRunnersLocale.last_online}</th>
                        <th>{repoSettingsRunnersLocale.edit}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.runners.map((runner) => (
                        <tr>
                          <td>
                            <input
                              type="checkbox"
                              name="ids"
                              value={String(runner.row.id)}
                              aria-label={`${adminActionsRunnersLocale.selectRow}: ${runner.row.name}`}
                            />
                          </td>
                          <td>
                            <p data-tooltip-content={runner.row.description}>{runner.row.name}</p>
                          </td>
                          <td>
                            <span class={`ui label ${runnerStatusClass(runner.status)}`}>{runnerStatusLocaleText(runner.status)}</span>
                            {runner.row.isDisabled ? <span class="ui grey label">{repoSettingsRunnersLocale.disabled}</span> : null}
                          </td>
                          <td>{runner.row.id}</td>
                          <td>{runner.row.version !== "" ? runner.row.version : repoSettingsRunnersLocale.unknown}</td>
                          <td>
                            {runner.belongsTo.tooltip !== null ? (
                              <span data-tooltip-content={runner.belongsTo.tooltip}>{runner.belongsTo.text}</span>
                            ) : (
                              <span>{runner.belongsTo.text}</span>
                            )}
                          </td>
                          <td>
                            <span class="flex-text-inline tw-flex-wrap">
                              {runner.agentLabels.map((label) => (
                                <span class="ui label">{label}</span>
                              ))}
                            </span>
                          </td>
                          <td>
                            {runner.row.lastOnline !== null ? (
                              <TimeSince unixSeconds={runner.row.lastOnline.getTime() / 1000} tz="+0000" />
                            ) : (
                              repoSettingsRunnersLocale.never
                            )}
                          </td>
                          {/* EditableInContext(0, 0) is TRUE for every row
                              (runner.go:162-165) — the pencil is
                              unconditional at the admin scope
                              (runner_list.tmpl:118-122). */}
                          <td>
                            <a href={`${base}/${runner.row.id}`} aria-label={repoSettingsRunnersLocale.edit}>
                              <Icon name="octicon-pencil" />
                            </a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {/* The bulk toolbar's three submits (runner_list.tmpl:41-52
                    reduced; the confirm modal omitted — the module
                    header). */}
                <div class="ui attached segment">
                  <button type="submit" class="ui small button" name="action" value="disable">
                    {repoSettingsRunnersLocale.disable_runner}
                  </button>
                  <button type="submit" class="ui small button" name="action" value="enable">
                    {repoSettingsRunnersLocale.enable_runner}
                  </button>
                  <button type="submit" class="ui small red button" name="action" value="delete">
                    {repoSettingsRunnersLocale.delete_runner}
                  </button>
                </div>
              </form>
            ) : (
              <div class="ui attached segment tw-text-center">{repoSettingsRunnersLocale.none}</div>
            )}
            {/* base/paginate — the family pager keeping the q + sort
                facets. */}
            <AdminFamilyPagination basePath={base} query={pagerQuery} page={data.page} more={data.more} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-document render. */
export function renderAdminActionsRunnerEditPage(ctx: UiContext, data: AdminActionsRunnerEditPageData): string {
  return renderPage(<AdminActionsRunnerEditPage ctx={ctx} data={data} />);
}

/** The runner edit page (tplAdminRunnerEdit — admin/runners/edit.tmpl; the
 *  `admin runners` pageClass, edit.tmpl:1). */
export function AdminActionsRunnerEditPage(props: { ctx: UiContext; data: AdminActionsRunnerEditPageData }) {
  const { ctx, data } = props;
  const base = "/-/admin/actions/runners";
  const runnerLink = `${base}/${data.runner.id}`;
  return (
    <BaseLayout ctx={ctx} title={adminActionsRunnersLocale.edit_runner} pageClass="admin runners">
      <div class="ui container fluid padded flex-container">
        <AdminActionsNav active="actions-runners" />
        <div class="flex-container-main">
          <div class="admin-setting-content">
            {/* runner_edit.tmpl:2-4 (shared/actions/runner_edit) — the
                header. */}
            <h4 class="ui top attached header">
              {repoSettingsRunnersLocale.runner_title} {data.runner.id} {data.runner.name}
            </h4>
            <div class="ui attached segment">
              {/* The basic-info fields (runner_edit.tmpl:7-31). */}
              <div class="runner-basic-info">
                <div class="field tw-inline-block tw-mr-4">
                  <label>{repoSettingsRunnersLocale.status}</label>
                  <span class={`ui ${data.runnerStatus === "offline" ? "basic" : "green"} label`}>
                    {runnerStatusLocaleText(data.runnerStatus)}
                  </span>
                </div>
                <div class="field tw-inline-block tw-mr-4">
                  <label>{repoSettingsRunnersLocale.availability}</label>
                  <span class={`ui ${data.runner.isDisabled ? "grey" : "green"} label`}>
                    {data.runner.isDisabled ? repoSettingsRunnersLocale.disabled : repoSettingsRunnersLocale.enabled}
                  </span>
                </div>
                <div class="field tw-inline-block tw-mr-4">
                  <label>{repoSettingsRunnersLocale.last_online}</label>
                  <span>
                    {data.runner.lastOnline !== null ? (
                      <TimeSince unixSeconds={data.runner.lastOnline.getTime() / 1000} tz="+0000" />
                    ) : (
                      repoSettingsRunnersLocale.never
                    )}
                  </span>
                </div>
                <div class="field tw-inline-block tw-mr-4">
                  <label>{repoSettingsRunnersLocale.labels}</label>
                  <span class="flex-text-inline tw-flex-wrap">
                    {data.agentLabels.map((label) => (
                      <span class="ui label">{label}</span>
                    ))}
                  </span>
                </div>
                <div class="field tw-inline-block tw-mr-4">
                  <label>{repoSettingsRunnersLocale.owner_type}</label>
                  <span>
                    {data.belongsTo.tooltip !== null ? (
                      <span data-tooltip-content={data.belongsTo.tooltip}>{data.belongsTo.text}</span>
                    ) : (
                      data.belongsTo.text
                    )}
                  </span>
                </div>
              </div>
              <div class="divider" />
              {/* The description form (runner_edit.tmpl:33-42) — the submit
                  is the Update Changes button; the enable/disable and
                  delete arms reduce to the plain POST forms beside it (the
                  twins' header). */}
              <form class="ui form" method="post" action={runnerLink}>
                <div class="field">
                  <label for="description">{repoSettingsRunnersLocale.description}</label>
                  <input id="description" name="description" value={data.runner.description} />
                </div>
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {repoSettingsRunnersLocale.update_runner}
                  </button>
                </div>
              </form>
              <form class="tw-inline-block" method="post" action={`${runnerLink}/update-runner`}>
                <input type="hidden" name="disabled" value={data.runner.isDisabled ? "false" : "true"} />
                <button type="submit" class="ui button">
                  {data.runner.isDisabled ? repoSettingsRunnersLocale.enable_runner : repoSettingsRunnersLocale.disable_runner}
                </button>
              </form>
              <form class="tw-inline-block" method="post" action={`${runnerLink}/delete`}>
                <button type="submit" class="ui red button">
                  {repoSettingsRunnersLocale.delete_runner}
                </button>
              </form>
            </div>
            {/* The recent tasks (runner_edit.tmpl:45-86). */}
            <h4 class="ui top attached header">{repoSettingsRunnersLocale.task_list}</h4>
            <div class="ui attached segment">
              <table class="ui very basic table unstackable">
                <thead>
                  <tr>
                    <th>{repoSettingsRunnersLocale.task_list_job}</th>
                    <th>{repoSettingsRunnersLocale.task_list_status}</th>
                    <th>{repoSettingsRunnersLocale.task_list_repository}</th>
                    <th>{repoSettingsRunnersLocale.task_list_commit}</th>
                    <th>{repoSettingsRunnersLocale.task_list_done_at}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tasks.length > 0 ? (
                    data.tasks.map((task) => (
                      <tr>
                        {/* The GetRunJobLink reduction — the id renders as
                            text (the repo twin's header; its fold-back is
                            that module's follow-up). */}
                        <td>{task.jobId ?? task.id}</td>
                        <td>
                          <span class={`ui label task-status-${actionsStatusToString(task.status)}`}>
                            {actionsStatusLocaleText(task.status)}
                          </span>
                        </td>
                        <td>{task.repoLink !== null ? <a href={task.repoLink}>{task.repoFullName}</a> : null}</td>
                        <td>
                          {task.commitSha !== "" && task.repoLink !== null ? (
                            <a class="ui sha label" href={`${task.repoLink}/commit/${task.commitSha}`}>
                              {shortSha(task.commitSha)}
                            </a>
                          ) : null}
                        </td>
                        <td>{task.stopped !== null ? <TimeSince unixSeconds={task.stopped.getTime() / 1000} tz="+0000" /> : "-"}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colspan={5}>{repoSettingsRunnersLocale.task_list_no_tasks}</td>
                    </tr>
                  )}
                </tbody>
              </table>
              {data.page > 1 || data.more ? (
                <div class="center page buttons">
                  <div class="ui borderless pagination menu">
                    {data.page > 1 ? (
                      <a class="item navigation" href={`${runnerLink}?page=${data.page - 1}`}>
                        <span class="navigation_label">Newer</span>
                      </a>
                    ) : null}
                    {data.more ? (
                      <a class="item navigation" href={`${runnerLink}?page=${data.page + 1}`}>
                        <span class="navigation_label">Older</span>
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
