/**
 * The org settings ACTIONS tab's tests (the bench-row UNMOUNTED module —
 * the user-settings-secrets.test.tsx harness): the parse/apply/delete matrix
 * over real D1 through the LANDED secrets-variables service at the ORG owner
 * scope (generated migrations in beforeAll; migration 0021's `secrets` +
 * `action_variables` stores) and the DOM contract of both page renders —
 * hono/jsx renderToString, the modules driven directly (no routes yet, the
 * HANDOFF NOTE in the module header).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import {
  createOrUpdateSecret,
  createVariableRow,
  listSecretRows,
  listVariableRows,
  ownerScope,
  repoScope,
} from "../../api/services/secrets-variables";
import { actionVariables, secrets } from "../../db/schema";
import type { OrgRecord } from "../../services/orgs/orgs";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  applyOrgActionsSecretForm,
  applyOrgActionsVariableCreate,
  applyOrgActionsVariableUpdate,
  deleteOrgActionsSecret,
  deleteOrgActionsVariable,
  formatActionsDate,
  loadOrgActionsSecretsPageData,
  loadOrgActionsVariablesPageData,
  ORG_ACTIONS_DESCRIPTION_MAXLENGTH,
  ORG_ACTIONS_NAME_PATTERN,
  ORG_ACTIONS_SECRET_DATA_MAXLENGTH,
  ORG_ACTIONS_VARIABLE_DATA_MAXLENGTH,
  OrgActionsSecretRowItem,
  OrgActionsSecretsPage,
  OrgActionsVariableRowItem,
  OrgActionsVariablesPage,
  orgSettingsActionsLocale,
  parseOrgActionsSecretDeleteForm,
  parseOrgActionsSecretForm,
  parseOrgActionsVariableForm,
  parseOrgActionsVariablePathId,
  renderOrgActionsSecretsPage,
  renderOrgActionsVariablesPage,
} from "./org-settings-actions";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";
const ORG_ID = 7;
const ORG_LINK = "/coalition";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

const org: OrgRecord = {
  id: ORG_ID,
  username: "coalition",
  usernameLower: "coalition",
  email: null,
  fullName: "The Coalition",
  description: null,
  website: null,
  location: null,
  avatarEmail: null,
  useCustomAvatar: false,
  visibility: "public",
  numMembers: 2,
  repoAdminChangeTeamAccess: false,
  createdAt: T0,
};

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["secrets", "action_variables", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
});

async function seedOrgSecret(name: string, data: string, description = ""): Promise<void> {
  await createOrUpdateSecret(env.DB, ownerScope(ORG_ID), name, data, description);
}

async function seedOrgVariable(name: string, data: string, description = ""): Promise<void> {
  await createVariableRow(env.DB, ownerScope(ORG_ID), name, data, description);
}

async function secretsHtml(error: string | null = null, form = { name: "", data: "", description: "" }): Promise<string> {
  const data = await loadOrgActionsSecretsPageData(env.DB, org);
  return renderToString(<OrgActionsSecretsPage ctx={ctx} data={{ ...data, form }} error={error} />);
}

async function variablesHtml(error: string | null = null, form = { name: "", data: "", description: "" }): Promise<string> {
  const data = await loadOrgActionsVariablesPageData(env.DB, org);
  return renderToString(<OrgActionsVariablesPage ctx={ctx} data={{ ...data, form }} error={error} />);
}

// --- the secrets sub-tab --------------------------------------------------------

describe("loadOrgActionsSecretsPageData (the 0021 store, the ORG owner scope)", () => {
  it("answers the empty list on a fresh store", async () => {
    const data = await loadOrgActionsSecretsPageData(env.DB, org);
    expect(data.secrets).toEqual([]);
    expect(data.form).toEqual({ name: "", data: "", description: "" });
  });

  it("lists the org's owner-scope rows name-ordered, hiding repo-scoped and foreign rows", async () => {
    await seedOrgSecret("BETA", "b-value");
    await seedOrgSecret("ALPHA", "a-value", "first");
    // A repo-scope row (the BelongingScopeRepo encoding) and another owner's
    // owner-scope row stay hidden.
    await createOrUpdateSecret(env.DB, repoScope("repo-1"), "REPO_ROW", "x", "");
    await createOrUpdateSecret(env.DB, ownerScope(9), "FOREIGN", "f-value", "");

    const data = await loadOrgActionsSecretsPageData(env.DB, org);
    expect(data.secrets.map((row) => row.name)).toEqual(["ALPHA", "BETA"]); // ToOrders "name"
  });
});

describe("parseOrgActionsSecretForm (the dialog's three fields)", () => {
  it("parses name/data/description", () => {
    expect(parseOrgActionsSecretForm(new URLSearchParams({ name: "A", data: "v", description: "d" }))).toEqual({
      name: "A",
      data: "v",
      description: "d",
    });
  });

  it("absent fields parse empty (the urlencoded convention)", () => {
    expect(parseOrgActionsSecretForm(new URLSearchParams())).toEqual({ name: "", data: "", description: "" });
  });
});

describe("applyOrgActionsSecretForm (SecretsPost → PerformSecretsPost over createOrUpdateSecret)", () => {
  it("creates, then updates by the same name (the dialog's edit re-posts the name)", async () => {
    expect(await applyOrgActionsSecretForm(env.DB, ORG_ID, { name: "ORG_SECRET", data: "v1", description: "first" })).toEqual({
      outcome: "saved",
    });
    let rows = (await listSecretRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("ORG_SECRET");

    expect(await applyOrgActionsSecretForm(env.DB, ORG_ID, { name: "ORG_SECRET", data: "v2", description: "second" })).toEqual({
      outcome: "saved",
    });
    rows = (await listSecretRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toBe("v2");
    expect(rows[0]!.description).toBe("second");
  });

  it("EOL-normalizes the submitted value before the service call (the web write path, scope-shared)", async () => {
    await applyOrgActionsSecretForm(env.DB, ORG_ID, { name: "MULTILINE", data: "line1\r\nline2\r\nline3", description: "" });
    const rows = (await listSecretRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows;
    expect(rows[0]!.data).toBe("line1\nline2\nline3");
  });

  it("the upsert is scope-guarded — another owner's same-name row is untouched", async () => {
    await createOrUpdateSecret(env.DB, ownerScope(9), "SHARED", "theirs", "");
    expect(await applyOrgActionsSecretForm(env.DB, ORG_ID, { name: "SHARED", data: "ours", description: "" })).toEqual({
      outcome: "saved",
    });
    const all = await drizzle(env.DB).select().from(secrets);
    expect(all).toHaveLength(2);
    expect(all.find((row) => row.ownerId === 9)!.data).toBe("theirs");
    expect(all.find((row) => row.ownerId === ORG_ID)!.data).toBe("ours");
  });

  it("surfaces the service's exact validation texts as invalid outcomes", async () => {
    expect(await applyOrgActionsSecretForm(env.DB, ORG_ID, { name: "9bad", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: orgSettingsActionsLocale.invalid_name_pattern,
    });
    expect(await applyOrgActionsSecretForm(env.DB, ORG_ID, { name: "GITEA_TOKEN", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: orgSettingsActionsLocale.invalid_name_prefix,
    });
    expect(await applyOrgActionsSecretForm(env.DB, ORG_ID, { name: "github_x", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: orgSettingsActionsLocale.invalid_name_prefix,
    });
    expect(await applyOrgActionsSecretForm(env.DB, ORG_ID, { name: "ci", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: orgSettingsActionsLocale.reserved_ci,
    });
    expect(await applyOrgActionsSecretForm(env.DB, ORG_ID, { name: "TOO_BIG", data: "x".repeat(65537), description: "" })).toEqual({
      outcome: "invalid",
      message: orgSettingsActionsLocale.data_too_long,
    });
    expect((await listSecretRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows).toHaveLength(0); // nothing partially written
  });
});

describe("deleteOrgActionsSecret (SecretsDelete → PerformSecretsDelete)", () => {
  beforeEach(async () => {
    await seedOrgSecret("DOOMED", "v");
  });

  it("parses the id field (absent/junk → null, the FormInt64 convention)", () => {
    expect(parseOrgActionsSecretDeleteForm(new URLSearchParams({ id: "12" }))).toEqual({ id: 12 });
    expect(parseOrgActionsSecretDeleteForm(new URLSearchParams())).toEqual({ id: null });
    expect(parseOrgActionsSecretDeleteForm(new URLSearchParams({ id: "junk" }))).toEqual({ id: null });
  });

  it("deletes the scoped row by id", async () => {
    const row = (await listSecretRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    expect(await deleteOrgActionsSecret(env.DB, ORG_ID, { id: row.id })).toBe("deleted");
    expect((await listSecretRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows).toHaveLength(0);
  });

  it("answers missing for a null id, a stale id, and a foreign id — every arm deletes nothing", async () => {
    const row = (await listSecretRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    expect(await deleteOrgActionsSecret(env.DB, ORG_ID, { id: null })).toBe("missing");
    expect(await deleteOrgActionsSecret(env.DB, ORG_ID, { id: row.id + 1000 })).toBe("missing");
    expect(await deleteOrgActionsSecret(env.DB, 9, { id: row.id })).toBe("missing"); // another owner's scope
    expect((await listSecretRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows).toHaveLength(1);
  });

  it("is idempotent — a repeated delete answers missing", async () => {
    const row = (await listSecretRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    expect(await deleteOrgActionsSecret(env.DB, ORG_ID, { id: row.id })).toBe("deleted");
    expect(await deleteOrgActionsSecret(env.DB, ORG_ID, { id: row.id })).toBe("missing");
  });
});

// --- the variables sub-tab ------------------------------------------------------

describe("loadOrgActionsVariablesPageData (the 0021 store, the ORG owner scope)", () => {
  it("answers the empty list on a fresh store", async () => {
    const data = await loadOrgActionsVariablesPageData(env.DB, org);
    expect(data.variables).toEqual([]);
    expect(data.form).toEqual({ name: "", data: "", description: "" });
  });

  it("lists the org's owner-scope rows name-ordered, hiding repo-scoped and foreign rows", async () => {
    await seedOrgVariable("BETA", "b-value");
    await seedOrgVariable("ALPHA", "a-value", "first");
    await createVariableRow(env.DB, repoScope("repo-1"), "REPO_ROW", "x", "");
    await createVariableRow(env.DB, ownerScope(9), "FOREIGN", "f-value", "");

    const data = await loadOrgActionsVariablesPageData(env.DB, org);
    expect(data.variables.map((row) => row.name)).toEqual(["ALPHA", "BETA"]);
  });
});

describe("parseOrgActionsVariableForm + parseOrgActionsVariablePathId", () => {
  it("parses name/data/description; absent fields parse empty", () => {
    expect(parseOrgActionsVariableForm(new URLSearchParams({ name: "A", data: "v", description: "d" }))).toEqual({
      name: "A",
      data: "v",
      description: "d",
    });
    expect(parseOrgActionsVariableForm(new URLSearchParams())).toEqual({ name: "", data: "", description: "" });
  });

  it("the path id is digits-only (junk/absent → null, the PathParamInt64 convention)", () => {
    expect(parseOrgActionsVariablePathId("12")).toBe(12);
    expect(parseOrgActionsVariablePathId("junk")).toBeNull();
    expect(parseOrgActionsVariablePathId("")).toBeNull();
  });
});

describe("applyOrgActionsVariableCreate (VariableCreate → CreateVariable)", () => {
  it("creates the row — UPPERCASE name, EOL-normalized value (the service-side arms)", async () => {
    expect(await applyOrgActionsVariableCreate(env.DB, ORG_ID, { name: "org_var", data: "line1\r\nline2", description: "d" })).toEqual({
      outcome: "saved",
    });
    const rows = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("ORG_VAR");
    expect(rows[0]!.data).toBe("line1\nline2");
    expect(rows[0]!.description).toBe("d");
  });

  it("surfaces the service's exact validation texts as invalid outcomes", async () => {
    expect(await applyOrgActionsVariableCreate(env.DB, ORG_ID, { name: "9bad", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: orgSettingsActionsLocale.invalid_name_pattern,
    });
    expect(await applyOrgActionsVariableCreate(env.DB, ORG_ID, { name: "GITHUB_X", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: orgSettingsActionsLocale.invalid_name_prefix,
    });
    expect(await applyOrgActionsVariableCreate(env.DB, ORG_ID, { name: "TOO_BIG", data: "x".repeat(65537), description: "" })).toEqual({
      outcome: "invalid",
      message: orgSettingsActionsLocale.data_too_long,
    });
    expect((await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows).toHaveLength(0);
  });
});

describe("applyOrgActionsVariableUpdate (VariableUpdate over the landed updateVariableRow)", () => {
  beforeEach(async () => {
    await seedOrgVariable("EDITABLE", "old-value", "old-desc");
  });

  it("overwrites name/data/description through the row's stored name", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    expect(await applyOrgActionsVariableUpdate(env.DB, ORG_ID, row.id, { name: "renamed_var", data: "new-value", description: "new-desc" })).toEqual({
      outcome: "saved",
    });
    const rows = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("RENAMED_VAR"); // the rename re-normalizes
    expect(rows[0]!.data).toBe("new-value");
    expect(rows[0]!.description).toBe("new-desc");
  });

  it("an empty form name rides the zero-value fallback (keeps the stored name)", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    expect(await applyOrgActionsVariableUpdate(env.DB, ORG_ID, row.id, { name: "", data: "kept-value", description: "" })).toEqual({
      outcome: "saved",
    });
    const rows = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows;
    expect(rows[0]!.name).toBe("EDITABLE");
    expect(rows[0]!.data).toBe("kept-value");
  });

  it("an invalid rename surfaces the service text without writing", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    expect(await applyOrgActionsVariableUpdate(env.DB, ORG_ID, row.id, { name: "9bad", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: orgSettingsActionsLocale.invalid_name_pattern,
    });
    expect((await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!.data).toBe("old-value");
  });

  it("answers missing for a null, stale, or foreign id — nothing written", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    expect(await applyOrgActionsVariableUpdate(env.DB, ORG_ID, null, { name: "X", data: "v", description: "" })).toEqual({ outcome: "missing" });
    expect(await applyOrgActionsVariableUpdate(env.DB, ORG_ID, row.id + 1000, { name: "X", data: "v", description: "" })).toEqual({
      outcome: "missing",
    });
    expect(await applyOrgActionsVariableUpdate(env.DB, 9, row.id, { name: "X", data: "v", description: "" })).toEqual({ outcome: "missing" });
    expect((await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!.data).toBe("old-value");
  });
});

describe("deleteOrgActionsVariable (VariableDelete over the landed deleteVariableRow)", () => {
  beforeEach(async () => {
    await seedOrgVariable("DOOMED", "v");
  });

  it("deletes the scoped row by id", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    expect(await deleteOrgActionsVariable(env.DB, ORG_ID, row.id)).toBe("deleted");
    expect((await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows).toHaveLength(0);
  });

  it("answers missing for a null, stale, or foreign id", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    expect(await deleteOrgActionsVariable(env.DB, ORG_ID, null)).toBe("missing");
    expect(await deleteOrgActionsVariable(env.DB, ORG_ID, row.id + 1000)).toBe("missing");
    expect(await deleteOrgActionsVariable(env.DB, 9, row.id)).toBe("missing");
    expect((await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows).toHaveLength(1);
  });

  it("is idempotent — a repeated delete answers missing", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    expect(await deleteOrgActionsVariable(env.DB, ORG_ID, row.id)).toBe("deleted");
    expect(await deleteOrgActionsVariable(env.DB, ORG_ID, row.id)).toBe("missing");
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the secrets page DOM (org/settings/actions.tmpl PageType secrets + shared/secrets/add_list.tmpl)", () => {
  it("renders the page discriminator, OrgHeader scope, and the navbar with the Actions disclosure open + Secrets active", async () => {
    const html = await secretsHtml();
    expect(html).toContain("organization settings actions"); // layout_head's pageClass
    expect(html).toContain("<details"); // navbar.tmpl:29's disclosure
    expect(html).toContain("open"); // the PageIsSharedSettingsSecrets open arm
    expect(html).toContain('class="active item" href="/coalition/settings/actions/secrets"');
    expect(html).toContain('href="/coalition/settings/actions/variables"'); // the sibling sub-item
    expect(html).toContain('href="/coalition/settings"'); // the landed settings tabs stay linked
    expect(html).toContain('href="/coalition/settings/hooks"');
    expect(html).toContain('href="/coalition/labels"');
    expect(html).not.toContain("settings/actions/runners"); // the unlanded sub-items render nothing
    expect(html).not.toContain("scoped-workflows");
  });

  it("renders the empty arm (secrets.none) and the add form with the upstream contract", async () => {
    const html = await secretsHtml();
    expect(html).toContain(orgSettingsActionsLocale.secrets_management);
    expect(html).toContain(orgSettingsActionsLocale.secrets_none);
    expect(html).toContain('action="/coalition/settings/actions/secrets"');
    expect(html).toContain('name="name"');
    expect(html).toContain(`pattern="${ORG_ACTIONS_NAME_PATTERN}"`); // add_list.tmpl:81
    expect(html).toContain("MY_SECRET_NAME"); // add_list.tmpl:83's placeholder
    expect(html).toContain(`maxlength="${ORG_ACTIONS_SECRET_DATA_MAXLENGTH}"`); // {{.DataMaxLength}}
    expect(html).toContain(`maxlength="${ORG_ACTIONS_DESCRIPTION_MAXLENGTH}"`);
    expect(html).toContain(orgSettingsActionsLocale.value_placeholder);
    expect(html).toContain(orgSettingsActionsLocale.description_placeholder);
    expect(html).toContain(orgSettingsActionsLocale.secrets_description); // the dialog's lead line
    expect(html).toContain(`>${orgSettingsActionsLocale.add_secret}</button>`);
  });

  it("renders the list rows: glyph, name, description-or-dash, ******, added-on, no plaintext", async () => {
    await seedOrgSecret("ALPHA", "alpha-plaintext-value", "the first one");
    await seedOrgSecret("BETA", "beta-plaintext-value", "");
    const data = await loadOrgActionsSecretsPageData(env.DB, org);
    const html = renderToString(<OrgActionsSecretsPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain("flex-divided-list items-with-main");
    expect(html).toContain(">ALPHA</div>");
    expect(html).toContain(">BETA</div>");
    expect(html).toContain("the first one");
    expect(html).toContain('<div class="item-body">-</div>'); // the empty-description dash arm
    expect(html).toContain("******");
    expect(html).toContain("Added on"); // settings.added_on
    expect(html).not.toContain("alpha-plaintext-value"); // the value never enters the DOM
    expect(html).not.toContain("beta-plaintext-value");
    expect(html).not.toContain(orgSettingsActionsLocale.secrets_none);
  });

  it("renders the edit disclosures: read-only name, EMPTY value, and the remove id forms", async () => {
    await seedOrgSecret("EDITABLE", "secret-value", "");
    const row = (await listSecretRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    const html = await secretsHtml();
    expect(html).toContain("<details>"); // the modal reduction
    expect(html).toContain(orgSettingsActionsLocale.edit_secret);
    expect(html).toContain('value="EDITABLE"');
    expect(html).toContain('readOnly="true"'); // add_list.tmpl:46's read-only arm
    expect(html).not.toContain("secret-value"); // add_list.tmpl:47's empty data arm
    expect(html).toContain('action="/coalition/settings/actions/secrets/delete"');
    expect(html).toContain(`name="id" value="${String(row.id)}"`);
    expect(html).toContain(orgSettingsActionsLocale.remove);
    expect(html).not.toContain("show-modal"); // the JS modal pair is not reproduced
    expect(html).not.toContain("link-action");
  });

  it("the error slot renders the negative message and the submitted form re-renders", async () => {
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

  it("the row component keys the masked body and the org-scoped delete URL", async () => {
    await seedOrgSecret("ROW_SHAPE", "v", "");
    const row = (await listSecretRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    const html = renderToString(<OrgActionsSecretRowItem orgLink={ORG_LINK} row={row} />);
    expect(html).toContain('class="item-main"');
    expect(html).toContain("******");
    expect(html).not.toContain(">v<");
    expect(html).toContain(`action="${ORG_LINK}/settings/actions/secrets/delete"`);
  });

  it("the full-document render path matches the component path", async () => {
    const data = await loadOrgActionsSecretsPageData(env.DB, org);
    const html = renderOrgActionsSecretsPage(ctx, data);
    expect(html).toContain("organization settings actions");
    expect(html).toContain(orgSettingsActionsLocale.secrets_none);
  });

  it("leaves no stale rows behind after the delete flow (the store round-trip)", async () => {
    await seedOrgSecret("GONE", "v");
    const row = (await listSecretRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    await deleteOrgActionsSecret(env.DB, ORG_ID, { id: row.id });
    expect(await drizzle(env.DB).select().from(secrets).where(eq(secrets.id, row.id)).get()).toBeUndefined();
  });
});

describe("the variables page DOM (org/settings/actions.tmpl PageType variables + shared/variables/variable_list.tmpl)", () => {
  it("renders the page discriminator and the navbar with the Actions disclosure open + Variables active", async () => {
    const html = await variablesHtml();
    expect(html).toContain("organization settings actions");
    expect(html).toContain("<details");
    expect(html).toContain("open");
    expect(html).toContain('class="active item" href="/coalition/settings/actions/variables"');
    expect(html).toContain('href="/coalition/settings/actions/secrets"'); // the sibling sub-item
  });

  it("renders the empty arm (actions.variables.none) and the add form posting to /new", async () => {
    const html = await variablesHtml();
    expect(html).toContain(orgSettingsActionsLocale.variables_management);
    expect(html).toContain(orgSettingsActionsLocale.variables_none);
    expect(html).toContain('action="/coalition/settings/actions/variables/new"');
    expect(html).toContain(`pattern="${ORG_ACTIONS_NAME_PATTERN}"`);
    expect(html).toContain("MY_VARIABLE_NAME"); // variable_list.tmpl:81's placeholder
    expect(html).toContain(`maxlength="${ORG_ACTIONS_VARIABLE_DATA_MAXLENGTH}"`);
    expect(html).toContain(orgSettingsActionsLocale.variables_description); // the dialog's lead line
    expect(html).toContain(`>${orgSettingsActionsLocale.add_variable}</button>`);
  });

  it("renders the list rows with the value IN PLAINTEXT (variables are not masked)", async () => {
    await seedOrgVariable("ALPHA", "alpha-open-value", "desc one");
    await seedOrgVariable("BETA", "beta-open-value", "");
    const data = await loadOrgActionsVariablesPageData(env.DB, org);
    const html = renderToString(<OrgActionsVariablesPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain(">ALPHA</div>");
    expect(html).toContain("alpha-open-value"); // variable_list.tmpl:31-33 — the plaintext body
    expect(html).toContain("beta-open-value");
    expect(html).toContain('<div class="item-body">-</div>');
    expect(html).not.toContain("******");
    expect(html).not.toContain(orgSettingsActionsLocale.variables_none);
  });

  it("renders the edit disclosures prefilled (name NOT read-only) posting to the row's edit URL, and the path-id delete forms", async () => {
    await seedOrgVariable("EDITABLE", "kept-value", "kept-desc");
    const row = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    const html = await variablesHtml();
    expect(html).toContain('value="EDITABLE"');
    expect(html).toContain("kept-value"); // the dialog pre-fills all three fields
    expect(html).toContain("kept-desc");
    expect(html).not.toContain('readOnly="true"'); // no read-only arm in the variables dialog
    expect(html).toContain(`action="/coalition/settings/actions/variables/${row.id}/edit"`);
    expect(html).toContain(`action="/coalition/settings/actions/variables/${row.id}/delete"`); // the id in the path
    expect(html).toContain(orgSettingsActionsLocale.deletion);
    expect(html).toContain("octicon-trash");
  });

  it("the error slot renders the negative message and the submitted form re-renders", async () => {
    const html = await variablesHtml("name must start with a letter or underscore and contain only letters, numbers, and underscores", {
      name: "9bad",
      data: "kept",
      description: "also kept",
    });
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain('value="9bad"');
    expect(html).toContain("kept");
  });

  it("the row component keys the plaintext body and the org-scoped edit/delete URLs", async () => {
    await seedOrgVariable("ROW_SHAPE", "row-value", "");
    const row = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    const html = renderToString(<OrgActionsVariableRowItem orgLink={ORG_LINK} row={row} />);
    expect(html).toContain("row-value");
    expect(html).toContain(`action="${ORG_LINK}/settings/actions/variables/${row.id}/edit"`);
    expect(html).toContain(`action="${ORG_LINK}/settings/actions/variables/${row.id}/delete"`);
  });

  it("the full-document render path matches the component path", async () => {
    const data = await loadOrgActionsVariablesPageData(env.DB, org);
    const html = renderOrgActionsVariablesPage(ctx, data);
    expect(html).toContain("organization settings actions");
    expect(html).toContain(orgSettingsActionsLocale.variables_none);
  });

  it("leaves no stale rows behind after the delete flow (the store round-trip)", async () => {
    await seedOrgVariable("GONE", "v");
    const row = (await listVariableRows(env.DB, ownerScope(ORG_ID), 1, 10)).rows[0]!;
    await deleteOrgActionsVariable(env.DB, ORG_ID, row.id);
    expect(await drizzle(env.DB).select().from(actionVariables).where(eq(actionVariables.id, row.id)).get()).toBeUndefined();
  });
});

// --- the shared chrome ------------------------------------------------------------

describe("the shared chrome", () => {
  it("formatActionsDate renders upstream's AbsoluteShort in UTC", () => {
    expect(formatActionsDate(T0)).toBe("Nov 14, 2023");
  });

  it("both pages render the OrgHeader with the org identity", async () => {
    const secrets = await secretsHtml();
    const variables = await variablesHtml();
    expect(secrets).toContain("The Coalition");
    expect(variables).toContain("The Coalition");
  });
});
