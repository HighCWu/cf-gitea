/**
 * The repo Actions WORKFLOW BADGE — the ui-parity survey's F-row tail GET #3
 * (docs/compat/ui-parity-survey.md's F actions row): the shields-style
 * status SVG a README embeds. NOT a page — an asset arm (the archive-files
 * family shape).
 *
 * Upstream pin (VERIFIED at fc4936884584a41931906553d96c2601d750e6ef):
 *
 *   - Route: web.go:1606 `m.Group("/workflows/{workflow_name}", func() {
 *     m.Get("/badge.svg", webAuth.AllowBasic, webAuth.AllowOAuth2,
 *     actions.GetWorkflowBadge) })` inside the `/actions` group — the SAME
 *     read-group middleware ladder (`optSignIn, RepoAssignment,
 *     MustBeNotEmpty, reqRepoActionsReader, MustEnableActions`): a badge for
 *     a private repo 404s for anonymous, exactly like every other read arm.
 *   - Handler: routers/web/repo/actions/badge.go:20-46 — `?branch=`
 *     (default the repo's default branch) / `?event=` / `?style=` params;
 *     `GetWorkflowLatestRun` (models/actions/run.go:328-348: repo_id + ref
 *     `refs/heads/{branch}` + workflow_id + is_scoped_run = false [+ event
 *     when set], newest by id DESC) →
 *     - miss → `GenerateBadge(name, "no status", DefaultColor)`;
 *     - status missing from StatusColorMap (modules/badge/badge.go:75-85:
 *     cancelling/pending are NOT mapped) → "unknown status" + DefaultColor;
 *     - else the status name + its color. `name` is the workflow file
 *     minus its extension (badge.go:49-50).
 *   - Render: `ctx.HTML(200, "shared/actions/runner_badge_flat[-square]")`
 *     after `ctx.RespHeader().Set("Content-Type", "image/svg+xml")` — the
 *     two templates are ported VERBATIM (including the empty IDPrefix —
 *     ctx.Data never sets it, so the gradient/clip ids are bare `s`/`r`).
 *     Text interpolations carry Go html/template's escaper (the SVG is
 *     served as image/svg+xml through the HTML renderer, so & < > ' " all
 *     entity-escape, the htmlEscaper table).
 *
 * ## Documented divergences (§6 method)
 *
 * - `CheckRepoScopedToken(ctx, auth_model.Read)` + webAuth.AllowBasic/
 *   AllowOAuth2 (badge.go:21, web.go:1606): the API-token auth arms have no
 *   UI-layer analog — the UI session resolver IS this route's
 *   authentication. A README-image consumer on a PUBLIC repo passes
 *   anonymously (upstream too); a private repo's badge requires the
 *   browser session (upstream additionally admits scoped tokens).
 * - The workflow_id match gains the path-spelling tolerance (eq OR a
 *   `/{workflow_name}` suffix — the repo-actions-workflow module's store
 *   divergence: M1a producers wrote path-spelled ids; upstream stores bare
 *   names and matches `workflow_id = ?` exactly). The is_scoped_run = false
 *   filter ports verbatim (run.go:334's own TODO — a scoped run must not
 *   leak into the repo badge).
 * - Widths are the DejaVuSans-advance table ported whole
 *   (modules/badge/badge_glyph_width.go — generated from the font at the
 *   pin; a missing PRINTABLE glyph takes 'm''s width 11, non-printables
 *   count 0, badge.go:114-127). Labels render TrimSpace'd.
 *
 * ## HANDOFF (the ui/index.ts mount — the integrator window's arms)
 *
 * 1. Interface: a NEW one-shape family (the workflow_name param is the raw
 *    segment):
 *
 *     export interface RepoActionsWorkflowBadgeRoute {
 *       family: "repo-actions-workflow-badge";
 *       owner: string;
 *       repo: string;
 *       workflowName: string;
 *     }
 *
 * 2. Parse arm (the `/actions` block, AFTER the runs subtree's arms — the
 *    disjoint `workflows` first segment):
 *    `if (head === "actions" && rest.length === 3 && rest[0] === "workflows" && rest[2] === "badge.svg")
 *    return { family: "repo-actions-workflow-badge", owner, repo, workflowName: rest[1] as string };`
 *    — the exact 3-segment shape; deeper/other tails stay unclaimed → the
 *    engine's 404.
 * 3. Import: `import { renderWorkflowBadgeSvg, resolveWorkflowBadge }
 *    from "./pages/repo-actions-badge";`
 * 4. Handler (the C1 read ladder verbatim — anonymous reads pass):
 *
 *     async function repoActionsWorkflowBadgeRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
 *       const resolved = await resolveUiRequest(c);
 *       if (!resolved.ok) return resolved.response;
 *       const { ctx, url, repo, respond } = resolved;
 *       if (resolved.route.family !== "repo-actions-workflow-badge") return respond(await c.notFound()); // drift guard
 *       if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
 *       const settings = await loadRepoSettings(c.env.DB, repo.id);
 *       if (!settings.hasActions) return respond(c.html(renderNotFound(ctx), 404));
 *       const badge = await resolveWorkflowBadge(c.env.DB, repo, {
 *         workflowName: resolved.route.workflowName,
 *         branch: url.searchParams.get("branch") ?? undefined,
 *         event: url.searchParams.get("event") ?? undefined,
 *         style: url.searchParams.get("style") ?? undefined,
 *       });
 *       return respond(new Response(renderWorkflowBadgeSvg(badge), {
 *         status: 200,
 *         headers: { "content-type": "image/svg+xml" },
 *       }));
 *     }
 *
 * 5. Registration (the `/actions` group's block — chi registers the badge
 *    subgroup last inside the group, web.go:1605-1607):
 *    `uiRouter.get("/:owner/:repo/actions/workflows/:workflowName/badge.svg", (c) => repoActionsWorkflowBadgeRoute(c));`
 *    `uiRouter.post("/:owner/:repo/actions/workflows/:workflowName/badge.svg", () => methodNotAllowed("GET"));`
 * 6. No neighbor pin flips: the badge shape is pinned NOWHERE unclaimed
 *    (the runs-list matrix's sibling-tail list never carried it; the
 *    C1 module header notes the route unlanded prose-only).
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRuns } from "../../db/schema";

type D1 = D1Database;

// ---------------------------------------------------------------------------
// The status names + colors (models/actions/status.go's String map +
// modules/badge/badge.go:75-85)
// ---------------------------------------------------------------------------

/** The 10-value status → String() names (the repo-actions-view module's
 *  STATUS_NAMES twin — module-local so the badge endpoint's bundle never
 *  pulls the run-viewer; the dedup note rides the same precedent). */
const STATUS_NAMES: Record<number, string> = {
  0: "unknown",
  1: "success",
  2: "failure",
  3: "cancelled",
  4: "skipped",
  5: "waiting",
  6: "running",
  7: "blocked",
  8: "cancelling",
  9: "pending",
};

export function badgeStatusName(status: number): string {
  return STATUS_NAMES[status] ?? "unknown";
}

/** StatusColorMap (badge.go:75-85) — cancelling(8)/pending(9) unmapped, the
 *  "unknown status" arm's exact membership. */
export const BADGE_STATUS_COLORS: Record<number, string> = {
  1: "#4c1", // success — Green
  4: "#dfb317", // skipped — Yellow
  0: "#97ca00", // unknown — Light Green
  2: "#e05d44", // failure — Red
  3: "#fe7d37", // cancelled — Orange
  5: "#dfb317", // waiting — Yellow
  6: "#dfb317", // running — Yellow
  7: "#dfb317", // blocked — Yellow
};

/** badge.DefaultColor (badge.go:46) — Grey. */
export const BADGE_DEFAULT_COLOR = "#9f9f9f";

/** badge.DefaultFontFamily (badge.go:47). */
const BADGE_FONT_FAMILY = "DejaVu Sans,Verdana,Geneva,sans-serif";

/** badge.StyleFlatSquare (badge.go:35) — the only style param value that
 *  changes the template (badge.go:40-45's switch). */
export const BADGE_STYLE_FLAT_SQUARE = "flat-square";

// ---------------------------------------------------------------------------
// The DejaVu advance table (badge_glyph_width.go, verbatim)
// ---------------------------------------------------------------------------

/** DejaVuGlyphWidthData (badge_glyph_width.go:14-206) — generated from
 *  DejaVu Sans v2.37 at size 11; keyed by rune code point. */
const DEJAVU_GLYPH_WIDTH: Record<number, number> = {
  32: 3, 33: 4, 34: 5, 35: 9, 36: 7, 37: 10, 38: 9, 39: 3, 40: 4, 41: 4,
  42: 6, 43: 9, 44: 3, 45: 4, 46: 3, 47: 4, 48: 7, 49: 7, 50: 7, 51: 7,
  52: 7, 53: 7, 54: 7, 55: 7, 56: 7, 57: 7, 58: 4, 59: 4, 60: 9, 61: 9,
  62: 9, 63: 6, 64: 11, 65: 8, 66: 8, 67: 8, 68: 8, 69: 7, 70: 6, 71: 9,
  72: 8, 73: 3, 74: 3, 75: 7, 76: 6, 77: 9, 78: 8, 79: 9, 80: 7, 81: 9,
  82: 8, 83: 7, 84: 7, 85: 8, 86: 8, 87: 11, 88: 8, 89: 7, 90: 8, 91: 4,
  92: 4, 93: 4, 94: 9, 95: 6, 96: 6, 97: 7, 98: 7, 99: 6, 100: 7, 101: 7,
  102: 4, 103: 7, 104: 7, 105: 3, 106: 3, 107: 6, 108: 3, 109: 11, 110: 7,
  111: 7, 112: 7, 113: 7, 114: 5, 115: 6, 116: 4, 117: 7, 118: 7, 119: 9,
  120: 7, 121: 7, 122: 6, 123: 7, 124: 4, 125: 7, 126: 9, 161: 4, 162: 7,
  163: 7, 164: 7, 165: 7, 166: 4, 167: 6, 168: 6, 169: 11, 170: 5, 171: 7,
  172: 9, 174: 11, 175: 6, 176: 6, 177: 9, 178: 4, 179: 4, 180: 6, 181: 7,
  182: 7, 183: 3, 184: 6, 185: 4, 186: 5, 187: 7, 188: 11, 189: 11, 190: 11,
  191: 6, 192: 8, 193: 8, 194: 8, 195: 8, 196: 8, 197: 8, 198: 11, 199: 8,
  200: 7, 201: 7, 202: 7, 203: 7, 204: 3, 205: 3, 206: 3, 207: 3, 208: 9,
  209: 8, 210: 9, 211: 9, 212: 9, 213: 9, 214: 9, 215: 9, 216: 9, 217: 8,
  218: 8, 219: 8, 220: 8, 221: 7, 222: 7, 223: 7, 224: 7, 225: 7, 226: 7,
  227: 7, 228: 7, 229: 7, 230: 11, 231: 6, 232: 7, 233: 7, 234: 7, 235: 7,
  236: 3, 237: 3, 238: 3, 239: 3, 240: 7, 241: 7, 242: 7, 243: 7, 244: 7,
  245: 7, 246: 7, 247: 9, 248: 7, 249: 7, 250: 7, 251: 7, 252: 7, 253: 7,
  254: 7, 255: 7,
};

/** The width of 'm' — the missing-printable-glyph fallback (badge.go:122). */
const GLYPH_WIDTH_M = 11;

/** calculateTextWidth (badge.go:111-127): over TrimSpace'd text; a missing
 *  PRINTABLE glyph takes 'm''s width; non-printables count 0. */
export function calculateTextWidth(text: string): number {
  let width = 0;
  for (const ch of text.trim()) {
    const code = ch.codePointAt(0) ?? 0;
    const known = DEJAVU_GLYPH_WIDTH[code];
    if (known !== undefined) {
      width += known;
    } else if (isPrintable(code)) {
      width += GLYPH_WIDTH_M;
    }
  }
  return width;
}

/** Go unicode.IsPrint over the ranges that matter here: graphic + ASCII
 *  space (the badge labels' Latin-1 universe; L/m/Cf categories beyond
 *  0x2028 cannot reach a workflow name through the URL param unencoded). */
function isPrintable(code: number): boolean {
  return code === 0x20 || (code >= 0x21 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff);
}

// ---------------------------------------------------------------------------
// The badge model (badge.go:55-73 GenerateBadge + the layout consts)
// ---------------------------------------------------------------------------

export interface BadgeText {
  text: string;
  width: number;
  x: number;
  textLength: number;
}

export interface Badge {
  fontFamily: string;
  color: string;
  fontSize: number;
  label: BadgeText;
  message: BadgeText;
  width: number;
  /** The chosen template arm (the `?style=` resolution at load; the render
   *  switches on it — badge.go:40-45's exact-literal case). */
  style: string;
}

const DEFAULT_OFFSET = 10;
const DEFAULT_FONT_SIZE = 11;

/** GenerateBadge (badge.go:100-117) over the 10x scale. The style arm
 *  defaults to flat (badge.go:43-45's default case); the loader's
 *  withStyle overwrites it from the param. */
export function generateBadge(label: string, message: string, color: string): Badge {
  const lw = calculateTextWidth(label) + DEFAULT_OFFSET;
  const mw = calculateTextWidth(message) + DEFAULT_OFFSET;
  return {
    fontFamily: BADGE_FONT_FAMILY,
    color,
    fontSize: DEFAULT_FONT_SIZE * 10,
    label: { text: label, width: lw, x: lw * 5, textLength: (lw - DEFAULT_OFFSET) * 10 },
    message: { text: message, width: mw, x: lw * 10 + mw * 5 - 10, textLength: (mw - DEFAULT_OFFSET) * 10 },
    width: lw + mw,
    style: "flat",
  };
}

// ---------------------------------------------------------------------------
// The templates (templates/shared/actions/runner_badge_flat[-square].tmpl)
// ---------------------------------------------------------------------------

/** Go html/template's htmlEscaper table (text/template/html.go) — NULL
 *  becomes U+FFFD, then the five entities. */
function htmlEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "\u0000":
        out += "\uFFFD";
        break;
      case "&":
        out += "&amp;";
        break;
      case "'":
        out += "&#39;";
        break;
      case "<":
        out += "&lt;";
        break;
      case ">":
        out += "&gt;";
        break;
      case '"':
        out += "&#34;";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** runner_badge_flat.tmpl, verbatim (IDPrefix is empty — badge.go:38 never
 *  sets it). */
function renderBadgeFlat(b: Badge): string {
  const esc = htmlEscape;
  const label = esc(b.label.text);
  const message = esc(b.message.text);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${b.width}" height="20"\n` +
    `\trole="img" aria-label="${label}: ${message}">\n` +
    `\t<title>${label}: ${message}</title>\n` +
    `\t<linearGradient id="s" x2="0" y2="100%">\n` +
    `\t\t<stop offset="0" stop-color="#bbb" stop-opacity=".1" />\n` +
    `\t\t<stop offset="1" stop-opacity=".1" />\n` +
    `\t</linearGradient>\n` +
    `\t<clipPath id="r">\n` +
    `\t\t<rect width="${b.width}" height="20" rx="3" fill="#fff" />\n` +
    `\t</clipPath>\n` +
    `\t<g clip-path="url(#r)">\n` +
    `\t\t<rect width="${b.label.width}" height="20" fill="#555" />\n` +
    `\t\t<rect x="${b.label.width}" width="${b.message.width}" height="20" fill="${esc(b.color)}" />\n` +
    `\t\t<rect width="${b.width}" height="20" fill="url(#s)" />\n` +
    `\t</g>\n` +
    `\t<g fill="#fff" text-anchor="middle" font-family="${esc(b.fontFamily)}"\n` +
    `\t\ttext-rendering="geometricPrecision" font-size="${b.fontSize}">\n` +
    `\t\t<text aria-hidden="true" x="${b.label.x}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)"\n` +
    `\t\t\ttextLength="${b.label.textLength}">${label}</text>\n` +
    `\t\t<text x="${b.label.x}" y="140"\n` +
    `\t\t\ttransform="scale(.1)" fill="#fff" textLength="${b.label.textLength}">${label}</text>\n` +
    `\t\t<text aria-hidden="true" x="${b.message.x}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)"\n` +
    `\t\t\ttextLength="${b.message.textLength}">${message}</text>\n` +
    `\t\t<text x="${b.message.x}" y="140" transform="scale(.1)" fill="#fff"\n` +
    `\t\t\ttextLength="${b.message.textLength}">${message}</text>\n` +
    `\t</g>\n` +
    `</svg>\n`
  );
}

/** runner_badge_flat-square.tmpl, verbatim. */
function renderBadgeFlatSquare(b: Badge): string {
  const esc = htmlEscape;
  const label = esc(b.label.text);
  const message = esc(b.message.text);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${b.width}" height="20"\n` +
    `\trole="img" aria-label="${label}: ${message}">\n` +
    `\t<title>${label}: ${message}</title>\n` +
    `\t<g shape-rendering="crispEdges">\n` +
    `\t\t<rect width="${b.label.width}" height="20" fill="#555" />\n` +
    `\t\t<rect x="${b.label.width}" width="${b.message.width}" height="20" fill="${esc(b.color)}" />\n` +
    `\t</g>\n` +
    `\t<g fill="#fff" text-anchor="middle" font-family="${esc(b.fontFamily)}"\n` +
    `\t\ttext-rendering="geometricPrecision" font-size="${b.fontSize}">\n` +
    `\t\t<text x="${b.label.x}" y="140"\n` +
    `\t\t\ttransform="scale(.1)" fill="#fff" textLength="${b.label.textLength}">${label}</text>\n` +
    `\t\t<text x="${b.message.x}" y="140" transform="scale(.1)" fill="#fff"\n` +
    `\t\t\ttextLength="${b.message.textLength}">${message}</text>\n` +
    `\t</g>\n` +
    `</svg>\n`
  );
}

/** The ctx.HTML(200, tpl) render — the style switch (badge.go:40-45):
 *  ONLY the exact flat-square literal picks the square template. */
export function renderWorkflowBadgeSvg(badge: Badge): string {
  if (badge.style === BADGE_STYLE_FLAT_SQUARE) return renderBadgeFlatSquare(badge);
  return renderBadgeFlat(badge);
}

// ---------------------------------------------------------------------------
// The loader (badge.go:48-65 getWorkflowBadge + run.go:328-348)
// ---------------------------------------------------------------------------

/** The loader's repo subset (the caller's resolved row). */
export type BadgeRepo = { id: string; defaultBranch: string };

export interface WorkflowBadgeParams {
  workflowName: string;
  /** The `?branch=` value — the SHORT branch name; absent resolves the
   *  repo's default (badge.go:27). */
  branch?: string;
  /** The `?event=` filter — empty matches any event (run.go:336-338). */
  event?: string;
  /** The `?style=` value — only the exact flat-square literal deviates. */
  style?: string;
}

/**
 * getWorkflowBadge (badge.go:48-65) over the M1a store: the newest
 * non-scoped run of (repo, refs/heads/{branch}, workflow file [, event]),
 * mapped to its badge triple. Never 404s once the route's gates passed — a
 * run-less workflow answers the grey "no status" badge (upstream's own
 * shape, badge.go:54-56).
 */
export async function resolveWorkflowBadge(d1: D1, repo: BadgeRepo, params: WorkflowBadgeParams): Promise<Badge> {
  const branchRef = `refs/heads/${params.branch ?? repo.defaultBranch}`;
  const conds = [
    eq(actionRuns.repoId, repo.id),
    eq(actionRuns.ref, branchRef),
    eq(actionRuns.isScopedRun, false),
    // The workflow_id match: upstream's exact equality plus the store's
    // path-spelling tolerance (the module header's divergence note).
    sql`(${actionRuns.workflowId} = ${params.workflowName} OR ${actionRuns.workflowId} LIKE ${`%/${params.workflowName}`})`,
  ];
  if (params.event !== undefined && params.event !== "") {
    conds.push(eq(actionRuns.event, params.event));
  }
  const rows = await drizzle(d1)
    .select({ status: actionRuns.status })
    .from(actionRuns)
    .where(and(...conds))
    .orderBy(desc(actionRuns.id))
    .limit(1);

  const workflowName = trimExtension(params.workflowName);
  const row = rows[0];
  if (row === undefined) {
    return withStyle(generateBadge(workflowName, "no status", BADGE_DEFAULT_COLOR), params.style);
  }
  const color = BADGE_STATUS_COLORS[row.status];
  if (color === undefined) {
    return withStyle(generateBadge(workflowName, "unknown status", BADGE_DEFAULT_COLOR), params.style);
  }
  return withStyle(generateBadge(workflowName, badgeStatusName(row.status), color), params.style);
}

/** filepath.Ext + TrimSuffix (badge.go:49-50) — Ext scans only the FINAL
 *  element (a dot in a parent dir segment does not count); a leading-dot
 *  name (".env") has Ext ".env", so the stem goes empty — Go's exact
 *  arithmetic, warts included. */
function trimExtension(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return base;
  return base.slice(0, dot);
}

/** The style rides the badge value (the render's switch input). */
function withStyle(badge: Badge, style: string | undefined): Badge {
  badge.style = style === BADGE_STYLE_FLAT_SQUARE ? BADGE_STYLE_FLAT_SQUARE : "flat";
  return badge;
}
