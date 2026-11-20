import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  orgMembers,
  packageVersions,
  packages,
  repositories,
  sessions,
  twoFactor,
  userRedirects,
  users,
} from "../../db/schema";
import { newSalt, newPasswordRecord } from "../../auth/password";
import { isComplexEnough, isPwned, PASSWORD_PWNED_ERROR_TEXT, type PwnedResult } from "../../auth/password-policy";
import { configuredPasswordHashAlgo, resolvePasswordPolicy } from "../config";
import { RepoNameCollisionError, RepoNameInvalidError, RepoObjectFormatUnsupportedError } from "../../repos/service";
import { AuditActions, auditClientIp, auditEventInsert, emitAudit } from "../../services/audit";
import { OrgNameCollisionError, OrgError } from "../../services/orgs/errors";
import { OrgService, usableUsernameError, type OrgRecord } from "../../services/orgs/orgs";
import { actorCredentialOf } from "../../services/oauth2/audit-arms";
import { enqueueRegisterNotifyMail } from "../../services/mail/register-notify";
import { deleteUserCascade, emitUserColumnAuditRows } from "../../services/user-accounts";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { createOrgOptionSchema, organizationSchema } from "../models/organization";
import { createRepoOptionSchema, repositorySchema } from "../models/repository";
import { userListSchema, userSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { toApiOrganization, toCreatedOrgRepository } from "../services/org-repos";
import { findUserByName, formBool, formBoolValue, formString, viewerOf } from "../services/repository";
import { createUserRepository, resolveAutoInitReadme } from "../services/user-repos";
import { toApiUser } from "../services/user";

/**
 * Tier-2 `admin`-tagged routes that run ENTIRELY over the EXISTING tables
 * (SPEC-0004 appendix A category f, the table-free subset — 8 of the 33
 * contract operations in the tag):
 *
 *   - `GET /admin/users`                    (adminSearchUsers, admin/user.go:374–502)
 *   - `POST /admin/users`                   (adminCreateUser, admin/user.go:57–152)
 *   - `PATCH /admin/users/{username}`       (adminEditUser, admin/user.go:155–251)
 *   - `DELETE /admin/users/{username}`      (adminDeleteUser, admin/user.go:254–301)
 *   - `GET /admin/orgs`                     (adminGetAllOrgs, admin/org.go:83–125)
 *   - `POST /admin/users/{username}/orgs`   (adminCreateOrg, admin/org.go:23–80)
 *   - `POST /admin/users/{username}/rename` (adminRenameUser, admin/user.go:505–545)
 *   - `POST /admin/users/{username}/repos`  (adminCreateRepo, admin/repo.go:14–41 —
 *                                             a thin delegation to repo.CreateUserRepo,
 *                                             exactly what POST /user/repos rides)
 *
 * The remaining 24 ops are TABLE-DEPENDENT and stay undeclared: cron
 * (`/admin/cron*` — no task model), emails (`/admin/emails*` — no
 * email_address store), system-wide webhooks (`/admin/hooks*` — webhooks is
 * repo-scoped), packages, user badges (no badge tables) and admin user keys
 * (no public_key tables). (Upstream REMOVED the `/admin/unadopted` surface in
 * this window — 1554b6c939 "feat!: remove repository adopt feature"; the
 * unadopted line above was already undeclared here, and the landed
 * admin-degenerate.ts routes are a handoff for the removing wave.)
 *
 * Upstream wiring (`routers/api/v1/api.go:1843–1892` at the 099abf5db4 pin):
 * the whole /admin group runs `tokenRequiresScopes(admin) → reqToken() →
 * reqSiteAdmin() → rejectPublicOnly()`, and the `/users/{username}` subgroup
 * adds `context.UserAssignmentAPI()`. Landed seams:
 *   - reqToken → the shared requireAuth middleware (401 `token is required`;
 *     runtime-only, the documented /user 401 class — the contract declares no
 *     401s in this tag);
 *   - reqSiteAdmin (api.go:364–368) → the requireSiteAdmin middleware below,
 *     403 `user should be the site admin`;
 *   - tokenRequiresScopes → mounted tree-wide (auth-parity H1):
 *     src/api/router.ts's apiScopeGate — the /admin row carries `admin`
 *     (api.go:1891's group gate); rejectPublicOnly → the src/index.ts
 *     arm at /api/v1/admin/*;
 *   - UserAssignmentAPI (services/context/user.go:36–41 at the pin) →
 *     resolveTargetRow below: type-blind name lookup, the user_redirect 307
 *     seam, else 404 with upstream's `user not found` body — the pin's
 *     errCb carries `util.NewNotExistErrorf("user not found")` and
 *     APIErrorAuto renders the wrapper message over ErrNotExist's 404 class
 *     (user.go:55–56; the pre-pin text `user redirect does not exist
 *     [name: …]` is history — 1d8474ee1f/b3422c0920's error-system port).
 *
 * Annotation drift at the pin (5671c5192d, wire-identical): upstream's
 * swagger comments folded the per-endpoint 400/403/404/409/422 entries into
 * a single `default: error` response per op; our route `responses` blocks
 * keep the explicit statuses (the same apiErrorSchema shape — a documented
 * superset, never served as generated JSON, the /api/swagger redirect only).
 *
 * ---------------------------------------------------------------------------
 * Documented deviations from upstream (PAT-only auth model + landed columns):
 * ---------------------------------------------------------------------------
 *   1. **External-auth fields accepted and ignored** — `source_id` and
 *      `login_name` (external-auth concepts) are accepted and ignored on
 *      both arms: every cf-gitea user is LOCAL (LoginType Plain), so
 *      upstream's parseAuthSource arm (admin/user.go:99) and its
 *      `LoginType == Plain` ladder gate (admin/user.go:96) always resolve
 *      to the local ladder. The PASSWORD fields left this deviation when
 *      the password store landed (SPEC-0002 §6, PWD-2/PWD-4): create
 *      enforces the length/complexity 400s (admin/user.go:96–114 — the
 *      pwned arm stays dormant, default-off config, pwn.go:37-39), edit
 *      re-hashes `password` (admin/user.go:191–214 → UpdateAuth), and
 *      `must_change_password` persists (see 7). `send_notify` left the
 *      deviation when the mailer landed (specs/email-outbound.md §2.5 — it
 *      fires the register-notify mail, upstream admin/user.go:147-150).
 *   2. **`purge` distinguished through the real cascade** (adminDeleteUser):
 *      upstream purge disables the account, deletes every owned repository
 *      through the repo-deletion service (services/user/user.go:172-182 →
 *      DeleteOwnerRepositoriesDirectly), removes org memberships and deletes
 *      last-owner orgs (user.go:184-219), then re-checks both counts inside
 *      the final transaction (user.go:234-248) whose errors the route maps
 *      422 (admin/user.go:287-296). cf-gitea rides the SAME shape: purge=true
 *      drives every owned repo through the engine-backed deleteRepository
 *      cascade (repos/service.ts — the exact path the demo-sweep consumer
 *      rides; D1 cascade + tombstone inline, R2-prefix purge/destroy
 *      enqueued to REPO_TASKS) and removes memberships (a last-owner org
 *      DELETED through OrgService, upstream's DeleteOrganization(org, true)
 *      shape) and sweeps every owned package through the
 *      deletePackageAndReferences cascade (upstream's RemoveAllPackages,
 *      user.go:249-253 → services/packages/packages.go:720-750); purge=false
 *      keeps the table-free guards — owned repos and org
 *      memberships still 422 exactly like upstream's non-purge path
 *      (user.go:238-251), packages ownership included (the third in-tx
 *      guard, user.go:250-255). The cascade + the census live in the service
 *      (`deleteUserCascade`, services/user-accounts.ts); the earlier
 *      accepted-and-undistinguished posture (noted 2026-10-28) predates the
 *      engine-backed cascade — a purge that silently dropped rows would have
 *      orphaned blobs, which the cascade's queue purge now prevents. The
 *      demo sweep stays the fail-safe backstop for hand-D1 user deletes.
 *   3. **`type` conversions**: upstream parses only User/Bot
 *      (services/convert/user.go:27–36 — "Organization" is a 400
 *      `invalid user type "Organization" (expected User, Bot)`, mirrored);
 *      a valid user↔Bot conversion CONVERTS for real since B-72 (the
 *      `users.type` 'bot' value landed): the patch rides the same UPDATE as
 *      the profile columns (upstream's one UpdateUserCols), the conversion
 *      checks run against the EFFECTIVE admin (opts.IsAdmin applies
 *      in-memory first — update.go:186-190), org targets 400
 *      `user type can not be converted` (ErrUserTypeCanNotConvert) and the
 *      change emits `user:type:update` (update.go:223; B-72's handoff 1 —
 *      the former deviation-3 blanket 400 is history). The route-level
 *      auth-material guard (admin/user.go:198-201) covers the
 *      conversion-to-bot path; UpdateAuth's service-level twin
 *      (update.go:241-243) covers an ALREADY-bot target — both 400 with
 *      `a bot account cannot have a password or authentication source`.
 *   4. **No external-login columns**: the `source_id`/`login_name` filters
 *      evaluate against the constant local-everything state (every user is
 *      local). `is_2fa_enabled` LEFT this deviation when the `two_factor`
 *      store landed (migration 0059) — the filter is the real EXISTS over it
 *      by uid, both polarities live (search.go:142–162's LEFT JOIN in twin).
 *      `is_restricted` LEFT it too once `users.is_restricted` landed (and the
 *      PATCH/CREATE arms write it): the filter is the exact-match boolean
 *      `is_restricted = <value>` (search.go:118–120), engaged only when the
 *      param is present and non-empty (admin/user.go:478–479).
 *   5. **No `updated` column**: the adminSearchUsers `updated` sort orders by
 *      `created_at` (upstream orders by `updated_unix`, user/search.go:21–36).
 *   6. **`active`/`prohibit_login` conflation**: upstream keeps two columns;
 *      the landed `users.status` enum ('active'|'prohibited') folds them —
 *      active=false or prohibit_login=true both land 'prohibited' (the same
 *      correlation convert.ToUser already renders, services/user.ts).
 *   7. **`must_change_password` stores but does not enforce (yet)** — the
 *      column landed (migration 0075, upstream user.go:113-115
 *      `NOT NULL DEFAULT false`): create defaults it TRUE (admin/user.go:
 *      89-95), edit sets/clears it (admin/user.go:195 → UpdateAuth
 *      update.go:283-285), and the change-password posts upstream pair with
 *      `optional.Some(false)` clears. The ENFORCEMENT surface — the web
 *      redirect to /user/settings/change_password (web.go:197-206), the
 *      /user/change_password flow (password.go:267+) and the API 403 arm
 *      (`verifyAuthWithOptionsAPI`, api.go:886-893, "You must change your
 *      password. Change it at: …") — is recorded as SPEC-0002 §6.3's open
 *      B-row: an admin-created user with the default flag can currently
 *      sign in without being routed through the change-password flow.
 *   8. **Render subset**: the response converter (`toApiUser`,
 *      services/user.ts) renders description/location/website as "" and
 *      visibility as the public TODO — the same render the landed
 *      GET /users/{username} surface already has. adminCreateUser and
 *      adminEditUser still PERSIST full_name (both landed columns — the
 *      directory render reads `display_name`, the org render `full_name` —
 *      two stand-ins for upstream's one FullName), email, description,
 *      website, location and visibility on the row; the columns surface when
 *      the converter's TODOs land.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

// ---------------------------------------------------------------------------
// Auth seams (the /admin group's reqToken + reqSiteAdmin pair)
// ---------------------------------------------------------------------------

/**
 * `reqSiteAdmin` (routers/api/v1/api.go:343–347): a resolved doer who is not
 * a site admin gets the exact upstream 403 message. Mounted AFTER requireAuth,
 * which has already set `authUser` (the middleware order mirrors the upstream
 * group: reqToken then reqSiteAdmin).
 */
function requireSiteAdmin(): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (c.get("authUser")?.is_admin !== true) {
      throw new ApiError(403, "user should be the site admin");
    }
    await next();
  };
}

/** D1 row of the `users` table — the UserAssignmentAPI result shape. */
type TargetRow = typeof users.$inferSelect;

/**
 * `context.UserAssignmentAPI` (services/context/user.go:36–41 at the pin)
 * for the admin `/users/{username}` subgroup: type-blind case-folded lookup
 * (an org row is a valid ContextUser — upstream GetUserByName has no type
 * filter); on a miss consult `user_redirects` (LookupUserRedirect) and answer
 * the 307 seam with the same path/query rewrite RedirectToUser performs
 * (services/context/context_response.go:28–56) — the visibility gate always
 * passes here because reqToken+reqSiteAdmin guarantee a signed-in admin;
 * otherwise the 404 body carries upstream's pin message `user not found` —
 * the errCb now throws `util.NewNotExistErrorf("user not found")` through
 * APIErrorAuto (user.go:55–56; the pre-pin text
 * `user redirect does not exist [name: …]` is history, the error-system
 * consolidation b3422c0920 + 1d8474ee1f).
 */
async function resolveTargetRow(c: Context<ApiEnv>, username: string): Promise<TargetRow> {
  const row = await findUserByName(c.env.DB, username);
  if (row !== null) {
    return row;
  }
  const redirectUserId = await new OrgService(c.env.DB).lookupUserRedirect(username);
  if (redirectUserId !== null) {
    const target = await findUserById(c.env.DB, redirectUserId);
    if (target !== null && (target.visibility === "public" || c.get("authUser") !== undefined)) {
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
  // util.NewNotExistErrorf("user not found") → APIErrorAuto: ErrNotExist's
  // 404 class, the wrapper's message as the body (user.go:55–56, :66–68).
  throw new ApiError(404, "user not found");
}

/** Missing member targets are the same 404-shaped miss (userAssignment). */
async function findUserById(d1: D1Database, id: number): Promise<TargetRow | null> {
  return (
    (await drizzle(d1).select().from(users).where(eq(users.id, id)).limit(1).then((rows) => rows[0])) ??
    null
  );
}

// ---------------------------------------------------------------------------
// adminSearchUsers — GET /admin/users
// ---------------------------------------------------------------------------

/**
 * Upstream `AdminUserOrderByMap` (models/user/search.go:21–36): sort keys
 * name|created|updated|id × order asc|desc. 'updated' maps to created_at —
 * deviation 5 (no updated_unix column).
 */
const ADMIN_USER_ORDER_COLUMNS = {
  name: users.usernameLower,
  created: users.createdAt,
  updated: users.createdAt,
  id: users.id,
} as const;

type AdminUserSortKey = keyof typeof ADMIN_USER_ORDER_COLUMNS;

/**
 * `utils.ResolveSortOrder` (routers/api/v1/utils/sort.go:18–41): sort absent →
 * the default (alphabetically); order absent → "asc"; an unknown ORDER 422s
 * before an unknown SORT (the map is keyed order-first).
 */
function resolveAdminUserSort(
  url: URL,
): { kind: "ok"; column: typeof users.usernameLower | typeof users.createdAt | typeof users.id; direction: "asc" | "desc" } | {
  kind: "error";
  error: ApiError;
} {
  const sortMode = formString(url.searchParams, "sort");
  if (sortMode === "") {
    return { kind: "ok", column: users.usernameLower, direction: "asc" };
  }
  const sortOrder = formString(url.searchParams, "order") || "asc";
  if (sortOrder !== "asc" && sortOrder !== "desc") {
    return {
      kind: "error",
      error: new ApiError(422, `Invalid sort order: ${JSON.stringify(sortOrder)}`),
    };
  }
  if (!(sortMode in ADMIN_USER_ORDER_COLUMNS)) {
    return {
      kind: "error",
      error: new ApiError(422, `Invalid sort mode: ${JSON.stringify(sortMode)}`),
    };
  }
  return { kind: "ok", column: ADMIN_USER_ORDER_COLUMNS[sortMode as AdminUserSortKey], direction: sortOrder };
}

/**
 * The adminSearchUsers filter row — upstream `SearchUsers`
 * (models/user/search.go:76–170) restricted to the landed `users` columns.
 * The type base is `user_model.AdminListedUserTypes` since 405ba258a8 (the
 * admin lists every account kind except organizations — admin/user.go:462,
 * `Types: AdminListedUserTypes`, models/user/user.go:72–73): our type enum
 * carries 'user' (Individual) and 'bot' (Bot); the Reserved/Remote members
 * have no D1 enum values, so the base is `type IN ('user','bot')` — the WEB
 * list page's exact predicate (admin-users.tsx loader). Deviations 1/4/5
 * above.
 */
async function searchAdminUsers(
  d1: D1Database,
  url: URL,
  options: { page: number; limit: number },
): Promise<{ items: TargetRow[]; total: number }> {
  const conditions: SQL[] = [inArray(users.type, ["user", "bot"])];

  const keyword = formString(url.searchParams, "q").trim().toLowerCase();
  if (keyword !== "") {
    // Upstream LIKEs lower_name, LOWER(full_name) and LOWER(email) for an
    // admin actor (no keep_email_private arm — search.go:87–99). Parameterized
    // instr() instead of LIKE: D1 caps LIKE patterns at 50 bytes and %/_ in
    // user input would need escaping (the services/user.ts convention).
    conditions.push(
      sql`(
        instr(${users.usernameLower}, ${keyword}) > 0
        or instr(lower(coalesce(${users.fullName}, '')), ${keyword}) > 0
        or instr(lower(coalesce(${users.email}, '')), ${keyword}) > 0
      )`,
    );
  }

  const visibility = formString(url.searchParams, "visibility");
  if (visibility !== "") {
    if (visibility !== "public" && visibility !== "limited" && visibility !== "private") {
      throw new ApiError(422, "invalid visibility");
    }
    conditions.push(eq(users.visibility, visibility));
  }

  const sourceId = formString(url.searchParams, "source_id");
  if (/^-?\d+$/.test(sourceId)) {
    // login_source column: every cf-gitea user is local (source 0) — a 0
    // filter matches everyone, anything else matches nothing (deviation 4).
    conditions.push(sql`0 = ${Number.parseInt(sourceId, 10)}`);
  }
  const loginName = formString(url.searchParams, "login_name").trim();
  if (loginName !== "") {
    // login_name column: none of our users carry an external identifier.
    conditions.push(sql`0 = 1`);
  }

  const isActiveRaw = url.searchParams.get("is_active");
  if (isActiveRaw !== null && isActiveRaw !== "") {
    conditions.push(eq(users.status, formBoolValue(isActiveRaw) ? "active" : "prohibited"));
  }
  const isProhibitRaw = url.searchParams.get("is_prohibit_login");
  if (isProhibitRaw !== null && isProhibitRaw !== "") {
    conditions.push(eq(users.status, formBoolValue(isProhibitRaw) ? "prohibited" : "active"));
  }
  const isAdminRaw = url.searchParams.get("is_admin");
  if (isAdminRaw !== null && isAdminRaw !== "") {
    conditions.push(eq(users.isAdmin, formBoolValue(isAdminRaw)));
  }
  // IsRestricted (search.go:118-120): the route arms the option only when the
  // param is present and non-empty (admin/user.go:500-501's
  // `ctx.FormString("is_restricted") != ""` gate), then the filter is the
  // EXACT-MATCH boolean `is_restricted = <value>` — both polarities live
  // against the landed users.is_restricted column (the deviation-4
  // false-everything posture is cured: the PATCH and CREATE arms write it).
  const isRestrictedRaw = url.searchParams.get("is_restricted");
  if (isRestrictedRaw !== null && isRestrictedRaw !== "") {
    conditions.push(eq(users.restricted, formBoolValue(isRestrictedRaw)));
  }
  const isTwoFaRaw = url.searchParams.get("is_2fa_enabled");
  if (isTwoFaRaw !== null && isTwoFaRaw !== "") {
    // Upstream LEFT OUTER JOINs two_factor and keeps `two_factor.uid IS NOT
    // NULL` / `IS NULL` (search.go:142-162, engaged only when the option was
    // provided — our presence gate). The EXISTS twin over our `two_factor`
    // store (migration 0059) is equivalent: the uid UNIQUE makes the join
    // 1:0..1, so a NULL join row ⇔ no enrollment row.
    const enrolled = formBoolValue(isTwoFaRaw);
    conditions.push(
      enrolled
        ? sql`EXISTS (SELECT 1 FROM ${twoFactor} WHERE ${twoFactor.userId} = ${users.id})`
        : sql`NOT EXISTS (SELECT 1 FROM ${twoFactor} WHERE ${twoFactor.userId} = ${users.id})`,
    );
  }

  const sort = resolveAdminUserSort(url);
  if (sort.kind === "error") {
    throw sort.error;
  }
  const order = sort.direction === "asc" ? asc(sort.column) : desc(sort.column);

  const db = drizzle(d1);
  const where = and(...conditions);
  const totalRows = await db.select({ value: sql<number>`count(*)` }).from(users).where(where);
  const items = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(order)
    .limit(options.limit)
    .offset((options.page - 1) * options.limit);
  return { items, total: Number(totalRows[0]?.value ?? 0) };
}

const adminSearchUsersRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/admin/users",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Search users according filter conditions",
    operationId: "adminSearchUsers",
    request: {
      query: z.object({
        source_id: z
          .string()
          .optional()
          .openapi({ type: "integer", format: "int64", description: "ID of the user's login source to search for, 0 means the local users" }),
        login_name: z
          .string()
          .optional()
          .openapi({ description: "identifier of the user, provided by the external authenticator" }),
        page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
        limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
        sort: z
          .string()
          .optional()
          .openapi({
            description:
              'sort users by attribute. Supported values are "name", "created", "updated" and "id". Default is "name"',
          }),
        order: z
          .string()
          .optional()
          .openapi({
            description:
              'sort order, either "asc" (ascending) or "desc" (descending). Default is "asc", ignored if "sort" is not specified.',
          }),
        q: z.string().optional().openapi({ description: "search term (username, full name, email)" }),
        visibility: z
          .string()
          .optional()
          .openapi({ description: 'visibility filter. Supported values are "public", "limited" and "private".' }),
        is_active: z.string().optional().openapi({ type: "boolean", description: "filter active users" }),
        is_admin: z.string().optional().openapi({ type: "boolean", description: "filter admin users" }),
        is_restricted: z.string().optional().openapi({ type: "boolean", description: "filter restricted users" }),
        is_2fa_enabled: z.string().optional().openapi({ type: "boolean", description: "filter 2FA enabled users" }),
        is_prohibit_login: z
          .string()
          .optional()
          .openapi({ type: "boolean", description: "filter login prohibited users" }),
      }),
    },
    responses: {
      200: { description: "UserList", content: { "application/json": { schema: userListSchema } } },
      403: forbiddenResponse,
      422: validationErrorResponse,
    },
  });

// ---------------------------------------------------------------------------
// adminCreateUser — POST /admin/users
// ---------------------------------------------------------------------------

/**
 * Mirror of the contract's `CreateUserOption` (required: username, email).
 * `password` and `must_change_password` are LIVE (SPEC-0002 §6): the ladder
 * enforces upstream's 400s (admin/user.go:96–114) and the flag stores with
 * the default-true semantics (admin/user.go:83–89). `restricted` is LIVE
 * (the B-89 follow-up): upstream threads it through
 * `overwriteDefault.IsRestricted` (admin/user.go:116–119,
 * `optional.FromPtr(form.Restricted)`) into createUser's overwrite loop
 * (user.go:760–761 `if overwrite.IsRestricted.Has()`) against the user.go:731
 * default `setting.Service.DefaultUserIsRestricted` (unset → false; no config
 * surface landed) — a present field lands ANY value, an absent field stays
 * false; the landed `users.is_restricted` column carries it and the response
 * render reflects it. NO template interplay (`Meta{}` carries no restricted)
 * and NO visibility interplay (Visibility has its own overwrite arm,
 * admin/user.go:121–123). Upstream's create emits ONLY the UserCreate audit
 * row (admin/user.go:143) — no restricted-family row exists at create (the
 * status trio lives in the UpdateUser tail, update.go:211–225, which create
 * never calls). `source_id` / `login_name` remain accepted-and-ignored —
 * deviation 1 (every user is local). `send_notify` LEFT deviation 1 when the
 * mailer landed
 * (specs/email-outbound.md §2.5): it fires the register-notify mail via
 * services/mail/register-notify.ts, upstream admin/user.go:147-150 parity.
 * Out-of-enum `visibility` dies in the request validator (runtime-only 400
 * where upstream binding 422s — the documented orgs.ts divergence class).
 */
const createUserOptionSchema = z.object({
  created_at: z.string().optional().openapi({
    format: "date-time",
    description:
      'For explicitly setting the user creation timestamp. Useful when users are\nmigrated from other systems. When omitted, the user\'s creation timestamp\nwill be set to "now".',
  }),
  email: z.string().openapi({ description: "email of the user to create" }),
  full_name: z.string().optional().openapi({ description: "The full display name of the user" }),
  login_name: z
    .string()
    .optional()
    .openapi({
      description: "identifier of the user, provided by the external authenticator (if configured)",
    }),
  must_change_password: z
    .boolean()
    .optional()
    .openapi({ description: "Whether the user must change password on first login" }),
  password: z.string().optional().openapi({ description: "The plain text password for the user" }),
  restricted: z.boolean().optional().openapi({ description: "Whether the user has restricted access privileges" }),
  send_notify: z.boolean().optional().openapi({ description: "Whether to send welcome notification email to the user" }),
  source_id: z.number().int().optional().openapi({
    format: "int64",
    description: "The authentication source ID to associate with the user",
  }),
  username: z.string().openapi({ description: "username of the user" }),
  visibility: z.enum(["public", "limited", "private"]).optional().openapi({
    description: "User visibility level: public, limited, or private",
  }),
});

type CreateUserOption = z.infer<typeof createUserOptionSchema>;

/**
 * Upstream `validation.IsEmailAddressValid` essentials (models/user/
 * email_address.go:120–138 — ValidateEmailForAdmin checks format only): one
 * '@', non-empty local and domain parts, no whitespace or control chars.
 */
function invalidEmailMessage(email: string): string | null {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/[\s@]/.test(email.split("@")[0] ?? "")) {
    return null;
  }
  return `email address is invalid: ${email}`;
}

/**
 * D1 row insert behind `user_model.createUser` (models/user/user.go:718–831).
 * `password` has already cleared the route's ladder (the 400s fire before
 * AdminCreateUser upstream), so the row always stores a hashed record here —
 * upstream's SetPassword arm (user.go:807–810: new salt, the CONFIGURED
 * algorithm) plus the Rands salt every create writes (user.go:804–805) and
 * the MustChangePassword default-true flag (admin/user.go:83–89).
 *
 * B-73: the `user:create` audit row rides the SAME batch — the §4.2
 * transactional form ("a failed write emits nothing"), the org-create twin's
 * shape (services/orgs/orgs.ts:459-474). Upstream emits
 * `audit.Record(ctx, audit_model.UserCreate, u)` immediately after
 * AdminCreateUser (admin/user.go:143): actor the ADMIN (ctx.Doer), scope the
 * created user, message the registry template. The new user's numeric id is
 * allocated by the insert of the same batch, so scope_id resolves through the
 * scalar subquery (cast to text — the schema's scope_id drift note: decimal
 * string for numeric entities) exactly like the org twin's mid-batch id;
 * actor_name snapshots upstream's DisplayName (models/user/user.go:494-500 —
 * FullName when set, else Name).
 */
async function insertCreatedUser(
  d1: D1Database,
  form: CreateUserOption,
  now: Date,
  audit: { actorId: number; actorName: string; actorCredential?: string | null; ipAddress?: string | null },
  configuredHashSpec: string,
): Promise<TargetRow> {
  const lower = form.username.toLowerCase();
  // SetPassword under the request env's CONFIGURED algorithm (census B-87's
  // consumption half — the route resolves
  // `configuredPasswordHashAlgo(c.env).specification`; user.go:807-810's
  // "current algo" IS setting.PasswordHashAlgo). An unexecutable configured
  // spec refuses through the controlled PasswordHashUnsupportedError before
  // any write.
  const record = await newPasswordRecord(form.password ?? "", configuredHashSpec);
  const db = drizzle(d1);
  try {
    const [inserted] = await db.batch([
      db
        .insert(users)
        .values({
          username: form.username,
          usernameLower: lower,
          email: form.email,
          // The user-directory render (toApiUser) reads display_name; the org
          // render reads full_name — two landed columns for upstream's one
          // FullName, so a user-typed create fills both.
          displayName: form.full_name ?? null,
          isAdmin: false,
          // IsRestricted at create (admin/user.go:116-119 → createUser:
          // user.go:731's `setting.Service.DefaultUserIsRestricted` default →
          // user.go:760-761's `if overwrite.IsRestricted.Has()`): the API
          // binds optional.FromPtr(form.Restricted), so a present field
          // writes ANY value and an absent field keeps the default — false,
          // the setting's unset value (no config surface landed). The
          // `?? false` fold is observationally identical to upstream's
          // overwrite-or-default while the default stays constant.
          // Sibling default SINCE 1f614953a2: createUser also sets
          // u.KeepActivityPrivate = ForceUserActivityVisibility=="private"
          // (user.go:725) — the knob's unset value makes it FALSE, this
          // insert's constant posture (no keep_activity_private column
          // landed); the knob surface is the update unit's pending port.
          restricted: form.restricted ?? false,
          status: "active",
          visibility: form.visibility ?? "public",
          fullName: form.full_name ?? null,
          type: "user",
          createdAt: form.created_at !== undefined ? new Date(form.created_at) : now,
          passwd: record.passwd,
          salt: record.salt,
          passwdHashAlgo: record.passwdHashAlgo,
          rands: newSalt(),
          mustChangePassword: form.must_change_password ?? true,
        })
        .returning(),
      // SPEC-0015 §4.2: the audit row commits (or rolls back) atomically with
      // the users row it describes.
      auditEventInsert(db, {
        action: AuditActions.UserCreate,
        actorId: audit.actorId,
        actorName: audit.actorName,
        actorCredential: audit.actorCredential ?? null,
        scopeType: "user",
        scopeId: sql`(select cast(id as text) from users where username_lower = ${lower})`,
        scopeName: form.username,
        origin: "api",
        ipAddress: audit.ipAddress ?? null,
        vars: { scope: form.username },
        timestamp: now,
      }),
    ]);
    return inserted[0]!;
  } catch (error) {
    // The UNIQUE(users.username_lower) race arbiter (upstream IsUserExist
    // pre-check inside the tx, user.go:783–790). Same OrgError convention as
    // the org service: the API layer maps the class.
    let text = error instanceof Error ? error.message : String(error);
    let cause: unknown = error;
    while (cause instanceof Error && cause.cause !== undefined) {
      cause = cause.cause;
      text += ` ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    if (text.includes("UNIQUE constraint failed")) {
      throw new UserAlreadyExistsError(form.username);
    }
    throw error;
  }
}

/**
 * 409 — upstream `ErrUserAlreadyExist` (models/user/error.go:23–31, unwraps
 * to util.ErrAlreadyExist → APIErrorAuto 409): "user already exists [name: %s]".
 */
class UserAlreadyExistsError extends ApiError {
  constructor(name: string) {
    super(409, `user already exists [name: ${name}]`);
    this.name = "UserAlreadyExistsError";
  }
}

/**
 * 409 — upstream `ErrEmailAlreadyUsed` (models/user/email_address.go:35–40,
 * unwraps to util.ErrAlreadyExist → 409): "e-mail already in use [email: %s]".
 */
class EmailAlreadyUsedError extends ApiError {
  constructor(email: string) {
    super(409, `e-mail already in use [email: ${email}]`);
    this.name = "EmailAlreadyUsedError";
  }
}

/**
 * 400 — upstream `ErrNameReserved`/`ErrNameCharsNotAllowed`/
 * `ErrNamePatternNotAllowed` unwrap to util.ErrInvalidArgument → APIErrorAuto
 * 400 in adminCreateUser (admin/user.go:134–136). The messages are the org
 * errors module's byte-exact ports; only the STATUS differs from the org
 * surface (explicit 422s there, auto-400 here).
 */
function mapCreateNameError(error: OrgError): ApiError {
  return new ApiError(400, error.message);
}

/** Duplicate-email probe — upstream IsEmailUsed over any user row. */
async function emailUsedByOther(d1: D1Database, email: string, selfId?: number): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .all();
  return rows.some((row) => row.id !== selfId);
}

const adminCreateUserRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/admin/users",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Create a user",
    operationId: "adminCreateUser",
    request: {
      body: { content: { "application/json": { schema: createUserOptionSchema } } },
    },
    responses: {
      201: { description: "User", content: { "application/json": { schema: userSchema } } },
      400: errorResponse,
      403: forbiddenResponse,
      409: errorResponse,
      422: validationErrorResponse,
    },
  });

// ---------------------------------------------------------------------------
// adminEditUser — PATCH /admin/users/{username}
// ---------------------------------------------------------------------------

/**
 * Mirror of the contract's `EditUserOption` (required: source_id — a binding
 * artifact; the field is accepted-and-ignored like the rest of the
 * external-auth set, deviation 1). `password` and `must_change_password` are
 * LIVE (SPEC-0002 §6): a non-empty password runs upstream's UpdateAuth
 * ladder (update.go:247–262) and the flag persists whenever present
 * (update.go:273–275) — an empty/absent password leaves the stored record
 * untouched (optional.FromNonDefault semantics). `active`, `admin`,
 * `description`, `email`, `full_name`, `location`, `prohibit_login`,
 * `restricted`, `visibility`, `website` map onto landed columns —
 * `restricted` writes `users.is_restricted` PRESENCE-gated exactly like
 * upstream (the API binds `IsRestricted: optional.FromPtr(form.Restricted)`,
 * admin/user.go:247 → `optional.FromPtr`: a present field writes ANY value,
 * an absent field never touches the column; update.go:137-141's
 * `if opts.IsRestricted.Has()` — no last-admin/actual-change guard, unlike
 * IsAdmin and Visibility). The still-columnless account-flag set
 * (`allow_create_organization`, `allow_git_hook`, `allow_import_local`,
 * `max_repo_creation`) is accepted and ignored.
 */
const editUserOptionSchema = z.object({
  active: z.boolean().optional().openapi({ description: "Whether the user account is active" }),
  admin: z.boolean().optional().openapi({ description: "Whether the user has administrator privileges" }),
  allow_create_organization: z
    .boolean()
    .optional()
    .openapi({ description: "Whether the user can create organizations" }),
  allow_git_hook: z.boolean().optional().openapi({ description: "Whether the user can use Git hooks" }),
  allow_import_local: z.boolean().optional().openapi({ description: "Whether the user can import local repositories" }),
  description: z.string().optional().openapi({ description: "The user's personal description or bio" }),
  email: z.string().optional().openapi({ format: "email", description: "The email address of the user" }),
  full_name: z.string().optional().openapi({ description: "The full display name of the user" }),
  location: z.string().optional().openapi({ description: "The user's location or address" }),
  login_name: z
    .string()
    .optional()
    .openapi({
      description: "identifier of the user, provided by the external authenticator (if configured)",
    }),
  max_repo_creation: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "Maximum number of repositories the user can create" }),
  must_change_password: z
    .boolean()
    .optional()
    .openapi({ description: "Whether the user must change password on next login" }),
  password: z.string().optional().openapi({ description: "The plain text password for the user" }),
  prohibit_login: z.boolean().optional().openapi({ description: "Whether the user is prohibited from logging in" }),
  restricted: z.boolean().optional().openapi({ description: "Whether the user has restricted access privileges" }),
  source_id: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "The authentication source ID to associate with the user" }),
  type: z.enum(["User", "Organization", "Bot"]).optional().openapi({ description: "The user type" }),
  visibility: z.enum(["public", "limited", "private"]).optional().openapi({
    description: "User visibility level: public, limited, or private",
  }),
  website: z.string().optional().openapi({ description: "The user's personal website URL" }),
});

/**
 * 400 — upstream `ErrDeleteLastAdminUser` (models/user/user.go:869–871):
 * "can not delete the last admin user [uid: %d]". The adminEditUser mapping
 * (admin/user.go:239–245) is an explicit 400; the delete mapping is a 422.
 */
class DeleteLastAdminUserError extends ApiError {
  constructor(uid: number) {
    super(400, `can not delete the last admin user [uid: ${uid}]`);
    this.name = "DeleteLastAdminUserError";
  }
}

/** `IsLastAdminUser` (models/user/user.go) — target is the only admin row. */
async function isLastAdminUser(d1: D1Database, target: TargetRow): Promise<boolean> {
  if (!target.isAdmin) {
    return false;
  }
  const others = await drizzle(d1)
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), sql`${users.id} != ${target.id}`))
    .limit(1);
  return others.length === 0;
}

const adminEditUserRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/admin/users/{username}",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Edit an existing user",
    operationId: "adminEditUser",
    request: {
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose data is to be edited" }),
      }),
      body: { content: { "application/json": { schema: editUserOptionSchema } } },
    },
    responses: {
      200: { description: "User", content: { "application/json": { schema: userSchema } } },
      400: errorResponse,
      403: forbiddenResponse,
      409: errorResponse,
      422: validationErrorResponse,
    },
  });

// ---------------------------------------------------------------------------
// adminDeleteUser — DELETE /admin/users/{username}
// ---------------------------------------------------------------------------

const adminDeleteUserRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/admin/users/{username}",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Delete a user",
    operationId: "adminDeleteUser",
    request: {
      params: z.object({
        username: z.string().min(1).openapi({ description: "username of the user to delete" }),
      }),
      query: z.object({
        purge: z.string().optional().openapi({ type: "boolean", description: "purge the user from the system completely" }),
      }),
    },
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

// ---------------------------------------------------------------------------
// adminGetAllOrgs — GET /admin/orgs
// ---------------------------------------------------------------------------

const adminListQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const adminGetAllOrgsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/admin/orgs",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "List all organizations",
    operationId: "adminGetAllOrgs",
    request: adminListQuery,
    responses: {
      200: {
        description: "OrganizationList",
        content: { "application/json": { schema: z.array(organizationSchema) } },
      },
      403: forbiddenResponse,
    },
  });

// ---------------------------------------------------------------------------
// adminCreateOrg — POST /admin/users/{username}/orgs
// ---------------------------------------------------------------------------

const adminCreateOrgRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/admin/users/{username}/orgs",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Create an organization",
    operationId: "adminCreateOrg",
    request: {
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user who will own the created organization" }),
      }),
      body: { content: { "application/json": { schema: createOrgOptionSchema } } },
    },
    responses: {
      201: { description: "Organization", content: { "application/json": { schema: organizationSchema } } },
      403: forbiddenResponse,
      422: validationErrorResponse,
    },
  });

// ---------------------------------------------------------------------------
// adminRenameUser — POST /admin/users/{username}/rename
// ---------------------------------------------------------------------------

/**
 * Mirror of the contract's `RenameUserOption` (required: new_username).
 */
const renameUserOptionSchema = z.object({
  new_username: z
    .string()
    .openapi({
      description: "New username for this user. This name cannot be in use yet by any other user.",
    }),
});

const adminRenameUserRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/admin/users/{username}/rename",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Rename a user",
    operationId: "adminRenameUser",
    request: {
      params: z.object({
        username: z.string().min(1).openapi({ description: "current username of the user" }),
      }),
      body: { content: { "application/json": { schema: renameUserOptionSchema } } },
    },
    responses: {
      204: { description: "empty" },
      403: forbiddenResponse,
      422: validationErrorResponse,
    },
  });

// ---------------------------------------------------------------------------
// adminCreateRepo — POST /admin/users/{username}/repos
// ---------------------------------------------------------------------------

const adminCreateRepoRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/admin/users/{username}/repos",
    middleware: [requireAuth, requireSiteAdmin()],
    tags: ["admin"],
    summary: "Create a repository on behalf of a user",
    operationId: "adminCreateRepo",
    request: {
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user who will own the created repository" }),
      }),
      body: { content: { "application/json": { schema: createRepoOptionSchema } } },
    },
    responses: {
      201: { description: "Repository", content: { "application/json": { schema: repositorySchema } } },
      400: errorResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      409: errorResponse,
      422: validationErrorResponse,
    },
  });

// ---------------------------------------------------------------------------
// Registration — handlers
// ---------------------------------------------------------------------------

export function registerAdminT2Routes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // GET /admin/users — SearchUsers over Individuals (type='user'), the
  // filter/offset census of search.go:76–170; the doer is a site admin, so
  // every rendered User carries the authed fields (convert.ToUser admin arm).
  app.openapi(adminSearchUsersRoute(requireAuth), async (c) => {
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await searchAdminUsers(c.env.DB, new URL(c.req.url), listOptions);
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json(items.map((row) => toApiUser(viewer, row)), 200);
  });

  // POST /admin/users — the createUser ladder (user.go:718–831): the
  // password 400s FIRST (admin/user.go:96-114 — upstream order: the ladder
  // runs before AdminCreateUser's user-model validation), then usable name
  // (400 arms via APIErrorAuto — deviation-free messages from the org errors
  // module), email format (400), namespace collision (409), email-in-use
  // (409), redirect consumption, insert with the hashed password record and
  // the default-true must_change_password flag (deviation 7: stored, not
  // enforced). `send_notify` fires the register-notify mailer
  // (specs/email-outbound.md §2.5, upstream admin/user.go:147-150) —
  // caught-and-logged, never load-bearing for the 201.
  app.openapi(adminCreateUserRoute(requireAuth), async (c) => {
    const form = c.req.valid("json");

    // The password ladder (admin/user.go:96–114), unconditioned because
    // every cf-gitea user is local (LoginType Plain — deviation 1). An
    // absent/empty password fails the min-length arm upstream too
    // (len("") < MinPasswordLength → `PasswordIsRequired`), so the field is
    // effectively REQUIRED on create. The complexity arm answers upstream's
    // bare code `PasswordComplexity`. The pwned arm (`PasswordPwned`,
    // admin/user.go:107-113) runs ONLY when the knob is armed (census
    // B-87: PASSWORD_CHECK_PWN, default off = upstream's default posture);
    // BOTH pwned failure shapes answer PasswordPwned, with the
    // request-failure logged (admin/user.go:109-111's log.Error).
    const policy = resolvePasswordPolicy(c.env);
    const password = form.password ?? "";
    if (password.length < policy.minLength) {
      throw new ApiError(400, "PasswordIsRequired");
    }
    if (!isComplexEnough(password, policy.complexityClasses)) {
      throw new ApiError(400, "PasswordComplexity");
    }
    if (policy.checkPwned) {
      const pwned = await isPwned(password);
      if (pwned.kind !== "clean") {
        if (pwned.kind === "request-failed") {
          console.error(`pwned-check: ${pwned.message}`);
        }
        throw new ApiError(400, "PasswordPwned");
      }
    }

    const nameError = usableUsernameError(form.username);
    if (nameError !== null) {
      throw mapCreateNameError(nameError);
    }
    const emailError = invalidEmailMessage(form.email);
    if (emailError !== null) {
      throw new ApiError(400, emailError);
    }
    if ((await findUserByName(c.env.DB, form.username)) !== null) {
      throw new UserAlreadyExistsError(form.username);
    }
    if (await emailUsedByOther(c.env.DB, form.email)) {
      throw new EmailAlreadyUsedError(form.email);
    }

    const lower = form.username.toLowerCase();
    // DeleteUserRedirect (user.go:817): creating on a live redirect consumes it.
    await drizzle(c.env.DB).delete(userRedirects).where(eq(userRedirects.lowerName, lower));
    // The audit emit rides the insert batch (B-73 — admin/user.go:149):
    // actor the ADMIN (ctx.Doer), name the DisplayName mapping.
    const doer = c.get("authUser");
    // The wire-model User's id/login/full_name are wire-OMITTABLE — the
    // authed admin row always carries them; guard the optionals for the type.
    if (doer?.id === undefined || doer.login === undefined) {
      throw new ApiError(401, "Unauthorized");
    }
    // The row's passwd_hash_algo = the env-resolved CONFIGURED spec (census
    // B-87's consumption half — upstream boots with the dealiased
    // security.go:175 value; Workers resolves per request).
    const row = await insertCreatedUser(
      c.env.DB,
      form,
      new Date(),
      {
        actorId: doer.id,
        actorName: (doer.full_name ?? "").trim() !== "" ? (doer.full_name as string) : doer.login,
        // The audit request context (census B-89's open 3 — the PATCH arm's
        // same derivation): the calling credential (event.go:123) + the
        // socket-peer address (common/audit.go:21's RemoteHost pick — NOT
        // X-Forwarded-For); a bare mount keeps the landed nulls.
        actorCredential: actorCredentialOf(c.get("auth")),
        ipAddress: auditClientIp(c.req.raw.headers),
      },
      configuredPasswordHashAlgo(c.env).specification,
    );
    // The register-notify mail arm (specs/email-outbound.md §2.5) — upstream
    // `if form.SendNotify { mailer.SendRegisterNotifyMail(u) }`
    // (routers/api/v1/admin/user.go:147-150; the web twin admin/users.go:261).
    // The previously accepted-and-ignored `send_notify` field fires the
    // mailer's first real surface. Fire-and-forget in EFFECT (upstream
    // SendAsync, services/mailer/mailer.go:66-80): the helper's await covers
    // only the cheap D1 insert, the queue send inside is best-effort, and
    // EVERY failure class is caught-and-logged — a mailer outage must never
    // fail the 201 (the services/issue-events.ts seam posture).
    if (form.send_notify === true) {
      try {
        await enqueueRegisterNotifyMail(c.env, row);
      } catch (error) {
        console.error(
          "[mail] register-notify enqueue failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return c.json(toApiUser(viewerOf(c), row), 201);
  });

  // PATCH /admin/users/{username} — the EditUser ladder (admin/user.go:155–251
  // over services/user/update.go): type arms first (the parse rejects
  // "Organization"; the convert check rejects admin→Bot), then the auth arm —
  // the optional password (empty/absent = unchanged, non-empty = upstream's
  // UpdateAuth ladder) plus the must_change_password write, committed BEFORE
  // the email replace (400 invalid / 409 in use) exactly like upstream's
  // separate UpdateAuth → ReplacePrimaryEmailAddress sequence, then the
  // column patches with the last-admin guard on `admin`.
  app.openapi(adminEditUserRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const target = await resolveTargetRow(c, username);
    const form = c.req.valid("json");

    // --- type parse arm (admin/user.go:181–189 → convert.UserTypeFromString):
    // the posted type only engages when it DIFFERS from the target's
    // current type string (upstream parses form.Type non-empty and !=
    // UserTypeToString(u.Type); identical/no posts leave userType None and
    // nothing below converts). "Organization" fails the parse with the
    // InvalidArgument text — APIErrorAuto answers it 400 (the wrapper's
    // message over errorForUser's code). users.type gained 'bot' (B-72), so
    // "Bot" now parses and CONVERTS below — the deviation-3 blanket 400 is
    // history.
    const password = form.password ?? "";
    const currentType = target.type === "org" ? "Organization" : target.type === "bot" ? "Bot" : "User";
    const parsedType = form.type !== undefined && form.type !== currentType ? form.type : null;
    if (parsedType === "Organization") {
      throw new ApiError(400, 'invalid user type "Organization" (expected User, Bot)');
    }
    // Upstream's route-level auth-material guard (admin/user.go:198-201):
    // fires ONLY when the NEW type is Bot — a user→Bot conversion carrying
    // password/auth-source material 400s before UpdateAuth runs, regardless
    // of admin status.
    if (parsedType === "Bot" && (password !== "" || (form.source_id ?? 0) !== 0 || (form.login_name ?? "") !== "")) {
      throw new ApiError(400, "a bot account cannot have a password or authentication source");
    }

    // --- the auth arm (admin/user.go:200–226 → UpdateAuth, update.go:
    // 231–267), applied and COMMITTED before the email/profile steps —
    // upstream runs UpdateAuth to completion (UpdateUserCols) before
    // ReplacePrimaryEmailAddress; no transaction spans them, so a later 409
    // never rolls the password write back here either.
    // UpdateAuth's service-level bot guard (update.go:241-243) — REACHABLE
    // since B-72 (the route-level guard above covers only the
    // conversion-to-bot path): an ALREADY-bot target refuses any
    // auth-material assignment even without a type change. Same 400 +
    // message upstream's APIErrorAuto yields for the InvalidArgumentErrorf
    // (the wrapper's message over ErrInvalidArgument's 400 code).
    if (target.type === "bot" && (password !== "" || (form.source_id ?? 0) !== 0 || (form.login_name ?? "") !== "")) {
      throw new ApiError(400, "a bot account cannot have a password or authentication source");
    }
    const authPatch: Partial<typeof users.$inferInsert> = {};
    if (password !== "") {
      // optional.FromNonDefault semantics (update.go:249): empty/absent =
      // unchanged. The ladder texts DIFFER from create's bare codes — the
      // route maps ErrMinLength to its own fmt string (admin/user.go:204-205)
      // and ErrComplexity to err.Error() (admin/user.go:206-207, "password
      // not complex enough"). The pwned arm (admin/user.go:208-209) maps
      // BOTH failure shapes to the raw err.Error() text at 400 — and runs
      // ONLY when the knob is armed (census B-87: PASSWORD_CHECK_PWN,
      // default off = upstream's default posture).
      const policy = resolvePasswordPolicy(c.env);
      if (password.length < policy.minLength) {
        throw new ApiError(400, `password must be at least ${policy.minLength} characters`);
      }
      if (!isComplexEnough(password, policy.complexityClasses)) {
        throw new ApiError(400, "password not complex enough");
      }
      if (policy.checkPwned) {
        const pwned: PwnedResult = await isPwned(password);
        if (pwned.kind === "pwned") {
          throw new ApiError(400, PASSWORD_PWNED_ERROR_TEXT);
        }
        if (pwned.kind === "request-failed") {
          throw new ApiError(400, pwned.message);
        }
      }
      // SetPassword (user.go:413–420): new salt + the CONFIGURED algorithm —
      // the env-resolved spec (census B-87's consumption half, the same
      // bridge the create arm takes). An unexecutable configured spec
      // refuses through the controlled PasswordHashUnsupportedError BEFORE
      // the UPDATE below (no partial write).
      const record = await newPasswordRecord(password, configuredPasswordHashAlgo(c.env).specification);
      authPatch.passwd = record.passwd;
      authPatch.salt = record.salt;
      authPatch.passwdHashAlgo = record.passwdHashAlgo;
    }
    if (form.must_change_password !== undefined) {
      // optional.FromPtr (update.go:283–284): present = write, absent =
      // untouched — an explicit false clears the create-defaulted flag.
      authPatch.mustChangePassword = form.must_change_password;
    }
    if (Object.keys(authPatch).length > 0) {
      await drizzle(c.env.DB).update(users).set(authPatch).where(eq(users.id, target.id));
      if (authPatch.passwd !== undefined) {
        // UpdateAuth's token invalidation (update.go:295–298 →
        // DeleteAuthTokensByUserID): our remember-session rows play the
        // auth_token role (the changeOwnPassword interpretation,
        // services/user-accounts.ts) — live non-remember sessions and PATs
        // are untouched.
        await drizzle(c.env.DB)
          .delete(sessions)
          .where(and(eq(sessions.userId, target.id), eq(sessions.remember, true)));
      }
    }

    // --- email replace arm (admin/user.go:216–221 → ReplacePrimaryEmailAddress,
    // services/user/email.go:21–33): org targets 400, same-address no-op,
    // invalid format 400, foreign duplicate 409.
    if (form.email !== undefined) {
      if (target.type === "org") {
        throw new ApiError(400, `user ${target.username} is an organization`);
      }
      if ((target.email ?? "").toLowerCase() !== form.email.toLowerCase()) {
        const emailError = invalidEmailMessage(form.email);
        if (emailError !== null) {
          throw new ApiError(400, emailError);
        }
        if (await emailUsedByOther(c.env.DB, form.email, target.id)) {
          throw new EmailAlreadyUsedError(form.email);
        }
      }
    }

    // --- last-admin guard (update.go:142–155): only the false-set checks.
    if (form.admin === false && (await isLastAdminUser(c.env.DB, target))) {
      throw new DeleteLastAdminUserError(target.id);
    }

    // --- the type conversion (update.go:186-190: `opts.UserType.Has() &&
    // value != u.Type` → CheckConvertUserType, update.go:187–189 + :312–318). Upstream
    // checks the IN-MEMORY IsAdmin — opts.IsAdmin applies FIRST (the
    // UpdateUser column loop runs before the UserType arm), so posting
    // {admin:false, type:"Bot"} on an admin target CONVERTS (the admin flag
    // flips false, then the check passes). effectiveAdmin is that fold.
    // Org targets fail ErrUserTypeCanNotConvert; ErrBotMustBeLocal is
    // vacuous (every row is local — the module header). B-72 handoff 1: the
    // REAL conversion lands — users.type gained 'bot', so user↔bot patches
    // the type column instead of the former deviation-3 blanket 400.
    let convertedType: "user" | "bot" | null = null;
    if (parsedType !== null) {
      const effectiveIsAdmin = form.admin !== undefined ? form.admin : target.isAdmin;
      if (effectiveIsAdmin) {
        // CheckConvertUserType's ErrBotCanNotBeAdmin — APIErrorAuto → 400.
        throw new ApiError(400, "bot user can not be a site administrator");
      }
      if (target.type === "org") {
        throw new ApiError(400, "user type can not be converted");
      }
      convertedType = parsedType === "Bot" ? "bot" : "user";
    }

    // --- the column patch (update.go:65–227 reduced to landed columns).
    const patch: Partial<typeof users.$inferInsert> = {};
    if (form.full_name !== undefined) {
      patch.fullName = form.full_name;
      patch.displayName = form.full_name; // the toApiUser render column
    }
    if (form.website !== undefined) patch.website = form.website;
    if (form.location !== undefined) patch.location = form.location;
    if (form.description !== undefined) patch.description = form.description;
    if (form.email !== undefined) patch.email = form.email;
    if (form.visibility !== undefined) patch.visibility = form.visibility;
    if (form.admin !== undefined) patch.isAdmin = form.admin;
    // IsRestricted (update.go:137-141): PRESENCE-gated only — the API binds
    // optional.FromPtr(form.Restricted) (admin/user.go:247), so a present
    // field writes ANY value and an absent field never touches the column.
    // The formerly accepted-and-ignored posture is cured here (B-89's OPEN
    // half 2): the write arms the helper's UserRestricted row below.
    if (form.restricted !== undefined) patch.restricted = form.restricted;
    // Deviation 6: the active/prohibit_login pair folds into one status
    // column — either "off" signal lands 'prohibited', an explicit-on lands
    // 'active', absence leaves the row untouched.
    const prohibited = form.prohibit_login === true || form.active === false;
    const activated = form.active === true || form.prohibit_login === false;
    if (prohibited) {
      patch.status = "prohibited";
    } else if (activated) {
      patch.status = "active";
    }
    if (convertedType !== null) patch.type = convertedType;
    if (Object.keys(patch).length > 0) {
      await drizzle(c.env.DB).update(users).set(patch).where(eq(users.id, target.id));
      // UpdateUser's audit tail (B-89, services/user/update.go:211-225 —
      // the shared service block upstream runs after EVERY UpdateUser
      // commit, :200's UpdateUserCols): one row per ACTUALLY-changed
      // audited column against the pre-UPDATE target snapshot (:68), in
      // upstream's fixed order active → admin → restricted → visibility;
      // the pin's tail adds OrganizationTeamAccess (:226, no users-side
      // write surface landed) and the type emit below stays LAST (:223).
      // `after` is the write's own intent (upstream compares the
      // mutated in-memory struct, :68 vs :211-225 — not a re-read). The
      // status fold's driver rule: only an `active` post emits
      // user:status:active — upstream's prohibit_login write rides
      // UpdateAuth, whose tail records `user:prohibitlogin:update` SINCE
      // 3f1b738f09 (:305-307; the pre-pin silence is a PENDING DELTA — the
      // row is the update unit's UpdateAuth-tail port, HANDOFF). The
      // restricted arm is LIVE: `restricted` writes the column above
      // (update.go:137-141's presence gate), so a flip emits
      // user:status:restricted (:216-218). Failure posture = upstream writeEvent
      // (audit/event.go:129-133): a failed audit INSERT logs and never
      // errorizes the successful write.
      const doer = c.get("authUser");
      // The wire-model User's id/username are wire-OMITTABLE — the authed
      // admin row always carries them (the create arm's guard posture).
      if (doer?.id === undefined) {
        throw new ApiError(401, "Unauthorized");
      }
      // The audit request context (census B-89's open 3 — upstream's
      // SetRequestInfo + GetDoerCredential threading): the calling
      // credential off the auth snapshot (event.go:123's
      // GetDoerCredential(doer), derived per request exactly like upstream's
      // middleware-published request info) and the client address off the
      // edge's socket-peer header (common/audit.go:21's RemoteHost pick —
      // NOT X-Forwarded-For). A bare mount (tests/embedding without
      // resolveAuth) keeps the landed nulls.
      const auditCredential = actorCredentialOf(c.get("auth"));
      const auditIp = auditClientIp(c.req.raw.headers);
      await emitUserColumnAuditRows(
        c.env.DB,
        target,
        { ...target, ...patch },
        {
          actorId: doer.id,
          actorName: doer.username ?? doer.login ?? "",
          origin: "api",
          activePosted: form.active,
          actorCredential: auditCredential,
          ipAddress: auditIp,
        },
      ).catch((error: unknown) => {
        console.log(`[audit] user update-family rows failed (scope=${target.id}): ${String(error)}`);
      });
      if (convertedType !== null) {
        // UpdateUser's type-change audit (update.go:223:
        // `audit.Record(ctx, audit_model.UserType, u, "user_type",
        // u.Type.DisplayName())`) — the shared service tail, so the API arm
        // emits exactly like the web arm. DisplayName's English render
        // ("Bot"/"User") is the var (the UI translates concept_user_*).
        await emitAudit(drizzle(c.env.DB), {
          action: AuditActions.UserType,
          actorId: doer.id,
          actorName: doer.username ?? doer.login ?? "",
          actorCredential: auditCredential,
          scopeType: "user",
          scopeId: target.id,
          scopeName: target.username,
          origin: "api",
          ipAddress: auditIp,
          vars: { scope: target.username, user_type: convertedType === "bot" ? "Bot" : "User" },
        }).catch((error: unknown) => {
          console.log(`[audit] user:type:update row failed (scope=${target.id}): ${String(error)}`);
        });
      }
    }

    const updated = await findUserById(c.env.DB, target.id);
    if (updated === null) {
      throw new Error(`user disappeared during edit: ${target.id}`);
    }
    return c.json(toApiUser(viewerOf(c), updated), 200);
  });

  // DELETE /admin/users/{username} — the DeleteUser ladder
  // (admin/user.go:292-316): the org/self guards, the last-admin guard
  // (services/user/user.go:147-149), then — WITHOUT purge — the repo/
  // membership/packages count guards upstream checks inside its final
  // transaction (user.go:234-255, the route's 422 mapping at
  // admin/user.go:291-299). The cascade itself (purge's owned-repo +
  // membership + packages arms, the branch-protection scrub, the census
  // batch and the row delete) is the deleteUserCascade service
  // (services/user-accounts.ts) — the port of upstream's
  // DeleteUser/deleteUser pair. Deviation 2: purge is now distinguished
  // through the real repo cascade.
  app.openapi(adminDeleteUserRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const target = await resolveTargetRow(c, username);
    const doer = c.get("authUser");
    const purge = formBool(new URL(c.req.url).searchParams, "purge");

    if (target.type === "org") {
      throw new ApiError(422, "target is an organization but not user");
    }
    if (target.id === doer.id) {
      throw new ApiError(422, "you cannot delete yourself");
    }
    if (target.status === "active" && (await isLastAdminUser(c.env.DB, target))) {
      throw new ApiError(422, `can not delete the last admin user [uid: ${target.id}]`);
    }

    if (!purge) {
      // Upstream's in-tx count guards (user.go:234-248) hold ONLY on the
      // non-purge path — with purge the cascade removes the repos and the
      // memberships before the row delete, exactly like upstream running
      // DeleteOwnerRepositoriesDirectly + the RemoveOrgUser loop first.
      const db = drizzle(c.env.DB);
      const repoCount = await db
        .select({ total: sql<number>`count(*)` })
        .from(repositories)
        .where(eq(repositories.ownerId, target.id))
        .get();
      if ((repoCount?.total ?? 0) > 0) {
        throw new ApiError(422, `user still has ownership of repositories [uid: ${target.id}]`);
      }
      const membershipCount = await db
        .select({ total: sql<number>`count(*)` })
        .from(orgMembers)
        .where(eq(orgMembers.userId, target.id))
        .get();
      if ((membershipCount?.total ?? 0) > 0) {
        throw new ApiError(422, `user still has membership of organizations [uid: ${target.id}]`);
      }
      // The third in-tx guard (user.go:250-255): `HasOwnerPackages` (an
      // INNER JOIN over package_versions with is_internal=false —
      // models/packages/package.go:342-351) → `ErrUserOwnPackages` ("user
      // still has ownership of packages [uid: N]", package.go:344-346),
      // mapped 422 beside the repos/orgs pair (admin/user.go:287-296). The
      // purge path clears the packages first (the cascade's sweep), matching
      // upstream running RemoveAllPackages before this transaction.
      const packageCount = await db
        .select({ total: sql<number>`count(*)` })
        .from(packageVersions)
        .innerJoin(packages, eq(packages.id, packageVersions.packageId))
        .where(and(eq(packages.ownerId, target.id), eq(packageVersions.isInternal, false)))
        .get();
      if ((packageCount?.total ?? 0) > 0) {
        throw new ApiError(422, `user still has ownership of packages [uid: ${target.id}]`);
      }
    }

    await deleteUserCascade(c.env, target.id, { purge });
    return c.body(null, 204);
  });

  // GET /admin/orgs — SearchUsers over Organizations with the FULL visibility
  // ladder (admin/org.go:106–118: Visible=[public,limited,private]) — the
  // listVisibleOrgs admin arm. Email renders verbatim (convert.ToOrganization).
  app.openapi(adminGetAllOrgsRoute(requireAuth), async (c) => {
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listAllOrgs(c.env.DB, listOptions);
    setPaginationHeaders(c, total, listOptions);
    const origin = new URL(c.req.url).origin;
    return c.json(items.map((org) => toApiOrganization(org, { origin, includeEmail: true })), 200);
  });

  // POST /admin/users/{username}/orgs — CreateOrganization with the TARGET as
  // the owner row (admin/org.go:54–65: ctx.ContextUser, not the admin). The
  // name errors 422 with err.Error() (org.go:66–70) — the shared-namespace
  // collision included (upstream IsErrUserAlreadyExist in the same arm).
  app.openapi(adminCreateOrgRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const target = await resolveTargetRow(c, username);
    const form = c.req.valid("json");
    let org: OrgRecord;
    try {
      org = await new OrgService(c.env.DB).createOrg({
        name: form.username,
        ownerId: target.id,
        visibility: form.visibility ?? "public",
        fullName: form.full_name ?? null,
        description: form.description ?? null,
        website: form.website ?? null,
        location: form.location ?? null,
        email: form.email ?? null,
        repoAdminChangeTeamAccess: form.repo_admin_change_team_access,
      });
    } catch (error) {
      if (error instanceof OrgNameCollisionError) {
        throw new ApiError(422, error.message);
      }
      if (error instanceof OrgError) {
        throw new ApiError(error.status, error.message);
      }
      throw error;
    }
    const origin = new URL(c.req.url).origin;
    return c.json(toApiOrganization(org, { origin, includeEmail: true }), 201);
  });

  // POST /admin/users/{username}/rename — the RenameUser port
  // (admin/user.go:552–568 over services/user/user.go:36–116): org targets
  // 422 first, the no-op/case-only branches, the shared-namespace collision,
  // then the batch (rename + redirect write rule + the owner_namespace
  // rewrite our git gate resolves against). Name errors 422 err.Error().
  app.openapi(adminRenameUserRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const target = await resolveTargetRow(c, username);
    const form = c.req.valid("json");

    if (target.type === "org") {
      throw new ApiError(422, "target is an organization but not user");
    }
    await renameUserRow(c.env.DB, target, form.new_username);
    return c.body(null, 204);
  });

  // POST /admin/users/{username}/repos — upstream is a one-line delegation to
  // repo.CreateUserRepo (admin/repo.go:46–48), the same service POST
  // /user/repos rides: the readme-template 400 first, then the create with
  // the TARGET row as owner, mapped 409/422 like user-repos.ts; an unknown
  // gitignores/license template name 500s with the row rolled back
  // (create.go:236-241,448-456 — the user-repos route note and the
  // RUNTIME_ONLY table entry carry the cites).
  app.openapi(adminCreateRepoRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const target = await resolveTargetRow(c, username);
    const form = c.req.valid("json");
    // 400 arm first (upstream CreateUserRepo validates the readme template
    // before touching the database).
    resolveAutoInitReadme(form);
    let repo;
    try {
      repo = await createUserRepository(c.env.DB, c.env, target, form, new Date());
    } catch (error) {
      if (error instanceof RepoNameCollisionError) {
        throw new ApiError(409, "The repository with the same name already exists.");
      }
      if (error instanceof RepoNameInvalidError) {
        throw new ApiError(422, error.message);
      }
      if (error instanceof RepoObjectFormatUnsupportedError) {
        // The engine is sha1-only (SPEC-0001 §5): a sha256 create is refused
        // with upstream's exact Error() text (create.go:225) under the
        // contract-declared 422 (see user-repos.ts's mapping note).
        throw new ApiError(422, error.message);
      }
      throw error;
    }
    const viewer = viewerOf(c);
    return c.json(toCreatedOrgRepository(viewer, { repo, owner: target }), 201);
  });
}

// ---------------------------------------------------------------------------
// Local helpers (route-thin glue)
// ---------------------------------------------------------------------------

/**
 * The GET /admin/orgs listing — upstream SearchUsers with Types=[org] and the
 * full public+limited+private ladder, alphabetically (admin/org.go:106–118).
 * The admin doer widens listVisibleOrgs to exactly that set.
 */
async function listAllOrgs(
  d1: D1Database,
  options: { page: number; limit: number },
): Promise<{ items: OrgRecord[]; total: number }> {
  const db = drizzle(d1);
  const where = eq(users.type, "org");
  const totalRow = await db.select({ total: sql<number>`count(*)` }).from(users).where(where).get();
  const items = await db
    .select({
      id: users.id,
      username: users.username,
      usernameLower: users.usernameLower,
      email: users.email,
      fullName: users.fullName,
      description: users.description,
      website: users.website,
      location: users.location,
      avatarEmail: users.avatarEmail,
      useCustomAvatar: users.useCustomAvatar,
      visibility: users.visibility,
      numMembers: users.numMembers,
      repoAdminChangeTeamAccess: users.repoAdminChangeTeamAccess,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(where)
    .orderBy(asc(users.usernameLower))
    .limit(options.limit)
    .offset((options.page - 1) * options.limit);
  return { items, total: Number(totalRow?.total ?? 0) };
}

/**
 * The type='user' half of upstream `RenameUser` (services/user/user.go:36–116)
 * — the OrgService.renameOrg port mirrored onto plain users: exact-match
 * no-op, name validation, case-only display flip (no redirect row), then ONE
 * batch = rename + NewUserRedirect write rule (delete at old name, delete at
 * new name, insert old→id) + the `repositories.owner_namespace` rewrite
 * (UpdateRepositoryOwnerName — the git gate's lookup key).
 *
 * Name errors carry upstream's messages with the handler's explicit 422
 * (admin/user.go:560–565): reserved/pattern/chars from the org errors module,
 * the shared-namespace collision as ErrUserAlreadyExist.
 */
async function renameUserRow(d1: D1Database, target: TargetRow, newName: string): Promise<void> {
  if (newName === target.username) {
    return; // upstream: newUserName == u.Name → nil (exact compare)
  }
  const nameError = usableUsernameError(newName);
  if (nameError !== null) {
    throw new ApiError(422, nameError.message);
  }
  const newLower = newName.toLowerCase();

  const db = drizzle(d1);
  if (newLower === target.usernameLower) {
    // Case-only: display case flips, no redirect row (user.go:48–59).
    await db.update(users).set({ username: newName }).where(eq(users.id, target.id));
    return;
  }

  // Shared-namespace pre-check (IsUserExist excluding self, user.go:88–96).
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, newLower)).get();
  if (existing !== undefined && existing.id !== target.id) {
    throw new ApiError(422, `user already exists [name: ${newName}]`);
  }

  const now = new Date();
  try {
    await db.batch([
      db
        .update(users)
        .set({ username: newName, usernameLower: newLower })
        .where(and(eq(users.id, target.id), eq(users.type, "user"))),
      db.delete(userRedirects).where(eq(userRedirects.lowerName, target.usernameLower)),
      db.delete(userRedirects).where(eq(userRedirects.lowerName, newLower)),
      db.insert(userRedirects).values({ lowerName: target.usernameLower, redirectUserId: target.id }),
      db
        .update(repositories)
        .set({ ownerNamespace: newLower, updatedAt: now })
        .where(eq(repositories.ownerId, target.id)),
    ]);
  } catch (error) {
    let text = error instanceof Error ? error.message : String(error);
    let cause: unknown = error;
    while (cause instanceof Error && cause.cause !== undefined) {
      cause = cause.cause;
      text += ` ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    if (text.includes("UNIQUE constraint failed")) {
      throw new ApiError(422, `user already exists [name: ${newName}]`);
    }
    throw error;
  }
}
