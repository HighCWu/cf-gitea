/**
 * The ORG settings ACTIONS tab's GENERAL sub-tab's tests — the census C9
 * arm's owner page at the org scope (pages/org-settings-actions-general.tsx).
 * The module is store-free (the OWNER-level OwnerActionsConfig store is the
 * module header's recorded reduction), so this is the shell.test.tsx harness
 * (hono/jsx through renderPage-owned renderers, no D1): the loader's no-setting posture pins,
 * the full-document DOM contract (org/settings/actions_general.tmpl +
 * shared/actions/owner_general_settings.tmpl at the pin, byte-level where
 * upstream's own quirks live — the trailing-space form class, the
 * `page-content ` attribute), and the POST parsers + the
 * ParseMaxTokenPermissions port (general.go:25-44).
 *
 * The route-level matrix (the require-owner prologue arms, the parse
 * claims, the bare-path 303, the POST tails' engine 404s) lands WITH THE
 * MOUNT — index.ts is a shared file this unit does not edit (the module
 * header's HANDOFF).
 */

import { describe, expect, it } from "vitest";
import type { OrgRecord } from "../../services/orgs/orgs";
import type { UiManifest } from "../manifest";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { makeWriteAllActionsTokenPermissions } from "../../services/actions/config";
import {
  OWNER_ACTIONS_GENERAL_FRESH_DATA,
  loadOrgActionsGeneralPageData,
  renderOrgActionsGeneralPage,
  orgSettingsActionsGeneralLocale,
  parseMaxTokenPermissions,
  parseOwnerActionsCrossRepoForm,
  parseOwnerActionsPermissionsForm,
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

const pageData: OrgActionsGeneralPageDataWithOrg = { org, ...loadOrgActionsGeneralPageData(org) };

// --- the loader (general.go:46-98 at the no-setting posture) -------------------

describe("loadOrgActionsGeneralPageData (the store-free no-setting posture)", () => {
  it("answers upstream's fresh-owner render inputs — mode permissive, the write-all max, enable-max false, an empty allowed list", () => {
    const data = loadOrgActionsGeneralPageData(org);
    expect(data.tokenPermissionMode).toBe("permissive"); // the absent user_setting row's FromDB EnumValue normalization
    expect(data.maxTokenPermissions).toEqual(makeWriteAllActionsTokenPermissions()); // general.go:76-78's nil fallback
    expect(data.enableMaxTokenPermissions).toBe(false); // MaxTokenPermissions != nil, general.go:80
    expect(data.allowedRepos).toEqual([]); // GetOwnerRepositoriesByIDs' empty-ids arm, repo_list.go:845-847
    expect(data.ownerId).toBe(ORG_ID); // getRunnersCtx's org arm, runners.go:82-91
    // The shared fresh-posture constant is exactly this shape (the user
    // twin re-exports it under OWNER_ACTIONS_GENERAL_FRESH_POSTURE).
    expect(OWNER_ACTIONS_GENERAL_FRESH_DATA).toEqual({
      tokenPermissionMode: "permissive",
      maxTokenPermissions: makeWriteAllActionsTokenPermissions(),
      enableMaxTokenPermissions: false,
      allowedRepos: [],
    });
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
    // Scoped-workflows stays the dead sub-item (P1-3's substrate).
    expect(html).not.toContain("scoped-workflows");
  });

  it("renders the Cross-Repository Access section with upstream's contract (the trailing-space form class included)", () => {
    const html = renderOrgActionsGeneralPage(ctx, pageData);
    expect(html).toContain(`<h4 class="ui top attached header">${orgSettingsActionsGeneralLocale.cross_repo}</h4>`);
    // owner_general_settings.tmpl:5 — the template's own trailing space
    // after form-fetch-action, mirrored verbatim; both forms post to .Link.
    expect(html).toContain(`class="ui form form-fetch-action " action="${GENERAL_LINK}" method="post"`);
    expect(html).toContain(`<div class="help">${orgSettingsActionsGeneralLocale.cross_repo_desc}</div>`);
    expect(html).toContain(`<h5 class="ui header">${orgSettingsActionsGeneralLocale.cross_repo_target_repos}</h5>`);
    // The empty arm (:27-29) — the store gap keeps the list empty.
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

// --- the POST parsers (general.go:25-44 + :119-139 — the HANDOFF's parse half) --

describe("the form parsers (UpdateGeneralSettings' reads)", () => {
  it("parses the cross-repo form — FormBool's spellings, the name echo, FormInt64's junk-to-0", () => {
    expect(parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_add_target=true&cross_repo_add_target_name=repo-a"))).toEqual({
      crossRepoAddTarget: true,
      crossRepoAddTargetName: "repo-a",
      crossRepoRemoveTargetId: 0,
    });
    // The checkbox's value-less "on" spelling (upstream FormBool).
    expect(parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_add_target=on")).crossRepoAddTarget).toBe(true);
    expect(parseOwnerActionsCrossRepoForm(new URLSearchParams("")).crossRepoAddTarget).toBe(false);
    expect(parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_remove_target_id=42")).crossRepoRemoveTargetId).toBe(42);
    expect(parseOwnerActionsCrossRepoForm(new URLSearchParams("cross_repo_remove_target_id=junk")).crossRepoRemoveTargetId).toBe(0);
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
