/**
 * Server-driven migrate (SPEC-0009 §2.2/§2.6) — the orchestration behind the
 * upstream contract path POST /repos/migrate (routers/api/v1/repo/migrate.go,
 * operationId repoMigrate): this arm CREATES the target repository row and
 * then drives the landed channel for the requested shape,
 *
 *   mirror=true  → registerMirror (api/services/mirror.ts — the §2.2 attach:
 *                  is_mirror + sanitized original_url CAS, the 1:1
 *                  `repo_mirrors` row due immediately, the §4.2 credential
 *                  envelope) + one best-effort mirror-sync enqueue. The
 *                  initial population IS that first sync: the sync consumer's
 *                  population settle (services/mirror/sync.ts) flips
 *                  `is_empty` when the fetch lands — mirrors never leave
 *                  `status='ready'` (sync.ts's settle writes no status).
 *   mirror=false → ImportService.create (repos/imports/service.ts — the
 *                  SPEC-0003 §2.6 channel: one batch flips the repo to
 *                  `status='migrating'` + inserts the `repo_imports` row) and
 *                  the chunked upload is the caller's to drive (the route
 *                  hands back the one-time import token bootstrap); the
 *                  channel's own settle (repos/imports/pipeline.ts
 *                  finalizeImport → settleDone) flips the repo `ready`.
 *
 * This is the surface the repo-scoped POST /repos/{owner}/{repo}/migrate
 * (routes/mirror.ts, the into-empty attach) deliberately is not: upstream's
 * migrate lives at the GLOBAL path and creates the target itself, so the
 * create-shaped fields (repo_owner/uid, repo_name, private, description) are
 * SEMANTIC here, not accepted-and-ignored.
 *
 * BIRTH + THE SINGLE EMISSION (the f5406c3 webhook-audit finding): the
 * `repositories` INSERT is the birth, made through RepoService.create —
 * never createUserRepository, so no user-repos-style emission fires
 * underneath and RepoService itself is silent. The ONE `repository`
 * action=created webhook is emitted by the route's finalize step
 * (routes/mirror.ts) after this service commits and arms the channel —
 * in-request, exactly like upstream's API arm, whose notifier fires inside
 * the request (migrate.go:188-214 → notify_service.MigrateRepository); our
 * DATA population completes later on the queue, which is the §2.2 documented
 * async divergence. No settle site emits a birth (imports.test.ts's
 * silence-guard + sync.ts only fan push-family events), so the count per
 * migrated repo is exactly one.
 *
 * RESTRICTED SHAPE (§2.2): https-only + egress-gated clone_addr
 * (checkMirrorSourceUrl — userinfo URLs rejected so credentials can never
 * leak into logs or original_url), `service` unset or "git" (the family's
 * documented stricter-than-upstream rule — upstream falls back to the
 * plain-git downloader), metadata flags zeroed for mirror=true (upstream
 * migrate.go:159-166) and 422 when true with mirror=false, mirror_interval
 * through the Go-duration floor (§2.2 row 6).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../api/errors";
import {
  checkMirrorSourceUrl,
  deriveMirrorAuthHeader,
  MirrorCredentialKeyError,
  parseMirrorInterval,
  registerMirror,
  type MirrorSettingsEnv,
  type MirrorStatus,
  type MigrateOptions,
} from "../api/services/mirror";
import { saveRepoSettings } from "../api/services/repo-settings";
import { findUserByName, type UserRow } from "../api/services/repository";
import { repositories, users } from "../db/schema";
import { ImportConflictError, ImportService, MAX_CHUNKS } from "../repos/imports/service";
import { RepoNameCollisionError, RepoNameInvalidError, RepoService, type RepoRow } from "../repos/service";
import { OrgService } from "./orgs/orgs";

/** The env slice the migrate orchestration reads — the mirror settings/KEK
 *  slice over the generated Env (whose MIRROR_SYNC_QUEUE binding is live;
 *  the enqueue below still runtime-guards it, so bare-test callers without
 *  the binding self-heal at the next cron tick — the row lands due at
 *  `now`) plus REGISTRY, which the birth write threads into RepoService so
 *  the migrated repo's engine-registry upsert runs at create (REDEPLOY8: a
 *  bare construction left the repo 404ing on info/refs/clone until the
 *  population's first push). */
export type MigrateEnv = MirrorSettingsEnv & Pick<Env, "REGISTRY">;

/**
 * The server-driven arm's body: the shared MigrateOptions (the into-empty
 * shape's accepted fields) plus the create-shaped fields that are SEMANTIC
 * here — upstream MigrateRepoOptions binds `clone_addr` and `repo_name`
 * Required; `repo_owner`/`uid` name the target owner (modules/structs/
 * repo.go:419-450).
 */
export interface ServerMigrateOptions extends MigrateOptions {
  repo_owner?: string;
  uid?: number;
  repo_name: string;
}

/** The owner-level flags the route's auth middleware resolved. */
export interface MigrateDoer {
  id: number;
  isAdmin: boolean;
}

export interface MigrateImportBootstrap {
  import_id: number;
  import_token: string;
  chunk_size_cap: number;
  chunk_count_cap: number;
  upload: string;
}

export interface MigrateOutcome {
  repo: RepoRow;
  owner: UserRow;
  /** mirror=true arm — the registered mirror status row (§2.3 shape). */
  mirror: MirrorStatus | null;
  /** mirror=false arm — the chunked-import bootstrap the caller drives. */
  importBootstrap: MigrateImportBootstrap | null;
}

/**
 * Resolve the target owner the way upstream migrate.go:82-99 does:
 * `repo_owner` (name) first, then `uid`, then the doer; a non-admin doer may
 * target themself or an org they OWN — anything else is upstream's exact 403
 * texts. Unknown owners are upstream's 422 (`user does not exist [name: x]`,
 * the ErrUserNotExist.Error() text APIError'd verbatim).
 */
export async function resolveMigrateOwner(
  db: D1Database,
  doer: MigrateDoer,
  options: Pick<ServerMigrateOptions, "repo_owner" | "uid">,
): Promise<UserRow> {
  let owner: UserRow | null;
  if (options.repo_owner !== undefined && options.repo_owner !== "") {
    owner = await findUserByName(db, options.repo_owner);
    if (owner === null) {
      throw new ApiError(422, `user does not exist [name: ${options.repo_owner}]`);
    }
  } else if (options.uid !== undefined) {
    owner = (await drizzle(db).select().from(users).where(eq(users.id, options.uid)).get()) ?? null;
    if (owner === null) {
      throw new ApiError(422, `user does not exist [id: ${options.uid}]`);
    }
  } else {
    owner = (await drizzle(db).select().from(users).where(eq(users.id, doer.id)).get()) ?? null;
    if (owner === null) {
      // The findDoerRow convention: a token resolving to no row is the
      // silent-auth-failure class (the api middlewares' "token is required").
      throw new ApiError(401, "token is required");
    }
  }
  if (!doer.isAdmin && owner.id !== doer.id) {
    if (owner.type !== "org") {
      throw new ApiError(403, "Given user is not an organization.");
    }
    if (!(await new OrgService(db).isOrgOwner(owner.id, doer.id))) {
      throw new ApiError(403, "Given user is not owner of organization.");
    }
  }
  return owner;
}

/**
 * The §2.2 server-driven migrate. Validation happens BEFORE the birth write
 * wherever the shared services allow it, so a rejected migrate costs no
 * state; the two write phases are the create (repos/service.ts — the
 * UNIQUE(owner, slug) arbitration → 409 collision / 422 name) and the arm
 * drive (registerMirror's batch CAS / ImportService.create's batch CAS —
 * both atomic, both re-arbitrating on the born row).
 */
export async function migrateRepository(
  db: D1Database,
  env: MigrateEnv,
  owner: UserRow,
  options: ServerMigrateOptions,
  now: Date,
): Promise<MigrateOutcome> {
  // -- §2.2 restricted validation (URL gate first, upstream migrate.go order)
  const source = checkMirrorSourceUrl(options.clone_addr, env);
  if (options.service !== undefined && options.service !== "git") {
    throw new ApiError(422, `unsupported service: ${JSON.stringify(options.service)}`);
  }
  for (const flag of [
    options.wiki,
    options.issues,
    options.milestones,
    options.labels,
    options.pull_requests,
    options.releases,
  ]) {
    if (flag === true && options.mirror !== true) {
      // §2.2: fail rather than silently dropping data; mirror=true is the
      // upstream zeroed case (migrate.go:159-166) and passes below.
      throw new ApiError(422, "metadata migration is not supported for this service");
    }
  }
  parseMirrorInterval(options.mirror_interval); // §2.2 row 6 — 422s, stored by the mirror arm
  if (options.lfs_endpoint !== undefined && options.lfs_endpoint !== "") {
    // §4.1: the LFS endpoint gets the identical gate at accept time.
    checkMirrorSourceUrl(options.lfs_endpoint, env);
  }
  // Pre-flight the credential KEK BEFORE the birth write: registerMirror
  // validates it too, but only after the repo row exists — a stranded born
  // row (retry = 409) is worse than failing fast (§4.2 fail-fast posture).
  if (options.mirror === true && deriveMirrorAuthHeader(options) !== null) {
    const kek = env.MIRROR_CREDENTIAL_KEY;
    if (kek === undefined || kek === "") {
      // The registerMirror 500 family (§4.2 fail-fast) — thrown pre-birth.
      throw new MirrorCredentialKeyError(
        "MIRROR_CREDENTIAL_KEY is not configured; source credentials cannot be stored",
      );
    }
  }

  // -- the birth (the arm's own repositories INSERT; silent by design) ------
  const service = new RepoService(db, { registry: env.REGISTRY.getByName("registry") });
  let repo: RepoRow;
  try {
    repo = await service.create({
      owner: { id: owner.id, usernameLower: owner.usernameLower },
      name: options.repo_name,
      isPrivate: options.private === true,
    });
  } catch (error) {
    if (error instanceof RepoNameCollisionError) {
      // §2.2 row 4 — upstream's exact text (migrate.go:226-228).
      throw new ApiError(409, "The repository with the same name already exists.");
    }
    if (error instanceof RepoNameInvalidError) {
      // upstream 422s err.Error() for reserved/pattern violations
      throw new ApiError(422, error.message);
    }
    throw error;
  }

  // `description` rides the repo-edit stored subset — the createUserRepository
  // pattern (upstream keeps it on the repository row; the sweep keeps the
  // side table).
  if (options.description !== undefined && options.description !== "") {
    await saveRepoSettings(db, repo.id, { description: options.description }, now);
  }

  if (options.mirror === true) {
    // upstream zeroes the metadata flags for mirrors (migrate.go:159-166);
    // registerMirror re-runs the URL gate + interval parse on the zeroed copy.
    const mirrorOptions: ServerMigrateOptions = {
      ...options,
      mirror: true,
      wiki: false,
      issues: false,
      milestones: false,
      labels: false,
      pull_requests: false,
      releases: false,
    };
    const mirror = await registerMirror(
      db,
      env,
      { id: repo.id, ownerNamespace: repo.ownerNamespace, slug: repo.slug },
      mirrorOptions,
    );
    // Kick the initial population (§2.6 — best-effort: the row is due at
    // `now`, so a failed send self-heals at the next cron tick; the consumer
    // re-checks every state on its own).
    const queue = env.MIRROR_SYNC_QUEUE;
    if (queue) {
      try {
        // The literal sync.ts MirrorSyncMessage shape (inlined — the route
        // graph must stay engine-free; see routes/mirror.ts's header).
        await queue.send({ kind: "mirror-sync", repoId: repo.id });
      } catch (error) {
        console.error(
          `[migrate] sync enqueue failed for ${repo.ownerNamespace}/${repo.slug}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { repo, owner, mirror, importBootstrap: null };
  }

  // -- the one-time import arm: original_url + the chunked-channel row ------
  // (mirror repos got original_url inside registerMirror's CAS; this arm
  // writes it directly — upstream sets OriginalURL at create for both.)
  await drizzle(db)
    .update(repositories)
    .set({ originalUrl: source.sanitized, updatedAt: now })
    .where(eq(repositories.id, repo.id));
  const created = await new ImportService(db)
    .create(repo.id)
    .catch((error: unknown) => {
      // Only reachable as a race (the row was born empty+ready above) — the
      // same 409 the channel's own route answers.
      if (error instanceof ImportConflictError) throw new ApiError(409, error.message);
      throw error;
    });
  // Re-read: the channel's create flipped the row to `status='migrating'`
  // (§2.2's divergence note — the 201 renders the migrating repo).
  repo = (await service.get(repo.id)) ?? repo;
  return {
    repo,
    owner,
    mirror: null,
    importBootstrap: {
      import_id: created.row.id,
      import_token: created.importToken,
      chunk_size_cap: created.chunkCap,
      chunk_count_cap: MAX_CHUNKS,
      upload: `/api/v1/repos/${encodeURIComponent(repo.ownerNamespace)}/${encodeURIComponent(
        repo.slug,
      )}/imports/${created.row.id}/chunks/{n}`,
    },
  };
}
