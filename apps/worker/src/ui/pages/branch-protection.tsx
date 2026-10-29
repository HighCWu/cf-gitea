/**
 * The protected-branches settings panel — pages wave 15 (SPEC-0013's UI
 * piece): the `/settings/branches` family over the LANDED
 * `/repos/{owner}/{repo}/branch_protections` API arms (routes/
 * branch-protections.ts — 6 frozen operations, M4-complete).
 *
 *   GET  /{owner}/{repo}/settings/branches                 the rules list
 *   GET/POST /{owner}/{repo}/settings/branches/edit        the new/edit form
 *                                                          (`?rule_name=`
 *                                                          keys the GET —
 *                                                          upstream's own
 *                                                          convention)
 *   POST /{owner}/{repo}/settings/branches/{id}/delete     the delete write
 *   POST /{owner}/{repo}/settings/branches/priority        the reorder write
 *
 * ## DOM contract (templates/repo/settings/{branches,protected_branch,
 *  navbar}.tmpl + layout_head at the pin)
 *
 * The list page is branches.tmpl: layout_head's pageClass is the literal
 * `repository settings edit` at this pin (the FORM page carries `repository
 * settings branches` — upstream swapped the obvious names; both render
 * verbatim). The h4 header + `.ui right` Add New Rule button, then the
 * `#protected-branches-list` divided list: each row the rule name in a
 * `.ui.basic.primary.label`, the Edit anchor onto `?rule_name=<name>` and
 * the red Delete button (the JS confirm modal is not reproduced — the same
 * reduction the hooks list recorded in wave 4). Above it the default-branch
 * segment (branches.tmpl:8-30 — upstream's SetDefaultBranchPost arm, NOT
 * part of the landed branch_protections family) renders over the landed
 * §2.5.2 write (RepoService.setDefaultBranch): the section below. The form
 * page is protected_branch.tmpl's shape: the
 * Patterns / Push / Force Push / Branch Deletion / Pull Request Approvals /
 * Pull Request Merge / Bypass sections with the exact upstream field names
 * (`rule_name`, `enable_push` none|all|whitelist radios,
 * `whitelist_users`, `required_approvals`, …).
 *
 * ## The honest field subset (the brief; SPEC-0013 §1 vs §6)
 *
 * The form renders exactly the arms SPEC-0013 v1 ENFORCES — the merge-side
 * set (required approvals, approvals whitelist, rejected-review /
 * official-request / outdated-branch blocks, merge + bypass allowlists,
 * admin override) and the push-side set (direct-push allowlist, force push,
 * deletion). The API also writes the stored-but-unenforced arms —
 * protected/unprotected file patterns, require_signed_commits, status
 * checks, block_on_codeowner_reviews (§6: no file walking, no signature
 * surface, no CI consumer, no CODEOWNERS) — and those are NOT rendered: a
 * control that pretends protection the engine does not deliver would be
 * worse than its absence. On edit they keep their stored values (the form
 * carries no field for them). The list's meta line IS the surface where the
 * stored status-check arm stays visible (context count) so an admin can see
 * an API-written rule's full shape. Also not rendered: the deploy-key
 * checkboxes — upstream's own template dropped them at this pin
 * (protected_branch.tmpl carries no push_whitelist_deploy_keys input), and
 * the comma inputs cannot express the pseudo-names; a whitelist resubmit
 * through this form drops stored pseudo-principal ids exactly like
 * upstream's web post.
 *
 * ## No-JS reductions (documented divergences)
 *
 * - Upstream's user/team multiselect dropdowns (settings/user_dropdown.tmpl
 *   + team_dropdown.tmpl — hidden inputs carrying comma-joined IDs the
 *   bundle's JS fills) render as plain comma-separated NAME inputs: the
 *   landed API resolves name arrays at the edge (routes/
 *   branch-protections.ts resolveUserIds/resolveTeamIds — the exact 422
 *   texts re-surface inline), so names are what the no-JS form can express.
 *   Team inputs render on org-owned repos only (the template's
 *   `.Owner.IsOrganization` gate).
 * - Upstream's drag-and-drop priority ordering (branches.tmpl's
 *   `data-update-priority-url` + octicon-grabber handles) renders as
 *   per-row Move up/Move down buttons: each posts the FULL reordered id
 *   list to `/settings/branches/priority` — upstream's JS POSTs the same
 *   `{ids}` payload as JSON; the urlencoded repeated-`ids` form is the
 *   no-JS shape of the same op (repoUpdateBranchProtectionPriories —
 *   renumber 1-based in list order, foreign-repo ids no-op through the
 *   repo_id guard).
 *
 * ## The default-branch segment (branches.tmpl:8-30 + SetDefaultBranchPost)
 *
 * The list page's first segment is upstream's default-branch select: the h4
 * `repo.default_branch` header, the form POSTing onto the page itself
 * (`.Link` — the request path, context.go:59) with the hidden
 * `action=default_branch` field, the option menu sourced from
 * PrepareBranchList's port (routers/web/repo/repo.go:598-618 over the
 * ENGINE branch list — refs/heads/ byte-sorted, the current default moved
 * to the top when it exists) and the submit disabled while
 * `.Repository.IsEmpty` (branches.tmpl:26). The Fomantic search dropdown
 * reduces to a native select (the no-JS convention — the menu items ARE
 * upstream's `data-value` items, the current default the marked selection;
 * the triangle-down svg is the JS dropdown's chrome, the icon-reduction
 * precedent) and carries the current default even when the engine does not
 * know it (upstream's hidden input + `.default text` render it verbatim).
 *
 * **MOUNTED (w129 batch-14 sweep — this paragraph was the two-stage
 * HANDOFF, kept verbatim below as the recipe record):** the default-branch
 * write arm went live in `src/ui/index.ts` exactly per that recipe —
 * `branchProtectionDefaultBranchSubmit` (the registered POST) and the GET
 * passing `branchOptions` (ce52935's mount). The stale halves were "the GET
 * handler does not yet pass `branchOptions` … and the POST is unregistered";
 * both flipped with the mount.
 *
 * **The HANDOFF record (SetDefaultBranchPost's shape):**
 * sameOriginGuard → resolveUiRequest → settingsGate → the archived 404
 * (RepoMustNotBeArchived's posture), `action != "default_branch"` 404s
 * (upstream's switch default arm), then applyDefaultBranchForm(c.env, repo,
 * form.get("branch") ?? "") — `missing` 404-shells (upstream's
 * ErrBranchNotExist → ctx.Status(404)), success 303s onto
 * `/{owner}/{repo}/settings/branches` (upstream's redirect to the request
 * path; the update_settings_success flash is the display-only-param
 * reduction dropped — the delete/priority bare-303 precedent), plus the
 * GET passing `branchOptions: repo.isArchived ? [] : await
 * loadDefaultBranchOptions(c.env, repo)` in the list data.
 *
 * ## Auth + CSRF + archived posture (the settings pages' convention)
 *
 * Every page runs the settings gate (index.ts settingsGate: repo resolved
 * first, anonymous 303s onto the login round-trip, a signed-in non-admin
 * 404-shells) and every POST the §2.8 layer-2 Origin guard
 * (sameOriginGuard). Archived repos: the LIST renders
 * branches.tmpl's `branchsettings_unavailable` warning instead of the list
 * and its controls (the template's IsArchived arm); the edit GET renders
 * the same warning instead of a form whose POST could only 404 (upstream
 * renders the editable form on archived GET — its POST then 404s through
 * RepoMustNotBeArchived; a guaranteed-dead form is a dead control, §2.4.1);
 * all three POSTs 404-shell (the RepoMustNotBeArchived posture — upstream
 * wraps the edit POST and the priority route, and the delete arms answer
 * the same shape).
 *
 * ## Write paths (§3.2 — the landed arms re-played, never a self-fetch)
 *
 * The POST bodies are re-played over the landed service primitives
 * (services/branch-protection.ts) exactly like wave 14's test-fire
 * re-played routes/hooks.ts's arm body: the route module's handlers are
 * module-private, so the page module ports their steps with the same
 * conjunctions, sanitization and recompute:
 * - Create (repoCreateBranchProtection): empty-name guard, the 403
 *   "Branch protection already exist" duplicate text, name→id resolution
 *   with upstream's exact 422 texts, createConfigFromOption's
 *   push/force/deletion flag conjunctions, the M4 save-side
   * sanitizeRuleWhitelists (zero comparison side — a resolved name whose
 *   principal lacks the access is silently dropped, the settings-multiselect
 *   semantics), the priority-0 → MAX(priority)+1 insert
 *   (protected_branch.go:502-513), then the recheck fan-out
 *   (recomputeOfficialForRule — the OQ-3 instrument, logged).
 * - Edit (repoEditBranchProtection): the rule loads by id (repo-scoped; a
 *   miss/foreign id 404-shells — existence hidden). The form submits every
 *   rendered field bound to the stored values, so the merged config is the
 *   PATCH arm's pointer-patch with explicit values: the push/force cascades
 *   clear their sub-flags, deletion re-conjoins onto can_push (:935-936),
 *   a rendered whitelist array replaces the stored ids while an
 *   omitted one (checkbox off) keeps them — EXCEPT the bypass and deletion
 *   allowlists, which the arm clears when their flags are off (:1180-1192).
 *   The unrendered arms keep their stored values; required_approvals
 *   renames are impossible (EditBranchProtectionOption has no name field —
 *   the rule_name input is readonly on edit; upstream's web POST renames,
 *   the landed API family cannot — documented divergence), sanitization
 *   runs with the AS-LOADED comparison side (the SliceSortedEqual
 *   short-circuit keeps unchanged lists verbatim), then the update +
 *   recompute.
 * - Delete (repoDeleteBranchProtection): the row deletes, the recompute
 *   runs over the NO-RULE state (a deleted whitelist can only widen
 *   officialness — the arm's own semantics, upstream's skip noted in the
 *   route header), success 303s onto the list (the JSONRedirect target).
 * - Priority (repoUpdateBranchProtectionPriories): the id list renumbers
 *   1-based in one D1 batch through the repo_id guard, then 303s back
 *   (upstream's JS reloads; the flash-free redirect is the reduction).
 *
 * Success flashes are the display-only-param reduction (no session-flash
 * plumbing): the save POST 303s onto `/settings/branches?rule_name=<saved>`
 * — upstream's exact redirect target (protected_branch.go:337) — and the
 * list renders the `repo.settings.update_protect_branch_success` text as an
 * info message. Delete/priority land bare (the hooks-delete precedent).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../../api/errors";
import { engineReads } from "../../api/services/engine";
import type { RepositoryWithOwner } from "../../api/services/repository";
import { RepoService } from "../../repos/service";
import { protectedBranches, teams, users } from "../../db/schema";
import {
  ACTIONS_USER_ID,
  DEPLOY_KEY_USER_ID,
  emptyRuleConfig,
  isRuleNameSpecial,
  listRepoRules,
  parseRuleConfig,
  recomputeOfficialForRule,
  sanitizeRuleWhitelists,
  serializeRuleConfig,
  type ProtectedBranchConfig,
  type ProtectedBranchRow,
} from "../../services/branch-protection";
import type { RepoRow, UiContext } from "../ui-context";
import { BaseLayout, renderPage } from "../shell";
// pages/settings.tsx owns the reduced settings menu (one owner — the navbar
// is shared chrome, not this module's); the wave-15 addition binds it to the
// `branches` active item.
import { SettingsNav as SettingsNavHost } from "./settings";

/** Page chrome text (the settingsLocale pattern; upstream locale keys cited,
 *  cf-gitea additions marked). */
export const branchProtectionLocale = {
  branches: "Branches", // "repo.settings.branches" (the navbar item)
  protected_branch: "Branch Protection", // "repo.settings.protected_branch" (the list header)
  add_new_rule: "Add New Rule", // "repo.settings.branches.add_new_rule"
  edit_protected_branch: "Edit", // "repo.settings.edit_protected_branch"
  delete_rule: "Delete Rule", // "repo.settings.protected_branch.delete_rule"
  no_protected_branch: "There are no protected branches.", // "repo.settings.no_protected_branch"
  save_rule: "Save Rule", // "repo.settings.protected_branch.save_rule"
  branch_protection_prefix: "Branch Protection Rules for Branch '", // "repo.settings.branch_protection" (split around the <b>%s</b>)
  branch_protection_suffix: "'",
  archived_unavailable: "Branch settings are not available if the repo is archived.", // "repo.settings.archive.branchsettings_unavailable"
  patterns: "Patterns", // "repo.settings.protect_patterns"
  name_pattern: "Protected Branch Name Pattern", // "repo.settings.protect_branch_name_pattern"
  name_pattern_help: "Examples: main, release/**", // the %s-doc-link tail dropped (no external docs surface) — cf-gitea reduction
  event_push: "Push", // "repo.settings.event_push"
  disable_push: "Disable Push", // "repo.settings.protect_disable_push"
  enable_push: "Enable Push", // "repo.settings.protect_enable_push"
  whitelist_committers: "Allowlist Restricted Push", // "repo.settings.protect_whitelist_committers"
  whitelist_users: "Allowlisted users for pushing:", // "repo.settings.protect_whitelist_users"
  whitelist_teams: "Allowlisted teams for pushing:", // "repo.settings.protect_whitelist_teams"
  event_force_push: "Force Push", // "repo.settings.event_force_push"
  disable_force_push: "Disable Force Push", // "repo.settings.protect_disable_force_push"
  enable_force_push_all: "Enable Force Push", // "repo.settings.protect_enable_force_push_all"
  enable_force_push_allowlist: "Allowlist Restricted Force Push", // "repo.settings.protect_enable_force_push_allowlist"
  force_push_allowlist_users: "Allowlisted users for force pushing:", // "repo.settings.protect_force_push_allowlist_users"
  force_push_allowlist_teams: "Allowlisted teams for force pushing:", // "repo.settings.protect_force_push_allowlist_teams"
  event_branch_delete: "Branch Deletion", // "repo.settings.event_branch_delete"
  disable_deletion: "Disable Branch Deletion", // "repo.settings.protect_disable_deletion"
  enable_deletion_all: "Enable Branch Deletion", // "repo.settings.protect_enable_deletion_all"
  enable_deletion_allowlist: "Allowlist Restricted Branch Deletion", // "repo.settings.protect_enable_deletion_allowlist"
  deletion_allowlist_users: "Allowlisted users for deleting:", // "repo.settings.protect_deletion_allowlist_users"
  deletion_allowlist_teams: "Allowlisted teams for deleting:", // "repo.settings.protect_deletion_allowlist_teams"
  event_pull_request_approvals: "Pull Request Approvals", // "repo.settings.event_pull_request_approvals"
  required_approvals: "Required approvals:", // "repo.settings.protect_required_approvals"
  approvals_whitelist_enabled: "Restrict approvals to allowlisted users or teams", // "repo.settings.protect_approvals_whitelist_enabled"
  approvals_whitelist_users: "Allowlisted reviewers:", // "repo.settings.protect_approvals_whitelist_users"
  approvals_whitelist_teams: "Allowlisted teams for reviews:", // "repo.settings.protect_approvals_whitelist_teams"
  dismiss_stale_approvals: "Dismiss stale approvals", // "repo.settings.dismiss_stale_approvals"
  ignore_stale_approvals: "Ignore stale approvals", // "repo.settings.ignore_stale_approvals"
  event_pull_request_merge: "Pull Request Merge", // "repo.settings.event_pull_request_merge"
  enable_merge: "Enable Merge", // "repo.settings.protect_enable_merge"
  merge_whitelist_committers: "Enable Merge Allowlist", // "repo.settings.protect_merge_whitelist_committers"
  merge_whitelist_users: "Allowlisted users for merging:", // "repo.settings.protect_merge_whitelist_users"
  merge_whitelist_teams: "Allowlisted teams for merging:", // "repo.settings.protect_merge_whitelist_teams"
  bypass_allowlist: "Bypass branch protection", // "repo.settings.protect_bypass_allowlist" (the section header)
  enable_bypass_allowlist: "Allow selected users or teams to bypass branch protection", // "repo.settings.protect_enable_bypass_allowlist"
  bypass_allowlist_users: "Allowlisted users for bypassing protection:", // "repo.settings.protect_bypass_allowlist_users"
  bypass_allowlist_teams: "Allowlisted teams for bypassing protection:", // "repo.settings.protect_bypass_allowlist_teams"
  block_rejected_reviews: "Block merge on rejected reviews", // "repo.settings.block_rejected_reviews"
  block_on_official_review_requests: "Block merge on official review requests", // "repo.settings.block_on_official_review_requests"
  block_outdated_branch: "Block merge if pull request is outdated", // "repo.settings.block_outdated_branch"
  block_admin_merge_override: "Administrators must follow branch protection rules", // "repo.settings.block_admin_merge_override"
  names_help: "Comma-separated names.", // cf-gitea addition — the dropdown multiselect's no-JS replacement hint
  move_up_aria: "Move this rule up the priority order", // cf-gitea addition — the drag handle's no-JS stand-in
  move_down_aria: "Move this rule down the priority order", // cf-gitea addition
  saved_flash: "Branch protection for rule", // "repo.settings.update_protect_branch_success" head; the "…" form is "%s" has been updated." — rendered split
  glob_badge: "glob", // cf-gitea addition — the wildcard rule badge (IsRuleNameSpecial)
  unenforced_note:
    "The stored-but-unenforced arms (protected file patterns, signed commits, status checks, CODEOWNER reviews — SPEC-0013 §6) have no fields here; an edit keeps their stored values.", // cf-gitea addition
  readonly_name_note: "Rule names cannot be renamed: the API edit arm keys the rule by its name.", // cf-gitea addition
  required_rule_name: "Rule name cannot be empty.", // cf-gitea addition (the HTML5 required backs this; upstream's flash key is protected_branch_required_rule_name)
  required_approvals_min: "Required approvals cannot be negative.", // "repo.settings.protected_branch_required_approvals_min"
  default_branch: "Default Branch", // "repo.default_branch" (the segment header)
  default_branch_desc: "Select a default branch for code commits.", // "repo.settings.default_branch_desc"
  update_default_branch: "Update Default Branch", // "repo.settings.branches.update_default_branch" (the submit)
  default_target_branch_desc:
    "Pull requests can use different default target branch if it is set in the Pull Requests section of Repository Advance Settings.", // "repo.settings.default_target_branch_desc"
  default_branch_select_aria: "Default branch", // cf-gitea addition — the native select's accessible name (upstream's dropdown has none)
} as const;

// ---------------------------------------------------------------------------
// The read side (§3.2 — the landed list read)
// ---------------------------------------------------------------------------

/** One rendered rule row: the stored row plus its parsed config and the
 *  glob-classification the wildcard badge renders. */
export interface RuleListItem {
  row: ProtectedBranchRow;
  config: ProtectedBranchConfig;
  /** IsRuleNameSpecial (protected_branch.go:87-94) — the name compiles as a
   *  glob (`* ? \ [ ] { }` present) rather than matching as a plain name. */
  glob: boolean;
}

/** The list read (FindRepoProtectedBranchRules' port — listRepoRules'
 *  priority → plain-before-glob → created sort IS the first-match order the
 *  gates evaluate in; the rendered rank is that order). */
export async function loadBranchProtectionRules(d1: D1Database, repoId: string): Promise<RuleListItem[]> {
  const rules = await listRepoRules(d1, repoId);
  return rules.map((row) => ({ row, config: parseRuleConfig(row.rules), glob: isRuleNameSpecial(row.ruleName) }));
}

/** Whether the repo's owner is an org (the team inputs' template gate —
 *  upstream `.Owner.IsOrganization`). The owner row is the users-table org
 *  row (SPEC-0007's org-as-user-row model); an orphaned repo (null ownerId)
 *  is invisible upstream of this loader, so the null reads "not an org". */
export async function loadOwnerIsOrg(d1: D1Database, repo: RepoRow): Promise<boolean> {
  if (repo.ownerId === null) return false;
  const row = await drizzle(d1).select({ type: users.type }).from(users).where(eq(users.id, repo.ownerId)).limit(1).get();
  return row?.type === "org";
}

// ---------------------------------------------------------------------------
// The default-branch select (branches.tmpl:8-30 — upstream's SetDefaultBranchPost
// arm; the option source and the write seam below, the module header carries
// the mount recipe)
// ---------------------------------------------------------------------------

/** The engine's branch names (refs/heads/ filtered, byte-sorted — the API
 *  LIST's universe and comparator, loadBranchesData's half): the write arm's
 *  existence check AND (through loadDefaultBranchOptions) the select's
 *  source, so the render gate and the write seam can never disagree (the
 *  branches.tsx delete posture). A failed read degrades to an empty list
 *  (§4.9) — the select renders the unborn default alone and the write arm
 *  refuses changes (upstream's IsBranchExist arm reads the synced branch
 *  table; a lookup failure reads as not-exist there too). */
export async function loadEngineBranchNames(env: Env, repo: RepoRow): Promise<string[]> {
  const refs = await engineReads(env, repo).listRefs();
  return (refs?.refs ?? [])
    .filter((ref) => ref.name.startsWith("refs/heads/"))
    .map((ref) => ref.name.slice("refs/heads/".length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** PrepareBranchList's port (routers/web/repo/repo.go:598-618) over the
 *  engine's branch list — the select's option menu, "always put default
 *  branch on the top if it exists". */
export async function loadDefaultBranchOptions(env: Env, repo: RepoRow): Promise<string[]> {
  const names = await loadEngineBranchNames(env, repo);
  if (names.includes(repo.defaultBranch)) {
    return [repo.defaultBranch, ...names.filter((name) => name !== repo.defaultBranch)];
  }
  return names;
}

/** Singular/plural count word (the counts line's tiny grammar). */
function countWord(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The key counts per the list read (the brief's list meta line): the armed
 *  allowlists with their user/team sizes, the required-approvals bar and the
 *  stored status-check context count — the honest visibility for the
 *  API-written arms this UI's form does not render (the module header). */
export function ruleCountParts(config: ProtectedBranchConfig): string[] {
  const parts: string[] = [];
  if (config.requiredApprovals > 0) parts.push(`required approvals: ${config.requiredApprovals}`);
  if (config.enableWhitelist) {
    parts.push(`push allowlist: ${countWord(config.whitelistUserIds.length, "user")}, ${countWord(config.whitelistTeamIds.length, "team")}`);
  }
  if (config.canForcePush) {
    parts.push(
      config.enableForcePushAllowlist
        ? `force push allowlist: ${countWord(config.forcePushAllowlistUserIds.length, "user")}, ${countWord(config.forcePushAllowlistTeamIds.length, "team")}`
        : "force push: all",
    );
  }
  if (config.canDelete) {
    parts.push(
      config.enableDeletionAllowlist
        ? `deletion allowlist: ${countWord(config.deletionAllowlistUserIds.length, "user")}, ${countWord(config.deletionAllowlistTeamIds.length, "team")}`
        : "deletion: all",
    );
  }
  if (config.enableMergeWhitelist) {
    parts.push(`merge allowlist: ${countWord(config.mergeWhitelistUserIds.length, "user")}, ${countWord(config.mergeWhitelistTeamIds.length, "team")}`);
  }
  if (config.enableApprovalsWhitelist) {
    parts.push(`approvals allowlist: ${countWord(config.approvalsWhitelistUserIds.length, "user")}, ${countWord(config.approvalsWhitelistTeamIds.length, "team")}`);
  }
  if (config.enableBypassAllowlist) {
    parts.push(`bypass allowlist: ${countWord(config.bypassAllowlistUserIds.length, "user")}, ${countWord(config.bypassAllowlistTeamIds.length, "team")}`);
  }
  if (config.enableStatusCheck) parts.push(`status checks: ${config.statusCheckContexts.length} contexts`);
  return parts;
}

// ---------------------------------------------------------------------------
// The form (protected_branch.tmpl's field names; the honest subset — module
// header)
// ---------------------------------------------------------------------------

/** The radio trio's values — upstream's literal `enable_push` /
 *  `enable_force_push` / `enable_deletion` values (protected_branch.tmpl
 *  :33-48, :76-91, :112-127). */
export type PushMode = "none" | "all" | "whitelist";

export interface BranchProtectionForm {
  /** 0 = the create form; >0 the stored rule id under edit (upstream's
   *  hidden `rule_id`). */
  ruleId: number;
  ruleName: string;
  enablePush: PushMode;
  whitelistUsers: string;
  whitelistTeams: string;
  enableForcePush: PushMode;
  forcePushAllowlistUsers: string;
  forcePushAllowlistTeams: string;
  enableDeletion: PushMode;
  deletionAllowlistUsers: string;
  deletionAllowlistTeams: string;
  requiredApprovals: number;
  enableApprovalsWhitelist: boolean;
  approvalsWhitelistUsers: string;
  approvalsWhitelistTeams: string;
  enableMergeWhitelist: boolean;
  mergeWhitelistUsers: string;
  mergeWhitelistTeams: string;
  enableBypassAllowlist: boolean;
  bypassAllowlistUsers: string;
  bypassAllowlistTeams: string;
  dismissStaleApprovals: boolean;
  ignoreStaleApprovals: boolean;
  blockOnRejectedReviews: boolean;
  blockOnOfficialReviewRequests: boolean;
  blockOnOutdatedBranch: boolean;
  blockAdminMergeOverride: boolean;
}

/** Parse one urlencoded POST (the template's input names verbatim; the
 *  radios' junk values fall back to "none" — Go's zero). */
export function parseBranchProtectionForm(params: URLSearchParams): BranchProtectionForm {
  const mode = (name: string): PushMode => {
    const value = params.get(name);
    return value === "all" || value === "whitelist" ? value : "none";
  };
  const idRaw = params.get("rule_id") ?? "0";
  const ruleId = /^\d+$/.test(idRaw) ? Number.parseInt(idRaw, 10) : 0;
  const approvalsRaw = params.get("required_approvals") ?? "0";
  const approvals = Number.parseInt(approvalsRaw, 10);
  return {
    ruleId,
    ruleName: (params.get("rule_name") ?? "").trim(),
    enablePush: mode("enable_push"),
    whitelistUsers: params.get("whitelist_users") ?? "",
    whitelistTeams: params.get("whitelist_teams") ?? "",
    enableForcePush: mode("enable_force_push"),
    forcePushAllowlistUsers: params.get("force_push_allowlist_users") ?? "",
    forcePushAllowlistTeams: params.get("force_push_allowlist_teams") ?? "",
    enableDeletion: mode("enable_deletion"),
    deletionAllowlistUsers: params.get("deletion_allowlist_users") ?? "",
    deletionAllowlistTeams: params.get("deletion_allowlist_teams") ?? "",
    requiredApprovals: Number.isSafeInteger(approvals) ? approvals : 0,
    enableApprovalsWhitelist: (params.get("enable_approvals_whitelist") ?? "") !== "",
    approvalsWhitelistUsers: params.get("approvals_whitelist_users") ?? "",
    approvalsWhitelistTeams: params.get("approvals_whitelist_teams") ?? "",
    enableMergeWhitelist: (params.get("enable_merge_whitelist") ?? "") !== "",
    mergeWhitelistUsers: params.get("merge_whitelist_users") ?? "",
    mergeWhitelistTeams: params.get("merge_whitelist_teams") ?? "",
    enableBypassAllowlist: (params.get("enable_bypass_allowlist") ?? "") !== "",
    bypassAllowlistUsers: params.get("bypass_allowlist_users") ?? "",
    bypassAllowlistTeams: params.get("bypass_allowlist_teams") ?? "",
    dismissStaleApprovals: (params.get("dismiss_stale_approvals") ?? "") !== "",
    ignoreStaleApprovals: (params.get("ignore_stale_approvals") ?? "") !== "",
    blockOnRejectedReviews: (params.get("block_on_rejected_reviews") ?? "") !== "",
    blockOnOfficialReviewRequests: (params.get("block_on_official_review_requests") ?? "") !== "",
    blockOnOutdatedBranch: (params.get("block_on_outdated_branch") ?? "") !== "",
    blockAdminMergeOverride: (params.get("block_admin_merge_override") ?? "") !== "",
  };
}

/** The comma input's name list — split, trim, drop empties (upstream
 *  `strings.Split(f.WhitelistUsers, ",")` plus the trim its dropdown
 *  inputs never needed). */
function namesInput(value: string): string[] {
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** The create form's binding — every arm off, every list empty. */
export function emptyBranchProtectionForm(): BranchProtectionForm {
  return {
    ruleId: 0,
    ruleName: "",
    enablePush: "none",
    whitelistUsers: "",
    whitelistTeams: "",
    enableForcePush: "none",
    forcePushAllowlistUsers: "",
    forcePushAllowlistTeams: "",
    enableDeletion: "none",
    deletionAllowlistUsers: "",
    deletionAllowlistTeams: "",
    requiredApprovals: 0,
    enableApprovalsWhitelist: false,
    approvalsWhitelistUsers: "",
    approvalsWhitelistTeams: "",
    enableMergeWhitelist: false,
    mergeWhitelistUsers: "",
    mergeWhitelistTeams: "",
    enableBypassAllowlist: false,
    bypassAllowlistUsers: "",
    bypassAllowlistTeams: "",
    dismissStaleApprovals: false,
    ignoreStaleApprovals: false,
    blockOnRejectedReviews: false,
    blockOnOfficialReviewRequests: false,
    blockOnOutdatedBranch: false,
    blockAdminMergeOverride: false,
  };
}

/**
 * The stored row as the edit form's binding — the ToBranchProtection render
 * (services/convert/convert.go:151-215) reduced to the form's subset: ids
 * map to names in id order, vanished ids render as nothing (never
 * invented), the pseudo-principal ids (-2/-3) render as nothing too — a
 * resubmit drops them exactly like upstream's web form, whose template
 * dropped the deploy-key checkboxes at this pin (module header).
 */
export async function editFormOfRule(d1: D1Database, pair: RepositoryWithOwner, item: RuleListItem): Promise<BranchProtectionForm> {
  const config = item.config;
  const userIds = [...new Set([...config.whitelistUserIds, ...config.forcePushAllowlistUserIds, ...config.deletionAllowlistUserIds, ...config.mergeWhitelistUserIds, ...config.approvalsWhitelistUserIds, ...config.bypassAllowlistUserIds])].filter(
    (id) => id > 0,
  );
  const userNames = new Map<number, string>();
  if (userIds.length > 0) {
    for (const row of await drizzle(d1).select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, userIds)).all()) {
      userNames.set(row.id, row.username);
    }
  }
  const teamIds = [...new Set([...config.whitelistTeamIds, ...config.forcePushAllowlistTeamIds, ...config.deletionAllowlistTeamIds, ...config.mergeWhitelistTeamIds, ...config.approvalsWhitelistTeamIds, ...config.bypassAllowlistTeamIds])];
  const teamNames = new Map<number, string>();
  if (teamIds.length > 0) {
    for (const row of await drizzle(d1).select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamIds)).all()) {
      teamNames.set(row.id, row.name);
    }
  }
  const namesOf = (ids: number[], map: Map<number, string>): string =>
    ids
      .map((id) => map.get(id))
      .filter((name): name is string => name !== undefined)
      .join(",");
  const modeOf = (armed: boolean, allowlist: boolean): PushMode => (!armed ? "none" : allowlist ? "whitelist" : "all");
  return {
    ruleId: item.row.id,
    ruleName: item.row.ruleName,
    enablePush: modeOf(config.canPush, config.enableWhitelist),
    whitelistUsers: namesOf(config.whitelistUserIds, userNames),
    whitelistTeams: namesOf(config.whitelistTeamIds, teamNames),
    enableForcePush: modeOf(config.canForcePush, config.enableForcePushAllowlist),
    forcePushAllowlistUsers: namesOf(config.forcePushAllowlistUserIds, userNames),
    forcePushAllowlistTeams: namesOf(config.forcePushAllowlistTeamIds, teamNames),
    enableDeletion: modeOf(config.canDelete, config.enableDeletionAllowlist),
    deletionAllowlistUsers: namesOf(config.deletionAllowlistUserIds, userNames),
    deletionAllowlistTeams: namesOf(config.deletionAllowlistTeamIds, teamNames),
    requiredApprovals: config.requiredApprovals,
    enableApprovalsWhitelist: config.enableApprovalsWhitelist,
    approvalsWhitelistUsers: namesOf(config.approvalsWhitelistUserIds, userNames),
    approvalsWhitelistTeams: namesOf(config.approvalsWhitelistTeamIds, teamNames),
    enableMergeWhitelist: config.enableMergeWhitelist,
    mergeWhitelistUsers: namesOf(config.mergeWhitelistUserIds, userNames),
    mergeWhitelistTeams: namesOf(config.mergeWhitelistTeamIds, teamNames),
    enableBypassAllowlist: config.enableBypassAllowlist,
    bypassAllowlistUsers: namesOf(config.bypassAllowlistUserIds, userNames),
    bypassAllowlistTeams: namesOf(config.bypassAllowlistTeamIds, teamNames),
    dismissStaleApprovals: config.dismissStaleApprovals,
    ignoreStaleApprovals: config.ignoreStaleApprovals,
    blockOnRejectedReviews: config.blockOnRejectedReviews,
    blockOnOfficialReviewRequests: config.blockOnOfficialReviewRequests,
    blockOnOutdatedBranch: config.blockOnOutdatedBranch,
    blockAdminMergeOverride: config.blockAdminMergeOverride,
  };
}

// ---------------------------------------------------------------------------
// The write paths (§3.2 — the landed arms re-played over the service
// primitives; the module header carries the arm-by-arm citations)
// ---------------------------------------------------------------------------

/** routes/branch-protections.ts's private resolveUserIds (loadBranchProtectionUserIDs,
 *  branch.go:709-724): every name resolves case-insensitively (the two
 *  system pseudo-names too) or the whole save 422s with upstream's exact
 *  text. */
async function resolveUserIds(d1: D1Database, names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower === "gitea-actions") {
      ids.push(ACTIONS_USER_ID);
      continue;
    }
    if (lower === "gitea:deploy-key") {
      ids.push(DEPLOY_KEY_USER_ID);
      continue;
    }
    const row = await drizzle(d1).select({ id: users.id }).from(users).where(eq(users.usernameLower, lower)).limit(1).get();
    if (row === undefined) {
      // ErrUserNotExist.Error() (models/user/error.go:46) — name lookups carry uid 0.
      throw new ApiError(422, `user does not exist [uid: 0, name: ${name}]`);
    }
    ids.push(row.id);
  }
  return ids;
}

/** routes/branch-protections.ts's private resolveTeamIds (GetTeamIDsByNames)
 *  — org-scoped, case-insensitive, upstream's exact 422 text. */
async function resolveTeamIds(d1: D1Database, orgId: number, names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const row = await drizzle(d1)
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.orgId, orgId), eq(teams.lowerName, name.toLowerCase())))
      .limit(1)
      .get();
    if (row === undefined) {
      // ErrTeamNotExist.Error() (models/organization/team.go:65).
      throw new ApiError(422, `team does not exist [org_id ${orgId}, team_id 0, name: ${name}]`);
    }
    ids.push(row.id);
  }
  return ids;
}

/** The rule-change recheck fan-out over the landed recompute
 *  (recomputeOfficialForRule — the OQ-3 instrument), logged exactly like
 *  routes/branch-protections.ts's recomputeLogged. */
async function recomputeLogged(d1: D1Database, pair: RepositoryWithOwner, rule: ProtectedBranchRow): Promise<void> {
  const rewritten = await recomputeOfficialForRule(d1, pair.repo, rule);
  if (rewritten > 0) {
    console.error(`[branch-protections] ${pair.repo.ownerNamespace}/${pair.repo.slug}: rule ${rule.ruleName} recompute rewrote ${rewritten} official flag(s)`);
  }
}

export type BranchProtectionResult =
  | { outcome: "created"; ruleName: string }
  | { outcome: "saved"; ruleName: string }
  | { outcome: "missing" } // the edit id not found in this repo (404 shell)
  | { outcome: "invalid"; message: string };

/**
 * The create-or-edit write (upstream SettingsProtectedBranchPost's shape
 * over the landed arms — the module header carries the citations). The
 * form's rule_id splits the arms: 0 creates through the POST
 * branch_protections arm, >0 edits through the PATCH arm keyed by the
 * STORED name (a rule cannot be renamed). ApiError 422/403 messages
 * surface as `invalid` re-renders (the hooks-form convention).
 */
export async function applyBranchProtectionForm(d1: D1Database, pair: RepositoryWithOwner, form: BranchProtectionForm): Promise<BranchProtectionResult> {
  if (form.ruleName === "") {
    return { outcome: "invalid", message: branchProtectionLocale.required_rule_name };
  }
  if (form.requiredApprovals < 0) {
    return { outcome: "invalid", message: branchProtectionLocale.required_approvals_min };
  }
  // The arms throw ApiError (the 422 resolution texts, the 403 duplicate) —
  // caught here so the message re-renders inline (the hooks-form
  // convention); unknown errors propagate.
  try {
    return await applyFormArms(d1, pair, form);
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
}

/** The arms' body (applyBranchProtectionForm owns the guards + the catch). */
async function applyFormArms(d1: D1Database, pair: RepositoryWithOwner, form: BranchProtectionForm): Promise<BranchProtectionResult> {
  const isOrg = pair.owner.type === "org";
  const orgId = pair.owner.id;

  // Upstream's UI coercion (protected_branch.go:221-225): deletion requires
  // push access — a deletion arm with push disabled is silently "none".
  const deletionMode: PushMode = form.enablePush === "none" ? "none" : form.enableDeletion;

  // Push/force/deletion radio → armed + allowlist pairs (the template's
  // three-way radios; the API conjunctions apply below per arm).
  const pushWhitelist = form.enablePush === "whitelist";
  const forceWhitelist = form.enableForcePush === "whitelist";
  const deletionWhitelist = deletionMode === "whitelist";

  if (form.ruleId === 0) {
    // --- CREATE (repoCreateBranchProtection) --------------------------------
    // The exact-name collision (branch.go:698-705).
    const existing = await drizzle(d1)
      .select({ id: protectedBranches.id })
      .from(protectedBranches)
      .where(and(eq(protectedBranches.repoId, pair.repo.id), eq(protectedBranches.ruleName, form.ruleName)))
      .limit(1)
      .get();
    if (existing !== undefined) {
      return { outcome: "invalid", message: "Branch protection already exist" };
    }
    // Name resolution before anything writes (unknown names 422 the whole
    // request). The deletion and bypass arrays only load when their flag
    // conjunctions say they matter (:727-734).
    const whitelistUsers = await resolveUserIds(d1, pushWhitelist ? namesInput(form.whitelistUsers) : []);
    const forcePushUsers = await resolveUserIds(d1, forceWhitelist ? namesInput(form.forcePushAllowlistUsers) : []);
    const deletionUsers = await resolveUserIds(d1, deletionWhitelist ? namesInput(form.deletionAllowlistUsers) : []);
    const mergeUsers = await resolveUserIds(d1, form.enableMergeWhitelist ? namesInput(form.mergeWhitelistUsers) : []);
    const approvalsUsers = await resolveUserIds(d1, form.enableApprovalsWhitelist ? namesInput(form.approvalsWhitelistUsers) : []);
    const bypassUsers = await resolveUserIds(d1, form.enableBypassAllowlist ? namesInput(form.bypassAllowlistUsers) : []);
    // Teams resolve on org-owned repos only; push/force/merge/approvals
    // resolve regardless of their flags (an unknown team 422s even with the
    // flag off — the create arm's :722-769 shape). This form binds team
    // lists to their own checkboxes/radios, so each list rides its arm.
    const whitelistTeams = isOrg ? await resolveTeamIds(d1, orgId, pushWhitelist ? namesInput(form.whitelistTeams) : []) : [];
    const forcePushTeams = isOrg ? await resolveTeamIds(d1, orgId, forceWhitelist ? namesInput(form.forcePushAllowlistTeams) : []) : [];
    const deletionTeams = isOrg && deletionWhitelist ? await resolveTeamIds(d1, orgId, namesInput(form.deletionAllowlistTeams)) : [];
    const mergeTeams = isOrg ? await resolveTeamIds(d1, orgId, form.enableMergeWhitelist ? namesInput(form.mergeWhitelistTeams) : []) : [];
    const approvalsTeams = isOrg ? await resolveTeamIds(d1, orgId, form.enableApprovalsWhitelist ? namesInput(form.approvalsWhitelistTeams) : []) : [];
    const bypassTeams = isOrg && form.enableBypassAllowlist ? await resolveTeamIds(d1, orgId, namesInput(form.bypassAllowlistTeams)) : [];

    // createConfigFromOption (branch.go:786-807) — the conjunctions verbatim.
    const enablePush = form.enablePush !== "none";
    const canForcePush = enablePush && form.enableForcePush !== "none";
    const config: ProtectedBranchConfig = {
      ...emptyRuleConfig(),
      canPush: enablePush,
      enableWhitelist: enablePush && pushWhitelist,
      canForcePush,
      enableForcePushAllowlist: canForcePush && forceWhitelist,
      canDelete: enablePush && deletionMode !== "none",
      enableDeletionAllowlist: enablePush && deletionMode !== "none" && deletionWhitelist,
      enableMergeWhitelist: form.enableMergeWhitelist,
      enableBypassAllowlist: form.enableBypassAllowlist,
      enableApprovalsWhitelist: form.enableApprovalsWhitelist,
      requiredApprovals: form.requiredApprovals > 0 ? form.requiredApprovals : 0,
      blockOnRejectedReviews: form.blockOnRejectedReviews,
      blockOnOfficialReviewRequests: form.blockOnOfficialReviewRequests,
      blockOnOutdatedBranch: form.blockOnOutdatedBranch,
      dismissStaleApprovals: form.dismissStaleApprovals,
      ignoreStaleApprovals: form.ignoreStaleApprovals,
      blockAdminMergeOverride: form.blockAdminMergeOverride,
      // The unrendered arms stay the zero config (absent scalars decode as
      // Go zeros on the API arm — the honest subset).
    };
    config.whitelistUserIds = whitelistUsers;
    config.whitelistTeamIds = whitelistTeams;
    config.forcePushAllowlistUserIds = forcePushUsers;
    config.forcePushAllowlistTeamIds = forcePushTeams;
    config.deletionAllowlistUserIds = deletionUsers;
    config.deletionAllowlistTeamIds = deletionTeams;
    config.mergeWhitelistUserIds = mergeUsers;
    config.mergeWhitelistTeamIds = mergeTeams;
    config.approvalsWhitelistUserIds = approvalsUsers;
    config.approvalsWhitelistTeamIds = approvalsTeams;
    config.bypassAllowlistUserIds = bypassUsers;
    config.bypassAllowlistTeamIds = bypassTeams;

    // The M4 save-side sanitization (zero comparison side — every fresh
    // list filters; a resolved name whose principal lacks the access is
    // silently dropped, like upstream's settings multiselect).
    await sanitizeRuleWhitelists(d1, pair.repo, config, emptyRuleConfig());

    const now = new Date();
    await drizzle(d1).insert(protectedBranches).values({
      repoId: pair.repo.id,
      ruleName: form.ruleName,
      // UpdateProtectBranch's new-rule branch: priority 0 → MAX+1
      // (protected_branch.go:502-513).
      priority: sql`coalesce((select max(${protectedBranches.priority}) from ${protectedBranches} where ${protectedBranches.repoId} = ${pair.repo.id}), 0) + 1`,
      rules: serializeRuleConfig(config),
      createdAt: now,
      updatedAt: now,
    });
    const rule = (await drizzle(d1)
      .select()
      .from(protectedBranches)
      .where(and(eq(protectedBranches.repoId, pair.repo.id), eq(protectedBranches.ruleName, form.ruleName)))
      .limit(1)
      .get())!;
    await recomputeLogged(d1, pair, rule);
    return { outcome: "created", ruleName: form.ruleName };
  }

  // --- EDIT (repoEditBranchProtection, keyed by the stored name) -----------
  const rule = (
    await drizzle(d1)
      .select()
      .from(protectedBranches)
      .where(and(eq(protectedBranches.id, form.ruleId), eq(protectedBranches.repoId, pair.repo.id)))
      .limit(1)
      .get()
  );
  if (rule === undefined) return { outcome: "missing" };
  const config = parseRuleConfig(rule.rules);
  // The comparison side AS LOADED (the SliceSortedEqual short-circuit keeps
  // every list the form omitted verbatim — the M4 header).
  const stored = parseRuleConfig(rule.rules);

  config.canPush = form.enablePush !== "none";
  config.enableWhitelist = pushWhitelist;
  if (pushWhitelist) {
    config.whitelistUserIds = await resolveUserIds(d1, namesInput(form.whitelistUsers));
    config.whitelistTeamIds = isOrg ? await resolveTeamIds(d1, orgId, namesInput(form.whitelistTeams)) : [];
  } // else: the flags cleared above; the stored ids persist (the absent-array arm, :1080-1086).

  config.canForcePush = form.enableForcePush !== "none";
  config.enableForcePushAllowlist = forceWhitelist;
  if (forceWhitelist) {
    config.forcePushAllowlistUserIds = await resolveUserIds(d1, namesInput(form.forcePushAllowlistUsers));
    config.forcePushAllowlistTeamIds = isOrg ? await resolveTeamIds(d1, orgId, namesInput(form.forcePushAllowlistTeams)) : [];
  }

  config.canDelete = deletionMode !== "none";
  config.enableDeletionAllowlist = deletionWhitelist;
  if (deletionWhitelist) {
    config.deletionAllowlistUserIds = await resolveUserIds(d1, namesInput(form.deletionAllowlistUsers));
    config.deletionAllowlistTeamIds = isOrg ? await resolveTeamIds(d1, orgId, namesInput(form.deletionAllowlistTeams)) : [];
  }
  // The post-patch re-conjunction (:935-936) — deletion rides push.
  config.canDelete = config.canPush && config.canDelete;
  config.enableDeletionAllowlist = config.canDelete && config.enableDeletionAllowlist;

  config.requiredApprovals = form.requiredApprovals > 0 ? form.requiredApprovals : 0;
  config.enableApprovalsWhitelist = form.enableApprovalsWhitelist;
  if (form.enableApprovalsWhitelist) {
    config.approvalsWhitelistUserIds = await resolveUserIds(d1, namesInput(form.approvalsWhitelistUsers));
    config.approvalsWhitelistTeamIds = isOrg ? await resolveTeamIds(d1, orgId, namesInput(form.approvalsWhitelistTeams)) : [];
  }
  config.enableMergeWhitelist = form.enableMergeWhitelist;
  if (form.enableMergeWhitelist) {
    config.mergeWhitelistUserIds = await resolveUserIds(d1, namesInput(form.mergeWhitelistUsers));
    config.mergeWhitelistTeamIds = isOrg ? await resolveTeamIds(d1, orgId, namesInput(form.mergeWhitelistTeams)) : [];
  }
  config.enableBypassAllowlist = form.enableBypassAllowlist;
  if (form.enableBypassAllowlist) {
    config.bypassAllowlistUserIds = await resolveUserIds(d1, namesInput(form.bypassAllowlistUsers));
    config.bypassAllowlistTeamIds = isOrg ? await resolveTeamIds(d1, orgId, namesInput(form.bypassAllowlistTeams)) : [];
  } else {
    // The disabled arms clear their arrays before the save (:1180-1192) —
    // bypass here, deletion above through the conjunction.
    config.bypassAllowlistUserIds = [];
    config.bypassAllowlistTeamIds = [];
  }
  if (!config.enableDeletionAllowlist) {
    config.deletionAllowlistUserIds = [];
    config.deletionAllowlistTeamIds = [];
  }
  config.blockOnRejectedReviews = form.blockOnRejectedReviews;
  config.blockOnOfficialReviewRequests = form.blockOnOfficialReviewRequests;
  config.blockOnOutdatedBranch = form.blockOnOutdatedBranch;
  config.dismissStaleApprovals = form.dismissStaleApprovals;
  config.ignoreStaleApprovals = form.ignoreStaleApprovals;
  config.blockAdminMergeOverride = form.blockAdminMergeOverride;
  // The unrendered arms (status checks, signed commits, file patterns,
  // codeowner blocks — SPEC-0013 §6) keep their stored values: `config`
  // started as the parsed stored blob.

  await sanitizeRuleWhitelists(d1, pair.repo, config, stored);
  await drizzle(d1)
    .update(protectedBranches)
    .set({ rules: serializeRuleConfig(config), updatedAt: new Date() })
    .where(eq(protectedBranches.id, rule.id));
  const updated = (await drizzle(d1).select().from(protectedBranches).where(eq(protectedBranches.id, rule.id)).limit(1).get())!;
  await recomputeLogged(d1, pair, updated);
  return { outcome: "saved", ruleName: rule.ruleName };
}

/** The delete write (repoDeleteBranchProtection): the repo-scoped row
 *  deletes, the recompute runs over the NO-RULE state (the arm's own
 *  semantics — a deleted whitelist can only widen officialness), false = a
 *  missing/foreign id (404 shell). */
export async function deleteRuleById(d1: D1Database, pair: RepositoryWithOwner, id: number): Promise<boolean> {
  const rule = (
    await drizzle(d1)
      .select()
      .from(protectedBranches)
      .where(and(eq(protectedBranches.id, id), eq(protectedBranches.repoId, pair.repo.id)))
      .limit(1)
      .get()
  );
  if (rule === undefined) return false;
  await drizzle(d1).delete(protectedBranches).where(eq(protectedBranches.id, rule.id));
  const noRuleState: ProtectedBranchRow = { ...rule, rules: serializeRuleConfig(emptyRuleConfig()) };
  await recomputeLogged(d1, pair, noRuleState);
  return true;
}

/**
 * The priority write (repoUpdateBranchProtectionPriories —
 * UpdateProtectBranchPriorities, protected_branch.go:529-545): each id
 * renumbers 1-based in list order; foreign-repo ids no-op through the
 * repo_id guard; one D1 batch (the implicit tx).
 */
export async function reorderRules(d1: D1Database, repoId: string, ids: number[]): Promise<void> {
  const updates = ids.map((id, index) =>
    drizzle(d1)
      .update(protectedBranches)
      .set({ priority: index + 1 })
      .where(and(eq(protectedBranches.id, id), eq(protectedBranches.repoId, repoId))),
  );
  const [first, ...rest] = updates;
  if (first !== undefined) await drizzle(d1).batch([first, ...rest]);
}

/** Parse the repeated `ids` fields (the no-JS form's `{ids}` array —
 *  non-integers drop). */
export function parsePriorityIds(params: URLSearchParams): number[] {
  return params
    .getAll("ids")
    .map((raw) => (/^-?\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN))
    .filter((id) => Number.isSafeInteger(id));
}

// ---------------------------------------------------------------------------
// The default-branch write (branches.tmpl's SetDefaultBranchPost arm over the
// landed §2.5.2 service — the module header carries the mount recipe)
// ---------------------------------------------------------------------------

export type DefaultBranchResult =
  | { outcome: "applied"; branch: string }
  | { outcome: "missing"; branch: string }; // the engine does not know the branch — the 404 shell

/** The production setDefaultBranch seam: RepoService with the engine's
 *  setHead RPC wired (the api/routes/repo.ts PATCH wiring shape — bare
 *  construction silently skips the DO head move; D1 is the metadata truth
 *  either way, the service header). */
function productionSetDefaultBranch(env: Env): (repoId: string, branch: string) => Promise<unknown> {
  const service = new RepoService(env.DB, {
    setHead: async (engineName, branch) => (await env.REPO.getByName(engineName).setHead(branch)).tag,
  });
  return (repoId, branch) => service.setDefaultBranch(repoId, branch);
}

/**
 * The default-branch write, SetDefaultBranchPost's shape over the landed
 * `RepoService.setDefaultBranch` (SPEC-0003 §2.5.2):
 *
 * 1. the same-name POST is the service's own early no-op
 *    (SetRepoDefaultBranch, services/repository/branch.go:708-710) — still
 *    success, nothing writes (updatedAt untouched);
 * 2. any other name must exist in the SAME engine branch list the select
 *    renders (SetRepoDefaultBranch's IsBranchExist arm :711-717); missing →
 *    `missing` (the handler 404-shells — upstream's ErrBranchNotExist →
 *    ctx.Status(404); an empty repo's hand-crafted POST lands here too, its
 *    button is disabled upstream);
 * 3. the landed service writes: D1 first (the metadata truth), the engine's
 *    setHead best-effort (an "invalid"/"not_found" rejection logs, never
 *    blocks — an empty repo may point at an unborn branch, the service
 *    header).
 *
 * `setDefaultBranch` is injectable so the seam tests assert the call's
 * arguments; the handler mounts the production wiring (the default).
 */
export async function applyDefaultBranchForm(
  env: Env,
  repo: RepoRow,
  branch: string,
  setDefaultBranch: (repoId: string, branch: string) => Promise<unknown> = productionSetDefaultBranch(env),
): Promise<DefaultBranchResult> {
  if (branch !== repo.defaultBranch) {
    const names = await loadEngineBranchNames(env, repo);
    if (!names.includes(branch)) return { outcome: "missing", branch };
    await setDefaultBranch(repo.id, branch);
  }
  return { outcome: "applied", branch };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The full-document render — the rules list (§2.4.1 discriminator:
 *  `repository settings edit`, branches.tmpl's layout_head literal at this
 *  pin). */
export function renderBranchProtectionListPage(options: {
  ctx: UiContext;
  data: BranchProtectionListData;
}): string {
  return renderPage(<BranchProtectionListPage ctx={options.ctx} data={options.data} />);
}

/** The list page's render inputs. The data literal is assembled handler-side
 *  in ui/index.ts (the /settings/branches GET arm), which passes the
 *  loadRepoSettings read's has_actions (the options page's options-data
 *  twin); absent = the reduced nav without the block (the settings.tsx
 *  prop's documented reduction — the direct-render callers may omit it). */
export interface BranchProtectionListData {
  rules: RuleListItem[];
  isOrg: boolean;
  /** The `?rule_name=` flash reduction — the save POST's redirect target
   *  carries the saved rule's name (upstream's exact target,
   *  protected_branch.go:337); display-only. */
  savedRule: string | null;
  /** The default-branch select's options (loadDefaultBranchOptions —
   *  PrepareBranchList's port). Optional: w129 batch-14 sweep note — the
   *  mount wave passes it since ce52935 (the module header's MOUNTED
   *  record); the optionality is the two-stage-unmounted convention's
   *  residue — the segment still renders with the current default alone
   *  when the caller omits it. */
  branchOptions?: string[];
  /** `repo_settings.has_actions` — arms the settings nav's conditional
   *  Actions <details> (navbar.tmpl:41-59; the settings.tsx `hasActions`
   *  prop). The mounted route passes it (the ui/index.ts data literal);
   *  optional for the direct-render callers. */
  hasActions?: boolean;
}

function SettingsBranchesNav(props: { repoLink: string; repo: RepoRow; hasActions?: boolean }) {
  // The settings navbar is pages/settings.tsx's shared component (one
  // owner — imported at the top); this module renders it with `branches`
  // active. The repo row arms the conditional Public Access item
  // (navbar.tmpl:7-11 — the wave-settingsnav-fold's disclosed gap on this
  // call site closed; like the five folded tabs the grant arm reduces to
  // the visibility arm — this page loads no repo_units row, and
  // loadRepoPublicAccess's read stays the public-access page's loader).
  // The Actions block rides the hasActions pass-through (navbar.tmpl:47's
  // unit conditional — the settings.tsx prop).
  return <SettingsNavHost repoLink={props.repoLink} active="branches" repo={props.repo} hasActions={props.hasActions === true} />;
}

/** The default-branch segment (branches.tmpl:8-30 — upstream's
 *  SetDefaultBranchPost form): the h4 header, the attached segment with the
 *  desc paragraph, the POST onto the page itself (`.Link` — the request
 *  path, context.go:59) carrying the hidden `action=default_branch`, the
 *  Fomantic search dropdown reduced to a native select (the option list IS
 *  upstream's menu items, the current default the marked selection; the
 *  current default rides the form even when the engine does not know it —
 *  upstream's hidden input + `.default text` render it verbatim), the
 *  submit disabled while the repo is empty (the template's IsEmpty arm) and
 *  the target-branch help line at the form's tail. */
function DefaultBranchSegment(props: { repoLink: string; repo: RepoRow; branchOptions: string[] }) {
  const { repoLink, repo } = props;
  // PrepareBranchList tops the list with the default when it exists; an
  // unborn/unresolvable default still opens the menu (the hidden-input arm).
  const options = props.branchOptions.includes(repo.defaultBranch)
    ? props.branchOptions
    : [repo.defaultBranch, ...props.branchOptions];
  return (
    <>
      <h4 class="ui top attached header">{branchProtectionLocale.default_branch}</h4>
      <div class="ui attached segment">
        <p>{branchProtectionLocale.default_branch_desc}</p>
        <form class="ui form" action={`${repoLink}/settings/branches`} method="post">
          <input type="hidden" name="action" value="default_branch" />
          <div class="flex-text-block">
            <select
              id="default_branch"
              name="branch"
              class="ui selection dropdown tw-flex-1 tw-mr-2 tw-max-w-96"
              aria-label={branchProtectionLocale.default_branch_select_aria}
            >
              {options.map((name) => (
                <option value={name} selected={name === repo.defaultBranch}>
                  {name}
                </option>
              ))}
            </select>
            <button type="submit" class="ui primary button" disabled={repo.isEmpty || undefined}>
              {branchProtectionLocale.update_default_branch}
            </button>
          </div>
          <div class="help tw-mt-4 tw-p-0">{branchProtectionLocale.default_target_branch_desc}</div>
        </form>
      </div>
    </>
  );
}

function BranchProtectionListPage(props: { ctx: UiContext; data: BranchProtectionListData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("BranchProtectionListPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const archived = repo.isArchived;
  const rules = data.rules;
  return (
    <BaseLayout ctx={ctx} title={branchProtectionLocale.protected_branch} pageClass="repository settings edit">
      <div class="ui container flex-container">
        <SettingsBranchesNav repoLink={repoLink} repo={repo} hasActions={data.hasActions} />
        <div class="flex-container-main">
          {archived ? (
            // branches.tmpl's IsArchived arm: the warning INSTEAD of the
            // list and its controls.
            <>
              <h4 class="ui top attached header">{branchProtectionLocale.protected_branch}</h4>
              <div class="ui attached segment">
                <div class="ui warning message tw-text-center">{branchProtectionLocale.archived_unavailable}</div>
              </div>
            </>
          ) : (
            <>
              <DefaultBranchSegment repoLink={repoLink} repo={repo} branchOptions={data.branchOptions ?? []} />
              <h4 class="ui top attached header flex-left-right">
                <span>{branchProtectionLocale.protected_branch}</span>
                <a class="ui primary tiny button" href={`${repoLink}/settings/branches/edit`}>
                  {branchProtectionLocale.add_new_rule}
                </a>
              </h4>
              <div class="ui attached segment">
                {data.savedRule !== null ? (
                  <div class="ui info message">
                    {branchProtectionLocale.saved_flash} "{data.savedRule}" has been updated.
                  </div>
                ) : null}
                {rules.length === 0 ? (
                  <div class="item tw-text-center">{branchProtectionLocale.no_protected_branch}</div>
                ) : (
                  <div class="flex-divided-list items-with-main" id="protected-branches-list">
                    {rules.map((item, index) => {
                      const ruleLink = `${repoLink}/settings/branches/edit?rule_name=${encodeURIComponent(item.row.ruleName)}`;
                      // The reorder form's id list: this row swapped with its
                      // neighbor (the drag handle's no-JS stand-in); a
                      // boundary row omits its dead direction.
                      const ids = rules.map((entry) => entry.row.id);
                      const moveUp = index > 0 ? [...ids.slice(0, index - 1), ids[index]!, ids[index - 1]!, ...ids.slice(index + 1)] : null;
                      const moveDown = index < ids.length - 1 ? [...ids.slice(0, index), ids[index + 1]!, ids[index]!, ...ids.slice(index + 2)] : null;
                      const counts = ruleCountParts(item.config);
                      return (
                        <div class="item tw-items-center" data-id={item.row.id}>
                          <div class="item-main">
                            <div class="item-title flex-text-block">
                              <span class="ui tiny basic label">#{index + 1}</span>
                              <div class="ui basic primary label">{item.row.ruleName}</div>
                              {item.glob ? <span class="ui tiny label">{branchProtectionLocale.glob_badge}</span> : null}
                            </div>
                            {counts.length > 0 ? <div class="tw-text-text-light">{counts.join(" · ")}</div> : null}
                          </div>
                          <div class="item-trailing flex-text-block">
                            {moveUp !== null ? (
                              <form method="post" action={`${repoLink}/settings/branches/priority`} class="tw-inline-block">
                                {moveUp.map((id) => (
                                  <input type="hidden" name="ids" value={String(id)} />
                                ))}
                                <button type="submit" class="ui tiny icon button" aria-label={branchProtectionLocale.move_up_aria}>
                                  ↑
                                </button>
                              </form>
                            ) : null}
                            {moveDown !== null ? (
                              <form method="post" action={`${repoLink}/settings/branches/priority`} class="tw-inline-block">
                                {moveDown.map((id) => (
                                  <input type="hidden" name="ids" value={String(id)} />
                                ))}
                                <button type="submit" class="ui tiny icon button" aria-label={branchProtectionLocale.move_down_aria}>
                                  ↓
                                </button>
                              </form>
                            ) : null}
                            <a class="ui tiny button" href={ruleLink}>
                              {branchProtectionLocale.edit_protected_branch}
                            </a>
                            <form method="post" action={`${repoLink}/settings/branches/${item.row.id}/delete`} class="tw-inline-block">
                              <button type="submit" class="ui red tiny button">
                                {branchProtectionLocale.delete_rule}
                              </button>
                            </form>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-document render — the create/edit form (§2.4.1 discriminator:
 *  `repository settings branches`, protected_branch.tmpl's layout_head
 *  literal at this pin). */
export function renderBranchProtectionEditPage(options: {
  ctx: UiContext;
  data: BranchProtectionEditData;
  error: string | null;
}): string {
  return renderPage(<BranchProtectionEditPage ctx={options.ctx} data={options.data} error={options.error} />);
}

/** The edit page's render inputs: the form binding (the stored values on a
 *  plain GET, the kept submission on a re-render), the org gate for the
 *  team inputs and the rule under edit (null = the create form). Same
 *  hasActions shape as BranchProtectionListData (both /settings/branches
 *  edit arms pass the loadRepoSettings read's flag handler-side). */
export interface BranchProtectionEditData {
  form: BranchProtectionForm;
  isOrg: boolean;
  rule: RuleListItem | null;
  /** `repo_settings.has_actions` — arms the settings nav's conditional
   *  Actions <details> (navbar.tmpl:41-59; the settings.tsx `hasActions`
   *  prop). The mounted routes pass it; optional for the direct-render
   *  callers. */
  hasActions?: boolean;
}

/** One radio trio field (the template's `.ui.radio.checkbox` shapes with
 *  the upstream value/label pairs). */
function RadioField(props: { name: string; value: string; label: string; help: string; current: string; id: string }) {
  return (
    <div class="field">
      <div class="ui radio checkbox">
        <input id={props.id} name={props.name} type="radio" value={props.value} checked={props.current === props.value} />
        <label for={props.id}>{props.label}</label>
      </div>
      <p class="help">{props.help}</p>
    </div>
  );
}

/** One checkbox field (the template's `.ui.checkbox` shape). */
function CheckboxField(props: { id: string; name: string; label: string; checked: boolean }) {
  return (
    <div class="field">
      <div class="ui checkbox">
        <input id={props.id} name={props.name} type="checkbox" checked={props.checked} />
        <label for={props.id}>{props.label}</label>
      </div>
    </div>
  );
}

/** One comma-separated names field (the dropdown multiselect's no-JS
 *  replacement — the module header). */
function NamesField(props: { id: string; name: string; label: string; value: string }) {
  return (
    <div class="field">
      <label for={props.id}>{props.label}</label>
      <input id={props.id} name={props.name} type="text" value={props.value} autocomplete="off" />
      <p class="help">{branchProtectionLocale.names_help}</p>
    </div>
  );
}

function BranchProtectionEditPage(props: { ctx: UiContext; data: BranchProtectionEditData; error: string | null }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("BranchProtectionEditPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const form = data.form;
  const editing = data.rule !== null;
  return (
    <BaseLayout
      ctx={ctx}
      title={editing ? branchProtectionLocale.protected_branch : branchProtectionLocale.add_new_rule}
      pageClass="repository settings branches"
    >
      <div class="ui container flex-container">
        <SettingsBranchesNav repoLink={repoLink} repo={repo} hasActions={data.hasActions} />
        <div class="flex-container-main">
          {repo.isArchived ? (
            // The POST would 404 (RepoMustNotBeArchived) — the warning
            // replaces the guaranteed-dead form (module header).
            <>
              <h4 class="ui top attached header">{branchProtectionLocale.protected_branch}</h4>
              <div class="ui attached segment">
                <div class="ui warning message tw-text-center">{branchProtectionLocale.archived_unavailable}</div>
              </div>
            </>
          ) : (
            <form class="ui form" action={`${repoLink}/settings/branches/edit`} method="post">
              <h4 class="ui top attached header">
                {editing ? (
                  <span>
                    {branchProtectionLocale.branch_protection_prefix}
                    <b>{data.rule!.row.ruleName}</b>
                    {branchProtectionLocale.branch_protection_suffix}
                  </span>
                ) : (
                  branchProtectionLocale.add_new_rule
                )}
              </h4>
              <div class="ui attached segment branch-protection">
                {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
                <h5 class="ui dividing header">{branchProtectionLocale.patterns}</h5>
                <div class="required field">
                  <label for="rule_name">{branchProtectionLocale.name_pattern}</label>
                  <input
                    id="rule_name"
                    name="rule_name"
                    type="text"
                    value={form.ruleName}
                    required={editing ? undefined : true}
                    readonly={editing ? true : undefined}
                  />
                  <input type="hidden" name="rule_id" value={String(form.ruleId)} />
                  {editing ? (
                    <p class="help">{branchProtectionLocale.readonly_name_note}</p>
                  ) : (
                    <p class="help">{branchProtectionLocale.name_pattern_help}</p>
                  )}
                </div>

                <h5 class="ui dividing header">{branchProtectionLocale.event_push}</h5>
                <RadioField
                  id="enable_push_none"
                  name="enable_push"
                  value="none"
                  label={branchProtectionLocale.disable_push}
                  help="No pushing will be allowed to this branch."
                  current={form.enablePush}
                />
                <RadioField
                  id="enable_push_all"
                  name="enable_push"
                  value="all"
                  label={branchProtectionLocale.enable_push}
                  help="Anyone with write access will be allowed to push to this branch (but not force push)."
                  current={form.enablePush}
                />
                <div class="grouped fields">
                  <RadioField
                    id="enable_push_whitelist"
                    name="enable_push"
                    value="whitelist"
                    label={branchProtectionLocale.whitelist_committers}
                    help="Only allowlisted users or teams will be allowed to push to this branch (but not force push)."
                    current={form.enablePush}
                  />
                  <NamesField id="whitelist_users" name="whitelist_users" label={branchProtectionLocale.whitelist_users} value={form.whitelistUsers} />
                  {data.isOrg ? (
                    <NamesField id="whitelist_teams" name="whitelist_teams" label={branchProtectionLocale.whitelist_teams} value={form.whitelistTeams} />
                  ) : null}
                </div>

                <h5 class="ui dividing header">{branchProtectionLocale.event_force_push}</h5>
                <RadioField
                  id="enable_force_push_none"
                  name="enable_force_push"
                  value="none"
                  label={branchProtectionLocale.disable_force_push}
                  help="No force pushing will be allowed to this branch."
                  current={form.enableForcePush}
                />
                <RadioField
                  id="enable_force_push_all"
                  name="enable_force_push"
                  value="all"
                  label={branchProtectionLocale.enable_force_push_all}
                  help="Anyone with push access will be allowed to force push to this branch."
                  current={form.enableForcePush}
                />
                <div class="grouped fields">
                  <RadioField
                    id="enable_force_push_whitelist"
                    name="enable_force_push"
                    value="whitelist"
                    label={branchProtectionLocale.enable_force_push_allowlist}
                    help="Only allowlisted users or teams with push access will be allowed to force push to this branch."
                    current={form.enableForcePush}
                  />
                  <NamesField
                    id="force_push_allowlist_users"
                    name="force_push_allowlist_users"
                    label={branchProtectionLocale.force_push_allowlist_users}
                    value={form.forcePushAllowlistUsers}
                  />
                  {data.isOrg ? (
                    <NamesField
                      id="force_push_allowlist_teams"
                      name="force_push_allowlist_teams"
                      label={branchProtectionLocale.force_push_allowlist_teams}
                      value={form.forcePushAllowlistTeams}
                    />
                  ) : null}
                </div>

                <h5 class="ui dividing header">{branchProtectionLocale.event_branch_delete}</h5>
                <RadioField
                  id="enable_deletion_none"
                  name="enable_deletion"
                  value="none"
                  label={branchProtectionLocale.disable_deletion}
                  help="No branch deletion will be allowed for this branch."
                  current={form.enableDeletion}
                />
                <RadioField
                  id="enable_deletion_all"
                  name="enable_deletion"
                  value="all"
                  label={branchProtectionLocale.enable_deletion_all}
                  help="Anyone with push access will be allowed to delete this branch."
                  current={form.enableDeletion}
                />
                <div class="grouped fields">
                  <RadioField
                    id="enable_deletion_whitelist"
                    name="enable_deletion"
                    value="whitelist"
                    label={branchProtectionLocale.enable_deletion_allowlist}
                    help="Only allowlisted users or teams with push access will be allowed to delete this branch."
                    current={form.enableDeletion}
                  />
                  <NamesField
                    id="deletion_allowlist_users"
                    name="deletion_allowlist_users"
                    label={branchProtectionLocale.deletion_allowlist_users}
                    value={form.deletionAllowlistUsers}
                  />
                  {data.isOrg ? (
                    <NamesField
                      id="deletion_allowlist_teams"
                      name="deletion_allowlist_teams"
                      label={branchProtectionLocale.deletion_allowlist_teams}
                      value={form.deletionAllowlistTeams}
                    />
                  ) : null}
                </div>

                <h5 class="ui dividing header">{branchProtectionLocale.event_pull_request_approvals}</h5>
                <div class="field">
                  <label for="required_approvals">{branchProtectionLocale.required_approvals}</label>
                  <input id="required_approvals" name="required_approvals" type="number" min="0" value={String(form.requiredApprovals)} />
                </div>
                <div class="grouped fields">
                  <CheckboxField
                    id="enable_approvals_whitelist"
                    name="enable_approvals_whitelist"
                    label={branchProtectionLocale.approvals_whitelist_enabled}
                    checked={form.enableApprovalsWhitelist}
                  />
                  <NamesField
                    id="approvals_whitelist_users"
                    name="approvals_whitelist_users"
                    label={branchProtectionLocale.approvals_whitelist_users}
                    value={form.approvalsWhitelistUsers}
                  />
                  {data.isOrg ? (
                    <NamesField
                      id="approvals_whitelist_teams"
                      name="approvals_whitelist_teams"
                      label={branchProtectionLocale.approvals_whitelist_teams}
                      value={form.approvalsWhitelistTeams}
                    />
                  ) : null}
                </div>
                <CheckboxField
                  id="dismiss_stale_approvals"
                  name="dismiss_stale_approvals"
                  label={branchProtectionLocale.dismiss_stale_approvals}
                  checked={form.dismissStaleApprovals}
                />
                <CheckboxField
                  id="ignore_stale_approvals"
                  name="ignore_stale_approvals"
                  label={branchProtectionLocale.ignore_stale_approvals}
                  checked={form.ignoreStaleApprovals}
                />

                <h5 class="ui dividing header">{branchProtectionLocale.event_pull_request_merge}</h5>
                <CheckboxField
                  id="enable_merge_whitelist"
                  name="enable_merge_whitelist"
                  label={branchProtectionLocale.merge_whitelist_committers}
                  checked={form.enableMergeWhitelist}
                />
                <NamesField id="merge_whitelist_users" name="merge_whitelist_users" label={branchProtectionLocale.merge_whitelist_users} value={form.mergeWhitelistUsers} />
                {data.isOrg ? (
                  <NamesField id="merge_whitelist_teams" name="merge_whitelist_teams" label={branchProtectionLocale.merge_whitelist_teams} value={form.mergeWhitelistTeams} />
                ) : null}

                <h5 class="ui dividing header">{branchProtectionLocale.bypass_allowlist}</h5>
                <CheckboxField
                  id="enable_bypass_allowlist"
                  name="enable_bypass_allowlist"
                  label={branchProtectionLocale.enable_bypass_allowlist}
                  checked={form.enableBypassAllowlist}
                />
                <NamesField id="bypass_allowlist_users" name="bypass_allowlist_users" label={branchProtectionLocale.bypass_allowlist_users} value={form.bypassAllowlistUsers} />
                {data.isOrg ? (
                  <NamesField id="bypass_allowlist_teams" name="bypass_allowlist_teams" label={branchProtectionLocale.bypass_allowlist_teams} value={form.bypassAllowlistTeams} />
                ) : null}

                <CheckboxField
                  id="block_on_rejected_reviews"
                  name="block_on_rejected_reviews"
                  label={branchProtectionLocale.block_rejected_reviews}
                  checked={form.blockOnRejectedReviews}
                />
                <CheckboxField
                  id="block_on_official_review_requests"
                  name="block_on_official_review_requests"
                  label={branchProtectionLocale.block_on_official_review_requests}
                  checked={form.blockOnOfficialReviewRequests}
                />
                <CheckboxField
                  id="block_on_outdated_branch"
                  name="block_on_outdated_branch"
                  label={branchProtectionLocale.block_outdated_branch}
                  checked={form.blockOnOutdatedBranch}
                />
                <CheckboxField
                  id="block_admin_merge_override"
                  name="block_admin_merge_override"
                  label={branchProtectionLocale.block_admin_merge_override}
                  checked={form.blockAdminMergeOverride}
                />

                <p class="help">{branchProtectionLocale.unenforced_note}</p>
                <div class="field">
                  <button type="submit" class="ui primary button">
                    {branchProtectionLocale.save_rule}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    </BaseLayout>
  );
}

// (the settings navbar is pages/settings.tsx's shared component, imported
// above as SettingsNavHost — one owner, no re-export).
