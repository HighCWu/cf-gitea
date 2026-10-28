# Tagging dossier — v1.2 (prepared 2026-10-29)

Read-only survey unit deliverable. Purpose: let the user decide the v1.2 tag
(and optional back-dated v1.1) with one glance. Every hash/date below was
verified against `git` at preparation time; nothing was tagged or pushed by
this unit.

## 1. Current tag state

`git tag -l` → **one tag: `v1.0`** (annotated).

| tag | tag object | peeled commit | creatordate | subject |
|-----|-----------|---------------|-------------|---------|
| v1.0 | `f71b1c3` | `a2ecd92` | 2026-10-25 15:10:38 +0800 | "v1.0 — the deployed freeze tree: smart-HTTP v0/v2 (P0-hardened), 301+ op API, … engine M0–M3.4 (leases/compaction/GC). Deployed as c68af947." |

`a2ecd92` is dated 2026-10-25 14:22:48 +0800 ("docs: bench-d1 header
attribution corrected …"). No GitHub Releases exist (`gh release list` is
empty) — v1.0 was tagged only, never published as a Release.

Current state: HEAD = `60c65e1` ("docs(evidence): REDEPLOY25 LIVE"), working
tree clean, `origin/main` == `60c65e1` (already pushed; a new tag needs only
`git push origin v1.2`). `v1.0..HEAD` = **585 commits**. Coherence gap the
sweep would note: `docs/RELEASE-NOTES-v1.1.md` and `v1.2` exist but no
v1.1/v1.2 tags do.

## 2. What the v1.2 notes cover vs what landed since its snapshot cut

**Header/window line** (`docs/RELEASE-NOTES-v1.2.md:3-20`): "Snapshot
2026-10-27, HEAD `640005b` — the post-v1.1 window (198 commits,
`4f59daa`→`640005b`, 2026-10-26 20:58 – 2026-10-27 19:46 +0800)".

**The addenda are IN the doc, so the content is complete through RD24 and the
day-record.** Since that snapshot cut the doc grew five appended sections,
each landed in-tree: the post-cut polish window (wave-129), the fourth
(wave-130, at `bd6d257`), the fifth (at `7c3b7c4`), the sixth — the
post-ledger mega-window (at `98eb3f6`) — plus the **FINALIZED RD24 block**
(`RELEASE-NOTES-v1.2.md:737-786`: RD24b freeze `1235b4d0`, migrations
0036+0037, full gate 268 files PASS, 155 live checks, demo flip + public
repo) and the **sixth addendum's day-record close** (`:788-908`, append-time
HEAD `7741f6a`, landed by `f33860e` — the last commit to touch the doc:
post-RD24b waves, the assignee emission story, the engine cursor-drain
discipline, the e2e scratch-tree isolation, the four-beat public-CI saga,
CONTRIBUTING/SECURITY, tick-16).

**What is NOT in the doc: RD25.** Eleven commits after `f33860e`
(`f0eda84`→`60c65e1`) — the RD25 dep-bump window: the CI engine gates, the
RD25 runbook, the tokens-audit close, the goldens root-fix, the demo day-one
review, the sweep's orphan fix (`ada3b73`), the bench noise calibration,
SPEC-0001 §9, `deleteUserCascade` (`a27ca47`), the dep bump itself
(`873da29`), and the **REDEPLOY25 LIVE record (`60c65e1`)**. RD25's evidence
is complete but lives outside the notes doc: the LIVE record rides `60c65e1`'s
commit message and the closed template slots in
`docs/design/p0-evidence.md` (REDEPLOY25 section, "the window's record is
COMPLETE"). A short seventh addendum would close that gap; it is optional
for tagging (open issue 1 below).

## 3. Candidate cut point — RECOMMEND: `60c65e1` (current resting HEAD)

Rationale, each verified:

- **All gates green at `60c65e1`**: RD25's quiet-window gate at the BUMPED
  runtime — `pnpm test:full` PASS (268 files, 268 direct, zero solo needed,
  0 deaths, 127.7 s), tsc 0, lint 0, delete-husk 6/6, `check:api` PASS
  (490 ops / 298 paths standing), batteries 113/0 · 18/0 · 22/0 · demo
  2/1-by-design/1-info (`60c65e1` commit message = the LIVE record).
- **CI first-green**: run 40726243702 on `60c65e1` is **completed success**
  (10m43s) — the first green CI run on the bumped runtime, including the
  benchmark job's first compare-mode verdict. (The bump commit `873da29`'s
  own run failed ONLY the benchmark job — first run against the new
  CI-hardware baseline; the identical tree content went green on `60c65e1`'s
  run, docs-only delta. On record, not a blocker.)
- **RD25 deployed**: version `fb654a8b` (build-then-deploy per the
  stale-dist discipline), no migrations pending, healthz 200 on both
  surfaces, the custom domain survived the bump. Production == HEAD.
- **Evidence complete**: `docs/design/p0-evidence.md` REDEPLOY25 slots
  closed; RD24 finalized in the notes; the only open observation (the
  `dp3t/p0-shallow` orphan cascade, first tick past 72 h retention ≈ Oct 31)
  is a recorded watch item, not a gate.

No later commit is needed: the tree is quiet, pushed, and production matches
it. Tag exactly `60c65e1`. **Concurrent-edit caveat (updated at final pass)**:
sibling units had uncommitted hunks in flight at dossier finalization
(`AGENTS.md`, `README.md`, `wrangler.jsonc.example`,
`pnpm-workspace.yaml`, `dep-freshness-2026-10-28.md`, `check-delete-husk.mjs`,
`comment-attachments-fragment.ts`). The commands in §4 tag the COMMIT, so
uncommitted work cannot leak into the tag; but if those hunks should ride
v1.2, let their commits land first and re-run this dossier's checks at the
new HEAD (the §3 gate evidence above was measured at `60c65e1`, not at the
newer tree).

## 4. Exact commands (for the user, or the orchestrator on the user's nod)

Tag + push (the minimal decision):

```bash
git tag -a v1.2 -m "v1.2 — the port-first UI endgame: dispatchable board EMPTY (tick-16: 94/5/17), THE MOUNT WINDOW (11 modules, 62 ops), deferred-matrix ~1,170 cases (18 real bugs fixed), ws1009 root-fixed + pnpm test:full gate (ADR-0006), REDEPLOY17–25, engine cursor-drain discipline, demo live + repo public. Deployed as fb654a8b (RD25)." 60c65e1
git push origin v1.2
```

Optional GitHub Release — **size caveat**: the notes file is 908 lines /
~60 KB. `gh release create v1.2 --notes-file docs/RELEASE-NOTES-v1.2.md`
would render that entire wall in the release page; a short `--notes` summary
linking to the doc in-tree reads better:

```bash
gh release create v1.2 --target 60c65e1 --title "v1.2 — the port-first UI endgame" --notes "Full notes: docs/RELEASE-NOTES-v1.2.md in-tree at this tag (908 lines — snapshot 2026-10-27 HEAD 640005b + five addenda through the RD24 FINALIZED block and the day-record close). Highlights: UI parity endgame complete (dispatchable board EMPTY, tick-16 94/5/17), THE MOUNT WINDOW, ~1,170-case deferred matrix with 18 real bugs fixed, ws1009 root-fixed and ADR-0006's test:full gate, REDEPLOY17–25, demo live at cf-gitea-demo.aiapp.run, repo public. RD25 (the dep-bump window) rides this tag; its LIVE record is the tag commit's message + docs/design/p0-evidence.md."
```

(`--target 60c65e1` is redundant once the tag is pushed but harmless; keep
it if creating the release in the same breath.)

## 5. Intermediate v1.1 — RECOMMEND yes (back-dated), user decides

The v1.1 notes doc exists (622 lines / ~38 KB) with no tag behind it, and
v1.2's own header defines its window as "the post-v1.1 window" — a v1.1 tag
makes the three-notes/three-tags correspondence coherent and is one cheap
annotated tag. Two candidate cut points:

- **`4f59daa` — recommended**: the commit carrying the v1.1 notes' closing
  Addendum 3 (the v1.2 notes name it: "The v1.1 notes close at Addendum 3
  (`4f59daa`)"). The tagged tree contains the complete v1.1 record.
- `5ba6183` — the v1.1 header's snapshot HEAD; the tagged tree holds only
  the pre-addendum snapshot.

The tag object will carry today's date (tags cannot back-date truthfully);
say so in the message. Recommendation, not a decision:

```bash
git tag -a v1.1 -m "v1.1 (back-dated 2026-10-29) — the 2026-10-26 session snapshot (46 commits 9f92950→5ba6183) plus its addenda, closing at this commit; API 385→490 ops (88.4%), batch 6 project boards, storage lifecycle P1s. Record: docs/RELEASE-NOTES-v1.1.md." 4f59daa
git push origin v1.1
```

No GitHub Release needed for v1.1 (historical; SECURITY.md's supported-
versions line stays honest — latest tag only). A matching v1.0 Release is
likewise optional (`gh release create v1.0 --target a2ecd92 …`).

## Open issues

1. **RD25 is unrecorded in the notes doc** (11 commits after `f33860e`). The
   tag is valid without it (the tag message names RD25; evidence lives in
   `60c65e1`'s message + `p0-evidence.md`). If the user wants the doc
   complete first, a short seventh addendum (RD25 LIVE, `60c65e1`) should be
   appended and committed BEFORE tagging — that would move the cut point one
   commit ahead of `60c65e1`; re-run this dossier's §3 checks there.
2. **Benchmark job's red on `873da29`** (first compare-mode bench run) —
   resolved by the green `60c65e1` run; noted for the record only.
3. **Orphan watch item**: `dp3t/p0-shallow` cascades at the first sweep tick
   past 72 h retention (≈ Oct 31) — rides cron, does not block tagging.
4. If the v1.1 back-date is declined, `4f59daa`/`5ba6183` stay untagged and
   the sweep's coherence note stands resolved by v1.2 alone.
