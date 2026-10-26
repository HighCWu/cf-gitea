/**
 * The repo settings HOOKS family's deferred matrix (the module MOUNTED since
 * the early waves — pages/settings.tsx over ui/index.ts's wave-10 list arms
 * + wave-14 per-hook arms: GET+POST /{owner}/{repo}/settings/hooks, GET+POST
 * /{owner}/{repo}/settings/hooks/{id}, POST /{id}/test, POST /{id}/delete):
 * the route-level arms the wave-4 list block and the wave-14 per-hook block
 * left open, driven through the REAL routes on the deploy-keys 0b8d2bc
 * matrix's minted-session pattern.
 *
 * Deliberately NOT re-covered here (checked first — no duplication): the
 * list page's render + create hit/miss with the carried form + the anon /
 * non-admin / cross-origin gates on its GET (pages-wave4.test.ts), the
 * per-hook page's render + hidden-events semantics, the edit/test/delete
 * hits + their 404 misses + the empty-repo test-fire 303 no-fire quirk
 * (pages-wave14.test.ts), the settings-family claim pins (wave-14 + the
 * basics matrix). This file adds only the open arms:
 *
 *   - the write gates BEFORE any write on all three POST families: an
 *     anonymous same-origin POST 303s onto the login round-trip carrying
 *     the REQUESTED path (the settingsGate's loginRedirect(url.pathname)
 *     — pinned verbatim), a signed-in non-admin 404-shells — each with the
 *     stored rows proven untouched through D1 reads,
 *   - the guard-first cross-origin 403 on the test-fire and delete POSTs
 *     (the list POST's and edit POST's 403s are the wave-4/wave-14 blocks'),
 *     each with zero side-effects,
 *   - the site-admin's list GET (the gate's other admit — the wave-4 block
 *     rides the owner only; the wave-14 block rides the detail page only).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createRepoHook } from "../../api/services/hooks";
import { repositories, users, webhookDeliveries, webhooks } from "../../db/schema";
import { uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { RepoRow } from "../ui-context";
import type { UiManifest } from "../manifest";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

let repo: RepoRow;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // Child-first (the deliveries ride the hooks, the hooks ride the repo).
  for (const table of ["webhook_deliveries", "webhooks", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  repo = await seedRepo("demo");
});

async function seedRepo(slug: string): Promise<RepoRow> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'alice', 1, ?, 'main', 'public', unixepoch())",
  )
    .bind(slug)
    .run();
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
  if (row === undefined) throw new Error("fixture repository missing");
  return row;
}

/** The stored webhook rows of the seeded repo (the gate arms' untouched
 *  witnesses — full triple per row). */
async function storedHooks(): Promise<Array<{ name: string; url: string; isActive: boolean }>> {
  const rows = await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.repoId, repo.id)).all();
  return rows.map((row) => ({ name: row.name, url: row.url, isActive: row.isActive }));
}

/** The delivery rows keyed to the repo's hooks (the test-fire arm's
 *  nothing-fired witness). */
async function storedDeliveryCount(): Promise<number> {
  const rows = await drizzle(env.DB).select({ id: webhookDeliveries.id }).from(webhookDeliveries).all();
  return rows.length;
}

/** A seeded hook created through the landed service (the wave-14 fixture's
 *  shape) — the per-hook arms' target. */
async function seedHook(url: string, name = "seeded hook"): Promise<number> {
  const hook = await createRepoHook(env.DB, repo.id, {
    type: "gitea",
    name,
    config: { url, content_type: "json" },
    active: true,
  });
  return hook.id;
}

/** A second plain user (the signed-in non-admin posture) or a site admin
 *  (the gate's other admit) — ids are seed-assigned, never hardcoded. */
async function seedUser(username: string, isAdmin = false): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  return row.id;
}

// --- the mounted-route harness (the deploy-keys 0b8d2bc minted-session
// --- pattern) ----------------------------------------------------------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → resolveUiRequest →
 *  the settingsGate → the arm, on the mounted uiRouter with the synthetic
 *  manifest; the execution context is awaited so waitUntil side-effects
 *  settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the user id (the real mintSession
 *  path, minted per request — the beforeEach users wipe cascades the
 *  sessions table, so a cross-test cache would go stale; the value is never
 *  rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** The seeded owner's minted session header (the settingsGate's
 *  isRepositoryAdmin admit). */
async function ownerSessionHeader(): Promise<string> {
  const owner = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get();
  if (owner === undefined) throw new Error("fixture owner missing");
  return sessionHeader(owner.id);
}

/** A urlencoded POST with an EXPLICIT cookie header (or none — the anonymous
 *  arms) and an explicit Origin (the §2.8 guard's input). */
async function postAs(path: string, fields: Record<string, string>, cookie: string | null, origin = ORIGIN): Promise<Response> {
  return fetchUi(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      ...(cookie === null ? {} : { cookie }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

// --- the list write's open gates (POST /{owner}/{repo}/settings/hooks) --------

describe("the list create write's open gates (POST /{owner}/{repo}/settings/hooks)", () => {
  const VALID_CREATE = { name: "anon-hook", payload_url: "https://hooks.example.com/anon", content_type: "json" };

  it("303s an anonymous same-origin POST onto the login round-trip carrying the requested path (guard passes, then the gate; nothing written)", async () => {
    await seedHook("https://hooks.example.com/witness");
    const res = await postAs("/alice/demo/settings/hooks", VALID_CREATE, null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/alice/demo/settings/hooks")}`);
    expect(await storedHooks()).toEqual([{ name: "seeded hook", url: "https://hooks.example.com/witness", isActive: true }]);
  });

  it("404-shells a signed-in non-admin's POST before any write (the gate fronts the create arm too)", async () => {
    await seedHook("https://hooks.example.com/witness");
    const bob = await seedUser("bob");
    const res = await postAs("/alice/demo/settings/hooks", VALID_CREATE, await sessionHeader(bob));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error"); // the 404 shell
    expect(html).not.toContain("repository settings"); // never the tab's content
    expect(await storedHooks()).toEqual([{ name: "seeded hook", url: "https://hooks.example.com/witness", isActive: true }]);
  });
});

// --- the list read's open admit (GET — the site admin) -------------------------

describe("the site-admin's list GET (GET /{owner}/{repo}/settings/hooks)", () => {
  it("answers the gate's other admit at 200 with the discriminator, the row and the add form", async () => {
    const hookId = await seedHook("https://hooks.example.com/visible");
    const root = await seedUser("root", true);
    const res = await fetchUi("/alice/demo/settings/hooks", { headers: { cookie: await sessionHeader(root) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content repository settings webhooks"); // the §2.4.1 discriminator
    expect(html).toContain('class="active item" href="/alice/demo/settings/hooks">Webhooks</a>');
    expect(html).toContain(`href="/alice/demo/settings/hooks/${hookId}"`); // the row's edit anchor
    expect(html).toContain(">seeded hook</a>");
    expect(html).toContain('action="/alice/demo/settings/hooks" method="post"'); // the add form
  });
});

// --- the edit write's open gates (POST /{owner}/{repo}/settings/hooks/{id}) ----

describe("the edit write's open gates (POST /{owner}/{repo}/settings/hooks/{id})", () => {
  const HIJACK = { name: "hijacked", payload_url: "https://hooks.example.com/evil", content_type: "json" };

  it("303s an anonymous same-origin POST onto the login round-trip carrying the per-hook path (nothing written)", async () => {
    const hookId = await seedHook("https://hooks.example.com/untouched");
    const res = await postAs(`/alice/demo/settings/hooks/${hookId}`, HIJACK, null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/alice/demo/settings/hooks/${hookId}`)}`,
    );
    expect(await storedHooks()).toEqual([{ name: "seeded hook", url: "https://hooks.example.com/untouched", isActive: true }]);
  });

  it("404-shells a signed-in non-admin's POST before any write (the stored row is untouched)", async () => {
    const hookId = await seedHook("https://hooks.example.com/untouched");
    const bob = await seedUser("bob");
    const res = await postAs(`/alice/demo/settings/hooks/${hookId}`, HIJACK, await sessionHeader(bob));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(await storedHooks()).toEqual([{ name: "seeded hook", url: "https://hooks.example.com/untouched", isActive: true }]);
  });
});

// --- the test-fire write's open gate (POST /{owner}/{repo}/settings/hooks/{id}/test)

describe("the test-fire write's open gate (POST /{owner}/{repo}/settings/hooks/{id}/test)", () => {
  it("rejects a cross-origin POST with 403 before any fire (sameOriginGuard first; zero delivery rows)", async () => {
    const hookId = await seedHook("https://hooks.example.com/nofire");
    const res = await postAs(`/alice/demo/settings/hooks/${hookId}/test`, {}, await ownerSessionHeader(), "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await storedDeliveryCount()).toBe(0); // nothing fired
    expect(await storedHooks()).toHaveLength(1); // the hook is untouched
  });
});

// --- the delete write's open gates (POST /{owner}/{repo}/settings/hooks/{id}/delete)

describe("the delete write's open gates (POST /{owner}/{repo}/settings/hooks/{id}/delete)", () => {
  it("303s an anonymous same-origin delete POST onto the login round-trip carrying the requested DELETE tail (nothing written)", async () => {
    const hookId = await seedHook("https://hooks.example.com/survivor");
    const res = await postAs(`/alice/demo/settings/hooks/${hookId}/delete`, {}, null);
    expect(res.status).toBe(303);
    // The round-trip carries the REQUESTED path (the delete tail) — the
    // settingsGate's loginRedirect(url.pathname), the deploy-keys anon arm's pin.
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/alice/demo/settings/hooks/${hookId}/delete`)}`,
    );
    expect(await storedHooks()).toEqual([{ name: "seeded hook", url: "https://hooks.example.com/survivor", isActive: true }]);
  });

  it("404-shells a signed-in non-admin's delete POST before any write (the hook survives)", async () => {
    const hookId = await seedHook("https://hooks.example.com/survivor");
    const bob = await seedUser("bob");
    const res = await postAs(`/alice/demo/settings/hooks/${hookId}/delete`, {}, await sessionHeader(bob));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(await storedHooks()).toEqual([{ name: "seeded hook", url: "https://hooks.example.com/survivor", isActive: true }]);
  });

  it("rejects a cross-origin delete POST with 403 before any write (sameOriginGuard first)", async () => {
    const hookId = await seedHook("https://hooks.example.com/still-here");
    const res = await postAs(`/alice/demo/settings/hooks/${hookId}/delete`, {}, await ownerSessionHeader(), "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await storedHooks()).toEqual([{ name: "seeded hook", url: "https://hooks.example.com/still-here", isActive: true }]);
  });
});
