/**
 * The ADMIN HOOKS page's matrix: the two-list load over the LANDED
 * global-hooks service (seeded through createGlobalHook — the same path the
 * API's adminCreateHook rides), the system/default split, and the render
 * contract: the two base_list sections in upstream order (System FIRST),
 * the status dot's three-class mapping, the name/URL plain-text rows (the
 * dead-link rule — the edit page is unlanded), the delete forms, and the
 * scoped thead / nav fold.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { users, webhooks } from "../../db/schema";
import { createGlobalHook } from "../../api/services/hooks";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { applyAdminHookDelete, AdminHooksPage, loadAdminHooksData } from "./admin-hooks";

const T0 = 1_700_000_000;
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "root", isAdmin: true };
const ctx: UiContext = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };

/** The base create payload (typed as the landed create arm's own option —
 *  the option type is service-private, so the parameter position carries
 *  it). */
const baseHook: Parameters<typeof createGlobalHook>[1] = {
  type: "gitea",
  config: { url: "https://hooks.example.test/ci", content_type: "json" },
  events: ["push"],
};

/** One system hook (the is_system_webhook config key — adminCreateHook's
 *  parsed arm) + two default hooks + one OWNER-scoped row that must never
 *  surface. Ids captured at seed time. */
async function seedHookWorld(): Promise<{ systemId: number; defaultA: number; defaultB: number }> {
  await drizzle(env.DB)
    .insert(users)
    .values([{ username: "hookowner", usernameLower: "hookowner", status: "active", createdAt: new Date(T0 * 1000) }])
    .run();
  const owner = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "hookowner")).get();
  if (owner === undefined) throw new Error("hook owner seed failed");

  const system = await createGlobalHook(env.DB, {
    ...baseHook,
    name: "system-wide",
    config: { ...baseHook.config, is_system_webhook: "true" },
  });
  const defaultA = await createGlobalHook(env.DB, { ...baseHook, name: "default-a" });
  const defaultB = await createGlobalHook(env.DB, {
    ...baseHook,
    name: "default-b",
    config: { url: "https://hooks.example.test/other", content_type: "json" },
  });
  // The owner-scoped twin — NOT a global row.
  await drizzle(env.DB)
    .insert(webhooks)
    .values({
      ownerId: owner.id,
      repoId: null,
      isSystemWebhook: false,
      url: "https://hooks.example.test/owned",
      name: "owned",
      httpMethod: "POST",
      contentType: 1,
      secret: "",
      events: "{}",
      isActive: false,
      type: "gitea",
      meta: "",
      createdAt: new Date(T0 * 1000),
      updatedAt: new Date(T0 * 1000),
    })
    .run();
  return { systemId: system.id, defaultA: defaultA.id, defaultB: defaultB.id };
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["users", "sessions", "webhooks", "webhook_deliveries"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("loadAdminHooksData — the system/default split", () => {
  it("splits the global rows by is_system_webhook; owner-scoped rows never surface; each list is id ASC", async () => {
    const ids = await seedHookWorld();
    const data = await loadAdminHooksData(env.DB);
    expect(data.systemHooks.map((hook) => hook.id)).toEqual([ids.systemId]);
    expect(data.defaultHooks.map((hook) => hook.id)).toEqual([ids.defaultA, ids.defaultB]);
    expect(data.defaultHooks.some((hook) => hook.name === "owned")).toBe(false);
  });

  it("answers two empty lists on a bare store", async () => {
    const data = await loadAdminHooksData(env.DB);
    expect(data.systemHooks).toEqual([]);
    expect(data.defaultHooks).toEqual([]);
  });
});

describe("applyAdminHookDelete — the DeleteDefaultOrSystemWebhook port", () => {
  it("deletes either kind of global row and reports the unknown-id arm", async () => {
    const ids = await seedHookWorld();
    expect(await applyAdminHookDelete(env.DB, ids.defaultA)).toBe(true);
    expect(await applyAdminHookDelete(env.DB, ids.systemId)).toBe(true);
    expect(await applyAdminHookDelete(env.DB, ids.defaultB)).toBe(true);
    expect(await applyAdminHookDelete(env.DB, ids.defaultA)).toBe(false);
    expect((await drizzle(env.DB).select().from(webhooks).all()).length).toBe(1); // the owner-scoped twin survives
  });
});

describe("the admin hooks DOM (admin/hooks.tmpl × base_list.tmpl at the pin)", () => {
  it("renders the pageClass, the two sections in upstream order (System first), the description lines, and the rows", async () => {
    const ids = await seedHookWorld();
    const data = await loadAdminHooksData(env.DB);
    const html = renderToString(<AdminHooksPage ctx={ctx} data={data} />);
    expect(html).toContain('class="page-content admin hooks"');
    // System FIRST (hooks.tmpl:2-3), then Default.
    expect(html.indexOf("System Webhooks")).toBeLessThan(html.indexOf("Default Webhooks"));
    expect(html).toContain("webhooks guide"); // the desc anchor text (both sections)
    expect(html).toContain('href="https://docs.gitea.com/usage/webhooks"');
    expect(html).toContain('<span title="https://hooks.example.test/ci">system-wide</span>');
    expect(html).toContain('<span title="https://hooks.example.test/ci">default-a</span>');
    // The delete forms ride the landed arm; the ids are the real rows'.
    expect(html.split('action="/-/admin/hooks/delete"').length - 1).toBe(3);
    expect(html).toContain(`value="${ids.systemId}"`);
    expect(html).not.toContain('value="owned"');
    // No dead controls: the name anchor targets the unlanded edit page →
    // plain text; the Add-Webhook dropdown is omitted.
    expect(html).not.toContain('href="/-/admin/hooks/'); // no per-hook edit links
    expect(html).not.toContain("Add Webhook");
    expect(html).not.toContain("/-/admin/default-hooks");
    expect(html).not.toContain("/-/admin/system-hooks");
  });

  it("renders the three status-dot classes over last_status and the Unnamed fallback", async () => {
    const ids = await seedHookWorld();
    await drizzle(env.DB).update(webhooks).set({ lastStatus: 1 }).where(eq(webhooks.id, ids.defaultA));
    await drizzle(env.DB).update(webhooks).set({ lastStatus: 2 }).where(eq(webhooks.id, ids.defaultB));
    await drizzle(env.DB).update(webhooks).set({ lastStatus: 0, name: "" }).where(eq(webhooks.id, ids.systemId));
    const html = renderToString(<AdminHooksPage ctx={ctx} data={await loadAdminHooksData(env.DB)} />);
    expect(html).toContain("tw-text-green");
    expect(html).toContain("tw-text-red");
    expect(html).toContain("tw-text-text-light");
    expect(html).toContain("Unnamed Webhook"); // repo.settings.webhook.name_empty
  });

  it("renders the empty-list lines and NO pager (upstream base_list pages nothing)", async () => {
    const html = renderToString(<AdminHooksPage ctx={ctx} data={await loadAdminHooksData(env.DB)} />);
    expect(html).toContain("No webhooks yet.");
    expect(html).not.toContain('class="center page buttons"');
  });

  it("every th carries scope=col and the nav renders the landed arms (Integrations open, Webhooks active)", async () => {
    await seedHookWorld();
    const html = renderToString(<AdminHooksPage ctx={ctx} data={await loadAdminHooksData(env.DB)} />);
    expect(html).not.toMatch(/<th(?![^>]*scope=)[^>]*>/); // base_list carries NO th at all (the rows are a divided list)
    expect(html).toContain('class="active item" href="/-/admin/hooks"');
    expect(html).toContain('href="/-/admin/applications"');
    expect(html).toContain('href="/-/admin/emails"');
    // The EXTERNAL AUTH W4 arm landed: the auths item LEFT the omission
    // list (specs/external-auth-sources.md §6.4 — navbar.tmpl:19's first
    // Identity & Access entry).
    expect(html).toContain('href="/-/admin/auths"');
  });
});
