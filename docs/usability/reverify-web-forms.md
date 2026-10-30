# Re-verification: web-form journey sweep (production, FIXED deploy, 2026-10-30)

Re-run of `docs/usability/findings-web-forms.md`'s 7 journeys against
`https://cf-gitea.hecongw.workers.dev`, plus the two NEW fix verifications the
brief added. Method is identical to the original sweep (deploy-probes
`ui-login` idiom: `POST /login` form-urlencoded with the PAT as the password;
every form POST used the fields extracted from the live rendered HTML,
submitted as `application/x-www-form-urlencoded` with the `gitea_session`
cookie and a same-origin `Origin` header; redirects followed manually so every
303's `Location` was asserted verbatim).

**Deployment identity, verified before running**: `wrangler deployments list`
shows the active deployment (100%) is version `bd9dda74-6390-4984-aaf7-…`
(created 2026-10-30T02:57Z) — the FIXED deploy the brief names. (`GET
/api/v1/version` answers `29.0.0+dev-208-gfc49368845`, the vendored upstream
pin constant — it does NOT carry the deploy id, so the deploy check rode
wrangler, not the API.)

## Verdict summary

**7 of 7 journeys PASS. F-1 fix VERIFIED on both mission surfaces (with one
disclosed residual reader). B-3 fix VERIFIED end-to-end. 0 blockers.**
Step assertions: **87 — 83 pass / 4 fail**; of the 4 fails, 2 are harness
artifacts of this sweep itself (an admin cookie sent to the signup GET — the
page's signed-in redirect is by design) and 2 are ONE real residual finding
(R-1 below). F-2 (the `/user/settings/packages` 404) is gone exactly as the
original predicted — it self-resolved with this deploy.

| # | Journey | Verdict (original → now) |
|---|---------|--------------------------|
| 1 | Login → dashboard/profile | PASS → **PASS** |
| 2 | Create repo via `/repo/create` form | PASS → **PASS** (private-checkbox note re-confirmed) |
| 3 | Create issue via the web form | PASS → **PASS** |
| 4 | Comment via the web form | PASS → **PASS** |
| 5 | Repo settings description via the web form | PASS → **PASS** |
| 6 | User settings profile via the web form | PASS → **PASS** (+ F-1 fix verified) |
| 7 | v1.3 surface GET renders | PASS except F-2 → **PASS, all 7 surfaces** (F-2 self-resolved) |
| — | F-1 fix (profile trio → API readers) | **VERIFIED** on `/api/v1/users/{name}` + repo listings' owner objects; residual R-1 on `GET /api/v1/user` |
| — | B-3 fix (demo quota guards the web create) | **VERIFIED** (5 creates land, the 6th re-renders the refusal banner, nothing created) |

## Fix verification 1 — F-1 (the user profile trio reaching the API readers): VERIFIED

The original F-1: `description`/`website`/`location` set through the web form
stored and web-rendered fine, but the tier-1 API readers returned `""`. This
pass drove the trio through the WEB form (same form as J6, one POST:
`full_name` kept + fresh `description`/`website`/`location`) and cross-checked
four readers live:

| Reader | Result while the values were set |
|---|---|
| `GET /api/v1/users/p0probe` | **populated** — the three values byte-exact (`full_name` too) |
| `GET /api/v1/user/repos` → `owner` of the listed repo | **populated** — the three values byte-exact |
| `GET /api/v1/repos/p0probe/{repo}` → `owner` | **populated** — the three values byte-exact |
| `GET /api/v1/user` (token-identity self reader) | **still `""` for all three** → residual R-1 |

Both surfaces the brief names — `GET /api/v1/users/{name}` and the repo
listings' owner objects — carry the trio populated. **F-1 is fixed at its
reported severity** (the directory/owner readers a consumer actually fans out
over). The revert through the same web form restored the documented baseline
and the FIXED named-user reader confirms it (`full_name: "p0probe"`, the trio
empty).

### R-1 (residual, annoyance): `GET /api/v1/user` still renders the empty trio

- **Live**: with the trio set via the web form, `GET /api/v1/user` →
  `"description": ""`, `"website": ""`, `"location": ""` (while `full_name`
  round-trips — the same split the original F-1 documented, now confined to
  this one reader).
- **Mechanism** (repo, read-only): the F-1 fix converted the canonical
  serializer `apiUserFromRow` (`apps/worker/src/api/services/repository.ts:416`,
  trio projected off the row) and `services/user.ts`'s `toApiUser` is a thin
  delegation to it. But the auth middleware owns a THIRD, same-named local
  converter — `toApiUser(u: AuthUser)` (`apps/worker/src/api/auth.ts:50`) —
  which still hardcodes `location`/`website`/`description` as `""`
  (auth.ts:59-61); `GET /api/v1/user` renders `c.get("authUser")`
  (`api/routes/user.ts:46-48`), projected by exactly that converter
  (`api/auth.ts:89`). It predates the fix (last touched at `8c8464a`, the
  auth-wiring batch) and was not converted with it.
- **Upstream parity**: upstream `userGetCurrent` converts `ctx.Doer` through
  the same `convert.ToUser` every other reader uses — one converter, no
  split.
- **Severity**: annoyance (self reader only; every named-user and owner
  embedding is correct). The natural closing move is delegating auth.ts's
  converter to the canonical one like services/user.ts already does. Not
  applied — this unit verifies, it does not fix.

## Fix verification 2 — B-3 (the demo quota guards the web create): VERIFIED

The original B-3 (findings-first-run.md blocker 3): `DEMO_MAX_REPOS_PER_OWNER
= 5` was enforced on the API create and the push-create settle but NOT on the
web's `POST /repo/create` — 7 repos went through the form in one session with
no refusal. This pass re-drove exactly that bypass with a fresh non-admin
(the quota's upstream-faithful admin bypass makes the standing `p0probe`
account vacuous for this arm):

1. Signed up a throwaway `wformq-61b09c9b` through the WEB signup form
   (`POST /user/sign_up`, cookie-less, Origin-carried) → **303** + auto-login
   session; API confirms the account is **non-admin** (`is_admin: false`).
2. Five creates through the WEB create form → **303 each**, `Location:
   /wformq-61b09c9b/b3r-1` … `b3r-5`, verbatim.
3. The SIXTH attempt → **200 re-render, not a 303 create**, with the refusal
   verbatim — **"The owner has already reached the limit of 5 repositories."**
   — riding the `ui negative message` banner, the submitted values kept in
   the re-rendered form. `b3r-6` does not exist (anonymous GET → 404); the
   owner holds exactly the five (API list).
4. Cleanup: all five deleted via the API (204 each, every anonymous page 404)
   — the owner's repo list is `[]`, i.e. **0 < 5, under the limit**.

Mechanism confirmed in source (read-only): the web call site rides BOTH arms
through the same helper — `assertDemoRepoQuota` imported at
`apps/worker/src/ui/pages/repo-create.tsx:95`, called at :291 (personal arm;
the org arm rides the same helper), mapped to the re-render at :342 with the
`quota_reached_n` locale pair. The gate-off invariant and the admin bypass
are intact: `p0probe`'s own J2 create was un-quota'd (upstream
`CanCreateRepoIn` admin bypass), and the refusal text is the web-form wording
standing in for the API arm's 403 body, exactly as the module header
documents.

## Per-journey evidence

Field lists below are what the live HTML rendered (extracted, not assumed);
`*` marks a checkbox rendered checked. Steps ran against production on
2026-10-30 against deploy `bd9dda74+`; probe artifacts used one-shot names
(`wform-61b09c9b`, `wformq-61b09c9b`) and were deleted after. One-shot hex
for the run: `61b09c9b`.

### J1 — Login → dashboard/profile: PASS

1. Anonymous `GET /` → 200.
2. `POST /login` (`user_name` + `password=<PAT>`) → **303**, `Location: "/"`,
   `Set-Cookie: gitea_session=…`.
3. Cookie `GET /` → 200; differs from the anonymous render, carries the
   `p0probe` identity, no sign-in form.
4. Cookie `GET /p0probe` → 200, renders the username.

### J2 — Create repo via `/repo/create`: PASS

1. Cookie `GET /repo/create` → 200. Extracted form:
   `POST /repo/create [uid:select(=4), repo_name:text, private:checkbox*,
   description:textarea, auto_init:checkbox]` (plus the logout form).
2. Browser-faithful submit (`repo_name=wform-61b09c9b`, description,
   `auto_init`, `private` riding its rendered CHECKED default) → **303**,
   `Location: "/p0probe/wform-61b09c9b"` exactly.
3. Cookie `GET /p0probe/wform-61b09c9b` → 200, renders the repo name.
4. API cross-check → `"private": true` — the note re-confirmed: the form
   renders `private` CHECKED, so a browser-faithful submit creates a PRIVATE
   repo (the form's rendered default, unchanged from the original sweep).

### J3 — Create issue via the web form: PASS

1. Cookie `GET …/issues/new` → 200. Extracted form:
   `POST …/issues/new [title:text, content:textarea, milestone_id:select]`.
2. Posted title + content → **303**, `Location: "…/issues/1"` exactly.
3. Cookie `GET …/issues/1` → 200, renders the submitted title.

### J4 — Comment via the web form: PASS

1. Cookie `GET …/issues/1` → 200. Extracted form:
   `POST …/issues/1/comments [content:textarea]`.
2. Posted the content → **303**, `Location: "…/issues/1#issuecomment-…"`
   (anchored on the new comment; the anchor shape asserted by regex).
3. Cookie `GET …/issues/1` → 200, the comment text renders on the page.

### J5 — Repo settings description via the web form: PASS

1. Cookie `GET …/settings` → 200; the basics form extracted with its rendered
   defaults (the same checked/unchecked set the original recorded).
2. Re-posted the extracted fields with only the description changed →
   **303** back onto the canonical `…/settings`.
3. Re-GET → 200; the new description renders back in the form textarea.
4. API cross-check `GET /api/v1/repos/p0probe/wform-61b09c9b` → the new
   description byte-exact.

### J6 — User settings profile via the web form: PASS (web round-trip + revert)

1. Cookie `GET /user/settings` → 200. Extracted form:
   `POST /user/settings [name:text, full_name:text, description:textarea,
   website:url, location:text, keep_email_private:checkbox,
   keep_activity_private:checkbox]`. Rendered baseline captured:
   `full_name "p0probe"`, trio empty.
2. Posted new `full_name` + `description` → **303** onto `/user/settings`;
   the page re-renders the new description; API `full_name` confirmed.
3. F-1 arm and revert as described above; the revert rode the SAME form →
   **303**, and the FIXED named-user reader confirms the documented baseline
   restored.

### J7 — v1.3 surface GET renders: PASS, all 7 surfaces (F-2 gone)

| Surface | Path | Verdict | Evidence |
|---|---|---|---|
| Repo actions (empty state) | `…/actions` | 200 PASS | `page-content` shell renders |
| Repo actions job queue | `…/actions/job_queue` | 200 PASS | `page-content` shell renders |
| User packages settings | `/user/settings/packages` | **200 PASS** | shell + packages content — the original F-2 bare-404 is gone, self-resolved with this deploy exactly as predicted |
| Org packages settings | `/wformorg-61b09c9b/settings/packages` | 200 PASS | `page-content` shell renders |
| Admin actions runners | `/-/admin/actions/runners` | 200 PASS | admin content renders |
| Admin actions variables | `/-/admin/actions/variables` | 200 PASS | admin content renders |
| Admin actions job queue | `/-/admin/actions/job_queue` | 200 PASS | admin content renders |

(The org fixture was created via the API for the org arm and deleted in
cleanup.)

## Blockers

None. Every core journey completes end-to-end through the web UI, and both
targeted fixes are live on production.

## Cleanup (verified)

- Probe repo `p0probe/wform-61b09c9b` (carrying issue #1 + the comment):
  API `DELETE` → **204**; anonymous repo page → 404 at t+0.
- Probe org `wformorg-61b09c9b`: API `DELETE` → **204**; anonymous page → 404.
- B-3 repos `wformq-61b09c9b/b3r-1` … `b3r-5`: API `DELETE` → **204** each
  (`b3r-6` correctly 404s — never created); the owner's repo list → `[]`
  (under the limit, 0 < 5).
- Throwaway user `wformq-61b09c9b` (id 136): child-row census first (exactly
  1 session; 0 tokens/emails/user_settings/watchers/stars/follows/orgs),
  then session + user row removed via a **DISCLOSED admin D1 write** (the
  findings-first-run precedent; the demo sweep cleans repos, not users).
  Verified: profile page 404, `GET /api/v1/users/wformq-61b09c9b` → 404,
  `/explore/users` lists nothing.
- Profile: reverted through the SAME web form; the FIXED named-user reader
  confirms the baseline (`full_name: "p0probe"`, `description`/`website`/
  `location` empty).
- Token: the sweep's PAT (`cfg_9bf9a83f…`, minted via
  `scripts/bootstrap-admin.mjs p0probe --remote`) deleted by prefix via
  `wrangler d1 execute cf-gitea --remote`; row count 9 → 8 (drop exactly 1);
  the plaintext now answers **401** with upstream's exact error body. The
  8 remaining `personal_access_tokens` rows all predate this sweep — not
  touched. Local token files shredded.

## Honest command notes

- Single throwaway Node script (`/tmp/reverify-webforms.mjs`, zero deps,
  plain `fetch` with `redirect: "manual"`, the original sweep's shape);
  per-step HTML evidence dumped to `/tmp/webforms-reverify/` (36 files) and
  quoted above but NOT committed. Every log/evidence line scrubbed against
  the token and both session-cookie values.
- **The two harness-artifact fails, disclosed**: the script's first signup
  step sent the ALREADY-LOGGED-IN admin cookie to `GET /user/sign_up`, which
  303s for signed-in viewers by design (`redirectIfSignedIn`) — so the form
  extraction found nothing. The signup POST itself rode the correct
  cookie-less browser-faithful path and succeeded (303 + session). An
  anonymous control re-run after the sweep answers `GET /user/sign_up` →
  **200** with the `user_name` form present. Neither fail reflects product
  behavior; the B-3 verdict rests on the quota steps, which all passed.
- The J6 aggregate assertion ("all four readers") failed only on the
  `/api/v1/user` reader — R-1; the other three carried the values byte-exact.
- Nothing in the repo was modified by this unit except this findings doc; no
  commits made; no fixes applied.
