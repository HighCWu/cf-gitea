# Dependency Freshness Census — 2026-10-28

Read-only census of every direct dependency in the workspace (root `cf-gitea`,
`apps/worker`, `packages/git-engine`). No installs, lockfile untouched. Evidence:
`pnpm -r outdated`, `pnpm view <pkg> {dist-tags,time,dependencies,peerDependencies}`,
cross-checked against the registry's real dist-tags (see finding 1 below), the
house policy in `AGENTS.md` ("Dependencies"), `docs/research/miniflare-beta-pin.md`,
and the `wrangler.jsonc` compatibility-date comment.

Registry facts collected 2026-10-28T01:45–02:00Z. pnpm 12.13.0.

## 1. How resolution sees versions (method caveat)

pnpm 12's default `minimumReleaseAge` is **1440 minutes (24 h)**: versions younger
than 24 h are invisible to resolution and to `pnpm outdated`. Consequences for any
census here:

- `pnpm -r outdated` reports a **gate-adjusted latest**, not the registry's
  dist-tag `latest`. Today it hid `wrangler@4.154.0`, `@cloudflare/vitest-plugin@1.4.9`
  and `@cloudflare/workers-types@5.20261028.1` behind their 24 h wall.
- Every entry below therefore lists **both** the gate-adjusted latest (what
  `pnpm up` can actually install today) and the true `latest` with its publish
  time and eligibility date (`publish + 24 h`).
- `pnpm-workspace.yaml` currently excludes exactly one package:
  `@cloudflare/workers-types@5.20261025.1` (version-pinned; the recorded pattern
  for the daily-types train).

## 2. Census — all direct dependencies

Current (registry `latest`, all published well outside the gate — no action):
`eslint 10.13.0`, `@eslint/js 10.0.1`, `@hono/zod-openapi 1.6.3`, `aws4fetch 1.0.20`,
`drizzle-orm 0.45.4`, `drizzle-kit 0.31.11`, `zod 4.6.7`, `markdown-it 15.0.3`,
`@types/node 26.6.5`, `vite 8.3.5`, `vitest 5.0.5`, `@cloudflare/vite-plugin 1.65.0`,
`@cf-gitea/git-engine` (workspace). Thirteen of twenty-two unique direct deps are
fresh; the nine below are not.

| # | Package (where declared) | Ours | Gate-adjusted latest (pub UTC) | True `latest` (pub UTC) | Dist-tag sanity | Hold on record? | Verdict |
|---|---|---|---|---|---|---|---|
| 1 | `hono` (worker dep) | 4.13.13 | 4.13.14 (10-25 07:19) | same | `latest` stable; `next 5.0.0-rc.1` is prerelease — skipped | no | **BUMP** |
| 2 | `wrangler` (worker dev) | 4.152.0 | 4.153.0 (10-26 14:24) | 4.154.0 (10-27 17:06; eligible 10-28 17:06) | `latest` stable | no | **BUMP** to 4.153.0 now; 4.154.0 WAIT (tonight) |
| 3 | `@cloudflare/vitest-plugin` (worker dev) | 1.4.7 | 1.4.8 (10-26 14:29) | 1.4.9 (10-27 17:11; eligible 10-28 17:11) | `latest` stable | no | **BUMP** to 1.4.8 now; 1.4.9 WAIT (tonight) |
| 4 | `typescript-eslint` (root dev) | 8.72.0 | 8.72.1 (10-26 17:09) | same | `latest` stable (a `canary` tag exists — skipped) | no | **BUMP** |
| 5 | `@cloudflare/workers-types` (engine dev) | 5.20261025.1 | 5.20261027.1 (10-27 01:33; eligible 10-28 01:33) | 5.20261028.1 (10-28 01:08; eligible 10-29 01:08) | stable daily train | recorded exclude-entry pattern | **BUMP** to 5.20261027.1 (re-verified eligible in-window); 5.20261028.1 WAIT |
| 6 | `compatibility_date` (wrangler.jsonc) | 2026-10-19 | — | workerd `1.20261023.1` → supports 2026-10-23 | — | held only as long as the workerd pin | **BUMP** with #2/#3 (comment in wrangler.jsonc mandates it) |
| 7 | `pako` (engine dep) | ^2.1.0 → 2.2.0 | 3.0.3 (major) | 3.0.3 | stable major | **yes — engine written against pako 2 API, revisit at M2 adaptation** | **HOLD** (major noted) |
| 8 | `@types/pako` (engine dev) | ^2.0.3 → 2.0.4 | 3.0.0 (deprecated) | 3.0.0 | latest is a **deprecated stub** ("pako provides its own types"; pako 3 only) | **yes — moves with the pako hold** | **HOLD** |
| 9 | `typescript` (engine + worker dev) | ~6.0.3 → 6.0.3 | 7.0.2 (major, GA 2026-07-08) | 7.0.2 | `latest` stable; `next 7.1.0-dev` — skipped | **yes — typescript-eslint peer caps `typescript <6.1.0`** (verified against 8.72.1 today); 6.0.3 is the newest 6.0.x, so no in-hold bump exists | **HOLD** (major noted) |

Verdict tally: **5 BUMP** (hono, wrangler, vitest-plugin, typescript-eslint,
workers-types) plus 2 coordinated config edits (miniflare override,
compatibility_date); **3 WAIT** (wrangler 4.154.0, vitest-plugin 1.4.9,
workers-types 5.20261028.1 — all optional fresher variants with eligibility
dates); **3 HOLD** (pako, @types/pako, typescript); **0 actionable MAJOR**
(two majors visible — typescript 7.0.2, pako 3.0.3 — both behind recorded holds).

## 3. The interlocked Cloudflare family — who moves independently

Extra care requested for eslint/tsc/vitest/wrangler/vite-plugin because they
interlock through the transitive miniflare exact pin
(`docs/research/miniflare-beta-pin.md`: all three Cloudflare plugins pin miniflare
as an exact string; the workspace `overrides.miniflare` forces one version on all
consumers; workerd is date-encoded, and the newest runnable `compatibility_date`
equals the date in the pinned workerd's version).

Registry facts (dependencies, fetched today):

| Package | miniflare pin | workerd carried |
|---|---|---|
| wrangler@4.153.0 | `5.20261023.0-beta` | `1.20261023.1` |
| @cloudflare/vitest-plugin@1.4.8 | `5.20261023.0-beta` | — |
| wrangler@4.154.0 | `5.20261023.1-beta` | `1.20261023.1` |
| @cloudflare/vitest-plugin@1.4.9 | `5.20261023.1-beta` | — |
| @cloudflare/vite-plugin@1.65.0 (unchanged, still latest) | `5.20261019.2-beta` | — |
| miniflare stable `latest` | still `4.20260730.0` (2026-07-30) — no stable 5.x; `beta` tag now `5.20261023.0-beta` | — |

Independence verdicts:

- **eslint 10.13.0 / typescript-eslint 8.72.1 — fully independent.** No Cloudflare
  or miniflare transitive surface. Movable in any window alone. 8.72.1's peers:
  `eslint ^8.57.0 || ^9 || ^10` (we are fine), `typescript >=4.8.4 <6.1.0` (our
  ~6.0.3 is fine; nothing changes for the tsc hold).
- **typescript — NOT movable, and not because of miniflare.** The blocker is the
  typescript-eslint peer cap `<6.1.0` (the recorded hold; re-verified today at the
  version we intend to install). TypeScript 7.0.2 has been GA on `latest` since
  2026-07-08 and 6.0.3 is the terminal 6.0.x, so when typescript-eslint lifts the
  cap the move is a direct major jump (native/Go compiler: different CLI,
  removed/changed APIs and diagnostics — a migration that deserves its own SPEC).
  Independent of wrangler/vite/vitest entirely.
- **wrangler 4.153.0 + @cloudflare/vitest-plugin 1.4.8 — a coherent pair, NOT
  independently movable from the override.** Both pin the identical
  `5.20261023.0-beta`, so bumping them together keeps upstream's own alignment.
  But `@cloudflare/vite-plugin@1.65.0` still pins `5.20261019.2-beta` exactly, so
  the workspace override MUST move to `5.20261023.0-beta` in the same window to
  keep one resolved miniflare (override semantics replace the spec for all three
  consumers — the same mechanism the current pin uses). Forcing vite-plugin four
  days forward on the same 5.x beta train is the accepted trade; the vitest pool,
  `vite dev`, and typecheck gates are the verifier, and the documented rollback is
  to restore override `5.20261019.2-beta` + wrangler 4.152.0 (treat any pool
  misbehavior as a blocker, per miniflare-beta-pin.md doctrine).
- **compatibility_date 2026-10-19 — liftable to 2026-10-23 in the same window.**
  The hold's recorded reason is "newest date the pinned local runtime supports";
  the new pinned runtime (workerd `1.20261023.1`) supports 2026-10-23. The
  wrangler.jsonc comment explicitly ties this bump to `pnpm update wrangler`.
  Production-safe: compat date only picks the semantics cutoff; Cloudflare's
  deployed runtime is far newer than five days ago.
- **vite 8.3.5 / vitest 5.0.5 / @cloudflare/vite-plugin 1.65.0 — nothing to move.**
  All at stable `latest`. vite-plugin's `2.0.0-beta` train exists but is a
  prerelease dist-tag (policy: skip; also a major rewrite — watch for GA).

## 4. Ranked bump plan

### Window 1 — now (one window; every target is past the 24 h gate)

Shared-file edits (orchestrator-owned; do these FIRST so one resolution pass
applies them):

1. `pnpm-workspace.yaml`: `overrides.miniflare: 5.20261019.2-beta` →
   `5.20261023.0-beta`. Optionally also simplify the exclude to name-only
   `@cloudflare/workers-types` (registry docs: name-only exclusions are legal)
   so the daily train stops needing a per-bump edit — otherwise this entry needs
   touching again at every bump.
2. `apps/worker/wrangler.jsonc`: `compatibility_date` → `2026-10-23`, and update
   its comment (wrangler 4.153.0 pairs miniflare `5.20261023.0-beta`).

Then the refresh (all target versions are inside the declared `^` ranges — pure
lockfile refresh, no manifest edits needed):

```bash
pnpm -w up typescript-eslint                                   # root: 8.72.1
pnpm --filter cf-gitea-worker up hono wrangler '@cloudflare/vitest-plugin'
pnpm --filter @cf-gitea/git-engine up '@cloudflare/workers-types'  # 5.20261027.1
pnpm typecheck      # regenerates engine dist-types boundary + wrangler Env types
pnpm lint
pnpm test           # worker suite in workerd — exercises the new miniflare pool
pnpm test:full      # the standing composite gate before any commit (ADR-0006)
```

Expected lockfile drift: the five versions above; `miniflare` snapshots
`5.20261019.2-beta` → `5.20261023.0-beta`; `workerd` → `1.20261023.1`; the usual
sibling churn (`unenv`, `youch` prereleases ride along inside the toolchain).
If anything in the vitest pool or `vite dev` misbehaves with the moved override,
that is a blocker → revert override + wrangler to 4.152.0 and re-verify.

### Window 2 — tonight 2026-10-28T17:11Z (optional) and 2026-10-29T01:08Z

- From 17:11Z tonight: `wrangler@4.154.0` + `@cloudflare/vitest-plugin@1.4.9` +
  override → `5.20261023.1-beta`. Same workerd, zero compatibility-date gain —
  purely cosmetic. Recommend folding into the next natural refresh instead of
  spending a window.
- From 2026-10-29T01:08Z: `@cloudflare/workers-types@5.20261028.1` (needs the
  exclude entry updated or made name-only in window 1). Only worth taking with
  another bump, not on its own.

### Stays (recorded holds — do not propose casually)

- `pako ^2` + `@types/pako ^2` — engine API; revisit at the M2 adaptation.
  (pako 3.0.3 is a stable major; the hold is deliberate, not staleness.)
- `typescript ~6.0.3` — typescript-eslint peer cap `<6.1.0`; "bump with it".
  TS 7.0.2 GA is the migration on deck once the cap lifts; 6.0.3 is terminal 6.0.x.
- `compatibility_date` — no longer held once window 1 lands (tracks the workerd
  pin; keep the "newest date the pinned runtime supports" discipline).
- transitive miniflare 5.x-beta — upstream exact pin, unchanged doctrine
  (miniflare-beta-pin.md); stable 5.x still does not exist (`latest` = 4.20260730.0).

## 5. Surprises and open issues

**Surprises**

1. `pnpm outdated` is gate-filtered: it silently reported `4.153.0` as wrangler's
   latest while the registry's `latest` was `4.154.0`. Any freshness census here
   must cross-check dist-tags or it under-reports by up to a day.
2. TypeScript 7.0.2 is GA on `latest` (since 2026-07-08) and 6.0.3 is the last
   6.0.x — the eslint peer cap is the *only* thing between us and a native-compiler
   major jump. That future migration has real surface area (CLI/API/diagnostic
   changes) and will need a SPEC, not a `pnpm up`.
3. wrangler 4.153.0 and vitest-plugin 1.4.8 pin the identical miniflare beta —
   a cleanly coordinated pair; only vite-plugin (still 1.65.0) lags at the 10-19 pin.

**Open issues**

- `pnpm-workspace.yaml` and `wrangler.jsonc` are orchestrator/shared-owned files —
  window 1 cannot proceed without those two edits made by the designated owner.
- The workers-types exclude entry is version-pinned to 5.20261025.1; harmless after
  window 1 (the new target is >24 h old) but stale — name-only is the durable form.
- hono 4.13.14 — the exact version AGENTS.md recorded as gate-blocked on 10-25 —
  cleared the gate on 10-26T07:19Z; the recorded observation has aged as expected.
- miniflare 5 GA remains the endgame for the whole prerelease chain
  (miniflare beta, unenv rc, youch beta); re-check at the next dependency refresh.
- The two untracked files in `docs/` (`d1-index-engineering.md`,
  `reviews/wave-131-landing-ledger.md`) are sibling units' work, not part of this
  census; untouched.
