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
 * replicateRepoCopy). The copy arms cover BOTH content classes the shared
 * pass must move: packed (the push template) and LOOSE — the auto_init
 * producer (REDEPLOY12's captured 500: `finalizeForkImport: object not
 * imported: <tip> (refs/heads/main)` — Worker-authored objects live outside
 * the pack catalog), plus the mixed shape. Also the REDEPLOY11 failure
 * contract: a copy that cannot converge (storage bytes gone) 500s WITHOUT
 * stranding the created row (upstream's cleanupRepository,
 * template.go:102-108). The `.gitea/template` variable substitution is out of
 * slice (api/services/generate-repo.ts module header) and has no test arm.
 */

import { applyD1Migrations, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { replicateRepoCopy } from "../../repos/fork-task";
import { RepoService } from "../../repos/service";
import { buildPack, buildReceivePackBody } from "../../repos/testing/git-pack";
import { users } from "../../db/schema";
import { createUserRepository } from "../services/user-repos";
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

/** The full `users` row behind a seeded identity (the auto-init producer's
 *  git-signature fields ride it). */
async function userRowOf(username: string) {
  const row = await drizzle(env.DB)
    .select()
    .from(users)
    .where(eq(users.usernameLower, username))
    .limit(1)
    .then((rows) => rows[0]);
  if (row === undefined) throw new Error(`seeded user ${username} not found`);
  return row;
}

/** Create a repo through the REAL `POST /user/repos` service arm — the
 *  auto_init commit lands through putApiObjects + commitApiChange, i.e. as
 *  LOOSE objects with zero pack-catalog rows (the production producer shape
 *  behind REDEPLOY12's captured generate 500). */
async function autoInitTemplate(owner: string, slug: string): Promise<{ commitOid: string; repoId: string }> {
  const row = await createUserRepository(env.DB, env, await userRowOf(owner), { name: slug, auto_init: true }, new Date());
  const cell = env.REPO.getByName(`${owner}/${slug}`);
  const refs = await cell.listRefs();
  expect(refs.refs.map((r) => r.name)).toEqual(["refs/heads/main"]);
  const mainTip = refs.refs.find((r) => r.name === "refs/heads/main");
  if (mainTip === undefined) throw new Error("auto-init main ref missing");
  // the producer sanity: the tip is loose — the pack catalog serves nothing
  const page = await cell.listCatalogPage("", 10);
  expect(page.packs).toEqual([]);
  return { commitOid: mainTip.target, repoId: row.id };
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

  // REDEPLOY11 open issue 1: a failing content copy used to strand the
  // created row at status='creating' behind the 500. Upstream's contract is
  // GenerateRepository's `defer cleanupRepository(generateRepo)`
  // (services/repository/template.go:102-108 → DeleteRepositoryDirectly,
  // create.go:448-455): the half-made repo is DELETED, never left behind.
  it("deletes the created row when the content copy fails (no 'creating' strand)", { timeout: 120_000 }, async () => {
    await seedIdentities();
    const service = new RepoService(env.DB);
    // Fresh names: the engine DO cells and R2 objects persist across this
    // file's tests (beforeEach clears D1 only), so reused names would let
    // the copy read a prior test's surviving packs past the sabotage.
    const template = await pushTemplateContent("alice", "tpl-strand", "trunk");
    await markTemplate("alice", "tpl-strand");

    // Sabotage the copy's input: wipe the template's stored pack bytes from
    // R2 (catalog rows live in the DO, so listCatalogPage still serves the
    // pack and copyObject's bucket.get misses — "fork copy: source object
    // missing"). The retry re-throws; the cleanup arm then runs.
    const row = await service.get(template.repoId);
    const page = await env.REPO.getByName("alice/tpl-strand").listCatalogPage("", 10);
    await env.REPO_PACKS.delete(
      page.packs.flatMap((p) => [
        `repos/${row!.storageKey}/packs/${p.packKey}.pack`,
        `repos/${row!.storageKey}/packs/${p.packKey}.idx`,
      ]),
    );

    const res = await router()(
      "/api/v1/repos/alice/tpl-strand/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "copy-strand", git_content: true }) }),
    );
    expect(res.status).toBe(500);
    // The strand is gone: no 'creating' row survives a failed generate (and
    // the name is immediately reusable — a retry starts from a clean slate).
    expect(await service.getBySlug("alice", "copy-strand")).toBeNull();
  });

  // REDEPLOY12's captured producer (docs/design/p0-evidence.md, OPEN ISSUE 1):
  // `POST /user/repos` with auto_init lands refs/heads/main as a LOOSE commit
  // (putApiObjects + commitApiChange — zero pack-catalog rows). The shared
  // copy pass used to replicate the pack catalog only, so finalize's
  // store.has found no `02f68bc4ca0e…` and the generate 500ed (verbatim:
  // `finalizeForkImport: object not imported: <tip> (refs/heads/main)`). The
  // contract here: the copy must carry the loose class too — 201, the
  // template's tip adopted into the generated cell, ready-non-empty.
  it("copies an auto_init template (loose-object content, the REDEPLOY12 producer)", { timeout: 120_000 }, async () => {
    await seedIdentities();
    const { commitOid } = await autoInitTemplate("alice", "tpl-init");
    await markTemplate("alice", "tpl-init");

    const res = await router()(
      "/api/v1/repos/alice/tpl-init/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "copy-init", git_content: true }) }),
    );
    expect(res.status).toBe(201);

    const service = new RepoService(env.DB);
    const row = await service.getBySlug("alice", "copy-init");
    expect(row?.status).toBe("ready");
    expect(row?.isEmpty).toBe(false);
    const refs = await env.REPO.getByName("alice/copy-init").listRefs();
    expect(refs.refs).toEqual([{ name: "refs/heads/main", target: commitOid }]);
    // the tip RESOLVES in the generated cell (finalize's own store.has bar)
    expect(await env.REPO.getByName("alice/copy-init").readCommit(commitOid)).not.toBeNull();
  });

  // Both classes in one copy: auto_init's loose main + a pushed (packed)
  // branch. The loose walk must skip the packed closure and finalize must
  // accept both tips.
  it("copies a mixed template (loose main + pushed branch)", { timeout: 120_000 }, async () => {
    await seedIdentities();
    const { commitOid } = await autoInitTemplate("alice", "tpl-mixed");
    const pushed = await pushTemplateContent("alice", "tpl-mixed", "feature");
    await markTemplate("alice", "tpl-mixed");

    const res = await router()(
      "/api/v1/repos/alice/tpl-mixed/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "copy-mixed", git_content: true }) }),
    );
    expect(res.status).toBe(201);
    const row = await new RepoService(env.DB).getBySlug("alice", "copy-mixed");
    expect(row?.status).toBe("ready");
    expect(row?.isEmpty).toBe(false);
    const refs = await env.REPO.getByName("alice/copy-mixed").listRefs();
    expect([...refs.refs].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "refs/heads/feature", target: pushed.oid },
      { name: "refs/heads/main", target: commitOid },
    ]);
    expect(await env.REPO.getByName("alice/copy-mixed").readCommit(commitOid)).not.toBeNull();
  });

  // The shared pass itself (the fork queue consumer rides the same function —
  // src/repos/fork-task.ts handleForkMessage), driven at the service level on
  // the loose producer: the fork of an auto_init repo must converge too.
  it("replicateRepoCopy carries an auto_init source into a fork cell", { timeout: 120_000 }, async () => {
    await seedIdentities();
    const { commitOid } = await autoInitTemplate("alice", "tpl-forksrc");
    const service = new RepoService(env.DB);
    const fork = await service.create({ owner: { id: (await userIdOf("alice"))!, usernameLower: "alice" }, name: "fork-init", isPrivate: false });

    await replicateRepoCopy(env, (await service.get((await service.getBySlug("alice", "tpl-forksrc"))!.id))!, fork);

    const refs = await env.REPO.getByName("alice/fork-init").listRefs();
    expect(refs.refs).toEqual([{ name: "refs/heads/main", target: commitOid }]);
    expect(await env.REPO.getByName("alice/fork-init").readCommit(commitOid)).not.toBeNull();
  });
});
