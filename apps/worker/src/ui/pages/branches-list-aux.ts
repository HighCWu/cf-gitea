/**
 * The branches page's aux JSON — the parity survey's row 5 (top-5 #5), second
 * fragment: the bare branch-name feed, upstream
 *
 *   GET /{owner}/{repo}/branches/list   web.go:1695 repo.GetBranchesList
 *                                   (routers/web/repo/repo.go:565-583 —
 *                                   git_model.FindBranchNames into the
 *                                   shared branchTagSearchResponse)
 *
 * ## JSON shape (the ported contract, byte-order included)
 *
 * `branchTagSearchResponse` (repo.go:560-562) marshals exactly
 *
 *     { "results": ["main", "feature", …] }
 *
 * — the same struct `/tags/list` serves (pages/tag-list-aux.ts), entries bare
 * branch NAMES (no links, no metadata). The handler applies NO filter and
 * reads NO query param: every non-deleted branch name, unpaginated
 * (`ListOptionsAll`, repo.go:568). Upstream reads its `branch` DB TABLE
 * (`IsDeletedBranch: optional.Some(false)` — deleted branches live only in
 * that table, a state the ref universe cannot carry, so the filter is a
 * no-op for this port); the engine's `listRefs` is the name universe — the
 * branches page's exact read (pages/branches.tsx:88).
 *
 * ## Order (repo.go:574-580 — default branch hoisted, then the store's order)
 *
 * The default branch moves to the top when present
 * (`slices.Contains` + prepend); the REST ride `FindBranchOptions`' default
 * `ToOrders` — `commit_time DESC, name ASC` (models/git/branch_list.go:89-93).
 * The engine boundary carries no commit times on refs (the
 * commit-contained-refs `-creatordate` divergence verbatim), so the tail
 * sorts in byte order — the branches page / tag-list sortedRefs convention,
 * documented divergence. The default-branch tie is impossible (hoisted out).
 *
 * ## Arms
 *
 * - the group gate `repo.MustBeNotEmpty` (web.go:1696) — an EMPTY repo
 *   404-shells (the tag-list-aux twin; empty upstream repos carry no branch
 *   rows either);
 * - unknown/private repo → the §2.5 404 shell (the group's
 *   `reqUnitCodeReader`, web.go:1317);
 * - a failed ref read degrades to the empty list (§4.9 — unreadable storage
 *   answers an empty feed, never a broken page; the tag-list loader's
 *   `refs ?? []` arm verbatim).
 *
 * This module holds the loader + the JSON Response builder only; the handler
 * lives in src/ui/index.ts beside its sibling dispatchers (the
 * resolveUiRequest session/repo prologue is index-owned). Not a page — the
 * wave-33 tag-list-aux sibling module.
 */

import { engineReads } from "../../api/services/engine";

/** `branchTagSearchResponse` (repo.go:560-562) — the field order is the Go
 *  struct's marshal order (one member). */
export interface BranchListSearchResponse {
  results: string[];
}

/** The loader's repo subset (the caller's resolved row). */
export type BranchListRepo = {
  ownerNamespace: string;
  slug: string;
  isEmpty: boolean;
  defaultBranch: string;
};

/**
 * Load the branch-name universe: `refs/heads/*`, byte-order sorted (the
 * `commit_time DESC` divergence above), the default branch hoisted to the
 * top (repo.go:574-580).
 */
export async function loadBranchesListAux(env: Env, repo: BranchListRepo): Promise<BranchListSearchResponse> {
  if (repo.isEmpty) return { results: [] }; // MustBeNotEmpty (web.go:1696's group gate)
  const refs = await engineReads(env, repo).listRefs();
  const names = (refs?.refs ?? [])
    .filter((ref) => ref.name.startsWith("refs/heads/"))
    .map((ref) => ref.name.slice("refs/heads/".length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // The default-branch hoist (repo.go:574-580) — prepend when present.
  const withoutDefault = names.filter((name) => name !== repo.defaultBranch);
  const results = names.includes(repo.defaultBranch) ? [repo.defaultBranch, ...withoutDefault] : withoutDefault;
  return { results };
}

/**
 * The aux JSON Response — ctx.JSON's `application/json;charset=utf-8`
 * (services/context/base.go:115-122) plus the web middleware's zero-option
 * prod Cache-Control (the tagListResponse sibling).
 */
export function branchesListResponse(data: BranchListSearchResponse): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}
