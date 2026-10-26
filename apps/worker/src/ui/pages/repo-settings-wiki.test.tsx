/**
 * The repo settings wiki panel's tests (the module MOUNTED since window-2d
 * 46e7e68 — GET+POST /{owner}/{repo}/settings/wiki at ui/index.ts): the
 * toggle's parse/apply matrix over real D1 (generated migrations in
 * beforeAll; the write goes through the landed `saveRepoSettings`, the same
 * store the PATCH arm writes and the wiki gate reads), the DOM contract of
 * the page render — hono/jsx renderToString — and the deferred matrix
 * driving the real routes (the githooks matrix's minted-session pattern):
 * the settingsGate posture (anonymous 303, signed-in non-admin 404 shell)
 * on GET and POST, the admin GET reflecting the stored enable state, the
 * POST→303 ?saved=1 round-trip with the flash + persisted state on the
 * follow-up GET, the honest-absence read-only lines through the route (no
 * dead inputs), the guard-first cross-origin 403, and the settings-family
 * claim pin.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { repositories, users } from "../../db/schema";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { Viewer } from "../viewer";
import {
  applyRepoWikiSettings,
  loadRepoWikiSettings,
  parseRepoWikiForm,
  renderRepoWikiSettingsPage,
  RepoWikiSettingsPage,
  wikiSettingsLocale,
  WikiSettingsNav,
} from "./repo-settings-wiki";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const selfViewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };

/** The render context with the seeded repo row plugged in (set by
 *  seedRepo). */
const ctx: UiContext = {
  viewer: selfViewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

let repo: RepoRow;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_settings", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  repo = await seedRepo("demo", "main");
});

async function seedRepo(slug: string, defaultBranch: string): Promise<RepoRow> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'alice', 1, ?, ?, 'public', unixepoch())",
  )
    .bind(slug, defaultBranch)
    .run();
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
  if (row === undefined) throw new Error("fixture repository missing");
  return row;
}

/** The page component under a ctx carrying the seeded repo. */
function PageForTest(props: { data: Awaited<ReturnType<typeof loadRepoWikiSettings>>; error: string | null; saved: boolean }) {
  return <RepoWikiSettingsPage ctx={{ ...ctx, repo }} data={props.data} error={props.error} saved={props.saved} />;
}

// --- the loader ---------------------------------------------------------------

describe("loadRepoWikiSettings (the PATCH arm's store, read side)", () => {
  it("absent settings row renders the upstream default — wiki enabled (DefaultRepoUnits)", async () => {
    const data = await loadRepoWikiSettings(env.DB, repo);
    expect(data.hasWiki).toBe(true);
    expect(data.defaultWikiBranch).toBe("main");
  });

  it("carries the stored flag and the repository's effective wiki branch", async () => {
    const { saveRepoSettings } = await import("../../api/services/repo-settings");
    await saveRepoSettings(env.DB, repo.id, { hasWiki: false }, new Date(T0 * 1000));
    await env.DB.prepare("UPDATE repositories SET default_branch = 'trunk' WHERE id = 'repo-1'").run();
    const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
    if (row === undefined) throw new Error("fixture repository missing");
    repo = row;

    const data = await loadRepoWikiSettings(env.DB, repo);
    expect(data.hasWiki).toBe(false);
    expect(data.defaultWikiBranch).toBe("trunk"); // wikiBranch(pair) = the repo default (services/wiki.ts:348)
  });
});

// --- the form parse ------------------------------------------------------------

describe("parseRepoWikiForm (options.tmpl's enable_wiki checkbox semantics)", () => {
  it("checked posts the field — true", () => {
    expect(parseRepoWikiForm(new URLSearchParams({ enable_wiki: "on" })).enableWiki).toBe(true);
  });

  it("unchecked posts ABSENT — false (the org-settings checkbox rule)", () => {
    expect(parseRepoWikiForm(new URLSearchParams()).enableWiki).toBe(false);
  });

  it("any present value counts (HTML checkbox semantics, not '1'/'on' parsing)", () => {
    expect(parseRepoWikiForm(new URLSearchParams({ enable_wiki: "1" })).enableWiki).toBe(true);
    expect(parseRepoWikiForm(new URLSearchParams({ enable_wiki: "" })).enableWiki).toBe(false);
  });
});

// --- the write -----------------------------------------------------------------

describe("applyRepoWikiSettings (routes/repo.ts:578's has_wiki write over saveRepoSettings)", () => {
  it("flips the stored flag off and back on", async () => {
    await applyRepoWikiSettings(env.DB, repo, { enableWiki: false });
    expect((await loadRepoSettings(env.DB, repo.id)).hasWiki).toBe(false);

    await applyRepoWikiSettings(env.DB, repo, { enableWiki: true });
    expect((await loadRepoSettings(env.DB, repo.id)).hasWiki).toBe(true);
  });

  it("is idempotent — a same-value toggle stays a valid upsert", async () => {
    await applyRepoWikiSettings(env.DB, repo, { enableWiki: true });
    await applyRepoWikiSettings(env.DB, repo, { enableWiki: true });
    expect((await loadRepoSettings(env.DB, repo.id)).hasWiki).toBe(true);
  });

  it("leaves the other stored settings intact (the merged-row upsert)", async () => {
    const { saveRepoSettings } = await import("../../api/services/repo-settings");
    await saveRepoSettings(env.DB, repo.id, { description: "kept" }, new Date(T0 * 1000));
    await applyRepoWikiSettings(env.DB, repo, { enableWiki: false });
    const settings = await loadRepoSettings(env.DB, repo.id);
    expect(settings.hasWiki).toBe(false);
    expect(settings.description).toBe("kept");
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the wiki panel DOM (options.tmpl:319-355 + 873-880 + 1046-1062 at the pin)", () => {
  it("renders the enable form: action, checkbox checked, update button", async () => {
    const data = await loadRepoWikiSettings(env.DB, repo);
    const html = renderToString(<PageForTest data={data} error={null} saved={false} />);
    expect(html).toContain("repository settings wiki"); // the §2.4.1 discriminator
    expect(html).toContain('action="/alice/demo/settings/wiki"');
    expect(html).toContain('method="post"');
    expect(html).toContain('id="enable_wiki" name="enable_wiki" type="checkbox" checked=""');
    expect(html).toContain(`>${wikiSettingsLocale.wiki_desc}</label>`);
    expect(html).toContain(`>${wikiSettingsLocale.update_settings}</button>`);
    // The full-document render path matches the component path.
    expect(renderRepoWikiSettingsPage({ ctx: { ...ctx, repo }, data, error: null, saved: false })).toContain(
      'action="/alice/demo/settings/wiki"',
    );
  });

  it("renders the checkbox unchecked after a disable", async () => {
    await applyRepoWikiSettings(env.DB, repo, { enableWiki: false });
    const data = await loadRepoWikiSettings(env.DB, repo);
    const html = renderToString(<PageForTest data={data} error={null} saved={false} />);
    expect(html).toContain('id="enable_wiki" name="enable_wiki" type="checkbox"/>');
    expect(html).not.toContain("checked=");
  });

  it("the unrendered arms render as read-only lines + the honest absence notes (no dead controls)", async () => {
    const data = await loadRepoWikiSettings(env.DB, repo);
    const html = renderToString(<PageForTest data={data} error={null} saved={false} />);
    // No radio, no external-URL input, no default-branch input: the landed
    // arms they would bind to do not exist (the module header).
    expect(html).not.toContain('name="enable_external_wiki"');
    expect(html).not.toContain('name="external_wiki_url"');
    expect(html).not.toContain('name="default_wiki_branch"');
    expect(html).not.toContain('type="url"');
    // The read-only reductions render.
    expect(html).toContain(wikiSettingsLocale.use_internal_wiki);
    expect(html).toContain(wikiSettingsLocale.flavor_note);
    expect(html).toContain("<p>main</p>");
    expect(html).toContain(wikiSettingsLocale.default_wiki_branch_name);
    expect(html).toContain(wikiSettingsLocale.branch_note);
  });

  it("the danger segment renders only while the wiki is enabled, with the absence note (no button, no modal)", async () => {
    const enabled = await loadRepoWikiSettings(env.DB, repo);
    const enabledHtml = renderToString(<PageForTest data={enabled} error={null} saved={false} />);
    expect(enabledHtml).toContain("ui top attached error header"); // options.tmpl:802-803's danger header pair
    expect(enabledHtml).toContain(wikiSettingsLocale.danger_zone);
    expect(enabledHtml).toContain(wikiSettingsLocale.wiki_delete);
    expect(enabledHtml).toContain(wikiSettingsLocale.wiki_delete_desc);
    expect(enabledHtml).toContain(wikiSettingsLocale.delete_unavailable);
    expect(enabledHtml).not.toContain("show-modal"); // the #delete-wiki-modal opener is not reproduced
    expect(enabledHtml).not.toContain("delete-wiki-modal");
    expect(enabledHtml).not.toContain('name="action" value="delete-wiki"');

    await applyRepoWikiSettings(env.DB, repo, { enableWiki: false });
    const disabled = await loadRepoWikiSettings(env.DB, repo);
    const disabledHtml = renderToString(<PageForTest data={disabled} error={null} saved={false} />);
    expect(disabledHtml).not.toContain(wikiSettingsLocale.wiki_delete);
    expect(disabledHtml).not.toContain("ui attached error danger segment");
  });

  it("the ?saved=1 flash renders the upstream success text; the error slot renders the negative message", async () => {
    const data = await loadRepoWikiSettings(env.DB, repo);
    const savedHtml = renderToString(<PageForTest data={data} error={null} saved={true} />);
    expect(savedHtml).toContain('class="ui info message"');
    expect(savedHtml).toContain(wikiSettingsLocale.update_settings_success);

    const errorHtml = renderToString(<PageForTest data={data} error="boom" saved={false} />);
    expect(errorHtml).toContain('class="ui negative message"');
    expect(errorHtml).toContain("boom");
  });

  it("the nav renders the six items with Wiki active (the mount scaffolding)", () => {
    const html = renderToString(<WikiSettingsNav repoLink="/alice/demo" />);
    expect(html).toContain('class="flex-container-nav"');
    expect(html).toContain('href="/alice/demo/settings"');
    expect(html).toContain('href="/alice/demo/settings/collaboration"');
    expect(html).toContain('href="/alice/demo/settings/hooks"');
    expect(html).toContain('href="/alice/demo/settings/branches"');
    expect(html).toContain('href="/alice/demo/settings/mirror"');
    expect(html).toContain('class="active item" href="/alice/demo/settings/wiki"');
  });

  it("throws without a resolved repo (the settings pages' ctx.repo contract)", async () => {
    const data = await loadRepoWikiSettings(env.DB, repo);
    expect(() =>
      renderToString(<RepoWikiSettingsPage ctx={ctx} data={data} error={null} saved={false} />),
    ).toThrow("RepoWikiSettingsPage requires ctx.repo");
  });

  it("the render entry throws the same way (the full-document render path)", async () => {
    const data = await loadRepoWikiSettings(env.DB, repo);
    expect(() => renderRepoWikiSettingsPage({ ctx, data, error: null, saved: false })).toThrow(
      "RepoWikiSettingsPage requires ctx.repo",
    );
  });
});

// --- the mounted-route harness (window-2d 46e7e68; the githooks-matrix
// --- minted-session pattern) ----------------------------------------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → resolveUiRequest →
 *  the settingsGate → load → render, on the mounted uiRouter with the
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
 *  sessions table, so a cross-test cache would go stale; the value is never
 *  rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** The seeded owner's minted session header — the repo-admin doer the
 *  settingsGate's isRepositoryAdmin admits (ids are seed-assigned — never
 *  hardcoded). */
async function ownerSessionHeader(): Promise<string> {
  const owner = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get();
  if (owner === undefined) throw new Error("fixture owner missing");
  return sessionHeader(owner.id);
}

/** A second plain user (the signed-in non-admin posture — the public repo
 *  resolves for the read, the admin gate 404-shells the tab). */
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

/** The admin's GET of the tab through the real route (the optional `search`
 *  carries the ?saved=1 flash param). */
async function wikiGet(search = ""): Promise<Response> {
  return fetchUi(`/alice/demo/settings/wiki${search}`, { headers: { cookie: await ownerSessionHeader() } });
}

/** The admin's urlencoded POST to the tab through the real route: the given
 *  Origin header (the §2.8 guard's input) and the owner's minted session
 *  cookie. An empty field set IS the disable post — the browser emits
 *  nothing for an unchecked checkbox. */
async function wikiPost(fields: Record<string, string> = {}, origin = ORIGIN): Promise<Response> {
  return fetchUi("/alice/demo/settings/wiki", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      cookie: await ownerSessionHeader(),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

// --- the mounted routes (window-2d: GET + POST /{owner}/{repo}/settings/wiki)

describe("the mounted routes (GET + POST /{owner}/{repo}/settings/wiki)", () => {
  it("303s an anonymous GET onto the login round-trip (the settingsGate)", async () => {
    const res = await fetchUi("/alice/demo/settings/wiki");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/alice/demo/settings/wiki")}`,
    );
  });

  it("303s an anonymous same-origin POST onto the login round-trip too (guard passes, then the gate; nothing written)", async () => {
    const res = await fetchUi("/alice/demo/settings/wiki", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
      },
      body: new URLSearchParams({ enable_wiki: "on" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/alice/demo/settings/wiki")}`,
    );
    expect((await loadRepoSettings(env.DB, repo.id)).hasWiki).toBe(true); // the absent-row default stands
  });

  it("404-shells a signed-in non-admin's GET (the settingsGate posture — the public repo resolves, the tab doesn't)", async () => {
    const bob = await seedNonAdmin("bob");
    const res = await fetchUi("/alice/demo/settings/wiki", { headers: { cookie: await sessionHeader(bob.id) } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error"); // the 404 shell
    expect(html).not.toContain("repository settings wiki"); // never the tab's content
  });

  it("404-shells a signed-in non-admin's POST before any write (the gate fronts the write arm too)", async () => {
    const bob = await seedNonAdmin("bob");
    const res = await fetchUi("/alice/demo/settings/wiki", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        cookie: await sessionHeader(bob.id),
      },
      body: "", // the disable post — must never be applied
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect((await loadRepoSettings(env.DB, repo.id)).hasWiki).toBe(true); // nothing was written
  });

  it("renders the admin's GET at 200 with the discriminator, the active navbar item and the stored enable state", async () => {
    const res = await wikiGet();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository settings wiki"); // the §2.4.1 pageClass
    expect(html).toContain('class="active item" href="/alice/demo/settings/wiki"');
    expect(html).toContain('id="enable_wiki" name="enable_wiki" type="checkbox" checked=""'); // the absent-row default: enabled
  });

  it("a disable POST 303s onto ?saved=1, the flag lands in D1, and the follow-up GET shows the flash and the unchecked box", async () => {
    const res = await wikiPost(); // no fields — the browser's unchecked-checkbox post
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings/wiki?saved=1");
    expect((await loadRepoSettings(env.DB, repo.id)).hasWiki).toBe(false); // the read-back
    const page = await wikiGet("?saved=1");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('class="ui info message"'); // the ?saved=1 flash
    expect(html).toContain(wikiSettingsLocale.update_settings_success);
    expect(html).toContain('id="enable_wiki" name="enable_wiki" type="checkbox"/>'); // the persisted state
    expect(html).not.toContain("checked=");
    expect(html).not.toContain("ui attached error danger segment"); // the disabled wiki has no danger segment
  });

  it("an enable POST round-trips the flag back on — the follow-up plain GET renders the checked box and no flash", async () => {
    await applyRepoWikiSettings(env.DB, repo, { enableWiki: false });
    const res = await wikiPost({ enable_wiki: "on" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings/wiki?saved=1");
    expect((await loadRepoSettings(env.DB, repo.id)).hasWiki).toBe(true);
    const page = await wikiGet(); // no ?saved=1 — the flash is param-gated
    const html = await page.text();
    expect(html).not.toContain('class="ui info message"');
    expect(html).toContain('id="enable_wiki" name="enable_wiki" type="checkbox" checked=""');
    expect(html).toContain("ui attached error danger segment"); // the danger segment is back with the wiki
  });

  it("renders the honest-absence read-only lines through the route and never a dead input", async () => {
    const res = await wikiGet();
    expect(res.status).toBe(200);
    const html = await res.text();
    // No radio pair, no external-URL input, no default-branch input, no
    // delete modal — the landed arms they would bind to do not exist.
    expect(html).not.toContain('name="enable_external_wiki"');
    expect(html).not.toContain('name="external_wiki_url"');
    expect(html).not.toContain('name="default_wiki_branch"');
    expect(html).not.toContain('type="url"');
    expect(html).not.toContain("show-modal");
    expect(html).not.toContain("delete-wiki-modal");
    // The read-only reductions render through the route.
    expect(html).toContain(wikiSettingsLocale.use_internal_wiki);
    expect(html).toContain(wikiSettingsLocale.flavor_note);
    expect(html).toContain("<p>main</p>"); // the effective branch (the repo default)
    expect(html).toContain(wikiSettingsLocale.default_wiki_branch_name);
    expect(html).toContain(wikiSettingsLocale.branch_note);
    expect(html).toContain(wikiSettingsLocale.delete_unavailable);
  });

  it("rejects a cross-origin POST with 403 before any write (sameOriginGuard first)", async () => {
    const res = await wikiPost({ enable_wiki: "" }, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect((await loadRepoSettings(env.DB, repo.id)).hasWiki).toBe(true); // nothing was written
  });
});

// --- the route claim pin (parse ↔ registration — the githooks-matrix pin) ---

describe("the route claim pin (the settings family claims exactly the wiki tab)", () => {
  it("parses the GET/POST shape; misspelled or deeper tails stay unclaimed", () => {
    expect(parseUiRoute("/alice/demo/settings/wiki")).toEqual({
      family: "settings-wiki",
      owner: "alice",
      repo: "demo",
    });
    expect(handlesUiRoute("/alice/demo/settings/wiki")).toBe(true);
    expect(parseUiRoute("/alice/demo/settings/wikis")).toBeNull(); // the plural misspelling
    expect(parseUiRoute("/alice/demo/settings/wiki/extra")).toBeNull();
    expect(handlesUiRoute("/alice/demo/settings/wiki/extra")).toBe(false);
  });
});
