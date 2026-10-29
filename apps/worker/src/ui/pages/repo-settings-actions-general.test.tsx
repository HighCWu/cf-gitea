/**
 * The repo settings ACTIONS GENERAL sub-tab's tests (the census C9 arm —
 * the repo-settings-actions-secrets-variables.test.tsx harness over the
 * generated migrations): the FormBool/FormInt64 parse matrices (upstream
 * base_form.go), the toggle write over real D1 (the settings write idiom —
 * repo_settings.has_actions, DEFAULT false), the token_permissions +
 * collaborative_owner POST arms (the services/actions/config.ts store —
 * migration 0043's repo_units.config), the page-load read (the
 * override/owner-fallback inputs + the private-repo owners arm), and the
 * DOM contract of all three sections' postures — hono/jsx renderToString,
 * the module driven directly.
 *
 * The ROUTE-level matrix (the settingsGate arms, the bare-path redirect's
 * enabled-303/disabled-404 polarity, the actions_unit POST through
 * sameOriginGuard) rides the integrator's index.ts registration window —
 * the C8 test's mounted `fetchUi` section is its pattern; this module's
 * exports are the surface those handlers consume (the reported arms). The
 * three POST tails' route registration is the wiring HANDOFF (the module
 * header's recipe) — the handlers themselves are not this module's files.
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef:
 * routers/web/repo/setting/actions.go:23-191 + web.go:1262-1278 +
 * templates/repo/settings/actions_general.tmpl + the shared
 * permission_mode_select/permissions_table templates (the module header
 * carries the full cite set).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { loadRepoSettings, saveRepoSettings } from "../../api/services/repo-settings";
import { repositories, repoUnits } from "../../db/schema";
import {
  applyRepoActionsUnitToggle,
  applyRepoCollaborativeOwnerAdd,
  applyRepoCollaborativeOwnerDelete,
  applyRepoTokenPermissions,
  formBool,
  formInt64,
  loadRepoActionsGeneralPageData,
  parseRepoActionsUnitForm,
  parseRepoCollaborativeOwnerAddForm,
  parseRepoCollaborativeOwnerDeleteForm,
  parseRepoTokenPermissionsForm,
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
  await seedUsers();
  repo = await seedRepo("demo");
});

async function seedUsers(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (2, 'bob', 'bob', 'Bob Builder', unixepoch())",
  ).run();
}

async function seedRepo(slug: string, visibility: "public" | "private" = "public", id = "repo-1"): Promise<RepoRow> {
  await env.DB.prepare("DELETE FROM repositories WHERE id IN (?, 'repo-2')").bind(id).run(); // the reseed (beforeEach seeded "demo")
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES (?, ?, 'alice', 1, ?, 'main', ?, unixepoch())",
  )
    .bind(id, id, slug, visibility)
    .run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-2', 'repo-2', 'alice', 1, 'other', 'main', 'public', unixepoch())",
  ).run();
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, id)).get();
  if (row === undefined) throw new Error("fixture repository missing");
  return row;
}

/** The actions unit ON (the options form's enable_actions write — the same
 *  store arm the toggle writes). */
async function enableActions(): Promise<void> {
  await saveRepoSettings(env.DB, repo.id, { hasActions: true }, T0);
}

async function generalHtml(data?: Awaited<ReturnType<typeof loadRepoActionsGeneralPageData>>): Promise<string> {
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

describe("formInt64 (upstream FormInt64, base_form.go:88-91 — ParseInt with the error swallowed)", () => {
  it("parses decimal integers", () => {
    expect(formInt64("42")).toBe(42);
    expect(formInt64("-7")).toBe(-7);
  });

  it("answers 0 for absent, empty, and junk (the swallowed ParseInt error)", () => {
    expect(formInt64(null)).toBe(0);
    expect(formInt64("")).toBe(0);
    expect(formInt64("12abc")).toBe(0); // Go's ParseInt errors whole-string → 0 (not JS's prefix parse)
    expect(formInt64("junk")).toBe(0);
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

describe("parseRepoTokenPermissionsForm (UpdateTokenPermissions' form reads, actions.go:141-177)", () => {
  it("parses the full override post: FormBools, the mode, the per-unit radios, the id-token", () => {
    const params = new URLSearchParams({
      override_owner_config: "on",
      token_permission_mode: "restricted",
      enable_max_permissions: "on",
      max_unit_access_mode_1: "write",
      max_unit_access_mode_2: "read",
      max_id_token: "write",
    });
    const form = parseRepoTokenPermissionsForm(params);
    expect(form.overrideOwnerConfig).toBe(true);
    expect(form.tokenPermissionMode).toBe("restricted");
    expect(form.enableMaxPermissions).toBe(true);
    expect(form.maxUnitAccessModes[1]).toBe("write");
    expect(form.maxUnitAccessModes[2]).toBe("read");
    expect(form.maxUnitAccessModes[9]).toBe(""); // the packages field is absent from the form (the template's omission)
    expect(form.maxIdToken).toBe("write");
  });

  it("parses the bare override-unchecked post (absent FormBools false, radios \"\")", () => {
    expect(parseRepoTokenPermissionsForm(new URLSearchParams())).toEqual({
      overrideOwnerConfig: false,
      tokenPermissionMode: "",
      enableMaxPermissions: false,
      maxUnitAccessModes: Object.fromEntries([1, 2, 3, 9, 10, 5, 4, 8].map((u) => [u, ""])),
      maxIdToken: "",
    });
  });
});

describe("the collaborative_owner parse arms (actions.go:103-137)", () => {
  it("add: the search-user-box input's raw value (upstream FormString does not trim)", () => {
    expect(parseRepoCollaborativeOwnerAddForm(new URLSearchParams({ collaborative_owner: "bob" }))).toEqual({ collaborativeOwner: "bob" });
    expect(parseRepoCollaborativeOwnerAddForm(new URLSearchParams({ collaborative_owner: " Bob " }))).toEqual({ collaborativeOwner: " Bob " });
    expect(parseRepoCollaborativeOwnerAddForm(new URLSearchParams())).toEqual({ collaborativeOwner: "" });
  });

  it("delete: the ?id= FormInt64 (query-style body, junk → 0)", () => {
    expect(parseRepoCollaborativeOwnerDeleteForm(new URLSearchParams({ id: "7" }))).toEqual({ id: 7 });
    expect(parseRepoCollaborativeOwnerDeleteForm(new URLSearchParams({ id: "junk" }))).toEqual({ id: 0 });
    expect(parseRepoCollaborativeOwnerDeleteForm(new URLSearchParams())).toEqual({ id: 0 });
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

// --- the POST arms over the store -------------------------------------------------

describe("applyRepoTokenPermissions (UpdateTokenPermissions through the store, actions.go:139-191)", () => {
  it("stores a valid override post; both outcomes ride the same 303 (the flash reduction)", async () => {
    await enableActions();
    const form = parseRepoTokenPermissionsForm(
      new URLSearchParams({
        override_owner_config: "on",
        token_permission_mode: "restricted",
        enable_max_permissions: "on",
        max_unit_access_mode_1: "read",
        max_id_token: "write",
      }),
    );
    expect(await applyRepoTokenPermissions(env.DB, repo.id, form)).toBe("saved");
    const stored = await loadRepoActionsGeneralPageData(env.DB, repo.id);
    expect(stored.tokenPermissions.overrideOwnerConfig).toBe(true);
    expect(stored.tokenPermissions.tokenPermissionMode).toBe("restricted");
    expect(stored.tokenPermissions.enableMaxTokenPermissions).toBe(true);
    expect(stored.tokenPermissions.maxTokenPermissions.unitAccessModes[1]).toBe(1);
    expect(stored.tokenPermissions.maxTokenPermissions.idToken).toBe(true);
  });

  it("an invalid mode refuses the save (the :162-167 arm — the handler 303s unchanged)", async () => {
    await enableActions();
    const form = parseRepoTokenPermissionsForm(new URLSearchParams({ override_owner_config: "on", token_permission_mode: "junk" }));
    expect(await applyRepoTokenPermissions(env.DB, repo.id, form)).toBe("invalid-mode");
  });
});

describe("applyRepoCollaborativeOwnerAdd/Delete (actions.go:103-137 through the store)", () => {
  it("add resolves the name case-insensitively and appends; unknown names are the JSONError arm", async () => {
    repo = await seedRepo("locked", "private"); // the owners load arm is private-only (actions.go:62)
    await enableActions();
    expect(await applyRepoCollaborativeOwnerAdd(env.DB, repo.id, parseRepoCollaborativeOwnerAddForm(new URLSearchParams({ collaborative_owner: "BOB" })))).toBe("added");
    const page = await loadRepoActionsGeneralPageData(env.DB, repo.id);
    expect(page.collaborativeOwners).toEqual([{ id: 2, username: "bob", displayName: "Bob Builder" }]);
    expect(
      await applyRepoCollaborativeOwnerAdd(env.DB, repo.id, parseRepoCollaborativeOwnerAddForm(new URLSearchParams({ collaborative_owner: "ghost" }))),
    ).toBe("user-not-found");
  });

  it("delete removes a listed owner; a non-owner id is the JSONErrorNotFound arm", async () => {
    await enableActions();
    await applyRepoCollaborativeOwnerAdd(env.DB, repo.id, parseRepoCollaborativeOwnerAddForm(new URLSearchParams({ collaborative_owner: "bob" })));
    expect(await applyRepoCollaborativeOwnerDelete(env.DB, repo.id, parseRepoCollaborativeOwnerDeleteForm(new URLSearchParams({ id: "2" })))).toBe("removed");
    expect((await loadRepoActionsGeneralPageData(env.DB, repo.id)).collaborativeOwners).toEqual([]);
    expect(await applyRepoCollaborativeOwnerDelete(env.DB, repo.id, parseRepoCollaborativeOwnerDeleteForm(new URLSearchParams({ id: "2" })))).toBe("not-an-owner");
    expect(await applyRepoCollaborativeOwnerDelete(env.DB, repo.id, parseRepoCollaborativeOwnerDeleteForm(new URLSearchParams()))).toBe("not-an-owner"); // FormInt64's 0
  });

  it("both arms answer missing on a unit-less repo (the gate's 404 at the store seam)", async () => {
    expect(await applyRepoCollaborativeOwnerAdd(env.DB, repo.id, parseRepoCollaborativeOwnerAddForm(new URLSearchParams({ collaborative_owner: "bob" })))).toBe("missing");
    expect(await applyRepoCollaborativeOwnerDelete(env.DB, repo.id, parseRepoCollaborativeOwnerDeleteForm(new URLSearchParams({ id: "2" })))).toBe("missing");
  });
});

// --- the page load ----------------------------------------------------------------

describe("loadRepoActionsGeneralPageData (ActionsGeneralSettings, actions.go:23-101)", () => {
  it("answers the disabled posture with the unrendered fallback inputs", async () => {
    const page = await loadRepoActionsGeneralPageData(env.DB, repo.id);
    expect(page.isActionsEnabled).toBe(false);
    expect(page.tokenPermissions.overrideOwnerConfig).toBe(false);
    expect(page.tokenPermissions.enableMaxTokenPermissions).toBe(false);
    expect(page.collaborativeOwners).toEqual([]);
  });

  it("on an enabled public repo: the owner-fallback inputs (permissive, write-all, enable-max false) and no owners", async () => {
    await enableActions();
    const page = await loadRepoActionsGeneralPageData(env.DB, repo.id);
    expect(page.isActionsEnabled).toBe(true);
    expect(page.tokenPermissions).toEqual({
      overrideOwnerConfig: false,
      tokenPermissionMode: "permissive",
      maxTokenPermissions: { unitAccessModes: Object.fromEntries([1, 2, 3, 9, 10, 5, 4, 8].map((u) => [u, 2])), idToken: true },
      enableMaxTokenPermissions: false,
    });
    expect(page.collaborativeOwners).toEqual([]); // actions_general.tmpl:57-58's IsPrivate arm
  });

  it("reflects the stored override config (actions.go:41-44's overriding branch)", async () => {
    await enableActions();
    await applyRepoTokenPermissions(
      env.DB,
      repo.id,
      parseRepoTokenPermissionsForm(
        new URLSearchParams({ override_owner_config: "on", token_permission_mode: "restricted", enable_max_permissions: "on", max_unit_access_mode_10: "write" }),
      ),
    );
    const page = await loadRepoActionsGeneralPageData(env.DB, repo.id);
    expect(page.tokenPermissions.overrideOwnerConfig).toBe(true);
    expect(page.tokenPermissions.tokenPermissionMode).toBe("restricted");
    expect(page.tokenPermissions.enableMaxTokenPermissions).toBe(true);
    expect(page.tokenPermissions.maxTokenPermissions.unitAccessModes[10]).toBe(2);
    expect(page.tokenPermissions.maxTokenPermissions.unitAccessModes[1]).toBe(0); // the absent radio parsed none
  });

  it("loads the collaborative owners on a PRIVATE repo in config order (actions.go:62-69)", async () => {
    repo = await seedRepo("locked", "private");
    await enableActions();
    await applyRepoCollaborativeOwnerAdd(env.DB, repo.id, parseRepoCollaborativeOwnerAddForm(new URLSearchParams({ collaborative_owner: "bob" })));
    const page = await loadRepoActionsGeneralPageData(env.DB, repo.id);
    expect(page.collaborativeOwners).toEqual([{ id: 2, username: "bob", displayName: "Bob Builder" }]);
  });
});

// --- the DOM ---------------------------------------------------------------------

describe("the general page DOM (repo/settings/actions.tmpl PageType general + actions_general.tmpl)", () => {
  it("renders the toggle section on a DISABLED unit — the re-entry posture (the route carries no unit gate)", async () => {
    const html = await generalHtml({ isActionsEnabled: false, tokenPermissions: (await loadRepoActionsGeneralPageData(env.DB, repo.id)).tokenPermissions, collaborativeOwners: [] });
    expect(html).toContain("repository settings actions"); // layout_head's pageClass (actions.tmpl:1)
    expect(html).toContain('class="repo-setting-content"'); // actions.tmpl:2
    expect(html).toContain("Enable Actions"); // the h4 (actions_general.tmpl:5)
    expect(html).toContain('action="/alice/demo/settings/actions/general/actions_unit"'); // {{.Link}}/actions_unit
    expect(html).toContain('<input name="enable_actions" type="checkbox"/>'); // unchecked
    expect(html).toContain("Enable Repository Actions"); // the checkbox label (actions_general.tmpl:14)
    expect(html).toContain("Update Settings"); // the submit (actions_general.tmpl:20)
  });

  it("renders the checkbox checked when the unit is enabled", async () => {
    const html = await generalHtml({ isActionsEnabled: true, tokenPermissions: (await loadRepoActionsGeneralPageData(env.DB, repo.id)).tokenPermissions, collaborativeOwners: [] });
    expect(html).toContain('<input name="enable_actions" type="checkbox" checked=""/>');
  });

  it("the enabled-posture sections stay unrendered on a DISABLED unit (actions_general.tmpl:26/:57's arms)", async () => {
    const html = await generalHtml();
    expect(html).not.toContain("Actions Token Permissions"); // actions_general.tmpl:28's section
    expect(html).not.toContain("token_permissions"); // its POST tail
    expect(html).not.toContain("Collaborative Owners Management"); // actions_general.tmpl:61's section
    expect(html).not.toContain("collaborative_owner"); // its POST tails
  });

  it("renders the Token Permissions section on an enabled repo — the owner-fallback posture (override unchecked, permissive checked, write-all table)", async () => {
    await enableActions();
    const html = await generalHtml();
    expect(html).toContain("Actions Token Permissions"); // actions_general.tmpl:28
    expect(html).toContain('action="/alice/demo/settings/actions/general/token_permissions"'); // :27's {{.RepoLink}} form
    expect(html).toContain('<input type="checkbox" name="override_owner_config"/>'); // :34, unchecked
    expect(html).toContain("Override owner-level configuration"); // :34's label
    expect(html).toContain("Default Token Permissions"); // permission_mode_select.tmpl:2
    expect(html).toContain('<input type="radio" name="token_permission_mode" value="permissive" checked=""/>'); // the fallback mode (EnumValue's permissive)
    expect(html).toContain('<input type="radio" name="token_permission_mode" value="restricted"/>'); // unchecked
    expect(html).toContain('<input type="checkbox" name="enable_max_permissions"/>'); // :13, unchecked (no explicit ceiling)
    // the per-unit maximum table (permissions_table.tmpl's rows + the id-token row)
    expect(html).toContain("No Access"); // the table headers
    expect(html).toContain('<input type="radio" name="max_unit_access_mode_1" value="write" checked=""/>'); // the write-all fallback
    expect(html).toContain('<input type="radio" name="max_unit_access_mode_10" value="write" checked=""/>');
    expect(html).toContain('<input type="radio" name="max_unit_access_mode_10" value="none"/>');
    expect(html).toContain("OpenID Connect token"); // :88
    expect(html).toContain('<input type="radio" name="max_id_token" value="write" checked=""/>'); // MakeWriteAll... idToken
    expect(html).toContain("Update Settings"); // :53's submit
  });

  it("renders the stored override posture (restricted checked, the ceiling radios, enable-max checked)", async () => {
    await enableActions();
    await applyRepoTokenPermissions(
      env.DB,
      repo.id,
      parseRepoTokenPermissionsForm(
        new URLSearchParams({ override_owner_config: "on", token_permission_mode: "restricted", enable_max_permissions: "on", max_unit_access_mode_1: "read" }),
      ),
    );
    const html = await generalHtml();
    expect(html).toContain('<input type="checkbox" name="override_owner_config" checked=""/>');
    expect(html).toContain('<input type="radio" name="token_permission_mode" value="restricted" checked=""/>');
    expect(html).toContain('<input type="radio" name="token_permission_mode" value="permissive"/>');
    expect(html).toContain('<input type="checkbox" name="enable_max_permissions" checked=""/>');
    expect(html).toContain('<input type="radio" name="max_unit_access_mode_1" value="read" checked=""/>');
    expect(html).toContain('<input type="radio" name="max_unit_access_mode_1" value="none"/>'); // the rest none (the absent radios parsed none)
    expect(html).toContain('<input type="radio" name="max_id_token" value="none" checked=""/>'); // max_id_token absent → refused
  });

  it("the Collaborative Owners section renders only on a PRIVATE enabled repo (actions_general.tmpl:57-58's arm)", async () => {
    await enableActions();
    expect((await generalHtml())).not.toContain("Collaborative Owners Management"); // public

    repo = await seedRepo("locked", "private");
    await enableActions();
    const empty = await generalHtml();
    expect(empty).toContain("Collaborative Owners Management"); // :61
    expect(empty).toContain('action="/alice/locked/settings/actions/general/collaborative_owner/add"'); // :89's {{.Link}} form
    expect(empty).toContain('name="collaborative_owner"'); // the search-user-box input (:90)
    expect(empty).toContain("Search users…"); // "search.user_kind"
    expect(empty).toContain("Add Collaborative Owner"); // :92
    expect(empty).toContain("A collaborative owner is a user or an organization"); // :96's help
    expect(empty).not.toContain("collaborative_owner/delete"); // no owners listed yet

    await applyRepoCollaborativeOwnerAdd(env.DB, repo.id, parseRepoCollaborativeOwnerAddForm(new URLSearchParams({ collaborative_owner: "bob" })));
    const listed = await generalHtml();
    expect(listed).toContain('href="/bob"'); // shared/user/name's HomeLink anchor (the avatar img is the documented reduction)
    expect(listed).toContain("Bob Builder");
    expect(listed).toContain('data-url="/alice/locked/settings/actions/general/collaborative_owner/delete?id=2"'); // :75's link-action
    expect(listed).toContain("Remove Collaborative Owner"); // :76's modal header
    expect(listed).toContain(">Remove</button>"); // :78
  });

  it("the nav rides the shared SettingsNav: General active in BOTH postures, the trio only when enabled", async () => {
    const disabled = await generalHtml();
    expect(disabled).toContain("<details"); // the Actions disclosure — the active==="general" arm
    expect(disabled).toContain('class="active item" href="/alice/demo/settings/actions/general"');
    expect(disabled).not.toContain('href="/alice/demo/settings/actions/secrets"'); // General alone (navbar.tmpl:43-46)
    expect(disabled).not.toContain('href="/alice/demo/settings/actions/variables"');

    await enableActions();
    const enabled = await generalHtml();
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
