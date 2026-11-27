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
  /** Wall-clock budget for one receive's indexing phase (staged-pack scan +
   * delta resolution + connectivity check + idx write), in MILLISECONDS
   * (default 600000 — 10 minutes, strictly inside GIT_TIMEOUT_RECEIVE's 900s
   * so a breached deadline releases the lease through the unpack-ng path
   * before the TTL sweep would). The wall-clock race bounds the receive-walk
   * grind shape: a delta resolution that keeps consuming ODB round trips and
   * R2 range reads past the budget fails the push with an explicit ng line
   * ("unpack: receive indexing deadline exceeded") and turns the push slot
   * over, instead of holding the lease silently until the TTL. A legitimately
   * slow receive (a very large windowed push against a deep object database)
   * needs this raised together with RANGE_BUDGET; the deadline is
   * wall-clock, not CPU, so idle I/O waits consume it like work. Floor/ceiling:
   * [1000, 86400000] ms. Unset/garbage keeps the default. */
  GIT_RECEIVE_DEADLINE_MS?: string;
  /** Cadence of the streaming receive answer's keepalive heartbeat, in
   * MILLISECONDS (SPEC 0230; default 20000). Once a side-band-64k push's
   * pack body is fully staged, the answer streams, and an idle-gated
   * interval timer emits git's official `receive.keepAlive` packet — the
   * five-byte zero-data band-1 frame `0005\x01` — whenever processing
   * produces no other frame, so an edge path never judges the long indexing
   * phase a silent/dead answer. The official idle-gate semantics apply: a
   * tick that already saw a milestone/progress frame stays silent, so the
   * heartbeat never doubles a busy stretch. The default keeps the proposal's
   * hard constraint (interval x 2 below the observed ~60s answer-silence cap
   * floor) with margin; the clamp window is [50, 30000] ms — the ceiling
   * keeps that constraint true for every deployable value, the floor exists
   * for protocol-timing test batteries. Unset/garbage keeps the default. No
   * effect on non-sideband pushes (their buffered answer never heartbeats). */
  GIT_RECEIVE_KEEPALIVE_MS?: string;
  /** Cadence of the upload-pack answer's keepalive heartbeat in MILLISECONDS
   * (SPEC-0024 M4.0; default 20000, clamped [50, 30000]). Emits Git's
   * official `uploadpack.keepAlive` five-byte zero-data band-1 frame
   * `0005\x01` while server-side planning or R2 reads stall without output. */
  GIT_UPLOAD_KEEPALIVE_MS?: string;
  /** Strict-polarity flag ("true" enables) shifting warm full-clone uploadPack
   * streams from 1 MiB DO Range GETs to sequential Worker-side R2 streams and
   * zero-copy single-pack passthrough (SPEC-0024 M4.0). Unset/anything else
   * keeps the legacy DO path. */
  UPLOAD_PACK_WORKER_STREAM?: string;
  /** Minimum total R2 pack bytes that routes a cold full clone (before SQLite
   * `reachable` is warmed) onto Worker streaming (`worker-cold-stream`,
   * SPEC-0024 M4.4; default `8388608` = 8 MiB, or >= 8 active packs). */
  WORKER_COLD_CLONE_MIN_BYTES?: string;
  /** Strict-polarity flag ("true" enables) routing multi-pack compaction from
   * the 32 MiB DO-heap merge to Worker/Queue streaming compaction + OFS_DELTA +
   * `.pref` sidecars (SPEC-0024 M4.1). */
  COMPACTION_QUEUE_ENABLED?: string;
  /** Strict-polarity flag ("true" enables) streaming receivePack bytes directly
   * to the final R2 pack key (`packs/pack-rx-<leaseToken>.pack`) using 64 MiB
   * multipart parts, eliminating `copyObject` double R2 writes (SPEC-0024 M4.2). */
  RECEIVE_DIRECT_PACK_WRITE?: string;
  /** Strict-polarity flag ("true" enables) Protocol v2 `bundle-uri` advertisement,
   * bundle materialization on compaction, and signed Range download serving (SPEC-0024 M4.3). */
  BUNDLE_URI_ENABLED?: string;
  /** HMAC-SHA256 signing key for time-bounded bundle download tokens (SPEC-0024 M4.3).
   * Rotating invalidates outstanding tokens immediately. */
  BUNDLE_SIGNING_SECRET?: string;
  /** Minimum compacted pack size in bytes before materializing a `.bundle`
   * (SPEC-0024 M4.3; default `67108864` = 64 MiB). */
  BUNDLE_MIN_BYTES?: string;
  /** Signed bundle download token lifetime in seconds (SPEC-0024 M4.3; default `900`,
   * clamped `[60, 3600]`). */
  BUNDLE_TOKEN_TTL_SEC?: string;
  /** Optional Cloudflare Queue binding used by `receivePack` to enqueue
   * `{ kind: "pack-compact", repo }` when `COMPACTION_QUEUE_ENABLED === "true"`. */
  REPO_TASKS?: { send(message: unknown): Promise<unknown> };
  SITE_NAME?: string;
  SITE_DESC?: string;
  SITE_OWNER?: string;
}
