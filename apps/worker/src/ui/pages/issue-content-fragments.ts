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
 *   content_history.go:104-125) — and the snapshot table EXISTS since
 *   specs/issue-content-history.md (the write-path hooks fill it from the
 *   landed edit services), so the loader now runs the upstream query
 *   verbatim. History: before the table landed the map was reconstructed
 *   from the `content_version` edit counters (0 = never edited, +1 per
 *   body edit), which matches the table exactly until the 20-revision
 *   retention limiter saturates (upstream's count then DECREASES below the
 *   true edit count; the counter reconstruction kept the true count) and
 *   until soft-deleted revisions enter (they still count upstream — no
 *   filter in the query); the switch trades those divergences away. The
 *   i18n block carries the four strings verbatim from the pin's
 *   locale_en-US.json (`repo.issues.content_history.*` — edited /
 *   delete_from_history / delete_from_history_confirm / options); the
 *   locale.ts owner extends it there when the keys land in the shell map.
 * - CONTENT-HISTORY LIST — IMPLEMENTED (issue_content_history.go:42-88
 *   GetContentHistoryList; specs/issue-content-history.md): the dropdown
 *   payload `{"results": [{"name": <item HTML>, "value": <historyId>}…]}` —
 *   one entry per revision of (issue, comment_id), `edited_unix DESC`
 *   (FetchIssueContentHistoryList, content_history.go:149-171, LEFT JOIN
 *   the poster user row). `name` is the pre-rendered
 *   "avatar + <strong>userName</strong> + (fullName) + action + timeSince"
 *   HTML (AvatarHTML 24px + `/user/avatar/{name}/0` fast link or the
 *   default-avatar asset, the fullName segment only when non-empty, the
 *   deleted/created/edited action arms with upstream's
 *   `data-history-is-deleted` marker, and the `relative-time` stamp — all
 *   rendered module-locally, the attachments-twin re-declaration
 *   convention). An empty history marshals the nil slice as
 *   `{"results": null}` (upstream's []map[string]any zero value; fomantic
 *   treats it as no items).
 * - CONTENT-HISTORY DETAIL — IMPLEMENTED (issue_content_history.go:141-180
 *   GetContentHistoryDetail; specs/issue-content-history.md): the diff
 *   payload `{"canSoftDelete": <bool>, "historyId": <n>, "prevHistoryId":
 *   <n>, "diffHtml": <HTML>}`. `GetIssueContentHistoryAndPrev`
 *   (content_history.go:221-246) resolves the revision
 *   (`id AND issue_id` — a foreign id is the JSON 404
 *   `{"message": "Can not find the content history"}`) plus the newest
 *   non-deleted same-namespace revision strictly older by edited_unix;
 *   `diffHtml` is the diffContentHistory renderer (:112-138) —
 *   NormalizeStringEOL, diffmatchpatch DiffMain(checklines=false) +
 *   DiffCleanupEfficiency, wrapped in `<pre class="chroma">` with
 *   `<span class="gi">`/`<span class="gd">` around insertions/deletions,
 *   every text run HTML-escaped (the HTMLBuilder's WriteString arm). The
 *   dmp core (prefix/suffix trim, contains fast path, half-match, Myers
 *   bisect, cleanup-merge) plus the efficiency cleanup are ported
 *   module-locally; span boundaries may differ from go-diff in rare
 *   equal-cost cases and oversized inputs (combined > 200k chars) degrade
 *   to a single delete+insert — presentation-only divergences, SPEC §2.
 *   `canSoftDelete` is canSoftDeleteContentHistory (:84-110) through the
 *   landed `sessionRepoGrant` bridge (repo write) OR the poster-family arms
 *   (issue poster / comment poster / revision poster, scope-checked). The
 *   revision's comment row cannot be missing (the comment-delete hook
 *   removes its history rows), but the upstream miss arm (log + EMPTY 200
 *   body, :160-163) is mirrored as the `orphanedComment` outcome.
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
 * - `rest = [<index>, "content-history", "list"|"detail"]` → HANDOFF (the
 *   arms are EXPORTED but unmounted): extend the `IssueAuxRoute` family
 *   union, claim the two tails beside the overview parse (the
 *   `rest.length === 3` arm), and drive
 *   `loadContentHistoryListFragment(d1, issue, commentId)` +
 *   `contentHistoryListFragmentResponse(data)` (commentId = FormInt64 of
 *   the `comment_id` query param, 0 on a missing/garbage value) and
 *   `loadContentHistoryDetailFragment(env, repo, issue, viewer, commentId,
 *   historyId)` + `contentHistoryDetailFragmentResponse(data)` (the
 *   historyNotFound outcome IS the JSON 404 body — do not substitute the
 *   HTML shell). The exact recipes are in specs/issue-content-history.md §6.
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

import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Issue } from "../../api/models/issue";
import {
  findIssueByRepoAndIndex,
  issueLabelRows,
  toApiIssue,
} from "../../api/services/issues";
import { canWriteRepository } from "../../api/services/repo-access";
import {
  findRepositoryById,
  type Viewer as ApiViewer,
} from "../../api/services/repository";
import { comments, issueAttachments, issueContentHistory, users } from "../../db/schema";
import type { IssueRow, LabelRow } from "../../issues/service";
import { timeSinceParts } from "../page-data";
import { sessionRepoGrant } from "../repo-grants";
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
 * The edited-count map — `QueryIssueContentHistoryEditedCountMap`
 * (content_history.go:110-133) verbatim now that the snapshot table exists:
 * `SELECT comment_id, COUNT(1) … WHERE issue_id = ? GROUP BY comment_id
 * HAVING count(1) > 1`. Key "0" = the issue body, otherwise the comment id.
 * The 20-revision retention limiter and the is_deleted counting behavior
 * (soft-deleted revisions still count — no filter, like upstream) ride the
 * same rows the list/detail arms read, so the three arms cannot disagree.
 */
export async function loadContentHistoryOverviewFragment(
  d1: D1Database,
  issue: IssueRow,
): Promise<{ i18n: typeof CONTENT_HISTORY_I18N; editedHistoryCountMap: Record<string, number> }> {
  const rows = await drizzle(d1)
    .select({ commentId: issueContentHistory.commentId, historyCount: sql<number>`count(1)` })
    .from(issueContentHistory)
    .where(eq(issueContentHistory.issueId, issue.id))
    .groupBy(issueContentHistory.commentId)
    .having(sql`count(1) > 1`)
    .all();
  const editedHistoryCountMap: Record<string, number> = {};
  for (const row of rows) editedHistoryCountMap[String(row.commentId)] = Number(row.historyCount);
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

// ---------------------------------------------------------------------------
// Arm 4 — GET /{type}/{index}/content-history/list (issue_content_history.go:42-82)
// ---------------------------------------------------------------------------

/** `avatars.DefaultAvatarClass` (models/avatars/avatar.go:25) + the call
 *  site's " tw-mr-2" (issue_content_history.go:71). */
const AVATAR_CLASS = "ui avatar tw-align-middle tw-mr-2";

/** `avatars.DefaultAvatarLink()` — AppSubURL "" at the pin. */
const DEFAULT_AVATAR_LINK = "/assets/img/avatar_default.png";

/** The list-side locale strings (locale_en-US.json
 *  `repo.issues.content_history.{created,edited,deleted}` at the pin — the
 *  overview i18n block's siblings; same locale.ts-owner caveat). */
const CONTENT_HISTORY_ACTIONS = { created: "created", edited: "edited", deleted: "deleted" } as const;

/** `templates.AvatarHTML` (modules/templates/util_avatar.go:31-36): the
 *  empty alt keeps a failed image load from sizing to the alt text; an
 *  empty name degrades to "avatar" (util.IfZero). */
function avatarHtml(src: string, size: number, cssClass: string, name: string): string {
  const sizeStr = String(size);
  const title = name === "" ? "avatar" : name;
  return (
    `<img loading="lazy" alt class="${escapeHtml(cssClass)}" src="${escapeHtml(src)}"` +
    ` title="${escapeHtml(title)}" width="${sizeStr}" height="${sizeStr}">`
  );
}

/** `timeSinceTo` (modules/templates/util_date.go:106-125) at the server's
 *  zone — Workers run UTC, so the friendly stamp is the "+0000" convention
 *  (page-data.timeSinceParts). */
function timeSinceHtml(editedAt: Date): string {
  const parts = timeSinceParts(Math.floor(editedAt.getTime() / 1000), "+0000");
  return (
    `<relative-time prefix="" tense="${parts.tense}" datetime="${parts.datetime}"` +
    ` data-tooltip-content data-tooltip-interactive="true">${escapeHtml(parts.text)}</relative-time>`
  );
}

/** One dropdown entry: `name` is the item HTML, `value` the historyId
 *  (issue_content_history.go:73-76). */
export interface ContentHistoryListItem {
  readonly name: string;
  readonly value: number;
}

/** The fetched row shape (FetchIssueContentHistoryList's SELECT list,
 *  content_history.go:151-155 — LEFT JOIN the poster user row). */
interface ContentHistoryRow {
  readonly userId: number | null;
  readonly userName: string | null;
  readonly userFullName: string | null;
  readonly historyId: number;
  readonly posterId: number | null;
  readonly editedAt: Date;
  readonly isFirstCreated: boolean;
  readonly isDeleted: boolean;
}

async function fetchContentHistoryRows(d1: D1Database, issueId: number, commentId: number): Promise<ContentHistoryRow[]> {
  return drizzle(d1)
    .select({
      userId: users.id,
      userName: users.username,
      userFullName: users.fullName,
      historyId: issueContentHistory.id,
      posterId: issueContentHistory.posterId,
      editedAt: issueContentHistory.editedAt,
      isFirstCreated: issueContentHistory.isFirstCreated,
      isDeleted: issueContentHistory.isDeleted,
    })
    .from(issueContentHistory)
    .leftJoin(users, eq(users.id, issueContentHistory.posterId))
    .where(and(eq(issueContentHistory.issueId, issueId), eq(issueContentHistory.commentId, commentId)))
    // Upstream's single ORDER BY edited_unix DESC (content_history.go:156).
    .orderBy(desc(issueContentHistory.editedAt))
    .all();
}

/** The list payload builder: `{"results": null}` when empty (upstream's nil
 *  []map[string]any marshals to null, issue_content_history.go:54/79-81). */
export async function loadContentHistoryListFragment(
  d1: D1Database,
  issue: IssueRow,
  commentId: number,
): Promise<{ results: ContentHistoryListItem[] | null }> {
  const rows = await fetchContentHistoryRows(d1, issue.id, commentId);
  if (rows.length === 0) return { results: null };

  const results = rows.map((item) => {
    // The action arm (:56-63): the deleted marker rides an <i> the dropdown
    // checks by attribute (repo-issue-content.ts:121) before opening detail.
    const actionHtml = item.isDeleted
      ? `<i data-history-is-deleted="1">${CONTENT_HISTORY_ACTIONS.deleted}</i>`
      : item.isFirstCreated
        ? CONTENT_HISTORY_ACTIONS.created
        : CONTENT_HISTORY_ACTIONS.edited;

    // The fullName segment (:65-69), only when the trimmed name is non-empty.
    const fullName = (item.userFullName ?? "").trim();
    const fullNameHtml =
      fullName === ""
        ? ""
        : ` (<span class="tw-inline-flex tw-max-w-[160px]"><span class="gt-ellipsis">${escapeHtml(fullName)}</span></span>)`;

    // The avatar (:71 + content_history.go:163-169): a joined user row gets
    // the /user/avatar/{name}/0 fast link, everything else the default asset.
    const userName = item.userName ?? "";
    const avatarLink = item.userId !== null && item.userId > 0
      ? `/user/avatar/${encodeURIComponent(userName)}/0`
      : DEFAULT_AVATAR_LINK;
    const avatar = avatarHtml(avatarLink, 24, AVATAR_CLASS, userName);

    // HTMLFormat("%s <strong>%s</strong>%s %s %s", avatar, userName,
    // fullNameHTML, actionHTML, timeSinceHTML) (:74) — the string arg
    // escapes, the HTML args pass through.
    const name = `${avatar} <strong>${escapeHtml(userName)}</strong>${fullNameHtml} ${actionHtml} ${timeSinceHtml(item.editedAt)}`;
    return { name, value: item.historyId };
  });
  return { results };
}

/** `ctx.JSON(http.StatusOK, map[string]any{"results": …})` (:79-81). */
export function contentHistoryListFragmentResponse(data: { results: ContentHistoryListItem[] | null }): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: jsonHeaders() });
}

/** Go FormInt64 (services/context/form.go): missing/garbage parses to 0 —
 *  the issue-body namespace. */
export function formInt64(value: string | null): number {
  if (value === null || !/^-?\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Arm 5 — GET /{type}/{index}/content-history/detail (issue_content_history.go:141-180)
// ---------------------------------------------------------------------------

/** The detail loader's outcomes: `historyNotFound` is upstream's JSON 404
 *  (`ctx.JSON(404, {"message": …})`, :150-153 — NOT the HTML shell);
 *  `orphanedComment` mirrors the impossible-in-practice comment-miss arm
 *  (:160-163 — log + return, an EMPTY 200 body). */
export type ContentHistoryDetailOutcome =
  | {
      readonly kind: "ok";
      readonly canSoftDelete: boolean;
      readonly historyId: number;
      readonly prevHistoryId: number;
      readonly diffHtml: string;
    }
  | { readonly kind: "historyNotFound" }
  | { readonly kind: "orphanedComment" };

/** `canSoftDeleteContentHistory` (:84-110): repo write (IsOwner or
 *  CanWriteIssuesOrPulls — the landed `canWriteRepository` through the
 *  sessionRepoGrant bridge, the file-editor convention) OR a signed-in
 *  viewer who posted the issue/comment/the revision, scope-checked. */
async function canSoftDeleteContentHistory(
  env: Env,
  repo: RepoRow,
  issue: IssueRow,
  viewer: Viewer,
  comment: typeof comments.$inferSelect | null,
  history: typeof issueContentHistory.$inferSelect,
): Promise<boolean> {
  if (await sessionRepoGrant(env, repo, viewer, canWriteRepository)) return true;
  if (viewer.kind !== "user") return false;
  if (comment === null) {
    return (viewer.id === issue.posterId || viewer.id === history.posterId) && history.issueId === issue.id;
  }
  return (
    (viewer.id === comment.posterId || viewer.id === history.posterId) &&
    history.issueId === issue.id &&
    history.commentId === comment.id
  );
}

/**
 * The detail loader: `GetIssueContentHistoryAndPrev`
 * (content_history.go:221-246) — the revision scoped to this issue, plus
 * the newest NON-DELETED same-namespace revision strictly older by
 * edited_unix (absent → prevHistoryId 0, diff against ""); then the
 * canSoftDelete grant and the diffHtml render. `env` (not bare d1) because
 * the write-grant arm rides sessionRepoGrant.
 */
export async function loadContentHistoryDetailFragment(
  env: Env,
  repo: RepoRow,
  issue: IssueRow,
  viewer: Viewer,
  commentId: number,
  historyId: number,
): Promise<ContentHistoryDetailOutcome> {
  // The `AND issue_id = ?` scope (:223) makes a foreign history id the 404.
  const historyRows = await drizzle(d1Of(env))
    .select()
    .from(issueContentHistory)
    .where(and(eq(issueContentHistory.id, historyId), eq(issueContentHistory.issueId, issue.id)))
    .limit(1)
    .all();
  const history = historyRows[0];
  if (history === undefined) return { kind: "historyNotFound" };

  // The comment read (:157-164) — only for comment-scoped revisions; the
  // delete hook guarantees the row exists, the miss arm mirrors upstream's
  // empty-200 quirk anyway.
  let comment: typeof comments.$inferSelect | null = null;
  if (history.commentId !== 0) {
    const found = await drizzle(d1Of(env)).select().from(comments).where(eq(comments.id, history.commentId)).limit(1).all();
    comment = found[0] ?? null;
    if (comment === null) return { kind: "orphanedComment" };
  }

  const prevRows = await drizzle(d1Of(env))
    .select({ id: issueContentHistory.id, contentText: issueContentHistory.contentText })
    .from(issueContentHistory)
    .where(
      and(
        eq(issueContentHistory.issueId, history.issueId),
        eq(issueContentHistory.commentId, history.commentId),
        eq(issueContentHistory.isDeleted, false),
        lt(issueContentHistory.editedAt, history.editedAt),
      ),
    )
    .orderBy(desc(issueContentHistory.editedAt))
    .limit(1)
    .all();
  const prev = prevRows[0] ?? null;

  return {
    kind: "ok",
    canSoftDelete: await canSoftDeleteContentHistory(env, repo, issue, viewer, comment, history),
    historyId: history.id,
    prevHistoryId: prev?.id ?? 0,
    diffHtml: diffContentHistoryHtml(prev?.contentText ?? "", history.contentText),
  };
}

/** `ctx.JSON` per outcome (:150-153 the 404, :174-179 the payload). */
export function contentHistoryDetailFragmentResponse(data: ContentHistoryDetailOutcome): Response {
  if (data.kind === "historyNotFound") {
    return new Response(JSON.stringify({ message: "Can not find the content history" }), {
      status: 404,
      headers: jsonHeaders(),
    });
  }
  if (data.kind === "orphanedComment") {
    return new Response(null, { status: 200 }); // upstream's unwritten-body quirk
  }
  return new Response(
    JSON.stringify({
      canSoftDelete: data.canSoftDelete,
      historyId: data.historyId,
      prevHistoryId: data.prevHistoryId,
      diffHtml: data.diffHtml,
    }),
    { status: 200, headers: jsonHeaders() },
  );
}

/** The fragment loaders take D1Database; the detail's grant bridge takes
 *  Env — the single-field projection keeps both call shapes honest. */
function d1Of(env: Env): D1Database {
  return env.DB;
}

// ---------------------------------------------------------------------------
// diffContentHistory — the diffmatchpatch core port (:112-138)
// ---------------------------------------------------------------------------

/** Diff_EditCost's default (4) — cleanupEfficiency's merge threshold. */
const DMP_EDIT_COST = 4;

type DmpOp = { tag: -1 | 0 | 1; text: string }; // -1 delete, 0 equal, 1 insert

function dmpCommonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

function dmpCommonSuffixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * `NormalizeStringEOL` (modules/util/util.go:308-317): textarea line
 * endings are \r\n; the diff compares \n only.
 */
function normalizeStringEol(input: string): string {
  return input.replaceAll("\r\n", "\n");
}

/** `DiffMain` (checklines=false): trim prefix/suffix, compute, restore,
 *  cleanup-merge — the go-diff diffMainRunes shape. */
function dmpDiffMain(text1: string, text2: string): DmpOp[] {
  if (text1 === text2) return text1 === "" ? [] : [{ tag: 0, text: text1 }];

  let body1 = text1;
  let body2 = text2;
  const prefix = body1.slice(0, dmpCommonPrefixLength(body1, body2));
  body1 = body1.slice(prefix.length);
  body2 = body2.slice(prefix.length);
  const suffix = body1.slice(body1.length - dmpCommonSuffixLength(body1, body2));
  body1 = body1.slice(0, body1.length - suffix.length);
  body2 = body2.slice(0, body2.length - suffix.length);

  const diffs = dmpDiffCompute(body1, body2);
  if (prefix !== "") diffs.unshift({ tag: 0, text: prefix });
  if (suffix !== "") diffs.push({ tag: 0, text: suffix });
  return dmpCleanupMerge(diffs);
}

/** `diffCompute` (go-diff): the empty arms, the contains fast path, the
 *  short-input arm, the half-match split, and the Myers bisect fallback. */
function dmpDiffCompute(text1: string, text2: string): DmpOp[] {
  if (text1 === "") return [{ tag: 1, text: text2 }];
  if (text2 === "") return [{ tag: -1, text: text1 }];

  const longtext = text1.length > text2.length ? text1 : text2;
  const shorttext = text1.length > text2.length ? text2 : text1;

  const i = longtext.indexOf(shorttext);
  if (i !== -1) {
    // The shorter text sits whole inside the longer: the surrounding
    // longtext is one pure op around the common middle.
    const op: -1 | 1 = text1.length > text2.length ? -1 : 1;
    const diffs: DmpOp[] = [];
    if (i !== 0) diffs.push({ tag: op, text: longtext.slice(0, i) });
    diffs.push({ tag: 0, text: shorttext });
    if (i + shorttext.length !== longtext.length) diffs.push({ tag: op, text: longtext.slice(i + shorttext.length) });
    return diffs;
  }
  if (shorttext.length < 2) {
    // No contains match with a 1-char short text: pure delete+insert.
    return [
      { tag: -1, text: text1 },
      { tag: 1, text: text2 },
    ];
  }

  const half = dmpHalfMatch(text1, text2);
  if (half !== null) {
    const diffsA = dmpDiffMain(half.text1A, half.text2A);
    const diffsB = dmpDiffMain(half.text1B, half.text2B);
    return [...diffsA, { tag: 0, text: half.midCommon }, ...diffsB];
  }
  return dmpBisect(text1, text2);
}

/** `diffHalfMatchI` (JS dmp): the seed at `i` matched anywhere in the
 *  short text, keeping the longest expansion. */
function dmpHalfMatchI(longtext: string, shorttext: string, i: number) {
  const seed = longtext.slice(i, Math.round(i + longtext.length / 4));
  let j = -1;
  let bestCommon = "";
  let bestLongtextA = "";
  let bestLongtextB = "";
  let bestShorttextA = "";
  let bestShorttextB = "";
  while ((j = shorttext.indexOf(seed, j + 1)) !== -1) {
    const prefixLength = dmpCommonPrefixLength(longtext.slice(i), shorttext.slice(j));
    const suffixLength = dmpCommonSuffixLength(longtext.slice(0, i), shorttext.slice(0, j));
    if (bestCommon.length < suffixLength + prefixLength) {
      bestCommon = shorttext.slice(j - suffixLength, j) + shorttext.slice(j, j + prefixLength);
      bestLongtextA = longtext.slice(0, i - suffixLength);
      bestLongtextB = longtext.slice(i + prefixLength);
      bestShorttextA = shorttext.slice(0, j - suffixLength);
      bestShorttextB = shorttext.slice(j + prefixLength);
    }
  }
  if (bestCommon.length * 2 >= longtext.length) {
    return { bestLongtextA, bestLongtextB, bestShorttextA, bestShorttextB, bestCommon };
  }
  return null;
}

/** `diffHalfMatch_`: split the problem around a common middle at least
 *  half the long text's length (seeded at the 1/4 and 1/2 marks). */
function dmpHalfMatch(text1: string, text2: string) {
  const longtext = text1.length > text2.length ? text1 : text2;
  const shorttext = text1.length > text2.length ? text2 : text1;
  if (longtext.length < 4 || shorttext.length * 2 < longtext.length) return null;

  const hm1 = dmpHalfMatchI(longtext, shorttext, Math.ceil(longtext.length / 4));
  const hm2 = dmpHalfMatchI(longtext, shorttext, Math.ceil(longtext.length / 2));
  const hm = hm1 === null ? hm2 : hm2 === null || hm1.bestCommon.length > hm2.bestCommon.length ? hm1 : hm2;
  if (hm === null) return null;

  const midCommon = hm.bestCommon;
  if (longtext === text1) {
    return { text1A: hm.bestLongtextA, text1B: hm.bestLongtextB, text2A: hm.bestShorttextA, text2B: hm.bestShorttextB, midCommon };
  }
  return { text1A: hm.bestShorttextA, text1B: hm.bestShorttextB, text2A: hm.bestLongtextA, text2B: hm.bestLongtextB, midCommon };
}

/** `diffBisect_`: the Myers O(ND) middle-snake meet, front and back
 *  traces advancing in lockstep (UTF-16 units, no deadline — the size
 *  guard lives at the renderer). */
function dmpBisect(text1: string, text2: string): DmpOp[] {
  const text1Length = text1.length;
  const text2Length = text2.length;
  const maxD = Math.ceil((text1Length + text2Length) / 2);
  const vOffset = maxD;
  const vLength = 2 * maxD;
  // +2: the JS reference relies on array growth for the v[kOffset+1]
  // sentinel at the top k — the Int32Array keeps that slot allocated.
  const v1 = new Int32Array(vLength + 2).fill(-1);
  const v2 = new Int32Array(vLength + 2).fill(-1);
  v1[vOffset + 1] = 0;
  v2[vOffset + 1] = 0;
  const delta = text1Length - text2Length;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  // Every algorithmic read lands in-bounds by construction (|k| ≤ maxD);
  // the fallback -1 keeps the type honest for the strict index reads.
  const vAt = (v: Int32Array, i: number): number => v[i] ?? -1;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1Offset = vOffset + k1;
      let x1: number;
      if (k1 === -d || (k1 !== d && vAt(v1, k1Offset - 1) < vAt(v1, k1Offset + 1))) {
        x1 = vAt(v1, k1Offset + 1);
      } else {
        x1 = vAt(v1, k1Offset - 1) + 1;
      }
      let y1 = x1 - k1;
      while (x1 < text1Length && y1 < text2Length && text1[x1] === text2[y1]) {
        x1++;
        y1++;
      }
      v1[k1Offset] = x1;
      if (x1 > text1Length) {
        k1end += 2;
      } else if (y1 > text2Length) {
        k1start += 2;
      } else if (front) {
        const k2Offset = vOffset + delta - k1;
        const v2At = k2Offset >= 0 ? vAt(v2, k2Offset) : -1;
        if (k2Offset >= 0 && k2Offset < vLength && v2At !== -1) {
          const x2 = text1Length - v2At;
          if (x1 >= x2) return dmpBisectSplit(text1, text2, x1, y1);
        }
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2Offset = vOffset + k2;
      let x2: number;
      if (k2 === -d || (k2 !== d && vAt(v2, k2Offset - 1) < vAt(v2, k2Offset + 1))) {
        x2 = vAt(v2, k2Offset + 1);
      } else {
        x2 = vAt(v2, k2Offset - 1) + 1;
      }
      let y2 = x2 - k2;
      while (x2 < text1Length && y2 < text2Length && text1[text1Length - x2 - 1] === text2[text2Length - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[k2Offset] = x2;
      if (x2 > text1Length) {
        k2end += 2;
      } else if (y2 > text2Length) {
        k2start += 2;
      } else if (!front) {
        const k1Offset = vOffset + delta - k2;
        const v1At = k1Offset >= 0 ? vAt(v1, k1Offset) : -1;
        if (k1Offset >= 0 && k1Offset < vLength && v1At !== -1) {
          const x1 = v1At;
          const y1 = vOffset + x1 - k1Offset;
          if (x1 >= text1Length - x2) return dmpBisectSplit(text1, text2, x1, y1);
        }
      }
    }
  }
  // Timeout-equivalent: no commonality at all — pure delete+insert.
  return [
    { tag: -1, text: text1 },
    { tag: 1, text: text2 },
  ];
}

/** `diffBisectSplit_`: recurse on both sides of the found middle. */
function dmpBisectSplit(text1: string, text2: string, x: number, y: number): DmpOp[] {
  return [...dmpDiffMain(text1.slice(0, x), text2.slice(0, y)), ...dmpDiffMain(text1.slice(x), text2.slice(y))];
}

/** `diffCleanupMerge` (JS dmp, both passes): merge same-type runs, factor
 *  equalities out of delete/insert pairs, then shift single edits
 *  surrounded by equalities sideways. */
function dmpCleanupMerge(diffs: DmpOp[]): DmpOp[] {
  diffs.push({ tag: 0, text: "" });
  let pointer = 0;
  let countDelete = 0;
  let countInsert = 0;
  let textDelete = "";
  let textInsert = "";
  while (pointer < diffs.length) {
    const op = diffs[pointer];
    if (op === undefined) break;
    if (op.tag === 1) {
      countInsert++;
      textInsert += op.text;
      pointer++;
    } else if (op.tag === -1) {
      countDelete++;
      textDelete += op.text;
      pointer++;
    } else {
      if (countDelete + countInsert > 1) {
        if (countDelete !== 0 && countInsert !== 0) {
          // Factor out any common prefix.
          let commonLength = dmpCommonPrefixLength(textInsert, textDelete);
          if (commonLength !== 0) {
            const before = diffs[pointer - countDelete - countInsert - 1];
            if ((pointer - countDelete - countInsert) > 0 && before !== undefined && before.tag === 0) {
              before.text += textInsert.slice(0, commonLength);
            } else {
              diffs.unshift({ tag: 0, text: textInsert.slice(0, commonLength) });
              pointer++;
            }
            textInsert = textInsert.slice(commonLength);
            textDelete = textDelete.slice(commonLength);
          }
          // Factor out any common suffix.
          commonLength = dmpCommonSuffixLength(textInsert, textDelete);
          if (commonLength !== 0) {
            const at = diffs[pointer];
            if (at !== undefined) at.text = textInsert.slice(textInsert.length - commonLength) + at.text;
            textInsert = textInsert.slice(0, textInsert.length - commonLength);
            textDelete = textDelete.slice(0, textDelete.length - commonLength);
          }
        }
        pointer -= countDelete + countInsert;
        diffs.splice(pointer, countDelete + countInsert);
        if (countDelete !== 0) {
          diffs.splice(pointer, 0, { tag: -1, text: textDelete });
          pointer++;
        }
        if (countInsert !== 0) {
          diffs.splice(pointer, 0, { tag: 1, text: textInsert });
          pointer++;
        }
      } else if (pointer !== 0 && diffs[pointer - 1]?.tag === 0) {
        const prev = diffs[pointer - 1];
        if (prev !== undefined) prev.text += op.text;
        diffs.splice(pointer, 1);
      } else {
        pointer++;
      }
      countInsert = 0;
      countDelete = 0;
      textDelete = "";
      textInsert = "";
    }
  }
  const last = diffs[diffs.length - 1];
  if (last !== undefined && last.text === "") diffs.pop();

  // Second pass: shift a single edit surrounded by equalities sideways
  // (A<ins>BA</ins>C → <ins>AB</ins>AC).
  let changes = false;
  pointer = 1;
  while (pointer < diffs.length - 1) {
    const prev = diffs[pointer - 1];
    const cur = diffs[pointer];
    const next = diffs[pointer + 1];
    if (prev?.tag === 0 && next?.tag === 0 && cur !== undefined) {
      if (cur.text.slice(cur.text.length - prev.text.length) === prev.text) {
        cur.text = prev.text + cur.text.slice(0, cur.text.length - prev.text.length);
        next.text = prev.text + next.text;
        diffs.splice(pointer - 1, 1);
        changes = true;
      } else if (cur.text.slice(0, next.text.length) === next.text) {
        prev.text += next.text;
        cur.text = cur.text.slice(next.text.length) + next.text;
        diffs.splice(pointer + 1, 1);
        changes = true;
      }
    }
    pointer++;
  }
  return changes ? dmpCleanupMerge(diffs) : diffs;
}

/** `DiffCleanupEfficiency` (go-diff): eliminate equalities shorter than
 *  Diff_EditCost that sandwich delete/insert pairs, when merging them
 *  shortens the edit script. */
function dmpCleanupEfficiency(diffs: DmpOp[]): void {
  const equalities: number[] = [];
  let lastequality: string | null = null;
  let pointer = 0;
  let preIns = false;
  let preDel = false;
  let postIns = false;
  let postDel = false;
  let changes = false;
  while (pointer < diffs.length) {
    const op = diffs[pointer];
    if (op === undefined) break;
    if (op.tag === 0) {
      if (op.text.length < DMP_EDIT_COST && (postIns || postDel)) {
        equalities.push(pointer);
        preIns = postIns;
        preDel = postDel;
        lastequality = op.text;
      } else {
        equalities.length = 0;
        lastequality = null;
      }
      postIns = false;
      postDel = false;
    } else {
      if (op.tag === -1) postDel = true;
      else postIns = true;
      if (
        lastequality !== null &&
        ((preIns && preDel && postIns && postDel) ||
          (lastequality.length < DMP_EDIT_COST / 2 && Number(preIns) + Number(preDel) + Number(postIns) + Number(postDel) === 3))
      ) {
        const insertionIndex = equalities.pop() ?? -1;
        if (insertionIndex >= 0) {
          diffs.splice(insertionIndex, 0, { tag: -1, text: lastequality });
          const twin = diffs[insertionIndex + 1];
          if (twin !== undefined) twin.tag = 1;
          lastequality = null;
          if (preIns && preDel) {
            postIns = true;
            postDel = true;
            equalities.length = 0;
          } else {
            const top = equalities[equalities.length - 1];
            pointer = top ?? -1;
            postIns = false;
            postDel = false;
          }
          changes = true;
        }
      }
    }
    pointer++;
  }
  if (changes) dmpCleanupMerge(diffs);
}

/**
 * `diffContentHistory` (issue_content_history.go:112-138): NormalizeEOL
 * both sides, DiffMain(checklines=false) + DiffCleanupEfficiency, then the
 * `<pre class="chroma">` render — insertions in `<span class="gi">`,
 * deletions in `<span class="gd">`, equal text bare, every text run
 * HTML-escaped (the HTMLBuilder's WriteString arm). Inputs beyond 200k
 * UTF-16 units combined skip the bisect and render as one delete+insert
 * pair (upstream bounds the same work with a 1 s deadline).
 */
export function diffContentHistoryHtml(oldContent: string, newContent: string): string {
  const oldText = normalizeStringEol(oldContent);
  const newText = normalizeStringEol(newContent);
  let diffs: DmpOp[];
  if (oldText.length + newText.length > 200_000) {
    diffs = [
      { tag: -1, text: oldText },
      { tag: 1, text: newText },
    ];
  } else {
    diffs = dmpDiffMain(oldText, newText);
    dmpCleanupEfficiency(diffs);
  }

  let html = `<pre class="chroma">`;
  for (const diff of diffs) {
    if (diff.tag === 1) {
      html += `<span class="gi">${escapeHtml(diff.text)}</span>`;
    } else if (diff.tag === -1) {
      html += `<span class="gd">${escapeHtml(diff.text)}</span>`;
    } else {
      html += escapeHtml(diff.text);
    }
  }
  return `${html}</pre>`;
}
