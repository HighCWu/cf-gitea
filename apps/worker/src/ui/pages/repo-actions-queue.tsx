/**
 * The Actions JOB QUEUE page family (the census C6 arm) — the repo tab arm
 * and the admin instance arm over the ONE shared fragment, ported from the
 * pin fc4936884584a41931906553d96c2601d750e6ef.
 *
 * Upstream sources (VERIFIED at the pin):
 *   - `routers/web/repo/actions/job_queue.go:15-31` — the repo arm:
 *     `PageIsActions` + `PageIsActionsJobQueue`, the sidebar (only on the
 *     non-refresh render), then `RenderJobQueue(ctx, repo.ID, "repo/actions/
 *     job_queue")` under the tab group's middleware
 *     (web.go:1566-1572: optSignIn, RepoAssignment, MustBeNotEmpty,
 *     reqRepoActionsReader, actions.MustEnableActions).
 *   - `routers/web/shared/actions/job_queue.go:21-31` — the admin arm:
 *     `PageIsSharedSettingsActionsJobQueue` + `PageType: "job_queue"`, then
 *     `RenderJobQueue(ctx, 0, "admin/actions")` under the /-/admin group
 *     (web.go:898-905 — `GET /actions/job_queue` inside the actions group's
 *     `actions.MustEnableActions`; the admin gate rides the group).
 *   - `routers/web/shared/actions/job_queue.go:34-130` — `RenderJobQueue`:
 *     the `?status=` filter (running|waiting, anything else resets to ""),
 *     the owner/repo filters (instance scope ONLY — repoID==0), the paged
 *     `FindJobQueueJobs` (pageSize 50), `GetTaskRunnerNames` over the page's
 *     claimed task ids, `ShowRepoColumn = repoID == 0`, the pager whose
 *     refresh link carries page + refresh=1 + the filter params, and
 *     `?refresh=1` re-rendering ONLY `shared/actions/job_queue_list`.
 *   - `models/actions/run_job_queue.go` — the queue query: reusable-caller
 *     jobs never count; waiting = (status 5, task_id 0); running =
 *     status IN (6, 8) ("a cancelling job still occupies its runner"); the
 *     order is active-first-by-started, then queued-by-updated, then id.
 *   - `templates/repo/actions/job_queue.tmpl` + `templates/shared/actions/
 *     job_queue_list.tmpl` + `templates/admin/actions.tmpl` (PageType
 *     "job_queue") + `templates/repo/actions/sidebar.tmpl`.
 *
 * ## Mount record
 *
 *   GET /{owner}/{repo}/actions/job_queue  → the repo shell
 *   GET /-/admin/actions/job_queue         → the admin shell
 *
 * both through `loadJobQueuePageData` + the shared `JobQueueFragment`;
 * `?refresh=1` answers the fragment ONLY (no base layout) on either scope —
 * the morph contract div `#actions-job-queue`
 * (`data-global-init="initActionJobQueueList"` — the bundle's timer fetches
 * the refresh link and morphs the outerHTML). Upstream's `GET /-/admin/
 * actions` LocationRedirect onto ./actions/runners and the admin runners/
 * variables/scoped-workflows routes stay unclaimed — those pages are not
 * landed (the dead-link rule; the C7 unit lands the REPO-scope runners arm
 * only).
 *
 * ## Data (SPEC-0012 M1a's landed store)
 *
 * The queue reads `action_run_jobs` joined (batched, LoadAttributes' shape)
 * with `action_runs` (index, commit_sha) and `repositories` (full name), and
 * `action_tasks`⟗`action_runners` for the Runner column
 * (models/actions/task.go:165-185 — taskID → runner name; a missing row
 * renders empty exactly like the template's zero-value `index`). The owner
 * filter rides `action_run_jobs.owner_id` (the M1a insert copies
 * run.owner_id per job) where upstream joins `repository.owner_id` —
 * equivalent within the queue window, divergent only across an ownership
 * transfer of a repo with still-queued jobs (documented reduction).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The Job cell renders the name + `#index` as PLAIN TEXT: upstream links
 *   `$job.Run.Link` (the run viewer — unlanded, the census C2 unit's page).
 *   The commit cell keeps its link (the commit page is landed); the repo
 *   cell keeps its link (repo home is landed).
 * - The dev-mode arms of `RefreshIntervalMs`/RenderJobQueue (the 1 s/2 s
 *   values and the blank-first-screen debug arm) are upstream's
 *   `setting.IsProd` harness — not ported; the prod intervals (3 s with
 *   activity / 12 s idle) render unconditionally (the census's open
 *   question 6 verdict).
 * - The sidebar (`repo/actions/sidebar.tmpl`) reduces to the Management
 *   menu only: the workflows menu's every item targets the unlanded runs
 *   list (the census C1 unit) or needs M3's workflow parser — rendered as
 *   nothing; the Job-queue item is the page's own (active) entry.
 * - The status glyphs follow `repo/icons/action_status.tmpl`; only
 *   octicon-check / octicon-dot-fill sit in the generated allowlist —
 *   running/cancelling stand in with octicon-clock (carrying upstream's
 *   `rotate-clockwise` class on the running arm), blocked/failure/unknown
 *   with octicon-info; the color classes are upstream's verbatim.
 * - The owner/repo/status filter dropdowns render the upstream anchor
 *   lists; their Fomantic dropdown JS is the bundle's business — the
 *   anchors are plain links that survive without it.
 * - The pager is the family's Newer/Older reduction of base/paginate (the
 *   AdminFamilyPagination shape) keeping the status facet in its hrefs.
 */

import { renderToString } from "hono/jsx/dom/server";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRunJobs, actionRunners, actionRuns, actionTasks, repositories } from "../../db/schema";
import { TimeSince } from "../components/file-list";
import { shortSha } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { AdminFamilyShell } from "./admin-users";

// ---------------------------------------------------------------------------
// Locale (the component-local pattern — every string cites its upstream key;
// values are the pin's locale_en-US.json English texts)
// ---------------------------------------------------------------------------

export const actionsQueueLocale = {
  actions: "Actions", // "actions.actions" (the page Title, job_queue.go:25/80)
  management: "Management", // "actions.management" (sidebar.tmpl:41)
  job_queue: "Job queue", // "actions.job_queue.title"
  total: "Total %d", // "admin.total %d"
  repository: "Repository", // "repository"
  owner: "Owner", // "repo.owner"
  status: "Status", // "actions.runs.status"
  status_no_select: "All status", // "actions.runs.status_no_select"
  job: "Job", // "actions.runners.task_list.job"
  runs_on: "Runs on", // "actions.job_queue.runs_on"
  runner_title: "Runner", // "actions.runners.runner_title"
  commit: "Commit", // "actions.runs.commit"
  waiting_or_started: "Waiting / started", // "actions.job_queue.waiting_or_started"
  no_jobs: "No jobs are running or waiting to be picked up.", // "actions.job_queue.no_jobs"
  filter_owner_no_select: "All owners", // "actions.job_queue.filter_owner_no_select"
  filter_repo_no_select: "All repositories", // "actions.job_queue.filter_repo_no_select"
  status_running: "Running", // "actions.status.running"
  status_waiting: "Waiting", // "actions.status.waiting"
} as const;

/** models/actions/status.go:15-25's String() spellings (the template's
 *  `Status.String` — the icon map's keys and the `?status=` filter values). */
export function actionsStatusToString(status: number): string {
  switch (status) {
    case 1:
      return "success";
    case 2:
      return "failure";
    case 3:
      return "cancelled";
    case 4:
      return "skipped";
    case 5:
      return "waiting";
    case 6:
      return "running";
    case 7:
      return "blocked";
    case 8:
      return "cancelling";
    case 9:
      return "pending";
    default:
      return "unknown";
  }
}

/** "actions.status.{string}" texts (locale_en-US.json at the pin). */
export function actionsStatusLocaleText(status: number): string {
  switch (status) {
    case 1:
      return "Success";
    case 2:
      return "Failure";
    case 3:
      return "Canceled";
    case 4:
      return "Skipped";
    case 5:
      return "Waiting";
    case 6:
      return "Running";
    case 7:
      return "Blocked";
    case 8:
      return "Canceling";
    case 9:
      return "Pending";
    default:
      return "Unknown";
  }
}

/** The queue's page size (job_queue.go:33 `jobQueuePageSize = 50`). */
export const ACTIONS_JOB_QUEUE_PAGE_SIZE = 50;

/**
 * RefreshIntervalMs (job_queue.go:36-42) — the PROD arms verbatim; the
 * dev-mode values (1 s / 2 s) are upstream's `setting.IsProd` harness and
 * are not ported (the module header).
 */
export function actionsQueueRefreshIntervalMs(hasActivity: boolean): number {
  return hasActivity ? 3_000 : 12_000;
}

/** repo/icons/action_status.tmpl — the icon map with the allowlist stand-ins
 *  (the module header's glyph note); the color classes are verbatim. */
export function actionsStatusIcon(status: number): {
  name: "octicon-check" | "octicon-dot-fill" | "octicon-clock" | "octicon-info";
  class: string;
} {
  switch (actionsStatusToString(status)) {
    case "success":
      return { name: "octicon-check", class: "tw-text-green" };
    case "waiting":
      return { name: "octicon-dot-fill", class: "tw-text-yellow" };
    case "running":
      // Upstream gitea-running (a spinner) — octicon-clock carries the same
      // rotation class.
      return { name: "octicon-clock", class: "tw-text-yellow rotate-clockwise" };
    case "cancelling":
      // Upstream octicon-stop (yellow).
      return { name: "octicon-clock", class: "tw-text-yellow" };
    case "skipped":
      // Upstream octicon-skip (text-light) — the clock's neutral arm.
      return { name: "octicon-clock", class: "tw-text-text-light" };
    case "pending":
      // Upstream octicon-circle (text-light).
      return { name: "octicon-dot-fill", class: "tw-text-text-light" };
    case "blocked":
      // Upstream octicon-blocked (yellow).
      return { name: "octicon-info", class: "tw-text-yellow" };
    default:
      // failure / unknown — upstream octicon-x (red); octicon-info is the
      // red stand-in (the glyph differs, the color contract carries).
      return { name: "octicon-info", class: "tw-text-red" };
  }
}

/** One status glyph (action_status.tmpl's 16px default — the tooltip rides
 *  the caller's span). */
export function ActionStatusIcon(props: { status: number; size?: number }) {
  const glyph = actionsStatusIcon(props.status);
  return <Icon name={glyph.name} size={props.size ?? 16} class={glyph.class} />;
}

// ---------------------------------------------------------------------------
// The queue query (models/actions/run_job_queue.go)
// ---------------------------------------------------------------------------

const STATUS_WAITING = 5;
const STATUS_RUNNING = 6;
const STATUS_CANCELLING = 8;

/** queuedJobsCond (run_job_queue.go:27): waiting AND unclaimed. */
const queuedJobsCond = and(eq(actionRunJobs.status, STATUS_WAITING), eq(actionRunJobs.taskId, 0));
/** runningJobsCond (run_job_queue.go:29-30): a cancelling job still occupies
 *  its runner. */
const runningJobsCond = inArray(actionRunJobs.status, [STATUS_RUNNING, STATUS_CANCELLING]);

/** statusCond (run_job_queue.go:32-42): the ?status= filter's arms. */
function queueStatusCond(filterStatus: string) {
  if (filterStatus === "running") return runningJobsCond;
  if (filterStatus === "waiting") return queuedJobsCond;
  return or(runningJobsCond, queuedJobsCond);
}

/** The scope-agnostic base condition: reusable-caller jobs never queue
 *  (run_job_queue.go:22-24). */
const queueBaseCond = eq(actionRunJobs.isReusableCaller, false);

/** jobQueueOrderBy (run_job_queue.go:45-48): active first by start time,
 *  then queued in pickup order, then id. */
function queueOrderBy() {
  return [
    sql`CASE WHEN ${actionRunJobs.status} IN (${STATUS_RUNNING}, ${STATUS_CANCELLING}) THEN 0 ELSE 1 END ASC`,
    sql`CASE WHEN ${actionRunJobs.status} IN (${STATUS_RUNNING}, ${STATUS_CANCELLING}) THEN ${actionRunJobs.started} ELSE ${actionRunJobs.updated} END ASC`,
    asc(actionRunJobs.id),
  ];
}

/** The slim job row the page query selects (FindJobQueueJobs' Cols list —
 *  the payload columns are skipped). */
export interface QueueJobRow {
  id: number;
  repoId: string;
  name: string;
  status: number;
  runId: number;
  runsOn: string;
  started: Date | null;
  updated: Date;
  taskId: number;
}

/**
 * FindJobQueueJobs (run_job_queue.go:58-84): the total, then one page in
 * `jobQueueOrderBy` order. The auto-refresh page clamp rides too — a queue
 * that shrank under a reader on page N shows the LAST page, never empty
 * (run_job_queue.go:70-71).
 */
export async function findJobQueueJobs(
  d1: D1Database,
  opts: { repoId?: string; ownerId?: number; status?: string },
  page: number,
  pageSize: number = ACTIONS_JOB_QUEUE_PAGE_SIZE,
): Promise<{ jobs: QueueJobRow[]; total: number }> {
  const conds = [queueBaseCond, queueStatusCond(opts.status ?? "")];
  if (opts.repoId !== undefined && opts.repoId !== "") {
    conds.push(eq(actionRunJobs.repoId, opts.repoId));
  }
  if (opts.ownerId !== undefined && opts.ownerId > 0) {
    // Upstream joins repository on repo_id for owner_id; the M1a store
    // carries owner_id on every job row (the module header's note).
    conds.push(eq(actionRunJobs.ownerId, opts.ownerId));
  }
  const db = drizzle(d1);
  const totalRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(actionRunJobs)
    .where(and(...conds));
  const total = Number(totalRows[0]?.count ?? 0);
  if (total === 0) {
    return { jobs: [], total: 0 };
  }
  const clampedPage = Math.min(page, Math.ceil(total / pageSize));
  const jobs = await db
    .select({
      id: actionRunJobs.id,
      repoId: actionRunJobs.repoId,
      name: actionRunJobs.name,
      status: actionRunJobs.status,
      runId: actionRunJobs.runId,
      runsOn: actionRunJobs.runsOn,
      started: actionRunJobs.started,
      updated: actionRunJobs.updated,
      taskId: actionRunJobs.taskId,
    })
    .from(actionRunJobs)
    .where(and(...conds))
    .orderBy(...queueOrderBy())
    .limit(pageSize)
    .offset((clampedPage - 1) * pageSize);
  return { jobs, total };
}

/**
 * GetTaskRunnerNames (models/actions/task.go:165-185): the page's claimed
 * task ids → their runners' names.
 */
export async function getTaskRunnerNames(d1: D1Database, taskIds: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  if (taskIds.length === 0) {
    return names;
  }
  const rows = await drizzle(d1)
    .select({ id: actionTasks.id, name: actionRunners.name })
    .from(actionTasks)
    .innerJoin(actionRunners, eq(actionRunners.id, actionTasks.runnerId))
    .where(inArray(actionTasks.id, taskIds))
    .all();
  for (const row of rows) {
    names.set(row.id, row.name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// The page data (RenderJobQueue, job_queue.go:37-130)
// ---------------------------------------------------------------------------

/** One owner entry of the instance scope's filter dropdown. */
export interface JobQueueFilterOwner {
  id: number;
  name: string;
}

/** One repo entry of the instance scope's filter dropdown. */
export interface JobQueueFilterRepo {
  id: string;
  fullName: string;
  ownerId: number;
  ownerName: string;
}

/** One render row — the slim job row plus the batched enrichments. */
export interface JobQueueJobView {
  id: number;
  name: string;
  status: number;
  runsOn: string[];
  started: Date | null;
  updated: Date;
  runnerName: string;
  runIndex: number | null;
  commitSha: string;
  repoFullName: string | null;
  repoLink: string | null;
}

export type JobQueueScope = { kind: "repo"; repoId: string; repoLink: string } | { kind: "admin" };

export interface JobQueuePageData {
  scope: JobQueueScope;
  /** ShowRepoColumn (job_queue.go:78 — the instance scope only). */
  showRepoColumn: boolean;
  jobs: JobQueueJobView[];
  total: number;
  page: number;
  more: boolean;
  filterStatus: string;
  // The instance scope's filter state (job_queue.go:49-51, 118-125). The
  // repo id is the TEXT repositories.id (null = unset — upstream's 0).
  filterOwnerId: number;
  filterRepoId: string | null;
  filterOwnerName: string | null;
  filterRepoName: string | null;
  filterOwners: JobQueueFilterOwner[];
  filterRepos: JobQueueFilterRepo[];
  refreshLink: string;
  refreshIntervalMs: number;
}

/**
 * renderJobQueueFilterOptions (job_queue.go:87-141): the instance scope's
 * dropdown arms — up to 200 repos with pending work (plus the selected
 * scope even when its queue is empty), sorted by full name (base.
 * NaturalSortCompare reduces to plain lexicographic here — a documented
 * reduction), the owners derived first-seen from the sorted repos and
 * sorted by name. Our repositories.id is TEXT (the M1a sentinel adaptation),
 * so the selected repo id stays a string where upstream parses an int64.
 */
export async function loadJobQueueFilterOptions(
  d1: D1Database,
  reqRepoId: string,
  reqOwnerId: number,
): Promise<{
  filterOwnerId: number;
  filterRepoId: string | null;
  filterOwnerName: string | null;
  filterRepoName: string | null;
  owners: JobQueueFilterOwner[];
  repos: JobQueueFilterRepo[];
}> {
  const db = drizzle(d1);
  const idRows = await db
    .selectDistinct({ repoId: actionRunJobs.repoId })
    .from(actionRunJobs)
    .where(and(queueBaseCond, or(runningJobsCond, queuedJobsCond)))
    .limit(200);
  const repoIds = idRows.map((row) => row.repoId);
  if (reqRepoId !== "" && !repoIds.includes(reqRepoId)) {
    repoIds.push(reqRepoId);
  }
  const repoRows =
    repoIds.length > 0
      ? await db
          .select({
            id: repositories.id,
            ownerNamespace: repositories.ownerNamespace,
            slug: repositories.slug,
            ownerId: repositories.ownerId,
          })
          .from(repositories)
          .where(inArray(repositories.id, repoIds))
          .all()
      : [];
  const repos: JobQueueFilterRepo[] = repoRows
    .map((row) => ({
      id: row.id,
      fullName: `${row.ownerNamespace}/${row.slug}`,
      ownerId: row.ownerId ?? 0,
      ownerName: row.ownerNamespace,
    }))
    .sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));

  const owners: JobQueueFilterOwner[] = [];
  const seenOwners = new Set<number>();
  for (const repo of repos) {
    if (!seenOwners.has(repo.ownerId)) {
      seenOwners.add(repo.ownerId);
      owners.push({ id: repo.ownerId, name: repo.ownerName });
    }
  }

  let filterRepoId: string | null = null;
  let filterOwnerId = 0;
  let filterRepoName: string | null = null;
  let filterOwnerName: string | null = null;
  const selectedRepo = repos.find((repo) => repo.id === reqRepoId);
  if (selectedRepo !== undefined) {
    filterRepoId = selectedRepo.id;
    filterRepoName = selectedRepo.fullName;
  } else if (reqOwnerId > 0) {
    // The selected owner's name renders even when its queue is empty (the
    // upstream fetches the user row). Our owner names ride the repo rows;
    // an owner whose repos hold no queue rows renders the generic label.
    filterOwnerId = reqOwnerId;
    const owner = owners.find((candidate) => candidate.id === reqOwnerId);
    if (owner !== undefined) {
      filterOwnerName = owner.name;
    } else {
      owners.push({ id: reqOwnerId, name: "" });
    }
  }
  owners.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // An owner filter narrows the repo dropdown to that owner's repos
  // (job_queue.go:140-141).
  const scopedRepos = filterOwnerId > 0 ? repos.filter((repo) => repo.ownerId === filterOwnerId) : repos;
  return { filterOwnerId, filterRepoId, filterOwnerName, filterRepoName, owners, repos: scopedRepos };
}

/**
 * RenderJobQueue (job_queue.go:37-130) — the loader both mounts ride. The
 * repo scope pins repoId (the query's owner/repo params are ignored —
 * renderJobQueueFilterOptions only runs when repoID == 0); the admin scope
 * computes the filter options and applies owner_id/repo_id.
 */
export async function loadJobQueuePageData(d1: D1Database, scope: JobQueueScope, search: URLSearchParams): Promise<JobQueuePageData> {
  const page = Math.max(Number.parseInt(search.get("page") ?? "", 10) || 1, 1);
  let filterStatus = search.get("status") ?? "";
  if (filterStatus !== "running" && filterStatus !== "waiting") {
    filterStatus = "";
  }

  const showRepoColumn = scope.kind === "admin";
  let filterOwnerId = 0;
  let filterRepoId: string | null = null;
  let filterOwnerName: string | null = null;
  let filterRepoName: string | null = null;
  let owners: JobQueueFilterOwner[] = [];
  let repos: JobQueueFilterRepo[] = [];
  if (scope.kind === "admin") {
    const reqRepoId = search.get("repo_id") ?? "";
    const reqOwnerId = Number.parseInt(search.get("owner_id") ?? "", 10) || 0;
    const options = await loadJobQueueFilterOptions(d1, reqRepoId, reqOwnerId);
    filterOwnerId = options.filterOwnerId;
    filterRepoId = options.filterRepoId;
    filterOwnerName = options.filterOwnerName;
    filterRepoName = options.filterRepoName;
    owners = options.owners;
    repos = options.repos;
  }

  const { jobs, total } = await findJobQueueJobs(
    d1,
    {
      repoId: scope.kind === "repo" ? scope.repoId : filterRepoId ?? undefined,
      ownerId: filterOwnerId > 0 ? filterOwnerId : undefined,
      status: filterStatus,
    },
    page,
  );

  // ActionJobList.LoadAttributes' two batched reads (the run identity + the
  // repo identity) then GetTaskRunnerNames over the claimed tasks.
  const runIds = [...new Set(jobs.map((job) => job.runId))];
  const repoIds = [...new Set(jobs.map((job) => job.repoId))];
  const [runRows, repoRows, runnerNames] = await Promise.all([
    runIds.length > 0
      ? drizzle(d1)
          .select({ id: actionRuns.id, index: actionRuns.index, commitSha: actionRuns.commitSha })
          .from(actionRuns)
          .where(inArray(actionRuns.id, runIds))
          .all()
      : Promise.resolve([] as { id: number; index: number; commitSha: string }[]),
    repoIds.length > 0
      ? drizzle(d1)
          .select({ id: repositories.id, ownerNamespace: repositories.ownerNamespace, slug: repositories.slug })
          .from(repositories)
          .where(inArray(repositories.id, repoIds))
          .all()
      : Promise.resolve([] as { id: string; ownerNamespace: string; slug: string }[]),
    getTaskRunnerNames(
      d1,
      jobs.map((job) => job.taskId).filter((taskId) => taskId > 0),
    ),
  ]);
  const runsById = new Map(runRows.map((row) => [row.id, row]));
  const reposById = new Map(repoRows.map((row) => [row.id, row]));

  const views: JobQueueJobView[] = jobs.map((job) => {
    const run = runsById.get(job.runId);
    const repo = reposById.get(job.repoId);
    const repoLink = repo !== undefined ? `/${repo.ownerNamespace}/${repo.slug}` : null;
    return {
      id: job.id,
      name: job.name,
      status: job.status,
      runsOn: (JSON.parse(job.runsOn) as string[]) ?? [],
      started: job.started,
      updated: job.updated,
      runnerName: runnerNames.get(job.taskId) ?? "",
      runIndex: run?.index ?? null,
      commitSha: run?.commitSha ?? "",
      repoFullName: repo !== undefined ? `${repo.ownerNamespace}/${repo.slug}` : null,
      repoLink,
    };
  });

  // The pager's param set (job_queue.go:107-117): the filters + the page,
  // refresh=1 appended — the refresh link is `EscapedPath + "?" + query`
  // verbatim (no AppSubURL — the root posture).
  const query = new URLSearchParams();
  if (filterOwnerId > 0) query.set("owner_id", String(filterOwnerId));
  if (filterRepoId !== null) query.set("repo_id", filterRepoId);
  if (filterStatus !== "") query.set("status", filterStatus);
  const pageQuery = new URLSearchParams(query);
  pageQuery.set("page", String(page));
  pageQuery.set("refresh", "1");
  const refreshPath = scope.kind === "repo" ? `${scope.repoLink}/actions/job_queue` : "/-/admin/actions/job_queue";

  return {
    scope,
    showRepoColumn,
    jobs: views,
    total,
    page,
    more: page * ACTIONS_JOB_QUEUE_PAGE_SIZE < total,
    filterStatus,
    filterOwnerId,
    filterRepoId,
    filterOwnerName,
    filterRepoName,
    filterOwners: owners,
    filterRepos: repos,
    refreshLink: `${refreshPath}?${pageQuery.toString()}`,
    refreshIntervalMs: actionsQueueRefreshIntervalMs(views.length > 0),
  };
}

// ---------------------------------------------------------------------------
// The render (templates/shared/actions/job_queue_list.tmpl — the fragment
// both scopes render; repo/actions/job_queue.tmpl and admin/actions.tmpl are
// the shells)
// ---------------------------------------------------------------------------

/** The status filter dropdown's item href (job_queue_list.tmpl:40-47): the
 *  owner/repo params ride verbatim — upstream renders them 0 at repo scope
 *  and the loader treats 0 as unset. */
function statusFilterHref(data: JobQueuePageData, status: string | null): string {
  const ownerId = data.scope.kind === "admin" ? data.filterOwnerId : 0;
  const repoId = data.scope.kind === "admin" ? data.filterRepoId : 0;
  const params = new URLSearchParams();
  params.set("owner_id", String(ownerId));
  params.set("repo_id", String(repoId));
  if (status !== null) params.set("status", status);
  return `?${params.toString()}`;
}

/** shared/actions/job_queue_list.tmpl — the morph contract div BOTH scopes
 *  render (full page and `?refresh=1` fragment alike). */
export function JobQueueFragment(props: { data: JobQueuePageData }) {
  const { data } = props;
  return (
    <div
      id="actions-job-queue"
      class="runner-container"
      data-global-init="initActionJobQueueList"
      data-job-queue-refresh-link={data.refreshLink}
      data-job-queue-refresh-interval={String(data.refreshIntervalMs)}
    >
      <div class="ui top attached header flex-left-right">
        <strong>
          {actionsQueueLocale.job_queue} ({actionsQueueLocale.total.replace("%d", String(data.total))})
        </strong>
        <div class="ui secondary filter menu flex-text-block tw-m-0" id="actions-job-queue-filter">
          {data.showRepoColumn ? (
            <>
              {/* The owner dropdown (job_queue_list.tmpl:10-27) — disabled
                  while no owner offers queue rows. */}
              <div class={data.filterOwners.length === 0 ? "ui disabled dropdown jump item" : "ui dropdown jump item"}>
                <span class="text">{data.filterOwnerName ?? actionsQueueLocale.owner}</span>
                <div class="menu">
                  <a class={data.filterOwnerId === 0 ? "item selected" : "item"} href={statusFilterHref(data, data.filterStatus)}>
                    {actionsQueueLocale.filter_owner_no_select}
                  </a>
                  {data.filterOwners.map((owner) => (
                    <a
                      class={owner.id === data.filterOwnerId ? "item selected" : "item"}
                      href={`?owner_id=${owner.id}&${new URLSearchParams({ status: data.filterStatus }).toString()}`}
                    >
                      {owner.name}
                    </a>
                  ))}
                </div>
              </div>
              {/* The repo dropdown (job_queue_list.tmpl:28-45). */}
              <div class={data.filterRepos.length === 0 ? "ui disabled dropdown jump item" : "ui dropdown jump item"}>
                <span class="text">{data.filterRepoName ?? actionsQueueLocale.repository}</span>
                <div class="menu">
                  <a class={data.filterRepoId === null ? "item selected" : "item"} href={statusFilterHref(data, data.filterStatus)}>
                    {actionsQueueLocale.filter_repo_no_select}
                  </a>
                  {data.filterRepos.map((repo) => (
                    <a
                      class={repo.id === String(data.filterRepoId) ? "item selected" : "item"}
                      href={`?owner_id=${data.filterOwnerId}&repo_id=${repo.id}&${new URLSearchParams({ status: data.filterStatus }).toString()}`}
                    >
                      {repo.fullName}
                    </a>
                  ))}
                </div>
              </div>
            </>
          ) : null}
          {/* The status dropdown (job_queue_list.tmpl:46-63) — both scopes. */}
          <div class="ui dropdown jump item">
            <span class="text">
              {data.filterStatus === "running"
                ? actionsQueueLocale.status_running
                : data.filterStatus === "waiting"
                  ? actionsQueueLocale.status_waiting
                  : actionsQueueLocale.status}
            </span>
            <div class="menu">
              <a class={data.filterStatus === "" ? "item selected" : "item"} href={statusFilterHref(data, null)}>
                {actionsQueueLocale.status_no_select}
              </a>
              {(["running", "waiting"] as const).map((status) => (
                <a class={data.filterStatus === status ? "item selected" : "item"} href={statusFilterHref(data, status)}>
                  <span class="flex-text-inline tw-gap-2">
                    <ActionStatusIcon status={status === "running" ? STATUS_RUNNING : STATUS_WAITING} />
                    {status === "running" ? actionsQueueLocale.status_running : actionsQueueLocale.status_waiting}
                  </span>
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div class="ui attached table segment">
        {data.jobs.length > 0 ? (
          <table class="ui very basic table unstackable">
            <thead>
              <tr>
                <th>{actionsQueueLocale.status}</th>
                {data.showRepoColumn ? <th>{actionsQueueLocale.repository}</th> : null}
                <th>{actionsQueueLocale.job}</th>
                <th>{actionsQueueLocale.runs_on}</th>
                <th>{actionsQueueLocale.runner_title}</th>
                <th>{actionsQueueLocale.commit}</th>
                <th>{actionsQueueLocale.waiting_or_started}</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((job) => (
                <tr>
                  <td>
                    <span class="flex-text-inline" data-tooltip-content={actionsStatusLocaleText(job.status)}>
                      <ActionStatusIcon status={job.status} />
                    </span>
                  </td>
                  {data.showRepoColumn ? (
                    <td>{job.repoLink !== null ? <a href={job.repoLink}>{job.repoFullName}</a> : null}</td>
                  ) : null}
                  {/* The run link is the census C2 unit's page (unlanded) —
                      the name renders as text (the module header). */}
                  <td>
                    {job.name} <span class="text grey">#{job.runIndex ?? "?"}</span>
                  </td>
                  <td>
                    <span class="flex-text-inline tw-flex-wrap">
                      {job.runsOn.map((label) => (
                        <span class="ui label">{label}</span>
                      ))}
                    </span>
                  </td>
                  <td>{job.runnerName}</td>
                  <td>
                    {job.repoLink !== null && job.commitSha !== "" ? (
                      <a href={`${job.repoLink}/commit/${job.commitSha}`}>{shortSha(job.commitSha)}</a>
                    ) : null}
                  </td>
                  <td>
                    <TimeSince unixSeconds={(job.started ?? job.updated).getTime() / 1000} tz="+0000" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div class="tw-text-center tw-p-4">{actionsQueueLocale.no_jobs}</div>
        )}
        {/* base/paginate — the family's Newer/Older reduction, keeping the
            status facet. */}
        {data.page > 1 || data.more ? (
          <div class="center page buttons">
            <div class="ui borderless pagination menu">
              {data.page > 1 ? (
                <a class="item navigation" href={`?page=${data.page - 1}${data.filterStatus !== "" ? `&status=${data.filterStatus}` : ""}`}>
                  <span class="navigation_label">Newer</span>
                </a>
              ) : null}
              {data.more ? (
                <a class="item navigation" href={`?page=${data.page + 1}${data.filterStatus !== "" ? `&status=${data.filterStatus}` : ""}`}>
                  <span class="navigation_label">Older</span>
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The fragment render — `?refresh=1`'s whole-body answer on both scopes
 *  (RenderJobQueue's `ctx.HTML(200, "shared/actions/job_queue_list")` arm):
 *  exactly the morph-target div, NO base layout (the lastcommit-fragment
 *  convention). */
export function renderJobQueueFragment(data: JobQueuePageData): string {
  return renderToString(<JobQueueFragment data={data} />);
}

// ---------------------------------------------------------------------------
// The repo tab shell (templates/repo/actions/job_queue.tmpl)
// ---------------------------------------------------------------------------

/** The sidebar's Management menu (repo/actions/sidebar.tmpl:38-49) — the
 *  workflows menu renders NOTHING until the runs list lands (its every
 *  item targets the census C1 unit's page — the dead-link rule; the module
 *  header). octicon-list-ordered is outside the generated allowlist —
 *  octicon-checklist is the documented stand-in (the SECRET_ICON
 *  convention). */
export function RepoActionsQueueSidebar(props: { repoLink: string }) {
  return (
    <div class="flex-container-nav">
      <div class="ui fluid secondary vertical menu flex-items-block">
        <div>{actionsQueueLocale.management}</div>
        <a class="item active" href={`${props.repoLink}/actions/job_queue`}>
          <Icon name="octicon-checklist" />
          <span class="gt-ellipsis">{actionsQueueLocale.job_queue}</span>
        </a>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderRepoActionsJobQueuePage(ctx: UiContext, data: JobQueuePageData): string {
  return renderPage(<RepoActionsJobQueuePage ctx={ctx} data={data} />);
}

/** The repo job-queue page (§2.4.1 discriminator: `repository actions` — the
 *  page-content class of repo/actions/job_queue.tmpl). BaseLayout renders
 *  the repo header from ctx.repo. */
export function RepoActionsJobQueuePage(props: { ctx: UiContext; data: JobQueuePageData }) {
  const { ctx, data } = props;
  if (ctx.repo === undefined) throw new Error("RepoActionsJobQueuePage requires ctx.repo");
  const repoLink = `/${ctx.repo.ownerNamespace}/${ctx.repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={actionsQueueLocale.actions} pageClass="repository actions">
      <div class="ui container">
        <div class="flex-container">
          <RepoActionsQueueSidebar repoLink={repoLink} />
          <div class="flex-container-main">
            <JobQueueFragment data={data} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The admin shell (templates/admin/actions.tmpl PageType "job_queue")
// ---------------------------------------------------------------------------

/** The full-document render. */
export function renderAdminActionsJobQueuePage(ctx: UiContext, data: JobQueuePageData): string {
  return renderPage(<AdminActionsJobQueuePage ctx={ctx} data={data} />);
}

/** The admin job-queue page (§2.4.1 discriminator: `admin actions` —
 *  admin/layout_head's pageClass dict, admin/actions.tmpl:1). */
export function AdminActionsJobQueuePage(props: { ctx: UiContext; data: JobQueuePageData }) {
  return (
    <AdminFamilyShell ctx={props.ctx} title={actionsQueueLocale.actions} pageClass="admin actions" active="actions-job-queue">
      <JobQueueFragment data={props.data} />
    </AdminFamilyShell>
  );
}
