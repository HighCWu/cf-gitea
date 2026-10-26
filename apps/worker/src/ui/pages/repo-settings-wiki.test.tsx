/**
 * The repo settings wiki panel's tests (the bench-row UNMOUNTED module —
 * the activity-feeds.test.tsx harness): the toggle's parse/apply matrix over
 * real D1 (generated migrations in beforeAll; the write goes through the
 * landed `saveRepoSettings`, the same store the PATCH arm writes and the
 * wiki gate reads) and the DOM contract of the page render — hono/jsx
 * renderToString, the module driven directly (no route yet, the HANDOFF
 * NOTE in the module header).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { repositories } from "../../db/schema";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
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
