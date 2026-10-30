# Findings — pre-deploy local git-side smoke (2026-10-30)

Black-box smoke of the git-facing surfaces against a LOCAL dev server, using
real clients: `git 2.43.0`, `git-lfs/3.4.1`, `curl 8.5.0`. Instance
`29.0.0+dev-208-gfc49368845` (from `GET /api/v1/version` on the live server).
Local D1 migrations: **46/46 applied (0045 included**, verified via
`SELECT COUNT(*) FROM d1_migrations` = 46 = the number of `*.sql` files).
No repo files were modified except this findings doc; nothing was committed;
all code/config were treated read-only against the running server.

Credentials discipline: PATs minted with
`node scripts/bootstrap-admin.mjs <user>` in its **local** mode (no
`--remote`), plaintexts captured to 0600 files under `/tmp/cf-gitea-smoke/`,
every minted token row deleted and every token file `shred -u`-ed at teardown
(verified: only the pre-existing sibling-fixture row `cfg_deadbeef` remains).

## 0. Verdict

- **8 surfaces exercised: 6 clean PASS, 2 findings** (1 HIGH, 1
  HIGH-adjacent), both **fix-before-deploy** items for the git side.
- The core plumbing is deploy-ready: smart-HTTP clone/push with both a PAT
  and a `gdt_` deploy-key token, the release→tag N2 arm (fresh `tag_name`
  creates the git tag, `created_at` filled from the tagged commit), the
  archive GET/POST arms (DEFLATE + export-ignore + upstream-exact POST body),
  and the LFS batch/upload/verify + locks family all behaved upstream-exact.
- The two failures share a theme: **the deploy-key credential is only
  half-wired** — it authenticates git transport but not the LFS endpoints
  (F1), and the API route you need to grant a second human identity push
  access 500s outright (F2).

### Blockers up front

| # | Severity | Finding |
|---|----------|---------|
| F1 | **HIGH** | `gdt_` deploy-key tokens are rejected by the LFS endpoints: `POST …/info/lfs/objects/batch` with Basic `deploy:<gdt_…>` → **401 `{"message":"Unauthorized"}`**, while the same token clones, fetches and pushes the same repo fine. A deploy-token clone of any repo carrying LFS objects dies at smudge with `batch response: Authentication required: Unauthorized` (reproduced with the real `git lfs` client and with raw curl, on two independently-booted servers). Upstream mounts its LFS routes **with** `AllowDeployToken` (`gitea/routers/web/web.go:1777`, method in `gitea/services/auth/deploy_token.go:16-17` — "Only add it to an auth group where a repo scoped credential makes sense"). PATs work everywhere on LFS; only deploy tokens are locked out. |
| F2 | **HIGH** | `PUT /api/v1/repos/{owner}/{repo}/collaborators/{user}` → **500 `{"message":""}`** with body `{"permission":"write"}` (also `"admin"` and `{}` — 422 with `"owner"`, so validation itself is fine). Auth is not the cause: the same PAT scores 200 on `GET /api/v1/user` and `GET …/collaborators` seconds earlier/later. Net effect: collaborators cannot be added via API at all, which also blocks any flows that depend on granting a second identity push access. |

### Environment collision (disclosure, not a product defect)

A sibling pool unit was concurrently running its own `vite dev` for the same
repo on `127.0.0.1:5173`; this unit's server found 5173 occupied and bound
**5174**. Both vite/workerd instances share the single persist dir
(`apps/worker/.wrangler/state`), so mid-run the sibling's test-fixture seed
(the `cfg_deadbeef` PAT row + the `root/smoke` repo) **replaced the shared D1
state**, wiping this unit's token and repo rows (~21:12 local). Consequences
for the record: first-pass observations below (§1–§7) were served by the
sibling's instance on 5173 — same pinned commit, same shared state — and
stand as observed; the pre-wipe findings (notably F1, observed at 21:10,
before the wipe) are unaffected; every claim that could have been poisoned by
the collision was **re-executed and reconfirmed on this unit's own instance
(5174)** after re-seeding (marked "reconfirmed" below). One alarm that turned
out environmental: a transient wave of 401 `invalid username, password or
token` across all API endpoints (§8) was exactly the wipe hitting the token
table — the server answered correctly against a DB where the token row no
longer existed; re-minting restored normal behavior, so it is **not** a
product defect. Operational lesson for the pool: concurrent `pnpm dev`/test
runs against the shared `.wrangler` state clobber each other's scratch data;
smoke units should check `ss -tlnp` for an existing listener before booting.

---

## 1. Boot + migrations — PASS

- `pnpm db:migrate:local` → "No migrations to apply" (state already at head);
  `d1_migrations` count = 46 = 46 migration files (0045 included).
- `pnpm dev --host 127.0.0.1` (background): ready in ~39 s; polled with curl
  on the explicit bind (the runner-images ::1 lesson) — `GET /api/v1/version`
  → **200** `{"version":"29.0.0+dev-208-gfc49368845"}` after ~1 s of polling.
  (First boot took the 5174 fallback per the collision note.)

**Verdict: deploy-ready.**

## 2. Auth realm (unauthenticated git) — PASS

- `curl` on `/root/smoke-git-1030.git/info/refs?service=git-upload-pack`
  with no credentials → **401**, `content-type: text/plain;charset=utf-8`,
  **`www-authenticate: Basic realm="Gitea (Basic Auth)"`**, body
  `Unauthorized`. This is the upstream disabled-OAuth2 arm exactly
  (`githttp.go:152-158` via `src/git-http/respond.ts:21-25` — the realm
  deliberately avoids the GCM OAuth2 trap).

**Verdict: deploy-ready.**

## 3. Repo + deploy-key token creation (API) — PASS

- `POST /api/v1/user/repos` `{"name":"smoke-git-1030","private":true,…}` →
  **201**; body echoes `full_name`, `"empty":true`, `default_branch:"main"`,
  and the sent `description` (the older id:0 create-serialization nit from
  findings-git-e2e §1 was still present — `id:0` in the create body — but is
  already a known, previously-reported item, not re-lodged here).
- `POST /api/v1/repos/root/smoke-git-1030/keys/tokens`
  `{"title":"smoke-deploy","read_only":false}` → **201**, body carries the
  plaintext `gdt_` token **once** and the scan-bait fingerprint
  (`gdt_57********ma`), `key_type:"token"` — upstream `CreateDeployKeyToken`
  shape (`deploykey_token.go:12-44`).

**Verdict: deploy-ready.**

## 4. git clone (real client, both credentials) — PASS

- `git clone http://deploy:<gdt_…>@127.0.0.1:5173/root/smoke-git-1030.git` →
  exit 0, "you appear to have cloned an empty repository" (correct for an
  empty repo), checkout on the unborn **`main`** (server-advertised default).
- `git clone http://root:<cfg_…>@…` → exit 0, same posture. Token-as-password
  (arbitrary username) accepted for both credential kinds per SPEC-0002 §2.5.

**Verdict: deploy-ready.**

## 5. git push (real client, both credentials) — PASS

- PAT clone: committed README/src → `git push origin main` →
  `* [new branch] main -> main`, exit 0 (root commit b24adc4).
- Deploy-token clone (read_only:false): fetched, committed DEPLOY.md, push →
  fast-forward `b24adc4..ecc742b`, exit 0 — the write-armed deploy token
  pushes.
- One `! [rejected] … non-fast-forward` push from a stale clone: correct
  server-side enforcement (client-local mistake, not a defect; the server
  accepted the rebased push immediately after).

**Verdict: deploy-ready.**

## 6. Release with fresh tag_name → git tag (N2) — PASS

- `POST /api/v1/repos/root/smoke-git-1030/releases`
  `{"tag_name":"v0.1.0-smoke","target_commitish":"main",…}` → **201**.
- `git ls-remote --tags` → `refs/tags/v0.1.0-smoke` **and**
  `refs/tags/v0.1.1-smoke` both present at the tagged commits (exit 0) — the
  release with a fresh `tag_name` really created its git tag (findings-links
  N2 closed on the wire, matching the 6b2bedc/efd1916 wave).
- **Tagged-commit fill observed on the wire, decisively**: the second release
  was POSTed at 13:06:12Z against a tip committed at 13:04:39Z (92 s earlier)
  and its `created_at` is `2026-10-30T13:04:39.000Z` — the **commit's
  committer time**, not the POST moment (upstream `release.go:148-158`).
- The release JSON key set matches upstream's swagger `Release` definition
  **exactly** (`assets,author,body,created_at,draft,html_url,id,name,
  prerelease,published_at,tag_name,tarball_url,target_commitish,upload_url,
  url,zipball_url`); `sha1`/`num_commits` correctly **never appear** on the
  wire (upstream swagger has no such props — the fill lives in D1 and shows
  through `created_at` only, per the efd1916 contract note).

**Verdict: deploy-ready.**

## 7. Archive arms (API GET + UI GET/POST) — PASS

- API `GET /api/v1/repos/{owner}/{repo}/archive/main.zip` (with PAT):
  **200**, `content-type: application/zip`,
  `content-disposition: attachment; filename="smoke-git-1030-main.zip"`,
  immutable `Link: <…/archive/<oid>.zip?rev=<oid>>; rel="immutable"` (the
  upstream nixos-tarball shape, `archiver.go:358`). HEAD answered 200 too.
- Real GET → valid zip; every entry **DEFLATE** (`compress_type: 8`, the
  5365236 fix observable); **`export-ignore` honored**: after committing
  `secret/ export-ignore` in `.gitattributes`, the re-fetched archive excludes
  `secret/` entirely while keeping `.gitattributes` and `VISIBLE.md`
  (upstream attribute semantics); weak ETag `W/"<oid>-zip-true"` — upstream's
  `W/"<commitID>-<type>-<prefixArchiveFiles>"` shape.
- UI GET `/{owner}/{repo}/archive/main.zip` (public repo): **200**,
  `application/octet-stream` + same disposition/Link/ETag family. *Minor
  divergence:* the UI arm says `application/octet-stream` where the API arm
  (and upstream's `ServeRepoArchive`, which sniffs the filename extension)
  say `application/zip` — cosmetic, both download fine; not a blocker.
- UI POST (InitiateDownload) → **200 `{"complete":true}`**
  (`application/json;charset=utf-8`) — upstream-exact for the stream path
  (`repo.go:381-391`).
- Private-repo posture: UI GET/POST with PAT auth → 404, unauthenticated →
  404 (no leak) — consistent with the known F11 posture from
  findings-git-e2e (UI routes do not honor PAT auth); documented, not
  re-lodged.

**Verdict: deploy-ready.**

## 8. LFS (real client + raw API) — FAILS on deploy tokens (F1), PASS otherwise

With the PAT (root):

- `git lfs track '*.bin'`, 1 MiB random `bin/data.bin`, `git push` → pre-push
  hook ran batch/upload/verify: `Uploading LFS objects: 100% (1/1), 1.0 MB`,
  exit 0; push output advertised locking support ("Locking support detected on
  remote origin…"), and the server answered `locks/verify` during push.
- Batch download (raw curl): **200** with upstream-exact envelope —
  `objects[0].actions.download.{href,header.Authorization}` (Basic echo).
- Downloaded href → **200, 1,048,576 bytes, md5 identical** to the pushed
  file — byte-perfect roundtrip.
- Batch **without** the `Accept: application/vnd.git-lfs+json` header →
  **415 `{"message":"Unsupported Media Type"}`** — upstream-faithful
  (`services/lfs/server.go:103-105` `CheckAcceptMediaType`); real clients
  always send Accept.
- Locks family, real client: `git lfs lock bin/data.bin` → "Locked"; `git lfs
  locks` → `bin/data.bin root ID:<n>` (list round-trips path/owner/id);
  `git lfs unlock` → "Unlocked"; final `locks` → `{"locks":[]}`. Raw arms:
  `POST locks` → **201** lock JSON `{"lock":{"id","path","locked_at",
  "owner":{"name"}}}`; owner `POST locks/{lid}/unlock` force=false → **200**
  with the lock JSON.
- Not-owner unlock, non-collaborator identity (assets PAT): → **401
  `{"message":"You must have push access to delete locks"}`** — upstream's
  exact pre-check message (`locks.go:268-306`); faithful.
- **Upstream's 500-on-not-owner bug-compat arm (`locks.go:311-318` → 500
  `{"message":"unable to delete lock : Internal Server Error"}` for a
  push-access identity that doesn't own the lock) was NOT reachable**: the
  only two ways to get a non-owner *with* push access both break — adding a
  collaborator 500s (F2), and the deploy-key identity is rejected before the
  lock logic (F1). Re-tested after re-seeding; still unreachable.

With the deploy-key token (`gdt_`):

- **F1**: git transport accepts it; `POST …/info/lfs/objects/batch` rejects it
  with **401**. Real-client symptom: fresh clone/fetch of an LFS repo fails
  with `Smudge error: … batch response: Authentication required:
  Unauthorized`. Observed twice (both servers), raw curl and real client.

**Verdict: blocked-with-reason — deploy-token × LFS (F1) is a
fix-before-deploy item; every PAT-path arm is deploy-ready.**

## 9. Collaborators (adjacent discovery, needed by the LFS not-owner arm) — FAILS (F2)

- `PUT /api/v1/repos/root/smoke-git-1030b/collaborators/assets`
  `{"permission":"write"}` → **500 `{"message":""}`** (empty message, swagger
  URL filler only). Also 500 with `"admin"` and `{}`; `"owner"` → 422
  (validation arm alive). Same PAT: `/api/v1/user` 200, `GET …/collaborators`
  → 200 `[]` — auth and the read arm are fine; the write arm dies server-side
  (no console trace in dev output; black-box record only).
- `GET …/collaborators/check/assets` → 404 with a plain-text body — correct
  upstream status for "not a collaborator", plain-text body instead of the
  API JSON error shape (low, cosmetic).

**Verdict: blocked-with-reason — F2 is a fix-before-deploy item.**

## 10. Cleanup record (executed and verified)

- Scratch repos deleted through the API cascade: `DELETE
  /api/v1/repos/root/smoke-git-1030b` → **204** (fresh repo), and — after the
  collision resurrected the pre-wipe repo row — `DELETE
  /api/v1/repos/root/smoke-git-1030` → **204** (direct D1 deletes fail on
  FK constraints; the API cascade is the correct tool). Verified:
  `repositories` holds only the sibling's `smoke` fixture row.
- Deploy-key rows: API-cascaded + direct delete of the orphaned pre-wipe row
  → `SELECT COUNT(*) FROM deploy_keys` = **0**.
- PAT rows minted by this unit (4 total, ids 2/8/9/10 across the wipe
  boundary): all deleted; final `personal_access_tokens` = only the sibling's
  pre-existing `cfg_deadbeef` fixture row (untouched — not this unit's).
- Token files (`pat*.txt`, `gdt*.txt`, `mint.log`): `shred -u`; scratch repos
  and scratch artifacts removed; `/tmp/cf-gitea-smoke/` left empty.
- This unit's dev server stopped via task kill; `ss -tlnp` shows nothing on
  5174 (the sibling's 5173 listener is not this unit's to stop).
- Residue note (collision aftermath, accepted as dev-scratch): the pre-wipe
  repo's git/LFS objects may remain as orphaned entries in the shared local
  R2 state; their D1 rows are gone (cascade verified for releases/keys), and
  the shared bucket is dev-only state.
