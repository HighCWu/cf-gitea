/**
 * Repo licenses storage + detection (long-tail batch; the `repo_license`
 * table of migration 0027). Upstream: the table is the PUSH-time product of
 * services/repository/license.go — resolveLicenses walks the default branch's
 * tree, matches license files against the licenseclassifier corpus, and
 * UpdateRepoLicenses diffs the rows (models/repo/license.go:81-122);
 * `GET /repos/{owner}/{repo}/licenses` reads the rows (GetRepoLicenses,
 * :66-73, `ORDER BY license ASC`).
 *
 * WHAT IS PORTED HERE:
 *   - the table, the GetRepoLicenses read, the UpdateRepoLicenses diff and
 *     CleanRepoLicenses;
 *   - the REUSE arm (LICENSES/ directory — license.go:112-131, SPDX ID = the
 *     file stem, NO classifier needed) and the license-FILE-name predicate
 *     isLicenseFile (license.go:139-149) — exact ports;
 *   - `detectLicenseText` — the corpus MATCHER, ported as a SPARSE-corpus
 *     detector over `license-corpus.ts` (the full detection pipeline below);
 *   - `syncRepoLicensesFromCell` — the PUSH arm's engine-side walk: resolve
 *     the default-branch tip, run the REUSE/file resolution, feed
 *     updateRepoLicenses. Wired into the engine's onPush settle seam at
 *     services/webhooks-push.ts `handleUserPushEvent` (upstream
 *     push.go:160-174 enqueues its license updater queue for exactly the
 *     same delta shape: a default-branch create/update — deletes and other
 *     refs never re-run detection; the queue consumer's empty-repo skip,
 *     license.go:79-81, becomes the unborn-tip guard — the full statement
 *     lives on syncRepoLicensesFromCell).
 *
 * THE DETECTOR — documented divergence from upstream's classifier. Upstream
 * embeds github.com/google/licenseclassifier v2 with the FULL 27-file corpus
 * (InitLicenseClassifier, license.go:47-64, `NewClassifier(.85)`; corpus =
 * gitea/options/license/*). Porting that engine is out of scope; ours is a
 * normalized-token coverage matcher over a SPARSE corpus (the mission's most
 * common SPDX list, transcribed from the same options dir — see
 * license-corpus.ts). Consequences, stated honestly:
 *   - licenses outside the sparse corpus answer no-match (the table is
 *     extensible — append a corpus entry);
 *   - matching is LCS token coverage (corpus tokens matched in order inside
 *     the candidate / corpus token count) at upstream's threshold 0.85
 *     (license.go:48-49 "threshold should be 0.84~0.86"), with two
 *     specificity rules the raw threshold needs:
 *       (a) near-max dominance — a match more than 0.03 below the best
 *           coverage is dropped (kills the AGPL-vs-GPL-3.0 and GPL-3.0-vs-
 *           AGPL cross-matches, which sit at 0.91-0.93 by text overlap);
 *       (b) corpus subsumption — when two matches survive (a) and one
 *           corpus's text is verbatim-contained (LCS ≥ 0.98) inside the
 *           other's, only the longer (more specific) corpus is reported
 *           (kills BSD-2-Clause matching a BSD-3-Clause file at 1.00 — the
 *           2-clause text is verbatim inside the 3-clause one, and GPL-3.0
 *           inside upstream's combined LGPL-3.0 corpus file, which embeds
 *           the GPL text). Upstream's classifier resolves the same
 *           collisions inside its engine; rule (a)'s cut and rule (b)'s
 *           "report the specific license only" (vs upstream reporting BOTH
 *           for a combined LGPL-3.0 file) are the deliberate divergences.
 *   - bounded analysis: candidates whose LCS would exceed 96M cells (file ≳
 *     110KB against the largest corpus entry) are skipped for that entry —
 *     the classifier streams instead; practical license files never hit the
 *     cap. Worst realistic CPU is a full GPL-family scan, ~0.5s, run only on
 *     default-branch pushes inside the onPush waitUntil.
 */

import { and, asc, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repoLicenses } from "../db/schema";
import { LICENSE_CORPUS_TEXTS } from "./license-corpus";

export type RepoLicenseRow = typeof repoLicenses.$inferSelect;

/** Upstream DetectedLicense (models/repo/license.go:39-45). */
export interface DetectedLicense {
  /** SPDXID of the license. */
  spdxId: string;
  /** Repo-relative path to the license. */
  licensePath: string;
}

/** REUSE license spec directory (license.go:29-31, LicenseReuseDir). */
export const LICENSE_REUSE_DIR = "LICENSES";

/**
 * One entry of the fixture/candidate tree the resolver walks. `read` is
 * only called for root-level license-file candidates (never for REUSE-dir
 * files — the REUSE SPDX id comes from the file NAME).
 */
export interface LicenseTreeEntry {
  /** Repo-relative slash path, e.g. "LICENSE", "LICENSES/MIT.txt". */
  path: string;
  /** Regular-file predicate (upstream entry.IsRegular). */
  isRegular: boolean;
  read?: () => Promise<string> | string;
}

/** util.PathBaseStem (modules/util/path.go:32-34): base name minus ext. */
export function pathBaseStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * isLicenseFile (license.go:139-149): stem license|licence|copying, at most
 * one allowed extension (.md/.lesser/.txt or none). Case-insensitive.
 */
export function isLicenseFile(name: string): boolean {
  const lower = name.toLowerCase();
  const stem = pathBaseStem(lower);
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot) : "";
  return (
    (stem === "license" || stem === "licence" || stem === "copying") &&
    (ext === "" || ext === ".md" || ext === ".lesser" || ext === ".txt")
  );
}

/**
 * resolveLicenses (license.go:151-193) over a flat tree listing. REUSE first:
 * any LICENSES/ entry claims the whole resolution (upstream's early return
 * from the SubTree hit, :160-165) — every regular file under it becomes
 * DetectedLicense{SPDXID: file stem, LicensePath: full path} and root files
 * are ignored. Otherwise the root-level regular files that pass
 * isLicenseFile go to the detector; without one (or with no match) they are
 * skipped — no corpus, no invented SPDX ids.
 */
export async function resolveDetectedLicenses(
  entries: LicenseTreeEntry[],
  detectText?: (content: string) => string[],
): Promise<DetectedLicense[]> {
  const reuse = entries.filter((entry) => entry.path.startsWith(`${LICENSE_REUSE_DIR}/`));
  if (reuse.length > 0) {
    return reuse
      .filter((entry) => entry.isRegular)
      .map((entry) => ({ spdxId: pathBaseStem(entry.path), licensePath: entry.path }));
  }

  const detected: DetectedLicense[] = [];
  for (const entry of entries) {
    if (entry.path.includes("/")) continue; // root level only (upstream: root SubTree)
    if (!entry.isRegular || !isLicenseFile(entry.path)) continue;
    if (detectText === undefined || entry.read === undefined) continue;
    const content = await entry.read();
    for (const spdxId of detectText(content)) {
      detected.push({ spdxId, licensePath: entry.path });
    }
  }
  return detected;
}

/**
 * GetRepoLicenses (license.go:66-73): one repo's rows, `license` ascending —
 * the endpoint's exact read.
 */
export async function getRepoLicenses(d1: D1Database, repoId: string): Promise<RepoLicenseRow[]> {
  return drizzle(d1)
    .select()
    .from(repoLicenses)
    .where(eq(repoLicenses.repoId, repoId))
    .orderBy(asc(repoLicenses.license))
    .all();
}

/** CleanRepoLicenses (license.go:171-174): drop every row of the repo. */
export async function cleanRepoLicenses(d1: D1Database, repoId: string): Promise<void> {
  await drizzle(d1).delete(repoLicenses).where(eq(repoLicenses.repoId, repoId));
}

/**
 * UpdateRepoLicenses (license.go:81-122): the population diff the push arm
 * will call. Per incoming license — matching SPDX id updates commit_id +
 * license_path in place; a new SPDX id inserts; existing rows whose
 * commit_id fell behind the scan are deleted (the "moved past this commit"
 * sweep, :109-118).
 */
export async function updateRepoLicenses(
  d1: D1Database,
  repoId: string,
  commitId: string,
  licenses: DetectedLicense[],
): Promise<void> {
  const db = drizzle(d1);
  const oldRows = await db.select().from(repoLicenses).where(eq(repoLicenses.repoId, repoId)).all();
  const now = new Date();
  for (const license of licenses) {
    const existing = oldRows.find((row) => row.license === license.spdxId);
    if (existing !== undefined) {
      // Mutate the in-memory row like upstream (license.go:95-97: o.CommitID
      // / o.LicensePath are assigned BEFORE the UPDATE) — the delete sweep
      // below reads the same objects and must see the fresh commit_id.
      existing.commitId = commitId;
      existing.licensePath = license.licensePath;
      await db
        .update(repoLicenses)
        .set({ commitId, licensePath: license.licensePath, updatedAt: now })
        .where(eq(repoLicenses.id, existing.id));
      continue;
    }
    await db.insert(repoLicenses).values({
      repoId,
      commitId,
      license: license.spdxId,
      licensePath: license.licensePath,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const row of oldRows) {
    if (row.commitId !== commitId) {
      await db.delete(repoLicenses).where(and(eq(repoLicenses.id, row.id), ne(repoLicenses.repoId, "")));
    }
  }
}

// ---------------------------------------------------------------------------
// The corpus matcher (detectLicenseText) — see the module header for the
// sparse-corpus divergence statement. Pipeline: normalize both sides into
// lowercase alphanumeric tokens, measure LCS token coverage of each corpus
// entry inside the candidate, apply upstream's threshold, then the two
// specificity rules (near-max dominance, corpus subsumption).
// ---------------------------------------------------------------------------

/** Upstream's confidence threshold — license.go:48-49 (`NewClassifier(.85)`,
 *  "threshold should be 0.84~0.86 or the test will be failed"). */
export const LICENSE_MATCH_THRESHOLD = 0.85;

/** Near-max dominance cut: matches this far below the best coverage are
 *  dropped (module header rule (a); the empirical GPL/AGPL cross-coverage
 *  band is 0.91-0.93 against self-matches at 1.00). */
const NEAR_MAX_EPSILON = 0.03;

/** Corpus subsumption: LCS(corpusA, corpusB)/|A| at or above this says A's
 *  text is verbatim-contained in B's (module header rule (b)). */
const CORPUS_SUBSUMPTION = 0.98;

/** Analysis cap: LCS cells per (corpus, candidate) pair. A pair over budget
 *  is skipped — the documented bounding divergence (a >110KB "license file"
 *  against the largest corpus entry answers no-match instead of burning
 *  seconds of the onPush waitUntil). */
const LCS_CELL_BUDGET = 96_000_000;

/** Upstream matches corpus Variant names; ours match the corpus file names
 *  (license-corpus.ts). The results are sorted — upstream's container.Set
 *  order is random, and a deterministic array is testable. */
export function detectLicenseText(content: string): string[] {
  const corpus = getCorpusEntries();
  if (content.length === 0 || corpus.length === 0) return [];
  const target = normalizeTokens(content);
  if (target.length === 0) return [];

  // The LCS can never exceed the shorter side, so a candidate carrying fewer
  // tokens than threshold×|corpus| cannot reach the threshold — the prune
  // that keeps the big GPL-family corpora off small files.
  const matches: Array<{ entry: CorpusEntry; coverage: number }> = [];
  for (const entry of corpus) {
    const len = entry.tokens.length;
    if (target.length < len * LICENSE_MATCH_THRESHOLD) continue;
    if (len * target.length > LCS_CELL_BUDGET) continue;
    const coverage = lcsLength(entry.tokens, target) / len;
    if (coverage >= LICENSE_MATCH_THRESHOLD) matches.push({ entry, coverage });
  }
  if (matches.length === 0) return [];

  // Rule (a): only matches effectively as good as the best survive.
  let max = 0;
  for (const match of matches) max = Math.max(max, match.coverage);
  const kept = matches.filter((match) => match.coverage >= max - NEAR_MAX_EPSILON);

  // Rule (b): a survivor whose corpus is verbatim-contained in another
  // survivor's corpus is the generic twin of a more specific match — drop it.
  const survivors = kept.filter((a) =>
    !kept.some(
      (b) =>
        b.entry !== a.entry &&
        b.entry.tokens.length > a.entry.tokens.length &&
        b.coverage >= a.coverage &&
        corpusSubsumption(a.entry, b.entry) >= CORPUS_SUBSUMPTION,
    ),
  );
  return survivors.map((match) => match.entry.spdxId).sort();
}

/** Lowercase alphanumeric runs — the normal form the coverage math runs in
 *  (wrapping, punctuation, capitalization and list-marker variance in the
 *  wild all cancel). */
function normalizeTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

interface CorpusEntry {
  spdxId: string;
  tokens: string[];
}

let corpusCache: CorpusEntry[] | null = null;

/** The corpus built once per isolate from the generated text table. The
 *  cache is written once and frozen afterwards — static data, not request
 *  state (AGENTS.md). */
function getCorpusEntries(): CorpusEntry[] {
  if (corpusCache === null) {
    corpusCache = LICENSE_CORPUS_TEXTS.map(([spdxId, text]) => ({ spdxId, tokens: normalizeTokens(text) }));
  }
  return corpusCache;
}

/** LCS length of two token streams (two-row int DP). Deterministic; the
 *  caller bounds the cell count (LCS_CELL_BUDGET). */
function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let prev = new Uint32Array(b.length + 1);
  let curr = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const ai = a[i - 1]!;
    for (let j = 1; j <= b.length; j++) {
      const diagonal = prev[j - 1]!;
      const above = prev[j]!;
      const left = curr[j - 1]!;
      curr[j] = ai === b[j - 1]! ? diagonal + 1 : above >= left ? above : left;
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[b.length]!;
}

/** Memoized per-isolate: LCS(a.tokens, b.tokens)/|a| — the share of a's
 *  corpus text found verbatim (in order) inside b's. Only survivor pairs are
 *  ever computed, a handful per isolate, and each pair is computed once. */
const subsumptionMemo = new Map<string, number>();

function corpusSubsumption(a: CorpusEntry, b: CorpusEntry): number {
  const key = `${a.spdxId}\u0000${b.spdxId}`;
  const memo = subsumptionMemo.get(key);
  if (memo !== undefined) return memo;
  const value = lcsLength(a.tokens, b.tokens) / a.tokens.length;
  subsumptionMemo.set(key, value);
  return value;
}

// ---------------------------------------------------------------------------
// The push arm's engine-side walk (wired at services/webhooks-push.ts
// `handleUserPushEvent` — the engine's onPush settle seam, upstream
// push.go:160-174 + the queue consumer license.go:70-102).
// ---------------------------------------------------------------------------

/** Go's zero oid (webhooks-push.ts exports the same constant as
 *  PUSH_ZERO_OID; duplicated here because webhooks-push imports THIS module
 *  — an import back would close a cycle). */
const PUSH_ZERO_OID = "0".repeat(40);

/** Blobs decode capped — a pathological multi-megabyte "LICENSE" is analyzed
 *  truncated (and mostly skipped by LCS_CELL_BUDGET anyway). */
const BLOB_DECODE_CAP = 1024 * 1024;

/**
 * The engine cell slice the walk consumes — structurally satisfied by the
 * repo cell RPC stub (`DurableObjectStub<RepoCell>`: listTree's TreeResult /
 * readBlob's BlobResult / readCommit's CommitJson carry these fields), and
 * faked by tests.
 */
export interface LicenseEngineCell {
  /** `id` is a branch, full ref, or reachable oid (engine repo.d.ts). */
  readCommit(id?: string): Promise<{ oid: string } | null>;
  listTree(ref?: string, path?: string): Promise<{
    entries: ReadonlyArray<{ name: string; mode: string; type: "tree" | "blob" | "commit" }>;
  } | null>;
  readBlob(ref: string | undefined, path: string): Promise<{ data: Uint8Array } | null>;
}

/** The repositories-row slice the walk needs (RepoRow satisfies it). */
export interface RepoLicenseSyncTarget {
  id: string;
  defaultBranch: string;
}

/** One applied ref update ({ref, next} of webhooks-push.ts's PushRefUpdate —
 *  the zero `next` marks a deletion). */
export interface RepoLicenseRefUpdate {
  ref: string;
  next: string;
}

/**
 * The push settle leg: re-resolve the repo's license rows after a receive
 * applied `updates`. Upstream arms, faithfully:
 *   - ONLY a default-branch create/update triggers the scan (push.go:160-174
 *     — `branch == repo.DefaultBranch` inside `!opts.IsDelRef()`); a deleted
 *     default branch and every other ref leave the table alone;
 *   - the scan reads the default branch's TIP tree (the queue consumer's
 *     GetBranchCommit + UpdateRepoLicenses, license.go:91-96) and diffs the
 *     rows at the tip's oid (updateRepoLicenses — the stale-commit sweep
 *     doubles as the clean-on-no-match arm, license.go:206-208).
 *
 * DELIBERATE DIVERGENCE — the empty-repo skip (license.go:79-81
 * `if repo.IsEmpty { continue }`): upstream's queue is ASYNC, so by scan
 * time the push processing has already flipped IsEmpty; the guard protects
 * an unborn-branch scan. Ours is synchronous inside onPush, where an applied
 * default-branch update IS the proof of non-emptiness — and cf-gitea's D1
 * `is_empty` is stale for the API-created population (only the push-create
 * settle flips it, git-http/gate.ts; the general flip is an ENGINE-WAVE
 * gap). The authoritative empty check here is the unborn tip: readCommit
 * answering null skips the scan. A repo whose D1 row still claims is_empty
 * but carries a resolvable default branch scans, upstream's effective
 * behavior.
 *
 * All engine failures propagate to the caller's catch (the onPush seam's
 * never-fail-the-push posture — logged, the applied push stands).
 */
export async function syncRepoLicensesFromCell(
  d1: D1Database,
  cell: LicenseEngineCell,
  repo: RepoLicenseSyncTarget,
  updates: readonly RepoLicenseRefUpdate[],
): Promise<void> {
  if (!updates.some((update) => update.ref === `refs/heads/${repo.defaultBranch}` && update.next !== PUSH_ZERO_OID)) {
    return; // push.go:160-174 — default-branch create/update only
  }
  const branchRef = `refs/heads/${repo.defaultBranch}`;
  const tip = await cell.readCommit(branchRef);
  if (tip === null) return; // unborn branch — upstream's IsEmpty guard's exact subject
  const detected = await resolveLicensesFromCell(cell, tip.oid);
  await updateRepoLicenses(d1, repo.id, tip.oid, detected);
}

/**
 * resolveLicenses (license.go:156-198) over the engine's tree RPCs: the
 * REUSE LICENSES/ subtree claims the whole resolution when it exists
 * (listTree answers null for a missing path — the SubTree/IsErrNotExist
 * split, :157-165); otherwise root-level regular files passing
 * isLicenseFile are blob-read and corpus-matched, with upstream's
 * continue-on-error posture per entry (:184-192).
 */
async function resolveLicensesFromCell(cell: LicenseEngineCell, ref: string): Promise<DetectedLicense[]> {
  const reuseTree = await cell.listTree(ref, LICENSE_REUSE_DIR);
  if (reuseTree !== null) {
    return reuseTree.entries
      .filter(isRegularEntry)
      .map((entry) => ({ spdxId: pathBaseStem(entry.name), licensePath: `${LICENSE_REUSE_DIR}/${entry.name}` }));
  }

  const root = await cell.listTree(ref, "");
  if (root === null) return [];
  const detected: DetectedLicense[] = [];
  for (const entry of root.entries) {
    if (!isRegularEntry(entry) || !isLicenseFile(entry.name)) continue;
    const blob = await cell.readBlob(ref, entry.name);
    if (blob === null) continue; // license.go:184-187
    const bytes = blob.data.length > BLOB_DECODE_CAP ? blob.data.slice(0, BLOB_DECODE_CAP) : blob.data;
    for (const spdxId of detectLicenseText(new TextDecoder().decode(bytes))) {
      detected.push({ spdxId, licensePath: entry.name });
    }
  }
  return detected;
}

/** entry.IsRegular over the engine's tree entry shape: a blob whose mode is
 *  a regular file (symlinks are blobs with mode 120000, gitlinks are type
 *  "commit" — neither is a license candidate). */
function isRegularEntry(entry: { mode: string; type: "tree" | "blob" | "commit" }): boolean {
  return entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
}
