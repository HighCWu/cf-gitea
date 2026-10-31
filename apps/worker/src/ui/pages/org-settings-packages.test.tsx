/**
 * The org settings PACKAGES tab's tests (the package cleanup-rules
 * management page — web.go:1069-1085's group over the LANDED
 * `package_cleanup_rules` store): the pattern compile (cleanup.ts:153's
 * exact port), the display ellipsis, the form parser's binding parity (the
 * In lists, the NON-ZERO RegexPattern rule, the absent-int zero decode,
 * the checkbox bools, the Required action), the create/edit/remove arms'
 * upstream orders (the dup-type gate, the scoped resolution BEFORE the
 * remove branch, the type-immutable save), the preview's candidate ladder
 * end-to-end against seeded packages/versions/files (keep-count positional
 * trim, keep/remove patterns with the anchored case-insensitive match,
 * match_full_name, remove-days, the internal rows pinned out) plus the
 * descriptor cells (size, creator, Ghost), and the three pages' DOM
 * contracts (list + add/edit + preview — the pageClass, the nav
 * scaffolding's active Packages item, the cargo absence, the error-class
 * re-render arms, the banner text).
 *
 * The route-level matrix (anonymous 303 / non-owner 404 shells /
 * cross-origin 403 / the parse claims) lands WITH THE MOUNT — index.ts is a
 * shared file this unit does not edit (the module header's HANDOFF item 4).
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
  packages,
  users,
} from "../../db/schema";
import { getOrInsertBlob } from "../../services/packages/blobs";
import { getOrInsertPackage, getOrInsertVersion } from "../../services/packages/model";
import type { OrgRecord } from "../../services/orgs/orgs";
import type { UiManifest } from "../manifest";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import {
  CLEANUP_RULE_KEEP_COUNTS,
  CLEANUP_RULE_REMOVE_DAYS,
  applyOrgCleanupRuleCreate,
  applyOrgCleanupRuleEdit,
  cleanupRuleDays,
  cleanupRuleKeepCountN,
  cleanupRulePreviewOverview,
  compileOrgCleanupRulePattern,
  ellipsisPattern,
  findOrgScopedCleanupRule,
  hasOrgCleanupRuleForType,
  loadOrgCleanupRuleEditPageData,
  loadOrgCleanupRulePreview,
  loadOrgPackagesSettingsPageData,
  listOrgCleanupRules,
  orgCleanupRuleEditDataForAdd,
  orgCleanupRuleEditDataFromForm,
  orgSettingsPackagesLocale,
  parseOrgCleanupRuleForm,
  renderOrgCleanupRuleEditPage,
  renderOrgCleanupRulePreviewPage,
  renderOrgSettingsPackagesPage,
} from "./org-settings-packages";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
// The preview's fixed clock (the runners twin's fixed-NOW posture).
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

const org: OrgRecord = {
  id: 7,
  username: "coalition",
  usernameLower: "coalition",
  email: null,
  fullName: "The Coalition",
  description: null,
  website: null,
  location: null,
  avatarEmail: null,
  useCustomAvatar: false,
  visibility: "public",
  numMembers: 2,
  repoAdminChangeTeamAccess: false,
  createdAt: T0,
};

/** The private-visibility org (the preview badge's Private arm). */
const privateOrg: OrgRecord = { ...org, id: 8, username: "closed-coalition", usernameLower: "closed-coalition", visibility: "private" };

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

async function seedUser(username: string): Promise<number> {
  const rows = await db()
    .insert(users)
    .values({ username, usernameLower: username.toLowerCase(), status: "active", createdAt: T0 })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return user.id;
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

// --- the compile + the ellipsis ------------------------------------------------

describe("compileOrgCleanupRulePattern (cleanup.ts:153's port — upstream (?i)\\A…\\z)", () => {
  it("empty → null (no matcher); a valid pattern compiles anchored and case-insensitive", () => {
    expect(compileOrgCleanupRulePattern("")).toBeNull();
    const matcher = compileOrgCleanupRulePattern("v1");
    expect(matcher).not.toBeNull();
    expect(matcher!.test("V1")).toBe(true); // the "i" flag
    expect(matcher!.test("v1")).toBe(true);
    expect(matcher!.test("xv1x")).toBe(false); // the ^(?:…)$ anchors
    expect(matcher!.test("v10")).toBe(false);
  });

  it("an un-compilable pattern → null (the consumer's skip arm; the preview's throw arm)", () => {
    expect(compileOrgCleanupRulePattern("([")).toBeNull();
    expect(compileOrgCleanupRulePattern("*oops")).toBeNull();
  });
});

describe("ellipsisPattern (StringUtils.EllipsisString's ASCII port)", () => {
  it("short strings ride unchanged; long strings cut to limit-1 + the ellipsis", () => {
    expect(ellipsisPattern("abc", 100)).toBe("abc");
    expect(ellipsisPattern("a".repeat(100), 100)).toBe("a".repeat(100));
    const long = "b".repeat(120);
    const cut = ellipsisPattern(long, 100);
    expect(cut).toBe("b".repeat(99) + "…");
    expect([...cut].length).toBe(100);
  });
});

describe("the locale helpers (the parameterized upstream strings)", () => {
  it("keeps the %d texts", () => {
    expect(cleanupRuleKeepCountN(5)).toBe("5 versions per package");
    expect(cleanupRuleDays(30)).toBe("30 days");
    expect(cleanupRulePreviewOverview(2)).toBe("2 packages are scheduled to be removed.");
    expect(CLEANUP_RULE_KEEP_COUNTS).toEqual([0, 1, 5, 10, 25, 50, 100]);
    expect(CLEANUP_RULE_REMOVE_DAYS).toEqual([0, 7, 14, 30, 60, 90, 180]);
  });
});

// --- the form parser -----------------------------------------------------------

describe("parseOrgCleanupRuleForm (PackageCleanupRuleForm's binding parity)", () => {
  it("parses a full valid form", () => {
    const parsed = parseOrgCleanupRuleForm(fullForm);
    expect(parsed.invalid).toBe(false);
    expect(parsed.values).toMatchObject({
      id: 0,
      enabled: true,
      type: "generic",
      keepCount: 5,
      keepPattern: "keep-.*",
      removeDays: 30,
      removePattern: "rc-.*",
      matchFullName: true,
      action: "save",
    });
  });

  it("absent ints decode to the zero value (upstream's decode); present ints must be in the In lists", () => {
    const absent = parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm" }));
    expect(absent.invalid).toBe(false);
    expect(absent.values.keepCount).toBe(0);
    expect(absent.values.removeDays).toBe(0);

    for (const bad of ["banana", "3", "-1", "7x"]) {
      const parsed = parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm", keep_count: bad }));
      expect(parsed.invalid).toBe(true);
      expect(parsed.errors.keepCount).toBe(true);
    }
    for (const good of ["0", "1", "5", "10", "25", "50", "100"]) {
      expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm", keep_count: good })).invalid).toBe(false);
    }
    for (const bad of ["8", "45", "-7"]) {
      const parsed = parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm", remove_days: bad }));
      expect(parsed.invalid).toBe(true);
      expect(parsed.errors.removeDays).toBe(true);
    }
    for (const good of ["0", "7", "14", "30", "60", "90", "180"]) {
      expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm", remove_days: good })).invalid).toBe(false);
    }
  });

  it("the type is Required and must be in the 23-value list; the action is Required and In(save,remove)", () => {
    expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "save" })).errors.type).toBe(true);
    expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "not-a-type" })).errors.type).toBe(true);
    expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "cargo" })).invalid).toBe(false); // the full TypeList rides (the module header)
    expect(parseOrgCleanupRuleForm(new URLSearchParams({ type: "npm" })).errors.action).toBe(true);
    expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "explode", type: "npm" })).errors.action).toBe(true);
    expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "remove", type: "npm" })).invalid).toBe(false);
  });

  it("the NON-ZERO RegexPattern rule: empty passes, a non-empty value must compile", () => {
    expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm" })).errors.keepPattern).toBe(false);
    expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm", keep_pattern: "([" })).errors.keepPattern).toBe(true);
    expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm", keep_pattern: "^v[0-9]+$" })).invalid).toBe(false);
    expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm", remove_pattern: "*bad" })).errors.removePattern).toBe(true);
  });

  it("the checkbox bools and the hidden id", () => {
    const checked = parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm", enabled: "on", match_full_name: "true" }));
    expect(checked.values.enabled).toBe(true);
    expect(checked.values.matchFullName).toBe(true);
    const unchecked = parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm" }));
    expect(unchecked.values.enabled).toBe(false);
    expect(unchecked.values.matchFullName).toBe(false);

    expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm" })).values.id).toBe(0);
    expect(parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm", id: "12" })).values.id).toBe(12);
    const junkId = parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm", id: "junk" }));
    expect(junkId.invalid).toBe(true);
    expect(junkId.errors.id).toBe(true); // no template arm renders it (the module header)
  });
});

// --- the create / edit / remove arms ---------------------------------------------

describe("applyOrgCleanupRuleCreate (performRuleEditPost's add arm)", () => {
  it("hasOrgCleanupRuleForType gates per owner+type (the add arm's pre-check; the UNIQUE index is the backstop)", async () => {
    expect(await hasOrgCleanupRuleForType(env.DB, org.id, "generic")).toBe(false);
    await seedRule({ ownerId: org.id, type: "generic" });
    expect(await hasOrgCleanupRuleForType(env.DB, org.id, "generic")).toBe(true);
    expect(await hasOrgCleanupRuleForType(env.DB, org.id, "npm")).toBe(false); // another type
    expect(await hasOrgCleanupRuleForType(env.DB, privateOrg.id, "generic")).toBe(false); // another owner
  });

  it("inserts with the form's fields, the org as owner and the form's type; answers the row id", async () => {
    const now = new Date(NOW.getTime() + 1_000);
    const result = await applyOrgCleanupRuleCreate(env.DB, org.id, parseOrgCleanupRuleForm(fullForm).values, now);
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    const row = await db().select().from(packageCleanupRules).where(eq(packageCleanupRules.id, result.ruleId)).get();
    expect(row).toMatchObject({
      ownerId: org.id,
      type: "generic",
      enabled: true,
      keepCount: 5,
      keepPattern: "keep-.*",
      removeDays: 30,
      removePattern: "rc-.*",
      matchFullName: true,
    });
    expect(row!.createdUnix.getTime()).toBe(now.getTime());
    expect(row!.updatedUnix.getTime()).toBe(now.getTime());
  });

  it("the duplicate gate: a second rule for the same owner+type answers duplicate-type and inserts nothing", async () => {
    await applyOrgCleanupRuleCreate(env.DB, org.id, parseOrgCleanupRuleForm(fullForm).values, NOW);
    const second = await applyOrgCleanupRuleCreate(env.DB, org.id, parseOrgCleanupRuleForm(fullForm).values, NOW);
    expect(second).toEqual({ outcome: "duplicate-type" });
    const rows = await db().select().from(packageCleanupRules).all();
    expect(rows).toHaveLength(1);
  });

  it("the duplicate gate is owner-scoped: a rival org's same-type rule does not block", async () => {
    await applyOrgCleanupRuleCreate(env.DB, org.id, parseOrgCleanupRuleForm(fullForm).values, NOW);
    const rival = await applyOrgCleanupRuleCreate(env.DB, privateOrg.id, parseOrgCleanupRuleForm(fullForm).values, NOW);
    expect(rival.outcome).toBe("created");
  });
});

describe("applyOrgCleanupRuleEdit (PerformRuleEditPost's orders)", () => {
  it("save overwrites the mutable fields + the updated stamp and keeps type/owner/created", async () => {
    const ruleId = await seedRule({ ownerId: org.id, type: "generic", enabled: true, keepCount: 1, keepPattern: "old", removeDays: 7, removePattern: "old-.*" });
    const before = (await db().select().from(packageCleanupRules).where(eq(packageCleanupRules.id, ruleId)).get())!;
    const later = new Date(NOW.getTime() + 5_000);
    const values = parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "npm", keep_count: "50", keep_pattern: "new", remove_days: "90", remove_pattern: "new-.*", enabled: "on", match_full_name: "on" })).values;
    const result = await applyOrgCleanupRuleEdit(env.DB, org.id, ruleId, values, later);
    expect(result).toEqual({ outcome: "updated", ruleId });
    const after = (await db().select().from(packageCleanupRules).where(eq(packageCleanupRules.id, ruleId)).get())!;
    // Type is NOT among the overwritten fields (shared/packages.go:90-96 —
    // the posted npm is ignored; the row keeps generic).
    expect(after.type).toBe("generic");
    expect(after.ownerId).toBe(org.id);
    expect(after.createdUnix.getTime()).toBe(before.createdUnix.getTime());
    expect(after.enabled).toBe(true);
    expect(after.keepCount).toBe(50);
    expect(after.keepPattern).toBe("new");
    expect(after.removeDays).toBe(90);
    expect(after.removePattern).toBe("new-.*");
    expect(after.matchFullName).toBe(true);
    expect(after.updatedUnix.getTime()).toBe(later.getTime());
  });

  it("remove deletes the rule — checked BEFORE validation upstream, so the applier runs it regardless of field errors", async () => {
    const ruleId = await seedRule({ ownerId: org.id, type: "generic" });
    const values = parseOrgCleanupRuleForm(new URLSearchParams({ action: "remove", type: "npm", keep_pattern: "([" })).values;
    const result = await applyOrgCleanupRuleEdit(env.DB, org.id, ruleId, values, NOW);
    expect(result).toEqual({ outcome: "removed" });
    expect(await db().select().from(packageCleanupRules).all()).toHaveLength(0);
  });

  it("the scoped resolution FIRST: a foreign, stale or non-positive id answers missing and touches nothing", async () => {
    const ownId = await seedRule({ ownerId: org.id, type: "generic" });
    const foreignId = await seedRule({ ownerId: privateOrg.id, type: "npm" });
    expect(await applyOrgCleanupRuleEdit(env.DB, org.id, foreignId, { ...parseOrgCleanupRuleForm(fullForm).values, action: "remove" }, NOW)).toEqual({ outcome: "missing" });
    expect(await applyOrgCleanupRuleEdit(env.DB, org.id, 999_999, { ...parseOrgCleanupRuleForm(fullForm).values, action: "remove" }, NOW)).toEqual({ outcome: "missing" });
    expect(await applyOrgCleanupRuleEdit(env.DB, org.id, 0, { ...parseOrgCleanupRuleForm(fullForm).values, action: "remove" }, NOW)).toEqual({ outcome: "missing" });
    expect(await db().select().from(packageCleanupRules).all()).toHaveLength(2);
    expect(await findOrgScopedCleanupRule(env.DB, org.id, ownId)).not.toBeNull();
  });
});

// --- the list + the edit-page loaders ---------------------------------------------

describe("listOrgCleanupRules / loadOrgPackagesSettingsPageData (GetCleanupRulesByOwner)", () => {
  it("lists exactly the org's rules — a rival org's never rides", async () => {
    await seedRule({ ownerId: org.id, type: "generic", enabled: true, keepCount: 5 });
    await seedRule({ ownerId: org.id, type: "npm", removeDays: 30 });
    await seedRule({ ownerId: privateOrg.id, type: "generic" });
    const data = await loadOrgPackagesSettingsPageData(env.DB, org);
    expect(data.org).toBe(org);
    expect(data.rules).toHaveLength(2);
    expect(data.rules.map((rule) => rule.type).sort()).toEqual(["generic", "npm"]);
    expect((await listOrgCleanupRules(env.DB, privateOrg.id)).map((rule) => rule.type)).toEqual(["generic"]);
  });

  it("an empty store lists none (the page renders the none-line)", async () => {
    expect(await listOrgCleanupRules(env.DB, org.id)).toEqual([]);
  });
});

describe("findOrgScopedCleanupRule + loadOrgCleanupRuleEditPageData (getCleanupRuleByContext)", () => {
  it("resolves only the org's own rows; a foreign/stale/zero/negative id is null", async () => {
    const ownId = await seedRule({ ownerId: org.id, type: "generic" });
    const foreignId = await seedRule({ ownerId: privateOrg.id, type: "npm" });
    expect((await findOrgScopedCleanupRule(env.DB, org.id, ownId))?.type).toBe("generic");
    expect(await findOrgScopedCleanupRule(env.DB, org.id, foreignId)).toBeNull();
    expect(await findOrgScopedCleanupRule(env.DB, org.id, 999_999)).toBeNull();
    expect(await findOrgScopedCleanupRule(env.DB, org.id, 0)).toBeNull();
    expect(await findOrgScopedCleanupRule(env.DB, org.id, -5)).toBeNull();
  });

  it("the edit page data maps the row; a foreign id is the NotFound arm (null)", async () => {
    const ruleId = await seedRule({ ownerId: org.id, type: "maven", enabled: true, keepCount: 10, keepPattern: "release-.*", removeDays: 60, removePattern: "dev-.*", matchFullName: true });
    const data = (await loadOrgCleanupRuleEditPageData(env.DB, org, ruleId))!;
    expect(data.isEditRule).toBe(true);
    expect(data.rule).toEqual({ id: ruleId, enabled: true, type: "maven", matchFullName: true, keepCount: 10, keepPattern: "release-.*", removeDays: 60, removePattern: "dev-.*" });
    expect(data.errType).toBe(false);
    expect(data.error).toBeNull();
    expect(await loadOrgCleanupRuleEditPageData(env.DB, org, 999_999)).toBeNull();
  });

  it("the add page data is the zero rule (SetRuleAddContext)", () => {
    const data = orgCleanupRuleEditDataForAdd(org);
    expect(data.isEditRule).toBe(false);
    expect(data.rule).toEqual({ id: 0, enabled: false, type: "", matchFullName: false, keepCount: 0, keepPattern: "", removeDays: 0, removePattern: "" });
  });
});

// --- the preview (the sweep loop's ladder over searchVersions + descriptors) -------

describe("loadOrgCleanupRulePreview (SetRulePreviewContext — shared/packages.go:136-207)", () => {
  it("answers missing for a foreign/stale id before any read", async () => {
    await seedRule({ ownerId: privateOrg.id, type: "generic" });
    expect(await loadOrgCleanupRulePreview(env.DB, org, 999_999, NOW)).toEqual({ kind: "missing" });
    expect(await loadOrgCleanupRulePreview(env.DB, org, 0, NOW)).toEqual({ kind: "missing" });
  });

  it("throws on a hand-seeded non-compilable pattern (upstream ServerError CompiledPattern)", async () => {
    const ruleId = await seedRule({ ownerId: org.id, type: "generic", keepPattern: "([" });
    await expect(loadOrgCleanupRulePreview(env.DB, org, ruleId, NOW)).rejects.toThrow(/does not compile/);
  });

  it("the full ladder: keep-count positional trim → remove-days cut; the newest stay, the old go, nothing is deleted", async () => {
    const pkgId = (await seedPackage(org.id, "App")).id;
    await seedVersion(pkgId, "v4", NOW); // the keep-count shield (position 0)
    await seedVersion(pkgId, "v3", new Date(NOW.getTime() - 1 * DAY)); // position 1
    await seedVersion(pkgId, "v2", new Date(NOW.getTime() - 10 * DAY)); // candidate (past the trim, past 7 days)
    const v1 = await seedVersion(pkgId, "v1", new Date(NOW.getTime() - 20 * DAY)); // candidate
    const ruleId = await seedRule({ ownerId: org.id, type: "generic", keepCount: 2, removeDays: 7 });

    const data = await loadOrgCleanupRulePreview(env.DB, org, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    expect(data.rows.map((row) => row.version.version)).toEqual(["v2", "v1"]); // created-desc within the package
    expect(v1).toBeGreaterThan(0);

    // The preview never deletes (GET only).
    expect(await db().select().from(packageVersions).where(eq(packageVersions.packageId, pkgId)).all()).toHaveLength(4);
  });

  it("the fetch is unbounded: 12 candidates all ride (the paginator-less Find — searchVersions' no-page/limit arm; identical rows before/after the searchVersions{PackageID} upgrade)", async () => {
    const pkgId = (await seedPackage(org.id, "Many")).id;
    for (let i = 1; i <= 12; i++) {
      await seedVersion(pkgId, `1.${i}`, new Date(NOW.getTime() - i * DAY));
    }
    const ruleId = await seedRule({ ownerId: org.id, type: "generic", removeDays: 0 });
    const data = await loadOrgCleanupRulePreview(env.DB, org, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    expect(data.rows).toHaveLength(12);
    expect(data.rows[0]?.version.version).toBe("1.1"); // the newest candidate first (created desc)
  });

  it("the keep pattern is an anchored skip: matching versions stay even past the days", async () => {
    const pkgId = (await seedPackage(org.id, "svc")).id;
    await seedVersion(pkgId, "v10", new Date(NOW.getTime() - 30 * DAY)); // "v1" does NOT match (the anchors)
    await seedVersion(pkgId, "v1", new Date(NOW.getTime() - 30 * DAY)); // matches → kept
    const ruleId = await seedRule({ ownerId: org.id, type: "generic", keepPattern: "v1", removeDays: 7 });

    const data = await loadOrgCleanupRulePreview(env.DB, org, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    expect(data.rows.map((row) => row.version.version)).toEqual(["v10"]);
  });

  it("the remove pattern gates: only matching versions are deletable (case-insensitively)", async () => {
    const pkgId = (await seedPackage(org.id, "lib")).id;
    await seedVersion(pkgId, "RC-1", new Date(NOW.getTime() - 30 * DAY));
    await seedVersion(pkgId, "stable-1", new Date(NOW.getTime() - 30 * DAY));
    const ruleId = await seedRule({ ownerId: org.id, type: "generic", removePattern: "^rc-.*", removeDays: 7 });

    const data = await loadOrgCleanupRulePreview(env.DB, org, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    expect(data.rows.map((row) => row.version.version)).toEqual(["RC-1"]);
  });

  it("match_full_name switches the match string to lowerName/lowerVersion (lower-cased, slash-joined)", async () => {
    const aId = (await seedPackage(org.id, "Alpha")).id;
    const bId = (await seedPackage(org.id, "beta")).id;
    await seedVersion(aId, "v1", new Date(NOW.getTime() - 30 * DAY));
    await seedVersion(bId, "v1", new Date(NOW.getTime() - 30 * DAY));

    // One rule at a time — the owner+type UNIQUE allows a single generic
    // rule; the second arm re-seeds after the first rule's row is removed.
    const bareId = await seedRule({ ownerId: org.id, type: "generic", removePattern: "^v1$", removeDays: 7 });
    const bare = await loadOrgCleanupRulePreview(env.DB, org, bareId, NOW);
    if (bare.kind !== "ok") throw new Error("expected ok");
    expect(bare.rows).toHaveLength(2);
    await db().delete(packageCleanupRules).where(eq(packageCleanupRules.id, bareId));

    const fullNameId = await seedRule({ ownerId: org.id, type: "generic", removePattern: "^alpha/v1$", removeDays: 7, matchFullName: true });
    const fullName = await loadOrgCleanupRulePreview(env.DB, org, fullNameId, NOW);
    if (fullName.kind !== "ok") throw new Error("expected ok");
    expect(fullName.rows).toHaveLength(1);
    expect(fullName.rows[0]!.pkg.id).toBe(aId); // the lower-cased toMatch ("alpha/v1") matched
  });

  it("internal versions and internal packages never ride (the excludeInternal pin + GetPackagesByType's is_internal pin)", async () => {
    const pkgId = (await seedPackage(org.id, "internal-src")).id;
    const visibleId = await seedVersion(pkgId, "v1", new Date(NOW.getTime() - 30 * DAY));
    const internalPkg = (await seedPackage(org.id, "Hidden")).id;
    await seedVersion(internalPkg, "v9", new Date(NOW.getTime() - 30 * DAY));
    await db().update(packageVersions).set({ isInternal: true }).where(eq(packageVersions.id, visibleId));
    await db().update(packages).set({ isInternal: true }).where(eq(packages.id, internalPkg));
    const ruleId = await seedRule({ ownerId: org.id, type: "generic", removeDays: 7 });

    const data = await loadOrgCleanupRulePreview(env.DB, org, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    expect(data.rows).toHaveLength(0);
  });

  it("a rule for another type never sees the org's other-type packages; an empty match renders the none arm", async () => {
    await seedPackage(org.id, "only-generic");
    const ruleId = await seedRule({ ownerId: org.id, type: "npm", removeDays: 7 });
    const data = await loadOrgCleanupRulePreview(env.DB, org, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    expect(data.rows).toEqual([]);
  });

  it("the rows carry the descriptor cells: the version web link, the creator (Ghost for creator_id 0) and the summed blob size", async () => {
    const creatorId = await seedUser("bob");
    const pkg = await seedPackage(org.id, "FatPkg");
    const versionId = await seedVersion(pkg.id, "1.0.0", new Date(NOW.getTime() - 30 * DAY), creatorId);
    await seedFile(versionId, "a.bin", 1024, "a".repeat(64), T0);
    await seedFile(versionId, "b.bin", 512, "b".repeat(64), T0);

    const ghostPkg = await seedPackage(org.id, "GhostPkg");
    await seedVersion(ghostPkg.id, "2.0", new Date(NOW.getTime() - 30 * DAY), 0);

    const ruleId = await seedRule({ ownerId: org.id, type: "generic", removeDays: 7 });
    const data = await loadOrgCleanupRulePreview(env.DB, org, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");

    const fat = data.rows.find((row) => row.pkg.lowerName === "fatpkg")!;
    expect(fat.versionLink).toBe("/coalition/-/packages/generic/fatpkg/1.0.0");
    expect(fat.creatorName).toBe("bob");
    expect(fat.sizeText).toBe("1.5 kiB");

    const ghost = data.rows.find((row) => row.pkg.lowerName === "ghostpkg")!;
    expect(ghost.creatorName).toBeNull(); // the Ghost cell at render
    expect(ghost.sizeText).toBe("0 B");
  });
});

// --- the renders -----------------------------------------------------------------

describe("the list page render (packages.tmpl → cleanup_rules/list.tmpl)", () => {
  it("renders the pageClass, the header + add link, the rule rows and the trailing links; no cargo section", async () => {
    const ruleId = await seedRule({ ownerId: org.id, type: "generic", enabled: true, keepCount: 5, keepPattern: "keep-.*", removeDays: 30, removePattern: "rc-.*" });
    const data = await loadOrgPackagesSettingsPageData(env.DB, org);
    const html = renderOrgSettingsPackagesPage(ctx, data);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("organization settings packages");
    expect(html).toContain(orgSettingsPackagesLocale.cleanup_rules_title);
    expect(html).toContain(`href="/coalition/settings/packages/rules/add"`);
    expect(html).toContain(">Generic</a>"); // the type-name title link → the edit page
    expect(html).toContain(`<i>${orgSettingsPackagesLocale.enabled}</i>`);
    expect(html).toContain(`<i>${orgSettingsPackagesLocale.keep_count}:</i> ${cleanupRuleKeepCountN(5)}`);
    expect(html).toContain(`<i>${orgSettingsPackagesLocale.keep_pattern}:</i> keep-.*`);
    expect(html).toContain(`<i>${orgSettingsPackagesLocale.remove_days}:</i> ${cleanupRuleDays(30)}`);
    expect(html).toContain(`<i>${orgSettingsPackagesLocale.remove_pattern}:</i> rc-.*`);
    expect(html).toContain(`href="/coalition/settings/packages/rules/${ruleId}">Edit`);
    expect(html).toContain(`href="/coalition/settings/packages/rules/${ruleId}/preview"`);
    // The cargo section is NOT rendered (the documented dead-control reduction).
    expect(html.toLowerCase()).not.toContain("cargo");
    // The nav scaffolding's Packages item is the active one; the shared
    // family's hrefs ride verbatim (incl. the labels wave-14 divergence).
    expect(html).toContain(`class="active item" href="/coalition/settings/packages"`);
    expect(html).toContain(`href="/coalition/settings"`);
    expect(html).toContain(`href="/coalition/settings/hooks"`);
    expect(html).toContain(`href="/coalition/labels"`);
    expect(html).toContain(`href="/coalition/settings/applications"`);
    expect(html).toContain(`href="/coalition/settings/blocked_users"`);
    expect(html).toContain(`href="/coalition/settings/actions/runners"`);
    expect(html).toContain(`href="/coalition/settings/audit_logs"`);
  });

  it("the disabled rule renders Disabled; the zero facets render no body lines; the empty arm renders the none-line", async () => {
    await seedRule({ ownerId: org.id, type: "npm" });
    const data = await loadOrgPackagesSettingsPageData(env.DB, org);
    const html = renderOrgSettingsPackagesPage(ctx, data);
    expect(html).toContain(`<i>${orgSettingsPackagesLocale.disabled}</i>`);
    expect(html).not.toContain(orgSettingsPackagesLocale.keep_count); // keepCount 0 → no line
    expect(html).not.toContain(orgSettingsPackagesLocale.remove_days);

    const empty = await loadOrgPackagesSettingsPageData(env.DB, privateOrg);
    const emptyHtml = renderOrgSettingsPackagesPage(ctx, empty);
    expect(emptyHtml).toContain(orgSettingsPackagesLocale.none);
  });

  it("a >100-char pattern ellipsizes at 100 display runes", async () => {
    await seedRule({ ownerId: org.id, type: "generic", keepPattern: "x".repeat(150) });
    const data = await loadOrgPackagesSettingsPageData(env.DB, org);
    const html = renderOrgSettingsPackagesPage(ctx, data);
    expect(html).toContain("x".repeat(99) + "…");
    expect(html).not.toContain("x".repeat(150));
  });
});

describe("the add/edit page render (packages_cleanup_rules_edit.tmpl → cleanup_rules/edit.tmpl)", () => {
  it("the add arm: the add header, the rules/add action, the hidden zero id, the full option censuses, the Add button only", () => {
    const html = renderOrgCleanupRuleEditPage(ctx, orgCleanupRuleEditDataForAdd(org));
    expect(html).toContain("organization settings packages");
    expect(html).toContain(orgSettingsPackagesLocale.add_rule);
    expect(html).toContain(`action="/coalition/settings/packages/rules/add"`);
    expect(html).toContain(`<input type="hidden" name="id" value="0"/>`);
    expect(html).toContain('name="type"');
    expect([...html.matchAll(/<option/g)].length).toBe(23 + 7 + 7); // types + keep counts + remove days
    expect(html).toContain('>Cargo</option>'); // the full TypeList rides (the module header)
    expect(html).toContain('value="save">Add</button>');
    expect(html).not.toContain('>Remove</button>');
    expect(html).toContain(orgSettingsPackagesLocale.keep_title);
    expect(html).toContain(orgSettingsPackagesLocale.remove_title);
    expect(html).toContain("The <code>latest</code> version is always kept for Container packages.");
  });

  it("the edit arm: the edit header, the rule action, the disabled type field on the row's type, the Save/Remove/Preview trio, the values echoed", async () => {
    const ruleId = await seedRule({ ownerId: org.id, type: "maven", enabled: true, keepCount: 10, keepPattern: "release-.*", removeDays: 60, removePattern: "dev-.*", matchFullName: true });
    const data = (await loadOrgCleanupRuleEditPageData(env.DB, org, ruleId))!;
    const html = renderOrgCleanupRuleEditPage(ctx, data);
    expect(html).toContain(orgSettingsPackagesLocale.edit_rule);
    expect(html).toContain(`action="/coalition/settings/packages/rules/${ruleId}"`);
    expect(html).toContain(`name="id" value="${ruleId}"`);
    expect(html).toContain('class="disabled field'); // the type field's edit-mode arm (upstream leaves the trailing space when no error)
    expect(html).toContain('<option value="maven" selected=""'); // the row's type echoes selected
    expect(html).toContain('name="enabled" checked=""');
    expect(html).toContain('name="match_full_name" checked=""');
    expect(html).toContain('value="release-.*"');
    expect(html).toContain('value="dev-.*"');
    expect(html).toContain('name="action" value="save"');
    expect(html).toContain('name="action" value="remove"');
    expect(html).toContain(`href="/coalition/settings/packages/rules/${ruleId}/preview"`);
    expect(html).toContain(">Save</button>");
    expect(html).toContain(">Remove</button>");
  });

  it("the re-render arms: the binding-error classes ride the parsed errors; the duplicate-type arm adds the Err_Type class + the banner", () => {
    const parsed = parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "nope", keep_count: "3", keep_pattern: "([" }));
    const data = orgCleanupRuleEditDataFromForm(org, false, parsed);
    const html = renderOrgCleanupRuleEditPage(ctx, data);
    expect(html).toContain('class="field error"'); // keepCount + keepPattern arms
    expect(html).not.toContain('class="disabled field"'); // still the add arm

    const dupParsed = parseOrgCleanupRuleForm(new URLSearchParams({ action: "save", type: "generic" }));
    const dupData = orgCleanupRuleEditDataFromForm(org, false, dupParsed, { errType: true, error: orgSettingsPackagesLocale.already_exists });
    const dupHtml = renderOrgCleanupRuleEditPage(ctx, dupData);
    expect(dupHtml).toContain(`field error`); // the Err_Type class on the type field
    expect(dupHtml).toContain(orgSettingsPackagesLocale.already_exists);
    expect(dupHtml).toContain('class="ui negative message"');
  });
});

describe("the preview page render (packages_cleanup_rules_preview.tmpl → cleanup_rules/preview.tmpl)", () => {
  it("renders the overview line, the six headers, the rows (link, badge, creator, size, published) and the none arm", async () => {
    const creatorId = await seedUser("bob");
    const pkg = await seedPackage(org.id, "FatPkg");
    const versionId = await seedVersion(pkg.id, "1.0.0", new Date(NOW.getTime() - 30 * DAY), creatorId);
    await seedFile(versionId, "a.bin", 1024, "c".repeat(64), T0);
    const ruleId = await seedRule({ ownerId: org.id, type: "generic", removeDays: 7 });

    const data = await loadOrgCleanupRulePreview(env.DB, org, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    const html = renderOrgCleanupRulePreviewPage(ctx, data);
    expect(html).toContain("organization settings packages");
    expect(html).toContain(orgSettingsPackagesLocale.preview);
    expect(html).toContain("1 packages are scheduled to be removed."); // upstream's bare %d shape
    expect(html).toContain(orgSettingsPackagesLocale.admin_version);
    expect(html).toContain(`href="/coalition/-/packages/generic/fatpkg/1.0.0">1.0.0</a>`);
    expect(html).toContain(`href="/bob">bob</a>`);
    expect(html).toContain("1.0 kiB");
    expect(html).toContain("Sep 09, 2025"); // absoluteShort(version.createdUnix = NOW-30d) in UTC
  });

  it("a private-visibility owner renders the Private badge; a missing creator renders Ghost", async () => {
    const pkg = await seedPackage(privateOrg.id, "Secret");
    await seedVersion(pkg.id, "9.9", new Date(NOW.getTime() - 30 * DAY), 0);
    const ruleId = await seedRule({ ownerId: privateOrg.id, type: "generic", removeDays: 7 });

    const data = await loadOrgCleanupRulePreview(env.DB, privateOrg, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    const html = renderOrgCleanupRulePreviewPage(ctx, data);
    expect(html).toContain('<span class="ui basic label">Private</span>');
    expect(html).toContain(`href="/Ghost">Ghost</a>`);
  });

  it("an empty match renders the colspan none-line", async () => {
    const ruleId = await seedRule({ ownerId: org.id, type: "npm", removeDays: 7 });
    const data = await loadOrgCleanupRulePreview(env.DB, org, ruleId, NOW);
    if (data.kind !== "ok") throw new Error("expected ok");
    const html = renderOrgCleanupRulePreviewPage(ctx, data);
    expect(html).toContain("0 packages are scheduled to be removed.");
    expect(html).toContain(orgSettingsPackagesLocale.preview_none);
    expect(html).toContain('colspan="6"');
  });
});
