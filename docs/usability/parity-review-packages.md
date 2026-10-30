# Parity review: package registry wire shapes — generic / pypi / helm / npm / maven / nuget (2026-10-30)

READ-ONLY parity review. Scope: `apps/worker/src/api/routes/packages-protocols.ts` +
`apps/worker/src/api/routes/packages.ts` + `apps/worker/src/services/packages/**`
against upstream at the vendored pin (`gitea/` @ fc493688):
`gitea/routers/api/packages/**`, `gitea/services/packages/**`,
`gitea/models/packages/**`, `gitea/modules/packages/**`, `gitea/services/convert/package.go`,
`gitea/modules/structs/package.go`, `gitea/modules/httplib/serve.go`.

Method: static wire-shape comparison, endpoint by endpoint — paths + methods,
per-protocol auth headers, response headers, error bodies/statuses,
pagination shapes, and version-comparison semantics. No fixes applied, no
code touched; this file is the only artifact.

Skipped per brief (known/documented elsewhere): cargo and chef registries are
absent on both comparison tracks (not implemented here, out of this review);
the npm trailing-slash publish footgun is recorded as a guide note only (§9);
the count-quota `+1` post-insert parity already landed and re-verified
(model.ts / every upload walk).

## 1. Verdict summary

| Protocol | Endpoints | Auth | Response headers | Error bodies | Listing/pagination | Version semantics | Drifts |
|---|---|---|---|---|---|---|---|
| generic | MATCH | MATCH | partial (§3) | 1 message drift | n/a | n/a | G-1..G-4 |
| pypi | MATCH | MATCH | partial (§3) | 2 drifts (P-2, P-3) | MATCH (simple index) | strings.Compare MATCH | P-1..P-5 |
| helm | MATCH | MATCH | partial (§3) | 1 body drift (H-2) | MATCH (index.yaml) | creation order MATCH | H-1..H-3 |
| npm | MATCH (all three URL shapes) | MATCH | ETag/304 MATCH | MATCH (incl. empty `{"error":""}` arms) | MATCH (30/50, total) | go-version port MATCH | N-1..N-4 |
| maven | MATCH | MATCH | MATCH (incl. HEAD no-disposition) | MATCH (all four texts) | n/a | creation order MATCH | M-1 (nit) |
| nuget | MATCH (V3 + V2 OData + symbols) | 1 carve-out drift (U-1) | partial (§3) | 1 minor drift | MATCH ($skip/$top, next link, counts) | SemVer ascending MATCH | U-1..U-3 |
| v1 management API | 1 slash-shape note | MATCH (gate stack order) | n/a | 4 message drifts (A-2) | Link/X-Total-Count MATCH | latest = SearchLatestVersions MATCH | A-1..A-4 |

No happy-path blocker was found: every read/publish flow that twine, pip,
npm, `helm push/pull`, `mvn deploy`, `dotnet nuget push/restore` and plain
`curl` issue on the success path matches upstream's status, body shape and
header spellings. The drifts below live in the edges: retry/idempotency
behavior, integrity-check strictness, chunked uploads, and error-body texts.

## 2. Top drifts, ranked by what real client tools hit

1. **D-1 (Medium, generic + pypi): re-uploading identical bytes answers 201, upstream answers 409.**
   Upstream `TryInsertFile` (models/packages/package_file.go:46-58) rejects ANY
   duplicate `(version, lower_name, composite_key)` regardless of blob, and the
   routes map `ErrDuplicatePackageFile` → 409 (generic.go:169-171, pypi.go:201-203).
   Ours treats a same-blob duplicate as the idempotent no-op → 201
   (model.ts `tryInsertFile` "identical" outcome; generic.ts:193-196 never sees it;
   pypi.ts:666-669 maps only "conflict"). A CI script that pushes twice and
   branches on 409, or twine re-uploading a filename (its standard
   "already exists" signal), sees success here and conflict upstream. maven
   (maven.ts:1075-1077) and nuget symbol packages (nuget.ts:2075-2079) DO
   409 duplicates regardless of bytes — parity holds there.
2. **D-2 (Medium, all six families): uploads without `Content-Length` are rejected 411; upstream streams them.**
   Go reads chunked request bodies transparently (`ctx.UploadStream`,
   `FormFile`, `http.MaxBytesReader`); no upstream handler has a
   Content-Length precondition. Ours requires a valid declared length on
   every upload arm and answers `411 "Content-Length header is required"`
   (packages-protocols.ts:460-463/652-655/819-822/862-865/1480-1481;
   routes/packages.ts:933-936). Real client: `curl -T - file.whl`,
   `curl --data-binary @-` (chunked) → 411 here, 201 upstream. twine/npm/mvn/
   dotnet/helm all send Content-Length, so the common paths are unaffected.
3. **D-3 (Medium, pypi): a missing `sha256_digest` field publishes instead of 400.**
   Upstream compares `FormValue("sha256_digest")` (empty string when the field
   is absent) against the streamed hash with `strings.EqualFold` and 400s
   "hash mismatch" on any inequality (pypi.go:121-123) — an upload without the
   digest field cannot succeed. Ours skips the check when the field is absent
   (pypi.ts:594-597: `declaredDigest !== undefined && …`), so a digest-less
   uploader gets 201 where upstream 400s, and the integrity gate is bypassed.
   twine always sends the field; hand-rolled uploaders may not.
4. **D-4 (Medium, nuget): the service-index endpoints require read access; upstream deliberately leaves them unauthenticated.**
   Upstream registers `GET /`, `/index.json`, `/$metadata` in a subgroup with
   an explicit comment "Needs to be unauthenticated for the NuGet client"
   (api.go:342-346 — outside the `reqPackageAccess(read)` wrap). Ours runs
   `protocolContext(c, "read")` on all three (packages-protocols.ts:909-950),
   so an anonymous/insufficient client gets 401 + `WWW-Authenticate` where
   upstream 200s the index. NuGet clients retry with credentials on 401, so
   push/restore usually self-heals; the drift shows for clients that read the
   index before authenticating and give up.
5. **D-5 (Low, cross-family): quota 403 body texts differ from upstream's three sentinel strings.**
   Upstream: "maximum allowed package count exceeded" /
   "maximum allowed package type size exceeded" / "maximum allowed package
   storage quota exceeded" (services/packages/packages.go:31-35). Ours:
   "package quota count limit exceeded" / "package quota type size limit
   exceeded" / "package quota total size limit exceeded" (model.ts:686-707).
   Statuses (403) and the arms are correct; only the message text differs,
   visible in pypi/maven plain-text bodies and npm/helm/nuget `{"error"…}`/
   `{"Message"…}` bodies.
6. **D-6 (Low, all file downloads): upstream's ServeContent header set is a superset of ours.**
   See §3. The visible-to-clients pieces: no `Cache-Control`, no
   `Accept-Ranges`/206 (resumable `curl -C -`), no 304 on `If-Modified-Since`,
   non-ASCII filenames lose the RFC 5987 `filename*` twin. Content-Type
   defaults and the maven per-extension types match.

## 3. Response headers on file downloads (shared by every protocol)

Upstream `helper.ServePackageFile` → `ctx.ServeContent`
(httplib/serve.go:77-95, services/context/base.go:186-190) sets, per download:

| Header | Upstream | Ours (fileResponse / serveDownload) |
|---|---|---|
| Content-Type | `application/octet-stream` default (serve.go:60); maven overrides `.jar`→`application/java-archive`, `.pom`→`text/xml` (maven.go:209-214) | MATCH, incl. the maven overrides (maven.ts:1139-1148) |
| Content-Length | set | MATCH |
| Content-Disposition | `attachment; filename="X"`, plus `; filename*=utf-8''…` for non-ASCII (content_disposition.go:47-67) | `attachment; filename="X"` with `["\` → `_`; no `filename*` twin (LOW) |
| Last-Modified | file created time, http.TimeFormat | MATCH (`toUTCString`) |
| Cache-Control | `max-age=0, private, must-revalidate` in prod (httpcache.go:23-38) | MISSING (LOW) |
| X-Content-Type-Options | `nosniff` (serve.go:61) | MISSING (LOW) |
| Content-Security-Policy | `sandbox allow-scripts …` (serve.go:64-74) | MISSING (LOW) |
| Access-Control-Expose-Headers | `Content-Disposition` (serve.go:91-94) | MISSING (LOW) |
| Accept-Ranges / 206 / If-Range / If-Modified-Since→304 | `http.ServeContent` semantics | MISSING — full-body 200 always (LOW; breaks ranged/resumable clients and validator caching) |
| ETag | none on files; npm metadata only | MATCH (see §7) |

## 4. Generic (`/api/packages/{username}/generic/...`)

Endpoints (upstream api.go:318-335): `DELETE /{name}/{version}`,
`HEAD|GET /{name}/{version}/{filename}`, `PUT /{name}/{version}/{filename}`,
`DELETE /{name}/{version}/{filename}` — all MATCH
(routes/packages.ts:1006-1010). Auth `reqPackageAccess(read|write)` MATCH.
Validation order and texts (name → filename → version; generic.go:69-86) MATCH
(generic.ts:59-78, routes/packages.ts:924-932). Statuses 201/204/409/404 MATCH
modulo D-1.

| # | Drift | Severity | Upstream cite |
|---|---|---|---|
| G-1 | Identical-bytes re-upload → 201 (ours) vs 409 `package file already exists` (upstream) | Medium | package_file.go:46-58; generic.go:169-171 |
| G-2 | Missing `Content-Length` → 411 (ours); upstream accepts chunked | Medium | no such arm (generic.go:87+ streams) |
| G-3 | Download 404 text is always `package file does not exist`; upstream answers `package does not exist` for a missing VERSION and `package file does not exist` for a missing FILE | Low | generic.go:109-112 + helper.PackageErrorStatus (helper.go:19-24); packages.go:605-614 |
| G-4 | Download-file delete 404: same conflation as G-3 (version-missing arm) | Low | generic.go:180-190 |

## 5. PyPI (`/api/packages/{username}/pypi/...`)

Endpoints (api.go:417-421): `POST /` (upload — ours registers both the
upstream slashed and bare shapes), `GET /files/{id}/{version}/{filename}`,
`GET /simple/{id}` — MATCH. Plain-text error bodies (pypi.go:41-44) MATCH.
Simple index: PEP 503 anchors, `#sha256=` fragment, conditional
`data-requires-python`, versions sorted by raw version string ascending
(pypi.go:67-69 `strings.Compare`) — MATCH (pypi.ts:759-854), modulo a
whitespace nit (P-5). Name normalizer (`.`/`_` → `-`) and the PEP 426/440
matchers port verbatim (pypi.go:25-39 → pypi.ts:70-84). project_urls
homepage-label normalization ports (pypi.go:212-225 → pypi.ts:91-105).

| # | Drift | Severity | Upstream cite |
|---|---|---|---|
| P-1 | Missing `sha256_digest` → 201 publish (ours) vs 400 `hash mismatch` (upstream — empty FormValue never EqualFolds the hash) | Medium | pypi.go:121-123 |
| P-2 | Missing/empty `content` part → 400 `the content file field is missing` (ours) vs Go's `FormFile` error text (`http: no such file`) | Low | pypi.go:106-110 |
| P-3 | Malformed-multipart error texts are ours ("multipart boundary not found", scan-cap texts) where Go's mime messages would appear | Low | pypi.go:106-110 |
| P-4 | Download 404 conflation (version arm should read `package does not exist`) | Low | pypi.go:96-98 + packages.go:605-614 |
| P-5 | Simple-index tail renders `\n\t` where the template's range leaves `\n\t\t` before `</body>` (whitespace-only; pip parses anchors) | Nit | templates/api/packages/pypi/simple.tmpl |

## 6. Helm (`/api/packages/{username}/helm/...`)

Endpoints (api.go:330-335): `GET /index.yaml`, `GET /{filename}`,
`POST /api/charts`, `POST /api/prov` — MATCH, index.yaml winning over the
param route. `index.yaml` served as `text/plain; charset=utf-8` (Go's
sniffer on a headerless stream) — MATCH. Index document: `apiVersion: v1`,
entries keyed by chart name (go-yaml sorted map keys), metadata inline in
yaml-field order, `urls` = base + PathEscape'd canonical filename,
`created`, `generated`, `serverInfo.contextPath` — MATCH (helm.go:40-96 →
helm.ts:796-894; the URL base uses PathEscape/encodeURIComponent
equivalents). Chart/prov uploads: ErrInvalidArgument arms → 400 with the four
sentinel texts, prov's `ErrPackageNotExist` → 404, `OverwriteExisting`
(re-publish replaces the file row, same-blob short-circuits) — MATCH
(helm.go:142-276 → helm.ts:591-784). Download: filename-only search requiring
EXACTLY one version (the route passes only `{filename}`; the Name filter value
is empty and skipped — helm.go:100-119) — MATCH (helm.ts:914-955).

| # | Drift | Severity | Upstream cite |
|---|---|---|---|
| H-1 | Missing `Content-Length` → 411 (ours; upstream `UploadStream` streams chunked) | Medium (shared D-2) | helm.go:148-152 (no such arm) |
| H-2 | Ambiguous/zero filename match → 404 `{"error":"package file does not exist"}` (ours) vs `{"error":""}` (upstream `apiError(404, nil)` — empty message) | Low | helm.go:116-119 |
| H-3 | `generated`/`created` render ISO-millis UTC; Go renders RFC3339Nano (documented divergence class) | Nit | helm.go:82-93 |

## 7. npm (`/api/packages/{username}/npm/...`)

Routing: upstream's chi PathGroup + `UseUnescapedPath` with the
`(@scope/)?name` id pattern (api.go:382-400, the NPM-ROUTE-PATH-PATTERN hint)
is re-implemented as the `/:username/npm/*` wildcard + `parseNpmTarget`
grammar; all three documented URL shapes (`@scope/core`, `@angular%2Fcore`,
`%40angular%2Fcore`) decode to the same target, invalid URL names 404 at
routing like chi's embedded regex — MATCH. Endpoint inventory (search, ping,
whoami, packument GET/PUT, version metadata GET, both download shapes with
the version segment ignored, dist-tags GET/PUT/DELETE, `-rev` DELETE/PUT
preview, unpublish by tarball and by package) — MATCH.

Wire shapes verified field-by-field against
routers/api/packages/npm/api.go + modules/packages/npm/creator.go:

- Packument: versions keyed by the NORMALIZED semver string, ascending
  `SemVer.LessThan` sort (api.go:21-23), dist-tags from `npm.tag` properties
  with the highest-non-prerelease `latest` fallback (api.go:51-60), `time`
  with derived `created`/`modified` (api.go:47-49), top-level field order and
  omitempty set (creator.go:59-75) — MATCH (npm.ts:1745-1844).
- Version objects: struct field order, `_hasShrinkwrap`/`hasInstallScript`
  spellings, `dist.integrity` = `sha512-` + base64(sha512 hex→bytes),
  `dist.shasum` = sha1 hex, `dist.tarball` = stored `gitea_tarball_path` or
  the 1.27 fallback (api.go:81-125) — MATCH (npm.ts:1655-1712). (Upstream
  never sets the version-level `Readme`, so our omission is parity, not
  drift.)
- ETag: `W/"<sha256-hex>"` over the deterministic body (npm.go:87-95),
  `If-None-Match` weak match → 304 with the ETag echoed — MATCH
  (packages-protocols.ts:1350-1371).
- dist-tags CRUD: 4 KiB bounded quoted-version body, `The tag name is
  invalid` (capital T), tag-parses-as-version rejection, delete falls to the
  newest version, unset-`latest` list falls back to the packument's dist-tags
  (npm.go:377-509) — MATCH (npm.ts:1922-2009).
- Publish: name/semver/attachment/integrity sentinel texts, sha1/sha512
  integrity verification, single-attachment fallback for provenance bundles,
  tarball scan flags, repo-link permission 403 `no permission to upload this
  package`, duplicate version → 409 `package version already exists`, deprecate
  arm (`no versions` → 400, per-version metadata patch) — MATCH
  (creator.go:265-486, npm.go:178-335 → npm.ts:1277-1500).
- Errors: `{"error": message}` JSON; the not-found arms upstream answers with
  `apiError(404, nil)` render `{"error":""}` — MATCH (packages-protocols.ts:1469,
  1497, 1535, 1542).
- Search `/-/v1/search`: absolute skip/take (30/50 caps), `total` = latest-
  versions-per-package count, object shape (`scope`/`unscoped`, `publisher`,
  empty `maintainers`, `links.npm`) — MATCH (npm.go:523-551, api.go:127-160 →
  npm.ts:2025-2106).

| # | Drift | Severity | Upstream cite |
|---|---|---|---|
| N-1 | Missing `Content-Length` on publish → 411 (ours); upstream MaxBytesReader streams | Medium (shared D-2) | npm.go:180-183 |
| N-2 | Publish document cap 64 MiB (ours) vs upstream 256 MiB MaxBytesReader — 413 `http: request body too large` text matches | Low (documented divergence) | npm.go:180 |
| N-3 | dist-tag PUT body is read in full BEFORE the 4 KiB bound (ours); upstream bounds the read itself (`io.LimitReader`, npm.go:411-419) | Nit (efficiency, not wire) | npm.go:408-419 |
| N-4 | Search/packument timestamps render UTC `Z`; upstream renders the server-local offset (documented class) | Nit | api.go:33/142 |

Guide note (per brief, not a drift row): the trailing-slash publish footgun
(`npm publish --registry …/api/packages/{owner}/npm` with a slash-terminated
config value) remains a client-configuration hazard; document it in the
registry setup guide rather than in code.

## 8. Maven (`/api/packages/{username}/maven/...`)

The strongest parity in the set. Endpoints `PUT|GET|HEAD /*` (api.go:336-340)
MATCH with the wildcard decode matching chi's decoded-path behavior
(maven.ts:196-205). Path-parameter grammar incl. `maven-metadata.xml[.md5/.sha1/
.sha256/.sha512]`, `-SNAPSHOT` consumption, illegal-characters regex
`[\\/:"<>|?*]` → 400 `request parameters are invalid` — MATCH (maven.go:424-490 →
maven.ts:110-205). Metadata serve: legacy+current name union, creation-order
sort, `latest`/`release` (release omitted when all-SNAPSHOT), checksums
computed over `xml.Header`+body, `Last-Modified` from the newest-created
version, Content-Length+`text/xml` — MATCH (maven.go:82-150 → maven.ts:727-800,
routes/packages.ts:758-776). File serve: checksum GETs answer the stored hash
as plain text, HEAD sets headers WITHOUT Content-Disposition (maven.go:216-219)
while GET adds it, `.jar`/`.pom` content types — MATCH (routes/packages.ts:786-808).
Upload: artifact-level metadata PUT → 200 no-op, `use_legacy_package_name`
ParseBool, legacy package rename to `group:artifact`, checksum PUTs verify
against stored columns (never stored; ≤129 bytes else 413 `checksum is too
large`; mismatch 400 `hash mismatch`; match 200), pom parse 400, pom metadata
lands on create AND re-publish, duplicate non-meta file → 409 REGARDLESS of
bytes (maven.ts:1075-1077) — MATCH (maven.go:238-414).

| # | Drift | Severity | Upstream cite |
|---|---|---|---|
| M-1 | Upload serializes via the D1 UNIQUE where upstream takes a `globallock` per package name (same outcomes, different contention behavior) | Nit | maven.go:256-262 |

## 9. NuGet (`/api/packages/{username}/nuget/...`)

V3 JSON family — `GET /index.json` (nine resources in order, version 3.0.0),
`GET /query` (skip/take 30/50, `totalHits` = package count, grouped results
with case-insensitive collation sort, per-version `downloads: 0` as upstream's
never-set field), `GET /registration/{id}/index.json` (single page, SemVer
ascending, `lower`/`upper`), `GET /registration/{id}/{version}[.json]` (leaf,
`.json` suffix trimmed), `GET /package/{id}/index.json` (enumerate; empty →
404 `{"Message":""}`), `GET /package/{id}/{version}/{filename}` (any file;
lead-file GET counter bump), `PUT /` (publish; normalized version —
`1.04.5.2-rc.1+meta` stores as `1.4.5.2-rc.1`; nupkg lead + original nuspec
files; duplicate version 409 wins over quota), `PUT /symbolpackage`,
`DELETE /{id}/{version}` → 204/404 — MATCH against nuget.go + api_v3.go +
links.go (nuget.ts:1395-1782, routes/packages.ts:885-1063).

V2 OData family — `GET /` service index, `GET /$metadata` (static Edmx,
rendered with Go's no-self-closing posture and struct-order attributes),
`GET /Packages(Id='…',Version='…')` entry (namespaced, self-closing
`<content/>` innerxml workaround preserved), `GET /Packages()` + `/Search()`
(latest-versions feed, `$skip`/`$top`, next link when the page filled, query
keys sorted + QueryEscaped), `GET /FindPackagesById()`, the three `/$count`
arms as plain text, `getSearchTerm` quote-trimming + OData `$filter`
extraction with the ` eq '` exact rule — MATCH against api_v2.go +
nuget.go:93-188 (nuget.ts:1431-1803, routes/packages.ts:1098-1214).

Symbols — `GET /symbols/{filename}/{guid}/{filename2}`: the chi guid regex
`[0-9a-fA-F]{32}[fF]{8}` gate, filename mismatch → 400 empty body, exactly-one
file-property hit, `nuget.symbol.id` property — MATCH (nuget.go:637-671 →
nuget.ts:2166-2228).

Auth: `X-NuGet-ApiKey` fallback with Authorization-wins (nuget/auth.go:23-26 →
packages-protocols.ts:199-215) — MATCH.

| # | Drift | Severity | Upstream cite |
|---|---|---|---|
| U-1 | `GET /`, `/index.json`, `/$metadata` require read access (ours); upstream leaves them unauthenticated by design | Medium | api.go:342-346 ("Needs to be unauthenticated for the NuGet client") |
| U-2 | Download 404 conflation: file-missing arm should read `package file does not exist`; ours answers `package does not exist` for every miss | Low | packages.go:605-614 + helper.go:19-24 |
| U-3 | `FindPackagesById()` next link omits `id=` when the request's id was empty; upstream always sets it | Nit | nuget.go:338-347 vs routes/packages.ts:1157-1169 |

Verified non-drift (checked because it looked like one): the V2 leaf's
handling of percent-encoded quotes. chi v5.4.0's `routeHTTP` prefers
`r.URL.RawPath` (the ESCAPED path) when set and only falls back to the decoded
`URL.Path` otherwise, so upstream matches the `Packages(Id='{id:[^']+}',…)`
pattern against the raw path too — a `%27`-quoted URL fails the literal-quote
pattern upstream exactly as it fails ours (raw-quote requests: both 200).
Our route's raw-path re-pin (packages-protocols.ts:1104-1130) is behaviorally
identical.

Upload cap 64 MiB with a 413 arm upstream lacks is the documented divergence
(nuget.ts:60-70); dependency-group map order is deterministic where upstream
iterates a Go map — both pre-documented.

## 10. Management API (`/api/v1/packages/...` + `GET /api/v1/admin/packages`)

The nine ops + admin list (upstream api.go:1695-1714, 1820) all register with
matching methods and statuses. Gate stack order matches upstream:
PACKAGES_ENABLED=false → 404; reqToken 401 `token is required`;
tokenRequiresScopes 403 with the exact upstream message;
UserAssignment/owner masking 404s; reqPackageAccess 401 +
`WWW-Authenticate: Basic realm="Gitea Package API"` (routes/packages.ts:244-282).
Field parity against structs/package.go + convert/package.go: `id` = the
VERSION id, `owner`/`repository` (view-gated)/`creator`/`type`/`name`/
`version`/`created_at` — MATCH; `html_url` = `/{owner}/-/packages/{type}/
{lower_name}/{lower_version}` — MATCH (descriptor.go:95-102 →
routes/packages.ts:343). `PackageFile` carries the four hashes with `md5: ""`
(the documented NULL-md5 divergence). Listing: `type`/`q` filters (q is the
partial match upstream uses), page/limit with Link + X-Total-Count headers,
`GET /-/latest` = SearchLatestVersions first row — MATCH.

| # | Drift | Severity | Upstream cite |
|---|---|---|---|
| A-1 | `GET /packages/{owner}/{type}/{name}` registers WITHOUT the trailing slash (ours) vs upstream's `m.Get("/")` WITH it — swagger-shaped clients (no slash) work here and 404 upstream; slash clients the reverse | Low (ours = the swagger shape) | api.go:1699 |
| A-2 | link/unlink error bodies differ: upstream 400 `invalid argument` (already/not linked) and 403 `permission denied`; ours uses longer custom texts (`package has already been linked to a repository`, `user does not have granted access to the repository/package`) | Low | package_update.go:15-43 (bare `util.ErrInvalidArgument`/`ErrPermissionDenied` sentinels, util/error.go:25-28); package.go handlers print `err.Error()` |
| A-3 | `creator` renders `null` for creator_id 0; upstream loads the row and would internal-error (documented divergence) | Low | convert/package.go:41 |
| A-4 | Repo-not-found 404 text omits upstream's bracketed detail suffix (`repository does not exist [id: 0, …]`) | Nit | repo.go:763-773 |

## 11. Cross-family notes (not per-protocol drifts)

- **Version-comparison semantics** (mission item): the six protocols split
  exactly as upstream — npm and nuget use the hashicorp/go-version port
  (`parseGoVersion`/`parseGoSemver`, canonical re-render, segment-padding
  Compare with prerelease precedence — npm.ts:190-313) for publish validation
  (NewSemver), packument/registration ordering (LessThan) and
  tag-vs-version probing (NewVersion); pypi sorts the simple index by the raw
  version string (strings.Compare); maven and helm order by creation
  timestamp. No drift found.
- **Error-body spellings per family** (mission item): pypi/maven/generic
  plain text; helm/npm `{"error": …}` JSON; nuget `{"Message": …}` JSON with
  500s stripped to `internal server error` (helper.go:28-48) — all MATCH.
- **Basic-auth credential model**: ours resolves tokens only (username,
  `x-oauth-basic`, or password-as-token — httpauth.ts:79-82); upstream's
  `auth.Basic` also accepts the account password. Platform-wide, documented
  auth-model seam — affects all six protocols equally.
- **Content-Type of error responses**: ours `text/plain;charset=utf-8` /
  `application/json` vs Go's `text/plain; charset=utf-8` (space) — byte-level
  difference in the header value only; no client tool parses it.
- Upstream's serve-direct (`ShouldServeDirect` → 302 redirect to storage,
  packages.go:654-659) has no analogue here — ours always streams from R2;
  wire-identical to upstream's local-store posture.

## 12. Suggested fix order (for the next implementation wave — not applied)

1. D-1: drop the "identical" no-op for generic/pypi (answer 409 like maven does).
2. D-3: make a missing/empty `sha256_digest` fail `hash mismatch` (pypi).
3. D-4: lift the three nuget service-index arms out of the read gate.
4. D-5: swap the three quota message strings to upstream's texts.
5. G-3/P-4/U-3/A-2: message-text passes (mechanical).
6. D-6: add `Cache-Control`, `X-Content-Type-Options: nosniff`,
   `Accept-Ranges` decision, and the `filename*` disposition twin to the
   shared file-response helper in one move.
