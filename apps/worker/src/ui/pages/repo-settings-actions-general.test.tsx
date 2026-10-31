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
 * header's recipe) — so THEIR route-level matrix mounts a FRESH Hono app
 * over the exact fold glue (sameOriginGuard → the session/repo resolution
 * halves from the production primitives → the settingsGate → the
 * MustEnableActions repo arm → parse over the body+query merge → the
 * applier → the upstream response bytes), the 6b40fbc mounted pattern with
 * the registration still pending.
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
import { Hono, type Context } from "hono";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { loadRepoSettings, saveRepoSettings } from "../../api/services/repo-settings";
import { repositories, repoUnits } from "../../db/schema";
import { locale } from "../locale";
import { renderNotFound } from "../render";
import { mintSession, sameOriginGuard, SESSION_COOKIE_NAME } from "../session";
import { resolveRepositoryForViewer } from "../repo-view";
import { resolveViewer } from "../viewer";
import type { UiAssetsFetcher } from "../index";
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
  REPO_ACTIONS_NOT_FOUND_ERROR,
  REPO_ACTIONS_USER_NOT_EXIST_ERROR,
  readRepoActionsGeneralFormParams,
  renderRepoActionsGeneralPage,
  RepoActionsGeneralPage,
  repoSettingsActionsGeneralLocale,
} from "./repo-settings-actions-general";
import { canAdminRepo } from "./settings";
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
  for (const table of ["repo_units", "repo_settings", "repositories", "users", "repo_collaborators"]) {
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

describe("parseRepoTokenPermissionsForm (UpdateTokenPermissions' form reads, actions.go:158-177)", () => {
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

describe("the collaborative_owner parse arms (actions.go:95-142)", () => {
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

describe("applyRepoTokenPermissions (UpdateTokenPermissions through the store, actions.go:145-191)", () => {
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

  it("an invalid mode refuses the save (the :163-169 arm — the handler 303s unchanged)", async () => {
    await enableActions();
    const form = parseRepoTokenPermissionsForm(new URLSearchParams({ override_owner_config: "on", token_permission_mode: "junk" }));
    expect(await applyRepoTokenPermissions(env.DB, repo.id, form)).toBe("invalid-mode");
  });
});

describe("applyRepoCollaborativeOwnerAdd/Delete (actions.go:95-142 through the store)", () => {
  it("add resolves the name case-insensitively and appends; unknown names are the JSONError arm", async () => {
    repo = await seedRepo("locked", "private"); // the owners load arm is private-only (actions.go:61)
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

describe("loadRepoActionsGeneralPageData (ActionsGeneralSettings, actions.go:23-72)", () => {
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

  it("reflects the stored override config (actions.go:45-49's overriding branch)", async () => {
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

// --- the mounted POST tails (the wiring HANDOFF's glue on a FRESH app —
//     the 6b40fbc mounted pattern with the registration still pending) -------
//
// The three POST tails are NOT in `uiRouter` — the index.ts registration is
// the orchestrator's fold (the module tail's HANDOFF carries the exact
// lines). So this mount is a fresh Hono app over that same glue:
// sameOriginGuard FIRST, then resolveUiRequest's session + repo halves
// inlined from the production primitives (resolveViewer /
// resolveRepositoryForViewer — the index.ts-private resolveUiRequest folds
// back in verbatim at registration; invisible repos 404 BEFORE the redirect
// could leak them), then the settingsGate (anonymous login 303 / non-admin
// 404 shell), the MustEnableActions repo arm (repo_settings.has_actions —
// the group placement), the parse over readRepoActionsGeneralFormParams
// (the body+query merge), the applier, the upstream response bytes
// (Base.JSON's application/json;charset=utf-8, services/context/base.go:
// 113-118 — c.json would emit Hono's "application/json; charset=UTF-8").

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const routeEnv: RouteEnv = { ...env };

const routeApp = new Hono<{ Bindings: Env }>();

/** The settingsGate's anonymous arm — loginRedirect's exact bytes (the FULL
 *  pathname+search round-trip, upstream RedirectLinkUserLogin). */
function routeLoginRedirect(requestUri: string): Response {
  return new Response(null, { status: 303, headers: { location: `/login?redirect_to=${encodeURIComponent(requestUri)}` } });
}

/** The JSON envelope — Base.JSON's exact bytes (base.go:113-118). */
function routeJson(status: 200 | 400 | 404, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json;charset=utf-8" } });
}

/** methodNotAllowed's exact bytes (index.ts's chi-405 shape — upstream chi
 *  answers GET on a POST-only tail with 405 + Allow). */
function routeMethodNotAllowed(): Response {
  return new Response("Method Not Allowed\n", {
    status: 405,
    headers: { "content-type": "text/plain;charset=utf-8", allow: "POST", "x-content-type-options": "nosniff" },
  });
}

type PostTailRoute =
  | { ok: false; response: Response }
  | { ok: true; respond: (res: Response) => Response; repo: RepoRow; ctx: UiContext };

/** The POST prologue: sameOriginGuard → the session half → the repo half →
 *  the settingsGate. Drift-guard + parse arms ride index.ts's resolveUiRequest
 *  at the fold; the fresh mount IS the claim here. */
async function postTailPrologue(c: Context<{ Bindings: Env }>): Promise<PostTailRoute> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return { ok: false, response: guard };
  const url = new URL(c.req.raw.url);
  const { viewer, setCookie } = await resolveViewer(c.env, c.req.raw);
  const respond = (res: Response): Response => {
    if (setCookie === null) return res;
    const headers = new Headers(res.headers);
    headers.append("set-cookie", setCookie);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  const owner = c.req.param("owner");
  const slug = c.req.param("repo");
  if (owner === undefined || slug === undefined) return { ok: false, response: respond(new Response("not found\n", { status: 404 })) };
  const repo = await resolveRepositoryForViewer(c.env, viewer, owner, slug);
  const ctx: UiContext = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };
  if (repo === null) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  ctx.repo = repo;
  if (viewer.kind === "anonymous") return { ok: false, response: respond(routeLoginRedirect(url.pathname + url.search)) };
  if (!(await canAdminRepo(c.env, repo, viewer))) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  return { ok: true, respond, repo, ctx };
}

routeApp.post("/:owner/:repo/settings/actions/general/token_permissions", async (c) => {
  const pro = await postTailPrologue(c);
  if (!pro.ok) return pro.response;
  const { respond, repo, ctx } = pro;
  if (!(await loadRepoSettings(c.env.DB, repo.id)).hasActions) return respond(c.html(renderNotFound(ctx), 404));
  const form = parseRepoTokenPermissionsForm(await readRepoActionsGeneralFormParams(c.req.raw));
  await applyRepoTokenPermissions(c.env.DB, repo.id, form);
  // "saved" | "invalid-mode" BOTH 303 (the success flash and the invalid-mode
  // flash both land on upstream's redirect — the no-session-flash reduction);
  // "missing" is unreachable behind the gate.
  return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/settings/actions/general` } }));
});

routeApp.post("/:owner/:repo/settings/actions/general/collaborative_owner/add", async (c) => {
  const pro = await postTailPrologue(c);
  if (!pro.ok) return pro.response;
  const { respond, repo, ctx } = pro;
  if (!(await loadRepoSettings(c.env.DB, repo.id)).hasActions) return respond(c.html(renderNotFound(ctx), 404));
  const outcome = await applyRepoCollaborativeOwnerAdd(
    c.env.DB,
    repo.id,
    parseRepoCollaborativeOwnerAddForm(await readRepoActionsGeneralFormParams(c.req.raw)),
  );
  if (outcome === "user-not-found") return respond(routeJson(400, REPO_ACTIONS_USER_NOT_EXIST_ERROR)); // ctx.JSONError
  return respond(routeJson(200, { ok: true })); // ctx.JSONOK; "missing" unreachable
});

routeApp.post("/:owner/:repo/settings/actions/general/collaborative_owner/delete", async (c) => {
  const pro = await postTailPrologue(c);
  if (!pro.ok) return pro.response;
  const { respond, repo, ctx } = pro;
  if (!(await loadRepoSettings(c.env.DB, repo.id)).hasActions) return respond(c.html(renderNotFound(ctx), 404));
  const outcome = await applyRepoCollaborativeOwnerDelete(
    c.env.DB,
    repo.id,
    parseRepoCollaborativeOwnerDeleteForm(await readRepoActionsGeneralFormParams(c.req.raw)),
  );
  if (outcome === "not-an-owner") return respond(routeJson(404, REPO_ACTIONS_NOT_FOUND_ERROR)); // ctx.JSONErrorNotFound
  return respond(routeJson(200, { ok: true })); // "removed"
});

// chi's 405 GET twins (the runners' registration convention — POST-only tails).
routeApp.get("/:owner/:repo/settings/actions/general/token_permissions", () => routeMethodNotAllowed());
routeApp.get("/:owner/:repo/settings/actions/general/collaborative_owner/add", () => routeMethodNotAllowed());
routeApp.get("/:owner/:repo/settings/actions/general/collaborative_owner/delete", () => routeMethodNotAllowed());

async function fetchRoute(path: string, init?: RequestInit): Promise<Response> {
  return routeApp.fetch(new Request(`https://test.local${path}`, init), routeEnv);
}

/** A viewer's minted session cookie header (the C8 convention — minted per
 *  request; the beforeEach users wipe cascades the sessions table). */
async function routeCookie(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A urlencoded POST through the fresh mount (`userId: null` is the
 *  anonymous arm; pass a foreign origin for the 403 arms). */
async function postRoute(path: string, userId: number | null, fields: Record<string, string>, origin = ORIGIN): Promise<Response> {
  return fetchRoute(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      ...(userId === null ? {} : { cookie: await routeCookie(userId) }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The actions unit row's RAW config column (the store bytes the 6b40fbc
 *  matrix pins; null = no row or a NULL column). */
async function storedUnitConfig(repoId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT config FROM repo_units WHERE repo_id = ? AND type = 'actions'").bind(repoId).first<{ config: string | null }>();
  return row?.config ?? null;
}

describe("the mounted POST tails (the wiring HANDOFF's glue — the fresh-app route matrix)", () => {
  const TP_PATH = "/alice/demo/settings/actions/general/token_permissions";
  const ADD_PATH = "/alice/demo/settings/actions/general/collaborative_owner/add";
  const DELETE_PATH = "/alice/demo/settings/actions/general/collaborative_owner/delete";

  it("the token_permissions happy post: 303 back onto the general page + the EXACT store bytes", async () => {
    await enableActions();
    const res = await postRoute(TP_PATH, 1, {
      override_owner_config: "on",
      token_permission_mode: "restricted",
      enable_max_permissions: "on",
      max_unit_access_mode_1: "read",
      max_id_token: "write",
    });
    expect(res.status).toBe(303); // upstream :189-190's ctx.Redirect (base.go:157's See Other)
    expect(res.headers.get("location")).toBe("/alice/demo/settings/actions/general");
    // serializeRepoActionsConfig's Go-marshal bytes: nil slices, the sorted
    // unit-key map, omitempty on the tagged three.
    expect(await storedUnitConfig(repo.id)).toBe(
      '{"DisabledWorkflows":null,"DisabledScopedWorkflows":null,"CollaborativeOwnerIDs":null,"token_permission_mode":"restricted","max_token_permissions":{"unit_access_modes":{"1":1,"2":0,"3":0,"4":0,"5":0,"8":0,"9":0,"10":0},"id_token":true},"override_owner_config":true}',
    );
  });

  it("the add happy post: JSONOK 200 bytes + the id lands; a repeat adds nothing (append-if-absent)", async () => {
    await enableActions();
    const res = await postRoute(ADD_PATH, 1, { collaborative_owner: "BOB" });
    expect(res.status).toBe(200); // ctx.JSONOK (context.go:243-245)
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8"); // Base.JSON, base.go:114
    expect(await res.json()).toEqual({ ok: true });
    expect(await storedUnitConfig(repo.id)).toBe(
      '{"DisabledWorkflows":null,"DisabledScopedWorkflows":null,"CollaborativeOwnerIDs":[2],"token_permission_mode":"permissive"}',
    ); // the zero config + the case-folded id
    const again = await postRoute(ADD_PATH, 1, { collaborative_owner: "bob" });
    expect(again.status).toBe(200);
    expect(await storedUnitConfig(repo.id)).toBe(
      '{"DisabledWorkflows":null,"DisabledScopedWorkflows":null,"CollaborativeOwnerIDs":[2],"token_permission_mode":"permissive"}',
    ); // repo_unit_actions.go:134-137's contains-guard — a save, not a duplicate
  });

  it("the add arm's unknown user: the 400 literal body + NOTHING stored (the early return skips the save)", async () => {
    await enableActions();
    const res = await postRoute(ADD_PATH, 1, { collaborative_owner: "ghost" });
    expect(res.status).toBe(400); // ctx.JSONError (context.go:276-278)
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await res.json()).toEqual(REPO_ACTIONS_USER_NOT_EXIST_ERROR); // "The user does not exist."
    expect(await storedUnitConfig(repo.id)).toBe(null); // the unit row keeps its NULL config
  });

  it("the delete arm reads ?id= from the QUERY (the link-action data-url contract — the body posts empty)", async () => {
    await enableActions();
    await postRoute(ADD_PATH, 1, { collaborative_owner: "bob" });
    const res = await postRoute(`${DELETE_PATH}?id=2`, 1, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await storedUnitConfig(repo.id)).toBe(
      '{"DisabledWorkflows":null,"DisabledScopedWorkflows":null,"CollaborativeOwnerIDs":null,"token_permission_mode":"permissive"}',
    ); // removed — the empty slice marshals null again
  });

  it("the delete arm's non-owner id: JSONErrorNotFound 404 bytes + the list unchanged; junk/absent id is the same 404", async () => {
    await enableActions();
    await postRoute(ADD_PATH, 1, { collaborative_owner: "bob" });
    const res = await postRoute(`${DELETE_PATH}?id=99`, 1, {});
    expect(res.status).toBe(404); // ctx.JSONErrorNotFound (context.go:286-292)
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await res.json()).toEqual(REPO_ACTIONS_NOT_FOUND_ERROR); // "The target couldn't be found."
    expect(await storedUnitConfig(repo.id)).toContain('"CollaborativeOwnerIDs":[2]'); // untouched
    expect((await postRoute(`${DELETE_PATH}?id=junk`, 1, {})).status).toBe(404); // FormInt64's swallowed error → 0
    expect((await postRoute(DELETE_PATH, 1, {})).status).toBe(404); // absent → 0
  });

  it("the invalid-mode post 303s UNCHANGED — the refused save persists nothing, not even the override flag", async () => {
    await enableActions();
    const res = await postRoute(TP_PATH, 1, { override_owner_config: "on", token_permission_mode: "junk" });
    expect(res.status).toBe(303); // upstream :163-169's flash-error redirect — the same location
    expect(res.headers.get("location")).toBe("/alice/demo/settings/actions/general");
    expect(await storedUnitConfig(repo.id)).toBe(null); // the save never runs (UpdateRepoUnitConfig is skipped)
  });

  it("the not-overriding save writes the false flag and KEEPS the stored mode + ceiling (the shouldUpdate gate)", async () => {
    await enableActions();
    await postRoute(TP_PATH, 1, {
      override_owner_config: "on",
      token_permission_mode: "restricted",
      enable_max_permissions: "on",
      max_unit_access_mode_1: "read",
    });
    const res = await postRoute(TP_PATH, 1, { token_permission_mode: "permissive" }); // override unchecked; the radios post anyway (the no-JS byte-equivalence)
    expect(res.status).toBe(303);
    expect(await storedUnitConfig(repo.id)).toBe(
      '{"DisabledWorkflows":null,"DisabledScopedWorkflows":null,"CollaborativeOwnerIDs":null,"token_permission_mode":"restricted","max_token_permissions":{"unit_access_modes":{"1":1,"2":0,"3":0,"4":0,"5":0,"8":0,"9":0,"10":0}}}',
    ); // actions.go:158 wrote the flag (omitted when false), :175-182 left mode + max untouched
  });

  it("the gates: anonymous 303s to login, a non-collaborator 404-shells, a WRITE-collaborator still 404s, an unknown repo 404s", async () => {
    await enableActions();
    for (const path of [TP_PATH, ADD_PATH, `${DELETE_PATH}?id=2`]) {
      const anon = await postRoute(path, null, {});
      expect(anon.status).toBe(303); // the settingsGate's login round-trip (the guard passed first)
      expect(anon.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(path)}`);
    }
    const shell = await postRoute(TP_PATH, 2, { token_permission_mode: "restricted" });
    expect(shell.status).toBe(404); // bob: no relation — the admin gate's shell
    expect(await shell.text()).toContain(locale.error404_box_title);
    await env.DB.prepare("INSERT INTO repo_collaborators (repo_id, user_id, mode, created_at) VALUES (?, 2, 'write', unixepoch())").bind(repo.id).run();
    const collab = await postRoute(TP_PATH, 2, { token_permission_mode: "restricted" });
    expect(collab.status).toBe(404); // a write-mode collaborator is NOT repo-admin (canAdminRepo) — nothing leaks
    const unknown = await postRoute("/alice/no-such-repo/settings/actions/general/token_permissions", 1, {});
    expect(unknown.status).toBe(404); // the invisible-repo shell — resolution precedes the redirect
    expect(await storedUnitConfig(repo.id)).toBe(null); // the refused posts wrote nothing
  });

  it("the cross-origin guard answers FIRST — 403 with and without the session (the origin, not the session, decides)", async () => {
    await enableActions();
    const anon = await postRoute(TP_PATH, null, { token_permission_mode: "restricted" }, "https://evil.example");
    expect(anon.status).toBe(403);
    expect(await anon.text()).toBe("cross-origin request rejected\n");
    const owned = await postRoute(TP_PATH, 1, { token_permission_mode: "restricted" }, "https://evil.example");
    expect(owned.status).toBe(403); // §2.8 layer 2 — guard before the session gate
    expect(await storedUnitConfig(repo.id)).toBe(null);
  });

  it("the MustEnableActions arm: even the ADMIN 404-shells a DISABLED unit — the group placement (nothing written)", async () => {
    expect((await loadRepoSettings(env.DB, repo.id)).hasActions).toBe(false); // the store default
    for (const path of [TP_PATH, ADD_PATH]) {
      const res = await postRoute(path, 1, { token_permission_mode: "restricted", collaborative_owner: "bob" });
      expect(res.status).toBe(404);
      expect(await res.text()).toContain(locale.error404_box_title);
    }
    expect(await storedUnitConfig(repo.id)).toBe(null);
    expect(await storedUnitConfig("repo-2")).toBe(null);
  });

  it("the scoping arm: demo's add never moves the neighbor repo's stored owners", async () => {
    await enableActions();
    await saveRepoSettings(env.DB, "repo-2", { hasActions: true }, T0);
    await applyRepoCollaborativeOwnerAdd(env.DB, "repo-2", { collaborativeOwner: "bob" }); // the neighbor's own state
    const before = await storedUnitConfig("repo-2");
    const res = await postRoute(ADD_PATH, 1, { collaborative_owner: "bob" });
    expect(res.status).toBe(200);
    expect(await storedUnitConfig(repo.id)).toContain('"CollaborativeOwnerIDs":[2]'); // demo got the id
    expect(await storedUnitConfig("repo-2")).toBe(before); // the neighbor's bytes untouched
  });

  it("the GET twins answer chi's 405 with the Allow header (the runners' registration convention)", async () => {
    for (const path of [TP_PATH, ADD_PATH, DELETE_PATH]) {
      const res = await fetchRoute(path);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(await res.text()).toBe("Method Not Allowed\n");
    }
  });
});
