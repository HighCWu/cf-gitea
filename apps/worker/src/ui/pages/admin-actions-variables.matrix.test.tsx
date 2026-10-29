/**
 * The admin actions VARIABLES page's tests (the ui-parity tick-19 arm — the
 * ADMIN scope of the shared variables builders over the landed 0021 store):
 * the GLOBAL scope pair `{ownerId: 0, repoId: ""}` (upstream
 * BelongingScopeGlobal's encoding) — the list shows ONLY global rows (a
 * repo-scope or owner-scope variable never renders here), the create /
 * update / delete arms' outcomes over the landed service (the id→row hop
 * makes any foreign-scope id the "missing" 404 arm), the exact ApiError
 * texts on the invalid arms, the DOM contract (the `admin actions`
 * pageClass, the plaintext values, the edit disclosures, the add form), and
 * the PRE-MOUNT router pins.
 *
 * PRE-MOUNT posture: the routes 404 through the router until the
 * orchestrator executes the module header's HANDOFF recipes — these tests
 * drive the module loaders/writers/parsers/renderers directly (the house
 * pattern for pre-mount waves) and PIN the unclaimed parse shapes (they flip
 * at the mount window, the repo-actions-queue.test.tsx:433 precedent).
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createVariableRow, ownerScope, repoScope } from "../../api/services/secrets-variables";
import { parseUiRoute } from "../index";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { repoSettingsActionsLocale } from "./repo-settings-actions-secrets-variables";
import {
  applyAdminActionsVariableCreate,
  applyAdminActionsVariableUpdate,
  deleteAdminActionsVariable,
  formatAdminActionsDate,
  loadAdminActionsVariablesPageData,
  parseAdminActionsVariableForm,
  parseAdminActionsVariablePathId,
  renderAdminActionsVariablesPage,
} from "./admin-actions-variables";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";
const BASE = "/-/admin/actions/variables";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "root", isAdmin: true };

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM action_variables").run();
});

// --- the list (Variables' admin arm — the GLOBAL scope only) -------------------

describe("loadAdminActionsVariablesPageData (Variables, variables.go:83-105)", () => {
  it("lists ONLY the global scope's rows — a repo-scope and an owner-scope variable never render here", async () => {
    await createVariableRow(env.DB, repoScope("repo-1"), "repo_var", "repo-value", "repo desc");
    await createVariableRow(env.DB, ownerScope(7), "owner_var", "owner-value", "");
    await applyAdminActionsVariableCreate(env.DB, { name: "global_var", data: "global-value", description: "global desc" });

    const data = await loadAdminActionsVariablesPageData(env.DB);
    expect(data.variables.map((row) => row.name)).toEqual(["GLOBAL_VAR"]);
    expect(data.variables[0]!.data).toBe("global-value"); // the plaintext body
    expect(data.variables[0]!.description).toBe("global desc");
    expect(data.form).toEqual({ name: "", data: "", description: "" }); // the empty triple on the plain GET
  });

  it("name-ordered (the service's FindVariablesOptions order)", async () => {
    await applyAdminActionsVariableCreate(env.DB, { name: "B", data: "2", description: "" });
    await applyAdminActionsVariableCreate(env.DB, { name: "a", data: "1", description: "" });
    const data = await loadAdminActionsVariablesPageData(env.DB);
    expect(data.variables.map((row) => row.name)).toEqual(["A", "B"]); // UPPERCASED at insert, name-ordered
  });
});

// --- the write arms (VariableCreate/VariableUpdate/VariableDelete) --------------

describe("the write arms (upstream VariableCreate/VariableUpdate/VariableDelete at the GLOBAL scope)", () => {
  it("the create saves UPPERCASED at the global scope; an invalid name answers the exact ApiError text", async () => {
    expect(
      await applyAdminActionsVariableCreate(env.DB, { name: "my_var", data: "value", description: "desc" }),
    ).toEqual({ outcome: "saved" });
    const data = await loadAdminActionsVariablesPageData(env.DB);
    expect(data.variables.map((row) => row.name)).toEqual(["MY_VAR"]);

    // The service's ValidateName trio — the exact texts (the re-rendered
    // error line's content).
    expect(
      await applyAdminActionsVariableCreate(env.DB, { name: "9bad", data: "v", description: "" }),
    ).toEqual({ outcome: "invalid", message: "name must start with a letter or underscore and contain only letters, numbers, and underscores" });
    expect(
      await applyAdminActionsVariableCreate(env.DB, { name: "GITEA_x", data: "v", description: "" }),
    ).toEqual({ outcome: "invalid", message: "name cannot start with 'GITEA_' or 'GITHUB_'" });
  });

  it("the update resolves the id WITHIN the global scope — a repo-scope id is the missing 404 arm", async () => {
    await applyAdminActionsVariableCreate(env.DB, { name: "global_var", data: "old", description: "old desc" });
    const foreign = await createVariableRow(env.DB, repoScope("repo-1"), "repo_var", "repo-value", "");
    expect(foreign.id).toBeGreaterThan(0);

    expect(await applyAdminActionsVariableUpdate(env.DB, foreign.id, { name: "x", data: "y", description: "z" })).toEqual({ outcome: "missing" });
    expect(await applyAdminActionsVariableUpdate(env.DB, 424242, { name: "x", data: "y", description: "z" })).toEqual({ outcome: "missing" });
    expect(await applyAdminActionsVariableUpdate(env.DB, null, { name: "x", data: "y", description: "z" })).toEqual({ outcome: "missing" });

    const own = await loadAdminActionsVariablesPageData(env.DB);
    expect(await applyAdminActionsVariableUpdate(env.DB, own.variables[0]!.id, { name: "renamed_var", data: "new", description: "new desc" })).toEqual({
      outcome: "saved",
    });
    const after = await loadAdminActionsVariablesPageData(env.DB);
    expect(after.variables.map((row) => row.name)).toEqual(["RENAMED_VAR"]);
    expect(after.variables[0]!.data).toBe("new");
    expect(after.variables[0]!.description).toBe("new desc");
  });

  it("the update validates like the create (an invalid replacement name is the invalid arm)", async () => {
    await applyAdminActionsVariableCreate(env.DB, { name: "global_var", data: "v", description: "" });
    const own = await loadAdminActionsVariablesPageData(env.DB);
    expect(
      await applyAdminActionsVariableUpdate(env.DB, own.variables[0]!.id, { name: "GITHUB_x", data: "v", description: "" }),
    ).toEqual({ outcome: "invalid", message: "name cannot start with 'GITEA_' or 'GITHUB_'" });
  });

  it("the delete is idempotent-missing and scope-guarded", async () => {
    await applyAdminActionsVariableCreate(env.DB, { name: "global_var", data: "v", description: "" });
    const foreign = await createVariableRow(env.DB, ownerScope(7), "owner_var", "v", "");
    const own = await loadAdminActionsVariablesPageData(env.DB);

    expect(await deleteAdminActionsVariable(env.DB, foreign.id)).toBe("missing");
    expect(await deleteAdminActionsVariable(env.DB, own.variables[0]!.id)).toBe("deleted");
    expect(await deleteAdminActionsVariable(env.DB, own.variables[0]!.id)).toBe("missing"); // idempotent-missing
    expect(await deleteAdminActionsVariable(env.DB, null)).toBe("missing");
    expect((await loadAdminActionsVariablesPageData(env.DB)).variables).toHaveLength(0);
  });
});

// --- the parsers -----------------------------------------------------------------

describe("the form parsers", () => {
  it("the variable form parses its three fields (absent → empty)", () => {
    expect(parseAdminActionsVariableForm(new URLSearchParams({ name: "N", data: "D", description: "S" }))).toEqual({
      name: "N",
      data: "D",
      description: "S",
    });
    expect(parseAdminActionsVariableForm(new URLSearchParams())).toEqual({ name: "", data: "", description: "" });
  });

  it("the path id parses digits only; junk/absent is the missing arm", () => {
    expect(parseAdminActionsVariablePathId("42")).toBe(42);
    expect(parseAdminActionsVariablePathId("junk")).toBeNull();
    expect(parseAdminActionsVariablePathId("")).toBeNull();
    expect(parseAdminActionsVariablePathId("-1")).toBeNull();
  });
});

// --- the DOM contracts ------------------------------------------------------------

describe("the page renders (admin/actions.tmpl PageType variables + shared/variables/variable_list.tmpl)", () => {
  it("the page carries the `admin actions` pageClass, the nav's active Variables item and the plaintext rows", async () => {
    await applyAdminActionsVariableCreate(env.DB, { name: "deploy_target", data: "staging", description: "where" });
    const data = await loadAdminActionsVariablesPageData(env.DB);
    const html = renderAdminActionsVariablesPage({ ...ctx }, data);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("admin actions");
    expect(html).toContain(repoSettingsActionsLocale.variables_management);
    // The nav: the Actions group OPEN with Variables active.
    expect(html).toContain('<details class="item" open');
    expect(html).toContain(`class="active item" href="${BASE}"`);
    expect(html).toContain('href="/-/admin/actions/runners"');
    // The rows: the plaintext value body (variables are not masked), the
    // description dash arm, the added-on stamp.
    expect(html).toContain("DEPLOY_TARGET");
    expect(html).toContain("staging");
    expect(html).toContain("where");
    expect(html).toContain(`Added on ${formatAdminActionsDate(data.variables[0]!.createdAt)}`);
    // The edit disclosure targets the row's own /{id}/edit; the delete form
    // the row's /{id}/delete; the add form the /new tail.
    expect(html).toContain(`action="${BASE}/${data.variables[0]!.id}/edit"`);
    expect(html).toContain(`action="${BASE}/${data.variables[0]!.id}/delete"`);
    expect(html).toContain(`action="${BASE}/new"`);
    expect(html).toContain(repoSettingsActionsLocale.add_variable);
    // The name pattern rides verbatim (the client-side ValidateName mirror).
    expect(html).toContain('pattern="^(?!GITEA_|GITHUB_)[a-zA-Z_][a-zA-Z0-9_]*$"');
  });

  it("the empty list renders the none line; an error re-render carries the message and the submitted values", async () => {
    const empty = await loadAdminActionsVariablesPageData(env.DB);
    const emptyHtml = renderAdminActionsVariablesPage({ ...ctx }, empty);
    expect(emptyHtml).toContain(repoSettingsActionsLocale.variables_none);

    // The invalid re-render: the error line + the submitted triple in the
    // add form (the JSONErrorAuto no-JS reduction).
    const submitted = { name: "9bad", data: "kept", description: "also kept" };
    const errorHtml = renderAdminActionsVariablesPage({ ...ctx }, { ...empty, form: submitted }, "name must start with a letter or underscore and contain only letters, numbers, and underscores");
    expect(errorHtml).toContain("ui negative message");
    expect(errorHtml).toContain('value="9bad"');
    expect(errorHtml).toContain("kept");
  });
});

// --- the PRE-MOUNT router pins (they flip at the orchestrator's mount window) ----

describe("the router shapes (flipped at the HANDOFF mount window)", () => {
  it("the parse claims every admin actions variables shape the family mounts", () => {
    expect(parseUiRoute("/-/admin/actions/variables")).toMatchObject({ family: "admin-actions-variables" });
    expect(parseUiRoute("/-/admin/actions/variables/new")).toMatchObject({ family: "admin-actions-variables-new" });
    expect(parseUiRoute("/-/admin/actions/variables/3/edit")).toMatchObject({ family: "admin-actions-variables-edit", id: 3 });
    expect(parseUiRoute("/-/admin/actions/variables/3/delete")).toMatchObject({ family: "admin-actions-variables-delete", id: 3 });
    expect(parseUiRoute("/-/admin/actions/variables/3")).toBeNull(); // upstream registers no bare-{id} GET — engine-owned
  });
});
