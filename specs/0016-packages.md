# SPEC-0016: The package registry — owner-scoped package model, the generic registry protocol, and the R04/R16 prerequisites

Status: **accepted** (ratified 2026-10-29, orchestrator — decisions at §8) ·
Date: 2026-10-29 · Un-defers the UI gap census's two (c) FEATURE-GATED
package rows
([docs/compat/ui-gap-census-2026-10-29.md](../docs/compat/ui-gap-census-2026-10-29.md):
R04 `GET /{username}/-/packages[/...]` and R16 `GET .../packages`) plus the
API inventory's FEATURE-ABSENT package class
([docs/compat/api-remaining-inventory.md](../docs/compat/api-remaining-inventory.md):
9 `/packages/*` ops + `GET /admin/packages` — the census's "package registry
10 ops, all FEATURE-ABSENT, no D1 tables"). Depends on: SPEC-0002 (auth — the
`package` scope category already in the token grammar), SPEC-0004 (the
`/api/v1` router + the zod-openapi conventions), SPEC-0005 §3.3 (the
release-asset upload discipline: Content-Length required, 512 MiB cap,
single-pass streaming), SPEC-0006 (the R2 key-namespace + bare-rows-in-D1
conventions), SPEC-0007 (org teams — the org packages access mode), SPEC-0014
§3 (the cron-producer → queue-consumer idiom the cleanup arm rides).

Owns: the D1 package model (§4), the package storage service over the shared
REPO_PACKS bucket, the **generic** registry protocol (v1), the 9 management
API ops + the admin list, the quota checks, and the cleanup consumer arm.
The per-ecosystem protocols beyond generic (npm/pypi/container/…) are
scoped-but-NOT-BUILT — each lands as its own milestone with its own size
(§7); the R04/R16 UI pages are DOWNSTREAM of this SPEC and own their own
routes/pages (§1 out-of-scope, the census's "the UI pages are downstream of
their APIs").

Upstream findings are against the vendored submodule (`gitea/`, READ-ONLY,
pin `fc4936884584` — v1.22.0-rc1-3919-gfc493688). Every `web.go:N` cite is
`gitea/routers/web/web.go` at that pin; `api.go:N` cites are
`gitea/routers/api/packages/api.go`; our-substrate findings are against
`apps/worker/src/**` and `apps/worker/wrangler.jsonc.example` as of
2026-10-29.

---

## 1. Problem and scope

The census classifies the whole package family (c) FEATURE-GATED — "the
package registry has no SPEC and needs its own gate first" (census §"(c)
FEATURE-GATED"). This document is that gate. Upstream's package subsystem is
not one feature but two stacked ones:

1. **A package model + blob store** — owner-scoped (user OR org), repo-linked
   (optional), with content-addressed deduplicated blobs. Every registry type
   and every UI page rides this.
2. **Per-ecosystem registry protocols** — 22 protocol families on
   `/api/packages/{username}/…` (`api.go:91` `CommonRoutes` — the full
   route-group census: alpine, arch, cargo, chef, composer, conan, **conda**,
   cran, debian, go, generic, helm, maven, nuget, npm, pub, pypi, rpm,
   rubygems, swift, **terraform**, vagrant; the earlier "21" missed two
   groups in its own tally — the adjudication note at the terraform as-built)
   plus the OCI distribution API on `/v2/…` (`api.go:509` `ContainerRoutes`)
   — TWENTY-THREE protocol surfaces at the pin. Each is a
   wire contract a real package-manager client speaks (`npm publish`,
   `pip install`, `docker push`, …), and their weights differ by an order of
   magnitude (pypi ≈ 230 lines upstream; nuget ≈ 700; the container family
   ≈ 2,000 + a JWT token flow).

A v1 that serves rows R04/R16 honestly needs (1) in full and (2) exactly one
representative protocol — **generic** — which needs no client-specific wire
format (plain PUT/GET of a file at a path), leaving every other ecosystem a
milestone-sized follow-up.

In scope: the D1 model (§4), the R2 key namespace + storage service (§4.2),
the generic registry protocol + the 9 management ops + admin list (§3), the
quota checks (§3.4), the cleanup arm (§4.4), and the tests (§6).

Out of scope (each named so it is not silently re-decided):

- **Every non-generic registry protocol** — npm/pypi/container/maven/nuget/
  helm/debian/alpine/rpm/arch/cargo/conan/composer/chef/conda/cran/go/pub/
  rubygems/swift/terraform/vagrant. §2.1 sizes each; §7 stages them. The
  MODEL makes them possible; none is IMPLEMENTED here.
- **The R04/R16 UI pages themselves** (`user/overview/packages*.tsx`-family +
  the repo packages tab) and the user/org settings + admin packages pages —
  downstream wave, unlocked the moment M1 lands (the census's own split:
  "the UI pages are downstream of their APIs … then `pages/*-packages*.tsx`").
- **The container token-auth flow** (JWT mint/verify,
  `gitea/services/packages/auth.go:31`), chunked blob uploads
  (`gitea/services/packages/container/blob_uploader.go:26`) and manifests —
  M5's subject, not v1's.
- **Cargo's git-backed index repo** (`_cargo-index`,
  `gitea/services/packages/cargo/index.go:29` — a real repository whose
  files commit through the files service) — the heaviest single ecosystem;
  own SPEC-attached milestone. *(Landed 2026-11-01 as the rowless engine
  cell — see the mirror as-built below; the carve-out is closed.)*
- **Repository signing keys** (alpine/debian/rpm `GetRepositoryKey` arms, the
  chef keypair, `DefaultRPMSignEnabled`,
  `gitea/modules/setting/packages.go:42`) — no signing key exists in our
  substrate; the index-builder milestones will propose their posture.

## 2. The subsystem — upstream cites, our substrate, the gap

### 2.1 The registry-type census: 23 model types, 22 CommonRoutes protocol families, 1 container API

The model's type list is 23 constants (`gitea/models/packages/package.go:33-53`:
`TypeAlpine … TypeVagrant`, the `TypeList` at `:55-77`). The protocol surface
is two routers (`api.go`):

- **`CommonRoutes()`** (`api.go:91`) mounted on `/api/packages` (NOT
  `/api/v1` — the file's comment: "These are mounted on `/api/packages` (not
  `/api/v1/packages`)"): 22 ecosystem groups (the census correction —
  conda `api.go:263` and terraform `api.go:466-476` route too; the "21" was
  this document's own tally miss, caught at the 2026-11-01 conda+terraform
  adjudication), each wrapped in
  `reqPackageAccess(perm.AccessModeRead)` with write arms inside
  (`reqPackageAccess(perm.AccessModeWrite)`), over auth methods
  `{OAuth2, Basic, nuget.Auth, Auth, chef.Auth}` (`api.go:97-102`). The
  v1-management group's note in `routers/api/v1/api.go:1695` says it
  plainly: "these are Gitea package management API - see
  packages.CommonRoutes and packages.DockerContainerRoutes for endpoints
  that implement package manager APIs".
- **`ContainerRoutes()`** (`api.go:509`) mounted on `/v2/` (the OCI
  distribution spec): token auth (`/token` → `container.Authenticate`,
  `api.go:530`), catalog, and the per-image blobs/uploads + manifests
  groups (`api.go:536-557`), over `{Basic, Auth{AllowGhostUser}}`
  (`api.go:512-515` — "container auth requires token, so container.
  Authenticate issues a Ghost user token for anonymous access").

Per-ecosystem weight (verified upstream line counts at the pin, handlers +
wire-format module):

| family | upstream size (router + module) | protocol shape | storage-side? | v1 |
|---|---|---|---|---|
| generic (`api.go:318-335`) | 202 ln | PUT/GET/HEAD/DELETE file per `{packagename}/{packageversion}/{filename}` | plain CRUD over the model | **M1** |
| pypi (`api.go:417-421`) | 244 ln | POST `/` upload (multipart), GET `/simple/{id}` HTML index, GET `/files/...` | small index render | M2 |
| helm (`api.go:337-341`) | 284 ln | POST `/api/charts`, GET `/index.yaml` (generated chart index) | small index render | M2 |
| npm (`api.go:378-414`) | 1,236 ln (npm.go 551 + creator 486 + api.go 160 + metadata 39) | scoped-name PUT (metadata+tarball multipart), dist-tags CRUD, tarball GET | yes — metadata properties + tags | M3 |
| maven (`api.go:343-346`) | 490 ln | PUT/GET/HEAD `/*` path-group (layout-served artifacts) | path-group + maven-metadata.xml generation | M4 |
| nuget (`api.go:348-378`) | 698 ln | V2 OData + V3 JSON service index, registration, symbols | yes — the largest single-ecosystem wire | M4 |
| container (`api.go:509-547`) | ≈2,000 ln (routers 1,459: container 796 + blob 195 + manifest 416 + errors 52; plus services 314 + the wire module 204) | OCI: token → blob POST/PATCH/PUT chunked uploads, manifests | yes — JWT flow + upload state + digests | M5 |
| debian / alpine / rpm / arch | each 300-600 ln | repo metadata index BUILDERS (`Packages`/`Release`/`APKINDEX`/`repodata`/`.repo` files) regenerated on upload/delete (`gitea/services/packages/cleanup/cleanup.go:115-145` rebuild arms) | yes — index files | M6 |
| cargo (`api.go:156-172`) | ~600 ln + index.go | sparse index: `config.json` + `1|2|3/{name}` version lists derived on read (upstream's HTTP face builds them from the DB per request, cargo.go:66-87 → index.go:139-183); the **git repo** (`_cargo-index`, index.go:29) is the traditional git-protocol mirror — **LANDED** as the rowless engine cell (the 2026-11-01 as-built below; the git-URL face itself stays a gate-family gap) | yes — D1-derived; the git mirror maintained | **M7 LANDED incl. the mirror** (see both cargo as-builts) |
| conan / composer / chef / conda / cran / go / pub / rubygems / swift / terraform / vagrant | each 150-700 ln | per-client wire contracts | protocol-only | long tail, demand-driven — RESOLVED per family at the 2026-11-01 adjudication: terraform **LANDED** (the as-built at the tail), conda **LANDED** (2026-11-01 — the three walls RESOLVED: the bz2 decoder adopted, the `.conda`/zstd reduction recorded, the repodata-encoder reduction reopened and ADOPTED the same day; the as-built at the tail supersedes this row's earlier STAGED state) |

Verdict: the MODEL is the one shared prerequisite; the protocols are a
staged family. Only **generic** is "plain UI/API CRUD"-sized — every other
ecosystem needs STORAGE-side protocol endpoints (index renders, multipart
parsers, upload-state machines), which is exactly why the census gated the
whole family on a SPEC.

### 2.2 The data model (`gitea/models/packages/`)

Six tables; owner scoping is on the package row; dedup is content-addressed:

- **`Package`** (`package.go:191-199`): `ID`, `OwnerID` +
  `Type` + `LowerName` sharing `UNIQUE(s)` (one package per owner/type/lower
  name — `TryInsertPackage` checks `owner_id/type/lower_name`,
  `package.go:203-213`), `RepoID` (INDEX — the optional repo link), `Name`,
  `SemverCompatible`, `IsInternal`. NOT NULL everywhere that matters; the
  duplicate error is `ErrDuplicatePackage` (`package.go:20-23`).
- **`PackageVersion`** (`package_version.go:27-36`): `ID`, `PackageID` +
  `LowerVersion` sharing `UNIQUE(s)` (one version row per package+lowercased
  version — `GetOrInsertVersion` answers the existing row with
  `ErrDuplicatePackageVersion`, `package_version.go:48-67`), `CreatorID`,
  `Version`, `CreatedUnix` (INDEX), `IsInternal`, `MetadataJSON` (LONGTEXT —
  the per-ecosystem metadata blob), `DownloadCount`. The semver flag lives on
  the package; `IsPrerelease` is a substring test
  (`package_version.go:40-44`).
- **`PackageBlob`** (`package_blob.go:30-39`): `ID`, `Size`, and FOUR hash
  columns each `UNIQUE`-indexed (`HashMD5` char(32), `HashSHA1` char(40),
  `HashSHA256` char(64), `HashSHA512` char(128)) + `CreatedUnix`. Dedup is
  `GetOrInsertBlob`: lookup by `size+all four hashes`, existing row returned
  with `exists=true` (`package_blob.go:52-77`).
- **`PackageFile`** (`package_file.go:34-43`): `ID`, `VersionID` +
  `LowerName` + `CompositeKey` sharing `UNIQUE(s)` (a file's identity inside
  a version; `CompositeKey` is the maven/conan-style disambiguator,
  `EmptyFileKey = ""` at `package_file.go:31`), `BlobID` (INDEX), `Name`,
  `IsLead`, `CreatedUnix`. `TryInsertFile` answers
  `ErrDuplicatePackageFile` (`package_file.go:46-58`).
- **`PackageProperty`** (`package_property.go:31-37`): `ID`, `RefType`
  (0=version / 1=file / 2=package, `package_property.go:22-27`), `RefID`,
  `Name` (INDEX), `Value` (LONGTEXT). This is the per-ecosystem extension
  seam: npm dist-tags, container digests/repo names
  (`routers/api/packages/container/blob.go:111` inserts a
  `PropertyTypePackage` `PropertyRepository`; `:154` a `PropertyTypeFile`
  `PropertyDigest`), alpine branch/architecture fields — all properties, no
  per-type tables.
- **`PackageCleanupRule`** (`package_cleanup_rule.go:25-40`): per-owner
  (`OwnerID` + `Type` in `UNIQUE(s)`, 0 = user-level default), `Enabled`,
  `KeepCount`, `KeepPattern`/`RemovePattern` (regex, compiled case-
  insensitively anchored `(?i)\A…\z`, `package_cleanup_rule.go:41-54`),
  `RemoveDays`, `MatchFullName`.

The descriptor aggregation (`models/packages/descriptor.go:56-77`) is the
read shape every UI/API consumer renders: `PackageDescriptor{Package, Owner,
Repository, Version, SemVer, Creator, PackageProperties, VersionProperties,
Metadata, Files[]}` with `PackageFileDescriptor{File, Blob, Properties}`.

The list queries the UI rows actually need: **latest-version-per-package** is
`SearchLatestVersions` (`package_version.go:320-330`) — a `MAX(id) GROUP BY
package_id` subquery over the joined `package`/`package_version` pair — and
the repo tab adds `RepoID` to the filter (`routers/web/repo/packages.go:24-33`);
`HasRepositoryPackages` is `package.go:355`.

### 2.3 Blob storage: one content store, sharded sha256 keys

`gitea/modules/packages/content_store.go`: `ContentStore` wraps ONE
`storage.ObjectStorage` (`setting.Packages.Storage`,
`content_store.go:22-32` — `NewContentStore` reads `storage.Packages`).
Keys are the sha256 hex with a 2/2 prefix shard — `KeyToRelativePath`
converts `aabb000000…` to `aa/bb/aabb000000…` (`content_store.go:69-71`) —
and the container registry rides the SAME store (blob.go:41 instantiates the
plain `packages_module.NewContentStore()`; manifest creation also stores
through it, manifest.go:109/379). The settings block
(`gitea/modules/setting/packages.go:7-43`) carries the storage reference plus
the quota fields (§2.6).

**Our substrate (verified):** the shared `REPO_PACKS` bucket is the only R2
binding (`apps/worker/wrangler.jsonc.example:81-87`), already hosting three
namespaces: engine prefixes `repos/<storage_key>/…` + `imports/<storage_key>/…`
(`apps/worker/src/repos/purge.ts:94-105`), LFS `lfs/<storage_key>/<oid>`
(`apps/worker/src/services/lfs/store.ts:75-85` — format-gated key
construction, "Never store these keys; D1 keeps bare rows only"), and
release assets `repos/<storage_key>/release-assets/<release_id>/<uuid>-<name>`
(`apps/worker/src/api/services/release-assets.ts:21-25` — the row-first
landing + single-pass hash-and-forward discipline this SPEC reuses). The
upload mechanics both prior families enforce are the ones packages needs:
Content-Length REQUIRED (411 when absent), a hard byte cap checked before
streaming and per-chunk while streaming, and the hash computed in the same
pass (release-assets.ts:27-51).

**The gap:** there is no package table anywhere in `apps/worker/src/db/schema.ts`
(the inventory's verification stands: "no package table exists in our schema
(only the `repositories.has_packages` flag column)" — schema.ts:1301/1302),
no storage service, no registry route.

### 2.4 Owner scoping, access mode, and token scopes

Upstream resolves a package context through `PackageAssignment`
(`gitea/services/context/package.go:34-55`): the `{username}` owner may be a
user OR an org (`ContextUser`); access mode comes from
`determineAccessMode` (`package.go:112-166`): owner self = `AccessModeOwner`;
org members get their max team authorize level then the best
`unit.TypePackages` team mode across their teams (`package.go:130-146` —
`TypePackages` is unit 9, `gitea/models/unit/unit.go:34`); non-members get
READ when the owner is public/visible; anonymous read only for public
owners. The web R04 group wraps the whole `/packages` subtree in
`context.PackageAssignment(), reqPackageAccess(perm.AccessModeRead)`
(web.go:1128). `reqPackageAccess` (`api.go:43-72`) additionally checks the
TOKEN scope: when the doer carries a token, it requires the
`AccessTokenScopeCategoryPackage` scopes derived from the access mode — the
same category our grammar already implements.

**Our substrate (verified):** `apps/worker/src/auth/scopes.ts:16-26` —
`SCOPE_CATEGORIES` already contains `"package"` (read:/write: bits, upstream
byte-for-byte port per the module doc); the requireScope middleware derives
read/write from the HTTP method (`scopes.ts` `ScopeLevel`). The `/api/v1`
router is mounted at `apps/worker/src/index.ts:133`
(`createApiRouter()`), the auth middlewares ride `resolveAuth()` +
`sudo()` (index.ts:70/78), and static assets never shadow `/api/*`
(wrangler.jsonc.example `run_worker_first` pins `/api/*`).

Org-team package grants upstream read `unit.TypePackages` modes off team
units; our `teams` table collapses per-unit overrides onto the team row
(schema.ts, the SPEC-0007 §3.5 note "team_unit … NOT modeled") — so the org
access-mode fold for packages is a DECISION this SPEC makes (§4.1 PROPOSAL:
team `accessMode ≥ read` grants package read; `≥ write` grants package
write; no per-unit packages column).

### 2.5 The UI surface (what R04/R16 render)

**R04** — `GET /{username}/-/packages` (`web.go:1106` group; the packages
subtree `web.go:1108-1128`, gated `if setting.Packages.Enabled`):

| route | handler (`gitea/routers/web/user/package.go`) | shape |
|---|---|---|
| `GET /-/packages` | `ListPackages` (:49) | latest-version-per-package list (`SearchLatestVersions`), `q`/`type` filters, pager at `setting.UI.PackagesPagingNum` = 20 (`gitea/modules/setting/ui.go:94`) |
| `GET /-/packages/{type}/{name}` | `RedirectToLastVersion` (:137) | 302 to the latest version's page |
| `GET .../versions` | `ListPackageVersions` (:322) | the version table |
| `GET .../{version}` (+`/{version_sub}`) | `ViewPackageVersion` (:188) | the per-type detail page — `templates/package/view.tmpl` with the 26 `content/*.tmpl` + 22 `metadata/*.tmpl` family members (ls at the pin), registry-host instructions per type |
| `POST .../{version}` | `PackageVersionDelete` (:503) | delete one version |
| `GET .../files/{fileid}` | `DownloadPackageFile` (:530) | the file bytes |
| `GET/POST /-/packages/settings/{type}/{name}` | `PackageSettings` (:409) / `PackageSettingsPost` (:435) | visibility (global/internal) — write-gated |

**R16** — `GET /{username}/{reponame}/packages` (`web.go:1538-1542`, the
`packagesEnabled` gate): `repo.Packages`
(`gitea/routers/web/repo/packages.go:23`) — the same list shape filtered
`RepoID = ctx.Repo.Repository.ID` (:24-33), `CanWritePackages` off
`unit.TypePackages` repo permission (:62), rendering `repo/packages`.

The R04/R16 arms-rider pages (user settings `web.go:701-719`, org settings
`web.go:1069-1086`, admin `web.go:854-858`) are cleanup-rules CRUD + cargo
init/rebuild + the admin list/delete/cleanup — all downstream of the model
they manage.

### 2.6 Limits, quota, cleanup

- **Per-type size caps + owner totals** (`gitea/modules/setting/packages.go:7-43`):
  `LimitTotalOwnerCount` (default **-1** = unlimited, `packages.go:46-48`),
  `LimitTotalOwnerSize`, and `LimitSize{Type}` for all 23 types — each
  `-1` by default (the ini keys load through `mustBytes` with the `-1`
  no-limit sentinel, `packages.go:96-99`). Enforcement:
  `CheckCountQuotaExceeded` (`gitea/services/packages/packages.go:366`) and
  `CheckSizeQuotaExceeded` (`packages.go:390-457`) — admins bypass
  (`packages.go:391-393`), the type cap compares the single upload, the
  owner total re-computes `CalculateFileSize` over the owner's files
  (`packages.go:449-456`). Quota rejections map to **403** at the protocol
  layer (`ErrQuotaTotalCount/ErrQuotaTypeSize/ErrQuotaTotalSize`, e.g.
  `routers/api/packages/generic/generic.go:128-131`).
- **Upload size ceilings** are per-protocol, not model-level: npm caps its
  parsed body at **256 MiB** (`routers/api/packages/npm/npm.go:180`
  `http.MaxBytesReader(…, 256*1024*1024)`); the container manifest cap is
  **10 MiB** (`routers/api/packages/container/container.go:42`).
- **Cleanup** has two arms (`gitea/services/packages/cleanup/cleanup.go:26-32`
  `CleanupTask` = `ExecuteCleanupRules` + `CleanupExpiredData`): rules
  execute per enabled `PackageCleanupRule` with per-type index rebuilds
  after deletions (`cleanup.go:115-145` — debian/alpine/rpm/arch/cargo
  `BuildAllRepositoryFiles`/`UpdatePackageIndexIfExists`), and expired
  UNREFERENCED blobs are deleted past `OLDER_THAN` (the cron:
  `custom/conf/app.example.ini:2378-2392` — `[cron.cleanup_packages]`,
  `SCHEDULE = @midnight`, `OLDER_THAN = 24h`).
- **Our posture (verified):** `limits.cpu_ms: 300000`
  (wrangler.jsonc.example:12-14) — the 5-minute CPU maximum (AGENTS.md
  Workers rules); crons under 1 h get 30 s CPU, so the cleanup arm must be a
  producer enqueuing onto the serialized REPO_TASKS consumer, the
  SPEC-0014 §3 idiom (demo-sweep.ts:12-13 at 2026-10-29 — "hourly cron →
  REPO_TASKS messages … the EXISTING serialized consumer"; the scheduled
  dispatcher already carries a sanctioned hourly extension block for audit
  retention, the marked block at demo-sweep.ts:258-269 — a packages-cleanup
  producer is the same class of extension, gated the same way; the file is
  sibling-owned mid-flight, so the QUOTED sentences are the anchors, not
  the line numbers). Quota vars ride `vars` in
  wrangler.jsonc.example (the `DEMO_MODE` strict-polarity precedent,
  demo-sweep.ts §6.8 note); there is no per-type settings UI in v1.

## 3. The v1 surface (PROPOSAL)

### 3.1 Management API — the 9 FEATURE-ABSENT ops + admin list

`/api/v1/packages/{username}/…` mirrors upstream's management group
(`gitea/routers/api/v1/api.go:1696-1714`) with our router conventions
(zod-openapi per SPEC-0004; thin handlers over the services):

| op | route | upstream handler (routers/api/v1/packages/package.go) |
|---|---|---|
| `listPackages` | `GET /packages/{owner}` | `ListPackages` (:22) — latest versions, `page`/`limit`/`type`/`q` |
| `listPackageVersions` | `GET /packages/{owner}/{type}/{name}/` | `ListPackageVersions` (:237) version list |
| `deletePackage` | `DELETE /packages/{owner}/{type}/{name}` | `DeletePackage` (:120) — write scope |
| `getPackage` | `GET /packages/{owner}/{type}/{name}/{version}` | `GetPackage` (:77) |
| `deletePackageVersion` | `DELETE …/{version}` | (:155) — write scope |
| `listPackageFiles` | `GET …/{version}/files` | (:195) |
| `getLatestPackageVersion` | `GET …/-/latest` | (:293) |
| `linkPackage` | `POST …/-/link/{repo_name}` | (:352) — write scope |
| `unlinkPackage` | `POST …/-/unlink` | — write scope |
| `adminListPackages` | `GET /admin/packages` | `routers/api/v1/api.go:1820` |

Wire shapes are upstream's `modules/structs/package.go` (`Package` at
:11-33 with `owner/repository/creator/type/name/version/html_url/created_at`;
`PackageFile` at :34-47 carrying the four hashes + size + name) through our
existing user/repo serializers (the SPEC-0004 `convert` idiom). Scope
enforcement: `read:package` / `write:package` via the EXISTING
`requireScope` grammar — no new scope work (`apps/worker/src/auth/scopes.ts:16-26`).

### 3.2 The generic registry protocol

`/api/packages/{username}/generic/{packagename}/{packageversion}/{filename}`
mirrors `api.go:318-335` + `gitea/routers/api/packages/generic/generic.go`:

- `PUT` upload (streams the body; upstream validates name/version/filename
  against regexes — `generic.go:20-21`, `isValidPackageName`/`isValidFileName`
  at :53-66 — and rejects duplicates with **409** for an identical file,
  :128); quota rejections **403**.
- `GET`/`HEAD` download (404 unknown; Content-Disposition per upstream's
  `helper.ServePackageFile`, `routers/api/packages/helper/helper.go:52`).
- `DELETE` per-file and per-package (`generic.go:130-202`, DeletePackage at :140 / DeletePackageFile at :164) — write scope.
- Auth: the resolveAuth stack (Basic + PAT; the protocols are the Basic-auth
  consumers our httpauth already parses). NO container-style anonymous or
  client-native token flows in v1.

### 3.3 The web routes (R04/R16) — mount contract only

The downstream UI wave mounts: `GET /{username}/-/packages[/…]` (the seven
R04 arms of §2.5) and `GET /{username}/{reponame}/packages` (R16), gated on
the same owner-scoped access mode the services expose. This SPEC commits the
SOURCES those pages read (the services of §3.1 + the descriptor assembly),
not the pages.

### 3.4 Quota posture (PROPOSAL)

v1 carries upstream's quota CATEGORIES with our config surface:
`PACKAGES_ENABLED` (default true), `PACKAGES_LIMIT_TOTAL_OWNER_COUNT` and
`PACKAGES_LIMIT_TOTAL_OWNER_SIZE` (both default `-1` = unlimited, upstream's
defaults), and a single `PACKAGES_LIMIT_SIZE_GENERIC` (default **512 MiB**
per file — the SPEC-0005 §3.3 fixed posture, upstream's generic default is
unlimited) — strict-polarity vars, the `DEMO_MODE` discipline. Admins bypass
(upstream packages.go:391-393). The per-type `LimitSize{Type}` lattice
arrives with each ecosystem milestone, not before.

## 4. Data model

### 4.1 D1 tables (new — migration via `pnpm db:generate` into
`apps/worker/src/db/migrations`)

Column-for-column ports of §2.2's structs onto D1 types (TEXT enum convention
per the schema's `org_members.role` note):

- **`packages`**: `id` pk autoincrement; `owner_id` int NOT NULL;
  `repo_id` int NULL (the optional link — NULL = global to the owner, and
  `linkPackage`/`unlinkPackage` set it); `type` TEXT NOT NULL; `name` TEXT
  NOT NULL; `lower_name` TEXT NOT NULL; `semver_compatible` int (bool)
  NOT NULL default 0; `is_internal` int (bool) NOT NULL default 0.
  **`UNIQUE(owner_id, type, lower_name)`** — the `TryInsertPackage`
  arbitration point (upstream `UNIQUE(s)`, package.go:192-196). Index on
  `repo_id`.
- **`package_versions`**: `id` pk; `package_id` int NOT NULL; `creator_id`
  int NOT NULL default 0; `version` TEXT NOT NULL; `lower_version` TEXT NOT
  NULL; `created_unix` int NOT NULL; `is_internal` int NOT NULL default 0;
  `metadata_json` TEXT (JSON, NULL); `download_count` int NOT NULL default 0.
  **`UNIQUE(package_id, lower_version)`** (package_version.go:28-30).
- **`package_blobs`**: `id` pk; `size` int NOT NULL default 0; `hash_md5`
  TEXT; `hash_sha1` TEXT; `hash_sha256` TEXT NOT NULL; `hash_sha512` TEXT;
  `created_unix` int NOT NULL. UNIQUE on each hash column
  (package_blob.go:32-36 — md5/sha1 stay nullable: some protocols know only
  sha256, e.g. container digests; upstream computes all four because every
  upload streams through a HashedSizeReader that hashes all four at once).
- **`package_files`**: `id` pk; `version_id` int NOT NULL; `blob_id` int NOT
  NULL; `name` TEXT NOT NULL; `lower_name` TEXT NOT NULL; `composite_key`
  TEXT NOT NULL default ''; `is_lead` int NOT NULL default 0; `created_unix`
  int NOT NULL. **`UNIQUE(version_id, lower_name, composite_key)`**
  (package_file.go:35-40).
- **`package_properties`**: `id` pk; `ref_type` int NOT NULL (0=version,
  1=file, 2=package — upstream's iota order, package_property.go:22-27);
  `ref_id` int NOT NULL; `name` TEXT NOT NULL; `value` TEXT NOT NULL.
  Index (`ref_type`, `ref_id`).
- **`package_cleanup_rules`**: `id` pk; `enabled` int NOT NULL default 0;
  `owner_id` int NOT NULL default 0; `type` TEXT NOT NULL; `keep_count` int
  NOT NULL default 0; `keep_pattern` TEXT NOT NULL default '';
  `remove_days` int NOT NULL default 0; `remove_pattern` TEXT NOT NULL
  default ''; `match_full_name` int NOT NULL default 0; `created_unix` /
  `updated_unix` int NOT NULL. **`UNIQUE(owner_id, type)`** (the rules are
  one-per-owner+type upstream, package_cleanup_rule.go:26-29). Rules CRUD is
  DOWNSTREAM (the settings pages) — the table lands with the model so the
  cleanup arm has its inputs.

Org access-mode fold (§2.4 PROPOSAL, recorded as a documented divergence):
team grants come from the team row's `accessMode` (`teams.access_mode ≥
read` → package read; `≥ write` → package write) — no `team_unit` per-unit
column, consistent with the landed teams collapse (schema.ts SPEC-0007 note).

### 4.2 R2 keys (PROPOSAL)

Under the shared `REPO_PACKS` bucket, one new namespace:

- **Content blobs**: `packages/blobs/aa/bb/<sha256>` — upstream's
  `KeyToRelativePath` shard (`content_store.go:69-71`) under a `packages/`
  root. The key is content-addressed and GLOBAL (owner scoping lives purely
  in D1, as upstream's model does: a blob row has no owner column) — two
  owners uploading identical bytes share one R2 object, which is the point
  of the four-hash dedup row.
- **Upload spool**: `packages/tmp/<upload_uuid>` — the hash-then-key staging
  object (§5.1). Never read by anything but the upload that created it;
  deleted on both success and failure paths.

Namespace rules inherited from the landed families: keys are pure functions
of validated segments (the LFS injection-proof rule, lfs/store.ts:5-9);
D1 stores bare rows only — the `package_blobs.hash_sha256` IS the key
material, no r2_key column (deviation from the release-asset convention,
which keys by uuid because asset bytes are NOT deduplicated; packages
blobs are, so the hash column already names the object).

### 4.3 No DO

Package writes need no Durable Object: the mutation arbiter is the D1
UNIQUE constraints (the `org_members_org_user_uq` constraint-first pattern),
R2 puts are idempotent under content-addressed keys, and there is no
cross-request ordering requirement inside one protocol exchange. (The
engine's `Registry` DO at
`packages/git-engine/src/registry.ts:25` is the REPO-name registry — an
unrelated name.) The container family's chunked uploads are the one future
exception; their upload state gets its own posture at M5 (Open question 6).

### 4.4 Cleanup arm (PROPOSAL)

An hourly-producer block joins the existing scheduled dispatcher (the
demo-sweep.ts mount record — §2.6's quote anchors): SELECT due cleanup work and enqueue
`{kind: "package-cleanup"}` onto REPO_TASKS; the serialized consumer
(`src/repos/purge.ts` dispatch family) executes:

1. `CleanupExpiredData`: delete `package_blobs` rows with zero
   `package_files` references older than the `PACKAGE_CLEANUP_OLDER_THAN`
   var (default 24h, upstream's `OLDER_THAN`), then `bucket.delete` their
   `packages/blobs/…` keys.
2. `ExecuteCleanupRules`: iterate enabled rules (keep-count / keep-pattern /
   remove-days / remove-pattern) deleting matching versions — then the
   index-rebuild rider of upstream cleanup.go:122-147 (LANDED with the distro
   tail): when a rule deleted at least one version (`anyVersionDeleted`), the
   rule type's registry index files rebuild whole, once per rule — debian /
   alpine / rpm / arch each through their BuildAllRepositoryFiles arm in
   `src/services/packages/cleanup.ts` (rpm via the landed
   `buildAllRpmRepositoryFiles`; the other three composed: internal-version
   file sweep, then the family's distinct-property enumeration through the
   landed BuildSpecific twins). Upstream's arch arm rides a globallock we do
   not carry (the serialized REPO_TASKS consumer is the writer gate). The
   per-package cargo rider (cleanup.go:108-118) is WIRED since the cargo
   family landed — INSIDE the rule's package loop, per package that lost a
   version, distinct from the distro post-loop rebuild; it resolves to
   upstream's own repo-absent no-op (index.go:94-99; the git mirror is §1's
   separate milestone, the sparse index derives on read).

The arm never runs unless a rule is enabled or orphans exist; no DEMO-gating
parallel — this is upstream's own midnight job, not the demo sweep's
data-deletion invariant (it deletes only UNREFERENCED blobs and rule-matched
versions, exactly what upstream self-hosters get). Ratification confirms
(this is Open question 5).

## 5. Edge cases, limits, and failure modes

1. **Hash-then-key ordering** — the generic PUT must know the sha256 BEFORE
   the final R2 key exists, but the body can only be read once. PROPOSAL:
   single-pass hash-and-forward into `packages/tmp/<uuid>` (the LFS
   relay-store pipeline verbatim, digest in the same pass), then ONE bounded
   second pass streaming `bucket.get(tmp)` → `bucket.put(final-key)`, then
   `bucket.delete(tmp)` — intra-datacenter bandwidth, no egress, ≤2
   subrequest-classes per upload, and the D1 row lands only after the final
   key is durably stored (row-first landing inverted: object-first here,
   because D1 rows are only useful once the bytes they point at exist — the
   release-asset relay completion idiom). Failure windows: a crash between
   tmp-put and final-put leaves an orphan tmp object — the cleanup arm's
   OLDER_THAN sweep deletes `packages/tmp/` objects past the window; a
   crash between final-put and D1-insert leaves an unreferenced content blob
   — the same sweep deletes unreferenced `packages/blobs/…` rows+keys.
   (Alternative rejected: keying blobs by upload uuid like release assets —
   loses cross-owner dedup, the reason the blob table has four hash
   UNIQUEs.)
2. **Duplicate-upload semantics** — upstream returns the EXISTING version
   row with `ErrDuplicatePackageVersion` on re-publish
   (package_version.go:48-67) and per-file duplicates answer 409
   (generic.go:128-131). Our services must mirror BOTH: `GetOrInsert`
   shapes for version/blob, 409 only when the same file
   (version+lower_name+composite_key) exists with DIFFERENT bytes; identical
   bytes → the idempotent no-op upstream's `GetOrInsertBlob` models.
3. **Streaming under the CPU cap** — `limits.cpu_ms` 300000 with waiting-on-
   R2 free (AGENTS.md Workers rules): the 512 MiB cap streams in 8 MiB
   multipart parts when Content-Length is absent-for-the-part (the
   release-asset multipart rule, release-assets.ts:33-51); the protocol
   routes REQUIRE Content-Length (411) like every landed upload family.
4. **Property explosion** — properties are LONGTEXT key-value rows; a
   hostile client cannot create unbounded rows on one version (uploads are
   the only property writers in v1, and generic writes no properties at
   all). npm dist-tags and container digests arrive with their milestones
   and inherit the same writer-side discipline.
5. **Owner deletion cascade** — upstream `RemoveAllPackages`
   (packages.go:720-744) rides user/org deletion. Our user/org deletion
   cascade must add: delete the owner's `packages` rows (versions/files/
   properties/blobs rows) and their `packages/blobs/…` keys — EXCEPT keys
   still referenced by another owner's files (dedup makes ownership of
   bytes non-exclusive). PROPOSAL: the consumer deletes a content key only
   after confirming zero remaining file references (a SELECT before each
   delete, or the unreferenced-blob sweep as the sole deleter — decided at
   implementation, Open question 4).
6. **Repo deletion does NOT touch packages** — the repo link is a pointer
   (`Package.RepoID`); upstream's repo delete unlinks, not deletes (the
   packages survive owner-scoped). Our purge pipeline
   (`src/repos/purge.ts`) needs NO changes in v1 because packages never
   write under `repos/<storage_key>/`; the purge arm adds an unlink
   (`UPDATE packages SET repo_id = NULL WHERE repo_id = ?`) to the repo
   delete transaction family — a service arm, not a purge change.
7. **Version ordering** — `lower_version` uniqueness makes version
   comparison a display concern; upstream sorts semver-aware types with
   hashicorp/go-version at the descriptor (`descriptor.go` `SemVer`). v1
   lists order by `created_unix DESC` (insertion recency, upstream's own
   default ordering for non-semver types); a JS semver compare arrives with
   the npm milestone (its consumers need it), not in the model.
8. **Download counters** — `IncrementDownloadCounter` is a bare SQL
   increment upstream (package_version.go:76-79). Drizzle-side: the same
   `SET x = x + 1` expression; D1 serializes it correctly per-row.
9. **The name/type enum surface** — `type` is upstream's string set; our D1
   column stays TEXT (not a CHECK list) so ecosystem milestones add types
   without migrations, matching upstream's open `Type` string model.
10. **401 shape** — upstream's `reqPackageAccess` sets
    `WWW-Authenticate: Basic realm="Gitea Package API"` on scope failure
    (api.go:52-60) — our protocol routes mirror that header so real
    package-manager clients re-prompt for credentials.

## 6. Testing plan

Worker vitest (real bindings, the `applyD1Migrations` + seeded-env idiom of
the landed suites):

- **Model**: TryInsert/GetOrInsert shapes (duplicate package → existing row;
  duplicate version → existing row + duplicate sentinel; blob dedup across
  owners — two owners, one blob row, two file rows); the UNIQUE arbitrations
  under concurrent inserts (D1 serializes — assert the constraint answers,
  not a race).
- **Storage service**: key construction format-gates (invalid sha256 segment
  → thrown before any R2 call); the PUT pipeline — tmp spool, final key,
  tmp deleted, hash verified (a corrupted-body test asserts the mismatch
  deletes the spool and rejects); Content-Length absent → 411; over-cap →
  413 checked before and during streaming.
- **Generic protocol**: PUT/GET/HEAD/DELETE round-trip with a real
  package-manager-shaped body (curl-level conformance); name/version/filename
  validation rejections (upstream's regex set, generic.go:20-66); 409 on
  duplicate-different-bytes, idempotent on duplicate-same-bytes; 403 on
  quota; 401 with the `WWW-Authenticate` header on scope failure; download
  counters increment.
- **Management API**: the 9 ops against the wire shapes (structs/package.go
  fixtures); link/unlink round-trip; the repo filter of R16's source query
  (two repos, one owner — each tab sees only its own).
- **Cleanup arm**: orphan blob + orphan spool sweep (a tmp object and an
  unreferenced blob older than the window are gone; young ones survive);
  rule execution (keep-count, remove-days) WITH the distro rebuild rider
  (a type-matched delete rebuilds the family's internal index files whole;
  a non-distro rule and a no-deletion run rebuild nothing); the
  producer gate (no rules enabled + no orphans → zero queue sends).
- **Quota**: owner-total accumulation across two packages; admin bypass;
  `-1` defaults disable every check (the strict-polarity tripwire test
  pattern).
- **Gates**: `pnpm typecheck`; `pnpm test:full` per ADR-0006 — a single-file
  `pnpm test` pass is never cited as suite-green.

No engine-check `.mjs` arms exist for this SPEC — packages touches no engine
code (§4.3); the vitest suites are the whole plan (the 0015 engine-check
idiom applies only where the vendored engine grows).

## 7. Milestones (the census's sizing, serializable)

- **M1 — model + generic registry + management API** (size **L**; the
  census's package class is the whole family — this is its v1 core):
  migration + `src/services/packages/` (store + quota + descriptor) +
  generic protocol routes + the 9 ops + admin list + the cleanup arm +
  tests. Lands R04/R16's prerequisite (their rows un-defer the moment this
  ships) and closes the 9-op FEATURE-ABSENT class. No DO. One commit-unit;
  file-ownership: schema + services + api routes + a small index.ts mount
  addition (the `/api/packages` router — the orchestrator-designated owner
  rule applies to index.ts).
- **M2 — R04/R16 UI pages** (size **M** per page, the census's own sizing
  for management tabs): the seven R04 arms + the R16 repo tab + the
  downstream settings/admin pages when their wave opens. UI wave —
  dispatches only after M1.
- **M3 — pypi + helm protocols** (size **S-M**): the two smallest
  index-render families (~250 lines upstream each) — the first real
  package-manager client conformance (`pip install -i …`). Rides M1's
  storage service unchanged.
- **M4 — npm protocol** (size **M-L**): the multipart creator port
  (modules/packages/npm/creator.go, 486 lines upstream) + dist-tag
  properties + scoped-name paths + the semver ordering consumer.
- **M5 — maven + nuget** (size **M** each): path-group layout serving +
  metadata.xml generation; the OData/V3 dual wire.
- **M6 — container (OCI)** (size **L**): the JWT token flow (an HS256
  secret posture — PROPOSAL: reuse the token-service discipline, decided at
  the milestone), chunked blob uploads with their upload-state machine,
  manifests, the `PropertyDigest` file properties, HEAD/GC-aware deletes.
  The only milestone that may need new infrastructure posture.
- **M7 — the index-builder family** (size **L** each, demand-driven):
  debian/alpine/rpm/arch index renders (pure computation over the model +
  signed-key posture decisions), cargo LAST (the git-backed `_cargo-index`
  repo needs the files-service write path to exist for owner-scoped repos).
- **The long tail** (conan/composer/chef/conda/cran/go/pub/rubygems/swift/
  terraform/vagrant): no committed milestone — each is a client wire contract
  over the SAME model; dispatch on demand, sizes S-M. (The 2026-11-01
  adjudication disposition: terraform LANDED — the as-built at the tail;
  [corrected 2026-11-01, the conda unit] conda LANDED too — the three walls
  RESOLVED (the bz2 decoder adopted; the `.conda`/zstd reduction recorded;
  the repodata-encoder reduction reopened and adopted — the bz2-encode
  unit), the as-built at the tail; the census claim this
  closes: TWENTY-THREE of TWENTY-THREE.)

Entry criteria: ratified SPEC (this document → accepted), then M1 as a
worker unit; M2+ per the census's wave discipline. Each ecosystem milestone
updates §2.1's table + the divergence ledger with its documented reductions.

## 8. Open questions (resolve at ratification)

1. **Blob storage mechanics** — the tmp-spool + second-pass copy of §5.1 vs
   waiting for an R2 server-side copy affordance. Proposal: ship the two-pass
   (it is bounded, idempotent-failure-safe, and needs nothing new); revisit
   only if the second pass shows up in CPU profiles.
2. **R2 namespace** — `packages/blobs/<sharded-sha256>` global-dedup
   (§4.2, upstream's model) vs per-owner prefixes (`packages/<owner_key>/…`,
   purge-friendly but dedup-losing). Proposal: global dedup; owner deletion
   uses the reference-counted delete of §5.5.
3. **Quota defaults** — `PACKAGES_LIMIT_SIZE_GENERIC` at 512 MiB
   (SPEC-0005 posture) vs upstream's unlimited-generic default. Proposal:
   512 MiB — self-host R2 cost safety beats upstream parity; the var
   relaxes it.
4. **Cross-owner blob deletion** — confirm the reference-counted rule
   (§5.5): a content key is deletable only when zero file rows reference
   its blob id. Proposal: the unreferenced-sweep as the SOLE deleter of
   content keys (simpler, eventually-consistent), owner-cascade deleting
   rows only.
5. **Cleanup arm gating** — the packages cleanup is NOT demo-gated
   (§4.4), unlike the demo sweep; it deletes only what upstream's own
   midnight cron deletes. Confirm ratification accepts this as the second
   sanctioned producer block on the hourly entry (alongside audit
   retention).
6. **Container upload state (M6 pre-read)** — upstream's
   `blob_uploader.go` persists upload sessions; on Workers the candidates
   are R2 multipart-upload handles (native, resumable, no D1 state) vs a D1
   upload-rows model. Deferred to the M6 SPEC-attachment; noted so it is
   not silently re-decided.
7. **`repo_units` enum extension** — the packages unit (`TypePackages`,
   upstream unit 9) arrives when R16's tab visibility + repo settings
   toggle land (M2); the enum is `["code"]` today (schema.ts:292) and
   `repositories.hasPackages` (schema.ts:1301) is already carried. Proposal:
   extend the enum in the M2 migration, not M1 (no UI reads it before).
8. **Org-team package grants** — the accessMode-collapse fold of §4.1
   (team row mode ≥ read/write grants package access, no per-unit column)
   vs adding a `team_unit` packages row upstream-parity. Proposal: the
   collapse, consistent with the landed teams model; upstream parity can
   arrive as a columns migration later if a deployment needs per-unit
   granularity.

### Ratification (2026-10-29, orchestrator)

All eight questions resolved per their proposals: (1) two-pass blob copy
ships; (2) global-dedup `packages/blobs/<sharded-sha256>` namespace with the
reference-counted deletion; (3) 512 MiB generic quota default (self-host R2
cost safety; the var relaxes); (4) the unreferenced-sweep is the SOLE
content-key deleter, owner cascades delete rows only; (5) the cleanup is the
second sanctioned non-demo-gated producer block on the hourly entry (the
audit-retention precedent, landed 5c8853c); (6) container upload state
deferred to the M6 SPEC-attachment; (7) `repo_units` enum extends in the M2
migration; (8) the accessMode-collapse fold, upstream parity can arrive as a
later columns migration.

## As-built — M5b nuget (e26c862, 2026-10-29 — the registry carries SIX protocols)

The §2.1 nuget row's full wire (upstream 698 ln: the V2 OData + V3 JSON dual),
landed as `services/packages/nuget.ts` (2,227 lines) + the route arms in
`api/routes/packages-protocols.ts`:

- **The hand-built zip reader** — EOCD + central-directory walk, stored +
  deflate-raw entries, the bomb gate — no new dependency (the hand-rolled
  posture, same spirit as the actions connect codec).
- **The root-nuspec rule** with the fifth-segment normalization.
- **V3**: the nine-resource service index + registration leaves +
  byte-parity downloads.
- **V2 OData**: the Edmx + the `Packages(Id=…)` leaf via a PREFIX-WILDCARD
  re-pin of upstream's regex — Hono cannot compile chi's embedded-param
  parens (probe-verified; a documented wire-shape divergence with upstream's
  match set preserved).
- **The BSJB symbol extractor** (the symbols endpoint) and the
  **X-NuGet-ApiKey auth fallback** (upstream's `nuget.Auth` in api.go:97-102).
- **The +1 post-insert count-quota parity** upstream's transaction ordering
  produces (the pattern the npm fix below generalizes).
- Tests: 14/14 own + the six-protocol superset sweep 122/122. The commit
  flagged npm's missing quota-parity arm for backport — landed (below).

## As-built — npm count-quota parity (54a8fc4, 2026-10-30)

Upstream's count quota is insert-THEN-check inside the rolling-back
transaction — `CheckCountQuotaExceeded` is called only after `versionCreated`
(`services/packages/packages.go:188-191`; the `totalCount >
LimitTotalOwnerCount` comparison at `:380-381`) — so the publish reaching
limit N succeeds (201) and only N+1 fails (403), the failed publish rolling
back whole. npm's landed pre-insert check allowed one version MORE at the
boundary; the fix applies the pre-insert EQUIVALENT — the inline
`countVersions + 1 > limit` block with admin bypass and `-1` disable
(mirroring nuget's landed shape) — and the boundary test pins N-th 201 /
(N+1)-th 403 + the rollback posture. 24/24 own + the six-protocol
superset sweep 183/183.

The same +1 parity is now family-wide: the pypi/generic/helm/maven sweep
landed `4e42c8c` (the inline shape at every publish arm — helm's prov path
included, maven's checksum-verify early return staying quota-free;
`checkCountQuotaExceeded` deleted from model.ts, zero occurrences left in
src; boundary tests in all four suites; superset sweep 156/156).

**Open at this as-built read (honest, NOT landed):** nuget is NOT yet in
the deploy-probes packages-registry battery
(`scripts/deploy-probes.mjs`, the 49a1502 battery round-trips FIVE of the
six protocols end-to-end — generic, pypi, npm, helm, maven — nuget pending).

## As-built — M6 container/OCI (2026-10-31 — the registry carries SEVEN protocols)

The §2.1 container row's full wire (upstream ≈2,000 ln: routers
api.go:509-547 + container/blob/manifest/errors 1,459 + services 456), landed
as `services/packages/container.ts` + `createContainerProtocolRouter()` in
`api/routes/packages-protocols.ts`, mounted at the `/v2` ROOT (upstream's
mount, NOT `/api/packages`; `package_blob_uploads` migration 0046):

- **The auth model** (`services/packages/auth.go`): `/v2/token` (GET) mints
  the HS256 JWT `{exp(+24 h), nbf, UserID, Scope}` keyed off the instance's
  general token signing secret — the SAME `system_keystore` row
  `general_token_signing_secret` the actions keystore owns (upstream's
  single GetGeneralTokenSigningSecret); the container module has its own
  generate-once-save-back reader that deliberately skips the actions
  loader's RSA keygen on cold paths. Basic → the PAT verify; Bearer → the
  container JWT ONLY (a Bearer PAT is not a container credential — upstream
  packages/auth.go parses every Bearer as the JWT and 401s on garbage);
  anonymous → the GHOST token (UserID −1, user_system.go:12), which passes
  ReqContainerAccess but stays anonymous in the access ladder
  (package.go's `!doer.IsGhost()` guards — mirrored by doer=null).
  Credentials that fail Basic verify are ANONYMOUS (upstream basic.go's
  nil-nil), not invalid. The 401 handshake (container.go:116-130) serves
  `Bearer realm="<origin>/v2/token",service="container_registry",scope="*"`
  plus — on a {username} path whose owner exists and is non-public — the
  `Basic realm="Gitea Container Registry"` twin (the apple-container login
  support); the access-denied arms answer the shared Gitea-Package-API
  challenge verbatim (upstream reqPackageAccess api.go:43-63). SCOPE: the
  /token mint gates `HasAnyScope(read:package, write:package, all)`
  (container.go:165-176) and the JWT carries the scope for the downstream
  reqPackageAccess (GetDoerTokenScope via ExtDoerData — our
  ScopeSet.parseLenient of the claim).
- **The upload-session store** (the §8.6 decision): BOTH HALVES in their
  native homes, mirroring upstream's row + temp-file split — the
  `package_blob_uploads` D1 row (id uuid pk, bytes_received, chunk_count,
  updated INDEX; the column map in the schema comment) and the chunk bytes
  in R2 `packages/uploads/<uuid>/<seq>` (one object per PATCH — R2 cannot
  append; chunk_count is the ordered enumeration upstream infers from the
  file extent; the PATCH counters advance atomically under a
  expected-chunk-count guard — the errOffsetMismatch race arm,
  blob_uploader.go:88-90). R2 multipart uploads were REJECTED: non-terminal
  parts have a 5 MiB floor and real chunked pushes stream smaller parts.
  Disclosed reductions: (1) NO HashStateBytes — WebCrypto digest state is
  unserializable, so PUT re-streams the chunks through fresh digests
  (blob_uploader.go:48-53's resume posture, adapted); (2) each PATCH chunk
  spools under the 512 MiB cap (upstream's temp file is unbounded).
  The PUT-finalize digest verification, the quota checks
  (CheckSizeQuotaExceeded at the blob arms, CheckCountQuotaExceeded inside
  createPackageAndVersion — post-insert, count-includes-the-new-row, the
  same N/N+1 boundary as the family's +1 pre-insert equivalent) and the
  session-removed-only-on-success lifecycle are upstream-exact.
- **Manifests** (manifest.go): the 10 MiB cap through the bounded spool
  (over-cap → MANIFEST_INVALID 413), the media-type resolution
  (header first, document second), the image-manifest flow (config blob
  must exist → the metadata parse → the version row with the
  DELETE-AND-RECREATE overwrite arm keeping the download count
  (manifest.go:277-294) → config+layer file inserts with the
  expected-size SIZE_INVALID gate and the _upload-version move semantics
  (:369-374) → the lead manifest.json file with older leads demoted) and
  the image-index flow (every referenced manifest must exist AS a manifest
  → MANIFEST_BLOB_UNKNOWN; platform list into Metadata). The Metadata JSON
  serializer pins Go's struct order + omitempty + sorted label keys; the
  helm-config dispatch (helm.go:8's media type) carries the §2.1 helm-chart
  posture. Deletes: blob DELETE removes every file row carrying the digest
  (the unreferenced-sweep stays the sole R2-key deleter, ratification 4);
  manifest DELETE walks GetManifestVersions (non-internal) →
  RemovePackageVersion each → 202.
- **Serving** (container.go:706-732's serveBlob): ALWAYS 200 full-body with
  Content-Length + Docker-Content-Digest + ETag + the api-version header —
  upstream io.Copy's with no Range/conditional machinery, so we neither
  advertise Accept-Ranges nor serve 206s here (the six /api/packages
  families keep the serve-content battery); the store-size gate
  (getExistingContainerBlob's OptionalSize check, :781-796) reads as
  BLOB_UNKNOWN/MANIFEST_UNKNOWN when the R2 object disagrees with the row.
- **The wire grammar** (the route half): the image spans slashes (upstream's
  `<image:*>`), so the router takes a wildcard and walks the tail
  segment-by-segment (the npm family's parseTarget pattern); VerifyImageName
  + reference/digest grammars are the pinned regexes (container.go:48-49,
  go-digest).
- **Live walk (docker 28.1.1, real daemon)**: `docker login` (GET /v2/ 401
  handshake → GET /v2/token → JWT) → `docker push` of alpine:smoke (the
  full POST→PATCH→PUT chunked dance per layer + config, then the manifest
  PUT) → `docker pull` round-trip at the same digest → `docker run` echoed
  (byte parity) → tags/list, _catalog, manifest HEAD (content-type
  resolved from the document, digest + ETag), ghost-token anonymous pull
  200, anonymous DELETE 401.
- **THE HANDOFF (orchestrator-owned files; the live walk APPLIED these
  locally, then reverted byte-exact — three pieces, the walk proved all
  three are needed):**
  1. `src/index.ts` — the import beside the ecosystem router's
     (`import { createContainerProtocolRouter } from "./api/routes/packages-protocols";`)
     and the mount beside the packages mounts (after
     `app.route("/api/packages", createEcosystemProtocolRouter());`):
     `app.route("/v2", createContainerProtocolRouter());`
  2. `src/index.ts` — THE DISPATCH CARVE the predecessor's two-line diff
     missed: the fetch wrapper's `isRepoScoped` predicate
     (src/index.ts:323-329) hijacks every 2+-segment path into the
     git-http gate, so `/v2/{owner}/…` never reached Hono (the engine
     bare-404ed the walk). Add `segments[0] !== "v2" &&` to the predicate
     (beside the `api`/`twirp` carve-outs).
  3. `wrangler.jsonc.example` — `"/v2/*"` in the `run_worker_first` array
     (beside `"/api/*"`, the asset-shadowing rule; wrangler.jsonc is
     account-local, the example is the template).
- **FOUND IN THE WALK (pre-existing, all seven families, orchestrator
  call):** the root `app.onError` (src/index.ts:91) renders EVERY unhandled
  error as the 500 chrome and has no HTTPException passthrough — the
  protocol families' thrown 401 challenges (packageAccessChallenge,
  api.go:51-61's shared shape) answer 500 "Internal Server Error" on the
  live deployment while their vitest parents (bare Hono, default onError)
  render them. One-line fix at the top of the override:
  `if (error instanceof HTTPException) return error.getResponse();`.
  The container family is unaffected either way: its gate arms carry
  responses as VALUES (ContainerGateResponse, unwrapped one frame down in
  the dispatcher) — landed deliberately so M6 is correct live regardless.
- Tests: `container.test.ts` 36/36 own-eyes (handshake + token + ghost;
  POST→PATCH-chunks→PUT with the mismatch/416/stream-upload/status/abort
  arms; the chunked unknown-length spool arm; single-POST; cross-repo
  mount; manifests incl. the overwrite arm, index, 10 MiB cap, the
  BLOB_UNKNOWN/SIZE_INVALID/UNSUPPORTED/NAME_UNKNOWN arms; tags + catalog
  pagination; quota 403s bare; PACKAGES_ENABLED=false; the cleanup sweep)
  + neighbors re-run post-refactor: generic+helm 45/45, npm+nuget+pypi+
  maven 92/92, blobs/model/serve-content/cleanup 88/88; check-openapi PASS
  (/v2 is OUTSIDE the frozen contract's inventory — zero `/v2` paths in
  v1-swagger.generated.json, upstream keeps the OCI API out of the v1
  swagger too); tsc 0 in the touched files; scoped eslint clean; migration
  0046 applied to the local D1 (DDL verified, recorded once). The
  `specs/README.md` SPEC-0016 row ("M6 container + M7 index-builder
  pending") and the deploy-probes battery (currently five protocols) are
  the orchestrator's doc/wiring follow-ups, not this unit's files.

## As-built — M7 index-builder family, half one: debian + alpine (2026-10-31 — the registry carries NINE protocols)

The §2.1 M7 row's first two families landed: `services/packages/debian.ts` +
`services/packages/alpine.ts` over the shared `services/packages/distro-common.ts`
substrate, the route arms in `api/routes/packages-protocols.ts`
(`api.go:287-304` debian, `api.go:105-117` alpine). rpm and arch remain
PENDING (their additive cites below).

- **The generation posture (the M7 family's answer, mirrored from upstream):
  indices are STORED, not rendered per request.** Upstream builds on every
  upload/delete (`BuildSpecificRepositoryFiles`, debian.go:197/300,
  alpine.go:195/278) into files of an internal package version
  (`GetOrCreateRepositoryVersion` → `_debian`/`_alpine` + `_repository`,
  both rows is_internal, repository.go:34-38/alpine repository.go:39-50) and
  the GET arms are plain file lookups. Ours: `getOrCreateInternalPackageVersion`
  + `storeRepositoryFile`/`deleteRepositoryFile` in distro-common (the
  OverwriteExisting internal-file arm — a same-key row with different bytes is
  deleted with its properties and re-inserted; identical bytes keep the row),
  built bytes hashed with all THREE WebCrypto digests into the shared blob
  dedup. (Contrast helm — upstream's only per-request render.) model.ts is not
  this unit's file, so the internal version get-or-insert is the local twin
  over the same tables/UNIQUEs (same re-select on a lost race).
- **Keypairs** (the §1 out-of-scope item resolved): per-owner RSA in
  `user_settings_kv` — upstream's exact `user_setting` home
  (keypair.go:18-43's GetOrCreateKeyPair: read → generate → re-read → store)
  under upstream's setting keys `debian.key.private/public` and
  `alpine.key.private/public`, plus `debian.key.created` pinning the OpenPGP
  key-packet creation time (the packet bytes must be STABLE or the key
  id/fingerprint would drift between requests). RSA-2048 RSASSA-PKCS1-v1_5 —
  upstream 4096 (util.GenerateKeyPair / packet.Config RSABits), the documented
  Workers-cost divergence the actions OIDC issuer carries
  (secrets.ts:269-280). The private arm stays in the store; every consumer
  imports per request (no module-level key state).
- **The byte substrate (distro-common.ts)** — the Go stdlib re-implementation,
  no new dependency (the nuget hand-built zip-reader posture):
  - gzip via CompressionStream/DecompressionStream. workerd's decoder is
    STRICTLY single-member (probe-verified — "Trailing bytes after end of
    compressed data"; the landed `spike-streams.test.ts` is the platform
    record, 161bc62), AND it discards already-decoded chunks when it errors —
    so concatenated members (an .apk's signature‖control‖data streams) are
    walked by grow-then-bisect EXACT-LENGTH windows: a window decodes clean
    only when it ends at the member boundary, pinning both payload and raw
    extent (the .apk C: checksum hashes the raw member bytes, the tee'd
    reader in alpine metadata.go:79-108).
  - ustar writer/reader (APKINDEX entries Mode 0o600; the .SIGN.RSA member
    written WITHOUT end blocks — writeGzipStream's addTarEnd=false, alpine
    repository.go:331-351) and the blakesmith/ar reader (deb(5)).
  - a minimal OpenPGP v4 signer for debian: RSA-SHA256 signature packets
    (hashed subpackets = creation time + issuer fingerprint v4; unhashed =
    issuer key id), armor + CRC-24, the clearsign InRelease, the armored
    detached Release.gpg, and the transferable public key for repository.key
    (RFC 4880 §11.1 packet ORDER key‖uid‖self-cert — the live battery caught
    the uid-first requirement: gpg's import tolerated a trailing uid but
    gpgv/apt's strict ring parser rejected it, FIXED in-flight). The RSA
    operation is WebCrypto RSASSA-PKCS1-v1_5 over the RFC 4880 hash framing
    (the wire form); the clearsign hash covers the CRLF-canonicalized escaped
    body MINUS the final trailing newline (the body/signature separator —
    cross-verified against gpg's own clearsign of the same body).
- **debian** (repository.go's full builder set): Packages paragraphs from the
  stored `debian.control` property + Filename/Size/SHA1/SHA256/SHA512 (the
  correlated-count property filter over non-internal is_lead files,
  debian search.go:26-67, ordered package lower_name + version creation);
  Release/Release.gpg/InRelease with Origin/Label "Gitea", sorted
  Components/Architectures, RFC 1123 GMT Date, Acquire-By-Hash: yes, checksum
  sections at `{component}/binary-{arch}/{filename}`; the empty arms delete.
  Upload = the pypi quota shape (+1 count parity, size after parse) + the D-1
  any-duplicate 409 + the post-write rebuild rider; the ar walk reads ONLY
  debian-binary + control.tar (data.tar never touched — the streaming
  spool-reader stops at control), `binary-` trimmed architecture on the GET
  arm, by-hash arms serve by blob hash. **Documented reductions:** no
  Packages.xz (no xz codec in the substrate; apt consumes the mandatory .gz
  baseline); .xz/.zst control archives → 400 "unsupported compression
  algorithm" (upstream's own default-arm message — LIVE-FIRED: this host's
  dpkg-deb ≥ 1.21.18 defaults control.tar.zst, so modern-dpkg builders pass
  `-Zgzip`, or a later milestone grows a zstd decoder); MD5 never computed
  (the blobs.ts three-digest posture) → Packages omits the MD5sum line,
  Release omits the MD5Sum section, by-hash/md5sum answers 404.
- **alpine** (repository.go's builder set): APKINDEX paragraphs from the
  stored `alpine.metadata` FileMetadata + the version's VersionMetadata JSON
  (Go tag order), `A:` printing the INDEX architecture (noarch files merged
  into every real architecture's index, repository.go:155-162), the two-gzip
  signed archive (signature member tar-no-end ‖ unsigned index member tar),
  `.SIGN.RSA-{lower}@{sha256-of-SPKI}.rsa.pub`; upload carries the branch/
  repository/architecture/metadata properties, the noarch upload re-rolls
  EVERY architecture of its branch/repository (repository.go:104-112), the
  index + .apk serving arms fall back to noarch (alpine.go:83-97/:219-236);
  delete has NO fallback (exactly-one search, alpine.go:251-267). The .apk
  parse walks members and stops at the .PKGINFO member like upstream;
  PKGINFO provides/depend capped at 1024 entries. **Documented reduction:**
  the parse window is capped at 64 MiB (signature+control members are
  kilobytes in real apks); index paragraph order pinned to file lower_name.
- **Tests** (`packages-debian.test.ts` 12/12, `packages-alpine.test.ts` 8/8,
  own-eyes): the fixture fixtures are hand-built upstream-shaped archives
  (ar + control.tar.gz + an unread data.tar; three-member .apk with the
  checksum asserted against the raw control member); the alpine suite runs
  the REAL crypto verification in-suite (WebCrypto RSA-SHA1 verify of the
  served signature over the served member bytes against the served key, plus
  the tampered-payload failure arm). Neighbors re-run post-change: the five
  protocol suites 109/109, blobs/cleanup/container/model/serve-content
  124/124, the sibling's landed workerd platform record 4/4; check:api PASS
  (zero new contract paths — the /api/packages families sit outside the
  frozen v1 swagger inventory, the M6 precedent); tsc 0 repo-wide; scoped
  eslint clean.
- **The LIVE battery (real clients, this host):** dpkg-deb-built livepkg
  uploaded → apt-get update against the dev server (sandboxed rootless:
  Dir::* redirected, signed-by the served key.asc — upstream's own setup
  shape, debian spec.go's RenderSetupManual) VERIFIED the InRelease signature
  and fetched the index; `apt-get download livepkg` round-tripped the pool
  .deb BYTE-IDENTICAL through apt's own index→Filename→pool path; gpgv on the
  raw InRelease and Release+Release.gpg: GOOD (rc=0) both, against the served
  repository.key. Alpine: `apk` is NOT installed on this host (disclosed) —
  the live arms were a system-tool battery: tar/gzip-built .apk uploaded,
  the served APKINDEX.tar.gz member-split by zlib, the .SIGN.RSA entry
  verified by openssl (`Verified OK`, RSA-SHA1 over the exact raw unsigned
  member), the C: checksum asserted against the uploaded control member, the
  .apk download byte-parity; by-hash (sha256) + the delete-rebuild arms
  exercised live on both families (204 → the index 404s on the empty arm).
  Residual for the orchestrator's wiring wave: the deploy-probes battery
  (currently six protocols) may gain debian/alpine arms — not this unit's
  file.
- **As-built — M7 half two: rpm (2026-10-31 — the registry carries TEN
  protocols):** `services/packages/rpm.ts` + the rpm route arms in
  `api/routes/packages-protocols.ts` (upstream `routers/api/packages/rpm/
  rpm.go` 471 ln + `services/packages/rpm/repository.go` 709 ln +
  `services/packages/rpm/sign.go` + `modules/packages/rpm/header.go` 259 ln
  + `metadata.go` 303 ln + `models/packages/rpm/search.go`), all over the
  debian/alpine trio's substrate unchanged.
  - **The binary header reader** (header.go ported byte-for-byte): the
    96-byte lead (magic 0xedabeedb), the signature section (≤32 entries,
    ≤64 MiB) with the 8-byte alignment pad, the main section (≤0xffff
    entries, ≤0x0fffffff data), the hdrblobVerifyInfo index validation
    (monotonic offsets, per-type length bounds, the ≤63 region tag skipped
    at position 0), and the sigTagSHA256/SHA1 digest over the main header
    bytes. The parse consumes ONLY the header region off the spool stream
    (bounded at 64 MiB total — the documented window; real sections are
    tens of KiB), never the payload — upstream's io.Reader shape.
  - **The tag extraction** (metadata.go port): name/version/release/epoch/
    arch, the provides/requires/conflicts/obsoletes triples folded into
    flag-tagged entries (GE/LE/GT/LT/EQ over the sense bits, the
    epoch:version-release split), the dirnames+basenames+dirindexes file
    list with the ghost/dir/executable mode fold, the changelog triple;
    the version string is `{ver}-{rel}` prefixed `{epoch}-` when non-zero
    and the stored file is `{name}-{version}.{arch}.rpm` with composite
    key = the group segment. The FileMetadata property is serialized in
    Go's json.Marshal field order with omitempty.
  - **The stored-index build** (repository.go's builder set): the
    createrepo-shaped `primary.xml.gz`/`filelists.xml.gz`/`other.xml.gz`
    (+ `updateinfo.xml.gz` when any version carries errata updates),
    rendered in Go's encoding/xml shape — struct field order, explicit
    open+close pairs, EscapeText's escapes (`&#xA;` newlines, `&#34;`
    quotes — live-fired on the rpmbuild battery) — then `repomd.xml` with
    the compressed/uncompressed checksum+size pairs per data entry, and
    `repomd.xml.asc`, the armored detached RSA-SHA256 signature. All
    stored into the internal `_rpm` + `_repository` version keyed by the
    group (the family's OverwriteExisting posture), the empty-group arm
    deleting the group's own files (upstream wipes EVERY group there; the
    debian/alpine per-key posture kept — documented). The search mirrors
    the generic SearchFiles toConds (is_internal=false subselect, the
    `%.rpm` lower_name filter, the composite filter DROPPED for the empty
    group — package_file.go's own guard), order pinned to file lower_name.
  - **The signing posture (the keypair answer):** upstream serves the
    owner-scoped OpenPGP pair (`rpm.key.private/public`) as
    `repository.key` and signs repomd with `openpgp.ArmoredDetachSign` —
    exactly the debian twin's signer subset, so distro-common covers it
    unchanged; the third `rpm.key.created` row pins the OpenPGP key-packet
    creation time (the debian.key.created posture — the packet bytes must
    be STABLE or the key id/fingerprint would drift). The served uid is
    "(RPM Registry)" (go-crypto's NewEntity("", "RPM Registry", "")
    rendering — gpg verified it live, below).
  - **Documented reductions:** the upload-time package re-sign arm
    (`?sign=true` / DefaultRPMSignEnabled, upstream default OFF) is NOT
    ported — it needs the signature-region rewrite plus MD5 payload
    verification (WebCrypto has no MD5, the debian MD5 posture);
    rpmsign-signed packages pass through untouched. RSA-2048 (the
    Workers-cost divergence). The errata arm's 400 body is the engine's
    JSON error text (Go/V8 spellings differ).
  - **The routes:** the sibling `/rpm.repo` config (group "" — upstream
    api.go:423) plus the `/:username/rpm/*` wildcard walk
    (`parseRpmTarget`, the npm walk's precedent — the group spans
    segments upstream via chi's `<group:*>`, so every arm is
    tail-anchored). repository.key is GROUP-LESS (one owner keypair; the
    .repo gpgkey line points there for every group, rpm.go:51's exact
    body). The errata POST is a bounded 4 MiB JSON read; GET repodata
    never bumps the counter (IsLead=false), GET .rpm downloads bump per
    GET (packages.go:665-670's IsLead gate), the noarch fallback applies
    on download only (the delete arm is exact, rpm.go:259-328).
  - **Tests** (`packages-rpm.test.ts` 17/17, own-eyes): the CORE fixture
    is upstream's OWN test rpm (metadata_test.go's
    `base64RpmsignSignedPackage`, a real rpmsign-signed package, embedded
    byte-exact) — the parse-parity test asserts EVERY field value the Go
    test asserts (build time 1678225964, installed size 13, archive size
    272, the provides/requires/files/changelog sets); the round-trip
    asserts the repodata XML shape, the repomd checksums re-hashing the
    SERVED bytes, and the sig-armor structure; a hand-built minimal rpm
    (lead + sig section with a real SHA-256 + pad + main header) pins the
    exact-read walk and the noarch fallback; the rejection arms pin the
    lead magic, the digest mismatch, the oversized-array bound
    (metadata_test.go:200-209's arm), the D-1 409, the quota +1 parity,
    the 401 challenge, and PACKAGES_ENABLED=false. Neighbors re-run
    post-change: debian 12/12 + alpine 8/8 (no regression), the other
    protocol suites + blobs/cleanup/model/serve-content 190/190;
    check:api PASS (the /api/packages families sit outside the frozen v1
    swagger, the M6 precedent); tsc 0 in the touched files (the two
    remaining repo errors are another unit's in-flight src/services/
    actions/trigger.ts); scoped eslint clean.
  - **The LIVE battery (real clients, this host):** `rpm` 4.18.2 and
    `rpmbuild` are installed; dnf/yum/createrepo/createrepo_c/zypper are
    NOT (disclosed). `rpm -qp` on the upstream fixture read exactly the
    metadata the Go test asserts (the pre-upload parse parity); a real
    `rpmbuild`-built hello-rpm-1.2.3-2.x86_64.rpm was PUT via curl → 201,
    the served primary.xml.gz carries the real header's metadata (the
    description newline escaped `&#xA;`, the packager email `&lt;`,
    provides with EQ flags, size 6576/21/284), ALL TWELVE repomd
    checksum/size fields cross-verified against the served bytes
    (python3 gzip+sha256), the download round-tripped BYTE-IDENTICAL and
    `rpm -qp` parsed the downloaded copy, the served repository.key
    imported into a fresh GNUPGHOME verified repomd.xml.asc with
    `gpg: Good signature from "(RPM Registry)"` (rc=0 — the real OpenPGP
    crypto, the debian gpgv battery's twin), and the DELETE → 204 left
    the group's repodata 404ing while the persisted key still serves.
- **PENDING (the remaining M7 row):** arch (`api.go:118-126` +
  arch/router 305 ln + repository.go 400 ln + vercmp.go 105 ln — the
  PathGroup wildcard grammar, the pacman .db tar built from .PKGINFO desc
  files, the version-compare port), mirroring this substrate unchanged.

## As-built — M7 index-builder family, half three: arch (2026-10-31 — the registry carries ELEVEN protocols; the §7 M7 index-builder family is COMPLETE of its four non-git families, cargo alone pending)

The §2.1 M7 row's arch family landed: `services/packages/arch.ts` + the
arch route arms in `api/routes/packages-protocols.ts` (upstream
`routers/api/packages/arch/arch.go` 306 ln + `services/packages/arch/
repository.go` 401 ln + `vercmp.go` 105 ln + `models/packages/arch/
search.go` + `modules/packages/arch/metadata.go` 269 ln + the upstream
integration test `tests/integration/api_packages_arch_test.go` as the
client-shape oracle), over the same substrate unchanged. The
dual-tenant note: this section and the rpm half two above landed as one
disclosed wave in `packages-protocols.ts` — each family's hunks attributed
separately, neither unit touched the other's arms.

- **The generation posture** — unchanged (stored, not per-request): every
  upload/delete ends with `BuildSpecificRepositoryFiles` (arch.go:160/299 →
  repository.go:149-171) and the GET arm is a plain file lookup
  (arch.go:168-252). **The symlink dance resolved:** pacman's repo-add
  re-points the `{repository}.db` symlink at each new `.db.tar.gz`; upstream
  Gitea reproduces the CLIENT-VISIBLE effect with filename NORMALIZATION —
  every `.db`/`.db.tar.gz`/`.files`/`.files.tar.gz` spelling (plus the
  repository-generic `index.*`/`packages.*` spellings pacman clients emit)
  normalizes to the ONE stored `packages.db` of the internal `_arch` +
  `_repository` version under composite key `{repository}|{architecture}`
  (arch.go:186-197) — the integration test's six-name sweep
  (`packages.db`, `packages.db.tar.gz`, `index.db`, `index.db.tar.gz`,
  `index.files`, `index.files.tar.gz`, each with a working `.sig` arm)
  pins it. There is no literal symlink anywhere in the pin.
- **The .db format** (repository.go:237-321): ONE gzip member whose ustar
  carries the per-package pairs `{name}-{version}/files` + `{name}-{version}/
  desc` (files FIRST — repository.go:282-287), each a `%KEY%\nvalue\n\n`
  field document with empty values skipped and Mode `os.ModePerm` = 0o777;
  desc's 23-field order is the be_sync.c layout verbatim (FILENAME through
  CHECKDEPENDS, repository.go:353-379); FILES = the package's tar member
  names, and `joinFields` DROPS entries carrying \n or \r (the pacman
  line-forgery gate, repository.go:339-344 — the same gate lives at the
  parse side in metadata.go:158-160). The archive is signed (SignData, the
  RAW detached RSA-SHA256 packet — no armor) with the base64 stored as the
  index file's `arch.signature` property (the `{filename}.sig` arm decodes
  and serves it, arch.go:222-239); each desc's PGPSIG is the PACKAGE file's
  own stored signature property verbatim.
- **vercmp** (vercmp.go, ported whole): parseEVR's epoch=0/release=1
  defaults, numeric-vs-alpha segment ordering with the empty-segment-is-
  numeric and Go's ignored-Atoi-overflow quirks mirrored, the epoch →
  dot-split version → release ladder. Its registry consumer is the index
  build's highest-version fold (repository.go:225-235 — the pacman
  downgrade-hazard comment carried): a package's older versions never
  "downgrade" the entry; the upstream `vercmp_test.go` table (the two
  man-vercmp.8 chains + the three epoch/release arms) and
  `metadata_test.go`'s Regexp table (`1.2_3~4+5` valid, `a:1.0.0-1`,
  `0.0.1/1-1`, `1.0.0 -1` rejected) are pinned verbatim in the suite.
- **The PathGroup wildcard grammar** (api.go:118-126): `<repository:*>`
  spans segments AND matches EMPTY (the integration test's repository ""
  arms ride it — chi's catch-all); the literal tails pin the arms — GET
  `/<repository:*>/<architecture>/<filename>` (last TWO segments), DELETE
  `/<repository:*>/<name>/<version>/<architecture>` (last THREE), PUT's
  whole remainder IS the repository (TrimSpace'd, per arch.go:44 — the
  read/delete arms do NOT trim). Ported as the npm-family walk: the
  `/:username/arch/*` wildcard hands the raw remainder to a per-segment
  decoder (chi matches raw + unescapes per param — an encoded slash stays
  inside its segment), short remainders 404 at the walk. The bare
  `PUT /arch` (api.go:120's no-repository arm) and the static
  `repository.key` (arch.go:31-41, `application/pgp-keys`, ServeContent
  with no filename — no attachment disposition, the alpine key arm's
  contrast) register beside the wildcard; the static route outranks the
  wildcard for the key.
- **The any-arch folds** — unchanged from upstream: an `any` upload
  re-rolls EVERY architecture's index of the repository
  (repository.go:155-163 via GetArchitectures, models/packages/arch/
  search.go:25-36), every real-architecture index merges the any files in
  (repository.go:194-201) with their OWN `ARCH` field in desc (metadata.go
  writes FileMetadata.Architecture — unlike alpine's A: index-arch rule),
  and the serving arms fall back to `repository|any` (arch.go:204-216,
  uniform for index AND package files — the integration test's
  any/aarch64/myarch sweep).
- **Documented reductions:** `.pkg.tar.zst`/`.pkg.tar.xz` → 400 "unsupported
  package container format" (upstream's own sentinel — no zstd/xz codec in
  the substrate; workerd ships gzip only); the upload capped at 64 MiB
  (413) — SignData holds the whole document for the RFC 4880 hash framing
  (WebCrypto cannot stream it) and the parse materializes the walked
  members' payloads; desc omits `%MD5SUM%` (the blobs.ts three-digest
  posture — the empty field is skipped by writeFields, the debian
  precedent); the index member order is package lower_name/version
  ascending (upstream folds a Go map — random; the alpine paragraph-order
  precedent); `arch.key.created` pins the v4 key-packet creation time (the
  `debian.key.created` precedent — upstream freezes it inside the
  serialized openpgp entity, ours stores a raw PEM); userid
  `(Arch Registry)` mirrors upstream's `NewEntity("", "Arch Registry", "",
  nil)` comment-only rendering. **A platform record worth keeping:** the
  streaming DecompressionStream delivers ZERO output when the input has
  trailing bytes (the concatenated-multistream input errors before any
  chunk surfaces — probe-verified this unit), so the parse walks the
  members with distro-common's exact-length windows and concatenates the
  payloads (upstream Go gzip.Reader is multistream by default; the tar
  walk then stays incremental over the payload — only .PKGINFO's bytes and
  the member names retained, the tar.Next() posture).
- **Tests** (`packages-arch.test.ts` 21/21, own eyes): the vercmp table +
  EVR parser pins; the PKGINFO reader (the metadata_test.go Valid field
  sweep — xdata/backup/group/conflict/makedepend/checkdepend included —
  plus the rejection arms); the round-trip with the desc/files tar shape
  (exact member order files-then-desc, Mode 0o777 read off the header
  bytes, the field documents byte-shaped, the six index spellings serving
  IDENTICAL bytes each with a 200 .sig); the REAL crypto — the index .sig
  and the desc's PGPSIG both verify (WebCrypto RSASSA-PKCS1-v1_5 SHA-256)
  over the exact signed documents reconstructed from the packets' own
  hashed-subpacket areas (doc ‖ prefix ‖ trailer, RFC 4880 §5.2.4) against
  the n/e parsed out of the SERVED repository.key armor (the full OpenPGP
  framing end-to-end), each with a tampered-payload failure arm; the
  any-merge/fallback sweep; the KeepLastVersion vercmp fold (upload 1.0.0
  then 1.0.1 → only 1.0.1 in the .db; delete 1.0.1 → 1.0.0 restored); the
  delete arms' two 404 BODIES (the version miss's "resource does not
  exist" vs the file-search miss's EMPTY body — arch.go:268-275 vs
  :285-288); multi-segment + empty repositories; the unsupported-format,
  PKGINFO-less, 409, 401, quota and PACKAGES_ENABLED gates; the wildcard
  grammar's short-remainder 404s; the multistream concat fixture
  (end-block-less first member — Go's tar.Reader stops at the
  end-of-archive marker, so the parity shape continues into member B).
  Neighbors re-run post-change: debian 12/12 + alpine 8/8 (the
  sibling-counted 20/20), blobs/cleanup/model/serve-content/spike-streams
  + generic 120/120, npm/nuget/pypi/helm/maven/container 145/145;
  check:api PASS (the /api/packages families sit outside the frozen v1
  swagger, the M6 precedent); tsc 0 in the touched files (the remaining
  tree errors are other units' in-flight files — actions expression-syntax/
  trigger, export-subst); scoped eslint clean.
- **The LIVE battery (real clients, this host):** `pacman`, `repo-add`,
  `makepkg` and `pkgfile` are NOT installed (disclosed — the alpine `apk`
  precedent). The live arms were the byte-level battery: upstream's OWN
  test vectors (vercmp_test.go's table, metadata_test.go's Regexp + Valid
  sweeps, the integration test's six-name sweep / KeepLastVersion shape /
  the `with/slash` + empty-repository arms) replayed against the real D1 +
  R2 bindings, plus the WebCrypto signature verifications above — the
  desc PGPSIG verifies over the UPLOADED package bytes and the index .sig
  over the SERVED .db bytes, both against the n/e of the served armor
  (the debian gpgv battery's in-suite twin). A future `pacman -Syu`
  battery (a repo-add-built sync db cross-checked against ours) is the
  residual, gated on a host with pacman.

## As-built — the long-tail `go` family: the Go module proxy protocol (2026-10-31 — the registry carries TWELVE protocols)

The §2.1 long-tail row's `go` family landed: `services/packages/goproxy.ts`
+ the api.go:305-316 route arms in `api/routes/packages-protocols.ts`
(upstream `routers/api/packages/goproxy/goproxy.go` 223 ln +
`modules/packages/goproxy/metadata.go` 103 ln + the upstream integration
test `tests/integration/api_packages_goproxy_test.go` as the client-shape
oracle), over the same substrate unchanged (no new tables — the go.mod
text is a version-scoped package_property row, the zip the ONE lead file
`{version}.zip`, the blob bytes verbatim through the two-pass store).

- **The endpoint map (pin cites):** `PUT /go/upload` (api.go:306, write) →
  UploadPackage; `GET /go/sumdb/sum.golang.org/supported` (api.go:308) →
  `http.NotFound` — the checksum-DB mirror probe answers the Go not-found
  page, the protocol's "this proxy does not mirror sum.golang.org"; the
  PathGroup (api.go:309-316) reads `/{name}/@latest`,
  `/{name}/@v/list`, `/{name}/@v/{version}.zip/.info/.mod` with the whole
  group wrapped in reqPackageAccess(read). chi's `<name:*>` is greedy
  (`.*`), so the LAST `@latest`/`@v` marker wins (a module path may carry a
  `@v` segment); `<version>` is `[^/]+` — an empty version tail (`.zip`
  with nothing before the dot) falls off the grammar. Ported as the npm
  walk: the `/:username/go/*` wildcard hands the raw remainder to
  `parseGoTarget` (decode-once-fully, the npm path discipline); the statics
  (`upload`, the sumdb probe) outrank the wildcard; chi runs the group
  middleware BEFORE the router 404s, so the gate stack precedes the
  not-found page.
- **The 404/410 missing contract:** the protocol lets a proxy answer 404 OR
  410 for a missing module/version (the go tool treats the pair alike);
  upstream answers uniformly 404 — the list miss is `apiError(404, nil)`
  (the EMPTY body, goproxy.go:35-37), the resolve misses carry
  ErrPackageNotExist's "package does not exist" (goproxy.go:54-56/:93-95);
  410 appears nowhere in the pin, so this family serves 404 and never 410.
  Unmatched shapes serve chi's router page ("404 page not found\n",
  text/plain; charset=utf-8 + nosniff) AFTER the gate.
- **The parse (metadata.go:37-103, go.dev/ref/mod#zip-files):** the module
  name and version come from the FIRST central-directory entry whose
  path.Dir carries `@` (SplitN "@" 2 → SplitN "/" 2); the version is gated
  by x/mod/semver.IsValid (→ 400 "package version is invalid"); entries
  below the `{module}@{version}/` root are skipped; the first root-level
  go.mod reads as the version PROPERTY `go.mod` (16 MiB recorded-size cap
  → 400, metadata.go:20); no `@`-entry → 400 "package has invalid
  structure"; `@`-entries but no root go.mod synthesize `module {name}`
  (metadata.go:100). The zip bytes store VERBATIM (IsLead), so downloads
  are byte-parity by construction.
- **The version grammar:** `isGoSemverValid` is x/mod/semver's parse ported
  anchor-for-anchor (parseInt's leading-zero rule, the prerelease's
  numeric-identifier rule, the build's laxer identifiers). Short forms
  (`v1`, `v1.0`) are VALID (the parse short-circuits), and Go's
  pseudo-versions (`v0.0.0-20230101000000-abcdefabcdef`) are simply
  canonical semver with a prerelease — there is no separate pseudo-version
  grammar in the pin. The upstream metadata_test.go arms + the x/mod
  acceptance/rejection table are pinned in the suite.
- **Wire shapes:** @v/list renders one version per line, CreatedUnix ASC
  (the handler's sort.Slice — ours adds the id tiebreak for determinism),
  text/plain;charset=utf-8, 404-EMPTY when the module is unknown;
  @latest/{version}.info answer ctx.JSON's `{"Version", "Time"}` in
  declaration order, application/json;charset=utf-8 (base.go:112-119) —
  Time renders RFC3339Nano with the UTC `Z` (the AsLocalTime reduction:
  workerd has no TZ database; upstream's second-granular column never
  emits a fraction, and neither do ours); {version}.mod serves the stored
  property verbatim (a missing property is upstream's 500 — the prod body);
  {version}.zip rides helper.ServePackageFile → the D-6 serve set with
  application/octet-stream (ServeSetHeaders' IfZero default — serve.go:75,
  the zip is NOT sniffed) and the lead GET counter bump (packages.go:664-668).
  Upload error mapping (goproxy.go:172-180/:211-217): the three
  ErrInvalidArgument sentinels → 400; ErrDuplicatePackageVersion → 409
  ALWAYS (allowDuplicate=false — even same bytes, the integration test's
  conflict arm); quota → 403 (the +1 count parity, the landed sweep's
  shape); zip.NewReader's plain error and a duplicate FILE row hit the
  DEFAULT arm → 500. "latest" resolves via SearchLatestVersions
  (`len != 1` → not exist), the max(id)-per-package shape.
- **Documented reductions:** the upload capped at 64 MiB (413 — the
  nuget/arch parse-family precedent; upstream spools with no explicit cap,
  ours materializes for the zip walk); the self-hosted zip reader is
  self-contained in goproxy.ts (EOCD + central-directory walk, stored +
  deflate-raw, the bomb gate — nuget's extractor is module-private); the
  lying-Content-Length store failure maps 500 (the npm/nuget
  non-InvalidArgument posture); wrong-method requests on read shapes fall
  off the sub-app (Hono) where chi would answer 405 — the helm/pypi mount
  precedent.
- **Tests** (`packages-go.test.ts` 22/22, own eyes): the round-trip (201 →
  the type "go" package + version + the go.mod property + the lead
  {version}.zip; list order via a pinned created_unix; @latest vs .info;
  byte-parity zip with the disposition + the counter bump — HEAD never
  counts); the zip layout arms (below-root skip → synthesized `module
  {name}`, greedy first-@ capture, short `v2` acceptance, non-semver 400,
  no-@-entry 400, corrupt body 500, the recorded-size go.mod cap 400, the
  deflate arm + the zip-bomb gate 500, the always-409 re-publish with the
  property-not-doubled assert); the semver table (14 valid + 16 invalid
  forms incl. pseudo-versions, short forms, leading zeros, bad prerelease
  numerics, non-ASCII, empty identifiers); the 404/410 contract (the EMPTY
  list-miss body; "package does not exist" on every resolve miss; the
  router page for unmatched shapes; the sumdb probe); the auth/quota arms
  (401 challenges, public-anonymous/private-challenge reads incl. the sumdb
  probe's gate, the size + +1-count 403s with the admin bypass,
  PACKAGES_ENABLED=false, the unknown-owner redirect message, the service
  seams for the 64 MiB cap + the archive sentinel). Neighbors re-run
  post-change: debian + alpine + rpm + arch 58/58.
- **The LIVE battery (real client, this host):** `go` 1.25.1 linux/amd64 IS
  installed — the full proxy round-trip ran against the real dev server
  (vite + workerd, local D1 + R2, the bootstrap-admin PAT): a two-file
  module zip (`goproxy.local/hello@v1.0.0/go.mod` + `hello.go`, built with
  python zipfile in a scratch dir) PUT → 201 (duplicate → 409); curl swept
  the shapes (list 200 "v1.0.0\n" then the pseudo-version; @latest → the
  newest row; .info RFC3339; .mod verbatim; .zip 200 size=625 = the exact
  upload size; sumdb probe 404 page); then the REAL client:
  `GOPROXY=http://127.0.0.1:5174/api/packages/goproxyer/go GONOPROXY=none
  GONOSUMDB='*' GOFLAGS=-mod=mod go mod download goproxy.local/hello` →
  exit 0 (the module cache holds `list`, `v1.0.0.info`, `v1.0.0.mod`,
  `v1.0.0.zip` + ziphash — the client fetched ALL FOUR shapes from this
  family), `go build -buildvcs=false` → the consumer binary printed
  "hello from the cf-gitea proxy" (the served zip's code compiles and
  runs), the pseudo-version `v0.0.0-20230101000000-abcdefabcdef` downloaded
  (exit 0, both versions' go.sum h1: hashes computed from OUR bytes), and
  the missing-version arm through the client (`v1.9.9`) reads the 404
  verbatim: "server response: package does not exist" — the protocol's
  missing-module contract end-to-end. Two client postures disclosed:
  `GOPRIVATE='*'` is WRONG for a GOPROXY-only host (it sets GONOPROXY too —
  go bypasses the proxy for VCS fetch); the working posture is
  `GONOPROXY=none GONOSUMDB='*'` (proxy everything, skip the checksum DB —
  consistent with the sumdb probe's 404). A `-buildvcs=false` consumer
  build (the scratch dir sits outside any git repo; VCS stamping fails in
  /tmp — client-side, not a proxy behavior).
- **Independent re-verification (the gap-fill unit, same day):** the whole
  gate set re-run with own eyes against the final bytes — the suite 22/22,
  the neighbors (debian + alpine + rpm + arch) 58/58, check:api PASS, bare
  tsc zero errors in the family's files, scoped eslint clean — plus a
  second live battery (user `gobattery`, the 5173 server, module
  `gitea.local/battery/hello`): upload 201 → list/@latest/sumdb-probe via
  curl; `go mod download` exit 0 (cache holds `list`, `.info`, `.mod`,
  `.zip` + ziphash), and the UNPINNED `go get` resolving through `@latest`
  → the version row added. **The checksum parity assert:** the go.sum h1
  the client pinned (`h1:d26unde…LdI=`) equals `dirhash.HashZip(zip,
  dirhash.Hash1)` (golang.org/x/mod@v0.42.0, the authoritative library)
  computed over OUR uploaded zip — the H1 dirhash is over the EXTRACTED
  files, not the zip bytes, and the client's acceptance of our served
  bytes is what produced the hash. The mission's literal command
  (`GOPROXY=… GOFLAGS=-mod=mod go mod download`, default GOSUMDB) fails by
  design: the client honors our /supported 404, goes DIRECT to
  sum.golang.org, and the public DB rejects a private module — the
  disclosed private-module posture (`GONOSUMDB='gitea.local/*'`) is the
  fix, upstream's own contract working as intended. The battery's PAT row
  was deleted and its 0600 token file shredded after the run.

## As-built — M7 tail: cargo (2026-10-31 — the registry carried THIRTEEN at this landing; TWELVE was the go heading's count — a heading drift caught in the doc sweep; the census's sparse-index family lands, the git mirror stays its own milestone)

Upstream `routers/api/packages/cargo/cargo.go` + `services/packages/cargo/index.go` +
`modules/packages/cargo/parser.go` at the pin, ported as `src/services/packages/cargo.ts`
+ the cargo arms in `packages-protocols.ts` (the section after the GO family —
the file's per-family split). Mount: the sparse-index family over
`/api/packages/{owner}/cargo` — `GET config.json` (index.go:260-272:
`{dl, api, auth-required}`; `auth-required` = the non-public owner — the
`RequireSignInViewStrict` OR-arm is off-by-default and not carried in our
config surface), the sparse index through all FOUR path shapes
(`/1/{p}`, `/2/{p}`, `/3/{_}/{p}`, `/{_}/{__}/{p}` — the placeholders are
dummies, the name is the last segment; registration order mirrors upstream
api.go:129-145, statics first so the generic 3-segment shape cannot shadow
the search route), `GET api/v1/crates` search, `PUT api/v1/crates/new`
publish, `GET .../{p}/{v}/download` (byte parity, the lead-file GET counter),
`DELETE .../yank` + `PUT .../unyank`, `GET .../{p}/owners`.

**The index storage posture (the family's one real decision, recorded):**
upstream maintains the `_cargo-index` GIT repository (index.go:24) as the
traditional git-protocol mirror, but the sparse HTTP endpoints never read it
— `EnumeratePackageVersions` derives every NDJSON line from D1 at request
time (cargo.go:66-87 → BuildPackageIndex, index.go:139-183), and
`UpdatePackageIndexIfExists` itself defines the seam this port rides:
"cargo http index does not rely on the repo itself, so if the repo does not
exist, we just do nothing" (index.go:94-99). Our tree never creates the repo
(§1 keeps it a SPEC-attached milestone), so `updateCargoPackageIndex` is
permanently the repo-absent arm — one repositories-row probe keyed
owner+`_cargo-index`, then the no-op (a present row logs the reduction). Every
write arm still calls it at upstream's call-site shape, so the git-mirror
milestone hangs off one seam.

As-built pins: the .crate publish container (`uint32-LE metadata length |
metadata JSON | uint32-LE content length | .crate bytes`, parser.go:57-71;
32 MiB metadata cap, limited_reader.go:14 → 400 "content exceeds the size
limit"; short content → 400 "invalid content size" cargo.go:181-184; TRAILING
bytes past the declared length are the upstream LimitReader truncation and
succeed); the name regex `\A[a-zA-Z][a-zA-Z0-9-_]{0,63}\z` + hashicorp/go-version
`NewSemver` via npm.ts's `parseGoSemver` port (parser.go:53/:63); the rename
resolution (`explicit_name_in_toml` names the dep, the original moves to
`package`, parser.go:105-124); non-absolute http(s) URLs blank out
(parser.go:66-71). The index-entry line is `IndexVersionEntry` struct order —
`{name, vers, deps, cksum, features, yanked, links?}` with deps nil → [] and
features nil → {} (index.go:157-165), cksum = the LEAD file's blob sha256
(index.go:171), yanked from the `cargo.yanked` version property
(strconv.ParseBool ignored-error → false), links omitempty; served as
text/plain NDJSON, one line per version, in upstream SortVersionAsc order —
`ORDER BY version ASC, id DESC`, the RAW version string (package_version.go:
287-294 — NOT a semver-aware sort: `1.0.10` sorts BEFORE `1.0.2`; recorded
because cargo clients expect semver order, and upstream-parity wins until a
real client pins otherwise). Zero versions → the nil-index 404 with the EMPTY
detail (cargo.go:80-82 → apiError(404, nil)). Every error answers the
StatusResponse wrap `{"ok":false,"errors":[{"detail":…}]}`, every success
`{"ok":true}` (cargo.go:19-49), 500s stripped to "internal server error"
(helper.go:30-49 prod posture). Divergences recorded in cargo.ts's header:
the transport cap is the store's 512 MiB (upstream cargo carries no
MaxBytesReader), container parse error messages are JS text where upstream
carries Go runtime text (the status and wrap are exact), and the yank walk's
"Property not found" 500 (cargo.go:256-259) answers the stripped prod body.

The cleanup rider (upstream cleanup.go:108-118) LANDED with the family, per
§4.4 above — inside `executeCleanupOneRule`'s package loop, per package that
lost a version, `rule.type === "cargo"` gated, DISTINCT from the four distro
families' post-loop rebuild (the df868d2 record's "stays unwired" note is
superseded). Suites: cargo.test 17/17 (publish round-trip through every
sparse shape + the D1 posture, the rename resolution, the string-sort
ordering pin, the nil-index 404, config.json's private-owner arm, search
clamps, owners, download byte-parity/counter, yank/unyank index flips, the
parser sentinels incl. the 65-char name + the parser_test.go invalid-version
set, short-content 400 + trailing-bytes OK, 409/403/401 arms,
PACKAGES_ENABLED=false) and cleanup.test 22→24 (the rider arm: per-package
loop shape over two cargo packages, the repo-row-present arm resolving, no
internal `_cargo` rows fabricated). The REAL-CLIENT battery rode cargo
1.94.0 against the live dev server (5174; a disclosed local python shim
proxied 9911→5174 stripping the `Upgrade: h2c`/`HTTP2-Settings` headers the
miniflare-beta dev dispatch crashes on — client-side only, the PROTOCOL
arms were exercised unmodified): server-side publish via curl with
`Authorization: token <PAT>` → `{"ok":true}` 200; `cargo fetch` in a
consumer crate → config.json 200 (cargo parsed `{dl, api}`), the sparse
index GET `cf/-b/cf-battery` 200 (cargo's own two-line version resolution
picked 0.1.1 over 0.1.0), the `dl` download 200 with the cache file's
sha256 `ad5ab0f7…df68fc` == the stored payload, and `cargo build` COMPILED
the crate — cargo's cksum gate accepted our served bytes. The PUBLISH side
from the real client is a documented PARITY WALL, not a bug: cargo 1.94's
credential provider sends `Authorization: <token>` BARE (header captured
live), and upstream's own auth chain at the pin accepts only the 2-part
`token|bearer|Basic` grammar (httpauth.ParseAuthorizationHeader, basic.go
parseAuthBasic — both trees identical), so a bare-token `PUT /new` answers
401 against upstream Gitea TOO (verified against the pin's source; live
`cargo publish` here reproduced the 401 with the gate challenge body). The
bare-token acceptance would be a cross-family divergence beyond the pin —
recorded as an open question for the orchestrator, NOT landed. Battery
teardown: the battery user row deleted, the PAT swept, the 0600 token file
shredded.

## As-built — M7's deferred half: the `_cargo-index` git mirror (2026-11-01 — index.go ported as the rowless engine cell; the §1 carve-out and the §2.1 census "deferred" tail flip with this section)

Upstream `gitea/services/packages/cargo/index.go` (the whole file: config.json
root, the 1|2|3/{name} per-package NDJSON files, delete-side removals, the
initial-branch setup) at the pin, ported as
`src/services/packages/cargo-index.ts` with the hook seam extended in
`cargo.ts` (`updateCargoPackageIndex`'s 4th arg + the `cargoIndex` field on
the publish input and the yank/unyank walk).

**The three adjudications the mission demanded, recorded:**

1. **Incremental per package, never a per-write rebuild.** Upstream's write
   arms (publish cargo.go:247, yank/unyank cargo.go:298, the cleanup rider
   cleanup.go:115) all funnel into `UpdatePackageIndexIfExists`, which
   rewrites exactly ONE package file — `addOrUpdatePackageIndex` over that
   package's full version list (index.go:198-208) — and the whole-tree
   `RebuildIndex` (index.go:63-106) is a separate explicit operator action,
   never a write-arm behavior. Ours keeps that shape: each write recomputes
   the ONE package's NDJSON from D1 (`buildCargoPackageIndex`, the same
   builder the sparse face serves) and rewrites its file; the RebuildIndex
   port (`rebuildCargoIndexMirror`) exists for the operator button. One
   deliberate write-arm divergence: upstream LEAVES a package's index file
   behind when its last version disappears (BuildPackageIndex's zero-version
   nil → addOrUpdatePackageIndex no-ops, index.go:154-156/203-205 — the stale
   line-file survives until a manual Rebuild); OURS REMOVES it — the mirror's
   source of truth is D1 (the sparse face 404s an emptied package), so
   matching the sparse face (and upstream's own RebuildIndex output) is the
   more faithful of the two observable behaviors.
2. **The hiding posture — rowless cell, hidden by construction.** Upstream
   creates the index as a REAL repositories row (`CreateRepositoryDirectly`,
   index.go:210-226) and does NOT hide it from listings (no models/repo filter
   at the pin — the repo shows on the owner's profile). Our substrate's
   pattern for infrastructure repositories is the wiki sibling: a bare engine
   cell with NO D1 row and NO registry entry, invisible to every listing, the
   site index, and the git gate's registry-existence oracle. The mirror is
   that: the cell `<owner>/_cargo-index` (wikiCellName's combined-name
   convention). Divergences bought: upstream's index repo is user-visible and
   cloneable at `{origin}/{owner}/_cargo-index.git` — ours is hidden and the
   git-URL face 404s until a wiki-style gate family teaches the gate the
   marker (gate.ts is not this module's surface; the CONTENT is maintained so
   that face is one seam away — and the sparse `+sparse+` face cargo clients
   actually use never reads the repo). Owner renames strand the cell at the
   old namespace (upstream renames it automatically): the next write after a
   re-initialize re-seeds at the new name, untouched packages reappear on
   their next write or a rebuild.
3. **Best-effort landings (the webhook-fan posture, disclosed).** Upstream
   FAILS the publish when the index write fails and ROLLS THE VERSION BACK
   (cargo.go:247-254). Ours logs and continues — a failed mirror write heals
   on the next write of the same package or a rebuild. Commit identity:
   upstream's `CommitTreeUserOptions{DoerUser: doer}` — publish/yank commit
   as ctx.Doer, the cleanup arm as owner,owner (cleanup.go:115); ours
   resolves the hook's `doerId` row (publish/yank) or the owner row, with the
   house noreply fallback `<username>@noreply.<origin hostname>` for a null
   email (upload-staging's convention; the hostname comes from the bindings'
   origin because the cleanup consumer runs off-request).

**Shape:** `ensureCargoIndexMirror` (InitializeIndexRepository: get-or-create —
the config root commit over the unborn cell, the engine seats HEAD on the
first branch — and a config re-stamp on a born one; upstream commits on every
click, ours skips when the bytes are already current, the one micro-divergence),
`updateCargoIndexMirror` (the present arm: unborn → the upstream repo-absent
no-op verbatim, index.go:108-111 "We do not want to force the creation of the
repo here"; else one file rewritten/removed via the mirror's own level-chain
tree builder + `putApiObjects`/`commitApiChange` CAS with ONE conflict retry —
the shared contents builder is NOT reused because its level map never
registers fresh intermediate directories, dropping 2+-level creates), and
`rebuildCargoIndexMirror` (RebuildIndex: one whole-tree replacement commit,
config.json preserved from the live cell, emptied packages vanish). The tree
lands at 100644 blobs under the canonical shard dirs; the branch is `main`
(upstream's repo.DefaultBranch = the DEFAULT_BRANCH setting; our repo rows'
birth value). The engine's 8 MiB `putApiObjects` budget bounds a rebuild — a
registry past it answers `too_large` on the explicit action instead of
failing.

**The collision guard:** a `repositories` ROW at `owner/_cargo-index` means a
USER owns the address (our design never creates one; `isUsableRepoName`
allows it). Upstream would find that repo and commit the index INTO it; ours
refuses — every mirror arm (ensure/update/rebuild and the `updateCargoPackageIndex`
seam) probes the row first and logged-skips. This repurposes the old seam
probe (which used to log "the mirror is not maintained") into the guard; the
cleanup.test expectations (row present → resolves; absent → resolves) hold
unchanged.

**Wiring (dormant until mounted — the routes are recipe-owned):**
`updateCargoPackageIndex(d1, ownerId, packageId, cargoIndex?)` is the one
seam; `cargoIndexBindings(env, requestOrigin?)` builds the hook bindings
(`APP_URL` → request origin → localhost). Mount lines for the recipe wave:
the publish arm passes `cargoIndex: { bindings: cargoIndexBindings(c.env),
doerId: doer.id }` (the service already pins doerId from its own `doer` when
the field is present); the yank/unyank arms the same; cleanup.ts's rider
(:451) threads the struct as the 4th arg; the settings buttons call
`ensureCargoIndexMirror` / `rebuildCargoIndexMirror`. Until then every arm
stays the upstream no-op — the mirror only ever exists where ensure ran.

**Suites (own eyes):** cargo-index.test 16/16 solo (real-cell: the config
root commit with the exact `json.Encoder`-newline bytes, the idempotent
"current" + visibility-flip "updated" arms, the unborn no-op with NO cell
created, upload → tree with the exact NDJSON line and cksum == payload
sha256, the 1.0.10-before-1.0.2 string-sort rewrite, yank/unyank flag flips
in the file, delete → removed with the emptied `do/om` dir-chain collapse and
surviving siblings, the never-mirrored zero-version "unchanged", the
collision-guard freeze, the rebuild's stale-file purge + get-or-create,
the doer/owner identity + noreply fallback); cargo.test 17/17 (unchanged —
the hook is optional); cleanup.test 25/25 (the rider's repo-absent and
row-present arms both resolve through the extended seam). `tsc --noEmit`
carries zero cargo-family errors (the tree's remaining errors are the
webauthn/two-factor wave's in-flight files); scoped eslint on the three
touched files exits 0.

## As-built — the long-tail `swift` family: the Swift package registry protocol (2026-10-31 — the census's Swift registry lands; the registry carries FOURTEEN protocols)

Upstream `routers/api/packages/swift/swift.go` (507 ln) +
`modules/packages/swift/metadata.go` (258 ln) at the pin, with
`tests/integration/api_packages_swift_test.go` + the module's
`metadata_test.go` as the shape oracles, ported as
`src/services/packages/swift.ts` + the swift arms in `packages-protocols.ts`
(the section after the CARGO family; the walk + wire helpers in the file's
per-family helper split). Mount: `/api/packages/{owner}/swift` over
`POST ""`/`POST /login` (CheckAuthenticate — the UNAUTHENTICATED group,
api.go:452-455: Doer-nil is the only check, any valid credential passes
REGARDLESS of token scope; the bare 200 carries NO Content-Version), the
`{scope}/{name}` family (enumerate bare + `.json`, the chi PathGroup
`/*` shapes `<version>` / `<version>.json` / `<version>.zip` /
`<version>/Package.swift` / PUT `<version>`, api.go:462-468) and
`GET /identifiers?url=…` (api.go:470). The scope/name/version params are
chi `[^/]+` single segments — the walk decodes PER SEGMENT (the arch
precedent); the `.json`/`.zip` suffix routes strip their suffixes the way
chi's static-tail branches win over the bare param route (a valid package
name can never carry a dot — namePattern), so `1.0.0.exe` rides the BARE
version route into the metadata lookup's Problem 404 while a four-segment
shape runs the read gate then chi's router page (the go family's
gate-before-404 posture).

- **The storage posture (unchanged substrate):** the zip stores VERBATIM as
  the ONE lead file `{name}-{version}.zip` (byte-parity downloads by
  construction); the manifest texts + author + description/keywords/
  license/licenseURL/codeRepository ride the version's MetadataJSON (the
  SwiftMetadata shape, upstream tag order, Go's sorted-map manifests keys);
  `swift.scope`/`swift.name` are PACKAGE properties; each metadata
  `repositoryURLs` entry becomes a `swift.repository_url` VERSION property
  (insert errors logged, never fatal — swift.go:411-416); the package id is
  `scope.name` with `SemverCompatible` true.
- **The version grammar = hashicorp/go-version v1.9.0** (gitea/go.mod; the
  source verified against the real library on this host): the upload gate
  and the manifest filename/tools-version gates ride `NewSemver`
  (SemverRegexpRaw — the prerelease REQUIRES its separator), the
  `swift-version` query param rides `NewVersion` (VersionRegexpRaw — the
  laxer `-?` letter form). Ported anchor-for-anchor: parse/String()/
  TrimmedVersionString/Compare, quirks included (the letter class
  `[-A-Za-z~]` EATS a trailing hyphen, so NewVersion accepts `1.0.6-`
  rendering "1.0.6--" while NewSemver rejects it — the integration test's
  upload-400 arm; numeric prerelease parts sort BELOW non-numeric ones;
  1-2 segment forms canonicalize to three). Enumerate sorts
  SemVer.LessThan ASC (id tiebreak for determinism) with the Link
  `rel="latest-version"` carrying the LAST row's RAW version while the
  releases map keys render `SemVer.String()` — a "1.0" upload enumerates
  under "1.0.0" with the Link pointing at the raw "1.0".
- **The parse (metadata.go:118-245):** the SELECTED manifest set is the
  SHALLOWEST manifest directory, ties by dir name, never archive order —
  the nested-package rule (test fixtures/examples must not replace the
  package manifest; `swift package archive-source`'s single top-level dir
  and the leading-slash entry are pinned by the metadata_test.go arms).
  Caps ride the RECORDED uncompressed sizes: 128 KiB per file, 64 files,
  8 MiB total. The default (no-suffix) manifest MUST exist. The optional
  metadata form part decodes as the schema.org SoftwareSourceCode document
  with Go's case-insensitive field fallback; codeRepository/licenseURL
  validate as absolute http(s) (else blanked — validation.IsValidURL) while
  `repositoryURLs` is NOT validated; an absent author name synthesizes from
  given/middle/family (`Person.String()`).
- **Wire shapes:** every swift response carries `Content-Version: 1`
  (setResponseHeaders) EXCEPT CheckAuthenticate's 200; errors are the RFC
  7807 Problem document `{"status",detail}\n` over
  application/problem+json (json.Encoder's trailing newline; ProcessErrorForUser
  semantics: an err's message, fmt.Sprint of a string, "" for nil; 500s
  stripped to the prod body). Enumerate renders Go's key-sorted map over
  baseURL'd RAW-version URLs (`{"releases":{…}}`); metadata renders the
  declaration-order PackageVersionMetadataResponse + SoftwareSourceCode
  (the resources pair names the source-archive with the blob sha256 as
  checksum; author present only when ANY name part is set;
  `repositoryURLs` omitempty); DownloadPackageFile sets
  `Digest: sha256=<hash>` + application/zip through the D-6 serve set with
  the lead GET counter bump (HEAD never counts); DownloadManifest serves
  the stored text verbatim as text/x-swift (the query param normalized
  through NewVersion+TrimmedVersionString — `5.6.0` → `5.6`), a MISS
  answering 303 SeeOther with the bare RAW Location (no query param). The
  Accept media-type contract: a PRESENT-but-different Accept answers the
  400 Problem naming the required type on every read shape + the PUT
  (absent/empty passes — swift.go:96).
- **Documented reductions:** the multipart/urlencoded body capped at 64 MiB
  (413 — the goproxy/nuget parse-family posture; upstream spools with no
  cap, ours materializes for the multipart walk); the metadata part bounds
  at upstream's own 32 MiB MaxMetadataSize (limited_reader.go:14 — an
  over-size document errors the JSON decode upstream, the 500 default arm);
  a corrupt zip / a zip-bomb-shaped archive / an undecodable metadata JSON
  are PLAIN errors upstream → the DEFAULT arm → 500 (only the
  ErrInvalidArgument sentinels answer 400; an empty metadata VALUE part is
  FormValue's "" → the nil reader — ABSENT, while an empty FILE part still
  fails the decode); a vanished R2 content object answers the honest 404
  (the families' sole-sweeper posture); wrong-method requests fall off the
  sub-app where chi would answer 405 (the helm/pypi mount precedent);
  JSON rendering via JSON.stringify (no Go Marshal HTML escaping — the
  landed families' wire posture); `GET /swift` bare falls off the sub-app
  (upstream chi answers the router page — no route there either).
- **Tests** (`swift.test.ts` 27/27 + `packages-swift.test.ts` 20/20, own
  eyes): the parse battery against the metadata_test.go oracle (the
  selection-tie arms incl. the prefixed-archive + leading-slash +
  name-decides cases, the 64-file boundary at > not >=, the recorded-size
  lies firing the caps without materializing bytes, the deflate arm +
  bomb gate, the metadata decode arms incl. author synthesis + URL
  validation + the EMPTY document); the TrimmedVersionString table; the
  go-version port tables (String canonicalization, Compare incl. the
  numeric-below-non-numeric prerelease rule and the jagged segments, the
  strict/lax acceptance split verified against go-version v1.9.0 itself);
  the route battery's round-trip (201 → the properties + MetadataJSON +
  the lead `{name}-{version}.zip`; the always-409 re-publish that must not
  double a property row; byte-parity download with the Digest header + the
  counter bump), the Accept contract sweep over all seven shapes, the
  SemVer-sorted enumerate with the Link header + the `.json` twin, the
  metadata document's exact shape, the manifest default/trim/303 arms, the
  identifiers trio, the login probe pair's 401-Problem-vs-bare-200 split,
  the bad-scope/name/version triples (the go-version error text as the
  Problem detail), the auth challenges, the +1 count boundary + the size
  cap + the admin bypass, PACKAGES_ENABLED=false, the unknown-owner
  redirect message, the gated-vs-ungated 404 split, and the walk grammar's
  suffix/gating table. NO live swift client battery — no swift toolchain on
  this host (the hand-built zip + multipart fixtures are the battery, the
  rpm/arch builder pattern); the wire shapes were pinned against the
  upstream integration test's assertions instead of a real
  `swift package` run — flagged as the follow-up when a toolchain host is
  available. Neighbors re-run post-change: debian + alpine + rpm + arch +
  go + helm + nuget 112/112; check:api PASS; scoped eslint clean; bare tsc
  zero errors in the swift files (a concurrent rubygems unit's in-flight
  file carried the only repo-visible tsc error — not this unit's).

## As-built — the long-tail `rubygems` family: the RubyGems registry protocol (2026-10-31 — the registry carries FIFTEEN protocols)

The §2.1 long-tail row's `rubygems` family landed: `services/packages/rubygems.ts`
+ the api.go:437-447 route arms in `api/routes/packages-protocols.ts`
(upstream `routers/api/packages/rubygems/rubygems.go` 466 ln +
`modules/packages/rubygems/marshal.go` 312 ln + `metadata.go` 247 ln at the
pin fc493688, with `tests/integration/api_packages_rubygems_test.go` as the
client-shape oracle), over the same substrate unchanged (no new tables; the
Metadata struct serializes into the version row's MetadataJSON, the .gem
bytes store VERBATIM as the ONE lead file through the two-pass store).

- **The endpoint map (pin cites):** the whole `/rubygems` group carries
  reqPackageAccess(read) (api.go:447), the `/api/v1/gems` subgroup adding
  write (api.go:445-446): `GET /specs.4.8.gz` → EnumeratePackages (every
  version, GetVersionsByPackageType), `GET /latest_specs.4.8.gz` →
  EnumeratePackagesLatest (SearchLatestVersions), `GET
  /prerelease_specs.4.8.gz` → EnumeratePackagesPreRelease (ALWAYS the empty
  list — rubygems.go:59-61), `GET /quick/Marshal.4.8/{filename}` →
  ServePackageSpecification, `GET /gems/{filename}` → DownloadPackageFile,
  `GET /info/{packagename}` → GetPackageInfo, `GET /versions` →
  GetAllPackagesVersions (the compact-index pair, rubygems.org-compact-index
  shaped, rubygems.go:300-302), `POST /api/v1/gems` (+ its `/` twin — chi's
  group-index shape, the pypi double-registration precedent) →
  UploadPackageFile, `DELETE /api/v1/gems/yank` → DeletePackage. HEAD rides
  the download/gemspec GET walks (the pypi/helm precedent — upstream
  registers GET only); the enumerations stay GET-only (the helm index.yaml
  precedent).
- **THE MISSION-BRIEF CORRECTION — the pin parses YAML, not Marshal:** the
  mission brief said the gem container's metadata.gz holds "the Marshal-4.8
  spec"; at the pin it is a gzipped YAML document with `!ruby/object:Gem::*`
  tags (Ruby's `Gem::Specification#to_yaml` output) parsed by
  go.yaml.in/yaml/v4 into a typed gemspec struct (metadata.go:184), and
  `marshal.go` is ENCODER-ONLY — grep-verified: no `MarshalDecoder` exists
  anywhere in the pin tree (the historical decoder was removed when the
  parse moved to YAML). Marshal 4.8 remains the wire format on the READ
  sides: the specs.4.8 enumerations and the quick/Marshal.4.8 gemspec render.
  Both halves ported anchor-for-anchor; the upload parse rides the `yaml`
  package's parseDocument with source tokens.
- **The Marshal encoder (marshal.go ported):** `MarshalEncoder` carries the
  4.8 header, the fixnum single-byte forms (0; +5/-5 offsets for
  1..122/-123..-1), the positive/negative length forms (ErrInvalidIntRange
  outside ±0x40000000), the IVar-wrapped string with the single `E`=true
  instance variable, the deduped symbol table (':' spelling then ';'+index
  links), arrays, RubyUserMarshal ('U'), RubyUserDef ('u' — the value encodes
  through a FRESH encoder INCLUDING its own 4.8 header, then
  length-prefixed), and RubyObject ('o', insertion-ordered members where Go's
  map order is undefined — no wire path emits one). The marshal_test.go
  TestMinimalEncoder byte vectors pin the port exactly.
- **The gemspec.rz oracle:** the served zlib inflate matches the integration
  test's EXACT Marshal byte string (api_packages_rubygems_test.go:254) — the
  19 @-fields in upstream's literal order ("3.2.3", 4, name, the
  Gem::Version usermarshal, nil date, summary, nil × 2, platform, [],
  nil, "", authors, description, project_url, true, platform, nil,
  licenses). Note the byte string is a GO byte string: the test reads it
  through latin-1 code units (`\xc3` = the 195 length prefix of the inner
  encoding, one byte — a JS literal would UTF-8-encode U+00C3 as two).
- **The parse (metadata.go):** the .gem is a tar whose `metadata.gz` member
  returns EARLY (a malformed member after it never read — the walk keeps
  Go's tar.Next early-return plus its header-checksum/partial-block 500
  arms); the inflate caps at MaxMetadataSize 32 MiB (limited_reader.go:14 —
  enforced after inflating, upstream trips mid-stream; same
  ErrContentTooLarge 400); the YAML decode walks the gemspec struct's field
  set (name/version/platform/authors/description/homepage/licenses/summary/
  dependencies/required_ruby_version/required_rubygems_version) where a
  collection in a scalar field is yaml.v3's type error (the 500 arm) and
  unknown fields are ignored. String scalars render `n.Value` — the scalar's
  TEXT (`version: 1.0` stays "1.0"), which the platform parser loses to
  float resolution; the decode reads plain scalars through their
  `srcToken.source` (verbatim text) and quoted/block scalars through the
  unescaped value (Go unescapes the same way). Validations: the
  VALID_NAME_PATTERN `\A[\w.-]+\z` and the versionMatcher
  `\A[0-9]+(?:\.[0-9a-zA-Z]+)*(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z` →
  ErrInvalidName/ErrInvalidVersion 400s; AsVersionRequirement (the
  `[[restriction, {version}], …]` rows, skipping malformed entries AND the
  `>= 0` default pair); the homepage URL validation (invalid → dropped);
  the dependency split on `type: ":runtime"`; and the compact-index
  line-forgery gate — any indexed value (platform, dep names, requirement
  restrictions/versions) carrying \r or \n → ErrInvalidMetadata 400
  (metadata.go:228-239, c52e7c0cd2).
- **Version semantics:** stored VERBATIM from the gemspec — no server-side
  Gem::Version normalization exists in the pin (Ruby normalizes client-side);
  the gate is versionMatcher, the package row is SemverCompatible (upload:
  rubygems.go:243), and Gem::Version appears on the wire only as the marshal
  wrapper `U:\x11Gem::Version[\x06{version}`.
- **Wire shapes:** the enumerations answer SetServeHeaders +
  gzip-writer streams (rubygems.go:82-94): octet-stream + nosniff + the
  sandbox CSP, the prod Cache-Control, the attachment disposition +
  expose-headers echo, and NO Last-Modified (a zero ServeHeaderOptions time —
  serve.go:101-104 skips it) and no byte-serving (never ctx.ServeContent);
  Go's zw.Name ("specs.4.8") rides the gzip FNAME field, which the platform
  encoder cannot set — every consumer compares DECOMPRESSED payloads (the
  integration test does exactly that, and its base64 vectors pin our served
  gunzip byte-for-byte). /info + /versions are ctx.PlainText
  (text/plain;charset=utf-8 + nosniff); the compact line is
  `VERSION[-PLATFORM] RUNTIME_DEPS|checksum:SHA256[,ruby:REQS][,rubygems:
  REQS]` — RUNTIME deps only (rubygems.go:421's range), requirements
  `&`-joined with the `>= 0` default, the md5 of the info text closing each
  /versions line (the maven family's md5Hex — Workers' WebCrypto carries no
  MD5); packages render in GetPackagesByType order (upstream's Find is
  unordered — ours pins id ASC), versions in GetVersionsByPackageName order
  (created DESC); a non-"ruby" platform renders `VERSION_platform` on the
  versions line and `VERSION-PLATFORM` on the info line.
- **Error shapes (apiError → ProcessErrorForUser → ctx.PlainText):** 400 —
  the five InvalidArgument sentinels (missing metadata.gz, invalid name,
  invalid version, invalid metadata, the 32 MiB cap); 404 — the yank miss
  WITH "package does not exist" (rubygems.go:292-293) and the EMPTY-body
  nil-detail 404s (the len!=1 file searches rubygems.go:111-113/:175-177,
  the info miss); 409 — ErrDuplicatePackageVersion (always); 403 — quota;
  501 — the quick filename without `.gemspec.rz` (rubygems.go:100-103,
  EMPTY); 500 — everything else: corrupt tar/gzip/YAML (plain Go errors
  upstream — tar.Next, gzip.NewReader, yaml.Decode are not
  InvalidArgument), a duplicate file row, the prod body strip.
  Upload: the RAW body is the .gem (ctx.UploadStream — the integration test
  posts bare bytes, no multipart); yank: ParseMultipartForm FIRST — a
  non-multipart content type is Go's ErrNotMultipart → the 500 DEFAULT arm
  (the integration test posts multipart fields; the pin's literal shape),
  gem_name/version read in Go's r.Form order (URL query first, body fields
  append), success = Go's write-nothing handler answer 200 EMPTY, and the
  delete cascade is RemovePackageVersionByNameAndVersion (packages.go:505)
  over DeletePackageVersionAndReferences — blobs defer to the sweep
  (PACKAGE-DEFER-STORAGE-DELETE), rubygems registers no
  OnBeforeRemovePackageVersion hook.
- **Documented reductions:** the upload capped at 64 MiB (413 — the
  go/nuget/arch parse-family precedent); the 32 MiB metadata cap enforced
  post-inflate; the tar walk self-contained in rubygems.ts (distro-common's
  reader answers a finished list — the early-return needs the incremental
  walk); concatenated-member gzip decode rides walkGzipMembers (Go's
  multistream default), a body with no gzip magic errors; parseDocument
  reads a single document (Go's Decoder.Decode reads the first of a
  stream); multi-line plain scalars would read their raw source through
  srcToken (Go renders the folded value) — pathological for the indexed
  field set, and the newline gate rejects any \r\n carrier anyway; the
  lying-Content-Length store failure maps 500 (the npm/nuget posture).
- **Tests** (`packages-rubygems.test.ts` 33/33, own eyes: `Tests  33
  passed (33)`): the Marshal encoder vectors (marshal_test.go's table +
  the length-form arms + the error sentinels + the symbol-dedup shape); the
  parse battery (the fixture field set, the missing-member/structural tar
  arms, the invalid-name rows, the versionMatcher accept/reject tables, the
  newline-forgery rows, the empty-metadata 500 arm, the 32 MiB cap, the
  AsVersionRequirement skip table); the round-trip (201 → the
  SemverCompatible package + MetadataJSON + the ONE lead
  `{name}-{version}.gem`; the always-409 re-publish; byte-parity download +
  the counter bump — HEAD never counts; the gemspec.rz EXACT-byte oracle
  twice — through the route and through buildRubyGemSpecification; the 501
  gate; the enumerate vectors byte-for-byte incl. the always-empty
  prerelease; the compact-index info + versions text exactly as the
  integration test asserts; the platform-gem filename + `_platform` index
  suffix); the yank walk (multipart 200 → the 404s after; the unknown-gem
  404 message; the non-multipart 500 arm; the EMPTY-404 download/
  gemspec misses); the auth/quota arms (401s, public-anonymous/
  private-challenge reads, the size + +1-count 403s with the admin bypass,
  PACKAGES_ENABLED=false, the unknown-owner redirect message, the corrupt-
  body sentinel mapping). Neighbors re-run post-change: debian + alpine +
  rpm + arch + go 80/80. check:api PASS. Scoped eslint clean
  (rubygems.ts, packages-rubygems.test.ts, packages-protocols.ts). Bare tsc
  zero errors in the family's files.
- **Open issues:** none blocking. The no-`gem`-CLI-on-this-host posture
  stands (the go family's live-battery pattern would need a ruby toolchain
  with `gem` + a bundled Gitea source plugin — `gem` speaks the same compact
  index + Marshal shapes the integration test pins, and every byte-level
  consumer shape is already double-pinned by upstream's own vectors); if a
  ruby toolchain lands, the live battery should push the built fixture gem
  through the real client and sweep info/versions/specs.4.8.gz.

## As-built — the six-minor protocol batch: vagrant, cran, pub, chef, composer, conan (2026-10-31 — the registry carries TWENTY-ONE protocols)

The §2.1 long-tail row's six families landed in ONE wave:
`services/packages/{vagrant,cran,pub,chef,composer,conan}.ts` + their
service batteries, + the api.go route arms in
`api/routes/packages-protocols.ts` (per-family registrations inside
`createEcosystemProtocolRouter`; the handlers at module level — the
rubygems split), over the same substrate unchanged (no new tables, no new
migrations; every family stores through the landed two-pass blob store and
the D1 model).

- **Sizes as-honest:** vagrant is the small boxes family (5 arms);
  cran the PACKAGES-index family (8 arms, the property-matched search);
  pub the dart publish dance (7 arms, the YAML-subset reader); chef the
  supermarket (9 arms, the universe/search/cookbook metadata shapes);
  composer the packagist shapes (8 arms, the p2 metadata + the search
  pagination); conan is the BIG one (the full v1+v2 revisions protocol,
  ~30 arms through ONE decoded-remainder walk). Each family's module
  header carries its own pin map.
- **The storage posture (unchanged substrate):** every family uploads
  through `spoolAndHash` (the two-pass store) and stores the EXTRACTED
  file bytes at the content key — the multipart/archive envelopes never
  store (chef's tarball and pub's `file` part are extracted in memory;
  composer/conan/cran/vagrant bodies ARE the file). Properties land per
  upstream's lattice: vagrant `vagrant.provider` (file), cran
  `cran.type`/`cran.platform`/`cran.rvserion` (the UPSTREAM KEY TYPO
  verbatim; file), chef none (metadata JSON only), composer
  `composer.type` (VERSION), conan the six-key lattice (user/channel/
  recipe-revision/package-reference/package-revision/package-info), pub
  none.
- **The distinctive arms, per family:**
  - *vagrant* — the .box parse (a gzip'd tar whose OPTIONAL info.json
    feeds the case-insensitive key walk; a MISSING member is the ZERO
    metadata, no error — metadata.go:48), the go-version NewSemver gate
    (the swift port reused — the SAME hashicorp library), the sha512
    checksum + provider array in the enumerate, the path-name (never
    the archive's) as the package name.
  - *cran* — the PACKAGES index: per-package LATEST version by the
    NaturalSort port (the x/text collation reduced to byte order — the
    documented reduction), the DESCRIPTION field blocks with the
    continuation-line rule and the Author parenthetical strip, the
    gzip-magic tar.gz/zip dispatch (a self-contained zip reader — the
    swift walk's inverse), the binary `platform|rversion` composite
    key + the three-property triple, the MD5sum line rendering the
    EMPTY value (the WebCrypto reduction).
  - *pub* — the bounded YAML subset reader (block maps/sequences, flow
    forms, quoted scalars, comments, int/bool/null resolution —
    anchors/aliases/block scalars/multi-doc are the documented
    reductions; an unparseable document is the plain-error arm), the
    unquoted-float version (`version: 1.0`) riding go-yaml's DECODE
    ERROR arm (the plain-error 500 class, NOT the invalid-version 400),
    the go-version v.String() normalization ("v1.0.0" stores "1.0.0"),
    the `latest` = last entry enumerate shape, the 204-with-Location
    publish answer, the multipart `file` extraction.
  - *chef* — the one-slash metadata.json pick, the `\A\S+\z` /
    `\d+\.\d+(\.\d+)?` gates, the maintainer→author /
    source_url→repository_url mapping, the universe/search/cookbook
    metadata URL shapes (location_type "opscode", the `category: ""` /
    `deprecated: false` constants), the `{"error_messages":[…]}` body,
    the ABSOLUTE start/items search window ( Paginator.GetSkipTake —
    the landed page/limit search cannot express an arbitrary skip, so
    the window slices a start+items fetch), the created-DESC-id-DESC
    recently_updated order.
  - *composer* — the zip/tar.gz/bz2 detection with the bz2 arm LIVE
    through the vendored bzip2 decoder port (`./bz2.ts` — see the
    as-built decision record below), the ?version= fallback with the
    BOTH-missing route 400
    (ParsePackage itself TOLERATES the empty version — metadata.go's
    optional-arg), the `composer.type` VERSION property, the p2
    metadata with the url.PathEscape'd dist path (%2F — api.go:141)
    and the sha1 shasum, the linked-repo SOURCE arm gated on the repo
    visibility/owner/admin (the HasAnyUnitAccessOrPublicAccess
    reduction), the property-filtered search TOTAL (upstream filters
    in SQL; ours pre-resolves the matching version ids and slices —
    registry-small).
  - *conan* — THE REVISIONS DANCE: recipe/package revisions as
    created-DESC property-value aggregates (references.go:35-76's
    count-subquery reproduced as the property-map ⊇ filter walk), the
    composite keys `user|channel|recipeRev[|ref|pkgRev]`, the
    unpinned raw-revision filter answering EMPTY (upstream's own
    shape — GetPackageReferences filters the RAW revision), the
    name+version filter in EVERY walk (findPropertyValues' cond —
    the bug the service battery caught before landing), the
    OverwriteExisting delete-and-reinsert (identical bytes short-
    circuit idempotently, properties never duplicate), the conanfile
    metadata UPDATE in place on an existing version (conan.go:404-419),
    the conaninfo section parser (the pre-section invalid arm), the v1
    delete that IGNORES the revision vs the v2 pin, the search query
    grammar (@→/ split, `*` wildcards, `_` literal).
- **Error bodies per family (each upstream apiError helper's wire
  shape):** vagrant `{"errors":[…]}`; cran PLAIN TEXT (the empty
  detail on the nil arms); pub `{"error":{code,message}}` over
  application/vnd.pub.v2+json; chef `{"error_messages":[…]}`;
  composer `{"errors":[{status,message}]}`; conan `{"message":…}`
  over application/json WITH the json.Encoder trailing newline.
- **The conan auth seam and the chef X-Ops method (the 2026-11-01
  chef-auth flip):** upstream registers chef.Auth (the X-Ops RSA signed
  headers over the user's `chef.public_pem` setting) as an additional
  auth method, and conan's /users/authenticate mints a scoped
  authorization token the client echoes back. The chef X-Ops method IS
  NOW PORTED (services/packages/chef-auth.ts — the as-built note below);
  conan's authenticate mints through the auth module's container-token
  seam (mintContainerToken) and the conan gate accepts the minted token
  beside the standard credentials (Basic password / Bearer) — the
  CreateAuthorizationToken flow's function.
- **The route posture:** every family's read arms ride
  protocolContext(c, "read") (the shared gate stack); the write arms
  the "write" gate; HEAD rides the GET walks (the pypi/helm
  precedent). The conan arms ride ONE conanDispatch walk (the
  npm/rpm/swift posture) over the decoded remainder — chi's nested
  optional tails are not expressible as Hono params.
- **Tests** (own eyes, `Tests 215 passed (215)` across the eleven
  files of the batch + the neighbors sweep — per family: vagrant 14,
  cran 14, pub 16, chef 16, composer 14, conan 22; the route-level
  arms of OTHER families re-ran green through the shared file after
  every edit: go + rubygems + swift + cargo 119/119). Each family's
  battery: the parse oracle arms, the upload/list/download/delete
  round-trip on real D1 + REPO_PACKS, the distinctive arms, the error
  shapes with codes+bodies, and the quota/auth boundaries. NO live
  toolchains on this host (the hand-built fixture posture — the
  rpm/arch builder pattern; upstream's OWN integration-test shapes
  pinned the wire contracts: the chef metadata.json, the cran
  DESCRIPTION, the pub pubspec.yaml, the composer composer.json, the
  conan conanfile/conaninfo texts, the vagrant info.json).
- **Open issues:** ~~the cran zip CRC verification skipped (the blob
  sha256 gates the bytes)~~ RESOLVED 2026-11-01 (every zip member read
  across the package families — cran, composer, nuget, go, swift — now
  verifies the central-directory CRC32 at member-data EOF, Go's
  archive/zip readDataEOF → checkSum: a deflated member's CRC is over
  the UNcompressed bytes, a stored member's over the stored bytes; the
  check reuses distro-common's crc32 table (Go's crc32.ChecksumIEEE) and
  the mismatch throws the family's existing invalid-archive class —
  CranArchiveError / ComposerArchiveError /
  NugetInvalidPackageArchiveError ("zip: checksum error", Go's
  ErrChecksum text) / GoInvalidArchiveError / SwiftInvalidArchiveError —
  so a corrupt-CRC zip is rejected at the parse, nothing stores; per
  family a corrupt-CRC test arm pins it, valid archives still parse).
  ~~the chef X-Ops auth method~~ RESOLVED
  2026-11-01 (the chef-auth flip — the as-built note below).

## As-built — the composer `.tar.bz2` decision record: the reduction LIFTED by the vendored bzip2 decoder (2026-11-01)

The six-minor wave's recorded reduction ("bz2 DETECTED then REJECTED —
no bzip2 decoder on Workers") is lifted: `.tar.bz2` uploads now take
upstream's full acceptance path (metadata.go:146-149's
`compress/bzip2.NewReader` + tar walk). The adjudication, in full:

- **The platform claim, verified at the pin's compatibility_date
  2026-10-23:** workerd offers NO bzip2 surface. The generated
  `DecompressionStream` union is exactly `"gzip" | "deflate" |
  "deflate-raw"`, and a live probe in the vitest workerd rejects
  `bzip2`/`bz2`/`x-bzip2`/`bzip` (and `br`/`zstd`/`lzma`/`xz`) with
  "The compression format must be either 'deflate', 'deflate-raw' or
  'gzip'"; no bzip-like global exists. So the arm cannot ride a
  platform primitive — it needed a decoder, same as the cran zip reader
  did.
- **Why BUILD instead of keeping the reduction:** (a) upstream parity is
  the default decision (AGENTS.md) — upstream accepts bz2 fully, so the
  rejection was a divergence, not parity; (b) the decoder's scope is a
  single hand-rolled substrate: ~530 decode-only lines, the same family
  and size as the OpenPGP v4 subset (~250 ln) and the bounded YAML
  reader (~300 ln) this repo already hand-rolled — the port follows Go's
  compress/bzip2 decoder (go1.25.1: bzip2.go/huffman.go/move_to_front.go,
  the EXACT library upstream imports) rather than libbz2; (c) the format
  is self-verifying — every block carries a CRC and the stream a combined
  CRC — so real-fixture correctness is checkable loudly, which the
  battery does.
- **The landed posture (`services/packages/bz2.ts`):** decode-only,
  zero-dependency, whole-buffer; canonical Huffman tables reconstructed
  from the transmitted lengths (limit/firstCode/offset/perm), selector
  list MTF+unary coded with a table switch every 50 symbols,
  RUNA/RUNB run accumulation, MTF undo, the single-array inverse BWT
  (SRC-RR-124 §4.2), the RLE1 undo with Go's lazy-repeat state machine
  (pending repeats at block END flush into the block output), block +
  combined CRC verification, concatenated-stream continuations. Go's own
  simplifications kept for parity: RANDOMIZED blocks are REJECTED
  (StructuralError upstream — the encoder stopped emitting them in
  bzip2 0.9.5, 1999), and every malformed/CRC-failing stream maps onto
  the invalid-archive arm (ComposerArchiveError, the route's 500
  default — the same mapping the corrupt-gzip arm rides).
- **The verification:** fixtures are REAL system-bzip2 archives
  (bzip2 1.0.8 `-<level> -c` at authoring time, embedded base64) across
  levels 1/5/9, multi-block (110000B at -1), the exact block capacity
  (900000B at -9), RUNA/RUNB-heavy runs, single-symbol alphabets,
  incompressible PRNG bytes, the trailing pending-repeats edge, the
  empty stream, and concatenated streams; the CONTENT side regenerates
  in-test from the same deterministic formulas, and the composer
  fixture's tar side is byte-verified against the repo's OWN buildTar.
  An authoring-time cross-check (not committed) decoded 23 further
  bzip2-generated cases byte-exactly, including block boundaries and a
  2MB multi-block stream. Tests: bz2.test.ts 17, composer.test.ts 17
  (was 14 — the parse/corrupt/upload arms grew).
- **Reopen trigger:** none needed for Workers — if workerd ever gains a
  native bzip2 format, the arm can swap `bzip2Decompress` for the
  platform stream in one call site (`composerTarBz2Members`); the
  randomized-block rejection tracks Go's stdlib and only revisits if
  upstream Gitea's Go dependency learns to read them.

## As-built — the chef X-Ops auth method: the recorded reduction PORTED (2026-11-01)

The six-minor batch's open item — chef.Auth — landed as
`services/packages/chef-auth.ts` (+ `chef-auth.test.ts`), wired into the
chef family's handlers through `chefProtocolContext`
(`api/routes/packages-protocols.ts`, the CHEF section). Upstream
routers/api/packages/chef/auth.go at the pin, cross-verified against its
own integration test's signRequest
(tests/integration/api_packages_chef_test.go:171-251).

- **The acceptance order (the adjudication):** upstream runs
  `{OAuth2, Basic, nuget.Auth, Auth, chef.Auth}` through the auth group
  (api.go:96-102), whose semantics are first-user-wins with the first
  error remembered (services/auth/group.go:44-63); verifyAuth answers
  the remembered error with `ctx.HTTPError(401, "Failed to authenticate
  user")` (api.go:82-85 → base.go:105-112, Go http.Error's plain-text
  shape). Basic/token credentials therefore WIN and chef.Auth fires only
  when they yield no user — upstream's own integration test uploads with
  AddBasicAuth (:296). The port keeps the token seam as the PRIMARY pass
  (`resolveCredential` first) and layers X-Ops second; the seam STAYS.
  Scope note: upstream's chain makes X-Ops technically live on every
  /api/packages family; the port scopes it to the chef family's handlers
  (a chef-signed request has no client on other families' paths).
- **The method surface (auth.go, in order):** the applicability probe —
  an absent `X-Ops-Userid` is the (nil, nil) not-applicable pair
  (:93-100); the GetUserByName walk (case-insensitive, :99); the
  `chef.public_pem` setting read + PKIX/RSA parse BEFORE the timestamp
  arm (:102-111 precede :113), non-RSA rejected (:81-84); the RFC3339
  timestamp with the ±10 min window (:34, :113-134); the X-Ops-Sign
  version gate {1.0, 1.1, 1.2, 1.3} with `algorithm=sha1` (or `sha256`
  on 1.3 only) (:136-161); the `X-Ops-Authorization-N` chunk join in
  index order, gaps rejected (:181-205); the canonical check data
  (:207-239) — 1.3's `Method/Path/X-Ops-Sign:version/X-Ops-Timestamp/
  X-Ops-UserId/X-Ops-Server-API-Version` over `path.Clean(URL.Path)`
  with the raw username, 1.0-1.2's `Hashed Path` shape with the
  sha1-b64 username for 1.1/1.2; the signature dispatch (:241-280) —
  1.3 RSASSA-PKCS1-v1_5-SHA256, 1.2 RSASSA-PKCS1-v1_5-SHA1 (WebCrypto's
  verify hashes the message itself — the VerifyPKCS1v15 composition),
  1.0/1.1 the RAW RSA private_encrypt composition: signature^e mod n
  (BigInt — WebCrypto has no raw RSA), the PKCS#1 v1.5 padding stripped
  by the 0xFF-0x00 scan from index 2 (:264-273), the remainder compared
  byte-exactly with the check data (:275).
- **The key store arm:** upstream exposes the SET only through the user
  settings page — POST /user/settings/packages/chef/regenerate_keypair
  (web.go:718 → routers/web/user/setting/packages.go:103-119,
  GenerateKeyPair(KeyBits=4096), SetUserSetting(chef.public_pem, pub),
  the private PEM streamed once as {user}.priv). The port carries the
  same set/get pair on `user_settings_kv` (the distro-common
  signing-key precedent) + `generateChefKeyPair` (SPKI `PUBLIC KEY` PEM
  byte-format-identical; the private arm renders PKCS#1
  `RSA PRIVATE KEY` via a PKCS#8 DER unwrap — util/keypair.go's exact
  label set). The `POST /user/settings/packages/chef/regenerate_keypair`
  web handler is NOT yet mounted (the worker has no
  /user/settings/packages page; index.ts is the shared mount) — the
  service pair is in place for the web arm to call; knife users cannot
  yet self-serve keypairs.
- **Divergences (documented):** upstream's X-Ops-Authorization-0 index
  panics the slice walk (Go tmp[-1] → the 500-recovery page); the port
  folds it into the invalid-headers error (the same 401 body). Upstream
  `pem.Decode` returning nil derefs at :108 (500-recovery); the port
  answers the method error (401). A missing X-Ops-Authorization family
  with otherwise-valid headers errors at the strict base64 decode vs
  upstream's empty-signature verify failure — the same 401 body either
  way. `path.Clean` is ported byte-exactly (src/path/path.go, the
  rooted-slash upfront append included).
- **Tests:** chef-auth.test.ts 53 — the store round-trip, the keypair
  shape (PKCS#1 private / SPKI public, e=65537, the 4096 default), the
  applicability/lookup/no-key/non-RSA/garbage-PEM arms, the timestamp
  window both ways with the edge + fractional seconds, the version and
  algorithm gates, the chunk join (order/gap/zero-index/garbage), the
  pathClean table, the canonical check data byte-exactly, SIGN/VERIFY
  round-trips for ALL FOUR versions (the upstream test's signing walk —
  raw-RSA d-exponent for 1.0/1.1, WebCrypto for 1.2/1.3, 60-char
  chunking), the different-path and tampered-signature rejections, and
  the route-face acceptance order (X-Ops-alone upload 201 on all four
  versions, Basic still 201, the byte-exact
  `Failed to authenticate user\n` 401 with nosniff on the
  bad-signature/stale-timestamp/no-key arms, anonymous read 200, the
  anonymous upload challenge preserved).

## As-built — the long-tail `terraform` family + the conda adjudication (2026-11-01 — the registry carries TWENTY-TWO of the pin's TWENTY-THREE protocol surfaces; the six-minor wave's "FULL PARITY 21" claim corrected)

The row-16 flag adjudicated (docs/residuals-v1.3.2.md): the pin's
`CommonRoutes()` carries **22** route groups (the full census at §1 —
conda `api.go:263` and terraform `api.go:466-476` route too), plus
`ContainerRoutes()` = **23** protocol surfaces. The wave's 21 was a tally
miss in its own list (the §2.1 out-of-scope list named all 22), so
"FULL PARITY" never held. This unit closes the census: terraform BUILT,
conda STAGED with its walls named.

### terraform — the state backend, LANDED

Upstream's surface is the GitLab-compatible TERRAFORM STATE backend — the
route group's own comment cites GitLab's fine-grained-permissions reference
(api.go:465-466). The pin has NO module registry / `.well-known/
terraform.json` discovery anywhere (grep across routers/ + modules/ is
empty); any registry-protocol work would be pin-silent invention and is
NOT built. One package per state name (type `terraform`, package.go:54),
one version per serial (`version = FormatUint(serial)`), one lead file
`tfstate`, the lock a package-type property `terraform.lock` holding the
LockInfo JSON.

The seven arms (`api/routes/packages-protocols.ts`, between the rubygems
and vagrant blocks — the pin's swift→terraform→vagrant adjacency):

- `GET /:username/terraform/state/:name` (+HEAD) — the LATEST version's
  state (terraform.go:39-50; SearchLatestVersions exact-name, the
  GET-only download bump packages.go:668);
- `GET …/versions/:serial` (+HEAD) — the pinned serial (:53-55);
- `POST …` — upload (write): the name gate (`\A[-_+.\w]+\z` + not ".." +
  the lone-char letter/number rule, terraform_test.go's vectors verbatim),
  the PRE-BODY lock enforcement (`?ID=` — ctx.FormString reads the query;
  mismatch → **423 + the current lock JSON** :117-121), spool → size quota
  → ParseState (`{serial, lineage}`, serial ≥ 1, :149-154) → create →
  **201**; a same-serial re-post is the duplicate 409;
- `DELETE …` — the whole state (write): locked → **423**
  "terraform state is locked", else every version + package cascade →
  **200** (:238-297);
- `DELETE …/versions/:serial` — the LATEST serial is the **403**
  "cannot delete the latest version", else **204** (:196-234);
- `POST …/lock` — the 64 KiB ID-required lock parse (lock.go:38-52), the
  package ALLOCATION when missing (:327-342), locked → **423 + lock JSON**,
  set → **200**;
- `DELETE …/lock` — missing/not-locked → **200**, ID mismatch → **423**
  "lock ID mismatch", else clear → **200** (:366-422).

Error bodies are PLAIN TEXT (terraform.go:33-36) with the EMPTY body on
the nil-error 404s (ProcessErrorForUser's zero message) + nosniff
(base.go:140-147); the 423 lock bodies are the ONE JSON exception
(ctx.JSON) with the Go struct field order
`ID/Operation/Info/Who/Version/Created/Path` (lock.go:20-29).

Documented divergences: upstream's globallock (redis/inproc) → the D1
conditional-update CAS (the SetLock `value=''` / RemoveLock `value!=''`
guards ported literally — lock.go:87-101's "failed to update lock state"
arm kept), the constraint-arbitrated posture every landed family uses;
`Created` round-trips as its RFC3339-shaped string with an absent field
rendering Go's zero time `0001-01-01T00:00:00Z` (the Go round-trip's
observable shape); serials are safe integers (Go's uint64 decode admits
more digits); the store's 512 MiB cap maps to 413 and a lying
Content-Length to 500 (upstream's unbounded spool has neither arm); no
count-quota arm on upload (upstream checks size only, :140).

Tests (own eyes): services `terraform.test.ts` **23/23** + route arms
`packages-terraform.test.ts` **8/8** (both quoted: `Tests 31 passed (31)`
over the pair; `Tests 8 passed (8)` solo) — the pin's own
TestValidatePackageName vectors, the ParseState/ParseLockInfo arms, the
lock machine incl. the CAS clear, the lifecycle round-trip with byte
parity + the GET-only bump, the 423 JSON shape with the field order, the
allocation arm, the 401 challenge / private-owner 401 / quota 403 +
admin bypass / PACKAGES_ENABLED=false arms. Neighbors unregressed:
debian + rpm + cran service+route suites 115/115, blobs/model/serve-content
+ cleanup 80/80 (one load-flake in a concurrent pass re-ran green solo).
`pnpm check:api` PASS; tsc zero in the unit's files; scoped eslint clean.

### conda — STAGED (the three Workers codec walls, exactly what's missing)

The family is NOT built; staging it honestly requires deciding (repo-level,
SPEC-attached) how to source three codecs the platform lacks at
compatibility_date 2026-10-23 — `DecompressionStream`/`CompressionStream`
admit exactly gzip/deflate/deflate-raw (the composer/arch units' documented
reductions precedent, composer.ts:340-354 / arch.ts:64):

1. **`.tar.bz2` upload parse** (conda.go:213-217 → ParsePackageBZ2) needs a
   bzip2 DECODER + the tar walk over `info/index.json` + `info/about.json`
   (metadata.go:94-98). A zero-dependency bzip2 decoder is IN FLIGHT from
   the composer unit (`services/packages/bz2.ts`, decode-only, CRC-
   verified) — adoptable here once landed, but it does not exist as a
   landed dependency today and its header scopes it to composer.
2. **`.conda` upload parse** (ParsePackageConda, metadata.go:101-130) needs
   zip (available — the cran/nuget readers) PLUS a **zstd decoder** for the
   inner `info-*.tar.zst` — no zstd surface exists on the platform or in
   the dependency tree, and no unit has one in flight.
3. **`repodata.json.bz2` serving** (conda.go:170-183) needs a bzip2
   ENCODER — decode-only ports don't help; the honest reduction would 404
   the `.bz2` arms (conda clients fall back to plain `repodata.json`) and
   that shape needs its own SPEC row.

Without uploads BOTH formats 400 (the parse is the name/version source),
so every read arm would answer its empty-404 forever — a family of
dead arms misrepresents parity. The staged row unblocks when (1)'s
decoder lands + a zstd decision + the encoder-or-404 reduction SPEC.
Size then: the route dispatch (ListOrGetPackages' four repodata names vs
the package-filename split), the RepoData JSON family
(`info.packages`/`packages.conda`/`removed` + the subdir echo), the
channel-prefixed names, the subdir composite key — an S-M unit once the
codecs are decided. NOT counted toward the registry's parity claim until
then: **the registry carries TWENTY-TWO of TWENTY-THREE**.

## As-built — the long-tail `conda` family: the three walls RESOLVED (2026-11-01 — the staged row's decoder adopted; the wall-2 zstd reduction recorded, the wall-3 encoder reduction REOPENED AND ADOPTED the same day; the census claim this section closes: **TWENTY-THREE of TWENTY-THREE**)

The STAGED section above named three Workers codec walls; this unit
adjudicated each with the BUILD-or-record discipline (upstream parity is
the default decision; a Workers-impossible wall gets an honestly
documented reduction):

1. **`.tar.bz2` upload parse — ADOPTED.** `services/packages/conda.ts`
   imports the landed `bzip2Decompress` (./bz2.ts — the Go
   compress/bzip2 port; the decoder is generic, its composer naming is
   doc-only) over distro-common's `readTarMembers`, and walks
   `info/index.json` (REQUIRED — its absence is ErrInvalidStructure) +
   `info/about.json` (optional, zero-filled) exactly as
   metadata.go:132-217 does: the ≤ 32 MiB limited reads, the
   conda-build name/version grammar verbatim (lowercase, the
   `=@#$%^&*:;\"'\|<>?/ ` set + `!` in names / `-` in versions), the
   about-URL validation (abs+host — an `ftp://` dev_url KEEPS, a
   relative home clears), and the decode-error class split (a type-
   mismatched/arrailed/dependent-bad index is the plain-error 500 arm
   exactly like Go's json.Decode failure; a JSON-`null` index is the
   decode no-op — upstream nil-panics at `i.Name`, our port answers the
   invalid-name 400, the documented divergence on a crash arm).
2. **`.conda` upload parse — RECORDED REDUCTION (wall 2).** Verified
   against the pin first: the pin DOES accept `.conda`
   (conda.go:37-39, the conda.go:215-216 dispatch → ParsePackageConda,
   metadata.go:101-130) — zip + a ZSTD decoder for the inner
   `info-*.tar.zst`. The platform has no zstd surface (the bz2 as-
   built's probe record: the DecompressionStream union and
   worker-configuration.d.ts both lack it) and Go's stdlib has neither
   (upstream rides klauspost/compress); a full zstd decoder port is out
   of a family unit's scope. THE REDUCTION: every `.conda` upload
   answers the family's invalid-structure sentinel
   (`CondaInvalidStructureError` → the 400 arm, conda.go:218-220's
   ErrInvalidArgument shape) BEFORE any spool — upstream's 201-valid /
   400-no-info-member / 500-corrupt-zip triple collapses to one 400
   because no `.conda` can ever parse here. REOPEN TRIGGER: a zstd
   decoder unit.
3. **`repodata.json.bz2` serving — ADOPTED (2026-11-01, the wall's
   recorded reopen trigger landed: the dedicated bzip2-encoder unit).**
   The pin DOES serve the `.bz2` variants (conda.go:44's switch +
   conda.go:170-183's bzip2 writer over github.com/dsnet/compress — a
   format Go's stdlib cannot WRITE, so there was NO Go-stdlib reference
   to port). The from-spec encoder landed as `services/packages/
   bz2-encode.ts`: RLE1 (the 4+count pairs, pair-capped at 255, block
   cuts BETWEEN pairs) → the BWT over the RLE bytes (rotation order via
   a prefix-doubling suffix array of the DOUBLED block — O(n log n)
   time, O(n) space; the doubled text is what makes the sort match the
   inverse's cyclic semantics where a plain sentinel sort silently
   breaks the T-chain) → MTF with RUNA/RUNB bijective-base-2 runs →
   libbz2's nMTF-grouped 2-6 Huffman tables (length-capped at 20 by
   frequency halving, canonical hbAssignCodes assignment) → the
   selector MTF + unary list. Encoder freedom over byte-identity with
   bzip2(1); correctness is self-checking (every block CRC + the
   combined stream CRC) and was proven BOTH ways: the committed battery
   round-trips every arm through the landed decoder AND the authoring
   harness ran every arm (plus a 200-case mixed-shape fuzz, levels
   1-9) through system `bzip2 -d` byte-for-byte (bzip2 1.0.8; the
   empty and aaaaa outputs are byte-identical to the tool's). The
   conda wiring: `CONDA_REPODATA_NAMES` carries all FOUR switch names
   (conda.go:44), and the `.bz2` requests serve the SAME repodata JSON
   body through `bzip2Compress` with `application/x-bzip2`
   (conda.go:170-183's suffix branch; level 9 — an enumeration fits
   one 900k block). Wall 2's zstd reduction below STAYS RECORDED.

The built surface (api.go:263-267, the conan→conda→cran adjacency; one
decoded-remainder walk carries the chi PathGroup's `<channel:*>`
optional-wildcard grammar — `(.*?/)?` per router_path.go:168-179, so a
nested channel `a/b` spans segments and an empty/short path rides the
chi NotFound page):

- `GET /<architecture>/<filename>` (+HEAD) and the channel-prefixed
  twin — ListOrGetPackages (conda.go:41-53): the repodata switch
  (all FOUR names, conda.go:44 — the `.bz2` twins ride the wall-3
  encoder), then the package-filename split, then http.NotFound;
- the repodata render (conda.go:55-187): SearchFiles(channel, subdir)
  over the `conda.channel` PACKAGE property (exact match — the
  EMPTY-channel row is written at package creation and the default
  enumeration needs it) + the `conda.subdir` FILE property; the RepoData
  body carries `info:{subdir}` / `packages` / `packages.conda` /
  `removed` in the struct order, the Go map-key sort (bytewise), the
  13-field PackageInfo order with `md5` rendering EMPTY (no WebCrypto
  MD5 — the landed blob-row note) and `depends` nil→[], and the
  json.Encoder trailing newline; zero files → the 404-nil JSON; the
  `.bz2` names answer with the SAME body through `bzip2Compress` and
  `application/x-bzip2` (conda.go:170-183's suffix branch), the
  `.json` names verbatim with `application/json`;
- the package download (conda.go:296-322): the search must answer
  EXACTLY one row (zero OR multiple is the 404 — conda.go:308's
  `len != 1`); the D-6 serve walk with the sniffed content type
  (application/x-bzip2 — the only container the store can hold behind
  wall 2), the HEAD ride, the lead-file GET-only counter bump
  (packages.go:668);
- `PUT /<channel>/<filename>` (+ the empty-channel arm) — the raw-body
  upload (conda.go:189-294): the filename gate 400-nil, the `.conda`
  wall 400 (wall 2), the spool → parse → size-quota →
  CreatePackageOrAddFileToExisting chain: the package named
  `channel/name` (the bare name when channel-empty, conda.go:232-237)
  with `conda.name`/`conda.channel` at package CREATION only, the
  VersionMetadata JSON at version CREATION only (a second file never
  rewrites it), the stored file `{name}-{version}-{build}{.tar.bz2}`
  (Go's Sprintf verbatim — an empty build leaves the trailing dash)
  under the SUBDIR composite key with `conda.subdir`/`conda.metadata`,
  and ANY duplicate row the ErrDuplicatePackageFile 409; the apiError
  family body is `{"reason": http.StatusText, "message"}` over
  application/json;charset=utf-8 (conda.go:26-35) with the 500s
  stripped to the prod posture's constant.

Documented divergences: the recorded wall-2 zstd reduction above (the
wall-3 encoder reduction was reopened and adopted — see wall 3); the stored-
metadata JSON renders follow the Go struct tag orders with the
omitempty sweep (`is_conda` has none — always present); the JSON
decode gates reduce Go's int64-literal strictness to safe-integer
checks (the terraform serial posture); upstream's `len(pfs) > 1`
download ambiguity and the same-key repodata overwrite arm are ported
literally (the survivor's version is undefined in both); the globallock
wrapping CreatePackageOrAddFileToExisting rides the landed
constraint-arbitrated posture (the model.ts header note, every family
the same).

Tests (own eyes, the wall-3 bz2-encode unit's re-run): the encoder
battery `bz2-encode.test.ts` **19/19** + the decoder battery
`bz2.test.ts` **17/17** + services `conda.test.ts` **31/31** — quoted
over the three files: `Tests 67 passed (67)`; route arms
`packages-conda.test.ts` **9/9** (the former wall-3 404 arm now asserts
the compressed twins: 200 application/x-bzip2, the payload decoding
back to the exact plain render). The encoder goldens were cross-checked
at authoring time with system `bzip2 -d` (bzip2 1.0.8): every committed
arm reproduces its content byte-for-byte plus a 200-case mixed-shape
fuzz (runs + random + cycles, levels 1-9) through BOTH decoders; the
empty and aaaaa outputs are byte-identical to the tool's. The service
fixtures remain the real system-bzip2 conda packages (bzip2 1.0.8 -9,
embedded base64), the name/version/URL/decode-error parse arms, the
metadata JSON renders, the upload chain with the property/creation-only
semantics, the duplicate 409, the `.conda` wall 400, the exact RepoData
render, the exactly-one download gate, the channel/nested-channel walk,
the auth/quota/PACKAGES_ENABLED gates. Neighbors unregressed: blobs +
model + serve-content `Tests 72 passed (72)` over the three files.
`pnpm -C apps/worker typecheck` zero errors in the touched files (the
tree's remaining errors ride sibling units' in-flight untracked files);
scoped eslint exit 0 on the five touched files.

- **Open issues (conda):** (1) ~~the vendored bz2 decoder diverges from
  Go on a zero-run-dominated tiny stream~~ RETRACTED at the same unit's
  close: the suspect bytes were this unit's own corrupted base64 paste
  (a stale embed), and a controlled cross-check settled it — Go's
  compress/bzip2 (go1.25.1) rejects those exact bytes with the SAME
  "Huffman length out of range" bz2.ts produced, and accepts every
  fixture bz2.ts accepts (the two decoders AGREE on all tested streams;
  no bz2-owner unit needed). (2) ~~a bzip2-encoder unit for the `.bz2`
  repodata variants~~ CLOSED at the bz2-encode unit (wall 3 ADOPTED,
  above); the zstd decoder unit for `.conda` uploads stays the one open
  reopen trigger (wall 2). With conda landed the census closes:
  **TWENTY-THREE of TWENTY-THREE** protocol surfaces (the 22
  CommonRoutes groups + container) — the parity claim the 2056
  section's TWENTY-TWO row staged for.
