# Re-verification: fresh-visitor / first-run UX audit

Re-audited: 2026-10-30, against https://cf-gitea.hecongw.workers.dev (the FIXED
deployment), re-auditing `docs/usability/findings-first-run.md` (same day, pre-fix).
Method: the original's — curl-driven page fetches + form drives (a real signup, real
repo + wiki-page creates, real token mint + token login), HTML structural scans, asset
sweeps, response-header checks, and parity checks against the vendored upstream pin
(`gitea/` templates). The five fix-verifications were exercised on the wire, plus one
full signup → dashboard → token-mint → token-login → dashboard journey. All probe
artifacts were removed afterwards (cleanup disclosed at the bottom).

## Fix-verdicts (read these first)

### B-1 (HIGH) — the decoy password: FIXED

- `GET /user/sign_up` (200, text/html): **zero** `type="password"` inputs and zero
  "Password"/"Confirm Password" labels. Form fields are exactly `user_name` + `email`
  (+ submit). In their place, the upstream sign_up_tip slot carries the token-flow
  notice: "Accounts on this instance authenticate with personal access tokens, not
  passwords. After signing up, create a token under Settings → Applications and use it
  to sign in." (`ui/pages/first-run.tsx` — the B-1 fix's module header documents the
  upstream `DisablePassword` shape it mirrors.)
- `GET /login`: the credential field's visible label is now `>Access Token</label>`,
  with the helper paragraph "Sign in with a personal access token (PAT), not a password
  — accounts on this instance have no passwords. Create a token under Settings →
  Applications." The helper SURVIVES the failure re-render: a wrong-credential POST
  re-renders "The token is not valid." above the same Access Token label + helper, so
  the recovery guidance is on the page at the moment of failure.
- End-to-end coherence re-proven live: signup → mint PAT → POST /login with the token →
  303 → signed-in dashboard.

### B-2 (MEDIUM) — bare-text dead-end 404s: FIXED (correct conneg kept)

- `/explore/xyz` with a BROWSER Accept header → `404` + `text/html; charset=UTF-8`,
  the FULL themed shell (navbar, `<title>Page Not Found - cf-gitea</title>`,
  `status-page-error-title` "404 Not Found", footer), all referenced assets 200.
  `/explore/xyz/deep` answers the same way (multi-segment covered).
- `/{owner}/{repo}/nope` with a browser Accept → `404` + the themed shell **plus the
  repo header** (title "Page Not Found - {owner}/{repo}", `repo-header` present —
  upstream's `IsRepo` arm; 11.8 KB vs 4.2 KB for the headerless shell). A
  nonexistent-repo path (`/admin/nope-repo/nope`) gets the themed shell WITHOUT the
  repo header — existence never leaks through the 404.
- Bare curl / plain Accept on the same paths keeps the plain arm: `404` +
  `text/plain;charset=UTF-8`, body `not found` — the documented connection-negotiation
  split (the engine's answer for non-browser callers), matching upstream's
  Accept-conditional `status/404.tmpl` posture.
- All three 404 variants carry the F2 security headers (nosniff, SAMEORIGIN, CSP on the
  HTML arm) — the dead-end is now signed, themed, and hardened.

### B-4 (MEDIUM) — missing visitor affordances: FIXED

Anonymous view of a fresh public repo's home page now renders:

- The Watch / Star / Fork button group (`#repo-header-watch` present; labels "Watch",
  "Star", "Fork"; counts 0). For anonymous visitors each is a login-redirect anchor
  (`href="/login"` — the documented `/user/login` → `/login` rewrite applied; zero
  `/user/login` occurrences on the page) with the upstream tooltips "Sign in to
  watch/star/fork this repository." and `role="button"` + `aria-label`, matching
  `repo/header/watch.tmpl:51`'s guest arm. Signed in, the Watch button becomes the
  mode dropdown ("Participating and mentions" / "All activity").
- The clone panel: `repo-clone-https` tab ("HTTPS") and the `js-clone-url` readonly
  input carrying the full HTTPS URL
  `https://cf-gitea.hecongw.workers.dev/{owner}/{repo}.git` (the single most-copied
  first-run string). No "clone"-less repo pages remain in the sampled set.

### B-5 (MEDIUM) — unreachable wiki: FIXED

- The repo header tab strip now carries the Wiki tab
  (`href="{repo}/wiki"`) with `data-shortcut-keys="g w"` — upstream-exact attribute and
  value (`gitea/templates/repo/header.tmpl:166` at the pin).
- `/wiki/` renders the upstream empty state; the owner additionally gets "Create the
  First Page" (`/wiki?action=_new`, absent for anonymous — `CanWriteWiki` parity).
- The one-hop pages list: after creating a page, `/wiki/?action=_pages` renders the
  Pages view (`<title>Pages - {owner}/{repo}</title>`) listing the page row with its
  `/wiki/Home` and `/wiki/Home.md` links. On an EMPTY wiki `_pages` renders the wiki
  home content directly (200); upstream 303s to `/wiki` in that case (`wiki.go`
  `HasWiki` arm) — same destination, no dead end; noted as a cosmetic divergence only.

### F2 — security headers: FIXED

Swept on `/`, `/login`, `/user/sign_up`, repo pages, the wiki pages list, and the themed
404 HTML arm:

- `x-content-type-options: nosniff` and `x-frame-options: SAMEORIGIN` on EVERY sampled
  response class — HTML pages, the plain-text 404 arm, and `/assets/*` (immutable
  cache) alike (upstream's tree-wide `SecurityHeadersHandler` posture).
- `content-security-policy` on `text/html` responses only, upstream's general policy
  shape with the documented nonce → `'unsafe-inline'` adaptation:
  `default-src * data: blob:;script-src * 'unsafe-inline';style-src * 'unsafe-inline';`.
  Non-HTML responses (assets, the plain 404 arm) correctly carry no CSP.
- The design keeps upstream's set-if-absent semantics (`web/security-headers.ts`):
  handler-set headers (the raw/media `sandbox` matrix) win over the defaults.

## Per-area re-verdicts

### Area 1 — Anonymous browsing: PASS

`/`, `/explore/{repos,users,organizations,code}` all 200 text/html with coherent
chrome. `/explore/users` lists `admin` and the pre-existing `p0probe` (both expected;
the previous audit's probe stayed removed). The `/login` divergence and
`redirect_to=` anonymous-gate 303s re-verified consistent (`loginRedirect` emits
`/login?redirect_to=…`).

### Area 2 — Signup: PASS

Real `POST /user/sign_up` (fresh user, disclosed below) → 303 → `/` with a session
cookie → signed-in dashboard (notification counter, user menu, Sign Out, "No recent
activity.", "New Repository" links). With the B-1 fix the credential story is coherent:
the form collects only username + email and TELLS you the login credential is a PAT.

### Area 3 — Demo banner / quotas: banner PASS; the old B-3 quota gap is UNCHANGED

- Banner on every sampled page (home, all four explore tabs, login, signup) — "This is
  a demo instance: data on this instance is periodically cleaned."
- The original blocker 3 (web `POST /repo/create` bypassing
  `DEMO_MAX_REPOS_PER_OWNER`) was NOT in this fix wave and is still open in source:
  `DEMO_MAX_REPOS_PER_OWNER` lives only in `services/demo-quota.ts` (+ tests), and the
  web create submit (`src/ui/index.ts` `repoCreateSubmit`) enforces no quota. Both
  probe repos were created through the form without refusal (2 < 5, so no live
  over-quota proof was attempted this round). Still on the ledger.

### Area 4 — Docs / help affordances: PASS

Navbar "Help" → `https://docs.gitea.com` (`target="_blank"`); the home feature grid's
installation links point at `docs.gitea.com/installation/{install-from-binary,install-from-package}`
— upstream's canonical targets.

### Area 5 — JS/CSS asset posture: PASS

Every distinct `src=`/`href=` `/assets/...` reference across the sampled pages (home,
login, signup, anonymous repo home, wiki pages list, AND the themed 404 shell — the
page class that previously referenced no assets at all) returned 200; no 404/500 asset
refs anywhere sampled.

### Area 6 — v1.3 empty states (fresh repo): PASS (unchanged)

Actions "There are no workflows yet.", Packages "There are no packages yet." + the
documentation line, Issues "No results" + "Try adjusting your search filters" — all
exact upstream texts. Projects still 404 with the tab hidden (the documented
`has_projects=false` default divergence; unchanged, owner can enable in settings).
Wiki empty state exact; Releases/Tags count header present.

## Journey log (the one full drive)

1. `POST /user/sign_up` → 303 → `/`, session cookie set.
2. Dashboard signed in (user menu, Sign Out, empty activity/repo panels).
3. `POST /repo/create` (public, auto-init) → 303 → the repo page. (A first attempt
   passed `private=public` — checkbox semantics coerced it to PRIVATE; re-created
   without the field. Audit-method artifact, not a product defect: upstream's checkbox
   behaves the same.)
4. Anonymous repo page: B-4 affordances + B-5 tab verified (above).
5. Wiki: create "Home" page as owner (`/wiki?action=_new`, 303 → `/wiki/Home`) →
   `_pages` list renders (B-5).
6. Mint PAT at `/user/settings/applications` (scoped radio matrix; note: the scope
   values are `read:{category}`/`write:{category}` — a bare `read` value re-renders the
   honest inline error "invalid access token scope: read", the form's own radio
   values work).
7. Fresh browser context: `POST /login` with username + token → 303 → `/`, persistent
   session cookie (`remember`), dashboard shows the repo and user. Wrong-credential
   login re-renders "The token is not valid." under the Access Token label + helper.
8. Cleanup (below), then re-verification of removal.

## Honest notes

- The old cosmetic finding stands: `ui/pages/search-aux.ts`'s dispatcher comment still
  says the anonymous gate 303s to `/user/login`; the code (`loginRedirect`) emits
  `/login`. Unchanged this wave.
- `/api/v1` unknown paths still answer `text/plain` "404 Not Found" (spot-checked
  `/api/v1/nonexistent` → 404 text/plain) — the API-parity ledger note from the
  original audit, outside this audit's core.
- `p0probe` in `/explore/users` is a pre-existing account from an earlier audit wave,
  not this probe; left untouched.
- No fixes were applied and nothing was committed from this re-audit.

## Cleanup

The re-verification created and then fully removed:

- User `uxreprobe0961` (id 134), 2 repos (`ux-reverify-probe` — private via the
  method artifact above, `ux-reverify-pub` — public), 1 wiki page (`Home`, deleted
  with its repo cascade), 2 PATs (`ux-reverify-pat` read-scoped,
  `ux-reverify-cleanup` write-scoped, the latter minted solely to run the API repo
  deletes), 2 sessions.
- Repos were deleted via `DELETE /api/v1/repos/{owner}/{repo}` (both 204; the user
  repo list then returned `[]`, and D1 showed zero repository rows) so the normal
  delete cascade ran.
- The user row + 2 sessions + 2 token rows were then removed via an admin
  `wrangler d1 execute cf-gitea --remote` write (**DISCLOSED admin D1 write**, per the
  mission brief; satellite checks — email_addresses, user_settings,
  notification_states, repo_watchers, stars, follows, user_redirects — were all zero
  before the delete).
- Post-cleanup verification: D1 counts for user 134 all zero; `/uxreprobe0961` and
  `/uxreprobe0961/ux-reverify-pub` 404; both probe PATs 401 on `/api/v1/user`; the
  probe is absent from `/explore/users`; both ex-session cookies 303 to `/login`.
