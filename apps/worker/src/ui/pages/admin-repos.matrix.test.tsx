/**
 * The ADMIN REPOSITORIES list page's matrix (the module is UNMOUNTED — the
 * mounted route posture cannot be tested; the activity-feeds.matrix harness
 * drives the module's load+render seams over real D1, generated migrations in
 * beforeAll, hono/jsx renderToString).
 *
 * Covered here:
 *   - the LOADER over the landed `searchRepositories` service: the admin
 *     viewer's all-rows scope (the service's is_admin short-circuit IS
 *     upstream's Private:true, repos.go:35) and — the admin-gate predicate's
 *     data-path twin — the NON-admin viewer driving the same loader gets the
 *     service's own visibility ladder back (public + own rows only), so the
 *     route gate is the only admin bar and the ladder stays intact;
 *   - the keyword arm, the tri-state facets (archived/template/private both
 *     directions; fork=1/mirror=1 through the mode arm), the sort vocabulary
 *     (the created/alpha real orders + the documented id-order stand-ins),
 *     and the 50-per-page pagination;
 *   - the RENDER's contract: the `admin` pageClass, the panel header +
 *     total, the row projection (the badges, the mirror/fork glyphs, the
 *     owner lock, the KiB→bytes Size cell), the no-results row, the filter
 *     radios' checked states, the pager hrefs — and the dead-link
 *     assertions (no Op/delete column, no Unadopted button, no fork=0 /
 *     mirror=0 arms).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  ADMIN_REPOS_PAGE_SIZE,
  AdminReposPage,
  adminReposLocale,
  adminRepoSortMapping,
  loadAdminReposData,
} from "./admin-repos";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const adminViewer: Viewer = { kind: "user", id: 1, username: "root", isAdmin: true };
/** A signed-in non-owner — the service ladder's stranger arm. */
const plainViewer: Viewer = { kind: "user", id: 3, username: "stranger", isAdmin: false };
const adminCtx: UiContext = { viewer: adminViewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };

interface RepoInsert {
  id: string;
  owner: string;
  ownerId: number;
  slug: string;
  visibility?: "public" | "private";
  archived?: boolean;
  template?: boolean;
  forkParent?: string | null;
  mirror?: boolean;
  stars?: number;
  forks?: number;
  watches?: number;
  issues?: number;
  sizeKb?: number;
}

async function insertUser(username: string, isAdmin = false, visibility: "public" | "private" = "public"): Promise<number> {
  const result = await env.DB.prepare(
    "INSERT INTO users (username, username_lower, display_name, is_admin, visibility, created_at) VALUES (?, ?, ?, ?, ?, unixepoch())",
  )
    .bind(username, username, username, isAdmin ? 1 : 0, visibility)
    .run();
  return result.meta.last_row_id;
}

async function insertRepo(insert: RepoInsert): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility, is_archived, is_template, fork_parent, is_mirror, num_stars, num_forks, num_watches, num_issues, size_kb, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      insert.id,
      `r_${insert.id}`,
      insert.owner,
      insert.ownerId,
      insert.slug,
      insert.visibility ?? "public",
      insert.archived === true ? 1 : 0,
      insert.template === true ? 1 : 0,
      insert.forkParent ?? null,
      insert.mirror === true ? 1 : 0,
      insert.stars ?? 0,
      insert.forks ?? 0,
      insert.watches ?? 0,
      insert.issues ?? 0,
      insert.sizeKb ?? 0,
      T0 + Number(insert.id), // distinct stamps — the created sorts stay deterministic
    )
    .run();
}

/** The fixture set (NUMERIC text ids so the service's CAST id-order stand-ins
 *  are observable — real ids are UUIDs; CAST parses leading digits (NOT
*  always 0 — the fixed-id-seed wave's probe), so the order rides the
*  id tiebreak (deterministic; corrected with the service comment)
 *  is the service's own documented degenerate posture):
 *   1 alice/pub    public            5 alice/arch      public  archived
 *   2 alice/priv   private           6 alice/tmpl      public  template
 *   3 bob/pub      public (bob is a  7 alice/forked  fork of 1
 *                  private-visibility 8 alice/mirrored mirror
 *                  owner → internal) 9 alice/starry   stars 7 forks 2 size 1024 KiB
 *   4 alice/hidden private, size 1 KiB
 *  Plus `root` (the admin) and `stranger` (the non-owner ladder probe). */
async function seedBaseFixtures(): Promise<void> {
  const aliceId = await insertUser("alice");
  const bobId = await insertUser("bob", false, "private");
  await insertUser("root", true);
  await insertUser("stranger");
  await insertRepo({ id: "1", owner: "alice", ownerId: aliceId, slug: "pub" });
  await insertRepo({ id: "2", owner: "alice", ownerId: aliceId, slug: "priv", visibility: "private" });
  await insertRepo({ id: "3", owner: "bob", ownerId: bobId, slug: "pub" });
  await insertRepo({ id: "4", owner: "alice", ownerId: aliceId, slug: "hidden", visibility: "private", sizeKb: 1 });
  await insertRepo({ id: "5", owner: "alice", ownerId: aliceId, slug: "arch", archived: true });
  await insertRepo({ id: "6", owner: "alice", ownerId: aliceId, slug: "tmpl", template: true });
  await insertRepo({ id: "7", owner: "alice", ownerId: aliceId, slug: "forked", forkParent: "1" });
  await insertRepo({ id: "8", owner: "alice", ownerId: aliceId, slug: "mirrored", mirror: true });
  await insertRepo({ id: "9", owner: "alice", ownerId: aliceId, slug: "starry", stars: 7, forks: 2, watches: 3, issues: 4, sizeKb: 1024 });
}

async function load(viewer: Viewer, search: string): Promise<Awaited<ReturnType<typeof loadAdminReposData>>> {
  return loadAdminReposData(env.DB, viewer, new URLSearchParams(search));
}

function render(data: Awaited<ReturnType<typeof loadAdminReposData>>): string {
  return renderToString(<AdminReposPage ctx={adminCtx} data={data} />);
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repositories", "users", "sessions"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the loader: the admin scope + the gate predicate's data-path twin ----------

describe("loadAdminReposData — the viewer scope", () => {
  it("the admin viewer sees ALL rows — private and internal included (upstream Private:true, repos.go:35)", async () => {
    await seedBaseFixtures();
    const data = await load(adminViewer, "");
    expect(data.total).toBe(9);
    expect(data.items.map((item) => item.repo.slug)).toContain("priv");
    expect(data.items.map((item) => item.repo.slug)).toContain("hidden");
  });

  it("the NON-admin viewer driving the same loader gets the service ladder — public + own rows only (the route gate is the admin bar)", async () => {
    await seedBaseFixtures();
    const data = await load(plainViewer, "");
    const slugs = data.items.map((item) => item.repo.slug).sort();
    expect(slugs).toEqual(["arch", "forked", "mirrored", "pub", "pub", "starry", "tmpl"]); // the publics; alice's two privates hidden
    expect(data.total).toBe(slugs.length);
  });
});

// --- the loader: keyword, facets, sorts, pagination ------------------------------

describe("loadAdminReposData — the query arms", () => {
  it("the keyword matches the slug and the owner/name pair (the service's comma-separated arm)", async () => {
    await seedBaseFixtures();
    expect((await load(adminViewer, "q=starry")).items.map((item) => item.repo.slug)).toEqual(["starry"]);
    expect((await load(adminViewer, "q=alice/pub")).items.map((item) => item.repo.slug)).toEqual(["pub"]); // the pair arm: owner alice + slug pub
    expect((await load(adminViewer, "q=nobody")).total).toBe(0);
  });

  it("archived/template/private filter BOTH directions; fork=1/mirror=1 ride the mode arm", async () => {
    await seedBaseFixtures();
    const slugs = (search: string): Promise<string[]> =>
      load(adminViewer, search).then((d) => d.items.map((item) => item.repo.slug).sort());

    expect(await slugs("archived=1")).toEqual(["arch"]);
    expect(await slugs("archived=0")).toEqual(["forked", "hidden", "mirrored", "priv", "pub", "pub", "starry", "tmpl"]);
    expect(await slugs("template=1")).toEqual(["tmpl"]);
    expect(await slugs("private=1")).toEqual(["hidden", "priv"]);
    expect(await slugs("private=0")).toEqual(["arch", "forked", "mirrored", "pub", "pub", "starry", "tmpl"]);
    expect(await slugs("fork=1")).toEqual(["forked"]);
    expect(await slugs("mirror=1")).toEqual(["mirrored"]);
    // Facets compose.
    expect(await slugs("private=1&archived=0")).toEqual(["hidden", "priv"]);
  });

  it("the sort vocabulary maps onto the landed service keys — real orders and the documented stand-ins", async () => {
    expect(adminRepoSortMapping("newest")).toEqual({ sort: "created", order: "desc" });
    expect(adminRepoSortMapping("oldest")).toEqual({ sort: "created", order: "asc" });
    expect(adminRepoSortMapping("alphabetically")).toEqual({ sort: "alpha", order: "asc" });
    expect(adminRepoSortMapping("reversealphabetically")).toEqual({ sort: "alpha", order: "desc" });
    expect(adminRepoSortMapping("recentupdate")).toEqual({ sort: "updated", order: "desc" }); // the id-order stand-in
    expect(adminRepoSortMapping("moststars")).toEqual({ sort: "stars", order: "desc" });
    expect(adminRepoSortMapping("gitsize")).toEqual({ sort: "git_size", order: "asc" });

    await seedBaseFixtures();
    // alpha is a REAL order (owner, slug).
    const alpha = await load(adminViewer, "sort=alphabetically");
    expect(alpha.items.slice(0, 3).map((item) => `${item.repo.ownerNamespace}/${item.repo.slug}`)).toEqual([
      "alice/arch",
      "alice/forked",
      "alice/hidden",
    ]);
    // created desc = the newest ids.
    const newest = await load(adminViewer, "sort=newest");
    expect(newest.items[0]?.repo.slug).toBe("starry"); // id 9
    expect(newest.items[8]?.repo.slug).toBe("pub"); // id 1
    // The default (recentupdate) rides the updated→id stand-in, never the URL.
    const fallback = await load(adminViewer, "sort=junk");
    expect(fallback.params.sort).toBe("recentupdate");
    expect(fallback.query.has("sort")).toBe(false);
  });

  it("paginates 50 per page (Admin.RepoPagingNum); the pager query carries q + sort + the facets", async () => {
    const aliceId = await insertUser("alice");
    await insertUser("root", true);
    for (let i = 0; i < ADMIN_REPOS_PAGE_SIZE + 1; i++) {
      await insertRepo({ id: String(i + 1), owner: "alice", ownerId: aliceId, slug: `r${String(i).padStart(2, "0")}` });
    }
    const page1 = await load(adminViewer, "");
    expect(page1.items).toHaveLength(ADMIN_REPOS_PAGE_SIZE);
    expect(page1.more).toBe(true);
    expect((await load(adminViewer, "page=2")).items).toHaveLength(1);

    const filtered = await load(adminViewer, "q=r&sort=moststars&archived=0&private=1&fork=1");
    expect(filtered.query.get("q")).toBe("r");
    expect(filtered.query.get("sort")).toBe("moststars");
    expect(filtered.query.get("archived")).toBe("0");
    expect(filtered.query.get("private")).toBe("1");
    expect(filtered.query.get("fork")).toBe("1");
    expect(filtered.query.has("page")).toBe(false);
  });
});

// --- the render -------------------------------------------------------------------

describe("the admin repos DOM (templates/admin/repo/list.tmpl at the pin)", () => {
  it("renders the pageClass, the panel header + total, and the row projection with badges", async () => {
    await seedBaseFixtures();
    const html = render(await load(adminViewer, ""));
    expect(html).toContain('class="page-content admin"'); // list.tmpl:1 (§2.4.1)
    expect(html).toContain(`>${adminReposLocale.repo_manage_panel} (${adminReposLocale.total.replace("%d", "9")})</h4>`);
    // The name cell: link + the archived/private/internal/template labels.
    expect(html).toContain('<a class="tw-break-anywhere" href="/alice/arch">arch</a>');
    expect(html.split(`<span class="ui basic label">${adminReposLocale.archived}</span>`).length - 1).toBe(1);
    expect(html.split(`<span class="ui basic label">${adminReposLocale.private}</span>`).length - 1).toBe(2); // priv + hidden
    expect(html.split(`<span class="ui basic label">${adminReposLocale.internal}</span>`).length - 1).toBe(1); // bob's public repo
    expect(html.split(`<span class="ui basic label">${adminReposLocale.template}</span>`).length - 1).toBe(1);
    // The mirror/fork glyphs (embedded bytes) and the owner lock (bob is a
    // private-visibility owner).
    expect(html).toContain("octicon-mirror");
    expect(html).toContain("octicon-repo-forked");
    expect(html).toContain("octicon-lock");
    // The counters + the Size cell (1 KiB → 1024 B → "1.0 kiB"; 1024 KiB → "1.0 MiB").
    expect(html).toContain("<td>7</td>"); // starry's stars
    expect(html).toContain("1.0 kiB");
    expect(html).toContain("1.0 MiB");
    for (const header of [
      adminReposLocale.col_owner,
      adminReposLocale.col_watchers,
      adminReposLocale.col_stars,
      adminReposLocale.col_forks,
      adminReposLocale.col_issues,
      adminReposLocale.col_size,
      adminReposLocale.col_updated,
      adminReposLocale.col_created,
    ]) {
      expect(html).toContain(header);
    }
  });

  it("renders NO dead controls — no Op/delete column, no Unadopted button, no LFS Size column", async () => {
    await seedBaseFixtures();
    const html = render(await load(adminViewer, ""));
    expect(html).not.toContain("/-/admin/repos/delete"); // the Op column's target (list.tmpl:84)
    expect(html).not.toContain("octicon-trash");
    expect(html).not.toContain('href="/-/admin/repos/unadopted"'); // list.tmpl:6
    expect(html).not.toContain("LFS Size"); // the omitted column (no source — the module header)
    expect(html).not.toContain('name="fork" value="0"'); // the negated fork arm is not rendered
    expect(html).not.toContain('name="mirror" value="0"'); // the negated mirror arm is not rendered
  });

  it("renders the filter radios' checked states and the sort buttons", async () => {
    await seedBaseFixtures();
    const html = render(await load(adminViewer, "q=a&archived=1&fork=1&private=0&sort=moststars"));
    expect(html).toContain('action="/-/admin/repos"');
    expect(html).toContain('name="q" value="a"');
    expect(html).toContain('name="archived" value="1" checked');
    expect(html).not.toContain('name="archived" value="0" checked');
    expect(html).toContain('name="fork" value="1" checked');
    expect(html).toContain('name="private" value="0" checked');
    expect(html).toContain('name="sort" value="moststars"'); // the submit-button sort menu
  });

  it("renders the no-results row (colspan 10) and the sortable header links", async () => {
    await seedBaseFixtures();
    const empty = render(await load(adminViewer, "q=nobody"));
    expect(empty).toContain(adminReposLocale.no_results);

    const sorted = render(await load(adminViewer, "sort=feweststars"));
    expect(sorted).toContain('href="/-/admin/repos?sort=moststars"'); // the Stars header toggles back
    expect(sorted).toContain('href="/-/admin/repos?sort=gitsize"'); // the Size header offers its asc arm (list.tmpl:32)
    expect(sorted).toContain("octicon-triangle-down"); // the active feweststars direction (desc)
  });

  it("renders the pager href carrying q + sort + the facets", async () => {
    const aliceId = await insertUser("alice");
    await insertUser("root", true);
    for (let i = 0; i < ADMIN_REPOS_PAGE_SIZE + 1; i++) {
      await insertRepo({ id: String(i + 1), owner: "alice", ownerId: aliceId, slug: `r${String(i).padStart(2, "0")}` });
    }
    const html = render(await load(adminViewer, "sort=newest"));
    expect(html).toContain(">Older<");
    expect(html).toContain('href="/-/admin/repos?sort=newest&amp;page=2"');
    expect(html).not.toContain(">Newer<");
  });

  it("renders the family navbar with Repositories active and nothing unlanded", async () => {
    await seedBaseFixtures();
    const html = render(await load(adminViewer, ""));
    expect(html).toContain('class="active item" href="/-/admin/repos"');
    expect(html).toContain('href="/-/admin/users"');
    expect(html).toContain('href="/-/admin/orgs"');
    expect(html).not.toContain("/-/admin/packages"); // the Assets group's other item — unlanded
    // The census R18 arms landed (the nav fold wave): the Integrations group.
    expect(html).toContain('href="/-/admin/applications"');
    expect(html).toContain('href="/-/admin/hooks"');
    expect(html).toContain('href="/-/admin/notices"'); // SPEC-0018 §3.1's top-level item
    expect(html).not.toContain("/-/admin/config");
    expect(html).not.toContain("/-/admin/actions");
  });
});
