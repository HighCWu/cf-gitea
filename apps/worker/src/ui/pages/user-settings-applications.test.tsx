/**
 * The user settings applications page module's tests (pages wave 54, the
 * `/user/settings/applications` module): the PAT panel over the landed
 * SPEC-0002 TokenService with real D1 via the vitest plugin — the
 * scope-radio parse + normalization, the create arm's gate order (binder →
 * scope → duplicate), the revoke arm, the loader's HasUsed/HasRecentActivity
 * projections and the render's DOM contract.
 *
 * Wave 81's deferred matrix (the module is now MOUNTED — index.ts window-2a,
 * GET/POST /user/settings/applications + POST /delete): the upstream arm
 * ORDER at the unit seam (normalize → permission gate → name arms,
 * applications.go:82-106) and the mounted-route round-trips through the real
 * uiRouter — the scope-join→normalize→gate pipeline as the browser posts it,
 * the duplicate/length JSONError arms, the one-shot plaintext banner
 * (created renders exactly once, the reload drops it), the idempotent-303
 * revoke miss, the sorted scope-radio table with admin stripped for
 * non-admins, and the token-row permission list minus public-only.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { oauth2Applications, oauth2Grants, personalAccessTokens, users } from "../../db/schema";
import { createOAuth2Application, verifyClientSecret } from "../../api/services/oauth2-apps";
import { getOrCreateGrant } from "../../services/oauth2/grants";
import { BUILTIN_OAUTH2_CLIENT_IDS, oauth2AppEditLocale } from "./oauth2-app-edit";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { uiEnv } from "../__tests__/harness";
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
  // "sessions" too: the mounted-route matrix below mints session rows (the
  // users delete would cascade them, but the reset stays explicit). The W5
  // oauth2 pair rides the reset too (the builtin seed rows are wiped per
  // test — the lock-arm test seeds its own builtin-clientId row).
  for (const table of ["personal_access_tokens", "sessions", "users", "oauth2_grant", "oauth2_application"]) {
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

// --- the create arm's upstream ORDER (applications.go:82-106) --------------------

describe("createTokenFromForm (the upstream arm order: normalize → permission gate → name arms)", () => {
  it("the permission gate precedes the duplicate arm (a public-only re-name answers at_least_one_permission)", async () => {
    await createTokenFromForm(env.DB, aliceId, { name: "ci", scopesRaw: "read:user" }, NOW);
    expect(await createTokenFromForm(env.DB, aliceId, { name: "ci", scopesRaw: "public-only" }, NOW)).toEqual({
      outcome: "invalid",
      message: userSettingsApplicationsLocale.at_least_one_permission,
    });
  });

  it("normalization precedes the duplicate arm (an invalid-scope re-name answers the InvalidScopeError verbatim)", async () => {
    await createTokenFromForm(env.DB, aliceId, { name: "ci", scopesRaw: "read:user" }, NOW);
    expect(await createTokenFromForm(env.DB, aliceId, { name: "ci", scopesRaw: "write:dispatcher" }, NOW)).toEqual({
      outcome: "invalid",
      message: "invalid access token scope: write:dispatcher",
    });
  });

  it("the length cap precedes the duplicate arm (the mint's binder arm answers before the name lookup)", async () => {
    await createTokenFromForm(env.DB, aliceId, { name: "ci", scopesRaw: "read:user" }, NOW);
    expect(
      await createTokenFromForm(env.DB, aliceId, { name: "x".repeat(256), scopesRaw: "read:user" }, NOW),
    ).toEqual({ outcome: "invalid", message: "Name: MaxSize(255)" });
  });
});

// --- the mounted routes (index.ts window-2a, commit 0c2b151) ----------------------

describe("the mounted /user/settings/applications routes (window-2a over this module)", () => {
  /** A session cookie for the shared beforeEach-seeded alice (the non-admin
   *  principal; the users row already exists). */
  function aliceSession(): Promise<string> {
    return mintSession(env.DB, aliceId);
  }

  /** Seed the admin principal and mint its session cookie (the viewer's
   *  isAdmin is re-read from the users row per request, so the flag lives in
   *  the seed). */
  async function adminSession(): Promise<string> {
    const id = await seedUser("root", true);
    return mintSession(env.DB, id);
  }

  /** POST the urlencoded create form (the browser shape: same-origin POST +
   *  the session cookie — the sameOriginGuard + resolveUiSession order).
   *  Hono's fetch types the dispatch as `Response | Promise<Response>`; the
   *  call sites all await, so the union flows through unchanged. */
  function postCreate(cookie: string, body: URLSearchParams): Promise<Response> | Response {
    return uiRouter.fetch(
      new Request("https://test.local/user/settings/applications", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://test.local",
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        },
        body: body.toString(),
      }),
      uiEnv,
    );
  }

  /** POST the delete form (id as the string the form carries; "x" exercises
   *  the unparseable-id arm). */
  function postDelete(cookie: string, id: string): Promise<Response> | Response {
    return uiRouter.fetch(
      new Request("https://test.local/user/settings/applications/delete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://test.local",
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        },
        body: new URLSearchParams({ id }).toString(),
      }),
      uiEnv,
    );
  }

  function getRoute(path: string, cookie: string): Promise<Response> | Response {
    return uiRouter.fetch(
      new Request(`https://test.local${path}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } }),
      uiEnv,
    );
  }

  /** The rendered generate form's browser body: exactly one value per
   *  scope-* radio group (the checked one), the no-access "" default where
   *  the matrix leaves a category unselected. */
  function renderedFormBody(name: string, selections: Record<string, string>, isAdmin: boolean): URLSearchParams {
    const body = new URLSearchParams({ name });
    body.set("scope-public-only", selections["public-only"] ?? "");
    for (const category of tokenScopeCategories(isAdmin)) {
      body.set(`scope-${category}`, selections[category] ?? "");
    }
    return body;
  }

  it("answers a public-only-alone create with the at-least-one-permission line and mints nothing", async () => {
    const cookie = await aliceSession();
    const res = await postCreate(cookie, renderedFormBody("ci", { "public-only": "public-only" }, false));
    expect(res.status).toBe(200); // the full-page re-render, not a redirect
    const html = await res.text();
    expect(html).toContain('class="ui negative message">You must select at least one permission to create a token');
    // NOTE (wave 81, disclosed): the mounted handler re-renders the name
    // input EMPTY — the submitted-name carry-over the module header's
    // invalid-arm note documents ("the error line + the submitted name")
    // lives in the render seam (form.name, pinned by the render describe)
    // but the window-2a handler passes the freshly-loaded data (form.name
    // "") untouched; the keys twin's handler diverges from its header
    // identically. Not pinned here — index.ts is orchestrator-owned and the
    // wiring-vs-header call is theirs.
    expect(await drizzle(env.DB).select().from(personalAccessTokens).all()).toHaveLength(0);
  });

  it("answers a tampered scope with normalizeScope's error verbatim", async () => {
    const cookie = await aliceSession();
    const res = await postCreate(cookie, renderedFormBody("ci", { user: "read:nuclear" }, false));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('class="ui negative message">invalid access token scope: read:nuclear');
    expect(await drizzle(env.DB).select().from(personalAccessTokens).all()).toHaveLength(0);
  });

  it("joins the rendered scope-* radios into the stored normalized scope (write carries read; repeated keys merge)", async () => {
    const cookie = await aliceSession();
    const res = await postCreate(cookie, renderedFormBody("ci", { repository: "write:repository", user: "read:user" }, false));
    expect(res.status).toBe(200);
    // the tampered repeated-key join (upstream's `scopeNames = append(scopeNames, v...)`)
    // merges under the write implication
    const tampered = renderedFormBody("both", { repository: "read:repository" }, false);
    tampered.append("scope-repository", "write:repository");
    expect((await postCreate(cookie, tampered)).status).toBe(200);
    const rows = await drizzle(env.DB).select().from(personalAccessTokens).all();
    expect(rows.find((row) => row.name === "ci")?.scopes).toBe("write:repository,read:user");
    expect(rows.find((row) => row.name === "both")?.scopes).toBe("write:repository");
  });

  it("answers the duplicate-name create with the upstream JSONError locale text (the <strong> wrapper stripped)", async () => {
    const cookie = await aliceSession();
    await postCreate(cookie, renderedFormBody("ci", { user: "read:user" }, false));
    const res = await postCreate(cookie, renderedFormBody("ci", { user: "read:misc" }, false));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("ci has been used as an application name already. Please use a new one.");
    expect(html).not.toContain("<strong>ci</strong>"); // the locale's HTML tags stripped
    expect(await drizzle(env.DB).select().from(personalAccessTokens).all()).toHaveLength(1);
  });

  it("answers a 256-char name with the MaxSize(255) binder arm and mints nothing", async () => {
    const cookie = await aliceSession();
    const res = await postCreate(cookie, renderedFormBody("x".repeat(256), { user: "read:user" }, false));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('class="ui negative message">Name: MaxSize(255)');
    expect(await drizzle(env.DB).select().from(personalAccessTokens).all()).toHaveLength(0);
  });

  it("renders the minted plaintext exactly once — the one-shot banner drops on reload and the row stores only the digest", async () => {
    const cookie = await aliceSession();
    const created = await postCreate(cookie, renderedFormBody("ci", { user: "read:user" }, false));
    // 200, not a 303 — upstream's flash round-trip would drop the token (the
    // handler's no-fetch-action analog renders the FULL page with newToken).
    expect(created.status).toBe(200);
    const createdHtml = await created.text();
    const plaintext = /cfg_[0-9a-f]{8}_[A-Z2-9]{32}/.exec(createdHtml)?.[0] ?? "";
    expect(plaintext).not.toBe("");
    expect(createdHtml).toContain("ui positive message");
    expect(createdHtml).toContain(userSettingsApplicationsLocale.generate_token_success);
    expect(createdHtml).toContain(`id="new-access-token-value">${plaintext}</code>`);

    // SPEC-0002 §3: the plaintext never persists — only the digest (and the
    // mint-visible 8-hex prefix window) land in D1.
    const row = (await drizzle(env.DB).select().from(personalAccessTokens).all())[0]!;
    expect(row.name).toBe("ci");
    expect(row.sha256Digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(plaintext);

    // the reload: the banner and the value are gone; the token row survives
    const reload = await getRoute("/user/settings/applications", cookie);
    expect(reload.status).toBe(200);
    const reloadHtml = await reload.text();
    expect(reloadHtml).not.toContain("ui positive message");
    expect(reloadHtml).not.toContain(userSettingsApplicationsLocale.generate_token_success);
    expect(reloadHtml).not.toContain(plaintext);
    expect(reloadHtml).toContain('<span class="item-title">ci</span>');
  });

  it("303s home on delete and stays a silent 303 when the id misses (idempotent)", async () => {
    const cookie = await aliceSession();
    await postCreate(cookie, renderedFormBody("ci", { user: "read:user" }, false));
    const row = (await drizzle(env.DB).select().from(personalAccessTokens).all())[0]!;

    const first = await postDelete(cookie, String(row.id));
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/user/settings/applications");
    expect(await drizzle(env.DB).select().from(personalAccessTokens).all()).toHaveLength(0);

    // the stale-form miss: the same id again, then an unparseable one — both
    // silent 303s onto the tab (the module header's no-flash-analog note)
    for (const id of [String(row.id), "x"]) {
      const res = await postDelete(cookie, id);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/user/settings/applications");
    }
    expect(await drizzle(env.DB).select().from(personalAccessTokens).all()).toHaveLength(0);
  });

  it("renders the SORTED scope radio table — admin stripped for the user, present for the admin", async () => {
    const userCookie = await aliceSession();
    const userHtml = await (await getRoute("/user/settings/applications", userCookie)).text();
    const userOrder = tokenScopeCategories(false).map((category) => userHtml.indexOf(`<td>${category}</td>`));
    expect(userOrder.every((position, i) => position >= 0 && (i === 0 || position > userOrder[i - 1]!))).toBe(true);
    expect(userHtml).not.toContain("scope-admin"); // NewAccessTokensPanel's SliceRemoveAll

    const adminCookie = await adminSession();
    const adminHtml = await (await getRoute("/user/settings/applications", adminCookie)).text();
    const adminOrder = tokenScopeCategories(true).map((category) => adminHtml.indexOf(`<td>${category}</td>`));
    expect(adminOrder.every((position, i) => position >= 0 && (i === 0 || position > adminOrder[i - 1]!))).toBe(true);
    expect(adminHtml).toContain('name="scope-admin" value="" checked');
    expect(adminHtml).toContain('value="read:admin"');
    expect(adminHtml).toContain('value="write:admin"');
  });

  it("renders the token row's permission list minus public-only with the Public only access line", async () => {
    const cookie = await aliceSession();
    await postCreate(cookie, renderedFormBody("ci", { "public-only": "public-only", user: "read:user" }, false));
    const html = await (await getRoute("/user/settings/applications", cookie)).text();
    expect(html).toContain('<span class="item-title">ci</span>');
    expect(html).toContain("Public only"); // DisplayPublicOnly()
    expect(html).toContain("<li>read:user</li>");
    expect(html).not.toContain("<li>public-only</li>"); // access_tokens.tmpl's ne-filter
  });
});

// =================================================================================
// W5 (specs/oauth2-provider.md §6 W5): the applications.tmpl OAuth2 halves —
// the grants section (grants_oauth2.tmpl), the applications_oauth2 section
// (applications_oauth2*.tmpl) over the shared edit page
// (pages/oauth2-app-edit.tsx — the OAuth2CommonHandlers port), the
// secret-shown-once posture, and the /oauth2 subgroup's gate.
// =================================================================================

/** Seed one OAuth2 application owned by alice (the landed service). */
async function seedApp(name: string, uid: number, overrides: { clientId?: string } = {}) {
  const { row, secret } = await createOAuth2Application(
    env.DB,
    { uid, name, redirectUris: ["https://ci.example/cb"], confidentialClient: true, skipSecondaryAuthorization: false },
    NOW,
  );
  if (overrides.clientId !== undefined) {
    await drizzle(env.DB).update(oauth2Applications).set({ clientId: overrides.clientId }).where(eq(oauth2Applications.id, row.id));
  }
  return { ...row, clientId: overrides.clientId ?? row.clientId, secret };
}

describe("the loader's OAuth2 half (applications.go:189-203's conditional shape)", () => {
  it("loads the uid-scoped apps + the joined grants when the gate is on", async () => {
    const app = await seedApp("my app", aliceId);
    const { grant } = await getOrCreateGrant(env.DB, { userId: aliceId, applicationId: app.id, scope: "openid read:user" }, NOW);
    const data = await loadUserSettingsApplicationsPageData(env.DB, aliceId, false, NOW, true);
    expect(data.oauth2Enabled).toBe(true);
    expect(data.apps.map((row) => row.id)).toEqual([app.id]);
    expect(data.grants).toHaveLength(1);
    expect(data.grants[0]?.grant.id).toBe(grant.id);
    expect(data.grants[0]?.application.name).toBe("my app");
    expect(data.oauth2Error).toBeNull();
    expect(data.oauth2Form).toEqual({ name: "", redirectUrisRaw: "", confidentialClient: true, skipSecondaryAuthorization: false });
  });

  it("skips the OAuth2 reads entirely when the gate is off (applications.tmpl:5)", async () => {
    await seedApp("my app", aliceId);
    await getOrCreateGrant(env.DB, { userId: aliceId, applicationId: (await seedApp("second", aliceId)).id, scope: "openid" }, NOW);
    const data = await loadUserSettingsApplicationsPageData(env.DB, aliceId, false, NOW, false);
    expect(data.oauth2Enabled).toBe(false);
    expect(data.apps).toEqual([]);
    expect(data.grants).toEqual([]);
  });
});

describe("the render's OAuth2 sections (grants_oauth2.tmpl + applications_oauth2*.tmpl DOM)", () => {
  it("renders the grants section rows with the revoke forms (NO empty-list arm — upstream-exact)", async () => {
    const app = await seedApp("my app", aliceId);
    const { grant } = await getOrCreateGrant(env.DB, { userId: aliceId, applicationId: app.id, scope: "openid read:user" }, NOW);
    const data = await loadUserSettingsApplicationsPageData(env.DB, aliceId, false, NOW, true);
    const html = renderUserSettingsApplicationsPage(ctx, data);
    expect(html).toContain("Authorized OAuth2 Applications");
    expect(html).toContain(userSettingsApplicationsLocale.authorized_oauth2_applications_description);
    expect(html).toContain(`<div class="item-title">my app</div>`);
    expect(html).toContain(`Added on ${formatTokenDate(grant.createdAt)}`);
    expect(html).toContain(`action="/user/settings/applications/oauth2/${app.id}/revoke/${grant.id}"`);
    expect(html).toContain(`>${userSettingsApplicationsLocale.revoke_key}</button>`);
    expect(html).not.toContain("No applications yet"); // the grants template has no empty arm (nor does the app list)
  });

  it("renders the oauth2 application rows with Edit links + Remove forms and the create form", async () => {
    const app = await seedApp("my app", aliceId);
    const data = await loadUserSettingsApplicationsPageData(env.DB, aliceId, false, NOW, true);
    const html = renderUserSettingsApplicationsPage(ctx, data);
    expect(html).toContain("Manage OAuth2 Applications");
    expect(html).toContain(`href="/user/settings/applications/oauth2/${app.id}"`); // the Edit link
    expect(html).toContain("octicon-pencil");
    expect(html).toContain(`action="/user/settings/applications/oauth2/${app.id}/delete"`);
    expect(html).toContain(` ${userSettingsApplicationsLocale.remove}</button>`); // the trash icon precedes the label
    expect(html).toContain(`<span class="ui label"> ${app.clientId}</span>`);
    // The create form's field set (applications_oauth2_list.tmpl:53-77).
    expect(html).toContain('action="/user/settings/applications/oauth2" method="post"');
    expect(html).toContain('name="application_name"');
    expect(html).toContain('name="redirect_uris"');
    expect(html).toContain('name="confidential_client" checked');
    expect(html).toContain('name="skip_secondary_authorization"');
    // The create details stays CLOSED (a fresh GET carries no kept name).
    expect(html).toContain("<details>"); // the PAT generate form... and the oauth2 create
  });

  it("hides BOTH sections when the gate is off; the PAT panel renders regardless", async () => {
    await seedApp("my app", aliceId);
    const data = await loadUserSettingsApplicationsPageData(env.DB, aliceId, false, NOW, false);
    const html = renderUserSettingsApplicationsPage(ctx, data);
    expect(html).toContain("Manage Access Tokens"); // the PAT panel (never gated)
    expect(html).not.toContain("Authorized OAuth2 Applications");
    expect(html).not.toContain("Manage OAuth2 Applications");
    expect(html).not.toContain('action="/user/settings/applications/oauth2"');
  });

  it("re-renders a failed oauth2 create: the kept submission opens the details with the negative banner", async () => {
    const data = await loadUserSettingsApplicationsPageData(env.DB, aliceId, false, NOW, true);
    data.oauth2Form = { name: "kept", redirectUrisRaw: "not-a-uri", confidentialClient: false, skipSecondaryAuthorization: false };
    const html = renderUserSettingsApplicationsPage(ctx, { ...data, oauth2Error: "RedirectURIs is bad" });
    expect(html).toContain('class="ui negative message">RedirectURIs is bad');
    expect(html).toContain('value="kept"');
  });
});

// --- the mounted /user/settings/applications/oauth2[...] subgroup -----------------

describe("the mounted /oauth2 subgroup (web.go:682-689 over the shared edit page)", () => {
  /** A session cookie for the shared beforeEach-seeded alice (the mounted
   *  routes describe's helper is describe-scoped, re-minted here). */
  function aliceCookie(): Promise<string> {
    return mintSession(env.DB, aliceId);
  }

  function getRoute(path: string, cookie: string): Promise<Response> | Response {
    return uiRouter.fetch(
      new Request(`https://test.local${path}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } }),
      uiEnv,
    );
  }

  function oauth2Get(path: string, cookie: string, overrides: Record<string, string> = {}): Promise<Response> | Response {
    return uiRouter.fetch(
      new Request(`https://test.local${path}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } }),
      { ...uiEnv, ...overrides },
    );
  }

  function oauth2Post(path: string, cookie: string, body: string, overrides: Record<string, string> = {}): Promise<Response> | Response {
    return uiRouter.fetch(
      new Request(`https://test.local${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://test.local",
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        },
        body,
      }),
      { ...uiEnv, ...overrides },
    );
  }

  it("create renders the shared EDIT page with the plaintext exactly once; the store keeps the hash and the reload masks it", async () => {
    const cookie = await aliceCookie();
    const created = await oauth2Post(
      "/user/settings/applications/oauth2",
      cookie,
      new URLSearchParams({ application_name: "ci app", redirect_uris: "https://ci.example/cb", confidential_client: "on" }).toString(),
    );
    expect(created.status).toBe(200);
    const html = await created.text();
    const plaintext = /gto_[a-z2-7]{52}/.exec(html)?.[0] ?? "";
    expect(plaintext).not.toBe("");
    expect(html).toContain('id="client-secret" type="text" readonly'); // the shown-once arm
    expect(html).toContain(`value="${plaintext}"`);
    expect(html).toContain('class="page-content user settings applications"'); // the user chrome
    expect(html).toContain('class="active item" href="/user/settings/applications"'); // the Applications tab active
    const row = (await drizzle(env.DB).select().from(oauth2Applications).all())[0]!;
    expect(row.uid).toBe(aliceId);
    expect(await verifyClientSecret(row.clientSecret, plaintext)).toBe(true);
    expect(JSON.stringify(row)).not.toContain(plaintext); // the store keeps the hash only

    // The plain show: the masked placeholder replaces the plaintext.
    const show = await oauth2Get(`/user/settings/applications/oauth2/${row.id}`, cookie);
    expect(show.status).toBe(200);
    const showHtml = await show.text();
    expect(showHtml).toContain('id="client-secret" type="password" readonly');
    expect(showHtml).toContain(oauth2AppEditLocale.masked_secret_placeholder);
    expect(showHtml).not.toContain(plaintext);
    expect(showHtml).toContain(`action="/user/settings/applications/oauth2/${row.id}/regenerate_secret"`);
    // The follow-up list renders the Edit link + the client id.
    const list = await getRoute("/user/settings/applications", cookie);
    const listHtml = await (list).text();
    expect(listHtml).toContain(`href="/user/settings/applications/oauth2/${row.id}"`);
    expect(listHtml).not.toContain(plaintext); // the plaintext never re-renders
  });

  it("create answers the bind arms with the list re-render and writes nothing", async () => {
    const cookie = await aliceCookie();
    const res = await oauth2Post(
      "/user/settings/applications/oauth2",
      cookie,
      new URLSearchParams({ application_name: "", redirect_uris: "https://ci.example/cb" }).toString(),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="ui negative message">Name cannot be empty.');
    expect(await drizzle(env.DB).select().from(oauth2Applications).all()).toHaveLength(0);
    const badUri = await oauth2Post(
      "/user/settings/applications/oauth2",
      cookie,
      new URLSearchParams({ application_name: "x", redirect_uris: "not-a-uri" }).toString(),
    );
    const badHtml = await (badUri).text();
    expect(badHtml).toContain("RedirectURIs: &quot;not-a-uri&quot; is not a valid URL."); // the escaped composite
    expect(await drizzle(env.DB).select().from(oauth2Applications).all()).toHaveLength(0);
  });

  it("save updates WITHOUT rotating the secret and 303s home; a bind error re-renders the edit page; a foreign uid 404-shells", async () => {
    const cookie = await aliceCookie();
    const app = await seedApp("ci app", aliceId);
    const saved = await oauth2Post(
      `/user/settings/applications/oauth2/${app.id}`,
      cookie,
      new URLSearchParams({ application_name: "renamed", redirect_uris: "https://new.example/cb", skip_secondary_authorization: "on" }).toString(),
    );
    expect(saved.status).toBe(303);
    expect((saved).headers.get("location")).toBe("/user/settings/applications");
    const row = (await drizzle(env.DB).select().from(oauth2Applications).all())[0]!;
    expect(row.name).toBe("renamed");
    expect(JSON.parse(row.redirectUris)).toEqual(["https://new.example/cb"]);
    expect(row.skipSecondaryAuthorization).toBe(true);
    // THE WEB SAVE NEVER ROTATES — the original plaintext still verifies.
    expect(await verifyClientSecret(row.clientSecret, app.secret)).toBe(true);

    // The bind-error arm: 200 + the negative line + the kept values, the
    // masked secret (no leak on the error arm), nothing written.
    const invalid = await oauth2Post(
      `/user/settings/applications/oauth2/${app.id}`,
      cookie,
      new URLSearchParams({ application_name: "", redirect_uris: "https://ci.example/cb" }).toString(),
    );
    expect(invalid.status).toBe(200);
    const invalidHtml = await (invalid).text();
    expect(invalidHtml).toContain('class="ui negative message">Name cannot be empty.');
    expect(invalidHtml).toContain('id="client-secret" type="password" readonly');
    const untouched = (await drizzle(env.DB).select().from(oauth2Applications).all())[0]!;
    expect(untouched.name).toBe("renamed");

    // bob's session on alice's app: the EditShow UID check 404-shells.
    const bobId = await seedUser("bob", false);
    const bobCookie = await mintSession(env.DB, bobId);
    const foreign = await oauth2Get(`/user/settings/applications/oauth2/${app.id}`, bobCookie);
    expect(foreign.status).toBe(404);
    const foreignSave = await oauth2Post(
      `/user/settings/applications/oauth2/${app.id}`,
      bobCookie,
      new URLSearchParams({ application_name: "hijack", redirect_uris: "https://evil.example/cb" }).toString(),
    );
    expect(foreignSave.status).toBe(404);
    expect(((await drizzle(env.DB).select().from(oauth2Applications).all())[0] as { name: string }).name).toBe("renamed");
  });

  it("regenerate_secret re-renders with a FRESH plaintext once; the old secret stops verifying", async () => {
    const cookie = await aliceCookie();
    const app = await seedApp("ci app", aliceId);
    const res = await oauth2Post(`/user/settings/applications/oauth2/${app.id}/regenerate_secret`, cookie, "");
    expect(res.status).toBe(200);
    const html = await (res).text();
    const fresh = /gto_[a-z2-7]{52}/.exec(html)?.[0] ?? "";
    expect(fresh).not.toBe("");
    expect(fresh).not.toBe(app.secret);
    expect(html).toContain('id="client-secret" type="text" readonly');
    const row = (await drizzle(env.DB).select().from(oauth2Applications).all())[0]!;
    expect(await verifyClientSecret(row.clientSecret, fresh)).toBe(true);
    expect(await verifyClientSecret(row.clientSecret, app.secret)).toBe(false);
  });

  it("delete 303s home; the builtin lock 404-shells and the row survives", async () => {
    const cookie = await aliceCookie();
    const app = await seedApp("doomed", aliceId);
    const res = await oauth2Post(`/user/settings/applications/oauth2/${app.id}/delete`, cookie, "");
    expect(res.status).toBe(303);
    expect((res).headers.get("location")).toBe("/user/settings/applications");
    expect(await drizzle(env.DB).select().from(oauth2Applications).all()).toHaveLength(0);

    // A user-owned row carrying a builtin client id (a crafted collision):
    // the lock refuses — the list never renders the controls for it, and
    // the crafted POST takes the 404 shell (the landed divergence posture).
    const locked = await seedApp("locked", aliceId, { clientId: BUILTIN_OAUTH2_CLIENT_IDS[0] });
    const lockRes = await oauth2Post(`/user/settings/applications/oauth2/${locked.id}/delete`, cookie, "");
    expect(lockRes.status).toBe(404);
    expect(await drizzle(env.DB).select().from(oauth2Applications).all()).toHaveLength(1);
  });

  it("revoke 303s home and the grant dies; a foreign or missing grant 404-shells", async () => {
    const cookie = await aliceCookie();
    const app = await seedApp("granted app", aliceId);
    const { grant } = await getOrCreateGrant(env.DB, { userId: aliceId, applicationId: app.id, scope: "openid" }, NOW);
    const res = await oauth2Post(`/user/settings/applications/oauth2/${app.id}/revoke/${grant.id}`, cookie, "");
    expect(res.status).toBe(303);
    expect((res).headers.get("location")).toBe("/user/settings/applications");
    expect(await drizzle(env.DB).select().from(oauth2Grants).all()).toHaveLength(0);

    // A foreign grant (bob's) 404-shells; grants belong to individual users
    // (oauth2_common.go:204).
    const bobId = await seedUser("bob", false);
    const bobApp = await seedApp("bob app", bobId);
    const bobGrant = await getOrCreateGrant(env.DB, { userId: bobId, applicationId: bobApp.id, scope: "openid" }, NOW);
    const foreign = await oauth2Post(`/user/settings/applications/oauth2/${bobApp.id}/revoke/${bobGrant.grant.id}`, cookie, "");
    expect(foreign.status).toBe(404);
    expect(await drizzle(env.DB).select().from(oauth2Grants).all()).toHaveLength(1);
    // A missing grant 404-shells too.
    const missing = await oauth2Post(`/user/settings/applications/oauth2/${app.id}/revoke/9999`, cookie, "");
    expect(missing.status).toBe(404);
  });

  it("the gate: OAUTH2_ENABLED=false 403s every subgroup arm and hides the sections on the list page", async () => {
    const cookie = await aliceCookie();
    await seedApp("my app", aliceId);
    for (const [method, path, body] of [
      ["GET", "/user/settings/applications/oauth2/1", ""],
      ["POST", "/user/settings/applications/oauth2", "application_name=x&redirect_uris=https://x.example/cb"],
      ["POST", "/user/settings/applications/oauth2/1", "application_name=x&redirect_uris=https://x.example/cb"],
      ["POST", "/user/settings/applications/oauth2/1/regenerate_secret", ""],
      ["POST", "/user/settings/applications/oauth2/1/delete", ""],
      ["POST", "/user/settings/applications/oauth2/1/revoke/1", ""],
    ] as const) {
      const res =
        method === "GET" ? await oauth2Get(path, cookie, { OAUTH2_ENABLED: "false" }) : await oauth2Post(path, cookie, body, { OAUTH2_ENABLED: "false" });
      expect(res.status).toBe(403);
      expect(await (res).text()).toBe("Forbidden\n"); // web.go:373-378's body
    }
    // The list page still 200s (the PAT panel renders) with both sections
    // hidden.
    const list = await oauth2Get("/user/settings/applications", cookie, { OAUTH2_ENABLED: "false" });
    expect(list.status).toBe(200);
    const listHtml = await (list).text();
    expect(listHtml).toContain("Manage Access Tokens");
    expect(listHtml).not.toContain("Manage OAuth2 Applications");
    expect(listHtml).not.toContain("Authorized OAuth2 Applications");
  });

  it("the POST-only tails answer GET with 405", async () => {
    const cookie = await aliceCookie();
    const create = await oauth2Get("/user/settings/applications/oauth2", cookie);
    expect(create.status).toBe(405);
    const regen = await oauth2Get("/user/settings/applications/oauth2/1/regenerate_secret", cookie);
    expect(regen.status).toBe(405);
    const del = await oauth2Get("/user/settings/applications/oauth2/1/delete", cookie);
    expect(del.status).toBe(405);
    const revoke = await oauth2Get("/user/settings/applications/oauth2/1/revoke/1", cookie);
    expect(revoke.status).toBe(405);
  });
});
