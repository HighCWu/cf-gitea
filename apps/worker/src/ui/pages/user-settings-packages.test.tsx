/**
 * The USER settings PACKAGES tab's tests (the user-scope twin of
 * org-settings-packages.test.tsx — the same shared shims over `ctx.Doer`):
 * the aliasing re-export surface (the user-named bindings ride the org
 * module's owner-id functions), the user-shaped page-data twins (the list's
 * owner scoping, the add/form/edit loaders over UserProfileRow), the write
 * arms at the user scope (create + the resolve-before-action edit orders),
 * the preview ladder end-to-end against seeded packages/versions/files with
 * the USER's owner cells (the username segment in the version links, the
 * user-visibility badge arms public/limited/private, Ghost), and the three
 * pages' DOM contracts (list + add/edit + preview — the DISTINCT
 * `user packages admin` preview pageClass, the scaffold nav's active
 * Packages item, the cargo AND chef absences, the error-class re-render
 * arms, the banner text).
 *
 * The route-level matrix (anonymous 303 / cross-origin 403 / the parse
 * claims / the cargo+chef tails' engine 404s) lands WITH THE MOUNT —
 * index.ts is a shared file this unit does not edit (the module header's
 * HANDOFF item 4).
 */

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import {
  packageCleanupRules,
  packageFiles,
  packageVersions,
  users,
} from "../../db/schema";
import { getOrInsertBlob } from "../../services/packages/blobs";
import { getOrInsertPackage, getOrInsertVersion } from "../../services/packages/model";
import type { UiManifest } from "../manifest";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import {
  CLEANUP_RULE_KEEP_COUNTS,
  CLEANUP_RULE_REMOVE_DAYS,
  RULE_PREVIEW_VERSIONS_LIMIT,
  applyUserCleanupRuleCreate,
  applyUserCleanupRuleEdit,
  cleanupRuleDays,
  cleanupRuleKeepCountN,
  cleanupRulePreviewOverview,
  compileOrgCleanupRulePattern,
  ellipsisPattern,
  findUserScopedCleanupRule,
  hasUserCleanupRuleForType,
  listUserCleanupRules,
  loadUserCleanupRuleEditPageData,
  loadUserCleanupRulePreview,
  loadUserPackagesSettingsPageData,
  parseUserCleanupRuleForm,
  renderUserCleanupRuleEditPage,
  renderUserCleanupRulePreviewPage,
  renderUserSettingsPackagesPage,
  userCleanupRuleEditDataForAdd,
  userCleanupRuleEditDataFromForm,
  userSettingsPackagesLocale,
} from "./user-settings-packages";
import type { UserProfileRow } from "./user-profile";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
// The preview's fixed clock (the org twin's fixed-NOW posture).
const NOW = new Date(1_760_000_000 * 1000); // 2025-10-09T09:46:40Z
const DAY = 24 * 60 * 60 * 1000;

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };

const ctx: UiContext = {
  viewer,
  origin: "https://test.local",
  assets: shellAssetsFromManifest(manifest),
};

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "package_properties",
    "package_files",
    "package_blobs",
    "package_versions",
    "package_cleanup_rules",
    "packages",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

async function seedUserRow(username: string, visibility: "public" | "limited" | "private" = "public"): Promise<UserProfileRow> {
  const rows = await db()
    .insert(users)
    .values({ username, usernameLower: username.toLowerCase(), status: "active", visibility, createdAt: T0 })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return user;
}

async function seedPackage(ownerId: number, name: string, type = "generic"): Promise<{ id: number; lowerName: string }> {
  const { row } = await getOrInsertPackage(env.DB, { ownerId, type, name, now: T0 });
  return { id: row.id, lowerName: row.lowerName };
}

async function seedVersion(packageId: number, version: string, at: Date, creatorId = 0): Promise<number> {
  const { row } = await getOrInsertVersion(env.DB, { packageId, creatorId, version, now: at });
  return row.id;
}

/** One file+blob under the version (the size cell's substrate). */
async function seedFile(versionId: number, name: string, size: number, sha: string, at: Date): Promise<void> {
  const { row: blob } = await getOrInsertBlob(env.DB, { size, sha256: sha, now: at });
  await db().insert(packageFiles).values({
    versionId,
    blobId: blob.id,
    name,
    lowerName: name.toLowerCase(),
    createdUnix: at,
  });
}

async function seedRule(input: {
  ownerId: number;
  type: string;
  enabled?: boolean;
  keepCount?: number;
  keepPattern?: string;
  removeDays?: number;
  removePattern?: string;
  matchFullName?: boolean;
}): Promise<number> {
  const inserted = await db()
    .insert(packageCleanupRules)
    .values({
      enabled: input.enabled ?? false,
      ownerId: input.ownerId,
      type: input.type,
      keepCount: input.keepCount ?? 0,
      keepPattern: input.keepPattern ?? "",
      removeDays: input.removeDays ?? 0,
      removePattern: input.removePattern ?? "",
      matchFullName: input.matchFullName ?? false,
      createdUnix: T0,
      updatedUnix: T0,
    })
    .returning({ id: packageCleanupRules.id })
    .all();
  const row = inserted[0];
  if (row === undefined) throw new Error("rule seed failed");
  return row.id;
}

const fullForm = new URLSearchParams({
  action: "save",
  type: "generic",
  keep_count: "5",
  keep_pattern: "keep-.*",
  remove_days: "30",
  remove_pattern: "rc-.*",
  enabled: "on",
  match_full_name: "on",
});

// --- the aliasing re-export surface -------------------------------------------

describe("the re-export surface (the owner-agnostic logic rides the org module)", () => {
  it("the aliased bindings behave: the parser, the appliers, the scoped find, the dup gate, the list", async () => {
    const alice = await seedUserRow("alice");
    expect(parseUserCleanupRuleForm(fullForm).values.type).toBe("generic");
    expect(CLEANUP_RULE_KEEP_COUNTS).toEqual([0, 1, 5, 10, 25, 50, 100]);
    expect(CLEANUP_RULE_REMOVE_DAYS).toEqual([0, 7, 14, 30, 60, 90, 180]);
    expect(RULE_PREVIEW_VERSIONS_LIMIT).toBeGreaterThan(0);
    expect(compileOrgCleanupRulePattern("v1")!.test("V1")).toBe(true); // the shared compile
    expect(ellipsisPattern("a".repeat(120), 100)).toBe("a".repeat(99) + "…");

    // The write + read arms at the USER scope (ownerId = the user's id).
    const created = await applyUserCleanupRuleCreate(env.DB, alice.id, parseUserCleanupRuleForm(fullForm).values, NOW);
    expect(created.outcome).toBe("created");
    if (created.outcome !== "created") return;
    expect(await hasUserCleanupRuleForType(env.DB, alice.id, "generic")).toBe(true);
    const found = await findUserScopedCleanupRule(env.DB, alice.id, created.ruleId);
    expect(found?.ownerId).toBe(alice.id);
    expect((await listUserCleanupRules(env.DB, alice.id)).map((rule) => rule.type)).toEqual(["generic"]);
    expect(cleanupRuleKeepCountN(5)).toBe("5 versions per package");
    expect(cleanupRuleDays(30)).toBe("30 days");
    expect(cleanupRulePreviewOverview(2)).toBe("2 packages are scheduled to be removed.");
    expect(userSettingsPackagesLocale.title).toBe("Packages");
  });
});

// --- the user-shaped page data --------------------------------------------------

describe("loadUserPackagesSettingsPageData (SetPackagesContext over ctx.Doer)", () => {
  it("lists exactly the doer's rules — another user's never rides", async () => {
    const alice = await seedUserRow("alice");
    const bob = await seedUserRow("bob");
    await seedRule({ ownerId: alice.id, type: "generic", enabled: true, keepCount: 5 });
    await seedRule({ ownerId: alice.id, type: "npm", removeDays: 30 });
    await seedRule({ ownerId: bob.id, type: "generic" });
    const data = await loadUserPackagesSettingsPageData(env.DB, alice);
    expect(data.user).toBe(alice);
    expect(data.rules).toHaveLength(2);
    expect(data.rules.map((rule) => rule.type).sort()).toEqual(["generic", "npm"]);
    expect((await loadUserPackagesSettingsPageData(env.DB, bob)).rules).toHaveLength(1);
  });
});

describe("the edit-page data twins (SetRuleAddContext / SetRuleEditContext)", () => {
  it("the add arm is the zero rule over the doer", async () => {
    const alice = await seedUserRow("alice");
    const data = userCleanupRuleEditDataForAdd(alice);
    expect(data.user).toBe(alice);
    expect(data.isEditRule).toBe(false);
    expect(data.rule).toEqual({ id: 0, enabled: false, type: "", matchFullName: false, keepCount: 0, keepPattern: "", removeDays: 0, removePattern: "" });
  });

  it("the edit arm maps the doer's scoped row; a foreign user's id is the NotFound arm", async () => {
    const alice = await seedUserRow("alice");
    const bob = await seedUserRow("bob");
    const ruleId = await seedRule({ ownerId: alice.id, type: "maven", enabled: true, keepCount: 10, keepPattern: "release-.*", removeDays: 60, removePattern: "dev-.*", matchFullName: true });
    const data = (await loadUserCleanupRuleEditPageData(env.DB, alice, ruleId))!;
    expect(data.user).toBe(alice);
    expect(data.isEditRule).toBe(true);
    expect(data.rule).toEqual({ id: ruleId, enabled: true, type: "maven", matchFullName: true, keepCount: 10, keepPattern: "release-.*", removeDays: 60, removePattern: "dev-.*" });
    expect(await loadUserCleanupRuleEditPageData(env.DB, bob, ruleId)).toBeNull();
    expect(await loadUserCleanupRuleEditPageData(env.DB, alice, 999_999)).toBeNull();
  });

  it("the invalid-POST echo composes the submitted values + errors + the banner extras", async () => {
    const alice = await seedUserRow("alice");
    const parsed = parseUserCleanupRuleForm(new URLSearchParams({ action: "save", type: "nope", keep_count: "3" }));
    const data = userCleanupRuleEditDataFromForm(alice, false, parsed, { errType: true, error: userSettingsPackagesLocale.already_exists });
    expect(data.rule.keepCount).toBe(0); // the failed-In decode leaves the zero value (the parser's arm)
    expect(data.errors.keepCount).toBe(true);
    expect(data.errors.type).toBe(true);
    expect(data.errType).toBe(true);
    expect(data.error).toBe(userSettingsPackagesLocale.already_exists);
  });
});

describe("the write arms at the user scope (PerformRuleAddPost / PerformRuleEditPost over ctx.Doer)", () => {
  it("create inserts under the doer's id; the dup gate is doer-scoped", async () => {
    const alice = await seedUserRow("alice");
    const bob = await seedUserRow("bob");
    const first = await applyUserCleanupRuleCreate(env.DB, alice.id, parseUserCleanupRuleForm(fullForm).values, NOW);
    if (first.outcome !== "created") throw new Error("expected created");
    const row = (await db().select().from(packageCleanupRules).where(eq(packageCleanupRules.id, first.ruleId)).get())!;
    expect(row.ownerId).toBe(alice.id);
    expect(await applyUserCleanupRuleCreate(env.DB, alice.id, parseUserCleanupRuleForm(fullForm).values, NOW)).toEqual({ outcome: "duplicate-type" });
    expect((await applyUserCleanupRuleCreate(env.DB, bob.id, parseUserCleanupRuleForm(fullForm).values, NOW)).outcome).toBe("created");
  });

  it("edit resolves the doer's scoped row FIRST (a foreign id is missing); save keeps the type; remove deletes", async () => {
    const alice = await seedUserRow("alice");
    const bob = await seedUserRow("bob");
    const ruleId = await seedRule({ ownerId: alice.id, type: "generic", keepCount: 1, keepPattern: "old" });
    const values = parseUserCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm", keep_count: "50", keep_pattern: "new", remove_days: "90", enabled: "on" })).values;
    expect(await applyUserCleanupRuleEdit(env.DB, bob.id, ruleId, values, NOW)).toEqual({ outcome: "missing" });
    expect(await applyUserCleanupRuleEdit(env.DB, alice.id, ruleId, values, new Date(NOW.getTime() + 1_000))).toEqual({ outcome: "updated", ruleId });
    const after = (await db().select().from(packageCleanupRules).where(eq(packageCleanupRules.id, ruleId)).get())!;
    expect(after.type).toBe("generic"); // the type-immutable save
    expect(after.keepCount).toBe(50);
    expect(await applyUserCleanupRuleEdit(env.DB, alice.id, ruleId, { ...values, action: "remove" }, NOW)).toEqual({ outcome: "removed" });
    expect(await db().select().from(packageCleanupRules).where(eq(packageCleanupRules.id, ruleId)).all()).toHaveLength(0);
  });
});

// --- the preview (the ladder over the doer's packages) -----------------------------

describe("loadUserCleanupRulePreview (SetRulePreviewContext over ctx.Doer)", () => {
  it("answers missing for a foreign/stale id before any read; throws on a non-compilable stored pattern", async () => {
    const alice = await seedUserRow("alice");
    const bob = await seedUserRow("bob");
    await seedRule({ ownerId: bob.id, type: "generic" });
    expect(await loadUserCleanupRulePreview(env.DB, alice, 999_999, NOW)).toEqual({ kind: "missing" });
    const foreign = await seedRule({ ownerId: bob.id, type: "npm" });
    expect(await loadUserCleanupRulePreview(env.DB, alice, foreign, NOW)).toEqual({ kind: "missing" });
    const brokenId = await seedRule({ ownerId: alice.id, type: "generic", keepPattern: "([" });
    await expect(loadUserCleanupRulePreview(env.DB, alice, brokenId, NOW)).rejects.toThrow(/does not compile/);
  });

  it("the ladder over the doer's packages: keep-count trim → remove-days cut; the user's username rides the version links", async () => {
    const alice = await seedUserRow("alice");
    const pkgId = (await seedPackage(alice.id, "App")).id;
    await seedVersion(pkgId, "v4", NOW); // the keep-count shield
    await seedVersion(pkgId, "v3", new Date(NOW.getTime() - 1 * DAY));
    await seedVersion(pkgId, "v2", new Date(NOW.getTime() - 10 * DAY)); // candidate
    await seedVersion(pkgId, "v1", new Date(NOW.getTime() - 20 * DAY)); // candidate
    const ruleId = await seedRule({ ownerId: alice.id, type: "generic", keepCount: 2, removeDays: 7 });

    const data = await loadUserCleanupRulePreview(env.DB, alice, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    expect(data.user).toBe(alice);
    expect(data.rows.map((row) => row.version.version)).toEqual(["v2", "v1"]);
    expect(data.rows.every((row) => row.versionLink.startsWith(`/${alice.username}/-/packages/generic/app/`))).toBe(true);
    // The preview never deletes (GET only).
    expect(await db().select().from(packageVersions).where(eq(packageVersions.packageId, pkgId)).all()).toHaveLength(4);
  });

  it("the descriptor cells: the creator renders by name, creator_id 0 renders Ghost at the page; the size sums the blobs", async () => {
    const alice = await seedUserRow("alice");
    const creator = await seedUserRow("bob");
    const pkg = await seedPackage(alice.id, "FatPkg");
    const versionId = await seedVersion(pkg.id, "1.0.0", new Date(NOW.getTime() - 30 * DAY), creator.id);
    await seedFile(versionId, "a.bin", 1024, "a".repeat(64), T0);
    await seedFile(versionId, "b.bin", 512, "b".repeat(64), T0);
    const ghostPkg = await seedPackage(alice.id, "GhostPkg");
    await seedVersion(ghostPkg.id, "2.0", new Date(NOW.getTime() - 30 * DAY), 0);
    const ruleId = await seedRule({ ownerId: alice.id, type: "generic", removeDays: 7 });

    const data = await loadUserCleanupRulePreview(env.DB, alice, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    const fat = data.rows.find((row) => row.pkg.lowerName === "fatpkg")!;
    expect(fat.creatorName).toBe("bob");
    expect(fat.versionLink).toBe("/alice/-/packages/generic/fatpkg/1.0.0");
    expect(fat.sizeText).toBe("1.5 kiB");
    expect(data.rows.find((row) => row.pkg.lowerName === "ghostpkg")!.creatorName).toBeNull();
  });
});

// --- the renders -----------------------------------------------------------------

describe("the list page render (user/settings/packages.tmpl → cleanup_rules/list.tmpl)", () => {
  it("renders the pageClass, the header + add link over the FIXED user base, the rule rows and the trailing links; no cargo AND no chef section", async () => {
    const alice = await seedUserRow("alice");
    const ruleId = await seedRule({ ownerId: alice.id, type: "generic", enabled: true, keepCount: 5, keepPattern: "keep-.*", removeDays: 30, removePattern: "rc-.*" });
    const data = await loadUserPackagesSettingsPageData(env.DB, alice);
    const html = renderUserSettingsPackagesPage(ctx, data);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("user settings packages");
    expect(html).toContain(userSettingsPackagesLocale.cleanup_rules_title);
    expect(html).toContain(`href="/user/settings/packages/rules/add"`);
    expect(html).toContain(">Generic</a>");
    expect(html).toContain(`<i>${userSettingsPackagesLocale.enabled}</i>`);
    expect(html).toContain(`<i>${userSettingsPackagesLocale.keep_count}:</i> ${cleanupRuleKeepCountN(5)}`);
    expect(html).toContain(`<i>${userSettingsPackagesLocale.keep_pattern}:</i> keep-.*`);
    expect(html).toContain(`<i>${userSettingsPackagesLocale.remove_days}:</i> ${cleanupRuleDays(30)}`);
    expect(html).toContain(`<i>${userSettingsPackagesLocale.remove_pattern}:</i> rc-.*`);
    expect(html).toContain(`href="/user/settings/packages/rules/${ruleId}">Edit`);
    expect(html).toContain(`href="/user/settings/packages/rules/${ruleId}/preview"`);
    // Neither substrate section renders (the documented omissions).
    expect(html.toLowerCase()).not.toContain("cargo");
    expect(html).not.toContain("chef/regenerate_keypair");
    expect(html).not.toContain("Chef Registry"); // the chef section's header (locale key packages.owner.settings.chef.title)
    // The scaffold nav's Packages item is the active one (the mount swaps
    // in the shared UserSettingsNavbar with the same href).
    expect(html).toContain(`class="active item" href="/user/settings/packages"`);
  });

  it("the disabled rule renders Disabled; the empty arm renders the none-line; long patterns ellipsize", async () => {
    const alice = await seedUserRow("alice");
    await seedRule({ ownerId: alice.id, type: "npm", keepPattern: "x".repeat(150) });
    const data = await loadUserPackagesSettingsPageData(env.DB, alice);
    const html = renderUserSettingsPackagesPage(ctx, data);
    expect(html).toContain(`<i>${userSettingsPackagesLocale.disabled}</i>`);
    expect(html).toContain("x".repeat(99) + "…");
    expect(html).not.toContain("x".repeat(150));

    const loner = await seedUserRow("loner");
    const emptyHtml = renderUserSettingsPackagesPage(ctx, await loadUserPackagesSettingsPageData(env.DB, loner));
    expect(emptyHtml).toContain(userSettingsPackagesLocale.none);
  });
});

describe("the add/edit page render (packages_cleanup_rules_edit.tmpl → cleanup_rules/edit.tmpl)", () => {
  it("the add arm: the add header, the rules/add action over the user base, the hidden zero id, the full option censuses, the Add button only", async () => {
    const alice = await seedUserRow("alice");
    const html = renderUserCleanupRuleEditPage(ctx, userCleanupRuleEditDataForAdd(alice));
    expect(html).toContain("user settings packages");
    expect(html).toContain(userSettingsPackagesLocale.add_rule);
    expect(html).toContain(`action="/user/settings/packages/rules/add"`);
    expect(html).toContain(`<input type="hidden" name="id" value="0"/>`);
    expect([...html.matchAll(/<option/g)].length).toBe(23 + 7 + 7); // types + keep counts + remove days
    expect(html).toContain(">Chef</option>"); // a chef RULE is functional (the header)
    expect(html).toContain(">Cargo</option>");
    expect(html).toContain('value="save">Add</button>');
    expect(html).not.toContain(">Remove</button>");
  });

  it("the edit arm: the edit header, the rule action, the disabled type field, the Save/Remove/Preview trio", async () => {
    const alice = await seedUserRow("alice");
    const ruleId = await seedRule({ ownerId: alice.id, type: "maven", enabled: true, keepCount: 10, keepPattern: "release-.*", removeDays: 60, removePattern: "dev-.*", matchFullName: true });
    const data = (await loadUserCleanupRuleEditPageData(env.DB, alice, ruleId))!;
    const html = renderUserCleanupRuleEditPage(ctx, data);
    expect(html).toContain(userSettingsPackagesLocale.edit_rule);
    expect(html).toContain(`action="/user/settings/packages/rules/${ruleId}"`);
    expect(html).toContain(`name="id" value="${ruleId}"`);
    expect(html).toContain('class="disabled field');
    expect(html).toContain('<option value="maven" selected=""');
    expect(html).toContain('name="action" value="save"');
    expect(html).toContain('name="action" value="remove"');
    expect(html).toContain(`href="/user/settings/packages/rules/${ruleId}/preview"`);
    expect(html).toContain(">Save</button>");
    expect(html).toContain(">Remove</button>");
  });

  it("the re-render arms: the binding-error classes ride the parsed errors; the duplicate arm adds Err_Type + the banner", async () => {
    const alice = await seedUserRow("alice");
    const parsed = parseUserCleanupRuleForm(new URLSearchParams({ action: "save", type: "nope", keep_count: "3", keep_pattern: "([" }));
    const html = renderUserCleanupRuleEditPage(ctx, userCleanupRuleEditDataFromForm(alice, false, parsed));
    expect(html).toContain('class="field error"');

    const dupParsed = parseUserCleanupRuleForm(new URLSearchParams({ action: "save", type: "generic" }));
    const dupHtml = renderUserCleanupRuleEditPage(ctx, userCleanupRuleEditDataFromForm(alice, false, dupParsed, { errType: true, error: userSettingsPackagesLocale.already_exists }));
    expect(dupHtml).toContain("field error");
    expect(dupHtml).toContain(userSettingsPackagesLocale.already_exists);
    expect(dupHtml).toContain('class="ui negative message"');
  });
});

describe("the preview page render (packages_cleanup_rules_preview.tmpl → cleanup_rules/preview.tmpl)", () => {
  it("renders the DISTINCT `user packages admin` pageClass, the overview line, the rows and the doer-visibility badge arms", async () => {
    const alice = await seedUserRow("alice", "private");
    const creator = await seedUserRow("bob");
    const pkg = await seedPackage(alice.id, "FatPkg");
    const versionId = await seedVersion(pkg.id, "1.0.0", new Date(NOW.getTime() - 30 * DAY), creator.id);
    await seedFile(versionId, "a.bin", 1024, "c".repeat(64), T0);
    const ruleId = await seedRule({ ownerId: alice.id, type: "generic", removeDays: 7 });

    const data = await loadUserCleanupRulePreview(env.DB, alice, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    const html = renderUserCleanupRulePreviewPage(ctx, data);
    expect(html).toContain("user packages admin"); // preview.tmpl:1 — NOT `user settings packages`
    expect(html).not.toContain("user settings packages");
    expect(html).toContain(userSettingsPackagesLocale.preview);
    expect(html).toContain("1 packages are scheduled to be removed."); // upstream's bare %d shape
    expect(html).toContain(`href="/alice/-/packages/generic/fatpkg/1.0.0">1.0.0</a>`);
    expect(html).toContain(`href="/bob">bob</a>`);
    expect(html).toContain("1.0 kiB");
    expect(html).toContain('<span class="ui basic label">Private</span>'); // the doer's own visibility
    expect(html).toContain("Sep 09, 2025"); // absoluteShort(version.createdUnix = NOW-30d) in UTC
  });

  it("a limited-visibility doer renders the Internal badge; a missing creator renders Ghost; an empty match renders the none arm", async () => {
    const limited = await seedUserRow("limited", "limited");
    const pkg = await seedPackage(limited.id, "Pub");
    await seedVersion(pkg.id, "9.9", new Date(NOW.getTime() - 30 * DAY), 0);
    const ruleId = await seedRule({ ownerId: limited.id, type: "generic", removeDays: 7 });

    const data = await loadUserCleanupRulePreview(env.DB, limited, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    const html = renderUserCleanupRulePreviewPage(ctx, data);
    expect(html).toContain('<span class="ui basic label">Internal</span>');
    expect(html).toContain(`href="/Ghost">Ghost</a>`);

    // A public doer with no matching packages renders the colspan none-line.
    const plain = await seedUserRow("plain");
    await seedPackage(plain.id, "only-generic");
    const npmRule = await seedRule({ ownerId: plain.id, type: "npm", removeDays: 7 });
    const empty = await loadUserCleanupRulePreview(env.DB, plain, npmRule, NOW);
    if (empty.kind !== "ok") throw new Error("expected ok");
    const emptyHtml = renderUserCleanupRulePreviewPage(ctx, empty);
    expect(emptyHtml).toContain("0 packages are scheduled to be removed.");
    expect(emptyHtml).toContain(userSettingsPackagesLocale.preview_none);
    expect(emptyHtml).toContain('colspan="6"');
  });
});
