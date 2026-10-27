/**
 * The tier-1 engine-read/write client backing the git-object API families
 * (SPEC-0004 §2.4 category (c) rows + the PR deferred family; engine semantics
 * per SPEC-0005 §3.4). The DO is addressed by the RESOLVED D1 row's combined
 * name (`ownerNamespace/slug` — the ui/engine.ts convention, so /ALICE/hello
 * and /alice/hello reach the same cell; the storage_key switch is the shared
 * TODO(SPEC-0003 M2) of that module, inherited here by living behind this one
 * file).
 *
 * Transport posture mirrors ui/engine.ts: READ RPCs resolve `null` on a thrown
 * RPC — `null` is also the engine's own not-found answer, so callers branch on
 * one shape and map it to the route's declared code (404, or 409
 * EmptyRepository for the commit-list row). WRITE RPCs (commitApiChange /
 * deleteApiRef / executeMerge / rebaseOnto / putRebaseObjects /
 * putApiObjects / setHead) are NOT caught: a transport failure there is
 * retryable-unknown state, and the honest answer is the 500 handler
 * (giteaErrorHandler), never a fabricated 4xx.
 *
 * Engine access is strictly the public RPC surface of
 * packages/git-engine/dist-types (repo.d.ts + control-plane.d.ts +
 * merge/types.d.ts) — engine sources are untouchable.
 */

import type {
  BlobResult,
  CheckMergeabilityResult,
  CommitApiChangeResult,
  CommitJson,
  DeleteApiRefResult,
  DiffResult,
  ExecuteMergeResult,
  LogResult,
  RefsResult,
  RepoCell,
  TreeResult,
} from "@cf-gitea/git-engine";
import type { ApiEnv } from "../env";
import { ApiError } from "../errors";

/** The all-zeros oid — CAS create-on-empty base (control-plane.d.ts). */
export const ZERO_OID = "0000000000000000000000000000000000000000";

/** Full ref name builders — the only ref shapes the API layer writes. */
export function branchRef(name: string): string {
  return `refs/heads/${name}`;
}

export function tagRef(name: string): string {
  return `refs/tags/${name}`;
}

/** `GetGitHeadRefName` (models/issues/pull.go:406) — the base-repo PR head ref. */
export function pullHeadRef(index: number): string {
  return `refs/pull/${index}/head`;
}

/** The DO name for a resolved D1 row (see module doc). */
export function engineRepoName(pair: { ownerNamespace: string; slug: string }): string {
  return `${pair.ownerNamespace}/${pair.slug}`;
}

/** The raw DO stub — write RPCs and ref-tip reads that must throw on transport. */
export function engineCell(env: ApiEnv["Bindings"], pair: { ownerNamespace: string; slug: string }): DurableObjectStub<RepoCell> {
  return env.REPO.getByName(engineRepoName(pair));
}

/** mergeBase/countDivergence outcomes (inline unions in repo.d.ts — named here). */
export type EngineMergeBaseResult =
  | { tag: "ok"; base: string | null; exhausted: boolean }
  | { tag: "missing"; which: "a" | "b" };
export type EngineDivergenceResult =
  | { tag: "ok"; ahead: number; behind: number; exhausted: boolean }
  | { tag: "missing" };

/**
 * The read-side client: every method resolves null on transport failure
 * (module doc). `checkMergeability` is read-only by the engine's locked rule
 * (0001b §4.6 — checks write nothing durable), so it rides the safe wrapper
 * even though its result drives a D1 write; the write itself is a CAS that
 * any later re-check corrects.
 */
export function engineReads(env: ApiEnv["Bindings"], pair: { ownerNamespace: string; slug: string }): EngineReads {
  const cell = env.REPO.getByName(engineRepoName(pair));
  // async/await erases the RPC stub's `Promise & Pick` intersection types,
  // which break plain `.catch(() => null)` inference on union results.
  const safe = async <T>(pending: Promise<T>): Promise<T | null> => {
    try {
      return await pending;
    } catch {
      return null;
    }
  };
  return {
    listRefs: () => safe(cell.listRefs()),
    readCommit: (id) => safe(cell.readCommit(id)),
    listLog: (ref, opts) => safe(cell.listLog(ref, opts)),
    listTree: (ref, path) => safe(cell.listTree(ref, path)),
    readBlob: (ref, path) => safe(cell.readBlob(ref, path)),
    readDiff: (id, id2) => safe(cell.readDiff(id, id2)),
    // the union-returning RPCs carry explicit type arguments — the RPC stub's
    // `Promise & Pick` intersections make inference pick one union member
    mergeBase: (a, b) => safe<EngineMergeBaseResult>(cell.mergeBase(a, b)),
    listCommitsRange: (base, head, limit, page) => safe(cell.listCommitsRange(base, head, limit, page)),
    countDivergence: (base, head) => safe<EngineDivergenceResult>(cell.countDivergence(base, head)),
    checkMergeability: (input) => safe<CheckMergeabilityResult>(cell.checkMergeability(input)),
  };
}

/** The exact read RPC slice the API routes consume (null-on-failure shapes). */
export interface EngineReads {
  listRefs(): Promise<RefsResult | null>;
  readCommit(id?: string): Promise<CommitJson | null>;
  listLog(ref?: string, opts?: { path?: string; ofs?: number; n?: number }): Promise<LogResult | null>;
  listTree(ref?: string, path?: string): Promise<TreeResult | null>;
  readBlob(ref: string | undefined, path: string): Promise<BlobResult | null>;
  readDiff(id?: string, id2?: string): Promise<DiffResult | null>;
  mergeBase(a: string, b: string): Promise<EngineMergeBaseResult | null>;
  listCommitsRange(base: string, head: string, limit: number, page?: number): Promise<{ commits: CommitJson[]; more: boolean } | null>;
  countDivergence(base: string, head: string): Promise<EngineDivergenceResult | null>;
  checkMergeability(input: { base: string; head: string }): Promise<CheckMergeabilityResult | null>;
}

/**
 * Branch/tag tip resolution straight from the refs list — one RPC answers
 * existence AND target for the whole family. `peeled` carries the tag-peel
 * cache the engine keeps on refs rows (present for annotated tags only, so
 * annotated vs lightweight is answerable without reading the object).
 */
export interface RefTip {
  target: string;
  /** present for annotated tags: the peeled commit oid */
  peeled?: string;
}

export function refTipMap(refs: RefsResult | null): Map<string, RefTip> {
  const map = new Map<string, RefTip>();
  if (refs === null) return map;
  for (const ref of refs.refs) {
    map.set(ref.name, { target: ref.target, ...(ref.peeled === undefined ? {} : { peeled: ref.peeled }) });
  }
  return map;
}

/**
 * Resolve the `ref` query param to a full ref name: an exact branch, then an
 * exact tag, then a full ref as given, then a 40-char oid (immutable —
 * passable to readCommit directly). STRICTLY null when the ref does not
 * resolve — there is NO default-branch fallback.
 *
 * Upstream posture (routers/api/v1/utils/git.go ResolveRefCommit + modules/git
 * GetCommit/GetTree): a non-empty ref either resolves (branch → tag → oid) or
 * the caller answers its family's not-found code — 404 (getCommit,
 * GetAllCommits, contents via APIErrorAuto on git.ErrNotExist), 400
 * (GetTreeBySHA's InvalidArgument "sha not found"), 500 (CreateBranch's
 * APIErrorInternal), or the web forms' refusal. The default branch applies
 * ONLY when the param is ABSENT (upstream util.IfZero before ResolveRefCommit)
 * — every consumer here implements that absent arm explicitly at its call
 * site, so none passes a default into this resolver. The former fallback made
 * /commits?sha=bogus answer the default tip with 200 and left every
 * not-found arm dead for non-hex input (engine review c2).
 */
export function resolveNamedRef(tips: Map<string, RefTip>, ref: string): { ref: string; target: string; peeled?: string } | null {
  for (const candidate of [branchRef(ref), tagRef(ref), ref]) {
    const tip = tips.get(candidate);
    if (tip !== undefined) {
      return { ref: candidate, target: tip.target, ...(tip.peeled === undefined ? {} : { peeled: tip.peeled }) };
    }
  }
  if (/^[0-9a-f]{40}$/.test(ref)) {
    return { ref, target: ref };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Write-outcome → upstream error mapping (tagged unions never throw; the
// mappers turn them into the route's declared ApiError codes)
// ---------------------------------------------------------------------------

/**
 * commitApiChange / branch-create outcome. `ref_conflict` is the upstream
 * 409 family (SPEC-0004 maps the CAS mismatch there); `invalid` carries the
 * engine's refname/object validation → the declared 422.
 */
export function commitApiChangeError(result: Exclude<CommitApiChangeResult, { tag: "committed" }>): ApiError {
  if (result.tag === "ref_conflict") {
    return new ApiError(409, `The branch update has failed, the ref moved [current: ${result.currentOid}]`);
  }
  // "importing" (the fork-import gate) and "invalid" (refname/object
  // validation) both refuse the write; the declared 422 carries the reason
  // where the engine supplies one.
  return new ApiError(422, result.tag === "invalid" ? result.reason : "repository is importing");
}

/** deleteApiRef outcome — a null currentOid is the engine's "already gone" ok. */
export function deleteApiRefError(result: Exclude<DeleteApiRefResult, { tag: "deleted" }>): ApiError | null {
  if (result.tag === "invalid") {
    return new ApiError(422, result.reason);
  }
  if (result.currentOid === null) {
    return null; // idempotent delete: the ref is already absent
  }
  return new ApiError(409, `The ref delete has failed, the ref moved [current: ${result.currentOid}]`);
}

/** executeMerge outcome → the merge route's declared {405, 409} family. */
export function executeMergeError(result: Exclude<ExecuteMergeResult, { tag: "committed" }>): ApiError {
  if (result.tag === "not_fast_forward") {
    return new ApiError(405, "not a fast forward");
  }
  if (result.tag === "conflict") {
    return new ApiError(405, "merge would conflict");
  }
  if (result.tag === "nothing_to_merge") {
    return new ApiError(405, `nothing to merge [status: ${result.status}]`);
  }
  if (result.tag === "ref_conflict") {
    return new ApiError(409, `The merge has failed, the base ref moved [current: ${result.currentOid}]`);
  }
  // "invalid" carries the engine's reason; "importing" is the fork-import
  // gate refusing while replication is in flight.
  return new ApiError(405, result.tag === "invalid" ? result.reason : "repository is importing");
}

