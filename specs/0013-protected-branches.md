# SPEC-0013: Protected branches & approval-gated merges — draft, gated

Status: **accepted — ratified 2026-10-25** (the §1.1 entry criterion "the
landed-but-idle reviews family pulling" is met: the reviews wave landed with
merge-blocking explicitly deferred for want of this surface — the gap is
live in the product. Implementation begins at M1; M2's engine hook requires
the vendored-deviation ledger discipline) ·
Date: 2026-10-25 · Fills the deferred item the reviews wave recorded twice: the
`isOfficialReviewer` protected-branch whitelist arm ("the protected-branch whitelist
arm has no cf-gitea surface",
`apps/worker/src/api/routes/pull-reviews.ts:360-367`) and the `pull_reviews.official`
column comment (same note, `apps/worker/src/db/schema.ts:1776-1778`).
Depends on: SPEC-0003 (git-HTTP gate + ACL matrix), SPEC-0004 (API conventions +
contract discipline), SPEC-0005 (PR model + mergeable state), SPEC-0007 (org
teams — the whitelist team predicates), SPEC-0001b (merge-base/graph primitives),
and the **landed reviews family** (`pull_reviews` table, migration 0018;
`apps/worker/src/api/routes/pull-reviews.ts`).
Owns: the `protected_branches` D1 table, the rule match/predicate service, the merge
RPC approval gate, the push-time per-ref rejection arms, the reviews interplay
(official-recompute, stale-marking, dismiss-on-push), and the
`/repos/{owner}/{repo}/branch_protections` API family (6 frozen operations).

Upstream findings are against the vendored submodule (`gitea/`, read-only, pin
`fc4936884584` / `v1.22.0-rc1-3919-gfc493688` era — the same pin every 0012-era
citation uses). Landed-code findings are against `apps/worker/**` as of 2026-10-25.

## 1. Problem and scope

The reviews wave landed the complete review model — submit, pending lifecycle,
dismiss/undismiss, review requests (user + team), the `official`/`stale`/`dismissed`
flags — but **nothing consumes it**. Our merge RPC gates on write access + WIP +
mergeable state only (`apps/worker/src/api/routes/pulls.ts:1090-1123`); upstream gates
on the base branch's protection rule: required approvals, rejected-review blocks,
merge whitelists, bypass allowlists. Symmetrically, a push to `main` is gated only by
repo-level write access (`src/git-http/gate.ts` ACL matrix) — there is no per-ref
notion at all. Gitea's answer to both is the protected-branch rule: a per-repo
pattern-matched rule that arms (a) the git push reject path and (b) the PR merge path.

**Proposed compatibility level:** the frozen `/api/v1` branch_protections family is
contract-faithful end to end; enforcement covers the merge-side arms in full
(approvals, rejected reviews, official review requests, outdated branch, merge/bypass
whitelists, admin override) and the push-side arms that need no object inspection
(direct-push allowlist, force-push, deletion). Arms that need commit inspection
(protected-file patterns, signed commits) or a CI product (status checks) are stored
and echoed by the contract but deliberately not enforced in v1 (§6).

### 1.1 Entry-criteria decision (the gate on this SPEC)

**Decision: implement when a concrete demand exists for branch protection against a
deployed cf-gitea instance; until then this SPEC stays `draft` and nothing in it is
built.** The window opens when ANY of:

1. **Demand** — a real user/project on a cf-gitea instance needs "nobody pushes to
   `main` directly" or "merges need N approvals". SPEC-0010 §1.1's rationale applies
   verbatim: the correct resting state of a demand-shaped feature is `draft`.
2. **The reviews pull-through** — the strongest standing candidate: the reviews wave
   is already landed and idle. The `pull_reviews` table carries `official`, `stale`,
   `dismissed` (`src/db/schema.ts:1763-1793`) and the dismissal API arms exist
   (`pull-reviews.ts:1337-1464`), but with no rule model the flags are decorative —
   `official` is computed once at submit time (`pull-reviews.ts:682-692`) and no
   counter ever reads it. A second reviews-consuming feature (e.g. the settings UI
   wave showing "N approvals required") would justify landing the merge gate even
   without an external user asking.

Rationale (recorded so the gate survives personnel changes): protected branches span
three enforcement planes at once — D1 rule storage, the engine's receive path (a
vendored-package deviation with its own review cost, §3.3), and the merge RPC — and
the API family is 6 admin-scoped operations on a surface whose consumers are exactly
the users who ask for it. Building it speculatively buys complexity in the hardest
seam we have (per-ref push rejection) for nobody. When the gate fires, this SPEC is
reviewed, ratified to `accepted`, and implemented milestone by milestone (§5).

### 1.2 In scope (when the gate opens)

1. The `protected_branches` D1 table + rule service (match/sort/predicates) (§3.1-3.2).
2. The merge RPC gate: merge-whitelist, required approvals, rejected-review /
   official-request / outdated-branch blocks, bypass + admin override (§3.3).
3. The reviews interplay: approvals-whitelist-aware `official` computation
   (retroactive recompute on rule change), head-push stale marking, dismiss-on-push
   (§3.4).
4. The push-time per-ref gate: direct-push allowlist, force-push, branch deletion,
   through a new engine hook (§3.5).
5. The `/branch_protections` API family (6 ops) + the Branch-render extras
   (`user_can_push`, `user_can_merge`, `effective_branch_protection_name`) (§3.6).
6. Rule-change recheck fan-out (upstream CheckPRsForBaseBranch analog) (§3.4).

### 1.3 Out of scope (v1; §6 lists what stays out even later)

- Status-check requirements (`enable_status_check` / `status_check_contexts`) —
  no CI product exists (SPEC-0012 is itself gated); statuses are a write-only API
  today (`src/api/routes/statuses.ts`), nothing consumes them.
- Protected/unprotected file patterns, `require_signed_commits` (§6).
- CODEOWNER-review requirements (`block_on_codeowner_reviews`) — no CODEOWNERS
  surface landed.
- Auto-merge schedule (`merge_when_checks_succeed`): our merge route already refuses
  it with the declared 409 (`pulls.ts:1102-1105`) and
  `src/api/routes/pull-automerge.ts` mirrors upstream's not-scheduled 404 — that
  stance stands until demand.
- Tier-2 settings UI (upstream `routers/web/repo/setting/protected_branch.go`).

## 2. Surface inventory at the pin

### 2.1 The rule model (`models/git/protected_branch.go`)

`ProtectedBranch` (`gitea/models/git/protected_branch.go:30-42`) — one row per rule:

| Column | Notes (cite) |
|---|---|
| `ID` int64 pk autoincr | `:31` |
| `RepoID` int64, `UNIQUE(s)` (together with the name column) | `:32` |
| `RuleName` string, column **`branch_name`**, `UNIQUE(s)` — "a branch name or a glob match to branch name" | `:34` |
| `Priority` int64 NOT NULL DEFAULT 0 | `:35` |
| `ProtectedBranchConfig` — one JSON blob in column `config` (`JSON LONGTEXT`) | `:38` |
| `CreatedUnix` / `UpdatedUnix` | `:40-41` |

`ProtectedBranchConfig` (`:45-80`), every field with its json key — this is the
enforcement vocabulary; each is cited at its arming site in §2.3:

- Push: `can_push`, `enable_whitelist`, `whitelist_user_ids`, `whitelist_team_ids`
  (`:46-49`).
- Merge whitelist: `enable_merge_whitelist`, `merge_whitelist_user_ids`,
  `merge_whitelist_team_ids` (`:50-52`).
- Bypass: `enable_bypass_allowlist`, `bypass_allowlist_user_ids`,
  `bypass_allowlist_team_ids` (`:53-55`).
- Force push: `can_force_push`, `enable_force_push_allowlist`,
  `force_push_allowlist_user_ids`, `force_push_allowlist_team_ids` (`:56-59`).
- Deletion: `can_delete`, `enable_deletion_allowlist`, `deletion_allowlist_user_ids`,
  `deletion_allowlist_team_ids` (`:60-63`).
- Status checks: `enable_status_check`, `status_check_contexts` (`:64-65`).
- Approvals: `enable_approvals_whitelist`, `approvals_whitelist_user_ids`,
  `approvals_whitelist_team_ids`, `required_approvals`, `block_on_rejected_reviews`,
  `block_on_official_review_requests`, `block_on_codeowner_reviews`,
  `block_on_outdated_branch`, `dismiss_stale_approvals`, `ignore_stale_approvals`
  (`:66-75`).
- Commits/files: `require_signed_commits`, `protected_file_patterns`,
  `unprotected_file_patterns` (`:76-78`).
- Admin: `block_admin_merge_override` (`:79`).

**Matching.** `IsRuleNameSpecial` = contains any glob special byte
(`modules/glob` predicates, `:87-94`). Plain (non-special) names match
case-insensitively (`strings.EqualFold`, `Match` `:115-124`); special names compile
as globs with `/` as separator (`glob.Compile(name, '/')`, `:107`); an invalid glob
falls back to a quoted-literal match (`:108-111`) — never a panic, never a broad
match. Rule selection is **first match wins** over a sorted list:
`FindRepoProtectedBranchRules` loads all repo rules then sorts by `Priority`, then
plain-name-before-glob, then creation order
(`models/git/protected_branch_list.go:27-54`); `GetFirstMatchProtectedBranchRule`
returns the first match (`:92-98`); `IsBranchProtected` is the boolean wrapper
(`:101-107`).

**Predicates** (all cite `models/git/protected_branch.go`):

- `CanUserPush` (`:135-158`): `can_push` must be set; without the whitelist, any
  repo-code-unit write access passes; with it, explicit user id or team membership
  (`organization.IsUserInTeams`, `:152`).
- `CanUserForcePush` (`:162-185`): `can_force_push` AND (no allowlist → the push
  predicate; else user/team allowlist AND push predicate).
- `CanUserDelete` (`:189-215`): write access AND `can_delete` AND push predicate,
  plus the deletion allowlist when enabled.
- `IsUserMergeWhitelisted` (`:218-238`): without `enable_merge_whitelist`, falls back
  to repo write access; with it, explicit user/team only.
- `CanBypassBranchProtection` (`:242-261`): repo admin unless
  `block_admin_merge_override`, else the bypass allowlist (user/team).
- `IsUserOfficialReviewer` (`:264-289`): without `enable_approvals_whitelist`,
  anyone with code-unit **write** counts; with it, the approvals whitelist
  (user/team) counts.

**Save-side validation.** `UpdateProtectBranch` (`:418-527`) refuses archived repos
(`MustNotBeArchived`, `:419`), sanitizes every whitelist: user whitelists keep only
users with write access (deploy-key/Actions pseudo-ids excepted,
`updateUserWhitelist` `:572-601`, pseudo-id carve-out `:580-583`); the approvals
whitelist keeps users with any unit access (`updateApprovalWhitelist` `:549-568`);
team whitelists keep teams with read+ on code or PR units
(`updateTeamWhitelist` `:605-624`); new rules get `priority = max+1`
(`:502-513`). `UpdateProtectBranchPriorities` renumbers in one transaction
(`:529-545`). `RemoveUserIDFromProtectedBranch` / team variant scrub a deleted
principal from every allowlist column in one config rewrite (`:648-693`).

### 2.2 The frozen API contract (6 operations)

Route group (`gitea/routers/api/v1/api.go:1323-1332`) — every route carries
`reqToken(), reqAdmin()`; the write routes add `mustNotBeArchived`:

| Op | Route | Handler |
|---|---|---|
| `repoListBranchProtection` | GET `/repos/{owner}/{repo}/branch_protections` | `branch.go:588` |
| `repoGetBranchProtection` | GET `…/branch_protections/{name}` | `branch.go:544` |
| `repoCreateBranchProtection` | POST `…/branch_protections` | `branch.go:652` |
| `repoEditBranchProtection` | PATCH `…/branch_protections/{name}` | `branch.go:855` |
| `repoDeleteBranchProtection` | DELETE `…/branch_protections/{name}` | `branch.go:1210` |
| `repoUpdateBranchProtectionPriories` | POST `…/branch_protections/priority` | `branch.go:1259` |

Wire shapes (`gitea/modules/structs/repo_branch.go`): `BranchProtection`
(`:33-80`) — note `rule_name` + the deprecated `branch_name` (`:34-35`), priorities
(`:38-39`), and the full config vocabulary as username/team-**name** arrays
(`:40-75`) plus `created_at`/`updated_at` (`:76-79`). `CreateBranchProtectionOption`
(`:83-124`), `EditBranchProtectionOption` (`:127-165`, all-scalar fields are
pointers — absent ≠ false), `UpdateBranchProtectionPriories{ids}` (`:167-170`).
Create semantics: 400 when both names are empty (`branch.go:693-696`), the
deprecated `branch_name` falls back (`:689-692`), 403 "Branch protection already
exist" on name collision (`:698-705`), usernames→ids via
`loadBranchProtectionUserIDs` (`:712-717`), team names→ids via
`GetTeamIDsByNames` with 422 on unknown team, org-owned repos only (`:722-769`).

The `Branch` render extras this SPEC makes real
(`modules/structs/repo_branch.go:11-30`): `protected`, `required_approvals`,
`enable_status_check`, `status_check_contexts`, `user_can_push`, `user_can_merge`,
`effective_branch_protection_name`. Our contract models already declare the first
two as optional fields (`apps/worker/src/api/models/git.ts:212-213`).

### 2.3 Enforcement points

**(a) Git push (pre-receive).** `gitea/routers/private/hook_pre_receive.go`,
`preReceiveBranch` (`:123-313`), evaluated per ref command in strict order:

1. Default-branch and PR-target deletion refused absolutely (`:140-147`).
2. Rule lookup `GetFirstMatchProtectedBranchRule` (`:149-153`); no rule → allow
   (`:155-158`).
3. Deletion arm: `CanUserDelete` else 403 "Branch X is protected from deletion"
   (`:166-171`).
4. Force-push detection: `git rev-list --max-count=1 <old> ^<new>` — output
   non-empty ⇒ old is not an ancestor of new ⇒ force push; refused unless
   `CanForcePush` ("Branch X is protected from force push", `:176-191`).
5. `RequireSignedCommits` verification (`:194-205`).
6. Protected-file patterns via `CheckFileProtection` (`:210-226`).
7. `canPush = !changedProtectedFiles && (isForcePush ? CanUserForcePush :
   CanUserPush)` (`:229-234`).
8. **The UI/API-merge escape hatch** (`:236-312`): when the push originates from a
   merge (`opts.PullRequestID != 0`), instead of the direct-push refusal the hook
   runs `IsUserAllowedToMerge` (`:281`), `CanBypassBranchProtection` (`:293`), and
   the full `CheckPullBranchProtections` (`:304`); direct pushes get 403
   "Not allowed to push to protected branch X" (`:267`), with the
   unprotected-files-only allowance in between (`:248-260`).

**(b) Branch delete/rename via API+UI.** `CanDeleteBranchWithPermission`
(`gitea/services/repository/branch.go:560-581`) refuses non-allowlisted deletion of
a protected branch (`:569-579`); renaming **onto** a protected name requires the
push predicate (`:461-468`); web editor push arms land in the same pre-receive hook
(`routers/web/repo/editor.go`, the `protected_branch` reference).

**(c) PR head-branch update.** Force-pushing a PR head through the update endpoint
checks `CanUserForcePush` (`gitea/services/pull/update.go:127`).

**(d) Merge RPC.** `MergePullRequest` (`gitea/routers/api/v1/repo/pull.go:849-…`)
calls `CheckPullMergeable` (`:928`) → `services/pull/check.go:142-213`:

- `IsUserAllowedToMerge` (`services/pull/merge.go:671-691`): repo-code write with
  **no** rule, or merge-whitelist pass with one — else `ErrNoPermissionToMerge`
  (405 "User not allowed to merge PR", `pull.go:930-932`).
- `CheckPullBranchProtections` (`merge.go:694-742`), in order: commit-status pass
  (`:707-713`), `HasEnoughApprovals` (`:715-717`), rejected-review block
  (`:718-720`), official-review-request block (`:721-723`), outdated-branch block
  (`:725-727`), codeowner reviews (`:729-731`), protected files (`:737-739`).
  Every failure wraps `ErrNotReadyToMerge`, whose `Error()` renders **only the
  message** (`modules/util/error.go:56-58`) — so the API 405 body is exactly
  "Does not have enough approvals" / "There are requested changes" / "There are
  official review requests" / "The head branch is behind the base branch" / "Changed
  protected files" / "Not all required status checks successful"
  (`pull.go:936-937` maps `ErrNotReadyToMerge` → 405 with `err.Error()`).
- **Force-merge escape** (`check.go:192-207`): `force_merge` succeeds only through
  `CanBypassBranchProtection`; **auto merge** (`MergeCheckTypeAuto`) defers
  protection failures instead of failing (`:187-190`); "manually merged" skips the
  checks entirely (`:162-165`).
- Same checks re-arm inside the git push hook for UI/API merges (§2.3(a) step 8).

**(e) Approval counting.** `gitea/models/issues/pull.go`: `HasEnoughApprovals`
(`:762-767`, zero required = pass); `GetGrantedApprovalsCount` (`:770-785`) counts
reviews `type = Approve AND official = true AND dismissed = false`, adding
`stale = false` **only** when `ignore_stale_approvals` is set (`:775-777`);
`MergeBlockedByRejectedReview` (`:788-803`) — any official undismissed reject;
`MergeBlockedByOfficialReviewRequests` (`:807-821`) — any official request row;
`MergeBlockedByOutdatedBranch` (`:824-826`) — `block_on_outdated_branch AND
CommitsBehind > 0`.

**(f) Staleness + dismissal on head push.** `gitea/services/pull/pull.go:425-461`:
on a head-branch push that changed PR content — `MarkReviewsAsStale` (`:440`), then
`DismissApprovalReviews` when the base rule sets `dismiss_stale_approvals`
(`:444-453`; the dismissal comment text is fixed:
"New commits pushed, approval review dismissed automatically according to repository
settings", `services/pull/review.go:362`), then `MarkReviewsAsNotStale` against the
new tip (`:455`). `DismissApprovalReviews` dismisses every undismissed approval in
one transaction and lands a `CommentTypeDismissReview` comment per review
(`review.go:338-380`).

**(g) Rule-change recheck.** `CreateOrUpdateProtectedBranch`
(`gitea/services/pull/protected_branch.go:13-47`): after save, re-checks PRs whose
base branch the rule matches — the exact branch for a plain name, all matched
branches for a glob (`FindAllMatchedBranches`, `models/git/protected_branch_list.go:57-89`).

**(h) Web settings UI.** `routers/web/repo/setting/protected_branch.go` (e.g. the
dismiss-stale toggle at `:304`) — Tier-2 UI, out of scope (§1.3).

## 3. cf-gitea mapping

### 3.1 D1 table (one migration, next number — 0019+ at this writing; the reviews
wave landed 0018, `apps/worker/src/db/migrations/0018_long_jigsaw.sql`)

`protected_branches` — column-for-column port of `ProtectedBranch`
(§2.1) minus ORM plumbing:

| column | type / notes |
|---|---|
| `id` | integer PK autoincrement |
| `repo_id` | integer NOT NULL, indexed; `UNIQUE(repo_id, rule_name)` — the upstream `UNIQUE(s)` pair (`protected_branch.go:32,34`) |
| `rule_name` | text NOT NULL (upstream column `branch_name`; we use the semantic name — the API keeps `rule_name`) |
| `priority` | integer NOT NULL DEFAULT 0 |
| `rules` | text NOT NULL — the `ProtectedBranchConfig` JSON verbatim, stored under upstream's exact snake_case json keys (§2.1) so contract rendering is a read-and-echo |
| `created_at` / `updated_at` | integer timestamps |

No separate allowlist tables: the six user/team id arrays stay inside the JSON blob,
exactly like upstream's single `config` column. Team predicates ride the landed
SPEC-0007 tables — `teams` / `team_members` with the exact lookup shape
`pull-reviews.ts:809-831` already uses (org-scoped membership select).

### 3.2 The rule service (`src/services/branch-protection.ts`, new)

Pure-D1 module, consumed by the merge RPC, the push hook, and the API family:

- `findRule(repoId, branchName)`: load repo rules, port the §2.1 sort
  (priority → plain-before-glob → created; `protected_branch_list.go:27-54`), first
  match. Plain-name matching is case-insensitive (`EqualFold`, `:117-119`) — our
  branch names are stored verbatim, so the comparator ports, not the storage.
- Glob matching: a minimal port of `modules/glob` (`*`, `?`, `[...]`, `[]` classes,
  `/`-separated) — self-contained, ~200 lines upstream; invalid patterns
  fall back to quoted-literal (`:108-111`).
- Predicate ports: `canUserPush` / `canUserForcePush` / `canUserDelete` /
  `isUserMergeWhitelisted` / `canBypassBranchProtection` / `isUserOfficialReviewer`
  (§2.1), each taking `(rule, viewer/permission)`; the team arms resolve through the
  §3.1 membership select. The permission input is the existing
  `repositoryPermissions` + `collaboratorModeOf` pair
  (`pull-reviews.ts:367-375` uses exactly this composition for the reduced
  `isOfficialReviewer`).

### 3.3 The merge gate (M1 — the reviews payoff)

Insertion point in `POST /repos/{owner}/{repo}/pulls/{index}/merge`
(`src/api/routes/pulls.ts:1087-1151`): after the write check (`:1090`) and before
the mergeable precondition (`:1114-1123`), porting `CheckPullMergeable`'s ordering:

1. `isUserAllowedToMerge` port (§2.3(d)) — no rule + write (already checked), or
   rule + merge whitelist; failure stays the existing 403 "User not allowed to
   merge PR" (`pulls.ts:1091`).
2. Rule found → `checkPullBranchProtections` port over `pull_reviews`:
   count approvals (`type=Approve AND official AND NOT dismissed`, plus
   `stale=false` iff `ignore_stale_approvals` — a single Drizzle count against the
   existing index `pull_reviews_issue_idx`
   (`src/db/schema.ts:1790`)); rejected-review and official-request existence
   checks; outdated-branch block needs the commits-behind count the mergeability
   check already computes (SPEC-0001b merge-base landed;
   `mergeableOfRow`/`ensurePullRequestChecked` at `pulls.ts:1114-1123` is where the
   count surfaces). Failures → **405 with the upstream message text verbatim**
   (§2.3(d): "Does not have enough approvals", "There are requested changes",
   "There are official review requests", "The head branch is behind the base
   branch").
3. `force_merge` escape (`CanBypassBranchProtection` port) → clears the failure
   (§2.3(d), `check.go:192-207`). Note our merge option schema must grow
   `force_merge` (upstream `forms.MergePullRequestForm`); it is not in the frozen
   bind today — contract check at M1.
4. `block_admin_merge_override`: our current admin-grant path
   (`repositoryPermissions().admin`) feeds `canBypassBranchProtection`'s
   repo-admin arm.

This closes the merge-block the reviews wave deferred: the reviews flags stop being
decorative the moment this gate lands.

### 3.4 Reviews interplay (M1, same wave)

- **`isOfficialReviewer` gains its whitelist arm** — the documented gap
  (`pull-reviews.ts:360-367`) closes: write-access fallback becomes the
  no-`enable_approvals_whitelist` arm, the whitelist (user/team) becomes the
  explicit arm (§2.1 `IsUserOfficialReviewer`). Callers are unchanged.
- **Retroactive recompute on rule change** (the §2.3(g) port): creating/updating a
  rule re-evaluates `official` for open PRs whose base matches (plain name → one
  branch; glob → matched branches via the branches listing). Upstream re-runs the
  PR check pipeline; for us the minimal faithful pass is a bounded D1 rewrite of
  the `official` flags per open PR (the flag is a stored denormalization both
  upstream and we carry).
- **Head-push staleness** (the §2.3(f) port): the engine's `onPush` seam
  (`packages/git-engine/src/mod.ts:1043-1052`, wired through
  `handleUserPushEvent`, `src/services/webhooks-push.ts:578-590`) gains two
  fan-out legs beside `emitPushFamilyUpdates`: when a pushed branch is (or contains,
  via `refs/pull/N/head`) a PR head and content changed → `stale=true` on the PR's
  decision reviews; if the base rule sets `dismiss_stale_approvals` → the
  dismissal pass (flag flip + `CommentTypeDismissReview` comment + num_comments
  bump, `pull-reviews.ts:1430-1444` shape). Budget: these are bounded D1 writes per
  open PR on the pushed branch — inline under the `onPush` hook's 30 s
  `waitUntil` cap (AGENTS.md) at hobby scale; a `repo-tasks` queue leg is the
  escape hatch if PR counts grow (OQ-3).

### 3.5 The push-time per-ref gate (M2 — the engine seam, the hard one)

Upstream rejects per-ref inside pre-receive (§2.3(a)). Our gate authorizes
per-**request** (`read`/`write`, `src/git-http/acl.ts` + the ACL matrix) and the
engine `authorize` hook's `AuthContext` carries repo/op/credentials but **no ref
information** (`packages/git-engine/src/mod.ts:165-177`). The push command section
is parsed inside the engine's worker-side receive handler — `parsePushRequest`
buffers exactly the pkt-line command list before the pack streams
(`mod.ts:580-615`, `parsePushCommands` at `:615`) — and the DO re-checks per-command
CAS at finalize (`mod.ts:995-1001`). The seam is therefore **a new engine hook**,
not gate-side parsing (the gate would have to re-frame pkt-lines from a body that
must stay stream-clean — a protocol-parse duplication with zero upside):

- Proposal: `validatePush?: (commands, ctx) => Promise<Decision[]>` invoked after
  `parsePushCommands` and before lease acquisition; each `Decision` is
  `allow | reject(reason)`, with rejected commands rendered through the existing
  report-status path and the whole-request case (403 text) preserved for
  fail-closed arms. **This is a vendored-engine deviation → one `NOTICE.md` entry**
  (AGENTS.md structure rules), reviewed in the same wave.
- What the hook must know per command: create / delete / fast-forward / force-push
  classification. Force detection is ancestry (§2.3(a) step 4) — the engine has the
  primitive (`mergeBase`, `packages/git-engine/src/repo.ts:919`) and already walks
  commands at finalize, so v1 classifies **inside the engine** and hands the hook
  classified commands (one DO RPC per push, not per command).
- v1 enforced arms (no object inspection): deletion allowlist, force-push
  allowlist, direct-push allowlist — the §2.1 push/deletion predicate ports. The
  UI/API-merge escape hatch does not exist for us (our merges never traverse
  receive-pack), so the hook's failure mode is uniformly "reject the command".
- Deferred arms that need the pack/tree: protected-file patterns,
  `require_signed_commits` (§6).

### 3.6 The API family (M3)

The 6 operations of §2.2 over zod-openapi routes in
`src/api/routes/branch-protections.ts`, admin-scoped (the repo-admin grant +
collaborator-admin row, the `pull-reviews.ts:1386-1394` composition), name-keyed
paths, `mustNotBeArchived` on writes, the create/priority arms' exact error mapping
(§2.2), usernames/teams resolved name→id at the edge (org teams only resolve on
org-owned repos — `pull-reviews.ts:1526-1542` precedent). Plus the Branch render
extras (§2.2): `GET /branches` + `GET /branches/{branch}` compute
`user_can_push`/`user_can_merge`/`effective_branch_protection_name` per viewer from
the rule service; `protected`/`required_approvals` stop rendering `undefined`.
Contract: 6 ops added to the frozen-swagger declarations, `pnpm check:api` moves
+6 (REG commit per family discipline).

## 4. Edge cases, limits, failure modes

| # | Case | Behavior |
|---|---|---|
| 4.1 | Rule-glob matches the default branch | Fully armed, like any branch — except default-branch deletion is refused absolutely (§2.3(a) step 1); our delete arms mirror via `CanDeleteBranchWithPermission` port. |
| 4.2 | Invalid glob in `rule_name` | Quoted-literal fallback (`:108-111`) — stored as-is, matches nothing it shouldn't. |
| 4.3 | Case: rule `Main` vs branch `main` | Plain names match case-insensitively (`:117-119`); glob rules stay case-sensitive (glob semantics). |
| 4.4 | Whitelist references a demoted/deleted user or team | Save-time sanitization (§2.1) drops them on the next rule edit; deletion-time scrub via the `RemoveUserID/TeamIDFromProtectedBranch` port (`:648-693`) when the principal delete cascades. |
| 4.5 | Priority edit reorders first-match | Sorting is deterministic (§2.1); the priority op renumbers in one D1 batch (`:529-545` port). |
| 4.6 | Archived repo | All rule writes 423 (upstream `mustNotBeArchived` + `MustNotBeArchived` `:419`); merges stay refused by the existing archived gate. |
| 4.7 | Rule added while PRs open | §3.4 recompute pass flips `official` (and the merge gate re-reads the rule per request — no caching; D1 reads are per-request like every ACL decision). |
| 4.8 | Push touches a protected branch AND the PR-merge path | N/A for us (merges never traverse receive-pack, §3.5) — the hook rejects; the merge RPC is the only protected-merge channel, matching upstream's API-merge arm (`check.go`). |
| 4.9 | `required_approvals > 0` with `enable_approvals_whitelist` and empty whitelist | Count is 0 forever → permanent 405 "Does not have enough approvals" (upstream-identical; the settings UI is the fix, §6). |
| 4.10 | Concurrent merge + rule edit | The gate reads the rule inside the merge request's D1 session; upstream has the same last-writer-wins semantics (rule read per check, `merge.go:699`). |

## 5. Milestones, effort, entry criteria

Effort in **wave units** (one wave ≈ one background-agent landing unit with review;
SPEC-0012 §5 convention). All gated behind §1.1.

| # | Milestone | Content | Est. | Why |
|---|---|---|---|---|
| M1 | Merge gate + reviews interplay | Migration + `protected_branches`; rule service (match/sort/glob); merge RPC gate (§3.3) with upstream 405 texts; `force_merge` bind; official-whitelist arm + recompute; head-push stale/dismiss legs (§3.4) | 2 | Pure D1 + existing seams; the recompute and stale legs touch the reviews module's hot paths |
| M2 | Push-time ref gate | Engine `validatePush` hook + classified commands + report-status rendering (§3.5); push/deletion/force predicate enforcement; NOTICE.md entry; e2e through a real git client | 1.5 | The vendored-engine deviation is the review risk; ancestry classification rides landed primitives |
| M3 | API family | 6 `/branch_protections` ops + Branch render extras + contract REG (§3.6) | 1 | Mechanical once the rule service exists; contract + swagger discipline |
| M4 | Hardening + allowlist breadth | Save-side whitelist sanitization (§2.1), principal-deletion scrub, priority op edge cases, bypass/admin-override matrix tests | 1 | Breadth, not depth |

**Total: ~5.5 waves.** Uncertainty concentration: M2's hook shape (engine review) and
M1's commits-behind plumbing for the outdated-branch block. Calibration: the
reviews wave (comparable breadth over the same PR machinery) landed as one family
commit (`pull-reviews.ts`, migration 0018).

## 6. What v1 deliberately omits (and likely stays omitted without new demand)

- **Status checks / `status_check_contexts`** — stored + echoed by the contract,
  never enforced: there is no CI (SPEC-0012 gated) and statuses are a write-only
  API (`src/api/routes/statuses.ts`); the `IsPullCommitStatusPass` arm
  (`merge.go:707-713`) has no producer. Enforcement returns only with a status
  consumer.
- **Protected/unprotected file patterns** — pre-receive diff walking
  (`hook_pre_receive.go:210-226`) is real CPU per push for the least-demanded arm;
  the `unprotected_files_only` allowance (`:248-260`) compounds it.
- **`require_signed_commits`** — no commit-signature verification surface exists.
- **`block_on_codeowner_reviews`** — no CODEOWNERS surface.
- **Merge queue / auto-merge schedule** — the 409 on
  `merge_when_checks_succeed` stands (`pulls.ts:1102-1105`); upstream's
  auto-merge deferral semantics (`check.go:187-190`) land with it, if ever.
- **Tier-2 settings UI** — upstream's rule editor
  (`routers/web/repo/setting/protected_branch.go`) is API-only for us; the API
  family is the admin surface.
- **Glob complexity**: the full upstream glob grammar ports (§3.2) because it is
  small and load-bearing for matching; the **UI conveniences** around it
  (drag-order priority editing, matched-branch preview) stay out — the priority
  op covers ordering.

## 7. Testing plan (when ratified)

- **Unit**: rule sort/match table (priority × plain/glob × created tie-break,
  `protected_branch_list.go:27-54` cases); predicate ports table-driven; approval
  counting against seeded `pull_reviews` (official/stale/dismissed permutations,
  `ignore_stale_approvals` arm).
- **vitest-pool-workers (real D1)**: merge gate 405 texts verbatim (§3.3);
  `force_merge` bypass matrix (admin × `block_admin_merge_override` × bypass
  allowlist); official recompute on rule create/update.
- **E2e (real git client)**: protected branch rejects direct push with upstream's
  message text; whitelist member pushes; force-push refused/allowed per allowlist;
  protected deletion refused; report-status shows the rejected command (§3.5).
- **Contract**: the 6 ops against the frozen swagger; `pnpm check:api` +6.

## 8. Open questions (resolve at ratification/implementation)

- **OQ-1 (M2, engine)**: hook signature — raw `PushCommand[]` vs pre-classified
  (create/delete/ff/force) commands; and reject granularity (per-command
  report-status vs whole-request 403) per arm. Decided in the M2 engine-design
  pass with the NOTICE.md entry.
- **OQ-2 (M1)**: does `force_merge` join the frozen merge bind at M1 (contract
  check) or ride the option schema's existing passthrough? Upstream binds it from
  the form (`pull.go:928` `ForceMerge`).
- **OQ-3 (M1)**: head-push dismissal inline (30 s `waitUntil` budget) vs a
  `repo-tasks` leg — instrument PR-count-per-branch at M1; the D1 write count is
  the only variable.
- **OQ-4 (product)**: default `required_approvals`/whitelist semantics for
  push-created repos — none (upstream creates no rules implicitly either; rules
  exist only where an admin created them).

## As-built — M1 (0c33d07, 2026-10-25)

Merge gate: two insertion arms in pulls.ts POST merge mirroring upstream
CheckPullMergeable's order (merge-whitelist 403 after the write check;
`checkPullBranchProtections` 405s after the mergeable precondition, texts
verbatim; `force_merge` only via canBypassBranchProtection — OQ-2 resolved,
the bind was already frozen). Table `protected_branches` (0019): repo_id TEXT
(repo-scoped convention), rule_name/priority, rules JSON under upstream's
exact snake_case keys. Service home `services/branch-protection.ts`: the
glob port (plain-Compile semantics, QuoteMeta fallback, RE2-invalid [] error
path), first-match ordering (priority → plain-before-glob → created), all
M2's push/force/delete predicates pre-ported, `recomputeOfficialForRule`
(the OQ-3 instrument, bounded, wired at M3). Reviews interplay:
isOfficialReviewer's whitelist arm (admin-off-whitelist NOT official —
upstream-verbatim), official persisted on REQUEST rows, head-push legs
(`markStaleReviewsOnPush` in webhooks-push: content-change detection via
merge-base file diff, stale → dismiss_stale_approvals dismissal with the
fixed comment + num_comments bump → un-stale at the new tip). Deviation:
`syncCommitDivergence` not ported (lazy mergeability re-heals divergence —
documented, revisit if a UI ever renders divergence eagerly).

## As-built — M2 (d7fdc49, 2026-10-25)

The push gate: `validatePush` rides `EngineCallOptions` (the per-call in-process
channel, same discipline as `pusher` — NOT DurableGitOptions, so mirror/import
engines are unenforced by construction and index.ts untouched). OQ-1 decided:
`ClassifiedPushCommand` kinds with force classification by REAL ancestry — one
batched `classifyReceive` DO RPC per push (never per command) walking
isAncestor over lease-staged rows (new tips resolve only post-scan; the hook
sits after-scan-before-finalize, a recorded deviation from the spec's literal
pre-lease placement which cannot classify force). Verdicts are index-aligned
(positional joins — a crafted two-commands-one-ref request can never cross-match);
malformed return or a throwing hook fails CLOSED; per-ref rejection filters the
finalize input (siblings land), all-rejected skips finalize with a full sweep.
Upstream texts verbatim per case + the default-branch-delete absolute arm.
Boundary: D1-resolved forwards only — mirror/import/transitional carry no
callback (proven by test). Signed-commits/protected-files arms not ported
(§6). Verified by check-validate-push.mjs (9) + branch-protection-push.test
(7) + 303-test scoped sweep.
