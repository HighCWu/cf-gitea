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
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { serializeCommit, serializeTag, serializeTree } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicHeader, basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { doerRepoAccessMode } from "../api/services/repository";
import { addDeployKeyToken } from "../api/services/deploy-keys";
import { TeamsService } from "../api/routes/org-teams";
import { OrgService } from "../services/orgs/orgs";
import { settleCreatingRepo, applyPushTail, type PushTailCommands } from "./gate";
import { authorizeGitHttp } from "./acl";
import type { AuthUser } from "../auth/auth-context";
import { createWikiPage } from "../services/wiki";
import { ensureCargoIndexMirror } from "../services/packages/cargo-index";
import type { AutoMergeCheckMessage } from "../services/pull-automerge";
import {
  agitHeadBranch,
  parseAgitPushOptionValue,
  pushOptionBool,
  pushOptionsMap,
  resolveAgitBaseTopic,
  splitCommitTitleBody,
} from "../api/services/agit";
import { deployKeys, PRFlow, PRStatus, repoCounters, repoRedirects, repoSettings, repositories, issues, protectedBranches, pullRequests, pullReviews, releases, ReviewType, userBlocking, users, webhookDeliveries, webhooks, comments, trackedTimes, actions } from "../db/schema";
import { emptyRuleConfig, serializeRuleConfig, type ProtectedBranchConfig } from "../services/branch-protection";
import { purgeRepoMessage } from "../repos/purge";
import { IssuesService } from "../issues/service";
import { CommentType } from "../issues/comment-types";
import { RepoService } from "../repos/service";
import { LFS_MEDIA_TYPE } from "../services/lfs/batch";
import { ZERO_OID, buildPack, buildReceivePackBody, drainReceive, pktLine } from "../repos/testing/git-pack";

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
  // SPEC 0230: the streaming answer resolves before the push applies; drain
  // to stream end (the arm closes strictly after finalize) so the settle
  // below reads the POST-push engine state
  await drainReceive(response);

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
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

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
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);
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
    await settleCreatingRepo({ DB: env.DB, REPO: env.REPO, REPO_PACKS: env.REPO_PACKS, REPO_TASKS: env.REPO_TASKS }, noVarRow, "alice/settledorigin", requestOrigin);
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
  // SPEC 0230: the streaming answer resolves before the push applies;
  // drain to stream end — the arm closes strictly after finalize's
  // transaction, so stream end is the push-completion signal
  await drainReceive(push);

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
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

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
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);
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
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

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
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

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
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

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
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

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

  it("a first-ever wiki push births the registry row ALREADY priv=1 — the write arm seeds BEFORE the forward (engine upsert mod.ts:1399-1401)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    await repoService().create({ owner: { id: alice.id, usernameLower: "alice" }, name: "wikipushseed", isPrivate: false });
    const aliceToken = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const name = "alice/wikipushseed.wiki";

    // The cell is born registry-less (services/wiki.ts) and this push is the
    // FIRST protocol traffic it ever sees — no prior read ever seeded it.
    expect(await env.REGISTRY.getByName("registry").get(name)).toBeNull();

    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack);
    const push = await SELF.fetch("https://example.com/alice/wikipushseed.wiki.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(aliceToken), "content-type": RECEIVE_CT },
      body,
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);
    const cellRefs = await env.REPO.getByName(name).listRefs();
    expect(cellRefs.refs.map((r) => r.name)).toContain("refs/heads/main");

    // The invariant: the row the engine's post-push bookkeeping upsert
    // (mod.ts:1399-1401) would otherwise INSERT at the DDL default 0 exists
    // at priv=1 — the gate seeded it before the forward, so the engine's
    // upsert rode its ON CONFLICT arm (idle/ver only, registry.ts:37-44).
    const row = await env.REGISTRY.getByName("registry").get(name);
    expect(row).not.toBeNull();
    expect(row?.priv).toBe(1);
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
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);
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
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);
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
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);
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

  it("a push into an ARCHIVED repo takes the PRE-grant archived 403 — a read-mode key's receive too, not the zero-perm 404 (githttp.go:124-128 orders it before the key permission)", async () => {
    const { token, repoId } = await seedRepoWithToken("dtfrozen", true);
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, repoId));

    // Upstream httpBase answers the archived push 403 BEFORE
    // GetDoerRepoPermission (the key's ONLY permission source, :185-193) —
    // so even the read-mode key (which the write mask would 404) gets the
    // archived body here. The masking order is the S6 residual's fix.
    const probe = await SELF.fetch(
      "https://example.com/alice/dtfrozen.git/info/refs?service=git-receive-pack",
      { headers: { authorization: basicHeader("git", token) } },
    );
    expect(probe.status).toBe(403);
    expect(await probe.text()).toBe(
      "This repo is archived. You can view files and clone it, but cannot push or open issues/pull-requests.",
    );

    // The `!isPull` gate: the same key's clone advert still serves.
    const clone = await SELF.fetch(
      "https://example.com/alice/dtfrozen.git/info/refs?service=git-upload-pack",
      { headers: { authorization: basicHeader("git", token) } },
    );
    expect(clone.status).toBe(200);
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

// ---------------------------------------------------------------------------
// Upstream-parity arms (services-parity review items 3-5): the mirror-readonly
// 403's verbatim PlainText body, the PRE-AUTH owner-inactive/archived 403s
// (anonymous callers get the plain 403 body, never the 401 Basic challenge),
// and the `?go-get=1` meta answering on every git route upstream's httpBase
// reaches (githttp.go:63-66 — GET /info/refs AND the POST RPCs).
// ---------------------------------------------------------------------------

describe("upstream-parity arms: mirror 403 body, pre-auth 403s, go-get on every git route", () => {
  /** One minimal public D1 repo row (the ACL-only arms never reach the engine). */
  async function seedGateRepo(slug: string, extra: Partial<typeof repositories.$inferInsert> = {}) {
    const alice = await seedVerifiedUser({ username: "Alice" });
    await drizzle(env.DB)
      .insert(repositories)
      .values({
        id: `g_${slug}`,
        storageKey: `r_g_${slug}`,
        ownerNamespace: "alice",
        ownerId: alice.id,
        slug,
        visibility: "public",
        ...extra,
      });
    return alice;
  }

  it("mirror-readonly 403 writes the body verbatim (no trailing newline) with upstream's PlainText headers", async () => {
    const alice = await seedGateRepo("mirror", { isMirror: true });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;

    const advert = await SELF.fetch(
      "https://example.com/alice/mirror.git/info/refs?service=git-receive-pack",
      { headers: { authorization: basicTokenHeader(token) } },
    );
    expect(advert.status).toBe(403);
    // ctx.PlainText (base.go plainTextInternal) writes the string VERBATIM —
    // the review's finding: the old inline shape appended `\n`.
    expect(await advert.text()).toBe("mirror repository is read-only");
    expect(advert.headers.get("content-type")).toBe("text/plain;charset=utf-8");
    expect(advert.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("owner-inactive answers the plain 403 PRE-auth — anonymous gets the body, not the 401 challenge (githttp.go:103-107)", async () => {
    const alice = await seedGateRepo("frozenowner");
    await drizzle(env.DB).update(users).set({ status: "prohibited" }).where(eq(users.id, alice.id));

    const anonymous = await SELF.fetch(
      "https://example.com/alice/frozenowner.git/info/refs?service=git-upload-pack",
    );
    expect(anonymous.status).toBe(403);
    expect(anonymous.headers.get("www-authenticate")).toBeNull();
    expect(await anonymous.text()).toBe(
      "Repository cannot be accessed. You cannot push or open issues/pull-requests.",
    );

    // The owner themself (valid token, write scope): the same pre-auth 403 —
    // upstream's block runs for every caller.
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const owner = await SELF.fetch("https://example.com/alice/frozenowner.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(owner.status).toBe(403);
    expect(await owner.text()).toBe(
      "Repository cannot be accessed. You cannot push or open issues/pull-requests.",
    );
  });

  it("archived pushes answer the plain 403 PRE-auth — anonymous gets the body, not the 401 challenge; clones keep working (githttp.go:124-128)", async () => {
    await seedGateRepo("frozen", { isArchived: true });

    const anonymousPush = await SELF.fetch(
      "https://example.com/alice/frozen.git/info/refs?service=git-receive-pack",
    );
    expect(anonymousPush.status).toBe(403);
    expect(anonymousPush.headers.get("www-authenticate")).toBeNull();
    expect(await anonymousPush.text()).toBe(
      "This repo is archived. You can view files and clone it, but cannot push or open issues/pull-requests.",
    );

    // Reads are unaffected by the archived refusal (the `!isPull` gate) — the
    // anonymous clone advert still serves once the engine knows the name.
    await env.REGISTRY.getByName("registry").upsert("alice/frozen", Date.now());
    const clone = await SELF.fetch("https://example.com/alice/frozen.git/info/refs?service=git-upload-pack");
    expect(clone.status).toBe(200);
  });

  it("?go-get=1 answers the go-import meta on the RPC routes too (httpBase answers before auth/existence)", async () => {
    const meta = '<meta name="go-import" content="example.com/nobody/nothing git https://example.com/nobody/nothing.git">';

    // The upload-pack RPC (POST, the router-admitted method).
    const uploadRpc = await SELF.fetch("https://example.com/nobody/nothing.git/git-upload-pack?go-get=1", {
      method: "POST",
      headers: { "content-type": UPLOAD_CT },
      body: "0000",
    });
    expect(uploadRpc.status).toBe(200);
    expect(await uploadRpc.text()).toBe(meta);

    // The receive-pack RPC — the anonymous push-create advert probe would
    // otherwise 401 BEFORE anything else; the meta outranks it like upstream.
    const receiveRpc = await SELF.fetch("https://example.com/nobody/nothing.git/git-receive-pack?go-get=1", {
      method: "POST",
      headers: { "content-type": RECEIVE_CT },
      body: "0000",
    });
    expect(receiveRpc.status).toBe(200);
    expect(await receiveRpc.text()).toBe(meta);
  });

  it("go-get follows upstream's router method bindings: a method the router would not route gets no meta", async () => {
    // GET /git-upload-pack is not a chi route upstream (POST,OPTIONS only) —
    // no meta; the request falls through to the ordinary pipeline (here the
    // D1-miss registry-oracle 404).
    const getRpc = await SELF.fetch("https://example.com/nobody/nothing.git/git-upload-pack?go-get=1");
    expect(getRpc.status).toBe(404);
    expect(await getRpc.text()).not.toContain("go-import");

    // POST /info/refs is likewise not a route (GET,OPTIONS only) — no meta;
    // on a D1-resolved repo the service parse answers the bare 400 (§2.2,
    // no ?service).
    await seedGateRepo("postrefs");
    const postRefs = await SELF.fetch("https://example.com/alice/postrefs.git/info/refs?go-get=1", {
      method: "POST",
      headers: { "content-type": UPLOAD_CT },
      body: "0000",
    });
    expect(postRefs.status).toBe(400);
    expect(await postRefs.text()).not.toContain("go-import");

    // The synthetic HEAD file has no upstream httpBase arm at all — no meta.
    const head = await SELF.fetch("https://example.com/nobody/nothing.git/HEAD?go-get=1");
    expect(head.status).toBe(404);
    expect(await head.text()).not.toContain("go-import");
  });
});

// ---------------------------------------------------------------------------
// The R5/D-7c push tail (the v1.5.3 continuation): a receive-pack's tag
// deletions run upstream PushUpdateDeleteTags' D1 lifecycle (models/repo/
// release.go:465-492 — the is_tag records die, the real releases withdraw to
// draft with the zero-valued sha1/num_commits/published_unix), and a PR-head
// push (refs/pull/N/head) enqueues ONE auto-merge-check REPO_TASKS message.
// The command collection rides the receive validator (in-process — the
// engine surfaces its applied updates only on the worker entry's onPush
// hook), and applyPushTail verifies against the post-commit refs before
// touching D1, so a CAS-conflicted delete ("fetch first" ng) flips nothing.
// ---------------------------------------------------------------------------


/** A sendBatch-recording REPO_TASKS stub — Queue-SHAPED so the B-47-widened
 *  XrefPushEnv tail env accepts it structurally (the D-7c test's `{...env,
 *  REPO_TASKS: spy}` spread); the bodies log is the assertion surface. */
function spyQueue(): Queue<unknown> & { bodies: { body: unknown }[][] } {
  const bodies: { body: unknown }[][] = [];
  const metrics = { backlogCount: 0, backlogBytes: 0 };
  return {
    bodies,
    metrics: () => Promise.resolve(metrics),
    send: () => Promise.resolve({ metadata: { metrics } }),
    sendBatch: (messages) => {
      bodies.push([...messages]);
      return Promise.resolve({ metadata: { metrics } });
    },
  };
}

/** alice/<slug> via RepoService with a pushed main; returns the row + the
 *  owner's write token (the tag-protection-push fixture shape). */
async function seedTailRepo(slug: string): Promise<{ repoId: string; engineName: string; ownerId: number; token: string; tip: string }> {
  const alice = await seedVerifiedUser({ username: "Alice" });
  const created = await repoService().create({
    owner: { id: alice.id, usernameLower: "alice" },
    name: slug,
    isPrivate: false,
  });
  const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
  const { oid, pack } = await buildPack();
  const body = buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack);
  const push = await SELF.fetch(`https://example.com/alice/${slug}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
    body,
  });
  expect(push.status).toBe(200);
  // SPEC 0230: the streaming answer resolves before the push applies;
  // drain to stream end — the arm closes strictly after finalize's
  // transaction, so stream end is the push-completion signal
  await drainReceive(push);
  return { repoId: created.id, engineName: `alice/${slug}`, ownerId: alice.id, token, tip: oid };
}

/** Seed one release row (a real release or a tag-only record) through the
 *  shared service (the releases.test.ts seeding shape). */
async function seedReleaseRow(repoId: string, publisherId: number, tag: string, isTag: boolean): Promise<number> {
  const row = await new IssuesService(env.DB).createRelease({
    repoId,
    publisherId,
    tagName: tag,
    target: "main",
    title: `Rel ${tag}`,
    note: "",
    isDraft: false,
    isPrerelease: false,
    isTag,
    now: new Date(),
  });
  return row.id;
}

describe("the R5 push tail: git-push tag deletion draft-flips releases (PushUpdateDeleteTags, release.go:465-492)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM releases").run();
    await env.DB.prepare("DELETE FROM issues").run();
  });

  it("a receive-pack tag delete draft-flips the release and drops the tag-only record (end-to-end)", async () => {
    const { repoId, engineName, ownerId, token, tip } = await seedTailRepo("r5flip");
    // Engine refs first: v1 and v2 exist as real tag refs (buildPack's commit).
    const cell = env.REPO.getByName(engineName);
    for (const ref of ["refs/tags/v1", "refs/tags/v2"]) {
      const landed = await cell.commitApiChange({ ref, expectedOldOid: ZERO_OID, newOid: tip });
      expect(landed.tag).toBe("committed");
    }
    const releaseId = await seedReleaseRow(repoId, ownerId, "v1", false);
    const tagOnlyId = await seedReleaseRow(repoId, ownerId, "v2", true);
    // The release is published and filled (the state a delete withdraws).
    await drizzle(env.DB)
      .update(releases)
      .set({ publishedUnix: 1_700_000_000, sha1: tip, numCommits: 3 })
      .where(eq(releases.id, releaseId));

    // THE PUSH: delete both tags over the real receive-pack (old = the live
    // tip, new = the zero oid — a delete command carries NO pack; the
    // tag-protection-push suite's receiveBody shape). The tail runs in
    // waitUntil on the runner (production ctx.waitUntil; observed landed
    // within seconds — the settle precedent), so poll for the flip.
    const section =
      pktLine(`${tip} ${ZERO_OID} refs/tags/v1\0report-status side-band-64k`) +
      pktLine(`${tip} ${ZERO_OID} refs/tags/v2`) +
      "0000";
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: new TextEncoder().encode(section),
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

    await vi.waitFor(
      async () => {
        const flipped = await drizzle(env.DB).select().from(releases).where(eq(releases.id, releaseId)).get();
        // The real release SURVIVES, withdrawn to draft with the zero-valued
        // Cols (release.go:480-490 — is_draft, num_commits, sha1,
        // published_unix).
        expect(flipped?.isDraft).toBe(true);
        expect(flipped?.publishedUnix).toBe(0);
        expect(flipped?.sha1).toBe("");
        expect(flipped?.numCommits).toBe(0);
      },
      { timeout: 15_000, interval: 300 },
    );
    // The tag-only record DIED with its tag (release.go:471-478).
    expect(await drizzle(env.DB).select().from(releases).where(eq(releases.id, tagOnlyId)).all()).toEqual([]);
    // The engine refs are gone (the receive itself, not the tail).
    const refs = (await cell.listRefs()).refs.map((r) => r.name);
    expect(refs).not.toContain("refs/tags/v1");
    expect(refs).not.toContain("refs/tags/v2");
  });

  it("a CAS-conflicted delete (the ref still present post-push) flips nothing (the verify arm)", async () => {
    const { repoId, engineName, ownerId } = await seedTailRepo("r5conflict");
    const cell = env.REPO.getByName(engineName);
    const landed = await cell.commitApiChange({ ref: "refs/tags/v1", expectedOldOid: ZERO_OID, newOid: (await cell.listRefs()).refs.find((r) => r.name === "refs/heads/main")!.target });
    expect(landed.tag).toBe("committed");
    const releaseId = await seedReleaseRow(repoId, ownerId, "v1", false);

    // The tail invoked with a delete whose ref is STILL THERE (the shape a
    // CAS-conflicted command leaves behind): the verify filters it, D1
    // untouched.
    const tail: PushTailCommands = { tagDeletes: ["v1"], tagAdds: [], prHeadPushes: [], branchPushes: [], pusherId: ownerId };
    await applyPushTail(env, (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get())!, engineName, tail);

    const row = await drizzle(env.DB).select().from(releases).where(eq(releases.id, releaseId)).get();
    expect(row?.isDraft).toBe(false);
    // The service stamped published_at on the seeded publish — untouched
    // means the withdrawal never ran.
    expect((row?.publishedUnix ?? 0)).toBeGreaterThan(0);
  });

  // --- B-54: the mint arm (upstream pushUpdateAddTags, push.go:323-409) ---

  it("a receive-pack LIGHTWEIGHT tag create mints the is_tag row (end-to-end, push.go:361-378)", async () => {
    const { repoId, engineName, ownerId, token, tip } = await seedTailRepo("b54mint");
    // The commit's committer time is buildPack's fixed 1700000000 and the
    // message "initial push-create\n" — the mint's created_unix/published_unix
    // (Tagger nil → published = created) and title/note sources.
    // The objects already landed with main — a valid pack stream is still
    // required, so the tag commands ride buildPack's pack verbatim.
    const { pack } = await buildPack();
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildReceivePackBody(
        [
          { ref: "refs/tags/v1", oid: tip },
          { ref: "refs/tags/v2", oid: tip },
        ],
        pack,
      ),
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

    await vi.waitFor(async () => {
      const rows = await drizzle(env.DB).select().from(releases).where(eq(releases.repoId, repoId)).all();
      expect(rows).toHaveLength(2);
    });
    const byTag = new Map(
      (await drizzle(env.DB).select().from(releases).where(eq(releases.repoId, repoId)).all()).map((row) => [row.tagName, row]),
    );
    const v1 = byTag.get("v1");
    const v2 = byTag.get("v2");
    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    for (const row of [v1, v2]) {
      // The minted row's exact shape (push.go:361-378 — Target "", the
      // numCommits -1 placeholder, IsDraft/IsPrerelease false, IsTag true,
      // publisher = the pusher, created_unix = the commit's committer time,
      // published_unix = created_unix on the lightweight shape, title/note
      // from SplitCommitTitleBody of the commit's message).
      expect(row?.target).toBe("");
      expect(row?.sha1).toBe(tip);
      expect(row?.numCommits).toBe(-1);
      expect(row?.isDraft).toBe(false);
      expect(row?.isPrerelease).toBe(false);
      expect(row?.isTag).toBe(true);
      expect(row?.publisherId).toBe(ownerId);
      expect(row?.createdAt?.getTime()).toBe(1700000000 * 1000);
      expect(row?.publishedUnix).toBe(1700000000);
      expect(row?.title).toBe("initial push-create");
      expect(row?.note).toBe("");
    }
    // Original-case tag_name rows, lowered lookup keys.
    expect(v1?.lowerTagName).toBe("v1");
    expect(v2?.lowerTagName).toBe("v2");
  });

  it("a receive-pack ANNOTATED tag create mints published_unix from the tagger and title/note from the tag message (push.go:350-356)", async () => {
    const { repoId, engineName, ownerId, token, tip } = await seedTailRepo("b54annotated");
    const cell = env.REPO.getByName(engineName);
    const TAGGER_TIME = 1_750_000_000;
    const tag = serializeTag({
      object: tip,
      type: "commit",
      tag: "v9",
      tagger: { name: "Tagger User", email: "tagger@example.com", time: TAGGER_TIME, tz: "+0000" },
      message: "annotated subject\nbody line\n",
    });
    const stored = await cell.putApiObjects([{ oid: tag.oid, type: tag.type, data: tag.data }]);
    expect(stored.tag).toBe("ok");
    const { pack } = await buildPack();
    const body = buildReceivePackBody([{ ref: "refs/tags/v9", oid: tag.oid }], pack);
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body,
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

    await vi.waitFor(async () => {
      expect(await drizzle(env.DB).select().from(releases).where(eq(releases.repoId, repoId)).all()).toHaveLength(1);
    });
    const row = (await drizzle(env.DB).select().from(releases).where(eq(releases.repoId, repoId)).all())[0];
    // sha1 = the PEELED commit (GetTagCommit), created_unix = the commit's
    // committer time (1700000000), published_unix = the TAGGER time
    // (push.go:351-354), title/note split from the annotated message
    // (push.go:356 — the first "\n" cut).
    expect(row?.sha1).toBe(tip);
    expect(row?.createdAt?.getTime()).toBe(1700000000 * 1000);
    expect(row?.publishedUnix).toBe(TAGGER_TIME);
    expect(row?.title).toBe("annotated subject");
    expect(row?.note).toBe("body line\n");
    expect(row?.isTag).toBe(true);
    expect(row?.publisherId).toBe(ownerId);
  });

  it("the mint's verify arm: a collected add whose ref is absent post-push mints nothing (the CAS-conflict shape)", async () => {
    const { repoId, engineName, ownerId } = await seedTailRepo("b54conflict");
    const tail: PushTailCommands = { tagDeletes: [], tagAdds: ["ghost"], prHeadPushes: [], branchPushes: [], pusherId: ownerId };
    await applyPushTail(env, (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get())!, engineName, tail);
    expect(await drizzle(env.DB).select().from(releases).where(eq(releases.repoId, repoId)).all()).toEqual([]);
  });

  it("the refresh arms (push.go:380-403): a real release keeps its publish stamp and un-drafts, an is_tag row refreshes title/note/published, the publisher follows the pusher", async () => {
    const { repoId, engineName, ownerId } = await seedTailRepo("b54refresh");
    const cell = env.REPO.getByName(engineName);
    const tip = (await cell.listRefs()).refs.find((ref) => ref.name === "refs/heads/main")!.target;
    // Real release + is_tag record on tags that already exist as refs (the
    // direct-CAS seeding shape — applyPushTail runs directly, no receive).
    for (const ref of ["refs/tags/rel-tag", "refs/tags/pure-tag"]) {
      const landed = await cell.commitApiChange({ ref, expectedOldOid: ZERO_OID, newOid: tip });
      expect(landed.tag).toBe("committed");
    }
    const relId = await seedReleaseRow(repoId, 424242, "rel-tag", false);
    const pureId = await seedReleaseRow(repoId, 424242, "pure-tag", true);
    await drizzle(env.DB)
      .update(releases)
      .set({ publishedUnix: 1_700_000_000, sha1: "", numCommits: 7, isDraft: true, title: "Real release", note: "kept note" })
      .where(eq(releases.id, relId));
    await drizzle(env.DB)
      .update(releases)
      .set({ title: "stale title", note: "stale note", publishedUnix: 1, sha1: null, createdAt: new Date(0) })
      .where(eq(releases.id, pureId));

    await applyPushTail(env, (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get())!, engineName, {
      tagDeletes: [],
      tagAdds: ["rel-tag", "pure-tag"],
      prHeadPushes: [], branchPushes: [],
      pusherId: ownerId,
    });

    const rel = (await drizzle(env.DB).select().from(releases).where(eq(releases.id, relId)).get())!;
    // The REAL release: sha1/created_unix refresh, isDraft=false, a NON-zero
    // published_unix survives (push.go:388-392's zero arm), title/note/
    // num_commits untouched, publisher = the PUSHER (push.go:403 — both
    // arms).
    expect(rel.sha1).toBe(tip);
    expect(rel.createdAt?.getTime()).toBe(1700000000 * 1000);
    expect(rel.isDraft).toBe(false);
    expect(rel.publishedUnix).toBe(1_700_000_000);
    expect(rel.title).toBe("Real release");
    expect(rel.note).toBe("kept note");
    expect(rel.numCommits).toBe(7);
    expect(rel.publisherId).toBe(ownerId);

    const pure = (await drizzle(env.DB).select().from(releases).where(eq(releases.id, pureId)).get())!;
    // The is_tag row: title/note/published_unix refresh from the tag
    // (push.go:385-387 — the stale stamp goes), sha1/created_unix refresh.
    expect(pure.isTag).toBe(true);
    expect(pure.title).toBe("initial push-create");
    expect(pure.note).toBe("");
    expect(pure.publishedUnix).toBe(1700000000);
    expect(pure.sha1).toBe(tip);
    expect(pure.createdAt?.getTime()).toBe(1700000000 * 1000);
    expect(pure.publisherId).toBe(ownerId);
  });

  it("PROBE: one receive carrying main+tags (the ensureSeededRepo shape) mints rows", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const created = await new RepoService(env.DB).create({ owner: { id: alice.id, usernameLower: "alice" }, name: "b54probe", isPrivate: false });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const { oid, pack } = await buildPack();
    const body = buildReceivePackBody(
      [
        { ref: "refs/heads/main", oid },
        { ref: "refs/tags/v1", oid },
      ],
      pack,
    );
    const push = await SELF.fetch(`https://example.com/alice/b54probe.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body,
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);
    await vi.waitFor(
      async () => {
        const rows = await drizzle(env.DB).select().from(releases).where(eq(releases.repoId, created.id)).all();
        if (rows.length === 0) throw new Error("no minted row");
        expect(rows[0]?.tagName).toBe("v1");
        expect(rows[0]?.isTag).toBe(true);
      },
      { timeout: 15_000, interval: 300 },
    );
  });

  it("the D-7c producer: a PR-head push enqueues ONE auto-merge-check message, non-PR-head shapes enqueue zero", async () => {
    const { repoId, engineName } = await seedTailRepo("d7c");
    // PR index 7 exists (the issues row the refs/pull/N/head index resolves).
    const inserted = await drizzle(env.DB)
      .insert(issues)
      .values({ repoId, index: 7, title: "PR seven", isPull: true, isClosed: false, createdAt: new Date(), updatedAt: new Date() })
      .returning({ id: issues.id });
    const issueId = inserted[0]!.id;

    const queue = spyQueue();
    const tailEnv = { ...env, REPO_TASKS: queue };
    // The PR-head push: exactly ONE message, resolved to the global issue id.
    await applyPushTail(tailEnv, (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get())!, engineName, {
      tagDeletes: [],
      tagAdds: [],
      prHeadPushes: [7], branchPushes: [],
      pusherId: 0,
    });
    expect(queue.bodies.length).toBe(1);
    const first = (queue.bodies[0] ?? []).map((wrapper) => wrapper.body as AutoMergeCheckMessage);
    expect(first).toEqual([{ kind: "auto-merge-check", issueId }]);

    // A crafted duplicate command for the same head still sends ONE (dedupe).
    await applyPushTail(tailEnv, (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get())!, engineName, {
      tagDeletes: [],
      tagAdds: [],
      prHeadPushes: [7, 7], branchPushes: [],
      pusherId: 0,
    });
    expect((queue.bodies[1] ?? []).length).toBe(1);

    // Non-PR-head shapes: an empty tail and an unknown PR index send NOTHING.
    const quiet = spyQueue();
    await applyPushTail({ ...env, REPO_TASKS: quiet }, (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get())!, engineName, {
      tagDeletes: [],
      tagAdds: [],
      prHeadPushes: [], branchPushes: [],
      pusherId: 0,
    });
    await applyPushTail({ ...env, REPO_TASKS: quiet }, (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get())!, engineName, {
      tagDeletes: [],
      tagAdds: [],
      prHeadPushes: [99], branchPushes: [], // no issues row at index 99
      pusherId: 0,
    });
    expect(quiet.bodies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The B-47 push tail — push-integrated issue closes (UpdateIssuesCommit,
// services/issue/commit.go:126-238, reached from the push-update queue at
// services/repository/push.go:184): every NON-delete branch push walks the
// pushed range's commit messages (FindAllIssueReferences — the non-markdown
// scan), writes type-4 commit_ref comments and closes/reopens referenced
// issues per the keyword table — gated by the canclose/cancomment ladder,
// the self-reference guard, and the pushed repo's CloseIssuesViaCommitInAnyBranch
// branch scope. The walk rides the tail validator's branch collection +
// applyPushTail's branch leg; the range reads are the engine's EXISTING
// listCommitsRange/listLog RPCs (no new seam). The tails run in waitUntil on
// the runner — vi.waitFor polls, the settle precedent.
// ---------------------------------------------------------------------------

/** buildPack's fixed commit stamp (the walk's objects carry it too). */
const B47_PERSON = { name: "Test User", email: "test@example.com", time: 1700000000, tz: "+0000" };

/** Worker-side object hash (the wiki-seeding shape — the `type size\0`
 *  header, putApiObjects re-verifies). */
async function b47Oid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b47ObjectHeader(type: number, size: number): Uint8Array {
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

function b47Be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value]);
}

/** zlib-deflate via the workerd-native transform (git-pack.ts's shape). */
async function b47Deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A self-contained one-commit pack whose commit message is CUSTOM (buildPack's
 * is fixed): serializeCommit frames the object bytes (oid computed there),
 * the pack wrap is repos/testing/git-pack.ts's shape (header, per-object
 * type+size varint + deflate, trailing SHA-1 over the whole stream).
 * `parent` chains the commit onto an existing tip so an update-range walk
 * (listCommitsRange old..new) sees exactly it.
 */
async function buildMessagePack(message: string, parent?: string): Promise<{ oid: string; pack: Uint8Array }> {
  const blob = new TextEncoder().encode(`payload ${message.length}\n`);
  const blobSha = await b47Oid("blob", blob);
  const tree = serializeTree([{ mode: "100644", name: "file.txt", oid: blobSha }]);
  const tip = serializeCommit({
    tree: tree.oid,
    parents: parent === undefined ? [] : [parent],
    author: B47_PERSON,
    committer: B47_PERSON,
    message,
  });
  const entries: { type: number; body: Uint8Array }[] = [
    { type: 3, body: blob }, // OBJ_BLOB
    { type: 2, body: tree.data }, // OBJ_TREE
    { type: 1, body: tip.data }, // OBJ_COMMIT
  ];
  const chunks: Uint8Array[] = [new TextEncoder().encode("PACK"), b47Be32(2), b47Be32(entries.length)];
  for (const entry of entries) {
    chunks.push(b47ObjectHeader(entry.type, entry.body.length));
    chunks.push(await b47Deflate(entry.body));
  }
  const soFar = chunks.reduce((acc, chunk) => {
    const merged = new Uint8Array(acc.byteLength + chunk.byteLength);
    merged.set(acc, 0);
    merged.set(chunk, acc.byteLength);
    return merged;
  }, new Uint8Array(0));
  const checksum = new Uint8Array(await crypto.subtle.digest("SHA-1", soFar));
  const pack = new Uint8Array(soFar.byteLength + 20);
  pack.set(soFar, 0);
  pack.set(checksum, soFar.byteLength);
  return { oid: tip.oid, pack };
}

/** An update receive-pack body with the REAL old tip (buildReceivePackBody
 *  always sends the zero old — a create; an update must carry the live tip
 *  or the engine's CAS refuses it). */
function b47UpdateBody(oldTip: string, oid: string, ref: string, pack: Uint8Array): Uint8Array {
  const section =
    pktLine(`${oldTip} ${oid} ${ref}\0report-status side-band-64k`) + "0000";
  const head = new TextEncoder().encode(section);
  const body = new Uint8Array(head.byteLength + pack.byteLength);
  body.set(head, 0);
  body.set(pack, head.byteLength);
  return body;
}

/** One open issue row (the D-7c fixture's raw-insert shape). */
async function seedB47Issue(
  repoId: string,
  index: number,
  patch: Partial<typeof issues.$inferInsert> = {},
): Promise<number> {
  const inserted = await drizzle(env.DB)
    .insert(issues)
    .values({
      repoId,
      index,
      title: `issue ${index}`,
      isPull: false,
      isClosed: false,
      posterId: null,
      ref: "",
      ...patch,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: issues.id });
  return inserted[0]!.id;
}

/** An owner-level webhooks row matching the issues family (the settle
 *  fixture's shape). */
async function seedB47Hook(ownerId: number): Promise<number> {
  const inserted = await drizzle(env.DB)
    .insert(webhooks)
    .values({
      repoId: null,
      ownerId,
      url: "https://hooks.example.com/b47",
      events: JSON.stringify({ choose_events: true, events: { issues: true } }),
      isActive: true,
    })
    .returning({ id: webhooks.id })
    .all();
  return inserted[0]!.id;
}

describe("the B-47 push tail: commit messages write commit_ref rows and close/reopen issues (UpdateIssuesCommit, commit.go:126-238)", () => {
  beforeEach(async () => {
    // The global sweep misses the issue-family tables (the R5 describe's
    // local sweep precedent, extended to the walk's write set).
    await env.DB.prepare("DELETE FROM issues").run();
    await env.DB.prepare("DELETE FROM comments").run();
    await env.DB.prepare("DELETE FROM action").run();
    await env.DB.prepare("DELETE FROM tracked_time").run();
    await env.DB.prepare("DELETE FROM pull_requests").run();
  });

  it("a 'fixes #1' push closes the issue, writes the commit_ref row, the close comment, the webhook and the feed action (end-to-end)", async () => {
    const { repoId, engineName, ownerId, token, tip } = await seedTailRepo("b47close");
    const issueId = await seedB47Issue(repoId, 1, { posterId: ownerId });
    const hookId = await seedB47Hook(ownerId);

    // THE PUSH: main tip0 -> tip1, message "fixes #1".
    const { oid, pack } = await buildMessagePack("fixes #1\n\nsome body", tip);
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: b47UpdateBody(tip, oid, "refs/heads/main", pack),
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

    await vi.waitFor(async () => {
      const row = await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueId)).get();
      if (row?.isClosed !== true) throw new Error("issue not closed yet");
    });

    // The issue state (SetIssueAsClosed: is_closed, closed_unix).
    const issue = (await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueId)).get())!;
    expect(issue.isClosed).toBe(true);
    expect(issue.closedAt).not.toBeNull();

    // The walk's rows: the type-4 commit_ref comment (CreateRefComment —
    // content `<a href="{repoLink}/commit/{sha}">{first line}</a>`), then the
    // type-2 close system comment (updateIssueNumbers).
    const rows = await drizzle(env.DB).select().from(comments).where(eq(comments.issueId, issueId)).all();
    const refRow = rows.find((row) => row.type === CommentType.CommitRef);
    expect(refRow?.commitSha).toBe(oid);
    expect(refRow?.content).toBe(`<a href="/alice/b47close/commit/${oid}">fixes #1</a>`);
    expect(refRow?.posterId).toBe(ownerId);
    expect(rows.find((row) => row.type === CommentType.Close)).toBeDefined();

    // The closed webhook (IssueChangeStatus — commit_id carries the sha).
    const deliveries = await drizzle(env.DB).select().from(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId)).all();
    expect(deliveries.length).toBe(1);
    const payload = JSON.parse(deliveries[0]!.payloadContent) as { action: string; commit_id: string; number: number };
    expect(payload.action).toBe("closed");
    expect(payload.commit_id).toBe(oid);
    expect(payload.number).toBe(1);

    // The feed action row (feed/notifier.go:66-97 — close_issue "index|").
    const feed = await drizzle(env.DB).select().from(actions).all();
    expect(feed.some((row) => row.opType === 12 && row.content === "1|" && row.actUserId === ownerId)).toBe(true);
  });

  it("a 'reopens #1' push reopens a closed issue (the reopen keyword arm)", async () => {
    const { repoId, engineName, ownerId, token, tip } = await seedTailRepo("b47reopen");
    const issueId = await seedB47Issue(repoId, 1, { posterId: ownerId, isClosed: true, closedAt: new Date() });
    const hookId = await seedB47Hook(ownerId);

    const { oid, pack } = await buildMessagePack("reopens #1", tip);
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: b47UpdateBody(tip, oid, "refs/heads/main", pack),
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

    await vi.waitFor(async () => {
      const row = await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueId)).get();
      if (row?.isClosed !== false) throw new Error("issue not reopened yet");
    });
    const rows = await drizzle(env.DB).select().from(comments).where(eq(comments.issueId, issueId)).all();
    expect(rows.find((row) => row.type === CommentType.CommitRef)?.commitSha).toBe(oid);
    expect(rows.find((row) => row.type === CommentType.Reopen)).toBeDefined();
    const deliveries = await drizzle(env.DB).select().from(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId)).all();
    expect((JSON.parse(deliveries[0]!.payloadContent) as { action: string }).action).toBe("reopened");
  });

  it("the branch scope: knob false closes only from the default branch (the ref comment still writes), the flip opens every branch, the issue.ref pin", async () => {
    const { repoId, engineName, ownerId, token, tip } = await seedTailRepo("b47scope");
    const cell = env.REPO.getByName(engineName);
    // refs/heads/feature exists as a real branch (the direct-CAS seeding
    // shape — commitApiChange), so update pushes onto it carry a live old.
    const landed = await cell.commitApiChange({ ref: "refs/heads/feature", expectedOldOid: ZERO_OID, newOid: tip });
    expect(landed.tag).toBe("committed");

    const knobFalse = async (): Promise<void> => {
      await drizzle(env.DB).update(repositories).set({ closeIssuesViaCommitInAnyBranch: false }).where(eq(repositories.id, repoId));
    };

    // Arm 1 — knob false: "fixes #2" from feature does NOT close, but the
    // commit_ref comment STILL writes (CreateRefComment precedes the gate,
    // commit.go:184-190 vs :207-218).
    const issue2 = await seedB47Issue(repoId, 2, { posterId: ownerId });
    const p1 = await buildMessagePack("fixes #2", tip);
    await knobFalse();
    const push1 = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: b47UpdateBody(tip, p1.oid, "refs/heads/feature", p1.pack),
    });
    expect(push1.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push1);
    await vi.waitFor(async () => {
      const rows = await drizzle(env.DB).select().from(comments).where(eq(comments.issueId, issue2)).all();
      if (!rows.some((row) => row.type === CommentType.CommitRef)) throw new Error("ref comment not written yet");
    });
    expect((await drizzle(env.DB).select().from(issues).where(eq(issues.id, issue2)).get())?.isClosed).toBe(false);

    // Arm 2 — the flip (repositories.closeIssuesViaCommitInAnyBranch = true):
    // a second feature commit closes it.
    await drizzle(env.DB).update(repositories).set({ closeIssuesViaCommitInAnyBranch: true }).where(eq(repositories.id, repoId));
    const p2 = await buildMessagePack("fixes #2 again", p1.oid);
    const push2 = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: b47UpdateBody(p1.oid, p2.oid, "refs/heads/feature", p2.pack),
    });
    expect(push2.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push2);
    await vi.waitFor(async () => {
      const row = await drizzle(env.DB).select().from(issues).where(eq(issues.id, issue2)).get();
      if (row?.isClosed !== true) throw new Error("issue2 not closed yet");
    });

    // Arm 3 — knob false again, the issue.ref pin: an issue pinned to
    // feature closes FROM feature, an identically-pinned one does not close
    // from main.
    await knobFalse();
    const issue3 = await seedB47Issue(repoId, 3, { posterId: ownerId, ref: "refs/heads/feature" });
    const issue4 = await seedB47Issue(repoId, 4, { posterId: ownerId, ref: "refs/heads/feature" });
    const p3 = await buildMessagePack("fixes #3", p2.oid);
    const push3 = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: b47UpdateBody(p2.oid, p3.oid, "refs/heads/feature", p3.pack),
    });
    expect(push3.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push3);
    const p4 = await buildMessagePack("fixes #4", tip);
    const push4 = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: b47UpdateBody(tip, p4.oid, "refs/heads/main", p4.pack),
    });
    expect(push4.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push4);
    // Prove BOTH tails ran before the negative assertion: issue3 closed AND
    // issue4's ref comment present (walk4 executed, the gate held).
    await vi.waitFor(async () => {
      const row = await drizzle(env.DB).select().from(issues).where(eq(issues.id, issue3)).get();
      const c4 = await drizzle(env.DB).select().from(comments).where(eq(comments.issueId, issue4)).all();
      if (row?.isClosed !== true) throw new Error("issue3 not closed yet");
      if (!c4.some((row) => row.type === CommentType.CommitRef)) throw new Error("issue4 ref comment not written yet");
    });
    // issue4 (same ref, pushed from MAIN) stays open — the branch gate.
    const c4 = await drizzle(env.DB).select().from(comments).where(eq(comments.issueId, issue4)).all();
    expect((await drizzle(env.DB).select().from(issues).where(eq(issues.id, issue4)).get())?.isClosed).toBe(false);
    // issue3's ref comment and close comment both exist; issue4 has its ref
    // comment only (the close arm never fired).
    const c3 = await drizzle(env.DB).select().from(comments).where(eq(comments.issueId, issue3)).all();
    expect(c3.find((row) => row.type === CommentType.Close)).toBeDefined();
    expect(c4.find((row) => row.type === CommentType.Close)).toBeUndefined();
  });

  it("the re-push idempotency: the same commit walked again writes no duplicate ref row and never re-closes", async () => {
    const { repoId, engineName, ownerId, token, tip } = await seedTailRepo("b47idem");
    const issueId = await seedB47Issue(repoId, 1, { posterId: ownerId });
    const { oid, pack } = await buildMessagePack("fixes #1", tip);
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: b47UpdateBody(tip, oid, "refs/heads/main", pack),
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);
    await vi.waitFor(async () => {
      const row = await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueId)).get();
      if (row?.isClosed !== true) throw new Error("issue not closed yet");
    });
    const closedAt = (await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueId)).get())!.closedAt;

    // The deterministic re-walk: the same tail entry, applied again (the
    // createRefComment (type, issue_id, commit_sha) dedupe is THE re-push
    // idempotency; the ladder reads isClosed and skips the close arm).
    const repoRow = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get())!;
    await applyPushTail(env, repoRow, engineName, {
      tagDeletes: [],
      tagAdds: [],
      prHeadPushes: [],
      branchPushes: [{ ref: "refs/heads/main", old: tip, next: oid }],
      pusherId: ownerId,
    });
    const refRows = await drizzle(env.DB)
      .select()
      .from(comments)
      .where(and(eq(comments.issueId, issueId), eq(comments.type, CommentType.CommitRef)))
      .all();
    expect(refRows).toHaveLength(1);
    const after = (await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueId)).get())!;
    expect(after.isClosed).toBe(true);
    expect(after.closedAt?.getTime()).toBe(closedAt!.getTime());
  });

  it("a cross-repo full-URL reference closes the other repo's issue from this push (the AppURL rewrite + the cross-reference arm)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const service = new RepoService(env.DB);
    await service.create({ owner: { id: alice.id, usernameLower: "alice" }, name: "b47a", isPrivate: false });
    const b = await service.create({ owner: { id: alice.id, usernameLower: "alice" }, name: "b47b", isPrivate: false });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const seed = await buildPack();
    for (const name of ["b47a", "b47b"]) {
      const push = await SELF.fetch(`https://example.com/alice/${name}.git/git-receive-pack`, {
        method: "POST",
        headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
        body: buildReceivePackBody([{ ref: "refs/heads/main", oid: seed.oid }], seed.pack),
      });
      expect(push.status).toBe(200);
      // SPEC 0230: the streaming answer resolves before the push applies;
      // drain to stream end — the arm closes strictly after finalize's
      // transaction, so stream end is the push-completion signal
      await drainReceive(push);
    }
    const issueB = await seedB47Issue(b.id, 1, { posterId: alice.id });
    const hookId = await seedB47Hook(alice.id);

    // The message carries the FULL AppURL reference — the scan rewrites it
    // to alice/b47b#1 (convertFullHTMLReferencesToShortRefs) and the
    // cross-ref loop resolves it. The active AppURL is the settle test's
    // chain (the APP_URL var wins over the request origin).
    const appUrlOrigin = ((env as { APP_URL?: string }).APP_URL ?? "https://example.com").replace(/\/+$/, "");
    const { oid, pack } = await buildMessagePack(`closes ${appUrlOrigin}/alice/b47b/issues/1`, seed.oid);
    const push = await SELF.fetch("https://example.com/alice/b47a.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: b47UpdateBody(seed.oid, oid, "refs/heads/main", pack),
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

    await vi.waitFor(async () => {
      const row = await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueB)).get();
      if (row?.isClosed !== true) throw new Error("cross-repo issue not closed yet");
    });
    // The ref comment landed on B's issue, content linking the PUSHED repo.
    const rows = await drizzle(env.DB).select().from(comments).where(eq(comments.issueId, issueB)).all();
    expect(rows.find((row) => row.type === CommentType.CommitRef)?.content).toBe(
      `<a href="/alice/b47a/commit/${oid}">closes ${appUrlOrigin}/alice/b47b/issues/1</a>`,
    );
    const deliveries = await drizzle(env.DB).select().from(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId)).all();
    expect(deliveries.length).toBe(1);
    expect((JSON.parse(deliveries[0]!.payloadContent) as { action: string }).action).toBe("closed");
  });

  it("the cancomment gate: an unreadable cross-repo target is skipped whole (no comment, no close)", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const carol = await seedVerifiedUser({ username: "Carol" });
    const service = new RepoService(env.DB);
    await service.create({ owner: { id: alice.id, usernameLower: "alice" }, name: "b47reader", isPrivate: false });
    // Carol's PRIVATE repo — alice holds no grant there.
    const c = await service.create({ owner: { id: carol.id, usernameLower: "carol" }, name: "b47secret", isPrivate: true });
    const token = (await mintFor(alice.id, "w", "write:repository")).plaintext;
    const seed = await buildPack();
    await SELF.fetch("https://example.com/alice/b47reader.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildReceivePackBody([{ ref: "refs/heads/main", oid: seed.oid }], seed.pack),
    });
    const issueC = await seedB47Issue(c.id, 1, { posterId: carol.id });

    const appUrlOrigin = ((env as { APP_URL?: string }).APP_URL ?? "https://example.com").replace(/\/+$/, "");
    const { oid, pack } = await buildMessagePack(`fixes ${appUrlOrigin}/carol/b47secret/issues/1`, seed.oid);
    const push = await SELF.fetch("https://example.com/alice/b47reader.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: b47UpdateBody(seed.oid, oid, "refs/heads/main", pack),
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

    // Give the waitUntil tail its window, then assert nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const row = await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueC)).get();
    expect(row?.isClosed).toBe(false);
    expect(await drizzle(env.DB).select().from(comments).where(eq(comments.issueId, issueC)).all()).toEqual([]);
  });

  it("the self-reference guard: a PR's merge commit referencing itself writes nothing (commit.go:180)", async () => {
    const { repoId, engineName, ownerId, token, tip } = await seedTailRepo("b47selfref");
    const issueId = await seedB47Issue(repoId, 5, { posterId: ownerId, isPull: true, title: "PR five" });
    const { oid, pack } = await buildMessagePack("fixes #5", tip);
    // The PR row whose merged commit IS the pushed sha (isSelfReference's
    // MergedCommitID == c.Sha1).
    await drizzle(env.DB).insert(pullRequests).values({
      issueId,
      index: 5,
      headRepoId: repoId,
      baseRepoId: repoId,
      headBranch: "topic",
      baseBranch: "main",
      hasMerged: true,
      mergedCommitId: oid,
    });
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: b47UpdateBody(tip, oid, "refs/heads/main", pack),
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

    await new Promise((resolve) => setTimeout(resolve, 3000));
    const row = await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueId)).get();
    expect(row?.isClosed).toBe(false);
    expect(await drizzle(env.DB).select().from(comments).where(eq(comments.issueId, issueId)).all()).toEqual([]);
  });

  it("the time-log arm: 'fixes #1 @1h30m' writes the tracked time and the type-14 comment (issueAddTime -> AddTime)", async () => {
    const { repoId, engineName, ownerId, token, tip } = await seedTailRepo("b47time");
    const issueId = await seedB47Issue(repoId, 1, { posterId: ownerId });
    const { oid, pack } = await buildMessagePack("fixes #1 @1h30m", tip);
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: b47UpdateBody(tip, oid, "refs/heads/main", pack),
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

    await vi.waitFor(async () => {
      const times = await drizzle(env.DB).select().from(trackedTimes).where(eq(trackedTimes.issueId, issueId)).all();
      if (times.length === 0) throw new Error("no tracked time yet");
    });
    const time = (await drizzle(env.DB).select().from(trackedTimes).where(eq(trackedTimes.issueId, issueId)).all())[0]!;
    expect(time.seconds).toBe(5400); // 1h30m — commit.go's collapsed units
    expect(time.userId).toBe(ownerId);
    // dated by the commit's AUTHOR time (CommitToPushCommit's Timestamp).
    expect(time.createdAt?.getTime()).toBe(1700000000 * 1000);
    const rows = await drizzle(env.DB).select().from(comments).where(eq(comments.issueId, issueId)).all();
    const addTime = rows.find((row) => row.type === CommentType.AddTimeManual);
    expect(addTime?.content).toBe("|5400");
    expect(addTime?.timeId).toBe(time.id);
    expect((await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueId)).get())?.isClosed).toBe(true);
  });

  it("a NEW branch push walks its last 10 commits (the listLog arm — CommitsBeforeLimit) and closes (any-branch knob on)", async () => {
    const { repoId, engineName, ownerId, token, tip } = await seedTailRepo("b47newbranch");
    const issueId = await seedB47Issue(repoId, 6, { posterId: ownerId });
    // topic is NOT the default branch — the scope knob must be on for the
    // close to fire (the knob-false block is the scope test's arm 1).
    await drizzle(env.DB).update(repositories).set({ closeIssuesViaCommitInAnyBranch: true }).where(eq(repositories.id, repoId));
    const { oid, pack } = await buildMessagePack("fixes #6", tip);
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildReceivePackBody([{ ref: "refs/heads/topic", oid }], pack),
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);

    await vi.waitFor(async () => {
      const row = await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueId)).get();
      if (row?.isClosed !== true) throw new Error("issue not closed yet");
    });
    const rows = await drizzle(env.DB).select().from(comments).where(eq(comments.issueId, issueId)).all();
    expect(rows.find((row) => row.type === CommentType.CommitRef)?.commitSha).toBe(oid);
  });
});

// ---------------------------------------------------------------------------
// The rowless `_cargo-index` git family (S-2 — upstream's cargo sparse-index
// mirror repository, services/packages/cargo/index.go IndexRepositoryName,
// cloneable at {origin}/{owner}/_cargo-index.git). The wiki family's
// contract mirrored: the OWNER resolves (never a repo row), the index cell
// is upstream-born public, reads seed the priv:1 registry row before the
// forward, writes need the owner or a site admin, and a repositories ROW at
// the address is user-owned — the ordinary flow serves it.
// ---------------------------------------------------------------------------

/** Seed the mirror cell through the REAL production path (the config root
 *  commit on refs/heads/main), then return the owner. */
async function seedCargoIndexFixture(username: string): Promise<{ ownerId: number; token: string }> {
  const owner = await seedVerifiedUser({ username });
  await ensureCargoIndexMirror({ repo: env.REPO, origin: "https://example.com" }, env.DB, owner.id);
  const token = (await mintFor(owner.id, "w", "write:repository")).plaintext;
  return { ownerId: owner.id, token };
}

describe("the _cargo-index git family (S-2 — the wiki family's contract over the rowless cell)", () => {
  it("serves the anonymous clone advert of a public owner's mirror cell, registry row seeded index-hidden", async () => {
    const { ownerId } = await seedCargoIndexFixture("cargoalice");
    const cellTip = (await env.REPO.getByName("cargoalice/_cargo-index").listRefs()).refs.find((r) => r.name === "refs/heads/main")?.target;

    const advert = await SELF.fetch("https://example.com/cargoalice/_cargo-index.git/info/refs?service=git-upload-pack");
    expect(advert.status).toBe(200);
    expect(advert.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const body = new TextDecoder().decode(await advert.arrayBuffer());
    expect(body).toContain("refs/heads/main");
    expect(body).toContain(cellTip);

    // The seed discipline (the wiki family's, verbatim): priv=1 — hidden
    // from every engine index; the gate-owned ACL owns authorization.
    const row = await env.REGISTRY.getByName("registry").get("cargoalice/_cargo-index");
    expect(row).not.toBeNull();
    expect(row?.priv).toBe(1);
    expect(ownerId).toBeGreaterThan(0);
  });

  it("serves the mirror cell's synthetic HEAD and 404s an unknown owner (the bare-404 arm)", async () => {
    await seedCargoIndexFixture("cargohead");
    const head = await SELF.fetch("https://example.com/cargohead/_cargo-index.git/HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("text/plain");
    expect(new TextDecoder().decode(await head.arrayBuffer())).toBe("ref: refs/heads/main\n");

    // No owner row at the namespace → the bare 404 for every credential
    // (the wiki family's no-parent arm; the push-create surface never
    // claims the name).
    const missing = await SELF.fetch("https://example.com/ghost/_cargo-index.git/info/refs?service=git-upload-pack");
    expect(missing.status).toBe(404);
  });

  it("masks the cell behind the owner's visibility: private owner challenges anonymous, 404s a stranger, serves the owner", async () => {
    const { ownerId, token } = await seedCargoIndexFixture("cargohide");
    const cellTip = (await env.REPO.getByName("cargohide/_cargo-index").listRefs()).refs.find((r) => r.name === "refs/heads/main")?.target;
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.id, ownerId));
    const stranger = await seedVerifiedUser({ username: "CargoBob" });
    const strangerToken = (await mintFor(stranger.id, "r", "read:repository")).plaintext;

    const anon = await SELF.fetch("https://example.com/cargohide/_cargo-index.git/info/refs?service=git-upload-pack");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe(CHALLENGE);

    const masked = await SELF.fetch("https://example.com/cargohide/_cargo-index.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(strangerToken) },
    });
    expect(masked.status).toBe(404);
    expect(new TextDecoder().decode(await masked.arrayBuffer())).toBe("Repository not found");

    const ownerView = await SELF.fetch("https://example.com/cargohide/_cargo-index.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(ownerView.status).toBe(200);
    expect(new TextDecoder().decode(await ownerView.arrayBuffer())).toContain(cellTip);
  });

  it("keeps writes owner/admin-only: anonymous 401, a stranger 404-masked, the owner's push lands in the cell", async () => {
    const { ownerId, token } = await seedCargoIndexFixture("cargopush");
    const stranger = await seedVerifiedUser({ username: "CargoPushBob" });
    const strangerToken = (await mintFor(stranger.id, "w", "write:repository")).plaintext;

    const anon = await SELF.fetch("https://example.com/cargopush/_cargo-index.git/info/refs?service=git-receive-pack");
    expect(anon.status).toBe(401);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(anon);
    expect(anon.headers.get("www-authenticate")).toBe(CHALLENGE);

    const { oid, pack } = await buildPack();
    const pushBody = buildReceivePackBody([{ ref: "refs/heads/notes", oid }], pack);
    const strangerPush = await SELF.fetch("https://example.com/cargopush/_cargo-index.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(strangerToken), "content-type": RECEIVE_CT },
      body: pushBody,
    });
    expect(strangerPush.status).toBe(404);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(strangerPush);

    const ownerPush = await SELF.fetch("https://example.com/cargopush/_cargo-index.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildReceivePackBody([{ ref: "refs/heads/notes", oid }], pack),
    });
    expect(ownerPush.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(ownerPush);
    const refs = (await env.REPO.getByName("cargopush/_cargo-index").listRefs()).refs.map((r) => r.name);
    expect(refs).toContain("refs/heads/notes");
    expect(refs).toContain("refs/heads/main");
    expect(ownerId).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Row 6 — the require-sign-in-view instance flag (SPEC-0003 §2.4 row 6,
// census B-34). Upstream folds EVERY anonymous-pull arm inside
// `!setting.Service.RequireSignInViewStrict` (routers/web/repo/githttp.go:132,
// pinned by tests/integration/git_smart_http_test.go:186-188: the anonymous
// unit-read grant flips to 401 under the flag). These tests drive
// `authorizeGitHttp` DIRECTLY with an env slice override (the vitest plugin
// injects the deployed wrangler vars into SELF's env, so SELF cannot flip the
// var per test); the flag default in wrangler.jsonc(.example) is "false" —
// the anonymous-readable self-host posture.
// ---------------------------------------------------------------------------

describe("row 6: require-sign-in-view kills every anonymous pull (SPEC-0003 §2.4)", () => {
  /** The AuthUser projection resolveRepository hands the gate (acl.ts:87-102)
   *  — the direct call needs the same shape for the owner-active grant lines. */
  function authUserOf(id: number, username: string): AuthUser {
    return {
      id,
      username,
      usernameLower: username.toLowerCase(),
      email: null,
      displayName: null,
      location: null,
      website: null,
      description: null,
      isAdmin: false,
      status: "active",
      createdAt: new Date(),
    };
  }

  /** Seed `alice/<slug>` (owner PUBLIC, repo visibility per arg) with a real
   *  users row; the D1 row + the owner projection are all the direct gate
   *  call needs. */
  async function seedRepo(slug: string, visibility: "public" | "private") {
    // One owner per slug — the direct call never parses the URL, so the
    // namespace string is cosmetic and per-test usernames dodge the UNIQUE
    // collision the shared "alice" would hit across this describe's tests.
    const username = `alice_${slug.replace(/-/g, "_")}`;
    const alice = await seedVerifiedUser({ username });
    const created = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: username.toLowerCase() },
      name: slug,
      isPrivate: visibility === "private",
    });
    const row = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, created.id)).get())!;
    return { repo: row, owner: authUserOf(alice.id, alice.username), ownerVisibility: "public" as const };
  }

  /** The anonymous read decision through the real gate (the flag rides the
   *  env-slice override). */
  async function anonRead(
    fx: { repo: typeof repositories.$inferSelect; owner: AuthUser; ownerVisibility: "public" },
    envOverride: Record<string, string>,
    unitAnonymousRead = false,
  ): Promise<Response | true> {
    return authorizeGitHttp({
      req: new Request(`https://example.com/alice/${fx.repo.slug}.git/info/refs?service=git-upload-pack`),
      env: Object.assign({}, env, envOverride),
      waitUntil: () => {},
      op: "read",
      repo: fx.repo,
      owner: fx.owner,
      ownerVisibility: fx.ownerVisibility,
      unitAnonymousRead,
    });
  }

  it("overrides row 1: anonymous read of a public repo 401-challenges under the flag", async () => {
    const fx = await seedRepo("r6public", "public");
    // Control: flag OFF (the deployed default) — row 1 stays open.
    expect(await anonRead(fx, {})).toBe(true);
    // The flag: the same request challenges.
    const denied = await anonRead(fx, { REQUIRE_SIGNIN_VIEW: "true" });
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(401);
    expect((denied as Response).headers.get("www-authenticate")).toBe(CHALLENGE);
  });

  it("overrides row 4: the anonymous unit-read grant flips to 401 under the flag (upstream test :186-188)", async () => {
    const fx = await seedRepo("r6unit", "private");
    await env.DB
      .prepare("INSERT INTO repo_units (repo_id, type, anonymous_access_mode) VALUES (?, 'code', 'read')")
      .bind(fx.repo.id)
      .run();
    // Control: flag OFF — the grant admits the read (row 4).
    expect(await anonRead(fx, {}, true)).toBe(true);
    // The flag: the grant no longer reaches the decision.
    const denied = await anonRead(fx, { REQUIRE_SIGNIN_VIEW: "true" }, true);
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(401);
    expect((denied as Response).headers.get("www-authenticate")).toBe(CHALLENGE);
  });

  it("never consults a signed-in doer: the owner's token pull still passes under the flag", async () => {
    const fx = await seedRepo("r6authed", "public");
    const token = (await mintFor(fx.owner.id, "w", "write:repository")).plaintext;
    const outcome = await authorizeGitHttp({
      req: new Request(`https://example.com/alice/${fx.repo.slug}.git/info/refs?service=git-upload-pack`, {
        headers: { authorization: basicTokenHeader(token) },
      }),
      env: Object.assign({}, env, { REQUIRE_SIGNIN_VIEW: "true" }),
      waitUntil: () => {},
      op: "read",
      repo: fx.repo,
      owner: fx.owner,
      ownerVisibility: fx.ownerVisibility,
      unitAnonymousRead: false,
    });
    expect(outcome).toBe(true);
  });

  it("kills the deploy-key public-read line: a foreign key on a public repo 404s under the flag, its own repo still reads", async () => {
    const fx = await seedRepo("r6key", "public");
    const other = await seedRepo("r6other", "public");
    const key = await addDeployKeyToken(env.DB, fx.repo.id, "r6-key", true);
    if (key.token === undefined) throw new Error("deploy key seed returned no plaintext");
    const deployAuth = { authorization: basicHeader("git", key.token) };

    const call = (target: typeof fx.repo, flag: string) =>
      authorizeGitHttp({
        req: new Request(`https://example.com/alice/${target.slug}.git/info/refs?service=git-upload-pack`, {
          headers: deployAuth,
        }),
        env: Object.assign({}, env, flag === "" ? {} : { REQUIRE_SIGNIN_VIEW: flag }),
        waitUntil: () => {},
        op: "read",
        repo: target,
        owner: fx.owner,
        ownerVisibility: "public",
        unitAnonymousRead: false,
      });

    // Control (flag OFF): the foreign key reads the public repo through the
    // canAnonymousPull arm (the decideDeployKey public line).
    const flagOff = await call(other.repo, "");
    expect(flagOff).toBe(true);
    // Under the flag: the public line dies (falls to the key permission —
    // own repo only), 404-masked like any zero-perm read.
    const foreign = await call(other.repo, "true");
    expect(foreign).toBeInstanceOf(Response);
    expect((foreign as Response).status).toBe(404);
    // The key's OWN repo reads on (the key permission is a signed-in arm —
    // the flag never consults it).
    expect(await call(fx.repo, "true")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The agit push-to-propose lane (census B-52 — api/services/agit.ts): a
// `refs/for/<branch>[/<topic>]` command plans against D1 + the branch
// universe (upstream ProcReceive), the forward translates onto
// `refs/pull/N/head`, the report renders against the ORIGINAL `refs/for`
// names with the PR URL message on sideband band 2, and the create/update
// tails run the PR row work upstream's hook ran inside the receive.
// ---------------------------------------------------------------------------

/** Build a receive-pack request body for the agit battery: the command
 *  section (capabilities on the first line), the optional push-options
 *  section (present exactly when pushOptions is given, like git's
 *  --push-option), and the optional pack. */
function buildAgitPushBody(
  commands: { old?: string; oid: string; ref: string }[],
  options: { caps?: string; pushOptions?: string[]; pack?: Uint8Array } = {},
): Uint8Array {
  const caps = options.caps ?? "report-status side-band-64k push-options";
  let section = "";
  commands.forEach((cmd, i) => {
    const suffix = i === 0 ? `\0${caps}` : "";
    section += pktLine(`${cmd.old ?? ZERO_OID} ${cmd.oid} ${cmd.ref}${suffix}`);
  });
  section += "0000";
  const chunks: Uint8Array[] = [new TextEncoder().encode(section)];
  if (options.pushOptions !== undefined) {
    let opts = "";
    for (const opt of options.pushOptions) opts += pktLine(opt);
    opts += "0000";
    chunks.push(new TextEncoder().encode(opts));
  }
  if (options.pack !== undefined) chunks.push(options.pack);
  return concatBatteryU8(chunks);
}

/** One self-contained commit pack (blob + tree + commit) with a controllable
 *  message and optional parent — the agit update tests need a fast-forward
 *  tip (parented) and a force tip (unrelated), which the fixed
 *  testing/git-pack builder cannot produce. workerd-safe (WebCrypto +
 *  CompressionStream), the buildPack shape. */
async function buildAgitCommitPack(opts: { message: string; file?: string; parent?: string }): Promise<{ oid: string; pack: Uint8Array }> {
  const blob = new TextEncoder().encode(opts.file ?? "agit content\n");
  const blobSha = await batterySha1Hex(concatBatteryU8([new TextEncoder().encode(`blob ${blob.length}\0`), blob]));
  const treeBody = concatBatteryU8([new TextEncoder().encode(`100644 file.txt\0`), batteryRawOid(blobSha)]);
  const treeSha = await batterySha1Hex(concatBatteryU8([new TextEncoder().encode(`tree ${treeBody.length}\0`), treeBody]));
  const time = 1700000100;
  const commitBody = new TextEncoder().encode(
    `tree ${treeSha}\n` +
      (opts.parent !== undefined ? `parent ${opts.parent}\n` : "") +
      `author Agit Tester <agit@example.com> ${time} +0000\n` +
      `committer Agit Tester <agit@example.com> ${time} +0000\n\n` +
      opts.message,
  );
  const commitSha = await batterySha1Hex(concatBatteryU8([new TextEncoder().encode(`commit ${commitBody.length}\0`), commitBody]));
  const entries: { type: number; body: Uint8Array }[] = [
    { type: 3, body: blob },
    { type: 2, body: treeBody },
    { type: 1, body: commitBody },
  ];
  const chunks: Uint8Array[] = [new TextEncoder().encode("PACK"), batteryBe32(2), batteryBe32(entries.length)];
  for (const entry of entries) {
    chunks.push(batteryObjectHeader(entry.type, entry.body.length));
    chunks.push(await batteryDeflate(entry.body));
  }
  chunks.push(await batterySha1Bytes(concatBatteryU8(chunks)));
  return { oid: commitSha, pack: concatBatteryU8(chunks) };
}

async function batterySha1Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function batterySha1Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

async function batteryDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
}

function batteryRawOid(oidHex: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

function batteryObjectHeader(type: number, size: number): Uint8Array {
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

function batteryBe32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function concatBatteryU8(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}

/** The serving origin the test env actually carries: the vitest plugin
 *  injects the wrangler VARS (APP_URL among them) and appOrigin's pinned
 *  precedence puts the var over the request origin — so the agit hook
 *  message's PR URL rides the CONFIGURED origin, never the literal request
 *  host (the same ride-the-real-config posture as services/mirror/
 *  sync.test.ts; upstream builds the URL from repo.HTMLURL(), agit.go:208). */
const EXPECTED_APP_ORIGIN = env.APP_URL.replace(/\/+$/, "");

/** Split a sideband-framed receive-pack RESULT: the band-1 report pkt-lines
 *  and the band-2 remote messages. */
function parseAgitResponse(body: ArrayBuffer): { report: string; messages: string } {
  const bytes = new Uint8Array(body);
  const decoder = new TextDecoder();
  let band1 = "";
  let band2 = "";
  let pos = 0;
  while (pos + 4 <= bytes.length) {
    const len = parseInt(decoder.decode(bytes.subarray(pos, pos + 4)), 16);
    if (len === 0) break;
    const band = bytes[pos + 4]!;
    const payload = decoder.decode(bytes.subarray(pos + 5, pos + len));
    pos += len;
    if (band === 1) band1 += payload;
    else if (band === 2) band2 += payload;
  }
  return { report: band1, messages: band2 };
}

/** Seed one active repo webhook subscribed to the two PR event types the
 *  agit tails emit (the delivery rows the assertions read). */
async function seedAgitWebhook(repoId: string): Promise<void> {
  await drizzle(env.DB)
    .insert(webhooks)
    .values({ repoId, url: "https://hooks.example/agit-lane", events: JSON.stringify({ events: { pull_request: true, pull_request_sync: true } }), isActive: true })
    .run();
}

/** The agit battery's extra sweep (the file-level beforeEach does not clear
 *  the PR family, the block table, or the update-tail's comment/review/
 *  protection tables). */
async function sweepAgitTables(): Promise<void> {
  await env.DB.prepare("DELETE FROM pull_requests").run();
  await env.DB.prepare("DELETE FROM issues").run();
  await env.DB.prepare("DELETE FROM user_blocking").run();
  await env.DB.prepare("DELETE FROM comments").run();
  await env.DB.prepare("DELETE FROM pull_reviews").run();
  await env.DB.prepare("DELETE FROM protected_branches").run();
}

describe("agit lane pure helpers (the upstream ports)", () => {
  it("resolveAgitBaseTopic: exact branch, shortest-prefix split, slashy branches, the miss", () => {
    const branches = ["main", "release", "release/1.0"];
    expect(resolveAgitBaseTopic(branches, "main")).toEqual({ base: "main", topic: "" });
    expect(resolveAgitBaseTopic(branches, "main/my-topic")).toEqual({ base: "main", topic: "my-topic" });
    // Shortest prefix first (agit.go's in-order range walk): "release" wins
    // over "release/1.0" when both exist.
    expect(resolveAgitBaseTopic(branches, "release/1.0/topic")).toEqual({ base: "release", topic: "1.0/topic" });
    // Without the short prefix, the slashy branch itself is the base.
    expect(resolveAgitBaseTopic(["release/1.0"], "release/1.0/topic")).toEqual({ base: "release/1.0", topic: "topic" });
    expect(resolveAgitBaseTopic(branches, "nope/topic")).toBeNull();
    expect(resolveAgitBaseTopic([], "main")).toBeNull();
  });

  it("agitHeadBranch: topics namespace under the lowercased pusher, prefixed topics ride as-is", () => {
    expect(agitHeadBranch("alice", "my-topic")).toBe("alice/my-topic");
    expect(agitHeadBranch("alice", "alice/my-topic")).toBe("alice/my-topic");
    expect(agitHeadBranch("alice", "bob/my-topic")).toBe("alice/bob/my-topic");
  });

  it("parseAgitPushOptionValue: {base64} decodes, failures keep the raw text", () => {
    expect(parseAgitPushOptionValue("plain")).toBe("plain");
    expect(parseAgitPushOptionValue("{base64}aGVsbG8=")).toBe("hello");
    expect(parseAgitPushOptionValue("{base64}!!!not base64!!!")).toBe("{base64}!!!not base64!!!");
    expect(parseAgitPushOptionValue("{base64}")).toBe("");
  });

  it("pushOptionsMap + pushOptionBool: the GIT_PUSH_OPTION_* map and Go's ParseBool polarity", () => {
    const map = pushOptionsMap(["force-push", "topic= my topic ", "bogus=not-a-bool"]);
    expect(pushOptionBool(map, "force-push")).toBe(true); // bare key = true
    expect(pushOptionBool(map, "absent")).toBe(false);
    expect(map.get("topic")).toBe(" my topic ");
    expect(pushOptionBool(pushOptionsMap(["force-push="]), "force-push")).toBe(true);
    expect(pushOptionBool(pushOptionsMap(["force-push=true"]), "force-push")).toBe(true);
    expect(pushOptionBool(pushOptionsMap(["force-push=1"]), "force-push")).toBe(true);
    expect(pushOptionBool(pushOptionsMap(["force-push=TRUE"]), "force-push")).toBe(true);
    expect(pushOptionBool(pushOptionsMap(["force-push=false"]), "force-push")).toBe(false);
    expect(pushOptionBool(pushOptionsMap(["force-push=0"]), "force-push")).toBe(false);
    expect(pushOptionBool(pushOptionsMap(["force-push=yes"]), "force-push")).toBe(false); // unparseable → None → false
  });

  it("splitCommitTitleBody: MessageTitle/MessageBody (commit_message.go)", () => {
    expect(splitCommitTitleBody("title only")).toEqual({ title: "title only", body: "" });
    expect(splitCommitTitleBody("the title\n\nthe body\n")).toEqual({ title: "the title", body: "the body" });
    expect(splitCommitTitleBody("  \n  body after blank title \n")).toEqual({ title: "body after blank title", body: "" });
    expect(splitCommitTitleBody("")).toEqual({ title: "", body: "" });
  });
});

describe("the agit create arm end-to-end (refs/for → PR + refs/pull/N/head)", () => {
  beforeEach(sweepAgitTables);

  it("a refs/for push with options creates the PR, lands refs/pull/1/head, reports the ORIGINAL ref and the URL message", async () => {
    const { repoId, engineName, ownerId, token } = await seedTailRepo("agitcreate");
    await seedAgitWebhook(repoId);
    const { oid, pack } = await buildAgitCommitPack({ message: "proposal one\n" });
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid, ref: "refs/for/main/topic-a" }], {
        pack,
        pushOptions: ["topic=topic-a", "title=Proposal title", "description=Proposal body"],
      }),
    });
    expect(push.status).toBe(200);

    // The report renders the ORIGINAL refs/for name — the engine saw (and
    // applied) refs/pull/1/head, the rewrite mapped it back.
    const { report, messages } = parseAgitResponse(await push.arrayBuffer());
    expect(report).toContain("unpack ok");
    expect(report).toContain("ok refs/for/main/topic-a\n");
    expect(report).not.toContain("ok refs/pull/");
    // A report-status (v1) client gets NO v2 option lines — those ride only
    // the negotiated v2 (cmd/hook.go's option lines are consumed by git's
    // receive-pack and re-rendered per the client's caps; the gate plays
    // both roles and must not leak v2 directives to a v1 client).
    expect(report).not.toContain("option ");
    // The hookPrintResult message rides band 2 with the PR URL.
    expect(messages).toContain("Visit the existing pull request:\n");
    expect(messages).toContain(`  ${EXPECTED_APP_ORIGIN}/${engineName}/pulls/1\n`);

    // The engine: the real head ref landed, the refs/for name did NOT.
    const listed = await env.REPO.getByName(engineName).listRefs();
    const refs = listed.refs.map((r) => r.name);
    expect(refs).toContain("refs/pull/1/head");
    expect(refs).not.toContain("refs/for/main/topic-a");
    const headTip = listed.refs.find((r) => r.name === "refs/pull/1/head")!.target;
    expect(headTip).toBe(oid);

    // D1: the PR row (flow=AGit, the username-prefixed head branch, the
    // option-carried text) and its issue.
    const pr = await drizzle(env.DB).select().from(pullRequests).all();
    expect(pr).toHaveLength(1);
    expect(pr[0]!.index).toBe(1);
    expect(pr[0]!.flow).toBe(PRFlow.AGit);
    expect(pr[0]!.headBranch).toBe("alice/topic-a");
    expect(pr[0]!.baseBranch).toBe("main");
    expect(pr[0]!.headSha).toBe(oid);
    expect(pr[0]!.hasMerged).toBe(false);
    const issue = await drizzle(env.DB).select().from(issues).where(eq(issues.id, pr[0]!.issueId)).get();
    expect(issue!.title).toBe("Proposal title");
    expect(issue!.content).toBe("Proposal body");
    expect(issue!.isPull).toBe(true);
    expect(issue!.posterId).toBe(ownerId);

    // The opened webhook rode the create tail (the awaited delivery row).
    const deliveries = await drizzle(env.DB).select().from(webhookDeliveries).all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventType).toBe("pull_request");
    const payload = JSON.parse(deliveries[0]!.payloadContent) as { action: string; number: number };
    expect(payload.action).toBe("opened");
    expect(payload.number).toBe(1);
  });

  it("a refs/for push WITHOUT title/description derives both from the tip commit post-receive", async () => {
    const { engineName, token } = await seedTailRepo("agitderive");
    const { oid, pack } = await buildAgitCommitPack({ message: "derived title line\nand the body line\n" });
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid, ref: "refs/for/main/derive" }], { pack, pushOptions: [] }),
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);
    const pr = (await drizzle(env.DB).select().from(pullRequests).all())[0]!;
    expect(pr.headBranch).toBe("alice/derive");
    await vi.waitFor(async () => {
      const issue = await drizzle(env.DB).select().from(issues).where(eq(issues.id, pr.issueId)).get();
      expect(issue!.title).toBe("derived title line");
      expect(issue!.content).toBe("and the body line");
    });
  });

  it("the create arm lands the FIRST type-29 push comment (the base..head create shape; an empty head adds none)", async () => {
    const { engineName, ownerId, token, tip } = await seedTailRepo("agitcreatecomment");
    // Upstream's create pin (services/pull/pull.go:145, BOTH flows):
    // CreatePushPullComment with oldRef = the BASE BRANCH REF — resolved to
    // the base tip, never ZERO_OID (comment.go:107-113) — and isForcePush =
    // the literal false. The proposal here is parented on main's tip, so the
    // normal walk (comment.go:43-45: rev-list --reverse -n limit
    // baseTip..headTip) is exactly the PR's own commit, oldest-first.
    const proposal = await buildAgitCommitPack({ message: "created proposal\n", parent: tip, file: "create content\n" });
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid: proposal.oid, ref: "refs/for/main/create-comment" }], {
        pack: proposal.pack,
        pushOptions: ["topic=create-comment"],
      }),
    });
    expect(push.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(push);
    const pr = (await drizzle(env.DB).select().from(pullRequests).all())[0]!;
    const rows = await drizzle(env.DB)
      .select()
      .from(comments)
      .where(and(eq(comments.issueId, pr.issueId), eq(comments.type, CommentType.PullRequestPush)))
      .all();
    expect(rows).toHaveLength(1); // ONE row — no force marker pair at create
    expect(JSON.parse(rows[0]!.content ?? "")).toEqual({ is_force_push: false, commit_ids: [proposal.oid] });
    // The doer is issue.Poster (pull.go:145) — the agit flow's poster IS the
    // pusher.
    expect(rows[0]!.posterId).toBe(ownerId);

    // The EMPTY create: a head AT the base tip adds nothing beyond the base
    // → upstream's shouldCreate=false (comment.go:44-45) — the PR row still
    // exists (upstream creates the PR either way) but NO comment.
    const empty = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid: tip, ref: "refs/for/main/create-empty" }], { pushOptions: ["topic=create-empty"] }),
    });
    expect(empty.status).toBe(200);
    expect(parseAgitResponse(await empty.arrayBuffer()).report).toContain("ok refs/for/main/create-empty\n");
    const prs = await drizzle(env.DB).select().from(pullRequests).all();
    expect(prs).toHaveLength(2);
    const emptyPr = prs.find((p) => p.id !== pr.id)!;
    expect(emptyPr.headSha).toBe(tip);
    const emptyRows = await drizzle(env.DB)
      .select()
      .from(comments)
      .where(and(eq(comments.issueId, emptyPr.issueId), eq(comments.type, CommentType.PullRequestPush)))
      .all();
    expect(emptyRows).toHaveLength(0);
  });
});

describe("the agit update arm (the same proposal moves refs/pull/N/head)", () => {
  beforeEach(sweepAgitTables);

  it("a fast-forward re-push moves the head ref and the row, emits pull_request_sync; a same-oid re-push ngs", async () => {
    const { repoId, engineName, token } = await seedTailRepo("agitupdate");
    await seedAgitWebhook(repoId);
    const first = await buildAgitCommitPack({ message: "proposal base\n" });
    const create = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid: first.oid, ref: "refs/for/main/topic-u" }], { pack: first.pack, pushOptions: ["topic=topic-u"] }),
    });
    expect(create.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(create);
    const created = (await drizzle(env.DB).select().from(pullRequests).all())[0]!;
    expect(created.headSha).toBe(first.oid);

    // The fast-forward tip: a child of the first commit.
    const second = await buildAgitCommitPack({ message: "proposal follow-up\n", parent: first.oid, file: "agit content v2\n" });
    const update = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid: second.oid, ref: "refs/for/main/topic-u" }], { pack: second.pack, pushOptions: [] }),
    });
    expect(update.status).toBe(200);
    const { report, messages } = parseAgitResponse(await update.arrayBuffer());
    expect(report).toContain("ok refs/for/main/topic-u\n");
    expect(messages).toContain(`  ${EXPECTED_APP_ORIGIN}/${engineName}/pulls/1\n`);
    const refTip = (await env.REPO.getByName(engineName).listRefs()).refs.find((r) => r.name === "refs/pull/1/head")!.target;
    expect(refTip).toBe(second.oid);
    const updated = await drizzle(env.DB).select().from(pullRequests).where(eq(pullRequests.id, created.id)).get();
    expect(updated!.headSha).toBe(second.oid);
    expect(updated!.hasMerged).toBe(false);
    // ONE row stays (no duplicate proposal), and the synchronized webhook
    // carries the before/after head oids.
    expect(await drizzle(env.DB).select().from(pullRequests).all()).toHaveLength(1);
    await vi.waitFor(async () => {
      const syncs = await drizzle(env.DB).select().from(webhookDeliveries).all();
      const sync = syncs.find((d) => d.eventType === "pull_request_sync");
      expect(sync).toBeDefined();
      const payload = JSON.parse(sync!.payloadContent) as { action: string; before: string; after: string };
      expect(payload.action).toBe("synchronized");
      expect(payload.before).toBe(first.oid);
      expect(payload.after).toBe(second.oid);
    });

    // The same-oid re-push: upstream's "new commit is same with old commit"
    // ng (a commands-only body — nothing to apply, nothing forwarded).
    const same = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid: second.oid, ref: "refs/for/main/topic-u" }], { pushOptions: [] }),
    });
    expect(same.status).toBe(200);
    expect(parseAgitResponse(await same.arrayBuffer()).report).toContain("ng refs/for/main/topic-u new commit is same with old commit");
    const still = await drizzle(env.DB).select().from(pullRequests).where(eq(pullRequests.id, created.id)).get();
    expect(still!.headSha).toBe(second.oid);
  });

  /** One agit receive over the wired SELF app; returns the report text. */
  async function pushAgit(engineName: string, token: string, commands: { old?: string; oid: string; ref: string }[], pack: Uint8Array | undefined, pushOptions: string[]): Promise<string> {
    const response = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody(commands, { pack, pushOptions }),
    });
    expect(response.status).toBe(200);
    return parseAgitResponse(await response.arrayBuffer()).report;
  }

  /** Create one proposal (refs/for/main/<topic>) and return its issue id. */
  async function seedProposal(engineName: string, token: string, topic: string): Promise<{ first: { oid: string; pack: Uint8Array }; issueId: number; prId: number }> {
    const first = await buildAgitCommitPack({ message: "proposal base\n" });
    const report = await pushAgit(engineName, token, [{ oid: first.oid, ref: `refs/for/main/${topic}` }], first.pack, [`topic=${topic}`]);
    expect(report).toContain(`ok refs/for/main/${topic}\n`);
    const pr = (await drizzle(env.DB).select().from(pullRequests).all())[0]!;
    return { first, issueId: pr.issueId, prId: pr.id };
  }

  /** The issue's type-29 `pull_push` rows, id order. */
  async function type29Rows(issueId: number) {
    return drizzle(env.DB)
      .select()
      .from(comments)
      .where(and(eq(comments.issueId, issueId), eq(comments.type, CommentType.PullRequestPush)))
      .all();
  }

  it("the re-push lands the type-29 push comment (normal walk + force-option reconcile) and settles the check immediately", async () => {
    const { engineName, token, ownerId } = await seedTailRepo("agitpushcomment");
    const { first, issueId, prId } = await seedProposal(engineName, token, "topic-p");
    // The create arm writes the FIRST type-29 row at create (NewPullRequest's
    // shared pin, pull.go:145 — the create describe pins its exact shape);
    // the UPDATE arm owns the family from here on (agit.go:296).
    const createRows = await type29Rows(issueId);
    expect(createRows).toHaveLength(1);
    expect(JSON.parse(createRows[0]!.content ?? "")).toEqual({ is_force_push: false, commit_ids: [first.oid] });

    // Normal fast-forward: the capped old..new walk, non-empty → ONE comment
    // carrying the pushed commits, posted by the agit pusher (comment.go's
    // CreateCommentOptions doer = the agit pusher).
    const second = await buildAgitCommitPack({ message: "proposal follow-up\n", parent: first.oid, file: "agit content v2\n" });
    expect(await pushAgit(engineName, token, [{ oid: second.oid, ref: "refs/for/main/topic-p" }], second.pack, [])).toContain("ok refs/for/main/topic-p\n");
    let rows = await type29Rows(issueId);
    expect(rows).toHaveLength(2); // the create row + this update's row
    expect(JSON.parse(rows[1]!.content ?? "")).toEqual({ is_force_push: false, commit_ids: [second.oid] });
    expect(rows[1]!.posterId).toBe(ownerId);

    // StartPullRequestCheckImmediately's queue work (agit.go:279): the
    // re-arm wrote status=checking (markChecking) and the tail's inline
    // check settled the row BEFORE the response returned — no lazy GET
    // needed.
    const checked = await drizzle(env.DB).select().from(pullRequests).where(eq(pullRequests.id, prId)).get();
    expect(checked!.status).not.toBe(PRStatus.Checking);

    // Force update to an UNRELATED tip under the option: upstream's
    // isForcePush is the OPTION VALUE (agit.go:297 — not the shared path's
    // ancestry derivation), so the force arm runs: BOTH old non-force
    // comments (the create row and the update row) reconcile away — none of
    // their ids survive the force list — and the boundary marker lands; the
    // unrelated tip's merge base is empty → an empty walk → ONLY the marker
    // row survives.
    const rewritten = await buildAgitCommitPack({ message: "rewritten proposal\n", file: "rewritten root\n" });
    expect(await pushAgit(engineName, token, [{ oid: rewritten.oid, ref: "refs/for/main/topic-p" }], rewritten.pack, ["force-push"])).toContain("ok refs/for/main/topic-p\n");
    rows = await type29Rows(issueId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.content ?? "")).toEqual({ is_force_push: true, commit_ids: [second.oid, rewritten.oid] });
  });

  it("the re-push marks existing reviews stale and refreshes reviews made against the new head (no rule: no dismissal)", async () => {
    const { engineName, token, ownerId } = await seedTailRepo("agitstale");
    const bob = await seedVerifiedUser({ username: "Bob" });
    const { first, issueId } = await seedProposal(engineName, token, "topic-s");
    const second = await buildAgitCommitPack({ message: "proposal follow-up\n", parent: first.oid, file: "agit content v2\n" });
    // One approval against the CURRENT head (will go stale) and one already
    // recorded against the INCOMING head (MarkReviewsAsNotStale refreshes
    // it — review.go:630-635's exact commit_id match).
    await drizzle(env.DB)
      .insert(pullReviews)
      .values([
        { type: ReviewType.Approve, reviewerId: ownerId, issueId, content: "", official: true, commitId: first.oid, stale: false, dismissed: false, createdAt: new Date(), updatedAt: new Date() },
        { type: ReviewType.Approve, reviewerId: bob.id, issueId, content: "", official: false, commitId: second.oid, stale: false, dismissed: false, createdAt: new Date(), updatedAt: new Date() },
      ])
      .run();

    expect(await pushAgit(engineName, token, [{ oid: second.oid, ref: "refs/for/main/topic-s" }], second.pack, [])).toContain("ok refs/for/main/topic-s\n");
    const reviews = await drizzle(env.DB).select().from(pullReviews).where(eq(pullReviews.issueId, issueId)).all();
    const aliceReview = reviews.find((r) => r.reviewerId === ownerId)!;
    expect(aliceReview.stale).toBe(true);
    expect(aliceReview.dismissed).toBe(false);
    const bobReview = reviews.find((r) => r.reviewerId === bob.id)!;
    expect(bobReview.stale).toBe(false);
    expect(bobReview.dismissed).toBe(false);
    // No rule on main → the dismiss arm never runs (agit.go:266-276 gates
    // on GetFirstMatchProtectedBranchRule's DismissStaleApprovals).
    const dismissals = await drizzle(env.DB)
      .select()
      .from(comments)
      .where(and(eq(comments.issueId, issueId), eq(comments.type, CommentType.DismissReview)))
      .all();
    expect(dismissals).toHaveLength(0);
  });

  it("the re-push dismisses stale approvals when the base rule sets dismiss_stale_approvals (type-32 comments, num_comments bump)", async () => {
    const { repoId, engineName, token, ownerId } = await seedTailRepo("agitdismiss");
    await seedFileRule(repoId, "main", { dismissStaleApprovals: true });
    const { first, issueId } = await seedProposal(engineName, token, "topic-d");
    await drizzle(env.DB)
      .insert(pullReviews)
      .values({ type: ReviewType.Approve, reviewerId: ownerId, issueId, content: "", official: true, commitId: first.oid, stale: false, dismissed: false, createdAt: new Date(), updatedAt: new Date() })
      .run();
    const issueBefore = (await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueId)).get())!;

    const second = await buildAgitCommitPack({ message: "proposal follow-up\n", parent: first.oid, file: "agit content v2\n" });
    expect(await pushAgit(engineName, token, [{ oid: second.oid, ref: "refs/for/main/topic-d" }], second.pack, [])).toContain("ok refs/for/main/topic-d\n");

    const review = (await drizzle(env.DB).select().from(pullReviews).where(eq(pullReviews.issueId, issueId)).all())[0]!;
    expect(review.dismissed).toBe(true);
    const dismissals = await drizzle(env.DB)
      .select()
      .from(comments)
      .where(and(eq(comments.issueId, issueId), eq(comments.type, CommentType.DismissReview)))
      .all();
    expect(dismissals).toHaveLength(1);
    expect(dismissals[0]!.content).toBe("New commits pushed, approval review dismissed automatically according to repository settings");
    expect(dismissals[0]!.reviewId).toBe(review.id);
    const issueAfter = (await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueId)).get())!;
    // TWO bumps over issueBefore — the create arm's first type-29 bump is
    // ALREADY INSIDE issueBefore (it reads post-create): this update's
    // type-29 (agit.go:296) AND the type-32 dismissal — upstream's
    // CreateComment bumps num_comments for each.
    expect(issueAfter.numComments).toBe(issueBefore.numComments + 2);
  });
});

describe("agit structural rejections synthesize their ng lines (no engine forward)", () => {
  beforeEach(sweepAgitTables);

  it("delete / missing base / missing topic reject in command order; an all-rejected push never forwards", async () => {
    const { engineName, token, tip } = await seedTailRepo("agitngs");
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody(
        [
          { old: tip, oid: ZERO_OID, ref: "refs/for/main/doomed" },
          { oid: tip, ref: "refs/for/nonexistent/topic" },
          { oid: tip, ref: "refs/for/main" },
        ],
        { pushOptions: [] },
      ),
    });
    expect(push.status).toBe(200);
    const { report } = parseAgitResponse(await push.arrayBuffer());
    expect(report).toContain("unpack ok");
    expect(report).toContain("ng refs/for/main/doomed Can't delete not exist branch");
    expect(report).toContain("ng refs/for/nonexistent/topic base-branch does not exist");
    expect(report).toContain("ng refs/for/main topic-branch is not set");
    // Nothing landed engine-side and no PR rows exist.
    const refs = (await env.REPO.getByName(engineName).listRefs()).refs.map((r) => r.name);
    expect(refs).toEqual(["refs/heads/main"]);
    expect(await drizzle(env.DB).select().from(pullRequests).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(issues).all()).toHaveLength(0);
  });

  it("a mixed push forwards the fall-through command and splices the agit ng into command order", async () => {
    const { engineName, token } = await seedTailRepo("agitmix");
    const { oid, pack } = await buildAgitCommitPack({ message: "a real branch\n" });
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody(
        [
          { oid: oid, ref: "refs/for/nope/topic" },
          { oid: oid, ref: "refs/heads/feature" },
        ],
        { pack, pushOptions: [] },
      ),
    });
    expect(push.status).toBe(200);
    const { report } = parseAgitResponse(await push.arrayBuffer());
    // The report keeps the CLIENT's command order (ng first, ok second) —
    // the engine's own report covered only the fall-through command.
    const ngAt = report.indexOf("ng refs/for/nope/topic base-branch does not exist");
    const okAt = report.indexOf("ok refs/heads/feature\n");
    expect(ngAt).toBeGreaterThan(-1);
    expect(okAt).toBeGreaterThan(-1);
    expect(ngAt).toBeLessThan(okAt);
    const refs = (await env.REPO.getByName(engineName).listRefs()).refs.map((r) => r.name);
    expect(refs).toContain("refs/heads/feature");
    expect(refs).not.toContain("refs/for/nope/topic");
  });
});

describe("the agit force gate (the engine classifies, upstream's ng text decides)", () => {
  beforeEach(sweepAgitTables);

  it("an unrelated tip without force-push ngs; with the option it moves", async () => {
    const { engineName, token } = await seedTailRepo("agitforce");
    const first = await buildAgitCommitPack({ message: "proposal base\n" });
    const create = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid: first.oid, ref: "refs/for/main/topic-f" }], { pack: first.pack, pushOptions: ["topic=topic-f"] }),
    });
    expect(create.status).toBe(200);
    // SPEC 0230: the streaming answer resolves before the push applies;
    // drain to stream end — the arm closes strictly after finalize's
    // transaction, so stream end is the push-completion signal
    await drainReceive(create);

    // An UNRELATED tip (no common ancestor with the first): the engine's
    // classification is force-push, the option is absent — upstream's exact
    // ng text, the ref and the row untouched.
    const unrelated = await buildAgitCommitPack({ message: "rewritten history\n", file: "rewritten\n" });
    const refused = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid: unrelated.oid, ref: "refs/for/main/topic-f" }], { pack: unrelated.pack, pushOptions: [] }),
    });
    expect(refused.status).toBe(200);
    expect(parseAgitResponse(await refused.arrayBuffer()).report).toContain("ng refs/for/main/topic-f request `force-push` push option");
    expect((await env.REPO.getByName(engineName).listRefs()).refs.find((r) => r.name === "refs/pull/1/head")!.target).toBe(first.oid);
    expect((await drizzle(env.DB).select().from(pullRequests).all())[0]!.headSha).toBe(first.oid);

    // The SAME tip WITH `-o force-push` moves the proposal.
    const forced = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid: unrelated.oid, ref: "refs/for/main/topic-f" }], { pack: unrelated.pack, pushOptions: ["force-push"] }),
    });
    expect(forced.status).toBe(200);
    expect(parseAgitResponse(await forced.arrayBuffer()).report).toContain("ok refs/for/main/topic-f\n");
    expect((await env.REPO.getByName(engineName).listRefs()).refs.find((r) => r.name === "refs/pull/1/head")!.target).toBe(unrelated.oid);
    expect((await drizzle(env.DB).select().from(pullRequests).all())[0]!.headSha).toBe(unrelated.oid);
  });
});

describe("agit report-status-v2 option lines (cmd/hook.go:604-620)", () => {
  beforeEach(sweepAgitTables);

  it("a v2 create carries refname + new-oid (no old-oid); a v2 update adds old-oid", async () => {
    const { engineName, token } = await seedTailRepo("agitv2");
    const first = await buildAgitCommitPack({ message: "v2 proposal\n" });
    const create = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid: first.oid, ref: "refs/for/main/topic-v" }], {
        caps: "report-status-v2 side-band-64k push-options",
        pack: first.pack,
        pushOptions: ["topic=topic-v"],
      }),
    });
    expect(create.status).toBe(200);
    const createReport = parseAgitResponse(await create.arrayBuffer()).report;
    expect(createReport).toContain("ok refs/for/main/topic-v\n");
    expect(createReport).toContain("option refname refs/pull/1/head\n");
    expect(createReport).toContain(`option new-oid ${first.oid}\n`);
    expect(createReport).not.toContain("option old-oid");

    // The update arm renders the old-oid line (the ref existed).
    const second = await buildAgitCommitPack({ message: "v2 follow-up\n", parent: first.oid, file: "v2 content\n" });
    const update = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid: second.oid, ref: "refs/for/main/topic-v" }], {
        caps: "report-status-v2 side-band-64k push-options",
        pack: second.pack,
        pushOptions: [],
      }),
    });
    expect(update.status).toBe(200);
    const updateReport = parseAgitResponse(await update.arrayBuffer()).report;
    expect(updateReport).toContain(`option old-oid ${first.oid}\n`);
    expect(updateReport).toContain(`option new-oid ${second.oid}\n`);
  });
});

describe("the agit blocked gate (NewPullRequest's IsUserBlockedBy arm)", () => {
  beforeEach(sweepAgitTables);

  it("a pusher blocked by the repo owner ngs with upstream's exact hook UserMsg; no PR row lands", async () => {
    const { repoId, engineName, ownerId, token } = await seedTailRepo("agitblocked");
    // The row-level shape of the reachable population (a pusher holding a
    // write grant — the owner themself here; the block SERVICE's own rules
    // are another suite's subject). Upstream: the decline lives ONLY in the
    // proc-receive hook, and its exact UserMsg is the ng text.
    await drizzle(env.DB)
      .insert(userBlocking)
      .values({ blockerId: ownerId, blockeeId: ownerId, note: "", createdAt: new Date() })
      .run();
    const { oid, pack } = await buildAgitCommitPack({ message: "should not create\n" });
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid, ref: "refs/for/main/topic-b" }], { pack, pushOptions: ["topic=topic-b"] }),
    });
    expect(push.status).toBe(200);
    // 640cd615c4 wrapped NewPullRequest's ErrBlockedUser with the
    // repo.creation_blocked_by_owner translation — the hook's ng line
    // carries the new wording (services/pull/pull.go:66-70 via
    // PrivateUserErrorAuto; the AGIT_NG.blocked port).
    expect(parseAgitResponse(await push.arrayBuffer()).report).toContain(
      "ng refs/for/main/topic-b Cannot create an issue or pull request because you are blocked by the repository owner.",
    );
    expect(await drizzle(env.DB).select().from(pullRequests).all()).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(issues).all()).toHaveLength(0);
    expect((await env.REPO.getByName(engineName).listRefs()).refs.map((r) => r.name)).toEqual(["refs/heads/main"]);
    void repoId;
  });
});

describe("agit quiet clients (no report-status negotiation)", () => {
  beforeEach(sweepAgitTables);

  it("a quiet push still creates the PR and still carries the band-2 message — but no report", async () => {
    const { repoId, engineName, token } = await seedTailRepo("agitquiet");
    void repoId;
    const { oid, pack } = await buildAgitCommitPack({ message: "quiet proposal\n" });
    const push = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildAgitPushBody([{ oid, ref: "refs/for/main/topic-q" }], {
        caps: "side-band-64k push-options",
        pack,
        pushOptions: ["topic=topic-q"],
      }),
    });
    expect(push.status).toBe(200);
    const { report, messages } = parseAgitResponse(await push.arrayBuffer());
    expect(report).toBe(""); // no report-status → no report, exactly the engine's quiet shape
    expect(messages).toContain(`  ${EXPECTED_APP_ORIGIN}/${engineName}/pulls/1\n`);
    expect(await drizzle(env.DB).select().from(pullRequests).all()).toHaveLength(1);
  });
});

describe("the lane boundary: rowless (engine-only) repos keep the engine's literal refs/for", () => {
  beforeEach(sweepAgitTables);

  it.skipIf(!env.GIT_TOKEN)(
    "a refs/for push at a repo with NO D1 row applies the literal ref (the D1-repository boundary, census-recorded)",
    async () => {
      const { oid, pack } = await buildAgitCommitPack({ message: "rowless\n" });
      const push = await SELF.fetch("https://example.com/demo/agitrowless.git/git-receive-pack", {
        method: "POST",
        headers: { authorization: basicHeader("x", env.GIT_TOKEN), "content-type": RECEIVE_CT },
        body: buildAgitPushBody([{ oid, ref: "refs/for/main/topic" }], { pack, caps: "report-status side-band-64k" }),
      });
      expect(push.status).toBe(200);
      // SPEC 0230: the streaming answer resolves before the push applies;
      // drain to stream end — the arm closes strictly after finalize's
      // transaction, so stream end is the push-completion signal
      await drainReceive(push);
      const refs = (await env.REPO.getByName("demo/agitrowless").listRefs()).refs.map((r) => r.name);
      expect(refs).toContain("refs/for/main/topic");
      expect(await drizzle(env.DB).select().from(pullRequests).all()).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// The push-side protected-file family (hook_pre_receive.go:207-267 — census
// B-53 remainder (1), landed with the engine's lease-carrying
// `diffReceive`/`changedPaths` seam): upstream steps 4-6 ride the protected
// branch ladder — the file walk refuses even an ALLOWLISTED pusher, the
// `unprotected_files_only` allowance lets a non-allowlisted one through, the
// force refusal still precedes the gate, and a branch-create diffs from its
// divergence point (GetCommitBranchStart).
// ---------------------------------------------------------------------------

/** One commit pack over a {path: content} file map — nested paths build real
 *  subtrees (buildAgitCommitPack fixes the path at file.txt; this battery
 *  needs controlled ones). workerd-safe, the buildAgitCommitPack shape. */
async function buildBatteryFilesPack(opts: { files: Record<string, string>; parent?: string; message?: string }): Promise<{ oid: string; pack: Uint8Array }> {
  const encoder = new TextEncoder();
  const blobs = new Map<string, { oid: string; body: Uint8Array }>();
  for (const [path, content] of Object.entries(opts.files)) {
    const body = encoder.encode(content);
    const oid = await batterySha1Hex(concatBatteryU8([encoder.encode(`blob ${body.length}\0`), body]));
    blobs.set(path, { oid, body });
  }
  const dirs = new Set<string>();
  for (const path of blobs.keys()) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join("/") + "/");
  }
  const treeOids = new Map<string, string>();
  const buildTreeBody = (prefix: string): Uint8Array => {
    const entries: { name: string; mode: string; oidHex: string }[] = [];
    for (const [path, blob] of blobs) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes("/")) continue;
      entries.push({ name: rest, mode: "100644", oidHex: blob.oid });
    }
    for (const dir of dirs) {
      if (!dir.startsWith(prefix) || dir === prefix) continue;
      // `dir` carries its trailing '/': strip it before the depth test (a
      // bare "Secret/" is a DIRECT child, not a deeper path)
      const rest = dir.slice(prefix.length);
      const bare = rest.endsWith("/") ? rest.slice(0, -1) : rest;
      if (bare.includes("/")) continue;
      entries.push({ name: bare, mode: "40000", oidHex: treeOids.get(dir)! });
    }
    // git tree order: names byte-compared, directories as name + '/'
    const keyOf = (entry: { name: string; mode: string }): string => entry.name + (entry.mode === "40000" ? "/" : "");
    entries.sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const chunks: Uint8Array[] = [];
    for (const entry of entries) {
      chunks.push(encoder.encode(`${entry.mode} ${entry.name}\0`));
      chunks.push(batteryRawOid(entry.oidHex));
    }
    return concatBatteryU8(chunks);
  };
  const treeShaOf = async (body: Uint8Array): Promise<string> => batterySha1Hex(concatBatteryU8([encoder.encode(`tree ${body.length}\0`), body]));
  const objects: { type: number; body: Uint8Array }[] = [];
  for (const blob of blobs.values()) objects.push({ type: 3, body: blob.body });
  // bottom-up: a subtree's oid exists before its parent's body builds
  const deepestFirst = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const dir of deepestFirst) {
    const body = buildTreeBody(dir);
    const sha = await treeShaOf(body);
    treeOids.set(dir, sha);
    objects.push({ type: 2, body });
  }
  const rootBody = buildTreeBody("");
  const rootSha = await treeShaOf(rootBody);
  objects.push({ type: 2, body: rootBody });
  const parentLines = opts.parent !== undefined ? `parent ${opts.parent}\n` : "";
  const commitBody = encoder.encode(
    `tree ${rootSha}\n` +
      parentLines +
      `author Battery Tester <battery@example.com> 1700000200 +0000\n` +
      `committer Battery Tester <battery@example.com> 1700000200 +0000\n\n` +
      (opts.message ?? "battery files commit") +
      `\n`,
  );
  const commitSha = await batterySha1Hex(concatBatteryU8([encoder.encode(`commit ${commitBody.length}\0`), commitBody]));
  objects.push({ type: 1, body: commitBody });
  const chunks: Uint8Array[] = [encoder.encode("PACK"), batteryBe32(2), batteryBe32(objects.length)];
  for (const object of objects) {
    chunks.push(batteryObjectHeader(object.type, object.body.length));
    chunks.push(await batteryDeflate(object.body));
  }
  chunks.push(await batterySha1Bytes(concatBatteryU8(chunks)));
  return { oid: commitSha, pack: concatBatteryU8(chunks) };
}

/** Seed one protected-branch rule row (the branch-protection-push.test.ts
 *  shape: the full config through the landed serializer). */
async function seedFileRule(repoId: string, ruleName: string, config: Partial<ProtectedBranchConfig>): Promise<void> {
  await drizzle(env.DB)
    .insert(protectedBranches)
    .values({
      repoId,
      ruleName,
      priority: 0,
      rules: serializeRuleConfig({ ...emptyRuleConfig(), ...config }),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}

/** One plain receive (report-status + side-band, NO push-options section —
 *  the file battery sends no options, and advertising the capability would
 *  make the gate's section parse read the pack as the options section). */
async function pushFileBattery(engineName: string, token: string, command: { old?: string; oid: string; ref: string }, pack: Uint8Array): Promise<string> {
  const response = await SELF.fetch(`https://example.com/${engineName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
    body: buildAgitPushBody([command], { pack, caps: "report-status side-band-64k" }),
  });
  expect(response.status).toBe(200);
  return parseAgitResponse(await response.arrayBuffer()).report;
}

async function batteryRefTip(engineName: string, ref: string): Promise<string | undefined> {
  return (await env.REPO.getByName(engineName).listRefs()).refs.find((r) => r.name === ref)?.target;
}

describe("the push-side protected-file family (hook_pre_receive.go:207-267 — census B-53 remainder (1))", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM protected_branches").run();
  });

  it("a changed protected file refuses even a pusher the rule allows, with the LOWERCASED path; a public-file push lands", async () => {
    const { repoId, engineName, token, tip } = await seedTailRepo("protfileallow");
    // can_push with the whitelist off: every writer passes CanUserPush — the
    // file gate is the ONLY thing that can refuse this pusher (:229-234:
    // canPush = !changedProtectedFiles && CanUserPush).
    await seedFileRule(repoId, "main", { canPush: true, protectedFilePatterns: "SECRET/**" });

    const secret = await buildBatteryFilesPack({ files: { "Secret/Token.txt": "rot13\n" }, parent: tip, message: "touch a protected file" });
    const refused = await pushFileBattery(engineName, token, { old: tip, oid: secret.oid, ref: "refs/heads/main" }, secret.pack);
    // The column lowercases at compile and the walk lowercases each path
    // (patch.go:370-402) — the refusal names the lowercased path.
    expect(refused).toContain("ng refs/heads/main Branch main is protected from changing file secret/token.txt");
    expect(await batteryRefTip(engineName, "refs/heads/main")).toBe(tip);

    const open = await buildBatteryFilesPack({ files: { "docs/public.md": "fine\n" }, parent: tip, message: "touch a public file" });
    const landed = await pushFileBattery(engineName, token, { old: tip, oid: open.oid, ref: "refs/heads/main" }, open.pack);
    expect(landed).toContain("ok refs/heads/main\n");
    expect(await batteryRefTip(engineName, "refs/heads/main")).toBe(open.oid);
  });

  it("the unprotected_files_only allowance passes a pusher the rule does NOT allow; an outside file and a protected file each refuse with their own text", async () => {
    const { repoId, engineName, token, tip } = await seedTailRepo("protfileunprot");
    // can_push unset: CanUserPush is false for everyone — only the
    // allowance (:246-258) can let a push through.
    await seedFileRule(repoId, "main", { protectedFilePatterns: "secret/**", unprotectedFilePatterns: "docs/**" });

    const docsOnly = await buildBatteryFilesPack({ files: { "docs/a.md": "free\n" }, parent: tip, message: "docs only" });
    // The tree is replaced wholesale, so the seed commit's own file counts as
    // a changed (deleted) path outside docs/** — the allowance must NOT pass.
    const mixed = await pushFileBattery(engineName, token, { old: tip, oid: docsOnly.oid, ref: "refs/heads/main" }, docsOnly.pack);
    expect(mixed).toContain("ng refs/heads/main Not allowed to push to protected branch main");
    expect(await batteryRefTip(engineName, "refs/heads/main")).toBe(tip);

    // A protected file under the same non-allowed pusher: the file text
    // wins over the direct-push refusal (:240-243 precedes :246).
    const leak = await buildBatteryFilesPack({ files: { "secret/leak.txt": "leak\n" }, parent: tip, message: "leak" });
    const fileText = await pushFileBattery(engineName, token, { old: tip, oid: leak.oid, ref: "refs/heads/main" }, leak.pack);
    expect(fileText).toContain("ng refs/heads/main Branch main is protected from changing file secret/leak.txt");
  });

  it("the allowance passes when EVERY changed path is unprotected", async () => {
    const { repoId, engineName, token } = await seedTailRepo("protfileevery");
    // A docs-only base lands first on an unruled branch, so the next push's
    // diff is docs-only on both sides.
    const base = await buildBatteryFilesPack({ files: { "docs/a.md": "one\n" }, message: "docs base" });
    const staged = await pushFileBattery(engineName, token, { oid: base.oid, ref: "refs/heads/docs" }, base.pack);
    expect(staged).toContain("ok refs/heads/docs\n");

    await seedFileRule(repoId, "docs", { protectedFilePatterns: "secret/**", unprotectedFilePatterns: "docs/**" });
    const next = await buildBatteryFilesPack({ files: { "docs/a.md": "one\n", "docs/b.md": "two\n" }, parent: base.oid, message: "docs follow-up" });
    const allowed = await pushFileBattery(engineName, token, { old: base.oid, oid: next.oid, ref: "refs/heads/docs" }, next.pack);
    expect(allowed).toContain("ok refs/heads/docs\n");
    expect(await batteryRefTip(engineName, "refs/heads/docs")).toBe(next.oid);
  });

  it("a branch CREATE diffs from its divergence point (GetCommitBranchStart), not from the root", async () => {
    const { repoId, engineName, token, tip } = await seedTailRepo("protfilecreate");
    // main (unruled) already carries a file under the protected pattern.
    const base = await buildBatteryFilesPack({ files: { "secret/base.txt": "base\n" }, parent: tip, message: "main carries a secret" });
    const onMain = await pushFileBattery(engineName, token, { old: tip, oid: base.oid, ref: "refs/heads/main" }, base.pack);
    expect(onMain).toContain("ok refs/heads/main\n");

    await seedFileRule(repoId, "release/**", { canPush: true, protectedFilePatterns: "secret/**" });

    // The new branch adds a second secret. A root-based diff would name
    // secret/base.txt first (path order); the divergence base is main's tip,
    // so ONLY the new file is a change.
    const leak = await buildBatteryFilesPack({
      files: { "secret/base.txt": "base\n", "secret/leak.txt": "leak\n" },
      parent: base.oid,
      message: "release adds a secret",
    });
    const refused = await pushFileBattery(engineName, token, { oid: leak.oid, ref: "refs/heads/release/1" }, leak.pack);
    expect(refused).toContain("ng refs/heads/release/1 Branch release/1 is protected from changing file secret/leak.txt");
    expect(await batteryRefTip(engineName, "refs/heads/release/1")).toBeUndefined();

    // Inherited-but-unchanged secrets do not refuse the create.
    const clean = await buildBatteryFilesPack({
      files: { "secret/base.txt": "base\n", "docs/ok.md": "ok\n" },
      parent: base.oid,
      message: "release adds docs",
    });
    const landed = await pushFileBattery(engineName, token, { oid: clean.oid, ref: "refs/heads/release/2" }, clean.pack);
    expect(landed).toContain("ok refs/heads/release/2\n");
    expect(await batteryRefTip(engineName, "refs/heads/release/2")).toBe(clean.oid);
  });

  it("a force push meets the outright refusal BEFORE the file gate, then the gate with the force predicate", async () => {
    const { repoId, engineName, token, tip } = await seedTailRepo("protfileforce");
    await seedFileRule(repoId, "main", { canPush: true, protectedFilePatterns: "secret/**" });

    // can_force_push unset: step 2's refusal (:176-191), no walk needed —
    // even though this rewrite WOULD trip the file gate.
    const rewrite = await buildBatteryFilesPack({ files: { "secret/rewritten.txt": "rewritten\n" }, message: "unrelated rewrite" });
    const outright = await pushFileBattery(engineName, token, { old: tip, oid: rewrite.oid, ref: "refs/heads/main" }, rewrite.pack);
    expect(outright).toContain("ng refs/heads/main Branch main is protected from force push");

    await drizzle(env.DB)
      .update(protectedBranches)
      .set({ rules: serializeRuleConfig({ ...emptyRuleConfig(), canPush: true, canForcePush: true, protectedFilePatterns: "secret/**" }) })
      .where(eq(protectedBranches.repoId, repoId));

    // can_force_push set and the predicate holds: the file gate refuses.
    const gated = await pushFileBattery(engineName, token, { old: tip, oid: rewrite.oid, ref: "refs/heads/main" }, rewrite.pack);
    expect(gated).toContain("ng refs/heads/main Branch main is protected from changing file secret/rewritten.txt");
    expect(await batteryRefTip(engineName, "refs/heads/main")).toBe(tip);

    // The same rule, a rewrite outside the patterns: the force push lands.
    const open = await buildBatteryFilesPack({ files: { "docs/rewrite.md": "open\n" }, message: "unrelated open rewrite" });
    const landed = await pushFileBattery(engineName, token, { old: tip, oid: open.oid, ref: "refs/heads/main" }, open.pack);
    expect(landed).toContain("ok refs/heads/main\n");
    expect(await batteryRefTip(engineName, "refs/heads/main")).toBe(open.oid);
  });
});
