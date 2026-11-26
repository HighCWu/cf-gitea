import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import {
  classifyRepoNameReject,
  RepoNameCollisionError,
  RepoNameInvalidError,
  RepoObjectFormatUnsupportedError,
} from "../../repos/service";
import { assertDemoRepoQuota, DemoRepoQuotaError } from "../../services/demo-quota";
import { emitRepoEvent, repositoryEventIdentity, repositoryEventPayload } from "../../services/repo-events";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { createRepoOptionSchema, repositoryListSchema, repositorySchema } from "../models/repository";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { toCreatedOrgRepository } from "../services/org-repos";
import {
  findRepositoryById,
  findUserByName,
  listOwnedRepositories,
  listUserRepositories,
  toApiRepository,
  viewerOf,
} from "../services/repository";
import { loadRepoSettings } from "../services/repo-settings";
import { createUserRepository, findDoerRow, resolveAutoInitReadme } from "../services/user-repos";

/**
 * Tier-1 `user`-tagged repository routes (SPEC-0004 §2.4 rows:
 * `GET /users/{username}/repos` (userListRepos), `GET /user/repos`
 * (userCurrentListRepos) and `POST /user/repos` (createCurrentUserRepo)). The
 * two lists send the runtime list headers upstream sends on every list
 * (`X-Total-Count`, `Link`).
 */

const notFoundResponse = {
  description: "notFound",
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

const listQuerySchema = {
  query: z.object({
    page: z
      .string()
      .optional()
      .openapi({ type: "integer", description: "page number of results to return (1-based)" }),
    limit: z
      .string()
      .optional()
      .openapi({ type: "integer", description: "page size of results" }),
  }),
} as const;

// ---------------------------------------------------------------------------
// The create-arm name-reject wire texts (SMALLS6 open #1 — the split-text
// adoption over repos/service.ts's classifyRepoNameReject). Shared by the
// four create arms (this file, org-repos.ts, admin-t2.ts,
// admin-org-extras.ts — the route→route import precedent).
// ---------------------------------------------------------------------------

/** Upstream `reservedRepoNamePatterns` (models/repo/repo.go:74) — the suffix
 *  half the pattern-class render needs. Mirrors repos/service.ts's
 *  RESERVED_REPO_NAME_SUFFIXES table (that module is the classifier's home;
 *  the classifier returns only the class, not the matched entry). */
const REPO_NAME_PATTERN_SUFFIXES = [".wiki", ".git", ".rss", ".atom"];

/**
 * The upstream EXACT per-class text for a refused repository name, rendered
 * from the classifier's verdict (the create arms keep the 400 — the
 * ROUTESWAP b3422c0920 ladder; only the text splits now):
 *
 *   - `chars` → ErrNameCharsNotAllowed "name is invalid [%s]: must be valid
 *     alpha or numeric or dash(-_) or dot characters" (models/db/name.go:
 *     58-66 via the IsUsableRepoName first leg, models/repo/repo.go:82-86;
 *     %s is the RAW name — upstream passes repo.Name untrimmed).
 *   - `reserved` → ErrNameReserved "name is reserved [name: %s]"
 *     (models/db/name.go:24-26; upstream renders the TrimSpace+ToLower'd
 *     name, db/name.go:78 — our reachable reserved set {".", "..", "-"} is
 *     case-free, so the raw name IS the rendered one).
 *   - `pattern` → ErrNamePatternNotAllowed "name pattern is not allowed
 *     [pattern: %s]" (models/db/name.go:48-50; %s is the TABLE pattern —
 *     `*${suffix}` — matched case-insensitively on the LOWERED name,
 *     db/name.go:88-93, so "HELD.WIKI" renders `*.wiki`).
 *   - `engine` → our recorded EXTRA (the engine-routability alphabet,
 *     SPEC-0003 §4.4) has no upstream text — it keeps the conflated port
 *     message RepoNameInvalidError renders (the recorded divergence).
 */
export function repoNameRejectMessage(name: string): string {
  switch (classifyRepoNameReject(name)) {
    case "chars":
      return `name is invalid [${name}]: must be valid alpha or numeric or dash(-_) or dot characters`;
    case "reserved":
      return `name is reserved [name: ${name}]`;
    case "pattern": {
      const suffix = REPO_NAME_PATTERN_SUFFIXES.find((entry) => name.toLowerCase().endsWith(entry));
      return `name pattern is not allowed [pattern: *${suffix ?? ""}]`;
    }
    default:
      // "engine" (our extra) — the conflated port message.
      return `repository name is not allowed: ${name}`;
  }
}

/**
 * `GET /users/{username}/repos` — public repositories of the user (all of
 * them when the token resolves to the user themself or a site admin); 404
 * when the user does not exist. Token optional (upstream Contexter resolves
 * `ctx.Doer` on every route — visibility widens for the owner/admin).
 */
function userListReposRoute(optionalAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
    method: "get",
    path: "/users/{username}/repos",
    tags: ["user"],
    summary: "List the repos owned by the given user",
    operationId: "userListRepos",
    middleware: [optionalAuth],
    request: {
      ...listQuerySchema,
      params: z.object({
        username: z
          .string()
          .min(1)
          .openapi({ description: "username of the user whose owned repos are to be listed" }),
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
}

/**
 * `GET /user/repos` — requires a signed-in caller (upstream `reqToken`);
 * anonymous callers get the runtime 401 `token is required` body exactly
 * like `GET /user` (not declared here: the vendored contract documents only
 * 200 — /user's RUNTIME_ONLY_RESPONSES exception pattern, orchestrator-owned
 * table). Created inside `registerUserReposRoutes`: the declaration carries
 * the `requireAuth` middleware handed in by the router.
 */
function userCurrentListReposRoute(requireAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
    method: "get",
    path: "/user/repos",
    tags: ["user"],
    summary: "List the repos that the authenticated user owns",
    operationId: "userCurrentListRepos",
    middleware: [requireAuth],
    request: listQuerySchema,
    responses: {
      200: {
        description: "RepositoryList",
        content: { "application/json": { schema: repositoryListSchema } },
      },
    },
  });
}

/**
 * `POST /user/repos` — 201 + the Repository at owner permissions
 * (createCurrentUserRepo → upstream repo.Create). Upstream wires the route
 * `rejectPublicOnly()` inside the reqToken'd /user group (api.go:1181) — a
 * signed-in caller is required (anonymous → the runtime 401 `token is
 * required` body, the /user RUNTIME_ONLY class; not declared: the vendored
 * contract declares only {201, 400, 409, 422}). Guard order mirrors
 * CreateUserRepo: unknown readme template → 400; duplicate name → 409 with
 * ErrRepoAlreadyExist.Error() "repository already exists [owner: %s, repo:
 * %s]" (the b3422c0920 APIErrorAuto ladder, update.go:79-81 — was the
 * pre-repin "The repository with the same name already exists.");
 * invalid/reserved name → 400 (ErrNameReserved/ErrNamePatternNotAllowed
 * unwrap util.ErrInvalidArgument, db/name.go:31-33/:55-57 — was the
 * pre-repin 422; the wire text is upstream's exact per-class string via
 * repoNameRejectMessage below — the split-text adoption). `auto_init` lands
 * the initial commit through the engine
 * (services/user-repos.ts owns the fidelity notes and divergences); an
 * unknown `gitignores`/`license` template name → the init-failure 500 with
 * the row rolled back (create.go:236-241,448-456 via the unmapped-error arm
 * repo.go:254-259; undeclared — the checker's default-fold equivalence
 * carries it against the contract's folded {201, default} doc, the
 * SPLITTEXT RUNTIME_ONLY prune).
 */
function createCurrentUserRepoRoute(requireAuth: MiddlewareHandler<ApiEnv>) {
  return createRoute({
    method: "post",
    path: "/user/repos",
    tags: ["user"],
    summary: "Create a repository",
    operationId: "createCurrentUserRepo",
    middleware: [requireAuth],
    request: {
      body: { content: { "application/json": { schema: createRepoOptionSchema } } },
    },
    responses: {
      201: { description: "Repository", content: { "application/json": { schema: repositorySchema } } },
      400: errorResponse,
      409: { description: "The repository with the same name already exists." },
      422: validationErrorResponse,
    },
  });
}

export function registerUserReposRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(userListReposRoute(optionalAuth), async (c) => {
    const { username } = c.req.valid("param");
    const viewer = viewerOf(c);
    const user = await findUserByName(c.env.DB, username);
    if (user === null) {
      throw new ApiError(404, "not found");
    }
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listUserRepositories(c.env.DB, user.usernameLower, viewer, listOptions);
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map((pair) => toApiRepository(viewer, pair)), 200);
  });

  app.openapi(userCurrentListReposRoute(requireAuth), async (c) => {
    const viewer = viewerOf(c);
    const listOptions = parseListOptions(new URL(c.req.url));
    const { items, total } = await listOwnedRepositories(c.env.DB, viewer, listOptions);
    setPaginationHeaders(c, total, listOptions);
    return c.json(items.map((pair) => toApiRepository(viewer, pair)), 200);
  });

  app.openapi(createCurrentUserRepoRoute(requireAuth), async (c) => {
    const doer = c.get("authUser");
    const form = c.req.valid("json");
    // 400 arm first (upstream CreateUserRepo validates the readme template
    // before touching the database).
    resolveAutoInitReadme(form);
    const owner = await findDoerRow(c.env.DB, doer);
    if (owner === null) {
      throw new ApiError(401, "token is required");
    }
    // SPEC-0014 §4.3 — the gated demo repo-count quota (M2): upstream rides
    // the limit check inside the create service (doer.CanCreateRepoIn,
    // user.go:285-295 — the admin doer bypass included — refusing with
    // ErrReachLimitOfRepo); cf-gitea's check rides THIS route (the create
    // call site the SPEC names) because RepoService carries no env, and the
    // owner row IS the doer row here. Gate off → zero reads, zero checks
    // (the §2 invariant). Upstream maps the limit refusal through its
    // ErrPermissionDenied unwrap to 403 + err.Error()
    // (routers/api/v1/repo/repo.go:256-258) — the exact status + message
    // below.
    try {
      await assertDemoRepoQuota(c.env, c.env.DB, owner, owner.id);
    } catch (error) {
      if (error instanceof DemoRepoQuotaError) {
        throw new ApiError(403, error.message);
      }
      throw error;
    }
    let repo;
    try {
      repo = await createUserRepository(c.env.DB, c.env, owner, form, new Date());
    } catch (error) {
      if (error instanceof RepoNameCollisionError) {
        // RE-PIN (099abf5db4, b3422c0920): upstream's create arm maps every
        // error through ctx.APIErrorAuto (repo.go:249-259) — the collision
        // unwraps util.ErrAlreadyExist → 409 with the TOP error's text,
        // ErrRepoAlreadyExist.Error() "repository already exists [owner: %s,
        // repo: %s]" (models/repo/update.go:79-81; upstream throws
        // {u.LowerName, name} — our fields are the same lowercased pair).
        throw new ApiError(409, `repository already exists [owner: ${error.ownerNamespace}, repo: ${error.repoName}]`);
      }
      if (error instanceof RepoNameInvalidError) {
        // RE-PIN (099abf5db4, b3422c0920): reserved/pattern violations unwrap
        // util.ErrInvalidArgument (models/db/name.go:31-33/:55-57) →
        // APIErrorAuto 400 on CREATE (was the pre-repin 422; the PATCH
        // rename arm keeps its explicit 422, repo.go:618-627 — not this
        // route). SPLIT-TEXT ADOPTION (SMALLS6 open #1): the wire text is
        // now upstream's EXACT per-class string via the classifier —
        // "name is invalid [name]: must be valid …" (chars) / "name is
        // reserved [name: %s]" / "name pattern is not allowed
        // [pattern: %s]" (repoNameRejectMessage above; the engine extra
        // keeps the conflated port message).
        throw new ApiError(400, repoNameRejectMessage(error.repoName));
      }
      if (error instanceof RepoObjectFormatUnsupportedError) {
        // The engine is sha1-only (SPEC-0001 §5): a sha256 create is refused
        // with upstream's exact Error() text (create.go:225) under the
        // contract-declared 422 (upstream's own runtime arm for this class
        // is the 500-internal family — the recorded B-24 divergence note).
        throw new ApiError(422, error.message);
      }
      throw error;
    }
    const viewer = viewerOf(c);
    // Webhook: repository created (upstream CreateRepository,
    // notifier.go:114-116 — Sender is the creating doer, Organization the
    // owner user). Emitted after the create committed; a webhook failure is
    // caught inside the fan-out and never fails the 201.
    const created = await findRepositoryById(c.env.DB, repo.id);
    if (created !== null) {
      const identity = repositoryEventIdentity(viewer, created);
      await emitRepoEvent(c, {
        repoId: created.repo.id,
        ownerId: created.repo.ownerId,
        eventType: "repository",
        payload: repositoryEventPayload("created", identity.repository, identity.organization, doer),
      });
    }
    // The CreateUserRepo tail: `convert.ToRepo(ctx, repo, Permission{
    // AccessModeOwner})` — the creator's embedded permissions block is the
    // full owner triple (services/org-repos.ts toCreatedOrgRepository).
    // Upstream reloads the row "to get a real state after creation"
    // (repo.go:270-274) so the 201 carries the sent description; the settings
    // read is our equivalent reload (the sweep keeps description in the
    // repo_settings side table — the create service wrote it above). Without
    // it the 201 rendered the empty default and dropped the field (F6).
    const settings = await loadRepoSettings(c.env.DB, repo.id);
    return c.json(toCreatedOrgRepository(viewer, { repo, owner }, settings), 201);
  });
}
