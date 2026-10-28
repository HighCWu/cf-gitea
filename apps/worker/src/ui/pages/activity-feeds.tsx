/**
 * The user profile ACTIVITY tab, `/{username}?tab=activity` — pages wave 50
 * (bench row `wave-feeds-module`; MOUNTED at b1bf73a —
 * `ownerHomePage`'s user arm calls this module's load + render under the
 * tab param, the mount record's recipe verbatim).
 *
 * ## Mount record (MOUNTED at b1bf73a — the wiring HANDOFF is retired)
 *
 * - The page module is complete end-to-end: `resolveActivityFeeds` (the
 *   owner seam), `loadActivityFeedsData` (the data seam) and
 *   `renderActivityFeedsPage` (the full-document render). The route arm is
 *   `GET /{username}` with `tab=activity`: resolve → load → render, the
 *   owner-projects pattern (pages/owner-projects.tsx).
 * - The owner seam returns the FULL owner union (org | user | redirect |
 *   missing) because upstream hangs the tab inside `OwnerProfile`'s dispatch
 *   (routers/web/user/profile.go:37-52): a USER name runs `userProfile` →
 *   `prepareUserProfileTabData`'s `case "activity"` (profile.go:162-190) →
 *   tplProfile; an ORG name runs `org.Home`, which IGNORES `?tab=activity`
 *   and serves the org home. So the handler dispatches: `kind === "org"` →
 *   `renderOrgHomePage` (pages/org-home.tsx — the org home renders no
 *   activity arm upstream, templates/org/home.tmpl has no feeds include),
 *   `kind === "user"` → THIS page, redirect → 307, missing → the 404 shell.
 * - The viewer comes from `resolveViewer` (the SPEC-0010 seam) and rides the
 *   UiContext; the loader takes it directly (no route-side projection).
 *
 * ## Upstream shape (cited)
 *
 * `templates/user/profile.tmpl:10-17` — the `.TabName == "activity"` branch
 * inside the profile grid (four-wide avatar column + twelve-wide column
 * carrying `user/overview/header`): the `KeepActivityPrivate` info message
 * (`user.disabled_public_activity`), then `user/heatmap` (NOT rendered — no
 * heatmap pipeline on our side, the `/-/heatmap` route is an unclaimed tail,
 * the org-repos header's tail note), then `user/dashboard/feeds.tmpl`. The
 * handler arm (profile.go:162-190): `date = FormString("date")`,
 * `pagingNum = setting.UI.FeedPagingNum` (= 20, modules/setting/ui.go:93),
 * `showPrivate = IsSigned && (admin || self)`, `OnlyPerformedBy: true`,
 * `feed_service.GetFeedsForDashboard` over the requested user, and the pager
 * (`WithUnlimitedPaging` — the FIXME-acknowledged extra-row quirk; reduced
 * to the landed Older/Newer pair on `page * size < total`, the org-home
 * convention).
 *
 * `user/dashboard/feeds.tmpl` — the feed-item DOM (the pin's exact rows):
 * `#activity-feed.flex-divided-list.items-with-main[data-ref-issue-container]`
 * with one `.item` per action: `.item-leading` carries
 * `ctx.AvatarUtils.AvatarByAction` (an `<img class="ui avatar
 * tw-align-middle" width=28 height=28>` — the avatar-slot placeholder rule
 * renders the person octicon, no avatar pipeline); `.item-main.tw-gap-2`
 * carries the message line (the actor link — `.GetActUserName | PathEscape`
 * with `title="{.GetActDisplayNameTitle}"`, then the per-type locale
 * message, then `DateUtils.TimeSince .GetCreate`) and the per-type content
 * arm; `.item-trailing` carries
 * `{{svg (printf "octicon-%s" (ActionIcon .GetOpType)) 32 "tw-text-text-light
 * tw-mr-1"}}`.
 *
 * ## The type→icon/message matrix (the wired set)
 *
 * Rows exist ONLY for the op types the landed emitters write
 * (specs/activity-feeds.md §3.3 + the since-landed seams) — 14 distinct
 * wired op types: create_repo, rename_repo, create_issue,
 * create_pull_request, comment_issue, merge_pull_request, close_issue,
 * reopen_issue, close_pull_request, reopen_pull_request,
 * approve_pull_request, reject_pull_request, comment_pull, publish_release
 * (producers: services/repo-events.ts, services/issue-events.ts,
 * routes/pulls.ts:446-453, routes/releases.ts:270-274; the brief's "15"
 * rounds the same set — the SPEC's wired matrix is the authority). The
 * message arms port `feeds.tmpl:14-83` +
 * `options/locale/locale_en-US.json:3500-3529`; the icons port `ActionIcon`
 * (modules/templates/util_misc.go:71-108). Anything outside the wired set
 * degrades EXACTLY like upstream's own fall-through: no message arm (the
 * if-chain has no default branch) and the `octicon-question` default icon.
 * A future wave extending the emitter matrix extends both matrices in the
 * same change.
 *
 * Icon allowlist degradations (the generated set is wave-owned —
 * scripts/gen-ui-icons.mjs is NOT this wave's file; each cites its
 * precedent):
 * - comment_issue/comment_pull: upstream `octicon-comment-discussion` →
 *   `octicon-pencil` (the pull-reviews octicon-comment stand-in precedent);
 * - reopen_issue/reopen_pull_request: upstream `octicon-issue-reopened` →
 *   `octicon-issue-opened` (the issue-detail.tsx:1054 precedent);
 * - reject_pull_request: upstream `octicon-file-diff` →
 *   `octicon-git-pull-request-closed` (the pull-reviews reject-glyph
 *   precedent);
 * - the default: upstream `octicon-question` → `octicon-info`.
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The overview header (user/overview/header.tmpl) renders its two LIVE
 *   tabs only — Repositories (`?tab=repositories`, upstream header.tmpl:12's
 *   exact href; the landed profile page answers the query by ignoring it,
 *   upstream's no-readme default-tab rule profile.go:84-101) and Activity
 *   (header.tmpl:33-34, ACTIVE here). Packages/Code/Projects/Stars need
 *   their owner-scoped surfaces (rendering a tab whose page the route has
 *   not claimed is a dead link, §2.4.1). The strip is module-local — OrgMenu
 *   has no activity slot and org-home.tsx is not this wave's file (the
 *   wave-37 extension pattern, kept local).
 * - The Activity tab's upstream glyph is `octicon-rss` — not in the
 *   generated set; `octicon-history` (the timeline/clock glyph) stands in.
 * - The actor avatar renders the placeholder octicon in a 28px `ui avatar`
 *   span (the avatar-slot rule; upstream AvatarHTML —
 *   modules/templates/util_avatar.go:31-36 — carries
 *   `class="ui avatar tw-align-middle" width=28 height=28` and the display
 *   name as title; the span keeps the class pair + title).
 * - `GetActDisplayName` resolves through `setting.UI.DefaultShowFullName`
 *   (false at the pin — the modules/setting/ui.go zero value): the link
 *   text is the username and the tooltip the full name
 *   (`GetActDisplayNameTitle`, models/activities/action.go:226-231).
 * - `ShortRepoPath`/`ShortActUserName` trims port as a code-point ellipsis
 *   (owner ≤ 20, name ≤ 33, username ≤ 20 —
 *   models/activities/action.go:230-297; upstream guesses CJK display
 *   width, ours counts code points — display sugar over ASCII-restricted
 *   names).
 * - The comment-excerpt arm renders through the SHARED markdown service in
 *   its context-less "markdown" mode (upstream `FeedExcerptToHtml`,
 *   modules/templates/util_render.go:207-209 — the FeedExcerpt flattening
 *   is not landed; the raw body ships per specs/activity-feeds.md §4 and
 *   ours escapes raw HTML, SPEC-0008 §3.4).
 * - Issue-title text renders plain (upstream `RenderIssueSimpleTitle` adds
 *   emoji + code spans — util_render.go:98-102; no emoji pipeline landed).
 * - `GetIssueTitle`'s failure literals port verbatim: index ≤ 0 →
 *   "<Issue not found>", a missing row → "<500 when get issue>"
 *   (models/activities/action.go:386-403).
 * - The heatmap template arm is not rendered (no pipeline — the header
 *   note).
 *
 * ## Data (§3.2 — the landed service, never a self-fetch)
 *
 * The loader consumes `getFeedRows` + `renderFeedItems`
 * (src/api/services/activity-feeds.ts) with the handler's exact parameters,
 * then batches the two lookups the template helpers need over the page:
 * coordinates → TEXT repo id (the Activity payload renders `repo_id`
 * NUMERIC — crypto.randomUUID TEXT keys render 0 — so the issue-title join
 * goes through repositories.ownerNamespace/slug), and the live issue titles
 * for the GetIssueTitle arms (the service's `feedIssueTitles` — both the
 * repo and index filters ride the (repo_id, index) unique index, the
 * query-shape audit's C2).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { feedIssueTitles, getFeedRows, renderFeedItems, type Activity } from "../../api/services/activity-feeds";
import { listFollowers, listFollowing } from "../../api/services/follows";
import { renderMarkdownToHtml } from "../../api/services/markdown";
import type { Viewer as ApiViewer } from "../../api/services/repository";
import type { OrgRecord } from "../../services/orgs/orgs";
import { repositories } from "../../db/schema";
import { TimeSince } from "../components/file-list";
import type { IconName } from "../icons";
import { parsePageNumber } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { Viewer } from "../viewer";
import type { UiContext } from "../ui-context";
import { EyeIcon } from "./user-watching-tab";
import { resolveOrgHome } from "./org-home";
import {
  ProfileAvatarCard,
  resolveUserProfile,
  userDisplayName,
  type ProfileDoer,
  type UserProfileRow,
} from "./user-profile";

/** Page chrome text (component-local, the orgHomeLocale pattern — locale.ts
 *  is shared and not this wave's file; upstream locale keys cited). */
export const activityFeedsLocale = {
  repositories: "Repositories", // "user.repositories"
  activity: "Public Activity", // "user.activity"
  starred: "Starred Repositories", // "user.starred" (header.tmpl:38)
  watched: "Watched Repositories", // "user.watched" (header.tmpl:45)
  disabled_public_activity: "This user has disabled the public visibility of the activity.", // "user.disabled_public_activity"
  newer: "Newer", // the base/paginate reduction's navigation_label (OrgHomePagination shape)
  older: "Older",
} as const;

/** Upstream `setting.UI.FeedPagingNum` (modules/setting/ui.go:93) — the
 *  activity tab's page size (profile.go:168 reads it directly). */
export const ACTIVITY_FEEDS_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// The matrix — pure, exported for the tests (the loader decorates with these)
// ---------------------------------------------------------------------------

/** The arms whose message/body render the LIVE issue title
 *  (`GetIssueTitle` — models/activities/action.go:386-403). */
const LIVE_TITLE_OP_TYPES: ReadonlySet<Activity["op_type"]> = new Set([
  "comment_issue",
  "approve_pull_request",
  "reject_pull_request",
  "comment_pull",
  "close_issue",
  "reopen_issue",
  "close_pull_request",
  "reopen_pull_request",
] as Activity["op_type"][]);

/**
 * `ActionIcon` (modules/templates/util_misc.go:71-108) over the wired set,
 * with the header's four allowlist degradations; everything outside the
 * wired set falls to the default arm (upstream `octicon-question`, :107-108).
 */
export function feedIconName(opType: Activity["op_type"]): IconName {
  switch (opType) {
    case "create_repo": // ActionCreateRepo
    case "rename_repo": // ActionRenameRepo
      return "octicon-repo"; // util_misc.go:74-76 (transfer_repo shares the arm — unwired)
    case "create_issue":
      return "octicon-issue-opened"; // :81
    case "create_pull_request":
      return "octicon-git-pull-request"; // :82
    case "merge_pull_request":
      return "octicon-git-merge"; // :83-84
    case "close_issue":
      return "octicon-issue-closed"; // :87-88
    case "reopen_issue": // :89-90
    case "reopen_pull_request":
      return "octicon-issue-reopened"; // exact (allowlist +5, ec07fb6 follow-up)
    case "comment_issue": // :85-86
    case "comment_pull":
      return "octicon-comment-discussion"; // exact
    case "close_pull_request":
      return "octicon-git-pull-request-closed"; // :79-80
    case "approve_pull_request":
      return "octicon-check"; // :91-92
    case "reject_pull_request": // :93-94
      return "octicon-file-diff"; // exact
    case "publish_release":
      return "octicon-tag"; // :95-96 (push_tag/delete_tag share it — unwired)
    default:
      return "octicon-question"; // :107-108 — exact
  }
}

/** One message segment: plain text, an anchor, or a `<code>` span — the
 *  three shapes the upstream locale strings compose
 *  (locale_en-US.json:3500-3529). */
export type FeedMessageSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; href: string; text: string }
  | { kind: "code"; text: string };

/** The per-type content arm below the message line (feeds.tmpl:86-123). */
export type FeedBody =
  | { kind: "issue-title"; title: string } // the span.issue-title arm — create
  // arms carry the content-stored title, close/reopen arms the live one
  | { kind: "comment"; href: string; title: string; excerptHtml: string | null } // the
  // GetCommentLink + FeedExcerptToHtml arm
  | { kind: "merge-title"; title: string }; // merge's div.item-body arm

/** The loader's per-item projection — the Activity payload reshaped into
 *  exactly what the render reads (every field resolved; the component is
 *  pure). */
export interface ActivityFeedItem {
  readonly id: number;
  readonly opType: Activity["op_type"];
  /** GetActDisplayName — the username (DefaultShowFullName=false). */
  readonly actorName: string;
  /** GetActDisplayNameTitle — the full name (blank when unset). */
  readonly actorTitle: string;
  /** `{{AppSubUrl}}/{{GetActUserName | PathEscape}}`. */
  readonly actorHref: string;
  /** GetRepoLink — `/{owner}/{name}`, each segment PathEscape'd. */
  readonly repoHref: string;
  /** ShortRepoPath — the 20/33-ellipsized `owner/name`. */
  readonly shortRepoPath: string;
  /** GetCreate as unix seconds (the TimeSince input). */
  readonly createdUnix: number;
  readonly refName: string;
  readonly content: string;
  /** getIssueIndex — ParseInt(GetIssueInfos[0]), 0 on junk. */
  readonly issueIndex: number;
  /** GetIssueTitle for the live-title arms — the exact upstream literal
   *  ("<Issue not found>" / "<500 when get issue>") when the row is absent;
   *  "" when the arm does not read it. */
  readonly liveIssueTitle: string;
  /** The live comment's html_url (GetCommentLink's Comment.Link arm); null
   *  when the comment row is gone → the Issue.Link fallback / "#". */
  readonly liveCommentUrl: string | null;
  /** feedIconName(opType). */
  readonly icon: IconName;
  /** feedMessageSegments(item) — null outside the wired set. */
  readonly message: FeedMessageSegment[] | null;
  /** feedBody(item) — null when the op type carries no content arm. */
  readonly body: FeedBody | null;
}

/** The render inputs `feedIconName`/`feedMessageSegments`/`feedBody` read
 *  (the ActivityFeedItem minus the derived trio). */
export type ActivityFeedItemFields = Omit<ActivityFeedItem, "icon" | "message" | "body">;

/**
 * `GetIssueInfos` (models/activities/action.go:376-383): Go
 * `strings.SplitN(content, "|", 3)` — the first two separators split, the
 * remainder stays in the third element (JS `split(sep, 3)` would DROP the
 * remainder instead).
 */
export function issueInfos(content: string): [string, string, string] {
  const first = content.indexOf("|");
  if (first < 0) return [content, "", ""];
  const head = content.slice(0, first);
  const rest = content.slice(first + 1);
  const second = rest.indexOf("|");
  if (second < 0) return [head, rest, ""];
  return [head, rest.slice(0, second), rest.slice(second + 1)];
}

/** `getIssueIndex` (action.go:386-391): ParseInt(infos[0]) — junk → 0. */
export function issueIndexOf(content: string): number {
  const raw = issueInfos(content)[0];
  return /^\d+$/.test(raw) ? Number(raw) : 0;
}

/** Upstream `util.EllipsisDisplayString` reduced to code-point counting:
 *  over the limit → the first limit-1 code points + "…" (truncate.go:50-53
 *  guarantees ≤ limit runes; ours skips the CJK width guess — the header's
 *  reduction note). */
export function ellipsisDisplay(value: string, limit: number): string {
  const chars = Array.from(value);
  if (chars.length <= limit) return value;
  return `${chars.slice(0, Math.max(limit - 1, 1)).join("")}…`;
}

/** `GetTag` (action.go:352-354): RefName stripped of the tag prefix. */
function tagOf(refName: string): string {
  return refName.startsWith("refs/tags/") ? refName.slice("refs/tags/".length) : refName;
}

/**
 * The message line's per-type segments — feeds.tmpl:14-83's if-chain over
 * the wired set with the exact locale strings
 * (options/locale/locale_en-US.json:3500-3529; each arm cites its key).
 * Null outside the wired set: upstream's chain has NO default branch, so an
 * unknown op type renders the actor + TimeSince only.
 */
export function feedMessageSegments(item: ActivityFeedItemFields): FeedMessageSegment[] | null {
  const text = (value: string): FeedMessageSegment => ({ kind: "text", text: value });
  const link = (href: string, display: string): FeedMessageSegment => ({ kind: "link", href, text: display });
  const repoLink = link(item.repoHref, item.shortRepoPath); // (.GetRepoLink ctx) (.ShortRepoPath ctx)
  const index = issueInfos(item.content)[0]; // upstream renders the RAW string, not the parsed int
  const issueLink = (kind: "issues" | "pulls", label: string): FeedMessageSegment[] => [
    text(label),
    link(`${item.repoHref}/${kind}/${index}`, `${item.shortRepoPath}#${index}`),
  ];
  switch (item.opType) {
    case "create_repo": // "action.create_repo"
      return [text("created repository "), repoLink];
    case "rename_repo": // "action.rename_repo" — GetContent = the old name
      return [text("renamed repository from "), { kind: "code", text: item.content }, text(" to "), repoLink];
    case "create_issue": // "action.create_issue"
      return issueLink("issues", "opened issue ");
    case "create_pull_request": // "action.create_pull_request"
      return issueLink("pulls", "created pull request ");
    case "comment_issue": // "action.comment_issue"
      return issueLink("issues", "commented on issue ");
    case "merge_pull_request": // "action.merge_pull_request"
      return issueLink("pulls", "merged pull request ");
    case "close_issue": // "action.close_issue"
      return issueLink("issues", "closed issue ");
    case "reopen_issue": // "action.reopen_issue"
      return issueLink("issues", "reopened issue ");
    case "close_pull_request": // "action.close_pull_request"
      return issueLink("pulls", "closed pull request ");
    case "reopen_pull_request": // "action.reopen_pull_request"
      return issueLink("pulls", "reopened pull request ");
    case "approve_pull_request": // "action.approve_pull_request"
      return issueLink("pulls", "approved ");
    case "reject_pull_request": // "action.reject_pull_request"
      return issueLink("pulls", "suggested changes for ");
    case "comment_pull": // "action.comment_pull"
      return issueLink("pulls", "commented on pull request ");
    case "publish_release": {
      // "action.publish_release": released <a tag>{Content}</a> at
      // <a repo>{path}</a> — $linkText is Content | RenderEmoji upstream;
      // plain text here (the header's degradation note).
      const tag = tagOf(item.refName);
      return [
        text("released "),
        link(`${item.repoHref}/releases/tag/${tag}`, item.content),
        text(" at "),
        repoLink,
      ];
    }
    default:
      return null;
  }
}

/**
 * The content arm — feeds.tmpl:86-123 over the wired set. `issue-title`:
 * create arms carry the content-stored title (infos[1], :105-108), the
 * close/reopen family the live `GetIssueTitle` (:118-119) — both render the
 * same `span.tw-inline-block.tw-truncate.issue.title`. `comment`: the
 * GetCommentLink anchor + the non-empty infos[1] excerpt through
 * FeedExcerptToHtml (:109-115). `merge-title`: infos[1] in the
 * `div.item-body.tw-text-text` (:116-117). Null when the type has no arm.
 */
export function feedBody(item: ActivityFeedItemFields): FeedBody | null {
  const infos = issueInfos(item.content);
  switch (item.opType) {
    case "create_issue":
    case "create_pull_request":
      return { kind: "issue-title", title: infos[1] };
    case "close_issue":
    case "reopen_issue":
    case "close_pull_request":
    case "reopen_pull_request":
      return { kind: "issue-title", title: item.liveIssueTitle };
    case "merge_pull_request":
      return { kind: "merge-title", title: infos[1] };
    case "comment_issue":
    case "approve_pull_request":
    case "reject_pull_request":
    case "comment_pull": {
      // GetCommentLink (action.go:317-338): live comment → Comment.Link;
      // else Issue.Link() when the issue LOADS; a failed/absent load
      // (missing row, or index ≤ 0 → no load attempted) → "#". The loader
      // encodes the load outcome in liveIssueTitle's literals.
      const issueLoaded =
        item.issueIndex > 0 && item.liveIssueTitle !== "<500 when get issue>" && item.liveIssueTitle !== "<Issue not found>";
      const href =
        item.liveCommentUrl ?? (issueLoaded ? `${item.repoHref}/${item.opType === "comment_issue" ? "issues" : "pulls"}/${infos[0]}` : "#");
      const excerpt =
        infos[1] !== ""
          ? renderMarkdownToHtml({ text: infos[1], mode: "markdown", context: "", wiki: false, origin: "" })
          : null;
      return { kind: "comment", href, title: item.liveIssueTitle, excerptHtml: excerpt };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Resolution — the handler-side seam (the owner-projects pattern)
// ---------------------------------------------------------------------------

/** The resolution outcome for the `/{username}` owner: upstream
 *  `OwnerProfile`'s dispatch (profile.go:37-52) — an org name serves the
 *  org home (which ignores `tab=activity`), a user name the profile family
 *  this page belongs to. */
export type ActivityFeedsResolution =
  | { kind: "org"; org: OrgRecord }
  | { kind: "user"; user: UserProfileRow }
  | { kind: "redirect"; location: string }
  | { kind: "missing" };

/**
 * Resolve the owner for `/{username}?tab=activity`: the org half first
 * (`resolveOrgHome` — renamed orgs 307, invisible orgs 404-shell, the
 * OrgAssignment seam), then the user half (`resolveUserProfile` — the
 * userAssignment + RedirectToUser + IsUserVisibleToViewer ladder, the
 * landed profile page's exact seam). The route dispatches on the union
 * (the header's mount record).
 */
export async function resolveActivityFeeds(
  d1: D1Database,
  owner: string,
  doer: ProfileDoer,
  requestPath: string,
  requestQuery: string,
): Promise<ActivityFeedsResolution> {
  const org = await resolveOrgHome(d1, owner, doer, requestPath, requestQuery);
  if (org.kind !== "missing") return org;
  return resolveUserProfile(d1, owner, doer, requestPath, requestQuery);
}

// ---------------------------------------------------------------------------
// Data loading (§3.2 — the landed service arms, never a self-fetch)
// ---------------------------------------------------------------------------

/** The activity page's render inputs. */
export interface ActivityFeedsData {
  user: UserProfileRow;
  items: ActivityFeedItem[];
  page: number;
  /** The unpaginated total (getFeedRows' count — the pager's bound). */
  total: number;
  more: boolean;
  /** The `?date=YYYY-MM-DD` passthrough (unparsable input never reaches
   *  the query — the service's FeedDateCond warn-and-continue). */
  date: string;
  /** `users.visibility = 'private'` — the landed keep_activity_private
   *  mapping (specs/activity-feeds.md §3.4): the profile.tmpl:11-15 info
   *  message shows regardless of the viewer, exactly upstream. */
  keepActivityPrivate: boolean;
  /** The overview header's Repositories count (the profile loader's
   *  doer-visible WHERE — loadHeaderCount parity). */
  repoCount: number;
  followers: number;
  following: number;
}

/** The api `Viewer` projection of the session viewer (the owner-projects
 *  projectsApiUser shape — three fields, the rest optional). */
function feedsApiUser(viewer: Viewer, origin: string): ApiViewer {
  return {
    origin,
    requester:
      viewer.kind === "user" ? { id: viewer.id, login: viewer.username, is_admin: viewer.isAdmin } : null,
  };
}

/**
 * Load the page (profile.go:162-190's arm): the feed page through the
 * landed service (`getFeedRows` + `renderFeedItems` — IncludePrivate =
 * signed ∧ (admin ∨ self), OnlyPerformedBy = true, FeedPagingNum = 20),
 * then the two batched lookups the template helpers need: TEXT repo ids by
 * owner/slug coordinates (the Activity payload's `repo_id` renders numeric
 * — TEXT keys render 0) and the live issue titles for the GetIssueTitle
 * arms through the service's `feedIssueTitles` (the C2 consolidation — the
 * page's own select is gone); finally the avatar-card + tab counts.
 */
export async function loadActivityFeedsData(
  d1: D1Database,
  user: UserProfileRow,
  viewer: Viewer,
  origin: string,
  params: URLSearchParams,
): Promise<ActivityFeedsData> {
  const page = parsePageNumber(params.get("page"));
  const date = params.get("date") ?? "";
  const viewerId = viewer.kind === "user" ? viewer.id : null;
  const viewerIsAdmin = viewer.kind === "user" ? viewer.isAdmin : false;
  const includePrivate = viewerId !== null && (viewerIsAdmin || viewerId === user.id);

  const { total, rows } = await getFeedRows(d1, {
    kind: "user",
    requested: { id: user.id },
    actor: viewerId === null ? null : { id: viewerId, isAdmin: viewerIsAdmin },
    includePrivate,
    onlyPerformedBy: true,
    date: date === "" ? undefined : date,
    page,
    limit: ACTIVITY_FEEDS_PAGE_SIZE,
  });

  const activities = await renderFeedItems(d1, feedsApiUser(viewer, origin), rows);

  // coordinates → TEXT repositories.id (the numeric-payload join note).
  const coordinates = [
    ...new Set(
      activities.map((activity) => `${activity.repo?.owner?.login ?? ""}/${activity.repo?.name ?? ""}`),
    ),
  ].filter((key) => key !== "/");
  const repoIdByCoordinates = new Map<string, string>();
  if (coordinates.length > 0) {
    const namespaces = [...new Set(coordinates.map((key) => key.slice(0, key.indexOf("/"))))];
    const repoRows = await drizzle(d1)
      .select({ id: repositories.id, ownerNamespace: repositories.ownerNamespace, slug: repositories.slug })
      .from(repositories)
      .where(inArray(repositories.ownerNamespace, namespaces))
      .all();
    for (const row of repoRows) {
      const key = `${row.ownerNamespace}/${row.slug}`;
      if (coordinates.includes(key)) repoIdByCoordinates.set(key, row.id);
    }
  }

  // The GetIssueTitle arms: the service's batched title read over the
  // page's (repoId, index) pairs (≤ page size pairs — the D1 bind cap is
  // far). The page-local select this replaced read EVERY issue of the
  // referenced repos and post-filtered (the query-shape audit's C2); the
  // consolidated shape filters both columns through the (repo_id, index)
  // unique index.
  const titleKeys = new Map<string, { repoId: string; index: number }>();
  for (const activity of activities) {
    if (!LIVE_TITLE_OP_TYPES.has(activity.op_type)) continue;
    const repoId = repoIdByCoordinates.get(`${activity.repo?.owner?.login ?? ""}/${activity.repo?.name ?? ""}`);
    const index = issueIndexOf(activity.content);
    if (repoId !== undefined && index > 0) titleKeys.set(`${repoId}#${index}`, { repoId, index });
  }
  const titles = await feedIssueTitles(d1, titleKeys.values());

  const items: ActivityFeedItem[] = activities.map((activity) => {
    const ownerLogin = activity.repo?.owner?.login ?? "";
    const name = activity.repo?.name ?? "";
    const index = issueIndexOf(activity.content);
    // GetIssueTitle (action.go:386-403): index ≤ 0 skips the load →
    // "<Issue not found>"; a missing row is the load error →
    // "<500 when get issue>". Non-live arms never read it ("").
    let liveIssueTitle = "";
    if (LIVE_TITLE_OP_TYPES.has(activity.op_type)) {
      if (index <= 0) {
        liveIssueTitle = "<Issue not found>";
      } else {
        const repoId = repoIdByCoordinates.get(`${ownerLogin}/${name}`);
        liveIssueTitle =
          repoId === undefined ? "<500 when get issue>" : titles.get(`${repoId}#${index}`) ?? "<500 when get issue>";
      }
    }
    const base: ActivityFeedItemFields = {
      id: activity.id,
      opType: activity.op_type,
      actorName: ellipsisDisplay(activity.act_user?.login ?? "", 20),
      actorTitle: activity.act_user?.full_name ?? "",
      actorHref: `/${encodeURIComponent(activity.act_user?.login ?? "")}`,
      repoHref: `/${encodeURIComponent(ownerLogin)}/${encodeURIComponent(name)}`,
      shortRepoPath: `${ellipsisDisplay(ownerLogin, 20)}/${ellipsisDisplay(name, 33)}`,
      createdUnix: Math.floor(Date.parse(activity.created) / 1000),
      refName: activity.ref_name,
      content: activity.content,
      issueIndex: index,
      liveIssueTitle,
      liveCommentUrl: activity.comment?.html_url ?? null,
    };
    return {
      ...base,
      icon: feedIconName(base.opType),
      message: feedMessageSegments(base),
      body: feedBody(base),
    };
  });

  // The overview header's Repositories count (the profile loader's
  // doer-visible WHERE — the owner themself/admin sees private rows).
  const repoWhere =
    viewerId !== null && (viewerIsAdmin || viewerId === user.id)
      ? eq(repositories.ownerId, user.id)
      : and(eq(repositories.ownerId, user.id), eq(repositories.visibility, "public"));
  const repoCountRow = await drizzle(d1)
    .select({ total: sql<number>`count(*)` })
    .from(repositories)
    .where(repoWhere)
    .get();

  const followViewer = { id: viewerId, isAdmin: viewerIsAdmin };
  const [followers, following] = await Promise.all([
    listFollowers(d1, user.id, followViewer, { page: 1, pageSize: 1 }),
    listFollowing(d1, user.id, followViewer, { page: 1, pageSize: 1 }),
  ]);

  return {
    user,
    items,
    page,
    total,
    more: page * ACTIVITY_FEEDS_PAGE_SIZE < total,
    date,
    keepActivityPrivate: user.visibility === "private",
    repoCount: Number(repoCountRow?.total ?? 0),
    followers: followers.total,
    following: following.total,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The message line's segments (the FeedMessageSegment union → DOM). */
function FeedMessageSegments(props: { segments: FeedMessageSegment[] }) {
  return (
    <>
      {props.segments.map((segment, i) =>
        segment.kind === "link" ? (
          <a key={i} href={segment.href}>
            {segment.text}
          </a>
        ) : segment.kind === "code" ? (
          <code key={i}>{segment.text}</code>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/** The per-type content arm (the FeedBody union → the feeds.tmpl DOM). */
function FeedItemBody(props: { item: ActivityFeedItem }) {
  const body = props.item.body;
  if (body === null) return null;
  switch (body.kind) {
    case "issue-title":
      return <span class="tw-inline-block tw-truncate issue title">{body.title}</span>;
    case "merge-title":
      return <div class="item-body tw-text-text">{body.title}</div>;
    case "comment":
      return (
        <>
          <a href={body.href} class="tw-inline-block tw-truncate tw-max-w-full tw-self-start issue title">
            {body.title}
          </a>
          {body.excerptHtml !== null ? (
            <div class="render-content markup" dangerouslySetInnerHTML={{ __html: body.excerptHtml }} />
          ) : null}
        </>
      );
  }
}

/**
 * One feeds.tmpl `.item` row (the header's DOM contract): the actor avatar
 * placeholder in `.item-leading`, the message line (actor link → title
 * tooltip, the per-type message, TimeSince) and the content arm in
 * `.item-main`, the 32px action glyph in `.item-trailing`.
 */
export function ActivityFeedListItem(props: { item: ActivityFeedItem }) {
  const { item } = props;
  return (
    <div class="item">
      <div class="item-leading">
        <span class="ui avatar tw-align-middle" title={item.actorTitle} aria-hidden="true">
          <Icon name="octicon-person" size={28} />
        </span>
      </div>
      <div class="item-main tw-gap-2">
        <div>
          <a href={item.actorHref} title={item.actorTitle}>
            {item.actorName}
          </a>{" "}
          {item.message !== null ? <FeedMessageSegments segments={item.message} /> : null}{" "}
          <TimeSince unixSeconds={item.createdUnix} tz="+0000" />
        </div>
        <FeedItemBody item={item} />
      </div>
      <div class="item-trailing">
        <Icon name={item.icon} size={32} class="tw-text-text-light tw-mr-1" />
      </div>
    </div>
  );
}

/** The feeds container (feeds.tmpl:1-131 minus the base/paginate include —
 *  the pager is the sibling component): upstream renders the container
 *  even when empty (no empty-state arm in the template). */
export function ActivityFeedList(props: { items: ActivityFeedItem[] }) {
  return (
    <div id="activity-feed" class="flex-divided-list items-with-main" data-ref-issue-container>
      {props.items.map((item) => (
        <ActivityFeedListItem item={item} />
      ))}
    </div>
  );
}

/** The overview header (user/overview/header.tmpl reduced to its live
 *  tabs — the header's degradation note; module-local because OrgMenu has
 *  no activity slot and org-home.tsx is not this wave's file). The Activity
 *  anchor is ACTIVE here; Stars (header.tmpl:36-44) and watching
 *  (header.tmpl:43-46) render INACTIVE — the collapsed-if rule: upstream
 *  swaps Stars→watching under DisableStars (default false), the landed
 *  strips ship BOTH anchors and never mark either active on this page. */
function OverviewTabs(props: { username: string; repoCount: number }) {
  return (
    <overflow-menu class="ui secondary pointing tabular borderless menu">
      <div class="overflow-menu-items">
        <a class="item" href={`/${props.username}?tab=repositories`}>
          <Icon name="octicon-repo" /> {activityFeedsLocale.repositories}
          {props.repoCount > 0 ? <div class="ui small label">{props.repoCount}</div> : null}
        </a>
        <a class="active item" href={`/${props.username}?tab=activity`}>
          <Icon name="octicon-rss" /> {activityFeedsLocale.activity}
        </a>
        <a class="item" href={`/${props.username}?tab=stars`}>
          <Icon name="octicon-star" /> {activityFeedsLocale.starred}
        </a>
        <a class="item" href={`/${props.username}?tab=watching`}>
          <EyeIcon /> {activityFeedsLocale.watched}
        </a>
      </div>
    </overflow-menu>
  );
}

/** The pager — base/paginate.tmpl reduced to the Older/Newer pair (the
 *  org-home convention), carrying `tab=activity`, the active `date` and
 *  `page`. */
function ActivityFeedsPager(props: { username: string; page: number; more: boolean; date: string }) {
  const href = (page: number): string => {
    const params = new URLSearchParams();
    params.set("tab", "activity");
    if (props.date !== "") params.set("date", props.date);
    if (page > 1) params.set("page", String(page));
    const query = params.toString();
    return `/${props.username}${query === "" ? "" : `?${query}`}`;
  };
  if (props.page <= 1 && !props.more) return null;
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={href(props.page - 1)}>
            <span class="navigation_label">{activityFeedsLocale.newer}</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={href(props.page + 1)}>
            <span class="navigation_label">{activityFeedsLocale.older}</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the
 *  component). */
export function renderActivityFeedsPage(ctx: UiContext, data: ActivityFeedsData): string {
  return renderPage(<ActivityFeedsPage ctx={ctx} data={data} />);
}

/** The profile activity tab (profile.tmpl's grid + the `tab == "activity"`
 *  branch: §2.4.1 discriminator `user profile`). */
export function ActivityFeedsPage(props: { ctx: UiContext; data: ActivityFeedsData }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={userDisplayName(data.user)} pageClass="user profile">
      <div class="ui container">
        <div class="ui stackable grid">
          <div class="ui four wide column">
            <ProfileAvatarCard user={data.user} followers={data.followers} following={data.following} />
          </div>
          <div class="ui twelve wide column tw-mb-4">
            <OverviewTabs username={data.user.username} repoCount={data.repoCount} />
            {data.keepActivityPrivate ? (
              <div class="ui info message">
                <p>{activityFeedsLocale.disabled_public_activity}</p>
              </div>
            ) : null}
            <ActivityFeedList items={data.items} />
            <ActivityFeedsPager
              username={data.user.username}
              page={data.page}
              more={data.more}
              date={data.date}
            />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
