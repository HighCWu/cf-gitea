# Re-verification: packages + actions surfaces (production, 2026-10-30)

Re-run of `docs/usability/findings-packages-actions.md` against
`https://cf-gitea.hecongw.workers.dev` (the FIXED deployment — the v1.3-era
surfaces plus the post-sweep packages-settings fix). Same method, same
clients where the box has them, one new fix-verification arm: the org AND
user **packages settings** pages (the user twin was deploy-lag in the
original sweep), with the cleanup-rules CRUD round-trip on one of them.

Method deltas worth knowing:

- The per-run admin PAT was minted for the standing `p0probe` user via
  `scripts/bootstrap-admin.mjs p0probe --remote` (mint stdout + token file
  shredded; the row — id 115, `prefix = cfg_fe89…` — deleted by prefix and
  the table re-listed after: two standing rows from other waves remain,
  deliberately untouched). Web pages rode the `gitea_session` cookie from the
  real `POST /login` (PAT-as-password); API calls rode the PAT.
- Real clients on this box: **twine 7.0.0** (installed into a scratch venv —
  the box's conda `twine` shim was broken, its shebang pointing at a since-
  removed python3.10), **pip 26.2.1**, **npm 11.12.1** — the same versions the
  original run reported. helm/mvn remain absent → curl-exact per the
  `packages-registry` battery's fixture shapes (`scripts/deploy-probes.mjs`).
- The runner wire calls were hand-built protobuf (the `wire.ts` field map)
  POSTed as `application/proto` connect unary, as before.

## Verdict summary

**Packages + actions surfaces: all PASS (the original 11/11 re-confirms).
The NEW packages-settings arm: the render fix VERIFIED (both pages), but the
cleanup-rules CRUD round-trip FAILS — 1 new blocker (B-1).**

| # | Surface | Client | Verdict |
|---|---------|--------|---------|
| 1 | generic registry | curl | PASS |
| 2 | pypi registry | **real twine 7.0.0** + **real pip 26.2.1** | PASS |
| 3 | npm registry | **real npm 11.12.1** | PASS |
| 4 | helm registry | curl (helm binary absent) | PASS |
| 5 | maven registry | curl | PASS |
| 6 | nuget registry (V3 + V2) | curl | PASS |
| 7 | packages web pages (owner list / 303 / versions / version view / file link / repo tab) | session cookie | PASS |
| 8 | Actions tab empty state (fresh repo) | session cookie | PASS |
| 9 | Runner registration (connect wire) | hand-built proto | PASS |
| 10 | Runners pages (admin / user / org / repo) | session cookie | PASS |
| 11 | OIDC discovery + JWKS | curl | PASS |
| 12 | NEW: packages settings pages render (user + org) | session cookie | PASS (the fix is live) |
| 13 | NEW: cleanup-rules CRUD round-trip (form POST → list row → delete) | session cookie | **FAIL — B-1** |

## Blockers

### B-1 (blocker): the packages cleanup-rules CREATE and EDIT-SAVE are dead on BOTH scopes — the form POST always re-renders without writing

The fix being verified (both settings pages render) is live, but the CRUD
round-trip through the rendered form does not work:

- `POST /user/settings/packages/rules/add` with a fully valid body
  (`id=0&action=save&type=generic&enabled=on&keep_count=5&…`) → **200** (the
  add page re-rendered with every submitted value echoed — type selected,
  checkboxes checked, selects carrying the posted values) — NOT the documented
  303 onto `/user/settings/packages/rules/{id}`; **no rule row is created**
  (the list still reads "No cleanup rules available.").
- The same POST against `POST /{org}/settings/packages/rules/add` behaves
  identically (200 re-render, no row) — the org scope is equally dead.
- Bisecting the body (minimal `action=save&type=generic`; the battery-test
  shape `type=npm&keep_count=50&keep_pattern=new&remove_days=90`; varied
  `remove_days`) never yields a 303. Every create re-renders.

Root cause (repo HEAD, reproduced locally): the submit handlers gate the
invalid-form re-render on

```
if (Object.keys(parsed.errors).length > 0) {   // user: ui/index.ts:8719, org: ui/index.ts:9910
```

but `parseOrgCleanupRuleForm` (org-settings-packages.tsx:487) **always**
returns all seven error keys (`{ id, action, type, keepCount, keepPattern,
removeDays, removePattern }`, boolean-valued), so `Object.keys(...).length`
is 7 — the gate is tautologically true and the create arm is unreachable.
The correct aggregate is the parser's own `parsed.invalid` (the shape already
carries it). The edit submit (ui/index.ts:8755 / 9933) has the same
tautology in `if (Object.keys(parsed.errors).length > 0 && parsed.values.action !== "remove")`
— so **edit-save re-renders without updating** while **remove** (the
`action !== "remove"` escape) still works.

Local repro through the real mounted router at HEAD (workerd, real D1, the
session.test.ts harness — login → add form → POST the exact production body):

```
CREATE-STATUS: 200  (LOC: null)        RULE-ROWS: []          ← no insert
DIRECT-PARSE-INVALID: false            ← the same body parses clean
DIRECT-APPLY-OUTCOME: {"outcome":"created","ruleId":1}         ← the write arm works
GATE-KEYS-LENGTH: 7 => tautologically >0: true                 ← the bug
EDIT-SAVE-STATUS: 200 (LOC: null)      ← save re-renders, no update
REMOVE-STATUS: 303 → /user/settings/packages                   ← remove works
```

Production and HEAD are byte-for-byte the same story (the echoed-values
re-render with no field error marks and no banner is exactly the
`userCleanupRuleEditDataFromForm` arm under a tautological gate). The family's
unit suites pass because they exercise `parse…` and `apply…` directly and the
parse-table guard cases — never the handler's gate. This is not upstream
parity: upstream's `ctx.HasError` binding check is a real aggregate, not an
always-true key count.

Fix direction (NOT applied, per probe discipline): gate both submits on
`parsed.invalid` (create), and `parsed.invalid && parsed.values.action !== "remove"`
(edit) — two lines per scope, plus a router-level round-trip test so the
handler gate stays covered.

## Packages (six protocols) — all PASS, identical posture to the original

One owner-scoped fixture set: public probe repo `p0probe/probe02004360`
(auto_init) + the run PAT; per-run random `probe-*` / `Probe.Nuget.*` names
(`…02004360` this run).

1. **generic — PASS.** `PUT /api/packages/p0probe/generic/{name}/1.0.0/probe-file.bin`
   → 201; GET → 200, bytes verbatim (cmp clean).
2. **pypi — PASS with real clients.** A valid wheel (zipfile-built,
   dist-info/METADATA+WHEEL+RECORD) published with **twine 7.0.0**
   (`--repository-url …/api/packages/p0probe/pypi/`) → twine's own success
   output, `201 Created`, exit 0. `GET …/pypi/simple/{name}` → 200
   `text/html` PEP 503 page, the anchor carries `#sha256=<full digest>`; the
   file URL → 200 bytes verbatim. **A real `pip download --index-url
   …/pypi/simple/` resolved and fetched the wheel byte-identically** (cmp
   clean) — same strongest-signal shape as the original run.
3. **npm — PASS with the real client, using the F-1 workaround.** The
   `.npmrc` rode the trailing-slash form F-1 documents:
   `registry=…/api/packages/p0probe/npm/` WITH the trailing slash plus
   `//<host>/api/packages/p0probe/npm/:_authToken` → `npm publish` →
   `+ probe-npm-…@1.0.0`; `npm view <name> versions dist-tags` → `1.0.0` /
   `{ latest: '1.0.0' }`; the `/-/package/{name}/dist-tags` endpoint → 200
   `{"latest":"1.0.0"}`; the tarball GET's sha1 equals the publish shasum
   byte-for-byte. (F-1 itself unchanged — still the client-side footgun it
   was; the workaround remains required.)
4. **helm — PASS (curl; no helm binary).** A real `tar -czf` chart
   (`{chart}/Chart.yaml`) POSTed to `…/helm/api/charts` → 201; `index.yaml`
   → 200 with `entries:` / name / version and the canonical
   `https://…/api/packages/p0probe/helm/{chart}-1.0.0.tgz` URL; the chart
   download is byte-identical to the upload (cmp clean).
5. **maven — PASS.** `.pom` PUT → 201, `.jar` PUT → 201; generated
   `maven-metadata.xml` → 200 `text/xml` with groupId/artifactId/version and
   `<latest>1.0.0</latest>`; jar GET byte-identical. One probe note (method,
   not a bug): the metadata lives at the ARTIFACT level
   (`/maven/com/example/{artifact}/maven-metadata.xml`); a version-level
   request (`…/{artifact}/1.0.0/maven-metadata.xml`) 404s — the battery's
   base path is the artifact level, and the original doc's incantation was
   read against that.
6. **nuget — PASS (V3 + V2).** Service index → 200 (version 3.0.0, 9
   resources, `PackagePublish/2.0.0` at the base); the stored-entry `.nupkg`
   (root `package.nuspec` + nested `lib/net45/` entry, fifth-segment version
   `1.04.5.2.5-rc.1+probe`) PUT with ONLY `X-NuGet-ApiKey` (no Authorization —
   the apiKey fallback arm) → 201; registration index bounds and leaf answer
   the NORMALIZED `1.4.5.2-rc.1`; the `.nupkg` download is byte-identical with
   the lowercased `content-disposition` filename; V2
   `Packages(Id='…',Version='1.4.5.2-rc.1')` → 200 atom with
   `<d:NormalizedVersion>1.4.5.2-rc.1</d:NormalizedVersion>` and the
   self-closing `<content/>`.

### Packages web pages (session cookie) — PASS

- `GET /p0probe/-/packages` → 200 with all six probe names rendered.
- `GET …/-/packages/generic/{name}` → **303** exactly onto `…/1.0.0`.
- `GET …/-/packages/generic/{name}/versions` → 200 with the version row.
- `GET …/-/packages/generic/{name}/1.0.0` → 200; the page's file link
  (`…/1.0.0/files/51`) downloads the ORIGINAL uploaded bytes (cmp clean).
- **Repo tab**: `POST /api/v1/packages/p0probe/generic/{name}/-/link/{repo}`
  → 201, then `GET /p0probe/{repo}/packages` → 200 carrying the linked name.

### Packages cleanup — PASS

Whole-package `DELETE /api/v1/packages/p0probe/{type}/{name}` → 204 for all
six, management list reads `[]` after. The maven delete again needed the
colon percent-encoded (`maven/com.example%3Aprobe-mvn-…`) — **F-2
re-confirmed as-is** (parity papercut, unchanged).

## NEW fix-verification: packages settings pages

- **The render fix is LIVE — both twins render.**
  `GET /user/settings/packages` → 200, pageClass `page-content user settings
  packages`, the "Manage Cleanup Rules" panel with its Add Cleanup Rule
  button; `GET /{org}/settings/packages` → 200, pageClass `page-content
  organization settings packages`, the same panel. The original sweep's
  deploy-lag user twin is resolved.
- `GET /user/settings/packages/rules/add` → 200 with the full form
  (type/keep_count/remove_days selects, enabled + match_full_name checkboxes,
  hidden `id=0`, `action=save` submit) — the form itself renders fine.
- **The CRUD round-trip FAILS — see blocker B-1.** Create (both scopes) and
  edit-save never write; only the remove arm 303s. Production verdicts above;
  the repo-HEAD repro pins the tautological gate.
- The remove arm was verified through the router at HEAD (303 onto the list;
  the seeded row gone). Production has no rule rows to remove (nothing can be
  created through the UI), and fabricating D1 rows on production is out of a
  probe's posture — the remove path's production verdict rides on the local
  repro plus the shared handler shape.

## Actions (control plane live; M3 trigger chain still absent) — trio PASS

1. **Actions tab empty state — PASS.** On a fresh (auto_init, zero-workflow)
   repo, `GET /p0probe/{repo}/actions` → 200, pageClass
   `page-content repository actions`, empty state "There are no workflows
   yet. Don't know how to start with Gitea Actions? See the quick start
   guide." with the guide linking
   `https://docs.gitea.com/usage/actions/quickstart/` — the Quick Guide shape,
   unchanged.
2. **Runner registration — PASS.** The global registration token was scraped
   from the live `GET /-/admin/actions/runners` token panel (40-hex; left
   active — the designed reusable-until-reset posture). A hand-built
   `RegisterRequest` (name/token/version 3.5.1/labels `ubuntu-latest`,
   `node:20`) POSTed to `/api/actions/runner.v1.RunnerService/Register`
   (`application/proto`) answered 200 `application/proto`, decoded
   `{id: 2, uuid, token, name, version, labels}` — runner **id 2**: id 1 was
   the original probe's (deleted), the counter continues; production had no
   standing runners. `Ping` → 200 `Hello, Hello, reverify!!` (the echo
   shape); `Declare` with `x-runner-uuid`/`x-runner-token` → 200 with the
   runner name back. The row appeared on **all four** runners pages:
   `/-/admin/actions/runners`, `/user/settings/actions/runners`,
   `/{probe-org}/settings/actions/runners` (fresh probe org — the original's
   was deleted in its cleanup), and `/p0probe/{repo}/settings/actions/runners`.
   Deletion via `POST /-/admin/actions/runners/2/delete` → 303 back to the
   list; the admin page no longer carries the row.
3. **OIDC issuer — PASS.** `GET /api/actions/oidc/.well-known/openid-configuration`
   → 200 `application/json` with
   `issuer: https://cf-gitea.hecongw.workers.dev/api/actions/oidc`, coherent
   `jwks_uri`, `RS256`; `GET /api/actions/oidc/jwks` → 200 with one
   RSA/RS256/`sig` key (2048-bit modulus). Unchanged from the original.

Not exercised (honest scope, unchanged from the original): FetchTask /
UpdateTask / UpdateLog on production (no runnable jobs without M3; no
production D1 fabrication), artifacts v1/v4, the `/api/actions_pipeline`
family, a real act_runner binary, and real helm/mvn clients (binaries absent).

## Probe hygiene

Deleted and re-verified gone: the two probe repos (204 + 204; `/user/repos`
carries zero probe repos after), the probe org (204), all six packages (204s,
list `[]`), the runner row (admin list clean after the 303). The per-run PAT
row (id 115, prefix-scoped DELETE → changes: 1) is gone and the token table
re-listed — two standing rows from other waves (ids 1, 74) remain, untouched.
Token material (mint stdout + err, token file, .npmrc, the registration-token
scrape, the runner session json, the session cookie jar) shredded; the
scratch dir re-scanned clean of `cfg_*` material. The global runner
REGISTRATION TOKEN row remains active by design (reusable-until-reset).
