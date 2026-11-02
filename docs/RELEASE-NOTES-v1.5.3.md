# cf-gitea v1.5.3 — Release Notes (the seven-axis convergence wave)

**Range**: RANGE=`b2e416b..7d67132` — **COMMIT_COUNT=15** commits, landed
across 2026-11-02's evening — a single-session wave that closed every
residual row of the seven review axes (⑬⑭⑮⑯⑰⑲⑳). Deployed
as **`DEPLOY_ID=dad2c37f`** (version `dad2c37f-4791-46a4-9c4b-4700dce69b80`). Probe battery
**253 planned all green — 245 first-pass + 8 in targeted reruns; 6 warns**
(the documented token-unconfigured classes). The first run answered
217/6/6: all six failures were the transient uplink window that also
killed the first deploy attempt (four fetch-failed, one git-clone break,
one D1 API break, one fixture cascade) — every one green on the targeted
battery rerun, zero product drift. The full-suite composite gate was
accepted **green-with-adjudication on R4**: 472 files, 469 pass, ZERO
assertion failures (the R1 drift pins held), 3 hook-timeout load flakes
solo-exonerated 110/110, and the one unhandled `EnvironmentTeardownError`
(the `87621de` known class, third appearance). **No
migrations this wave** — the schema is unchanged since `0061`.

The wave's shape: **the v1.5.2 ledger's dispatch board executed to zero.**
Sixteen units launched (A-J); TWO quota-death windows killed seven of them
mid-flight, and every one was salvaged — the orchestrator finished the
incomplete clusters hunk-by-hunk (B2's parse-order root cause, J-2's
missing seven-test battery, the R15/webhook-shape re-baselines) and folded
eleven orchestrator-owned index.ts hunk sets at the landings. Three real
bugs the wave found and fixed beyond the ledger rows: the auto-merge
schedule test raced the REAL queue consumer (determinism barrier per the
W16 precedent); the parse layer rejected infrastructure-cell names before
the infra admission ran (the cargo git family's four 404s); and the
repo-actions double-execution flake got its afterAll barrier (D-8 — the
concurrent-interleave residual is documented).

## 1. The seven axes' residual rows — all closed

| axis | rows | landing |
|---|---|---|
| ⑬ issues/comments/timeline | #10-#17 + #B + the P3-4 coupling | `cddae16` (A+A2) |
| ⑭ releases/tags | R2-R16 + W5's tags-webhook follow-up | `e95ce33` (B+B2) |
| ⑮ oauth2/link-account | F3-F10 + the account-aggregates audit twins | `0e4b35c` + `cc38cf8` (C+C2) |
| ⑯ projects/boards | P2-1/P2-2/P2-3(deferred-SPEC)/P3-4/P3-5 | `444b14f` (H) |
| ⑰ admin-config/mail | A2/A3, M1-M7, DOC-1/QW-2 | `86626c9` (D+D2) |
| ⑲ actions/admin/profile UI | A2-A7, B1-B3, C1-C5 + D-7a/D-7b | `506c401` + `9a26f6b` (I-a/I-b) |
| ⑳ LFS | L2-L15 (L14 recorded-defer) | `0d8f550` + `8936a2d` (J-2/J-3) |
| engine boundary | D-1/D-2/D-3, S-2, the two W11 tails | `b389b84` (E) |
| merge tail | UF-1/UF-2, D-4/D-5 | `0ab9dcc` + `bb0043f` (F) |

## 2. The user-visible headlines

- **Every actions-UI button lands** — the rerun/approve trio (v1.5.2), now
  the row kebab (delete), the dispatch banner+modal, the badge modal, the
  enable/disable kebab, the sidebar Management section, the job-queue page's
  viewer links, and the Back-to-PR arm on push runs.
- **Admin & profile surfaces complete** — the users list's detail/edit
  actions, the Impersonate form, the profile Projects/Code tabs, the
  follow/unfollow button + its POST route, the organizations tab, the RSS
  anchors.
- **LFS content renders** — `/media` serves object bytes (upstream's exact
  raw-vs-media split, api.go:1309-1310), the file view swaps pointer for
  content, `lfs_oid`/`lfs_size` ride the ContentsResponse.
- **The releases lifecycle is upstream's** — delete converts to tag-only
  (not drop), tag-only records render their page, download URLs are
  name-based, git-push tag deletes draft-flip releases.
- **The mail notifier family is whole** — push-comment and
  review-dismissed mails, the replies route's legs, the review excerpts,
  the dual-gated participant fan-out (ENABLE_NOTIFY_MAIL), the auto-watch
  push flip.
- **Projects are a first-class unit** — the API unit-toggle gate, the
  deletion sweep, and the deferred workflow-notifier surface recorded as a
  SPEC for the next cycle.
- **The oauth2 audit family** — 14 verbatim action ids with emits on every
  write arm, the PAT regenerate flow, and the admin token twins.

## 3. The engine's wave

`b389b84`: the wiki patch-series mirror folded onto the shared diff
renderer (the encode seam); computeDiff's gitlink directory-residual
collapsed to git's shape; the wiki view's unresolvable-sha 404 shell; the
413 standardization on the receive staging abort; the bounded gzip read on
the upload-pack sibling; `_cargo-index` admitted in the engine's path
parser (S-2's engine half — the worker half landed with B2). NOTICE.md
carries the three rows; dist-types regenerated.

## 4. Gate evidence

- **R1**: 472 ran, 464 pass — 6 assert-files all attributed as drift from
  THIS wave's landings (the L9 LFS-JSON flip, five project-membership
  witness ripples, the R12/R13 page shapes, the corrected tag webhook
  pair) — pinned in `cc38cf8`; 2 timeouts + the known teardown class.
- **R2**: 472 ran, 470 pass, 0 timeouts — 2 assert-files (the repo-actions
  runs-describe, the documented D-8 class's concurrent-interleave residual;
  user-repos' init-failure arm) both solo-green ×4; the tag-protection
  teardown (87621de known class).
- **R3**: 472 ran, 468 pass, 3 timeout-files + 1 assert-file — the
  repo-actions runs-describe AGAIN (the same data-bleed signature), which
  root-caused the REAL mechanism: the seeds' push-trigger consumer insert
  landing between the beforeAll wipe loop's last attempt and the first
  describe. The barrier now spaces attempts 250ms apart and demands two
  consecutive clean passes (`7d67132`).
- **R4**: 472 ran, 469 pass, ZERO assert-files — the barrier held; 3
  timeout-files (repo-actions' own beforeAll under load, pages-wave6,
  pull-engine fork-head) solo-exonerated 110/110; the known teardown class.
  Accepted green-with-adjudication (cleaner than v1.5.1's shipped R3).
- Typecheck: exit 0 tree-wide at every landing. Scoped eslint clean.

## 5. The salvage record (the two quota-death windows)

Seven units died mid-flight (B2, C2's predecessor C, D2's predecessor D,
A2's predecessor A, F's predecessor F, J-2, J-3); every cluster was
recovered — the complete ones verified and committed as-is (F, E), the
~90% ones finished by the orchestrator with disclosed completions (A2's
three gaps, B2's parse-order + lint tails, C2's export/import + test
names, D2's D1Result typing, J-2's whole battery), and J-3 re-dispatched
clean. Eleven orchestrator-hunk sets were folded at the landings (index.ts
mounts ×4, wrangler vars, admin-config rows, the webhooks-push M1/M7 arms,
the router comment, the monitor census). The pre-commit checklist held at
every landing: own-eyes Tests lines, bare tsc, guard separate, scoped
eslint, hunk-by-hunk attribution (three sibling hunks caught and routed:
issues/errors.ts to B2, the spec's mixed hunks split, the I-a claim pin).

## 6. Deploy and probe evidence

Deployed as **`dad2c37f`** from `dist/` built at `7d67132` (the drizzle
single-chunk pin verified: the library lives in exactly one chunk). The
first deploy attempt died on a transient `fetch failed` upload; the retry
landed clean with the full trigger/queue table mounted. Probes: 253
planned all green (six transient-network first-run failures re-proven
green on targeted reruns — forkpr-e2e 8/8, fixwave-parity,
branch-protection, packages-terraform/minor, cleanup-audit). No
migrations; the D1 schema is unchanged since `0061`. The PAT posture held:
minted via bootstrap-admin, swept (changes: 1, table back to 0, files
shredded).
