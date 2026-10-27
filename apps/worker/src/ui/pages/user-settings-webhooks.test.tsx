/**
 * The user settings WEBHOOKS tab's tests (the bench-row UNMOUNTED module —
 * the repo-settings-wiki.test.tsx harness): the list/read/create/edit/delete
 * arms over real D1 (generated migrations in beforeAll; the writes go
 * through the landed owner-scoped service arms, the same calls the
 * hooks-scopes wave's /user/hooks routes make) and the DOM contract of the
 * two page renders — hono/jsx renderToString, the modules driven directly
 * (no route yet, the HANDOFF NOTE in the module header).
 *
 * ## The deferred matrix (wave-83 — the module is MOUNTED at ui/index.ts)
 *
 * The mount (window-2a: GET+POST /user/settings/hooks, GET+POST /:id,
 * POST /:id/delete) un-defers the route-level arms; they drive the mounted
 * uiRouter the production way (parse → resolveUiSession → load → render —
 * the user-settings-appearance.test.tsx window harness):
 *
 *   - the mounted write/read arms (create 303 + the 422 re-render with the
 *     kept submission, edit 303, delete hit 303 list vs miss 404);
 *   - the hidden events preserve inputs riding the PATCH rewrite on the
 *     wire (a form carrying `events=push&events=create` survives; a bare
 *     form resets to push-only — the shared editHook's unconditional
 *     rewrite, asserted through the parse's SUBSCRIPTION_ORDER order);
 *   - the foreign-owner 404s (detail + edit + delete — existence hidden);
 *   - the parse claim split: an unknown NUMERIC id is claimed and 404-shells
 *     through the loader, a NON-NUMERIC segment stays unclaimed
 *     (parseUiRoute null → the dispatcher never hands it to this router →
 *     the engine's 404; asserted at the parse, never by fetching the
 *     sub-app directly — Hono's `:id` would match the junk segment and
 *     misrepresent production).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { users, webhookDeliveries, webhooks } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  createUserHookFromForm,
  deleteUserHook,
  editUserHookFromForm,
  loadUserHookDetailData,
  loadUserSettingsHooksPageData,
  parseCreateHookForm,
  parseHookEditForm,
  renderUserHookDetailPage,
  renderUserSettingsHooksPage,
  userSettingsWebhooksLocale,
  UserHookDetailPage,
  UserHooksSettingsPage,
} from "./user-settings-webhooks";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

let selfViewer: Viewer = { kind: "user", id: 0, username: "alice", isAdmin: false };

const ctx: UiContext = {
  viewer: selfViewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

let alice: typeof users.$inferSelect;
let bob: typeof users.$inferSelect;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["webhook_deliveries", "webhooks", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const db = drizzle(env.DB);
  const seeded = await db
    .insert(users)
    .values([
      { username: "alice", usernameLower: "alice", isAdmin: false, status: "active", createdAt: new Date("2026-01-01T00:00:00Z") },
      { username: "bob", usernameLower: "bob", isAdmin: false, status: "active", createdAt: new Date("2026-01-01T00:00:00Z") },
    ])
    .returning()
    .all();
  const a = seeded.find((row) => row.username === "alice");
  const b = seeded.find((row) => row.username === "bob");
  if (a === undefined || b === undefined) throw new Error("user seed failed");
  alice = a;
  bob = b;
  selfViewer = { kind: "user", id: alice.id, username: "alice", isAdmin: false };
});

/** Seed an owner hook directly (the create arm's row shape, without the
 *  validation round-trip — used for the isolation/deliveries fixtures). */
async function seedOwnerHook(ownerId: number, overrides: Partial<typeof webhooks.$inferInsert> = {}): Promise<typeof webhooks.$inferSelect> {
  const inserted = await drizzle(env.DB)
    .insert(webhooks)
    .values({
      ownerId,
      repoId: null,
      url: "https://hooks.example.com/" + ownerId,
      name: "relay",
      contentType: 1,
      events: JSON.stringify({ choose_events: true, branch_filter: "", events: { push: true } }),
      isActive: true,
      type: "gitea",
      createdAt: new Date("2026-01-02T00:00:00Z"),
      updatedAt: new Date("2026-01-02T00:00:00Z"),
      ...overrides,
    })
    .returning()
    .all();
  const row = inserted[0];
  if (row === undefined) throw new Error("hook seed failed");
  return row;
}

/** Seed one delivered row (the consumer's terminal shape). The repoId column
 *  is NOT NULL (denormalized for the repo purge) — the current emit fan-out
 *  is repo-scoped, so the value is a placeholder for owner-hook rows; the
 *  module counts by hookId alone. */
async function seedDelivery(hookId: number, overrides: Partial<typeof webhookDeliveries.$inferInsert> = {}): Promise<void> {
  await drizzle(env.DB)
    .insert(webhookDeliveries)
    .values({
      hookId,
      repoId: "repo-1",
      uuid: crypto.randomUUID(),
      eventType: "push",
      eventGroup: "push",
      payloadContent: "{}",
      state: "delivered",
      isSucceed: true,
      createdAt: new Date("2026-01-03T00:00:00Z"),
      deliveredAt: new Date("2026-01-03T00:01:00Z"),
      ...overrides,
    });
}

// --- the list loader ----------------------------------------------------------

describe("loadUserSettingsHooksPageData (the userListHooks read arm)", () => {
  it("renders an empty list for a user without hooks", async () => {
    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    expect(data.hooks).toEqual([]);
    expect(data.form).toEqual({ name: "", payloadUrl: "", contentType: "json" });
  });

  it("lists the owner's hooks with events and the batched delivery counts", async () => {
    const hook = await seedOwnerHook(alice.id);
    await seedDelivery(hook.id);
    await seedDelivery(hook.id, { uuid: crypto.randomUUID(), state: "failed", isSucceed: false });

    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    expect(data.hooks).toHaveLength(1);
    const item = data.hooks[0]!;
    expect(item.row.id).toBe(hook.id);
    expect(item.events).toEqual(["push"]);
    expect(item.deliveries).toBe(2);
  });

  it("keeps the owner scope: repo rows and another user's owner rows never leak", async () => {
    await seedOwnerHook(0, { repoId: "repo-1", ownerId: null }); // a repo webhook
    await seedOwnerHook(bob.id);

    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    expect(data.hooks).toHaveLength(0);
  });
});

// --- the create write ---------------------------------------------------------

describe("createUserHookFromForm (the userCreateHook write)", () => {
  it("creates the gitea-typed owner row (config + active from the form)", async () => {
    const outcome = await createUserHookFromForm(env.DB, alice.id, {
      name: "relay",
      payloadUrl: "https://hooks.example.com/ci",
      contentType: "json",
      secret: "s3cret",
      active: true,
    });
    expect(outcome.outcome).toBe("created");

    const row = (await drizzle(env.DB).select().from(webhooks).all())[0]!;
    expect(row.ownerId).toBe(alice.id);
    expect(row.repoId).toBeNull();
    expect(row.type).toBe("gitea");
    expect(row.url).toBe("https://hooks.example.com/ci");
    expect(row.name).toBe("relay");
    expect(row.secret).toBe("s3cret");
    expect(row.isActive).toBe(true);
    expect(row.lastStatus).toBe(0);
  });

  it("surfaces the checkCreateHookOption 422 message inline (invalid url)", async () => {
    const outcome = await createUserHookFromForm(env.DB, alice.id, {
      name: "bad",
      payloadUrl: "ftp://hooks.example.com/ci",
      contentType: "json",
      secret: "",
      active: false,
    });
    expect(outcome).toEqual({ outcome: "invalid", message: "Invalid url" });
    expect((await drizzle(env.DB).select().from(webhooks).all())).toHaveLength(0);
  });

  it("parses the upstream field names (parseCreateHookForm)", () => {
    const form = parseCreateHookForm(new URLSearchParams("name=relay&payload_url=https%3A%2F%2Fx.example&content_type=form&secret=s&active=on"));
    expect(form).toEqual({ name: "relay", payloadUrl: "https://x.example", contentType: "form", secret: "s", active: true });
    expect(parseCreateHookForm(new URLSearchParams()).active).toBe(false); // checkbox absence
  });
});

// --- the read arm -------------------------------------------------------------

describe("loadUserHookDetailData (the userGetHook read)", () => {
  it("binds the stored values into the edit form", async () => {
    const hook = await seedOwnerHook(alice.id, {
      url: "https://hooks.example.com/ci",
      name: "relay",
      contentType: 2,
      events: JSON.stringify({ choose_events: true, branch_filter: "main", events: { push: true, create: true } }),
      isActive: true,
    });

    const data = await loadUserHookDetailData(env.DB, alice.id, hook.id);
    if (data === null) throw new Error("read arm lost the row");
    expect(data.hook.id).toBe(hook.id);
    expect(data.events.sort()).toEqual(["create", "push"]);
    expect(data.branchFilter).toBe("main");
    expect(data.form.events.sort()).toEqual(["create", "push"]); // SUBSCRIPTION_ORDER's read-back (order-free here)
    expect(data.form).toMatchObject({
      name: "relay",
      payloadUrl: "https://hooks.example.com/ci",
      contentType: "form",
      branchFilter: "main",
      active: true,
    });
  });

  it("404-shells an unknown id and a foreign-owned id (existence hidden)", async () => {
    const foreign = await seedOwnerHook(bob.id);
    expect(await loadUserHookDetailData(env.DB, alice.id, 424242)).toBeNull();
    expect(await loadUserHookDetailData(env.DB, alice.id, foreign.id)).toBeNull();
  });
});

// --- the edit write -----------------------------------------------------------

describe("editUserHookFromForm (the userEditHook write over the shared editHook)", () => {
  it("round-trips url/name/active/branch filter", async () => {
    const hook = await seedOwnerHook(alice.id);
    const form = parseHookEditForm(
      new URLSearchParams("name=renamed&payload_url=https%3A%2F%2Fmoved.example%2Fhook&content_type=form&branch_filter=main&active=on"),
    );
    const outcome = await editUserHookFromForm(env.DB, hook, form);
    expect(outcome.outcome).toBe("saved");

    const data = await loadUserHookDetailData(env.DB, alice.id, hook.id);
    if (data === null) throw new Error("read arm lost the row");
    expect(data.form.name).toBe("renamed");
    expect(data.form.payloadUrl).toBe("https://moved.example/hook");
    expect(data.form.contentType).toBe("form");
    expect(data.form.branchFilter).toBe("main");
    expect(data.form.active).toBe(true);
  });

  it("surfaces the editHook 422 message and leaves the row untouched", async () => {
    const hook = await seedOwnerHook(alice.id, { url: "https://hooks.example.com/keep" });
    const outcome = await editUserHookFromForm(env.DB, hook, parseHookEditForm(new URLSearchParams("payload_url=not-a-url")));
    expect(outcome).toEqual({ outcome: "invalid", message: "Invalid url" });
    expect((await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.id, hook.id)).get())?.url).toBe(
      "https://hooks.example.com/keep",
    );
  });

  it("preserves the hidden events inputs through the unconditional rewrite; a bare POST resets to push-only", async () => {
    const hook = await seedOwnerHook(alice.id, {
      events: JSON.stringify({ choose_events: true, branch_filter: "", events: { push: true, create: true } }),
    });

    // The page's hidden inputs ride the same `events` field name upstream's
    // form submits — the PATCH arm rewrites subscriptions unconditionally.
    const kept = parseHookEditForm(new URLSearchParams("payload_url=https%3A%2F%2Fx.example&content_type=json&events=push&events=create"));
    expect(kept.events.sort()).toEqual(["create", "push"]);
    await editUserHookFromForm(env.DB, hook, kept);
    const afterKeep = await loadUserHookDetailData(env.DB, alice.id, hook.id);
    expect(afterKeep?.events.sort()).toEqual(["create", "push"]);

    // A form without the hidden inputs resets the subscription to push-only
    // (the shared editHook's unconditional `updateHookEvents(form.Events)`).
    await editUserHookFromForm(env.DB, hook, parseHookEditForm(new URLSearchParams("payload_url=https%3A%2F%2Fx.example&content_type=json")));
    const afterBare = await loadUserHookDetailData(env.DB, alice.id, hook.id);
    expect(afterBare?.events).toEqual(["push"]);
  });
});

// --- the delete write ---------------------------------------------------------

describe("deleteUserHook (upstream DeleteWebhook's arm)", () => {
  it("deletes the owner's row; the second call answers false (the 404 arm)", async () => {
    const hook = await seedOwnerHook(alice.id);
    expect(await deleteUserHook(env.DB, alice.id, hook.id)).toBe(true);
    expect(await deleteUserHook(env.DB, alice.id, hook.id)).toBe(false);
    expect(await drizzle(env.DB).select().from(webhooks).all()).toHaveLength(0);
  });

  it("refuses a foreign owner's id (existence stays hidden)", async () => {
    const foreign = await seedOwnerHook(bob.id);
    expect(await deleteUserHook(env.DB, alice.id, foreign.id)).toBe(false);
    expect((await drizzle(env.DB).select().from(webhooks).all()).map((row) => row.id)).toEqual([foreign.id]);
  });
});

// --- the list page DOM ---------------------------------------------------------

function ListPageForTest(props: { data: Awaited<ReturnType<typeof loadUserSettingsHooksPageData>>; error: string | null }) {
  return <UserHooksSettingsPage ctx={ctx} data={props.data} error={props.error} />;
}

describe("the list page DOM (user/settings/hooks.tmpl + base_list.tmpl at the pin)", () => {
  it("renders the discriminator pageClass, the Settings h4 quirk, the desc and the add form", async () => {
    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    const html = renderToString(<ListPageForTest data={data} error={null} />);
    expect(html).toContain("user settings webhooks"); // hooks.tmpl:1's pageClass — upstream's own webhooks naming
    expect(html).toContain('class="ui top attached header">Settings</h4>'); // webhooks.go:23's settings_title .Title (the org arm's h4 quirk twin)
    expect(html).toContain(userSettingsWebhooksLocale.hooks_desc); // settings.hooks.desc
    expect(html).toContain(`action="/user/settings/hooks"`);
    expect(html).toContain('name="payload_url"');
    expect(html).toContain('name="content_type"');
    expect(html).toContain('name="secret"');
    expect(html).toContain('name="active"');
    // The full-document render path matches the component path.
    expect(renderUserSettingsHooksPage({ ctx, data, error: null })).toContain('action="/user/settings/hooks"');
  });

  it("renders the empty arm when no hooks exist", async () => {
    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    const html = renderToString(<ListPageForTest data={data} error={null} />);
    expect(html).not.toContain("flex-divided-list");
    expect(html).toContain("No webhooks yet.");
  });

  it("renders base_list's row: the status dot mapping, the name/URL link, the chip, the pencil", async () => {
    const hook = await seedOwnerHook(alice.id, { name: "", url: "https://hooks.example.com/ci" });
    await seedDelivery(hook.id);
    await seedDelivery(hook.id, { uuid: crypto.randomUUID() });
    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    const html = renderToString(<ListPageForTest data={data} error={null} />);

    expect(html).toContain("flex-divided-list");
    expect(html).toContain("tw-text-text-light"); // last_status None → the neutral dot (base_list's three-class mapping)
    expect(html).toContain(`href="/user/settings/hooks/${hook.id}"`); // BaseLink/{ID}
    expect(html).toContain("Unnamed Webhook"); // repo.settings.webhook.name_empty for the empty name
    expect(html).toContain("https://hooks.example.com/ci");
    expect(html).toContain("2 deliveries"); // the batched count chip
    expect(html).toContain("octicon-pencil");
    expect(html).not.toContain("octicon-trash"); // the link-action delete is not rendered (the module header)
  });

  it("maps the maintained last_status to the green/red dot classes", async () => {
    const ok = await seedOwnerHook(alice.id, { lastStatus: 1 });
    const bad = await seedOwnerHook(alice.id, { url: "https://hooks.example.com/2", lastStatus: 2 });
    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    const html = renderToString(<ListPageForTest data={data} error={null} />);
    const okIdx = html.indexOf(`/user/settings/hooks/${ok.id}`);
    const badIdx = html.indexOf(`/user/settings/hooks/${bad.id}`);
    expect(okIdx).toBeGreaterThan(-1);
    expect(badIdx).toBeGreaterThan(okIdx);
    expect(html.slice(0, okIdx)).toContain("tw-text-green");
    expect(html.slice(okIdx, badIdx)).toContain("tw-text-red");
  });

  it("renders the failed POST's 422 message in the error slot", async () => {
    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    const html = renderToString(<ListPageForTest data={data} error="Invalid url" />);
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("Invalid url");
  });

  it("re-renders the submitted add-form values on a validation failure", async () => {
    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    const carried = { ...data, form: { name: "relay", payloadUrl: "ftp://x", contentType: "form" } };
    const html = renderToString(<ListPageForTest data={carried} error="Invalid url" />);
    expect(html).toContain('value="relay"');
    expect(html).toContain('value="ftp://x"');
    expect(html).toContain('value="form"');
  });

  it("keeps the h4 quirk: the base_list header is Settings, never the navbar's Webhooks", async () => {
    // webhooks.go:23 sets the list segment's .Title to settings_title
    // ("Settings") — the org arm's quirk twin. The navbar item keeps the
    // repo.settings.hooks label ("Webhooks"), but no h4 may carry it (the
    // repo arm's header text would be the quirk regression).
    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    const html = renderToString(<ListPageForTest data={data} error={null} />);
    expect(html).toContain('class="ui top attached header">Settings</h4>');
    expect(html).not.toContain('attached header">Webhooks</h4>');
    expect(html).toContain(">Webhooks</a>"); // the navbar item, unchanged
    // The second h4 is the inline add form's (base_list renders only the one
    // header; the add segment is this module's reduction).
    expect(html).toContain('class="ui top attached header">Add Webhook</h4>');
  });
});

// --- the per-hook page DOM ------------------------------------------------------

describe("the per-hook page DOM (hook_new.tmpl's edit arm + webhook/new.tmpl at the pin)", () => {
  async function renderedDetail(hookOverrides: Partial<typeof webhooks.$inferInsert> = {}, deliveries = 0): Promise<string> {
    const hook = await seedOwnerHook(alice.id, hookOverrides);
    for (let i = 0; i < deliveries; i++) {
      await seedDelivery(hook.id, { uuid: crypto.randomUUID() });
    }
    const data = await loadUserHookDetailData(env.DB, alice.id, hook.id);
    if (data === null) throw new Error("read arm lost the row");
    return renderToString(<UserHookDetailPage ctx={ctx} data={data} error={null} />);
  }

  it("renders the discriminator pageClass, the Update Webhook h4 and the edit form", async () => {
    const hook = await seedOwnerHook(alice.id, { url: "https://hooks.example.com/ci", isActive: true });
    const data = await loadUserHookDetailData(env.DB, alice.id, hook.id);
    if (data === null) throw new Error("read arm lost the row");
    const html = renderToString(<UserHookDetailPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain("user settings new webhook"); // hook_new.tmpl:1's pageClass
    expect(html).toContain(">Update Webhook</h4>"); // CustomHeaderTitle = repo.settings.update_webhook on the edit arm
    expect(html).toContain(`action="/user/settings/hooks/${hook.id}"`);
    expect(html).toContain('name="payload_url"');
    expect(html).toContain('name="branch_filter"');
    expect(html).toContain('name="active" type="checkbox" checked'); // the stored active binds checked
    expect(html).toContain('action="/user/settings/hooks/' + hook.id + '/delete"'); // the Remove form
    expect(html).toContain("Remove Webhook");
    expect(renderUserHookDetailPage({ ctx, data, error: null })).toContain("Update Webhook");
  });

  it("carries the hidden events preserve inputs and the read-only subscription line", async () => {
    const html = await renderedDetail({
      events: JSON.stringify({ choose_events: true, branch_filter: "", events: { push: true, create: true } }),
    });
    expect(html).toContain('type="hidden" name="events" value="push"');
    expect(html).toContain('type="hidden" name="events" value="create"');
    expect(html).toContain("Trigger On:"); // settings.tmpl's matrix reduced to the line
    expect(html).toContain("push");
    expect(html).toContain("create");
  });

  it("renders the deliveries segment with the row trio and the empty arm", async () => {
    const withRows = await renderedDetail({}, 2);
    expect(withRows).toContain("Recent Deliveries");
    expect(withRows).toContain("tw-font-mono"); // the uuid
    expect(withRows).toContain("ui tiny label"); // the event chip
    expect(withRows).toContain("tw-text-green"); // the delivered-success mark

    const empty = await renderedDetail();
    expect(empty).toContain("No deliveries yet.");
  });

  it("keeps the reductions honest: no test-fire, no replay, no provider picker", async () => {
    const html = await renderedDetail();
    expect(html).not.toContain("Test Push Event"); // no test route in the /user/settings/hooks group (the module header)
    expect(html).not.toContain("replay"); // registered upstream, not landed anywhere (the module header)
    const list = renderToString(<ListPageForTest data={await loadUserSettingsHooksPageData(env.DB, alice.id)} error={null} />);
    expect(list).not.toContain("/gitea/new"); // the provider-picker page is not rendered — one landed provider
    expect(list).not.toContain("type dropdown");
  });

  it("renders the failed POST's message in the error slot", async () => {
    const hook = await seedOwnerHook(alice.id);
    const data = await loadUserHookDetailData(env.DB, alice.id, hook.id);
    if (data === null) throw new Error("read arm lost the row");
    const html = renderToString(<UserHookDetailPage ctx={ctx} data={data} error="Invalid content type" />);
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("Invalid content type");
  });
});

// --- the navbar -----------------------------------------------------------------

// STALE-PIN UPDATE (wave-114 nav swap): the page's local five-item
// UserSettingsWebhooksNav was deleted for the shared
// components/settings-nav UserSettingsNavbar, whose landed family includes
// the Appearance item — the old "appearance stays absent" negative inverted
// into a positive (the shared nav renders it), and the still-dead upstream
// targets keep their negatives.
describe("the settings navbar (the shared UserSettingsNavbar, hooks active)", () => {
  it("marks the hooks item active and carries the shared family's landed tabs", async () => {
    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    const html = renderToString(<ListPageForTest data={data} error={null} />);
    expect(html).toContain('class="active item" href="/user/settings/hooks"');
    expect(html).toContain('href="/user/settings"'); // Profile
    expect(html).toContain('href="/user/settings/security"');
    expect(html).toContain('href="/user/settings/applications"');
    expect(html).toContain('href="/user/settings/keys"');
    expect(html).toContain('href="/user/settings/appearance"'); // the shared nav's Appearance item (was a dead target pre-swap)
    expect(html).toContain(">Webhooks</a>"); // the navbar label — repo.settings.hooks reused
    // The still-unlanded upstream items stay absent (the dead-link rule).
    // STALE-PIN FLIP (484eb92, the user-settings repos mini-mount): Repos
    // LEFT the dead list — the repos tab mounted and the shared nav renders
    // its navbar.tmpl:74-76 item on EVERY settings page, so the old absence
    // negative inverted into the item's exact inactive-anchor pin (the
    // wave-114 Appearance inversion precedent above).
    expect(html).not.toContain("/user/settings/audit_logs");
    expect(html).toContain('class="item" href="/user/settings/repos"');
  });
});

// --- the deferred matrix (wave-83: the module is MOUNTED) ------------------------
// The mount (ui/index.ts window-2a: GET+POST /user/settings/hooks,
// GET+POST /:id, POST /:id/delete) un-defers the route-level arms below —
// driven the production way (parse → resolveUiSession → load → render), the
// user-settings-appearance.test.tsx window harness.

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real dispatch path against the mounted uiRouter; the execution
 *  context is awaited so waitUntil side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** Alice's minted session cookie header — re-minted per request (the
 *  beforeEach users wipe cascades the sessions table, so a cross-test cache
 *  would go stale; the value is never rendered). */
async function aliceSessionHeader(): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, alice.id)}`;
}

/** A urlencoded POST carrying the browser's Origin (the §2.8 guard's happy
 *  path); repeated fields (`events`) flatten to repeated keys — the exact
 *  wire shape of the detail page's hidden preserve inputs. */
function formPost(path: string, fields: Record<string, string | string[]>, cookie: string, origin: string = ORIGIN): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      cookie,
    },
    body: new URLSearchParams(
      Object.entries(fields).flatMap(([key, value]) =>
        Array.isArray(value) ? value.map((entry) => [key, entry] as [string, string]) : [[key, value] as [string, string]],
      ),
    ).toString(),
  };
}

describe("the mounted routes (window-2a: GET+POST /user/settings/hooks, GET+POST /:id, POST /:id/delete)", () => {
  it("303s an anonymous GET onto the login round-trip (the reqSignIn gate)", async () => {
    const res = await fetchUi("/user/settings/hooks");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Fuser%2Fsettings%2Fhooks");
  });

  it("renders the signed-in list page at 200 (the Settings h4 quirk over the mount)", async () => {
    const res = await fetchUi("/user/settings/hooks", { headers: { cookie: await aliceSessionHeader() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content user settings webhooks"); // hooks.tmpl:1's pageClass
    expect(html).toContain('class="ui top attached header">Settings</h4>'); // webhooks.go:23
    expect(html).toContain('action="/user/settings/hooks"'); // the inline add form
  });

  it("POST create hit: 303s onto the list and persists the owner row", async () => {
    const res = await fetchUi(
      "/user/settings/hooks",
      formPost(
        "/user/settings/hooks",
        { name: "mounted", payload_url: "https://hooks.example.com/mounted", content_type: "json", active: "on" },
        await aliceSessionHeader(),
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/user/settings/hooks");
    const row = (await drizzle(env.DB).select().from(webhooks).all())[0]!;
    expect(row.ownerId).toBe(alice.id);
    expect(row.repoId).toBeNull(); // owner-scoped, never a repo row
    expect(row.url).toBe("https://hooks.example.com/mounted");
    expect(row.isActive).toBe(true);
  });

  it("POST create miss: re-renders 200 with the 422 message and the kept submission", async () => {
    // No payload_url field at all — parseCreateHookForm's "" trips
    // IsValidURL → ApiError 422 "Invalid url", re-rendered inline with the
    // submitted name carried over (RenderWithErrDeprecated's re-render arm:
    // upstream binds the form into the re-render via
    // middleware.AssignForm — context_response.go:117-125; the module
    // header's HANDOFF NOTE "+ the `form` values carried over";
    // UserHooksSettingsData.form's doc comment; the org twin
    // orgHooksSettingsSubmit assigns data.form verbatim and the wave-53
    // test pins it).
    const res = await fetchUi(
      "/user/settings/hooks",
      formPost("/user/settings/hooks", { name: "kept-name", content_type: "json" }, await aliceSessionHeader()),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("Invalid url");
    expect(html).toContain('value="kept-name"');
    expect((await drizzle(env.DB).select().from(webhooks).all())).toHaveLength(0);
  });

  it("rejects a cross-origin POST before any write (sameOriginGuard first)", async () => {
    const res = await fetchUi(
      "/user/settings/hooks",
      formPost(
        "/user/settings/hooks",
        { payload_url: "https://hooks.example.com/x" },
        await aliceSessionHeader(),
        "https://evil.example",
      ),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect((await drizzle(env.DB).select().from(webhooks).all())).toHaveLength(0);
  });

  it("GET detail hit renders the edit arm over the mount (both form actions + the hidden events)", async () => {
    const hook = await seedOwnerHook(alice.id, {
      events: JSON.stringify({ choose_events: true, branch_filter: "", events: { push: true, create: true } }),
    });
    const res = await fetchUi(`/user/settings/hooks/${hook.id}`, { headers: { cookie: await aliceSessionHeader() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content user settings new webhook"); // hook_new.tmpl:1's pageClass
    expect(html).toContain(">Update Webhook</h4>"); // the CustomHeaderTitle edit arm
    expect(html).toContain(`action="/user/settings/hooks/${hook.id}"`);
    expect(html).toContain(`action="/user/settings/hooks/${hook.id}/delete"`);
    expect(html).toContain('type="hidden" name="events" value="push"');
    expect(html).toContain('type="hidden" name="events" value="create"');
  });

  it("GET detail on an unknown NUMERIC id: the claimed family 404-shells through the loader", async () => {
    const res = await fetchUi("/user/settings/hooks/424242", { headers: { cookie: await aliceSessionHeader() } });
    expect(res.status).toBe(404);
  });

  it("POST edit with the hidden events inputs: the subscription survives the rewrite (per the parse)", async () => {
    const hook = await seedOwnerHook(alice.id, {
      events: JSON.stringify({ choose_events: true, branch_filter: "", events: { push: true, create: true } }),
    });
    const res = await fetchUi(
      `/user/settings/hooks/${hook.id}`,
      formPost(
        `/user/settings/hooks/${hook.id}`,
        {
          name: "relay",
          payload_url: "https://moved.example/hook",
          content_type: "json",
          branch_filter: "main",
          events: ["push", "create"], // the hidden inputs' repeated-key wire shape
        },
        await aliceSessionHeader(),
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/user/settings/hooks/${hook.id}`);
    const data = await loadUserHookDetailData(env.DB, alice.id, hook.id);
    if (data === null) throw new Error("read arm lost the row");
    // hookEventsArray re-reads the stored flags in SUBSCRIPTION_ORDER — the
    // parse's exact order, not the wire order.
    expect(data.events).toEqual(["create", "push"]);
    expect(data.branchFilter).toBe("main");
    expect(data.form.payloadUrl).toBe("https://moved.example/hook");
  });

  it("POST edit bare (no events field): the unconditional rewrite resets to push-only", async () => {
    const hook = await seedOwnerHook(alice.id, {
      events: JSON.stringify({ choose_events: true, branch_filter: "main", events: { push: true, create: true } }),
    });
    const res = await fetchUi(
      `/user/settings/hooks/${hook.id}`,
      formPost(
        `/user/settings/hooks/${hook.id}`,
        { payload_url: "https://moved.example/hook", content_type: "json" },
        await aliceSessionHeader(),
      ),
    );
    expect(res.status).toBe(303);
    const data = await loadUserHookDetailData(env.DB, alice.id, hook.id);
    if (data === null) throw new Error("read arm lost the row");
    expect(data.events).toEqual(["push"]); // updateHookEvents([]) ⇒ push-only (upstream's nil Events)
    expect(data.branchFilter).toBe(""); // branch_filter applies unconditionally too
  });

  it("POST edit on an unknown NUMERIC id 404-shells before any write", async () => {
    const res = await fetchUi(
      "/user/settings/hooks/424242",
      formPost("/user/settings/hooks/424242", { payload_url: "https://hooks.example.com/x" }, await aliceSessionHeader()),
    );
    expect(res.status).toBe(404);
    expect((await drizzle(env.DB).select().from(webhooks).all())).toHaveLength(0);
  });

  it("POST delete hit: 303s onto the list and removes the row; a miss 404-shells", async () => {
    const hook = await seedOwnerHook(alice.id);
    const hit = await fetchUi(
      `/user/settings/hooks/${hook.id}/delete`,
      formPost(`/user/settings/hooks/${hook.id}/delete`, {}, await aliceSessionHeader()),
    );
    expect(hit.status).toBe(303);
    expect(hit.headers.get("location")).toBe("/user/settings/hooks"); // DeleteWebhook's JSONRedirect target
    expect(await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.id, hook.id)).get()).toBeUndefined();

    const miss = await fetchUi(
      "/user/settings/hooks/424242/delete",
      formPost("/user/settings/hooks/424242/delete", {}, await aliceSessionHeader()),
    );
    expect(miss.status).toBe(404); // the existence-hiding shell, not a flash
  });
});

describe("the mounted foreign-owner arms (another doer's hook id — existence stays hidden)", () => {
  it("GET detail on bob's hook 404-shells", async () => {
    const hook = await seedOwnerHook(bob.id);
    const res = await fetchUi(`/user/settings/hooks/${hook.id}`, { headers: { cookie: await aliceSessionHeader() } });
    expect(res.status).toBe(404);
  });

  it("POST edit on bob's hook 404-shells and leaves the row untouched", async () => {
    const hook = await seedOwnerHook(bob.id);
    const res = await fetchUi(
      `/user/settings/hooks/${hook.id}`,
      formPost(
        `/user/settings/hooks/${hook.id}`,
        { name: "stolen", payload_url: "https://evil.example/hook", content_type: "json" },
        await aliceSessionHeader(),
      ),
    );
    expect(res.status).toBe(404);
    const row = (await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.id, hook.id)).get())!;
    expect(row.name).toBe("relay"); // the unconditional rewrite never touched it
    expect(row.url).toBe(`https://hooks.example.com/${bob.id}`);
  });

  it("POST delete on bob's hook 404-shells and the row survives", async () => {
    const hook = await seedOwnerHook(bob.id);
    const res = await fetchUi(
      `/user/settings/hooks/${hook.id}/delete`,
      formPost(`/user/settings/hooks/${hook.id}/delete`, {}, await aliceSessionHeader()),
    );
    expect(res.status).toBe(404);
    expect(await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.id, hook.id)).get()).toBeDefined();
  });
});

describe("the parse claim split (parseUiRoute / handlesUiRoute — the id arm)", () => {
  it("claims the numeric id shapes (leading zeros fold — the org-teams precedent)", () => {
    expect(parseUiRoute("/user/settings/hooks/424242")).toEqual({ family: "user-settings-hook-detail", id: 424242 });
    expect(parseUiRoute("/user/settings/hooks/007")).toEqual({ family: "user-settings-hook-detail", id: 7 });
    expect(parseUiRoute("/user/settings/hooks/7/delete")).toEqual({ family: "user-settings-hook-delete", id: 7 });
    expect(handlesUiRoute("/user/settings/hooks/424242")).toBe(true);
    expect(handlesUiRoute("/user/settings/hooks/424242/delete")).toBe(true);
  });

  it("leaves the non-numeric and deeper tails unclaimed → the engine's 404", () => {
    // A junk segment never reaches this router: the dispatcher consults
    // handlesUiRoute (parseUiRoute null → not ours) and the git gate /
    // engine answers — exactly upstream's unregistered-route 404. Asserted
    // at the parse on purpose: fetching the sub-app directly would let
    // Hono's `:id` match the junk segment and misrepresent production.
    expect(parseUiRoute("/user/settings/hooks/abc")).toBeNull();
    expect(handlesUiRoute("/user/settings/hooks/abc")).toBe(false);
    expect(parseUiRoute("/user/settings/hooks/-3")).toBeNull(); // /^\d+$/ — no sign
    expect(parseUiRoute("/user/settings/hooks/7/edit")).toBeNull(); // deeper tail (no replay arm landed)
    expect(parseUiRoute("/user/settings/hooks/7/delete/extra")).toBeNull();
  });
});

describe("the create validation arms (checkCreateHookOption's exact ApiError texts)", () => {
  it("Invalid content type — the service arm behind the form's content_type key", async () => {
    // The form parse narrows content_type to json|form, so this text is
    // unreachable on the wire; the module write surfaces whatever ApiError
    // the shared addHook throws — its exact message is the contract.
    const outcome = await createUserHookFromForm(env.DB, alice.id, {
      name: "yaml",
      payloadUrl: "https://hooks.example.com/ci",
      contentType: "yaml",
      secret: "",
      active: false,
    });
    expect(outcome).toEqual({ outcome: "invalid", message: "Invalid content type" });
    expect((await drizzle(env.DB).select().from(webhooks).all())).toHaveLength(0);
  });

  it("Invalid url on an empty payload_url (the blank-form arm)", async () => {
    const outcome = await createUserHookFromForm(env.DB, alice.id, {
      name: "blank",
      payloadUrl: "",
      contentType: "json",
      secret: "",
      active: false,
    });
    expect(outcome).toEqual({ outcome: "invalid", message: "Invalid url" });
    expect((await drizzle(env.DB).select().from(webhooks).all())).toHaveLength(0);
  });
});

describe("the delivery-count chip batching (the one group-by read per page)", () => {
  it("counts each hook's deliveries from the single batched read; a countless hook reads 0", async () => {
    const two = await seedOwnerHook(alice.id, { url: "https://hooks.example.com/two" });
    const one = await seedOwnerHook(alice.id, { url: "https://hooks.example.com/one" });
    const _zero = await seedOwnerHook(alice.id, { url: "https://hooks.example.com/zero" });
    await seedDelivery(two.id);
    await seedDelivery(two.id, { uuid: crypto.randomUUID() });
    await seedDelivery(one.id);
    // Deliveries on an UNLISTED hook never bleed in — the group-by keys on
    // the listed ids alone (the inArray guard over the page's rows).
    const bobHook = await seedOwnerHook(bob.id, { url: "https://hooks.example.com/bob" });
    await seedDelivery(bobHook.id);

    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    expect(data.hooks.map((hook) => hook.deliveries)).toEqual([2, 1, 0]); // id ASC

    const html = renderToString(<ListPageForTest data={data} error={null} />);
    expect(html).toContain("2 deliveries"); // settingsLocale.deliveries (plural)
    expect(html).toContain("1 delivery"); // settingsLocale.deliveries_1 (singular)
    expect(html).toContain("0 deliveries"); // the counts-miss default
  });
});
