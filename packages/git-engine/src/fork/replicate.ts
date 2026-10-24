/**
 * The Worker-side fork replication loop (SPEC-0001b §5.3 steps 2-4) — the
 * queue-consumer body the fork endpoint's 202 hands the work to. The engine
 * RPCs (control-plane.ts) keep pack bytes out of the DO→DO control plane;
 * THIS module is the broker that moves them:
 *
 *   fork.beginForkImport(forkStorageKey)
 *   loop: parent.listCatalogPage(cursor, rowsPerPage)
 *           → for each first-slice pack: stream the bytes into the fork's
 *             prefix — bucket.get(parentKey) → bucket.put(forkKey) for `.pack`
 *             + `.idx` (R2 has NO server-side copy on the Workers binding —
 *             verified against the pinned workers-types and the Cloudflare
 *             Workers API reference, workerd#1349 — so this is a
 *             worker-mediated streaming copy: opaque bytes, no parse, no
 *             inflate; the SPEC's §5.2 cost table holds per pack, minus the
 *             word "server-side"). location='sqlite' packs arrive with inline
 *             packData and are rehydrated with one plain put.
 *           → fork.adoptForkPacks(page)   (verifies bytes, lands rows)
 *         until page.more is false
 *   fork.finalizeForkImport(parent refs + HEAD)
 *
 * Crash-safe by idempotent re-run (§5.3): rows are keyed, copies overwrite,
 * staging is replaced; a re-run begins again at "" and converges. After a
 * finalize already committed, beginForkImport refuses (`invalid`) — the
 * consumer treats that as success.
 *
 * `parent`/`fork` are structural (RepoCell stubs satisfy them), so the same
 * body runs against real DO RPC stubs in the Worker and against the
 * control-plane functions in the engine check script.
 */
import { idxR2Key, packR2Key } from "../git/r2keys";
import type { CatalogPage } from "./types";

/** Structural parent surface the loop needs (RepoCell: listCatalogPage +
 * listRefs). */
export interface ForkSourceRepo {
  listCatalogPage(afterPackKey: string, limit: number): Promise<CatalogPage>;
  listRefs(): Promise<{ head: string | null; refs: { name: string; target: string }[] }>;
}

/** Structural fork surface (RepoCell: the three replication lease RPCs). */
export interface ForkTargetRepo {
  beginForkImport(
    storageKey: string
  ): Promise<{ tag: "ok"; storageKey: string } | { tag: "invalid"; reason: string }>;
  adoptForkPacks(page: CatalogPage): Promise<{ tag: "ok" } | { tag: "invalid"; reason: string }>;
  finalizeForkImport(input: {
    refs: { name: string; oid: string }[];
    head: string | null;
  }): Promise<{ tag: "ok"; refsVersion: string } | { tag: "invalid"; reason: string }>;
}

export interface ReplicateForkOpts {
  /** the parent's immutable storage key (D1 repositories row) — namespaces the
   * source R2 keys */
  parentStorageKey: string;
  /** the fork's new immutable storage key (D1 minted it with the fork row) */
  forkStorageKey: string;
  /** index rows per listCatalogPage page (default 8192; the engine clamps to
   * [1, FORK_PAGE_MAX_ROWS]) */
  rowsPerPage?: number;
  /** crash-injection hook for tests: called after each page is adopted */
  afterPage?: (page: CatalogPage, adoptedPages: number) => Promise<void> | void;
}

export interface ReplicateForkResult {
  /** catalog packs replicated (active rows listed) */
  packs: number;
  /** index rows landed on the fork */
  indexRows: number;
  /** refs written by the finalize */
  refs: number;
  refsVersion: string;
}

/**
 * Streamed R2→R2 copy within ONE bucket (receive's staging→packs copy uses
 * the same shape). workerd requires a length-known stream for a plain PUT, so
 * the bytes ride a FixedLengthStream when the runtime provides one; the engine
 * check script (plain Node) takes the buffered fallback. Bytes are opaque —
 * no parse, no inflate.
 */
export async function copyObject(bucket: R2Bucket, from: string, to: string): Promise<void> {
  const obj = await bucket.get(from);
  if (!obj) throw new Error(`fork copy: source object missing: ${from}`);
  if (typeof FixedLengthStream !== "undefined") {
    const fixed = new FixedLengthStream(obj.size);
    const put = bucket.put(to, fixed.readable);
    try {
      await obj.body.pipeTo(fixed.writable);
    } catch (err) {
      try {
        await put;
      } catch {
        // the destination rejects alongside the failed pipe
      }
      throw err;
    }
    await put;
  } else {
    // test/host fallback without the workers-runtime global: buffer once
    const bytes = new Uint8Array(await obj.arrayBuffer());
    await bucket.put(to, bytes);
  }
}

/**
 * Run the full replication. Throws only on transport-class failures (DO RPC,
 * R2) — application outcomes (`invalid`) throw here too, with the reason:
 * the consumer's queue retry re-runs the whole body idempotently, and a
 * deterministic `invalid` (corrupt page, missing bytes) is not survivable by
 * retrying, so surfacing it loudly is the honest behavior.
 */
export async function replicateForkCatalog(
  parent: ForkSourceRepo,
  fork: ForkTargetRepo,
  bucket: R2Bucket,
  opts: ReplicateForkOpts
): Promise<ReplicateForkResult> {
  const begin = await fork.beginForkImport(opts.forkStorageKey);
  if (begin.tag === "invalid") throw new Error(`beginForkImport: ${begin.reason}`);

  let packs = 0;
  let indexRows = 0;
  let adoptedPages = 0;
  let cursor = "";
  for (;;) {
    const page = await parent.listCatalogPage(cursor, opts.rowsPerPage ?? 8192);
    for (const p of page.packs) {
      if (p.rowsFrom !== "") continue; // continuation slice: bytes already moved
      const dstPack = packR2Key(opts.forkStorageKey, p.packKey);
      if (p.location === "r2") {
        await copyObject(bucket, packR2Key(opts.parentStorageKey, p.packKey), dstPack);
      } else if (p.packData) {
        // sqlite-location pack: the bytes rode the page (DO-local pack_data
        // rehydration) — one plain put into the fork's prefix
        await bucket.put(dstPack, p.packData);
      } else {
        throw new Error(`fork copy: sqlite pack without inline bytes: ${p.packKey}`);
      }
      if (p.idxBytes > 0) {
        await copyObject(bucket, idxR2Key(opts.parentStorageKey, p.packKey), idxR2Key(opts.forkStorageKey, p.packKey));
      }
      packs++;
    }
    await fork.adoptForkPacks(page);
    indexRows += page.packs.reduce((n, p) => n + p.rows.length, 0);
    adoptedPages++;
    await opts.afterPage?.(page, adoptedPages);
    cursor = page.nextAfter;
    if (!page.more) break;
  }

  const refsResult = await parent.listRefs();
  const fin = await fork.finalizeForkImport({
    refs: refsResult.refs.map((r) => ({ name: r.name, oid: r.target })),
    head: refsResult.head,
  });
  if (fin.tag === "invalid") throw new Error(`finalizeForkImport: ${fin.reason}`);
  return { packs, indexRows, refs: refsResult.refs.length, refsVersion: fin.refsVersion };
}
