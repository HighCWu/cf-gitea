/**
 * Shared page-data helpers for the three slice-1 pages (SPEC-0008 §3.3–3.5):
 * the §3.5 per-file latest-commit enrichment with its documented interim
 * fallback, upstream README detection, blob display classification, and the
 * small formatting primitives the page components share. Pure data — the JSX
 * lives under pages/ and components/.
 */

import type { CommitJson, TreeEntryJson } from "@cf-gitea/git-engine";

import { renderMarkdownToHtml } from "../api/services/markdown";

import type { EngineClient } from "./engine";

// ---------------------------------------------------------------------------
// §3.5 per-file latest-commit enrichment — the A10-L batched RPC + fallback
// ---------------------------------------------------------------------------

/**
 * §3.5's per-file latest-commit enrichment over the engine's BATCHED
 * `listTreeCommits(ref, paths)` RPC (the audit A10-L closure — the boundary
 * now carries it, verified dist-types/repo.d.ts): ONE same-DO roundtrip
 * answers the whole bounded listing with an INDEX-ALIGNED commit per path,
 * replacing the audit's interim parallel fan (up to ENRICH_MAX
 * `listLog(ref, {path, n: 1})` RPCs per view via Promise.all — cheap same-DO
 * hops individually, but N× the subrequests and N walks of the same history).
 *
 * Degradation keeps §3.5's null semantics end to end:
 * - the batch RPC itself is unavailable (an old boundary / stub) or throws —
 *   the documented interim per-path fan answers EVERY entry instead;
 * - a path the batch left unanswered (an index gap — never expected from the
 *   current engine, whose aligned slots cover the whole input) falls back to
 *   its own `listLog` call like the interim path did;
 * - every failure resolves `null` and the render path is IDENTICAL to the
 *   batch RPC's `null` slots: the muted `.notready` message cell, without the
 *   `data-fetch` loader (§3.5 — no partial-refresh endpoint in this slice).
 *
 * Budget: entries beyond ENRICH_MAX never reach the engine at all — the batch
 * call is sliced to ENRICH_MAX paths and the rest fall through to `null`,
 * bounding per-request work independent of directory size. The batch answers
 * each path's commit within the engine's own PATH_LOG_SCAN walk budget.
 */
export const ENRICH_MAX = 30;

export type CommitByEntry = Map<string, CommitJson | null>;

export async function enrichTreeCommits(
  engine: EngineClient,
  ref: string,
  /** Tree entries; `fullPath` maps an entry to its repo-relative path (root
   *  listings pass the entry name, sub-directories the dir-prefixed path). */
  entries: readonly TreeEntryJson[],
  fullPath: (entry: TreeEntryJson) => string,
): Promise<CommitByEntry> {
  const commits: CommitByEntry = new Map();
  // ONE batched RPC for the bounded listing (A10-L); `.catch` + the presence
  // guard degrade to the interim fan on transport failure or a boundary that
  // predates the RPC (a stub without the method throws synchronously).
  const listing = entries.slice(0, ENRICH_MAX).map((entry) => ({ entry, path: fullPath(entry) }));
  const batch = engine.listTreeCommits
    ? await engine.listTreeCommits(ref, listing.map((l) => l.path)).catch(() => null)
    : null;
  // Entries the batch left unanswered (index gap) ride the per-path fallback.
  const fan: { entry: TreeEntryJson; path: string }[] = [];
  if (batch) {
    for (const [index, item] of listing.entries()) {
      const answered = batch.commits[index];
      if (answered === undefined) fan.push(item);
      else commits.set(item.entry.name, answered);
    }
  } else {
    fan.push(...listing);
  }
  // The documented interim fallback (§3.5), unchanged: concurrent same-DO
  // `listLog(ref, {path, ofs: 0, n: 1})` roundtrips, each degrading to `null`
  // on failure — never a rejection, so one failed entry cannot sink the page.
  await Promise.all(
    fan.map(async (item) => {
      try {
        const log = await engine.listLog(ref, { path: item.path, ofs: 0, n: 1 });
        commits.set(item.entry.name, log?.commits[0] ?? null);
      } catch {
        commits.set(item.entry.name, null); // degraded → notready cell (§3.5)
      }
    }),
  );
  return commits;
}

// ---------------------------------------------------------------------------
// README detection (§3.3) — upstream IsReadmeFileName/IsReadmeFileExtension
// (modules/util/path.go:332-360), with findReadmeFile's ".md preferred" pick
// ---------------------------------------------------------------------------

/** Extensions the §3.4 pipeline renders as markdown (upstream markup types). */
export const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkdn"] as const;

/** Upstream's preference classes: markdown first (.md ahead of the rarer
 *  markdown aliases), then extensionless, then any other extension. */
function readmeScore(name: string): number {
  const lower = name.toLowerCase();
  if (lower === "readme") return 2;
  const dot = lower.indexOf(".");
  const ext = dot < 0 ? "" : lower.slice(dot);
  const mdIndex = MARKDOWN_EXTENSIONS.indexOf(ext as (typeof MARKDOWN_EXTENSIONS)[number]);
  if (mdIndex >= 0) return mdIndex; // .md sorts ahead of the other aliases
  return 3; // .txt, org, adoc, … → plain-text render (§3.4 degradation)
}

/** Pick the README entry from one directory listing, or `null` (§4.4: the
 *  home page renders without the README section — no placeholder box). */
export function pickReadme(entries: readonly TreeEntryJson[]): TreeEntryJson | null {
  let best: TreeEntryJson | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const lower = entry.name.toLowerCase();
    if (lower !== "readme" && !lower.startsWith("readme.")) continue;
    const score = readmeScore(entry.name);
    if (score < bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

/** `true` when the path's extension renders through the §3.4 markdown
 *  pipeline (file view `markup` variant + README markup decision). */
export function isMarkdownPath(name: string): boolean {
  const dot = name.toLowerCase().indexOf(".");
  if (dot < 0) return false;
  return (MARKDOWN_EXTENSIONS as readonly string[]).includes(name.toLowerCase().slice(dot));
}

/**
 * The §3.4 render pipeline over the SHARED markdown service
 * (src/api/services/markdown.ts — reused, never a second markdown-it
 * instance): repo-context rewriting comes with it (relative links → the
 * branch-prefixed `/src/...` pages; relative images → the renderer's
 * upstream-shaped `/media/...` family — see links.ts/open question 3 for the
 * raw-vs-media URL note). `""` for non-markdown sources; any pipeline
 * failure also degrades to `""` → the plain-text variant (markdown never
 * breaks the page).
 */
export function renderRepoMarkdown(input: {
  text: string;
  name: string;
  repo: { ownerNamespace: string; slug: string };
  refType: "branch" | "tag" | "commit";
  ref: string;
  origin: string;
}): string {
  if (!isMarkdownPath(input.name)) return "";
  const dir = input.name.includes("/") ? input.name.split("/").slice(0, -1).join("/") : "";
  const context = `/${input.repo.ownerNamespace}/${input.repo.slug}/src/${input.refType}/${input.ref}${
    dir === "" ? "" : `/${dir}`
  }`;
  try {
    return renderMarkdownToHtml({
      text: input.text,
      mode: "file",
      context,
      wiki: false,
      origin: input.origin,
    });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Blob display classification (§3.3 / §4.2 / §4.3 — view_file.tmpl branches)
// ---------------------------------------------------------------------------

/** §4.3: display cap = upstream `setting.UI.MaxDisplayFileSize`
 *  (modules/setting/ui.go:98). Larger blobs never cross the DO→Worker hop —
 *  the tree entry's `size` decides BEFORE readBlob. */
export const MAX_DISPLAY_FILE_SIZE = 8_388_608;

/** §3.4: markdown rendering only for blobs ≤ 512 KiB; larger → plain-text. */
export const MAX_MARKDOWN_SIZE = 512 * 1024;

/** §4.2 binary sniff: a null byte in the first 8 KiB (git/upstream
 *  convention) → `.view-raw`; SVG deliberately NOT media (§4.2 divergence:
 *  rendered as source — our raw URL has no media sandboxing). */
export function isBinaryData(data: Uint8Array): boolean {
  const probe = data.subarray(0, 8192);
  return probe.includes(0);
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".ogv", ".mov"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".ogg", ".wav", ".flac", ".m4a"]);

function extensionOf(name: string): string {
  const dot = name.toLowerCase().lastIndexOf(".");
  return dot < 0 ? "" : name.toLowerCase().slice(dot);
}

/** The `.view-raw` media family by extension sniff (§4.2); `null` = the
 *  "View Raw" prompt. SVG is intentionally absent (rendered as source). */
export function mediaKindOf(
  name: string,
): "image" | "video" | "audio" | null {
  const ext = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return null;
}

/** How a blob renders in the file view (view_file.tmpl:94-132 variants). */
export type BlobViewVariant = "markup" | "plain-text" | "code-view" | "view-raw" | "too-large" | "empty";

export function classifyBlob(entry: TreeEntryJson, data: Uint8Array): BlobViewVariant {
  const size = entry.size ?? data.byteLength;
  if (size === 0) return "empty";
  if (size > MAX_DISPLAY_FILE_SIZE) return "too-large";
  if (isMarkdownPath(entry.name) && size <= MAX_MARKDOWN_SIZE) return "markup";
  if (isBinaryData(data)) return "view-raw";
  return "code-view"; // plain text incl. SVG-as-source (§4.2 divergence)
}

// ---------------------------------------------------------------------------
// Formatting primitives shared by the pages
// ---------------------------------------------------------------------------

/** Upstream `ShortSha` (modules/base/tool.go:31): the first 10 chars. */
export function shortSha(oid: string): string {
  return oid.slice(0, 10);
}

/** Split source text into display lines, dropping the single empty tail a
 *  trailing newline produces (line accounting matches `wc -l` / upstream's
 *  NumLines). */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Upstream `FormatByteSize` = humanize.IBytes ("1.0 kiB"). */
export function formatByteSize(size: number): string {
  const units = ["B", "kiB", "MiB", "GiB", "TiB"] as const;
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const text = unit === 0 ? String(value) : value.toFixed(1);
  return `${text} ${units[unit]}`;
}

/**
 * Upstream `DateUtils.TimeSince` (modules/templates/util_date.go:112-125):
 * `<relative-time prefix="" tense="…" datetime="{RFC3339}"
 * data-tooltip-content data-tooltip-interactive="true">` whose text is the
 * absolute `2006-01-02 15:04:05 -07:00` stamp formatted in the commit's own
 * offset. The parts are returned for JSX rendering (the component supplies
 * the element shape, escaping and the `data-*` attribute pair).
 */
export function timeSinceParts(
  unixSeconds: number,
  tz: string,
  // Wall-clock seam (render-wallclock-audit): only `tense` reads the clock —
  // datetime/text are pure. Default keeps every caller unchanged; tests pin
  // it for deterministic `tense="past|future"` bytes.
  now: number = Date.now(),
): {
  datetime: string;
  tense: "past" | "future";
  text: string;
} {
  const then = new Date(unixSeconds * 1000);
  const sign = tz.startsWith("-") ? -1 : 1;
  const hours = Number.parseInt(tz.replace(/^[-+]/, "").slice(0, 2) || "0", 10);
  const minutes = Number.parseInt(tz.replace(/^[-+]/, "").slice(2) || "0", 10);
  // Format in the commit's own offset like Go's time.Format on a fixed-zone time.
  const shifted = new Date(then.getTime() + sign * (hours * 60 + minutes) * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const text =
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())} ` +
    `${tz.slice(0, 1) === "-" ? "-" : "+"}${pad(hours)}:${pad(minutes)}`;
  return {
    datetime: then.toISOString().replace(/\.\d{3}Z$/, "Z"),
    tense: then.getTime() > now ? "future" : "past",
    text,
  };
}

/** Pagination clamp (§4.11): `page < 1`, non-numeric → 1. There is no upper
 *  clamp — the log's `more` flag simply hides the Older link past the end. */
export function parsePageNumber(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return 1;
  const parsed = Number.parseInt(raw, 10);
  return parsed < 1 ? 1 : parsed;
}

/** Upstream `PathEscapeSegments` (routers/common): escape each "/"-separated
 *  segment, keep the separators. `PathEscape` for single values is the same
 *  `encodeURIComponent` on a segment-free string. */
export function pathEscapeSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
