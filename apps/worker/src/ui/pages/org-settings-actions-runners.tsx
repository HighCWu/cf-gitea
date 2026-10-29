/**
 * The org settings ACTIONS tab's RUNNERS sub-tab — the census C7 arm's ORG
 * scope (the org twin of pages/repo-settings-actions-runners.tsx; the same
 * four-scope shared builders, ported from the pin
 * fc4936884584a41931906553d96c2601d750e6ef).
 *
 * Upstream sources (VERIFIED at the pin):
 *   - `routers/web/web.go:1058` — `addSettingsRunnersRoutes()` inside the org
 *     `/settings` `/actions` group (web.go:1051-1061), behind
 *     `context.OrgAssignment{RequireOwner: true}` (web.go:1092) and
 *     `actions.MustEnableActions`. At the ORG scope MustEnableActions checks
 *     ONLY the instance-level flags (`setting.Actions.Enabled` +
 *     `unit.TypeActions.UnitGlobalDisabled()`, actions/actions.go:67-80 — the
 *     repo-permission arm needs `ctx.Repo.Repository`, nil here); both flags
 *     are compile-time TRUE in the landed posture, so the gate reduces to the
 *     require-owner prologue — exactly the org secrets/variables twins'
 *     shape (org-settings-actions.tsx's mount record).
 *   - `routers/web/shared/actions/runners.go` — the shared handlers and the
 *     four-scope dispatch: `getRunnersCtx`'s ORG arm (runners.go:69-80 —
 *     RepoID 0, OwnerID = org.ID, tplOrgRunners "org/settings/actions",
 *     tplOrgRunnerEdit "org/settings/runners_edit", RedirectLink
 *     `{OrgLink}/settings/actions/runners/`), `Runners` (runners.go:102-155 —
 *     `opts.OwnerID = rCtx.OwnerID` + WithAvailable, pageSize 100,
 *     `GetOrCreateActiveRunnerToken(orgID, 0)`), `RunnersEdit`
 *     (runners.go:158-216 — the runner plus its paged recent tasks, pageSize
 *     30), `RunnersEditPost` (runners.go:219-254, the description overwrite
 *     → Redirect onto the list), `ResetRunnerRegistrationToken`
 *     (runners.go:275-290 — NewRunnerToken(orgID, 0) + JSONRedirect),
 *     `RunnerDeletePost` (runners.go:292-326), `RunnerUpdatePost`
 *     (runners.go:328-369 — the required `disabled` param flip),
 *     `findActionsRunner`'s ORG arm (runners.go:432-460 — IDs + OwnerID
 *     pinned, NO WithAvailable: a global or foreign runner is the
 *     ctx.NotFound arm).
 *   - `models/actions/runner.go` — the org arm of `FindRunnerOptions.ToConds`
 *     (runner.go:262-266: `owner_id = orgID OR (repo_id = 0 AND owner_id =
 *     0)` — the org's OWN runners plus the globals; a repo-scoped runner
 *     NEVER lists here, unlike the repo scope which also admits its owner's
 *     rows), the shared sort ladder (runner.go:301-318), `EditableInContext`'s
 *     owner arm (runner.go:174-175 — `r.OwnerID == ownerID`),
 *     `BelongsToOwnerType/Name` (runner.go:101-124 — an org-scope runner
 *     renders OwnerTypeOrganization over the owner's name), `DeleteRunner`
 *     (runner.go:369-376 — a HARD delete).
 *   - Templates: `org/settings/actions.tmpl` (the PageType switchyard,
 *     pageClass `organization settings actions` — actions.tmpl:1) over
 *     `shared/actions/runner_list.tmpl`, and `org/settings/runners_edit.tmpl`
 *     (tplOrgRunnerEdit, runners.go:26) with pageClass
 *     `organization settings runners` (runners_edit.tmpl:1 — the org family's
 *     genuinely distinct edit template; the repo twin flattened both pages
 *     onto the actions class, this twin carries upstream's exact per-template
 *     discriminators). Both sit under OrgHeader +
 *     `org/settings/navbar.tmpl`'s Actions disclosure (navbar.tmpl:28-48 —
 *     open while PageIsSharedSettingsRunners is set; the Runners sub-item
 *     :35-37), carried by the SHARED OrgSettingsNavbar with
 *     `active: "runners"` (the wave-114 idiom; the Runners sub-item lit by
 *     this mount).
 *
 * ## Mount record
 *
 *   GET  /{org}/settings/actions/runners                       → list
 *   GET  /{org}/settings/actions/runners/{id}                  → edit
 *   POST /{org}/settings/actions/runners/{id}                  → desc
 *   POST /{org}/settings/actions/runners/{id}/update-runner    → flip
 *   POST /{org}/settings/actions/runners/{id}/delete           → del
 *   POST /{org}/settings/actions/runners/reset_registration_token
 *
 * all behind the shared `resolveOrgTeamsRequest` prologue (the anonymous
 * login 303 + the requireOrgOwnership 404 shell — a signed-in non-owner, and
 * any anonymous request, never reaches a handler) PLUS sameOriginGuard-first
 * POSTs. The literal `reset_registration_token` claims ahead of the {id}
 * combo (chi's static-first dispatch, web.go:507-512's group order). The
 * bare `GET /{org}/settings/actions` stays upstream's LocationRedirect onto
 * ./actions/general — the general tab is NOT this module's claim (the
 * dispatcher 404-shells it until that slice lands, the secrets/variables
 * twins' posture).
 *
 * ## Data (SPEC-0012 M1a's landed store — the repo twin's convention)

 * The registration-token block and its reset arm ride
 * services/actions/model.ts: `getOrCreateActiveRunnerToken` /
 * `newRunnerToken` at (orgId, 0) — the ORG owner scope (runner_token.go's
 * owner_id/repo_id pair; the token is REUSED while active). The list's
 * WithAvailable org arm, the scope guards and the sort ladder are the REPO
 * twin's module-level ports reused where scope-neutral (the status model,
 * `runnersOrderBy`, `runnerBelongsTo`, the task-list shapes) plus this
 * module's org-specific cond/find/writes mirroring `findActionsRunner`'s org
 * arm and `UpdateRunner`/`SetRunnerDisabled`/`DeleteRunner`.
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * The REPO twin's reductions carry verbatim (its module header): the
 * token-panel dropdown reduced inline, the reset as a plain 303 form POST,
 * the plain-GET search, AllowBulkActions admin-only (no bulk toolbar at the
 * org scope either), the task list's Job cell as text (the C2 viewer page's
 * link is unlanded), the edit page's three write arms as plain POST forms.
 * Org-specific notes:
 * - The nav is the SHARED components/settings-nav OrgSettingsNavbar rendered
 *   with `active: "runners"` (the wave-114 idiom — no local copy; the repo
 *   twin's local copy was forced by a dirty shared nav at its writing and its
 *   fold-back is that module's reported follow-up).
 * - The edit page's Title is upstream's exact "Edit Runner"
 *   (actions.runners.edit_runner, runners.go:160); the list page's Title is
 *   "Actions" (actions.actions, runners.go:105) — both over the org's
 *   pageClasses above.
 * - BelongsToOwnerName at this scope: an org runner shows the org's username
 *   tooltip (Owner.Name); a global runner has none (the attribute omits).
 *   Repo-scoped rows cannot appear (the cond), so no repo-name read rides
 *   the edit page.
 */

import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRunJobs, actionRunners, actionTasks, repositories, users } from "../../db/schema";
import type { OrgRecord } from "../../services/orgs/orgs";
import { getOrCreateActiveRunnerToken, newRunnerToken, type RunnerRow } from "../../services/actions/model";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { OrgSettingsNavbar } from "../components/settings-nav";
import { TimeSince } from "../components/file-list";
import { shortSha } from "../page-data";
import { actionsStatusLocaleText, actionsStatusToString } from "./repo-actions-queue";
import {
  repoSettingsRunnersLocale,
  runnerBelongsTo,
  runnerStatusLocaleText,
  runnerStatusClass,
  runnerStatusOf,
  runnersOrderBy,
  parseRepoActionsRunnerDescriptionForm,
  parseRepoActionsRunnerDisabledForm,
  RUNNERS_PAGE_SIZE,
  RUNNER_EDIT_TASKS_PAGE_SIZE,
  type RunnerBelongsTo,
  type RunnerTaskView,
  type RunnerView,
} from "./repo-settings-actions-runners";
import { OrgHeader } from "./org-home";

// ---------------------------------------------------------------------------
// Locale (this module adds only the strings its pages cite beyond the shared
// repo twin's vocabulary — every string cites its upstream key)
// ---------------------------------------------------------------------------

export const orgSettingsRunnersLocale = {
  edit_runner: "Edit Runner", // "actions.runners.edit_runner" (the edit page's Title, runners.go:160)
} as const;

// ---------------------------------------------------------------------------
// The list query (FindRunnerOptions.ToConds over the ORG scope)
// ---------------------------------------------------------------------------

/** The ORG scope's WithAvailable conds (ToConds runner.go:262-266): the org's
 *  own runners and the globals — RepoID is 0 at this scope, so the RepoID
 *  branch never rides and a repo-scoped runner never lists. */
export function orgRunnersCond(orgId: number) {
  return or(eq(actionRunners.ownerId, orgId), and(eq(actionRunners.repoId, ""), eq(actionRunners.ownerId, 0)));
}

export interface OrgActionsRunnersPageData {
  org: OrgRecord;
  runners: RunnerView[];
  total: number;
  page: number;
  more: boolean;
  /** The echoed `?q=` (the search input's value arm). */
  query: string;
  /** The echoed `?sort=` (the SortArrow arm reads it). */
  sortType: string;
  /** The scope's active registration token (GetOrCreateActiveRunnerToken —
   *  reused while active; a reset mints the next). */
  registrationToken: string;
}

/**
 * Runners (runners.go:102-155) at the ORG scope: the WithAvailable list
 * (q + sort + page over the org cond), then
 * GetOrCreateActiveRunnerToken(orgID, 0) — the token read CREATES the scope's
 * first token on the bare GET exactly like upstream (runner_token.go:127-134).
 */
export async function loadOrgActionsRunnersPageData(
  d1: D1Database,
  org: OrgRecord,
  search: URLSearchParams,
  now: Date = new Date(),
): Promise<OrgActionsRunnersPageData> {
  const page = Math.max(Number.parseInt(search.get("page") ?? "", 10) || 1, 1);
  const query = search.get("q") ?? "";
  const sortType = search.get("sort") ?? "";

  const conds = [orgRunnersCond(org.id)];
  if (query !== "") {
    conds.push(like(actionRunners.name, `%${query}%`));
  }
  const db = drizzle(d1);
  const totalRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(actionRunners)
    .where(and(...conds));
  const total = Number(totalRows[0]?.count ?? 0);

  const rows =
    total === 0
      ? []
      : await db
          .select()
          .from(actionRunners)
          .where(and(...conds))
          .orderBy(...runnersOrderBy(sortType, now))
          .limit(RUNNERS_PAGE_SIZE)
          .offset((page - 1) * RUNNERS_PAGE_SIZE);

  // BelongsToOwnerName's batched attributes (the read stays general like the
  // repo twin's: the cond structurally admits only owner/global rows, but
  // the repo-name enrichment covers the defensive both-set row).
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

  const token = await getOrCreateActiveRunnerToken(d1, org.id, "");

  return {
    org,
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
// RunnerUpdatePost / RunnerDeletePost — every arm scope-guarded first)
// ---------------------------------------------------------------------------

/** EditableInContext's owner arm (runner.go:174-175): only the org's OWN
 *  runners are editable here (global runners merely LIST via WithAvailable). */
export function runnerEditableInOrg(runner: Pick<RunnerRow, "ownerId">, orgId: number): boolean {
  return runner.ownerId === orgId;
}

/**
 * findActionsRunner's ORG arm (runners.go:432-460): resolve the runner within
 * THIS org's scope — only `owner_id = orgId` rows resolve (a global or
 * foreign runner is a NotFound upstream, the "missing" outcome here). Note
 * the org arm pins OwnerID WITHOUT WithAvailable, so a global runner is NOT
 * editable — the same polarity as the repo arm's repoId pin.
 */
export async function findOrgScopedRunner(d1: D1Database, orgId: number, runnerId: number): Promise<RunnerRow | null> {
  if (!Number.isInteger(runnerId) || runnerId <= 0) {
    return null;
  }
  const rows = await drizzle(d1)
    .select()
    .from(actionRunners)
    .where(and(eq(actionRunners.id, runnerId), eq(actionRunners.ownerId, orgId)))
    .limit(1);
  return rows[0] ?? null;
}

/** ResetRunnerRegistrationToken (runners.go:275-290): NewRunnerToken at the
 *  ORG scope — the deactivate+insert batch mints the fresh active token and
 *  answers its RAW string (the value that renders next GET). */
export async function resetOrgActionsRunnerToken(d1: D1Database, orgId: number): Promise<string> {
  const row = await newRunnerToken(d1, orgId, "");
  return row.token;
}

/** RunnerDeletePost (runners.go:292-326): the scope-guarded hard delete —
 *  "missing" covers a stale/foreign/global id (upstream's findActionsRunner
 *  NotFound arm) and deletes nothing. */
export async function deleteOrgActionsRunner(d1: D1Database, orgId: number, runnerId: number): Promise<"deleted" | "missing"> {
  const runner = await findOrgScopedRunner(d1, orgId, runnerId);
  if (runner === null) {
    return "missing";
  }
  await drizzle(d1).delete(actionRunners).where(eq(actionRunners.id, runner.id));
  return "deleted";
}

/** RunnersEditPost (runners.go:219-254): the description overwrite at the
 *  org scope (UpdateRunner's "description" col). */
export async function updateOrgActionsRunnerDescription(
  d1: D1Database,
  orgId: number,
  runnerId: number,
  description: string,
): Promise<"updated" | "missing"> {
  const runner = await findOrgScopedRunner(d1, orgId, runnerId);
  if (runner === null) {
    return "missing";
  }
  await drizzle(d1)
    .update(actionRunners)
    .set({ description, updated: new Date() })
    .where(eq(actionRunners.id, runner.id));
  return "updated";
}

/** RunnerUpdatePost (runners.go:328-369): the required `disabled` flip
 *  (SetRunnerDisabled). "missing" for a foreign/stale/global id; the caller
 *  answers 400 when the param is absent (the missing-parameter arm). */
export async function setOrgActionsRunnerDisabled(
  d1: D1Database,
  orgId: number,
  runnerId: number,
  disabled: boolean,
): Promise<"updated" | "missing"> {
  const runner = await findOrgScopedRunner(d1, orgId, runnerId);
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
// The forms (the shared scope-neutral parsers — org-named delegates to the
// repo twin's URLSearchParams readers)
// ---------------------------------------------------------------------------

export function parseOrgActionsRunnerDescriptionForm(params: URLSearchParams): { description: string } {
  return parseRepoActionsRunnerDescriptionForm(params);
}

export function parseOrgActionsRunnerDisabledForm(params: URLSearchParams): { disabled: boolean | null } {
  return parseRepoActionsRunnerDisabledForm(params);
}

// ---------------------------------------------------------------------------
// The edit page's recent tasks (RunnersEdit — FindTaskOptions over the
// runner, pageSize 30, `id DESC`) — the repo twin's task loader is
// scope-neutral once the runner row is resolved; this module re-shapes its
// result around the org's belongsTo enrichment.
// ---------------------------------------------------------------------------

export interface OrgActionsRunnerEditPageData {
  org: OrgRecord;
  runner: RunnerRow;
  runnerStatus: ReturnType<typeof runnerStatusOf>;
  agentLabels: string[];
  belongsTo: RunnerBelongsTo;
  tasks: RunnerTaskView[];
  page: number;
  more: boolean;
}

/**
 * RunnersEdit (runners.go:158-216): the runner (scope-guarded — null is the
 * NotFound arm, EditableInContext's owner arm folded into the same
 * predicate) plus one page of its recent tasks with the job/repo attributes
 * loaded (TaskList.LoadAttributes' batched shape, the repo twin's loader).
 */
export async function loadOrgActionsRunnerEditPageData(
  d1: D1Database,
  org: OrgRecord,
  runnerId: number,
  search: URLSearchParams,
  now: Date = new Date(),
): Promise<OrgActionsRunnerEditPageData | null> {
  const runner = await findOrgScopedRunner(d1, org.id, runnerId);
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
  // for the Repository/Commit cells (the repo twin's batched reads).
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

  return {
    org,
    runner,
    runnerStatus: runnerStatusOf(runner, now),
    agentLabels: (JSON.parse(runner.agentLabels) as string[]) ?? [],
    belongsTo: runnerBelongsTo(runner, {
      repoFullName: null,
      ownerName: org.username,
      ownerType: "org",
    }),
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
// The render — org/settings/actions.tmpl PageType "runners" over
// shared/actions/runner_list.tmpl, and org/settings/runners_edit.tmpl
// ---------------------------------------------------------------------------

/** The pager href builder (the q + sort facets minus the page param) — the
 *  repo twin's shape, local because the base URL differs. */
function runnersPagerHref(base: string, query: string, sortType: string, page: number): string {
  const params = new URLSearchParams();
  if (query !== "") params.set("q", query);
  if (sortType !== "") params.set("sort", sortType);
  params.set("page", String(page));
  return `${base}?${params.toString()}`;
}

/** The full-document render (the render.tsx pattern — index.ts stays a
 *  pure-TS router module). */
export function renderOrgActionsRunnersPage(ctx: UiContext, data: OrgActionsRunnersPageData): string {
  return renderPage(<OrgActionsRunnersPage ctx={ctx} data={data} />);
}

/** The runners list page (§2.4.1 discriminator: `organization settings
 *  actions` — org/settings/actions.tmpl:1; upstream's Title is
 *  `actions.actions`, runners.go:105). */
export function OrgActionsRunnersPage(props: { ctx: UiContext; data: OrgActionsRunnersPageData }) {
  const { ctx, data } = props;
  const orgLink = `/${data.org.username}`;
  const base = `${orgLink}/settings/actions/runners`;
  return (
    <BaseLayout ctx={ctx} title={repoSettingsRunnersLocale.actions} pageClass="organization settings actions">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={orgLink} active="runners" />
        <div class="flex-container-main">
          <div class="org-setting-content">
            {/* runner_list.tmpl:3-32 — the header with the token panel (the
                dropdown reduced inline; the module header). */}
            <h4 class="ui top attached header">
              {repoSettingsRunnersLocale.runner_manage_panel} ({`Total ${data.total}`})
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
                  reduced to the plain form (the repo twin's header). */}
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
            {/* AllowBulkActions is admin-only — no toolbar at org scope
                (runners.go:147; the module header). */}
            {data.runners.length > 0 ? (
              <div class="ui attached table segment">
                <table class="ui very basic table unstackable">
                  <thead>
                    <tr>
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
                        {/* The EditableInContext conditional
                            (runner_list.tmpl:118-122): global rows list via
                            WithAvailable but carry no pencil. */}
                        <td>
                          {runnerEditableInOrg(runner.row, data.org.id) ? (
                            <a href={`${base}/${runner.row.id}`} aria-label={repoSettingsRunnersLocale.edit}>
                              <Icon name="octicon-pencil" />
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div class="ui attached segment tw-text-center">{repoSettingsRunnersLocale.none}</div>
            )}
            {/* base/paginate — the family's Newer/Older reduction keeping
                the q + sort facets. */}
            {data.page > 1 || data.more ? (
              <div class="center page buttons">
                <div class="ui borderless pagination menu">
                  {data.page > 1 ? (
                    <a class="item navigation" href={runnersPagerHref(base, data.query, data.sortType, data.page - 1)}>
                      <span class="navigation_label">Newer</span>
                    </a>
                  ) : null}
                  {data.more ? (
                    <a class="item navigation" href={runnersPagerHref(base, data.query, data.sortType, data.page + 1)}>
                      <span class="navigation_label">Older</span>
                    </a>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-document render. */
export function renderOrgActionsRunnerEditPage(ctx: UiContext, data: OrgActionsRunnerEditPageData): string {
  return renderPage(<OrgActionsRunnerEditPage ctx={ctx} data={data} />);
}

/** The runner edit page (tplOrgRunnerEdit — org/settings/runners_edit.tmpl;
 *  the org family's DISTINCT `organization settings runners` pageClass,
 *  runners_edit.tmpl:1). */
export function OrgActionsRunnerEditPage(props: { ctx: UiContext; data: OrgActionsRunnerEditPageData }) {
  const { ctx, data } = props;
  const orgLink = `/${data.org.username}`;
  const base = `${orgLink}/settings/actions/runners`;
  const runnerLink = `${base}/${data.runner.id}`;
  return (
    <BaseLayout ctx={ctx} title={orgSettingsRunnersLocale.edit_runner} pageClass="organization settings runners">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={orgLink} active="runners" />
        <div class="flex-container-main">
          <div class="org-setting-content">
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
                  repo twin's header). */}
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
                        {/* The GetRunJobLink is the census C2 unit's page
                            (unlanded) — the id renders as text (the repo
                            twin's header). */}
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
