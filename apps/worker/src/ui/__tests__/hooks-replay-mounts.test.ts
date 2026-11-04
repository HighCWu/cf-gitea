/**
 * The B-63 replay mounts' behavioral pins (ui/index.ts — the four scopes'
 * POST /…/hooks/{id}/replay/{uuid} arms): the parse claims (family + uuid
 * carrier), the POST copies (303 onto the scope's hook-detail URL + a NEW
 * pending delivery row carrying the source's stored payload/event bytes —
 * upstream ReplayHookTask's copy semantics, the history keeps both
 * attempts), the 404 shells (unknown hook / foreign hook / unknown uuid /
 * non-owner / non-admin) and the GET twins' 405 (chi's posture).
 *
 * Harness posture: pages-wave53 (the router driven directly with the
 * synthetic ASSETS manifest; idempotent seeds through the LANDED service
 * arms; FIXED uuids — the wave-14 determinism rule). The WEBHOOK_DELIVERY
 * producer is absent from the test Env, so the copies stay `pending`
 * (SPEC-0005 §3.6 — the pending D1 row is the durable truth; the
 * waitUntil-less test dispatch never enqueues).
 *
 * Upstream: web.go:1237 repo / :743 user / :1038 org / :865 admin — all
 * m.Post("/replay/{uuid}", repo_setting.ReplayWebhook) inside the scope's
 * {id} group; ReplayWebhook (routers/web/repo/setting/webhook.go:735)
 * redirects to orCtx.Link + "/" + w.ID (the admin Link is /-/admin/hooks —
 * its {id} edit page is the admin-hooks module's documented UNLANDED slice,
 * so that 303 target 404-shells until the slice lands; the redirect itself
 * is the pin). Junk/deeper tails stay unclaimed at the parse (asserted
 * there, never by fetching the sub-app — the user-settings-webhooks.test.tsx
 * convention).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, users, webhookDeliveries, webhooks } from "../../db/schema";
import { createOwnerHook, createRepoHook, type WebhookRow } from "../../api/services/hooks";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { OrgService } from "../../services/orgs/orgs";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const formPost = (path: string, cookie: string, origin = "https://test.local"): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...(origin === "" ? {} : { origin }),
    cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
  },
  body: new URLSearchParams().toString(),
});

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

// --- fixtures -----------------------------------------------------------------

interface ReplayFixture {
  ownerCookie: string; // replayowner — owns everything seeded here
  memberCookie: string; // a plain replayorg member (non-owner)
  adminCookie: string; // site admin
  strangerCookie: string; // an unrelated signed-in viewer
  userId: number;
  orgId: number;
  repoId: string;
  userHookId: number;
  orgHookId: number;
  repoHookId: number;
  globalHookId: number;
  scopedHookId: number; // an ORG hook (the admin arm's scope miss)
  userDeliveryUuid: string;
  orgDeliveryUuid: string;
  repoDeliveryUuid: string;
  globalDeliveryUuid: string;
}

let fixture: ReplayFixture | null = null;

const DELIVERY_SOURCE_PAYLOAD = '{"zen":"replay me"}';

async function seedDelivery(hookId: number, repoId: string, uuid: string): Promise<void> {
  const existing = await drizzle(env.DB).select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(eq(webhookDeliveries.uuid, uuid)).get();
  if (existing !== undefined) return;
  await drizzle(env.DB).insert(webhookDeliveries).values({
    hookId,
    repoId,
    uuid,
    eventType: "issues",
    eventGroup: "issues",
    payloadContent: DELIVERY_SOURCE_PAYLOAD,
    state: "delivered",
    isSucceed: true,
    attempts: 1,
    createdAt: new Date("2026-01-03T00:00:00Z"),
    deliveredAt: new Date("2026-01-03T00:01:00Z"),
  });
}

async function ensureReplayFixtures(): Promise<ReplayFixture> {
  if (fixture !== null) return fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const orgs = new OrgService(env.DB);

  for (const extra of [
    { username: "replayowner", isAdmin: false },
    { username: "replaymember", isAdmin: false },
    { username: "replayadmin", isAdmin: true },
    { username: "replaystranger", isAdmin: false },
  ] as const) {
    if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra.username)).get()) === undefined) {
      await seedVerifiedUser({ username: extra.username, isAdmin: extra.isAdmin });
    }
  }
  const owner = (await db.select().from(users).where(eq(users.usernameLower, "replayowner")).get())!;
  const admin = (await db.select().from(users).where(eq(users.usernameLower, "replayadmin")).get())!;

  let org = await orgs.getOrgByUsername("replayorg");
  if (org === null) {
    org = await orgs.createOrg({ name: "replayorg", ownerId: owner.id, visibility: "public" });
    await orgs.addMember(org.id, (await db.select().from(users).where(eq(users.usernameLower, "replaymember")).get())!.id);
  }
  org = (await orgs.getOrgByUsername("replayorg"))!;

  if ((await db.select({ id: repositories.id }).from(repositories).where(eq(repositories.ownerNamespace, "replayowner")).get()) === undefined) {
    await db.insert(repositories).values({
      id: "r_replayrepo",
      storageKey: "r_replayrepo",
      ownerNamespace: "replayowner",
      ownerId: owner.id,
      slug: "replayrepo",
      visibility: "public",
    });
  }
  const repo = (await db.select().from(repositories).where(and(eq(repositories.ownerNamespace, "replayowner"), eq(repositories.slug, "replayrepo"))).get())!;

  const hookOf = async (url: string): Promise<WebhookRow | null> => (await db.select().from(webhooks).where(eq(webhooks.url, url)).get()) ?? null;
  const ensureOwnerHook = async (url: string, ownerId: number, repoId: string | null): Promise<WebhookRow> => {
    let hook = await hookOf(url);
    if (hook === null) {
      if (repoId === null) {
        await createOwnerHook(env.DB, ownerId, {
          type: "gitea",
          name: "replay hook",
          config: { url, content_type: "json" },
          active: true,
          branch_filter: "",
          events: ["push"],
        });
      } else {
        await createRepoHook(env.DB, repoId, {
          type: "gitea",
          name: "replay hook",
          config: { url, content_type: "json" },
          active: true,
          branch_filter: "",
          events: ["push"],
        });
      }
      hook = await hookOf(url);
    }
    if (hook === null) throw new Error("hook seed failed");
    return hook;
  };

  const userHook = await ensureOwnerHook("https://hooks.example.com/replay-user", owner.id, null);
  const orgHook = await ensureOwnerHook("https://hooks.example.com/replay-org", org.id, null);
  const repoHook = await ensureOwnerHook("https://hooks.example.com/replay-repo", owner.id, repo.id);
  // The admin arm's GLOBAL row (owner_id and repo_id both NULL — the
  // GetSystemOrDefaultWebhook condition) and its SCOPED negative.
  let globalHook = await hookOf("https://hooks.example.com/replay-global");
  if (globalHook === null) {
    await db.insert(webhooks).values({
      ownerId: null,
      repoId: null,
      url: "https://hooks.example.com/replay-global",
      name: "global replay hook",
      contentType: 1,
      events: JSON.stringify({ choose_events: true, branch_filter: "", events: { push: true } }),
      isActive: true,
      type: "gitea",
      createdAt: new Date("2026-01-02T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });
    globalHook = await hookOf("https://hooks.example.com/replay-global");
  }
  if (globalHook === null) throw new Error("global hook seed failed");

  const userDeliveryUuid = "replay-user-src-uuid";
  const orgDeliveryUuid = "replay-org-src-uuid";
  const repoDeliveryUuid = "replay-repo-src-uuid";
  const globalDeliveryUuid = "replay-global-src-uuid";
  await seedDelivery(userHook.id, "r_replayrepo", userDeliveryUuid);
  await seedDelivery(orgHook.id, "r_replayrepo", orgDeliveryUuid);
  await seedDelivery(repoHook.id, repo.id, repoDeliveryUuid);
  await seedDelivery(globalHook.id, "r_replayrepo", globalDeliveryUuid);

  fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    memberCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "replaymember")).get())!.id),
    adminCookie: await mintSession(env.DB, admin.id),
    strangerCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "replaystranger")).get())!.id),
    userId: owner.id,
    orgId: org.id,
    repoId: repo.id,
    userHookId: userHook.id,
    orgHookId: orgHook.id,
    repoHookId: repoHook.id,
    globalHookId: globalHook.id,
    scopedHookId: orgHook.id,
    userDeliveryUuid,
    orgDeliveryUuid,
    repoDeliveryUuid,
    globalDeliveryUuid,
  };
  return fixture;
}

beforeAll(async () => {
  await ensureReplayFixtures();
});

// --- the parse claims (family enum entries + parser arms) ----------------------

describe("parseUiRoute claims the four replay families (B-63)", () => {
  const uuid = "replay-src-uuid";

  it("repo: /{owner}/{repo}/settings/hooks/{id}/replay/{uuid} (the uuid rides verbatim)", () => {
    expect(parseUiRoute(`/alice/replayrepo/settings/hooks/5/replay/${uuid}`)).toEqual({
      family: "settings-hook-replay",
      owner: "alice",
      repo: "replayrepo",
      id: 5,
      uuid,
    });
  });

  it("user: /user/settings/hooks/{id}/replay/{uuid}", () => {
    expect(parseUiRoute(`/user/settings/hooks/7/replay/${uuid}`)).toEqual({ family: "user-settings-hook-replay", id: 7, uuid });
  });

  it("org: /org/{org}/settings/hooks/{id}/replay/{uuid}", () => {
    expect(parseUiRoute(`/org/replayorg/settings/hooks/3/replay/${uuid}`)).toEqual({ family: "org-settings-hook-replay", owner: "replayorg", id: 3, uuid });
  });

  it("admin: /-/admin/hooks/{id}/replay/{uuid}", () => {
    expect(parseUiRoute(`/-/admin/hooks/9/replay/${uuid}`)).toEqual({ family: "admin-hooks-replay", id: 9, uuid });
  });

  it("the junk/deeper tails stay unclaimed (the engine's 404)", () => {
    expect(parseUiRoute(`/user/settings/hooks/7/replay`)).toBeNull(); // the literal needs its {uuid} segment
    expect(parseUiRoute(`/user/settings/hooks/abc/replay/${uuid}`)).toBeNull(); // the hooks-family PathParamInt64 parity
    expect(parseUiRoute(`/user/settings/hooks/7/replay/${uuid}/more`)).toBeNull();
    expect(parseUiRoute(`/-/admin/hooks/abc/replay/${uuid}`)).toBeNull();
    expect(parseUiRoute(`/-/admin/hooks/9/replay`)).toBeNull();
    expect(parseUiRoute(`/org/replayorg/settings/hooks/abc/replay/${uuid}`)).toBeNull();
    expect(parseUiRoute(`/alice/replayrepo/settings/hooks/5/replay`)).toBeNull();
    expect(handlesUiRoute(`/user/settings/hooks/7/replay`)).toBe(false);
  });
});

// --- the POST copies (ReplayWebhook over each scope's guards) ------------------

/** The copy assertions shared by the four scope arms: exactly one NEW row on
 *  the hook (the source untouched — upstream replays COPY, never re-queue),
 *  carrying the source's stored payload/event bytes under a new uuid in the
 *  pending state (the producer-less test dispatch never enqueues — the
 *  pending D1 row is the durable truth). */
async function expectReplayedCopy(hookId: number, sourceUuid: string): Promise<number> {
  const rows = await drizzle(env.DB).select().from(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId)).all();
  const source = rows.find((row) => row.uuid === sourceUuid);
  const copy = rows.find((row) => row.uuid !== sourceUuid);
  expect(source).toBeDefined();
  expect(copy).toBeDefined();
  expect(copy?.uuid).not.toBe(sourceUuid);
  expect(copy).toMatchObject({
    hookId,
    state: "pending",
    eventType: source?.eventType,
    eventGroup: source?.eventGroup,
    payloadContent: DELIVERY_SOURCE_PAYLOAD,
    attempts: 0,
  });
  expect(source).toMatchObject({ state: "delivered", attempts: 1 }); // the source row is untouched
  return copy!.id;
}

describe("POST replay mounts (the four scopes)", () => {
  it("repo: the owner replays — 303 onto the hook's page, a NEW pending copy rides the hook", async () => {
    const f = await ensureReplayFixtures();
    const res = await fetchUi(`/replayowner/replayrepo/settings/hooks/${f.repoHookId}/replay/${f.repoDeliveryUuid}`, formPost(`/replayowner/replayrepo/settings/hooks/${f.repoHookId}/replay/${f.repoDeliveryUuid}`, f.ownerCookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/replayowner/replayrepo/settings/hooks/${f.repoHookId}`);
    await expectReplayedCopy(f.repoHookId, f.repoDeliveryUuid);
  });

  it("repo: a uuid not among THAT hook's deliveries 404-shells", async () => {
    const f = await ensureReplayFixtures();
    const res = await fetchUi(`/replayowner/replayrepo/settings/hooks/${f.repoHookId}/replay/unknown-uuid`, formPost(`/replayowner/replayrepo/settings/hooks/${f.repoHookId}/replay/unknown-uuid`, f.ownerCookie));
    expect(res.status).toBe(404);
  });

  it("user: the doer replays — 303 onto the hook's page, a NEW pending copy rides the hook", async () => {
    const f = await ensureReplayFixtures();
    const res = await fetchUi(`/user/settings/hooks/${f.userHookId}/replay/${f.userDeliveryUuid}`, formPost(`/user/settings/hooks/${f.userHookId}/replay/${f.userDeliveryUuid}`, f.ownerCookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/user/settings/hooks/${f.userHookId}`);
    await expectReplayedCopy(f.userHookId, f.userDeliveryUuid);
  });

  it("user: an unknown hook id 404-shells (existence stays hidden)", async () => {
    const f = await ensureReplayFixtures();
    const res = await fetchUi(`/user/settings/hooks/424242/replay/${f.userDeliveryUuid}`, formPost(`/user/settings/hooks/424242/replay/${f.userDeliveryUuid}`, f.ownerCookie));
    expect(res.status).toBe(404);
  });

  it("org: the owner replays — 303 onto the hook's page; a non-owner member 404-shells", async () => {
    const f = await ensureReplayFixtures();
    const ok = await fetchUi(`/org/replayorg/settings/hooks/${f.orgHookId}/replay/${f.orgDeliveryUuid}`, formPost(`/org/replayorg/settings/hooks/${f.orgHookId}/replay/${f.orgDeliveryUuid}`, f.ownerCookie));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/org/replayorg/settings/hooks/${f.orgHookId}`);
    await expectReplayedCopy(f.orgHookId, f.orgDeliveryUuid);

    const member = await fetchUi(`/org/replayorg/settings/hooks/${f.orgHookId}/replay/${f.orgDeliveryUuid}`, formPost(`/org/replayorg/settings/hooks/${f.orgHookId}/replay/${f.orgDeliveryUuid}`, f.memberCookie));
    expect(member.status).toBe(404); // upstream's RequireOwner OrgAssignment NotFound
  });

  it("admin: the site admin replays a GLOBAL hook — 303 onto upstream's redirect target; a scoped hook 404s; a non-admin 404-shells", async () => {
    const f = await ensureReplayFixtures();
    const ok = await fetchUi(`/-/admin/hooks/${f.globalHookId}/replay/${f.globalDeliveryUuid}`, formPost(`/-/admin/hooks/${f.globalHookId}/replay/${f.globalDeliveryUuid}`, f.adminCookie));
    expect(ok.status).toBe(303);
    // orCtx.Link + "/" + w.ID (getOwnerRepoCtx's PageIsAdmin arm) — the edit
    // page itself is the admin-hooks module's documented UNLANDED slice.
    expect(ok.headers.get("location")).toBe(`/-/admin/hooks/${f.globalHookId}`);
    await expectReplayedCopy(f.globalHookId, f.globalDeliveryUuid);

    // GetSystemOrDefaultWebhook's scope: an owner-scoped row is a miss (the
    // same uuid lives on the org hook — never replayed from the admin arm).
    const scoped = await fetchUi(`/-/admin/hooks/${f.scopedHookId}/replay/${f.orgDeliveryUuid}`, formPost(`/-/admin/hooks/${f.scopedHookId}/replay/${f.orgDeliveryUuid}`, f.adminCookie));
    expect(scoped.status).toBe(404);

    const stranger = await fetchUi(`/-/admin/hooks/${f.globalHookId}/replay/${f.globalDeliveryUuid}`, formPost(`/-/admin/hooks/${f.globalHookId}/replay/${f.globalDeliveryUuid}`, f.strangerCookie));
    expect(stranger.status).toBe(404); // adminPagePrologue's non-admin shell
  });

  it("the §2.8 origin guard runs first (a cross-origin POST never reaches the write)", async () => {
    const f = await ensureReplayFixtures();
    const before = (await drizzle(env.DB).select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(eq(webhookDeliveries.hookId, f.userHookId)).all()).length;
    const res = await fetchUi(`/user/settings/hooks/${f.userHookId}/replay/${f.userDeliveryUuid}`, formPost(`/user/settings/hooks/${f.userHookId}/replay/${f.userDeliveryUuid}`, f.ownerCookie, "https://evil.example"));
    expect(res.status).toBe(403); // sameOriginGuard's crossOriginRejected
    const after = (await drizzle(env.DB).select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(eq(webhookDeliveries.hookId, f.userHookId)).all()).length;
    expect(after).toBe(before); // no copy was written
  });
});

// --- the GET twins (chi's 405 posture) -----------------------------------------

describe("GET on the POST-only replay tails answers 405", () => {
  it("all four scopes", async () => {
    const f = await ensureReplayFixtures();
    for (const path of [
      `/replayowner/replayrepo/settings/hooks/${f.repoHookId}/replay/${f.repoDeliveryUuid}`,
      `/user/settings/hooks/${f.userHookId}/replay/${f.userDeliveryUuid}`,
      `/org/replayorg/settings/hooks/${f.orgHookId}/replay/${f.orgDeliveryUuid}`,
      `/-/admin/hooks/${f.globalHookId}/replay/${f.globalDeliveryUuid}`,
    ]) {
      const res = await fetchUi(path, withCookie(f.ownerCookie));
      expect(res.status, path).toBe(405);
      expect(res.headers.get("allow"), path).toBe("POST");
    }
  });
});
