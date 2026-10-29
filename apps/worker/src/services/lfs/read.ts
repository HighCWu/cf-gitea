/**
 * The settings-LFS read family (census R11 — upstream
 * `routers/web/repo/setting/lfs.go`): the worker side of the ratified scan
 * split (SPEC-0015 §2.3/§3.3). The engine (fdfe73a) returns every size-gated
 * candidate blob RAW (`scanLfsPointers`); THIS module parses with the landed
 * pointer grammar (services/lfs/pointer.ts — SPEC-0006's pointer.go port),
 * joins `lfsObjects`, and serves the four read surfaces the settings LFS
 * pages render:
 *
 *   - `listLfsMetaObjects` — the paged per-repo meta-object listing
 *     (LFSFiles, lfs.go:44-68: CountLFSMetaObjects + GetLFSMetaObjects).
 *   - `loadLfsPointerRows` — the pointers scan (LFSPointerFiles,
 *     lfs.go:389-495: SearchPointerBlobs + the InRepo/Exists/Accessible
 *     joins and the found/associated/unassociated/missing counters).
 *   - `loadLfsObjectContent` — the detail view's content read (LFSFileGet,
 *     lfs.go:230-315: ReadMetaObject + the text/type sniff).
 *   - `findLfsPointerCommits` — the reverse map (LFSFileFind, lfs.go:349-386:
 *     the canonical pointer's blob identity over FindLFSFile).
 *
 * The write arms (LFSDelete, LFSAutoAssociate, the locks trio) stay out of
 * this wave — read-only pages (the census's ratified split). The locks
 * settings page in particular has NO substrate at this pin: the LFS locks
 * API is a 501 defer (SPEC-0006 §2.7 P2; src/lfs/router.ts:432), so the
 * census impact table's "locks already landed" reads the PLAN, not the pin —
 * the pages render no Locks anchor (the dead-link rule).
 *
 * All D1 access goes through Drizzle (the AGENTS boundary); blob access goes
 * through the injected `LfsStore`; the engine answers through the injected
 * `scan` seam (structurally the `EngineClient.scanLfsPointers` member —
 * ui/engine.ts owns the wrapper, this module never imports the ui layer).
 */

import { and, asc, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { LfsPointerScanResult } from "@cf-gitea/git-engine";

import { lfsObjects } from "../../db/schema";
import { InvalidPointerError, NotAPointerError, parsePointer, pointerBlobSha1 } from "./pointer";
import { lfsKey, type LfsObjectStat, type LfsStore } from "./store";

/** The engine scan seam — structurally `EngineClient.scanLfsPointers`. */
export type LfsPointerScan = (
  ref: string | undefined,
  opts?: { path?: string; oid?: string },
) => Promise<LfsPointerScanResult | null>;

/** ExplorePagingNum's default (modules/setting/ui.go:87) — the settings LFS
 *  list's page size (lfs.go:57/60 build the pager on it). */
export const LFS_LIST_PAGE_SIZE = 20;

/** The detail view's text-render ceiling — upstream MaxDisplayFileSize
 *  (modules/setting/ui.go:98, 8 MiB): a text object at or over it renders
 *  the "file is too large" arm instead of the content table. */
export const LFS_DETAIL_MAX_DISPLAY_BYTES = 8 * 1024 * 1024;

/** Ref tips the find arm scans (the default branch first, then branches,
 *  then tags) — upstream FindLFSFile walks `rev-list --all`, an unbounded
 *  every-commit × every-tree walk this engine cannot express; the tip-scan
 *  port pays one flattenTree per ref under this cap (the census R11 hedge:
 *  "may honest-absent on slice one" — this is the slice-one budget). */
export const LFS_FIND_REF_SCAN_MAX = 10;

// ---------------------------------------------------------------------------
// The meta-object listing (LFSFiles, lfs.go:44-68)
// ---------------------------------------------------------------------------

/** One row of the settings list (lfs.tmpl: oid label, size, created). */
export interface LfsMetaListItem {
  oid: string;
  size: number;
  createdAt: Date;
}

/**
 * The paged listing — CountLFSMetaObjects + GetLFSMetaObjects (lfs.go:50-64).
 * Upstream's xorm Find carries no ORDER BY (natural key order); ours pins
 * `oid` ASC — the composite PK's second column, i.e. the deterministic order
 * that scan actually answers — so the pager is stable page-to-page.
 * `page` is 1-based; `max(FormInt("page"), 1)` is the caller's clamp.
 */
export async function listLfsMetaObjects(
  d1: D1Database,
  repoId: number,
  page: number,
  pageSize: number = LFS_LIST_PAGE_SIZE,
): Promise<{ total: number; rows: LfsMetaListItem[] }> {
  const db = drizzle(d1);
  const filtered = eq(lfsObjects.repoId, repoId);
  const totalRow = await db.select({ n: count() }).from(lfsObjects).where(filtered).get();
  const total = totalRow?.n ?? 0;
  const rows =
    total === 0
      ? []
      : await db
          .select({ oid: lfsObjects.oid, size: lfsObjects.size, createdAt: lfsObjects.createdAt })
          .from(lfsObjects)
          .where(filtered)
          .orderBy(asc(lfsObjects.oid))
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .all();
  return { total, rows };
}

// ---------------------------------------------------------------------------
// The pointers scan (LFSPointerFiles, lfs.go:389-495)
// ---------------------------------------------------------------------------

/** One rendered pointers-table row (lfs.go:408-416's pointerResult). */
export interface LfsPointerRow {
  /** The GIT blob oid of the pointer FILE (the SHA column — links the raw
   *  blob view). */
  blobSha: string;
  /** An in-tree path carrying the pointer (upstream's scan is object-keyed
   *  and pathless; the tree-walk engine answer's first path in tree order
   *  stands as the row's representative path). */
  path: string;
  /** The LFS oid — the parsed `oid sha256:<hex>` (the OID column). */
  oid: string;
  /** The LFS size — the parsed `size <n>`. */
  size: number;
  /** A `lfs_objects` row exists for (repo, oid) — GetLFSMetaObjectByOid's
   *  hit (lfs.go:432-438). */
  inRepo: boolean;
  /** The content store holds the object's bytes (lfs.go:440 — contentStore.
   *  Exists). */
  exists: boolean;
  /** Exists && !InRepo && fixable — the associate arm's predicate
   *  (lfs.go:445-462; the arm itself stays unrendered this wave). */
  associatable: boolean;
  /** InRepo || Associatable (lfs.go:464). */
  accessible: boolean;
}

/** The header counters (lfs.go:480-484). */
export interface LfsPointerCounters {
  numPointers: number;
  numAssociated: number;
  numAssociatable: number;
  numNoExist: number;
  numNotAssociated: number;
}

/** The scan answer: `null` = the engine's unresolvable-ref/empty-repo ladder
 *  (the page 404-shells — an LFS settings view of a nonexistent history);
 *  `truncated` surfaces the engine's budget honesty to the header. */
export type LfsPointerScanAnswer =
  | { answer: null }
  | { answer: { pointers: LfsPointerRow[]; counters: LfsPointerCounters; truncated: boolean } };

/**
 * The scan + join. Engine candidates are SIZE-gated and GRAMMAR-AGNOSTIC —
 * this side parses each (`parsePointer`; non-pointer and malformed
 * candidates skip silently, exactly upstream's `pointer, _ :=
 * ReadPointerFromBuffer(...); if !pointer.IsValid() { continue }`,
 * pointer_scanner.go:83-86), dedups by GIT blob oid (upstream's scan is
 * object-keyed — one row per unique pointer blob — while the tree-walk
 * engine answer yields one candidate per path), then joins:
 *
 *   - InRepo: the PK lookup over `lfs_objects` (lfs.go:432-438).
 *   - Exists: the store HEAD (lfs.go:440).
 *   - Associatable: Exists && !InRepo && (admin-sees-any-row ||
 *     no-row-anywhere). Upstream's mid term — LFSObjectAccessible's
 *     AccessibleRepositoryCondition join (lfs.go:450-459) — cannot be
 *     expressed at this pin: `lfs_objects.repo_id` is the numeric
 *     lfsRepoId bridge (router.ts:563), not a joinable `repositories.id`
 *     FK, so "a row in another repo this viewer can read" is not a single
 *     indexed query. The two decisive arms port exactly (unassociated →
 *     associatable for everyone; site-admin → any row); the mid term
 *     honest-absents to false (the divergence-ledger record; the associate
 *     arm that would consume it stays unrendered this wave).
 *   - Accessible = InRepo || Associatable (lfs.go:464).
 */
export async function loadLfsPointerRows(
  d1: D1Database,
  store: LfsStore,
  scan: LfsPointerScan,
  options: { repoId: number; storageKey: string; ref?: string; viewerIsAdmin: boolean },
): Promise<LfsPointerScanAnswer> {
  const result = await scan(options.ref ?? undefined);
  if (result === null) return { answer: null };

  // The candidate set can hold one row per path; upstream's table is one row
  // per unique pointer blob — dedup by GIT blob oid, first (tree order) wins.
  const seen = new Set<string>();
  const pointers: LfsPointerRow[] = [];
  const counters: LfsPointerCounters = {
    numPointers: 0,
    numAssociated: 0,
    numAssociatable: 0,
    numNoExist: 0,
    numNotAssociated: 0,
  };

  for (const candidate of result.candidates) {
    if (seen.has(candidate.oid)) continue;
    const pointer = (() => {
      try {
        return parsePointer(candidate.data);
      } catch (error) {
        // NotAPointerError (plain small text/binary) AND InvalidPointerError
        // (pointer-shaped but malformed) both skip — upstream's
        // ReadPointerFromBuffer error is discarded and IsValid() gates.
        if (error instanceof NotAPointerError || error instanceof InvalidPointerError) return null;
        throw error;
      }
    })();
    if (pointer === null) continue;
    seen.add(candidate.oid);

    const inRepo = await getLfsMetaObject(d1, options.repoId, pointer.oid) !== null;

    let stat: LfsObjectStat | null;
    try {
      stat = await store.head(lfsKey(options.storageKey, pointer.oid));
    } catch {
      stat = null; // a store failure reads as "not in store" — the Exists column's degraded arm
    }
    const exists = stat !== null;

    const associatable =
      exists && !inRepo && (options.viewerIsAdmin || !(await lfsObjectExistsAnywhere(d1, pointer.oid)));

    counters.numPointers++;
    if (inRepo) counters.numAssociated++;
    if (!exists) counters.numNoExist++;
    if (associatable) counters.numAssociatable++;
    pointers.push({
      blobSha: candidate.oid,
      path: candidate.path,
      oid: pointer.oid,
      size: pointer.size,
      inRepo,
      exists,
      associatable,
      accessible: inRepo || associatable,
    });
  }
  counters.numNotAssociated = counters.numPointers - counters.numAssociated;
  return { answer: { pointers, counters, truncated: result.truncated } };
}

// ---------------------------------------------------------------------------
// The detail view's content read (LFSFileGet, lfs.go:230-315)
// ---------------------------------------------------------------------------

/** The detail content's render arm (lfs_file.tmpl's branch set). */
export type LfsObjectContent =
  | { kind: "text"; lines: string[] }
  | { kind: "binary" }
  | { kind: "too-large" }
  | { kind: "empty" };

/**
 * The stored object's bytes → the detail render arm. Upstream reads the
 * META OBJECT's content (ReadMetaObject — the content store, lfs.go:256),
 * sniffs the first 1024 bytes (typesniffer) and renders text as the
 * line-numbered table, media as the view-raw embeds, everything else as the
 * View Raw link. Our port keeps the same branches with a vocabulary-port
 * sniff (a NUL byte anywhere in the stored bytes = binary — render-files.ts's
 * isBinaryData rule; the store read is bounded by the too-large guard
 * above): text (decoded UTF-8 with replacement, split to lines) vs binary;
 * the too-large and empty arms are the template's exact size guards
 * (IsFileTooLarge at MaxDisplayFileSize; `not .FileSize` → fileisempty).
 * Callers resolve `binary` to the View Raw link arm.
 */
export async function loadLfsObjectContent(
  store: LfsStore,
  storageKey: string,
  oid: string,
  size: number,
): Promise<LfsObjectContent> {
  if (size === 0) return { kind: "empty" }; // lfs_file.tmpl:19 `not .FileSize` → shared/fileisempty
  if (size > LFS_DETAIL_MAX_DISPLAY_BYTES) return { kind: "too-large" }; // lfs.go:282 IsFileTooLarge
  const object = await store.get(lfsKey(storageKey, oid));
  if (object === null) return { kind: "binary" }; // row-without-bytes race — the raw-link arm
  const bytes = new Uint8Array(await object.arrayBuffer());
  let hasNull = false;
  for (const b of bytes) {
    if (b === 0) {
      hasNull = true;
      break;
    }
  }
  if (hasNull) return { kind: "binary" };
  const lines = new TextDecoder("utf-8").decode(bytes).split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop(); // the trailing-newline row upstream's writer skips
  return { kind: "text", lines };
}

// ---------------------------------------------------------------------------
// The reverse map (LFSFileFind, lfs.go:349-386)
// ---------------------------------------------------------------------------

/** One find-table row (lfs_file_find.tmpl:9-36). */
export interface LfsFindResult {
  /** The in-tree path (the octicon-file cell's link). */
  path: string;
  /** The introducing commit's oid (the row's commit links). */
  sha: string;
  /** The commit subject (the message cell). */
  summary: string;
  /** The commit's author time, unix seconds (DateUtils.TimeSince). */
  when: number;
  /** The commit's recorded timezone offset (TimeSince's own-offset format). */
  tz: string;
  /** The commit's parents (the parent labels). */
  parentHashes: string[];
  /** The ref tip where the path matched — fillResultNameRev's BranchName
   *  reduced to the finding ref's short name. */
  branchName: string;
}

/** The structural slice of `CommitJson` the find rows read. */
export interface LfsFindCommit {
  oid: string;
  subject: string;
  parents: string[];
  author: { time: number; tz: string };
}

/** The structural slice of `RefsResult` the find arm reads. */
export interface LfsFindRefs {
  head: string | null;
  refs: { name: string; target: string }[];
}

/** The structural slice of `EngineClient.listTreeCommits` the find arm reads. */
export type LfsFindTreeCommits = (
  ref: string | undefined,
  paths: string[],
) => Promise<{ commits: (LfsFindCommit | null)[] } | null>;

/**
 * The canonical-pointer identity (lfs.go:366-368: ComputeBlobHash over
 * `Pointer{Oid, Size}.StringContent()` — the CANONICAL serialization, so a
 * non-canonical pointer file's blob never matches, ours nor upstream's) and
 * the tip-scan port of FindLFSFile: refs under LFS_FIND_REF_SCAN_MAX, each
 * scanned with the engine's git-oid filter (the grammar-free reading of the
 * ratified split — the engine compares the candidate's TREE ENTRY oid, the
 * exact identity upstream's tree walk compares), paths deduped per ref, and
 * the per-path introducing commit answered by the batched `listTreeCommits`
 * (the first commit that touched the path — FindLFSFile's parent-reduction,
 * lfs_find.go:134-144, reduced to the finding ref's history line). Results
 * sort oldest-first (lfsResultSlice.Less). The callers' oid/size guards are
 * upstream's 404 arms (lfs.go:356-359).
 */
export async function findLfsPointerCommits(
  scan: LfsPointerScan,
  refs: LfsFindRefs,
  listTreeCommits: LfsFindTreeCommits,
  oid: string,
  size: number,
  sha?: string,
): Promise<LfsFindResult[]> {
  const targetBlobSha = sha && sha !== "" ? sha : await pointerBlobSha1({ oid, size });

  // The scan order — HEAD's branch first (name-rev's preference shape), then
  // the remaining branch refs, then tags, all under the ref budget.
  const branchNames = refs.refs.filter((r) => r.name.startsWith("refs/heads/")).map((r) => r.name);
  const ordered = [
    ...(refs.head !== null ? [refs.head] : []),
    ...branchNames.filter((name) => name !== refs.head),
    ...refs.refs.filter((r) => r.name.startsWith("refs/tags/")).map((r) => r.name),
  ].slice(0, LFS_FIND_REF_SCAN_MAX);

  const pathToRef = new Map<string, string>();
  for (const ref of ordered) {
    const result = await scan(ref, { oid: targetBlobSha });
    if (result === null) continue;
    for (const candidate of result.candidates) {
      if (!pathToRef.has(candidate.path)) pathToRef.set(candidate.path, ref);
    }
  }
  if (pathToRef.size === 0) return [];

  const paths = [...pathToRef.keys()];
  const firstRef = pathToRef.get(paths[0] as string) ?? "";
  const batch = await listTreeCommits(firstRef, paths);
  if (batch === null) return [];
  const results: LfsFindResult[] = [];
  for (let i = 0; i < paths.length; i++) {
    const commit = batch.commits[i];
    if (commit === null || commit === undefined) continue;
    const findingRef = pathToRef.get(paths[i] as string) ?? firstRef;
    results.push({
      path: paths[i] as string,
      sha: commit.oid,
      summary: commit.subject,
      when: commit.author.time,
      tz: commit.author.tz,
      parentHashes: commit.parents,
      branchName: shortRefName(findingRef),
    });
  }
  results.sort((a, b) => a.when - b.when); // lfsResultSlice: oldest first
  return results;
}

/** name-rev's short shape — `refs/heads/main` → `main`, `refs/tags/v1` →
 *  `v1`; a raw oid ref renders as itself. */
function shortRefName(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return ref;
}

// ---------------------------------------------------------------------------
// The per-oid joins shared by the scan + detail arms
// ---------------------------------------------------------------------------

/**
 * The repo-scoped meta read (GetLFSMetaObjectByOid, models/git/lfs.go:124 —
 * any row for (repoID, oid); a miss is the handler's NotFound). The landed
 * `LfsStateService.get` answers the same PK read; this module keeps its own
 * select so the read family has ONE file (the mission's new-module
 * ownership) without touching the landed service.
 */
export async function getLfsMetaObject(d1: D1Database, repoId: number, oid: string) {
  return (
    (
      await drizzle(d1)
        .select()
        .from(lfsObjects)
        .where(and(eq(lfsObjects.repoId, repoId), eq(lfsObjects.oid, oid)))
        .limit(1)
        .all()
    )[0] ?? null
  );
}

/** Any-repo row probe (ExistsLFSObject, models/git/lfs.go:207-209) — the
 *  associatable join's existsAnywhere arm. */
export async function lfsObjectExistsAnywhere(d1: D1Database, oid: string): Promise<boolean> {
  return (
    (await drizzle(d1).select({ oid: lfsObjects.oid }).from(lfsObjects).where(eq(lfsObjects.oid, oid)).limit(1).all())
      .length > 0
  );
}
