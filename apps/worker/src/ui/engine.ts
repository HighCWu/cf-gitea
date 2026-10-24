/**
 * The Tier-2 pages' engine client (SPEC-0008 §3.2 data-sourcing rules): the
 * thin wrapper over the RepoCell RPC surface the pages read. Pages NEVER
 * self-fetch their own HTTP surface (no `fetch("/api/v1/…")` from a handler —
 * the subrequest budget, auth re-runs, and event-loop hop all forbid it, §3.2;
 * precedent: gitHttpGate.serveHead reads `RepoCell.listRefs()` by RPC).
 *
 * Engine RPC surface used (verified `packages/git-engine/dist-types/repo.d.ts`
 * at this pin): `listRefs`, `readCommit`, `listLog`, `listTree`, `readBlob`.
 * §3.5's batched `listTreeCommits(ref?, path?)` enrichment RPC does NOT exist
 * on the boundary yet — the documented §3.5 interim fallback applies (per-entry
 * `listLog(ref, {path})` RPCs to the SAME DO; see page-data.ts).
 *
 * Failure posture: every method resolves `null` on transport failure (a thrown
 * RPC), mirroring the gate's serveHead catch-and-fall-back (§4.9 "unreadable
 * storage must not break" the page). `null` is ALSO the engine's own
 * not-found/unresolvable-ref answer, so callers branch on one shape; a page
 * decides per family whether that means the empty-repo render or the 404
 * shell.
 *
 * DO addressing: the combined repo name from the RESOLVED D1 row
 * (`ownerNamespace/slug` — the same combined-name convention as the gate's
 * `env.REPO.getByName("owner/repo")`, but taken from the row the page already
 * resolved so /ALICE/hello and /alice/hello reach the same cell; the gate's
 * request-casing variant carries the same `TODO(SPEC-0003 M2)` switch to
 * `storage_key`, which this module inherits — one more reason pages go through
 * this one file, open question 5).
 */

import type { BlobResult, CommitJson, LogResult, RefsResult, TreeResult } from "@cf-gitea/git-engine";

/** The exact engine RPC slice the pages consume — `null`-on-failure shape. */
export interface EngineClient {
  listRefs(): Promise<RefsResult | null>;
  readCommit(id?: string): Promise<CommitJson | null>;
  listLog(ref?: string, opts?: { path?: string; ofs?: number; n?: number }): Promise<LogResult | null>;
  listTree(ref?: string, path?: string): Promise<TreeResult | null>;
  readBlob(ref: string | undefined, path: string): Promise<BlobResult | null>;
}

/** Build the client for one repository from the request's bindings. */
export function engineClient(env: Env, repoName: string): EngineClient {
  const cell = env.REPO.getByName(repoName);
  const safe = <T>(pending: Promise<T>): Promise<T | null> => pending.catch(() => null);
  return {
    listRefs: () => safe(cell.listRefs()),
    readCommit: (id) => safe(cell.readCommit(id)),
    listLog: (ref, opts) => safe(cell.listLog(ref, opts)),
    listTree: (ref, path) => safe(cell.listTree(ref, path)),
    readBlob: (ref, path) => safe(cell.readBlob(ref, path)),
  };
}
