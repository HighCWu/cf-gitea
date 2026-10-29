/**
 * The repo settings ACTIONS tab's RUNNERS sub-tab (the census C7 arm — the
 * REPO scope of the four-scope shared builders), ported from the pin
 * fc4936884584a41931906553d96c2601d750e6ef.
 *
 * Upstream sources (VERIFIED at the pin):
 *   - `routers/web/web.go:506-513` — `addSettingsRunnersRoutes`: the runners
 *     group `GET ""` (list), `Combo("/{runnerid}")` GET+POST (edit page /
 *     description update), `POST /{runnerid}/update-runner` (disable flip),
 *     `POST /{runnerid}/delete`, `POST /reset_registration_token`; mounted
 *     for the repo scope inside web.go:1266-1278's `/settings/actions`
 *     group (the reqRepoAdmin settings subtree + `actions.MustEnableActions`
 *     — web.go:1277).
 *   - `routers/web/shared/actions/runners.go` — the shared handlers and the
 *     four-scope dispatch: `getRunnersCtx` (runners.go:48-99 — the
 *     `PageIsRepoSettings` arm pins RepoID, OwnerID 0), `Runners`
 *     (runners.go:102-155 — FindRunnerOptions pageSize 100, `WithAvailable`
 *     for repo/org/user, `GetOrCreateActiveRunnerToken(opts.OwnerID,
 *     opts.RepoID)`), `RunnersEdit` (runners.go:158-210 — the runner plus
 *     its paged recent tasks, pageSize 30), `RunnersEditPost` (description),
 *     `ResetRunnerRegistrationToken` (NewRunnerToken + JSONRedirect),
 *     `RunnerDeletePost` (scope-guarded find + DeleteRunner),
 *     `RunnerUpdatePost` (the required `disabled` param flip).
 *   - `models/actions/runner.go` — `Status` (runner.go:127-135: offline past
 *     RunnerOfflineTime 1 min, idle past RunnerIdleTime 10 s, else active),
 *     `EditableInContext` (runner.go:158-169 — the repo arm is
 *     `r.RepoID == repoID`), `FindRunnerOptions.ToConds/ToOrders`
 *     (runner.go:240-318: the `WithAvailable` repo arm is repo_id = X OR
 *     owner_id = repo.owner OR global; the sort ladder with the computed
 *     status rank and the id tiebreaker), `DeleteRunner` (runner.go:369-376
 *     — a HARD delete).
 *   - Templates: `repo/settings/actions.tmpl` (the PageType switchyard,
 *     pageClass `repository settings actions`) over
 *     `shared/actions/runner_list.tmpl` and `repo/settings/runner_edit.tmpl`
 *     (tplRepoRunners/tplRepoRunnerEdit, runners.go:16-17).
 *
 * ## Mount record
 *
 *   GET  /{owner}/{repo}/settings/actions/runners                       → list
 *   GET  /{owner}/{repo}/settings/actions/runners/{id}                  → edit
 *   POST /{owner}/{repo}/settings/actions/runners/{id}                  → desc
 *   POST /{owner}/{repo}/settings/actions/runners/{id}/update-runner    → flip
 *   POST /{owner}/{repo}/settings/actions/runners/{id}/delete           → del
 *   POST /{owner}/{repo}/settings/actions/runners/reset_registration_token
 *
 * all behind the shared settingsGate PLUS the C8 arm's MustEnableActions
 * gate (repo_settings.has_actions — index.ts's repoActionsGate). The
 * literal `reset_registration_token` claims ahead of the {id} combo (chi's
 * static-first dispatch, runners group order web.go:507-512).
 *
 * ## Data (SPEC-0012 M1a's landed store)
 *
 * The registration-token block and its reset arm ride
 * services/actions/model.ts: `getOrCreateActiveRunnerToken` / `newRunnerToken`
 * (the reset is a same-scope deactivate+insert batch — runner_token.go:74-98's
 * semantics; the token is REUSED while active per GetOrCreateActiveRunnerToken).
 * The list's `WithAvailable` arm, the scope guards and the sort ladder are
 * module-level ports (FindRunnerOptions.ToConds/ToOrders,
 * EditableInContext) over `action_runners` + `repositories` + `users`; the
 * description/disabled writes and the delete are module-level drizzle arms
 * mirroring `UpdateRunner`/`SetRunnerDisabled`/`DeleteRunner` (the model's
 * updateRunner covers no description column — the org twin's module-level
 * drizzle convention for the scope-guarded write).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The "Create new Runner" dropdown (runner_list.tmpl:5-32) reduces to an
 *   inline token panel in the header segment: the new-notice link, the
 *   readonly token input with the copy button (`data-clipboard-text` — the
 *   bundle's clipboard JS enhances it), and the reset arm as a PLAIN FORM
 *   POST (upstream's `link-action` + confirm modal pair is not reproduced —
 *   the org twin's modal reduction).
 * - The reset answers a plain 303 back onto the list URL (upstream's
 *   JSONRedirect is the form-fetch-action JS arm; the no-JS reduction is
 *   the twins' 303).
 * - The search form is a plain GET (`?q=`); upstream's search/combo wrapper
 *   (Fomantic) is not reproduced.
 * - AllowBulkActions is admin-only (runners.go:147) — the repo scope
 *   renders no bulk toolbar and no checkbox column.
 * - The task list's Job cell renders the job id as TEXT: upstream links
 *   `GetRunJobLink` (the run viewer — the census C2 unit's page, unlanded).
 * - The edit page's enable/disable and delete buttons reduce to plain form
 *   POSTs beside the description form (upstream's `link-action` buttons
 *   with `data-url` + the delete confirm modal are not reproduced); each
 *   answers 303 (the delete onto the list, the flip back onto the edit
 *   page — upstream's JSONRedirect("") stays-on-page arm).
 * - The nav is this module's LOCAL repo-settings navbar copy (the family's
 *   mount-scaffolding convention — the wave-114 swap precedent): the
 *   Actions disclosure is OPEN with Runners active (navbar.tmpl:42, 47-50).
 *   settings.tsx's shared SettingsNav cannot express the member yet (its
 *   window carried a concurrent sibling's dirty hunks at this module's
 *   writing) — the reported follow-up folds `"runners"` into SettingsNav's
 *   union + the Runners item into its Actions block, then swaps this copy
 *   (the secrets/variables twins' shape).
 * - BelongsToOwnerName tooltip: a repo-scoped runner shows its repo's full
 *   name (batched read); an owner runner shows the owner's username; a
 *   global runner has none (the attribute omits, like upstream's empty
 *   string).
 */

import { and, asc, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRunJobs, actionRunners, actionTasks, repositories, users } from "../../db/schema";
import {
  getOrCreateActiveRunnerToken,
  newRunnerToken,
  type RunnerRow,
} from "../../services/actions/model";
import { TimeSince } from "../components/file-list";
import { shortSha } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { actionsStatusLocaleText, actionsStatusToString } from "./repo-actions-queue";
import { repoSettingsActionsLocale } from "./repo-settings-actions-secrets-variables";

/** The repo reference the loaders take (the Repositories row's identifying
 *  slice — index.ts passes the resolved RepoRow directly). */
export interface RunnerRepoRef {
  id: string;
  ownerId: number | null;
  ownerNamespace: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Locale (the component-local pattern — every string cites its upstream key;
// values are the pin's locale_en-US.json English texts)
// ---------------------------------------------------------------------------

export const repoSettingsRunnersLocale = {
  actions: "Actions", // "actions.actions" (the page Title, runners.go:105)
  runner_manage_panel: "Runners Management", // "actions.runners.runner_manage_panel"
  new_notice: "How to start a runner", // "actions.runners.new_notice"
  registration_token: "Registration Token", // the dropdown header's literal (runner_list.tmpl:18)
  copy: "Copy", // "copy"
  reset_registration_token: "Reset registration token", // "actions.runners.reset_registration_token"
  search_runners: "Search runners…", // "search.runner_kind"
  status: "Status", // "actions.runners.status"
  id: "ID", // "actions.runners.id"
  version: "Version", // "actions.runners.version"
  owner_type: "Type", // "actions.runners.owner_type"
  labels: "Labels", // "actions.runners.labels"
  last_online: "Last Online Time", // "actions.runners.last_online"
  edit: "Edit", // "edit"
  none: "No runners available", // "actions.runners.none"
  status_active: "Active", // "actions.runners.status.active"
  status_idle: "Idle", // "actions.runners.status.idle"
  status_offline: "Offline", // "actions.runners.status.offline"
  disabled: "Disabled", // "disabled"
  enabled: "Enabled", // "enabled"
  unknown: "Unknown", // "unknown"
  never: "Never", // "never"
  availability: "Availability", // "actions.runners.availability"
  description: "Description", // "actions.runners.description"
  runner_title: "Runner", // "actions.runners.runner_title" (also the nav item's "actions.runners")
  update_runner: "Update Changes", // "actions.runners.update_runner"
  enable_runner: "Enable this runner", // "actions.runners.enable_runner"
  disable_runner: "Disable this runner", // "actions.runners.disable_runner"
  delete_runner: "Delete this runner", // "actions.runners.delete_runner"
  task_list: "Recent tasks on this runner", // "actions.runners.task_list"
  task_list_job: "Job", // "actions.runners.task_list.job"
  task_list_status: "Status", // "actions.runners.task_list.status"
  task_list_repository: "Repository", // "actions.runners.task_list.repository"
  task_list_commit: "Commit", // "actions.runners.task_list.commit"
  task_list_done_at: "Done At", // "actions.runners.task_list.done_at"
  task_list_no_tasks: "There is no task yet.", // "actions.runners.task_list.no_tasks"
  concept_system_global: "Global", // "concept_system_global"
  concept_user_user: "User", // "concept_user_user"
  concept_code_repository: "Repository", // "concept_code_repository"
  concept_user_organization: "Organization", // "concept_user_organization"
} as const;

// ---------------------------------------------------------------------------
// Constants + status model (models/actions/runner.go at the pin)
// ---------------------------------------------------------------------------

/** The list's page size (Runners: db.ListOptions PageSize 100). */
export const RUNNERS_PAGE_SIZE = 100;
/** The edit page's recent-tasks page size (RunnersEdit: PageSize 30). */
export const RUNNER_EDIT_TASKS_PAGE_SIZE = 30;
/** RunnerOfflineTime (runner.go:76) — past this the runner is offline. */
export const RUNNER_OFFLINE_MS = 60_000;
/** RunnerIdleTime (runner.go:77) — past this an online runner is idle. */
export const RUNNER_IDLE_MS = 10_000;

export type RunnerStatusName = "active" | "idle" | "offline";

/** ActionRunner.Status (runner.go:127-135) — the timestamp columns are
 *  nullable (never seen = the zero arm, offline). */
export function runnerStatusOf(
  runner: { lastOnline: Date | null; lastActive: Date | null },
  now: Date = new Date(),
): RunnerStatusName {
  const lastOnline = runner.lastOnline?.getTime() ?? 0;
  const lastActive = runner.lastActive?.getTime() ?? 0;
  if (now.getTime() - lastOnline > RUNNER_OFFLINE_MS) return "offline";
  if (now.getTime() - lastActive > RUNNER_IDLE_MS) return "idle";
  return "active";
}

/** StatusLocaleName (runner.go:141-143) — "actions.runners.status.{name}". */
export function runnerStatusLocaleText(status: RunnerStatusName): string {
  switch (status) {
    case "active":
      return repoSettingsRunnersLocale.status_active;
    case "idle":
      return repoSettingsRunnersLocale.status_idle;
    default:
      return repoSettingsRunnersLocale.status_offline;
  }
}

/** The status label's color class (runner_list.tmpl:74: green/yellow/red). */
export function runnerStatusClass(status: RunnerStatusName): string {
  switch (status) {
    case "active":
      return "green";
    case "idle":
      return "yellow";
    default:
      return "red";
  }
}

export interface RunnerBelongsTo {
  type: "repository" | "organization" | "individual" | "system-global";
  text: string;
  tooltip: string | null;
}

/** BelongsToOwnerType (runner.go:111-124) + BelongsToOwnerName
 *  (runner.go:101-108): the scope the runner belongs to, with the tooltip
 *  name when one exists. The lookup rows ride the caller's enrichment (the
 *  batched read in the loaders). */
export function runnerBelongsTo(
  runner: Pick<RunnerRow, "ownerId" | "repoId">,
  names: { repoFullName: string | null; ownerName: string | null; ownerType: "user" | "org" | null },
): RunnerBelongsTo {
  if (runner.repoId !== "") {
    return { type: "repository", text: repoSettingsRunnersLocale.concept_code_repository, tooltip: names.repoFullName };
  }
  if (runner.ownerId !== 0) {
    const org = names.ownerType === "org";
    return {
      type: org ? "organization" : "individual",
      text: org ? repoSettingsRunnersLocale.concept_user_organization : repoSettingsRunnersLocale.concept_user_user,
      tooltip: names.ownerName,
    };
  }
  return { type: "system-global", text: repoSettingsRunnersLocale.concept_system_global, tooltip: null };
}

/** EditableInContext's repo arm (runner.go:158-169): ownerID 0 + the repo
 *  id — only the repo's OWN runners are editable here (owner/global runners
 *  merely LIST via WithAvailable). */
export function runnerEditableInRepo(runner: Pick<RunnerRow, "repoId">, repoId: string): boolean {
  return runner.repoId === repoId;
}

// ---------------------------------------------------------------------------
// The list query (FindRunnerOptions.ToConds/ToOrders over the repo scope)
// ---------------------------------------------------------------------------

/** The list's sort ladder — FindRunnerOptions.ToOrders (runner.go:301-318)
 *  with the computed status rank (runner.go:285-294; the NULL timestamps
 *  rank offline). Every order appends the id tiebreaker. */
export function runnersOrderBy(sort: string, now: Date) {
  const offlineThreshold = Math.floor((now.getTime() - RUNNER_OFFLINE_MS) / 1000);
  const idleThreshold = Math.floor((now.getTime() - RUNNER_IDLE_MS) / 1000);
  const statusRank = sql`CASE WHEN ${actionRunners.lastOnline} IS NULL OR ${actionRunners.lastOnline} <= ${offlineThreshold} THEN 2 WHEN ${actionRunners.lastActive} IS NULL OR ${actionRunners.lastActive} <= ${idleThreshold} THEN 1 ELSE 0 END`;
  switch (sort) {
    case "online":
      return [asc(statusRank), asc(actionRunners.isDisabled), desc(actionRunners.lastOnline), asc(actionRunners.id)];
    case "offline":
      return [desc(statusRank), asc(actionRunners.isDisabled), asc(actionRunners.lastOnline), asc(actionRunners.id)];
    case "alphabetically":
      return [asc(actionRunners.name), asc(actionRunners.id)];
    case "reversealphabetically":
      return [desc(actionRunners.name), asc(actionRunners.id)];
    case "newest":
      return [desc(actionRunners.id)];
    case "oldest":
      return [asc(actionRunners.id)];
    default:
      return [asc(statusRank), asc(actionRunners.isDisabled), desc(actionRunners.lastOnline), asc(actionRunners.id)];
  }
}

/** The repo scope's WithAvailable conds (ToConds runner.go:248-256): the
 *  repo's own runners, the owner's, and the globals. */
export function repoRunnersCond(repo: RunnerRepoRef) {
  const arms = [
    eq(actionRunners.repoId, repo.id),
    repo.ownerId !== null ? eq(actionRunners.ownerId, repo.ownerId) : undefined,
    and(eq(actionRunners.repoId, ""), eq(actionRunners.ownerId, 0)),
  ].filter((arm) => arm !== undefined);
  return or(...arms);
}

export interface RunnerView {
  row: RunnerRow;
  status: RunnerStatusName;
  belongsTo: RunnerBelongsTo;
  agentLabels: string[];
}

export interface RepoActionsRunnersPageData {
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
 * Runners (runners.go:102-155) at the REPO scope: the WithAvailable list
 * (q + sort + page), then GetOrCreateActiveRunnerToken(0, repoId) — the
 * token read CREATES the scope's first token on the bare GET exactly like
 * upstream (runner_token.go:127-134).
 */
export async function loadRepoActionsRunnersPageData(
  d1: D1Database,
  repo: RunnerRepoRef,
  search: URLSearchParams,
  now: Date = new Date(),
): Promise<RepoActionsRunnersPageData> {
  const page = Math.max(Number.parseInt(search.get("page") ?? "", 10) || 1, 1);
  const query = search.get("q") ?? "";
  const sortType = search.get("sort") ?? "";

  const conds = [repoRunnersCond(repo)];
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

  // BelongsToOwnerName's batched attributes: the other repos (a repo-scoped
  // runner of a sibling repo can never appear in this scope's list, but the
  // read stays general) and the owner rows' types.
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

  const token = await getOrCreateActiveRunnerToken(d1, 0, repo.id);

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
// RunnerUpdatePost / RunnerDeletePost — every arm scope-guarded first)
// ---------------------------------------------------------------------------

/**
 * findActionsRunner's repo arm (runners.go:331-360): resolve the runner
 * within THIS repo's scope — only `repo_id = repoId` rows resolve (an
 * owner/global runner is a NotFound upstream, the "missing" outcome here).
 */
export async function findRepoScopedRunner(d1: D1Database, repoId: string, runnerId: number): Promise<RunnerRow | null> {
  if (!Number.isInteger(runnerId) || runnerId <= 0) {
    return null;
  }
  const rows = await drizzle(d1)
    .select()
    .from(actionRunners)
    .where(and(eq(actionRunners.id, runnerId), eq(actionRunners.repoId, repoId)))
    .limit(1);
  return rows[0] ?? null;
}

/** ResetRunnerRegistrationToken (runners.go:275-290): NewRunnerToken at the
 *  repo scope — the deactivate+insert batch mints the fresh active token
 *  and answers its RAW string (the value that renders next GET). */
export async function resetRepoActionsRunnerToken(d1: D1Database, repoId: string): Promise<string> {
  const row = await newRunnerToken(d1, 0, repoId);
  return row.token;
}

/** RunnerDeletePost (runners.go:292-326): the scope-guarded hard delete —
 *  "missing" covers a stale/foreign id (upstream's findActionsRunner
 *  NotFound arm) and deletes nothing. */
export async function deleteRepoActionsRunner(d1: D1Database, repoId: string, runnerId: number): Promise<"deleted" | "missing"> {
  const runner = await findRepoScopedRunner(d1, repoId, runnerId);
  if (runner === null) {
    return "missing";
  }
  await drizzle(d1).delete(actionRunners).where(eq(actionRunners.id, runner.id));
  return "deleted";
}

/** RunnersEditPost (runners.go:212-246): the description overwrite at the
 *  repo scope (UpdateRunner's "description" col). */
export async function updateRepoActionsRunnerDescription(
  d1: D1Database,
  repoId: string,
  runnerId: number,
  description: string,
): Promise<"updated" | "missing"> {
  const runner = await findRepoScopedRunner(d1, repoId, runnerId);
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
 *  (SetRunnerDisabled). "missing" for a foreign/stale id; the caller
 *  answers 400 when the param is absent (the missing-parameter arm). */
export async function setRepoActionsRunnerDisabled(
  d1: D1Database,
  repoId: string,
  runnerId: number,
  disabled: boolean,
): Promise<"updated" | "missing"> {
  const runner = await findRepoScopedRunner(d1, repoId, runnerId);
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
// The edit page's recent tasks (RunnersEdit — FindTaskOptions over the
// runner, pageSize 30, `id DESC`)
// ---------------------------------------------------------------------------

export interface RunnerTaskView {
  id: number;
  /** The claimed job's id (action_run_jobs.id — the Job cell; null when the
   *  job row is gone, the `{{.ID}}` fallback arm). */
  jobId: number | null;
  status: number;
  repoLink: string | null;
  repoFullName: string | null;
  commitSha: string;
  stopped: Date | null;
}

export interface RepoActionsRunnerEditPageData {
  runner: RunnerRow;
  runnerStatus: RunnerStatusName;
  agentLabels: string[];
  belongsTo: RunnerBelongsTo;
  tasks: RunnerTaskView[];
  page: number;
  more: boolean;
}

/** RunnersEdit (runners.go:158-210): the runner (scope-guarded — null is
 *  the NotFound arm, EditableInContext's repo arm folded into the same
 *  predicate) plus one page of its recent tasks with the job/repo
 *  attributes loaded (TaskList.LoadAttributes' batched shape). */
export async function loadRepoActionsRunnerEditPageData(
  d1: D1Database,
  repo: RunnerRepoRef,
  runnerId: number,
  search: URLSearchParams,
  now: Date = new Date(),
): Promise<RepoActionsRunnerEditPageData | null> {
  const runner = await findRepoScopedRunner(d1, repo.id, runnerId);
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
          .orderBy(desc(actionTasks.id))
          .limit(RUNNER_EDIT_TASKS_PAGE_SIZE)
          .offset((page - 1) * RUNNER_EDIT_TASKS_PAGE_SIZE);

  // TaskList.LoadAttributes (task_list.go:63-70): the jobs, then the repos
  // for the Repository/Commit cells.
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
    runner,
    runnerStatus: runnerStatusOf(runner, now),
    agentLabels: (JSON.parse(runner.agentLabels) as string[]) ?? [],
    belongsTo: runnerBelongsTo(runner, {
      repoFullName: runner.repoId === repo.id ? `${repo.ownerNamespace}/${repo.slug}` : null,
      ownerName: null,
      ownerType: null,
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
// The forms
// ---------------------------------------------------------------------------

/** The description form's single field (runner_edit.tmpl:33-36). */
export interface RepoActionsRunnerDescriptionForm {
  description: string;
}

export function parseRepoActionsRunnerDescriptionForm(params: URLSearchParams): RepoActionsRunnerDescriptionForm {
  return { description: params.get("description") ?? "" };
}

/** The update-runner form's `disabled` param (RunnerUpdatePost's
 *  FormOptionalBool — absent is the caller's 400 arm; the bool spellings
 *  parse, everything else is false). */
export function parseRepoActionsRunnerDisabledForm(params: URLSearchParams): { disabled: boolean | null } {
  const raw = params.get("disabled");
  if (raw === null) return { disabled: null };
  if (raw === "true" || raw === "1") return { disabled: true };
  return { disabled: false };
}

// ---------------------------------------------------------------------------
// The render — repo/settings/actions.tmpl PageType "runners" over
// shared/actions/runner_list.tmpl, and repo/settings/runner_edit.tmpl
// ---------------------------------------------------------------------------

/** The module-local repo settings navbar (the mount-scaffolding convention —
 *  the module header's nav note): the shared SettingsNav's shape with the
 *  Actions disclosure OPEN and Runners active (navbar.tmpl:42, 47-50). The
 *  SettingsNav fold + swap is the reported follow-up. */
export function RepoSettingsActionsRunnersNav(props: { repoLink: string }) {
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">Settings</div>
        <a class="item" href={`${props.repoLink}/settings`}>
          Repository
        </a>
        <a class="item" href={`${props.repoLink}/settings/collaboration`}>
          Collaboration
        </a>
        <a class="item" href={`${props.repoLink}/settings/branches`}>
          Branches
        </a>
        <a class="item" href={`${props.repoLink}/settings/tags`}>
          Tags
        </a>
        <a class="item" href={`${props.repoLink}/settings/hooks/git`}>
          Git Hooks
        </a>
        <a class="item" href={`${props.repoLink}/settings/keys`}>
          Deploy Keys
        </a>
        <details class="item" open>
          <summary>{repoSettingsActionsLocale.actions}</summary>
          <div class="menu">
            <a class="active item" href={`${props.repoLink}/settings/actions/runners`}>
              {repoSettingsRunnersLocale.runner_title}
            </a>
            <a class="item" href={`${props.repoLink}/settings/actions/secrets`}>
              {repoSettingsActionsLocale.secrets_nav}
            </a>
            <a class="item" href={`${props.repoLink}/settings/actions/variables`}>
              {repoSettingsActionsLocale.variables_nav}
            </a>
          </div>
        </details>
      </div>
    </div>
  );
}

/** The pager href builder (the q + sort facets minus the page param). */
function runnersPagerHref(base: string, query: string, sortType: string, page: number): string {
  const params = new URLSearchParams();
  if (query !== "") params.set("q", query);
  if (sortType !== "") params.set("sort", sortType);
  params.set("page", String(page));
  return `${base}?${params.toString()}`;
}

/** The full-document render (the render.tsx pattern). */
export function renderRepoActionsRunnersPage(ctx: UiContext, data: RepoActionsRunnersPageData): string {
  return renderPage(<RepoActionsRunnersPage ctx={ctx} data={data} />);
}

/** The runners list page (§2.4.1 discriminator: `repository settings actions`
 *  — actions.tmpl:1). */
export function RepoActionsRunnersPage(props: { ctx: UiContext; data: RepoActionsRunnersPageData }) {
  const { ctx, data } = props;
  const pageRepo = ctx.repo;
  if (pageRepo === undefined) throw new Error("RepoActionsRunnersPage requires ctx.repo");
  const repoLink = `/${pageRepo.ownerNamespace}/${pageRepo.slug}`;
  const base = `${repoLink}/settings/actions/runners`;
  return (
    <BaseLayout ctx={ctx} title={repoSettingsRunnersLocale.actions} pageClass="repository settings actions">
      <div class="ui container flex-container">
        <RepoSettingsActionsRunnersNav repoLink={repoLink} />
        <div class="flex-container-main">
          <div class="repo-setting-content">
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
                  reduced to the plain form (the module header). */}
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
            {/* AllowBulkActions is admin-only — no toolbar at repo scope
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
                            (runner_list.tmpl:118-122): owner/global rows
                            list via WithAvailable but carry no pencil. */}
                        <td>
                          {runnerEditableInRepo(runner.row, pageRepo.id) ? (
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
export function renderRepoActionsRunnerEditPage(ctx: UiContext, data: RepoActionsRunnerEditPageData): string {
  return renderPage(<RepoActionsRunnerEditPage ctx={ctx} data={data} />);
}

/** The runner edit page (tplRepoRunnerEdit — runner_edit.tmpl; the same
 *  `repository settings actions` pageClass family). */
export function RepoActionsRunnerEditPage(props: { ctx: UiContext; data: RepoActionsRunnerEditPageData }) {
  const { ctx, data } = props;
  if (ctx.repo === undefined) throw new Error("RepoActionsRunnerEditPage requires ctx.repo");
  const repoLink = `/${ctx.repo.ownerNamespace}/${ctx.repo.slug}`;
  const base = `${repoLink}/settings/actions/runners`;
  const runnerLink = `${base}/${data.runner.id}`;
  return (
    <BaseLayout ctx={ctx} title={repoSettingsRunnersLocale.runner_title} pageClass="repository settings actions">
      <div class="ui container flex-container">
        <RepoSettingsActionsRunnersNav repoLink={repoLink} />
        <div class="flex-container-main">
          <div class="repo-setting-content">
            {/* runner_edit.tmpl:2-4 — the header. */}
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
                  module header). */}
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
                            (unlanded) — the id renders as text (the module
                            header). */}
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
