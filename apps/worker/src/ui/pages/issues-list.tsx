/**
 * The issues list page, `/{owner}/{repo}/issues` — and the pulls list,
 * `/{owner}/{repo}/pulls`, which reuses the same component over the same
 * issue rows with `is_pull = 1` (a PR IS an issue row with a `pull_requests`
 * extension, SPEC-0005 §3.2; the pull extension fields — branch pair, CI
 * statuses — are not rendered v1). Pages wave 2 (SPEC-0008 U3 extension).
 *
 * ## DOM contract (templates/repo/issue/list.tmpl + shared/issuelist.tmpl +
 *  shared/issueicon.tmpl + repo/issue/openclose.tmpl at the pin)
 *
 * `.page-content.repository.issue-list` (both lists share the upstream
 * template), `div#issue-list.flex-divided-list.items-with-main` with one
 * `.item` per row (`.item-leading` state glyph + `.item-main` > `.item-header`
 * title + `.labels-list` badges, `.item-body` #index / event line /
 * milestone), `.item-trailing` comment count, the `small-menu-items ui
 * compact tiny menu` open/closed tabs, and the `tw-text-center tw-p-8` empty
 * state.
 *
 * ## Documented v1 degradations (data that has no landed source, §6 method)
 *
 * - PR rows' `.branches` pair (issuelist.tmpl:78-96) landed in the v1.3.2
 *   review-webui window: base + `gitea-double-chevron-left` + head, each a
 *   `/src/branch/{PathEscapeSegments …}` link with `truncated-name` spans —
 *   both hrefs against THIS repo (no forks, so upstream's cross-repo
 *   `OwnerName:` prefix arm is dead); the extension row's branch pair rides
 *   the loader's existing batched PR read. Milestone rows link
 *   `/{repo}/milestone/{id}` with the octicon-milestone mark (the page
 *   landed after this header's plain-text reduction was written — the
 *   stale-note sync).
 * - Poster names anchor the `/{username}` profile since wave 7 (the
 *   dead-link unlock — userLink; plain text before the page existed).
 * - Search box and the label/milestone management buttons are not rendered
 *   (no search route, no management pages — dead links forbidden §2.4.1).
 *   The New Issue button renders like upstream (list.tmpl, unconditional —
 *   wave 4's /issues/new page is live; anonymous viewers land on the authed
 *   page's /login round-trip) and hidden on archived repos (upstream's
 *   `if not .Repository.IsArchived`). The pulls list carries the matching
 *   New Pull Request button (list.tmpl:27) with upstream's three viewer
 *   states: a writer (the canWriteRepository static arms — site admin or
 *   the case-folded owner; the collaborator/team arms need the D1 grant
 *   read this page's fixed loader signature does not carry, so a
 *   write-granted collaborator sees the reader arm — disclosed) renders the
 *   live compare link, a plain signed-in reader upstream's `disabled` class
 *   over the same link (list.tmpl's `{{if not .PullRequestCtx
 *   .CanCreateNewPull}}disabled{{end}}`), and an anonymous viewer the live
 *   `/login?redirect_to=` round-trip onto the compare target (the issue-
 *   detail sign-in convention — upstream renders anon the inert disabled
 *   arm; the round-trip makes the button honest for anon). The archived
 *   pulls list renders the compare-commits button (list.tmpl:31-33,
 *   upstream's exact doubled `small primary small` classes). The
 *   `?labels=` / `?milestone=` FILTERS are wired — the label badges link
 *   into them (upstream QueryBuild parity, reduced to the params this page
 *   actually honors).
 * - Event line timestamp: `createdAt` for open issues, `closedAt` for
 *   closed ones (upstream computes the full last-event timeline; the
 *   denormalized columns carry the same facts for this render). Rendered
 *   through the shared `<relative-time>` component — no timestamps-of-render.
 *
 * State glyphs (the wave-3 tail, restored in wave 4): the row's
 * `.item-leading` slot carries the shared/issueicon.tmpl octicon —
 * octicon-issue-opened/-closed for plain issues (2-path bodies, carried by
 * the multi-path Icon since wave 4) and the single-path PR state machine for
 * pull rows. Merged-vs-closed needs the `pull_requests` extension row, so
 * the loader batch-reads `has_merged` for the page's PR rows (the wave-2
 * batching pattern). The wave-3 icon-allowlist degradation note (text-only
 * state) is retired with the multi-path generator extension.
 *
 * Data comes from the tier-1 service layer directly (§3.2: never a
 * self-fetch): `listRepoIssues` + `milestoneIdsByRepoEntries`
 * (src/api/services/issues.ts) plus three small batched D1 lookups (labels,
 * milestone names, poster names). Anonymous, public repos only — the router
 * resolved the row before this loader runs (§2.5).
 */

import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  hasWorkInProgressPrefix,
  listRepoIssues,
  milestoneIdsByRepoEntries,
  type IssueListFilters,
} from "../../api/services/issues";
import type { IssueRow, LabelRow, MilestoneRow } from "../../issues/service";
import { issueLabels, labels, milestones, pullRequests, users } from "../../db/schema";
import { TimeSince } from "../components/file-list";
import { userLink } from "../links";
import { parsePageNumber, pathEscapeSegments } from "../page-data";
import { compareLink } from "./compare";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** Page chrome text (component-local, the components/commit-list.tsx
 *  pattern — locale.ts is shared and not this wave's file). */
export const issuesLocale = {
  issues: "Issues", // "repo.issues"
  pulls: "Pull Requests", // "repo.pulls"
  open_title: "Open", // "repo.issues.open_title"
  closed_title: "Closed", // "repo.issues.closed_title"
  noResults: "No results", // "repo.issues.filter_no_results"
  noResultsPlaceholder: "Try adjusting your search filters.", // "repo.issues.filter_no_results_placeholder"
  new_issue: "New Issue", // "repo.issues.new" (wave 4: the /issues/new page exists)
  new_pull: "New Pull Request", // "repo.pulls.new" (list.tmpl:27's pulls-tab button)
  compare_commits_general: "Compare commits", // "action.compare_commits_general" (the archived arm, list.tmpl:32)
} as const;

/** Upstream `setting.UI.IssuePagingNum` (modules/setting/ui.go:89). */
export const ISSUES_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Color helpers — upstream modules/util/color.go (RenderLabel text contrast)
// ---------------------------------------------------------------------------

/** `HexToRBGColor` (color.go:14-29): rgb/rrggbb(/+aa) only, else 0,0,0. */
function hexChannels(color: string): [number, number, number] {
  const hexString = color.startsWith("#") ? color.slice(1) : color;
  let six = hexString;
  if (six.length === 3 || six.length === 4) {
    six = six
      .slice(0, 3)
      .split("")
      .map((c) => `${c}${c}`)
      .join("");
  }
  if (six.length === 8) six = six.slice(0, 6);
  if (six.length !== 6) return [0, 0, 0];
  const channel = (at: number): number => Number.parseInt(six.slice(at, at + 2), 16);
  return [channel(0), channel(2), channel(4)];
}

/** `linearizeChannel` (color.go:42-48). */
function linearizeChannel(channel: number): number {
  const srgb = channel / 255;
  if (srgb <= 0.04045) return srgb / 12.92;
  return ((srgb + 0.055) / 1.055) ** 2.4;
}

/** `ContrastColor` (color.go:69-74 via getRelativeLuminance:64-66). */
export function contrastColor(background: string): "#fff" | "#000" {
  const [r, g, b] = hexChannels(background);
  const luminance = 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
  return luminance < 0.36 ? "#fff" : "#000";
}

/** A renderable label color: only the stored `#RRGGBB` shape is trusted;
 *  anything else renders the class-less badge (never break the page). */
function labelColor(raw: string | null): string | null {
  return raw !== null && /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : null;
}

/** `RenderLabel`'s regular-label case (util_render.go:118-121, minus the
 *  emoji pass and the archived variant): the inline-styles badge the Gitea
 *  CSS shapes. Wrapped by the issuelist anchor in the row renderer. */
export function LabelBadge(props: { label: LabelRow }) {
  const color = labelColor(props.label.color);
  return (
    <span
      class="ui label"
      style={color === null ? undefined : `color: ${contrastColor(color)} !important; background-color: ${color} !important;`}
      title={props.label.description ?? ""}
    >
      <span class="gt-ellipsis">{props.label.name}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Data loading (§3.2 direct service calls)
// ---------------------------------------------------------------------------

/** One rendered row's everything (the issue row + its joined badges). */
export interface IssueListItem {
  issue: IssueRow;
  labels: LabelRow[];
  milestone: MilestoneRow | null;
  /** Display-cased poster username; `null` = no poster (mirrored imports). */
  posterName: string | null;
  /** The `pull_requests.has_merged` extension flag — PR rows only (the state
   *  glyph's merged branch, shared/issueicon.tmpl); false for plain issues. */
  prMerged: boolean;
  /** The `pull_requests` branch pair — PR rows only (issuelist.tmpl:78-96's
   *  `.branches` base→head links); null/absent for plain issues, the
   *  sibling row-builders (milestone-detail, the project boards — their
   *  loaders predate the pair and stay at their own posture), and rows whose
   *  extension read missed. Both hrefs resolve against THIS repo: the landed
   *  substrate has no forks, so headRepoId is always the row's own repo
   *  (upstream's cross-repo OwnerName prefix arm is dead here — the
   *  `ne $issue.RepoID …` guards never fire). */
  prBaseBranch?: string | null;
  prHeadBranch?: string | null;
}

/** The issues/pulls page render inputs, loaded by loadIssuesListData. */
export interface IssuesListData {
  listKind: "issues" | "pulls";
  /** The state tab in force — upstream has no "all" tab on this page. */
  state: "open" | "closed";
  page: number;
  items: IssueListItem[];
  /** The filtered open/closed totals behind the tab counts (upstream
   *  OpenCount/ClosedCount — computed over the same label/milestone filter). */
  openCount: number;
  closedCount: number;
  more: boolean;
  /** The active single filter facets, echoed into tab/pagination hrefs. */
  labelIds: number[];
  milestoneId: number | null;
  /** The D1 write grant, set by the index.ts dispatch (canWriteRepo —
   *  collaborator/team arms included) for the pulls arm's CanCreateNewPull
   *  fold; the loader (d1, repoId, …) never sees the viewer, so this stays
   *  undefined for direct-loader callers (the static arms then apply). */
  canWriteIssues?: boolean;
}

/** `?labels=` — comma-separated label ids (upstream stringsToInts split);
 *  non-numeric and non-positive entries are dropped. */
export function parseLabelIds(raw: string | null): number[] {
  if (raw === null) return [];
  return raw
    .split(",")
    .map((entry) => Number.parseInt(entry, 10))
    .filter((entry) => Number.isInteger(entry) && entry > 0);
}

/** `?state=` — anything but "closed" is open (upstream parseStateFilter's
 *  default branch; no "all" tab is rendered, §2.4.1 dead-UI rule). */
export function parseListState(raw: string | null): "open" | "closed" {
  return raw === "closed" ? "closed" : "open";
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Load the list (§3.2): one filtered page read + two 1-row count reads (the
 * tab totals) + one page-batched label join + three batched name/flag
 * lookups (PR flags, milestones, posters).
 */
export async function loadIssuesListData(
  d1: D1Database,
  repoId: string,
  listKind: "issues" | "pulls",
  params: URLSearchParams,
): Promise<IssuesListData> {
  const state = parseListState(params.get("state"));
  const page = parsePageNumber(params.get("page"));
  const labelIds = parseLabelIds(params.get("labels"));

  let milestoneId: number | null = null;
  const milestoneParam = params.get("milestone");
  if (milestoneParam !== null && milestoneParam !== "") {
    // Upstream ListIssues milestone filter: name first, numeric id fallback.
    const ids = await milestoneIdsByRepoEntries(d1, repoId, [milestoneParam]);
    milestoneId = ids[0] ?? null;
  }

  const filters: IssueListFilters = {
    isClosed: state === "closed",
    isPull: listKind === "pulls",
    keyword: "",
    labelIds,
    milestoneIds: milestoneId === null ? [] : [milestoneId],
    since: null,
    before: null,
    page,
    limit: ISSUES_PAGE_SIZE,
  };

  const db = drizzle(d1);
  const [listPage, openPage, closedPage] = await Promise.all([
    listRepoIssues(d1, repoId, filters),
    listRepoIssues(d1, repoId, { ...filters, isClosed: false, page: 1, limit: 1 }),
    listRepoIssues(d1, repoId, { ...filters, isClosed: true, page: 1, limit: 1 }),
  ]);

  // One batched label join for the whole page (issueLabelRows' per-row
  // select reduced to a single inArray read — the same loader's PR-flags
  // pattern). Grouped in memory; the asc(labels.id) orderBy preserves
  // issueLabelRows' per-issue badge order exactly, and issues carry each
  // label once, so bucket order is the join order.
  const labelsByIssue = new Map<number, LabelRow[]>();
  const pageIssueIds = listPage.items.map((issue) => issue.id);
  if (pageIssueIds.length > 0) {
    const rows = await db
      .select({ issueId: issueLabels.issueId, label: labels })
      .from(issueLabels)
      .innerJoin(labels, eq(labels.id, issueLabels.labelId))
      .where(inArray(issueLabels.issueId, pageIssueIds))
      .orderBy(asc(labels.id))
      .all();
    for (const row of rows) {
      const bucket = labelsByIssue.get(row.issueId);
      if (bucket === undefined) labelsByIssue.set(row.issueId, [row.label]);
      else bucket.push(row.label);
    }
  }

  const items: IssueListItem[] = listPage.items.map((issue) => ({
    issue,
    labels: labelsByIssue.get(issue.id) ?? [],
    milestone: null,
    posterName: null,
    prMerged: false,
    prBaseBranch: null,
    prHeadBranch: null,
  }));

  // Batched PR extension flags + branch pair for the is_pull rows (the state
  // glyph's merged branch AND issuelist.tmpl:78-96's `.branches` links — one
  // read for the whole page, the wave-2 pattern).
  const pullIds = items.filter((item) => item.issue.isPull).map((item) => item.issue.id);
  if (pullIds.length > 0) {
    const rows = await db
      .select({
        issueId: pullRequests.issueId,
        hasMerged: pullRequests.hasMerged,
        baseBranch: pullRequests.baseBranch,
        headBranch: pullRequests.headBranch,
      })
      .from(pullRequests)
      .where(inArray(pullRequests.issueId, pullIds))
      .all();
    const byIssue = new Map(rows.map((row) => [row.issueId, row]));
    for (const item of items) {
      const extension = byIssue.get(item.issue.id);
      item.prMerged = extension?.hasMerged ?? false;
      item.prBaseBranch = extension?.baseBranch ?? null;
      item.prHeadBranch = extension?.headBranch ?? null;
    }
  }

  // Batched milestone names (unique ids across the page).
  const milestoneIds = [...new Set(items.map((item) => item.issue.milestoneId).filter((id): id is number => id !== null))];
  if (milestoneIds.length > 0) {
    const rows = await db.select().from(milestones).where(inArray(milestones.id, milestoneIds)).all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const item of items) {
      item.milestone = item.issue.milestoneId === null ? null : (byId.get(item.issue.milestoneId) ?? null);
    }
  }

  // Batched poster display names.
  const posterIds = [...new Set(items.map((item) => item.issue.posterId).filter((id): id is number => id !== null))];
  if (posterIds.length > 0) {
    const rows = await db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, posterIds)).all();
    const byId = new Map(rows.map((row) => [row.id, row.username]));
    for (const item of items) {
      item.posterName = item.issue.posterId === null ? null : (byId.get(item.issue.posterId) ?? null);
    }
  }

  return {
    listKind,
    state,
    page,
    items,
    openCount: openPage.total,
    closedCount: closedPage.total,
    more: page * ISSUES_PAGE_SIZE < listPage.total,
    labelIds,
    milestoneId,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The canonical list URL for one state + filter set (state=open is the
 *  default and never emitted; page resets — upstream QueryBuild tabs). */
function listHref(basePath: string, state: "open" | "closed", labelIds: number[], milestoneId: number | null, page?: number): string {
  const params = new URLSearchParams();
  if (state === "closed") params.set("state", "closed");
  if (labelIds.length > 0) params.set("labels", labelIds.join(","));
  if (milestoneId !== null) params.set("milestone", String(milestoneId));
  if (page !== undefined && page > 1) params.set("page", String(page));
  const query = params.toString();
  return query === "" ? basePath : `${basePath}?${query}`;
}

/** The open/closed tab menu (repo/issue/openclose.tmpl — the Open tab
 *  carries the list's own state glyph, octicon-git-pull-request on the pulls
 *  list and octicon-issue-opened on issues; the Closed tab always
 *  octicon-issue-closed). The wave-3 icon degradation note is retired with
 *  the wave-4 multi-path Icon. */
export function OpenCloseTabs(props: {
  basePath: string;
  state: "open" | "closed";
  openCount: number;
  closedCount: number;
  labelIds: number[];
  milestoneId: number | null;
  openTitle: string;
  closedTitle: string;
  /** Which open-tab glyph the list carries (upstream `.PageIsPullList`). */
  pullList: boolean;
}) {
  const tab = (count: number, title: string): string => {
    return count === 1 ? `1 ${title}` : `${count} ${title}`;
  };
  return (
    <div class="small-menu-items ui compact tiny menu">
      <a
        class={props.state === "open" ? "active item flex-text-inline" : "item flex-text-inline"}
        href={listHref(props.basePath, "open", props.labelIds, props.milestoneId)}
      >
        <Icon name={props.pullList ? "octicon-git-pull-request" : "octicon-issue-opened"} />{" "}
        {tab(props.openCount, props.openTitle)}
      </a>
      <a
        class={props.state === "closed" ? "active item flex-text-inline" : "item flex-text-inline"}
        href={listHref(props.basePath, "closed", props.labelIds, props.milestoneId)}
      >
        <Icon name="octicon-issue-closed" /> {tab(props.closedCount, props.closedTitle)}
      </a>
    </div>
  );
}

/** The Older/Newer pagination — the commits page's DOM shape
 *  (div.center.page.buttons), driven by `page * size < total`. */
export function IssuesPagination(props: {
  basePath: string;
  state: "open" | "closed";
  labelIds: number[];
  milestoneId: number | null;
  page: number;
  more: boolean;
}) {
  if (props.page <= 1 && !props.more) return null;
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a
            class="item navigation"
            href={listHref(props.basePath, props.state, props.labelIds, props.milestoneId, props.page - 1)}
          >
            <span class="navigation_label">Newer</span>
          </a>
        ) : null}
        {props.more ? (
          <a
            class="item navigation"
            href={listHref(props.basePath, props.state, props.labelIds, props.milestoneId, props.page + 1)}
          >
            <span class="navigation_label">Older</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The event line: "opened {time} by {poster}" / "closed {time} …" — the
 *  upstream GetLastEventLabel facts from the denormalized columns (header
 *  comment). Wave 7 (the dead-link unlock): the poster anchors the
 *  `/{username}` profile (upstream issuelist.tmpl's poster link shape). */
function EventLine(props: { item: IssueListItem }) {
  const { issue } = props.item;
  const event = issue.isClosed
    ? (issue.closedAt ?? issue.updatedAt ?? issue.createdAt)
    : (issue.createdAt ?? issue.updatedAt);
  return (
    <div class="flex-text-inline">
      {issue.isClosed ? "closed" : "opened"}{" "}
      {event !== null ? <TimeSince unixSeconds={unixSeconds(event)} tz="+0000" /> : null}
      {props.item.posterName !== null ? (
        <>
          {" "}by <a href={userLink(props.item.posterName)}>{props.item.posterName}</a>
        </>
      ) : null}
    </div>
  );
}

/** The shared/issueicon.tmpl state glyph with its `getIssueIcon` color
 *  classes (16px, like upstream's `{{svg … 16}}` calls): the PR state
 *  machine (merged → merge-purple, closed → closed-red, WIP → draft-grey,
 *  open → green) over the plain-issue open/closed pair. */
export function IssueStateIcon(props: { item: IssueListItem; size?: number }) {
  const { issue, prMerged } = props.item;
  if (issue.isPull) {
    if (issue.isClosed) {
      return prMerged ? (
        <Icon name="octicon-git-merge" size={props.size ?? 16} class="tw-text-purple" />
      ) : (
        <Icon name="octicon-git-pull-request-closed" size={props.size ?? 16} class="tw-text-red" />
      );
    }
    if (hasWorkInProgressPrefix(issue.title)) {
      return <Icon name="octicon-git-pull-request-draft" size={props.size ?? 16} class="tw-text-text-light" />;
    }
    return <Icon name="octicon-git-pull-request" size={props.size ?? 16} class="tw-text-green" />;
  }
  return issue.isClosed ? (
    <Icon name="octicon-issue-closed" size={props.size ?? 16} class="tw-text-red" />
  ) : (
    <Icon name="octicon-issue-opened" size={props.size ?? 16} class="tw-text-green" />
  );
}

/** One `.item` row of shared/issuelist.tmpl (degradations: header comment). */
function IssueListItemRow(props: { repoLink: string; item: IssueListItem }) {
  const { item } = props;
  const href = `${props.repoLink}/issues/${item.issue.index}`;
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
                  <a
                    class="item"
                    href={`?state=${item.issue.isClosed ? "closed" : "open"}&labels=${label.id}`}
                  >
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
          <EventLine item={item} />
          {item.prBaseBranch && item.prHeadBranch ? (
            <div class="branches flex-text-inline">
              <div class="branch">
                <a href={`${props.repoLink}/src/branch/${pathEscapeSegments(item.prBaseBranch)}`}>
                  <span class="truncated-name">{item.prBaseBranch}</span>
                </a>
              </div>
              <Icon name="gitea-double-chevron-left" size={12} />
              <div class="branch">
                <a href={`${props.repoLink}/src/branch/${pathEscapeSegments(item.prHeadBranch)}`}>
                  <span class="truncated-name">{item.prHeadBranch}</span>
                </a>
              </div>
            </div>
          ) : null}
          {item.milestone !== null ? (
            <a class="milestone flex-text-inline tw-max-w-[300px]" href={`${props.repoLink}/milestone/${item.milestone.id}`}>
              <Icon name="octicon-milestone" size={14} />
              <span class="gt-ellipsis">{item.milestone.name}</span>
            </a>
          ) : null}
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

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderIssuesListPage(ctx: UiContext, data: IssuesListData): string {
  return renderPage(<IssuesListPage ctx={ctx} data={data} />);
}

/**
 * The `PullRequestCtx.CanCreateNewPull` reduction: the static grant arms
 * (site admin via `is_admin`, the repo owner via the case-folded namespace
 * fold) OR the dispatch-threaded D1 grant (`data.canWriteIssues`, set by the
 * index.ts dispatch from canWriteRepo — the collaborator-row and §3.5 team
 * arms). Anonymous is the caller's arm (the login round-trip link), never
 * this predicate.
 */
export function viewerCanCreatePull(ctx: UiContext, canWriteRepoGrant?: boolean): boolean {
  const { viewer, repo } = ctx;
  if (viewer.kind !== "user" || repo === undefined) return false;
  return (
    canWriteRepoGrant === true ||
    viewer.isAdmin ||
    repo.ownerNamespace.toLowerCase() === viewer.username.toLowerCase()
  );
}

/** The issues/pulls list page (§2.4.1 discriminator: `repository
 *  issue-list` — upstream's shared list template serves both lists).
 *  activeTab stays the shell default: the tab strip renders only landed
 *  pages (Code/Commits) until the shell's owner extends RepoTab. */
export function IssuesListPage(props: { ctx: UiContext; data: IssuesListData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("IssuesListPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const basePath = data.listKind === "pulls" ? `${repoLink}/pulls` : `${repoLink}/issues`;
  const title = data.listKind === "pulls" ? issuesLocale.pulls : issuesLocale.issues;
  // PullRequestCtx.MakeDefaultCompareLink .Repository.DefaultBranch for the
  // same-repo head (services/context/repo.go:83-87 — baseRepo.Link() +
  // /compare/ + the PR-unit DefaultTargetBranch ... the head ref; the PR-unit
  // config is unlanded so the target IS the default branch, and
  // CompareHeadRef folds the same-repo head to the bare branch name).
  const compareHref = compareLink(repoLink, repo.defaultBranch, repo.defaultBranch);
  return (
    <BaseLayout ctx={ctx} title={title} pageClass="repository issue-list">
      <div class="ui container">
        {/* The list-header row's creation button (list.tmpl:19-35, reduced to
            the live link — the search box and the Labels/Milestones buttons
            above it stay unrendered, header comment). Issues arm: the New
            Issue button, hidden on archived repos — the upstream `if not
            .Repository.IsArchived` gate; anonymous viewers clicking it land
            on the authed page's /login round-trip. Pulls arm: list.tmpl:27's
            New Pull Request button over the compare target — writers live,
            plain signed-in readers the upstream `disabled` class over the
            same link, anonymous the /login round-trip onto the compare page
            (upstream renders anon the inert disabled arm; the round-trip is
            the issue-detail sign-in convention); the archived twin carries
            list.tmpl:31-33's Compare-commits button with its exact doubled
            `small primary small` classes. */}
        {data.listKind === "issues" && !repo.isArchived ? (
          <div class="list-header flex-text-block">
            <a class="ui small primary button issue-list-new" href={`${repoLink}/issues/new`}>
              {issuesLocale.new_issue}
            </a>
          </div>
        ) : null}
        {data.listKind === "pulls" ? (
          <div class="list-header flex-text-block">
            {repo.isArchived ? (
              <a class="ui small primary small button issue-list-new" href={compareHref}>
                {issuesLocale.compare_commits_general}
              </a>
            ) : ctx.viewer.kind === "anonymous" ? (
              <a
                class="ui small primary button new-pr-button issue-list-new"
                href={`/login?redirect_to=${encodeURIComponent(compareHref)}`}
              >
                {issuesLocale.new_pull}
              </a>
            ) : (
              <a
                class={
                  viewerCanCreatePull(ctx, data.canWriteIssues)
                    ? "ui small primary button new-pr-button issue-list-new"
                    : "ui small primary button new-pr-button issue-list-new disabled"
                }
                href={compareHref}
              >
                {issuesLocale.new_pull}
              </a>
            )}
          </div>
        ) : null}
        <div class="issue-list-toolbar-left">
          <OpenCloseTabs
            basePath={basePath}
            state={data.state}
            openCount={data.openCount}
            closedCount={data.closedCount}
            labelIds={data.labelIds}
            milestoneId={data.milestoneId}
            openTitle={issuesLocale.open_title}
            closedTitle={issuesLocale.closed_title}
            pullList={data.listKind === "pulls"}
          />
        </div>
        {data.items.length === 0 ? (
          <div class="tw-text-center tw-p-8">
            <h3 class="tw-my-4">{issuesLocale.noResults}</h3>
            <p class="tw-text-placeholder-text">{issuesLocale.noResultsPlaceholder}</p>
          </div>
        ) : (
          <div id="issue-list" class="flex-divided-list items-with-main">
            {data.items.map((item) => (
              <IssueListItemRow repoLink={repoLink} item={item} />
            ))}
          </div>
        )}
        <IssuesPagination
          basePath={basePath}
          state={data.state}
          labelIds={data.labelIds}
          milestoneId={data.milestoneId}
          page={data.page}
          more={data.more}
        />
      </div>
    </BaseLayout>
  );
}
