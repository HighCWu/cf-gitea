/**
 * The shared provider formatting helpers — the port of the pieces of
 * `services/webhook/general.go` (plus the tiny `modules/util` /
 * `modules/git.RefName` / `modules/base` helpers the requesters call) that the
 * per-provider payload builders need. Each function mirrors its upstream
 * namesake's byte behavior at the pin.
 */

import type { ApiIssue, ApiPullRequest, ApiRepository, ApiUser, ChangesPayload } from "./payload-shapes";
import { num, str } from "./payload-shapes";

// ---------------------------------------------------------------------------
// Link formatters (general.go:22-32, slack.go:72-103)
// ---------------------------------------------------------------------------

/** Go `html.EscapeString` — escapes exactly & ' < > " (html/escape.go). */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;");
}

export type LinkFormatter = (url: string, text: string) => string;

/** `noneLinkFormatter` — text only (general.go:25-27). */
export const noneLinkFormatter: LinkFormatter = (_url, text) => text;

/** `htmlLinkFormatter` (general.go:30-32) — HTML link with escaped parts. */
export const htmlLinkFormatter: LinkFormatter = (url, text) =>
  `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;

/** `SlackTextFormatter` (slack.go:74-80) — & < > to HTML entities. */
export function slackTextFormatter(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** `SlackShortTextFormatter` (slack.go:83-90) — the first line, escaped. */
export function slackShortTextFormatter(text: string): string {
  return slackTextFormatter(text.split("\n")[0] ?? "");
}

/** `SlackLinkFormatter` (slack.go:93-95) — `<url|text>`. */
export const slackLinkFormatter: LinkFormatter = (url, text) => `<${url}|${slackTextFormatter(text)}>`;

// ---------------------------------------------------------------------------
// Go percent-encoding (modules/util/url.go PathEscapeSegments)
// ---------------------------------------------------------------------------

/**
 * Go `url.PathEscape` for one path segment: unreserved bytes and the
 * sub-delims/`:`/`@` set stay literal (`shouldEscape`'s encodePathSegment
 * case), everything else percent-encodes per UTF-8 byte with UPPER hex.
 */
export function goPathEscapeSegment(segment: string): string {
  const unescaped = /[A-Za-z0-9\-._~$&+,;=:@]/;
  let out = "";
  for (const ch of segment) {
    if (unescaped.test(ch)) {
      out += ch;
    } else {
      for (const byte of new TextEncoder().encode(ch)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

/** `util.PathEscapeSegments` (modules/util/url.go:12-18) — per-segment escape, `/` kept. */
export function pathEscapeSegments(path: string): string {
  return path.split("/").map(goPathEscapeSegment).join("/");
}

/**
 * Go `url.QueryEscape` (net/url): unreserved bytes stay literal, SPACE becomes
 * `+`, everything else percent-encodes per UTF-8 byte with UPPER hex — the
 * dingtalk singleURL builder's escape (dingtalk.go:205).
 */
export function goQueryEscape(text: string): string {
  const unescaped = /[A-Za-z0-9\-._~]/;
  let out = "";
  for (const ch of text) {
    if (unescaped.test(ch)) {
      out += ch;
    } else if (ch === " ") {
      out += "+";
    } else {
      for (const byte of new TextEncoder().encode(ch)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RefName helpers (modules/git/ref.go)
// ---------------------------------------------------------------------------

const BRANCH_PREFIX = "refs/heads/";
const TAG_PREFIX = "refs/tags/";
const REMOTE_PREFIX = "refs/remotes/";

/** `RefName.IsBranch/IsTag/IsRemote` prefix probes. */
export function refIsBranch(ref: string): boolean {
  return ref.startsWith(BRANCH_PREFIX);
}

export function refIsTag(ref: string): boolean {
  return ref.startsWith(TAG_PREFIX);
}

/** `RefName.BranchName/TagName` — the prefix-stripped short form. */
export function refBranchName(ref: string): string {
  return refIsBranch(ref) ? ref.slice(BRANCH_PREFIX.length) : ref;
}

export function refTagName(ref: string): string {
  return refIsTag(ref) ? ref.slice(TAG_PREFIX.length) : ref;
}

/** `RefName.ShortName` (ref.go:169-187) — the branch/tag/remote/fallback walk. */
export function refShortName(ref: string): string {
  if (refIsBranch(ref)) return refBranchName(ref);
  if (refIsTag(ref)) return refTagName(ref);
  if (ref.startsWith(REMOTE_PREFIX)) return ref.slice(REMOTE_PREFIX.length).split("/")[0] ?? ref;
  return ref; // usually a commit id, or "HEAD"
}

/**
 * `RefName.RefType` (ref.go:221-231) — "branch" | "tag" | "commit" (a full
 * hex object id), "" otherwise — the WEB link type RefWebLinkPath renders,
 * not the refs/ subdirectory group.
 */
function refType(ref: string): string {
  if (refIsBranch(ref)) return "branch";
  if (refIsTag(ref)) return "tag";
  if (/^[0-9a-fA-F]{40}$/.test(ref)) return "commit";
  return "";
}

/** `RefName.RefWebLinkPath` (ref.go:233-244) — `branch/test` shape; "" when untyped. */
export function refWebLinkPath(ref: string): string {
  const group = refType(ref);
  if (group === "") return "";
  return `${group}/${pathEscapeSegments(refShortName(ref))}`;
}

// ---------------------------------------------------------------------------
// Truncation + colors (modules/base/tool.go, modules/util/truncate.go,
// discord.go:82-102)
// ---------------------------------------------------------------------------

/** `util.TruncateRunes` (truncate.go:127-133) — rune-bounded prefix. */
export function truncateRunes(text: string, limit: number): string {
  const runes = [...text];
  if (runes.length < limit) return text;
  return runes.slice(0, limit).join("");
}

/** `base.ShortSha` (tool.go:31-33). */
export function shortSha(sha: string): string {
  return truncateRunes(sha, 10);
}

/** discord.go `color()` (:82-91) — hex string to int, 0 on garbage. */
export function colorFromHex(clr: string): number {
  if (clr !== "") {
    const trimmed = clr.replace(/^#+/, "");
    if (/^[0-9a-fA-F]+$/.test(trimmed)) {
      const value = Number.parseInt(trimmed, 16);
      if (Number.isSafeInteger(value) && value <= 0x7fffffff) return value;
    }
  }
  return 0;
}

/** The general.go color constants (:93-102), built through the same parser. */
export const COLORS = {
  green: colorFromHex("1ac600"),
  greenLight: colorFromHex("bfe5bf"),
  yellow: colorFromHex("ffd930"),
  grey: colorFromHex("4f545c"),
  purple: colorFromHex("7289da"),
  orange: colorFromHex("eb6420"),
  orangeLight: colorFromHex("e68d60"),
  red: colorFromHex("ff3232"),
} as const;

/** Go `fmt.Sprintf("%x", color)` — lowercase hex, used for slack/msteams colors. */
export function colorHex(value: number): string {
  return value.toString(16);
}

// ---------------------------------------------------------------------------
// Review event mapping (discord.go:313-324 parseHookPullRequestEventType)
// ---------------------------------------------------------------------------

/** `parseHookPullRequestEventType` — null renders Go's "unknown event type" error. */
export function parseHookPullRequestEventType(event: string): string | null {
  switch (event) {
    case "pull_request_review_approved":
      return "approved";
    case "pull_request_review_rejected":
      return "requested changes";
    case "pull_request_review_comment":
      return "comment";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The general.go info getters (:35-432)
//
// Every getter takes the instance root URL (`appUrl`, WITH the trailing slash
// — upstream reads `setting.AppURL`, whose configured value ends in "/", and
// concatenates directly: `setting.AppURL + url.PathEscape(name)`). Callers
// normalize through `appRoot` below.
// ---------------------------------------------------------------------------

/** Normalize a stripped APP_URL into upstream's trailing-slash AppURL shape. */
export function appRoot(appUrl: string): string {
  return appUrl.endsWith("/") ? appUrl : `${appUrl}/`;
}

/** The `setting.AppURL + url.PathEscape(user.UserName)` sender profile link. */
function senderLink(appUrl: string, user: ApiUser | null | undefined, format: LinkFormatter): string {
  return format(appUrl + goPathEscapeSegment(str(user?.login)), str(user?.login));
}

/** `getChangedAssigneeNames` (general.go:111-124) — "" when changes is nil. */
function changedAssigneeNames(
  changes: ChangesPayload | null | undefined,
  action: string,
  appUrl: string,
  format: LinkFormatter,
): string {
  if (changes === null || changes === undefined) return "";
  const assignees = action === "unassigned" ? changes.removed_assignees : changes.added_assignees;
  return (assignees ?? [])
    .map((user) => format(appUrl + goPathEscapeSegment(str(user?.login)), str(user?.login)))
    .join(", ");
}

/** `getIssuesInfo` (general.go:67-96) — the plain-text feishu layout fields. */
export function getIssuesInfo(payload: {
  action?: string;
  number?: number;
  changes?: ChangesPayload | null;
  issue?: ApiIssue | null;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
}): { title: string; link: string; by: string; operator: string; operateResult: string; assignees: string } {
  const issue = payload.issue ?? {};
  const repo = payload.repository ?? {};
  const action = str(payload.action);
  const title = `[Issue-${str(repo.full_name)} #${num(payload.number)}]: ${action}\n${str(issue.title)}`;
  const assignees = (issue.assignees ?? []).map((user) => str(user.login));

  let operateResult = "";
  switch (action) {
    case "assigned": {
      operateResult = `${str(payload.sender?.login)} assigned this`;
      const names = changedAssigneeNames(payload.changes, action, "", noneLinkFormatter);
      if (names !== "") operateResult = `${str(payload.sender?.login)} assign this to ${names}`;
      break;
    }
    case "unassigned": {
      operateResult = `${str(payload.sender?.login)} unassigned this for someone`;
      const names = changedAssigneeNames(payload.changes, action, "", noneLinkFormatter);
      if (names !== "") operateResult = `${str(payload.sender?.login)} unassigned this for ${names}`;
      break;
    }
    case "milestoned":
      operateResult = `${str(repo.html_url)}/milestone/${num(issue.milestone?.id)}`;
      break;
  }

  const link = str(issue.html_url);
  const by = `Issue by ${str(issue.user?.login)}`;
  const assigneesField = assignees.length > 0 ? `Assignees: ${assignees.join(", ")}` : "";
  const operator = `Operator: ${str(payload.sender?.login)}`;
  return { title, link, by, operator, operateResult, assignees: assigneesField };
}

/** `getPullRequestInfo` (general.go:35-64) — the plain-text feishu layout fields. */
export function getPullRequestInfo(payload: {
  action?: string;
  number?: number;
  changes?: ChangesPayload | null;
  pull_request?: ApiPullRequest | null;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
}): { title: string; link: string; by: string; operator: string; operateResult: string; assignees: string } {
  const pr = payload.pull_request ?? {};
  const repo = payload.repository ?? {};
  const action = str(payload.action);
  const title = `[PullRequest-${str(repo.full_name)} #${num(payload.number)}]: ${action}\n${str(pr.title)}`;
  const assignees = (pr.assignees ?? []).map((user) => str(user.login));

  let operateResult = "";
  switch (action) {
    case "assigned": {
      operateResult = `${str(payload.sender?.login)} assigned this`;
      const names = changedAssigneeNames(payload.changes, action, "", noneLinkFormatter);
      if (names !== "") operateResult = `${str(payload.sender?.login)} assign this to ${names}`;
      break;
    }
    case "unassigned": {
      operateResult = `${str(payload.sender?.login)} unassigned this for someone`;
      const names = changedAssigneeNames(payload.changes, action, "", noneLinkFormatter);
      if (names !== "") operateResult = `${str(payload.sender?.login)} unassigned this for ${names}`;
      break;
    }
    case "milestoned":
      operateResult = `${str(repo.html_url)}/milestone/${num(pr.milestone?.id)}`;
      break;
  }

  const link = str(pr.html_url);
  const by = `PullRequest by ${str(pr.user?.login)}`;
  const assigneesField = assignees.length > 0 ? `Assignees: ${assignees.join(", ")}` : "";
  const operator = `Operator: ${str(payload.sender?.login)}`;
  return { title, link, by, operator, operateResult, assignees: assigneesField };
}

/** `getIssuesCommentInfo` (general.go:99-109). */
export function getIssuesCommentInfo(payload: {
  action?: string;
  issue?: ApiIssue | null;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
  is_pull?: boolean;
}): { title: string; link: string; by: string; operator: string } {
  const issue = payload.issue ?? {};
  const repo = payload.repository ?? {};
  const title = `[Comment-${str(repo.full_name)} #${num(issue.number)}]: ${str(payload.action)}\n${str(issue.title)}`;
  const link = str(issue.html_url);
  const by = payload.is_pull === true ? `PullRequest by ${str(issue.user?.login)}` : `Issue by ${str(issue.user?.login)}`;
  const operator = `Operator: ${str(payload.sender?.login)}`;
  return { title, link, by, operator };
}

export interface PayloadInfo {
  text: string;
  issueTitle?: string;
  extraMarkdown?: string;
  color: number;
}

/** `getIssuesPayloadInfo` (general.go:126-176). */
export function getIssuesPayloadInfo(
  payload: { action?: string; number?: number; changes?: ChangesPayload | null; issue?: { title?: string; html_url?: string; body?: string; milestone?: { id?: number; title?: string } | null } | null; repository?: { html_url?: string; full_name?: string } | null; sender?: ApiUser | null },
  format: LinkFormatter,
  withSender: boolean,
  appUrl: string,
): PayloadInfo {
  const issue = payload.issue ?? {};
  const repo = payload.repository ?? {};
  const action = str(payload.action);
  let color = COLORS.yellow;
  const issueTitle = `#${num(payload.number)} ${str(issue.title)}`;
  const titleLink = format(`${str(repo.html_url)}/issues/${num(payload.number)}`, issueTitle);
  const repoLink = format(str(repo.html_url), str(repo.full_name));

  let text: string;
  switch (action) {
    case "opened":
      text = `[${repoLink}] Issue opened: ${titleLink}`;
      color = COLORS.orange;
      break;
    case "closed":
      text = `[${repoLink}] Issue closed: ${titleLink}`;
      color = COLORS.red;
      break;
    case "reopened":
      text = `[${repoLink}] Issue re-opened: ${titleLink}`;
      break;
    case "edited":
      text = `[${repoLink}] Issue edited: ${titleLink}`;
      break;
    case "assigned": {
      text = `[${repoLink}] Issue assigned: ${titleLink}`;
      const names = changedAssigneeNames(payload.changes, action, appUrl, format);
      if (names !== "") text = `[${repoLink}] Issue assigned to ${names}: ${titleLink}`;
      color = COLORS.green;
      break;
    }
    case "unassigned": {
      text = `[${repoLink}] Issue unassigned: ${titleLink}`;
      const names = changedAssigneeNames(payload.changes, action, appUrl, format);
      if (names !== "") text = `[${repoLink}] Issue unassigned from ${names}: ${titleLink}`;
      break;
    }
    case "label_updated":
      text = `[${repoLink}] Issue labels updated: ${titleLink}`;
      break;
    case "label_cleared":
      text = `[${repoLink}] Issue labels cleared: ${titleLink}`;
      break;
    case "synchronized":
      text = `[${repoLink}] Issue synchronized: ${titleLink}`;
      break;
    case "milestoned": {
      const mileStoneLink = `${str(repo.html_url)}/milestone/${num(issue.milestone?.id)}`;
      text = `[${repoLink}] Issue milestoned to ${format(mileStoneLink, str(issue.milestone?.title))}: ${titleLink}`;
      break;
    }
    case "demilestoned":
      text = `[${repoLink}] Issue milestone cleared: ${titleLink}`;
      break;
    default:
      text = "";
  }
  if (withSender) {
    text += ` by ${senderLink(appUrl, payload.sender, format)}`;
  }

  const extraMarkdown = action === "opened" || action === "edited" ? str(issue.body) : "";
  return { text, issueTitle, extraMarkdown, color };
}

/** `getPullRequestPayloadInfo` (general.go:178-238). */
export function getPullRequestPayloadInfo(
  payload: { action?: string; number?: number; changes?: ChangesPayload | null; pull_request?: { title?: string; url?: string; body?: string; merged?: boolean; milestone?: { id?: number; title?: string } | null } | null; repository?: { html_url?: string; full_name?: string } | null; sender?: ApiUser | null; review?: { type?: string; content?: string } | null },
  format: LinkFormatter,
  withSender: boolean,
  appUrl: string,
): PayloadInfo {
  const pr = payload.pull_request ?? {};
  const repo = payload.repository ?? {};
  const action = str(payload.action);
  let color = COLORS.yellow;
  const issueTitle = `#${num(payload.number)} ${str(pr.title)}`;
  const titleLink = format(str(pr.url), issueTitle);
  const repoLink = format(str(repo.html_url), str(repo.full_name));

  let text: string;
  let extraMarkdown = "";
  switch (action) {
    case "opened":
      text = `[${repoLink}] Pull request opened: ${titleLink}`;
      extraMarkdown = str(pr.body);
      color = COLORS.green;
      break;
    case "closed":
      if (pr.merged === true) {
        text = `[${repoLink}] Pull request merged: ${titleLink}`;
        color = COLORS.purple;
      } else {
        text = `[${repoLink}] Pull request closed: ${titleLink}`;
        color = COLORS.red;
      }
      break;
    case "reopened":
      text = `[${repoLink}] Pull request re-opened: ${titleLink}`;
      break;
    case "edited":
      text = `[${repoLink}] Pull request edited: ${titleLink}`;
      extraMarkdown = str(pr.body);
      break;
    case "assigned": {
      text = `[${repoLink}] Pull request assigned: ${titleLink}`;
      const names = changedAssigneeNames(payload.changes, action, appUrl, format);
      if (names !== "") text = `[${repoLink}] Pull request assigned to ${names}: ${titleLink}`;
      color = COLORS.green;
      break;
    }
    case "unassigned": {
      text = `[${repoLink}] Pull request unassigned: ${titleLink}`;
      const names = changedAssigneeNames(payload.changes, action, appUrl, format);
      if (names !== "") text = `[${repoLink}] Pull request unassigned from ${names}: ${titleLink}`;
      break;
    }
    case "label_updated":
      text = `[${repoLink}] Pull request labels updated: ${titleLink}`;
      break;
    case "label_cleared":
      text = `[${repoLink}] Pull request labels cleared: ${titleLink}`;
      break;
    case "synchronized":
      text = `[${repoLink}] Pull request synchronized: ${titleLink}`;
      break;
    case "milestoned": {
      const mileStoneLink = `${str(repo.html_url)}/milestone/${num(pr.milestone?.id)}`;
      text = `[${repoLink}] Pull request milestoned to ${format(mileStoneLink, str(pr.milestone?.title))}: ${titleLink}`;
      break;
    }
    case "demilestoned":
      text = `[${repoLink}] Pull request milestone cleared: ${titleLink}`;
      break;
    case "reviewed":
      text = `[${repoLink}] Pull request reviewed: ${titleLink}`;
      extraMarkdown = str(payload.review?.content);
      break;
    case "review_requested":
      text = `[${repoLink}] Pull request review requested: ${titleLink}`;
      break;
    case "review_request_removed":
      text = `[${repoLink}] Pull request review request removed: ${titleLink}`;
      break;
    default:
      text = "";
  }
  if (withSender) {
    // Upstream's PR arm skips the PathEscape (general.go:233-235) — verbatim.
    text += ` by ${format(appUrl + str(payload.sender?.login), str(payload.sender?.login))}`;
  }

  return { text, issueTitle, extraMarkdown, color };
}

/** `getIssueCommentPayloadInfo` (general.go:295-329) — (text, issueTitle, color). */
export function getIssueCommentPayloadInfo(
  payload: { action?: string; is_pull?: boolean; issue?: { number?: number; title?: string } | null; comment?: { pull_request_url?: string; issue_url?: string } | null; repository?: { html_url?: string; full_name?: string } | null; sender?: ApiUser | null },
  format: LinkFormatter,
  withSender: boolean,
  appUrl: string,
): { text: string; issueTitle: string; color: number } {
  const repo = payload.repository ?? {};
  const repoLink = format(str(repo.html_url), str(repo.full_name));
  const issueTitle = `#${num(payload.issue?.number)} ${str(payload.issue?.title)}`;

  let text: string;
  let typ: string;
  let titleLink: string;
  let color = COLORS.yellow;

  if (payload.is_pull === true) {
    typ = "pull request";
    titleLink = format(str(payload.comment?.pull_request_url), issueTitle);
  } else {
    typ = "issue";
    titleLink = format(str(payload.comment?.issue_url), issueTitle);
  }

  switch (str(payload.action)) {
    case "created":
      text = `[${repoLink}] New comment on ${typ} ${titleLink}`;
      color = payload.is_pull === true ? COLORS.greenLight : COLORS.orangeLight;
      break;
    case "edited":
      text = `[${repoLink}] Comment edited on ${typ} ${titleLink}`;
      break;
    case "deleted":
      text = `[${repoLink}] Comment deleted on ${typ} ${titleLink}`;
      color = COLORS.red;
      break;
    default:
      text = "";
  }
  if (withSender) {
    text += ` by ${senderLink(appUrl, payload.sender, format)}`;
  }

  return { text, issueTitle, color };
}

/** `getReleasePayloadInfo` (general.go:240-264) — (text, color). */
export function getReleasePayloadInfo(
  payload: { action?: string; release?: { tag_name?: string; assets?: unknown[] | null } | null; repository?: { html_url?: string; full_name?: string } | null; sender?: ApiUser | null },
  format: LinkFormatter,
  withSender: boolean,
  appUrl: string,
): { text: string; color: number } {
  const repo = payload.repository ?? {};
  const repoLink = format(str(repo.html_url), str(repo.full_name));
  const tagName = str(payload.release?.tag_name);
  const refLink = format(`${str(repo.html_url)}/releases/tag/${pathEscapeSegments(tagName)}`, tagName);

  let text: string;
  let color: number;
  switch (str(payload.action)) {
    case "published":
      text = `[${repoLink}] Release created: ${refLink}`;
      color = COLORS.green;
      break;
    case "updated":
      text = `[${repoLink}] Release updated: ${refLink}`;
      color = COLORS.yellow;
      break;
    case "deleted":
      text = `[${repoLink}] Release deleted: ${refLink}`;
      color = COLORS.red;
      break;
    default:
      text = "";
      color = COLORS.yellow;
  }
  if (withSender) {
    text += ` by ${senderLink(appUrl, payload.sender, format)}`;
  }

  const assets = payload.release?.assets ?? [];
  if (str(payload.action) !== "deleted" && assets.length > 0) {
    text += ` (assets: ${assets.length})`;
  }

  return { text, color };
}

/** `getWikiPayloadInfo` (general.go:266-293) — (text, color, pageLink). */
export function getWikiPayloadInfo(
  payload: { action?: string; page?: string; comment?: string; repository?: { html_url?: string; full_name?: string } | null; sender?: ApiUser | null },
  format: LinkFormatter,
  withSender: boolean,
  appUrl: string,
): { text: string; color: number; pageLink: string } {
  const repo = payload.repository ?? {};
  const repoLink = format(str(repo.html_url), str(repo.full_name));
  const page = str(payload.page);
  const pageLink = format(`${str(repo.html_url)}/wiki/${goPathEscapeSegment(page)}`, page);

  let text: string;
  let color = COLORS.green;

  switch (str(payload.action)) {
    case "created":
      text = `[${repoLink}] New wiki page '${pageLink}'`;
      break;
    case "edited":
      text = `[${repoLink}] Wiki page '${pageLink}' edited`;
      color = COLORS.yellow;
      break;
    case "deleted":
      text = `[${repoLink}] Wiki page '${pageLink}' deleted`;
      color = COLORS.red;
      break;
    default:
      text = "";
  }

  if (str(payload.action) !== "deleted" && str(payload.comment) !== "") {
    text += ` (${str(payload.comment)})`;
  }

  if (withSender) {
    text += ` by ${senderLink(appUrl, payload.sender, format)}`;
  }

  return { text, color, pageLink };
}

/** `getRepoRenamedFrom` (general.go:331-336). */
export function getRepoRenamedFrom(payload: { changes?: ChangesPayload | null }): string {
  return str(payload.changes?.name?.from);
}

/** `getPackagePayloadInfo` (general.go:338-354) — (text, color). */
export function getPackagePayloadInfo(
  payload: { action?: string; package?: { html_url?: string; name?: string; version?: string } | null; sender?: ApiUser | null },
  format: LinkFormatter,
  withSender: boolean,
  appUrl: string,
): { text: string; color: number } {
  const pkg = payload.package ?? {};
  const refLink = format(str(pkg.html_url), `${str(pkg.name)}:${str(pkg.version)}`);

  let text: string;
  let color: number;
  switch (str(payload.action)) {
    case "created":
      text = `Package created: ${refLink}`;
      color = COLORS.green;
      break;
    case "deleted":
      text = `Package deleted: ${refLink}`;
      color = COLORS.red;
      break;
    default:
      text = "";
      color = COLORS.yellow;
  }
  if (withSender) {
    text += ` by ${senderLink(appUrl, payload.sender, format)}`;
  }

  return { text, color };
}

/** `getStatusPayloadInfo` (general.go:356-370) — (text, color). Upstream's
 *  system-user arm (`GetSystemUserByName` hit → plain FullName) is UNREACHABLE
 *  here — it queries the user table, which the delivery worker does not carry;
 *  the sender-name link arm is what a payload-shaped sender always renders
 *  (the recorded platform adaptation). */
export function getStatusPayloadInfo(
  payload: { target_url?: string; context?: string; sha?: string; description?: string; sender?: ApiUser | null },
  format: LinkFormatter,
  withSender: boolean,
  appUrl: string,
): { text: string; color: number } {
  const refLink = format(str(payload.target_url), `${str(payload.context)} [${shortSha(str(payload.sha))}]`);

  let text = `Commit Status changed: ${refLink} - ${str(payload.description)}`;
  const color = COLORS.green;
  if (withSender) {
    text += ` by ${senderLink(appUrl, payload.sender, format)}`;
  }

  return { text, color };
}

/** `getWorkflowRunPayloadInfo` (general.go:372-401) — (text, color). */
export function getWorkflowRunPayloadInfo(
  payload: { action?: string; workflow_run?: { conclusion?: string; status?: string; html_url?: string; display_title?: string; id?: number; head_sha?: string } | null; sender?: ApiUser | null },
  format: LinkFormatter,
  withSender: boolean,
  appUrl: string,
): { text: string; color: number } {
  const run = payload.workflow_run ?? {};
  const description = str(run.conclusion) !== "" ? str(run.conclusion) : str(run.status);
  const refLink = format(
    str(run.html_url),
    `${str(run.display_title)}(#${num(run.id)})[${shortSha(str(run.head_sha))}]:${description}`,
  );

  let text = `Workflow Run ${str(payload.action)}: ${refLink}`;
  const color = workflowColor(description);
  if (withSender) {
    text += ` by ${senderLink(appUrl, payload.sender, format)}`;
  }

  return { text, color };
}

/** `getWorkflowJobPayloadInfo` (general.go:403-432) — (text, color). */
export function getWorkflowJobPayloadInfo(
  payload: { action?: string; workflow_job?: { conclusion?: string; status?: string; html_url?: string; name?: string; run_id?: number; head_sha?: string } | null; sender?: ApiUser | null },
  format: LinkFormatter,
  withSender: boolean,
  appUrl: string,
): { text: string; color: number } {
  const job = payload.workflow_job ?? {};
  const description = str(job.conclusion) !== "" ? str(job.conclusion) : str(job.status);
  const refLink = format(
    str(job.html_url),
    `${str(job.name)}(#${num(job.run_id)})[${shortSha(str(job.head_sha))}]:${description}`,
  );

  let text = `Workflow Job ${str(payload.action)}: ${refLink}`;
  const color = workflowColor(description, { waiting: COLORS.orange });
  if (withSender) {
    text += ` by ${senderLink(appUrl, payload.sender, format)}`;
  }

  return { text, color };
}

/** The two shared description→color ladders (general.go:380-395, :411-425). */
function workflowColor(description: string, overrides: Record<string, number> = {}): number {
  const shared: Record<string, number> = {
    waiting: COLORS.orange,
    queued: COLORS.orangeLight,
    success: COLORS.green,
    failure: COLORS.red,
    cancelled: COLORS.yellow,
    skipped: COLORS.purple,
  };
  const table = { ...shared, ...overrides };
  return table[description] ?? COLORS.grey;
}

// Re-export note: the milestone-action special cases ride the action strings
// directly inside each getter above; no shared set exists upstream either.
