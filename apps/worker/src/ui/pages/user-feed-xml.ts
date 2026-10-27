/**
 * The `/{username}.rss` + `/{username}.atom` user-feed envelopes — pages
 * wave 74 (bench row `wave-rss-atom`, UNMOUNTED — `index.ts` is
 * orchestrator/sibling-owned; the HANDOFF NOTE below carries the mount
 * recipe). Byte surfaces over the landed activity-feed service (never a
 * self-fetch): no JSX, the two XML documents are composed as strings with
 * the exact Go serializer semantics upstream ships.
 *
 * ## HANDOFF NOTE (for the wiring wave)
 *
 * - Upstream has NO dedicated feed route: web.go:910-912 registers
 *   `m.Get("/{username}", webAuth.AllowBasic, user.UsernameSubRoute)` and
 *   `UsernameSubRoute` (routers/web/user/home.go:705-745) suffix-dispatches
 *   `.png`/`.keys`/`.gpg`/`.rss`/`.atom` on the raw path segment, strips the
 *   suffix, re-runs UserAssignmentWeb, and calls `feed.ShowUserFeedRSS` /
 *   `feed.ShowUserFeedAtom` (routers/web/feed/profile.go:20-26). The
 *   web.go:910 comment: "it handles "username.rss" in the handler, so allow
 *   basic auth as other rss/atom routes". The Accept-header dispatch
 *   (`OwnerProfile`, routers/web/user/profile.go:35-45) is UNREGISTERED at
 *   the pin — the suffix families are the only user-feed entry points.
 * - Mount recipe in `resolveUiRoute`'s single-segment owner arm (the block
 *   that already refuses `.keys`/`.gpg`, index.ts:~2081-2089), BEFORE the
 *   `.keys`/`.gpg` refusal (order is irrelevant — disjoint suffixes; the
 *   suffix dispatch must win over the bare owner-home claim so a feed URL
 *   can never 404 into the profile):
 *
 *     const lower = owner.toLowerCase();
 *     if (lower.endsWith(".rss")) return { family: "user-feed-rss", owner: owner.slice(0, -4) };
 *     if (lower.endsWith(".atom")) return { family: "user-feed-atom", owner: owner.slice(0, -5) };
 *
 *   (Upstream matches the suffix on the RAW segment — case-sensitive
 *   `strings.HasSuffix`; the landed `.keys`/`.gpg` arm lowercases. Match the
 *   landed family rule — lowercased — so the whole UsernameSubRoute suffix
 *   family keeps one rule on our side; a user literally named "foo.rss" is
 *   unreachable on either side: the suffix dispatch runs first, upstream's
 *   own chi-781 WORKAROUND comment in home.go:706-708.)
 * - The route arm: resolve the stripped owner through
 *   `resolveActivityFeeds` (pages/activity-feeds.tsx — the org-then-user
 *   seam, visibility gated exactly like the page tab) and dispatch:
 *   `user` → `loadUserFeedData(d1, { kind: "user", ...row }, viewer, origin,
 *   query)` → `renderUserFeedRss` / `renderUserFeedAtom` (by family) →
 *   `new Response(body, { headers: { "Content-Type":
 *   USER_FEED_CONTENT_TYPES.rss / .atom } })`; `org` → the same with the org
 *   row (upstream `showUserFeed` serves orgs too — profile.go:33; the
 *   org-member `includePrivate` arm lives in the loader); `redirect` → 307
 *   to `location` (the seam's replace keeps the `.rss`/`.atom` tail in
 *   place); `missing` → the 404 shell.
 *
 * ## Upstream shape (cited — gitea/routers/web/feed/profile.go)
 *
 * `showUserFeed(ctx, formatType)` (:28-104): 404 unless `EnableFeed` (the
 * pin default is TRUE — modules/setting/other.go:21) and the owner is
 * visible (`IsUserVisibleToViewer` / `HasOrgOrUserVisible` — the resolution
 * seam's ladders); `includePrivate = IsSigned && (admin || self)` plus the
 * org-member arm (:44-53); `GetFeeds{RequestedUser, Actor, IncludePrivate,
 * OnlyPerformedBy: !isOrganisation, IncludeDeleted: false, Date:
 * FormString("date")}` (:55-62) — no page param; the zero ListOptions falls
 * to page 1 × `setting.API.DefaultPagingNum` (30 —
 * models/db/list.go:64-74 + modules/setting/api.go:19); the channel fields
 * (:85-91): Title = `TrString("home.feed_of", DisplayName)` →
 * `Feed of "alice"` (locale_en-US.json:344), Link = the user HTMLURL,
 * Description = the markdown-rendered bio
 * (`NewRenderContextSimpleDocument` + `RenderString` :76-84), Created =
 * `time.Now()`; then `feedActionsToFeedItems` (convert.go:64-213) and
 * `writeFeed` (:94-104) — content type `application/atom+xml;charset=utf-8`
 * or `application/rss+xml;charset=utf-8`.
 *
 * The serializer is gorilla/feeds v1.2.0 (go.mod:51): `Feed.WriteRss` /
 * `WriteAtom` → `encoding/xml` MarshalIndent with two-space indent (the
 * header written WITHOUT its trailing newline). The element maps below were
 * verified byte-for-byte against a Go program carrying the vendored struct
 * tags (rss.go/atom.go v1.2.0 verbatim) run at this task's scratch:
 *
 *   RSS: `<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">`
 *   → `<channel>` → title, link, description (ALWAYS present, even empty —
 *   no omitempty), pubDate (RFC1123Z of Created = now; LastBuildDate is
 *   omitempty over the zero Updated → absent; no generator/author elements —
 *   the handler sets neither) → `<item>` per action: title, link,
 *   description (always), `content:encoded` CDATA (only when non-empty),
 *   author (the display NAME only — newRssItem :126-128), guid with
 *   `isPermaLink="false"` (IsPermaLink set by convert.go:207), pubDate
 *   (RFC1123Z of the action's CreatedUnix) → `</channel></rss>`.
 *
 *   Atom: `<feed xmlns="http://www.w3.org/2005/Atom">` → title, id (= the
 *   feed link href — AtomFeed() :152-160), updated (RFC3339 of Created =
 *   now), subtitle (= the rendered bio, omitempty), `<link href=…></link>`
 *   (rel "" → omitempty) → `<entry>` per action: title, updated (RFC3339),
 *   id, `content type="html"` (omitempty), `<link href=… rel="alternate">`,
 *   `summary type="html"` (= the description, omitempty), author
 *   (`<name>`/`<email>` — present when either is non-empty) → `</feed>`.
 *
 *   Both: empty elements marshal as PAIRED tags (`<link …></link>`, NOT
 *   self-closing); text/attr escaping per encoding/xml EscapeText (`&`→
 *   `&amp;`, `<`→`&lt;`, `>`→`&gt;`, `'`→`&#39;`, `"`→`&#34;`, and the
 *   whitespace set `\t`→`&#x9;`, `\n`→`&#xA;`, `\r`→`&#xD;` — newlines in
 *   multi-line descriptions really do render as `&#xA;`); CDATA bodies are
 *   raw with Go's `]]>` split (`]]]]><![CDATA[>`); NO trailing newline.
 *
 * ## The item projection (convert.go feedActionsToFeedItems over the wired set)
 *
 * The message locale arms (the 14-type wired matrix, specs/activity-feeds.md
 * §3.3 authority — the page module's own rule: a future emitter wave extends
 * both matrices in the same change) compose the item title as
 * `HTMLEscapeString(displayName + " ") + titleExtra` where titleExtra is the
 * locale string with every string argument `template.HTMLEscapeString`'d
 * (TrHTML — modules/translation/i18n/localestore.go:156-170; the locale
 * markup itself stays raw). The item link starts at `GetCommentHTMLURL`
 * (action.go:298-315: live comment → Comment.HTMLURL, else the loaded
 * issue's HTMLURL by `IsPull`, else "#") and the per-type arms override /
 * fall back exactly as convert.go's switch does. Description/content arms:
 * create_issue/create_pull_request → `Join(GetIssueInfos(), "#")` (the
 * infos TRIPLE is padded to 3 — action.go:376-383 — so a 2-field content
 * joins a trailing "#") + the issue BODY rendered as the content;
 * comment_issue/approve/reject/comment_pull → the live issue title + "\n\n"
 * + the rendered excerpt; merge → infos[1]; close/reopen → the live issue
 * title; create_repo/rename_repo/publish_release → no arm (both empty).
 * `if len(content) == 0 { content = markup.Sanitize(desc) }`.
 *
 * ## Documented v1 reductions (the §6 method)
 *
 * - `GetEmail` (user.go:247-252) returns the `{name}@{noreply}` placeholder
 *   behind `KeepEmailPrivate` — the column is not landed and the landed API
 *   posture hides emails behind "" (api/services/repository.ts:230-246), so
 *   the author email is the row's nullable email verbatim; when it renders
 *   "" the Atom `<email>` element drops (omitempty) and the RSS `<author>`
 *   drops with it (newRssItem copies only the Name).
 * - `GetDisplayName` resolves through `setting.UI.DefaultShowFullName`
 *   (user.go:485-493; the pin default FALSE — modules/setting/ui.go) → the
 *   username; the hook is kept as a constant for the day the setting lands.
 * - `markup.Sanitize(desc)` is reduced to `desc` verbatim: the only descs
 *   that carry HTML embed OUR markdown output, which is XSS-safe by
 *   construction (markdown-it `html: false` — SPEC-0008 §3.4, the landed
 *   sanitizer posture); plain-text descs pass a whitelist sanitizer
 *   unchanged either way.
 * - The excerpt/body render uses the page module's exact context-less
 *   "markdown" call (activity-feeds.tsx:418) — upstream's repo-comment
 *   context with `UseAbsoluteLink(true)` + FeedExcerpt flattening is the
 *   landed module's §6 note verbatim.
 * - Times format in UTC (`+0000` / `Z`): upstream `AsTime()` renders in the
 *   server zone, UTC in every Gitea deployment default
 *   (setting.DefaultUILocation empty → time.Local → UTC containers).
 * - encoding/xml replaces invalid UTF-8 with U+FFFD — D1 TEXT is valid
 *   UTF-8, so `escapeXmlText`'s table stops at the whitespace set.
 * - The feed author (channel-level) is never set upstream (profile.go
 *   :85-91 sets only Title/Link/Description/Created) → no managingEditor /
 *   feed-level author elements on either envelope.
 * - The unwired op types (anything outside the 14) hit convert.go's default
 *   arm (:196-197): `return nil, fmt.Errorf("unknown action type: %v", …)`
 *   — the WHOLE feed fails. Ported verbatim as a throw; unreachable over
 *   the landed emitter set (only the wired 14 are written), exactly like
 *   upstream where the closed ActionType enum covers the switch.
 */

import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";

import {
  getFeedRows,
  renderFeedItems,
  type Activity,
} from "../../api/services/activity-feeds";
import { renderMarkdownToHtml } from "../../api/services/markdown";
import type { Viewer as ApiViewer } from "../../api/services/repository";
import { issues, orgMembers, repositories } from "../../db/schema";
import type { Viewer } from "../viewer";
import { ellipsisDisplay, issueIndexOf, issueInfos } from "./activity-feeds";

// ---------------------------------------------------------------------------
// Go serializer parity — escaping + time formats
// ---------------------------------------------------------------------------

/** `encoding/xml` `EscapeText` (Go 1.x) — the attr AND chardata table, the
 *  whitespace set included (newlines marshal as `&#xA;` inside both). */
const XML_TEXT_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&#34;",
  "\t": "&#x9;",
  "\n": "&#xA;",
  "\r": "&#xD;",
};

/** Escape one XML text/attribute value (every chardata and attr in both
 *  envelopes; CDATA bodies are the one exception — raw, see `cdataBody`). */
export function escapeXmlText(value: string): string {
  return value.replace(/[&<>'"\t\n\r]/g, (ch) => XML_TEXT_ESCAPES[ch] ?? ch);
}

/** `html/template.HTMLEscapeString` — the table Go's htmlReplacementTable
 *  ships (verified against the toolchain: NUL → U+FFFD, `+` → `&#43;`,
 *  `=` → `&#61;`). This is the escaper `Locale.TrHTML` applies to every
 *  string argument AND the one convert.go applies to the actor name. */
const HTML_TEMPLATE_ESCAPES: Record<string, string> = {
  "\0": "\uFFFD",
  '"': "&#34;",
  "&": "&amp;",
  "'": "&#39;",
  "+": "&#43;",
  "<": "&lt;",
  "=": "&#61;",
  ">": "&gt;",
};

export function escapeHtmlTemplate(value: string): string {
  return value.replace(/[\0"&'+<=>]/g, (ch) => HTML_TEMPLATE_ESCAPES[ch] ?? ch);
}

/** Go's `,cdata` marshal: the body stays RAW, each `]]>` split into
 *  `]]]]><![CDATA[>` (verified against the toolchain). */
export function cdataBody(value: string): string {
  return value.split("]]>").join("]]]]><![CDATA[>");
}

const RFC1123Z_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const RFC1123Z_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** Go `time.RFC1123Z` (`Mon, 02 Jan 2006 15:04:05 -0700`) in UTC — the RSS
 *  channel pubDate and every item pubDate (rss.go:106/:134-135). */
export function formatRfc1123z(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const day = RFC1123Z_DAYS[date.getUTCDay()] ?? "Sun";
  const month = RFC1123Z_MONTHS[date.getUTCMonth()] ?? "Jan";
  return (
    `${day}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/** Go `time.RFC3339` (`2006-01-02T15:04:05Z07:00`) in UTC — the Atom
 *  updated timestamps (atom.go:99/:122/:147). RFC3339 has no fraction; JS
 *  toISOString' millis are stripped. */
export function formatRfc3339(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// The feeds.Item projection (convert.go:64-213 over the wired 14-type set)
// ---------------------------------------------------------------------------

/** `setting.UI.DefaultShowFullName` — the pin's zero value
 *  (modules/setting/ui.go); `GetDisplayName` (user.go:485-493) only prefers
 *  the trimmed full name when it is set. */
const DEFAULT_SHOW_FULL_NAME = false;

/** The live-issue lookups the projection reads (the loaded `*Issue`):
 *  `title` for GetIssueTitle, `isPull` for Issue.HTMLURL's path,
 *  `content` (the body) for GetIssueContent. Keyed
 *  `{ownerLogin}/{repoName}#{index}` — the coordinates the Activity payload
 *  carries (TEXT repo ids render numeric 0 — the page module's join note). */
export type FeedIssueLookups = Map<string, { title: string; isPull: boolean; content: string }>;

const ISSUE_NOT_FOUND = "<Issue not found>"; // GetIssueTitle, index ≤ 0 (LoadIssue no-op → nil Issue)
const ISSUE_LOAD_FAILED = "<500 when get issue>"; // GetIssueTitle, index > 0 + missing row (GetIssueByIndex error)
const CONTENT_NOT_FOUND = "<Content not found>"; // GetIssueContent's nil-Issue arm

/** `GetIssueTitle` (action.go:400-408) over the lookups. */
function liveIssueTitle(lookups: FeedIssueLookups, key: string, index: number): string {
  if (index <= 0) return ISSUE_NOT_FOUND; // LoadIssue skips the load, Issue stays nil
  const row = lookups.get(key);
  return row === undefined ? ISSUE_LOAD_FAILED : row.title;
}

/** `GetIssueContent` (action.go:411-420) over the lookups. */
function liveIssueContent(lookups: FeedIssueLookups, key: string, index: number): string {
  if (index <= 0) return CONTENT_NOT_FOUND;
  const row = lookups.get(key);
  return row === undefined ? ISSUE_LOAD_FAILED : row.content;
}

/** `Action.GetBranch` (action.go:338-341): TrimPrefix "refs/heads/" — the
 *  tag prefix is NOT stripped (toReleaseLink's feed link therefore reads
 *  `/releases/tag/refs/tags/v1` for a tag action; the upstream quirk is
 *  ported verbatim — the TEMPLATE's message arm uses GetTag and is the
 *  page module's different, correct arm). */
function feedBranchOf(refName: string): string {
  return refName.startsWith("refs/heads/") ? refName.slice("refs/heads/".length) : refName;
}

/** `util.PathEscapeSegments` (modules/util/url.go:12-18): split on "/",
 *  `url.PathEscape` each segment, rejoin. */
function pathEscapeSegments(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** The upstream feeds.Item — exactly the fields gorilla's serializer reads
 *  (feed.go:28-40) that convert.go sets (:200-211). */
export interface UserFeedItem {
  /** `HTMLEscapeString(displayName + " ") + titleExtra` (raw HTML — the
   *  envelopes XML-escape it again, upstream's own double-encode). */
  readonly title: string;
  /** The item link href (GetCommentHTMLURL ladder + the per-type arms). */
  readonly link: string;
  /** The description arm (RSS `<description>` / Atom `<summary>`). */
  readonly description: string;
  /** The content arm (RSS `content:encoded` CDATA / Atom `<content>`); ""
   *  renders no element on either envelope. */
  readonly content: string;
  /** Author.Name = GetDisplayName; Author.Email = the row email (the
   *  landed API posture — the module header's reduction note). */
  readonly authorName: string;
  readonly authorEmail: string;
  /** `fmt.Sprintf("%v: %v", act.ID, link.Href)` (convert.go:208). */
  readonly id: string;
  /** `IsPermaLink: "false"` (convert.go:207) — every item. */
  readonly isPermaLink: "false";
  /** `act.CreatedUnix.AsTime()` as unix seconds. */
  readonly createdUnix: number;
}

/** One activity → one feeds.Item, element-for-element vs convert.go's
 *  composer (the wired 14-type set; the default arm throws — the header's
 *  parity note). `origin` is the AppURL stand-in for the absolute links. */
export function feedItemFromActivity(
  activity: Activity,
  origin: string,
  issueLookups: FeedIssueLookups,
): UserFeedItem {
  // GetDisplayName (username at the pin) + GetEmail (the landed posture).
  const actUser = activity.act_user;
  const actorName = actUser?.login ?? "";
  const actorEmail = actUser?.email ?? "";

  // GetRepoAbsoluteLink (action.go:286-288): AppURL + PathEscape'd segments.
  const ownerLogin = activity.repo?.owner?.login ?? "";
  const repoName = activity.repo?.name ?? "";
  const repoHref = `${origin}/${encodeURIComponent(ownerLogin)}/${encodeURIComponent(repoName)}`;
  // ShortRepoPath (action.go:273-277) — the 20/33-ellipsized display path.
  const shortRepoPath = `${ellipsisDisplay(ownerLogin, 20)}/${ellipsisDisplay(repoName, 33)}`;

  const infos = issueInfos(activity.content); // the Go-padded triple (action.go:376-383)
  const rawIndex = infos[0] ?? ""; // upstream renders infos[0] as the RAW string
  const index = issueIndexOf(activity.content); // ParseInt parity (junk → 0)
  const lookupKey = `${ownerLogin}/${repoName}#${index}`;
  const liveIssue = issueLookups.get(lookupKey);

  // GetCommentHTMLURL (action.go:298-315): live comment → Comment.HTMLURL;
  // else the loaded issue's HTMLURL (path by IsPull); else "#".
  const issueUrl =
    liveIssue === undefined
      ? null
      : `${repoHref}/${liveIssue.isPull ? "pulls" : "issues"}/${index}`;
  let link = activity.comment?.html_url ?? (issueUrl ?? "#");

  const issueLink = `${repoHref}/issues/${encodeURIComponent(rawIndex)}`; // toIssueLink
  const pullLink = `${repoHref}/pulls/${encodeURIComponent(rawIndex)}`; // toPullLink
  // toReleaseLink — GetBranch does NOT strip the tag prefix (the quirk note).
  const releaseLink = `${repoHref}/releases/tag/${pathEscapeSegments(feedBranchOf(activity.ref_name))}`;

  // The title arm — the locale strings (locale_en-US.json:3500-3529) with
  // every string argument template.HTMLEscapeString'd (TrHTML), then glued
  // behind the escaped actor name. convert.go:70-197's exact arms.
  const esc = escapeHtmlTemplate;
  let titleExtra: string;
  switch (activity.op_type) {
    case "create_repo": // "action.create_repo" — link.Href = repo link
      link = repoHref;
      titleExtra = `created repository <a href="${esc(repoHref)}">${esc(shortRepoPath)}</a>`;
      break;
    case "rename_repo": // "action.rename_repo" — GetContent = the old name
      link = repoHref;
      titleExtra = `renamed repository from <code>${esc(activity.content)}</code> to <a href="${esc(repoHref)}">${esc(shortRepoPath)}</a>`;
      break;
    case "create_issue":
      link = issueLink;
      titleExtra = `opened issue <a href="${esc(issueLink)}">${esc(shortRepoPath)}#${esc(rawIndex)}</a>`;
      break;
    case "create_pull_request":
      link = pullLink;
      titleExtra = `created pull request <a href="${esc(pullLink)}">${esc(shortRepoPath)}#${esc(rawIndex)}</a>`;
      break;
    case "comment_issue": {
      // convert.go:110-113 — the issue link only rescues a "#" base.
      if (link === "#") link = issueLink;
      titleExtra = `commented on issue <a href="${esc(issueLink)}">${esc(shortRepoPath)}#${esc(rawIndex)}</a>`;
      break;
    }
    case "merge_pull_request": {
      if (link === "#") link = pullLink;
      titleExtra = `merged pull request <a href="${esc(pullLink)}">${esc(shortRepoPath)}#${esc(rawIndex)}</a>`;
      break;
    }
    case "close_issue": {
      if (link === "#") link = issueLink;
      titleExtra = `closed issue <a href="${esc(issueLink)}">${esc(shortRepoPath)}#${esc(rawIndex)}</a>`;
      break;
    }
    case "reopen_issue": {
      if (link === "#") link = issueLink;
      titleExtra = `reopened issue <a href="${esc(issueLink)}">${esc(shortRepoPath)}#${esc(rawIndex)}</a>`;
      break;
    }
    case "close_pull_request": {
      if (link === "#") link = pullLink;
      titleExtra = `closed pull request <a href="${esc(pullLink)}">${esc(shortRepoPath)}#${esc(rawIndex)}</a>`;
      break;
    }
    case "reopen_pull_request": {
      if (link === "#") link = pullLink;
      titleExtra = `reopened pull request <a href="${esc(pullLink)}">${esc(shortRepoPath)}#${esc(rawIndex)}</a>`;
      break;
    }
    case "approve_pull_request": // convert.go:163-165 — NO link.Href arm
      titleExtra = `approved <a href="${esc(pullLink)}">${esc(shortRepoPath)}#${esc(rawIndex)}</a>`;
      break;
    case "reject_pull_request":
      titleExtra = `suggested changes for <a href="${esc(pullLink)}">${esc(shortRepoPath)}#${esc(rawIndex)}</a>`;
      break;
    case "comment_pull":
      titleExtra = `commented on pull request <a href="${esc(pullLink)}">${esc(shortRepoPath)}#${esc(rawIndex)}</a>`;
      break;
    case "publish_release": {
      // convert.go:184-188 — the release link only rescues a "#" base.
      if (link === "#") link = releaseLink;
      titleExtra = `released <a href="${esc(releaseLink)}">${esc(activity.content)}</a> at <a href="${esc(repoHref)}">${esc(shortRepoPath)}</a>`;
      break;
    }
    default:
      // convert.go:196-197 — the closed-enum error arm, verbatim.
      throw new Error(`unknown action type: ${activity.op_type}`);
  }
  const title = `${esc(`${actorName} `)}${titleExtra}`;

  // The description & content arms — convert.go:199-234's exact shape.
  let description = "";
  let content = "";
  switch (activity.op_type) {
    case "create_issue":
    case "create_pull_request": {
      description = infos.join("#"); // Join over the padded triple
      content = renderMarkdownToHtml({
        text: liveIssueContent(issueLookups, lookupKey, index),
        mode: "markdown",
        context: "",
        wiki: false,
        origin: "",
      });
      break;
    }
    case "comment_issue":
    case "approve_pull_request":
    case "reject_pull_request":
    case "comment_pull": {
      description = liveIssueTitle(issueLookups, lookupKey, index);
      const excerpt = infos[1] ?? "";
      if (excerpt !== "") {
        description += `\n\n${renderMarkdownToHtml({ text: excerpt, mode: "markdown", context: "", wiki: false, origin: "" })}`;
      }
      break;
    }
    case "merge_pull_request":
      description = infos[1] ?? "";
      break;
    case "close_issue":
    case "reopen_issue":
    case "close_pull_request":
    case "reopen_pull_request":
      description = liveIssueTitle(issueLookups, lookupKey, index);
      break;
    default:
      break; // create_repo / rename_repo / publish_release: no arm — both stay ""
  }
  if (content === "") {
    // markup.Sanitize(desc) — the module header's reduction (desc verbatim).
    content = description;
  }

  return {
    title,
    link,
    description,
    content,
    authorName: DEFAULT_SHOW_FULL_NAME ? (actUser?.full_name ?? "").trim() || actorName : actorName,
    authorEmail: actorEmail,
    id: `${activity.id}: ${link}`,
    isPermaLink: "false",
    createdUnix: Math.floor(Date.parse(activity.created) / 1000),
  };
}

// ---------------------------------------------------------------------------
// The envelopes (gorilla/feeds v1.2.0 WriteRss / WriteAtom bytes)
// ---------------------------------------------------------------------------

/** `writeFeed`'s content types (routers/web/feed/profile.go:94-104). */
export const USER_FEED_CONTENT_TYPES = {
  rss: "application/rss+xml;charset=utf-8",
  atom: "application/atom+xml;charset=utf-8",
} as const;

/** The channel-level render input (the Feed struct fields showUserFeed
 *  sets — profile.go:85-91; no Author/Image/Copyright upstream). */
export interface UserFeedEnvelopeInput {
  /** `Feed of "{displayName}"` — TrString("home.feed_of"). */
  readonly title: string;
  /** The user HTMLURL. */
  readonly link: string;
  /** The markdown-rendered bio ("" when none — RSS still emits the empty
   *  `<description>`, Atom drops the `<subtitle>`). */
  readonly descriptionHtml: string;
  /** `time.Now()` at handler time. */
  readonly generatedUnix: number;
  readonly items: readonly UserFeedItem[];
}

/** `<?xml version="1.0" encoding="UTF-8"?>` — Go xml.Header minus its
 *  trailing newline, straight into the root element. */
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/** gorilla `WriteRss` bytes — element-for-element vs the verified Go run
 *  (the module header's RSS map). No trailing newline. */
export function renderUserFeedRss(input: UserFeedEnvelopeInput): string {
  const e = escapeXmlText;
  const lines: string[] = [
    `${XML_HEADER}<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">`,
    "  <channel>",
    `    <title>${e(input.title)}</title>`,
    `    <link>${e(input.link)}</link>`,
    `    <description>${e(input.descriptionHtml)}</description>`,
    `    <pubDate>${formatRfc1123z(input.generatedUnix)}</pubDate>`,
  ];
  for (const item of input.items) {
    lines.push(
      "    <item>",
      `      <title>${e(item.title)}</title>`,
      `      <link>${e(item.link)}</link>`,
      `      <description>${e(item.description)}</description>`,
    );
    if (item.content !== "") {
      lines.push(`      <content:encoded><![CDATA[${cdataBody(item.content)}]]></content:encoded>`);
    }
    if (item.authorName !== "") {
      // newRssItem (:126-128) copies ONLY the Name into <author>.
      lines.push(`      <author>${e(item.authorName)}</author>`);
    }
    if (item.id !== "") {
      // The attr is omitempty upstream (RssGuid.IsPermaLink) — empty drops
      // it; the projection's literal "false" always renders it.
      lines.push(`      <guid isPermaLink="${e(item.isPermaLink)}">${e(item.id)}</guid>`);
    }
    lines.push(`      <pubDate>${formatRfc1123z(item.createdUnix)}</pubDate>`, "    </item>");
  }
  lines.push("  </channel>", "</rss>");
  return lines.join("\n");
}

/** gorilla `WriteAtom` bytes — element-for-element vs the verified Go run
 *  (the module header's Atom map). No trailing newline. */
export function renderUserFeedAtom(input: UserFeedEnvelopeInput): string {
  const e = escapeXmlText;
  const lines: string[] = [
    `${XML_HEADER}<feed xmlns="http://www.w3.org/2005/Atom">`,
    `  <title>${e(input.title)}</title>`,
    `  <id>${e(input.link)}</id>`,
    `  <updated>${formatRfc3339(input.generatedUnix)}</updated>`,
  ];
  if (input.descriptionHtml !== "") {
    lines.push(`  <subtitle>${e(input.descriptionHtml)}</subtitle>`);
  }
  lines.push(`  <link href="${e(input.link)}"></link>`);
  for (const item of input.items) {
    lines.push(
      "  <entry>",
      `    <title>${e(item.title)}</title>`,
      `    <updated>${formatRfc3339(item.createdUnix)}</updated>`,
      `    <id>${e(item.id)}</id>`,
    );
    if (item.content !== "") {
      lines.push(`    <content type="html">${e(item.content)}</content>`);
    }
    lines.push(`    <link href="${e(item.link)}" rel="alternate"></link>`);
    if (item.description !== "") {
      lines.push(`    <summary type="html">${e(item.description)}</summary>`);
    }
    if (item.authorName !== "" || item.authorEmail !== "") {
      lines.push("    <author>", `      <name>${e(item.authorName)}</name>`);
      if (item.authorEmail !== "") {
        lines.push(`      <email>${e(item.authorEmail)}</email>`);
      }
      lines.push("    </author>");
    }
    lines.push("  </entry>");
  }
  lines.push("</feed>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The loader (showUserFeed's GetFeeds arm over the landed service)
// ---------------------------------------------------------------------------

/** Upstream `setting.API.DefaultPagingNum` (modules/setting/api.go:19) —
 *  the feed's zero ListOptions falls here via SetDefaultValues
 *  (models/db/list.go:64-67); the handler reads no page param. */
export const USER_FEED_PAGE_SIZE = 30;

/** The resolved owner row, structurally (a users row or an OrgRecord fits).
 *  `kind` drives OnlyPerformedBy + the org-member includePrivate arm. */
export interface UserFeedSubject {
  kind: "user" | "org";
  id: number;
  username: string;
  fullName: string | null;
  email: string | null;
  description: string | null;
}

/** The loader's output — the envelope input plus what the route/tests
 *  read (the action page count for asserts, the generated timestamp). */
export interface UserFeedData extends UserFeedEnvelopeInput {
  readonly subject: UserFeedSubject;
  /** getFeedRows' unpaginated total (the anonymous exclusions included). */
  readonly total: number;
}

/** The api `Viewer` projection of the session viewer (the page module's
 *  feedsApiUser shape). */
function feedsApiUser(viewer: Viewer, origin: string): ApiViewer {
  return {
    origin,
    requester:
      viewer.kind === "user" ? { id: viewer.id, login: viewer.username, is_admin: viewer.isAdmin } : null,
  };
}

/**
 * `showUserFeed`'s data arm (profile.go:33-91): the includePrivate ladder
 * (self/admin; the org-member arm for org feeds), `getFeedRows` at page 1 ×
 * 30 with the `?date=` passthrough and `OnlyPerformedBy = kind === "user"`,
 * `renderFeedItems`, the batched live-issue lookups the title/description
 * arms read (the page module's coordinates→TEXT-id join), then the channel
 * fields. The visibility gate lives in the route's resolution seam (the
 * HANDOFF NOTE) — the loader takes the already-resolved subject.
 */
export async function loadUserFeedData(
  d1: D1Database,
  subject: UserFeedSubject,
  viewer: Viewer,
  origin: string,
  params: URLSearchParams,
  // Wall-clock seam (render-wallclock-audit): the channel Created stamp
  // (generatedUnix → RSS pubDate / Atom updated). Default keeps every
  // caller unchanged; tests pin it for byte-stable feeds.
  now: Date = new Date(),
): Promise<UserFeedData> {
  const viewerId = viewer.kind === "user" ? viewer.id : null;
  const viewerIsAdmin = viewer.kind === "user" ? viewer.isAdmin : false;

  // includePrivate = IsSigned && (admin || self) — profile.go:43.
  let includePrivate = viewerId !== null && (viewerIsAdmin || viewerId === subject.id);
  if (viewerId !== null && subject.kind === "org" && !includePrivate) {
    // profile.go:44-53 — a signed org member sees the member feed
    // (IsOrganizationMember): membership test = the row exists (§3.3).
    const membership = await drizzle(d1)
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, subject.id), eq(orgMembers.userId, viewerId)))
      .get();
    includePrivate = membership !== undefined;
  }

  const date = params.get("date") ?? "";
  const { total, rows } = await getFeedRows(d1, {
    kind: subject.kind === "org" ? "org" : "user",
    requested: { id: subject.id },
    actor: viewerId === null ? null : { id: viewerId, isAdmin: viewerIsAdmin },
    includePrivate,
    onlyPerformedBy: subject.kind === "user",
    date: date === "" ? undefined : date,
    page: 1,
    limit: USER_FEED_PAGE_SIZE,
  });
  const activities = await renderFeedItems(d1, feedsApiUser(viewer, origin), rows);

  // The live-issue lookups: coordinates → TEXT repositories.id (the
  // numeric-payload join note) → one batched issues read over the page's
  // (repoId, index) pairs.
  const coordinates = [
    ...new Set(
      activities.map((activity) => `${activity.repo?.owner?.login ?? ""}/${activity.repo?.name ?? ""}`),
    ),
  ].filter((key) => key !== "/");
  const repoIdByCoordinates = new Map<string, string>();
  const namespaces = [...new Set(coordinates.map((key) => key.slice(0, key.indexOf("/"))))];
  if (namespaces.length > 0) {
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

  const issueLookups: FeedIssueLookups = new Map();
  const repoIds = new Set<string>();
  for (const activity of activities) {
    const index = issueIndexOf(activity.content);
    if (index <= 0) continue;
    const repoId = repoIdByCoordinates.get(
      `${activity.repo?.owner?.login ?? ""}/${activity.repo?.name ?? ""}`,
    );
    if (repoId !== undefined) repoIds.add(repoId);
  }
  if (repoIds.size > 0) {
    const issueRows = await drizzle(d1)
      .select({ repoId: issues.repoId, index: issues.index, title: issues.title, isPull: issues.isPull, content: issues.content })
      .from(issues)
      .where(inArray(issues.repoId, [...repoIds]))
      .all();
    const repoIdToCoordinates = new Map<string, string[]>();
    for (const [key, repoId] of repoIdByCoordinates) {
      const list = repoIdToCoordinates.get(repoId) ?? [];
      list.push(key);
      repoIdToCoordinates.set(repoId, list);
    }
    for (const row of issueRows) {
      const keys = repoIdToCoordinates.get(row.repoId) ?? [];
      for (const key of keys) {
        issueLookups.set(`${key}#${row.index}`, {
          title: row.title,
          isPull: row.isPull,
          content: row.content ?? "",
        });
      }
    }
  }

  const items = activities.map((activity) => feedItemFromActivity(activity, origin, issueLookups));

  // The channel fields (profile.go:85-91): Title = TrString("home.feed_of",
  // GetDisplayName) — locale_en-US.json:344 `Feed of "%s"`; Link = the user
  // HTMLURL; Description = the rendered bio; Created = now.
  const displayName =
    DEFAULT_SHOW_FULL_NAME && (subject.fullName ?? "").trim() !== ""
      ? (subject.fullName ?? "").trim()
      : subject.username;
  return {
    subject,
    title: `Feed of "${displayName}"`,
    link: `${origin}/${subject.username}`,
    descriptionHtml: renderMarkdownToHtml({
      text: subject.description ?? "",
      mode: "markdown",
      context: "",
      wiki: false,
      origin: "",
    }),
    generatedUnix: Math.floor(now.getTime() / 1000),
    items,
    total,
  };
}
