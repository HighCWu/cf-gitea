/**
 * §2.4 row 2 regression — anonymous reads of D1-backed PRIVATE repositories
 * must 401-challenge on every one of the four git routes, across the entire
 * §2.5.2 push-create lifecycle (status='creating' through settle → 'ready').
 *
 * Production history (2026-10-24): the DEPLOY wave observed a push-created
 * private repo serving anonymous `git ls-remote` with 200 + full refs. The
 * serving branch was the morning build's engine passthrough — that deploy
 * (HEAD 419c811, 10:30 UTC) predated repo lifecycle (f052c64), so the smoke's
 * push created the repo ENGINE-SIDE ONLY (no D1 row, registry priv=0) and the
 * gate's D1-miss passthrough reached the engine hook's public-read branch
 * (authorize.ts). Later deploys carried the lifecycle gate; the current tree
 * gates all four routes for every D1-resolved row and the passthrough stays
 * reachable only for rows that genuinely have no D1 row. These tests pin that
 * split so neither side can regress:
 *
 *   - D1-backed private  + anonymous advert/RPC → 401 Basic (matrix row 2),
 *     before AND after the settle handshake flips status → 'ready';
 *   - D1-backed public   + anonymous advert     → 200 (row 1 stays open);
 *   - no D1 row (the transitional e2e population) → the engine hook decides,
 *     unchanged (public reads open, writes to the engine's create-by-push).
 *
 * The second wave under test (SPEC-0003 §2.1 gate-scope widening,
 * defense-in-depth): the repository-scoped ENGINE JSON/admin paths
 * (`/{owner}/{repo}/api/*`, PUT config/description, POST gc, DELETE root) for
 * D1-RESOLVED repos run the same matrix — the engine's own hook would decide
 * them from the registry's best-effort `priv` mirror (seedRepoExtras), so a
 * drifted/failed setConfig must not turn a private repo's JSON refs (or its
 * admin mutations) anonymous while the git routes correctly 401. D1-missing
 * repos keep the engine verbatim there; page/unknown shapes stay passthrough
 * (the engine headless-404s them BEFORE its authorize hook); the LFS family
 * (SPEC-0006) keeps its own branch, realm and error shapes.
 *
 * The third wave under test (the orphaned-row finding): an ALLOWED admin
 * DELETE of a D1-resolved repo must not reach the engine as a bare cell wipe
 * — the engine (packages/git-engine src/repo.ts DELETE "/") knows nothing of
 * D1, so the repositories row and its dependents survived as an orphan that
 * still resolved and gated routes against dead storage. The allow tail runs
 * the sanctioned §2.5.5 pipeline instead (src/repos/purge.ts
 * deleteRepositoryViaEngineShape) and answers with the engine's wire
 * contract; the D1-missing transitional population keeps the verbatim
 * passthrough.
 */

import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicHeader, basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { settleCreatingRepo } from "./gate";
import { repoCounters, repoRedirects, repositories } from "../db/schema";
import { purgeRepoMessage } from "../repos/purge";
import { RepoService } from "../repos/service";
import { LFS_MEDIA_TYPE } from "../services/lfs/batch";
import { ZERO_OID, buildPack, buildReceivePackBody } from "../repos/testing/git-pack";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
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

const RECEIVE_CT = "application/x-git-receive-pack-request";
const UPLOAD_CT = "application/x-git-upload-pack-request";
const CHALLENGE = 'Basic realm="Gitea"';

/** Push-create `alice/<slug>` (SPEC-0003 §2.5.2) with a real one-commit pack,
 *  then run the §2.5.2 settle handshake the gate schedules via waitUntil. */
async function pushCreateAndSettle(slug: string): Promise<void> {
  const alice = await seedVerifiedUser({ username: "Alice" });
  const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
  const { oid, pack } = await buildPack();
  const body = buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack);
  const response = await SELF.fetch(`https://example.com/alice/${slug}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
    body,
  });
  expect(response.status).toBe(200);

  // The settle runs on the runner here (production: ctx.waitUntil, observed
  // landed by ~t+2.3s); invoking it directly makes both windows deterministic.
  const rows = await drizzle(env.DB).select().from(repositories).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.visibility).toBe("private"); // DefaultPushCreatePrivate
  await settleCreatingRepo(env, rows[0]!.id, `alice/${slug}`);

  const settled = await drizzle(env.DB).select().from(repositories).all();
  expect(settled[0]?.status).toBe("ready");
  expect(settled[0]?.isEmpty).toBe(false);
  expect(settled[0]?.visibility).toBe("private");
}

describe("row 2 across the settle: anonymous reads of a push-created private repo (SPEC-0003 §2.4)", () => {
  it("401-challenges the anonymous upload-pack advert while creating AND after settle", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack);
    const push = await SELF.fetch("https://example.com/alice/window.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body,
    });
    expect(push.status).toBe(200);

    // status='creating' window: the matrix decides (row 2), never the engine.
    const creating = await SELF.fetch(
      "https://example.com/alice/window.git/info/refs?service=git-upload-pack",
    );
    expect(creating.status).toBe(401);
    expect(creating.headers.get("www-authenticate")).toBe(CHALLENGE);

    const rows = await drizzle(env.DB).select().from(repositories).all();
    await settleCreatingRepo(env, rows[0]!.id, "alice/window");

    const settled = await SELF.fetch(
      "https://example.com/alice/window.git/info/refs?service=git-upload-pack",
    );
    expect(settled.status).toBe(401);
    expect(settled.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await settled.arrayBuffer())).not.toContain(oid);
  });

  it("401-challenges the anonymous upload-pack RPC after settle", async () => {
    await pushCreateAndSettle("rpcleak");

    const rpc = await SELF.fetch("https://example.com/alice/rpcleak.git/git-upload-pack", {
      method: "POST",
      headers: { "content-type": UPLOAD_CT },
      body: "0000",
    });
    expect(rpc.status).toBe(401);
    expect(rpc.headers.get("www-authenticate")).toBe(CHALLENGE);
  });

  it("401-challenges the anonymous receive-pack advert after settle (row 3, push always needs identity)", async () => {
    await pushCreateAndSettle("pushleak");

    const advert = await SELF.fetch(
      "https://example.com/alice/pushleak.git/info/refs?service=git-receive-pack",
    );
    expect(advert.status).toBe(401);
    expect(advert.headers.get("www-authenticate")).toBe(CHALLENGE);
  });
});

describe("row 1 stays open: anonymous read of a D1-backed PUBLIC repo after settle", () => {
  it("serves the advertisement anonymously once the settled repo is flipped public", async () => {
    await pushCreateAndSettle("flip");
    // The §2.5.6 visibility flip (API-owned; the matrix re-reads D1 per request).
    await drizzle(env.DB)
      .update(repositories)
      .set({ visibility: "public" })
      .where(eq(repositories.slug, "flip"));
    const rows = await drizzle(env.DB).select().from(repositories).all();
    expect(rows[0]?.visibility).toBe("public");

    const advert = await SELF.fetch(
      "https://example.com/alice/flip.git/info/refs?service=git-upload-pack",
    );
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });
});

describe("transitional passthrough unchanged: repos with NO D1 row (TODO SPEC-0003 ENGINE-WAVE)", () => {
  it("keeps the engine's public-read for a registry-known repo that has no D1 row", async () => {
    // The e2e population shape: engine Registry row only, no repositories row.
    await env.REGISTRY.getByName("registry").upsert("demo/engineonly", Date.now());
    const rows = await drizzle(env.DB).select().from(repositories).all();
    expect(rows).toHaveLength(0);

    const advert = await SELF.fetch(
      "https://example.com/demo/engineonly.git/info/refs?service=git-upload-pack",
    );
    // gate.ts D1-miss passthrough → engine hook public-read — the exact
    // branch the morning build served for EVERY repo; it must survive ONLY
    // for this population.
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });

  it.skipIf(!env.GIT_TOKEN)(
    "keeps the engine's create-by-push advert for GIT_TOKEN credentials on a D1-missing repo",
    async () => {
      const response = await SELF.fetch(
        "https://example.com/demo/enginepush.git/info/refs?service=git-receive-pack",
        { headers: { authorization: basicHeader("x", env.GIT_TOKEN) } },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/x-git-receive-pack-advertisement");
      expect(await drizzle(env.DB).select().from(repositories).all()).toHaveLength(0);
    },
  );

  it("keeps the engine's 404 for anonymous reads of repos unknown to BOTH sides", async () => {
    const response = await SELF.fetch(
      "https://example.com/demo/trulyabsent.git/info/refs?service=git-upload-pack",
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });
});

/** RepoService over the real registry binding (create/rename fixtures for the
 *  engine-path suite; all other deps optional, queue never exercised here). */
function repoService(): RepoService {
  return new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry") });
}

/** The sole fixture repo's owner id (repositories.owner_id is nullable in the
 *  schema; every repo this suite creates seeds it). */
async function soleRepoOwnerId(): Promise<number> {
  const rows = await drizzle(env.DB).select().from(repositories).all();
  const ownerId = rows[0]!.ownerId;
  if (ownerId === null) throw new Error("fixture repo has no owner");
  return ownerId;
}

describe("engine JSON API for D1-resolved repos runs the matrix (SPEC-0003 §2.1 gate-scope widening)", () => {
  it("401-challenges the anonymous JSON refs API of a private D1-backed repo (the drifted-priv finding)", async () => {
    await pushCreateAndSettle("apileak");

    const refs = await SELF.fetch("https://example.com/alice/apileak/api/refs");
    expect(refs.status).toBe(401);
    expect(refs.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await refs.arrayBuffer())).not.toContain("refs/heads");
  });

  it("serves the JSON refs API to the authenticated owner via the matrix read grant", async () => {
    await pushCreateAndSettle("apiowner");
    const aliceToken = (await mintFor(await soleRepoOwnerId(), "r", "read:repository")).plaintext;

    const refs = await SELF.fetch("https://example.com/alice/apiowner/api/refs", {
      headers: { authorization: basicTokenHeader(aliceToken) },
    });
    expect(refs.status).toBe(200);
    const body = new TextDecoder().decode(await refs.arrayBuffer());
    expect(body).toContain("refs/heads/main");
  });

  it("keeps the JSON API anonymous-readable for a D1-backed PUBLIC repo (row 1)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "apipublic", isPrivate: false });

    const refs = await SELF.fetch("https://example.com/alice/apipublic/api/refs");
    expect(refs.status).toBe(200);
    const body = new TextDecoder().decode(await refs.arrayBuffer());
    expect(JSON.parse(body)).toEqual({ head: null, refs: [] });
  });

  it("keeps the engine's JSON 404 (no challenge) for api paths of repos missing from BOTH sides", async () => {
    const refs = await SELF.fetch("https://example.com/demo/norepo/api/refs");
    expect(refs.status).toBe(404);
    expect(refs.headers.get("www-authenticate")).toBeNull();
    expect(JSON.parse(new TextDecoder().decode(await refs.arrayBuffer()))).toEqual({
      error: "repository not found: demo/norepo",
    });
  });

  it("keeps the transitional passthrough: a registry-only repo's JSON API answers via the engine", async () => {
    await env.REGISTRY.getByName("registry").upsert("demo/apionly", Date.now());
    expect(await drizzle(env.DB).select().from(repositories).all()).toHaveLength(0);

    const refs = await SELF.fetch("https://example.com/demo/apionly/api/refs");
    // The engine hook's public-read decides (registry priv defaults false) —
    // byte-identical with the pre-widening behavior for this population.
    expect(refs.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(await refs.arrayBuffer()))).toEqual({ head: null, refs: [] });
  });

  it("claims percent-encoded engine tails for D1-resolved repos (fail-closed vs runtime decode divergence)", async () => {
    await pushCreateAndSettle("apienc");

    const refs = await SELF.fetch("https://example.com/alice/apienc/api%2Frefs");
    // The matrix decides (401 challenge); it must NOT fall through to the
    // engine, where a hypothetical wildcard-decoding runtime would classify
    // the tail as /api/refs and decide from the registry priv instead.
    expect(refs.status).toBe(401);
    expect(refs.headers.get("www-authenticate")).toBe(CHALLENGE);
  });

  it("leaves the engine's pre-auth 404 shapes untouched for D1-resolved repos (pages, wrong-method admin)", async () => {
    await pushCreateAndSettle("pageshape");

    // GET /config and GET /gc are neither api- nor admin-shaped (the admin
    // shapes pin their methods) — the engine headless-404s them BEFORE its
    // authorize hook, so the passthrough must stay challenge-free.
    for (const path of ["/alice/pageshape/config", "/alice/pageshape/gc"]) {
      const page = await SELF.fetch(`https://example.com${path}`);
      expect(page.status).toBe(404);
      expect(page.headers.get("www-authenticate")).toBeNull();
    }
  });
});

describe("engine admin shapes for D1-resolved repos take the matrix WRITE decision (§2.1 widening)", () => {
  it("challenges anonymous admin DELETE on a private D1-backed repo and leaves the repo intact", async () => {
    await pushCreateAndSettle("adminwipe");
    const aliceToken = (await mintFor(await soleRepoOwnerId(), "r", "read:repository")).plaintext;

    const wipe = await SELF.fetch("https://example.com/alice/adminwipe", { method: "DELETE" });
    expect(wipe.status).toBe(401);
    expect(wipe.headers.get("www-authenticate")).toBe(CHALLENGE);

    // The engine's wipe never ran: the JSON API still serves through the gate.
    const refs = await SELF.fetch("https://example.com/alice/adminwipe/api/refs", {
      headers: { authorization: basicTokenHeader(aliceToken) },
    });
    expect(refs.status).toBe(200);
  });

  it("404-masks the admin DELETE for an authenticated non-owner (row 8)", async () => {
    await pushCreateAndSettle("adminother");
    const bob = await seedVerifiedUser({ username: "Bob" });
    const bobToken = (await mintFor(bob.id, "w", "write:repository")).plaintext;

    const wipe = await SELF.fetch("https://example.com/alice/adminother", {
      method: "DELETE",
      headers: { authorization: basicTokenHeader(bobToken) },
    });
    expect(wipe.status).toBe(404);
    expect(new TextDecoder().decode(await wipe.arrayBuffer())).toBe("Repository not found");
  });

  it("requires write scope for the admin config PUT (row 7) and allows the owner holding it", async () => {
    await pushCreateAndSettle("admincfg");
    const ownerId = await soleRepoOwnerId();
    const readToken = (await mintFor(ownerId, "r", "read:repository")).plaintext;
    const writeToken = (await mintFor(ownerId, "w2", "write:repository")).plaintext;

    const forbidden = await SELF.fetch("https://example.com/alice/admincfg/config", {
      method: "PUT",
      headers: { authorization: basicTokenHeader(readToken), "content-type": "application/json" },
      body: JSON.stringify({ description: "nope", private: true }),
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("www-authenticate")).toBeNull();

    const allowed = await SELF.fetch("https://example.com/alice/admincfg/config", {
      method: "PUT",
      headers: { authorization: basicTokenHeader(writeToken), "content-type": "application/json" },
      body: JSON.stringify({ description: "engine mirror only; D1 stays the authority" }),
    });
    expect(allowed.status).toBe(200);
    const echo = await allowed.json<{ description: string }>();
    expect(echo.description).toBe("engine mirror only; D1 stays the authority");
  });

  it("403s an admin DELETE carrying a read-only scope (row 7) and leaves both stores intact", async () => {
    await pushCreateAndSettle("admindeny");
    const ownerId = await soleRepoOwnerId();
    const readToken = (await mintFor(ownerId, "r", "read:repository")).plaintext;
    const writeToken = (await mintFor(ownerId, "w2", "write:repository")).plaintext;

    const wipe = await SELF.fetch("https://example.com/alice/admindeny", {
      method: "DELETE",
      headers: { authorization: basicTokenHeader(readToken) },
    });
    // Identity was established, the write scope was not: plain 403, never a
    // challenge (§2.4 row 7) — and no cascade may run on a rejected shape.
    expect(wipe.status).toBe(403);
    expect(wipe.headers.get("www-authenticate")).toBeNull();

    // Both stores intact: the D1 row still resolves and the engine still
    // serves the repo's refs through the gate.
    expect(await drizzle(env.DB).select().from(repositories).all()).toHaveLength(1);
    const refs = await SELF.fetch("https://example.com/alice/admindeny/api/refs", {
      headers: { authorization: basicTokenHeader(writeToken) },
    });
    expect(refs.status).toBe(200);
  });

  it("deletes an authorized admin DELETE through the sanctioned pipeline: D1 cascade now, engine destroy only via the purge", async () => {
    await pushCreateAndSettle("admincascade");
    const svc = repoService();
    const row = (await svc.getBySlug("alice", "admincascade"))!;
    const ownerId = await soleRepoOwnerId();
    // "w2": pushCreateAndSettle already minted a "w"-named token for this user.
    const writeToken = (await mintFor(ownerId, "w2", "write:repository")).plaintext;
    // Dependents the cascade must remove: a rename's redirect (the delete
    // also tombstones/destroys the cell under the OLD name) and an
    // imports/<storage_key>/ object — a prefix the engine's own DELETE shape
    // never purges (packages/git-engine repo.ts purgePackCache covers only
    // repos/<storage_key>/), i.e. exactly the bytes the old leak stranded.
    await svc.rename(row.id, "admincascade2");
    await env.REPO_PACKS.put(`imports/${row.storageKey}/chunk-0.pack`, new Uint8Array([4]));

    const wipe = await SELF.fetch("https://example.com/alice/admincascade2", {
      method: "DELETE",
      headers: { authorization: basicTokenHeader(writeToken) },
    });
    // The engine's wire contract, byte-for-byte (scripts/deploy-smoke.mjs
    // checkCleanup asserts 200 + "deleted") — the shape keeps working, it
    // just stopped leaking.
    expect(wipe.status).toBe(200);
    expect(await wipe.text()).toBe("deleted\n");

    // Step 1 landed synchronously: the row and its dependents are gone — no
    // orphan resolves or gates routes anymore.
    expect(await svc.get(row.id)).toBeNull();
    expect(await drizzle(env.DB).select().from(repoCounters).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(repoRedirects).all()).toHaveLength(0);

    // Steps 2-4 ran on the queue the gate scheduled; driven here exactly like
    // src/repos/lifecycle.test.ts (the consumer is not wired in vitest, and
    // every step is idempotent). The engine destroy happens ONLY here — never
    // as a bare engine wipe inside the request.
    const engineNames = ["alice/admincascade2", "alice/admincascade"];
    await purgeRepoMessage(env, { storageKey: row.storageKey, engineNames });
    expect((await env.REPO_PACKS.list({ prefix: `repos/${row.storageKey}/` })).objects).toHaveLength(0);
    expect((await env.REPO_PACKS.list({ prefix: `imports/${row.storageKey}/` })).objects).toHaveLength(0);
    const registry = env.REGISTRY.getByName("registry");
    expect(await registry.get("alice/admincascade2")).toBeNull();
    expect(await registry.get("alice/admincascade")).toBeNull();
    // Destroy (not tombstone) is the terminal state: a revived cell accepts
    // receives, so a same-name re-create starts clean (§4.8).
    const revived = await env.REPO.getByName("alice/admincascade2").beginReceive({
      commands: [{ ref: "refs/heads/main", old: ZERO_OID, next: ZERO_OID }],
      capabilities: [],
      packBytesHint: null,
    });
    expect(revived.tag).toBe("ok");
  });

  it.skipIf(!env.GIT_TOKEN)(
    "keeps the engine's verbatim admin DELETE for a D1-missing (registry-only) repo",
    async () => {
      // The transitional population: engine Registry row only, no D1 row —
      // the gate passes the shape through verbatim and the engine's own hook
      // + wipe decide (a 200 proves the engine decided: the gate's matrix
      // would have 401-challenged this non-D1 credential).
      await env.REGISTRY.getByName("registry").upsert("demo/enginewipe", Date.now());
      expect(await drizzle(env.DB).select().from(repositories).all()).toHaveLength(0);

      const wipe = await SELF.fetch("https://example.com/demo/enginewipe", {
        method: "DELETE",
        headers: { authorization: basicHeader("x", env.GIT_TOKEN) },
      });
      expect(wipe.status).toBe(200);
      expect(await wipe.text()).toBe("deleted\n");

      // Nothing cascaded (there is no D1 row) and the engine behavior is
      // unchanged — full ENGINE-side teardown exactly as before the fix: the
      // wiped cell is gone from the registry too (the engine's dispatch
      // removes the row after a successful DELETE, mod.ts), so the repo
      // answers the engine's JSON not-found from here on.
      expect(await drizzle(env.DB).select().from(repositories).all()).toHaveLength(0);
      expect(await env.REGISTRY.getByName("registry").get("demo/enginewipe")).toBeNull();
      const refs = await SELF.fetch("https://example.com/demo/enginewipe/api/refs");
      expect(refs.status).toBe(404);
      expect(JSON.parse(new TextDecoder().decode(await refs.arrayBuffer()))).toEqual({
        error: "repository not found: demo/enginewipe",
      });
    },
  );

  it("301s a renamed repo's old JSON API URL before any auth (row 13)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const created = await repoService().create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "apiorig",
      isPrivate: false,
    });
    await repoService().rename(created.id, "apinew");

    const moved = await SELF.fetch("https://example.com/alice/apiorig/api/refs", { redirect: "manual" });
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("https://example.com/alice/apinew/api/refs");
  });
});

describe("the LFS family stays on its own branch (SPEC-0006 §2.1, untouched by the widening)", () => {
  it("answers the anonymous batch of a private D1-backed repo with the gitea-lfs challenge, not the git 401", async () => {
    await pushCreateAndSettle("lfsbranch");

    const batch = await SELF.fetch("https://example.com/alice/lfsbranch.git/info/lfs/objects/batch", {
      method: "POST",
      headers: { accept: LFS_MEDIA_TYPE, "content-type": LFS_MEDIA_TYPE },
      body: JSON.stringify({ operation: "download", objects: [] }),
    });
    expect(batch.status).toBe(401);
    expect(batch.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
    expect(JSON.parse(new TextDecoder().decode(await batch.arrayBuffer()))).toEqual({ message: "Unauthorized" });
  });
});
