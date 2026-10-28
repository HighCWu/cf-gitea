# Pre-Publish Secret Scan — 2026-10-28

The repository (720 commits, single `main` branch, ~1034 distinct paths) is about
to become a public GitHub repository. This scan covers the **entire history** —
every blob ever committed, including unreachable objects — plus the current
working tree's untracked files. Verdict at the bottom: **PUBLIC-SAFE** (no
secrets), with one owner-acknowledged non-blocking disclosure flag.

## Method

- Object inventory: `git rev-list --all --objects` (7419 objects) +
  `git cat-file --batch-all-objects --batch-check` → 2652 blobs (~100 MB),
  **including unreachable objects** (758 commits + 1 tag + 4186 trees also
  inventoried). Every blob was dumped to a scratch dir and grepped per pattern
  family; every hit was manually reviewed in context (object sha + path +
  surrounding lines) before classification.
- sha→path attribution via the `rev-list --objects` map, so each hit is
  reported with the file it lived in and the era it lived there.
- Working tree: `git status` untracked set scanned (result: **empty** — no
  untracked files exist); in-flight sibling-modified files were only
  surface-grepped through `git diff` added lines, per the parallel-work policy.
- Calibration targets (the two known incidents) were verified independently,
  not assumed.

## Pattern families run and results

### 1. Credential prefixes / key shapes

| Pattern | Hits |
|---|---|
| `gh[posur]_…`, `github_pat_…` (GitHub PATs) | 0 |
| `AKIA…`/`ASIA…` (AWS access keys) | 0 |
| `sk-(live\|test\|proj)-…` style API keys | 0 |
| `xox[baprs]-…` (Slack) | 0 |
| `CLOUDFLARE_API_TOKEN` / `CF_API_TOKEN` assignments with values | 0 |
| `"oauth_token"` / `refresh_token` / `access_token` with long values (wrangler OAuth creds) | 0 |
| `BEGIN (OPENSSH\|RSA\|EC\|DSA\|PGP)?…PRIVATE KEY` blocks | 2 blobs — same file |
| `cfg_<8hex>_<32base32>` (this repo's own gitea-style PAT shape) | 4 distinct strings |

- The two private-key hits are two historical versions of
  `apps/worker/src/ui/pages/user-settings-keys.test.tsx`; the PEM body is the
  base64 literal `b3BlbnNzaC1rZXk=` — which decodes to the ASCII string
  "openssh-key". Synthetic test fixture. **BENIGN-EXPLAINED.**
- The 4 cfg-shaped tokens: `cfg_00000000_AAAA…`, `cfg_0123abcd_abcdefgh…`,
  `cfg_ffffffff_BBBB…`, `cfg_ffffffff_AAAA…` — all hand-written test fixtures
  in auth/UI tests (visible sequential or repeated-character filler). **No
  real PAT ever entered git. BENIGN-EXPLAINED.**

### 2. Keyword-adjacent high-entropy runs

Pattern: hex/base64 runs ≥32 chars within ~20 chars of
`token|secret|password|api_key|authorization|bearer|credential|refresh`
(case-insensitive) → **30 blobs**. Manual review of every match line:

- 21 blobs: doc prose (`docs/compat/ui-parity-survey.md` section lists like
  "secrets/actions-secrets+variables/hooks/keys…", "token-first/session-cookie")
  — no literal values. **BENIGN-EXPLAINED.**
- 8 blobs: synthetic test fixtures (`cfg_00000000_…`, `cfg_ffffffff_…`,
  `cfg_0123abcd_…`, `"0123456789abcdef01234567…"`) in auth middleware/session/
  application tests. **BENIGN-EXPLAINED.**
- 1 blob: `scripts/mirror-e2e.README.md` contains
  `MIRROR_CREDENTIAL_KEY=OR9xOOi4L+VpTHWpz3d9tCwNWGex2CVu5tSO3Q0vbKE=` inside
  the *suggested CI job* snippet. Context review: this is a sample AES-256-GCM
  **KEK for the local/CI mirror e2e** — it encrypts loopback-fixture source
  credentials inside scratch local D1 only; the README explicitly documents it
  as CI-local and regenerable per run ("openssl rand -base64 32 fresh per CI
  run is fine"), production uses `wrangler secret`. It appears in exactly one
  blob ever, the script reads it from the never-committed `.dev.vars`. It
  grants access to no external system. **BENIGN-EXPLAINED** (dev/CI-only KEK
  sample; documented value).

### 3. 40-hex runs (gitea token shape + Cloudflare token shape)

44 distinct strings across all history, each reviewed in context — all
accounted for, none token-like:

- Git OID constants: `0000…0` (ZERO_OID), repeated-digit e2e fixtures
  (`1111…1`…`eeee…e` in `check-migrations.mjs`), `deadbeef…`, `abcdef…`
  sequences, synthetic SHAs in test suites.
- Well-known public digests: empty-tree `4b825dc6…`, SHA-1("") `da39a3ee…`,
  SHA-1("foobar") `8843d7f9…`, RFC 2202 HMAC-SHA1 test vectors
  `b6173186…` / `effcdf6a…`.
- Commit SHAs quoted as references: the gitea submodule pin
  `fc4936884…`, upstream durable-git commit `d5eba04e…`, local fixture/evidence
  tips in `docs/design/p0-evidence.md` and `scripts/deploy-probes.README.md`,
  golden HTML fixtures. Commit SHAs are identifiers, not secrets.
- The 10-28 window adds only the submodule pin + a synthetic test SHA (see §5).

### 4. Binding IDs — wrangler configs and deployment identifiers

- Path history: only **one** wrangler path ever existed
  (`apps/worker/wrangler.jsonc`, 12 historical blob versions).
- **Every one of the 12 historical versions carries the identical committed
  placeholder `database_id: a72f93d3-f85a-411e-880e-7effaed306bb`.** No
  deviation, ever. No `account_id` was ever committed. `docs/ops/deploy-notes.md`
  quotes the same value explicitly labeled as the placeholder.
- All other UUID-shaped strings in history (~70 distinct) triaged: Cloudflare
  Workers **deployment version IDs** in `docs/design/p0-evidence.md`
  ("Deploy shipped as ONE version: …"), drizzle migration snapshot ids, and
  test fixture ids. Version IDs are deploy metadata, not access-granting
  values. **BENIGN-EXPLAINED.**

### 5. Secrets-shaped files ever committed

Path scan over all 1034 distinct historical paths for
`dev.vars|.env|secret|credential|.pem|id_rsa|id_ed25519|.p12|.pfx|token`:
only `.dev.vars.example` (contains only the documented `GIT_TOKEN=devtoken`
dev placeholder), source/test files whose *names* legitimately contain
"secret"/"token", and a drizzle-random migration filename. **No `.dev.vars`,
`.env`, credentials file, or key file was ever committed.** `.gitignore`
covers `.env`, `.env.*`, `.dev.vars`.

### 6. URLs / hostnames

All hostnames from every URL in every blob, deduplicated: dominated by
synthetic hosts (`example.com`, `test.local`, `*.invalid`, `*.example`,
`hooks.example.com`, `p0mirror-dummy.invalid`, …) and public third parties
(`docs.gitea.com`, `github.com`, `git-lfs.github.com`, `www.w3.org`,
`purl.org`, `www.sitemaps.org`, and `tsx.hirok.io` — which is the public
documentation site of the npm `tsx` package, not owner infra).

**One flag (owner-acknowledged, non-blocking):**

- `cf-gitea.hecongw.workers.dev` — committed in 5 historical
  `wrangler.jsonc` versions and still at HEAD as `"APP_URL"` in `vars`
  (functional: webhook payload compare URLs), plus runbook (the documented
  live deployment), RELEASE-NOTES, and 30 refs in `docs/design/p0-evidence.md`.
  It is **live and publicly serving** (HTTP 200 verified 2026-10-28).
  Classification: **SUSPECT → owner decision taken: non-blocking disclosure
  flag.** It exposes the account's workers.dev subdomain (`hecongw`); it is
  not a credential and grants no access. Agreed remediation (no history
  rewrite): rename the account's workers.dev subdomain in the Cloudflare
  dashboard after publish to invalidate the published hostname, and swap
  `wrangler.jsonc` `APP_URL` to `cf-gitea-demo.aiapp.run` at the next deploy.
- The demo domain `cf-gitea-demo.aiapp.run` appears in docs — sanctioned
  public URL per the owner.

## Incident calibration (the two known 2026-10 incidents)

1. **Terminal PAT display incident (2026-10):** verified it never entered
   git. All 53 commits dated 10-28 were diffed; the only long-hex *added*
   lines across all of them are the gitea submodule pin sha and the synthetic
   test SHA `0123456789abcdef…` (a 404-path probe fixture). No 40-hex string
   was inserted near `d1` / auth / probe changes. Combined with the
   history-wide cfg-shape scan (only 4 synthetic fixtures) and the
   keyword-entropy scan (no token-looking literals), the PAT never reached
   any object in the database.
2. **`scripts/bootstrap-admin.mjs`:** single commit in history (`0dd7cca`),
   never modified since. Verified at HEAD: tokens are minted at runtime from
   `randomBytes(24)` (`cfg_<8hex>_<32base32>`), digest stored, plaintext
   printed exactly once; **no hardcoded fallback token exists** (the only
   literals are the BASE32 alphabet and format strings).

## Working tree (untracked files)

`git status` untracked set is **empty** — nothing to scan. In-flight sibling
modifications were only surface-grepped via `git diff` added lines for secret
shapes (cfg tokens, PAT prefixes, AKIA, private-key headers, long-token
assignments): zero hits.

## Verdict

**PUBLIC-SAFE.** Zero secrets across the full object database (including
unreachable objects): no credentials, no private keys, no real D1/account IDs,
no secrets files, no wrangler OAuth material, no internal-infrastructure
hostnames beyond the one owner-acknowledged workers.dev flag above. The two
known incidents are verified to have never entered git. Pre-publish actions
are **optional hardening only**: the workers.dev subdomain rename + `APP_URL`
swap agreed in §6.
