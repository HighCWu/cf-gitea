/**
 * SPEC-0014 §4.3/§7 (M2) — the gated per-owner repo-count quota. The
 * INVARIANT arm leads (the M1 demo-sweep.test.ts discipline): with
 * `DEMO_MODE` off, `assertDemoRepoQuota` performs ZERO D1 reads (the
 * tripwire stub throws on first touch) at BOTH create paths — a default
 * deployment's repo creation is byte-for-byte what it was before this
 * module existed.
 *
 * The armed arms pin the upstream-faithful shape at the pin (`fc4936884584`):
 * the refusal text is `ErrReachLimitOfRepo.Error()` verbatim
 * (models/repo/update.go:59-61); a site-admin DOER bypasses with no count
 * (models/user/user.go:289-291); the API create route answers 403 with that
 * message (the ErrPermissionDenied unwrap mapping,
 * routers/api/v1/repo/repo.go:256-258); the push-create arm masks to the
 * bare 404 (routers/web/repo/githttp.go:235-238). Real local D1
 * (workerd, @cloudflare/vitest-plugin) for the count; the API-create route
 * arms run through a locally-mounted `createApiRouter` (the
 * repositories.test.ts harness) so the env can carry the armed gate; the
 * push-create arms drive the real worker `fetch` with an armed env copy
 * (SELF cannot vary bindings).
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, resetAuthTables, seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, users } from "../../db/schema";
import { buildPack, buildReceivePackBody } from "../../repos/testing/git-pack";
import { STUB_USER, createStubAuthResolver } from "../auth";
import { createApiRouter } from "../router";
import { assertDemoRepoQuota, DEMO_MAX_REPOS_PER_OWNER, DemoRepoQuotaError } from "../../services/demo-quota";
import worker from "../../index";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The env copy with the gate var overridden — the scheduledEnv pattern
 *  (demo-sweep.test.ts): wrangler types a declared var by its LITERAL config
 *  value ("false"), so a spread override alone cannot flip it. */
function armedEnv(demoMode: string): Env {
  const copy = { ...env };
  (copy as { DEMO_MODE: string }).DEMO_MODE = demoMode;
  return copy;
}

/** The gate-off tripwire (the demo-sweep.test.ts d1ThatThrows shape): any
 *  prepare/batch/exec by gate-off code fails the test naming the touch. */
function d1ThatThrows(): D1Database {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`D1 touched while the DEMO_MODE gate is off: .${String(prop)}`);
      },
    },
  ) as D1Database;
}

async function seedQuotaRepos(ownerId: number, ownerNamespace: string, n: number, offset = 0): Promise<void> {
  for (let i = 0; i < n; i++) {
    const id = `q_${ownerId}_${offset + i}`;
    await drizzle(env.DB).insert(repositories).values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace,
      ownerId,
      slug: `quota-${offset + i}`,
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: new Date(0),
    });
  }
}

async function countRepos(ownerId: number): Promise<number> {
  const rows = await drizzle(env.DB)
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.ownerId, ownerId))
    .all();
  return rows.length;
}

beforeEach(async () => {
  await applyAuthD1Migrations();
  await resetAuthTables();
  for (const table of ["repo_settings", "repo_counters", "repo_redirects", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// ---------------------------------------------------------------------------
// §7 invariant arm — the gate OFF means ZERO checks (runs first, always)
// ---------------------------------------------------------------------------

describe("the quota gate (§2 invariant — runs first)", () => {
  it("gate OFF (unset): ZERO D1 reads — the tripwire never fires", async () => {
    await expect(assertDemoRepoQuota({}, d1ThatThrows(), { isAdmin: false }, 1)).resolves.toBeUndefined();
  });

  it("gate OFF ('false' default, '1', 'on', 'TRUE'): same zero-check silence — §6.8 fail-closed", async () => {
    for (const demoMode of ["false", "1", "on", "TRUE"]) {
      await expect(
        assertDemoRepoQuota({ DEMO_MODE: demoMode }, d1ThatThrows(), { isAdmin: false }, 1),
      ).resolves.toBeUndefined();
    }
  });

  it("armed + ADMIN doer: the upstream CanCreateRepoIn bypass — ZERO D1 reads (user.go:289-291)", async () => {
    await expect(
      assertDemoRepoQuota({ DEMO_MODE: "true" }, d1ThatThrows(), { isAdmin: true }, 1),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §7 armed arms — the helper boundary (one COUNT, one indexed query)
// ---------------------------------------------------------------------------

describe("the armed count boundary (§4.3)", () => {
  it("under the cap: passes (the Nth create lands, the (cap+1)th is refused)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    await seedQuotaRepos(alice.id, "alice", DEMO_MAX_REPOS_PER_OWNER - 1);
    await expect(
      assertDemoRepoQuota({ DEMO_MODE: "true" }, env.DB, { isAdmin: false }, alice.id),
    ).resolves.toBeUndefined();
    // At the cap: the refusal carries the upstream ErrReachLimitOfRepo text.
    await seedQuotaRepos(alice.id, "alice", 1, DEMO_MAX_REPOS_PER_OWNER - 1);
    const refusal = assertDemoRepoQuota({ DEMO_MODE: "true" }, env.DB, { isAdmin: false }, alice.id);
    await expect(refusal).rejects.toBeInstanceOf(DemoRepoQuotaError);
    await expect(refusal).rejects.toThrow(/user has reached maximum limit of repositories \[limit: 5\]/);
  });

  it("the cap counts the OWNER's repos — an org owner is capped like a user (upstream MaxCreationLimit())", async () => {
    const doer = await seedVerifiedUser({ username: "Doer" });
    const org = await seedVerifiedUser({ username: "an-org", isAdmin: false });
    await drizzle(env.DB)
      .update(users)
      .set({ type: "org" })
      .where(eq(users.id, org.id));
    await seedQuotaRepos(org.id, "an-org", DEMO_MAX_REPOS_PER_OWNER);
    // A non-admin doer with the org grant pushes into a FULL org namespace:
    // the count is over the owner (the org), the doer's own count is moot.
    await expect(
      assertDemoRepoQuota({ DEMO_MODE: "true" }, env.DB, { isAdmin: false }, org.id),
    ).rejects.toBeInstanceOf(DemoRepoQuotaError);
    // (The doer owns nothing — the refusal is the org's fullness.)
    expect(await countRepos(doer.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Call site 1 — the API create route (POST /api/v1/user/repos)
// ---------------------------------------------------------------------------

describe("the quota at POST /user/repos (§4.3 call site 1)", () => {
  const apiApp = createApiRouter();

  /** repositories.test.ts's fetch shape, plus an env override so the route
   *  can run with the gate armed (SELF cannot vary bindings). Route paths
   *  are relative to the /api/v1 mount (router.ts header) — the fetch is
   *  against the mounted app, so the URL carries NO prefix. */
  async function apiCreate(
    body: Record<string, unknown>,
    envOverride?: Env,
    auth?: ReturnType<typeof createStubAuthResolver>,
  ): Promise<Response> {
    const app = auth === undefined ? apiApp : createApiRouter({ auth });
    const ctx = createExecutionContext();
    const res = await app.fetch(
      new Request("https://example.com/user/repos", {
        method: "POST",
        headers: { authorization: "token stub-token", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      envOverride ?? env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  /** The stub resolver's fixed identity (id 1) must exist as a D1 row —
   *  findDoerRow reads it (the users row carries is_admin). */
  async function seedStubRow(isAdmin: boolean): Promise<void> {
    await drizzle(env.DB)
      .insert(users)
      .values({
        id: 1,
        username: STUB_USER.login ?? "cf-gitea-stub",
        usernameLower: (STUB_USER.login ?? "cf-gitea-stub").toLowerCase(),
        isAdmin,
        status: "active",
        createdAt: new Date(0),
      });
  }

  it("gate OFF (the deployed default): create runs exactly as before — 201, zero checks", async () => {
    await seedStubRow(false);
    await seedQuotaRepos(1, "cf-gitea-stub", DEMO_MAX_REPOS_PER_OWNER + 2); // past the cap — irrelevant when off
    const res = await apiCreate({ name: "gate-off-create", private: true });
    expect(res.status).toBe(201);
    expect(await countRepos(1)).toBe(DEMO_MAX_REPOS_PER_OWNER + 3);
  });

  it("armed, under the cap: 201", async () => {
    await seedStubRow(false);
    await seedQuotaRepos(1, "cf-gitea-stub", DEMO_MAX_REPOS_PER_OWNER - 1);
    const res = await apiCreate({ name: "armed-create", private: true }, armedEnv("true"));
    expect(res.status).toBe(201);
    expect(await countRepos(1)).toBe(DEMO_MAX_REPOS_PER_OWNER);
  });

  it("armed, at the cap: upstream's 403 + ErrReachLimitOfRepo.Error() verbatim (repo.go:256-258)", async () => {
    await seedStubRow(false);
    await seedQuotaRepos(1, "cf-gitea-stub", DEMO_MAX_REPOS_PER_OWNER);
    const res = await apiCreate({ name: "over-quota", private: true }, armedEnv("true"));
    expect(res.status).toBe(403);
    const body = await res.json<{ message: string; url: string }>();
    expect(body.message).toBe(`user has reached maximum limit of repositories [limit: ${DEMO_MAX_REPOS_PER_OWNER}]`);
    expect(body.url).toBe("https://example.com/api/swagger");
    // Nothing was created.
    expect(await countRepos(1)).toBe(DEMO_MAX_REPOS_PER_OWNER);
  });

  it("armed, ADMIN doer at the cap: the upstream bypass — 201 (the demo's fixture-minting posture, §6.2)", async () => {
    const adminAuth = {
      resolveToken: () =>
        Promise.resolve({
          ...STUB_USER,
          id: 2,
          login: "demo-admin",
          is_admin: true,
        }),
    };
    await drizzle(env.DB)
      .insert(users)
      .values({ id: 2, username: "demo-admin", usernameLower: "demo-admin", isAdmin: true, status: "active", createdAt: new Date(0) });
    await seedQuotaRepos(2, "demo-admin", DEMO_MAX_REPOS_PER_OWNER + 2); // already past the cap
    const res = await apiCreate({ name: "admin-fixture", private: true }, armedEnv("true"), adminAuth);
    expect(res.status).toBe(201);
    expect(await countRepos(2)).toBe(DEMO_MAX_REPOS_PER_OWNER + 3);
  });
});

// ---------------------------------------------------------------------------
// Call site 2 — the push-create settle (git-http/gate.ts, the bare-404 mask)
// ---------------------------------------------------------------------------

describe("the quota at push-create (§4.3 call site 2)", () => {
  const RECEIVE_CT = "application/x-git-receive-pack-request";

  /** A real one-commit receive against a non-existent repo (push-create) —
   *  the gate.test.ts pushCreateAndSettle shape, driven through the real
   *  worker `fetch` with an env override. */
  async function pushCreate(token: string, owner: string, slug: string, envOverride?: Env): Promise<Response> {
    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack);
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`https://example.com/${owner}/${slug}.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
        body,
      }),
      envOverride ?? env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("armed, under the cap: push-create lands (the row is created)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    await seedQuotaRepos(alice.id, "alice", DEMO_MAX_REPOS_PER_OWNER - 1);
    const res = await pushCreate(token, "alice", "armed-under", armedEnv("true"));
    expect(res.status).toBe(200);
    expect(await countRepos(alice.id)).toBe(DEMO_MAX_REPOS_PER_OWNER);
  });

  it("armed, at the cap: upstream's bare-404 mask (githttp.go:235-238) — no row, no error surface", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    await seedQuotaRepos(alice.id, "alice", DEMO_MAX_REPOS_PER_OWNER);
    const res = await pushCreate(token, "alice", "armed-over", armedEnv("true"));
    // The mask: indistinguishable from any other refused push-create — the
    // git surface carries no error taxonomy (the gate's documented posture).
    expect(res.status).toBe(404);
    expect(await countRepos(alice.id)).toBe(DEMO_MAX_REPOS_PER_OWNER);
  });

  it("gate OFF: a past-cap push-create still lands — zero interference (§2)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    await seedQuotaRepos(alice.id, "alice", DEMO_MAX_REPOS_PER_OWNER + 1);
    const res = await pushCreate(token, "alice", "gate-off-over");
    expect(res.status).toBe(200);
    expect(await countRepos(alice.id)).toBe(DEMO_MAX_REPOS_PER_OWNER + 2);
  });
});
