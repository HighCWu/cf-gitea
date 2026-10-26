/**
 * The org settings BLOCKED USERS tab's tests (the bench-row module, MOUNTED
 * since window-2b 4f2805f — GET+POST /{org}/settings/blocked_users at
 * ui/index.ts): the load/parse/apply matrix over real D1 (generated
 * migrations in beforeAll; the writes go through the landed org-scope block
 * service arms — the same `user_blocking` store the API family's GET/PUT/
 * DELETE read and write, routes/blocks.ts) and the DOM contract of the page
 * render — hono/jsx renderToString, the module driven directly. The
 * deferred-test matrix also drives the real routes (the appearance/
 * organizations matrices' minted-session uiRouter pattern): the org-teams
 * prologue's anonymous-303 / non-owner-404-shell posture on GET and POST,
 * the owner block/unblock round-trips through the real handlers, the exact
 * upstream banner texts on the invalid arms, the guard-first cross-origin
 * 403, the reduced note arm's honest absence through the route, and the
 * list cap posture (BLOCKED_USERS_LIST_LIMIT rows, no pager).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
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
import { OrgSettingsNavbar } from "../components/settings-nav";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { Viewer } from "../viewer";
import {
  BLOCKED_USERS_LIST_LIMIT,
  applyOrgBlockedForm,
  loadOrgBlockedUsers,
  OrgBlockedUsersPage,
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

  // STALE-PIN UPDATE (wave-114 nav swap): the mount-scaffolding
  // OrgSettingsBlockedNav was deleted for the shared
  // components/settings-nav OrgSettingsNavbar rendered with active:
  // "blocked" — the same pins hold against the shared component (which adds
  // the Actions disclosure's Secrets/Variables sub-items).
  it("the shared navbar renders the landed tabs plus the Blocked-users item active", () => {
    const html = renderToString(<OrgSettingsNavbar orgLink="/acme" active="blocked" />);
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

// --- the mounted-route harness (window-2b 4f2805f; the appearance-matrix pattern) --

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → the org-teams
 *  prologue → load → render, on the mounted uiRouter with the synthetic
 *  manifest; the execution context is awaited so waitUntil side-effects
 *  settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the seeded user id (the real
 *  mintSession path, minted per request — the beforeEach users wipe
 *  cascades the sessions table, so a cross-test cache would go stale; the
 *  value is never rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** The fixture owner's minted session header (ids are seed-assigned —
 *  never hardcoded). */
async function ownerSessionHeader(): Promise<string> {
  if (viewer.kind !== "user") throw new Error("fixture viewer missing");
  return sessionHeader(viewer.id);
}

/** A urlencoded POST to the tab through the real route: the browser's
 *  same-origin Origin header (the §2.8 guard's happy path) and the owner's
 *  minted session cookie. */
async function blockedUsersPost(fields: Record<string, string>): Promise<Response> {
  return fetchUi(`/${org.username}/settings/blocked_users`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      cookie: await ownerSessionHeader(),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The owner's GET of the tab through the real route. */
async function blockedUsersGet(): Promise<Response> {
  return fetchUi(`/${org.username}/settings/blocked_users`, {
    headers: { cookie: await ownerSessionHeader() },
  });
}

// --- the mounted routes (window-2b: GET + POST /{org}/settings/blocked_users) ------

describe("the mounted routes (GET + POST /{org}/settings/blocked_users)", () => {
  it("303s an anonymous GET onto the login round-trip (the org-teams prologue)", async () => {
    const res = await fetchUi(`/${org.username}/settings/blocked_users`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/${org.username}/settings/blocked_users`)}`,
    );
  });

  it("303s an anonymous same-origin POST onto the login round-trip too (guard passes, then the signed-in gate; nothing written)", async () => {
    const res = await fetchUi(`/${org.username}/settings/blocked_users`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
      },
      body: new URLSearchParams({ action: "block", blockee: "bob", note: "" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/${org.username}/settings/blocked_users`)}`,
    );
    expect((await loadOrgBlockedUsers(env.DB, org.record)).blocks).toEqual([]);
  });

  it("404-shells a signed-in non-owner's GET (the RequireOwner posture)", async () => {
    const bob = await seedBlockee("bob");
    const res = await fetchUi(`/${org.username}/settings/blocked_users`, {
      headers: { cookie: await sessionHeader(bob.id) },
    });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error"); // the 404 shell
    expect(html).not.toContain("org-setting-content"); // never the tab's content
  });

  it("404-shells a signed-in non-owner's block POST before any write (the ownership gate fronts the write arm too)", async () => {
    const bob = await seedBlockee("bob");
    const res = await fetchUi(`/${org.username}/settings/blocked_users`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        cookie: await sessionHeader(bob.id),
      },
      body: new URLSearchParams({ action: "block", blockee: "bob", note: "" }).toString(),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect((await loadOrgBlockedUsers(env.DB, org.record)).blocks).toEqual([]);
  });

  it("renders the owner's GET at 200 with the discriminator and the active navbar item", async () => {
    const res = await blockedUsersGet();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("organization settings blocked_users"); // the §2.4.1 pageClass
    expect(html).toContain(`class="active item" href="/${org.username}/settings/blocked_users"`);
    expect(html).toContain(orgSettingsBlockedLocale.list_none); // the empty arm
  });

  it("a block POST 303s back onto the tab, the row lands, and the follow-up GET renders it", async () => {
    await seedBlockee("bob");
    const res = await blockedUsersPost({ action: "block", blockee: "bob", note: "spam waves" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${org.username}/settings/blocked_users`);
    const data = await loadOrgBlockedUsers(env.DB, org.record);
    expect(data.blocks.map((row) => [row.blockee.username, row.note])).toEqual([["bob", "spam waves"]]);
    const page = await blockedUsersGet();
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="blockee" value="bob"'); // the row's unblock form
  });

  it("an unblock POST 303s back onto the tab, the row is gone, and the follow-up GET renders the empty arm", async () => {
    const bob = await seedBlockee("bob");
    await seedBlock(bob, "spam");
    const res = await blockedUsersPost({ action: "unblock", blockee: "bob", note: "" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${org.username}/settings/blocked_users`);
    expect((await loadOrgBlockedUsers(env.DB, org.record)).blocks).toEqual([]);
    const page = await blockedUsersGet();
    expect(await page.text()).toContain(orgSettingsBlockedLocale.list_none);
  });

  it("an unknown blockee re-renders at 200 with upstream's exact target-not-found banner, nothing written", async () => {
    const res = await blockedUsersPost({ action: "block", blockee: "ghost", note: "" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("The target couldn&#39;t be found."); // error.not_found, hono-escaped
    expect((await loadOrgBlockedUsers(env.DB, org.record)).blocks).toEqual([]);
  });

  it("a re-block re-renders the upstream failure wrap and the fresh load still lists the row", async () => {
    const bob = await seedBlockee("bob");
    await seedBlock(bob);
    const res = await blockedUsersPost({ action: "block", blockee: "bob", note: "" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Failed to block user: cannot block the user"); // user.block.block.failure
    expect(html).toContain('name="blockee" value="bob"'); // the re-render's fresh load keeps the row
  });

  it("an org blockee re-renders the upstream ErrBlockOrganization wrap through the route", async () => {
    const res = await blockedUsersPost({ action: "block", blockee: "acme", note: "" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Failed to block user: cannot block an organization");
  });

  it("unblocking a pair that is not blocked re-renders the upstream unblock failure wrap", async () => {
    await seedBlockee("bob"); // exists; the pair was never blocked
    const res = await blockedUsersPost({ action: "unblock", blockee: "bob", note: "" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Failed to unblock user: cannot unblock the user");
  });

  it("the reduced note arm POST re-renders the honest-absence banner and never writes (never emitted by this DOM)", async () => {
    await seedBlockee("bob");
    const res = await blockedUsersPost({ action: "note", blockee: "bob", note: "x" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="ui negative message"');
    // The apostrophe rides hono's escape (&#39;) — assert the rendered form.
    expect(html).toContain(
      "Editing the note is not supported yet: no landed write arm updates a stored block&#39;s note.",
    );
    expect((await loadOrgBlockedUsers(env.DB, org.record)).blocks).toEqual([]); // no edge was created
  });

  it("rejects a cross-origin block POST with 403 before any write (sameOriginGuard first)", async () => {
    await seedBlockee("bob");
    const res = await fetchUi(`/${org.username}/settings/blocked_users`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        cookie: await ownerSessionHeader(),
      },
      body: new URLSearchParams({ action: "block", blockee: "bob", note: "" }).toString(),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect((await loadOrgBlockedUsers(env.DB, org.record)).blocks).toEqual([]); // nothing was written
  });

  it("the list cap: 51 blocked users render the first 50 rows only, with no pager (the reduction)", async () => {
    // id ASC order — bulk00..bulk49 fill the page; bulk50 (seeded last, the
    // highest id) is the cap casualty.
    for (let i = 0; i <= BLOCKED_USERS_LIST_LIMIT; i++) {
      const blockee = await seedBlockee(`bulk${String(i).padStart(2, "0")}`);
      await seedBlock(blockee);
    }
    const page = await blockedUsersGet();
    expect(page.status).toBe(200);
    const html = await page.text();
    expect((html.match(/value="unblock"/g) ?? []).length).toBe(BLOCKED_USERS_LIST_LIMIT);
    expect(html).toContain('href="/bulk00"'); // the head of the id-ASC page
    expect(html).not.toContain('href="/bulk50"'); // the cap casualty
    expect(html).not.toContain("pagination"); // upstream's template has no pager to reproduce
  });
});

// --- the route claim pin (parse ↔ registration — the organizations-matrix pin) ------

describe("the route claim pin (the settings family claims exactly the blocked_users tab)", () => {
  it("parses the GET/POST shape; misspelled or deeper tails stay unclaimed", () => {
    expect(parseUiRoute(`/${org.username}/settings/blocked_users`)).toEqual({
      family: "org-settings-blocked",
      owner: org.username,
    });
    expect(handlesUiRoute(`/${org.username}/settings/blocked_users`)).toBe(true);
    expect(parseUiRoute(`/${org.username}/settings/blocked_user`)).toBeNull(); // the singular misspelling
    expect(parseUiRoute(`/${org.username}/settings/blocked_users/extra`)).toBeNull();
    expect(handlesUiRoute(`/${org.username}/settings/blocked_users/extra`)).toBe(false);
  });
});
