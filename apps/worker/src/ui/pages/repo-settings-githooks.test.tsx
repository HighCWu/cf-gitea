/**
 * The repo settings git-hooks tab's tests (the module MOUNTED since window-2d
 * b54f709 — GET /settings/hooks/git, GET+POST /settings/hooks/git/{name} at
 * ui/index.ts): the loader/write matrix over the REAL REPO_PACKS bucket (the
 * githooks/ prefix — routes/git-hooks.test.ts's cleanup loop) and the DOM
 * contract of both pages — hono/jsx renderToString. The deferred-test matrix
 * also drives the real routes (the org-settings-blocked matrix's
 * minted-session pattern): the settingsGate posture (anonymous 303, signed-in
 * non-admin 404 shell) on GET and POST, the admin list + per-name edit
 * renders through the real handlers, the ErrNotValidHook 404, the
 * POST→303 write with the R2 read-back, the guard-first cross-origin 403,
 * and the hooks/git ↔ numeric hooks/{id} claim pin.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { PRE_RECEIVE_SAMPLE, UPDATE_SAMPLE } from "../../api/routes/git-hooks";
import { repositories, repoSettings, users } from "../../db/schema";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { Viewer } from "../viewer";
import {
  applyRepoGitHook,
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

describe("the nav and the ctx.repo contract", () => {
  it("the pages render SettingsNav's reduced settings items with Git Hooks active (the nav fold: the GitHooksSettingsNav scaffold is deleted — wave-settingsnav-fold)", async () => {
    // The list page's nav carries the item set; the edit page renders the
    // same component with the same active value.
    const data = await loadRepoGitHooks(env.REPO_PACKS, repo);
    const html = renderToString(<ListForTest data={data} />);
    expect(html).toContain('class="flex-container-nav"');
    expect(html).toContain('href="/alice/demo/settings"');
    expect(html).toContain('href="/alice/demo/settings/collaboration"');
    expect(html).toContain('href="/alice/demo/settings/hooks"');
    expect(html).toContain('href="/alice/demo/settings/branches"');
    // Upstream navbar.tmpl:34-38's item — the code-unit block (Branches →
    // Tags → Git Hooks → Keys), before Mirror, active.
    expect(html).toContain('class="active item" href="/alice/demo/settings/hooks/git"');
    expect(html).toContain(`>${gitHooksSettingsLocale.githooks}</a>`);
    expect(html).toContain('href="/alice/demo/settings/mirror"');
    const edit = await loadRepoGitHookEdit(env.REPO_PACKS, repo, "pre-receive");
    expect(edit).not.toBeNull();
    const editHtml = renderToString(<EditForTest data={edit} />);
    expect(editHtml).toContain('class="active item" href="/alice/demo/settings/hooks/git"');
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

  it("lights the nav's Actions block only while the loaded hasActions flag is set (navbar.tmpl:47's unit conditional — the hasActions threading)", async () => {
    // The loaders' D1 seam: omitted = the store-default false (the reduced
    // nav — the ui/index.ts producer handoff pending), supplied = the row's
    // flag (the seeded store has none → false).
    expect((await loadRepoGitHooks(env.REPO_PACKS, repo)).hasActions).toBe(false);
    expect((await loadRepoGitHooks(env.REPO_PACKS, repo, env.DB)).hasActions).toBe(false);
    const edit = await loadRepoGitHookEdit(env.REPO_PACKS, repo, "pre-receive", env.DB);
    expect(edit).not.toBeNull();
    expect(edit!.hasActions).toBe(false);
    const db = drizzle(env.DB);
    await db.insert(repoSettings).values({ repoId: repo.id, hasActions: true }).onConflictDoNothing();
    try {
      expect((await loadRepoGitHooks(env.REPO_PACKS, repo, env.DB)).hasActions).toBe(true);
      const armedEdit = await loadRepoGitHookEdit(env.REPO_PACKS, repo, "pre-receive", env.DB);
      expect(armedEdit).not.toBeNull();
      expect(armedEdit!.hasActions).toBe(true);
      const html = renderToString(<ListForTest data={await loadRepoGitHooks(env.REPO_PACKS, repo, env.DB)} />);
      expect(html).toContain('href="/alice/demo/settings/actions/secrets"');
      expect(html).toContain('href="/alice/demo/settings/actions/variables"');
      // The reduced default: the d1-less data renders no block.
      const reduced = renderToString(<ListForTest data={await loadRepoGitHooks(env.REPO_PACKS, repo)} />);
      expect(reduced).not.toContain("/settings/actions/secrets");
      expect(reduced).not.toContain("/settings/actions/variables");
    } finally {
      await db.delete(repoSettings).where(eq(repoSettings.repoId, repo.id));
    }
  });
});

// --- the mounted-route harness (window-2d b54f709; the org-blocked-matrix
// --- minted-session pattern) ---------------------------------------------

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

/** The admin's GET of the list tab through the real route. */
async function githooksListGet(): Promise<Response> {
  return fetchUi("/alice/demo/settings/hooks/git", { headers: { cookie: await ownerSessionHeader() } });
}

/** The admin's GET of one hook's edit page through the real route. */
async function githookEditGet(name: string): Promise<Response> {
  return fetchUi(`/alice/demo/settings/hooks/git/${name}`, { headers: { cookie: await ownerSessionHeader() } });
}

/** The admin's urlencoded POST to one hook's edit URL through the real
 *  route: the given Origin header (the §2.8 guard's input) and the owner's
 *  minted session cookie. */
async function githookPost(name: string, fields: Record<string, string>, origin = ORIGIN): Promise<Response> {
  return fetchUi(`/alice/demo/settings/hooks/git/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      cookie: await ownerSessionHeader(),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

// --- the mounted routes (window-2d: GET /settings/hooks/git, GET+POST /settings/hooks/git/{name})

describe("the mounted list route (GET /{owner}/{repo}/settings/hooks/git)", () => {
  it("303s an anonymous GET onto the login round-trip (the settingsGate)", async () => {
    const res = await fetchUi("/alice/demo/settings/hooks/git");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/alice/demo/settings/hooks/git")}`,
    );
  });

  it("303s an anonymous same-origin edit POST onto the login round-trip too (guard passes, then the gate; nothing written)", async () => {
    const res = await fetchUi("/alice/demo/settings/hooks/git/update", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
      },
      body: new URLSearchParams({ content: "#!/bin/sh\ntrue\n" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/alice/demo/settings/hooks/git/update")}`,
    );
    expect(await storedHook("update")).toBeNull();
  });

  it("404-shells a signed-in non-admin's GET (the reqRepoAdmin posture — the public repo resolves, the tab doesn't)", async () => {
    const bob = await seedNonAdmin("bob");
    const res = await fetchUi("/alice/demo/settings/hooks/git", { headers: { cookie: await sessionHeader(bob.id) } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error"); // the 404 shell
    expect(html).not.toContain("repository settings githooks"); // never the tab's content
  });

  it("404-shells a signed-in non-admin's edit POST before any write (the gate fronts the write arm too)", async () => {
    const bob = await seedNonAdmin("bob");
    const res = await fetchUi("/alice/demo/settings/hooks/git/update", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        cookie: await sessionHeader(bob.id),
      },
      body: new URLSearchParams({ content: "#!/bin/sh\nbob was here\n" }).toString(),
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(await storedHook("update")).toBeNull(); // nothing was written
  });

  it("renders the admin's GET at 200 with the discriminator, the active nav item and the three rows", async () => {
    const res = await githooksListGet();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository settings githooks"); // the §2.4.1 pageClass
    expect(html).toContain('class="active item" href="/alice/demo/settings/hooks/git"');
    for (const name of ["pre-receive", "update", "post-receive"]) {
      expect(html).toContain(`href="/alice/demo/settings/hooks/git/${name}"`);
    }
    // The fresh bucket's three neutral dots — none active.
    expect((html.match(/class="tw-text-text-light"/g) ?? []).length).toBe(3);
    expect(html).not.toContain('class="tw-text-green"');
  });
});

describe("the mounted edit route (GET /{owner}/{repo}/settings/hooks/git/{name})", () => {
  for (const name of ["pre-receive", "update", "post-receive"]) {
    it(`renders ${name}'s edit form at 200 (the action onto the hook's own URL, the h4 header)`, async () => {
      const res = await githookEditGet(name);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("repository settings edit githook"); // the §2.4.1 pageClass
      expect(html).toContain(`action="/alice/demo/settings/hooks/git/${name}"`);
      expect(html).toContain(`>${name}</h4>`);
      expect(html).toContain('id="content" name="content"');
    });
  }

  it("renders an ACTIVE hook's stored content through the route, not the sample", async () => {
    await applyRepoGitHook(env.REPO_PACKS, repo, "update", { content: "#!/bin/sh\necho route-active\n" });
    const res = await githookEditGet("update");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("echo route-active");
    expect(html).not.toContain("to block unannotated tags from entering");
  });

  it("404-shells an invalid name — ErrNotValidHook → the 404 shell, not a render", async () => {
    const res = await githookEditGet("commit-msg");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error");
    expect(html).not.toContain("repository settings edit githook");
  });
});

describe("the mounted edit write (POST /{owner}/{repo}/settings/hooks/git/{name})", () => {
  it("303s back onto the list, the R2 content lands \\r-stripped (read-back), and the follow-up GET shows one active dot", async () => {
    const res = await githookPost("update", { content: "#!/bin/sh\r\necho route-written\r\n" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings/hooks/git");
    expect(await storedHook("update")).toBe("#!/bin/sh\necho route-written\n"); // the read-back
    const page = await githooksListGet();
    expect(page.status).toBe(200);
    const html = await page.text();
    expect((html.match(/class="tw-text-green"/g) ?? []).length).toBe(1); // exactly update's dot
    expect((html.match(/class="tw-text-text-light"/g) ?? []).length).toBe(2);
  });

  it("an empty-content POST disables through the route — the object is removed", async () => {
    await githookPost("pre-receive", { content: "#!/bin/sh\ntrue\n" });
    expect(await storedHook("pre-receive")).not.toBeNull();
    const res = await githookPost("pre-receive", { content: "" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings/hooks/git");
    expect(await storedHook("pre-receive")).toBeNull();
  });

  it("a POST to an invalid name 404-shells before any write (the ErrNotValidHook arm fronts the write)", async () => {
    const res = await githookPost("commit-msg", { content: "#!/bin/sh\nnope\n" });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(await storedHook("commit-msg")).toBeNull();
  });

  it("rejects a cross-origin POST with 403 before any write (sameOriginGuard first)", async () => {
    const res = await githookPost("update", { content: "#!/bin/sh\nevil\n" }, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await storedHook("update")).toBeNull(); // nothing was written
  });
});

// --- the route claim pin (parse ↔ registration — the org-blocked-matrix pin) ----

describe("the route claim pin (hooks/git vs the numeric hooks/{id} family — disjoint)", () => {
  it("parses the githooks shapes; the numeric family keeps its own tail", () => {
    expect(parseUiRoute("/alice/demo/settings/hooks/git")).toEqual({
      family: "settings-githooks",
      owner: "alice",
      repo: "demo",
    });
    expect(handlesUiRoute("/alice/demo/settings/hooks/git")).toBe(true);
    expect(parseUiRoute("/alice/demo/settings/hooks/git/pre-receive")).toEqual({
      family: "settings-githook",
      owner: "alice",
      repo: "demo",
      name: "pre-receive",
    });
    // The numeric family's own tail stays its own — "git" fails the numeric
    // guard, and the id tail never leaks into the githook families.
    expect(parseUiRoute("/alice/demo/settings/hooks/5")).toEqual({
      family: "settings-hook-detail",
      owner: "alice",
      repo: "demo",
      id: 5,
    });
  });

  it("hooks/git/5 is never claimed by the numeric family — the githook name tail takes it and 404-shells", async () => {
    const parsed = parseUiRoute("/alice/demo/settings/hooks/git/5");
    expect(parsed).not.toBeNull();
    expect(parsed?.family).not.toBe("settings-hook-detail");
    expect(parsed).toEqual({ family: "settings-githook", owner: "alice", repo: "demo", name: "5" });
    // Through the route: the non-vocabulary "5" 404-shells, nothing written.
    const res = await githookEditGet("5");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(await storedHook("5")).toBeNull();
  });
});
