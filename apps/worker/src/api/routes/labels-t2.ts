import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { createLabelOptionSchema, editLabelOptionSchema, labelListSchema, labelSchema } from "../models/label";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { orgDoerOf, type OrgDoer } from "../services/org-repos";
import {
  requireOrgOwnership,
  requireOrgVisible,
  resolveOrgForRequest,
  type OrgProfileDoer,
} from "../services/orgs";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import {
  createOrgLabel,
  findOrgLabelById,
  findOrgLabelByIdOrName,
  listOrgLabels,
  toApiOrgLabel,
} from "../services/labels-t2";
import { deleteRepoLabel, editRepoLabel, normalizeLabelColor, type LabelSortType } from "../services/labels";

/**
 * Tier-2 `organization`-tagged org-label routes (SPEC-0004 appendix A,
 * category a): GET/POST /orgs/{org}/labels, GET/PATCH/DELETE
 * /orgs/{org}/labels/{id} — the orgLabel family
 * (orgListLabels/orgCreateLabel/orgGetLabel/orgEditLabel/orgDeleteLabel).
 * Behavior authority: gitea/routers/api/v1/org/label.go (handlers) over
 * api.go:1758–1764 (registration); queries in services/labels-t2.ts.
 *
 * Upstream guard chain (middleware order at api.go:1786 + 1758–1764): the
 * /orgs/{org} group's orgAssignment (rename 307 seam / type-filtered 404) →
 * the labels group's reqOrgVisible (invisible org ⇒ 404) → per-op:
 *   - GET list:        anonymous-capable (no reqToken — unlike every other
 *                      read of the family);
 *   - GET /{id}:       reqToken (the combo wires it — anonymous gets the
 *                      runtime-only 401 the vendored contract omits), then
 *                      the handler; id resolves by int OR case-sensitive name;
 *   - POST/PATCH/DELETE: reqToken + reqOrgOwnership — 403
 *                      "Must be an organization owner" (api.go:449) for plain
 *                      members and non-members; site admins bypass
 *                      (api.go:428–430).
 *
 * Declared responses mirror the vendored contract exactly; runtime-only codes
 * the handlers can still emit (orchestrator-owned RUNTIME_ONLY_RESPONSES
 * table, same class as the /user 401 exception):
 *   - all ops:              401 (reqToken'd ops), 307 (renamed org — the
 *                           group orgAssignment answers before everything
 *                           upstream);
 *   - POST/PATCH:           400 (malformed JSON dies in the request validator;
 *                           upstream bind 422s).
 * Ordering note: upstream answers the org 404/307 BEFORE reqToken's 401
 * (group middleware first); our requireAuth middleware runs before the
 * handler's org resolution, so an anonymous caller on a missing org gets the
 * 401 — the same accepted ordering as the routes/orgs.ts family.
 *
 * Mirrored upstream quirks (see services/labels-t2.ts for citations):
 *   - org Get/Edit/Delete 404s are the PLAIN "not found"
 *     (APIErrorNotFound), not the repo family's detailed label message;
 *   - DELETE of a missing label is still 204 (DeleteOrgLabel deletes zero
 *     rows without error);
 *   - POST ignores `is_archived` (upstream builds the Label without an
 *     archived stamp);
 *   - PATCH absent `is_archived` KEEPS the archived stamp (shared
 *     editRepoLabel; the landed repo family made the same call for the
 *     identical `SetArchived(form.IsArchived != nil && *form.IsArchived)`
 *     handler shape — deviation vs literal upstream documented there);
 *   - `sort` is honored on the list but never declared in the contract
 *     (upstream reads ctx.FormString("sort") with the same mismatch);
 *   - tokenRequiresScopes scope categories are mounted tree-wide
 *     (src/api/router.ts's apiScopeGate — this family's /orgs paths carry
 *     `organization`, auth-parity H1); public-only-token downgrades remain
 *     the services/orgs.ts header's topic.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const orgParams = {
  org: z.string().min(1).openapi({ description: "name of the organization" }),
} as const;

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

const idParams = {
  params: z.object({
    ...orgParams,
    id: z
      .string()
      .min(1)
      .openapi({ type: "integer", format: "int64", description: "id of the label to get" }),
  }),
} as const;

const orgListLabelsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/labels",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "List an organization's labels",
    operationId: "orgListLabels",
    request: { params: z.object(orgParams), ...listQuery },
    responses: {
      200: {
        description: "LabelList",
        content: { "application/json": { schema: labelListSchema } },
      },
      404: notFoundResponse,
    },
  });

const orgCreateLabelRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/orgs/{org}/labels",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Create a label for an organization",
    operationId: "orgCreateLabel",
    request: {
      params: z.object(orgParams),
      body: { content: { "application/json": { schema: createLabelOptionSchema } } },
    },
    responses: {
      201: {
        description: "Label",
        content: { "application/json": { schema: labelSchema } },
      },
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const orgGetLabelRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/labels/{id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Get a single label",
    operationId: "orgGetLabel",
    request: idParams,
    responses: {
      200: {
        description: "Label",
        content: { "application/json": { schema: labelSchema } },
      },
      404: notFoundResponse,
    },
  });

const orgEditLabelRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/orgs/{org}/labels/{id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Update a label",
    operationId: "orgEditLabel",
    request: {
      ...idParams,
      body: { content: { "application/json": { schema: editLabelOptionSchema } } },
    },
    responses: {
      200: {
        description: "Label",
        content: { "application/json": { schema: labelSchema } },
      },
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const orgDeleteLabelRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/orgs/{org}/labels/{id}",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Delete a label",
    operationId: "orgDeleteLabel",
    request: idParams,
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
    },
  });

/** The org family's shared 404: plain "not found" (APIErrorNotFound). */
function orgNotFound(): ApiError {
  return new ApiError(404, "not found");
}

/**
 * The renamed-org 307 as a thrown HTTPException carrying its prepared
 * response: the routes' declared response unions stay contract-shaped while
 * giteaErrorHandler passes the prepared 307 — Location + empty body —
 * through untouched (same seam as routes/orgs.ts).
 */
function renamedOrgRedirect(location: string): HTTPException {
  return new HTTPException(307, {
    res: new Response(null, { status: 307, headers: { Location: location } }),
  });
}

/** Doer slice for the list route (null = anonymous). */
function optionalDoer(c: Context<ApiEnv>): OrgProfileDoer | null {
  const requester = c.get("authUser");
  return requester === undefined ? null : orgDoerOf(requester);
}

/** Doer slice for the reqToken'd ops (requireAuth guarantees the row). */
function requireDoer(c: Context<ApiEnv>): OrgDoer & { id: number } {
  const requester = c.get("authUser");
  if (requester === undefined) {
    throw new ApiError(401, "token is required");
  }
  return orgDoerOf(requester);
}

/**
 * The orgAssignment + reqOrgVisible seam every route here shares: the
 * resolved org, a thrown 307 for renamed orgs, or the thrown 404-shaped miss
 * (missing org, plain user under /orgs, invisible org — all indistinguishable
 * upstream).
 */
async function resolveVisibleOrg(
  c: Context<ApiEnv>,
  orgName: string,
  doer: OrgProfileDoer | null,
): Promise<{ orgs: OrgService; org: OrgRecord }> {
  const url = new URL(c.req.url);
  const resolved = await resolveOrgForRequest(
    c.env.DB,
    orgName,
    doer,
    c.req.path,
    url.search.startsWith("?") ? url.search.slice(1) : url.search,
  );
  if (resolved.kind === "redirect") {
    throw renamedOrgRedirect(resolved.location);
  }
  if (resolved.kind === "missing") {
    throw orgNotFound();
  }
  const orgs = new OrgService(c.env.DB);
  await requireOrgVisible(orgs, resolved.org, doer);
  return { orgs, org: resolved.org };
}

/** Body bind hook: upstream's Go bind answers malformed bodies with the
 * declared 422 (same family convention as routes/labels.ts). */
const labelBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** Tri-state pointer rule: absent and JSON-null both mean "unchanged". */
function patchField<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

/**
 * `ctx.PathParamInt64` — strict decimal or 0 (garbage ids never match a
 * label, unlike GET's name fallback).
 */
function pathParamInt64(raw: string): number {
  return /^[+-]?\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
}

/** The silent `sort` query (never declared in the contract — upstream reads
 * ctx.FormString("sort") with the same mismatch); unknown values take the
 * default alphabetical order. */
function sortParam(url: URL): LabelSortType {
  const raw = url.searchParams.get("sort") ?? "";
  return raw === "reversealphabetically" || raw === "leastissues" || raw === "mostissues" ? raw : "";
}

export function registerLabelsT2Routes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // GET /orgs/{org}/labels (orgListLabels) — anonymous-capable, the one
  // reqToken-free read of the family (api.go:1759).
  app.openapi(orgListLabelsRoute(optionalAuth), async (c) => {
    const doer = optionalDoer(c);
    const { org: orgName } = c.req.valid("param");
    const { org } = await resolveVisibleOrg(c, orgName, doer);
    const url = new URL(c.req.url);
    const listOptions = parseListOptions(url);
    const { items, total } = await listOrgLabels(
      c.env.DB,
      org.id,
      sortParam(url),
      listOptions.page,
      listOptions.limit,
    );
    setPaginationHeaders(c, total, listOptions);
    const origin = url.origin;
    return c.json(items.map((row) => toApiOrgLabel(row, org.username, origin)), 200);
  });

  // POST /orgs/{org}/labels (orgCreateLabel) — reqOrgOwnership upstream.
  app.openapi(
    orgCreateLabelRoute(requireAuth),
    async (c) => {
      const doer = requireDoer(c);
      const { org: orgName } = c.req.valid("param");
      const { orgs, org } = await resolveVisibleOrg(c, orgName, doer);
      await requireOrgOwnership(orgs, org, doer);
      const body = c.req.valid("json");
      // org.CreateLabel trims spaces then NormalizeColor (org/label.go:80–87);
      // the shared normalizer's own TrimSpace subsumes the space trim.
      const color = normalizeLabelColor(body.color);
      const row = await createOrgLabel(c.env.DB, org.id, {
        name: body.name,
        exclusive: body.exclusive ?? false,
        color,
        description: body.description ?? "",
      });
      return c.json(toApiOrgLabel(row, org.username, new URL(c.req.url).origin), 201);
    },
    labelBodyHook,
  );

  // GET /orgs/{org}/labels/{id} (orgGetLabel) — reqToken'd upstream
  // (api.go:1761), id by int with the case-sensitive name fallback.
  app.openapi(orgGetLabelRoute(requireAuth), async (c) => {
    const doer = requireDoer(c);
    const { org: orgName, id } = c.req.valid("param");
    const { org } = await resolveVisibleOrg(c, orgName, doer);
    const row = await findOrgLabelByIdOrName(c.env.DB, org.id, id);
    if (row === null) {
      // org.GetLabel answers IsErrOrgLabelNotExist with the PLAIN
      // APIErrorNotFound — not the repo family's detailed message
      // (org/label.go:70–74).
      throw orgNotFound();
    }
    return c.json(toApiOrgLabel(row, org.username, new URL(c.req.url).origin), 200);
  });

  // PATCH /orgs/{org}/labels/{id} (orgEditLabel) — lookup (plain 404) before
  // the color 422, exactly upstream's handler order (org/label.go:148–175).
  app.openapi(
    orgEditLabelRoute(requireAuth),
    async (c) => {
      const doer = requireDoer(c);
      const { org: orgName, id } = c.req.valid("param");
      const { orgs, org } = await resolveVisibleOrg(c, orgName, doer);
      await requireOrgOwnership(orgs, org, doer);
      const numericId = pathParamInt64(id);
      const row = await findOrgLabelById(c.env.DB, org.id, numericId);
      if (row === null) {
        throw orgNotFound();
      }
      const body = c.req.valid("json");
      let color: string | undefined;
      const rawColor = patchField(body.color);
      if (rawColor !== undefined) {
        color = normalizeLabelColor(rawColor);
      }
      const updated = await editRepoLabel(c.env.DB, row, {
        name: patchField(body.name),
        exclusive: patchField(body.exclusive),
        color,
        description: patchField(body.description),
        isArchived: patchField(body.is_archived),
        now: new Date(),
      });
      return c.json(toApiOrgLabel(updated, org.username, new URL(c.req.url).origin), 200);
    },
    labelBodyHook,
  );

  // DELETE /orgs/{org}/labels/{id} (orgDeleteLabel) — DeleteOrgLabel deletes
  // zero rows without error, so a missing label is still the 204
  // (org/label.go:214–224 over models/issues/label.go:282–298).
  app.openapi(orgDeleteLabelRoute(requireAuth), async (c) => {
    const doer = requireDoer(c);
    const { org: orgName, id } = c.req.valid("param");
    const { orgs, org } = await resolveVisibleOrg(c, orgName, doer);
    await requireOrgOwnership(orgs, org, doer);
    const row = await findOrgLabelById(c.env.DB, org.id, pathParamInt64(id));
    if (row !== null) {
      await deleteRepoLabel(c.env.DB, row);
    }
    return c.body(null, 204);
  });
}
