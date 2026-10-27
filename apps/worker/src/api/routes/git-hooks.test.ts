/**
 * The four server-side git-hooks ops on real D1 + R2 (remaining-API inventory
 * §repository RUNTIME-ONLY batch — `wave-api-git-hooks`; behavior ports
 * gitea/routers/api/v1/repo/git_hook.go over gitea/modules/git/hook.go's
 * filesystem model, degenerated to the REPO_PACKS bucket). Seeds `users` +
 * `repositories` rows through Drizzle, mounts the module on a local
 * OpenAPIHono with the REAL auth middlewares (the orchestrator's
 * `registerGitHookRoutes(app, requireAuth)` one-liner seam — the `u<id>`
 * token scheme binds tokens to the seeded D1 rows), and asserts:
 *
 *   - the degenerate read surface: LIST renders the fixed three-name set in
 *     hookNames order with the embedded samples verbatim (git 2.43 template
 *     content; byte-exactness against /usr/share/git-core/templates/hooks/
 *     verified out-of-tree) and is_active false; an inactive post-receive
 *     OMITS content (modern git ships no post-receive.sample — the module
 *     header's divergence note 2);
 *   - the persistence contract: PATCH lands `githooks/<repo_id>/<hook_name>`
 *     with the `\r`-stripped copy (hook.go Update()'s write arm) while the
 *     PATCH RESPONSE carries the form content verbatim (the ported quirk —
 *     h.Content is never re-read after the write), a later GET returns the
 *     stripped stored copy, whitespace-empty content (or an absent field —
 *     Go's zero bind) deactivates by DELETING the object (hook.go:74-82),
 *     and DELETE restores the sample with no 404 arm for valid names;
 *   - the gates: reqToken 401 on every op, reqAdmin's exact 403 message
 *     (write collaborator denied; admin-mode collaborator and site admin
 *     pass), the anti-enumeration 404 for missing/invisible repos, and the
 *     ErrNotValidHook 404 (exact vocabulary, case-sensitive) for unknown ids;
 *   - the contract declaration: every arm's operationId and response set
 *     against the frozen contract JSON (the per-arm check:api verification,
 *     run in-test because the router.ts registration is the orchestrator's).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { repoCollaborators, repositories, users } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import {
  GIT_HOOK_NAMES,
  PRE_RECEIVE_SAMPLE,
  UPDATE_SAMPLE,
  registerGitHookRoutes,
} from "./git-hooks";
import { contract, type Swagger2Operation } from "../../compat/contract/frozen-contract";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["repo_collaborators", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The githooks/ prefix of the shared bucket — this batch's whole key space.
  let cursor: string | undefined;
  do {
    const page = await env.REPO_PACKS.list({ prefix: "githooks/", cursor });
    for (const object of page.objects) {
      await env.REPO_PACKS.delete(object.key);
    }
    cursor = page.truncated === true ? page.cursor : undefined;
  } while (cursor !== undefined);
  seededUsers.clear();
});

const db = () => drizzle(env.DB);

const ERROR_URL = "https://example.com/api/swagger";

// ---------------------------------------------------------------------------
// Auth rig — the `u<id>` token scheme (avatars.test.ts's pattern)
// ---------------------------------------------------------------------------

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

const seededUsers = new Map<number, SeededUser>();

async function seedUser(username: string, isAdmin = false): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin });
  return { id: user.id, username: user.username, isAdmin };
}

/** API `User` projection the resolver returns (the auth middleware's shape). */
function apiUser(user: SeededUser): User {
  return {
    id: user.id,
    login: user.username,
    email: `${user.username.toLowerCase()}@example.com`,
    full_name: "",
    avatar_url: "",
    html_url: "",
    language: "en-US",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: user.isAdmin,
    prohibit_login: false,
    restricted: false,
    login_name: "",
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: "2026-01-01T00:00:00Z",
    last_login: "0001-01-01T00:00:00Z",
    type: "User",
    visibility: "public",
  };
}

const resolver: AuthResolver = {
  resolveToken(token) {
    const match = /^u(\d+)$/.exec(token);
    const user = match === null ? undefined : seededUsers.get(Number(match[1]));
    if (match === null || user === undefined) return Promise.resolve(null);
    return Promise.resolve(apiUser(user));
  },
};

const authHeaders = (userId: number): Record<string, string> => ({
  Authorization: `token u${userId}`,
  "Content-Type": "application/json",
});

/** Local mount of exactly the orchestrator one-liner's seam. */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerGitHookRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

let repoSeq = 9100;

interface RepoSeed {
  slug: string;
  repoId: string;
}

/** One repo owned by `ownerName` (public by default). */
async function seedRepo(
  ownerName: string,
  ownerId: number,
  options: {
    visibility?: "public" | "private";
    collaborator?: { userId: number; mode: "read" | "write" | "admin" };
  } = {},
): Promise<RepoSeed> {
  const repoId = String(repoSeq++);
  const slug = `hookrepo${repoId}`;
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: ownerName,
    ownerId,
    slug,
    visibility: options.visibility ?? "public",
    isArchived: false,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  if (options.collaborator !== undefined) {
    await db()
      .insert(repoCollaborators)
      .values({ repoId, userId: options.collaborator.userId, mode: options.collaborator.mode });
  }
  return { slug, repoId };
}

// ---------------------------------------------------------------------------
// The embedded samples — structural sanity (byte-exactness against the git
// template dir is verified out-of-tree; see the file header)
// ---------------------------------------------------------------------------

describe("embedded samples (the git template constants)", () => {
  it("carries the canonical shell-script samples for pre-receive and update", () => {
    expect(PRE_RECEIVE_SAMPLE.startsWith("#!/bin/sh\n")).toBe(true);
    expect(PRE_RECEIVE_SAMPLE).toContain('rename this file to "pre-receive"');
    expect(PRE_RECEIVE_SAMPLE).toContain("${value#*=}");
    expect(UPDATE_SAMPLE.startsWith("#!/bin/sh\n")).toBe(true);
    expect(UPDATE_SAMPLE).toContain('rename this file to "update"');
    expect(UPDATE_SAMPLE).toContain("${refname##refs/tags/}");
  });

  it("ships the hookNames vocabulary in upstream order (hook.go:19-23)", () => {
    expect([...GIT_HOOK_NAMES]).toEqual(["pre-receive", "update", "post-receive"]);
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/hooks/git (repoListGitHooks) — the degenerate read
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/hooks/git (repoListGitHooks)", () => {
  it("lists the three hooks in hookNames order with samples verbatim, inactive", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git`, { headers: authHeaders(alice.id) });
    expect(res.status).toBe(200);
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body).toEqual([
      { name: "pre-receive", is_active: false, content: PRE_RECEIVE_SAMPLE },
      { name: "update", is_active: false, content: UPDATE_SAMPLE },
      { name: "post-receive", is_active: false }, // no sample on modern git → omitempty
    ]);
    expect("content" in body[2]!).toBe(false);
    expect(await env.REPO_PACKS.list({ prefix: `githooks/${repo.repoId}/` })).toHaveProperty("objects.length", 0);
  });

  it("marks an edited hook active and renders the stored copy", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    await env.REPO_PACKS.put(`githooks/${repo.repoId}/update`, "#!/bin/sh\nexit 1\n");
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git`, { headers: authHeaders(alice.id) });
    expect(res.status).toBe(200);
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body[1]).toEqual({ name: "update", is_active: true, content: "#!/bin/sh\nexit 1\n" });
    // The untouched neighbors stay sample-backed.
    expect(body[0]).toMatchObject({ name: "pre-receive", is_active: false });
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/hooks/git/{id} (repoGetGitHook)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/hooks/git/{id} (repoGetGitHook)", () => {
  it("returns the sample verbatim for a fresh hook", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git/pre-receive`, {
      headers: authHeaders(alice.id),
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({
      name: "pre-receive",
      is_active: false,
      content: PRE_RECEIVE_SAMPLE,
    });
  });

  it("omits content for an inactive post-receive (no sample on modern git)", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git/post-receive`, {
      headers: authHeaders(alice.id),
    });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body).toEqual({ name: "post-receive", is_active: false });
    expect("content" in body).toBe(false);
  });

  it("404s an unknown id with the plain shared body (ErrNotValidHook arm)", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git/nope`, { headers: authHeaders(alice.id) });
    expect(res.status).toBe(404);
    expect(await jsonBody(res)).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("is case-sensitive like IsValidHookName (Update is not update)", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git/Update`, { headers: authHeaders(alice.id) });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /repos/{owner}/{repo}/hooks/git/{id} (repoEditGitHook) — persistence
// ---------------------------------------------------------------------------

describe("PATCH /repos/{owner}/{repo}/hooks/git/{id} (repoEditGitHook)", () => {
  it("persists the \\r-stripped copy but answers the form content verbatim (ported quirk)", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    const form = "#!/bin/sh\r\necho hi\r\n";
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git/pre-receive`, {
      method: "PATCH",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ content: form }),
    });
    expect(res.status).toBe(200);
    // The response carries h.Content — the form text AS-SENT (hook.go:141-147).
    expect(await jsonBody(res)).toEqual({ name: "pre-receive", is_active: true, content: form });
    // The stored object is the file Update() wrote — \r stripped (hook.go:88).
    const stored = await env.REPO_PACKS.get(`githooks/${repo.repoId}/pre-receive`);
    expect(stored).not.toBeNull();
    expect(await stored?.text()).toBe("#!/bin/sh\necho hi\n");
    // A later GET reads the stripped copy back (the file on disk upstream).
    const got = await router()(`/repos/alice/${repo.slug}/hooks/git/pre-receive`, {
      headers: authHeaders(alice.id),
    });
    expect(await jsonBody(got)).toEqual({ name: "pre-receive", is_active: true, content: "#!/bin/sh\necho hi\n" });
  });

  it("deactivates on whitespace-only content and removes the object (hook.go:74-82)", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    await env.REPO_PACKS.put(`githooks/${repo.repoId}/update`, "old");
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git/update`, {
      method: "PATCH",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ content: "  \r\n\t " }),
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ name: "update", is_active: false, content: UPDATE_SAMPLE });
    expect(await env.REPO_PACKS.head(`githooks/${repo.repoId}/update`)).toBeNull();
  });

  it("binds an absent content field to Go's zero (same remove arm)", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git/post-receive`, {
      method: "PATCH",
      headers: authHeaders(alice.id),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ name: "post-receive", is_active: false });
    expect(await env.REPO_PACKS.head(`githooks/${repo.repoId}/post-receive`)).toBeNull();
  });

  it("404s an unknown id before touching the bucket", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git/bogus`, {
      method: "PATCH",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(404);
    expect((await env.REPO_PACKS.list({ prefix: "githooks/" })).objects).toHaveLength(0);
  });

  it("maps bind failures to the upstream statuses (400 malformed, 422 invalid)", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    // Malformed JSON never reaches the bind: hono's reader 400s first — the
    // landed divergence (the /markdown RUNTIME_ONLY precedent).
    const malformed = await router()(`/repos/alice/${repo.slug}/hooks/git/update`, {
      method: "PATCH",
      headers: authHeaders(alice.id),
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect((await jsonBody(malformed)).message).toBe("Malformed JSON in request body");
    // A schema-invalid body (content: 42) goes through the bind hook's 422.
    const invalid = await router()(`/repos/alice/${repo.slug}/hooks/git/update`, {
      method: "PATCH",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ content: 42 }),
    });
    expect(invalid.status).toBe(422);
    expect(await jsonBody(invalid)).toEqual({ message: "invalid request body", url: ERROR_URL });
  });

  // --- the deferred-polish bind shapes (EditGitHookOption's wire boundary) ---

  it("422s a null content field (the zod bind rejects null; upstream's Go bind would zero it)", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    // structs/git_hook.go:20-23's Content is a PLAIN string — Go's
    // encoding/json leaves a null field at its zero (""), which would ride
    // the remove arm (hook.go:74-82). The landed bind is z.string().optional()
    // (git-hooks.ts editGitHookOptionSchema): null is neither string nor
    // absent, so bindValidationHook answers the 422 — the pinned landed
    // posture at this wire shape.
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git/update`, {
      method: "PATCH",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ content: null }),
    });
    expect(res.status).toBe(422);
    expect(await jsonBody(res)).toEqual({ message: "invalid request body", url: ERROR_URL });
    // Nothing stored — the bind refused before the handler touched R2.
    expect(await env.REPO_PACKS.head(`githooks/${repo.repoId}/update`)).toBeNull();
  });

  it("deactivates on the exact empty string (the trim arm's zero boundary)", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    await env.REPO_PACKS.put(`githooks/${repo.repoId}/pre-receive`, "old");
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git/pre-receive`, {
      method: "PATCH",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ content: "" }),
    });
    expect(res.status).toBe(200);
    // TrimSpace("") is empty — the same remove arm hook.go:74-82 rides for
    // the whitespace-only twin above; the sample falls back (with content:
    // pre-receive's sample is non-empty, unlike post-receive's).
    expect(await jsonBody(res)).toEqual({ name: "pre-receive", is_active: false, content: PRE_RECEIVE_SAMPLE });
    expect(await env.REPO_PACKS.head(`githooks/${repo.repoId}/pre-receive`)).toBeNull();
  });

  it("binds the body BEFORE the unknown-id 404 answers (upstream's router-level web.Bind order)", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    // Upstream binds EditGitHookOption at the router (web.Bind runs before
    // the handler body reaches GetHook's ErrNotValidHook): a schema-invalid
    // body answers the bind 422 even against a non-vocabulary id.
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git/bogus`, {
      method: "PATCH",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ content: 42 }),
    });
    expect(res.status).toBe(422);
    expect(await jsonBody(res)).toEqual({ message: "invalid request body", url: ERROR_URL });
    expect((await env.REPO_PACKS.list({ prefix: "githooks/" })).objects).toHaveLength(0);
  });

  it("keys the edit per hook name — a pre-receive PATCH leaves update sample-backed", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    const patched = await router()(`/repos/alice/${repo.slug}/hooks/git/pre-receive`, {
      method: "PATCH",
      headers: authHeaders(alice.id),
      body: JSON.stringify({ content: "#!/bin/sh\nonly pre-receive\n" }),
    });
    expect(patched.status).toBe(200);
    // The neighbor hook never saw the write (the githooks/<repo>/<name> keys
    // are per name — the LIST renders exactly one active row).
    const list = await router()(`/repos/alice/${repo.slug}/hooks/git`, { headers: authHeaders(alice.id) });
    const body = await list.json<Array<Record<string, unknown>>>();
    expect(body[0]).toEqual({ name: "pre-receive", is_active: true, content: "#!/bin/sh\nonly pre-receive\n" });
    expect(body[1]).toEqual({ name: "update", is_active: false, content: UPDATE_SAMPLE });
    expect(await env.REPO_PACKS.head(`githooks/${repo.repoId}/update`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DELETE /repos/{owner}/{repo}/hooks/git/{id} (repoDeleteGitHook) — back to
// the sample; no 404 arm for a valid name
// ---------------------------------------------------------------------------

describe("DELETE /repos/{owner}/{repo}/hooks/git/{id} (repoDeleteGitHook)", () => {
  it("removes the stored edit, restores the sample, and stays 204 when absent", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    await env.REPO_PACKS.put(`githooks/${repo.repoId}/update`, "#!/bin/sh\ntrue\n");
    const first = await router()(`/repos/alice/${repo.slug}/hooks/git/update`, {
      method: "DELETE",
      headers: authHeaders(alice.id),
    });
    expect(first.status).toBe(204);
    expect(await env.REPO_PACKS.head(`githooks/${repo.repoId}/update`)).toBeNull();
    const got = await router()(`/repos/alice/${repo.slug}/hooks/git/update`, { headers: authHeaders(alice.id) });
    expect(await jsonBody(got)).toEqual({ name: "update", is_active: false, content: UPDATE_SAMPLE });
    // Upstream has no 404 arm for a valid name: GetHook succeeds via the
    // sample fallback, Update() removes nothing (git_hook.go:179-196).
    const second = await router()(`/repos/alice/${repo.slug}/hooks/git/update`, {
      method: "DELETE",
      headers: authHeaders(alice.id),
    });
    expect(second.status).toBe(204);
  });

  it("404s an unknown id", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    const res = await router()(`/repos/alice/${repo.slug}/hooks/git/pre`, {
      method: "DELETE",
      headers: authHeaders(alice.id),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Gates — reqToken, reqAdmin (exact message), repo assignment
// ---------------------------------------------------------------------------

describe("gates", () => {
  it("401s anonymous callers on every op (upstream reqToken)", async () => {
    const alice = await seedUser("alice");
    const repo = await seedRepo("alice", alice.id);
    const base = `/repos/alice/${repo.slug}/hooks/git`;
    expect((await router()(base)).status).toBe(401);
    expect((await router()(`${base}/update`)).status).toBe(401);
    expect(
      (await router()(`${base}/update`, { method: "PATCH", body: JSON.stringify({ content: "x" }) })).status,
    ).toBe(401);
    expect((await router()(`${base}/update`, { method: "DELETE" })).status).toBe(401);
  });

  it("403s a write collaborator with reqAdmin's exact message on every op", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const repo = await seedRepo("alice", alice.id, { collaborator: { userId: bob.id, mode: "write" } });
    const base = `/repos/alice/${repo.slug}/hooks/git`;
    const expected = { message: "user should be an owner or a collaborator with admin write of a repository", url: ERROR_URL };
    expect(await jsonBody(await router()(base, { headers: authHeaders(bob.id) }))).toEqual(expected);
    expect(await jsonBody(await router()(`${base}/update`, { headers: authHeaders(bob.id) }))).toEqual(expected);
    const patch = await router()(`${base}/update`, {
      method: "PATCH",
      headers: authHeaders(bob.id),
      body: JSON.stringify({ content: "x" }),
    });
    expect(await jsonBody(patch)).toEqual(expected);
    expect(await jsonBody(await router()(`${base}/update`, { method: "DELETE", headers: authHeaders(bob.id) }))).toEqual(
      expected,
    );
    expect((await env.REPO_PACKS.list({ prefix: "githooks/" })).objects).toHaveLength(0);
  });

  it("lets an admin-mode collaborator and the site admin through", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const admin = await seedUser("site-admin", true);
    const repo = await seedRepo("alice", alice.id, { collaborator: { userId: bob.id, mode: "admin" } });
    const base = `/repos/alice/${repo.slug}/hooks/git`;
    expect((await router()(base, { headers: authHeaders(bob.id) })).status).toBe(200);
    const patch = await router()(`${base}/update`, {
      method: "PATCH",
      headers: authHeaders(admin.id),
      body: JSON.stringify({ content: "#!/bin/sh\ntrue\n" }),
    });
    expect(patch.status).toBe(200);
    expect((await router()(`${base}/update`, { method: "DELETE", headers: authHeaders(bob.id) })).status).toBe(204);
  });

  it("404s an unknown repo and an invisible private repo (anti-enumeration)", async () => {
    const alice = await seedUser("alice");
    const outsider = await seedUser("outsider");
    const priv = await seedRepo("alice", alice.id, { visibility: "private" });
    const hidden = await router()(`/repos/alice/${priv.slug}/hooks/git`, { headers: authHeaders(outsider.id) });
    expect(hidden.status).toBe(404);
    const missing = await router()(`/repos/alice/ghost/hooks/git`, { headers: authHeaders(alice.id) });
    expect(missing.status).toBe(404);
    expect(await jsonBody(missing)).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("scopes edits per repo id (no cross-repo leakage)", async () => {
    const alice = await seedUser("alice");
    const repoA = await seedRepo("alice", alice.id);
    const repoB = await seedRepo("alice", alice.id);
    await env.REPO_PACKS.put(`githooks/${repoA.repoId}/update`, "A-only");
    const listB = await router()(`/repos/alice/${repoB.slug}/hooks/git`, { headers: authHeaders(alice.id) });
    const bodyB = await listB.json<Array<Record<string, unknown>>>();
    expect(bodyB[1]).toEqual({ name: "update", is_active: false, content: UPDATE_SAMPLE });
  });
});

// ---------------------------------------------------------------------------
// Contract declaration — the per-arm check:api verification (run here because
// the router.ts registration is the orchestrator's)
// ---------------------------------------------------------------------------

describe("contract declaration", () => {
  /** The arms grouped per path item (the list path carries get only). */
  const LIST_ARMS = [["get", "/repos/{owner}/{repo}/hooks/git"]] as const;
  const ID_ARMS = [
    ["get", "/repos/{owner}/{repo}/hooks/git/{id}"],
    ["patch", "/repos/{owner}/{repo}/hooks/git/{id}"],
    ["delete", "/repos/{owner}/{repo}/hooks/git/{id}"],
  ] as const;

  /** The lookups stay inline above (literal method/path types per loop
   *  element); this helper does the structural assertions on the pair. */
  function assertArm(
    label: string,
    declared: { operationId?: string; responses?: Record<string, unknown> } | undefined,
    expected: Swagger2Operation | undefined,
  ): void {
    expect(declared, label).toBeDefined();
    if (expected === undefined) {
      throw new Error(`contract is missing ${label}`);
    }
    expect(declared?.operationId).toBe(expected.operationId);
    const contractCodes = Object.keys(expected.responses ?? {});
    for (const code of Object.keys(declared?.responses ?? {})) {
      expect(contractCodes, `${label} response ${code}`).toContain(code);
    }
  }

  it("declares every arm with the contract's operationId and a response subset", () => {
    const app = new OpenAPIHono<ApiEnv>();
    registerGitHookRoutes(app, createTokenAuthMiddleware(resolver));
    const doc = app.getOpenAPIDocument({
      openapi: "3.0.3",
      info: { title: "Gitea API", version: "test" },
    });
    for (const [method, path] of LIST_ARMS) {
      assertArm(`${method.toUpperCase()} ${path}`, doc.paths?.[path]?.[method], contract.paths[path]?.[method]);
    }
    for (const [method, path] of ID_ARMS) {
      assertArm(`${method.toUpperCase()} ${path}`, doc.paths?.[path]?.[method], contract.paths[path]?.[method]);
    }
  });

  it("declares exactly the two contract git-hook paths, four operations", () => {
    const app = new OpenAPIHono<ApiEnv>();
    registerGitHookRoutes(app, createTokenAuthMiddleware(resolver));
    const doc = app.getOpenAPIDocument({
      openapi: "3.0.3",
      info: { title: "Gitea API", version: "test" },
    });
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      "/repos/{owner}/{repo}/hooks/git",
      "/repos/{owner}/{repo}/hooks/git/{id}",
    ]);
    const methods = Object.values(doc.paths ?? {}).flatMap((item) => Object.keys(item));
    expect(methods).toHaveLength(4);
  });
});
