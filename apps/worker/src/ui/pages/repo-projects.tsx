/**
 * The REPO-scoped projects surface — pages wave 45 (the UI-parity survey's
 * re-ranked #1, docs/compat/ui-parity-survey.md §F: web.go:1544-1563 — the
 * F-family row the restored `repo === "-"` guard held unclaimed until this
 * wave): `/{owner}/{repo}/projects` list + `/{id}` board + the write group +
 * the workflow tails over the landed 64-op projects family (src/api/services/
 * projects.ts — the repo scope REG'd `fc123b0`). The owner-board precedent is
 * COMPLETE (pages/owner-project-board.tsx, 9b49cd2); this module ports its
 * shapes onto the repo scope's three differences:
 *
 * 1. RESOLUTION — the owner pages resolve a user-or-org owner
 *    (resolveOwnerProjects); the repo scope rides the landed
 *    `requireVisibleRepo` family (resolveUiRequest's §2.5 repo read — the
 *    read grant IS the reader arm, services/repo-access.ts) and then the
 *    repo-scoped project lookup is GetProjectByID over
 *    `repoProjectScope(repo.id)` — another repo's id reads as not found (the
 *    upstream handlers' `p.RepoID != ctx.Repo.Repository.ID` NotFound arm,
 *    projects.go:193-197/253-257/292-296, folded into the scope condition).
 * 2. WRITE GATES — upstream's group ladder (web.go:1562-1563) reduces to the
 *    landed predicates exactly like the repo-scope API routes declared
 *    (routes/projects-repo.ts's header table):
 *    - read group `optSignIn + RepoAssignment + reqRepoProjectsReader +
 *      repo.MustEnableRepoProjects`: the §2.5 read grant (visible repo —
 *      the RequireUnitReader arm is unreachable in our collapsed matrix,
 *      visibility ⇒ read) plus the UNIT TOGGLE;
 *    - `repo.MustEnableRepoProjects` (repo/projects.go:43-58 —
 *      ProjectsConfig().IsProjectsAllowed("repo")): the landed store MODELS
 *      the toggle — `repo_settings.has_projects` (the repo-edit PATCH's
 *      stored flag, services/repo-settings.ts; upstream's four-mode
 *      ProjectsConfig reduces to the boolean, the landed store's shape).
 *      Every family and the header tab gate on it; a disabled unit is the
 *      NotFound shell. NOTE the default: upstream's DefaultRepoUnits has
 *      projects disabled on fresh repos too — the store's default matches.
 *    - write group `reqRepoProjectsWriter + RepoMustNotBeArchived`:
 *      anonymous → the login 303, then `canWriteRepository` (the landed
 *      general write grant — the units model is absent, the repo-labels
 *      precedent) and `repo.isArchived` → the NotFound shell.
 *    - the workflow writes' second layer `CanManageWorkflows`
 *      (services/projects/workflow.go:24-31 repo arm — write access to BOTH
 *      the issues and pulls units): collapses to the same repo-wide writer
 *      (the routes/projects-repo.ts header's exact reduction, its
 *      requireWorkflowManager) — no separate gate below.
 * 3. ENTRY POINTS — the repo header's Projects tab (upstream repo/header.tmpl:
 *     146-154, gated on the SAME unit condition, `data-shortcut-keys="g b"`,
 *     the count badge the documented reduction — the repositories table
 *     carries no project counters, the projects store's DEVIATION note; the
 *     icon is the landed set's octicon-project-symlink, the org tab
 *     precedent — upstream's octicon-project is not in the generated set).
 *
 * ## Reuse vs adapt (the precedent's module structure as the guide)
 *
 * IMPORTED unchanged from pages/owner-project-board.tsx (owner-agnostic
 * shapes): the locale strings (upstream resolves the SAME locale keys at both
 * scopes), WORKFLOW_EVENTS, the project form (ProjectFormBlock +
 * parse/validate — one shared template upstream too, projects/new.tmpl), the
 * column-form pair, the workflow-form pair + its write tail
 * deleteWorkflowFromForm, the updateProjectFromForm write, and the board's
 * facet parsers (parseBoardLabelIds/positiveIntOrNull). From pages/
 * owner-projects.tsx: the list locale, the page size, the state facet parse,
 * and the two list atoms (ProjectStateToggle, ProjectListItem).
 * ADAPTED (owner-bound in the precedent — its data types carry the
 * user-or-org owner union and its chrome renders org/profile arms): the list
 * block (adds the write controls upstream renders only at this scope — the
 * New Project button + per-row edit/open/close/delete, the delete-confirm
 * dialog reduced to plain submits), the board (the single-repo loader —
 * upstream passes RepoIDs: [repo.ID] with no visibility walk, projects.go:
 * 322-328, because the page's repo grant already covers every member issue —
 * the card renderer's DOM kept verbatim), and the workflows page (the repo
 * arm's chrome + label pool: the repo's labels PLUS the owner org's
 * owner-level labels, GetProjectLabels' repository arm — the same pool the
 * repo-scope API writes validate against).
 *
 * ## The slice (honest scoping — the no-JS port, the precedent's reductions)
 *
 * Everything the owner board landed ports verbatim at this scope: the board
 * with its facet filters honored in memory (`?labels=`, `?assignee=`,
 * `?milestone=`; the count reflects the filter), the form-POST write group
 * (POST /new, /{id}/edit|delete|open|close, /{id}/columns/new,
 * /{id}/{columnID}/default), and the workflow tails (POST /{id}/workflows
 * [/{wid}[/delete]] — the replace-vs-toggle contract, the exact 422s).
 * The SAME reductions carry over with their citations: the PUT/DELETE column
 * arms + the drag-drop /move arms unclaimed (HTML forms cannot emit the
 * verbs; no no-JS control upstream either), the fullscreen/filter-dropdown
 * chrome, the delete-confirm dialogs, the color picker (plain text input),
 * the card image attachments, and the JS workflow builder (one static form).
 * The LIST carries the owner list's reductions (search box + sort dropdown
 * unrendered, `?q=`/`?sort=` silently ignored — no landed keyword/sort arm;
 * the pager reduced to the Older/Newer pair) PLUS this scope's writer
 * controls now live (routes claimed here). The board's top links row
 * (repo/projects/view.tmpl): Labels + Milestones anchor their LIVE pages;
 * the New Issue button anchors the LANDED `/issues/new` form — upstream's
 * `/issues/new/choose?project={id}` chooser (with its project preselect)
 * is unlanded, so the anchor carries no dead path and no preselect (the
 * documented divergence).
 */

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../../api/errors";
import {
  createProject,
  createWorkflow,
  listColumnIssues,
  listColumns,
  listProjects,
  listWorkflows,
  projectIssueCounts,
  repoProjectScope,
  toApiWorkflowActions,
  toApiWorkflowFilters,
  updateWorkflow,
  type ProjectColumnRow,
  type ProjectRow,
  type ProjectWorkflowRow,
} from "../../api/services/projects";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { issueLabelRows } from "../../api/services/issues";
import type { IssueRow, LabelRow } from "../../issues/service";
import { renderMarkdownToHtml } from "../../api/services/markdown";
import { findRepositoryById, type RepositoryWithOwner } from "../../api/services/repository";
import {
  comments,
  issueAssignees,
  issues,
  labels,
  milestones,
  pullRequests,
  users,
} from "../../db/schema";
import { BaseLayout, Icon, renderPage } from "../shell";
import { parsePageNumber } from "../page-data";
import { TimeSince } from "../components/file-list";
import { IssueStateIcon, LabelBadge, contrastColor, type IssueListItem } from "./issues-list";
import { canWriteRepo } from "./file-editor";
// The owner-board precedent (9b49cd2) — the owner-agnostic shapes imported,
// the owner-bound ones adapted (the module header's reuse-vs-adapt note).
// The parse/validate + column/write helpers the HANDLERS compose ride the
// same exports from src/ui/index.ts.
import {
  ownerProjectBoardLocale,
  parseBoardLabelIds,
  positiveIntOrNull,
  ProjectFormBlock,
  validateProjectForm,
  WORKFLOW_EVENTS,
  type BoardCard,
  type ColumnForm,
  type ProjectForm,
  type WorkflowForm,
} from "./owner-project-board";
import {
  OWNER_PROJECTS_PAGE_SIZE,
  ownerProjectsLocale,
  parseOwnerProjectsState,
  ProjectListItem,
  ProjectStateToggle,
} from "./owner-projects";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";

/** Page chrome text beyond the two precedent locales (upstream locale keys
 *  cited) — the board's top links row and the workflow page's chrome. */
export const repoProjectsLocale = {
  labels: "Labels", // "repo.labels"
  milestones: "Milestones", // "repo.milestones"
  new_issue: "New Issue", // "repo.issues.new"
  workflows_title: "Workflows", // "projects.workflows"
} as const;

/** The board's per-column load ceiling (the owner board's BOARD_QUERY_LIMIT
 *  shape — upstream LoadIssuesFromProject has no pagination). */
const BOARD_QUERY_LIMIT = 10_000;

// ---------------------------------------------------------------------------
// The unit toggle + data loading (§3.2 — the landed repo-scope arms)
// ---------------------------------------------------------------------------

/**
 * `repo.MustEnableRepoProjects` (repo/projects.go:43-58) reduced to the
 * landed store's toggle: `repo_settings.has_projects` (missing row = the
 * upstream-default disabled arm). The shared prologue reads it once per
 * repo-scoped request (the header tab rides the same flag); this helper is
 * the page-module seam for callers that hold only the repo row.
 */
export async function repoProjectsEnabled(d1: D1Database, repoId: string): Promise<boolean> {
  return (await loadRepoSettings(d1, repoId)).hasProjects;
}

/** The list page's render inputs. */
export interface RepoProjectsData {
  repo: RepoRow;
  items: Array<{ project: ProjectRow; counts: { open: number; closed: number; total: number } }>;
  /** The active facet (the web handler's binary reading — no "all" arm). */
  state: "open" | "closed";
  page: number;
  /** The ACTIVE state's total (the pager's TotalCount). */
  total: number;
  more: boolean;
  /** The unconditional facet totals (OpenCount/ClosedCount — the toggle's
   *  numbers and the empty-arm decision; upstream reads the maintained repo
   *  counters, the landed store computes both totals — the same numbers). */
  openTotal: number;
  closedTotal: number;
  /** `ctx.Repo.Permission.CanWrite(unit.TypeProjects)` — the landed writer
   *  grant behind the New Project button + the per-row controls. */
  canWrite: boolean;
}

/**
 * Load the list (repo.Projects, projects.go:60-121): the repo-scoped
 * active-state page, the opposite state's total (the handler's FindAndCount
 * + the counts), the per-row joined issue counts (LoadIssueNumbersForProjects'
 * REPOSITORY branch — plain counts, no permission filtering, the landed
 * `projectIssueCounts`), and the writer grant. `?q=`/`?sort=` are silently
 * ignored (the owner list's reduction — no landed keyword/sort arm).
 */
export async function loadRepoProjectsData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  viewer: Viewer,
  params: URLSearchParams,
): Promise<RepoProjectsData> {
  const state = parseOwnerProjectsState(params);
  const isShowClosed = state === "closed";
  const page = parsePageNumber(params.get("page"));
  const scope = repoProjectScope(repo.id);
  const [active, opposite] = await Promise.all([
    listProjects(d1, scope, isShowClosed, page, OWNER_PROJECTS_PAGE_SIZE),
    listProjects(d1, scope, !isShowClosed, 1, 1),
  ]);
  const items = [];
  for (const project of active.items) {
    items.push({ project, counts: await projectIssueCounts(d1, project.id) });
  }
  return {
    repo,
    items,
    state,
    page,
    total: active.total,
    more: page * OWNER_PROJECTS_PAGE_SIZE < active.total,
    openTotal: isShowClosed ? opposite.total : active.total,
    closedTotal: isShowClosed ? active.total : opposite.total,
    canWrite: await canWriteRepo(env, repo, viewer),
  };
}

/** `LoadIssueNumbersForProject`'s repository branch reads ride the landed
 *  `projectIssueCounts` (imported above) — no local fork. */

/** The board page's render inputs (the single-repo card rows). */
export interface RepoProjectBoardData {
  repo: RepoRow;
  /** The resolved repo pair (the cards' link base). */
  repoPair: RepositoryWithOwner;
  project: ProjectRow;
  columns: Array<{ column: ProjectColumnRow; numIssues: number; cards: BoardCard[] }>;
  canWrite: boolean;
  /** The active facet echo (the honored filters). */
  filters: { labels: number[]; assignee: number | null; milestone: number | null };
}

/** Upstream issueTasksPat/issueTasksDonePat (models/issues/issue.go:114-115,
 *  the owner board's citation) — `- [ ]`/`- [x]` list-item checkboxes. */
const ISSUE_TASKS_PATTERN = /(^[\s]*[-*][\s]\[[\sxX]\][\s].)|(\n[\s]*[-*][\s]\[[\sxX]\][\s].)/g;
const ISSUE_TASKS_DONE_PATTERN = /(^[\s]*[-*][\s]\[[xX]\][\s].)|(\n[\s]*[-*][\s]\[[xX]\][\s].)/g;

function issueTaskCounts(content: string | null): { total: number; done: number } {
  if (content === null) return { total: 0, done: 0 };
  return {
    total: content.match(ISSUE_TASKS_PATTERN)?.length ?? 0,
    done: content.match(ISSUE_TASKS_DONE_PATTERN)?.length ?? 0,
  };
}

function unixSeconds(date: Date | null): number {
  return Math.floor((date?.getTime() ?? 0) / 1000);
}

/**
 * Load the board (repo.ViewProject, projects.go:287-438 — the single-repo
 * loader): the columns in `sorting, id` order, per-column
 * `listColumnIssues` reads (RepoIDs: [repo.ID] upstream — the page's repo
 * grant already covers every member issue, no visibility walk), the batched
 * card joins, and the in-memory facet filter (the owner board's reduction —
 * upstream filters in SQL over the same rows; the count reflects the filter,
 * projects.go:354-356).
 */
export async function loadRepoProjectBoardData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  project: ProjectRow,
  viewer: Viewer,
  params: URLSearchParams,
): Promise<RepoProjectBoardData> {
  const labelFilter = parseBoardLabelIds(params.get("labels"));
  const assigneeFilter = positiveIntOrNull(params.get("assignee"));
  const milestoneFilter = positiveIntOrNull(params.get("milestone"));

  const repoPair = await findRepositoryById(d1, repo.id);
  if (repoPair === null) throw new Error("repo pair vanished mid-request");
  const [columnsPage, canWrite] = await Promise.all([
    listColumns(d1, project.id, 1, BOARD_QUERY_LIMIT),
    canWriteRepo(env, repo, viewer),
  ]);

  const columnPages: Array<{ column: ProjectColumnRow; items: IssueRow[] }> = [];
  for (const column of columnsPage.items) {
    const page = await listColumnIssues(d1, repo.id, project.id, column, 1, BOARD_QUERY_LIMIT);
    columnPages.push({ column, items: page.items });
  }
  const allIssues = columnPages.flatMap((entry) => entry.items);
  const issueIds = [...new Set(allIssues.map((issue) => issue.id))];

  // The batched card joins (the owner board's batching pattern): labels,
  // assignees, milestones, posters, PR-merged flags, and the linked-PR walk
  // (ViewProject's linkedPrsMap — the comments cross-reference walk).
  const labelsByIssue = new Map<number, LabelRow[]>();
  const assigneeIdsByIssue = new Map<number, number[]>();
  const assigneeNamesByIssue = new Map<number, string[]>();
  const milestoneById = new Map<number, { id: number; name: string }>();
  const posterById = new Map<number, string>();
  const mergedByIssue = new Map<number, boolean>();
  const linkedPrsByIssue = new Map<number, IssueRow[]>();

  if (issueIds.length > 0) {
    const labelRows = await Promise.all(issueIds.map((id) => issueLabelRows(d1, id)));
    issueIds.forEach((id, index) => labelsByIssue.set(id, labelRows[index] ?? []));

    const assigneeRows = await drizzle(d1)
      .select({ issueId: issueAssignees.issueId, assigneeId: issueAssignees.assigneeId, username: users.username })
      .from(issueAssignees)
      .innerJoin(users, eq(users.id, issueAssignees.assigneeId))
      .where(inArray(issueAssignees.issueId, issueIds))
      .all();
    for (const row of assigneeRows) {
      const ids = assigneeIdsByIssue.get(row.issueId) ?? [];
      ids.push(row.assigneeId);
      assigneeIdsByIssue.set(row.issueId, ids);
      const names = assigneeNamesByIssue.get(row.issueId) ?? [];
      names.push(row.username);
      assigneeNamesByIssue.set(row.issueId, names);
    }

    const milestoneIds = [...new Set(allIssues.map((issue) => issue.milestoneId).filter((id): id is number => id !== null))];
    if (milestoneIds.length > 0) {
      const rows = await drizzle(d1)
        .select({ id: milestones.id, name: milestones.name })
        .from(milestones)
        .where(inArray(milestones.id, milestoneIds))
        .all();
      for (const row of rows) milestoneById.set(row.id, row);
    }

    const posterIds = [...new Set(allIssues.map((issue) => issue.posterId).filter((id): id is number => id !== null))];
    if (posterIds.length > 0) {
      const rows = await drizzle(d1)
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(inArray(users.id, posterIds))
        .all();
      for (const row of rows) posterById.set(row.id, row.username);
    }

    const pullRows = await drizzle(d1)
      .select({ issueId: pullRequests.issueId, hasMerged: pullRequests.hasMerged })
      .from(pullRequests)
      .where(inArray(pullRequests.issueId, issueIds))
      .all();
    for (const row of pullRows) mergedByIssue.set(row.issueId, row.hasMerged);

    const refRows = await drizzle(d1)
      .select({ issueId: comments.issueId, refIssueId: comments.refIssueId })
      .from(comments)
      .where(and(inArray(comments.issueId, issueIds), eq(comments.refIsPull, true)))
      .all();
    const refIssueIds = [
      ...new Set(refRows.map((row) => row.refIssueId).filter((id): id is number => id !== null && id > 0)),
    ];
    if (refIssueIds.length > 0) {
      const prRows = await drizzle(d1)
        .select()
        .from(issues)
        .where(and(inArray(issues.id, refIssueIds), eq(issues.isPull, true)))
        .all();
      const prMergeRows = await drizzle(d1)
        .select({ issueId: pullRequests.issueId, hasMerged: pullRequests.hasMerged })
        .from(pullRequests)
        .where(inArray(pullRequests.issueId, prRows.map((row) => row.id)))
        .all();
      const prMergeById = new Map(prMergeRows.map((row) => [row.issueId, row.hasMerged]));
      const prById = new Map(prRows.map((row) => [row.id, row]));
      for (const row of refRows) {
        if (row.refIssueId === null) continue;
        const pr = prById.get(row.refIssueId);
        if (pr === undefined) continue;
        const list = linkedPrsByIssue.get(row.issueId) ?? [];
        list.push(pr);
        linkedPrsByIssue.set(row.issueId, list);
        if (prMergeById.has(pr.id)) mergedByIssue.set(pr.id, prMergeById.get(pr.id) ?? false);
      }
    }
  }

  // The card assembly + the in-memory facet filter (AND label semantics, the
  // landed issues-list convention the owner board cites).
  const cardsByIssue = new Map<number, BoardCard>();
  for (const issue of allIssues) {
    const labelIds = new Set((labelsByIssue.get(issue.id) ?? []).map((label) => label.id));
    if (labelFilter.some((id) => !labelIds.has(id))) continue;
    if (assigneeFilter !== null && !(assigneeIdsByIssue.get(issue.id) ?? []).includes(assigneeFilter)) continue;
    if (milestoneFilter !== null && issue.milestoneId !== milestoneFilter) continue;
    const merged = mergedByIssue.get(issue.id) ?? false;
    cardsByIssue.set(issue.id, {
      issue,
      prMerged: merged,
      repo: repoPair,
      labels: labelsByIssue.get(issue.id) ?? [],
      assignees: assigneeNamesByIssue.get(issue.id) ?? [],
      milestone: issue.milestoneId === null ? null : (milestoneById.get(issue.milestoneId) ?? null),
      linkedPrs: (linkedPrsByIssue.get(issue.id) ?? []).map((pr) => {
        // The linked PR usually lives in THIS repo; a cross-repo ref resolves
        // its own pair, the invisible/missing row keeping the owner board's
        // "#" fallback.
        const sameRepo = pr.repoId === repo.id;
        return {
          title: pr.title,
          index: pr.index,
          merged: mergedByIssue.get(pr.id) ?? false,
          isClosed: pr.isClosed,
          href: sameRepo
            ? `/${repo.ownerNamespace}/${repo.slug}/pulls/${pr.index}`
            : "#",
        };
      }),
      tasks: issueTaskCounts(issue.content),
      lastEventUnix: unixSeconds(issue.isClosed ? (issue.closedAt ?? issue.createdAt) : (issue.createdAt ?? issue.updatedAt)),
      lastEventKind: issue.isClosed ? (issue.isPull && merged ? "merged" : "closed") : "opened",
      posterName: issue.posterId === null ? null : (posterById.get(issue.posterId) ?? issue.originalAuthor ?? null),
    });
  }

  const columns = columnPages.map(({ column, items }) => {
    const cards = items
      .map((issue) => cardsByIssue.get(issue.id))
      .filter((card): card is BoardCard => card !== undefined);
    return { column, numIssues: cards.length, cards };
  });

  return {
    repo,
    repoPair,
    project,
    columns,
    canWrite,
    filters: { labels: labelFilter, assignee: assigneeFilter, milestone: milestoneFilter },
  };
}

/** The workflows page's render inputs (RenderWorkflows' reads at the repo
 *  arm). `canWrite` is the caller's writer-and-not-archived grant;
 *  `canManage` is CanManageWorkflows' REPO arm — write access to BOTH the
 *  issues and pulls units — collapsed to the same repo-wide writer
 *  (routes/projects-repo.ts's requireWorkflowManager reduction). */
export interface RepoProjectWorkflowsData {
  repo: RepoRow;
  project: ProjectRow;
  projectLink: string;
  workflows: ProjectWorkflowRow[];
  columns: ProjectColumnRow[];
  /** The label pool (GetProjectLabels' repository arm — the repo's labels
   *  PLUS the owner org's owner-level labels; `repo.ownerId` is the pool's
   *  org half whatever the owner kind — a user owns no org labels). */
  labelRows: Array<{ id: number; name: string }>;
  canWrite: boolean;
  canManage: boolean;
  /** The focused workflow (the /workflows/{wid} PATH tail — RenderWorkflows'
   *  param read; an unknown id 404-shells at the handler). */
  workflowId: number | null;
  /** The create form's preselected event (?event= — validated upstream). */
  event: string | null;
}

/**
 * Load the workflows page (repo.ProjectWorkflows → shared RenderWorkflows):
 * the project's workflows (`project_id ASC, id ASC`), the columns, the label
 * pool (repo labels + the owner org's owner-level labels — the same pool
 * `createWorkflow`'s repo-scope validation reads through repoOwnerId), and
 * the writer grant narrowed by the archived flag (upstream passes
 * `CanWrite && !IsArchived` in).
 */
export async function loadRepoProjectWorkflowsData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  project: ProjectRow,
  viewer: Viewer,
  params: URLSearchParams,
): Promise<RepoProjectWorkflowsData> {
  const [workflowsPage, columnsPage, canWriteRaw] = await Promise.all([
    listWorkflows(d1, project.id, 1, BOARD_QUERY_LIMIT),
    listColumns(d1, project.id, 1, BOARD_QUERY_LIMIT),
    canWriteRepo(env, repo, viewer),
  ]);
  const canWrite = canWriteRaw && !repo.isArchived;
  const labelRows = await drizzle(d1)
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(
      or(
        eq(labels.repoId, repo.id),
        // A null ownerId is degenerate data — the 0 half matches no org label.
        and(eq(labels.orgId, repo.ownerId ?? 0), isNull(labels.repoId)),
      ),
    )
    .orderBy(labels.id)
    .all();
  const eventParam = params.get("event") ?? "";
  return {
    repo,
    project,
    projectLink: `/${repo.ownerNamespace}/${repo.slug}/projects/${project.id}`,
    workflows: workflowsPage.items,
    columns: columnsPage.items,
    labelRows,
    canWrite,
    // The repo arm's collapse (the module header's gate note).
    canManage: canWrite,
    workflowId: null,
    event: eventParam === "" ? null : WORKFLOW_EVENTS.some((entry) => entry.event === eventParam) ? eventParam : null,
  };
}

// ---------------------------------------------------------------------------
// Writes (§3.2 — the landed repo-scope arms, the precedent's shapes)
// ---------------------------------------------------------------------------

/** The create write (NewProjectPost, projects.go:133-160): validate, then
 *  `createProject` with the REPO scope + the doer as creator. The 303 onto
 *  the list is the handler's arm (upstream Redirects to RepoLink+/projects). */
export async function createRepoProjectFromForm(
  d1: D1Database,
  repo: RepoRow,
  doerId: number,
  form: ProjectForm,
  now: Date,
): Promise<{ outcome: "created"; project: ProjectRow } | { outcome: "invalid"; message: string }> {
  const validated = validateProjectForm(form);
  if (validated.outcome === "invalid") return validated;
  const project = await createProject(d1, repoProjectScope(repo.id), {
    title: form.title,
    description: form.content,
    template_type: validated.templateType,
    card_type: validated.cardType,
    creatorId: doerId,
    now,
  });
  return { outcome: "created", project };
}

/**
 * The workflow create write (CreateWorkflow → project_service.CreateWorkflow):
 * the event must be one of the eight (the service's exact 422 otherwise),
 * then the landed service call with the REPO scope and `repo.ownerId` as the
 * label-pool owner — the repo-scope API route's exact composition
 * (routes/projects-repo.ts:1003).
 */
export async function createRepoWorkflowFromForm(
  d1: D1Database,
  repo: RepoRow,
  project: ProjectRow,
  form: WorkflowForm,
  now: Date,
): Promise<{ outcome: "created" } | { outcome: "invalid"; message: string }> {
  if (!WORKFLOW_EVENTS.some((entry) => entry.event === form.event)) {
    return { outcome: "invalid", message: `invalid event: ${form.event}` };
  }
  try {
    await createWorkflow(d1, repoProjectScope(repo.id), repo.ownerId, project, {
      event: form.event,
      enabled: form.enabledPresent ? form.enabled : undefined,
      filters: form.hasRuleFields ? form.filters : undefined,
      actions: form.hasRuleFields ? form.actions : undefined,
      now,
    });
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
  return { outcome: "created" };
}

/** The workflow update write (UpdateWorkflow): the toggle POST (enabled
 *  only) keeps the stored rules; the full-form POST replaces them. */
export async function updateRepoWorkflowFromForm(
  d1: D1Database,
  repo: RepoRow,
  project: ProjectRow,
  workflow: ProjectWorkflowRow,
  form: WorkflowForm,
  now: Date,
): Promise<{ outcome: "updated" } | { outcome: "invalid"; message: string }> {
  try {
    await updateWorkflow(d1, repoProjectScope(repo.id), repo.ownerId, project, workflow, {
      enabled: form.enabledPresent ? form.enabled : undefined,
      filters: form.hasRuleFields ? form.filters : undefined,
      actions: form.hasRuleFields ? form.actions : undefined,
      now,
    });
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
  return { outcome: "updated" };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The project link (ProjectLinkForRepo — `/{owner}/{repo}/projects/{id}`). */
export function repoProjectLink(repo: RepoRow, project: ProjectRow): string {
  return `/${repo.ownerNamespace}/${repo.slug}/projects/${project.id}`;
}

/** One issue card (repo/issue/card.tmpl's server half — the owner board's
 *  BoardCardItem's DOM at the single-repo link base). */
function RepoBoardCardItem(props: { repoLink: string; card: BoardCard }) {
  const { card } = props;
  const issue = card.issue;
  const glyphItem: IssueListItem = {
    issue,
    labels: card.labels,
    milestone: null,
    posterName: card.posterName,
    prMerged: card.prMerged,
  };
  return (
    <div class="issue-card tw-break-anywhere">
      <div class="content tw-w-full">
        <div class="tw-flex tw-items-start tw-gap-[5px]">
          <span class="issue-card-icon">
            <IssueStateIcon item={glyphItem} />
          </span>
          <a
            class="issue-card-title muted issue-title tw-break-anywhere"
            href={`${props.repoLink}/${issue.isPull ? "pulls" : "issues"}/${issue.index}`}
          >
            {issue.title}
          </a>
        </div>
        <div class="meta">
          <span class="tw-text-grey-light muted-links">
            {card.repo.repo.ownerNamespace}/{card.repo.repo.slug}#{issue.index}{" "}
            {card.lastEventKind === "opened" ? (
              <>
                opened <TimeSince unixSeconds={card.lastEventUnix} tz="+0000" />
                {card.posterName !== null ? <> by {card.posterName}</> : null}
              </>
            ) : (
              <>
                by {card.posterName} was {card.lastEventKind === "merged" ? "merged" : "closed"}{" "}
                <TimeSince unixSeconds={card.lastEventUnix} tz="+0000" />
              </>
            )}
          </span>
        </div>
        {card.milestone !== null ? (
          <div class="meta tw-my-1">
            <a class="milestone" href={`${props.repoLink}/milestone/${card.milestone.id}`}>
              <Icon name="octicon-milestone" size={16} class="tw-mr-1 tw-align-middle" />
              <span class="tw-align-middle">{card.milestone.name}</span>
            </a>
          </div>
        ) : null}
        {card.linkedPrs.map((pr) => (
          <div class="meta tw-my-1">
            <a href={pr.href}>
              <Icon
                name="octicon-git-merge"
                size={16}
                class={`tw-mr-1 tw-align-middle ${pr.merged ? "tw-text-purple" : pr.isClosed ? "tw-text-red" : "tw-text-green"}`}
              />
              <span class="tw-align-middle">
                {pr.title} <span class="tw-text-grey-light">#{pr.index}</span>
              </span>
            </a>
          </div>
        ))}
        {card.tasks.total > 0 ? (
          <div class="meta tw-my-1">
            <Icon name="octicon-checklist" size={16} class="tw-mr-1 tw-align-middle" />
            <span class="tw-align-middle">
              {card.tasks.done} / {card.tasks.total}
            </span>
          </div>
        ) : null}
      </div>
      {card.labels.length > 0 || card.assignees.length > 0 ? (
        <div class="issue-card-bottom">
          <div class="issue-card-bottom-part labels-list">
            {card.labels.map((label) => (
              <a class="item" href={`${props.repoLink}/issues?labels=${label.id}`}>
                <LabelBadge label={label} />
              </a>
            ))}
          </div>
          {card.assignees.length > 0 ? (
            <div class="issue-card-bottom-part tw-justify-end" title={ownerProjectBoardLocale.assigned_to}>
              {card.assignees.map((name) => (
                <span class="flex-text-inline">
                  <Icon name="octicon-person" size={16} /> {name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The New Column disclosure (the owner board's no-JS reduction — the
 *  modal's two fields POSTing upstream's /columns/new route). */
function RepoNewColumnForm(props: { action: string; form: ColumnForm; error: string | null }) {
  return (
    <details>
      <summary class="item flex-text-inline">
        <Icon name="octicon-plus" size={16} /> {ownerProjectBoardLocale.new_column}
      </summary>
      <form class="ui form" method="post" action={props.action}>
        {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
        <div class="required field">
          <label for="repo-new-project-column-title">{ownerProjectBoardLocale.column_name}</label>
          <input id="repo-new-project-column-title" name="title" value={props.form.title} required maxlength={100} />
        </div>
        <div class="field">
          <label for="repo-new-project-column-color">{ownerProjectBoardLocale.column_color}</label>
          <input
            id="repo-new-project-column-color"
            name="color"
            value={props.form.color}
            maxlength={7}
            placeholder="#c320f6"
          />
        </div>
        <div class="field">
          <button type="submit" class="ui primary button">
            {ownerProjectBoardLocale.create_column}
          </button>
        </div>
      </form>
    </details>
  );
}

/** The board half (projects/view.tmpl): the top links row (repo/projects/
 *  view.tmpl — Labels/Milestones live, New Issue onto the LANDED form, the
 *  chooser divergence the module header notes), then the project header with
 *  its writer controls and the columns with their cards. */
export function RepoProjectBoardBlock(props: {
  repoLink: string;
  data: RepoProjectBoardData;
  columnForm: ColumnForm;
  columnError: string | null;
}) {
  const { data } = props;
  const link = repoProjectLink(data.repo, data.project);
  const canEdit = data.canWrite && !data.repo.isArchived;
  const descriptionHtml =
    data.project.description !== ""
      ? renderMarkdownToHtml({ text: data.project.description, mode: "markdown", context: "", wiki: false, origin: "" })
      : "";
  return (
    <>
      <div class="ui container padded">
        <div class="flex-text-block tw-justify-end tw-mb-4">
          <a class="ui small button" href={`${props.repoLink}/labels`}>
            {repoProjectsLocale.labels}
          </a>
          <a class="ui small button" href={`${props.repoLink}/milestones`}>
            {repoProjectsLocale.milestones}
          </a>
          <a class="ui small primary button" href={`${props.repoLink}/issues/new`}>
            {repoProjectsLocale.new_issue}
          </a>
        </div>
      </div>
      <div class="ui container fluid padded projects-view">
        <div class="ui container flex-text-block project-header">
          <h2>{data.project.title}</h2>
          <div class="tw-flex-1" />
          <div class="ui compact mini menu">
            <a class="item" href={`${link}/workflows`}>
              {ownerProjectBoardLocale.workflows}
            </a>
            {canEdit ? (
              <>
                <a class="item" href={`${link}/edit?redirect=project`}>
                  {ownerProjectBoardLocale.edit}
                </a>
                <form
                  class="tw-inline-block"
                  method="post"
                  action={data.project.isClosed ? `${link}/open` : `${link}/close`}
                >
                  <button type="submit" class="item">
                    {data.project.isClosed ? ownerProjectBoardLocale.open : ownerProjectBoardLocale.close}
                  </button>
                </form>
                <form class="tw-inline-block" method="post" action={`${link}/delete`}>
                  <button type="submit" class="item">
                    {ownerProjectBoardLocale.delete}
                  </button>
                </form>
                <RepoNewColumnForm action={`${link}/columns/new`} form={props.columnForm} error={props.columnError} />
              </>
            ) : null}
          </div>
        </div>

        <div class="ui container project-description">
          {descriptionHtml !== "" ? (
            <div class="render-content markup" dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
          ) : null}
          <div class="divider" />
        </div>

        <div id="project-board" class="board">
          {data.columns.map((entry) => {
            const color = /^#[0-9a-fA-F]{6}$/.test(entry.column.color) ? entry.column.color : null;
            const columnStyle =
              color === null ? undefined : `background: ${color} !important; color: ${contrastColor(color)} !important`;
            return (
              <div class="project-column" style={columnStyle} data-id={entry.column.id}>
                <div class="project-column-header">
                  <div class="ui circular label project-column-issue-count">{entry.numIssues}</div>
                  <div
                    class="project-column-title-text flex-text-inline gt-ellipsis"
                    title={entry.column.isDefault ? ownerProjectBoardLocale.default_hint : undefined}
                  >
                    {entry.column.isDefault ? <Icon name="octicon-star" size={16} /> : null} {entry.column.title}
                  </div>
                  {canEdit && !entry.column.isDefault ? (
                    <form class="tw-inline-block" method="post" action={`${link}/${entry.column.id}/default`}>
                      <button type="submit" class="item" title={ownerProjectBoardLocale.set_default}>
                        {ownerProjectBoardLocale.set_default}
                      </button>
                    </form>
                  ) : null}
                </div>
                <div class="divider" />
                <div class="ui cards" id={`board_${entry.column.id}`}>
                  {entry.cards.map((card) => (
                    <RepoBoardCardItem repoLink={props.repoLink} card={card} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/** The board page (repo/projects/view.tmpl: `repository projects
 *  view-project` over the repo header). */
export function RepoProjectBoardPage(props: {
  ctx: UiContext;
  data: RepoProjectBoardData;
  columnForm: ColumnForm;
  columnError: string | null;
}) {
  const repoLink = `/${props.data.repo.ownerNamespace}/${props.data.repo.slug}`;
  return (
    <BaseLayout
      ctx={props.ctx}
      title={props.data.project.title}
      pageClass="repository projects view-project"
      activeTab="projects"
    >
      <RepoProjectBoardBlock
        repoLink={repoLink}
        data={props.data}
        columnForm={props.columnForm}
        columnError={props.columnError}
      />
    </BaseLayout>
  );
}

export function renderRepoProjectBoardPage(options: {
  ctx: UiContext;
  data: RepoProjectBoardData;
  columnForm: ColumnForm;
  columnError: string | null;
}): string {
  return renderPage(
    <RepoProjectBoardPage
      ctx={options.ctx}
      data={options.data}
      columnForm={options.columnForm}
      columnError={options.columnError}
    />,
  );
}

// ---------------------------------------------------------------------------
// The list page
// ---------------------------------------------------------------------------

/** The pager — base/paginate.tmpl reduced to the Older/Newer pair (the
 *  owner list's convention), carrying `?page=` plus the active state facet. */
function RepoProjectsPager(props: { basePath: string; data: RepoProjectsData }) {
  const { data } = props;
  const href = (page: number): string =>
    data.state === "open" ? `${props.basePath}?page=${page}` : `${props.basePath}?state=closed&page=${page}`;
  if (data.page <= 1 && !data.more) return null;
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {data.page > 1 ? (
          <a class="item navigation" href={data.page > 2 ? href(data.page - 1) : props.basePath}>
            <span class="navigation_label">Newer</span>
          </a>
        ) : null}
        {data.more ? (
          <a class="item navigation" href={href(data.page + 1)}>
            <span class="navigation_label">Older</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The list half (projects/list.tmpl at the repo scope — the toggle + New
 * Project button share the writer-only row; the rows carry the per-row
 * edit/open/close/delete controls THIS scope's routes make live, the
 * delete-confirm dialog reduced to plain submits; the `.list-header`
 * search/sort block is the documented reduction).
 */
export function RepoProjectsListBlock(props: { basePath: string; data: RepoProjectsData }) {
  const { data } = props;
  const canEdit = data.canWrite && !data.repo.isArchived;
  return (
    <>
      {canEdit ? (
        <div class="flex-left-right tw-mb-4">
          <ProjectStateToggle
            basePath={props.basePath}
            state={data.state}
            openTotal={data.openTotal}
            closedTotal={data.closedTotal}
          />
          <a class="ui small primary button" href={`${props.basePath}/new`}>
            {ownerProjectBoardLocale.new_project}
          </a>
        </div>
      ) : null}
      {data.items.length > 0 ? (
        <>
          <div class="flex-divided-list milestone-list">
            {data.items.map(({ project, counts }) => {
              const link = `${props.basePath}/${project.id}`;
              return (
                <div class="item flex-relaxed-list">
                  <ProjectListItem item={{ project, counts }} href={link} />
                  {canEdit ? (
                    <div class="flex-text-block tw-flex-wrap">
                      <a class="flex-text-inline" href={`${link}/edit`}>
                        <Icon name="octicon-pencil" size={14} />
                        {ownerProjectBoardLocale.edit}
                      </a>
                      <form class="tw-inline-block" method="post" action={project.isClosed ? `${link}/open` : `${link}/close`}>
                        <button type="submit" class="flex-text-inline link-action">
                          {/* Upstream's open/close pair is octicon-check /
                              octicon-skip; the landed set lacks skip — the
                              closed glyph carries the close arm. */}
                          <Icon name={project.isClosed ? "octicon-check" : "octicon-issue-closed"} size={14} />
                          {project.isClosed ? ownerProjectBoardLocale.open : ownerProjectBoardLocale.close}
                        </button>
                      </form>
                      <form class="tw-inline-block" method="post" action={`${link}/delete`}>
                        <button type="submit" class="flex-text-inline tw-text-red">
                          <Icon name="octicon-trash" size={14} />
                          {ownerProjectBoardLocale.delete}
                        </button>
                      </form>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <RepoProjectsPager basePath={props.basePath} data={data} />
        </>
      ) : data.openTotal === 0 && data.closedTotal === 0 ? (
        <div class="empty-placeholder">
          <Icon name="octicon-project-symlink" size={48} />
          <h2>{ownerProjectsLocale.empty}</h2>
          <p>{ownerProjectsLocale.empty_description}</p>
        </div>
      ) : (
        <div class="empty-placeholder">
          <Icon name="octicon-search" size={48} />
          <h2>{ownerProjectsLocale.no_results}</h2>
        </div>
      )}
    </>
  );
}

/** The list page (repo/projects/list.tmpl: `repository projects milestones`
 *  — upstream's literal page-content classes — over the repo header). */
export function RepoProjectsPage(props: { ctx: UiContext; data: RepoProjectsData }) {
  const repoLink = `/${props.data.repo.ownerNamespace}/${props.data.repo.slug}`;
  return (
    <BaseLayout
      ctx={props.ctx}
      title={ownerProjectsLocale.projects}
      pageClass="repository projects milestones"
      activeTab="projects"
    >
      <div class="ui container">
        <RepoProjectsListBlock basePath={`${repoLink}/projects`} data={props.data} />
      </div>
    </BaseLayout>
  );
}

export function renderRepoProjectsPage(ctx: UiContext, data: RepoProjectsData): string {
  return renderPage(<RepoProjectsPage ctx={ctx} data={data} />);
}

// ---------------------------------------------------------------------------
// New / edit pages (projects/new.tmpl — the SHARED form reused verbatim)
// ---------------------------------------------------------------------------

/** The new-project page (repo/projects/new.tmpl: `repository projects
 *  edit-project new`; CancelLink = RepoLink + "/projects"). */
export function RepoProjectNewPage(props: {
  ctx: UiContext;
  repo: RepoRow;
  form: ProjectForm;
  error: string | null;
}) {
  const repoLink = `/${props.repo.ownerNamespace}/${props.repo.slug}`;
  const basePath = `${repoLink}/projects`;
  return (
    <BaseLayout
      ctx={props.ctx}
      title={ownerProjectBoardLocale.new_project}
      pageClass="repository projects edit-project new"
      activeTab="projects"
    >
      <div class="ui container">
        <ProjectFormBlock action={`${basePath}/new`} cancelHref={basePath} isEdit={false} form={props.form} error={props.error} />
      </div>
    </BaseLayout>
  );
}

export function renderRepoProjectNewPage(props: { ctx: UiContext; repo: RepoRow; form: ProjectForm; error: string | null }): string {
  return renderPage(<RepoProjectNewPage ctx={props.ctx} repo={props.repo} form={props.form} error={props.error} />);
}

/** The edit-project page (the shared template's PageIsEditProjects arm; the
 *  cancel link lands on the board — ProjectLinkForRepo). */
export function RepoProjectEditPage(props: {
  ctx: UiContext;
  data: RepoProjectBoardData;
  form: ProjectForm;
  error: string | null;
  redirect: string;
}) {
  const boardPath = repoProjectLink(props.data.repo, props.data.project);
  return (
    <BaseLayout
      ctx={props.ctx}
      title={ownerProjectBoardLocale.edit_project}
      pageClass="repository projects edit-project new"
      activeTab="projects"
    >
      <div class="ui container">
        <ProjectFormBlock
          action={`${boardPath}/edit`}
          cancelHref={boardPath}
          isEdit
          form={props.form}
          error={props.error}
          redirect={props.redirect}
        />
      </div>
    </BaseLayout>
  );
}

export function renderRepoProjectEditPage(props: {
  ctx: UiContext;
  data: RepoProjectBoardData;
  form: ProjectForm;
  error: string | null;
  redirect: string;
}): string {
  return renderPage(
    <RepoProjectEditPage ctx={props.ctx} data={props.data} form={props.form} error={props.error} redirect={props.redirect} />,
  );
}

// ---------------------------------------------------------------------------
// The workflows page (shared/project/workflow.go's RenderWorkflows at the
// repo arm — the builder's no-JS reduction, the precedent's shapes)
// ---------------------------------------------------------------------------

/** One workflow's summary (the builder's summary.* shapes over the stored
 *  wire projections — the owner board's WorkflowSummary at the repo pool). */
function RepoWorkflowSummary(props: {
  data: RepoProjectWorkflowsData;
  filters: ReturnType<typeof toApiWorkflowFilters>;
  actions: ReturnType<typeof toApiWorkflowActions>;
}) {
  const { data } = props;
  const columnName = (id: number | undefined): string =>
    id === undefined
      ? ownerProjectBoardLocale.any_column
      : (data.columns.find((column) => column.id === id)?.title ?? `#${id}`);
  const labelNames = (ids: number[] | undefined): string =>
    ids === undefined || ids.length === 0
      ? ownerProjectBoardLocale.any_label
      : ids.map((id) => data.labelRows.find((label) => label.id === id)?.name ?? `#${id}`).join(", ");
  const applyTo =
    props.filters.issue_type === "issue"
      ? ownerProjectBoardLocale.issues_only
      : props.filters.issue_type === "pull_request"
        ? ownerProjectBoardLocale.pull_requests_only
        : ownerProjectBoardLocale.issues_and_pull_requests;
  const actionParts: string[] = [];
  if (props.actions.column_id !== undefined) {
    actionParts.push(`${ownerProjectBoardLocale.move_to_column} ${columnName(props.actions.column_id)}`);
  }
  if (props.actions.add_label_ids?.length) {
    actionParts.push(`${ownerProjectBoardLocale.add_labels} ${labelNames(props.actions.add_label_ids)}`);
  }
  if (props.actions.remove_label_ids?.length) {
    actionParts.push(`${ownerProjectBoardLocale.remove_labels} ${labelNames(props.actions.remove_label_ids)}`);
  }
  if (props.actions.issue_state === "close") actionParts.push(ownerProjectBoardLocale.close_issue);
  if (props.actions.issue_state === "reopen") actionParts.push(ownerProjectBoardLocale.reopen_issue);
  return (
    <ul class="tw-list-none tw-m-0 tw-p-0">
      <li>
        {ownerProjectBoardLocale.apply_to}: {applyTo}
      </li>
      {props.filters.source_column_id !== undefined || props.filters.target_column_id !== undefined ? (
        <li>
          {props.filters.source_column_id !== undefined
            ? `${ownerProjectBoardLocale.when_moved_from_column} ${columnName(props.filters.source_column_id)}; `
            : null}
          {props.filters.target_column_id !== undefined
            ? `${ownerProjectBoardLocale.when_moved_to_column} ${columnName(props.filters.target_column_id)}`
            : null}
        </li>
      ) : null}
      {props.filters.label_ids !== undefined ? (
        <li>
          {ownerProjectBoardLocale.only_if_has_labels} — {ownerProjectBoardLocale.filters}: {labelNames(props.filters.label_ids)}
        </li>
      ) : null}
      <li>
        {ownerProjectBoardLocale.actions}: {actionParts.length === 0 ? ownerProjectBoardLocale.none : actionParts.join("; ")}
      </li>
    </ul>
  );
}

/** The workflow rule form (the builder's no-JS reduction — the owner
 *  board's WorkflowRuleForm at the repo pool; `workflow` present = the edit
 *  arm, absent = the create arm). */
function RepoWorkflowRuleForm(props: {
  data: RepoProjectWorkflowsData;
  workflow?: ProjectWorkflowRow;
  form: WorkflowForm;
  error: string | null;
}) {
  const { data } = props;
  const storedFilters = props.workflow !== undefined ? toApiWorkflowFilters(props.workflow.filters) : undefined;
  const storedActions = props.workflow !== undefined ? toApiWorkflowActions(props.workflow.actions) : undefined;
  const action =
    props.workflow === undefined
      ? `${data.projectLink}/workflows`
      : `${data.projectLink}/workflows/${props.workflow.id}`;
  const filters =
    props.workflow === undefined
      ? props.form.filters
      : {
          issue_type: storedFilters?.issue_type ?? "",
          source_column_id: storedFilters?.source_column_id ?? 0,
          target_column_id: storedFilters?.target_column_id ?? 0,
          label_ids: storedFilters?.label_ids ?? [],
        };
  const actions =
    props.workflow === undefined
      ? props.form.actions
      : {
          column_id: storedActions?.column_id ?? 0,
          add_label_ids: storedActions?.add_label_ids ?? [],
          remove_label_ids: storedActions?.remove_label_ids ?? [],
          issue_state: storedActions?.issue_state ?? "",
        };
  const event = props.workflow === undefined ? (props.form.event || data.event || "") : props.workflow.event;
  return (
    <form class="ui form" method="post" action={action}>
      {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
      <div class={props.workflow === undefined ? "required field" : "field"}>
        <label for="repo-workflow-event">{ownerProjectBoardLocale.event}</label>
        <select id="repo-workflow-event" name="event" disabled={props.workflow !== undefined}>
          {WORKFLOW_EVENTS.map((entry) => (
            <option value={entry.event} selected={entry.event === event}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for="repo-workflow-enabled">{ownerProjectBoardLocale.enabled}</label>
        <select id="repo-workflow-enabled" name="enabled">
          <option value="true" selected={props.workflow?.enabled !== false}>
            {ownerProjectBoardLocale.enabled}
          </option>
          <option value="false" selected={props.workflow?.enabled === false}>
            {ownerProjectBoardLocale.disabled}
          </option>
        </select>
      </div>
      <fieldset>
        <legend>{ownerProjectBoardLocale.filters}</legend>
        <div class="field">
          <label for="repo-workflow-issue-type">{ownerProjectBoardLocale.apply_to}</label>
          <select id="repo-workflow-issue-type" name="filter_issue_type">
            <option value="" selected={filters.issue_type === ""}>
              {ownerProjectBoardLocale.issues_and_pull_requests}
            </option>
            <option value="issue" selected={filters.issue_type === "issue"}>
              {ownerProjectBoardLocale.issues_only}
            </option>
            <option value="pull_request" selected={filters.issue_type === "pull_request"}>
              {ownerProjectBoardLocale.pull_requests_only}
            </option>
          </select>
        </div>
        <div class="field">
          <label for="repo-workflow-source-column">{ownerProjectBoardLocale.when_moved_from_column}</label>
          <select id="repo-workflow-source-column" name="filter_source_column_id">
            <option value="" selected={filters.source_column_id === 0}>
              {ownerProjectBoardLocale.any_column}
            </option>
            {data.columns.map((column) => (
              <option value={column.id} selected={column.id === filters.source_column_id}>
                {column.title}
              </option>
            ))}
          </select>
        </div>
        <div class="field">
          <label for="repo-workflow-target-column">{ownerProjectBoardLocale.when_moved_to_column}</label>
          <select id="repo-workflow-target-column" name="filter_target_column_id">
            <option value="" selected={filters.target_column_id === 0}>
              {ownerProjectBoardLocale.any_column}
            </option>
            {data.columns.map((column) => (
              <option value={column.id} selected={column.id === filters.target_column_id}>
                {column.title}
              </option>
            ))}
          </select>
        </div>
        {data.labelRows.length > 0 ? (
          <div class="field">
            <span class="label">{ownerProjectBoardLocale.only_if_has_labels}</span>
            {data.labelRows.map((label) => (
              <label class="flex-text-inline">
                <input
                  type="checkbox"
                  name="filter_label_ids"
                  value={label.id}
                  checked={filters.label_ids.includes(label.id)}
                />{" "}
                {label.name}
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>
      <fieldset>
        <legend>{ownerProjectBoardLocale.actions}</legend>
        <div class="field">
          <label for="repo-workflow-action-column">{ownerProjectBoardLocale.move_to_column}</label>
          <select id="repo-workflow-action-column" name="action_column_id">
            <option value="" selected={actions.column_id === 0}>
              {ownerProjectBoardLocale.none}
            </option>
            {data.columns.map((column) => (
              <option value={column.id} selected={column.id === actions.column_id}>
                {column.title}
              </option>
            ))}
          </select>
        </div>
        {data.labelRows.length > 0 ? (
          <>
            <div class="field">
              <span class="label">{ownerProjectBoardLocale.add_labels}</span>
              {data.labelRows.map((label) => (
                <label class="flex-text-inline">
                  <input
                    type="checkbox"
                    name="action_add_label_ids"
                    value={label.id}
                    checked={actions.add_label_ids.includes(label.id)}
                  />{" "}
                  {label.name}
                </label>
              ))}
            </div>
            <div class="field">
              <span class="label">{ownerProjectBoardLocale.remove_labels}</span>
              {data.labelRows.map((label) => (
                <label class="flex-text-inline">
                  <input
                    type="checkbox"
                    name="action_remove_label_ids"
                    value={label.id}
                    checked={actions.remove_label_ids.includes(label.id)}
                  />{" "}
                  {label.name}
                </label>
              ))}
            </div>
          </>
        ) : null}
        <div class="field">
          <label for="repo-workflow-issue-state">{ownerProjectBoardLocale.issue_state}</label>
          <select id="repo-workflow-issue-state" name="action_issue_state">
            <option value="" selected={actions.issue_state === ""}>
              {ownerProjectBoardLocale.no_change}
            </option>
            <option value="close" selected={actions.issue_state === "close"}>
              {ownerProjectBoardLocale.close_issue}
            </option>
            <option value="reopen" selected={actions.issue_state === "reopen"}>
              {ownerProjectBoardLocale.reopen_issue}
            </option>
          </select>
        </div>
      </fieldset>
      <div class="flex-text-block tw-justify-end">
        <a class="ui cancel button" href={`${data.projectLink}/workflows`}>
          {ownerProjectBoardLocale.cancel}
        </a>
        <button type="submit" class="ui primary button">
          {ownerProjectBoardLocale.save}
        </button>
      </div>
    </form>
  );
}

/** The workflows page (repo/projects/workflows.tmpl: `repository projects`
 *  over the repo header + the shared workflows body). */
export function RepoProjectWorkflowsPage(props: {
  ctx: UiContext;
  data: RepoProjectWorkflowsData;
  form: WorkflowForm;
  error: string | null;
}) {
  const { data } = props;
  const focused = data.workflowId === null ? undefined : data.workflows.find((workflow) => workflow.id === data.workflowId);
  return (
    <BaseLayout
      ctx={props.ctx}
      title={repoProjectsLocale.workflows_title}
      pageClass="repository projects"
      activeTab="projects"
    >
      <div class="ui container">
        <a class="flex-text-inline" href={data.projectLink}>
          {data.project.title}
        </a>
        <p class="tw-mt-2 tw-text-text-light-2">{ownerProjectBoardLocale.runs_as_hint}</p>
        {data.workflows.length === 0 ? (
          <p>{ownerProjectBoardLocale.none}</p>
        ) : (
          <div class="flex-divided-list">
            {data.workflows.map((workflow) => {
              const eventLabel = WORKFLOW_EVENTS.find((entry) => entry.event === workflow.event)?.label ?? workflow.event;
              return (
                <div class="item">
                  <div class="flex-text-block">
                    <strong>{eventLabel}</strong>
                    <span class={workflow.enabled ? "tw-text-green" : "tw-text-red"}>
                      {workflow.enabled ? ownerProjectBoardLocale.enabled : ownerProjectBoardLocale.disabled}
                    </span>
                    <div class="tw-flex-1" />
                    {data.canManage ? (
                      <>
                        <form
                          class="tw-inline-block"
                          method="post"
                          action={`${data.projectLink}/workflows/${workflow.id}`}
                        >
                          <input type="hidden" name="enabled" value={workflow.enabled ? "false" : "true"} />
                          <button type="submit" class="ui tiny button">
                            {workflow.enabled ? ownerProjectBoardLocale.disable : ownerProjectBoardLocale.enable}
                          </button>
                        </form>
                        <a class="ui tiny button" href={`${data.projectLink}/workflows?workflow_id=${workflow.id}`}>
                          {ownerProjectBoardLocale.edit}
                        </a>
                        <form
                          class="tw-inline-block"
                          method="post"
                          action={`${data.projectLink}/workflows/${workflow.id}/delete`}
                        >
                          <button type="submit" class="ui tiny negative button">
                            {ownerProjectBoardLocale.delete}
                          </button>
                        </form>
                      </>
                    ) : null}
                  </div>
                  <RepoWorkflowSummary
                    data={data}
                    filters={toApiWorkflowFilters(workflow.filters)}
                    actions={toApiWorkflowActions(workflow.actions)}
                  />
                </div>
              );
            })}
          </div>
        )}
        {data.canManage && focused === undefined ? (
          <details open={data.workflows.length === 0}>
            <summary>{ownerProjectBoardLocale.new_workflow}</summary>
            <RepoWorkflowRuleForm data={data} form={props.form} error={props.error} />
          </details>
        ) : null}
        {data.canManage && focused !== undefined ? (
          <>
            <h3>{ownerProjectBoardLocale.edit_workflow}</h3>
            <RepoWorkflowRuleForm data={data} workflow={focused} form={props.form} error={props.error} />
          </>
        ) : null}
      </div>
    </BaseLayout>
  );
}

export function renderRepoProjectWorkflowsPage(props: {
  ctx: UiContext;
  data: RepoProjectWorkflowsData;
  form: WorkflowForm;
  error: string | null;
}): string {
  return renderPage(
    <RepoProjectWorkflowsPage ctx={props.ctx} data={props.data} form={props.form} error={props.error} />,
  );
}
