# Findings: packages + actions surfaces (production, 2026-10-30)

Target: `https://cf-gitea.hecongw.workers.dev` (the deployed production worker).
Scope: the two v1.3-era user surfaces driven with REAL tooling — the six
`/api/packages` registry protocols (real clients where installable, curl
per the `packages-registry` battery's fixtures where not) and the Actions
control plane's user-visible surface (the M3 trigger chain is NOT deployed, so
runs cannot start from a push; what was verified is what a user actually gets
today).

Method: a per-run admin PAT was minted for the standing `p0probe` user via
`scripts/bootstrap-admin.mjs p0probe --remote` (mint stdout + token file
shredded; the row deleted by prefix and the table re-listed after). Web pages
rode the `gitea_session` cookie from the real `POST /login` (PAT-as-password,
the ui-login methodology); API calls rode the PAT; the runner wire calls were
hand-built protobuf (the `wire.ts` field map) POSTed as `application/proto`
connect unary — exactly what a stock act_runner speaks. All fixtures were
scratch `probe-*` names under one owner; everything created was deleted and
re-verified gone.

## Verdict summary

**All surfaces PASS. 0 blockers. 2 informational findings, both
parity-with-upstream client-side footguns.**

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
| 9 | Runner registration (connect wire) | hand-built proto (fake-runner shapes) | PASS |
| 10 | Runners pages (admin / user / org / repo) | session cookie | PASS |
| 11 | OIDC discovery + JWKS | curl | PASS |

## Blockers

None.

## Packages (six protocols)

One owner-scoped fixture set: public probe repo `p0probe/probe08565824916`
(auto_init, deleted 204 at the end) + the run PAT. All names below were
per-run random `probe-*`/`Probe.Nuget.*` shapes.

1. **generic — PASS.** `PUT /api/packages/p0probe/generic/{name}/1.0.0/probe-file.bin`
   → 201; GET → 200, bytes verbatim (cmp clean).
2. **pypi — PASS with real clients.** A valid wheel (zipfile-built,
   dist-info/METADATA+WHEEL+RECORD) published with **twine 7.0.0**
   (`--repository-url …/api/packages/p0probe/pypi/`) → upload 200-green
   (twine's own success output, no error). `GET …/pypi/simple/{name}` → 200
   `text/html` PEP 503 page, the anchor carries `#sha256=<full digest>`; the
   file URL → 200 bytes verbatim. **A real `pip download --index-url
   …/pypi/simple/` resolved and fetched the wheel byte-identically** (the
   strongest end-user signal on this surface).
3. **npm — PASS with the real client.** `npm publish` (npm 11.12.1) → `+
   probe-npm-…@1.0.0`; `npm view <name> versions dist-tags` answers
   `1.0.0` / `{ latest: '1.0.0' }`; the `/-/package/{name}/dist-tags`
   endpoint → 200; the tarball GET's sha1 equals the publish notice's shasum
   byte-for-byte. See F-1 for the .npmrc auth-key footgun.
4. **helm — PASS (curl; no helm binary on the probe host).** A real
   `tar -czf` chart (`{chart}/Chart.yaml`) POSTed to `…/helm/api/charts` →
   201; `index.yaml` → 200 with `entries:` / name / version / canonical
   `…-1.0.0.tgz` URL; the chart download is byte-identical to the upload.
5. **maven — PASS.** `.pom` PUT → 201, `.jar` PUT → 201; generated
   `maven-metadata.xml` → 200 `text/xml` with groupId/artifactId/version and
   `<latest>`; jar GET byte-identical.
6. **nuget — PASS (V3 + V2).** Service index → 200 (version 3.0.0, 9
   resources, `PackagePublish/2.0.0` at the base); the hand-built
   stored-entry `.nupkg` (root `package.nuspec`, fifth-segment version
   `1.04.5.2.5-rc.1+probe`) PUT with ONLY `X-NuGet-ApiKey` (no Authorization
   — upstream's apiKey fallback arm) → 201; registration index bounds and
   leaf answer the NORMALIZED `1.4.5.2-rc.1`; the `.nupkg` download is
   byte-identical with the lowercased `content-disposition`; V2
   `Packages(Id='…',Version='1.4.5.2-rc.1')` → 200 atom with
   `<d:NormalizedVersion>1.4.5.2-rc.1</d:NormalizedVersion>`.

### Packages web pages (session cookie) — PASS

- `GET /p0probe/-/packages` → 200, all six probe names rendered in the list.
- `GET …/-/packages/generic/{name}` → **303** exactly onto `…/1.0.0` (the
  RedirectToLastVersion shape).
- `GET …/-/packages/generic/{name}/versions` → 200 with the version row.
- `GET …/-/packages/generic/{name}/1.0.0` → 200; the page's file link
  (`…/1.0.0/files/33`) downloads the ORIGINAL uploaded bytes (cmp clean).
- **Repo tab**: `POST /api/v1/packages/p0probe/generic/{name}/-/link/{repo}`
  → 201, then `GET /p0probe/{repo}/packages` → 200 carrying the linked
  package name. The link/unlink API is supported and the tab reflects it.

### Packages cleanup — PASS

Whole-package `DELETE /api/v1/packages/p0probe/{type}/{name}` → 204 for all
six, and the management list reads `[]` after. One nuance (parity, not a
bug): the maven package's management name is `group:artifact`
(`com.example:probe-mvn-…`), so the DELETE path needs the colon
percent-encoded (`maven/com.example%3Aprobe-mvn-…`) — a bare artifact-id
404s. R2 content keys remain as documented residue (the unreferenced-blob
sweep is the sole deleter — unchanged posture).

## Actions (control plane live; M3 trigger chain absent)

1. **Actions tab empty state — PASS.** On a fresh (auto_init, zero-workflow)
   repo, `GET /p0probe/{repo}/actions` → 200, pageClass
   `page-content repository actions`, empty state reads "There are no
   workflows yet. Don't know how to start with Gitea Actions? See the quick
   start guide." — the Quick Guide shape a user needs. (An EMPTY repo 404s
   the tab — upstream `MustBeNotEmpty` parity, previously verified in the
   act-runner smoke.)
2. **Runner registration — PASS.** The global registration token was scraped
   from the live `GET /-/admin/actions/runners` token panel (40-hex, the
   `getOrCreateActiveRunnerToken(d1, 0, "")` row — created/ensured as
   standing state by the visit; left active, which is the designed
   reusable-until-reset posture). A hand-built `RegisterRequest`
   protobuf POSTed to
   `/api/actions/runner.v1.RunnerService/Register` (`application/proto`)
   answered 200 with a decoded `{id: 1, uuid, token, name, version,
   labels}` — runner id **1**, i.e. production had no runners before this
   probe. `Ping` → 200 `Hello, prod-findings!`; `Declare` with
   `x-runner-uuid`/`x-runner-token` → 200 (the interceptor authenticates on
   production). The runner row appeared on **all four** runners pages:
   `/-/admin/actions/runners`, `/user/settings/actions/runners`,
   `/probe-org-fd/settings/actions/runners`, and
   `/p0probe/{repo}/settings/actions/runners` — this is upstream parity
   (upstream's scoped runners pages list with `WithAvailable: true`, which
   includes global runners; models/actions/runner.go:219-223). The runner
   was deleted via the admin UI route
   `POST /-/admin/actions/runners/1/delete` → 303 back to the list, and the
   admin page no longer carries the row.
3. **OIDC issuer — PASS.** `GET /api/actions/oidc/.well-known/openid-configuration`
   → 200 `application/json` with
   `issuer: https://cf-gitea.hecongw.workers.dev/api/actions/oidc`,
   coherent `jwks_uri`, `RS256`; `GET /api/actions/oidc/jwks` → 200 with one
   RSA/RS256/`sig` key (2048-bit modulus). The exact paths (under
   `/api/actions/oidc`, not site-root `/.well-known`) match
   `services/actions/routes.ts`'s mount and upstream actions.go.

Not exercised (honest scope): FetchTask/UpdateTask/UpdateLog on production
(no runnable jobs exist without M3, and seeding production D1 rows is out of
a probe's posture — the local smoke covers the wire), artifacts v1/v4, the
`/api/actions_pipeline` family, and a real act_runner binary run.

## Findings

### F-1 (informational): npm publish auth-key matching is a trailing-slash footgun

A real `npm publish` against `registry=…/api/packages/{owner}/npm` (NO
trailing slash) fails client-side with `ENEEDAUTH` for both obvious .npmrc
key shapes (`…/{owner}/npm/:_authToken` and the host-only `//host/:_authToken`).
npm 11's `nerfDart` drops the registry URL's LAST path segment when looking
up credentials, so the no-slash registry matches the key ONE segment higher
(`//host/api/packages/{owner}/:_authToken` — verified publishing
successfully), while WITH a trailing slash (`registry=…/npm/`) the
upstream-documented `…/{owner}/npm/:_authToken` key matches (also verified
publishing successfully). Both successful forms are shown in
`docs/guide/`-style material nowhere user-visible; anyone following the
canonical Gitea .npmrc snippet with a no-slash registry URL gets a
confusing client-side "need auth" that never reaches the server. Pure
npm-client behavior (upstream Gitea users hit the same), parity not a bug —
worth one line in the packages guide's npm section.

### F-2 (informational): maven management-name delete needs the encoded colon

`DELETE /api/v1/packages/{owner}/maven/{name}` requires
`group%3Aartifact` (the stored name is `group:artifact`); a bare
artifact id 404s. Upstream has the same naming, so this is parity — a
papercut only for users scripting cleanup from the LIST output (the list
renders `com.example:probe-mvn-…` ready-encoded-needing).

## Probe hygiene

Deleted and re-verified gone: the probe repo (204), the probe org (204), all
six packages (204s, list `[]`), the runner row (admin list empty, and
`action_runners` counts 0), the two per-run PAT rows (prefix-scoped D1
deletes; final table re-listed). Token material (both mint stdouts + token
files) shredded. The global runner REGISTRATION TOKEN row remains active by
design (reusable-until-reset, the standing posture the admin page maintains
on visit). Deliberately left alone — concurrent sibling-wave state under the
shared `p0probe` user: three "bootstrap" PAT rows minted within ±2 min of
this run's windows (ids 99/101/103, 08:54–08:56 +08:00), the
`p0probe/linkcrawl` repo + its `linkprobe-pkg` generic package (created
08:57:33 +08:00, after this run's window), and the standing
`p0probe/p0-shallow` fixture.
