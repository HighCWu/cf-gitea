import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { repositories } from "../../db/schema";
import { RepoNameCollisionError, RepoNameInvalidError, RepoService } from "../../repos/service";
import { tombstoneRepoDO } from "../../repos/purge";
import { OrgService } from "../../services/orgs/orgs";
import { emitRepoEvent, repositoryEventIdentity, repositoryEventPayload } from "../../services/repo-events";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { createRepoOptionSchema, repositorySchema } from "../models/repository";
import {
  orgDoerOf,
  requireCanCreateOrgRepo,
  toCreatedOrgRepository,
  orgUserRow,
} from "../services/org-repos";
import { requireOrgOwnership, resolveOrgForRequest } from "../services/orgs";
import { deleteRepoCollaborators } from "../services/repo-collaborators";
import { deleteRepoSettings } from "../services/repo-settings";
import { deleteRepoTopics } from "../services/repo-topics";
import { deleteRepoWatchers } from "../services/repo-watchers";
import {
  canViewRepositoryWithTeams,
  findRepositoryById,
  findRepositoryByPath,
  viewerOf,
} from "../services/repository";

/**
 * Org/repo EXTRAS — the three non-aggregate ops of the api-remaining-inventory
 * batch `wave-api-tokens-times-aggregates` (plus the repo-scoped signing-key
 * pair), all table-free:
 *
 *   - POST /org/{org}/repos (createOrgRepoDeprecated — repo/repo.go:428-459):
 *     the DEPRECATED singular-org alias of the declared createOrgRepo
 *     (routes/org-repos.ts). Upstream's handler IS CreateOrgRepo — the alias
 *     re-drives the same guard chain and service here (extracting the shared
 *     handler would touch org-repos.ts, outside this batch's ownership; the
 *     verbatim duplicate is the documented seam until a consolidation wave).
 *   - DELETE /orgs/{org}/repos (orgDeleteRepos — org/org.go:540-579): the
 *     org-owner-gated bulk delete over the landed §2.5.5 purge pipeline
 *     (src/repos/purge.ts + RepoService.deleteRepository). Upstream answers
 *     202 and deletes in a DETACHED goroutine (org.go:576); cf-gitea rides
 *     the executionCtx-guarded waitUntil (the branches.ts/tags.ts precedent —
 *     in-process callers without an execution context run inline so tests
 *     stay deterministic), with upstream's per-repo continue-on-error arm.
 *   - GET /repos/{owner}/{repo}/signing-key.gpg|.pub (repoSigningKey /
 *     repoSigningKeySSH — misc/signing.go:14-24 shared helper): the repo
 *     pair of the landed GLOBAL signing-key routes (routes/misc-t3.ts).
 *     cf-gitea has no signing-key configuration, so the helper's blank-format
 *     arm answers APIErrorNotFound("no signing key") — the same degenerate
 *     404 the global pair ships, declared with the contract's {200} plus the
 *     documented RUNTIME_ONLY_RESPONSES exceptions in
 *     scripts/check-openapi.mjs. Like the global pair's registration
 *     (api.go:1015-1016 vs 1530-1531), the repo paths carry NO extra gate
 *     beyond the repo assignment — the visibility check 404s
 *     missing/invisible repos, anonymous included.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

// ---------------------------------------------------------------------------
// Route declarations
// ---------------------------------------------------------------------------

const createOrgRepoDeprecatedRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/org/{org}/repos",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Create a repository in an organization",
    operationId: "createOrgRepoDeprecated",
    deprecated: true,
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of organization" }),
      }),
      body: { content: { "application/json": { schema: createRepoOptionSchema } } },
    },
    responses: {
      201: { description: "Repository", content: { "application/json": { schema: repositorySchema } } },
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

const orgDeleteReposRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/orgs/{org}/repos",
    middleware: [requireAuth],
    tags: ["organization"],
    summary: "Delete all repositories in an organization",
    operationId: "orgDeleteRepos",
    request: {
      params: z.object({
        org: z.string().min(1).openapi({ description: "name of the organization" }),
      }),
    },
    responses: {
      202: { description: "empty" },
      204: { description: "empty" },
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

/** The signing-key pair: the contract declares {200} text/plain alone — the
 *  reachable 404 is the documented RUNTIME_ONLY_RESPONSES exception. */
const signingKeyResponses = {
  200: {
    description: "GPG armored public key",
    content: { "text/plain": { schema: z.string() } },
  },
} as const;

const repoSigningKeyGpgRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/signing-key.gpg",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get signing-key.gpg for given repository",
    operationId: "repoSigningKey",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
      }),
    },
    responses: signingKeyResponses,
  });

const repoSigningKeyPubRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/signing-key.pub",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get signing-key.pub for given repository",
    operationId: "repoSigningKeySSH",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo" }),
        repo: z.string().min(1).openapi({ description: "name of the repo" }),
      }),
    },
    responses: signingKeyResponses,
  });

// ---------------------------------------------------------------------------

export function registerAdminOrgExtrasRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // POST /org/{org}/repos (createOrgRepoDeprecated) — the alias arm of
  // createOrgRepo (upstream calls CreateOrgRepo verbatim, repo.go:458).
  // Declared set {201,403,404,422} = the contract's; the 409 duplicate-name
  // arm stays runtime-only undeclared (org-repos.ts module header).
  // -------------------------------------------------------------------------
  app.openapi(createOrgRepoDeprecatedRoute(requireAuth), async (c) => {
    const { org: orgName } = c.req.valid("param");
    const doer = orgDoerOf(c.get("authUser"));
    const org = await requireCanCreateOrgRepo(c.env.DB, orgName, doer);
    const form = c.req.valid("json");
    const service = new RepoService(c.env.DB);
    let repo;
    try {
      repo = await service.create({
        owner: { id: org.id, usernameLower: org.usernameLower },
        name: form.name,
        isPrivate: form.private === true,
      });
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
        owner: await orgUserRow(c.env.DB, org),
      }),
      201,
    );
  });

  // -------------------------------------------------------------------------
  // DELETE /orgs/{org}/repos (orgDeleteRepos) — org-owner gate (the upstream
  // 403 message verbatim), then the org's repo ids: none → 204, else 202 +
  // the background delete loop (one §2.5.5 pipeline + one `deleted` webhook
  // per repo, per-repo continue-on-error like upstream's notice arm).
  // -------------------------------------------------------------------------
  app.openapi(orgDeleteReposRoute(requireAuth), async (c) => {
    const { org: orgName } = c.req.valid("param");
    const doer = orgDoerOf(c.get("authUser"));
    const url = new URL(c.req.url);
    const resolved = await resolveOrgForRequest(
      c.env.DB,
      orgName,
      doer,
      c.req.path,
      url.search.startsWith("?") ? url.search.slice(1) : url.search,
    );
    if (resolved.kind === "redirect") {
      // The /orgs/{org} group's rename seam (orgs.ts resolveOrg): the
      // prepared 307 passes through giteaErrorHandler untouched.
      throw new HTTPException(307, {
        res: new Response(null, { status: 307, headers: { Location: resolved.location } }),
      });
    }
    if (resolved.kind === "missing") {
      throw new ApiError(404, "not found");
    }
    const org = resolved.org;
    await requireOrgOwnership(new OrgService(c.env.DB), org, doer);

    const repoIds = (
      await drizzle(c.env.DB)
        .select({ id: repositories.id })
        .from(repositories)
        .where(eq(repositories.ownerId, org.id))
        .all()
    ).map((row) => row.id);
    if (repoIds.length === 0) {
      return c.body(null, 204);
    }

    const deleteAll = (async () => {
      for (const repoId of repoIds) {
        try {
          const found = await findRepositoryById(c.env.DB, repoId);
          if (found === null) {
            continue; // GetRepositoryByID failure arm (org.go:522-527)
          }
          // The repoDelete housekeeping first (the §2.5.5 pipeline's
          // raw-D1-store sweep — see routes/repo.ts repoDelete).
          await Promise.all([
            deleteRepoTopics(c.env.DB, found.repo.id),
            deleteRepoWatchers(c.env.DB, found.repo.id),
            deleteRepoCollaborators(c.env.DB, found.repo.id),
            deleteRepoSettings(c.env.DB, found.repo.id),
          ]);
          await new RepoService(c.env.DB, {
            registry: c.env.REGISTRY.getByName("registry"),
            queue: c.env.REPO_TASKS,
            tombstone: (engineName) => tombstoneRepoDO(c.env, engineName),
          }).deleteRepository(found.repo.id);
          const identity = repositoryEventIdentity(viewerOf(c), found);
          await emitRepoEvent(c, {
            repoId: found.repo.id,
            ownerId: found.repo.ownerId,
            eventType: "repository",
            payload: repositoryEventPayload("deleted", identity.repository, identity.organization, c.get("authUser")),
          });
        } catch (error) {
          // deleteOrgReposBackground's per-repo arm (org.go:521-536): one
          // failure skips that repo, the loop continues.
          console.error(
            `[admin-org-extras] org repo deletion failed (org ${org.username} repo ${repoId}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    })();
    let execCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
    try {
      execCtx = c.executionCtx;
    } catch {
      execCtx = undefined; // in-process caller (tests): run inline
    }
    if (execCtx === undefined) {
      await deleteAll;
    } else {
      execCtx.waitUntil(deleteAll);
    }
    return c.body(null, 202);
  });

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/signing-key.gpg (repoSigningKey) and
  // …/signing-key.pub (repoSigningKeySSH) — the repo arm of the global
  // signing-key pair: repo assignment first (invisible/missing → the
  // assignment 404), then the no-key degenerate 404 verbatim.
  // -------------------------------------------------------------------------
  const requireSigningKeyRepo = async (c: Context<ApiEnv>): Promise<never> => {
    const params = c.req.param();
    const viewer = viewerOf(c);
    const found = await findRepositoryByPath(c.env.DB, params.owner ?? "", params.repo ?? "");
    if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
      throw new ApiError(404, "not found");
    }
    throw new ApiError(404, "no signing key");
  };
  app.openapi(repoSigningKeyGpgRoute(optionalAuth), (c) => requireSigningKeyRepo(c));
  app.openapi(repoSigningKeyPubRoute(optionalAuth), (c) => requireSigningKeyRepo(c));
}
