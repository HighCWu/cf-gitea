/**
 * The admin user EDIT page's module-level suite (PORT-FIRST: the GET+POST
 * combo lives behind the orchestrator's index.ts fold — the recipe is the
 * module header's; the seams drive directly, the admin-user-detail.test
 * pattern).
 *
 * Coverage (upstream at the pin: web.go:820's
 * `m.Combo("/{userid}/edit").Get(admin.EditUser).Post(web.Bind[*forms.AdminEditUserForm](), admin.EditUserPost)`,
 * routers/web/admin/users.go:391-557 over prepareUserInfo, and
 * templates/admin/user/edit.tmpl):
 *
 *   - THE LOADER (prepareUserInfo): the unknown-id null — the caller's 303
 *     onto the LIST, never a 404 — the sources pull, the
 *     CanConvertUserType gate (plain user yes / admin no / org no), and
 *     the TwoFactorEnabled read (the landed two_factor row is the TOTP
 *     half; WebAuthn's half is the constant false).
 *   - THE RENDER (edit.tmpl): the shell chrome (`admin edit user`), the
 *     field values, the visibility dropdown's 0/1/2 wire values, the
 *     auth-source dropdown (Local + the landed login_sources), the
 *     checkbox block's checked/disabled/hidden arms (the DEFAULT-config
 *     render for git-hook/import-local), the self-disabled prohibit arm,
 *     the CanConvertUserType and TwoFactorEnabled gates, the avatar fold
 *     (the landed seams' forms), the error banner + flagged field
 *     (RenderWithErrDeprecated), and the dead arms (no delete modal, no
 *     language field).
 *   - THE SUBMIT round-trip per field group (EditUserPost's ladder): the
 *     profile columns (full_name+display_name/website/location/
 *     visibility), the email arm (change / case-fold no-op / duplicate /
 *     the silent format bind / the org target), the rename arm (user rows
 *     through the module-local mirror: redirect row + owner_namespace
 *     rewrite; case-only flip; org rows through the landed
 *     OrgService.renameOrg; the collision/reserved/chars error texts), the
 *     flag folds (status deviation-6, admin with the last-admin guard, the
 *     skip-self prohibit guard), the PASSWORD ARM'S VALIDATION SHAPES
 *     (deviation 1: accepted-and-ignored — no length/complexity/pwned arm
 *     exists to hit), the type arms (Bot on user/admin/org; junk at the
 *     bind), the reset-2FA arm, the bind arms (silent flagged
 *     re-renders), and the unknown-target LIST redirect.
 *
 * THE ADMIN GATE is wiring-level (adminPagePrologue — the seams here are
 * POST-gate inputs, the matrix-harness posture: "the module trusts its
 * inputs"); its arms (anonymous 303 onto the login round-trip, non-admin
 * 404-shell) ride the orchestrator's index.test.ts fold test exactly like
 * the detail/avatar/impersonate landings — the recipe lines are in the
 * module header.
 *
 * Fixture discipline: tables wiped per test (children first), ids captured
 * at seed time — never hardcoded.
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { loginSources, repositories, twoFactor, userRedirects, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { adminUserLink } from "./admin-users-avatar";
import {
  ADMIN_USERS_LIST_LINK,
  adminUserEditLocale,
  loadAdminUserEdit,
  parseAdminUserEditForm,
  renderAdminUserEditPage,
  submitAdminUserEdit,
} from "./admin-user-edit";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date("2026-01-01T00:00:00Z");

/** Tables the fixtures touch (children first — the detail suite's list
 *  plus the login_source/two_factor pairs this suite seeds). */
const FIXTURE_TABLES = [
  "sessions",
  "external_login_user",
  "login_source",
  "two_factor",
  "email_addresses",
  "repo_settings",
  "repositories",
  "user_redirects",
  "org_members",
  "teams",
  "users",
];

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The signed-in site admin viewing/submitting the page (the route stage's
 *  posture — adminPagePrologue gates it; the seams are post-gate). */
let adminViewer: Viewer = { kind: "anonymous" };
let ctx: UiContext;

interface Seeded {
  adminId: number;
  aliceId: number;
  bobId: number;
  orgId: number;
  secondAdminId: number;
  sourceId: number;
}

async function seedUser(
  options: Parameters<typeof seedVerifiedUser>[0] & {
    email?: string;
    fullName?: string | null;
    location?: string | null;
    website?: string | null;
    visibility?: "public" | "limited" | "private";
    type?: "user" | "org";
  },
): Promise<{ id: number; username: string }> {
  const seeded = await seedVerifiedUser(options);
  const extra = options.email ?? options.fullName ?? options.location ?? options.website ?? options.visibility ?? options.type;
  if (extra !== undefined) {
    await drizzle(env.DB)
      .update(users)
      .set({
        email: options.email ?? null,
        fullName: options.fullName ?? null,
        location: options.location ?? null,
        website: options.website ?? null,
        visibility: options.visibility,
        type: options.type,
      })
      .where(eq(users.id, seeded.id))
      .run();
  }
  return seeded;
}

async function seedEdit(): Promise<Seeded> {
  const admin = await seedVerifiedUser({ username: "edit-admin", isAdmin: true });
  adminViewer = { kind: "user", id: admin.id, username: admin.username, isAdmin: true };
  ctx = { viewer: adminViewer, origin: "https://test.local", assets: shellAssetsFromManifest(manifest) };

  const alice = await seedUser({
    username: "edit-alice",
    email: "alice@example.com",
    fullName: "Alice Doe",
    location: "Berlin",
    website: "https://alice.example",
  });
  const bob = await seedUser({ username: "edit-bob", email: "bob@example.com" });
  const secondAdmin = await seedVerifiedUser({ username: "edit-root", isAdmin: true });
  const org = await seedUser({ username: "edit-org", type: "org", email: "forge@example.com" });

  // The auth source the dropdown lists (FindSources — every row, name ASC).
  const source = (
    await drizzle(env.DB)
      .insert(loginSources)
      .values({ type: 6, name: "corp-oidc", cfg: "{}", createdAt: T0, updatedAt: T0 })
      .returning({ id: loginSources.id })
      .all()
  )[0]!;

  // An owned repo — the rename arm's owner_namespace rewrite target.
  await drizzle(env.DB)
    .insert(repositories)
    .values({
      id: "9201",
      storageKey: "r_9201",
      ownerNamespace: "edit-alice",
      ownerId: alice.id,
      slug: "alpha",
      visibility: "public",
      forkParent: null,
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: T0,
    })
    .run();

  return { adminId: admin.id, aliceId: alice.id, bobId: bob.id, orgId: org.id, secondAdminId: secondAdmin.id, sourceId: source.id };
}

async function seedTwoFactor(userId: number): Promise<void> {
  const unix = Math.floor(T0.getTime() / 1000); // raw unix seconds (no timestamp mode on the pair)
  await drizzle(env.DB)
    .insert(twoFactor)
    .values({ userId, secret: "JBSWY3DPEHPK3PXP", scratchSalt: "salt", scratchHash: "hash", createdUnix: unix, updatedUnix: unix })
    .run();
}

/** The full edit POST for ALICE — every text field the template posts, at
 *  the row's current values; `checked` names the posted checkboxes
 *  (presence = checked, the org-settings parse convention). */
function aliceForm(overrides: Record<string, string> = {}, checked: string[] = ["active"]): URLSearchParams {
  const form = new URLSearchParams({
    user_name: "",
    user_type: "",
    login_type: "0-0",
    login_name: "",
    full_name: "Alice Doe",
    email: "alice@example.com",
    password: "",
    website: "https://alice.example",
    location: "Berlin",
    max_repo_creation: "-1",
    visibility: "0",
    ...overrides,
  });
  for (const name of checked) form.set(name, "on");
  return form;
}

/** A blank edit POST carrying just the target's own email — for submits
 *  against OTHER rows (the admin demotions, the type arms) that must not
 *  collide with alice's address nor overwrite her values onto them. */
function blankForm(email: string, checked: string[] = ["active"], overrides: Record<string, string> = {}): URLSearchParams {
  return aliceForm({ full_name: "", email, password: "", website: "", location: "", ...overrides }, checked);
}

async function submit(seeded: Seeded, form: URLSearchParams, doerId = seeded.adminId, targetId = seeded.aliceId) {
  return submitAdminUserEdit(env.DB, targetId, doerId, parseAdminUserEditForm(form));
}

async function rowOf(userId: number) {
  return (await drizzle(env.DB).select().from(users).where(eq(users.id, userId)).get())!;
}

async function renderEdit(seeded: Seeded, userId = seeded.aliceId, extra: { error?: string; errorField?: "email" } = {}) {
  const data = (await loadAdminUserEdit(env.DB, userId))!;
  return renderAdminUserEditPage(ctx, { ...data, error: extra.error ?? null, errorField: extra.errorField ?? null });
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of FIXTURE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the loader -----------------------------------------------------------------

describe("the loader (EditUser's data pull over prepareUserInfo)", () => {
  it("an unknown id answers null — the LIST-redirect arm, never a 404", async () => {
    const seeded = await seedEdit();
    expect(await loadAdminUserEdit(env.DB, seeded.aliceId + 10_000)).toBeNull();
    expect(ADMIN_USERS_LIST_LINK).toBe("/-/admin/users");
  });

  it("pulls the row, the sources, the CanConvertUserType gate, and the 2FA read", async () => {
    const seeded = await seedEdit();
    await seedTwoFactor(seeded.aliceId);

    const alice = (await loadAdminUserEdit(env.DB, seeded.aliceId))!;
    expect(alice.user.email).toBe("alice@example.com");
    expect(alice.canConvertUserType).toBe(true);
    expect(alice.twoFactorEnabled).toBe(true);
    expect(alice.sources.map((source) => source.id)).toEqual([seeded.sourceId]);

    // The gate's arms: admins and orgs cannot convert (CheckConvertUserType).
    expect((await loadAdminUserEdit(env.DB, seeded.adminId))!.canConvertUserType).toBe(false);
    expect((await loadAdminUserEdit(env.DB, seeded.orgId))!.canConvertUserType).toBe(false);

    // No TOTP row → the constant-false posture (WebAuthn has no store).
    const bob = (await loadAdminUserEdit(env.DB, seeded.bobId))!;
    expect(bob.twoFactorEnabled).toBe(false);
  });
});

// --- the render -----------------------------------------------------------------

describe("the render (edit.tmpl at the pin)", () => {
  it("carries the family shell chrome: pageClass `admin edit user`, the active users item, the Title, the form action", async () => {
    const seeded = await seedEdit();
    const html = await renderEdit(seeded);
    expect(html).toContain('class="page-content admin edit user"');
    expect(html).toContain(adminUserEditLocale.edit_account);
    expect(html).toContain('class="active item" href="/-/admin/users"');
    expect(html).toContain(`action="/-/admin/users/${seeded.aliceId}/edit" method="post"`);
  });

  it("renders the row's values into the field set (name/full name/email/website/location)", async () => {
    const seeded = await seedEdit();
    const html = await renderEdit(seeded);
    expect(html).toContain('id="user_name" name="user_name" value="edit-alice" maxlength="40"');
    expect(html).toContain('name="full_name" value="Alice Doe"');
    expect(html).toContain('name="email" type="email" value="alice@example.com" required');
    expect(html).toContain('name="website" type="url" value="https://alice.example"');
    expect(html).toContain('name="location" value="Berlin"');
    // The password field renders for parity and NEVER echoes; the helper rides.
    expect(html).toContain('name="password" type="password" autocomplete="new-password"');
    expect(html).toContain(adminUserEditLocale.password_helper);
    expect(html).not.toContain('type="password" value=');
  });

  it("the visibility dropdown posts upstream's 0/1/2 wire values with the current selected", async () => {
    const seeded = await seedEdit();
    const html = await renderEdit(seeded);
    expect(html).toContain('id="visibility" name="visibility"');
    expect(html).toContain('<option value="0" selected="">');
    expect(html).toContain('<option value="1">');
    expect(html).toContain('<option value="2">');
    expect(html).toContain("Private");

    await drizzle(env.DB).update(users).set({ visibility: "limited" }).where(eq(users.id, seeded.aliceId)).run();
    const htmlLimited = await renderEdit(seeded);
    expect(htmlLimited).toContain('<option value="1" selected="">');
    expect(htmlLimited).not.toContain('<option value="0" selected="">');
  });

  it("the auth-source dropdown lists Local plus the landed login_sources; login_name renders hidden", async () => {
    const seeded = await seedEdit();
    const html = await renderEdit(seeded);
    expect(html).toContain('id="login_type" name="login_type"');
    expect(html).toContain('<option value="0-0" selected="">');
    expect(html).toContain(`<option value="6-${seeded.sourceId}">corp-oidc</option>`);
    // The LoginSource-0 hidden arm (every row is source 0) + the empty value.
    expect(html).toContain("js-non-local js-non-bot field tw-hidden");
    expect(html).toContain('id="login_name" name="login_name" value=""');
  });

  it("the checkbox block: the status pair, admin, restricted, and the DEFAULT-config hidden+disabled pair", async () => {
    const seeded = await seedEdit();
    const html = await renderEdit(seeded);
    expect(html).toContain('name="active" type="checkbox" checked=""');
    expect(html).toContain('name="prohibit_login" type="checkbox"/>'); // active user → unchecked
    expect(html).not.toContain('prohibit_login" type="checkbox" disabled'); // not self
    expect(html).toContain('name="admin" type="checkbox"/>'); // alice is not admin
    expect(html).toContain('name="restricted" type="checkbox"/>'); // the constant-false store
    // DisableGitHooks (true) + ImportLocalPaths (false) defaults → both
    // fields render tw-hidden with the checkbox disabled.
    expect(html).toContain('data-tooltip-content="Git Hooks are executed');
    expect(html).toContain('name="allow_git_hook" type="checkbox" disabled=""');
    expect(html).toContain('name="allow_import_local" type="checkbox" disabled=""');
    expect(html).toContain('name="allow_create_organization" type="checkbox"/>');
  });

  it("an admin target flips the admin/create-org checks and drops the user_type dropdown", async () => {
    const seeded = await seedEdit();
    const html = await renderEdit(seeded, seeded.adminId);
    expect(html).toContain('name="admin" type="checkbox" checked=""');
    expect(html).toContain('name="allow_create_organization" type="checkbox" checked=""');
    expect(html).not.toContain('id="user_type"');
  });

  it("the self arm: the prohibit checkbox renders disabled for the doer's own row", async () => {
    const seeded = await seedEdit();
    const selfViewer: Viewer = { kind: "user", id: seeded.adminId, username: "edit-admin", isAdmin: true };
    const selfCtx: UiContext = { viewer: selfViewer, origin: "https://test.local", assets: shellAssetsFromManifest(manifest) };
    const data = (await loadAdminUserEdit(env.DB, seeded.adminId))!;
    const html = renderAdminUserEditPage(selfCtx, { ...data, error: null, errorField: null });
    expect(html).toContain('name="prohibit_login" type="checkbox" disabled=""');
  });

  it("a plain target renders the user_type dropdown (the CanConvertUserType gate)", async () => {
    const seeded = await seedEdit();
    const html = await renderEdit(seeded);
    expect(html).toContain('id="user_type" name="user_type"');
    expect(html).toContain('<option value="User" selected="">');
    expect(html).toContain('<option value="Bot">');
  });

  it("the reset_2fa checkbox renders only when a two_factor row exists", async () => {
    const seeded = await seedEdit();
    const without = await renderEdit(seeded);
    expect(without).not.toContain('name="reset_2fa"');
    await seedTwoFactor(seeded.aliceId);
    const withRow = await renderEdit(seeded);
    expect(withRow).toContain('name="reset_2fa" type="checkbox"/>');
    expect(withRow).toContain(adminUserEditLocale.reset_2fa);
  });

  it("the avatar fold targets the landed admin-users-avatar seams; the dead arms render nowhere", async () => {
    const seeded = await seedEdit();
    const html = await renderEdit(seeded);
    expect(html).toContain(`action="/-/admin/users/${seeded.aliceId}/avatar"`);
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('name="avatar" type="file"');
    expect(html).toContain(`formaction="/-/admin/users/${seeded.aliceId}/avatar/delete"`);
    expect(html).toContain('src="/user/avatar/edit-alice/64"');
    // The delete-account button + modal POST ./delete — unlanded, dropped.
    expect(html).not.toContain("delete-user-modal");
    expect(html).not.toContain(`/-/admin/users/${seeded.aliceId}/delete`);
    // The language field is dropped (no column, no contract field).
    expect(html).not.toContain('name="language"');
  });

  it("the error banner + flagged field ride RenderWithErrDeprecated's posture", async () => {
    const seeded = await seedEdit();
    const html = await renderEdit(seeded, seeded.aliceId, {
      error: adminUserEditLocale.email_been_used,
      errorField: "email",
    });
    expect(html).toContain('<div class="ui negative message"><p>The email address is already used.</p></div>');
    expect(html).toContain('class="required field error"');
  });
});

// --- the submit: the profile / email / rename / flags round-trips ---------------

describe("the submit — profile columns round-trip", () => {
  it("writes full_name (with the display-name twin), website, location, and visibility", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(
      seeded,
      aliceForm({ full_name: "Alice A. Doe", website: "https://doe.example", location: "Vienna", visibility: "2" }),
    );
    expect(outcome).toEqual({ outcome: "updated" });
    const row = await rowOf(seeded.aliceId);
    expect(row.fullName).toBe("Alice A. Doe");
    expect(row.displayName).toBe("Alice A. Doe"); // the admin-t2 dual-column posture
    expect(row.website).toBe("https://doe.example");
    expect(row.location).toBe("Vienna");
    expect(row.visibility).toBe("private"); // wire value 2
    expect(row.email).toBe("alice@example.com"); // untouched
  });

  it("empty profile fields CLEAR (upstream's optional.Some semantics)", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(seeded, aliceForm({ full_name: "", website: "", location: "" }));
    expect(outcome).toEqual({ outcome: "updated" });
    const row = await rowOf(seeded.aliceId);
    expect(row.fullName).toBe("");
    expect(row.website).toBe("");
    expect(row.location).toBe("");
  });

  it("the updated outcome's wiring target is upstream's userLink (the detail page)", () => {
    // adminUserLink drives the 303 for updated | redirect; the LIST link
    // drives unknown-target (pinned in the loader block).
    expect(adminUserLink(42)).toBe("/-/admin/users/42");
  });
});

describe("the submit — the email arm", () => {
  it("replaces the primary address", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(seeded, aliceForm({ email: "alice.doe@example.com" }));
    expect(outcome).toEqual({ outcome: "updated" });
    expect((await rowOf(seeded.aliceId)).email).toBe("alice.doe@example.com");
  });

  it("a case-fold-same address no-ops the arm (email.go:33-35) but the rest lands", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(seeded, aliceForm({ email: "ALICE@Example.Com", location: "Vienna" }));
    expect(outcome).toEqual({ outcome: "updated" });
    const row = await rowOf(seeded.aliceId);
    expect(row.email).toBe("alice@example.com"); // unchanged
    expect(row.location).toBe("Vienna");
  });

  it("a foreign duplicate re-renders flagged with form.email_been_used", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(seeded, aliceForm({ email: "bob@example.com" }));
    expect(outcome).toEqual({ outcome: "invalid", message: adminUserEditLocale.email_been_used, field: "email" });
    expect((await rowOf(seeded.aliceId)).email).toBe("alice@example.com"); // nothing landed
  });

  it("a format miss is the SILENT bind arm — flagged, no banner (the Required;Email bind)", async () => {
    const seeded = await seedEdit();
    expect(await submit(seeded, aliceForm({ email: "not-an-email" }))).toEqual({
      outcome: "invalid",
      message: null,
      field: "email",
    });
    expect(await submit(seeded, aliceForm({ email: "" }))).toEqual({ outcome: "invalid", message: null, field: "email" });
    expect((await rowOf(seeded.aliceId)).location).toBe("Berlin"); // the bind arms run first — nothing else landed
  });

  it("an org target answers upstream's InvalidArgument mapping (email.go:28-31 → the email_invalid flag)", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(seeded, aliceForm({ email: "forge-other@example.com" }), seeded.adminId, seeded.orgId);
    expect(outcome).toEqual({ outcome: "invalid", message: adminUserEditLocale.email_invalid, field: "email" });
  });
});

describe("the submit — the rename arm", () => {
  it("renames a user row: the row, the redirect row, and the owner_namespace rewrite", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(seeded, aliceForm({ user_name: "alice-renamed" }));
    expect(outcome).toEqual({ outcome: "updated" });
    const row = await rowOf(seeded.aliceId);
    expect(row.username).toBe("alice-renamed");
    expect(row.usernameLower).toBe("alice-renamed");
    const redirect = await drizzle(env.DB).select().from(userRedirects).where(eq(userRedirects.redirectUserId, seeded.aliceId)).all();
    expect(redirect.map((entry) => entry.lowerName)).toEqual(["edit-alice"]);
    const repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "9201")).get())!;
    expect(repo.ownerNamespace).toBe("alice-renamed");
  });

  it("a case-only flip changes display case and writes NO redirect row", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(seeded, aliceForm({ user_name: "Edit-Alice" }));
    expect(outcome).toEqual({ outcome: "updated" });
    const row = await rowOf(seeded.aliceId);
    expect(row.username).toBe("Edit-Alice");
    expect(row.usernameLower).toBe("edit-alice");
    expect(await drizzle(env.DB).select().from(userRedirects).all()).toEqual([]);
  });

  it("renames an org row through the landed OrgService.renameOrg", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(
      seeded,
      aliceForm({ user_name: "forge-renamed", email: "forge@example.com" }),
      seeded.adminId,
      seeded.orgId,
    );
    expect(outcome).toEqual({ outcome: "updated" });
    expect((await rowOf(seeded.orgId)).username).toBe("forge-renamed");
    const redirect = await drizzle(env.DB).select().from(userRedirects).where(eq(userRedirects.redirectUserId, seeded.orgId)).all();
    expect(redirect.map((entry) => entry.lowerName)).toEqual(["edit-org"]);
  });

  it("the collision answers form.username_been_taken flagged; reserved and junk chars carry the name-rule texts", async () => {
    const seeded = await seedEdit();
    expect(await submit(seeded, aliceForm({ user_name: "edit-bob" }))).toEqual({
      outcome: "invalid",
      message: adminUserEditLocale.username_been_taken,
      field: "userName",
    });
    expect(await submit(seeded, aliceForm({ user_name: "api" }))).toEqual({
      outcome: "invalid",
      message: 'The username "api" is reserved.',
      field: "userName",
    });
    expect(await submit(seeded, aliceForm({ user_name: "a b" }))).toEqual({
      outcome: "invalid",
      message: 'Username "a b" contains invalid characters.',
      field: "userName",
    });

    // The failed renames wrote nothing.
    expect((await rowOf(seeded.aliceId)).username).toBe("edit-alice");
    expect(await drizzle(env.DB).select().from(userRedirects).all()).toEqual([]);
  });
});

describe("the submit — the flag folds", () => {
  it("active unchecked lands prohibited; prohibit_login checked lands prohibited (the deviation-6 fold)", async () => {
    const seeded = await seedEdit();
    expect(await submit(seeded, aliceForm({}, []))).toEqual({ outcome: "updated" });
    expect((await rowOf(seeded.aliceId)).status).toBe("prohibited");

    expect(await submit(seeded, aliceForm({}, ["active", "prohibit_login"]))).toEqual({ outcome: "updated" });
    expect((await rowOf(seeded.aliceId)).status).toBe("prohibited");

    // An explicit re-activation lands active.
    expect(await submit(seeded, aliceForm())).toEqual({ outcome: "updated" });
    expect((await rowOf(seeded.aliceId)).status).toBe("active");
  });

  it("the skip-self guard forces prohibit false for the doer's own row (users.go:476-480)", async () => {
    const seeded = await seedEdit();
    expect(await submit(seeded, aliceForm({}, []))).toEqual({ outcome: "updated" }); // prohibited first
    const outcome = await submit(seeded, aliceForm({}, ["active", "prohibit_login"]), seeded.aliceId, seeded.aliceId);
    expect(outcome).toEqual({ outcome: "updated" });
    expect((await rowOf(seeded.aliceId)).status).toBe("active"); // the crafted prohibit overridden; the explicit-on landed
  });

  it("promotes to admin; demotes a non-last admin; refuses the LAST admin with auth.last_admin", async () => {
    const seeded = await seedEdit();
    // Promote alice (admins: edit-admin, edit-root, alice).
    expect(await submit(seeded, aliceForm({ admin: "on" }))).toEqual({ outcome: "updated" });
    expect((await rowOf(seeded.aliceId)).isAdmin).toBe(true);

    // Demote edit-root (two admins remain): lands.
    expect(await submit(seeded, blankForm("root@example.com"), seeded.adminId, seeded.secondAdminId)).toEqual({
      outcome: "updated",
    });
    expect((await rowOf(seeded.secondAdminId)).isAdmin).toBe(false);

    // Demote edit-admin (alice remains): lands.
    expect(await submit(seeded, blankForm("admin@example.com"), seeded.adminId, seeded.adminId)).toEqual({
      outcome: "updated",
    });
    expect((await rowOf(seeded.adminId)).isAdmin).toBe(false);

    // Demote alice — the LAST admin: the refusal, nothing landed.
    const refused = await submit(seeded, aliceForm(), seeded.adminId, seeded.aliceId);
    expect(refused).toEqual({ outcome: "invalid", message: adminUserEditLocale.last_admin, field: null });
    expect((await rowOf(seeded.aliceId)).isAdmin).toBe(true);
  });
});

describe("the submit — the password arm's validation shapes (deviation 1)", () => {
  it("accepts ANY password — short, long, junk — and stores nothing (no arm exists to hit)", async () => {
    const seeded = await seedEdit();
    for (const password of ["a", "password123", "x".repeat(300)]) {
      expect(await submit(seeded, aliceForm({ password }))).toEqual({ outcome: "updated" });
      const row = await rowOf(seeded.aliceId);
      expect(row.location).toBe("Berlin"); // the rest of the round-trip landed
      expect(Object.keys(row)).not.toContain("password"); // no password store exists
    }
    // The rendered field never echoes a value.
    const html = await renderEdit(seeded);
    expect(html).toContain('name="password" type="password" autocomplete="new-password"');
    expect(html).not.toContain('type="password" value=');
  });
});

describe("the submit — the type arms (CheckConvertUserType at the UpdateUser position)", () => {
  it("Bot on a plain user re-renders with deviation 3's closest declared error", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(seeded, aliceForm({ user_type: "Bot" }));
    expect(outcome).toEqual({ outcome: "invalid", message: "user type can not be converted", field: null });
    expect((await rowOf(seeded.aliceId)).type).toBe("user"); // nothing landed
  });

  it("Bot on an admin answers upstream's ErrBotCanNotBeAdmin flash+redirect arm (the flash dropped)", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(seeded, blankForm("admin@example.com", ["active"], { user_type: "Bot" }), seeded.adminId, seeded.adminId);
    expect(outcome).toEqual({ outcome: "redirect" });
    expect((await rowOf(seeded.adminId)).isAdmin).toBe(true); // the update never landed
  });

  it("Bot on an org answers upstream's default ServerError arm", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(seeded, blankForm("forge@example.com", ["active"], { user_type: "Bot" }), seeded.adminId, seeded.orgId);
    expect(outcome).toEqual({ outcome: "server-error" });
    expect((await rowOf(seeded.orgId)).type).toBe("org");
  });

  it("junk user_type fails the In() bind — the flag-less silent re-render", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(seeded, aliceForm({ user_type: "Organization" }));
    expect(outcome).toEqual({ outcome: "invalid", message: null, field: null });
    expect((await rowOf(seeded.aliceId)).type).toBe("user");
  });
});

describe("the submit — the reset-2FA arm (DisableTwoFactor)", () => {
  it("dies the TOTP row when posted; keeps it otherwise", async () => {
    const seeded = await seedEdit();
    await seedTwoFactor(seeded.aliceId);

    expect(await submit(seeded, aliceForm())).toEqual({ outcome: "updated" });
    expect((await drizzle(env.DB).select().from(twoFactor).where(eq(twoFactor.userId, seeded.aliceId)).all()).length).toBe(1);

    expect(await submit(seeded, aliceForm({}, ["active", "reset_2fa"]))).toEqual({ outcome: "updated" });
    expect((await drizzle(env.DB).select().from(twoFactor).where(eq(twoFactor.userId, seeded.aliceId)).all()).length).toBe(0);
  });
});

describe("the submit — the bind arms and the unknown target", () => {
  it("the silent bind arms: login_type required, visibility and max_repo_creation int binds", async () => {
    const seeded = await seedEdit();
    expect(await submit(seeded, aliceForm({ login_type: "" }))).toEqual({ outcome: "invalid", message: null, field: "loginType" });
    expect(await submit(seeded, aliceForm({ visibility: "9" }))).toEqual({ outcome: "invalid", message: null, field: "visibility" });
    expect(await submit(seeded, aliceForm({ max_repo_creation: "abc" }))).toEqual({
      outcome: "invalid",
      message: null,
      field: "maxRepoCreation",
    });
    expect(await submit(seeded, aliceForm({ max_repo_creation: "" }))).toEqual({
      outcome: "invalid",
      message: null,
      field: "maxRepoCreation",
    });
    // Nothing landed through any of the arms.
    expect((await rowOf(seeded.aliceId)).location).toBe("Berlin");
  });

  it("an unknown target answers the LIST redirect (prepareUserInfo's arm, never a 404)", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(seeded, aliceForm(), seeded.adminId, seeded.aliceId + 10_000);
    expect(outcome).toEqual({ outcome: "unknown-target" });
  });

  it("an org target round-trips its own columns (full_name/location/visibility)", async () => {
    const seeded = await seedEdit();
    const outcome = await submit(
      seeded,
      aliceForm({ email: "forge@example.com", full_name: "The Forge", location: "Hamburg", visibility: "1" }),
      seeded.adminId,
      seeded.orgId,
    );
    expect(outcome).toEqual({ outcome: "updated" });
    const row = await rowOf(seeded.orgId);
    expect(row.fullName).toBe("The Forge");
    expect(row.location).toBe("Hamburg");
    expect(row.visibility).toBe("limited");
    expect(row.email).toBe("forge@example.com"); // same-address no-op
  });
});
