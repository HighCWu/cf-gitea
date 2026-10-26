/**
 * The user settings ACTIONS VARIABLES tab's tests (the user-settings-secrets
 * .test.tsx sibling harness): the parse/create/update/delete matrix over real
 * D1 through the LANDED secrets-variables service (generated migrations in
 * beforeAll; migration 0021's `action_variables` store) and the DOM contract
 * of the page render — hono/jsx renderToString, the module driven directly.
 *
 * The deferred matrix (the polish wave, after the window-2a mount): the
 * name-pattern/boundary/UNIQUE arms the bench row left out, plus the MOUNTED
 * route arms driven through `uiRouter.fetch()` with a minted session (GET
 * /user/settings/actions/variables, POST new, POST :id/edit, POST :id/delete
 * — the keep-name fallback, the empty-form re-render, the duplicate-name
 * UNIQUE 500 and the findActionsVariable 404 shell, upstream's
 * NotFound(nil)/JSONErrorAuto fidelity).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createVariableRow, listVariableRows, ownerScope } from "../../api/services/secrets-variables";
import { actionVariables } from "../../db/schema";
import { locale } from "../locale";
import { uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
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

// --- the deferred create matrix (the polish wave) --------------------------------

/** The wrapped driver error's text (DrizzleQueryError carries the SQLite
 *  message on `cause`; no casts — the ES2022 Error.cause chain). */
function errorCauseMessage(error: unknown): string {
  return error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
}

describe("applyUserSettingsVariableCreate — the deferred name-pattern matrix", () => {
  it("accepts the underscore-lead name (the pattern's second first-char arm)", async () => {
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "_lead_ok", data: "v", description: "" })).toEqual({
      outcome: "saved",
    });
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!.name).toBe("_LEAD_OK");
  });

  it("rejects the remaining pattern violators with the service's exact text — hyphen, space, non-ASCII — nothing written", async () => {
    for (const name of ["HAS-HYPHEN", "HAS SPACE", "CAFÉ"]) {
      expect(await applyUserSettingsVariableCreate(env.DB, 1, { name, data: "v", description: "" })).toEqual({
        outcome: "invalid",
        message: userSettingsVariablesLocale.invalid_name_pattern,
      });
    }
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(0);
  });

  it("rejects the uppercase GITHUB_ prefix and the mixed-case CI reservation (the case-insensitive arms)", async () => {
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "GITHUB_TOKEN", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsVariablesLocale.invalid_name_prefix,
    });
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "Ci", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsVariablesLocale.reserved_ci,
    });
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(0);
  });

  it("accepts a name beyond the upstream binding's MaxSize(255) (the documented binding divergence — the pattern attr carries the browser arm)", async () => {
    const name = `LONG_${"X".repeat(295)}`; // 300 chars, pattern-clean
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name, data: "v", description: "" })).toEqual({ outcome: "saved" });
    // Stored UPPERCASE and uncapped — services/forms/user_form.go:237 is a
    // form-binding arm the reduction deliberately does not carry server-side
    // (the module header's divergence note).
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!.name).toHaveLength(300);
  });

  it("rides the exact 65536-rune data boundary and rune-counts multibyte values (utf8.RuneCountInString, not UTF-16)", async () => {
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "BOUNDARY", data: "v".repeat(65_536), description: "" })).toEqual({
      outcome: "saved",
    });
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "EMOJI_BOUNDARY", data: "🎉".repeat(65_536), description: "" })).toEqual({
      outcome: "saved",
    }); // 65_536 runes = 131_072 UTF-16 units — runes are what count
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "EMOJI_OVER", data: "🎉".repeat(65_537), description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsVariablesLocale.data_too_long,
    });
  });

  it("truncates a beyond-cap description instead of rejecting it (InsertVariable's TruncateRunes arm)", async () => {
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "DESCRIBED", data: "v", description: "d".repeat(5_000) })).toEqual({
      outcome: "saved",
    });
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!.description).toHaveLength(4_096);
  });

  it("an empty create form parses to the invalid-pattern arm (the route's empty-form re-render root)", async () => {
    expect(await applyUserSettingsVariableCreate(env.DB, 1, { name: "", data: "", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsVariablesLocale.invalid_name_pattern,
    });
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(0);
  });

  it("a duplicate name propagates the UNIQUE(owner_repo_name) violation — no web pre-check, upstream's JSONErrorAuto 500 arm", async () => {
    await seedVariable("DUP", "original");
    // Drizzle wraps the driver error in DrizzleQueryError ("Failed query: …");
    // the SQLite UNIQUE text rides the `cause` (the helper below).
    const first = await applyUserSettingsVariableCreate(env.DB, 1, { name: "DUP", data: "v", description: "" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(Error); // the non-ApiError propagates — never an "invalid" outcome
    expect(errorCauseMessage(first)).toMatch(/UNIQUE constraint failed/);
    // The UPPERCASE normalization collides case-insensitively.
    const second = await applyUserSettingsVariableCreate(env.DB, 1, { name: "dup", data: "v", description: "" }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(errorCauseMessage(second)).toMatch(/UNIQUE constraint failed/);
    const rows = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toBe("original"); // nothing partial written
  });
});

describe("applyUserSettingsVariableUpdate — the deferred exact-boundary arm", () => {
  it("rides the exact 65536-rune data boundary on update too", async () => {
    await seedVariable("BOUNDARY_EDIT", "old");
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(
      await applyUserSettingsVariableUpdate(env.DB, 1, row.id, { name: "BOUNDARY_EDIT", data: "v".repeat(65_536), description: "" }),
    ).toEqual({ outcome: "saved" });
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!.data).toHaveLength(65_536);
  });
});

// --- the mounted route arms (the window-2a mount, driven through uiRouter.fetch) --

type VariablesUiTestEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const variablesAssets: UiAssetsFetcher = {
  fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })),
};

const variablesUiEnv: VariablesUiTestEnv = { ...env, ASSETS: variablesAssets };

/** A signed-in session cookie for the seeded doer (the beforeEach user 1). */
async function mintDoerCookie(): Promise<string> {
  return mintSession(env.DB, 1);
}

async function getVariablesRoute(cookie: string | null): Promise<Response> {
  return uiRouter.fetch(
    new Request(`${ORIGIN}/user/settings/actions/variables`, {
      headers: cookie === null ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    }),
    variablesUiEnv,
  );
}

async function postVariablesRoute(path: string, fields: Record<string, string>, cookie: string): Promise<Response> {
  return uiRouter.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN, // sameOriginGuard's matching-origin arm
        cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
      },
      body: new URLSearchParams(fields).toString(),
    }),
    variablesUiEnv,
  );
}

/** The findActionsVariable miss — upstream's ctx.NotFound(nil) fidelity: the
 *  404 SHELL answers, never the re-rendered tab (the module handoff's call). */
async function expectNotFoundShell(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const html = await res.text();
  expect(html).toContain(locale.error404_box_title);
  expect(html).not.toContain(userSettingsVariablesLocale.variables_management);
}

describe("the mounted /user/settings/actions/variables route arms (window-2a)", () => {
  it("GET renders the tab for the session doer and 303s the anonymous doer onto the login round-trip", async () => {
    const res = await getVariablesRoute(await mintDoerCookie());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("user settings actions");
    expect(html).toContain('action="/user/settings/actions/variables/new"');
    const anon = await getVariablesRoute(null);
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login");
  });

  it("POST new saves through the mount — 303 onto the list, the row stored UPPERCASE", async () => {
    const res = await postVariablesRoute(
      "/user/settings/actions/variables/new",
      { name: "route_made", data: "route-value", description: "route-desc" },
      await mintDoerCookie(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/user/settings/actions/variables");
    const rows = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows.map((row) => row.name)).toEqual(["ROUTE_MADE"]);
    expect(rows[0]!.description).toBe("route-desc");
  });

  it("POST new with an empty form re-renders the tab with the service's invalid-pattern line and the empty submitted fields", async () => {
    const res = await postVariablesRoute("/user/settings/actions/variables/new", {}, await mintDoerCookie()); // every field absent
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">');
    expect(html).toContain(userSettingsVariablesLocale.invalid_name_pattern);
    expect(html).toContain('value=""'); // the empty submitted name re-renders
    expect(html).toContain(userSettingsVariablesLocale.none); // nothing written
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(0);
  });

  it("POST new on a duplicate name answers the generic 500 (the UNIQUE propagation — upstream has no web pre-check either)", async () => {
    await seedVariable("DUP_VAR", "original");
    const res = await postVariablesRoute(
      "/user/settings/actions/variables/new",
      { name: "dup_var", data: "v", description: "" },
      await mintDoerCookie(),
    );
    expect(res.status).toBe(500); // upstream JSONErrorAuto's fall-through (services/context/context.go:257-271)
    expect(await res.text()).toContain("Internal Server Error");
    const rows = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toBe("original"); // the hit row untouched
  });

  it("POST :id/edit rides the keep-name fallback through the mount (empty form name, the row kept and rewritten)", async () => {
    await seedVariable("keep_me", "old-value", "old-description");
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    const res = await postVariablesRoute(
      `/user/settings/actions/variables/${row.id}/edit`,
      { name: "", data: "route-kept", description: "route-desc" },
      await mintDoerCookie(),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/user/settings/actions/variables");
    const after = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(after.id).toBe(row.id);
    expect(after.name).toBe("KEEP_ME"); // the service's zero-value fallback
    expect(after.data).toBe("route-kept");
    expect(after.description).toBe("route-desc");
  });

  it("POST :id/edit re-renders the tab with the service's invalid-pattern line (200, the row-driven disclosures)", async () => {
    await seedVariable("EDITABLE", "old-value", "");
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    const res = await postVariablesRoute(
      `/user/settings/actions/variables/${row.id}/edit`,
      { name: "BAD-HYPHEN", data: "v", description: "" },
      await mintDoerCookie(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">');
    expect(html).toContain(userSettingsVariablesLocale.invalid_name_pattern);
    expect(html).toContain('value="EDITABLE"'); // the disclosure re-renders from the row
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!.data).toBe("old-value"); // the failed edit wrote nothing
  });

  it("POST :id/edit answers the 404 shell for a stale, a foreign and every non-numeric path id (upstream NotFound(nil) fidelity)", async () => {
    const cookie = await mintDoerCookie();
    await seedVariable("DOOMED", "v");
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    await seedVariable("FOREIGN", "f", "", 2);
    const foreignId = (await listVariableRows(env.DB, ownerScope(2), 1, 10)).rows[0]!.id;
    await deleteUserSettingsVariable(env.DB, 1, row.id); // stale the id

    await expectNotFoundShell(
      await postVariablesRoute(`/user/settings/actions/variables/${row.id}/edit`, { name: "X", data: "v", description: "" }, cookie),
    );
    await expectNotFoundShell(
      await postVariablesRoute(`/user/settings/actions/variables/${foreignId}/edit`, { name: "X", data: "v", description: "" }, cookie),
    );
    // Upstream's PathParamInt64 junk → NotFound; the mount's Number(param)
    // answers the same 404 through the resolve miss (NaN/-3/12.5 hit no row).
    for (const junk of ["junk", "-3", "12.5"]) {
      await expectNotFoundShell(
        await postVariablesRoute(`/user/settings/actions/variables/${junk}/edit`, { name: "X", data: "v", description: "" }, cookie),
      );
    }
    expect((await listVariableRows(env.DB, ownerScope(2), 1, 10)).rows).toHaveLength(1); // the foreign row survives
  });

  it("POST :id/delete 303s the hit and answers the 404 shell for a stale, a foreign and every non-numeric path id", async () => {
    const cookie = await mintDoerCookie();
    await seedVariable("GONE", "v");
    const row = (await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    const hit = await postVariablesRoute(`/user/settings/actions/variables/${row.id}/delete`, {}, cookie);
    expect(hit.status).toBe(303);
    expect(hit.headers.get("location")).toBe("/user/settings/actions/variables");
    expect((await listVariableRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(0);

    await seedVariable("FOREIGN", "f", "", 2);
    const foreignId = (await listVariableRows(env.DB, ownerScope(2), 1, 10)).rows[0]!.id;
    await expectNotFoundShell(await postVariablesRoute(`/user/settings/actions/variables/${row.id}/delete`, {}, cookie)); // stale
    await expectNotFoundShell(await postVariablesRoute(`/user/settings/actions/variables/${foreignId}/delete`, {}, cookie)); // foreign
    for (const junk of ["junk", "-3", "12.5"]) {
      await expectNotFoundShell(await postVariablesRoute(`/user/settings/actions/variables/${junk}/delete`, {}, cookie));
    }
    expect((await listVariableRows(env.DB, ownerScope(2), 1, 10)).rows).toHaveLength(1); // the foreign row survives
  });
});
