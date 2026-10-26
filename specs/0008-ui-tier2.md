# SPEC-0008: Tier-2 UI, slice 1 — official-bundle repo pages on Hono JSX

Status: **draft** · Date: 2026-10-24 · Implements ADR-0001 decision **D2 (Tier 2)**.

Inputs (cited throughout, not re-derived):

- `docs/ui-tier2-plan.md` — the feasibility spike (build proof, DOM contract, serving
  plan, first-pages data gaps, risks). Referred to below as "spike §n".
- SPEC-0004 §2.4 — tier-1 endpoint surface feeding the pages.
- SPEC-0002 §2.8 — web sessions are **documented-only** (not built); CSRF dropped
  upstream at this pin.
- SPEC-0003 §2/§3 — repo-scoped route ownership, ACL matrix, name validation.
- SPEC-0006 §2.1 — LFS routes are repo-scoped `/:owner/:repo(.git)?/info/lfs/*`.

Numbering note: ADR-0001's SPEC-order list names the UI spec "0006"; `specs/0006-lfs.md`
and `specs/0007-orgs-teams.md` took those numbers first, so the UI SPEC lands as 0008.

## 1. Problem and scope

The Worker is headless today (`src/index.ts` runs the engine with `ui: false`; every
repo page 404s). The spike proved the vendored Gitea frontend builds standalone with
zero Go (784 files / ~13.9 MB, content-hashed, Vite manifest resolvable from Hono),
and enumerated the DOM/CSS/JS contract our server-rendered HTML must satisfy so the
unmodified official bundles enhance our pages (spike §1–§4). This SPEC specifies the
first implementing slice: serve three repo pages for **public repositories, anonymous,
read-only**, reusing Gitea's own bundles.

### 1.1 In scope

1. Assets pipeline: gitignored build output, deterministic `pnpm build:assets`, wrangler
   `assets` config with an exact `run_worker_first` enumeration, cache headers, and the
   TS Vite-manifest reader (§2.3).
2. Rendering architecture: Hono JSX pages under `apps/worker/src/ui/**`, the shell DOM
   contract (§2.4), and the `src/index.ts` integration point (§2.2).
3. Auth model decision for pages: **anonymous-only for this slice** (§2.5).
4. Three pages: repo browse (file list + README), commit log, file view (§3.3), with
   the README/markup render pipeline (§3.4) and per-file latest-commit enrichment (§3.5).
5. Edge cases (§4), testing plan (§5), milestones U1–U5.

### 1.2 Out of scope (this slice)

- Session/PAT login for pages, private-repo browsing, any cookie issuance (§2.5).
- Write actions of any kind: star/watch/fork, create/edit file, settings, admin.
- Commit detail page (`/{owner}/{repo}/commit/{sha}`) — list rows emit upstream-shaped
  URLs that currently land on the 404 shell (open question 1).
- Issues/PRs/releases/wiki/org/user pages, dashboard, explore/search.
- Blame view (no data source — spike §6.3), commit keyword search and total counts
  (spike §6.2 gaps), "recently pushed branches" prompt (spike §6.1 gap).
- Topics / languages bar / latest-release label: their backing services have not
  landed (SPEC-0004/0005 batches); the pages feature-detect and omit (§3.3).
- CSP headers and per-request nonces (spike §8 lists the decision; open question 6).
- User theme switching UI — `data-theme="gitea-light"` is fixed for this slice (§4.6).

## 2. Surface: routes, assets, DOM contract, auth

### 2.1 Route and page inventory

All routes are `GET`-only. `{owner}/{repo}` segments are case-folded for resolution and
rendered in original case (gate convention, `src/git-http/acl.ts`). "Core chunks" = the
four manifest entries every page needs (spike §3.1): `web_src/js/iife.ts` (blocking,
head), `web_src/js/index.ts` (`js/index.<h8>.js` module + `css/index.<h8>.css`),
`web_src/css/themes/theme-gitea-light.css`, plus the `user-events.sharedworker` URI in
`window.config`. No page pulls lazy feature chunks in this slice (no mermaid/katex/
CodeMirror triggers are emitted).

| Route | Page (`src/ui/pages/`) | Data calls (see §3.2–3.3) | Asset chunks | Auth |
|---|---|---|---|---|
| `GET /:owner/:repo` | `home.tsx` — repo browse (header, branch selector, file list, README) | `resolveRepository` (D1); engine RPC: `listRefs`, `readCommit(head)`, `listTree(head, "")`, `readBlob(head, readmePath)`, tree-commit enrichment (§3.5) | core chunks | anonymous, public repos only |
| `GET /:owner/:repo/commits` (`?page=`, `?path=`) | `commits.tsx` — commit log | `resolveRepository`; engine RPC: `listRefs`, `listLog(ref, {path, ofs, n})` | core chunks | anonymous, public repos only |
| `GET /:owner/:repo/src/{branch\|tag\|commit}/:ref/*` | `file-view.tsx` — blob view (+ current-dir tree sidebar) | `resolveRepository`; engine RPC: `listRefs`, `listTree(ref, dir)`, `readBlob(ref, path)`, `listLog(ref, {path})` (history count line) | core chunks | anonymous, public repos only |
| any other repo-scoped non-protocol path | `not-found.tsx` — 404 shell (§4.5) | `resolveRepository` only | core chunks | anonymous |
| `/assets/*` | — (edge-served static; Worker never invoked) | — | — | — |

Non-routes (pass through unchanged, engine keeps ownership): the four git-protocol
routes via `gitHttpGate`, and every repo-scoped path this slice does not claim (engine
JSON API / admin). There is deliberately **no** `/login` route (§2.5).

### 2.2 Dispatcher integration point (`src/index.ts` — orchestrator wires)

The UI router is a Hono sub-app built in `apps/worker/src/ui/index.ts` and mounted at
the Hono app level. Because `src/index.ts` routes **all** repo-scoped requests
(`segments.length >= 2 && segments[0] !== "api"`) to `gitHttpGate`, which forwards
non-protocol paths to the engine (which 404s them under `ui: false`), the integration
adds one precedence check in the repo-scoped branch — engine protocol paths and
passthrough behavior are untouched:

```ts
// src/index.ts (orchestrator-owned; uiRouter owns its own matchers)
import { uiRouter, handlesUiRoute } from "./ui";
const app = new Hono<{ Bindings: Env }>();
app.route("/", uiRouter);            // uiRouter.notFound falls through — see below

// repo-scoped dispatch, after the existing isRepoScoped computation:
if (isRepoScoped) {
  // 1. Git protocol routes: gitHttpGate unchanged (its four routes).
  // 2. UI page families: src/ui exports the single source of truth.
  if (handlesUiRoute(pathname)) return app.fetch(req, env, ctx);
  // 3. Engine paths (JSON API / admin / unknown): unchanged.
  return gitHttpGate(req, env, ctx, gitHttp);
}
```

`handlesUiRoute(pathname)` and the router's `notFound` live in `src/ui` so route
knowledge has exactly one owner. For a repo that exists but has no UI route, and for
repo-scoped paths under a repo the UI router cannot resolve, `uiRouter`'s 404 must
**not** swallow engine paths — hence the `handlesUiRoute` gate happens *before* Hono is
consulted, and `uiRouter` only ever sees families it claims. Files touched by the
orchestrator at wiring time: `apps/worker/src/index.ts`, `apps/worker/tsconfig.json`
(`"jsx": "react-jsx", "jsxImportSource": "hono/jsx"`), `apps/worker/wrangler.jsonc`
(§2.3.2), `apps/worker/.gitignore` or root `.gitignore` (assets output), root
`package.json`/CI ordering (§5.4). Per AGENTS.md, parallel agents never touch these
shared files.

### 2.3 Assets pipeline

#### 2.3.1 Build output, location, determinism

- Build output lands at `apps/worker/public/assets/` and is **gitignored** (root
  `.gitignore` gains the entry — wiring item; AGENTS.md rule: generated artifacts are
  never committed; spike §5 recommendation, reasons a–d).
- `pnpm build:assets` → `scripts/build-gitea-assets.mjs` **already wired** in root
  `package.json` (verified). Script properties relied on here (script header):
  default `--out apps/worker/public/assets`; clears only its own entries
  (`js/ css/ fonts/ img/ .vite/ licenses.txt emoji.json`) so a committed sibling
  `_headers` file survives rebuilds; production build with `ENABLE_SOURCEMAP=false`;
  verifies required manifest entries before emitting; never writes inside `gitea/`.
- Determinism: submodule pin (D5) + committed `pnpm-lock.yaml` + content-hashed
  outputs ⇒ byte-identical manifest across rebuilds; CI asserts this (§5.4).

#### 2.3.2 wrangler.jsonc `assets` block (exact)

```jsonc
"assets": {
  "directory": "./public",
  "binding": "ASSETS",
  "html_handling": "none",
  "not_found_handling": "none",
  "run_worker_first": [
    "/api/*",
    "/*/*/info/refs",
    "/*/*/git-upload-pack",
    "/*/*/git-receive-pack",
    "/*/*/HEAD",
    "/*/*/info/lfs/*"
  ]
}
```

Routing semantics (Cloudflare static assets docs, verified 2026-10-24): with a Worker
present the default is **assets-first / worker-on-miss** — GET/HEAD matching a file in
`public/` is served from the edge (no Worker invocation, no request charge); a miss
invokes the Worker. `run_worker_first` accepts glob patterns with deep-matching `*`
and `!`-prefixed negative patterns (max 100 entries), forcing those paths to the
Worker first. The enumeration:

- `/api/*` — the whole `/api/v1` surface must never risk asset shadowing (gitorange
  pattern per SPEC-0004; spike §5).
- `/*/*/info/refs`, `/*/*/git-upload-pack`, `/*/*/git-receive-pack`, `/*/*/HEAD` — the
  four repo-scoped git-protocol routes this repo's dispatcher sends to
  `gitHttpGate` → the engine (`src/git-http/gate.ts`; SPEC-0003 §2.1). Two leading
  wildcards span `/:owner/:repo(.git)?`. These must not be shadowable by the asset
  tree; POST RPCs always reach the Worker regardless of assets, and `info/refs`/`HEAD`
  are GETs, so they are pinned explicitly.
- `/*/*/info/lfs/*` — repo-scoped LFS batch API (SPEC-0006 §2.1). The leading `*`
  spans `/:owner/:repo(.git)?`. Note: **there is no top-level `/info/lfs/*` mount** in
  this codebase or upstream at the pin (`gitea/routers/common/lfs.go` groups under
  `/{username}/{reponame}/info/lfs`); the glob is the repo-scoped shape.

Why nothing else is listed: every HTML route, and every other repo-scoped path, can
only be shadowed if its resolved path exists in the asset tree — which requires the
owner segment to be `assets`. That is eliminated at the registry level:

> **SPEC-0003 coordination note (required, not cosmetic):** the owner name `assets`
> must be added to the reserved-name set of SPEC-0003 §3 repository/owner name
> validation (upstream reserves `.`/`..`/`-` plus `*.wiki|*.git|*.rss|*.atom` patterns
> at `gitea/models/repo/repo.go:76-77`; `assets` is a cf-gitea-specific addition
> because we host the static tree at `/assets`). Without it, a repo under an owner
> named `assets` (e.g. `/assets/img/favicon.svg`) would be answered by the edge asset
> server and could never be reached — no `run_worker_first` glob can express "any
> repo-scoped path under `/assets/`" while keeping hashed assets edge-served.

`html_handling: "none"` — the tree never contains `.html` (verified output inventory,
spike §3.1); exact-path-only serving removes trailing-slash redirects and index.html
resolution, so the assets layer can never rewrite or shadow an HTML route.
`not_found_handling: "none"` is the default, made explicit: miss → Worker.
`binding: "ASSETS"` is used by the manifest reader (§2.3.4).

U1 adds miniflare-level routing tests asserting all of this (§5.3).

#### 2.3.3 Cache headers

A committed `apps/worker/public/_headers` file (outside the build script's clear set,
verified), with **non-overlapping** rules so rule interaction is never load-bearing:

```
/assets/js/*
  Cache-Control: public, max-age=31536000, immutable
/assets/css/*
  Cache-Control: public, max-age=31536000, immutable
/assets/fonts/*
  Cache-Control: public, max-age=31536000, immutable
/assets/.vite/manifest.json
  Cache-Control: public, max-age=300
/assets/img/*
  Cache-Control: public, max-age=3600
/assets/emoji.json
  Cache-Control: public, max-age=3600
/assets/licenses.txt
  Cache-Control: public, max-age=3600
```

Hashed bundles are immutable for a year; the manifest must stay fresh because it is
the re-pin resolution point (spike §5). `licenses.txt` stays in the served tree
(MIT compliance artifact, spike §8). `fonts/` may not exist at this pin (fonts are
inlined) — the rule is harmless.

#### 2.3.4 Vite manifest reader (replicates `modules/public/manifest.go`)

`apps/worker/src/ui/manifest.ts`, ~40 lines per spike §4.4:

- `loadManifest(env)`: fetch `new Request(new URL("/assets/.vite/manifest.json", reqUrl))`
  via `env.ASSETS.fetch(...)`; parse; cache in module scope for the isolate lifetime
  (hashes change only on re-pin/rebuild; this is isolate-scoped immutable deploy data,
  not request state — AGENTS.md "no module-level mutable request state" not violated).
- `assetURI(key)` — manifest key → `/assets/` + `file` (e.g. `web_src/js/index.ts` →
  `/assets/js/index.<h8>.js`).
- `cssLinks(...keys)` — transitive walk of each entry's `imports` (deduplicated),
  expanding to exactly what upstream `AssetCSSLinks` produces (spike §4.1 note: for
  `index.ts` this is the single `css/index.<h8>.css`).
- Failure mode: missing manifest file or missing required key (`iife.ts`, `index.ts`,
  `theme-gitea-light.css`, `user-events.sharedworker.ts` — exact key
  `web_src/js/user-events.sharedworker.ts`, verified against the real build's
  manifest 2026-10-24; no `features/` prefix) → typed `AssetBuildError` →
  the shell answers **503 plain text** ("UI assets not built — run `pnpm build:assets`").
  Fail fast beats a broken page; git/API routes are unaffected because the assets
  config never routes them through the shell. Re-checked at every re-pin (§5.4).

### 2.4 Rendering architecture

Hono JSX server-rendered pages under `apps/worker/src/ui/**` — **no client framework
added by us**; Gitea's own bundles do the enhancing (spike §1, §4.3). Hono 4.13 renders
`hono/jsx` components to strings natively (`c.html(<Page />)`); pages are plain server
components. Icons and the markup pipeline (§3.4) are the only code we add.

Module layout (all under `apps/worker/src/ui/`):

```
index.ts        # uiRouter + handlesUiRoute + route parsers (ref-suffix resolution)
manifest.ts     # §2.3.4
icons.ts        # icon allowlist; icons.generated.ts = generated SVG bodies (gitignored)
locale.ts       # server-side English strings for page text (spike §8 i18n row)
viewer.ts       # §2.5 seam: resolveViewer() → { kind: "anonymous" }
ui-context.ts   # per-request render context: viewer, origin, repo row, asset URIs
shell.tsx       # BaseLayout (head/config/scripts), Navbar, RepoHeader, Footer
pages/home.tsx  pages/commits.tsx  pages/file-view.tsx  pages/not-found.tsx
components/     # file list table, commit list, branch dropdown, file tree sidebar
markup.ts       # §3.4 README/markdown pipeline
```

#### 2.4.1 DOM contract (from spike §4; verified against the pinned templates)

The shell emits exactly the spike §4.1 skeleton. Verified specifics this slice commits
to:

- `<html lang="en" data-theme="gitea-light">`; theme CSS link resolved via the manifest
  from `web_src/css/themes/theme-gitea-light.css`.
- `<script type="application/json" id="global-window-config">` containing **exactly**
  the upstream `WindowConfig()` shape (`gitea/services/context/context_template.go:154-187`,
  verified; defaults from `modules/setting/ui.go:116-118`, `markup.go:138`;
  values from `options/locale/locale_en-US.json`):

  ```json
  {
    "appUrl": "<origin>/",
    "appSubUrl": "",
    "assetUrlPrefix": "/assets",
    "runModeIsProd": true,
    "customEmojis": {},
    "pageData": null,
    "mermaidMaxSourceCharacters": 50000,
    "sharedWorkerUri": "/assets/js/user-events.sharedworker.<h8>.js",
    "notificationSettings": { "MinTimeout": 10000, "TimeoutStep": 10000, "MaxTimeout": 60000 },
    "i18n": {
      "error_occurred": "An error occurred",
      "remove_label_str": "Remove item \"%s\"",
      "modal_confirm": "Confirm",
      "modal_cancel": "Cancel",
      "more_items": "More items",
      "copy_success": "Copied!",
      "copy_error": "Copy failed"
    }
  }
  ```

  `pageData` is `null` on every slice-1 page (upstream emits `null` when unset; per-page
  payloads arrive later with the Vue islands they feed). The 7 i18n keys are the entire
  client i18n surface (spike §8). Serialization escapes `<` as `\u003c` so a README- or
  repo-name-borne `</script>` can never close the tag.
- Script order: the head carries the small error-collector inline script
  (`window.addEventListener('error', …` → `_globalHandlerErrors`, spike §4.1), the
  config JSON tag, then the **blocking** `<script src="…/js/iife.<h8>.js">` (defines
  `window.$`/`jQuery`, spike §2.2). The `<script type="module" src="…/js/index.<h8>.js">`
  is the **last element of `<body>`** — init is module-execution-driven, not
  `DOMContentLoaded`; the footer's `frontendInited` prod alert is the runtime canary
  (verified `templates/base/footer.tmpl:16`).
- Load-bearing structure: `.full.height` wrapper; `nav#navbar[aria-label]`;
  `div[role="main"][aria-label][class="page-content …"]` with page discriminator
  classes (`repository file list`, `repository commits`, `repository diff`-family →
  file view uses `repository view file`-style discriminators mirroring upstream);
  `footer`. Repo nav: `div.secondary-nav > div.ui.container > div.repo-header.flex-left-right`
  then the `.overflow-menu.ui.secondary.pointing.menu` tab strip (`.item` links), closed
  by `.ui.tabs.divider` (spike §4.2).
- File list: `#repo-files-table` — the ID is load-bearing CSS (spike §4.2) — with
  `.repo-file-line.repo-file-last-commit` (latest-commit box), `.repo-file-line.parent-link`
  (non-root dirs), and per-entry `.repo-file-item > .repo-file-cell.name.muted-links`
  (`.entry-name` anchor) / `.repo-file-cell.message.commit-summary` / `.repo-file-cell.age`.
  This slice resolves every entry's commit subject server-side (§3.5), so the table
  emits **complete** — no `notready` cells, and no `data-fetch-url`/`data-fetch-trigger="load"`/
  `data-fetch-sync="$morph"` partial-refresh loader (verified shape at
  `templates/repo/view_list.tmpl:2-6`; loader is a fallback if §3.5 degrades).
- Enhancement registries actually used (verified template grep): repo switcher
  `data-global-init="initRepoSwitcher"` on a `.ui.custom.dropdown` (the `custom` class
  exempts it from Fomantic's generic `.ui.dropdown` init, spike §4.3-3); file view root
  `data-global-init="initRepoFileView" data-raw-file-link="…"` and copy button
  `data-global-click="onCopyContentButtonClick"` (`templates/repo/view_file.tmpl:2,63`);
  branch selector rendered as a plain `.ui.dropdown` (Fomantic enhances it). Deliberately
  omitted: `initActiveStopwatchNotification` (no stopwatches exist), 
  `initCommitHistoryFollowRename` (no search box). Web components used: `<relative-time>`
  for dates — inside `index.js`, nothing extra to serve (spike §4.3-4).
- Icons: inline `<svg class="svg octicon-…">` like upstream `{{svg}}` — generated at
  build time from the committed `gitea/public/assets/img/svg/*.svg` bodies (§3.1 of the
  spike: committed inputs). New `scripts/gen-ui-icons.mjs` reads an allowlist
  (~20 icons) and emits gitignored `src/ui/icons.generated.ts`; wired via `predev`/
  `prebuild`/`pretest` hooks + a CI step before typecheck (orchestrator-owned
  `package.json`s). Missing icon file → generator fails (same fail-fast as the assets
  build's input assertions, spike §7).
- Tab strip shows only existing pages: Code, Commits. Other tabs (Issues, Pulls,
  Releases, …) are **not rendered** rather than emitted as dead links (deviation from
  upstream header; revisited per future slice). Star/watch/fork buttons are not
  rendered (no actions without auth §2.5); no counters exist in D1 yet (§3.1).

### 2.5 Auth model — decision

**Decision: option (b) — anonymous, read-only, public repos only. No login page, no
cookie, no session in this slice. Option (a) (PAT-verified session cookie) is deferred
to its own future SPEC** (U4 is a placeholder recording entry criteria, not work).

Justification:

1. The product contract is Tier 1: a headless Gitea (ADR-0001 D2). Every page in this
   slice is a read-only view of public data; the tier-2 wedge is *public browse of
   public repos*.
2. SPEC-0002 §2.8 keeps web sessions documented-only by explicit decision; the API
   auth group at this pin has no session method. Inventing a session surface (cookie
   name/flags, TTL, rotation, logout, and CSRF posture — note upstream dropped CSRF at
   this pin, SPEC-0002 §2.8) is a real security commitment that buys nothing for
   read-only public pages.
3. The ACL collapses to one check: resolve the repo via the same
   `resolveRepository()` join the gate uses (`src/git-http/acl.ts`); `visibility !==
   "public"` (or owner row missing / `prohibited`) → 404 shell. This matches SPEC-0003
   §2.4 semantics (invisible repo 404s; never a 401 for pages).
4. Private-repo workflows are fully served today by PAT + git + `/api/v1`.

Seam for later: every page takes a `viewer` from `src/ui/viewer.ts`
(`resolveViewer(): { kind: "anonymous" }`). A future session SPEC (option (a): minimal
`/login` POST verifying a PAT via `TokenService`, minting an HttpOnly+Secure+SameSite=Lax
cookie) plugs in at the viewer and navbar only — page components are unchanged.

## 3. Data model and data sources

### 3.1 Schema deltas

**None.** No new D1 tables/columns, no new R2 keys, no new DO classes. Pages read the
existing `repositories`/`users` tables (columns listed in `src/db/schema.ts`) and the
engine's RepoCell. Two coordination notes ride along with this SPEC (not schema):

- `assets` owner-name reservation (§2.3.2 — SPEC-0003 §3 validation update).
- The repositories table has no `description`, `default_branch`, archived/fork/template
  flags, or star/watch counters yet (SPEC-0003 M2/lifecycle territory; the gate's
  `serveHead` TODO documents the same gap). The shell renders what exists (owner/name,
  visibility badge, created date) and omits the rest until those columns land.

### 3.2 Data sourcing rules — direct service calls, never HTTP self-fetch

Pages call the same layers the API routes call — D1 through Drizzle service modules and
the engine through `env.REPO.getByName("owner/repo")` RepoCell RPC — and **must not**
fetch the Worker's own HTTP endpoints (no `fetch("/api/v1/…")` from a handler):

- AGENTS.md architecture boundaries: routes are thin; logic lives in services. A
  self-fetch would double the request count against the subrequest budget (50/request
  on Workers Free — fatal for one directory listing fanning out), re-run auth
  middleware, and add an avoidable event-loop hop.
- Precedent in-tree: `gitHttpGate.serveHead` already reads `RepoCell.listRefs()` by RPC
  (`src/git-http/gate.ts`), not via the engine's HTTP surface.
- Engine RPCs used (verified `packages/git-engine/dist-types/repo.d.ts`):
  `listRefs()` (HEAD + default branch resolution), `readCommit(id?)`,
  `listLog(ref?, {path?, ofs?, n?})`, `listTree(ref?, path?)`, `readBlob(ref, path)`.
- DO addressing follows the gate's current convention (`"owner/repo"` request casing)
  and inherits the same `TODO(SPEC-0003 M2)` switch to `storage_key` — one more reason
  page data access goes through a small service module (`src/ui` services) rather than
  inlined in handlers (open question 5).
- Tier-1 HTTP endpoints remain the contract for *external* clients; the inventory
  table (§2.1) maps pages to the same underlying data those endpoints expose
  (SPEC-0004 §2.4), but the pages do not call them.

### 3.3 Per-page data wiring and the spike's gap closure

**Home (`repo browse`)** — spike §6.1 mapped; slice-1 choices for the ⚠ rows:
- Repo meta: D1 row (+ §3.1 limitations). Branch selector: `listRefs()` — default
  branch from `head`; dropdown lists branches (plain `.ui.dropdown` DOM, Fomantic
  enhances); no fuzzy jump input.
- Directory listing: `listTree(head, "")` for root; sub-directories navigate to
  `/src/branch/<head>/<dir>` (file view page doubles as tree browser, like upstream).
  Entry icons via the generated icon set; symlink (`mode 120000`) and submodule
  (`type "commit"`) rows rendered per §4.11.
- Latest-commit box above the list: `readCommit(head)` (the tier-1
  `git/commits/{sha}` data, taken at the service layer).
- Per-entry commit subjects: §3.5.
- README: pick the first entry matching upstream's README detection
  (`modules/util/path.go` `IsReadmeFileName`/`IsReadmeFileExtension`; case-insensitive
  `readme` with optional extension, `.md` preferred), `readBlob(head, path)`, render
  via §3.4. Missing README → section omitted (§4.4).
- Omitted (no landed data source): topics, languages bar, latest release label,
  recently-pushed prompt (spike §6.1 ⚠ rows; feature-detect and omit).

**Commits** — spike §6.2:
- `listLog(ref, {ofs, n})` with page size **50** (upstream `setting.Git.CommitsRangeSize`,
  `modules/setting/git.go:44`). `?page=N` → `ofs=(N-1)*50`; `LogResult.more` drives the
  Older link. `?path=<filepath>` filters history (listLog already supports it) — this
  doubles as the file-view history link target.
- Rendered per `commits_list.tmpl` structure (verified): `.ui.attached.table.segment.commit-table`
  → `table#commits-table` → `tbody.commit-list` rows with author (plain name text —
  no avatar images v1), sha link cell, subject/message cell, `<relative-time>` date.
  Header: `.ui.top.attached.header.flex-left-right` with the branch selector.
- Omitted (spike ⚠ rows): total count header, keyword search box, per-commit CI status
  (statuses tables not in D1 yet — SPEC-0005 batch), signature badges (`CommitJson`
  carries no verification), branches/tags-containing decoration.

**File view** — spike §6.3:
- Route parsing: `/src/` suffix requires a ref-type prefix (`branch|tag|commit`) as
  upstream does; the ref (possibly slash-bearing) is resolved against `listRefs()`
  branches/tags or a 40-hex sha — the same longest-match approach SPEC-0004 uses for
  raw-route ambiguity. No prefix / unresolvable ref → 404 shell.
- Content: `readBlob(ref, path)`; rendering branches exactly like
  `templates/repo/view_file.tmpl:94-132` (verified): `.ui.bottom.attached.segment.file-view-container`
  → `.file-view` variant `markup <type>` (markdown §3.4) | `plain-text` (`<pre>`) |
  `code-view` (line table: `td.lines-num > span#L<n>[data-line-number]` +
  `td.lines-code.chroma > code.code-inner`) | `.view-raw` (`img`/`video`/`audio` by
  extension sniff) | too-large prompt (§4.3).
- Sidebar: current directory listing only (`listTree(ref, parentDir)`) — one call, no
  lazy recursive tree v1.
- Raw / download links: `data-raw-file-link` and the Raw button target the tier-1 API
  route `/api/v1/repos/{owner}/{repo}/raw/{filepath}?ref={ref}` — anonymous GET on a
  public repo is allowed (SPEC-0004 §2.4) and it streams (AGENTS rule). Documented
  divergence: upstream's web-shaped `/raw/branch/{ref}/...` URL is not emitted in this
  slice (open question 3).
- Blame: deferred entirely (spike §6.3 ⚠ — no data source).
- History link → `/commits?path=…` (above).

### 3.4 README / markup rendering — decision

**Server-side render via a small markdown pipeline, now** — a plain `<pre>` README
would make the repo home page (the wedge's centerpiece) look broken, and the DOM
contract for markup is small (`.file-view.markup.<type>` container).

- Implementation: **markdown-it** (latest stable; the single new runtime dependency of
  this SPEC), `html: false` (raw HTML in source is escaped — XSS-safe by construction),
  `linkify: true`, `typographer: false`. Posture documented as a divergence: upstream
  uses goldmark + sanitizer and allows safe raw HTML (§4, open question 7 for marked
  vs markdown-it).
- Repo-context rewriting (the spike's biggest ⚠, §6 summary) — minimal but real:
  renderer-level rules rewrite relative `href`/`src` — links → `/src/branch/{ref}/{path}`
  (branch-prefixed), images → the API raw URL (§3.3). Absolute and `http(s)`/`mailto`
  URLs pass; markdown-it's built-in `validateLink` blocks `javascript:` etc. Heading
  anchors rendered with slug `id`s (upstream parity so `.markup` styles apply).
- Non-markdown READMEs (`.txt`, unknown markup types like org/asciidoc): `plain-text`
  `<pre>` this slice (documented degradation; no extra parsers).
- Code fences render as plain `<pre><code>` (no syntax highlighter v1; the chroma
  classes are absent and the CSS still styles the base). **No mermaid/katex triggers
  are emitted**, so the heavy lazy chunks never load and the ~969 kB core-page budget
  (spike §3.1/§8) stays intact.
- Same pipeline serves `.md` files in the file view (`markup-inplace` variant).
- Caps: markdown rendering only for blobs ≤ 512 KiB; larger → `plain-text` fallback
  with the raw link.

### 3.5 Per-file latest-commit enrichment

The spike's §6.1 ⚠: `/contents` gives `last_commit_sha`/date but **no subject**;
upstream computes subjects in one tree walk. Decision: add **one batched engine RPC**
`listTreeCommits(ref?, path?)` on `RepoCell` → `{ [entryName]: CommitJson | null }`:
walk the log from `ref` head, resolving the first commit that touched each top-level
entry under `path`, stopping when all entries are resolved or a step budget (≤ 200
commits walked) is hit; unresolved entries → `null`. The home page renders `null`
entries as a muted `.notready` message cell **without** the `data-fetch` loader (no
partial endpoint exists in this slice). This is the slice's only engine-surface
addition — vendored-engine changes follow the NOTICE.md discipline and engine-owner
coordination (orchestrator dispatches; AGENTS.md file ownership).

Interim fallback if the RPC slips: per-entry `listLog(ref, {path})` RPCs to the *same*
DO (cheap same-DO hops, not N× HTTP self-fetches — the thing spike §6.1 forbids).
The `notready` render path is identical either way.

## 4. Edge cases, limits, failure modes

1. **Empty repos** (`visibility` public, unborn HEAD): `listRefs()` → `head: null`.
   Render an empty-repo page in the shell (upstream `repo/empty.tmpl` analog): clone
   command from the request origin (`/owner/repo.git`), create-by-push hint
   (SPEC-0003 model). No file list, no README section. Never crash on `readCommit(null)`.
2. **Binary files**: null-byte sniff of the first 8 KiB (git/upstream convention) →
   `.view-raw` variant; image/video/audio by extension sniff. **SVG is rendered as
   source, not `<img>`** — our raw URL has no upstream-style media sandboxing, and
   inline SVG is active content (deliberate tightening; documented divergence).
3. **Huge files**: display cap = **8 MiB** (upstream `setting.UI.MaxDisplayFileSize`,
   `modules/setting/ui.go:98`) using the tree entry's `size` before `readBlob` — blobs
   above it render the too-large prompt + raw link and are never pulled into the DO →
   Worker hop (the DO RPC returns a full `Uint8Array`; only ≤ 8 MiB blobs are ever
   requested). The raw route itself streams unbounded — that is the API's contract
   (AGENTS streaming rule). README markup cap 512 KiB (§3.4). Commit pages are bounded
   by the 50/page size.
4. **Missing README**: home renders without the README section (upstream behavior —
   no placeholder box).
5. **404 styling**: one `not-found.tsx` in the same shell (navbar, footer, `.page-content`),
   status 404, for: unknown owner/repo, private/invisible repo (§2.5), bad ref, missing
   path, unclaimed repo-scoped path, and the commit-detail dead links (open question 1).
   Never a bare engine 404 for UI-family routes.
6. **Theme switching**: `data-theme="gitea-light"` fixed in this slice. Valid values at
   this pin (verified `web_src/css/themes/`): `gitea-light`, `gitea-dark`,
   `gitea-auto`, and the `-protanopia-deuteranopia`/`-tritanopia` variants (9 files).
   The theme `<link>` key is resolved through the manifest, so adopting another theme
   later is a config value, not a template change (open question 2).
7. **Asset 404s after re-pin (manifest coupling)**: hashed filenames and the manifest
   change together in one deploy; fresh isolates resolve fresh hashes. Residual
   staleness is bounded: browser-cached HTML (HTML carries no cache directives from us)
   can reference a removed hashed file until reload; the manifest's module cache dies
   with the isolate; the `_headers` manifest TTL (§2.3.3) keeps CDN copies short.
   Deploy order (`pnpm build:assets` → `pnpm build` → `pnpm deploy`) and the CI
   determinism guard (§5.4) catch drift; a manifest/asset mismatch surfaces as §2.3.4's
   503, not silent breakage.
8. **Private repo / prohibited owner** → 404 shell before any engine call (§2.5).
9. **Unborn HEAD on a non-empty repo / broken refs**: fall back to the gate's default
   branch convention; unresolvable ref → 404 shell (§3.3 file view parsing).
10. **Symlink/submodule entries**: symlink rows render with the follow-symlink link
    shape omitted (no `?follow_symlink` v1); submodule rows render name `@ <sha>` as
    plain text (no cross-forge resolution v1).
11. **Pagination bounds**: `page < 1` clamps to 1; `more === false` hides Older.
12. **Injection sinks**: JSX auto-escaping everywhere; the only raw-HTML sink is the
    markdown pipeline output (§3.4 posture); the config JSON tag escapes `<` (§2.4.1).
13. **Trailing slashes**: the UI router applies Hono's `trimTrailingSlash`; we never
    emit trailing-slash URLs — ONE upstream-parity exception (the dispatcher's
    lastcommit carve): the file-list loader URL keeps upstream's trailing slash for
    root listings (view.go:277 appends `/` before `PathEscapeSegments(TreePath)`,
    which is "" there; upstream's own `m.Get("/lastcommit/*")` wildcard serves that
    shape, web.go:1761). The top-level dispatcher routes `/owner/repo/lastcommit/…/`
    into the sub-app when the trimmed path is parser-claimed — every other
    trailing-slash shape keeps its pre-UI engine owner.
14. **No CSP** is emitted this slice (upstream uses per-request nonces — spike §8);
    the two inline head artifacts (error collector, config JSON) are the reason CSP
    needs its own pass (open question 6).

## 5. Testing plan

Runs in `@cloudflare/vitest-plugin` (workerd, real local D1/DO/R2 — ADR-0001 D4;
config already reads `wrangler.jsonc`, so the §2.3.2 assets block applies to tests
once present). New tests live in `apps/worker/src/ui/*.test.ts`.

### 5.1 Page render tests (HTML shape assertions)

- Seeding: D1 rows via Drizzle + migrations (`src/auth/testing/apply-d1-migrations.ts`
  pattern). Engine data via a `src/ui/testing/seed-repo.ts` helper that pushes a tiny
  prebuilt pack through the engine's scriptable receive API (`beginReceive` → pack
  stream → `finalizeReceive`), producing a 2-commit/2-file fixture with a README; a
  committed minimal pack fixture is acceptable (implementation detail; fall back to
  engine-test utilities if simpler).
- Assertions per page (string/regex on `c.res` HTML, no browser):
  - Shell (every page): `<html lang="en" data-theme="gitea-light">`; exactly one
    `#global-window-config` whose parsed JSON has **exactly** the §2.4.1 key set
    (recursively, incl. `notificationSettings` and the 7 `i18n` keys); iife script tag
    present in `<head>`; the `type="module" …/index.<h8>.js` tag is the last element
    of `<body>`; `nav#navbar`, `[role="main"]`, `footer` present; theme CSS link
    resolved from the manifest.
  - Home: `.page-content.repository.file list`; `#repo-files-table` with
    `.repo-file-item` rows, `.repo-file-cell.name/.message.commit-summary/.age`;
    `.file-view.markup` container when README renders; parent-link row on
    sub-directory views.
  - Commits: `#commits-table` / `tbody.commit-list` row shape; pagination Older link
    only when `more`.
  - File view: `.file-view-container` with the correct variant class for
    markdown / plain-text / code / binary fixtures; `data-raw-file-link` equals the
    API raw URL; 8 MiB cap → too-large prompt.
- Negative: private repo → 404 shell with status 404; unknown repo → 404 shell;
  missing manifest (simulate via a test-env binding pointing at an empty dir) → 503
  plain text on HTML routes while `/api/v1` and git routes stay unaffected.

### 5.2 Golden DOM snapshots

Vitest snapshots of the rendered shell (head + navbar + footer) for the three pages,
with **asset hashes normalized** (regex `-[\w-]{8}\.(js|css)` → `.<H>.$1`) so
snapshots are stable across asset rebuilds and only flag real DOM drift. Reviewed in
PR; re-baselined on every re-pin (§5.4).

### 5.3 Asset serving + routing tests (U1 gate)

With `public/assets` present in CI (§5.4): an existing hashed asset URL (resolved via
the real manifest) returns 200 with `Cache-Control: …immutable`; the manifest URL
returns the short TTL; `/api/v1/version` returns worker JSON (worker-first, not an
asset 404); `/a/b/info/refs?service=git-upload-pack` reaches the engine path (401
Basic challenge family — never an asset body); an unknown path reaches the Worker
(404 shell). These pin the §2.3.2 semantics, including the `run_worker_first` globs
and `html_handling: "none"`, against the real miniflare implementation.

### 5.4 CI ordering and determinism guard

CI job order: checkout with submodules → `pnpm build:assets` → typecheck/lint/test
(the generated icons module and the manifest exist before typecheck/tests). A
determinism step runs `pnpm build:assets` twice into different targets and diffs the
emitted `.vite/manifest.json` byte-for-byte, then `wrangler deploy --dry-run` to prove
the committed config references a tree that builds (spike §5's guard). The re-pin
checklist (spike §8) applies unchanged: rebuild assets, re-diff the handful of §4
templates, re-baseline goldens.

### 5.5 Accessibility smoke

parse5-based (devDependency, latest stable) assertions per page: exactly one `<h1>`
(repo name); heading levels do not skip; landmarks `nav#navbar[aria-label]`,
`[role="main"][aria-label]`, `footer` present; all `<img>` carry `alt` (our generated
markup always does); tab strip links have discernible text. No browser automation in
CI this slice.

### 5.6 Enhancement smoke (manual gate)

The bundle cannot execute in vitest workerd. U2/U3 exit includes a manual `pnpm dev`
check: no `frontendInited` alert (footer canary, `templates/base/footer.tmpl:16`),
dropdowns enhance, `<relative-time>` renders. Automating this (headless browser stage)
is open question 8.

## Open questions (resolve at implementation or in follow-up SPECs)

1. Commit detail route (`/{owner}/{repo}/commit/{sha}`): slice 1 emits upstream-shaped
   links that land on the 404 shell. Add a commit-detail page in slice 1.5/2, or
   render sha/subject as plain text until then?
2. Theme: fixed `gitea-light` now; adopt `gitea-auto` (honors `prefers-color-scheme`
   via the bundle's own theme init) as the default later?
3. Raw/media URL shape: keep the API raw URL, or add the upstream web-shaped
   `/raw/branch/{ref}/...` + sandboxed `/media/` routes to the UI router?
4. Session auth (option (a)): separate SPEC; entry criteria are private-repo page
   browsing demand or the first admin/UI write action.
5. Engine addressing: pages inherit the gate's `TODO(SPEC-0003 M2)` owner/repo →
   `storage_key` switch; centralize in one `src/ui` service module to make it a
   one-file change.
6. CSP adoption (per-request nonces like upstream) — its own pass; blocked partly on
   upstream's dropped-CSRF state (SPEC-0002 §2.8).
7. Markdown pipeline: markdown-it pinned in this draft (CommonMark, `html:false`
   safety); revisit bundle-size vs `marked` at implementation if it matters.
8. Automated browser smoke for `frontendInited`/dropdown enhancement in CI.
9. `assets` owner-name reservation must land in SPEC-0003 §3 validation before any
   deployment exposes repo creation (local dev/tests unaffected) — coordinate owner.

## Milestones

- **U1 — Assets + manifest + serving config.** `.gitignore` entry; `wrangler.jsonc`
  assets block (§2.3.2); committed `public/_headers` (§2.3.3); `scripts/gen-ui-icons.mjs`
  + package.json hooks; `src/ui/manifest.ts` + tests; §5.3 routing tests; CI ordering
  (§5.4). Exit: `pnpm build:assets && pnpm dev` serves a hashed asset with immutable
  headers; engine and API routes demonstrably unaffected.
- **U2 — Shell layout + theme.** `shell.tsx` (head order, config JSON, scripts),
  navbar/tab-strip/footer, icons component, locale module, viewer seam, 404 shell,
  trimTrailingSlash. Exit: shell renders on a 404 route passing golden snapshots;
  manual enhancement check green.
- **U3 — Three pages.** home, commits, file view + ref-suffix route parser + markup
  pipeline (`markdown-it` dep) + `listTreeCommits` engine RPC (or documented fallback)
  + per-page tests (§5.1). Exit: a seeded public repo is browsable end-to-end
  (list → README → file view → history).
- **U4 — Auth.** **Not in this slice** (decision §2.5). Placeholder records entry
  criteria (open question 4); becomes its own SPEC when picked up.
- **U5 — A11y + goldens + determinism.** parse5 a11y smoke (§5.5), golden DOM
  snapshots committed (§5.2), CI determinism + dry-run deploy guard (§5.4), re-pin
  checklist recorded in the SPEC (§5.4).
