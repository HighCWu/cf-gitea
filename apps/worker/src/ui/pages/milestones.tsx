/**
 * The milestones page, `/{owner}/{repo}/milestones` — pages wave 6 (SPEC-0008
 * U3 extension) — and its admin create form `/{owner}/{repo}/milestones/new`
 * (pages wave 6 write surface):
 *
 *   GET  /{owner}/{repo}/milestones       the list (open by default,
 *                                         `?state=closed` the second tab)
 *   GET  /{owner}/{repo}/milestones/new   the create form (admin viewer)
 *   POST /{owner}/{repo}/milestones/new   the create write (admin viewer)
 *
 * ## DOM contract (templates/repo/issue/milestones.tmpl + milestone_new.tmpl +
 *  repo/issue/navbar.tmpl + repo/issue/openclose.tmpl at the pin)
 *
 * `.page-content.repository milestones` (the form: `repository new
 * milestone`), then milestones.tmpl's `.list-header` (the reduced
 * issue-navbar compact menu + the New Milestone button) over the
 * `div.flex-divided-list.milestone-list` rows: one `.item.flex-relaxed-list`
 * per milestone — `.flex-left-right` with the `.list-item-large-title`
 * milestone glyph + name and the `{Completeness}%` + `<progress>` pair, the
 * `.list-item-secondary-bar` with the open/closed issue counts
 * (octicon-issue-opened / octicon-check), the "Updated {TimeSince}" /
 * "Closed {TimeSince}" stamps and the due-date line (octicon-calendar, red
 * when overdue, "No due date" when unset). The form page is
 * milestone_new.tmpl reduced to the title/deadline/content fields.
 *
 * ## Data (§3.2 — the landed services, never a self-fetch)
 *
 * The list rides `listRepoMilestones` (src/api/services/milestones.ts — the
 * upstream `deadline ASC, name ASC` order + state filter); the tab counts
 * are two 1-row reads over both states (the issues list's tab-count
 * pattern — upstream GetMilestonesStatsByRepoCondAndKw's unfiltered totals).
 * Row facts come from the maintained milestone counters (`num_issues`,
 * `num_closed_issues`, `completeness` — recomputed in the same batch as
 * every issue attach/close, src/issues/service.ts): the progress bar and
 * percentage are REAL numbers, no degradation. The write goes through
 * `createRepoMilestone` (the landed milestone-create service; the deadline
 * through its `parseMilestoneDeadline` — end-of-day UTC, the exact parser
 * the API POST route runs).
 *
 * ## Auth + CSRF posture (the settings page's shape)
 *
 * The list renders for every viewer who can see the repo (the router
 * resolved the row first, §2.5). The form + write are ADMIN-viewer-only
 * (`canAdminRepo` — pages/settings.tsx's predicate): anonymous 303s onto the
 * login round-trip, a signed-in non-admin 404-shells (upstream gates the
 * write group on write access — our reduction to the admin predicate, the
 * task brief's settings.tsx posture). The POST runs the §2.8 layer-2
 * Origin/Referer check (`sameOriginGuard`) — no CSRF token (layer 1 is the
 * SameSite=Lax cookie). Archived repos refuse the write (upstream
 * `context.RepoMustNotBeArchived()` on the milestones group; the list hides
 * the New button) with the API's exact message re-rendered inline.
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The milestone title renders as PLAIN TEXT: upstream links
 *   `/{repo}/milestone/{id}` — no milestone detail page exists; the §2.4.1
 *   "dead links are not emitted" rule wins (the issues list's milestone
 *   badge does the same).
 * - The issue-navbar compact menu reduces to the single live item
 *   (Milestones): the Labels list page does not exist (dead-link rule).
 * - The row admin controls (edit / close / delete links + the delete
 *   confirm modal) are not rendered — none of those routes or pages exist
 *   in the UI inventory this slice.
 * - The row's milestone description block is not rendered (upstream renders
 *   it through the markdown pipeline; the create form still stores it).
 * - The search box and the `?sort=` / `?q=` facets are not wired (no search
 *   route); the state facet is.
 * - Total tracked time has no landed source (no timetracker) — the clock
 *   chip renders only for the updated/closed stamps.
 * - Pagination is the list pages' Older/Newer shape (upstream
 *   base/paginate), page size upstream `setting.UI.IssuePagingNum` = 20.
 */

import { IssuesService } from "../../issues/service";
import type { MilestoneRow } from "../../issues/service";
import {
  createRepoMilestone,
  listRepoMilestones,
  parseMilestoneDeadline,
} from "../../api/services/milestones";
import { TimeSince } from "../components/file-list";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** Page chrome text (component-local, the issuesLocale pattern — the strings
 *  cite upstream's locale keys). */
export const milestonesLocale = {
  milestones: "Milestones", // "repo.milestones"
  labels: "Labels", // "repo.labels" (wave 25's navbar item — navbar.tmpl's first entry)
  new_milestone: "New Milestone", // "repo.milestones.new"
  open_title: "Open", // "repo.issues.open_title"
  closed_title: "Closed", // "repo.issues.closed_title"
  closed_ago: "Closed", // "repo.milestones.closed" (the stamp renders beside it)
  update_ago: "Updated", // "repo.milestones.update_ago"
  no_due_date: "No due date", // "repo.milestones.no_due_date"
  title: "Title", // "repo.milestones.title"
  due_date: "Due Date (optional)", // "repo.milestones.due_date"
  desc: "Description", // "repo.milestones.desc"
  create: "Create Milestone", // "repo.milestones.create"
  new_subheader: "Milestones can help you organize issues and track their progress.", // "repo.milestones.new_subheader"
  /** The invalid-deadline re-render message — upstream's exact string. */
  invalid_due_date_format: "Due date format must be 'yyyy-mm-dd'.", // "repo.milestones.invalid_due_date_format"
  /** cf-gitea addition: upstream's HTML5 `required` catches the empty title
   *  client-side; this is the server-side re-render message (the new-issue
   *  page's convention, mirrored wording). */
  title_required: "A title is required.",
  /** cf-gitea addition: the server-side MaxSize(50) binding check (the input
   *  carries maxlength=50). */
  title_too_long: "Title must be at most 50 characters.",
  /** The archived refusal — upstream `mustNotBeArchived`'s exact message
   *  (routers/api/v1/api.go:816), the new-issue page's carried convention. */
  repo_archived: "repo is archived",
} as const;

/** Upstream `setting.UI.IssuePagingNum` (modules/setting/ui.go:89) — the
 *  milestones list pages with the same page size (routers/web/repo/
 *  milestone.go Milestones). */
export const MILESTONES_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// List data (§3.2 direct service calls)
// ---------------------------------------------------------------------------

/** One rendered row's display facts (computed in the loader, the
 *  issues-list loader pattern — components render synchronously). */
export interface MilestoneListItem {
  row: MilestoneRow;
  openIssues: number;
  /** The stored `completeness` column (recomputed by the landed service on
   *  every counter write) — the progress bar's real number. */
  completeness: number;
  /** Open milestone with a past deadline (upstream IsOverdue — the red
   *  due-date line). Evaluated against the loader's clock. */
  overdue: boolean;
}

/** The milestones page render inputs. */
export interface MilestonesData {
  state: "open" | "closed";
  page: number;
  items: MilestoneListItem[];
  /** The unfiltered tab totals (upstream OpenCount/ClosedCount). */
  openCount: number;
  closedCount: number;
  more: boolean;
  /** The repo-admin grant behind the New Milestone button (upstream
   *  `(or .CanWriteIssues .CanWritePulls)` reduced to canAdminRepo). Set by
   *  the route handler after the load — the predicate needs the resolved
   *  repo row + viewer, which the loader deliberately never sees. */
  canWrite: boolean;
}

/** `?state=` — anything but "closed" is open (upstream `isShowClosed :=
 *  FormString("state") == "closed"`; no "all" tab — the handler always
 *  filters one state, optional.Some(isShowClosed)). */
export function parseMilestonesState(raw: string | null): "open" | "closed" {
  return raw === "closed" ? "closed" : "open";
}

/** Upstream `DateUtils.AbsoluteShort` ("Jan 2, 2006") for the due date —
 *  UTC, hand-rolled so the bytes never depend on the runtime's ICU. */
export function formatDueDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/**
 * Load the list (§3.2): one filtered page read + two 1-row count reads (the
 * unfiltered tab totals, the issues list's pattern). `now` is the loader's
 * clock for the overdue flag — a fixed past deadline stays overdue forever,
 * so fixed-`now` fixtures render deterministically.
 */
export async function loadMilestonesData(
  d1: D1Database,
  repoId: string,
  params: URLSearchParams,
  now: Date = new Date(),
): Promise<MilestonesData> {
  const state = parseMilestonesState(params.get("state"));
  const page = parsePageNumber(params.get("page"));

  const [listPage, openPage, closedPage] = await Promise.all([
    listRepoMilestones(d1, repoId, { state, name: "", page, limit: MILESTONES_PAGE_SIZE }),
    listRepoMilestones(d1, repoId, { state: "open", name: "", page: 1, limit: 1 }),
    listRepoMilestones(d1, repoId, { state: "closed", name: "", page: 1, limit: 1 }),
  ]);

  const items: MilestoneListItem[] = listPage.items.map((row) => ({
    row,
    openIssues: Math.max((row.numIssues ?? 0) - (row.numClosedIssues ?? 0), 0),
    completeness: Math.min(Math.max(row.completeness ?? 0, 0), 100),
    overdue: !row.isClosed && row.deadlineAt !== null && row.deadlineAt.getTime() < now.getTime(),
  }));

  return {
    state,
    page,
    items,
    openCount: openPage.total,
    closedCount: closedPage.total,
    more: page * MILESTONES_PAGE_SIZE < listPage.total,
    canWrite: false, // the handler assigns the real predicate (see MilestonesData)
  };
}

// ---------------------------------------------------------------------------
// Form parsing + the write (§3.2 — createRepoMilestone directly)
// ---------------------------------------------------------------------------

/** The parsed create-milestone submission; `deadline` keeps the raw string
 *  for the re-render (the `<input type="date">` value shape). */
export interface NewMilestoneForm {
  title: string;
  content: string;
  deadline: string;
}

/** Parse the urlencoded POST (`title`, `deadline`, `content` — the upstream
 *  milestone_new.tmpl field names). Title is trimmed (the new-issue
 *  convention). */
export function parseMilestoneForm(params: URLSearchParams): NewMilestoneForm {
  return {
    title: (params.get("title") ?? "").trim(),
    content: params.get("content") ?? "",
    deadline: (params.get("deadline") ?? "").trim(),
  };
}

export type NewMilestoneResult = { outcome: "created" } | { outcome: "invalid"; message: string };

/**
 * The write: validate the form, then the landed `createRepoMilestone` (the
 * API POST route's service — the deadline parser, the name trim, the
 * IssuesService batch underneath). Validation failures re-render inline;
 * there are no expected service-level errors (the repo row is already
 * resolved, the title/deadline are validated here).
 */
export async function createMilestoneFromForm(
  d1: D1Database,
  repoId: string,
  form: NewMilestoneForm,
  now: Date = new Date(),
): Promise<NewMilestoneResult> {
  if (form.title === "") return { outcome: "invalid", message: milestonesLocale.title_required };
  if (form.title.length > 50) return { outcome: "invalid", message: milestonesLocale.title_too_long };
  let deadlineAt: Date | null;
  try {
    deadlineAt = parseMilestoneDeadline(form.deadline);
  } catch {
    return { outcome: "invalid", message: milestonesLocale.invalid_due_date_format };
  }
  await createRepoMilestone(new IssuesService(d1), repoId, {
    title: form.title,
    description: form.content,
    deadlineAt,
    state: "open",
    now,
  });
  return { outcome: "created" };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The issue-navbar compact menu (repo/issue/navbar.tmpl) — wave 25 adds
 *  the Labels item (the page exists now: pages/repo-labels.tsx); upstream's
 *  order renders Labels first, Milestones second, each active on its own
 *  page. */
function MilestoneNavbar(props: { repoLink: string }) {
  return (
    <h2 class="ui compact small menu small-menu-items issue-list-navbar">
      <a class="item" href={`${props.repoLink}/labels`}>
        {milestonesLocale.labels}
      </a>
      <a class="active item" href="?">
        {milestonesLocale.milestones}
      </a>
    </h2>
  );
}

/** The open/closed tab menu (repo/issue/openclose.tmpl — the milestones
 *  list carries the milestone glyph on the Open tab, `PageIsMilestones`).
 *  The active tab links to its own state (the issues-list OpenCloseTabs
 *  convention; upstream's active-tab toggles to the unfiltered "all" URL
 *  this reduction does not render). */
export function MilestoneTabs(props: { basePath: string; state: "open" | "closed"; openCount: number; closedCount: number }) {
  const href = (state: "open" | "closed"): string =>
    state === "open" ? props.basePath : `${props.basePath}?state=closed`;
  return (
    <div class="small-menu-items ui compact tiny menu">
      <a class={props.state === "open" ? "active item flex-text-inline" : "item flex-text-inline"} href={href("open")}>
        <Icon name="octicon-milestone" /> {props.openCount} {milestonesLocale.open_title}
      </a>
      <a class={props.state === "closed" ? "active item flex-text-inline" : "item flex-text-inline"} href={href("closed")}>
        <Icon name="octicon-issue-closed" /> {props.closedCount} {milestonesLocale.closed_title}
      </a>
    </div>
  );
}

/** The Older/Newer pagination — the list pages' DOM shape
 *  (div.center.page.buttons), driven by `page * size < total`. */
function MilestonesPagination(props: { basePath: string; state: "open" | "closed"; page: number; more: boolean }) {
  if (props.page <= 1 && !props.more) return null;
  const href = (page: number): string => {
    if (page <= 1) return props.basePath;
    return props.state === "closed" ? `${props.basePath}?state=closed&page=${page}` : `${props.basePath}?page=${page}`;
  };
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={href(props.page - 1)}>
            <span class="navigation_label">Newer</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={href(props.page + 1)}>
            <span class="navigation_label">Older</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** One `.item.flex-relaxed-list` row of milestones.tmpl (reductions in the
 *  module header). */
function MilestoneListItemRow(props: { item: MilestoneListItem }) {
  const { row, completeness } = props.item;
  return (
    <div class="item flex-relaxed-list">
      <div class="flex-left-right">
        <span class="list-item-large-title">
          <Icon name="octicon-milestone" size={16} /> {row.name}
        </span>
        <div class="flex-text-inline">
          <span>{completeness}%</span>
          <progress class="list-item-title-progress" value={completeness} max={100} />
        </div>
      </div>
      <div class="list-item-secondary-bar">
        <div class="flex-text-block tw-flex-wrap">
          <div class="flex-text-inline">
            <Icon name="octicon-issue-opened" size={14} /> {props.item.openIssues} {milestonesLocale.open_title}
          </div>
          <div class="flex-text-inline">
            <Icon name="octicon-check" size={14} /> {row.numClosedIssues ?? 0} {milestonesLocale.closed_title}
          </div>
          {row.updatedAt !== null ? (
            <div class="flex-text-inline">
              <Icon name="octicon-clock" size={14} /> {milestonesLocale.update_ago}{" "}
              <TimeSince unixSeconds={Math.floor(row.updatedAt.getTime() / 1000)} tz="+0000" />
            </div>
          ) : null}
          <div class="flex-text-inline">
            {row.isClosed ? (
              <>
                <Icon name="octicon-clock" size={14} /> {milestonesLocale.closed_ago}
                {row.closedDateAt !== null ? (
                  <>
                    {" "}
                    <TimeSince unixSeconds={Math.floor(row.closedDateAt.getTime() / 1000)} tz="+0000" />
                  </>
                ) : null}
              </>
            ) : row.deadlineAt !== null ? (
              <span class={props.item.overdue ? "flex-text-inline tw-text-red" : "flex-text-inline"}>
                <Icon name="octicon-calendar" size={14} /> {formatDueDate(row.deadlineAt)}
              </span>
            ) : (
              <span class="flex-text-inline">
                <Icon name="octicon-calendar" size={14} /> {milestonesLocale.no_due_date}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderMilestonesPage(ctx: UiContext, data: MilestonesData): string {
  return renderPage(<MilestonesPage ctx={ctx} data={data} />);
}

/** The milestones list page (§2.4.1 discriminator: `repository milestones`).
 *  activeTab="issues": upstream sets PageIsIssueList on this page
 *  (milestone.go Milestones), so the shell's Issues tab carries the active
 *  mark, like the issues list. */
export function MilestonesPage(props: { ctx: UiContext; data: MilestonesData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("MilestonesPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={milestonesLocale.milestones} pageClass="repository milestones" activeTab="issues">
      <div class="ui container">
        <div class="list-header">
          <MilestoneNavbar repoLink={repoLink} />
          {data.canWrite && !repo.isArchived ? (
            <a class="ui small primary button" href={`${repoLink}/milestones/new`}>
              {milestonesLocale.new_milestone}
            </a>
          ) : null}
        </div>
        <MilestoneTabs basePath={`${repoLink}/milestones`} state={data.state} openCount={data.openCount} closedCount={data.closedCount} />
        <div class="flex-divided-list milestone-list">
          {data.items.map((item) => (
            <MilestoneListItemRow item={item} />
          ))}
        </div>
        <MilestonesPagination basePath={`${repoLink}/milestones`} state={data.state} page={data.page} more={data.more} />
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The new-milestone form (GET/POST /milestones/new)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern). */
export function renderNewMilestonePage(options: {
  ctx: UiContext;
  form: NewMilestoneForm;
  error: string | null;
}): string {
  return renderPage(<NewMilestonePage ctx={options.ctx} form={options.form} error={options.error} />);
}

/** The create form (§2.4.1 discriminator: `repository new milestone`),
 *  milestone_new.tmpl reduced to the title/deadline/content fields (the
 *  combo markdown editor is the plain-textarea reduction, the new-issue
 *  page's convention). */
export function NewMilestonePage(props: { ctx: UiContext; form: NewMilestoneForm; error: string | null }) {
  const { ctx } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("NewMilestonePage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={milestonesLocale.new_milestone} pageClass="repository new milestone" activeTab="issues">
      <div class="ui container">
        <div class="issue-navbar">
          <MilestoneNavbar repoLink={repoLink} />
        </div>
        <div class="divider" />
        <h2 class="ui dividing header">
          {milestonesLocale.new_milestone}
          <div class="sub header">{milestonesLocale.new_subheader}</div>
        </h2>
        <form class="ui form" action={`${repoLink}/milestones/new`} method="post">
          {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
          <div class="field">
            <label for="milestone-title">{milestonesLocale.title}</label>
            <input id="milestone-title" name="title" value={props.form.title} required maxlength={50} autocomplete="off" />
          </div>
          <div class="field">
            <label for="milestone-deadline">{milestonesLocale.due_date}</label>
            <input id="milestone-deadline" type="date" name="deadline" class="tw-w-auto" value={props.form.deadline} />
          </div>
          <div class="field">
            <label for="milestone-content">{milestonesLocale.desc}</label>
            <textarea id="milestone-content" name="content" rows={5}>
              {props.form.content}
            </textarea>
          </div>
          <div class="flex-text-block tw-justify-end">
            <button type="submit" class="ui primary button">
              {milestonesLocale.create}
            </button>
          </div>
        </form>
      </div>
    </BaseLayout>
  );
}
