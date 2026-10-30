# Findings: deployed-instance link-integrity crawl (2026-10-30)

Subject: `https://cf-gitea.hecongw.workers.dev`. Method: web-session BFS over
rendered HTML — POST /login (p0probe PAT) → `gitea_session`, then every unique
same-origin `href`/`src` extracted from each 200 HTML page was fetched and its
final status recorded. Seeds: `/`, `/explore/{repos,users}`, the user profile
and every user-settings tab (incl. packages/runners), a seeded scratch repo's
full page set (home/code/commits/branches/tags/releases/issues/pulls/labels/
milestones/projects/wiki/actions/packages/settings tabs), an org's pages and
settings (incl. a D1-seeded cleanup rule), and the full `/-/admin` surface
(incl. the v1.3 admin-actions group). All checks ran WITH the session, so a
red below is red for a logged-in (even admin) viewer; the anonymous
303-onto-`/login?redirect_to=…` gate class is separately covered green by
`scripts/deploy-probes.mjs`'s window batteries and produced no rows here.

Totals: **428 unique URLs checked, 400 × 200, 28 × 404** — no 5xx, no
non-resolving 3xx, **0 red `/assets/*`** (7 asset URLs checked), no session
drops. Known-risk v1.3 surfaces: `/-/admin/actions/{runners,variables,
job_queue}` all 200; org packages settings with a seeded rule — rules list,
`/rules/2` (edit), `/rules/2/preview` all 200.

The 28 reds, classified:

## A. Real dead links (structural — 4)

| # | Page of origin | Target | Status | Class | Notes |
|---|---|---|---|---|---|
| A1 | `/-/admin/orgs` (settings pencil, `admin-orgs.tsx:426`) | `/org/{org}/settings` | 404 | dead-link | Verified against a LIVE org (`/org/linkcrawl-org/settings`). Upstream mounts the org-settings group at `/org/{org}/settings/*` (upstream `web.go:970` + `:1017`); this repo mounts org settings at `/{org}/settings` (per `ui/index.test.ts:419-426`) with no `/org/{org}/settings` alias, so the upstream-shaped pencil 404s for every org. The `admin-orgs.tsx:423-426` comment claims the target is "a LANDED page (org-settings.tsx)" — that claim is false at the mounted path. Fix direction (not applied): either alias the route or emit `/{org}/settings`. |
| A2 | `/user/settings/applications` (`user-settings-applications.tsx:470`) | `/api/swagger` | 404 | dead-link | The "API docs" hint link (upstream serves the swagger UI at `/api/swagger`; `user-settings-applications.test.tsx:263` pins the href). The route is not mounted on the deployed instance — every logged-in user sees a dead link. |
| A3 | `/{owner}/{repo}/activity`, "N Releases published by…" section (`repo-activity.tsx:809`) | `/{owner}/{repo}/src/{tag}` (bare, no `tag/` prefix) | 404 | dead-link | The emitted shape is upstream-faithful (upstream `pulse.tmpl:128`), but upstream resolves it via the deprecated `m.Get("/*")` catchall under `/src` (upstream `web.go:1749-1755`) which §3.3 of the UI router deliberately does NOT claim ("the legacy no-prefix form … 404-shells"). Internal incoherence: we emit upstream's URL without upstream's catchall — the link 404s even when the tag exists (`/src/tag/v0.1.0` was also 404 here only because the fixture tag is missing in git, see Note N2). The releases list page does it right: `releases.tsx:833` emits `/src/tag/{tag}` gated on the tag existing in git. |
| A4 | `/-/admin/orgs` → `/org/wformorg-0f5735e1/settings` | same shape as A1 | 404 | dead-link | Same A1 mechanism, caught on a since-swept fixture org; listed separately only because it appeared as its own crawl row. Counts once with A1 conceptually. |

## B. Deploy-lag artifact, not a HEAD-code dead link (4)

| # | Page of origin | Target | Status | Class | Notes |
|---|---|---|---|---|---|
| B1-B4 | none on the deployed instance (probe seeds only) | `/user/settings/packages`, `/user/settings/packages/rules/add`, `/user/settings/packages/rules/1`, `/user/settings/packages/rules/1/preview` | 404 | expected (feature not yet deployed) | The user-scope Packages settings twin landed at HEAD `74df9ad` (post-v1.3-tag). The deployed build predates it: the deployed user-settings sidebar has no Packages nav item (verified in HTML). Nothing on any deployed page links these URLs — zero user-visible impact until the twin deploys. At HEAD the routes + nav fold are landed (commit message; `ui/index.test.ts:429-431`). |

## C. Mid-crawl fixture sweep transients (9)

All 404 because the referenced fixture was deleted by the demo/probe sweep
between the referring page's fetch and the target check. Verified after the
crawl: no `wform*` rows in D1, the home page and org list no longer link them,
and a freshly seeded generic package's bare URL **303s to the latest version**
(`/{owner}/-/packages/{type}/{name}` → `…/{version}`), so the package
breadcrumb shape itself is healthy.

| # | Page of origin (at crawl time) | Target | Status | Class |
|---|---|---|---|---|
| C1 | `/` (dashboard) | `/p0probe/wform-0f5735e1` | 404 | transient (swept repo) |
| C2 | `/` (dashboard) | `/p0probe/wform-0f5735e1/pulls` | 404 | transient |
| C3 | `/p0probe?tab=activity` | `/p0probe/wform-0f5735e1/issues/1` | 404 | transient |
| C4 | `/user/settings/organization` | `/wformorg-0f5735e1` | 404 | transient (swept org) |
| C5-C9 | each package's `/versions` page breadcrumb (`packages.tsx:1418`) | `/p0probe/-/packages/{generic,helm,npm,nuget,pypi}/probe-*` (bare package URL) | 404 | transient (swept packages; bare URL verified 303 when present) |

## D. Admin users page links rows whose profiles are defined to 404 (2)

| # | Page of origin | Target | Status | Class | Notes |
|---|---|---|---|---|---|
| D1 | `/-/admin/users` (row for user `assets`, id 3, `status='prohibited'`) | `/assets` | 404 | data-artifact + route collision | Prohibited users are intentionally invisible to every viewer (§4.8 — profile 404 is the documented posture), but the admin users list still links their public profile. Upstream's admin user list links the admin edit surface (`/admin/users/{id}/edit`), not the profile. Extra wrinkle: the username `assets` collides with the `/assets` static prefix, so that profile could never render even if unprohibited. |
| D2 | `/-/admin/users` (row for `gitea:deploy-key`, id −3, `status='prohibited'`) | `/gitea:deploy-key` | 404 | data-artifact | Same class: a synthetic negative-id deploy-key identity listed (and linked) on the admin users page, with a deliberately-404ing profile. Username contains a colon — no upstream-legal username shape. |

## E. Probe-only 404s (9) — my seed guesses, nothing user-visible links them

`referrer = none` for all of these; listed for the record, each is either a
documented reduction or an over-seed:

- `/-/monitor` — upstream `/admin/monitor` unmounted; not linked by the admin nav.
- `/user/settings/actions` (bare) — the recorded user-actions bare-redirect reduction (v1.4 backlog P2).
- `/linkcrawl-org/settings/actions` (bare) — the org actions remainder (v1.4 backlog P2).
- `/linkcrawl-org/settings/collaboration` — over-seed; no such org tab upstream either.
- `/p0probe/linkcrawl/projects` — repo projects unmounted; repo navbar does not link it.
- `/p0probe/linkcrawl/settings/githooks` — unmounted; not linked by the settings nav.
- `/p0probe/linkcrawl/settings/packages` — over-seed; no repo-scope packages settings upstream either.
- `/user/packages` — over-seed; no such upstream route.
- `/user/profile/p0probe` — probe artifact (wrong URL guess for a profile).

## Notes

- **N1 — deployment vs HEAD**: the deployed build predates HEAD (`74df9ad`).
  Green-with-session everywhere else, including all repo and org settings
  tabs (collaboration, branches, tags, hooks, lfs, actions + secrets/
  variables/runners/general), wiki, explore, notifications, and the admin
  surface.
- **N2 — release without a git tag (API parity observation, out of
  link-crawl scope)**: `POST /api/v1/repos/{o}/{r}/releases` with a fresh
  `tag_name` created the release row but no git tag (upstream auto-creates it
  from `target_commitish`; `GET /api/v1/repos/{o}/{r}/tags` returned `[]`).
  Consequence: every git-tag-shaped link for that tag 404s (`/src/tag/{tag}`,
  and the A3 link twice over). The releases list page degrades correctly (it
  gates the `/src/tag/` link on the tag existing — `releases.tsx:94,833`).
- **N3 — asset class clean**: 7 unique same-origin `/assets/*` URLs checked,
  0 red.
- **N4 — expected-gate class empty**: the crawl rode a login session, so
  anon-gating produced no reds; the anonymous 303 →
  `/login?redirect_to=…` shape is asserted green by deploy-probes'
  window batteries on the same instance.

*Probe hygiene: the PAT used (bootstrap p0probe, prefix `cfg_07459911`) and
its session were destroyed after the crawl; scratch fixtures (repo
`p0probe/linkcrawl`, org `linkcrawl-org`, cleanup rules 1-2, package
`linkprobe-pkg`) were deleted. No code was changed.*
