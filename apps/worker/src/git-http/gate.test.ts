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

import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicHeader, basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { doerRepoAccessMode } from "../api/services/repository";
import { addDeployKeyToken } from "../api/services/deploy-keys";
import { TeamsService } from "../api/routes/org-teams";
import { OrgService } from "../services/orgs/orgs";
import { settleCreatingRepo } from "./gate";
import { createWikiPage } from "../services/wiki";
import { deployKeys, repoCounters, repoRedirects, repoSettings, repositories, userBlocking, users, webhookDeliveries, webhooks } from "../db/schema";
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
    "deploy_keys",
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
// The challenge realm follows the pin's OAuth2 switch (githttp.go:152-158,
// now LIVE — SPEC specs/oauth2-provider.md §2.11's flip): the provider is
// ENABLED by default (OAUTH2_ENABLED strict polarity, default true =
// upstream's setting.OAuth2.Enabled), so the challenge answers realm="Gitea"
// — GCM then attempts its BUILT-IN OAuth2 application (the seeded builtin
// rows make the attempt land, git-credential-manager#1442). The disabled
// polarity reverts to "Gitea (Basic Auth)" — the GCM-loop fix (SPEC-0002
// §2.6), pinned at the challenge site in web/oauth2-wellknown.test.ts.
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

describe("the HEAD file runs the rows 4/5 grant like every other read (the S7 alignment)", () => {
  it("serves the anonymous HEAD of a grant-carrying private repo (row 4) and keeps the 401 without the grant (row 2)", async () => {
    await pushCreateAndSettle("headgrant");
    const repo = (await drizzle(env.DB).select().from(repositories).all())[0];
    if (repo === undefined) throw new Error("repo seed missing");

    // No grant yet: the anonymous HEAD probe stays a row-2 challenge — the
    // pre-S7 posture the fix preserves for grant-less private repos.
    const denied = await SELF.fetch("https://example.com/alice/headgrant/HEAD");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe(CHALLENGE);

    // The code unit's anonymous-read grant (SPEC-0003 §3.1,
    // upstream git_smart_http_test.go:163-189) admits the same probe the
    // protocol reads on this repo already allow — the old hardcoded
    // `unitAnonymousRead: false` challenged it instead.
    await env.DB.prepare("INSERT INTO repo_units (repo_id, type, anonymous_access_mode) VALUES (?, 'code', 'read')").bind(repo.id).run();

    const allowed = await SELF.fetch("https://example.com/alice/headgrant/HEAD");
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toBe("text/plain");
    expect(new TextDecoder().decode(await allowed.arrayBuffer())).toBe("ref: refs/heads/main\n");
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

  it("the created payload renders the request origin when APP_URL is unset; the var still wins over it", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const hookId = await seedRepositoryHook(alice.id);
    const service = new RepoService(env.DB);
    const requestOrigin = "https://push.example.com";
    const appUrlOrigin = ((env as { APP_URL?: string }).APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");

    /** One 'creating' row + a warmed cell (refs/heads/main landed over the
     *  cell RPCs — NO gate receive, so the gate's own waitUntil settle never
     *  races this test's explicit CAS; push-stale.test.ts's seeding shape). */
    async function seedCreatingRepoWithRef(slug: string): Promise<string> {
      const row = await service.create({
        owner: { id: alice.id, usernameLower: "alice" },
        name: slug,
        isPrivate: true,
        status: "creating",
      });
      const cell = env.REPO.getByName(`alice/${slug}`);
      const person = { name: "seed", email: "seed@stale.invalid", time: 1761000000, tz: "+0000" };
      const readme = new TextEncoder().encode(`# ${slug}\n`);
      // Worker-side object hash (push-stale.test.ts's shape — the
      // `type size\0` header, putApiObjects re-verifies).
      const gitOid = async (type: string, data: Uint8Array): Promise<string> => {
        const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
        const bytes = new Uint8Array(header.byteLength + data.byteLength);
        bytes.set(header, 0);
        bytes.set(data, header.byteLength);
        const digest = await crypto.subtle.digest("SHA-1", bytes);
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      };
      const readmeOid = await gitOid("blob", readme);
      const tree = serializeTree([{ mode: "100644", name: "README.md", oid: readmeOid }]);
      const tip = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "seed\n" });
      const put = await cell.putApiObjects([
        { oid: readmeOid, type: "blob", data: readme },
        { oid: tree.oid, type: "tree", data: tree.data },
        { oid: tip.oid, type: "commit", data: tip.data },
      ]);
      if (put.tag !== "ok") throw new Error(`seed putApiObjects failed: ${put.tag}`);
      const landed = await cell.commitApiChange({ ref: "refs/heads/main", expectedOldOid: "0".repeat(40), newOid: tip.oid });
      if (landed.tag !== "committed") throw new Error(`seed ref landing failed: ${landed.tag}`);
      return row.id;
    }

    // Arm 1 — the varless bindings view + a request origin: the payload URLs
    // carry the REQUEST origin (appOrigin's middle leg, the zero-config
    // fallback the settle threads from the receive in hand).
    const noVarRow = await seedCreatingRepoWithRef("settledorigin");
    await settleCreatingRepo({ DB: env.DB, REPO: env.REPO, REPO_PACKS: env.REPO_PACKS }, noVarRow, "alice/settledorigin", requestOrigin);
    let rows = await settleDeliveries(hookId);
    expect(rows).toHaveLength(1);
    const noVarPayload = JSON.parse(rows[0]!.payloadContent) as { repository: { html_url: string } };
    expect(noVarPayload.repository.html_url).toBe(`${requestOrigin}/alice/settledorigin`);

    // Arm 2 — the real bindings (the wrangler.jsonc APP_URL var set) + the
    // same request origin: the var WINS (the APP_URL unit's precedence, now
    // pinned through the settle path too).
    const varRow = await seedCreatingRepoWithRef("settledoriginvar");
    await settleCreatingRepo(env, varRow, "alice/settledoriginvar", requestOrigin);
    rows = await settleDeliveries(hookId);
    expect(rows).toHaveLength(2);
    const varPayload = JSON.parse(rows[1]!.payloadContent) as { repository: { html_url: string } };
    expect(varPayload.repository.html_url).toBe(`${appUrlOrigin}/alice/settledoriginvar`);
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

  it("the fw-org-member-preaccess battery arm shape END-TO-END: the API-created auto_init org repo + the includes-all repo.code team let the member's own token list refs/heads/main", async () => {
    // The fixwave battery's exact shape (deploy-probes.mjs fw-org-setup-201s
    // → fw-org-member-preaccess): org via the API, PRIVATE repo with
    // auto_init via POST /orgs/{org}/repos, team created with
    // `units: ["repo.code"]` (the assignTeamPermission collapse: authorize
    // 'none' + the units_map) + includes_all, member added — then the
    // MEMBER's own all-scopes token ls-remotes. The history this pins:
    // the member's grant always resolved (the team predicate was green in
    // isolation), but the org route ignored auto_init, so the repo stayed
    // empty and `refs/heads/main` never appeared — the arm read "team
    // membership did not grant the git read" while the true seam was the
    // never-written initial commit. The advert shape below is the arm's
    // poll predicate verbatim: status 200 AND a refs/heads/main line.
    const admin = await seedVerifiedUser({ username: "BatteryAdmin", isAdmin: true });
    const member = await seedVerifiedUser({ username: "BatteryMember" });
    const orgs = new OrgService(env.DB);
    const teamsSvc = new TeamsService(env.DB);
    const org = await orgs.createOrg({ name: "batorg", ownerId: admin.id });

    const adminToken = (await mintFor(admin.id, "admin", "all")).plaintext;
    const create = await SELF.fetch("https://example.com/api/v1/orgs/batorg/repos", {
      method: "POST",
      headers: { authorization: `token ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "batrepo", private: true, auto_init: true }),
    });
    expect(create.status).toBe(201);
    const created = await create.json<{ empty?: boolean }>();
    expect(created.empty).toBe(false); // auto_init landed before the 201 — the arm's refs exist already

    const team = await teamsSvc.createTeam(org, {
      name: "bat-team",
      permission: "read",
      includes_all_repositories: true,
      units: ["repo.code"],
    });
    await teamsSvc.addTeamMember(team, member.id);

    const memberToken = (await mintFor(member.id, "member", "all")).plaintext;
    const advert = await SELF.fetch("https://example.com/batorg/batrepo.git/info/refs?service=git-upload-pack", {
      headers: { authorization: `token ${memberToken}` },
    });
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const advertText = new TextDecoder().decode(await advert.arrayBuffer());
    expect(advertText).toContain("refs/heads/main");

    // The team predicate stays the unit of record: the shared repository-service
    // grant resolves 'read' for the member (units_map collapse — repository.ts).
    const row = (await repoService().getBySlug("batorg", "batrepo"))!;
    expect(await doerRepoAccessMode(env.DB, { id: row.id, ownerId: row.ownerId }, member.id)).toBe("read");
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

// ---------------------------------------------------------------------------
// The `*.wiki` git family (the wiki SPEC ledger's open follow-up). Upstream
// serves the wiki twin over git-HTTP at `/{owner}/{repo}.wiki.git` — the
// marker strips in httpBase and the PARENT repo resolves/authorizes
// (routers/web/repo/githttp.go:94-101 at the pin); wiki pushes are SERVED
// with write checks kept deliberately (githttp.go:186-189), wiki push-create
// is not (githttp.go:215-218), and the wiki pre-receive runs the parent's
// protected-branch rules (hook_pre_receive.go:123-175). cf-gitea serves the
// same surface over the sibling ENGINE cell `owner/slug.wiki`
// (services/wiki.ts wikiCellName): reads clone the pages' objects, receives
// land in the cell (no parent settle — hook_post_receive.go:96), the wiki
// inherits the parent's visibility, and the engine's registry row is seeded
// priv=1 (index-hidden) so protocol/api reads stop 404ing the cell.
// ---------------------------------------------------------------------------

/** Fixture: `alice/<slug>` via RepoService (real D1 row + registry seed) with
 *  one wiki page landed through the real service write path (the wiki cell
 *  then holds a loose root commit on refs/heads/main). Returns the parent's
 *  owner id and the wiki cell's tip. */
async function seedWikiParent(slug: string, isPrivate: boolean): Promise<{ aliceId: number; tip: string }> {
  const alice = await seedVerifiedUser({ username: "Alice" });
  const created = await repoService().create({
    owner: { id: alice.id, usernameLower: "alice" },
    name: slug,
    isPrivate,
  });
  const ownerRow = await drizzle(env.DB).select().from(users).where(eq(users.id, alice.id)).get();
  if (ownerRow === undefined) throw new Error("wiki fixture: owner row missing");
  await createWikiPage(
    env,
    { repo: created, owner: ownerRow },
    { name: "alice", email: "alice@example.com" },
    { title: "Home", content: new TextEncoder().encode("# Home\n"), message: "" },
    "https://example.com",
    { now: 1_700_000_000 },
  );
  const refs = await env.REPO.getByName(`alice/${slug}.wiki`).listRefs();
  const tip = refs.refs.find((r) => r.name === "refs/heads/main")?.target;
  if (tip === undefined) throw new Error("wiki fixture: no refs/heads/main on the sibling cell");
  return { aliceId: alice.id, tip };
}

describe("the *.wiki git family (upstream githttp.go:94-101 — the wiki SPEC's open follow-up)", () => {
  it("serves the anonymous clone advert of a public parent's seeded wiki cell, registry row seeded index-hidden", async () => {
    const { tip } = await seedWikiParent("openwiki", false);

    const advert = await SELF.fetch("https://example.com/alice/openwiki.wiki.git/info/refs?service=git-upload-pack");
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const body = new TextDecoder().decode(await advert.arrayBuffer());
    expect(body).toContain("refs/heads/main");
    expect(body).toContain(tip);

    // The seed discipline: the wiki cell's registry row exists (the engine's
    // protocol-read prerequisite) with priv=1 — "hidden from index" — so the
    // services/wiki.ts index-leak posture stays honored with the gate open.
    const row = await env.REGISTRY.getByName("registry").get("alice/openwiki.wiki");
    expect(row).not.toBeNull();
    expect(row?.priv).toBe(1);
  });

  it("serves the wiki pages' objects through the upload-pack RPC (the clone round trip)", async () => {
    const { tip } = await seedWikiParent("clonewiki", false);

    // Minimal v0 negotiation: want the tip, flush, done — no side-band, so
    // the pack streams raw and the response body must carry the pack magic.
    const negotiation = pktLine(`want ${tip}\n`) + "0000" + pktLine("done\n");
    const rpc = await SELF.fetch("https://example.com/alice/clonewiki.wiki.git/git-upload-pack", {
      method: "POST",
      headers: { "content-type": UPLOAD_CT },
      body: negotiation,
    });
    expect(rpc.status).toBe(200);
    expect(rpc.headers.get("content-type")).toBe("application/x-git-upload-pack-result");
    const body = new TextDecoder().decode(await rpc.arrayBuffer());
    expect(body).toContain("NAK");
    expect(body).toContain("PACK");
  });

  it("401-challenges the anonymous clone of a private parent's wiki (the wiki inherits the parent's visibility)", async () => {
    const { tip } = await seedWikiParent("hiddenwiki", true);

    const advert = await SELF.fetch("https://example.com/alice/hiddenwiki.wiki.git/info/refs?service=git-upload-pack");
    expect(advert.status).toBe(401);
    expect(advert.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(new TextDecoder().decode(await advert.arrayBuffer())).not.toContain(tip);
  });

  it("masks the wiki from an authenticated stranger and serves the owner (matrix rows 8/9 over the parent)", async () => {
    const { aliceId, tip } = await seedWikiParent("strangerwiki", true);
    const bob = await seedVerifiedUser({ username: "Bob" });
    const bobToken = (await mintFor(bob.id, "r", "read:repository")).plaintext;
    const aliceToken = (await mintFor(aliceId, "r", "read:repository")).plaintext;

    const stranger = await SELF.fetch("https://example.com/alice/strangerwiki.wiki.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(bobToken) },
    });
    expect(stranger.status).toBe(404);
    const strangerBody = new TextDecoder().decode(await stranger.arrayBuffer());
    expect(strangerBody).toBe("Repository not found");
    expect(strangerBody).not.toContain(tip);

    const owner = await SELF.fetch("https://example.com/alice/strangerwiki.wiki.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(aliceToken) },
    });
    expect(owner.status).toBe(200);
    expect(new TextDecoder().decode(await owner.arrayBuffer())).toContain(tip);
  });

  it("serves the wiki cell's synthetic HEAD from the parent's read rows", async () => {
    await seedWikiParent("headwiki", false);
    const head = await SELF.fetch("https://example.com/alice/headwiki.wiki.git/HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/plain");
    expect(new TextDecoder().decode(await head.arrayBuffer())).toBe("ref: refs/heads/main\n");
  });

  it("serves wiki receive-pack with the parent's write grant and settles nothing on the parent row", async () => {
    const created = await (async () => {
      const alice = await seedVerifiedUser({ username: "Alice" });
      return repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "wikipush", isPrivate: false });
    })();
    const aliceToken = (await mintFor(created.ownerId ?? 0, "w", "write:repository")).plaintext;

    // Anonymous write first: pushes always need identity (rows 2/3), wiki or not.
    const anon = await SELF.fetch("https://example.com/alice/wikipush.wiki.git/info/refs?service=git-receive-pack");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe(CHALLENGE);

    // The authenticated receive lands in the SIBLING cell (upstream parity:
    // githttp.go:186-189 — wiki pushes keep write checks and are served).
    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody([{ ref: "refs/heads/notes", oid }], pack);
    const push = await SELF.fetch("https://example.com/alice/wikipush.wiki.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(aliceToken), "content-type": RECEIVE_CT },
      body,
    });
    expect(push.status).toBe(200);

    const cellRefs = await env.REPO.getByName("alice/wikipush.wiki").listRefs();
    expect(cellRefs.refs.map((r) => r.name)).toContain("refs/heads/notes");

    // No settle: the parent row keeps its born empty-unborn posture — a wiki
    // push must not flip the CODE cell's is_empty/default_branch
    // (hook_post_receive.go:96 — the wiki's post-receive is not supported).
    const row = await repoService().get(created.id);
    expect(row).not.toBeNull();
    expect(row?.isEmpty).toBe(true);
    expect(row?.status).toBe("ready");
  });

  it("keeps wiki push-create absent: a receive on an unparented wiki name is the bare 404 (githttp.go:215-218)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack);
    const push = await SELF.fetch("https://example.com/alice/nosuch.wiki.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body,
    });
    expect(push.status).toBe(404);
    // No row was push-created under the wiki name (the suffix is reserved —
    // the parent never existed, so nothing may bloom).
    expect(await drizzle(env.DB).select().from(repositories).all()).toHaveLength(0);
  });

  it("301s a renamed parent's wiki git URL with the .wiki marker preserved (row 13 over the parent name)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const created = await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "oldwiki", isPrivate: false });
    await repoService().rename(created.id, "newwiki");

    // (redirect: "manual" — SELF.fetch follows by default.)
    const moved = await SELF.fetch("https://example.com/alice/oldwiki.wiki.git/info/refs?service=git-upload-pack", {
      redirect: "manual",
    });
    expect(moved.status).toBe(301);
    const location = moved.headers.get("location");
    expect(location).toBe("https://example.com/alice/newwiki.wiki.git/info/refs?service=git-upload-pack");
  });

  it("leaves the non-wiki path unchanged: the parent's own git URLs answer exactly as before", async () => {
    await seedWikiParent("bothways", false);
    const parent = await SELF.fetch("https://example.com/alice/bothways.git/info/refs?service=git-upload-pack");
    expect(parent.status).toBe(200);
    expect(parent.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });

  it("gates the wiki's engine JSON api by the parent's read rows (the seeded row must not reopen the passthrough)", async () => {
    const { aliceId } = await seedWikiParent("jsonwiki", true);

    const anon = await SELF.fetch("https://example.com/alice/jsonwiki.wiki/api/refs");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe(CHALLENGE);

    const aliceToken = (await mintFor(aliceId, "r", "read:repository")).plaintext;
    const owner = await SELF.fetch("https://example.com/alice/jsonwiki.wiki/api/refs", {
      headers: { authorization: basicTokenHeader(aliceToken) },
    });
    expect(owner.status).toBe(200);
    expect(new TextDecoder().decode(await owner.arrayBuffer())).toContain("refs/heads/main");
  });

  it("answers admin shapes on wiki names with the bare 404 (a .wiki DELETE never runs the parent cascade)", async () => {
    const { aliceId } = await seedWikiParent("nodeletewiki", true);
    const aliceToken = (await mintFor(aliceId, "w", "write:repository")).plaintext;

    const wiped = await SELF.fetch("https://example.com/alice/nodeletewiki.wiki", {
      method: "DELETE",
      headers: { authorization: basicTokenHeader(aliceToken) },
    });
    expect(wiped.status).toBe(404);
    // The parent row (and its wiki cell) survive — wiki-cell wipes belong to
    // the purge cascade, never an engine-shape DELETE on the sibling name.
    const rows = await drizzle(env.DB).select().from(repositories).all();
    expect(rows).toHaveLength(1);
    const cell = await env.REPO.getByName("alice/nodeletewiki.wiki").listRefs();
    expect(cell.refs.map((r) => r.name)).toContain("refs/heads/main");
  });

  // -------------------------------------------------------------------------
  // The disabled-wiki family — the parent's repo_settings.hasWiki switch
  // (loadRepoSettings) gating the cell per upstream's unit-aware checks
  // (githttp.go at the pin fc493688): reads on a PUBLIC parent take the tail
  // 403 "repository wiki is disabled" (:243-253 — the canAnonymousPull arms
  // skip the whole auth block, so the tail is the only wiki-aware stop);
  // every other matrix-passing arm takes the grant 404 "Repository not
  // found" (:195-199 — the check runs against unitType=TypeWiki, which a
  // disabled unit fails for every principal); anonymous non-public requests
  // stay at the matrix's 401 challenge (:146-160). The other tests in this
  // describe run with has_wiki on — that IS the "enabled unchanged" pin.
  // -------------------------------------------------------------------------

  /** The parent's `repo_settings.has_wiki` flip (loadRepoSettings reads THIS
   *  row; RepoService.create seeds it with the enabled default — the upsert
   *  keeps the flip robust even where a fixture skipped the seed). */
  async function setParentWiki(slug: string, enabled: boolean): Promise<void> {
    const row = await drizzle(env.DB).select({ id: repositories.id }).from(repositories).where(eq(repositories.slug, slug)).get();
    if (row === undefined) throw new Error(`wiki-unit flip: ${slug} row missing`);
    await drizzle(env.DB)
      .insert(repoSettings)
      .values({ repoId: row.id, hasWiki: enabled })
      .onConflictDoUpdate({ target: repoSettings.repoId, set: { hasWiki: enabled } });
  }

  it("403s a public parent's disabled-wiki clone with the exact upstream text, anonymous and granted alike (:243-253)", async () => {
    const { aliceId } = await seedWikiParent("shutwiki", false);
    await setParentWiki("shutwiki", false);
    const aliceToken = (await mintFor(aliceId, "r", "read:repository")).plaintext;

    // Upstream's canAnonymousPull read arms (public repo, public owner) skip
    // the whole auth block, so ANY doer — anonymous or granted — reaches the
    // tail check and takes its 403.
    for (const init of [{}, { headers: { authorization: basicTokenHeader(aliceToken) } }]) {
      const advert = await SELF.fetch("https://example.com/alice/shutwiki.wiki.git/info/refs?service=git-upload-pack", init);
      expect(advert.status).toBe(403);
      // ctx.PlainText writes verbatim — no trailing newline — with the
      // plainText family's content-type + nosniff pair.
      expect(new TextDecoder().decode(await advert.arrayBuffer())).toBe("repository wiki is disabled");
      expect(advert.headers.get("content-type")).toBe("text/plain;charset=utf-8");
      expect(advert.headers.get("x-content-type-options")).toBe("nosniff");
    }

    // The synthetic HEAD rides the same read verdict.
    const head = await SELF.fetch("https://example.com/alice/shutwiki.wiki.git/HEAD");
    expect(head.status).toBe(403);
    expect(new TextDecoder().decode(await head.arrayBuffer())).toBe("repository wiki is disabled");
  });

  it("404s a granted doer's read of a private parent's disabled wiki (the unitType=TypeWiki grant arm, :195-199)", async () => {
    const { aliceId, tip } = await seedWikiParent("lockedwiki", true);
    await setParentWiki("lockedwiki", false);
    const aliceToken = (await mintFor(aliceId, "r", "read:repository")).plaintext;

    const advert = await SELF.fetch("https://example.com/alice/lockedwiki.wiki.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(aliceToken) },
    });
    expect(advert.status).toBe(404);
    expect(new TextDecoder().decode(await advert.arrayBuffer())).toBe("Repository not found");

    const head = await SELF.fetch("https://example.com/alice/lockedwiki.wiki.git/HEAD", {
      headers: { authorization: basicTokenHeader(aliceToken) },
    });
    expect(head.status).toBe(404);
    expect(new TextDecoder().decode(await head.arrayBuffer())).not.toContain(tip);
  });

  it("401-challenges the anonymous clone of a private parent's disabled wiki (the matrix precedes the verdict)", async () => {
    await seedWikiParent("darkwiki", true);
    await setParentWiki("darkwiki", false);

    const advert = await SELF.fetch("https://example.com/alice/darkwiki.wiki.git/info/refs?service=git-upload-pack");
    expect(advert.status).toBe(401);
    expect(advert.headers.get("www-authenticate")).toBe(CHALLENGE);
  });

  it("404s every push at a disabled wiki — advert probe and RPC — and lands no ref (:195-199 for writes)", async () => {
    const { aliceId } = await seedWikiParent("frozenwiki", false);
    await setParentWiki("frozenwiki", false);
    const aliceToken = (await mintFor(aliceId, "w", "write:repository")).plaintext;

    // The receive-pack ADVERT (anonymous and granted): writes never take the
    // tail 403 — anonymous stays at the challenge, the granted owner takes
    // the grant 404 (upstream's accessMode stays Write for wiki URLs and
    // CanAccess(Write, TypeWiki) fails for a disabled unit).
    const anonAdvert = await SELF.fetch("https://example.com/alice/frozenwiki.wiki.git/info/refs?service=git-receive-pack");
    expect(anonAdvert.status).toBe(401);
    expect(anonAdvert.headers.get("www-authenticate")).toBe(CHALLENGE);

    const probe = await SELF.fetch("https://example.com/alice/frozenwiki.wiki.git/info/refs?service=git-receive-pack", {
      headers: { authorization: basicTokenHeader(aliceToken) },
    });
    expect(probe.status).toBe(404);
    expect(new TextDecoder().decode(await probe.arrayBuffer())).toBe("Repository not found");

    // The full RPC refuses at the same gate — the sibling cell never sees it.
    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody([{ ref: "refs/heads/notes", oid }], pack);
    const push = await SELF.fetch("https://example.com/alice/frozenwiki.wiki.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(aliceToken), "content-type": RECEIVE_CT },
      body,
    });
    expect(push.status).toBe(404);
    const cellRefs = await env.REPO.getByName("alice/frozenwiki.wiki").listRefs();
    expect(cellRefs.refs.map((r) => r.name)).not.toContain("refs/heads/notes");
  });

  it("gates the disabled wiki's engine JSON api by the same family verdict", async () => {
    const { aliceId } = await seedWikiParent("jsonoff", false);
    await setParentWiki("jsonoff", false);

    // Public parent: the read arm's tail 403, exactly like the git family.
    const anon = await SELF.fetch("https://example.com/alice/jsonoff.wiki/api/refs");
    expect(anon.status).toBe(403);
    expect(new TextDecoder().decode(await anon.arrayBuffer())).toBe("repository wiki is disabled");

    // Flip the SAME parent private (no second seed — seedVerifiedUser is not
    // idempotent within a test): the granted owner now takes the 404.
    await drizzle(env.DB).update(repositories).set({ visibility: "private" }).where(eq(repositories.slug, "jsonoff")).run();
    const aliceToken = (await mintFor(aliceId, "r", "read:repository")).plaintext;
    const owner = await SELF.fetch("https://example.com/alice/jsonoff.wiki/api/refs", {
      headers: { authorization: basicTokenHeader(aliceToken) },
    });
    expect(owner.status).toBe(404);
    expect(new TextDecoder().decode(await owner.arrayBuffer())).toBe("Repository not found");
  });
});

// ---------------------------------------------------------------------------------
// The 401 realm follows the pin's OAuth2 switch (githttp.go:152-158 — LIVE per
// SPEC specs/oauth2-provider.md §2.11) and deploy tokens authenticate git-HTTP
// (the upstream DeployToken method, web.go:135-136)
// ---------------------------------------------------------------------------------

describe("the 401 challenge realm follows the OAuth2 provider gate (SPEC oauth2-provider §2.11)", () => {
  it("answers Basic realm=\"Gitea\" under the enabled-by-default provider — the GCM built-in-application realm", async () => {
    await pushCreateAndSettle("realmonly");
    const challenge = await SELF.fetch(
      "https://example.com/alice/realmonly.git/info/refs?service=git-upload-pack",
    );
    expect(challenge.status).toBe(401);
    // The exact pin: `setting.OAuth2.Enabled` (default true; our
    // OAUTH2_ENABLED strict polarity) selects `realm="Gitea"` — GCM then
    // attempts its built-in OAuth2 application (git-credential-manager#1442;
    // the migration-0052 builtin seed makes the attempt land). The disabled
    // arm ("Gitea (Basic Auth)") is pinned at the challenge site in
    // web/oauth2-wellknown.test.ts.
    expect(challenge.headers.get("www-authenticate")).toBe('Basic realm="Gitea"');
  });
});

describe("deploy tokens authenticate git-HTTP (upstream's DeployToken method, web.go:135-136)", () => {
  /** pushCreateAndSettle + a deploy key row: the repo id comes back for the
   *  key seed, the plaintext token only ever rides the return value. */
  async function seedRepoWithToken(
    slug: string,
    readOnly: boolean,
  ): Promise<{ token: string; repoId: string }> {
    await pushCreateAndSettle(slug);
    const repo = (await drizzle(env.DB).select().from(repositories).all())[0]!;
    const added = await addDeployKeyToken(env.DB, repo.id, `deploy-${slug}`, readOnly);
    if (added.token === undefined) throw new Error("token create returned no plaintext");
    return { token: added.token, repoId: repo.id };
  }

  it("admits a read-only token's clone advert in the password form (upstream semantics)", async () => {
    const { token } = await seedRepoWithToken("dtclone", true);
    const advert = await SELF.fetch(
      "https://example.com/alice/dtclone.git/info/refs?service=git-upload-pack",
      { headers: { authorization: basicHeader("git", token) } },
    );
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });

  it("admits the username-only Basic form too (parseAuthBasic's token-as-username)", async () => {
    const { token } = await seedRepoWithToken("dtuser", true);
    const advert = await SELF.fetch(
      "https://example.com/alice/dtuser.git/info/refs?service=git-upload-pack",
      { headers: { authorization: basicTokenHeader(token) } },
    );
    expect(advert.status).toBe(200);
  });

  it("a write-mode token pushes for real: advert 200 and a receive lands the ref", async () => {
    const { token } = await seedRepoWithToken("dtwrite", false);
    const probe = await SELF.fetch(
      "https://example.com/alice/dtwrite.git/info/refs?service=git-receive-pack",
      { headers: { authorization: basicHeader("git", token) } },
    );
    expect(probe.status).toBe(200);

    const { oid, pack } = await buildPack();
    const push = await SELF.fetch("https://example.com/alice/dtwrite.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicHeader("git", token), "content-type": RECEIVE_CT },
      body: buildReceivePackBody([{ ref: "refs/heads/feature", oid }], pack),
    });
    expect(push.status).toBe(200);
    const refs = await env.REPO.getByName("alice/dtwrite").listRefs();
    expect(refs.refs.map((r) => r.name)).toContain("refs/heads/feature");
  });

  it("a read-only token's receive is 404-masked (upstream :197-199 write-capability hiding)", async () => {
    const { token } = await seedRepoWithToken("dtro", true);
    const probe = await SELF.fetch(
      "https://example.com/alice/dtro.git/info/refs?service=git-receive-pack",
      { headers: { authorization: basicHeader("git", token) } },
    );
    expect(probe.status).toBe(404);
    expect(new TextDecoder().decode(await probe.arrayBuffer())).toBe("Repository not found");
  });

  it("a key for another repository grants nothing here: 404 on its own op, public repos stay open", async () => {
    const { token } = await seedRepoWithToken("dtmine", true);
    // A second, PRIVATE repo: the foreign key is the zero-perm 404
    // (repo_permission.go:393 — "the key belongs to another repository, so
    // it grants nothing here"). The owner is the alice row push-create
    // already seeded — seeding her again trips users.username_lower's UNIQUE.
    const alice = (await drizzle(env.DB).select().from(users).all())[0]!;
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "dtother", isPrivate: true });
    const foreign = await SELF.fetch(
      "https://example.com/alice/dtother.git/info/refs?service=git-upload-pack",
      { headers: { authorization: basicHeader("git", token) } },
    );
    expect(foreign.status).toBe(404);

    // Upstream's canAnonymousPull arm admits any signed-in doer's pull on a
    // public repo with a public owner (:132-135) — key user included.
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "dtpublic", isPrivate: false });
    await env.DB.prepare("DELETE FROM repo_units").run();
    const open = await SELF.fetch(
      "https://example.com/alice/dtpublic.git/info/refs?service=git-upload-pack",
      { headers: { authorization: basicHeader("git", token) } },
    );
    expect(open.status).toBe(200);
  });

  it("an unknown gdt_ value falls through every method into the 401 challenge", async () => {
    await seedRepoWithToken("dtmissing", true);
    const miss = await SELF.fetch(
      "https://example.com/alice/dtmissing.git/info/refs?service=git-upload-pack",
      { headers: { authorization: basicHeader("git", "gdt_notarealtoken0123456789abcdef0123456789abcdefg") } },
    );
    expect(miss.status).toBe(401);
    expect(miss.headers.get("www-authenticate")).toBe(CHALLENGE);
  });

  it("a Bearer gdt_ value is NOT a deploy credential (parseAuthBasic reads Basic only)", async () => {
    const { token } = await seedRepoWithToken("dtbearer", true);
    const bearer = await SELF.fetch(
      "https://example.com/alice/dtbearer.git/info/refs?service=git-upload-pack",
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(bearer.status).toBe(401);
  });

  it("an engine-shape admin DELETE stays refused for a write-mode key (git data only)", async () => {
    const { token } = await seedRepoWithToken("dtadmin", false);
    const wipe = await SELF.fetch("https://example.com/alice/dtadmin", {
      method: "DELETE",
      headers: { authorization: basicHeader("git", token) },
    });
    expect(wipe.status).toBe(404);
    expect(new TextDecoder().decode(await wipe.arrayBuffer())).toBe("Repository not found");
    expect(await drizzle(env.DB).select().from(repositories).all()).toHaveLength(1);
  });

  it("touches updated_unix on use (upstream UpdateDeployKeyLastUsed / the HasUsed gate)", async () => {
    const { token, repoId } = await seedRepoWithToken("dtused", true);
    const before = await drizzle(env.DB).select().from(deployKeys).all();
    expect(before).toHaveLength(1);
    expect(before[0]!.updatedAt.getTime()).toBe(before[0]!.createdAt.getTime());

    // The §2.7 24h throttle suppresses the touch on a FRESH key (the arm the
    // matrix runs is `needsDeployKeyLastUsedTouch ? touch : no-op`) — backdate
    // the stamp past the window so the use below moves it.
    const staleMs = before[0]!.updatedAt.getTime() - 25 * 60 * 60 * 1000;
    await env.DB.prepare("UPDATE deploy_keys SET updated_unix = ? WHERE id = ?")
      .bind(Math.floor(staleMs / 1000), before[0]!.id)
      .run();

    const advert = await SELF.fetch(
      "https://example.com/alice/dtused.git/info/refs?service=git-upload-pack",
      { headers: { authorization: basicHeader("git", token) } },
    );
    expect(advert.status).toBe(200);
    // The touch rides ctx.waitUntil in production; on the runner the
    // background work lands within the test — poll for the stamp to move off
    // the backdated value. Compared against the backdate (25h in the past),
    // NOT against created_unix: both stamps are second-granular columns and a
    // sub-second seed→use gap truncates the two equal (exact round-trip is
    // pinned at second precision in deploy-token-service.test.ts).
    let used = false;
    for (let i = 0; i < 60 && !used; i++) {
      const rows = await drizzle(env.DB).select().from(deployKeys).all();
      used = rows[0]!.updatedAt.getTime() > staleMs;
      if (!used) await new Promise((r) => setTimeout(r, 50));
    }
    expect(used).toBe(true);
    expect((await drizzle(env.DB).select().from(deployKeys).all())[0]!.repoId).toBe(repoId);
  });
});
