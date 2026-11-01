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
 * on the combined name — the storage-move/adopt RPC for renames/transfers
 * remains the documented engine gap. Consequence: rename/transfer update D1 +
 * redirects fully, and the CELL CONTENT is carried old → new synchronously
 * (src/repos/carry.ts — the registry-fix wave's P1 fix: fork-import lease for
 * packs, exact serialize reconstruction for the Worker-authored loose
 * objects) before the registry entry moves, so the new URL serves the same
 * git data immediately; R2 addressing follows the immutable storage_key
 * either way. Upstream semantics citation: upstream renames the repository
 * DIRECTORY in place (services/repository/transfer.go:391) so the new name
 * serves the same storage at once, and files a repo_redirects row
 * (models/repo/redirect.go NewRedirect via RenameRepository) so the OLD name
 * keeps resolving — both live here (the carry + the redirect rows; the old
 * name 301s to the canonical path rather than serving in place, the §2.5.3
 * row-13 divergence already on record).
 *
 * The wiki sibling cell (specs/wiki.md §3): every repo also owns the engine
 * cell `<owner>/<slug>.wiki` (services/wiki.ts wikiCellName — upstream's
 * `{repo}.wiki` sibling git repo), so the mutations above drag it along:
 * deleteRepository sync-tombstones each engine name's sibling (upstream
 * delete.go:335-337 removes the wiki repo files in the same post-transaction
 * sweep as the repo files; the queue consumer derives the same siblings itself
 * — src/repos/purge.ts's wiki cascade — so the sync arm is defense-in-depth
 * for the pre-consumer window), and the rename/transfer carry moves the
 * sibling with the main cell (upstream renames the wiki repo too:
 * transferOwnership's IsRepositoryExist-guarded wiki rename,
 * services/repository/transfer.go:316-326, and changeRepositoryName's
 * HasWiki-guarded one, transfer.go:396-399 — the guard is the wikiExists
 * dep's contract, so a never-provisioned wiki stays unprovisioned at the new
 * name).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { Registry } from "@cf-gitea/git-engine";

import { IssuesService } from "../issues/service";
import { AuditActions, auditEventInsert, type AuditOrigin } from "../services/audit";
import { OrgService } from "../services/orgs/orgs";
import {
  actions,
  comments,
  commitStatuses,
  issueLabels,
  issuePins,
  issueSubscriptions,
  issues,
  labels,
  milestones,
  notificationStates,
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
  orgMembers,
  pullRequests,
  protectedBranches,
  repositories,
  stars,
  teamRepoAccess,
  teams,
  users,
  webhookDeliveries,
  webhooks,
} from "../db/schema";
import { CommentType } from "../issues/comment-types";
import { clearRepoStars } from "../api/services/stars";
import { clearRepoWatches, unwatchRepo, watchRepo } from "../api/services/repo-watchers";
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

/**
 * A transfer is re-requested while one is already pending (upstream
 * `ErrRepoTransferInProgress`, models/repo/transfer.go:42-57 —
 * TestRepositoryReadyForTransfer raises it for a RepositoryPendingTransfer
 * status, models/repo/transfer.go:213-222, via StartRepositoryTransfer's
 * readiness gate, services/repository/transfer.go:445-446; the API maps it
 * to 409 Conflict, routers/api/v1/repo/transfer.go:113-115). Message is the
 * upstream Error() text verbatim.
 */
export class TransferInProgressError extends Error {
  constructor(
    public readonly ownerNamespace: string,
    public readonly repoName: string,
  ) {
    super(`repository is already being transferred [uname: ${ownerNamespace}, name: ${repoName}]`);
    this.name = "TransferInProgressError";
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
 * The sibling wiki cell's combined engine name (`owner/repo` → `owner/repo.wiki`)
 * — services/wiki.ts wikiCellName's convention folded to the combined form the
 * REPO namespace addresses (specs/wiki.md §3, upstream's `{repo}.wiki` sibling
 * git repo). Collision-free by construction: isUsableRepoName forbids the
 * `.wiki` suffix (RESERVED_REPO_NAME_SUFFIXES), so a derived name can never
 * host an unrelated repo's cell.
 */
export function wikiEngineName(name: string): string {
  return `${name}.wiki`;
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
  /** Engine-cell carry (the registry-fix wave): moves the OLD combined name's
   *  cell content into the NEW name's cell at rename/transfer time, so the
   *  new URL serves the same git data immediately (src/repos/carry.ts).
   *  Best-effort: a carry failure is logged, the D1 mutation stands. The wiki
   *  sibling rides the same channel with the derived `*.wiki` names. */
  carry?: (fromEngine: string, toEngine: string, storageKey: string) => Promise<void>;
  /** Wiki-cell existence probe — upstream's `HasWiki`
   *  (services/repository/repository.go:329-334), the guard that keeps the
   *  wiki rename a no-op for a repo without one (transfer.go:318-326 checks
   *  IsRepositoryExist on the old wiki repo; :396-399 gates on HasWiki).
   *  Optional: unwired, the rename/transfer wiki steps run unconditionally —
   *  a never-provisioned sibling tombstones and carries as the fresh-empty
   *  cell the new name would lazily get on its first wiki write anyway. A
   *  throwing probe falls the same way (attempt the move; the empty round
   *  trip is harmless, the provisioned one preserves the pages). */
  wikiExists?: (wikiEngineName: string) => Promise<boolean>;
}

export interface CreateRepoInput {
  owner: { id: number; usernameLower: string };
  name: string;
  isPrivate: boolean;
  /** 'creating' for push-create (§2.5.2); 'ready' for API creates. */
  status?: "ready" | "creating";
  /** The create-time default-units posture selector (upstream's
   *  DefaultRepoUnits switch, services/repository/create.go:349-355).
   *  "normal" — the default — arms actions + packages (DefaultRepoUnits,
   *  models/unit/unit.go:66-75); "fork" leaves both off
   *  (DefaultForkRepoUnits, unit.go:80-83); "mirror" arms packages only
   *  (DefaultMirrorRepoUnits, unit.go:86-93). Generate-from-template needs
   *  no kind: upstream's GenerateRepository creates with the NORMAL list
   *  (template.go:90 passes isFork=false and leaves IsTemplate unset). */
  creationKind?: RepoCreationKind;
  /** SPEC-0015 §4.2: the audit event's origin hint. Service-level v1 default
   *  "api" (every current call site is an API route or the git push-create
   *  settle); the downstream audit wave threads the real per-request origin. */
  origin?: AuditOrigin;
}

/** The creation kinds that select a default-units posture (see
 *  CreateRepoInput.creationKind). */
export type RepoCreationKind = "normal" | "fork" | "mirror";

/**
 * The actions/packages arming per creation kind — the 2026-10-29
 * upstream-parity flip of the creation defaults. Upstream's
 * createRepositoryInDB inserts a repo_units row per DefaultRepoUnits entry
 * in the same transaction (create.go:347-395), and the has_* state IS the
 * unit presence there (UnitEnabled reads the rows, models/repo/repo.go
 * :385-391); our reduction seeds the `repo_settings` side row (the flag
 * store) plus the `repo_units` actions row (the owner-scope runner scan's
 * join gate) with the same per-kind posture. `has_projects` stays false for
 * every kind — the remaining documented house divergence (upstream arms it
 * for normal/mirror/template; flipping it is its own alignment).
 */
const CREATION_UNIT_POSTURE: Record<RepoCreationKind, { actions: boolean; packages: boolean }> = {
  normal: { actions: true, packages: true },
  fork: { actions: false, packages: false },
  mirror: { actions: false, packages: true },
};

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
   * redirected name consumes the redirect), seeds the issue/PR counter row
   * (post-batch, seedRepoExtras), seeds the default-units posture (the
   * `repo_settings` row + the `repo_units` actions row, per creationKind —
   * upstream inserts the DefaultRepoUnits rows in the same transaction,
   * create.go:347-395), and mirrors the repo into the engine Registry.
   */
  async create(input: CreateRepoInput): Promise<RepoRow> {
    if (!isUsableRepoName(input.name)) throw new RepoNameInvalidError(input.name);
    const lower = input.name.toLowerCase();
    const id = crypto.randomUUID();
    const createdAt = new Date();
    const posture = CREATION_UNIT_POSTURE[input.creationKind ?? "normal"];
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
          createdAt,
        }),
        // Immutable thereafter; renames/transfers never touch it (ADR-0001 D3).
        this.db
          .update(repositories)
          .set({ storageKey: sql`'r_' || ${repositories.id}` })
          .where(eq(repositories.id, id)),
        // The default-units seed (the upstream-parity flip, 2026-10-29): the
        // settings side row (the has_* flag store) with the per-kind
        // actions/packages posture, and — when the posture arms actions —
        // the `repo_units` actions row (the runner scan's join gate; the
        // same row the settings toggle's enable arm writes, so a created
        // repo and a toggle-enabled one are indistinguishable downstream).
        // One batch = one SQLite transaction: the flags and the row commit
        // atomically with the repository row, upstream's units-insert shape.
        this.db.insert(repoSettings).values({
          repoId: id,
          description: "",
          website: "",
          hasIssues: true,
          hasWiki: true,
          hasPullRequests: true,
          hasReleases: true,
          hasProjects: false,
          hasPackages: posture.packages,
          hasActions: posture.actions,
          updatedAt: createdAt,
        }),
        ...(posture.actions ? [this.db.insert(repoUnits).values({ repoId: id, type: "actions" })] : []),
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
        // SPEC-0015 §4.2 slice-one: the `repository:create` audit row rides
        // the SAME batch — it commits (or rolls back) atomically with the
        // repositories row, making "audit rows must not outlive the write
        // they describe" structural (a name collision or invalid name throws
        // before the batch and emits nothing; a seedRepoExtras failure after
        // the batch leaves a real repositories row, so the event is
        // truthful). Actor = the owner from the input (fully attributed);
        // scope_id is the client-minted UUID, known before the batch.
        auditEventInsert(this.db, {
          action: AuditActions.RepositoryCreate,
          actorId: input.owner.id,
          actorName: input.owner.usernameLower,
          scopeType: "repository",
          scopeId: id,
          scopeName: `${input.owner.usernameLower}/${lower}`,
          origin: input.origin ?? "api",
          vars: { scope: `${input.owner.usernameLower}/${lower}` },
          metadata: {
            visibility: input.isPrivate ? "private" : "public",
            status: input.status ?? "ready",
          },
          timestamp: createdAt,
        }),
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
    await this.moveEngineCell(oldEngine, newEngine, repo);
    const row = await this.get(repoId);
    if (row === null) throw new RepoNotExistError(repoId);
    return row;
  }

  /**
   * §2.5.4: file a pending transfer. One live row per repo (UNIQUE repo_id);
   * a re-request while one is pending REFUSES — upstream 409s the duplicate
   * (TestRepositoryReadyForTransfer raises ErrRepoTransferInProgress for a
   * RepositoryPendingTransfer status, models/repo/transfer.go:213-222, via
   * StartRepositoryTransfer's readiness gate,
   * services/repository/transfer.go:445-446). The unique-violation arm is
   * the concurrent duplicate (upstream serializes on the repo working lock,
   * transfer.go:438-448; ours arbitrates on the constraint) — same 409. The
   * repo stays usable (§2.5.4).
   *
   * `teamIds` rides the org-team attach list (upstream `StartRepositoryTransfer
   * ... teams []*organization.Team`, services/repository/transfer.go:437 — the
   * route pre-validates every id, transfer.go:76-98, and the pending row
   * stores the ids, `RepoTransfer.TeamIDs []int64` JSON TEXT; the ATTACH
   * itself happens at acceptTransfer). Empty for user targets — the route's
   * ladder 422s any team list on a non-org recipient before reaching here. */
  async requestTransfer(
    repoId: string,
    doerId: number,
    newOwnerId: number,
    teamIds: number[] = [],
  ): Promise<void> {
    const repo = await this.get(repoId);
    if (repo === null) throw new RepoNotExistError(repoId);
    if (repo.ownerId === newOwnerId) {
      throw new OwnerNotAssignableError("repository is already owned by that owner");
    }
    const target = await this.db.select().from(users).where(eq(users.id, newOwnerId)).get();
    if (target === undefined) throw new OwnerNotAssignableError("target owner does not exist");
    if (target.status !== "active") throw new OwnerNotAssignableError("target owner is not active");
    const pending = await this.db
      .select({ id: repoTransfer.id })
      .from(repoTransfer)
      .where(eq(repoTransfer.repoId, repoId))
      .get();
    if (pending !== undefined) throw new TransferInProgressError(repo.ownerNamespace, repo.slug);
    try {
      await this.db
        .insert(repoTransfer)
        .values({ repoId, doerId, newOwnerId, teamIds: JSON.stringify(teamIds), createdAt: new Date() });
    } catch (error) {
      // The §4.1-adjacent race: two requests for the same repo decided by
      // UNIQUE(repo_id) where upstream's lock serializes — the loser 409s.
      if (isUniqueViolation(error)) throw new TransferInProgressError(repo.ownerNamespace, repo.slug);
      throw error;
    }
  }

  /** §2.5.4 reject/cancel: delete the pending row (no-op when absent). */
  async cancelTransfer(repoId: string): Promise<void> {
    await this.db.delete(repoTransfer).where(eq(repoTransfer.repoId, repoId));
  }

  /**
   * `CanUserAcceptOrRejectTransfer` (models/repo/transfer.go:142-160) — the
   * shared admission predicate for BOTH transfer verdicts (accept rides it
   * via AcceptTransferOwnership transfer.go:67-69, reject via
   * RejectRepositoryTransfer :525-527): "For user, it checks if it's
   * himself; for organizations, it checks if the user is able to create
   * repos". A missing recipient row refuses (upstream LoadAttributes fails
   * the check, :147-150). The org arm composes the landed
   * `OrgService.canCreateOrgRepo` seam (org_user.go:98-106's
   * can_create_org_repo OR owner-team predicate — org OWNERS pass through
   * the isOrgOwner bridge inside it).
   */
  async canUserAcceptOrRejectTransfer(recipientId: number, doerId: number): Promise<boolean> {
    const recipient = await this.db
      .select({ id: users.id, type: users.type })
      .from(users)
      .where(eq(users.id, recipientId))
      .get();
    if (recipient === undefined) return false;
    if (recipient.type !== "org") return recipient.id === doerId;
    return new OrgService(this.d1).canCreateOrgRepo(recipient.id, doerId);
  }

  /**
   * §2.5.4 accept — one transaction: move ownership (owner_id +
   * owner_namespace), delete the redirect shadowing the new location, insert
   * the redirect UNDER THE OLD OWNER (`NewRedirect(oldOwner.ID, repo.ID,
   * repo.Name, repo.Name)`, services/repository/transfer.go:320-354), drop
   * the pending row — plus the transferOwnership cascade arms that have a
   * landed seam here (upstream services/repository/transfer.go:110-355):
   *
   *   - redundant-collaborator cleanup (:183-210): the drop set is the NEW
   *     owner's own row plus every collaborator who is a member of the new
   *     owner's org (they hold the same access through the org); everyone
   *     else survives. Upstream's ghost arm has no counterpart here (our
   *     collaborators are never ghost rows).
   *   - the old-org arms (oldOwner.IsOrganization, :226-233 + :280-306): the
   *     old org's team↔repo grants die with the move (RemoveOrgRepo,
   *     models/organization/org.go:559-583) and each affected team's
   *     num_repos drops with them (org.go:586-588); the old org's watch
   *     drops; the org-label EDGES detach from this repo's issues (the
   *     `DELETE FROM issue_label` + label-comment sweep, transfer.go:267-306
   *     — the label definitions stay with the old org, so the edges are
   *     recoverable if the repo ever transfers back; their counters and the
   *     issues' num_comments are left to drift exactly like upstream's raw
   *     deletes).
   *
   *   - the filed team attach (:346-352): every org-team id stored on the
   *     pending row (RepoTransfer.TeamIDs) gains its team_repo_access grant
   *     + num_repos charge INSIDE the transaction, addRepositoryToTeam
   *     (services/repository/repo_team.go:40-47) — the filing-side ladder
   *     lives in the route (repo.ts, transfer.go:76-98).
   *
   *   - documented equivalents (no seam): upstream's `user.num_repos ± 1`
   *     owner counters (:246-250) have no column here — our users table
   *     carries no repo tally and every owner count derives from the rows;
   *     the new-org includes-all team materialization (:261-269) is subsumed
   *     by the dynamic coverage union (schema.ts teamRepoAccess note); the
   *     access-table recalculation (:271-275) needs no access table (the ACL
   *     matrix re-reads D1 per request).
   *
   * Storage untouched (`storage_key` immutable); the visibility re-check is
   * implicit — every request re-reads the owner from D1 (§2.5.4), so a
   * transfer to a private owner hides the repo from anonymous readers
   * immediately. The watch-transfer arms (transfer.go:277-286 — the filing
   * doer auto-watches, the old org unwatched) run as the guarded
   * watchRepo/unwatchRepo batches right after the main batch, upstream's
   * in-tx order preserved (doer watch first).
   *
   * Admission is upstream's CanUserAcceptOrRejectTransfer port
   * (models/repo/transfer.go:142-160, via AcceptTransferOwnership
   * services/repository/transfer.go:67-69): the USER recipient alone, or —
   * when the recipient is an ORG (the pending row's newOwnerId is the org's
   * row id, matching no human id) — any doer with CanCreateOrgRepo on it
   * (org owners + can-create/owner teams, the landed canCreateOrgRepo seam).
   * Upstream grants NO admin bypass here (admins act via sudo) and does not
   * admit the transferring repo owner — the wider {repo owner, site admin}
   * arms the earlier reduction carried are gone with the port. 403 message
   * is upstream's `util.ErrPermissionDenied` text (the reject route's
   * verbatim twin).
   */
  async acceptTransfer(repoId: string, doer: { id: number; isAdmin: boolean }): Promise<RepoRow> {
    const repo = await this.get(repoId);
    if (repo === null) throw new RepoNotExistError(repoId);
    const pending = await this.db.select().from(repoTransfer).where(eq(repoTransfer.repoId, repoId)).get();
    if (pending === undefined) throw new TransferNotExistError(repoId);
    if (!(await this.canUserAcceptOrRejectTransfer(pending.newOwnerId, doer.id))) {
      throw new NotAuthorizedError("permission denied");
    }
    const target = await this.db.select().from(users).where(eq(users.id, pending.newOwnerId)).get();
    if (target === undefined || target.status !== "active") {
      throw new OwnerNotAssignableError("target owner does not exist or is not active");
    }
    if (repo.ownerId === null) throw new OwnerNotAssignableError("repository has no recorded owner");
    const oldOwner = await this.db
      .select({ id: users.id, type: users.type })
      .from(users)
      .where(eq(users.id, repo.ownerId))
      .get();
    const oldOwnerIsOrg = oldOwner?.type === "org";

    // Upstream's label sweep narrows to labels that do not belong to the
    // repo's new home (transfer.go:267-306): a REPO label of another repo
    // (`label.org_id = 0 AND issue.repo_id != label.repo_id`) or an ORG
    // label of an org that is not the new owner (`label.repo_id = 0 AND
    // label.org_id != ?newOwner`). Our column shape: repo labels have
    // `repo_id` set, org labels `repo_id` NULL (the issues.ts:198 read
    // convention), so the two arms translate directly; COALESCE mirrors
    // upstream's `= 0` / `= 0` zero-discriminators over a nullable column.
    const foreignLabelIds = () =>
      this.db
        .select({ id: labels.id })
        .from(labels)
        .where(
          sql`(${labels.repoId} IS NOT NULL AND ${labels.repoId} != ${repoId}) OR (${labels.repoId} IS NULL AND COALESCE(${labels.orgId}, 0) != ${pending.newOwnerId})`,
        );
    const repoIssueIds = () => this.db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, repoId));

    // The filed org-team attach list (RepoTransfer.TeamIDs, JSON TEXT) — the
    // rows ATTACH here, at accept (transferOwnership's closing loop,
    // services/repository/transfer.go:346-352). Upstream LoadAttributes
    // re-fetches the teams by id at accept (models/repo/transfer.go:111-121),
    // so a team deleted between filing and accept drops silently — mirrored
    // by the org-scoped lookup below (filing validated team.org_id against
    // the recipient org; orgs never re-point teams, so the conjunct only
    // drops vanished rows). includes-all teams stay UNMATERIALIZED per the
    // landed addTeamRepo reduction (routes/org-teams.ts — their coverage is
    // the dynamic union; upstream's unconditional addRepositoryToTeam
    // materialization is redundant here).
    const filedTeamIds: number[] = JSON.parse(pending.teamIds) as number[];
    const attachTeams =
      filedTeamIds.length === 0
        ? []
        : (
            await this.db
              .select({ id: teams.id, includesAllRepositories: teams.includesAllRepositories })
              .from(teams)
              .where(and(inArray(teams.id, filedTeamIds), eq(teams.orgId, pending.newOwnerId)))
              .all()
          ).filter((team) => !team.includesAllRepositories);

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
      // Redundant collaborators (:183-210): the new owner's own row and
      // every new-org member's row drop (org access subsumes them); the
      // upstream ghost arm has no seam here (no ghost collaborator rows).
      this.db
        .delete(repoCollaborators)
        .where(
          and(
            eq(repoCollaborators.repoId, repoId),
            sql`(${repoCollaborators.userId} = ${pending.newOwnerId} OR ${repoCollaborators.userId} IN (SELECT ${orgMembers.userId} FROM ${orgMembers} WHERE ${orgMembers.orgId} = ${pending.newOwnerId}))`,
          ),
        ),
      this.db.delete(repoTransfer).where(eq(repoTransfer.repoId, repoId)),
      // The team attach (:346-352 → addRepositoryToTeam, services/repository/
      // repo_team.go:40-47 = AddTeamRepo + IncrTeamRepoNum), one guarded pair
      // per team. Update-before-insert so the NOT EXISTS guard reads the
      // PRE-insert coverage (a team already holding the repo skips the bump,
      // the idempotent re-attach arms no-op) — the batch-serialized stand-in
      // for the landed addTeamRepo's hasTeamRepo pre-check + unique-violation
      // catch (that seam lives in a route module; the grant rows and the
      // num_repos charge are the same ones it writes).
      ...attachTeams.flatMap((team) => [
        this.db
          .update(teams)
          .set({ numRepos: sql`${teams.numRepos} + 1` })
          .where(
            and(
              eq(teams.id, team.id),
              sql`NOT EXISTS (SELECT 1 FROM ${teamRepoAccess} WHERE ${teamRepoAccess.teamId} = ${team.id} AND ${teamRepoAccess.repoId} = ${repoId})`,
            ),
          ),
        this.db
          .insert(teamRepoAccess)
          .values({ orgId: pending.newOwnerId, teamId: team.id, repoId })
          .onConflictDoNothing(),
      ]),
      // The old-org arms (:226-233 + :280-306). First RemoveOrgRepo with its
      // counter arm (transfer.go:227-229 → org.go:559-583, org.go:586-588):
      // update-before-delete, so the decrement's subquery sees the rows its
      // charge is computed from; MAX(…,0) is the landed drift-insurance
      // floor (same posture as deleteRepository). Then the label-edge sweep
      // (:267-306): edges detach, the type-Label event comments referencing
      // them go with — the label definitions stay with the old org (upstream
      // deletes neither them nor the drifted counters).
      ...(oldOwnerIsOrg
        ? [
            this.db
              .update(teams)
              .set({ numRepos: sql`MAX(num_repos - 1, 0)` })
              .where(
                inArray(
                  teams.id,
                  this.db
                    .select({ teamId: teamRepoAccess.teamId })
                    .from(teamRepoAccess)
                    .where(and(eq(teamRepoAccess.orgId, repo.ownerId), eq(teamRepoAccess.repoId, repoId))),
                ),
              ),
            this.db
              .delete(teamRepoAccess)
              .where(and(eq(teamRepoAccess.orgId, repo.ownerId), eq(teamRepoAccess.repoId, repoId))),
            this.db.delete(issueLabels).where(
              and(
                inArray(issueLabels.issueId, repoIssueIds()),
                inArray(issueLabels.labelId, foreignLabelIds()),
              ),
            ),
            this.db.delete(comments).where(
              and(
                eq(comments.type, CommentType.Label),
                inArray(comments.issueId, repoIssueIds()),
                inArray(comments.labelId, foreignLabelIds()),
              ),
            ),
          ]
        : []),
    ]);
    // Watch transfer (:277-286): the ORIGINAL doer (repoTransfer.Doer, the
    // user who filed the request) auto-watches; the old org's watch drops.
    // WatchRepoAuto semantics ride the landed watchRepo/unwatchRepo ports
    // (watch.go:159-178: a Custom watch is kept, an Auto old-org watch lands
    // on Dont, everything else on None) — separate guarded batches, upstream
    // order preserved.
    await watchRepo(this.d1, repoId, pending.doerId, new Date());
    if (oldOwnerIsOrg && repo.ownerId !== null) {
      await unwatchRepo(this.d1, repoId, repo.ownerId, new Date());
    }
    await this.moveEngineCell(oldEngine, newEngine, repo);
    const row = await this.get(repoId);
    if (row === null) throw new RepoNotExistError(repoId);
    return row;
  }

  /**
   * §2.5.6 visibility flip — the full setRepoVisibility port
   * (services/repository/repository.go:145-205), fork coupling included.
   * Per flipped repo: the row update, the →private zeroing (stars + watches
   * of a private repo are not public facts, repository.go:172-181 —
   * ClearRepoStars/ClearRepoWatches), the best-effort registry priv mirror,
   * then the FORK-TREE cascade (repository.go:184-200):
   *
   *   shouldUpdateForks := private
   *   if !private && repo.Owner.Visibility != VisibleTypePrivate {
   *     shouldUpdateForks = true
   *   }
   *
   * →private always descends; →public descends only when the flipping
   * repo's owner is not a private org — evaluated PER LEVEL via the
   * recursive applyVisibility walk (GetRepositoriesByForkID →
   * setRepoVisibility per child), so a private-org-owned fork flips itself
   * while its own subtree stops there. The fork column is the single
   * nullable fork_parent (migration 0009; no is_fork — the delete cascade
   * resets orphaned children, so the walk cannot loop).
   *
   * The ACL matrix re-reads both rows per request, so no cache invalidation
   * is required; the worst-case stale window is the refs edge-cache TTL
   * (§2.5.6). The forced-value arm of the coupling (a fork PATCH cannot
   * choose its own visibility) is the ROUTE's — repo.go:673-679 forces
   * `private` to the base's value before the change detection.
   */
  async setVisibility(repoId: string, isPrivate: boolean): Promise<RepoRow> {
    const repo = await this.get(repoId);
    if (repo === null) throw new RepoNotExistError(repoId);
    await this.applyVisibility(repo, isPrivate);
    const row = await this.get(repoId);
    if (row === null) throw new RepoNotExistError(repoId);
    return row;
  }

  /** One setRepoVisibility level (repository.go:145-205): the flip, the
   *  →private zeroing, the registry mirror, the fork walk. */
  private async applyVisibility(repo: RepoRow, isPrivate: boolean): Promise<void> {
    await this.db
      .update(repositories)
      .set({ visibility: isPrivate ? "private" : "public", updatedAt: new Date() })
      .where(eq(repositories.id, repo.id));
    if (isPrivate) {
      // repository.go:172-181 — every flipped repo zeroes its own edges.
      await clearRepoStars(this.d1, repo.id);
      await clearRepoWatches(this.d1, repo.id);
    }
    try {
      if (this.deps.registry) {
        await this.deps.registry.setConfig(engineName(repo.ownerNamespace, repo.slug), { priv: isPrivate });
      }
    } catch (error) {
      console.error(`[repos] registry sync failed for ${repo.id}: ${errorMessage(error)}`);
    }
    // repository.go:184-200 — the cascade gate, then GetRepositoriesByForkID
    // and a recursive setRepoVisibility per child.
    if (isPrivate || (await this.ownerVisibility(repo.ownerId)) !== "private") {
      const forks = await this.db
        .select()
        .from(repositories)
        .where(eq(repositories.forkParent, repo.id))
        .all();
      for (const fork of forks) {
        await this.applyVisibility(fork, isPrivate);
      }
    }
  }

  /** The owner row's visibility for the →public cascade gate (repo.Owner.
   *  Visibility, repository.go:186) — 'public' for a missing owner row (the
   *  git gate's orphaned-owner LEFT JOIN convention, redirectOwnerId). */
  private async ownerVisibility(ownerId: number | null): Promise<"public" | "limited" | "private"> {
    if (ownerId === null) return "public";
    const row = await this.db
      .select({ visibility: users.visibility })
      .from(users)
      .where(eq(users.id, ownerId))
      .get();
    return row?.visibility ?? "public";
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
   * markDeleted RPC — every name's `.wiki` sibling included, the wiki
   * cascade's sync arm, upstream delete.go:335-337) and the queue purge
   * message (best-effort; a lost enqueue strands R2 bytes and is logged —
   * the upstream `CreateNotice` analog — never failing the user-facing
   * delete). The consumer runs the storage-key R2 prefix purge and the final
   * destroy, deriving each name's `.wiki` sibling itself (src/repos/purge.ts),
   * so the message shape stays `{storageKey, engineNames}`.
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
    // labels, subscriptions, notifications, reactions); everything else keys
    // on repo_id.
    const issueIds = () => this.db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, repoId));
    await this.db.batch([
      this.db.delete(comments).where(inArray(comments.issueId, issueIds())),
      this.db.delete(issueLabels).where(inArray(issueLabels.issueId, issueIds())),
      this.db.delete(issueSubscriptions).where(inArray(issueSubscriptions.issueId, issueIds())),
      // Notification read-state (⑩-review P3): upstream's census carries
      // `&activities_model.Notification{RepoID: repoID}` directly
      // (services/repository/delete.go:170). Our derived-thread store has no
      // repo_id column — notification_states keys on (user_id, issue_id) and
      // the threads derive from issues — so the arm joins through the repo's
      // issue ids like the siblings above. Without it the leak is invisible
      // (the threads 404 with their issues) but the rows are permanent.
      this.db.delete(notificationStates).where(inArray(notificationStates.issueId, issueIds())),
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
      // Delete-cascade counter arms (the counters-2 fold; upstream
      // services/repository/delete.go), update-before-delete so each count
      // subquery sees the rows its charge is computed from:
      //   - :224-228 — a deleted fork decrements its parent's tally
      //     (`UPDATE repository SET num_forks=num_forks-1 WHERE id=?`,
      //     repo.ForkID); the MAX(…, 0) floor is the landed drift insurance
      //     (same posture as the ±1 arms in services/stars.ts).
      ...(repo.forkParent !== null
        ? [
            this.db
              .update(repositories)
              .set({ numForks: sql`MAX(num_forks - 1, 0)` })
              .where(eq(repositories.id, repo.forkParent)),
          ]
        : []),
      //   - :133 — every starrer's user tally drops with their edge
      //     (`UPDATE user SET num_stars=num_stars-1 WHERE id IN (SELECT uid
      //     FROM star WHERE repo_id = ?)`); the port subtracts each starrer's
      //     own edge count on this repo (the unique pair makes it one —
      //     blocks.ts's dropUserStarsFor posture), floored at 0 like every
      //     other decrement arm.
      this.db
        .update(users)
        .set({
          numStars: sql`MAX(num_stars - (
            SELECT COUNT(*) FROM stars
            WHERE stars.user_id = users.id AND stars.repo_id = ${repoId}
          ), 0)`,
        })
        .where(
          inArray(
            users.id,
            this.db.select({ uid: stars.userId }).from(stars).where(eq(stars.repoId, repoId)),
          ),
        ),
      //   - :282-285 — surviving forks keep no dangling edge: upstream resets
      //     `fork_id=0,is_fork=false WHERE fork_id=?`; our column shape is the
      //     single nullable fork_parent (no is_fork column), so the reset is
      //     fork_parent = NULL. Upstream's `repo.NumForks > 0` gate is
      //     subsumed by the WHERE (zero matching children = a no-op).
      this.db.update(repositories).set({ forkParent: null }).where(eq(repositories.forkParent, repoId)),
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
      // Protected-branch rules die with the repo (SPEC-0013 M4's cascade arm —
      // upstream's DeleteBeans census carries &git_model.ProtectedBranch
      // {RepoID: repoID}, services/repository/delete.go:171). The schema's
      // repo-scoped convention (no FK) already promised this sweep.
      this.db.delete(protectedBranches).where(eq(protectedBranches.repoId, repoId)),
      // Activity rows die with the repo — the REDEPLOY11/12 carried issue
      // (probe operators hand-swept orphan `action` rows twice). Upstream's
      // DeleteBeans census carries `&activities_model.Action{RepoID:
      // repo.ID}` (services/repository/delete.go:155-157): every
      // NotifyWatchers receiver copy keys on repo_id, so one repo_id-keyed
      // DELETE sweeps originals and fan-out copies alike. Upstream does NOT
      // write is_deleted=1 — no production writer sets that flag at the pin
      // (models/activities/action_list.go:222-224 + action.go:539-541 are
      // read filters only) — the landed schema contract agrees (db/schema.ts
      // actions docstring: "repo deletion cascades rows away with the repo
      // row"); the feeds' `is_deleted=false` read filter
      // (activity-feeds.ts feedCondition) stays the parity arm it already
      // is.
      this.db.delete(actions).where(eq(actions.repoId, repoId)),
      this.db.delete(repoRedirects).where(eq(repoRedirects.redirectRepoId, repoId)),
      this.db.delete(repoTransfer).where(eq(repoTransfer.repoId, repoId)),
      // The row is gone: git requests miss at repo resolution; the §4.1 race
      // logic makes a concurrent push-create re-create a FRESH row/key (§4.8).
      this.db.delete(repositories).where(eq(repositories.id, repoId)),
    ] satisfies BatchStatements);

    // Step 2: DO tombstone (markDeleted RPC) — refuses new receive leases and
    // aborts in-flight finalizes (§4.2). Best-effort: D1 already won; a
    // tombstone failure is logged and retried by the queue consumer (the
    // steps are idempotent). Each name's `.wiki` sibling tombstones with it
    // (the wiki cascade's sync arm — upstream delete.go:335-337 removes the
    // wiki repo files in the same post-transaction sweep as the repo files;
    // defense-in-depth: the consumer derives the same siblings itself, so
    // this only shrinks the pre-consumer window. markDeleted on a
    // never-created sibling is the same fresh-empty initialize-and-tombstone
    // the consumer relies on).
    if (this.deps.tombstone) {
      for (const name of [...engineNames, ...engineNames.map(wikiEngineName)]) {
        try {
          await this.deps.tombstone(name);
        } catch (error) {
          console.error(`[repos] tombstone failed for ${name}: ${errorMessage(error)}`);
        }
      }
    }

    // Step 2b (registry-fix wave — the P1 probe's symptom 2): drop EVERY
    // registry entry for the repo SYNCHRONOUSLY with the D1 delete. The queue
    // purge removes them too, but the production probe observed a renamed
    // repo's entry serving its refs ANONYMOUSLY 48 s+ in the window before
    // the consumer ran: D1 was gone, the tombstoned cell kept answering
    // reads, and the engine's registry hit authorized them. Best-effort like
    // every registry sync; the purge's backstop sweep below is unchanged.
    // (No arm for the derived `*.wiki` siblings: a wiki cell holds no
    // registry row, and the consumer's backstop sweeps the names anyway.)
    if (this.deps.registry) {
      for (const name of engineNames) {
        try {
          await this.deps.registry.remove(name);
        } catch (error) {
          console.error(`[repos] registry remove failed for ${name}: ${errorMessage(error)}`);
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

  /**
   * The engine half of a rename/transfer, after the D1 batch won (registry-fix
   * wave — the P1 probe's symptom 1): the engine's RepoCells are NAME-addressed,
   * so the new combined name would otherwise resolve a FRESH, EMPTY cell while
   * the content stayed under the old one. The main cell's three best-effort
   * steps, in order:
   *
   *   1. tombstone the OLD cell (straggler receive leases abort cleanly §4.2;
   *      reads keep answering for the carry below);
   *   2. CARRY the cell content old → new (src/repos/carry.ts: the fork-import
   *      lease for packs, exact serialize reconstruction for loose objects) —
   *      upstream renames the repo DIRECTORY in place (transfer.go:391
   *      git.RenameRepository), so the new name serves the same storage
   *      immediately; the carry is that move on name-addressed cells. The
   *      immutable storage_key means both cells share one R2 prefix — no byte
   *      forks (ADR-0001 D3 holds);
   *   3. move the registry entry (upsert new → remove old, the no-miss-window
   *      order) — the engine 404s/serves off this index.
   *
   * The WIKI SIBLING `<old>.wiki` moves with the repo (specs/wiki.md §3; the
   * wiki purge landing's follow-up — upstream renames the wiki repo with the
   * repo: transferOwnership's IsRepositoryExist-guarded wiki rename,
   * services/repository/transfer.go:316-326, and changeRepositoryName's
   * HasWiki-guarded one, transfer.go:396-399): the same tombstone + carry
   * steps through the same deps, minus the registry arm (a `*.wiki` cell
   * holds no registry row). wikiExists (upstream's HasWiki) keeps a
   * never-provisioned wiki a no-op at the new name; the sibling's whole state
   * surface is Worker-authored loose objects + refs (the git channels that
   * pack are 404-gated for *.wiki), so the carry's loose round trip moves it
   * exactly. A failed sibling carry strands the pages at the old cell until
   * the delete purge reclaims them (logged, never thrown — the same degraded
   * floor as the main carry).
   *
   * Every step logs and continues on failure: D1 is the source of truth, the
   * degraded floor is the pre-fix behavior, and receivePack upserts heal the
   * registry (the module-docstring engine-sync contract).
   */
  private async moveEngineCell(oldEngine: string, newEngine: string, repo: RepoRow): Promise<void> {
    if (oldEngine === newEngine) return;
    if (this.deps.tombstone) {
      try {
        await this.deps.tombstone(oldEngine);
      } catch (error) {
        console.error(`[repos] tombstone failed for ${oldEngine}: ${errorMessage(error)}`);
      }
    }
    if (this.deps.carry) {
      try {
        await this.deps.carry(oldEngine, newEngine, repo.storageKey);
      } catch (error) {
        console.error(
          `[repos] cell carry failed ${oldEngine} -> ${newEngine} (repo ${repo.id}, new url serves empty until healed): ${errorMessage(error)}`,
        );
      }
      // The wiki sibling (upstream transfer.go:316-326 + :396-399, HasWiki-
      // gated): tombstone the old sibling, carry it to the new name — the
      // main cell's steps 1-2 over the derived `*.wiki` names.
      const oldWiki = wikiEngineName(oldEngine);
      if (await this.wikiSiblingProvisioned(oldWiki)) {
        if (this.deps.tombstone) {
          try {
            await this.deps.tombstone(oldWiki);
          } catch (error) {
            console.error(`[repos] wiki tombstone failed for ${oldWiki}: ${errorMessage(error)}`);
          }
        }
        try {
          await this.deps.carry(oldWiki, wikiEngineName(newEngine), repo.storageKey);
        } catch (error) {
          console.error(
            `[repos] wiki cell carry failed ${oldWiki} -> ${wikiEngineName(newEngine)} (repo ${repo.id}, pages stranded at the old cell until the delete purge reclaims them): ${errorMessage(error)}`,
          );
        }
      }
    }
    await this.syncRegistryMove(oldEngine, newEngine, repo.visibility === "private");
  }

  /** The HasWiki gate for the wiki sibling's move steps (moveEngineCell):
   *  true when the probe is unwired or throws — attempt the move either way
   *  (a fresh-empty sibling's round trip is the lazy-provisioning equivalent,
   *  and a provisioned one must not strand its pages on a probe hiccup);
   *  the wired probe's verdict otherwise. */
  private async wikiSiblingProvisioned(oldWiki: string): Promise<boolean> {
    if (this.deps.wikiExists === undefined) return true;
    try {
      return await this.deps.wikiExists(oldWiki);
    } catch (error) {
      console.error(`[repos] wikiExists probe failed for ${oldWiki}: ${errorMessage(error)}`);
      return true;
    }
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
