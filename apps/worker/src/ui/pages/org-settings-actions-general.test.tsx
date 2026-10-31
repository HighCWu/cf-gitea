/**
 * The ORG settings ACTIONS tab's GENERAL sub-tab's tests — the census C9
 * arm's owner page at the org scope (pages/org-settings-actions-general.tsx).
 * The shell harness pieces (hono/jsx through renderPage-owned renderers)
 * pin the full-document DOM contract (org/settings/actions_general.tmpl +
 * shared/actions/owner_general_settings.tmpl at the pin, byte-level where
 * upstream's own quirks live — the trailing-space form class, the
 * `page-content ` attribute) and the POST parsers + the
 * ParseMaxTokenPermissions port (general.go:25-44); the D1 pieces (real
 * local-D1 via the auth migrations helper) pin the loader's store read —
 * the absent-row default AND a saved-owner posture — and the POST applier
 * `applyOwnerActionsGeneralForms` (UpdateGeneralSettings' arms:
 * general.go:119-139's resolution arms, :142-152's no-refusal EnumValue
 * arm, the save).
 *
 * The route-level matrix (the require-owner prologue arms, the parse
 * claims, the bare-path 303, the POST registrations) rides the MOUNTED
 * router (`uiRouter.fetch`, the wave-49 convention) — index.ts stays a
 * file this suite does not edit; the POST registrations landed at `4bffff0`
 * (the owner-store wave) and their route-level arms are pinned at the
 * bottom of this file.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { setOwnerActionsConfig } from "../../services/actions/owner-actions-config";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import type { UiManifest } from "../manifest";
import { uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { uiEnv } from "../__tests__/harness";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { makeWriteAllActionsTokenPermissions } from "../../services/actions/config";
import {
  OWNER_ACTIONS_GENERAL_FRESH_DATA,
  OWNER_ACTIONS_REPO_NOT_EXIST_ERROR,
  applyOwnerActionsGeneralForms,
  deriveOwnerActionsGeneralData,
  loadOrgActionsGeneralPageData,
  parseOwnerActionsCrossRepoForm,
  parseOwnerActionsPermissionsForm,
  parseMaxTokenPermissions,
  renderOrgActionsGeneralPage,
  orgSettingsActionsGeneralLocale,
  type OrgActionsGeneralPageDataWithOrg,
} from "./org-settings-actions-general";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000);
const ORIGIN = "https://test.local";
const ORG_ID = 7;
const ORG_LINK = "/coalition";
const GENERAL_LINK = `${ORG_LINK}/settings/actions/general`;

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

/** The no-setting page data for the DOM pins (the fresh posture, no D1 —
 *  the store's absent-row answer IS this shape, pinned by the loader test
 *  below). */
const pageData: OrgActionsGeneralPageDataWithOrg = {
  org,
  ownerId: ORG_ID,
  ...OWNER_ACTIONS_GENERAL_FRESH_DATA,
};

// --- the D1 harness ------------------------------------------------------------

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["user_settings_kv", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, type, created_at) VALUES (7, 'coalition', 'coalition', 'The Coalition', 'org', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, type, created_at) VALUES (2, 'otherowner', 'otherowner', 'Other Owner', 'user', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'coalition', 7, 'demo', 'main', 'public', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-2', 'repo-2', 'coalition', 7, 'site', 'main', 'private', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-f', 'repo-f', 'otherowner', 2, 'theirs', 'main', 'public', unixepoch())",
  ).run();
});

// --- the loader (general.go:46-98 over the landed store) ------------------------

describe("loadOrgActionsGeneralPageData (the store read)", () => {
  it("answers the fresh-owner render inputs for an absent row — mode permissive, the write-all max, enable-max false, an empty allowed list", async () => {
    const data = await loadOrgActionsGeneralPageData(env.DB, org);
    expect(data.tokenPermissionMode).toBe("permissive"); // the absent user_setting row's FromDB EnumValue normalization
    expect(data.maxTokenPermissions).toEqual(makeWriteAllActionsTokenPermissions()); // general.go:76-78's nil fallback
    expect(data.enableMaxTokenPermissions).toBe(false); // MaxTokenPermissions != nil, general.go:80
    expect(data.allowedRepos).toEqual([]); // GetOwnerRepositoriesByIDs' empty-ids arm, repo_list.go:845-847
    expect(data.ownerId).toBe(ORG_ID); // getRunnersCtx's org arm, runners.go:82-91
    // The shared fresh-posture constant is exactly this shape (the user
    // twin re-exports it under OWNER_ACTIONS_GENERAL_FRESH_POSTURE) —
    // derived from the store's absent-row default through the same mapping.
    expect(OWNER_ACTIONS_GENERAL_FRESH_DATA).toEqual({
      tokenPermissionMode: "permissive",
      maxTokenPermissions: makeWriteAllActionsTokenPermissions(),
      enableMaxTokenPermissions: false,
      allowedRepos: [],
    });
    expect(deriveOwnerActionsGeneralData({ tokenPermissionMode: "permissive", maxTokenPermissions: null, allowedCrossRepoIds: [] })).toEqual({
      tokenPermissionMode: "permissive",
      maxTokenPermissions: makeWriteAllActionsTokenPermissions(),
      enableMaxTokenPermissions: false,
    });
  });

  it("answers a saved-owner posture from the store — the stored mode/max/enable and the resolved allowed rows", async () => {
    await setOwnerActionsConfig(env.DB, ORG_ID, {
      tokenPermissionMode: "restricted",
      maxTokenPermissions: { unitAccessModes: { 1: 2 }, idToken: true },
      allowedCrossRepoIds: ["repo-1", "repo-2"],
    });
    const data = await loadOrgActionsGeneralPageData(env.DB, org);
    expect(data.tokenPermissionMode).toBe("restricted");
    expect(data.maxTokenPermissions).toEqual({ unitAccessModes: { 1: 2 }, idToken: true }); // explicit — no nil fallback
    expect(data.enableMaxTokenPermissions).toBe(true); // MaxTokenPermissions != nil, general.go:80
    expect(data.allowedRepos).toEqual([
      { id: "repo-1", fullName: "coalition/demo", link: "/coalition/demo" },
      { id: "repo-2", fullName: "coalition/site", link: "/coalition/site" },
    ]);
  });
});

// --- the DOM (org/settings/actions_general.tmpl + the shared partial) --------

describe("OrgActionsGeneralPage (org/settings/actions_general.tmpl + shared/actions/owner_general_settings.tmpl)", () => {
  it("renders the full document — the EMPTY layout_head dict's trailing-space page-content, the Actions title, OrgHeader, the navbar with General active", () => {
    const html = renderOrgActionsGeneralPage(ctx, pageData);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    // layout_head's `page-content {{.pageClass}}` with an EMPTY dict — Go
    // renders the trailing space (verified on Go 1.27; the module header).
    expect(html).toContain('class="page-content "');
    // The Title is actions.actions (general.go:48) — the aria-label on
    // role=main and the <title> pair.
    expect(html).toContain('aria-label="Actions"');
    expect(html).toContain("<title>Actions - cf-gitea</title>");
    // The org frame (actions_general.tmpl's layout_head pulls org/header).
    expect(html).toContain('<div class="org-setting-content">');
    // The shared navbar with the Actions disclosure open + General active —
    // upstream's own href is the BARE actions URL (navbar.tmpl:32-34, the
    // LocationRedirect's target), not the page URL.
    expect(html).toContain('<details class="item" open');
    expect(html).toContain(`class="active item" href="${ORG_LINK}/settings/actions"`);
    expect(html).toContain(`href="${ORG_LINK}/settings/actions/runners"`);
    expect(html).toContain(`href="${ORG_LINK}/settings/actions/secrets"`);
    expect(html).toContain(`href="${ORG_LINK}/settings/actions/variables"`);
    // Scoped-workflows RENDERED with the store wave's mount (navbar.tmpl:44-45).
    expect(html).toContain(`href="${ORG_LINK}/settings/actions/scoped-workflows"`);
  });

  it("renders the Cross-Repository Access section with upstream's contract (the trailing-space form class included)", () => {
    const html = renderOrgActionsGeneralPage(ctx, pageData);
    expect(html).toContain(`<h4 class="ui top attached header">${orgSettingsActionsGeneralLocale.cross_repo}</h4>`);
    // owner_general_settings.tmpl:5 — the template's own trailing space
    // after form-fetch-action, mirrored verbatim; both forms post to .Link.
    expect(html).toContain(`class="ui form form-fetch-action " action="${GENERAL_LINK}" method="post"`);
    expect(html).toContain(`<div class="help">${orgSettingsActionsGeneralLocale.cross_repo_desc}</div>`);
    expect(html).toContain(`<h5 class="ui header">${orgSettingsActionsGeneralLocale.cross_repo_target_repos}</h5>`);
    // The empty arm (:27-29) — the no-saved-targets posture.
    expect(html).toContain(`<div class="item">${orgSettingsActionsGeneralLocale.repos_none}</div>`);
    expect(html).toContain(`<h5 class="ui header">${orgSettingsActionsGeneralLocale.cross_repo_add}</h5>`);
    // The search-repo-box wrapper kept inert with upstream's attrs (:37-40) —
    // data-uid carries .OwnerID.
    expect(html).toContain('data-global-init="initSearchRepoBox"');
    expect(html).toContain(`data-uid="${ORG_ID}"`);
    expect(html).toContain('data-exclusive="true"');
    expect(html).toContain('name="cross_repo_add_target_name" required="" placeholder="Search repos…" autocomplete="off"');
    expect(html).toContain('name="cross_repo_add_target" value="true"');
    expect(html).toContain(">Add</button>");
  });

  it("renders saved allowed-repo rows — the repo/icon row shape with the link-action Remove buttons", () => {
    const html = renderOrgActionsGeneralPage(ctx, {
      ...pageData,
      allowedRepos: [
        { id: "repo-1", fullName: "coalition/demo", link: "/coalition/demo" },
        { id: "repo-2", fullName: "coalition/site", link: "/coalition/site" },
      ],
    });
    expect(html).not.toContain(`<div class="item">${orgSettingsActionsGeneralLocale.repos_none}</div>`); // the empty arm yields
    expect(html).toContain("octicon-repo"); // the repo/icon svg arm
    expect(html).toContain('href="/coalition/demo">coalition/demo</a>');
    expect(html).toContain('href="/coalition/site">coalition/site</a>');
    expect(html).toContain(`data-url="?cross_repo_remove_target_id=repo-1"`); // the string id space
    expect(html).toContain(`data-url="?cross_repo_remove_target_id=repo-2"`);
    expect(html).toContain(">Remove</button>");
  });

  it("renders the Actions Token Permissions section — the shared partials, no repo-only override checkbox", () => {
    const html = renderOrgActionsGeneralPage(ctx, pageData);
    expect(html).toContain('<h4 class="ui top attached header">Actions Token Permissions</h4>');
    // The permissions form posts to .Link with the bundle hook kept inert.
    expect(html).toContain(`action="${GENERAL_LINK}" method="post" data-global-init="initOwnerActionsPermissionsForm"`);
    // permission_mode_select.tmpl — permissive checked (the no-setting
    // posture), restricted not.
    expect(html).toContain('name="token_permission_mode" value="permissive" checked');
    expect(html).not.toContain('name="token_permission_mode" value="restricted" checked');
    expect(html).toContain('name="token_permission_mode" value="restricted"');
    // The repo page's override_owner_config checkbox is the REPO template's
    // arm — it never renders on the owner page (owner_general_settings.tmpl
    // has no such field).
    expect(html).not.toContain('name="override_owner_config"');
    // permissions_table.tmpl — the enable-max checkbox unchecked, the seven
    // unit rows (the template's own list — packages not rendered) with the
    // write-all radios checked, and the id-token row AT WRITE: the nil-max
    // fallback is MakeWriteAllActionsTokenPermissions (IDToken true —
    // repo_unit_actions.go:54-57), the fresh-owner posture's own grant.
    expect(html).toContain('<input type="checkbox" name="enable_max_permissions"/>'); // unchecked
    for (const unit of ["Code", "Issues", "Pull Requests", "Wiki", "Releases", "Projects", "Actions"]) {
      expect(html).toContain(`<strong>${unit}</strong>`);
    }
    expect(html).not.toContain("<strong>Packages</strong>");
    expect((html.match(/name="max_unit_access_mode_\d+" value="write" checked/g) ?? []).length).toBe(7);
    expect(html).toContain('<input type="radio" name="max_id_token" value="write" checked=""/>');
    expect(html).toContain('<input type="radio" name="max_id_token" value="none"/>');
    expect(html).toContain('type="submit" class="ui primary button">Update Settings</button>');
  });
});

// --- the POST parsers (general.go:25-44 + :119-139 — the parse half) -------------

describe("the form parsers (UpdateGeneralSettings' reads)", () => {
  it("parses the cross-repo form — FormBool's spellings, the name echo, the string remove id (empty = the no-op sentinel)", () => {
    expect(parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_add_target=true&cross_repo_add_target_name=repo-a"))).toEqual({
      crossRepoAddTarget: true,
      crossRepoAddTargetName: "repo-a",
      crossRepoRemoveTargetId: "",
    });
    // The checkbox's value-less "on" spelling (upstream FormBool).
    expect(parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_add_target=on")).crossRepoAddTarget).toBe(true);
    expect(parseOwnerActionsCrossRepoForm(new URLSearchParams("")).crossRepoAddTarget).toBe(false);
    expect(parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_remove_target_id=repo-42")).crossRepoRemoveTargetId).toBe("repo-42");
    // Upstream FormInt64's junk-to-0 no-op arm — the string id space's
    // absent-field arm (junk ids never match a real repositories.id, so a
    // junk value remove is a no-op by non-match).
    expect(parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_remove_target_id=42")).crossRepoRemoveTargetId).toBe("42");
    expect(parseOwnerActionsCrossRepoForm(new URLSearchParams("")).crossRepoRemoveTargetId).toBe("");
  });

  it("parses the permissions form — absent radios read as the empty-string none arm", () => {
    const params = new URLSearchParams("token_permission_mode=restricted&enable_max_permissions=true&max_unit_access_mode_1=write&max_id_token=write");
    const form = parseOwnerActionsPermissionsForm(params);
    expect(form.tokenPermissionMode).toBe("restricted");
    expect(form.enableMaxPermissions).toBe(true);
    expect(form.maxUnitAccessModes[1]).toBe("write");
    expect(form.maxUnitAccessModes[2]).toBe(""); // absent → "" (the parse's default arm)
    expect(form.maxIdToken).toBe("write");
  });

  it("ports ParseMaxTokenPermissions (general.go:25-44) — write/read keywords, everything else none, the id-token literal", () => {
    const form = parseOwnerActionsPermissionsForm(
      new URLSearchParams("max_unit_access_mode_1=write&max_unit_access_mode_2=read&max_unit_access_mode_3=junk&max_id_token=write"),
    );
    const perms = parseMaxTokenPermissions(form);
    expect(perms.unitAccessModes[1]).toBe(2);
    expect(perms.unitAccessModes[2]).toBe(1);
    expect(perms.unitAccessModes[3]).toBe(0); // junk parses none
    expect(perms.unitAccessModes[5]).toBe(0); // absent parses none
    expect(perms.idToken).toBe(true);
    expect(parseMaxTokenPermissions(parseOwnerActionsPermissionsForm(new URLSearchParams("max_id_token=read"))).idToken).toBe(false);
  });
});

// --- the POST arm (UpdateGeneralSettings, general.go:100-161) -------------------

/** The owner's stored config row, parsed for the byte pins — the raw
 *  serialized bytes ARE the store's contract (the Go-marshal pins read them
 *  directly rather than through the typed loader). */
async function storedConfig(userId: number): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare("SELECT setting_value FROM user_settings_kv WHERE user_id = ?").bind(userId).first<{ setting_value: string }>();
  return JSON.parse(row!.setting_value) as Record<string, unknown>;
}

describe("applyOwnerActionsGeneralForms (UpdateGeneralSettings over the owner store)", () => {
  it("saves the add arm — resolves the repo WITHIN the owner, appends the id once", async () => {
    const crossRepo = parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_add_target=true&cross_repo_add_target_name=DEMO"));
    const outcome = await applyOwnerActionsGeneralForms(env.DB, ORG_ID, crossRepo, parseOwnerActionsPermissionsForm(new URLSearchParams("")));
    expect(outcome).toEqual({ outcome: "saved" }); // the wiring's 303-back arm
    const cfg = await storedConfig(ORG_ID);
    expect(cfg.allowed_cross_repo_ids).toEqual(["repo-1"]); // lower_name case-fold (DEMO → demo)
    // Append-if-absent (:131-133): a second add of the same repo is a save, not a duplicate.
    await applyOwnerActionsGeneralForms(env.DB, ORG_ID, crossRepo, parseOwnerActionsPermissionsForm(new URLSearchParams("")));
    const cfg2 = await storedConfig(ORG_ID);
    expect(cfg2.allowed_cross_repo_ids).toEqual(["repo-1"]);
  });

  it("refuses the add arm on an unknown repo — the :125 JSONError outcome, NOTHING stored", async () => {
    const crossRepo = parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_add_target=true&cross_repo_add_target_name=missing"));
    const outcome = await applyOwnerActionsGeneralForms(env.DB, ORG_ID, crossRepo, parseOwnerActionsPermissionsForm(new URLSearchParams("")));
    expect(outcome).toEqual({ outcome: "repo-not-exist" });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_settings_kv WHERE user_id = ?").bind(ORG_ID).first<{ n: number }>();
    expect(row?.n).toBe(0); // the early return skips the save (upstream's control flow)
    // Another OWNER's repo name is unknown through this owner's lens
    // (GetRepositoryByName is owner-pinned — repo.go:763's owner_id arm).
    const foreign = parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_add_target=true&cross_repo_add_target_name=theirs"));
    expect(
      await applyOwnerActionsGeneralForms(env.DB, ORG_ID, foreign, parseOwnerActionsPermissionsForm(new URLSearchParams(""))),
    ).toEqual({ outcome: "repo-not-exist" });
    // And the JSONError body is the :125 literal under the context.go shape.
    expect(OWNER_ACTIONS_REPO_NOT_EXIST_ERROR).toEqual({ errorMessage: "Repository doesn't exist", renderFormat: "text" });
  });

  it("treats an add-flag with an empty name as a no-op that STILL saves (:121's guard → the save)", async () => {
    const crossRepo = parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_add_target=true&cross_repo_add_target_name="));
    const outcome = await applyOwnerActionsGeneralForms(env.DB, ORG_ID, crossRepo, parseOwnerActionsPermissionsForm(new URLSearchParams("")));
    expect(outcome).toEqual({ outcome: "saved" });
    const cfg = await storedConfig(ORG_ID);
    expect(cfg).toEqual({ token_permission_mode: "permissive" }); // the normalized default row written, no ids
  });

  it("removes all occurrences of the remove id (:137-139) — an empty id is the no-op sentinel", async () => {
    await setOwnerActionsConfig(env.DB, ORG_ID, {
      tokenPermissionMode: "permissive",
      maxTokenPermissions: null,
      allowedCrossRepoIds: ["repo-1", "repo-2", "repo-1"],
    });
    await applyOwnerActionsGeneralForms(
      env.DB,
      ORG_ID,
      parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_remove_target_id=repo-1")),
      parseOwnerActionsPermissionsForm(new URLSearchParams("")),
    );
    const cfg = await storedConfig(ORG_ID);
    expect(cfg.allowed_cross_repo_ids).toEqual(["repo-2"]); // SliceRemoveAll, order kept
    // The empty sentinel removes nothing (upstream's 0 arm).
    await applyOwnerActionsGeneralForms(env.DB, ORG_ID, parseOwnerActionsCrossRepoForm(new URLSearchParams("")), parseOwnerActionsPermissionsForm(new URLSearchParams("")));
    const cfg2 = await storedConfig(ORG_ID);
    expect(cfg2.allowed_cross_repo_ids).toEqual(["repo-2"]);
  });

  it("applies the permissions arm — enable-max on parses the radios, off stores nil; loading falls back to write-all", async () => {
    const permsForm = parseOwnerActionsPermissionsForm(
      new URLSearchParams("token_permission_mode=restricted&enable_max_permissions=true&max_unit_access_mode_1=write&max_unit_access_mode_2=read&max_id_token=write"),
    );
    expect(await applyOwnerActionsGeneralForms(env.DB, ORG_ID, parseOwnerActionsCrossRepoForm(new URLSearchParams("")), permsForm)).toEqual({
      outcome: "saved",
    });
    const cfg = await storedConfig(ORG_ID);
    expect(cfg.token_permission_mode).toBe("restricted");
    // ParseMaxTokenPermissions fills ALL eight unit keys (the loop's none
    // default — general.go:25-44); zero-valued map entries are NOT omitted
    // (map omitempty only drops the whole empty map).
    expect(cfg.max_token_permissions).toEqual({ unit_access_modes: { 1: 2, 2: 1, 3: 0, 4: 0, 5: 0, 8: 0, 9: 0, 10: 0 }, id_token: true });
    // enable-max OFF stores nil — the loader answers the write-all fallback
    // with enable-max false (general.go:77-81). (An ON post with NO radios
    // would store the all-none ceiling instead — the parse fills all eight.)
    await applyOwnerActionsGeneralForms(
      env.DB,
      ORG_ID,
      parseOwnerActionsCrossRepoForm(new URLSearchParams("")),
      parseOwnerActionsPermissionsForm(new URLSearchParams("token_permission_mode=restricted")),
    );
    const nilRow = await storedConfig(ORG_ID);
    expect(nilRow.token_permission_mode).toBe("restricted");
    expect(nilRow.max_token_permissions).toBeUndefined();
    const data = await loadOrgActionsGeneralPageData(env.DB, org);
    expect(data.maxTokenPermissions).toEqual(makeWriteAllActionsTokenPermissions());
    expect(data.enableMaxTokenPermissions).toBe(false);
  });

  it("IGNORES an invalid token_permission_mode — the no-refusal EnumValue arm keeps the stored values (:142-152)", async () => {
    // A pre-saved restricted config stays restricted through a junk-mode post.
    await setOwnerActionsConfig(env.DB, ORG_ID, {
      tokenPermissionMode: "restricted",
      maxTokenPermissions: { unitAccessModes: { 1: 1 }, idToken: false },
      allowedCrossRepoIds: [],
    });
    const junk = parseOwnerActionsPermissionsForm(new URLSearchParams("token_permission_mode=custom&enable_max_permissions=true"));
    expect(await applyOwnerActionsGeneralForms(env.DB, ORG_ID, parseOwnerActionsCrossRepoForm(new URLSearchParams("")), junk)).toEqual({
      outcome: "saved", // SAVED — the owner arm has no repo-style refusal
    });
    const cfg = await storedConfig(ORG_ID);
    expect(cfg.token_permission_mode).toBe("restricted"); // the stored values kept
    expect(cfg.max_token_permissions).toEqual({ unit_access_modes: { 1: 1 } }); // the max block skipped whole
    // A fresh owner's junk-mode post saves the normalized default row.
    const junkFresh = await applyOwnerActionsGeneralForms(
      env.DB,
      2,
      parseOwnerActionsCrossRepoForm(new URLSearchParams("")),
      parseOwnerActionsPermissionsForm(new URLSearchParams("token_permission_mode=custom")),
    );
    expect(junkFresh).toEqual({ outcome: "saved" });
    const fresh = await storedConfig(2);
    expect(fresh).toEqual({ token_permission_mode: "permissive" });
  });

  it("keeps owners isolated through the apply — a post on one owner never touches another's row", async () => {
    await setOwnerActionsConfig(env.DB, 2, { tokenPermissionMode: "restricted", maxTokenPermissions: null, allowedCrossRepoIds: [] });
    await applyOwnerActionsGeneralForms(
      env.DB,
      ORG_ID,
      parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_add_target=true&cross_repo_add_target_name=demo")),
      parseOwnerActionsPermissionsForm(new URLSearchParams("")),
    );
    const other = await storedConfig(2);
    expect(other).toEqual({ token_permission_mode: "restricted" }); // untouched
  });
});

// --- the mounted POST (the 4bffff0 glue's route-level matrix) --------------------
//
// The registrations (index.ts: POST /{org}/settings/actions/general → the
// orgActionsGeneralSubmit glue) ride the require-owner prologue
// (resolveOrgTeamsRequest: session → org resolution → the anonymous login
// 303 → the non-owner 404 shell) with sameOriginGuard FIRST (§2.8 layer 2),
// parse BOTH forms, apply over the owner store, and answer the two
// outcomes: the :125 JSONError literal 400 (nothing stored) and the 303
// back onto the page URL (general.go:159-160's JSONRedirect("") + flash,
// the no-session-flash reduction).

async function postUi(path: string, init: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

function formPost(body: Record<string, string>, cookie?: string, origin = "https://test.local"): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(origin === "" ? {} : { origin }),
      ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
    },
    body: new URLSearchParams(body).toString(),
  };
}

/** A fresh org + its owner/member sessions, seeded per test (the file's
 *  beforeEach wipes users/repositories/user_settings_kv): the org rides the
 *  LANDED OrgService (the owner membership row is the route prologue's
 *  isOrgOwner gate), the member is the non-owner 404-shell arm. */
async function seedRouteOrg(): Promise<{ org: OrgRecord; ownerCookie: string; memberCookie: string; ownerId: number }> {
  const owner = await seedVerifiedUser({ username: "genowner" });
  const member = await seedVerifiedUser({ username: "genmember" });
  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({ name: "actionsorg", ownerId: owner.id, visibility: "public", now: T0 });
  await orgs.addMember(org.id, member.id, { now: new Date(T0.getTime() + 1000) });
  return {
    org,
    ownerId: owner.id,
    ownerCookie: await mintSession(env.DB, owner.id),
    memberCookie: await mintSession(env.DB, member.id),
  };
}

describe("the mounted POST /{org}/settings/actions/general (the route-level matrix)", () => {
  it("saves through the router — the permissions post 303s back onto the page and writes the ORG's row", async () => {
    const f = await seedRouteOrg();
    const path = `/${f.org.username}/settings/actions/general`;
    const res = await postUi(
      path,
      formPost({
        token_permission_mode: "restricted",
        enable_max_permissions: "true",
        max_unit_access_mode_1: "write",
        max_unit_access_mode_2: "read",
        max_id_token: "write",
      }, f.ownerCookie),
    );
    expect(res.status).toBe(303); // JSONRedirect("") mapped onto the redirect-back
    expect(res.headers.get("location")).toBe(path);
    const cfg = await storedConfig(f.org.id);
    expect(cfg.token_permission_mode).toBe("restricted");
    // ParseMaxTokenPermissions fills all eight unit keys (the loop's none
    // default) — the same byte pin the applier suite carries.
    expect(cfg.max_token_permissions).toEqual({ unit_access_modes: { 1: 2, 2: 1, 3: 0, 4: 0, 5: 0, 8: 0, 9: 0, 10: 0 }, id_token: true });
  });

  it("adds a cross-repo target through the router — the within-owner resolution lands the id once", async () => {
    const f = await seedRouteOrg();
    const path = `/${f.org.username}/settings/actions/general`;
    const repoId = `route-${f.org.id}`;
    await env.DB.prepare(
      "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES (?, ?, ?, ?, 'demo', 'main', 'public', unixepoch())",
    )
      .bind(repoId, repoId, f.org.usernameLower, f.org.id)
      .run();
    const res = await postUi(path, formPost({ cross_repo_add_target: "true", cross_repo_add_target_name: "DEMO" }, f.ownerCookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(path);
    const cfg = await storedConfig(f.org.id);
    expect(cfg.allowed_cross_repo_ids).toEqual([repoId]); // lower_name case-fold (DEMO → demo)
    // A second add is a save, not a duplicate (append-if-absent, :131-133).
    await postUi(path, formPost({ cross_repo_add_target: "true", cross_repo_add_target_name: "demo" }, f.ownerCookie));
    expect((await storedConfig(f.org.id)).allowed_cross_repo_ids).toEqual([repoId]);
  });

  it("answers the :125 JSONError 400 through the router — the literal body, NOTHING stored", async () => {
    const f = await seedRouteOrg();
    const path = `/${f.org.username}/settings/actions/general`;
    const res = await postUi(path, formPost({ cross_repo_add_target: "true", cross_repo_add_target_name: "missing" }, f.ownerCookie));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await res.json()).toEqual(OWNER_ACTIONS_REPO_NOT_EXIST_ERROR); // context.go:276-278's shape
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_settings_kv WHERE user_id = ?").bind(f.org.id).first<{ n: number }>();
    expect(row?.n).toBe(0); // the early return skips the save
  });

  it("keeps the require-owner prologue on the POST — anonymous 303s to login, a signed-in non-owner 404-shells, an unknown org 404-shells", async () => {
    const f = await seedRouteOrg();
    const path = `/${f.org.username}/settings/actions/general`;
    const body = { token_permission_mode: "restricted" };
    const anon = await postUi(path, formPost(body));
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(path)}`);
    const member = await postUi(path, formPost(body, f.memberCookie));
    expect(member.status).toBe(404); // the non-owner shell — no org context leaks
    const unknown = await postUi("/no-such-org/settings/actions/general", formPost(body, f.ownerCookie));
    expect(unknown.status).toBe(404);
    // The refused posts wrote nothing.
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_settings_kv").first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("rejects a cross-origin write before the session gate (§2.8 layer 2 — the guard answers first)", async () => {
    const f = await seedRouteOrg();
    const path = `/${f.org.username}/settings/actions/general`;
    // No cookie AND a foreign origin: the guard's 403 wins over the login 303.
    const res = await postUi(path, formPost({ token_permission_mode: "restricted" }, undefined, "https://evil.example"));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("cross-origin request rejected\n");
    // Same answer with the owner's cookie — the origin, not the session, decides.
    const ownered = await postUi(path, formPost({ token_permission_mode: "restricted" }, f.ownerCookie, "https://evil.example"));
    expect(ownered.status).toBe(403);
  });

  it("scopes the write to the ORG's owner id — the doer's own user-scope row is never touched", async () => {
    const f = await seedRouteOrg();
    await setOwnerActionsConfig(env.DB, f.ownerId, { tokenPermissionMode: "restricted", maxTokenPermissions: null, allowedCrossRepoIds: [] });
    const path = `/${f.org.username}/settings/actions/general`;
    const res = await postUi(path, formPost({ token_permission_mode: "permissive" }, f.ownerCookie));
    expect(res.status).toBe(303);
    expect((await storedConfig(f.org.id)).token_permission_mode).toBe("permissive"); // the org's row written
    expect(await storedConfig(f.ownerId)).toEqual({ token_permission_mode: "restricted" }); // the doer's row untouched
  });
});
