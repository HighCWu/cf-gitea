import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { comments, issues } from "../../db/schema";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { isFollowing } from "../services/follows";
import { findUserByName } from "../services/repository";

/**
 * Tier-2 `user`-tagged read-only leftovers — the two remaining operations of
 * the user tag computable from ALREADY-MIGRATED stores (no schema changes;
 * the queries live here because the batch's file ownership admits no new
 * service module — extraction can follow with the owning labels/teams waves).
 *
 *   - GET /users/{username}/heatmap (userGetHeatmapData): upstream
 *     routers/api/v1/user/user.go:138–161 over
 *     `activities_model.GetUserHeatmapDataByUser`
 *     (models/activities/user_heatmap.go:22–77) — anonymous-capable (no
 *     reqToken on the route, api.go:1061), gated by ActivityReadable
 *     (models/activities/action.go:440–442), 15-minute buckets
 *     (`created_unix / 900 * 900`, user_heatmap.go:43), the trailing
 *     (366+7)-day window (user_heatmap.go:66), ascending by bucket.
 *     DEVIATION (documented): upstream aggregates the `action` table — no
 *     such table exists here, so the contributions are computed from the
 *     issues and comments the subject CREATED (`issues.poster_id` +
 *     `comments.poster_id`, created_unix timestamped rows only). Issue and
 *     pull creations both count (upstream counts both creation actions).
 *     The ActivityReadable gate maps to the landed SPEC-0007 visibility
 *     model: `visibility='private'` plays KeepActivityPrivate — readable by
 *     the subject themself and site admins, an empty list for everyone else
 *     (the upstream shape: 200 with `[]`, never an error).
 *   - GET /user/following/{username} (userCurrentCheckFollowing): upstream
 *     routers/api/v1/user/follower.go:168–186 + checkUserFollowing
 *     (follower.go:158–164) — reqToken() (api.go /user group), IsFollowing →
 *     204, anything else (missing target included — userAssignment resolves
 *     the {username} first) → the declared notFound. Runtime-only 401
 *     (anonymous) is the /user RUNTIME_ONLY class — undeclared in the
 *     vendored swagger and NOT added to the orchestrator's
 *     RUNTIME_ONLY_RESPONSES table by this batch (routes/social-t2.ts
 *     convention).
 *
 * DROPPED from the user tag as table-dependent (no D1 tables exist):
 * /user/teams (teams), /user/stopwatches + /user/times (tracked times),
 * /users/{username}/activities/feeds (action feed), POST/DELETE /user/avatar
 * (no avatar blob store). The organization tag's read-only leftovers are all
 * implemented (routes/orgs.ts) or equally table-dependent.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/** UserHeatmapData (models/activities/user_heatmap.go:17–20) — the timestamp
 *  is a `TimeStamp` (UNIX SECONDS of the bucket start), not an RFC3339 string. */
const userHeatmapDataSchema = z
  .object({
    timestamp: z.number().int(),
    contributions: z.number().int(),
  })
  .openapi("UserHeatmapData");

const heatmapRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/users/{username}/heatmap",
    middleware: [optionalAuth],
    tags: ["user"],
    summary: "Get a user's heatmap",
    operationId: "userGetHeatmapData",
    request: {
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose heatmap is to be obtained" }),
      }),
    },
    responses: {
      200: {
        description: "UserHeatmapData",
        content: { "application/json": { schema: z.array(userHeatmapDataSchema) } },
      },
      404: notFoundResponse,
    },
  });

const checkFollowingRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/following/{username}",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Check whether a user is followed by the authenticated user",
    operationId: "userCurrentCheckFollowing",
    request: {
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user to check for authenticated followers" }),
      }),
    },
    responses: {
      204: { description: "empty" },
      404: notFoundResponse,
    },
  });

/** The heatmap aggregation window: `now - (366+7) days` in UNIX seconds
 *  (user_heatmap.go:66). */
const HEATMAP_WINDOW_SECONDS = (366 + 7) * 86_400;

/** The bucket width upstream groups by (user_heatmap.go:42–51) — 15-minute
 *  intervals so clients can shift buckets into any timezone offset. */
const HEATMAP_BUCKET_SECONDS = 900;

export function registerUserReadT2Routes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(heatmapRoute(optionalAuth), async (c) => {
    const { username } = c.req.valid("param");
    const subject = await findUserByName(c.env.DB, username);
    if (subject === null) {
      throw new ApiError(404, "not found");
    }
    // ActivityReadable (action.go:440–442) over the landed visibility model:
    // private subjects expose activity only to themself and site admins;
    // public/limited subjects to everyone (KeepActivityPrivate's default).
    const doer = c.get("authUser");
    const readable =
      subject.visibility !== "private" ||
      (doer !== undefined && (doer.is_admin === true || doer.id === subject.id));
    if (!readable) {
      return c.json([], 200);
    }

    // Two bounded reads (the subject's issues and comments inside the window)
    // bucketed in the handler — upstream groups in SQL over its action table;
    // the 15-minute semantics are identical and the row count is bounded by
    // the subject's own 373-day activity. (The verbatim
    // `created_unix / 900 * 900` group-by expression misrendered through the
    // drizzle sql template — grouped values came back unbucketed — so the
    // grouping runs where it is provably correct.)
    const cutoff = new Date((Math.floor(Date.now() / 1000) - HEATMAP_WINDOW_SECONDS) * 1000);
    const issueRows = await drizzle(c.env.DB)
      .select({ createdAt: issues.createdAt })
      .from(issues)
      .where(
        and(
          eq(issues.posterId, subject.id),
          isNotNull(issues.createdAt),
          gt(issues.createdAt, cutoff),
        ),
      );
    const commentRows = await drizzle(c.env.DB)
      .select({ createdAt: comments.createdAt })
      .from(comments)
      .where(
        and(
          eq(comments.posterId, subject.id),
          isNotNull(comments.createdAt),
          gt(comments.createdAt, cutoff),
        ),
      );

    const totals = new Map<number, number>();
    for (const row of [...issueRows, ...commentRows]) {
      // createdAt is NOT NULL per the filter; the timestamp mode hands the
      // driver value over as a Date.
      const seconds = (row.createdAt as Date).getTime() / 1000;
      const bucket = Math.floor(seconds / HEATMAP_BUCKET_SECONDS) * HEATMAP_BUCKET_SECONDS;
      totals.set(bucket, (totals.get(bucket) ?? 0) + 1);
    }
    const heatmap = [...totals.entries()]
      .sort(([a], [b]) => a - b)
      .map(([timestamp, contributions]) => ({ timestamp, contributions }));
    return c.json(heatmap, 200);
  });

  // GET /user/following/{username} — checkUserFollowing (follower.go:158–164):
  // IsFollowing(doer, target) → 204, everything else → the notFound body.
  // The reqToken id-less corner (a resolved identity without a D1 row) answers
  // the silent-auth-failure 401 (routes/follows.ts viewerSlice convention).
  app.openapi(checkFollowingRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const doer = c.get("authUser");
    if (doer === undefined || doer.id === undefined) {
      throw new ApiError(401, "token is required");
    }
    const target = await findUserByName(c.env.DB, username);
    if (target === null) {
      throw new ApiError(404, "not found");
    }
    if (await isFollowing(c.env.DB, doer.id, target.id)) {
      return c.body(null, 204);
    }
    throw new ApiError(404, "not found");
  });
}
