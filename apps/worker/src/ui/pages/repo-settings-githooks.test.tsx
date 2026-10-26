/**
 * The repo settings git-hooks tab's tests (the bench-row UNMOUNTED module —
 * the repo-settings-wiki.test.tsx harness): the loader/write matrix over the
 * REAL REPO_PACKS bucket (the githooks/ prefix — routes/git-hooks.test.ts's
 * cleanup loop) and the DOM contract of both pages — hono/jsx
 * renderToString, the module driven directly (no route yet, the HANDOFF
 * NOTE in the module header).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { PRE_RECEIVE_SAMPLE, UPDATE_SAMPLE } from "../../api/routes/git-hooks";
import { repositories } from "../../db/schema";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  applyRepoGitHook,
  GitHooksSettingsNav,
  gitHooksSettingsLocale,
  loadRepoGitHookEdit,
  loadRepoGitHooks,
  parseRepoGitHookForm,
  renderRepoGitHookEditPage,
  renderRepoGitHooksListPage,
  RepoGitHookEditPage,
  RepoGitHooksPage,
} from "./repo-settings-githooks";

// --- fixtures ----------------------------------------------------------------

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
  for (const table of ["repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The githooks/ prefix of the shared bucket — this module's whole key
  // space (routes/git-hooks.test.ts's cleanup loop).
  let cursor: string | undefined;
  do {
    const page = await env.REPO_PACKS.list({ prefix: "githooks/", cursor });
    for (const object of page.objects) {
      await env.REPO_PACKS.delete(object.key);
    }
    cursor = page.truncated === true ? page.cursor : undefined;
  } while (cursor !== undefined);
  repo = await seedRepo("demo");
});

async function seedRepo(slug: string): Promise<RepoRow> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'alice', 1, ?, 'main', 'public', unixepoch())",
  )
    .bind(slug)
    .run();
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
  if (row === undefined) throw new Error("fixture repository missing");
  return row;
}

/** The stored object's text (null when the key is absent — the inactive
 *  state). */
async function storedHook(name: string): Promise<string | null> {
  const object = await env.REPO_PACKS.get(`githooks/repo-1/${name}`);
  if (object === null) return null;
  return await object.text();
}

/** The list page component under a ctx carrying the seeded repo. */
function ListForTest(props: { data: Awaited<ReturnType<typeof loadRepoGitHooks>> }) {
  return <RepoGitHooksPage ctx={{ ...ctx, repo }} data={props.data} />;
}

/** The edit page component under a ctx carrying the seeded repo. */
function EditForTest(props: { data: Awaited<ReturnType<typeof loadRepoGitHookEdit>> }) {
  if (props.data === null) throw new Error("fixture hook missing");
  return <RepoGitHookEditPage ctx={{ ...ctx, repo }} data={props.data} />;
}

// --- the loader (list) ---------------------------------------------------------

describe("loadRepoGitHooks (the repoListGitHooks read arm's page twin)", () => {
  it("renders the fixed three-name set in hookNames order, inactive on a fresh bucket", async () => {
    const data = await loadRepoGitHooks(env.REPO_PACKS, repo);
    expect(data.hooks.map((hook) => hook.name)).toEqual(["pre-receive", "update", "post-receive"]);
    expect(data.hooks.every((hook) => !hook.isActive)).toBe(true);
  });

  it("a persisted edit flips exactly its own hook active", async () => {
    await applyRepoGitHook(env.REPO_PACKS, repo, "update", { content: "#!/bin/sh\ntrue\n" });
    const data = await loadRepoGitHooks(env.REPO_PACKS, repo);
    expect(data.hooks.find((hook) => hook.name === "update")?.isActive).toBe(true);
    expect(data.hooks.find((hook) => hook.name === "pre-receive")?.isActive).toBe(false);
    expect(data.hooks.find((hook) => hook.name === "post-receive")?.isActive).toBe(false);
  });
});

// --- the loader (edit) -----------------------------------------------------------

describe("loadRepoGitHookEdit (the repoGetGitHook read arm's page twin)", () => {
  it("an inactive hook prefills the git sample — pre-receive and update", async () => {
    const pre = await loadRepoGitHookEdit(env.REPO_PACKS, repo, "pre-receive");
    expect(pre).not.toBeNull();
    expect(pre?.isActive).toBe(false);
    expect(pre?.content).toBe(PRE_RECEIVE_SAMPLE);

    const update = await loadRepoGitHookEdit(env.REPO_PACKS, repo, "update");
    expect(update?.isActive).toBe(false);
    expect(update?.content).toBe(UPDATE_SAMPLE);
  });

  it("an inactive post-receive prefills EMPTY — modern git ships no post-receive sample (divergence 2)", async () => {
    const post = await loadRepoGitHookEdit(env.REPO_PACKS, repo, "post-receive");
    expect(post?.isActive).toBe(false);
    expect(post?.content).toBe("");
  });

  it("an active hook prefills the stored content (the \\r-stripped copy)", async () => {
    await applyRepoGitHook(env.REPO_PACKS, repo, "pre-receive", { content: "#!/bin/sh\r\necho hello\r\n" });
    const data = await loadRepoGitHookEdit(env.REPO_PACKS, repo, "pre-receive");
    expect(data?.isActive).toBe(true);
    expect(data?.content).toBe("#!/bin/sh\necho hello\n");
  });

  it("a non-vocabulary name is the 404 shell seam — unknown and case-mismatched", async () => {
    expect(await loadRepoGitHookEdit(env.REPO_PACKS, repo, "commit-msg")).toBeNull();
    expect(await loadRepoGitHookEdit(env.REPO_PACKS, repo, "Pre-Receive")).toBeNull();
  });
});

// --- the write -------------------------------------------------------------------

describe("applyRepoGitHook (GitHooksEditPost over hook.Update()'s arms)", () => {
  it("stores the \\r-stripped copy at githooks/<repoId>/<name> (hook.go:83-93)", async () => {
    await applyRepoGitHook(env.REPO_PACKS, repo, "update", { content: "#!/bin/sh\r\necho one\r\necho two\r\n" });
    expect(await storedHook("update")).toBe("#!/bin/sh\necho one\necho two\n");
  });

  it("whitespace-empty content DISABLES — the object is removed (hook.go:74-82)", async () => {
    await applyRepoGitHook(env.REPO_PACKS, repo, "pre-receive", { content: "#!/bin/sh\ntrue\n" });
    expect(await storedHook("pre-receive")).not.toBeNull();

    await applyRepoGitHook(env.REPO_PACKS, repo, "pre-receive", { content: "   \n\t  " });
    expect(await storedHook("pre-receive")).toBeNull();
  });

  it("an absent content field binds to Go's zero \"\" — the same disable arm", async () => {
    await applyRepoGitHook(env.REPO_PACKS, repo, "pre-receive", { content: "#!/bin/sh\ntrue\n" });
    await applyRepoGitHook(env.REPO_PACKS, repo, "pre-receive", parseRepoGitHookForm(new URLSearchParams()));
    expect(await storedHook("pre-receive")).toBeNull();
  });

  it("disabling an ALREADY-inactive hook is a no-op (the R2 delete of an absent key)", async () => {
    await applyRepoGitHook(env.REPO_PACKS, repo, "post-receive", { content: "" });
    expect(await storedHook("post-receive")).toBeNull();
  });

  it("a non-vocabulary name throws (the handlers' ErrNotValidHook arm)", async () => {
    await expect(applyRepoGitHook(env.REPO_PACKS, repo, "commit-msg", { content: "x" })).rejects.toThrow(
      "not a valid Git hook",
    );
  });
});

// --- the form parse ----------------------------------------------------------------

describe("parseRepoGitHookForm (githook_edit.tmpl's content field)", () => {
  it("carries the posted content verbatim", () => {
    expect(parseRepoGitHookForm(new URLSearchParams({ content: "#!/bin/sh\ntrue\n" })).content).toBe(
      "#!/bin/sh\ntrue\n",
    );
  });

  it("an absent field is \"\" (the disable arm's bind)", () => {
    expect(parseRepoGitHookForm(new URLSearchParams()).content).toBe("");
  });
});

// --- the DOM (list) ------------------------------------------------------------------

describe("the list page DOM (githooks.tmpl at the pin)", () => {
  it("renders the pageClass discriminator, header, desc and the three rows with dot + pencil", async () => {
    await applyRepoGitHook(env.REPO_PACKS, repo, "pre-receive", { content: "#!/bin/sh\ntrue\n" });
    const data = await loadRepoGitHooks(env.REPO_PACKS, repo);
    const html = renderToString(<ListForTest data={data} />);
    expect(html).toContain("repository settings githooks"); // the §2.4.1 discriminator
    expect(html).toContain(`>${gitHooksSettingsLocale.githooks}</h4>`);
    expect(html).toContain(gitHooksSettingsLocale.githooks_desc);
    expect(html).toContain('<div class="divider"></div>');
    // The IsActive dot classes (githooks.tmpl:12's two-class mapping).
    expect(html).toContain('class="tw-text-green"');
    expect(html).toContain('class="tw-text-text-light"');
    for (const name of ["pre-receive", "update", "post-receive"]) {
      expect(html).toContain(`<span class="gt-ellipsis tw-flex-1">${name}</span>`);
      expect(html).toContain(`href="/alice/demo/settings/hooks/git/${name}"`);
    }
    expect(html).toContain('class="muted tw-pr-2"');
    // The full-document render path matches the component path.
    expect(renderRepoGitHooksListPage({ ctx: { ...ctx, repo }, data })).toContain("repository settings githooks");
  });
});

// --- the DOM (edit) --------------------------------------------------------------------

describe("the edit page DOM (githook_edit.tmpl at the pin)", () => {
  it("renders the form onto the hook's own URL with the sample prefill and Update Hook submit", async () => {
    const data = await loadRepoGitHookEdit(env.REPO_PACKS, repo, "pre-receive");
    if (data === null) throw new Error("fixture hook missing");
    const html = renderToString(<EditForTest data={data} />);
    expect(html).toContain("repository settings edit githook"); // the §2.4.1 discriminator
    expect(html).toContain('action="/alice/demo/settings/hooks/git/pre-receive"');
    expect(html).toContain('method="post"');
    expect(html).toContain('id="content" name="content"');
    expect(html).toContain(`placeholder="${gitHooksSettingsLocale.editor_placeholder}"`);
    // The sample prefill, verbatim (an escaping-free snippet of it — hono/jsx
    // SSR escapes & < > " in textarea text, so the sample's quotes and >&2
    // redirects render as entities).
    expect(html).toContain("An example hook script to make use of push options.");
    expect(html).toContain(`>${gitHooksSettingsLocale.update_githook}</button>`);
    // The full-document render path matches the component path.
    expect(renderRepoGitHookEditPage({ ctx: { ...ctx, repo }, data })).toContain("repository settings edit githook");
  });

  it("an ACTIVE hook's textarea carries the stored content, not the sample", async () => {
    await applyRepoGitHook(env.REPO_PACKS, repo, "update", { content: "#!/bin/sh\necho custom\n" });
    const data = await loadRepoGitHookEdit(env.REPO_PACKS, repo, "update");
    if (data === null) throw new Error("fixture hook missing");
    const html = renderToString(<EditForTest data={data} />);
    expect(html).toContain("echo custom");
    expect(html).not.toContain("to block unannotated tags from entering");
  });

  it("renders the hook name in the h4 header (upstream {{.Hook.Name}})", async () => {
    const data = await loadRepoGitHookEdit(env.REPO_PACKS, repo, "post-receive");
    if (data === null) throw new Error("fixture hook missing");
    const html = renderToString(<EditForTest data={data} />);
    expect(html).toContain("flex-left-right");
    expect(html).toContain(">post-receive</h4>");
  });
});

// --- the DOM (nav + ctx contract) -------------------------------------------------------

describe("the nav scaffold and the ctx.repo contract", () => {
  it("the nav renders the reduced settings items with Git Hooks active (the mount scaffolding)", () => {
    const html = renderToString(<GitHooksSettingsNav repoLink="/alice/demo" />);
    expect(html).toContain('class="flex-container-nav"');
    expect(html).toContain('href="/alice/demo/settings"');
    expect(html).toContain('href="/alice/demo/settings/collaboration"');
    expect(html).toContain('href="/alice/demo/settings/hooks"');
    expect(html).toContain('href="/alice/demo/settings/branches"');
    // Upstream navbar.tmpl:34-38's item — after Branches, before Mirror, active.
    expect(html).toContain('class="active item" href="/alice/demo/settings/hooks/git"');
    expect(html).toContain(`>${gitHooksSettingsLocale.githooks}</a>`);
    expect(html).toContain('href="/alice/demo/settings/mirror"');
  });

  it("throws without a resolved repo (the settings pages' ctx.repo contract)", async () => {
    const list = await loadRepoGitHooks(env.REPO_PACKS, repo);
    expect(() => renderToString(<RepoGitHooksPage ctx={ctx} data={list} />)).toThrow(
      "RepoGitHooksPage requires ctx.repo",
    );
    const edit = await loadRepoGitHookEdit(env.REPO_PACKS, repo, "pre-receive");
    expect(edit).not.toBeNull();
    expect(() => renderToString(<RepoGitHookEditPage ctx={ctx} data={edit as NonNullable<typeof edit>} />)).toThrow(
      "RepoGitHookEditPage requires ctx.repo",
    );
    expect(() => renderRepoGitHooksListPage({ ctx, data: list })).toThrow("RepoGitHooksPage requires ctx.repo");
  });
});
