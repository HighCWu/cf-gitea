import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { td, isOid } from "./git/util";
import { GitStore } from "./git/store";
import { OidSet } from "./git/oidset";
import { gunzipLimited } from "./git/zlib";
import { cloneCacheKey, repoPrefix } from "./git/r2keys";
import {
  advertisement,
  uploadPack,
  latestCommitTime,
  wantsAreAllTips,
  openPlanLease,
  releasePlanLease,
  serveReadGate,
  Service,
  PackCache,
} from "./git/protocol";
import type { ReadGate } from "./git/packstore";
import {
  beginReceive,
  beginForkImport,
  adoptForkPacks,
  finalizeForkImport,
  listCatalogPage,
  commitApiChange,
  checkMergeability,
  countDivergence,
  deleteApiRef,
  destroy,
  executeMerge,
  finalizeReceive,
  listCommitsRange,
  listPackCatalog,
  lookupObjects,
  markDeleted,
  mergeBase,
  putApiObjects,
  putIndexRows,
  putRebaseObjects,
  rebaseOnto,
  releaseReceive,
  setHead,
  sweepExpiredLeases,
  type ApiObject,
  type AdoptForkPacksResult,
  type BeginForkImportResult,
  type BeginReceiveInput,
  type BeginReceiveResult,
  type CatalogPage,
  type CheckMergeabilityInput,
  type CheckMergeabilityResult,
  type CommitApiChangeInput,
  type CommitApiChangeResult,
  type DeleteApiRefInput,
  type DeleteApiRefResult,
  type DestroyResult,
  type ExecuteMergeInput,
  type ExecuteMergeResult,
  type FinalizeForkImportInput,
  type FinalizeForkImportResult,
  type FinalizeReceiveInput,
  type FinalizeReceiveResult,
  type IndexRow,
  type LeaseHost,
  type ListPackCatalogInput,
  type ListPackCatalogResult,
  type LookupObjectResult,
  type MarkDeletedResult,
  type PutApiObjectsResult,
  type PutRebaseObjectsResult,
  type RebaseOntoInput,
  type RebaseOutcome,
  type ReleaseReceiveInput,
  type ReleaseReceiveResult,
  type SetHeadResult,
} from "./control-plane";
import {
  Commit,
  ObjType,
  Person,
  parseCommit,
  parseTag,
  parseTree,
  isTreeMode,
  isGitlinkMode,
  modeString,
  TreeEntry,
} from "./git/objects";
import { diffLines, toHunks, isBinary, Hunk, DiffOp } from "./git/diff";
import { blame, BlameHistoryEntry } from "./git/blame";
import { tarGz, zip, SnapshotFile } from "./git/snapshot";
import {
  planFetch,
  planFetchInsideTransaction,
  releaseReadLease,
  renewAndAuthorizeRead,
  type ByteRange,
  type PlanCloneStreamResult,
  type ReleaseReadResult,
  type RenewReadResult,
} from "./read-leases";
import {
  COMPACTION_ACTIVE_PACK_THRESHOLD,
  COMPACTION_RETRY_MS,
  runCompaction,
  type CompactionHost,
  type CompactionResult,
} from "./compaction";
import { GC_RETRY_MS, runGcPass, type GcHost, type GcPassResult } from "./gc";
import { esc, repoUrl, repoBase, age, fmtDate, fmtDate2822, layout, htmlResponse, errorPage, LayoutOpts } from "./ui/html";
import { renderMarkdown } from "./ui/markdown";
import { highlightLines } from "./ui/highlight";

const LOG_PAGE = 50;
const MAX_DIFF_FILES = 100;
const MAX_DIFF_BLOB = 512 * 1024;
const MAX_LOG_SCAN = 5000;
/** a path-filtered log rejects most commits, so bound its walk tighter */
const PATH_LOG_SCAN = 2000;
const MAX_STATS_SCAN = 2000;
/** whole-file blame is memory-bound: cap the tip blob and the history bytes */
const MAX_BLAME_BYTES = 1024 * 1024;
const MAX_BLAME_HISTORY_BYTES = 16 * 1024 * 1024;
// full streaming is a separate follow-up; until then this must fit the isolate
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
/** the DO SQLite storage ceiling gc must not cross while duplicating objects */
const DO_STORAGE_CAP = 10 * 1024 * 1024 * 1024;
/** an upload-pack request is wants/haves/caps only — a few hundred KB at most */
const MAX_UPLOAD_PACK_BYTES = 16 * 1024 * 1024;
// like cgit's about-file: a dedicated about page wins over the README
const README_NAMES = [
  "about.md",
  "about.markdown",
  "about",
  "readme.md",
  "readme.markdown",
  "readme",
  "readme.txt",
  "readme.rst",
];

interface LogEntry {
  oid: string;
  commit: Commit;
}

interface LogFilter {
  path?: string[];
  qt?: string;
  q?: string;
}

// The shapes returned by the cell's typed content surface (see the methods
// below planCloneStream).

export interface RefsResult {
  head: string | null;
  refs: { name: string; target: string; peeled?: string }[];
}

export interface CommitJson {
  oid: string;
  tree: string;
  parents: string[];
  author: Person;
  committer: Person;
  subject: string;
  message: string;
}

export interface LogResult {
  commits: CommitJson[];
  more: boolean;
}

export interface TreeEntryJson {
  name: string;
  mode: string;
  type: "tree" | "blob" | "commit";
  oid: string;
  size?: number;
}

export interface TreeResult {
  oid: string;
  entries: TreeEntryJson[];
}

export interface BlobResult {
  oid: string;
  mode: string;
  data: Uint8Array;
}

export interface DiffFileJson {
  path: string;
  old: { oid: string; mode: string } | null;
  new: { oid: string; mode: string } | null;
  kind: "text" | "binary" | "toolarge";
  add: number;
  del: number;
  hunks: Hunk[];
}

export interface DiffResult {
  /** null for a root commit */
  old: string | null;
  new: string;
  files: DiffFileJson[];
  truncated: boolean;
}

interface FileDiff {
  path: string;
  o: { oid: string; mode: string } | null;
  n: { oid: string; mode: string } | null;
  kind: "text" | "binary" | "toolarge";
  ops: DiffOp[] | null;
  hunks: Hunk[];
  add: number;
  del: number;
}

export class RepoCell extends DurableObject<Env> {
  store: GitStore;
  /** concurrent clone walks contend on one event loop; bound them */
  private activeUploads = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // SPEC-0011 §8 (M3.0): the GitStore constructor runs the forward-only
    // schema migration journal BEFORE any store use — each upgrade txn is
    // atomic under storage.transactionSync. Unrecognized pre-baseline states
    // open SEALED (data access fails closed; the DELETE request path wipes
    // and unseals) — see src/git/migrations.ts for the state model.
    this.store = new GitStore(ctx.storage.sql, { tx: (fn) => ctx.storage.transactionSync(fn) });
  }

  /**
   * Bind the R2 pack backend (REPO_PACKS: receive staging, stored packs, and
   * the clone cache — one bucket, keys from src/git/r2keys.ts) for this repo.
   * The DO is per-repo, so the name is stable; persist it (and the storage
   * key, which equals the name until SPEC-0003 supplies the D1 r_<id>) once
   * so request-less paths — lease RPCs, alarm-driven sweeps, gc — can rebind
   * and rebuild keys without a request.
   */
  private bindR2(repo: string): void {
    this.store.setR2(this.env.REPO_PACKS, this.storageKey(repo));
    if (this.store.getMeta("repo") !== repo) this.store.setMeta("repo", repo);
  }

  /** The persisted storage key (meta.storage_key), falling back to the request
   * name — the same resolution control-plane.ts's beginReceive performs. */
  private storageKey(requestName?: string): string {
    return this.store.getMeta("storage_key") ?? this.store.getMeta("repo") ?? requestName ?? "repo";
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const repo = req.headers.get("x-repo") ?? "repo";
    const host = req.headers.get("x-host") ?? url.host;
    const proto = req.headers.get("x-proto") ?? "https";
    const path = url.pathname;
    // SPEC-0011 §8 (M3.0): a SEALED cell (unrecognized pre-baseline schema,
    // refused at construction) serves exactly ONE request — the explicit
    // DELETE, whose wipe unseals and rebuilds the cell — and fails closed
    // with the refusal reason for everything else. Nothing is ever served
    // from an unrecognized schema, and the cell is never undeletable.
    if (this.store.schemaState.refused !== null) {
      if (req.method === "DELETE" && (path === "/" || path === "")) {
        console.error(
          `[schema] LOUD: DELETE on sealed repo cell "${repo}" — explicitly wiping an ` +
            `unrecognized-schema state (${this.store.schemaState.refused})`
        );
      } else {
        return new Response(
          `error: [schema sealed] ${this.store.schemaState.refused}\n` +
            `Recovery: DELETE this repo, or open it with allowUnknownSchemaReset.\n`,
          { status: 500 }
        );
      }
    } else {
      this.bindR2(repo);
    }

    try {
      if (path === "/info/refs" && req.method === "GET") {
        const service = url.searchParams.get("service");
        if (service !== "git-upload-pack" && service !== "git-receive-pack") {
          return new Response("smart HTTP only\n", { status: 400 });
        }
        const v2 = req.headers.get("git-protocol")?.split(":").some((value) => value.trim() === "version=2");
        return new Response(advertisement(this.store, service as Service, v2) as unknown as BodyInit, {
          headers: {
            "content-type": `application/x-${service}-advertisement`,
            "cache-control": "no-cache",
          },
        });
      }
      if (path === "/git-upload-pack" && req.method === "POST") {
        if (overDeclaredLength(req, MAX_UPLOAD_PACK_BYTES)) return tooLargeResponse(MAX_UPLOAD_PACK_BYTES);
        if (this.activeUploads >= 4) {
          return new Response("busy: too many concurrent fetches, retry shortly\n", {
            status: 503,
            headers: { "retry-after": "15" },
          });
        }
        // the slot must span the whole response stream, not just uploadPack's
        // return: decrementing when the ReadableStream is handed back — before
        // a byte is produced — disables admission control and lets celld
        // idle-evict the cell mid-clone. release() fires exactly once, from the
        // stream's close/cancel or a non-stream early return.
        this.activeUploads++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          this.activeUploads--;
        };
        try {
          return await uploadPack(this.store, await this.readBody(req), release, this.packCacheFor());
        } catch (err) {
          release();
          // an over-inflating body is the client's fault, not a server error
          if (err instanceof Error && err.message.includes("exceeds maximum size")) {
            return tooLargeResponse(MAX_UPLOAD_PACK_BYTES);
          }
          throw err;
        }
      }
      // POST /git-receive-pack no longer arrives here: since SPEC-0001a §3
      // Step 1 the Worker-side data plane (mod.ts) parses the command section,
      // stages the pack into R2, and drives the beginReceive/finalizeReceive/
      // releaseReceive lease RPCs below. The DO never sees pack bytes.
      if (path === "/config" && req.method === "PUT") {
        return this.handleConfig(await req.text());
      }
      if (path === "/description" && req.method === "PUT") {
        return this.handleConfig(JSON.stringify({ description: (await req.text()).trim() }));
      }
      if ((path === "/" || path === "") && req.method === "DELETE") {
        // the whole wipe is ONE transactionSync: drop + re-create the schema
        // atomically, so a concurrent request can never land between the table
        // drop and the re-init (SPEC-0001a §3 Step 4 — Rule 3: the last
        // blockConcurrencyWhile on this path is gone)
        this.ctx.storage.transactionSync(() => {
          this.store.wipe();
        });
        try {
          await this.ctx.storage.deleteAlarm();
        } catch {
          // best effort: an un-cleared alarm fires on an empty schema and no-ops
        }
        // this instance stays resident: re-persist the storage key so later
        // requests — including a re-creating push — find their bindings
        this.bindR2(repo);
        // the R2 subtree (packs, staging, clone cache — one prefix under the
        // new key layout) outlives the SQLite wipe; purge it so a re-created
        // repo never inherits stale bytes (its versioned keys would differ
        // anyway)
        await this.purgePackCache();
        return new Response("deleted\n");
      }
      if (path === "/gc" && req.method === "POST") {
        return Response.json(await this.gc());
      }

      if (req.method !== "GET") return new Response("method not allowed\n", { status: 405 });
      return await this.ui(repo, host, proto, path, url.searchParams);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`error: ${msg}\n`, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    // sealed cells (SPEC-0011 §8) hold no openable schema — sweeps would only
    // throw "no such table"; the cell is deleted or flagged-reset instead
    if (this.store.schemaState.refused !== null) return;
    // lease-expiry sweep first: reclaim crashed pushes' staging objects and
    // free the lease slot. Cheap (a SELECT over an almost-always-empty table)
    // and safe during clones — it never touches pack data.
    try {
      await sweepExpiredLeases(this.leaseHost());
    } catch (err) {
      console.log(`lease sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // M2 gc consumer: migrate reachable objects to loose + drop the packs.
    if (this.store.getMeta("gc-pending") === "1") {
      // GC calls packs.reset(): running it while a clone is streaming or a push
      // is ingesting corrupts both. Defer past any in-flight upload (leave
      // gc-pending set so the re-armed alarm retries) rather than run now.
      if (this.activeUploads > 0) {
        try {
          await this.ctx.storage.setAlarm(Date.now() + 30 * 1000);
        } catch {
          // alarm store may be busy under a burst; the next push re-arms it
        }
        return;
      }
      // clear first: at-most-once, so a throwing sweep can't trigger a retry storm
      this.store.setMeta("gc-pending", "0");
      // no request here to carry x-repo: rebind R2 from the persisted repo name
      // (meta.storage_key backfills from it) so the sweep can read R2-backed
      // objects and drop their raw objects
      this.bindR2(this.store.getMeta("repo") ?? "repo");
      try {
        await this.gc();
      } catch (err) {
        console.log("gc failed", String(err));
      }
    }
    // M3.3 compaction consumer (SPEC-0011 §5.1) — the standing
    // "crons enqueue, consumers work" pattern with NO Worker-cron entry:
    // finalizeReceive stamps `compaction_wanted_at` (the enqueue) and this
    // alarm is the DO consumer that works, gated by the pack-count threshold.
    // Runs AFTER the gc branch (a gc round resets the pack tables wholesale;
    // compacting first would be wasted work the gc un-does).
    await this.maybeCompactFromAlarm();
    // M3.4 GC consumer (SPEC-0011 §2) — compaction's stamp pattern one step
    // downstream: `gc_wanted_at` is stamped by every committed ref change
    // (which stales the clone-cache entry it served) and by every compaction
    // round that landed RETIRED inputs; the pass collects what read leases
    // have drained and re-arms (the periodic sweep) until the catalog
    // converges. Ordered after the sweep + compaction so expired read leases
    // are reaped before the pass consults them.
    await this.maybeGcFromAlarm();
  }

  /** The alarm-side compaction trigger (SPEC-0011 §5.1): threshold-gated,
   * deferred rounds leave the stamp and re-arm; convergence across the bound
   * window happens one alarm per round. */
  private async maybeCompactFromAlarm(): Promise<void> {
    if (!this.store.getMeta("compaction_wanted_at")) return;
    const rearm = async (ms: number): Promise<void> => {
      try {
        await this.ctx.storage.setAlarm(Date.now() + ms);
      } catch {
        // alarm store busy: the next push's finalize re-arms instead
      }
    };
    if (this.store.packs.activePackCount() <= COMPACTION_ACTIVE_PACK_THRESHOLD) {
      // converged (or the push that stamped never crossed the threshold)
      this.store.setMeta("compaction_wanted_at", "");
      return;
    }
    if (this.activeUploads > 0) {
      await rearm(COMPACTION_RETRY_MS);
      return;
    }
    this.bindR2(this.store.getMeta("repo") ?? "repo");
    let result: CompactionResult;
    try {
      result = await runCompaction(this.compactionHost());
    } catch (err) {
      console.log(`compaction failed: ${err instanceof Error ? err.message : String(err)}`);
      await rearm(COMPACTION_RETRY_MS);
      return;
    }
    if (result.tag === "compacted") {
      // §5.2 step 5 / M3.4: the round landed RETIRED inputs — GC reclaims
      // them once leases drain (the stamp this alarm's GC consumer reads)
      this.store.setMeta("gc_wanted_at", String(Date.now()));
      if (this.store.packs.activePackCount() > COMPACTION_ACTIVE_PACK_THRESHOLD) {
        // still above the trigger: keep the stamp, converge next round
        this.store.setMeta("compaction_wanted_at", String(Date.now()));
        await rearm(COMPACTION_RETRY_MS);
      } else {
        this.store.setMeta("compaction_wanted_at", "");
      }
    } else if (result.tag === "skipped") {
      this.store.setMeta("compaction_wanted_at", "");
    } else {
      // deferred (live receive/compaction lease, lost lease): retry later
      await rearm(COMPACTION_RETRY_MS);
    }
  }

  /** The compaction host over this cell's DO storage + R2 binding. */
  private compactionHost(): CompactionHost {
    return {
      store: this.store,
      storage: this.ctx.storage,
      putPackObject: async (r2Key, data) => {
        const bucket = this.env.REPO_PACKS;
        if (!bucket) throw new Error(`compaction: REPO_PACKS unbound, cannot write ${r2Key}`);
        await bucket.put(r2Key, data);
      },
      deletePackObjects: async (keys) => {
        const bucket = this.env.REPO_PACKS;
        if (!bucket) return;
        try {
          await bucket.delete(keys);
        } catch (err) {
          // best effort: an unswept orphan is retried by the next expiry sweep
          console.log(`[r2 ${this.store.getMeta("repo") ?? ""}] compaction sweep delete failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };
  }

  /**
   * Manual compaction entry point (SPEC-0011 §5.1, M3.3) — the tests/benches
   * (and admin) surface. `force` bypasses the pack-count threshold; every
   * other gate (receive-lease exclusion, the compaction lease, the bounded
   * window) still applies. Production triggers ride the alarm instead (see
   * maybeCompactFromAlarm). Sweeps expired leases first so a crashed round's
   * orphan converges before this one starts.
   */
  async compactNow(opts: { force?: boolean } = {}): Promise<CompactionResult> {
    if (this.store.schemaState.refused !== null) return { tag: "skipped", reason: "sealed", activePacks: 0 };
    this.rpcBind();
    if (!this.env.REPO_PACKS) return { tag: "skipped", reason: "no_r2_backend", activePacks: this.store.packs.activePackCount() };
    try {
      await sweepExpiredLeases(this.leaseHost());
    } catch {
      // a failed sweep must not block the manual round; the next one converges
    }
    const result = await runCompaction(this.compactionHost(), { force: opts.force === true });
    if (result.tag === "compacted") {
      // §5.2 step 5 / M3.4: the round landed RETIRED inputs — stamp + arm the
      // GC consumer (the alarm pass collects once leases drain)
      this.stampGcWanted();
    }
    return result;
  }

  // ---- M3.4 GC (SPEC-0011 §2): RETIRED→RECLAIMABLE→DELETED -----------------
  // The alarm consumer (maybeGcFromAlarm) + the manual RPC (gcNow). The
  // transitions and their guards live in src/gc.ts; this is the cadence:
  // compaction's stamp pattern — stamp `gc_wanted_at` when work is created
  // (a compaction round's RETIRED inputs; every committed ref change's
  // staled clone-cache entry — see finalizeReceive), run a pass from the
  // alarm, re-arm while the pass reports pending work (lease drain, delete
  // retry), consume the stamp at convergence.

  /** Stamp + arm the GC consumer (post-compaction; the pass runs on the next
   * alarm — the re-arm cadence keeps it converging while work pends). */
  private stampGcWanted(): void {
    this.store.setMeta("gc_wanted_at", String(Date.now()));
    void this.ctx.storage.setAlarm(Date.now() + GC_RETRY_MS).catch(() => {
      // alarm store busy under a burst: the next push/compaction re-arms
    });
  }

  /** The alarm-side GC trigger: stamp-gated, re-armed while pending. */
  private async maybeGcFromAlarm(): Promise<void> {
    if (!this.store.getMeta("gc_wanted_at")) return;
    const rearm = async (ms: number): Promise<void> => {
      try {
        await this.ctx.storage.setAlarm(Date.now() + ms);
      } catch {
        // alarm store busy: the next push's finalize re-arms instead
      }
    };
    if (!this.env.REPO_PACKS) {
      // no R2 backend: nothing is reclaimable (a RECLAIMABLE→DELETED row
      // removal requires the delete ack) — drop the stamp rather than spin
      this.store.setMeta("gc_wanted_at", "");
      return;
    }
    this.bindR2(this.store.getMeta("repo") ?? "repo");
    let result: GcPassResult;
    try {
      result = await runGcPass(this.gcHost());
    } catch (err) {
      console.log(`gc pass failed: ${err instanceof Error ? err.message : String(err)}`);
      await rearm(GC_RETRY_MS);
      return;
    }
    if (result.tag !== "collected") return;
    if (result.pending) {
      // lease-drain / delete-retry pending: keep the stamp, sweep again on
      // the retry cadence (the periodic sweep)
      await rearm(GC_RETRY_MS);
    } else {
      this.store.setMeta("gc_wanted_at", "");
    }
  }

  /** The GC host over this cell's DO storage + R2 binding. Unlike the
   * compaction host's best-effort deletes, GC's delete adapter THROWS when
   * unbound: the RECLAIMABLE→DELETED row removal requires the delete to have
   * actually happened — a silent no-op would strand the bytes. */
  private gcHost(): GcHost {
    return {
      store: this.store,
      storage: this.ctx.storage,
      deletePackObjects: async (keys) => {
        const bucket = this.env.REPO_PACKS;
        if (!bucket) throw new Error(`gc: REPO_PACKS unbound, cannot delete ${keys[0] ?? ""}`);
        await bucket.delete(keys);
      },
      listPackObjects: async (prefix) => {
        const bucket = this.env.REPO_PACKS;
        if (!bucket) return [];
        const keys: string[] = [];
        for (let cursor: string | undefined; ; ) {
          const listed = await bucket.list({ prefix, cursor });
          keys.push(...listed.objects.map((o) => o.key));
          if (!listed.truncated) break;
          cursor = listed.cursor;
        }
        return keys;
      },
    };
  }

  /**
   * Manual GC entry point (SPEC-0011 §2, M3.4) — the tests/benches (and
   * admin) surface, mirroring compactNow: sweeps expired leases first (a
   * crashed holder's read lease stops blocking), then runs one pass. The
   * production trigger rides the alarm (maybeGcFromAlarm).
   */
  async gcNow(): Promise<GcPassResult> {
    if (this.store.schemaState.refused !== null) return { tag: "skipped", reason: "sealed" };
    this.rpcBind();
    if (!this.env.REPO_PACKS) return { tag: "skipped", reason: "no_r2_backend" };
    try {
      await sweepExpiredLeases(this.leaseHost());
    } catch {
      // a failed sweep must not block the manual pass; the next one converges
    }
    return runGcPass(this.gcHost());
  }

  /**
   * Run GC under blockConcurrencyWhile, so packs.reset() can never land
   * mid-clone. (It used to also chain on the pushes' receiveChain; since
   * SPEC-0001a §3 Step 1 pushes enter via finalizeReceive holding a receive
   * lease, and GC defers to any active lease instead.)
   */
  private async gc(): Promise<{ removed: number; kept: number; skipped?: boolean }> {
    if (this.store.hasActiveReceiveLease(Date.now())) {
      // a push finalize may be mid-ingest; never reset packs under it
      return { removed: 0, kept: 0, skipped: true };
    }
    return this.ctx.blockConcurrencyWhile(async () => this.runGc());
  }

  private async handleConfig(body: string): Promise<Response> {
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(body);
    } catch {
      return new Response("invalid JSON\n", { status: 400 });
    }
    if (typeof cfg.description === "string") this.store.setMeta("description", cfg.description.slice(0, 200));
    if (typeof cfg.owner === "string") this.store.setMeta("owner", cfg.owner.slice(0, 100));
    if (typeof cfg.section === "string") this.store.setMeta("section", cfg.section.slice(0, 100));
    if (typeof cfg.private === "boolean") this.store.setMeta("private", cfg.private ? "1" : "0");
    // backfill the registry sort key: re-PUTing config recomputes idle from the
    // real latest-commit date, so a mirrored repo's index age stops tracking
    // its push time. The Worker reads this and threads it into the registry.
    // The tip peels are served content reads: they run under the content lease.
    const commitTime = await this.withContentLease((gate) => latestCommitTime(this.store, gate));
    return Response.json(
      {
        description: this.store.getMeta("description") ?? "",
        owner: this.store.getMeta("owner") ?? "",
        section: this.store.getMeta("section") ?? "",
        private: this.store.getMeta("private") === "1",
      },
      { headers: { "x-commit-time": String(commitTime) } }
    );
  }

  /**
   * Delete loose objects unreachable from any ref. Objects inside stored
   * packs are kept (deleting mid-pack is impossible without a repack);
   * huge repos skip the sweep entirely — the walk isn't worth it.
   *
   * Its object reads are deliberately NOT content-lease-gated (SPEC-0011 §3
   * posture survey, the only ungated serve-adjacent reads in this file): the
   * caller runs the whole migration under `blockConcurrencyWhile`, so nothing
   * — GC, compaction, a content read — interleaves with it, and it defers to
   * in-flight uploads instead of racing them. There is no concurrent
   * transition to be lease-protected against.
   */
  private async runGc(): Promise<{ removed: number; kept: number; skipped?: boolean }> {
    if (this.store.objectCount() > 300_000) {
      return { removed: 0, kept: this.store.objectCount(), skipped: true };
    }
    const reachable = new OidSet(Math.max(this.store.objectCount(), 4096));
    const stack: string[] = this.store.refs().map((r) => r.oid);
    const head = this.store.resolveHead();
    if (head) stack.push(head);
    while (stack.length) {
      const oid = stack.pop()!;
      if (!reachable.addHex(oid)) continue;
      const meta = this.store.typeAndSize(oid);
      if (!meta) continue;
      if (meta.type === "blob") continue; // leaf: never inflate blob content here
      const obj = await this.store.get(oid);
      if (!obj) continue;
      if (obj.type === "commit") {
        const c = parseCommit(obj.data);
        stack.push(c.tree, ...c.parents);
      } else if (obj.type === "tag") {
        const t = parseTag(obj.data);
        if (t.object) stack.push(t.object);
      } else if (obj.type === "tree") {
        for (const e of parseTree(obj.data)) {
          if (!isGitlinkMode(e.mode)) stack.push(e.oid);
        }
      }
    }
    // base_oid is a second reference edge: thin-pack deltas point at bases
    // that are frequently unreachable from any ref. Added after the graph walk
    // so a base that is itself a reachable tree keeps its own children.
    for (const b of this.store.packs.baseOids()) reachable.addHex(b);

    const packCount = this.store.packs.countObjects();
    // migration duplicates every reachable pack object into loose storage
    // before the packs are dropped: guard against crossing the 10GB DO ceiling
    // mid-rewrite (which would brick the repo) by leaving the packs intact when
    // there is no headroom for the copy.
    const noHeadroom =
      packCount > 0 && this.store.dbSize() + this.store.packs.totalPackBytes() > DO_STORAGE_CAP;
    let removed = 0;
    if (packCount > 0 && !noHeadroom) {
      // migrate reachable pack objects to loose FIRST, then reset packs, so a
      // base or reachable object stranded inside a pack survives the drop
      let migrated = 0;
      for (let i = 0; i < reachable.size; i++) {
        const oid = reachable.atHex(i);
        if (this.store.packs.lookup(oid)) {
          const obj = await this.store.get(oid);
          if (obj) {
            this.store.put(oid, obj.type, obj.data);
            migrated++;
          }
        }
      }
      removed += packCount - migrated;
      // capture the R2-backed pack keys before the index is dropped, then
      // delete their raw objects after reset so no orphaned bytes linger in R2
      const r2keys = this.store.packs.r2PackKeys();
      this.store.packs.reset();
      await this.store.packs.deleteR2Packs(r2keys);
    }
    // sweep loose objects (including anything just migrated) unreachable now
    for (const oid of this.store.allOids()) {
      if (!reachable.hasHex(oid)) {
        this.store.deleteObject(oid);
        removed++;
      }
    }
    return noHeadroom ? { removed, kept: reachable.size, skipped: true } : { removed, kept: reachable.size };
  }

  /**
   * The Worker R2 fast path's plan+lease RPC (SPEC-0011 §3.1/§4.2, M3.1):
   * the exact-full-clone probe (`wants` exactly the current ref tips) and the
   * read lease over the versioned clone-cache pack register in ONE
   * transaction — the probe's catalog read (refs state) and the lease INSERT
   * are atomic, so a GC/compaction transition cannot land between "decide the
   * key" and "protect the stream". The lease covers the ENTIRE stream
   * duration (§4.2): the Worker renews it inline in the re-framing loop and
   * releases it when the last R2 read completed. A miss (any other
   * negotiation shape) takes no lease — the DO serve path plans its own.
   *
   * Replaces the pre-M3.1 `currentPackKey` bare probe: same hit predicate
   * (wantsAreAllTips, strict set equality against ALL refs), plus the atomic
   * lease registration.
   *
   * `repo` is advisory since the Step 3 key layout: the key's namespace comes
   * from the persisted storage key (meta.storage_key), not the request name.
   */
  async planCloneStream(repo: string, wants: string[]): Promise<PlanCloneStreamResult> {
    this.rpcBind();
    const storageKey = this.storageKey(repo);
    let result: PlanCloneStreamResult = { tag: "miss" };
    // ONE transaction: the ref-state read (the probe) + the lease insert.
    // planFetchInsideTransaction: we are ALREADY inside store.tx — the DO's
    // transactionSync must never nest.
    this.store.tx(() => {
      if (!wantsAreAllTips(this.store, wants)) return;
      const key = cloneCacheKey(storageKey, this.store.reachableVersion());
      const plan = planFetchInsideTransaction(this.store, {
        generation: this.store.reachableVersion(),
        packKeys: [key],
        cache: true, // clone-cache keys have no pack_catalog row (§4.2)
      });
      if (plan.tag !== "leased") return;
      result = { tag: "leased", key, planId: plan.planId, expiresAt: plan.expiresAt };
    });
    return result;
  }

  /**
   * Inline read-lease renewal + per-segment authorization (SPEC-0011 §3.3):
   * the Worker awaits this before every R2 GET segment of a leased stream.
   * Rejection (expired lease, pack no longer readable — RECLAIMABLE is
   * irreversible) is the terminate-and-retry posture; the Worker errors the
   * stream, and git clients re-fetch. See src/read-leases.ts.
   */
  async renewAndAuthorizeRead(
    planId: string,
    packKey: string | null,
    byteRange?: ByteRange | null
  ): Promise<RenewReadResult> {
    this.rpcBind();
    return renewAndAuthorizeRead(this.store, planId, packKey, byteRange ?? null);
  }

  /**
   * Release the read lease (SPEC-0011 §3.4): called when the last dependent
   * R2 read completed — after the fast path's stream end or a
   * terminate/cancel — NOT at the HTTP response lifetime. Idempotent.
   */
  async releaseReadLease(planId: string): Promise<ReleaseReadResult> {
    this.rpcBind();
    return releaseReadLease(this.store, planId);
  }

  // ---- receive control plane (SPEC-0001a §3 Steps 1-2) ---------------------
  // Public lease/index RPCs, callable as Workers RPC by the Worker-side data
  // plane (mod.ts receive flow). The implementations live in control-plane.ts;
  // the DO contributes storage and the R2 delete adapter. Tagged unions only —
  // application outcomes never throw across this boundary (lookupObjects'
  // lost-lease case is the one deliberate exception: the push is dead
  // regardless, so it surfaces as a transport-class failure).

  /** Request-less RPC paths rebind R2 from the persisted repo name (set by the
   * first HTTP request — the advert always precedes a push); fork replication
   * is the request-less path's request-less path — a fresh fork DO's first
   * contact is beginForkImport, which persists meta.storage_key before any
   * pack key is derived — so the storage key is the fallback name source. */
  private rpcBind(): void {
    // sealed cells (SPEC-0011 §8): binding reads meta — refuse-adjacent paths
    // skip it so the destroy/delete RPCs stay reachable on a sealed store
    if (this.store.schemaState.refused !== null) return;
    const name = this.store.getMeta("repo") ?? this.store.getMeta("storage_key");
    if (name) this.bindR2(name);
  }

  private leaseHost(): LeaseHost {
    this.rpcBind();
    return {
      store: this.store,
      storage: this.ctx.storage,
      deletePackObjects: async (keys) => {
        const bucket = this.env.REPO_PACKS;
        if (!bucket) return;
        try {
          await bucket.delete(keys);
        } catch (err) {
          // best effort: an unswept staging object is reclaimed by the
          // lease-expiry sweep's retry on the next begin/alarm
          console.log(`[r2 ${this.store.getMeta("repo") ?? ""}] sweep delete failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      readPackTail: async (r2Key, len) => {
        const bucket = this.env.REPO_PACKS;
        if (!bucket) return null;
        try {
          const obj = await bucket.get(r2Key, { range: { suffix: len } });
          if (!obj) return null;
          return new Uint8Array(await obj.arrayBuffer());
        } catch (err) {
          console.log(`[r2 ${r2Key}] tail read failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      },
      removeFromRegistry: async (name) => {
        await this.env.REGISTRY.getByName("registry").remove(name);
      },
    };
  }

  async beginReceive(input: BeginReceiveInput): Promise<BeginReceiveResult> {
    return beginReceive(this.leaseHost(), input);
  }

  async finalizeReceive(input: FinalizeReceiveInput): Promise<FinalizeReceiveResult> {
    return finalizeReceive(this.leaseHost(), input);
  }

  async releaseReceive(input: ReleaseReceiveInput): Promise<ReleaseReceiveResult> {
    return releaseReceive(this.leaseHost(), input);
  }

  /** Land one bounded batch of Worker-resolved index rows (Step 2), keyed by
   * the pack name the Worker derives from the pack's own SHA-1. */
  async putIndexRows(leaseToken: string, packName: string, rows: IndexRow[]): Promise<{ tag: "ok" } | { tag: "lease_mismatch" }> {
    return putIndexRows(this.leaseHost(), leaseToken, packName, rows);
  }

  /** Resolve oids for the Worker's thin-pack bases and connectivity
   * anti-checks (Step 2); the Worker R2-reads packed hits itself. */
  async lookupObjects(leaseToken: string, oids: string[]): Promise<LookupObjectResult[]> {
    return lookupObjects(this.leaseHost(), leaseToken, oids);
  }

  // ---- API commit builder (SPEC-0001a §4) + merge surface (SPEC-0001b §4) --
  // Public RPCs over the LeaseHost delegation, same tagged-union discipline as
  // the receive lease RPCs above. The read paths (mergeBase through
  // rebaseOnto) perform NO durable writes (SPEC-0001b §4.6); executeMerge /
  // putApiObjects / commitApiChange / deleteApiRef are the CAS landings.

  /** Verify + store Worker-built objects (SPEC-0001a §4.3). Idempotent. */
  async putApiObjects(objects: ApiObject[]): Promise<PutApiObjectsResult> {
    return putApiObjects(this.leaseHost(), objects);
  }

  /** One CAS ref landing for a Worker-built commit/tag/branch (SPEC-0001a
   * §4.3). Cannot delete refs — deleteApiRef below. */
  async commitApiChange(input: CommitApiChangeInput): Promise<CommitApiChangeResult> {
    return commitApiChange(this.leaseHost(), input);
  }

  /** CAS ref delete (SPEC-0001b §4.8): PR cleanup, cascade and branch deletes. */
  async deleteApiRef(input: DeleteApiRefInput): Promise<DeleteApiRefResult> {
    return deleteApiRef(this.leaseHost(), input);
  }

  /** Best common ancestor of two refs/oids (SPEC-0001b §4.1). */
  async mergeBase(a: string, b: string): Promise<{ tag: "ok"; base: string | null; exhausted: boolean } | { tag: "missing"; which: "a" | "b" }> {
    return mergeBase(this.leaseHost(), a, b);
  }

  /** `base..head` commits, topological, oldest first (SPEC-0001b §4.1). */
  async listCommitsRange(base: string, head: string, limit: number, page = 0): Promise<{ commits: CommitJson[]; more: boolean } | null> {
    return listCommitsRange(this.leaseHost(), base, head, limit, page);
  }

  /** `rev-list --left-right --count base head` in one walk (§4.1). */
  async countDivergence(base: string, head: string): Promise<{ tag: "ok"; ahead: number; behind: number; exhausted: boolean } | { tag: "missing" }> {
    return countDivergence(this.leaseHost(), base, head);
  }

  /** Read-only mergeability classification (§4.3; writes nothing — §4.6). */
  async checkMergeability(input: CheckMergeabilityInput): Promise<CheckMergeabilityResult> {
    return checkMergeability(this.leaseHost(), input);
  }

  /** Merge execution: one landing primitive, styles as parameters (§4.4). */
  async executeMerge(input: ExecuteMergeInput): Promise<ExecuteMergeResult> {
    return executeMerge(this.leaseHost(), input);
  }

  /** Rebase replay — read-only + in-memory; objects come back in the outcome
   * and land through putRebaseObjects + a fast-forward-only executeMerge (§4.5). */
  async rebaseOnto(input: RebaseOntoInput): Promise<RebaseOutcome> {
    return rebaseOnto(this.leaseHost(), input);
  }

  /** Store a replay's objects through the commit builder's budgets (§4.5). */
  async putRebaseObjects(objects: { oid: string; type: ObjType; data: Uint8Array }[]): Promise<PutRebaseObjectsResult> {
    return putRebaseObjects(this.leaseHost(), objects);
  }

  // ---- fork catalog replication (SPEC-0001b §5.3) ---------------------------
  // The parent/fork pair of the replication lease. listCatalogPage runs on the
  // PARENT (paged catalog + index-row read); begin/adopt/finalize run on the
  // FORK. The bytes move Worker-side — src/fork/replicate.ts is the consumer
  // loop the fork endpoint's queue consumer calls.

  /** Paged read of this repo's ACTIVE pack catalog + index rows (parent side
   * of §5.3's copy loop). `afterPackKey` is the previous page's nextAfter
   * cursor ("" starts); `limit` is the page's index-row budget. */
  async listCatalogPage(afterPackKey: string, limit: number): Promise<CatalogPage> {
    return listCatalogPage(this.leaseHost(), afterPackKey, limit);
  }

  /** Open the replication lease on this (fresh, empty) fork DO: persists the
   * storage key, sets meta.importing (gates beginReceive/commitApiChange/
   * executeMerge), clears stale staging. Idempotent during the import. */
  async beginForkImport(storageKey: string): Promise<BeginForkImportResult> {
    return beginForkImport(this.leaseHost(), storageKey);
  }

  /** Adopt one catalog page: verify the copied pack bytes against their keys,
   * land the index rows, stage completed packs for finalize. */
  async adoptForkPacks(page: CatalogPage): Promise<AdoptForkPacksResult> {
    return adoptForkPacks(this.leaseHost(), page);
  }

  /** Finalize: catalog rows (kind='fork') + refs + HEAD + refs_version bump in
   * ONE transaction; clears meta.importing. Idempotent-safe re-run until this
   * commits. */
  async finalizeForkImport(input: FinalizeForkImportInput): Promise<FinalizeForkImportResult> {
    return finalizeForkImport(this.leaseHost(), input);
  }

  // ---- invariants read RPC ---------------------------------------------------
  // Read-only, lease-free: the Worker's invariants checker pages the pack
  // catalog to cross-check it against R2 (tagged unions only, per the RPC
  // discipline above; the checker must never take or contend on a lease).

  /** Keyset page over the pack catalog — EVERY lifecycle state, pack_key
   * order (the invariants checker classifies non-active rows itself; a
   * superseded row's object may legitimately be gone). `input.cursor` is the
   * previous page's nextCursor (null = first page); `input.limit` is
   * 1..500 (default 200). */
  async listPackCatalog(input: ListPackCatalogInput): Promise<ListPackCatalogResult> {
    return listPackCatalog(this.leaseHost(), input);
  }

  // ---- repo lifecycle (SPEC-0003 §2.5.5; LIFECYCLE gap RPCs) ----------------

  /** Tombstone the repo (delete step 2): new leases are refused, a finalize
   * mid-flight aborts inside its commit transaction. Idempotent. */
  async markDeleted(): Promise<MarkDeletedResult> {
    return markDeleted(this.leaseHost());
  }

  /** Destroy the repo cell (delete step 4, after the R2 prefix purge): one
   * transactional wipe, alarm cleared, registry row removed via the host
   * hook. Does NOT touch R2. Idempotent. */
  async destroy(): Promise<DestroyResult> {
    return destroy(this.leaseHost());
  }

  /** Default-branch setter (SPEC-0003 §2.5.2): accepts "main" or
   * "refs/heads/main"; validates, requires an existing branch on a non-empty
   * repo, writes meta.head + bumps refs_version in one transaction. */
  async setHead(branch: string): Promise<SetHeadResult> {
    return setHead(this.leaseHost(), branch);
  }

  // ---- typed content surface ----------------------------------------------
  // Public methods callable two ways: over HTTP as /<repo>/api/* (JSON; the
  // Worker's authorize gate applies) and directly as Workers RPC by any
  // same-account Worker holding the REPO binding — that path carries no HTTP
  // auth, a service binding is already trusted infrastructure
  // (rpcBind above rebinds R2 for it).

  /**
   * The content-path read lease (SPEC-0011 §3 applied to everything OUTSIDE
   * the two upload-pack arms — closes the gap the M3.2 as-built record named:
   * "content-path reads outside upload-pack (UI blobs, ls-refs peels) remain
   * lease-free"). Every served content read — the six typed content RPCs and
   * the DO's own ui()/config pages — runs through this wrapper:
   *
   * 1. `planFetch` registers a `kind='read'` lease over the READABLE catalog
   *    (active + retired — the conservative whole-catalog dependency set, the
   *    same derivation the serve paths use) in ONE transaction with the
   *    catalog read. From that instant a GC pass cannot flip any dependency
   *    RETIRED→RECLAIMABLE (`hasLiveReadLeaseFor` gates the flip) — the bytes
   *    every read below may name stay in R2 for the wrapper's duration.
   * 2. `gate` (the M3.2 per-segment `serveReadGate`) rides down to every
   *    `store.get` R2 chunk read: past half the TTL it renews INLINE before
   *    the read (a long request keeps its lease indefinitely while it keeps
   *    reading; a request that stalls past the expiry loses only availability
   *    — the next gated read rejects and the whole request fails, Property A).
   *    A rejected renewal, like any mid-read unavailability, throws: the RPC
   *    fails WHOLE, never a torn/partial answer (a snapshot page can no longer
   *    silently omit a blob whose pack was reclaimed mid-archive — the read
   *    cannot name a reclaimed pack while the lease is live, and an unhelmeted
   *    failure surfaces instead).
   * 3. Release fires in `finally` — on completion, error and cancel alike —
   *    decoupling GC from client transfer time (§3.4: buffered response bytes
   *    need no pack protection).
   *
   * A repo with an EMPTY catalog (loose-only: API-created repos before their
   * first push) takes no row and no gate (`planFetch` short-circuits to the
   * guard-free plan id) — nothing R2-backed exists to protect. The cost on
   * the populated path is one small in-DO transaction + one delete per RPC,
   * the same shape the serve arms pay per stream.
   */
  private async withContentLease<T>(fn: (gate: ReadGate | undefined) => Promise<T>): Promise<T> {
    const lease = openPlanLease(this.store, planFetch(this.store, { generation: this.store.refsVersion() }));
    const gate = serveReadGate(this.store, lease);
    try {
      return await fn(gate);
    } finally {
      releasePlanLease(this.store, lease);
    }
  }

  async listRefs(): Promise<RefsResult> {
    this.rpcBind();
    return this.withContentLease(async (gate) => {
      const refs: RefsResult["refs"] = [];
      for (const r of this.store.refs()) {
        const entry: RefsResult["refs"][number] = { name: r.name, target: r.oid };
        if (r.name.startsWith("refs/tags/")) {
          // peeledRefTarget reads the refs row's peeled column (written once at
          // first peel), so repeat calls never re-walk the tag object; a cold
          // peel's tag-object reads ride the content lease (gate)
          const peeled = await this.store.peeledRefTarget(r.name, r.oid, gate);
          if (peeled && peeled !== r.oid) entry.peeled = peeled;
        }
        refs.push(entry);
      }
      return { head: this.store.resolveHead() ? this.store.head() : null, refs };
    });
  }

  /** `id` is a branch, tag, full ref, or reachable oid; absent means HEAD. */
  async readCommit(id?: string): Promise<CommitJson | null> {
    this.rpcBind();
    return this.withContentLease(async (gate) => {
      const rr = await this.resolveRef(id, gate);
      if (!rr) return null;
      const c = await this.peelToCommit(rr.oid, gate);
      return c ? commitJson(c.oid, c.commit) : null;
    });
  }

  async listLog(ref?: string, opts: { path?: string; ofs?: number; n?: number } = {}): Promise<LogResult> {
    this.rpcBind();
    return this.withContentLease(async (gate) => {
      const rr = await this.resolveRef(ref, gate);
      if (!rr) return { commits: [], more: false };
      const n = Math.min(Math.max(opts.n ?? LOG_PAGE, 1), 100);
      const ofs = Math.max(opts.ofs ?? 0, 0);
      const filter: LogFilter = opts.path ? { path: decodePath("/" + opts.path) } : {};
      const { entries, more } = await this.walkLog(rr.oid, ofs, n, filter, gate);
      return { commits: entries.map((e) => commitJson(e.oid, e.commit)), more };
    });
  }

  async listTree(ref?: string, path = ""): Promise<TreeResult | null> {
    this.rpcBind();
    return this.withContentLease(async (gate) => {
      const rr = await this.resolveRef(ref, gate);
      if (!rr) return null;
      const head = await this.peelToCommit(rr.oid, gate);
      if (!head) return null;
      const segs = decodePath("/" + path);
      const found = await this.lookupPath(head.commit.tree, segs, gate);
      if (!found || found.kind !== "tree") return null;
      const entries: TreeEntryJson[] = found.entries.map((e) => {
        const type = isTreeMode(e.mode) ? ("tree" as const) : isGitlinkMode(e.mode) ? ("commit" as const) : ("blob" as const);
        const out: TreeEntryJson = { name: e.name, mode: e.mode, type, oid: e.oid };
        // typeAndSize is an index-only SQLite read — no R2 GET, nothing to gate
        const meta = type === "blob" ? this.store.typeAndSize(e.oid) : null;
        if (meta) out.size = meta.size;
        return out;
      });
      return { oid: found.oid, entries };
    });
  }

  /** Changes id2..id (default id2 = first parent of id, like the diff page). */
  async readDiff(id?: string, id2?: string): Promise<DiffResult | null> {
    this.rpcBind();
    return this.withContentLease(async (gate) => {
      const rr = await this.resolveRef(id, gate);
      if (!rr) return null;
      const head = await this.peelToCommit(rr.oid, gate);
      if (!head) return null;
      let oldOid: string | null = null;
      if (id2) {
        const rr2 = await this.resolveRef(id2, gate);
        const c2 = rr2 ? await this.peelToCommit(rr2.oid, gate) : null;
        if (!c2) return null;
        oldOid = c2.oid;
      } else {
        oldOid = head.commit.parents[0] ?? null;
      }
      const oldCommit = oldOid ? await this.loadCommit(oldOid, gate) : null;
      const { files, truncated } = await this.computeDiff(oldCommit?.tree ?? null, head.commit.tree, gate);
      return {
        old: oldOid,
        new: head.oid,
        truncated,
        files: files.map((f) => ({ path: f.path, old: f.o, new: f.n, kind: f.kind, add: f.add, del: f.del, hunks: f.hunks })),
      };
    });
  }

  async readBlob(ref: string | undefined, path: string): Promise<BlobResult | null> {
    this.rpcBind();
    return this.withContentLease(async (gate) => {
      const rr = await this.resolveRef(ref, gate);
      if (!rr) return null;
      const head = await this.peelToCommit(rr.oid, gate);
      if (!head) return null;
      const found = await this.lookupPath(head.commit.tree, decodePath("/" + path), gate);
      if (!found || found.kind !== "blob") return null;
      const obj = await this.store.get(found.entry.oid, gate);
      if (!obj || obj.type !== "blob") return null;
      return { oid: found.entry.oid, mode: found.entry.mode, data: obj.data };
    });
  }

  /** The content methods over HTTP. GET-only; routed from ui(). */
  private async api(path: string, q: URLSearchParams): Promise<Response> {
    const h = q.get("h") ?? undefined;
    const json = (data: unknown, status = 200) =>
      Response.json(data, { status, headers: { "x-content-type-options": "nosniff" } });
    const notFound = (what: string) => json({ error: what }, 404);
    if (path === "/api/refs") return json(await this.listRefs());
    if (path === "/api/log") {
      return json(
        await this.listLog(h, {
          path: q.get("path") ?? undefined,
          ofs: parseInt(q.get("ofs") ?? "0", 10) || 0,
          n: parseInt(q.get("n") ?? "", 10) || undefined,
        })
      );
    }
    if (path === "/api/commit") {
      const c = await this.readCommit(q.get("id") ?? h);
      return c ? json(c) : notFound("commit not found");
    }
    if (path === "/api/tree") {
      const t = await this.listTree(h, q.get("path") ?? "");
      return t ? json(t) : notFound("tree not found");
    }
    if (path === "/api/diff") {
      const d = await this.readDiff(q.get("id") ?? h, q.get("id2") ?? undefined);
      return d ? json(d) : notFound("commit not found");
    }
    if (path === "/api/blob") {
      const blob = await this.readBlob(h, q.get("path") ?? "");
      if (!blob) return notFound("blob not found");
      const res = rawBlobResponse(blob.data, (q.get("path") ?? "").split("/").pop() ?? "");
      res.headers.set("x-oid", blob.oid);
      return res;
    }
    return notFound(`no such endpoint: ${path}`);
  }

  /**
   * R2 full-clone offload adapter (write side), or undefined when no bucket is
   * bound (celld and Workers without the binding both fall back to the pure DO
   * path). Since the Step 3 unification this is the SAME bucket as receive
   * (REPO_PACKS) — the clone cache lives under repos/<storage_key>/clone-cache/.
   * A throwing createMultipartUpload (celld deliberately makes R2 throw)
   * degrades to null so the clone still streams uncached; part-level failures
   * are handled by MultipartCapture aborting the upload.
   */
  private packCacheFor(): PackCache | undefined {
    const bucket = this.env.REPO_PACKS;
    if (!bucket) return undefined;
    const storageKey = this.storageKey();
    return {
      storageKey,
      beginMultipart: async (key, objects) => {
        try {
          const mp = await bucket.createMultipartUpload(key, {
            customMetadata: { objects: String(objects) },
          });
          const parts: R2UploadedPart[] = [];
          return {
            uploadPart: async (data) => {
              parts.push(await mp.uploadPart(parts.length + 1, data));
            },
            complete: async () => {
              await mp.complete(parts);
            },
            abort: async () => {
              await mp.abort();
            },
          };
        } catch (err) {
          console.log(`[r2 ${storageKey}] multipart begin failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      },
    };
  }

  /** Purge every R2 object for a repo on delete: packs, staging and clone
   * cache share ONE prefix (repos/<storage_key>/) since the Step 3 key
   * layout; no request name is involved. */
  private async purgePackCache(): Promise<void> {
    const bucket = this.env.REPO_PACKS;
    if (!bucket) return;
    const prefix = repoPrefix(this.storageKey());
    try {
      for (let cursor: string | undefined; ; ) {
        const listed = await bucket.list({ prefix, cursor });
        if (listed.objects.length) await bucket.delete(listed.objects.map((o) => o.key));
        if (!listed.truncated) break;
        cursor = listed.cursor;
      }
    } catch (err) {
      console.log(`[r2 ${prefix}] purge failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async readBody(req: Request): Promise<Uint8Array> {
    let body: Uint8Array = new Uint8Array(await req.arrayBuffer());
    if (body.length > MAX_UPLOAD_PACK_BYTES) throw new Error("request body exceeds maximum size");
    if (req.headers.get("content-encoding")?.includes("gzip")) {
      body = gunzipLimited(body, MAX_UPLOAD_PACK_BYTES);
    }
    return body;
  }

  private async base(repo: string, tab: string, ref?: string, formAction?: string, gate?: ReadGate): Promise<Omit<LayoutOpts, "body">> {
    const branches = this.store
      .refs()
      .filter((r) => r.name.startsWith("refs/heads/"))
      .map((r) => r.name.slice(11))
      .slice(0, 50);
    const headBranch = this.store.head().replace("refs/heads/", "");
    return {
      site: this.env.SITE_NAME ?? "dgit",
      siteDesc: this.env.SITE_DESC ?? "",
      title: `${repo} - ${tab}`,
      repo,
      sub: this.store.getMeta("description") || "[no description]",
      tab,
      ref: ref ?? headBranch,
      hasAbout: (await this.findReadme(gate)) !== null,
      branches,
      formAction: formAction ?? `/${repoUrl(repo)}/`,
    };
  }

  /**
   * The DO's own web UI boundary: ONE content read lease spans the whole page
   * render (SPEC-0011 §3 content-path coverage — the M3.2 record's "UI blobs"
   * gap). Every object read below — tree walks, blob bodies, snapshot
   * archives, log walks — rides the lease and the per-read gate: a concurrent
   * RETIRED→RECLAIMABLE flip is blocked for the render's duration, a rejection
   * or expiry throws and fails the page whole (snapshotPage's silent
   * `if (!obj) continue` can no longer omit a reclaimed blob from an archive —
   * under the lease the read cannot name a reclaimed pack, and an unfixable
   * read surfaces as a failed request instead).
   */
  private async ui(repo: string, host: string, proto: string, path: string, q: URLSearchParams): Promise<Response> {
    // /api/* re-enters the typed content RPCs, which lease themselves — route
    // them around the page lease so a request holds exactly one (the gate
    // parameter is theirs to consume, not the page's)
    if (path.startsWith("/api/")) return this.uiPage(repo, host, proto, path, q, undefined);
    return this.withContentLease((gate) => this.uiPage(repo, host, proto, path, q, gate));
  }

  private async uiPage(
    repo: string,
    host: string,
    proto: string,
    path: string,
    q: URLSearchParams,
    gate: ReadGate | undefined
  ): Promise<Response> {
    const h = q.get("h") ?? undefined;
    if (path.startsWith("/api/")) return this.api(path, q);
    if (path === "/" || path === "") return this.summaryPage(repo, host, proto, gate);
    if (path === "/about/" || path === "/about") return this.aboutPage(repo, h, gate);
    if (path === "/log/" || path === "/log")
      return this.logPage(repo, h, parseInt(q.get("ofs") ?? "0", 10) || 0, {
        path: q.get("path") ? decodePath("/" + q.get("path")!) : undefined,
        qt: q.get("qt") ?? undefined,
        q: q.get("q") ?? undefined,
      }, gate);
    if (path === "/refs/" || path === "/refs") return this.refsPage(repo, gate);
    if (path === "/commit/" || path === "/commit") return this.commitPage(repo, q.get("id") ?? undefined, h, gate);
    if (path === "/diff/" || path === "/diff")
      return this.diffPage(repo, q.get("id") ?? undefined, q.get("id2") ?? undefined, h, false, gate);
    if (path === "/rawdiff/" || path === "/rawdiff")
      return this.diffPage(repo, q.get("id") ?? undefined, q.get("id2") ?? undefined, h, true, gate);
    if (path === "/patch/" || path === "/patch") return this.patchPage(repo, q.get("id") ?? undefined, h, gate);
    if (path === "/tag/" || path === "/tag") return this.tagPage(repo, q.get("h") ?? q.get("id") ?? undefined, gate);
    if (path === "/atom/" || path === "/atom") return this.atomPage(repo, host, proto, h, gate);
    if (path === "/stats/" || path === "/stats") return this.statsPage(repo, h, q.get("period") ?? "m", gate);
    if (path === "/blob/" || path === "/blob") return this.blobByIdPage(q.get("id") ?? "", gate);
    if (path.startsWith("/tree")) return this.treePage(repo, h, decodePath(path.slice("/tree".length)), gate);
    if (path.startsWith("/plain")) return this.plainPage(h, decodePath(path.slice("/plain".length)), gate);
    if (path.startsWith("/blame")) return this.blamePage(repo, h, decodePath(path.slice("/blame".length)), gate);
    if (path.startsWith("/snapshot/")) return this.snapshotPage(repo, decodeURIComponent(path.slice("/snapshot/".length)), gate);
    return errorPage(await this.base(repo, "summary", undefined, undefined, gate), `page not found: ${path}`);
  }


  /**
   * Resolve an object id for the browser's object-serving paths (blob/commit/
   * diff/patch/tree-by-oid). Only a full 40-char oid that is reachable from a
   * current ref is served: short-prefix resolution let a force-pushed secret be
   * brute-forced through the UI even after the protocol side stopped serving
   * unreachable objects.
   */
  private async resolveServable(id: string, gate?: ReadGate): Promise<string | null> {
    if (!isOid(id) || !this.store.has(id)) return null;
    return (await this.reachableOid(id, gate)) ? id : null;
  }

  /** Is `target` reachable from any current ref (or HEAD)? */
  private async reachableOid(target: string, gate?: ReadGate): Promise<boolean> {
    // the full-clone reachable-set cache is versioned against current refs
    // (null on any mismatch), so a hit here is exactly as correct as the walk
    // below and skips inflating/parsing the whole object graph
    const cached = this.store.loadReachable();
    if (cached) return cached.hasHex(target);
    const seen = new OidSet(Math.max(this.store.objectCount(), 4096));
    const stack: string[] = this.store.refs().map((r) => r.oid);
    const head = this.store.resolveHead();
    if (head) stack.push(head);
    while (stack.length) {
      const oid = stack.pop()!;
      if (oid === target) return true;
      if (!seen.addHex(oid)) continue;
      const meta = this.store.typeAndSize(oid);
      if (!meta) continue;
      if (meta.type === "blob") continue;
      const obj = await this.store.get(oid, gate);
      if (!obj) continue;
      if (obj.type === "commit") {
        const c = parseCommit(obj.data);
        stack.push(c.tree, ...c.parents);
      } else if (obj.type === "tag") {
        const t = parseTag(obj.data);
        if (t.object) stack.push(t.object);
      } else if (obj.type === "tree") {
        for (const e of parseTree(obj.data)) {
          if (!isGitlinkMode(e.mode)) stack.push(e.oid);
        }
      }
    }
    return false;
  }

  /** Resolve ?h= (branch, tag, full ref, or oid) to an object id. */
  private async resolveRef(h: string | undefined, gate?: ReadGate): Promise<{ refName: string | null; oid: string } | null> {
    if (!h) {
      const oid = this.store.resolveHead();
      return oid ? { refName: this.store.head(), oid } : null;
    }
    for (const cand of [`refs/heads/${h}`, `refs/tags/${h}`, h]) {
      const oid = this.store.getRef(cand);
      if (oid) return { refName: cand, oid };
    }
    const full = await this.resolveServable(h, gate);
    if (full) return { refName: null, oid: full };
    return null;
  }

  /**
   * Follow tag objects until we reach a commit. Tag oids are immutable
   * content, so a start oid that actually peeled through a tag has its final
   * commit oid cached — a hit skips every intermediate tag object read.
   */
  private async peelToCommit(oid: string, gate?: ReadGate): Promise<{ oid: string; commit: Commit } | null> {
    const start = oid;
    const cached = this.store.getPeeled(start);
    if (cached !== null) {
      const obj = await this.store.get(cached, gate);
      return obj?.type === "commit" ? { oid: cached, commit: parseCommit(obj.data) } : null;
    }
    for (let i = 0; i < 10; i++) {
      const obj = await this.store.get(oid, gate);
      if (!obj) return null;
      if (obj.type === "commit") {
        if (oid !== start) this.store.setPeeled(start, oid);
        return { oid, commit: parseCommit(obj.data) };
      }
      if (obj.type === "tag") {
        oid = parseTag(obj.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  private async loadCommit(oid: string, gate?: ReadGate): Promise<Commit | null> {
    const obj = await this.store.get(oid, gate);
    return obj?.type === "commit" ? parseCommit(obj.data) : null;
  }

  /** oid of the entry at `path` in this commit's tree (any type), or null. */
  private async pathOid(commit: Commit, path: string[], gate?: ReadGate): Promise<string | null> {
    let oid = commit.tree;
    for (const seg of path) {
      const obj = await this.store.get(oid, gate);
      if (obj?.type !== "tree") return null;
      const entry = parseTree(obj.data).find((e) => e.name === seg);
      if (!entry) return null;
      oid = entry.oid;
    }
    return oid;
  }

  /** pathOid keyed by the root tree it starts from: shared across a log walk. */
  private async pathOidCached(
    treeOid: string,
    path: string[],
    memo: Map<string, string | null>,
    gate?: ReadGate
  ): Promise<string | null> {
    const hit = memo.get(treeOid);
    if (hit !== undefined) return hit;
    let oid: string | null = treeOid;
    for (const seg of path) {
      const obj = await this.store.get(oid, gate);
      if (obj?.type !== "tree") { oid = null; break; }
      const entry = parseTree(obj.data).find((e) => e.name === seg);
      if (!entry) { oid = null; break; }
      oid = entry.oid;
    }
    memo.set(treeOid, oid);
    return oid;
  }

  private async matchesFilter(e: LogEntry, filter: LogFilter, memo: Map<string, string | null>, gate?: ReadGate): Promise<boolean> {
    if (filter.path && filter.path.length) {
      const mine = await this.pathOidCached(e.commit.tree, filter.path, memo, gate);
      const parentTree = e.commit.parents[0] ? (await this.loadCommit(e.commit.parents[0], gate))?.tree : undefined;
      const theirs = parentTree ? await this.pathOidCached(parentTree, filter.path, memo, gate) : null;
      if (mine === theirs) return false;
    }
    if (filter.q) {
      const q = filter.q.toLowerCase();
      const qt = filter.qt ?? "grep";
      if (qt === "author") {
        if (!`${e.commit.author.name} ${e.commit.author.email}`.toLowerCase().includes(q)) return false;
      } else if (qt === "committer") {
        if (!`${e.commit.committer.name} ${e.commit.committer.email}`.toLowerCase().includes(q)) return false;
      } else {
        if (!e.commit.message.toLowerCase().includes(q)) return false;
      }
    }
    return true;
  }

  /** Date-ordered commit walk (newest first) with optional filtering. */
  private async walkLog(
    tip: string,
    skip: number,
    limit: number,
    filter: LogFilter = {},
    gate?: ReadGate
  ): Promise<{ entries: LogEntry[]; more: boolean }> {
    const first = await this.peelToCommit(tip, gate);
    if (!first) return { entries: [], more: false };
    skip = Math.min(skip, MAX_LOG_SCAN); // a wild ofs must not drive the walk to its cap for an empty page
    const scanCap = filter.path?.length ? PATH_LOG_SCAN : MAX_LOG_SCAN;
    const memo = new Map<string, string | null>();
    const seen = new Set<string>([first.oid]);
    const frontier: LogEntry[] = [{ oid: first.oid, commit: first.commit }];
    const out: LogEntry[] = [];
    let scanned = 0;
    while (frontier.length && out.length < skip + limit + 1 && scanned++ < scanCap) {
      frontier.sort((a, b) => b.commit.committer.time - a.commit.committer.time);
      const cur = frontier.shift()!;
      if (await this.matchesFilter(cur, filter, memo, gate)) out.push(cur);
      for (const p of cur.commit.parents) {
        if (seen.has(p)) continue;
        seen.add(p);
        const c = await this.loadCommit(p, gate);
        if (c) frontier.push({ oid: p, commit: c });
      }
    }
    return { entries: out.slice(skip, skip + limit), more: out.length > skip + limit };
  }

  /** First-parent history of a path (for blame), newest first, with blobs. */
  private async pathHistory(tip: string, path: string[], cap: number, maxBytes: number, gate?: ReadGate): Promise<BlameHistoryEntry[]> {
    const out: BlameHistoryEntry[] = [];
    let cur = await this.peelToCommit(tip, gate);
    let steps = 0;
    let bytes = 0;
    while (cur && steps++ < MAX_LOG_SCAN && out.length < cap) {
      const myOid = await this.pathOid(cur.commit, path, gate);
      const parent = cur.commit.parents[0] ? await this.peelToCommit(cur.commit.parents[0], gate) : null;
      const parentOid = parent ? await this.pathOid(parent.commit, path, gate) : null;
      if (myOid !== parentOid) {
        const blob = myOid ? await this.store.get(myOid, gate) : null;
        const data = blob?.type === "blob" ? blob.data : null;
        if (data) {
          bytes += data.length;
          if (bytes > maxBytes && out.length) break; // bound total blobs held in memory
        }
        out.push({ oid: cur.oid, commit: cur.commit, blob: data });
        if (!parentOid) break; // file created here
      }
      cur = parent;
    }
    return out;
  }

  /** Map oid -> decorations (branch/tag pointing at it). */
  private async decorations(repo: string, gate?: ReadGate): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const r = `/${repoUrl(repo)}`;
    for (const ref of this.store.refs()) {
      let html = "";
      let target = ref.oid;
      if (ref.name.startsWith("refs/heads/")) {
        html = `<a class='branch-deco' href='${r}/log/?h=${encodeURIComponent(ref.name.slice(11))}'>${esc(ref.name.slice(11))}</a>`;
      } else if (ref.name.startsWith("refs/tags/")) {
        const peeled = await this.peelToCommit(ref.oid, gate);
        if (peeled) target = peeled.oid;
        html = `<a class='tag-deco' href='${r}/tag/?h=${encodeURIComponent(ref.name.slice(10))}'>${esc(ref.name.slice(10))}</a>`;
      } else continue;
      map.set(target, (map.get(target) ?? "") + html);
    }
    return map;
  }

  private async lookupPath(
    rootTree: string,
    path: string[],
    gate?: ReadGate
  ): Promise<{ kind: "tree"; oid: string; entries: TreeEntry[] } | { kind: "blob"; entry: TreeEntry } | null> {
    let treeOid = rootTree;
    for (let i = 0; i < path.length; i++) {
      const obj = await this.store.get(treeOid, gate);
      if (obj?.type !== "tree") return null;
      const entry = parseTree(obj.data).find((e) => e.name === path[i]);
      if (!entry) return null;
      if (i === path.length - 1 && !isTreeMode(entry.mode)) {
        return { kind: "blob", entry };
      }
      if (!isTreeMode(entry.mode)) return null;
      treeOid = entry.oid;
    }
    const obj = await this.store.get(treeOid, gate);
    if (obj?.type !== "tree") return null;
    return { kind: "tree", oid: treeOid, entries: parseTree(obj.data) };
  }

  private async findReadme(gate?: ReadGate): Promise<{ name: string; oid: string } | null> {
    const head = this.store.resolveHead();
    if (!head) return null;
    const c = await this.peelToCommit(head, gate);
    if (!c) return null;
    const root = await this.store.get(c.commit.tree, gate);
    if (root?.type !== "tree") return null;
    const entries = parseTree(root.data);
    for (const want of README_NAMES) {
      const e = entries.find((x) => x.name.toLowerCase() === want && !isTreeMode(x.mode));
      if (e) return { name: e.name, oid: e.oid };
    }
    return null;
  }

  private async flattenTree(treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>, gate?: ReadGate): Promise<void> {
    const obj = await this.store.get(treeOid, gate);
    if (obj?.type !== "tree") return;
    for (const e of parseTree(obj.data)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (isTreeMode(e.mode)) await this.flattenTree(e.oid, p, out, gate);
      else if (!isGitlinkMode(e.mode)) out.set(p, { oid: e.oid, mode: e.mode });
    }
  }


  private async computeDiff(oldTree: string | null, newTree: string, gate?: ReadGate): Promise<{ files: FileDiff[]; truncated: boolean }> {
    const oldFiles = new Map<string, { oid: string; mode: string }>();
    const newFiles = new Map<string, { oid: string; mode: string }>();
    if (oldTree) await this.flattenTree(oldTree, "", oldFiles, gate);
    await this.flattenTree(newTree, "", newFiles, gate);
    const paths = [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort();
    const files: FileDiff[] = [];
    let truncated = false;
    for (const p of paths) {
      const o = oldFiles.get(p) ?? null;
      const n = newFiles.get(p) ?? null;
      if (o && n && o.oid === n.oid && o.mode === n.mode) continue;
      if (files.length >= MAX_DIFF_FILES) {
        truncated = true;
        break;
      }
      const oldData = o ? (await this.store.get(o.oid, gate))?.data ?? new Uint8Array(0) : new Uint8Array(0);
      const newData = n ? (await this.store.get(n.oid, gate))?.data ?? new Uint8Array(0) : new Uint8Array(0);
      const fd: FileDiff = { path: p, o, n, kind: "text", ops: null, hunks: [], add: 0, del: 0 };
      if (isBinary(oldData) || isBinary(newData)) {
        fd.kind = "binary";
      } else if (oldData.length > MAX_DIFF_BLOB || newData.length > MAX_DIFF_BLOB) {
        fd.kind = "toolarge";
      } else {
        const ops = diffLines(td.decode(oldData), td.decode(newData));
        if (!ops) {
          fd.kind = "toolarge";
        } else {
          fd.ops = ops;
          fd.hunks = toHunks(ops);
          for (const op of ops) {
            if (op.tag === "add") fd.add++;
            if (op.tag === "del") fd.del++;
          }
        }
      }
      files.push(fd);
    }
    return { files, truncated };
  }

  private renderDiffHtml(repo: string, files: FileDiff[], truncated: boolean): string {
    let statRows = "";
    let diffHtml = "";
    let totalAdd = 0, totalDel = 0;
    for (const f of files) {
      totalAdd += f.add;
      totalDel += f.del;
      const status = !f.o
        ? " (new)"
        : !f.n
          ? " (deleted)"
          : f.o.mode !== f.n.mode
            ? ` <span class='modechange'>[mode ${f.o.mode} -&gt; ${f.n.mode}]</span>`
            : "";
      statRows += `<tr><td>${esc(f.path)}${status}</td><td class='add right'>+${f.add}</td><td class='del right'>-${f.del}</td></tr>`;
      let bodyHtml: string;
      if (f.kind === "binary") {
        bodyHtml = `<div>Binary files differ</div>`;
      } else if (f.kind === "toolarge") {
        bodyHtml = `<div>Diff skipped: file too large</div>`;
      } else {
        bodyHtml = f.hunks.map((hk) => renderHunk(hk)).join("");
      }
      diffHtml += `<div class='head'>diff --git a/${esc(f.path)} b/${esc(f.path)}</div>${bodyHtml}`;
    }
    return `
<div class='diffstat-header'>Diffstat</div>
<table class='diffstat'>
${statRows || "<tr><td>(no changes)</td></tr>"}
</table>
<div class='diffstat-summary'>${files.length} file${files.length === 1 ? "" : "s"} changed, ${totalAdd} insertions(+), ${totalDel} deletions(-)${truncated ? " [diff truncated]" : ""}</div>
<table class='diff'><tr><td>${diffHtml}</td></tr></table>`;
  }

  private renderRawDiff(files: FileDiff[]): string {
    let out = "";
    for (const f of files) {
      out += `diff --git a/${f.path} b/${f.path}\n`;
      if (!f.o) {
        out += `new file mode ${f.n!.mode.padStart(6, "0")}\n`;
        out += `index 0000000..${f.n!.oid.slice(0, 7)}\n`;
      } else if (!f.n) {
        out += `deleted file mode ${f.o.mode.padStart(6, "0")}\n`;
        out += `index ${f.o.oid.slice(0, 7)}..0000000\n`;
      } else {
        if (f.o.mode !== f.n.mode) {
          out += `old mode ${f.o.mode.padStart(6, "0")}\nnew mode ${f.n.mode.padStart(6, "0")}\n`;
        }
        out += `index ${f.o.oid.slice(0, 7)}..${f.n.oid.slice(0, 7)}${f.o.mode === f.n.mode ? ` ${f.n.mode.padStart(6, "0")}` : ""}\n`;
      }
      if (f.kind === "binary") {
        out += `Binary files a/${f.path} and b/${f.path} differ\n`;
        continue;
      }
      if (f.kind === "toolarge") {
        out += `--- diff skipped: file too large ---\n`;
        continue;
      }
      out += f.o ? `--- a/${f.path}\n` : `--- /dev/null\n`;
      out += f.n ? `+++ b/${f.path}\n` : `+++ /dev/null\n`;
      for (const hk of f.hunks) {
        out += `@@ -${hk.aStart},${hk.aLen} +${hk.bStart},${hk.bLen} @@\n`;
        for (const op of hk.ops) {
          out += (op.tag === "add" ? "+" : op.tag === "del" ? "-" : " ") + op.line + "\n";
        }
      }
    }
    return out;
  }


  private async aboutPage(repo: string, h: string | undefined, gate?: ReadGate): Promise<Response> {
    const base = await this.base(repo, "about", h, `/${repoUrl(repo)}/about/`, gate);
    const readme = await this.findReadme(gate);
    if (!readme) return errorPage(base, "no readme found");
    const obj = await this.store.get(readme.oid, gate);
    if (!obj) return errorPage(base, "missing readme blob");
    const text = td.decode(obj.data);
    const lower = readme.name.toLowerCase();
    const body =
      lower.endsWith(".md") || lower.endsWith(".markdown")
        ? `<div class='md'>${renderMarkdown(text, { repo, ref: h ?? base.ref })}</div>`
        : `<pre>${esc(text)}</pre>`;
    return htmlResponse(layout({ ...base, body }));
  }

  private async summaryPage(repo: string, host: string, proto: string, gate?: ReadGate): Promise<Response> {
    const base = await this.base(repo, "summary", undefined, undefined, gate);
    const branches = this.store.refs().filter((r) => r.name.startsWith("refs/heads/"));
    const tags = this.store.refs().filter((r) => r.name.startsWith("refs/tags/"));
    const r = `/${repoUrl(repo)}`;

    if (!branches.length && !tags.length) {
      return htmlResponse(
        layout({
          ...base,
          body:
            `<div class='error'>empty repository</div>` +
            `<p>push something to get started:</p>` +
            `<pre>git remote add origin ${esc(proto)}://${esc(host)}/${esc(repo)}.git\ngit push -u origin main</pre>`,
        })
      );
    }

    const branchRows = (await Promise.all(branches
      .slice(0, 10)
      .map(async (b) => {
        const name = b.name.slice(11);
        const c = await this.peelToCommit(b.oid, gate);
        if (!c) return "";
        return `<tr><td><a href='${r}/log/?h=${encodeURIComponent(name)}'>${esc(name)}</a></td>` +
          `<td><a href='${r}/commit/?id=${c.oid}'>${esc(c.commit.subject)}</a></td>` +
          `<td>${esc(c.commit.author.name)}</td><td>${age(c.commit.committer.time)}</td></tr>`;
      })))
      .join("");

    const tagRows = (await Promise.all(tags
      .slice(0, 10)
      .map(async (t) => {
        const name = t.name.slice(10);
        const obj = await this.store.get(t.oid, gate);
        let when = 0;
        let target = t.oid;
        if (obj?.type === "tag") {
          const tag = parseTag(obj.data);
          when = tag.tagger?.time ?? 0;
          target = tag.object;
        }
        const c = await this.peelToCommit(target, gate);
        if (c && !when) when = c.commit.committer.time;
        const snap = `<a href='${r}/snapshot/${encodeURIComponent(repoBase(repo))}-${encodeURIComponent(name)}.tar.gz'>tar.gz</a> ` +
          `<a href='${r}/snapshot/${encodeURIComponent(repoBase(repo))}-${encodeURIComponent(name)}.zip'>zip</a>`;
        return `<tr><td><a href='${r}/tag/?h=${encodeURIComponent(name)}'>${esc(name)}</a></td>` +
          `<td><a href='${r}/commit/?id=${target}'>${esc(c?.commit.subject ?? "")}</a></td>` +
          `<td>${esc(c?.commit.author.name ?? "")}</td><td>${age(when)}</td><td class='snapshots'>${snap}</td></tr>`;
      })))
      .join("");

    const headOid = this.store.resolveHead();
    const recent = headOid ? (await this.walkLog(headOid, 0, 10, {}, gate)).entries : [];
    const deco = await this.decorations(repo, gate);
    const logRows = recent
      .map(
        (e) =>
          `<tr><td>${age(e.commit.committer.time)}</td>` +
          `<td><a href='${r}/commit/?id=${e.oid}'>${esc(e.commit.subject)}</a>${deco.get(e.oid) ?? ""}</td>` +
          `<td>${esc(e.commit.author.name)}</td></tr>`
      )
      .join("");

    const body = `
<table class='list nowrap'>
<tr class='nohover'><th class='left'>Branch</th><th class='left'>Commit message</th><th class='left'>Author</th><th class='left'>Age</th><th></th></tr>
${branchRows}
${tags.length ? `<tr class='nohover'><td colspan='5'>&nbsp;</td></tr><tr class='nohover'><th class='left'>Tag</th><th class='left'>Commit message</th><th class='left'>Author</th><th class='left'>Age</th><th class='left'>Download</th></tr>${tagRows}` : ""}
<tr class='nohover'><td colspan='5'>&nbsp;</td></tr>
<tr class='nohover'><th class='left'>Age</th><th class='left'>Commit message</th><th class='left'>Author</th><th colspan='2'></th></tr>
${logRows}
<tr class='nohover'><td colspan='5'>&nbsp;</td></tr>
<tr class='nohover'><th class='left' colspan='5'>Clone</th></tr>
<tr class='nohover'><td colspan='5' class='clone-url'>${esc(proto)}://${esc(host)}/${esc(repo)}.git</td></tr>
</table>`;
    return htmlResponse(layout({ ...base, body }));
  }

  private async logPage(repo: string, h: string | undefined, ofs: number, filter: LogFilter, gate?: ReadGate): Promise<Response> {
    const r = `/${repoUrl(repo)}`;
    const base = await this.base(repo, "log", h, `${r}/log/`, gate);
    let tip = h;
    if (filter.qt === "range" && filter.q) {
      tip = filter.q;
      filter = {};
    }
    const rr = await this.resolveRef(tip, gate);
    if (!rr) return errorPage(base, tip ? `bad ref: ${tip}` : "empty repository");
    const { entries, more } = await this.walkLog(rr.oid, ofs, LOG_PAGE, filter, gate);
    const deco = await this.decorations(repo, gate);
    const rows = entries
      .map(
        (e) =>
          `<tr><td>${age(e.commit.committer.time)}</td>` +
          `<td><a href='${r}/commit/?id=${e.oid}'>${esc(e.commit.subject)}</a>${deco.get(e.oid) ?? ""}</td>` +
          `<td>${esc(e.commit.author.name)}</td></tr>`
      )
      .join("");
    const params = new URLSearchParams();
    if (h) params.set("h", h);
    if (filter.q) params.set("q", filter.q);
    if (filter.qt) params.set("qt", filter.qt);
    if (filter.path?.length) params.set("path", filter.path.join("/"));
    const link = (o: number) => {
      const p = new URLSearchParams(params);
      if (o > 0) p.set("ofs", String(o));
      return `?${p.toString()}`;
    };
    const nav =
      `<div style='margin-top:1em'>` +
      (ofs > 0 ? `<a href='${link(Math.max(0, ofs - LOG_PAGE))}'>[prev]</a> ` : "") +
      (more ? `<a href='${link(ofs + LOG_PAGE)}'>[next]</a>` : "") +
      `</div>`;
    const qt = filter.qt ?? "grep";
    const searchForm =
      `<form method='get' action='${r}/log/'>` +
      (h ? `<input type='hidden' name='h' value='${esc(h)}'/>` : "") +
      `<select name='qt'>` +
      ["grep", "author", "committer", "range"]
        .map((t) => `<option value='${t}'${t === qt ? " selected='selected'" : ""}>${t}</option>`)
        .join("") +
      `</select> <input type='text' name='q' size='30' value='${esc(filter.q ?? "")}'/> ` +
      `<input type='submit' value='search'/></form>`;
    const pathNote = filter.path?.length
      ? `<div class='path'>path: ${esc(filter.path.join("/"))} (<a href='${r}/log/${h ? `?h=${encodeURIComponent(h)}` : ""}'>clear</a>)</div>`
      : "";
    const body = `
${searchForm}
${pathNote}
<table class='list nowrap'>
<tr class='nohover'><th class='left'>Age</th><th class='left'>Commit message</th><th class='left'>Author</th></tr>
${rows || "<tr class='nohover'><td colspan='3'>(no matching commits)</td></tr>"}
</table>${nav}`;
    return htmlResponse(layout({ ...base, body }));
  }

  private async refsPage(repo: string, gate?: ReadGate): Promise<Response> {
    const r = `/${repoUrl(repo)}`;
    const base = await this.base(repo, "refs", undefined, `${r}/refs/`, gate);
    const refs = this.store.refs();
    const branches = refs.filter((x) => x.name.startsWith("refs/heads/"));
    const tags = refs.filter((x) => x.name.startsWith("refs/tags/"));
    const branchRows = (await Promise.all(branches
      .map(async (b) => {
        const name = b.name.slice(11);
        const c = await this.peelToCommit(b.oid, gate);
        const snap = `<a href='${r}/snapshot/${encodeURIComponent(repoBase(repo))}-${encodeURIComponent(name)}.tar.gz'>tar.gz</a> ` +
          `<a href='${r}/snapshot/${encodeURIComponent(repoBase(repo))}-${encodeURIComponent(name)}.zip'>zip</a>`;
        return `<tr><td><a href='${r}/log/?h=${encodeURIComponent(name)}'>${esc(name)}</a></td>` +
          `<td class='sha1'><a href='${r}/commit/?id=${b.oid}'>${b.oid.slice(0, 10)}</a></td>` +
          `<td>${esc(c?.commit.author.name ?? "")}</td><td>${c ? age(c.commit.committer.time) : ""}</td><td class='snapshots'>${snap}</td></tr>`;
      })))
      .join("");
    const tagRows = (await Promise.all(tags
      .map(async (t) => {
        const name = t.name.slice(10);
        const obj = await this.store.get(t.oid, gate);
        let when = 0;
        let who = "";
        let target = t.oid;
        if (obj?.type === "tag") {
          const tag = parseTag(obj.data);
          when = tag.tagger?.time ?? 0;
          who = tag.tagger?.name ?? "";
          target = tag.object;
        } else if (obj?.type === "commit") {
          const c = parseCommit(obj.data);
          when = c.committer.time;
          who = c.author.name;
        }
        const snap = `<a href='${r}/snapshot/${encodeURIComponent(repoBase(repo))}-${encodeURIComponent(name)}.tar.gz'>tar.gz</a> ` +
          `<a href='${r}/snapshot/${encodeURIComponent(repoBase(repo))}-${encodeURIComponent(name)}.zip'>zip</a>`;
        return `<tr><td><a href='${r}/tag/?h=${encodeURIComponent(name)}'>${esc(name)}</a></td>` +
          `<td class='sha1'><a href='${r}/commit/?id=${target}'>${target.slice(0, 10)}</a></td>` +
          `<td>${esc(who)}</td><td>${age(when)}</td><td class='snapshots'>${snap}</td></tr>`;
      })))
      .join("");
    const body = `
<table class='list nowrap'>
<tr class='nohover'><th class='left' colspan='5'>Branch</th></tr>
${branchRows || "<tr class='nohover'><td colspan='5'>none</td></tr>"}
<tr class='nohover'><td colspan='5'>&nbsp;</td></tr>
<tr class='nohover'><th class='left' colspan='5'>Tag</th></tr>
${tagRows || "<tr class='nohover'><td colspan='5'>none</td></tr>"}
</table>`;
    return htmlResponse(layout({ ...base, body }));
  }

  private pathBar(repo: string, h: string | undefined, path: string[]): string {
    const q = h ? `?h=${encodeURIComponent(h)}` : "";
    let html = `path: <a href='/${repoUrl(repo)}/tree/${q}'>root</a>`;
    let acc = "";
    for (const seg of path) {
      acc += "/" + encodeURIComponent(seg);
      html += `/<a href='/${repoUrl(repo)}/tree${acc}${q}'>${esc(seg)}</a>`;
    }
    return html;
  }

  private async treePage(repo: string, h: string | undefined, path: string[], gate?: ReadGate): Promise<Response> {
    const r = `/${repoUrl(repo)}`;
    const base = await this.base(repo, "tree", h, `${r}/tree/${path.map(encodeURIComponent).join("/")}`, gate);
    const rr = await this.resolveRef(h, gate);
    if (!rr) return errorPage(base, h ? `bad ref: ${h}` : "empty repository");
    const head = await this.peelToCommit(rr.oid, gate);
    if (!head) return errorPage(base, "no commit found");
    const found = await this.lookupPath(head.commit.tree, path, gate);
    if (!found) return errorPage(base, `path not found: ${path.join("/")}`);
    const withPath = { ...base, pathBar: this.pathBar(repo, h, path) };

    if (found.kind === "blob") {
      return this.blobPage(repo, h, path, found.entry, withPath, gate);
    }

    const q = h ? `?h=${encodeURIComponent(h)}` : "";
    const prefix = path.map(encodeURIComponent).join("/");
    const rows = found.entries
      .map((e) => {
        const href = `${prefix ? prefix + "/" : ""}${encodeURIComponent(e.name)}`;
        const dir = isTreeMode(e.mode);
        const gitlink = isGitlinkMode(e.mode);
        const size = dir || gitlink ? "" : String(this.store.typeAndSize(e.oid)?.size ?? "");
        const link = gitlink
          ? `${esc(e.name)} @ ${e.oid.slice(0, 10)}`
          : `<a class='${dir ? "ls-dir" : "ls-blob"}' href='${r}/tree/${href}${q}'>${esc(e.name)}</a>`;
        const pathParam = [...path, e.name].map(encodeURIComponent).join("/");
        const logLink = `<a href='${r}/log/?${h ? `h=${encodeURIComponent(h)}&` : ""}path=${pathParam}'>log</a>`;
        const fileLinks = dir || gitlink ? "" : ` <a href='${r}/plain/${href}${q}'>plain</a> <a href='${r}/blame/${href}${q}'>blame</a>`;
        return `<tr><td class='ls-mode'>${modeString(e.mode)}</td><td>${link}</td><td class='ls-size'>${size}</td>` +
          `<td>${gitlink ? "" : logLink}${fileLinks}</td></tr>`;
      })
      .join("");
    const body = `
<table class='list'>
<tr class='nohover'><th class='left'>Mode</th><th class='left'>Name</th><th class='right'>Size</th><th></th></tr>
${rows}
</table>`;
    return htmlResponse(layout({ ...withPath, body }));
  }

  private async blobPage(
    repo: string,
    h: string | undefined,
    path: string[],
    entry: TreeEntry,
    base: Omit<LayoutOpts, "body">,
    gate?: ReadGate
  ): Promise<Response> {
    const obj = await this.store.get(entry.oid, gate);
    if (!obj) return errorPage(base, "missing blob");
    const r = `/${repoUrl(repo)}`;
    const q = h ? `?h=${encodeURIComponent(h)}` : "";
    const href = path.map(encodeURIComponent).join("/");
    const plainHref = `${r}/plain/${href}${q}`;
    if (isBinary(obj.data)) {
      const body = `<div>Binary file (${obj.data.length} bytes) &mdash; <a href='${plainHref}'>download</a></div>`;
      return htmlResponse(layout({ ...base, body }));
    }
    const name = path[path.length - 1] ?? "";
    const lines = highlightLines(td.decode(obj.data), name);
    const nums = lines.map((_, i) => `<a id='n${i + 1}' href='#n${i + 1}'>${i + 1}</a>`).join("\n");
    const code = lines.map((l) => l || " ").join("\n");
    const body = `
<div>blob: ${entry.oid} (<a href='${plainHref}'>plain</a>) (<a href='${r}/blame/${href}${q}'>blame</a>)</div>
<table class='blob'>
<tr><td class='linenumbers'><pre>${nums}</pre></td><td class='lines'><pre><code>${code}</code></pre></td></tr>
</table>`;
    return htmlResponse(layout({ ...base, body }));
  }

  private async blamePage(repo: string, h: string | undefined, path: string[], gate?: ReadGate): Promise<Response> {
    const r = `/${repoUrl(repo)}`;
    const base = await this.base(repo, "tree", h, `${r}/blame/${path.map(encodeURIComponent).join("/")}`, gate);
    const withPath = { ...base, pathBar: this.pathBar(repo, h, path) };
    const rr = await this.resolveRef(h, gate);
    if (!rr) return errorPage(withPath, "empty repository");
    if (!path.length) return errorPage(withPath, "blame needs a file path");
    // size-gate the tip blob before walking history: a large file would
    // otherwise load up to 200 full revisions into memory before blame() bails
    const tip = await this.peelToCommit(rr.oid, gate);
    if (!tip) return errorPage(withPath, "no commit found");
    const tipOid = await this.pathOid(tip.commit, path, gate);
    const meta = tipOid ? this.store.typeAndSize(tipOid) : null;
    if (!meta || meta.type !== "blob") return errorPage(withPath, `no such file: ${path.join("/")}`);
    if (meta.size > MAX_BLAME_BYTES) return errorPage(withPath, "blame skipped: file too large");
    const history = await this.pathHistory(rr.oid, path, 200, MAX_BLAME_HISTORY_BYTES, gate);
    if (!history.length || !history[0].blob) return errorPage(withPath, `no such file: ${path.join("/")}`);
    if (isBinary(history[0].blob)) return errorPage(withPath, "cannot blame a binary file");
    const result = blame(history);
    if (!result) return errorPage(withPath, "blame skipped: file too large");
    // group consecutive lines from the same commit
    let rows = "";
    for (let i = 0; i < result.length; ) {
      let j = i;
      while (j < result.length && result[j].oid === result[i].oid) j++;
      const b = result[i];
      const codeLines: string[] = [];
      const numLines: string[] = [];
      for (let k = i; k < j; k++) {
        numLines.push(String(k + 1));
        codeLines.push(esc(result[k].line) || " ");
      }
      rows += `<tr><td class='sha1'><a href='${r}/commit/?id=${b.oid}'>${b.oid.slice(0, 8)}</a> ${esc(b.author)} ${age(b.time)}</td>` +
        `<td class='linenumbers'><pre>${numLines.join("\n")}</pre></td>` +
        `<td class='lines'><pre>${codeLines.join("\n")}</pre></td></tr>`;
      i = j;
    }
    const body = `<table class='blame blob'>${rows}</table>`;
    return htmlResponse(layout({ ...withPath, body }));
  }

  private async plainPage(h: string | undefined, path: string[], gate?: ReadGate): Promise<Response> {
    const rr = await this.resolveRef(h, gate);
    if (!rr) return new Response("not found\n", { status: 404 });
    const head = await this.peelToCommit(rr.oid, gate);
    if (!head) return new Response("not found\n", { status: 404 });
    const found = await this.lookupPath(head.commit.tree, path, gate);
    if (!found || found.kind !== "blob") return new Response("not found\n", { status: 404 });
    const obj = await this.store.get(found.entry.oid, gate);
    if (!obj) return new Response("not found\n", { status: 404 });
    return rawBlobResponse(obj.data, path[path.length - 1] ?? "");
  }

  private async blobByIdPage(id: string, gate?: ReadGate): Promise<Response> {
    const oid = await this.resolveServable(id, gate);
    if (!oid) return new Response("not found\n", { status: 404 });
    const obj = await this.store.get(oid, gate);
    if (!obj || obj.type !== "blob") return new Response("not a blob\n", { status: 404 });
    return rawBlobResponse(obj.data, "");
  }

  private async commitPage(repo: string, id: string | undefined, h: string | undefined, gate?: ReadGate): Promise<Response> {
    const r = `/${repoUrl(repo)}`;
    const base = await this.base(repo, "commit", h, `${r}/commit/`, gate);
    const oid = await this.resolveCommitId(id, h, gate);
    if (!oid) return errorPage(base, "commit not found");
    const commit = await this.loadCommit(oid, gate);
    if (!commit) return errorPage(base, `commit not found: ${oid}`);

    const parent = commit.parents[0] ? await this.loadCommit(commit.parents[0], gate) : null;
    const { files, truncated } = await this.computeDiff(parent?.tree ?? null, commit.tree, gate);
    const deco = await this.decorations(repo, gate);

    const body = `
<table class='commit-info'>
<tr><th>author</th><td>${esc(commit.author.name)} &lt;${esc(commit.author.email)}&gt;</td><td class='right'>${fmtDate(commit.author.time, commit.author.tz)}</td></tr>
<tr><th>committer</th><td>${esc(commit.committer.name)} &lt;${esc(commit.committer.email)}&gt;</td><td class='right'>${fmtDate(commit.committer.time, commit.committer.tz)}</td></tr>
<tr><th>commit</th><td colspan='2' class='sha1'>${oid} (<a href='${r}/patch/?id=${oid}'>patch</a>)</td></tr>
<tr><th>tree</th><td colspan='2' class='sha1'><a href='${r}/tree/?h=${oid}'>${commit.tree}</a></td></tr>
${commit.parents.map((p) => `<tr><th>parent</th><td colspan='2' class='sha1'><a href='?id=${p}'>${p}</a> (<a href='${r}/diff/?id=${oid}&id2=${p}'>diff</a>)</td></tr>`).join("")}
<tr><th>download</th><td colspan='2' class='sha1'><a href='${r}/snapshot/${encodeURIComponent(repoBase(repo))}-${oid.slice(0, 10)}.tar.gz'>${esc(repoBase(repo))}-${oid.slice(0, 10)}.tar.gz</a> <a href='${r}/snapshot/${encodeURIComponent(repoBase(repo))}-${oid.slice(0, 10)}.zip'>zip</a></td></tr>
</table>
<div class='commit-subject'>${esc(commit.subject)}${deco.get(oid) ?? ""}</div>
<div class='commit-msg'>${esc(commit.message.split("\n").slice(1).join("\n").trim())}</div>
${this.renderDiffHtml(repo, files, truncated)}`;
    return htmlResponse(layout({ ...base, body }));
  }

  private async resolveCommitId(id: string | undefined, h: string | undefined, gate?: ReadGate): Promise<string | null> {
    if (id) {
      const full = await this.resolveServable(id, gate);
      return full ? (await this.peelToCommit(full, gate))?.oid ?? null : null;
    }
    const rr = await this.resolveRef(h, gate);
    return rr ? (await this.peelToCommit(rr.oid, gate))?.oid ?? null : null;
  }

  /** diff/rawdiff: changes id2..id (default id2 = first parent of id). */
  private async diffPage(
    repo: string,
    id: string | undefined,
    id2: string | undefined,
    h: string | undefined,
    raw: boolean,
    gate?: ReadGate
  ): Promise<Response> {
    const base = await this.base(repo, "diff", h, `/${repoUrl(repo)}/diff/`, gate);
    const newOid = await this.resolveCommitId(id, h, gate);
    if (!newOid) return raw ? new Response("not found\n", { status: 404 }) : errorPage(base, "commit not found");
    const commit = (await this.loadCommit(newOid, gate))!;
    let oldOid: string | null = null;
    if (id2) {
      oldOid = await this.resolveCommitId(id2, undefined, gate);
      if (!oldOid) return raw ? new Response("bad id2\n", { status: 404 }) : errorPage(base, `bad id2: ${id2}`);
    } else {
      oldOid = commit.parents[0] ?? null;
    }
    const oldCommit = oldOid ? await this.loadCommit(oldOid, gate) : null;
    const { files, truncated } = await this.computeDiff(oldCommit?.tree ?? null, commit.tree, gate);
    if (raw) {
      return new Response(this.renderRawDiff(files), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const body = `
<div class='commit-subject'>diff: ${oldOid ? `<a href='../commit/?id=${oldOid}'>${oldOid.slice(0, 10)}</a>` : "(root)"} .. <a href='../commit/?id=${newOid}'>${newOid.slice(0, 10)}</a></div>
${this.renderDiffHtml(repo, files, truncated)}`;
    return htmlResponse(layout({ ...base, body }));
  }

  /** git-format-patch style output, applies with `git am`. */
  private async patchPage(repo: string, id: string | undefined, h: string | undefined, gate?: ReadGate): Promise<Response> {
    const oid = await this.resolveCommitId(id, h, gate);
    if (!oid) return new Response("not found\n", { status: 404 });
    const commit = (await this.loadCommit(oid, gate))!;
    const parent = commit.parents[0] ? await this.loadCommit(commit.parents[0], gate) : null;
    const { files } = await this.computeDiff(parent?.tree ?? null, commit.tree, gate);
    const bodyText = commit.message.split("\n").slice(1).join("\n").trim();
    let statLines = "";
    let totalAdd = 0, totalDel = 0;
    for (const f of files) {
      statLines += ` ${f.path} | ${f.add + f.del} ${"+".repeat(Math.min(f.add, 30))}${"-".repeat(Math.min(f.del, 30))}\n`;
      totalAdd += f.add;
      totalDel += f.del;
    }
    const patch =
      `From ${oid} Mon Sep 17 00:00:00 2001\n` +
      `From: ${commit.author.name} <${commit.author.email}>\n` +
      `Date: ${fmtDate2822(commit.author.time, commit.author.tz)}\n` +
      `Subject: [PATCH] ${commit.subject}\n` +
      `\n` +
      (bodyText ? bodyText + "\n" : "") +
      `---\n` +
      statLines +
      ` ${files.length} file${files.length === 1 ? "" : "s"} changed, ${totalAdd} insertions(+), ${totalDel} deletions(-)\n` +
      `\n` +
      this.renderRawDiff(files) +
      `--\ndgit 0.2\n`;
    return new Response(patch, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  private async tagPage(repo: string, name: string | undefined, gate?: ReadGate): Promise<Response> {
    const r = `/${repoUrl(repo)}`;
    const base = await this.base(repo, "refs", undefined, `${r}/refs/`, gate);
    if (!name) return errorPage(base, "no tag given");
    const target = this.store.getRef(`refs/tags/${name}`) ?? (await this.resolveServable(name, gate));
    if (!target) return errorPage(base, `tag not found: ${name}`);
    const obj = await this.store.get(target, gate);
    if (!obj) return errorPage(base, `missing object`);
    let body: string;
    if (obj.type === "tag") {
      const tag = parseTag(obj.data);
      body = `
<table class='commit-info'>
<tr><th>tag name</th><td>${esc(tag.tag || name)}</td></tr>
${tag.tagger ? `<tr><th>tag date</th><td>${fmtDate(tag.tagger.time, tag.tagger.tz)}</td></tr><tr><th>tagged by</th><td>${esc(tag.tagger.name)} &lt;${esc(tag.tagger.email)}&gt;</td></tr>` : ""}
<tr><th>tagged object</th><td class='sha1'><a href='${r}/commit/?id=${tag.object}'>${tag.object}</a> (${esc(tag.type)})</td></tr>
<tr><th>download</th><td class='sha1'><a href='${r}/snapshot/${encodeURIComponent(repoBase(repo))}-${encodeURIComponent(name)}.tar.gz'>${esc(repoBase(repo))}-${esc(name)}.tar.gz</a> <a href='${r}/snapshot/${encodeURIComponent(repoBase(repo))}-${encodeURIComponent(name)}.zip'>zip</a></td></tr>
</table>
<div class='commit-msg'>${esc(tag.message.trim())}</div>`;
    } else {
      body = `
<table class='commit-info'>
<tr><th>tag name</th><td>${esc(name)}</td></tr>
<tr><th>tagged object</th><td class='sha1'><a href='${r}/commit/?id=${target}'>${target}</a> (lightweight)</td></tr>
</table>`;
    }
    return htmlResponse(layout({ ...base, body }));
  }

  private async snapshotPage(repo: string, filename: string, gate?: ReadGate): Promise<Response> {
    let format: "tar.gz" | "zip";
    let stem: string;
    if (filename.endsWith(".tar.gz")) {
      format = "tar.gz";
      stem = filename.slice(0, -7);
    } else if (filename.endsWith(".tgz")) {
      format = "tar.gz";
      stem = filename.slice(0, -4);
    } else if (filename.endsWith(".zip")) {
      format = "zip";
      stem = filename.slice(0, -4);
    } else {
      return new Response("unsupported snapshot format (use .tar.gz or .zip)\n", { status: 400 });
    }
    // cgit-style: reponame-ref.tar.gz; also accept a bare ref and a v-prefix
    const candidates = [stem];
    const base = repoBase(repo); // snapshot filenames carry the last name segment
    if (stem.startsWith(`${base}-`)) candidates.push(stem.slice(base.length + 1));
    for (const c of [...candidates]) candidates.push(`v${c}`);
    let commit: { oid: string; commit: Commit } | null = null;
    for (const cand of candidates) {
      const rr = await this.resolveRef(cand, gate);
      if (rr) {
        commit = await this.peelToCommit(rr.oid, gate);
        if (commit) break;
      }
    }
    if (!commit) return new Response(`no ref matches snapshot name: ${stem}\n`, { status: 404 });

    const flat = new Map<string, { oid: string; mode: string }>();
    await this.flattenTree(commit.commit.tree, "", flat, gate);
    const files: SnapshotFile[] = [];
    let total = 0;
    for (const [path, info] of flat) {
      // under the page's content lease this read cannot name a reclaimed pack
      // (the lease blocks the RETIRED→RECLAIMABLE flip), so the missing-object
      // skip below is reachable only for genuinely broken refs — never as the
      // silent partial-archive a mid-render GC delete used to be able to
      // produce (the M3.2 record's known gap)
      const obj = await this.store.get(info.oid, gate);
      if (!obj) continue;
      total += obj.data.length;
      if (total > MAX_SNAPSHOT_BYTES) {
        return new Response("snapshot too large\n", { status: 413 });
      }
      const m = parseInt(info.mode, 8);
      files.push({
        path,
        mode: m & 0o100 ? 0o755 : 0o644,
        symlink: (m & 0o170000) === 0o120000,
        data: obj.data,
      });
    }
    const archive = format === "tar.gz"
      ? tarGz(stem, files, commit.commit.committer.time)
      : zip(stem, files, commit.commit.committer.time);
    return new Response(archive as unknown as BodyInit, {
      headers: {
        "content-type": format === "tar.gz" ? "application/gzip" : "application/zip",
        "content-disposition": `attachment; filename="${filename.replaceAll('"', "")}"`,
      },
    });
  }

  private async atomPage(repo: string, host: string, proto: string, h: string | undefined, gate?: ReadGate): Promise<Response> {
    const rr = await this.resolveRef(h, gate);
    if (!rr) return new Response("empty repository\n", { status: 404 });
    const { entries } = await this.walkLog(rr.oid, 0, 20, {}, gate);
    const abs = `${proto}://${host}/${repoUrl(repo)}`;
    const iso = (t: number) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z");
    const updated = entries[0] ? iso(entries[0].commit.committer.time) : iso(0);
    const items = entries
      .map(
        (e) => `<entry>
<title>${esc(e.commit.subject)}</title>
<updated>${iso(e.commit.committer.time)}</updated>
<author><name>${esc(e.commit.author.name)}</name><email>${esc(e.commit.author.email)}</email></author>
<published>${iso(e.commit.author.time)}</published>
<link rel='alternate' type='text/html' href='${abs}/commit/?id=${e.oid}'/>
<id>urn:sha1:${e.oid}</id>
<content type='text'>${esc(e.commit.message)}</content>
</entry>`
      )
      .join("\n");
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns='http://www.w3.org/2005/Atom'>
<title>${esc(repo)}</title>
<subtitle>${esc(this.store.getMeta("description") ?? "")}</subtitle>
<id>${abs}/</id>
<link rel='self' href='${abs}/atom/'/>
<link rel='alternate' type='text/html' href='${abs}/'/>
<updated>${updated}</updated>
${items}
</feed>`;
    return new Response(xml, { headers: { "content-type": "application/atom+xml; charset=utf-8" } });
  }

  /**
   * Commit-activity aggregation for a fixed (tip commit oid, period) pair.
   * History under an immutable commit oid never changes, so a cache hit
   * needs no version check — only the pair itself as key.
   */
  private async computeStats(
    tipOid: string,
    period: string,
    gate?: ReadGate
  ): Promise<{ periodKeys: string[]; authors: { name: string; counts: Record<string, number> }[]; totals: Record<string, number>; count: number }> {
    const cached = this.store.getStatsCache(tipOid, period);
    if (cached) return JSON.parse(cached);
    const { entries } = await this.walkLog(tipOid, 0, MAX_STATS_SCAN, {}, gate);
    const keyOf = (t: number): string => {
      const d = new Date(t * 1000);
      if (period === "y") return String(d.getUTCFullYear());
      if (period === "w") {
        const onejan = Date.UTC(d.getUTCFullYear(), 0, 1);
        const week = Math.ceil(((d.getTime() - onejan) / 86400000 + 1) / 7);
        return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
      }
      if (period === "q") return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    const periodKeys: string[] = [];
    const authorOrder: string[] = [];
    const byAuthor = new Map<string, Record<string, number>>();
    const totals: Record<string, number> = {};
    for (const e of entries) {
      const key = keyOf(e.commit.committer.time);
      if (!periodKeys.includes(key)) periodKeys.push(key);
      const author = e.commit.author.name || "(unknown)";
      if (!byAuthor.has(author)) {
        byAuthor.set(author, {});
        authorOrder.push(author);
      }
      const m = byAuthor.get(author)!;
      m[key] = (m[key] ?? 0) + 1;
      totals[key] = (totals[key] ?? 0) + 1;
    }
    const result = {
      periodKeys,
      authors: authorOrder.map((name) => ({ name, counts: byAuthor.get(name)! })),
      totals,
      count: entries.length,
    };
    this.store.setStatsCache(tipOid, period, JSON.stringify(result));
    return result;
  }

  private async statsPage(repo: string, h: string | undefined, period: string, gate?: ReadGate): Promise<Response> {
    const r = `/${repoUrl(repo)}`;
    const base = await this.base(repo, "stats", h, `${r}/stats/`, gate);
    const rr = await this.resolveRef(h, gate);
    if (!rr) return errorPage(base, "empty repository");
    const agg = await this.computeStats(rr.oid, period, gate);

    const cols = agg.periodKeys.slice(0, 8);
    const authors = agg.authors
      .map((a) => ({ name: a.name, m: a.counts, total: Object.values(a.counts).reduce((x, y) => x + y, 0) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 20);
    const periodLinks = [
      ["w", "week"],
      ["m", "month"],
      ["q", "quarter"],
      ["y", "year"],
    ]
      .map(([p, label]) =>
        p === period
          ? `<strong>${label}</strong>`
          : `<a href='?${h ? `h=${encodeURIComponent(h)}&` : ""}period=${p}'>${label}</a>`
      )
      .join(" | ");
    const rows = authors
      .map(
        (a) =>
          `<tr><td class='name'>${esc(a.name)}</td>` +
          cols.map((k) => `<td>${a.m[k] ?? ""}</td>`).join("") +
          `<td><strong>${a.total}</strong></td></tr>`
      )
      .join("");
    const totalRow =
      `<tr><td class='name'><strong>Total</strong></td>` +
      cols.map((k) => `<td><strong>${agg.totals[k] ?? 0}</strong></td>`).join("") +
      `<td><strong>${agg.count}</strong></td></tr>`;
    const body = `
<div>Commits per author per ${period === "w" ? "week" : period === "y" ? "year" : period === "q" ? "quarter" : "month"} (${periodLinks})${agg.count >= MAX_STATS_SCAN ? ` &mdash; last ${MAX_STATS_SCAN} commits` : ""}</div>
<table class='stats'>
<tr><th>Author</th>${cols.map((k) => `<th>${esc(k)}</th>`).join("")}<th>Total</th></tr>
${rows}
${totalRow}
</table>`;
    return htmlResponse(layout({ ...base, body }));
  }
}

/**
 * Reject an oversized body from its declared length, before a byte of it is
 * read. content-length is advisory (chunked and gzipped bodies under-report or
 * omit it), so this is the cheap first gate only — the in-stream ingest cap and
 * the bounded gunzip still have to hold for everything that gets past it.
 *
 * Shared with mod.ts's Worker-side receive flow (SPEC-0001a §3 Step 1).
 */
export function overDeclaredLength(req: Request, maxBytes: number): boolean {
  const declared = parseInt(req.headers.get("content-length") ?? "", 10);
  return Number.isFinite(declared) && declared > maxBytes;
}

export function tooLargeResponse(maxBytes: number): Response {
  const mb = Math.round(maxBytes / (1024 * 1024));
  return new Response(`error: request body exceeds the ${mb} MiB limit for this server\n`, {
    status: 413,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function renderHunk(hk: Hunk): string {
  let html = `<div class='hunk'>@@ -${hk.aStart},${hk.aLen} +${hk.bStart},${hk.bLen} @@</div>`;
  for (const op of hk.ops) {
    const cls = op.tag === "add" ? "add" : op.tag === "del" ? "del" : "ctx";
    const sign = op.tag === "add" ? "+" : op.tag === "del" ? "-" : " ";
    html += `<div class='${cls}'>${sign}${esc(op.line) || " "}</div>`;
  }
  return html;
}

function rawBlobResponse(data: Uint8Array, name: string): Response {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const types: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    svg: "text/plain; charset=utf-8", pdf: "application/pdf", html: "text/plain",
  };
  // hasOwn: ext is attacker-named, and a bare index would reach prototype
  // members for names like "constructor"
  const ct = (Object.hasOwn(types, ext) ? types[ext] : undefined) ?? (isBinary(data) ? "application/octet-stream" : "text/plain; charset=utf-8");
  return new Response(data as unknown as BodyInit, {
    headers: {
      "content-type": ct,
      "x-content-type-options": "nosniff",
      "content-disposition": "inline",
    },
  });
}

function commitJson(oid: string, c: Commit): CommitJson {
  return {
    oid,
    tree: c.tree,
    parents: c.parents,
    author: c.author,
    committer: c.committer,
    subject: c.subject,
    message: c.message,
  };
}

function decodePath(p: string): string[] {
  return p
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => decodeURIComponent(s))
    .filter((s) => s !== "." && s !== "..");
}
