# SPEC-0018: The admin config / notices / auths arms — the R18/R20 remaining (b) verdicts

Status: **accepted** (ratified 2026-10-29, orchestrator — decisions at §8) ·
Date: 2026-10-29 · Un-defers the UI gap census's three remaining (b) NEEDS-API
arms of rows R18/R20
([docs/compat/ui-gap-census-2026-10-29.md](../docs/compat/ui-gap-census-2026-10-29.md):
"R18/R20 remaining (b) arms — admin config / notices / auths — size M/L per
page — impact #16", the row at :375-388). Depends on: SPEC-0002 (auth — the
PAT-only posture this SPEC's auths verdict reads), SPEC-0010 (ui-session —
the login page and the admin gate), SPEC-0014 §3.0 (the repo-tasks
dead-letter queue consumer — the notices emit seam), SPEC-0015 (audit events
— the store this SPEC's notices arm is deliberately kept separate from),
SPEC-0004 (the openapi/zod conventions the misc settings routes follow).

Owns: the D1 `system_notices` table (§4), the notices emit seam over the
repo-tasks DLQ consumer (§3.1), the `/-/admin/notices` page family (§3.1),
the read-only `/-/admin/config` summary page (§3.2), and the auths
**omission verdict** with its divergence-ledger entry (§3.3). It does NOT
own: `src/ui/pages/admin-users.tsx` (the shared `AdminFamilyNav` — its nav
edits ride the orchestrator's registration window, §7) or `src/ui/index.ts`
(shared mount file — same rule); the `audit_event` store (SPEC-0015's); the
oauth2 application surfaces (landed — `admin-applications.tsx`); any login
chain (the §3.3 gate names what would reopen the auths arm).

Upstream findings are against the vendored submodule (`gitea/`, READ-ONLY,
pin `fc4936884584`; the deployed version string composes the same pin —
`SERVER_VERSION = "29.0.0+dev-208-gfc49368845"`,
`apps/worker/src/api/config.ts:13`). Every `web.go:N` cite is
`gitea/routers/web/web.go` at that pin; `navbar.tmpl:N` is
`gitea/templates/admin/navbar.tmpl`; our-substrate findings are against
`apps/worker/src/**` and `apps/worker/wrangler.jsonc.example` as of
2026-10-29.

---

## 1. Problem and scope

The census's R18/R20 rows closed their (a) arms (emails, hooks, badges,
applications — landed pages) and left three arms classified (b) NEEDS-API
because "none of the three stores exist (schema list confirmed — no
system_notice, no login_source, no system-settings KV)" (census :377-380).
The census sketched the posture but deferred the calls: notices as
"needs-model (small D1 KV + admin writes + the page)" (note: upstream has NO
admin write form — the arm's own research below corrects this), config as
"a page over our actual landed config … rendered with honest-absence lines
… arguably (a)-with-reduction", and auths as "likely N/A … an explicit
policy call (honest-absence page vs omission) rather than a store (Open
Issues #7)" (census :381-388; the auths call is Open Issues #5 at :511-513).
This document makes all three calls with pinned evidence, and SPECs the two
that build.

The three arms share only their nav real estate; they are three independent
decisions:

- **Config** — upstream's page is a *summary read* over the parsed app.ini
  plus, newer, a *dynamic settings editor* over a `system_setting` table.
  Our substrate has no app.ini and no runtime-writable settings store — but
  it has a real, honest config surface (wrangler vars + the published
  `/settings/*` constants + build-time posture), so the read half maps and
  the write half does not.
- **Notices** — upstream's store is a four-column table written by
  background failures; the concept is fully portable to D1. The missing
  piece upstream-style research surfaces is the WRITER: upstream's emitters
  are repo-subsystem failure paths and cron task outcomes; ours are the
  queue consumers' dead-letter paths.
- **Auths** — upstream's page manages *login sources* (`login_source`):
  pluggable external authentication chains (LDAP/SMTP/OAuth2/PAM/SSPI).
  cf-gitea has exactly one auth method, PAT-only, and no password store —
  the store, its writer, and its consumer chain are all absent by design.
  This arm gets a verdict, not a build.

In scope: the per-arm verdicts (§2-§3), the `system_notices` model + emit
seam + notices page (§3.1, §4), the read-only config summary page (§3.2),
the auths omission ledger entry (§3.3), the shared nav/mount integration
notes (§7), tests (§6).

Out of scope (each named so it is not silently re-decided):

- **Any `/api/v1` surface for the three arms** — upstream has NONE at this
  pin: the authoritative swagger's `/admin/*` path list contains cron,
  emails, hooks, orgs, packages, unadopted, users, actions — no auths, no
  notices, no config (`gitea/templates/swagger/v1-swagger.generated.json`,
  sorted `/admin/` path extraction, verified 2026-10-29), matching the
  router (`routers/api/v1/api.go:1814-1867` — the admin group mounts
  exactly those). Both built pages are web-only, mirroring upstream.
- **The config WRITE path** — upstream's `POST /-/admin/config`
  (`ChangeConfig`, web.go:790 → `routers/web/admin/config.go:132-161`) and
  the `system_setting` table + dynamic-config getter that back it
  (`models/system/setting.go:78-100`, `:102-152`). Our posture is
  "arming is a var edit + redeploy, never a runtime toggle"
  (wrangler.jsonc.example:53). The editor returns only when a concrete
  runtime-toggle need exists (§8.5).
- **The `/-/admin/config/settings` dynamic editor page** — upstream's
  avatars/repository/instance maintenance forms
  (`templates/admin/config_settings/*.tmpl` over the
  `modules/setting/config` option registry, `value.go:176-185`); requires
  the §-out write path.
- **The audit_logs monitor arm** — R13's row (census :354-373); the store
  landed (SPEC-0015: `audit_event`, schema.ts:3026; the emit seam
  `src/services/audit.ts`), the page does not exist yet and stays R13's.
  §5.5 fixes the notices-vs-audit boundary so the two stores do not blur.
- **The auths page itself** — §3.3 proposes omission; even if ratification
  overrode that, the honest-absence page is an S-sized static render with
  no store, not a needs-model arm.
- **Packages/actions admin arms** — (c) FEATURE-GATED (SPEC-0012 posture,
  census :391-417).
- **`/-/admin/self_check`** — unlanded upstream surface out of this row's
  census scope; omitted from the nav by the existing dead-link rule
  (admin-users.tsx:318-321) and untouched here.

## 2. Per-arm upstream vs substrate

### 2.1 The config arm — upstream's read page + dynamic editor, our static posture

**Upstream read page** (`GET /-/admin/config`, web.go:788-794 group;
`routers/web/admin/config.go:58-106`): the handler assembles ~25 template
variables straight off the parsed settings tree — `setting.CustomConf`,
`RunUser`, `RunMode`, the four filesystem root paths, `SSH`, `LFS`,
`Service`, `DbCfg`, the mailer's presence, the cache adapter, `SessionConfig`
(with `ProviderConfig` explicitly blanked before render, config.go:93-95 —
upstream's own secret hygiene), `Git`, and the log manager's dump
(config.go:101). The template renders ELEVEN fixed sections:
server (`templates/admin/config.tmpl:4`), ssh (:47), lfs (:78), db (:94),
service (:122), webhook (:172), mailer (:186), cache (:234), session
(:259), git (:277), log (:304) — each row an icon-check against a compiled
value. Two POST riders hang off the same group: test-mail (:792 →
config.go:29-39) and test-cache (:793 → config.go:42-55) — both N/A here
(no mailer, no cache adapter).

**Upstream write path** (`POST /-/admin/config` → `ChangeConfig`,
config.go:132-161): accepts parallel `key[]`/`value[]` form arrays,
validates each key against the registered dynamic-option table
(`validateConfigKeyValue`, config.go:115-130 — unknown key rejected, value
≤ 64 KiB, JSON-valid), then upserts into `system_setting`
(`system_model.SetSettings`, `models/system/setting.go:78-100` — each row
carries a `version` column and the sentinel `revision` key bumps
monotonically, setting.go:38-59). The getter
(`dbConfigCachedGetter`, setting.go:102-152) caches the map for one second
and serves the `config.DynKeyGetter` seam the settings tree reads dynamic
overrides through. The NEWER editor page (`GET /-/admin/config/settings`,
web.go:794 → config.go:108-113) renders three form groups (avatars,
repository, instance maintenance/web banner —
`templates/admin/config_settings/config_settings.tmpl:1-7`) that round-trip
through the same write path.

**Our substrate (verified):** there is no app.ini, no custom-conf file, and
no runtime-writable settings store. The real config surface is:

- **Vars** (`wrangler.jsonc.example:41-59`): `APP_URL` (:42), `ALLOW_SIGNUP`
  (:43-46, the SPEC-0010 §6 self-registration gate), `DEMO_MODE` (:47-54,
  the SPEC-0014 §2 fail-closed demo gate), `AUDIT_RETENTION_DAYS` (:55-58,
  the SPEC-0015 §4.3 retention window). The module rules (:26-31),
  bindings (:76-91 D1 `DB`, :86-91 R2 `REPO_PACKS`, :118-121 the DO
  classes), observability (:60-65, both flags `true`), cron triggers
  (:149-152 — `*/10 * * * *` + the hourly entry), and the queue topology
  (:160-176 — three producers, four consumers with
  `max_retries`/dead-letter wiring) are the rest of the posture, all
  GITIGNORED-file configuration applied at deploy time.
- **Published settings constants** — the `/api/v1/settings/{ui,api,
  attachment,repository}` family (`src/api/routes/misc-t2.ts:354, 369, 392,
  407`) answers module-private constants that DOCUMENT actual behavior per
  field: `GENERAL_API_SETTINGS` (:489-499, paging clamps + blob caps),
  `GENERAL_ATTACHMENT_SETTINGS` (:503-509 — `max_size: 512` is "OUR real 413
  threshold"), `GENERAL_REPO_SETTINGS` (:516-528 — `time_tracking_disabled:
  true` as the honest advertisement), `GENERAL_UI_SETTINGS` (:530-535).
- **Constants**: `SERVER_VERSION` (config.ts:13), `SWAGGER_DOC_PATH`
  (config.ts:20). The D1 `sessions` table is the session provider
  (schema.ts:1694). LFS is landed over the shared R2 bucket
  (`src/services/lfs/store.ts:75-85` key discipline). Webhooks are landed
  with delivery records (`webhookDeliveries`, schema.ts). No mailer, no
  cache adapter, no SSH server, no filesystem — the four honest-absent
  families.

**The gap:** no page renders any of this; upstream's read shape has no
consumer in `src/ui/pages/` (the admin family's landed set is dashboard,
monitor×4, users, orgs, repos, emails, badges, applications, hooks — the
nav union at `admin-users.tsx:273-285`). The census's own suggestion
(:383-385) is the shape this SPEC adopts: a page over the landed config,
with honest-absence lines where the substrate has no answer.

### 2.2 The notices arm — a portable store, and the writer is the discovery

**Upstream model** (`models/system/notice.go`): four columns —
`Notice{ID, Type, Description LONGTEXT, CreatedUnix INDEX}` (:29-34) with a
two-value type enum `NoticeRepository = 1` / `NoticeTask = 2` (:21-26,
iota+1). Writers are SYSTEM-side only — there is NO admin create form; the
page is read + delete + empty:

- `CreateNotice(ctx, type, desc, args...)` formats at call time (:46-55);
  the DB stores the RENDERED text.
- `CreateRepositoryNotice` (:58-60) posts onto the **shutdown context** —
  fire-and-forget during process teardown, the upstream-idiom version of
  "background work must still land durably".
- Emitters: repo health-check failures
  (`services/repository/check.go:53, 95, 105, 138, 166, 194`), repo-delete
  cleanup failures (`services/repository/delete.go:330-340`,
  `create.go:452`), migration failures (`services/migrations/migrate.go:105`),
  storage-delete failures (`RemoveStorageWithNotice`, notice.go:64-73), and
  cron task cancelled/finished outcomes — the `NoticeTask` pair
  (`services/cron/tasks.go:139-152`). A disabled-by-default cron prunes
  notices older than 365d (`registerDeleteOldSystemNotices`,
  `services/cron/tasks_extended.go:175-186`;
  `custom/conf/app.example.ini:2576-2580`, `@every 168h`).

**Upstream page** (`GET /-/admin/notices`, web.go:882-886;
`routers/web/admin/notice.go:24-43`): `CountNotices` (:76-79) + the paged
read `Notices(ctx, page, NoticePagingNum)` ordered `DESC created_unix`
(notice.go:82-88; paging default **25**, `modules/setting/ui.go:140`) over
a checkbox-per-row table with a delete-selected form and a red
delete-ALL form (`templates/admin/notice.tmpl:20, 36-38, 54`). The two
POST arms: `POST /notices/delete` parses `ids[]`, ignoring non-numeric
entries (:46-63 — `ctx.FormStrings("ids[]")` filtered through a positive-int
check, :47-54), and `POST /notices/empty` runs `DELETE FROM notice`
(notice.go:66-75 over :91-103). Delete answers a flash + 200; empty answers
flash + redirect (:56-62, :73-74).

**Our substrate (verified):** no `system_notices` table anywhere in
`apps/worker/src/db/schema.ts` (3094 lines; the census's schema-list
verification re-confirmed: the ONLY `login_source`-family string in the
file is the vestigial `public_keys.login_source_id` column, always 0,
schema.ts:2003-2005). The upstream emitters have no cf-gitea analogs
yet — no repo-health checker, no migration writer — but their FUNCTIONAL
replacement exists and is currently invisible: background tasks fail into
log lines only.

- The repo-tasks consumer's per-family catch arms log-and-retry
  (`src/repos/purge.ts:156-157` import, `:175-176` mirror-sync,
  `:188-189` push-mirror-sync, `:204-205` demo-sweep, `:218-219`
  audit-retention); the malformed-message arm drops with a log line
  (:225). After `max_retries: 5` the message lands in `repo-tasks-dlq`
  (wrangler.jsonc.example:174-175), whose consumer
  (`src/repos/dlq.ts`) logs the full redrive context — kind label, raw
  body, message id, attempt count — and acks. Its own header names the
  gap this SPEC closes: "Unlike the webhook DLQ there is NO D1 row to
  flip **and no notices table**: the observability log IS the record"
  (src/repos/dlq.ts:18-19). The SPEC-0014 §3.0 e2e incident that built the
  DLQ (a purge dropped after 5 retries, an orphan RepoCell surviving under
  a deleted repo's name — dlq.ts:5-11) is EXACTLY the event class
  upstream writes a `NoticeRepository` row for (delete.go:330-340).
- The webhook delivery family keeps its own failure ledger
  (`webhookDeliveries` rows + the `webhook-delivery-dlq` sweep,
  wrangler.jsonc.example:167-168) — it is NOT a notices emitter (§5.6).

**The gap:** the store (four columns), the page (three routes), and one
emit call in a consumer that already holds every fact upstream's emitters
carry (task kind, repo identity, attempt count, error text).

### 2.3 The auths arm — upstream's login sources, our single-method posture

**Upstream surface** (`GET /-/admin/auths` + new/edit/delete,
web.go:874-880): a CRUD over `login_source`
(`models/auth/source.go:109-126` — `Source{ID, Type, Name UNIQUE, IsActive,
IsSyncEnabled, TwoFactorPolicy, Cfg TEXT}`; "an external way for
authorizing users", source.go:109). The type lattice is a SEVEN-value
enum — `NoType 0, Plain 1, LDAP 2, SMTP 3, PAM 4, DLDAP 5, OAuth2 6,
SSPI 7` (source.go:28-37; display names at :50-57) — and each value owns a
typed config record the admin form parses: ~35 LDAP fields
(`parseLDAPConfig`, `routers/web/admin/auths.go:116-153`), the SMTP pair
(:155-166), the OAuth2 provider record with custom-URL mapping and claim
configuration (:168-209), the SSPI record (:211-233). The list handler is
one `db.FindAndCount[auth.Source]` (auths.go:44-56); the create/edit posts
switch on type, register the provider (`RegisterableSource`,
source.go:94-97, invoked in `CreateSource` :218-254), and the delete arm
refuses sources still attached to users (`ErrSourceInUse`, auths.go:450;
source.go:389-402). The nav renders it FIRST in the Identity & Access
group (navbar.tmpl:19).

**Our substrate (verified):** cf-gitea has ONE auth method and no
pluggability seam at any layer:

- **No password store** — forms accept the password field for upstream
  form parity and ignore it ("**No password store** (SPEC-0002 §4.6.7 …)
  the forms accept a password field for upstream InstallForm/RegisterForm
  parity", `src/services/user-accounts.ts:25-26`; the field is
  "accepted-and-ignored", :105). The users table carries no credential
  column (schema.ts, the `users` definition).
- **The login credential IS a PAT** — "The credential is a PAT posted as
  `password` (`token` accepted as a field alias) — token-as-password
  mirrors the Basic convention SPEC-0002 §2.2 already accepts"
  (`src/ui/pages/login.tsx:3-6`). The auth module's whole public surface is
  token/Basic machinery (`src/auth/index.ts:1-8`: `resolveAuth`,
  `requireToken`, `requireScope`, `tokenRouter`, `TokenService`, the
  failure limiter — no source-chain hooks of any kind).
- **The vestigial join column stays zero** — `public_keys.login_source_id`
  "always 0 until an LDAP/OAuth2 SPEC lands" (schema.ts:2003-2005).
- **OAuth2 APPLICATIONS are a different subsystem** — the landed
  `oauth2Applications` table + `/user/applications/oauth2` CRUD
  (schema.ts:2759; `src/api/routes/oauth2-apps.ts`) manage OAuth2 CLIENT
  registrations (API consumers of THIS instance). Upstream's OAuth2 LOGIN
  SOURCE (type 6) is a client OF AN EXTERNAL IdP that signs users in —
  the `oauth2.Source{Provider, ClientID, ClientSecret, Scopes,
  RequiredClaimName, …}` record of auths.go:168-209. Landing applications
  therefore does NOT dent the auths verdict; the landed admin-applications
  page makes the distinction itself: "NOTE the census's N/A call is the
  AUTHS arm (single auth method), not this one — applications is (a) and
  LANDED here" (`src/ui/pages/admin-applications.tsx:6-7`).

**The gap is the feature.** A `login_source` table without the six source
backends would be a config store for chains that cannot sign anyone in:
upstream's chain has, per source, an auth-path consumer (the sign-in flow
switches on active sources), a user-join surface (`ExternalLoginUser` —
the column our publicKeys comment points at), and a sync engine
(`IsSyncEnabled`, source.go:114 — "Synchronization is only available with
LDAP for now", :225-228). None exists here; none is ~an arm-sized away.

### 2.4 The shared frame — nav groups, gate, and the omission ledger

Upstream's navbar groups: auths rides Identity & Access (navbar.tmpl:19),
config gets its OWN "Configuration" group with two items — the summary and
the settings editor (navbar.tmpl:93-102) — notices is a TOP-LEVEL item
(navbar.tmpl:104-106), audit_logs rides Monitoring (:108). The landed
`AdminFamilyNav` mirrors the group structure and already documents the
omissions: "auths, packages, audit_logs, self_check, config, notices,
actions are omitted — all their upstream items are unlanded pages (the
dead-link rule; the census's (b)/(c) classes)"
(`src/ui/pages/admin-users.tsx:318-321`). The route gate is the shared
`adminPagePrologue` — anonymous → login redirect, signed-in non-admin →
the 404 shell (`src/ui/index.ts:7400-7409`), upstream's
`verifyAuthWithOptionsWeb(&VerifyOptions{SignInRequired: true,
AdminRequired: true})` posture (web.go:777-779). POST arms ride the
`sameOriginGuard` first (the admin-dashboard submit pattern,
index.ts:7418-7420).

One upstream nuance the §3.3 verdict leans on: **upstream's own navbar is
conditional** — the packages item renders only `{{if .EnablePackages}}`
(navbar.tmpl:39), the actions group only `{{if .EnableActions}}`
(navbar.tmpl:74), and the whole integrations group reshapes on
`DisableWebhooks`/`EnableOAuth2` (navbar.tmpl:50-72). Nav omission for a
surface the deployment cannot serve is upstream behavior under
configuration, not a divergence from it.

## 3. The v1 surface (PROPOSAL per arm)

### 3.1 Notices — BUILD (the portable arm)

Web-only, upstream-shaped, three routes behind `adminPagePrologue`:

| route | upstream handler (routers/web/admin/notice.go) | ours |
|---|---|---|
| `GET /-/admin/notices` | `Notices` (:24-43) — paged DESC read, 25/page, total count, pager | the same read over §4's table; page size 25; upstream's checkbox table (`notice.tmpl:20, 54`) reduced to our no-JS form vocabulary: a delete-selected POST + the red delete-all POST |
| `POST /-/admin/notices/delete` | `DeleteNotices` (:46-63) — `ids[]`, non-numeric entries ignored | same parsing discipline; deletes by id set; re-render with flash (the no-JS POST answer, the admin-dashboard re-render idiom) |
| `POST /-/admin/notices/empty` | `EmptyNotices` (:66-75) — `DELETE FROM notice` | same; flash + the page re-rendered empty |

No create UI: notices are system-generated, upstream and here. The emit
seam (the SPEC's actual contribution):

- **Slice-one emitter: the repo-tasks DLQ consumer.** Every dead-lettered
  message the `repoTasksDlqHandler` logs (dlq.ts:13-17's redrive context)
  gains the same facts as a `system_notices` row, written in the handler's
  existing forward path (the handler never throws — the notice insert is
  best-effort NEXT TO the log, never instead of the ack; a failed notice
  write degrades to the log-only behavior of today). Type mapping over the
  dispatch families (dlq.ts:29-38 + the two instance-scoped riders):
  repo-scoped bodies — the purge family (structurally no `kind`),
  `import-chunk/import-abort/import-sweep`, `repo-fork`, `mirror-sync`,
  `push-mirror-sync` — are **type 1 (repository)**, description rendered
  `"<kind label> for <repo identity> dead-lettered after <attempts>
  attempts: <error digest>"`; instance-scoped bodies — `demo-sweep`,
  `audit-retention` — are **type 2 (task)**. This is upstream's
  repository-vs-task split: repo-subsystem failures vs maintenance-task
  outcomes (notice.go:21-26; cron/tasks.go:139-152).
- Description renders at emit (the audit seam's discipline — services/
  audit.ts "the DB never stores a template"), bounded (§5.2). The error
  digest and repo identity come from the decode the handler already
  performs; no new parsing.
- NOT emitters in v1: the retrying consumer catch arms (purge.ts:156-219 —
  a message that will be retried is not a notice; §8.3), the webhook
  delivery path (its ledger exists, §5.6), and the UI/API write paths
  (none upstream).

The page family + table + seam close the census's "small D1 KV + admin
writes + the page" sketch with one correction recorded: there are no admin
WRITES upstream — only delete/empty (§2.2).

### 3.2 Config — BUILD as a read-only summary (the re-mapped arm)

`GET /-/admin/config`, behind `adminPagePrologue`, rendering upstream's
eleven section headings in upstream's order with THREE row classes (the
admin-dashboard's posture-line idiom generalized: that module renders
upstream's inapplicable maintenance ops "as this note, never as buttons",
admin-dashboard.tsx:166-167, :321):

1. **REAL rows** — values read from the landed surface: `SERVER_VERSION`
   (config.ts:13), `APP_URL` (the wrangler var), the four vars of
   wrangler.jsonc.example:41-59, the published settings constants (misc-t2.ts
   §2.1's four GENERAL_* groups — imported, not re-declared; §8.2), the
   session provider ("Cloudflare D1 `sessions` table"), LFS enabled over the
   shared R2 bucket, webhook delivery enabled with its delivery ledger, the
   D1/R2/DO binding names, observability on, the two cron expressions, the
   queue topology with retry/DLQ wiring.
2. **POSTURE rows** — true-by-construction lines where upstream renders a
   config value for infrastructure we deliberately do not run: "no SSH
   server — git smart-HTTP over HTTPS only", "no mailer — email
   notifications absent", "no cache adapter — stateless workers", "no
   filesystem — R2/D1/DO are the only stores", "no app.ini — configuration
   is wrangler vars applied at deploy; changes are a var edit + redeploy
   (wrangler.jsonc.example:53)". These are the honest-absence lines the
   census called for (:383-385).
3. **SECRET rows never exist** — upstream blanks provider config before
   render (config.go:93-95); our page goes further: `wrangler secret`
   values (e.g. `GIT_TOKEN`) are never read for the page at all. Only the
   declared non-secret vars of wrangler.jsonc.example:41-59 render.

Section-by-section mapping (upstream's eleven → ours):

| upstream section (config.tmpl line) | ours |
|---|---|
| server (:4) | REAL: SERVER_VERSION, APP_URL; POSTURE: run-user/paths/script-type have no substrate |
| ssh (:47) | POSTURE row only |
| lfs (:78) | REAL: enabled, R2-backed; POSTURE: http-auth-expiry has no token-TTL knob to show |
| db (:94) | POSTURE-flavored REAL: "Cloudflare D1 (binding DB)"; no host/user/ssl to print |
| service (:122) | REAL: ALLOW_SIGNUP (mapped to upstream's registration rows); POSTURE: email-confirm/OpenID/captcha/timetracking lines (the last also published as `time_tracking_disabled: true`, misc-t2.ts:516-528) |
| webhook (:172) | REAL: enabled, delivered via the landed family; POSTURE: skip-tls-verify follows platform fetch defaults |
| mailer (:186) | POSTURE row only (+ upstream's test-mail rider is absent with it) |
| cache (:234) | POSTURE row only (upstream's test-cache rider absent) |
| session (:259) | REAL: the D1 provider; POSTURE: provider-config details mirror upstream's own blanking (config.go:93-95) |
| git (:277) | REAL: engine-backed git (the vendored engine); POSTURE: gc-args/timeout rows have no user-facing knob |
| log (:304) | REAL: observability + traces enabled; POSTURE: no access-log template / log-SQL rows |

NO write path, NO settings editor, NO test riders (§1 out-of-scope). The
page is a pure GET; nav integration gives the Configuration group its
first item (the editor item stays omitted — dead-link rule).

Classification recorded for the ledger: the census's "arguably
(a)-with-reduction" is confirmed — the arm's data all exists; nothing here
un-defers an API row, and no D1 migration rides it.

### 3.3 Auths — OMIT (the reasoned cut)

**Verdict: nav omission, ledgered — no page, no store.** The dead-link
rule keeps the auths item out of `AdminFamilyNav` exactly as the
config-settings editor item stays out in §3.2. Reasons, in the order that
actually decides it:

1. **The posture line has nothing to sit beside.** The idiom works when
   landed data shares the page with the note (the dashboard's cron table
   carries upstream's inapplicable ops as a note under a LIVE table;
   §3.2's config page renders real values above its posture lines). An
   auths page would be 100% posture — a page whose only content is
   "this cannot exist here". Upstream's page in its zero-source state
   shows an empty list plus a prominent "create authentication source"
   CTA into a six-backend form ladder (auths.go:86-114); rendering the
   list without the CTA is upstream-minus-its-purpose.
2. **Upstream itself omits unservable surfaces from this exact menu**
   (§2.4's navbar conditionals — navbar.tmpl:39, :50-72, :74). A
   deployment with LDAP compiled out and OAuth2 disabled shows a shorter
   Identity & Access group; cf-gitea's single-auth posture is the same
   configuration state, just fixed at build time.
3. **The store would be config for chains that cannot run** (§2.3): no
   sign-in consumer, no user-join surface, no sync engine. This is the
   census's own frame — "rather than a store" (:387).
4. **The gate is explicit**, so the omission is not forever-by-default:
   this verdict is superseded the day a SPEC lands any external login
   chain (the schema comment already names the trigger — schema.ts:2003's
   "until an LDAP/OAuth2 SPEC lands"). At that point the arm reopens as
   the upstream-shape CRUD over the new store; §3.3's ledger entry is
   then obsolete and gets edited, not argued with.

The ledger entry (for
`docs/compat/` — added with the implementing wave): "admin auths page:
omitted by SPEC-0018 §3.3 — upstream manages external login sources
(login_source; LDAP/SMTP/PAM/OAuth2-source/SSPI); cf-gitea has one auth
method (PAT-as-credential, no password store) and no pluggable login
chain; the nav item is absent (the upstream conditional-navbar precedent,
navbar.tmpl:39/74). Reopens with the first external-auth SPEC." The
applications-vs-auths distinction rides the already-landed note
(admin-applications.tsx:6-7) and needs no further record.

## 4. Data model

### 4.1 D1 tables (new — migration via `pnpm db:generate` into
`apps/worker/src/db/migrations`)

One table, a column-for-column port of §2.2's struct:

- **`system_notices`** (upstream table name is `notice` — the drizzle
  schema's plural convention applies; the census's "no system_notice"
  phrasing names the model): `id` pk autoincrement; `type` int NOT NULL
  (1 = repository, 2 = task — upstream's iota+1 order, notice.go:21-26;
  INTEGER here, not TEXT, because the enum is closed and upstream stores
  it as an int the locale keys index — `admin.notices.type_%d`,
  notice.go:41-43); `description` TEXT NOT NULL (upstream LONGTEXT;
  bounded at emit, §5.2); `created_unix` int NOT NULL
  (mode timestamp). **Index on `created_unix`** (upstream
  `xorm:"INDEX created"`, notice.go:33 — the DESC paged read's scan).
  No UNIQUE constraints (upstream has none — notices are an append log);
  no FKs (no owner column — nothing cascades, §5.5).

### 4.2 No other tables, no R2, no DO

Notices are pure D1 rows: no blob ever rides them (descriptions are
bounded text), and no cross-request ordering exists (append + bulk
delete — D1 serializes each statement; the empty-all is one
`DELETE FROM system_notices` exactly as upstream's is one
`DELETE FROM notice`, notice.go:93). The DLQ emitter's insert rides the
consumer's existing env binding (`env.DB`), not a transaction: the DLQ
handler has no surrounding write to batch with, and the §3.1
best-effort posture (log-on-failure, never throw) is deliberate.

The config arm adds NO storage (§3.2 reads existing constants/vars); the
auths arm adds NO storage (§3.3).

## 5. Edge cases, limits, and failure modes

1. **Retry vs terminal (the emit-vs-spam rule)** — a queue message that
   fails attempt 1 of 5 is a transient, not a notice: upstream's emitters
   fire at operation FAILURE (the health check that could not complete,
   delete.go's post-cleanup errors), never per retry. Slice one emits
   ONLY from the DLQ consumer (the terminal state, after the platform's
   own `max_retries: 5`); the retrying catch arms keep their log lines
   and gain nothing. A future attempt-aware emitter (notice on final
   attempt in-line, softening the DLQ dependency) is §8.3's call, not
   v1's.
2. **Description bounds** — upstream stores LONGTEXT unbounded; ours
   bounds at emit: the rendered description is clipped to **2000 chars**
   (the kind label, identity, attempt count, and a one-line error digest
   fit comfortably; a stack-trace-sized error is not upstream's content
   either — its emitters pass formatted one-liners). The clip is a
   suffix-truncate with a visible `…` marker, never a silent drop of the
   row (§8.4 confirms the bound).
3. **The emitter must not kill the consumer** — the DLQ handler's
   contract is "NEVER throws and NEVER retries" (dlq.ts:24). The
   notice insert rides inside that contract: try/insert, on ANY failure
   log-and-continue; the ack path is untouched. A notices-store outage
   degrades to today's exact behavior (log-only), never to a DLQ loop.
4. **`ids[]` parsing discipline** — upstream ignores every non-positive
   or non-numeric entry (notice.go:47-54); ours mirrors it (a stray
   `"abc"` in the form never 500s). The delete arm answers the
   re-render-with-flash even when the id set is empty-after-filter
   (upstream answers success with a 200 flash regardless of matched
   rows, :56-62).
5. **Nothing cascades** — notices have no owner/repo FK: deleting a user
   or repo never touches them (upstream likewise — the rows
   deliberately survive their subjects; a dead-lettered purge notice
   about repo X outlives X by design, which is the point: the admin
   reads it after the subject is gone). The purge pipeline
   (`src/repos/purge.ts`) needs NO changes.
6. **The audit boundary (§1's out-of-scope rider, made concrete)** —
   `audit_event` rows are actor-attributed write records (who did what
   with which credential — the SPEC-0015 seam's shape, services/audit.ts);
   `system_notices` rows are system-attributed failure reports (no actor,
   no credential, written by the platform about itself). Upstream keeps
   the same split (models/audit vs models/system/notice); no v1 or future
   arm folds one into the other. The `origin: "system"` value in the
   audit union (schema.ts, the auditEvents `origin` enum) does NOT make
   audit_event a notices home — system-origin audit rows still carry an
   action id and actor.
7. **Paging floor** — the list orders `created_unix DESC` (upstream
   :82-88); equal-timestamp rows (a DLQ batch landing several dead
   letters in one invocation) keep insertion order by `id DESC` as the
   tiebreaker (upstream relies on insertion order implicitly; the
   explicit tiebreak is the D1-honest version of the same read).
8. **Empty-instance posture** — zero notices renders upstream's empty
   state: the table header plus the empty line, delete-all button still
   present (upstream's template renders the form unconditionally,
   notice.tmpl:36-38 — deleting an empty set is a no-op success). The
   config page's posture rows render identically on every deployment —
   there is no "empty" state to special-case.
9. **Vars are deploy-time** — the config page reads `env` vars at request
   time, so a var edited-and-redeployed shows up WITHOUT any cache
   invalidation story (upstream needs `InvalidateCache` after its dynamic
   writes, config.go:159 — the whole subsystem our read-only posture
   makes unnecessary). This is the §3.2 verdict paying rent: no
   revision counter, no cache getter, no invalidation seam.

## 6. Testing plan

Worker vitest (real bindings, the `applyD1Migrations` + seeded-env idiom
of the landed suites):

- **Model/service**: insert/paged-read shapes (25/page window,
  `created_unix DESC, id DESC` ordering under equal timestamps);
  delete-by-ids with the upstream filtering discipline (non-numeric
  entries ignored, empty set a no-op success); empty-all on a populated
  and on an empty table.
- **Emit seam**: unit-test the DLQ handler's notice write with each
  message family fixture (purge/import/fork/mirror-sync/push-mirror-sync
  → type 1; demo-sweep/audit-retention → type 2; the description carries
  kind + identity + attempts); the degrade path — a DB that rejects the
  insert still yields the normal ack + log (the handler-never-throws
  contract, §5.3); description clipping at the bound (§5.2).
- **Notices page**: golden for the populated render (the checkbox table,
  the two forms — the session-goldens idiom); the admin gate matrix
  (anonymous → login redirect, non-admin → 404 shell — the
  adminPagePrologue contract, index.ts:7400-7409); the delete/empty POSTs
  through `sameOriginGuard` (a cross-origin POST is refused before the
  prologue).
- **Config page**: golden for the full render; a VALUES-CROSS-CHECK test
  that imports the page's data module AND the misc-t2 constants, asserting
  every published number on the page equals the API's (the single-source
  guarantee of §8.2 — if this test cannot be written, the constants were
  duplicated and the §8.2 proposal was violated); an env-var matrix test
  (ALLOW_SIGNUP/DEMO_MODE/AUDIT_RETENTION_DAYS flips change the
  corresponding rows); a SECRET-HYGIENE test asserting the rendered HTML
  contains no `GIT_TOKEN`-shaped secret value even when env carries one
  (§3.2 rule 3).
- **Auths**: no tests — the arm builds nothing (§3.3); the ledger entry
  is docs, reviewed in the landing wave.
- **Gates**: `pnpm typecheck`; `pnpm test:full` per ADR-0006 — a
  single-file `pnpm test` pass is never cited as suite-green.

No engine-check `.mjs` arms exist for this SPEC — neither arm touches the
vendored engine; the vitest suites are the whole plan.

## 7. Milestones (the census's sizing, serializable)

- **M1 — notices: table + emit seam + page** (size **M**; the census's
  "M/L per page" prices the store-ful arms, and this is the lighter one —
  four columns, three routes, one emitter): migration + the notices
  service (insert/paged-read/delete/empty) + the DLQ handler's notice
  write + `pages/admin-notices.tsx` + tests. Lands the census's
  "needs-model" step for notices and closes the DLQ header's "no notices
  table" gap (dlq.ts:18-19). One commit-unit; file-ownership: the new
  schema slice + `src/repos/dlq.ts` (its emitter call) + the new page
  module + tests; `AdminFamilyNav`'s notices item and the `index.ts`
  mount ride the orchestrator's registration window (below).
- **M2 — config: the read-only summary page** (size **M**; the bulk is
  the §3.2 section assembly + the values cross-check): the page module
  with its data loader (env vars + imported constants + §3.2's row
  classes) + tests. No migration, no service, no API change (the §8.2
  export of the GENERAL_* constants is the one misc-t2.ts touch — a
  three-line diff, disclosed in the unit). Same shared-file rule: the
  Configuration group's nav item + mount ride the orchestrator window.
- **No auths milestone.** The §3.3 verdict's cost is one ledger paragraph,
  attached to M1's docs slice (the wave that lands the notices page also
  appends the ledger entry — one docs+code unit per the atomic-commit
  policy).

Entry criteria: ratified SPEC (this document → accepted), then M1 and M2
as independent worker units — M2 has no dependency on M1 — BUT their
shared-file edits (`AdminFamilyNav` in admin-users.tsx, the `index.ts`
mounts) serialize through ONE orchestrator registration window per the
census's index.ts discipline (Open Issues #7: "batch the (a) wave's
mounts into one registration window and prove each route through the
live router"). Dispatch order proposal: M1 first (it owns the store and
the emitter — the load-bearing half), M2 second or parallel-dispatched
with the mount window at the end.

## 8. Open questions (resolve at ratification)

1. **Auths final call** — §3.3's omission (recommended) vs the honest-
   absence page (an S-sized static page: upstream's zero-source list
   state, minus the create CTA, plus a posture line; the nav item
   appears). Proposal: omission — the page would carry no data ever
   (§3.3.1), upstream's own navbar omits unservable surfaces
   (§3.3.2), and the reopening gate (the first external-auth SPEC)
   is explicit.
2. **Config value sources** — export the four module-private
   `GENERAL_*` constants from `src/api/routes/misc-t2.ts` for the page
   to import (single source; the values-cross-check test of §6 enforces
   it) vs re-declaring page-local copies. Proposal: export — the
   constants are the API's published truth and the page's whole point is
   rendering that truth.
3. **Notice emission scope** — DLQ-only slice one (§3.1: terminal-only,
   zero risk of retry spam, uses the handler that already holds every
   fact) vs adding attempt-aware emission inside the retrying consumers
   (an earlier notice, at the cost of retry-count plumbing through
   purge.ts's five catch arms). Proposal: DLQ-only; the DLQ arrival is
   the true terminal event and the platform's `max_retries: 5` window is
   short enough that the delay is minutes, not days.
4. **Description bound** — 2000 chars at emit (§5.2) vs upstream's
   unbounded LONGTEXT-parity. Proposal: 2000 — upstream's emitters write
   one-liners by construction; the bound is defensive against error
   objects with embedded payloads and keeps the LONGTEXT column a plain
   TEXT.
5. **The write path / config_settings editor** — confirm this SPEC
   builds NOTHING for upstream's `ChangeConfig`/`system_setting`/
   dynamic-editor stack (§1 out-of-scope) and that the ledger wording is
   "returns when a concrete runtime-toggle need exists" — the first
   candidate being upstream's instance maintenance mode/web banner pair
   (the instance.tmpl forms, §2.1), not a general settings editor.
   Proposal: confirm as written.
6. **The app/site name row** — upstream's server section leads with the
   instance name (`AppName`, config.tmpl:8; `[app] RUN_NAME` in the ini);
   we have no such var, and the vendored frontend's branding is
   asset-baked. Proposal: a POSTURE row ("no instance-name setting;
   branding is the deployed frontend's") rather than a new `APP_NAME`
   var — add the var only when a deployment actually asks to rebrand.

### Ratification (pending — recorded here when resolved)

### Ratification (2026-10-29, orchestrator)

All six resolved per their proposals: (1) auths OMIT, ledgered, reopened only
by the first external-login-chain SPEC; (2) export the GENERAL_* constants
(one source of truth — the values-cross-check test enforces it); (3) DLQ-only
emission for slice one; (4) the 2000-char description bound; (5) zero build
for the config write-path stack — the read-only summary IS the arm; (6) the
instance-name row as a POSTURE line. M1 (notices) and M2 (config) serialize
through one admin-registration window per the census's Open Issues #7 note.

---

## As-built — the v1.3.2 board's P1-4 re-verification (2026-10-31 — no build; the §3.3 verdict HOLDS)

The v1.3.2 residual board dispatched P1-4 with an implementation premise:
an "API-first ladder" — an `/api/v1/admin/auths` family (list/get/create/
update/delete "with upstream's exact bodies") with the web page built over
it. This amendment records the tension resolution the dispatch asked for:
**the premise fails at the pin, the board row does not override §3.3, and
the omission verdict stands unchanged.** Zero code ships under P1-4; the
row stays the survey's one PARTIAL row as a documented divergence, exactly
the board's S-priced arm ("S to leave as documented divergence"). The
re-verification evidence, all own-eyes at the same pin (`fc4936884584`,
2026-10-31):

1. **Upstream has NO auth-source API at the pin — §1's out-of-scope bullet
   re-verified.** The admin group mounts exactly cron/orgs/packages/users/
   emails/unadopted/hooks/actions (`gitea/routers/api/v1/api.go:1814-1867` —
   every `m.Get/m.Post/m.Combo/m.Patch/m.Delete` in the group walked); no
   auths arm. `gitea/routers/api/v1/admin/` holds eleven files (action,
   adopt, cron, email, hooks, org, packages, repo, runners, user_badge,
   user) — no auths.go. Both generated swagger documents
   (`gitea/templates/swagger/v1-swagger.generated.json` and
   `v1-openapi3.generated.json`) parse to **350 paths each with zero
   `/admin/auths*` entries**; the only auth-adjacent paths in either are
   `/user/applications/oauth2` and `/{id}` — the OAuth2 CLIENT-app family
   §2.3 already distinguishes from login sources. `gitea/modules/structs/`
   declares no auth-source request/response structs. There are no
   "upstream's exact bodies" to mirror: the family is pin-silent, and the
   standing rule ("pin-silent = open question, never invent") applies.
2. **The loophole is closed at the source: upstream main has never had it
   either.** `templates/swagger/v1-swagger.generated.json` fetched live from
   `go-gitea/gitea` main via the GitHub contents API (2026-10-31) parses to
   the same 350 paths with the same `/admin/*` set and zero auths entries —
   the auths management surface is web-only in every upstream state, so no
   newer-than-pin version supplies the missing API shape.
3. **The web page exists upstream and is exactly what §2.3/§3.3 priced.**
   `GET|POST /-/admin/auths` + `/{authid}` + `/{authid}/delete` mount at
   `gitea/routers/web/web.go:874-880` over `routers/web/admin/auths.go` and
   `templates/admin/auth/` — a CRUD whose store is `login_source`
   (`models/auth/source.go:109-126`, the seven-value type lattice at
   :28-37) and whose create/edit forms parse the four typed backend config
   records (`routers/web/admin/auths.go:116-233`). cf-gitea has none of
   that substrate by design (SPEC-0002's PAT-only posture; the vestigial
   `public_keys.login_source_id` always 0) — a page over it would be 100%
   posture (§3.3 reason 1) and a `login_source` table without the six
   backends would be config for chains that cannot sign anyone in (§3.3
   reason 3). The survey's "no admin login-source read family is declared"
   (`docs/compat/ui-parity-survey.md:724, :1276, :1488`) names this
   dependency; its remedy is the external-login-chain SPEC §3.3's gate
   names — not API invention.
4. **The contract discipline mechanically forbids the invented family.**
   `scripts/check-openapi.mjs` assertion (a) hard-fails (non-zero exit) any
   path+method our router declares that the frozen contract copy
   (`apps/worker/src/compat/contract/v1-swagger.generated.json`, the
   verbatim-at-pin swagger per ADR-0002) lacks. An
   `/api/v1/admin/auths` family would therefore fail the repo's own gate by
   construction, and carrying it as a runtime-only/documented divergence
   would make it the only upstream-absent family in the API — a reverse
   divergence with no upstream cite, which the parity rule does not permit.

**Board-row resolution:** the P1-4 row's own text defers to this SPEC —
"No new decision here: either the verdict stands (zero work; the row stays
the recorded divergence) or a future login-source SPEC reopens it." The
verdict stands; nothing in the row overrides a ratified SPEC. The row's
"needs-API-first" classification remains accurate and unchanged: the page
is not dispatchable as UI work, and its true prerequisite is the substrate
SPEC (§3.3's reopen gate), because the API half of an "API-first ladder"
does not exist upstream to build first.

**Forward note for the reopen** (recorded here so the future SPEC does not
re-derive it): when the first external-login-chain SPEC lands, the reopened
arm is the upstream-shape WEB CRUD over the new store (web.go:874-880's
five arms) — it must NOT be specced as an API-first ladder, because
upstream's own auths management has no `/api/v1` family at the pin or at
main (points 1-2); any API family built alongside would itself be an
invention requiring its own divergence record and contract exception.

**Landing state of §3.3's ledger entry:** the entry rides the surfaces the
implementing waves touched rather than a standalone `docs/compat/` file —
this SPEC's §3.3 (the verdict + the gate), the `AdminFamilyNav` omission
note (`apps/worker/src/ui/pages/admin-users.tsx:371-375`, "the auths
omission is SPEC-0018 §3.3's verdict", landed with M1's `7381c0d`), the
SPEC-0018 index row in `specs/README.md` ("the auths arm is the SPEC's
documented omission verdict (§3.3 — no build)"), and the survey's admin row
+ NEEDS-API-FIRST paragraph (`docs/compat/ui-parity-survey.md:1276`,
`:1551`). No code, no migration, no nav edit ships with this amendment;
M1/M2 (`7381c0d`, `9d7ccd6`) remain the SPEC's only build output.
