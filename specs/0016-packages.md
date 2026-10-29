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
2. **Per-ecosystem registry protocols** — 21 protocol families on
   `/api/packages/{username}/…` (`api.go:91` `CommonRoutes`) plus the OCI
   distribution API on `/v2/…` (`api.go:509` `ContainerRoutes`). Each is a
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
  own SPEC-attached milestone.
- **Repository signing keys** (alpine/debian/rpm `GetRepositoryKey` arms, the
  chef keypair, `DefaultRPMSignEnabled`,
  `gitea/modules/setting/packages.go:42`) — no signing key exists in our
  substrate; the index-builder milestones will propose their posture.

## 2. The subsystem — upstream cites, our substrate, the gap

### 2.1 The registry-type census: 23 model types, 21 protocol families, 1 container API

The model's type list is 23 constants (`gitea/models/packages/package.go:33-53`:
`TypeAlpine … TypeVagrant`, the `TypeList` at `:55-77`). The protocol surface
is two routers (`api.go`):

- **`CommonRoutes()`** (`api.go:91`) mounted on `/api/packages` (NOT
  `/api/v1` — the file's comment: "These are mounted on `/api/packages` (not
  `/api/v1/packages`)"): 21 ecosystem groups, each wrapped in
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
| cargo (`api.go:156-172`) | ~600 ln + index.go | sparse/git index: `config.json` + `1|2|3/{name}` version lists **in a real git repo** (`_cargo-index`, index.go:29; commits via the files service, index.go:112) | yes — a git repo | M7 |
| conan / composer / chef / conda / cran / go / pub / rubygems / swift / terraform / vagrant | each 150-700 ln | per-client wire contracts | protocol-only | long tail, demand-driven |

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
   remove-days / remove-pattern) deleting matching versions — the
   index-rebuild riders of upstream cleanup.go:115-145 do NOT exist in v1
   (no non-generic ecosystems yet) and arrive per-ecosystem.

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
  rule execution (keep-count, remove-days) without index rebuilds; the
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
  over the SAME model; dispatch on demand, sizes S-M.

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
