/**
 * The single R2 key builder (SPEC-0001 §3 layout, SPEC-0001a §3 Step 3).
 *
 * EVERY R2 key the engine constructs or resolves goes through this module —
 * receive staging, stored packs, idx sidecars, the full-clone cache, and the
 * delete-time prefix purge. A construction site that formats its own key
 * silently forks the namespace; the delete purge would then strand bytes.
 *
 * Layout (SPEC-0001 §3):
 *
 *   repos/<storage_key>/packs/<packName>.pack              verbatim stored pack
 *   repos/<storage_key>/packs/<packName>.idx               idx v2 sidecar
 *   repos/<storage_key>/staging/pack-rx-<leaseToken>.pack  in-flight receive
 *   repos/<storage_key>/clone-cache/<refsVersionHash>.pack whole-clone cache
 *
 * `<storage_key>` is the immutable D1-minted key (r_<id>) so renames never
 * touch storage. Until SPEC-0003 supplies it, the persisted repo name doubles
 * as the storage key (meta.storage_key backfills from meta.repo; see
 * control-plane.ts for the Worker→DO contract).
 *
 * `<packName>` = pack-<packSha1>: the pack's own trailer hash, deterministic,
 * so an identical repack dedupes to the same object name. The pack_catalog
 * sequence (meta `next_pack_seq`) orders the CATALOG, never the R2 name.
 */

/** A storage key segment: repo names today, r_<id> once SPEC-0003 lands. */
const STORAGE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `key` is a usable storage key segment (no "/" or ".." tricks). */
export function isValidStorageKey(key: string): boolean {
  return STORAGE_KEY_RE.test(key) && !key.includes("..");
}

/** `pack-<packSha1>` — the pack catalog's primary key and R2 object stem. */
export function packName(packSha1: string): string {
  return `pack-${packSha1}`;
}

/** `repos/<storage_key>/` — the one prefix a repo's delete purge walks. */
export function repoPrefix(storageKey: string): string {
  return `repos/${storageKey}/`;
}

/** `repos/<storage_key>/staging/pack-rx-<leaseToken>.pack` (receive input). */
export function stagingKey(storageKey: string, leaseToken: string): string {
  return `repos/${storageKey}/staging/pack-rx-${leaseToken}.pack`;
}

/** `repos/<storage_key>/packs/<packName>.pack` (verbatim stored pack). */
export function packR2Key(storageKey: string, name: string): string {
  return `repos/${storageKey}/packs/${name}.pack`;
}

/** `repos/<storage_key>/packs/<packName>.idx` (idx v2 sidecar). */
export function idxR2Key(storageKey: string, name: string): string {
  return `repos/${storageKey}/packs/${name}.idx`;
}

/**
 * `repos/<storage_key>/clone-cache/<refsVersionHash>.pack` — the whole-clone
 * cache object. `refsVersionHash` is a hash over the current ref state (the
 * store's reachableVersion(): every ref tip + HEAD folded through SHA-1), so
 * the key changes on every push and a stale/force-pushed pack is never named.
 */
export function cloneCacheKey(storageKey: string, refsVersionHash: string): string {
  return `repos/${storageKey}/clone-cache/${refsVersionHash}.pack`;
}

/**
 * `repos/<storage_key>/clone-cache/` — the listing prefix the GC drain walks
 * (M3.4). The write-side constructor above stays the only way an object key
 * is BUILT; this is its listing dual, so the namespace keeps one definition.
 */
export function cloneCachePrefix(storageKey: string): string {
  return `repos/${storageKey}/clone-cache/`;
}

/**
 * The refs-version hash a clone-cache object key serves — null when `key` is
 * not a clone-cache object shape. The GC drain (M3.4) compares it against the
 * current reachableVersion() to decide whether the entry is still hot; any
 * key that does not parse is foreign and is never touched.
 */
export function cloneCacheVersionOf(key: string): string | null {
  const m = /^repos\/[^/]+\/clone-cache\/([0-9a-f]{40})\.pack$/.exec(key);
  return m ? m[1] : null;
}
