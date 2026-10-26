/**
 * The owner projects BOARD surface, `/{username}/-/projects/{id}` + its write
 * group + the workflow tails — pages wave 40 (the UI-parity survey's ABSENT
 * follow-up row, docs/compat/ui-parity-survey.md: web.go:1140-1155 plus the
 * board/workflow helpers web.go:327-345) over the landed 64-op projects
 * family (src/api/services/projects.ts, all three scopes REG'd).
 *
 * ## Upstream shape (cited)
 *
 * `GET /{username}/-/projects/{id}` routes to `org.ViewProject`
 * (routers/web/org/projects.go:304-481, tplProjectsView = "org/projects/view"
 * → the shared projects/view.tmpl board), the workflows tails to
 * `org.ProjectWorkflows` (projects.go:484-491 → shared/project/workflow.go's
 * RenderWorkflows, tplProjectWorkflows = "org/projects/workflows"), and the
 * write group to web.go:1146-1155's reqSignIn group: `/new` (GET+POST
 * RenderNewProject/NewProjectPost), `/{id}/edit` (GET+POST), `/{id}/delete`
 * (POST), `/{id}/{action:open|close}` (POST ChangeProjectStatus) plus the two
 * helper groups — addProjectBoardRoutes (web.go:331-345: POST `/move`
 * MoveColumns, POST `/columns/new` AddColumnToProjectPost, PUT/DELETE
 * `/{columnID}`, POST `/{columnID}/default`, POST `/{columnID}/move`
 * MoveIssues) and addProjectWorkflowRoutes (web.go:327-331: POST `/workflows`
 * CreateWorkflow, POST `/workflows/{workflow_id}` UpdateWorkflow, POST
 * `/workflows/{workflow_id}/delete` DeleteWorkflow). The template arms match
 * the LIST page's (org → org/header, individual → the profile grid), then
 * projects/view.tmpl's board.
 *
 * ## The slice (honest scoping — the no-JS port)
 *
 * Upstream's board is a JS surface (data-global-init="initRepoProjectsView":
 * sortablejs drag-drop for columns and cards, a modal column editor, a color
 * picker, JS link-actions). The READ half is fully server-rendered upstream
 * and lands here in full:
 *
 * - the project header (title h2, the rendered markdown description —
 *   projects/view.tmpl's `.project-description`), the writer controls
 *   (workflows link, edit link, open/close + delete submits, the New Column
 *   disclosure) and the BOARD: one `.project-column` per column in
 *   `sorting, id` order with its color background + contrast text, the
 *   circular issue count, the default column's star (with the
 *   default_column_hint tooltip text), and the column's issue cards in
 *   `project-column-sorting` order;
 * - each card renders repo/issue/card.tmpl's server half: the state glyph
 *   (the landed IssueStateIcon — merged/closed/WIP/open), the title link onto
 *   the issue (pulls/{index} for PRs, issues/{index} otherwise —
 *   Issue.Link()), the `{repo}#{index}` meta + the event label with its
 *   TimeSince timestamp (opened_by/closed_by/merged_by — GetLastEventLabel),
 *   the milestone link, the linked-PR rows (the comments refIssueId+refIsPull
 *   refs, ViewProject's linkedPrsMap), the task counter (issueTasksPat —
 *   models/issues/issue.go:114-115, 441-449) and the label/assignee bottom;
 * - the board's facet filters (`?labels=`, `?assignee=`, `?milestone=` —
 *   ViewProject's FormString/FormInt64 reads) are HONORED, filtered in memory
 *   over the loaded cards (upstream filters in SQL; the same rows, the
 *   reduction documented below). Column counts reflect the filter
 *   (ViewProject sets NumIssues from the FILTERED load, projects.go:354-356).
 *
 * The WRITE half ports at the form-POST conventions (the landed
 * settings/org-labels pattern) exactly where upstream's own routes are
 * form-compatible POSTs — everything else reduces, never dead controls:
 *
 * - LANDED, upstream's exact routes: POST `/new`, POST `/{id}/edit`,
 *   POST `/{id}/delete`, POST `/{id}/open|close` (upstream's JSONRedirect
 *   answers become 303 redirects), POST `/{id}/columns/new`
 *   (AddColumnToProjectPost — upstream's web.Bind reads the modal form's
 *   `title`/`color` fields, repo_form.go:380-386), POST
 *   `/{id}/{columnID}/default` (SetDefaultProjectColumn), POST `/workflows`
 *   + POST `/workflows/{wid}` + POST `/workflows/{wid}/delete` (the workflow
 *   writes; upstream posts JSON, ours urlencoded fields — the field names
 *   carry the api CreateProjectWorkflowOption/EditProjectWorkflowOption
 *   shapes, the mapping documented at parseWorkflowForm);
 * - REDUCED (upstream's controls are pure JS against non-POST methods):
 *   the column EDIT/DELETE kebab arms (upstream PUT/DELETE `/{columnID}` —
 *   HTML forms cannot emit those verbs, and upstream's own controls are
 *   fetches; no controls render, no routes claimed), the column/card
 *   drag-drop moves (POST `/move` + `/{columnID}/move` with JSON bodies —
 *   sortablejs wires, no no-JS control upstream either), the fullscreen
 *   toggle, the filter dropdown chrome (Fomantic menus are JS-opened;
 *   upstream's no-JS page hides them too — the facets stay URL-reachable),
 *   the delete-confirm dialogs (plain submits, the org-labels precedent),
 *   the color picker (a plain text input), the card image attachments
 *   (card_type 1's issuesAttachmentMap — no landed attachments read for
 *   images) and the JS workflow BUILDER (its per-event field visibility
 *   reduces to one static form; unsupported selections re-render with the
 *   service's exact 422 text).
 *
 * ## Gates (the group's exact ladders, reduced to the landed predicates)
 *
 * - READ (`/{id}`, `/{id}/workflows[/{workflow_id}]`): the LIST page's
 *   resolution verbatim (resolveOwnerProjects — the org unit-access gate or
 *   the individualPermsChecker ladder), then GetProjectByIDAndOwner's owner
 *   scoping (findProjectById — another owner's id reads as not found).
 * - WRITE (the group): reqSignIn (anonymous → the login 303,
 *   loginRedirect), canWriteProjects (projects.go:121-124 — org →
 *   orgProjectsAccessMode >= write, user → doer == owner; note the write
 *   group's inline web.go:1151-1155 check makes even a SITE ADMIN a NotFound
 *   on another user's project writes — kept verbatim), plus the workflow
 *   writes' CanManageWorkflows layer (services/projects/workflow.go:27-48:
 *   org → site admin or org OWNER, user → owner equality — the landed
 *   canManageOrgProjectWorkflows/canManageUserProjectWorkflows; a projects
 *   writer who is not the org owner sees the workflows but no edit arms).
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - Column edit/delete: unrendered + unclaimed (the PUT/DELETE note above).
 * - The workflow builder reduces to static forms; `?event=` preselects a
 *   create event (RenderWorkflows' validated FormString read — an unknown
 *   event 404-shells, workflow.go:48-52) and `?workflow_id=` focuses the
 *   edit form (an unknown id 404-shells, workflow.go:39-47).
 * - The linked-PR read is the comments-ref walk upstream does (batched
 *   queries here, LoadComments there).
 * - The user arm's chrome carries the SAME reductions as the LIST page's
 *   (the two live overview tabs, no avatar images).
 * - Markdown renders through the SHARED service in its context-less mode
 *   (SPEC-0008 §3.4's sanitizer divergence, the LIST page's note).
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../../api/errors";
import {
  cardTypeFromString,
  canManageOrgProjectWorkflows,
  canManageUserProjectWorkflows,
  createColumn,
  createProject,
  createWorkflow,
  deleteWorkflow,
  findColumnByIdAndProject,
  findProjectById,
  findWorkflowByIdAndProject,
  listColumnIssuesForOrg,
  listColumns,
  listProjects,
  listWorkflows,
  orgAccessAtLeast,
  orgProjectScope,
  orgProjectsAccessMode,
  setDefaultColumn,
  templateTypeFromString,
  toApiWorkflowActions,
  toApiWorkflowFilters,
  updateProject,
  updateWorkflow,
  userProjectScope,
  userVisibleRepos,
  type ProjectColumnRow,
  type ProjectRow,
  type ProjectScope,
  type ProjectWorkflowRow,
} from "../../api/services/projects";
import { issueLabelRows } from "../../api/services/issues";
import type { IssueRow } from "../../issues/service";
import { listFollowers, listFollowing } from "../../api/services/follows";
import { renderMarkdownToHtml } from "../../api/services/markdown";
import type { RepositoryWithOwner, Viewer as ApiViewer } from "../../api/services/repository";
import type { LabelRow } from "../../db/schema";
import { comments, issueAssignees, issues, labels, milestones, pullRequests, repositories, users } from "../../db/schema";
import { BaseLayout, Icon, renderPage } from "../shell";
import { TimeSince } from "../components/file-list";
import { IssueStateIcon, LabelBadge, contrastColor, type IssueListItem } from "./issues-list";
import { OrgHeader, OrgMenu } from "./org-home";
import { ProfileAvatarCard, type ProfileDoer } from "./user-profile";
import type { OwnerProjectsResolution } from "./owner-projects";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import type { Child } from "hono/jsx";

/** Page chrome text (component-local, the ownerProjectsLocale pattern —
 *  upstream locale keys cited). */
export const ownerProjectBoardLocale = {
  workflows: "Workflows", // "projects.workflows"
  edit: "Edit", // "repo.issues.label_edit"
  delete: "Delete", // "repo.issues.label_delete"
  open: "Open", // "repo.projects.open"
  close: "Close", // "repo.projects.close"
  new_column: "New Column", // "new_project_column"
  column_name: "Name", // "repo.projects.column.new_title"
  column_color: "Color", // "repo.projects.column.color"
  create_column: "Create Column", // "repo.projects.column.new_submit"
  set_default: "Set Default", // "repo.projects.column.set_default"
  default_hint: "New issues added to this project will be added to this column", // "repo.projects.column.default_column_hint"
  save: "Save", // "save"
  cancel: "Cancel", // "settings.cancel" / "repo.milestones.cancel"
  new_project: "New Project", // "repo.projects.new"
  edit_project: "Edit Project", // "repo.projects.edit"
  new_subheader:
    "Coordinate, track, and update your work in one place, so projects stay transparent and on schedule.", // "repo.projects.new_subheader"
  edit_subheader: "Projects organize issues and track progress.", // "repo.projects.edit_subheader"
  title: "Title", // "repo.projects.title"
  description: "Description (optional)", // "repo.projects.description"
  description_placeholder: "Description", // "repo.projects.description_placeholder"
  template: "Template", // "repo.projects.template.desc"
  template_helper: "Select a project template to get started", // "repo.projects.template.desc_helper"
  template_none: "None", // "repo.projects.type.none"
  template_basic_kanban: "Basic Kanban", // "repo.projects.type.basic_kanban"
  template_bug_triage: "Bug Triage", // "repo.projects.type.bug_triage"
  card_previews: "Card Previews", // "repo.projects.card_type.desc"
  card_text_only: "Text Only", // "repo.projects.card_type.text_only"
  card_images_and_text: "Images and Text", // "repo.projects.card_type.images_and_text"
  create_project: "Create Project", // "repo.projects.create"
  modify_project: "Edit Project", // "repo.projects.modify"
  title_required: "A title is required.", // the settings/milestone binding-error convention
  title_too_long: "Title is too long.", // the MaxSize(100) binding error
  template_invalid: "Invalid template type.", // the binding error arm
  card_invalid: "Invalid card type.", // the binding error arm
  event: "Event", // the builder's event picker
  enabled: "Enabled", // "enabled"
  disabled: "Disabled", // "disabled"
  apply_to: "Apply to", // "projects.workflows.apply_to"
  issues_and_pull_requests: "Issues and pull requests", // "projects.workflows.issues_and_pull_requests"
  issues_only: "Issues only", // "projects.workflows.issues_only"
  pull_requests_only: "Pull requests only", // "projects.workflows.pull_requests_only"
  when_moved_from_column: "When moved from column", // "projects.workflows.when_moved_from_column"
  when_moved_to_column: "When moved to column", // "projects.workflows.when_moved_to_column"
  any_column: "Any column", // "projects.workflows.any_column"
  only_if_has_labels: "Only if it has labels", // "projects.workflows.only_if_has_labels"
  any_label: "Any label", // "projects.workflows.any_label"
  filters: "Filters", // "projects.workflows.filters"
  actions: "Actions", // "projects.workflows.actions"
  move_to_column: "Move to column", // "projects.workflows.move_to_column"
  add_labels: "Add labels", // "projects.workflows.add_labels"
  remove_labels: "Remove labels", // "projects.workflows.remove_labels"
  none: "None", // "projects.workflows.none"
  issue_state: "Issue state", // "projects.workflows.issue_state"
  no_change: "No change", // "projects.workflows.no_change"
  close_issue: "Close issue", // "projects.workflows.close_issue"
  reopen_issue: "Reopen issue", // "projects.workflows.reopen_issue"
  runs_as_hint:
    "Workflows act on their items without further permission checks, so only users who can manage them may edit them. Deleting a column or transferring a repository does not trigger workflows.", // "projects.workflows.runs_as_hint"
  new_workflow: "New workflow", // the builder's create affordance
  edit_workflow: "Edit workflow", // the builder's edit affordance
  enable: "Enable", // "projects.workflows.enable"
  disable: "Disable", // "projects.workflows.disable"
  assigned_to: "Assigned to", // "repo.projects.column.assigned_to"
} as const;

/** The eight WorkflowEvents in upstream's registration order with their
 *  display names (models/project/workflows.go:73-84's slice + the
 *  projects.workflows.event.* locale keys RenderWorkflows resolves). */
export const WORKFLOW_EVENTS: ReadonlyArray<{ event: string; label: string }> = [
  { event: "item_added_to_project", label: "Item added to project" },
  { event: "item_removed_from_project", label: "Item removed from project" },
  { event: "item_reopened", label: "Item reopened" },
  { event: "item_closed", label: "Item closed" },
  { event: "item_column_changed", label: "Item column changed" },
  { event: "code_changes_requested", label: "Code changes requested" },
  { event: "code_review_approved", label: "Code review approved" },
  { event: "pull_request_merged", label: "Pull request merged" },
];

/** The template/card select options (GetTemplateConfigs, template.go:29-37 +
 *  GetCardConfig, project.go:188-191). */
const TEMPLATE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "none", label: ownerProjectBoardLocale.template_none },
  { value: "basic_kanban", label: ownerProjectBoardLocale.template_basic_kanban },
  { value: "bug_triage", label: ownerProjectBoardLocale.template_bug_triage },
];
const CARD_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "text_only", label: ownerProjectBoardLocale.card_text_only },
  { value: "images_and_text", label: ownerProjectBoardLocale.card_images_and_text },
];

/** The board's unbounded per-column load (upstream LoadIssuesFromProject has
 *  no pagination — Issues() with no ListOptions; the landed service's page
 *  shape just carries a ceiling here). */
const BOARD_QUERY_LIMIT = 10_000;

// ---------------------------------------------------------------------------
// Gates + shared resolution helpers
// ---------------------------------------------------------------------------

/** The owner-scope `ProjectScope` of the resolved owner (the org/user union). */
function ownerScope(owner: ResolvedOwner): ProjectScope {
  return owner.kind === "org" ? orgProjectScope(owner.org.id) : userProjectScope(owner.user.id);
}

/** The resolved owner union this page's loaders take (the LIST page's
 *  resolution's landed arms). */
export type ResolvedOwner = Extract<OwnerProjectsResolution, { kind: "org" | "user" }>;

/** `canWriteProjects` (org/projects.go:121-124) — org →
 *  orgProjectsAccessMode >= write; user → doer == owner. This is ALSO the
 *  write group's route gate (web.go:1146-1155: the write unit access for
 *  orgs, the inline ContextUser.ID != Doer.ID NotFound for individuals —
 *  so a site admin is a NotFound on another user's project writes, kept
 *  verbatim). */
export async function ownerProjectWriteAccess(d1: D1Database, owner: ResolvedOwner, doer: ProfileDoer): Promise<boolean> {
  if (owner.kind === "org") {
    const access = await orgProjectsAccessMode(d1, owner.org, doer.id);
    return orgAccessAtLeast(access, "write");
  }
  return doer.id !== null && doer.id === owner.user.id;
}

/** The owner's users.id (the scope's ownerId half). */
function ownerIdOf(owner: ResolvedOwner): number {
  return owner.kind === "org" ? owner.org.id : owner.user.id;
}

/** `GetProjectByIDAndOwner`'s owner scoping (models/project/project.go:
 *  314-324) — the resolved owner's scope + id. `null` → the 404 shell. */
export async function findOwnerProject(d1: D1Database, owner: ResolvedOwner, id: number): Promise<ProjectRow | null> {
  return findProjectById(d1, ownerScope(owner), id);
}

/** The session viewer's ProfileDoer projection (loadOwnerProjectsData's). */
export function boardDoer(viewer: Viewer): ProfileDoer {
  return viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
}

/** The api `Viewer` projection of the session viewer (the LIST page's
 *  projectsApiUser shape). */
function boardApiUser(viewer: Viewer, origin: string): ApiViewer {
  return {
    origin,
    requester: viewer.kind === "user" ? { id: viewer.id, login: viewer.username, is_admin: viewer.isAdmin } : null,
  };
}

/** `ProjectLinkForOrg` — `/{username}/-/projects/{id}`. */
export function projectLinkOf(owner: ResolvedOwner, project: ProjectRow): string {
  const ownerName = owner.kind === "org" ? owner.org.username : owner.user.username;
  return `/${ownerName}/-/projects/${project.id}`;
}

// ---------------------------------------------------------------------------
// Chrome counts (the LIST page's recipes, verbatim)
// ---------------------------------------------------------------------------

/** The shared chrome counts (repoCount/openTotal for the menu tab,
 *  followers/following for the user arm's avatar card). */
export interface BoardChromeCounts {
  repoCount: number;
  openTotal: number;
  followers: number;
  following: number;
}

/** loadHeaderCount's RepoCount arm + the owner's OPEN-projects total (the
 *  menu tab's count) + the avatar-card pair — the LIST page's exact reads,
 *  extracted so the board/workflow/form pages share them. */
export async function loadProjectChromeCounts(
  d1: D1Database,
  owner: ResolvedOwner,
  viewer: Viewer,
): Promise<BoardChromeCounts> {
  const doer = boardDoer(viewer);
  const ownerId = ownerIdOf(owner);
  const seePrivateRepos = doer.id !== null && (doer.isAdmin || doer.id === ownerId);
  const repoWhere = seePrivateRepos
    ? eq(repositories.ownerId, ownerId)
    : and(eq(repositories.ownerId, ownerId), eq(repositories.visibility, "public"));
  const scope = ownerScope(owner);
  const [repoCountRow, openPage] = await Promise.all([
    drizzle(d1)
      .select({ total: sql<number>`count(*)` })
      .from(repositories)
      .where(repoWhere)
      .get(),
    // listProjects isClosed=false, page 1, limit 1 — the total is the count.
    listProjects(d1, scope, false, 1, 1),
  ]);
  let followers = 0;
  let following = 0;
  if (owner.kind === "user") {
    const followViewer = { id: doer.id, isAdmin: doer.isAdmin };
    const [followerPage, followingPage] = await Promise.all([
      listFollowers(d1, owner.user.id, followViewer, { page: 1, pageSize: 1 }),
      listFollowing(d1, owner.user.id, followViewer, { page: 1, pageSize: 1 }),
    ]);
    followers = followerPage.total;
    following = followingPage.total;
  }
  return {
    repoCount: Number(repoCountRow?.total ?? 0),
    openTotal: openPage.total,
    followers,
    following,
  };
}

// ---------------------------------------------------------------------------
// Board view — data
// ---------------------------------------------------------------------------

/** One card's render inputs (the joined badges repo/issue/card.tmpl reads). */
export interface BoardCard {
  issue: IssueRow;
  /** The card's PR-merged glyph flag (pull_requests.has_merged). */
  prMerged: boolean;
  /** The owning repository pair (the `{repo}#{index}` meta + every link). */
  repo: RepositoryWithOwner;
  /** The card's labels (repo/issue/card.tmpl's labels-list). */
  labels: LabelRow[];
  /** The assignee display names (upstream renders avatar links; the landed
   *  no-avatar convention renders the names, §3.3). */
  assignees: string[];
  milestone: { id: number; name: string } | null;
  /** Linked PRs (the comments cross-reference walk, ViewProject's
   *  linkedPrsMap — projects.go:370-389). */
  linkedPrs: Array<{ title: string; index: number; merged: boolean; isClosed: boolean; href: string }>;
  /** The task counter (GetTasks/GetTasksDone over the content). */
  tasks: { total: number; done: number };
  /** The meta line's timestamp (GetLastEventTimestamp: closed → closed_unix,
   *  else created_unix — models/issues/issue.go:451-455). */
  lastEventUnix: number;
  /** opened/closed/merged — GetLastEventLabel's three-way split. */
  lastEventKind: "opened" | "closed" | "merged";
  posterName: string | null;
}

/** One column's render inputs. */
export interface BoardColumnData {
  column: ProjectColumnRow;
  /** The FILTERED issue count (ViewProject's NumIssues — projects.go:354). */
  numIssues: number;
  cards: BoardCard[];
}

/** The board page's render inputs. */
export interface ProjectBoardData {
  owner: ResolvedOwner;
  project: ProjectRow;
  columns: BoardColumnData[];
  canWrite: boolean;
  chrome: BoardChromeCounts;
  /** The active facet echo (the honored filters — the module header). */
  filters: { labels: number[]; assignee: number | null; milestone: number | null };
}

/** Upstream issueTasksPat/issueTasksDonePat (models/issues/issue.go:114-115)
 *  — `- [ ]`/`- [x]` list-item checkboxes. */
const ISSUE_TASKS_PATTERN = /(^[\s]*[-*][\s]\[[\sxX]\][\s].)|(\n[\s]*[-*][\s]\[[\sxX]\][\s].)/g;
const ISSUE_TASKS_DONE_PATTERN = /(^[\s]*[-*][\s]\[[xX]\][\s].)|(\n[\s]*[-*][\s]\[[xX]\][\s].)/g;

/** GetTasks/GetTasksDone (issue.go:441-449) — null content counts zero. */
function issueTaskCounts(content: string | null): { total: number; done: number } {
  if (content === null) return { total: 0, done: 0 };
  return {
    total: content.match(ISSUE_TASKS_PATTERN)?.length ?? 0,
    done: content.match(ISSUE_TASKS_DONE_PATTERN)?.length ?? 0,
  };
}

/** `?labels=` — the landed issues-list convention (parseLabelIds: comma
 *  separated positive ints, junk dropped). */
export function parseBoardLabelIds(raw: string | null): number[] {
  if (raw === null) return [];
  return raw
    .split(",")
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}

/** A positive-int form/query id, or null (the formLabelId convention). */
export function positiveIntOrNull(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return value > 0 ? value : null;
}

function unixSeconds(date: Date | null): number {
  return Math.floor((date?.getTime() ?? 0) / 1000);
}

/**
 * Load the board (§3.2 — the landed service arms, never a self-fetch): the
 * caller-resolved owner-scoped project, the columns, ONE visibility walk of
 * the owner's repositories (userVisibleRepos — the same set the LIST page's
 * counts ride), then per-column `listColumnIssuesForOrg` reads with the
 * in-memory facet filter and the batched card joins.
 */
export async function loadProjectBoardData(
  d1: D1Database,
  owner: ResolvedOwner,
  project: ProjectRow,
  viewer: Viewer,
  origin: string,
  params: URLSearchParams,
): Promise<ProjectBoardData> {
  // The facets (ViewProject's FormString("assignee")/FormInt64("milestone")
  // reads + the landed labels convention).
  const labelFilter = parseBoardLabelIds(params.get("labels"));
  const assigneeFilter = positiveIntOrNull(params.get("assignee"));
  const milestoneFilter = positiveIntOrNull(params.get("milestone"));

  const [visible, columnsPage, chrome] = await Promise.all([
    userVisibleRepos(d1, ownerIdOf(owner), boardApiUser(viewer, origin)),
    listColumns(d1, project.id, 1, BOARD_QUERY_LIMIT),
    loadProjectChromeCounts(d1, owner, viewer),
  ]);
  const reposById = new Map(visible.map((pair) => [pair.repo.id, pair]));
  const visibleRepoIds = visible.map((pair) => pair.repo.id);

  // Per-column issues through the owner arm (the visibility-filtered read).
  const columnPages: Array<{ column: ProjectColumnRow; items: IssueRow[] }> = [];
  for (const column of columnsPage.items) {
    const page = await listColumnIssuesForOrg(d1, project.id, column, visibleRepoIds, 1, BOARD_QUERY_LIMIT);
    columnPages.push({ column, items: page.items });
  }
  const allIssues = columnPages.flatMap((entry) => entry.items);
  const issueIds = [...new Set(allIssues.map((issue) => issue.id))];

  // Batched joins over the whole board (the issues-list page's batching
  // pattern): labels, assignees, milestones, posters, PR-merged flags and
  // the linked-PR walk.
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

    // The linked-PR walk (ViewProject's linkedPrsMap): comments of the
    // board's issues whose ref is a pull request, then those PR rows.
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

  // The card assembly + the in-memory facet filter (the module header's
  // reduction note — upstream filters in SQL over the same rows).
  const cardsByIssue = new Map<number, BoardCard>();
  for (const issue of allIssues) {
    const repo = reposById.get(issue.repoId);
    if (repo === undefined) continue; // not in the doer-visible set — unreachable
    const labelIds = new Set((labelsByIssue.get(issue.id) ?? []).map((label) => label.id));
    if (labelFilter.some((id) => !labelIds.has(id))) continue; // AND semantics (the API label_ids rule)
    if (assigneeFilter !== null && !(assigneeIdsByIssue.get(issue.id) ?? []).includes(assigneeFilter)) continue;
    if (milestoneFilter !== null && issue.milestoneId !== milestoneFilter) continue;
    const merged = mergedByIssue.get(issue.id) ?? false;
    cardsByIssue.set(issue.id, {
      issue,
      prMerged: merged,
      repo,
      labels: labelsByIssue.get(issue.id) ?? [],
      assignees: assigneeNamesByIssue.get(issue.id) ?? [],
      milestone: issue.milestoneId === null ? null : (milestoneById.get(issue.milestoneId) ?? null),
      linkedPrs: (linkedPrsByIssue.get(issue.id) ?? []).map((pr) => {
        const prRepo = reposById.get(pr.repoId);
        return {
          title: pr.title,
          index: pr.index,
          merged: mergedByIssue.get(pr.id) ?? false,
          isClosed: pr.isClosed,
          href:
            prRepo === undefined
              ? "#"
              : `/${prRepo.repo.ownerNamespace}/${prRepo.repo.slug}/${pr.isPull ? "pulls" : "issues"}/${pr.index}`,
        };
      }),
      tasks: issueTaskCounts(issue.content),
      lastEventUnix: unixSeconds(issue.isClosed ? (issue.closedAt ?? issue.createdAt) : (issue.createdAt ?? issue.updatedAt)),
      lastEventKind: issue.isClosed ? (issue.isPull && merged ? "merged" : "closed") : "opened",
      posterName: issue.posterId === null ? null : (posterById.get(issue.posterId) ?? issue.originalAuthor ?? null),
    });
  }

  const columns: BoardColumnData[] = columnPages.map(({ column, items }) => {
    const cards = items
      .map((issue) => cardsByIssue.get(issue.id))
      .filter((card): card is BoardCard => card !== undefined);
    return { column, numIssues: cards.length, cards };
  });

  return {
    owner,
    project,
    columns,
    canWrite: await ownerProjectWriteAccess(d1, owner, boardDoer(viewer)),
    chrome,
    filters: { labels: labelFilter, assignee: assigneeFilter, milestone: milestoneFilter },
  };
}

// ---------------------------------------------------------------------------
// Board view — components
// ---------------------------------------------------------------------------

/** The shared chrome (both arms of org/projects/view.tmpl + new/workflows'
 *  templates): the org half renders org/header, the individual half the
 *  profile grid — the LIST page's arms with the page's block inside. */
function BoardChrome(props: {
  ctx: UiContext;
  owner: ResolvedOwner;
  title: string;
  pageClass: string;
  counts: BoardChromeCounts;
  children?: Child;
}) {
  const { ctx } = props;
  const ownerName = props.owner.kind === "org" ? props.owner.org.username : props.owner.user.username;
  const listPath = `/${ownerName}/-/projects`;
  if (props.owner.kind === "org") {
    return (
      <BaseLayout ctx={ctx} title={props.title} pageClass={props.pageClass}>
        <OrgHeader org={props.owner.org} signedIn={ctx.viewer.kind === "user"} />
        <OrgMenu
          orgLink={`/${ownerName}`}
          repoCount={props.counts.repoCount}
          projectsTab={{ active: true, count: props.counts.openTotal, href: listPath }}
        />
        {props.children}
      </BaseLayout>
    );
  }
  return (
    <BaseLayout ctx={ctx} title={props.title} pageClass={props.pageClass}>
      <div class="ui container">
        <div class="ui stackable grid">
          <div class="ui four wide column">
            <ProfileAvatarCard
              user={props.owner.user}
              followers={props.counts.followers}
              following={props.counts.following}
            />
          </div>
          <div class="ui twelve wide column tw-mb-4">
            <OrgMenu
              orgLink={`/${ownerName}`}
              repoCount={props.counts.repoCount}
              projectsTab={{ active: true, count: props.counts.openTotal, href: listPath }}
            />
            {props.children}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** One issue card (repo/issue/card.tmpl's server half — the module header
 *  lists the reductions: no image attachments, plain-name assignees). */
function BoardCardItem(props: { card: BoardCard }) {
  const { card } = props;
  const issue = card.issue;
  const repoLink = `/${card.repo.repo.ownerNamespace}/${card.repo.repo.slug}`;
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
            href={`${repoLink}/${issue.isPull ? "pulls" : "issues"}/${issue.index}`}
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
            <a class="milestone" href={`${repoLink}/milestone/${card.milestone.id}`}>
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
              <a class="item" href={`${repoLink}/issues?labels=${label.id}`}>
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

/** The New Column disclosure (the modal's no-JS reduction — the module
 *  header): title + a plain color input, POSTing upstream's /columns/new
 *  route. */
function NewColumnForm(props: { action: string; form: { title: string; color: string }; error: string | null }) {
  return (
    <details>
      <summary class="item flex-text-inline">
        <Icon name="octicon-plus" size={16} /> {ownerProjectBoardLocale.new_column}
      </summary>
      <form class="ui form" method="post" action={props.action}>
        {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
        <div class="required field">
          <label for="new-project-column-title">{ownerProjectBoardLocale.column_name}</label>
          <input id="new-project-column-title" name="title" value={props.form.title} required maxlength={100} />
        </div>
        <div class="field">
          <label for="new-project-column-color">{ownerProjectBoardLocale.column_color}</label>
          <input id="new-project-column-color" name="color" value={props.form.color} maxlength={7} placeholder="#c320f6" />
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

/** The board half (projects/view.tmpl): the header row (title + the writer
 *  controls), the description, and the columns with their cards. */
export function ProjectBoardBlock(props: {
  data: ProjectBoardData;
  columnForm: { title: string; color: string };
  columnError: string | null;
}) {
  const { data } = props;
  const link = projectLinkOf(data.owner, data.project);
  const descriptionHtml =
    data.project.description !== ""
      ? renderMarkdownToHtml({ text: data.project.description, mode: "markdown", context: "", wiki: false, origin: "" })
      : "";
  return (
    <div class="ui container fluid padded projects-view">
      <div class="ui container flex-text-block project-header">
        <h2>{data.project.title}</h2>
        <div class="tw-flex-1" />
        <div class="ui compact mini menu">
          <a class="item" href={`${link}/workflows`}>
            {ownerProjectBoardLocale.workflows}
          </a>
          {data.canWrite ? (
            <>
              <a class="item" href={`${link}/edit?redirect=project`}>
                {ownerProjectBoardLocale.edit}
              </a>
              <form class="tw-inline-block" method="post" action={data.project.isClosed ? `${link}/open` : `${link}/close`}>
                <button type="submit" class="item">
                  {data.project.isClosed ? ownerProjectBoardLocale.open : ownerProjectBoardLocale.close}
                </button>
              </form>
              <form class="tw-inline-block" method="post" action={`${link}/delete`}>
                <button type="submit" class="item">
                  {ownerProjectBoardLocale.delete}
                </button>
              </form>
              <NewColumnForm action={`${link}/columns/new`} form={props.columnForm} error={props.columnError} />
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
                {data.canWrite && !entry.column.isDefault ? (
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
                  <BoardCardItem card={card} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The board page (org/projects/view.tmpl's two chrome arms). */
export function ProjectBoardPage(props: {
  ctx: UiContext;
  data: ProjectBoardData;
  columnForm: { title: string; color: string };
  columnError: string | null;
}) {
  return (
    <BoardChrome
      ctx={props.ctx}
      owner={props.data.owner}
      title={props.data.project.title}
      pageClass="organization repository projects view-project"
      counts={props.data.chrome}
    >
      <ProjectBoardBlock data={props.data} columnForm={props.columnForm} columnError={props.columnError} />
    </BoardChrome>
  );
}

/** The full-document render (the render.tsx pattern — index.ts stays a
 *  pure-TS router module). */
export function renderProjectBoardPage(options: {
  ctx: UiContext;
  data: ProjectBoardData;
  columnForm: { title: string; color: string };
  columnError: string | null;
}): string {
  return renderPage(
    <ProjectBoardPage
      ctx={options.ctx}
      data={options.data}
      columnForm={options.columnForm}
      columnError={options.columnError}
    />,
  );
}

// ---------------------------------------------------------------------------
// New / edit project forms (projects/new.tmpl — the shared template)
// ---------------------------------------------------------------------------

/** The create/edit form's fields (CreateProjectForm, repo_form.go:371-379 —
 *  title Required MaxSize(100), content, template_type on create only,
 *  card_type). */
export interface ProjectForm {
  title: string;
  content: string;
  templateType: string;
  cardType: string;
}

/** Parse the urlencoded project POST (the form names: title, content,
 *  template_type, card_type — projects/new.tmpl's inputs). */
export function parseProjectForm(params: URLSearchParams): ProjectForm {
  return {
    title: (params.get("title") ?? "").trim(),
    content: params.get("content") ?? "",
    templateType: params.get("template_type") ?? "",
    cardType: params.get("card_type") ?? "",
  };
}

/** The binding validation (Required;MaxSize(100) + the enum parse — junk
 *  enums re-render with the binding error, the upstream HasError arm).
 *  Returns the wire enum strings on success. */
export function validateProjectForm(
  form: ProjectForm,
): { outcome: "invalid"; message: string } | { outcome: "ok"; cardType: string; templateType: string } {
  if (form.title === "") return { outcome: "invalid", message: ownerProjectBoardLocale.title_required };
  if (form.title.length > 100) return { outcome: "invalid", message: ownerProjectBoardLocale.title_too_long };
  try {
    templateTypeFromString(form.templateType === "" ? "none" : form.templateType);
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: ownerProjectBoardLocale.template_invalid };
    throw error;
  }
  try {
    cardTypeFromString(form.cardType === "" ? "text_only" : form.cardType);
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: ownerProjectBoardLocale.card_invalid };
    throw error;
  }
  return {
    outcome: "ok",
    cardType: form.cardType === "" ? "text_only" : form.cardType,
    templateType: form.templateType === "" ? "none" : form.templateType,
  };
}

/** The create write (NewProjectPost): validate, createProject with the
 *  owner's scope + the doer as creator. The 303 onto the LIST page is the
 *  handler's arm (upstream Redirects to HomeLink()+"/-/projects"). */
export async function createProjectFromForm(
  d1: D1Database,
  owner: ResolvedOwner,
  doerId: number,
  form: ProjectForm,
  now: Date,
): Promise<{ outcome: "created"; project: ProjectRow } | { outcome: "invalid"; message: string }> {
  const validated = validateProjectForm(form);
  if (validated.outcome === "invalid") return validated;
  const project = await createProject(d1, ownerScope(owner), {
    title: form.title,
    description: form.content,
    template_type: validated.templateType,
    card_type: validated.cardType,
    creatorId: doerId,
    now,
  });
  return { outcome: "created", project };
}

/** The edit write (EditProjectPost): validate, updateProject (title /
 *  description / card_type — the template field is the create-only arm).
 *  The redirect target (board vs list) is the handler's arm. */
export async function updateProjectFromForm(
  d1: D1Database,
  project: ProjectRow,
  form: ProjectForm,
  now: Date,
): Promise<{ outcome: "updated" } | { outcome: "invalid"; message: string }> {
  const validated = validateProjectForm(form);
  if (validated.outcome === "invalid") return validated;
  await updateProject(d1, project, {
    title: form.title,
    description: form.content,
    cardType: cardTypeFromString(validated.cardType),
    now,
  });
  return { outcome: "updated" };
}

/** The project form (projects/new.tmpl — one template for both arms; the
 *  edit arm hides the template select and swaps the submit label). */
export function ProjectFormBlock(props: {
  action: string;
  cancelHref: string;
  isEdit: boolean;
  form: ProjectForm;
  error: string | null;
  redirect?: string;
}) {
  return (
    <>
      <h2 class="ui dividing header">
        {props.isEdit ? ownerProjectBoardLocale.edit_project : ownerProjectBoardLocale.new_project}
        <div class="sub header">
          {props.isEdit ? ownerProjectBoardLocale.edit_subheader : ownerProjectBoardLocale.new_subheader}
        </div>
      </h2>
      {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
      <form class="ui form" action={props.action} method="post">
        <div>
          <input type="hidden" id="redirect" name="redirect" value={props.redirect ?? ""} />
          <div class="required field">
            <label for="project-title">{ownerProjectBoardLocale.title}</label>
            <input
              id="project-title"
              name="title"
              placeholder={ownerProjectBoardLocale.title}
              value={props.form.title}
              autofocus
              required
              maxlength={100}
            />
          </div>
          <div class="field">
            <label for="project-description">{ownerProjectBoardLocale.description}</label>
            <textarea
              id="project-description"
              name="content"
              rows={6}
              placeholder={ownerProjectBoardLocale.description_placeholder}
            >
              {props.form.content}
            </textarea>
          </div>
          {!props.isEdit ? (
            <div class="field">
              <label for="project-template">{ownerProjectBoardLocale.template}</label>
              <select id="project-template" name="template_type">
                {TEMPLATE_OPTIONS.map((option) => (
                  <option
                    value={option.value}
                    selected={option.value === (props.form.templateType === "" ? "none" : props.form.templateType)}
                  >
                    {option.label}
                  </option>
                ))}
              </select>
              <p class="help">{ownerProjectBoardLocale.template_helper}</p>
            </div>
          ) : null}
          <div class="field">
            <label for="project-card-type">{ownerProjectBoardLocale.card_previews}</label>
            <select id="project-card-type" name="card_type">
              {CARD_OPTIONS.map((option) => (
                <option
                  value={option.value}
                  selected={option.value === (props.form.cardType === "" ? "images_and_text" : props.form.cardType)}
                >
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div class="divider" />
        <div class="flex-text-block tw-justify-end">
          <a class="ui cancel button" href={props.cancelHref}>
            {ownerProjectBoardLocale.cancel}
          </a>
          <button type="submit" class="ui primary button">
            {props.isEdit ? ownerProjectBoardLocale.modify_project : ownerProjectBoardLocale.create_project}
          </button>
        </div>
      </form>
    </>
  );
}

/** The new-project page (org/projects/new.tmpl's arms over the shared form). */
export function NewProjectPage(props: {
  ctx: UiContext;
  owner: ResolvedOwner;
  form: ProjectForm;
  error: string | null;
  counts: BoardChromeCounts;
}) {
  const ownerName = props.owner.kind === "org" ? props.owner.org.username : props.owner.user.username;
  const listPath = `/${ownerName}/-/projects`;
  return (
    <BoardChrome
      ctx={props.ctx}
      owner={props.owner}
      title={ownerProjectBoardLocale.new_project}
      pageClass="organization projects"
      counts={props.counts}
    >
      <div class="ui container">
        <ProjectFormBlock action={`${listPath}/new`} cancelHref={listPath} isEdit={false} form={props.form} error={props.error} />
      </div>
    </BoardChrome>
  );
}

export function renderNewProjectPage(props: {
  ctx: UiContext;
  owner: ResolvedOwner;
  form: ProjectForm;
  error: string | null;
  counts: BoardChromeCounts;
}): string {
  return renderPage(<NewProjectPage ctx={props.ctx} owner={props.owner} form={props.form} error={props.error} counts={props.counts} />);
}

/** The edit-project page (the same template's PageIsEditProjects arm; the
 *  cancel link lands on the board — ProjectLinkForOrg). */
export function EditProjectPage(props: {
  ctx: UiContext;
  data: ProjectBoardData;
  form: ProjectForm;
  error: string | null;
  redirect: string;
}) {
  const boardPath = projectLinkOf(props.data.owner, props.data.project);
  return (
    <BoardChrome
      ctx={props.ctx}
      owner={props.data.owner}
      title={ownerProjectBoardLocale.edit_project}
      pageClass="organization projects"
      counts={props.data.chrome}
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
    </BoardChrome>
  );
}

export function renderEditProjectPage(props: {
  ctx: UiContext;
  data: ProjectBoardData;
  form: ProjectForm;
  error: string | null;
  redirect: string;
}): string {
  return renderPage(<EditProjectPage ctx={props.ctx} data={props.data} form={props.form} error={props.error} redirect={props.redirect} />);
}

// ---------------------------------------------------------------------------
// Column writes (the form-compatible POST routes only — the module header)
// ---------------------------------------------------------------------------

/** The column-create form fields (EditProjectColumnForm's title/color —
 *  repo_form.go:380-386; upstream's modal form carries an extra `id` field
 *  the create route ignores). */
export interface ColumnForm {
  title: string;
  color: string;
}

export function parseColumnForm(params: URLSearchParams): ColumnForm {
  return { title: (params.get("title") ?? "").trim(), color: params.get("color") ?? "" };
}

/** AddColumnToProjectPost reduced: the empty-title binding error re-renders,
 *  then `createColumn` (the color 422 and the 127-cap 422 surface as the
 *  re-render message — the exact ApiError texts). */
export async function createColumnFromForm(
  d1: D1Database,
  project: ProjectRow,
  doerId: number,
  form: ColumnForm,
  now: Date,
): Promise<{ outcome: "created" } | { outcome: "invalid"; message: string }> {
  if (form.title === "") return { outcome: "invalid", message: ownerProjectBoardLocale.title_required };
  try {
    await createColumn(d1, project.id, { title: form.title, color: form.color, creatorId: doerId, now });
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
  return { outcome: "created" };
}

/** SetDefaultProjectColumn: the column must belong to this project
 *  (GetColumnByIDAndProjectID — a foreign id 404-shells), then
 *  `setDefaultColumn`. */
export async function setProjectDefaultColumnFromForm(
  d1: D1Database,
  project: ProjectRow,
  columnId: number,
  now: Date,
): Promise<{ outcome: "applied" } | { outcome: "missing" }> {
  const column = await findColumnByIdAndProject(d1, columnId, project.id);
  if (column === null) return { outcome: "missing" };
  await setDefaultColumn(d1, project.id, column.id, now);
  return { outcome: "applied" };
}

// ---------------------------------------------------------------------------
// Workflows (shared/project/workflow.go's RenderWorkflows + the three POST
// writes, at the form-POST conventions)
// ---------------------------------------------------------------------------

/** The workflows page's render inputs. */
export interface ProjectWorkflowsData {
  owner: ResolvedOwner;
  project: ProjectRow;
  projectLink: string;
  workflows: ProjectWorkflowRow[];
  columns: ProjectColumnRow[];
  /** The label pool (GetProjectLabels' owner-level arm: the owner's org
   *  labels — an individual owner has none, the service's own note). */
  labelRows: LabelRow[];
  /** canWriteProjects, then CanManageWorkflows' narrowing (workflow.go:
   *  27-48) — the edit arms' gate. */
  canWrite: boolean;
  canManage: boolean;
  /** The focused workflow (?workflow_id= — RenderWorkflows' param read; an
   *  unknown id 404-shells at the handler). */
  workflowId: number | null;
  /** The create form's preselected event (?event= — validated upstream). */
  event: string | null;
  chrome: BoardChromeCounts;
}

/**
 * Load the workflows page (RenderWorkflows' reads): the project's workflows
 * (`project_id ASC, id ASC` — ListOptionsAll), the columns, the label pool,
 * and the two-layer writer flag. The caller 404-shells a foreign
 * `?workflow_id=` and an unknown `?event=` BEFORE this load (upstream
 * NotFound's inside the render path — the handler's arm).
 */
export async function loadProjectWorkflowsData(
  d1: D1Database,
  owner: ResolvedOwner,
  project: ProjectRow,
  viewer: Viewer,
  origin: string,
  params: URLSearchParams,
): Promise<ProjectWorkflowsData> {
  const doer = boardDoer(viewer);
  const [workflowsPage, columnsPage, chrome] = await Promise.all([
    listWorkflows(d1, project.id, 1, BOARD_QUERY_LIMIT),
    listColumns(d1, project.id, 1, BOARD_QUERY_LIMIT),
    loadProjectChromeCounts(d1, owner, viewer),
  ]);
  const labelRows = await drizzle(d1)
    .select()
    .from(labels)
    .where(and(eq(labels.orgId, ownerIdOf(owner)), isNull(labels.repoId)))
    .all();
  const canWrite = await ownerProjectWriteAccess(d1, owner, doer);
  let canManage = false;
  if (canWrite && doer.id !== null) {
    canManage =
      owner.kind === "org"
        ? await canManageOrgProjectWorkflows(d1, owner.org, { id: doer.id, isAdmin: doer.isAdmin })
        : canManageUserProjectWorkflows(project, { id: doer.id });
  }
  const eventParam = params.get("event") ?? "";
  return {
    owner,
    project,
    projectLink: projectLinkOf(owner, project),
    workflows: workflowsPage.items,
    columns: columnsPage.items,
    labelRows,
    canWrite,
    canManage,
    workflowId: null,
    event: eventParam === "" ? null : WORKFLOW_EVENTS.some((entry) => entry.event === eventParam) ? eventParam : null,
    chrome,
  };
}

/** The workflow form's fields — the flat urlencoded mapping of the api
 *  CreateProjectWorkflowOption/EditProjectWorkflowOption shapes:
 *  `event`, `enabled` ("true"/"false" select), the filters under `filter_*`
 *  (issue_type, source_column_id, target_column_id, repeated
 *  filter_label_ids checkboxes) and the actions under `action_*`
 *  (action_column_id, repeated add/remove checkbox groups,
 *  action_issue_state). The builder's per-event field visibility reduces to
 *  one static form (the module header): unsupported selections hit the
 *  service's exact 422s and re-render. */
export interface WorkflowForm {
  event: string;
  enabled: boolean;
  enabledPresent: boolean;
  /** Any `filter_`/`action_` field present — the replace-vs-toggle contract:
   *  the update POST carries the full rule set (replace), the quick
   *  enable/disable toggle posts only `enabled` (keep the stored rules). */
  hasRuleFields: boolean;
  filters: { issue_type: string; source_column_id: number; target_column_id: number; label_ids: number[] };
  actions: { column_id: number; add_label_ids: number[]; remove_label_ids: number[]; issue_state: string };
}

/** Positive-int list from repeated or comma-separated entries. */
function formIdList(params: URLSearchParams, key: string): number[] {
  const values = params.getAll(key).flatMap((value) => value.split(","));
  return values
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}

export function parseWorkflowForm(params: URLSearchParams): WorkflowForm {
  const ruleKeys = [
    "filter_issue_type",
    "filter_source_column_id",
    "filter_target_column_id",
    "filter_label_ids",
    "action_column_id",
    "action_add_label_ids",
    "action_remove_label_ids",
    "action_issue_state",
  ];
  const enabledRaw = params.get("enabled");
  return {
    event: params.get("event") ?? "",
    enabled: enabledRaw !== "false",
    enabledPresent: enabledRaw !== null,
    hasRuleFields: ruleKeys.some((key) => params.has(key)),
    filters: {
      issue_type: params.get("filter_issue_type") ?? "",
      source_column_id: positiveIntOrNull(params.get("filter_source_column_id")) ?? 0,
      target_column_id: positiveIntOrNull(params.get("filter_target_column_id")) ?? 0,
      label_ids: formIdList(params, "filter_label_ids"),
    },
    actions: {
      column_id: positiveIntOrNull(params.get("action_column_id")) ?? 0,
      add_label_ids: formIdList(params, "action_add_label_ids"),
      remove_label_ids: formIdList(params, "action_remove_label_ids"),
      issue_state: params.get("action_issue_state") ?? "",
    },
  };
}

/** The create write (CreateWorkflow → project_service.CreateWorkflow): the
 *  event must be one of the eight (the service's exact 422 otherwise), the
 *  rules validate through the service's capability checks, `enabled`
 *  defaults true. */
export async function createWorkflowFromForm(
  d1: D1Database,
  owner: ResolvedOwner,
  project: ProjectRow,
  form: WorkflowForm,
  now: Date,
): Promise<{ outcome: "created" } | { outcome: "invalid"; message: string }> {
  if (!WORKFLOW_EVENTS.some((entry) => entry.event === form.event)) {
    return { outcome: "invalid", message: `invalid event: ${form.event}` };
  }
  try {
    await createWorkflow(d1, ownerScope(owner), null, project, {
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

/** The update write (UpdateWorkflow → project_service.UpdateWorkflow): the
 *  toggle POST (enabled only) keeps the stored rules; the full-form POST
 *  replaces them. */
export async function updateWorkflowFromForm(
  d1: D1Database,
  owner: ResolvedOwner,
  project: ProjectRow,
  workflow: ProjectWorkflowRow,
  form: WorkflowForm,
  now: Date,
): Promise<{ outcome: "updated" } | { outcome: "invalid"; message: string }> {
  try {
    await updateWorkflow(d1, ownerScope(owner), null, project, workflow, {
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

/** The delete write (DeleteWorkflow): the workflow must belong to this
 *  project (GetWorkflowByProjectAndID — a foreign id 404-shells at the
 *  handler), then `deleteWorkflow` (a vanished row still succeeds — the
 *  landed zero-row-delete semantics). */
export async function deleteWorkflowFromForm(
  d1: D1Database,
  project: ProjectRow,
  workflowId: number,
): Promise<{ outcome: "deleted" } | { outcome: "missing" }> {
  const workflow = await findWorkflowByIdAndProject(d1, workflowId, project.id);
  if (workflow === null) return { outcome: "missing" };
  await deleteWorkflow(d1, project.id, workflow.id);
  return { outcome: "deleted" };
}

/** One workflow's summary (the builder's summary.* shapes over the stored
 *  wire projections). */
function WorkflowSummary(props: {
  data: ProjectWorkflowsData;
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
          {ownerProjectBoardLocale.only_if_has_labels} — {ownerProjectBoardLocale.filters}:{" "}
          {labelNames(props.filters.label_ids)}
        </li>
      ) : null}
      <li>
        {ownerProjectBoardLocale.actions}: {actionParts.length === 0 ? ownerProjectBoardLocale.none : actionParts.join("; ")}
      </li>
    </ul>
  );
}

/** The workflow rule form (the builder's no-JS reduction — one static form;
 *  the module header). `workflow` present = the edit arm (pre-filled, POSTs
 *  to /workflows/{id}); absent = the create arm. */
function WorkflowRuleForm(props: {
  data: ProjectWorkflowsData;
  workflow?: ProjectWorkflowRow;
  form: WorkflowForm;
  error: string | null;
}) {
  const { data } = props;
  const storedFilters = props.workflow !== undefined ? toApiWorkflowFilters(props.workflow.filters) : undefined;
  const storedActions = props.workflow !== undefined ? toApiWorkflowActions(props.workflow.actions) : undefined;
  const action =
    props.workflow === undefined ? `${data.projectLink}/workflows` : `${data.projectLink}/workflows/${props.workflow.id}`;
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
        <label for="workflow-event">{ownerProjectBoardLocale.event}</label>
        <select id="workflow-event" name="event" disabled={props.workflow !== undefined}>
          {WORKFLOW_EVENTS.map((entry) => (
            <option value={entry.event} selected={entry.event === event}>
              {entry.label}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label for="workflow-enabled">{ownerProjectBoardLocale.enabled}</label>
        <select id="workflow-enabled" name="enabled">
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
          <label for="workflow-issue-type">{ownerProjectBoardLocale.apply_to}</label>
          <select id="workflow-issue-type" name="filter_issue_type">
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
          <label for="workflow-source-column">{ownerProjectBoardLocale.when_moved_from_column}</label>
          <select id="workflow-source-column" name="filter_source_column_id">
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
          <label for="workflow-target-column">{ownerProjectBoardLocale.when_moved_to_column}</label>
          <select id="workflow-target-column" name="filter_target_column_id">
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
                <LabelBadge label={label} />
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>
      <fieldset>
        <legend>{ownerProjectBoardLocale.actions}</legend>
        <div class="field">
          <label for="workflow-action-column">{ownerProjectBoardLocale.move_to_column}</label>
          <select id="workflow-action-column" name="action_column_id">
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
                  <LabelBadge label={label} />
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
                  <LabelBadge label={label} />
                </label>
              ))}
            </div>
          </>
        ) : null}
        <div class="field">
          <label for="workflow-issue-state">{ownerProjectBoardLocale.issue_state}</label>
          <select id="workflow-issue-state" name="action_issue_state">
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

/** The workflows page (org/projects/workflows.tmpl's chrome + the builder's
 *  no-JS reduction: the back link, the runs_as hint, the workflow list with
 *  its summaries and the manager arms, then the create/edit form). */
export function ProjectWorkflowsPage(props: {
  ctx: UiContext;
  data: ProjectWorkflowsData;
  form: WorkflowForm;
  error: string | null;
}) {
  const { data } = props;
  const focused = data.workflowId === null ? undefined : data.workflows.find((workflow) => workflow.id === data.workflowId);
  return (
    <BoardChrome
      ctx={props.ctx}
      owner={data.owner}
      title={ownerProjectBoardLocale.workflows}
      pageClass="organization projects"
      counts={data.chrome}
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
                        <form class="tw-inline-block" method="post" action={`${data.projectLink}/workflows/${workflow.id}`}>
                          <input type="hidden" name="enabled" value={workflow.enabled ? "false" : "true"} />
                          <button type="submit" class="ui tiny button">
                            {workflow.enabled ? ownerProjectBoardLocale.disable : ownerProjectBoardLocale.enable}
                          </button>
                        </form>
                        <a class="ui tiny button" href={`${data.projectLink}/workflows?workflow_id=${workflow.id}`}>
                          {ownerProjectBoardLocale.edit}
                        </a>
                        <form class="tw-inline-block" method="post" action={`${data.projectLink}/workflows/${workflow.id}/delete`}>
                          <button type="submit" class="ui tiny negative button">
                            {ownerProjectBoardLocale.delete}
                          </button>
                        </form>
                      </>
                    ) : null}
                  </div>
                  <WorkflowSummary
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
            <WorkflowRuleForm data={data} form={props.form} error={props.error} />
          </details>
        ) : null}
        {data.canManage && focused !== undefined ? (
          <>
            <h3>{ownerProjectBoardLocale.edit_workflow}</h3>
            <WorkflowRuleForm data={data} workflow={focused} form={props.form} error={props.error} />
          </>
        ) : null}
      </div>
    </BoardChrome>
  );
}

export function renderProjectWorkflowsPage(props: {
  ctx: UiContext;
  data: ProjectWorkflowsData;
  form: WorkflowForm;
  error: string | null;
}): string {
  return renderPage(<ProjectWorkflowsPage ctx={props.ctx} data={props.data} form={props.form} error={props.error} />);
}
