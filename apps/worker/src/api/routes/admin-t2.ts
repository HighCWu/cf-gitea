import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import {
  issueSubscriptions,
  orgMembers,
  reactions,
  repoCollaborators,
  repoWatchers,
  repositories,
  userRedirects,
  users,
} from "../../db/schema";
import { RepoNameCollisionError, RepoNameInvalidError } from "../../repos/service";
import { OrgNameCollisionError, OrgError } from "../../services/orgs/errors";
import { OrgService, usableUsernameError, type OrgRecord } from "../../services/orgs/orgs";
import { scrubUserFromAllRules } from "../../services/branch-protection";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { createOrgOptionSchema, organizationSchema } from "../models/organization";
import { createRepoOptionSchema, repositorySchema } from "../models/repository";
import { userListSchema, userSchema } from "../models/user";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { toApiOrganization, toCreatedOrgRepository } from "../services/org-repos";
import { findUserByName, formBoolValue, formString, viewerOf } from "../services/repository";
import { createUserRepository, resolveAutoInitReadme } from "../services/user-repos";
import { toApiUser } from "../services/user";

/**
 * Tier-2 `admin`-tagged routes that run ENTIRELY over the EXISTING tables
 * (SPEC-0004 appendix A category f, the table-free subset — 8 of the 33
 * contract operations in the tag):
 *
 *   - `GET /admin/users`                    (adminSearchUsers, admin/user.go:394–524)
 *   - `POST /admin/users`                   (adminCreateUser, admin/user.go:57–158)
 *   - `PATCH /admin/users/{username}`       (adminEditUser, admin/user.go:161–263)
 *   - `DELETE /admin/users/{username}`      (adminDeleteUser, admin/user.go:266–317)
 *   - `GET /admin/orgs`                     (adminGetAllOrgs, admin/org.go:85–127)
 *   - `POST /admin/users/{username}/orgs`   (adminCreateOrg, admin/org.go:23–82)
 *   - `POST /admin/users/{username}/rename` (adminRenameUser, admin/user.go:527–569)
 *   - `POST /admin/users/{username}/repos`  (adminCreateRepo, admin/repo.go:14–49 —
 *                                             a thin delegation to repo.CreateUserRepo,
 *                                             exactly what POST /user/repos rides)
 *
 * The remaining 25 ops are TABLE-DEPENDENT and stay undeclared: the Actions
 * runner/run families (`/admin/actions/*` — no runner tables), cron
 * (`/admin/cron*` — no task model), emails (`/admin/emails*` — no
 * email_address store), system-wide webhooks (`/admin/hooks*` — webhooks is
 * repo-scoped), packages, unadopted repositories (no adoption model), user
 * badges (no badge tables) and admin user keys (no public_key tables).
 *
 * Upstream wiring (`routers/api/v1/api.go:1824–1877`): the whole /admin group
 * runs `tokenRequiresScopes(admin) → reqToken() → reqSiteAdmin() →
 * rejectPublicOnly()`, and the `/users/{username}` subgroup adds
 * `context.UserAssignmentAPI()`. Landed seams:
 *   - reqToken → the shared requireAuth middleware (401 `token is required`;
 *     runtime-only, the documented /user 401 class — the contract declares no
 *     401s in this tag);
 *   - reqSiteAdmin (api.go:343–347) → the requireSiteAdmin middleware below,
 *     403 `user should be the site admin`;
 *   - tokenRequiresScopes / rejectPublicOnly → standing deferral like every
 *     landed module (SPEC-0002 scope gates pending);
 *   - UserAssignmentAPI (api.go:31–66) → resolveTargetRow below: type-blind
 *     name lookup, the user_redirect 307 seam, else 404 with upstream's
 *     `user redirect does not exist [name: …]` body (the redirect-miss error
 *     is what upstream's errCb carries, api.go:48–52).
 *
 * ---------------------------------------------------------------------------
 * Documented deviations from upstream (PAT-only auth model + landed columns):
 * ---------------------------------------------------------------------------
 *   1. **No password store (SPEC-0002 §4.6.7)** — upstream adminCreateUser
 *      takes a plain-text `password` and enforces length/complexity/pwned
 *      400s (admin/user.go:102–120), and adminEditUser re-hashes `password`
 *      (admin/user.go:203–226). cf-gitea users authenticate exclusively with
 *      personal access tokens: both fields are ACCEPTED AND IGNORED, the
 *      password-arms (400 `PasswordIsRequired`/`PasswordComplexity`/
 *      `PasswordPwned`, `must_change_password`) are unreachable, and the
 *      response is still the contract's `User` shape. `send_notify`,
 *      `source_id` and `login_name` (external-auth/mail concepts) are equally
 *      accepted and ignored.
 *   2. **`purge` accepted, not distinguished** (adminDeleteUser): upstream
 *      purge disables the account, deletes owned repositories through the
 *      storage layer and removes last-owner orgs (services/user/user.go:151–
 *      219). cf-gitea's repo deletion is engine-backed (R2/DO), so a purge
 *      that silently dropped rows would orphan blobs; instead BOTH modes run
 *      the same table-free guards — owned repos and org memberships still
 *      422 exactly like upstream's non-purge path (user.go:238–251).
 *   3. **`type` conversions**: upstream parses only User/Bot
 *      (services/convert/user.go:27–36 — "Organization" is a 400
 *      `invalid user type "Organization" (expected User, Bot)`, mirrored);
 *      converting a local non-admin user to Bot succeeds upstream but has no
 *      storage variant in `users.type` (enum 'user'|'org') — that arm answers
 *      upstream's CheckConvertUserType 400 `user type can not be converted`
 *      (services/user/update.go:299–307) as the closest declared error.
 *   4. **No restricted / 2FA / external-login columns**: `restricted` and
 *      `is_2fa_enabled` filters evaluate against the constant
 *      false-everything state (true filters match nothing);
 *      `source_id`/`login_name` filters likewise (every user is local).
 *   5. **No `updated` column**: the adminSearchUsers `updated` sort orders by
 *      `created_at` (upstream orders by `updated_unix`, user/search.go:21–36).
 *   6. **`active`/`prohibit_login` conflation**: upstream keeps two columns;
 *      the landed `users.status` enum ('active'|'prohibited') folds them —
 *      active=false or prohibit_login=true both land 'prohibited' (the same
 *      correlation convert.ToUser already renders, services/user.ts).
 *   7. Upstream-created users carry MustChangePassword=true — a concept we do
 *      not store; the created row is plain active.
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
 * `context.UserAssignmentAPI` (api.go:31–66) for the admin
 * `/users/{username}` subgroup: type-blind case-folded lookup (an org row is
 * a valid ContextUser — upstream GetUserByName has no type filter); on a miss
 * consult `user_redirects` (LookupUserRedirect) and answer the 307 seam with
 * the same path/query rewrite RedirectToUser performs
 * (services/context/context_response.go:28–56) — the visibility gate always
 * passes here because reqToken+reqSiteAdmin guarantee a signed-in admin;
 * otherwise the 404 body carries upstream's redirect-miss message
 * (api.go:48–52: `errCb(404, ErrUserRedirectNotExist.Error())`).
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
  throw new ApiError(404, `user redirect does not exist [name: ${username}]`);
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
 * (models/user/search.go:76–170) restricted to the landed `users` columns
 * (Types=[UserTypeIndividual] → type='user'; deviations 1/4/5 above).
 */
async function searchAdminUsers(
  d1: D1Database,
  url: URL,
  options: { page: number; limit: number },
): Promise<{ items: TargetRow[]; total: number }> {
  const conditions: SQL[] = [eq(users.type, "user")];

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
  // restricted / 2FA: constant false-everything state (deviation 4).
  const isRestrictedRaw = url.searchParams.get("is_restricted");
  if (isRestrictedRaw !== null && isRestrictedRaw !== "" && formBoolValue(isRestrictedRaw)) {
    conditions.push(sql`0 = 1`);
  }
  const isTwoFaRaw = url.searchParams.get("is_2fa_enabled");
  if (isTwoFaRaw !== null && isTwoFaRaw !== "" && formBoolValue(isTwoFaRaw)) {
    conditions.push(sql`0 = 1`);
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
 * `password` / `must_change_password` / `send_notify` / `source_id` /
 * `login_name` are carried per contract and IGNORED — deviation 1 (PAT-only
 * auth; no password or mail store). Out-of-enum `visibility` dies in the
 * request validator (runtime-only 400 where upstream binding 422s — the
 * documented orgs.ts divergence class).
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

/** D1 row insert behind `user_model.createUser` (models/user/user.go:700–812). */
async function insertCreatedUser(d1: D1Database, form: CreateUserOption, now: Date): Promise<TargetRow> {
  const lower = form.username.toLowerCase();
  const db = drizzle(d1);
  try {
    const inserted = await db
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
        status: "active",
        visibility: form.visibility ?? "public",
        fullName: form.full_name ?? null,
        type: "user",
        createdAt: form.created_at !== undefined ? new Date(form.created_at) : now,
      })
      .returning();
    return inserted[0]!;
  } catch (error) {
    // The UNIQUE(users.username_lower) race arbiter (upstream IsUserExist
    // pre-check inside the tx, user.go:776–783). Same OrgError convention as
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
 * 400 in adminCreateUser (admin/user.go:140–142). The messages are the org
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
 * external-auth set, deviation 1). `active`, `admin`, `description`, `email`,
 * `full_name`, `location`, `prohibit_login`, `visibility`, `website` map onto
 * landed columns; the account-flag set without columns
 * (`allow_create_organization`, `allow_git_hook`, `allow_import_local`,
 * `max_repo_creation`, `restricted`) is accepted and ignored.
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
 * 400 — upstream `ErrDeleteLastAdminUser` (models/user/user.go:853–855):
 * "can not delete the last admin user [uid: %d]". The adminEditUser mapping
 * (admin/user.go:251–257) is an explicit 400; the delete mapping is a 422.
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

  // POST /admin/users — the createUser ladder (user.go:700–812): usable name
  // (400 arms via APIErrorAuto — deviation-free messages from the org errors
  // module), email format (400), namespace collision (409), email-in-use
  // (409), redirect consumption, insert. Deviation 1: the password/
  // must_change_password/send_notify/source_id/login_name fields die here as
  // accepted-and-ignored — no 400 password arms exist to hit.
  app.openapi(adminCreateUserRoute(requireAuth), async (c) => {
    const form = c.req.valid("json");

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
    // DeleteUserRedirect (user.go:798): creating on a live redirect consumes it.
    await drizzle(c.env.DB).delete(userRedirects).where(eq(userRedirects.lowerName, lower));
    const row = await insertCreatedUser(c.env.DB, form, new Date());
    return c.json(toApiUser(viewerOf(c), row), 201);
  });

  // PATCH /admin/users/{username} — the EditUser ladder (admin/user.go:161–263
  // over services/user/update.go): type arms first (the parse rejects
  // "Organization"; the convert check rejects admin→Bot), then the email
  // replace (400 invalid / 409 in use), then the column patches with the
  // last-admin guard on `admin`. Password/auth-source fields ride the
  // accepted-and-ignored deviation 1.
  app.openapi(adminEditUserRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const target = await resolveTargetRow(c, username);
    const form = c.req.valid("json");

    // --- type conversion arm (user.go:193–201 → convert.UserTypeFromString)
    const currentType = target.type === "org" ? "Organization" : "User";
    if (form.type !== undefined && form.type !== currentType) {
      if (form.type === "Organization") {
        throw new ApiError(400, 'invalid user type "Organization" (expected User, Bot)');
      }
      // form.type === "Bot"
      if (target.isAdmin) {
        throw new ApiError(400, "bot user can not be a site administrator");
      }
      // Deviation 3: no bot storage variant — upstream would convert; ours
      // answers CheckConvertUserType's message instead.
      throw new ApiError(400, "user type can not be converted");
    }

    // --- email replace arm (user.go:228–233 → ReplacePrimaryEmailAddress,
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

    // --- last-admin guard (update.go:145–157): only the false-set checks.
    if (form.admin === false && (await isLastAdminUser(c.env.DB, target))) {
      throw new DeleteLastAdminUserError(target.id);
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
    if (Object.keys(patch).length > 0) {
      await drizzle(c.env.DB).update(users).set(patch).where(eq(users.id, target.id));
    }

    const updated = await findUserById(c.env.DB, target.id);
    if (updated === null) {
      throw new Error(`user disappeared during edit: ${target.id}`);
    }
    return c.json(toApiUser(viewerOf(c), updated), 200);
  });

  // DELETE /admin/users/{username} — the DeleteUser ladder
  // (admin/user.go:292–316): the org/self guards, the last-admin guard
  // (services/user/user.go:147–149), the repo/membership guards
  // (user.go:238–251), then the row delete (the users FK cascades carry
  // tokens/memberships/redirects/follows/stars/settings; the FK-less
  // watcher/collaborator/reaction/subscription rows go in the same batch —
  // the deleteUser DeleteBeans census, services/user/delete.go:74–103).
  // Deviation 2: `purge` is parsed but not distinguished.
  app.openapi(adminDeleteUserRoute(requireAuth), async (c) => {
    const { username } = c.req.valid("param");
    const target = await resolveTargetRow(c, username);
    const doer = c.get("authUser");

    if (target.type === "org") {
      throw new ApiError(422, "target is an organization but not user");
    }
    if (target.id === doer.id) {
      throw new ApiError(422, "you cannot delete yourself");
    }
    if (target.status === "active" && (await isLastAdminUser(c.env.DB, target))) {
      throw new ApiError(422, `can not delete the last admin user [uid: ${target.id}]`);
    }

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

    // Branch-protection whitelist scrub (SPEC-0013 M4) — upstream DeleteUser's
    // "***** START: Branch Protections *****" block (services/user/delete.go:
    // 134-155): the deleted id is stripped from every allowlist column of every
    // rule (ids are JSON-serialized, so the sweep pages all rules). Pre-batch
    // like upstream's in-tx ordering: a failed scrub aborts the delete.
    await scrubUserFromAllRules(c.env.DB, target.id);

    // The delete sweep: FK-cascade tables ride the users row; the FK-less
    // user-associable stores are cleared by id (delete.go:74–103 census).
    await db.batch([
      db.delete(repoWatchers).where(eq(repoWatchers.userId, target.id)),
      db.delete(repoCollaborators).where(eq(repoCollaborators.userId, target.id)),
      db.delete(reactions).where(eq(reactions.userId, target.id)),
      db.delete(issueSubscriptions).where(eq(issueSubscriptions.userId, target.id)),
      db.delete(users).where(eq(users.id, target.id)),
    ]);
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
  // the owner row (admin/org.go:56–67: ctx.ContextUser, not the admin). The
  // name errors 422 with err.Error() (org.go:68–72) — the shared-namespace
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
  // the TARGET row as owner, mapped 409/422 like user-repos.ts.
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
