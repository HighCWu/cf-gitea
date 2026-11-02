/**
 * The packages WRITE arms' module tests (census gap #5 — pages/
 * package-settings.tsx over the landed model + terraform services), one
 * fresh world per test behind per-test table wipes (the packages matrix
 * convention). The route-level arms (parseUiRoute claims + the uiRouter
 * .fetch mounts + the write-gate prologue) belong to the integrator's
 * landing window — index.ts is a sibling's file — so THIS suite drives the
 * module's own seams exactly the way the handlers will:
 *
 *   - the settings GET (loadPackageSettingsData): the linked-repo slug,
 *     the write rank (owner true, anonymous false — the handler 404-shells
 *     below write BEFORE this loads), both chrome arms' renders (the
 *     breadcrumb, the visibility-inherit section + the owner-settings
 *     link, the link form with the repo_name value, the danger-zone form
 *     with the typed package_name confirmation, the flash banner slot);
 *   - the link seam (applyPackageSettingsLink): the empty name unlinks,
 *     a named repo under the SAME owner links, a foreign name answers
 *     repo-missing (the upstream JSONError arm's union member);
 *   - the delete seam (applyPackageSettingsDelete): the typed-name
 *     mismatch refuses FIRST (the package row survives), the terraform
 *     LOCKED guard refuses before any write, the exact name deletes the
 *     package and every version;
 *   - the version-delete seam (deletePackageVersionGuarded +
 *     resolveVersionDeleteRedirect): a terraform LATEST version refuses,
 *     a LOCKED terraform version refuses, the redirect stays ON the
 *     package page while any non-internal version remains and falls to
 *     the owner list when the last one goes;
 *   - the terraform lock seams (lockPackageTerraformState /
 *     unlockPackageTerraformState): the manual lock lands (uuid /
 *     "Manual UI Lock" / who / RFC3339 now), a second lock is refused
 *     (already-locked, the state untouched), the unlock zeroes it, the
 *     unlock carries no not-locked arm (DeletePropertiesIfExist).
 *
 * Fixtures seed through the LANDED services (getOrInsertPackage /
 * getOrInsertVersion / linkPackageToRepo / the OrgService org arm) —
 * never hand-written package SQL.
 */

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RepoService } from "../../repos/service";
import { OrgService } from "../../services/orgs/orgs";
import { getOrInsertPackage, getOrInsertVersion, linkPackageToRepo } from "../../services/packages/model";
import { getTerraformLock, isTerraformLockLocked } from "../../services/packages/terraform";
import { packages, projects, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  applyPackageSettingsDelete,
  applyPackageSettingsLink,
  deletePackageVersionGuarded,
  loadPackageSettingsData,
  lockPackageTerraformState,
  parsePackageSettingsForm,
  renderPackageSettingsPage,
  resolveVersionDeleteRedirect,
  unlockPackageTerraformState,
} from "./package-settings";
import type { PackagesOwner } from "./packages";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const assets = shellAssetsFromManifest(manifest);

/** Tables the fixtures touch (children first — the model suite's sweep
 *  convention; package_properties carries the terraform lock). */
const FIXTURE_TABLES = [
  "projects",
  "package_properties",
  "package_files",
  "package_blobs",
  "package_versions",
  "package_cleanup_rules",
  "packages",
  "repo_units",
  "repo_settings",
  "repo_counters",
  "repositories",
  "follows",
  "team_members",
  "team_repo_access",
  "teams",
  "org_members",
  "user_redirects",
  "users",
];

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of FIXTURE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

async function seedUser(
  username: string,
  opts: { isAdmin?: boolean; type?: "user" | "org"; visibility?: "public" | "limited" | "private" } = {},
) {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: opts.isAdmin ?? false,
      status: "active",
      type: opts.type ?? "user",
      visibility: opts.visibility ?? "public",
      createdAt: T0,
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return user;
}

/** One package + version through the LANDED model service. */
async function seedPackageVersion(
  ownerId: number,
  name: string,
  version: string,
  opts: { creatorId?: number; type?: string; now?: Date } = {},
) {
  const { row: pkg } = await getOrInsertPackage(env.DB, {
    ownerId,
    type: opts.type ?? "generic",
    name,
    now: opts.now ?? T0,
  });
  const { row: ver } = await getOrInsertVersion(env.DB, {
    packageId: pkg.id,
    creatorId: opts.creatorId ?? ownerId,
    version,
    now: opts.now ?? T0,
  });
  return { pkg, ver };
}

function pageCtx(viewer: Viewer, extra: Partial<UiContext> = {}): UiContext {
  return { viewer, origin: ORIGIN, assets, ...extra };
}

/** The full users row by id (the loaders' UserProfileRow input). */
async function rowOf(id: number) {
  const row = await db().select().from(users).where(eq(users.id, id)).get();
  if (row === undefined) throw new Error("user row vanished");
  return row;
}

// ---------------------------------------------------------------------------
// The settings GET (loadPackageSettingsData + the render)
// ---------------------------------------------------------------------------

describe("the settings page — the loader, both chrome arms, the render", () => {
  it("loads the linked-repo slug and the write rank; renders the user arm's sections", async () => {
    const alice = await seedUser("alice");
    const repoService = new RepoService(env.DB);
    const repo = await repoService.create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "linked-repo",
      isPrivate: false,
      status: "ready",
    });
    const { pkg } = await seedPackageVersion(alice.id, "app-tools", "1.0.0");
    await linkPackageToRepo(env.DB, pkg.id, repo.id);
    const owner: PackagesOwner = { kind: "user", user: await rowOf(alice.id) };
    const viewer: Viewer = { kind: "user", id: alice.id, username: "alice", isAdmin: false };

    const data = await loadPackageSettingsData(env.DB, owner, viewer, ORIGIN, pkg);
    expect(data.linkedRepoName).toBe("linked-repo");
    expect(data.canWritePackages).toBe(true);

    const html = renderPackageSettingsPage(pageCtx(viewer), data);
    expect(html).toContain('action="/alice/-/packages/settings/generic/app-tools"');
    expect(html).toContain('href="/alice/-/packages/generic/app-tools"');
    expect(html).toContain(">Settings</strong>");
    expect(html).toContain('name="repo_name" value="linked-repo"');
    expect(html).toContain("Package visibility is inherited from the owner");
    expect(html).toContain('href="/user/settings"');
    expect(html).toContain("Change owner visibility");
    expect(html).toContain("Danger Zone");
    expect(html).toContain("Enter package name to confirm");
    expect(html).toContain('name="package_name" required="" maxlength="100"'); // the typed confirmation
    // The Packages tab rides ACTIVE on the user arm (the overview header).
    expect(html).toContain('href="/alice/-/packages"');
  });

  it("renders the org arm with the landed org-settings link", async () => {
    const founder = await seedUser("orgowner");
    const orgs = new OrgService(env.DB);
    const org = await orgs.createOrg({ name: "toolsorg", ownerId: founder.id, visibility: "public", now: T0 });
    const { pkg } = await seedPackageVersion(org.id, "org-pkg", "1.0.0");
    const owner: PackagesOwner = { kind: "org", org };
    const viewer: Viewer = { kind: "user", id: founder.id, username: "orgowner", isAdmin: false };

    const data = await loadPackageSettingsData(env.DB, owner, viewer, ORIGIN, pkg);
    const html = renderPackageSettingsPage(pageCtx(viewer), data);
    expect(html).toContain("package settings options organization");
    expect(html).toContain('href="/toolsorg/settings"'); // the landed org settings URL
  });

  it("renders the flash banner in the base/alert slot only when armed", async () => {
    const alice = await seedUser("flasher");
    const { pkg } = await seedPackageVersion(alice.id, "flashy", "1.0.0");
    const owner: PackagesOwner = { kind: "user", user: await rowOf(alice.id) };
    const viewer: Viewer = { kind: "user", id: alice.id, username: "flasher", isAdmin: false };
    const data = await loadPackageSettingsData(env.DB, owner, viewer, ORIGIN, pkg);
    const plain = renderPackageSettingsPage(pageCtx(viewer), data);
    expect(plain).not.toContain("flash-message");
    const flashed = renderPackageSettingsPage(pageCtx(viewer), data, {
      kind: "negative",
      text: "Repository ghost not found.",
    });
    expect(flashed).toContain("flash-message flash-error");
    expect(flashed).toContain("Repository ghost not found.");
  });

  it("computes the write rank false for anonymous (the handler 404-shells before this)", async () => {
    const alice = await seedUser("shutter");
    const { pkg } = await seedPackageVersion(alice.id, "shut", "1.0.0");
    const owner: PackagesOwner = { kind: "user", user: await rowOf(alice.id) };
    const data = await loadPackageSettingsData(env.DB, owner, { kind: "anonymous" }, ORIGIN, pkg);
    expect(data.canWritePackages).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The POST seams
// ---------------------------------------------------------------------------

describe("the link seam — unlink, link, foreign repo", () => {
  it("unlinks on the empty name, links a same-owner repo, answers repo-missing otherwise", async () => {
    const alice = await seedUser("linker");
    const repoService = new RepoService(env.DB);
    const repo = await repoService.create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "repo-a",
      isPrivate: false,
      status: "ready",
    });
    const { pkg } = await seedPackageVersion(alice.id, "linked", "1.0.0");

    expect(await applyPackageSettingsLink(env.DB, alice.id, pkg, "repo-a")).toEqual({ kind: "ok" });
    let row = await db().select().from(packages).where(eq(packages.id, pkg.id)).get();
    expect(row?.repoId).toBe(repo.id);

    expect(await applyPackageSettingsLink(env.DB, alice.id, pkg, "")).toEqual({ kind: "ok" });
    row = await db().select().from(packages).where(eq(packages.id, pkg.id)).get();
    expect(row?.repoId).toBeNull();

    expect(await applyPackageSettingsLink(env.DB, alice.id, pkg, "ghost")).toEqual({
      kind: "repo-missing",
      repoName: "ghost",
    });
  });
});

describe("the delete seam — mismatch first, then the locked guard, then the cascade", () => {
  it("refuses the wrong typed name with the row intact, deletes on the exact name", async () => {
    const alice = await seedUser("deleter");
    const { pkg } = await seedPackageVersion(alice.id, "doomed", "1.0.0");
    expect(await applyPackageSettingsDelete(env.DB, pkg, "wrong")).toBe("mismatch");
    expect(await db().select().from(packages).where(eq(packages.id, pkg.id)).all()).toHaveLength(1);
    expect(await applyPackageSettingsDelete(env.DB, pkg, "doomed")).toBe("ok");
    expect(await db().select().from(packages).where(eq(packages.id, pkg.id)).all()).toHaveLength(0);
  });

  it("refuses a LOCKED terraform state before any write; unlocked deletes", async () => {
    const alice = await seedUser("terraform-deleter");
    const { pkg } = await seedPackageVersion(alice.id, "state", "1.0.0", { type: "terraform" });
    expect(await lockPackageTerraformState(env.DB, pkg, "alice", T0)).toBe("ok");
    expect(await applyPackageSettingsDelete(env.DB, pkg, "state")).toBe("locked");
    expect(await db().select().from(packages).where(eq(packages.id, pkg.id)).all()).toHaveLength(1);
    expect(await unlockPackageTerraformState(env.DB, pkg)).toBe("ok");
    expect(await applyPackageSettingsDelete(env.DB, pkg, "state")).toBe("ok");
  });
});

describe("the version-delete seam — the terraform guards + the redirect split", () => {
  it("deletes a non-terraform version and keeps the redirect on the package until the last version goes", async () => {
    const alice = await seedUser("version-deleter");
    const first = await seedPackageVersion(alice.id, "multi", "1.0.0", { now: new Date(T0.getTime() + 1000) });
    const second = await seedPackageVersion(alice.id, "multi", "2.0.0", { now: new Date(T0.getTime() + 2000) });

    expect(await resolveVersionDeleteRedirect(env.DB, "alice", first.pkg)).toBe("/alice/-/packages/generic/multi");
    expect(await deletePackageVersionGuarded(env.DB, first.pkg, first.ver)).toBe("ok");
    expect(await resolveVersionDeleteRedirect(env.DB, "alice", first.pkg)).toBe("/alice/-/packages/generic/multi");
    expect(await deletePackageVersionGuarded(env.DB, second.pkg, second.ver)).toBe("ok");
    expect(await resolveVersionDeleteRedirect(env.DB, "alice", second.pkg)).toBe("/alice/-/packages");
  });

  it("refuses the LATEST terraform version and a LOCKED terraform state; the older version deletes", async () => {
    const alice = await seedUser("tf-version-deleter");
    const older = await seedPackageVersion(alice.id, "tfstate", "v1", { type: "terraform", now: new Date(T0.getTime() + 1000) });
    const latest = await seedPackageVersion(alice.id, "tfstate", "v2", { type: "terraform", now: new Date(T0.getTime() + 2000) });

    expect(await deletePackageVersionGuarded(env.DB, latest.pkg, latest.ver)).toBe("latest");
    expect(await lockPackageTerraformState(env.DB, latest.pkg, "alice", T0)).toBe("ok");
    expect(await deletePackageVersionGuarded(env.DB, older.pkg, older.ver)).toBe("locked");
    expect(await unlockPackageTerraformState(env.DB, latest.pkg)).toBe("ok");
    expect(await deletePackageVersionGuarded(env.DB, older.pkg, older.ver)).toBe("ok");
    expect(await deletePackageVersionGuarded(env.DB, latest.pkg, latest.ver)).toBe("latest");
  });
});

describe("the terraform lock seams — the manual lock/unlock pair", () => {
  it("lands the manual lock (uuid, Manual UI Lock, who, RFC3339), refuses the double lock, unlocks", async () => {
    const alice = await seedUser("locker");
    const { pkg } = await seedPackageVersion(alice.id, "lockable", "1.0.0", { type: "terraform" });

    expect(await lockPackageTerraformState(env.DB, pkg, "alice", T0)).toBe("ok");
    const lock = await getTerraformLock(env.DB, pkg.id);
    expect(isTerraformLockLocked(lock)).toBe(true);
    expect(lock.Operation).toBe("Manual UI Lock");
    expect(lock.Who).toBe("alice");
    expect(lock.Created).toBe(T0.toISOString());
    expect(lock.ID).toMatch(/^[0-9a-f-]{36}$/);

    expect(await lockPackageTerraformState(env.DB, pkg, "mallory", T0)).toBe("already-locked");
    const untouched = await getTerraformLock(env.DB, pkg.id);
    expect(untouched.Who).toBe("alice");

    expect(await unlockPackageTerraformState(env.DB, pkg)).toBe("ok");
    const cleared = await getTerraformLock(env.DB, pkg.id);
    expect(isTerraformLockLocked(cleared)).toBe(false);
  });

  it("carries no not-locked arm on unlock (DeletePropertiesIfExist)", async () => {
    const alice = await seedUser("idempotent");
    const { pkg } = await seedPackageVersion(alice.id, "never-locked", "1.0.0", { type: "terraform" });
    expect(await unlockPackageTerraformState(env.DB, pkg)).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// The form parse
// ---------------------------------------------------------------------------

describe("parsePackageSettingsForm — the three fields", () => {
  it("parses action, repo_name (trimmed), package_name; absent fields parse empty", () => {
    expect(parsePackageSettingsForm(new URLSearchParams("action=link&repo_name=repo-a"))).toEqual({
      action: "link",
      repoName: "repo-a",
      packageName: "",
    });
    expect(parsePackageSettingsForm(new URLSearchParams("action=delete&package_name=doomed"))).toEqual({
      action: "delete",
      repoName: "",
      packageName: "doomed",
    });
    expect(parsePackageSettingsForm(new URLSearchParams())).toEqual({ action: "", repoName: "", packageName: "" });
  });
});

// ---------------------------------------------------------------------------
// The wave I-b strip arms (header.tmpl:14-31 + org/header.tmpl:16-20/:17)
// ---------------------------------------------------------------------------

describe("the wave I-b strip arms on the settings page", () => {
  it("the USER arm: the Projects + Code tabs join the overview header (Packages stays active); the avatar strip renders no follow/gear/rss (org_profile_avatar)", async () => {
    const alice = await seedUser("ibsetter");
    await db().insert(projects).values({
      title: "Ib Settings Plan",
      creatorId: alice.id,
      ownerId: alice.id,
      repoId: "",
      type: 1,
      isClosed: false,
      createdAt: T0,
      updatedAt: T0,
    });
    const { pkg } = await seedPackageVersion(alice.id, "ib-set", "1.0.0");
    const owner: PackagesOwner = { kind: "user", user: await rowOf(alice.id) };
    // A signed-in NON-owner viewer: the data's follow button is present but
    // the settings page renders org_profile_avatar (no follow control).
    const viewer: Viewer = { kind: "user", id: alice.id + 1, username: "ibsetviewer", isAdmin: false };
    await seedUser("ibsetviewer");

    const data = await loadPackageSettingsData(env.DB, owner, viewer, ORIGIN, pkg);
    expect(data.openProjects).toBe(1);
    expect(data.followButton).toEqual({ following: false });
    const html = renderPackageSettingsPage(pageCtx(viewer), data);
    // The overview header (user/overview/header.tmpl): the C1 Projects +
    // Code tabs INACTIVE, the Packages tab stays ACTIVE.
    expect(html).toContain('class="item" href="/ibsetter/-/projects"');
    expect(html).toContain('<div class="ui small label">1</div>');
    expect(html).toContain('class="item" href="/ibsetter/-/code"');
    expect(html).not.toContain('class="active item" href="/ibsetter/-/code"');
    expect(html).toContain('<a class="active item" href="/ibsetter/-/packages">'); // ACTIVE Packages
    // org_profile_avatar.tmpl carries no follow control, no gear, no RSS —
    // the shared profile_big_avatar arms never render on this page.
    expect(html).not.toContain('method="post" action="/ibsetter?action=');
    expect(html).not.toContain('data-tooltip-content="User Details"');
    expect(html).not.toContain('href="/ibsetter.rss"');
  });

  it("the ORG arm: the header follow button rides the loader (anonymous drops it, the RSS anchor stays)", async () => {
    const founder = await seedUser("iborgsetter");
    const orgs = new OrgService(env.DB);
    const org = await orgs.createOrg({ name: "ibsetorg", ownerId: founder.id, visibility: "public", now: T0 });
    const { pkg } = await seedPackageVersion(org.id, "ib-org-set", "1.0.0");
    const owner: PackagesOwner = { kind: "org", org };
    const viewer: Viewer = { kind: "user", id: founder.id, username: "iborgsetter", isAdmin: false };

    const data = await loadPackageSettingsData(env.DB, owner, viewer, ORIGIN, pkg);
    expect(data.followButton).toEqual({ following: false });
    const html = renderPackageSettingsPage(pageCtx(viewer), data);
    expect(html).toContain('<form method="post" action="/ibsetorg?action=follow">');
    expect(html).toContain('class="ui basic label button" href="/ibsetorg.rss"');

    // Anonymous: the follow button drops (org/header.tmpl:17's IsSigned
    // gate), the RSS anchor stays (EnableFeed pins TRUE).
    const anonData = await loadPackageSettingsData(env.DB, owner, { kind: "anonymous" }, ORIGIN, pkg);
    expect(anonData.followButton).toBeNull();
    const anonHtml = renderPackageSettingsPage(pageCtx({ kind: "anonymous" }), anonData);
    expect(anonHtml).not.toContain('method="post" action="/ibsetorg?action=');
    expect(anonHtml).toContain('class="ui basic label button" href="/ibsetorg.rss"');
  });
});
