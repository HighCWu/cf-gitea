/**
 * The commit view's aux JSON — the parity survey's row 3: the
 * branches/tags-containing-this-commit feed the official bundle's commit
 * page fetches for the switcher dropdowns, upstream
 *
 *   GET /{owner}/{repo}/commit/{sha}/load-branches-and-tags   web.go:1740
 *                                   repo.LoadBranchesAndTags
 *                                   (routers/web/repo/commit.go:267-277 →
 *                                   services/repository/commit.go:26-57)
 *
 * ## JSON shape (the ported contract, byte-order included)
 *
 * `ContainedLinks` (services/repository/commit.go:12-20) marshals as
 *
 *     { "branches": [{ "name": …, "web_link": … }],
 *       "tags":     [{ "name": …, "web_link": … }],
 *       "default_branch": … }
 *
 * — consumed by web_src/js/features/repo-diff-commit.ts:7-24 (GETs the
 * button's data-url, renders one link per entry into `.branch-area` /
 * `.tag-area`, marks `name === default_branch` with the default-branch
 * tooltip) fed from templates/repo/commit_load_branches_and_tags.tmpl:10-13.
 * `web_link` = `{RepoLink}/src/{branch|tag}/{PathEscapeSegments(name)}`
 * (commit.go:41-51) — our repoLink + the links.ts path-escape convention.
 *
 * ## Containment semantics + cost posture (honest)
 *
 * Upstream runs `git branch --contains <sha>` / `git tag --contains <sha>`
 * (modules/git/repo_ref.go:24-45 ListOccurrences, `--sort=-creatordate`) —
 * two git processes, each classifying every ref in one graph walk. The
 * engine boundary has no batched `--contains`: `listRefs` yields tips and
 * `mergeBase(tip, commit) === commit` is the exact containment predicate
 * (base == the commit iff the commit is an ancestor of — or equal to — the
 * tip; packages/git-engine merge/graph.ts, each call a bounded two-sided
 * walk, MERGE_BASE_MAX_VISITS 50k). So the answer costs ONE listRefs + ONE
 * readCommit + one mergeBase RPC per candidate ref (heads + peeled tags),
 * issued in 8-wide batches against the same DO — N+2 round-trips where
 * upstream pays 2 processes, wall-time free (DO RPC wait is not CPU) and
 * per-call bounded, but linear in the ref universe where upstream's walk is
 * not. Annotated tags compare through their PEELED commit (refTipMap's
 * `peeled`), like GetCommit through a tag object. Upstream's
 * `-creatordate` ref order is NOT reproducible from the boundary (RefsResult
 * carries no dates) — candidates sort by name for determinism, a documented
 * divergence the consumer renders around (order is cosmetic).
 *
 * ## Arms
 *
 * - the route group's `MustBeNotEmpty` (web.go:1741): an empty repo 404s;
 * - the sha is hex-shaped 7..64 by the ROUTE PATTERN (web.go:1740's
 *   `([a-f0-9]{7,64})` — the parser claims the shape, the loader re-gates);
 *   a hex sha the engine cannot resolve (unknown oid, or any SHORT prefix —
 *   the landed full-oid divergence) 404s here where upstream answers its
 *   ServerError 500 (ListOccurrences fails on the bogus sha,
 *   commit.go:269-272): the §4.5 404-family convention every ui download
 *   family carries, divergence documented.
 *
 * This module holds the loader + the JSON Response builder; the handler
 * lives in src/ui/index.ts (the resolveUiRequest session/repo prologue is
 * index-owned). Not a page — the aux-JSON sibling of the diffpatch files.
 */

import { engineReads, refTipMap } from "../../api/services/engine";
import { pathEscapeSegments } from "../page-data";

/** `namedLink` (services/repository/commit.go:17-20). */
export interface ContainedRefLink {
  name: string;
  web_link: string;
}

/** `ContainedLinks` (services/repository/commit.go:12-16) — the field order
 *  is the Go struct's marshal order. */
export interface ContainedLinks {
  branches: ContainedRefLink[];
  tags: ContainedRefLink[];
  default_branch: string;
}

/** Upstream route pattern `([a-f0-9]{7,64})` (web.go:1740) — shape gate
 *  only; existence is the engine read's answer. The commit-view/diffpatch
 *  COMMIT_SHA convention verbatim. */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;

/** The loader's repo subset (the caller's resolved row). */
export type ContainedRefsRepo = {
  ownerNamespace: string;
  slug: string;
  isEmpty: boolean;
  defaultBranch: string;
};

/** mergeBase batches per DO round-trip group — polite concurrency against
 *  one cell, the cost posture's N+2 made concrete. */
const CONTAINMENT_BATCH = 8;

/**
 * Load the containing branches + tags for one commit. `null` = the 404
 * family: the empty-repo gate, a wrong-shape segment, or a commit the
 * engine cannot resolve (unknown/short oid — the documented divergence).
 */
export async function loadCommitContainedRefs(env: Env, repo: ContainedRefsRepo, sha: string): Promise<ContainedLinks | null> {
  if (repo.isEmpty) return null; // MustBeNotEmpty (web.go:1741)
  if (!COMMIT_SHA.test(sha)) return null; // the route pattern's shape arm
  const reads = engineReads(env, repo);
  const commit = await reads.readCommit(sha);
  if (commit === null) return null;
  const tips = refTipMap(await reads.listRefs());

  // The candidates: branch tips and (peeled) tag tips, name-sorted (the
  // `-creatordate` divergence above).
  interface Candidate {
    name: string;
    tip: string;
    contained: boolean;
  }
  const branches: Candidate[] = [];
  const tags: Candidate[] = [];
  for (const [name, tip] of tips) {
    if (name.startsWith("refs/heads/")) {
      branches.push({ name: name.slice("refs/heads/".length), tip: tip.target, contained: false });
    } else if (name.startsWith("refs/tags/")) {
      tags.push({ name: name.slice("refs/tags/".length), tip: tip.peeled ?? tip.target, contained: false });
    }
  }
  const byName = (a: Candidate, b: Candidate): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  branches.sort(byName);
  tags.sort(byName);

  // The containment predicate: mergeBase(tip, commit) === commit. A "missing"
  // side (a ref racing a delete) skips that ref, like upstream's per-ref
  // tolerance inside one walk.
  const candidates = [...branches, ...tags];
  for (let i = 0; i < candidates.length; i += CONTAINMENT_BATCH) {
    await Promise.all(
      candidates.slice(i, i + CONTAINMENT_BATCH).map(async (candidate) => {
        const merged = await reads.mergeBase(candidate.tip, commit.oid);
        candidate.contained = merged !== null && merged.tag === "ok" && merged.base === commit.oid;
      }),
    );
  }

  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const links = (list: Candidate[], kind: "branch" | "tag"): ContainedRefLink[] =>
    list
      .filter((candidate) => candidate.contained)
      .map((candidate) => ({
        name: candidate.name,
        web_link: `${repoLink}/src/${kind}/${pathEscapeSegments(candidate.name)}`,
      }));
  return {
    branches: links(branches, "branch"),
    tags: links(tags, "tag"),
    default_branch: repo.defaultBranch,
  };
}

/**
 * The aux JSON Response — ctx.JSON's `application/json;charset=utf-8`
 * (services/context/base.go:115-122) plus the web middleware's zero-option
 * prod Cache-Control (the diffpatch precedent; the official bundle caches
 * nothing here, it fetches per button click).
 */
export function containedRefsResponse(data: ContainedLinks): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}
