import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import {
  canViewRepositoryWithTeams,
  findRepositoryByPath,
  findRepositoryById,
  repositoryPermissions,
  viewerOf,
  type RepositoryWithOwner,
} from "../services/repository";
import { toCreatedOrgRepository } from "../services/org-repos";
import { findDoerRow } from "../services/user-repos";
import {
  getMirrorStatus,
  registerMirror,
  MirrorConflictError,
  MirrorCredentialKeyError,
  MirrorValidationError,
} from "../services/mirror";
import { migrateRepository, resolveMigrateOwner } from "../../services/migrate";
import { emitRepoEvent, repositoryEventIdentity, repositoryEventPayload } from "../../services/repo-events";
import { repositorySchema } from "../models/repository";

/**
 * Mirror/migrate routes (SPEC-0009 §2.2/§2.3 — the HTTP surface over the sync
 * service). Two shapes share this module:
 *
 *  - THE CONTRACT PATH, POST /repos/migrate (upstream operationId
 *    repoMigrate, frozen-contract responses {201,403,409,422}) — the
 *    SERVER-DRIVEN arm: it CREATES the target repository (services/migrate.ts,
 *    SPEC-0009 §2.2) and drives the right channel (mirror attach +
 *    mirror-sync enqueue for mirror=true; the chunked-import bootstrap
 *    otherwise), settling ready via each channel's own settle. DECLARED via
 *    app.openapi (it has an upstream path key, so it enters the generated
 *    OpenAPI document and scripts/check-openapi.mjs guards its response
 *    subset — unlike the repo-scoped family below).
 *
 *  - THE REPO-SCOPED FAMILY — mostly NON-CONTRACT, plain Hono, exactly like
 *    the imports family: these paths were OUTSIDE the frozen SPEC-0004 swagger
 *    inventory when they landed (the into-empty attach has no upstream path
 *    key), so they must NOT enter the generated OpenAPI document and must stay
 *    engine-free in the route module graph (scripts/check-openapi.mjs bundles
 *    src/api/openapi.ts — see api/services/mirror.ts for the boundary note).
 *    EXCEPTION: POST /repos/{owner}/{repo}/mirror-sync IS a contract path
 *    (upstream repoMirrorSync) and is DECLARED below (converted in place by
 *    the wave-api-tokens-times-aggregates batch; behavior unchanged).
 *
 *    POST /repos/{owner}/{repo}/migrate       attach a pull mirror to an
 *                                             EXISTING EMPTY repo: validate
 *                                             per upstream MigrateRepoOption,
 *                                             register the repo_mirrors row
 *                                             (sanitized URL, §4.2-encrypted
 *                                             credentials), kick one
 *                                             mirror-sync message → 202
 *    GET  /repos/{owner}/{repo}/mirror        the sync_state row (status/
 *                                             schedule/last_error; never
 *                                             credentials) → 200
 *    POST /repos/{owner}/{repo}/mirror-sync   force a sync now: enqueue →
 *                                             200 empty (upstream
 *                                             AddPullMirrorToQueue shape,
 *                                             routers/api/v1/repo/mirror.go
 *                                             :29-77)
 *
 * The message is `{kind: "mirror-sync", repoId}` on MIRROR_SYNC_QUEUE — the
 * literal shape of sync.ts's MirrorSyncMessage (inlined so the route graph
 * stays engine-free, the same discipline as imports.ts's
 * `{kind: "import-abort"}`); the consumer CAS re-guards every state, so a
 * racing cron/duplicate message is a harmless `skipped: "busy"`.
 *
 * Handlers stay thin (AGENTS.md): parse → authorize → service → respond.
 */

/** The migrate body is a small JSON document; reject oversized ones before
 *  buffering (the imports manifest cap pattern, SPEC-0003 §2.6 limits). */
const MIGRATE_BODY_MAX_BYTES = 64 * 1024;

/**
 * Upstream `MigrateRepoOption` (modules/structs/repo.go:419-450), field
 * names verbatim. Accepted-but-ignored here (the target repo IS the path):
 * repo_owner/uid/repo_name/private/description. Semantics live in
 * api/services/mirror.ts (422/409 families per SPEC-0009 §2.2).
 */
const migrateOptionsSchema = z.object({
  clone_addr: z.string().min(1),
  service: z.string().optional(),
  auth_username: z.string().optional(),
  auth_password: z.string().optional(),
  auth_token: z.string().optional(),
  mirror: z.boolean().optional(),
  lfs: z.boolean().optional(),
  lfs_endpoint: z.string().optional(),
  private: z.boolean().optional(),
  description: z.string().optional(),
  wiki: z.boolean().optional(),
  issues: z.boolean().optional(),
  milestones: z.boolean().optional(),
  labels: z.boolean().optional(),
  pull_requests: z.boolean().optional(),
  releases: z.boolean().optional(),
  mirror_interval: z.string().optional(),
  repo_owner: z.string().optional(),
  uid: z.number().optional(),
  repo_name: z.string().optional(),
});

/**
 * The CONTRACT path's body: upstream `MigrateRepoOptions` binds clone_addr
 * and repo_name Required (modules/structs/repo.go:419-450 — Go Required is
 * non-empty, so min(1), not merely present) — the same shape as the
 * into-empty schema above, with those two tightened.
 */
const migrateRepoMigrateSchema = migrateOptionsSchema.extend({
  clone_addr: z.string().min(1),
  repo_name: z.string().min(1),
});

/** Owner-or-admin gate (the imports family's requireAdminRepo): managing a
 *  repo's source URL and credentials is an owner operation; invisible repos
 *  are the 404 anti-enumeration. */
async function requireAdminRepo(c: Context<ApiEnv>, owner: string, repo: string): Promise<RepositoryWithOwner> {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, owner, repo);
  if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) throw new ApiError(404, "not found");
  if (!repositoryPermissions(viewer, found.repo).admin) {
    throw new ApiError(403, "only the repository owner or a site admin can manage the mirror");
  }
  return found;
}

/** Service error family → upstream status codes (§2.2 table): validation
 *  422, target conflicts 409, unconfigured-KEK 500. Unknown errors rethrow
 *  into the global handler's 500. Use as `.catch(toApiError)`. */
function toApiError(error: unknown): never {
  if (error instanceof MirrorValidationError) throw new ApiError(422, error.message);
  if (error instanceof MirrorConflictError) throw new ApiError(409, error.message);
  if (error instanceof MirrorCredentialKeyError) throw new ApiError(500, error.message);
  throw error;
}

export function registerMirrorRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // POST /repos/migrate — THE CONTRACT PATH (upstream repoMigrate, responses
  // {201,403,409,422}): the SERVER-DRIVEN migrate (SPEC-0009 §2.2). The route
  // creates the repository itself (services/migrate.ts) and drives the right
  // channel — mirror attach + one mirror-sync enqueue for mirror=true (the
  // initial population is that first sync), the chunked-import bootstrap
  // otherwise (the body's `import` extension carries the one-time token the
  // caller uploads chunks with; a documented divergence field, Gitea clients
  // ignore unknown JSON members). 201 renders the born repo — upstream's API
  // arm blocks and returns the completed repo; ours returns the migrating
  // one (§2.2's documented async divergence), status='migrating' on the
  // import arm, ready+empty on the mirror arm (the sync's population settle
  // flips is_empty; mirrors never leave ready).
  //
  // THE SINGLE BIRTH EMISSION (the f5406c3 audit): the repositories INSERT
  // inside migrateRepository is the birth, created silently (RepoService —
  // not createUserRepository, so no create-route emission fires underneath);
  // THIS handler's post-service emit is the arm's finalize step and owns the
  // one `repository` action=created — in-request, exactly like upstream's
  // synchronous API arm (migrate.go:188-214 fires the notifier in-request);
  // no settle site emits a birth (imports.test.ts's silence guard, sync.ts's
  // push-family-only fan-out), so the per-migration count is exactly one.
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/migrate",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Migrate a remote git repository",
      operationId: "repoMigrate",
      request: {
        body: { content: { "application/json": { schema: migrateRepoMigrateSchema } } },
      },
      responses: {
        201: { description: "Repository", content: { "application/json": { schema: repositorySchema } } },
        403: { description: "forbidden", content: { "application/json": { schema: apiErrorSchema } } },
        409: { description: "The repository with the same name already exists." },
        422: { description: "validationError", content: { "application/json": { schema: apiErrorSchema } } },
      },
    }),
    async (c) => {
      const options = c.req.valid("json");
      const doer = c.get("authUser");
      const doerRow = await findDoerRow(c.env.DB, doer);
      if (doerRow === null) throw new ApiError(401, "token is required");
      const owner = await resolveMigrateOwner(c.env.DB, { id: doerRow.id, isAdmin: doerRow.isAdmin }, options);
      const outcome = await migrateRepository(c.env.DB, c.env, owner, options, new Date()).catch(toApiError);

      const viewer = viewerOf(c);
      const pair = await findRepositoryById(c.env.DB, outcome.repo.id);
      if (pair !== null) {
        // Webhook: repository created — the arm's ONE birth emission (see the
        // block comment; upstream CreateRepository-notifier parity with the
        // migration's created repo, Sender the migrating doer, Organization
        // the owner row). Failures are caught inside the fan-out.
        const identity = repositoryEventIdentity(viewer, pair);
        await emitRepoEvent(c, {
          repoId: pair.repo.id,
          ownerId: pair.repo.ownerId,
          eventType: "repository",
          payload: repositoryEventPayload("created", identity.repository, identity.organization, doer),
        });
      }

      const body = toCreatedOrgRepository(viewer, { repo: outcome.repo, owner });
      // The import arm's bootstrap rides as the documented extension field —
      // the declared schema stays the contract's Repository.
      return c.json(
        outcome.importBootstrap === null ? body : { ...body, import: outcome.importBootstrap },
        201,
      );
    },
    // upstream's Go bind answers malformed bodies with 422 (bodyBind422).
    ({ success }: { success: boolean }): undefined => {
      if (!success) throw new ApiError(422, "invalid migrate options: malformed body");
      return undefined;
    },
  );

  // POST — migrate INTO an existing empty repo (§2.2's into-empty shape of
  // upstream POST /repos/migrate): mirror=true registers the pull mirror and
  // 202s with the mirror status; the initial population is the enqueued
  // mirror-sync (a delta sync against an empty repo fetches every advertised
  // tip — sync.ts handles old = ZERO_OID creates). The credential half runs
  // in the service: https-only + egress-gated URL, §4.2 AES-GCM envelope.
  app.post("/repos/:owner/:repo/migrate", requireAuth, async (c) => {
    const { owner, repo } = c.req.param();
    const found = await requireAdminRepo(c, owner, repo);

    const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isInteger(declared) && declared > MIGRATE_BODY_MAX_BYTES) {
      throw new ApiError(413, `migrate options exceed the ${MIGRATE_BODY_MAX_BYTES} byte cap`);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, "migrate options must be a JSON object");
    }
    const parsed = migrateOptionsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(422, `invalid migrate options: ${parsed.error.issues[0]?.message ?? "malformed"}`);
    }

    const status = await registerMirror(c.env.DB, c.env, found.repo, parsed.data).catch(toApiError);

    // Kick the initial sync (§2.6 — the enqueue is best-effort: the row is
    // registered due at now, so a failed send self-heals at the next cron
    // tick; the consumer re-checks every state on its own).
    const queue = c.env.MIRROR_SYNC_QUEUE;
    if (queue) {
      try {
        await queue.send({ kind: "mirror-sync", repoId: found.repo.id });
      } catch (error) {
        console.error(
          `[mirror] sync enqueue failed for ${found.repo.ownerNamespace}/${found.repo.slug}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return c.json(status, 202);
  });

  // GET — the sync_state row (schedule, last sync, sanitized last error).
  // Owner-or-admin like the imports status read: operational detail, and
  // last_error/remote_address are not part of the public repo JSON.
  app.get("/repos/:owner/:repo/mirror", requireAuth, async (c) => {
    const { owner, repo } = c.req.param();
    const found = await requireAdminRepo(c, owner, repo);
    const status = await getMirrorStatus(c.env.DB, found.repo.id);
    if (status === null) throw new ApiError(404, "repository has no mirror");
    return c.json(status, 200);
  });

  // POST — force a sync now (§2.3): token + code-write (upstream
  // reqRepoWriter(unit.TypeCode), api.go:1430; until collaborator tables
  // land, repositoryPermissions.push is owner/admin only), non-archived,
  // and a mirror row — upstream's exact `400 "Repository is not a mirror"`
  // otherwise (repo/mirror.go:29-77). 200 with an EMPTY body on enqueue,
  // like upstream; the sync itself runs on the queue consumer.
  //
  // DECLARED (upstream repoMirrorSync, responses {200,403,404} — the
  // api-remaining-inventory batch wave-api-tokens-times-aggregates converted
  // this plain route in place; behavior unchanged): the served 400/409 arms
  // stay RUNTIME-ONLY-UNDECLARED per the landed convention (the contract
  // documents neither "Repository is not a mirror" nor the archived 409).
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/mirror-sync",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Sync a mirrored repository",
      operationId: "repoMirrorSync",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
        }),
      },
      responses: {
        200: { description: "empty" },
        403: { description: "forbidden", content: { "application/json": { schema: apiErrorSchema } } },
        404: { description: "notFound", content: { "application/json": { schema: apiErrorSchema } } },
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      const viewer = viewerOf(c);
      const found = await findRepositoryByPath(c.env.DB, owner, repo);
      if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) throw new ApiError(404, "not found");
      if (!repositoryPermissions(viewer, found.repo).push) {
        throw new ApiError(403, "mirror sync requires write access to the repository");
      }
      if (found.repo.isArchived) {
        throw new ApiError(409, "repository is archived");
      }
      if (!(await getMirrorStatus(c.env.DB, found.repo.id))) {
        throw new ApiError(400, "Repository is not a mirror");
      }
      const queue = c.env.MIRROR_SYNC_QUEUE;
      if (!queue) throw new ApiError(500, "MIRROR_SYNC_QUEUE binding missing");
      await queue.send({ kind: "mirror-sync", repoId: found.repo.id });
      return c.body(null, 200);
    },
  );
}
