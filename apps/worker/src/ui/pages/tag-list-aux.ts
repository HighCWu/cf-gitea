/**
 * The tags page's aux JSON — the parity survey's row 2 tail (top-5 #2): the
 * bare tag-name feed, upstream
 *
 *   GET /{owner}/{repo}/tags/list   web.go:1499 repo.GetTagList
 *                                   (routers/web/repo/repo.go:587-597 —
 *                                   repo_model.GetTagNamesByRepoID into the
 *                                   shared branchTagSearchResponse)
 *
 * ## JSON shape (the ported contract)
 *
 * `branchTagSearchResponse` (repo.go:560-562) marshals exactly
 *
 *     { "results": ["v1.0.0", …] }
 *
 * — the `results` key is lowercase (the Go tag), the entries bare tag NAMES
 * (no links, no metadata — the siblings `/branches/list` and the API
 * branch/tag search share the struct). The handler applies NO filter and
 * reads NO query param: every tag name, unpaginated (the `?q=` search and
 * `?page=` pager of the tags PAGE are its own form/links, never this feed).
 *
 * ## When the page fetches it
 *
 * At the pin it never does: the tags list template
 * (templates/repo/tag/list.tmpl) renders server-side and the search combo is
 * a plain GET form, and no web_src consumer references the `/tags/list` URL
 * (grepped at the pin — the new-release form's tag list rides the
 * server-rendered `data-existing-tags`, release/new.tmpl:15). The route is
 * the shape-parity surface for bundle/external consumers (the API's
 * repoListTags carrying a different envelope), and this slice ships it so
 * the web mux's tag tails are complete.
 *
 * ## Arms
 *
 * - the group gates (web.go:1500: optSignIn + RepoAssignment +
 *   MustBeNotEmpty + reqUnitCodeReader) reduce to the tags page's own
 *   posture: an invisible repo 404-shells through the §2.5 read, an EMPTY
 *   repo 404-shells (MustBeNotEmpty).
 * - order (the B-54 landing — RL11's recorded divergence closes): upstream
 *   GetTagNamesByRepoID reads the RELEASES TABLE —
 *   FindReleasesOptions{IncludeDrafts, IncludeTags, HasSha1: Some(true)}
 *   (models/repo/release.go:317-335; ToConds' HasSha1 arm is
 *   `sha1 != ''`, which NULL sha1 rows drop out of the same way SQLite
 *   evaluates the comparison) — ordered `created_unix DESC, id DESC`
 *   (ToOrders, release.go:313-315). The B-54 mint arms give every pushed
 *   and API-created tag its row (pushUpdateAddTags / CreateNewTag), so
 *   this feed now rides that same table instead of substituting
 *   creator-date sorting over the engine's name universe (the old
 *   documented divergence — retired with the mint). One consequence both
 *   trees share: a tag whose row mint FAILED (the tail is a logged no-op)
 *   has no row and is invisible here — upstream's queue lag produces the
 *   same state.
 *
 * This module holds the loader + the JSON Response builder only; the handler
 * lives in src/ui/index.ts beside its sibling dispatchers (the resolveUiRequest
 * session/repo prologue is index-owned). Not a page — the wave-32
 * commit-contained-refs aux-JSON sibling.
 */

import { and, desc, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { releases } from "../../db/schema";

/** `branchTagSearchResponse` (repo.go:560-562) — the field order is the Go
 *  struct's marshal order (one member). */
export interface TagListSearchResponse {
  results: string[];
}

/** The loader's repo subset (the caller's resolved row). */
export type TagListRepo = {
  id: string;
  ownerNamespace: string;
  slug: string;
  isEmpty: boolean;
};

/**
 * Load the tag-name universe (GetTagNamesByRepoID's exact read: the
 * release rows with a real sha, newest created first, the id the
 * tiebreak — the module header's order note). A failed read degrades to
 * the empty list (§4.9 — unreadable storage answers an empty feed, never a
 * broken page; the API LIST's `refs ?? []` arm).
 */
export async function loadTagListAux(env: Env, repo: TagListRepo): Promise<TagListSearchResponse> {
  if (repo.isEmpty) return { results: [] }; // MustBeNotEmpty (web.go:1499's group gate)
  try {
    const rows = await drizzle(env.DB)
      .select({ tagName: releases.tagName })
      .from(releases)
      // GetTagNamesByRepoID's ToConds: IncludeDrafts+IncludeTags set no
      // flags filter; HasSha1 Some(true) is `sha1 != ''` (NULL sha1 rows
      // drop out of the comparison the same way upstream's xorm WHERE
      // drops them).
      .where(and(eq(releases.repoId, repo.id), ne(releases.sha1, "")))
      .orderBy(desc(releases.createdAt), desc(releases.id))
      .all();
    return { results: rows.map((row) => row.tagName) };
  } catch {
    return { results: [] };
  }
}

/**
 * The aux JSON Response — ctx.JSON's `application/json;charset=utf-8`
 * (services/context/base.go:115-122) plus the web middleware's zero-option
 * prod Cache-Control (the wave-32 containedRefsResponse sibling; no upstream
 * consumer caches the feed — it fetches fresh).
 */
export function tagListResponse(data: TagListSearchResponse): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}
