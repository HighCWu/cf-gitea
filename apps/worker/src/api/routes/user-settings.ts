import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { users } from "../../db/schema";
import { ApiError } from "../errors";
import type { ApiEnv } from "../env";
import { userSettingsOptionsSchema, userSettingsSchema } from "../models/user-settings";
import {
  loadUserSettings,
  saveUserProfileColumns,
  saveUserSettings,
  toApiUserSettings,
} from "../services/user-settings";

/**
 * Tier-1 user account settings (SPEC-0004 §2.4 row `GET/PATCH /user/settings`;
 * upstream routers/api/v1/user/settings.go GetUserSettings / UpdateUserSettings
 * over convert.User2UserSettings + user_service.UpdateOptions).
 *
 * Auth: upstream wires the group with `rejectPublicOnly()` inside the
 * reqToken'd /user group (api.go:1098–1101) — a signed-in caller is required
 * (anonymous → the runtime 401 `token is required` body, the /user
 * RUNTIME_ONLY class; not declared here: the vendored contract documents only
 * 200, and public-only tokens are a SPEC-0002 API-layer gate this
 * requireAuth-based route does not model yet).
 *
 * PATCH semantics mirror the Go POINTER body (`api.UserSettingsOptions`):
 * only the PRESENTED keys are applied, absent keys keep their stored value.
 * The nine fields split across the landed `users` profile columns and the
 * `user_settings` side store — services/user-settings.ts documents both
 * halves and the accepted-and-ignored Go binding limits (MaxSize/ValidUrl).
 */

const userSettingsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/settings",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Get user settings",
    operationId: "getUserSettings",
    responses: {
      200: {
        description: "UserSettings",
        content: { "application/json": { schema: userSettingsSchema } },
      },
    },
  });

const updateUserSettingsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/user/settings",
    middleware: [requireAuth],
    tags: ["user"],
    summary: "Update user settings",
    operationId: "updateUserSettings",
    request: {
      body: { content: { "application/json": { schema: userSettingsOptionsSchema } } },
    },
    responses: {
      200: {
        description: "UserSettings",
        content: { "application/json": { schema: userSettingsSchema } },
      },
    },
  });

export function registerUserSettingsRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  app.openapi(userSettingsRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    const row = await findSettingsRow(c.env.DB, doer.id);
    return c.json(toApiUserSettings(row, await loadUserSettings(c.env.DB, row.id)), 200);
  });

  app.openapi(updateUserSettingsRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    const row = await findSettingsRow(c.env.DB, doer.id);
    const form = c.req.valid("json");
    // Pointer semantics: a key PATCHES only when the body carried it
    // (undefined = keep the stored value).
    await saveUserProfileColumns(c.env.DB, row.id, {
      displayName: form.full_name,
      description: form.description,
      website: form.website,
      location: form.location,
    });
    await saveUserSettings(c.env.DB, row.id, {
      theme: form.theme,
      language: form.language,
      diffViewStyle: form.diff_view_style,
      hideEmail: form.hide_email,
      hideActivity: form.hide_activity,
    });
    // Upstream re-converts ctx.Doer AFTER user_service.UpdateUser mutated the
    // session user; the honest equivalent is re-reading both stores.
    const fresh = await findSettingsRow(c.env.DB, doer.id);
    return c.json(toApiUserSettings(fresh, await loadUserSettings(c.env.DB, row.id)), 200);
  });
}

/** The settings read/write needs the users row; a resolved token without a D1
 *  row is the silent-auth-failure convention (the api middlewares' class). */
async function findSettingsRow(d1: D1Database, doerId: number | undefined) {
  if (doerId === undefined) {
    throw new ApiError(401, "token is required");
  }
  const row = await drizzle(d1)
    .select({
      id: users.id,
      displayName: users.displayName,
      description: users.description,
      website: users.website,
      location: users.location,
    })
    .from(users)
    .where(eq(users.id, doerId))
    .limit(1)
    .then((rows) => rows[0]);
  if (row === undefined) {
    throw new ApiError(401, "token is required");
  }
  return row;
}
