import type { Registry } from "./registry";
import type { RepoCell } from "./repo";

export interface Env {
  REPO: DurableObjectNamespace<RepoCell>;
  REGISTRY: DurableObjectNamespace<Registry>;
  /** The ONE pack R2 bucket (SPEC-0001 §3, SPEC-0001a §3 Step 3 site 11):
   * receive staging, stored packs, and the full-clone cache all live under
   * `repos/<storage_key>/` in it — every key built by src/git/r2keys.ts.
   * Required for git push since Step 1 (no bucket = pushes fail). This field
   * replaces upstream's separate optional PACK_CACHE clone-cache binding
   * (removed; the unified binding is the worker's wrangler.jsonc name —
   * single source of truth per AGENTS.md). */
  REPO_PACKS?: R2Bucket;
  /** shared secret required for git push (Basic auth password) */
  GIT_TOKEN?: string;
  /** optional comma-separated extra tokens (multiple users) */
  GIT_TOKENS?: string;
  /** max accepted push size in MB (default 512) */
  MAX_PUSH_MB?: string;
  /** in-memory ingest cache budget in MB, holding decompressed objects for
   * delta-base resolution during a push. Misses reload from SQLite, so a
   * smaller budget trades ingest speed for peak memory. Default: 16 on real
   * Workers (hard 128MB isolate), 64 on celld (multi-GB heap). */
  INGEST_CACHE_MB?: string;
  /** "1" screens every pushed object with SHA-1DC collision detection; default
   * hashes with native crypto.subtle (identical oid, far faster) */
  SHA1DC?: string;
  SITE_NAME?: string;
  SITE_DESC?: string;
  SITE_OWNER?: string;
}
