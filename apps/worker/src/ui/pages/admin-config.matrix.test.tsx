/**
 * The ADMIN CONFIG page's matrix (SPEC-0018 §3.2/§6 — the admin-notices
 * harness shape: module seams over renderToString, plus the MOUNTED route
 * arms driven through `uiRouter.fetch()` with minted sessions).
 *
 * Covered here:
 *   - the SECTION STRUCTURE: upstream config.tmpl's ELEVEN sections in its
 *     fixed order with the upstream headings (config.tmpl:4…304), the
 *     `admin config` pageClass (config.tmpl:1), and the FORM-FREE posture
 *     while the mailer is disarmed (the canonical vars) — armed, exactly one
 *     form rides the page: the SendTestMail rider (config.tmpl:220-228,
 *     inside the mailer section's dl, config.tmpl:192's `{{if
 *     .MailerEnabled}}` wrap);
 *   - the ROW CLASSES (§3.2): REAL rows carrying `data-row-kind="real"`,
 *     POSTURE rows the muted `tw-text-placeholder-text` pairs with
 *     `data-row-kind="posture"` — ssh/cache are POSTURE-only, the mailer
 *     is REAL as-built (the outbound mailer landed; its send-test-mail
 *     rider is the FORM when armed, the POSTURE note when disarmed), every
 *     section carries at least one posture or real row per §3.2's mapping;
 *   - the SENDTESTMAIL RIDER (the census B-69 arm): the upstream form DOM
 *     byte-shapes, the flash banner arms (the re-render convention's
 *     `ui positive/negative message`), and the two flash texts verbatim
 *     (config.go:34/:36) with the silent-success posture documented;
 *   - the VALUES-CROSS-CHECK (§6/§8.2): the page's `published` slice is the
 *     misc-t2 constants BY IDENTITY (a page-local copy fails), and every
 *     published field reaches the DOM byte-for-byte;
 *   - the ENV-VAR MATRIX (§6): ALLOW_SIGNUP / DEMO_MODE / AUDIT_RETENTION_DAYS
 *     flips change the corresponding rows;
 *   - the SECRET-HYGIENE rule (§3.2 rule 3): `wrangler secret` values are
 *     structurally unreadable — adminConfigVarsFromEnv drops everything
 *     outside the declared non-secret slice, so the rendered HTML carries no
 *     GIT_TOKEN value even when the env object carries one;
 *   - the MOUNTED ROUTE ARMS: the adminPagePrologue gate matrix (anonymous →
 *     the login 303, signed-in non-admin → the 404 shell, site admin → 200),
 *     the live nav fold (the Configuration group's Summary item active), the
 *     ChangeConfig POST's unclaimed shape, and the B-69 POST battery — the
 *     guard/prologue ladder, the silent-success flash on the disarmed
 *     deployment, the sent flash over the dummy transport (no email_outbox
 *     row — the direct send bypasses the ledger), the failure flashes
 *     verbatim (no FROM / no recipient / the provider-less config error),
 *     the body-then-query merge, and the GET 405 twin.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";
import { drizzle } from "drizzle-orm/d1";

import { SERVER_VERSION } from "../../api/config";
import {
  GENERAL_API_SETTINGS,
  GENERAL_ATTACHMENT_SETTINGS,
  GENERAL_REPO_SETTINGS,
  GENERAL_UI_SETTINGS,
} from "../../api/routes/misc-t2";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { emailOutbox } from "../../db/schema";
import { uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  AdminConfigPage,
  adminConfigLocale,
  adminConfigSection,
  adminConfigTestMailFailedText,
  adminConfigTestMailLocale,
  adminConfigTestMailSentText,
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
  mailEnabled: "false",
  enableNotifyMail: "",
  mailProvider: "dummy",
  mailFrom: "",
  mailSubjectPrefix: "",
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

  it("disarmed (the canonical vars), the page keeps the form-free posture — the write §-outs stay unclaimed", async () => {
    const html = render(await load());
    // The document chrome carries the global sign-out form (every page's
    // BaseLayout); the DISARMED posture is that the config content itself
    // carries no form: upstream's ChangeConfig POST has no target here, the
    // test_cache rider is absent with the cache adapter, and the test-mail
    // rider's form is unrendered while the mailer is off (config.tmpl:192's
    // {{if .MailerEnabled}} wrap) — the section carries the posture note
    // instead.
    expect(html).not.toContain('action="/-/admin/config"');
    expect(html).not.toContain("test_mail");
    expect(html).not.toContain("test_cache");
    const contentStart = html.indexOf('class="admin-setting-content"');
    const contentEnd = html.indexOf('class="page-footer"');
    expect(contentStart).toBeGreaterThan(-1);
    expect(html.slice(contentStart, contentEnd)).not.toContain("<form");
    expect(html.slice(contentStart, contentEnd)).not.toContain("<button");
  });

  it("armed, exactly one form rides the page — the SendTestMail rider's upstream DOM (config.tmpl:220-228)", async () => {
    const html = render(await load({ ...VARS, mailEnabled: "true" }));
    const contentStart = html.indexOf('class="admin-setting-content"');
    const contentEnd = html.indexOf('class="page-footer"');
    const content = html.slice(contentStart, contentEnd);
    expect(content.match(/<form/g)?.length).toBe(1); // exactly one form on the whole page
    // The form pair byte-shapes (config.tmpl:219-227: divider, the
    // flex-text-block dt, the tw-py-0 dd, the ui form with its tiny input
    // and primary tiny button; NO CSRF token at the pin).
    expect(html).toContain(`<dt class="flex-text-block tw-py-1">${adminConfigTestMailLocale.rowLabel}</dt>`);
    expect(html).toContain('<dd class="tw-py-0"><form class="ui form ignore-dirty" action="/-/admin/config/test_mail" method="post">');
    expect(html).toContain('<div class="divider"></div>');
    expect(html).toContain(
      `<input type="email" name="email" placeholder="${adminConfigTestMailLocale.placeholder}" size="29" required=""/>`,
    );
    expect(html).toContain(`<button type="submit" class="ui tiny primary button">${adminConfigTestMailLocale.submit}</button>`);
    // The form sits INSIDE the mailer section's dl (the section's rows render
    // first: the From row's dd precedes the rider).
    expect(html.indexOf("MAIL_FROM")).toBeLessThan(html.indexOf('action="/-/admin/config/test_mail"'));
    // And the rider's posture note is GONE (the form replaces it).
    expect(html).not.toContain("form not rendered — upstream renders the test-mail form");
  });

  it("every section's rows carry a row class; ssh/cache are POSTURE-only, the mailer is REAL now (§3.2's mapping as-built)", async () => {
    const data = await load();
    for (const section of data.sections) {
      expect(section.rows.length).toBeGreaterThan(0);
      for (const row of section.rows) {
        expect(["real", "posture"]).toContain(row.kind);
      }
    }
    expect(adminConfigSection(data, "ssh").rows.every((row) => row.kind === "posture")).toBe(true);
    expect(adminConfigSection(data, "cache").rows.every((row) => row.kind === "posture")).toBe(true);
    // The mailer LANDED (specs/email-outbound.md): the four var rows are
    // REAL; DISARMED, the send-test-mail rider is the section's last row —
    // the posture note standing in for the armed-only form (config.tmpl:192's
    // wrap). Armed, the note row is GONE (the form renders in its place —
    // the rider describe pins that DOM).
    const mailer = adminConfigSection(data, "mailer");
    expect(mailer.rows.some((row) => row.kind === "real")).toBe(true);
    expect(mailer.rows.at(-1)?.kind).toBe("posture");
    expect(mailer.rows.at(-1)?.label).toContain("Send-test-mail");
    const armedMailer = adminConfigSection(await load({ ...VARS, mailEnabled: "true" }), "mailer");
    expect(armedMailer.rows.some((row) => row.label.includes("Send-test-mail"))).toBe(false);
    // The REAL side of the mapping: these sections carry at least one live row.
    for (const key of ["server", "lfs", "db", "service", "webhook", "mailer", "session", "git", "log"] as const) {
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
    const data = await load();
    const html = render(data);
    expect(html).toContain(`>${SERVER_VERSION}</dd>`); // src/api/config.ts:13
    expect(html).toContain("no SSH server — git smart-HTTP over HTTPS only");
    // The mailer LANDED — the false "no mailer" posture line is retired;
    // the section renders the four REAL var rows (canonical example values;
    // quoted values assert at the DATA level — JSX escapes them in text) and
    // the send-test-mail POSTURE row citing SPEC-0018's §-out.
    const mailer = adminConfigSection(data, "mailer");
    expect(mailer.rows.some((row) => row.value.includes('off (MAIL_ENABLED="false") — strict polarity, only the exact string "true" arms the senders'))).toBe(true);
    expect(mailer.rows.some((row) => row.value.includes('dummy (MAIL_PROVIDER="dummy") — render+log, upstream\'s dummy protocol; any non-"resend" value rides dummy'))).toBe(true);
    expect(mailer.rows.some((row) => row.value.includes('empty (MAIL_FROM="") — an armed mailer with no parseable From skips the send and logs'))).toBe(true);
    expect(mailer.rows.some((row) => row.value.includes('empty (MAIL_SUBJECT_PREFIX="") — subjects render unprefixed'))).toBe(true);
    // The DISARMED rider's posture note (the armed form replaces it — the
    // rider describe). Apostrophe-bearing fragments assert separately (JSX
    // escapes &#39; in text).
    expect(html).toContain("form not rendered — upstream renders the test-mail form inside this section only while the mailer is enabled");
    expect(html).toContain("the POST rider itself still answers upstream");
    expect(html).toContain("silent success (config.go:29-41 over mail.go:44-46");
    expect(html).toContain("MailService==nil nil return), so a disarmed deployment flashes success without sending");
    // The service posture row no longer claims "no mailer / no external
    // login chain" — both landed; the remaining absences are named.
    expect(html).toContain("no email-confirmation flow and no captcha");
    expect(html).toContain("the LANDED OAuth2 auth sources (/-/admin/auths");
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
    // The MAIL_* family defaults with the readers' own postures.
    expect(defaulted.mailEnabled).toBe("false"); // notify.ts/register-notify.ts `!== "true"`
    expect(defaulted.mailProvider).toBe("dummy"); // transport.ts:128's unset/empty arm
    expect(defaulted.mailFrom).toBe("");
    expect(defaulted.mailSubjectPrefix).toBe("");
    const html = render(await load(defaulted));
    expect(html).toContain("536870912 bytes (512 MiB)");
    expect(html).toContain("unlimited (-1)");
    const mailer = adminConfigSection(await load(defaulted), "mailer");
    expect(mailer.rows[0]?.value).toContain('off (MAIL_ENABLED="false")');
  });

  it("MAIL_ENABLED / MAIL_PROVIDER flip the mailer rows (strict polarity — only \"true\" arms, \"resend\" selects the relay)", async () => {
    const armed = await load({ ...VARS, mailEnabled: "true", mailProvider: "resend", mailFrom: "no-reply@cf-gitea.test" });
    const mailer = adminConfigSection(armed, "mailer");
    expect(mailer.rows.some((row) => row.value.includes('armed (MAIL_ENABLED="true")'))).toBe(true);
    expect(mailer.rows.some((row) => row.value.includes('resend (MAIL_PROVIDER="resend")'))).toBe(true);
    expect(mailer.rows.some((row) => row.value.includes('no-reply@cf-gitea.test (MAIL_FROM="no-reply@cf-gitea.test")'))).toBe(true);
    const armedHtml = render(armed);
    expect(armedHtml).toContain("the senders gate on the parseable MAIL_FROM");
    expect(armedHtml).toContain("the key rides the MAIL_PROVIDER_API_KEY secret (never rendered)");
    const disabled = await load({ ...VARS, mailEnabled: "TRUE" }); // NOT the exact string
    expect(adminConfigSection(disabled, "mailer").rows.some((row) => row.value.includes('off (MAIL_ENABLED="TRUE")'))).toBe(true);
  });
});

// --- the SendTestMail rider (the census B-69 arm: config.tmpl:220-228's form
// over config.go:29-41's handler — the flash IS the outcome surface) -------

describe("the SendTestMail rider (the census B-69 arm)", () => {
  it("the flash texts are upstream's locale strings verbatim (config.go:34/:36 over locale_en-US.json)", () => {
    expect(adminConfigTestMailSentText("root@test.local")).toBe('A testing email has been sent to "root@test.local".');
    expect(adminConfigTestMailFailedText("root@test.local", "no FROM specified")).toBe(
      'Failed to send a testing email to "root@test.local": no FROM specified',
    );
    expect(adminConfigTestMailLocale.rowLabel).toBe("Send Testing Email"); // "admin.config.send_test_mail"
    expect(adminConfigTestMailLocale.submit).toBe("Send"); // "admin.config.send_test_mail_submit"
    expect(adminConfigTestMailLocale.placeholder).toBe("Email Address (e.g. test@example.com)"); // "admin.config.test_email_placeholder"
  });

  it("the flash banner rides the re-render convention: null (the GET) renders none, the arms render the ui message classes", async () => {
    const data = await load();
    expect(renderAdminConfigPage(ctx, data)).not.toContain("ui positive message");
    expect(renderAdminConfigPage(ctx, data)).not.toContain("ui negative message");
    expect(renderAdminConfigPage(ctx, data, { kind: "positive", text: 'A testing email has been sent to "root@test.local".' })).toContain(
      '<div class="ui positive message">A testing email has been sent to &quot;root@test.local&quot;.</div>',
    );
    expect(renderAdminConfigPage(ctx, data, { kind: "negative", text: "Failed to send a testing email to \"root@test.local\": no FROM specified" })).toContain(
      '<div class="ui negative message">Failed to send a testing email to &quot;root@test.local&quot;: no FROM specified</div>',
    );
  });

  it("the bare AdminConfigPage component carries the optional flash prop too (the render seam's shape)", async () => {
    const html = renderToString(<AdminConfigPage ctx={ctx} data={await load()} flash={null} />);
    expect(html).toContain('class="page-content admin config"');
    expect(html).not.toContain("ui positive message");
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
      "enableNotifyMail", // the A2 register-gate var (declared, non-secret; empty = off)
      "mailEnabled", // the MAIL_* family: declared, non-secret (the API key is a secret, not a var)
      "mailFrom",
      "mailProvider",
      "mailSubjectPrefix",
      "oauth2Enabled", // the OAUTH2_ENABLED nav-gate var (declared, non-secret)
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
    await env.DB.prepare("DELETE FROM email_outbox").run();
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

// --- the mounted B-69 POST arm (web.go:792 — the /-/admin/config group's
// test_mail rider, driven through uiRouter.fetch) --------------------------
//
// Every POST pin drives an env with EXPLICIT MAIL_* overrides (the vitest
// plugin injects the operator-local wrangler VARS into `env`, so the
// determinism here is asserted, not assumed). All arms run transport-free:
// the dummy provider logs and succeeds, the provider-less resend arm throws
// before any fetch — no network, ever.

describe("the mounted POST /-/admin/config/test_mail (the census B-69 arm)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM users").run();
    await env.DB.prepare("DELETE FROM sessions").run();
    await env.DB.prepare("DELETE FROM email_outbox").run();
    await env.DB
      .prepare(
        "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES " +
          "(1, 'admin', 'admin', 'Site Admin', 1, unixepoch()), " +
          "(2, 'member', 'member', 'Plain Member', 0, unixepoch())",
      )
      .run();
  });

  /** The MAIL_* override slice the POST pins flip. The generated Env pins
   *  the deployed var literals ("dummy" etc.), so the overrides ride the
   *  widened-view property write the demo-armed tests use
   *  (admin-monitor.test.tsx's hermetic posture): assign onto a FRESH env
   *  copy through the plain-string view — never mutating the shared env. */
  type MailOverrides = {
    MAIL_ENABLED?: string;
    MAIL_FROM?: string;
    MAIL_PROVIDER?: string;
    MAIL_PROVIDER_API_KEY?: string;
    MAIL_SUBJECT_PREFIX?: string;
    MAIL_API_BASE?: string;
  };

  /** The POST pins' env: armed, dummy provider, parseable From — deterministic
   *  against the operator-local config posture (`.dev.vars`/wrangler.jsonc
   *  inject into `env`); the caller's overrides land last. */
  function mailTestEnv(overrides: MailOverrides = {}): ConfigUiTestEnv {
    const envCopy: ConfigUiTestEnv = { ...configUiEnv };
    const writable = envCopy as MailOverrides;
    writable.MAIL_ENABLED = "true";
    writable.MAIL_FROM = "no-reply@test.local";
    writable.MAIL_PROVIDER = "dummy";
    writable.MAIL_PROVIDER_API_KEY = "";
    writable.MAIL_SUBJECT_PREFIX = "";
    writable.MAIL_API_BASE = "";
    for (const key of Object.keys(overrides) as Array<keyof MailOverrides>) {
      const value = overrides[key];
      if (value !== undefined) writable[key] = value;
    }
    return envCopy;
  }

  /** POST the rider as the given principal, with explicit deterministic MAIL
   *  vars (defaults: armed, dummy provider, parseable From). */
  async function postTestMail(
    cookie: string | null,
    body: string,
    mail: MailOverrides = {},
    url = `${ORIGIN}/-/admin/config/test_mail`,
  ): Promise<Response> {
    return uiRouter.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          ...(cookie === null ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
        },
        body,
      }),
      mailTestEnv(mail),
    );
  }

  async function outboxCount(): Promise<number> {
    const rows = await drizzle(env.DB).select({ id: emailOutbox.id }).from(emailOutbox).all();
    return rows.length;
  }

  it("303s the anonymous POST onto the login round-trip (the prologue precedes any send)", async () => {
    const res = await postTestMail(null, "email=root@test.local", { MAIL_ENABLED: "false" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/admin/config/test_mail")}`);
    expect(await outboxCount()).toBe(0);
  });

  it("404-shells the signed-in non-admin (AdminRequired before the send)", async () => {
    const res = await postTestMail(await mintSession(env.DB, 2), "email=root@test.local");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('class="page-content admin config"');
    expect(await outboxCount()).toBe(0);
  });

  it("403s the cross-origin POST (the §2.8 sameOriginGuard rides first)", async () => {
    const cookie = await mintSession(env.DB, 1);
    const res = await uiRouter.fetch(
      new Request(`${ORIGIN}/-/admin/config/test_mail`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://evil.example",
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        },
        body: "email=root@test.local",
      }),
      configUiEnv,
    );
    expect(res.status).toBe(403);
    expect(await outboxCount()).toBe(0);
  });

  it("GET answers chi's 405 (the admin-emails GET-twin convention)", async () => {
    const res = await uiRouter.fetch(
      new Request(`${ORIGIN}/-/admin/config/test_mail`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, 1)}` },
      }),
      configUiEnv,
    );
    expect(res.status).toBe(405);
  });

  it("DISARMED deployment: the POST answers upstream's SILENT SUCCESS — the positive flash fires verbatim with no mail sent", async () => {
    const res = await postTestMail(await mintSession(env.DB, 1), "email=root@test.local", { MAIL_ENABLED: "false" });
    expect(res.status).toBe(200);
    const html = await res.text();
    // mail.go:44-46's MailService == nil → return nil → config.go:36's
    // Flash.Info — the success text fires even though nothing was sent and
    // the form itself is unrendered (config.tmpl:192's wrap: the re-rendered
    // page shows the posture note, no form).
    expect(html).toContain('<div class="ui positive message">A testing email has been sent to &quot;root@test.local&quot;.</div>');
    expect(html).toContain("form not rendered — upstream renders the test-mail form");
    expect(html).not.toContain('action="/-/admin/config/test_mail"');
    expect(await outboxCount()).toBe(0);
  });

  it("armed + dummy transport: the sent flash fires and the email_outbox ledger stays EMPTY (the direct-send bypass)", async () => {
    const res = await postTestMail(await mintSession(env.DB, 1), "email=root@test.local");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui positive message">A testing email has been sent to &quot;root@test.local&quot;.</div>');
    // The fresh re-render is the armed posture: the form renders (the next
    // send is one click away) and no outbox row exists (upstream's own
    // bypass — mail.go:45 outside the mail queue; nothing records it).
    expect(html).toContain('action="/-/admin/config/test_mail"');
    expect(await outboxCount()).toBe(0);
  });

  it("armed + unparseable MAIL_FROM: the failure flash embeds sender.go:27's verbatim \"no FROM specified\"", async () => {
    const res = await postTestMail(await mintSession(env.DB, 1), "email=root@test.local", { MAIL_FROM: "" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      '<div class="ui negative message">Failed to send a testing email to &quot;root@test.local&quot;: no FROM specified</div>',
    );
  });

  it("armed + a junk recipient: the failure flash embeds go-mail's verbatim \"no recipient addresses set\" (ErrNoRcptAddresses)", async () => {
    const res = await postTestMail(await mintSession(env.DB, 1), "email=junk");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      '<div class="ui negative message">Failed to send a testing email to &quot;junk&quot;: no recipient addresses set</div>',
    );
  });

  it("the absent email field rides the same failed arm (FormString's \"\" → the recipient parse miss)", async () => {
    const res = await postTestMail(await mintSession(env.DB, 1), "");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      '<div class="ui negative message">Failed to send a testing email to &quot;&quot;: no recipient addresses set</div>',
    );
  });

  it("the body-then-query merge: a query-carried email serves when the body omits the field (FormString's order, body wins)", async () => {
    const res = await postTestMail(await mintSession(env.DB, 1), "", {}, `${ORIGIN}/-/admin/config/test_mail?email=alt@test.local`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div class="ui positive message">A testing email has been sent to &quot;alt@test.local&quot;.</div>');
    // And the body field beats the query when both exist:
    const both = await postTestMail(
      await mintSession(env.DB, 1),
      "email=body@test.local",
      {},
      `${ORIGIN}/-/admin/config/test_mail?email=query@test.local`,
    );
    expect(await both.text()).toContain('<div class="ui positive message">A testing email has been sent to &quot;body@test.local&quot;.</div>');
  });

  it("armed + the provider-less resend arm: the failure flash embeds the transport's config error (no network, no send)", async () => {
    const res = await postTestMail(await mintSession(env.DB, 1), "email=root@test.local", {
      MAIL_PROVIDER: "resend",
      MAIL_PROVIDER_API_KEY: "",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      '<div class="ui negative message">Failed to send a testing email to &quot;root@test.local&quot;: resend: MAIL_PROVIDER_API_KEY is not set (wrangler secret put MAIL_PROVIDER_API_KEY)</div>',
    );
    expect(await outboxCount()).toBe(0);
  });
});
