# Miniflare Beta Pin — Transitive Dependency Investigation

Investigated 2026-10-26 (wave-31 `wave-miniflare-beta`, INVESTIGATE-ONLY — no lockfile or
install changes were made). Trigger: the vitest-contention unit flagged that
`miniflare@5.20261019.2-beta` resolves transitively in `pnpm-lock.yaml`, which surfaces as a
prerelease version in the tree despite AGENTS.md's "never pin alpha/beta/RC/next/canary
dist-tags" policy.

## TL;DR

**Do nothing.** The beta is not our pin — all three of its dependers (`wrangler@4.152.0`,
`@cloudflare/vite-plugin@1.65.0`, `@cloudflare/vitest-plugin@1.4.7`, all at their latest
published versions) declare miniflare with the *exact string* `"5.20261019.2-beta"`, not a
range. No stable miniflare satisfies their declared requirement; the stable `latest` tag
(4.20260730.0, published 2026-07-30) predates miniflare 5 and would drag a July workerd into
the dev/test pool, breaking alignment with our `compatibility_date 2026-10-19`. The beta has
been in the lockfile since the workspace scaffold commit and resolves as a single version,
isolated to dev tooling. AGENTS.md's dependency policy governs dependencies **we** declare;
this one is upstream's coordinated pin.

## 1. Who pulls it

`pnpm why miniflare` (repo root; identical single-version tree under `apps/worker`):

```
miniflare@5.20261019.2-beta
├─┬ @cloudflare/vite-plugin@1.65.0
│ └── cf-gitea-worker (devDependencies)
├─┬ @cloudflare/vitest-plugin@1.4.7
│ └── cf-gitea-worker (devDependencies)
└─┬ wrangler@4.152.0
  ├── @cloudflare/vite-plugin@1.65.0 [deduped]
  ├── @cloudflare/vitest-plugin@1.4.7 [deduped]
  └── cf-gitea-worker (devDependencies)

Found 1 version of miniflare
```

All three are `devDependencies` of `apps/worker` (declared by us as `^` carets:
`wrangler ^4.152.0`, `@cloudflare/vite-plugin ^1.65.0`, `@cloudflare/vitest-plugin ^1.4.7` —
our own ranges are clean; the prerelease enters only through upstream pins). Each depender's
installed `package.json` declares:

| Depender (installed) | miniflare declared range | engines |
|---|---|---|
| wrangler@4.152.0 | `"5.20261019.2-beta"` (exact) | node >=22 |
| @cloudflare/vite-plugin@1.65.0 | `"5.20261019.2-beta"` (exact) | — |
| @cloudflare/vitest-plugin@1.4.7 | `"5.20261019.2-beta"` (exact) | — |

Lockfile anchors (`pnpm-lock.yaml`): importers line 191; snapshots at 1708, 2084, 2099,
3126, 3389. Exactly one resolved version, no duplication.

## 2. Is a stable version available in the dependers' range?

**No.** The declared "range" is a single exact prerelease string, so the only version that
satisfies it is the beta itself. Registry state (`registry.npmjs.org/miniflare`, fetched
2026-10-26):

| dist-tag | Version | Note |
|---|---|---|
| `latest` (stable) | `4.20260730.0` | last stable release, published 2026-07-30 |
| `beta` | `5.20261019.2-beta` | current dev train; published 2026-10-22 |
| `legacy` | `3.20250718.3` | — |

The 5.x line has shipped continuous `alpha` (from 2026-09-07) then `beta` (from
2026-10-13: 5.20261006.2-beta → 5.20261019.2-beta) builds; **no stable 5.x exists yet**.

The dependers will not move to stable on their own any time soon either — the *latest
published* versions of all three still pin this exact beta (via the registry `/latest`
manifests, fetched 2026-10-26):

| Package | Latest on npm | Published | miniflare pin |
|---|---|---|---|
| wrangler | 4.152.0 (same as ours) | — | `5.20261019.2-beta` |
| @cloudflare/vite-plugin | 1.65.0 (same as ours) | 2026-10-23 | `5.20261019.2-beta` |
| @cloudflare/vitest-plugin | 1.4.7 (same as ours) | — | `5.20261019.2-beta` |

We are already on the newest of all three, so no bump of our own `^` ranges changes
anything today.

## 3. New resolution or long-standing?

**Long-standing — present since the first commit.** `git log -S "miniflare@5.20261019.2-beta"
-- pnpm-lock.yaml` and `git log -G "miniflare@" -- pnpm-lock.yaml` each return exactly one
commit:

- `ab61b5a` "chore: scaffold pnpm workspace and worker app" (2026-10-24 18:28 +0800) — the
  commit that *created* `pnpm-lock.yaml`, already pinning `wrangler@4.152.0`,
  `@cloudflare/vite-plugin@1.65.0`, `@cloudflare/vitest-plugin@1.4.7` and
  `miniflare@5.20261019.2-beta`.
- The 2026-10-25 dependency refresh (`b15a714`) left the miniflare resolution untouched.

So this is not a regression from a recent update; it is how the toolchain resolved from day
one, because that is what upstream declares.

## 4. Remediation options

### (a) Do nothing — RECOMMENDED

- **AGENTS.md intent**: the "never pin alpha/beta/RC/next/canary" rule is in the
  Dependencies section about versions *we* choose; every entry in its intentional-holds
  list is a directly-declared dep. Our own declared ranges (`^4.152.0`, `^1.65.0`,
  `^1.4.7`) are stable carets and policy-compliant. The beta is upstream's exact pin,
  transitive, and dev-only (vite dev, vitest pool, wrangler tooling) — it ships no runtime
  surface to production responses.
- **No stable alternative exists in-range** (section 2) — "upgrade to stable" is not
  currently a legal resolution of the dependers' manifests.
- **workerd alignment**: the beta pulls `workerd@1.20261019.1`, exactly matching
  `compatibility_date 2026-10-19` in `apps/worker/wrangler.jsonc` (line 10). The stable
  4.20260730.0 pulls `workerd@1.20260730.1` — a runtime ~3 months older than the compat
  date we build and test for. Downgrading would *reduce* local/dev fidelity.
- **Precedent in-tree**: the same Cloudflare toolchain generation transitively carries
  `unenv@2.0.0-rc.24` and `youch@4.1.0-beta.10` (visible in the same lockfile sections).
  The current wrangler/vite-plugin/vitest-plugin generation is pervasively
  prerelease-pinned by upstream; overriding one prerelease while keeping the others gains
  nothing.
- **Bounded risk**: single resolved version, dev-tooling-only, and CI gates (vitest in
  workerd, typecheck) exercise it on every push.

### (b) pnpm override to stable 4.20260730.0 — NOT recommended

Would force every depender off its exact pin. Blast radius:

- miniflare 5 is a **major** release; wrangler 4.x and both Cloudflare plugins are written
  against the miniflare 5 API. Nothing in the ecosystem is currently tested against
  miniflare 4 + these plugin versions — `pnpm dev` (vite-plugin), `pnpm test`
  (vitest-plugin + workerd) and wrangler dev/deploy could all break, with no upstream
  support matrix to fall back on.
- Drags `workerd@1.20260730.1` into dev/test, desynchronizing local runtime semantics from
  `compatibility_date 2026-10-19`.
- If overruled despite this, the override would be (root `pnpm-workspace.yaml`) — **for
  reference only, do not apply**:

  ```yaml
  overrides:
    miniflare: 4.20260730.0
  ```

  followed by, at a quiet window: `pnpm install` → inspect the lockfile diff (expect
  `miniflare@5.20261019.2-beta` snapshots replaced by `miniflare@4.20260730.0`, `workerd`
  moved to `1.20260730.1`, possible new dedupe churn) → `pnpm typecheck` → full
  `pnpm test` → smoke `pnpm dev` — treating any vitest-plugin/workerd behavior drift as a
  blocker to revert.

### (c) Wait for a stable-resolving upstream release — passive endgame

The 5.x beta train is Cloudflare's active current line (beta tag advancing weekly; the
vite-plugin release of 2026-10-23 still pins it). When miniflare 5 GAs, a routine
`wrangler`/plugin release will switch the pins to stable, and our periodic refresh
(commit pattern of `b15a714`) picks it up with zero action. Until then there is no
stable-declaring release to wait *for* — (c) is simply (a) plus a re-check at the next
dependency-refresh wave.

## 5. Recommendation

**Option (a)** — accept the transitive beta, document it (this file), and revisit at the
next periodic dependency refresh when Cloudflare ships miniflare-5-stable pins. Rationale:
our declared ranges are policy-clean; the beta is upstream's exact, coordinated,
dev-only pin; no stable in-range version exists; and forcing stable 4.x would both violate
every depender's manifest and downgrade the local workerd below our compatibility date.
Optionally add one line to AGENTS.md's intentional-holds list ("transitive
miniflare 5.x-beta — exact-pinned by wrangler/Cloudflare plugins; revisit at miniflare 5 GA")
if the team wants the exception recorded in the policy file itself.

## Files touched

- `docs/research/miniflare-beta-pin.md` (this report) — the sole artifact.

## Open issues

- Sibling transitive prereleases `unenv@2.0.0-rc.24` and `youch@4.1.0-beta.10` share the
  same policy reading; no separate action taken.
- `pnpm why miniflare` output is workspace-wide (same tree from root and `apps/worker`);
  miniflare appears only under `cf-gitea-worker` devDependencies.
- If the orchestrator wants the AGENTS.md intentional-holds annotation (recommendation's
  optional step), that is an orchestrator-owned edit to a shared file.
