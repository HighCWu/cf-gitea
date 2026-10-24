/**
 * The SPEC-0001b §4 RPC contract types, split out of control-plane.ts per the
 * amendment's NOTICE category 1 ("src/merge/types.ts if the RPC types are
 * split out"). control-plane.ts hosts the receive/commit-builder contract and
 * the LeaseHost delegation; these types are the merge/fork-wave surface the
 * API layers consume through the generated dist-types boundary.
 *
 * Every application outcome is a tagged union — never a thrown error (the
 * split-plane rule, SPEC-0001a §2 Rule 2 as clarified in its §8).
 */
import type { Person } from "../git/objects";
import type { ObjType } from "../git/objects";
import type { MergeConflictPath } from "./tree";

// ---- §4.4 merge execution ----------------------------------------------------

export type MergeStyle = "merge" | "squash" | "fast-forward-only";

export interface ExtraRefUpdate {
  /** full ref name, same validation as receive (BAD_REF rules) */
  ref: string;
  /** CAS base; ZERO_OID = create */
  expectedOldOid: string;
  /** null = delete */
  newOid: string | null;
}

export interface ExecuteMergeInput {
  style: MergeStyle;
  /** ref or oid; the landing moves the base REF, so a resolvable REF is
   * required (a bare oid has nothing to CAS — `invalid`) */
  base: string;
  /** ref or oid */
  head: string;
  /** CAS base: the base-ref tip the caller classified against (from D1's last
   * check or a fresh read). Mismatch ⇒ ref_conflict (mapped to 409 per SPEC-0004). */
  expectedBaseOid: string;
  /** merge/squash commit metadata (fast-forward-only ignores) */
  message: string;
  author: Person;
  committer: Person;
  /** ref choreography applied atomically with the base move (see the §4.4 table) */
  extraRefUpdates: ExtraRefUpdate[];
}

export type MergeCommitted = {
  tag: "committed";
  /** new base tip (merge/squash commit, or head for FF) */
  commitOid: string;
  mergeBase: string;
  /** post-commit edge-cache key (T4) */
  refsVersion: string;
  /** registry upsert input, same as receive/§4 */
  commitTime: number;
};
export type MergeNotFastForward = { tag: "not_fast_forward" };
export type MergeConflict = { tag: "conflict"; conflictedFiles: string[]; truncated: boolean };
export type MergeNothing = { tag: "nothing_to_merge"; status: "ancestor" | "empty" | "unrelated" };
export type MergeRefConflict = {
  tag: "ref_conflict";
  /** live tip of the base ref (or of the first conflicting extra update) */
  currentOid: string;
};
export type MergeInvalid = { tag: "invalid"; reason: string };
/** A fork import is in flight on this repo (meta.importing, SPEC-0001b §5.3):
 * the replication loop must finish — or be re-run to completion — before any
 * ref-moving landing can proceed. */
export type MergeImporting = { tag: "importing" };
export type ExecuteMergeResult =
  | MergeCommitted
  | MergeNotFastForward
  | MergeConflict
  | MergeNothing
  | MergeRefConflict
  | MergeInvalid
  | MergeImporting;

// ---- §4.3 mergeability classification ----------------------------------------

export type MergeabilityStatus =
  | "mergeable" // → status 2 (mergeable)
  | "conflict" // → status 0 (conflict), conflictedFiles populated
  | "ancestor" // → status 6 (ancestor): head already in base
  | "empty" // → status 5 (empty): merged tree == base tree (already applied)
  | "unrelated" // → status 5 (empty): no common ancestor (upstream: "no merge base ⇒ empty")
  | "error"; // → status 4 (error): unresolvable ref or exhausted walk

export interface CheckMergeabilityInput {
  /** ref or oid (usually refs/heads/<branch>) */
  base: string;
  /** ref or oid (usually refs/pull/<index>/head — resolves today, §2) */
  head: string;
}

export type CheckMergeabilityOk = {
  tag: "ok";
  status: MergeabilityStatus;
  /** null ⇔ status "unrelated"; stored in pull_requests.merge_base */
  mergeBase: string | null;
  /** root tree the merge would produce; null for ancestor/unrelated/error */
  mergedTree: string | null;
  /** sorted, capped at maxConflictedFiles; empty unless status "conflict" */
  conflictedFiles: string[];
  conflictedFilesTruncated: boolean;
  /** base..head / head..base counts; 0 when mergeBase is null */
  commitsAhead: number;
  commitsBehind: number;
};
export type CheckMergeabilityMissing = { tag: "missing"; which: "base" | "head"; ref: string };
export type CheckMergeabilityResult = CheckMergeabilityOk | CheckMergeabilityMissing;

// ---- §4.5 rebase replay --------------------------------------------------------

export interface RebaseOntoInput {
  /** branch/ref/oid replayed */
  head: string;
  /** new base commit (target branch tip) */
  onto: string;
  /** authors/author dates are preserved from each commit */
  committer: Person;
  /** default 100 (gitorange MAX_REBASE_COMMITS parity) */
  maxCommits?: number;
}

export type RebasedCommit = { original: string; rebased: string };

export type RebaseOutcome =
  | { tag: "up_to_date" } // head already sits on `onto`
  | { tag: "too_many"; count: number } // own commits > maxCommits
  | {
      tag: "conflict";
      atOriginal: string;
      conflicts: MergeConflictPath[];
      /** commits replayed before the stop (for partial bookkeeping) */
      commits: RebasedCommit[];
    }
  | {
      tag: "rebased";
      headOid: string;
      commits: RebasedCommit[];
      /** commits left out: already applied upstream (patch identity) or emptied */
      skipped: number;
      /** all objects to store before the refs move (caller: putRebaseObjects) */
      objects: { oid: string; type: ObjType; data: Uint8Array }[];
    }
  | { tag: "invalid"; reason: string }; // unresolvable ref / exhausted walk / overflow

// ---- §4.8 ref delete ------------------------------------------------------------

export interface DeleteApiRefInput {
  ref: string;
  expectedOid: string;
}
export type DeleteApiRefResult =
  | { tag: "deleted"; refsVersion: string }
  | { tag: "ref_conflict"; /** null = ref already gone (idempotent ok) */ currentOid: string | null }
  | { tag: "invalid"; reason: string };
