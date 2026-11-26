# SPEC: Terraform Module Registry (upstream 5d9bfa1e14)

Unit TFMODULE — the REPIN-PKG handoff. Upstream commit `5d9bfa1e14` ("feat(packages):
add private Terraform module registry (#38040)") at the pin `099abf5db4`, ~870 lines:
the module package type, a purpose-built HCL scanner, five registry routes, and the
`/modules/{submodule}` package-page tail. All-or-nothing per the handoff; this SPEC
comes first per the repo's SPEC-first rule.

## 1. Problem and scope

Terraform CLI resolves modules from a *module registry* (Hashicorp's module registry
protocol) distinct from the *state backend* we already port (`services/packages/
terraform.ts` — the GitLab-compatible `terraform/state/{name}` API). This SPEC lands
the module registry so `terraform init` and Terragrunt `tfr://` resolve modules from
Gitea:

```hcl
module "vpc" {
  source  = "gitea.example.com/owner/vpc/aws"
  version = "~> 1.0"
}
```

Modules upload as `.tar.gz` archives (module at the archive ROOT), store verbatim and
immutable, one version per normalized semver.

**In scope**

1. The package type `terraform-module` threading (type list, display name, descriptor
   metadata case, cleanup-rule type options, quota plumbing note).
2. The in-tree HCL scanner + archive parser (`modules/packages/terraform_module/`:
   `hcl.go` 235 + `parser.go` 172 + `metadata.go` 41) ported to a Workers-native
   service.
3. The five registry routes under `/api/packages/-/terraform/modules/…` (router 197
   lines) with upstream's auth ladder and error shapes.
4. The signed-archive download URL (upstream `base/tool.go:36-95` time-limit code).
5. The package-page `/modules/{submodule}` view tail (web route + handler guard +
   the content block: install snippets, README, inputs/outputs/providers, submodules).
6. Service-discovery integration: the routes land at exactly the base path the
   already-landed `/.well-known/terraform.json` document advertises
   (`ui/index.ts` `wellKnownTerraformDiscovery` → `{"modules.v1":
   "/api/packages/-/terraform/modules/"}` — upstream web.go:530).

**Out of scope (recorded, not silently ignored)**

- `LIMIT_SIZE_TERRAFORM_MODULE` per-type quota: upstream threads a per-type lattice
  entry (setting/packages.go:91, app.example.ini:2888-2889). Our quota surface carries
  only the generic per-file cap + owner totals (model.ts §3.4 — "the per-type lattice
  arrives with each ecosystem milestone"); every other type rides the same posture.
  The module type joins the generic-only lattice identically. Adding the env var is
  the quota/schema family's follow-up.
- The v1/admin swagger *type-filter enum strings* (`alpine…terraform-module…vagrant`):
  upstream edits doc comments + generated swagger JSON only — no handler change. Our
  `listQuery.type` is a free `z.string()` filter passed straight to the query; the
  filter already accepts the new type. Docs-surface no-op.
- The files API property table (b0b31bc593, landed in c9202b1): terraform-module has
  no spec registration upstream → `PublicPropertyNames()` empty → files render no
  properties; our `PACKAGE_PUBLIC_PROPERTY_NAMES` already answers none for unknown
  types. No change.
- The `packages-terraform` deploy probe battery (scripts/deploy-probes.mjs) gains no
  module arm in this unit (probe batteries are owned elsewhere); the scoped vitest
  battery covers the protocol.

## 2. API surface (upstream cites at the pin)

Router: `routers/api/packages/terraform_module/terraform_module.go`. Upstream mounts
the group at HOST level, BEFORE the `/{username}` families (api.go:105-117 — the
comment: "host-level base URL for service discovery, the namespace is the owner"):

```
/api/packages/-/terraform/modules/{username}/{name}/{provider}/…
  GET  /versions                    ListVersions      reqPackageAccess(read)
  GET  /{version}/download          DownloadRedirect  reqPackageAccess(read)
  GET  /{version}/archive[?code=]   DownloadArchive   HasValidArchiveSignature OR reqPackageAccess(read)
  PUT  /{version}                   UploadModule      reqPackageAccess(write)
  DELETE /{version}                 DeleteModule      reqPackageAccess(write)
```

wrapped in `context.UserAssignmentWeb()` + `context.PackageAssignment()` (unknown
owner → 404; private owner invisible to the caller → 404). The literal `-` first
segment outranks the `/{username}` families in both routers (chi mount order upstream;
static-over-param in Hono).

Error shape: `apiError` is PLAIN TEXT (terraform_module.go:33-35 —
`helper.ProcessErrorForUser` + `ctx.PlainText`), matching the terraform state family's
landed shape. Status mapping:

| Case | Status | Cite |
|---|---|---|
| address invalid (namespace/name/provider) | 400 | terraform_module.go:48-52, parser.go:24-27 |
| version not valid semver | 400 | parser.go:39-44 |
| versions list empty | 404 `package does not exist` | :70-73 |
| version missing (download/delete) | 404 | :99, :187 |
| duplicate version upload | 409 | :168-169 (ErrDuplicatePackageVersion) |
| quota count/type-size/total | 403 | :170-171 |
| archive > metadata cap / bad gzip-tar | 413 / 400 | :136-138 (ErrContentTooLarge → 413, else 400) |
| packages disabled / owner unknown / access denied | 404 / 404 / 401 | the shared gate stack |

### 2.1 ListVersions — `GET /versions`

Validate the address, then all versions of package `(owner, type terraform-module,
name = "{name}/{provider}")`, ordered upstream-style (created DESC, id DESC —
`GetVersionsByPackageName`, package_version.go). Empty → 404. Body:

```json
{"modules": [{"versions": [{"version": "1.0.0"}, {"version": "0.9.0"}]}]}
```

(terraform_module.go:75-91 — the protocol's two-level envelope, versions as bare
`{"version": …}` objects).

### 2.2 DownloadRedirect — `GET /{version}/download`

Validate address + normalize version; `GetVersionByNameAndVersion` must resolve
(else 404). Respond **204 No Content** with header:

```
X-Terraform-Get: ./archive?archive=tar.gz&code=<CreateTimeLimitCode>
```

(terraform_module.go:93-107 — signed because Terraform sends no credentials on the
fetch; `archive=tar.gz` tells go-getter the format of the extensionless URL). The
code payload is `terraform-module:{ownerId}:{name}/{provider}:{normalizedVersion}`
(:66-68), TTL 10 minutes (`archiveCodeMinutes`, :27).

### 2.3 DownloadArchive — `GET /{version}/archive`

Auth: `HasValidArchiveSignature` (valid unexpired `?code=` for THIS
owner/name/version) bypasses the read gate — Terraform downloads bare (:78-81).
Else `reqPackageAccess(read)`. Then
`OpenFileForDownloadByPackageNameAndVersion(PackageFileInfo{Filename:
"module.tar.gz"})` + `helper.ServePackageFile` — the landed generic serve path
(`serve-content.ts`: disposition headers, HEAD suppression, byte ranges). The
GET-only download-count bump rides upstream's open-for-download seam
(packages.go:668, the landed `incrementDownloadCounter` posture).

### 2.4 UploadModule — `PUT /{version}`

1. Validate address + normalize version (400s).
2. Spool the request body verbatim (upstream `CreateHashedBufferFromReader`,
   :124-133; ours `spoolAndHash` — the store's 512 MiB cap answers 413 where
   upstream's spool is unbounded; recorded divergence carried by every family).
3. `ParseModuleArchive` — gzip+tar walk, HCL scan (§3). `ErrContentTooLarge` → 413,
   any parse failure (bad gzip, bad tar, `ErrNoRootModule`) → 400.
4. `CreatePackageAndAddFile`: package `(owner, "terraform-module",
   "{name}/{provider}", semverCompatible=true)`, version = normalized semver,
   metadata = parsed Metadata JSON, ONE lead file `module.tar.gz` = the verbatim
   spooled bytes (:141-159). `ErrDuplicatePackageVersion` → 409 (immutable
   versions). Quota → 403.
5. `201 Created` (:175). The `package created` webhook fires on the created arm
   (upstream packages.go:133 `notify_service.PackageCreate` — the landed
   `emitPackageCreated` shape, gated on versionCreated).

### 2.5 DeleteModule — `DELETE /{version}`

Validate address + normalize version; remove the version by name+version
(RemovePackageVersionByNameAndVersion — modules have NO OnBeforeRemove guard, only
terraform state does). Miss → 404. The `package deleted` webhook fires with the
descriptor resolved BEFORE the cascade (the landed generic deleteVersion shape).
`204 No Content`.

### 2.6 Service discovery (integration, pre-landed)

`GET /.well-known/terraform.json` →
`{"modules.v1": "<AppSubURL>/api/packages/-/terraform/modules/"}` (web.go:530,
terraform_module.go:68-70) — already landed at `ui/index.ts`
`wellKnownTerraformDiscovery`. This SPEC's routes make that document TRUE.

## 3. The address, version, and archive grammar

### 3.1 Address validation (parser.go:32-46 — Terraform's registry-address rules)

- `nameRe = \A[0-9A-Za-z](?:[0-9A-Za-z_-]{0,62}[0-9A-Za-z])?\z` — namespace AND
  name: start alphanumeric, end alphanumeric, 2-64 chars total, middle may hold
  `_`/`-`; single char OK.
- `systemRe = \A[0-9a-z]{1,64}\z` — provider: lowercase alnum only, 1-64.
- Errors: `ErrInvalidNamespace` / `ErrInvalidName` / `ErrInvalidProvider` (all 400).
- Upstream test vectors (parser_test.go TestValidateAddress): `org/My_vpc-2/azurerm`
  valid; `john.doe` namespace invalid; `vpc-` name invalid; `my-cloud` provider
  invalid.

### 3.2 Version normalization (parser.go:39-44)

`version.NewSemver(raw).String()` — canonical semver so `v1.0.0` and `1.0.0` are the
SAME version row (lower-version uniqueness does the rest). Non-semver → 400. Our
port uses the landed semver normalizer posture (the container/swift families') —
same accept/reject set for the forms Terraform sends.

### 3.3 Archive layout (parser.go:46-125)

- gzip stream, TOTAL decompressed bytes capped at `MaxMetadataSize` = 32 MiB
  (limited_reader.go:14 — `ErrContentTooLarge` past the cap; the second per-entry
  limited read exists because sparse tar entries can read past their size).
- Walk tar entries: regular files only; basename starting `.` skipped (Terraform
  ignores dotfiles — `._main.tf` is a macOS AppleDouble, pinned skipped).
- Sources: basename ends `.tf` or `.tf.json` (`backup.TF` pinned SKIPPED — case
  matters). `*.tf.json` files are collected but yield no HCL blocks (JSON is not
  scanned — pinned: `modules/json/main.tf.json` gives an empty Module).
- Readmes: basename `readme.md` or `readme` case-insensitive; entries > 1 MiB
  (`maxReadmeSize`) skipped entirely.
- Placement: `path.Clean` + split; empty dir → ROOT; `modules/<name>` with no
  further `/` → submodule `<name>` (standard module structure, one level deep);
  anything else (e.g. `examples/basic/main.tf`, `modules/net/deep/main.tf`) SKIPPED.
- A directory-wrapped archive (`mod-1.0.0/main.tf`) has no root files and no
  submodules → `ErrNoRootModule` — the error message teaches the fix: "package the
  module directory's contents, not the directory itself (e.g. `tar -czf
  module.tar.gz -C path/to/module .`)" (parser.go:23).
- Submodule-only archives are legal (no Root, Submodules only — pinned).
- Readmes: root README > 1 MiB drops the readme (Root still parses); submodule
  README likewise; `LICENSE` never becomes the readme (pinned).

### 3.4 The HCL scanner's parse semantics (hcl.go — deliberately NOT a full HCL parse)

Upstream ships a 235-line block scanner instead of `hashicorp/hcl/v2` (5 modules /
~1.4 MB). Semantics our port must reproduce exactly (the upstream test vectors pin
them):

- Only four block TYPES are indexed: `variable`, `output`, `terraform`,
  `required_providers`; every other block body is skipped (skipped with the
  expression skipper, not byte-blind). Only `terraform.required_providers` nests two
  levels; depth hard-caps at 2.
- Expressions are NEVER evaluated — captured as raw source. `type` and `default`
  attributes store the expression TEXT (`Type: "string"`, `Default: "\"eu-west-1\""`
  — the default string carries its QUOTES, pinned). `description` strings are
  decoded via `hclString`.
- `hclString(expr)`: heredoc form `<<EOT…\nlines…\nEOT` → the lines between the
  first and last newline; escaped-template forms `$${`/`%%{` are unescaped
  placeholders (literal `${` in output); any OTHER `${`/`%{` means the value needs
  evaluation → `""`; otherwise Go `strconv.Unquote` (handles `\n`, `\"`, `\u…`);
  re-escape placeholders back. Pinned: description `"AWS region, not $${var.template}
  }"` renders `AWS region, not ${var.template} }` (trailing `}` survives — inside
  the quoted string); heredoc `Tags }\nEOT` renders `Tags }\n`.
- Scanner robustness (all pinned never-panic arms): unterminated string; lone
  backslash in string; unterminated heredoc; unterminated `/*`; braceless
  `variable {`; nested `${"${"${`; bare `}}}`. The skipper tracks `{[(` depth so an
  expression spanning lines (`aws = { … }` object) is consumed whole; comments
  (`#`, `//`, `/* */`) are transparent including inside expressions ("an unbalanced
  { in a comment" pinned); `configuration_aliases = [aws.alternate]` rides along in
  the provider object and is ignored.
- `${` templates inside strings can nest — recursion capped `hclMaxNesting = 32`.
- BOM: files are scanned after trimming a leading UTF-8 BOM (pinned:
  `"\xef\xbb\xbf" + terraform {…}` still parses).
- File order: sources scanned in SORTED filename order per directory map (Go
  slices.Sorted — deterministic inputs/outputs ordering).

### 3.5 Metadata shape (metadata.go — the version's metadata_json)

```jsonc
{
  "readme": "# vpc\n",                    // omitted when empty/oversized
  "root": {                                // omitted when no root sources
    "inputs":  [{ "name": "region", "type": "string", "description": "…",
                  "default": "\"eu-west-1\"", "required": false }],
    "outputs": [{ "name": "vpc_id", "description": "VPC id" }],
    "providers": [{ "name": "aws", "source": "hashicorp/aws", "version": "~> 5.0" }]
  },
  "submodules": { "net": { "readme": "…", "module": { …same Module shape… } } }
}
```

Go omitempty semantics on the wire: absent arms omitted; `Input.required` and every
`name` always present. Providers: from `terraform { required_providers { … } }` —
object form `{ source = "…" version = "…" … }` (extra keys ignored) or legacy
`name = "~> 3.0"` string form (version only, no source); dedup by name keeping the
FIRST; sorted by name (pinned order aws, random).

## 4. Data model

No schema migration (the B-59 posture — the landed six tables carry it):

- `packages`: one row per `(owner, 'terraform-module', lower('{name}/{provider}'))`,
  `semver_compatible = true`.
- `package_versions`: one row per canonical semver (`lower_version` uniqueness makes
  `v1.0.0`/`1.0.0` converge); `metadata_json` = §3.5's JSON, written ONLY on the
  version-created arm (a duplicate upload 409s before any write — upstream marshals
  metadata into the INSERT).
- `package_files` + `package_blobs`: ONE lead file `module.tar.gz` per version; the
  blob is the verbatim archive (R2 content key `packages/blobs/aa/bb/<sha256>`).
  Immutable: no OverwriteExisting anywhere in the router.
- `package_properties`: NONE for this type (no file properties, no lock property —
  the terraform STATE lock property belongs to type `terraform` only). The files API
  renders no properties (§1 out-of-scope note).
- Cleanup rules operate on the type like any other (`PACKAGE_TYPES` gains the entry,
  threading the three settings pages' rule forms — upstream package_form.go's
  `In(…)` enum).

## 5. The signed archive URL (upstream base/tool.go:36-95)

`CreateTimeLimitCode(data, minutes, startTime, nil)` = `startStr + %06d(minutes) +
hex(HMAC-SHA1)`, `startStr = startTime.Format("200601021504")` (12 chars), total
length 58 (`TimeLimitCodeLength = 12+6+40`). HMAC message:
`data + hex(secret) + startStr + endStr + minutes` where `endStr = start+minutes`,
secret = the general token signing secret (GetGeneralTokenSigningSecret — the landed
keystore row reader, container.ts's `loadSigningSecret` posture). `VerifyTimeLimitCode`:
length > 18; parse start/alive from the code; re-derive and constant-time compare;
window `start <= now < start + minutes`. Ports:

- Workers has no `time.Local` — the code formats/verifies in UTC (self-consistent
  create+verify; recorded divergence: upstream follows the server's TZ).
- WebCrypto HMAC-SHA1 is available; the hex(secret) bytes ride the message as UTF-8
  of the hex string (Go writes the hex STRING via Fprintf — byte-identical).

## 6. Edge cases, limits, failure modes

1. **32 MiB metadata cap** on TOTAL decompressed bytes — a legit module archive
   whose *.tf sources sum past it 413s on upload (upstream identical; archives are
   stored verbatim AFTER parse, so the cap binds parse-time only).
2. **512 MiB store cap** on the raw archive (our spool) — 413 (upstream unbounded;
   the standing recorded divergence).
3. **Immutability**: re-PUT of an existing version → 409 always (no overwrite).
   Delete then re-PUT is the upgrade path.
4. **Normalize collisions**: `PUT v1.0.0` then `PUT 1.0.0` → the second 409s
   (same canonical version, lower_version UNIQUE).
5. **`-/…` vs `/{username}`**: the literal route wins; no user can be named `-`
   (our owner resolution 404s it anyway — belt and suspenders).
6. **Private owners**: all five routes 404 for invisible owners (the shared gate);
   the archive route additionally honors a valid code — the code binds
   ownerId+name+version, so a leaked code grants exactly one archive for its 10
   minutes, matching upstream's threat model (Terraform sends no credentials on
   download).
7. **Empty versions list** → 404 with `package does not exist` (plain text).
8. **Scanner hostile input**: the seven pinned malformed sources must never throw
   (the scanner degrades — worst case attributes are empty); the parser never
   panics on arbitrary bytes.
9. **Sparse/huge tar entries**: per-entry reads stay under the remaining cap
   (upstream's second limited reader) — a sparse entry claiming huge sizes cannot
   inflate memory.
10. **`.tf.json` root-only archives** parse to an empty Root Module (blocks exist —
    pinned) and are legal uploads.
11. **README rendering**: rendered as package markdown — with a linked repo,
    relative links root at the repo's default branch (+ `modules/<sub>` treePath for
    submodule readmes — upstream RenderPackageMarkdown's CurrentTreePath,
    util_render.go:211-227); our renderer carries the repo-context mode; the
    treePath prefix rides the context path. No linked repo → plain render.
12. **Submodule view miss** (`/modules/{nope}` or a non-module type on that URL) →
    404 (upstream NotFound, web/user/package.go:208-214).

## 7. Testing plan (pins — upstream's own vectors where they exist)

- **Scanner/parser battery** (`terraform-modules.test.ts`, the service): build
  gzipped tar archives in-test (the helm battery's builder pattern) and port
  TestParseModuleArchive VERBATIM: the full-module vector (providers with
  configuration_aliases, comment with unbalanced `{`, escaped-template description,
  heredoc description, trailing comment, BOM, `._main.tf`/`backup.TF`/
  `examples/basic`/`modules/net/deep` skips, `modules/net` inputs+readme+LICENSE,
  `modules/json` via `.tf.json`), the submodule-only vector, the oversized-readme
  vector, `ErrNoRootModule`, the 32 MiB `ErrContentTooLarge`, the seven
  malformed-never-panic sources, and TestValidateAddress's four arms.
- **Time-limit code pins**: round-trip create→verify; expired window (start <
  now, now >= start+minutes); wrong data binding rejected; tampered code rejected;
  short code rejected; cross-version code (code for v1.0.0 fails v1.0.1).
- **Route battery** (`packages-terraform-modules.test.ts` or the protocols battery
  extension): versions envelope + 404-empty; download redirect's X-Terraform-Get
  (204, `./archive?archive=tar.gz&code=` shape, code verifies); archive download
  bytes verbatim + the code-bypass (anonymous + valid code → 200; invalid/expired →
  the read gate) + GET bump; upload happy path (201, metadata_json wire shapes, the
  verbatim blob round-trip, webhook emitted once), duplicate 409 (v-prefix collision
  too), quota 403s, 413 store cap, bad gzip/bad tar/no-root 400s; delete 204 + 404 +
  webhook; auth ladder (anonymous read on public owner OK, private owner 404,
  write gates).
- **View battery** (the ui page matrix or a focused file): the module view data +
  block render — install snippets (root source `host/owner/name/provider`, submodule
  `//modules/<name>`, terragrunt `tfr://`, credentials), inputs table with the
  required badge + quoted default text, outputs, providers, submodules list links;
  the route claim (9-segment `/modules/{sub}`) and the 404 arms (unknown submodule,
  wrong type, non-module URL shape falls through to the existing families).
- **Threading pins**: PACKAGE_TYPES carries `terraform-module` between swift and
  terraform (the cleanup-rule dropdowns inherit it); descriptor metadata parses.

## 8. Adaptation ledger (Workers divergences, each recorded in-code)

1. Spool cap 512 MiB (store) vs upstream's unbounded spool — the standing family
   divergence; store-cap 413 answers where upstream has no arm.
2. UTC instead of `time.Local` in the time-limit code (self-consistent).
3. The globallock serializes upstream's upload/delete; ours arbitrates on the D1
   UNIQUEs (the landed model.ts posture).
4. The per-type quota lattice entry (LIMIT_SIZE_TERRAFORM_MODULE) rides the
   generic-only lattice until the quota family lands per-type caps.
5. README treePath linking rides our repo-context renderer with the tree path in
   the context; exotic upstream renderhelper behaviors (attachment-markup
   interplays) degrade to plain links (the landed renderer's posture).
