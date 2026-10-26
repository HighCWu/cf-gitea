/**
 * The repo settings deploy-keys tab's SMOKE tests (PORT-FIRST — one happy
 * path per arm, the repo-settings-githooks.test.tsx harness): the list page
 * renders seeded keys, the add creates, the delete removes — the module
 * driven directly over real D1 (no route yet, the HANDOFF NOTE in the module
 * header).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { deployKeys, repositories } from "../../db/schema";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  addDeployKeyFromForm,
  deleteDeployKeyFromForm,
  deployKeysSettingsLocale,
  DeployKeysSettingsNav,
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

// --- the nav scaffold ----------------------------------------------------------------

describe("the nav scaffold (DeployKeysSettingsNav)", () => {
  it("renders the reduced settings items with Deploy Keys active", () => {
    const html = renderToString(<DeployKeysSettingsNav repoLink="/alice/demo" />);
    expect(html).toContain('class="flex-container-nav"');
    expect(html).toContain('href="/alice/demo/settings"');
    expect(html).toContain('href="/alice/demo/settings/collaboration"');
    expect(html).toContain('href="/alice/demo/settings/hooks"');
    expect(html).toContain('href="/alice/demo/settings/branches"');
    // upstream navbar.tmpl:32-34's item — after Branches, before Mirror, active.
    expect(html).toContain('class="active item" href="/alice/demo/settings/keys"');
    expect(html).toContain(`>${deployKeysSettingsLocale.deploy_keys}</a>`);
    expect(html).toContain('href="/alice/demo/settings/mirror"');
  });
});
