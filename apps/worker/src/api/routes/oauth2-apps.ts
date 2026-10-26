import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { orgDoerOf } from "../services/org-repos";
import {
  createOAuth2Application,
  deleteOAuth2Application,
  detectInvalidOAuth2ApplicationRedirectURI,
  getOAuth2ApplicationById,
  listOAuth2Applications,
  toApiOAuth2Application,
  updateOAuth2Application,
} from "../services/oauth2-apps";

/**
 * The OAuth2 application CRUD family (the long-tail inventory batch
 * `wave-api-oauth2-apps` — 5 frozen operations over migration 0026's
 * `oauth2_application` table, storage in services/oauth2-apps.ts):
 *
 *   - GET  /user/applications/oauth2       (userGetOauth2Application)
 *   - POST /user/applications/oauth2       (userCreateOAuth2Application)
 *   - GET  /user/applications/oauth2/{id}  (userGetOAuth2Application)
 *   - PATCH /user/applications/oauth2/{id} (userUpdateOAuth2Application)
 *   - DELETE /user/applications/oauth2/{id} (userDeleteOAuth2Application)
 *
 * All five sit in the /user group's `reqToken()` arm
 * (routers/api/v1/user/app.go via routers/api/v1/api.go:1093-grouping): the
 * doer IS the owner — requireAuth only, no further gate. Upstream handlers:
 * ListOauth2Applications / CreateOauth2Application / GetOauth2Application /
 * UpdateOauth2Application / DeleteOauth2Application (user/app.go).
 *
 * SECRET HANDLING — upstream's exact flow: the secret is generated
 * crypto-random behind the "gto_" prefix, stored HASHED (bcrypt there,
 * PBKDF2-SHA256 here — services/oauth2-apps.ts module header), and the
 * plaintext is rendered EXACTLY ONCE, in the create 201 body and in every
 * patch 200 body (PATCH always rotates the secret — app.go
 * UpdateOauth2Application). List blanks it ("Hide secret on application
 * list", app.go ListOauth2Applications) and get blanks it (app.go
 * GetOauth2Application); a foreign user's app is an indistinguishable 404 on
 * get (app.UID check) and on delete (the (id, uid) delete's 0-rows arm).
 *
 * SCOPE BOUNDARY — CRUD ONLY. The authorize/token flow that consumes these
 * registrations is web-UI territory: no token issuance, no grants, no
 * authorization codes. The contract defines no `scopes` field on this
 * family's shapes in this pin (scopes live on OAuth2Grant, oauth2.go:510),
 * so there is no application-level scope validation; the confidential-client
 * flag and the redirect-URI validation (forms.DetectInvalidOAuth2Application
 * RedirectURI) are ported exactly — see services/oauth2-apps.ts.
 *
 * DECLARED SETS mirror the vendored contract exactly, per operation: list
 * declares {200}; create declares {201,400}; get declares {200,404}; patch
 * declares {200,400,404}; delete declares {204,404}. The RUNTIME-ONLY codes
 * the handlers can still emit stay undeclared (the deploy-keys/
 * branch-protections batch pattern):
 *   - every op: 401 (reqToken);
 *   - writes:   422 (the Go binder's Required fields — "Name: Required" /
 *               "RedirectURIs: Required", the api.go `<Field>: <error>`
 *               rendering; the contract declares no 422 here);
 *   - patch:    500 (upstream's UID mismatch is a PLAIN error that its
 *               handler maps to APIErrorInternal — user/app.go
 *               UpdateOauth2Application + models/auth/oauth2.go:328 — unlike
 *               get/delete which 404 the foreign app; rendered by the
 *               repo-wide handler as the documented internal-error body).
 *
 * ERROR MESSAGES (the exact upstream texts):
 *   - invalid redirect URI: "invalid redirect URI: <uri>" (user/app.go,
 *     both create and patch);
 *   - create failure: "error creating oauth2 application";
 *   - every not-found arm: APIErrorNotFound's "not found"
 *     (services/context/api.go:137-142).
 */

// ---------------------------------------------------------------------------
// Wire schemas.
// ---------------------------------------------------------------------------

/** The rendered `OAuth2Application` (modules/structs/user_app.go:55-72) —
 *  every field serializes (no omitempty); `client_secret` carries the
 *  plaintext only in create/patch bodies. */
export const oauth2ApplicationSchema = z.object({
  id: z.number().int().openapi({ format: "int64", description: "The unique identifier of the OAuth2 application" }),
  name: z.string().openapi({ description: "The name of the OAuth2 application" }),
  client_id: z.string().openapi({ description: "The client ID of the OAuth2 application" }),
  client_secret: z.string().openapi({ description: "The client secret of the OAuth2 application" }),
  confidential_client: z.boolean().openapi({ description: "Whether the client is confidential" }),
  skip_secondary_authorization: z.boolean().openapi({ description: "Whether to skip secondary authorization" }),
  redirect_uris: z.array(z.string()).openapi({ description: "The list of allowed redirect URIs" }),
  created: z.string().openapi({ format: "date-time", description: "The timestamp when the application was created" }),
});

/** `#/definitions/CreateOAuth2ApplicationOptions` — the fields carry Go
 *  `binding:"Required"` tags enforced at runtime, not schema-level required,
 *  so the binder arm (422) fires off the optional zod fields. The fields are
 *  `nullish` because Go's JSON unmarshaller folds `null` into the zero value
 *  instead of erroring (a null string/slice then trips binding:"Required",
 *  a null bool just stays false). */
const createOAuth2ApplicationOptionsSchema = z.object({
  name: z.string().nullish().openapi({ description: "The name of the OAuth2 application" }),
  confidential_client: z.boolean().nullish().openapi({ description: "Whether the client is confidential" }),
  skip_secondary_authorization: z.boolean().nullish().openapi({ description: "Whether to skip secondary authorization" }),
  redirect_uris: z.array(z.string()).nullish().openapi({ description: "The list of allowed redirect URIs" }),
});

// ---------------------------------------------------------------------------
// Shared fragments.
// ---------------------------------------------------------------------------

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const idParam = {
  id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "Application ID to be found" }),
} as const;

// ---------------------------------------------------------------------------
// Handler helpers — the upstream ports, in handler order.
// ---------------------------------------------------------------------------

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathParamInt64(raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The Go binder's `binding:"Required"` arms for CreateOAuth2ApplicationOptions
 * (modules/structs/user_app.go:42-53): `Name` and `RedirectURIs` are
 * Required; the exact `<Field>: <error>` texts (api.go's binder rendering).
 * `null`/absent redirect_uris unmarshal to a nil Go slice (Required fails);
 * an EMPTY array is a non-nil slice upstream and creates the app with zero
 * URIs; a null name unmarshals to "" (Required fails).
 */
function bindCreateOAuth2ApplicationOptions(form: {
  name?: string | null;
  redirect_uris?: string[] | null;
}): { name: string; redirectUris: string[] } {
  if (form.name === undefined || form.name === null || form.name === "") {
    throw new ApiError(422, "Name: Required");
  }
  if (form.redirect_uris === undefined || form.redirect_uris === null) {
    throw new ApiError(422, "RedirectURIs: Required");
  }
  return { name: form.name, redirectUris: form.redirect_uris };
}

/**
 * The body-bind hook for both writes: any JSON-shape violation zod rejects
 * (a typed field, a malformed body) is Go's unmarshal error class — upstream
 * 422s those too, so the hook replaces hono's default 400 (the contract
 * declares no 422 here; runtime-only like the Required texts).
 */
const oauth2BodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/**
 * The handler's first arm on both create and patch
 * (user/app.go CreateOauth2Application / UpdateOauth2Application): the
 * invalid-URI 400 with the first offender inline.
 */
function requireValidRedirectUris(uris: string[]): void {
  const invalidURI = detectInvalidOAuth2ApplicationRedirectURI(uris);
  if (invalidURI !== "") {
    throw new ApiError(400, `invalid redirect URI: ${invalidURI}`);
  }
}

// ---------------------------------------------------------------------------
// The routes.
// ---------------------------------------------------------------------------

export function registerOAuth2AppRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // -------------------------------------------------------------------------
  // GET /user/applications/oauth2 (userGetOauth2Application)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/user/applications/oauth2",
      middleware: [requireAuth],
      tags: ["user"],
      summary: "List the authenticated user's oauth2 applications",
      operationId: "userGetOauth2Application",
      request: listQuery,
      responses: {
        200: {
          description: "OAuth2ApplicationList",
          content: { "application/json": { schema: z.array(oauth2ApplicationSchema) } },
        },
      },
    }),
    async (c) => {
      const doer = orgDoerOf(c.get("authUser"));
      const opts = parseListOptions(new URL(c.req.url));
      const { rows, total } = await listOAuth2Applications(c.env.DB, doer.id, opts.page, opts.limit);
      setPaginationHeaders(c, total, opts);
      // "Hide secret on application list" (user/app.go ListOauth2Applications).
      return c.json(rows.map((row) => toApiOAuth2Application(row, "")), 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /user/applications/oauth2 (userCreateOAuth2Application) — the
  // plaintext client_secret renders exactly once, here.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/user/applications/oauth2",
      middleware: [requireAuth],
      tags: ["user"],
      summary: "creates a new OAuth2 application",
      operationId: "userCreateOAuth2Application",
      request: {
        body: { content: { "application/json": { schema: createOAuth2ApplicationOptionsSchema } } },
      },
      responses: {
        201: {
          description: "OAuth2Application",
          content: { "application/json": { schema: oauth2ApplicationSchema } },
        },
        400: errorResponse,
      },
    }),
    async (c) => {
      const doer = orgDoerOf(c.get("authUser"));
      const form = c.req.valid("json");
      const { name, redirectUris } = bindCreateOAuth2ApplicationOptions(form);
      requireValidRedirectUris(redirectUris);
      const { row, secret } = await createOAuth2Application(
        c.env.DB,
        {
          uid: doer.id,
          name,
          redirectUris,
          confidentialClient: form.confidential_client === true,
          skipSecondaryAuthorization: form.skip_secondary_authorization === true,
        },
        new Date(),
      );
      return c.json(toApiOAuth2Application(row, secret), 201);
    },
    oauth2BodyHook,
  );

  // -------------------------------------------------------------------------
  // GET /user/applications/oauth2/{id} (userGetOAuth2Application) — a foreign
  // user's app is the same 404 (app.go's app.UID check hides existence).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/user/applications/oauth2/{id}",
      middleware: [requireAuth],
      tags: ["user"],
      summary: "get an OAuth2 Application",
      operationId: "userGetOAuth2Application",
      request: {
        params: z.object(idParam),
      },
      responses: {
        200: {
          description: "OAuth2Application",
          content: { "application/json": { schema: oauth2ApplicationSchema } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const doer = orgDoerOf(c.get("authUser"));
      const app = await getOAuth2ApplicationById(c.env.DB, pathParamInt64(c.req.valid("param").id));
      if (app === null || app.uid !== doer.id) {
        throw new ApiError(404, "not found");
      }
      // app.go GetOauth2Application blanks the secret before rendering.
      return c.json(toApiOAuth2Application(app, ""), 200);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /user/applications/oauth2/{id} (userUpdateOAuth2Application) — the
  // patch ALWAYS rotates the client secret (upstream regenerates on every
  // update, user/app.go UpdateOauth2Application). The UID mismatch arm is
  // upstream's plain-error 500, not a 404 (module header).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "patch",
      path: "/user/applications/oauth2/{id}",
      middleware: [requireAuth],
      tags: ["user"],
      summary: "update an OAuth2 Application, this includes regenerating the client secret",
      operationId: "userUpdateOAuth2Application",
      request: {
        params: z.object(idParam),
        body: { content: { "application/json": { schema: createOAuth2ApplicationOptionsSchema } } },
      },
      responses: {
        200: {
          description: "OAuth2Application",
          content: { "application/json": { schema: oauth2ApplicationSchema } },
        },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const doer = orgDoerOf(c.get("authUser"));
      const form = c.req.valid("json");
      const { name, redirectUris } = bindCreateOAuth2ApplicationOptions(form);
      requireValidRedirectUris(redirectUris);
      const result = await updateOAuth2Application(
        c.env.DB,
        {
          id: pathParamInt64(c.req.valid("param").id),
          uid: doer.id,
          name,
          redirectUris,
          confidentialClient: form.confidential_client === true,
          skipSecondaryAuthorization: form.skip_secondary_authorization === true,
        },
        new Date(),
      );
      if (result.kind === "not_found") {
        throw new ApiError(404, "not found");
      }
      if (result.kind === "uid_mismatch") {
        // models/auth/oauth2.go:328's plain "UID mismatch" error — the
        // upstream handler routes it to APIErrorInternal (500), not 404.
        throw new Error("UID mismatch");
      }
      return c.json(toApiOAuth2Application(result.row, result.secret), 200);
    },
    oauth2BodyHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /user/applications/oauth2/{id} (userDeleteOAuth2Application) — the
  // (id, uid) delete's 0-rows arm makes a foreign user's app the same 404.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/user/applications/oauth2/{id}",
      middleware: [requireAuth],
      tags: ["user"],
      summary: "delete an OAuth2 Application",
      operationId: "userDeleteOAuth2Application",
      request: {
        params: z.object(idParam),
      },
      responses: {
        204: { description: "APIEmpty" },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const doer = orgDoerOf(c.get("authUser"));
      const id = pathParamInt64(c.req.valid("param").id);
      // user/app.go DeleteOauth2Application: the load arm 404s the miss, then
      // the (id, uid) delete 404s again when zero rows carry the doer's uid.
      const app = await getOAuth2ApplicationById(c.env.DB, id);
      if (app === null) {
        throw new ApiError(404, "not found");
      }
      if (!(await deleteOAuth2Application(c.env.DB, id, doer.id))) {
        throw new ApiError(404, "not found");
      }
      return c.body(null, 204);
    },
  );
}
