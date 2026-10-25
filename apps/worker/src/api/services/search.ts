/**
 * Explore-search reads for the tier-2 UI pages — `/explore/repos` and
 * `/explore/users` (SPEC-0008 pages wave 9), upstream `routers/web/explore/`
 * reduced to the landed stores:
 *
 * - repo.go `Repos` → `RenderRepoSearch`: `SearchRepository` with
 *   `Private: ctx.Doer != nil` (a signed-in viewer's own private repos are
 *   in scope, anonymous sees public rows only), `AllPublic/AllLimited`,
 *   page size `setting.UI.ExplorePagingNum` = 20, `?q=` keyword.
 * - user.go `Users` → `RenderUserSearch`: `SearchUsers` with
 *   `Types: [UserTypeIndividual]` + `IsActive: Some(true)` + all three
 *   visibilities, page size `setting.UI.ExplorePagingNum`, `?q=` keyword.
 *
 * ## Choice recorded (wave-9 brief: "survey for a non-admin-capable search
 * service; extract/reuse only if only the admin arm exists")
 *
 * BOTH landed search services are already non-admin-capable, so no query had
 * to be freed from the admin routes:
 *
 * - `searchRepositories` (services/repository.ts — the `/repos/search` half)
 *   is reused VERBATIM through `searchExploreRepos` below. The only addition
 *   is the session-doer → API `Viewer` seam: the session viewer's
 *   `{ id, username, isAdmin }` maps onto the two requester fields the WHERE
 *   actually reads (`login`, `is_admin` — the contract `User` model's fields
 *   are optional, so the seam constructs a legal value, no casts), and
 *   `includePrivate` carries upstream's `Private: ctx.Doer != nil`.
 * - `searchUsers` (services/user.ts — the `/users/search` half) has no
 *   options for the explore page's Types/IsActive gates: without them the
 *   org rows that share the `users` table surface on a "Users" page. Rather
 *   than edit the landed route/service, `searchExploreUsers` re-issues that
 *   service's exact predicate set (the parameterized `instr()` keyword match
 *   — D1 caps LIKE patterns, the service header documents why — and the
 *   alphabetical ordering family) plus the two upstream gates, and the four
 *   upstream sort orders (user.go's orderBy switch; `newest` is the page
 *   default because `ExploreDefaultSort` "recentupdate" is outside the
 *   users page's SupportedSortOrders).
 */

import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";
import { searchRepositories, type RepositoryWithOwner, type Viewer } from "./repository";

/** D1 row of the `users` table (src/db/schema.ts). */
export type ExploreUserRow = typeof users.$inferSelect;

/** The session-viewer slice the explore search needs (`null` = anonymous). */
export interface ExploreDoer {
  id: number;
  /** Display-cased login — the seam lowercases it like the service does. */
  username: string;
  isAdmin: boolean;
}

export interface ExploreListOptions {
  /** Trimmed `?q=` — empty means unfiltered (upstream FormTrim). */
  keyword: string;
  /** Effective (already clamped) pagination. */
  page: number;
  limit: number;
}

export interface ExploreRepoListPage {
  items: RepositoryWithOwner[];
  total: number;
}

/**
 * The explore repos sort mapping — upstream `RenderRepoSearch` reads
 * `?sort=` against the web explore vocabulary and falls back to
 * `ExploreDefaultSort` ("recentupdate") for unknown values, never an error.
 * The landed `searchRepositories` speaks the API vocabulary, so the four
 * web sorts with a real landed backing map through and everything else
 * (recentupdate/leastupdate — no maintained sort key the service honors —
 * plus the stars/forks/size family) degrades to the service's own default
 * (slug ASC), the org-home "landed order wins" divergence.
 */
export function exploreRepoSort(sort: string): { sort: string; order: string } {
  switch (sort) {
    case "newest":
      return { sort: "created", order: "desc" };
    case "oldest":
      return { sort: "created", order: "asc" };
    case "alphabetically":
      return { sort: "alpha", order: "asc" };
    case "reversealphabetically":
      return { sort: "alpha", order: "desc" };
    default:
      return { sort: "", order: "" };
  }
}

/**
 * `/explore/repos` (upstream explore.Repos → SearchRepository): the landed
 * `searchRepositories` query with upstream's web-explore option set —
 * `Private: doer != null` and everything else at its neutral value
 * (`?topic=`/`?archived=`/… facets have no landed backing; the page does not
 * render their controls).
 */
export async function searchExploreRepos(
  d1: D1Database,
  doer: ExploreDoer | null,
  opts: ExploreListOptions & { sort: string },
): Promise<ExploreRepoListPage> {
  const viewer: Viewer = {
    origin: "",
    requester: doer === null ? null : { login: doer.username, is_admin: doer.isAdmin },
  };
  const mapped = exploreRepoSort(opts.sort);
  const listing = await searchRepositories(d1, viewer, {
    page: opts.page,
    limit: opts.limit,
    keyword: opts.keyword,
    topicOnly: false,
    includeDesc: false,
    uid: 0,
    exclusive: false,
    priorityOwnerId: 0,
    teamId: 0,
    starredBy: 0,
    includePrivate: doer !== null, // upstream Repos: Private: ctx.Doer != nil
    isPrivate: null,
    template: null,
    archived: null,
    mode: "",
    sort: mapped.sort,
    order: mapped.order,
  });
  return listing;
}

export interface ExploreUserListPage {
  items: ExploreUserRow[];
  total: number;
}

/** The four upstream users-page sorts (user.go's orderBy switch). */
export type ExploreUserSort = "newest" | "oldest" | "alphabetically" | "reversealphabetically";

/** `?sort=` against SupportedSortOrders; unknown values degrade to the page
 *  default ("newest") — upstream 404s them, a search page reads better
 *  degradation-first (documented divergence). */
export function parseExploreUserSort(raw: string | null): ExploreUserSort {
  switch (raw) {
    case "oldest":
    case "alphabetically":
    case "reversealphabetically":
      return raw;
    default:
      return "newest";
  }
}

function exploreUserOrderBy(sort: ExploreUserSort): SQL[] {
  switch (sort) {
    case "newest":
      return [desc(users.id)];
    case "oldest":
      return [asc(users.id)];
    case "alphabetically":
      return [asc(users.usernameLower)];
    case "reversealphabetically":
      return [desc(users.usernameLower)];
  }
}

/**
 * `/explore/users` (upstream explore.Users → SearchUsers): the landed
 * `searchUsers` predicate set (services/user.ts — `instr()` substring on
 * `username_lower`) plus the explore page's two gates, `Types:
 * [UserTypeIndividual]` + `IsActive: Some(true)` (user.go:178-187), all
 * three visibilities in scope (upstream's Visible triple). Org rows and
 * prohibited accounts never surface; private/limited USERS do — upstream's
 * explore lists them (Visibility badge in user_list.tmpl).
 */
export async function searchExploreUsers(
  d1: D1Database,
  opts: ExploreListOptions & { sort: ExploreUserSort },
): Promise<ExploreUserListPage> {
  const conditions: SQL[] = [eq(users.type, "user"), eq(users.status, "active")];
  if (opts.keyword !== "") {
    // The landed searchUsers keyword arm, verbatim (services/user.ts:92).
    conditions.push(sql`instr(${users.usernameLower}, ${opts.keyword.toLowerCase()}) > 0`);
  }
  const where = and(...conditions);
  const db = drizzle(d1);

  const totalRows = await db
    .select({ value: sql<number>`count(*)` })
    .from(users)
    .where(where);
  const items = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(...exploreUserOrderBy(opts.sort))
    .limit(opts.limit)
    .offset((opts.page - 1) * opts.limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}
