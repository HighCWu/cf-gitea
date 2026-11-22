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
  /** R2 range GETs a single receive's delta resolution may spend (default 256,
   *  receive/delta.ts RANGE_BUDGET). Raise it for windowed pushes of large
   *  repositories, whose delta chains re-read more staging bytes than the
   *  default budgets; every unit is one subrequest against the platform's
   *  per-request subrequest cap, so the raise trades cap headroom for
   *  resolution reach. */
  RANGE_BUDGET?: string;
  /** in-memory ingest cache budget in MB, holding decompressed objects for
   * delta-base resolution during a push. Misses reload from SQLite, so a
   * smaller budget trades ingest speed for peak memory. Default: 16 on real
   * Workers (hard 128MB isolate), 64 on celld (multi-GB heap). */
  INGEST_CACHE_MB?: string;
  /** "1" screens every pushed object with SHA-1DC collision detection; default
   * hashes with native crypto.subtle (identical oid, far faster) */
  SHA1DC?: string;
  /** How long one receive lease may hold a repo's push slot after its holder
   * stopped making progress, in SECONDS (default 900 — 15 minutes). Named for
   * upstream's `[git.timeout]` app.ini section (MIGRATE/MIRROR/GC, seconds):
   * upstream needs no receive key because its receive-pack is a child process
   * bound to the HTTP request context — a client disconnect kills the process
   * and git's advisory locks die with it. A DO lease has no process to die,
   * so the engine releases on the request's abort signal (the disconnect
   * fast-fail) and this TTL bounds the one case no signal can cover: a SILENT
   * client drop that delivers neither bytes, EOF, nor abort. Only
   * unexpired-but-dead holders block concurrent pushes (T7's 503), so a lower
   * value tightens the worst-case stall window; a higher one admits longer
   * unattended pushes (raise MAX_PUSH_MB's loopback transfers together).
   * Floor/ceiling: [60, 86400] s. Unset/garbage keeps the default. */
  GIT_TIMEOUT_RECEIVE?: string;
  SITE_NAME?: string;
  SITE_DESC?: string;
  SITE_OWNER?: string;
}
