/**
 * The ActivityPub follower store (specs/federation.md §5 as-built — ledger
 * S-1, the ADR-0007 migration grant, table `federation_followers`, migration
 * 0063). The inbox's verified Follow upserts; its Undo removes. Idempotent by
 * the UNIQUE (user_id, follower_iri) pair: a re-Follow lands as a no-op on
 * the existing row (created_at keeps the FIRST verified Follow — the local
 * `follows` table's insert-only semantics, models/user/follow.go's port
 * family). No reads land here: the federation surface renders no follower
 * views (SPEC §1's don't-invent rule) — the rows are the remaining tier's
 * substrate (the delivery lane, SPEC OQ-5).
 *
 * Upstream alignment note (ADR-0007 §2, intentional-recorded-with-predecessor):
 * upstream never carried this table at any reachable point — the follow
 * architecture was never merged (services/federation/ has zero commits in the
 * pin's whole history) and PR #36789 `1592576fa5` reduced PersonInbox to the
 * 204 black hole. The predecessor shape this store completes is our own
 * landed SPEC (specs/federation.md), which recorded the no-store posture as
 * the fallback arm of a missing migration grant.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { federationFollowers } from "../../db/schema";

/**
 * Record (or re-record) a verified Follow: the remote actor `followerIri`
 * follows local user `userId`. The UNIQUE pair makes a re-Follow a no-op —
 * the Accept ladder answers 200 identically either way.
 */
export async function upsertFollower(d1: D1Database, userId: number, followerIri: string, now: Date): Promise<void> {
  await drizzle(d1)
    .insert(federationFollowers)
    .values({ userId, followerIri, createdAt: now })
    .onConflictDoNothing({ target: [federationFollowers.userId, federationFollowers.followerIri] });
}

/**
 * Drop the (userId, followerIri) row — the Undo/Follow removal arm. Returns
 * whether a row was removed (an Undo for a never-stored follower is a
 * no-op; the black-hole response is identical either way).
 */
export async function removeFollower(d1: D1Database, userId: number, followerIri: string): Promise<boolean> {
  const removed = await drizzle(d1)
    .delete(federationFollowers)
    .where(and(eq(federationFollowers.userId, userId), eq(federationFollowers.followerIri, followerIri)))
    .returning({ id: federationFollowers.id });
  return removed.length > 0;
}
