/**
 * The `_cargo-index` git mirror — SPEC-0016 §7 M7's deferred half, upstream
 * `gitea/services/packages/cargo/index.go` at the pin. Upstream keeps one REAL
 * git repository per owner (`IndexRepositoryName`, index.go:29) whose tree
 * mirrors the cargo registry over the git protocol: `config.json` at the root
 * (index.go:242-258) and one NDJSON file per package at the sparse path
 * (index.go:31-48, addOrUpdatePackageIndex :198-208). This module maintains
 * that repository as an ENGINE CELL against D1 — the same objects upstream's
 * TemporaryUploadRepository commits, landed through the same primitives as
 * every Worker-authored write (`putApiObjects` + `commitApiChange` CAS — the
 * wiki sibling's seam, wiki.ts:826-834; the tree construction is this
 * module's level-chain builder, see buildMirrorChangeCommit for why the
 * shared contents builder is not reused).
 *
 * ## The adjudications (M7's deferred decisions, recorded for the SPEC)
 *
 * **Incremental per package, never a per-write rebuild.** Upstream's write
 * arms (publish cargo.go:247, yank/unyank cargo.go:298, the cleanup rider
 * cleanup.go:115) all funnel into `UpdatePackageIndexIfExists`, which rewrites
 * exactly ONE package file — `addOrUpdatePackageIndex` over that package's
 * full version list (index.go:198-208). The whole-tree `RebuildIndex`
 * (index.go:63-106) is a separate explicit operator action (the settings
 * button), not a write-arm behavior. Our arms keep that shape: every write
 * recomputes the ONE affected package's NDJSON from D1 (`buildCargoPackageIndex`
 * — the same builder the sparse HTTP face serves) and rewrites its file; a
 * full rebuild is `rebuildCargoIndexMirror` (the RebuildIndex port), exposed
 * for the operator button, never driven by writes.
 *
 * **The hiding posture — rowless cell, hidden by construction.** Upstream
 * creates the index as a real `repositories` row (`CreateRepositoryDirectly`,
 * index.go:210-226) and does NOT keep it out of listings — no models/repo
 * filter exists at the pin, so the repo shows up on the owner's profile. Our
 * substrate already owns the pattern for infrastructure repositories: the
 * wiki sibling is a bare engine cell `<owner>/<slug>.wiki` with NO D1 row and
 * NO engine-registry entry (wiki.ts storage convention; `*.wiki` names are
 * reserved so no real repo can take the address). The mirror is the same
 * class: the cell `<owner>/_cargo-index` (cargoIndexCellName), rowless and
 * registry-less — invisible to every D1 listing, to the public site index,
 * and to the git gate's registry-existence oracle (a rowless name 404s).
 * Documented divergence: upstream's index repo is user-visible (and cloneable
 * at `{origin}/{owner}/_cargo-index.git`); ours is hidden and the git-URL
 * face 404s until a wiki-style gate family teaches the gate the marker
 * (gate.ts is not this module's surface — the content is maintained now so
 * that face is one seam away; the sparse `+sparse+` config face is what cargo
 * clients use anyway, and it never reads the repo — cargo.go:66-87).
 *
 * **Remove-on-empty (the one deliberate write-arm divergence).** Upstream's
 * write arm leaves a package's index file BEHIND when its last version
 * disappears: `BuildPackageIndex` answers nil for zero versions and
 * `addOrUpdatePackageIndex` no-ops (index.go:154-156, 203-205), so the stale
 * line-file survives until a manual Rebuild. Our update arm REMOVES the file
 * instead: the mirror's source of truth is D1 (the sparse face 404s an
 * emptied package), and the mirror matching the sparse face is the more
 * faithful of the two observable behaviors. `RebuildIndex`'s own semantics
 * (remove everything, re-add what exists) produce exactly this tree, so the
 * divergence is "the write arm agrees with upstream's rebuild", not a new
 * shape.
 *
 * **Best-effort landings (the webhook-fan posture, disclosed).** Upstream
 * FAILS the publish when the index write fails and rolls the version back
 * (cargo.go:247-254). Ours logs and continues — a failed mirror write heals
 * on the next write of the same package (every write rewrites the whole file
 * from D1) or via `rebuildCargoIndexMirror`. The same posture covers the
 * engine's 8 MiB `putApiObjects` budget: a registry whose rebuilt tree
 * exceeds it answers `too_large` on the (explicit) rebuild instead of
 * failing.
 *
 * ## Lifecycle coupling
 *
 * Rowless cells are not dragged by repo rename/transfer/delete cascades —
 * but the mirror is owner-scoped (upstream keys it on the OWNER too, one
 * index per user/org), so repo renames never touch it. An owner (user/org)
 * rename strands the cell at the old namespace: writes address the CURRENT
 * namespace, so the next write after `ensureCargoIndexMirror` re-seeds
 * config.json + the touched package at the new name; untouched packages
 * reappear on their next write or a rebuild. Upstream renames the repo
 * automatically (a real row); ours degrades to "re-initialize heals" — the
 * trade the hiding posture buys.
 *
 * ## Wiring (the mount recipe)
 *
 * The protocol arms pass the hook struct; the routes are recipe-owned
 * (packages-protocols.ts), so the mount lines are recorded in SPEC-0016's
 * cargo as-built and in this module's report:
 *   - publish arm: `cargoIndex: { bindings: cargoIndexBindings(c.env) }`
 *   - yank/unyank arms: the same field
 *   - cleanup.ts rider: the same struct as `updateCargoPackageIndex`'s 4th arg
 *   - the settings buttons (when the UI wave lands): POST handlers call
 *     `ensureCargoIndexMirror` / `rebuildCargoIndexMirror`
 * Until a mount passes the hook, every arm stays the upstream repo-absent
 * no-op (index.go:108-111 — "We do not want to force the creation of the repo
 * here") — the mirror only ever exists where `ensureCargoIndexMirror` ran.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { serializeCommit, serializeTree, type ApiObject, type Person, type RepoCell } from "@cf-gitea/git-engine";

import {
  branchRef,
  engineRepoName,
  refTipMap,
  ZERO_OID,
  type EngineReads,
} from "../../api/services/engine";
import { packages, repositories, users } from "../../db/schema";
import {
  buildCargoPackageIndex,
  buildCargoPackagePath,
  buildCargoRegistryConfig,
  CARGO_CONFIG_FILE_NAME,
  CARGO_INDEX_REPOSITORY_NAME,
} from "./cargo";
import type { PackageRow } from "./model";

// ---------------------------------------------------------------------------
// Addressing + bindings (the hiding posture's concrete shape)
// ---------------------------------------------------------------------------

/** The mirror's default branch — upstream `repo.DefaultBranch` resolves the
 *  `[repository] DEFAULT_BRANCH` setting ("main"), the same value our repo
 *  rows are created with (repos/service.ts). */
export const CARGO_INDEX_BRANCH = "main";

/** The full ref the mirror commits land on. */
export const CARGO_INDEX_REF = branchRef(CARGO_INDEX_BRANCH);

/**
 * The bindings the mirror arms need: the REPO namespace (the engine cell
 * host) and the site origin (config.json's `dl`/`api` + the noreply hostname
 * for commit identity). Structural — tests pass `{ repo: env.REPO, origin }`
 * directly; production mounts build it with `cargoIndexBindings`.
 */
export interface CargoIndexBindings {
  repo: DurableObjectNamespace<RepoCell>;
  origin: string;
}

/** The hook the write arms thread (bindings + the acting user's id —
 *  upstream's `ctx.Doer`; the cleanup arm omits it and the owner authors). */
export interface CargoIndexHook {
  bindings: CargoIndexBindings;
  doerId?: number;
}

/** Build the hook bindings from a request/queue env (the `APP_URL` → request
 *  origin → localhost chain `appOrigin` runs, kept local to avoid the
 *  webhooks-push import edge). */
export function cargoIndexBindings(
  env: Pick<Env, "REPO"> & { APP_URL?: string },
  requestOrigin?: string,
): CargoIndexBindings {
  return {
    repo: env.REPO,
    origin: (env.APP_URL ?? requestOrigin ?? "http://localhost:3000").replace(/\/+$/, ""),
  };
}

/** The mirror cell's engine address — `<ownerNamespace>/_cargo-index` (the
 *  wiki sibling's combined-name convention, wiki.ts wikiCellName). */
export function cargoIndexCellName(ownerNamespace: string): { ownerNamespace: string; slug: string } {
  return { ownerNamespace, slug: CARGO_INDEX_REPOSITORY_NAME };
}

function indexCell(bindings: CargoIndexBindings, ownerNamespace: string): DurableObjectStub<RepoCell> {
  return bindings.repo.getByName(engineRepoName(cargoIndexCellName(ownerNamespace)));
}

/** The read slice the mirror arms consume (null-on-failure, engineReads'
 *  wrapper shape — engineReads itself is typed against the full Env). */
type IndexReads = Pick<EngineReads, "listRefs" | "listTree" | "readBlob" | "readCommit">;

function indexReads(bindings: CargoIndexBindings, ownerNamespace: string): IndexReads {
  const cell = indexCell(bindings, ownerNamespace);
  const safe = async <T>(pending: Promise<T>): Promise<T | null> => {
    try {
      return await pending;
    } catch {
      return null;
    }
  };
  return {
    listRefs: () => safe(cell.listRefs()),
    listTree: (ref, path) => safe(cell.listTree(ref, path)),
    readBlob: (ref, path) => safe(cell.readBlob(ref, path)),
    readCommit: (id) => safe(cell.readCommit(id)),
  };
}

// ---------------------------------------------------------------------------
// The collision guard + commit identity
// ---------------------------------------------------------------------------

/**
 * TRUE when a `repositories` row occupies `owner/_cargo-index`. Our design
 * never creates one (the hiding posture), so a hit means a USER owns the
 * name — upstream's shape would find that repo and commit the index INTO it
 * (GetRepositoryByOwnerAndName → alterRepositoryContent, index.go:210-226);
 * ours refuses to touch a user-owned repository and skips the mirror arms.
 */
export async function cargoIndexAddressOwned(d1: D1Database, ownerId: number): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerId, ownerId), eq(repositories.slug, CARGO_INDEX_REPOSITORY_NAME)))
    .limit(1)
    .all();
  return row.length > 0;
}

interface IndexOwner {
  id: number;
  username: string;
  usernameLower: string;
  email: string | null;
  visibility: "public" | "limited" | "private";
}

async function loadOwnerRow(d1: D1Database, ownerId: number): Promise<IndexOwner | null> {
  const row = await drizzle(d1)
    .select({
      id: users.id,
      username: users.username,
      usernameLower: users.usernameLower,
      email: users.email,
      visibility: users.visibility,
    })
    .from(users)
    .where(eq(users.id, ownerId))
    .get();
  return row ?? null;
}

/**
 * The commit person — upstream `CommitTreeUserOptions{DoerUser: doer}`
 * (index.go:298-303): the acting user's `NewGitSig` (user.go:400-407, name =
 * the display name, email = the stored email or the noreply default). Ours
 * resolves the DOER's row when the hook carries one (publish/yank pass
 * `ctx.Doer`; the cleanup arm passes owner,owner upstream — we omit doerId
 * and the owner authors), falling back to the owner row, with the house
 * noreply fallback `<username>@noreply.<origin hostname>` for a null email
 * (upload-staging.ts:443's convention; the hostname comes from the bindings'
 * origin because the cleanup consumer runs off-request).
 */
async function indexPerson(
  d1: D1Database,
  ownerRow: IndexOwner,
  bindings: CargoIndexBindings,
  doerId?: number,
  now?: number,
): Promise<Person> {
  let row: IndexOwner = ownerRow;
  if (doerId !== undefined && doerId !== ownerRow.id) {
    row = (await loadOwnerRow(d1, doerId)) ?? ownerRow;
  }
  const hostname = new URL(bindings.origin).hostname;
  return {
    name: row.username,
    email: row.email !== null && row.email !== "" ? row.email : `${row.username}@noreply.${hostname}`,
    time: now ?? Math.floor(Date.now() / 1000),
    tz: "+0000",
  };
}

/** The root `config.json` bytes — `json.Encoder.Encode` appends "\n"
 *  (index.go:249-251), so the file is the JSON document plus a newline. */
export function cargoIndexConfigBytes(
  owner: { username: string; visibility: "public" | "limited" | "private" },
  origin: string,
): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(buildCargoRegistryConfig(owner, origin))}\n`);
}

// ---------------------------------------------------------------------------
// The landing seam — objects + CAS, with one bounded conflict retry
// ---------------------------------------------------------------------------

type IndexLandingResult =
  | { tag: "committed"; newOid: string }
  | { tag: "unchanged" }
  | { tag: "too_large"; limitBytes: number }
  | { tag: "refused"; reason: string };

interface IndexLanding {
  reads: IndexReads;
  cell: DurableObjectStub<RepoCell>;
  person: Person;
  message: string;
}

/** One mirror-file change: upsert bytes at `path`, or remove the file. */
interface IndexChange {
  path: string;
  /** present = upsert; absent = remove. */
  content?: Uint8Array;
}

interface MirrorChangeBuild {
  objects: ApiObject[];
  commitOid: string;
  expectedOld: string;
  /** the new ROOT tree — equals the tip's tree when the change was a no-op */
  treeOid: string;
  unchanged: boolean;
}

/**
 * Build one change commit on `tipOid` (null = the unborn root). The mirror's
 * own level-chain builder — NOT the shared contents builder
 * (git-models.ts buildFileChangeCommit): that one registers only the leaf
 * directory and the root in its level map, so a create two levels deep has
 * its intermediate tree serialized but never attached (levels.get(parentDir)
 * is undefined for a fresh ancestor). Every index path is 1-3 segments deep
 * over possibly-new directories (`3/a/abc`, `ab/cd/abcd`), so the builder
 * here pre-loads EVERY prefix level of the changed path
 * ("" → "ab" → "ab/cd"), applies the change to the leaf, and rebuilds the
 * chain bottom-up with all parents present — the emptied-directory drop
 * (git has no empty trees) rides the same chain. `unchanged` fires when the
 * recomputed ROOT tree oid equals the base tree (identical bytes upserted,
 * or a remove of an already-absent file that slipped past the pre-check).
 */
async function buildMirrorChangeCommit(
  reads: IndexReads,
  tipOid: string | null,
  change: IndexChange,
  spec: { message: string; person: Person },
): Promise<MirrorChangeBuild | null> {
  const head = tipOid === null ? null : await reads.readCommit(tipOid);
  if (tipOid !== null && head === null) return null;

  const segments = change.path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;
  const name = segments[segments.length - 1] as string;

  // Every prefix level of the path, root first — "" included.
  const levels = new Map<string, Map<string, { mode: string; oid: string }>>();
  for (let depth = 0; depth < segments.length; depth++) {
    const prefix = segments.slice(0, depth).join("/");
    const entries = new Map<string, { mode: string; oid: string }>();
    if (tipOid !== null) {
      const tree = await reads.listTree(tipOid, prefix);
      if (tree !== null) {
        for (const entry of tree.entries) entries.set(entry.name, { mode: entry.mode, oid: entry.oid });
      }
    }
    levels.set(prefix, entries);
  }
  const leafDir = segments.slice(0, -1).join("/");
  const leaf = levels.get(leafDir);
  if (leaf === undefined) return null;

  const objects: ApiObject[] = [];
  if (change.content === undefined) {
    if (!leaf.delete(name)) {
      return { objects: [], commitOid: "", expectedOld: tipOid ?? ZERO_OID, treeOid: head?.tree ?? "", unchanged: true };
    }
  } else {
    const header = new TextEncoder().encode(`blob ${change.content.byteLength}\0`);
    const raw = new Uint8Array(header.length + change.content.byteLength);
    raw.set(header, 0);
    raw.set(change.content, header.length);
    const digest = await crypto.subtle.digest("SHA-1", raw);
    const oid = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    objects.push({ oid, type: "blob", data: change.content });
    leaf.set(name, { mode: "100644", oid });
  }

  // Bottom-up chain rebuild — deepest level first, every parent present; a
  // level emptied by a remove drops from its parent (git has no empty trees).
  for (let depth = segments.length - 1; depth >= 1; depth--) {
    const prefix = segments.slice(0, depth).join("/");
    const state = levels.get(prefix);
    if (state === undefined) continue;
    if (state.size === 0) {
      const parentPrefix = segments.slice(0, depth - 1).join("/");
      levels.get(parentPrefix)?.delete(segments[depth - 1] as string);
      continue;
    }
    const tree = serializeTree([...state.entries()].map(([entryName, entry]) => ({ name: entryName, mode: entry.mode, oid: entry.oid })));
    objects.push({ oid: tree.oid, type: tree.type, data: tree.data });
    const parentPrefix = segments.slice(0, depth - 1).join("/");
    levels.get(parentPrefix)?.set(segments[depth - 1] as string, { mode: "40000", oid: tree.oid });
  }

  const rootEntries = levels.get("");
  if (rootEntries === undefined) return null;
  const rootTree = serializeTree([...rootEntries.entries()].map(([entryName, entry]) => ({ name: entryName, mode: entry.mode, oid: entry.oid })));
  objects.push({ oid: rootTree.oid, type: rootTree.type, data: rootTree.data });

  if (head !== null && rootTree.oid === head.tree) {
    return { objects: [], commitOid: "", expectedOld: tipOid ?? ZERO_OID, treeOid: rootTree.oid, unchanged: true };
  }
  const commit = serializeCommit({
    tree: rootTree.oid,
    parents: head === null ? [] : [head.oid],
    author: spec.person,
    committer: spec.person,
    message: spec.message,
  });
  objects.push({ oid: commit.oid, type: commit.type, data: commit.data });
  return { objects, commitOid: commit.oid, expectedOld: head === null ? ZERO_OID : head.oid, treeOid: rootTree.oid, unchanged: false };
}

/**
 * Land one change on the mirror branch: resolve the tip, build on it,
 * `putApiObjects` + `commitApiChange` CAS — ONE rebuild-retry on
 * `ref_conflict` (two publishes racing the same owner's mirror; the loser
 * rebuilds atop the winner's commit — upstream's serialize-by-reclone
 * `alterRepositoryContent` shape reduced to a bounded retry). A build that
 * changes nothing lands nothing ("unchanged").
 */
async function landIndexChange(landing: IndexLanding, change: IndexChange): Promise<IndexLandingResult> {
  const spec = { message: landing.message, person: landing.person };
  for (let attempt = 0; attempt < 2; attempt++) {
    const tip = refTipMap(await landing.reads.listRefs()).get(CARGO_INDEX_REF);
    const built = await buildMirrorChangeCommit(landing.reads, tip?.target ?? null, change, spec);
    if (built === null) return { tag: "refused", reason: "mirror tip vanished" };
    if (built.unchanged) return { tag: "unchanged" };

    const stored = await landing.cell.putApiObjects(built.objects);
    if (stored.tag === "too_large") return { tag: "too_large", limitBytes: stored.limitBytes };
    if (stored.tag === "invalid") return { tag: "refused", reason: stored.reason };
    const landed = await landing.cell.commitApiChange({ ref: CARGO_INDEX_REF, expectedOldOid: built.expectedOld, newOid: built.commitOid });
    if (landed.tag === "committed") return { tag: "committed", newOid: landed.newOid };
    if (landed.tag === "ref_conflict" && attempt === 0) continue;
    return { tag: "refused", reason: landed.tag };
  }
  return { tag: "refused", reason: "conflict retries exhausted" };
}

// ---------------------------------------------------------------------------
// ensure-mirror — `InitializeIndexRepository` (index.go:50-61)
// ---------------------------------------------------------------------------

export type CargoIndexEnsureResult =
  | { tag: "created"; commitOid: string }
  | { tag: "updated"; commitOid: string }
  | { tag: "current" }
  | { tag: "refused"; reason: string }
  | { tag: "skipped" };

/**
 * `InitializeIndexRepository` (index.go:50-61): get-or-create the owner's
 * mirror repository and commit `config.json` on the default branch. Upstream
 * commits on EVERY initialize click (alterRepositoryContent always commits,
 * even a no-diff tree, index.go:242-258); ours lands the config commit only
 * when the bytes differ (the write seam's unchanged detection), so a
 * re-initialize over a current config answers `current` instead of stacking
 * an empty commit — the one micro-divergence, disclosed. Refuses (logged
 * skip) when a user-owned repositories row occupies the address.
 */
export async function ensureCargoIndexMirror(
  bindings: CargoIndexBindings,
  d1: D1Database,
  ownerId: number,
  options?: { doerId?: number; now?: number },
): Promise<CargoIndexEnsureResult> {
  const ownerRow = await loadOwnerRow(d1, ownerId);
  if (ownerRow === null) return { tag: "skipped" };
  if (await cargoIndexAddressOwned(d1, ownerId)) {
    console.log(
      `[packages-cargo-index] ensure skipped: a repositories row occupies ${ownerRow.usernameLower}/_cargo-index (user-owned; the rowless mirror refuses)`,
    );
    return { tag: "refused", reason: "address user-owned" };
  }
  const reads = indexReads(bindings, ownerRow.usernameLower);
  const born = refTipMap(await reads.listRefs()).has(CARGO_INDEX_REF);
  const landing: IndexLanding = {
    reads,
    cell: indexCell(bindings, ownerRow.usernameLower),
    person: await indexPerson(d1, ownerRow, bindings, options?.doerId, options?.now),
    message: "Initialize Cargo Config",
  };
  const result = await landIndexChange(landing, {
    path: CARGO_CONFIG_FILE_NAME,
    content: cargoIndexConfigBytes(ownerRow, bindings.origin),
  });
  if (result.tag === "committed") return { tag: born ? "updated" : "created", commitOid: result.newOid };
  if (result.tag === "unchanged") return { tag: "current" };
  if (result.tag === "too_large") return { tag: "refused", reason: "too_large" };
  if (result.tag === "refused") return { tag: "refused", reason: result.reason };
  return { tag: "skipped" };
}

// ---------------------------------------------------------------------------
// update-mirror — `UpdatePackageIndexIfExists`'s present arm (index.go:108-134)
// ---------------------------------------------------------------------------

export type CargoIndexUpdateResult =
  | { tag: "committed"; commitOid: string }
  | { tag: "removed"; commitOid: string }
  | { tag: "absent" }
  | { tag: "unchanged" }
  | { tag: "refused"; reason: string }
  | { tag: "skipped" };

/**
 * The present arm of `UpdatePackageIndexIfExists` — ONE package file
 * rewritten from D1 (the incremental adjudication). The unborn mirror is the
 * upstream repo-absent arm: return without creating (index.go:108-111, the
 * comment verbatim: "We do not want to force the creation of the repo here").
 * Zero versions → the file is REMOVED (the adjudicated divergence — upstream
 * leaves the stale file until a Rebuild; index.go:203-205). Identical bytes
 * land nothing.
 */
export async function updateCargoIndexMirror(
  bindings: CargoIndexBindings,
  d1: D1Database,
  ownerId: number,
  pkg: PackageRow,
  options?: { doerId?: number; now?: number },
): Promise<CargoIndexUpdateResult> {
  const ownerRow = await loadOwnerRow(d1, ownerId);
  if (ownerRow === null) return { tag: "skipped" };
  if (await cargoIndexAddressOwned(d1, ownerId)) {
    console.log(
      `[packages-cargo-index] update skipped: a repositories row occupies ${ownerRow.usernameLower}/_cargo-index (user-owned; the rowless mirror refuses)`,
    );
    return { tag: "refused", reason: "address user-owned" };
  }
  const reads = indexReads(bindings, ownerRow.usernameLower);
  const tip = refTipMap(await reads.listRefs()).get(CARGO_INDEX_REF);
  if (tip === undefined) {
    // index.go:108-111 — the repo-absent arm: no forced creation.
    return { tag: "absent" };
  }
  const path = buildCargoPackagePath(pkg.lowerName);
  const content = await buildCargoPackageIndex(d1, pkg);
  const landing: IndexLanding = {
    reads,
    cell: indexCell(bindings, ownerRow.usernameLower),
    person: await indexPerson(d1, ownerRow, bindings, options?.doerId, options?.now),
    message: `Update ${pkg.name}`,
  };

  if (content !== null) {
    const result = await landIndexChange(landing, { path, content: new TextEncoder().encode(content) });
    return mapLanding(result, "committed");
  }

  // Zero versions — remove the file when it exists (the adjudicated arm).
  const result = await landIndexChange(landing, { path });
  return mapLanding(result, "removed");
}

function mapLanding(result: IndexLandingResult, commitTag: "committed" | "removed"): CargoIndexUpdateResult {
  if (result.tag === "committed") return { tag: commitTag, commitOid: result.newOid };
  if (result.tag === "unchanged") return { tag: "unchanged" };
  if (result.tag === "too_large") return { tag: "refused", reason: "too_large" };
  return { tag: "refused", reason: result.reason };
}

// ---------------------------------------------------------------------------
// rebuild — `RebuildIndex` (index.go:63-106), the operator action
// ---------------------------------------------------------------------------

export type CargoIndexRebuildResult =
  | { tag: "committed"; commitOid: string; files: number }
  | { tag: "too_large"; limitBytes: number }
  | { tag: "refused"; reason: string }
  | { tag: "skipped" };

/**
 * `RebuildIndex` (index.go:63-106): one commit replacing the whole tree —
 * every existing file except `config.json` dropped ("Remove all existing
 * content but the Cargo config", index.go:80-90), every package with versions
 * re-added from D1. Get-or-create: a fresh mirror takes the config root
 * commit first, then the full tree (upstream's `t.Clone` branch-not-exist →
 * `t.Init` arm, index.go:269-276). Emptied packages naturally vanish — the
 * rebuild is where upstream's stale-file quirk gets cleaned, and our write
 * arm agrees with this shape (the remove-on-empty adjudication).
 */
export async function rebuildCargoIndexMirror(
  bindings: CargoIndexBindings,
  d1: D1Database,
  ownerId: number,
  options?: { doerId?: number; now?: number },
): Promise<CargoIndexRebuildResult> {
  const ownerRow = await loadOwnerRow(d1, ownerId);
  if (ownerRow === null) return { tag: "skipped" };
  if (await cargoIndexAddressOwned(d1, ownerId)) {
    console.log(
      `[packages-cargo-index] rebuild skipped: a repositories row occupies ${ownerRow.usernameLower}/_cargo-index (user-owned; the rowless mirror refuses)`,
    );
    return { tag: "refused", reason: "address user-owned" };
  }
  const reads = indexReads(bindings, ownerRow.usernameLower);
  const person = await indexPerson(d1, ownerRow, bindings, options?.doerId, options?.now);
  const configBytes = cargoIndexConfigBytes(ownerRow, bindings.origin);

  // Get-or-create: land the config on an unborn mirror first (upstream's
  // InitializeIndexRepository step inside RebuildIndex's getOrCreate).
  const before = refTipMap(await reads.listRefs()).get(CARGO_INDEX_REF);
  if (before === undefined) {
    const landing: IndexLanding = { reads, cell: indexCell(bindings, ownerRow.usernameLower), person, message: "Initialize Cargo Config" };
    const seeded = await landIndexChange(landing, { path: CARGO_CONFIG_FILE_NAME, content: configBytes });
    if (seeded.tag === "too_large") return { tag: "too_large", limitBytes: seeded.limitBytes };
    if (seeded.tag === "refused") return { tag: "refused", reason: `seed: ${seeded.reason}` };
    if (seeded.tag !== "committed") return { tag: "refused", reason: "seed" };
  }

  const tip = refTipMap(await reads.listRefs()).get(CARGO_INDEX_REF);
  if (tip === undefined) return { tag: "refused", reason: "seed tip vanished" };

  // The tree content: config.json from the LIVE cell when its bytes differ
  // from ours is kept as-is upstream (RebuildIndex only preserves the file,
  // never rewrites it — index.go:86-91), so read the stored bytes back.
  const storedConfig = await reads.readBlob(tip.target, CARGO_CONFIG_FILE_NAME);
  const files: { path: string; bytes: Uint8Array }[] = [
    { path: CARGO_CONFIG_FILE_NAME, bytes: storedConfig?.data ?? configBytes },
  ];

  const pkgs = await drizzle(d1)
    .select()
    .from(packages)
    .where(and(eq(packages.ownerId, ownerId), eq(packages.type, "cargo")))
    .all();
  for (const pkg of pkgs) {
    const content = await buildCargoPackageIndex(d1, pkg);
    if (content === null) continue;
    files.push({ path: buildCargoPackagePath(pkg.lowerName), bytes: new TextEncoder().encode(content) });
  }

  // The full tree, built from scratch (upstream's empty-temp-index shape).
  const objects: ApiObject[] = [];
  const rootTree = await serializeDirTree(files, objects);
  const commit = serializeCommit({
    tree: rootTree,
    parents: [tip.target],
    author: person,
    committer: person,
    message: "Rebuild Cargo Index",
  });
  objects.push({ oid: commit.oid, type: commit.type, data: commit.data });

  const cell = indexCell(bindings, ownerRow.usernameLower);
  const stored = await cell.putApiObjects(objects);
  if (stored.tag === "too_large") return { tag: "too_large", limitBytes: stored.limitBytes };
  if (stored.tag === "invalid") return { tag: "refused", reason: stored.reason };
  const landed = await cell.commitApiChange({ ref: CARGO_INDEX_REF, expectedOldOid: tip.target, newOid: commit.oid });
  if (landed.tag !== "committed") {
    // The explicit operator action does not retry-loop; re-run heals.
    return { tag: "refused", reason: landed.tag };
  }
  return { tag: "committed", commitOid: landed.newOid, files: files.length };
}

/** Nested-tree builder: insert every (path → blob), serialize bottom-up (the
 *  engine sorts each level canonically), pushing intermediate trees into
 *  `objects`. Returns the root tree oid. */
async function serializeDirTree(
  files: { path: string; bytes: Uint8Array }[],
  objects: ApiObject[],
): Promise<string> {
  type DirNode = Map<string, DirNode | { mode: string; oid: string }>;
  const root: DirNode = new Map();
  for (const file of files) {
    const segments = file.path.split("/").filter((segment) => segment.length > 0);
    const name = segments[segments.length - 1] as string;
    let node = root;
    for (const dir of segments.slice(0, -1)) {
      const next = node.get(dir);
      if (next === undefined || next instanceof Map) {
        const created: DirNode = new Map();
        node.set(dir, created);
        node = created;
      } else {
        // a blob where a directory belongs — impossible from our path shapes
        throw new Error(`cargo-index: path collision at ${file.path}`);
      }
    }
    const header = new TextEncoder().encode(`blob ${file.bytes.byteLength}\0`);
    const raw = new Uint8Array(header.length + file.bytes.byteLength);
    raw.set(header, 0);
    raw.set(file.bytes, header.length);
    const digest = await crypto.subtle.digest("SHA-1", raw);
    const oid = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    objects.push({ oid, type: "blob", data: file.bytes });
    node.set(name, { mode: "100644", oid });
  }

  const serialize = (node: DirNode): string => {
    const entries = [...node.entries()].map(([name, child]) => {
      if (child instanceof Map) return { name, mode: "40000", oid: serialize(child) };
      return { name, mode: child.mode, oid: child.oid };
    });
    const tree = serializeTree(entries);
    objects.push({ oid: tree.oid, type: tree.type, data: tree.data });
    return tree.oid;
  };
  return serialize(root);
}
