/**
 * Repository invariants checker — the periodic-prover backlog item from the
 * external review (docs/design/m3-design-inputs.md): prove that every
 * advertised ref points at an existing object, that reachable closures are
 * complete, and that a terminal push leaves no dangling state.
 *
 * Scope discipline: everything here runs over the engine's PUBLIC read
 * surface only — RepoCell.listRefs / readCommit / listTree / readBlob (the
 * generated dist-types RPCs) plus the REPO_PACKS R2 binding for prefix
 * probes. `readCommit`/`listTree` are not passive index reads: they resolve
 * through the DO's GitStore, which fetches object bytes from R2 pack files,
 * so a deleted/corrupt pack surfaces as a thrown RPC — availability is
 * proved by reading, exactly the "readable, verified, parseable" bar of
 * invariant 1 (ref closure availability) in the design inputs.
 *
 * BLOCKED (engine-side, this wave): the pack_catalog ↔ R2 consistency half.
 * The catalog (DO SQLite `pack_catalog`) has no public RPC — no listPacks —
 * and packages/git-engine is parallel-owned, so no invariants RPC was added
 * there. Until that RPC exists, catalog-row-vs-R2-object cross-checks are
 * impossible from the Worker; the R2-side probes below (staging orphans)
 * cover the one externally observable half of "terminal pushes leave no
 * dangling state". The checker's structure is ready to consume a
 * catalog/listPacks RPC when the engine exposes one.
 *
 * Budgets: every walk is bounded (queue-consumer friendly). `partial: true`
 * means a budget stopped the proof early — `ok` then asserts less, never
 * more. Content violations are reported, not thrown; only transport-class
 * failures (the DO itself unreachable) throw so a queue consumer retries.
 *
 * Detection horizon (engine-owned, verified empirically): the DO keeps
 * inflated objects in a GitStore-lifetime cache. Every ref update peels its
 * target, so every commit that was EVER a ref tip stays readable from memory
 * even after its R2 pack is deleted — ref-tip-level faults on such commits
 * surface only once the cell's cache evicts (16 MiB of inflated objects) or
 * the cell recycles. Trees, blobs, and never-advertised ancestors read
 * through to R2, and a pack's raw chunk leaves the DO's 4-slot chunk LRU
 * after ~4 subsequent pushes, so this checker observes those losses
 * immediately (see invariants.test.ts for the exact fixture reasoning).
 */

import type { BlobResult, CommitJson, RefsResult, TreeEntryJson, TreeResult } from "@cf-gitea/git-engine";

/** The slice of RepoCell's public RPC surface the checker consumes. A real
 *  `env` satisfies it (DurableObjectStub<RepoCell> is structural); tests
 *  substitute hand-rolled outcomes without reaching into engine internals. */
export interface RepoCellReader {
  listRefs(): Promise<RefsResult>;
  readCommit(id?: string): Promise<CommitJson | null>;
  listTree(ref?: string, path?: string): Promise<TreeResult | null>;
  readBlob(ref: string | undefined, path: string): Promise<BlobResult | null>;
}

/** Structural env slice — the full generated `Env` satisfies it. */
export type InvariantsEnv = { REPO: { getByName(name: string): RepoCellReader }; REPO_PACKS?: R2Bucket };

/** Violation kinds. The first four are the brief's required kinds;
 * `staging-orphan` is the externally observable dangling-state check. */
export type InvariantViolationKind =
  | "ref-tip-missing"
  | "head-missing"
  | "closure-broken"
  | "tree-missing"
  | "staging-orphan";

export interface InvariantViolation {
  kind: InvariantViolationKind;
  /** The advertised ref name, when the violation hangs off one. */
  ref?: string;
  /** The object id the violation is about (peeled to commit where known). */
  oid?: string;
  /** Human-readable context (failure text, R2 key). Never machine-parsed. */
  detail?: string;
}

export interface InvariantReport {
  /** Engine name the report is about (`owner/repo`). */
  repo: string;
  ok: boolean;
  /** True when a budget stopped the walk early (or the R2 probe hit its
   * page cap): `ok` then means "no violation within the budget". */
  partial: boolean;
  violations: InvariantViolation[];
  checked: {
    refs: number;
    commits: number;
    trees: number;
    /** blob spot checks (readBlob) under the sampled trees */
    blobs: number;
  };
}

export interface CheckInvariantsOptions {
  /** Advertised refs examined per invocation (default 200). */
  maxRefs?: number;
  /** Commit BFS pops per invocation (default 500). */
  maxCommits?: number;
  /** Distinct trees verified per invocation (default 200). */
  maxTrees?: number;
  /** readBlob spot checks per invocation (default 20). */
  maxBlobs?: number;
  /** Staging objects younger than this are assumed in-flight (a live receive
   * lease cannot be observed over public RPC). Default 15 min — beyond any
   * receive lease lifetime (the sweep reclaims at lease expiry). 0 flags
   * everything immediately (tests). */
  stagingMinAgeMs?: number;
  /** Probe `repos/<storageKey>/staging/` for orphans (default true when a
   * storageKey + REPO_PACKS are available). */
  checkStaging?: boolean;
}

const DEFAULT_MAX_REFS = 200;
const DEFAULT_MAX_COMMITS = 500;
const DEFAULT_MAX_TREES = 200;
const DEFAULT_MAX_BLOBS = 20;
const DEFAULT_STAGING_MIN_AGE_MS = 15 * 60 * 1000;
/** R2 list pages for one staging probe — keeps the probe bounded even for a
 * pathologically orphaned prefix. */
const STAGING_MAX_PAGES = 4;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Check one repository's invariants over the engine's public RPCs.
 *
 * `target.engineName` addresses the RepoCell (the combined `owner/repo` name
 * the DO id is keyed on); `target.storageKey` (the D1 `repositories.storage_key`,
 * `r_<id>`) names the R2 prefixes for the staging probe — when omitted the
 * R2 half is skipped (the DO half never needs it). Throws only on
 * transport-class failures (the DO RPC itself rejects, e.g. the cell is
 * unreachable); every content-level fault lands in `violations`.
 */
export async function checkRepoInvariants(
  env: InvariantsEnv,
  target: { engineName: string; storageKey?: string },
  options: CheckInvariantsOptions = {},
): Promise<InvariantReport> {
  const maxRefs = options.maxRefs ?? DEFAULT_MAX_REFS;
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const maxTrees = options.maxTrees ?? DEFAULT_MAX_TREES;
  const maxBlobs = options.maxBlobs ?? DEFAULT_MAX_BLOBS;
  const stagingMinAgeMs = options.stagingMinAgeMs ?? DEFAULT_STAGING_MIN_AGE_MS;

  const stub = env.REPO.getByName(target.engineName);
  const violations: InvariantViolation[] = [];
  const add = (violation: InvariantViolation): void => {
    const key = `${violation.kind}|${violation.ref ?? ""}|${violation.oid ?? ""}`;
    if (!violations.some((v) => `${v.kind}|${v.ref ?? ""}|${v.oid ?? ""}` === key)) {
      violations.push(violation);
    }
  };

  // listRefs is a pure DO-SQLite read; its rejection is transport-class.
  const refsResult = await stub.listRefs();

  // -- every advertised ref's tip resolves --------------------------------
  // A tip that cannot be read (object missing from R2, catalog row gone,
  // unresolvable) is ref-tip-missing. The walk never starts from it.
  const reportedTipRefs = new Set<string>();
  const tipCommits = new Set<string>();
  let refsChecked = 0;
  let refsTruncated = false;
  for (const ref of refsResult.refs) {
    if (refsChecked >= maxRefs) {
      refsTruncated = true;
      break;
    }
    refsChecked += 1;
    let tip: CommitJson | null;
    try {
      tip = await stub.readCommit(ref.name);
    } catch (error) {
      add({ kind: "ref-tip-missing", ref: ref.name, oid: ref.target, detail: errorText(error) });
      reportedTipRefs.add(ref.name);
      continue;
    }
    if (tip === null) {
      add({ kind: "ref-tip-missing", ref: ref.name, oid: ref.target });
      reportedTipRefs.add(ref.name);
      continue;
    }
    // readCommit peels tags; the BFS seeds from the peeled commit (the tag
    // object itself was just read — a missing tag object lands above).
    tipCommits.add(tip.oid);
  }

  // -- HEAD resolves -------------------------------------------------------
  // head is the HEAD ref name; null = unborn. Unborn HEAD over advertised
  // refs is the force-delete dangling-HEAD shape; a resolvable HEAD that
  // fails readCommit is reported only when its ref did not already report
  // (one root cause, one violation).
  if (refsResult.head === null) {
    if (refsResult.refs.length > 0) {
      add({ kind: "head-missing", detail: "HEAD is unborn while refs are advertised" });
    }
  } else if (!reportedTipRefs.has(refsResult.head)) {
    try {
      const head = await stub.readCommit();
      if (head === null) add({ kind: "head-missing", ref: refsResult.head });
    } catch (error) {
      add({ kind: "head-missing", ref: refsResult.head, detail: errorText(error) });
    }
  }

  // -- sampled closure walk ------------------------------------------------
  // BFS from the resolved tips over commit parents. Every visited commit
  // must (a) read back, (b) have a listable tree (deduped by tree oid —
  // content addressing makes one verification sound), and (c) get one blob
  // of that tree spot-checked through readBlob. A parent that cannot be
  // read is closure-broken; an unreadable tree/blob under a readable commit
  // is tree-missing.
  let partial = refsTruncated;
  const queue = [...tipCommits];
  const seen = new Set<string>(tipCommits);
  const verifiedTrees = new Set<string>();
  let commitsChecked = 0;
  let treesChecked = 0;
  let blobsChecked = 0;
  let skippedTrees = 0;
  let skippedBlobs = 0;

  while (queue.length > 0) {
    if (commitsChecked >= maxCommits) {
      partial = true;
      break;
    }
    const oid = queue.shift()!;
    commitsChecked += 1;

    let commit: CommitJson | null;
    try {
      commit = await stub.readCommit(oid);
    } catch (error) {
      add({ kind: "closure-broken", oid, detail: errorText(error) });
      continue;
    }
    if (commit === null) {
      add({ kind: "closure-broken", oid });
      continue;
    }

    if (!verifiedTrees.has(commit.tree)) {
      if (treesChecked >= maxTrees) {
        skippedTrees += 1;
      } else {
        treesChecked += 1;
        let entries: TreeEntryJson[] | null = null;
        try {
          const tree = await stub.listTree(oid);
          if (tree === null) {
            add({ kind: "tree-missing", oid: commit.tree, detail: `tree of commit ${oid} did not resolve` });
          } else {
            entries = tree.entries;
            verifiedTrees.add(commit.tree);
          }
        } catch (error) {
          add({ kind: "tree-missing", oid: commit.tree, detail: errorText(error) });
        }
        const blobEntry = entries?.find((e) => e.type === "blob");
        if (blobEntry !== undefined) {
          if (blobsChecked >= maxBlobs) {
            skippedBlobs += 1;
          } else {
            blobsChecked += 1;
            try {
              const blob = await stub.readBlob(oid, blobEntry.name);
              if (blob === null) {
                add({
                  kind: "tree-missing",
                  oid: blobEntry.oid,
                  detail: `blob ${blobEntry.name} of commit ${oid} did not resolve`,
                });
              }
            } catch (error) {
              add({ kind: "tree-missing", oid: blobEntry.oid, detail: errorText(error) });
            }
          }
        }
      }
    }

    for (const parent of commit.parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  if (skippedTrees > 0 || skippedBlobs > 0) partial = true;

  // -- staging empty of orphans (the R2 half) ------------------------------
  // Staging keys exist only while a receive lease is live (the sweep removes
  // them at finalize/release/expiry). A staging object older than any lease
  // is a dangling terminal state — the crash-window orphan. The lease table
  // itself is not observable over public RPC, so age is the proxy.
  if (target.storageKey !== undefined && env.REPO_PACKS && options.checkStaging !== false) {
    const prefix = `repos/${target.storageKey}/staging/`;
    const now = Date.now();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const listed = await env.REPO_PACKS.list({ prefix, cursor });
      for (const object of listed.objects) {
        const ageMs = now - object.uploaded.getTime();
        if (ageMs >= stagingMinAgeMs) {
          add({
            kind: "staging-orphan",
            detail: `${object.key} staged ${Math.round(ageMs / 1000)}s ago (no live lease can still own it)`,
          });
        }
      }
      if (!listed.truncated) break;
      cursor = listed.cursor;
      pages += 1;
      if (pages >= STAGING_MAX_PAGES) {
        partial = true;
        break;
      }
    }
  }

  return {
    repo: target.engineName,
    ok: violations.length === 0,
    partial,
    violations,
    checked: { refs: refsChecked, commits: commitsChecked, trees: treesChecked, blobs: blobsChecked },
  };
}
