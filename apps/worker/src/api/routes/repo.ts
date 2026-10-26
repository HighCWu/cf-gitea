import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories } from "../../db/schema";
import {
  OwnerNotAssignableError,
  RepoNameCollisionError,
  RepoNameInvalidError,
  RepoService,
} from "../../repos/service";
import { tombstoneRepoDO } from "../../repos/purge";
import { carryRepoCell } from "../../repos/carry";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  editRepoOptionSchema,
  repositorySchema,
  searchResultsSchema,
  transferRepoOptionSchema,
} from "../models/repository";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { BLOCKED_USER_MESSAGE, isUserBlockedBy } from "../services/blocks";
import { requireRepoAdmin, requireRepoDangerZone, requireVisibleRepo } from "../services/repo-access";
import { deleteRepoCollaborators } from "../services/repo-collaborators";
import { deleteRepoSettings, loadRepoSettings, saveRepoSettings, type RepoSettings } from "../services/repo-settings";
import { deleteRepoTopics } from "../services/repo-topics";
import { deleteRepoWatchers } from "../services/repo-watchers";
import { emitRepoEvent, repositoryEventIdentity, repositoryEventPayload } from "../../services/repo-events";
import {
  findRepositoryById,
  findRepositoryByPath,
  findUserByName,
  formBool,
  formBoolValue,
  formInt64,
  formString,
  formTrim,
  canViewRepository,
  searchRepositories,
  toApiRepository,
  viewerTeamAccessMode,
  viewerOf,
  type Viewer,
} from "../services/repository";

/**
 * Tier-1 `repository`-tagged repo-metadata routes (SPEC-0004 §2.4 rows:
 * repoGet / repoSearch / repoGetByID / repoEdit / repoDelete / repoTransfer).
 *
 * 404s follow the upstream anti-enumeration rule: a missing repository and a
 * private repository invisible to the requester are indistinguishable
 * (APIErrorNotFound → `{message: "not found", url}` at runtime; the vendored
 * contract declares the notFound response body-less — SPEC-0004 §2.5 quirk).
 *
 * repoEdit applies the meaningful EditRepoOption subset (the model file
 * documents the accepted-and-ignored remainder): rename via the landed
 * repos service, visibility flip, default branch (D1 + best-effort engine
 * setHead), archived flip, and the stored settings subset; upstream registers
 * NO mustNotBeArchived on this PATCH, so 423 is never emitted here.
 * repoDelete runs the landed §2.5.5 pipeline (D1 cascade → DO tombstone →
 * queue purge) plus the raw-D1 housekeeping of this batch's tables.
 * repoTransfer files the pending `repo_transfer` row via the repos service
 * and answers the SPEC-pinned async 202 (SPEC-0004 §2.4: "202 Accepted —
 * async, pending transfer; not the final state"; upstream's synchronous
 * 201-on-immediate-transfer path needs the team machinery this instance
 * defers, and its pending-transfer 201 would contradict the contract).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/** Query params declared as lenient strings (upstream never 400s on query
 * garbage — Go form helpers coerce); the generated OpenAPI types are
 * overridden to the contract's `boolean`/`integer` per parameter. */
const formBoolParam = (description: string) =>
  z.string().optional().openapi({ type: "boolean", description });
const formIntParam = (description: string) =>
  z.string().optional().openapi({ type: "integer", format: "int64", description });

/**
 * `GET /repos/{owner}/{repo}` — vendored contract: tag `repository`,
 * operationId `repoGet`, 200 → Repository + 404 → notFound. Anonymous reads
 * of public repositories; private ones 404 unless the token resolves to the
 * owner or a site admin (reduced ACL — SPEC-0003 owns the full matrix).
 */
function getRepoRoute(optionalAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
  method: "get",
  path: "/repos/{owner}/{repo}",
  middleware: [optionalAuth],
  tags: ["repository"],
  summary: "Get a repository",
  operationId: "repoGet",
  request: {
    params: z.object({
      owner: z.string().min(1).openapi({ description: "owner of the repo" }),
      repo: z.string().min(1).openapi({ description: "name of the repo" }),
    }),
  },
  responses: {
    200: {
      description: "Repository",
      content: { "application/json": { schema: repositorySchema } },
    },
    404: notFoundResponse,
  },
  });
}

/**
 * `GET /repos/search` — 17 query params per the contract; 200 → SearchResults
 * + 422 → validationError (invalid `mode`/`sort`/`order`). Runtime list
 * headers (`X-Total-Count`, `Link`) are sent upstream-style on every list.
 * Token is optional (`?private=true` visibility depends on the caller).
 */
function searchReposRoute(optionalAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
  method: "get",
  path: "/repos/search",
  middleware: [optionalAuth],
  tags: ["repository"],
  summary: "Search for repositories",
  operationId: "repoSearch",
  request: {
    query: z.object({
      q: z.string().optional().openapi({ description: "keyword" }),
      topic: formBoolParam("Limit search to repositories with keyword as topic"),
      includeDesc: formBoolParam("include search of keyword within repository description"),
      uid: formIntParam("search only for repos that the user with the given id owns or contributes to"),
      priority_owner_id: formIntParam("repo owner to prioritize in the results"),
      team_id: formIntParam("search only for repos that belong to the given team id"),
      starredBy: formIntParam("search only for repos that the user with the given id has starred"),
      private: formBoolParam("include private repositories this user has access to (defaults to true)"),
      is_private: formBoolParam("show only pubic, private or all repositories (defaults to all)"),
      template: formBoolParam("include template repositories this user has access to (defaults to true)"),
      archived: formBoolParam("show only archived, non-archived or all repositories (defaults to all)"),
      mode: z
        .string()
        .optional()
        .openapi({
          description:
            'type of repository to search for. Supported values are "fork", "source", "mirror" and "collaborative"',
        }),
      exclusive: formBoolParam("if `uid` is given, search only for repos that the user owns"),
      sort: z
        .string()
        .optional()
        .openapi({
          description:
            'sort repos by attribute. Supported values are "alpha", "created", "updated", "size", "git_size", "lfs_size", "stars", "forks" and "id". Default is "alpha"',
        }),
      order: z
        .string()
        .optional()
        .openapi({
          description:
            'sort order, either "asc" (ascending) or "desc" (descending). Default is "asc", ignored if "sort" is not specified.',
        }),
      page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
      limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
    }),
  },
  responses: {
    200: {
      description: "SearchResults",
      content: { "application/json": { schema: searchResultsSchema } },
    },
    422: {
      description: "validationError",
      content: { "application/json": { schema: apiErrorSchema } },
    },
  },
  });
}

/**
 * `GET /repositories/{id}` — token REQUIRED upstream (`reqToken`,
 * SPEC-0004 §2.4): anonymous callers get the runtime 401 `token is required`
 * body exactly like `GET /user` (declared 401 stays out of this operation
 * because the vendored contract documents only 200/404 — the /user
 * RUNTIME_ONLY_RESPONSES exception pattern, orchestrator-owned table).
 * Created inside `registerRepoRoutes`: the declaration carries the
 * `requireAuth` middleware handed in by the router.
 */
function getRepoByIdRoute(requireAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
    method: "get",
    path: "/repositories/{id}",
    tags: ["repository"],
    summary: "Get a repository by id",
    operationId: "repoGetByID",
    middleware: [requireAuth],
    request: {
      params: z.object({
        id: z.string().min(1).openapi({ description: "id of the repo to get", format: "int64" }),
      }),
    },
    responses: {
      200: {
        description: "Repository",
        content: { "application/json": { schema: repositorySchema } },
      },
      404: notFoundResponse,
    },
  });
}

/**
 * `PATCH /repos/{owner}/{repo}` — upstream `reqToken + reqAdmin` (api.go:1245,
 * NO mustNotBeArchived on this PATCH), 200 → the edited Repository.
 * Declared responses: {200, 403, 404, 422}.
 */
function editRepoRoute(requireAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Edit a repository's properties. Only fields that are set will be changed.",
    operationId: "repoEdit",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo to edit" }),
        repo: z.string().min(1).openapi({ description: "name of the repo to edit" }),
      }),
      body: { content: { "application/json": { schema: editRepoOptionSchema } } },
    },
    responses: {
      200: {
        description: "Repository",
        content: { "application/json": { schema: repositorySchema } },
      },
      403: {
        description: "forbidden",
        content: { "application/json": { schema: apiErrorSchema } },
      },
      404: notFoundResponse,
      422: {
        description: "validationError",
        content: { "application/json": { schema: apiErrorSchema } },
      },
    },
  });
}

/**
 * `DELETE /repos/{owner}/{repo}` — upstream `reqToken + reqRepoDangerZone`
 * (api.go:1244), 204; the engine-backed storage purge rides the landed
 * §2.5.5 pipeline. Declared responses: {204, 403, 404}.
 */
function deleteRepoRoute(requireAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete a repository",
    operationId: "repoDelete",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo to delete" }),
        repo: z.string().min(1).openapi({ description: "name of the repo to delete" }),
      }),
    },
    responses: {
      204: { description: "empty" },
      403: {
        description: "forbidden",
        content: { "application/json": { schema: apiErrorSchema } },
      },
      404: notFoundResponse,
    },
  });
}

/**
 * `POST /repos/{owner}/{repo}/transfer` — upstream `reqToken +
 * reqRepoDangerZone` (api.go:1246–1249), **202 Accepted** with the
 * Repository (SPEC-0004 §2.4: async, pending transfer). Declared responses:
 * {202, 403, 404, 422}.
 */
const transferRepoRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/transfer",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Transfer a repo ownership",
    operationId: "repoTransfer",
    request: {
      params: z.object({
        owner: z.string().min(1).openapi({ description: "owner of the repo to transfer" }),
        repo: z.string().min(1).openapi({ description: "name of the repo to transfer" }),
      }),
      body: { content: { "application/json": { schema: transferRepoOptionSchema } } },
    },
    responses: {
      202: {
        description: "Repository",
        content: { "application/json": { schema: repositorySchema } },
      },
      403: {
        description: "forbidden",
        content: { "application/json": { schema: apiErrorSchema } },
      },
      404: notFoundResponse,
      422: {
        description: "validationError",
        content: { "application/json": { schema: apiErrorSchema } },
      },
    },
  });

/** Body bind hook: upstream's Go bind answers malformed bodies with 422. */
const repoBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** Throws the upstream 422 for `mode` values outside the contract enum. */
function validateSearchMode(raw: string): "fork" | "source" | "mirror" | "collaborative" | "" {
  switch (raw) {
    case "source":
    case "fork":
    case "mirror":
    case "collaborative":
    case "":
      return raw;
    default:
      // upstream: ctx.APIError(http.StatusUnprocessableEntity, "invalid search mode")
      throw new ApiError(422, "invalid search mode");
  }
}

/** Resolves the upstream `private` query param for a signed search:
 * `ctx.IsSigned && (FormString("private") == "" || FormBool("private"))`. */
function resolveIncludePrivate(viewer: Viewer, rawPrivate: string): boolean {
  return viewer.requester !== null && (rawPrivate === "" || formBoolValue(rawPrivate));
}

export function registerRepoRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(getRepoRoute(optionalAuth), async (c) => {
    const { owner, repo } = c.req.valid("param");
    const viewer = viewerOf(c);
    const found = await findRepositoryByPath(c.env.DB, owner, repo);
    if (found === null) {
      // Missing and invisible are the same 404 upstream (anti-enumeration).
      throw new ApiError(404, "not found");
    }
    // One grant resolution feeds both the visibility check and the embedded
    // permissions block (SPEC-0007 §3.5 — the resolved team grant admits a
    // team member and renders their AccessMode, like upstream ToRepo).
    const teamMode = await viewerTeamAccessMode(c.env.DB, viewer, found.repo);
    if (!canViewRepository(viewer, found.repo, teamMode)) {
      throw new ApiError(404, "not found");
    }
    // Single-repo renders overlay the stored repo-edit subset (PATCH→GET
    // round trip); list/search paths keep the defaults (the settings row is
    // the not-yet-swept column store — see toApiRepository).
    const settings = await loadRepoSettings(c.env.DB, found.repo.id);
    return c.json(toApiRepository(viewer, found, settings, teamMode), 200);
  });

  app.openapi(searchReposRoute(optionalAuth), async (c) => {
    const query = c.req.valid("query");
    const url = new URL(c.req.url);
    const viewer = viewerOf(c);
    const listOptions = parseListOptions(url);
    const mode = validateSearchMode(query.mode ?? "");
    const { items, total } = await searchRepositories(c.env.DB, viewer, {
      keyword: formTrim(url.searchParams, "q"),
      topicOnly: formBool(url.searchParams, "topic"),
      includeDesc: formBool(url.searchParams, "includeDesc"),
      uid: formInt64(url.searchParams, "uid"),
      exclusive: formBool(url.searchParams, "exclusive"),
      priorityOwnerId: formInt64(url.searchParams, "priority_owner_id"),
      teamId: formInt64(url.searchParams, "team_id"),
      starredBy: formInt64(url.searchParams, "starredBy"),
      includePrivate: resolveIncludePrivate(viewer, query.private ?? ""),
      isPrivate: query.is_private === undefined || query.is_private === "" ? null : formBool(url.searchParams, "is_private"),
      template: query.template === undefined || query.template === "" ? null : formBool(url.searchParams, "template"),
      archived: query.archived === undefined || query.archived === "" ? null : formBool(url.searchParams, "archived"),
      mode,
      sort: formString(url.searchParams, "sort"),
      order: formString(url.searchParams, "order"),
      page: listOptions.page,
      limit: listOptions.limit,
    });
    setPaginationHeaders(c, total, listOptions);
    return c.json({ ok: true, data: items.map((pair) => toApiRepository(viewer, pair)) }, 200);
  });

  app.openapi(getRepoByIdRoute(requireAuth), async (c) => {
    const { id } = c.req.valid("param");
    const viewer = viewerOf(c);
    const found = await findRepositoryById(c.env.DB, id);
    if (found === null) {
      throw new ApiError(404, "not found");
    }
    const teamMode = await viewerTeamAccessMode(c.env.DB, viewer, found.repo);
    if (!canViewRepository(viewer, found.repo, teamMode)) {
      throw new ApiError(404, "not found");
    }
    const settings = await loadRepoSettings(c.env.DB, found.repo.id);
    return c.json(toApiRepository(viewer, found, settings, teamMode), 200);
  });

  // -------------------------------------------------------------------------
  // PATCH /repos/{owner}/{repo} (repoEdit) — the meaningful-subset edit.
  // -------------------------------------------------------------------------
  app.openapi(
    editRepoRoute(requireAuth),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, found);
      // Upstream registers NO mustNotBeArchived on this PATCH (api.go:1245).
      const form = c.req.valid("json");
      // The engine deps ride the PATCH (REDEPLOY8's flagged tail — the delete
      // arm below threads the same registry): bare construction silently skips
      // rename's cell carry + syncRegistryMove, setVisibility's
      // setConfig(priv), and setDefaultBranch's setHead — D1 moves while the
      // engine keeps serving and indexing the old name/visibility/head. The
      // carry (registry-fix wave) moves the OLD name's cell content into the
      // NEW name's cell so the renamed URL serves the same git data
      // immediately (src/repos/carry.ts); setHead maps the RepoCell RPC's
      // SetHeadResult tag straight through (the production shape
      // repos/lifecycle.test.ts wires at the service seam).
      const service = new RepoService(c.env.DB, {
        registry: c.env.REGISTRY.getByName("registry"),
        setHead: async (name, branch) => (await c.env.REPO.getByName(name).setHead(branch)).tag,
        carry: (fromEngine, toEngine, storageKey) => carryRepoCell(c.env, fromEngine, toEngine, storageKey),
      });
      const now = new Date();

      // Name: rename only on a case-insensitive change (upstream
      // `!strings.EqualFold(lower_name, newName)`); invalid/reserved names
      // and collisions are the declared 422s (updateBasicProperties).
      if (form.name !== undefined && form.name.toLowerCase() !== found.repo.slug) {
        try {
          await service.rename(found.repo.id, form.name);
        } catch (error) {
          if (error instanceof RepoNameInvalidError || error instanceof RepoNameCollisionError) {
            throw new ApiError(422, error.message);
          }
          throw error;
        }
        // Webhook: repository renamed (upstream RenameRepository,
        // notifier.go:137-138 — changes.name.from carries the old name; the
        // payload's repository object renders the NEW row, like upstream's
        // convert.ToRepo(ctx, repo)).
        const renamed = await findRepositoryById(c.env.DB, found.repo.id);
        if (renamed !== null) {
          const identity = repositoryEventIdentity(viewerOf(c), renamed);
          await emitRepoEvent(c, {
            repoId: renamed.repo.id,
            ownerId: renamed.repo.ownerId,
            eventType: "repository",
            payload: repositoryEventPayload("renamed", identity.repository, identity.organization, c.get("authUser"), {
              changes: { name: { from: found.repo.slug } },
            }),
          });
        }
      }

      // Private flip (forks cannot exist yet — no base-repo sync needed).
      if (form.private !== undefined && form.private !== (found.repo.visibility === "private")) {
        await service.setVisibility(found.repo.id, form.private);
      }

      // Default branch: D1 value + the engine setHead best-effort (the
      // service logs, never throws). DEVIATION documented: upstream gates the
      // change on branch existence (an engine read) or an empty repo; ours
      // applies and lets the engine's own setHead guard reject unknown
      // branches engine-side while D1 keeps the metadata.
      if (form.default_branch !== undefined && form.default_branch !== found.repo.defaultBranch) {
        await service.setDefaultBranch(found.repo.id, form.default_branch);
      }

      // Archived flip (repositories.is_archived, SPEC-0003 §2.4 row 10).
      if (form.archived !== undefined && form.archived !== found.repo.isArchived) {
        await drizzle(c.env.DB)
          .update(repositories)
          .set({ isArchived: form.archived, updatedAt: now })
          .where(eq(repositories.id, found.repo.id));
      }

      // The stored settings subset: description/website + has_* unit flags.
      const settingsPatch: Partial<RepoSettings> = {};
      if (form.description !== undefined) settingsPatch.description = form.description;
      if (form.website !== undefined) settingsPatch.website = form.website;
      if (form.has_issues !== undefined) settingsPatch.hasIssues = form.has_issues;
      if (form.has_wiki !== undefined) settingsPatch.hasWiki = form.has_wiki;
      if (form.has_pull_requests !== undefined) settingsPatch.hasPullRequests = form.has_pull_requests;
      if (form.has_releases !== undefined) settingsPatch.hasReleases = form.has_releases;
      if (form.has_projects !== undefined) settingsPatch.hasProjects = form.has_projects;
      if (form.has_packages !== undefined) settingsPatch.hasPackages = form.has_packages;
      if (form.has_actions !== undefined) settingsPatch.hasActions = form.has_actions;
      if (Object.keys(settingsPatch).length > 0) {
        await saveRepoSettings(c.env.DB, found.repo.id, settingsPatch, now);
      }

      // Re-render through the same converter as GET (the rename may have
      // moved the row's slug; the settings read picks up this PATCH's write).
      const fresh = await findRepositoryByPath(
        c.env.DB,
        found.repo.ownerNamespace,
        form.name !== undefined ? form.name.toLowerCase() : found.repo.slug,
      );
      if (fresh === null) {
        throw new ApiError(404, "not found"); // unreachable: the row survived the edit
      }
      const settings = await loadRepoSettings(c.env.DB, found.repo.id);
      const viewer = viewerOf(c);
      return c.json(toApiRepository(viewer, fresh, settings), 200);
    },
    repoBodyHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo} (repoDelete) — the landed §2.5.5 pipeline.
  // -------------------------------------------------------------------------
  app.openapi(deleteRepoRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    await requireRepoDangerZone(c, found);
    // Housekeeping for this batch's raw-D1 stores FIRST (the repos service's
    // cascade cannot see them until the migration owner's sweep lands —
    // services/repo-*.ts document the gap).
    await Promise.all([
      deleteRepoTopics(c.env.DB, found.repo.id),
      deleteRepoWatchers(c.env.DB, found.repo.id),
      deleteRepoCollaborators(c.env.DB, found.repo.id),
      deleteRepoSettings(c.env.DB, found.repo.id),
    ]);
    // Then the landed pipeline: D1 cascade → DO tombstone → queue purge.
    await new RepoService(c.env.DB, {
      registry: c.env.REGISTRY.getByName("registry"),
      queue: c.env.REPO_TASKS,
      tombstone: (engineName) => tombstoneRepoDO(c.env, engineName),
    }).deleteRepository(found.repo.id);
    // Webhook: repository deleted (upstream DeleteRepository,
    // notifier.go:126-127). DEVIATION (documented): upstream triggers BEFORE
    // its cascade ("we need to trigger them before deleting it…",
    // services/repository/repository.go:69-70) because its queued hook tasks
    // outlive the hook rows; our delivery rows ARE the source of truth and
    // the landed §2.5.5 cascade deletes webhook_deliveries with the repo —
    // so this fan-out runs AFTER the pipeline and the deleted repo's OWN
    // hooks (already cascaded) never hear the event, while owner-level and
    // system hooks still do.
    const identity = repositoryEventIdentity(viewerOf(c), found);
    await emitRepoEvent(c, {
      repoId: found.repo.id,
      ownerId: found.repo.ownerId,
      eventType: "repository",
      payload: repositoryEventPayload("deleted", identity.repository, identity.organization, c.get("authUser")),
    });
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/transfer (repoTransfer) — 202 + pending row.
  // -------------------------------------------------------------------------
  app.openapi(
    transferRepoRoute(requireAuth),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoDangerZone(c, found);
      const form = c.req.valid("json");

      // The new owner must exist: upstream answers the anti-enumeration 404
      // message for missing (and invisible org) targets (transfer.go:60–73).
      const target = await findUserByName(c.env.DB, form.new_owner);
      if (target === null) {
        throw new ApiError(404, "The new owner does not exist or cannot be found");
      }
      // Teams land with SPEC-0007 — every id misses, in upstream's message
      // shape (transfer.go:96–99; the non-org check fires first upstream,
      // but with zero teams both reduce to the same 422).
      if (form.team_ids !== undefined && form.team_ids.length > 0) {
        throw new ApiError(422, `team ${form.team_ids[0]} not found`);
      }

      // StartRepositoryTransfer's blocked arm (services/repository/transfer.go:
      // 464-466 via repoTransfer's `errors.Is(err, user_model.ErrBlockedUser)`
      // → 403 `err.Error()`, transfer.go:118): past the doer-admin and
      // self-transfer direct arms, a doer blocked by the NEW owner — or a new
      // owner blocked by the CURRENT owner — refuses. Upstream runs the probe
      // inside StartRepositoryTransfer after `doer.IsAdmin || doer.ID ==
      // newOwner.ID` short-circuits to a direct transfer; the route carries
      // the equivalent ordering here (repos/service.ts is outside this
      // file's ownership): the site-admin doer bypasses (upstream's
      // IsAdmin direct arm), and a self-"transfer" keeps the landed
      // OwnerNotAssignableError 422 below (upstream's direct arm would
      // transfer back silently — the landed 202-handler divergence stands),
      // so neither reaches the probe, exactly like upstream.
      const requester = c.get("authUser");
      const doerIsAdmin = requester.is_admin === true;
      if (!doerIsAdmin && found.repo.ownerId !== target.id) {
        const doerBlockedByNewOwner = await isUserBlockedBy(
          c.env.DB,
          { id: requester.id ?? 0, isAdmin: doerIsAdmin },
          target.id,
        );
        const newOwnerBlockedByCurrent = await isUserBlockedBy(
          c.env.DB,
          { id: target.id, isAdmin: target.isAdmin },
          found.repo.ownerId ?? -1,
        );
        if (doerBlockedByNewOwner || newOwnerBlockedByCurrent) {
          throw new ApiError(403, BLOCKED_USER_MESSAGE);
        }
      }

      try {
        await new RepoService(c.env.DB).requestTransfer(found.repo.id, requester.id ?? 0, target.id);
      } catch (error) {
        if (error instanceof OwnerNotAssignableError) {
          // Self-transfer and inactive targets: the declared 422 family.
          throw new ApiError(422, error.message);
        }
        throw error;
      }

      // 202 + the CURRENT Repository — the transfer is pending, not applied
      // (SPEC-0004 §2.4; acceptance is the tier-2 transfer/accept surface).
      // No webhook: upstream fires none for transfers — its webhookNotifier
      // inherits NullNotifier's no-op TransferRepository, and HookRepoAction
      // has no transfer member (modules/structs/hook.go:557-562).
      const viewer = viewerOf(c);
      const settings = await loadRepoSettings(c.env.DB, found.repo.id);
      return c.json(toApiRepository(viewer, found, settings), 202);
    },
    repoBodyHook,
  );
}
