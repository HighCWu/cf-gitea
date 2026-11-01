/**
 * The repository branches page, `/{owner}/{repo}/branches` — pages wave 16
 * (SPEC-0008 U3 extension; upstream templates/repo/branch/list.tmpl at the
 * pin, routers/web/repo/branch.go Branches + DeleteBranchPost, and the
 * /branches/delete route shape web.go:1478-1482 `m.Post("/delete",
 * repo.DeleteBranchPost)`). The wave-branches-reductions pass renders the
 * now-renderable reductions the wave-61 audit flagged: the writer's
 * create/rename forms, the PR column, and the info-line glyph (below).
 *
 * ## DOM contract (list.tmpl at the pin)
 *
 * pageClass is the template's literal `ui repository branches`. The two
 * attached sections: the Default Branch section (the h4 header — with the
 * admin's Switch Default Branch link onto the landed `/settings/branches`
 * page — then either the `branches-default-branch-list` table or the
 * `branches-default-branch-not-exist` segment) and the Branches section (the
 * h4 header, the shared/search/combo GET form, the branch table, base/
 * paginate). Per-row: the name link onto the `/src/branch/{name}` tree, the
 * `p.info` last-commit line (the octicon-git-commit mark · ShortSha link
 * onto `/commit/{oid}` · subject · "Updated" TimeSince · author), the
 * `.commit-divergence` bar pair with the commits_divergence_from /
 * commits_no_divergence tooltips, the PR cell (its section below), and the
 * actions cell (the writer's create/rename forms + the delete button — the
 * section below). The bars'
 * widths use upstream's Eval formula (100·count/(behind+ahead)); the 0/0 NaN
 * the template knowingly renders is replaced with 0% (an honest
 * improvement, not a fidelity break — nothing reads the value).
 *
 * ## The DEFAULT badge (the brief's explicit marker)
 *
 * Upstream marks the default branch through the separate section header
 * alone (the list table excludes it — LoadBranches' ExcludeBranchNames).
 * The default section's row additionally renders a small `ui basic label`
 * reading "Default" — a cf-gitea addition the wave brief pins explicitly;
 * everything else about the row is the template's.
 *
 * ## The protection badge — UI-15's skip, now with its consumer
 *
 * Wave 15 landed the branch render extras (SPEC-0013 §3.6:
 * `protected`/`effective_branch_protection_name`/`user_can_push` on the API
 * LIST/GET payloads) and honestly skipped the list.tmpl badge — no page
 * consumed them. This page is the consumer: every row whose first-match
 * rule governs it (GetFirstMatchProtectedBranchRule's port over
 * listRepoRules + compileRuleName/ruleMatches) renders the
 * `octicon-shield-lock` glyph (newly allowlisted for this wave) with the
 * template's `repo.settings.protected_branch` tooltip, plus the rule's name
 * as a tiny label (the brief's addition — upstream shows the glyph alone;
 * the settings panel is the rule-name surface). `protected` is
 * viewer-independent; `user_can_push` rides the session viewer.
 *
 * ## Delete buttons — upstream's CanDelete list rules, cited
 *
 * The per-row delete button renders exactly when upstream's list renders
 * `.CanDelete` (services/repository/branch.go loadOneBranch):
 *
 *     canDelete := !IsDeleted && DefaultBranch != name && pullRequestTargetBranch != name
 *     if isProtected && canDelete { canDelete = canDelete && rule.CanUserDelete(...) }
 *
 * reduced to the landed model: live rows only (`!IsDeleted` — the loader's
 * deleted arm renders its own rows, the deleted-branches section below),
 * and GetPullRequestTargetBranch folds to the default branch for a
 * same-repo target, so the first two arms are one `name != defaultBranch`
 * check. `rule.CanUserDelete` is the LANDED port (`canUserDelete`,
 * services/branch-protection.ts — write access + the rule's deletion arm +
 * the push predicate + the deletion allowlist). The button posts to this
 * page's own POST arm (below), the confirm modal reduced to a direct form
 * (the wave-15 rules-list delete precedent).
 *
 * ## The delete write — the landed API DELETE arm's steps + the M2 predicate
 *
 * POST /{owner}/{repo}/branches/delete (`name` as the form field — upstream
 * carries it on the query string; Go's FormString reads both) re-plays
 * routes/branches.ts's repoDeleteBranch handler in its order — the archived
 * and empty refusals (404 shells, RepoMustNotBeArchived/MustBeNotEmpty's UI
 * posture), the default-branch refusal, the ref-tip lookup (missing → the
 * 404 shell, the arm's declared 404), the `deleteApiRef` CAS landing, and
 * the `delete` ref webhook fan-out (DeleteRef payload verbatim, the queue
 * producer riding waitUntil) — PLUS the M2 deletion predicate the API arm
 * predates (SPEC-0013's gate refuses protected deletes at push time via the
 * same `canUserDelete`; the API DELETE arm was SPEC-0004 and carries no rule
 * check — an open issue for the API surface's owner). The UI arm refuses a
 * delete whose predicate fails, so the render gate and the write seam can
 * never disagree: no protection-defeating path exists through this surface.
 *
 * Outcomes 303 back onto the list with the flash in display-only params (no
 * session-flash plumbing — the wave-15 `?rule_name=` reduction), carrying
 * upstream DeleteBranchPost's exact JSONError/Success texts:
 * `repo.branch.deletion_success` / `default_deletion_failed` /
 * `protected_deletion_failed` / `deletion_failed`.
 *
 * ## The deleted-branch rows + the restore POST — census gap #10(a):
 *    the recorded REDUCTION's 3-step reopen trigger, gone REAL
 *
 * Upstream's deleted-branch substrate is NOT a separate table: the `branch`
 * table keeps EVERY branch ever seen and a web/API delete only FLAGS the
 * row (`MarkBranchAsDeleted`, models/git/branch.go:254-269 — `is_deleted=
 * true, deleted_by_id, deleted_unix`, the name/CommitID columns untouched:
 * the sha survives with the row; every live-branch read filters
 * `is_deleted=false`, and the list order is `is_deleted ASC, commit_time
 * DESC, name ASC` — branch_list.go:96, deleted rows sort last). The page
 * renders flagged rows in the SAME table (list.tmpl:93-99: a plain-text
 * name — no tree link, the ref is gone — the copy button, and a
 * `Deleted by {user} {TimeSince}` info line in place of the commit line)
 * and offers its writer the restore control (list.tmpl:195-204,
 * `restore-branch-button`, `octicon-reply`, non-protected deleted rows
 * only) posting web.go:1485's `m.Post("/restore",
 * repo.RestoreBranchPost)` under the web.go:1484-1489 group's gates
 * (`RepoMustNotBeArchived, reqRepoCodeWriter, MustBeNotEmpty`).
 * `RestoreBranchPost` (routers/web/repo/branch.go:108-135): form
 * `branch_id` → `GetDeletedBranchByID` (models/git/branch.go:209-217 — id
 * + repo_id + is_deleted, else ErrBranchNotExist → JSONErrorAuto) →
 * `PushManaged` with `Branch: "{CommitID}:refs/heads/{Name}"` — the push
 * restoring the ref AT THE RECORDED SHA; a push error containing "already
 * exists" flashes `repo.branch.already_exists`, any other failure
 * `repo.branch.restore_failed`, success re-synthesizes the push update
 * (empty OldCommitID → the sha as NewCommitID) and flashes
 * `repo.branch.restore_success`.
 *
 * This backend kept NO such substrate — a deleted branch was unrecoverable
 * BY CONSTRUCTION (the reduction the branches.tsx header adjudicated and
 * 70d4220 pinned). Migration 0059 landed the substrate table
 * (`deleted_branches` — upstream's column subset, unique (repo_id, name),
 * the schema doc's contract: the delete arm writes the row PRE-CAS so the
 * sha survives the ref deletion; a re-delete of the same name overwrites),
 * and the recorded 3-step reopen trigger is now REAL, in the trigger's own
 * order:
 *
 * (1) DONE — `applyBranchDelete` writes the row PRE-CAS (below, step 4.5):
 *     the tip sha comes off the same listRefs snapshot the CAS base reads,
 *     the actor + unix-second stamp ride along, the upsert overwrites on
 *     re-delete;
 * (2) DONE — the loader's `loadDeletedBranches` arm + the list.tmpl:93-99
 *     deleted-row render (plain-text name — no tree link, the Deleted-by
 *     info line, the PR cell reusing the live row's arms with the nil-
 *     divergence posture, the ungated RSS anchor) + list.tmpl:195-204's
 *     restore form (the no-JS direct-POST reduction like the delete
 *     button; writer + non-protected);
 * (3) the restore POST — the MODULE is landed (pages/branch-restore.ts:
 *     `applyBranchRestore` replaying PushManaged as
 *     `commitApiChange({ref: "refs/heads/{name}", expectedOldOid:
 *     ZERO_OID, newOid: sha})` + the create-event webhook (the API
 *     create's payload shape) with the already_exists / restore_failed /
 *     restore_success flash arms carried by this page's BranchesFlash from
 *     the delete arm's display-param convention (`?restored=` /
 *     `?restore_error=&name=`).
 *
 * **ROUTE-SEAM HANDOFF (the orchestrator's fold window — ui/index.ts is
 * NOT this unit's file):** the POST tail needs three index.ts hunks, all
 * replaying landed shapes:
 *   a. parseUiRoute's `head === "branches"` block lifts the `/restore`
 *      literal out of the unclaimed set: `if (rest.length === 1 &&
 *      rest[0] === "restore") return { family: "branch-restore", owner,
 *      repo };` (add `"branch-restore"` to the BranchesRoute family union —
 *      upstream web.go:1485, inside the 1484-1489 group);
 *   b. register the POST handler beside branchDeleteSubmit with the group's
 *      middlewares posture (sameOriginGuard → resolveUiRequest → anonymous
 *      loginRedirect → archived/empty 404 shells → form read → doer row →
 *      findRepositoryById → applyBranchRestore); outcomes: `missing` → the
 *      404 shell, `restored` → 303 `?restored={name}`, `already-exists` →
 *      303 `?restore_error=already_exists&name={name}`,
 *      `refused-protected`/`failed` → 303
 *      `?restore_error=failed&name={name}` (upstream's protected-name push
 *      refusal lands in the restore_failed arm — no dedicated flash key);
 *   c. the branches GET handler passes the two new display params into
 *      renderBranchesPage's flash: `restored:
 *      url.searchParams.get("restored"), restoreError:
 *      url.searchParams.get("restore_error")` (the props are OPTIONAL —
 *      the current call site compiles unchanged, the two-stage convention).
 * Until the fold, `/branches/restore` stays engine-owned (the matrix's
 * documented arm holds) and the restore flashes render only from direct
 * GET params — the render half is fully live.
 *
 * The loader's deleted arm filters rows whose name carries a LIVE ref
 * again: upstream's push pipeline un-flags the branch row on every push
 * (the sync upserts is_deleted=false), so ANY path that revives the name —
 * our restore POST, a plain git push of the same name — makes the flagged
 * row stop rendering; the engine-universe check answers all of them at
 * once. The row itself survives (invisible; a re-delete overwrites it —
 * the schema's upsert contract).
 *
 * ## The writer block — create + rename (two-stage; POST arms mounted)
 *
 * Upstream's default-section and per-row actions render under `and $.IsWriter
 * $.Repository.CanContentChange (not .IsDeleted)` (list.tmpl:34,56,163,185):
 * reduced here to the loader's write grant (principalAccessOfRow's write —
 * IsWriter's CanWrite(TypeCode)) plus `!repo.isArchived` (CanContentChange;
 * no mirror column is landed). Live rows get the create/rename pair;
 * deleted rows get the restore control instead (the same gate plus the
 * non-protected arm — list.tmpl:195's `{{if not .IsProtected}}`). Each
 * modal button is
 * reduced to an inline no-JS
 * form carrying upstream's EXACT route and fields, so the mount wave can
 * serve them verbatim:
 *
 * - create: POST `/{owner}/{repo}/branches/_new/branch/{from}` with the
 *   required `new_branch_name` (web.go:1477-1481's `m.Group("/_new")` +
 *   forms/repo_branch_form.go NewBranchForm; the octicon-git-branch glyph
 *   — newly allowlisted — and the `repo.branch.new_branch_from` tooltip are
 *   the template's, list.tmpl:35-42,164-171);
 * - rename: POST `/{owner}/{repo}/branches/rename` with `from` (hidden) +
 *   `to` (required; left empty like upstream's modal — web_src/js/features/
 *   repo-branch.ts prefills only `from`) (web.go:1486 + RenameBranchForm).
 *
 * **MOUNTED (w129 batch-14 sweep — this paragraph was the two-stage
 * HANDOFF):** the two POST arms went live in `src/ui/index.ts` with the
 * window-2e folds (635ce2e — "the branches writer forms' POST arms"), which
 * carried the group middlewares' posture (writer grant +
 * RepoMustNotBeArchived + MustBeNotEmpty) and replayed the landed API
 * create/rename ops (routes/branches.ts POST/PATCH) the way applyBranchDelete
 * replays repoDeleteBranch. The module kept the sibling two-stage-unmounted
 * convention (the settings modules, 46230c8..fbbc05b) on its way there:
 * render + upstream contract first, write arm second.
 *
 * ## The PR column (list.tmpl's third cell, `three wide tw-text-right`)
 *
 * loadOneBranch's pull-request shape (services/repository/branch.go:219-270)
 * over the landed rows: `latestPr` is GetLatestPullRequestByHeadInfo's port
 * (models/issues/pull.go:525-535 — head_repo_id + head_branch + github
 * flow, latest by id; ONE joined D1 walk per request, not per branch)
 * reduced to what the column renders — the shared issue index, hasMerged,
 * the joined issue's isClosed, and MergeMovedOn (branch.go:240-252: the
 * merged pull head's tip — `refs/pull/N/head` — exists and differs from the
 * branch tip; pulled off the SAME listRefs snapshot the page already
 * loaded, so the check costs one map lookup). The cell plays the template's
 * four arms (list.tmpl:110-155): no PR + IsIncluded (ahead == 0 — the
 * already-loaded divergence) → the orange Included label with the
 * `repo.branch.included_desc` tooltip; no PR + AllowsPulls + ahead > 0 →
 * the compare button (allowsPulls = `repoSettings.hasPullRequests`,
 * DEFAULT_REPO_SETTINGS's default — upstream's Repository.AllowsPulls minus
 * the mirror arm, no mirror column landed); merged + MergeMovedOn → the
 * compare button; otherwise the `#N` link onto the landed
 * `/{owner}/{repo}/pulls/{index}` page plus the Merged/Closed/Open state
 * label (octicon-git-merge / -pull-request-closed / -pull-request, all
 * allowlisted). The compare link is compareLink(default, branch) +
 * `?expand=1` (MakeDefaultCompareLink's same-repo shape,
 * services/context/repo.go:83-87); its label is CanPull's —
 * CanWrite(TypeCode) || HasForkedRepo (routers/web/repo/branch.go:43-44),
 * and forks cannot exist yet, so the loader's write grant answers it
 * ("New Pull Request" vs "Compare").
 *
 * ## Reads consumed vs degraded
 *
 * - `listRefs()` — the branch universe AND the tip map the MergeMovedOn
 *   check reads; `readCommit()` additionally runs for every FILTERED branch
 *   (the sort key — the order section above), the rendered slice reusing
 *   the pre-read commits for its info line.
 * - `readCommit(branch)` — the last-commit line per rendered row (page
 *   slice only); a failed read skips the line, never the row.
 * - `countDivergence(default, branch)` — the ahead/behind pair (SPEC-0001b
 *   §4.1's one-walk rev-list; upstream GetDivergingCommits' shape). A
 *   `missing`/failed read renders an empty divergence cell — upstream
 *   renders -1/-1 there; the honest absence beats a negative count. The
 *   same -1 posture answers the PR cell: a degraded divergence is never
 *   "included" and never a compare button (upstream's -1 arms).
 * - D1: `listRepoRules` once + `principalAccessOfRow` once per request (the
 *   API LIST's loadBranchProtectionContext composition), `loadRepoSettings`
 *   once (AllowsPulls), and the latest-PR walk once (headRepoId +
 *   github-flow joined to its issue — GetLatestPullRequestByHeadInfo
 *   reduced from per-branch queries to one ordered scan); per-branch
 *   predicates only for the rendered slice.
 *
 * ## Reductions (documented divergences)
 *
 * - The Download / RSS buttons (upstream's EnableFeed /
 *   DisableDownloadSourceArchives block, list.tmpl:44-52/:173-181) stay
 *   unrendered: the per-branch RSS feed MODULE is landed
 *   (pages/branch-feed-xml.ts — census gap #10(b), both envelopes) but its
 *   route seam is the orchestrator's fold (the module doc's route-seam
 *   HANDOFF carries the recipe), and until that mount the anchor would
 *   target a 404 (the dead-link rule); the w129 batch-14 absence pin
 *   (branches.matrix.test.tsx) flips with the fold. The archive half's
 *   premise is stale — the web-shape archive endpoint IS landed
 *   (wave-ui-parity-6's `/archive/{ref}.{format}`, branches resolve), so
 *   the unrendered dropdown is this page's own open parity row, not a
 *   dead-link arm.
 * - The per-name copy-to-clipboard button (list.tmpl's octicon-copy
 *   `data-clipboard-text` control) stays unrendered — a JS clipboard
 *   control with no no-JS posture.
 * - The Switch Default Branch link renders for ADMIN viewers, not upstream's
 *   `IsWriter` — the settings page it targets is admin-gated here, and a
 *   link a writer follows into a 404 would break the dead-link rule.
 * - The search combo filters the ref universe by case-insensitive substring
 *   (upstream's SQL LIKE over the branch table — the engine keeps no branch
 *   rows); the default-branch section is unaffected, like upstream's
 *   separate GetBranchExisting read.
 * - The last-commit line renders the commit AUTHOR as plain text (the
 *   commit-list reduction): refs carry no pusher tracking, and avatar
 *   pipelines do not exist. The line's leading `octicon-git-commit` glyph
 *   IS rendered — the releases wave granted the glyph, superseding this
 *   page's wave-16 refusal (the wave-61 audit's allowlist note was already
 *   answered; the actually-missing glyph was the create button's
 *   octicon-git-branch, allowlisted this pass).
 * - The PR link carries no cross-repo prefix (upstream's
 *   `{{if not .LatestPullRequest.IsSameRepo}}` FullName arm): forks cannot
 *   exist yet, so every latest PR is same-repo.
 */

import type { CommitJson } from "@cf-gitea/git-engine";
import { and, asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { branchRef, engineCell, engineReads, refTipMap, type EngineDivergenceResult } from "../../api/services/engine";
import { pullHeadRefName } from "../../api/services/pulls";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { apiUserFromRow, toApiRepository, type RepositoryWithOwner, type UserRow } from "../../api/services/repository";
import { deletedBranches, issues, PRFlow, pullRequests, users } from "../../db/schema";
import { emitWebhookDeliveries } from "../../issues/webhooks";
import {
  canUserDelete,
  canUserPush,
  compileRuleName,
  listRepoRules,
  parseRuleConfig,
  principalAccessOfRow,
  ruleMatches,
  type ProtectedBranchConfig,
  type ProtectedBranchRow,
} from "../../services/branch-protection";
import type { WebhookDeliveryMessage } from "../../webhooks/consumer";
import { compareLink } from "./compare";
import { ExploreSearchForm } from "./explore";
import { TimeSince } from "../components/file-list";
import { commitLink, treeLink } from "../links";
import { pathEscapeSegments, shortSha } from "../page-data";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";

/** Page chrome text (the branchProtectionLocale pattern; upstream locale
 *  keys cited, cf-gitea additions marked). */
export const branchesLocale = {
  page_title: "Branches", // "repo.branches"
  default_branch: "Default Branch", // "repo.default_branch"
  default_badge: "Default", // cf-gitea addition — the brief's DEFAULT badge (upstream marks the default through the section header alone)
  branches: "Branches", // "repo.branches"
  search_placeholder: "Search branches…", // "search.branch_kind"
  switch_default_branch: "Switch Default Branch", // "repo.settings.branches.switch_default_branch" (the link renders as its title text — the icon-reduction precedent)
  protected_branch: "Branch Protection", // "repo.settings.protected_branch" (the shield's tooltip)
  updated: "Updated", // "org.repo_updated"
  new_branch_from: (from: string): string => `Create new branch from "${from}"`, // "repo.branch.new_branch_from" (the create button's tooltip)
  branch_name: "Branch Name", // "repo.branch.name" (the create form's input label)
  rename_branch: (name: string): string => `Rename Branch "${name}"`, // "repo.branch.rename" (the rename button's tooltip)
  rename_to: (name: string): string => `Rename "${name}" to:`, // "repo.branch.rename_branch_to" (the rename input's label)
  rss_feed: "RSS Feed", // "rss_feed" (the per-branch feed anchor's tooltip, list.tmpl:44-45)
  included: "Included", // "repo.branch.included"
  included_desc: "This branch is part of the default branch", // "repo.branch.included_desc" (the Included label's tooltip)
  compare_changes: "New Pull Request", // "repo.pulls.compare_changes" (the compare button, CanPull viewers)
  compare_branch: "Compare", // "action.compare_branch" (the compare button, everyone else)
  merged: "Merged", // "repo.pulls.merged"
  open_title: "Open", // "repo.issues.open_title"
  closed_title: "Closed", // "repo.issues.closed_title"
  divergence_from: (behind: number, ahead: number, base: string): string =>
    `Commit divergence: ${behind} behind and ${ahead} ahead of ${base}`, // "repo.branch.commits_divergence_from"
  divergence_none: (base: string): string => `The same as branch ${base}`, // "repo.branch.commits_no_divergence"
  delete_branch_aria: (name: string): string => `Delete Branch "${name}"`, // "repo.branch.delete"
  default_branch_not_exist: (name: string): string => `Default branch "${name}" does not exist.`, // "repo.branch.default_branch_not_exist"
  deletion_success: (name: string): string => `Branch "${name}" has been deleted.`, // "repo.branch.deletion_success"
  deletion_failed: (name: string): string => `Failed to delete branch "${name}".`, // "repo.branch.deletion_failed"
  default_deletion_failed: (name: string): string =>
    `Branch "${name}" is the default or pull request target branch. It cannot be deleted.`, // "repo.branch.default_deletion_failed"
  protected_deletion_failed: (name: string): string => `Branch "${name}" is protected. It cannot be deleted.`, // "repo.branch.protected_deletion_failed"
  deleted_by: (user: string): string => `Deleted by ${user}`, // "repo.branch.deleted_by" (the deleted-row info line's leading text; the template appends the TimeSince node)
  restore_branch_aria: (name: string): string => `Restore Branch "${name}"`, // "repo.branch.restore" (the restore button's tooltip)
  restore_success: (name: string): string => `Branch "${name}" has been restored.`, // "repo.branch.restore_success"
  restore_failed: (name: string): string => `Failed to restore branch "${name}".`, // "repo.branch.restore_failed"
  already_exists: (name: string): string => `A branch named "${name}" already exists.`, // "repo.branch.already_exists"
} as const;

/** Upstream `setting.Git.BranchesRangeSize` (modules/setting/git.go:45). */
export const BRANCHES_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Data loading (§3.2 — the landed reads, never a self-fetch)
// ---------------------------------------------------------------------------

// ## The list ORDER — upstream's default `commit_time DESC, name ASC`
//
// The webui-parity brief asked for a sort control ("default / updated /
// oldest / newest / completed"); NO such control exists at the pin, and the
// upstream-parity rule (AGENTS.md) binds the page to the pin's actual
// shape: the Branches arm reads only `q` and `page`
// (routers/web/repo/branch.go:48-53), the template renders the search combo
// alone (templates/repo/branch/list.tmpl:82-86), and NO caller in the pin
// ever sets `FindBranchOptions.OrderBy` — the branch_list order is
// `ToOrders()`' default `commit_time DESC, name ASC` for every surface that
// lists branches (models/git/branch_list.go:89-99 — "the commit_time might
// be the same, so add the 'name' to make sure the order is stable"). The
// key is the tip commit's COMMITTER time (Branch.CommitTime =
// commit.Committer.When.Unix(), models/git/branch.go:248 — the same stamp
// the info line renders). Upstream orders its branch DB TABLE; the engine
// keeps no branch rows, so the loader reads every filtered branch's tip
// commit (the sort key's only source) and sorts the page universe before
// slicing — `Array.prototype.sort` stability is irrelevant (the comparator
// is total: unique names break every time tie). A degraded tip read sorts
// as time 0, i.e. LAST (upstream's zero-value CommitTime arm; the
// branches-list-aux sibling keeps its own byte-order tail as a documented
// divergence — a name feed has no call for N tip reads).

/** The PR column's LatestPullRequest summary (loadOneBranch's shape reduced
 *  to what the cell renders — the module header's PR-column section). */
export interface BranchLatestPr {
  /** The shared per-repo issue index (the `#N` link and the page target). */
  index: number;
  hasMerged: boolean;
  /** The joined issue's state (upstream pr.Issue.IsClosed). */
  isClosed: boolean;
  /** upstream MergeMovedOn (branch.go:240-252): the merged pull head
   *  (`refs/pull/N/head`) exists and differs from the branch tip — the
   *  compare-button arm instead of the Merged label. */
  mergeMovedOn: boolean;
}

/** One rendered branch row: the name, the SPEC-0013 §3.6 render extras this
 *  page consumes (the badge + the writer's gates), the last commit and the
 *  divergence pair — both `null` when their read degraded (§4.9: unreadable
 *  storage must not break the page). */
export interface BranchRowView {
  name: string;
  /** The first-match rule governs the branch (viewer-independent). */
  isProtected: boolean;
  /** The matched rule's name; "" when unprotected (the extras' convention). */
  ruleName: string;
  /** The doer's push answer (no rule → the plain write grant; a rule →
   *  canUserPush) — the API LIST's `user_can_push`. */
  userCanPush: boolean;
  /** Upstream loadOneBranch's CanDelete (the module header cites the arms):
   *  not the default branch, the writer grant, and — protected — the rule's
   *  canUserDelete. Drives the delete button on BOTH sides (render + write). */
  canDelete: boolean;
  /** The tip commit (the last-commit line); null = degraded read. */
  commit: CommitJson | null;
  /** The divergence vs the default branch; null = degraded/missing read. */
  divergence: { ahead: number; behind: number } | null;
  /** GetLatestPullRequestByHeadInfo's port (the header's PR-column
   *  section); null = no PR heads here. */
  latestPr: BranchLatestPr | null;
}

/** One rendered DELETED-branch row (list.tmpl:93-99/:195-204's shape over
 *  migration 0059's deleted_branches substrate): the recorded id (the
 *  restore form's `branch_id`), the plain-text name, the recorded sha
 *  (never rendered — the restore POST's source), the actor + deletion
 *  stamp (the info line), the first-match protection answer (the restore
 *  control's non-protected gate) and the PR-column row (the same
 *  GetLatestPullRequestByHeadInfo scan the live rows share — a deleted
 *  name can still carry one; MergeMovedOn reads the STORED sha, upstream
 *  loadOneBranch's `headCommit := dbBranch.CommitID`). */
export interface BranchDeletedRowView {
  id: number;
  name: string;
  commitId: string;
  /** The actor's username (the users join; "unknown" if the row vanished —
   *  the template renders DeletedBy.Name unconditionally). */
  deletedByName: string;
  deletedUnix: number;
  /** First-match rule governs the NAME (viewer-independent) — hides the
   *  restore control (list.tmpl's `{{if not .IsProtected}}`). */
  isProtected: boolean;
  latestPr: BranchLatestPr | null;
}

/** The page's render inputs, loaded by loadBranchesData. */
export interface BranchesData {
  keyword: string;
  page: number;
  /** The pager's Older flag (the commits-list convention: filtered count
   *  beyond the fetched page). */
  more: boolean;
  /** The default branch's short name (the §4.9 fallbacks applied); null =
   *  unborn/unresolvable — the not-exist segment renders instead. */
  defaultBranch: string | null;
  /** The default section's extras (the badge row needs them like any row). */
  defaultIsProtected: boolean;
  defaultRuleName: string;
  defaultCommit: CommitJson | null;
  /** The viewer's write grant (principalAccessOfRow's write — upstream
   *  IsWriter's CanWrite(TypeCode); also CanPull's answer, forks cannot
   *  exist yet). Gates the writer create/rename forms and the compare
   *  button's label. */
  canWrite: boolean;
  /** `repoSettings.hasPullRequests` (the DEFAULT_REPO_SETTINGS default when
   *  no row exists) — upstream AllowsPulls minus the mirror arm. */
  allowsPulls: boolean;
  /** The list table's live rows (the default branch excluded — upstream
   *  ExcludeBranchNames), keyword-filtered, one page (the deleted rows
   *  below sort after them — upstream's `is_deleted ASC` primary key). */
  rows: BranchRowView[];
  /** The list table's deleted rows (list.tmpl's IsDeleted arm), keyword-
   *  filtered, the page slice's tail, names carrying a live ref again
   *  excluded (upstream's push-sync un-flag; the module header). */
  deletedRows: BranchDeletedRowView[];
}

/** The page doer's protection-context identity (anonymous → the all-false
 *  access — principalAccessOfRow's null arm). */
export function protectionDoer(viewer: Viewer): { id: number; username: string; isAdmin: boolean } | null {
  return viewer.kind === "user" ? { id: viewer.id, username: viewer.username, isAdmin: viewer.isAdmin } : null;
}

/** GetFirstMatchProtectedBranchRule's port over the request-loaded rules
 *  (routes/branches.ts firstMatchRule — the same per-branch half without
 *  re-reading D1). */
export function firstMatchRule(
  rules: readonly ProtectedBranchRow[],
  branchName: string,
): ProtectedBranchRow | null {
  for (const rule of rules) {
    if (ruleMatches(compileRuleName(rule.ruleName), branchName)) return rule;
  }
  return null;
}

/** One branch's render extras (the API LIST's branchRenderExtras reduced to
 *  what this page renders) plus the delete gate. `configOut` receives the
 *  matched rule's parsed config for the delete predicate below. */
async function rowExtras(
  db: D1Database,
  rules: readonly ProtectedBranchRow[],
  access: { userId: number; write: boolean; admin: boolean },
  branchName: string,
  isDefault: boolean,
): Promise<Pick<BranchRowView, "isProtected" | "ruleName" | "userCanPush" | "canDelete">> {
  const rule = firstMatchRule(rules, branchName);
  if (rule === null) {
    return {
      isProtected: false,
      ruleName: "",
      userCanPush: access.write,
      // Unprotected: upstream's non-rule arm — writer + not-default only.
      canDelete: !isDefault && access.write,
    };
  }
  const config: ProtectedBranchConfig = parseRuleConfig(rule.rules);
  return {
    isProtected: true,
    ruleName: rule.ruleName,
    userCanPush: await canUserPush(db, config, access),
    // Protected: && the rule's CanUserDelete (the M2 gate's own predicate).
    canDelete: !isDefault && access.write && (await canUserDelete(db, config, access)),
  };
}

/**
 * Load the page. Never 404s: an unborn/unreadable repo renders the
 * not-exist segment and an empty list (upstream's MustBeNotEmpty-free GET —
 * the delete POST group carries the gate, not the page).
 */
export async function loadBranchesData(
  env: Env,
  db: D1Database,
  repo: RepoRow,
  options: { page: number; keyword: string; viewer: Viewer },
): Promise<BranchesData> {
  const reads = engineReads(env, repo);
  const refs = await reads.listRefs();
  // The ref universe: refs/heads/ filtered (byte order — the input order;
  // the RENDER order is the tip-time sort below).
  const branchNames = (refs?.refs ?? [])
    .filter((ref) => ref.name.startsWith("refs/heads/"))
    .map((ref) => ref.name.slice("refs/heads/".length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // The full-ref tip map off the SAME snapshot — the MergeMovedOn check
  // reads `refs/pull/N/head` from it (the header's PR-column section).
  const tips = refTipMap(refs);

  // The §4.9 default-branch fallbacks (the ref-suffix resolver's convention):
  // the D1 default branch when it exists, else the first branch, else null.
  const defaultBranch = branchNames.includes(repo.defaultBranch) ? repo.defaultBranch : (branchNames[0] ?? null);

  // The protection context (the API LIST's loadBranchProtectionContext
  // composition): rules once, the doer's access pair once — plus the
  // AllowsPulls read, the latest-PR walk and the deleted-branch read (the
  // migration-0059 substrate — one ordered scan with its actor join), also
  // once per request.
  const [rules, access, settings, prRows, deletedRaw] = await Promise.all([
    listRepoRules(db, repo.id),
    principalAccessOfRow(db, repo, protectionDoer(options.viewer)),
    loadRepoSettings(db, repo.id),
    drizzle(db)
      .select({ pr: pullRequests, isClosed: issues.isClosed })
      .from(pullRequests)
      .innerJoin(issues, eq(issues.id, pullRequests.issueId))
      .where(and(eq(pullRequests.headRepoId, repo.id), eq(pullRequests.flow, PRFlow.Github)))
      .orderBy(asc(pullRequests.id)),
    // loadDeletedBranches' port over the substrate: the repo's flagged rows
    // with their actor's username. Upstream orders the combined list
    // `is_deleted ASC, commit_time DESC, name ASC` (branch_list.go:96 — the
    // flagged rows sort last); our table carries no commit_time (upstream's
    // flagged row keeps its branch's commit_time — the one column the
    // subset drops), so the deletion stamp orders them among themselves:
    // `deleted_unix DESC, name ASC` — the documented divergence.
    drizzle(db)
      .select({ row: deletedBranches, deletedByName: users.username })
      .from(deletedBranches)
      .leftJoin(users, eq(users.id, deletedBranches.deletedById))
      .where(eq(deletedBranches.repoId, repo.id))
      .orderBy(desc(deletedBranches.deletedUnix), asc(deletedBranches.name)),
  ]);

  // GetLatestPullRequestByHeadInfo's reduction: the scan is id-ordered, so
  // the LAST row per head branch is the latest (upstream's `OrderBy id DESC
  // LIMIT 1` per branch — one walk instead of one query per branch).
  const latestPrByBranch = new Map<string, BranchLatestPr>();
  for (const { pr, isClosed } of prRows) {
    const branchTip = tips.get(branchRef(pr.headBranch))?.target;
    const pullHeadTip = pr.hasMerged ? tips.get(pullHeadRefName(pr.index))?.target : undefined;
    latestPrByBranch.set(pr.headBranch, {
      index: pr.index,
      hasMerged: pr.hasMerged,
      isClosed,
      // MergeMovedOn's exact arms (branch.go:249-252): the pull head ref
      // must EXIST and differ — a missing ref never moves on.
      mergeMovedOn: pr.hasMerged && pullHeadTip !== undefined && pullHeadTip !== branchTip,
    });
  }

  const defaultExtras =
    defaultBranch !== null ? await rowExtras(db, rules, access, defaultBranch, true) : null;
  const defaultCommit = defaultBranch !== null ? await reads.readCommit(defaultBranch) : null;

  // The keyword filter (case-insensitive substring — the search combo's
  // honest stand-in for upstream's SQL LIKE) over the non-default universe
  // AND the deleted rows (upstream's LIKE runs over the flagged rows too).
  const needle = options.keyword.trim().toLowerCase();
  const others = branchNames.filter((name) => name !== defaultBranch);
  const filtered = needle === "" ? others : others.filter((name) => name.toLowerCase().includes(needle));
  // The deleted rows whose name carries a LIVE ref again stop rendering —
  // upstream's push-sync un-flag arm (the module header): our restore POST
  // and a plain git push of the same name both revive the ref, and the
  // engine snapshot already holds every live name.
  const deletedRows: BranchDeletedRowView[] = deletedRaw
    .filter((entry) => !tips.has(branchRef(entry.row.name)))
    .filter((entry) => needle === "" || entry.row.name.toLowerCase().includes(needle))
    .map((entry) => {
      const rule = firstMatchRule(rules, entry.row.name);
      const pr = latestPrByBranch.get(entry.row.name) ?? null;
      // MergeMovedOn reads the STORED sha for a deleted name (upstream's
      // `headCommit := dbBranch.CommitID` — the ref is gone, the row's
      // CommitID is the only head): the pull head must exist and differ
      // from the recorded sha.
      const pullHeadTip = pr !== null && pr.hasMerged ? tips.get(pullHeadRefName(pr.index))?.target : undefined;
      return {
        id: entry.row.id,
        name: entry.row.name,
        commitId: entry.row.commitId,
        deletedByName: entry.deletedByName ?? "unknown",
        deletedUnix: entry.row.deletedUnix,
        isProtected: rule !== null,
        latestPr: pr === null ? null : { ...pr, mergeMovedOn: pr.hasMerged && pullHeadTip !== undefined && pullHeadTip !== entry.row.commitId },
      };
    });

  // The tip-commit read over the WHOLE filtered universe — the sort key's
  // data (upstream orders its branch TABLE by the stored commit_time; the
  // engine keeps no branch rows, so the tip read is the only source). The
  // rendered slice's info line reuses these commits — no re-read.
  const filteredTips = await Promise.all(
    filtered.map(async (name) => ({ name, commit: await reads.readCommit(name) })),
  );
  // The upstream default order — `FindBranchOptions.ToOrders()` with no
  // OrderBy set (models/git/branch_list.go:89-99, the web arm's only order):
  // `commit_time DESC, name ASC` — "the commit_time might be the same, so
  // add the 'name' to make sure the order is stable" (:92-93). CommitTime is
  // the tip commit's COMMITTER time (branch.go:248); a degraded tip read
  // sorts as time 0 (upstream's zero-value CommitTime arm), ties break on
  // the name.
  const ordered = filteredTips.sort(
    (a, b) =>
      (b.commit === null ? 0 : b.commit.committer.time) - (a.commit === null ? 0 : a.commit.committer.time) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );

  // Pagination (§4.11 clamps) over the ordered list with the deleted rows
  // appended (upstream's `is_deleted ASC` primary sort key — branch_list.go:
  // 96, flagged rows sort last, so they land on the last pages); the
  // per-row protection predicates + divergence walks still run for the
  // rendered slice only.
  const page = Math.max(options.page, 1);
  const start = (page - 1) * BRANCHES_PAGE_SIZE;
  type PageEntry = { kind: "live"; name: string; commit: CommitJson | null } | { kind: "deleted"; row: BranchDeletedRowView };
  const pageEntries: PageEntry[] = [
    ...ordered.map((entry) => ({ kind: "live" as const, name: entry.name, commit: entry.commit })),
    ...deletedRows.map((row) => ({ kind: "deleted" as const, row })),
  ];
  const sliced = pageEntries.slice(start, start + BRANCHES_PAGE_SIZE);
  const more = pageEntries.length > start + BRANCHES_PAGE_SIZE;

  const rows = await Promise.all(
    sliced
      .filter((entry): entry is Extract<PageEntry, { kind: "live" }> => entry.kind === "live")
      .map(async (entry): Promise<BranchRowView> => {
        const extras = await rowExtras(db, rules, access, entry.name, false);
        const divergence = await readDivergence(reads, defaultBranch, entry.name);
        return { name: entry.name, commit: entry.commit, divergence, latestPr: latestPrByBranch.get(entry.name) ?? null, ...extras };
      }),
  );
  const pageDeletedRows = sliced
    .filter((entry): entry is Extract<PageEntry, { kind: "deleted" }> => entry.kind === "deleted")
    .map((entry) => entry.row);

  return {
    keyword: options.keyword,
    page,
    more,
    defaultBranch,
    defaultIsProtected: defaultExtras?.isProtected ?? false,
    defaultRuleName: defaultExtras?.ruleName ?? "",
    defaultCommit,
    canWrite: access.write,
    allowsPulls: settings.hasPullRequests,
    rows,
    deletedRows: pageDeletedRows,
  };
}

/** countDivergence(default, branch) — ahead = the branch leads by, behind =
 *  the branch trails by (the engine's rev-list left-right arms; upstream
 *  GetDivergingCommits' order). A missing side or a failed walk → null (the
 *  cell renders empty; upstream renders -1/-1 — the module header). */
async function readDivergence(
  reads: ReturnType<typeof engineReads>,
  defaultBranch: string | null,
  name: string,
): Promise<{ ahead: number; behind: number } | null> {
  if (defaultBranch === null) return null;
  const result: EngineDivergenceResult | null = await reads.countDivergence(defaultBranch, name);
  return result !== null && result.tag === "ok" ? { ahead: result.ahead, behind: result.behind } : null;
}

// ---------------------------------------------------------------------------
// The delete write (the landed API DELETE arm's steps + the M2 predicate —
// module header)
// ---------------------------------------------------------------------------

export type BranchDeleteResult =
  | { outcome: "deleted"; name: string }
  | { outcome: "missing"; name: string } // no tip in this repo → the 404 shell
  | { outcome: "refused-default"; name: string }
  | { outcome: "refused-protected"; name: string }
  | { outcome: "failed"; name: string }; // CAS moved under us → the deletion_failed flash

/** The doer row the webhook sender renders (the handler resolves it once;
 *  a vanished session doer refuses the write like the editor POST). */
export interface BranchDeleteInput {
  pair: RepositoryWithOwner;
  doer: UserRow;
  origin: string;
  /** ctx.waitUntil when a live execution context exists (in-process test
   *  callers settle inline / skip the enqueue — the hooks-route convention). */
  waitUntil: ((promise: Promise<unknown>) => void) | undefined;
}

/**
 * The write, in routes/branches.ts repoDeleteBranch's order (the module
 * header carries the why of the extra predicate arm):
 *
 * 1. default-branch refusal (the arm's exact 403 condition);
 * 2. the writer grant — principalAccessOfRow's write IS the landed
 *    canWriteRepository composition (the render gate's own predicate);
 * 3. the M2 deletion predicate (`canUserDelete`) — the API arm predates
 *    SPEC-0013; the UI never offers a protection-defeating path;
 * 4. the ref-tip lookup (missing → `missing`, the arm's declared 404);
 * 4.5 the deleted_branches row, PRE-CAS (migration 0059 — the schema doc's
 *     contract: the sha survives the ref deletion; the upsert overwrites on
 *     re-delete);
 * 5. the `deleteApiRef` CAS (moved → `failed`; already-gone → the arm's
 *    idempotent-204 arm, answered as `deleted` without an event, exactly
 *    like the route);
 * 6. the `delete` ref webhook fan-out (the route's emitRefWebhook ported:
 *    the DeletePayload verbatim, the queue producer on waitUntil).
 */
export async function applyBranchDelete(
  env: Env,
  repo: RepoRow,
  viewer: Viewer,
  name: string,
  input: BranchDeleteInput,
): Promise<BranchDeleteResult> {
  // 1. The default-branch refusal (upstream CanDeleteBranchWithPermission's
  //    ErrBranchIsDefault arm; the API route's exact 403 condition).
  if (name === repo.defaultBranch) {
    return { outcome: "refused-default", name };
  }
  // 2+3. The writer grant + the protection predicate, over one context load.
  const access = await principalAccessOfRow(env.DB, repo, protectionDoer(viewer));
  if (!access.write) {
    return { outcome: "missing", name }; // the non-writer 404 posture (the handler shells it)
  }
  const rules = await listRepoRules(env.DB, repo.id);
  const rule = firstMatchRule(rules, name);
  if (rule !== null && !(await canUserDelete(env.DB, parseRuleConfig(rule.rules), access))) {
    return { outcome: "refused-protected", name };
  }
  // 4. The tip (the route resolves it off listRefs — one RPC answers
  //    existence AND the CAS base).
  const tips = refTipMap(await engineReads(env, repo).listRefs());
  const tip = tips.get(branchRef(name));
  if (tip === undefined) {
    return { outcome: "missing", name };
  }
  // 4.5 The deleted-branch row, PRE-CAS (migration 0059's substrate — the
  //     schema doc's contract): the restore source survives the ref
  //     deletion because the row lands BEFORE deleteApiRef — a crash or
  //     refusal after this point can lose a delete, never the sha. The
  //     upsert overwrites on re-delete (unique (repo_id, name)); a CAS
  //     failure leaves the row holding the pre-attempt tip — the branch
  //     still lives, so a restore of that row is refused already-exists and
  //     the next delete overwrites it.
  const deletedUnix = Math.floor(Date.now() / 1000);
  await drizzle(env.DB)
    .insert(deletedBranches)
    .values({ repoId: repo.id, name, commitId: tip.target, deletedById: input.doer.id, deletedUnix })
    .onConflictDoUpdate({
      target: [deletedBranches.repoId, deletedBranches.name],
      set: { commitId: tip.target, deletedById: input.doer.id, deletedUnix },
    });
  // 5. The CAS delete (a WRITE RPC — a transport failure propagates, the
  //    honest 500: retryable-unknown state).
  const result = await engineCell(env, input.pair.repo).deleteApiRef({ ref: branchRef(name), expectedOid: tip.target });
  if (result.tag === "invalid") {
    return { outcome: "failed", name };
  }
  if (result.tag === "ref_conflict") {
    return { outcome: "failed", name }; // the ref moved under us — the arm's 409 family
  }
  if (result.tag === "deleted") {
    // 6. The DeleteRef webhook (the route's payload verbatim; failures are
    //    logged, never propagated — a webhook miss cannot fail the write).
    await replayBranchRefWebhook(env, input, "delete", name, undefined);
  }
  // `already-absent` (currentOid null) lands here: the arm answers 204
  // without an event; the flash reads deleted.
  return { outcome: "deleted", name };
}

/** routes/branches.ts emitRefWebhook's port for the branch family's `create`
 *  and `delete` ref events: the upstream DeletePayload (notifier.go:858→:870
 *  — pusher_type "user", ref the SHORT name) and the upstream CreatePayload
 *  (notifier.go:821→:830 — `sha` = the restored/created tip, ref the SHORT
 *  name, NO pusher_type — the API POST arm's exact shape), the delivery rows
 *  INLINE, only the Queue producer hanging off waitUntil when the binding is
 *  wired (the route's structural probe). The restore POST
 *  (pages/branch-restore.ts) replays the create arm. */
export async function replayBranchRefWebhook(
  env: Env,
  input: BranchDeleteInput,
  eventType: "create" | "delete",
  branchName: string,
  sha: string | undefined,
): Promise<void> {
  const queueCandidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  const queue =
    typeof queueCandidate === "object" &&
    queueCandidate !== null &&
    typeof (queueCandidate as { sendBatch?: unknown }).sendBatch === "function"
      ? { sendBatch: (queueCandidate as { sendBatch: (messages: { body: WebhookDeliveryMessage }[]) => Promise<unknown> }).sendBatch.bind(queueCandidate) }
      : null;
  const viewer = { origin: input.origin, requester: apiUserFromRow(input.doer, { origin: input.origin, requester: null }) };
  const payload =
    eventType === "create"
      ? { sha, ref: branchName, ref_type: "branch", repository: toApiRepository(viewer, input.pair), sender: apiUserFromRow(input.doer, viewer) }
      : { ref: branchName, ref_type: "branch", pusher_type: "user", repository: toApiRepository(viewer, input.pair), sender: apiUserFromRow(input.doer, viewer) };
  try {
    await emitWebhookDeliveries(
      env.DB,
      {
        repoId: input.pair.repo.id,
        ownerId: input.pair.repo.ownerId,
        eventType,
        refName: branchRef(branchName),
        payload,
      },
      {
        enqueue:
          queue !== null && input.waitUntil !== undefined
            ? (deliveryIds) => {
                input.waitUntil!(
                  queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(undefined, (error: unknown) => {
                    console.error(`[branches] delivery enqueue failed (${eventType}): ${error instanceof Error ? error.message : String(error)}`);
                  }),
                );
              }
            : undefined,
      },
    );
  } catch (error) {
    console.error(`[branches] webhook fan-out failed (${eventType}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Parse the delete form (the hidden `name` field — trimmed; upstream's
 *  query-string carrier reads through the same Go FormString). */
export function parseBranchDeleteForm(params: URLSearchParams): string {
  return (params.get("name") ?? "").trim();
}

// ---------------------------------------------------------------------------
// Components (list.tmpl's DOM, the reductions documented in the header)
// ---------------------------------------------------------------------------

/** The `p.info` last-commit line (the template's shape minus the pusher
 *  namelink — the header's reductions): the octicon-git-commit mark ·
 *  ShortSha link · subject · "Updated" TimeSince · author. */
function BranchCommitInfo(props: { repoLink: string; commit: CommitJson }) {
  const { commit } = props;
  return (
    <p class="info tw-flex tw-items-center tw-my-1">
      <Icon name="octicon-git-commit" class="tw-mr-1" />
      <a href={commitLink(props.repoLink, commit.oid)}>{shortSha(commit.oid)}</a>
      <span class="tw-mx-1">·</span>
      <span class="commit-message">{commit.subject}</span>
      <span class="tw-mx-1">·</span>
      {branchesLocale.updated} <TimeSince unixSeconds={commit.committer.time} tz={commit.committer.tz} />
      {" "}
      <span class="text grey">{commit.author.name}</span>
    </p>
  );
}

/** The protection badge: the shield-lock glyph with the template's tooltip
 *  plus the rule name as a tiny label (the module header). */
function ProtectionBadge(props: { ruleName: string }) {
  return (
    <>
      <span data-tooltip-content={branchesLocale.protected_branch}>
        <Icon name="octicon-shield-lock" />
      </span>
      {props.ruleName !== "" ? <span class="ui tiny basic label">{props.ruleName}</span> : null}
    </>
  );
}

/** The `.commit-divergence` bar pair (the template's DOM; the 0/0 NaN width
 *  replaced with 0% — the header note). `null` renders nothing (the
 *  degraded read). */
function DivergenceCell(props: { divergence: { ahead: number; behind: number } | null; defaultBranch: string }) {
  const { divergence } = props;
  if (divergence === null) return null;
  const total = divergence.ahead + divergence.behind;
  const pct = (count: number): number => (total > 0 ? (100 * count) / total : 0);
  const tooltip =
    total === 0 ? branchesLocale.divergence_none(props.defaultBranch) : branchesLocale.divergence_from(divergence.behind, divergence.ahead, props.defaultBranch);
  return (
    <div class="commit-divergence" data-tooltip-content={tooltip}>
      <div class="bar-group">
        <div class="count count-behind">{divergence.behind}</div>
        <div class="bar bar-behind" style={`width: ${pct(divergence.behind)}%`} />
      </div>
      <div class="bar-group">
        <div class="count count-ahead">{divergence.ahead}</div>
        <div class="bar bar-ahead" style={`width: ${pct(divergence.ahead)}%`} />
      </div>
    </div>
  );
}

/** The create-branch control (list.tmpl's `show-create-branch-modal` button
 *  — the JS modal reduced to an inline no-JS form): a visible required
 *  `new_branch_name` input posting upstream's EXACT route
 *  POST `/branches/_new/branch/{from}` (web.go:1477-1481 +
 *  NewBranchForm's single field). The POST arm mounted with the window-2e
 *  folds (635ce2e — w129 batch-14 sweep: was "NOT mounted in src/ui/index.ts
 *  yet", the two-stage HANDOFF). */
function BranchCreateForm(props: { repoLink: string; from: string }) {
  return (
    <form
      method="post"
      action={`${props.repoLink}/branches/_new/branch/${pathEscapeSegments(props.from)}`}
      class="tw-inline-flex tw-items-center"
    >
      <input type="text" name="new_branch_name" required aria-label={branchesLocale.branch_name} size={12} />
      <button
        type="submit"
        class="btn interact-bg tw-p-2"
        aria-label={branchesLocale.new_branch_from(props.from)}
        title={branchesLocale.new_branch_from(props.from)}
        data-tooltip-content={branchesLocale.new_branch_from(props.from)}
      >
        <Icon name="octicon-git-branch" />
      </button>
    </form>
  );
}

/** The rename control (list.tmpl's `showRenameBranchModal` button — the JS
 *  modal reduced to an inline no-JS form): hidden `from` + a required `to`
 *  input (left empty like upstream's modal — repo-branch.ts prefills only
 *  `from`), posting upstream's POST `/branches/rename` (web.go:1486 +
 *  RenameBranchForm). The POST arm mounted with the window-2e folds
 *  (635ce2e — w129 batch-14 sweep: was "NOT mounted", the HANDOFF). */
/** list.tmpl:44-45's EnableFeed anchor: `{RepoLink}/rss/branch/{name}` with
 *  PathEscapeSegments (each segment encodeURIComponent'd, the slashes kept)
 *  — ungated (upstream renders it beside the writer pair for every viewer;
 *  the route seam landed with pages/branch-feed-xml.ts). */
function BranchRssButton(props: { repoLink: string; name: string }) {
  const escaped = props.name.split("/").map(encodeURIComponent).join("/");
  return (
    <a
      role="button"
      class="btn interact-bg tw-p-2"
      href={`${props.repoLink}/rss/branch/${escaped}`}
      aria-label={branchesLocale.rss_feed}
      data-tooltip-content={branchesLocale.rss_feed}
    >
      <Icon name="octicon-rss" />
    </a>
  );
}

function BranchRenameForm(props: { repoLink: string; name: string }) {
  return (
    <form
      method="post"
      action={`${props.repoLink}/branches/rename`}
      class="tw-inline-flex tw-items-center"
    >
      <input type="hidden" name="from" value={props.name} />
      <input type="text" name="to" required aria-label={branchesLocale.rename_to(props.name)} size={12} />
      <button
        type="submit"
        class="btn interact-bg tw-p-2"
        aria-label={branchesLocale.rename_branch(props.name)}
        title={branchesLocale.rename_branch(props.name)}
        data-tooltip-content={branchesLocale.rename_branch(props.name)}
      >
        <Icon name="octicon-pencil" />
      </button>
    </form>
  );
}

/** The PR column's cell (list.tmpl's third cell — the header's PR-column
 *  section cites the four arms). Takes the cell's two inputs as primitives
 *  so the deleted rows can share it (upstream renders the same cell over
 *  flagged rows: IsIncluded folds away — their divergence is skipped, the
 *  -1 error default — and the compare arm is gated `not .DBBranch.IsDeleted`).
 *  Renders nothing when the arms render nothing upstream (e.g. merged +
 *  movedOn + ahead 0). */
function BranchPrCell(props: { repoLink: string; branchName: string; ahead: number; pr: BranchLatestPr | null; defaultBranch: string; allowsPulls: boolean; canPull: boolean }) {
  const { pr } = props;
  // The degraded divergence reads as upstream's -1 error default: never
  // "included", never a compare button.
  const ahead = props.ahead;
  const compare =
    props.allowsPulls && ahead > 0 ? (
      <a class="ui compact basic button tw-m-0 tw-max-w-full" href={`${compareLink(props.repoLink, props.defaultBranch, props.branchName)}?expand=1`}>
        <span class="gt-ellipsis">{props.canPull ? branchesLocale.compare_changes : branchesLocale.compare_branch}</span>
      </a>
    ) : null;
  if (pr === null) {
    if (ahead === 0) {
      return (
        <span class="ui orange large label" data-tooltip-content={branchesLocale.included_desc}>
          <Icon name="octicon-git-pull-request" /> {branchesLocale.included}
        </span>
      );
    }
    return compare;
  }
  if (pr.hasMerged && pr.mergeMovedOn) return compare;
  const issueLink = `${props.repoLink}/pulls/${pr.index}`;
  return (
    <>
      <a href={issueLink} class="tw-align-middle ref-issue">
        #{pr.index}
      </a>
      {pr.hasMerged ? (
        <a href={issueLink} class="ui purple large label">
          <Icon name="octicon-git-merge" class="tw-mr-1" />
          {branchesLocale.merged}
        </a>
      ) : pr.isClosed ? (
        <a href={issueLink} class="ui red large label">
          <Icon name="octicon-git-pull-request-closed" class="tw-mr-1" />
          {branchesLocale.closed_title}
        </a>
      ) : (
        <a href={issueLink} class="ui green large label">
          <Icon name="octicon-git-pull-request" class="tw-mr-1" />
          {branchesLocale.open_title}
        </a>
      )}
    </>
  );
}

/** The row's delete form (the modal reduced to a direct POST — the wave-15
 *  rules-list precedent). The button renders only when the write seam would
 *  accept (CanDelete on both sides — the module header). */
function BranchDeleteForm(props: { repoLink: string; name: string }) {
  return (
    <form method="post" action={`${props.repoLink}/branches/delete`} class="tw-inline-block">
      <input type="hidden" name="name" value={props.name} />
      <button
        type="submit"
        class="btn interact-bg tw-p-2 delete-branch-button tw-text-red"
        aria-label={branchesLocale.delete_branch_aria(props.name)}
        title={branchesLocale.delete_branch_aria(props.name)}
        data-tooltip-content={branchesLocale.delete_branch_aria(props.name)}
      >
        <Icon name="octicon-trash" />
      </button>
    </form>
  );
}

/** The deleted row's info line (list.tmpl:97's
 *  `{{ctx.Locale.Tr "repo.branch.deleted_by" .DBBranch.DeletedBy.Name}}
 *  {{DateUtils.TimeSince .DBBranch.DeletedUnix}}`): the locale text node,
 *  a space, then the relative-time element — the deletion stamp, not a
 *  commit read (the ref is gone; upstream's flagged row keeps
 *  DeletedUnix, our substrate's own column). */
function BranchDeletedInfo(props: { deletedByName: string; deletedUnix: number }) {
  return (
    <p class="info">
      {branchesLocale.deleted_by(props.deletedByName)} <TimeSince unixSeconds={props.deletedUnix} tz="+0000" />
    </p>
  );
}

/** list.tmpl:195-204's restore control (the JS link-action button reduced
 *  to the no-JS direct-POST form like the delete button — the wave-15
 *  rules-list precedent): hidden `branch_id` (RestoreBranchPost's form
 *  field) posting upstream's exact route POST `/branches/restore`
 *  (web.go:1485); the glyph is the template's octicon-reply in its
 *  tw-text-blue span, the tooltip its repo.branch.restore text. Rendered
 *  for writers on NON-protected deleted rows only (the module header's
 *  gate); the POST seam itself is the orchestrator's fold (the module
 *  header's HANDOFF). */
function BranchRestoreForm(props: { repoLink: string; branchId: number; name: string }) {
  return (
    <form method="post" action={`${props.repoLink}/branches/restore`} class="tw-inline-block">
      <input type="hidden" name="branch_id" value={props.branchId} />
      <button
        type="submit"
        class="btn interact-bg tw-p-2 restore-branch-button"
        aria-label={branchesLocale.restore_branch_aria(props.name)}
        title={branchesLocale.restore_branch_aria(props.name)}
        data-tooltip-content={branchesLocale.restore_branch_aria(props.name)}
      >
        <span class="tw-text-blue">
          <Icon name="octicon-reply" />
        </span>
      </button>
    </form>
  );
}

/** The Older/Newer pager preserving `?q=` (the explore/commits DOM shape,
 *  driven by the `more` flag). */
export function BranchesPagination(props: { basePath: string; keyword: string; page: number; more: boolean }) {
  if (props.page <= 1 && !props.more) return null;
  const href = (page: number): string => {
    const params = new URLSearchParams();
    if (props.keyword !== "") params.set("q", props.keyword);
    if (page > 1) params.set("page", String(page));
    return `${props.basePath}?${params.toString()}`;
  };
  return (
    <div class="center page buttons">
      <div class="ui borderless pagination menu">
        {props.page > 1 ? (
          <a class="item navigation" href={href(props.page - 1)}>
            <span class="navigation_label">Newer</span>
          </a>
        ) : null}
        {props.more ? (
          <a class="item navigation" href={href(props.page + 1)}>
            <span class="navigation_label">Older</span>
          </a>
        ) : null}
      </div>
    </div>
  );
}

/** The flash block (the display-only-param reduction — `?deleted=` /
 *  `?delete_error=&name=` carry upstream DeleteBranchPost's texts; the
 *  restore arms ride `?restored=` / `?restore_error=already_exists|failed
 *  &name=` — RestoreBranchPost's texts, the same convention). The restore
 *  params are OPTIONAL so the current index.ts call site compiles
 *  unchanged; the orchestrator's fold wires the two reads (the module
 *  header's HANDOFF). */
export interface BranchesFlashParams {
  deleted: string | null;
  errorKind: string | null;
  errorName: string;
  /** `?restored={name}` — the restore_success flash. */
  restored?: string | null;
  /** `?restore_error=already_exists|failed&name={name}` — the two restore
   *  failure arms (the protected-name refusal folds into `failed`, the
   *  module's mapping). */
  restoreError?: string | null;
}

export function BranchesFlash(props: BranchesFlashParams) {
  if (props.deleted !== null) {
    return <div class="ui info message">{branchesLocale.deletion_success(props.deleted)}</div>;
  }
  if (props.errorKind === "default") {
    return <div class="ui negative message">{branchesLocale.default_deletion_failed(props.errorName)}</div>;
  }
  if (props.errorKind === "protected") {
    return <div class="ui negative message">{branchesLocale.protected_deletion_failed(props.errorName)}</div>;
  }
  if (props.errorKind === "failed") {
    return <div class="ui negative message">{branchesLocale.deletion_failed(props.errorName)}</div>;
  }
  if (props.restored != null && props.restored !== "") {
    return <div class="ui info message">{branchesLocale.restore_success(props.restored)}</div>;
  }
  if (props.restoreError === "already_exists") {
    return <div class="ui negative message">{branchesLocale.already_exists(props.errorName)}</div>;
  }
  if (props.restoreError === "failed") {
    return <div class="ui negative message">{branchesLocale.restore_failed(props.errorName)}</div>;
  }
  return null;
}

/** The full-document render (the render.tsx pattern). `canAdmin` gates the
 *  Switch Default Branch link (the settings page's own gate — the module
 *  header's divergence note). */
export function renderBranchesPage(options: { ctx: UiContext; data: BranchesData; canAdmin: boolean; flash: BranchesFlashParams }): string {
  return renderPage(
    <BranchesPage ctx={options.ctx} data={options.data} canAdmin={options.canAdmin} flash={options.flash} />,
  );
}

/** The branches page (§2.4.1 discriminator: list.tmpl's literal
 *  `ui repository branches`). */
export function BranchesPage(props: { ctx: UiContext; data: BranchesData; canAdmin: boolean; flash: BranchesFlashParams }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("BranchesPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  // The writer block's gate (the header's writer-block section): the loader's
  // write grant (IsWriter) + the archived refusal (CanContentChange — no
  // mirror column is landed). Upstream's `(not .IsDeleted)` arm folds away:
  // deleted-branch rows cannot exist here.
  const writerControls = data.canWrite && !repo.isArchived;
  return (
    <BaseLayout ctx={ctx} title={branchesLocale.page_title} pageClass="ui repository branches" activeTab="code">
      <div class="ui container">
        <BranchesFlash deleted={props.flash.deleted} errorKind={props.flash.errorKind} errorName={props.flash.errorName} />

        {/* --- The Default Branch section (list.tmpl:7-77) --- */}
        <h4 class="ui top attached header">
          {branchesLocale.default_branch}
          {props.canAdmin ? (
            <a
              role="button"
              class="right"
              href={`${repoLink}/settings/branches`}
              data-tooltip-content={branchesLocale.switch_default_branch}
              aria-label={branchesLocale.switch_default_branch}
            >
              {branchesLocale.switch_default_branch}
            </a>
          ) : null}
        </h4>

        {data.defaultBranch === null ? (
          <div class="ui attached segment" data-testid="branches-default-branch-not-exist">
            {branchesLocale.default_branch_not_exist(repo.defaultBranch)}
          </div>
        ) : (
          <div class="ui attached table segment" data-testid="branches-default-branch-list">
            <table class="ui very basic fixed table single line">
              {/* thead additive (the U5 §5.5 smoke's scoped-header rule — no
                  CSS/JS reads it); the second column is the template's empty
                  actions cell (the mirror-table empty-th convention). */}
              <thead>
                <tr>
                  <th scope="col">Branch</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <div class="flex-text-block">
                      <a class="gt-ellipsis branch-name" href={treeLink(repoLink, "branch", data.defaultBranch)}>
                        {data.defaultBranch}
                      </a>
                      <span class="ui basic label">{branchesLocale.default_badge}</span>
                      {data.defaultIsProtected ? <ProtectionBadge ruleName={data.defaultRuleName} /> : null}
                    </div>
                    {data.defaultCommit !== null ? <BranchCommitInfo repoLink={repoLink} commit={data.defaultCommit} /> : null}
                  </td>
                  <td>
                    <div class="tw-flex tw-flex-wrap tw-justify-end">
                      {writerControls ? (
                        <>
                          {/* list.tmpl:34-64's default-section writer pair — the
                              create (from the default) + rename (is-default)
                              buttons, modals reduced to inline forms. */}
                          <BranchCreateForm repoLink={repoLink} from={data.defaultBranch} />
                          <BranchRenameForm repoLink={repoLink} name={data.defaultBranch} />
                        </>
                      ) : null}
                      {/* list.tmpl:44-45's EnableFeed anchor — ungated (the
                          landed /rss/branch/* route seam). */}
                      <BranchRssButton repoLink={repoLink} name={data.defaultBranch} />
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* --- The Branches section (list.tmpl:79-187) --- */}
        <h4 class="ui top attached header">{branchesLocale.branches}</h4>

        <div class="ui attached segment">
          <ExploreSearchForm action={`${repoLink}/branches`} keyword={data.keyword} placeholder={branchesLocale.search_placeholder} />
        </div>

        <div class="ui attached table segment">
          <table class="ui very basic fixed table single line">
            {/* thead additive (the default section's note); the two empty
                th's are the PR cell and the actions column (the mirror-table
                convention). */}
            <thead>
              <tr>
                <th scope="col" class="eight wide">
                  Branch
                </th>
                <th scope="col" class="two wide">
                  Commit divergence
                </th>
                <th scope="col" class="three wide" />
                <th scope="col" class="three wide" />
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr>
                  <td class="eight wide">
                    <div class="flex-text-block">
                      <a class="gt-ellipsis branch-name" href={treeLink(repoLink, "branch", row.name)}>
                        {row.name}
                      </a>
                      {row.isProtected ? <ProtectionBadge ruleName={row.ruleName} /> : null}
                    </div>
                    {row.commit !== null ? <BranchCommitInfo repoLink={repoLink} commit={row.commit} /> : null}
                  </td>
                  <td class="two wide">
                    <DivergenceCell divergence={row.divergence} defaultBranch={data.defaultBranch ?? repo.defaultBranch} />
                  </td>
                  <td class="three wide tw-text-right">
                    <BranchPrCell
                      repoLink={repoLink}
                      branchName={row.name}
                      ahead={row.divergence?.ahead ?? -1}
                      pr={row.latestPr}
                      defaultBranch={data.defaultBranch ?? repo.defaultBranch}
                      allowsPulls={data.allowsPulls}
                      canPull={data.canWrite}
                    />
                  </td>
                  <td class="three wide">
                    <div class="tw-flex tw-flex-wrap tw-justify-end">
                      {/* list.tmpl:163-200's per-row order: create, rename,
                          then the RSS anchor (the download arm stays
                          unrendered — the header's reduction). */}
                      {writerControls ? <BranchCreateForm repoLink={repoLink} from={row.name} /> : null}
                      {writerControls ? <BranchRenameForm repoLink={repoLink} name={row.name} /> : null}
                      <BranchRssButton repoLink={repoLink} name={row.name} />
                      {/* Delete folds the archived refusal into the render
                          gate — upstream gates all three controls identically
                          (list.tmpl:199's IsWriter + CanContentChange); the
                          POST arm 404-shells archived repos, so rendering the
                          button there was a dead control (the branches
                          matrix's RED). */}
                      {row.canDelete && !repo.isArchived ? <BranchDeleteForm repoLink={repoLink} name={row.name} /> : null}
                    </div>
                  </td>
                </tr>
              ))}
              {/* list.tmpl:93-99's IsDeleted arm, rendered in the SAME table
                  (upstream's `is_deleted ASC` order puts them after the live
                  rows — the loader composes the page universe that way): the
                  plain-text name (the ref is gone — no tree link; the
                  per-name copy button stays the header's clipboard
                  reduction), the Deleted-by info line in place of the commit
                  line, an empty divergence cell (upstream skips the walk —
                  the -1 default), the PR cell over its shared scan (a
                  deleted name can carry one), then the actions cell: the
                  ungated RSS anchor (list.tmpl:172-174 carries no
                  IsDeleted condition — the feed itself 404s the gone ref,
                  upstream-identical) and the restore control (writer +
                  non-protected; the POST seam is the module header's
                  HANDOFF). */}
              {data.deletedRows.map((row) => (
                <tr>
                  <td class="eight wide">
                    <div class="flex-text-block">
                      <span class="gt-ellipsis branch-name">{row.name}</span>
                    </div>
                    <BranchDeletedInfo deletedByName={row.deletedByName} deletedUnix={row.deletedUnix} />
                  </td>
                  <td class="two wide" />
                  <td class="three wide tw-text-right">
                    <BranchPrCell
                      repoLink={repoLink}
                      branchName={row.name}
                      ahead={-1}
                      pr={row.latestPr}
                      defaultBranch={data.defaultBranch ?? repo.defaultBranch}
                      allowsPulls={data.allowsPulls}
                      canPull={data.canWrite}
                    />
                  </td>
                  <td class="three wide">
                    <div class="tw-flex tw-flex-wrap tw-justify-end">
                      <BranchRssButton repoLink={repoLink} name={row.name} />
                      {writerControls && !row.isProtected ? <BranchRestoreForm repoLink={repoLink} branchId={row.id} name={row.name} /> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <BranchesPagination basePath={`${repoLink}/branches`} keyword={data.keyword} page={data.page} more={data.more} />
      </div>
    </BaseLayout>
  );
}
