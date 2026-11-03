# SPEC — renamed_branches (the branch-rename log + the stale-link redirect)

Unit RB (2026-11-04). Plan source: the audit's §3.3 scrutiny + the GS
precision fold (`/tmp/GS-port-plans.md` Plan 1). Upstream pin:
`RenamedBranch` (models/git/branch.go:293-299), created upstream in v197
(modelmigration/v1_16/v197.go — a bare xorm Sync of the model).

## 1. Problem and scope

Upstream logs every branch rename into `renamed_branches` (RenameBranch tx
step 5, models/git/branch.go:407-413) and its ref-resolution consults the
log when a URL names a dead branch (getRefName's FindRenamedBranch arm,
services/context/repo.go:888-894): a renamed hit REDIRECTS the stale link
onto the new name's URL (RepoRefByType's shared arm, repo.go:1006-1016)
with the `repo.branch.renamed` flash ("Branch %s was renamed to %s.",
locale_en-US.json:2748). Ours had both rename writers
(`PATCH /repos/{owner}/{repo}/branches/{branch}` and the UI
`POST /{owner}/{repo}/branches/rename`) but no log, and the legacy
raw/media walk never consulted one: its default-branch fallback
(raw-files.ts, porting upstream getRefNameLegacy's FIXME'd fallback,
repo.go:859-862) resolved the dead name's URL against the DEFAULT branch —
wrong bytes whenever the tail names a real path under default (a directory
doubly-named like the old branch), and a 404-divergence in the plain shape
— where upstream answers the REDIRECT first (its legacy arm runs
getRefName, renamed walk included, before the fallback).

IN: the table (migration 0071), the log insert in both rename writers, the
redirect in the raw/media families (typed + legacy shapes) and the /src
family (typed + legacy shapes), the repo-delete cascade arm, the
chain-order determinism pin.

OUT (recorded, not ported):
- The flash: upstream's ctx.Flash.Info is a cookie shown on the next HTML
  render; our byte arms and the resolveUiRequest dispatch have no
  cookie-flash machinery (the branches page's query-param convention is the
  HTML arm for its OWN rename flow). The redirect is the observable parity;
  the flash semantics are recorded here.
- The commits/blame file-editor RepoRefByType consumers: upstream's
  redirect fires for them too; ours keeps the landed 404s there (same walk
  shape available in the loaders; the /src + raw/media families are the
  dispatched scope).
- The API surface: upstream exposes renamed_branch NOWHERE in the REST API
  (web-only reader) — OpenAPI untouched.
- Non-goal flagged adjacent: upstream's rename tx also rewrites the
  exact-match protected-rule name — already landed (the step-3 rewrite arm
  in both writers).

## 2. The typed-vs-legacy derivation (the cite decides)

Upstream serves the renamed redirect from ONE site: RepoRefByType
(repo.go:1006-1016), which BOTH route shapes run — the typed
`/src/branch/*` / `/raw/branch/*` / `/media/branch/*` routes
(web.go:1750/1709/1701, `RepoRefByType(git.RefTypeBranch)`) and the
deprecated legacy catch-alls `/src/*` / `/raw/*` / `/media/*`
(web.go:1754/1712/1704, `RepoRefByType("")` → getRefNameLegacy). The
renamed walk lives INSIDE getRefName's RefTypeBranch arm (repo.go:866-895:
branch walk → HEAD check → FindRenamedBranch walk); the tag/commit arms
never consult it. Therefore: upstream's TYPED arm redirects too — the
typed shape's landed 404 is ported to the redirect as well; only the
branch-typed shapes check renames. Order inside the arm: an EXISTING
branch wins (the FindRenamedBranch query fires only on the walk's miss);
in the legacy walk the renamed arm outranks the tag walk and the sha/
default fallback (it sits inside the branch call, which runs first —
getRefNameLegacy repo.go:846-848).

Redirect shape (repo.go:1010-1014): 303 (ctx.Redirect's default status,
base.go:157's StatusSeeOther) onto `AppSubURL + strings.Replace(
req.URL.EscapedPath(), PathEscapeSegments(from), PathEscapeSegments(to),
1)` — the FIRST occurrence of the escaped old name in the FULL escaped
path, owner segment included, query dropped.

## 3. Data model

`renamed_branches` (schema.ts, migration 0071 — plain CREATE TABLE +
CREATE INDEX, backtick-quoted throughout; no data copy, so the 0066 DQS
trap cannot apply):

| column | type | upstream |
| --- | --- | --- |
| `id` | INTEGER pk autoincrement | `ID int64 pk autoincr` (non-referencing pk — the audit §2.1 id-family rule, the repo_units precedent) |
| `repo_id` | TEXT NOT NULL, index `renamed_branches_repo_idx` | `RepoID int64 INDEX NOT NULL` (the id family's TEXT form; repo-scoped no-FK convention, cascade via the explicit deleteRepository arm — upstream services/repository/delete.go:164) |
| `from` | TEXT | `From` (SQL keyword — Drizzle backtick-quotes it; the schema test pins the quoting) |
| `to` | TEXT | `To` (same keyword note) |
| `created_unix` | INTEGER | `CreatedUnix xorm:"created"` (seconds — verbatim like FN-6's created_unix, NOT the §2.5 created_at family: that family records EXISTING pairs) |

Only repo_id carries NOT NULL (upstream tags only it); from/to/created_unix
are untagged upstream (nullable) — every writer populates all three. NO
unique constraint: upstream tolerates duplicate `from` rows across rename
chains (a→b then b→a then a→b leaves two from=a rows).

### Chain-order semantics (pinned)

Upstream's FindRenamedBranch (branch.go:302-304) is `db.Get` — LIMIT 1,
UNORDERED; SQLite answers the lowest rowid, i.e. the OLDEST row for a
duplicated `from`. Ours pins that determinism explicitly:
`findRenamedBranchMap` reads `ORDER BY id ASC` and is FIRST-WINS per
`from` (the oldest row's `to` survives a re-rename of a re-created name).

## 4. Writers

Both rename arms insert `(repo_id, from, to)` + `created_unix` = seconds.
Upstream's tx order: ref flip → default fixup → protected-rule
rename/rewrite → open-PR base/head walks → step-5 log insert → git action
(the notification). Ours is engine-first (create-then-delete over the
engine), so the insert rides the D1 tail in upstream's relative order:
default-branch fixup → protected-rule rewrite → THE LOG INSERT → the
webhook pair (API writer only) — the log row exists when the create event
lands.

DISCLOSED no-tx window (the engine/D1 split): a D1 failure after the refs
flipped leaves the rename unlogged — stale links then fall through to the
404/default fallback instead of redirecting. The same partial-rename window
the default and rule tails disclose (ui/index.ts's existing note).

## 5. Readers (the redirect arms)

- raw/media families (ui/pages/raw-files.ts + the rawMediaFile handler):
  the loaders resolve refs; on a typed-branch miss or inside the legacy
  walk (slot: after the branch walk, before the tag walk) the renamed map
  is fetched (ONE D1 read, only on the miss — upstream's query-on-miss
  posture) and walked with the same shortest-cumulative-prefix shape; a hit
  returns the renamed outcome and the handler answers
  `renamedBranchRedirect` (303, path-replace, query dropped). The blob
  (`/{raw,media}/blob/{sha}`) arms never check renames (upstream
  DownloadByID* has no RepoRef ref-name walk).
- /src family (resolveUiRequest's src/commits/blame threading block): the
  typed branch shape redirects when `resolveRefSuffix` missed; the legacy
  shape (no typed prefix) redirects when the WHOLE branch walk misses AND a
  renamed row matches (upstream: the legacy walk's branch call runs first —
  a live branch never redirects). Empty repos skip (upstream RepoRefByType's
  IsEmpty early return). Commits/blame keep their landed 404s (the §1
  boundary).

## 6. Edge cases and failure modes

- Renamed hit + query string: the query is DROPPED (upstream's link is the
  replaced path only).
- Multi-segment from (`feat/one` → `f2`): the cumulative-prefix walk
  matches `feat/one` at depth 2 and swaps only those segments.
- Live branch named like a stale `from` row (rename a→b then re-create a):
  NO redirect — the branch-exists arm wins (upstream order).
- Duplicate `from` rows: the oldest row's `to` (§3's pin).
- Empty repo / blob arms / typed tag+commit shapes: never redirect.
- Repo delete: the log rows die with the repo (the batch arm).

## 7. Testing plan

- schema.test: the DDL pin (five columns, the `from`/`to` quoting, the
  index) + the duplicate-from shape.
- engine-read.test: PATCH rename → row; the default rename → both rows;
  every refusal arm (422/404/403) → NO row; the duplicate-from chain
  (a→b, b→c, re-create a, a→d → two from=a rows, oldest first).
- branches.matrix.test: the UI rename POST → row; the refusal quartet →
  no rows; the site-admin default rename → row.
- raw-files.matrix.test: legacy/typed × raw/media redirect arms (incl.
  the query-drop), the cumulative-prefix walk, branch-exists-first, the
  typed-tag no-consult, the legacy renamed-outranks-fallback fix, the
  chain-order pin, the never-renamed passthrough (typed 404; legacy keeps
  the FIXME fallback), and the /src family's typed + legacy redirects with
  their passthroughs.
- delete-actions.test: the cascade (doomed repo's rows die, keeper's stay).

Gates: migration applied + PRAGMA (own eyes), the suites' Tests lines,
scoped eslint 0, tsc zero — never cited as full-suite green (ADR-0006).
