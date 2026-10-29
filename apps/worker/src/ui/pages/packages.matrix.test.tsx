/**
 * The packages family's M2 matrix (SPEC-0016 §6 + the mission's gate list) —
 * the module-level arms driven against the LANDED model service (M1 at
 * 8cdf44a), one fresh world per describe behind per-test table wipes. The
 * route-level arms (parseUiRoute claims + the uiRouter.fetch mounts) belong
 * to the integrator's landing window — index.ts is a sibling's file — so
 * THIS suite drives the module's own seams exactly the way the handlers
 * will: resolvePackagesOwner (the gate ladder) → the loaders → the
 * renderers / the download pair.
 *
 *   - the gate ladder through resolvePackagesOwner: anonymous reads a public
 *     owner; a limited owner admits any signed-in doer and blinds
 *     anonymous; a private user misses for every non-self viewer INCLUDING
 *     the follower (the profile ladder admits, the package ladder refuses —
 *     the module header's determineAccessMode arm); private-org members —
 *     team-granted AND plain — read through the §4.1 fold (upstream
 *     HasOrgOrUserVisible's membership floor, org.go:458-461); site admin
 *     reads everything; renames redirect; unknown names miss;
 *   - the R04 list: the latest-version-per-package rows (link shape, type
 *     label, published-by(-in) over the viewer-visible linked repo, the
 *     unattributed-creator reduction), ?q/?type facets, the 20-per-page
 *     pager, both empty arms, the org chrome arm (Packages tab ACTIVE) and
 *     the user grid arm;
 *   - the versions page: the default created-desc order, the version_asc
 *     flip, the ?q version-substring filter, the unknown-package null;
 *   - the version view: the assets list with sizes, the summed blob size,
 *     the versions sidebar + total, the generic curl lines, the
 *     missing-version null;
 *   - the download pair: the id-pair arbitration, the attachment
 *     disposition + nosniff + extension content type, the skip-compression
 *     hint, the If-Modified-Since 304, the IsLead counter gate (GET bumps a
 *     lead file, HEAD never does), the missing-object 404 family;
 *   - the R16 tab: `repoPackagesEnabled` (the repo_settings.has_packages
 *     toggle — the enum gate arm), the repo facet (two repos, one owner —
 *     each tab sees only its own rows), the writer-only empty-repo hint,
 *     and the shell tab strip render (repoHasPackages arms the Packages
 *     item at upstream's header.tmpl:140 slot; absent keeps the landed
 *     tab set);
 *   - the profile tab anchors: the profile page arms the inactive Packages
 *     item when `packagesEnabled !== false` and drops it on "false";
 *   - the `repo_units` enum extension: a 'packages' row inserts, reads and
 *     deletes (the type-level extension's runtime half — drizzle's SQLite
 *     enum carries no CHECK, the db:generate no-drift gate is its other
 *     half).
 *
 * Fixtures seed through the LANDED model service (getOrInsertPackage /
 * getOrInsertVersion / getOrInsertBlob / tryInsertFile / linkPackageToRepo)
 * — never hand-written package SQL — plus the RepoService/OrgService arms
 * the matrix suites share. ids are captured at seed time.
 */

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { renderToString } from "hono/jsx/dom/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RepoService } from "../../repos/service";
import { OrgService } from "../../services/orgs/orgs";
import { TeamsService } from "../../api/routes/org-teams";
import { getOrInsertBlob, packageBlobContentKey } from "../../services/packages/blobs";
import {
  deletePackageVersionAndReferences,
  getOrInsertPackage,
  getOrInsertVersion,
  linkPackageToRepo,
  tryInsertFile,
} from "../../services/packages/model";
import { follows, packageVersions, packages, repoSettings, repoUnits, users } from "../../db/schema";
import { BaseLayout } from "../shell";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  PACKAGES_PAGE_SIZE,
  PACKAGE_TYPES,
  absoluteShort,
  loadOwnerPackageVersionViewData,
  loadOwnerPackageVersionsData,
  loadOwnerPackagesData,
  loadPackageFileDownload,
  loadRepoPackagesData,
  packageFileDownloadResponse,
  packageTypeName,
  renderOwnerPackageVersionViewPage,
  renderOwnerPackageVersionsPage,
  renderOwnerPackagesPage,
  renderRepoPackagesPage,
  repoPackagesEnabled,
  resolveLatestVersionRedirect,
  resolvePackagesOwner,
  versionWebLink,
} from "./packages";
import { loadUserProfileData, renderUserProfilePage } from "./user-profile";

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
 *  convention). */
const FIXTURE_TABLES = [
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
const bucket = () => env.REPO_PACKS;

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

/** One package + version through the LANDED model service (distinct `now`
 *  drives the created-desc order; creatorId 0 = the unattributed arm). */
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

/** One file (and its content-addressed blob row + R2 object) for a version —
 *  the upload pipeline's landing half without the HTTP pass. */
async function seedFile(versionId: number, name: string, payload: string, opts: { isLead?: boolean } = {}) {
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const { row: blob } = await getOrInsertBlob(env.DB, { size: bytes.byteLength, sha256, now: T0 });
  const inserted = await tryInsertFile(env.DB, { versionId, blobId: blob.id, name, isLead: opts.isLead ?? false, now: T0 });
  if (inserted.outcome !== "created") throw new Error("file seed failed");
  await bucket().put(packageBlobContentKey(sha256), bytes);
  return { file: inserted.row, blob, sha256, bytes };
}

/** The doer shape the resolution seams take (null id = anonymous). */
function doer(viewer: Viewer): { id: number | null; isAdmin: boolean } {
  return viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
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
// The gate ladder (resolvePackagesOwner — the R04 subtree wrap)
// ---------------------------------------------------------------------------

describe("resolvePackagesOwner — the R04 gate ladder", () => {
  it("admits anonymous + outsider reads of a PUBLIC owner and resolves the user arm", async () => {
    const alice = await seedUser("alice");
    const strangers: Viewer[] = [
      { kind: "anonymous" },
      { kind: "user", id: 999, username: "stranger", isAdmin: false },
    ];
    for (const viewer of strangers) {
      const resolved = await resolvePackagesOwner(env.DB, "alice", doer(viewer), "/alice/-/packages", "");
      expect(resolved.kind).toBe("user");
      if (resolved.kind === "user") expect(resolved.user.id).toBe(alice.id);
    }
  });

  it("LIMITED owners admit any signed-in doer and blind anonymous (the HasOrgOrUserVisible ladder)", async () => {
    await seedUser("lim", { visibility: "limited" });
    const anon = await resolvePackagesOwner(env.DB, "lim", doer({ kind: "anonymous" }), "/lim/-/packages", "");
    expect(anon.kind).toBe("missing");
    const signed = await resolvePackagesOwner(
      env.DB,
      "lim",
      doer({ kind: "user", id: 999, username: "stranger", isAdmin: false }),
      "/lim/-/packages",
      "",
    );
    expect(signed.kind).toBe("user");
  });

  it("a PRIVATE user misses for every non-self viewer INCLUDING the follower (the package ladder's user arm)", async () => {
    const privy = await seedUser("privy", { visibility: "private" });
    const follower = await seedUser("devon");
    await db().insert(follows).values({ userId: follower.id, followId: privy.id, createdAt: T0 }).run();
    // The profile ladder ADMITS the follower; the package ladder still
    // refuses (determinePackageAccessMode answers read for public/limited
    // user owners only — upstream package.go:157-160).
    const asFollower = await resolvePackagesOwner(
      env.DB,
      "privy",
      doer({ kind: "user", id: follower.id, username: "devon", isAdmin: false }),
      "/privy/-/packages",
      "",
    );
    expect(asFollower.kind).toBe("missing");
    const asSelf = await resolvePackagesOwner(
      env.DB,
      "privy",
      doer({ kind: "user", id: privy.id, username: "privy", isAdmin: false }),
      "/privy/-/packages",
      "",
    );
    expect(asSelf.kind).toBe("user");
    const asAdmin = await resolvePackagesOwner(
      env.DB,
      "privy",
      doer({ kind: "user", id: 1, username: "root", isAdmin: true }),
      "/privy/-/packages",
      "",
    );
    expect(asAdmin.kind).toBe("user");
  });

  it("a PRIVATE org keeps team-granted AND plain members, blinds strangers (the §4.1 fold + HasOrgOrUserVisible's membership floor)", async () => {
    const owner = await seedUser("secorg-owner");
    const member = await seedUser("secmember");
    const plain = await seedUser("secplain");
    const orgs = new OrgService(env.DB);
    const org = await orgs.createOrg({ name: "secorg", ownerId: owner.id, visibility: "private", now: T0 });
    await orgs.addMember(org.id, member.id, { now: T0 });
    await orgs.addMember(org.id, plain.id, { now: T0 });
    // The member's grant rides a read team; the PLAIN member (a membership
    // row, NO team row) reads through the membership floor — upstream
    // HasOrgOrUserVisible (org.go:458-461) grants members at package.go:
    // 155-157 (the M1 open issue, closed in the model service).
    const teamsService = new TeamsService(env.DB);
    const readers = await teamsService.createTeam(org, { name: "Readers", permission: "read" });
    await teamsService.addTeamMember(readers, member.id);

    const anon = await resolvePackagesOwner(env.DB, "secorg", doer({ kind: "anonymous" }), "/secorg/-/packages", "");
    expect(anon.kind).toBe("missing");
    const outsider = await resolvePackagesOwner(
      env.DB,
      "secorg",
      doer({ kind: "user", id: 999, username: "stranger", isAdmin: false }),
      "/secorg/-/packages",
      "",
    );
    expect(outsider.kind).toBe("missing");
    const asPlain = await resolvePackagesOwner(
      env.DB,
      "secorg",
      doer({ kind: "user", id: plain.id, username: "secplain", isAdmin: false }),
      "/secorg/-/packages",
      "",
    );
    expect(asPlain.kind).toBe("org"); // the closed plain-member floor (upstream package.go:155-157)
    if (asPlain.kind === "org") expect(asPlain.org.id).toBe(org.id);
    const asMember = await resolvePackagesOwner(
      env.DB,
      "secorg",
      doer({ kind: "user", id: member.id, username: "secmember", isAdmin: false }),
      "/secorg/-/packages",
      "",
    );
    expect(asMember.kind).toBe("org");
    if (asMember.kind === "org") expect(asMember.org.id).toBe(org.id);
    const asOwner = await resolvePackagesOwner(
      env.DB,
      "secorg",
      doer({ kind: "user", id: owner.id, username: "secorg-owner", isAdmin: false }),
      "/secorg/-/packages",
      "",
    );
    expect(asOwner.kind).toBe("org");
  });

  it("redirects renamed owners and misses unknown names (the RedirectToUser seam)", async () => {
    const orgs = new OrgService(env.DB);
    const renamer = await seedUser("renamer");
    const old = await orgs.createOrg({ name: "oldpkgorg", ownerId: renamer.id, visibility: "public", now: T0 });
    await orgs.renameOrg(old.id, "newpkgorg", { now: T0 });
    const renamed = await resolvePackagesOwner(
      env.DB,
      "oldpkgorg",
      doer({ kind: "anonymous" }),
      "/oldpkgorg/-/packages", // the path WITHOUT its query (the seam appends it)
      "type=generic",
    );
    expect(renamed.kind).toBe("redirect");
    if (renamed.kind === "redirect") expect(renamed.location).toBe("/newpkgorg/-/packages?type=generic");
    const unknown = await resolvePackagesOwner(env.DB, "ghost", doer({ kind: "anonymous" }), "/ghost/-/packages", "");
    expect(unknown.kind).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// The R04 list (loadOwnerPackagesData + renderOwnerPackagesPage)
// ---------------------------------------------------------------------------

/** The main world: alice (3 packages — app-tools with two versions + files,
 *  lib-x linked to repo-a, plain-pkg unattributed). */
interface ListWorld {
  alice: Awaited<ReturnType<typeof seedUser>>;
  repoA: RepoRow;
  /** The two app-tools files, named (zip = the lead carrier, txt = plain). */
  zip: Awaited<ReturnType<typeof seedFile>>;
  txt: Awaited<ReturnType<typeof seedFile>>;
}

async function seedListWorld(): Promise<ListWorld> {
  const alice = await seedUser("alice");
  const repoService = new RepoService(env.DB);
  const repoA = await repoService.create({
    owner: { id: alice.id, usernameLower: "alice" },
    name: "repo-a",
    isPrivate: false,
    status: "ready",
  });

  await seedPackageVersion(alice.id, "app-tools", "v1.0.0", { now: new Date(T0.getTime() + 1000) });
  const latest = await seedPackageVersion(alice.id, "app-tools", "V1.1.0", { now: new Date(T0.getTime() + 2000) });
  const zip = await seedFile(latest.ver.id, "app-tools-1.1.0.zip", "zip-bytes", { isLead: true });
  const txt = await seedFile(latest.ver.id, "checksums.txt", "sha256 sums");
  const { pkg: libX } = await seedPackageVersion(alice.id, "lib-x", "2.0.0", { now: new Date(T0.getTime() + 3000) });
  await linkPackageToRepo(env.DB, libX.id, repoA.id);
  await seedPackageVersion(alice.id, "plain-pkg", "0.1.0", { creatorId: 0, now: new Date(T0.getTime() + 4000) });

  return { alice, repoA, zip, txt };
}

describe("the R04 list — rows, facets, empty arms", () => {
  it("renders the latest-version rows with the upstream link/label/by-line shapes", async () => {
    const world = await seedListWorld();
    const aliceViewer: Viewer = { kind: "user", id: world.alice.id, username: "alice", isAdmin: false };
    const data = await loadOwnerPackagesData(
      env.DB,
      { kind: "user", user: await rowOf(world.alice.id) },
      aliceViewer,
      ORIGIN,
      new URLSearchParams(),
    );
    expect(data.items).toHaveLength(3); // latest-version-per-package
    expect(data.hasPackages).toBe(true);
    expect(data.total).toBe(3);

    const html = renderOwnerPackagesPage(pageCtx(aliceViewer), data);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('class="page-content user profile packages"');
    // The latest version's page is the row link (descriptor.go:90-92's shape
    // over the LOWER name/version).
    expect(html).toContain('href="/alice/-/packages/generic/app-tools/v1.1.0"');
    expect(html).not.toContain("/generic/app-tools/v1.0.0"); // the latest only
    // The type chip (the octicon-package degradation) + the by-line.
    expect(html).toContain('<span class="ui label">');
    expect(html).toContain("</svg> Generic</span>");
    expect(html).toContain('href="/alice">alice</a>');
    // The linked repo renders the published_by_in arm for a viewer who can
    // see it.
    expect(html).toContain('href="/alice/repo-a"');
    expect(html).toContain("<strong>alice/repo-a</strong>");
    // The unattributed version renders the by-armless line.
    expect(html).toContain("Published");
  });

  it("filters by q (package-name LIKE) and type, and the pager walks 20-per-page", async () => {
    const bulk = await seedUser("bulk");
    for (let index = 0; index < PACKAGES_PAGE_SIZE + 1; index += 1) {
      await seedPackageVersion(bulk.id, `bulk-${String(index).padStart(2, "0")}`, "1.0.0");
    }
    await seedPackageVersion(bulk.id, "special-npm", "1.0.0", { type: "npm" });
    const viewer: Viewer = { kind: "anonymous" };
    const owner = { kind: "user", user: await rowOf(bulk.id) } as const;

    const page1 = await loadOwnerPackagesData(env.DB, owner, viewer, ORIGIN, new URLSearchParams());
    expect(page1.items).toHaveLength(PACKAGES_PAGE_SIZE);
    expect(page1.total).toBe(PACKAGES_PAGE_SIZE + 2);
    expect(page1.more).toBe(true);
    const page1Html = renderOwnerPackagesPage(pageCtx(viewer), page1);
    expect(page1Html).toContain('href="/bulk/-/packages?page=2"');

    const page2 = await loadOwnerPackagesData(env.DB, owner, viewer, ORIGIN, new URLSearchParams("page=2"));
    expect(page2.items).toHaveLength(2);
    expect(page2.more).toBe(false);
    const page2Html = renderOwnerPackagesPage(pageCtx(viewer), page2);
    expect(page2Html).toContain('href="/bulk/-/packages"'); // Newer folds onto the bare link
    expect(page2Html).not.toContain("page=3");

    const filtered = await loadOwnerPackagesData(env.DB, owner, viewer, ORIGIN, new URLSearchParams("q=special"));
    expect(filtered.items.map((item) => item.pkg.name)).toEqual(["special-npm"]);

    const typed = await loadOwnerPackagesData(env.DB, owner, viewer, ORIGIN, new URLSearchParams("type=npm"));
    expect(typed.items.map((item) => item.pkg.name)).toEqual(["special-npm"]);
    const all = await loadOwnerPackagesData(env.DB, owner, viewer, ORIGIN, new URLSearchParams("type=all"));
    expect(all.items).toHaveLength(PACKAGES_PAGE_SIZE); // the "all" value clears the facet
  });

  it("renders both empty arms: the placeholder without any packages, the no-result line with a missing q", async () => {
    const empty = await seedUser("empt");
    const viewer: Viewer = { kind: "anonymous" };
    const emptyData = await loadOwnerPackagesData(
      env.DB,
      { kind: "user", user: await rowOf(empty.id) },
      viewer,
      ORIGIN,
      new URLSearchParams(),
    );
    expect(emptyData.hasPackages).toBe(false);
    const emptyHtml = renderOwnerPackagesPage(pageCtx(viewer), emptyData);
    expect(emptyHtml).toContain("There are no packages yet.");
    expect(emptyHtml).toContain("empty-placeholder");
    expect(emptyHtml).toContain("https://docs.gitea.com/usage/packages/overview");
    expect(emptyHtml).not.toContain('name="q"'); // the filter form needs HasPackages

    const world = await seedListWorld();
    const aliceViewer: Viewer = { kind: "user", id: world.alice.id, username: "alice", isAdmin: false };
    const miss = await loadOwnerPackagesData(
      env.DB,
      { kind: "user", user: await rowOf(world.alice.id) },
      aliceViewer,
      ORIGIN,
      new URLSearchParams("q=zzz"),
    );
    expect(miss.items).toHaveLength(0);
    const missHtml = renderOwnerPackagesPage(pageCtx(aliceViewer), miss);
    expect(missHtml).toContain("Your filter produced no results.");
    expect(missHtml).toContain('name="q"');
  });

  it("renders the org arm with the Packages tab ACTIVE and the repo-linked in-arm hidden from blind viewers", async () => {
    const owner = await seedUser("orgpk");
    const orgs = new OrgService(env.DB);
    const org = await orgs.createOrg({ name: "pkgorg", ownerId: owner.id, visibility: "public", now: T0 });
    await seedPackageVersion(org.id, "org-tool", "1.0.0");

    const repoService = new RepoService(env.DB);
    const privRepo = await repoService.create({
      owner: { id: org.id, usernameLower: "pkgorg" },
      name: "priv-repo",
      isPrivate: true,
      status: "ready",
    });
    const { pkg: linked } = await seedPackageVersion(org.id, "linked-tool", "2.0.0");
    await linkPackageToRepo(env.DB, linked.id, privRepo.id);

    // Anonymous sees the package but NOT the private repo arm.
    const anonData = await loadOwnerPackagesData(env.DB, { kind: "org", org }, { kind: "anonymous" }, ORIGIN, new URLSearchParams());
    const anonHtml = renderOwnerPackagesPage(pageCtx({ kind: "anonymous" }), anonData);
    expect(anonHtml).toContain('class="page-content organization packages"');
    expect(anonHtml).toContain('<a href="/pkgorg/-/packages/generic/org-tool/1.0.0">org-tool</a>');
    expect(anonHtml).not.toContain("/pkgorg/priv-repo");
    expect(anonHtml).toContain('<a class="active item" href="/pkgorg/-/packages">'); // the ACTIVE packages tab

    // The org owner sees the in-arm.
    const ownerViewer: Viewer = { kind: "user", id: owner.id, username: "orgpk", isAdmin: false };
    const ownerData = await loadOwnerPackagesData(env.DB, { kind: "org", org }, ownerViewer, ORIGIN, new URLSearchParams());
    const ownerHtml = renderOwnerPackagesPage(pageCtx(ownerViewer), ownerData);
    expect(ownerHtml).toContain('href="/pkgorg/priv-repo"');
  });
});

// ---------------------------------------------------------------------------
// The versions page (loadOwnerPackageVersionsData + render)
// ---------------------------------------------------------------------------

describe("the versions page — order, q, sort arms", () => {
  it("orders created-desc by default, flips with version_asc, filters by q, and nulls unknown packages", async () => {
    const owner = await seedUser("verser");
    const t1 = new Date(T0.getTime() + 1000);
    const t2 = new Date(T0.getTime() + 2000);
    const t3 = new Date(T0.getTime() + 3000);
    await seedPackageVersion(owner.id, "multi", "9.9.9", { now: t1 });
    await seedPackageVersion(owner.id, "multi", "1.0.0", { now: t3 }); // newest created
    await seedPackageVersion(owner.id, "multi", "5.5.5", { now: t2 });
    const base = { kind: "user" as const, user: await rowOf(owner.id) };

    const defaults = await loadOwnerPackageVersionsData(env.DB, base, { kind: "anonymous" }, "generic", "multi", new URLSearchParams());
    expect(defaults?.items.map((item) => item.version.version)).toEqual(["1.0.0", "5.5.5", "9.9.9"]); // created desc
    expect(defaults?.total).toBe(3);

    const asc = await loadOwnerPackageVersionsData(env.DB, base, { kind: "anonymous" }, "generic", "multi", new URLSearchParams("sort=version_asc"));
    expect(asc?.items.map((item) => item.version.version)).toEqual(["1.0.0", "5.5.5", "9.9.9"]); // string order

    const filtered = await loadOwnerPackageVersionsData(env.DB, base, { kind: "anonymous" }, "generic", "multi", new URLSearchParams("q=5.5"));
    expect(filtered?.items.map((item) => item.version.version)).toEqual(["5.5.5"]);
    expect(filtered?.total).toBe(1);

    expect(await loadOwnerPackageVersionsData(env.DB, base, { kind: "anonymous" }, "generic", "ghost", new URLSearchParams())).toBeNull();
    expect(await loadOwnerPackageVersionsData(env.DB, base, { kind: "anonymous" }, "npm", "multi", new URLSearchParams())).toBeNull();

    const html = renderOwnerPackageVersionsPage(pageCtx({ kind: "anonymous" }), defaults!);
    expect(html).toContain("<!DOCTYPE html>");
    // The breadcrumb + the lower-version row text (versionlist.tmpl's
    // `{{.Version.LowerVersion}}`).
    expect(html).toContain('href="/verser/-/packages/generic/multi"');
    expect(html).toContain(">9.9.9</a>");
    expect(html).not.toContain('class="item navigation"'); // pager-less at one page
  });
});

// ---------------------------------------------------------------------------
// The version view (loadOwnerPackageVersionViewData + render)
// ---------------------------------------------------------------------------

describe("the version view — assets, sidebar, install lines", () => {
  it("renders the assets list with sizes, the summed blob size, the sidebar and the curl lines", async () => {
    const world = await seedListWorld();
    const aliceViewer: Viewer = { kind: "user", id: world.alice.id, username: "alice", isAdmin: false };
    const owner = { kind: "user" as const, user: await rowOf(world.alice.id) };
    // One more version so the sidebar has three rows.
    await seedPackageVersion(world.alice.id, "app-tools", "v0.9.0", { now: new Date(T0.getTime() + 500) });

    // The URL-keyed lookup is the LOWER version (the versionWebLink shape).
    const data = await loadOwnerPackageVersionViewData(env.DB, owner, aliceViewer, ORIGIN, "generic", "app-tools", "v1.1.0");
    expect(data).not.toBeNull();
    expect(data!.files.map((file) => file.file.name)).toEqual(["app-tools-1.1.0.zip", "checksums.txt"]); // lower_name order
    expect(data!.downloadCount).toBe(0);
    expect(data!.totalVersionCount).toBe(3);
    expect(data!.latestVersions).toHaveLength(3);
    const blobBytes = world.zip.bytes.byteLength + world.txt.bytes.byteLength;
    expect(data!.blobSizeText).toBe(`${blobBytes} B`);
    expect(data!.registryHost).toBe("test.local");

    const html = renderOwnerPackageVersionViewPage(pageCtx(aliceViewer), data!);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("app-tools (V1.1.0)"); // the h1 — display name + stored case
    expect(html).toContain('href="/alice/-/packages/generic/app-tools/v1.1.0/files/');
    expect(html).toContain("checksums.txt");
    // The generic install block: one curl line per file over the protocol URL.
    expect(html).toContain("curl -OJ https://test.local/api/packages/alice/generic/app-tools/V1.1.0/app-tools-1.1.0.zip");
    // The sidebar rows + the view-all anchor.
    expect(html).toContain('href="/alice/-/packages/generic/app-tools/versions"');
    expect(html).toContain(absoluteShort(new Date(T0.getTime() + 2000)));
  });

  it("nulls the missing version hop", async () => {
    const world = await seedListWorld();
    const owner = { kind: "user" as const, user: await rowOf(world.alice.id) };
    expect(await loadOwnerPackageVersionViewData(env.DB, owner, { kind: "anonymous" }, ORIGIN, "generic", "app-tools", "9.9.9")).toBeNull();
    expect(await loadOwnerPackageVersionViewData(env.DB, owner, { kind: "anonymous" }, ORIGIN, "generic", "ghost", "1.0.0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The download pair (loadPackageFileDownload + packageFileDownloadResponse)
// ---------------------------------------------------------------------------

describe("the download pair — arbitration, headers, counter gate", () => {
  it("serves the file with the attachment headers and the extension content type", async () => {
    const world = await seedListWorld();
    const lead = world.zip;
    const tail = world.txt;
    const latest = await seedPackageVersion(world.alice.id, "app-tools", "V1.1.0"); // re-reads the SAME rows
    const serve = await loadPackageFileDownload(bucket(), env.DB, latest.ver.id, lead.file.id, "GET");
    expect(serve.kind).toBe("serve");
    if (serve.kind !== "serve") return;
    expect(serve.filename).toBe("app-tools-1.1.0.zip");
    expect(serve.size).toBe(lead.bytes.byteLength);

    const response = packageFileDownloadResponse(serve, { ifModifiedSince: null });
    expect(response.status).toBe(200);
    // Go's mime.FormatMediaType keeps token chars (`-`, `.`) bare.
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=app-tools-1.1.0.zip");
    expect(response.headers.get("content-type")).toBe("application/zip"); // the extension arm
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-no-compression")).toBe("1");
    expect(response.headers.get("content-length")).toBe(String(lead.bytes.byteLength));
    expect(response.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    const body = new Uint8Array(await response.arrayBuffer());
    expect([...body]).toEqual([...lead.bytes]);

    // The .txt arm maps by extension and carries no compression hint.
    const tailServe = await loadPackageFileDownload(bucket(), env.DB, latest.ver.id, tail.file.id, "GET");
    if (tailServe.kind !== "serve") throw new Error("tail serve failed");
    const tailResponse = packageFileDownloadResponse(tailServe, { ifModifiedSince: null });
    expect(tailResponse.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(tailResponse.headers.get("x-no-compression")).toBeNull();
  });

  it("answers the If-Modified-Since conditional with 304", async () => {
    const world = await seedListWorld();
    const lead = world.zip;
    const latest = await seedPackageVersion(world.alice.id, "app-tools", "V1.1.0");
    const serve = await loadPackageFileDownload(bucket(), env.DB, latest.ver.id, lead.file.id, "GET");
    if (serve.kind !== "serve") throw new Error("serve failed");
    const future = new Date(serve.createdAt.getTime() + 60_000);
    const response = packageFileDownloadResponse(serve, { ifModifiedSince: future.toUTCString() });
    expect(response.status).toBe(304);
    expect(response.headers.get("last-modified")).not.toBeNull();
  });

  it("arbitrates the id pair and the object hop: wrong version/file/missing object are the 404 family", async () => {
    const world = await seedListWorld();
    const lead = world.zip;
    const latest = await seedPackageVersion(world.alice.id, "app-tools", "V1.1.0");
    const older = await seedPackageVersion(world.alice.id, "app-tools", "v1.0.0");
    // The file belongs to the LATEST version — the older version's id misses.
    expect((await loadPackageFileDownload(bucket(), env.DB, older.ver.id, lead.file.id, "GET")).kind).toBe("not-found");
    expect((await loadPackageFileDownload(bucket(), env.DB, latest.ver.id, 424242, "GET")).kind).toBe("not-found");
    // A row whose object is gone (the sole-sweeper posture's honest 404).
    await bucket().delete(packageBlobContentKey(lead.sha256));
    expect((await loadPackageFileDownload(bucket(), env.DB, latest.ver.id, lead.file.id, "GET")).kind).toBe("not-found");
  });

  it("bumps the download counter for a LEAD file's GET only (the OpenBlobForDownload gate)", async () => {
    const owner = await seedUser("countered");
    const { ver } = await seedPackageVersion(owner.id, "counted", "1.0.0");
    const lead = await seedFile(ver.id, "lead.bin", "lead-bytes", { isLead: true });
    const tail = await seedFile(ver.id, "tail.bin", "tail-bytes");

    await loadPackageFileDownload(bucket(), env.DB, ver.id, lead.file.id, "GET");
    await loadPackageFileDownload(bucket(), env.DB, ver.id, lead.file.id, "HEAD");
    await loadPackageFileDownload(bucket(), env.DB, ver.id, tail.file.id, "GET");
    const row = await db().select().from(packageVersions).where(eq(packageVersions.id, ver.id)).get();
    expect(row?.downloadCount).toBe(1); // the lead GET; HEAD and the non-lead GET never bump
  });
});

// ---------------------------------------------------------------------------
// The redirect arm (RedirectToLastVersion)
// ---------------------------------------------------------------------------

describe("the redirect arm — 303 onto the latest version", () => {
  it("resolves the latest non-internal version's page and nulls empty packages", async () => {
    const owner = await seedUser("redirecter");
    const t1 = new Date(T0.getTime() + 1000);
    const t2 = new Date(T0.getTime() + 2000);
    const first = await seedPackageVersion(owner.id, "redir", "1.0.0", { now: t1 });
    const second = await seedPackageVersion(owner.id, "redir", "2.0.0", { now: t2 });
    const resolved = await resolveLatestVersionRedirect(env.DB, owner.id, "generic", "redir");
    expect(resolved).toEqual({
      kind: "redirect",
      location: versionWebLink("redirecter", "generic", "redir", "2.0.0"),
    });

    // A package whose every version vanished (the model's delete cascade)
    // answers missing — RedirectToLastVersion's len(pvs)==0 arm.
    await deletePackageVersionAndReferences(env.DB, second.ver.id);
    await deletePackageVersionAndReferences(env.DB, first.ver.id);
    expect(await resolveLatestVersionRedirect(env.DB, owner.id, "generic", "redir")).toEqual({ kind: "missing" });
    expect(await resolveLatestVersionRedirect(env.DB, owner.id, "generic", "ghost")).toEqual({ kind: "missing" });
  });
});

// ---------------------------------------------------------------------------
// The R16 tab (repoPackagesEnabled + loadRepoPackagesData + render)
// ---------------------------------------------------------------------------

describe("the R16 repo tab — the enum gate arm, the repo facet, the render", () => {
  async function seedRepoWorld() {
    const owner = await seedUser("tabowner");
    const repoService = new RepoService(env.DB);
    const repoA = await repoService.create({ owner: { id: owner.id, usernameLower: "tabowner" }, name: "repo-a", isPrivate: false, status: "ready" });
    const repoB = await repoService.create({ owner: { id: owner.id, usernameLower: "tabowner" }, name: "repo-b", isPrivate: false, status: "ready" });
    const { pkg: pkgA } = await seedPackageVersion(owner.id, "pkg-a", "1.0.0");
    const { pkg: pkgB } = await seedPackageVersion(owner.id, "pkg-b", "1.0.0");
    await linkPackageToRepo(env.DB, pkgA.id, repoA.id);
    await linkPackageToRepo(env.DB, pkgB.id, repoB.id);
    return { owner, repoA, repoB };
  }

  it("reads the has_packages toggle both ways (the gate arm)", async () => {
    const { repoA, repoB } = await seedRepoWorld();
    expect(await repoPackagesEnabled(env.DB, repoA.id)).toBe(false); // the upstream default
    await db()
      .insert(repoSettings)
      .values({ repoId: repoA.id, hasPackages: true })
      .onConflictDoUpdate({ target: repoSettings.repoId, set: { hasPackages: true } })
      .run();
    expect(await repoPackagesEnabled(env.DB, repoA.id)).toBe(true);
    expect(await repoPackagesEnabled(env.DB, repoB.id)).toBe(false);
  });

  it("filters by RepoID: two repos, one owner — each tab sees only its own rows", async () => {
    const { repoA, repoB } = await seedRepoWorld();
    const anon: Viewer = { kind: "anonymous" };
    const tabA = await loadRepoPackagesData(
      env.DB,
      { id: repoA.id, ownerNamespace: "tabowner", slug: "repo-a", ownerId: repoA.ownerId! },
      anon,
      ORIGIN,
      new URLSearchParams(),
    );
    expect(tabA.items.map((item) => item.pkg.name)).toEqual(["pkg-a"]);
    const tabB = await loadRepoPackagesData(
      env.DB,
      { id: repoB.id, ownerNamespace: "tabowner", slug: "repo-b", ownerId: repoA.ownerId! },
      anon,
      ORIGIN,
      new URLSearchParams(),
    );
    expect(tabB.items.map((item) => item.pkg.name)).toEqual(["pkg-b"]);
    expect(tabA.hasPackages).toBe(true);
    expect(tabB.hasPackages).toBe(true);

    const html = renderRepoPackagesPage(pageCtx(anon, { repo: repoA, repoHasPackages: true }), tabA);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('class="page-content repository packages"');
    expect(html).toContain('<a class="active item" href="/tabowner/repo-a/packages">'); // the ACTIVE shell tab
    expect(html).toContain('href="/tabowner/-/packages/generic/pkg-a/1.0.0"');
    expect(html).not.toContain("pkg-b");
    expect(html).not.toContain("empty-placeholder");
  });

  it("renders the empty arm; the writer hint rides canWritePackages only", async () => {
    const { owner, repoB } = await seedRepoWorld();
    await db().update(packages).set({ repoId: null }).run(); // unlink every fixture package
    const anon: Viewer = { kind: "anonymous" };
    const emptied = await loadRepoPackagesData(
      env.DB,
      { id: repoB.id, ownerNamespace: "tabowner", slug: "repo-b", ownerId: owner.id },
      anon,
      ORIGIN,
      new URLSearchParams(),
    );
    expect(emptied.items).toHaveLength(0);
    const anonHtml = renderRepoPackagesPage(pageCtx(anon, { repo: repoB, repoHasPackages: true }), { ...emptied, canWritePackages: false });
    expect(anonHtml).toContain("There are no packages yet.");
    expect(anonHtml).not.toContain("package settings"); // the writer hint needs the grant

    const writerViewer: Viewer = { kind: "user", id: owner.id, username: "tabowner", isAdmin: false };
    const writerHtml = renderRepoPackagesPage(pageCtx(writerViewer, { repo: repoB, repoHasPackages: true }), {
      ...emptied,
      canWritePackages: true,
    });
    expect(writerHtml).toContain("package settings");
    expect(writerHtml).toContain('href="/tabowner/-/packages"');
  });

  it("the shell tab strip arms the Packages item only when repoHasPackages is set (the header.tmpl:140 slot)", async () => {
    const { repoA } = await seedRepoWorld();
    const armed = renderToString(
      <BaseLayout
        ctx={pageCtx({ kind: "anonymous" }, { repo: repoA, repoHasPackages: true, repoHasProjects: true })}
        title="Packages"
        pageClass="repository packages"
        activeTab="packages"
      >
        <p>x</p>
      </BaseLayout>,
    );
    const strip = armed.slice(armed.indexOf('<overflow-menu class="ui secondary pointing menu">'), armed.indexOf("</overflow-menu>"));
    expect(strip).toContain('<a class="active item" href="/tabowner/repo-a/packages">');
    expect(strip).toContain('class="svg octicon-package"');
    // Upstream slot: between Pulls and Projects.
    expect(strip.indexOf("/tabowner/repo-a/packages")).toBeGreaterThan(strip.indexOf("/tabowner/repo-a/pulls"));
    expect(strip.indexOf("/tabowner/repo-a/packages")).toBeLessThan(strip.indexOf("/tabowner/repo-a/projects"));

    const unarmed = renderToString(
      <BaseLayout ctx={pageCtx({ kind: "anonymous" }, { repo: repoA })} title="Code">
        <p>x</p>
      </BaseLayout>,
    );
    const plainStrip = unarmed.slice(unarmed.indexOf('<overflow-menu class="ui secondary pointing menu">'), unarmed.indexOf("</overflow-menu>"));
    expect(plainStrip).not.toContain("/tabowner/repo-a/packages");
    expect(plainStrip).not.toContain("octicon-package");
  });
});

// ---------------------------------------------------------------------------
// The profile tab anchor + the enum extension
// ---------------------------------------------------------------------------

describe("the profile tab anchor (packagesEnabled arms the Packages item)", () => {
  it("arms the inactive Packages item by default and drops it when the gate reads false", async () => {
    const owner = await seedUser("anchored");
    const ownerRow = await rowOf(owner.id);
    const viewer: Viewer = { kind: "user", id: owner.id, username: "anchored", isAdmin: false };
    const data = await loadUserProfileData(env.DB, ownerRow, doer(viewer), new URLSearchParams());

    const armed = renderUserProfilePage(pageCtx(viewer), data);
    expect(armed).toContain('href="/anchored/-/packages"');
    expect(armed).not.toContain('href="/anchored/-/packages" class="active item"'); // inactive here
    const disarmed = renderUserProfilePage(pageCtx(viewer, { packagesEnabled: false }), data);
    expect(disarmed).not.toContain('href="/anchored/-/packages"');
  });
});

describe("the repo_units enum extension (ratification 7)", () => {
  it("accepts a 'packages' unit row beside 'code' and reads it back", async () => {
    const owner = await seedUser("uniters");
    const repoService = new RepoService(env.DB);
    const repo = await repoService.create({ owner: { id: owner.id, usernameLower: "uniters" }, name: "unitrepo", isPrivate: false, status: "ready" });
    // The create service seeds no unit rows (repo_units rows are the
    // public-access settings page's writes) — seed the 'code' twin beside
    // the new 'packages' type explicitly.
    await db()
      .batch([
        db().insert(repoUnits).values({ repoId: repo.id, type: "code", anonymousAccessMode: "none" }).onConflictDoNothing(),
        db().insert(repoUnits).values({ repoId: repo.id, type: "packages", anonymousAccessMode: "none" }).onConflictDoNothing(),
      ]);
    const row = await db().select().from(repoUnits).where(eq(repoUnits.repoId, repo.id)).all();
    expect(row.map((unit) => unit.type).sort()).toEqual(["code", "packages"]);
    const packagesRow = row.find((unit) => unit.type === "packages");
    expect(packagesRow?.anonymousAccessMode).toBe("none");
    await db().delete(repoUnits).where(eq(repoUnits.type, "packages")).run();
    expect((await db().select().from(repoUnits).where(eq(repoUnits.repoId, repo.id)).all()).map((unit) => unit.type)).toEqual(["code"]);
  });
});

// ---------------------------------------------------------------------------
// The type census
// ---------------------------------------------------------------------------

it("the type census carries upstream's 23-member TypeList with display names", () => {
  expect(PACKAGE_TYPES).toHaveLength(23);
  expect(packageTypeName("generic")).toBe("Generic");
  expect(packageTypeName("npm")).toBe("npm");
  expect(packageTypeName("pypi")).toBe("PyPI");
  expect(packageTypeName("terraform")).toBe("Terraform State");
  expect(packageTypeName("mystery")).toBe("mystery"); // the open string set
});
