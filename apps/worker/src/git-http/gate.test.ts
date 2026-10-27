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
 *
 * The fourth wave under test (SPEC-0007 §3.5 team grants, the TEAMS-ACL
 * tail): the matrix's grant lines now include the doer's org/team grant,
 * resolved per request by `authorizeGitHttp` through the repository-service
 * `doerRepoAccessMode` (acl.ts:194) — the SAME predicate the API visibility
 * layer uses, so gate and API cannot drift. These are the direct git-HTTP
 * happy paths (the service-level coverage lives in
 * src/api/services/repository.test.ts): read-mode team ⇒ clone allowed /
 * push 404-masked (row 8, acl.ts:322-323 — teamWrites is write|admin|owner
 * only), write-mode team ⇒ both adverts, non-member ⇒ 404 on both, the
 * includes-all union-on-read, and the Owners-team bridge (org owners can
 * reach their own org's private repos without any team row).
 */

import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicHeader, basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { doerRepoAccessMode } from "../api/services/repository";
import { TeamsService } from "../api/routes/org-teams";
import { OrgService } from "../services/orgs/orgs";
import { settleCreatingRepo } from "./gate";
import { repoCounters, repoRedirects, repositories, userBlocking, users, webhookDeliveries, webhooks } from "../db/schema";
import { purgeRepoMessage } from "../repos/purge";
import { RepoService } from "../repos/service";
import { LFS_MEDIA_TYPE } from "../services/lfs/batch";
import { ZERO_OID, buildPack, buildReceivePackBody, pktLine } from "../repos/testing/git-pack";

// wave-129 full-run contention budget: this file's heaviest closure measured
// 4.02s of the 30s default IN a green 8-worker full run (the D1-resolved
// admin-matrix write arms over real pushes; the suite's 260-isolate spawn
// storm spikes closures up to ~12x their solo time). File-local 90s budgets;
// vitest.config.ts keeps 30s for every other file. Membership: the measured
// >=4s in-run closure/hook set (full-suite junit run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    // Team tables first (the org-teams.test.ts sweep order); teams and
    // team_members would cascade with the users delete below, but
    // team_repo_access.repo_id declares no FK and is swept explicitly.
    "team_repo_access",
    "team_members",
    "teams",
    "personal_access_tokens",
    "repo_units",
    "repo_transfer",
    "repo_redirects",
    "repo_counters",
    "webhook_deliveries",
    "webhooks",
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

describe("settleCreatingRepo emits repository action=created (the push-create arm)", () => {
  /** An OWNER-level hook subscribed to ONLY the repository family, seeded
   *  BEFORE the push: the gate's own waitUntil-scheduled settle (the
   *  production path, live under SELF.fetch) can fire before any repo-scoped
   *  hook could exist — the owner-level resolution covers both settle
   *  orders, and the subscription keeps the onPush push/create events out of
   *  the asserted log. */
  async function seedRepositoryHook(ownerId: number): Promise<number> {
    const inserted = await drizzle(env.DB)
      .insert(webhooks)
      .values({
        repoId: null,
        ownerId,
        url: "https://hooks.example.com/settle",
        events: JSON.stringify({ choose_events: true, events: { repository: true } }),
        isActive: true,
      })
      .returning({ id: webhooks.id })
      .all();
    return inserted[0]!.id;
  }

  const settleDeliveries = (hookId: number) =>
    drizzle(env.DB).select().from(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId)).all();

  it("the winning settle emits created; a re-settle never duplicates it", async () => {
    const slug = "settlecreated";
    const alice = await seedVerifiedUser({ username: "Alice" });
    const hookId = await seedRepositoryHook(alice.id);
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const { oid, pack } = await buildPack();
    const push = await SELF.fetch(`https://example.com/alice/${slug}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack),
    });
    expect(push.status).toBe(200);
    const rows = await drizzle(env.DB).select().from(repositories).all();
    expect(rows).toHaveLength(1);

    // The create becomes real → one repository/created delivery. (The gate's
    // own waitUntil-scheduled settle races the explicit call for the CAS —
    // exactly one of them emits, but when the gate's settle wins, its
    // emission lands on the waitUntil queue and may settle AFTER this
    // statement — so the row is awaited, not assumed.) The two replay
    // settles return first, so once one row is visible no other emitter
    // remains: the count stays exactly one.
    await settleCreatingRepo(env, rows[0]!.id, `alice/${slug}`);
    await settleCreatingRepo(env, rows[0]!.id, `alice/${slug}`); // idempotent replay

    await vi.waitFor(async () => {
      expect(await settleDeliveries(hookId)).toHaveLength(1);
    }, { timeout: 10_000 });
    const deliveries = await settleDeliveries(hookId);
    expect(deliveries.map((r) => [r.eventType, r.eventGroup])).toEqual([["repository", "repository"]]);
    const payload = JSON.parse(deliveries[0]!.payloadContent) as {
      action: string;
      repository: { full_name: string; private: boolean };
      organization: { login: string };
      sender: { login: string };
    };
    expect(payload.action).toBe("created");
    expect(payload.repository.full_name).toBe(`alice/${slug}`);
    // The owner-fallback sender (the settle carries no pusher identity — the
    // push family's documented deviation) and upstream's organization = owner.
    expect(payload.organization.login).toBe("Alice");
    expect(payload.sender.login).toBe("Alice");
  });

  it("the undo arm (no refs landed) stays silent", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const hookId = await seedRepositoryHook(alice.id);
    // A 'creating' row whose DO was never warmed: listRefs fails → the settle
    // deletes the row again (§2.5.2 undo) and notifies nobody — the repo was
    // never servable.
    const created = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "settledoomed",
      isPrivate: true,
      status: "creating",
    });
    await settleCreatingRepo(env, created.id, "alice/settledoomed");
    expect(await drizzle(env.DB).select().from(repositories).all()).toHaveLength(0);
    expect(await settleDeliveries(hookId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SPEC-0007 §3.5 — team grants over the git-HTTP surface (TEAMS-ACL tail)
// ---------------------------------------------------------------------------

/** The team-grant fixture, seeded through the LANDED teams module's services
 *  (OrgService/TeamsService) over real D1 — exactly the rows acl.ts's
 *  `doerRepoAccessMode` consultation (acl.ts:194) reads. Org `acme` owns the
 *  private repo `vault` carrying one real commit (pushed by the org owner,
 *  which is itself the bridge's write arm). Teams: `readers` (read mode),
 *  `writers` (write mode) — both repo-scoped via team_repo_access — and the
 *  includes-all `all-hands`. The second repo `extra` is created AFTER the
 *  team fan-out, so it is covered only by the includes-all union-on-read. */
async function seedTeamGrantFixture(): Promise<{
  reader: { id: number };
  allhands: { id: number };
  outsider: { id: number };
  oid: string;
  tokens: { ownerRead: string; readerRead: string; readerWrite: string; writerWrite: string; allhandsRead: string; outsiderWrite: string };
}> {
  const orgs = new OrgService(env.DB);
  const teams = new TeamsService(env.DB);

  const owner = await seedVerifiedUser({ username: "OrgOwner" });
  const reader = await seedVerifiedUser({ username: "TeamReader" });
  const writer = await seedVerifiedUser({ username: "TeamWriter" });
  const allhands = await seedVerifiedUser({ username: "AllHands" });
  const outsider = await seedVerifiedUser({ username: "Outsider" });

  const org = await orgs.createOrg({ name: "acme", ownerId: owner.id });
  const vault = await repoService().create({
    owner: { id: org.id, usernameLower: org.usernameLower },
    name: "vault",
    isPrivate: true,
  });

  // One real commit so the clone assertions pin actual refs. Allowed through
  // the bridge itself: `role='owner'` resolves mode 'owner' (teamWrites).
  const { oid, pack } = await buildPack();
  const push = await SELF.fetch("https://example.com/acme/vault.git/git-receive-pack", {
    method: "POST",
    headers: {
      authorization: basicTokenHeader((await mintFor(owner.id, "w", "write:repository")).plaintext),
      "content-type": RECEIVE_CT,
    },
    body: buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack),
  });
  expect(push.status).toBe(200);

  const readers = await teams.createTeam(org, { name: "readers", permission: "read" });
  await teams.addTeamRepo(readers, vault.id);
  await teams.addTeamMember(readers, reader.id);
  const writers = await teams.createTeam(org, { name: "writers", permission: "write" });
  await teams.addTeamRepo(writers, vault.id);
  await teams.addTeamMember(writers, writer.id);
  // includes-all: deliberately NO addTeamRepo — coverage is the flag itself.
  const allTeam = await teams.createTeam(org, {
    name: "all-hands",
    permission: "read",
    includes_all_repositories: true,
  });
  await teams.addTeamMember(allTeam, allhands.id);

  // Created after the fan-out: no team_repo_access row materialized for it.
  await repoService().create({
    owner: { id: org.id, usernameLower: org.usernameLower },
    name: "extra",
    isPrivate: true,
  });

  return {
    reader,
    allhands,
    outsider,
    oid,
    tokens: {
      ownerRead: (await mintFor(owner.id, "r", "read:repository")).plaintext,
      readerRead: (await mintFor(reader.id, "r", "read:repository")).plaintext,
      // The push-advert case needs a scope-adequate credential (row 7 runs
      // first): with the read-only token the reader's push answers 403, not
      // the row-8 mask.
      readerWrite: (await mintFor(reader.id, "w", "write:repository")).plaintext,
      writerWrite: (await mintFor(writer.id, "w", "write:repository")).plaintext,
      allhandsRead: (await mintFor(allhands.id, "r", "read:repository")).plaintext,
      outsiderWrite: (await mintFor(outsider.id, "w", "write:repository")).plaintext,
    },
  };
}

describe("team grants decide the git-HTTP matrix (SPEC-0007 §3.5 via authorizeGitHttp)", () => {
  it("read-mode team member: clone advert + upload-pack RPC ok, push advert 404-masked (row 8)", async () => {
    const fx = await seedTeamGrantFixture();

    // The grant is load-bearing: without it the private org repo is
    // anonymous-opaque (row 2 — 401 challenge, never a ref leak).
    const anon = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-upload-pack");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe(CHALLENGE);

    const auth = { authorization: basicTokenHeader(fx.tokens.readerRead) };

    const advert = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-upload-pack", {
      headers: auth,
    });
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(new TextDecoder().decode(await advert.arrayBuffer())).toContain(fx.oid);

    // One cross-check against the service layer (the full predicate matrix
    // lives in repository.test.ts): the gate consumed exactly the shared
    // repository-service grant — one resolution, no drift (acl.ts:39-41).
    const vault = (await repoService().getBySlug("acme", "vault"))!;
    expect(await doerRepoAccessMode(env.DB, { id: vault.id, ownerId: vault.ownerId }, fx.reader.id)).toBe("read");

    // The full fetch round-trip: want the pushed commit, get NAK + pack.
    const rpc = await SELF.fetch("https://example.com/acme/vault.git/git-upload-pack", {
      method: "POST",
      headers: { ...auth, "content-type": UPLOAD_CT },
      body: `${pktLine(`want ${fx.oid}\n`)}0000${pktLine("done\n")}`,
    });
    expect(rpc.status).toBe(200);
    expect(rpc.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
    expect(new TextDecoder().decode(await rpc.arrayBuffer())).toContain("NAK");

    // Row 8 (acl.ts:322-323): `teamWrites = write|admin|owner` — a read-mode
    // team stays read-only, and the write capability is 404-masked (upstream's
    // invisible-push shape), plain text, no challenge re-prompt. The token
    // carries write scope on purpose: a read-scope token would stop at row 7's
    // plain 403 before the mask (the scope check precedes the grant rows).
    const pushAdvert = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-receive-pack", {
      headers: { authorization: basicTokenHeader(fx.tokens.readerWrite) },
    });
    expect(pushAdvert.status).toBe(404);
    expect(new TextDecoder().decode(await pushAdvert.arrayBuffer())).toBe("Repository not found");
    expect(pushAdvert.headers.get("www-authenticate")).toBeNull();
  });

  it("write-mode team member: both the fetch and the push advert are allowed", async () => {
    const fx = await seedTeamGrantFixture();
    const auth = { authorization: basicTokenHeader(fx.tokens.writerWrite) };

    const fetchAdvert = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-upload-pack", {
      headers: auth,
    });
    expect(fetchAdvert.status).toBe(200);
    expect(fetchAdvert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");

    const pushAdvert = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-receive-pack", {
      headers: auth,
    });
    expect(pushAdvert.status).toBe(200);
    expect(pushAdvert.headers.get("content-type")).toBe("application/x-git-receive-pack-advertisement");
  });

  it("non-member authenticated: 404 mask on both adverts (existence hidden, not a scope 403)", async () => {
    const fx = await seedTeamGrantFixture();
    // Write scope on purpose: the 404s below are row 9's existence mask, not
    // row 7's missing-scope 403 — an org non-member learns nothing.
    const auth = { authorization: basicTokenHeader(fx.tokens.outsiderWrite) };

    const fetchAdvert = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-upload-pack", {
      headers: auth,
    });
    expect(fetchAdvert.status).toBe(404);
    expect(new TextDecoder().decode(await fetchAdvert.arrayBuffer())).toBe("Repository not found");
    expect(fetchAdvert.headers.get("www-authenticate")).toBeNull();

    const pushAdvert = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-receive-pack", {
      headers: auth,
    });
    expect(pushAdvert.status).toBe(404);
    expect(new TextDecoder().decode(await pushAdvert.arrayBuffer())).toBe("Repository not found");
    expect(pushAdvert.headers.get("www-authenticate")).toBeNull();
  });

  it("includes-all covers a repo created after the fan-out; the org owner clones via the Owners-team bridge", async () => {
    const fx = await seedTeamGrantFixture();

    // Union-on-read (orgs.ts teamRepoAccessMode: covered = includesAll ?
    // true : team_repo_access row): `extra` has no materialized grant row.
    const extraAdvert = await SELF.fetch("https://example.com/acme/extra.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(fx.tokens.allhandsRead) },
    });
    expect(extraAdvert.status).toBe(200);
    expect(extraAdvert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");

    // The §3.3 bridge: org_members.role='owner' resolves 'owner' through
    // doerRepoAccessMode (repository.ts:141-143) with NO team rows at all —
    // the org owner reads their own org's private repo over git-HTTP.
    const ownerClone = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(fx.tokens.ownerRead) },
    });
    expect(ownerClone.status).toBe(200);
    expect(ownerClone.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(new TextDecoder().decode(await ownerClone.arrayBuffer())).toContain(fx.oid);
  });

  it("removeMember revokes a TWO-team member's fetch and push adverts immediately (the services sweep)", async () => {
    const fx = await seedTeamGrantFixture();
    const orgs = new OrgService(env.DB);
    const teams = new TeamsService(env.DB);
    const orgRow = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "acme")).get();
    if (orgRow === undefined) throw new Error("fixture org missing");
    const writer = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "teamwriter")).get();
    if (writer === undefined) throw new Error("fixture writer missing");

    // The writer joins a SECOND write-mode team covering vault — revocation
    // must sweep every team with the membership, not one at a time.
    const second = await teams.createTeam((await orgs.getOrgById(orgRow.id))!, {
      name: "second-crew",
      permission: "write",
    });
    const vault = (await repoService().getBySlug("acme", "vault"))!;
    await teams.addTeamRepo(second, vault.id);
    await teams.addTeamMember(second, writer.id);

    const auth = { authorization: basicTokenHeader(fx.tokens.writerWrite) };
    // Precondition through the real gate: the push advert is allowed while
    // the team rows stand.
    const pushBefore = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-receive-pack", {
      headers: auth,
    });
    expect(pushBefore.status).toBe(200);

    expect(await orgs.removeMember(orgRow.id, writer.id)).toBe(true);

    // Both adverts collapse to the row-9 404 mask (plain "Repository not
    // found", no re-challenge) — doerRepoAccessMode re-reads the swept
    // team_members per request, so no credential or cache window remains.
    const fetchAfter = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-upload-pack", {
      headers: auth,
    });
    expect(fetchAfter.status).toBe(404);
    expect(new TextDecoder().decode(await fetchAfter.arrayBuffer())).toBe("Repository not found");
    const pushAfter = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-receive-pack", {
      headers: auth,
    });
    expect(pushAfter.status).toBe(404);
    expect(new TextDecoder().decode(await pushAfter.arrayBuffer())).toBe("Repository not found");
    expect(pushAfter.headers.get("www-authenticate")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The blocked-pusher relation over git-HTTP (upstream parity posture):
// upstream's blocked decline is agit-ONLY — it lives in the private
// proc-receive hook (routers/private/hook_proc_receive.go:29-39, surfacing
// ErrBlockedUser as the "Cannot create pull request …" UserMsg) and is
// reached solely by push-to-propose `refs/for/*` pushes; hook_pre_receive
// has NO blocked check, so a blocked user holding a write grant pushes
// directly. cf-gitea has no agit flow, so receive-pack carries no blocked
// decline either (the wholesale 403 this seam used to answer was narrower
// than upstream — wrongly pinned, removed; when the SPEC-0005 agit surface
// lands, the decline reappears at THAT seam with upstream's exact text).
// ---------------------------------------------------------------------------

describe("the blocked-pusher relation does not gate receive-pack (upstream parity)", () => {
  // A nested wipe — the shared beforeEach above owns the other tables, and
  // the fixtures above mint pushes that the arms must not see stale rows for.
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_blocking").run();
  });

  /** The org row and the write-team member of seedTeamGrantFixture. */
  async function orgAndWriter(): Promise<{ orgId: number; writerId: number }> {
    const org = await drizzle(env.DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, "acme"))
      .get();
    const writer = await drizzle(env.DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, "teamwriter"))
      .get();
    if (org === undefined || writer === undefined) throw new Error("fixture lookup failed");
    return { orgId: org.id, writerId: writer.id };
  }

  it("a pusher blocked by the repo owner WITH a write grant pushes fine (upstream's hook_pre_receive has no blocked check)", async () => {
    const fx = await seedTeamGrantFixture();
    const { orgId, writerId } = await orgAndWriter();
    // The raw blocking row is the stale-grant state: upstream's own BlockUser
    // cascade removes collaborations but NOT org team grants, and its
    // CanBlockUser refuses an org blocking a CURRENT member — and upstream
    // still lets the direct push through (only the agit proc-receive hook
    // consults IsUserBlockedBy, hook_proc_receive.go:29-39). Seeded raw; the
    // receive must succeed at parity.
    await drizzle(env.DB).insert(userBlocking).values({ blockerId: orgId, blockeeId: writerId, note: "", createdAt: new Date() });

    const { oid, pack } = await buildPack();
    const push = await SELF.fetch("https://example.com/acme/vault.git/git-receive-pack", {
      method: "POST",
      headers: {
        authorization: basicTokenHeader(fx.tokens.writerWrite),
        "content-type": RECEIVE_CT,
      },
      body: buildReceivePackBody([{ ref: "refs/heads/feature", oid }], pack),
    });
    expect(push.status).toBe(200);

    // The success is honest: the pushed ref reads back through the advert
    // (the engine commits refs before its response returns).
    const advert = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(fx.tokens.writerWrite) },
    });
    expect(advert.status).toBe(200);
    expect(new TextDecoder().decode(await advert.arrayBuffer())).toContain(oid);
  });

  it("the blocking row leaves the push ADVERT and reads untouched", async () => {
    const fx = await seedTeamGrantFixture();
    const { orgId, writerId } = await orgAndWriter();
    await drizzle(env.DB).insert(userBlocking).values({ blockerId: orgId, blockeeId: writerId, note: "", createdAt: new Date() });

    const advert = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-receive-pack", {
      headers: { authorization: basicTokenHeader(fx.tokens.writerWrite) },
    });
    expect(advert.status).toBe(200);

    const clone = await SELF.fetch("https://example.com/acme/vault.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(fx.tokens.writerWrite) },
    });
    expect(clone.status).toBe(200);
  });

  it("pushes with no blocking row present (the parity baseline)", async () => {
    const fx = await seedTeamGrantFixture();
    const { oid, pack } = await buildPack();
    const push = await SELF.fetch("https://example.com/acme/vault.git/git-receive-pack", {
      method: "POST",
      headers: {
        authorization: basicTokenHeader(fx.tokens.writerWrite),
        "content-type": RECEIVE_CT,
      },
      body: buildReceivePackBody([{ ref: "refs/heads/feature", oid }], pack),
    });
    expect(push.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The first-push settle generalizes to API-created empty repos
// (wave-settle-is-empty): upstream pushNewBranch (services/repository/
// push.go:255-270, the push-update queue handler) flips IsEmpty +
// DefaultBranch on the first new-branch push of EVERY repo; the gate's
// settle used to fire only for the push-create flow's status='creating'
// rows, so an API-created (ready, is_empty) repo's first push never cleared
// is_empty — generate took the settle-empty arm, renders lied, and the
// license/size settle legs' unborn-tip guards read stale state.
// ---------------------------------------------------------------------------

describe("the first-push settle generalizes to API-created empty repos (wave-settle-is-empty)", () => {
  it("an API-created (ready, is_empty) repo's first applied push clears is_empty and adopts the pushed branch — the gate's own settle, no manual call", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const service = repoService();
    const created = await service.create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "latefirst",
      isPrivate: true,
    });
    expect(created.status).toBe("ready");
    expect(created.isEmpty).toBe(true); // the bug's premise: API rows are born ready+empty

    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const { oid, pack } = await buildPack();
    const push = await SELF.fetch("https://example.com/alice/latefirst.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildReceivePackBody([{ ref: "refs/heads/trunk", oid }], pack),
    });
    expect(push.status).toBe(200);

    // The gate schedules the settle itself (ctx.waitUntil after the awaited
    // receive forward) — the assertion waits on the flip, never on a manual
    // settle call, so this pins the SCHEDULING too, not just the settle arm.
    await vi.waitFor(
      async () => {
        const row = await service.get(created.id);
        expect(row?.isEmpty).toBe(false);
      },
      { timeout: 10_000 },
    );
    const settled = (await service.get(created.id))!;
    expect(settled.status).toBe("ready");
    expect(settled.defaultBranch).toBe("trunk"); // upstream pushNewBranch adoption
    expect(settled.storageKey).toBe(created.storageKey); // immutable across the settle
    // The create's seeded dependents survive (the undo arm stays creating-only).
    expect(
      (await drizzle(env.DB).select().from(repoCounters).where(eq(repoCounters.repoId, created.id)).all()),
    ).toHaveLength(1);

    // The clone advert now serves the pushed content (the empty-repo advert
    // arm is gone with the flip).
    const advert = await SELF.fetch("https://example.com/alice/latefirst.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(advert.status).toBe(200);
    expect(new TextDecoder().decode(await advert.arrayBuffer())).toContain(oid);
  });

  it("the settled ready repo never re-emits repository/created (the emission stays creating-only)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    // OWNER-level hook on the repository family (the settle test's fixture
    // shape): the direct RepoService.create below emits nothing (the API
    // route owns that emission), so ANY delivery here would be the settle
    // re-emitting for a ready row.
    const hook = await drizzle(env.DB)
      .insert(webhooks)
      .values({
        repoId: null,
        ownerId: alice.id,
        url: "https://hooks.example.com/latefirst",
        events: JSON.stringify({ choose_events: true, events: { repository: true } }),
        isActive: true,
      })
      .returning({ id: webhooks.id })
      .all();
    const service = repoService();
    const created = await service.create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "noresettle",
      isPrivate: true,
    });

    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const { oid, pack } = await buildPack();
    const push = await SELF.fetch("https://example.com/alice/noresettle.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack),
    });
    expect(push.status).toBe(200);

    await vi.waitFor(
      async () => {
        const row = await service.get(created.id);
        expect(row?.isEmpty).toBe(false);
      },
      { timeout: 10_000 },
    );
    // Idempotent replay on the settled row (deterministic no-op), then the
    // delivery log must still be empty — the settle arm's emission is gated
    // on the row having BEEN 'creating'.
    await settleCreatingRepo(env, created.id, "alice/noresettle");
    const deliveries = await drizzle(env.DB)
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.hookId, hook[0]!.id))
      .all();
    expect(deliveries).toEqual([]);
  });

  it("a ref-less receive on a ready empty repo settles nothing (the undo arm stays creating-only)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const service = repoService();
    const created = await service.create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "emptyvoid",
      isPrivate: true,
    });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const push = await SELF.fetch("https://example.com/alice/emptyvoid.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: "0000",
    });
    expect(push.status).toBe(200);

    // Deterministic replay of the scheduled settle: without the explicit
    // creating-only guard this arm would sweep the seeded dependents of a
    // LIVE repo (the batch's counters/units deletes are unconditional; only
    // the repositories DELETE is CAS'd).
    await settleCreatingRepo(env, created.id, "alice/emptyvoid");
    const row = await service.get(created.id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("ready");
    expect(row?.isEmpty).toBe(true);
    expect(
      (await drizzle(env.DB).select().from(repoCounters).where(eq(repoCounters.repoId, created.id)).all()),
    ).toHaveLength(1);
  });
});
