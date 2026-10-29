/**
 * The ADMIN PACKAGES list page's matrix (the module + its mounted route):
 * the admin-repos.matrix harness shape (module load+render seams over real
 * D1, generated migrations in beforeAll, hono/jsx renderToString) plus the
 * mount-window's minted-session route harness for the GATE LADDER (the
 * shared adminPagePrologue through the real uiRouter).
 *
 * Covered here:
 *   - the GATE LADDER (route level): anonymous 303s onto the login
 *     round-trip carrying the exact path, a signed-in non-admin 404-shells,
 *     the site admin gets the page with the shared navbar's Packages item
 *     marked active (exactly once); the strict-polarity PACKAGES_ENABLED
 *     arm — "false" 404-shells the page AND hides the nav item on the
 *     other admin pages (upstream's `packagesEnabled` group qualifier,
 *     web.go:855, and navbar.tmpl:34's `{{if .EnablePackages}}`); the
 *     unlanded delete/cleanup POST tails stay unclaimed (parse null).
 *   - the LOADER over the landed `searchVersions` service (the function the
 *     API's adminListPackages op rides — routes/packages.ts:770): the
 *     ALL-OWNERS VERSION-list shape (SearchVersions, not the R04
 *     latest-per-package projection — a two-version package renders two
 *     rows), internal rows pinned out (both is-internal columns), the
 *     lower-name LIKE q facet, the type facet (exact/all/""/junk), the
 *     20-per-page pagination with the more flag, and the header's two
 *     blob-size totals (referenced minus unreferenced / the raw
 *     unreferenced figure — package_blob.go:110-123's pair).
 *   - the RENDER's contract: the nine live columns over a seeded row (the
 *     owner link + the private-visibility lock, the type display name, the
 *     PLAIN name cell, the VersionWebLink anchor, the creator link, the
 *     linked-repo cell, the summed blob Size, the AbsoluteShort stamp),
 *     the unattributed-creator empty cell (creator_id 0 — no Ghost page),
 *     the empty state's colspan=9 no-results row under the UNCONDITIONAL
 *     filter form, the pager keeping q + type, and the dead-link
 *     assertions (no Cleanup button, no delete modal/URL, no sortable
 *     headers — the service has no sort arm).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { getOrInsertBlob, packageBlobContentKey } from "../../services/packages/blobs";
import { getOrInsertPackage, getOrInsertVersion, linkPackageToRepo, tryInsertFile } from "../../services/packages/model";
import { RepoService } from "../../repos/service";
import { packageVersions, packages, users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import {
  AdminPackagesPage,
  adminPackagesLocale,
  loadAdminPackagesData,
  type AdminPackagesData,
} from "./admin-packages";
import { PACKAGES_PAGE_SIZE } from "./packages";
import { formatByteSize } from "../page-data";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const assets = shellAssetsFromManifest(manifest);
const adminViewer = { kind: "user", id: 1, username: "root", isAdmin: true } as const;
const adminCtx: UiContext = { viewer: adminViewer, origin: ORIGIN, assets };

/** Tables the fixtures touch (children first — the model suite's sweep
 *  convention; the users wipe last, cascading the sessions the route group
 *  mints). */
const FIXTURE_TABLES = [
  "personal_access_tokens",
  "email_addresses",
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
  opts: { visibility?: "public" | "limited" | "private" } = {},
): Promise<{ id: number; username: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      visibility: opts.visibility ?? "public",
      createdAt: at(0),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username };
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
    now: opts.now ?? at(0),
  });
  const { row: ver } = await getOrInsertVersion(env.DB, {
    packageId: pkg.id,
    creatorId: opts.creatorId ?? ownerId,
    version,
    now: opts.now ?? at(0),
  });
  return { pkg, ver };
}

/** One file (and its content-addressed blob row + R2 object) for a version. */
async function seedFile(versionId: number, name: string, payload: string) {
  const bytes = new TextEncoder().encode(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const { row: blob } = await getOrInsertBlob(env.DB, { size: bytes.byteLength, sha256, now: at(0) });
  const inserted = await tryInsertFile(env.DB, { versionId, blobId: blob.id, name, isLead: false, now: at(0) });
  if (inserted.outcome !== "created") throw new Error("file seed failed");
  await env.REPO_PACKS.put(packageBlobContentKey(sha256), bytes);
  return { file: inserted.row, blob };
}

async function load(search: string): Promise<AdminPackagesData> {
  return loadAdminPackagesData(env.DB, new URLSearchParams(search));
}

function render(data: AdminPackagesData): string {
  return renderToString(<AdminPackagesPage ctx={adminCtx} data={data} />);
}

// ---------------------------------------------------------------------------
// The loader (services/packages/model.ts searchVersions — the admin read)
// ---------------------------------------------------------------------------

describe("loadAdminPackagesData — the all-owners version list", () => {
  it("lists VERSION rows across every owner (SearchVersions, not the R04 latest-only shape)", async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    await seedPackageVersion(alice.id, "Alpha", "1.0.0", { now: at(1) });
    await seedPackageVersion(alice.id, "Alpha", "2.0.0", { now: at(2) });
    await seedPackageVersion(bob.id, "beta", "0.1.0", { now: at(3), type: "npm" });

    const data = await load("");
    expect(data.total).toBe(3);
    expect(data.items.map((item) => `${item.ownerName}/${item.pkg.name}@${item.version.version}`)).toEqual([
      "bob/beta@0.1.0", // created desc — the service's pinned order
      "alice/Alpha@2.0.0",
      "alice/Alpha@1.0.0",
    ]);
    expect(data.more).toBe(false);
  });

  it("pins internal rows out (both is-internal columns)", async () => {
    const alice = await seedUser("alice");
    await seedPackageVersion(alice.id, "open", "1.0.0", { now: at(1) });
    const hiddenPkg = await seedPackageVersion(alice.id, "shaded", "1.0.0", { now: at(2) });
    await db().update(packages).set({ isInternal: true }).where(eq(packages.id, hiddenPkg.pkg.id)).run();
    const hiddenVer = await seedPackageVersion(alice.id, "veiled", "1.0.0", { now: at(3) });
    await db().update(packageVersions).set({ isInternal: true }).where(eq(packageVersions.id, hiddenVer.ver.id)).run();

    const data = await load("");
    expect(data.total).toBe(1);
    expect(data.items.map((item) => item.pkg.name)).toEqual(["open"]);
  });

  it("the q facet rides the lower-name LIKE (case-insensitive)", async () => {
    const alice = await seedUser("alice");
    await seedPackageVersion(alice.id, "Alpha", "1.0.0", { now: at(1) });
    await seedPackageVersion(alice.id, "beta", "1.0.0", { now: at(2) });

    expect((await load("q=alp")).total).toBe(1);
    expect((await load("q=ALP")).items.map((item) => item.pkg.name)).toEqual(["Alpha"]);
    expect((await load("q=nomatch")).total).toBe(0);
  });

  it("the type facet: an exact type filters, all and empty keep everything, junk matches nothing", async () => {
    const alice = await seedUser("alice");
    await seedPackageVersion(alice.id, "gen-thing", "1.0.0", { now: at(1), type: "generic" });
    await seedPackageVersion(alice.id, "npm-thing", "1.0.0", { now: at(2), type: "npm" });

    expect((await load("type=generic")).items.map((item) => item.pkg.name)).toEqual(["gen-thing"]);
    expect((await load("type=all")).total).toBe(2);
    expect((await load("")).total).toBe(2);
    const junk = await load("type=junk");
    expect(junk.total).toBe(0);
    expect(junk.items).toEqual([]);
  });

  it("paginates 20 version rows per page with the more flag (PackagesPagingNum)", async () => {
    const alice = await seedUser("alice");
    for (let i = 1; i <= PACKAGES_PAGE_SIZE + 2; i++) {
      await seedPackageVersion(alice.id, "paged", `1.0.${i}`, { now: at(i) });
    }
    const first = await load("");
    expect(first.total).toBe(PACKAGES_PAGE_SIZE + 2);
    expect(first.items.length).toBe(PACKAGES_PAGE_SIZE);
    expect(first.more).toBe(true);
    const second = await load("page=2");
    expect(second.items.length).toBe(2);
    expect(second.more).toBe(false);
    // The pager's param set keeps the facets, never the page.
    expect(second.pagerQuery.toString()).toBe("");
    const filtered = await load("q=paged&type=generic&page=1");
    expect(filtered.pagerQuery.get("q")).toBe("paged");
    expect(filtered.pagerQuery.get("type")).toBe("generic");
    expect(filtered.pagerQuery.get("page")).toBeNull();
  });

  it("the header's blob-size totals: referenced minus unreferenced, and the raw sweep", async () => {
    const alice = await seedUser("alice");
    const { ver } = await seedPackageVersion(alice.id, "sized", "1.0.0", { now: at(1) });
    await seedFile(ver.id, "one.bin", "a".repeat(100));
    await seedFile(ver.id, "two.bin", "b".repeat(200));
    // An unreferenced blob — a row no package_files row points at.
    const orphanBytes = new TextEncoder().encode("c".repeat(50));
    const orphanDigest = await crypto.subtle.digest("SHA-256", orphanBytes);
    const orphanSha = [...new Uint8Array(orphanDigest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await getOrInsertBlob(env.DB, { size: 50, sha256: orphanSha, now: at(0) });

    const data = await load("");
    // totalBlobSize = 100 + 200 + 50 = 350; displayed Total Size = 350 - 50.
    expect(data.totalSizeText).toBe(formatByteSize(350 - 50));
    expect(data.totalUnreferencedSizeText).toBe(formatByteSize(50));
  });
});

// ---------------------------------------------------------------------------
// The render (templates/admin/packages/list.tmpl at the pin)
// ---------------------------------------------------------------------------

describe("AdminPackagesPage — the nine-column table", () => {
  it("projects one row: owner link + lock, type name, plain name, version link, creator, repo, size, date", async () => {
    const alice = await seedUser("alice");
    const privateBob = await seedUser("bob", { visibility: "private" });
    const repoService = new RepoService(env.DB);
    const repo = await repoService.create({
      owner: { id: alice.id, usernameLower: alice.username.toLowerCase() },
      name: "linked-repo",
      isPrivate: false,
      status: "ready",
    });
    const own = await seedPackageVersion(alice.id, "Own-Pkg", "2.0.0", { now: at(1), creatorId: alice.id });
    await seedFile(own.ver.id, "asset.bin", "x".repeat(2048));
    await linkPackageToRepo(env.DB, own.pkg.id, repo.id);
    await seedPackageVersion(privateBob.id, "locked-thing", "1.0.0", {
      now: at(2),
      type: "npm",
      creatorId: 0, // the unattributed arm — the empty creator cell
    });

    const html = render(await load(""));

    // The header: panel + total + the two size totals.
    expect(html).toContain("Package Management (Total: 2,");
    // The alice row: the version link (VersionWebLink — lower segments), the
    // creator link, the linked repo (bare slug text, full href), the summed
    // blob size, the AbsoluteShort stamp.
    expect(html).toContain('href="/alice/-/packages/generic/own-pkg/2.0.0"');
    expect(html).toContain(">2.0.0</a>");
    expect(html).toContain('href="/alice">alice</a>');
    expect(html).toContain('href="/alice/linked-repo">linked-repo</a>');
    expect(html).toContain(">2.0 kiB</td>");
    expect(html).toContain(">Nov 14, 2023</td>");
    // The name cell is PLAIN text — the admin table does not link it.
    expect(html).toContain("<td class=\"gt-ellipsis tw-max-w-48\">Own-Pkg</td>");
    // The type renders its display name.
    expect(html).toContain("<td>Generic</td>");
    expect(html).toContain("<td>npm</td>");
    // The private owner's lock rides the embedded-icon seam.
    expect(html).toContain("octicon-lock");
    // The private owner's OWN link still renders (the lock is additive).
    expect(html).toContain('href="/bob">bob</a>');
    // The unattributed creator renders the EMPTY cell (no Ghost anchor) —
    // the theirs row's creator + repository cells (unlinked package) are
    // the only empty tds in the document.
    expect(html).toContain("<td></td>");
    expect(html).not.toContain('href="/0"');
  });

  it("the empty state: the unconditional filter form + the colspan-9 no-results row", async () => {
    const html = render(await load(""));
    expect(html).toContain('name="q"');
    expect(html).toContain('name="type"');
    expect(html).toContain("<option value=\"\">Type</option>");
    expect(html).toContain('<option value="all">All</option>');
    expect(html).toContain('<option value="generic">Generic</option>');
    expect(html).toContain('colspan="9"');
    expect(html).toContain("No results found.");
  });

  it("the dead-link assertions: no Cleanup button, no delete modal/URL, no sortable headers, no Op column", async () => {
    const alice = await seedUser("alice");
    await seedPackageVersion(alice.id, "plain", "1.0.0", { now: at(1) });
    const html = render(await load(""));
    expect(html).not.toContain(adminPackagesLocale.cleanup);
    expect(html).not.toContain("/-/admin/packages/delete");
    expect(html).not.toContain("/-/admin/packages/cleanup");
    expect(html).not.toContain("admin-package-delete-modal");
    // The sort vocabulary has no landed service arm — plain headers only.
    expect(html).not.toContain("data-sortt-asc");
    expect(html).not.toContain("data-sortt-desc");
    expect(html).not.toContain("SortArrow");
  });

  it("the pager keeps q + type and carries the page arm", async () => {
    const alice = await seedUser("alice");
    for (let i = 1; i <= PACKAGES_PAGE_SIZE + 1; i++) {
      await seedPackageVersion(alice.id, "pager", `1.0.${i}`, { now: at(i), type: "generic" });
    }
    const html = render(await load("q=pager&type=generic"));
    expect(html).toContain('href="/-/admin/packages?q=pager&amp;type=generic&amp;page=2"');
  });
});

// ---------------------------------------------------------------------------
// The route level — the gate ladder through the shared adminPagePrologue
// ---------------------------------------------------------------------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher; PACKAGES_ENABLED?: string };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};
/** The disabled-posture env (the strict-polarity var's only off value). */
const packagesOffEnv: RouteEnv = { ...routeEnv, PACKAGES_ENABLED: "false" };

async function fetchUi(path: string, init?: RequestInit, withEnv: RouteEnv = routeEnv): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), withEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

describe("the /-/admin/packages route — the gate ladder", () => {
  it("the parse claims the bare literal only", () => {
    expect(parseUiRoute("/-/admin/packages")).toEqual({ family: "admin-packages" });
    // The unlanded write tails stay unclaimed — the engine's 404.
    expect(parseUiRoute("/-/admin/packages/delete")).toBeNull();
    expect(parseUiRoute("/-/admin/packages/cleanup")).toBeNull();
    expect(parseUiRoute("/-/admin/packages/extra")).toBeNull();
    expect(handlesUiRoute("/-/admin/packages")).toBe(true);
  });

  it("anonymous 303s onto the login round-trip carrying the exact path", async () => {
    const res = await fetchUi("/-/admin/packages");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/admin/packages")}`);
  });

  it("a signed-in non-admin 404-shells (the hidden-surface NotFound posture)", async () => {
    const pal = await seedVerifiedUser({ username: "apkg-pal" });
    const res = await fetchUi("/-/admin/packages", { headers: { cookie: await sessionHeader(pal.id) } });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
  });

  it("the admin gets the page with the shared navbar's Packages item marked active (exactly once)", async () => {
    const admin = await seedVerifiedUser({ username: "apkg-admin", isAdmin: true });
    const alice = await seedUser("alice");
    await seedPackageVersion(alice.id, "routed", "1.0.0", { now: at(1) });
    const res = await fetchUi("/-/admin/packages", { headers: { cookie: await sessionHeader(admin.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="active item" href="/-/admin/packages"');
    expect(html.match(/class="flex-container-nav"/g)?.length).toBe(1);
    expect(html).toContain("Package Management (Total: 1,");
  });

  it("PACKAGES_ENABLED=false 404-shells the page AND hides the nav item on the sibling pages", async () => {
    const admin = await seedVerifiedUser({ username: "apkg-admin2", isAdmin: true });
    const cookie = { headers: { cookie: await sessionHeader(admin.id) } };
    const page = await fetchUi("/-/admin/packages", cookie, packagesOffEnv);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("status-page-error");
    // navbar.tmpl:34's EnablePackages arm — the item vanishes from the OTHER
    // admin pages' shared navbar (Assets keeps Repositories).
    const users = await fetchUi("/-/admin/users", cookie, packagesOffEnv);
    expect(users.status).toBe(200);
    const usersHtml = await users.text();
    expect(usersHtml).not.toContain('href="/-/admin/packages"');
    expect(usersHtml).toContain('href="/-/admin/repos"');
    // The enabled posture renders the item on the same page.
    const usersOn = await fetchUi("/-/admin/users", cookie, routeEnv);
    expect((await usersOn.text())).toContain('href="/-/admin/packages"');
  });
});
