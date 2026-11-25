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
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { labels, protectedBranches, repoTopics, repositories, webhooks } from "../../db/schema";
import { emptyRuleConfig, serializeRuleConfig } from "../../services/branch-protection";
import { settleCreatingRepo } from "../../git-http/gate";
import { replicateRepoCopy } from "../../repos/fork-task";
import { RepoService } from "../../repos/service";
import { buildPack, buildReceivePackBody, pktLine, ZERO_OID, drainReceive } from "../../repos/testing/git-pack";
import { users } from "../../db/schema";
import { createUserRepository } from "../services/user-repos";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import type { ApiEnv } from "../env";
import { giteaErrorHandler } from "../errors";
import { registerGenerateRepoRoute } from "./generate-repo";
import { registerTagRoutes } from "./tags";

// wave-129 full-run contention budget: this file's heaviest closure measured
// 4.72s of the 30s default IN a green 8-worker full run (the generateRepo
// content-copy arms over the shared fork machinery; the suite's 260-isolate
// spawn storm spikes closures up to ~12x their solo time). File-local 90s
// budgets; vitest.config.ts keeps 30s for every other file. Membership: the
// measured >=4s in-run closure/hook set (full-suite junit run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

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
 *  per-test from the seeded users. The tags family rides along so the loose
 *  annotated-tag arms can create tags through the REAL tags API. */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerGenerateRepoRoute(app, createTokenAuthMiddleware(resolver));
  registerTagRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
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
  // SPEC 0230: the streaming answer resolves before the push applies;
  // drain to stream end — the arm closes strictly after finalize's
  // transaction, so stream end is the push-completion signal
  await drainReceive(response);
  const service = new RepoService(env.DB);
  const creating = await service.getBySlug(owner, slug);
  if (creating) await settleCreatingRepo(env, creating.id, `${owner}/${slug}`);
  const settled = await service.getBySlug(owner, slug);
  expect(settled?.status).toBe("ready");
  expect(settled?.isEmpty).toBe(false);
  return { oid, repoId: settled!.id };
}

// ---- the STACKED-push shape (REDEPLOY13 OPEN ISSUE 1's producer) -----------
//
// The production template: `POST /user/repos` auto_init (the loose commit A)
// followed by a REAL git push whose commit B descends from A. The client's
// thin-pack negotiation excludes everything under the advertised tip A, so
// the pushed pack contains B's closure only and B's PARENT line names A —
// an object that stays LOOSE in the template, outside every pack, and is
// referenced by no ref tip. The local builders below reproduce exactly that
// pack shape (full entries, parent → the loose oid).

const RECEIVE_CT = "application/x-git-receive-pack-request";
const UPLOAD_CT = "application/x-git-upload-pack-request";

async function sha1Hex(parts: Uint8Array[]): Promise<string> {
  const total = parts.reduce((n, a) => n + a.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const a of parts) {
    merged.set(a, off);
    off += a.length;
  }
  const digest = await crypto.subtle.digest("SHA-1", merged);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function packObjectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

/** One full-entry pack from raw git object bodies (blob → tree → commit). */
async function buildStackedPack(objects: { type: number; body: Uint8Array }[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [new TextEncoder().encode("PACK"), new Uint8Array([0, 0, 0, 2]), new Uint8Array([0, 0, 0, objects.length])];
  for (const entry of objects) {
    chunks.push(packObjectHeader(entry.type, entry.body.length));
    chunks.push(await zlibDeflate(entry.body));
  }
  chunks.push(new Uint8Array(await crypto.subtle.digest("SHA-1", concatBytes(chunks))));
  return concatBytes(chunks);
}

/** A receive-pack request with EXPLICIT old/new oids (the fast-forward
 *  update `buildReceivePackBody` cannot express — it always sends ZERO). */
function buildUpdateBody(updates: { old: string; oid: string; ref: string }[], pack: Uint8Array): Uint8Array {
  let section = "";
  for (const update of updates) {
    section += pktLine(`${update.old} ${update.oid} ${update.ref}\0report-status side-band-64k`);
  }
  section += "0000";
  return concatBytes([new TextEncoder().encode(section), pack]);
}

/**
 * Push commit B (parent = `parentOid`, tree = {LICENSE → new blob}) onto
 * `owner/slug`'s `branch` at `oldOid` — the production stacked push. The
 * pack deliberately contains ONLY B's closure: the parent stays loose, and
 * B's parent line is the cross-store edge the copy pass must carry.
 */
async function pushStackedCommit(
  owner: string,
  slug: string,
  branch: string,
  oldOid: string,
  parentOid: string,
): Promise<string> {
  const aliceId = (await userIdOf(owner))!;
  const token = (await mintFor(aliceId, "push", "write:repository")).plaintext;
  const blob = new TextEncoder().encode("MIT License\n\nCopyright (C) 2026\n");
  const blobSha = await sha1Hex([new TextEncoder().encode(`blob ${blob.length}\0`), blob]);
  const treeBody = concatBytes([new TextEncoder().encode("100644 LICENSE\0"), rawOidOf(blobSha)]);
  const treeSha = await sha1Hex([new TextEncoder().encode(`tree ${treeBody.length}\0`), treeBody]);
  const time = 1700000100;
  const commitBody = new TextEncoder().encode(
    `tree ${treeSha}\n` +
      `parent ${parentOid}\n` +
      `author Test User <test@example.com> ${time} +0000\n` +
      `committer Test User <test@example.com> ${time} +0000\n\n` +
      "stacked push on the auto_init commit\n",
  );
  const commitSha = await sha1Hex([new TextEncoder().encode(`commit ${commitBody.length}\0`), commitBody]);
  const pack = await buildStackedPack([
    { type: 3, body: blob },
    { type: 2, body: treeBody },
    { type: 1, body: commitBody },
  ]);
  const response = await SELF.fetch(`https://example.com/${owner}/${slug}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
    body: buildUpdateBody([{ old: oldOid, oid: commitSha, ref: `refs/heads/${branch}` }], pack),
  });
  expect(response.status).toBe(200);
  // SPEC 0230: the streaming answer resolves before the push applies;
  // drain to stream end — the arm closes strictly after finalize's
  // transaction, so stream end is the push-completion signal
  await drainReceive(response);
  return commitSha;
}

function rawOidOf(oidHex: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

/** Full-clone fetch round: want `oid` + done (plain v0, no caps). */
function buildFetchBody(want: string): string {
  return `${pktLine(`want ${want}\n`)}0000${pktLine("done\n")}`;
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
    expect(body.name).toBe("Generated"); // FN-4: the display-case Name column (the slug stays folded)
    expect(body.owner.login).toBe("alice");
    expect(body.private).toBe(false);
    expect(body.fork).toBe(false);

    const row = await service.getBySlug("alice", "generated");
    expect(row?.status).toBe("ready");
    expect(row?.isEmpty).toBe(true); // template was empty — nothing to copy
    expect(row?.isTemplate).toBe(false); // generated repos are not templates
    expect(row?.defaultBranch).toBe("trunk"); // the form's branch wins
    expect(row?.ownerId).toBe(aliceId);
    // FN-4: description rides the repositories row (migration 0068) — the
    // legacy repo_settings store is retired.
    const desc = await env.DB.prepare("SELECT description FROM repositories WHERE id = ?")
      .bind(row!.id)
      .first<{ description: string | null }>();
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

  // The third loose class (the corner 6c54c1a documented): an ANNOTATED tag
  // created through the tags API lands its tag OBJECT loose (serializeTag →
  // putApiObjects — zero pack-catalog rows), and the copy's ref partition
  // used to exclude the ref outright (no raw-byte read RPC for tag objects).
  // The copy now re-materializes it Worker-side; the fidelity limit (the
  // materialized oid differs — tagger/message unrecoverable) is carry.ts's
  // module doc; the contract here: same name, SAME peel, resolves.
  it("copies an auto_init template's LOOSE annotated tag (re-materialized; same peel)", { timeout: 120_000 }, async () => {
    await seedIdentities();
    const { commitOid } = await autoInitTemplate("alice", "tpl-loosetag");
    const tagged = await router()(
      "/api/v1/repos/alice/tpl-loosetag/tags",
      aliceAuth({ method: "POST", body: JSON.stringify({ tag_name: "v1", message: "release one" }) }),
    );
    expect(tagged.status).toBe(200);
    const sourceTag = (await env.REPO.getByName("alice/tpl-loosetag").listRefs()).refs.find((r) => r.name === "refs/tags/v1");
    expect(sourceTag?.peeled).toBe(commitOid);
    await markTemplate("alice", "tpl-loosetag");

    const res = await router()(
      "/api/v1/repos/alice/tpl-loosetag/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "copy-loosetag", git_content: true }) }),
    );
    expect(res.status).toBe(201);

    const row = await new RepoService(env.DB).getBySlug("alice", "copy-loosetag");
    expect(row?.status).toBe("ready");
    expect(row?.isEmpty).toBe(false);
    // RED at HEAD: the tag ref was excluded from completeLooseImport — the
    // generated repo had no refs/tags/v1 at all.
    const refs = await env.REPO.getByName("alice/copy-loosetag").listRefs();
    const carriedTag = refs.refs.find((r) => r.name === "refs/tags/v1");
    expect(carriedTag).toBeDefined();
    if (carriedTag === undefined || sourceTag === undefined) throw new Error("unreachable");
    expect(carriedTag.peeled).toBe(commitOid);
    expect(carriedTag.target).not.toBe(sourceTag.target); // the materialized oid (fidelity limit)
    expect((await env.REPO.getByName("alice/copy-loosetag").readCommit(carriedTag.target))?.oid).toBe(commitOid);
  });

  // REDEPLOY13 OPEN ISSUE 1 (docs/design/p0-evidence.md ~1666): the mixed
  // shape above has the loose tip still advertised, so finalize's TIP
  // validation catches it and the loose completion runs. The production
  // template is harder: a REAL push stacked on the auto_init commit — every
  // ref tip is then PACKED, finalize succeeds, and the loose interior (the
  // auto_init commit + its tree/blob, referenced only by B's parent line)
  // is silently skipped. The generated cell's adopted pack carries legal
  // external edges into that missing loose store: full clone's walk throws
  // `missing object` (the silent upload-pack 500) and a later push's
  // anti-check cannot resolve advertised-closure objects (`missing
  // necessary objects`). The contract: the copy must carry the loose class
  // through the packed tips' edges too, and the generated repo must serve
  // BOTH wire directions.
  it("copies a push STACKED on auto_init content and the generated repo serves the git wire", { timeout: 120_000 }, async () => {
    await seedIdentities();
    const { commitOid: looseParent } = await autoInitTemplate("alice", "tpl-stack");
    // The production sequence: a real git push of commit B whose parent is
    // the loose auto_init commit (fast-forward main A → B).
    const stackedTip = await pushStackedCommit("alice", "tpl-stack", "main", looseParent, looseParent);
    expect(stackedTip).not.toBe(looseParent);

    // Control: the TEMPLATE is wire-healthy (its loose interior is local).
    const aliceToken = basicTokenHeader((await mintFor((await userIdOf("alice"))!, "r", "read:repository")).plaintext);
    const templateFetch = await SELF.fetch("https://example.com/alice/tpl-stack.git/git-upload-pack", {
      method: "POST",
      headers: { authorization: aliceToken, "content-type": UPLOAD_CT },
      body: buildFetchBody(stackedTip),
    });
    expect(templateFetch.status).toBe(200);

    await markTemplate("alice", "tpl-stack");
    const res = await router()(
      "/api/v1/repos/alice/tpl-stack/generate",
      aliceAuth({ method: "POST", body: JSON.stringify({ name: "copy-stack", git_content: true }) }),
    );
    expect(res.status).toBe(201);
    const row = await new RepoService(env.DB).getBySlug("alice", "copy-stack");
    expect(row?.status).toBe("ready");
    expect(row?.isEmpty).toBe(false);

    // The cell-state diff that WAS the bug: the generated cell resolves the
    // packed tip but not the loose parent its pack's parent lines name.
    const genCell = env.REPO.getByName("alice/copy-stack");
    expect((await genCell.readCommit(stackedTip))?.oid).toBe(stackedTip);
    expect(await genCell.readCommit(looseParent)).not.toBeNull();
    // ...and the full history walks (the clone's closure, not just tips).
    const log = await genCell.listLog("main");
    expect(log.commits.map((c) => c.oid)).toEqual([stackedTip, looseParent]);

    // The wire, read direction: the full-clone fetch round that 500ed in
    // production (info/refs 200, ls-refs 200, the fetch POST dying inside
    // the DO's walk with no surfaced exception).
    const wireFetch = await SELF.fetch("https://example.com/alice/copy-stack.git/git-upload-pack", {
      method: "POST",
      headers: { authorization: aliceToken, "content-type": UPLOAD_CT },
      body: buildFetchBody(stackedTip),
    });
    expect(wireFetch.status).toBe(200);
    expect((await wireFetch.arrayBuffer()).byteLength).toBeGreaterThan(0);

    // The wire, write direction: a push onto the generated repo whose tree
    // re-uses the carried loose README blob (the real client's thin-pack
    // shape — unchanged content is assumed present under the advertised
    // tips' closure). The receive anti-check must resolve it: report-status
    // ok, never `ng … missing necessary objects`.
    const autoTree = await env.REPO.getByName("alice/tpl-stack").listTree(looseParent, "");
    if (autoTree === null) throw new Error("template auto_init tree unreadable");
    const readmeEntry = autoTree.entries.find((e) => e.name === "README.md");
    if (readmeEntry === undefined) throw new Error("template README entry missing");
    const aliceId2 = (await userIdOf("alice"))!;
    const token2 = (await mintFor(aliceId2, "probe-push", "write:repository")).plaintext;
    const licenseBlob = new TextEncoder().encode("MIT License\n");
    const licenseSha = await sha1Hex([new TextEncoder().encode(`blob ${licenseBlob.length}\0`), licenseBlob]);
    const newTreeBody = concatBytes([
      new TextEncoder().encode("100644 README.md\0"),
      rawOidOf(readmeEntry.oid),
      new TextEncoder().encode("100644 LICENSE\0"),
      rawOidOf(licenseSha),
    ]);
    const newTreeSha = await sha1Hex([new TextEncoder().encode(`tree ${newTreeBody.length}\0`), newTreeBody]);
    const time = 1700000200;
    const probeCommitBody = new TextEncoder().encode(
      `tree ${newTreeSha}\n` +
        `parent ${stackedTip}\n` +
        `author Test User <test@example.com> ${time} +0000\n` +
        `committer Test User <test@example.com> ${time} +0000\n\n` +
        "probe push onto the generated repo\n",
    );
    const probeSha = await sha1Hex([new TextEncoder().encode(`commit ${probeCommitBody.length}\0`), probeCommitBody]);
    const probePack = await buildStackedPack([
      { type: 3, body: licenseBlob },
      { type: 2, body: newTreeBody },
      { type: 1, body: probeCommitBody },
    ]);
    const probePush = await SELF.fetch("https://example.com/alice/copy-stack.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token2), "content-type": RECEIVE_CT },
      body: buildUpdateBody([{ old: ZERO_OID, oid: probeSha, ref: "refs/heads/probe" }], probePack),
    });
    expect(probePush.status).toBe(200);
    const report = new TextDecoder().decode(await probePush.arrayBuffer());
    expect(report).toContain("ok refs/heads/probe");
    expect(report).not.toContain("missing necessary objects");
  });

  // The fork consumer arm of the same corner, driven at the service level
  // like the auto_init fork test above.
  it("replicateRepoCopy carries a loose annotated tag into a fork cell", { timeout: 120_000 }, async () => {
    await seedIdentities();
    const { commitOid } = await autoInitTemplate("alice", "tpl-forktag");
    const tagged = await router()(
      "/api/v1/repos/alice/tpl-forktag/tags",
      aliceAuth({ method: "POST", body: JSON.stringify({ tag_name: "v1", message: "release one" }) }),
    );
    expect(tagged.status).toBe(200);
    const service = new RepoService(env.DB);
    const fork = await service.create({ owner: { id: (await userIdOf("alice"))!, usernameLower: "alice" }, name: "fork-tag", isPrivate: false });

    await replicateRepoCopy(env, (await service.get((await service.getBySlug("alice", "tpl-forktag"))!.id))!, fork);

    // RED at HEAD: the fork converged on every branch but dropped the tag.
    const refs = await env.REPO.getByName("alice/fork-tag").listRefs();
    const carriedTag = refs.refs.find((r) => r.name === "refs/tags/v1");
    expect(carriedTag).toBeDefined();
    if (carriedTag === undefined) throw new Error("unreachable");
    expect(carriedTag.peeled).toBe(commitOid);
    expect((await env.REPO.getByName("alice/fork-tag").readCommit(carriedTag.target))?.oid).toBe(commitOid);
  });
});

// ---------------------------------------------------------------------------
// The six non-git_content copy arms (B-29, census 2026-11-04): every
// GenerateRepoOption boolean now copies its unit — upstream order
// template.go:131-178, each gated on its own boolean (template.go gates ONLY
// the git-content arm on git_content × emptiness, :133). The units seed via
// their landed stores directly (the join/rows/R2 objects); the generate call
// rides the same standalone router the guard matrix uses. git_content stays
// FALSE in this block, so the assertions also pin upstream's birth flag
// (`IsEmpty: !opts.GitContent || templateRepo.IsEmpty` — a copy-armed,
// content-less generate lands EMPTY).
// ---------------------------------------------------------------------------

/** Seed the unit rows + R2 objects on `templateId` and return the expectation
 *  table the assertions compare against (verbatim copies, upstream's field
 *  lists: labels WITHOUT the archived flag, webhooks WITHOUT name/status). */
async function seedAllUnits(templateId: string): Promise<{ avatarSourceKey: string }> {
  const avatarSourceKey = `r_${templateId}`;
  // topics — the join rows + the render column (the FN-4 shape the writer
  // maintains; the copy reads the JOIN — repo-topics.ts's source of truth).
  await env.DB.prepare("INSERT INTO repo_topics (repo_id, topic) VALUES (?, 'alpha'), (?, 'beta')")
    .bind(templateId, templateId)
    .run();
  await drizzle(env.DB)
    .update(repositories)
    .set({ topics: JSON.stringify(["alpha", "beta"]) })
    .where(eq(repositories.id, templateId));
  // labels — one archived (the flag must NOT carry: upstream's field list,
  // template.go:35-42) and one plain scoped pair.
  await drizzle(env.DB).insert(labels).values([
    { repoId: templateId, name: "archived-one", exclusive: false, exclusiveOrder: 0, description: "d1", color: "#aa0000", archivedAt: new Date() },
    { repoId: templateId, name: "scope/one", exclusive: true, exclusiveOrder: 3, description: "d2", color: "#00bb00" },
  ]);
  // protected branches — one rule, priority 4, the canonical config JSON.
  await drizzle(env.DB).insert(protectedBranches).values({
    repoId: templateId,
    ruleName: "release/*",
    priority: 4,
    rules: serializeRuleConfig(emptyRuleConfig()),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  // webhooks — the events blob + secret copied verbatim.
  await drizzle(env.DB).insert(webhooks).values({
    repoId: templateId,
    ownerId: 42,
    url: "https://hooks.example.com/gen",
    httpMethod: "POST",
    contentType: 1,
    secret: "s3cret",
    events: JSON.stringify({ push: { active: true } }),
    isActive: true,
    type: "gitea",
    meta: "",
  });
  // git hook — the route's persisted-edit layout (routes/git-hooks.ts).
  await env.REPO_PACKS.put(`githooks/${templateId}/pre-receive`, "#!/bin/sh\necho generated-copy-probe\n");
  // repo avatar — the services/avatars.ts key layout.
  await env.REPO_PACKS.put(`avatars/${avatarSourceKey}`, new Uint8Array([1, 2, 3]));
  return { avatarSourceKey };
}

describe("generateRepo copy arms (B-29 — the six non-git_content units)", () => {
  const CLEANUP_TABLES = ["labels", "protected_branches", "webhooks", "repo_topics"];

  beforeEach(async () => {
    for (const table of CLEANUP_TABLES) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  it("copies every selected unit (topics, git hooks, webhooks, avatar, labels, protected branches)", async () => {
    const { aliceId } = await seedIdentities();
    await createTemplate("arm-all");
    const template = await new RepoService(env.DB).getBySlug("alice", "arm-all");
    if (template === null) throw new Error("template seed missing");
    await seedAllUnits(template.id);

    const response = await router()(
      "/api/v1/repos/alice/arm-all/generate",
      aliceAuth({
        method: "POST",
        body: JSON.stringify({
          owner: "alice",
          name: "arm-all-copy",
          topics: true,
          git_hooks: true,
          webhooks: true,
          avatar: true,
          labels: true,
          protected_branch: true,
        }),
      }),
    );
    expect(response.status).toBe(201);
    const generated = await new RepoService(env.DB).getBySlug("alice", "arm-all-copy");
    if (generated === null) throw new Error("generated row missing");
    // Upstream's birth flag: git_content=false → the generated repo lands
    // EMPTY even though the template had content classes seeded elsewhere.
    expect(generated.isEmpty).toBe(true);
    expect(generated.status).toBe("ready");

    // topics — the join rows AND the render column (upstream's
    // GenerateTopics + syncTopicsInRepository tail). The template's own rows
    // live in the same tables, so every store assertion scopes the
    // generated repo's id.
    const topics = await drizzle(env.DB)
      .select({ topic: repoTopics.topic })
      .from(repoTopics)
      .where(eq(repoTopics.repoId, generated.id))
      .all();
    expect(topics.map((t) => t.topic).sort()).toEqual(["alpha", "beta"]);
    const renderRow = await drizzle(env.DB)
      .select({ topics: repositories.topics })
      .from(repositories)
      .where(eq(repositories.id, generated.id))
      .get();
    // The render column carries the writer's ASC-sorted JSON (upstream's
    // syncTopicsInRepository Find-order) — assert the literal bytes.
    expect(renderRow?.topics).toBe('["alpha","beta"]');

    // labels — the five upstream columns; the archived flag did NOT carry.
    const copied = await drizzle(env.DB)
      .select({
        name: labels.name,
        exclusive: labels.exclusive,
        exclusiveOrder: labels.exclusiveOrder,
        description: labels.description,
        color: labels.color,
        archivedAt: labels.archivedAt,
      })
      .from(labels)
      .where(eq(labels.repoId, generated.id))
      .all();
    const byName = Object.fromEntries(copied.map((l) => [l.name, l]));
    expect(byName["scope/one"]).toMatchObject({ exclusive: true, exclusiveOrder: 3, description: "d2", color: "#00bb00", archivedAt: null });
    expect(byName["archived-one"]).toMatchObject({ archivedAt: null });
    // The TEMPLATE's archived row keeps its flag (the copy never mutates the
    // template).
    const templateLabel = await drizzle(env.DB)
      .select({ archivedAt: labels.archivedAt })
      .from(labels)
      .where(eq(labels.repoId, template.id))
      .all();
    expect(templateLabel).toHaveLength(2);
    expect(templateLabel.filter((l) => l.archivedAt !== null)).toHaveLength(1);

    // protected branches — name, priority and the config JSON verbatim.
    const rules = await drizzle(env.DB)
      .select({ ruleName: protectedBranches.ruleName, priority: protectedBranches.priority, rules: protectedBranches.rules })
      .from(protectedBranches)
      .where(eq(protectedBranches.repoId, generated.id))
      .all();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ ruleName: "release/*", priority: 4 });

    // webhooks — upstream's exact field list.
    const hooks = await drizzle(env.DB)
      .select({ url: webhooks.url, secret: webhooks.secret, events: webhooks.events, isActive: webhooks.isActive, ownerId: webhooks.ownerId })
      .from(webhooks)
      .where(eq(webhooks.repoId, generated.id))
      .all();
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({
      url: "https://hooks.example.com/gen",
      secret: "s3cret",
      events: JSON.stringify({ push: { active: true } }),
      isActive: true,
      ownerId: 42,
    });

    // git hooks — the persisted edit moved to the generated repo's key.
    const hook = await env.REPO_PACKS.get(`githooks/${generated.id}/pre-receive`);
    expect(hook).not.toBeNull();
    expect(await hook!.text()).toBe("#!/bin/sh\necho generated-copy-probe\n");

    // avatar — the copy landed under the generated repo's own storage key.
    const avatar = await env.REPO_PACKS.get(`avatars/${generated.storageKey}`);
    expect(avatar).not.toBeNull();

    void aliceId;
  });

  it("gates each unit on its OWN boolean (topics=true copies topics and nothing else)", async () => {
    await seedIdentities();
    await createTemplate("arm-solo");
    const template = await new RepoService(env.DB).getBySlug("alice", "arm-solo");
    if (template === null) throw new Error("template seed missing");
    await seedAllUnits(template.id);

    const response = await router()(
      "/api/v1/repos/alice/arm-solo/generate",
      aliceAuth({
        method: "POST",
        body: JSON.stringify({ owner: "alice", name: "arm-solo-copy", topics: true }),
      }),
    );
    expect(response.status).toBe(201);
    const generated = await new RepoService(env.DB).getBySlug("alice", "arm-solo-copy");
    if (generated === null) throw new Error("generated row missing");

    const topics = await drizzle(env.DB)
      .select({ topic: repoTopics.topic })
      .from(repoTopics)
      .where(eq(repoTopics.repoId, generated.id))
      .all();
    expect(topics.map((t) => t.topic).sort()).toEqual(["alpha", "beta"]);
    const forGenerated = (table: typeof labels | typeof protectedBranches | typeof webhooks) =>
      drizzle(env.DB)
        .select({ id: table.id })
        .from(table)
        .where(eq(table.repoId, generated.id))
        .all();
    expect(await forGenerated(labels)).toHaveLength(0);
    expect(await forGenerated(protectedBranches)).toHaveLength(0);
    expect(await forGenerated(webhooks)).toHaveLength(0);
    // The template's own seeded rows are untouched (2 labels, 1 rule, 1 hook).
    expect(
      await drizzle(env.DB).select({ id: labels.id }).from(labels).where(eq(labels.repoId, template.id)).all(),
    ).toHaveLength(2);
    expect(
      await drizzle(env.DB)
        .select({ id: protectedBranches.id })
        .from(protectedBranches)
        .where(eq(protectedBranches.repoId, template.id))
        .all(),
    ).toHaveLength(1);
    expect(await env.REPO_PACKS.get(`githooks/${generated.id}/pre-receive`)).toBeNull();
    expect(await env.REPO_PACKS.get(`avatars/${generated.storageKey}`)).toBeNull();
  });

  it("avatar=true on a template WITHOUT an avatar is a silent no-op (upstream's len(Avatar) > 0 gate)", async () => {
    await seedIdentities();
    await createTemplate("arm-noavatar");
    const response = await router()(
      "/api/v1/repos/alice/arm-noavatar/generate",
      aliceAuth({
        method: "POST",
        body: JSON.stringify({ owner: "alice", name: "arm-noavatar-copy", avatar: true }),
      }),
    );
    expect(response.status).toBe(201);
    const generated = await new RepoService(env.DB).getBySlug("alice", "arm-noavatar-copy");
    if (generated === null) throw new Error("generated row missing");
    expect(await env.REPO_PACKS.get(`avatars/${generated.storageKey}`)).toBeNull();
  });

  it("labels=true with an EMPTY template label set inserts nothing (upstream's empty-slice guard)", async () => {
    await seedIdentities();
    await createTemplate("arm-nolabels");
    const response = await router()(
      "/api/v1/repos/alice/arm-nolabels/generate",
      aliceAuth({
        method: "POST",
        body: JSON.stringify({ owner: "alice", name: "arm-nolabels-copy", labels: true }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await drizzle(env.DB).select({ id: labels.id }).from(labels).all()).toHaveLength(0);
  });
});
