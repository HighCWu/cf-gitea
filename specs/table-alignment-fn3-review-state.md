# SPEC: review_state.updated_files — the per-file viewed map (ADR-0007 FN-3)

Status: accepted (the ADR-0007 drift grant; the audit backlog's FN-3 unit) ·
Date: 2026-11-03 · Upstream pin: `gitea/` @ `fc4936884584` ·
Migration: `0065_review-state-updated-files` · Owner: the table-alignment wave (FN-3)

## 1. Problem and scope

Upstream's `review_state` table carries `updated_files` — the per-file viewed
map a reviewer builds while walking a pull request
(`gitea/models/pull/review_state.go:46`, `map[string]ViewedState` serialized
`xorm:"NOT NULL LONGTEXT JSON"`). Our landed `review_state` (migration 0059)
reduced the surface to ONE sha cursor per (user, pull): a reviewer who viewed
3 of 10 files at commit X, then saw the PR advance, lost the per-file
resolution upstream preserves — the viewed checkboxes degraded to a
whole-PR mark (the audit's drift row: `docs/research/table-alignment-audit.md`
§4 `review_state`, "MISSING `updated_files`").

In scope: the column (migration 0065), the viewed-files write arm's per-file
persistence, the files-page read (per-file badges, the changed-since marker,
the summary count), the no-JS form's honest mapping, tests, and this record.
Out of scope: the `pull_id` value-space move (our `issue_id` = issues.id vs
upstream pull_request.id — recorded optional in the audit; issues.id works
while the rows stay 1:1), upstream's per-commit-row history (see §3), and
the internal HasChanged persistence write (see §4).

## 2. Upstream derivation (the cites)

Model — `gitea/models/pull/review_state.go`:

- `ViewedState` uint8 iota (:19-25): `Unviewed=0`, `HasChanged=1`
  ("cannot be set from the UI/API, only internally"), `Viewed=2`.
- `ReviewState` (:41-48): `id` pk autoincr; `user_id`, `pull_id`,
  `commit_sha` VARCHAR(64) NOT NULL, together `UNIQUE(pull_commit_user)` —
  ONE ROW PER (user, pull, commit), the history kept; `updated_files`
  `map[string]ViewedState` `NOT NULL LONGTEXT JSON` (:46); `updated_unix`
  `xorm:"updated"` (:47). The JSON stores NUMBERS (encoding/json emits the
  uint8; the `String()` names never serialize).
- `UpdateReviewState` (:83-113), the merge ladder:
  - a row exists at the posted (user, pull, sha) → the posted map MERGES over
    the stored map (`mergeFiles` :117-126 — per-key override, old map kept
    for unposted keys);
  - no row at that sha → the newest OTHER-commit row's map seeds the new row
    (`getNewestReviewStateApartFrom` :141-158, `updated_unix DESC`, skipping
    the posted sha), merged with the posted map (:93-98) — viewed marks
    INHERIT across a push;
  - no previous row at all → the posted map as-is (:100);
  - insert (:107) or update of the `updated_files` column only (:111). A
    row is written even for an EMPTY posted map.
- `GetNewestReviewState` (:130-137): the newest row for (user, pull) by
  `updated_unix DESC` — the read entry point.

Write arm — the viewed-files route, `gitea/routers/web/repo/pull_review.go`:

- Route `m.Post("/viewed-files", repo.UpdateViewedFiles)`
  (`routers/web/web.go:1371`).
- Body `viewedFilesUpdate{Files map[string]bool, HeadCommitSHA string}`
  (:297-300); Go's json decode makes a non-object top level, a non-object
  `files`, a non-bool file value, or a non-string `headCommitSHA` a decode
  error → 400 (:310-316); absent fields decode as zero values.
- Empty `headCommitSHA` → `pull.HeadCommitID` (:319-321).
- bool → ViewedState: `false → Unviewed`, `true → Viewed`; HasChanged is not
  settable from outside (:323-331).
- `UpdateReviewState(ctx.Doer.ID, pull.ID, data.HeadCommitSHA, updatedFiles)`
  (:333). NOTE: this arm lives in the WEB router at the pin; the api/v1
  pull_review family carries no viewed arm (grep 0).

Read sites:

- `SyncUserSpecificDiff` (`services/gitdiff/gitdiff.go:1510-1579`), on the
  signed-in files view (gated `ctx.IsSigned && isShowAllCommits`,
  `routers/web/repo/pull.go:792`): read the newest row (:1513); compute the
  files changed between the row's `commit_sha` and the current head
  (`GetFilesChangedBetween`, :1526; errors IGNORED → assume no changes,
  :1527-1534); per diff file (:1541-1555): stored `HasChanged` OR in the
  changed set → `HasChangedSinceLastReview` (a stale VIEWED degrades); else
  stored `Viewed` → `IsViewed`; else unviewed. Files changed-then-reverted
  reset to `Unviewed` in the STORED map (:1556-1564), and the changed marks
  are PERSISTED via `UpdateReviewState` (:1566-1576) so they survive reloads.
- The count: `reviewState.GetViewedFileCount()` (`pull.go:799`, the model
  method counts `Viewed` entries, review_state.go:54-65) →
  `NumViewedFiles` + `prReview` PageData (:809-814).
- The diff tree carries the map (`pull.go:851-857`,
  `PageData["DiffFileTree"]`).
- Renders: the summary progress `templates/repo/diff/box.tmpl:28-33`; the
  per-file `viewed-file-form` label with `data-link`/`data-headcommit` and
  the path-named checkbox (box.tmpl:144-148, the JS island
  initDiffFileViewedForm posts one file per click); the
  `changed-since-last-review` marker (box.tmpl:141-143, locale
  `repo.pulls.has_changed_since_last_review` = "Changed since your last
  review").
- MERGE BOX: no consumer. The merge gate never reads review_state (grep over
  `services/pull`, `templates/repo/pull*`: zero viewed references) — the
  viewed map gates nothing at merge time.

## 3. Data model

`apps/worker/src/db/schema.ts`, the `review_state` hunk:

- ADD `updated_files` TEXT NOT NULL DEFAULT '{}' — upstream's exact column
  name and JSON shape (`{"path": 0|1|2}`); the numeric ViewedState iota is
  kept verbatim (upstream's serialization is numeric). The DEFAULT is the
  house migration adaptation (upstream has none): 0065 must back-fill the
  pre-map cursor rows with the empty map, and SQLite's ADD COLUMN applies the
  constant default to existing rows. The write path always stores a full JSON
  object.
- The single-row cursor is KEPT and recorded (the audit's optional arm): ours
  is UNIQUE(user_id, issue_id) — one row per (user, pull) whose `commit_sha`
  IS the cursor — where upstream keeps one row per (user, pull, commit) and
  orders by `updated_unix` to find the newest. The mapping is honest: our row
  IS upstream's newest row (its cursor sha), and `UpdateReviewState`'s
  new-sha inheritance (the previous-row seeding) collapses to merging the
  stored map into itself before advancing the cursor — the same map, one
  read instead of two. What we give up: the per-commit history (upstream can
  re-read an older review row; nothing at the pin reads anything but the
  newest — `GetNewestReviewState` is the only reader).

## 4. The ports (as-built, `apps/worker/src/ui/pages/pull-files.tsx`)

Write arm — `updateViewedFilesFromWeb` (+ `parseViewedFilesBody`,
`updateReviewStateAtHead`):

- The route seam (`ui/index.ts` viewedFilesPost) is UNCHANGED — it resolves
  the write context and the module owns the ladder (the established
  write-arm shape).
- Parse: the JSON arm is Go-strict (the §2 decode table → `bad-request`,
  the 400); the urlencoded form arm (`head_commit_sha`, `viewed`) stays the
  no-JS house arm, now expressing WHOLE-DIFF entries.
- Entries: JSON `files` map bool → VIEWED/UNVIEWED (HasChanged not
  externally settable, :325-329); the form arm expands to the diff's FULL
  path set (pullRequestDiffForEnv — the same range the page renders) at the
  resolved sha; an unreadable range degrades to no entries (the row still
  advances, never an error page). Empty posted map → entries {} — the row
  still upserts (upstream inserts the empty-map row, :105-108).
- Merge (`updateReviewStateAtHead`): same sha → per-key override over the
  stored map (mergeFiles); different sha → the stored map seeds, then the
  delta merges, and the cursor advances (the inheritance); `updated_unix`
  refreshes. The unique pair index carries the conflict target. The old
  `clearReviewState` row-delete is GONE: upstream never deletes rows on
  uncheck — an all-unviewed post writes UNVIEWED entries.

Read arm — `loadViewedState` (+ `changedPathsSinceCursor`, `parseUpdatedFiles`):

- The newest row for (user, pull); `current` = the row's sha IS the PR head
  sha — nothing can have changed, so the changed-set is empty by definition
  and NO engine read runs (the cheap-cursor read the audit asked to keep).
- Stale cursor: the changed paths between the cursor and the head come from
  the engine's `readDiff(head, cursor)` (GetFilesChangedBetween's port;
  transport/ref failures → the empty set, the errIgnored posture). Per
  rendered file the ladder resolves: stored HasChanged OR in the changed set
  → HAS_CHANGED; else stored VIEWED → VIEWED; else UNVIEWED
  (gitdiff.go:1541-1555).
- The count is GetViewedFileCount over the RESOLVED states (the summary and
  the progress bar) — upstream's count runs after its sync degraded the
  changed files, so both count the same set.
- DIVERGENCE (recorded): the internal persistence half of
  SyncUserSpecificDiff (:1566-1576) is NOT ported — no D1 write happens on a
  GET. Upstream persists HasChanged marks so they survive reloads; ours
  recomputes the changed set on every stale-cursor render, which yields the
  same rendered states for every input the persistence was protecting
  (the marks only matter while the cursor is stale, and the recompute covers
  exactly that window; once the reviewer posts at the new head, both stores
  agree the catch-up cleared them). The reverted-file reset (:1556-1564) is
  likewise recompute-side: a reverted file absent from the current diff
  simply resolves nothing (and its stale stored key cannot inflate the
  count, which walks the rendered diff's paths only).
- Renders: per-file `viewed-file-form` label (checked per the resolved
  state; upstream's exact attrs), the `changed-since-last-review` marker
  (box.tmpl:141-143's span verbatim), the summary count + progress over the
  resolved VIEWED set, and the no-JS mark form — now rendered while anything
  is left to mark (`numViewedFiles < files.length`; upstream has no no-JS
  arm; the form is the recorded house addition from the 79a94f9 fold).
- Single-commit and range pages keep their existing posture (viewed info is
  designed for the latest-PR diff only, pull.go:786-792 — unchanged).

## 5. Edge cases, limits, failure modes

- JSON `null` body: upstream decodes into a nil pointer and nil-derefs
  (a 500-panic class); ours answers the 400 (bad-request) — the honest
  divergence, recorded here.
- Non-bool file values / non-string `headCommitSHA`: 400 (Go's decode
  strictness — the previous house parser silently filtered; restored to
  upstream's refusal).
- The empty-sha default resolves `pr.headSha` ("" on a broken PR row — the
  row then stores an empty cursor, read as never-current).
- A forced push that GCs the cursor sha: `readDiff` misses → the empty
  changed set → stored VIEWED marks render as viewed (upstream's identical
  errIgnored posture, gitdiff.go:1527-1534).
- Legacy rows (pre-0065): DEFAULT '{}' → the empty map → zero viewed files,
  never a crash (`parseUpdatedFiles` clamps malformed/unknown values to
  UNVIEWED; the stored shape is otherwise trusted).
- The stale-key corner (Viewed entries for files no longer in the diff):
  cannot inflate the count or render phantom badges — both walk the rendered
  diff's paths. Upstream cleans such keys on its read (:1556-1564); ours
  leaves them dormant in the store, a bounded, write-side-only residue.

## 6. Testing plan (as-built)

- `apps/worker/src/db/schema.test.ts`, "review_state.updated_files parity
  (ADR-0007 FN-3, migration 0065)": the DDL pin (PRAGMA table_info — TEXT
  NOT NULL DEFAULT '{}' beside the untouched cursor columns), the
  legacy-writer simulation (a pre-0065 INSERT omitting the column reads
  '{}' and parses empty), and the merge port (no-row insert, same-sha
  override, new-sha inheritance + cursor + stamp, one-row-per-pair, the
  parser's defenses).
- `apps/worker/src/ui/pages/pull-files.matrix.test.tsx`:
  - the rewritten "viewed-files round-trip" describe (module-level over real
    D1, the seam's write context): the official bundle's JSON body stores
    the per-file entry in the numeric upstream shape; same-sha delta merges
    (per-key override, empty map preserves entries); the sha advance
    inherits the map and moves the cursor; the urlencoded form never deletes
    the row; the Go-strict 400 family (malformed JSON, non-bool, non-string
    sha, non-object files) and the non-pull redirect; the render arms (the
    stale/current/partial/anonymous summary and checkbox states over the
    fabricated diff, the helper merging the fabricated path into the
    resolved record the way the real loader resolves the rendered diff);
  - the new "FN-3 per-file viewed map" describe over the REAL engine (the
    w111 pull with actual refs): the no-JS form expands to the diff's full
    path set and the unmark form writes UNVIEWED entries; the read ladder
    resolves the subset post (posted keys only) and the advance (the changed
    file flips to HAS_CHANGED, the unchanged VIEWED file keeps VIEWED); the
    route-level page arms pin the partial summary ("1 / 2 files viewed",
    progress 1/2), the checked subset, and the changed-since marker on the
    real HTML.
- Adjacent: issue-detail.matrix's route-level viewed-files POST (the empty
  headCommitSHA default arm) stays green; pull-files-single-commit smoke
  unaffected.

## 7. Sources

- Upstream: `gitea/models/pull/review_state.go`, `gitea/routers/web/repo/
  pull_review.go`, `gitea/routers/web/web.go:1371`, `gitea/routers/web/repo/
  pull.go:786-861`, `gitea/services/gitdiff/gitdiff.go:1510-1579`,
  `gitea/templates/repo/diff/box.tmpl:28-33,141-148`,
  `gitea/options/locale/locale_en-US.json:1782-1784`.
- Ours: `apps/worker/src/db/schema.ts` (the review_state hunk),
  `apps/worker/src/db/migrations/0065_review-state-updated-files.sql`,
  `apps/worker/src/ui/pages/pull-files.tsx`, `apps/worker/src/ui/pages/
  pull-files.matrix.test.tsx`, `apps/worker/src/db/schema.test.ts`.
- Drift classification: `docs/research/table-alignment-audit.md` §4/§5 FN-3;
  the grant: `docs/decisions/0007-upstream-table-alignment.md`.
