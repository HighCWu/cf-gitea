/**
 * The ADMIN CONFIG page — `/-/admin/config` — SPEC-0018 §3.2 (the census
 * R18/R20 config arm, BUILD-as-read-only-summary verdict): the route lives
 * in `index.ts`'s admin literal family block beside the landed arms (the
 * mount record at the bottom of this header). This module owns the config
 * page only; the values it renders come from THREE landed sources — the
 * wrangler vars (request-time `env`), the published `/settings/*` constants
 * (imported from `../../api/routes/misc-t2`, §8.2's single source), and the
 * build-time posture (SERVER_VERSION, the binding/cron/queue inventory of
 * `wrangler.jsonc.example`).
 *
 * ## Upstream surface (at the pin)
 *
 * `templates/admin/config.tmpl` (329 lines) served by `admin.Config`
 * (routers/web/admin/config.go:58-106), route `GET /-/admin/config`
 * (web.go:788-794's `/config` group `m.Get("")`), Title "Summary"
 * ("admin.config_summary", config.go:61), pageClass `admin config`
 * (config.tmpl:1), behind `verifyAuthWithOptionsWeb(SignInRequired +
 * AdminRequired)` (web.go:777-779) — the shared adminPagePrologue's exact
 * posture. The template renders ELEVEN fixed sections, each
 * `h4.ui.top.attached.header` over `.ui.attached.table.segment` with a
 * `dl.admin-dl-horizontal` of dt/dd rows: server (:4), ssh (:47), lfs (:78),
 * db (:94), service (:122), webhook (:172), mailer (:186), cache (:234),
 * session (:259), git (:277), log (:304).
 *
 * The group's OTHER routes do NOT exist here:
 *   - `POST /-/admin/config` — upstream's ChangeConfig dynamic-settings
 *     write (web.go:790 → config.go:132-161 over the `system_setting`
 *     table, models/system/setting.go:78-100). §1's §-out: our posture is
 *     "arming is a var edit + redeploy, never a runtime toggle"
 *     (wrangler.jsonc.example:53). Unclaimed → the engine's 404/405 family.
 *   - `GET /-/admin/config/settings` — the dynamic editor page (web.go:794
 *     → config.go:108-113). Requires the write path; the nav item stays
 *     omitted with it (the dead-link rule, AdminFamilyNav).
 *   - the two POST riders `test_mail` (web.go:792 → config.go:29-39) and
 *     `test_cache` (web.go:793 → config.go:42-55) — no mailer, no cache
 *     adapter (the §3.2 mailer/cache arms' own notes).
 *
 * ## The THREE row classes (§3.2 — the dashboard's posture-line idiom
 * generalized; admin-dashboard.tsx renders upstream's inapplicable ops "as
 * this note, never as buttons")
 *
 *   1. REAL rows — values read from the landed surface at request time:
 *      SERVER_VERSION (../../api/config:13), the declared non-secret
 *      wrangler vars (wrangler.jsonc.example:41-66), the published settings
 *      constants (misc-t2's four GENERAL_* groups — IMPORTED, not
 *      re-declared; §8.2), the session provider (the D1 `sessions` table,
 *      schema.ts:1694), LFS over the shared R2 bucket, webhook delivery
 *      with its webhookDeliveries ledger (schema.ts:1006), the
 *      D1/R2/DO binding names, the two cron expressions, and the queue
 *      topology with retry/DLQ wiring (all of wrangler.jsonc.example's
 *      bindings/triggers/queues blocks).
 *   2. POSTURE rows — true-by-construction lines where upstream renders a
 *      config value for infrastructure we deliberately do not run. Rendered
 *      muted (the dashboard's `tw-text-placeholder-text` idiom) and carrying
 *      `data-row-kind="posture"` in the DOM. The honest-absence lines the
 *      census called for (census :383-385): no SSH server, no mailer, no
 *      cache adapter, no filesystem, no app.ini — configuration is wrangler
 *      vars applied at deploy; changes are a var edit + redeploy.
 *   3. SECRET rows never exist (§3.2 rule 3) — upstream blanks the session
 *      ProviderConfig before render (config.go:93-95); we go further:
 *      `wrangler secret` values are never READ for the page at all. The
 *      loader's input is `AdminConfigVars` — a struct whose fields are
 *      exactly the declared NON-secret vars of wrangler.jsonc.example:41-66,
 *      so a secret cannot reach the DOM even by accident (the structurally-
 *      unreadable shape; the secret-hygiene test pins it).
 *
 * ## The env-var rows are request-time reads (§5.9)
 *
 * A var edited-and-redeployed shows up without any cache story — the whole
 * point of the read-only verdict: no revision counter, no cache getter, no
 * invalidation seam (upstream needs InvalidateCache after its dynamic
 * writes, config.go:159). POSTURE rows render identically on every
 * deployment (§5.8) — there is no empty state to special-case.
 *
 * ## Mount record (MOUNTED this unit — the route is live)
 *
 * Route table (`index.ts`), beside the landed adminPagePrologue arms:
 *
 *   GET /-/admin/config   adminPagePrologue → adminConfigVarsFromEnv(env) →
 *                         loadAdminConfigData → renderAdminConfigPage at 200
 *
 * GET-only: upstream's POST arms are all §-outs (above). The claim sits in
 * the landed admin literal family block (`raw[1] === "-" && raw[2] ===
 * "admin"`), a static literal beside the notices arm, ahead of any dynamic
 * arm. The family navbar gains the Configuration group between Integrations
 * and the System Notices item (upstream navbar.tmpl:93-102's position), with
 * the Summary item only — the settings-editor item stays omitted.
 */

import { SERVER_VERSION } from "../../api/config";
import {
  GENERAL_API_SETTINGS,
  GENERAL_ATTACHMENT_SETTINGS,
  GENERAL_REPO_SETTINGS,
  GENERAL_UI_SETTINGS,
} from "../../api/routes/misc-t2";
import type { UiContext } from "../ui-context";
import { AdminFamilyShell } from "./admin-users";
import { renderPage } from "../shell";

// ---------------------------------------------------------------------------
// The vars input (§3.2 rule 3's structural secret hygiene)
// ---------------------------------------------------------------------------

/** The declared NON-secret wrangler vars the page renders
 * (wrangler.jsonc.example:41-66) — the exact field set is the §3.2 rule-3
 * guarantee: `wrangler secret` values (GIT_TOKEN, MIRROR_*) are not fields,
 * so no call site can hand them to the page. Plain strings: the generated
 * Env pins deployed literals, the loader renders raw declared values, and
 * the env-var matrix test flips fields freely. */
export interface AdminConfigVars {
  appUrl: string;
  allowSignup: string;
  demoMode: string;
  auditRetentionDays: string;
  packagesLimitSizeGeneric: string;
  packagesLimitTotalOwnerCount: string;
  packagesLimitTotalOwnerSize: string;
  packagesEnabled: string;
  packageCleanupOlderThan: string;
}

/** The env slice `adminConfigVarsFromEnv` reads — a WEAK STRUCTURAL slice,
 *  the PackagesQuotaEnv posture (services/packages/model.ts:651-656): plain
 *  string fields keep the generated Env assignable (its deployed literal
 *  types widen) without the page module pinning the operator's literals,
 *  and keep the tests free to flip values. The four core vars are required
 *  (the generated Env always declares them); the five packages vars are
 *  optional (their readers' own slices declare them optional — absent = the
 *  code default). */
export type AdminConfigEnv = {
  APP_URL: string;
  ALLOW_SIGNUP: string;
  DEMO_MODE: string;
  AUDIT_RETENTION_DAYS: string;
  PACKAGES_LIMIT_SIZE_GENERIC?: string;
  PACKAGES_LIMIT_TOTAL_OWNER_COUNT?: string;
  PACKAGES_LIMIT_TOTAL_OWNER_SIZE?: string;
  PACKAGES_ENABLED?: string;
  PACKAGE_CLEANUP_OLDER_THAN?: string;
};

/** Code defaults for the optional packages vars (the strict-polarity
 *  readers' own constants: model.ts:643-646 DEFAULT_LIMIT_SIZE_GENERIC /
 *  UNLIMITED_QUOTA, model.ts:680 `!== "false"`, cleanup.ts:80
 *  DEFAULT_CLEANUP_OLDER_THAN_HOURS). An unset var renders the EFFECTIVE
 *  default — the same value the enforcing readers would use. */
const PACKAGES_VAR_DEFAULTS = {
  limitSizeGeneric: "536870912",
  totalOwnerCount: "-1",
  totalOwnerSize: "-1",
  enabled: "true",
  cleanupHours: "24",
} as const;

/** Project the env slice onto the page's vars struct (the handler's only
 *  env touchpoint — secrets are not in the slice type). */
export function adminConfigVarsFromEnv(env: AdminConfigEnv): AdminConfigVars {
  return {
    appUrl: env.APP_URL,
    allowSignup: env.ALLOW_SIGNUP,
    demoMode: env.DEMO_MODE,
    auditRetentionDays: env.AUDIT_RETENTION_DAYS,
    packagesLimitSizeGeneric: env.PACKAGES_LIMIT_SIZE_GENERIC ?? PACKAGES_VAR_DEFAULTS.limitSizeGeneric,
    packagesLimitTotalOwnerCount: env.PACKAGES_LIMIT_TOTAL_OWNER_COUNT ?? PACKAGES_VAR_DEFAULTS.totalOwnerCount,
    packagesLimitTotalOwnerSize: env.PACKAGES_LIMIT_TOTAL_OWNER_SIZE ?? PACKAGES_VAR_DEFAULTS.totalOwnerSize,
    packagesEnabled: env.PACKAGES_ENABLED ?? PACKAGES_VAR_DEFAULTS.enabled,
    packageCleanupOlderThan: env.PACKAGE_CLEANUP_OLDER_THAN ?? PACKAGES_VAR_DEFAULTS.cleanupHours,
  };
}

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin; cf-gitea
// additions carry their source cite instead)
// ---------------------------------------------------------------------------

export const adminConfigLocale = {
  title: "Summary", // "admin.config_summary" (config.go:61's Title)
  sections: {
    server: "Server Configuration", // "admin.config.server_config" (config.tmpl:4)
    ssh: "SSH Configuration", // "admin.config.ssh_config" (config.tmpl:47)
    lfs: "LFS Configuration", // "admin.config.lfs_config" (config.tmpl:78)
    db: "Database Configuration", // "admin.config.db_config" (config.tmpl:94)
    service: "Service Configuration", // "admin.config.service_config" (config.tmpl:122)
    webhook: "Webhook Configuration", // "admin.config.webhook_config" (config.tmpl:172)
    mailer: "Mailer Configuration", // "admin.config.mailer_config" (config.tmpl:186)
    cache: "Cache Configuration", // "admin.config.cache_config" (config.tmpl:234)
    session: "Session Configuration", // "admin.config.session_config" (config.tmpl:259)
    git: "Git Configuration", // "admin.config.git_config" (config.tmpl:277)
    log: "Log Configuration", // "admin.config.log_config" (config.tmpl:304)
  },
} as const;

/** The section keys in upstream config.tmpl's fixed order. */
export type AdminConfigSectionKey =
  | "server"
  | "ssh"
  | "lfs"
  | "db"
  | "service"
  | "webhook"
  | "mailer"
  | "cache"
  | "session"
  | "git"
  | "log";

// ---------------------------------------------------------------------------
// The row/section data model (the render input — sections as data, the
// upstream dt/dd rows carrying their row class)
// ---------------------------------------------------------------------------

/** One config row. `kind: "real"` carries a live value; `kind: "posture"`
 *  is the true-by-construction honest-absence line (§3.2 class 2). SECRET
 *  rows are not a representable kind (§3.2 class 3 — the type level's
 *  guard). */
export interface AdminConfigRow {
  kind: "real" | "posture";
  /** The dt text (upstream's locale label or the cf-gitea label with its
   *  source cite rendered beside it). */
  label: string;
  /** The dd text — the live value, or the posture note. */
  value: string;
}

export interface AdminConfigSection {
  key: AdminConfigSectionKey;
  title: string;
  rows: AdminConfigRow[];
}

/** The imported published-settings constants, carried BY REFERENCE (§8.2's
 *  single source — the values-cross-check test asserts object identity
 *  against misc-t2's exports, so a page-local copy fails the suite). */
export interface AdminConfigPublished {
  api: typeof GENERAL_API_SETTINGS;
  attachment: typeof GENERAL_ATTACHMENT_SETTINGS;
  repo: typeof GENERAL_REPO_SETTINGS;
  ui: typeof GENERAL_UI_SETTINGS;
}

export interface AdminConfigData {
  published: AdminConfigPublished;
  sections: AdminConfigSection[];
}

// ---------------------------------------------------------------------------
// Value formatting (the published constants render field-by-field, so the
// cross-check can assert every published number reaches the DOM)
// ---------------------------------------------------------------------------

/** One published field: `key=value` with booleans/numbers via String, arrays
 *  bracket-joined (JSON-shaped without quoting — the DOM is a summary, not
 *  a re-serialization). */
export function formatPublishedValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => String(item)).join(",")}]`;
  }
  return String(value);
}

/** A whole published group: `k1=v1 · k2=v2 · …` in declaration order. */
export function formatPublishedGroup(group: Record<string, unknown>): string {
  return Object.entries(group)
    .map(([key, value]) => `${key}=${formatPublishedValue(value)}`)
    .join(" · ");
}

/** Bytes with a MiB annotation when the value divides evenly (512 MiB is the
 *  generic cap the var documents, services/packages/model.ts:646). */
function formatSizeBytes(raw: string): string {
  if (!/^\d+$/.test(raw)) {
    return raw;
  }
  const bytes = Number.parseInt(raw, 10);
  return bytes % (1024 * 1024) === 0 ? `${raw} bytes (${bytes / (1024 * 1024)} MiB)` : `${raw} bytes`;
}

/** An owner-quota raw value: `-1` is upstream's no-limit sentinel
 *  (setting/packages.go:96-99 via model.ts:643), any other integer is bytes
 *  (size) or a count (count). */
function formatQuota(raw: string, unit: "count" | "bytes"): string {
  if (raw === "-1") {
    return "unlimited (-1)";
  }
  return unit === "bytes" ? formatSizeBytes(raw) : raw;
}

/** Positive-integer parse (the AUDIT_RETENTION_DAYS reader's own polarity:
 *  any non-positive or non-integer value DISARMS the retention producer —
 *  wrangler.jsonc.example:55-58). */
function parsePositiveInt(raw: string): number | null {
  return /^\d+$/.test(raw) && Number.parseInt(raw, 10) > 0 ? Number.parseInt(raw, 10) : null;
}

// ---------------------------------------------------------------------------
// The loader (§3.2 — pure assembly over the landed surface; the Promise
// signature is the family's loader convention, the wiring-wave shape)
// ---------------------------------------------------------------------------

/** Build the eleven sections in upstream config.tmpl's order. The wrangler
 *  bindings/triggers/queues inventory is DECLARED here as the deploy-time
 *  posture it is (wrangler.jsonc.example:84-186 is gitignored config applied
 *  at deploy — no runtime introspection exists; the monitor module's
 *  MONITOR_CRON_TASKS mirrors the same file's crons, admin-monitor.tsx:476). */
export function loadAdminConfigData(vars: AdminConfigVars): Promise<AdminConfigData> {
  const published: AdminConfigPublished = {
    api: GENERAL_API_SETTINGS,
    attachment: GENERAL_ATTACHMENT_SETTINGS,
    repo: GENERAL_REPO_SETTINGS,
    ui: GENERAL_UI_SETTINGS,
  };
  const retentionDays = parsePositiveInt(vars.auditRetentionDays);
  const sections: AdminConfigSection[] = [
    {
      // config.tmpl:4-44 — server. Upstream leads with AppName (config.tmpl:8),
      // RunUser/RunMode, CustomConf, and the four filesystem root paths
      // (:19-42); the §8.6 ratification renders the instance name as a
      // POSTURE row and the run-user/paths/script-type family folds into the
      // app.ini posture line.
      key: "server",
      title: adminConfigLocale.sections.server,
      rows: [
        {
          kind: "posture",
          label: "Site Title", // "admin.config.app_name" (config.tmpl:8)
          value: "no instance-name setting — branding is the deployed frontend's",
        },
        {
          kind: "real",
          label: "Gitea Version", // "admin.config.app_ver" (config.tmpl:10)
          value: SERVER_VERSION, // src/api/config.ts:13 — tracks the submodule pin
        },
        {
          kind: "real",
          label: "AppURL", // APP_URL (wrangler.jsonc.example:42)
          value: vars.appUrl,
        },
        {
          kind: "real",
          label: "Demo operations (DEMO_MODE)", // wrangler.jsonc.example:47-54
          value:
            vars.demoMode === "true"
              ? 'armed (DEMO_MODE="true") — the hourly sweep producer enqueues'
              : `off (DEMO_MODE="${vars.demoMode}") — fail-closed; only the exact string "true" arms the sweep`,
        },
        {
          kind: "real",
          label: "Audit-event retention (AUDIT_RETENTION_DAYS)", // wrangler.jsonc.example:55-58
          value:
            retentionDays === null
              ? `disarmed (AUDIT_RETENTION_DAYS="${vars.auditRetentionDays}") — a non-positive or non-integer value disarms the producer`
              : `${retentionDays} days (AUDIT_RETENTION_DAYS="${vars.auditRetentionDays}")`,
        },
        {
          kind: "real",
          label: "Packages registry (PACKAGES_ENABLED)", // wrangler.jsonc.example:65
          value:
            vars.packagesEnabled !== "false"
              ? `enabled (PACKAGES_ENABLED="${vars.packagesEnabled}")`
              : 'disabled (PACKAGES_ENABLED="false")',
        },
        {
          kind: "real",
          label: "Packages size cap (PACKAGES_LIMIT_SIZE_GENERIC)", // wrangler.jsonc.example:62
          value: formatSizeBytes(vars.packagesLimitSizeGeneric),
        },
        {
          kind: "real",
          label: "Packages owner quotas (PACKAGES_LIMIT_TOTAL_OWNER_COUNT / PACKAGES_LIMIT_TOTAL_OWNER_SIZE)", // :63-64
          value: `count ${formatQuota(vars.packagesLimitTotalOwnerCount, "count")}, size ${formatQuota(vars.packagesLimitTotalOwnerSize, "bytes")}`,
        },
        {
          kind: "real",
          label: "Packages cleanup window (PACKAGE_CLEANUP_OLDER_THAN)", // :66
          value: `${vars.packageCleanupOlderThan} hours`,
        },
        {
          kind: "real",
          label: "Cron triggers", // wrangler.jsonc.example:157-159
          value:
            "*/10 * * * * (update_mirrors producer — services/mirror/sync) · 0 * * * * (the hourly tick — the demo sweep's producer, DEMO_MODE-gated)",
        },
        {
          kind: "real",
          label: "Queues", // wrangler.jsonc.example:168-186
          value:
            "producers: WEBHOOK_DELIVERY → webhook-delivery, REPO_TASKS → repo-tasks, MIRROR_SYNC_QUEUE → repo-tasks · consumers: repo-tasks (max_retries 5, dead-letter repo-tasks-dlq), webhook-delivery (max_retries 3, dead-letter webhook-delivery-dlq), plus the two DLQ sweep consumers",
        },
        {
          kind: "posture",
          label: "app.ini / run-user / filesystem paths", // config.tmpl:12-42's family
          value:
            "no app.ini — configuration is the wrangler vars applied at deploy; changes are a var edit + redeploy (run-user, run-mode, custom-conf, and the filesystem root paths have no substrate)",
        },
        {
          kind: "real",
          label: "Published API settings (/api/v1/settings/api)", // misc-t2 GENERAL_API_SETTINGS
          value: formatPublishedGroup(published.api),
        },
        {
          kind: "real",
          label: "Published attachment settings (/api/v1/settings/attachment)", // misc-t2 GENERAL_ATTACHMENT_SETTINGS
          value: formatPublishedGroup(published.attachment),
        },
        {
          kind: "real",
          label: "Published UI settings (/api/v1/settings/ui)", // misc-t2 GENERAL_UI_SETTINGS
          value: formatPublishedGroup(published.ui),
        },
      ],
    },
    {
      // config.tmpl:47-75 — ssh. POSTURE-only (§3.2): no SSH server exists.
      key: "ssh",
      title: adminConfigLocale.sections.ssh,
      rows: [
        {
          kind: "posture",
          label: "SSH server", // "admin.config.ssh_enabled" (config.tmpl:51)
          value: "no SSH server — git smart-HTTP over HTTPS only",
        },
      ],
    },
    {
      // config.tmpl:78-91 — lfs. REAL: enabled over the shared R2 bucket;
      // POSTURE: the http-auth-expiry row (config.tmpl:87) has no token-TTL
      // knob to show.
      key: "lfs",
      title: adminConfigLocale.sections.lfs,
      rows: [
        {
          kind: "real",
          label: "Enabled", // "admin.config.lfs_enabled" (config.tmpl:82)
          value: "yes — over the shared R2 bucket (binding REPO_PACKS)",
        },
        {
          kind: "posture",
          label: "HTTP auth expiry", // "admin.config.lfs_http_auth_expiry" (config.tmpl:87)
          value: "no token-TTL knob — LFS auth rides the request's credential",
        },
      ],
    },
    {
      // config.tmpl:94-119 — db. POSTURE-flavored REAL (§3.2): the type row
      // renders the D1 binding; upstream's host/name/user/ssl rows
      // (:101-112) have nothing to print.
      key: "db",
      title: adminConfigLocale.sections.db,
      rows: [
        {
          kind: "real",
          label: "Type", // "admin.config.db_type" (config.tmpl:98)
          value: "Cloudflare D1 (binding DB)",
        },
        {
          kind: "posture",
          label: "Host / name / user / SSL", // config.tmpl:101-112
          value: "not printed — the binding is the connection (no server coordinates exist)",
        },
      ],
    },
    {
      // config.tmpl:122-169 — service. REAL: the self-registration gate
      // mapped to upstream's registration rows (disable_register,
      // config.tmpl:128) + the published repository settings (the time-
      // tracking line among them — §3.2's service note); POSTURE: the
      // email-confirm/OpenID/captcha family has no substrate.
      key: "service",
      title: adminConfigLocale.sections.service,
      rows: [
        {
          kind: "real",
          label: "Self-registration (ALLOW_SIGNUP)", // wrangler.jsonc.example:43-46 → config.tmpl:128-135's rows
          value:
            vars.allowSignup === "true"
              ? 'open (ALLOW_SIGNUP="true") — /user/sign_up is served'
              : `closed (ALLOW_SIGNUP="${vars.allowSignup}") — the first admin comes from the login page's one-shot initialize form`,
        },
        {
          kind: "real",
          label: "Published repository settings (/api/v1/settings/repository)", // misc-t2 GENERAL_REPO_SETTINGS
          value: formatPublishedGroup(published.repo),
        },
        {
          kind: "posture",
          label: "Email confirmation / OpenID / captcha", // config.tmpl:126-139's family
          value: "no substrate — no mailer, no external login chain",
        },
      ],
    },
    {
      // config.tmpl:172-183 — webhook. REAL: delivery over the landed queue
      // family with its ledger; POSTURE: skip-tls-verify (config.tmpl:180)
      // follows the platform fetch defaults.
      key: "webhook",
      title: adminConfigLocale.sections.webhook,
      rows: [
        {
          kind: "real",
          label: "Delivery", // config.tmpl:176-179's queue rows
          value:
            "enabled — the webhook-delivery queue (max_retries 3, dead-letter webhook-delivery-dlq); every delivery keeps a webhookDeliveries ledger row",
        },
        {
          kind: "posture",
          label: "Skip TLS verify", // "admin.config.skip_tls_verify" (config.tmpl:180)
          value: "follows the platform fetch defaults — no runtime knob",
        },
      ],
    },
    {
      // config.tmpl:186-231 — mailer. POSTURE-only (§3.2); upstream's
      // send-test-mail rider (config.tmpl:220-228) is absent with it.
      key: "mailer",
      title: adminConfigLocale.sections.mailer,
      rows: [
        {
          kind: "posture",
          label: "Mailer", // "admin.config.mailer_enabled" (config.tmpl:190)
          value: "no mailer — email notifications absent (upstream's send-test-mail rider is absent with it)",
        },
      ],
    },
    {
      // config.tmpl:234-256 — cache. POSTURE-only (§3.2); the cache-test
      // rider (config.tmpl:249-254) is absent with it.
      key: "cache",
      title: adminConfigLocale.sections.cache,
      rows: [
        {
          kind: "posture",
          label: "Cache adapter", // "admin.config.cache_adapter" (config.tmpl:238)
          value: "no cache adapter — stateless workers (upstream's cache-test rider is absent with it)",
        },
      ],
    },
    {
      // config.tmpl:259-274 — session. REAL: the D1 provider; POSTURE: the
      // provider-config details mirror upstream's own blanking
      // (config.go:93-95).
      key: "session",
      title: adminConfigLocale.sections.session,
      rows: [
        {
          kind: "real",
          label: "Session provider", // "admin.config.session_provider" (config.tmpl:263)
          value: "Cloudflare D1 (the sessions table)",
        },
        {
          kind: "posture",
          label: "Provider configuration", // config.tmpl:265-272's details
          value: "not rendered — mirroring upstream's own blanking of ProviderConfig (config.go:93-95)",
        },
      ],
    },
    {
      // config.tmpl:277-301 — git. REAL: the vendored engine over the DO
      // classes; POSTURE: the gc-args/timeout/diff-limit rows (:281-299)
      // have no user-facing knob.
      key: "git",
      title: adminConfigLocale.sections.git,
      rows: [
        {
          kind: "real",
          label: "Git engine", // config.tmpl:277's section subject
          value:
            "the vendored durable-git engine (packages/git-engine) over Durable Objects — REPO → RepoCell (per-repo git storage), REGISTRY → Registry (repo index)",
        },
        {
          kind: "posture",
          label: "GC args / timeouts / diff limits", // config.tmpl:281-299
          value: "no user-facing knobs — the engine's internal discipline",
        },
      ],
    },
    {
      // config.tmpl:304-327 — log. REAL: observability + traces; POSTURE:
      // the access-log-template / log-SQL rows (:309-316) have no analog.
      key: "log",
      title: adminConfigLocale.sections.log,
      rows: [
        {
          kind: "real",
          label: "Observability", // wrangler.jsonc.example:68-73
          value: "enabled — platform observability with traces enabled",
        },
        {
          kind: "posture",
          label: "Access log template / SQL logging", // config.tmpl:308-316
          value: "no rows — the platform's request logs are the source",
        },
      ],
    },
  ];
  return Promise.resolve({ published, sections });
}

/** A section by key (the tests' lookup helper; the render walks the array). */
export function adminConfigSection(data: AdminConfigData, key: AdminConfigSectionKey): AdminConfigSection {
  const section = data.sections.find((candidate) => candidate.key === key);
  if (section === undefined) {
    throw new Error(`admin-config: unknown section ${key}`);
  }
  return section;
}

// ---------------------------------------------------------------------------
// The render (templates/admin/config.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern). */
export function renderAdminConfigPage(ctx: UiContext, data: AdminConfigData): string {
  return renderPage(<AdminConfigPage ctx={ctx} data={data} />);
}

/** One dt/dd row pair. REAL rows render upstream's plain pair with the row
 *  kind marked on the dd (`data-row-kind`); POSTURE rows render MUTED —
 *  both cells carry the dashboard's `tw-text-placeholder-text` idiom
 *  (admin-dashboard.tsx:321's posture paragraphs generalized to rows). */
function ConfigRow(props: { row: AdminConfigRow }) {
  const { kind, label, value } = props.row;
  if (kind === "posture") {
    return (
      <>
        <dt class="tw-text-placeholder-text">{label}</dt>
        <dd class="tw-text-placeholder-text" data-row-kind="posture">
          {value}
        </dd>
      </>
    );
  }
  return (
    <>
      <dt>{label}</dt>
      <dd data-row-kind="real">{value}</dd>
    </>
  );
}

/** The admin config page (§2.4.1 discriminator: `admin config` — the
 *  template's own dict, config.tmpl:1; upstream Title is "Summary",
 *  config.go:61). Pure GET — no forms, no flash arm, no write path. */
export function AdminConfigPage(props: { ctx: UiContext; data: AdminConfigData }) {
  return (
    <AdminFamilyShell ctx={props.ctx} title={adminConfigLocale.title} pageClass="admin config" active="config">
      {props.data.sections.map((section) => (
        <div key={section.key}>
          <h4 class="ui top attached header">{section.title}</h4>
          <div class="ui attached table segment">
            <dl class="admin-dl-horizontal">
              {section.rows.map((row) => (
                <ConfigRow key={row.label} row={row} />
              ))}
            </dl>
          </div>
        </div>
      ))}
    </AdminFamilyShell>
  );
}
