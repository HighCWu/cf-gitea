# Pre-deploy smoke: today's API/UI-side surfaces (local dev, 2026-10-30)

Live black-box smoke of the day's API/UI-side commits — scope gates (56109ec),
`/user` counts (40120ae), release tag-creation + draft-publish (6b2bedc +
29ecd1d), `assigned_by` (4f8ade7), the UI page set, and the packages serving
header set — against a LOCAL dev server, not production.

Method: curl (API) + curl with a `gitea_session` cookie (UI, via the real
`POST /login` with the PAT-as-password); git push over smart-HTTP to seed a
commit. No code changes; every claim below quotes a response this unit saw.

## Environment

- Server: `pnpm dev --host 127.0.0.1` from the repo root (vite 8.3.5,
  workerd), serving `http://127.0.0.1:5173` — booted by this unit (no sibling
  server was up; ports 8787/8788/5173/3000/8080 probed empty first). LEFT
  RUNNING on port **5173** for sibling reuse.
- Migrations: `wrangler d1 migrations apply cf-gitea --local` checked once —
  "No migrations to apply" (up to date).
- Version: `GET /api/v1/version` → `29.0.0+dev-208-gfc49368845`.
- Credentials: admin `smokeqa` + all-scope PAT minted via
  `scripts/bootstrap-admin.mjs smokeqa` (local mode); plaintext kept in a
  0600 `/tmp` file, row deleted and file shredded after (see Cleanup). Two
  scratch repos (`smoke-main`, `smoke-empty`, both public), one scratch user
  (`smokeb`), one scratch package.

## Verdict summary

**Scope gates PASS · `/user` counts PASS · releases PASS · assigned_by PASS ·
UI pages PASS · packages PASS with 1 FAIL arm (Range with a zero start).
1 fix-before-deploy item.**

### Per-surface verdict lines

1. **Scope gates (56109ec): PASS.**
   - Token API mint of a `read:user` token: `POST /api/v1/users/smokeqa/tokens`
     with `Authorization: token <PAT>` → `401 {"message":"auth required"}`
     (upstream `reqBasicAuth` parity); retried with basic auth
     `-u smokeqa:<PAT>` → `201` with `scopes:["read:user"]`.
   - `GET /api/v1/user` with the read:user token → **200**.
   - `PATCH /api/v1/user` with it → **403**
     `{"message":"token does not have at least one of required scope(s), required=[write:user], token scope=read:user"}` —
     byte-identical to upstream `routers/api/v1/api.go:299`.
   - Scopeless token (`no-token-scope`, minted via local D1 — the token API
     itself rejects scope-less mints, see Notes) vs `GET /api/v1/repos` →
     **403** `required=[read:repository], token scope=no-token-scope`.
   - Anon public read `GET /api/v1/repos/smokeqa/smoke-empty` → **200**;
     control anon `GET /api/v1/user` → **401**.
2. **`/user` counts (40120ae): PASS.** `smokeb` (write:user token) followed
   `smokeqa` via `PUT /api/v1/user/following/smokeqa` → **204**; `GET
   /api/v1/user/following` as smokeb → `["smokeqa"]`. Self view
   `GET /api/v1/user` → `followers_count: 1`; anon `GET /api/v1/users/smokeqa`
   → `followers_count: 1` (the one follower is public).
3. **Releases (6b2bedc + 29ecd1d): PASS.**
   - Seeded one commit via git push (smart-HTTP, PAT auth) with
     author=committer date `2025-01-15T10:00:00+00:00`.
   - `POST .../releases {"tag_name":"v0.1.0",...}` → **201**, and
     `GET .../tags` now lists `v0.1.0` at the pushed commit — the fresh tag
     was created by the release POST.
   - `created_at` echoes the commit time exactly:
     `"created_at":"2025-01-15T10:00:00.000Z"`.
   - Draft flow: `POST` draft with fresh tag `v0.2.0` → **201**, `draft:true`,
     `published_at:null`, tag NOT yet in `GET .../tags` (upstream behavior);
     `PATCH .../releases/4 {"draft":false,"name":"..."}` → **200**,
     `draft:false`, `published_at` set, tag `v0.2.0` NOW listed, and
     `created_at` re-filled to the commit time `2025-01-15T10:00:00.000Z`.
4. **`assigned_by` (4f8ade7): PASS.** `POST .../issues` → 201 (number 1);
   `PATCH .../issues/1 {"assignees":["smokeqa"]}` → **201** (upstream's
   201-on-edit parity), response carries `assignee: smokeqa`;
   `GET .../issues?assigned_by=smokeqa` → **200** returning the issue;
   control `?assigned_by=smokeb` → empty list.
5. **UI: PASS.**
   - `POST /login` (PAT in the password field, Origin header required) →
     **303** → `/`; `GET /` with the session → **200** `<title>Dashboard -
     cf-gitea</title>`.
   - Repo home `GET /smokeqa/smoke-main` (session) → **200**
     `<title>smokeqa/smoke-main</title>`.
   - `GET /api/swagger` → **200**, chunk links present:
     `/assets/js/swagger.D_PJtGPn.js` + `/assets/css/swagger.CCkSNymr.css`,
     data link `/swagger.v1.json`.
   - `GET /swagger.v1.json` → **200**, valid JSON, `openapi: 3.0.3`, 306
     paths.
   - Pulls list `GET /smokeqa/smoke-main/pulls` (session, owner) → **200**
     with 1 hit for "New Pull Request".
   - Empty repo as anon `GET /smokeqa/smoke-empty` → **200**, message arm
     ("This repository does not have any content."), **0** "Quick Guide"
     hits; contrast: the OWNER view of the same repo has the Quick Guide
     (clone/push instructions) — the two arms diverge exactly as intended.
6. **Packages: PASS except one Range arm (the fix-before-deploy item).**
   - Publish: `PUT
     /api/packages/smokeqa/generic/smokepkg/1.0.0/smoke-file.txt`
     (basic PAT auth, 56-byte body) → **201**; listing
     `GET /api/v1/packages/smokeqa` shows `smokepkg 1.0.0 generic`.
   - Download `GET` → **200**, byte-identical body (`cmp` clean), with the
     new header set present: `x-content-type-options: nosniff`,
     `content-security-policy: sandbox allow-scripts allow-modals
     allow-popups allow-downloads`, `accept-ranges: bytes`,
     `content-disposition: attachment; filename=smoke-file.txt`.
   - `If-None-Match: *` → **304** (header set intact minus length/last
     validators); `If-Modified-Since: <exact Last-Modified>` → **304**;
     bogus `If-None-Match: "abc123"` → **200** (correct). No ETag is
     emitted on any arm — upstream parity, not a bug (see Notes).
   - Range: `bytes=20-29` → **206**, `content-range: bytes 20-29/56`, 10
     bytes, correct slice; `bytes=1-9` → 206, 9 bytes, correct;
     `bytes=-5` → 206, `bytes 51-55/56`, 5 bytes, correct.
     **FAIL arm: every closed range with a zero start** — `bytes=0-9` →
     **206** `content-range: bytes 0-9/56` but `content-length: 56` and the
     FULL 56-byte body (reproduced twice; `bytes=0-0` → same, full body).
     `bytes=0-` (open-ended) is correct (full body IS the right answer).

## Findings

1. **HIGH — fix before deploy: package download 206 with a zero-start bounded
   range serves the full body.** Repro (local, port 5173):

   ```
   curl -H "Range: bytes=0-9" \
     http://127.0.0.1:5173/api/packages/smokeqa/generic/smokepkg/1.0.0/smoke-file.txt
   # → HTTP/1.1 206 Partial Content
   #   content-range: bytes 0-9/56
   #   content-length: 56          ← should be 10
   #   body: all 56 bytes          ← should be 10 bytes
   ```

   Only the bounded-start-at-zero arm is broken: `bytes=1-9`, `bytes=20-29`,
   `bytes=-5`, and open-ended `bytes=0-` are all correct, so the shape smells
   like a truthiness test on `start === 0` (or a falsy `start` check) in the
   slicing path of the packages file-serving layer. Upstream serves this
   surface through Go's `http.ServeContent` (`routers/api/packages/helper/
   helper.go:70`), which honors every range arm including `bytes=0-N`;
   resumable-download clients (LFS, pip, npm) issue zero-start ranges and
   will corrupt or fail. Everything else about the serving contract (200/304
   headers, other range arms, byte-exact bodies) passed.

2. **LOW — informational: no ETag on package downloads; conditional caching
   rests on Last-Modified only.** `If-None-Match` therefore only 304s with
   `*`; a stored-validator cache can only use `If-Modified-Since` (verified
   304 on exact match). Checked against upstream: `helper.ServePackageFile`
   sets no ETag either (`routers/api/packages/helper/helper.go:60-70`,
   `ServeHeaderOptions{Filename, LastModified}`) and Go's
   `http.ServeContent` does not synthesize one — so this is parity, not a
   gap. Recorded so the next sweep doesn't re-flag it.

3. **LOW — informational: scoped tokens cannot be minted for another user
   without that user's credential.** The token API requires basic auth
   (header PAT → 401 `auth required`, exact upstream `reqBasicAuth` shape),
   and basic auth accepts a PAT-as-password but no password exists anywhere
   (no password store — already a documented cross-cutting trap in
   `docs/usability/findings-first-run.md`). Net: a fresh user's first scoped
   token must be minted by the user themself through the UI settings page;
   scripts/bootstrap-admin.mjs (D1) is the only seeding path. This smoke
   D1-minted tokens for `smokeb` and the `no-token-scope` one for the gate
   arm; disclosed here, cleaned up below.

4. **LOW — cosmetic: `@localhost` emails rejected by the API but accepted by
   the bootstrap script.** `POST /api/v1/admin/users` with
   `smokeb@localhost` → 400 `email address is invalid: smokeb@localhost`
   (retry with `@example.com` → 201), while `bootstrap-admin.mjs` wrote
   `smokeqa@localhost` straight into D1. Tooling-vs-API validation drift;
   no user-visible impact unless someone bootstraps an address the UI/API
   would refuse to set.

5. **LOW — orphan parent package row survives its version delete.**
   `DELETE /api/v1/packages/smokeqa/generic/smokepkg/1.0.0` → **204** and
   `package_versions` emptied, but the parent `packages` row remained in
   local D1 (`owner_id=3, type=generic, name=smokepkg`) — upstream removes
   the emptied parent (`DeletePackageIfEmpty`). Not user-visible in this
   build (the row did not appear on `/explore/packages` — 0 hits, and its
   owner was gone), so this is D1-hygiene drift, not a live bug; the row was
   removed by hand in cleanup and `packages`/`package_versions` re-counted 0.

## Notes (parity checks done while verifying)

- Scope-deny message is upstream-exact: `gitea/routers/api/v1/api.go:299`
  formats `token does not have at least one of required scope(s),
  required=%v, token scope=%v` — our 403 bodies match byte-for-byte.
- Scope-less token mint via the API → 400 `access token must have a scope`
  for both `{}`-scopes and omitted scopes — exact upstream message
  (`gitea/routers/api/v1/user/app.go:127`). The `no-token-scope` value
  exists only in the internal mint path (the worker's own scope-gate tests
  use it the same way).
- `GET /api/v1/admin/users/{username}` returns a plain-text `404 Not Found`
  even for existing users — NOT a parity bug: upstream's swagger exposes
  only `patch`/`delete` on that path (checked both the served
  `swagger.v1.json` and `gitea/templates/swagger/v1-swagger.generated.json`);
  user reads go through `GET /api/v1/users/{username}` (verified 200) and
  the admin list (verified).

## Cleanup

Executed immediately after this doc was written (every claim below re-checked
against the tables afterward):
- `DELETE /api/v1/repos/smokeqa/smoke-main`, `.../smoke-empty` via the PAT →
  204/204 (releases, tags, issue ride the repo delete; verified 0 remaining).
- `DELETE /api/v1/user/following/smokeqa` as smokeb → 204 (`follows`
  re-counted 0), then admin `DELETE /api/v1/admin/users/smokeb?purge=true`
  → 204. Self-delete of smokeqa → 422 (cannot delete the authenticated
  self), so smokeqa + its remaining PAT rows were removed via local D1 and
  `users` re-listed: only the three standing users remain
  (`gitea:deploy-key`, `assets`, `root`).
- API-minted tokens deleted: scoped-smoke via
  `DELETE /api/v1/users/smokeqa/tokens/4` → 204; the D1-minted rows
  (b-smoke, scopeless-smoke) and the bootstrap PAT deleted against local
  D1. **Disclosure (coordination incident):** the D1 delete was keyed on
  token NAME (`WHERE name IN ('bootstrap','scopeless-smoke','b-smoke',
  'scoped-smoke')`), not on this unit's user_id — a sibling unit was
  concurrently smoking against the same local server and a `bootstrap`
  token minted for its account at 21:02 fell inside that name-based
  delete's blast radius; the sibling re-minted twice at 21:18 (rows for
  user 2 and user 1 now present). Lesson recorded: token teardown must key
  on `user_id`/`prefix`, never on a shared name like `bootstrap`.
  `personal_access_tokens` re-listed after: the standing `smoke` row
  (`prefix=cfg_deadbeef`, user 2, minted ~20h before this run — well before
  this session started) plus the sibling's two fresh `bootstrap` rows; none
  of them this unit's.
- Scratch package removed by
  `DELETE /api/v1/packages/smokeqa/generic/smokepkg/1.0.0` → 204; the
  orphaned parent `packages` row it left behind (finding 5) was deleted via
  local D1; `packages`/`package_versions` re-counted 0.
- Token material shredded: `shred -u` on the PAT file, all token files, the
  login cookie jar, and the two D1-minting helper scripts (all lived under
  /tmp with 0600); the smoke scratch git worktree, probe bodies, and dev
  log removed. Dev server left running on 127.0.0.1:5173 (see Environment).
