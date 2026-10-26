/**
 * The issue content fragments — the survey's last M-tier remainder row, the
 * per-issue AJAX family the official bundle fetches around an issue/PR page,
 * upstream (web.go:1319-1334 at the pin, `addIssuesPullsViewRoutes`, mounted
 * twice — `{type:issues}` with `optSignIn + RepoAssignment +
 * RequireUnitReader(TypeIssues, TypePulls)` and `{type:pulls}` with
 * `reqUnitPullsReader`):
 *
 *   GET /{username}/{reponame}/{type}/{index}/info                    repo.GetIssueInfo
 *   GET /{username}/{reponame}/{type}/{index}/attachments             repo.GetIssueAttachments
 *   GET /{username}/{reponame}/{type}/{index}/attachments/{uuid}      repo.GetAttachment
 *   GET /{username}/{reponame}/{type}/{index}/content-history/overview  repo.GetContentHistoryOverview
 *   GET /{username}/{reponame}/{type}/{index}/content-history/list      repo.GetContentHistoryList
 *   GET /{username}/{reponame}/{type}/{index}/content-history/detail    repo.GetContentHistoryDetail
 *
 * The `{type}` discriminators share ONE route group (web.go:1333-1334) and
 * upstream's own FIXME rides the group: "many pulls requests are sent to
 * issues endpoints" — every handler resolves the row by index alone with no
 * isPull/urlKind cross-check, so this module's loaders take the urlKind only
 * for parity of shape and ignore it for resolution (the index namespace is
 * shared, SPEC-0005 §3.1).
 *
 * ## Arm-by-arm against the landed store (the survey's "data partial")
 *
 * - INFO — IMPLEMENTED (issue.go:242-269 GetIssueInfo): the sidebar refresh
 *   payload `{"convertedIssue": <structs.Issue>, "renderedLabels": <HTML>}`.
 *   `convertedIssue` is `convert.ToIssue` verbatim — the landed
 *   `toApiIssue` (api/services/issues.ts), the same converter the /api/v1
 *   issues family and the issues-search aux serve. `renderedLabels` is
 *   `RenderUtils.RenderLabels` (modules/templates/util_render.go:230-249) —
 *   the `<span class="labels-list">` wrapper of per-label
 *   `<a class="item" href="{RepoLink}/{issues|pulls}?labels={id}">` anchors
 *   (pulls for PR rows), each wrapping `RenderLabel` (:71-95 regular arm,
 *   :96-131 scoped arm — ported with the full darken/lighten color math,
 *   util/color.go:24-73). Divergences: `RenderEmoji` is not ported — label
 *   names/descriptions render HTML-escaped plain text (no emoji pipeline on
 *   the server tier); archived labels carry upstream's `archived-label`
 *   class + "(Archived) " description prefix (locale key `archived`) from
 *   our `labels.archived_at`. The handler-side unit reads
 *   (`CanEnablePulls`/`CanRead(TypeIssues|TypePullRequests)`, :249-262) have
 *   no landed unit-toggle consumer — repo_units rows exist but no landed
 *   read consults them — so the unit gate reduces to the mount's visibility
 *   grant (the group's RequireUnitReader posture, the aux siblings'
 *   convention); a missing row is the 404 outcome (GetIssueWithAttrsByIndex
 *   miss → ctx.HTTPError(404), :246-248).
 * - ATTACHMENTS — IMPLEMENTED (issue.go:557-566 GetIssueAttachments): the
 *   JSON array of `structs.Attachment` over the issue's DIRECT attachments —
 *   upstream loads them with `GetAttachmentsByIssueID`
 *   (models/repo/attachment.go:135-141), `WHERE issue_id = ? AND
 *   comment_id = 0`: comment attachments ride the comment family
 *   (`/comments/{id}/attachments`, web.go:1339 — unmounted, its reads land
 *   with the comment-edit wave). Our `issue_attachments` half of the split
 *   attachment store (SPEC-0005 §3.3) answers with the same predicate; the
 *   wire shape is the landed `toApiAttachment` (routes/issue-attachments.ts:
 *   618-630, module-private — re-declared here byte-identical, cite in
 *   place). Upstream's Find has no ORDER BY (xorm emits pk order on SQLite);
 *   ours pins `id ASC` to the same effect. The `{uuid}` serving twin
 *   (web.go:1325, repo.GetAttachment) is NOT a fragment — the handler is
 *   already landed at the site-level seam `GET /attachments/{uuid}`
 *   (web/attachments-serving.ts, web.go:912's family), and the official
 *   bundle dereferences only the `browser_download_url` that seam serves;
 *   the per-issue path alias is a mount concern (the handoff note), not a
 *   second handler.
 * - CONTENT-HISTORY OVERVIEW — IMPLEMENTED (issue_content_history.go:23-40
 *   GetContentHistoryOverview): `{"i18n": {...}, "editedHistoryCountMap":
 *   {...}}` — the map the official bundle walks to hang the "edited"
 *   dropdown on the issue body (key "0") and each edited comment
 *   (web_src/js/features/repo-issue-content.ts:147-155; the VALUES are only
 *   truthiness-checked). Upstream's map is
 *   `SELECT comment_id, COUNT(1) … GROUP BY comment_id HAVING count(1) > 1`
 *   over the `issue_content_history` snapshot table (models/issues/
 *   content_history.go:104-125) — a table cf-gitea DOES NOT have (no
 *   snapshot rows anywhere in the schema). What the landed store keeps is
 *   the edit COUNTER: `issues.content_version` / `comments.content_version`
 *   (0 = never edited, +1 per body edit — api/services/issues.ts:767-771,
 *   832-839), which reconstructs the map exactly for the only consumer
 *   semantics: upstream counts 1 first-created revision + N edits per key
 *   and drops keys with count ≤ 1, so counter N > 0 ⟺ upstream key present,
 *   and this port emits `N + 1` (the revision count) to keep the value
 *   semantics honest. Documented divergences: upstream's 20-revision
 *   retention limiter (KeepLimitedContentHistory, content_history.go:56-98)
 *   hard-deletes MIDDLE revisions so a heavily-edited thread's count can
 *   DECREASE below the true edit count (capped at 20) while our counter
 *   keeps the true count; upstream's soft-deleted revisions (is_deleted)
 *   still count (the query has no filter) and have no counter counterpart.
 *   The i18n block carries the four strings verbatim from the pin's
 *   locale_en-US.json (`repo.issues.content_history.*` — edited /
 *   delete_from_history / delete_from_history_confirm / options); the
 *   locale.ts owner extends it there when the keys land in the shell map.
 * - CONTENT-HISTORY LIST — SKIPPED, ZERO SOURCE
 *   (issue_content_history.go:42-88 GetContentHistoryList): the dropdown
 *   needs per-revision rows (editor user row, edited_unix, is_first_created,
 *   is_deleted) to build the `avatar + userName + action + timeSince` name
 *   HTML. The landed store has no snapshot rows and no edit journal — only
 *   the counters above. No dead endpoint is mounted: the dispatcher leaves
 *   the `content-history/list` tail unclaimed (the official bundle's fetch
 *   404s; upstream renders the menu only when the overview map has the key,
 *   so with the overview answered from counters the menu would only render
 *   for edited bodies and then fail its list fetch — the documented
 *   unrendered arm until a history table lands, which needs the write-path
 *   SPEC first).
 * - CONTENT-HISTORY DETAIL — SKIPPED, ZERO SOURCE
 *   (issue_content_history.go:141-180 GetContentHistoryDetail): the
 *   diff-HTML payload (`diffContentHistory`, :107-138 — diffmatchpatch over
 *   the stored ContentText pair) needs two stored snapshots; there is
 *   nothing to diff. Same posture as list: no endpoint, documented.
 *
 * ## The mount recipes (HANDOFF — this module is UNMOUNTED, index-owned)
 *
 * Inside the issues/pulls arm of the route discriminator (where the
 * issue-detail family claims `/{type}/{index}` exact), for
 * `rest.length >= 2` with `rest[0]` parsing as the issue index:
 *
 * - `rest = [<index>, "info"]` → family `"issue-info"`:
 *   `loadIssueInfoFragment(d1, repo, urlKind, index, origin, viewer,
 *   repoLink)` — `kind: "notFound"` → the 404 shell; else
 *   `issueInfoFragmentResponse(data, renderNotFound(ctx))`.
 * - `rest = [<index>, "attachments"]` → family `"issue-attachments"`:
 *   resolve the issue (the family 404s on a miss like info), then
 *   `loadIssueAttachmentsFragment(d1, issue.id)` +
 *   `issueAttachmentsFragmentResponse(origin, rows)`.
 * - `rest = [<index>, "content-history", "overview"]` → family
 *   `"issue-content-history-overview"`: resolve the issue, then
 *   `loadContentHistoryOverviewFragment(d1, issue)` +
 *   `contentHistoryOverviewFragmentResponse(data)`.
 * - `rest = [<index>, "content-history", "list"|"detail"]` → UNCLAIMED (the
 *   skipped arms — falls through to the 404 shell).
 * - `rest = [<index>, "attachments", <uuid>]` → the per-issue alias of the
 *   landed site-level serving seam; simplest parity mount is a 302 onto
 *   `/attachments/{uuid}` (the canonical `browser_download_url`), or the
 *   index owner can re-drive the seam's handler — NOT this module's export.
 *
 * Group gates ride the mount (the aux convention): `optSignIn` → the mount's
 * anonymous-allowed visibility grant (resolveUiRequest's), the issues/
 * pulls unit-reader gates → no landed unit-toggle consumer (the info note
 * above), repo assignment → the dispatcher's resolved `RepoRow`.
 */

import { and, asc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Issue } from "../../api/models/issue";
import {
  findIssueByRepoAndIndex,
  issueLabelRows,
  toApiIssue,
} from "../../api/services/issues";
import {
  findRepositoryById,
  type Viewer as ApiViewer,
} from "../../api/services/repository";
import { comments, issueAttachments } from "../../db/schema";
import type { IssueRow, LabelRow } from "../../issues/service";
import type { RepoRow } from "../ui-context";
import type { Viewer } from "../viewer";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** The loader outcome (the sibling aux convention: the mount renders the
 *  404 shell on notFound, the Response builders below otherwise). */
export type IssueInfoFragmentOutcome =
  | { readonly kind: "ok"; readonly convertedIssue: Issue; readonly renderedLabels: string }
  | { readonly kind: "notFound" };

/** ctx.JSON's content-type (services/context/base.go:114-116) plus the web
 *  middleware's zero-option prod Cache-Control (the issues-search-aux
 *  sibling's exact header set). */
function jsonHeaders(): HeadersInit {
  return {
    "content-type": "application/json;charset=utf-8",
    "cache-control": "max-age=0, private, must-revalidate",
  };
}

/** The api-Viewer projection of the session viewer (the aux bridge's
 *  three-field `projectsApiUser` shape; anonymous → null requester). */
function apiViewerOf(viewer: Viewer, origin: string): ApiViewer {
  return {
    origin,
    requester:
      viewer.kind === "user" ? { id: viewer.id, login: viewer.username, is_admin: viewer.isAdmin } : null,
  };
}

/** HTML text escaping (Go html/template's set: `<` `>` `&` `'` `"` — the
 *  label names/descriptions sink into attribute + text positions here). */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;")
    .replaceAll("'", "&#39;");
}

// ---------------------------------------------------------------------------
// RenderLabels (modules/templates/util_render.go:71-131 + util/color.go)
// ---------------------------------------------------------------------------

/** `HexToRBGColor` (util/color.go:19-37): an OPTIONAL leading `#` is
 *  stripped first ("with or without #"), then bare hex of length 3/4/6/8
 *  only — 3/4 expand each digit, 8 truncates to 6, anything else decays to
 *  0,0,0; a non-hex payload fails Go's ParseUint and decays the same way. */
function hexToRgb(raw: string): [number, number, number] {
  let hex = raw.startsWith("#") ? raw.slice(1) : raw;
  if (hex.length === 3 || hex.length === 4) {
    hex = `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`;
  } else if (hex.length === 8) {
    hex = hex.slice(0, 6);
  }
  if (hex.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(hex)) return [0, 0, 0];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

/** `linearizeChannel` (util/color.go:47-52) — undo the sRGB transfer. */
function linearizeChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

/** `getRelativeLuminance` (util/color.go:59-62, WCAG relative luminance). */
function relativeLuminance(color: string): number {
  const [r, g, b] = hexToRgb(color);
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

/** `UseLightText` (util/color.go:65-67) — luminance < 0.36 reads as dark. */
function useLightText(backgroundColor: string): boolean {
  return relativeLuminance(backgroundColor) < 0.36;
}

/** `ContrastColor` (util/color.go:69-75) — the label's text color. */
function contrastColor(backgroundColor: string): string {
  return useLightText(backgroundColor) ? "#fff" : "#000";
}

/** `GetPerceivedBrightness` (util/color.go:64-67) — gamma-encoded space
 *  (NOT the luminance), the scoped arm's brightness input. */
function perceivedBrightness(color: string): number {
  const [r, g, b] = hexToRgb(color);
  return (0.2126729 * r + 0.7151521 * g + 0.072175 * b) / 255;
}

/** `ExclusiveScope` (models/issues/label.go:185-192): only exclusive labels
 *  scope; the scope is the text before the LAST "/" with both halves
 *  non-empty. */
function exclusiveScopeOf(label: LabelRow): string {
  if (!label.exclusive) return "";
  const cut = label.name.lastIndexOf("/");
  if (cut <= 0 || cut === label.name.length - 1) return "";
  return label.name.slice(0, cut);
}

/** The stored color, emitted VERBATIM into the CSS like upstream (upstream
 *  stores the hash — NormalizeColor adds it, label.go:29-51, VARCHAR(7) —
 *  and RenderLabel interpolates label.Color as-is; the color MATH
 *  normalizes through hexToRgb's optional-hash strip). */
function storedColor(label: LabelRow): string {
  return label.color ?? "";
}

function toHexByte(value: number): string {
  return Math.min(Math.round(value), 255).toString(16).padStart(2, "0");
}

/** `RenderLabel` (util_render.go:71-131) for ONE label row. The regular arm
 *  (:82-86) and both scoped arms (:87-131, `scope-parent` with the
 *  darken/lighten pair — the `scope-middle`+`scope-right` order div when
 *  exclusive_order > 0) port verbatim; RenderEmoji degrades to escaped
 *  plain text, and the archived arm (:75-80) prefixes the `archived` locale
 *  string ("Archived" at the pin). */
export function renderLabelHtml(label: LabelRow): string {
  const color = storedColor(label);
  const textColor = contrastColor(color);
  let descriptionText = label.description ?? "";
  let extraCssClasses = "";
  if (label.archivedAt !== null) {
    extraCssClasses = "archived-label";
    descriptionText = `(Archived) ${descriptionText}`;
  }

  const scope = exclusiveScopeOf(label);
  if (scope === "") {
    return (
      `<span class="ui label ${extraCssClasses}" style="color: ${textColor} !important;` +
      ` background-color: ${color} !important;" data-tooltip-content title="${escapeHtml(descriptionText)}">` +
      `<span class="gt-ellipsis">${escapeHtml(label.name)}</span></span>`
    );
  }

  // Scoped arm (:89-131): scope and item backgrounds derive from the label
  // color — scope darkened, item lightened, "more contrast needed with
  // higher brightness, empirically tweaked" (:91-100 verbatim).
  const brightness = perceivedBrightness(color);
  const contrast = 0.01 + brightness * 0.03;
  const darken = contrast + Math.max(brightness + contrast - 1.0, 0.0);
  const lighten = contrast + Math.max(contrast - brightness, 0.0);
  const darkenFactor = Math.max(brightness - darken, 0.0) / Math.max(brightness, 1.0 / 255.0);
  const lightenFactor = Math.min(brightness + lighten, 1.0) / Math.max(brightness, 1.0 / 255.0);
  const [r, g, b] = hexToRgb(color);
  const scopeColor = `#${toHexByte(r * darkenFactor)}${toHexByte(g * darkenFactor)}${toHexByte(b * darkenFactor)}`;
  const itemColor = `#${toHexByte(r * lightenFactor)}${toHexByte(g * lightenFactor)}${toHexByte(b * lightenFactor)}`;
  const scopeHtml = escapeHtml(scope);
  const itemHtml = escapeHtml(label.name.slice(scope.length + 1));

  if ((label.exclusiveOrder ?? 0) > 0) {
    // <scope> | <label> | <order> (:102-113)
    return (
      `<span class="ui label ${extraCssClasses} scope-parent" data-tooltip-content title="${escapeHtml(descriptionText)}">` +
      `<div class="ui label scope-left" style="color: ${textColor} !important; background-color: ${scopeColor} !important">${scopeHtml}</div>` +
      `<div class="ui label scope-middle" style="color: ${textColor} !important; background-color: ${itemColor} !important">${itemHtml}</div>` +
      `<div class="ui label scope-right">${label.exclusiveOrder}</div>` +
      `</span>`
    );
  }
  // <scope> | <label> (:114-124)
  return (
    `<span class="ui label ${extraCssClasses} scope-parent" data-tooltip-content title="${escapeHtml(descriptionText)}">` +
    `<div class="ui label scope-left" style="color: ${textColor} !important; background-color: ${scopeColor} !important">${scopeHtml}</div>` +
    `<div class="ui label scope-right" style="color: ${textColor} !important; background-color: ${itemColor} !important">${itemHtml}</div>` +
    `</span>`
  );
}

/** `RenderLabels` (util_render.go:230-249): the labels-list wrapper, each
 *  label an `<a class="item">` onto the LIST FILTER (`{RepoLink}/issues` or
 *  `/pulls` for PR rows, `?labels={id}`). */
export function renderedLabelsHtml(repoLink: string, isPull: boolean, labels: LabelRow[]): string {
  const baseLink = `${repoLink}/${isPull ? "pulls" : "issues"}`;
  const parts = labels.map((label) => `<a class="item" href="${baseLink}?labels=${label.id}">${renderLabelHtml(label)}</a>`);
  return `<span class="labels-list">${parts.join("")}</span>`;
}

// ---------------------------------------------------------------------------
// Arm 1 — GET /{type}/{index}/info (issue.go:242-269 GetIssueInfo)
// ---------------------------------------------------------------------------

/**
 * The info loader: resolve by index alone (no isPull cross-check — the
 * shared index namespace, see the module doc), convert through the landed
 * `toApiIssue`, render the labels HTML against the caller's repoLink.
 */
export async function loadIssueInfoFragment(
  d1: D1Database,
  repo: RepoRow,
  urlKind: "issues" | "pulls",
  index: number,
  origin: string,
  viewer: Viewer,
  repoLink: string,
): Promise<IssueInfoFragmentOutcome> {
  const issue = await findIssueByRepoAndIndex(d1, repo.id, index);
  if (issue === null) return { kind: "notFound" };
  const pair = await findRepositoryById(d1, repo.id);
  if (pair === null) return { kind: "notFound" }; // §4.8 orphaned repo row

  const convertedIssue = await toApiIssue(d1, apiViewerOf(viewer, origin), pair, issue);
  const labels = await issueLabelRows(d1, issue.id);
  return {
    kind: "ok",
    convertedIssue,
    // RenderLabels' pulls/issues baseLink follows the ROW (isPullRequest :=
    // issue.IsPull, util_render.go:231) — the urlKind param stays
    // informational (the shared index namespace, module doc).
    renderedLabels: renderedLabelsHtml(repoLink, issue.isPull, labels),
  };
}

/** `ctx.JSON(http.StatusOK, …)` (issue.go:264-268); the 404 arm is the web
 *  error page (ctx.HTTPError, issue.go:246-248) — the mount passes the
 *  rendered not-found shell like the issues-search sibling. */
export function issueInfoFragmentResponse(data: IssueInfoFragmentOutcome, notFoundHtml = ""): Response {
  if (data.kind === "notFound") {
    return new Response(notFoundHtml, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response(JSON.stringify({ convertedIssue: data.convertedIssue, renderedLabels: data.renderedLabels }), {
    status: 200,
    headers: jsonHeaders(),
  });
}

// ---------------------------------------------------------------------------
// Arm 2 — GET /{type}/{index}/attachments (issue.go:557-566)
// ---------------------------------------------------------------------------

/** Upstream loads the issue's DIRECT attachments only
 *  (`comment_id = 0`, models/repo/attachment.go:135-141) in pk order
 *  (unordered xorm Find on SQLite). */
export async function loadIssueAttachmentsFragment(d1: D1Database, issueId: number) {
  return drizzle(d1)
    .select()
    .from(issueAttachments)
    .where(and(eq(issueAttachments.issueId, issueId), eq(issueAttachments.commentId, 0)))
    .orderBy(asc(issueAttachments.id))
    .all();
}

/**
 * The wire arm — `convert.ToAttachment` (services/convert/attachment.go)
 * over the array; the shape is the landed `toApiAttachment`
 * (routes/issue-attachments.ts:618-630) re-declared: that twin is
 * module-private to the API route file, and this fragment serves the SAME
 * structs.Attachment JSON (id/name/created_at/download_count/size/uuid/
 * browser_download_url — no omitempty on the numbers, CreatedAt's zero
 * value degrades to a missing key exactly as the twin's undefined does).
 */
export function issueAttachmentsFragmentResponse(
  origin: string,
  rows: Array<typeof issueAttachments.$inferSelect>,
): Response {
  const attachments = rows.map((row) => ({
    id: row.id,
    name: row.name,
    created_at: row.createdAt === null || row.createdAt === undefined ? undefined : row.createdAt.toISOString(),
    download_count: row.downloadCount,
    size: row.size,
    uuid: row.uuid,
    browser_download_url: `${origin}/attachments/${encodeURIComponent(row.uuid)}`,
  }));
  return new Response(JSON.stringify(attachments), { status: 200, headers: jsonHeaders() });
}

// ---------------------------------------------------------------------------
// Arm 3 — GET /{type}/{index}/content-history/overview (issue_content_history.go:23-40)
// ---------------------------------------------------------------------------

/** The four strings the overview payload carries
 *  (locale_en-US.json `repo.issues.content_history.*` at the pin; the
 *  locale.ts owner moves them into the shell map when that key family
 *  lands). */
export const CONTENT_HISTORY_I18N = {
  textEdited: "edited", // "repo.issues.content_history.edited"
  textDeleteFromHistory: "Delete from history", // "…delete_from_history"
  textDeleteFromHistoryConfirm: "Delete from history?", // "…delete_from_history_confirm"
  textOptions: "Options", // "…options"
} as const;

/**
 * The edited-count map, reconstructed from the landed edit counters (the
 * module doc carries the full parity analysis): key "0" = the issue body,
 * otherwise the comment id — present exactly when the counter is > 0
 * (upstream's HAVING count(1) > 1), valued at counter + 1 (upstream counts
 * the first-created revision beside the edits).
 */
export async function loadContentHistoryOverviewFragment(
  d1: D1Database,
  issue: IssueRow,
): Promise<{ i18n: typeof CONTENT_HISTORY_I18N; editedHistoryCountMap: Record<string, number> }> {
  const editedHistoryCountMap: Record<string, number> = {};
  if (issue.contentVersion > 0) editedHistoryCountMap["0"] = issue.contentVersion + 1;
  const editedComments = await drizzle(d1)
    .select({ id: comments.id, contentVersion: comments.contentVersion })
    .from(comments)
    .where(and(eq(comments.issueId, issue.id), gt(comments.contentVersion, 0)))
    .all();
  for (const row of editedComments) editedHistoryCountMap[String(row.id)] = row.contentVersion + 1;
  return { i18n: CONTENT_HISTORY_I18N, editedHistoryCountMap };
}

/** `ctx.JSON(http.StatusOK, …)` (issue_content_history.go:38-39). */
export function contentHistoryOverviewFragmentResponse(data: {
  i18n: typeof CONTENT_HISTORY_I18N;
  editedHistoryCountMap: Record<string, number>;
}): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: jsonHeaders() });
}

/**
 * Shared issue resolution for the attachment/overview mounts (info resolves
 * internally): the family's existence arm — `GetActionIssue`'s
 * `GetIssueByIndex` miss → ctx.NotFound (issue.go:222-224 via
 * issue_action.go).
 */
export async function resolveFragmentIssue(d1: D1Database, repo: RepoRow, index: number): Promise<IssueRow | null> {
  return findIssueByRepoAndIndex(d1, repo.id, index);
}
