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
  for (const table of ["repo_redirects", "repo_settings", "repositories", "users"]) {
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
