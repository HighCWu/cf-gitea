/**
 * The LFS resolve chain behind the API media arm and the web file-view arm
 * (ledger ⑳ L2/L3): upstream's API `GetRawFileOrLFS`
 * (routers/api/v1/repo/file.go:154-201) and the web `getFileReader`
 * (routers/web/repo/view.go:72-123) share one chain — probe the GIT blob's
 * first `lfs.MetaFileMaxSize` bytes for a pointer, read the `lfs_objects`
 * meta row (GetLFSMetaObjectByOid, file.go:170), then open the stored
 * object. This module is that chain in ONE copy beside read.ts; the landed
 * web /media arm (ui/pages/raw-files.ts loadMediaBlob) predates it and keeps
 * its own loader (the read-only template — untouched by this wave).
 *
 * The callers split at the LAST step exactly like upstream: the API arm takes
 * the ServeDirect-or-relay posture (file.go:186-192 — `store.presignGet`
 * mints the redirect first, the relayed object streams), while the file view
 * always reads bytes through the local store (view.go:113-117's
 * ReadMetaObject — the view arm never redirects) and passes `presign: false`.
 */

import type { LfsPointer } from "./pointer";
import { parsePointer, PointerTooLargeError, POINTER_MAX_BYTES } from "./pointer";
import { getLfsMetaObject } from "./read";
import { lfsKey, type LfsStore } from "./store";

/** The store read's answer — the R2ObjectBody the relay arms stream. */
type LfsStoreObject = Exclude<Awaited<ReturnType<LfsStore["get"]>>, null>;

/** One resolved LFS file: the pointer, the meta row, and the store outcome. */
export interface LfsResolvedFile {
  /** The parsed pointer (the probe's verdict). */
  pointer: LfsPointer;
  /** The repo's meta row — `size` is upstream's blobOrLfsSize (view.go:118),
   *  `updatedAt` the ETag gate's Last-Modified (file.go:182). */
  meta: { oid: string; size: number; updatedAt: Date };
  /** The ServeDirect posture's redirect target (file.go:186-190); null in
   *  relay posture — the landed defaultLfsDeps store presigns only when LFS_STORE_PRESIGN arms the store (the L14 config wave). */
  href: string | null;
  /** The relayed object (stream + size + upload time). Null when presigned,
   *  or in the row-without-bytes race (the callers' graceful arms — the
   *  landed template degrades to the plain blob where upstream 500s). */
  object: LfsStoreObject | null;
}

export interface LfsResolveDeps {
  /** D1 — the `lfs_objects` meta read (getLfsMetaObject, read.ts). */
  d1: D1Database;
  /** The content store (createLfsStore / defaultLfsDeps' member). */
  store: LfsStore;
}

/**
 * The shared probe → row → read chain. Returns null when the blob is NOT an
 * LFS file from this repo's perspective — a non-pointer, a MALFORMED pointer
 * (upstream's `IsValid() == false` arm, file.go:161-166), or a valid pointer
 * whose meta row is missing (file.go:170-175 / view.go:104-110 — serve the
 * pointer bytes, keep the badge). A store failure surfaces as `object: null`
 * rather than a throw (the graceful arm).
 */
export async function resolveLfsFile(
  deps: LfsResolveDeps,
  input: { repoId: number; storageKey: string; blobData: Uint8Array },
  options: {
    presign?: boolean;
    /** Signed into the presigned GET's `response-content-disposition` — the
     *  caller's filename decoration, rendered with the shared
     *  `contentDisposition(name, "inline")` shape. Upstream builds the URL in
     *  the API CALLER too (file.go:186-190's ServeDirectURL carries
     *  blob.Name(); the shared chain and the web view arm never redirect), so
     *  the chain stays disposition-blind when the option is absent. */
    responseContentDisposition?: string;
  } = {},
): Promise<LfsResolvedFile | null> {
  // The probe window — `lfs.MetaFileMaxSize` bytes of the GIT blob
  // (file.go:154's GetBlobBytes cap; view.go:96-98's prefetchSize). The slice
  // happens BEFORE the parse, so PointerTooLargeError cannot fire.
  const probe = input.blobData.subarray(0, Math.min(input.blobData.byteLength, POINTER_MAX_BYTES));
  if (probe.byteLength === 0) return null;
  const pointer = (() => {
    try {
      return parsePointer(probe, { strict: false });
    } catch (error) {
      if (error instanceof PointerTooLargeError) throw error; // unreachable — the probe slices
      return null; // InvalidPointerError — the malformed-pointer fall-through
    }
  })();
  if (pointer === null) return null;

  const row = await getLfsMetaObject(deps.d1, input.repoId, pointer.oid);
  if (row === null) return null;

  const meta = { oid: row.oid, size: row.size, updatedAt: row.updatedAt };
  const key = lfsKey(input.storageKey, pointer.oid);
  if (options.presign !== false) {
    // The ServeDirect arm sits BEFORE the read (file.go:186-192) — a signed
    // URL answers the redirect and no bytes are opened. The caller's
    // disposition rides the URL (file.go:186-190 passes blob.Name() through
    // ServeDirectURL → prepareServeDirectOptions' response-content-disposition).
    const href = await deps.store.presignGet({
      key,
      ...(options.responseContentDisposition !== undefined
        ? { responseContentDisposition: options.responseContentDisposition }
        : {}),
    });
    if (href !== null) return { pointer, meta, href: href.href, object: null };
  }
  const object = await deps.store.get(key);
  return { pointer, meta, href: null, object };
}
