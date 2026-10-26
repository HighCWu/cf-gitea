/**
 * The user settings WEBHOOKS tab's tests (the bench-row UNMOUNTED module —
 * the repo-settings-wiki.test.tsx harness): the list/read/create/edit/delete
 * arms over real D1 (generated migrations in beforeAll; the writes go
 * through the landed owner-scoped service arms, the same calls the
 * hooks-scopes wave's /user/hooks routes make) and the DOM contract of the
 * two page renders — hono/jsx renderToString, the modules driven directly
 * (no route yet, the HANDOFF NOTE in the module header).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { users, webhookDeliveries, webhooks } from "../../db/schema";
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

describe("the settings navbar (user/settings/navbar.tmpl reduced to the landed items)", () => {
  it("marks the hooks item active and lists only the landed sibling tabs", async () => {
    const data = await loadUserSettingsHooksPageData(env.DB, alice.id);
    const html = renderToString(<ListPageForTest data={data} error={null} />);
    expect(html).toContain('class="active item" href="/user/settings/hooks"');
    expect(html).toContain('href="/user/settings"'); // Profile
    expect(html).toContain('href="/user/settings/security"');
    expect(html).toContain('href="/user/settings/applications"');
    expect(html).toContain('href="/user/settings/keys"');
    expect(html).toContain(">Webhooks</a>"); // the navbar label — repo.settings.hooks reused
    // The unlanded upstream items stay absent (the dead-link rule).
    expect(html).not.toContain("/user/settings/appearance");
    expect(html).not.toContain("/user/settings/audit_logs");
    expect(html).not.toContain("/user/settings/repos");
  });
});
