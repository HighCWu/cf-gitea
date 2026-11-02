import { and, asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { ReactionRow } from "./issue-extras";
import { reactions } from "../../db/schema";

/**
 * The RELEASE reaction seam (ledger R16(f) — upstream routers/web/web.go:1515's
 * `POST /releases/{id}/reactions/{action}` family; the data half is upstream
 * services/release/reaction.go (AllowedReleaseReactions / CreateReleaseReaction)
 * and models/issues/reaction.go's release arms (FindReleaseReactions :178-186,
 * CreateReaction's ReleaseID option :190-220, DeleteReleaseReaction :247-251)).
 *
 * The substrate is migration 0002's `reactions` table — `release_id` has been
 * a column of every reaction row since the landing (db/schema.ts, the
 * `reactions_target_uq` comment), so this file adds NO DDL — Drizzle-only
 * access per the architecture boundary, the issue-extras.ts posture. The
 * release arm binds `issue_id = 0, comment_id = 0` exactly like upstream's
 * CreateReaction leaves the unset options zero (ReactionOptions{ReleaseID}
 * only); the issue arm's readers bind `release_id = 0` symmetrically
 * (issue-extras.ts listTargetReactions), so the two arms never collide.
 *
 * The WEB-side handler (ui/pages/release-reaction-writes.ts) is this seam's
 * only caller at landing. Upstream's API has NO release-reactions twin — the
 * v1 API surface carries reactions for issues and comments only
 * (routers/api/v1/api.go:1585/:1641 — the issue + comment combos; there is no
 * `/repos/{owner}/{repo}/releases/{id}/reactions` anywhere in the OpenAPI
 * spec), so this row stays a web-route family by upstream's own shape.
 *
 * Documented divergences (the issue-extras.ts no-column convention):
 *   - the `LoadUsers` original-author halo (imports) is not modeled — the
 *     reacting user is always a local row (issue-extras.ts's note verbatim);
 *   - upstream filters reads by `type IN setting.UI.ReleaseReactions`
 *     (FindReleaseReactions' In clause) — mirrored: rows written before an
 *     allowed-set change would drop out of the render exactly upstream's.
 */

/** Upstream `setting.UI.ReleaseReactions` DEFAULT (modules/setting/ui.go:103
 *  — no settings module is landed, so the default set IS the instance set):
 *  the issue set MINUS `-1` and `confused`. Ordered — the picker renders this
 *  order (shared/reactions.tmpl's `{{range $value := $allowedReactions}}`). */
export const ALLOWED_RELEASE_REACTIONS: readonly string[] = ["+1", "laugh", "hooray", "heart", "rocket", "eyes"];

/** The lookup set (upstream UI.ReleaseReactionsLookup, ui.go:177). */
export const ALLOWED_RELEASE_REACTIONS_SET: ReadonlySet<string> = new Set(ALLOWED_RELEASE_REACTIONS);

/** The batched read's row: the issue-extras ReactionRow projection plus the
 *  release binding the caller groups by (upstream Find rows carry ReleaseID;
 *  the issue arm's projection omits it because its call sites bind the
 *  target before the read). */
export type ReleaseReactionRow = ReactionRow & { releaseId: number };

/**
 * FindReleaseReactions (models/issues/reaction.go:178-186) over the batched
 * release-id list: `release_id IN (...) AND type IN (ReleaseReactions)`,
 * oldest-first (`Asc(created_unix, id)`). An empty id list answers empty
 * (upstream's In with an empty slice never matches; drizzle's inArray refuses
 * one outright — the guard is the caller's page-load shape, getReleaseInfos'
 * releaseIDs of a zero-row page).
 */
export async function listReleaseReactions(d1: D1Database, releaseIds: number[]): Promise<ReleaseReactionRow[]> {
  if (releaseIds.length === 0) return [];
  return drizzle(d1)
    .select({
      id: reactions.id,
      userId: reactions.userId,
      type: reactions.type,
      createdAt: reactions.createdAt,
      releaseId: reactions.releaseId,
    })
    .from(reactions)
    .where(and(inArray(reactions.releaseId, releaseIds), inArray(reactions.type, ALLOWED_RELEASE_REACTIONS)))
    .orderBy(asc(reactions.createdAt), asc(reactions.id))
    .all();
}

export type ReleaseReactionChange = "created" | "exists";

/**
 * CreateReaction's release arm (models/issues/reaction.go:190-220 — the
 * allowed-set check rides the CALLER here, upstream CreateReleaseReaction's
 * CreateReaction(ctx, UI.ReleaseReactionsLookup, ...) pass): one guarded
 * insert, the `reactions_target_uq` unique tuple the idempotence arbiter, the
 * RETURNING probe answers created vs already-exist — the issue arm's
 * createIssueReaction shape (issue-extras.ts) with the release binding.
 * Upstream tolerates the duplicate (ErrReactionAlreadyExist — the handler
 * only refuses `util.ErrPermissionDenied`), so "exists" is success.
 */
export async function createReleaseReaction(
  d1: D1Database,
  params: { userId: number; releaseId: number; type: string },
  now: Date,
): Promise<ReleaseReactionChange> {
  const inserted = await drizzle(d1)
    .insert(reactions)
    .values({
      userId: params.userId,
      issueId: 0,
      commentId: 0,
      releaseId: params.releaseId,
      type: params.type,
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [reactions.userId, reactions.issueId, reactions.commentId, reactions.releaseId, reactions.type],
    })
    .returning({ id: reactions.id });
  return inserted.length > 0 ? "created" : "exists";
}

/**
 * DeleteReleaseReaction (models/issues/reaction.go:247-251) — `release_id +
 * user_id + type`, the silent delete (no rows is still success; upstream has
 * no original_author filter on the release arm, unlike the issue/comment
 * deletes — the release reactions were never migration-seeded).
 */
export async function deleteReleaseReaction(
  d1: D1Database,
  params: { userId: number; releaseId: number; type: string },
): Promise<void> {
  await drizzle(d1)
    .delete(reactions)
    .where(and(eq(reactions.releaseId, params.releaseId), eq(reactions.userId, params.userId), eq(reactions.type, params.type)));
}
