/**
 * The PERFTRACE/PPROF ARM (SPEC-0021 §4) — the Cloudflare-native adapter
 * over the official Workers profiling API, replacing the recorded "the
 * perftrace tab is dev-only AND source-less" reduction (the freeze,
 * 2026-11-01): a profile IS triggerable through the platform — the admin
 * page offers the bounded trigger and streams the .pprof.gz back as the
 * download; perftrace (REQUEST tracing) stays a SEPARATE section stating the
 * enabled posture honestly (Workers Traces have NO query API — dashboards,
 * wrangler tail, OTel/Logpush export only; verified live 2026-11-01,
 * developers.cloudflare.com/workers/observability/traces/), never a
 * fabricated query arm.
 *
 * ## Verified API shape (live docs, 2026-11-01)
 *
 *   POST /accounts/{account_id}/workers/workers/{worker_id}/versions/{version_id}/profile
 *   body {duration_ms: 1000..50000 required, profile_type: "cpu"(default)|"heap"}
 *   → 200 with a GZIPPED PPROF FILE (binary — NOT the JSON envelope);
 *     429 rate-limited (Retry-After honored, bounded retries);
 *     4xx/5xx error bodies are envelope JSON.
 *   `version_id` accepts "latest" — "the most recently created version, not
 *   necessarily a deployed one" — so callers pass the SERVING version from
 *   the deployments read (platform.ts readLatestDeployment) when they have
 *   one; "latest" is the documented fallback.
 *   Token: CLOUDFLARE_PROFILE_TOKEN (Workers Scripts Read).
 *
 * ## Content validation split (the freeze's verification split)
 *
 *   - THIS module (in-worker): size bounds + the gzip magic (1f 8b) — a
 *     wrong-shaped download is refused before it reaches the admin; the
 *     binary itself is NEVER logged (byte counts only).
 *   - The DEPLOY-PROBE battery (scripts/deploy-probes.mjs monitor-platform)
 *     owns the DEEP content validation: gunzip → the pprof protobuf parses
 *     → type/sampling sane — the REAL-API closed loop that flips the
 *     implementation-status wording (集成待验证 → 已实现, SPEC-0021 §6).
 *     Duplicating the protobuf reader in-worker would double the surface for
 *     zero admin value: the worker's contract to the admin is "a gzipped
 *     pprof from the platform", the probe's contract is "the bytes PARSE".
 *
 * ## Upstream posture (trace_tabs.tmpl + diagnosis.go)
 *
 *   The perftrace tab is `!setting.IsProd` upstream (stacktrace.go:19); the
 *   diagnosis form GETs /-/admin/monitor/diagnosis with a `seconds` field
 *   (clamped 1..300) and streams a ZIP. Ours: the profile form GETs
 *   /-/admin/monitor/profile (GET-with-effect is upstream's own posture —
 *   MonitorDiagnosis is a GET), `seconds` clamped to the PLATFORM's bounds
 *   (1..50 s — duration_ms 1000..50000), and the download is the platform's
 *   gzipped pprof (type-prefixed filename); the diagnosis report renders the
 *   composite page instead of the zip (documented divergence, SPEC-0021 §5).
 */

import { cfApiBinaryRequest, type FetchImpl } from "./platform";

export type ProfileType = "cpu" | "heap";

/** The platform's validated duration_ms bounds (live docs, 2026-11-01). */
export const PROFILE_DURATION_MS_MIN = 1000;
export const PROFILE_DURATION_MS_MAX = 50000;

/** The download's size cap (the probe battery's cap mirrored): a profile
 *  above this is refused (an unbounded body never buffers — AGENTS.md
 *  Workers rules). The observed cpu-profile order of magnitude is tens of
 *  KiB; 20 MiB is ~1000x headroom, far under the Workers memory ceiling. */
export const PROFILE_MAX_BYTES = 20 * 1024 * 1024;

/** The parsed profile trigger params (the trace page's form): `seconds` is
 *  upstream's field name; the platform bounds apply. null = the failed
 *  binding (never a guessed default — a wrong duration would silently
 *  profile the wrong window). */
export function parseMonitorProfileParams(params: URLSearchParams): { type: ProfileType; durationMs: number } | null {
  const secondsRaw = params.get("seconds") ?? params.get("duration_ms");
  if (secondsRaw === null) return null;
  const typeRaw = params.get("type") ?? "cpu";
  if (typeRaw !== "cpu" && typeRaw !== "heap") return null;
  const seconds = Number.parseInt(secondsRaw.trim(), 10);
  if (!Number.isFinite(seconds) || String(seconds) !== secondsRaw.trim()) return null;
  const durationMs = seconds * 1000;
  if (durationMs < PROFILE_DURATION_MS_MIN || durationMs > PROFILE_DURATION_MS_MAX) return null;
  return { type: typeRaw, durationMs };
}

/** The download filename (upstream's gitea-diagnosis-<ts> shape, adapted:
 *  type-prefixed so a cpu and a heap capture never collide on disk). */
export function profileFilename(type: ProfileType, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `cf-gitea-profile-${type}-${stamp}.pprof.gz`;
}

/** The gzip magic (RFC 1952: ID1=0x1f ID2=0x8b). */
function isGzipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** The profile trigger's outcome — the ok arm carries the VERIFIED gzipped
 *  bytes (bounded, magic-checked); the failure kinds are the frozen
 *  taxonomy plus invalid-response (a 200 whose body is not a gzip stream —
 *  the platform misbehaving, never passed through to the admin). */
export type ProfileOutcome =
  | { kind: "ok"; bytes: Uint8Array; byteLength: number; type: ProfileType; durationMs: number }
  | { kind: "unconfigured" }
  | { kind: "auth"; status: number; message: string }
  | { kind: "rate-limited"; retryAfterMs: number | null; attempts: number }
  | { kind: "platform-unavailable"; status: number | null; message: string }
  | { kind: "invalid-response"; message: string };

/** POST the profile request and return the verified gzipped pprof bytes.
 *  `versionId` defaults to the documented "latest" fallback; pass the
 *  deployments read's serving version when available. The binary is NEVER
 *  logged — outcomes carry byte counts and messages only. */
export async function requestWorkerProfile(options: {
  accountId: string;
  apiToken: string | undefined;
  workerName: string;
  versionId?: string;
  type: ProfileType;
  durationMs: number;
  fetchImpl?: FetchImpl;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<ProfileOutcome> {
  const versionId = options.versionId && options.versionId.trim() !== "" ? options.versionId.trim() : "latest";
  const outcome = await cfApiBinaryRequest({
    apiToken: options.apiToken,
    method: "POST",
    url:
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}` +
      `/workers/workers/${encodeURIComponent(options.workerName)}` +
      `/versions/${encodeURIComponent(versionId)}/profile`,
    body: JSON.stringify({ duration_ms: options.durationMs, profile_type: options.type }),
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });
  if (outcome.kind === "unconfigured") return { kind: "unconfigured" };
  if (outcome.kind === "auth") {
    return { kind: "auth", status: outcome.status, message: outcome.errors.map((e) => e.message).join("; ").slice(0, 200) };
  }
  if (outcome.kind === "rate-limited") {
    return { kind: "rate-limited", retryAfterMs: outcome.retryAfterMs, attempts: outcome.attempts };
  }
  if (outcome.kind !== "ok") {
    if (outcome.kind === "bad-request" || outcome.kind === "not-found") {
      // A 400/404 is the platform refusing the request shape/id — its own
      // taxonomy class (fail), never "platform unsupported".
      return { kind: "platform-unavailable", status: outcome.status, message: outcome.errors.map((e) => e.message).join("; ").slice(0, 200) };
    }
    return { kind: "platform-unavailable", status: outcome.status, message: outcome.message };
  }
  const res = outcome.result;
  // Bounded read: the content-length gate first, then the buffered read is
  // capped (a lying content-length cannot balloon the buffer past the cap
  // without streaming more than cap bytes — slice defensively anyway).
  const declaredLength = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > PROFILE_MAX_BYTES) {
    return { kind: "invalid-response", message: `profile exceeds the size cap (${declaredLength} bytes declared > ${PROFILE_MAX_BYTES})` };
  }
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.length > PROFILE_MAX_BYTES) {
    return { kind: "invalid-response", message: `profile exceeds the size cap (${bytes.length} bytes > ${PROFILE_MAX_BYTES})` };
  }
  if (bytes.length === 0) {
    return { kind: "invalid-response", message: "the platform answered 200 with an EMPTY body (a profile is never empty)" };
  }
  if (!isGzipMagic(bytes)) {
    return { kind: "invalid-response", message: `the response is not a gzip stream (first bytes ${bytes[0]}, ${bytes.length === 1 ? "<end>" : bytes[1]})` };
  }
  return { kind: "ok", bytes, byteLength: bytes.length, type: options.type, durationMs: options.durationMs };
}
