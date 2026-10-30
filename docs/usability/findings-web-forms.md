# Findings: web-form journey sweep (production, 2026-10-30)

Target: `https://cf-gitea.hecongw.workers.dev` (the deployed production worker).
Scope: the core journeys a real user drives through the WEB UI — session cookie +
HTML forms — not the API. Every form POST used the fields extracted from the live
rendered HTML (a small parser pulled each `<form>`'s action/method and its
input/textarea/select fields incl. defaults), submitted as
`application/x-www-form-urlencoded` with the `gitea_session` cookie and a
same-origin `Origin` header (the deploy-probes write-arm idiom). Redirects were
followed manually so every 303's Location was asserted verbatim.

Method note: the web login takes the PAT as the password (the established
deploy-probes `ui-login` methodology — `POST /login` form-urlencoded
`user_name` + `password=<PAT>` → 303 + `gitea_session`). A fresh admin PAT was
minted for the standing `p0probe` user via `scripts/bootstrap-admin.mjs p0probe
--remote` and its row shredded afterwards (prefix-scoped D1 delete; verified
dead with a 401). The probe user's profile was reverted to its captured
baseline through the same web form; fixture repo + org were deleted via the API
(both 204, both anonymous-dead at t+0).

## Verdict summary

**6 of 7 journeys PASS. 0 blockers. 2 findings (1 annoyance, 1 deploy-lag
degradation). 57 step assertions: 54 pass / 3 fail** (the 3 fails are the two
findings below — one is an API-side serializer gap, one is a route the
production deploy predates).

| # | Journey | Verdict |
|---|---------|---------|
| 1 | Login → dashboard/profile | PASS |
| 2 | Create repo via `/repo/create` form | PASS |
| 3 | Create issue via the web form | PASS |
| 4 | Comment via the web form | PASS |
| 5 | Repo settings description via the web form | PASS |
| 6 | User settings profile via the web form | PASS (with API-reader finding F-1) |
| 7 | v1.3 surface GET renders | PASS except `/user/settings/packages` (F-2) |

## Blockers

None. A real user can complete every core journey end-to-end through the web UI
today: login, repo create, issue create, comment, repo settings, profile
settings all round-trip with correct 303 targets and persisted state.

## Findings

### F-1 (annoyance): the tier-1 user API readers return `description`/`website`/`location` as `""` even after the web form (or the API PATCH) sets them

- **Journey**: J6 (user settings profile). The WEB round-trip itself is green:
  `POST /user/settings` → 303 → the settings page re-renders the new
  description and `full_name` (form → `saveUserProfileColumns` → the `users`
  row → page). The failure was only the API cross-check.
- **Repro (live)**:
  1. `PATCH /api/v1/user/settings {"description":"desc-probe-check-xyz"}` → 200.
  2. `GET /api/v1/user/settings` → `"description": "desc-probe-check-xyz"` (correct).
  3. `GET /api/v1/user` → `"description": ""` (empty).
- **Mechanism** (repo, read-only inspection): the row-level writer
  `saveUserProfileColumns` (`apps/worker/src/api/services/user-settings.ts:98`)
  persists all four profile columns; the settings converters project them. But
  the tier-1 directory serializer `apiUserFromRow`
  (`apps/worker/src/api/services/repository.ts:416`) hardcodes
  `description: ""`, `website: ""`, `location: ""` (the "documented
  zero/defaults" placeholders) while `full_name` (row.displayName) projects
  fine — which is exactly the observed split (full_name round-tripped, the
  other three did not).
- **Upstream parity**: upstream Gitea's `convert.ToUser` populates the User
  API struct's Description/Website/Location from the user row, so API
  consumers (and the vendored frontend where it reads these fields) see empty
  profile text that web users did set.
- **Severity**: annoyance (no journey breaks; data is stored and rendered on
  the web side, invisible only through `/api/v1/user`-family readers).

### F-2 (deploy-lag degradation): `GET /user/settings/packages` answers a bare 404 on production

- **Journey**: J7. `GET /user/settings/packages` with a valid admin session →
  **404** with a 10-byte body (`not found`) — a router fall-through, not the
  rendered not-found shell. The org twin `GET /<org>/settings/packages`
  renders correctly (200, pageClass `organization settings packages`, title
  `Packages - cf-gitea`).
- **Mechanism**: the user-scope packages family landed in the repo in 74df9ad
  (2026-10-30, "post-v1.3-tag", mounted by the orchestrator) — AFTER the last
  production deploy. Per the probe convention this is the documented
  not-yet-mounted degradation, not a code 404: the route exists in
  `apps/worker/src/ui/index.ts` (the `/user/settings/packages` GET +
  rules/preview families). It should go live with the next deploy; a red flag
  only if it still 404s after that deploy.
- **Severity**: annoyance (deploy lag), self-resolving at the next deploy.

## Per-journey evidence

All form field lists below are what the live HTML actually rendered (extracted,
not assumed); `*` marks a checkbox rendered checked. Steps ran against
production on 2026-10-30; probe artifacts used one-shot names (`wform-0f5735e1`)
and were deleted after.

### J1 — Login → dashboard/profile: PASS

1. Anonymous `GET /` → 200.
2. `POST /login` (`user_name` + `password=<PAT>`) → **303**, `Location: "/"`,
   `Set-Cookie: gitea_session=…`.
3. Cookie `GET /` → 200; body differs from the anonymous render, carries the
   `p0probe` identity in the nav, and shows no sign-in form.
4. Cookie `GET /p0probe` (profile) → 200, renders the username.

### J2 — Create repo via `/repo/create`: PASS

1. Cookie `GET /repo/create` → 200. Extracted form:
   `POST /repo/create [uid:select(=4), repo_name:text, private:checkbox*,
   description:textarea, auto_init:checkbox]` (plus the logout form).
2. Posted the extracted fields with `repo_name=wform-0f5735e1`, a description,
   `auto_init` set → **303**, `Location: "/p0probe/wform-0f5735e1"` exactly.
3. Cookie `GET /p0probe/wform-0f5735e1` → 200, renders the repo name.

Note: the create form renders `private` CHECKED, so a browser-faithful submit
creates a PRIVATE repo (confirmed via the API: `private: true`). That is the
form's rendered default, not a sweep error.

### J3 — Create issue via the web form: PASS

1. Cookie `GET /p0probe/wform-0f5735e1/issues/new` → 200. Extracted form:
   `POST …/issues/new [title:text, content:textarea, milestone_id:select]`
   (no `label_ids` group — the repo has no labels).
2. Posted title + content → **303**, `Location: "/p0probe/wform-0f5735e1/issues/1"`.
3. Cookie `GET …/issues/1` → 200, renders the submitted title.

### J4 — Comment via the web form: PASS

1. Cookie `GET …/issues/1` → 200. Extracted form:
   `POST …/issues/1/comments [content:textarea]`.
2. Posted the content → **303**,
   `Location: "…/issues/1#issuecomment-3964"` (anchored on the new comment).
3. Cookie `GET …/issues/1` → 200, the comment text renders on the page.

### J5 — Repo settings description via the web form: PASS

1. Cookie `GET /p0probe/wform-0f5735e1/settings` → 200. Extracted basics form:
   `POST …/settings [repo_name:text, template:checkbox, description:textarea,
   website:url, private:checkbox*, archived:checkbox,
   enable_internal_tracker:checkbox*, enable_projects:checkbox,
   enable_releases:checkbox*, enable_packages:checkbox*, enable_pulls:checkbox*]`.
2. Re-posted the extracted fields with only the description changed → **303**
   back onto the canonical `/p0probe/wform-0f5735e1/settings`.
3. Re-GET → 200; the new description renders back in the form textarea.
4. API cross-check `GET /api/v1/repos/p0probe/wform-0f5735e1` →
   `"description": "renamed-by-web-form 0f5735e1"` (repo-level serializer
   projects it correctly, unlike F-1's user-level one).

### J6 — User settings profile via the web form: PASS (web) / F-1 (API cross-check)

1. Cookie `GET /user/settings` → 200. Extracted form:
   `POST /user/settings [name:text, full_name:text, description:textarea,
   website:url, location:text, keep_email_private:checkbox,
   keep_activity_private:checkbox]`.
2. Posted new `full_name` + `description` → **303** onto `/user/settings`;
   the page re-renders the new description.
3. API `GET /api/v1/user`: `full_name` round-tripped, `description` stayed
   `""` → F-1.
4. Reverted through the SAME form → 303; API confirms baseline restored
   (`full_name: "p0probe"`, `description: ""`); website/location untouched.

### J7 — v1.3 surface GET renders: PASS except F-2

With a valid session cookie (admin where relevant):

| Surface | Path | Verdict | Render evidence |
|---|---|---|---|
| Repo actions (empty state) | `/p0probe/wform-0f5735e1/actions` | 200 PASS | `page-content repository actions`, `empty-placeholder`, title `Actions - p0probe/wform-0f5735e1` |
| Repo actions job queue | `…/actions/job_queue` | 200 PASS | `page-content repository actions` |
| User packages settings | `/user/settings/packages` | **404 FAIL** | bare `not found` fall-through → F-2 |
| Org packages settings | `/<org>/settings/packages` | 200 PASS | `page-content organization settings packages`, title `Packages - cf-gitea` |
| Admin actions runners | `/-/admin/actions/runners` | 200 PASS | `page-content admin actions`, title `Actions - cf-gitea` |
| Admin actions variables | `/-/admin/actions/variables` | 200 PASS | `page-content admin actions`, title `Variables - cf-gitea` |
| Admin actions job queue | `/-/admin/actions/job_queue` | 200 PASS | `page-content admin actions`, title `Actions - cf-gitea` |

(The org fixture was created via the API for the org-settings arm and deleted
in cleanup.)

## Cleanup (verified)

- Probe repo `p0probe/wform-0f5735e1` (carrying issue #1 + the comment):
  API `DELETE` → **204**; anonymous repo page → 404 at t+0.
- Probe org `wformorg-0f5735e1`: API `DELETE` → **204**; anonymous page → 404.
- Profile: reverted to the captured baseline through the web form, then
  confirmed via the API (`full_name: "p0probe"`, `description`/`website`/
  `location` empty).
- Token: the sweep's PAT row deleted by prefix (`cfg_a706cfd2`) via
  `wrangler d1 execute cf-gitea --remote`; the row count dropped by exactly 1
  and the plaintext token now answers **401**. The remaining
  `personal_access_tokens` rows all predate this sweep (the standing admin +
  earlier probe-window tokens — not touched).

## Honest command notes

- The sweep was a single throwaway Node script (`/tmp/webforms-journeys.mjs`,
  zero deps, plain `fetch` with `redirect: "manual"`) reusing the
  deploy-probes idioms; per-step HTML evidence was dumped to
  `/tmp/webforms-evidence/` (27 files) and is quoted above but NOT committed.
- The token was displayed once by the bootstrap script and immediately moved to
  a 0600 file; every log/evidence line was scrubbed against the token and the
  session cookie value before writing.
- One mid-run adaptation: J6's first pass left the profile description set
  while the API cross-check failed; the revert rode the same web form and the
  F-1 diagnosis used a separate `PATCH /api/v1/user/settings` probe that was
  itself reverted.
- Nothing in the repo was modified by this unit except this findings doc; no
  commits made.
