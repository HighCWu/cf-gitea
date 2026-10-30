/**
 * The USER settings ACTIONS tab's GENERAL sub-tab's tests — the census C9
 * arm's owner page at the user scope (pages/user-settings-actions-general.tsx,
 * the reuse twin of pages/org-settings-actions-general.tsx). The org module's
 * suite pins the SHARED body byte-for-byte (both scopes render the same
 * `shared/actions/owner_general_settings` partial) and the POST applier's
 * arms (UpdateGeneralSettings, general.go:100-161); this suite pins what
 * the user scope genuinely owns: the aliasing re-export surface (now
 * including the POST applier + the JSONError body), the loader's store read
 * keyed on the DOER's id (the absent-row default AND a saved posture over
 * real local D1), the user frame (the EMPTY layout_head dict's
 * trailing-space page-content, the NO `.user-setting-content` wrapper —
 * user/settings/actions_general.tmpl mounts the shared partial directly —
 * and the shared UserSettingsNavbar with General active, the disclosure
 * open, upstream's :43-45 href), and the shared body's presence inside it.
 *
 * The route-level matrix (the signed-in prologue arms, the parse claims,
 * the bare-path 303, the POST registration) lands WITH THE MOUNT — index.ts
 * is a shared file this unit does not edit (the org module header's
 * HANDOFF).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { setOwnerActionsConfig } from "../../services/actions/owner-actions-config";
import type { UiManifest } from "../manifest";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { makeWriteAllActionsTokenPermissions } from "../../services/actions/config";
import { parseOwnerActionsCrossRepoForm as aliasedCrossParser } from "./org-settings-actions-general";
import {
  OWNER_ACTIONS_GENERAL_FRESH_POSTURE,
  applyUserActionsGeneralForms,
  loadUserActionsGeneralPageData,
  parseUserActionsCrossRepoForm,
  parseUserActionsPermissionsForm,
  parseUserMaxTokenPermissions,
  renderUserActionsGeneralPage,
  userSettingsActionsGeneralLocale,
  USER_ACTIONS_REPO_NOT_EXIST_ERROR,
} from "./user-settings-actions-general";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";
const USER_ID = 9;

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: USER_ID, username: "alice", isAdmin: false };

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
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
    "INSERT INTO users (id, username, username_lower, display_name, type, created_at) VALUES (9, 'alice', 'alice', 'Alice Doe', 'user', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'alice', 9, 'scratch', 'main', 'public', unixepoch())",
  ).run();
});

// --- the re-export surface + the loader ----------------------------------------

describe("the user twin's reuse surface (the packages-twin aliasing)", () => {
  it("aliases the org module's scope-neutral pieces onto the user-facing names — parsers, applier, JSONError body", () => {
    expect(parseUserActionsCrossRepoForm).toBe(aliasedCrossParser);
    expect(parseUserMaxTokenPermissions.name).toBe("parseMaxTokenPermissions"); // the same fn, re-exported
    expect(typeof parseUserActionsPermissionsForm).toBe("function");
    expect(typeof applyUserActionsGeneralForms).toBe("function"); // the POST arm's applier, re-exported
    expect(USER_ACTIONS_REPO_NOT_EXIST_ERROR).toEqual({ errorMessage: "Repository doesn't exist", renderFormat: "text" }); // :125's literal
    expect(OWNER_ACTIONS_GENERAL_FRESH_POSTURE.allowedRepos).toEqual([]);
    expect(userSettingsActionsGeneralLocale.actions).toBe("Actions"); // general.go:48's Title
  });

  it("loads the no-setting posture with the DOER as the owner id (the store's absent-row default)", async () => {
    const data = await loadUserActionsGeneralPageData(env.DB, viewer.id);
    expect(data.ownerId).toBe(9); // getRunnersCtx's user arm, runners.go:82-91
    expect(data.tokenPermissionMode).toBe("permissive");
    expect(data.maxTokenPermissions).toEqual(makeWriteAllActionsTokenPermissions());
    expect(data.enableMaxTokenPermissions).toBe(false);
    expect(data.allowedRepos).toEqual([]);
  });

  it("loads a saved-owner posture from the store, keyed on the doer", async () => {
    await setOwnerActionsConfig(env.DB, USER_ID, {
      tokenPermissionMode: "restricted",
      maxTokenPermissions: null,
      allowedCrossRepoIds: ["repo-1"],
    });
    const data = await loadUserActionsGeneralPageData(env.DB, viewer.id);
    expect(data.tokenPermissionMode).toBe("restricted");
    expect(data.maxTokenPermissions).toEqual(makeWriteAllActionsTokenPermissions()); // the nil-max fallback
    expect(data.enableMaxTokenPermissions).toBe(false);
    expect(data.allowedRepos).toEqual([{ id: "repo-1", fullName: "alice/scratch", link: "/alice/scratch" }]);
  });

  it("applies a POST through the re-exported arm — the saved outcome and the owner-pinned refusal", async () => {
    const saved = await applyUserActionsGeneralForms(
      env.DB,
      USER_ID,
      parseUserActionsCrossRepoForm(new URLSearchParams("cross_repo_add_target=true&cross_repo_add_target_name=scratch")),
      parseUserActionsPermissionsForm(new URLSearchParams("")),
    );
    expect(saved).toEqual({ outcome: "saved" });
    const refused = await applyUserActionsGeneralForms(
      env.DB,
      USER_ID,
      parseUserActionsCrossRepoForm(new URLSearchParams("cross_repo_add_target=true&cross_repo_add_target_name=missing")),
      parseUserActionsPermissionsForm(new URLSearchParams("")),
    );
    expect(refused).toEqual({ outcome: "repo-not-exist" });
  });
});

// --- the DOM (user/settings/actions_general.tmpl) --------------------------------

describe("UserActionsGeneralPage (user/settings/actions_general.tmpl + the shared partial)", () => {
  it("renders the full document — the EMPTY layout_head dict's trailing-space page-content and the NO content wrapper", async () => {
    // The full-document render rides the module's renderer (the repo
    // convention — renderPage owns the DOCTYPE).
    const html = renderUserActionsGeneralPage(ctx, await loadUserActionsGeneralPageData(env.DB, viewer.id));
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    // layout_head's `page-content {{.pageClass}}` with an EMPTY dict — Go
    // renders the trailing space (verified on Go 1.27; the org module header).
    expect(html).toContain('class="page-content "');
    expect(html).toContain('aria-label="Actions"');
    // actions_general.tmpl:2 mounts the shared partial DIRECTLY — unlike the
    // family's actions.tmpl switchyard pages there is NO .user-setting-content.
    expect(html).not.toContain("user-setting-content");
  });

  it("renders the shared navbar with General active FIRST in the Actions menu (navbar.tmpl:40's open arm, :43-45's item)", async () => {
    const html = renderUserActionsGeneralPage(ctx, await loadUserActionsGeneralPageData(env.DB, viewer.id));
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

  it("renders the shared owner body inside the user frame (the sections' headline pairs + the forms on .Link)", async () => {
    const html = renderUserActionsGeneralPage(ctx, await loadUserActionsGeneralPageData(env.DB, viewer.id));
    // The shared body is pinned byte-level by the org module's suite — here
    // the frame-level presence pins: both section headers, both forms on the
    // user page URL, the fresh-posture mode radios and the write-all table.
    expect(html).toContain(`<h4 class="ui top attached header">${userSettingsActionsGeneralLocale.cross_repo}</h4>`);
    expect(html).toContain('<h4 class="ui top attached header">Actions Token Permissions</h4>');
    expect(html).toContain('class="ui form form-fetch-action " action="/user/settings/actions/general" method="post"');
    expect(html).toContain('action="/user/settings/actions/general" method="post" data-global-init="initOwnerActionsPermissionsForm"');
    expect(html).toContain('name="token_permission_mode" value="permissive" checked');
    expect(html).toContain(`data-uid="${USER_ID}"`);
    expect((html.match(/name="max_unit_access_mode_\d+" value="write" checked/g) ?? []).length).toBe(7);
    // The write-all max carries the id-token grant (MakeWriteAllActionsToken
    // Permissions' IDToken true) — the fresh owner's row renders write checked.
    expect(html).toContain('<input type="radio" name="max_id_token" value="write" checked=""/>');
  });
});
