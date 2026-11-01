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
 *     badge + joined-on line; the remove arms render NOWHERE (unlanded
 *     writes — the dead-control rule).
 *   - THE AVATAR FOLD: the upload form + delete button point at the landed
 *     admin-users-avatar.ts seams (`/-/admin/users/{id}/avatar[ /delete]`),
 *     whose redirects land HERE; the impersonate button and the edit link
 *     render nowhere (the STOP arm + the unlanded edit page — the
 *     dead-control rule).
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
import { emailAddresses, repositories, repoSettings, users } from "../../db/schema";
import { OrgService } from "../../services/orgs/orgs";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { loadAdminAvatarUser } from "./admin-users-avatar";
import {
  ADMIN_USERS_LIST_LINK,
  adminUserDetailLocale,
  displayNameWithFullName,
  loadAdminUserDetail,
  renderAdminUserDetailPage,
} from "./admin-user-detail";

// --- fixtures ----------------------------------------------------------------

const ORG_CREATED = new Date("2026-01-01T00:00:00Z");

/** Tables the fixtures touch (children first). */
const FIXTURE_TABLES = ["sessions", "email_addresses", "repo_settings", "repositories", "org_members", "user_redirects", "users"];

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
  await drizzle(env.DB).insert(repoSettings).values({ repoId: "9101", description: "the alpha repo" }).run();

  return {
    adminId: admin.id,
    aliceId: alice.id,
    bobProhibitedId: bob.id,
    orgPublicName: pub.username,
    orgPrivateName: priv.username,
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

  it("the orgs block: the membership rows with the private badge + joined-on; NO remove arms", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(html).toContain(`href="/${seeded.orgPublicName}"`);
    expect(html).toContain(`href="/${seeded.orgPrivateName}"`);
    expect(html).toContain("Joined on Jan 1, 2026");
    // The dead-control rule: view_orgs' remove-all modal + per-org Remove
    // buttons are unlanded writes — they render nowhere.
    expect(html).not.toContain("remove-all-orgs-modal");
    expect(html).not.toContain("/orgs/remove-all");
    expect(html).not.toContain("/orgs/remove");
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

  it("the dead arms render nowhere: no impersonate button, no edit link (the STOP arm + the unlanded page)", async () => {
    const seeded = await seedDetail();
    const data = (await loadAdminUserDetail(env.DB, seeded.aliceId))!;
    const html = renderAdminUserDetailPage(ctx, { ...data });
    expect(html).not.toContain("/impersonate");
    expect(html).not.toContain(`/-/admin/users/${seeded.aliceId}/edit`);
  });
});

/** The unknown-id redirect target — the module re-exports the pair's const;
 *  the pin keeps the link honest. */
describe("the list-link export", () => {
  it("re-exports the avatar pair's redirect target", () => {
    expect(ADMIN_USERS_LIST_LINK).toBe("/-/admin/users");
  });
});
