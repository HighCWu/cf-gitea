/**
 * Tier-1 commit-status routes on real D1 (SPEC-0004 §2.4 rows: repoCreateStatus
 * / repoListStatuses / repoListStatusesByRef / repoGetCombinedStatusByRef).
 * Seeds `users` + `repositories` + `commit_statuses` rows through Drizzle,
 * boots the API router with the stub auth resolver, and asserts the wire
 * shapes against the frozen vendored contract, the exact sort/aggregate
 * semantics of gitea/models/git/commit_status.go, and the byte-exact error
 * bodies. The ref-vs-sha wave limitation (full-length ids only, engine TODO)
 * is pinned here too.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { commitStatuses, repositories, users } from "../db/schema";
import { STUB_USER } from "./auth";
import { createApiRouter } from "./router";
import contract from "../compat/contract/v1-swagger.generated.json";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["commit_statuses", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

const COMMIT_STATUS_FIELDS = Object.keys(contract.definitions.CommitStatus.properties).sort();
const COMBINED_STATUS_FIELDS = Object.keys(contract.definitions.CombinedStatus.properties).sort();
/** Upstream-`omitempty` Repository fields absent for D1-only repos (same set
 * as repositories.test.ts: forks, external units, transfers, default target). */
const OMITTED_REPOSITORY_FIELDS = new Set([
  "default_target_branch",
  "external_tracker",
  "external_wiki",
  "parent",
  "repo_transfer",
]);
const REPOSITORY_FIELDS = Object.keys(contract.definitions.Repository.properties)
  .filter((name) => !OMITTED_REPOSITORY_FIELDS.has(name))
  .sort();

const TOKEN = "stub-token";
const authHeaders = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const ERROR_URL = "https://example.com/api/swagger";

let repoSeq = 300;

async function seedUser(username: string): Promise<{ id: number; usernameLower: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, usernameLower: user.usernameLower };
}

async function seedRepo(ownerNamespace: string, slug: string): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    slug,
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  return id;
}

interface SeedStatusInput {
  sha: string;
  state: string;
  context: string;
  createdAt: string;
  updatedAt?: string;
  targetUrl?: string;
  description?: string;
  creatorId?: number | null;
}

async function seedStatus(repoId: string, input: SeedStatusInput): Promise<number> {
  const rows = await db()
    .insert(commitStatuses)
    .values({
      repoId,
      sha: input.sha,
      state: input.state as "pending",
      context: input.context,
      targetUrl: input.targetUrl ?? "",
      description: input.description ?? "",
      creatorId: input.creatorId ?? null,
      createdAt: new Date(input.createdAt),
      updatedAt: new Date(input.updatedAt ?? input.createdAt),
    })
    .returning({ id: commitStatuses.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("status seed failed");
  return row.id;
}

const router = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
};

const SHA = "e5f2a1b3c4d5e6f708192a3b4c5d6e7f8091a2b3";
const SHA_OTHER = "0123456789abcdef0123456789abcdef01234567";

describe("POST /repos/{owner}/{repo}/statuses/{sha} (repoCreateStatus)", () => {
  it("creates a status with 201 and the exact contract CommitStatus field set", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");

    const res = await router()(`/repos/Alice/visible/statuses/${SHA}`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ state: "success", context: "ci/test", target_url: "https://ci.example.com/1", description: "tests passed" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(COMMIT_STATUS_FIELDS);
    expect(body).toMatchObject({
      status: "success",
      context: "ci/test",
      description: "tests passed",
      target_url: "https://ci.example.com/1",
      url: `https://example.com/api/v1/repos/alice/visible/statuses/${SHA}`,
      creator: { id: STUB_USER.id, login: STUB_USER.login },
    });
    expect(typeof body.id).toBe("number");
    // Upstream quirk at the pinned commit: updated_at renders CreatedUnix,
    // so it always equals created_at (services/convert/status.go:19–20).
    expect(body.created_at).toBeTypeOf("string");
    expect(body.updated_at).toBe(body.created_at);
    expect(Number.isInteger(body.id)).toBe(true);

    // The row is stored under the requested full sha, repo-scoped.
    const stored = await db().select().from(commitStatuses).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ repoId, sha: SHA, state: "success", context: "ci/test" });
  });

  it.each(["warning", "skipped"])("accepts the %s state of the contract enum", async (state) => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const res = await router()(`/repos/alice/visible/statuses/${SHA}`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ state }),
    });

    expect(res.status).toBe(201);
    expect((await res.json<{ status: string }>()).status).toBe(state);
  });

  it("normalizes an absent context to the schema default and trims text values", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const res = await router()(`/repos/alice/visible/statuses/${SHA}`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ state: "pending", context: "  ", description: "  trimmed  " }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ context: "default", description: "trimmed" });
  });

  it("400s an absent state and maps body bind failures to the declared 400", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const noState = await router()(`/repos/alice/visible/statuses/${SHA}`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ context: "ci" }),
    });
    expect(noState.status).toBe(400);
    expect(await noState.json()).toEqual({ message: "invalid status state: ", url: ERROR_URL });

    // Out-of-enum states are rejected by the body validator (upstream stores
    // them unvalidated — documented divergence, the D1 schema pins the enum).
    const badState = await router()(`/repos/alice/visible/statuses/${SHA}`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ state: "deployed" }),
    });
    expect(badState.status).toBe(400);
    expect((await badState.json<{ message: string }>()).message).toBe("invalid request body");

    const malformed = await router()(`/repos/alice/visible/statuses/${SHA}`, {
      method: "POST",
      headers: authHeaders,
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
  });

  it("422s non-full-length shas (runtime-only response; engine ref resolution TODO)", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    for (const sha of ["abc1234", "main", SHA.toUpperCase(), "xyz"]) {
      const res = await router()(`/repos/alice/visible/statuses/${sha}`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ state: "success" }),
      });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ message: `invalid sha: ${sha}`, url: ERROR_URL });
    }
    // Nothing was stored under any of those shapes.
    expect(await db().select().from(commitStatuses).all()).toHaveLength(0);
  });

  it("requires a token (401) and a visible repository (404)", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "visible");
    await seedRepo("alice", "secret"); // no users row → invisible via owner join

    const anon = await router()(`/repos/alice/visible/statuses/${SHA}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "success" }),
    });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ message: "token is required", url: ERROR_URL });

    const missing = await router()(`/repos/alice/ghost/statuses/${SHA}`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ state: "success" }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("GET /repos/{owner}/{repo}/statuses/{sha} (repoListStatuses)", () => {
  it("lists a commit's statuses newest-first by default with the contract field set", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedStatus(repoId, { sha: SHA, state: "success", context: "a", createdAt: "2026-01-01T00:00:00Z" });
    await seedStatus(repoId, { sha: SHA, state: "pending", context: "b", createdAt: "2026-01-02T00:00:00Z" });
    await seedStatus(repoId, { sha: SHA_OTHER, state: "success", context: "a", createdAt: "2026-01-03T00:00:00Z" });

    const res = await router()(`/repos/alice/visible/statuses/${SHA}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.headers.get("Link")).toBeNull();
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(Object.keys(body[0]!).sort()).toEqual(COMMIT_STATUS_FIELDS);
    // default order: created_unix DESC (then index DESC → newest id first)
    expect(body.map((s) => s.context)).toEqual(["b", "a"]);
  });

  it.each([
    // ToOrders (gitea/models/git/commit_status.go): a=created 03-01/updated 01-05,
    // b=created 02-01/updated 01-04, c=created 01-01/updated 01-06 (ids a<b<c).
    ["oldest", ["c", "b", "a"]], // created_unix ASC, index ASC
    ["recentupdate", ["c", "a", "b"]], // updated_unix DESC, index DESC
    ["leastupdate", ["b", "a", "c"]], // updated_unix ASC, index ASC
    ["leastindex", ["c", "b", "a"]], // index DESC — the inverted upstream name
    ["highestindex", ["a", "b", "c"]], // index ASC
    ["bogus", ["a", "b", "c"]], // unknown sorts silently take the default
  ])("applies the sort=%s order", async (sort, expected) => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedStatus(repoId, { sha: SHA, state: "success", context: "a", createdAt: "2026-03-01T00:00:00Z", updatedAt: "2026-01-05T00:00:00Z" });
    await seedStatus(repoId, { sha: SHA, state: "success", context: "b", createdAt: "2026-02-01T00:00:00Z", updatedAt: "2026-01-04T00:00:00Z" });
    await seedStatus(repoId, { sha: SHA, state: "success", context: "c", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-06T00:00:00Z" });

    const res = await router()(`/repos/alice/visible/statuses/${SHA}?sort=${sort}`);
    expect(res.status).toBe(200);
    expect((await res.json<Array<{ context: string }>>()).map((s) => s.context)).toEqual(expected);
  });

  it("filters by the state enum but ignores unknown values (skipped never filters)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedStatus(repoId, { sha: SHA, state: "success", context: "a", createdAt: "2026-01-01T00:00:00Z" });
    await seedStatus(repoId, { sha: SHA, state: "pending", context: "b", createdAt: "2026-01-02T00:00:00Z" });
    await seedStatus(repoId, { sha: SHA, state: "skipped", context: "c", createdAt: "2026-01-03T00:00:00Z" });

    const success = await router()(`/repos/alice/visible/statuses/${SHA}?state=success`);
    expect(success.headers.get("X-Total-Count")).toBe("1");
    expect((await success.json<Array<{ context: string }>>()).map((s) => s.context)).toEqual(["a"]);

    // "skipped" is NOT in the upstream state-filter enum → no filtering at all.
    const skipped = await router()(`/repos/alice/visible/statuses/${SHA}?state=skipped`);
    expect(skipped.headers.get("X-Total-Count")).toBe("3");

    const garbage = await router()(`/repos/alice/visible/statuses/${SHA}?state=bogus`);
    expect(garbage.headers.get("X-Total-Count")).toBe("3");
  });

  it("paginates with runtime headers and returns an empty list for unknown shas", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedStatus(repoId, { sha: SHA, state: "success", context: "a", createdAt: "2026-01-01T00:00:00Z" });
    await seedStatus(repoId, { sha: SHA, state: "success", context: "b", createdAt: "2026-01-02T00:00:00Z" });
    await seedStatus(repoId, { sha: SHA, state: "success", context: "c", createdAt: "2026-01-03T00:00:00Z" });

    const page = await router()(`/repos/alice/visible/statuses/${SHA}?limit=2&page=1`);
    expect(page.headers.get("X-Total-Count")).toBe("3");
    expect(page.headers.get("Link")).toContain('rel="next"');
    expect((await page.json<unknown[]>()).length).toBe(2);

    // Unknown (or differently-cased) shas are queried verbatim → empty 200.
    const unknown = await router()(`/repos/alice/visible/statuses/${SHA_OTHER}`);
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get("X-Total-Count")).toBe("0");
    expect(await unknown.json()).toEqual([]);

    const upper = await router()(`/repos/alice/visible/statuses/${SHA.toUpperCase()}`);
    expect(upper.headers.get("X-Total-Count")).toBe("0");
  });

  it("404s a missing or invisible repository with the exact body", async () => {
    await seedUser("Alice");
    const res = await router()(`/repos/alice/ghost/statuses/${SHA}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("GET /repos/{owner}/{repo}/commits/{ref}/statuses (repoListStatusesByRef)", () => {
  it("accepts a full-length commit id as the ref", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedStatus(repoId, { sha: SHA, state: "success", context: "a", createdAt: "2026-01-01T00:00:00Z" });

    const res = await router()(`/repos/alice/visible/commits/${SHA}/statuses?sort=oldest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    expect((await res.json<Array<{ context: string }>>()).map((s) => s.context)).toEqual(["a"]);
  });

  it("404s unresolvable refs with upstream's exact git.ErrNotExist message", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    // Branch/tag/short-sha resolution needs the storage engine (TODO
    // SPEC-0001/0003) — until then every non-full-length ref takes the
    // unresolvable-ref path upstream itself takes for unknown refs.
    // Slash-bearing refs must be URL-encoded to route (hono params are
    // single-segment; upstream chi also matches raw slashes — a documented
    // routing divergence), and arrive decoded in the error message.
    for (const ref of ["main", "abc1234", SHA.slice(0, 39)]) {
      const res = await router()(`/repos/alice/visible/commits/${ref}/statuses`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: `object does not exist [id: ${ref}, rel_path: ]`, url: ERROR_URL });
    }
    const encoded = await router()(`/repos/alice/visible/commits/${encodeURIComponent("refs/heads/main")}/statuses`);
    expect(encoded.status).toBe(404);
    expect(await encoded.json()).toEqual({
      message: "object does not exist [id: refs/heads/main, rel_path: ]",
      url: ERROR_URL,
    });
  });
});

describe("GET /repos/{owner}/{repo}/commits/{ref}/status (repoGetCombinedStatusByRef)", () => {
  it("returns the CombinedStatus shape with the exact contract field set", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedStatus(repoId, { sha: SHA, state: "success", context: "ci/build", createdAt: "2026-01-01T00:00:00Z" });
    await seedStatus(repoId, { sha: SHA, state: "pending", context: "ci/test", createdAt: "2026-01-02T00:00:00Z" });

    const res = await router()(`/repos/alice/visible/commits/${SHA}/status`);

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(COMBINED_STATUS_FIELDS);
    expect(Object.keys(body.repository as Record<string, unknown>).sort()).toEqual(REPOSITORY_FIELDS);
    expect(body).toMatchObject({
      state: "pending", // pending present, no failure-family state
      sha: SHA,
      total_count: 2,
      commit_url: `https://example.com/api/v1/repos/alice/visible/commits/${SHA}`,
      url: `https://example.com/api/v1/repos/alice/visible/commits/${SHA}/status`,
    });
    expect((body.statuses as Array<Record<string, unknown>>).map((s) => s.context)).toEqual(["ci/test", "ci/build"]);
  });

  it.each([
    // Combine() precedence (modules/commitstatus/commit_status.go:67–82):
    // any error/failure/warning → failure; all success/skipped → success;
    // otherwise pending.
    [["success", "success"], "success"],
    [["success", "skipped"], "success"],
    [["skipped", "skipped"], "success"],
    [["success", "pending"], "pending"],
    [["pending"], "pending"],
    [["success", "warning"], "failure"],
    [["success", "failure"], "failure"],
    [["success", "error"], "failure"],
    [["warning", "pending", "success"], "failure"],
  ])("aggregates %j to %s (worst-of precedence)", async (states, expected) => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    let i = 0;
    for (const state of states) {
      await seedStatus(repoId, { sha: SHA, state, context: `c${i++}`, createdAt: "2026-01-01T00:00:00Z" });
    }

    const res = await router()(`/repos/alice/visible/commits/${SHA}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: expected, total_count: states.length });
  });

  it("aggregates only the LATEST status per context", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    // ci/flaky reports success, then failure — the failure wins the combine.
    await seedStatus(repoId, { sha: SHA, state: "success", context: "ci/flaky", createdAt: "2026-01-01T00:00:00Z" });
    await seedStatus(repoId, { sha: SHA, state: "failure", context: "ci/flaky", createdAt: "2026-01-02T00:00:00Z" });
    await seedStatus(repoId, { sha: SHA, state: "success", context: "ci/green", createdAt: "2026-01-03T00:00:00Z" });

    const res = await router()(`/repos/alice/visible/commits/${SHA}/status`);
    expect(res.status).toBe(200);
    // total_count counts DISTINCT contexts (CountLatestCommitStatus), rows total 3.
    expect(await res.json()).toMatchObject({ state: "failure", total_count: 2 });
  });

  it("renders pending with empty statuses for a commit without any", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const res = await router()(`/repos/alice/visible/commits/${SHA}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "pending", total_count: 0, statuses: [] });
  });

  it("paginates the per-context list", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedStatus(repoId, { sha: SHA, state: "success", context: "a", createdAt: "2026-01-01T00:00:00Z" });
    await seedStatus(repoId, { sha: SHA, state: "success", context: "b", createdAt: "2026-01-02T00:00:00Z" });

    const res = await router()(`/repos/alice/visible/commits/${SHA}/status?limit=1`);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.headers.get("Link")).toContain('rel="next"');
    const body = await res.json<{ statuses: unknown[] }>();
    expect(body.statuses).toHaveLength(1);
  });

  it("404s unresolvable refs and invisible repositories", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const badRef = await router()("/repos/alice/visible/commits/main/status");
    expect(badRef.status).toBe(404);
    expect(await badRef.json()).toEqual({ message: "object does not exist [id: main, rel_path: ]", url: ERROR_URL });

    const ghost = await router()(`/repos/alice/ghost/commits/${SHA}/status`);
    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});
