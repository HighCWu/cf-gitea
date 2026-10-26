/**
 * User badges storage (long-tail batch; the `badge` + `user_badge` tables of
 * migration 0027). Ports of the model functions the frozen API family needs —
 * gitea/models/user/badge.go GetUserBadges/AddUserBadges/RemoveUserBadges —
 * driven by api/routes/admin-badges.ts.
 *
 * The badge CATALOG's own CRUD (CreateBadge/UpdateBadge/DeleteBadge,
 * badge.go:88-135) has no /api/v1 surface (upstream serves it from the web
 * admin UI, routers/web/admin/badges.go; the frozen contract declares none),
 * so this module only READS the catalog and writes the edges. Slugs that do
 * not exist fail with upstream's exact error text (AddUserBadges'
 * util.NewNotExistErrorf) — the route renders it as the same 500
 * APIErrorInternal upstream would.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { badges, userBadges } from "../db/schema";

export type BadgeRow = typeof badges.$inferSelect;

/** `badge does not exist [slug: x]` — badge.go AddUserBadges' hydrate miss
 *  (util.NewNotExistErrorf; upstream 500s it via APIErrorInternal). */
export class BadgeNotExistError extends Error {
  constructor(slug: string) {
    super(`badge does not exist [slug: ${slug}]`);
    this.name = "BadgeNotExistError";
  }
}

/** `user badge already exists [user_id: %d, badge_id: %d]` — badge.go
 *  AddUserBadges' pre-insert Exist check (again a 500 upstream). */
export class UserBadgeAlreadyExistsError extends Error {
  constructor(userId: number, badgeId: number) {
    super(`user badge already exists [user_id: ${userId}, badge_id: ${badgeId}]`);
    this.name = "UserBadgeAlreadyExistsError";
  }
}

/**
 * GetUserBadges (badge.go:41-52): the INNER JOIN over user_badge → badge for
 * one user. Upstream orders by no explicit column (FindAndCount natural
 * order = insertion); user_badge.id is that order. The count rides the join.
 */
export async function getUserBadges(d1: D1Database, userId: number): Promise<BadgeRow[]> {
  return drizzle(d1)
    .select({
      id: badges.id,
      slug: badges.slug,
      description: badges.description,
      imageUrl: badges.imageUrl,
    })
    .from(badges)
    .innerJoin(userBadges, eq(userBadges.badgeId, badges.id))
    .where(eq(userBadges.userId, userId))
    .orderBy(asc(userBadges.id))
    .all();
}

/**
 * AddUserBadges (badge.go:106-155) reduced to the modeled surface: per slug
 * — hydrate the badge (miss → BadgeNotExistError), the pair pre-check (the
 * 500 "already exists"), insert. Sequential like upstream's loop; the
 * compound unique is the race backstop (a concurrent insert surfaces as the
 * same already-exists error via the UNIQUE violation).
 */
export async function addUserBadges(d1: D1Database, userId: number, slugs: string[]): Promise<void> {
  const db = drizzle(d1);
  for (const slug of slugs) {
    const badge = (await db.select().from(badges).where(eq(badges.slug, slug)).limit(1).all())[0];
    if (badge === undefined) {
      throw new BadgeNotExistError(slug);
    }
    const existing = (
      await db
        .select({ id: userBadges.id })
        .from(userBadges)
        .where(and(eq(userBadges.badgeId, badge.id), eq(userBadges.userId, userId)))
        .limit(1)
        .all()
    )[0];
    if (existing !== undefined) {
      throw new UserBadgeAlreadyExistsError(userId, badge.id);
    }
    try {
      await db.insert(userBadges).values({ badgeId: badge.id, userId });
    } catch (error) {
      // The existence-check/insert race: UNIQUE(user_id, badge_id) hit →
      // the same upstream error text (badge.go's re-check arm, :132-140).
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        throw new UserBadgeAlreadyExistsError(userId, badge.id);
      }
      throw error;
    }
  }
}

/**
 * RemoveUserBadges (badge.go:164-206): resolve the edges whose badge slug is
 * in the list, delete by id; nothing matches → nothing to do (upstream's
 * `len(userBadgeIDs) == 0 → nil`). Unknown slugs are silently absorbed.
 */
export async function removeUserBadges(d1: D1Database, userId: number, slugs: string[]): Promise<void> {
  if (slugs.length === 0) return;
  const db = drizzle(d1);
  const edges = await db
    .select({ id: userBadges.id })
    .from(userBadges)
    .innerJoin(badges, eq(badges.id, userBadges.badgeId))
    .where(and(eq(userBadges.userId, userId), inArray(badges.slug, slugs)))
    .all();
  const ids = edges.map((edge) => edge.id);
  if (ids.length === 0) return;
  await db.delete(userBadges).where(inArray(userBadges.id, ids));
}
