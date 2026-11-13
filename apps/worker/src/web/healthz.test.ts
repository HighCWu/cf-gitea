/**
 * The health-check endpoint unit battery (src/web/healthz.ts — B-74, the
 * healthcheck.Check port, check.go:63-84). The live /api/healthz shape runs
 * through src/index.test.ts's SELF battery; this file pins the pieces that
 * need fault injection (the D1 fail arm — workerd's local D1 cannot be made
 * to fail through the real binding) and the status-code mapping.
 */

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { healthzHandler, healthzHttpStatus, healthzPayload } from "./healthz";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe("healthzHttpStatus (status.ToHTTPStatus, check.go:33-36)", () => {
  it("maps pass/warn to 200 and fail to 424", () => {
    expect(healthzHttpStatus("pass")).toBe(200);
    expect(healthzHttpStatus("warn")).toBe(200);
    expect(healthzHttpStatus("fail")).toBe(424); // http.StatusFailedDependency
  });
});

describe("healthzPayload", () => {
  it("passes with the database:ping component over the real D1", async () => {
    const payload = await healthzPayload(env.DB);
    expect(payload.status).toBe("pass");
    expect(payload.description).toBe("Gitea");
    const pings = payload.checks?.["database:ping"];
    expect(pings).toHaveLength(1);
    expect(pings?.[0]?.status).toBe("pass");
    expect(pings?.[0]?.output).toBeUndefined();
    expect(Object.keys(payload.checks ?? {})).toEqual(["database:ping"]); // the cache PLATFORM reduction
  });

  it("fails with the error text as output when the D1 ping throws", async () => {
    const broken = {
      prepare: () => {
        throw new Error("database is down");
      },
    } as unknown as D1Database;
    const payload = await healthzPayload(broken);
    expect(payload.status).toBe("fail");
    const pings = payload.checks?.["database:ping"];
    expect(pings?.[0]?.status).toBe("fail");
    // drizzle wraps the driver throw ("Failed to run the query '…'") — the
    // surfaced text still names the failed probe.
    expect(pings?.[0]?.output).toContain("SELECT 1");
    expect(healthzHttpStatus(payload.status)).toBe(424);
  });
});

describe("healthzHandler", () => {
  it("renders the fail posture: 424, the exact content type, the output field present", async () => {
    const broken = {
      prepare: () => {
        throw new Error("no such table");
      },
    } as unknown as D1Database;
    const c = {
      env: { DB: broken },
      body: (text: string, status?: number, headers?: Record<string, string>) =>
        new Response(text, { status, headers }),
    } as unknown as Parameters<ReturnType<typeof healthzHandler>>[0];
    const response = await healthzHandler()(c);
    expect(response.status).toBe(424);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = await response.json<{
      status: string;
      checks: Record<string, Array<{ status: string; output?: string }>>;
    }>();
    expect(body.status).toBe("fail");
    expect(body.checks["database:ping"]?.[0]?.output).toContain("SELECT 1"); // drizzle's wrapped throw text
  });
});
