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
 */

import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicHeader, basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { settleCreatingRepo } from "./gate";
import { repositories } from "../db/schema";
import { buildPack, buildReceivePackBody } from "../repos/testing/git-pack";

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
