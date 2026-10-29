/**
 * The repo settings ACTIONS secrets + variables sub-tabs' tests (the census
 * C8 arm — the org-settings-actions.test.tsx harness over the
 * repo-settings-wiki.test.tsx repo world): the parse/apply/delete matrix
 * over real D1 through the LANDED secrets-variables service at the REPO
 * scope (generated migrations in beforeAll; migration 0021's `secrets` +
 * `action_variables` stores over the TEXT repositories.id) and the DOM
 * contract of both page renders — hono/jsx renderToString, the modules
 * driven directly.
 *
 * The mounted matrix (the twins' minted-session route-level rows): the
 * settingsGate posture (anonymous 303s, signed-in non-admin 404 shells) AND
 * MustEnableActions' repo-unit arm (repo_settings.has_actions DEFAULT false —
 * even the admin 404-shells until the unit is enabled, the options form's
 * enable_actions flag), the admin's secret/variable create/edit/delete
 * round-trips with the carried-form contract (invalid secrets re-render with
 * name/description only; invalid variables carry all three), the cross-origin
 * 403 before any write, the missing→404 fidelity on the variable path-id
 * arms, and the cross-scope isolation (another repo's rows and any
 * owner-scope row are never visible/reachable).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { loadRepoSettings, saveRepoSettings } from "../../api/services/repo-settings";
import {
  createOrUpdateSecret,
  createVariableRow,
  listSecretRows,
  listVariableRows,
  ownerScope,
  repoScope,
} from "../../api/services/secrets-variables";
import { actionVariables, repositories, secrets, users } from "../../db/schema";
import { locale } from "../locale";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  applyRepoActionsSecretForm,
  applyRepoActionsVariableCreate,
  applyRepoActionsVariableUpdate,
  deleteRepoActionsSecret,
  deleteRepoActionsVariable,
  formatRepoActionsDate,
  loadRepoActionsSecretsPageData,
  loadRepoActionsVariablesPageData,
  parseRepoActionsSecretDeleteForm,
  parseRepoActionsSecretForm,
  parseRepoActionsVariableForm,
  parseRepoActionsVariablePathId,
  renderRepoActionsSecretsPage,
  renderRepoActionsVariablesPage,
  REPO_ACTIONS_DESCRIPTION_MAXLENGTH,
  REPO_ACTIONS_NAME_PATTERN,
  REPO_ACTIONS_SECRET_DATA_MAXLENGTH,
  REPO_ACTIONS_VARIABLE_DATA_MAXLENGTH,
  RepoActionsSecretRowItem,
  RepoActionsSecretsPage,
  RepoActionsVariableRowItem,
  RepoActionsVariablesPage,
  repoSettingsActionsLocale,
} from "./repo-settings-actions-secrets-variables";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";
const REPO_LINK = "/alice/demo";

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
  for (const table of ["secrets", "action_variables", "repo_settings", "repositories", "users"]) {
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

/** The actions unit ON — the MustEnableActions arm's happy-path posture
 *  (repo_settings.has_actions, the options form's enable_actions write). */
async function enableActions(): Promise<void> {
  await saveRepoSettings(env.DB, repo.id, { hasActions: true }, T0);
}

async function seedRepoSecret(name: string, data: string, description = ""): Promise<void> {
  await createOrUpdateSecret(env.DB, repoScope(repo.id), name, data, description);
}

async function seedRepoVariable(name: string, data: string, description = ""): Promise<void> {
  await createVariableRow(env.DB, repoScope(repo.id), name, data, description);
}

async function secretsHtml(error: string | null = null, form = { name: "", data: "", description: "" }): Promise<string> {
  const data = await loadRepoActionsSecretsPageData(env.DB, repo.id);
  return renderToString(<RepoActionsSecretsPage ctx={{ ...ctx, repo }} data={{ ...data, form }} error={error} />);
}

async function variablesHtml(error: string | null = null, form = { name: "", data: "", description: "" }): Promise<string> {
  const data = await loadRepoActionsVariablesPageData(env.DB, repo.id);
  return renderToString(<RepoActionsVariablesPage ctx={{ ...ctx, repo }} data={{ ...data, form }} error={error} />);
}

// --- the secrets sub-tab --------------------------------------------------------

describe("loadRepoActionsSecretsPageData (the 0021 store, the REPO scope)", () => {
  it("answers the empty list on a fresh store", async () => {
    const data = await loadRepoActionsSecretsPageData(env.DB, repo.id);
    expect(data.secrets).toEqual([]);
    expect(data.form).toEqual({ name: "", data: "", description: "" });
  });

  it("lists the repo's scope rows name-ordered, hiding owner-scoped and other-repo rows", async () => {
    await seedRepoSecret("BETA", "b-value");
    await seedRepoSecret("ALPHA", "a-value", "first");
    // Owner-scope rows (alice's own user-scope secret — the BelongingScopeOwner
    // encoding) and another repo's rows stay hidden.
    await createOrUpdateSecret(env.DB, ownerScope(1), "ALICE_SECRET", "u-value", "");
    await createOrUpdateSecret(env.DB, repoScope("other-repo"), "OTHER_ROW", "x", "");

    const data = await loadRepoActionsSecretsPageData(env.DB, repo.id);
    expect(data.secrets.map((row) => row.name)).toEqual(["ALPHA", "BETA"]); // ToOrders "name"
  });
});

describe("parseRepoActionsSecretForm (the dialog's three fields)", () => {
  it("parses name/data/description; absent fields parse empty (the urlencoded convention)", () => {
    expect(parseRepoActionsSecretForm(new URLSearchParams({ name: "A", data: "v", description: "d" }))).toEqual({
      name: "A",
      data: "v",
      description: "d",
    });
    expect(parseRepoActionsSecretForm(new URLSearchParams())).toEqual({ name: "", data: "", description: "" });
  });
});

describe("applyRepoActionsSecretForm (SecretsPost → PerformSecretsPost over createOrUpdateSecret)", () => {
  it("creates, then updates by the same name (the dialog's edit re-posts the name)", async () => {
    expect(await applyRepoActionsSecretForm(env.DB, repo.id, { name: "REPO_SECRET", data: "v1", description: "first" })).toEqual({
      outcome: "saved",
    });
    let rows = (await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("REPO_SECRET");

    expect(await applyRepoActionsSecretForm(env.DB, repo.id, { name: "REPO_SECRET", data: "v2", description: "second" })).toEqual({
      outcome: "saved",
    });
    rows = (await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toBe("v2");
    expect(rows[0]!.description).toBe("second");
  });

  it("EOL-normalizes the submitted value before the service call (the web write path, scope-shared)", async () => {
    await applyRepoActionsSecretForm(env.DB, repo.id, { name: "MULTILINE", data: "line1\r\nline2\r\nline3", description: "" });
    const rows = (await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows;
    expect(rows[0]!.data).toBe("line1\nline2\nline3");
  });

  it("the upsert is scope-guarded — another scope's same-name row is untouched", async () => {
    await createOrUpdateSecret(env.DB, repoScope("other-repo"), "SHARED", "theirs", "");
    expect(await applyRepoActionsSecretForm(env.DB, repo.id, { name: "SHARED", data: "ours", description: "" })).toEqual({
      outcome: "saved",
    });
    const all = await drizzle(env.DB).select().from(secrets);
    expect(all).toHaveLength(2);
    expect(all.find((row) => row.repoId === "other-repo")!.data).toBe("theirs");
    expect(all.find((row) => row.repoId === repo.id)!.data).toBe("ours");
  });

  it("surfaces the service's exact validation texts as invalid outcomes", async () => {
    expect(await applyRepoActionsSecretForm(env.DB, repo.id, { name: "9bad", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: repoSettingsActionsLocale.invalid_name_pattern,
    });
    expect(await applyRepoActionsSecretForm(env.DB, repo.id, { name: "GITEA_TOKEN", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: repoSettingsActionsLocale.invalid_name_prefix,
    });
    expect(await applyRepoActionsSecretForm(env.DB, repo.id, { name: "github_x", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: repoSettingsActionsLocale.invalid_name_prefix,
    });
    expect(await applyRepoActionsSecretForm(env.DB, repo.id, { name: "ci", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: repoSettingsActionsLocale.reserved_ci,
    });
    expect(await applyRepoActionsSecretForm(env.DB, repo.id, { name: "TOO_BIG", data: "x".repeat(65537), description: "" })).toEqual({
      outcome: "invalid",
      message: repoSettingsActionsLocale.data_too_long,
    });
    expect((await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0); // nothing partially written
  });
});

describe("deleteRepoActionsSecret (SecretsDelete → PerformSecretsDelete)", () => {
  beforeEach(async () => {
    await seedRepoSecret("DOOMED", "v");
  });

  it("parses the id field (absent/junk → null, the FormInt64 convention)", () => {
    expect(parseRepoActionsSecretDeleteForm(new URLSearchParams({ id: "12" }))).toEqual({ id: 12 });
    expect(parseRepoActionsSecretDeleteForm(new URLSearchParams())).toEqual({ id: null });
    expect(parseRepoActionsSecretDeleteForm(new URLSearchParams({ id: "junk" }))).toEqual({ id: null });
  });

  it("deletes the scoped row by id", async () => {
    const row = (await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    expect(await deleteRepoActionsSecret(env.DB, repo.id, { id: row.id })).toBe("deleted");
    expect((await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0);
  });

  it("answers missing for a null id, a stale id, and a foreign id — every arm deletes nothing", async () => {
    const row = (await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    expect(await deleteRepoActionsSecret(env.DB, repo.id, { id: null })).toBe("missing");
    expect(await deleteRepoActionsSecret(env.DB, repo.id, { id: row.id + 1000 })).toBe("missing");
    expect(await deleteRepoActionsSecret(env.DB, "other-repo", { id: row.id })).toBe("missing"); // another repo's scope
    expect((await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(1);
  });

  it("is idempotent — a repeated delete answers missing", async () => {
    const row = (await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    expect(await deleteRepoActionsSecret(env.DB, repo.id, { id: row.id })).toBe("deleted");
    expect(await deleteRepoActionsSecret(env.DB, repo.id, { id: row.id })).toBe("missing");
  });
});

// --- the variables sub-tab ------------------------------------------------------

describe("loadRepoActionsVariablesPageData (the 0021 store, the REPO scope)", () => {
  it("answers the empty list on a fresh store", async () => {
    const data = await loadRepoActionsVariablesPageData(env.DB, repo.id);
    expect(data.variables).toEqual([]);
    expect(data.form).toEqual({ name: "", data: "", description: "" });
  });

  it("lists the repo's scope rows name-ordered, hiding owner-scoped and other-repo rows", async () => {
    await seedRepoVariable("BETA", "b-value");
    await seedRepoVariable("ALPHA", "a-value", "first");
    await createVariableRow(env.DB, ownerScope(1), "ALICE_VAR", "u-value", "");
    await createVariableRow(env.DB, repoScope("other-repo"), "OTHER_ROW", "x", "");

    const data = await loadRepoActionsVariablesPageData(env.DB, repo.id);
    expect(data.variables.map((row) => row.name)).toEqual(["ALPHA", "BETA"]);
  });
});

describe("parseRepoActionsVariableForm + parseRepoActionsVariablePathId", () => {
  it("parses name/data/description; absent fields parse empty", () => {
    expect(parseRepoActionsVariableForm(new URLSearchParams({ name: "A", data: "v", description: "d" }))).toEqual({
      name: "A",
      data: "v",
      description: "d",
    });
    expect(parseRepoActionsVariableForm(new URLSearchParams())).toEqual({ name: "", data: "", description: "" });
  });

  it("the path id is digits-only (junk/absent → null, the PathParamInt64 convention)", () => {
    expect(parseRepoActionsVariablePathId("12")).toBe(12);
    expect(parseRepoActionsVariablePathId("junk")).toBeNull();
    expect(parseRepoActionsVariablePathId("")).toBeNull();
  });
});

describe("applyRepoActionsVariableCreate (VariableCreate → CreateVariable)", () => {
  it("creates the row — UPPERCASE name, EOL-normalized value (the service-side arms)", async () => {
    expect(await applyRepoActionsVariableCreate(env.DB, repo.id, { name: "repo_var", data: "line1\r\nline2", description: "d" })).toEqual({
      outcome: "saved",
    });
    const rows = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("REPO_VAR");
    expect(rows[0]!.data).toBe("line1\nline2");
    expect(rows[0]!.description).toBe("d");
  });

  it("surfaces the service's exact validation texts as invalid outcomes", async () => {
    expect(await applyRepoActionsVariableCreate(env.DB, repo.id, { name: "9bad", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: repoSettingsActionsLocale.invalid_name_pattern,
    });
    expect(await applyRepoActionsVariableCreate(env.DB, repo.id, { name: "GITHUB_X", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: repoSettingsActionsLocale.invalid_name_prefix,
    });
    expect(await applyRepoActionsVariableCreate(env.DB, repo.id, { name: "TOO_BIG", data: "x".repeat(65537), description: "" })).toEqual({
      outcome: "invalid",
      message: repoSettingsActionsLocale.data_too_long,
    });
    expect((await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0);
  });
});

describe("applyRepoActionsVariableUpdate (VariableUpdate over the landed updateVariableRow)", () => {
  beforeEach(async () => {
    await seedRepoVariable("EDITABLE", "old-value", "old-desc");
  });

  it("overwrites name/data/description through the row's stored name", async () => {
    const row = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    expect(await applyRepoActionsVariableUpdate(env.DB, repo.id, row.id, { name: "renamed_var", data: "new-value", description: "new-desc" })).toEqual({
      outcome: "saved",
    });
    const rows = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("RENAMED_VAR"); // the rename re-normalizes
    expect(rows[0]!.data).toBe("new-value");
    expect(rows[0]!.description).toBe("new-desc");
  });

  it("an empty form name rides the zero-value fallback (keeps the stored name)", async () => {
    const row = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    expect(await applyRepoActionsVariableUpdate(env.DB, repo.id, row.id, { name: "", data: "kept-value", description: "" })).toEqual({
      outcome: "saved",
    });
    const rows = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows;
    expect(rows[0]!.name).toBe("EDITABLE");
    expect(rows[0]!.data).toBe("kept-value");
  });

  it("an invalid rename surfaces the service text without writing", async () => {
    const row = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    expect(await applyRepoActionsVariableUpdate(env.DB, repo.id, row.id, { name: "9bad", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: repoSettingsActionsLocale.invalid_name_pattern,
    });
    expect((await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!.data).toBe("old-value");
  });

  it("answers missing for a null, stale, or foreign id — nothing written", async () => {
    const row = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    expect(await applyRepoActionsVariableUpdate(env.DB, repo.id, null, { name: "X", data: "v", description: "" })).toEqual({ outcome: "missing" });
    expect(await applyRepoActionsVariableUpdate(env.DB, repo.id, row.id + 1000, { name: "X", data: "v", description: "" })).toEqual({
      outcome: "missing",
    });
    expect(await applyRepoActionsVariableUpdate(env.DB, "other-repo", row.id, { name: "X", data: "v", description: "" })).toEqual({ outcome: "missing" });
    expect((await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!.data).toBe("old-value");
  });
});

describe("deleteRepoActionsVariable (VariableDelete over the landed deleteVariableRow)", () => {
  beforeEach(async () => {
    await seedRepoVariable("DOOMED", "v");
  });

  it("deletes the scoped row by id", async () => {
    const row = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    expect(await deleteRepoActionsVariable(env.DB, repo.id, row.id)).toBe("deleted");
    expect((await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0);
  });

  it("answers missing for a null, stale, or foreign id", async () => {
    const row = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    expect(await deleteRepoActionsVariable(env.DB, repo.id, null)).toBe("missing");
    expect(await deleteRepoActionsVariable(env.DB, repo.id, row.id + 1000)).toBe("missing");
    expect(await deleteRepoActionsVariable(env.DB, "other-repo", row.id)).toBe("missing");
    expect((await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(1);
  });

  it("is idempotent — a repeated delete answers missing", async () => {
    const row = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    expect(await deleteRepoActionsVariable(env.DB, repo.id, row.id)).toBe("deleted");
    expect(await deleteRepoActionsVariable(env.DB, repo.id, row.id)).toBe("missing");
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the secrets page DOM (repo/settings/actions.tmpl PageType secrets + shared/secrets/add_list.tmpl)", () => {
  it("renders the page discriminator and the navbar with the Actions disclosure open + Secrets active", async () => {
    await enableActions();
    const html = await secretsHtml();
    expect(html).toContain("repository settings actions"); // layout_head's pageClass (actions.tmpl:1)
    expect(html).toContain("<details"); // navbar.tmpl:41's disclosure
    expect(html).toContain("open"); // the PageIsSharedSettingsSecrets open arm
    expect(html).toContain('class="active item" href="/alice/demo/settings/actions/secrets"');
    expect(html).toContain('href="/alice/demo/settings/actions/variables"'); // the sibling sub-item
    expect(html).toContain('href="/alice/demo/settings"'); // the landed settings tabs stay linked
    expect(html).toContain('href="/alice/demo/settings/hooks"');
    expect(html).toContain('href="/alice/demo/settings/lfs"');
    expect(html).not.toContain("settings/actions/runners"); // the unlanded sub-item renders nothing
    // The General sub-item is lit by the census C9 mount
    // (pages/repo-settings-actions-general.tsx) — upstream keeps it
    // UNCONDITIONAL inside the Actions disclosure (navbar.tmpl:43-46; the
    // disabled unit's re-entry), so it renders on these enabled pages too,
    // inactive while Secrets is.
    expect(html).toContain('<a class="item" href="/alice/demo/settings/actions/general">General</a>');
    // Audit stays LAST in upstream's menu order (navbar.tmpl:60-62 — after
    // the Actions details block).
    const at = (s: string) => html.indexOf(s);
    expect(at('href="/alice/demo/settings/audit_logs"')).toBeGreaterThan(at('href="/alice/demo/settings/actions/variables"'));
  });

  it("renders the empty arm (secrets.none) and the add form with the upstream contract", async () => {
    await enableActions();
    const html = await secretsHtml();
    expect(html).toContain(repoSettingsActionsLocale.secrets_management);
    expect(html).toContain(repoSettingsActionsLocale.secrets_none);
    expect(html).toContain('action="/alice/demo/settings/actions/secrets"');
    expect(html).toContain('name="name"');
    expect(html).toContain(`pattern="${REPO_ACTIONS_NAME_PATTERN}"`); // add_list.tmpl:81
    expect(html).toContain("MY_SECRET_NAME"); // add_list.tmpl:83's placeholder
    expect(html).toContain(`maxlength="${REPO_ACTIONS_SECRET_DATA_MAXLENGTH}"`); // {{.DataMaxLength}}
    expect(html).toContain(`maxlength="${REPO_ACTIONS_DESCRIPTION_MAXLENGTH}"`);
    expect(html).toContain(repoSettingsActionsLocale.value_placeholder);
    expect(html).toContain(repoSettingsActionsLocale.description_placeholder);
    expect(html).toContain(repoSettingsActionsLocale.secrets_description); // the dialog's lead line
    expect(html).toContain(`>${repoSettingsActionsLocale.add_secret}</button>`);
  });

  it("renders the list rows: glyph, name, description-or-dash, ******, added-on, no plaintext", async () => {
    await enableActions();
    await seedRepoSecret("ALPHA", "alpha-plaintext-value", "the first one");
    await seedRepoSecret("BETA", "beta-plaintext-value", "");
    const data = await loadRepoActionsSecretsPageData(env.DB, repo.id);
    const html = renderToString(<RepoActionsSecretsPage ctx={{ ...ctx, repo }} data={data} error={null} />);
    expect(html).toContain("flex-divided-list items-with-main");
    expect(html).toContain(">ALPHA</div>");
    expect(html).toContain(">BETA</div>");
    expect(html).toContain("the first one");
    expect(html).toContain('<div class="item-body">-</div>'); // the empty-description dash arm
    expect(html).toContain("******");
    expect(html).toContain("Added on"); // settings.added_on
    expect(html).not.toContain("alpha-plaintext-value"); // the value never enters the DOM
    expect(html).not.toContain("beta-plaintext-value");
    expect(html).not.toContain(repoSettingsActionsLocale.secrets_none);
  });

  it("renders the edit disclosures: read-only name, EMPTY value, and the remove id forms", async () => {
    await enableActions();
    await seedRepoSecret("EDITABLE", "secret-value", "");
    const row = (await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    const html = await secretsHtml();
    expect(html).toContain("<details>"); // the modal reduction
    expect(html).toContain(repoSettingsActionsLocale.edit_secret);
    expect(html).toContain('value="EDITABLE"');
    expect(html).toContain('readOnly="true"'); // add_list.tmpl:46's read-only arm
    expect(html).not.toContain("secret-value"); // add_list.tmpl:47's empty data arm
    expect(html).toContain('action="/alice/demo/settings/actions/secrets/delete"');
    expect(html).toContain(`name="id" value="${String(row.id)}"`);
    expect(html).toContain(repoSettingsActionsLocale.remove);
    expect(html).not.toContain("show-modal"); // the JS modal pair is not reproduced
    expect(html).not.toContain("link-action");
  });

  it("the error slot renders the negative message and the submitted form re-renders", async () => {
    await enableActions();
    const html = await secretsHtml("name cannot start with 'GITEA_' or 'GITHUB_'", {
      name: "GITEA_TOKEN",
      data: "kept",
      description: "also kept",
    });
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("name cannot start with &#39;GITEA_&#39; or &#39;GITHUB_&#39;");
    expect(html).toContain('value="GITEA_TOKEN"');
    expect(html).toContain("kept");
  });

  it("the row component keys the masked body and the repo-scoped delete URL", async () => {
    await seedRepoSecret("ROW_SHAPE", "v", "");
    const row = (await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    const html = renderToString(<RepoActionsSecretRowItem repoLink={REPO_LINK} row={row} />);
    expect(html).toContain('class="item-main"');
    expect(html).toContain("******");
    expect(html).not.toContain(">v<");
    expect(html).toContain(`action="${REPO_LINK}/settings/actions/secrets/delete"`);
  });

  it("the full-document render path matches the component path", async () => {
    await enableActions();
    const data = await loadRepoActionsSecretsPageData(env.DB, repo.id);
    const html = renderRepoActionsSecretsPage({ ...ctx, repo }, data);
    expect(html).toContain("repository settings actions");
    expect(html).toContain(repoSettingsActionsLocale.secrets_none);
  });

  it("throws without a resolved repo (the settings pages' ctx.repo contract)", async () => {
    const data = await loadRepoActionsSecretsPageData(env.DB, repo.id);
    expect(() => renderToString(<RepoActionsSecretsPage ctx={ctx} data={data} error={null} />)).toThrow(
      "RepoActionsSecretsPage requires ctx.repo",
    );
    expect(() => renderRepoActionsSecretsPage(ctx, data)).toThrow("RepoActionsSecretsPage requires ctx.repo");
  });

  it("leaves no stale rows behind after the delete flow (the store round-trip)", async () => {
    await seedRepoSecret("GONE", "v");
    const row = (await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    await deleteRepoActionsSecret(env.DB, repo.id, { id: row.id });
    expect(await drizzle(env.DB).select().from(secrets).where(eq(secrets.id, row.id)).get()).toBeUndefined();
  });
});

describe("the variables page DOM (repo/settings/actions.tmpl PageType variables + shared/variables/variable_list.tmpl)", () => {
  it("renders the page discriminator and the navbar with the Actions disclosure open + Variables active", async () => {
    await enableActions();
    const html = await variablesHtml();
    expect(html).toContain("repository settings actions");
    expect(html).toContain("<details");
    expect(html).toContain("open");
    expect(html).toContain('class="active item" href="/alice/demo/settings/actions/variables"');
    expect(html).toContain('href="/alice/demo/settings/actions/secrets"'); // the sibling sub-item
  });

  it("renders the empty arm (actions.variables.none) and the add form posting to /new", async () => {
    await enableActions();
    const html = await variablesHtml();
    expect(html).toContain(repoSettingsActionsLocale.variables_management);
    expect(html).toContain(repoSettingsActionsLocale.variables_none);
    expect(html).toContain('action="/alice/demo/settings/actions/variables/new"');
    expect(html).toContain(`pattern="${REPO_ACTIONS_NAME_PATTERN}"`);
    expect(html).toContain("MY_VARIABLE_NAME"); // variable_list.tmpl:81's placeholder
    expect(html).toContain(`maxlength="${REPO_ACTIONS_VARIABLE_DATA_MAXLENGTH}"`);
    expect(html).toContain(repoSettingsActionsLocale.variables_description); // the dialog's lead line
    expect(html).toContain(`>${repoSettingsActionsLocale.add_variable}</button>`);
  });

  it("renders the list rows with the value IN PLAINTEXT (variables are not masked)", async () => {
    await enableActions();
    await seedRepoVariable("ALPHA", "alpha-open-value", "desc one");
    await seedRepoVariable("BETA", "beta-open-value", "");
    const data = await loadRepoActionsVariablesPageData(env.DB, repo.id);
    const html = renderToString(<RepoActionsVariablesPage ctx={{ ...ctx, repo }} data={data} error={null} />);
    expect(html).toContain(">ALPHA</div>");
    expect(html).toContain("alpha-open-value"); // variable_list.tmpl:31-33 — the plaintext body
    expect(html).toContain("beta-open-value");
    expect(html).toContain('<div class="item-body">-</div>');
    expect(html).not.toContain("******");
    expect(html).not.toContain(repoSettingsActionsLocale.variables_none);
  });

  it("renders the edit disclosures prefilled (name NOT read-only) posting to the row's edit URL, and the path-id delete forms", async () => {
    await enableActions();
    await seedRepoVariable("EDITABLE", "kept-value", "kept-desc");
    const row = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    const html = await variablesHtml();
    expect(html).toContain('value="EDITABLE"');
    expect(html).toContain("kept-value"); // the dialog pre-fills all three fields
    expect(html).toContain("kept-desc");
    expect(html).not.toContain('readOnly="true"'); // no read-only arm in the variables dialog
    expect(html).toContain(`action="/alice/demo/settings/actions/variables/${row.id}/edit"`);
    expect(html).toContain(`action="/alice/demo/settings/actions/variables/${row.id}/delete"`); // the id in the path
    expect(html).toContain(repoSettingsActionsLocale.deletion);
    expect(html).toContain("octicon-trash");
  });

  it("the error slot renders the negative message and the submitted form re-renders", async () => {
    await enableActions();
    const html = await variablesHtml("name must start with a letter or underscore and contain only letters, numbers, and underscores", {
      name: "9bad",
      data: "kept",
      description: "also kept",
    });
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain('value="9bad"');
    expect(html).toContain("kept");
  });

  it("the row component keys the plaintext body and the repo-scoped edit/delete URLs", async () => {
    await seedRepoVariable("ROW_SHAPE", "row-value", "");
    const row = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    const html = renderToString(<RepoActionsVariableRowItem repoLink={REPO_LINK} row={row} />);
    expect(html).toContain("row-value");
    expect(html).toContain(`action="${REPO_LINK}/settings/actions/variables/${row.id}/edit"`);
    expect(html).toContain(`action="${REPO_LINK}/settings/actions/variables/${row.id}/delete"`);
  });

  it("the full-document render path matches the component path and throws without ctx.repo", async () => {
    await enableActions();
    const data = await loadRepoActionsVariablesPageData(env.DB, repo.id);
    const html = renderRepoActionsVariablesPage({ ...ctx, repo }, data);
    expect(html).toContain("repository settings actions");
    expect(html).toContain(repoSettingsActionsLocale.variables_none);
    expect(() => renderRepoActionsVariablesPage(ctx, data)).toThrow("RepoActionsVariablesPage requires ctx.repo");
  });

  it("leaves no stale rows behind after the delete flow (the store round-trip)", async () => {
    await seedRepoVariable("GONE", "v");
    const row = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    await deleteRepoActionsVariable(env.DB, repo.id, row.id);
    expect(await drizzle(env.DB).select().from(actionVariables).where(eq(actionVariables.id, row.id)).get()).toBeUndefined();
  });
});

// --- the shared chrome ------------------------------------------------------------

describe("the shared chrome", () => {
  it("formatRepoActionsDate renders upstream's AbsoluteShort in UTC", () => {
    expect(formatRepoActionsDate(T0)).toBe("Nov 14, 2023");
  });

  it("both pages render the repo-scoped navbar over the repo-setting-content wrapper (actions.tmpl:2)", async () => {
    await enableActions();
    const secrets = await secretsHtml();
    const variables = await variablesHtml();
    expect(secrets).toContain('class="repo-setting-content"');
    expect(variables).toContain('class="repo-setting-content"');
  });
});

// --- the mounted route arms (the census C8 mount; the wiki matrix's
//     minted-session route-level pattern) ---------------------------------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → resolveUiRequest →
 *  the settingsGate + the MustEnableActions arm → load → render, on the
 *  mounted uiRouter with the synthetic manifest; the execution context is
 *  awaited so waitUntil side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A viewer's minted session cookie header (the real mintSession path, minted
 *  per request — the beforeEach users wipe cascades the sessions table, so a
 *  cross-test cache would go stale; the value is never rendered). */
async function sessionCookie(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A GET through the mount (`userId: null` is the anonymous arm). */
async function getRoute(path: string, userId: number | null): Promise<Response> {
  return fetchUi(path, { headers: userId === null ? {} : { cookie: await sessionCookie(userId) } });
}

/** A urlencoded POST through the mount (same-origin by default — the
 *  sameOriginGuard's happy path; pass another origin for the 403 arms). */
async function postRoute(path: string, userId: number, fields: Record<string, string>, origin = ORIGIN): Promise<Response> {
  return fetchUi(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      cookie: await sessionCookie(userId),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The 404 fidelity every missing arm shares: the shell answers (the
 *  handler's renderNotFound HTML or the parse-guard's plain 404 — both carry
 *  the upstream box title), never the re-rendered tab. */
async function expectNotFoundShell(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const html = await res.text();
  expect(html).toContain(locale.error404_box_title);
  expect(html).not.toContain(repoSettingsActionsLocale.secrets_management);
  expect(html).not.toContain(repoSettingsActionsLocale.variables_management);
}

describe("the mounted repo actions routes (the census C8: the minted-session route-level matrix)", () => {
  let bobId: number;

  beforeEach(async () => {
    // The file-level beforeEach has wiped users (cascading sessions) and
    // re-seeded alice as id 1; this stage seeds the non-admin second viewer
    // (the wiki matrix's seedNonAdmin posture — the public repo resolves for
    // the read, the admin gate 404-shells the tab).
    const [bob] = await drizzle(env.DB)
      .insert(users)
      .values({ username: "bob", usernameLower: "bob", status: "active", createdAt: T0 })
      .returning()
      .all();
    if (bob === undefined) throw new Error("non-admin seed failed");
    bobId = bob.id;
  });

  // -- the gates ------------------------------------------------------------

  it("303s an anonymous GET of both sub-tabs onto the login round-trip (the settingsGate)", async () => {
    for (const path of ["/alice/demo/settings/actions/secrets", "/alice/demo/settings/actions/variables"]) {
      const res = await getRoute(path, null);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(path)}`);
    }
  });

  it("303s an anonymous same-origin POST onto the login round-trip too (the guard passes, then the signed-in gate)", async () => {
    const res = await fetchUi("/alice/demo/settings/actions/secrets", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams({ name: "ANON_ROW", data: "v", description: "" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/alice/demo/settings/actions/secrets")}`,
    );
    expect((await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0); // nothing written
  });

  it("404-shells a signed-in non-admin (bob) on GET and POST — nothing written", async () => {
    await enableActions(); // the unit is ON — the 404 is the ADMIN gate's, not the unit's
    await expectNotFoundShell(await getRoute("/alice/demo/settings/actions/secrets", bobId));
    await expectNotFoundShell(await getRoute("/alice/demo/settings/actions/variables", bobId));
    await expectNotFoundShell(
      await postRoute("/alice/demo/settings/actions/secrets", bobId, { name: "BOB_ROW", data: "v", description: "" }),
    );
    await expectNotFoundShell(
      await postRoute("/alice/demo/settings/actions/variables/new", bobId, { name: "BOB_VAR", data: "v", description: "" }),
    );
    expect((await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0);
    expect((await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0);
  });

  it("404-shells even the ADMIN while the actions unit is disabled (MustEnableActions' repo-unit arm — the store default)", async () => {
    // No repo_settings row: repo_settings.has_actions defaults FALSE.
    expect((await loadRepoSettings(env.DB, repo.id)).hasActions).toBe(false);
    await expectNotFoundShell(await getRoute("/alice/demo/settings/actions/secrets", 1));
    await expectNotFoundShell(await getRoute("/alice/demo/settings/actions/variables", 1));
    await expectNotFoundShell(
      await postRoute("/alice/demo/settings/actions/secrets", 1, { name: "LATE_ROW", data: "v", description: "" }),
    );
    expect((await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0); // nothing written

    // The unit flips ON (the options form's enable_actions write) and the
    // same URLs answer 200 — the gate's exact polarity.
    await enableActions();
    expect((await getRoute("/alice/demo/settings/actions/secrets", 1)).status).toBe(200);
    expect((await getRoute("/alice/demo/settings/actions/variables", 1)).status).toBe(200);
  });

  // -- the admin's secrets sub-tab through the mount ------------------------

  it("the admin's secret POST saves through the mount and the follow-up GET renders the row (the round-trip)", async () => {
    await enableActions();
    const res = await postRoute("/alice/demo/settings/actions/secrets", 1, {
      name: "ROUTE_SECRET",
      data: "route-plaintext",
      description: "route description",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings/actions/secrets");
    const rows = (await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows;
    expect(rows.map((row) => row.name)).toEqual(["ROUTE_SECRET"]);

    const page = await getRoute("/alice/demo/settings/actions/secrets", 1);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("repository settings actions"); // the §2.4.1 pageClass
    expect(html).toContain(">ROUTE_SECRET</div>");
    expect(html).toContain("route description");
    expect(html).not.toContain("route-plaintext"); // masked, even on the admin's own page
  });

  it("the admin's invalid secret POST re-renders with the carried form — name/description kept, the value EMPTY", async () => {
    await enableActions();
    const res = await postRoute("/alice/demo/settings/actions/secrets", 1, {
      name: "GITEA_TOKEN",
      data: "route-plaintext",
      description: "kept description",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="ui negative message"');
    // renderToString HTML-escapes the message's apostrophes (the twins' DOM
    // convention).
    expect(html).toContain("name cannot start with &#39;GITEA_&#39; or &#39;GITHUB_&#39;");
    expect(html).toContain('value="GITEA_TOKEN"'); // the name carried
    expect(html).toContain(">kept description</textarea>"); // the description carried
    expect(html).not.toContain("route-plaintext"); // the plaintext never enters the DOM
    expect((await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0); // nothing written
  });

  it("the admin's secret delete POST removes the row and 303s back; a stale id 303s idempotently", async () => {
    await enableActions();
    await createOrUpdateSecret(env.DB, repoScope(repo.id), "DOOMED", "v", "");
    const row = (await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    const hit = await postRoute("/alice/demo/settings/actions/secrets/delete", 1, { id: String(row.id) });
    expect(hit.status).toBe(303);
    expect(hit.headers.get("location")).toBe("/alice/demo/settings/actions/secrets");
    expect((await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0);
    // A repeated (now stale) id: the same 303, nothing else happens (the
    // idempotent-303 reduction).
    const stale = await postRoute("/alice/demo/settings/actions/secrets/delete", 1, { id: String(row.id) });
    expect(stale.status).toBe(303);
    expect(stale.headers.get("location")).toBe("/alice/demo/settings/actions/secrets");
  });

  // -- the admin's variables sub-tab through the mount ----------------------

  it("renders the admin's variables GET at 200 with the discriminator and the new-form action", async () => {
    await enableActions();
    const res = await getRoute("/alice/demo/settings/actions/variables", 1);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository settings actions");
    expect(html).toContain('action="/alice/demo/settings/actions/variables/new"');
    expect(html).toContain(repoSettingsActionsLocale.variables_none); // the fresh-store empty arm
  });

  it("the admin's variable POST new saves through the mount — 303 onto the list, the name stored UPPERCASE", async () => {
    await enableActions();
    const res = await postRoute("/alice/demo/settings/actions/variables/new", 1, {
      name: "route_var",
      data: "route-open-value",
      description: "route description",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings/actions/variables");
    const rows = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows;
    expect(rows.map((row) => row.name)).toEqual(["ROUTE_VAR"]); // the service's UPPERCASE arm
    expect(rows[0]!.data).toBe("route-open-value");
  });

  it("the admin's invalid variable POST re-renders with ALL THREE fields carried (the value rides along, unlike secrets)", async () => {
    await enableActions();
    const res = await postRoute("/alice/demo/settings/actions/variables/new", 1, {
      name: "BAD-NAME",
      data: "carried-value",
      description: "carried description",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain(repoSettingsActionsLocale.invalid_name_pattern);
    expect(html).toContain('value="BAD-NAME"');
    expect(html).toContain(">carried-value</textarea>");
    expect(html).toContain(">carried description</textarea>");
    expect((await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0); // nothing written
  });

  it("the admin's variable edit POST saves through the mount (the row rewritten)", async () => {
    await enableActions();
    await createVariableRow(env.DB, repoScope(repo.id), "EDITABLE", "old-value", "");
    const row = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    const res = await postRoute(`/alice/demo/settings/actions/variables/${row.id}/edit`, 1, {
      name: "EDITABLE",
      data: "new-value",
      description: "new description",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings/actions/variables");
    const after = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    expect(after.id).toBe(row.id);
    expect(after.data).toBe("new-value");
    expect(after.description).toBe("new description");
  });

  it("the variable edit and delete arms answer the 404 shell for a stale and a foreign-repo id (the findActionsVariable NotFound fidelity)", async () => {
    await enableActions();
    await createVariableRow(env.DB, repoScope(repo.id), "DOOMED", "v", "");
    const row = (await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows[0]!;
    await createVariableRow(env.DB, repoScope("other-repo"), "FOREIGN_VAR", "f", "");
    const foreignId = (await listVariableRows(env.DB, repoScope("other-repo"), 1, 10)).rows[0]!.id;
    await deleteRepoActionsVariable(env.DB, repo.id, row.id); // stale the id

    for (const id of [row.id, foreignId]) {
      await expectNotFoundShell(
        await postRoute(`/alice/demo/settings/actions/variables/${id}/edit`, 1, { name: "X", data: "v", description: "" }),
      );
      await expectNotFoundShell(await postRoute(`/alice/demo/settings/actions/variables/${id}/delete`, 1, {}));
    }
    // The junk path ids never reach the write (the parse guard's digits-only
    // claim — "-3" parses to a rowid that misses, "junk"/"12.5" fail the
    // parse itself; both answer the same 404).
    for (const junk of ["junk", "-3", "12.5"]) {
      await expectNotFoundShell(
        await postRoute(`/alice/demo/settings/actions/variables/${junk}/edit`, 1, { name: "X", data: "v", description: "" }),
      );
      await expectNotFoundShell(await postRoute(`/alice/demo/settings/actions/variables/${junk}/delete`, 1, {}));
    }
    expect((await listVariableRows(env.DB, repoScope("other-repo"), 1, 10)).rows).toHaveLength(1); // the foreign row survives
  });

  // -- the guard + the scope isolation ---------------------------------------

  it("rejects a cross-origin POST with 403 before any write (sameOriginGuard first, both sub-tabs)", async () => {
    await enableActions();
    for (const path of ["/alice/demo/settings/actions/secrets", "/alice/demo/settings/actions/variables/new"]) {
      const res = await postRoute(path, 1, { name: "EVIL_ROW", data: "v", description: "" }, "https://evil.example");
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("cross-origin request rejected");
    }
    expect((await listSecretRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0);
    expect((await listVariableRows(env.DB, repoScope(repo.id), 1, 10)).rows).toHaveLength(0);
  });

  it("other scopes' rows are never visible on this repo's pages (the scope-isolation read arm)", async () => {
    await enableActions();
    await createOrUpdateSecret(env.DB, repoScope(repo.id), "OURS", "ours-plaintext", "ours description");
    await createOrUpdateSecret(env.DB, repoScope("other-repo"), "THEIR_REPO_SECRET", "theirs-plaintext", "theirs description");
    await createOrUpdateSecret(env.DB, ownerScope(1), "THEIR_OWNER_SECRET", "owner-plaintext", "owner description");
    await createVariableRow(env.DB, repoScope(repo.id), "OUR_VAR", "our-open-value", "");
    await createVariableRow(env.DB, repoScope("other-repo"), "THEIR_REPO_VAR", "their-open-value", "");
    const rivalSecretId = (await listSecretRows(env.DB, repoScope("other-repo"), 1, 10)).rows[0]!.id;

    const secretsPage = await getRoute("/alice/demo/settings/actions/secrets", 1);
    expect(secretsPage.status).toBe(200);
    const secretsText = await secretsPage.text();
    expect(secretsText).toContain(">OURS</div>");
    expect(secretsText).not.toContain("THEIR_REPO_SECRET");
    expect(secretsText).not.toContain("THEIR_OWNER_SECRET");
    expect(secretsText).not.toContain("theirs-plaintext");
    expect(secretsText).not.toContain("owner-plaintext");
    expect(secretsText).not.toContain(`name="id" value="${String(rivalSecretId)}"`); // no foreign delete form

    const variablesPage = await getRoute("/alice/demo/settings/actions/variables", 1);
    expect(variablesPage.status).toBe(200);
    const variablesText = await variablesPage.text();
    expect(variablesText).toContain(">OUR_VAR</div>");
    expect(variablesText).toContain("our-open-value");
    expect(variablesText).not.toContain("THEIR_REPO_VAR");
    expect(variablesText).not.toContain("their-open-value");
  });

  it("other scopes' rows are unreachable through this repo's write URLs (the scope-isolation write arms)", async () => {
    await enableActions();
    await createOrUpdateSecret(env.DB, repoScope("other-repo"), "THEIRS", "theirs-plaintext", "");
    await createVariableRow(env.DB, repoScope("other-repo"), "THEIR_VAR", "their-open-value", "");
    const rivalSecret = (await listSecretRows(env.DB, repoScope("other-repo"), 1, 10)).rows[0]!;
    const rivalVariable = (await listVariableRows(env.DB, repoScope("other-repo"), 1, 10)).rows[0]!;

    // The secrets delete always 303s (the idempotent-303 reduction) — but a
    // foreign id deletes nothing.
    const del = await postRoute("/alice/demo/settings/actions/secrets/delete", 1, { id: String(rivalSecret.id) });
    expect(del.status).toBe(303);
    const rivalSecrets = (await listSecretRows(env.DB, repoScope("other-repo"), 1, 10)).rows;
    expect(rivalSecrets).toHaveLength(1);
    expect(rivalSecrets[0]!.data).toBe("theirs-plaintext");

    // The variable edit/delete answer the genuine 404 shell — the row
    // survives untouched.
    await expectNotFoundShell(
      await postRoute(`/alice/demo/settings/actions/variables/${rivalVariable.id}/edit`, 1, {
        name: "HIJACKED",
        data: "hijacked-value",
        description: "",
      }),
    );
    await expectNotFoundShell(await postRoute(`/alice/demo/settings/actions/variables/${rivalVariable.id}/delete`, 1, {}));
    const after = (await listVariableRows(env.DB, repoScope("other-repo"), 1, 10)).rows[0]!;
    expect(after.name).toBe("THEIR_VAR");
    expect(after.data).toBe("their-open-value");
  });
});

// --- the route claim pin (parse ↔ registration — the wiki matrix's pin) -------

describe("the route claim pin (the settings family claims exactly the actions sub-tab CRUD arms)", () => {
  it("parses the six families; the bare /actions redirect and every junk/deeper tail stay unclaimed", () => {
    expect(parseUiRoute("/alice/demo/settings/actions/secrets")).toEqual({
      family: "settings-actions-secrets",
      owner: "alice",
      repo: "demo",
    });
    expect(parseUiRoute("/alice/demo/settings/actions/secrets/delete")).toEqual({
      family: "settings-actions-secrets-delete",
      owner: "alice",
      repo: "demo",
    });
    expect(parseUiRoute("/alice/demo/settings/actions/variables")).toEqual({
      family: "settings-actions-variables",
      owner: "alice",
      repo: "demo",
    });
    expect(parseUiRoute("/alice/demo/settings/actions/variables/new")).toEqual({
      family: "settings-actions-variables-new",
      owner: "alice",
      repo: "demo",
    });
    expect(parseUiRoute("/alice/demo/settings/actions/variables/12/edit")).toEqual({
      family: "settings-actions-variables-edit",
      owner: "alice",
      repo: "demo",
      id: 12,
    });
    expect(parseUiRoute("/alice/demo/settings/actions/variables/12/delete")).toEqual({
      family: "settings-actions-variables-delete",
      owner: "alice",
      repo: "demo",
      id: 12,
    });
    // The sibling arms landed (the shared index window): the bare /actions
    // redirect (C9 — upstream's LocationRedirect), the general page (C9)
    // and the runners list (C7) now claim.
    expect(parseUiRoute("/alice/demo/settings/actions")).toEqual({
      family: "settings-actions",
      owner: "alice",
      repo: "demo",
    });
    expect(parseUiRoute("/alice/demo/settings/actions/general")).toEqual({
      family: "settings-actions-general",
      owner: "alice",
      repo: "demo",
    });
    expect(parseUiRoute("/alice/demo/settings/actions/runners")).toEqual({
      family: "settings-actions-runners",
      owner: "alice",
      repo: "demo",
    });
    expect(parseUiRoute("/alice/demo/settings/actions/general/actions_unit")).toEqual({
      family: "settings-actions-general-unit",
      owner: "alice",
      repo: "demo",
    });
    for (const path of [
      "/alice/demo/settings/actions/general/extra", // the C9 page's junk deeper tail
      "/alice/demo/settings/actions/general/actions_unit/extra", // the write tail's junk deeper tail
      "/alice/demo/settings/actions/scoped-workflows",
      "/alice/demo/settings/actions/secret", // the singular misspelling
      "/alice/demo/settings/actions/secrets/extra",
      "/alice/demo/settings/actions/variables/new/extra",
      "/alice/demo/settings/actions/variables/junk/edit", // the digits-only id claim
      "/alice/demo/settings/actions/variables/12.5/delete",
    ]) {
      expect(parseUiRoute(path)).toBeNull();
      expect(handlesUiRoute(path)).toBe(false);
    }
    expect(handlesUiRoute("/alice/demo/settings/actions/secrets")).toBe(true);
    expect(handlesUiRoute("/alice/demo/settings/actions/variables/12/delete")).toBe(true);
  });
});
