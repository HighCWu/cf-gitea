/**
 * The owner HEATMAP web JSON route — `/{username}/-/heatmap` (pages wave;
 * upstream web.go:1107's `/{username}/-` group's `m.Get("/heatmap",
 * user.DashboardHeatmap)`, routers/web/user/heatmap.go:32-63): the JSON
 * endpoint the official bundle's profile widget fetches
 * (web_src/js/features/heatmap.ts `initHeatmap` → `#user-heatmap`'s
 * `data-heatmap-url` — the profile activity tab's contribution grid, this
 * wave's second piece renders the div that triggers it).
 *
 * ## The upstream handler, arm by arm (heatmap.go:32-63)
 *
 * - `EnableUserHeatmap` (heatmap.go:34-37, default ON,
 *   modules/setting/service.go) — not a landed setting; the route serves.
 * - The viewer-visibility gate (heatmap.go:38-44): `ctx.Org.Organization ==
 *   nil && !IsUserVisibleToViewer(ctx.ContextUser, ctx.Doer)` → NotFound.
 *   The landed `resolveUserProfile` seam IS that ladder (user-profile.tsx's
 *   `IsUserVisibleToViewer` port: admin/self short-circuit, public,
 *   limited-any-signed-in, private follower/shared-org) with the type gate
 *   upstream's group carries through `OrgAssignment` — an ORG name resolves
 *   through the org half upstream and serves
 *   `GetUserHeatmapDataByOrgTeam`'s org-scoped collation, which is census
 *   R06's prerequisite (the org-arm aggregation) and NOT this wave's brief:
 *   the user-gated resolver answers org names as a miss here, the recorded
 *   R06 boundary.
 * - `writeHeatmapJSON` (heatmap.go:22-30): `{"heatmapData":
 *   [[unixTs, count]...], "totalContributions": N}` — the PAIR shape, NOT
 *   the API's `[{timestamp, contributions}]` objects
 *   (routers/api/v1/user/user.go:138-161).
 * - The data: `GetUserHeatmapDataByUser` over the landed aggregation — the
 *   API route GET /users/{username}/heatmap (api/routes/user-read-t2.ts)
 *   carries the upstream-exact port (models/activities/user_heatmap.go:22-77:
 *   the 900-second buckets, the trailing (366+7)-day window, ascending).
 *   That read lives IN the route handler, and api/services/ is not this
 *   wave's file ownership — this module re-issues the exact two queries +
 *   bucket fold (the search.ts header's re-issue precedent), citing the
 *   route's documented DEVIATION verbatim: upstream aggregates the `action`
 *   table, which does not exist here — the contributions are the issues and
 *   comments the subject CREATED (`issues.poster_id` +
 *   `comments.poster_id`, created_unix timestamped rows only).
 *
 * ## Response shape
 *
 * `ctx.JSON`'s 200 application/json body, pair arrays ascending by bucket —
 * the exact contract ActivityHeatmap.vue consumes (heatmap.ts:19's
 * `resp.json() as HeatmapResponse`). No cache headers (upstream's JSON
 * answers carry none; the uiRouter middleware stamps the zero-option form
 * — the tree-wide posture).
 */

import { and, eq, gt, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { comments, issues } from "../../db/schema";
import type { UserProfileRow } from "./user-profile";

/** The aggregation window: `now - (366+7) days` in UNIX seconds
 *  (user_heatmap.go:66 — the API route's constant twin). */
const HEATMAP_WINDOW_SECONDS = (366 + 7) * 86_400;

/** The bucket width upstream groups by (user_heatmap.go:42-51) — 15-minute
 *  intervals so clients can shift buckets into any timezone offset. */
const HEATMAP_BUCKET_SECONDS = 900;

/** One web-shape pair: the bucket's unix-seconds start + the count. */
export type HeatmapPair = [number, number];

/** The loader's outcome: the pairs + the total, or null — the 404 family
 *  (the viewer-visibility gate's miss). */
export type OwnerHeatmapLoad = { pairs: HeatmapPair[]; total: number } | null;

/**
 * The web JSON read (heatmap.go's GetUserHeatmapDataByUser arm over the
 * landed aggregation — the API route's re-issued queries, module header):
 * the visibility gate is the CALLER's (resolveUserProfile already runs the
 * `IsUserVisibleToViewer` ladder — this loader trusts its `user` outcome).
 */
export async function loadOwnerHeatmapData(d1: D1Database, user: UserProfileRow): Promise<OwnerHeatmapLoad> {
  // Two bounded reads (the subject's issues and comments inside the window)
  // bucketed in the module — the API route's verbatim shape and citation.
  const cutoff = new Date((Math.floor(Date.now() / 1000) - HEATMAP_WINDOW_SECONDS) * 1000);
  const issueRows = await drizzle(d1)
    .select({ createdAt: issues.createdAt })
    .from(issues)
    .where(and(eq(issues.posterId, user.id), isNotNull(issues.createdAt), gt(issues.createdAt, cutoff)));
  const commentRows = await drizzle(d1)
    .select({ createdAt: comments.createdAt })
    .from(comments)
    .where(and(eq(comments.posterId, user.id), isNotNull(comments.createdAt), gt(comments.createdAt, cutoff)));

  const totals = new Map<number, number>();
  for (const row of [...issueRows, ...commentRows]) {
    // createdAt is NOT NULL per the filter; the timestamp mode hands the
    // driver value over as a Date.
    const seconds = (row.createdAt as Date).getTime() / 1000;
    const bucket = Math.floor(seconds / HEATMAP_BUCKET_SECONDS) * HEATMAP_BUCKET_SECONDS;
    totals.set(bucket, (totals.get(bucket) ?? 0) + 1);
  }
  let total = 0;
  const pairs: HeatmapPair[] = [...totals.entries()]
    .sort(([a], [b]) => a - b)
    .map(([timestamp, count]) => {
      total += count;
      return [timestamp, count] as HeatmapPair;
    });
  return { pairs, total };
}

/** The JSON body — writeHeatmapJSON (heatmap.go:22-30) verbatim. */
export function ownerHeatmapJsonBody(load: { pairs: HeatmapPair[]; total: number }): string {
  return JSON.stringify({ heatmapData: load.pairs, totalContributions: load.total });
}
