/**
 * The repo-settings BASICS page's deferred matrix (the module MOUNTED since
 * the early waves — GET+POST /{owner}/{repo}/settings at ui/index.ts, pages/
 * settings.tsx): the route-level arms the wave-4 block left open, driven
 * through the REAL routes on the repo-settings-wiki fdf3ab1 matrix's
 * minted-session pattern —
 *
 *   - the settingsGate posture on BOTH methods (anonymous 303, signed-in
 *     non-admin 404 BEFORE any write),
 *   - the admin GET carrying the STORED basics (saveRepoSettings' description
 *     + the private checkbox from the repositories row),
 *   - the rename round-trip verified at the storage layer: the 303 onto the
 *     RENAMED canonical URL, the D1 slug/description read-back, the
 *     `repo_redirects` row the git-HTTP/LFS legs consume, and the old
 *     settings URL 404-shelling (the UI repo resolution consults NO
 *     redirect — the landed split),
 *   - the case-fold no-op (a same-slug name is not a rename — no redirect
 *     row),
 *   - the invalid arms (empty / invalid / colliding name) re-rendering at
 *     200 with the service's EXACT texts and the carried submission, D1
 *     untouched,
 *   - the visibility flip both ways with the D1 read-back,
 *   - the guard-first cross-origin 403 (nothing written),
 *   - and the settings-family claim pin for the bare /settings tail.
 *
 * Wave-129 additions (the basics family's two deepest reachable arms):
 * the stale-alias consumption (renaming ONTO a name carrying another repo's
 * redirect row consumes the alias and files the reverse pair —
 * RepoService.rename's batch delete) and the private toggle's downstream
 * settings-nav visibility (the conditional Public Access item arms for a
 * private repo and disarms on the flip back).
 *
 * Wave-settings-options additions (the options form's full upstream field
 * set at the pin): the basic form's `template`/`website` fields, the
 * advanced form's unit checkboxes (`enable_internal_tracker` /
 * `enable_projects` / `enable_releases` / `enable_packages` /
 * `enable_pulls`, plus `enable_actions` relocated from actions_general.tmpl)
 * and the merged `archived` danger-zone flip — each toggle round-trips
 * through D1 (the repo_settings row / repositories.is_template /
 * repositories.is_archived) and re-renders its stored state on the GET;
 * the archive arm's upstream mirror refusal ("You cannot archive a mirrored
 * repo.") re-renders at 200 with nothing written. Disclosed, NOT pinned
 * here: `enable_code` (no landed repo_settings column), `enable_wiki` (the
 * wave-54 split owns it at /settings/wiki — repo-settings-wiki.test.tsx),
 * the default-branch select (NOT on options.tmpl at this pin — upstream's
 * branches.tmpl `action=default_branch` block, the branch-protection
 * module's page), and the invalid re-render's wave-129-field carry (the
 * handler rebuild pins below that the fallback renders the STORED states).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { loadRepoSettings, saveRepoSettings } from "../../api/services/repo-settings";
import { repoRedirects, repositories, users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { RepoRow } from "../ui-context";
import type { UiManifest } from "../manifest";
import { parseRepoBasicsForm } from "./settings";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

let repo: RepoRow;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_redirects", "repo_settings", "repo_mirrors", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  repo = await seedRepo("demo", "public");
});

async function seedRepo(slug: string, visibility: "public" | "private"): Promise<RepoRow> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'alice', 1, ?, 'main', ?, unixepoch())",
  )
    .bind(slug, visibility)
    .run();
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
  if (row === undefined) throw new Error("fixture repository missing");
  return row;
}

/** A second repo under the same owner (the collision arm's occupant). */
async function seedSiblingRepo(slug: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-2', 'repo-2', 'alice', 1, ?, 'main', 'public', unixepoch())",
  )
    .bind(slug)
    .run();
}

/** A second plain user (the signed-in non-admin posture). */
async function seedNonAdmin(username: string): Promise<{ id: number }> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("non-admin seed failed");
  return { id: row.id };
}

// --- the mounted-route harness (the repo-settings-wiki minted-session pattern)

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → resolveUiRequest →
 *  the settingsGate → load/apply → render, on the mounted uiRouter with the
 *  synthetic manifest; the execution context is awaited so waitUntil
 *  side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the user id (the real mintSession
 *  path, minted per request — the beforeEach users wipe cascades the
 *  sessions table; the value is never rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** The seeded owner's minted session header — the repo-admin doer the
 *  settingsGate's isRepositoryAdmin admits (the id is seed-assigned). */
async function ownerSessionHeader(): Promise<string> {
  const owner = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get();
  if (owner === undefined) throw new Error("fixture owner missing");
  return sessionHeader(owner.id);
}

/** The admin's urlencoded POST to the basics form through the real route:
 *  the given Origin header (the §2.8 guard's input) and the OWNER's minted
 *  session cookie (pass `null` explicitly for the cookie-less anonymous
 *  arm). Omitted fields are absent from the body exactly as the browser
 *  emits them (an unchecked checkbox posts nothing). */
async function basicsPost(
  fields: Record<string, string> = {},
  origin = ORIGIN,
  cookie: Promise<string> | null = ownerSessionHeader(),
): Promise<Response> {
  const cookieHeader = await (cookie ?? Promise.resolve(null));
  return fetchUi("/alice/demo/settings", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      ...(cookieHeader === null ? {} : { cookie: cookieHeader }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The stored (owner, slug) pair of the fixture repo — the D1 read-back. */
async function storedSlug(): Promise<string | undefined> {
  const row = await drizzle(env.DB).select({ slug: repositories.slug }).from(repositories).where(eq(repositories.id, repo.id)).get();
  return row?.slug;
}

/** The stored visibility of the fixture repo — the flip arm's read-back. */
async function storedVisibility(): Promise<string | undefined> {
  const row = await drizzle(env.DB).select({ visibility: repositories.visibility }).from(repositories).where(eq(repositories.id, repo.id)).get();
  return row?.visibility;
}

/** The redirect row the rename filed for the OLD slug (the git-HTTP/LFS
 *  row-13 lookup's input), or undefined. */
async function redirectFor(ownerLower: string, oldSlugLower: string): Promise<{ redirectRepoId: string } | undefined> {
  return (
    await drizzle(env.DB)
      .select({ redirectRepoId: repoRedirects.redirectRepoId })
      .from(repoRedirects)
      .where(and(eq(repoRedirects.ownerNamespace, ownerLower), eq(repoRedirects.lowerName, oldSlugLower)))
      .get()
  ) ?? undefined;
}

// --- the form parse (the route's urlencoded contract) --------------------------

describe("parseRepoBasicsForm (repo_name/description/private)", () => {
  it("trims the name, keeps the description verbatim", () => {
    const form = parseRepoBasicsForm(new URLSearchParams({ repo_name: "  padded  ", description: " body " }));
    expect(form.name).toBe("padded");
    expect(form.description).toBe(" body "); // the description is not trimmed
  });

  it("the private checkbox: any present value counts, an absent field is false", () => {
    expect(parseRepoBasicsForm(new URLSearchParams({ private: "on" })).isPrivate).toBe(true);
    expect(parseRepoBasicsForm(new URLSearchParams({ private: "" })).isPrivate).toBe(false);
    expect(parseRepoBasicsForm(new URLSearchParams()).isPrivate).toBe(false);
  });
});

describe("parseRepoBasicsForm (the wave-settings-options field set)", () => {
  it("the unit checkboxes carry upstream's field names; present = on, absent = off", () => {
    const on = parseRepoBasicsForm(
      new URLSearchParams({
        enable_internal_tracker: "on",
        enable_pulls: "on",
        enable_releases: "on",
        enable_projects: "on",
        enable_packages: "on",
        enable_actions: "on",
      }),
    );
    expect(on.units).toEqual({ hasIssues: true, hasPullRequests: true, hasReleases: true, hasProjects: true, hasPackages: true, hasActions: true });
    // The unchecked-checkbox post: every unit field absent from the body.
    expect(parseRepoBasicsForm(new URLSearchParams({ repo_name: "demo" })).units).toEqual({
      hasIssues: false,
      hasPullRequests: false,
      hasReleases: false,
      hasProjects: false,
      hasPackages: false,
      hasActions: false,
    });
  });

  it("website/template/archived parse with the checkbox semantics; the parser always fills the wave fields", () => {
    const full = parseRepoBasicsForm(
      new URLSearchParams({ repo_name: "demo", website: "https://demo.test", template: "on", archived: "on" }),
    );
    expect(full.website).toBe("https://demo.test");
    expect(full.isTemplate).toBe(true);
    expect(full.isArchived).toBe(true);
    const bare = parseRepoBasicsForm(new URLSearchParams({ repo_name: "demo" }));
    expect(bare.website).toBe("");
    expect(bare.isTemplate).toBe(false);
    expect(bare.isArchived).toBe(false);
  });
});

// --- the mounted routes (GET + POST /{owner}/{repo}/settings) -------------------

describe("the mounted routes (GET + POST /{owner}/{repo}/settings)", () => {
  it("303s an anonymous GET onto the login round-trip (the settingsGate)", async () => {
    const res = await fetchUi("/alice/demo/settings");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/alice/demo/settings")}`);
  });

  it("303s an anonymous same-origin POST onto the login round-trip too (guard passes, then the gate; nothing written)", async () => {
    const res = await basicsPost({ repo_name: "renamed", description: "should not land" }, ORIGIN, null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/alice/demo/settings")}`);
    expect(await storedSlug()).toBe("demo"); // no rename
    expect((await loadRepoSettings(env.DB, repo.id)).description).toBe(""); // no description write
  });

  it("404-shells a signed-in non-admin's GET (the settingsGate posture — the public repo resolves, the tab doesn't)", async () => {
    const bob = await seedNonAdmin("bob");
    const res = await fetchUi("/alice/demo/settings", { headers: { cookie: await sessionHeader(bob.id) } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error"); // the 404 shell
    expect(html).not.toContain("repository settings options"); // never the tab's content
  });

  it("404-shells a signed-in non-admin's POST before any write (the gate fronts the write arm too)", async () => {
    const bob = await seedNonAdmin("bob");
    const res = await basicsPost({ repo_name: "renamed", description: "should not land" }, ORIGIN, sessionHeader(bob.id));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(await storedSlug()).toBe("demo"); // nothing was written
    expect((await loadRepoSettings(env.DB, repo.id)).description).toBe("");
  });

  it("renders the admin's GET at 200 carrying the STORED basics: slug input, stored description, private checkbox", async () => {
    await saveRepoSettings(env.DB, repo.id, { description: "the stored description" }, new Date());
    const res = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository settings options"); // the §2.4.1 pageClass
    expect(html).toContain('class="active item" href="/alice/demo/settings"'); // the active navbar item
    expect(html).toContain('id="repo_name" name="repo_name" value="demo" data-repo-name="demo"');
    expect(html).toContain(">the stored description</textarea>"); // the stored row, not the default
    expect(html).toContain('id="private" name="private" type="checkbox"/>'); // public repo: unchecked
  });

  it("the admin GET of a PRIVATE repo renders the checkbox checked", async () => {
    await env.DB.prepare("UPDATE repositories SET visibility = 'private' WHERE id = 'repo-1'").run();
    const res = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<input id="private" name="private" type="checkbox" checked=""/>');
  });

  it("the rename round-trip: 303 onto the RENAMED canonical URL, D1 slug+description read-back, the redirect row, and the old URL 404-shells", async () => {
    const res = await basicsPost({ repo_name: "Renamed", description: "renamed body" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/renamed/settings"); // the renamed canonical URL

    // The D1 read-back: the slug is the LOWERED name, the description landed.
    expect(await storedSlug()).toBe("renamed");
    expect((await loadRepoSettings(env.DB, repo.id)).description).toBe("renamed body");

    // The git-HTTP/LFS leg: the old URL keeps resolving through repo_redirects.
    expect(await redirectFor("alice", "demo")).toEqual({ redirectRepoId: repo.id });

    // The UI leg: the settings route consults NO redirect — the old tab
    // 404-shells (existence moved, not aliased, for the web surface).
    const oldUrl = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(oldUrl.status).toBe(404);
    expect(await oldUrl.text()).toContain("status-page-error");

    // The renamed tab renders the new binding.
    const page = await fetchUi("/alice/renamed/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('value="renamed" data-repo-name="renamed"');
    expect(html).toContain(">renamed body</textarea>");
  });

  it("a case-folded same-slug name is NOT a rename: 303 onto the same URL and no redirect row", async () => {
    const res = await basicsPost({ repo_name: "DEMO", description: "same repo" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings");
    expect(await storedSlug()).toBe("demo"); // untouched
    expect(await redirectFor("alice", "demo")).toBeUndefined(); // no redirect was filed
    expect((await loadRepoSettings(env.DB, repo.id)).description).toBe("same repo"); // the rest still applies
  });

  it("a description-only write moves neither the slug nor the visibility", async () => {
    const res = await basicsPost({ repo_name: "demo", description: "words about the repo" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings");
    expect(await storedSlug()).toBe("demo");
    expect(await storedVisibility()).toBe("public"); // no private field → the flip is a no-op
    expect((await loadRepoSettings(env.DB, repo.id)).description).toBe("words about the repo");
  });

  it("the visibility flip round-trips through D1 both ways and the GET reflects the stored state", async () => {
    const privatize = await basicsPost({ repo_name: "demo", description: "", private: "on" });
    expect(privatize.status).toBe(303);
    expect(privatize.headers.get("location")).toBe("/alice/demo/settings");
    expect(await storedVisibility()).toBe("private");
    const privatePage = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(await privatePage.text()).toContain('<input id="private" name="private" type="checkbox" checked=""/>');

    const publish = await basicsPost({ repo_name: "demo", description: "" }); // the unchecked-checkbox post
    expect(publish.status).toBe(303);
    expect(await storedVisibility()).toBe("public");
    const publicPage = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(await publicPage.text()).toContain('<input id="private" name="private" type="checkbox"/>');
  });

  it("an empty name re-renders at 200 with the exact text and the carried submission; nothing is written", async () => {
    await saveRepoSettings(env.DB, repo.id, { description: "stored before" }, new Date());
    const res = await basicsPost({ repo_name: "", description: "carried body", private: "on" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">Repository name cannot be empty.</div>'); // exact text
    expect(html).toContain('id="repo_name" name="repo_name" value=""'); // the carried (empty) name
    expect(html).toContain(">carried body</textarea>"); // the carried description — NOT the stored one
    expect(html).toContain('<input id="private" name="private" type="checkbox" checked=""/>'); // the carried flip
    // Nothing was written: the slug, the stored description and the visibility stand.
    expect(await storedSlug()).toBe("demo");
    expect((await loadRepoSettings(env.DB, repo.id)).description).toBe("stored before");
    expect(await storedVisibility()).toBe("public");
  });

  it("an invalid name re-renders with the RepoNameInvalidError text verbatim and the carried form", async () => {
    const res = await basicsPost({ repo_name: "demo.git", description: "kept" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">repository name is not allowed: demo.git</div>');
    expect(html).toContain('value="demo.git"'); // the carried submission
    expect(await storedSlug()).toBe("demo"); // no partial write
    expect((await loadRepoSettings(env.DB, repo.id)).description).toBe(""); // the description write never ran
  });

  it("a colliding name re-renders with the RepoNameCollisionError text verbatim and the carried form", async () => {
    await seedSiblingRepo("sibling");
    const res = await basicsPost({ repo_name: "sibling", description: "kept", private: "on" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">repository already exists: alice/sibling</div>');
    expect(html).toContain(">kept</textarea>"); // the carried description
    expect(html).toContain('<input id="private" name="private" type="checkbox" checked=""/>'); // the carried flip
    expect(await storedSlug()).toBe("demo"); // the fixture repo is untouched
    expect((await loadRepoSettings(env.DB, repo.id)).description).toBe("");
    expect(await storedVisibility()).toBe("public");
  });

  it("rejects a cross-origin POST with 403 before any write (sameOriginGuard first)", async () => {
    const res = await basicsPost({ repo_name: "renamed", description: "should not land" }, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await storedSlug()).toBe("demo"); // nothing was written
    expect((await loadRepoSettings(env.DB, repo.id)).description).toBe("");
  });

  it("renaming ONTO a stale redirect row consumes it: the alias flips to the renaming repo (RepoService.rename's batch swap)", async () => {
    // The deepest redirect-row seam: rename's batch DELETES any redirect row
    // for the NEW name before filing the OLD one — without that delete the
    // insert would unique-collide and the rename would report a name
    // collision against a repo that no longer exists under that slug. So
    // gamma's rename-filed alias must let demo take the gamma name over.
    await seedSiblingRepo("gamma");
    // gamma → gamma2: files the row gamma → repo-2.
    const move = await fetchUi("/alice/gamma/settings", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, cookie: await ownerSessionHeader() },
      body: new URLSearchParams({ repo_name: "gamma2" }).toString(),
    });
    expect(move.status).toBe(303);
    expect(await redirectFor("alice", "gamma")).toEqual({ redirectRepoId: "repo-2" });
    // demo → gamma: the UI route resolves the LIVE demo repo (the settings
    // route consults no redirect), the write consumes repo-2's stale alias
    // and files the reverse pair.
    const take = await basicsPost({ repo_name: "gamma", description: "" });
    expect(take.status).toBe(303);
    expect(take.headers.get("location")).toBe("/alice/gamma/settings");
    expect(await storedSlug()).toBe("gamma");
    // The swap: the stale alias is CONSUMED (the live repo needs none) and
    // the reverse pair is filed for the vacated slug. repo-2's vacated-name
    // alias WAS the consumed gamma row — the takeover leaves it alias-less
    // too (each rename files exactly one row; chains never accumulate).
    expect(await redirectFor("alice", "gamma")).toBeUndefined();
    expect(await redirectFor("alice", "demo")).toEqual({ redirectRepoId: repo.id });
    expect(await redirectFor("alice", "gamma2")).toBeUndefined();
  });

  it("the private flip arms the conditional Public Access nav item, and flipping back disarms it", async () => {
    // SettingsNav's navbar.tmpl:7-11 conditional: the item renders only for
    // a PRIVATE repo (or a public-access grant) — the options page's own
    // downstream visibility effect of the private toggle.
    const publicPage = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(await publicPage.text()).not.toContain('href="/alice/demo/settings/public_access"');

    const privatize = await basicsPost({ repo_name: "demo", private: "on" });
    expect(privatize.headers.get("location")).toBe("/alice/demo/settings");
    expect(await storedVisibility()).toBe("private");
    const privatePage = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    const privateHtml = await privatePage.text();
    expect(privateHtml).toContain('<a class="item" href="/alice/demo/settings/public_access">Public Access</a>');
    // The private checkbox stays consistent on the re-read (the flip's
    // round-trip half is the earlier arm's pin — here only the nav effect).
    expect(privateHtml).toContain('<input id="private" name="private" type="checkbox" checked=""/>');

    const publish = await basicsPost({ repo_name: "demo" });
    expect(publish.status).toBe(303);
    expect(publish.headers.get("location")).toBe("/alice/demo/settings");
    expect(await storedVisibility()).toBe("public");
    const backPage = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(await backPage.text()).not.toContain('href="/alice/demo/settings/public_access"');
  });
});

// --- the wave-settings-options toggle matrix (the options form's field set) -----

/** The raw persisted unit row (the repo_settings columns as stored — the
 *  integers behind the service's boolean mode). */
async function storedUnitRow(): Promise<{ has_issues: number; has_pull_requests: number; has_releases: number; has_projects: number; has_packages: number; has_actions: number } | undefined> {
  const res = await env.DB.prepare(
    "SELECT has_issues, has_pull_requests, has_releases, has_projects, has_packages, has_actions FROM repo_settings WHERE repo_id = 'repo-1'",
  ).first<Record<string, number>>();
  return res as undefined | { has_issues: number; has_pull_requests: number; has_releases: number; has_projects: number; has_packages: number; has_actions: number };
}

/** The repositories row's template/archived/website columns (the flip arms'
 *  read-back). */
async function storedRepoColumns(): Promise<{ is_template: number; is_archived: number }> {
  const res = await env.DB.prepare("SELECT is_template, is_archived FROM repositories WHERE id = 'repo-1'").first<{
    is_template?: number;
    is_archived?: number;
  }>();
  if (res === null || res.is_template === undefined || res.is_archived === undefined) throw new Error("fixture repository missing");
  return { is_template: res.is_template, is_archived: res.is_archived };
}

describe("the options form's wave-settings-options field set (template/website/units/archived)", () => {
  it("the plain GET renders the upstream-default unit states (issues/pulls/releases on, projects/packages/actions off) and no stored website", async () => {
    const res = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // The advanced-form section label + the unit checkboxes at the defaults
    // (loadRepoSettings' DefaultRepoUnits minus wiki, which lives at
    // /settings/wiki, minus code, which has no landed column).
    expect(html).toContain('<h4 class="ui dividing header">Advanced Settings</h4>');
    expect(html).toContain('<input class="enable-system" name="enable_internal_tracker" type="checkbox" checked=""/>');
    expect(html).toContain('<input class="enable-system" name="enable_pulls" type="checkbox" checked=""/>');
    expect(html).toContain('<input class="enable-system" name="enable_releases" type="checkbox" checked=""/>');
    expect(html).toContain('<input class="enable-system" name="enable_projects" type="checkbox"/>');
    expect(html).toContain('<input class="enable-system" name="enable_packages" type="checkbox"/>');
    expect(html).toContain('<input class="enable-system" name="enable_actions" type="checkbox"/>');
    // The basic-form additions: the template/archived toggles unchecked (the
    // repo row's flags) and the website input empty (no stored value).
    expect(html).toContain('<input id="template" name="template" type="checkbox"/>');
    expect(html).toContain('<input id="archived" name="archived" type="checkbox"/>');
    expect(html).toContain('<input id="website" name="website" type="url" maxlength="1024" value=""/>');
  });

  it("the GET renders the STORED unit/website/template/archived states (saveRepoSettings' row + the repo row's flags)", async () => {
    await saveRepoSettings(
      env.DB,
      repo.id,
      { website: "https://demo.test", hasIssues: false, hasPullRequests: false, hasProjects: true, hasActions: true },
      new Date(),
    );
    await env.DB.prepare("UPDATE repositories SET is_template = 1 WHERE id = 'repo-1'").run();
    const res = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    const html = await res.text();
    expect(html).toContain('<input id="website" name="website" type="url" maxlength="1024" value="https://demo.test"/>');
    expect(html).toContain('<input class="enable-system" name="enable_internal_tracker" type="checkbox"/>'); // stored off
    expect(html).toContain('<input class="enable-system" name="enable_pulls" type="checkbox"/>'); // stored off
    expect(html).toContain('<input class="enable-system" name="enable_projects" type="checkbox" checked=""/>'); // stored on
    expect(html).toContain('<input class="enable-system" name="enable_actions" type="checkbox" checked=""/>'); // stored on
    expect(html).toContain('<input id="template" name="template" type="checkbox" checked=""/>'); // the repo row's flag
    expect(html).toContain('<input id="archived" name="archived" type="checkbox"/>'); // still unarchived
  });

  it("the units round-trip both ways: the POST lands every flag in D1 and the GET re-renders it", async () => {
    const on = await basicsPost({
      repo_name: "demo",
      description: "",
      enable_internal_tracker: "on",
      enable_pulls: "on",
      enable_releases: "on",
      enable_projects: "on",
      enable_packages: "on",
      enable_actions: "on",
    });
    expect(on.status).toBe(303);
    expect(on.headers.get("location")).toBe("/alice/demo/settings");
    // The persisted shape: the raw repo_settings integers (1/0) AND the
    // service read (the boolean mode the API PATCH + wiki gates consume).
    expect(await storedUnitRow()).toEqual({ has_issues: 1, has_pull_requests: 1, has_releases: 1, has_projects: 1, has_packages: 1, has_actions: 1 });
    const settings = await loadRepoSettings(env.DB, repo.id);
    expect(settings.hasIssues).toBe(true);
    expect(settings.hasPullRequests).toBe(true);
    expect(settings.hasReleases).toBe(true);
    expect(settings.hasProjects).toBe(true);
    expect(settings.hasPackages).toBe(true);
    expect(settings.hasActions).toBe(true);
    const page = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    const html = await page.text();
    expect(html).toContain('<input class="enable-system" name="enable_packages" type="checkbox" checked=""/>');
    expect(html).toContain('<input class="enable-system" name="enable_actions" type="checkbox" checked=""/>');

    // The unchecked-checkbox post flips every unit off (HTML semantics: an
    // absent field is an unchecked box — the same rule `private` pinned).
    const off = await basicsPost({ repo_name: "demo", description: "" });
    expect(off.status).toBe(303);
    expect(await storedUnitRow()).toEqual({ has_issues: 0, has_pull_requests: 0, has_releases: 0, has_projects: 0, has_packages: 0, has_actions: 0 });
    const offPage = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(await offPage.text()).toContain('<input class="enable-system" name="enable_internal_tracker" type="checkbox"/>');
  });

  it("the template flag round-trips both ways through repositories.is_template and the GET reflects it", async () => {
    const mark = await basicsPost({ repo_name: "demo", description: "", template: "on" });
    expect(mark.status).toBe(303);
    expect(await storedRepoColumns()).toEqual({ is_template: 1, is_archived: 0 });
    expect(await (await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } })).text()).toContain(
      '<input id="template" name="template" type="checkbox" checked=""/>',
    );
    const unmark = await basicsPost({ repo_name: "demo", description: "" });
    expect(unmark.status).toBe(303);
    expect(await storedRepoColumns()).toEqual({ is_template: 0, is_archived: 0 });
    expect(await (await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } })).text()).toContain(
      '<input id="template" name="template" type="checkbox"/>',
    );
  });

  it("the website field round-trips: stored verbatim (including empty), re-rendered as the input value", async () => {
    const set = await basicsPost({ repo_name: "demo", description: "", website: "https://demo.example/pages" });
    expect(set.status).toBe(303);
    expect((await loadRepoSettings(env.DB, repo.id)).website).toBe("https://demo.example/pages");
    expect(await (await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } })).text()).toContain(
      'value="https://demo.example/pages"/>',
    );
    const clear = await basicsPost({ repo_name: "demo", description: "" }); // the empty input clears
    expect(clear.status).toBe(303);
    expect((await loadRepoSettings(env.DB, repo.id)).website).toBe("");
  });

  it("the archived flip round-trips both ways through repositories.is_archived and the GET reflects it", async () => {
    const archive = await basicsPost({ repo_name: "demo", description: "", archived: "on" });
    expect(archive.status).toBe(303);
    expect(archive.headers.get("location")).toBe("/alice/demo/settings");
    expect(await storedRepoColumns()).toEqual({ is_template: 0, is_archived: 1 });
    const page = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(await page.text()).toContain('<input id="archived" name="archived" type="checkbox" checked=""/>');

    const unarchive = await basicsPost({ repo_name: "demo", description: "" }); // the unchecked post
    expect(unarchive.status).toBe(303);
    expect(await storedRepoColumns()).toEqual({ is_template: 0, is_archived: 0 });
    const backPage = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(await backPage.text()).toContain('<input id="archived" name="archived" type="checkbox"/>');
  });

  it("the archive arm refuses a MIRROR with upstream's exact text and writes nothing (setting.go:1009)", async () => {
    await env.DB.prepare(
      "INSERT INTO repo_mirrors (repo_id, remote_address) VALUES ('repo-1', 'https://upstream.test/demo.git')",
    ).run();
    await saveRepoSettings(env.DB, repo.id, { description: "untouched" }, new Date());
    const res = await basicsPost({ repo_name: "demo", description: "carried", archived: "on" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">You cannot archive a mirrored repo.</div>');
    // Nothing was written: the flag stands down AND the post's other fields
    // (the description) never landed — the guard fronts the whole POST.
    expect(await storedRepoColumns()).toEqual({ is_template: 0, is_archived: 0 });
    expect((await loadRepoSettings(env.DB, repo.id)).description).toBe("untouched");
    // Unarchiving (or an already-archived flip) does not hit the guard: the
    // mirror may post the form WITHOUT the archived field and still write.
    const plain = await basicsPost({ repo_name: "demo", description: "mirror still writes" });
    expect(plain.status).toBe(303);
    expect((await loadRepoSettings(env.DB, repo.id)).description).toBe("mirror still writes");
  });

  it("the invalid-name re-render carries the legacy trio and falls back to the STORED wave-129 states (the no-recipe posture)", async () => {
    // The landed handler rebuilds the carried form with the legacy three
    // fields only (ui/index.ts, orchestrator-owned); the wave-129 fields are
    // optional on RepoBasicsForm precisely for this path — absent renders
    // the STORED state, never a false state the user did not submit.
    await saveRepoSettings(env.DB, repo.id, { hasProjects: true, website: "https://stored.test" }, new Date());
    await env.DB.prepare("UPDATE repositories SET is_template = 1 WHERE id = 'repo-1'").run();
    const res = await basicsPost({
      repo_name: "demo.git", // invalid → the invalid outcome
      description: "carried body",
      private: "on",
      archived: "on", // the carried-but-dropped submission
      enable_packages: "on",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">repository name is not allowed: demo.git</div>');
    expect(html).toContain(">carried body</textarea>"); // the legacy carry holds
    expect(html).toContain('<input id="private" name="private" type="checkbox" checked=""/>'); // legacy carry
    // The wave-129 fields render the STORED states (hasProjects on; the
    // posted enable_packages dropped; template/archived off the repo row).
    expect(html).toContain('<input class="enable-system" name="enable_projects" type="checkbox" checked=""/>');
    expect(html).toContain('<input class="enable-system" name="enable_packages" type="checkbox"/>');
    expect(html).toContain('<input id="template" name="template" type="checkbox" checked=""/>');
    expect(html).toContain('<input id="archived" name="archived" type="checkbox"/>');
    expect(html).toContain('value="https://stored.test"/>');
    // Nothing was written (the pre-existing invalid-arm rule, now covering
    // the new write arms too): the stored row keeps its flags (hasProjects
    // on, the posted enable_packages dropped) and the repo row stands.
    expect(await storedRepoColumns()).toEqual({ is_template: 1, is_archived: 0 });
    expect(await storedUnitRow()).toEqual({ has_issues: 1, has_pull_requests: 1, has_releases: 1, has_projects: 1, has_packages: 0, has_actions: 0 });
  });

  it("the merged single POST applies the whole field set in one round-trip (upstream's two-form split reduced)", async () => {
    const res = await basicsPost({
      repo_name: "demo",
      description: "one post",
      website: "https://one.test",
      template: "on",
      enable_internal_tracker: "on",
      enable_packages: "on",
      enable_pulls: "on",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings");
    const settings = await loadRepoSettings(env.DB, repo.id);
    expect(settings.description).toBe("one post");
    expect(settings.website).toBe("https://one.test");
    expect(settings.hasIssues).toBe(true);
    expect(settings.hasPackages).toBe(true);
    expect(settings.hasPullRequests).toBe(true);
    expect(settings.hasProjects).toBe(false); // the unchecked box posts off
    expect(await storedRepoColumns()).toEqual({ is_template: 1, is_archived: 0 });
  });
});

// --- the route claim pin (parse ↔ registration — the settings-family pin) -------

describe("the route claim pin (the basics tail claims exactly the bare /settings)", () => {
  it("parses the GET/POST shape; deeper tails stay unclaimed or belong to the sibling families", () => {
    expect(parseUiRoute("/alice/demo/settings")).toEqual({ family: "settings", owner: "alice", repo: "demo" });
    expect(handlesUiRoute("/alice/demo/settings")).toBe(true);
    expect(parseUiRoute("/alice/demo/settings/extra")).toBeNull(); // no deeper tail for the basics
    expect(handlesUiRoute("/alice/demo/settings/extra")).toBe(false);
    // The sibling families claim their own literals (same module, other arms).
    expect(parseUiRoute("/alice/demo/settings/hooks")).toMatchObject({ family: "settings-hooks" });
    expect(parseUiRoute("/alice/demo/settings/mirror")).toMatchObject({ family: "settings-mirror" });
  });
});
