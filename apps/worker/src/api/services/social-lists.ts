import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, repoWatchers, stars, users } from "../../db/schema";
import type { RepositoryWithOwner, UserRow } from "./repository";
import { WatchMode } from "./repo-watchers";

/**
 * Tier-2 social listings behind the T2 listing routes (SPEC-0004 appendix A
 * rows: repoListStargazers / repoListSubscribers / userListStarred /
 * userCurrentListSubscriptions / userListSubscriptions — upstream
 * routers/api/v1/repo/star.go ListStargazers, repo/subscribe.go Subscribers,
 * user/star.go GetStarredRepos, routers/api/v1/user/watch.go
 * GetMyWatchedRepos (/user/subscriptions) + GetWatchedRepos
 * (/users/{username}/subscriptions)).
 *
 * Pure reads over the migrated `stars` / `repo_watchers` tables (0008) — the
 * same stores services/stars.ts and services/repo-watchers.ts write; Drizzle
 * only, per the architecture boundary.
 *
 * Visibility: repository-backed lists apply the landed reduced ACL (public,
 * plus rows the requesting doer owns; the admin arm drops the filter) — the
 * listStarredRepositories convention. User-backed lists (stargazers,
 * subscribers) skip the per-user visibility gate: every user row is public
 * until the SPEC-0007 visibility model reaches the directory (the
 * routes/follows.ts standing convention, documented there).
 */

export interface SocialListOptions {
  page: number;
  pageSize: number;
}

/** ListStargazers (models/repo/star.go GetStargazers) — the repo's starrers,
 *  `users.id` order. */
export async function listRepoStargazers(
  d1: D1Database,
  repoId: string,
  options: SocialListOptions,
): Promise<{ items: UserRow[]; total: number }> {
  const db = drizzle(d1);
  const totalRow = await db
    .select({ total: sql<number>`count(*)` })
    .from(stars)
    .innerJoin(users, eq(users.id, stars.userId))
    .where(eq(stars.repoId, repoId))
    .get();
  const items = await db
    .select({ user: users })
    .from(stars)
    .innerJoin(users, eq(users.id, stars.userId))
    .where(eq(stars.repoId, repoId))
    .orderBy(asc(users.id))
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize);
  return { items: items.map((row) => row.user), total: totalRow?.total ?? 0 };
}

/** Subscribers (routers/api/v1/repo/subscriber.go → GetRepoWatchers,
 *  models/repo/watch.go:295-308) — the repo's watchers, `users.id` order.
 *  Mode-aware: `watch.mode <> Dont` (:298) — a persisted ignore row (the
 *  Auto-unwatch landing, watch.go:164-165) is not a subscriber. */
export async function listRepoSubscribers(
  d1: D1Database,
  repoId: string,
  options: SocialListOptions,
): Promise<{ items: UserRow[]; total: number }> {
  const db = drizzle(d1);
  const watcherFilter = and(eq(repoWatchers.repoId, repoId), ne(repoWatchers.mode, WatchMode.Dont));
  const totalRow = await db
    .select({ total: sql<number>`count(*)` })
    .from(repoWatchers)
    .innerJoin(users, eq(users.id, repoWatchers.userId))
    .where(watcherFilter)
    .get();
  const items = await db
    .select({ user: users })
    .from(repoWatchers)
    .innerJoin(users, eq(users.id, repoWatchers.userId))
    .where(watcherFilter)
    .orderBy(asc(users.id))
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize);
  return { items: items.map((row) => row.user), total: totalRow?.total ?? 0 };
}

/**
 * GetWatchedRepos (models/repo/user_repo.go:82-114 — ToConds :82-100,
 * GetWatchedRepos :112-114) — the repositories one user watches,
 * newest-repo order not modeled: the same numeric-id ordering the
 * starred list uses (`CAST(id AS INTEGER)` — the text-id convention). The
 * visibility predicate mirrors services/stars.ts listStarredRepositories:
 * public rows plus rows owned by the REQUESTING doer; the admin arm drops
 * the filter entirely. Mode-aware: ToConds' `watch.mode <> WatchModeDont`
 * (user_repo.go:97-99) — an ignored repo leaves the watched list.
 *
 * RE-PIN 099abf5db4 (REPIN-WATCH 2026-11-20): models/repo/user_repo.go is
 * UNTOUCHED in the window fc49368845..099abf5db4 — this arm's upstream
 * semantics are byte-stable (the route-side deltas — 5671c5192d's missing
 * `return`, db9d2944d8's attribute pre-load, the swagger fold — live in
 * routers/api/v1/user/watch.go and are noted on routes/social-t2.ts).
 * 6782d0a37d/03fc2bdcc8's repo_list.go accessibility changes do not reach
 * this listing: the route builds WatchedReposOptions (no RepoOwnerID,
 * unit.TypeInvalid-equivalent — ToConds always applied
 * AccessibleRepositoryCondition for IncludePrivate), never
 * SearchRepositoryCondition.
 */
export async function listWatchedRepositories(
  d1: D1Database,
  userId: number,
  options: { doerLoginLower: string; isAdmin: boolean } & SocialListOptions,
): Promise<{ items: RepositoryWithOwner[]; total: number }> {
  const db = drizzle(d1);
  const modeFilter = ne(repoWatchers.mode, WatchMode.Dont);
  const where = options.isAdmin
    ? and(eq(repoWatchers.userId, userId), modeFilter)
    : and(
        eq(repoWatchers.userId, userId),
        modeFilter,
        or(eq(repositories.visibility, "public"), eq(repositories.ownerNamespace, options.doerLoginLower)),
      );
  const totalRow = await db
    .select({ total: sql<number>`count(*)` })
    .from(repoWatchers)
    .innerJoin(repositories, eq(repositories.id, repoWatchers.repoId))
    .where(where)
    .get();
  const items = await db
    .select({ repo: repositories, owner: users })
    .from(repoWatchers)
    .innerJoin(repositories, eq(repositories.id, repoWatchers.repoId))
    .innerJoin(users, eq(users.usernameLower, repositories.ownerNamespace))
    .where(where)
    .orderBy(sql`CAST(${repositories.id} AS INTEGER) ASC`)
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize);
  return { items, total: totalRow?.total ?? 0 };
}
