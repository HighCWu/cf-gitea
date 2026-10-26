/**
 * The org settings BLOCKED USERS tab's tests (the bench-row UNMOUNTED module
 * — the repo-settings-wiki.test.tsx harness): the load/parse/apply matrix
 * over real D1 (generated migrations in beforeAll; the writes go through the
 * landed org-scope block service arms — the same `user_blocking` store the
 * API family's GET/PUT/DELETE read and write, routes/blocks.ts) and the DOM
 * contract of the page render — hono/jsx renderToString, the module driven
 * directly (no route yet: the HANDOFF NOTE in the module header).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { blockUser } from "../../api/services/blocks";
import { orgMembers, users } from "../../db/schema";
import type { OrgRecord } from "../../services/orgs/orgs";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  applyOrgBlockedForm,
  loadOrgBlockedUsers,
  OrgBlockedUsersPage,
  OrgSettingsBlockedNav,
  orgSettingsBlockedLocale,
  parseOrgBlockedForm,
  renderOrgBlockedUsersPage,
} from "./org-settings-blocked";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The signed-in owner viewing the page (ids assigned at seed time — never
 *  hardcoded). */
let viewer: Viewer = { kind: "anonymous" };
let ctx: UiContext;

/** The write doer (the route stage's signed-in owner — requireOrgOwnership's
 *  precondition, mirrored by the seeded owner membership). */
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

/** The seeded org row plus its OrgRecord projection (the org-settings family's
 *  render input). */
let org: { id: number; username: string; record: OrgRecord };

const ORG_CREATED = new Date("2026-01-01T00:00:00Z");

function orgRecord(id: number, username: string): OrgRecord {
  return {
    id,
    username,
    usernameLower: username.toLowerCase(),
    email: null,
    fullName: null,
    description: null,
    website: null,
    location: null,
    avatarEmail: null,
    useCustomAvatar: false,
    visibility: "public",
    numMembers: 0,
    repoAdminChangeTeamAccess: false,
    createdAt: ORG_CREATED,
  };
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["user_blocking", "org_members", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The signed-in owner + the org, with the owner-membership row the route
  // stage's requireOrgOwnership precondition promises (services/orgs.ts —
  // org owner role='owner').
  const alice = await seedUser("alice");
  viewer = { kind: "user", id: alice.id, username: alice.username, isAdmin: false };
  ctx = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };
  const row = await seedUser("acme", "org");
  await drizzle(env.DB)
    .insert(orgMembers)
    .values({ orgId: row.id, userId: alice.id, role: "owner", createdAt: ORG_CREATED })
    .run();
  org = { id: row.id, username: row.username, record: orgRecord(row.id, row.username) };
});

/** Block through the landed org-scope service arm (the page's own write) —
 *  the fixture seam the API family's PUT arm serves through too. */
async function seedBlock(blockee: SeededUser, note = ""): Promise<void> {
  await blockUser(
    env.DB,
    doer(),
    { id: org.id, isOrg: true, isAdmin: false },
    { id: blockee.id, isOrg: false, isAdmin: false },
    note,
  );
}

async function seedBlockee(username: string): Promise<SeededUser> {
  return seedUser(username);
}

// --- the loader ----------------------------------------------------------------

describe("loadOrgBlockedUsers (the organizationListBlocks read arm + the batched notes)", () => {
  it("an empty store loads zero rows", async () => {
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    expect(data.blocks).toEqual([]);
  });

  it("carries the blockees and their notes in id ASC order", async () => {
    const bob = await seedBlockee("bob");
    const carol = await seedBlockee("carol");
    await seedBlock(bob, "spam waves");
    await seedBlock(carol);
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    expect(data.blocks.map((row) => [row.blockee.username, row.note])).toEqual([
      ["bob", "spam waves"],
      ["carol", ""],
    ]);
  });

  it("scopes the notes to THIS org's blocking edges", async () => {
    const bob = await seedBlockee("bob");
    // A different org blocks bob with a note; acme's page must not show it.
    const other = await seedUser("otherorg", "org");
    // The foreign org's owner gate is out of scope here — a site-admin doer
    // clears the service's ownership arm (blocks.ts:383-392) without
    // touching acme's membership.
    await blockUser(
      env.DB,
      { id: doer().id, isAdmin: true },
      { id: other.id, isOrg: true, isAdmin: false },
      { id: bob.id, isOrg: false, isAdmin: false },
      "other org note",
    );
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    expect(data.blocks).toEqual([]);
  });
});

// --- the form parse ------------------------------------------------------------

describe("parseOrgBlockedForm (BlockUserForm: action In(block,unblock,note), blockee Required, note)", () => {
  it("parses the block post with its note", () => {
    expect(parseOrgBlockedForm(new URLSearchParams({ action: "block", blockee: "bob", note: "spam" }))).toEqual({
      action: "block",
      blockee: "bob",
      note: "spam",
    });
  });

  it("parses the unblock post; an absent note stays an empty string", () => {
    expect(parseOrgBlockedForm(new URLSearchParams({ action: "unblock", blockee: "bob" }))).toEqual({
      action: "unblock",
      blockee: "bob",
      note: "",
    });
  });

  it("parses the reduced action=note arm as the note value (the module header's reduction)", () => {
    expect(parseOrgBlockedForm(new URLSearchParams({ action: "note", blockee: "bob", note: "x" })).action).toBe("note");
  });

  it("a failed binding (any out-of-enum action) parses as null", () => {
    expect(parseOrgBlockedForm(new URLSearchParams({ action: "destroy", blockee: "bob" })).action).toBeNull();
    expect(parseOrgBlockedForm(new URLSearchParams({ blockee: "bob" })).action).toBeNull();
  });
});

// --- the write -----------------------------------------------------------------

describe("applyOrgBlockedForm (routes/blocks.ts:366-393's org arms over the landed service)", () => {
  it("blocks through the org arm — the row lands with its note", async () => {
    await seedBlockee("bob");
    const result = await applyOrgBlockedForm(env.DB, org.record, doer(), {
      action: "block",
      blockee: "bob",
      note: "spam",
    });
    expect(result).toEqual({ outcome: "applied" });
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    expect(data.blocks.map((row) => [row.blockee.username, row.note])).toEqual([["bob", "spam"]]);
  });

  it("an unknown blockee — the error.not_found arm (block.go:75-76)", async () => {
    const result = await applyOrgBlockedForm(env.DB, org.record, doer(), { action: "block", blockee: "ghost", note: "" });
    expect(result).toEqual({ outcome: "invalid", message: "The target couldn't be found." });
  });

  it("an org blockee — the ErrBlockOrganization failure text", async () => {
    const result = await applyOrgBlockedForm(env.DB, org.record, doer(), { action: "block", blockee: "acme", note: "" });
    expect(result).toEqual({ outcome: "invalid", message: "Failed to block user: cannot block an organization" });
  });

  it("a re-block is not idempotent — the cannot-block failure text", async () => {
    const bob = await seedBlockee("bob");
    await seedBlock(bob);
    const result = await applyOrgBlockedForm(env.DB, org.record, doer(), { action: "block", blockee: "bob", note: "" });
    expect(result).toEqual({ outcome: "invalid", message: "Failed to block user: cannot block the user" });
  });

  it("an org member cannot be blocked — the service's member gate", async () => {
    const bob = await seedBlockee("bob");
    await drizzle(env.DB)
      .insert(orgMembers)
      .values({ orgId: org.id, userId: bob.id, role: "member", createdAt: new Date("2026-01-01T00:00:00Z") })
      .run();
    const result = await applyOrgBlockedForm(env.DB, org.record, doer(), { action: "block", blockee: "bob", note: "" });
    expect(result).toEqual({ outcome: "invalid", message: "Failed to block user: cannot block the user" });
  });

  it("unblocks through the org arm — the row is gone", async () => {
    const bob = await seedBlockee("bob");
    await seedBlock(bob, "spam");
    const result = await applyOrgBlockedForm(env.DB, org.record, doer(), { action: "unblock", blockee: "bob", note: "" });
    expect(result).toEqual({ outcome: "applied" });
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    expect(data.blocks).toEqual([]);
  });

  it("unblocking a pair that is not blocked — the cannot-unblock failure text", async () => {
    await seedBlockee("bob"); // the user exists; the pair was never blocked
    const result = await applyOrgBlockedForm(env.DB, org.record, doer(), { action: "unblock", blockee: "bob", note: "" });
    expect(result).toEqual({ outcome: "invalid", message: "Failed to unblock user: cannot unblock the user" });
  });

  it("the reduced action=note arm (and a failed binding) answers the honest-absence text", async () => {
    const note = await applyOrgBlockedForm(env.DB, org.record, doer(), { action: "note", blockee: "bob", note: "x" });
    expect(note).toEqual({ outcome: "invalid", message: orgSettingsBlockedLocale.note_unavailable });
    const bound = await applyOrgBlockedForm(env.DB, org.record, doer(), { action: null, blockee: "bob", note: "" });
    expect(bound).toEqual({ outcome: "invalid", message: orgSettingsBlockedLocale.note_unavailable });
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the blocked-users tab DOM (shared/user/blocked_users.tmpl at the pin)", () => {
  it("renders the pageClass discriminator and the full-document render path", async () => {
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    const html = renderToString(<OrgBlockedUsersPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain("organization settings blocked_users"); // the §2.4.1 discriminator
    expect(html).toContain('action="/acme/settings/blocked_users"');
    // The full-document render matches the component path.
    expect(renderOrgBlockedUsersPage({ ctx, data, error: null })).toContain(
      'action="/acme/settings/blocked_users"',
    );
  });

  it("renders the block form: hidden action, the required prompt, the red button, the note field", async () => {
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    const html = renderToString(<OrgBlockedUsersPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain('name="action" value="block"');
    expect(html).toContain('id="search-user-box"');
    expect(html).toContain('name="blockee"');
    expect(html).toContain(`placeholder="${orgSettingsBlockedLocale.search_user}"`);
    expect(html).toContain('autocomplete="off"');
    expect(html).toContain(`>${orgSettingsBlockedLocale.block}</button>`);
    expect(html).toContain(`>${orgSettingsBlockedLocale.note_title}</label>`);
    expect(html).toContain(`>${orgSettingsBlockedLocale.note_info}</p>`);
  });

  it("renders the info segment with the upstream docs link", async () => {
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    const html = renderToString(<OrgBlockedUsersPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain(orgSettingsBlockedLocale.info);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('href="https://docs.gitea.com/usage/access-control/blocking-user"');
    expect(html).toContain(orgSettingsBlockedLocale.info_docs);
  });

  it("renders the rows: avatar seam img, HomeLink title, the note arm, the unblock form", async () => {
    const bob = await seedBlockee("bob");
    await seedBlock(bob, "spam waves");
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    const html = renderToString(<OrgBlockedUsersPage ctx={ctx} data={data} error={null} />);
    // The 28px default avatar (util_avatar.go:39-44) through the serving seam.
    expect(html).toContain('src="/user/avatar/bob/28"');
    expect(html).toContain('width="28"');
    expect(html).toContain('href="/bob"');
    expect(html).toContain(">bob</a>");
    expect(html).toContain("<i>Note:</i> spam waves");
    expect(html).toContain('name="action" value="unblock"');
    expect(html).toContain('name="blockee" value="bob"');
    expect(html).toContain(`>${orgSettingsBlockedLocale.unblock}</button>`);
  });

  it("renders the empty arm when nothing is blocked", async () => {
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    const html = renderToString(<OrgBlockedUsersPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain(orgSettingsBlockedLocale.list_none);
  });

  it("renders NO note-edit dead controls (the reduction — no arm, no modal, no opener)", async () => {
    const bob = await seedBlockee("bob");
    await seedBlock(bob, "kept");
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    const html = renderToString(<OrgBlockedUsersPage ctx={ctx} data={data} error={null} />);
    expect(html).not.toContain("show-modal");
    expect(html).not.toContain("block-user-note-modal");
    expect(html).not.toContain('value="note"');
    expect(html).not.toContain(orgSettingsBlockedLocale.note_unavailable); // the absence note is a write answer, not a page element
  });

  it("the invalid-POST re-render carries the negative message banner", async () => {
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    const html = renderToString(<OrgBlockedUsersPage ctx={ctx} data={data} error="Failed to block user: cannot block the user" />);
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("Failed to block user: cannot block the user");
  });

  it("the nav scaffold renders the landed tabs plus the Blocked-users item active", () => {
    const html = renderToString(<OrgSettingsBlockedNav orgLink="/acme" />);
    expect(html).toContain('class="flex-container-nav"');
    expect(html).toContain('href="/acme/settings"'); // Options
    expect(html).toContain('href="/acme/settings/hooks"'); // Hooks
    expect(html).toContain('href="/acme/labels"'); // Labels
    expect(html).toContain('class="active item" href="/acme/settings/blocked_users"');
    expect(html).toContain(orgSettingsBlockedLocale.blocked_users);
  });
});

// --- fixture sanity ---------------------------------------------------------------

describe("the fixture store", () => {
  it("the seeded org row round-trips through the loader untouched", async () => {
    const row = await drizzle(env.DB).select().from(users).where(eq(users.id, org.id)).get();
    expect(row?.username).toBe("acme");
  });
});
