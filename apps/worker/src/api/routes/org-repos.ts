import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { RepoNameCollisionError, RepoNameInvalidError } from "../../repos/service";
import { assertDemoRepoQuota, DemoRepoQuotaError } from "../../services/demo-quota";
import { OrgService } from "../../services/orgs/orgs";
import { emitRepoEvent, repositoryEventIdentity, repositoryEventPayload } from "../../services/repo-events";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { organizationListSchema } from "../models/organization";
import type { User } from "../models/user";
import { createRepoOptionSchema, repositoryListSchema, repositorySchema } from "../models/repository";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { createUserRepository, resolveAutoInitReadme } from "../services/user-repos";
import {
  listOrgRepositories,
  orgDoerOf,
  orgUserRow,
  requireCanCreateOrgRepo,
  toApiOrganization,
  toCreatedOrgRepository,
} from "../services/org-repos";
import { findRepositoryById, toApiRepository, viewerOf } from "../services/repository";

/**
 * Tier-1 `organization`-tagged routes (SPEC-0007 §2.2 rows 1–3):
 * `GET /user/orgs` (orgListCurrentUserOrgs), `GET /orgs/{org}/repos`
 * (orgListRepos), `POST /orgs/{org}/repos` (createOrgRepo).
 *
 * Declared responses mirror the vendored contract exactly; the RUNTIME-ONLY
 * codes the handlers can still emit (orchestrator-owned
 * RUNTIME_ONLY_RESPONSES table, same class as the /user 401 exception):
 *   - GET /user/orgs:        401 — upstream `reqToken` (api.go:1718); the
 *                            swagger-declared 404 is unreachable
 *   - GET /orgs/{org}/repos: none — anonymous is allowed (no reqToken on
 *                            this GET, api.go:1733)
 *   - POST /orgs/{org}/repos: 401 (reqToken), 409 ("The repository with the
 *                            same name already exists."), 422 (invalid name
 *                            — upstream 422s err.Error())
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

const listQuery = {
  query: z.object({
    page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

/**
 * `GET /user/orgs` — the current user's organizations. Upstream wires TWO
 * scope categories here (organization + repository, api.go:1718; SPEC-0004
 * §2.4 row) and `reqToken`s the route; the per-category scope enforcement
 * lands with the SPEC-0002 API-layer scope gates (this requireAuth matches
 * the landed tier-1 routes' convention). Self-list semantics: the doer sees
 * ALL their memberships including non-public ones (the service's default
 * 'private' ceiling skips the `is_public` filter, org_list.go:57–71); a
 * public-only token downgrade lands with the scope gates too.
 */
const userOrgsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/user/orgs",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "List the current user's organizations",
    operationId: "orgListCurrentUserOrgs",
    request: listQuery,
    responses: {
      200: {
        description: "OrganizationList",
        content: { "application/json": { schema: organizationListSchema } },
      },
      404: notFoundResponse,
    },
  });

/**
 * `GET /orgs/{org}/repos` — anonymous allowed (upstream has NO reqToken and
 * NO owner-visibility gate on this GET): the §4.7 quirk is that an anonymous
 * caller receives 200 + the public repos of a *limited* or *private* org,
 * unlike GET /orgs/{org} (404) and git HTTP (401-challenge). Missing orgs
 * and plain-user names are the same 404 (GetOrgByName type filter, §4.11).
 */
const orgReposRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/orgs/{org}/repos",
    middleware: [optionalAuth],
    tags: ["organization"],
    summary: "List an organization's repos",
    operationId: "orgListRepos",
    request: {
      ...listQuery,
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of the organization" }),
      }),
    },
    responses: {
      200: {
        description: "RepositoryList",
        content: { "application/json": { schema: repositoryListSchema } },
      },
      404: notFoundResponse,
    },
  });

/**
 * `POST /orgs/{org}/repos` — 201 + the Repository at owner permissions.
 * Guard order (upstream `prepareDoerCreateRepoInOrg` + `CreateUserRepo`):
 * org missing/invisible → 404; create grant missing → 403; duplicate name →
 * 409; invalid/reserved name → 422. The §4.3 demo quota rides the declared
 * 403 arm (the M2 known-gap fold — the user-repos note applies, with the
 * ORG as the quota owner). The create itself is upstream's shared
 * `CreateUserRepo` service half (`repo.go:493` — `org.AsUser()` IS the
 * owner), so `auto_init` lands the initial commit through the engine and
 * `description`/`default_branch` persist, exactly like `POST /user/repos`.
 */
const createOrgRepoRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/orgs/{org}/repos",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Create a repository in an organization",
    operationId: "createOrgRepo",
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of organization" }),
      }),
      body: { content: { "application/json": { schema: createRepoOptionSchema } } },
    },
    responses: {
      201: { description: "Repository", content: { "application/json": { schema: repositorySchema } } },
      400: errorResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

export function registerOrgRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(userOrgsRoute(requireAuth), async (c) => {
    const doer = orgDoerOf(c.get("authUser"));
    const listOptions = parseListOptions(new URL(c.req.url));
    // Self-list: doer == subject ⇒ IncludeVisibility = private (the service
    // default) — every membership is listed, non-public ones included.
    const { items, total } = await new OrgService(c.env.DB).listUserOrgs(doer.id, {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const origin = new URL(c.req.url).origin;
    return c.json(items.map((org) => toApiOrganization(org, { origin, includeEmail: true })), 200);
  });

  app.openapi(orgReposRoute(optionalAuth), async (c) => {
    const { org } = c.req.valid("param");
    const orgs = new OrgService(c.env.DB);
    const orgRecord = await orgs.getOrgByUsername(org);
    if (orgRecord === null) {
      throw new ApiError(404, "not found");
    }
    // NO owner-visibility gate here — the mirrored upstream quirk (§4.7).
    const requester: User | undefined = c.get("authUser");
    const doer = requester === undefined ? { id: null as number | null, isAdmin: false } : orgDoerOf(requester);
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listOrgRepositories(c.env.DB, orgRecord, doer, {
      page: listOptions.page,
      pageSize: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    const viewer = viewerOf(c);
    return c.json(items.map((pair) => toApiRepository(viewer, pair)), 200);
  });

  app.openapi(createOrgRepoRoute(requireAuth), async (c) => {
    const { org: orgName } = c.req.valid("param");
    const doer = orgDoerOf(c.get("authUser"));
    // Guard chain in upstream order: 404 (missing/invisible) → 403 (grant).
    const org = await requireCanCreateOrgRepo(c.env.DB, orgName, doer);
    // SPEC-0014 §4.3 (the M2 known-gap fold) — the same gated per-owner quota
    // as POST /user/repos, with the owner being the ORG: upstream hands the
    // org to the create (`CreateUserRepo(ctx, org.AsUser(), *opt)`,
    // repo.go:493) and `CanCreateRepoIn` counts the OWNER's repositories
    // under the DOER's admin bypass (user.go:285-295) — the create below
    // is owned by the org's users row (id = org.id; orgs ARE owners), so
    // the assert rides `org.id`
    // (orgs ARE owners; a visitor cannot route around the cap via own-orgs).
    // Same mapping as user-repos.ts: the refusal unwraps to
    // ErrPermissionDenied → 403 + err.Error() (repo.go:263-264); the
    // admin-doer bypass rides the helper. Gate off → zero reads, zero checks
    // (the §2 invariant).
    try {
      await assertDemoRepoQuota(c.env, c.env.DB, doer, org.id);
    } catch (error) {
      if (error instanceof DemoRepoQuotaError) {
        throw new ApiError(403, error.message);
      }
      throw error;
    }
    const form = c.req.valid("json");
    // Upstream CreateUserRepo head: the readme-template 400 lands before any
    // write (repo.go:231-240), exactly like the /user/repos and admin
    // create-for-user routes.
    resolveAutoInitReadme(form);
    // The 201 rides the SAME upstream service half every other create route
    // shares: repo.go:493 hands the ORG to `CreateUserRepo(ctx, org.AsUser(),
    // *opt)` — description/default_branch metadata, the auto_init initial
    // commit (the owner's git signature, i.e. the org-as-user row — init.go
    // initRepoCommit(ctx, tmpPath, repo, u)) and the is_empty flip. The
    // engine registry rides the create (REDEPLOY8 — the user-repos note):
    // bare construction skips seedRepoExtras' upsert and the repo 404s on
    // info/refs/clone until a push lands.
    const ownerRow = await orgUserRow(c.env.DB, org);
    let repo;
    try {
      repo = await createUserRepository(c.env.DB, c.env, ownerRow, form, new Date());
    } catch (error) {
      if (error instanceof RepoNameCollisionError) {
        throw new ApiError(409, "The repository with the same name already exists.");
      }
      if (error instanceof RepoNameInvalidError) {
        // upstream 422s err.Error() for reserved/pattern violations; our
        // ported message text differs from Go's error strings
        throw new ApiError(422, error.message);
      }
      throw error;
    }
    const viewer = viewerOf(c);
    // Webhook: repository created (upstream CreateRepository,
    // notifier.go:114-116 with u = the ORG owner — Organization renders the
    // owner; Sender is the creating doer). A webhook failure is caught
    // inside the fan-out and never fails the 201.
    const created = await findRepositoryById(c.env.DB, repo.id);
    if (created !== null) {
      const identity = repositoryEventIdentity(viewer, created);
      await emitRepoEvent(c, {
        repoId: created.repo.id,
        ownerId: created.repo.ownerId,
        eventType: "repository",
        payload: repositoryEventPayload("created", identity.repository, identity.organization, c.get("authUser")),
      });
    }
    return c.json(
      toCreatedOrgRepository(viewer, {
        repo,
        owner: ownerRow,
      }),
      201,
    );
  });
}
