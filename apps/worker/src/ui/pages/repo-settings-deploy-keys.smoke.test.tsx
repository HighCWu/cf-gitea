/**
 * The repo settings deploy-keys tab's tests (PORT-FIRST — one happy path per
 * arm, the repo-settings-githooks.test.tsx harness; the module MOUNTED since
 * window-2d b54f709 — GET+POST /{owner}/{repo}/settings/keys + POST
 * /{owner}/{repo}/settings/keys/delete at ui/index.ts): the list page renders
 * seeded keys, the add creates, the delete removes — the module driven
 * directly over real D1. The deferred-test matrix also drives the real routes
 * (the org-settings-blocked matrix's minted-session pattern): the
 * settingsGate posture (anonymous 303, signed-in non-admin 404 shell) on GET
 * and both POSTs before any write, the admin add round-trip (303 + the row +
 * the follow-up GET), the exact wired 422 on invalid content with the
 * carried-form re-render, the idempotent delete hit/miss (both 303), the
 * guard-first cross-origin 403, and the read-only vs writable rows through
 * the is_writable checkbox.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { deployKeys, repositories, users } from "../../db/schema";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { Viewer } from "../viewer";
import {
  addDeployKeyFromForm,
  deleteDeployKeyFromForm,
  deployKeysSettingsLocale,
  loadRepoDeployKeys,
  parseDeployKeyDeleteForm,
  parseDeployKeyForm,
  RepoDeployKeysPage,
  renderRepoDeployKeysPage,
} from "./repo-settings-deploy-keys";

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
  for (const table of ["deploy_keys", "public_keys", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
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

/** Test key material — the deploy-keys route suite's pinned pair (the
 *  fingerprints are fixed through the shared parser). */
const ED25519_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICQgLhusngED6SvOcMDWHg9wVjgOJ4QTN77gPol4OtTU ed25519-comment user@host";
const ED25519_FINGERPRINT = "SHA256:nBIbxZfae58Hod5zlVgetQGtfn2OhEymkNryw9sEXR8";
const RSA_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC3sBogtkFTvHdp6XkAThDF9Xqbfri5C/mGWrH4vnwBhnWFULjS5Kcu9Sk1Rz0FsCvnsEG9Fnbkaq9g28Wv7QZZsWmkC+UfvSoMVIt3koKLYwweRv3do/TzL/2KT5BBGTSCUGeotpkP8znF3fK6xi7A7zf9cBzfL8P2tNnLR+XqgGfVuRFjVXd2wjjtpEhOHLK4BIncKpoI6TgIHwFayxH+DrNQDTjpCw7NWef5jsstb0ICBRQti5QNc+uYm1qQPDTsZ8ZlljnOxy/4Au6aPXpq2jUHQWfBFy+IrVeVEoGIacrBMK5aAjS/aHDIKDVql0km8r8BMFlfNDD/Lff5v59f";
const RSA_FINGERPRINT = "SHA256:I5plbz5CJDzZiBSGXjZBVDpAS8c0FI3jzxrjbQSfaaU";

/** The list page component under a ctx carrying the seeded repo. */
function PageForTest(props: { data: Awaited<ReturnType<typeof loadRepoDeployKeys>>; error?: { message: string; field?: "title" | "content" } | null }) {
  return <RepoDeployKeysPage ctx={{ ...ctx, repo }} data={props.data} error={props.error ?? null} />;
}

// --- the list arm ---------------------------------------------------------------

describe("the list arm (loadRepoDeployKeys + deploy_key_list.tmpl)", () => {
  it("renders seeded keys with the read-only/writable and fingerprint rows", async () => {
    await addDeployKeyFromForm(env.DB, repo, { title: "deploy-readonly", content: ED25519_KEY, isWritable: false });
    await addDeployKeyFromForm(env.DB, repo, { title: "deploy-writable", content: RSA_KEY, isWritable: true });
    const data = await loadRepoDeployKeys(env.DB, repo);
    expect(data.keys.map((key) => key.row.name)).toEqual(["deploy-readonly", "deploy-writable"]); // the op's name order

    const html = renderToString(<PageForTest data={data} />);
    expect(html).toContain("repository settings"); // the §2.4.1 discriminator (the layout_head literal)
    expect(html).toContain(`>${deployKeysSettingsLocale.deploy_keys}</h4>`);
    // The add form (rendered open — the no-JS reduction) onto the page's own URL.
    expect(html).toContain('action="/alice/demo/settings/keys"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="title"');
    expect(html).toContain('name="content"');
    expect(html).toContain('name="is_writable" value="1"');
    // One row per key: title, fingerprint, added-on, no recent activity.
    expect(html).toContain("<div class=\"item-title\">deploy-readonly</div>");
    expect(html).toContain(`<div class="item-body">${ED25519_FINGERPRINT}</div>`);
    expect(html).toContain(`<div class="item-body">${RSA_FINGERPRINT}</div>`);
    expect(html).toContain(deployKeysSettingsLocale.added_on);
    expect(html).toContain(deployKeysSettingsLocale.no_activity);
    // The read-only vs writable distinction (deploy_key_list.tmpl:25-26).
    expect(html).toContain("Read · Write");
    expect(html).not.toContain("Read · Write · Write");
    // The delete forms ride the id-keyed POST tail.
    expect(html).toContain('action="/alice/demo/settings/keys/delete"');
    expect(html).toContain(`>${deployKeysSettingsLocale.remove}</button>`);
    // The full-document render path matches the component path.
    expect(renderRepoDeployKeysPage({ ctx: { ...ctx, repo }, data, error: null })).toContain("repository settings");
  });
});

// --- the add arm ------------------------------------------------------------------

describe("the add arm (addDeployKeyFromForm — DeployKeysPost over addDeployKeySsh)", () => {
  it("creates the deploy key and the reloaded page lists it", async () => {
    const form = parseDeployKeyForm(new URLSearchParams({ title: "ci-bot", content: ED25519_KEY }));
    const result = await addDeployKeyFromForm(env.DB, repo, form);
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.label).toBe("ci-bot");

    const rows = await drizzle(env.DB).select().from(deployKeys).where(eq(deployKeys.repoId, repo.id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("ci-bot");
    expect(rows[0]!.mode).toBe(1); // read-only default (is_writable unchecked)

    const data = await loadRepoDeployKeys(env.DB, repo);
    const html = renderToString(<PageForTest data={data} />);
    expect(html).toContain("ci-bot");
  });
});

// --- the delete arm -----------------------------------------------------------------

describe("the delete arm (deleteDeployKeyFromForm — DeleteDeployKey)", () => {
  it("removes the deploy key and the reloaded page shows the empty state", async () => {
    const added = await addDeployKeyFromForm(env.DB, repo, { title: "gone-soon", content: ED25519_KEY, isWritable: false });
    if (added.outcome !== "created") throw new Error("fixture key missing");
    const rows = await drizzle(env.DB).select().from(deployKeys).where(eq(deployKeys.repoId, repo.id)).all();
    const form = parseDeployKeyDeleteForm(new URLSearchParams({ id: String(rows[0]!.id) }));

    expect(await deleteDeployKeyFromForm(env.DB, repo, form)).toBe("deleted");
    expect(await drizzle(env.DB).select().from(deployKeys).where(eq(deployKeys.repoId, repo.id)).all()).toHaveLength(0);

    const data = await loadRepoDeployKeys(env.DB, repo);
    const html = renderToString(<PageForTest data={data} />);
    expect(html).toContain(deployKeysSettingsLocale.no_deploy_keys);
    expect(html).not.toContain("gone-soon");
  });
});

// --- the nav (the fold) ---------------------------------------------------------------

describe("the nav (SettingsNav through the page — the DeployKeysSettingsNav scaffold is deleted)", () => {
  it("renders the reduced settings items with Deploy Keys active (the nav fold — wave-settingsnav-fold)", async () => {
    const data = await loadRepoDeployKeys(env.DB, repo);
    const html = renderToString(<PageForTest data={data} />);
    expect(html).toContain('class="flex-container-nav"');
    expect(html).toContain('href="/alice/demo/settings"');
    expect(html).toContain('href="/alice/demo/settings/collaboration"');
    expect(html).toContain('href="/alice/demo/settings/hooks"');
    expect(html).toContain('href="/alice/demo/settings/branches"');
    // upstream navbar.tmpl:32-34's item — the code-unit block (Branches →
    // Tags → Git Hooks → Keys), before Mirror, active.
    expect(html).toContain('class="active item" href="/alice/demo/settings/keys"');
    expect(html).toContain(`>${deployKeysSettingsLocale.deploy_keys}</a>`);
    expect(html).toContain('href="/alice/demo/settings/mirror"');
  });
});

// --- the mounted-route harness (window-2d b54f709; the org-settings-blocked
// --- matrix's minted-session pattern) --------------------------------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → resolveUiRequest →
 *  the settingsGate → load/apply → render/redirect, on the mounted uiRouter
 *  with the synthetic manifest; the execution context is awaited so waitUntil
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

/** The stored deploy-key rows of the seeded repo (the write assertions). */
async function storedKeys(): Promise<Array<{ name: string; mode: number }>> {
  const rows = await drizzle(env.DB).select().from(deployKeys).where(eq(deployKeys.repoId, repo.id)).all();
  return rows.map((row) => ({ name: row.name, mode: row.mode }));
}

/** The admin's GET of the tab through the real route. */
async function keysGet(): Promise<Response> {
  return fetchUi("/alice/demo/settings/keys", { headers: { cookie: await ownerSessionHeader() } });
}

/** The admin's urlencoded POST to the tab through the real route: the given
 *  Origin header (the §2.8 guard's input) and the owner's minted session
 *  cookie. */
async function keysPost(fields: Record<string, string>, origin = ORIGIN): Promise<Response> {
  return fetchUi("/alice/demo/settings/keys", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      cookie: await ownerSessionHeader(),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A urlencoded POST to the tab with an EXPLICIT cookie header (or none —
 *  the anonymous and non-admin posture arms; the sibling matrices build
 *  these inline). */
async function keysPostAs(fields: Record<string, string>, cookie: string | null, origin = ORIGIN): Promise<Response> {
  return fetchUi("/alice/demo/settings/keys", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      ...(cookie === null ? {} : { cookie }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The admin's urlencoded POST to the delete tail through the real route. */
async function keysDeletePost(fields: Record<string, string>, origin = ORIGIN, cookie?: string): Promise<Response> {
  return fetchUi("/alice/demo/settings/keys/delete", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      cookie: cookie ?? (await ownerSessionHeader()),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

// --- the mounted page route (window-2d: GET /{owner}/{repo}/settings/keys) ----

describe("the mounted page route (GET /{owner}/{repo}/settings/keys)", () => {
  it("303s an anonymous GET onto the login round-trip (the settingsGate)", async () => {
    const res = await fetchUi("/alice/demo/settings/keys");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/alice/demo/settings/keys")}`);
  });

  it("404-shells a signed-in non-admin's GET (the reqRepoAdmin posture — the public repo resolves, the tab doesn't)", async () => {
    const bob = await seedNonAdmin("bob");
    const res = await fetchUi("/alice/demo/settings/keys", { headers: { cookie: await sessionHeader(bob.id) } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error"); // the 404 shell
    expect(html).not.toContain("repository settings"); // never the tab's content
  });

  it("renders the admin's GET at 200 with the discriminator, the active nav item and the empty arm", async () => {
    const res = await keysGet();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository settings"); // the §2.4.1 pageClass
    expect(html).toContain('class="active item" href="/alice/demo/settings/keys"');
    expect(html).toContain(deployKeysSettingsLocale.no_deploy_keys); // the empty arm
  });
});

// --- the mounted add write (window-2d: POST /{owner}/{repo}/settings/keys) ----

describe("the mounted add write (POST /{owner}/{repo}/settings/keys)", () => {
  it("303s an anonymous same-origin POST onto the login round-trip too (guard passes, then the gate; nothing written)", async () => {
    const res = await keysPostAs({ title: "anon-bot", content: ED25519_KEY }, null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/alice/demo/settings/keys")}`);
    expect(await storedKeys()).toEqual([]); // nothing was written
  });

  it("404-shells a signed-in non-admin's POST before any write (the gate fronts the write arm too)", async () => {
    const bob = await seedNonAdmin("bob");
    const res = await keysPostAs({ title: "bob-bot", content: ED25519_KEY }, await sessionHeader(bob.id));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(await storedKeys()).toEqual([]); // nothing was written
  });

  it("the add round-trip: 303 back onto the tab, the row lands read-only, and the follow-up GET renders it", async () => {
    const res = await keysPost({ title: "ci-bot", content: ED25519_KEY });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings/keys");
    expect(await storedKeys()).toEqual([{ name: "ci-bot", mode: 1 }]); // is_writable unchecked → read-only
    const page = await keysGet();
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`>${deployKeysSettingsLocale.deploy_keys}</h4>`);
    expect(html).toContain("<div class=\"item-title\">ci-bot</div>");
    expect(html).toContain(`<div class="item-body">${ED25519_FINGERPRINT}</div>`);
  });

  it("invalid content re-renders at 200 with the exact wired 422 text and the carried form, nothing written", async () => {
    const res = await keysPost({ title: "bad-key", content: "-----BEGIN PUBLIC KEY-----" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="ui negative message"');
    // The service's wired 422 verbatim (HandleCheckKeyStringError's prefix).
    expect(html).toContain("Invalid key content: unsupported public key format (OpenSSH single-line only)");
    expect(html).toContain('class="field error"'); // the content field's error class
    // The submitted values ride the re-render (RenderWithErrDeprecated's arm).
    expect(html).toContain('name="title" value="bad-key"');
    expect(html).toContain("-----BEGIN PUBLIC KEY-----");
    expect(await storedKeys()).toEqual([]); // the failed add wrote nothing
  });

  it("rejects a cross-origin POST with 403 before any write (sameOriginGuard first)", async () => {
    const res = await keysPost({ title: "evil-bot", content: ED25519_KEY }, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await storedKeys()).toEqual([]); // nothing was written
  });

  it("read-only vs writable rows: the is_writable checkbox flips the mode, and the GET renders the distinction", async () => {
    expect((await keysPost({ title: "deploy-ro", content: ED25519_KEY })).status).toBe(303);
    expect((await keysPost({ title: "deploy-rw", content: RSA_KEY, is_writable: "1" })).status).toBe(303);
    // The modes: unchecked → read (1), checked → write (2).
    expect(await storedKeys()).toEqual([
      { name: "deploy-ro", mode: 1 },
      { name: "deploy-rw", mode: 2 },
    ]);
    const page = await keysGet();
    const html = await page.text();
    expect(html).toContain("<div class=\"item-title\">deploy-ro</div>");
    expect(html).toContain("<div class=\"item-title\">deploy-rw</div>");
    // Exactly the writable row carries the · Write suffix (deploy_key_list.tmpl:25-26).
    expect((html.match(/Read · Write/g) ?? []).length).toBe(1);
    expect(html).not.toContain("Read · Write · Write");
  });
});

// --- the mounted delete write (window-2d: POST /{owner}/{repo}/settings/keys/delete)

describe("the mounted delete write (POST /{owner}/{repo}/settings/keys/delete)", () => {
  /** A seeded key's stored id (the delete arms' target). */
  async function seedKey(title: string): Promise<number> {
    const added = await addDeployKeyFromForm(env.DB, repo, { title, content: ED25519_KEY, isWritable: false });
    if (added.outcome !== "created") throw new Error("fixture key missing");
    const rows = await drizzle(env.DB).select().from(deployKeys).where(eq(deployKeys.repoId, repo.id)).all();
    const row = rows.find((candidate) => candidate.name === title);
    if (row === undefined) throw new Error("fixture key id missing");
    return row.id;
  }

  it("303s an anonymous same-origin delete POST onto the login round-trip (guard passes, then the gate; nothing written)", async () => {
    const id = await seedKey("untouched");
    const res = await keysDeletePost({ id: String(id) }, ORIGIN, "");
    expect(res.status).toBe(303);
    // The round-trip carries the REQUESTED path (the delete tail) — the
    // settingsGate's loginRedirect(url.pathname), the githooks anon-POST arm.
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/alice/demo/settings/keys/delete")}`,
    );
    expect(await storedKeys()).toEqual([{ name: "untouched", mode: 1 }]); // nothing was written
  });

  it("a hit 303s back onto the tab, the row is gone, and the follow-up GET renders the empty arm", async () => {
    const id = await seedKey("gone-soon");
    const res = await keysDeletePost({ id: String(id) });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings/keys");
    expect(await storedKeys()).toEqual([]);
    const page = await keysGet();
    expect(await page.text()).toContain(deployKeysSettingsLocale.no_deploy_keys);
  });

  it("a miss (unknown id) is idempotent — 303 and the live key survives", async () => {
    await seedKey("stays");
    const res = await keysDeletePost({ id: "424242" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings/keys");
    expect(await storedKeys()).toEqual([{ name: "stays", mode: 1 }]);
  });

  it("a repeat delete of the same id is idempotent too — 303 over the gone key", async () => {
    const id = await seedKey("once");
    expect((await keysDeletePost({ id: String(id) })).status).toBe(303);
    expect(await storedKeys()).toEqual([]);
    expect((await keysDeletePost({ id: String(id) })).status).toBe(303); // the gone id
    expect(await storedKeys()).toEqual([]);
  });

  it("a junk id (FormInt64's null bind) rides the same idempotent 303", async () => {
    await seedKey("kept");
    const res = await keysDeletePost({ id: "abc" });
    expect(res.status).toBe(303);
    expect(await storedKeys()).toEqual([{ name: "kept", mode: 1 }]);
  });

  it("404-shells a signed-in non-admin's delete POST before any write", async () => {
    const bob = await seedNonAdmin("bob");
    const id = await seedKey("survives");
    const res = await keysDeletePost({ id: String(id) }, ORIGIN, await sessionHeader(bob.id));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(await storedKeys()).toEqual([{ name: "survives", mode: 1 }]); // nothing was written
  });

  it("rejects a cross-origin delete POST with 403 before any write (sameOriginGuard first)", async () => {
    const id = await seedKey("still-here");
    const res = await keysDeletePost({ id: String(id) }, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await storedKeys()).toEqual([{ name: "still-here", mode: 1 }]); // nothing was written
  });
});

// --- the route claim pin (parse ↔ registration — the org-blocked-matrix pin) --

describe("the route claim pin (the settings family claims exactly the keys tab)", () => {
  it("parses the keys shapes; misspelled or deeper tails stay unclaimed", () => {
    expect(parseUiRoute("/alice/demo/settings/keys")).toEqual({ family: "settings-keys", owner: "alice", repo: "demo" });
    expect(handlesUiRoute("/alice/demo/settings/keys")).toBe(true);
    expect(parseUiRoute("/alice/demo/settings/keys/delete")).toEqual({
      family: "settings-keys-delete",
      owner: "alice",
      repo: "demo",
    });
    expect(handlesUiRoute("/alice/demo/settings/keys/delete")).toBe(true);
    expect(parseUiRoute("/alice/demo/settings/key")).toBeNull(); // the singular misspelling
    expect(parseUiRoute("/alice/demo/settings/keys/extra")).toBeNull();
    expect(handlesUiRoute("/alice/demo/settings/keys/extra")).toBe(false);
  });
});
