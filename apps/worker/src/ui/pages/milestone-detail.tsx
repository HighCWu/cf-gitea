/**
 * The milestone detail page, `/{owner}/{repo}/milestone/{id}` — and its edit
 * form, `/{owner}/{repo}/milestones/{id}/edit` — pages wave 26 (the UI-parity
 * survey's TOP-3 row, docs/compat/ui-parity-survey.md): upstream
 * `repo.MilestoneIssuesAndPulls` (web.go:1340, routers/web/repo/milestone.go:
 * 237-274) in the reader group and the `/{id}/edit` combo (web.go:1427-1428,
 * milestone.go:139-200) in the writer group, over templates/repo/issue/
 * milestone_issues.tmpl + milestone_new.tmpl at the pin.
 *
 * ## Gates (the group's order, reduced to the landed model)
 *
 * - Detail (`optSignIn` + RepoAssignment + reqRepoIssuesOrPullsReader —
 *   RequireSignInViewStrict off at the pin): anonymous-capable like the
 *   issues list; an invisible repo 404-shells through the router's §2.5
 *   read; an unknown/garbage/foreign milestone id 404-shells (upstream
 *   GetMilestoneByRepoID's ErrMilestoneNotExist → NotFound — the id is
 *   REPO-SCOPED, so another repo's milestone id is equally invisible).
 * - Edit (reqSignIn + RepoMustNotBeArchived + reqRepoIssuesOrPullsWriter):
 *   anonymous → the login 303 (repo resolution FIRST — invisible repos 404
 *   before the redirect could leak), a signed-in non-writer → the 404 shell.
 *   The writer predicate is `canWriteRepo` (the wave-25 labels-write port of
 *   reqRepoIssuesOrPullsWriter) — a documented DIVERGENCE from the landed
 *   milestone-new reduction (pages/milestones.tsx gates its form on
 *   canAdminRepo); this page ports the upstream gate faithfully, the family's
 *   two write surfaces disagree exactly as their landed gates do. The POST
 *   re-checks the grant and re-renders with the archived message (the
 *   milestone-new posture).
 *
 * ## DOM contract (milestone_issues.tmpl at the pin)
 *
 * `.page-content.repository milestone-issue-list`, the shell's RepoHeader,
 * then `.ui.container`: the `.flex-text-block.tw-flex-wrap.tw-mb-2` header
 * row — `h1.tw-flex-1.tw-m-0` milestone name over the action buttons
 * (`not .IsArchived`): the writer's Edit button (`ui button` → the edit
 * form; upstream's Close/Open link-action button posts
 * `/milestones/{id}/{action}` — no such route in this slice, the dead-link
 * rule skips it) and everyone's New Issue button (`ui primary button` →
 * `/issues/new?milestone={id}`, the landed new-issue form's ?milestone=
 * preselect); the rendered description (`.render-content.markup` — the §3.4
 * shared markdown pipeline, issue-detail's renderIssueMarkdown); the
 * `.milestone-progress-big` progress bar + meta line (the closed
 * octicon-clock stamp OR the octicon-calendar due date — red when overdue —
 * OR "No due date"; `{N}% Completed` — the `completeness` locale's strong
 * split; the TotalTrackedTime chip has no landed source, the list page's
 * timetracker reduction); the divider; the openclose tab menu + the
 * shared/issuelist rows (listType "milestone": the per-row milestone badge
 * is suppressed — every row is this milestone).
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The tab menu renders upstream's DETAIL-page arms exactly: `State` is
 *   never set by MilestoneIssuesAndPulls, so NEITHER tab is ever active and
 *   each links to its own `?state=` (the list page's active-tab shape does
 *   not apply here). Open tab carries octicon-issue-opened (PageIsMilestones
 *   is false on this page — the milestone-glyph arm is the list page's).
 * - Upstream's filter toolbar (labels/assignee/poster/projects dropdowns,
 *   the keyword search — the issue indexer) is not rendered; the two facets
 *   this slice wires are `?state=` (open default, closed, and upstream's
 *   ParseIssueFilterStateIsClosed "all") and `?labels=` (the issues-list
 *   page's label facet — the row badges link into it). The list page's
 *   "default to all when only closed issues exist" arm
 *   (prepareIssueFilterAndList) is ported verbatim.
 * - The tab/label/pager hrefs reduce upstream's QueryBuild to the params
 *   this page honors (state + labels; the milestone scope IS the page).
 * - The PR rows render through the same IssueListItem shape (isPull null —
 *   upstream's isPullOption is optional.None: issues AND pulls together);
 *   the PR extension fields (branch pair, CI statuses, approval counts) are
 *   the issues-list page's reductions.
 * - The description renders through the comment-mode markdown pipeline
 *   (upstream RenderedContent); a pipeline failure renders nothing (the
 *   issue-body posture — markdown never breaks the page).
 *
 * ## The edit form (milestone_new.tmpl's PageIsEditMilestone arms)
 *
 * `repository new milestone` pageClass (the create form's discriminator —
 * one template serves both), the issue-navbar + the writer's New Milestone
 * button, the h2 dividing header ("Edit Milestone" + edit_subheader), and
 * the title/deadline/content fields (the landed create form's field set —
 * the combo markdown editor stays the plain-textarea reduction; the JS
 * clear-deadline link is dead UI here). The form posts to its own URL
 * (upstream `action="{{.Link}}"`): title required + MaxSize(50), the
 * deadline through the API's end-of-day parser, then the landed
 * `editRepoMilestone` (the PATCH route's service) — success 303s back onto
 * the list (upstream's redirect), validation failures re-render at 200 with
 * the message and the kept values, an unknown/foreign id 404-shells.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { issueLabelRows, listRepoIssues } from "../../api/services/issues";
import { editRepoMilestone, parseMilestoneDeadline } from "../../api/services/milestones";
import { inArray } from "drizzle-orm";
import { pullRequests, users, milestones } from "../../db/schema";
import { IssuesService, type MilestoneRow } from "../../issues/service";
import {
  IssueStateIcon,
  LabelBadge,
  issuesLocale,
  parseLabelIds,
  type IssueListItem,
} from "./issues-list";
import { renderIssueMarkdown } from "./issue-detail";
import {
  formatDueDate,
  MilestoneNavbar,
  milestonesLocale,
  parseMilestoneForm,
  type NewMilestoneForm,
} from "./milestones";
import { TimeSince } from "../components/file-list";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";

/** Page chrome text (component-local, the milestonesLocale pattern — the
 *  strings cite upstream's locale keys). */
export const milestoneDetailLocale = {
  edit: "Edit", // "repo.issues.label_edit" (the header action button)
  edit_milestone: "Edit Milestone", // "repo.milestones.edit"
  edit_subheader: "Milestones organize issues and track progress.", // "repo.milestones.edit_subheader"
  modify: "Update Milestone", // "repo.milestones.modify"
  cancel: "Cancel", // "repo.milestones.cancel"
  completed: "Completed", // "repo.milestones.completeness" (the strong-split tail)
  new_issue: "New Issue", // "repo.issues.new"
  noResults: "No results", // the issues-list page's empty arm (shared/issuelist)
  noResultsPlaceholder: "Try adjusting your search filters.",
} as const;

/** Upstream `setting.UI.IssuePagingNum` — the milestone detail's issue list
 *  pages with the same page size (prepareIssueFilterAndList's pager). */
export const MILESTONE_ISSUES_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Detail data (§3.2 direct service calls)
// ---------------------------------------------------------------------------

/** `?state=` — upstream ParseIssueFilterStateIsClosed (routers/common/
 * issue_filter.go:16-27): "all" disables the filter, "closed" is closed,
 * everything else ("", "open", unknown) is open. */
export function parseMilestoneIssueState(raw: string | null): "open" | "closed" | "all" {
  if (raw === "all") return "all";
  if (raw === "closed") return "closed";
  return "open";
}

/** The milestone detail page's render inputs. */
export interface MilestoneDetailData {
  milestone: MilestoneRow;
  /** The effective state facet AFTER the flip arm (below). */
  state: "open" | "closed" | "all";
  page: number;
  items: IssueListItem[];
  /** The milestone's unfiltered tab totals (upstream OpenCount/ClosedCount
   *  — GetIssueStats over the milestone filter). */
  openCount: number;
  closedCount: number;
  more: boolean;
  /** The active `?labels=` facet (the pager's href carrier). */
  labelIds: number[];
  /** The clamped completeness (0-100 — the progress bar's real number). */
  completeness: number;
  /** Open milestone with a past deadline (upstream IsOverdue). Evaluated
   *  against the loader's clock. */
  overdue: boolean;
  /** The rendered description ("" when none or on pipeline failure). */
  contentHtml: string;
  /** The writer grant behind the Edit button — assigned by the handler after
   *  the load (the MilestonesData.canWrite pattern: the predicate needs the
   *  viewer, which the loader never sees). */
  canWrite: boolean;
}

/** Parse the URL id segment (Go PathParamInt64: decimal only, garbage → 0 →
 *  the not-found arm at lookup time). Returns null for non-numeric segments. */
export function parseMilestoneId(raw: string): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** The repo-scoped milestone lookup (upstream GetMilestoneByRepoID — id AND
 *  repoId, so a foreign milestone id is invisible). */
export async function findRepoMilestoneById(
  d1: D1Database,
  repoId: string,
  id: number,
): Promise<MilestoneRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(milestones)
    .where(and(eq(milestones.id, id), eq(milestones.repoId, repoId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Load the milestone detail (§3.2): the repo-scoped milestone row, then the
 * filtered issue page + two 1-row count reads (the tab totals), then the
 * issues-list enrichment. `repo`/`origin` drive the markdown pipeline.
 * Returns null when the id misses (the caller 404-shells).
 */
export async function loadMilestoneDetailData(
  d1: D1Database,
  repo: RepoRow,
  rawId: string,
  params: URLSearchParams,
  origin: string,
  now: Date = new Date(),
): Promise<MilestoneDetailData | null> {
  const id = parseMilestoneId(rawId);
  if (id === null) return null;
  const milestone = await findRepoMilestoneById(d1, repo.id, id);
  if (milestone === null) return null;

  const page = parsePageNumber(params.get("page"));
  const labelIds = parseLabelIds(params.get("labels"));
  let state = parseMilestoneIssueState(params.get("state"));

  const filters = {
    isPull: null,
    keyword: "",
    labelIds,
    milestoneIds: [milestone.id] as number[],
    since: null,
    before: null,
  };

  // The two tab-count reads first (unfiltered by state): the flip arm below
  // needs them before the page slice can pick its filter.
  const [openPage, closedPage] = await Promise.all([
    listRepoIssues(d1, repo.id, { ...filters, isClosed: false, page, limit: 1 }),
    listRepoIssues(d1, repo.id, { ...filters, isClosed: true, page, limit: 1 }),
  ]);

  // prepareIssueFilterAndList's flip arm: the URL carried no state, no open
  // issues exist, closed ones do — show all (isShowClosed → None).
  if (params.get("state") === null && openPage.total === 0 && closedPage.total > 0) {
    state = "all";
  }

  const listPage = await listRepoIssues(d1, repo.id, {
    ...filters,
    isClosed: state === "all" ? null : state === "closed",
    page,
    limit: MILESTONE_ISSUES_PAGE_SIZE,
  });

  // The issues-list enrichment (labels, PR merged flags, poster names) —
  // the same batched reads, one module over.
  const items: IssueListItem[] = listPage.items.map((issue) => ({
    issue,
    labels: [],
    milestone: null,
    posterName: null,
    prMerged: false,
  }));
  await Promise.all(items.map(async (item) => {
    item.labels = await issueLabelRows(d1, item.issue.id);
  }));
  const pullIds = items.filter((item) => item.issue.isPull).map((item) => item.issue.id);
  if (pullIds.length > 0) {
    const rows = await drizzle(d1)
      .select({ issueId: pullRequests.issueId, hasMerged: pullRequests.hasMerged })
      .from(pullRequests)
      .where(inArray(pullRequests.issueId, pullIds))
      .all();
    const mergedByIssue = new Map(rows.map((row) => [row.issueId, row.hasMerged]));
    for (const item of items) {
      item.prMerged = mergedByIssue.get(item.issue.id) ?? false;
    }
  }
  const posterIds = [...new Set(items.map((item) => item.issue.posterId).filter((pid): pid is number => pid !== null))];
  if (posterIds.length > 0) {
    const rows = await drizzle(d1)
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, posterIds))
      .all();
    const byId = new Map(rows.map((row) => [row.id, row.username]));
    for (const item of items) {
      item.posterName = item.issue.posterId === null ? null : (byId.get(item.issue.posterId) ?? null);
    }
  }

  return {
    milestone,
    state,
    page,
    items,
    openCount: openPage.total,
    closedCount: closedPage.total,
    more: page * MILESTONE_ISSUES_PAGE_SIZE < listPage.total,
    labelIds,
    completeness: Math.min(Math.max(milestone.completeness ?? 0, 0), 100),
    overdue: !milestone.isClosed && milestone.deadlineAt !== null && milestone.deadlineAt.getTime() < now.getTime(),
    contentHtml: renderIssueMarkdown({ text: milestone.content ?? "", repo, origin }),
    canWrite: false, // the handler assigns the real predicate (see MilestoneDetailData)
  };
}

// ---------------------------------------------------------------------------
// Detail components (milestone_issues.tmpl, reductions in the header)
// ---------------------------------------------------------------------------

/** The tab menu (openclose.tmpl's detail-page arms — neither tab active,
 *  each linking its own state; the header's reductions cover the "all" URL
 *  and the filter toolbar). */
export function MilestoneIssueTabs(props: {
  basePath: string;
  openCount: number;
  closedCount: number;
}) {
  return (
    <div class="small-menu-items ui compact tiny menu">
      <a class="item flex-text-inline" href={`${props.basePath}?state=open`}>
        <Icon name="octicon-issue-opened" /> {props.openCount} {issuesLocale.open_title}
      </a>
      <a class="item flex-text-inline" href={`${props.basePath}?state=closed`}>
        <Icon name="octicon-issue-closed" /> {props.closedCount} {issuesLocale.closed_title}
      </a>
    </div>
  );
}

/** The Older/Newer pagination (the list pages' DOM shape), keeping the state
 *  and label facets (upstream QueryBuild's pager). */
function MilestoneIssuePagination(props: {
  basePath: string;
  state: "open" | "closed" | "all";
  labelIds: number[];
  page: number;
  more: boolean;
}) {
  if (props.page <= 1 && !props.more) return null;
  const href = (page: number): string => {
    const params = new URLSearchParams();
    if (props.state !== "open") params.set("state", props.state);
    if (props.labelIds.length > 0) params.set("labels", props.labelIds.join(","));
    if (page > 1) params.set("page", String(page));
    const query = params.toString();
    return query === "" ? props.basePath : `${props.basePath}?${query}`;
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

/** One shared/issuelist row at listType "milestone" (the issues-list row's
 *  shape with the milestone badge suppressed — every row is this milestone;
 *  label badges link into the page's own state+labels facets). */
function MilestoneIssueRow(props: { repoLink: string; state: "open" | "closed" | "all"; item: IssueListItem }) {
  const { item } = props;
  const href = `${props.repoLink}/issues/${item.issue.index}`;
  // The row badge's facet href (issuelist.tmpl's QueryBuild reduced to the
  // params this page honors): the current state (implicit when open — the
  // default) + the label id. The milestone param is suppressed upstream on
  // this page (listType "milestone") — the page IS the milestone scope.
  const labelHref = (labelId: number): string => {
    const params = new URLSearchParams();
    if (props.state !== "open") params.set("state", props.state);
    params.set("labels", String(labelId));
    return `?${params.toString()}`;
  };
  return (
    <div class="item">
      <div class="item-leading">
        <div class="flex-text-inline tw-mt-[3px]">
          <IssueStateIcon item={item} />
        </div>
      </div>
      <div class="item-main">
        <div class="item-header">
          <div>
            <a class="list-item-large-title" href={href}>
              {item.issue.title}
            </a>
            {item.labels.length > 0 ? (
              <span class="labels-list">
                {item.labels.map((label) => (
                  <a class="item" href={labelHref(label.id)}>
                    <LabelBadge label={label} />
                  </a>
                ))}
              </span>
            ) : null}
          </div>
        </div>
        <div class="item-body tw-gap-2">
          <a class="index flex-text-inline" href={href}>
            #{item.issue.index}
          </a>
          <MilestoneEventLine item={item} />
        </div>
      </div>
      {item.issue.numComments > 0 ? (
        <div class="item-trailing">
          <div class="tw-text-text-light">
            <a class="tw-no-underline muted flex-text-block" href={href}>
              {item.issue.numComments}
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The issuelist event line — the issues-list page's shape (the milestone
 *  page's rows carry the same facts from the same columns). */
function MilestoneEventLine(props: { item: IssueListItem }) {
  const { issue } = props.item;
  const event = issue.isClosed
    ? (issue.closedAt ?? issue.updatedAt ?? issue.createdAt)
    : (issue.createdAt ?? issue.updatedAt);
  const unix = (date: Date): number => Math.floor(date.getTime() / 1000);
  return (
    <div class="flex-text-inline">
      {issue.isClosed ? "closed" : "opened"}{" "}
      {event !== null ? <TimeSince unixSeconds={unix(event)} tz="+0000" /> : null}
      {props.item.posterName !== null ? (
        <>
          {" "}by <a href={`/${props.item.posterName}`}>{props.item.posterName}</a>
        </>
      ) : null}
    </div>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderMilestoneDetailPage(ctx: UiContext, data: MilestoneDetailData): string {
  return renderPage(<MilestoneDetailPage ctx={ctx} data={data} />);
}

/** The milestone detail page (§2.4.1 discriminator: the template's literal
 *  `repository milestone-issue-list`). No main tab highlights (upstream sets
 *  neither PageIsIssueList nor PageIsMilestones here). */
export function MilestoneDetailPage(props: { ctx: UiContext; data: MilestoneDetailData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("MilestoneDetailPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const basePath = `${repoLink}/milestone/${data.milestone.id}`;
  return (
    <BaseLayout
      ctx={ctx}
      title={data.milestone.name}
      pageClass="repository milestone-issue-list"
    >
      <div class="ui container">
        <div class="flex-text-block tw-flex-wrap tw-mb-2">
          <h1 class="tw-flex-1 tw-m-0">{data.milestone.name}</h1>
          {!repo.isArchived ? (
            <div>
              {data.canWrite ? (
                <a class="ui button" href={`${repoLink}/milestones/${data.milestone.id}/edit`}>
                  {milestoneDetailLocale.edit}
                </a>
              ) : null}
              <a class="ui primary button" href={`${repoLink}/issues/new?milestone=${data.milestone.id}`}>
                {milestoneDetailLocale.new_issue}
              </a>
            </div>
          ) : null}
        </div>
        {data.contentHtml !== "" ? (
          <div class="render-content markup tw-mb-4" dangerouslySetInnerHTML={{ __html: data.contentHtml }} />
        ) : null}
        <div class="tw-flex tw-flex-col tw-gap-2">
          <progress class="milestone-progress-big" value={data.completeness} max={100} />
          <div class="flex-text-block tw-gap-4">
            <div class="flex-text-inline">
              {data.milestone.isClosed ? (
                <>
                  <Icon name="octicon-clock" /> {milestonesLocale.closed_ago}
                  {data.milestone.closedDateAt !== null ? (
                    <>
                      {" "}
                      <TimeSince unixSeconds={Math.floor(data.milestone.closedDateAt.getTime() / 1000)} tz="+0000" />
                    </>
                  ) : null}
                </>
              ) : data.milestone.deadlineAt !== null ? (
                <span class={data.overdue ? "tw-text-red" : undefined}>
                  <Icon name="octicon-calendar" /> {formatDueDate(data.milestone.deadlineAt)}
                </span>
              ) : (
                <>
                  <Icon name="octicon-calendar" /> {milestonesLocale.no_due_date}
                </>
              )}
            </div>
            <div>
              <strong>{data.completeness}%</strong> {milestoneDetailLocale.completed}
            </div>
          </div>
        </div>
        <div class="divider" />
        <div class="issue-list-toolbar-left">
          <MilestoneIssueTabs basePath={basePath} openCount={data.openCount} closedCount={data.closedCount} />
        </div>
        {data.items.length === 0 ? (
          // The no-results arm — the issues-list page's shape with the
          // heading lifted h3→h2 (the tags page's a11y R2 precedent: this
          // page carries an h1, and h1→h3 would skip a level).
          <div class="tw-text-center tw-p-8">
            <h2 class="tw-my-4">{milestoneDetailLocale.noResults}</h2>
            <p class="tw-text-placeholder-text">{milestoneDetailLocale.noResultsPlaceholder}</p>
          </div>
        ) : (
          <div id="issue-list" class="flex-divided-list items-with-main">
            {data.items.map((item) => (
              <MilestoneIssueRow repoLink={repoLink} state={data.state} item={item} />
            ))}
          </div>
        )}
        <MilestoneIssuePagination basePath={basePath} state={data.state} labelIds={data.labelIds} page={data.page} more={data.more} />
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The edit form (milestone_new.tmpl's PageIsEditMilestone arms)
// ---------------------------------------------------------------------------

/** The edit page's render inputs: the milestone row (the header never
 *  renders it — upstream shows only the form fields) + the prefilled form. */
export interface MilestoneEditData {
  milestone: MilestoneRow;
}

/** The deadline's `<input type="date">` value shape (upstream
 *  DeadlineString — "2006-01-02" of the stored end-of-day UTC timestamp). */
export function formatDateInput(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}-${day}`;
}

/** Load the edit form (§3.2): the repo-scoped row (null → the caller 404-
 *  shells, upstream GetMilestoneByRepoID's NotFound) with the stored values
 *  prefilled (title/content verbatim, the deadline re-rendered as its date
 *  input shape). */
export async function loadMilestoneEditData(
  d1: D1Database,
  repoId: string,
  rawId: string,
): Promise<MilestoneEditData | null> {
  const id = parseMilestoneId(rawId);
  if (id === null) return null;
  const milestone = await findRepoMilestoneById(d1, repoId, id);
  if (milestone === null) return null;
  return { milestone };
}

/** The edit form's prefilled fields (the NewMilestoneForm shape — the same
 *  field names the POST parses). */
export function milestoneEditFormOf(milestone: MilestoneRow): NewMilestoneForm {
  return {
    title: milestone.name,
    content: milestone.content ?? "",
    deadline: milestone.deadlineAt !== null ? formatDateInput(milestone.deadlineAt) : "",
  };
}

export type EditMilestoneResult = { outcome: "applied" } | { outcome: "invalid"; message: string };

/**
 * The write: validate exactly like the create form (the shared parser +
 * validator), then the landed `editRepoMilestone` (the PATCH route's
 * service — name trimmed upstream-style, the state preserved by omission).
 * Validation failures surface as the invalid outcome; the repo row is
 * already resolved and the milestone existence was checked at load.
 */
export async function editMilestoneFromForm(
  d1: D1Database,
  milestoneId: number,
  form: NewMilestoneForm,
  now: Date = new Date(),
): Promise<EditMilestoneResult> {
  if (form.title === "") return { outcome: "invalid", message: milestonesLocale.title_required };
  if (form.title.length > 50) return { outcome: "invalid", message: milestonesLocale.title_too_long };
  let deadlineAt: Date | null;
  try {
    deadlineAt = parseMilestoneDeadline(form.deadline);
  } catch {
    return { outcome: "invalid", message: milestonesLocale.invalid_due_date_format };
  }
  await editRepoMilestone(new IssuesService(d1), milestoneId, {
    title: form.title,
    description: form.content,
    deadlineAt,
    now,
  });
  return { outcome: "applied" };
}

/** Re-export for the router's POST handler (the shared field parser — the
 *  create form's exact field names). */
export { parseMilestoneForm };

/** The full-document render (the render.tsx pattern). */
export function renderMilestoneEditPage(options: {
  ctx: UiContext;
  milestone: MilestoneRow;
  form: NewMilestoneForm;
  error: string | null;
}): string {
  return renderPage(
    <MilestoneEditPage ctx={options.ctx} milestone={options.milestone} form={options.form} error={options.error} />,
  );
}

/** The edit form (§2.4.1 discriminator: `repository new milestone` — the
 *  create form's pageClass, one template upstream). The navbar + the New
 *  Milestone button are the template's PageIsEditMilestone writer arm. */
export function MilestoneEditPage(props: {
  ctx: UiContext;
  milestone: MilestoneRow;
  form: NewMilestoneForm;
  error: string | null;
}) {
  const { ctx } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("MilestoneEditPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const action = `${repoLink}/milestones/${props.milestone.id}/edit`;
  return (
    <BaseLayout ctx={ctx} title={milestoneDetailLocale.edit_milestone} pageClass="repository new milestone" activeTab="issues">
      <div class="ui container">
        <div class="issue-navbar">
          <MilestoneNavbar repoLink={repoLink} />
          {!repo.isArchived ? (
            <div class="ui right">
              <a class="ui primary button" href={`${repoLink}/milestones/new`}>
                {milestonesLocale.new_milestone}
              </a>
            </div>
          ) : null}
        </div>
        <div class="divider" />
        <h2 class="ui dividing header">
          {milestoneDetailLocale.edit_milestone}
          <div class="sub header">{milestoneDetailLocale.edit_subheader}</div>
        </h2>
        <form class="ui form" action={action} method="post">
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
            <a class="ui primary basic button" href={`${repoLink}/milestones`}>
              {milestoneDetailLocale.cancel}
            </a>
            <button type="submit" class="ui primary button">
              {milestoneDetailLocale.modify}
            </button>
          </div>
        </form>
      </div>
    </BaseLayout>
  );
}
