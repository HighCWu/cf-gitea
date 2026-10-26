import { z } from "zod";
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";
import { OrgService } from "../../services/orgs/orgs";
import { BadgeNotExistError, getUserBadges, UserBadgeAlreadyExistsError, addUserBadges, removeUserBadges } from "../../services/badges";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { findUserByName } from "../services/repository";

/**
 * The `/admin/users/{username}/badges` API family (long-tail batch; the 3
 * frozen operations over migration 0027's `badge` + `user_badge` tables):
 *
 *   GET    /admin/users/{username}/badges   (adminListUserBadges,  200/404)
 *   POST   /admin/users/{username}/badges   (adminAddUserBadges,   204/403)
 *   DELETE /admin/users/{username}/badges   (adminDeleteUserBadges,204/403/422)
 *
 * the handlers are routers/api/v1/admin/user_badge.go:14-100, the group
 * mounts inside the site-admin admin group (api.go:1835-1837 —
 * reqToken + reqSiteAdmin), so every op 403s non-admins with upstream's
 * exact "user should be the site admin" before the user lookup
 * (api.go:343-347; the local requireSiteAdmin mirror of admin-t2.ts).
 *
 * RUNTIME-ONLY codes the handlers can emit that the vendored contract omits
 * (not added to the orchestrator-owned RUNTIME_ONLY_RESPONSES table — the
 * tag-protections batch pattern):
 *   - 401 on every op (upstream reqToken);
 *   - 403 on the GET for a non-admin (reqSiteAdmin; the contract declares
 *     403 only on the writes);
 *   - 422 on the POST for a malformed body (Go bind; the contract declares
 *     422 only on the DELETE);
 *   - 500 on POST for an unknown badge slug — upstream's AddUserBadges
 *     surfaces user_model.NewNotExistErrorf via APIErrorInternal
 *     (user_badge.go:66-69), the exact text carries the slug.
 * Declared sets mirror the contract exactly: list {200,404}, add {204,403},
 * delete {204,403,422}.
 *
 * TARGET USER — context.UserAssignmentAPI (services/context/user.go:38-66)
 * like the whole /admin/users/{username} subgroup: case-folded lookup, then
 * the user_redirect consult — a hit 307s to the canonical name (the
 * admin-t2.ts port), a miss 404s `user redirect does not exist [name: x]`.
 * Type-blind: an org row is a valid ContextUser (orgs ARE users rows).
 *
 * The badge catalog has no /api/v1 CRUD (upstream web-UI only), so badge
 * rows are out-of-band; the API list/add/delete edges over existing slugs —
 * the add 500 (unknown slug) and the delete's silent absorb of unknown
 * slugs are both upstream-exact (badge.go:164-206 RemoveUserBadges no-ops
 * on unmatched slugs).
 */

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/** Body bind hook for the operations with a declared 422 (Go bind parity). */
const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/** The rendered Badge (structs/user.go:120-125 — no omitempty, every field
 *  renders). */
export const badgeSchema = z.object({
  id: z.number().int().openapi({ format: "int64", description: "unique identifier of the badge" }),
  slug: z.string().openapi({ description: "the slug of the badge" }),
  description: z.string().openapi({ description: "the description of the badge" }),
  image_url: z.string().openapi({ description: "the URL of the badge image" }),
});

/** UserBadgeOption (structs/user.go:136-139) — BadgeSlugs carries Go's
 *  binding:"Required" (nil fails bind; an EMPTY array passes). */
const userBadgeOptionSchema = z.object({
  badge_slugs: z.array(z.string()).openapi({ description: "list of badge slugs to add or remove" }),
});

const usernameParam = {
  username: z.string().min(1).openapi({ description: "username of the user" }),
} as const;

// ---------------------------------------------------------------------------
// Auth seams (admin-t2.ts's pair, family-local copies)
// ---------------------------------------------------------------------------

/** `reqSiteAdmin` (api.go:343-347) — the exact upstream 403 message. */
function requireSiteAdmin(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (c.get("authUser")?.is_admin !== true) {
      throw new ApiError(403, "user should be the site admin");
    }
    await next();
  };
}

/**
 * context.UserAssignmentAPI (user.go:38-66) — the admin-t2.ts port: type
 * blind case-folded lookup, then `user_redirects`; a redirect hit 307s to
 * the canonical path (RedirectToUser, context_response.go:28-56 — the
 * visibility gate always passes under reqToken+reqSiteAdmin), a miss 404s
 * the redirect-miss text.
 */
async function resolveContextUser(c: Context<ApiEnv>, username: string): Promise<typeof users.$inferSelect> {
  const row = await findUserByName(c.env.DB, username);
  if (row !== null) {
    return row;
  }
  const redirectUserId = await new OrgService(c.env.DB).lookupUserRedirect(username);
  if (redirectUserId !== null) {
    const target = (
      await drizzle(c.env.DB).select().from(users).where(eq(users.id, redirectUserId)).limit(1).all()
    )[0];
    if (target !== undefined && (target.visibility === "public" || c.get("authUser") !== undefined)) {
      const requestPath = new URL(c.req.url).pathname;
      const rawQuery = new URL(c.req.url).search;
      let location = requestPath.replace(username, target.username);
      if (rawQuery !== "") {
        location += rawQuery;
      }
      throw new HTTPException(307, {
        res: new Response(null, { status: 307, headers: { Location: location } }),
      });
    }
  }
  throw new ApiError(404, `user redirect does not exist [name: ${username}]`);
}

// ---------------------------------------------------------------------------
// The routes.
// ---------------------------------------------------------------------------

export function registerAdminBadgeRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // -------------------------------------------------------------------------
  // GET /admin/users/{username}/badges (adminListUserBadges)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/users/{username}/badges",
      middleware: [requireAuth, requireSiteAdmin()],
      tags: ["admin"],
      summary: "List a user's badges",
      operationId: "adminListUserBadges",
      request: { params: z.object(usernameParam) },
      responses: {
        200: {
          description: "BadgeList",
          content: { "application/json": { schema: z.array(badgeSchema) } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { username } = c.req.valid("param");
      const user = await resolveContextUser(c, username);
      // ListUserBadges (user_badge.go:19-40): the rows + SetTotalCountHeader.
      const rows = await getUserBadges(c.env.DB, user.id);
      c.header("X-Total-Count", String(rows.length));
      return c.json(
        rows.map((row) => ({
          id: row.id,
          slug: row.slug,
          description: row.description ?? "",
          image_url: row.imageUrl ?? "",
        })),
        200,
      );
    },
  );

  // -------------------------------------------------------------------------
  // POST /admin/users/{username}/badges (adminAddUserBadges) — 204.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/users/{username}/badges",
      middleware: [requireAuth, requireSiteAdmin()],
      tags: ["admin"],
      summary: "Add a badge to a user",
      operationId: "adminAddUserBadges",
      request: {
        params: z.object(usernameParam),
        body: { content: { "application/json": { schema: userBadgeOptionSchema } } },
      },
      responses: {
        204: { description: "empty" },
        403: forbiddenResponse,
      },
    }),
    async (c) => {
      const { username } = c.req.valid("param");
      const user = await resolveContextUser(c, username);
      const form = c.req.valid("json");
      // AddUserBadges (user_badge.go:43-62): per-slug hydrate + pair insert;
      // an unknown slug is upstream's APIErrorInternal 500 (the module note).
      try {
        await addUserBadges(c.env.DB, user.id, form.badge_slugs);
      } catch (error) {
        if (error instanceof BadgeNotExistError || error instanceof UserBadgeAlreadyExistsError) {
          throw new ApiError(500, error.message);
        }
        throw error;
      }
      return c.body(null, 204);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /admin/users/{username}/badges (adminDeleteUserBadges) — 204;
  // unknown slugs are silently absorbed (RemoveUserBadges no-op arm).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/admin/users/{username}/badges",
      middleware: [requireAuth, requireSiteAdmin()],
      tags: ["admin"],
      summary: "Remove a badge from a user",
      operationId: "adminDeleteUserBadges",
      request: {
        params: z.object(usernameParam),
        body: { content: { "application/json": { schema: userBadgeOptionSchema } } },
      },
      responses: {
        204: { description: "empty" },
        403: forbiddenResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const { username } = c.req.valid("param");
      const user = await resolveContextUser(c, username);
      const form = c.req.valid("json");
      await removeUserBadges(c.env.DB, user.id, form.badge_slugs);
      return c.body(null, 204);
    },
    bindValidationHook,
  );
}
