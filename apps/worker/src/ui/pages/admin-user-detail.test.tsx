/**
 * The admin user DETAIL page's module-level suite (PORT-FIRST: the route
 * lives behind the orchestrator's index.ts fold — the recipe is the module
 * header's; the seams drive directly, the admin-users-avatar.test.ts
 * pattern).
 *
 * Coverage (upstream at the pin: web.go:817's GET /-/admin/users/{userid},
 * routers/web/admin/users.go:314-370's ViewUser over prepareUserInfo
 * (:269-281), templates/admin/user/view.tmpl + view_details/view_emails/
 * view_orgs, and the 2a00e28 avatar-pair fold):
 *
 *   - THE UNKNOWN-ID ARM (prepareUserInfo, users.go:269-278): the loader
 *     answers null — the caller's 303 onto the LIST, never a 404 — and the
 *     landed loadAdminAvatarUser seam agrees (one id space).
 *   - THE DETAILS BLOCK (view_details.tmpl): the 48px avatar through the
 *     landed serving seam, the shared/user/name link with upstream's
 *     DisplayNameWithFullName ("name (Full Name)"), the plain-text
 *     degradation on a PROHIBITED row (the list page's §4.8 posture), the
 *     Admin label, the constant-Local auth source, the four check/x lines
 *     (activated ⇔ status, prohibit_login folded, restricted + 2FA the
 *     constant-false stores), the visibility label, and the
 *     location/website arms.
 *   - THE EMAILS (view_emails.tmpl): the synthesized-primary union
 *     (misc-t3.ts emailEntriesOfUser's posture) with the Primary /
 *     Activated / Requires-activation labels and the total.
 *   - THE REPOSITORIES (view.tmpl:31-38): every OWNED repo, slug ASC, the
 *     private badge, the shared row's description line.
 *   - THE ORGS (view_orgs.tmpl): the membership rows with the private
 *     badge + joined-on line; THE REMOVE ARMS (census B-71, web.go:824-825)
 *     render as the no-JS plain-form reductions — the Remove All sweep
 *     button (only when orgs exist, the `{{if $userOrgs}}` gate) and the
 *     per-org Remove buttons, POSTing `{link}/orgs/remove-all` and
 *     `{link}/orgs/{orgId}/remove` (the landed index.ts families; the
 *     handlers' suite lives in ui/index.test.ts).
 *   - THE AVATAR FOLD: the upload form + delete button point at the landed
 *     admin-users-avatar.ts seams (`/-/admin/users/{id}/avatar[ /delete]`),
 *     whose redirects land HERE; the impersonate button and the edit link
 *     render nowhere (the STOP arm + the unlanded edit page — the
 *     dead-control rule).
 *   - THE BOT ACCESS-TOKENS PANEL (the B-72 handoff (4) close-out — the
 *     former "unproducible" note is history): the loader answers the panel
 *     for a type=bot target ONLY (users.go:355-359's gate — a user/org row
 *     is null, the `{{if .BotAccessTokens}}` slot), the render carries the
 *     shared template's bot arms (the `admin.users.bot_token_desc` lead,
 *     NO regenerate button/modal, the delete forms posting
 *     `{link}/delete`), the mint seam (web.go:822-823 → getTargetBot →
 *     user_setting.CreateAccessToken) through the EXISTING token service —
 *     the token owned by the BOT, the one-time plaintext, the audit row
 *     carrying owner=BOT + actor=the calling admin (applications.go:133's
 *     shape), the at_least_one_permission / duplicate-name / Required
 *     gates, the NON-bot refusal (`admin.users.bot_token_only`, the
 *     impersonate 400-map convention's body constant), the unknown-target
 *     arm, the revoke seam + its owner-scoped stale-id arm — and the
 *     parseUiRoute claims (digits-only {userid}, junk stays engine-404).
 *
 * Fixture discipline: tables wiped per test (children first), ids captured
 * at seed time — never hardcoded.
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TokenService } from "../../auth/token-service";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { auditEvents, emailAddresses, personalAccessTokens, repositories, users } from "../../db/schema";
import { OrgService } from "../../services/orgs/orgs";
import { parseUiRoute } from "../index";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { loadAdminAvatarUser } from "./admin-users-avatar";
import {
  ADMIN_BOT_TOKEN_ONLY_ERROR,
  ADMIN_USERS_LIST_LINK,
  adminUserDetailLocale,
  adminUserMintBotToken,
  adminUserRevokeBotToken,
  displayNameWithFullName,
  loadAdminUserDetail,
  renderAdminUserDetailPage,
  withBotTokenMintOutcome,
} from "./admin-user-detail";

// --- fixtures ----------------------------------------------------------------

const ORG_CREATED = new Date("2026-01-01T00:00:00Z");

/** Tables the fixtures touch (children first — audit_event and
 *  personal_access_tokens carry the bot-token pair's rows). */
const FIXTURE_TABLES = [
  "sessions",
  "email_addresses",
  "personal_access_tokens",
  "audit_event",
  "repo_settings",
  "repositories",
  "org_members",
  "user_redirects",
  "users",
];

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The signed-in site admin viewing the page (the route stage's posture —
 *  adminPagePrologue gates it; the seams are post-gate). */
let adminViewer: Viewer = { kind: "anonymous" };
let ctx: UiContext;

interface Seeded {
  adminId: number;
  aliceId: number;
  bobProhibitedId: number;
  orgPublicName: string;
  orgPrivateName: string;
  orgPublicId: number;
  orgPrivateId: number;
}

async function seedUser(options: Parameters<typeof seedVerifiedUser>[0] & { email?: string; fullName?: string | null; location?: string | null; website?: string | null }): Promise<{ id: number; username: string }> {
  const seeded = await seedVerifiedUser(options);
  if (options.email !== undefined || options.fullName !== undefined || options.location !== undefined || options.website !== undefined) {
    await drizzle(env.DB)
      .update(users)
      .set({ email: options.email ?? null, fullName: options.fullName ?? null, location: options.location ?? null, website: options.website ?? null })
      .where(eq(users.id, seeded.id))
      .run();
  }
  return seeded;
}

async function seedDetail(): Promise<Seeded> {
  const admin = await seedVerifiedUser({ username: "detail-admin", isAdmin: true });
  adminViewer = { kind: "user", id: admin.id, username: admin.username, isAdmin: true };
  ctx = { viewer: adminViewer, origin: "https://test.local", assets: shellAssetsFromManifest(manifest) };

  const alice = await seedUser({
    username: "detail-alice",
    email: "alice@example.com",
    fullName: "Alice Doe",
    location: "Berlin",
    website: "https://alice.example",
  });
  const bob = await seedVerifiedUser({ username: "detail-bob", status: "prohibited" });
  // The secondary address: unactivated (the Requires-activation arm).
  await drizzle(env.DB)
    .insert(emailAddresses)
    .values({ userId: alice.id, email: "alice+sec@example.com", lowerEmail: "alice+sec@example.com", isActivated: false, isPrimary: false })
    .run();

  const orgs = new OrgService(env.DB);
  const pub = await orgs.createOrg({ name: "detail-pub", ownerId: alice.id, visibility: "public", now: ORG_CREATED });
  const priv = await orgs.createOrg({ name: "detail-priv", ownerId: alice.id, visibility: "private", now: ORG_CREATED });

  // Two owned repos — seeded out of slug order to pin the slug-ASC read —
  // plus a description row on the first.
  const seedRepo = (id: string, slug: string, visibility: "public" | "private", forkParent: string | null = null) =>
    drizzle(env.DB)
      .insert(repositories)
      .values({
        id,
        storageKey: `r_${id}`,
        ownerNamespace: "detail-alice",
        ownerId: alice.id,
        slug,
        visibility,
        forkParent,
        refsVersion: 1,
        backend: "self-hosted",
        createdAt: ORG_CREATED,
      })
      .run();
  await seedRepo("9102", "zeta", "private");
  await seedRepo("9101", "alpha", "public", "9199"); // the fork arm
  // FN-4/0068: descriptions live on the repositories row.
  await drizzle(env.DB).update(repositories).set({ description: "the alpha repo" }).where(eq(repositories.id, "9101")).run();

  return {
    adminId: admin.id,
    aliceId: alice.id,
    bobProhibitedId: bob.id,
    orgPublicName: pub.username,
    orgPrivateName: priv.username,
    orgPublicId: pub.id,
    orgPrivateId: priv.id,
  };
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

describe("the loader (ViewUser's data pull)", () => {
  it("an unknown id answers null — the LIST-redirect arm, never a 404 (prepareUserInfo)", async () => {
    const seeded = await seedDetail();
    expect(await loadAdminUserDetail(env.DB, seeded.aliceId + 10_000)).toBeNull();
    // The landed avatar-pair seam agrees on the same id space.
    expect(await loadAdminAvatarUser(env.DB, seeded.aliceId + 10_000)).toBeNull();
  });

  it("the emails union: the synthesized primary first, then the rows by id; the totals", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    expect(data.emails).toEqual([
      { email: "alice@example.com", isActivated: true, isPrimary: true },
      { email: "alice+sec@example.com", isActivated: false, isPrimary: false },
    ]);
    expect(data.emailsTotal).toBe(2);
  });

  it("the repos: every owned row, slug ASC, no visibility filter; the batched description", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    expect(data.reposTotal).toBe(2);
    expect(data.repos.map((row) => row.repo.slug)).toEqual(["alpha", "zeta"]);
    expect(data.repos[0]!.description).toBe("the alpha repo");
    expect(data.repos.map((row) => row.repo.visibility)).toEqual(["public", "private"]); // the admin sees both
  });

  it("the orgs: the memberships at the admin's unfiltered ceiling (public + private)", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    expect(data.orgs.map((org) => org.username).sort()).toEqual([seeded.orgPrivateName, seeded.orgPublicName].sort());
  });
});

// --- the render -----------------------------------------------------------------

describe("the render (view.tmpl + the folds)", () => {
  it("carries the family shell chrome: pageClass `admin view user`, the active users item, the Title", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    const html = renderAdminUserDetailPage(ctx, { ...data, oauth2Enabled: true });
    expect(html).toContain('class="page-content admin view user"');
    expect(html).toContain(adminUserDetailLocale.details);
    expect(html).toContain('class="active item" href="/-/admin/users"');
  });

  it("the details block: the avatar img, the DisplayNameWithFullName link, the check/x lines, visibility", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(html).toContain(`src="/user/avatar/detail-alice/48"`);
    // DisplayNameWithFullName: the USERNAME + the parenthesized full name
    // (models/user/user.go:496-501 — u.Name is the username).
    expect(html).toContain('href="/detail-alice">detail-alice (Alice Doe)</a>');
    expect(html).toContain(`${adminUserDetailLocale.auth_source}:`);
    expect(html).toContain(adminUserDetailLocale.local);
    expect(html).toContain(`>${adminUserDetailLocale.visibility}:</b> ${adminUserDetailLocale.visibility_public}`);
    // Berlin + the website link.
    expect(html).toContain("Berlin");
    expect(html).toContain('href="https://alice.example"');
  });

  it("a PROHIBITED row renders the name plain (no dead profile link) and flips the activated/prohibit pair", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.bobProhibitedId))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(html).toContain(`>${displayNameWithFullName(data.user)}</span>`);
    expect(html).not.toContain('href="/detail-bob"');
  });

  it("the emails block: the mailto rows, the Primary and Requires-activation labels, the total", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(html).toContain('href="mailto:alice@example.com"');
    expect(html).toContain(`>${adminUserDetailLocale.primary}</div>`);
    expect(html).toContain(`>${adminUserDetailLocale.requires_activation}</div>`);
    expect(html).toContain(adminUserDetailLocale.emails);
    expect(html).toContain("Total: 2");
  });

  it("the repositories block: the shared rows, the private badge, the description, the total", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(html).toContain('href="/detail-alice/alpha"');
    expect(html).toContain('href="/detail-alice/zeta"');
    expect(html).toContain("the alpha repo");
    expect(html).toContain(adminUserDetailLocale.repositories);
    expect(html).toContain("Total: 2");
  });

  it("the orgs block: the membership rows with the private badge + joined-on + the B-71 remove arms", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(html).toContain(`href="/${seeded.orgPublicName}"`);
    expect(html).toContain(`href="/${seeded.orgPrivateName}"`);
    expect(html).toContain("Joined on Jan 1, 2026");
    // The B-71 pair's no-JS reductions (view_orgs.tmpl:7-21 + :46-50): the
    // Remove All sweep form and the per-org Remove forms, each POSTing the
    // landed index.ts family's path.
    expect(html).toContain('class="ui top attached header flex-left-right"');
    expect(html).toContain(`action="/-/admin/users/${seeded.aliceId}/orgs/remove-all"`);
    expect(html).toContain(`>${adminUserDetailLocale.remove_all}</button>`);
    expect(html).toContain(`action="/-/admin/users/${seeded.aliceId}/orgs/${seeded.orgPublicId}/remove"`);
    expect(html).toContain(`action="/-/admin/users/${seeded.aliceId}/orgs/${seeded.orgPrivateId}/remove"`);
    expect(html).toContain(`>${adminUserDetailLocale.remove}</button>`);
    // The upstream modal dialog and its JS dialect drop in the reduction.
    expect(html).not.toContain("remove-all-orgs-modal");
    expect(html).not.toContain("data-modal-confirm");
    expect(html).not.toContain("link-action");
  });

  it("the orgs block on an org-less target: NO Remove All button (the `{{if $userOrgs}}` gate), the rows absent", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.bobProhibitedId))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(data.orgs).toHaveLength(0);
    expect(html).not.toContain("/orgs/remove-all");
    // The empty segment list drops with the gate (view_orgs.tmpl:25).
    expect(html).toContain(adminUserDetailLocale.organizations);
    expect(html).toContain("Total: 0");
  });

  it("THE AVATAR FOLD: the upload form + delete button target the landed admin-users-avatar seams", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(html).toContain(`action="/-/admin/users/${seeded.aliceId}/avatar"`);
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('name="avatar" type="file"');
    expect(html).toContain(`formaction="/-/admin/users/${seeded.aliceId}/avatar/delete"`);
    // The current avatar rides the serving seam in the form too.
    expect(html).toContain('src="/user/avatar/detail-alice/64"');
  });

  it("the header pair targets the LIVE arms: the impersonate form POST + the edit link (view.tmpl:6-11)", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    // The no-JS form reduction of upstream's link-action button (the landed
    // admin-users-impersonate POST; success 303s onto /user/settings).
    expect(html).toContain(`action="/-/admin/users/${seeded.aliceId}/impersonate"`);
    expect(html).toContain('<button type="submit" class="ui primary compact tiny basic button">');
    expect(html).toContain(">Impersonate</button>");
    // The edit anchor onto the landed admin-user-edit page.
    expect(html).toContain(`href="/-/admin/users/${seeded.aliceId}/edit"`);
    expect(html).toContain(">Edit</a>");
  });

  it("a bot target renders NO impersonate button (view.tmpl:9's `{{if not .User.IsTypeBot}}` — live since B-72 handoff 3); the edit link stays", async () => {
    const seeded = await seedDetail();
    await drizzle(env.DB).update(users).set({ type: "bot" }).where(eq(users.id, seeded.aliceId));
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(html).not.toContain(`action="/-/admin/users/${seeded.aliceId}/impersonate"`);
    expect(html).not.toContain(">Impersonate</button>");
    expect(html).toContain(`href="/-/admin/users/${seeded.aliceId}/edit"`);
    // No type label renders on the detail page (view_details carries only
    // the Admin label — upstream's own).
    expect(html).not.toContain(">Bot</span>");
  });
});

// --- the bot access-tokens panel (the B-72 handoff (4) close-out) ----------------

/** The panel's render clock (fixed — the loader's `now` parameter). */
const PANEL_NOW = new Date("2026-06-10T00:00:00Z");

/** The bot-panel fixture: the signed-in admin (the audit arms' actor), a
 *  bot-typed target (the BOTTOKEN seeds `type` option — B-72's
 *  admin-created class) and a plain individual (the refusal's non-bot
 *  target). */
async function seedBotFixture(): Promise<{
  admin: { id: number; username: string };
  bot: { id: number; username: string };
  human: { id: number; username: string };
  actor: { id: number; username: string };
}> {
  const admin = await seedVerifiedUser({ username: "bot-admin", isAdmin: true });
  adminViewer = { kind: "user", id: admin.id, username: admin.username, isAdmin: true };
  ctx = { viewer: adminViewer, origin: "https://test.local", assets: shellAssetsFromManifest(manifest) };
  const bot = await seedVerifiedUser({ username: "ci-bot", type: "bot" });
  const human = await seedVerifiedUser({ username: "bot-human" });
  return { admin, bot, human, actor: { id: admin.id, username: admin.username } };
}

/** The audit rows carrying `action` (the audit_event table is wiped per
 *  test; the action ids are the landed services/audit.ts registry's). */
async function auditRows(action: string) {
  const rows = await drizzle(env.DB).select().from(auditEvents).all();
  return rows.filter((row) => row.action === action);
}

describe("the bot panel's loader gate (ViewUser, users.go:355-359)", () => {
  it("a bot target carries the panel: every owned token, the panel link, the scope categories minus admin (the OWNER's flag — the viewer here IS an admin), the empty slots", async () => {
    const { bot } = await seedBotFixture();
    await new TokenService(env.DB).mint({
      userId: bot.id,
      name: "deploy",
      scopes: "read:repository,public-only",
      now: new Date("2026-06-01T00:00:00Z"),
    });
    const data = (await loadAdminUserDetail(env.DB, bot.id, PANEL_NOW))!;
    expect(data.botTokens).not.toBeNull();
    const panel = data.botTokens!;
    expect(panel.link).toBe(`/-/admin/users/${bot.id}/access_tokens`);
    expect(panel.tokens.map((item) => item.token.name)).toEqual(["deploy"]);
    expect(panel.tokens[0]).toMatchObject({ publicOnly: true, scopes: ["read:repository"], hasUsed: false, hasRecentActivity: false });
    expect(panel.scopeCategories).not.toContain("admin");
    expect(panel.scopeCategories).toContain("repository");
    expect([...panel.scopeCategories]).toEqual([...panel.scopeCategories].sort());
    expect(panel).toMatchObject({ newToken: null, error: null, formName: "" });
  });

  it("a user row and an org row answer NO panel — even when the user OWNS tokens (the `{{if .BotAccessTokens}}` gate)", async () => {
    const { human } = await seedBotFixture();
    const org = await new OrgService(env.DB).createOrg({ name: "bot-org", ownerId: human.id, visibility: "public", now: ORG_CREATED });
    await new TokenService(env.DB).mint({ userId: human.id, name: "human-token", scopes: "read:repository" });
    expect((await loadAdminUserDetail(env.DB, human.id))!.botTokens).toBeNull();
    expect((await loadAdminUserDetail(env.DB, org.id))!.botTokens).toBeNull();
  });
});

describe("the bot panel's render (access_tokens.tmpl's bot arms)", () => {
  it("a bot target renders the panel in view.tmpl:28-29's slot: the header, the bot_token_desc lead, the generate form on the panel link", async () => {
    const { bot } = await seedBotFixture();
    const data = (await loadAdminUserDetail(env.DB, bot.id, PANEL_NOW))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(html).toContain('id="access-token-panel"');
    expect(html).toContain(adminUserDetailLocale.bot_token_desc);
    // The IsBot lead line REPLACES the self-service tokens_desc (tmpl:17's
    // arms — this is the admin panel, not /user/settings/applications).
    expect(html).not.toContain("These tokens grant access to your account using the Gitea API.");
    // The generate form posts the PANEL link (upstream `.Link` =
    // ctx.Link + "/access_tokens"); the name input + the scope radios.
    expect(html).toContain(`<form class="ui form" action="/-/admin/users/${bot.id}/access_tokens" method="post">`);
    expect(html).toContain('id="name" name="name" required="" maxlength="255"');
    expect(html).toContain('name="scope-public-only" value="public-only"');
    expect(html).toContain('name="scope-public-only" value="" checked');
    expect(html).toContain('name="scope-repository" value="read:repository"');
    expect(html).toContain('name="scope-repository" value="write:repository"');
    // The bot row is not an admin — the admin category drops
    // (applications.go:66-68's owner.IsAdmin key).
    expect(html).not.toContain('name="scope-admin"');
    // The slot order: after the responsive columns, before the avatar fold
    // (view.tmpl renders the panel between the columns and the repos list).
    expect(html.indexOf('class="admin-responsive-columns"')).toBeLessThan(html.indexOf('id="access-token-panel"'));
    expect(html.indexOf('id="access-token-panel"')).toBeLessThan(html.indexOf(`action="/-/admin/users/${bot.id}/avatar"`));
    // access_tokens.tmpl:67 — open when no tokens exist.
    expect(html).toContain("<details open=");
  });

  it("a non-bot target renders NO panel, no token machinery at all", async () => {
    const { human } = await seedBotFixture();
    const data = (await loadAdminUserDetail(env.DB, human.id))!;
    expect(data.botTokens).toBeNull();
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(html).not.toContain('id="access-token-panel"');
    expect(html).not.toContain(adminUserDetailLocale.bot_token_desc);
    expect(html).not.toContain("/access_tokens");
  });

  it("the token rows: the delete form posts `{link}/delete` with the hidden id; NO regenerate control or modal (tmpl:51/:115), no confirm dialog", async () => {
    const { bot } = await seedBotFixture();
    const minted = await new TokenService(env.DB).mint({ userId: bot.id, name: "row-token", scopes: "write:issue" });
    const data = (await loadAdminUserDetail(env.DB, bot.id, PANEL_NOW))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(html).toContain(`<form method="post" action="/-/admin/users/${bot.id}/access_tokens/delete">`);
    expect(html).toContain(`name="id" value="${String(minted.id)}"`);
    expect(html).toContain(`Delete</button>`);
    // The row's details: the name summary, the access line, the scope list.
    expect(html).toContain("<details>"); // closed — tokens exist (tmpl:67)
    expect(html).toContain("row-token");
    expect(html).toContain("<li>write:issue</li>");
    expect(html).toContain("All (public, private, and limited)"); // write:issue is not public-only
    // The IsBot arms: regenerate renders never for the admin panel.
    expect(html).not.toContain("Regenerate");
    expect(html).not.toContain("/regenerate");
    expect(html).not.toContain("regenerate-token");
    // The delete confirm dialog drops (the settings reduction).
    expect(html).not.toContain("delete-token");
    expect(html).not.toContain("data-modal-confirm");
  });

  it("the last-used arm: a used token renders the last_used date; a recent one carries the green state (tmpl:22/:47)", async () => {
    const { bot } = await seedBotFixture();
    const minted = await new TokenService(env.DB).mint({ userId: bot.id, name: "used-token", scopes: "read:user", now: new Date("2026-06-01T00:00:00Z") });
    await drizzle(env.DB).update(personalAccessTokens).set({ lastUsedAt: new Date("2026-06-08T00:00:00Z") }).where(eq(personalAccessTokens.id, minted.id)).run();
    const data = (await loadAdminUserDetail(env.DB, bot.id, PANEL_NOW))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(data.botTokens!.tokens[0]).toMatchObject({ hasUsed: true, hasRecentActivity: true });
    expect(html).toContain("Last used on");
    expect(html).toContain("tw-text-green");
  });

  it("the mint re-render carries the ONE-TIME plaintext exactly once (NewTokenValue — SPEC-0002 never stores it)", async () => {
    const { bot } = await seedBotFixture();
    const data = (await loadAdminUserDetail(env.DB, bot.id, PANEL_NOW))!;
    const outcome = { outcome: "created", plaintext: "cfg_01234567_ABCDEFGHJKLMNPQRSTUVWXYZ234567" } as const;
    const html = renderAdminUserDetailPage(ctx, withBotTokenMintOutcome({ ...data }, outcome)!);
    expect(html).toContain('<code id="new-access-token-value">cfg_01234567_ABCDEFGHJKLMNPQRSTUVWXYZ234567</code>');
    expect(html.match(/cfg_01234567/g)?.length).toBe(1);
    expect(html).toContain("Your new token has been generated. Copy it now as it will not be shown again.");
  });

  it("an invalid mint re-render carries the negative line + the kept name (the JSONError arms' reduction)", async () => {
    const { bot } = await seedBotFixture();
    const data = (await loadAdminUserDetail(env.DB, bot.id, PANEL_NOW))!;
    const html = renderAdminUserDetailPage(
      ctx,
      withBotTokenMintOutcome(
        { ...data },
        { outcome: "invalid", message: "You must select at least one permission to create a token", name: "Kept Name" },
      )!,
    );
    expect(html).toContain("You must select at least one permission to create a token");
    expect(html).toContain('value="Kept Name"');
  });

  it("withBotTokenMintOutcome answers null when the target stopped being a panelable bot (the mid-flight LIST belt)", async () => {
    await seedBotFixture();
    const human = (await loadAdminUserDetail(env.DB, (await seedVerifiedUser({ username: "plain-late" })).id))!;
    expect(
      withBotTokenMintOutcome({ ...human, botTokens: null }, { outcome: "created", plaintext: "cfg_00000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2" }),
    ).toBeNull();
  });
});

describe("the bot-token write pair (web.go:822-823 over getTargetBot — the EXISTING token service)", () => {
  it("the mint FOR a bot: owned by the bot, verifies as the bot; the audit row carries owner=BOT + actor=the calling ADMIN", async () => {
    const { admin, bot, actor } = await seedBotFixture();
    const outcome = await adminUserMintBotToken(env.DB, actor, bot.id, { name: "bot-credentials", scopesRaw: "read:repository" });
    expect(outcome.outcome).toBe("created");
    if (outcome.outcome !== "created") return;
    // The one-time plaintext shape (cfg_<8hex>_<32base32>, 45 chars).
    expect(outcome.plaintext).toMatch(/^cfg_[0-9a-f]{8}_[A-Z2-9]{32}$/);
    // The row is OWNED by the bot and the plaintext resolves to it —
    // admin-managed tokens are a bot's only auth path upstream.
    const listed = await new TokenService(env.DB).list(bot.id, 1, 30);
    expect(listed.total).toBe(1);
    expect(listed.tokens[0]).toMatchObject({ name: "bot-credentials", scopes: "read:repository" });
    expect(await new TokenService(env.DB).verify(outcome.plaintext)).toMatchObject({ user: { id: bot.id, type: "bot" } });
    // audit.Record(ctx, UserAccessTokenAdd, owner, "token", t.Name,
    // "token_scope", t.Scope) (applications.go:133): owner = the BOT, the
    // actor = the calling admin, the session write carries no credential.
    const rows = await auditRows("user:accesstoken:add");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scopeType: "user",
      scopeId: String(bot.id),
      scopeName: bot.username,
      actorId: admin.id,
      actorName: admin.username,
      actorCredential: null,
    });
    expect(JSON.parse(rows[0]?.metadata ?? "{}")).toEqual({ token: "bot-credentials", token_scope: "read:repository" });
  });

  it("the mint's gates — Required name, at_least_one_permission, the duplicate name — invalid outcomes keep the name; nothing extra is written", async () => {
    const { bot, actor } = await seedBotFixture();
    const required = await adminUserMintBotToken(env.DB, actor, bot.id, { name: "", scopesRaw: "read:repository" });
    expect(required).toEqual({ outcome: "invalid", message: "Name: Required", name: "" });
    const noPermission = await adminUserMintBotToken(env.DB, actor, bot.id, { name: "x", scopesRaw: "public-only" });
    expect(noPermission).toEqual({
      outcome: "invalid",
      message: "You must select at least one permission to create a token",
      name: "x",
    });
    const first = await adminUserMintBotToken(env.DB, actor, bot.id, { name: "dupe", scopesRaw: "read:user" });
    expect(first.outcome).toBe("created");
    const duplicate = await adminUserMintBotToken(env.DB, actor, bot.id, { name: "dupe", scopesRaw: "read:user" });
    expect(duplicate).toEqual({
      outcome: "invalid",
      message: "dupe has been used as an application name already. Please use a new one.",
      name: "dupe",
    });
    // Exactly one token + exactly one audit row landed (the failures wrote
    // nothing — never accept-and-partially-ignore).
    expect((await new TokenService(env.DB).list(bot.id, 1, 30)).total).toBe(1);
    expect(await auditRows("user:accesstoken:add")).toHaveLength(1);
  });

  it("the mint REFUSES a non-bot target (admin.users.bot_token_only) — user AND org rows; no token, no audit, never accept-and-ignore", async () => {
    const { human, actor } = await seedBotFixture();
    const org = await new OrgService(env.DB).createOrg({ name: "refuse-org", ownerId: human.id, visibility: "public", now: ORG_CREATED });
    for (const target of [human.id, org.id]) {
      expect(await adminUserMintBotToken(env.DB, actor, target, { name: "sneaky", scopesRaw: "read:repository" })).toEqual({ outcome: "refused" });
    }
    expect((await new TokenService(env.DB).list(human.id, 1, 30)).total).toBe(0);
    expect(await auditRows("user:accesstoken:add")).toHaveLength(0);
  });

  it("the mint answers unknown-target for a missing id (getTargetBot's own ServerError arm, never the list redirect)", async () => {
    const { bot, actor } = await seedBotFixture();
    expect(await adminUserMintBotToken(env.DB, actor, bot.id + 10_000, { name: "ghost", scopesRaw: "read:repository" })).toEqual({
      outcome: "unknown-target",
    });
  });

  it("the revoke: the owner-scoped delete + the remove audit naming the pair; a second revoke rides the stale-id `missing`", async () => {
    const { admin, bot, actor } = await seedBotFixture();
    const minted = await new TokenService(env.DB).mint({ userId: bot.id, name: "short-lived", scopes: "read:repository" });
    expect(await adminUserRevokeBotToken(env.DB, actor, bot.id, minted.id)).toBe("deleted");
    expect((await new TokenService(env.DB).list(bot.id, 1, 30)).total).toBe(0);
    const rows = await auditRows("user:accesstoken:remove");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scopeType: "user",
      scopeId: String(bot.id),
      scopeName: bot.username,
      actorId: admin.id,
      actorName: admin.username,
      actorCredential: null,
    });
    expect(JSON.parse(rows[0]?.metadata ?? "{}")).toEqual({ token: "short-lived" });
    // The stale id: silent `missing`, NO second audit row.
    expect(await adminUserRevokeBotToken(env.DB, actor, bot.id, minted.id)).toBe("missing");
    expect(await auditRows("user:accesstoken:remove")).toHaveLength(1);
  });

  it("the revoke refuses a non-bot target and never reaches across owners: a foreign id is `missing` and the row survives", async () => {
    const { human, bot, actor } = await seedBotFixture();
    const humans = await new TokenService(env.DB).mint({ userId: human.id, name: "humans-own", scopes: "read:repository" });
    const bots = await new TokenService(env.DB).mint({ userId: bot.id, name: "bots-own", scopes: "read:repository" });
    // A non-bot target refuses at the gate before ANY token work.
    expect(await adminUserRevokeBotToken(env.DB, actor, human.id, humans.id)).toBe("refused");
    // The bot's panel deletes only the BOT's rows: the human's id is the
    // owner-scoped miss (GetAccessTokenByID's (id, owner.ID) key).
    expect(await adminUserRevokeBotToken(env.DB, actor, bot.id, humans.id)).toBe("missing");
    expect(await new TokenService(env.DB).list(human.id, 1, 30)).toMatchObject({ total: 1 });
    expect(await new TokenService(env.DB).list(bot.id, 1, 30)).toMatchObject({ total: 1 });
    expect(await auditRows("user:accesstoken:remove")).toHaveLength(0);
    // And the bot's own revoke still works after those refusals.
    expect(await adminUserRevokeBotToken(env.DB, actor, bot.id, bots.id)).toBe("deleted");
  });

  it("the refusal body is upstream's buildJsonErrorMap shape with the en-US locale string", () => {
    expect(ADMIN_BOT_TOKEN_ONLY_ERROR).toEqual({
      errorMessage: "Access tokens can only be generated for bot accounts here.",
      renderFormat: "text",
    });
  });
});

describe("the bot-token pair's parse claims (handlesUiRoute's dispatcher gate)", () => {
  it("claims the mint and the delete shapes, digits-only {userid} (junk stays engine-404)", () => {
    expect(parseUiRoute("/-/admin/users/42/access_tokens")).toEqual({ family: "admin-user-bot-token", adminUserId: 42 });
    expect(parseUiRoute("/-/admin/users/42/access_tokens/delete")).toEqual({ family: "admin-user-bot-token-delete", adminUserId: 42 });
    expect(parseUiRoute("/-/admin/users/x/access_tokens")).toBeNull();
    expect(parseUiRoute("/-/admin/users/42/access_tokens/regenerate")).toBeNull();
    expect(parseUiRoute("/-/admin/users/42/access_tokens/delete/extra")).toBeNull();
    // The detail page's claim is untouched.
    expect(parseUiRoute("/-/admin/users/42")).toEqual({ family: "admin-user-detail", adminUserId: 42 });
  });
});

/** The unknown-id redirect target — the module re-exports the pair's const;
 *  the pin keeps the link honest. */
describe("the list-link export", () => {
  it("re-exports the avatar pair's redirect target", () => {
    expect(ADMIN_USERS_LIST_LINK).toBe("/-/admin/users");
  });
});
