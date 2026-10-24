import { and, asc, eq, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, repoWatchers, stars, users } from "../../db/schema";
import type { RepositoryWithOwner, UserRow } from "./repository";

/**
 * Tier-2 social listings behind the T2 listing routes (SPEC-0004 appendix A
 * rows: repoListStargazers / repoListSubscribers / userListStarred /
 * userCurrentListSubscriptions / userListSubscriptions — upstream
 * routers/api/v1/repo/star.go ListStargazers, repo/subscribe.go Subscribers,
 * user/star.go GetStarredRepos, repo/subscribe.go MySubscriptions plus the
 * /users variant).
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

/** Subscribers (models/repo/watch.go GetWatchers) — the repo's watchers,
 *  `users.id` order. */
export async function listRepoSubscribers(
  d1: D1Database,
  repoId: string,
  options: SocialListOptions,
): Promise<{ items: UserRow[]; total: number }> {
  const db = drizzle(d1);
  const totalRow = await db
    .select({ total: sql<number>`count(*)` })
    .from(repoWatchers)
    .innerJoin(users, eq(users.id, repoWatchers.userId))
    .where(eq(repoWatchers.repoId, repoId))
    .get();
  const items = await db
    .select({ user: users })
    .from(repoWatchers)
    .innerJoin(users, eq(users.id, repoWatchers.userId))
    .where(eq(repoWatchers.repoId, repoId))
    .orderBy(asc(users.id))
    .limit(options.pageSize)
    .offset((options.page - 1) * options.pageSize);
  return { items: items.map((row) => row.user), total: totalRow?.total ?? 0 };
}

/**
 * GetWatchedRepos (models/repo/user_repo.go) — the repositories one user
 * watches, newest-repo order not modeled: the same numeric-id ordering the
 * starred list uses (`CAST(id AS INTEGER)` — the text-id convention). The
 * visibility predicate mirrors services/stars.ts listStarredRepositories:
 * public rows plus rows owned by the REQUESTING doer; the admin arm drops
 * the filter entirely.
 */
export async function listWatchedRepositories(
  d1: D1Database,
  userId: number,
  options: { doerLoginLower: string; isAdmin: boolean } & SocialListOptions,
): Promise<{ items: RepositoryWithOwner[]; total: number }> {
  const db = drizzle(d1);
  const where = options.isAdmin
    ? eq(repoWatchers.userId, userId)
    : and(
        eq(repoWatchers.userId, userId),
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
