/**
 * Mergeability classification (§4.3), merge execution (§4.4) and the rebase
 * replay assembly (§4.5) — the read-write half of SPEC-0001b's merge surface.
 * All functions take the control-plane `LeaseHost` (store + storage) and
 * return tagged unions; the `transactionSync` landings live here, the object
 * derivation stays in src/merge/{graph,tree,rebase}.ts.
 *
 * Landing reuses the SPEC-0001a machinery verbatim: objects stored BEFORE the
 * transaction (content-addressed; a lost CAS leaves unreferenced loose objects
 * for the sweep, §4.5 posture), refname validation + presence checks + CAS +
 * `refs_version` bump + the commitPush HEAD fixup inside ONE transaction.
 */
import { GitStore } from "../git/store";
import { ZERO_OID, isOid } from "../git/util";
import { validRefName, latestCommitTime } from "../git/protocol";
import { parseCommit } from "../git/objects";
import { serializeCommit } from "../commit/serialize";
import { LeaseHost } from "../control-plane";
import { mergeBase, isAncestorEx, countDivergence, peelToCommitOid, resolveCommitish } from "./graph";
import { planTreeMerge, MergeConflictPath } from "./tree";
import type {
  CheckMergeabilityInput,
  CheckMergeabilityResult,
  ExecuteMergeInput,
  ExecuteMergeResult,
  MergeabilityStatus,
} from "./types";

/** conflictedFiles cap on one check/merge result (sorted, truncated beyond). */
export const MAX_CONFLICT_FILES = 50;

function sortCapConflicts(conflicts: MergeConflictPath[]): { files: string[]; truncated: boolean } {
  const paths = conflicts.map((c) => c.path).sort();
  return { files: paths.slice(0, MAX_CONFLICT_FILES), truncated: paths.length > MAX_CONFLICT_FILES };
}

/** CommitJson-lite of a resolved commit (tree access without the full JSON). */
interface ResolvedCommit {
  oid: string;
  tree: string;
}

async function loadCommit(store: GitStore, oid: string): Promise<ResolvedCommit | null> {
  const obj = await store.get(oid);
  return obj?.type === "commit" ? { oid, tree: parseCommit(obj.data).tree } : null;
}

/**
 * The §4.3 decision procedure, shared by the read-only check and the
 * execution's fresh re-classification (executeMerge never trusts the caller's
 * stale classification). Mirrors upstream
 * `checkPullRequestMergeableByMergeTree` step for step.
 */
export async function checkMergeability(store: GitStore, input: CheckMergeabilityInput): Promise<CheckMergeabilityResult> {
  const baseOid = await resolveCommitish(store, input.base);
  if (!baseOid) return { tag: "missing", which: "base", ref: input.base };
  const headOid = await resolveCommitish(store, input.head);
  if (!headOid) return { tag: "missing", which: "head", ref: input.head };
  return classify(store, baseOid, headOid);
}

/** The classifier over RESOLVED commit oids (executeMerge's inner half). */
async function classify(store: GitStore, baseOid: string, headOid: string): Promise<CheckMergeabilityResult> {
  // 2. merge-base; exhaustion ⇒ error (the Queue worker re-checks)
  const mb = await mergeBase(store, baseOid, headOid);
  if (mb.exhausted) return ok("error", null, null, [], false, 0, 0);
  if (mb.value === null) return ok("unrelated", null, null, [], false, 0, 0);
  const mbOid = mb.value;

  // divergence counts ride along so the check populates the D1 row in one RPC
  const div = await countDivergence(store, baseOid, headOid);
  const ahead = div.value?.ahead ?? 0;
  const behind = div.value?.behind ?? 0;
  if (div.exhausted) return ok("error", mbOid, null, [], false, ahead, behind);

  // 3. ancestor short-circuit: nothing to merge
  if (headOid === mbOid) return ok("ancestor", mbOid, null, [], false, ahead, behind);
  const anc = await isAncestorEx(store, headOid, baseOid);
  if (anc.exhausted) return ok("error", mbOid, null, [], false, ahead, behind);
  if (anc.value) return ok("ancestor", mbOid, null, [], false, ahead, behind);

  const baseCommit = await loadCommit(store, baseOid);
  const headCommit = await loadCommit(store, headOid);
  const mbCommit = await loadCommit(store, mbOid);
  if (!baseCommit || !headCommit) return ok("error", mbOid, null, [], false, ahead, behind);

  // 4. fast-forward shape: the merged tree IS head's tree — skip the walk
  let mergedTree: string;
  if (mbOid === baseOid) {
    mergedTree = headCommit.tree;
  } else {
    if (!mbCommit) return ok("error", mbOid, null, [], false, ahead, behind);
    // 5. plan the three-way merge
    const plan = await planTreeMerge(store, mbCommit.tree, baseCommit.tree, headCommit.tree);
    if (plan.overflow) return ok("error", mbOid, null, [], false, ahead, behind);
    if (plan.conflicts.length) {
      const { files, truncated } = sortCapConflicts(plan.conflicts);
      return ok("conflict", mbOid, plan.tree, files, truncated, ahead, behind);
    }
    mergedTree = plan.tree;
  }

  // 6. emptiness: tree-oid equality is recursive equality (zero blob reads)
  const status = mergedTree === baseCommit.tree ? "empty" : "mergeable";
  return ok(status, mbOid, mergedTree, [], false, ahead, behind);
}

function ok(
  status: MergeabilityStatus,
  mergeBase: string | null,
  mergedTree: string | null,
  conflictedFiles: string[],
  conflictedFilesTruncated: boolean,
  commitsAhead: number,
  commitsBehind: number
): CheckMergeabilityResult {
  return {
    tag: "ok",
    status,
    mergeBase,
    mergedTree,
    conflictedFiles,
    conflictedFilesTruncated,
    commitsAhead,
    commitsBehind,
  };
}

/** Resolve `base` to a REF (the landing moves it): refs/heads/<b>, refs/tags/<b>,
 * then verbatim. Null when base is not a ref (a bare oid has nothing to CAS). */
function resolveBaseRef(store: GitStore, base: string): { ref: string; oid: string } | null {
  for (const cand of [`refs/heads/${base}`, `refs/tags/${base}`, base]) {
    const oid = store.getRef(cand);
    if (oid) return { ref: cand, oid };
  }
  return null;
}

/**
 * Merge execution (§4.4) — one landing primitive, styles as parameters. The
 * classification runs against the FRESHLY read tips (never the caller's stale
 * classification); objects are stored before the transaction; the base move,
 * every extraRefUpdate CAS and the HEAD fixup land in ONE transactionSync.
 */
export async function executeMerge(host: LeaseHost, input: ExecuteMergeInput): Promise<ExecuteMergeResult> {
  const { store } = host;
  // 1. resolve base to its CURRENT tip and CAS against the caller's value
  const baseRef = resolveBaseRef(store, input.base);
  if (!baseRef) return { tag: "invalid", reason: `base is not a resolvable ref: ${input.base}` };
  const current = baseRef.oid;
  if (current !== input.expectedBaseOid) return { tag: "ref_conflict", currentOid: current };
  const baseTip = await peelToCommitOid(store, current);
  if (!baseTip) return { tag: "invalid", reason: `base ref does not peel to a commit: ${baseRef.ref}` };

  // head
  const headOid = await resolveCommitish(store, input.head);
  if (!headOid) return { tag: "invalid", reason: `head does not resolve to a commit: ${input.head}` };

  // pre-validate the choreography BEFORE any work (tagged-union outcomes, no throws)
  for (const x of input.extraRefUpdates) {
    if (!validRefName(x.ref)) return { tag: "invalid", reason: `funny refname: ${x.ref}` };
    if (x.ref === baseRef.ref) return { tag: "invalid", reason: `extra update targets the base ref: ${x.ref}` };
    if (x.newOid !== null && !isOid(x.newOid)) return { tag: "invalid", reason: `malformed new oid for ${x.ref}` };
    if (x.newOid !== null && !store.has(x.newOid)) return { tag: "invalid", reason: `object missing for ${x.ref}` };
    if (x.expectedOldOid !== ZERO_OID && !isOid(x.expectedOldOid)) {
      return { tag: "invalid", reason: `malformed expected oid for ${x.ref}` };
    }
  }

  // 2. fresh classification against the freshly read tips
  const verdict = await classify(store, baseTip, headOid);
  if (verdict.tag === "missing") return { tag: "invalid", reason: `unresolvable during classification: ${verdict.ref}` };
  if (verdict.status === "error") return { tag: "invalid", reason: "mergeability walk exhausted or overflowed" };
  if (verdict.status === "unrelated") return { tag: "nothing_to_merge", status: "unrelated" };
  if (verdict.status === "ancestor") return { tag: "nothing_to_merge", status: "ancestor" };
  if (verdict.status === "empty") return { tag: "nothing_to_merge", status: "empty" };
  if (verdict.status === "conflict") {
    return { tag: "conflict", conflictedFiles: verdict.conflictedFiles, truncated: verdict.conflictedFilesTruncated };
  }

  // 3. style mechanics
  const mbOid = verdict.mergeBase as string;
  let landingOid: string;
  if (input.style === "fast-forward-only") {
    if (mbOid !== baseTip) return { tag: "not_fast_forward" };
    landingOid = headOid;
  } else {
    const baseCommit = await loadCommit(store, baseTip);
    const headCommit = await loadCommit(store, headOid);
    const mbCommit = await loadCommit(store, mbOid);
    if (!baseCommit || !headCommit || !mbCommit) return { tag: "invalid", reason: "missing commit during merge" };
    const plan = await planTreeMerge(store, mbCommit.tree, baseCommit.tree, headCommit.tree);
    if (plan.overflow) return { tag: "invalid", reason: plan.overflow };
    if (plan.conflicts.length) {
      const { files, truncated } = sortCapConflicts(plan.conflicts);
      return { tag: "conflict", conflictedFiles: files, truncated };
    }
    // store the derived objects BEFORE the transaction (async R2 reads are
    // not legal inside transactionSync); content-addressed, so a lost CAS
    // leaves ordinary unreferenced loose objects for the sweep (§4.4)
    for (const o of plan.objects) store.put(o.oid, o.type, o.data);
    const commit = serializeCommit({
      tree: plan.tree,
      parents: input.style === "squash" ? [baseTip] : [baseTip, headOid],
      author: input.author,
      committer: input.committer,
      message: input.message,
    });
    store.put(commit.oid, commit.type, commit.data);
    landingOid = commit.oid;
  }

  // 4. ONE transaction: base CAS + extraRefUpdates CAS + HEAD fixup + version bump
  const fail = { ref: "", current: ZERO_OID };
  const applied = host.storage.transactionSync((): { ok: boolean } => {
    const live = store.getRef(baseRef.ref) ?? ZERO_OID;
    if (live !== input.expectedBaseOid) {
      fail.ref = baseRef.ref;
      fail.current = live;
      return { ok: false };
    }
    for (const x of input.extraRefUpdates) {
      const cur = store.getRef(x.ref) ?? ZERO_OID;
      if (cur !== x.expectedOldOid) {
        fail.ref = x.ref;
        fail.current = cur;
        return { ok: false };
      }
    }
    store.setRef(baseRef.ref, landingOid);
    for (const x of input.extraRefUpdates) {
      if (x.newOid === null) {
        if (store.getRef(x.ref) !== null) store.delRef(x.ref);
      } else {
        store.setRef(x.ref, x.newOid);
      }
    }
    // the same HEAD fixup as commitPush (first branch on an unborn HEAD,
    // prefer main/master)
    if (store.getRef(store.head()) === null) {
      const branches = store.refs().filter((r) => r.name.startsWith("refs/heads/"));
      const preferred =
        branches.find((b) => b.name === "refs/heads/main") ??
        branches.find((b) => b.name === "refs/heads/master") ??
        branches[0];
      if (preferred) store.setHead(preferred.name);
    }
    store.bumpRefsVersion();
    return { ok: true };
  });
  if (!applied.ok) {
    return { tag: "ref_conflict", currentOid: fail.current };
  }

  return {
    tag: "committed",
    commitOid: landingOid,
    mergeBase: mbOid,
    refsVersion: store.refsVersion(),
    commitTime: await latestCommitTime(store),
  };
}
