/**
 * The user settings ACTIONS VARIABLES tab's tests (the bench-row UNMOUNTED
 * module — the user-settings-secrets.test.tsx sibling harness): the
 * parse/create/update/delete matrix over real D1 through the LANDED
 * secrets-variables service (generated migrations in beforeAll; migration
 * 0021's `action_variables` store) and the DOM contract of the page render —
 * hono/jsx renderToString, the module driven directly (no route yet, the
 * HANDOFF NOTE in the module header).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createVariableRow, listVariableRows, ownerScope } from "../../api/services/secrets-variables";
import { actionVariables } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  applyUserSettingsVariableCreate,
  applyUserSettingsVariableUpdate,
  deleteUserSettingsVariable,
  formatVariableDate,
  loadUserSettingsVariablesPageData,
  parseUserSettingsVariableForm,
  parseUserSettingsVariablePathId,
  renderUserSettingsVariablesPage,
  VARIABLE_DATA_MAXLENGTH,
  VARIABLE_DESCRIPTION_MAXLENGTH,
  VARIABLE_NAME_PATTERN,
  userSettingsVariablesLocale,
  VariableRowItem,
  UserSettingsVariablesPage,
} from "./user-settings-variables";

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

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["action_variables", "secrets", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
});

async function seedVariable(name: string, data: string, description = "", ownerId = 1): Promise<void> {
  await createVariableRow(env.DB, ownerScope(ownerId), name, data, description);
}

async function pageHtml(error: string | null = null, form = { name: "", data: "", description: "" }): Promise<string> {
  const data = await loadUserSettingsVariablesPageData(env.DB, 1);
  return renderToString(<UserSettingsVariablesPage ctx={ctx} data={{ ...data, form }} error={error} />);
}

// --- the loader ---------------------------------------------------------------

describe("loadUserSettingsVariablesPageData (the 0021 store, owner scope)", () => {
  it("answers the empty list on a fresh store", async () => {
    const data = await loadUserSettingsVariablesPageData(env.DB, 1);
    expect(data.variables).toEqual([]);
    expect(data.form).toEqual({ name: "", data: "", description: "" });
  });

  it("lists the doer's owner-scope rows name-ordered, hiding repo-scoped and foreign rows", async () => {
    await seedVariable("BETA", "b-value");
    await seedVariable("ALPHA", "a-value", "first");
    // A repo-scope row (owner_id 0 + a repo id — the BelongingScopeRepo
    // encoding) and another doer's owner-scope row stay hidden.
    await env.DB.prepare(
      "INSERT INTO action_variables (owner_id, repo_id, name, data, description, created_unix, updated_unix) VALUES (0, 'repo-1', 'REPO_ROW', 'x', '', 0, 0)",
    ).run();
    await seedVariable("FOREIGN", "f-value", "", 2);

    const data = await loadUserSettingsVariablesPageData(env.DB, 1);
    expect(data.variables.map((row) => row.name)).toEqual(["ALPHA", "BETA"]); // ToOrders "name"
  });
});

// --- the form parse ------------------------------------------------------------

describe("parseUserSettingsVariableForm + parseUserSettingsVariablePathId", () => {
  it("parses name/data/description; absent fields parse empty (the urlencoded convention)", () => {
    expect(parseUserSettingsVariableForm(new URLSearchParams({ name: "A", data: "v", description: "d" }))).toEqual({
      name: "A",
      data: "v",
      description: "d",
    });
    expect(parseUserSettingsVariableForm(new URLSearchParams())).toEqual({ name: "", data: "", description: "" });
  });

  it("parses the {variable_id} path segment (digits only; junk/absent → null, the PathParamInt64 convention)", () => {
    expect(parseUserSettingsVariablePathId("12")).toBe(12);
    expect(parseUserSettingsVariablePathId("junk")).toBeNull();
    expect(parseUserSettingsVariablePathId("")).toBeNull();
    expect(parseUserSettingsVariablePathId("-3")).toBeNull();
    expect(parseUserSettingsVariablePathId("12.5")).toBeNull();
  });
});

// --- the create -----------------------------------------------------------------

describe("applyUserSettingsVariableCreate (VariableCreate → CreateVariable over createVariableRow)", () => {
  it("creates the row UPPERCASE-normalized", async () => {
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "my_var", data: "v1", description: "first" })).toEqual({
      outcome: "saved",
    });
    const rows = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("MY_VAR");
    expect(rows[0]!.data).toBe("v1");
    expect(rows[0]!.description).toBe("first");
  });

  it("EOL-normalizes the value (the landed service mirrors InsertVariable/UpdateVariableNameData — no module twin)", async () => {
    await applyUserSettingsVariableCreate(env.DB, 1, { name: "MULTILINE", data: "line1\r\nline2\r\nline3", description: "" });
    const rows = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows[0]!.data).toBe("line1\nline2\nline3");
  });

  it("surfaces the service's exact validation texts as invalid outcomes", async () => {
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "9bad", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsVariablesLocale.invalid_name_pattern,
    });
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "GITEA_TOKEN", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsVariablesLocale.invalid_name_prefix,
    });
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "github_x", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsVariablesLocale.invalid_name_prefix,
    });
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "ci", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsVariablesLocale.reserved_ci,
    });
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "TOO_BIG", data: "x".repeat(65537), description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsVariablesLocale.data_too_long,
    });
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(0); // nothing partially written
  });
});

// --- the update -----------------------------------------------------------------

describe("applyUserSettingsVariableUpdate (VariableUpdate: findActionsVariable → UpdateVariableNameData)", () => {
  beforeEach(async () => {
    await seedVariable("EDITABLE", "old-value", "old-description");
  });

  it("renames and rewrites data+description by the path id (the row's own edit URL)", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(
      await applyUserSettingsVariableUpdate(env.DB, 1, row.id, { name: "renamed_var", data: "new-value", description: "new-description" }),
    ).toEqual({ outcome: "saved" });
    const rows = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(row.id); // same row, renamed in place
    expect(rows[0]!.name).toBe("RENAMED_VAR");
    expect(rows[0]!.data).toBe("new-value");
    expect(rows[0]!.description).toBe("new-description");
  });

  it("EOL-normalizes the updated value (UpdateVariableNameData's normalize arm)", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    await applyUserSettingsVariableUpdate(env.DB, 1, row.id, { name: "EDITABLE", data: "a\r\nb", description: "" });
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!.data).toBe("a\nb");
  });

  it("an empty description clears the stored one (upstream assigns the form field verbatim)", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    await applyUserSettingsVariableUpdate(env.DB, 1, row.id, { name: "EDITABLE", data: "v", description: "" });
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!.description).toBe("");
  });

  it("an empty form name keeps the stored name (the service's zero-value fallback — the module header's binding divergence)", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(await applyUserSettingsVariableUpdate(env.DB, 1, row.id, { name: "", data: "v", description: "" })).toEqual({ outcome: "saved" });
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!.name).toBe("EDITABLE");
  });

  it("surfaces the service's exact validation texts as invalid outcomes", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(await applyUserSettingsVariableUpdate(env.DB, 1, row.id, { name: "GITEA_TOKEN", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsVariablesLocale.invalid_name_prefix,
    });
    expect(await applyUserSettingsVariableUpdate(env.DB, 1, row.id, { name: "OK_NAME", data: "x".repeat(65537), description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsVariablesLocale.data_too_long,
    });
    const after = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(after.name).toBe("EDITABLE"); // the failed rename wrote nothing
    expect(after.data).toBe("old-value");
  });

  it("answers missing for a null id, a stale id, and a foreign id — nothing written", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    const form = { name: "X", data: "v", description: "" };
    expect(await applyUserSettingsVariableUpdate(env.DB, 1, null, form)).toEqual({ outcome: "missing" });
    expect(await applyUserSettingsVariableUpdate(env.DB, 1, row.id + 1000, form)).toEqual({ outcome: "missing" });
    expect(await applyUserSettingsVariableUpdate(env.DB, 2, row.id, form)).toEqual({ outcome: "missing" }); // another doer's scope
    const after = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(after.name).toBe("EDITABLE");
    expect(after.data).toBe("old-value");
  });
});

// --- the delete ------------------------------------------------------------------

describe("deleteUserSettingsVariable (VariableDelete → DeleteVariableByID)", () => {
  beforeEach(async () => {
    await seedVariable("DOOMED", "v");
  });

  it("deletes the scoped row by the path id", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(await deleteUserSettingsVariable(env.DB, 1, row.id)).toBe("deleted");
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(0);
  });

  it("answers missing for a null id, a stale id, and a foreign id — every arm deletes nothing", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(await deleteUserSettingsVariable(env.DB, 1, null)).toBe("missing");
    expect(await deleteUserSettingsVariable(env.DB, 1, row.id + 1000)).toBe("missing");
    expect(await deleteUserSettingsVariable(env.DB, 2, row.id)).toBe("missing"); // another doer's scope
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(1);
  });

  it("is idempotent — a repeated delete answers missing (upstream's findActionsVariable arm)", async () => {
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(await deleteUserSettingsVariable(env.DB, 1, row.id)).toBe("deleted");
    expect(await deleteUserSettingsVariable(env.DB, 1, row.id)).toBe("missing");
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the variables page DOM (actions.tmpl PageType variables + shared/variables/variable_list.tmpl at the pin)", () => {
  it("renders the page discriminator, the navbar with the Actions disclosure open and Variables active", async () => {
    const html = await pageHtml();
    expect(html).toContain("user settings actions"); // layout_head's pageClass (actions.tmpl:1)
    expect(html).toContain("<details");
    expect(html).toContain('class="active item" href="/user/settings/actions/variables"');
    expect(html).toContain("open"); // navbar.tmpl:41's open arm
    expect(html).toContain('href="/user/settings/security"'); // the landed sibling tabs
    expect(html).toContain('href="/user/settings/actions/secrets"');
  });

  it("renders the empty arm (actions.variables.none) and the add form with the upstream contract", async () => {
    const html = await pageHtml();
    expect(html).toContain(userSettingsVariablesLocale.variables_management);
    expect(html).toContain(userSettingsVariablesLocale.none);
    expect(html).toContain('action="/user/settings/actions/variables/new"'); // the header button's data-modal-form.url, variable_list.tmpl:6
    expect(html).toContain('name="name"');
    expect(html).toContain(`pattern="${VARIABLE_NAME_PATTERN}"`); // variable_list.tmpl:79
    expect(html).toContain("MY_VARIABLE_NAME"); // the dialog's placeholder arm, variable_list.tmpl:81
    expect(html).toContain(`maxlength="${VARIABLE_DATA_MAXLENGTH}"`); // {{.DataMaxLength}}, variable_list.tmpl:89
    expect(html).toContain(`maxlength="${VARIABLE_DESCRIPTION_MAXLENGTH}"`); // {{.DescriptionMaxLength}}, variable_list.tmpl:99
    expect(html).toContain(userSettingsVariablesLocale.value_placeholder);
    expect(html).toContain(userSettingsVariablesLocale.description_placeholder);
    expect(html).toContain(userSettingsVariablesLocale.variables_description); // the dialog's lead line, variable_list.tmpl:72
    expect(html).toContain(`>${userSettingsVariablesLocale.add_variable}</button>`);
  });

  it("renders the list rows: glyph, name, description-or-dash, the value IN PLAINTEXT, added-on", async () => {
    await seedVariable("ALPHA", "alpha-value-in-the-clear", "the first one");
    await seedVariable("BETA", "beta-value", "");
    const data = await loadUserSettingsVariablesPageData(env.DB, 1);
    const html = renderToString(<UserSettingsVariablesPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain("flex-divided-list items-with-main");
    expect(html).toContain(">ALPHA</div>");
    expect(html).toContain(">BETA</div>");
    expect(html).toContain("the first one");
    expect(html).toContain('<div class="item-body">-</div>'); // the empty-description dash arm
    expect(html).toContain("alpha-value-in-the-clear"); // variable_list.tmpl:32 — NO ****** mask on variables
    expect(html).not.toContain("******");
    expect(html).toContain("Added on"); // settings.added_on
    expect(html).not.toContain(userSettingsVariablesLocale.none);
  });

  it("renders the edit disclosures prefilled with ALL THREE row fields (the one-dialog prefill, variable_list.tmpl:44-46)", async () => {
    await seedVariable("EDITABLE", "edit-value", "edit-description");
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    const html = await pageHtml();
    expect(html).toContain("<details>"); // the modal reduction
    expect(html).toContain(userSettingsVariablesLocale.edit_variable);
    expect(html).toContain('value="EDITABLE"'); // the name prefills — and stays editable (no read-only arm in this dialog)
    expect(html).not.toContain("readOnly"); // unlike the secrets dialog's read-only name arm
    expect(html).toContain(">edit-value</textarea>"); // the value prefills (secrets renders it EMPTY)
    expect(html).toContain(">edit-description</textarea>");
    expect(html).toContain(`action="/user/settings/actions/variables/${row.id}/edit"`); // {{$.Link}}/{{.ID}}/edit
    // The remove form: the id rides the action URL, no hidden field (the delete reduction).
    expect(html).toContain(`action="/user/settings/actions/variables/${row.id}/delete"`);
    expect(html).not.toContain('name="id"');
    expect(html).toContain(userSettingsVariablesLocale.deletion); // the tooltip text as the button label
    expect(html).not.toContain("show-modal"); // the JS modal pair is not reproduced
    expect(html).not.toContain("link-action");
  });

  it("the error slot renders the negative message and the submitted add form re-renders", async () => {
    const html = await pageHtml("name cannot start with 'GITEA_' or 'GITHUB_'", {
      name: "GITEA_TOKEN",
      data: "kept",
      description: "also kept",
    });
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("name cannot start with &#39;GITEA_&#39; or &#39;GITHUB_&#39;");
    expect(html).toContain('value="GITEA_TOKEN"');
    expect(html).toContain("kept");
  });

  it("formatVariableDate renders upstream's AbsoluteShort in UTC", () => {
    expect(formatVariableDate(T0)).toBe("Nov 14, 2023");
  });

  it("the row component keys the plaintext value body (the variable_list row shape)", async () => {
    await seedVariable("ROW_SHAPE", "row-value", "");
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    const html = renderToString(<VariableRowItem row={row} />);
    expect(html).toContain('class="item-main"');
    expect(html).toContain(">row-value<"); // the plaintext arm (inverted vs the secrets row's mask)
    expect(html).toContain(`action="/user/settings/actions/variables/${row.id}/delete"`);
  });

  it("the full-document render path matches the component path", async () => {
    const data = await loadUserSettingsVariablesPageData(env.DB, 1);
    const html = renderUserSettingsVariablesPage(ctx, data);
    expect(html).toContain("user settings actions");
    expect(html).toContain(userSettingsVariablesLocale.none);
  });

  it("leaves no stale rows behind after the delete flow (the store round-trip)", async () => {
    await seedVariable("GONE", "v");
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    await deleteUserSettingsVariable(env.DB, 1, row.id);
    expect(await drizzle(env.DB).select().from(actionVariables).where(eq(actionVariables.id, row.id)).get()).toBeUndefined();
  });
});
