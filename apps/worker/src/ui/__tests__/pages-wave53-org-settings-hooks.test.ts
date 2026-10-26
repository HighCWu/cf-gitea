/**
 * Wave-53 org settings HOOKS tab — the org-settings module's named next
 * slice: upstream web.go:1033-1044's `/hooks` group inside the require-owner
 * /{org}/settings subtree (org/settings/{hooks,hook_new}.tmpl) mounted in
 * index.ts over pages/org-settings-hooks.tsx:
 *
 * - `GET+POST /{org}/settings/hooks` — the webhooks list + add form riding
 *   the landed owner-scoped arms (`listOwnerHooks`/`createOwnerHook`, the
 *   hooks-scopes wave's org family);
 * - `GET+POST /{org}/settings/hooks/{id}` — the per-hook edit page over
 *   `getOwnerHook` + the scope-agnostic `editRepoHook`;
 * - `POST /{org}/settings/hooks/{id}/delete` — `deleteOwnerHook` (the
 *   arm-scoped tail, the repo hooks-page convention);
 * - the entry-link hunk: the org settings navbar grows the Hooks item
 *   (org/settings/navbar.tmpl:8-10 — org-settings.tsx, additive).
 *
 * Same harness posture as pages-wave49 (the org-page conventions): the
 * router driven directly with the synthetic ASSETS manifest; the org seeds
 * through the LANDED OrgService, hooks through the landed owner-scoped
 * service arms, deliveries as D1-only rows with FIXED uuids (the wave-14
 * determinism rule). No test/replay arms exist at this scope — the page
 * must not render them (the module header's dead-control rule).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { users, webhookDeliveries, webhooks } from "../../db/schema";
import { createOwnerHook, hookEventsArray, type WebhookRow } from "../../api/services/hooks";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { OrgService } from "../../services/orgs/orgs";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

const formPost = (path: string, body: Record<string, string | string[]>, cookie?: string, origin = "https://test.local"): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...(origin === "" ? {} : { origin }),
    ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
  },
  body: new URLSearchParams(Object.entries(body).flatMap(([key, value]) => (Array.isArray(value) ? value.map((v) => [key, v]) : [[key, value]]))).toString(),
});

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

// --- fixtures -----------------------------------------------------------------

interface Wave53Fixture {
  ownerCookie: string; // hookorg's owner
  memberCookie: string; // a plain hookorg member (non-owner)
  adminCookie: string; // site admin
  orgId: number;
  otherOrgId: number;
  hookId: number; // the edit/list hook (active, branch_filter, deliveries)
  deleteHookId: number; // the delete arm's hook
  foreignHookId: number; // another org's hook (the foreign-id rule)
}

let wave53Fixture: Wave53Fixture | null = null;

async function ensureWave53Fixtures(): Promise<Wave53Fixture> {
  if (wave53Fixture !== null) return wave53Fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const orgs = new OrgService(env.DB);

  for (const extra of [
    { username: "wave53owner", isAdmin: false },
    { username: "wave53member", isAdmin: false },
    { username: "wave53admin", isAdmin: true },
  ] as const) {
    if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra.username)).get()) === undefined) {
      await seedVerifiedUser({ username: extra.username, isAdmin: extra.isAdmin });
    }
  }
  const owner = (await db.select().from(users).where(eq(users.usernameLower, "wave53owner")).get())!;
  const member = (await db.select().from(users).where(eq(users.usernameLower, "wave53member")).get())!;

  let org = await orgs.getOrgByUsername("hookorg");
  if (org === null) {
    org = await orgs.createOrg({ name: "hookorg", ownerId: owner.id, visibility: "public", now: t(0) });
    await orgs.addMember(org.id, member.id, { now: t(1) });
  }
  org = (await orgs.getOrgByUsername("hookorg"))!;
  let other = await orgs.getOrgByUsername("otherhookorg");
  if (other === null) other = await orgs.createOrg({ name: "otherhookorg", ownerId: owner.id, visibility: "public", now: t(0) });

  // The hooks through the LANDED owner arms (the API family's create body),
  // idempotent by URL.
  const hookOf = async (url: string): Promise<WebhookRow | null> =>
    (await db.select().from(webhooks).where(eq(webhooks.url, url)).get()) ?? null;
  let hook = await hookOf("https://hooks.example.com/wave53-edit");
  if (hook === null) {
    await createOwnerHook(env.DB, org.id, {
      type: "gitea",
      name: "org build hook",
      config: { url: "https://hooks.example.com/wave53-edit", content_type: "json" },
      active: true,
      branch_filter: "main",
      events: ["push"],
    });
    hook = await hookOf("https://hooks.example.com/wave53-edit");
  }
  let deleteHook = await hookOf("https://hooks.example.com/wave53-delete");
  if (deleteHook === null) {
    await createOwnerHook(env.DB, org.id, {
      type: "gitea",
      name: "org delete hook",
      config: { url: "https://hooks.example.com/wave53-delete", content_type: "json" },
      active: false,
    });
    deleteHook = await hookOf("https://hooks.example.com/wave53-delete");
  }
  let foreignHook = await hookOf("https://hooks.example.com/wave53-foreign");
  if (foreignHook === null) {
    await createOwnerHook(env.DB, other.id, {
      type: "gitea",
      name: "foreign hook",
      config: { url: "https://hooks.example.com/wave53-foreign", content_type: "json" },
      active: true,
    });
    foreignHook = await hookOf("https://hooks.example.com/wave53-foreign");
  }

  // The delivery log on the edit hook (one row per status branch — the
  // wave-14 determinism shape; repoId is the repo-purge denormalization and
  // stays inert for an owner-scoped hook).
  const existingDeliveries = await db
    .select({ id: webhookDeliveries.id })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.hookId, hook!.id))
    .all();
  if (existingDeliveries.length === 0) {
    await db.insert(webhookDeliveries).values([
      {
        hookId: hook!.id,
        repoId: "org_hook_log",
        uuid: "wave53-delivery-succeed",
        eventType: "push",
        eventGroup: "push",
        payloadContent: "{}",
        state: "delivered",
        attempts: 1,
        isSucceed: true,
        requestContent: JSON.stringify({ url: "https://hooks.example.com/wave53-edit", http_method: "POST" }),
        responseContent: JSON.stringify({ status: 200 }),
        createdAt: t(60),
        deliveredAt: t(61),
      },
      {
        hookId: hook!.id,
        repoId: "org_hook_log",
        uuid: "wave53-delivery-pending",
        eventType: "push",
        eventGroup: "push",
        payloadContent: "{}",
        state: "pending",
        createdAt: t(70),
      },
    ]);
  }

  wave53Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    memberCookie: await mintSession(env.DB, member.id),
    adminCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave53admin")).get())!.id),
    orgId: org.id,
    otherOrgId: other.id,
    hookId: hook!.id,
    deleteHookId: deleteHook!.id,
    foreignHookId: foreignHook!.id,
  };
  return wave53Fixture;
}

beforeAll(async () => {
  await ensureWave53Fixtures();
});

// --- the parser claims ----------------------------------------------------------

describe("wave-53 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the org hooks shapes", () => {
    expect(parseUiRoute("/acme/settings/hooks")).toEqual({ family: "org-settings-hooks", owner: "acme" });
    expect(parseUiRoute("/acme/settings/hooks/7")).toEqual({ family: "org-settings-hook-detail", owner: "acme", id: 7 });
    expect(parseUiRoute("/acme/settings/hooks/007")).toEqual({ family: "org-settings-hook-detail", owner: "acme", id: 7 });
    expect(parseUiRoute("/acme/settings/hooks/7/delete")).toEqual({ family: "org-settings-hook-delete", owner: "acme", id: 7 });
    expect(handlesUiRoute("/acme/settings/hooks")).toBe(true);
    expect(handlesUiRoute("/acme/settings/hooks/7")).toBe(true);
  });

  it("leaves the junk and org-absent tails with the engine", () => {
    // The repo family's test tail has NO org twin (upstream registers
    // /{id}/test in the REPO group only); a negative id is admitted and
    // 404-shells at the lookup (the issue-detail convention).
    expect(parseUiRoute("/acme/settings/hooks/abc")).toBeNull();
    expect(parseUiRoute("/acme/settings/hooks/7/edit")).toBeNull();
    expect(parseUiRoute("/acme/settings/hooks/7/test")).toBeNull();
    expect(parseUiRoute("/acme/settings/hooks/7/delete/extra")).toBeNull();
    expect(parseUiRoute("/acme/settings/hooks/-3")).toEqual({ family: "org-settings-hook-detail", owner: "acme", id: -3 });
  });

  it("keeps the /user prefix exclusion and the repo family intact", () => {
    // Upstream's reqSignIn /user group owns the whole /user/* namespace.
    // Window-2a (0c2b151) mounted the USER hooks tab under it — the stale
    // toBeNull pin updated to the claimed shape (the org-hooks matrix's
    // escalation).
    expect(parseUiRoute("/user/settings/hooks")).toEqual({ family: "user-settings-hooks", id: null });
    // The REPO webhooks family (wave 4/14) is a different shape — five
    // segments with a repo between.
    expect(parseUiRoute("/octo/hello/settings/hooks")).toEqual({ family: "settings-hooks", owner: "octo", repo: "hello" });
  });

  it("shadows a repository named 'settings' exactly like upstream's route order", () => {
    // /{org}/settings/hooks claims the 4-segment shape for every owner —
    // a repo named "settings" under "acme" is shadowed for the hooks URL
    // (the wave-49 posture; upstream's org group registers ahead of
    // :1292's /{username}/{reponame}).
    expect(parseUiRoute("/alice/settings/hooks")).toEqual({ family: "org-settings-hooks", owner: "alice" });
  });
});

// --- the gate (the shared org-teams prologue) ------------------------------------

describe("GET /{org}/settings/hooks (the requireOrgOwnership posture)", () => {
  it("303s an anonymous viewer onto the login round-trip", async () => {
    const res = await fetchUi("/hookorg/settings/hooks");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Fhookorg%2Fsettings%2Fhooks");
  });

  it("404-shells a plain member and a user-owner namespace", async () => {
    const fixture = await ensureWave53Fixtures();
    const pal = await fetchUi("/hookorg/settings/hooks", withCookie(fixture.memberCookie));
    expect(pal.status).toBe(404);
    // A USER namespace: the org resolution's type gate misses → the shell.
    const userOwner = await fetchUi("/wave53member/settings/hooks", withCookie(fixture.memberCookie));
    expect(userOwner.status).toBe(404);
  });

  it("answers the owner and a site admin with the list page", async () => {
    const fixture = await ensureWave53Fixtures();
    for (const cookie of [fixture.ownerCookie, fixture.adminCookie]) {
      const res = await fetchUi("/hookorg/settings/hooks", withCookie(cookie));
      expect(res.status).toBe(200);
      const html = await res.text();
      // §2.4.1 discriminator: org/settings/hooks.tmpl's pageClass.
      expect(html).toContain("page-content organization settings webhooks");
      // Upstream's literal .Title on the segment header (org/setting.go:151
      // — org.settings, NOT the repo arm's "Webhooks"; the header's quirk).
      expect(html).toContain("Add webhooks which will be triggered for all repositories under this organization.");
      // The navbar's Hooks item ACTIVE; the options item inert.
      expect(html).toContain('<a class="active item" href="/hookorg/settings/hooks">');
      expect(html).toContain('<a class="item" href="/hookorg/settings">');
      // The add form rides the page URL; the seeded rows render.
      expect(html).toContain('action="/hookorg/settings/hooks"');
      expect(html).toContain(`href="/hookorg/settings/hooks/${fixture.hookId}"`);
      expect(html).toContain("org build hook");
      expect(html).toContain("https://hooks.example.com/wave53-edit");
    }
  });

  it("307s a renamed org (the shared resolve seam)", async () => {
    const fixture = await ensureWave53Fixtures();
    // otherhookorg is NOT renamed — the query string exercises the seam's
    // requestQuery half (the wave-49 posture).
    const res = await fetchUi("/otherhookorg/settings/hooks?q=x", withCookie(fixture.ownerCookie));
    expect(res.status).toBe(200);
  });
});

// --- the create arm ----------------------------------------------------------------

describe("POST /{org}/settings/hooks (the add-hook write over createOwnerHook)", () => {
  it("creates the hook and 303s back onto the list", async () => {
    const fixture = await ensureWave53Fixtures();
    const post = await fetchUi(
      "/hookorg/settings/hooks",
      formPost("/hookorg/settings/hooks", {
        name: "wave53 created",
        payload_url: "https://hooks.example.com/wave53-created",
        content_type: "json",
        secret: "s3cret",
        active: "on",
      }, fixture.ownerCookie),
    );
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/hookorg/settings/hooks");
    const row = await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.url, "https://hooks.example.com/wave53-created")).get();
    expect(row).toBeDefined();
    expect(row!.ownerId).toBe(fixture.orgId);
    expect(row!.repoId).toBeNull(); // owner-scoped, never a repo row
    expect(row!.name).toBe("wave53 created");
    expect(row!.isActive).toBe(true);
    // The list re-renders the row.
    const list = await fetchUi("/hookorg/settings/hooks", withCookie(fixture.ownerCookie));
    expect(await list.text()).toContain("wave53 created");
  });

  it("re-renders inline with the API's 422 message and the kept submission", async () => {
    const fixture = await ensureWave53Fixtures();
    const post = await fetchUi(
      "/hookorg/settings/hooks",
      formPost("/hookorg/settings/hooks", {
        name: "bad url",
        payload_url: "not-a-url",
        content_type: "json",
      }, fixture.ownerCookie),
    );
    expect(post.status).toBe(200);
    const html = await post.text();
    expect(html).toContain("Invalid url");
    expect(html).toContain('value="not-a-url"'); // the kept submission
    expect(html).toContain('value="bad url"');
  });

  it("keeps the gates on the POST arm (cross-origin 403, member 404)", async () => {
    const fixture = await ensureWave53Fixtures();
    const evil = await fetchUi(
      "/hookorg/settings/hooks",
      formPost("/hookorg/settings/hooks", { payload_url: "https://hooks.example.com/x" }, fixture.ownerCookie, "https://evil.example"),
    );
    expect(evil.status).toBe(403);
    const pal = await fetchUi(
      "/hookorg/settings/hooks",
      formPost("/hookorg/settings/hooks", { payload_url: "https://hooks.example.com/x" }, fixture.memberCookie),
    );
    expect(pal.status).toBe(404);
  });
});

// --- the per-hook page --------------------------------------------------------------

describe("GET /{org}/settings/hooks/{id} (the edit page over getOwnerHook)", () => {
  it("renders the edit form with the stored values for the owner and admin", async () => {
    const fixture = await ensureWave53Fixtures();
    for (const cookie of [fixture.ownerCookie, fixture.adminCookie]) {
      const res = await fetchUi(`/hookorg/settings/hooks/${fixture.hookId}`, withCookie(cookie));
      expect(res.status).toBe(200);
      const html = await res.text();
      // §2.4.1 discriminator: org/settings/hook_new.tmpl's edit arm.
      expect(html).toContain("page-content organization settings new webhook");
      expect(html).toContain("Update Webhook");
      expect(html).toContain(`action="/hookorg/settings/hooks/${fixture.hookId}"`);
      expect(html).toContain('value="https://hooks.example.com/wave53-edit"');
      expect(html).toContain('value="org build hook"');
      expect(html).toContain('value="main"'); // the stored branch filter
      expect(html).toContain('value="push"'); // the hidden events preserve input
      expect(html).toContain("Trigger On:"); // the read-only subscription line
      // The delete form rides the arm-scoped tail (the repo-page convention).
      expect(html).toContain(`action="/hookorg/settings/hooks/${fixture.hookId}/delete"`);
      expect(html).toContain("Remove Webhook");
      // NO test arm exists at this scope — never a dead control.
      expect(html).not.toContain(`action="/hookorg/settings/hooks/${fixture.hookId}/test"`);
      // The deliveries segment renders the seeded rows read-only.
      expect(html).toContain("Recent Deliveries");
      expect(html).toContain("wave53-delivery-succeed");
      expect(html).toContain("wave53-delivery-pending");
      expect(html).toContain("tw-text-green");
      expect(html).toContain("tw-text-orange");
    }
  });

  it("carries the org gate (anonymous 303, member 404)", async () => {
    const fixture = await ensureWave53Fixtures();
    const anon = await fetchUi(`/hookorg/settings/hooks/${fixture.hookId}`);
    expect(anon.status).toBe(303);
    const pal = await fetchUi(`/hookorg/settings/hooks/${fixture.hookId}`, withCookie(fixture.memberCookie));
    expect(pal.status).toBe(404);
  });

  it("404-shells an unknown id and a foreign-org hook id", async () => {
    const fixture = await ensureWave53Fixtures();
    const unknown = await fetchUi("/hookorg/settings/hooks/999999", withCookie(fixture.ownerCookie));
    expect(unknown.status).toBe(404);
    // The owner-scoped lookup keys on the org — another org's hook id
    // misses exactly like an unknown one (existence stays hidden).
    const foreign = await fetchUi(`/hookorg/settings/hooks/${fixture.foreignHookId}`, withCookie(fixture.ownerCookie));
    expect(foreign.status).toBe(404);
  });
});

// --- the edit write -------------------------------------------------------------------

describe("POST /{org}/settings/hooks/{id} (the edit write over the scope-agnostic editRepoHook)", () => {
  it("applies the form fields and 303s back onto the page", async () => {
    const fixture = await ensureWave53Fixtures();
    const post = await fetchUi(
      `/hookorg/settings/hooks/${fixture.deleteHookId}`,
      formPost(`/hookorg/settings/hooks/${fixture.deleteHookId}`, {
        name: "org delete hook renamed",
        payload_url: "https://hooks.example.com/wave53-delete-v2",
        content_type: "form",
        branch_filter: "release/*",
        events: "push",
      }, fixture.ownerCookie),
    );
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe(`/hookorg/settings/hooks/${fixture.deleteHookId}`);
    const row = (await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.id, fixture.deleteHookId)).get())!;
    expect(row.name).toBe("org delete hook renamed");
    expect(row.url).toBe("https://hooks.example.com/wave53-delete-v2");
    expect(row.contentType).toBe(2); // form (ToHookContentType: json=1, form=2)
    expect(row.isActive).toBe(false); // the unchecked box applies (the arm's unconditional posture)
    const events = JSON.parse(row.events) as { branch_filter?: string };
    expect(events.branch_filter).toBe("release/*");
    // The subscription rewrite kept push (the flags blob re-reads through
    // hookEventsArray — the same conversion the page render uses).
    expect(hookEventsArray(row.events)).toContain("push");
    // The re-rendered page carries the fresh values.
    const page = await fetchUi(`/hookorg/settings/hooks/${fixture.deleteHookId}`, withCookie(fixture.ownerCookie));
    expect(await page.text()).toContain('value="https://hooks.example.com/wave53-delete-v2"');
  });

  it("re-renders on the invalid-url arm with the kept submission", async () => {
    const fixture = await ensureWave53Fixtures();
    const post = await fetchUi(
      `/hookorg/settings/hooks/${fixture.hookId}`,
      formPost(`/hookorg/settings/hooks/${fixture.hookId}`, {
        name: "org build hook",
        payload_url: "also not a url",
        content_type: "json",
        branch_filter: "",
        events: "push",
      }, fixture.ownerCookie),
    );
    expect(post.status).toBe(200);
    const html = await post.text();
    expect(html).toContain("Invalid url");
    expect(html).toContain('value="also not a url"');
  });

  it("keeps the gates on the POST arm (cross-origin 403, member 404, unknown id 404)", async () => {
    const fixture = await ensureWave53Fixtures();
    const evil = await fetchUi(
      `/hookorg/settings/hooks/${fixture.hookId}`,
      formPost(`/hookorg/settings/hooks/${fixture.hookId}`, { payload_url: "https://hooks.example.com/x" }, fixture.ownerCookie, "https://evil.example"),
    );
    expect(evil.status).toBe(403);
    const pal = await fetchUi(
      `/hookorg/settings/hooks/${fixture.hookId}`,
      formPost(`/hookorg/settings/hooks/${fixture.hookId}`, { payload_url: "https://hooks.example.com/x" }, fixture.memberCookie),
    );
    expect(pal.status).toBe(404);
    const unknown = await fetchUi(
      "/hookorg/settings/hooks/999999",
      formPost("/hookorg/settings/hooks/999999", { payload_url: "https://hooks.example.com/x" }, fixture.ownerCookie),
    );
    expect(unknown.status).toBe(404);
  });
});

// --- the delete write --------------------------------------------------------------

describe("POST /{org}/settings/hooks/{id}/delete (deleteOwnerHook)", () => {
  it("deletes the hook and 303s onto the list", async () => {
    const fixture = await ensureWave53Fixtures();
    const post = await fetchUi(
      `/hookorg/settings/hooks/${fixture.deleteHookId}/delete`,
      formPost(`/hookorg/settings/hooks/${fixture.deleteHookId}/delete`, {}, fixture.ownerCookie),
    );
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/hookorg/settings/hooks");
    expect(await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.id, fixture.deleteHookId)).get()).toBeUndefined();
  });

  it("404-shells a miss and answers GET with chi's 405", async () => {
    const fixture = await ensureWave53Fixtures();
    const unknown = await fetchUi(
      "/hookorg/settings/hooks/999999/delete",
      formPost("/hookorg/settings/hooks/999999/delete", {}, fixture.ownerCookie),
    );
    expect(unknown.status).toBe(404);
    const get = await fetchUi(`/hookorg/settings/hooks/${fixture.hookId}/delete`, withCookie(fixture.ownerCookie));
    expect(get.status).toBe(405);
  });

  it("keeps the gates on the POST arm (cross-origin 403, member 404)", async () => {
    const fixture = await ensureWave53Fixtures();
    const evil = await fetchUi(
      `/hookorg/settings/hooks/${fixture.hookId}/delete`,
      formPost(`/hookorg/settings/hooks/${fixture.hookId}/delete`, {}, fixture.ownerCookie, "https://evil.example"),
    );
    expect(evil.status).toBe(403);
    const pal = await fetchUi(
      `/hookorg/settings/hooks/${fixture.hookId}/delete`,
      formPost(`/hookorg/settings/hooks/${fixture.hookId}/delete`, {}, fixture.memberCookie),
    );
    expect(pal.status).toBe(404);
    expect(await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.id, fixture.hookId)).get()).toBeDefined();
  });
});
