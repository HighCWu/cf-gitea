/**
 * The repo settings ACTIONS GENERAL sub-tab's tests (the census C9 arm —
 * the repo-settings-actions-secrets-variables.test.tsx harness over the
 * generated migrations): the FormBool parse matrix (upstream base_form.go
 * strconv.ParseBool ∪ "on"), the toggle write over real D1 (the settings
 * write idiom — repo_settings.has_actions, DEFAULT false), the page-load
 * read, and the DOM contract of both unit postures — hono/jsx
 * renderToString, the module driven directly.
 *
 * The ROUTE-level matrix (the settingsGate arms, the bare-path redirect's
 * enabled-303/disabled-404 polarity, the actions_unit POST through
 * sameOriginGuard) rides the integrator's index.ts registration window —
 * the C8 test's mounted `fetchUi` section is its pattern; this module's
 * exports are the surface those handlers consume (the reported arms).
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef:
 * routers/web/repo/setting/actions.go:23-93 + web.go:1262-1278 +
 * templates/repo/settings/actions_general.tmpl (the module header carries
 * the full cite set).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { loadRepoSettings, saveRepoSettings } from "../../api/services/repo-settings";
import { repoUnits, repositories } from "../../db/schema";
import {
  applyRepoActionsUnitToggle,
  formBool,
  loadRepoActionsGeneralPageData,
  parseRepoActionsUnitForm,
  REPO_ACTIONS_GENERAL_REDIRECT_TARGET,
  renderRepoActionsGeneralPage,
  RepoActionsGeneralPage,
  repoSettingsActionsGeneralLocale,
} from "./repo-settings-actions-general";
import type { RepoRow } from "../ui-context";
import type { UiContext } from "../ui-context";
import { shellAssetsFromManifest } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };

/** The render context (the repo row is plugged in by beforeEach's seed —
 *  the settings pages' ctx.repo contract). */
const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

let repo: RepoRow;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_units", "repo_settings", "repositories", "users"]) {
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
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-2', 'repo-2', 'alice', 1, 'other', 'main', 'public', unixepoch())",
  ).run();
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
  if (row === undefined) throw new Error("fixture repository missing");
  return row;
}

/** The actions unit ON (the options form's enable_actions write — the same
 *  store arm the toggle writes). */
async function enableActions(): Promise<void> {
  await saveRepoSettings(env.DB, repo.id, { hasActions: true }, T0);
}

async function generalHtml(data?: { isActionsEnabled: boolean }): Promise<string> {
  const resolved = data ?? (await loadRepoActionsGeneralPageData(env.DB, repo.id));
  return renderToString(<RepoActionsGeneralPage ctx={{ ...ctx, repo }} data={resolved} />);
}

// --- the parse matrix --------------------------------------------------------

describe("formBool (upstream FormBool, base_form.go:62-65 — strconv.ParseBool ∪ \"on\")", () => {
  it("accepts the ParseBool true spellings", () => {
    for (const value of ["1", "t", "T", "true", "TRUE", "True"]) {
      expect(formBool(value)).toBe(true);
    }
  });

  it("accepts the case-insensitive on a value-less checkbox sends", () => {
    expect(formBool("on")).toBe(true);
    expect(formBool("ON")).toBe(true);
    expect(formBool("On")).toBe(true);
    expect(formBool("oN")).toBe(true);
  });

  it("rejects the ParseBool false spellings, junk, empty, and absent", () => {
    for (const value of ["0", "f", "F", "false", "FALSE", "False", "junk", ""]) {
      expect(formBool(value)).toBe(false);
    }
    expect(formBool(null)).toBe(false);
  });
});

describe("parseRepoActionsUnitForm (ActionsUnitPost's enable_actions FormBool)", () => {
  it("parses the checked box (the browser sends on)", () => {
    expect(parseRepoActionsUnitForm(new URLSearchParams({ enable_actions: "on" }))).toEqual({ enableActions: true });
  });

  it("parses the unchecked post (the field is absent — an unchecked checkbox posts nothing)", () => {
    expect(parseRepoActionsUnitForm(new URLSearchParams())).toEqual({ enableActions: false });
  });

  it("a literal 0 body disables (the ParseBool arm — not the present-means-true convention)", () => {
    expect(parseRepoActionsUnitForm(new URLSearchParams({ enable_actions: "0" }))).toEqual({ enableActions: false });
    expect(parseRepoActionsUnitForm(new URLSearchParams({ enable_actions: "1" }))).toEqual({ enableActions: true });
  });
});

// --- the toggle write (the settings write idiom) ---------------------------------

describe("applyRepoActionsUnitToggle (ActionsUnitPost's UpdateRepositoryUnits arm over repo_settings.has_actions)", () => {
  it("flips the store's default-false unit ON", async () => {
    expect((await loadRepoSettings(env.DB, repo.id)).hasActions).toBe(false); // the store default
    await applyRepoActionsUnitToggle(env.DB, repo.id, { enableActions: true });
    expect((await loadRepoSettings(env.DB, repo.id)).hasActions).toBe(true);
  });

  it("flips an enabled unit OFF (the disabled posture's write)", async () => {
    await enableActions();
    await applyRepoActionsUnitToggle(env.DB, repo.id, { enableActions: false });
    expect((await loadRepoSettings(env.DB, repo.id)).hasActions).toBe(false);
  });

  it("is idempotent both ways (the settings upsert)", async () => {
    await applyRepoActionsUnitToggle(env.DB, repo.id, { enableActions: true });
    await applyRepoActionsUnitToggle(env.DB, repo.id, { enableActions: true });
    expect((await loadRepoSettings(env.DB, repo.id)).hasActions).toBe(true);
    await applyRepoActionsUnitToggle(env.DB, repo.id, { enableActions: false });
    await applyRepoActionsUnitToggle(env.DB, repo.id, { enableActions: false });
    expect((await loadRepoSettings(env.DB, repo.id)).hasActions).toBe(false);
  });

  it("is repo-scoped — the neighbor's flag never moves", async () => {
    await applyRepoActionsUnitToggle(env.DB, repo.id, { enableActions: true });
    expect((await loadRepoSettings(env.DB, "repo-2")).hasActions).toBe(false);
  });

  it("maintains the repo_units actions row in lockstep (the scan's unit gate — ActionsUnitPost's UpdateRepositoryUnits arm: enable inserts, disable deletes)", async () => {
    await applyRepoActionsUnitToggle(env.DB, repo.id, { enableActions: true });
    expect(
      (await drizzle(env.DB).select().from(repoUnits).where(eq(repoUnits.repoId, repo.id)).all()).map((r) => r.type),
    ).toEqual(["actions"]);
    await applyRepoActionsUnitToggle(env.DB, repo.id, { enableActions: false });
    expect(await drizzle(env.DB).select().from(repoUnits).where(eq(repoUnits.repoId, repo.id)).all()).toEqual([]);
  });
});

describe("loadRepoActionsGeneralPageData (ActionsGeneralSettings' unit read, actions.go:28-36)", () => {
  it("answers false on a fresh store (the disabled posture — the page still renders)", async () => {
    expect(await loadRepoActionsGeneralPageData(env.DB, repo.id)).toEqual({ isActionsEnabled: false });
  });

  it("answers true after the enable write", async () => {
    await enableActions();
    expect(await loadRepoActionsGeneralPageData(env.DB, repo.id)).toEqual({ isActionsEnabled: true });
  });
});

// --- the DOM ---------------------------------------------------------------------

describe("the general page DOM (repo/settings/actions.tmpl PageType general + actions_general.tmpl)", () => {
  it("renders the toggle section on a DISABLED unit — the re-entry posture (the route carries no unit gate)", async () => {
    const html = await generalHtml({ isActionsEnabled: false });
    expect(html).toContain("repository settings actions"); // layout_head's pageClass (actions.tmpl:1)
    expect(html).toContain('class="repo-setting-content"'); // actions.tmpl:2
    expect(html).toContain("Enable Actions"); // the h4 (actions_general.tmpl:5)
    expect(html).toContain('action="/alice/demo/settings/actions/general/actions_unit"'); // {{.Link}}/actions_unit
    expect(html).toContain('<input name="enable_actions" type="checkbox"/>'); // unchecked
    expect(html).toContain("Enable Repository Actions"); // the checkbox label (actions_general.tmpl:14)
    expect(html).toContain("Update Settings"); // the submit (actions_general.tmpl:20)
  });

  it("renders the checkbox checked when the unit is enabled", async () => {
    const html = await generalHtml({ isActionsEnabled: true });
    expect(html).toContain('<input name="enable_actions" type="checkbox" checked=""/>');
  });

  it("the enabled-posture sections stay unrendered (the ActionsConfig-store reduction — never a dead control)", async () => {
    const html = await generalHtml({ isActionsEnabled: true });
    expect(html).not.toContain("Actions Token Permissions"); // actions_general.tmpl:28's section
    expect(html).not.toContain("Override owner-level configuration"); // :37's checkbox
    expect(html).not.toContain("Permissive"); // permission_mode_select.tmpl:7
    expect(html).not.toContain("token_permissions"); // the gated POST tail — unclaimed
    expect(html).not.toContain("Collaborative Owners Management"); // actions_general.tmpl:61's section
    expect(html).not.toContain("collaborative_owner"); // its POST tails — unclaimed
  });

  it("the nav rides the shared SettingsNav: General active in BOTH postures, the trio only when enabled", async () => {
    const disabled = await generalHtml({ isActionsEnabled: false });
    expect(disabled).toContain("<details"); // the Actions disclosure — the active==="general" arm
    expect(disabled).toContain('class="active item" href="/alice/demo/settings/actions/general"');
    expect(disabled).not.toContain('href="/alice/demo/settings/actions/secrets"'); // General alone (navbar.tmpl:43-46)
    expect(disabled).not.toContain('href="/alice/demo/settings/actions/variables"');

    const enabled = await generalHtml({ isActionsEnabled: true });
    expect(enabled).toContain('class="active item" href="/alice/demo/settings/actions/general"');
    expect(enabled).toContain('href="/alice/demo/settings/actions/secrets"'); // the trio (navbar.tmpl:47's conditional)
    expect(enabled).toContain('href="/alice/demo/settings/actions/variables"');
    expect(enabled).not.toContain('href="/alice/demo/settings/actions/runners"'); // the C7 mount retires it
  });

  it("the full-document render path matches the component path and throws without ctx.repo", async () => {
    const data = await loadRepoActionsGeneralPageData(env.DB, repo.id);
    const html = renderRepoActionsGeneralPage({ ...ctx, repo }, data);
    expect(html).toContain("repository settings actions");
    expect(html).toContain("Enable Actions");
    expect(() => renderRepoActionsGeneralPage(ctx, data)).toThrow("RepoActionsGeneralPage requires ctx.repo");
  });

  it("the bare-path redirect target is upstream's literal relative bytes", () => {
    expect(REPO_ACTIONS_GENERAL_REDIRECT_TARGET).toBe("./actions/general"); // web.go:1267 + misc.go:76-80
  });

  it("the locale carries the nav's import contract (settings.tsx's General sub-item)", () => {
    expect(repoSettingsActionsGeneralLocale.general).toBe("General"); // "actions.general"
  });
});
