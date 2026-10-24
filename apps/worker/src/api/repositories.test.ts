/**
 * Tier-1 repo-metadata read routes on real D1 (SPEC-0004 §2.4 rows:
 * repoGet / repoSearch / repoGetByID / userListRepos / userCurrentListRepos).
 * Seeds `users` + `repositories` rows through Drizzle, boots the API router
 * with the stub auth resolver, and asserts the Repository field set against
 * the frozen vendored contract, the byte-exact Gitea error bodies, and the
 * runtime pagination headers.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { repositories, users } from "../db/schema";
import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { STUB_USER } from "./auth";
import { createApiRouter } from "./router";
import { REPO_SETTINGS_DDL_STATEMENTS } from "./services/repo-settings";
import contract from "../compat/contract/v1-swagger.generated.json";

// The vitest plugin's per-test storage isolation discards setupFiles-era D1
// writes; schema from `beforeAll` migrations persists for the file (same
// pattern as the SPEC-0002 suites, shared helper). repoGet overlays the
// batch-7 repo_settings raw store — the documented SCHEMA GAP with no
// migration yet — so its DDL-in-waiting is applied here too (the
// testing/repo-ddl.ts umbrella does this for the whole batch; both bootstrap
// calls disappear when the migration owner's sweep lands).
beforeAll(async () => {
  await applyAuthD1Migrations();
  for (const statement of REPO_SETTINGS_DDL_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  for (const table of ["repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

const SWAGGER_REPOSITORY_FIELDS = Object.keys(contract.definitions.Repository.properties).sort();

/** Upstream-`omitempty` fields that stay nil/empty for D1-only repositories:
 * forks (parent), external tracker/wiki units, pending transfers, and the
 * empty default PR target branch. Everything else is emitted (Go zero values
 * included), mirroring the vendored converter's runtime shape. */
const OMITTED_IN_RESPONSE = new Set([
  "default_target_branch",
  "external_tracker",
  "external_wiki",
  "parent",
  "repo_transfer",
]);

const EXPECTED_RESPONSE_FIELDS = SWAGGER_REPOSITORY_FIELDS.filter((name) => !OMITTED_IN_RESPONSE.has(name));

/** Indexed access under noUncheckedIndexedAccess — explicit guard instead of `!`. */
function firstOf<T>(items: T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error("expected a non-empty array");
  return first;
}

const STUB_LOGIN = STUB_USER.login ?? "cf-gitea-stub";
const TOKEN = "stub-token";
const authHeaders = { Authorization: `token ${TOKEN}` };
const ERROR_URL = "https://example.com/api/swagger";

let repoSeq = 200;

async function seedUser(
  username: string,
  opts: { isAdmin?: boolean } = {},
): Promise<{ id: number; usernameLower: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: opts.isAdmin ?? false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, usernameLower: user.usernameLower };
}

async function seedRepo(
  ownerNamespace: string,
  slug: string,
  opts: {
    visibility?: "public" | "private";
    refsVersion?: number;
    isEmpty?: boolean;
    id?: string;
    createdAt?: string;
    numIssues?: number;
    numPulls?: number;
  } = {},
): Promise<string> {
  const id = opts.id ?? String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    slug,
    visibility: opts.visibility ?? "public",
    refsVersion: opts.refsVersion ?? 0,
    isEmpty: opts.isEmpty ?? true,
    backend: "self-hosted",
    numIssues: opts.numIssues ?? 0,
    numPulls: opts.numPulls ?? 0,
    createdAt: new Date(opts.createdAt ?? "2026-02-03T04:05:06Z"),
  });
  return id;
}

/**
 * The plain `app.request()` helper builds requests WITHOUT worker bindings
 * (`c.env.DB` would be undefined); `app.fetch(request, env)` injects the real
 * test-worker bindings, matching how src/index.ts mounts the router.
 */
const router = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
};

describe("GET /repos/{owner}/{repo} (repoGet)", () => {
  it("mirrors the frozen contract's Repository field set for a public repo", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "visible");

    const res = await router()("/repos/Alice/visible");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(EXPECTED_RESPONSE_FIELDS);
  });

  it("fills D1-sourced fields and documented zero-defaults", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "visible", {
      // True post-settle row shape (push-create AND import settle): is_empty
      // flipped, refs_version still 0 — D1's refs_version is observability-
      // only (git-http/gate.ts §2.5.2) and must NOT drive the empty flag.
      isEmpty: false,
      id: "101",
      numIssues: 2,
      numPulls: 1,
    });

    const res = await router()("/repos/Alice/visible");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();

    expect(body).toMatchObject({
      id: 101,
      name: "visible",
      full_name: "alice/visible",
      private: false,
      empty: false,
      default_branch: "main",
      created_at: "2026-02-03T04:05:06.000Z",
      updated_at: "2026-02-03T04:05:06.000Z",
      object_format_name: "sha1",
      topics: [],
      licenses: [],
      link: "",
      html_url: "https://example.com/alice/visible",
      url: "https://example.com/api/v1/repos/alice/visible",
      clone_url: "https://example.com/alice/visible.git",
      ssh_url: "git@example.com:alice/visible.git",
      languages_url: "https://example.com/api/v1/repos/alice/visible/languages",
      // SPEC-0005 §3.2 maintained counters map to the D1 columns
      open_issues_count: 2,
      open_pr_counter: 1,
      // engine counters without backing columns render documented zeroes
      size: 0,
      stars_count: 0,
      forks_count: 0,
      watchers_count: 0,
      branch_count: 0,
      release_counter: 0,
      archived_at: "0001-01-01T00:00:00Z",
      mirror_updated: "0001-01-01T00:00:00Z",
      // upstream stock-repo unit/PR defaults
      has_code: true,
      has_issues: true,
      has_wiki: true,
      has_pull_requests: true,
      has_releases: true,
      has_projects: false,
      has_packages: false,
      has_actions: false,
      allow_merge_commits: true,
      default_merge_style: "merge",
      default_update_style: "merge",
      squash_merge_commit_message: "PR_BODY",
      default_allow_maintainer_edit: true,
      projects_mode: "all",
    });
    expect(body.owner).toMatchObject({ id: owner.id, login: "Alice", type: "User" });
  });

  it("builds the permissions block from the (anonymous) requester identity", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "visible");

    const res = await router()("/repos/alice/visible");
    const body = await res.json<{ permissions: { admin: boolean; push: boolean; pull: boolean } }>();

    expect(body.permissions).toEqual({ admin: false, push: false, pull: true });
  });

  it("gives the owner full permissions and a never-pushed repo empty=true", async () => {
    await seedUser(STUB_LOGIN); // the stub resolver authenticates as this user
    await seedRepo(STUB_LOGIN, "mine", { visibility: "private" });

    const res = await router()(`/repos/${STUB_LOGIN}/mine`, {
      headers: authHeaders,
    });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      private: true,
      empty: true,
      permissions: { admin: true, push: true, pull: true },
      owner: { login: STUB_LOGIN },
    });
  });

  it("404s a missing repo with the exact Gitea error body", async () => {
    const res = await router()("/repos/alice/ghost");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("404s an invisible private repo indistinguishably from a missing one", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "secret", { visibility: "private" });

    const res = await router()("/repos/alice/secret");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("404s an org-namespace repo (no users row yet — SPEC-0005)", async () => {
    await seedRepo("org-namespace", "repo");

    const res = await router()("/repos/org-namespace/repo");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("GET /repos/search (repoSearch)", () => {
  it("returns {data, ok:true} with X-Total-Count and matches the Repository field set", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "visible");
    await seedRepo(owner.usernameLower, "hidden");

    const res = await router()("/repos/search?q=vis");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    expect(res.headers.get("Link")).toBeNull();
    const body = await res.json<{ ok: boolean; data: Array<Record<string, unknown>> }>();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(Object.keys(firstOf(body.data)).sort()).toEqual(EXPECTED_RESPONSE_FIELDS);
    expect(firstOf(body.data)).toMatchObject({ full_name: "alice/visible" });
  });

  it("matches owner/repo keywords and is case-insensitive", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    await seedRepo(alice.usernameLower, "widgets");
    await seedRepo(bob.usernameLower, "widgets");

    const res = await router()("/repos/search?q=bob/Widg");

    const body = await res.json<{ data: Array<{ full_name: string }> }>();
    expect(res.headers.get("X-Total-Count")).toBe("1");
    expect(body.data.map((r) => r.full_name)).toEqual(["bob/widgets"]);
  });

  it("hides private repos from anonymous callers, shows own to the token owner", async () => {
    const alice = await seedUser("Alice");
    await seedRepo(alice.usernameLower, "pub");
    await seedRepo(alice.usernameLower, "sec", { visibility: "private" });
    await seedUser(STUB_LOGIN);
    await seedRepo(STUB_LOGIN, "mine", { visibility: "private" });

    const anon = await router()("/repos/search");
    const anonBody = await anon.json<{ data: Array<{ full_name: string }> }>();
    expect(anon.headers.get("X-Total-Count")).toBe("1");
    expect(anonBody.data.map((r) => r.full_name)).toEqual(["alice/pub"]);

    const owner = await router()("/repos/search", { headers: authHeaders });
    const ownerBody = await owner.json<{ data: Array<{ full_name: string }> }>();
    expect(owner.headers.get("X-Total-Count")).toBe("2");
    expect(ownerBody.data.map((r) => r.full_name).sort()).toEqual(["alice/pub", `${STUB_LOGIN}/mine`]);

    const publicOnly = await router()("/repos/search?private=false", {
      headers: authHeaders,
    });
    expect(publicOnly.headers.get("X-Total-Count")).toBe("1");
  });

  it("sorts by created desc / alpha desc and paginates with clamps and headers", async () => {
    const alice = await seedUser("Alice");
    await seedRepo(alice.usernameLower, "aaa", { id: "101", createdAt: "2026-01-01T00:00:00Z" });
    await seedRepo(alice.usernameLower, "bbb", { id: "102", createdAt: "2026-01-02T00:00:00Z" });
    await seedRepo(alice.usernameLower, "ccc", { id: "103", createdAt: "2026-01-03T00:00:00Z" });

    // page/limit clamps: 0-values silently become page=1, limit=30 (upstream
    // ToCorrectPageSize) — never a 422.
    const clamped = await router()("/repos/search?page=0&limit=0");
    expect(clamped.status).toBe(200);
    expect(clamped.headers.get("X-Total-Count")).toBe("3");
    expect(clamped.headers.get("Link")).toBeNull();
    expect((await clamped.json<{ data: unknown[] }>()).data.length).toBe(3);

    const paged = await router()("/repos/search?limit=2&page=2&sort=created&order=desc");
    expect(paged.headers.get("X-Total-Count")).toBe("3");
    expect(paged.headers.get("Link")).toContain('rel="prev"');
    expect(paged.headers.get("Link")).toContain('rel="first"');
    const body = await paged.json<{ data: Array<{ name: string }> }>();
    expect(body.data.map((r) => r.name)).toEqual(["aaa"]); // page 2 of [ccc, bbb, aaa]

    const alphaDesc = await router()("/repos/search?limit=2&sort=alpha&order=desc");
    const alphaBody = await alphaDesc.json<{ data: Array<{ name: string }> }>();
    expect(alphaBody.data.map((r) => r.name)).toEqual(["ccc", "bbb"]);
  });

  it.each([
    ["?mode=source", 3],
    ["?mode=fork", 0],
    ["?mode=mirror", 0],
    ["?mode=collaborative", 0],
  ])("applies mode %s against the fork-free registry", async (query, expected) => {
    const alice = await seedUser("Alice");
    await seedRepo(alice.usernameLower, "aaa");
    await seedRepo(alice.usernameLower, "bbb");
    await seedRepo(alice.usernameLower, "ccc");

    const res = await router()(`/repos/search${query}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe(String(expected));
  });

  it("422s invalid mode/sort/order with the upstream messages", async () => {
    const invalidMode = await router()("/repos/search?mode=bogus");
    expect(invalidMode.status).toBe(422);
    expect(await invalidMode.json()).toEqual({ message: "invalid search mode", url: ERROR_URL });

    const invalidSort = await router()("/repos/search?sort=bogus");
    expect(invalidSort.status).toBe(422);
    expect(await invalidSort.json()).toEqual({ message: 'Invalid sort mode: "bogus"', url: ERROR_URL });

    const invalidOrder = await router()("/repos/search?sort=alpha&order=bogus");
    expect(invalidOrder.status).toBe(422);
    expect(await invalidOrder.json()).toEqual({ message: 'Invalid sort order: "bogus"', url: ERROR_URL });

    // order is ignored when sort is absent (upstream ResolveSortOrder)
    const orderOnly = await router()("/repos/search?order=bogus");
    expect(orderOnly.status).toBe(200);
  });

  it("filters by uid ownership and documented-divergence params", async () => {
    const alice = await seedUser("Alice");
    await seedRepo(alice.usernameLower, "aaa");
    const privateId = await seedRepo(alice.usernameLower, "bbb", { visibility: "private" });

    const uid = await router()(`/repos/search?uid=${alice.id}`);
    expect(uid.headers.get("X-Total-Count")).toBe("1"); // private bbb invisible anonymously

    const unknownUid = await router()("/repos/search?uid=9999");
    expect(unknownUid.headers.get("X-Total-Count")).toBe("0");

    // starredBy/team_id/topic: no backing tables (SPEC-0005) → empty matches
    const starredBy = await router()(`/repos/search?starredBy=${alice.id}`);
    expect(starredBy.headers.get("X-Total-Count")).toBe("0");
    const team = await router()("/repos/search?team_id=1");
    expect(team.headers.get("X-Total-Count")).toBe("0");
    const topic = await router()("/repos/search?q=aaa&topic=true");
    expect(topic.headers.get("X-Total-Count")).toBe("0");

    // template/archived: no rows match `true` (registry has neither)
    const template = await router()("/repos/search?template=true");
    expect(template.headers.get("X-Total-Count")).toBe("0");
    const archived = await router()("/repos/search?archived=false");
    expect(archived.headers.get("X-Total-Count")).toBe("1"); // only public aaa is visible

    // is_private=true anonymous → nothing visible
    const isPrivate = await router()("/repos/search?is_private=true");
    expect(isPrivate.headers.get("X-Total-Count")).toBe("0");

    // the private repo stays reachable through its id (repoGetByID, token)
    const byId = await router()(`/repositories/${privateId}`, {
      headers: authHeaders,
    });
    expect(byId.status).toBe(404); // stub user is not alice
  });
});

describe("GET /repositories/{id} (repoGetByID)", () => {
  it("requires a token: anonymous → 401 token is required (upstream reqToken)", async () => {
    const res = await router()("/repositories/101");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "token is required", url: ERROR_URL });
  });

  it("returns the repository for a valid token", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "visible", { id: "101" });

    const res = await router()("/repositories/101", { headers: authHeaders });

    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(EXPECTED_RESPONSE_FIELDS);
    expect(body).toMatchObject({ id: 101, full_name: "alice/visible" });
  });

  it("404s unknown ids and private repos of other users", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "secret", { visibility: "private", id: "101" });

    const missing = await router()("/repositories/404", { headers: authHeaders });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });

    const invisible = await router()("/repositories/101", { headers: authHeaders });
    expect(invisible.status).toBe(404);
    expect(await invisible.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("GET /users/{username}/repos (userListRepos)", () => {
  it("lists the user's public repos in id order with pagination headers", async () => {
    const alice = await seedUser("Alice");
    await seedRepo(alice.usernameLower, "second", { id: "102" });
    await seedRepo(alice.usernameLower, "first", { id: "101" });
    await seedRepo(alice.usernameLower, "secret", { visibility: "private", id: "103" });

    const res = await router()("/users/alice/repos?limit=1");

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2"); // public only for anonymous
    expect(res.headers.get("Link")).toContain('rel="next"');
    const body = await res.json<Array<{ name: string }>>();
    expect(body.map((r) => r.name)).toEqual(["first"]);
    expect(Object.keys(firstOf(body)).sort()).toEqual(EXPECTED_RESPONSE_FIELDS);
  });

  it("404s a missing user with the exact Gitea body", async () => {
    const res = await router()("/users/ghost/repos");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("shows all own repos to the token owner, public only to others", async () => {
    await seedUser(STUB_LOGIN);
    await seedRepo(STUB_LOGIN, "pub");
    await seedRepo(STUB_LOGIN, "sec", { visibility: "private" });

    const self = await router()(`/users/${STUB_LOGIN}/repos`, {
      headers: authHeaders,
    });
    expect(self.headers.get("X-Total-Count")).toBe("2");

    const anon = await router()(`/users/${STUB_LOGIN}/repos`);
    expect(anon.headers.get("X-Total-Count")).toBe("1");
  });

  it("clamps garbage pagination params silently (page=abc&limit=0)", async () => {
    const alice = await seedUser("Alice");
    await seedRepo(alice.usernameLower, "a");
    await seedRepo(alice.usernameLower, "b");
    await seedRepo(alice.usernameLower, "c");

    const res = await router()("/users/alice/repos?page=abc&limit=0");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("3");
    expect((await res.json<unknown[]>()).length).toBe(3); // clamp → limit 30
  });
});

describe("GET /user/repos (userCurrentListRepos)", () => {
  it("requires a token: anonymous → 401 token is required", async () => {
    const res = await router()("/user/repos");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: "token is required", url: ERROR_URL });
  });

  it("lists the authenticated user's own repos including private, slug-ordered", async () => {
    await seedUser(STUB_LOGIN);
    await seedRepo(STUB_LOGIN, "zeta", { visibility: "private" });
    await seedRepo(STUB_LOGIN, "alpha");
    const other = await seedUser("Alice");
    await seedRepo(other.usernameLower, "not-mine");

    const res = await router()("/user/repos", { headers: authHeaders });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    const body = await res.json<Array<{ name: string; permissions: unknown }>>();
    expect(body.map((r) => r.name)).toEqual(["alpha", "zeta"]);
    expect(body.every((r) => r.permissions !== null)).toBe(true);
  });

  it("paginates and clamps", async () => {
    await seedUser(STUB_LOGIN);
    await seedRepo(STUB_LOGIN, "aaa");
    await seedRepo(STUB_LOGIN, "bbb");
    await seedRepo(STUB_LOGIN, "ccc");

    const pastEnd = await router()("/user/repos?limit=2&page=99", { headers: authHeaders });
    expect(pastEnd.status).toBe(200);
    expect(pastEnd.headers.get("X-Total-Count")).toBe("3");
    expect((await pastEnd.json<unknown[]>()).length).toBe(0); // past the end, upstream-style

    const first = await router()("/user/repos?limit=2", { headers: authHeaders });
    expect(first.headers.get("Link")).toContain('rel="next"');
    expect(first.headers.get("Link")).toContain('rel="last"');
  });
});

describe("repository reads with an admin token", () => {
  it("lets a site admin see private repos in listings and grants full permissions", async () => {
    const admin = { ...STUB_USER, login: "root", is_admin: true };
    const adminApp = createApiRouter({
      auth: { resolveToken: (token) => Promise.resolve(token === "admin-token" ? admin : null) },
    });
    const adminRouter = async (path: string, init?: RequestInit): Promise<Response> =>
      adminApp.fetch(new Request(`https://example.com${path}`, init), env);
    const alice = await seedUser("Alice");
    await seedRepo(alice.usernameLower, "sec", { visibility: "private" });

    const search = await adminRouter("/repos/search?is_private=true", {
      headers: { Authorization: "token admin-token" },
    });
    expect(search.headers.get("X-Total-Count")).toBe("1");

    const repo = await adminRouter("/repos/alice/sec", {
      headers: { Authorization: "token admin-token" },
    });
    expect(repo.status).toBe(200);
    const body = await repo.json<{ permissions: { admin: boolean } }>();
    expect(body.permissions.admin).toBe(true);
  });
});
