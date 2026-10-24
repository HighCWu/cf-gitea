/**
 * Test-rig sanity check for the SPEC-0002 suite: the injected migration
 * binding plus a top-level `beforeAll` application must yield the auth
 * schema on real D1, with per-test storage isolation keeping rows from
 * leaking between tests.
 */

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { TokenService } from "./token-service";
import { applyAuthD1Migrations } from "./testing/apply-d1-migrations";

beforeAll(applyAuthD1Migrations);

describe("test rig", () => {
  it("has the migrations binding injected and the auth schema applied", async () => {
    expect(env.TEST_MIGRATIONS.length).toBeGreaterThan(0);
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{
      name: string;
    }>();
    const names = tables.results.map((row) => row.name);
    for (const table of ["users", "personal_access_tokens", "auth_failures", "repositories"]) {
      expect(names).toContain(table);
    }
  });

  it("keeps schema across tests while isolating rows", async () => {
    // Schema survived from the previous test's database state, but rows do
    // not leak (per-test isolation).
    const service = new TokenService(env.DB);
    const { total } = await service.list(1, 1, 10);
    expect(total).toBe(0);
  });
});
