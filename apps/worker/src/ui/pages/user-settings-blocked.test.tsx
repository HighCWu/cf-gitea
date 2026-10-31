/**
 * The USER settings BLOCKED USERS tab's tests (the org twin's user-scope
 * twin — census gap #14, UNMOUNTED at writing): the load/parse/apply matrix
 * over real D1 (generated migrations in beforeAll; the writes go through
 * the landed user-scope block service arms — the same `user_blocking` store
 * the org family's arms serve, services/blocks.ts) and the DOM contract of
 * the page render — hono/jsx renderToString, the module driven directly.
 * The battery mirrors org-settings-blocked.test.tsx minus the mounted-route
 * matrix: the route claims (family `user-settings-blocked-users`, the
 * userSettingsTabPrologue GET/POST pair, the anonymous-303 posture) light
 * up at the orchestrator's index.ts fold — the module header carries the
 * exact mount recipe (the b91dd1c handoff pattern), and the route-level
 * pins move to the index.test.ts fold, so this file stays green unmounted
 * AND after the fold.
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { blockUser } from "../../api/services/blocks";
import { users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { UserSettingsNavbar } from "../components/settings-nav";
import type { Viewer } from "../viewer";
import {
  USER_BLOCKED_USERS_LIST_LIMIT,
  applyUserBlockedForm,
  loadUserBlockedUsers,
  renderUserSettingsBlockedPage,
  UserSettingsBlockedPage,
  userSettingsBlockedLocale,
  parseUserBlockedForm,
} from "./user-settings-blocked";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The signed-in viewer — the BLOCKER at user scope (setting/block.go:32's
 *  ctx.Doer flows into both parameters; ids assigned at seed time — never
 *  hardcoded). */
let viewer: Viewer = { kind: "anonymous" };
let ctx: UiContext;

/** The write doer (the route stage's signed-in user — the prologue's
 *  precondition, mirrored by the seeded row). */
function doer(): { id: number; isAdmin: boolean } {
  if (viewer.kind !== "user") throw new Error("fixture viewer missing");
  return { id: viewer.id, isAdmin: viewer.isAdmin };
}

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

async function seedUser(username: string, type: "user" | "org" = "user"): Promise<SeededUser> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      type,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username, isAdmin: false };
}

/** Block through the landed user-scope service arm with the fixture viewer
 *  as the blocker (the page's own write — the seam the mounted POST serves
 *  through). */
async function seedBlock(blockee: SeededUser, note = ""): Promise<void> {
  await blockUser(
    env.DB,
    doer(),
    { id: doer().id, isOrg: false, isAdmin: doer().isAdmin },
    { id: blockee.id, isOrg: false, isAdmin: false },
    note,
  );
}

async function seedBlockee(username: string): Promise<SeededUser> {
  return seedUser(username);
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["user_blocking", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const alice = await seedUser("alice");
  viewer = { kind: "user", id: alice.id, username: alice.username, isAdmin: false };
  ctx = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };
});

// --- the loader ----------------------------------------------------------------

describe("loadUserBlockedUsers (the FindBlockings read arm + the batched notes)", () => {
  it("an empty store loads zero rows", async () => {
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    expect(data.blocks).toEqual([]);
  });

  it("carries the blockees and their notes in id ASC order", async () => {
    const bob = await seedBlockee("bob");
    const carol = await seedBlockee("carol");
    await seedBlock(bob, "spam waves");
    await seedBlock(carol);
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    expect(data.blocks.map((row) => [row.blockee.username, row.note])).toEqual([
      ["bob", "spam waves"],
      ["carol", ""],
    ]);
  });

  it("scopes the list to THIS blocker's edges — another user's blocks never leak", async () => {
    const bob = await seedBlockee("bob");
    const carol = await seedBlockee("carol");
    // bob blocks carol with a note; alice's page must not show it.
    await blockUser(
      env.DB,
      { id: bob.id, isAdmin: false },
      { id: bob.id, isOrg: false, isAdmin: false },
      { id: carol.id, isOrg: false, isAdmin: false },
      "bob's private note",
    );
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    expect(data.blocks).toEqual([]);
    expect(bob.id).not.toBe(doer().id); // fixture sanity: a genuinely foreign blocker
  });

  it("caps at USER_BLOCKED_USERS_LIST_LIMIT rows — one page serves the slice (the reduction)", async () => {
    // id ASC order — bulk00..bulk49 fill the page; bulk50 (seeded last, the
    // highest id) is the cap casualty.
    for (let i = 0; i <= USER_BLOCKED_USERS_LIST_LIMIT; i++) {
      const blockee = await seedBlockee(`bulk${String(i).padStart(2, "0")}`);
      await seedBlock(blockee);
    }
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    expect(data.blocks.length).toBe(USER_BLOCKED_USERS_LIST_LIMIT);
    expect(data.blocks[0]?.blockee.username).toBe("bulk00"); // the head of the id-ASC page
    expect(data.blocks[USER_BLOCKED_USERS_LIST_LIMIT - 1]?.blockee.username).toBe("bulk49");
  });
});

// --- the form parse ------------------------------------------------------------

describe("parseUserBlockedForm (BlockUserForm: action In(block,unblock,note), blockee Required, note)", () => {
  it("parses the block post with its note", () => {
    expect(parseUserBlockedForm(new URLSearchParams({ action: "block", blockee: "bob", note: "spam" }))).toEqual({
      action: "block",
      blockee: "bob",
      note: "spam",
    });
  });

  it("parses the unblock post; an absent note stays an empty string", () => {
    expect(parseUserBlockedForm(new URLSearchParams({ action: "unblock", blockee: "bob" }))).toEqual({
      action: "unblock",
      blockee: "bob",
      note: "",
    });
  });

  it("parses the reduced action=note arm as the note value (the module header's reduction)", () => {
    expect(parseUserBlockedForm(new URLSearchParams({ action: "note", blockee: "bob", note: "x" })).action).toBe("note");
  });

  it("a failed binding (any out-of-enum action) parses as null", () => {
    expect(parseUserBlockedForm(new URLSearchParams({ action: "destroy", blockee: "bob" })).action).toBeNull();
    expect(parseUserBlockedForm(new URLSearchParams({ blockee: "bob" })).action).toBeNull();
  });
});

// --- the write -----------------------------------------------------------------

describe("applyUserBlockedForm (the doer IS the blocker — setting/block.go:32's ctx.Doer shape)", () => {
  it("blocks through the user arm — the row lands with its note", async () => {
    await seedBlockee("bob");
    const result = await applyUserBlockedForm(env.DB, doer(), {
      action: "block",
      blockee: "bob",
      note: "spam",
    });
    expect(result).toEqual({ outcome: "applied" });
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    expect(data.blocks.map((row) => [row.blockee.username, row.note])).toEqual([["bob", "spam"]]);
  });

  it("an unknown blockee — the error.not_found arm (block.go:75-76)", async () => {
    const result = await applyUserBlockedForm(env.DB, doer(), { action: "block", blockee: "ghost", note: "" });
    expect(result).toEqual({ outcome: "invalid", message: "The target couldn't be found." });
  });

  it("an org blockee — the ErrBlockOrganization failure text", async () => {
    await seedUser("acme", "org");
    const result = await applyUserBlockedForm(env.DB, doer(), { action: "block", blockee: "acme", note: "" });
    expect(result).toEqual({ outcome: "invalid", message: "Failed to block user: cannot block an organization" });
  });

  it("a self-block — the service's doer==blockee gate (the user-scope permission posture)", async () => {
    const result = await applyUserBlockedForm(env.DB, doer(), { action: "block", blockee: "alice", note: "" });
    expect(result).toEqual({ outcome: "invalid", message: "Failed to block user: cannot block the user" });
    expect((await loadUserBlockedUsers(env.DB, doer().id)).blocks).toEqual([]); // nothing written
  });

  it("a re-block is not idempotent — the cannot-block failure text", async () => {
    const bob = await seedBlockee("bob");
    await seedBlock(bob);
    const result = await applyUserBlockedForm(env.DB, doer(), { action: "block", blockee: "bob", note: "" });
    expect(result).toEqual({ outcome: "invalid", message: "Failed to block user: cannot block the user" });
  });

  it("unblocks through the user arm — the row is gone", async () => {
    const bob = await seedBlockee("bob");
    await seedBlock(bob, "spam");
    const result = await applyUserBlockedForm(env.DB, doer(), { action: "unblock", blockee: "bob", note: "" });
    expect(result).toEqual({ outcome: "applied" });
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    expect(data.blocks).toEqual([]);
  });

  it("unblocking a pair that is not blocked — the cannot-unblock failure text", async () => {
    await seedBlockee("bob"); // the user exists; the pair was never blocked
    const result = await applyUserBlockedForm(env.DB, doer(), { action: "unblock", blockee: "bob", note: "" });
    expect(result).toEqual({ outcome: "invalid", message: "Failed to unblock user: cannot unblock the user" });
  });

  it("the reduced action=note arm (and a failed binding) answers the honest-absence text", async () => {
    const note = await applyUserBlockedForm(env.DB, doer(), { action: "note", blockee: "bob", note: "x" });
    expect(note).toEqual({ outcome: "invalid", message: userSettingsBlockedLocale.note_unavailable });
    const bound = await applyUserBlockedForm(env.DB, doer(), { action: null, blockee: "bob", note: "" });
    expect(bound).toEqual({ outcome: "invalid", message: userSettingsBlockedLocale.note_unavailable });
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the blocked-users tab DOM (shared/user/blocked_users.tmpl at the pin)", () => {
  it("renders the pageClass discriminator and the full-document render path", async () => {
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    const html = renderToString(<UserSettingsBlockedPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain("user settings blocked_users"); // the §2.4.1 discriminator
    expect(html).toContain('action="/user/settings/blocked_users"');
    // The full-document render matches the component path.
    expect(renderUserSettingsBlockedPage({ ctx, data, error: null })).toContain(
      'action="/user/settings/blocked_users"',
    );
  });

  it("renders the block form: hidden action, the required prompt, the red button, the note field", async () => {
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    const html = renderToString(<UserSettingsBlockedPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain('name="action" value="block"');
    expect(html).toContain('id="search-user-box"');
    expect(html).toContain('name="blockee"');
    expect(html).toContain(`placeholder="${userSettingsBlockedLocale.search_user}"`);
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain(`>${userSettingsBlockedLocale.block}</button>`);
    expect(html).toContain(`>${userSettingsBlockedLocale.note_title}</label>`);
    expect(html).toContain(`>${userSettingsBlockedLocale.note_info}</p>`);
  });

  it("renders the info segment with the upstream docs link", async () => {
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    const html = renderToString(<UserSettingsBlockedPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain(userSettingsBlockedLocale.info);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('href="https://docs.gitea.com/usage/access-control/blocking-user"');
    expect(html).toContain(userSettingsBlockedLocale.info_docs);
  });

  it("renders the rows: avatar seam img, HomeLink title, the note arm, the unblock form", async () => {
    const bob = await seedBlockee("bob");
    await seedBlock(bob, "spam waves");
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    const html = renderToString(<UserSettingsBlockedPage ctx={ctx} data={data} error={null} />);
    // The 28px default avatar (util_avatar.go:39-44) through the serving seam.
    expect(html).toContain('src="/user/avatar/bob/28"');
    expect(html).toContain('width="28"');
    expect(html).toContain('href="/bob"');
    expect(html).toContain(">bob</a>");
    expect(html).toContain("<i>Note:</i> spam waves");
    expect(html).toContain('name="action" value="unblock"');
    expect(html).toContain('name="blockee" value="bob"');
    expect(html).toContain(`>${userSettingsBlockedLocale.unblock}</button>`);
  });

  it("renders the empty arm when nothing is blocked", async () => {
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    const html = renderToString(<UserSettingsBlockedPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain(userSettingsBlockedLocale.list_none);
  });

  it("renders NO note-edit dead controls (the reduction — no arm, no modal, no opener)", async () => {
    const bob = await seedBlockee("bob");
    await seedBlock(bob, "kept");
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    const html = renderToString(<UserSettingsBlockedPage ctx={ctx} data={data} error={null} />);
    expect(html).not.toContain("show-modal");
    expect(html).not.toContain("block-user-note-modal");
    expect(html).not.toContain('value="note"');
    expect(html).not.toContain(userSettingsBlockedLocale.note_unavailable); // the absence note is a write answer, not a page element
  });

  it("the invalid-POST re-render carries the negative message banner", async () => {
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    const html = renderToString(<UserSettingsBlockedPage ctx={ctx} data={data} error="Failed to block user: cannot block the user" />);
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("Failed to block user: cannot block the user");
  });

  it("the cap renders 50 unblock forms and no pager (the DOM face of the loader cap)", async () => {
    for (let i = 0; i <= USER_BLOCKED_USERS_LIST_LIMIT; i++) {
      const blockee = await seedBlockee(`bulk${String(i).padStart(2, "0")}`);
      await seedBlock(blockee);
    }
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    const html = renderToString(<UserSettingsBlockedPage ctx={ctx} data={data} error={null} />);
    expect((html.match(/value="unblock"/g) ?? []).length).toBe(USER_BLOCKED_USERS_LIST_LIMIT);
    expect(html).not.toContain('href="/bulk50"'); // the cap casualty
    expect(html).not.toContain("pagination"); // upstream's template has no pager to reproduce
  });

  // The shared navbar pins (the org twin's navbar test, user scope): the
  // Blocked-users item went LIVE with this module (user navbar.tmpl:25-27,
  // between Security and Applications) — order + active + the still-dead
  // Audit item.
  it("the shared navbar renders the Blocked-users item active, in upstream order, Audit still dead", async () => {
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    const html = renderToString(<UserSettingsBlockedPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain('class="active item" href="/user/settings/blocked_users"');
    expect(html).toContain(userSettingsBlockedLocale.blocked_users);
    // navbar.tmpl order: Security (:20-24) < Blocked users (:25-27) <
    // Applications (:28-30). Exactly one match each — the full quoted
    // attributes so a shorter needle cannot match a longer sibling href.
    const securityAt = html.indexOf('href="/user/settings/security"');
    const blockedAt = html.indexOf('href="/user/settings/blocked_users"');
    const applicationsAt = html.indexOf('href="/user/settings/applications"');
    expect(securityAt).toBeGreaterThanOrEqual(0);
    expect(blockedAt).toBeGreaterThan(securityAt);
    expect(applicationsAt).toBeGreaterThan(blockedAt);
    expect(html).not.toContain('href="/user/settings/audit_logs"'); // Audit (:36-38) stays dead
  });

  it("marks exactly one active anchor on the page render", async () => {
    const data = await loadUserBlockedUsers(env.DB, doer().id);
    const html = renderToString(<UserSettingsBlockedPage ctx={ctx} data={data} error={null} />);
    expect(html.match(/class="active item" href=/g)?.length).toBe(1);
  });
});

// --- the shared component's own pin (mirrors settings-nav.test.tsx's union pin) ----

describe("UserSettingsNavbar active=blocked-users (the union member this module lights)", () => {
  it("renders the blocked_users anchor active and exactly one active anchor", () => {
    const html = renderToString(<UserSettingsNavbar active="blocked-users" />);
    expect(html).toContain('class="active item" href="/user/settings/blocked_users"');
    expect(html.match(/class="active item" href=/g)?.length).toBe(1);
  });
});

// --- fixture sanity ---------------------------------------------------------------

describe("the fixture store", () => {
  it("the seeded viewer row round-trips through the loader untouched", async () => {
    const row = await drizzle(env.DB).select().from(users).where(eq(users.id, doer().id)).get();
    expect(row?.username).toBe("alice");
  });
});
