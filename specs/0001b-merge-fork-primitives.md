# SPEC-0001b: Merge & Fork Primitives (engine support for the PR surface)

Status: draft · Date: 2026-10-24 · Amends: SPEC-0001 (engine scope), sibling amendment to
`specs/0001a-split-plane-amendment.md` (same design-of-record format; reuses its §3 Step 1
lease RPCs and §4 commit-builder verbatim).
Governs: `packages/git-engine/` (vendored durable-git @ `d5eba04`, see NOTICE.md; all
`file:line` references below point at the vendored state of the engine sources).
Consumers: SPEC-0005 §2.4/§3.4 (PR mergeability state machine, merge styles, PR head refs),
SPEC-0004 §2.3 `POST /repos/{owner}/{repo}/forks`, `GET /compare/{basehead}`.
Resolves: SPEC-0004 §6 open question 4 (fork object sharing). Reference implementations
read for this design (READ-ONLY): gitorange @ `b3d5b08` (Apache-2.0),
g1t @ `b697069` (Apache-2.0) — provenance rules in §8.

This amendment contains: the existing-capability audit with a reuse verdict per capability
(§2), the port-vs-fresh evaluation of the reference implementations (§3), the merge surface
— graph, three-way tree merge, mergeability classification, merge execution — with exact
TypeScript signatures on the split-plane terms (§4), the fork model that resolves
SPEC-0004 OQ#4 with a cost model (§5), the diff-surface completeness map for
SPEC-0004/0005 endpoints (§6), effort/risk per step (§7), NOTICE discipline (§8), test
checkpoints (§9), and the corrections SPEC-0001/0001a/0004/0005 need (§10).

## 1. Problem and scope

SPEC-0005 §3.4 names engine operations that do not exist yet: `mergeBase`,
`isAncestor` as a queryable primitive, a `git merge-tree` equivalent, `rev-list
--left-right --count` divergence, and a two-parent `mergeCommit` landing. SPEC-0004 OQ#4
leaves the fork object-sharing model to SPEC-0003/0005; SPEC-0005 §3.4 sketches a
`copyObjects(headRepo, baseRepo, reach(headSha))` op for fork PRs and defers its cost
model to "one combined engine-spec addendum" (SPEC-0005 §6.1). This is that addendum.

In scope:

- Commit-graph primitives: merge-base, ancestor test with an honest budget signal,
  divergence counts (§4.1).
- Three-way tree merge with line-level (diff3) merging and conflict reporting (§4.2).
- Read-only mergeability classification matching SPEC-0005's status machine, including
  the emptiness check (§4.3) — and the rule that a check writes nothing durable (§4.6).
- Merge execution for the styles SPEC-0005 needs from the engine (`merge`, `squash`,
  `fast-forward-only`, plus the `rebase`/`rebase-merge` replay), landing through the
  SPEC-0001a §4 CAS machinery, with multi-ref choreography for `refs/pull/N/head` (§4.4).
- The receive-path hook that keeps a PR head ref in lockstep with its branch (§4.5).
- Fork model: fork creation storage strategy and the fork→PR object relay (§5).
- Diff-surface completeness for every engine-backed tier-1 read SPEC-0004/0005 list (§6).

Out of scope: the D1 `pull_requests` row and status *storage* (SPEC-0005 §3.2), the
mergeability Queue worker's scheduling and `UpdateColsIfNotMerged` guard (SPEC-0005
§3.4), review/approval gates (tier 2), wiki/project forks, LFS pointers inside merges
(resolved verbatim as blobs — LFS is a later SPEC), rename detection in merges
(deliberate divergence from git merge-recursive, documented in §4.2), and the M3
compaction redesign (SPEC-0001 §5 — this SPEC only states its fork/compaction interplay,
§5.5).

## 2. Existing-capability audit (vendored engine, with reuse verdicts)

Everything below is what the vendored state already provides; the reuse column says what
each SPEC-0005 feature gets from it.

| Capability | Where | What it is | Reused by |
|---|---|---|---|
| Tree-scope commit diff | `readDiff` (`repo.ts:505`, via `computeDiff` `repo.ts:1151-1190`) | Two commits' root trees flattened (`flattenTree` `repo.ts:1140-1148`), per-path oid/mode comparison, per-file Myers hunks (`diff.ts:20 diffLines`, `:93 toHunks`), caps: `MAX_DIFF_FILES=100`, `MAX_DIFF_BLOB=512 KiB` (`repo.ts:40-41`), `truncated` flag | PR diff/patch and `/files` endpoints (§6); compare. Output shape (`DiffResult`/`DiffFileJson`) is the API layer's rendering input |
| Raw diff / format-patch renderers | `renderRawDiff` (`repo.ts:1226-1260`), `patchPage` (`repo.ts:1670-1698`) | Private UI methods producing git-compat patch text | **Not callable over RPC** — the API layer re-renders from `DiffResult` (§6); the byte shapes stay test-oracle targets, not shared code |
| Bounded ancestor walk | `isAncestor` (`protocol.ts:1054-1072`) | DFS from `desc` over parents, hard cap **10 000 visits** (`:1060`), used by force-push detection (`:1284`) | PR "already merged" detection (`ancestor` status) — reusable as a primitive, but the boolean hides budget exhaustion (a false negative marks a merged PR mergeable); the general form in §4.1 returns the exhaustion bit |
| Connectivity closure | `reachableComplete` (`protocol.ts:1118-1135`) — OidSet-as-frontier cursor walk seeded with validated ref tips; `packComplete` (`protocol.ts:1194-1223`) — flat-memory SQL anti-join | Receive-side gates | The fork object relay rides the whole receive path (§5.4) and gets these for free; merge execution reuses the tip+root-tree gate from SPEC-0001a §4.3 |
| Push validate/commit | `validatePush` (`protocol.ts:1225-1288`) / `commitPush` (`protocol.ts:1298-1347`) | Per-command CAS, refname validation (`BAD_REF` `:1106-1107`), HEAD fixup (`:1325-1333`), reachable-cache maintenance | Merge landing mirrors this shape (§4.4) but through `commitApiChange`'s transaction; PR-head sync on push adds commands to the same receive transaction (§4.5) |
| Pack generation "wants − haves" | `uploadPack` (`protocol.ts:519`), `excludedObjects` (`:374`), `collectPackOids` (`:477`) | Builds a pack of objects reachable from wants minus haves, sideband-framed | The fork→PR object relay calls this *as a protocol path* — zero new engine code (§5.4) |
| Full-repo reachability walk | `reachableOid` (`repo.ts:903-935`), `runGc` walk (`repo.ts:351-421`); versioned reachable cache (`store.ts:343-428`) | OidSet-based walks from all refs; `loadReachable` fast path | Fork creation does NOT need them (row replication, §5.3); `reachableOid` already makes any ref-reachable oid servable to the content methods, which is what lets `refs/pull/N/head` resolve today |
| Ref resolution | `resolveRef` (`repo.ts:938-950`) | Tries `refs/heads/<h>`, `refs/tags/<h>`, then `h` **verbatim** (`:943`), then `resolveServable` | `refs/pull/7/head` already resolves as a full ref — every content method and `readDiff` accepts PR refs with **no engine change**. This is load-bearing and pinned by a test (§9) |
| Commit walk (listing) | `walkLog` (`repo.ts:1036-1058`) | Date-ordered frontier walk, `MAX_LOG_SCAN=5000`, path/query filters | Log endpoints. **Not a range walk** — no `base..head` exclusion; PR commits and divergence need the new §4.1 primitives |
| Content reads | `listTree` (`repo.ts:485`), `readBlob` (`repo.ts:530`), `readCommit` (`repo.ts:466`), `listRefs` (`repo.ts:451`) | Typed RPC surface (DO-resident data reads per SPEC-0001a §5) | Compare/files endpoints; the merge internals use `store.get` directly (same process) |
| Line diff core | `diffLines` (`diff.ts:20-90`), budgets at `:14-17` (`MAX_LINES=40000`, `MAX_PRODUCT=4e6`, `MAX_D=2000`, returns `null` on overflow), `isBinary` (`:145-149`) | Myers O(ND) | The diff3 line merge (§4.2) is built **on top of this** — two Myers passes + region reconciliation; `null` overflow ⇒ conflict, same as gitorange's size gate |
| Object store | `GitStore`: `has` (`store.ts:95`), `typeAndSize` (`:100`), `put` (`:136`), `refs` (`:244`), `getRef/setRef/delRef` (`:252-267`), peeled cache (`:307-319`) | Loose + packed object access, memo tables | Merge execution stores derived objects via `GitStore.put` (§4.4); `peelToCommit`'s memo write (`repo.ts:968`) is the allowed shape of read-path caching (§4.6) |
| Serializers | `hashObject`/`objectHeader` (`objects.ts:16-22`), `parseCommit/parseTag/parseTree` (`:98-163`) | Read + hash side | SPEC-0001a §4 added the write side (`src/commit/serialize.ts`); merge/rebase commit construction reuses it — no new serializer code |
| Snapshot | `tarGz`/`zip` (`snapshot.ts:65/108`) | Archive builder, 16 MiB cap (`repo.ts:50`) | Nothing in the PR flow (lists for completeness); serves SPEC-0004 `GET /archive` |
| Blame | `blame` (`blame.ts:27`), `pathHistory` (`repo.ts:1061-1083`) | First-parent history + line attribution | Nothing in the PR flow (UI-only, stays put per SPEC-0001a §5) |
| Index rows / catalog | `pack_objects` rows + `pack_catalog` (SPEC-0001a §3 Step 4), `lookupObjects` (0001a §3 Step 2) | oid → (pack_key, offset, …) | Fork creation's row replication (§5.3) pages exactly these tables |
| Commit builder RPCs | `putApiObjects`/`commitApiChange` (SPEC-0001a §4.3) | Worker-built objects + single-ref CAS landing | Merge landing builds on the same pattern; §4.4 extends it with engine-side object derivation and multi-ref choreography |

Audit conclusion: the engine has every *leaf* the PR surface needs (diff, walks, object
IO, CAS landing) and none of the *graph algorithms* (merge-base, three-way merge,
replay). What is missing is one coherent module, not a rearchitecture.

## 3. Reference implementations: port vs fresh, evaluated honestly

| Algorithm | gitorange (Apache-2.0) | g1t (Apache-2.0) | Verdict |
|---|---|---|---|
| Merge-base | `GitService.mergeBase` (`worker/src/git/service.ts:240-255`): BFS from head capped `MAX_WALK=2000`, hit-test against a **first-parent-only** chain of base | `services/repos/src/merge_base.rs`: walks **every** parent on both sides and selects the "best" (undominated) common ancestor; the file header documents the production bug the first-parent approximation caused (g1t#365) | **Fresh.** gitorange's is an approximation with a known wrong-answer class; g1t's is correct but shaped around first-parent log reads. A bounded two-sided BFS over `store.get` (git's paint-down-to-common-ancestors shape) is ~120 LOC against our OidSet and needs no attribution gymnastics (§4.1) |
| Three-way tree merge | `mergeTrees` (`service.ts:391-443`) + `mergeFile` (`:446-498`): recursive tree reconciliation; per-file diff3 via the `node-diff3` npm package; 1 MiB/binary gate; conflict collection; read-only `planMerge` (`:501-548`) with `mb===base`/`mb===head` short-circuits | n/a (delegates to smart-HTTP relays) | **Port the structure, with attribution** (Apache-2.0 → NOTICE line + changes statement, §8): recursion shape, entry-same tests, one-sided mode pick, file/dir clash handling. **Fresh for the line merge**: node-diff3 is a new dependency for ~200 LOC we can own — our `diff.ts` already has the Myers core, and the diff3 reconciliation (~150 LOC) is differential-tested against `git merge-file` (§9). If the differential suite finds persistent divergence we fall back to vendoring node-diff3 (MIT) and record it — decision point at Step M-PR2 |
| Diff/changed-files | `diffTrees` (`service.ts:278-335`) — recursive, status-tracked | `services/repos/src/diff.rs` | **Reuse ours.** `readDiff`/`computeDiff` already do the tree-scope job with tighter caps; only a files-only mode is added (§6) |
| Patch identity (rebase skip) | `changesPatchId` (`worker/src/git/patch-id.ts:22-70`): sha1 over path+status+mode+normalized added/removed lines (indent kept, inner whitespace collapsed); blob-id fallback for binary/huge | patch-id identity in g1t's crates (same idea) | **Fresh port of the algorithm** (~60 LOC) with an attribution comment naming both sources — it is a re-implementation of `git patch-id` semantics, not novel code worth carrying verbatim |
| Rebase replay | `worker/src/git/rebase.ts:271-445`: topological order (Kahn, `:104-128`), `MAX_REBASE_COMMITS=100`, patch-id skip against upstream, merge-commit **carry-over** (`autoMerge`/`CARRY_OVER_MESSAGE`), AI-resolution trailers | n/a | **Partial port, simplified for Gitea parity**: keep topological ordering, patch-id skipping, author/committer preservation, conflict stop; **drop** carry-over (Gitea `rebase` = plain `git rebase` flatten — merge commits contribute no separate edits) and the AI-resolution trailer machinery (product-specific). ~200 LOC, attribution for the retained structure |
| CAS fast-forward landing | `worker/src/merge/land.ts:194-205`: one atomic push moving the base branch **and** `refs/pull/N/head` (`pullRef` `:38`) | `land.rs`: fetch-pack/push-pack relay; `EMPTY_PACK`; `fast_forward` (`:404`) | **Reference only — no port.** Our landing is `commitApiChange`/`executeMerge` CAS (§4.4); the two-ref atomicity is `extraRefUpdates` in the same transaction (§4.4). The relay pattern is re-derived over our own protocol paths (§5.4) |
| Object serializers | `makeTree`/`makeCommit`/`makeBlob` (`worker/src/git/objects.ts`) | — | **Already covered**: SPEC-0001a §4's `src/commit/serialize.ts` is our equivalent; note gitorange's tree sort (directories compared as `name+"/"`, `objects.ts:31-37`) is the canonical git ordering our serializer must already implement — assert it in fixtures (§9) |

License posture: both references are Apache-2.0. SPEC-0001 §8's provenance rule names
gitoxide; §10 extends it to any Apache-2.0 source with attribution + license reference —
recorded as a SPEC-0001 correction (§10). No ziggit (GPL-2.0) contact.

## 4. Merge surface

Placement decision, locked here: all §4 primitives are **engine-resident** typed methods
on `RepoCell` (the `readDiff`/`listLog` class of SPEC-0001a §1.1), not Worker-side logic.
SPEC-0005 §3.4 says the mergeability check is "implemented in the Worker from engine
object reads" — that wording assumed the engine had no merge ops. Corrected (§10): a
Worker-side merge would need a by-oid read RPC per touched object (hundreds of RPCs per
check) and would duplicate graph logic outside the engine; the Queue *worker* still owns
scheduling, and drives the check with one RPC. The split-plane hard rules are unaffected:
this is read-heavy graph work over DO-local SQLite/R2 — exactly the class SPEC-0001a §5
leaves in the DO until the content-surface migration.

### 4.1 Commit graph — `src/merge/graph.ts` (new)

```ts
/** Result of a bounded graph walk. `exhausted: true` means the budget ran out
 * BEFORE the answer was determined — callers must not treat `false`/partial
 * results as definitive (SPEC-0005 maps this to status `error` for re-check). */
export interface WalkAnswer<T> {
  value: T | null;      // null = not found / not determinable
  exhausted: boolean;   // visit budget consumed
}

/** Best common ancestor of two commits (git merge-base semantics: none of the
 * common ancestors is an ancestor of another). `a`/`b` are refs or oids,
 * resolved like readDiff's ids (full refs — including refs/pull/* — accepted).
 * Budget: MERGE_BASE_MAX_VISITS = 50_000 commit visits per side (OidSet-backed;
 * ~2 MB worst case). Returns the answer plus exhaustion. */
export async function mergeBase(
  store: GitStore, a: string, b: string
): Promise<WalkAnswer<string>>;

/** Is `anc` an ancestor of (or equal to) `desc`? Same walk budget.
 * `protocol.ts:1055 isAncestor` (receive's force-push check) is LEFT ALONE —
 * its boolean-with-silent-cap is correct for that caller (a false negative
 * only marks a push forced, which GC handles) and vendored diffs stay minimal. */
export async function isAncestorEx(
  store: GitStore, anc: string, desc: string
): Promise<WalkAnswer<boolean>>;

/** Commits in `head` but not `base` (range `base..head`), parents before
 * children (topological pass — the date-ordered `walkLog` frontier can invert
 * side-branch order, gitorange `rebase.ts:104-128` documents the fix),
 * oldest first, capped at `limit`; `more` when the cap truncated. */
export async function listCommitsRange(
  store: GitStore, base: string, head: string, limit: number
): Promise<{ commits: CommitJson[]; more: boolean } | null>; // null = head unresolvable

/** `git rev-list --left-right --count base head` equivalent, one walk.
 * ahead = base..head, behind = head..base. */
export async function countDivergence(
  store: GitStore, base: string, head: string
): Promise<WalkAnswer<{ ahead: number; behind: number }>>;
```

Method signatures on `RepoCell` (thin wrappers; `rpcBind()` first, like the existing
content methods):

```ts
async mergeBase(a: string, b: string): Promise<
  { tag: "ok"; base: string | null; exhausted: boolean } | { tag: "missing"; which: "a" | "b" }>;
async listCommitsRange(base: string, head: string, limit: number, page?: number): Promise<
  { commits: CommitJson[]; more: boolean } | null>;
async countDivergence(base: string, head: string): Promise<
  { tag: "ok"; ahead: number; behind: number; exhausted: boolean } | { tag: "missing" }>;
```

Semantics locked here:

- `mergeBase` walks both tips in committer-date priority over one shared OidSet with
  two mark roles (the OidSet tagged sub-set, `oidset.ts:14`); when the open frontier has
  no node that can still reach an unmarked common commit, the marked commons are the
  candidate set; the answer is the candidate no other candidate descends from (with one
  candidate the common case, this collapses to "the best commit"). Unrelated histories ⇒
  `{ value: null, exhausted: false }` — a real answer, distinct from exhaustion.
- All four functions are read-only (§4.6 applies).

### 4.2 Three-way tree merge — `src/merge/tree.ts`, `src/merge/diff3.ts` (new)

```ts
/** Conflicting path record (mirrors what the API's conflicted_files needs). */
export interface MergeConflictPath { path: string; kind: "content" | "delete_edit" | "add_add_binary" | "mode" | "file_dir" | "too_large"; }

/** In-memory candidates produced by a three-way merge. WRITES NOTHING — the
 * caller decides to store (executeMerge) or discard (checkMergeability). */
export interface MergePlan {
  /** root tree of the merge result; the canonical empty-tree sha when every
   * path resolved to deletion */
  tree: string;
  /** new blobs/trees to store (deduped by oid) — empty for clean fast cases */
  objects: { oid: string; type: ObjType; data: Uint8Array }[];
  conflicts: MergeConflictPath[];
  /** hard stop: changed-path cap or diff budget blown — not a conflict, an error */
  overflow: string | null;
}

/** Three-way merge of root trees. base/ours/theirs are tree oids (null = absent,
 * e.g. root commits or delete side). Caps: MAX_MERGE_FILES = 20_000 changed
 * paths, MAX_MERGE_FILE_BYTES = 1 MiB per file content merge (gitorange parity,
 * service.ts:56), diff budgets inherited from diff.ts (null ⇒ conflict). */
export async function planTreeMerge(
  store: GitStore, base: string | null, ours: string | null, theirs: string | null
): Promise<MergePlan>;
```

Semantics (ported structure, gitorange `mergeTrees`/`mergeFile` with the deltas noted):

- Entry reconciliation per directory level, recursing only where all present sides are
  trees: same(ours, theirs) ⇒ pick; base==ours ⇒ theirs; base==theirs ⇒ ours; both sides
  trees ⇒ recurse; blob-vs-tree at one name ⇒ `file_dir` conflict; otherwise file-level
  three-way merge.
- File-level: both sides must be regular files (100644/100755) or it is a conflict
  (`delete_edit`/`add_add_binary` kinds); one-sided mode change wins; competing mode
  changes ⇒ `mode` conflict. Content: `diff3` (below); conflict ⇒ `content` with the
  path listed. **Gitlinks (160000)** compare by oid — one-sided pick, both-changed ⇒
  conflict; **symlinks (120000)** likewise (target is the blob content). Binary or
  over-cap content ⇒ conflict, never a line merge attempt.
- **No rename detection** (divergence from git merge-recursive, documented): a renamed
  file is delete+add; if only one side renamed, the result keeps the rename; if both
  sides touched the old/new paths the paths conflict independently. Gitea itself
  surfaces this as a normal text conflict — clients resolve manually. Recorded as an
  intentional divergence in §10 for the compat notes.
- `diff3.ts`: three-way line merge built on `diffLines` — compute base→ours and
  base→theirs change maps, walk base line indexes, emit stable regions from either side
  and unstable regions where exactly one side changed; overlapping or adjacent unstable
  regions from both sides ⇒ conflict hunk with `<<<<<<<`/`>>>>>>>` markers (labels
  `ours`/`theirs` = branch names, supplied by the caller). Output is new blob bytes plus
  a conflict list; identical-to-one-side merges collapse to that side's blob (no new
  object).
- The canonical empty tree is computed by the serializer and asserted equal to
  `4b825dc642cb6eb9a060e54bf8d69288fbee4904` in fixtures (§9).

### 4.3 Mergeability classification — read-only, status-machine-exact

```ts
/** Engine outcomes for one mergeability check. Mapping to SPEC-0005
 * PullRequestStatus (models/issues/pull.go:44-57) is the API layer's job;
 * the table below is normative for the mapping. */
export type MergeabilityStatus =
  | "mergeable"    // → status 2 (mergeable)
  | "conflict"     // → status 0 (conflict), conflictedFiles populated
  | "ancestor"     // → status 6 (ancestor): head already in base
  | "empty"        // → status 5 (empty): merged tree == base tree (already applied)
  | "unrelated"    // → status 5 (empty): no common ancestor (upstream: "no merge base ⇒ empty")
  | "error";       // → status 4 (error): unresolvable ref or exhausted walk

export interface CheckMergeabilityInput {
  base: string;  // ref or oid (usually refs/heads/<branch>)
  head: string;  // ref or oid (usually refs/pull/<index>/head — resolves today, §2)
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
  /** merge_base..head / head..merge_base counts; 0 when mergeBase is null */
  commitsAhead: number;
  commitsBehind: number;
};
export type CheckMergeabilityMissing = { tag: "missing"; which: "base" | "head"; ref: string };
export type CheckMergeabilityResult = CheckMergeabilityOk | CheckMergeabilityMissing;
```

Method on `RepoCell`:

```ts
async checkMergeability(input: CheckMergeabilityInput): Promise<CheckMergeabilityResult>;
```

Decision procedure (mirrors upstream `checkPullRequestMergeableByMergeTree`,
`services/pull/merge_tree.go:52`, step for step):

1. Resolve both ids; unresolvable ⇒ `missing` (API keeps/sets status `error`).
2. `mergeBase(base, head)`; exhausted ⇒ `status: "error"` (the Queue worker re-checks;
   SPEC-0005's crashed-check self-heal covers it). No common ancestor ⇒ `unrelated`.
3. `head === mergeBase` or `isAncestorEx(head, base)` true ⇒ `ancestor` (short-circuit:
   nothing to merge; upstream's `merge-base --is-ancestor` merged-detection folded in).
4. If `base === mergeBase` (fast-forward shape) the merged tree IS `head`'s tree — skip
   the walk (gitorange `planMerge` short-circuit, `service.ts:515-524`).
5. `planTreeMerge(mergeBase.tree, base.tree, head.tree)`: `overflow` ⇒ `error`;
   conflicts ⇒ `conflict` (+ list); else:
6. **Emptiness check — `mergedTree === baseCommit.tree`.** Upstream runs
   `diff-tree -r --quiet mergedTree baseCommit`; content addressing makes that an oid
   comparison (tree oid equality is recursive equality; zero blob reads). Equal ⇒
   `empty` (the PR's changes are all applied); else `mergeable`. `commitsAhead/Behind`
   from one divergence walk (§4.1) ride along so the check populates the D1 row in one
   RPC.

### 4.4 Merge execution — one landing primitive, styles as parameters

```ts
export type MergeStyle = "merge" | "squash" | "fast-forward-only";

export interface ExtraRefUpdate {
  /** full ref name, same validation as receive (BAD_REF rules) */
  ref: string;
  expectedOldOid: string;         // CAS base; ZERO_OID = create
  newOid: string | null;          // null = delete
}

export interface ExecuteMergeInput {
  style: MergeStyle;
  base: string;                   // ref or oid; ref is resolved to its CURRENT tip
  head: string;                   // ref or oid
  /** CAS base: the base-ref tip the caller classified against (from D1's last
   * check or a fresh read). Mismatch ⇒ ref_conflict (mapped to 409 per SPEC-0004). */
  expectedBaseOid: string;
  /** merge/squash commit metadata (fast-forward-only ignores) */
  message: string;
  author: Person;
  committer: Person;
  /** ref choreography applied atomically with the base move (see table) */
  extraRefUpdates: ExtraRefUpdate[];
}

export type MergeCommitted = {
  tag: "committed";
  commitOid: string;              // new base tip (merge/squash commit, or head for FF)
  mergeBase: string;
  refsVersion: string;            // post-commit edge-cache key (T4)
  commitTime: number;             // registry upsert input, same as receive/§4
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
export type ExecuteMergeResult =
  | MergeCommitted | MergeNotFastForward | MergeConflict
  | MergeNothing | MergeRefConflict | MergeInvalid;
```

Method on `RepoCell`:

```ts
async executeMerge(input: ExecuteMergeInput): Promise<ExecuteMergeResult>;
```

Semantics locked here:

1. Resolve `base` to its current tip; `current !== expectedBaseOid` ⇒ `ref_conflict`
   with the live tip (the caller may re-check and retry, or 409 per SPEC-0004).
   Resolve `head`; unresolvable ⇒ `invalid`.
2. Run the §4.3 classification against the freshly read tips (never the caller's
   stale classification): `nothing_to_merge`/`conflict` results carry the check's
   outcome. The 405-on-not-mergeable policy (SPEC-0005 §3.4) lives in the API layer.
3. Style mechanics:
   - `fast-forward-only`: `mergeBase === baseTip` required, else `not_fast_forward`
     (upstream refuses, `services/pull/merge.go`). No new objects; `commitOid = head`.
   - `merge`: `planTreeMerge` ⇒ store `objects` via `GitStore.put` ⇒ serialize the
     two-parent commit (`parents = [baseTip, headTip]`, message/author/committer from
     the input) ⇒ that oid is the landing target.
   - `squash`: same tree computation, **one** parent (`[baseTip]`) — gitorange's
     `method: 'squash'` parent rule (`service.ts:567`).
4. Landing is ONE `storage.transactionSync`: re-CAS base ref (`commitApiChange`'s
   rules: refname validation, presence of the new oid + root tree, CAS, ref write,
   `updated_at`/`peeled` for tags, `refs_version` bump) **plus** every
   `extraRefUpdates[i]` with its own CAS (a conflicting extra update fails the whole
   transaction — the base does not move without its choreography) **plus** the same
   HEAD fixup as `commitPush` (`protocol.ts:1325-1333`). Objects are stored BEFORE the
   transaction (async R2 reads are not legal inside `transactionSync`); they are
   content-addressed, so a lost CAS leaves ordinary unreferenced loose objects for the
   sweep — exactly the SPEC-0001a §4.5 posture.
5. `Person` is the existing `objects.ts:24` type; commit serialization is
   `src/commit/serialize.ts` (SPEC-0001a §4) — no new serializer.

Style choreography table (who passes which `extraRefUpdates`):

| Style (SPEC-0005 §3.4 `do`) | base ref | caller's extraRefUpdates |
|---|---|---|
| `merge` | move to the new two-parent commit | usually `[]` (upstream keeps `refs/pull/N/head` at the old head); gitorange-style landing passes `{refs/pull/N/head, old, headSha}` |
| `squash` | move to the new single-parent commit | optionally the head-branch delete (`newOid: null`) when the UI deletes after squash |
| `fast-forward-only` | move to `head` | optionally the same PR-head retarget as `merge` |
| `rebase` / `rebase-merge` | `rebaseOnto` (below) computes the tip; then this primitive with style `fast-forward-only`, `head` = rebased tip, plus `{refs/pull/N/head}` and the head-branch rewrite when `allow_maintainer_edit`/push rights say so |
| `manually-merged` | engine only verifies ancestry: `isAncestorEx(MergeCommitID, baseTip)` via the existing primitive; no `executeMerge` call |

### 4.5 Rebase replay — `src/merge/rebase.ts` (new, partial port)

```ts
export type RebaseOutcome =
  | { tag: "up_to_date" }                  // head already sits on `onto`
  | { tag: "too_many"; count: number }     // own commits > maxCommits (default 100)
  | { tag: "conflict"; atOriginal: string; conflicts: MergeConflictPath[];
      /** commits replayed before the stop (for partial bookkeeping) */
      commits: { original: string; rebased: string }[] }
  | { tag: "rebased";
      headOid: string;
      commits: { original: string; rebased: string }[];
      /** commits left out: already applied upstream (patch identity) or emptied */
      skipped: number;
      /** all objects to store before the refs move (caller: putRebaseObjects) */
      objects: { oid: string; type: ObjType; data: Uint8Array }[] };

export interface RebaseOntoInput {
  head: string;        // branch/ref/oid replayed
  onto: string;        // new base commit (target branch tip)
  committer: Person;   // authors/author dates are preserved from each commit
  maxCommits?: number; // default 100 (gitorange MAX_REBASE_COMMITS parity)
}
```

Method on `RepoCell`:

```ts
async rebaseOnto(input: RebaseOntoInput): Promise<RebaseOutcome>;
async putRebaseObjects(objects: { oid: string; type: ObjType; data: Uint8Array }[]):
  Promise<{ tag: "ok" } | { tag: "too_large"; limitBytes: number } | { tag: "invalid"; reason: string }>;
```

Semantics: `listCommitsRange(onto, head)` (topological, §4.1) capped at `maxCommits`;
each own commit is replayed as a three-way merge (base: its parent's tree; ours: replay
so far; theirs: the commit's tree) preserving author/date/message, committer = input;
merge commits are **flattened** (Gitea `git rebase` parity — no carry-over, §3); a
commit whose `patchId` (normalized added/removed lines per path, §3) already exists in
the commits `onto` gained since the merge base is skipped, as is a commit whose replay
changes nothing; first conflict stops with the offending original oid and its conflict
paths. `rebaseOnto` itself is read-only + in-memory; `putRebaseObjects` is
`putApiObjects`' DO-side store step re-exposed (same `PutApiObjectsResult` shape and
budgets — implementation delegates to it); the ref moves are then §4.4 style
`fast-forward-only` with the choreography. This split keeps the replay testable without
writes and reuses one object-ingest path.

### 4.6 The read-only rule (checks never write)

`checkMergeability`, `mergeBase`, `listCommitsRange`, `countDivergence`, `planTreeMerge`,
and `rebaseOnto` perform **no durable writes**: no `GitStore.put`, no ref/meta writes,
no catalog rows, no cache invalidation. The only writes permitted on these paths are the
existing derived-memo writes (`setPeeled` `repo.ts:968`, stats cache) — content-keyed,
self-verifying, and swept by the mechanisms that already own those tables. Candidate
objects built by a check or a conflict-aborted rebase are discarded with the call; a
merge/rebase that loses its CAS leaves unreferenced loose objects for the sweep
(SPEC-0001a §4.5). Test checkpoint §9 asserts this by object-count delta.

### 4.7 PR-head sync on push — receive-path integration (extends 0001a §3 Step 1)

SPEC-0005 §3.4 requires `refs/pull/N/head` to move "in the same RepoDO transaction as
the branch commit". When the push lands in the base repo itself, the Worker composes
this **inside the existing receive transaction** — no new RPC:

`FinalizeReceiveInput` (SPEC-0001a §3 Step 1) gains one optional field:

```ts
export interface FinalizeReceiveInput {
  // … exactly as SPEC-0001a §3 Step 1 …
  /** PR-head (and similar housekeeping) ref updates applied in the SAME
   * transaction as `commands`, CAS'd per entry, but EXCLUDED from `results`
   * (which stays index-aligned with the client's commands — report-status must
   * never name a ref the client did not send) and INCLUDED in `updates`
   * (hooks/webhooks see them). */
  extraRefUpdates?: ExtraRefUpdate[];   // the §4.4 type
}
```

The Worker derives the entries from its open-PR index (D1) after the pack scan
succeeds: for each branch update, every open PR whose `(head_repo_id, head_branch)`
matches gets `{ref: "refs/pull/N/head", expectedOldOid: recordedHeadSha, newOid:
command.next}`. Divergence/status/queueing stays Worker-side per SPEC-0005 §3.4. For
fork pushes (the push lands in the fork, not the base) the PR-head CAS is a standalone
`commitApiChange` call in the base repo — single-ref, retriable, no atomicity
requirement (the branch commit that matters already happened elsewhere).

### 4.8 Ref delete — `deleteApiRef` (small 0001a gap)

`commitApiChange` cannot delete (SPEC-0001a §4.3: `newOid` must be stored). The PR
lifecycle needs CAS deletes: creation-failure cleanup (SPEC-0005 §2.4, upstream
`services/pull/pull.go:157-162`), issue-delete cascade (SPEC-0005 §4.12 `removeRef`),
merged-head-branch deletion.

```ts
export interface DeleteApiRefInput { ref: string; expectedOid: string; }
export type DeleteApiRefResult =
  | { tag: "deleted"; refsVersion: string }
  | { tag: "ref_conflict"; currentOid: string | null }  // null = ref already gone (idempotent ok)
  | { tag: "invalid"; reason: string };
async deleteApiRef(input: DeleteApiRefInput): Promise<DeleteApiRefResult>;
```

One `transactionSync`: refname validation → CAS (`current === expectedOid`, already-gone
⇒ `deleted` — delete idempotence is the caller-friendly reading of a cascade) →
`delRef` → `refs_version` bump. Branch deletes for real branches go through the same
RPC from the SPEC-0004 branch service.

## 5. Fork model (resolves SPEC-0004 §6 OQ#4)

### 5.1 Options considered

**(a) Copy objects at fork time (queue-driven).** The fork gets its own `storage_key`,
and a Queue consumer replicates the parent's *store* — not a reachable-set extraction,
but a byte-exact catalog copy: R2 packs via same-bucket server-side copies (no parse,
no inflate, no egress), `pack_catalog` + `pack_objects` rows via paged DO→Worker→DO
replication (§5.3), then refs + HEAD + `meta` in one finalizing transaction. What it
costs and what it buys are quantified in §5.2.

**(b) Lazy shared packs** — `pack_catalog` rows in the fork referencing the parent's
pack keys. What breaks, concretely:

- *Reachability/connectivity checks are fine* (index rows work regardless of where the
  bytes live) — that is the option's one genuinely cheap part. Everything else breaks:
- *Deletion is the killer.* SPEC-0003 §2.5.5 step 3 purges `repos/<storage_key>/` by
  prefix, by design name-independent and stateless. With shared packs, deleting the
  parent bricks every fork: refs pointing at objects whose pack bytes vanished (the
  orphan sweep cannot help — the *fork's* catalog still references the deleted keys).
  Making prefix purge safe requires refcounts on pack keys, cross-DO coordination
  (parent purge must consult every fork's DO), delete ordering (fork-before-parent
  enforcement or copy-on-parent-delete fallback), and crash windows at every step —
  exactly the class of hazard the copy-before-finalize rule (SPEC-0001a §3 Step 1)
  exists to avoid. "Shared packs make prefix purge dangerous" is verified: it does.
- *Compaction (M3) re-fires the problem forever.* Compaction rewrites the pack set and
  deletes superseded packs (`pack_catalog.superseded_by`). Every such rewrite in the
  parent dangles every fork's shared rows unless compaction becomes refcount-aware or
  pushes re-point messages to all forks — a standing cross-repo coupling in the
  repo-local maintenance path.
- *The small-pack escape hatch is structurally incompatible.* 0001a §8 correction 2
  keeps packs < 16 MiB in the DO's SQLite (`location='sqlite'`). Those bytes are
  physically unreachable from another DO — young repos (the majority of forks) share
  nothing and still need the copy path. The option is partial even in theory.
- *Tenancy collapses.* The RepoDO is the authorization boundary; a fork's DO reading
  the parent's R2 keys means one repo's data is served through another repo's trust
  root. Visibility flips and private parents with public forks (upstream forbids, but
  flip sequences create windows) turn a storage optimization into an ACL review.
- *Clone fast path gains nothing.* `currentPackKey` (`repo.ts:430-433`) is per-repo
  versioned; forks still build their own clone-cache entries.

**(c) No sharing — fork = empty repo + client-side push.** Trivially correct, product-
broken: `POST /forks` returning an empty repo fails the observable contract (forks are
clonable immediately upstream), breaks fork-PR creation for every client, and pushes
the copy problem to users. Rejected.

### 5.2 Decision: (a), quantified

**Recommendation: full copy at fork time, queue-executed; no cross-repo pack sharing,
ever.** Cost model (per fork):

| Component | Cost | Bound |
|---|---|---|
| R2 pack copies | N_packs server-side `copy` ops (~tens of ms each) | N_packs = active catalog rows (compaction keeps this ≈ K, SPEC-0001 §5) + archive packs; worst case = push count, still ≤ a few hundred ops — one queue consumer budget |
| Index rows | O(objects) SQLite inserts, batched ~1000/transaction | 1 M objects ≈ 100 MB DO SQLite (T6: ~100 B/object; 10 GB cap ⇒ ~100 M objects), ≈ 1000 batched transactions ≈ 1–3 min in the consumer |
| Pack bytes | 2× repo bytes in R2 per fork | R2 at ~$0.015/GB-month: a 1 GB repo with 100 forks ≈ $1.50/month — the entire saving option (b) fights for |
| Steady state | **zero coupling** — delete stays a pure prefix purge (SPEC-0003 §2.5.5 unchanged); compaction stays repo-local; parent delete leaves forks fully functional (upstream: forks survive their parent) | — |

Option (b) trades that ~$1.50 for a refcount table, compaction coupling, delete-order
hazards, a structurally-partial model, and a tenancy review. Not close.

Consequences pinned by this decision:

- SPEC-0003 §2.5.5 needs **no correction** — prefix purge remains complete and safe.
- Fork lineage is metadata only (D1 `fork_parent_id`-style column, SPEC-0003/0005
  table business): upstream sync (`POST /merge-upstream`) and fork PRs read the parent
  through the API layer, never through storage.
- M3 compaction treats a fork's catalog exactly like any repo's (copies are ordinary
  packs; `next_pack_seq` and pack names are per-repo, and identical bytes under the
  same `pack-<sha1>` name dedupe naturally per SPEC-0001a §3 Step 3).

### 5.3 Fork creation flow — catalog replication (engine additions)

The queue consumer (own budget, SPEC-0003 §2.5.5 discipline) runs:

1. D1: create the fork row (new `storage_key`), status 202 to the caller (SPEC-0004
   declares the async fork already).
2. Fork RepoDO RPC `beginForkImport(storageKey)` — sets `meta.importing=1` (gates
   `beginReceive`/`commitApiChange`/`executeMerge` with a `busy` variant while set),
   so a push cannot race the replication.
3. Copy loop (Worker brokers, both DOs are same-account RPC endpoints):
   `listCatalogPage(afterPackKey, limit)` on the parent → for each row: R2
   `bucket.copy(forkKey, parentKey)` for `.pack` + `.idx` →
   `listIndexRows(packKey, afterOid, limit)` on the parent → bulk insert on the fork.
4. Finalize on the fork: one `transactionSync` inserting the catalog rows (verifying
   pack names still match their row keys), refs + peeled + `meta.head` + `storage_key`,
   clearing `meta.importing`. Crash-safe by idempotent re-run: steps 3–4 re-list and
   re-insert (rows are keyed, copies overwrite) until finalize commits.

Engine RPC surface (all new, control-plane class — control data only, no pack bytes
through the DO boundary):

```ts
export interface CatalogPage {
  packs: ({ packKey: string; kind: "receive" | "compact"; state: "active" | "superseded";
            location: "r2" | "sqlite"; objectCount: number; packBytes: number;
            idxBytes: number | null } & { rows: IndexRow[] })[];  // IndexRow = 0001a §3 Step 2 type
  more: boolean;
  /** true when any row has location 'sqlite' — the consumer must route those
   * through putApiObjects-style rehydration instead of an R2 copy (rare: small
   * repos; the row bytes ride the DO RPC, bounded by the 16 MiB threshold) */
  hasLocalPacks: boolean;
}
async listCatalogPage(afterPackKey: string, limit: number): Promise<CatalogPage>;
async beginForkImport(storageKey: string): Promise<{ tag: "ok" }>;
async adoptForkPacks(page: CatalogPage): Promise<{ tag: "ok" } | { tag: "invalid"; reason: string }>;
async finalizeForkImport(input: { refs: { name: string; oid: string }[]; head: string | null }):
  Promise<{ tag: "ok"; refsVersion: string } | { tag: "invalid"; reason: string }>;
```

(`listCatalogPage`/`adoptForkPacks` run on the parent / fork respectively; `IndexRow`
is reused verbatim so receive's Step 2 batches and fork replication share one row
shape.) `PUT /config`-style metadata (description, visibility) is D1-side and not
copied by the engine.

**Annotated-tag fidelity on copied repos (intentional divergence, as-built ab5d300).**
Upstream preserves tag-object bytes across fork/generate/rename (it moves `.git`
content on disk); this stack carries annotated tags through the §5.3 lease in two
classes. **Packed/pushed** tips stay byte-identical — they carry as plain refs and the
adopted packs bring the tag objects' true bytes (finalize re-peels from them).
**Loose** tips (Worker-authored via the tags API) are re-materialized through the same
`serializeTag` the writer used, with `tagger=null` / `message=""` — the read RPC
surface cannot recover tag-object bytes (`readCommit` peels past them; `listRefs`
carries only targets + the peel cache), so tagger/message are unrecoverable. The
materialized oid is a deterministic function of (name, peel), so rename-back and
fork/generate cycles are stable; name and peeled commit always match the source, only
the oid of a tag that originally carried a tagger line or message differs. Surfaces:
fork and template-generate ride this §5.3 consumer (`src/repos/fork-task.ts`
`completeLooseImport`), rename/transfer rides the same RPCs (`src/repos/carry.ts`
`carryRepoCell` — the module header holds the full fidelity note, and is the
authoritative detail).

**As-built redesign — the Worker brokers §5.3 itself; the loose closure is
UNCONDITIONAL (intentional, as-built 8828f43).** The original design above
delegated the whole replication to the engine's one-shot `replicateForkCatalog`
(`packages/git-engine/src/fork/replicate.ts:114`); the Worker carried loose
content only in the failure arm, when the engine's finalize REFUSED. That shape
was structurally blind below the tips: finalize's object validation checks each
REF TIP against the adopted object set and nothing else
(`control-plane.ts:1369` — `store.has(r.oid)` per ref, no closure walk), and
this engine's packs are thin-pack + loose-base, NOT closure-complete — a push
stacked on Worker-authored `auto_init` content legally names loose objects from
inside the pack (parent lines, tree entries). So finalize succeeded while the
loose INTERIOR — reachable only through the packed tips' parent lines — was
silently skipped, and the copy served API reads (tip resolution only) while the
git wire died: upload-pack's object walk threw `missing object` on the absent
parent (the silent 500, `src/git/protocol.ts:686`), and a later push's
anti-check rejected with `missing necessary objects`
(`src/git/protocol.ts:1571`). 8828f43 redesigns the flow:
`src/repos/fork-task.ts:210` `replicateRepoCopy` brokers §5.3 itself —
`beginForkImport` (the not-empty refusal IS the already-done success) → the
paged catalog copy/adopt loop (`listCatalogPage` at `fork-task.ts:261`,
streamed R2→R2 pack copies, `adoptForkPacks` per page) → the UNCONDITIONAL
loose carry inside the open lease (`carryLooseRefs`, `src/repos/carry.ts:438`
— stages nothing for packed oids but descends THROUGH packed commits'
cross-store parent/tree edges to reach the loose class, budgeted at
`PACKED_WALK_MAX_COMMITS = 64` packed commits, `src/repos/carry.ts:150`) →
ONE finalizing transaction (`fork-task.ts:304`). Template-generate rides the
same pass synchronously (`src/api/services/generate-repo.ts`), rename/transfer
through `carryRepoCell` (`src/repos/carry.ts:267-281`) — one descent, all
three surfaces. The 64-commit budget is a documented FIDELITY LIMIT, not a
correctness bar (`carry.ts` module doc): when the descent expires before
proving the closure — histories deeper than the budget above their loose
objects — the copy lands with the pre-8828f43 floor for that closure, flagged
by the `truncated` return and logged loudly (`fork-task.ts:292-298`; the
rename path's twin log `carry.ts:275-281`). The structural alternative —
engine-side loose-store enumeration or a closure-validating finalize — was
deliberately NOT taken: either is an engine deviation under the §8 NOTICE
discipline, and 8828f43 is engine-untouched / NOTICE-free by design; the
fidelity limit lifts when an engine wave takes that work. Supersession note
for the §5.3.1 table below (recorded against the pre-8828f43 tree, half an
hour before the redesign landed): the "Whole-catalog copy vs depth-1 clone"
row's mechanism claim — whole catalog PLUS the loose closure via this §5.3
pass — holds, but its `src/repos/fork-task.ts` cites (`:248-300` and
`completeLooseImport :191-208`) name the pre-redesign shape; the as-built
symbols are `replicateRepoCopy` / `replicateCatalogAndLooseClosure` +
`carryLooseRefs`, and the annotated-tag paragraph above's `completeLooseImport`
mention is superseded the same way (that paragraph's two-class tag record, and
the "Annotated-tag loose fidelity" row, are unaffected). Where those cites and
this paragraph disagree, this paragraph is the as-built record.

#### 5.3.1 As-built divergence record — the repo-copy surface (fork / template-generate / rename carry)

Consolidated record of the intentional divergences from upstream
ForkRepository/GenerateRepository/rename that previously lived only in the
module documentation headers (`src/repos/fork-task.ts`,
`src/api/services/generate-repo.ts`, `src/repos/carry.ts`, and the adjacent
`src/api/services/forks.ts` service header). Recorded 2026-10-26; every cite
below was verified against the current code and the pinned `gitea/` submodule
on that date. This is a record only — no new decisions.

| Divergence | Upstream behavior (pinned submodule) | This stack | Where implemented |
|---|---|---|---|
| Fork wire emptiness during creation | `ForkRepository` builds the row with `IsEmpty` copied from the base before the clone (`services/repository/fork.go:100`); the synchronous flow never serves a fork whose content flag is not settled | The fork row is minted `is_empty=true` (column default) and the wire serves `empty:true` for the whole `creating` window — nothing is servable before finalize — then the settle copies the source's emptiness | mint `src/repos/service.ts:296` + `src/db/schema.ts:42`; wire `src/api/services/repository.ts:317`; settle `src/repos/fork-task.ts:146,332` |
| `num_forks` tally timing | `IncrementRepoForkNum` runs INSIDE `ForkRepository`'s creation transaction (`services/repository/fork.go:108-118`, call `:112`; `models/repo/fork.go:57-61`) — the tally moves at row mint; the template-generate copy never counts | The increment rides the settle's ONE D1 batch, guarded by the fork row still `creating` — the tally moves when the fork becomes SERVABLE, not at mint (a template-generated repo never counts, same as upstream). Fork-delete/child-reset counter arms keep it honest (`services/repository/delete.go:224-228` / `:282-285` ↔ `src/repos/service.ts:604-611,632-637`) | `src/repos/fork-task.ts:339-350` (`settleForkRow`); column = migration 0031, documented at `src/db/schema.ts:179-203` |
| Orphaned fork shell | No equivalent — the fork is one synchronous transaction; the source cannot vanish mid-create | Source deleted while the message sits in the queue: the shell settles ready-empty (a visible empty repo beats a permanent `creating`), the tally arm matches nothing, no `fork` event | `src/repos/fork-task.ts:129-142` |
| Lost enqueue strands `creating` | Synchronous clone in-request; failure cleans up via the deferred `cleanupRepository` (`fork.go:125-132`) | A failed REPO_TASKS enqueue leaves the fork `creating`: logged admin-notice posture, the 202 stands | `src/api/services/forks.ts:134-145` |
| `IsPrivate` copy rule | `IsPrivate: base.IsPrivate \|\| base.Owner.Visibility == private` (`fork.go:99`) — the base OWNER's visibility ORs in | Only the base repo's visibility flag copies (no org/user visibility columns yet) | `src/api/services/forks.ts:117` |
| No LFS copy | `git_model.CopyLFS` after the copy on both paths (`fork.go:117`, `generate.go:299`; `models/git/lfs.go:256`) | No LFS arm on fork or generate — LFS objects are not copied | Absence verified across `src/repos/fork-task.ts` / `src/api/services/generate-repo.ts` (header claim, current) |
| No repo-count limit | Generate: `CanCreateRepoIn` → `ErrReachLimitOfRepo` (`template.go:71-75`); fork: sibling `CanForkRepoIn` → same error (`fork.go:68-71`) | Neither copy path checks any repo-count limit | Absence verified repo-wide (no `CanCreateRepoIn`/`ReachLimit` in `apps/worker/src`) |
| Size-settle failure posture | Fork path: `UpdateRepoSize` failure is logged and ignored ("even if below operations failed, it could be ignored", `fork.go:189-192`); generate path: the error FAILS the generate (`generate.go:295-297`) | The ignore posture applies to BOTH paths: size re-accounting failures log and keep the previous settled value, never fail the copy | `src/repos/fork-task.ts:292-299` (`syncRepoSizeFromStorage`) |
| No template variable substitution | `generateRepoCommit` expands `{YEAR}\|{MONTH_ENGLISH}\|{REPO_NAME}\|{TEMPLATE_NAME}\|{REPO_OWNER}\|{TEMPLATE_OWNER}\|…` transformers in `.gitea/template`-matched files (`generate.go:33-90` transformers + `generateExpansion`, `:154-168` `substGiteaTemplateFile`, driven from `:253-258`) | Byte-faithful catalog copy — no expansion pass exists | `src/api/services/generate-repo.ts:155-157` |
| Whole-catalog copy vs depth-1 clone | `generateRepoCommit` clones the template at depth 1 on its default branch and re-inits with a fresh commit (`generate.go:233-239`) | The generate copy adopts the template's whole pack catalog plus the loose closure — a superset of the default branch — via the same §5.3 pass the fork consumer runs | `src/repos/fork-task.ts:248-300` (+ `completeLooseImport` `:191-208`) |
| Inert template units | Topics, git hooks, webhooks, avatar, issue labels, protected branches each have a copy arm (`template.go:141`, `:148`, `:155`, `:162`, `:169`, `:175`) | The flags are accepted — satisfying IsValid's at-least-one rule (`generate.go:324-329`) — but only `git_content` copies; the rest are inert and the request succeeds with a bare copy | `src/api/services/generate-repo.ts:70-80` (parse) / `:155` (only `git_content` honored) |
| No CreateRepository webhook on generate | `notify_service.CreateRepository` ends `GenerateRepository` (`template.go:191`) | The generate path emits no repo-create event yet; the fork path DOES emit `fork` (`services/webhook/notifier.go:86-91` ↔ `src/repos/fork-task.ts:149-176`, SPEC-0005 §3.5) | Absence verified in `src/api/services/generate-repo.ts` |
| Annotated-tag loose fidelity | Upstream moves the `.git` storage content, so tag-object bytes survive fork/generate/rename | As recorded in the paragraph above: packed tips byte-identical; loose tips re-materialized `tagger=null`/`message=""` — oid may differ, name and peel identical | `src/repos/carry.ts:373-405` (`carryLooseRefs`); detail in the paragraph above |
| Rename/transfer degraded carry floor | `ChangeRepositoryName` renames the git-repo storage itself (`git.RenameRepository`, `services/repository/transfer.go:369-397`) — content moves with the name | D1 lands first; the cell carry is best-effort synchronous — a carry failure is logged, the D1 mutation stands, and the new URL serves empty until a push heals it | `src/repos/carry.ts:140-249` via `src/repos/service.ts:749-756` (route wiring `src/api/routes/repo.ts:462`) |

Header cites corrected during this consolidation (the headers themselves belong
to their module owners and were not edited): `src/api/services/forks.ts:39-41`
claims the `num_forks` bump is skipped and `forks_count` renders 0 — superseded
by migration 0031 (row 2 above); `src/api/services/generate-repo.ts:45` names
`git_model.CopyLFR` — the upstream symbol is `CopyLFS`; its upstream line cites
drifted: the default-branch `IfZero` chain is `generate.go:233` (header says
`:254`), `IsValid` is `generate.go:324-329` (header says `:311-315`), the
`template.go` status flip is `:185-189` and the notify `:191` (header says
`:181-187` / `:190`). Where this table and a module header disagree, the table
is the verified record.

### 5.4 Fork→PR object relay (resolves SPEC-0005 §6.2's cost question)

When a PR's head repo differs from its base repo, the base must contain the head
commit's objects before `refs/pull/N/head` can be written (SPEC-0005 §2.4,
`PushToBaseRepo`). With §5.2 decided, the fork owns its new commits exclusively — the
relay moves only the missing set, and it needs **zero new engine code**: the Worker
drives the two existing protocol paths over service bindings, g1t's `land.rs` pattern
re-derived on our own stack:

1. `git-upload-pack` on the **fork**: want = head branch tip, haves = base repo's ref
   tips (SPEC-0001 §5 negotiation) → sideband-framed thin pack of exactly
   `reach(head) − reach(baseTips)` — the `excludedObjects`/`collectPackOids`
   machinery (`protocol.ts:374/477`) does the set math.
2. `git-receive-pack` on the **base** (the SPEC-0001a Step 1 Worker pipeline):
   one synthetic command `ZERO_OID <headSha> refs/pull/N/head` + the pack. Lease, thin
   -pack resolution against base tips, scan, connectivity check, catalog row, CAS ref
   create + `refs_version` bump all reuse the receive path wholesale; one internal
   receive lands objects and ref in one transaction.
3. Same-repo PRs (head branch in the base repo): no relay at all — the ref CAS is the
   whole operation. Agit-flow PRs: the head commit already landed in the base
   (`refs/for/...` receives into the base), likewise no relay.

Cost answer to SPEC-0005 OQ#2: the relay moves a thin pack of the PR's own objects —
bytes proportional to the PR, not the fork — over one upload + one receive, seconds
bounded, no reachable-set walk written by hand. It takes the base repo's receive lease,
so a concurrent user push gets the standard `503 Retry-After` for the duration.

### 5.5 Interplay summary

| Concern | Effect of §5.2 |
|---|---|
| `refs/pull/N/head` (SPEC-0005) | Written in the base repo only; objects relayed per §5.4; fork delete never dangles it (base-local bytes) |
| Repo delete purge (SPEC-0003 §2.5.5) | Unchanged: `repos/<storage_key>/` prefix purge is complete for copies; parent delete cannot strand forks (they own their bytes) |
| Compaction (M3) | Repo-local; a fork's initial catalog is just its starting pack set; API-written loose objects and merge objects fold in per SPEC-0001a §4.6 |
| Clone fast path / `reachable` cache | Per-repo as today; the fork's cache builds on its own first serve |
| Quota | Fork copy counts against the fork's storage quota at adopt time (D1-side accounting, engine reports row counts) |

## 6. Diff surface completeness (endpoint → primitive map)

Division of labor: the engine owns graph/tree/blob access and returns structured JSON
(`DiffResult`/`DiffFileJson` shapes already exist); the API layer renders raw text
(unified diff, format-patch) from that JSON — `renderRawDiff`/`patchPage` stay private
UI code, and their byte shapes remain the CI oracles the API renderer is tested
against. Every endpoint below is engine-backed per SPEC-0004 §2.4.

| Endpoint (owner) | Range / input | Engine primitive | Status |
|---|---|---|---|
| `GET /pulls/{index}.{diffType}` (SPEC-0005 §3.4) | three-dot: `merge_base.tree → refs/pull/N/head.tree` | `checkMergeability` returns `mergeBase`; then `readDiff(mergeBaseOid, "refs/pull/N/head")` — both ids resolve today (§2) | reuse |
| `GET /pulls/{index}/files` (SPEC-0004) | same range, `ChangedFileList` | `readDiff` output (path/status/add/del/hunks); patch text rendered Worker-side | reuse |
| `GET /pulls/{index}/commits` (SPEC-0004) | `merge_base..refs/pull/N/head` | `mergeBase` + `listCommitsRange` (§4.1 — **new**) | new |
| `GET /compare/{basehead}` (SPEC-0004) | `base...head` three-dot (and `base..head` two-dot) | `mergeBase` + `listCommitsRange` + `readDiff(baseTree, headTree)` per the dots; divergence for the API's ahead/behind fields | reuse + new |
| `GET /git/commits/{sha}.{diffType}` (SPEC-0004) | commit vs first parent | `readDiff(sha)` default-parent behavior | exists |
| `GET /repos/…/commits` (SPEC-0004) | tip walk with filters | `listLog` | exists |
| Mergeability state machine (SPEC-0005 §2.4) | base vs head | `checkMergeability` (§4.3) | new |
| Divergence `commits_ahead/behind` (SPEC-0005 §3.2) | both directions | `countDivergence` (§4.1) | new |
| PR patch download (`.{diffType}=patch`, multi-commit) | per commit `format-patch` | `listCommitsRange` + per-commit `readDiff`; Worker renders mail text (oracle: `patchPage` byte shape) | reuse + render |
| Files-only listings at scale | tree diff without hunks | `readDiff` gains `opts?: { filesOnly?: boolean }` — skips blob inflation + line diff when only paths/status/oids are needed (`computeDiff`'s flatten comparison already computes them) | small option |
| `POST /merge-upstream` (SPEC-0004) | fork branch vs upstream branch | relay §5.4 into the fork onto a scratch ref `refs/cf/merge-<uuid>` (objects must exist before merging), `executeMerge`/FF, then `deleteApiRef` scratch — all §4/§5 primitives composed | composed |

One correction to note (§10): SPEC-0004 §2.4 lists `GET /pulls/{index}.{diffType}` and
`/files` as plain engine reads; they are *composed* reads (mergeability check first for
the merge-base, then the diff) — the API service module owns the composition.

## 7. Effort / risk per step

Steps are independently landable, each keeps `pnpm test` + engine e2e green, and each
is followed by `pnpm typecheck` (regenerates `dist-types/`). Landing order: M-F1 before
M-PR2/3; M-F3 (forks) independent of the merge steps and needed before SPEC-0005's
fork-PR routes.

| Step | Files (engine unless noted) | Size | Risk class | Guarding tests |
|---|---|---|---|---|
| M-G1. Graph primitives (§4.1) | new `src/merge/graph.ts`; `repo.ts` (four thin RPC wrappers) | ~300–400 LOC | **Low** — pure reads over proven walk machinery; the only subtlety is merge-base candidate domination and the exhaustion bit | merge-base fixtures incl. criss-cross + unrelated + exhaustion; divergence vs `git rev-list --left-right --count` oracle; read-only assertion (object count unchanged) |
| M-PR2. Tree merge + diff3 (§4.2) | new `src/merge/tree.ts`, `src/merge/diff3.ts` | ~400–550 LOC | **Medium-High** — the diff3 reconciliation is the riskiest code in this SPEC; mitigated by differential fixtures against `git merge-file` and `git merge-tree --write-tree` (tree + conflicted-file lists as oracles) | conflict-fixture matrix (§9); empty-tree constant assertion; `git fsck` clean after every object-store |
| M-PR3. Classification + execution + rebase + ref ops (§4.3–4.5, §4.8) | `src/merge/engine.ts`, `src/merge/rebase.ts`, `src/merge/patchid.ts`; `src/control-plane.ts` (+`checkMergeability`/`executeMerge`/`rebaseOnto`/`putRebaseObjects`/`deleteApiRef`); reuses `commit/serialize.ts`, `GitStore.put` | ~600–800 LOC | **Medium** — CAS choreography reuses proven machinery; risk is the extraRefUpdates all-or-nothing rule and style edge cases (FF refusal, squash parent count) | status-machine table tests (each row a fixture); read-only check assertion; CAS-conflict retry test; fsck + clone-after-merge roundtrip; rebase patch-id skip fixture vs `git rebase` oracle |
| M-PR4. Receive integration (§4.7) | `src/control-plane.ts` (`FinalizeReceiveInput.extraRefUpdates`); Worker receive pipeline passes + filters them | ~100–150 LOC | **Low-Medium** — additive optional field; the report-status filter is the one wire-visible invariant | push-with-open-PR e2e: branch + `refs/pull/N/head` move in one transaction; report-status shows ONLY client commands; concurrent push vs PR-sync CAS |
| M-F3. Fork model (§5) | `src/control-plane.ts` (+`listCatalogPage`/`beginForkImport`/`adoptForkPacks`/`finalizeForkImport`); `git/store.ts` (catalog/index paging reads); Worker fork service + queue consumer (SPEC-0003/0005 side) | ~400–500 LOC engine, ~300 Worker | **Medium** — the replication loop is new plumbing; idempotent re-run must be proven under crash injection | fork→clone→fsck byte-identical refs; crash-mid-replication re-run completes; push during import gated; parent delete with live fork; fork delete purge; fork→PR→merge e2e (§9) |

Estimated total scope: ~1.8–2.4 kLOC engine + ~300 LOC Worker, 3–4 milestones of
SPEC-0005's build order (before PR routes ship).

## 8. NOTICE discipline (`packages/git-engine/NOTICE.md`)

Per SPEC-0001 §8 / SPEC-0001a §7, every deviation lands as one line (date, file(s),
reason). Categories this SPEC generates, each of which **must** be recorded:

1. **New files** — `src/merge/graph.ts`, `src/merge/diff3.ts`, `src/merge/tree.ts`,
   `src/merge/rebase.ts`, `src/merge/patchid.ts` (+ `src/merge/types.ts` if the RPC
   types are split out of `control-plane.ts`): one line each, with the split-plane /
   PR-surface reason.
2. **Modified upstream files** — `repo.ts` (thin merge/divergence RPC wrappers),
   `git/store.ts` (catalog/index paging reads for §5.3): one line per file per logical
   change. **`git/protocol.ts` is deliberately untouched** — `isAncestor` stays the
   receive-path implementation (§4.1) and the zero-modification fact is itself worth a
   line when provenance is reviewed.
3. **New external provenance (first occurrence — extends the header's rules)** —
   gitorange @ `b3d5b08` (Apache-2.0): structural port of the three-way tree merge
   (§4.2), the rebase replay's retained parts (§4.5), and the patch-identity
   normalization (§3), with changes stated (Gitea-parity simplifications: no
   carry-over, no AI-resolution machinery; node-diff3 replaced by our Myers-based
   diff3). Apache-2.0 §4 obligations satisfied by: the NOTICE attribution line, the
   changes statement, and a reference to the upstream license in the engine's
   `LICENSE`-adjacent notices — recorded once here and cited by the per-file lines.
4. **Interface additions on exported classes** — `RepoCell` gains
   `mergeBase`/`listCommitsRange`/`countDivergence`/`checkMergeability`/
   `executeMerge`/`rebaseOnto`/`putRebaseObjects`/`deleteApiRef`/
   `listCatalogPage`/`beginForkImport`/`adoptForkPacks`/`finalizeForkImport`;
   `FinalizeReceiveInput` gains the optional `extraRefUpdates`: note that `pnpm
   typecheck` regeneration is part of each landing (generated `dist-types/` boundary).
5. **Renames / constant changes** — none (no key, table, or binding changes; the R2
   layout is untouched by this SPEC).

Not NOTICE-eligible: the `filesOnly` option on `readDiff` rides the `repo.ts` line from
category 2; pure additions inside new files are not per-hunk recorded.

## 9. Test checkpoints

Fixtures committed under the engine e2e (`packages/git-engine/e2e/`), oracle binaries
pinned in CI (`git` on the runner; every oracle assertion is a golden, not a live
comparison at runtime).

Graph (M-G1 gate):

- merge-base fixtures: linear, diverged, **criss-cross** (two merge bases — the
  domination rule must pick deterministically; document the pick in the fixture
  README), merge-into-side-branch (the g1t#365 class), unrelated histories (`null`,
  `exhausted:false`), exhaustion (synthetic 50k+ chain — `exhausted:true`, no answer
  claimed).
- `countDivergence` vs `git rev-list --left-right --count` on the same fixtures.
- Read-only assertion: `store.objectCount()` + `refs()` snapshot identical before/after
  every check call (§4.6).

Tree merge + classification (M-PR2/3 gate):

- Conflict-fixture matrix, each with the `git merge-tree --write-tree` oracle (tree oid
  + conflicted paths must match exactly): both-modified same hunk; non-overlapping
  edits both sides (clean diff3 merge); add/add identical (clean) vs add/add differing
  (conflict); delete/edit; mode vs content; file/dir clash; binary both-modified;
  symlink both-modified; gitlink both-changed; over-cap file (1 MiB gate ⇒ conflict
  `too_large`); changed-path cap ⇒ `overflow`.
- Emptiness: PR whose changes are all applied upstream ⇒ `empty` via tree-oid equality
  (assert NO blob reads — instrument the store or assert on timing-independent row
  counts).
- Short-circuits: FF shape (base is merge-base) returns head's tree without a walk;
  `ancestor` detected before any merge work.
- `git fsck` clean after every `executeMerge`/`rebaseOnto` + `putRebaseObjects`; stock
  `git clone` of a merged repo shows exactly upstream's history for `merge` style.
- CAS: concurrent `executeMerge` vs push — exactly one lands, loser gets
  `ref_conflict` + live tip; `extraRefUpdates` conflict fails the whole transaction
  (base unmoved — assert).
- Rebase: patch-id skip (same change landed upstream ⇒ commit dropped, `skipped`
  counts), author/date preservation, conflict stop reports the original oid; oracle:
  `git rebase` on the fixture repo produces the same final tree.

Receive integration (M-PR4 gate):

- Push to a branch with an open PR: branch ref + `refs/pull/N/head` + `refs_version`
  bump in one transaction; report-status bytes contain ONLY the client's commands
  (golden fixture); force-push to the branch moves the PR ref with `is_force_push`
  bookkeeping flowing to the Worker (SPEC-0005 §4.3).

Fork (M-F3 gate):

- Fork of a fixture repo (mixed r2/sqlite packs) → `git fsck` clean, refs byte-identical
  to parent, clone serves; fork→push→create PR→relay lands `refs/pull/N/head` →
  merge (`merge` style) → base advanced, fsck clean — the full fork→PR→merge e2e.
- Crash injection: kill the consumer between R2 copy and adopt, between adopt pages,
  before finalize — re-run completes; no partial catalog visible (`meta.importing`
  gate holds; pushes during import are refused with the busy variant).
- Parent delete with live fork: fork keeps serving (fsck clean post-delete).
- Fork delete: prefix purge complete, parent untouched.

SPEC-0005-side integration (owned there, listed for the joint gate): the PR-flow e2e
(SPEC-0005 §5.2) exercises M-PR2–M-F3 end-to-end through the API.

## 10. Corrections surfaced by this amendment

To be folded into the respective SPECs when this amendment is accepted:

1. **SPEC-0001 §1 scope** — add: merge/fork primitives are engine scope (this
   amendment); §5 gains a note that `executeMerge` is a third write entry point
   (alongside receive and SPEC-0001a §4) storing derived loose objects via `GitStore.put`
   inside the landing transaction's build phase, under the same CAS/`refs_version`
   machinery; M3 compaction folds merge/rebase loose objects in like API-written ones.
2. **SPEC-0001 §8 provenance rule** — generalize "gitoxide snippets (MIT OR Apache-2.0)
   allowed with attribution" to "Apache-2.0 sources (gitoxide, gitorange) allowed with
   attribution + license reference + changes statement" (§8 category 3 is the first
   exercise of it).
3. **SPEC-0001a §3 Step 1** — `FinalizeReceiveInput` gains the optional
   `extraRefUpdates` field (§4.7); `results` remains index-aligned with the client's
   `commands` only. Additive, no cutover.
4. **SPEC-0001a §4** — `commitApiChange` cannot delete refs; `deleteApiRef` (§4.8) is
   the CAS-delete counterpart. Record so branch/PR ref deletes do not get routed
   through receive.
5. **SPEC-0004 §6 OQ#4 (fork object sharing)** — **resolved**: full copy at fork time,
   queue-driven (§5.2/§5.3); no cross-repo pack sharing; SPEC-0003 §2.5.5 unchanged.
6. **SPEC-0005 §3.4** — the mergeability check is an engine-resident read-only RPC
   (`checkMergeability`) driven by the Queue worker, not "implemented in the Worker
   from engine object reads" (§4 placement decision); the fork-PR `copyObjects` op is
   replaced by the §5.4 relay over the existing protocol paths (no reachable-set pack
   writer, resolving OQ#2's cost question); merge execution's styles map onto
   `executeMerge` + `rebaseOnto` with the §4.4 choreography table.
7. **SPEC-0005 §4.4 (head branch deleted while PR open)** — the engine-facing half is
   guaranteed here: `refs/pull/N/head` and its objects are base-local (§5.5), so the
   PR stays mergeable after a fork-side branch delete; only GC of a *merged-and-cleaned*
   PR can void it, which is M3 compaction policy (refs are reachability roots while the
   ref exists — no new mechanism).
8. **SPEC-0004 §2.4** — `pulls/{index}.{diffType}` and `/files` are composed reads
   (mergeability check supplies the merge-base; §6); the API service module owns the
   composition, the engine never sees PR rows.
