/**
 * The ADMIN CONFIG page's matrix (SPEC-0018 §3.2/§6 — the admin-notices
 * harness shape: module seams over renderToString, plus the MOUNTED route
 * arm driven through `uiRouter.fetch()` with minted sessions).
 *
 * Covered here:
 *   - the SECTION STRUCTURE: upstream config.tmpl's ELEVEN sections in its
 *     fixed order with the upstream headings (config.tmpl:4…304), the
 *     `admin config` pageClass (config.tmpl:1), and the pure-GET posture
 *     (no form anywhere on the page — the write path is §1's §-out);
 *   - the ROW CLASSES (§3.2): REAL rows carrying `data-row-kind="real"`,
 *     POSTURE rows the muted `tw-text-placeholder-text` pairs with
 *     `data-row-kind="posture"` — ssh/mailer/cache are POSTURE-only, every
 *     section carries at least one posture or real row per §3.2's mapping;
 *   - the VALUES-CROSS-CHECK (§6/§8.2): the page's `published` slice is the
 *     misc-t2 constants BY IDENTITY (a page-local copy fails), and every
 *     published field reaches the DOM byte-for-byte;
 *   - the ENV-VAR MATRIX (§6): ALLOW_SIGNUP / DEMO_MODE / AUDIT_RETENTION_DAYS
 *     flips change the corresponding rows;
 *   - the SECRET-HYGIENE rule (§3.2 rule 3): `wrangler secret` values are
 *     structurally unreadable — adminConfigVarsFromEnv drops everything
 *     outside the declared non-secret slice, so the rendered HTML carries no
 *     GIT_TOKEN value even when the env object carries one;
 *   - the MOUNTED ROUTE ARM: the adminPagePrologue gate matrix (anonymous →
 *     the login 303, signed-in non-admin → the 404 shell, site admin → 200)
 *     and the live nav fold (the Configuration group's Summary item active).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { SERVER_VERSION } from "../../api/config";
import {
  GENERAL_API_SETTINGS,
  GENERAL_ATTACHMENT_SETTINGS,
  GENERAL_REPO_SETTINGS,
  GENERAL_UI_SETTINGS,
} from "../../api/routes/misc-t2";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  AdminConfigPage,
  adminConfigLocale,
  adminConfigSection,
  adminConfigVarsFromEnv,
  formatPublishedGroup,
  loadAdminConfigData,
  renderAdminConfigPage,
  type AdminConfigVars,
} from "./admin-config";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The signed-in site admin — the route stage's gate (web.go:779) is the
 *  wiring's posture; the module trusts its inputs. */
const viewer: Viewer = { kind: "user", id: 1, username: "root", isAdmin: true };
const ctx: UiContext = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };

/** The matrix's canonical vars (the wrangler.jsonc.example declared values —
 *  deterministic, independent of the operator-local test env). */
const VARS: AdminConfigVars = {
  appUrl: "https://cf-gitea.example.workers.dev",
  allowSignup: "false",
  demoMode: "false",
  auditRetentionDays: "90",
  packagesLimitSizeGeneric: "536870912",
  packagesLimitTotalOwnerCount: "-1",
  packagesLimitTotalOwnerSize: "-1",
  packagesEnabled: "true",
  packageCleanupOlderThan: "24",
};

async function load(vars: AdminConfigVars = VARS) {
  return loadAdminConfigData(vars);
}

function render(data: Awaited<ReturnType<typeof load>>): string {
  return renderToString(<AdminConfigPage ctx={ctx} data={data} />);
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

// The config arm touches no store — nothing to clean per-test (§4.2).

// --- the section structure (config.tmpl's eleven, in order) -------------------

describe("the admin config sections (config.tmpl at the pin)", () => {
  it("renders exactly the eleven upstream sections in upstream order with upstream headings", async () => {
    const data = await load();
    expect(data.sections.map((section) => section.key)).toEqual([
      "server", // config.tmpl:4
      "ssh", // :47
      "lfs", // :78
      "db", // :94
      "service", // :122
      "webhook", // :172
      "mailer", // :186
      "cache", // :234
      "session", // :259
      "git", // :277
      "log", // :304
    ]);
    const html = render(data);
    for (const title of Object.values(adminConfigLocale.sections)) {
      expect(html).toContain(`<h4 class="ui top attached header">${title}</h4>`);
    }
    expect(html).toContain('class="page-content admin config"'); // config.tmpl:1's own dict
    expect(html).toContain("<dl class=\"admin-dl-horizontal\">"); // the section body shape
  });

  it("the page is a pure GET — nothing posts to it, no write path anywhere (§1's §-out)", async () => {
    const html = render(await load());
    // The document chrome carries the global sign-out form (every page's
    // BaseLayout); the §-out posture is that NOTHING targets THIS page —
    // upstream's ChangeConfig POST and the two test riders have no target
    // here, and no form rides the config content itself.
    expect(html).not.toContain('action="/-/admin/config"');
    expect(html).not.toContain("test_mail");
    expect(html).not.toContain("test_cache");
    const contentStart = html.indexOf('class="admin-setting-content"');
    const contentEnd = html.indexOf('class="page-footer"');
    expect(contentStart).toBeGreaterThan(-1);
    expect(html.slice(contentStart, contentEnd)).not.toContain("<form");
    expect(html.slice(contentStart, contentEnd)).not.toContain("<button");
  });

  it("every section's rows carry a row class; ssh/mailer/cache are POSTURE-only (§3.2's mapping)", async () => {
    const data = await load();
    for (const section of data.sections) {
      expect(section.rows.length).toBeGreaterThan(0);
      for (const row of section.rows) {
        expect(["real", "posture"]).toContain(row.kind);
      }
    }
    expect(adminConfigSection(data, "ssh").rows.every((row) => row.kind === "posture")).toBe(true);
    expect(adminConfigSection(data, "mailer").rows.every((row) => row.kind === "posture")).toBe(true);
    expect(adminConfigSection(data, "cache").rows.every((row) => row.kind === "posture")).toBe(true);
    // The REAL side of the mapping: these sections carry at least one live row.
    for (const key of ["server", "lfs", "db", "service", "webhook", "session", "git", "log"] as const) {
      expect(adminConfigSection(data, key).rows.some((row) => row.kind === "real")).toBe(true);
    }
  });

  it("POSTURE rows render muted (the dashboard's posture-note idiom generalized) and marked in the DOM", async () => {
    const html = render(await load());
    expect(html).toContain('data-row-kind="posture"');
    expect(html).toContain('data-row-kind="real"');
    // The muted pair: the posture dd carries the placeholder-text class.
    expect(html).toMatch(/<dt class="tw-text-placeholder-text">[^<]+<\/dt><dd class="tw-text-placeholder-text" data-row-kind="posture">/);
    // REAL dds never carry the muted class.
    expect(html).not.toMatch(/data-row-kind="real" class="tw-text-placeholder-text"/);
  });

  it("renders the build-time REAL inventory: SERVER_VERSION, the posture absent-families, engine and provider lines", async () => {
    const html = render(await load());
    expect(html).toContain(`>${SERVER_VERSION}</dd>`); // src/api/config.ts:13
    expect(html).toContain("no SSH server — git smart-HTTP over HTTPS only");
    expect(html).toContain("no mailer — email notifications absent");
    expect(html).toContain("no cache adapter — stateless workers");
    expect(html).toContain("no app.ini — configuration is the wrangler vars applied at deploy");
    expect(html).toContain("Cloudflare D1 (binding DB)");
    expect(html).toContain("Cloudflare D1 (the sessions table)");
    expect(html).toContain("packages/git-engine");
    expect(html).toContain("binding REPO_PACKS");
    expect(html).toContain("webhookDeliveries ledger row");
    expect(html).toContain("no instance-name setting"); // §8.6's POSTURE site-title row
    expect(html).toContain("*/10 * * * *"); // the cron expressions verbatim
    expect(html).toContain("0 * * * *");
    expect(html).toContain("repo-tasks-dlq"); // the DLQ wiring
  });

  it("the full-document render path matches the component path", async () => {
    const data = await load();
    expect(renderAdminConfigPage(ctx, data)).toContain('class="page-content admin config"');
  });
});

// --- the values cross-check (§6 — §8.2's single-source guarantee) --------------

describe("the values cross-check (misc-t2 GENERAL_* — imported, not re-declared)", () => {
  it("the published slice IS the misc-t2 constants by identity (a page-local copy fails here)", async () => {
    const data = await load();
    expect(data.published.api).toBe(GENERAL_API_SETTINGS);
    expect(data.published.attachment).toBe(GENERAL_ATTACHMENT_SETTINGS);
    expect(data.published.repo).toBe(GENERAL_REPO_SETTINGS);
    expect(data.published.ui).toBe(GENERAL_UI_SETTINGS);
  });

  it("every published field of every group reaches the DOM byte-for-byte", async () => {
    const html = render(await load());
    for (const group of [GENERAL_API_SETTINGS, GENERAL_ATTACHMENT_SETTINGS, GENERAL_REPO_SETTINGS, GENERAL_UI_SETTINGS]) {
      expect(html).toContain(formatPublishedGroup(group));
    }
    // Literal spot-checks so a formatter bug cannot self-satisfy: the known
    // published numbers must appear in their rendered key=value shape.
    expect(html).toContain(`default_paging_num=${GENERAL_API_SETTINGS.default_paging_num}`);
    expect(html).toContain(`default_git_trees_per_page=${GENERAL_API_SETTINGS.default_git_trees_per_page}`);
    expect(html).toContain("max_size=512"); // OUR real 413 threshold (misc-t2:512-513)
    expect(html).toContain("536870912 bytes (512 MiB)"); // the size-cap VAR row annotates MiB
    expect(html).toContain("time_tracking_disabled=true"); // the honest advertisement
    expect(html).toContain(`default_theme=${GENERAL_UI_SETTINGS.default_theme}`);
  });
});

// --- the env-var matrix (§6 — flips change the corresponding rows) --------------

describe("the env-var matrix (wrangler vars at request time, §5.9)", () => {
  it("ALLOW_SIGNUP flips the self-registration row", async () => {
    const closed = await load({ ...VARS, allowSignup: "false" });
    expect(adminConfigSection(closed, "service").rows.some((row) => row.value.includes('ALLOW_SIGNUP="false"'))).toBe(true);
    const open = await load({ ...VARS, allowSignup: "true" });
    expect(adminConfigSection(open, "service").rows.some((row) => row.value.includes('ALLOW_SIGNUP="true"'))).toBe(true);
    expect(render(open)).toContain("/user/sign_up is served");
  });

  it("DEMO_MODE flips the demo-operations row (strict polarity — only \"true\" arms)", async () => {
    const off = await load({ ...VARS, demoMode: "false" });
    expect(adminConfigSection(off, "server").rows.some((row) => row.value.includes('DEMO_MODE="false"'))).toBe(true);
    expect(render(off)).toContain("fail-closed");
    const armed = await load({ ...VARS, demoMode: "true" });
    expect(adminConfigSection(armed, "server").rows.some((row) => row.value.includes('DEMO_MODE="true"'))).toBe(true);
    expect(render(armed)).toContain("armed");
  });

  it("AUDIT_RETENTION_DAYS flips the retention row — a non-positive value disarms it", async () => {
    const days = await load({ ...VARS, auditRetentionDays: "90" });
    expect(adminConfigSection(days, "server").rows.some((row) => row.value.includes("90 days"))).toBe(true);
    const disarmed = await load({ ...VARS, auditRetentionDays: "0" });
    expect(adminConfigSection(disarmed, "server").rows.some((row) => row.value.includes("disarmed"))).toBe(true);
    const junk = await load({ ...VARS, auditRetentionDays: "soon" });
    expect(adminConfigSection(junk, "server").rows.some((row) => row.value.includes("disarmed"))).toBe(true);
  });

  it("APP_URL renders verbatim into the server section", async () => {
    const html = render(await load({ ...VARS, appUrl: "https://config-matrix.test" }));
    expect(html).toContain(">https://config-matrix.test</dd>");
  });

  it("the unset packages vars render their effective code defaults (the strict-polarity readers' own fallbacks)", async () => {
    const defaulted = adminConfigVarsFromEnv({
      APP_URL: VARS.appUrl,
      ALLOW_SIGNUP: VARS.allowSignup,
      DEMO_MODE: VARS.demoMode,
      AUDIT_RETENTION_DAYS: VARS.auditRetentionDays,
    });
    expect(defaulted.packagesLimitSizeGeneric).toBe("536870912"); // model.ts DEFAULT_LIMIT_SIZE_GENERIC
    expect(defaulted.packagesLimitTotalOwnerCount).toBe("-1"); // UNLIMITED_QUOTA
    expect(defaulted.packagesEnabled).toBe("true"); // model.ts `!== "false"`
    expect(defaulted.packageCleanupOlderThan).toBe("24"); // cleanup.ts DEFAULT_CLEANUP_OLDER_THAN_HOURS
    const html = render(await load(defaulted));
    expect(html).toContain("536870912 bytes (512 MiB)");
    expect(html).toContain("unlimited (-1)");
  });
});

// --- the secret hygiene (§3.2 rule 3 — SECRET rows never exist) ------------------

describe("the secret hygiene rule (wrangler secret values are never read)", () => {
  it("adminConfigVarsFromEnv drops everything outside the declared non-secret slice", () => {
    // The env object carries a secret-shaped value; the projection's output
    // type has no field for it and the runtime copy carries no trace. The
    // wide variable (not a fresh literal at the call site) mirrors a real
    // env object that happens to carry the declared secret — no cast.
    const envWithSecret = {
      APP_URL: VARS.appUrl,
      ALLOW_SIGNUP: VARS.allowSignup,
      DEMO_MODE: VARS.demoMode,
      AUDIT_RETENTION_DAYS: VARS.auditRetentionDays,
      GIT_TOKEN: "super-secret-git-token-value",
    };
    const projected = adminConfigVarsFromEnv(envWithSecret);
    expect(JSON.stringify(projected)).not.toContain("super-secret-git-token-value");
    expect(Object.keys(projected).sort()).toEqual([
      "allowSignup",
      "appUrl",
      "auditRetentionDays",
      "demoMode",
      "packageCleanupOlderThan",
      "packagesEnabled",
      "packagesLimitSizeGeneric",
      "packagesLimitTotalOwnerCount",
      "packagesLimitTotalOwnerSize",
    ]);
  });

  it("the rendered HTML carries no secret value even when the env carries one (§6)", async () => {
    const data = await load(VARS);
    const html = renderAdminConfigPage(ctx, data);
    expect(html).not.toContain("super-secret-git-token-value");
    expect(html).not.toContain("GIT_TOKEN");
  });
});

// --- the mounted route arm (the SPEC-0018 mount, driven through uiRouter.fetch) --

type ConfigUiTestEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const configAssets: UiAssetsFetcher = {
  fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })),
};

const configUiEnv: ConfigUiTestEnv = { ...env, ASSETS: configAssets };

describe("the mounted /-/admin/config route arm (SPEC-0018 §3.2)", () => {
  /** The route gate's two non-anonymous principals: the site admin (user 1)
   *  and a signed-in plain member (user 2 — AdminRequired's 404 arm). */
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM sessions").run();
    await env.DB
      .prepare(
        "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES " +
          "(1, 'admin', 'admin', 'Site Admin', 1, unixepoch()), " +
          "(2, 'member', 'member', 'Plain Member', 0, unixepoch())",
      )
      .run();
  });

  async function getConfig(cookie: string | null): Promise<Response> {
    return uiRouter.fetch(
      new Request(`${ORIGIN}/-/admin/config`, {
        headers: cookie === null ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      }),
      configUiEnv,
    );
  }

  it("GET 200 for the site admin — the eleven sections and the Configuration nav item ACTIVE", async () => {
    const res = await getConfig(await mintSession(env.DB, 1));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content admin config"');
    expect(html).toContain("Server Configuration");
    expect(html).toContain("Log Configuration");
    expect(html).toContain(SERVER_VERSION);
    // The nav fold: the Configuration group opens with the Summary item
    // active here (navbar.tmpl:93-102's PageIsAdminConfigSummary posture),
    // positioned before the System Notices item.
    expect(html).toContain('class="active item" href="/-/admin/config"');
    expect(html.indexOf("/-/admin/config")).toBeLessThan(html.indexOf("/-/admin/notices"));
    expect(html).toContain("<summary>Configuration</summary>");
  });

  it("GET 303s the anonymous viewer onto the login round-trip (web.go:779's SignInRequired)", async () => {
    const res = await getConfig(null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/admin/config")}`);
  });

  it("GET 404-shells the signed-in non-admin (AdminRequired's hidden-surface posture)", async () => {
    const res = await getConfig(await mintSession(env.DB, 2));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain('class="page-content admin config"');
    expect(html).not.toContain("Server Configuration");
  });

  it("POST /-/admin/config answers no write path — the §3.2 verdict's unclaimed shape", async () => {
    const res = await uiRouter.fetch(
      new Request(`${ORIGIN}/-/admin/config`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: "key[]=x&value[]=y",
      }),
      configUiEnv,
    );
    // Upstream answers ChangeConfig's 303; we build NO write path (§1) — the
    // GET-only listing pages' posture: never a 200 render of this page.
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain('class="page-content admin config"');
  });
});
