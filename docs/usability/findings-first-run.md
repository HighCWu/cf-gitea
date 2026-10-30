# Findings: fresh-visitor / first-run UX audit

Audited: 2026-10-30, against https://cf-gitea.hecongw.workers.dev (production deployment).
Method: curl-driven page fetches + form drives (real signup, real repo creates, real token
mint + login), HTML structural scans, and parity checks against the vendored upstream pin
(`gitea/` templates + `options/locale/locale_en-US.json`) and the worker source. No fixes
landed from this audit; the probe account and all probe repos were fully removed afterwards
(cleanup disclosed in "Cleanup" below).

## Blockers (read these first)

1. **HIGH — the signup password is a decoy: login rejects it.** `/user/sign_up` collects
   "Password" + "Confirm Password" and ignores both (`services/user-accounts.ts:27` —
   "accepted-and-ignored", upstream form parity; there is no password store, SPEC-0002
   §4.6.7). The `/login` form then labels its credential field "Password" but verifies a
   PAT (`session.ts` POST handler, `TokenService.verify`); entering the just-registered
   password returns "The token is not valid." A fresh visitor who signs up, loses the
   auto-login session, and returns is locked out with a self-contradictory form: no
   password they ever set works, nothing on the page says a token is required, and the
   token must be minted (while the post-signup session is still alive) at
   `/user/settings/applications` and pasted into the field labeled "Password". The
   recovery path itself works end-to-end (verified: token mint → POST /login → 303 → /
   signed in), but the label/semantics mismatch is a real first-run trap. Minimal UX
   mitigations (not applied): label the field "Access Token (PAT)", link it to the token
   settings page from the login failure text, or surface a one-time "create your token
   now" nudge right after signup.
2. **MEDIUM — bare-text dead-end 404s inside `/explore/*` and repo subtrees.** Top-level
   unknowns (`/foo`, `/foo/bar`, `/user/login`) render the themed 404 page with full
   chrome. But unknown leaves inside the explore group and the repo subtree
   (`/explore/xyz`, `/{owner}/{repo}/nope`) return `404` + `text/plain` body `not found`
   (10 bytes) — no navbar, no footer, no way back. Upstream renders its themed 404
   (`status/404.tmpl`) across the whole web surface. Inconsistent with our own themed
   404 and a hard dead-end for a visitor who mistypes a repo path.
3. **MEDIUM — the demo repo-count quota does not guard the web create form.**
   `DEMO_MAX_REPOS_PER_OWNER = 5` (`services/demo-quota.ts`) is enforced on the API
   create routes (`api/routes/user-repos.ts`, `org-repos.ts`) and the git push-create
   settle path (`git-http/gate.ts`) — but NOT on the web UI's `POST /repo/create`. Live
   proof: 7 repos were created through the form in one session with no refusal. The
   banner promises a managed demo ("data … is periodically cleaned"); the primary
   creation affordance bypasses the only cheap quota.
4. **MEDIUM — repo page is missing upstream's visitor affordances.** A fresh repo page
   (anonymous AND signed-in) has no Watch / Star / Fork buttons and no clone-URL
   affordance anywhere on the page (zero occurrences of "clone" in the HTML). Upstream's
   header renders these for anonymous visitors as login-redirect buttons
   (`repo/header/watch.tmpl:51`, `star.tmpl:7`, `fork.tmpl:4`) and the clone dropdown is
   the single most important thing a first-time visitor copies. Note: upstream's
   hardcoded `/user/login` in those buttons would need our `/login` rewrite when this is
   implemented.
5. **MEDIUM — the wiki page exists but is unreachable.** `/{owner}/{repo}/wiki` serves
   the correct page (200, upstream-exact empty state), but the repo header has no Wiki
   tab — the `RepoTab` union (`ui/shell.tsx:259`) has no `wiki` member at all. A visitor
   cannot discover the wiki by navigation; only typing the URL works.

## Per-area verdicts

### Area 1 — Anonymous browsing: PASS with findings

- `/` home: full upstream-parity hero + feature grid, coherent chrome (navbar, demo
  banner, "Powered by Gitea" footer + Licenses), assets 200. Evidence: homepage HTML,
  all inline structure clean.
- `/explore/repos` (200), `/explore/users` (200 — lists `admin`, `p0probe`, joined dates),
  `/explore/organizations` (200, "No matching results found." = upstream
  `search.no_results`), `/explore/code` (200). Tab strip renders with SVG icons, active
  state correct.
- `/explore/code` carries instance-specific text ("Current code search results are
  provided by per-repository scans; a site-wide index is not configured.") — an honest,
  coherent disclosure of the SPEC-0019 posture, not leaked internals.
- `/login` 200 with chrome; `/user/login` 404s with the THEMED 404 (full chrome). The
  `/login` URL is a documented divergence (`ui/session.ts` header comment: "our web login
  lives at `/login` (upstream: `/user/login`, §2.1)"). Every rendered link and every
  anonymous-gate redirect (`/repo/create`, `/notifications`, `/user/settings`, repo
  search-aux) 303s to `/login?redirect_to=…` — internally consistent. (Upstream
  templates hardcode `{{AppSubUrl}}/user/login` in navbar/watch/star/fork/signup links;
  our renderer emits `/login` in all sampled spots.)
- Layout hygiene: structural tag-balance + leak-marker scan across 12 saved pages found
  no unclosed containers, no leaked JSON outside the upstream-standard
  `global-window-config` script block, no raw error text. The repo header badge
  "Public Access" checked out as upstream locale `repo.desc.public_access` — parity, not
  a concatenation bug.

### Area 2 — Signup: FAIL (works, but incoherent credential story)

Drive: real POST `/user/sign_up` (user `uxprobe1397`) → 303 → `/` with session cookie →
signed-in dashboard (notification counter, user menu, Sign Out; "Recent activity — No
recent activity.", "Repositories — No repositories yet."; New Repository / New
Organization links present). Form validation: duplicate username re-renders inline
"The username is already taken." (upstream parity). The account is immediately active —
no email verification, no captcha (per the open-demo posture, SPEC-0014).

FAIL detail = blocker 1: the collected password is discarded; the login form requires a
PAT under a "Password" label. Token minting UI (`/user/settings/applications`, upstream-
style scoped permission matrix) works, including its validation error ("You must select
at least one permission to create a token"); token login verified end-to-end.

### Area 3 — Demo banner / quotas posture: PASS on banner, FAIL on quota enforcement

- Banner on every page (home, explore, repo pages, login, signup, even the themed 404):
  "This is a demo instance: data on this instance is periodically cleaned." —
  dismissible per browser session via `sessionStorage` (inline script, no server
  round-trip), exactly the SPEC-0014 §4.4 design. Coherent and honest.
- Quotas: blocker 3 — web-form bypass of the 5-repo cap. Note the cap and refusal text
  live only in the API/push paths.
- Posture note (observation, not a defect): signup is open and instantly active, so the
  writable-public-instance risk rests entirely on the (bypassable) quota + the sweep.

### Area 4 — Docs / help affordances: PASS

- Navbar "Help" → `https://docs.gitea.com` (`target="_blank"`) — byte-parity with
  upstream `base/head_navbar.tmpl:33`.
- Actions empty state → `https://docs.gitea.com/usage/actions/overview/`; Packages empty
  state → `https://docs.gitea.com/usage/packages/overview` — both upstream's canonical
  targets, both resolve (upstream-managed).
- The code-search page explains its own index posture in place of a help link. No
  site-local help surface is expected (upstream ships none by default);
  `docs/guide/*` is repo-side and correctly not linked from the site.

### Area 5 — JS/CSS asset posture: PASS

Asset sweep across 11 pages (`/`, `/explore/repos`, `/explore/users`, `/explore/code`,
`/login`, `/user/sign_up`, repo home, repo `/actions`, `/wiki`, `/activity`,
`/commits/branch/main`): every `src=`/`href=` pointing at `/assets/...` (7 per page —
index CSS, theme CSS, `iife.*.js`, `index.*.js`, user-events sharedworker, favicon,
logo) returned HTTP 200. No 404/500 asset refs anywhere sampled. (The bare-text 404
path from blocker 2 naturally references no assets — that is part of the problem.)

### Area 6 — v1.3 empty states (fresh repo): PASS on texts, gaps on chrome

Created a fresh auto-initialized public repo and checked each surface as anonymous and
as owner:

| Surface | Our text | Upstream | Verdict |
|---|---|---|---|
| Actions | "There are no workflows yet." + "For more information on Gitea Actions, see the documentation." | `actions.runs.no_workflows` + `.documentation` | Exact match |
| Packages | "There are no packages yet." + "For more information on the package registry, see the documentation." | `packages.empty` + `.empty.documentation` | Exact match |
| Wiki | "Welcome to the Wiki." + "The wiki lets you write and share documentation with collaborators." + owner-only "Create the First Page" (absent for anonymous — `CanWriteWiki` parity) | `repo.wiki.start` template | Exact match |
| Releases / Tags | "0 Releases / 0 Tags" count header, empty list beneath (tags page adds its Search box) | `repo/release_tag_header` + empty list | Match (upstream renders no empty box either) |
| Issues / Pulls | "No results" + "Try adjusting your search filters." | `repo.issues.filter_no_results` + `.filter_no_results_placeholder` | Exact match |
| Projects | Not shown: `/projects` 404s, tab hidden | Upstream default: projects unit ENABLED on new repos (`DisabledRepoUnits: []`, header tab per `header.tmpl:146-154`) | Divergence — our `repo_settings.has_projects` defaults to FALSE (`db/schema.ts:1339`); owner can enable in settings ("Enable Projects" toggle present). Against the upstream-is-default rule. |
| Repo header chrome | No Watch/Star/Fork, no clone box; Releases count badge deliberately unrendered (documented in `ui/shell.tsx` — no maintained D1 counter); no Wiki tab (blocker 5) | header.tmpl renders all of these | Partial gap |

## Honest notes

- The audit created and then fully removed: user `uxprobe1397` (id 125), 7 repos
  (`ux-fresh-probe`, `ux-quota-2`…`ux-quota-7`), 1 PAT (`ux-audit-probe`), 2 sessions.
  Repos were deleted via `DELETE /api/v1/repos/{owner}/{repo}` (all 204, verified empty
  list) so the normal delete cascade ran; the user row + sessions + token were then
  removed via an admin `wrangler d1 execute cf-gitea --remote` write (DISCLOSED admin
  D1 write, per the mission brief). Post-cleanup verification: `/explore/users` no
  longer lists the probe, `/{owner}` and `/{owner}/{repo}` 404, the probe token 401s.
- Login happy-path was verified with a real minted token (PAT-as-password is the
  designed flow); the password path was verified to fail as described.
- `/api/v1` unknown paths return `text/plain` "404 Not Found" rather than upstream's
  JSON error body — outside this audit's core but noted for the API-parity ledger.
- Stale comment (cosmetic): `ui/pages/search-aux.ts` still says the anonymous gate
  redirects to `/user/login`; the code redirects to `/login`.
- The `cfg_`-prefixed token format is a documented SPEC-0002 divergence (upstream PATs
  are 40-hex, no prefix) — noted so it is not re-flagged.
