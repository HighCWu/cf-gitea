/**
 * The commit-graph page (SPEC-0017 M2 — the census R09 step 2, over the
 * M1 `graphData` engine RPC): `GET /{owner}/{repo}/graph` plus its
 * `?div-only=true` fragment arm.
 *
 * ## Upstream shape (submodule pin fc4936884584)
 *
 * web.go:1738's `m.Get("/graph", repo.Graph)` in a bare group with
 * `repo.MustBeNotEmpty` (web.go:1737-1744) — NO ref-suffix middleware: the
 * URL carries no ref, ever. The handler (routers/web/repo/commit.go:106-173)
 * parses `mode` (ToLower'd; anything but "monochrome" normalizes to
 * "color"), `hide-pr-refs` (FormBool), `branch` (multi-value, each entry
 * prefixed to `refs/heads/…` unless already `refs/`-prefixed,
 * commit.go:120-127) and `div-only`; `file` is accepted and ignored v1
 * (ratified Open question 5). One handler answers BOTH arms: the full page
 * (tplGraph) or the `#git-graph-body` INNER content only (tplGraphDiv,
 * commit.go:170-173) — the official bundle's refresh fetches that HTML
 * fragment, never a JSON route (web_src/js/features/repo-graph.ts:34-50).
 *
 * ## DOM parity (the official JS is the enhancement layer)
 *
 * The bundle loads on every page (shell.tsx) and `initRepoGraphGit`
 * activates on `#git-graph-container` alone, then EXPECTS the two color
 * buttons, the `#flow-select-refs-dropdown` fomantic dropdown and
 * `#git-graph-body` to exist with it (repo-graph.ts:9-10's non-null
 * assertions) — a partial DOM throws during init. This module reproduces
 * upstream's structure verbatim (graph.tmpl + graph/svgcontainer.tmpl +
 * graph/commits.tmpl at the pin): the `monochrome` mode class, the sentinel
 * `...flow-hide-pr-refs` dropdown item, full-ref `data-value`s, and the
 * three `#git-graph-body` children (SVG container + rev list + pager).
 * Without JS the page is fully readable; filter changes need the JS
 * (upstream's own posture — the fomantic dropdown has no noscript form).
 *
 * ## The SVG (upstream's exact 5px/12px geometry, svgcontainer.tmpl:2-18)
 *
 * `viewbox="minColumn*5 minRow*12 width*5+5 height*12"`,
 * `width="{width*10+10}px"` (the 2x scale aligns the 12px logical rows with
 * the 24px list rows, gitgraph.css:26-33/:54-58). One
 * `<g class="flow-group flow-color-{color} flow-color-16-{color%16}">` per
 * color, its `<path d>` assembled from the rows' edges — `from === to` →
 * `M {col*5+5} {row*12} v 12`; `to = from+1` → `M {col*5} {row*12} l 10 12`
 * (the `\` glyph's geometry); `to = from-1` → `M {col*5+10} {row*12}
 * l -10 12` (`/`). Circles `r="2.5"` at `(column*5+5, row*12+6)` per commit
 * row. The engine's one-step edge rule (SPEC §3.3.3) never produces
 * horizontal segments — upstream's `_`/`.` glyphs exist only for git's
 * multi-column bends, which our relation rows decompose (the ledgered
 * divergence, ratified Open question 2).
 *
 * ## Documented v1 cuts (ratified)
 *
 * - Identity enrichment is absent (Open question 4): rows carry git
 *   identities only — the author NAME in the avatar-stack slot (the
 *   commit-list precedent), no sign badges, no CI status.
 * - The monochrome/colored button icons (material-invert-colors /
 *   material-palette) and the remotes' octicon-cross-reference are outside
 *   the generated icon allowlist — the accessible text stands in (the
 *   repo-activity triangle-down precedent).
 * - `?file=` is accepted and ignored (no file input rendered).
 */

import { renderToString } from "hono/jsx/dom/server";
import type { Child } from "hono/jsx";

import type { GraphDataResult, GraphRow, RefsResult } from "@cf-gitea/git-engine";

import { formatMonitorFullTime } from "./admin-monitor";
import type { EngineClient } from "../engine";
import type { IconName } from "../icons";
import { commitLink } from "../links";
import { parsePageNumber, pathEscapeSegments } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** Upstream `setting.UI.GraphMaxCommitNum` (modules/setting/ui.go:23/:95 —
 *  the default we mirror; the engine clamps `limit` to the same 1..100). */
export const GRAPH_PAGE_SIZE = 100;

/** The pager's rolling window — upstream `navPageNum` 5
 *  (services/context/pagination.go:28-46's ValueOrDefault(5)). */
const PAGER_NAV_PAGE_NUM = 5;

/** Page-level strings (the activityLocale pattern — the keys cite upstream's
 *  locale_en-US.json; the pager labels are the keys the paginate template
 *  names). */
export const graphLocale = {
  /** "repo.commit_graph" */
  commit_graph: "Commit Graph",
  /** "repo.commit_graph.select" */
  select: "Select branches",
  /** "repo.commit_graph.hide_pr_refs" */
  hide_pr_refs: "Hide Pull Requests",
  /** "repo.commit_graph.monochrome" */
  monochrome: "Mono",
  /** "repo.commit_graph.color" */
  color: "Color",
  /** "repo.issues.previous" — the paginate template's prev label */
  previous: "Previous",
  /** "repo.issues.next" */
  next: "Next",
  /** "admin.first_page" */
  first: "First",
  /** "admin.last_page" */
  last: "Last",
  /** NON-upstream: our walk-budget honesty surface (the null-total arm's
   *  bound note — upstream's pager is unbounded; no locale key exists). */
  bound_note: "Older commits are beyond the graph walk budget.",
} as const;

// ---------------------------------------------------------------------------
// The query (commit.go:107-129's param parsing)
// ---------------------------------------------------------------------------

/** The parsed page query. `branches` keeps the RAW `?branch=` values with
 *  the `...flow-hide-pr-refs` sentinel removed — any `...`-prefixed value
 *  flips `hidePRRefs` instead (the JS maps the sentinel to the flag,
 *  repo-graph.ts:53-55/:63-65/:77-79; §5). */
export interface GraphQuery {
  page: number;
  mode: "color" | "monochrome";
  hidePRRefs: boolean;
  branches: string[];
  /** `?div-only=true` — the fragment arm (tplGraphDiv, commit.go:170-173). */
  divOnly: boolean;
}

/** Upstream `FormBool` (base_form.go:62-66): ParseBool's true forms plus the
 *  "on" fold. */
function formBool(value: string | null): boolean {
  if (value === null) return false;
  const lower = value.toLowerCase();
  return lower === "1" || lower === "t" || lower === "true" || lower === "on";
}

/** Parse the graph page's query params (commit.go:107-129 verbatim). */
export function parseGraphQuery(params: URLSearchParams): GraphQuery {
  // mode: ToLower(FormTrim) — anything but "monochrome" is "color" (commit.go:110-113)
  const mode = (params.get("mode") ?? "").trim().toLowerCase() === "monochrome" ? "monochrome" : "color";
  let hidePRRefs = formBool(params.get("hide-pr-refs"));
  const branches: string[] = [];
  for (const raw of params.getAll("branch")) {
    if (raw.startsWith("...")) {
      hidePRRefs = true; // the hide-PR sentinel never reaches the RPC (§5)
      continue;
    }
    branches.push(raw);
  }
  return {
    page: parsePageNumber(params.get("page")),
    mode,
    hidePRRefs,
    branches,
    divOnly: formBool(params.get("div-only")),
  };
}

/** commit.go:120-127 — each selected branch prefixed to `refs/heads/…`
 *  unless already `refs/`-prefixed (the RPC takes full names). */
export function branchRefs(branches: string[]): string[] {
  return branches.map((name) => (name.startsWith("refs/") ? name : `refs/heads/${name}`));
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

/** The loaded page data. */
export interface GraphLoad {
  query: GraphQuery;
  graph: GraphDataResult;
  /** The full ref table for the dropdown (upstream `AllRefs`,
   *  commit.go:158-164's `GitRepo.GetRefs`). */
  allRefs: RefsResult["refs"];
}

/**
 * Load the graph page's data. `null` = the 404 family: the repo has no refs
 * at all (unborn HEAD — upstream never reaches the handler: MustBeNotEmpty,
 * web.go:1737) or a transport failure answered the seam's null (the
 * activity-page posture: upstream ServerErrors 500, the documented
 * divergence). A stale `?branch=` value NEVER 404s here — the engine skips
 * unresolvable tips and falls back to the default tip set (upstream's
 * bad-ref retry, commit.go:130-142; §5).
 */
export async function loadGraphData(engine: EngineClient, query: GraphQuery): Promise<GraphLoad | null> {
  const refs = await engine.listRefs();
  if (refs === null) return null;
  const names = branchRefs(query.branches);
  const graph = await engine.graphData({
    refs: names.length > 0 ? names : undefined,
    page: query.page,
    hidePRRefs: query.hidePRRefs,
  });
  if (graph === null) return null; // the empty-repo ladder (§3.1)
  return { query, graph, allRefs: refs.refs };
}

// ---------------------------------------------------------------------------
// The SVG (svgcontainer.tmpl)
// ---------------------------------------------------------------------------

interface GeometryGroup {
  color: number;
  color16: number;
  /** The `<path d>` segments — `M x y v|l …` per edge, upstream's glyph
   *  geometry at 5px columns / 12px rows. */
  segments: string[];
  circles: { oid: string; cx: number; cy: number }[];
}

export interface GraphGeometry {
  /** `viewbox` — "minColumn*5 minRow*12 width*5+5 height*12" */
  viewBox: string;
  /** the `width` attr — "{width*10+10}px" (the 2x scale) */
  widthPx: string;
  groups: GeometryGroup[];
}

/**
 * The rows' SVG geometry, upstream's Graph.Width()/Height() math
 * (graph_models.go:48-55): rows[i] is SVG row i (minRow 0 — our walks always
 * start at row 0), columns fold in every commit dot AND every edge endpoint
 * (relation rows widen the graph through their edges).
 */
export function graphGeometry(rows: GraphRow[]): GraphGeometry {
  let minColumn = 0;
  let maxColumn = 0;
  for (const row of rows) {
    const columns = row.commit === null ? [] : [row.column];
    for (const edge of row.edges) {
      columns.push(edge.from, edge.to);
    }
    for (const column of columns) {
      if (column < minColumn) minColumn = column;
      if (column > maxColumn) maxColumn = column;
    }
  }
  const width = maxColumn - minColumn + 1;
  const height = Math.max(rows.length, 1); // the empty graph is 1x1 (Width()/Height() on zero rows)
  const groups = new Map<number, GeometryGroup>();
  const groupOf = (color: number): GeometryGroup => {
    const existing = groups.get(color);
    if (existing) return existing;
    const created: GeometryGroup = { color, color16: color % 16, segments: [], circles: [] };
    groups.set(color, created);
    return created;
  };
  rows.forEach((row, i) => {
    const y = i * 12;
    for (const edge of row.edges) {
      let segment: string;
      if (edge.to === edge.from) {
        // the `*`/`|` vertical: M col*5+5 row*12 v 12
        segment = `M ${edge.from * 5 + 5} ${y} v 12`;
      } else {
        // the one-step bends — `\` right: M col*5 row*12 l 10 12;
        // `/` left: M col*5+10 row*12 l -10 12. |to-from| > 1 cannot happen
        // (the engine's one-step invariant, check-graph pin) — the same
        // form degrades to a straight diagonal rather than lying.
        const dx = edge.to - edge.from;
        segment = `M ${edge.from * 5 + (dx > 0 ? 0 : 10)} ${y} l ${dx * 10} 12`;
      }
      groupOf(edge.color).segments.push(segment);
    }
    if (row.commit !== null) {
      groupOf(row.color).circles.push({ oid: row.commit.oid, cx: row.column * 5 + 5, cy: y + 6 });
    }
  });
  return {
    viewBox: `${minColumn * 5} 0 ${width * 5 + 5} ${height * 12}`,
    widthPx: `${width * 10 + 10}px`,
    groups: [...groups.values()].sort((a, b) => a.color - b.color),
  };
}

/** The SVG container (svgcontainer.tmpl verbatim: #rel-container > svg >
 *  g.flow-group per color > path + circles). */
function GraphSvg(props: { rows: GraphRow[] }) {
  const geometry = graphGeometry(props.rows);
  return (
    <div id="rel-container">
      <svg viewbox={geometry.viewBox} width={geometry.widthPx}>
        {geometry.groups.map((group) => (
          <g
            id={`flow-${group.color}`}
            class={`flow-group flow-color-${group.color} flow-color-16-${group.color16}`}
            data-flow={String(group.color)}
            data-color={String(group.color)}
          >
            <path
              d={group.segments.join(" ")}
              stroke-width="1"
              fill="none"
              id={`flow-${group.color}-path`}
              stroke-linecap="round"
            />
            {group.circles.map((circle) => (
              <circle
                class="flow-commit"
                cx={String(circle.cx)}
                cy={String(circle.cy)}
                r="2.5"
                stroke="none"
                id={`flow-commit-${circle.oid}`}
                data-rev={circle.oid}
              />
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The rev list (graph/commits.tmpl)
// ---------------------------------------------------------------------------

/** The ref name's UI short form (upstream RefName.ShortName, ref.go — the
 *  pull arm also trims the trailing "/head"). */
function shortRefName(name: string): string {
  if (name.startsWith("refs/heads/")) return name.slice("refs/heads/".length);
  if (name.startsWith("refs/tags/")) return name.slice("refs/tags/".length);
  if (name.startsWith("refs/remotes/")) return name.slice("refs/remotes/".length);
  if (name.startsWith("refs/pull/")) {
    const rest = name.slice("refs/pull/".length);
    return rest.endsWith("/head") ? rest.slice(0, -"/head".length) : rest;
  }
  return name;
}

/** The engine's RefGroup rule mirrored for the render arms
 *  (repo.ts refGroup; the template's four arms — `for` and unknown-group
 *  refs render nothing, graph/commits.tmpl's fall-through comment). */
function refGroup(name: string): "heads" | "tags" | "remotes" | "pull" | null {
  if (name.startsWith("refs/heads/")) return "heads";
  if (name.startsWith("refs/tags/")) return "tags";
  if (name.startsWith("refs/remotes/")) return "remotes";
  if (name.startsWith("refs/pull/")) return "pull";
  return null;
}

/** One ref chip (graph/commits.tmpl:19-40 per group; the pull chip renders
 *  only when NOT hide-pr-refs or the ref is explicitly selected — the :21
 *  gate). The remotes icon (octicon-cross-reference) is outside the
 *  generated allowlist — the text stands in. */
function RefChip(props: {
  repoLink: string;
  name: string;
  oid: string;
  hidePRRefs: boolean;
  selectedBranches: string[];
}) {
  const group = refGroup(props.name);
  if (group === null) return null;
  const short = shortRefName(props.name);
  if (group === "pull") {
    if (props.hidePRRefs && !props.selectedBranches.includes(props.name)) return null;
    return (
      <a class="ui basic tiny button" href={`${props.repoLink}/pulls/${pathEscapeSegments(short)}`}>
        <Icon name="octicon-git-pull-request" /> #{short}
      </a>
    );
  }
  if (group === "tags") {
    // repo/tag/name.tmpl — the ui basic label chip with the tag-label class
    return (
      <a class="ui basic label tag-label" href={`${props.repoLink}/src/tag/${pathEscapeSegments(short)}`}>
        <Icon name="octicon-tag" /> {short}
      </a>
    );
  }
  if (group === "remotes") {
    return (
      <a class="ui basic tiny button" href={`${props.repoLink}/src/commit/${props.oid}`}>
        {short}
      </a>
    );
  }
  return (
    <a class="ui basic tiny button" href={`${props.repoLink}/src/branch/${pathEscapeSegments(short)}`}>
      <Icon name="octicon-git-branch" /> {short}
    </a>
  );
}

/** The parallel rev list (graph/commits.tmpl:1-47): one `<li>` per row in
 *  row order — the SVG/list alignment is positional. Relation rows render a
 *  bare empty span; commit rows carry the subject (linked to the commit —
 *  §4.2), the ref chips, the author name (the avatar-stack slot's v1 cut)
 *  and the full author time (DateUtils.FullTime). */
function RevList(props: { repoLink: string; rows: GraphRow[]; query: GraphQuery }) {
  return (
    <div id="rev-container">
      <ul id="rev-list">
        {props.rows.map((row) =>
          row.commit === null ? (
            <li data-flow="0">
              <span />
            </li>
          ) : (
            <li id={`commit-${row.commit.oid}`} data-flow={String(row.color)}>
              <span class="message tw-inline-block gt-ellipsis">
                <a href={commitLink(props.repoLink, row.commit.oid)}>{row.commit.subject}</a>
              </span>
              <span class="commit-refs flex-text-inline">
                {row.commit.refs.map((ref) => (
                  <RefChip
                    repoLink={props.repoLink}
                    name={ref.name}
                    oid={row.commit?.oid ?? ""}
                    hidePRRefs={props.query.hidePRRefs}
                    selectedBranches={props.query.branches}
                  />
                ))}
              </span>
              <span class="flex-text-inline tw-text-12">{row.commit.author.name}</span>
              <span class="time flex-text-inline">
                {formatMonitorFullTime(new Date(row.commit.author.time * 1000))}
              </span>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The hybrid pager (ratified Open question 3)
// ---------------------------------------------------------------------------

/**
 * The numbered pager's rolling window — paginator.go's `Pages()` port
 * (numPages 5): page numbers with -1 marking the "…" placeholder. TotalPages
 * <= numPages renders every page; the window keeps navPageNum-1 neighbors
 * around the current page, growing one slot per overflowing side.
 */
export function paginatorPages(totalPages: number, current: number): number[] {
  const numPages = PAGER_NAV_PAGE_NUM;
  const middleIdx = (numPages + 1) / 2; // getMiddleIdx — 3 for 5
  if (totalPages <= numPages) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  let windowSize = numPages;
  let offsetIdx = 0;
  let hasMoreNext = false;
  let previousNum = middleIdx - 1;
  if (previousNum > current - 1) previousNum -= previousNum - (current - 1);
  let nextNum = numPages - previousNum - 1;
  if (current + nextNum > totalPages) {
    const delta = nextNum - (totalPages - current);
    nextNum -= delta;
    previousNum += delta;
  }
  const offsetVal = current - previousNum;
  if (offsetVal > 1) {
    windowSize++;
    offsetIdx = 1;
  }
  if (current + nextNum < totalPages) {
    windowSize++;
    hasMoreNext = true;
  }
  const pages: number[] = Array.from({ length: windowSize }, () => 0);
  if (offsetIdx === 1) pages[0] = -1; // more previous pages
  if (hasMoreNext) pages[pages.length - 1] = -1; // more next pages
  for (let i = 0; i < previousNum; i++) pages[offsetIdx + i] = offsetVal + i;
  pages[offsetIdx + previousNum] = current;
  for (let i = 1; i <= nextNum; i++) pages[offsetIdx + previousNum + i] = current + i;
  return pages;
}

/** A pager link's href (PagerBuilder.AddParamFromQuery's shape): page first,
 *  then every carried param — mode/branch/hide-pr-refs (div-only stripped,
 *  commit.go:169; the JS's live mode-rewrite then finds the param already
 *  present, the parity note in §4.2). `page === null` is the page-1 form
 *  (the paginate template's IsFirst arm links the bare URL). */
function pagerHref(basePath: string, query: GraphQuery, page: number | null): string {
  const params = new URLSearchParams();
  if (page !== null && page > 1) params.set("page", String(page));
  if (query.mode === "monochrome") params.set("mode", "monochrome");
  for (const branch of query.branches) params.append("branch", branch);
  if (query.hidePRRefs) params.set("hide-pr-refs", "true");
  const queryString = params.toString();
  if (page === null || page <= 1) return queryString === "" ? basePath : `${basePath}?${queryString}`;
  return queryString === "" ? `${basePath}?page=${page}` : `${basePath}?page=${page}&${queryString}`;
}

/** The pager's outer div (paginate.tmpl:8-9 verbatim). */
function PagerShell(props: { children: Child }) {
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">{props.children}</div>
    </div>
  );
}

/**
 * The hybrid pager. `total` delivered → the numbered pager (upstream
 * base/paginate: first/prev/window/next/last; hidden entirely at one page —
 * the template's TotalPages gate; current clamped to totalPages,
 * paginator.go:45-49). `total: null` → the commits-page Newer/Older pair;
 * `truncated` hides Older and shows the bound note (§4.2 — null total
 * implies truncated, so the pair degrades to Newer + note).
 */
function GraphPager(props: { basePath: string; query: GraphQuery; graph: GraphDataResult }) {
  const { query, graph } = props;
  if (graph.total !== null) {
    const totalPages = Math.max(1, Math.ceil(graph.total / GRAPH_PAGE_SIZE));
    if (totalPages <= 1) return null; // paginate.tmpl's `gt .TotalPages 1` gate
    const current = Math.min(Math.max(query.page, 1), totalPages);
    const hasPrev = current > 1;
    const hasNext = current * GRAPH_PAGE_SIZE < graph.total;
    return (
      <PagerShell>
        <a class={hasPrev ? "item navigation" : "disabled item navigation"} href={hasPrev ? pagerHref(props.basePath, query, 1) : undefined}>
          <span class="navigation_label">{graphLocale.first}</span>
        </a>
        <a
          class={hasPrev ? "item navigation" : "disabled item navigation"}
          href={hasPrev ? pagerHref(props.basePath, query, current - 1) : undefined}
        >
          <span class="navigation_label">{graphLocale.previous}</span>
        </a>
        {paginatorPages(totalPages, current).map((num) =>
          num === -1 ? (
            <a class="disabled item">...</a>
          ) : (
            <a
              class={num === current && totalPages > 1 ? "active item" : "item"}
              href={num === current ? undefined : pagerHref(props.basePath, query, num)}
            >
              {num}
            </a>
          ),
        )}
        <a
          class={hasNext ? "item navigation" : "disabled item navigation"}
          href={hasNext ? pagerHref(props.basePath, query, current + 1) : undefined}
        >
          <span class="navigation_label">{graphLocale.next}</span>
        </a>
        <a
          class={hasNext ? "item navigation" : "disabled item navigation"}
          href={hasNext ? pagerHref(props.basePath, query, totalPages) : undefined}
        >
          <span class="navigation_label">{graphLocale.last}</span>
        </a>
      </PagerShell>
    );
  }
  // the null-total arm: Newer/Older (the commits-page pair), Older hidden
  // under `truncated` with the bound note in its place (§4.2)
  const hasNewer = query.page > 1;
  const hasOlder = !graph.truncated;
  return (
    <PagerShell>
      {hasNewer ? (
        <a class="item navigation" href={pagerHref(props.basePath, query, query.page - 1)}>
          <span class="navigation_label">{graphLocale.previous}</span>
        </a>
      ) : null}
      {hasOlder ? (
        <a class="item navigation" href={pagerHref(props.basePath, query, query.page + 1)}>
          <span class="navigation_label">{graphLocale.next}</span>
        </a>
      ) : null}
      {graph.truncated ? <span class="navigation_label">{graphLocale.bound_note}</span> : null}
    </PagerShell>
  );
}

// ---------------------------------------------------------------------------
// The page + the fragment arm
// ---------------------------------------------------------------------------

/** The refs dropdown (graph.tmpl:9-42): the fomantic multiple-selection
 *  search dropdown — the sentinel item first, then every ref in listRefs
 *  order with the group icon (the four arms; groups outside them are
 *  skipped). Selection seeding is the JS's job (repo-graph.ts:57-59 — no
 *  selected markup SSR'd, upstream-exact). */
function RefsDropdown(props: { allRefs: RefsResult["refs"] }) {
  return (
    <div class="ui multiple selection search dropdown" id="flow-select-refs-dropdown">
      <input type="hidden" name="flow" />
      <div class="default text">{graphLocale.select}</div>
      <div class="menu">
        <div class="item" data-value="...flow-hide-pr-refs">
          <span class="gt-ellipsis" title={graphLocale.hide_pr_refs}>
            {graphLocale.hide_pr_refs}
          </span>
        </div>
        {props.allRefs.map((ref) => {
          const group = refGroup(ref.name);
          if (group === null) return null;
          const short = shortRefName(ref.name);
          const icon: IconName | null =
            group === "heads" ? "octicon-git-branch" : group === "tags" ? "octicon-tag" : group === "pull" ? "octicon-git-pull-request" : null; // remotes' octicon-cross-reference: outside the allowlist
          return (
            <div class="item" data-value={ref.name}>
              {icon !== null ? <Icon name={icon} /> : null}
              <span class="gt-ellipsis" title={short}>
                {group === "pull" ? `#${short}` : short}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The `#git-graph-body` inner content — the fragment arm's whole response
 *  and the full page's middle (graph.tmpl:47-51). */
export function GraphFragment(props: { repoLink: string; data: GraphLoad }) {
  return (
    <>
      <GraphSvg rows={props.data.graph.rows} />
      <RevList repoLink={props.repoLink} rows={props.data.graph.rows} query={props.data.query} />
      <GraphPager basePath={`${props.repoLink}/graph`} query={props.data.query} graph={props.data.graph} />
    </>
  );
}

/** The full page (graph.tmpl: the `repository commits` discriminator, the
 *  header with the dropdown + the two color buttons, then the body). */
export function RepoGraphPage(props: { ctx: UiContext; data: GraphLoad }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoGraphPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout
      ctx={ctx}
      title={graphLocale.commit_graph}
      pageClass="repository commits"
      activeTab="commits"
    >
      <div class="ui container">
        <div id="git-graph-container" class={`ui segment${data.query.mode === "monochrome" ? " monochrome" : ""}`}>
          <h2 class="ui header dividing">
            {graphLocale.commit_graph}
            <div class="ui icon buttons tiny color-buttons">
              <RefsDropdown allRefs={data.allRefs} />
              {/* the two color buttons (graph.tmpl:43-44): the material
                  icons are outside the allowlist — the text stands in */}
              <button
                type="button"
                id="flow-color-monochrome"
                class={data.query.mode === "monochrome" ? "ui icon button active" : "ui icon button"}
                title={graphLocale.monochrome}
              >
                {graphLocale.monochrome}
              </button>
              <button
                type="button"
                id="flow-color-colored"
                class={data.query.mode !== "monochrome" ? "ui icon button active" : "ui icon button"}
                title={graphLocale.color}
              >
                {graphLocale.color}
              </button>
            </div>
          </h2>
          <div id="git-graph-body">
            <GraphFragment repoLink={repoLink} data={data} />
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The serialized full page (the releases module's renderPage shape). */
export function renderRepoGraphPage(ctx: UiContext, data: GraphLoad): string {
  return renderPage(<RepoGraphPage ctx={ctx} data={data} />);
}

/** The serialized `?div-only=true` fragment (tplGraphDiv): the body's inner
 *  content only — no shell, no container chrome (commit.go:170-173). */
export function renderGraphFragment(repoLink: string, data: GraphLoad): string {
  return renderToString(<GraphFragment repoLink={repoLink} data={data} />);
}
