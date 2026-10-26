/**
 * `POST /repos/{template_owner}/{template_repo}/generate` (generateRepo —
 * long-tail batch), route-level on real D1 + real engine DOs/R2 (the
 * push-create.test.ts seeding convention: the template's git content arrives
 * through a real receive-pack push).
 *
 * Matrix: the upstream guard order (404 anti-enum → 422 not-a-template → 422
 * no-item-selected → owner resolution 404 {error}/403 → 409/422 from the
 * create), the 201 happy paths (empty template; generated FOR another user
 * by a site admin), and the content-copy integration: a non-empty template
 * with git_content=true settles the generated repo ready-non-empty with the
 * template's refs adopted into its own cell (the shared fork machinery —
 * replicateRepoCopy). The `.gitea/template` variable substitution is out of
 * slice (api/services/generate-repo.ts module header) and has no test arm.
 */

import { applyD1Migrations, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { RepoService } from "../../repos/service";
import { buildPack, buildReceivePackBody } from "../../repos/testing/git-pack";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import type { ApiEnv } from "../env";
import { giteaErrorHandler } from "../errors";
import { registerGenerateRepoRoute } from "./generate-repo";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "personal_access_tokens",
    "repo_license",
    "repo_settings",
    "repo_units",
    "repo_redirects",
    "repo_counters",
    "repositories",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

const ALICE_TOKEN = "token-alice";
const CHIEF_TOKEN = "token-chief";

let resolver: AuthResolver = { resolveToken: () => Promise.resolve(null) };

/** Standalone mount (paths strip the /api/v1 prefix); the resolver is built
 *  per-test from the seeded users. */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerGenerateRepoRoute(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const authed = (token: string, init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${token}`, "Content-Type": "application/json" },
});

const aliceAuth = (init?: RequestInit): RequestInit => authed(ALICE_TOKEN, init);

/** Seed alice + chief and wire the token resolver to them. */
async function seedIdentities(): Promise<{ aliceId: number }> {
  const alice = await seedVerifiedUser({ username: "alice" });
  await seedVerifiedUser({ username: "chief", isAdmin: true });
  resolver = {
    resolveToken: (token: string) =>
      Promise.resolve(
        token === ALICE_TOKEN
          ? { id: alice.id, login: "alice", is_admin: false }
          : token === CHIEF_TOKEN
            ? { id: 0, login: "chief", is_admin: true }
            : null,
      ),
  };
  return { aliceId: alice.id };
}

/** Mark a repo a template (the API has no template-flag flip yet — upstream
 *  sets it via the web-UI settings, out of the frozen contract). */
async function markTemplate(owner: string, slug: string): Promise<void> {
  await env.DB.prepare("UPDATE repositories SET is_template = 1 WHERE owner_namespace = ? AND slug = ?")
    .bind(owner, slug)
    .run();
}

async function createTemplate(slug: string): Promise<void> {
  await new RepoService(env.DB).create({
    owner: { id: (await userIdOf("alice")) ?? 0, usernameLower: "alice" },
    name: slug,
    isPrivate: false,
  });
  await markTemplate("alice", slug);
}

async function userIdOf(username: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT id FROM users WHERE username_lower = ?").bind(username).first<{ id: number }>();
  return row?.id ?? null;
}

/** Push one real commit to `owner/slug` on refs/heads/<branch> (the
 *  push-create path, authenticated by alice's minted PAT) and settle the
 *  row — the non-empty template. */
async function pushTemplateContent(owner: string, slug: string, branch: string): Promise<{ oid: string; repoId: string }> {
  const aliceId = (await userIdOf(owner))!;
  const token = (await mintFor(aliceId, "push", "write:repository")).plaintext;
  const { oid, pack } = await buildPack();
  const body = buildReceivePackBody([{ ref: `refs/heads/${branch}`, oid }], pack);
  const response = await SELF.fetch(`https://example.com/${owner}/${slug}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body,
  });
  expect(response.status).toBe(200);
  const service = new RepoService(env.DB);
  const creating = await service.getBySlug(owner, slug);
  if (creating) await settleCreatingRepo(env, creating.id, `${owner}/${slug}`);
  const settled = await service.getBySlug(owner, slug);
  expect(settled?.status).toBe("ready");
  expect(settled?.isEmpty).toBe(false);
  return { oid, repoId: settled!.id };
}

describe("generateRepo guards (upstream order)", () => {
  it("404s a missing template (anti-enumeration) and 401s an anonymous caller", async () => {
    await seedIdentities();
    const missing = await router()(
      "/api/v1/repos/alice/ghost/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "x", git_content: true }) }),
    );
    expect(missing.status).toBe(404);

    const anon = await router()("/api/v1/repos/alice/ghost/generate", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(anon.status).toBe(401);
  });

  it("422s a non-template repo with upstream's exact text", async () => {
    await seedIdentities();
    await new RepoService(env.DB).create({ owner: { id: (await userIdOf("alice"))!, usernameLower: "alice" }, name: "plain", isPrivate: false });
    const res = await router()(
      "/api/v1/repos/alice/plain/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "gen", git_content: true }) }),
    );
    expect(res.status).toBe(422);
    expect((await res.json<{ message: string }>()).message).toBe("this is not a template repo");
  });

  it("422s when no template item is selected (IsValid)", async () => {
    await seedIdentities();
    await createTemplate("tpl");
    const res = await router()(
      "/api/v1/repos/alice/tpl/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "gen" }) }),
    );
    expect(res.status).toBe(422);
    expect((await res.json<{ message: string }>()).message).toBe("must select at least one template item");
  });

  it("404s an unknown target owner with upstream's raw {error} body", async () => {
    await seedIdentities();
    await createTemplate("tpl");
    const res = await router()(
      "/api/v1/repos/alice/tpl/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "gen", owner: "ghost", topics: true }) }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "request owner `ghost` does not exist" });
  });

  it("403s a non-admin generating for another individual user", async () => {
    await seedIdentities();
    await seedVerifiedUser({ username: "bob" });
    await createTemplate("tpl");
    const res = await router()(
      "/api/v1/repos/alice/tpl/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "gen", owner: "bob", topics: true }) }),
    );
    expect(res.status).toBe(403);
    expect((await res.json<{ message: string }>()).message).toBe("Only admin can generate repository for other user.");
  });

  it("409s an existing name with the contract's exact text", async () => {
    await seedIdentities();
    const service = new RepoService(env.DB);
    await createTemplate("tpl");
    await service.create({ owner: { id: (await userIdOf("alice"))!, usernameLower: "alice" }, name: "taken", isPrivate: false });
    const res = await router()(
      "/api/v1/repos/alice/tpl/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "taken", topics: true }) }),
    );
    expect(res.status).toBe(409);
    expect((await res.json<{ message: string }>()).message).toBe("The repository with the same name already exists.");
  });

  it("422s an unusable repo name (the create's name validation)", async () => {
    await seedIdentities();
    await createTemplate("tpl");
    const res = await router()(
      "/api/v1/repos/alice/tpl/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "with space", topics: true }) }),
    );
    expect(res.status).toBe(422);
    expect((await res.json<{ message: string }>()).message).toBe("repository name is not allowed: with space");
  });
});

describe("generateRepo creation", () => {
  it("201: generates an empty repo from an empty template, carrying the form metadata", async () => {
    const { aliceId } = await seedIdentities();
    const service = new RepoService(env.DB);
    await createTemplate("tpl");

    const res = await router()(
      "/api/v1/repos/alice/tpl/generate",
      aliceAuth({
        method: "POST",
        body: JSON.stringify({ name: "Generated", git_content: true, description: "my desc", default_branch: "trunk" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ name: string; owner: { login: string }; private: boolean; fork: boolean; default_branch: string }>();
    expect(body.name).toBe("generated"); // the create lowercases (the slug)
    expect(body.owner.login).toBe("alice");
    expect(body.private).toBe(false);
    expect(body.fork).toBe(false);

    const row = await service.getBySlug("alice", "generated");
    expect(row?.status).toBe("ready");
    expect(row?.isEmpty).toBe(true); // template was empty — nothing to copy
    expect(row?.isTemplate).toBe(false); // generated repos are not templates
    expect(row?.defaultBranch).toBe("trunk"); // the form's branch wins
    expect(row?.ownerId).toBe(aliceId);
    const desc = await env.DB.prepare("SELECT description FROM repo_settings WHERE repo_id = ?")
      .bind(row!.id)
      .first<{ description: string }>();
    expect(desc?.description).toBe("my desc");
  });

  it("201: a site admin generates FOR another user", async () => {
    await seedIdentities();
    const bob = await seedVerifiedUser({ username: "bob" });
    const service = new RepoService(env.DB);
    await createTemplate("tpl");

    const res = await router()(
      "/api/v1/repos/alice/tpl/generate",
      authed(CHIEF_TOKEN, {
        method: "POST",
        body: JSON.stringify({ name: "for-bob", owner: "bob", topics: true, private: true }),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ owner: { login: string }; private: boolean }>();
    expect(body.owner.login).toBe("bob");
    expect(body.private).toBe(true);
    const row = await service.getBySlug("bob", "for-bob");
    expect(row?.ownerId).toBe(bob.id);
    expect(row?.visibility).toBe("private");
  });
});

describe("generateRepo content copy (the shared fork machinery)", () => {
  // The engine-heavy arm (a real receive-pack push + a full catalog
  // replication) — the explicit timeout absorbs full-suite contention (136
  // isolated workerd workers), where the 5s default spuriously expires.
  it("copies a non-empty template's refs into the generated repo and settles ready-non-empty", { timeout: 120_000 }, async () => {
    await seedIdentities();
    // The template arrives through a REAL receive-pack push (push-create).
    const { oid } = await pushTemplateContent("alice", "tpl", "trunk");
    await markTemplate("alice", "tpl");

    const res = await router()(
      "/api/v1/repos/alice/tpl/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "copy", git_content: true }) }),
    );
    expect(res.status).toBe(201);

    const service = new RepoService(env.DB);
    const row = await service.getBySlug("alice", "copy");
    expect(row?.status).toBe("ready");
    expect(row?.isEmpty).toBe(false);
    // The generated repo's own cell adopted the template's refs.
    const refs = await env.REPO.getByName("alice/copy").listRefs();
    expect(refs.refs.map((r) => ({ name: r.name, target: r.target }))).toEqual([
      { name: "refs/heads/trunk", target: oid },
    ]);
  });
});
