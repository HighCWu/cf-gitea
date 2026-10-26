/**
 * The user settings applications page module's tests (pages wave 54, the
 * UNMOUNTED `/user/settings/applications` module): the PAT panel over the
 * landed SPEC-0002 TokenService with real D1 via the vitest plugin — the
 * scope-radio parse + normalization, the create arm's gate order (binder →
 * scope → duplicate), the revoke arm, the loader's HasUsed/HasRecentActivity
 * projections and the render's DOM contract. The module has no route yet
 * (the HANDOFF NOTE in the module header).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { personalAccessTokens, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  TOKENS_LIST_LIMIT,
  createTokenFromForm,
  formatTokenDate,
  loadUserSettingsApplicationsPageData,
  parseUserSettingsApplicationsDeleteForm,
  parseUserSettingsApplicationsForm,
  renderUserSettingsApplicationsPage,
  revokeTokenFromForm,
  tokenScopeCategories,
  userSettingsApplicationsLocale,
} from "./user-settings-applications";

// --- fixtures ----------------------------------------------------------------

const NOW = new Date(1_700_000_000_000); // 2023-11-14T22:13:20Z — the fixed clock
const DAY = 24 * 60 * 60 * 1000;

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const selfViewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };
const adminViewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: true };
const ctx: UiContext = {
  viewer: selfViewer,
  origin: "https://test.local",
  assets: shellAssetsFromManifest(manifest),
};

let aliceId = 0;

async function seedUser(username: string, isAdmin: boolean): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({ username, usernameLower: username.toLowerCase(), isAdmin, createdAt: NOW })
    .returning()
    .all();
  return rows[0]!.id;
}

async function resetTables(): Promise<void> {
  for (const table of ["personal_access_tokens", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  await resetTables();
  aliceId = await seedUser("alice", false);
});

// --- the scope category table -------------------------------------------------

describe("tokenScopeCategories (GetAccessTokenCategories' sorted order)", () => {
  it("sorts the landed category set and strips admin for non-admin viewers", () => {
    expect(tokenScopeCategories(true)).toEqual([
      "activitypub",
      "admin",
      "issue",
      "misc",
      "notification",
      "organization",
      "package",
      "repository",
      "user",
    ]);
    expect(tokenScopeCategories(false)).toEqual([
      "activitypub",
      "issue",
      "misc",
      "notification",
      "organization",
      "package",
      "repository",
      "user",
    ]);
  });
});

// --- the create arm -----------------------------------------------------------

describe("parseUserSettingsApplicationsForm (the scope-* join)", () => {
  it("joins every scope-prefixed form value, ignoring non-scope keys", () => {
    const params = new URLSearchParams();
    params.append("name", "ci");
    params.append("scope-public-only", "");
    params.append("scope-repository", "read:repository");
    params.append("scope-user", "write:user");
    expect(parseUserSettingsApplicationsForm(params)).toEqual({
      name: "ci",
      scopesRaw: ",read:repository,write:user",
    });
    expect(parseUserSettingsApplicationsForm(new URLSearchParams("name=solo"))).toEqual({ name: "solo", scopesRaw: "" });
  });

  it("parseUserSettingsApplicationsDeleteForm coerces the id", () => {
    expect(parseUserSettingsApplicationsDeleteForm(new URLSearchParams("id=7"))).toEqual({ id: 7 });
    expect(parseUserSettingsApplicationsDeleteForm(new URLSearchParams("id=x"))).toEqual({ id: null });
  });
});

describe("createTokenFromForm (upstream CreateAccessToken over the landed mint)", () => {
  it("mints a token: the normalized scope is stored, the plaintext returns once", async () => {
    const form = { name: "ci", scopesRaw: "write:repository,read:user" };
    const result = await createTokenFromForm(env.DB, aliceId, form, NOW);
    expect(result.outcome).toBe("created");
    const plaintext = (result as { plaintext: string }).plaintext;
    expect(plaintext).toMatch(/^cfg_[0-9a-f]{8}_[A-Z2-9]{32}$/); // the twofactor alphabet (2-9, no 0/1)
    const row = (await drizzle(env.DB).select().from(personalAccessTokens).all())[0]!;
    expect(row.name).toBe("ci");
    expect(row.scopes).toBe("write:repository,read:user"); // write carries read
    expect(row.createdAt.getTime()).toBe(NOW.getTime());
  });

  it("answers the at-least-one-permission gate for public-only and empty scopes", async () => {
    expect(await createTokenFromForm(env.DB, aliceId, { name: "ci", scopesRaw: "public-only" }, NOW)).toEqual({
      outcome: "invalid",
      message: userSettingsApplicationsLocale.at_least_one_permission,
    });
    expect(await createTokenFromForm(env.DB, aliceId, { name: "ci", scopesRaw: "" }, NOW)).toEqual({
      outcome: "invalid",
      message: userSettingsApplicationsLocale.at_least_one_permission,
    });
    expect(await drizzle(env.DB).select().from(personalAccessTokens).all()).toHaveLength(0);
  });

  it("answers the binder arms (Name: Required / Name: MaxSize(255)) before the scope work", async () => {
    expect(await createTokenFromForm(env.DB, aliceId, { name: "", scopesRaw: "read:user" }, NOW)).toEqual({
      outcome: "invalid",
      message: "Name: Required",
    });
    expect(
      await createTokenFromForm(env.DB, aliceId, { name: "x".repeat(256), scopesRaw: "read:user" }, NOW),
    ).toEqual({ outcome: "invalid", message: "Name: MaxSize(255)" });
  });

  it("answers the duplicate-name arm with the generate_token_name_duplicate text", async () => {
    await createTokenFromForm(env.DB, aliceId, { name: "ci", scopesRaw: "read:user" }, NOW);
    const again = await createTokenFromForm(env.DB, aliceId, { name: "ci", scopesRaw: "read:misc" }, NOW);
    expect(again).toEqual({
      outcome: "invalid",
      message: "ci has been used as an application name already. Please use a new one.",
    });
  });

  it("answers an unknown scope with the InvalidScopeError message (the tampered-form arm)", async () => {
    const result = await createTokenFromForm(env.DB, aliceId, { name: "ci", scopesRaw: "read:nuclear" }, NOW);
    expect(result).toEqual({ outcome: "invalid", message: "invalid access token scope: read:nuclear" });
  });
});

// --- the revoke arm -------------------------------------------------------------

describe("revokeTokenFromForm (upstream DeleteAccessToken over the landed revoke)", () => {
  it("deletes an owned token and answers missing for an unknown id", async () => {
    const created = await createTokenFromForm(env.DB, aliceId, { name: "ci", scopesRaw: "read:user" }, NOW);
    const row = (await drizzle(env.DB).select().from(personalAccessTokens).all())[0]!;
    expect(await revokeTokenFromForm(env.DB, aliceId, row.id)).toBe("deleted");
    expect(await drizzle(env.DB).select().from(personalAccessTokens).all()).toHaveLength(0);
    expect(await revokeTokenFromForm(env.DB, aliceId, row.id)).toBe("missing");
    expect((created as { plaintext: string }).plaintext).toBeDefined();
  });
});

// --- the loader -------------------------------------------------------------------

describe("loadUserSettingsApplicationsPageData (NewAccessTokensPanel's landed shape)", () => {
  it("projects publicOnly, the scope slice minus public-only, and the usage pair", async () => {
    await createTokenFromForm(env.DB, aliceId, { name: "all", scopesRaw: "write:repository" }, NOW);
    await createTokenFromForm(env.DB, aliceId, { name: "restricted", scopesRaw: "read:user,public-only" }, NOW);
    // bump one token's last-used into the recent window (the 24 h throttle
    // feeds the same pair); creation moves back first so last-used is after it
    const all = await drizzle(env.DB).select().from(personalAccessTokens).all();
    const usedRow = all.find((row) => row.name === "all")!;
    await drizzle(env.DB)
      .update(personalAccessTokens)
      .set({ createdAt: new Date(NOW.getTime() - 30 * DAY), lastUsedAt: new Date(NOW.getTime() - DAY) })
      .where(eq(personalAccessTokens.id, usedRow.id));

    const data = await loadUserSettingsApplicationsPageData(env.DB, aliceId, false, NOW);
    expect(data.tokens).toHaveLength(2);
    const used = data.tokens.find((item) => item.token.name === "all")!;
    expect(used).toMatchObject({ publicOnly: false, scopes: ["write:repository"], hasUsed: true, hasRecentActivity: true });
    const restricted = data.tokens.find((item) => item.token.name === "restricted")!;
    expect(restricted).toMatchObject({ publicOnly: true, scopes: ["read:user"], hasUsed: false, hasRecentActivity: false });
    expect(data.scopeCategories).toEqual(tokenScopeCategories(false));
    expect(data.form).toEqual({ name: "" });
    expect(data.newToken).toBeNull();
  });

  it("caps the list at the render bound", async () => {
    for (let i = 0; i < 3; i++) {
      await createTokenFromForm(env.DB, aliceId, { name: `t${i}`, scopesRaw: "read:user" }, NOW);
    }
    const data = await loadUserSettingsApplicationsPageData(env.DB, aliceId, false, NOW);
    expect(TOKENS_LIST_LIMIT).toBe(500);
    expect(data.tokens).toHaveLength(3);
  });
});

// --- the render -------------------------------------------------------------------

describe("renderUserSettingsApplicationsPage (applications.tmpl + access_tokens.tmpl DOM)", () => {
  it("renders the empty page: pageClass, panel, open generate form, the scope radio table", async () => {
    const data = await loadUserSettingsApplicationsPageData(env.DB, aliceId, false, NOW);
    const html = renderUserSettingsApplicationsPage(ctx, data);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('class="page-content user settings applications"');
    expect(html).toContain("<title>Applications - cf-gitea</title>");
    expect(html).toContain("Manage Access Tokens");
    expect(html).toContain("These tokens grant access to your account using the Gitea API.");
    expect(html).toContain('id="access-token-panel"');
    expect(html).toContain("<details open="); // open when no tokens (hono/jsx boolean attr)
    expect(html).toContain('id="name" name="name" required="" maxlength="255"');
    expect(html).toContain('name="scope-public-only" value="public-only"');
    expect(html).toContain('name="scope-public-only" value="" checked');
    expect(html).toContain('name="scope-activitypub" value="" checked');
    expect(html).toContain('name="scope-repository" value="read:repository"');
    expect(html).toContain('name="scope-user" value="write:user"');
    expect(html).not.toContain("scope-admin"); // stripped for non-admin viewers
    expect(html).toContain('href="/api/swagger" target="_blank"');
    expect(html).toContain("https://docs.gitea.com/development/oauth2-provider#scopes");
    // the navbar reduces to the landed items, applications active
    expect(html).toContain('class="active item" href="/user/settings/applications"');
    expect(html).toContain('href="/user/settings/keys"');
    // the dead controls are omitted
    expect(html).not.toContain("data-fetch-sync");
    expect(html).not.toContain("data-clipboard-target");
    expect(html).not.toContain("modal-dialog");
    expect(html).not.toContain("Regenerate");
  });

  it("renders token rows: name summary, access line, permissions list, delete forms", async () => {
    await createTokenFromForm(env.DB, aliceId, { name: "ci", scopesRaw: "write:repository,public-only" }, NOW);
    const data = await loadUserSettingsApplicationsPageData(env.DB, aliceId, false, NOW);
    const html = renderUserSettingsApplicationsPage(ctx, data);
    expect(html).toContain("<details>"); // closed when tokens exist
    expect(html).toContain('<span class="item-title">ci</span>');
    expect(html).toContain("Public only");
    expect(html).toContain("<li>write:repository</li>");
    expect(html).not.toContain("<li>public-only</li>"); // the ne-filter
    expect(html).toContain("No recent activity");
    const row = data.tokens[0]!;
    expect(html).toContain(`name="id" value="${row.token.id}"`);
    expect(html).toContain('action="/user/settings/applications/delete"');
    expect(html).toContain("Delete");
    expect(html).toContain(`Added on ${formatTokenDate(row.token.createdAt)}`);
  });

  it("renders the admin category for an admin viewer and the one-shot token banner", async () => {
    const adminData = await loadUserSettingsApplicationsPageData(env.DB, aliceId, true, NOW);
    const adminHtml = renderUserSettingsApplicationsPage({ ...ctx, viewer: adminViewer }, adminData);
    expect(adminHtml).toContain("<td>admin</td>");

    const data = await loadUserSettingsApplicationsPageData(env.DB, aliceId, false, NOW);
    const html = renderUserSettingsApplicationsPage(ctx, { ...data, newToken: "cfg_0123abcd_abcdefghijklmnopqrstuvwxyz234567" });
    expect(html).toContain("ui positive message");
    expect(html).toContain(userSettingsApplicationsLocale.generate_token_success);
    expect(html).toContain('id="new-access-token-value">cfg_0123abcd_abcdefghijklmnopqrstuvwxyz234567</code>');
  });

  it("renders the create error line above the form", async () => {
    const data = await loadUserSettingsApplicationsPageData(env.DB, aliceId, false, NOW);
    const html = renderUserSettingsApplicationsPage(ctx, { ...data, form: { name: "dupe" } }, userSettingsApplicationsLocale.at_least_one_permission);
    expect(html).toContain('class="ui negative message">You must select at least one permission to create a token');
    expect(html).toContain('value="dupe"');
  });
});
