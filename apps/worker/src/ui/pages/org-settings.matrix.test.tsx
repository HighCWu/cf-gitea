/**
 * The org settings OPTIONS + DANGER arms' DEFERRED route-level matrix (the
 * polish wave, after the wave-49 mount — pages/org-settings.tsx over
 * index.ts's orgSettings* handlers): the MINTED-SESSION route arms driven
 * through `uiRouter.fetch()` on the real production path (parse →
 * resolveUiSession → the shared org-teams prologue → load → render — the
 * org-settings-hooks matrix 41bc9ab pattern), one fresh org world per test
 * behind per-test table wipes + an R2 avatar-prefix sweep.
 *
 * De-dup line: the wave-49 suite (src/ui/__tests__/pages-wave49-org-settings
 * .test.ts) keeps the parser families, the DOM contract, the owner's happy
 * paths and the typed failure texts over its SHARED fixture world; the team
 * edit/delete arms live there too and are NOT re-driven here. This file
 * holds the arms that suite leaves open, at ROUTE level:
 *
 *   - the gates on the fresh world: the anonymous 303 onto the login
 *     round-trip on GET **and on every same-origin write POST** (the §2.8
 *     guard passes, then the signed-in gate fronts the write — nothing
 *     written anywhere), the non-owner 404 shells (a plain member AND a
 *     signed-in outsider) BEFORE any write on all six write arms, and the
 *     site admin's 200;
 *   - the options round-trip (POST → 303 → the follow-up GET renders every
 *     submitted value with the checked Permissions box) and the CARRIED
 *     form on the invalid arms: a failed rename confirmation re-renders the
 *     WHOLE settings page at 200 — banner + the stored options values in
 *     the inputs, the org row untouched in D1;
 *   - the avatar write pair's read-back beyond wave-49's existence flag:
 *     the stored R2 object's exact bytes + content type, the
 *     `users.use_custom_avatar` marker, the page's live serving-seam
 *     `<img>`, and the delete-nothing arm's silent success;
 *   - the rename 307/redirect semantics: success 303s onto the NEW name's
 *     settings page, the `user_redirects` row reads back, and the shared
 *     resolve seam 307s the old name for the owner (query preserved), for
 *     ANONYMOUS viewers (the seam precedes the login 303) and on a write
 *     POST path;
 *   - the danger delete arm's D1 cascade read-back: the still-owns-repos
 *     refusal leaves the repo row standing, the emptied org's delete 303s
 *     onto the site root and the org's users row, memberships AND the
 *     rename's redirect row all read back gone (the old name 404-shells
 *     afterwards — the redirect died with the org);
 *   - the §2.8 cross-origin 403 before any write on ALL SIX write arms
 *     (wave-49 pins it on the options POST only);
 *   - the claim pin (the blocked-users matrix's pin): the settings family
 *     claims exactly its six shapes (the trailing slash folding onto the
 *     canonical shape); misspelled and deeper tails stay unclaimed — parse
 *     null, `handlesUiRoute` false, and a direct fetch through the mount
 *     answers the sub-app's bare 404, never the settings page;
 *   - the visibility arm's page posture: the flip lands in D1 and the
 *     danger-zone radios re-render the new state (wave-49 reads D1 only).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { avatarExists } from "../../services/avatars";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { UiManifest } from "../manifest";
import { orgMembers, repositories, userRedirects, users } from "../../db/schema";
import { locale } from "../locale";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** Tables the fixtures and the write arms touch (children first — the
 *  blocked-users harness's cleanup-list convention; "sessions" explicit
 *  because the route matrix mints session rows per request, and
 *  "repositories" because the world seeds one through the landed
 *  RepoService for the still-owns-repos refusal arm — repo_counters is the
 *  schema's ONE enforced FK child, wiped ahead of it). */
const FIXTURE_TABLES = ["repo_counters", "repositories", "user_redirects", "org_members", "sessions", "users"];

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of FIXTURE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The avatar objects live in R2, outside the D1 wipes — sweep the shared
  // `avatars/` prefix so the pair's read-backs start from a clean bucket.
  const listed = await env.REPO_PACKS.list({ prefix: "avatars/" });
  for (const object of listed.objects) {
    await env.REPO_PACKS.delete(object.key);
  }
});

/** A minimal valid PNG (1x1) — the avatar processor's accepted input; small
 *  enough to store VERBATIM (under the origin cap, no resize on Workers). */
const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

/** The route world's REAL rows: the orgs through the LANDED `OrgService
 *  .createOrg` (the same arm the create page serves), the plain repo through
 *  the landed `RepoService` (the delete refusal's still-owns ammunition):
 *  `optforge` (alice owner, bob plain member, one repo) carries the options/
 *  avatar/rename arms, `delforge` (alice owner, zero repos) the delete
 *  cascade, `rivalforge` (carol's own org) makes carol a signed-in OUTSIDER
 *  for optforge. Ids are captured at seed time — never hardcoded. */
interface SettingsWorld {
  orgUserId: number; // optforge's users-row id — the org's principal id
  deleteOrgUserId: number; // delforge's users-row id (the cascade arm's key)
  ownerId: number; // alice
  memberId: number; // bob (inside, but no ownership)
  outsiderId: number; // carol (owns only rivalforge)
  adminId: number; // dave (site admin)
}

const OPTIONS_ORG = "optforge";
const DELETE_ORG = "delforge";

async function seedSettingsWorld(): Promise<SettingsWorld> {
  const db = drizzle(env.DB);
  const inserted = await db
    .insert(users)
    .values([
      { username: "alice", usernameLower: "alice", status: "active", createdAt: T0 },
      { username: "bob", usernameLower: "bob", status: "active", createdAt: T0 },
      { username: "carol", usernameLower: "carol", status: "active", createdAt: T0 },
      { username: "dave", usernameLower: "dave", isAdmin: true, status: "active", createdAt: T0 },
    ])
    .returning({ id: users.id })
    .all();
  const [alice, bob, carol, dave] = inserted;
  if (alice === undefined || bob === undefined || carol === undefined || dave === undefined) {
    throw new Error("settings world seed failed");
  }
  const orgs = new OrgService(env.DB);
  const optforge = await orgs.createOrg({ name: OPTIONS_ORG, ownerId: alice.id, visibility: "public", now: T0 });
  const delforge = await orgs.createOrg({ name: DELETE_ORG, ownerId: alice.id, visibility: "public", now: T0 });
  await orgs.createOrg({ name: "rivalforge", ownerId: carol.id, visibility: "public", now: T0 });
  // The repo row is uncaptured — its existence (the delete refusal's
  // ammunition) is the only thing the world needs from it.
  await new RepoService(env.DB).create({
    owner: { id: optforge.id, usernameLower: OPTIONS_ORG },
    name: "repo-one",
    isPrivate: false,
    status: "ready",
  });
  return {
    orgUserId: optforge.id,
    deleteOrgUserId: delforge.id,
    ownerId: alice.id,
    memberId: bob.id,
    outsiderId: carol.id,
    adminId: dave.id,
  };
}

// --- the mounted-route harness (the org-settings-hooks matrix 41bc9ab) --------

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
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A viewer's minted session cookie header (the real mintSession path, minted
 *  per request — the beforeEach users wipe cascades the sessions table, so a
 *  cross-test cache would go stale; the value is never rendered). */
async function sessionCookie(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A GET through the mount (`userId: null` is the anonymous arm). */
async function getRoute(path: string, userId: number | null): Promise<Response> {
  return fetchUi(path, { headers: userId === null ? {} : { cookie: await sessionCookie(userId) } });
}

/** A urlencoded POST through the mount (same-origin by default — the
 *  sameOriginGuard's happy path; pass another origin for the 403 arms;
 *  `userId: null` is the anonymous arm). */
async function postRoute(
  path: string,
  userId: number | null,
  fields: Record<string, string>,
  origin: string = ORIGIN,
): Promise<Response> {
  return fetchUi(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      ...(userId === null ? {} : { cookie: await sessionCookie(userId) }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A multipart avatar POST (upstream AvatarForm's `avatar` file field);
 *  `file: false` posts the empty input (the delete button's formaction arm
 *  rides this same form). */
async function postAvatarRoute(path: string, userId: number | null, file: boolean, origin: string = ORIGIN): Promise<Response> {
  const form = new FormData();
  if (file) form.set("avatar", new Blob([PNG_1X1], { type: "image/png" }), "avatar.png");
  return fetchUi(path, {
    method: "POST",
    headers: { origin, ...(userId === null ? {} : { cookie: await sessionCookie(userId) }) },
    body: form,
  });
}

/** The six write arms of the settings family with their plausible bodies —
 *  the loops over the gates and the §2.8 guard iterate this list. */
function writeArms(): Array<{ path: string; fields: Record<string, string>; avatar?: boolean }> {
  return [
    { path: `/${OPTIONS_ORG}/settings`, fields: { full_name: "written behind a gate" } },
    { path: `/${OPTIONS_ORG}/settings/avatar`, fields: {}, avatar: true },
    { path: `/${OPTIONS_ORG}/settings/avatar/delete`, fields: {} },
    { path: `/${OPTIONS_ORG}/settings/rename`, fields: { org_name: OPTIONS_ORG, new_org_name: "optnova" } },
    { path: `/${OPTIONS_ORG}/settings/delete`, fields: { org_name: OPTIONS_ORG } },
    { path: `/${OPTIONS_ORG}/settings/visibility`, fields: { visibility: "private" } },
  ];
}

/** The 404 fidelity every missing arm shares: the shell answers, never the
 *  settings pages' content. */
async function expectNotFoundShell(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const html = await res.text();
  expect(html).toContain("status-page-error"); // the 404 shell
  expect(html).toContain(locale.error404_box_title);
  expect(html).not.toContain("page-content organization settings options"); // never the options page
}

/** The org row through the landed read (the write arms' round-trip key). */
async function orgRow(name: string) {
  const org = await new OrgService(env.DB).getOrgByUsername(name);
  if (org === null) throw new Error(`org row missing: ${name}`);
  return org;
}

// --- the mounted routes --------------------------------------------------------

describe("the mounted org settings routes (the minted-session route-level matrix)", () => {
  let world: SettingsWorld;

  beforeEach(async () => {
    world = await seedSettingsWorld();
  });

  // -- the gates (the shared org-teams prologue) -----------------------------

  it("303s an anonymous GET onto the login round-trip; the site admin gets the page (the requireOrgOwnership family)", async () => {
    const anon = await getRoute(`/${OPTIONS_ORG}/settings`, null);
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(`/${OPTIONS_ORG}/settings`)}`);
    const admin = await getRoute(`/${OPTIONS_ORG}/settings`, world.adminId);
    expect(admin.status).toBe(200);
    expect(await admin.text()).toContain("page-content organization settings options");
  });

  it("303s an anonymous same-origin POST on every write arm onto the login round-trip (the gate fronts the write; nothing written)", async () => {
    for (const arm of writeArms()) {
      const res = arm.avatar === true
        ? await postAvatarRoute(arm.path, null, true)
        : await postRoute(arm.path, null, arm.fields);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(arm.path)}`);
    }
    // The nothing-written read-back across every store the arms touch: the
    // org row verbatim, no avatar object, no rename redirects, the repo row
    // alive.
    const org = await orgRow(OPTIONS_ORG);
    expect(org.fullName).toBeNull();
    expect(org.repoAdminChangeTeamAccess).toBe(false);
    expect(org.visibility).toBe("public");
    expect(await avatarExists(env.REPO_PACKS, { kind: "org", principalId: world.orgUserId })).toBe(false);
    expect(await drizzle(env.DB).select().from(userRedirects).all()).toHaveLength(0);
    expect(org.username).toBe(OPTIONS_ORG);
    expect(await drizzle(env.DB).select({ id: repositories.id }).from(repositories).all()).toHaveLength(1);
  });

  it("404-shells a signed-in non-owner (plain member AND outsider) on GET and BEFORE every write POST", async () => {
    await expectNotFoundShell(await getRoute(`/${OPTIONS_ORG}/settings`, world.memberId));
    await expectNotFoundShell(await getRoute(`/${OPTIONS_ORG}/settings`, world.outsiderId));
    for (const userId of [world.memberId, world.outsiderId]) {
      for (const arm of writeArms()) {
        const res = arm.avatar === true
          ? await postAvatarRoute(arm.path, userId, true)
          : await postRoute(arm.path, userId, arm.fields);
        await expectNotFoundShell(res);
      }
    }
    // The nothing-written read-back: the intrusion attempts never ran.
    const org = await orgRow(OPTIONS_ORG);
    expect(org.fullName).toBeNull();
    expect(org.username).toBe(OPTIONS_ORG);
    expect(org.visibility).toBe("public");
    expect(await avatarExists(env.REPO_PACKS, { kind: "org", principalId: world.orgUserId })).toBe(false);
    expect(await drizzle(env.DB).select().from(userRedirects).all()).toHaveLength(0);
  });

  // -- the owner's options round-trip + the carried form on the invalid arms --

  it("the owner's options POST round-trips onto the re-rendered page (every field carried, the Permissions box checked)", async () => {
    const res = await postRoute(`/${OPTIONS_ORG}/settings`, world.ownerId, {
      full_name: "Roundtrip Org",
      email: "contact@optforge.example",
      description: "The deferred matrix org.",
      website: "https://optforge.example",
      location: "The workerd",
      repo_admin_change_team_access: "on",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OPTIONS_ORG}/settings`);
    const org = await orgRow(OPTIONS_ORG);
    expect(org.fullName).toBe("Roundtrip Org");
    expect(org.email).toBe("contact@optforge.example");
    expect(org.description).toBe("The deferred matrix org.");
    expect(org.website).toBe("https://optforge.example");
    expect(org.location).toBe("The workerd");
    expect(org.repoAdminChangeTeamAccess).toBe(true);
    // The follow-up GET renders the submitted values in the form controls —
    // the round-trip's re-render half.
    const page = await getRoute(`/${OPTIONS_ORG}/settings`, world.ownerId);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('value="Roundtrip Org"');
    expect(html).toContain('value="contact@optforge.example"');
    expect(html).toContain("The deferred matrix org."); // the textarea's content
    expect(html).toContain('value="https://optforge.example"');
    expect(html).toContain('value="The workerd"');
    expect(html).toContain('name="repo_admin_change_team_access" checked');
  });

  it("the invalid rename arm re-renders the WHOLE settings page with the CARRIED form (stored values survive the banner; the org row untouched)", async () => {
    // Store distinctive options first (the fresh world starts null).
    await postRoute(`/${OPTIONS_ORG}/settings`, world.ownerId, {
      full_name: "Roundtrip Org",
      email: "contact@optforge.example",
      description: "The deferred matrix org.",
      website: "https://optforge.example",
      location: "The workerd",
      repo_admin_change_team_access: "on",
    });
    // A wrong confirmation name → upstream's JSONError arm re-renders at 200.
    const res = await postRoute(`/${OPTIONS_ORG}/settings/rename`, world.ownerId, {
      org_name: "not-optforge",
      new_org_name: "optnova",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content organization settings options"); // the full page, not a partial
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("The organization name you entered is incorrect.");
    // The carried form: every stored options value rides the re-render.
    expect(html).toContain('value="Roundtrip Org"');
    expect(html).toContain('value="contact@optforge.example"');
    expect(html).toContain('name="repo_admin_change_team_access" checked');
    // The org row is untouched — the name did not move, nothing cleared.
    const org = await orgRow(OPTIONS_ORG);
    expect(org.username).toBe(OPTIONS_ORG);
    expect(org.fullName).toBe("Roundtrip Org");
    expect(await drizzle(env.DB).select().from(userRedirects).all()).toHaveLength(0);
  });

  // -- the avatar write pair (the R2 read-back beyond wave-49's exists flag) --

  it("the owner's avatar upload stores the exact bytes and the follow-up page renders the live serving seam", async () => {
    const res = await postAvatarRoute(`/${OPTIONS_ORG}/settings/avatar`, world.ownerId, true);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OPTIONS_ORG}/settings`);
    // The R2 read-back: the stored object at the shared `u_` namespace key is
    // byte-identical (under-cap inputs store VERBATIM) and typed PNG.
    const stored = await env.REPO_PACKS.get(`avatars/u_${world.orgUserId}`);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PNG_1X1);
    expect(stored!.httpMetadata?.contentType).toBe("image/png");
    // The marker flipped (the landed uploadAvatar's users-row write).
    const marker = await drizzle(env.DB)
      .select({ useCustomAvatar: users.useCustomAvatar })
      .from(users)
      .where(eq(users.id, world.orgUserId))
      .get();
    expect(marker?.useCustomAvatar).toBe(true);
    // The page renders the widget's live seam beside the file input.
    const page = await getRoute(`/${OPTIONS_ORG}/settings`, world.ownerId);
    expect(await page.text()).toContain(`src="/user/avatar/${OPTIONS_ORG}/64"`);
  });

  it("the avatar delete arm clears the object and the marker; deleting nothing still 303s silently", async () => {
    await postAvatarRoute(`/${OPTIONS_ORG}/settings/avatar`, world.ownerId, true);
    expect(await avatarExists(env.REPO_PACKS, { kind: "org", principalId: world.orgUserId })).toBe(true);
    const del = await postAvatarRoute(`/${OPTIONS_ORG}/settings/avatar/delete`, world.ownerId, false);
    expect(del.status).toBe(303);
    expect(del.headers.get("location")).toBe(`/${OPTIONS_ORG}/settings`);
    expect(await avatarExists(env.REPO_PACKS, { kind: "org", principalId: world.orgUserId })).toBe(false);
    const marker = await drizzle(env.DB)
      .select({ useCustomAvatar: users.useCustomAvatar })
      .from(users)
      .where(eq(users.id, world.orgUserId))
      .get();
    expect(marker?.useCustomAvatar).toBe(false);
    // The missing-object delete is a success no-op (the API arm's tolerance).
    const delAgain = await postAvatarRoute(`/${OPTIONS_ORG}/settings/avatar/delete`, world.ownerId, false);
    expect(delAgain.status).toBe(303);
    expect(await avatarExists(env.REPO_PACKS, { kind: "org", principalId: world.orgUserId })).toBe(false);
  });

  // -- the rename 307/redirect semantics --------------------------------------

  it("the rename POST 303s onto the NEW name's settings page; the seam 307s the old name for the owner, anonymous viewers and a write POST", async () => {
    const res = await postRoute(`/${OPTIONS_ORG}/settings/rename`, world.ownerId, {
      org_name: OPTIONS_ORG,
      new_org_name: "optnova",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/optnova/settings");
    // The redirect row reads back (the RenameUser port's user_redirects write).
    const redirect = await drizzle(env.DB)
      .select()
      .from(userRedirects)
      .where(eq(userRedirects.lowerName, OPTIONS_ORG))
      .get();
    expect(redirect).toBeDefined();
    expect(redirect!.redirectUserId).toBe(world.orgUserId);
    // The owner's old-name GET rewrites with the query preserved.
    const owner = await getRoute(`/${OPTIONS_ORG}/settings?tab=options`, world.ownerId);
    expect(owner.status).toBe(307);
    expect(owner.headers.get("location")).toBe("/optnova/settings?tab=options");
    // Anonymous: the seam precedes the login 303 in the prologue.
    const anon = await getRoute(`/${OPTIONS_ORG}/settings`, null);
    expect(anon.status).toBe(307);
    expect(anon.headers.get("location")).toBe("/optnova/settings");
    // A write-POST path rewrites the same way (the seam is method-blind).
    const anonPost = await postRoute(`/${OPTIONS_ORG}/settings/visibility`, null, { visibility: "private" });
    expect(anonPost.status).toBe(307);
    expect(anonPost.headers.get("location")).toBe("/optnova/settings/visibility");
    // The target answers 200 behind the new name, carrying the renamed org.
    const target = await getRoute("/optnova/settings", world.ownerId);
    expect(target.status).toBe(200);
    expect(await target.text()).toContain("page-content organization settings options");
  });

  // -- the danger delete arm's D1 cascade read-back ----------------------------

  it("the still-owns-repos refusal keeps the repo row standing (the guard's read-back)", async () => {
    const res = await postRoute(`/${OPTIONS_ORG}/settings/delete`, world.ownerId, { org_name: OPTIONS_ORG });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This organization still owns one or more repositories.");
    expect(await orgRow(OPTIONS_ORG)).toBeDefined();
    const repos = await drizzle(env.DB).select().from(repositories).where(eq(repositories.ownerId, world.orgUserId)).all();
    expect(repos).toHaveLength(1); // the ammunition survived the refused delete
  });

  it("the emptied org's delete 303s onto the site root and the D1 cascade reads back empty (users row, memberships)", async () => {
    const res = await postRoute(`/${DELETE_ORG}/settings/delete`, world.ownerId, { org_name: DELETE_ORG });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    // The cascade's read-back: the org's users row and every membership edge
    // are gone from D1, not just hidden from the service read.
    expect(await new OrgService(env.DB).getOrgByUsername(DELETE_ORG)).toBeNull();
    const orgRowGone = await drizzle(env.DB)
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, world.deleteOrgUserId), eq(users.type, "org")))
      .get();
    expect(orgRowGone).toBeUndefined();
    expect(
      await drizzle(env.DB).select().from(orgMembers).where(eq(orgMembers.orgId, world.deleteOrgUserId)).all(),
    ).toHaveLength(0);
    // Both names 404-shell afterwards — the org resolution misses.
    await expectNotFoundShell(await getRoute(`/${DELETE_ORG}/settings`, world.ownerId));
  });

  it("the cascade also clears the rename's redirect row — the old name 404-shells after the delete instead of 307ing", async () => {
    // Rename first so a redirect row exists (the delete cascade's
    // user_redirects arms have something to sweep).
    const renamed = await postRoute(`/${DELETE_ORG}/settings/rename`, world.ownerId, {
      org_name: DELETE_ORG,
      new_org_name: "delforge2",
    });
    expect(renamed.status).toBe(303);
    expect((await getRoute(`/${DELETE_ORG}/settings`, world.ownerId)).status).toBe(307); // the alias lived
    // Delete the org under its new name.
    const res = await postRoute("/delforge2/settings/delete", world.ownerId, { org_name: "delforge2" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    // The redirect rows read back gone — by the org's id AND by the old name.
    expect(
      await drizzle(env.DB)
        .select()
        .from(userRedirects)
        .where(eq(userRedirects.redirectUserId, world.deleteOrgUserId))
        .all(),
    ).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(userRedirects).where(eq(userRedirects.lowerName, DELETE_ORG)).all()).toHaveLength(0);
    // The old name no longer redirects — the alias died with the org.
    await expectNotFoundShell(await getRoute(`/${DELETE_ORG}/settings`, world.ownerId));
    await expectNotFoundShell(await getRoute("/delforge2/settings", world.ownerId));
  });

  // -- the visibility arm's page posture ---------------------------------------

  it("the visibility flip lands in D1 and the danger-zone radios re-render the new state", async () => {
    const res = await postRoute(`/${OPTIONS_ORG}/settings/visibility`, world.ownerId, { visibility: "limited" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OPTIONS_ORG}/settings`);
    expect((await orgRow(OPTIONS_ORG)).visibility).toBe("limited");
    // The follow-up GET's visibility modal carries the flipped radio.
    const page = await getRoute(`/${OPTIONS_ORG}/settings`, world.ownerId);
    const html = await page.text();
    expect(html).toContain('name="visibility" type="radio" value="limited" checked');
    expect(html).not.toContain('name="visibility" type="radio" value="public" checked');
  });

  // -- the §2.8 guard -----------------------------------------------------------

  it("rejects a cross-origin POST with 403 before any write on all six arms", async () => {
    for (const arm of writeArms()) {
      const res = arm.avatar === true
        ? await postAvatarRoute(arm.path, world.ownerId, true, "https://evil.example")
        : await postRoute(arm.path, world.ownerId, arm.fields, "https://evil.example");
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("cross-origin request rejected");
    }
    // The nothing-written read-back across every store the arms touch.
    const org = await orgRow(OPTIONS_ORG);
    expect(org.fullName).toBeNull();
    expect(org.username).toBe(OPTIONS_ORG);
    expect(org.visibility).toBe("public");
    expect(await avatarExists(env.REPO_PACKS, { kind: "org", principalId: world.orgUserId })).toBe(false);
    expect(await drizzle(env.DB).select().from(userRedirects).all()).toHaveLength(0);
    expect(await new OrgService(env.DB).getOrgByUsername(OPTIONS_ORG)).not.toBeNull();
    expect(await drizzle(env.DB).select({ id: repositories.id }).from(repositories).all()).toHaveLength(1);
  });

  // -- the route claim pin (the blocked-users matrix's pin) ----------------------

  it("the settings family claims exactly its six shapes; misspelled and deeper tails stay unclaimed, the trailing slash folds", () => {
    expect(parseUiRoute(`/${OPTIONS_ORG}/settings`)).toEqual({ family: "org-settings", owner: OPTIONS_ORG });
    expect(parseUiRoute(`/${OPTIONS_ORG}/settings/avatar`)).toEqual({ family: "org-settings-avatar", owner: OPTIONS_ORG });
    expect(parseUiRoute(`/${OPTIONS_ORG}/settings/avatar/delete`)).toEqual({
      family: "org-settings-avatar-delete",
      owner: OPTIONS_ORG,
    });
    expect(parseUiRoute(`/${OPTIONS_ORG}/settings/rename`)).toEqual({ family: "org-settings-rename", owner: OPTIONS_ORG });
    expect(parseUiRoute(`/${OPTIONS_ORG}/settings/delete`)).toEqual({ family: "org-settings-delete", owner: OPTIONS_ORG });
    expect(parseUiRoute(`/${OPTIONS_ORG}/settings/visibility`)).toEqual({
      family: "org-settings-visibility",
      owner: OPTIONS_ORG,
    });
    // The trailing slash folds onto the canonical shape (§4.13 — the parser
    // classifies the trimmed form so the router's 301 admits it).
    expect(parseUiRoute(`/${OPTIONS_ORG}/settings/visibility/`)).toEqual({
      family: "org-settings-visibility",
      owner: OPTIONS_ORG,
    });
    // The tails this family never claimed — parse null, the dispatcher's
    // handlesUiRoute false.
    for (const tail of [
      `/${OPTIONS_ORG}/settings/renamed`, // the misspelling
      `/${OPTIONS_ORG}/settings/avatar/upload`, // a deeper avatar tail
      `/${OPTIONS_ORG}/settings/delete/confirm`, // a deeper delete tail
      `/${OPTIONS_ORG}/settings/visibility/private`, // a deeper visibility tail
    ]) {
      expect(parseUiRoute(tail)).toBeNull();
      expect(handlesUiRoute(tail)).toBe(false);
    }
  });

  it("an unclaimed settings tail through the mount answers the bare 404 — the router does not absorb it", async () => {
    // The uiRouter's registrations end where the parse claim ends: no
    // settings gate ran (NOT a login 303 for the anonymous viewer), no
    // settings page rendered, the sub-app's default 404 answers.
    const anon = await getRoute(`/${OPTIONS_ORG}/settings/renamed`, null);
    expect(anon.status).toBe(404);
    const html = await anon.text();
    expect(html).not.toContain("page-content organization settings options");
    expect(html).not.toContain("signing in"); // never the login round-trip
    // The same posture signed-in on a deeper tail — the family never answered.
    const owner = await getRoute(`/${OPTIONS_ORG}/settings/avatar/upload`, world.ownerId);
    expect(owner.status).toBe(404);
    expect((await owner.text()).includes("page-content organization settings options")).toBe(false);
  });
});
