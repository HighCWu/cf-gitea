/**
 * REDEPLOY8 regression (2026-10-25) — every API-shaped repo create must
 * register the repo in the engine Registry AT CREATE (RepoService's
 * best-effort seedRepoExtras upsert). The pre-fix wave constructed
 * RepoService bare (no `registry` dep) on the API create/fork/org/migrate
 * paths, so `seedRepoExtras` skipped its upsert: the D1 row resolved, the
 * gate authorized, and the ENGINE then 404'd "repository not found" on
 * info/refs — minutes of clone failures for a freshly created repo until
 * the first push healed the row (the gate's receive-pack arm passes the
 * dep, which is why push-create never had the bug).
 *
 * Each case drives the PRODUCTION create path (SELF for the API routes; the
 * migrate orchestration at its service seam) and asserts BOTH halves of the
 * fix: the Registry DO row exists (the direct seam assertion) and an
 * anonymous `git ls-remote` advertisement answers 200 immediately (the
 * reported repro). Push-create's registry-passing path is unchanged and
 * stays covered by repos/push-create.test.ts.
 */

import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { registerForkRoutes } from "../api/routes/forks";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, STUB_USER } from "../api/auth";
import type { ApiEnv } from "../api/env";
import { giteaErrorHandler } from "../api/errors";
import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { migrateRepository } from "../services/migrate";
import { OrgService } from "../services/orgs/orgs";
import { users } from "../db/schema";
import { RepoService } from "./service";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

/** Reset lifecycle state; the migration-seeded 'assets' reservation user
 *  stays (production shape: the reserved row is never deletable via API). */
beforeEach(async () => {
  for (const table of [
    "repo_imports",
    "repo_mirrors",
    "repo_settings",
    "webhook_deliveries",
    "webhooks",
    "personal_access_tokens",
    "repo_units",
    "repo_transfer",
    "repo_redirects",
    "repo_counters",
    "repositories",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

/** Anonymous upload-pack advertisement fetch — the reported repro surface. */
async function uploadAdvert(owner: string, name: string): Promise<Response> {
  return SELF.fetch(`https://example.com/${owner}/${name}.git/info/refs?service=git-upload-pack`);
}

/** The direct seam assertion: the Registry DO has the repo's engine key. */
async function registryHas(engineName: string): Promise<boolean> {
  return (await env.REGISTRY.getByName("registry").get(engineName)) !== null;
}

/** POST /api/v1/user/repos through the real worker. */
async function apiCreateRepo(
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return SELF.fetch("https://example.com/api/v1/user/repos", {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("REDEPLOY8 — API creates register in the engine Registry at create (git smart-HTTP serves them immediately)", () => {
  it("POST /user/repos: the registry row lands with the D1 row and info/refs answers 200 with the advertisement", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    // Fixture widened (auth-parity H1): POST /user/repos sits in the user-scope
    // group AND the repo-scope combo (api.go:1181) — the token needs both
    // write:user and write:repository, as upstream demands of any client.
    const token = (await mintFor(alice.id, "w", "write:user,write:repository")).plaintext;

    const created = await apiCreateRepo(token, { name: "apimade", private: false });
    expect(created.status).toBe(201);

    // The seam: seedRepoExtras' best-effort upsert ran.
    expect(await registryHas("alice/apimade")).toBe(true);

    // The repro: minutes of 404 "repository not found" here pre-fix.
    const advert = await uploadAdvert("alice", "apimade");
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(new TextDecoder().decode(await advert.arrayBuffer())).toContain("# service=git-upload-pack");
  });

  it("POST /orgs/{org}/repos: same immediate servability for an org repo", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    await new OrgService(env.DB).createOrg({ name: "acme", ownerId: alice.id });
    // Fixture widened (auth-parity H1): POST /orgs/{org}/repos is gated
    // organization (group) AND repository (create arm) — api.go:1725-1813 +
    // 1731. Upstream clients mint both categories.
    const token = (await mintFor(alice.id, "w", "write:organization,write:repository")).plaintext;

    const created = await SELF.fetch("https://example.com/api/v1/orgs/acme/repos", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/json" },
      body: JSON.stringify({ name: "orgmade", private: false }),
    });
    expect(created.status).toBe(201);

    expect(await registryHas("acme/orgmade")).toBe(true);
    const advert = await uploadAdvert("acme", "orgmade");
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });

  it("POST /repos/{owner}/{repo}/forks: the fresh fork registers with the create — source and target both serve", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    // Fixture widened (auth-parity H1): the create leg rides POST /user/repos
    // (user+repository, api.go:1181); the fork POST itself is repository-only.
    const token = (await mintFor(alice.id, "w", "write:user,write:repository")).plaintext;
    const source = await apiCreateRepo(token, { name: "origin", private: false });
    expect(source.status).toBe(201);

    // The fork route on the local mount (the compat-suite pattern): the
    // REPO_TASKS producer is a capturing stub, so no live consumer races
    // the assertions — the registry upsert under test happens synchronously
    // at create, before the 202.
    const sends: Array<Record<string, unknown>> = [];
    const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
    const capturingQueue: Queue = {
      send: (message: unknown) => {
        sends.push(message as Record<string, unknown>);
        return Promise.resolve({ metadata });
      },
      sendBatch: () => Promise.resolve({ metadata }),
      metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
    };
    const app = new OpenAPIHono<ApiEnv>();
    app.onError(giteaErrorHandler);
    const identity = { ...STUB_USER, id: alice.id, login: "Alice" };
    const resolver = { resolveToken: (t: string) => Promise.resolve(t === "fork-token" ? identity : null) };
    registerForkRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
    const testEnv: ApiEnv["Bindings"] = { ...env, REPO_TASKS: capturingQueue };
    const forked = await app.fetch(
      new Request("https://example.com/repos/alice/origin/forks", {
        method: "POST",
        headers: { authorization: "token fork-token", "content-type": "application/json" },
        body: JSON.stringify({ name: "forked" }),
      }),
      testEnv,
    );
    expect(forked.status).toBe(202);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.kind).toBe("repo-fork");

    expect(await registryHas("alice/origin")).toBe(true);
    expect(await registryHas("alice/forked")).toBe(true);
    for (const name of ["origin", "forked"]) {
      const advert = await uploadAdvert("alice", name);
      expect(advert.status).toBe(200);
      expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    }
  });

  it("migrate (the global POST /repos/migrate birth): the born target registers before any content lands", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const ownerRow = (await drizzle(env.DB).select().from(users).where(eq(users.id, alice.id)).get())!;

    // The service seam the route drives (routes/mirror.ts passes `c.env`,
    // which now carries REGISTRY through MigrateEnv). mirror=false keeps the
    // arm queue-free; the chunked-import channel stays the caller's to drive.
    const outcome = await migrateRepository(env.DB, env, ownerRow, {
      mirror: false,
      clone_addr: "https://git.example.com/upstream.git",
      repo_name: "imported",
    }, new Date());
    expect(outcome.repo.ownerNamespace).toBe("alice");

    expect(await registryHas("alice/imported")).toBe(true);
    const advert = await uploadAdvert("alice", "imported");
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });

  it("control (the pre-fix shape): a D1 row created bare — no registry entry — still 404s the advertisement", async () => {
    // The bug mechanism, pinned: the engine 404s fetches for registry-missing
    // repos, so a bare `new RepoService(db)` create (the pre-fix API shape)
    // yields a row that resolves in D1 yet serves "repository not found"
    // until a push heals the registry. No registry row here BECAUSE the
    // construction is bare — this is the load-bearing difference the cases
    // above assert the production paths no longer have.
    const alice = await seedVerifiedUser({ username: "Alice" });
    await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "baremade",
      isPrivate: false,
    });
    expect(await registryHas("alice/baremade")).toBe(false);
    const advert = await uploadAdvert("alice", "baremade");
    expect(advert.status).toBe(404);
  });
});
