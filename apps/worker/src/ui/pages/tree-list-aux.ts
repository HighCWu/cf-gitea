/**
 * The file-browser's aux JSON — the parity survey's row 5 (top-5 #5), first
 * fragment: the recursive all-files feed the official bundle's "find file"
 * dialog fetches, upstream
 *
 *   GET /{owner}/{repo}/tree-list/{branch|tag|commit}/*   web.go:1297-1306
 *                                   repo.TreeList (routers/web/repo/treelist.go:24-49)
 *
 * ## JSON shape (the ported contract)
 *
 * A bare JSON ARRAY of recursive file paths, full paths from the repo root
 * (upstream `entry.Name()` over `ls-tree -r -t` entries — the "name field is
 * abused, here it is a full path" FIXME, modules/git/tree.go:138-139):
 *
 *     ["README.md", "src/app.ts", "src/lib/util.go", …]
 *
 * — consumed by web_src/js/features/repo-findfile.ts:78 (the
 * `data-tree-list-url` the code view emits,
 * templates/repo/view_content.tmpl:59, into RepoFileSearch.vue's weighted
 * filter — the dialog ranks client-side, so order is presentational).
 * Exclusions (treelist.go:51-64 isExcludedEntry): directories, submodules
 * ("commit" entries), and enry-vendor-detected files. The PATH TAIL in the
 * URL only feeds the ref middleware — the handler walks the ROOT tree
 * (`SubTree(ctx, gitRepo, "/")`, treelist.go:26), so the response ignores it.
 *
 * ## Ref resolution (the forced-type middleware, services/context/repo.go:905-985)
 *
 * `RepoRefByType(RefTypeBranch|Tag|Commit)` resolves the FIRST ref-universe
 * prefix of the tail IN THAT TYPE ONLY: the branch walk (plus the literal
 * `HEAD` → default-branch swap), the tag walk, or the 7..64-hex object-id
 * shape; a miss answers upstream's NotFound "branch or tag not exist"
 * (repo.go:976-979). This is exactly the landed `resolveRefSuffix`
 * machinery (src/ui/index.ts §3.3), fed the typed universe. An EMPTY repo
 * leaves upstream's `ctx.Repo.Commit` nil (repo.go:905-916 returns early),
 * so the handler fails at SubTree — our 404-family answer (the aux-JSON
 * convention, tag-list-aux's gate note).
 *
 * ## Arms
 *
 * - unknown/private repo → the §2.5 404 shell (the group's
 *   `reqUnitCodeReader`, web.go:1317);
 * - the ref-type literal is the route shape (web.go:1298-1300's three
 *   sub-routes): any other segment, or a missing typed tail
 *   (`/tree-list`, `/tree-list/branch`), is upstream's pattern miss →
 *   engine-owned;
 * - unresolvable ref (wrong universe, unknown oid, SHORT prefix — the
 *   full-oid divergence) or an unreadable storage walk → the §4.5 404 shell
 *   (upstream's NotFound / ServerError pair, both answered 404 here — the
 *   commit-contained-refs divergence note).
 *
 * ## Cost posture (honest)
 *
 * Upstream pays ONE `git ls-tree -t -r` process
 * (modules/git/tree.go:130-146). The engine boundary has no recursive tree
 * RPC: `listTree(ref, path)` is one level, so the walk issues one RPC per
 * DIRECTORY (breadth-first, 8-wide batches against the same DO — the
 * commit-contained-refs batching convention), wall-time free (DO RPC wait is
 * not CPU), linear in the directory universe where upstream's process is
 * not.
 *
 * ## Order (ported, with one documented divergence)
 *
 * `entries.CustomSort(base.NaturalSortCompare)` (treelist.go:31) — the
 * numeric-run logic of `modules/base/natural_sort.go:55-96` is ported
 * verbatim (digit-run grouping, leading-zero trimming, digit-count then
 * byte comparison, the whole-string byte fallback for ties). The
 * non-numeric runs upstream compares through `collate.New(language.English,
 * collate.Numeric)` (x/text English collation) are compared by code point
 * here — the contained-refs `-creatordate` class of divergence: only
 * mixed-case letter runs order differently, the client-side consumer
 * renders around it.
 */

import { engineReads } from "../../api/services/engine";
import { resolveRefSuffix, type RefType } from "../index";

/** The loader's repo subset (the caller's resolved row). */
export type TreeListRepo = {
  ownerNamespace: string;
  slug: string;
  isEmpty: boolean;
  defaultBranch: string;
};

/** The batch width per DO round-trip group (the contained-refs convention). */
const TREE_WALK_BATCH = 8;

/**
 * `NaturalSortCompare`'s numeric part, verbatim
 * (modules/base/natural_sort.go): split into alternating number/non-number
 * runs; number runs compare zero-trimmed (digit count, then bytes);
 * non-number runs compare by code point (the collation divergence above);
 * the whole-string byte comparison breaks every tie ("v1.02.3" < "v1.2.03").
 */
export function naturalSortCompare(s1: string, s2: string): number {
  const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
  const advance = (str: string, pos: number): { end: number; isNumber: boolean } => {
    let end = pos;
    let isNumber = false;
    while (end < str.length) {
      const cur = isDigit(str[end] as string);
      if (end === pos) {
        isNumber = cur;
        end += 1;
      } else if (cur === isNumber) {
        end += 1;
      } else {
        break;
      }
    }
    return { end, isNumber };
  };
  const trimZeros = (num: string): string => {
    let i = 0;
    while (i < num.length - 1 && num[i] === "0") i += 1;
    return num.slice(i);
  };
  let pos1 = 0;
  let pos2 = 0;
  while (pos1 < s1.length && pos2 < s2.length) {
    const run1 = advance(s1, pos1);
    const run2 = advance(s2, pos2);
    const part1 = s1.slice(pos1, run1.end);
    const part2 = s2.slice(pos2, run2.end);
    if (run1.isNumber && run2.isNumber) {
      if (part1 !== part2) {
        const num1 = trimZeros(part1);
        const num2 = trimZeros(part2);
        if (num1.length !== num2.length) return num1.length - num2.length; // more digits means larger value
        if (num1 !== num2) return num1 < num2 ? -1 : 1; // equal digit count: byte order is numeric order
      } // naturally equal value: leave it to the outer comparison
    } else {
      if (part1 !== part2) return part1 < part2 ? -1 : 1; // the collation divergence (module header)
    }
    pos1 = run1.end;
    pos2 = run2.end;
  }
  return s1 < s2 ? -1 : s1 > s2 ? 1 : 0; // each field naturally equal: string comparison
}

/**
 * One listTree level → the full child paths, or `null` when the read fails
 * (the 404 family — module header). Directories extend the frontier, blobs
 * (symlinks included — upstream's recursive entries keep them) land in the
 * output, submodules ("commit") are excluded exactly like
 * `isExcludedEntry`'s IsSubModule arm.
 */
function collectLevel(entries: readonly { name: string; type: "tree" | "blob" | "commit" }[], dir: string): { files: string[]; dirs: string[] } {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const entry of entries) {
    const full = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.type === "tree") dirs.push(full);
    else if (entry.type === "blob") files.push(full);
    // "commit" (submodule): excluded (treelist.go:56-58)
  }
  return { files, dirs };
}

/**
 * Load the recursive file-path universe at one ref. `null` = the 404 family:
 * the empty repo, an unresolvable ref (wrong universe / unknown / short oid),
 * or a failed tree read anywhere in the walk (module header).
 */
export async function loadTreeListAux(env: Env, repo: TreeListRepo, refType: RefType, refSuffix: string): Promise<string[] | null> {
  if (repo.isEmpty) return null; // the nil-Commit arm (module header)
  const reads = engineReads(env, repo);
  const refs = await reads.listRefs();
  if (refs === null) return null;
  const names = refs.refs.map((ref) => ref.name);
  const resolved = resolveRefSuffix(
    refType,
    refSuffix,
    {
      branches: names.filter((name) => name.startsWith("refs/heads/")).map((name) => name.slice("refs/heads/".length)),
      tags: names.filter((name) => name.startsWith("refs/tags/")).map((name) => name.slice("refs/tags/".length)),
      defaultBranch: repo.defaultBranch,
    },
  );
  if (resolved === null) return null; // "branch or tag not exist" (repo.go:976-979)

  // The root walk (treelist.go:26 — SubTree("/") — the path tail is ignored)
  // and the batched BFS descent (the cost posture above).
  const files: string[] = [];
  let frontier: string[] = [""];
  while (frontier.length > 0) {
    const nextDirs: string[] = [];
    for (let i = 0; i < frontier.length; i += TREE_WALK_BATCH) {
      const levels = await Promise.all(
        frontier.slice(i, i + TREE_WALK_BATCH).map(async (dir) => ({ dir, tree: await reads.listTree(resolved.ref, dir) })),
      );
      for (const level of levels) {
        if (level.tree === null) return null; // the storage-read 404 family
        const collected = collectLevel(level.tree.entries, level.dir);
        files.push(...collected.files);
        nextDirs.push(...collected.dirs);
      }
    }
    frontier = nextDirs;
  }
  files.sort(naturalSortCompare); // treelist.go:31's CustomSort over the recursive entries
  return files;
}

/**
 * The aux JSON Response — ctx.JSON's `application/json;charset=utf-8`
 * (services/context/base.go:115-122) plus the web middleware's zero-option
 * prod Cache-Control (the tag-list/contained-refs sibling; the findfile
 * dialog fetches fresh per open).
 */
export function treeListResponse(files: string[]): Response {
  return new Response(JSON.stringify(files), {
    status: 200,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}
