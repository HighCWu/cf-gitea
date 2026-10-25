/**
 * Repository lifecycle service — SPEC-0003 §2.5 (M2/M3): create, push-create,
 * rename (+ redirects), transfer, visibility, delete (queue-driven purge).
 *
 * Transaction discipline mirrors src/issues/service.ts: every multi-statement
 * mutation is ONE `db.batch([...])` (a single SQLite transaction on D1), and
 * the `UNIQUE(owner_id, lower_name)` arbitration point (here:
 * `UNIQUE(owner_namespace, slug)` on the landed table) decides every
 * create/rename path — the §4.1 race loser catches the unique violation and
 * re-reads, never surfacing the race as an error to a legitimate pusher.
 *
 * Engine synchronization: the engine Registry DO (packages/git-engine
 * src/registry.ts) is the engine's own repo index; the engine 404s fetches for
 * repos missing from it, so every lifecycle mutation best-effort mirrors the
 * affected `owner/name` key (`upsert` + `setConfig(priv)`, `remove` on
 * delete). A registry hiccup never fails the D1 mutation — receivePack
 * upserts on every committed push, so the next push heals the row; failures
 * land in the observability log (the admin-notice equivalent).
 *
 * storage_key addressing (the ENGINE-WAVE flip): SPEC-0003 §3.3 addresses R2
 * keys by `repos/<storage_key>/` and persists meta.storage_key in the cell.
 * The engine consumes the immutable key from the `x-storage-key` header the
 * gate sets on receive-pack forwards (SPEC-0001a §3 Step 3), and RepoCell now
 * exposes markDeleted/destroy/setHead RPCs (used by src/repos/purge.ts and
 * setDefaultBranch below). Still name-addressed: the RepoCell itself (DO id)
 * and every non-receive delegation (`env.REPO.getByName("owner/repo")`) key
 * on the combined name — a storage-move/adopt RPC for renames/transfers
 * remains the documented engine gap. Consequence, unchanged: rename/transfer
 * update D1 + redirects fully, but engine storage (DO SQLite + R2 prefixes)
 * stays under the pre-move name; pushes to the new URL re-seed a fresh empty
 * DO (git data written before the move is not migrated) while R2 addressing
 * follows the immutable storage_key either way.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { Registry } from "@cf-gitea/git-engine";

import { IssuesService } from "../issues/service";
import {
  comments,
  commitStatuses,
  issueLabels,
  issuePins,
  issueSubscriptions,
  issues,
  labels,
  milestones,
  reactions,
  releaseAssets,
  releases,
  repoCollaborators,
  repoCounters,
  repoRedirects,
  repoSettings,
  repoMirrors,
  repoTopics,
  repoTransfer,
  repoUnits,
  repoWatchers,
  pullRequests,
  repositories,
  stars,
  teamRepoAccess,
  users,
  webhookDeliveries,
  webhooks,
} from "../db/schema";
import type { RepoPurgeMessage } from "./purge";

/** Statement type accepted by drizzle's D1 `batch` (one SQLite transaction). */
type BatchStatement = Parameters<DrizzleD1Database["batch"]>[number][number];
/** The public `db.batch` signature requires a non-empty tuple. */
type BatchStatements = [BatchStatement, ...BatchStatement[]];

export type RepoRow = typeof repositories.$inferSelect;

// ---------------------------------------------------------------------------
// Upstream name rules (SPEC-0003 §2.5.3, models/repo/repo.go:72-89)
// ---------------------------------------------------------------------------

/** Upstream `validRepoNamePattern` (`^[-.\w]+$`). */
const VALID_REPO_NAME = /^[-.\w]+$/;
/** Upstream `invalidRepoNamePattern` (no consecutive dots). */
const INVALID_REPO_NAME = /[.]{2,}/;
/** Upstream `reservedRepoNames`. */
const RESERVED_REPO_NAMES = new Set([".", "..", "-"]);
/** Upstream `reservedRepoNamePatterns` — `*.git` is what makes the git gate's
 *  suffix trim unambiguous (§4.4). Matched case-insensitively, like upstream
 *  `db.IsUsableName`. */
const RESERVED_REPO_NAME_SUFFIXES = [".wiki", ".git", ".rss", ".atom"];

/** Engine `REPO_NAME` (packages/git-engine mod.ts) — the git gate only claims
 *  names the engine routes, so anything outside this alphabet would create an
 *  unreachable repo over git HTTP. Enforced ON TOP of the upstream rules. */
const ENGINE_REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Port of upstream `IsUsableRepoName` (models/repo/repo.go:72-89) plus the
 * engine-routability constraint above.
 */
export function isUsableRepoName(name: string): boolean {
  if (!VALID_REPO_NAME.test(name) || INVALID_REPO_NAME.test(name)) return false;
  if (RESERVED_REPO_NAMES.has(name)) return false;
  const lower = name.toLowerCase();
  if (RESERVED_REPO_NAME_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return false;
  return ENGINE_REPO_NAME.test(name);
}

/**
 * Owner namespaces no user/org may take. SPEC-0008 hard-reserves `assets`
 * (the UI asset route); `api` collides with the Hono-owned /api/v1 surface
 * (src/index.ts). The create-path check is the upstream-style
 * `IsUsableUsername` guard; the DB-level backstop is the seeded 'assets' row
 * in migration 0003 (users.username_lower is UNIQUE, so the permanently
 * prohibited seeded row makes the name un-takeable at the storage layer).
 * User registration (SPEC-0002 wave) and org creation (SPEC-0007) must call
 * this before INSERT.
 */
const RESERVED_OWNER_NAMES = new Set(["assets", "api"]);

export function isReservedOwnerName(name: string): boolean {
  return RESERVED_OWNER_NAMES.has(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Errors (API layers map them; upstream errclasses in parentheses)
// ---------------------------------------------------------------------------

export class RepoNameInvalidError extends Error {
  constructor(public readonly repoName: string) {
    super(`repository name is not allowed: ${repoName}`);
    this.name = "RepoNameInvalidError";
  }
}

/** Name taken (upstream `ErrRepoAlreadyExist`; 409 at the API level). */
export class RepoNameCollisionError extends Error {
  constructor(
    public readonly ownerNamespace: string,
    public readonly repoName: string,
  ) {
    super(`repository already exists: ${ownerNamespace}/${repoName}`);
    this.name = "RepoNameCollisionError";
  }
}

export class RepoNotExistError extends Error {
  constructor(public readonly repoId: string) {
    super(`repository does not exist: ${repoId}`);
    this.name = "RepoNotExistError";
  }
}

export class TransferNotExistError extends Error {
  constructor(public readonly repoId: string) {
    super(`no pending transfer for repository: ${repoId}`);
    this.name = "TransferNotExistError";
  }
}

export class OwnerNotAssignableError extends Error {
  constructor(messageText: string) {
    super(messageText);
    this.name = "OwnerNotAssignableError";
  }
}

export class NotAuthorizedError extends Error {
  constructor(messageText = "not authorized") {
    super(messageText);
    this.name = "NotAuthorizedError";
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** The combined engine name (namespaced mode): where the engine Registry and
 *  the DO/R2 storage are keyed until the storage-key engine wave. */
export function engineName(ownerNamespace: string, slug: string): string {
  return `${ownerNamespace}/${slug}`;
}

/**
 * Row 13 / §2.5.3: resolve an old URL to its canonical location via
 * `repo_redirects` (upstream `LookupRedirect`, models/repo/redirect.go:67-79;
 * applies to git HTTP and, later, web/API lookups alike). Returns the repo's
 * CURRENT canonical location (owner namespace + slug at the target row) — the
 * redirect row's own owner is only the lookup key, so a transfer's old-owner
 * URL lands on the new owner's path. Null when no redirect claims the name.
 */
export async function lookupRedirect(
  d1: D1Database,
  ownerLower: string,
  nameLower: string,
): Promise<{ ownerNamespace: string; slug: string } | null> {
  const db = drizzle(d1);
  const row = await db
    .select({ ownerNamespace: repositories.ownerNamespace, slug: repositories.slug })
    .from(repoRedirects)
    .innerJoin(repositories, eq(repositories.id, repoRedirects.redirectRepoId))
    .where(and(eq(repoRedirects.ownerNamespace, ownerLower), eq(repoRedirects.lowerName, nameLower)))
    .get();
  return row ?? null;
}

/** Best-effort engine-side dependencies; all optional so the D1 halves run
 *  standalone in tests (and until the engine RPC gaps close). */
export interface RepoEngineDeps {
  /** Engine Registry DO stub — best-effort repo-index sync. */
  registry?: DurableObjectStub<Registry>;
  /** REPO_TASKS producer — delete-purge messages (§2.5.5 step 3). */
  queue?: { send(message: RepoPurgeMessage): Promise<unknown> };
  /** RepoCell tombstone (§2.5.5 step 2): the engine's markDeleted RPC,
   *  injected so the service stays engine-agnostic. Best-effort. */
  tombstone?: (engineName: string) => Promise<void>;
  /** RepoCell setHead (§2.5.2 default-branch change): maps the engine's
   *  SetHeadResult tag. Best-effort; D1 is the metadata source of truth. */
  setHead?: (engineName: string, branch: string) => Promise<"ok" | "invalid" | "not_found">;
}

export interface CreateRepoInput {
  owner: { id: number; usernameLower: string };
  name: string;
  isPrivate: boolean;
  /** 'creating' for push-create (§2.5.2); 'ready' for API creates. */
  status?: "ready" | "creating";
}

export class RepoService {
  private readonly db: DrizzleD1Database;

  constructor(
    private readonly d1: D1Database,
    private readonly deps: RepoEngineDeps = {},
  ) {
    this.db = drizzle(d1);
  }

  async get(repoId: string): Promise<RepoRow | null> {
    const row = await this.db.select().from(repositories).where(eq(repositories.id, repoId)).get();
    return row ?? null;
  }

  /** Resolve by (owner, name), both case-folded (§4.5). */
  async getBySlug(ownerLower: string, nameLower: string): Promise<RepoRow | null> {
    const row = await this.db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, ownerLower), eq(repositories.slug, nameLower)))
      .get();
    return row ?? null;
  }

  /**
   * §2.5.1 create, two steps in ONE transaction: the insert allocates the id,
   * a same-batch UPDATE derives the immutable `storage_key = 'r_' || id` (the
   * SPEC's insert→last_row_id→UPDATE note; with client-minted TEXT ids the
   * unique placeholder merely keeps the UNIQUE column satisfied
   * mid-transaction). Also performs the §4.11 shadow rule (create at a
   * redirected name consumes the redirect), seeds the issue/PR counter row,
   * and mirrors the repo into the engine Registry.
   */
  async create(input: CreateRepoInput): Promise<RepoRow> {
    if (!isUsableRepoName(input.name)) throw new RepoNameInvalidError(input.name);
    const lower = input.name.toLowerCase();
    const id = crypto.randomUUID();
    try {
      await this.db.batch([
        this.db.insert(repositories).values({
          id,
          // replaced by the same-transaction UPDATE below (SPEC-0003 §2.5.1)
          storageKey: `pending_${id}`,
          ownerNamespace: input.owner.usernameLower,
          ownerId: input.owner.id,
          slug: lower,
          visibility: input.isPrivate ? "private" : "public",
          defaultBranch: "main",
          isEmpty: true,
          isArchived: false,
          status: input.status ?? "ready",
          refsVersion: 0,
          createdAt: new Date(),
        }),
        // Immutable thereafter; renames/transfers never touch it (ADR-0001 D3).
        this.db
          .update(repositories)
          .set({ storageKey: sql`'r_' || ${repositories.id}` })
          .where(eq(repositories.id, id)),
        // §4.11: creating at a live redirect consumes it (redirect rows are
        // not part of the repo namespace; upstream's IsUsableRepoName ignores
        // them, and NewRedirect's delete-first keeps at most one row).
        this.db
          .delete(repoRedirects)
          .where(
            and(
              eq(repoRedirects.ownerNamespace, input.owner.usernameLower),
              eq(repoRedirects.lowerName, lower),
            ),
          ),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new RepoNameCollisionError(input.owner.usernameLower, lower);
      throw error;
    }
    await this.seedRepoExtras(id, input, lower);
    const row = await this.get(id);
    if (row === null) throw new RepoNotExistError(id);
    return row;
  }

  /** Shared post-commit bookkeeping: counters + engine registry mirror. */
  private async seedRepoExtras(id: string, input: CreateRepoInput, lower: string): Promise<void> {
    // SPEC-0005 §3.1: the issue/PR counter row exists from birth.
    await new IssuesService(this.d1).ensureRepoCounters(id);
    // Engine registry mirror — the engine 404s fetches for registry-missing
    // repos, so creates MUST upsert. Best-effort (next push heals).
    const name = engineName(input.owner.usernameLower, lower);
    try {
      if (this.deps.registry) {
        await this.deps.registry.upsert(name, Date.now());
        await this.deps.registry.setConfig(name, {
          owner: input.owner.usernameLower,
          priv: input.isPrivate,
        });
      }
    } catch (error) {
      console.error(`[repos] registry sync failed for ${id}: ${errorMessage(error)}`);
    }
  }

  /**
   * §2.5.3 rename — metadata-only: validate (the IsUsableRepoName port),
   * delete any redirect shadowing the NEW name (upstream NewRedirect,
   * models/repo/redirect.go:81-92), flip the slug, insert the old-name
   * redirect — one transaction. `UNIQUE(owner_namespace, slug)` aborts a
   * collision (409 at the API level). storage_key/refs_version untouched;
   * the RepoDO is untouched (§2.5.3 step 3 — engine storage move is the
   * documented ENGINE-WAVE gap; see the module docstring).
   */
  async rename(repoId: string, newName: string): Promise<RepoRow> {
    if (!isUsableRepoName(newName)) throw new RepoNameInvalidError(newName);
    const repo = await this.get(repoId);
    if (repo === null) throw new RepoNotExistError(repoId);
    const newLower = newName.toLowerCase();
    if (newLower === repo.slug) return repo;

    const oldEngine = engineName(repo.ownerNamespace, repo.slug);
    const newEngine = engineName(repo.ownerNamespace, newLower);
    try {
      await this.db.batch([
        this.db
          .delete(repoRedirects)
          .where(
            and(eq(repoRedirects.ownerNamespace, repo.ownerNamespace), eq(repoRedirects.lowerName, newLower)),
          ),
        this.db
          .update(repositories)
          .set({ slug: newLower, updatedAt: new Date() })
          .where(eq(repositories.id, repoId)),
        this.db.insert(repoRedirects).values({
          ownerId: await this.redirectOwnerId(repo),
          ownerNamespace: repo.ownerNamespace,
          lowerName: repo.slug,
          redirectRepoId: repo.id,
          createdAt: new Date(),
        }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new RepoNameCollisionError(repo.ownerNamespace, newLower);
      throw error;
    }
    await this.syncRegistryMove(oldEngine, newEngine, repo.visibility === "private");
    const row = await this.get(repoId);
    if (row === null) throw new RepoNotExistError(repoId);
    return row;
  }

  /** §2.5.4: file a pending transfer. One live row per repo (UNIQUE repo_id);
   *  a re-request replaces the pending one. The repo stays usable (§2.5.4). */
  async requestTransfer(repoId: string, doerId: number, newOwnerId: number): Promise<void> {
    const repo = await this.get(repoId);
    if (repo === null) throw new RepoNotExistError(repoId);
    if (repo.ownerId === newOwnerId) {
      throw new OwnerNotAssignableError("repository is already owned by that owner");
    }
    const target = await this.db.select().from(users).where(eq(users.id, newOwnerId)).get();
    if (target === undefined) throw new OwnerNotAssignableError("target owner does not exist");
    if (target.status !== "active") throw new OwnerNotAssignableError("target owner is not active");
    await this.db
      .insert(repoTransfer)
      .values({ repoId, doerId, newOwnerId, createdAt: new Date() })
      .onConflictDoUpdate({
        target: repoTransfer.repoId,
        set: { doerId, newOwnerId, createdAt: new Date() },
      });
  }

  /** §2.5.4 reject/cancel: delete the pending row (no-op when absent). */
  async cancelTransfer(repoId: string): Promise<void> {
    await this.db.delete(repoTransfer).where(eq(repoTransfer.repoId, repoId));
  }

  /**
   * §2.5.4 accept — one transaction: move ownership (owner_id +
   * owner_namespace), delete the redirect shadowing the new location, insert
   * the redirect UNDER THE OLD OWNER (`NewRedirect(oldOwner.ID, repo.ID,
   * repo.Name, repo.Name)`, services/repository/transfer.go:320-354), drop
   * the pending row. Storage untouched (`storage_key` immutable); the
   * visibility re-check is implicit — every request re-reads the owner from
   * D1 (§2.5.4), so a transfer to a private owner hides the repo from
   * anonymous readers immediately.
   */
  async acceptTransfer(repoId: string, doer: { id: number; isAdmin: boolean }): Promise<RepoRow> {
    const repo = await this.get(repoId);
    if (repo === null) throw new RepoNotExistError(repoId);
    const pending = await this.db.select().from(repoTransfer).where(eq(repoTransfer.repoId, repoId)).get();
    if (pending === undefined) throw new TransferNotExistError(repoId);
    // The full collaborator model lands in SPEC-0005; today the accept grant
    // is { repo owner, target owner, site admin }.
    if (!doer.isAdmin && doer.id !== repo.ownerId && doer.id !== pending.newOwnerId) {
      throw new NotAuthorizedError(
        "only the repo owner, the target owner, or a site admin can accept a transfer",
      );
    }
    const target = await this.db.select().from(users).where(eq(users.id, pending.newOwnerId)).get();
    if (target === undefined || target.status !== "active") {
      throw new OwnerNotAssignableError("target owner does not exist or is not active");
    }
    if (repo.ownerId === null) throw new OwnerNotAssignableError("repository has no recorded owner");

    const oldEngine = engineName(repo.ownerNamespace, repo.slug);
    const newEngine = engineName(target.usernameLower, repo.slug);
    await this.db.batch([
      this.db
        .update(repositories)
        .set({ ownerId: target.id, ownerNamespace: target.usernameLower, updatedAt: new Date() })
        .where(eq(repositories.id, repoId)),
      // Shadow rule: a redirect at the new location dies with the move.
      this.db
        .delete(repoRedirects)
        .where(
          and(eq(repoRedirects.ownerNamespace, target.usernameLower), eq(repoRedirects.lowerName, repo.slug)),
        ),
      // The old URL keeps working, registered under the OLD owner.
      this.db.insert(repoRedirects).values({
        ownerId: repo.ownerId,
        ownerNamespace: repo.ownerNamespace,
        lowerName: repo.slug,
        redirectRepoId: repo.id,
        createdAt: new Date(),
      }),
      this.db.delete(repoTransfer).where(eq(repoTransfer.repoId, repoId)),
    ]);
    await this.syncRegistryMove(oldEngine, newEngine, repo.visibility === "private");
    const row = await this.get(repoId);
    if (row === null) throw new RepoNotExistError(repoId);
    return row;
  }

  /** §2.5.6 visibility flip: D1 update + registry mirror. The ACL matrix
   *  re-reads both rows per request, so no cache invalidation is required;
   *  the worst-case stale window is the refs edge-cache TTL (§2.5.6). */
  async setVisibility(repoId: string, isPrivate: boolean): Promise<RepoRow> {
    const repo = await this.get(repoId);
    if (repo === null) throw new RepoNotExistError(repoId);
    await this.db
      .update(repositories)
      .set({ visibility: isPrivate ? "private" : "public", updatedAt: new Date() })
      .where(eq(repositories.id, repoId));
    try {
      if (this.deps.registry) {
        await this.deps.registry.setConfig(engineName(repo.ownerNamespace, repo.slug), { priv: isPrivate });
      }
    } catch (error) {
      console.error(`[repos] registry sync failed for ${repoId}: ${errorMessage(error)}`);
    }
    const row = await this.get(repoId);
    if (row === null) throw new RepoNotExistError(repoId);
    return row;
  }

  /**
   * §2.5.2 default-branch change (upstream SetDefaultBranch): one D1 UPDATE,
   * then the engine's setHead RPC best-effort — meta.head CAS inside the DO
   * bumps refs_version, so the advertisement's symref capability, the
   * synthetic HEAD file and the clone-cache key all follow. D1 is the
   * metadata source of truth: the update lands regardless of the engine
   * outcome, and pointing at an unborn branch is legal (an empty repo's D1
   * default names a branch the DO has not seen; the gate's synthetic HEAD
   * falls back to D1 for exactly that). "invalid"/"not_found" and transport
   * failures are logged (the admin-notice equivalent), never thrown; refname
   * validation is the caller's (upstream CheckRefNumValid) plus the engine's
   * own setHead guard — the DO never adopts a rejected branch.
   */
  async setDefaultBranch(repoId: string, branch: string): Promise<RepoRow> {
    const repo = await this.get(repoId);
    if (repo === null) throw new RepoNotExistError(repoId);
    await this.db
      .update(repositories)
      .set({ defaultBranch: branch, updatedAt: new Date() })
      .where(eq(repositories.id, repoId));
    if (this.deps.setHead) {
      const name = engineName(repo.ownerNamespace, repo.slug);
      try {
        const outcome = await this.deps.setHead(name, branch);
        if (outcome !== "ok") {
          console.error(`[repos] setHead ${name} -> ${branch} rejected: ${outcome}`);
        }
      } catch (error) {
        console.error(`[repos] setHead ${name} -> ${branch} failed: ${errorMessage(error)}`);
      }
    }
    const row = await this.get(repoId);
    if (row === null) throw new RepoNotExistError(repoId);
    return row;
  }

  /**
   * §2.5.5 delete, upstream ordering with a queue in the middle
   * (services/repository/delete.go:53-394): ALL D1 rows go in one
   * transaction FIRST — the row, every dependent table that exists today
   * (SPEC-0005 §3.2), redirects pointing at the repo, and the pending
   * transfer — so every subsequent git request misses at repo resolution and
   * a same-name repo can be re-created immediately (§4.8; fresh storage_key).
   *
   * Then the DO tombstone (best-effort, synchronous; the engine's
   * markDeleted RPC) and the queue purge message (best-effort; a lost
   * enqueue strands R2 bytes and is logged — the upstream `CreateNotice`
   * analog — never failing the user-facing delete). The consumer runs the
   * storage-key R2 prefix purge and the final destroy (src/repos/purge.ts).
   *
   * Returns the engine names the repo was known by (current + redirected), so
   * the purge consumer tombstones and destroys every cell the repo ever
   * lived in; R2 itself is reached through the single immutable storage_key.
   */
  async deleteRepository(repoId: string): Promise<{ engineNames: string[] }> {
    const repo = await this.get(repoId);
    if (repo === null) throw new RepoNotExistError(repoId);
    const current = engineName(repo.ownerNamespace, repo.slug);
    const redirected = await this.db
      .select({ ownerNamespace: repoRedirects.ownerNamespace, lowerName: repoRedirects.lowerName })
      .from(repoRedirects)
      .where(eq(repoRedirects.redirectRepoId, repoId))
      .all();
    const engineNames = [current, ...redirected.map((r) => engineName(r.ownerNamespace, r.lowerName))].filter(
      (name, index, all) => all.indexOf(name) === index,
    );

    // Issue-scoped dependents join through the repo's issue ids (comments,
    // labels, subscriptions, reactions); everything else keys on repo_id.
    const issueIds = () => this.db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, repoId));
    await this.db.batch([
      this.db.delete(comments).where(inArray(comments.issueId, issueIds())),
      this.db.delete(issueLabels).where(inArray(issueLabels.issueId, issueIds())),
      this.db.delete(issueSubscriptions).where(inArray(issueSubscriptions.issueId, issueIds())),
      this.db.delete(reactions).where(inArray(reactions.issueId, issueIds())),
      this.db.delete(pullRequests).where(eq(pullRequests.baseRepoId, repoId)),
      this.db.delete(pullRequests).where(eq(pullRequests.headRepoId, repoId)),
      this.db.delete(issues).where(eq(issues.repoId, repoId)),
      this.db.delete(labels).where(eq(labels.repoId, repoId)),
      this.db.delete(milestones).where(eq(milestones.repoId, repoId)),
      this.db.delete(releases).where(eq(releases.repoId, repoId)),
      this.db.delete(releaseAssets).where(eq(releaseAssets.repoId, repoId)),
      this.db.delete(commitStatuses).where(eq(commitStatuses.repoId, repoId)),
      this.db.delete(issuePins).where(eq(issuePins.repoId, repoId)),
      this.db.delete(webhooks).where(eq(webhooks.repoId, repoId)),
      this.db.delete(webhookDeliveries).where(eq(webhookDeliveries.repoId, repoId)),
      this.db.delete(repoCounters).where(eq(repoCounters.repoId, repoId)),
      this.db.delete(repoUnits).where(eq(repoUnits.repoId, repoId)),
      // Batch-7 stores (migration 0007): topics, watch edges, collaborators,
      // and the PATCH-stored settings subset — plus stars (migration 0008's
      // sweep; `repo_id` is a plain column there, no declared FK).
      // `follows`/`user_settings` are user-scoped — they belong to the
      // (future) delete-user flow, not this cascade.
      this.db.delete(repoTopics).where(eq(repoTopics.repoId, repoId)),
      this.db.delete(repoWatchers).where(eq(repoWatchers.repoId, repoId)),
      this.db.delete(repoCollaborators).where(eq(repoCollaborators.repoId, repoId)),
      this.db.delete(repoSettings).where(eq(repoSettings.repoId, repoId)),
      this.db.delete(stars).where(eq(stars.repoId, repoId)),
      // Team↔repo grants (migration 0015; SPEC-0007 §3.5) — `repo_id` is a
      // plain column there (no declared FK), so the rows die HERE with the
      // repo, exactly like the other repo-scoped stores above (the schema's
      // documented convention; upstream deletes them via the team_repo
      // cascade, services/repository/delete.go).
      this.db.delete(teamRepoAccess).where(eq(teamRepoAccess.repoId, repoId)),
      // Mirror rows (migration 0010; SPEC-0009 §4.3.13) — the encrypted
      // credentials die with the repo that owned them.
      this.db.delete(repoMirrors).where(eq(repoMirrors.repoId, repoId)),
      this.db.delete(repoRedirects).where(eq(repoRedirects.redirectRepoId, repoId)),
      this.db.delete(repoTransfer).where(eq(repoTransfer.repoId, repoId)),
      // The row is gone: git requests miss at repo resolution; the §4.1 race
      // logic makes a concurrent push-create re-create a FRESH row/key (§4.8).
      this.db.delete(repositories).where(eq(repositories.id, repoId)),
    ] satisfies BatchStatements);

    // Step 2: DO tombstone (markDeleted RPC) — refuses new receive leases and
    // aborts in-flight finalizes (§4.2). Best-effort: D1 already won; a
    // tombstone failure is logged and retried by the queue consumer (the
    // steps are idempotent).
    if (this.deps.tombstone) {
      for (const name of engineNames) {
        try {
          await this.deps.tombstone(name);
        } catch (error) {
          console.error(`[repos] tombstone failed for ${name}: ${errorMessage(error)}`);
        }
      }
    }

    // Step 3: queue purge (storage-key R2 prefixes, then the final destroy).
    if (this.deps.queue) {
      try {
        await this.deps.queue.send({ storageKey: repo.storageKey, engineNames });
      } catch (error) {
        console.error(
          `[repos] purge enqueue failed for ${repo.storageKey} (R2 prefixes orphaned): ${errorMessage(error)}`,
        );
      }
    }
    return { engineNames };
  }

  /** Engine-registry move helper: upsert the new key BEFORE removing the old,
   *  so fetches never observe a registry-miss window. */
  private async syncRegistryMove(oldEngine: string, newEngine: string, isPrivate: boolean): Promise<void> {
    if (!this.deps.registry) return;
    try {
      await this.deps.registry.upsert(newEngine, Date.now());
      await this.deps.registry.setConfig(newEngine, { priv: isPrivate });
      await this.deps.registry.remove(oldEngine);
    } catch (error) {
      console.error(`[repos] registry move failed ${oldEngine} -> ${newEngine}: ${errorMessage(error)}`);
    }
  }

  /** Redirect owner id: the recorded owner, or the users-row lookup for rows
   *  predating the owner_id column (0 = orphaned owner, matching the LEFT
   *  JOIN convention in the git gate — lookups key on owner_namespace). */
  private async redirectOwnerId(repo: RepoRow): Promise<number> {
    if (repo.ownerId !== null) return repo.ownerId;
    const owner = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, repo.ownerNamespace))
      .get();
    return owner?.id ?? 0;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** D1 unique-violation probe — the §4.1/§2.5.3 arbitration signal. */
function isUniqueViolation(error: unknown): boolean {
  let text = errorMessage(error);
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
    text += ` ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return text.includes("UNIQUE constraint failed");
}
