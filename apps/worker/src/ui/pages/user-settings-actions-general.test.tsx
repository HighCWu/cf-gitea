/**
 * The USER settings ACTIONS tab's GENERAL sub-tab's tests — the census C9
 * arm's owner page at the user scope (pages/user-settings-actions-general.tsx,
 * the reuse twin of pages/org-settings-actions-general.tsx). The org module's
 * suite pins the SHARED body byte-for-byte (both scopes render the same
 * `shared/actions/owner_general_settings` partial); this suite pins what the
 * user scope genuinely owns: the aliasing re-export surface, the loader's
 * owner id (the doer's), the user frame (the EMPTY layout_head dict's
 * trailing-space page-content, the NO `.user-setting-content` wrapper —
 * user/settings/actions_general.tmpl mounts the shared partial directly —
 * and the shared UserSettingsNavbar with General active, the disclosure
 * open, upstream's :43-45 href), and the shared body's presence inside it.
 *
 * The route-level matrix (the signed-in prologue arms, the parse claims, the
 * bare-path 303, the POST tails' engine 404s) lands WITH THE MOUNT — index.ts
 * is a shared file this unit does not edit (the org module header's HANDOFF).
 */

import { describe, expect, it } from "vitest";
import type { UiManifest } from "../manifest";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { makeWriteAllActionsTokenPermissions } from "../../services/actions/config";
import { parseOwnerActionsCrossRepoForm as aliasedCrossParser } from "./org-settings-actions-general";
import {
  OWNER_ACTIONS_GENERAL_FRESH_POSTURE,
  loadUserActionsGeneralPageData,
  renderUserActionsGeneralPage,
  parseUserActionsCrossRepoForm,
  parseUserActionsPermissionsForm,
  parseUserMaxTokenPermissions,
  userSettingsActionsGeneralLocale,
} from "./user-settings-actions-general";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 9, username: "alice", isAdmin: false };

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

// --- the re-export surface + the loader ----------------------------------------

describe("the user twin's reuse surface (the packages-twin aliasing)", () => {
  it("aliases the org module's scope-neutral pieces onto the user-facing names", () => {
    expect(parseUserActionsCrossRepoForm).toBe(aliasedCrossParser);
    expect(parseUserMaxTokenPermissions.name).toBe("parseMaxTokenPermissions"); // the same fn, re-exported
    expect(typeof parseUserActionsPermissionsForm).toBe("function");
    expect(OWNER_ACTIONS_GENERAL_FRESH_POSTURE.allowedRepos).toEqual([]);
    expect(userSettingsActionsGeneralLocale.actions).toBe("Actions"); // general.go:48's Title
  });

  it("loads the no-setting posture with the DOER as the owner id", () => {
    const data = loadUserActionsGeneralPageData(viewer.id);
    expect(data.ownerId).toBe(9); // getRunnersCtx's user arm, runners.go:82-91
    expect(data.tokenPermissionMode).toBe("permissive");
    expect(data.maxTokenPermissions).toEqual(makeWriteAllActionsTokenPermissions());
    expect(data.enableMaxTokenPermissions).toBe(false);
    expect(data.allowedRepos).toEqual([]);
  });
});

// --- the DOM (user/settings/actions_general.tmpl) --------------------------------

describe("UserActionsGeneralPage (user/settings/actions_general.tmpl + the shared partial)", () => {
  it("renders the full document — the EMPTY layout_head dict's trailing-space page-content and the NO content wrapper", () => {
    // The full-document render rides the module's renderer (the repo
    // convention — renderPage owns the DOCTYPE).
    const html = renderUserActionsGeneralPage(ctx, loadUserActionsGeneralPageData(viewer.id));
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    // layout_head's `page-content {{.pageClass}}` with an EMPTY dict — Go
    // renders the trailing space (verified on Go 1.27; the org module header).
    expect(html).toContain('class="page-content "');
    expect(html).toContain('aria-label="Actions"');
    // actions_general.tmpl:2 mounts the shared partial DIRECTLY — unlike the
    // family's actions.tmpl switchyard pages there is NO .user-setting-content.
    expect(html).not.toContain("user-setting-content");
  });

  it("renders the shared navbar with General active FIRST in the Actions menu (navbar.tmpl:40's open arm, :43-45's item)", () => {
    const html = renderUserActionsGeneralPage(ctx, loadUserActionsGeneralPageData(viewer.id));
    expect(html).toContain('<details class="item" open');
    expect(html).toContain('class="active item" href="/user/settings/actions/general"');
    // Upstream's item order inside the disclosure: General, Runners,
    // Secrets, Variables — Scoped-workflows stays the dead item.
    const general = html.indexOf('href="/user/settings/actions/general"');
    const runners = html.indexOf('href="/user/settings/actions/runners"');
    const secrets = html.indexOf('href="/user/settings/actions/secrets"');
    const variables = html.indexOf('href="/user/settings/actions/variables"');
    expect(general).toBeGreaterThanOrEqual(0);
    expect(general).toBeLessThan(runners);
    expect(runners).toBeLessThan(secrets);
    expect(secrets).toBeLessThan(variables);
    expect(html).not.toContain("scoped-workflows");
  });

  it("renders the shared owner body inside the user frame (the sections' headline pairs + the forms on .Link)", () => {
    const html = renderUserActionsGeneralPage(ctx, loadUserActionsGeneralPageData(viewer.id));
    // The shared body is pinned byte-level by the org module's suite — here
    // the frame-level presence pins: both section headers, both forms on the
    // user page URL, the fresh-posture mode radios and the write-all table.
    expect(html).toContain(`<h4 class="ui top attached header">${userSettingsActionsGeneralLocale.cross_repo}</h4>`);
    expect(html).toContain('<h4 class="ui top attached header">Actions Token Permissions</h4>');
    expect(html).toContain('class="ui form form-fetch-action " action="/user/settings/actions/general" method="post"');
    expect(html).toContain('action="/user/settings/actions/general" method="post" data-global-init="initOwnerActionsPermissionsForm"');
    expect(html).toContain('name="token_permission_mode" value="permissive" checked');
    expect(html).toContain('data-uid="9"');
    expect((html.match(/name="max_unit_access_mode_\d+" value="write" checked/g) ?? []).length).toBe(7);
    // The write-all max carries the id-token grant (MakeWriteAllActionsToken
    // Permissions' IDToken true) — the fresh owner's row renders write checked.
    expect(html).toContain('<input type="radio" name="max_id_token" value="write" checked=""/>');
  });
});
