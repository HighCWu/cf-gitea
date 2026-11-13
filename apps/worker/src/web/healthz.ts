import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";

/**
 * GET /api/healthz — the health-check endpoint (B-74), the port of upstream
 * `healthcheck.Check` (routers/web/healthcheck/check.go:63-84). Upstream
 * mounts it on BOTH servers (`/api/healthz`, web.go:295 + install
 * routes.go:36) answering the draft-inadini vocabulary (check.go:20-31):
 * `status` pass/fail/warn, `description` = setting.AppName, `checks` = the
 * object of per-component arrays (`database:ping`, `cache:ping`), rendered
 * with Go's MarshalIndent two-space form and `Content-Type: application/json`
 * (check.go:76-84); a `fail` answers 424 Failed Dependency
 * (`status.ToHTTPStatus`, check.go:33-36), pass/warn 200.
 *
 * cf-gitea adaptations (recorded in the census flip):
 *   - The legacy dispatcher route `/healthz` (`{"ok":true}`, the pre-parity
 *     shape) STAYS as an alias — scripts/deploy-smoke.mjs's checkHealthz
 *     asserts `GET /healthz -> 200 {"ok":true}` verbatim, and the redeploy
 *     probe battery must stay green; upstream itself never serves `/healthz`.
 *   - `cache:ping` is a PLATFORM reduction: the Workers deployment has no
 *     cache tier (D1 is the only downstream stateful dependency —
 *     wrangler.jsonc carries no KV/CACHE binding), so the checks object
 *     carries the `database:ping` arm only. Upstream's SQLite file-exists
 *     side-check (check.go:110-117) has no remote-D1 counterpart for the
 *     same reason.
 *   - The `checks`-omitted pre-install arm (check.go:71-73 `InstallLock`)
 *     has no surface: cf-gitea serves one worker whose D1 is bound from
 *     boot, so the endpoint always reports the installed shape.
 */

/** The check vocabulary (check.go:20-31). */
type HealthzStatus = "pass" | "fail" | "warn";

/** `componentStatus` (check.go:53-57) — `output` omitted for pass rows. */
export interface HealthzComponentStatus {
  status: HealthzStatus;
  /** The check time, RFC3339 UTC (getCheckTime, check.go:119-121). */
  time: string;
  /** SHOULD be omitted for "pass" (draft-inadini §3.1.3). */
  output?: string;
}

/** The `response` struct (check.go:38-45); `checks` omitempty pre-install —
 *  ours always carries the installed shape (module header). */
export interface HealthzPayload {
  status: HealthzStatus;
  description: string;
  checks?: Record<string, HealthzComponentStatus[]>;
}

/** setting.AppName — upstream's default "Gitea" (no APP_NAME var landed; the
 *  auth/two-factor.ts:134-136 posture, GITEA_APP_NAME in the mail templates). */
const APP_NAME = "Gitea";

/** `status.ToHTTPStatus` (check.go:33-36): pass/warn → 200, fail → 424
 *  (http.StatusFailedDependency). */
export function healthzHttpStatus(status: HealthzStatus): 200 | 424 {
  return status === "fail" ? 424 : 200;
}

/** `checkDatabase` (check.go:99-118) over D1 — an engine-level `SELECT 1`
 *  through drizzle's raw run (the D1-through-Drizzle boundary rule; the ping
 *  probes the engine like upstream's db.Ping, not a table, so a fresh
 *  pre-migration database still answers pass); any throw is the fail arm with
 *  the error text as `output` (upstream logs it and marks the component
 *  failed). */
async function pingDatabase(d1: D1Database): Promise<HealthzComponentStatus> {
  const time = new Date().toISOString();
  try {
    await drizzle(d1).run(sql`SELECT 1`);
    return { status: "pass", time };
  } catch (error) {
    return { status: "fail", time, output: error instanceof Error ? error.message : String(error) };
  }
}

/** The payload builder (Check's assembly, check.go:65-84): pass while every
 *  component passes, fail on the first non-pass (upstream breaks the loop at
 *  the first non-pass status). */
export async function healthzPayload(d1: D1Database): Promise<HealthzPayload> {
  const database = await pingDatabase(d1);
  // Key order mirrors the Go struct's marshal order (status, description,
  // checks); checks carries the database arm only — the module header's
  // PLATFORM reduction.
  return {
    status: database.status,
    description: APP_NAME,
    checks: { "database:ping": [database] },
  };
}

/** The handler — MarshalIndent's two-space body, the exact upstream content
 *  type (check.go:76-84), the status-mapped code. */
export function healthzHandler(): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const payload = await healthzPayload(c.env.DB);
    return c.body(JSON.stringify(payload, null, 2), healthzHttpStatus(payload.status), {
      "Content-Type": "application/json",
    });
  };
}
