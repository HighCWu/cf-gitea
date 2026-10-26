/**
 * The file-list's commit-info refresh fragment — the parity survey's row 3
 * tail and wave-39's documented skip, upstream
 *
 *   GET /{owner}/{repo}/lastcommit/*   web.go:1761
 *                   (context.RepoRefByType(git.RefTypeCommit) + repo.LastCommit,
 *                   routers/web/repo/view.go:233-250 → ctx.HTML(tplRepoViewList))
 *
 * — the endpoint view_list.tmpl's `#repo-files-table` fetches when some rows
 * lack commit info (`data-fetch-url="{{.LastCommitLoaderURL}}"`
 * data-fetch-trigger="load" data-fetch-sync="$morph"): it re-runs the
 * directory listing WITH per-entry commit info and re-renders the
 * `tplRepoViewList` HTML fragment standalone (no base layout — the body is
 * exactly the `<div id="repo-files-table">…</div>` the htmx morphs in).
 *
 * ## The upstream loader this ports (modules/git/commit_info.go)
 *
 * `renderDirectoryFiles` (view.go:266-331): `Commit.SubTree(TreePath)` +
 * `tree.ListEntries` (view.go:267-296), `CustomSort(base.NaturalSortCompare)`
 * (view.go:292 — Entries.CustomSort's dirs/submodules-first arm then the
 * natural compare, tree_entry.go:163-171), then
 * `(Entries).GetCommitsInfo(ctx, timeout, repoLink, gitRepo, commit,
 * treePath)` (view.go:298; commit_info.go:79-108). GetCommitsInfo builds
 * `entryNames = ["", ...entries]` (the treePath itself rides along "for
 * free", commit_info.go:82-86), resolves them through the LastCommitCache
 * first (commit_info.go:110-131) and `GetLastCommitForPaths` for the rest
 * (commit_info.go:157-184) — ONE `git log --name-status -c --parents
 * --no-renames --no-follow -t -z <head> -- :(literal)…` process
 * (log_name_status.go:22-40) whose name-status stream yields the newest
 * commit touching EACH path in a single walk. Its knobs, and this port's
 * answer to each:
 *
 * - RENAMES: `--no-renames --no-follow` upstream — a path's history stops at
 *   its create/delete edge, never follows a rename. Our boundary filter
 *   compares the path's tree oid against the first parent's (packages/
 *   git-engine/src/repo.ts:1504-1514) — identical no-follow posture, parity.
 * - MERGES: upstream's `-c --parents` lists a path for a merge only in the
 *   COMBINED diff (differing from ALL parents), so a clean merge taking one
 *   side whole does NOT count as the path's last commit — the side commit
 *   does. Our filter differs from the FIRST parent only, so the merge itself
 *   matches when the path differs from the first parent: we may name the
 *   MERGE where upstream names the merged-side commit (both are commits
 *   where the path carries its current content; presentational divergence,
 *   documented).
 * - BIG LISTS: upstream's ≥70-paths arm drops the pathspec entirely and
 *   attributes per-path last commits from one pathspec-free walk
 *   (log_name_status.go:26-35). Our boundary has no batched
 *   last-commit-per-path RPC (§3.5's `listTreeCommits` still absent —
 *   page-data.ts's note): each path costs one `listLog(ref, {path, n:1})`,
 *   so the loader pays ONE readCommit + ONE listTree + at most N+1 listLog
 *   RPCs, issued 8-wide against the same DO (the commit-contained-refs.ts
 *   batching convention: polite concurrency on one cell, DO RPC wait is not
 *   CPU). Honest N+ posture: linear in the path universe where upstream's
 *   single process is not — the same class the tree-list BFS documented.
 * - WALK BOUND: each path-filtered walk is capped engine-side
 *   (PATH_LOG_SCAN = 2000 scanned commits, packages/git-engine/src/repo.ts:
 *   123/1535); a path untouched within that window resolves null → the
 *   `.notready` cell. Upstream is unbounded (the route passes timeout 0,
 *   view.go:240 — walk until done), so very cold paths degrade here where
 *   upstream eventually answers: the bounded-walk divergence.
 * - LAST-COMMIT CACHE: upstream's LastCommitCache (commit_info.go:110-131)
 *   has no counterpart — the boundary exposes no cross-request memo store
 *   and the D1/R2/DO split forbids duplicating derived git state, so every
 *   request re-walks (stateless, always fresh).
 *
 * Per-row submodule resolution (GetCommitInfoSubmoduleFile,
 * commit_info.go:13-27 → the .gitmodules lookup) is NOT ported: rows carry
 * the engine's `commit`-type entry through the shared table's §4.10
 * `name @ <sha>` plain-text arm (components/file-list.tsx's landed
 * degradation; tree-view-aux.ts owns the module machinery for the other
 * feed).
 *
 * ## The fragment DOM (templates/repo/view_list.tmpl at the pin)
 *
 * The template's decisions, and what the rendered bytes carry:
 * - `<div id="repo-files-table">` — the load-bearing CSS id (the template's
 *   own comment: "still use the old ID because there are many other CSS
 *   styles depending on this ID"). The `data-fetch-url` /
 *   `data-fetch-trigger` / `data-fetch-sync` / `data-fetch-indicator`
 *   attributes — emitted upstream only `{{if .HasFilesWithoutLatestCommit}}`
 *   (view.go:326-331 sets it when any row's Commit is nil) — are NOT
 *   emitted: the shared RepoFilesTable renders the landed §3.5 contract
 *   (muted `.notready` cell, "no partial-refresh endpoint"; this module
 *   DELIVERS the endpoint — flipping the attribute arm is a one-line change
 *   in components/file-list.tsx, that file's owner's call, not this module's).
 * - the `.repo-file-line.repo-file-last-commit` header row: the
 *   `repo/latest_commit.tmpl` subset (slice-1 LatestCommitBox — subject as
 *   the commit link, plain author name; no avatar stack / sign badge /
 *   statuses / ellipsis body) + `DateUtils.TimeSince
 *   .LatestCommit.Committer.When` in a bare `<div>`. `LatestCommit` here is
 *   `treeLastCommit` (commit_info.go:104-107: the treePath's own last
 *   commit; `commit` itself when treePath is "") — its `{{if not
 *   .LatestCommit}}…{{end}}` arm is the builder's null degradation.
 * - `{{$.FileIconPoolHTML}}` — the fileicon pool div is NOT emitted (the
 *   shared table renders inline octicon glyphs; the file-list header's
 *   documented icon degradation — also why the `..` parent row's
 *   `{{index $.FileIcons ".."}}` becomes the same plain folder glyph).
 * - the `{{if .HasParentPath}}` parent row: `<a class="repo-file-line
 *   parent-link silenced" href="{{.BranchLink}}{{PathEscapeSegments
 *   .ParentPath}}"> .. </a>`. BranchLink = RepoLink + "/src/" +
 *   refTypeNameSubURL (view_home.go:406); ParentPath carries a leading
 *   slash (view_home.go:416) whose PathEscapeSegments re-emits it, so the
 *   href is `{BranchLink}/{parent-dir}` — byte-identical to the shared
 *   table's `treeLink(repoLink, type, ref, parentPath)` shape, and for a
 *   top-level sub-directory (no ParentPath) the bare BranchLink (the table's
 *   treeLink base). HasParentPath is true for every non-root listing
 *   (view_home.go:414).
 * - per entry `{{range $item := .Files}}`: one `.repo-file-item` with three
 *   cells — `.repo-file-cell.name.muted-links` (glyph + the entry-name link
 *   onto TreeLink, `title` = the name), `.repo-file-cell.message
 *   .commit-summary` (RenderCommitMessageLinkSubject → our subject link onto
 *   `{RepoLink}/commit/{oid}`; `{{if not $commit}}notready{{end}}` with the
 *   `…` placeholder when nil), `.repo-file-cell.age` (TimeSince
 *   Committer.When, empty when nil). NOT ported (the shared table's landed
 *   subsetting, cited in its header): the directory name's
 *   GetSubJumpablePathName collapse (tree_entry.go:142-158 — single-child
 *   dir chains render one level per row here), the `IsLink` follow-symlink
 *   icon (view_list.tmpl), and the submodule SubmoduleWebLinkTree links.
 * - Link shapes: TreeLink = BranchLink + "/" + PathEscapeSegments(TreePath)
 *   (view_home.go:407-409); RefTypeNameSubURL is
 *   `PathEscapeSegments(shortName)` per segment (ref.go:238-244) — exactly
 *   the landed pathEscapeSegments/treeLink bytes, so parsing `refSubUrl`
 *   into (type, ref) and rendering through the shared table reproduces
 *   upstream's link strings for every well-formed value.
 *
 * ## refSubUrl (view.go:236-243)
 *
 * The route pins the listing to the COMMIT in the path (the
 * RefTypeCommit middleware: first wildcard segment is a 7..64-hex object id,
 * repo.go:915-921, remainder = treePath) but derives LINKS from the
 * `?refSubUrl=` query (`util.IfZero(path.Clean(refSubUrl),
 * ctx.Repo.RefTypeNameSubURL())` — the fallback is dead upstream because
 * path.Clean("") is "."; the degenerate values — no query, no type
 * segment — would emit `/src/.`-style links verbatim). This port parses the
 * cleaned value's `branch|tag|commit/<rest>` shape and falls back to the
 * path commit's own `commit/<sha>` context for everything else: the one
 * documented divergence in an arm the official bundle never produces (it
 * always appends `?refSubUrl=` — view.go:278). `commit` + literal `HEAD`
 * 404s like every landed commit-arm route (the resolveRefSuffix note —
 * upstream swaps the default branch's tip in, which costs an engine
 * round-trip the landed convention declines).
 *
 * ## Cost posture (honest, per request)
 *
 * 1 readCommit + 1 listTree + at most (1 + N) `listLog` RPCs (the tree's own
 * slot rides paths[0] when treePath ≠ ""), 8-wide batches, wall-time free
 * (DO RPC wait is not CPU). Upstream pays one git process for the same
 * answer (plus one ls-tree). Entries beyond the shared ENRICH_MAX budget
 * (page-data.ts §3.5 — the 50-subrequest ceiling) skip their RPC and render
 * `.notready`.
 *
 * ## HANDOFF — the route (a later index.ts window; this wave is
 * index.ts-sibling-held)
 *
 * The route arm maps onto this module as: parser arm `lastcommit` (the
 * `/{owner}/{repo}/lastcommit/*` family, GET, beside the wave-39 aux
 * families) holding `{ owner, repo, rawTail }`; the handler then
 * 1. `resolveUiRequest` (the shared session/repo prologue — index-owned);
 * 2. `parseLastCommitTail(route.rawTail)` → null ⇒ the §4.5 404 shell
 *    (upstream's pattern miss);
 * 3. `repo.isEmpty` + loader null ⇒ the same 404 shell (the aux-family
 *    convention: upstream's NotFound/ServerError pair both 404 here —
 *    commit-contained-refs.ts's note; HandleGitError answers
 *    tree_path_not_found 404 for a missing treePath, helper.go:11-19);
 * 4. `lastCommitFragmentResponse(lastCommitFragmentHtml(data, repoLink))`
 *    with repoLink `/${repo.ownerNamespace}/${repo.slug}`.
 * `lastcommit` never collides with the wave-18 single-tail `/commit/{sha}`
 * view claim (different family literal); the survey row's other halves
 * (blob_excerpt) stay documented skips.
 */

import type { CommitJson, TreeEntryJson } from "@cf-gitea/git-engine";

import { engineReads } from "../../api/services/engine";
import { RepoFilesTable } from "../components/file-list";
import { ENRICH_MAX } from "../page-data";
import { renderToString } from "hono/jsx/dom/server";
import type { RefType } from "../index";
import { naturalSortCompare } from "./tree-list-aux";
import { goPathClean } from "./tree-view-aux";

/** The loader's repo subset (the caller's resolved row — the aux convention). */
export type LastCommitRepo = {
  ownerNamespace: string;
  slug: string;
  isEmpty: boolean;
  defaultBranch: string;
};

/** Upstream `CommitInfo`'s rendered half (commit_info.go:9-13) — the Entry
 *  plus its last-touched Commit; `null` = the `.notready` row (budget or
 *  walk-cap miss). SubmoduleFile is not resolved (module doc). */
export interface LastCommitRow {
  entry: TreeEntryJson;
  commit: CommitJson | null;
}

/** The link context `?refSubUrl=` resolves to (the /src family's shape). */
export interface LastCommitLinkContext {
  refType: RefType;
  ref: string;
}

/** Everything the fragment builder renders. */
export interface LastCommitFragmentData {
  /** The listed directory ("" = root) — the resolved treePath half. */
  treePath: string;
  /** The commit the listing hangs off (the URL sha, resolved). */
  commit: CommitJson;
  /** Per-entry rows in render order (CustomSort applied). */
  rows: LastCommitRow[];
  /** The treePath's own last commit (commit_info.go:104-107; `commit`
   *  itself for the root listing; null = the template's `…` arm). */
  treeLastCommit: CommitJson | null;
  /** The /src link context from refSubUrl (links only — the listing always
   *  hangs off `commit`, never off this ref). */
  link: LastCommitLinkContext;
}

/** The route pattern's shape arm (web.go:1761's RefTypeCommit middleware +
 *  repo.go:915-921: first segment is a 7..64-hex object id, the landed
 *  commit-contained-refs COMMIT_SHA convention). */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

/** mergeBase batches per DO round-trip group — the batching convention
 *  (commit-contained-refs.ts), applied to the per-path listLog walk. */
const LASTCOMMIT_BATCH = 8;

/**
 * Split a decoded `/lastcommit/*` tail into the commit ref + treePath
 * (repo.go:915-921: the first segment must be the hex-shaped object id, the
 * remainder is the treePath — "this logic is different from other types"
 * upstream FIXME included: no existence check at parse time, the engine
 * readCommit re-gates). `null` = the route pattern's miss → 404 shell.
 */
export function parseLastCommitTail(tail: string): { commitRef: string; treePath: string } | null {
  const slash = tail.indexOf("/");
  const head = slash === -1 ? tail : tail.slice(0, slash);
  if (!COMMIT_SHA.test(head)) return null;
  return { commitRef: head, treePath: slash === -1 ? "" : tail.slice(slash + 1) };
}

/**
 * Resolve `?refSubUrl=` to the /src link context (view.go:236-243 + the
 * module doc's divergence note): `path.Clean` first (the shared Go-port),
 * then the `branch|tag|commit/<rest>` parse; anything else — including the
 * absent query's "." — falls back to the path commit's own context where
 * upstream would emit the degenerate string verbatim.
 */
export function parseRefSubUrl(raw: string, commitRef: string): LastCommitLinkContext {
  const cleaned = goPathClean(raw);
  const slash = cleaned.indexOf("/");
  if (slash > 0) {
    const type = cleaned.slice(0, slash);
    const rest = cleaned.slice(slash + 1);
    if ((type === "branch" || type === "tag" || type === "commit") && rest !== "") {
      return { refType: type, ref: rest };
    }
  }
  return { refType: "commit", ref: commitRef };
}

/**
 * Load one directory's commit-info listing (the GetCommitsInfo port — see
 * the module doc for the knob-by-knob mapping). `null` = the 404 family:
 * the empty repo (RepoRefByType's early return leaves upstream's Commit nil),
 * a wrong-shape or unresolvable sha (readCommit null — short prefixes fail
 * here: the full-oid divergence), a treePath that resolves to nothing
 * (HandleGitError's tree_path_not_found arm), or a failed read.
 */
export async function loadLastCommitFragment(
  env: Env,
  repo: LastCommitRepo,
  commitRef: string,
  treePath: string,
  refSubUrl: string,
): Promise<LastCommitFragmentData | null> {
  if (repo.isEmpty) return null; // RepoRefByType's empty arm (repo.go:930-944)
  const reads = engineReads(env, repo);
  const commit = await reads.readCommit(commitRef);
  if (commit === null) return null; // GetCommit's failure arm (the 404 class)
  const tree = await reads.listTree(commitRef, treePath);
  if (tree === null) return null; // SubTree/ListEntries → tree_path_not_found

  // view.go:292 CustomSort(base.NaturalSortCompare) — Entries.CustomSort's
  // dirs/submodules-first arm (tree_entry.go:163-171) then the natural
  // compare (the tree-list-aux shared port).
  const dirFirst = (entry: TreeEntryJson): number => (entry.type === "tree" || entry.type === "commit" ? 0 : 1);
  const entries = [...tree.entries].sort((a, b) => {
    const levelA = dirFirst(a);
    const levelB = dirFirst(b);
    if (levelA !== levelB) return levelA - levelB;
    return naturalSortCompare(a.name, b.name);
  });

  // GetCommitsInfo's entryNames (commit_info.go:82-86): the treePath itself
  // rides along ("for free during the tree traversal"), then every entry's
  // root-relative path (path.Join(treePath, name)). The tree slot is FIRST
  // so it always sits inside the enrichment budget.
  const paths: string[] = [];
  if (treePath !== "") paths.push(treePath);
  for (const entry of entries) {
    paths.push(treePath === "" ? entry.name : `${treePath}/${entry.name}`);
  }

  // One listLog(ref, {path, n:1}) per path — the newest commit whose tree
  // changed that path (the module doc's N+ posture), 8-wide batches;
  // anything past the shared budget (or the engine's walk cap, or a failed
  // RPC) stays null → the .notready cell.
  const resolved: (CommitJson | null)[] = new Array<CommitJson | null>(paths.length).fill(null);
  const budgeted = Math.min(paths.length, ENRICH_MAX);
  for (let i = 0; i < budgeted; i += LASTCOMMIT_BATCH) {
    const end = Math.min(i + LASTCOMMIT_BATCH, budgeted); // never past the budget
    await Promise.all(
      paths.slice(i, end).map(async (path, offset) => {
        const log = await reads.listLog(commitRef, { path, ofs: 0, n: 1 });
        resolved[i + offset] = log?.commits[0] ?? null;
      }),
    );
  }

  const rows: LastCommitRow[] = entries.map((entry, index) => ({
    entry,
    commit: resolved[index + (treePath === "" ? 0 : 1)] ?? null,
  }));
  // commit_info.go:104-107 — the treePath's own commit; the root listing's
  // is the commit itself (upstream skips revs[""] for "").
  const treeLastCommit = treePath === "" ? commit : (resolved[0] ?? null);

  return {
    treePath,
    commit,
    rows,
    treeLastCommit,
    link: parseRefSubUrl(refSubUrl, commitRef),
  };
}

/**
 * The tplRepoViewList fragment's bytes — the shared RepoFilesTable (the
 * landed view_list.tmpl port; every DOM decision cited in the module doc)
 * rendered standalone: no doctype, no layout, exactly the
 * `<div id="repo-files-table">…</div>` element the bundle's htmx morphs.
 */
export function lastCommitFragmentHtml(data: LastCommitFragmentData, repoLink: string): string {
  const commits = new Map<string, CommitJson | null>();
  for (const row of data.rows) commits.set(row.entry.name, row.commit);
  return renderToString(
    <RepoFilesTable
      repoLink={repoLink}
      refType={data.link.refType}
      ref={data.link.ref}
      dirPath={data.treePath}
      entries={data.rows.map((row) => row.entry)}
      commits={commits}
      latestCommit={data.treeLastCommit}
    />,
  );
}

/**
 * The fragment Response — ctx.HTML's `text/html; charset=utf-8`
 * (context_response.go:99's template render) plus the web middleware's
 * zero-option prod Cache-Control (httpcache.go:31; the render-files
 * fragment precedent).
 */
export function lastCommitFragmentResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}
