/**
 * The terraform MODULE package-page battery (SPEC
 * terraform-module-registry.md §7 — the view tail): upstream 5d9bfa1e14's
 * `m.Get("/modules/{submodule}", user.ViewPackageVersion)` (web.go:1093)
 * through the SAME loader the version view uses (upstream reuses
 * ViewPackageVersion, web/user/package.go:207-214):
 *
 *  - the root view's data: the parsed metadata + submodule null; the
 *    submodule view swaps the body; an UNKNOWN submodule 404s (the
 *    upstream guard — `Submodules[submodule] == nil` → NotFound); a
 *    non-module type on the /modules/ URL 404s (the metadata assertion
 *    fails upstream);
 *  - the render: the install snippet (root source `host/owner/name`,
 *    submodule source with `//modules/<name>`, the display version), the
 *    terragrunt tfr:// snippet, the credentials snippet, the README
 *    section, the inputs table (the required badge + the QUOTED default
 *    expression text), the outputs + providers sections, and the
 *    submodules list (root only, the PathEscaped link);
 *  - the page title gains ` //modules/<sub>` on the submodule arms
 *    (package.go's ctx.Data["Title"]);
 *  - the type census rides the matrix battery's updated pin (24 members).
 */

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";
import { getOrInsertPackage, getOrInsertVersion } from "../../services/packages/model";
import { writeVersionMetadata } from "../../services/packages/protocol-common";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { loadOwnerPackageVersionViewData, renderOwnerPackageVersionViewPage } from "./packages";

const T0 = new Date(1_700_000_000 * 1000);
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const assets = shellAssetsFromManifest(manifest);

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

async function seedUser(username: string) {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      type: "user",
      visibility: "public",
      createdAt: T0,
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return user;
}

/** One terraform-module package + version carrying the given metadata. */
async function seedModule(metadata: unknown, version = "1.2.0") {
  const owner = await seedUser("modowner");
  const { row: pkg } = await getOrInsertPackage(env.DB, {
    ownerId: owner.id,
    type: "terraform-module",
    name: "vpc/aws",
    semverCompatible: true,
    now: T0,
  });
  const { row: ver } = await getOrInsertVersion(env.DB, {
    packageId: pkg.id,
    creatorId: owner.id,
    version,
    now: T0,
  });
  await writeVersionMetadata(env.DB, ver.id, JSON.stringify(metadata));
  return { owner, pkg, ver };
}

function pageCtx(viewer: Viewer, extra: Partial<UiContext> = {}): UiContext {
  return { viewer, origin: ORIGIN, assets, ...extra };
}

const MODULE_METADATA = {
  readme: "# vpc\n",
  root: {
    inputs: [
      { name: "region", type: "string", default: '"eu-west-1"', required: false },
      { name: "cidr", required: true },
    ],
    outputs: [{ name: "vpc_id", description: "VPC id" }],
    providers: [
      { name: "aws", source: "hashicorp/aws", version: "~> 5.0" },
      { name: "random", version: "~> 3.0" },
    ],
  },
  submodules: {
    net: {
      readme: "# Net submodule\n",
      module: { inputs: [{ name: "sub_cidr", required: true }] },
    },
  },
};

const ownerViewer = (id: number, username: string): Viewer => ({ kind: "user", id, username, isAdmin: false });

describe("the module view loader (web/user/package.go:207-214)", () => {
  it("loads the root view: the metadata with submodule null", async () => {
    const { owner } = await seedModule(MODULE_METADATA);
    const data = await loadOwnerPackageVersionViewData(
      env.DB,
      { kind: "user", user: owner },
      ownerViewer(owner.id, "modowner"),
      ORIGIN,
      "terraform-module",
      "vpc/aws",
      "1.2.0",
    );
    expect(data).not.toBeNull();
    expect(data!.moduleView).not.toBeNull();
    expect(data!.moduleView!.submodule).toBeNull();
    expect(data!.moduleView!.metadata.readme).toBe("# vpc\n");
    expect(data!.moduleView!.metadata.root?.inputs).toHaveLength(2);
  });

  it("loads a submodule view and 404s an unknown one", async () => {
    const { owner } = await seedModule(MODULE_METADATA);
    const viewer = ownerViewer(owner.id, "modowner");
    const ownerRow = { kind: "user" as const, user: owner };
    const data = await loadOwnerPackageVersionViewData(env.DB, ownerRow, viewer, ORIGIN, "terraform-module", "vpc/aws", "1.2.0", "net");
    expect(data!.moduleView!.submodule).toBe("net");
    expect(data!.moduleView!.metadata.submodules?.net?.readme).toBe("# Net submodule\n");
    const missing = await loadOwnerPackageVersionViewData(env.DB, ownerRow, viewer, ORIGIN, "terraform-module", "vpc/aws", "1.2.0", "nope");
    expect(missing).toBeNull();
  });

  it("404s a non-module type riding the /modules/ URL", async () => {
    const owner = await seedUser("plainowner");
    const { row: pkg } = await getOrInsertPackage(env.DB, { ownerId: owner.id, type: "generic", name: "app-tools", now: T0 });
    await getOrInsertVersion(env.DB, { packageId: pkg.id, creatorId: owner.id, version: "1.0.0", now: T0 });
    const missing = await loadOwnerPackageVersionViewData(
      env.DB,
      { kind: "user", user: owner },
      ownerViewer(owner.id, "plainowner"),
      ORIGIN,
      "generic",
      "app-tools",
      "1.0.0",
      "net",
    );
    expect(missing).toBeNull();
  });
});

describe("the module view render (terraform_module.tmpl)", () => {
  it("renders the install snippets, README, tables, and the submodules list on the root view", async () => {
    const { owner } = await seedModule(MODULE_METADATA);
    const data = await loadOwnerPackageVersionViewData(
      env.DB,
      { kind: "user", user: owner },
      ownerViewer(owner.id, "modowner"),
      ORIGIN,
      "terraform-module",
      "vpc/aws",
      "1.2.0",
    );
    const html = renderOwnerPackageVersionViewPage(pageCtx(ownerViewer(owner.id, "modowner")), data!);
    // The install snippet: the label is the name's first /-cut segment, the
    // source is host/owner/name, the version is the DISPLAY version. (The
    // hono/jsx renderer escapes quotes in text — the pins use the escaped
    // wire form.)
    expect(html).toContain(`module &quot;vpc&quot; {`);
    expect(html).toContain(`source  = &quot;https://test.local/modowner/vpc/aws&quot;`);
    expect(html).toContain(`version = &quot;1.2.0&quot;`);
    // The terragrunt + credentials snippets.
    expect(html).toContain(`tfr://https://test.local/modowner/vpc/aws?version=1.2.0`);
    expect(html).toContain(`credentials &quot;test.local&quot; {`);
    // The README section (markdown → the heading wire form, the anchor
    // id included).
    expect(html).toContain(">vpc</h1>");
    // The inputs table: the required badge + the QUOTED default text.
    expect(html).toContain("<code>region</code>");
    expect(html).toContain('<span class="ui tiny red label">required</span>');
    expect(html).toContain("<code>&quot;eu-west-1&quot;</code>");
    expect(html).toContain("<code>cidr</code>");
    // The outputs + providers sections.
    expect(html).toContain("<code>vpc_id</code>");
    // The provider source renders PLAIN in parens (the template's shape);
    // the version stays in a code tag.
    expect(html).toContain("(hashicorp/aws)");
    expect(html).toContain("<code>~&gt; 3.0</code>");
    // The submodules list (root only) with the escaped link.
    expect(html).toContain("Submodules</h4>");
    expect(html).toContain(`/modowner/-/packages/terraform-module/vpc/aws/1.2.0/modules/net`);
    expect(html).toContain("https://test.local/modowner/vpc/aws//modules/net");
    // The plain title (no submodule suffix on the root view).
    expect(html).toContain("<title>vpc/aws");
  });

  it("renders the submodule view: the //modules source, the submodule body, the title suffix, no submodules list", async () => {
    const { owner } = await seedModule(MODULE_METADATA);
    const viewer = ownerViewer(owner.id, "modowner");
    const data = await loadOwnerPackageVersionViewData(
      env.DB,
      { kind: "user", user: owner },
      viewer,
      ORIGIN,
      "terraform-module",
      "vpc/aws",
      "1.2.0",
      "net",
    );
    const html = renderOwnerPackageVersionViewPage(pageCtx(viewer), data!);
    expect(html).toContain(`source  = &quot;https://test.local/modowner/vpc/aws//modules/net&quot;`);
    expect(html).toContain(`tfr://https://test.local/modowner/vpc/aws//modules/net?version=1.2.0`);
    // The submodule's README + inputs replace the root's.
    expect(html).toContain(">Net submodule</h1>");
    expect(html).toContain("<code>sub_cidr</code>");
    expect(html).not.toContain("<code>region</code>");
    expect(html).not.toContain("Submodules</h4>");
    // The title suffix (package.go's ctx.Data["Title"]) — BaseLayout
    // appends the site suffix on the wire.
    expect(html).toContain("<title>vpc/aws //modules/net");
  });

  it("renders an empty module body without sections when the metadata is bare", async () => {
    const { owner } = await seedModule({}, "0.1.0");
    const data = await loadOwnerPackageVersionViewData(
      env.DB,
      { kind: "user", user: owner },
      ownerViewer(owner.id, "modowner"),
      ORIGIN,
      "terraform-module",
      "vpc/aws",
      "0.1.0",
    );
    const html = renderOwnerPackageVersionViewPage(pageCtx(ownerViewer(owner.id, "modowner")), data!);
    expect(html).toContain(`module &quot;vpc&quot; {`);
    expect(html).not.toContain("Submodules</h4>");
    expect(html).not.toContain("<code>region</code>");
  });
});

describe("the metadata round trip through the ROUTE upload", () => {
  it("the upload walk's stored metadata renders (service→view integration)", async () => {
    // The parse side is pinned by the service battery; here the wire shape
    // lands through writeVersionMetadata and renders.
    const owner = await seedUser("modowner2");
    const { row: pkg } = await getOrInsertPackage(env.DB, {
      ownerId: owner.id,
      type: "terraform-module",
      name: "net/vpc",
      semverCompatible: true,
      now: T0,
    });
    const { row: ver } = await getOrInsertVersion(env.DB, {
      packageId: pkg.id,
      creatorId: owner.id,
      version: "1.0.0",
      now: T0,
    });
    await writeVersionMetadata(env.DB, ver.id, JSON.stringify({ root: { inputs: [{ name: "size", required: true }] } }));
    const data = await loadOwnerPackageVersionViewData(
      env.DB,
      { kind: "user", user: owner },
      ownerViewer(owner.id, "modowner2"),
      ORIGIN,
      "terraform-module",
      "net/vpc",
      "1.0.0",
    );
    const html = renderOwnerPackageVersionViewPage(pageCtx(ownerViewer(owner.id, "modowner2")), data!);
    // The label cuts at the FIRST slash: "net" (StringUtils.Cut's [0]).
    expect(html).toContain(`module &quot;net&quot; {`);
    expect(html).toContain(`source  = &quot;https://test.local/modowner2/net/vpc&quot;`);
    expect(html).toContain("<code>size</code>");
  });
});
