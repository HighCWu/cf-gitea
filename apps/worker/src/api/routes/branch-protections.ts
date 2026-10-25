import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";

import { protectedBranches, teams, users } from "../../db/schema";
import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import {
  emptyRuleConfig,
  isRuleNameSpecial,
  listRepoRules,
  parseRuleConfig,
  recomputeOfficialForRule,
  serializeRuleConfig,
  type ProtectedBranchConfig,
} from "../../services/branch-protection";
import type { RepositoryWithOwner } from "../services/repository";
import { assertNotArchived, requireRepoAdmin, requireVisibleRepo } from "../services/repo-access";

/**
 * SPEC-0013 §3.6 — the `/repos/{owner}/{repo}/branch_protections` API family
 * (6 frozen operations, the contract rows verified against the vendored
 * swagger): repoListBranchProtection, repoGetBranchProtection,
 * repoCreateBranchProtection, repoEditBranchProtection,
 * repoDeleteBranchProtection, repoUpdateBranchProtectionPriories.
 *
 * MIDDLEWARE — upstream mounts the whole group with `reqToken(), reqAdmin()`
 * (routers/api/v1/api.go:1323-1332) and adds `mustNotBeArchived` to the four
 * writes (create, edit, delete, priority). Ours: [requireAuth] +
 * requireVisibleRepo (the 404 arm) + requireRepoAdmin (the 403 arm) +
 * assertNotArchived (423). RUNTIME-ONLY codes the handlers can emit that the
 * vendored contract omits (the orchestrator-owned RUNTIME_ONLY_RESPONSES
 * table is not extended by this module — the branches.ts batch pattern):
 *   - 401 on every op (upstream reqToken; the contract's error family
 *     declares no 401 anywhere in this tag);
 *   - 403 on the reads for a non-admin (reqAdmin; only the create declares
 *     403);
 *   - 423 on DELETE for an archived repo (mustNotBeArchived IS upstream's
 *     delete middleware, branch.go route group — the swagger omits it there).
 * Declared sets mirror the contract exactly: list {200}, get {200,404},
 * create {201,403,404,422,423}, edit {200,404,422,423}, delete {204,404},
 * priority {204,404,422,423}.
 *
 * NAME RESOLUTION — GetProtectedBranchRuleByName is an EXACT rule-name row
 * lookup (protected_branch.go:370-378: `repo_id = ? AND branch_name = ?`),
 * NOT the glob first-match the gates use; the {name} path parameter is a rule
 * name ("a branch name or a glob match to branch name"). Missing rule and
 * foreign-repo rule are the same plain 404 (ctx.APIErrorNotFound).
 *
 * CREATE semantics (branch.go:652-845): `rule_name` falls back to the
 * deprecated `branch_name` (:689-692); both empty is upstream's runtime 400
 * "both rule_name and branch_name are empty" (:693-696 — undeclared in the
 * contract, same runtime-only family as the 401s above); collision on the
 * exact name is 403 "Branch protection already exist" (:698-705); the config
 * blobs out of the push/deletion flag conjunctions (:786-807); usernames
 * resolve name→id with upstream's 422 error text on unknown
 * (loadBranchProtectionUserIDs → ErrUserNotExist, "user does not exist [uid:
 * 0, name: X]"), team names only on org-owned repos with 422
 * "team does not exist [org_id N, team_id 0, name: X]" (GetTeamIDsByNames);
 * the system pseudo-principals resolve too (GetDoerUserIDsByNamesWithSystem:
 * "gitea-actions" → -2, "gitea:deploy-key" → -3, user_system.go:51). A new
 * rule with priority 0 gets MAX(priority)+1 (UpdateProtectBranch's new-rule
 * branch, protected_branch.go:502-513).
 *
 * EDIT semantics (branch.go:855-1195): all-scalar fields are pointers —
 * absent ≠ false; the push/force-push masters cascade their sub-flags
 * (enable_push=false clears the push whitelist; branch.go:894-929);
 * can_delete and enable_deletion_allowlist re-conjoin onto can_push after
 * the patches (:935-936); whitelists keep the stored ids when the name array
 * is absent (:1080-1086); the bypass and deletion arrays clear when their
 * enable flags are off (:1180-1192); deploy-key pseudo-id tracking follows
 * the handler's legacySetDeployKeyAllowlist dance (:875-881, :1085-1098).
 *
 * THE RECOMPUTE (M1's as-built "wired at M3") — every mutating arm that
 * changes what a rule means (create, edit, delete) calls
 * recomputeOfficialForRule over the open PRs the rule matches (upstream's
 * CheckPRsForBaseBranch fan-out, services/pull/protected_branch.go:13-47;
 * the glob arm is our recompute's matched-base-branch loop). Upstream skips
 * the fan-out on delete; we run it there too — a deleted whitelist can only
 * widen officialness, so the stored flags would go stale exactly when
 * upstream's omission leaves them. The priority op does NOT recompute
 * (upstream-parity; ordering changes first-match, not any single rule's
 * predicates). The rewritten count is logged — the OQ-3 instrument.
 *
 * M4 DEFERRAL (recorded per SPEC-0013 §5): the save-side whitelist
 * sanitization (updateUserWhitelist's CanWrite filter, updateApprovalWhitelist,
 * updateTeamWhitelist — protected_branch.go:549-624) is M4's milestone; M3
 * stores the RESOLVED ids verbatim, and the render maps ids→names without
 * upstream's readers filter (getAllowListUserNames, convert.go:123-137) —
 * vanished principals render as nothing, never invented.
 */

const DEPLOY_KEY_USER_ID = -3; // user_model.DeployKeyUserID (user_system.go:51)
const ACTIONS_USER_ID = -2; // user_model.ActionsUserID — resolvable by name

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const repoArchivedResponse = {
  description: "repoArchivedError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/** Body bind hook for the operations with a declared 422 (Go bind parity). */
const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Wire schemas (route-local: the module owns its contract shapes).
// ---------------------------------------------------------------------------

/** The rendered BranchProtection (structs/repo_branch.go:33-80) — every field
 *  renders (Go structs carry no omitempty), including the deprecated
 *  `branch_name` and the upstream json-tag quirk `approvals_whitelist_username`
 *  (singular; the Go field is ApprovalsWhitelistUsernames). */
export const branchProtectionSchema = z.object({
  branch_name: z.string().openapi({ description: "deprecated (but useful): the rule name when it is a plain branch name, else empty" }),
  rule_name: z.string().openapi({ description: "name of the branch protection rule (a branch name or a glob)" }),
  priority: z.number().int().openapi({ format: "int64", description: "the priority of this branch protection rule" }),
  enable_push: z.boolean(),
  enable_push_whitelist: z.boolean(),
  push_whitelist_usernames: z.array(z.string()),
  push_whitelist_teams: z.array(z.string()),
  push_whitelist_deploy_keys: z.boolean(),
  enable_force_push: z.boolean(),
  enable_force_push_allowlist: z.boolean(),
  force_push_allowlist_usernames: z.array(z.string()),
  force_push_allowlist_teams: z.array(z.string()),
  force_push_allowlist_deploy_keys: z.boolean(),
  enable_deletion: z.boolean(),
  enable_deletion_allowlist: z.boolean(),
  deletion_allowlist_usernames: z.array(z.string()),
  deletion_allowlist_teams: z.array(z.string()),
  enable_merge_whitelist: z.boolean(),
  merge_whitelist_usernames: z.array(z.string()),
  merge_whitelist_teams: z.array(z.string()),
  enable_bypass_allowlist: z.boolean(),
  bypass_allowlist_usernames: z.array(z.string()),
  bypass_allowlist_teams: z.array(z.string()),
  enable_status_check: z.boolean(),
  status_check_contexts: z.array(z.string()),
  required_approvals: z.number().int().openapi({ format: "int64" }),
  enable_approvals_whitelist: z.boolean(),
  approvals_whitelist_username: z.array(z.string()),
  approvals_whitelist_teams: z.array(z.string()),
  block_on_rejected_reviews: z.boolean(),
  block_on_official_review_requests: z.boolean(),
  block_on_codeowner_reviews: z.boolean(),
  block_on_outdated_branch: z.boolean(),
  dismiss_stale_approvals: z.boolean(),
  ignore_stale_approvals: z.boolean(),
  require_signed_commits: z.boolean(),
  protected_file_patterns: z.string(),
  unprotected_file_patterns: z.string(),
  block_admin_merge_override: z.boolean(),
  created_at: z.string().openapi({ format: "date-time" }),
  updated_at: z.string().openapi({ format: "date-time" }),
});

/** CreateBranchProtectionOption (:83-124) — absent scalars decode as Go zeros. */
const createOptionShape = {
  branch_name: z.string().optional().openapi({ description: "deprecated: fallback for rule_name" }),
  rule_name: z.string().optional().openapi({ description: "the rule name (a branch name or a glob)" }),
  priority: z.number().int().optional().openapi({ format: "int64" }),
  enable_push: z.boolean().optional(),
  enable_push_whitelist: z.boolean().optional(),
  push_whitelist_usernames: z.array(z.string()).optional(),
  push_whitelist_teams: z.array(z.string()).optional(),
  push_whitelist_deploy_keys: z.boolean().optional(),
  enable_force_push: z.boolean().optional(),
  enable_force_push_allowlist: z.boolean().optional(),
  force_push_allowlist_usernames: z.array(z.string()).optional(),
  force_push_allowlist_teams: z.array(z.string()).optional(),
  force_push_allowlist_deploy_keys: z.boolean().optional(),
  enable_deletion: z.boolean().optional(),
  enable_deletion_allowlist: z.boolean().optional(),
  deletion_allowlist_usernames: z.array(z.string()).optional(),
  deletion_allowlist_teams: z.array(z.string()).optional(),
  enable_merge_whitelist: z.boolean().optional(),
  merge_whitelist_usernames: z.array(z.string()).optional(),
  merge_whitelist_teams: z.array(z.string()).optional(),
  enable_bypass_allowlist: z.boolean().optional(),
  bypass_allowlist_usernames: z.array(z.string()).optional(),
  bypass_allowlist_teams: z.array(z.string()).optional(),
  enable_status_check: z.boolean().optional(),
  status_check_contexts: z.array(z.string()).optional(),
  required_approvals: z.number().int().optional().openapi({ format: "int64" }),
  enable_approvals_whitelist: z.boolean().optional(),
  approvals_whitelist_username: z.array(z.string()).optional(),
  approvals_whitelist_teams: z.array(z.string()).optional(),
  block_on_rejected_reviews: z.boolean().optional(),
  block_on_official_review_requests: z.boolean().optional(),
  block_on_codeowner_reviews: z.boolean().optional(),
  block_on_outdated_branch: z.boolean().optional(),
  dismiss_stale_approvals: z.boolean().optional(),
  ignore_stale_approvals: z.boolean().optional(),
  require_signed_commits: z.boolean().optional(),
  protected_file_patterns: z.string().optional(),
  unprotected_file_patterns: z.string().optional(),
  block_admin_merge_override: z.boolean().optional(),
} as const;

/** EditBranchProtectionOption (:127-165) — no name fields (a rule cannot be
 *  renamed); absent scalars mean KEEP (the pointer semantics). */
const editOptionShape = {
  priority: z.number().int().optional().openapi({ format: "int64" }),
  enable_push: z.boolean().optional(),
  enable_push_whitelist: z.boolean().optional(),
  push_whitelist_usernames: z.array(z.string()).optional(),
  push_whitelist_teams: z.array(z.string()).optional(),
  push_whitelist_deploy_keys: z.boolean().optional(),
  enable_force_push: z.boolean().optional(),
  enable_force_push_allowlist: z.boolean().optional(),
  force_push_allowlist_usernames: z.array(z.string()).optional(),
  force_push_allowlist_teams: z.array(z.string()).optional(),
  force_push_allowlist_deploy_keys: z.boolean().optional(),
  enable_deletion: z.boolean().optional(),
  enable_deletion_allowlist: z.boolean().optional(),
  deletion_allowlist_usernames: z.array(z.string()).optional(),
  deletion_allowlist_teams: z.array(z.string()).optional(),
  enable_merge_whitelist: z.boolean().optional(),
  merge_whitelist_usernames: z.array(z.string()).optional(),
  merge_whitelist_teams: z.array(z.string()).optional(),
  enable_bypass_allowlist: z.boolean().optional(),
  bypass_allowlist_usernames: z.array(z.string()).optional(),
  bypass_allowlist_teams: z.array(z.string()).optional(),
  enable_status_check: z.boolean().optional(),
  status_check_contexts: z.array(z.string()).optional(),
  required_approvals: z.number().int().optional().openapi({ format: "int64" }),
  enable_approvals_whitelist: z.boolean().optional(),
  approvals_whitelist_username: z.array(z.string()).optional(),
  approvals_whitelist_teams: z.array(z.string()).optional(),
  block_on_rejected_reviews: z.boolean().optional(),
  block_on_official_review_requests: z.boolean().optional(),
  block_on_codeowner_reviews: z.boolean().optional(),
  block_on_outdated_branch: z.boolean().optional(),
  dismiss_stale_approvals: z.boolean().optional(),
  ignore_stale_approvals: z.boolean().optional(),
  require_signed_commits: z.boolean().optional(),
  protected_file_patterns: z.string().optional(),
  unprotected_file_patterns: z.string().optional(),
  block_admin_merge_override: z.boolean().optional(),
} as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const protectionNameParam = {
  name: z.string().min(1).openapi({ description: "name of protected branch" }),
} as const;

// ---------------------------------------------------------------------------
// Handler helpers — the upstream ports, in handler order.
// ---------------------------------------------------------------------------

type ProtectionRow = typeof protectedBranches.$inferSelect;

/** GetProtectedBranchRuleByName (protected_branch.go:370-378) — EXACT name. */
async function findRuleByName(d1: D1Database, repoId: string, ruleName: string): Promise<ProtectionRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(protectedBranches)
    .where(and(eq(protectedBranches.repoId, repoId), eq(protectedBranches.ruleName, ruleName)))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

/** ctx.APIErrorNotFound — the plain shared-404 (unknown repo is already gone
 *  behind requireVisibleRepo's anti-enumeration 404). */
function requireRule(rule: ProtectionRow | null): ProtectionRow {
  if (rule === null) {
    throw new ApiError(404, "not found");
  }
  return rule;
}

/** legacySetDeployKeyAllowlist (branch.go:868-873) — the pseudo-id carve. */
function setDeployKeyAllowlist(userIds: number[], enabled: boolean): number[] {
  if (!enabled) {
    return userIds.filter((id) => id !== DEPLOY_KEY_USER_ID);
  }
  return userIds.includes(DEPLOY_KEY_USER_ID) ? userIds : [...userIds, DEPLOY_KEY_USER_ID];
}

/**
 * loadBranchProtectionUserIDs (branch.go:709-724) + getDoerUsersByNames'
 * system-user arm: absent array → null (the caller's keep/empty signal);
 * present → every name resolves (case-insensitively; the two system
 * pseudo-names too) or the whole request 422s with upstream's exact text.
 */
async function resolveUserIds(d1: D1Database, names: string[] | undefined): Promise<number[] | null> {
  if (names === undefined) {
    return null;
  }
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
    const row = (await drizzle(d1).select({ id: users.id }).from(users).where(eq(users.usernameLower, lower)).limit(1).all())[0];
    if (row === undefined) {
      // ErrUserNotExist.Error() (models/user/error.go:46) — name lookups carry uid 0.
      throw new ApiError(422, `user does not exist [uid: 0, name: ${name}]`);
    }
    ids.push(row.id);
  }
  return ids;
}

/** GetTeamIDsByNames (organization/team.go) — org-scoped, case-insensitive. */
async function resolveTeamIds(d1: D1Database, orgId: number, names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const row = (
      await drizzle(d1)
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.orgId, orgId), eq(teams.lowerName, name.toLowerCase())))
        .limit(1)
        .all()
    )[0];
    if (row === undefined) {
      // ErrTeamNotExist.Error() (models/organization/team.go:65) — a name
      // lookup carries team_id 0.
      throw new ApiError(422, `team does not exist [org_id ${orgId}, team_id 0, name: ${name}]`);
    }
    ids.push(row.id);
  }
  return ids;
}

/** CreateBranchProtection's config mapping (branch.go:786-807) — the push/
 *  deletion sub-flags conjoin onto the masters verbatim. */
function createConfigFromOption(form: {
  enable_push?: boolean;
  enable_push_whitelist?: boolean;
  enable_force_push?: boolean;
  enable_force_push_allowlist?: boolean;
  enable_deletion?: boolean;
  enable_deletion_allowlist?: boolean;
  enable_merge_whitelist?: boolean;
  enable_bypass_allowlist?: boolean;
  enable_status_check?: boolean;
  status_check_contexts?: string[];
  enable_approvals_whitelist?: boolean;
  required_approvals?: number;
  block_on_rejected_reviews?: boolean;
  block_on_official_review_requests?: boolean;
  block_on_codeowner_reviews?: boolean;
  block_on_outdated_branch?: boolean;
  dismiss_stale_approvals?: boolean;
  ignore_stale_approvals?: boolean;
  require_signed_commits?: boolean;
  protected_file_patterns?: string;
  unprotected_file_patterns?: string;
  block_admin_merge_override?: boolean;
}): ProtectedBranchConfig {
  const enablePush = form.enable_push === true;
  const enableForcePush = form.enable_force_push === true;
  const enableDeletion = form.enable_deletion === true;
  return {
    ...emptyRuleConfig(),
    canPush: enablePush,
    enableWhitelist: enablePush && form.enable_push_whitelist === true,
    canForcePush: enablePush && enableForcePush,
    enableForcePushAllowlist: enablePush && enableForcePush && form.enable_force_push_allowlist === true,
    canDelete: enablePush && enableDeletion,
    enableDeletionAllowlist: enablePush && enableDeletion && form.enable_deletion_allowlist === true,
    enableMergeWhitelist: form.enable_merge_whitelist === true,
    enableBypassAllowlist: form.enable_bypass_allowlist === true,
    enableStatusCheck: form.enable_status_check === true,
    statusCheckContexts: form.status_check_contexts ?? [],
    enableApprovalsWhitelist: form.enable_approvals_whitelist === true,
    requiredApprovals: form.required_approvals !== undefined && form.required_approvals > 0 ? form.required_approvals : 0,
    blockOnRejectedReviews: form.block_on_rejected_reviews === true,
    blockOnOfficialReviewRequests: form.block_on_official_review_requests === true,
    blockOnCodeownerReviews: form.block_on_codeowner_reviews === true,
    blockOnOutdatedBranch: form.block_on_outdated_branch === true,
    dismissStaleApprovals: form.dismiss_stale_approvals === true,
    ignoreStaleApprovals: form.ignore_stale_approvals === true,
    requireSignedCommits: form.require_signed_commits === true,
    protectedFilePatterns: form.protected_file_patterns ?? "",
    unprotectedFilePatterns: form.unprotected_file_patterns ?? "",
    blockAdminMergeOverride: form.block_admin_merge_override === true,
  };
}

/**
 * ToBranchProtection (services/convert/convert.go:151-215) — the read-and-echo
 * render over the storage JSON. The allowlist id arrays map to names in id
 * order; vanished ids render as nothing (the readers-filter nuance is M4's).
 */
async function renderProtection(d1: D1Database, row: ProtectionRow): Promise<z.infer<typeof branchProtectionSchema>> {
  const config = parseRuleConfig(row.rules);
  const userIdMap = new Map<number, string>();
  const referencedUserIds = [
    ...new Set([
      ...config.whitelistUserIds,
      ...config.forcePushAllowlistUserIds,
      ...config.deletionAllowlistUserIds,
      ...config.mergeWhitelistUserIds,
      ...config.approvalsWhitelistUserIds,
      ...config.bypassAllowlistUserIds,
    ]),
  ].filter((id) => id > 0);
  if (referencedUserIds.length > 0) {
    for (const row of await drizzle(d1).select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, referencedUserIds)).all()) {
      userIdMap.set(row.id, row.username);
    }
  }
  const usernamesOf = (ids: number[]): string[] => ids.map((id) => userIdMap.get(id)).filter((name): name is string => name !== undefined);
  const teamIds = [...new Set([...config.whitelistTeamIds, ...config.forcePushAllowlistTeamIds, ...config.deletionAllowlistTeamIds, ...config.mergeWhitelistTeamIds, ...config.approvalsWhitelistTeamIds, ...config.bypassAllowlistTeamIds])];
  const teamNameMap = new Map<number, string>();
  if (teamIds.length > 0) {
    for (const row of await drizzle(d1).select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, teamIds)).all()) {
      teamNameMap.set(row.id, row.name);
    }
  }
  const teamNamesOf = (ids: number[]): string[] => ids.map((id) => teamNameMap.get(id)).filter((name): name is string => name !== undefined);

  return {
    branch_name: isRuleNameSpecial(row.ruleName) ? "" : row.ruleName,
    rule_name: row.ruleName,
    priority: row.priority,
    enable_push: config.canPush,
    enable_push_whitelist: config.enableWhitelist,
    push_whitelist_usernames: usernamesOf(config.whitelistUserIds),
    push_whitelist_teams: teamNamesOf(config.whitelistTeamIds),
    push_whitelist_deploy_keys: config.whitelistUserIds.includes(DEPLOY_KEY_USER_ID),
    enable_force_push: config.canForcePush,
    enable_force_push_allowlist: config.enableForcePushAllowlist,
    force_push_allowlist_usernames: usernamesOf(config.forcePushAllowlistUserIds),
    force_push_allowlist_teams: teamNamesOf(config.forcePushAllowlistTeamIds),
    force_push_allowlist_deploy_keys: config.forcePushAllowlistUserIds.includes(DEPLOY_KEY_USER_ID),
    enable_deletion: config.canDelete,
    enable_deletion_allowlist: config.enableDeletionAllowlist,
    deletion_allowlist_usernames: usernamesOf(config.deletionAllowlistUserIds),
    deletion_allowlist_teams: teamNamesOf(config.deletionAllowlistTeamIds),
    enable_merge_whitelist: config.enableMergeWhitelist,
    merge_whitelist_usernames: usernamesOf(config.mergeWhitelistUserIds),
    merge_whitelist_teams: teamNamesOf(config.mergeWhitelistTeamIds),
    enable_bypass_allowlist: config.enableBypassAllowlist,
    bypass_allowlist_usernames: usernamesOf(config.bypassAllowlistUserIds),
    bypass_allowlist_teams: teamNamesOf(config.bypassAllowlistTeamIds),
    enable_status_check: config.enableStatusCheck,
    status_check_contexts: config.statusCheckContexts,
    required_approvals: config.requiredApprovals,
    enable_approvals_whitelist: config.enableApprovalsWhitelist,
    approvals_whitelist_username: usernamesOf(config.approvalsWhitelistUserIds),
    approvals_whitelist_teams: teamNamesOf(config.approvalsWhitelistTeamIds),
    block_on_rejected_reviews: config.blockOnRejectedReviews,
    block_on_official_review_requests: config.blockOnOfficialReviewRequests,
    block_on_codeowner_reviews: config.blockOnCodeownerReviews,
    block_on_outdated_branch: config.blockOnOutdatedBranch,
    dismiss_stale_approvals: config.dismissStaleApprovals,
    ignore_stale_approvals: config.ignoreStaleApprovals,
    require_signed_commits: config.requireSignedCommits,
    protected_file_patterns: config.protectedFilePatterns,
    unprotected_file_patterns: config.unprotectedFilePatterns,
    block_admin_merge_override: config.blockAdminMergeOverride,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * The rule-change recheck fan-out (CheckPRsForBaseBranch port) — the M3
 * wiring of M1's recomputeOfficialForRule. Returns the rewritten-flag count
 * (the OQ-3 instrument) and logs it: observability line, not an error —
 * the webhooks-push log-sink convention (workerd's diagnostics channel).
 */
async function recomputeLogged(d1: D1Database, pair: RepositoryWithOwner, rule: ProtectionRow): Promise<number> {
  const rewritten = await recomputeOfficialForRule(d1, pair.repo, rule);
  if (rewritten > 0) {
    console.error(`[branch-protections] ${pair.repo.ownerNamespace}/${pair.repo.slug}: rule ${rule.ruleName} recompute rewrote ${rewritten} official flag(s)`);
  }
  return rewritten;
}

/** A rule row's stored config, freshly parsed. */
function configOf(rule: ProtectionRow): ProtectedBranchConfig {
  return parseRuleConfig(rule.rules);
}

// ---------------------------------------------------------------------------
// The routes.
// ---------------------------------------------------------------------------

export function registerBranchProtectionRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/branch_protections (repoListBranchProtection)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/branch_protections",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "List branch protections for a repository",
      operationId: "repoListBranchProtection",
      request: {
        params: z.object(ownerRepoParams),
      },
      responses: {
        200: {
          description: "BranchProtectionList",
          content: { "application/json": { schema: z.array(branchProtectionSchema) } },
        },
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      // FindRepoProtectedBranchRules' sort (priority → plain-before-glob →
      // created) is the service's listRepoRules (protected_branch_list.go:27-54).
      const rules = await listRepoRules(c.env.DB, pair.repo.id);
      const rendered = await Promise.all(rules.map((rule) => renderProtection(c.env.DB, rule)));
      return c.json(rendered, 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/branch_protections (repoCreateBranchProtection)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/branch_protections",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Create a branch protections for a repository",
      operationId: "repoCreateBranchProtection",
      request: {
        params: z.object(ownerRepoParams),
        body: { content: { "application/json": { schema: z.object(createOptionShape) } } },
      },
      responses: {
        201: { description: "BranchProtection", content: { "application/json": { schema: branchProtectionSchema } } },
        403: forbiddenResponse,
        404: notFoundResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      assertNotArchived(pair);
      const form = c.req.valid("json");

      // rule_name > deprecated branch_name; both empty is upstream's runtime
      // 400 (undeclared in the contract — the module-header note).
      let ruleName = form.rule_name ?? "";
      if (ruleName === "") {
        ruleName = form.branch_name ?? "";
      }
      if (ruleName.length === 0) {
        throw new ApiError(400, "both rule_name and branch_name are empty");
      }

      // Collision on the exact rule name (branch.go:698-705).
      if ((await findRuleByName(c.env.DB, pair.repo.id, ruleName)) !== null) {
        throw new ApiError(403, "Branch protection already exist");
      }

      // Usernames resolve before anything writes (upstream aborts the whole
      // request on the first unknown name); the deletion and bypass arrays
      // only load when their flag conjunctions say they matter (:727-734).
      const whitelistUsers = (await resolveUserIds(c.env.DB, form.push_whitelist_usernames)) ?? [];
      const forcePushAllowlistUsers = (await resolveUserIds(c.env.DB, form.force_push_allowlist_usernames)) ?? [];
      const deletionAllowlistUsers =
        (await resolveUserIds(
          c.env.DB,
          form.enable_push === true && form.enable_deletion === true && form.enable_deletion_allowlist === true
            ? form.deletion_allowlist_usernames
            : undefined,
        )) ?? [];
      const mergeWhitelistUsers = (await resolveUserIds(c.env.DB, form.merge_whitelist_usernames)) ?? [];
      const approvalsWhitelistUsers = (await resolveUserIds(c.env.DB, form.approvals_whitelist_username)) ?? [];
      const bypassAllowlistUsers =
        (await resolveUserIds(c.env.DB, form.enable_bypass_allowlist === true ? form.bypass_allowlist_usernames : undefined)) ?? [];

      // Teams resolve on org-owned repos only (:722-769); push/force-push/
      // merge/approvals resolve unconditionally (an unknown team 422s even
      // with the enable flag off), deletion/bypass behind their flags.
      const isOrg = pair.owner.type === "org";
      const whitelistTeams = isOrg ? await resolveTeamIds(c.env.DB, pair.owner.id, form.push_whitelist_teams ?? []) : [];
      const forcePushAllowlistTeams = isOrg ? await resolveTeamIds(c.env.DB, pair.owner.id, form.force_push_allowlist_teams ?? []) : [];
      const deletionAllowlistTeams =
        isOrg && form.enable_push === true && form.enable_deletion === true && form.enable_deletion_allowlist === true
          ? await resolveTeamIds(c.env.DB, pair.owner.id, form.deletion_allowlist_teams ?? [])
          : [];
      const mergeWhitelistTeams = isOrg ? await resolveTeamIds(c.env.DB, pair.owner.id, form.merge_whitelist_teams ?? []) : [];
      const approvalsWhitelistTeams = isOrg ? await resolveTeamIds(c.env.DB, pair.owner.id, form.approvals_whitelist_teams ?? []) : [];
      const bypassAllowlistTeams =
        isOrg && form.enable_bypass_allowlist === true ? await resolveTeamIds(c.env.DB, pair.owner.id, form.bypass_allowlist_teams ?? []) : [];

      // The deploy-key pseudo-ids (:836-843).
      const whitelistUsersWithKeys = setDeployKeyAllowlist(
        whitelistUsers,
        form.enable_push === true && form.enable_push_whitelist === true && form.push_whitelist_deploy_keys === true,
      );
      const forcePushAllowlistUsersWithKeys = setDeployKeyAllowlist(
        forcePushAllowlistUsers,
        form.enable_push === true && form.enable_force_push === true && form.enable_force_push_allowlist === true && form.force_push_allowlist_deploy_keys === true,
      );

      const config = createConfigFromOption(form);
      config.whitelistUserIds = whitelistUsersWithKeys;
      config.whitelistTeamIds = whitelistTeams;
      config.forcePushAllowlistUserIds = forcePushAllowlistUsersWithKeys;
      config.forcePushAllowlistTeamIds = forcePushAllowlistTeams;
      config.deletionAllowlistUserIds = deletionAllowlistUsers;
      config.deletionAllowlistTeamIds = deletionAllowlistTeams;
      config.mergeWhitelistUserIds = mergeWhitelistUsers;
      config.mergeWhitelistTeamIds = mergeWhitelistTeams;
      config.approvalsWhitelistUserIds = approvalsWhitelistUsers;
      config.approvalsWhitelistTeamIds = approvalsWhitelistTeams;
      config.bypassAllowlistUserIds = bypassAllowlistUsers;
      config.bypassAllowlistTeamIds = bypassAllowlistTeams;

      const now = new Date();
      const priority = form.priority ?? 0;
      await drizzle(c.env.DB).insert(protectedBranches).values({
        repoId: pair.repo.id,
        ruleName,
        // UpdateProtectBranch's new-rule branch: priority 0 → MAX+1
        // (protected_branch.go:502-513). A concurrent same-name insert that
        // won the UNIQUE race surfaces as the driver's constraint error —
        // the pre-check above is upstream's own only guard.
        priority: priority === 0 ? sql`coalesce((select max(${protectedBranches.priority}) from ${protectedBranches} where ${protectedBranches.repoId} = ${pair.repo.id}), 0) + 1` : priority,
        rules: serializeRuleConfig(config),
        createdAt: now,
        updatedAt: now,
      });
      // Reload from db to get the landed row (branch.go:823-831).
      const rule = requireRule(await findRuleByName(c.env.DB, pair.repo.id, ruleName));

      // The recheck fan-out (CreateOrUpdateProtectedBranch's tail) — the
      // M3 wiring of the official recompute.
      await recomputeLogged(c.env.DB, pair, rule);
      return c.json(await renderProtection(c.env.DB, rule), 201);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/branch_protections/{name} (repoGetBranchProtection)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/branch_protections/{name}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Get a specific branch protection for the repository",
      operationId: "repoGetBranchProtection",
      request: {
        params: z.object({ ...ownerRepoParams, ...protectionNameParam }),
      },
      responses: {
        200: { description: "BranchProtection", content: { "application/json": { schema: branchProtectionSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      const rule = requireRule(await findRuleByName(c.env.DB, pair.repo.id, c.req.valid("param").name));
      return c.json(await renderProtection(c.env.DB, rule), 200);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /repos/{owner}/{repo}/branch_protections/{name} (repoEditBranchProtection)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "patch",
      path: "/repos/{owner}/{repo}/branch_protections/{name}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Edit a branch protections for a repository. Only fields that are set will be changed",
      operationId: "repoEditBranchProtection",
      request: {
        params: z.object({ ...ownerRepoParams, ...protectionNameParam }),
        body: { content: { "application/json": { schema: z.object(editOptionShape) } } },
      },
      responses: {
        200: { description: "BranchProtection", content: { "application/json": { schema: branchProtectionSchema } } },
        404: notFoundResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      assertNotArchived(pair);
      const form = c.req.valid("json");
      const ruleName = c.req.valid("param").name;
      const rule = requireRule(await findRuleByName(c.env.DB, pair.repo.id, ruleName));
      const config = configOf(rule);

      // The push master cascades its sub-flags (branch.go:894-913); the
      // deploy-key booleans ride the same cascade (HasDeployKeyPush input).
      let pushDeployKeys = config.whitelistUserIds.includes(DEPLOY_KEY_USER_ID);
      let forcePushDeployKeys = config.forcePushAllowlistUserIds.includes(DEPLOY_KEY_USER_ID);
      if (form.enable_push !== undefined) {
        if (form.enable_push === false) {
          config.canPush = false;
          config.enableWhitelist = false;
          pushDeployKeys = false;
        } else {
          config.canPush = true;
          if (form.enable_push_whitelist !== undefined) {
            if (form.enable_push_whitelist === false) {
              config.enableWhitelist = false;
              pushDeployKeys = false;
            } else {
              config.enableWhitelist = true;
              if (form.push_whitelist_deploy_keys !== undefined) {
                pushDeployKeys = form.push_whitelist_deploy_keys;
              }
            }
          }
        }
      }
      if (form.enable_force_push !== undefined) {
        if (form.enable_force_push === false) {
          config.canForcePush = false;
          config.enableForcePushAllowlist = false;
          forcePushDeployKeys = false;
        } else {
          config.canForcePush = true;
          if (form.enable_force_push_allowlist !== undefined) {
            if (form.enable_force_push_allowlist === false) {
              config.enableForcePushAllowlist = false;
              forcePushDeployKeys = false;
            } else {
              config.enableForcePushAllowlist = true;
              if (form.force_push_allowlist_deploy_keys !== undefined) {
                forcePushDeployKeys = form.force_push_allowlist_deploy_keys;
              }
            }
          }
        }
      }
      if (form.enable_deletion !== undefined) {
        config.canDelete = form.enable_deletion;
      }
      if (form.enable_deletion_allowlist !== undefined) {
        config.enableDeletionAllowlist = form.enable_deletion_allowlist;
      }
      // The post-patch re-conjunction (:935-936).
      config.canDelete = config.canPush && config.canDelete;
      config.enableDeletionAllowlist = config.canDelete && config.enableDeletionAllowlist;

      if (form.priority !== undefined) {
        rule.priority = form.priority;
      }
      if (form.enable_merge_whitelist !== undefined) config.enableMergeWhitelist = form.enable_merge_whitelist;
      if (form.enable_bypass_allowlist !== undefined) config.enableBypassAllowlist = form.enable_bypass_allowlist;
      if (form.enable_status_check !== undefined) config.enableStatusCheck = form.enable_status_check;
      if (form.status_check_contexts !== undefined) config.statusCheckContexts = form.status_check_contexts;
      if (form.required_approvals !== undefined && form.required_approvals >= 0) config.requiredApprovals = form.required_approvals;
      if (form.enable_approvals_whitelist !== undefined) config.enableApprovalsWhitelist = form.enable_approvals_whitelist;
      if (form.block_on_rejected_reviews !== undefined) config.blockOnRejectedReviews = form.block_on_rejected_reviews;
      if (form.block_on_official_review_requests !== undefined) config.blockOnOfficialReviewRequests = form.block_on_official_review_requests;
      if (form.block_on_codeowner_reviews !== undefined) config.blockOnCodeownerReviews = form.block_on_codeowner_reviews;
      if (form.dismiss_stale_approvals !== undefined) config.dismissStaleApprovals = form.dismiss_stale_approvals;
      if (form.ignore_stale_approvals !== undefined) config.ignoreStaleApprovals = form.ignore_stale_approvals;
      if (form.require_signed_commits !== undefined) config.requireSignedCommits = form.require_signed_commits;
      if (form.protected_file_patterns !== undefined) config.protectedFilePatterns = form.protected_file_patterns;
      if (form.unprotected_file_patterns !== undefined) config.unprotectedFilePatterns = form.unprotected_file_patterns;
      if (form.block_on_outdated_branch !== undefined) config.blockOnOutdatedBranch = form.block_on_outdated_branch;
      if (form.block_admin_merge_override !== undefined) config.blockAdminMergeOverride = form.block_admin_merge_override;

      // Whitelists: a present name array replaces (422 on unknown), an
      // absent one keeps the stored ids (:1080-1086). The team arm resolves
      // on org-owned repos only.
      const whitelistUsers = (await resolveUserIds(c.env.DB, form.push_whitelist_usernames)) ?? config.whitelistUserIds;
      const forcePushAllowlistUsers = (await resolveUserIds(c.env.DB, form.force_push_allowlist_usernames)) ?? config.forcePushAllowlistUserIds;
      const deletionAllowlistUsers = (await resolveUserIds(c.env.DB, form.deletion_allowlist_usernames)) ?? config.deletionAllowlistUserIds;
      const mergeWhitelistUsers = (await resolveUserIds(c.env.DB, form.merge_whitelist_usernames)) ?? config.mergeWhitelistUserIds;
      const approvalsWhitelistUsers = (await resolveUserIds(c.env.DB, form.approvals_whitelist_username)) ?? config.approvalsWhitelistUserIds;
      const bypassAllowlistUsers = (await resolveUserIds(c.env.DB, form.bypass_allowlist_usernames)) ?? config.bypassAllowlistUserIds;

      const isOrg = pair.owner.type === "org";
      const whitelistTeams = form.push_whitelist_teams !== undefined && isOrg ? await resolveTeamIds(c.env.DB, pair.owner.id, form.push_whitelist_teams) : config.whitelistTeamIds;
      const forcePushAllowlistTeams =
        form.force_push_allowlist_teams !== undefined && isOrg ? await resolveTeamIds(c.env.DB, pair.owner.id, form.force_push_allowlist_teams) : config.forcePushAllowlistTeamIds;
      const deletionAllowlistTeams =
        form.deletion_allowlist_teams !== undefined && isOrg ? await resolveTeamIds(c.env.DB, pair.owner.id, form.deletion_allowlist_teams) : config.deletionAllowlistTeamIds;
      const mergeWhitelistTeams = form.merge_whitelist_teams !== undefined && isOrg ? await resolveTeamIds(c.env.DB, pair.owner.id, form.merge_whitelist_teams) : config.mergeWhitelistTeamIds;
      const approvalsWhitelistTeams =
        form.approvals_whitelist_teams !== undefined && isOrg ? await resolveTeamIds(c.env.DB, pair.owner.id, form.approvals_whitelist_teams) : config.approvalsWhitelistTeamIds;
      const bypassAllowlistTeams =
        form.bypass_allowlist_teams !== undefined && isOrg ? await resolveTeamIds(c.env.DB, pair.owner.id, form.bypass_allowlist_teams) : config.bypassAllowlistTeamIds;

      // The deploy-key persistence dance (:1085-1098): a usernames array that
      // still carries the pseudo-id re-arms the flag when the form was silent.
      if (form.push_whitelist_usernames !== undefined && form.push_whitelist_deploy_keys === undefined && whitelistUsers.includes(DEPLOY_KEY_USER_ID)) {
        pushDeployKeys = true;
      }
      if (form.force_push_allowlist_usernames !== undefined && form.force_push_allowlist_deploy_keys === undefined && forcePushAllowlistUsers.includes(DEPLOY_KEY_USER_ID)) {
        forcePushDeployKeys = true;
      }

      // Disabled arms clear their arrays before the save (:1180-1192).
      const bypassEnabled = config.enableBypassAllowlist;
      const deletionEnabled = config.enableDeletionAllowlist;
      config.whitelistUserIds = setDeployKeyAllowlist(whitelistUsers, pushDeployKeys);
      config.whitelistTeamIds = whitelistTeams;
      config.forcePushAllowlistUserIds = setDeployKeyAllowlist(forcePushAllowlistUsers, forcePushDeployKeys);
      config.forcePushAllowlistTeamIds = forcePushAllowlistTeams;
      config.deletionAllowlistUserIds = deletionEnabled ? deletionAllowlistUsers : [];
      config.deletionAllowlistTeamIds = deletionEnabled ? deletionAllowlistTeams : [];
      config.mergeWhitelistUserIds = mergeWhitelistUsers;
      config.mergeWhitelistTeamIds = mergeWhitelistTeams;
      config.approvalsWhitelistUserIds = approvalsWhitelistUsers;
      config.approvalsWhitelistTeamIds = approvalsWhitelistTeams;
      config.bypassAllowlistUserIds = bypassEnabled ? bypassAllowlistUsers : [];
      config.bypassAllowlistTeamIds = bypassEnabled ? bypassAllowlistTeams : [];

      await drizzle(c.env.DB)
        .update(protectedBranches)
        .set({ priority: rule.priority, rules: serializeRuleConfig(config), updatedAt: new Date() })
        .where(eq(protectedBranches.id, rule.id));
      const updated = requireRule(await findRuleByName(c.env.DB, pair.repo.id, ruleName));

      // The recheck fan-out (branch.go:1147-1180 — CheckPRsForBaseBranch for
      // a plain existing rule, FindAllMatchedBranches for a glob; our
      // recompute's matched-base loop covers both arms).
      await recomputeLogged(c.env.DB, pair, updated);
      return c.json(await renderProtection(c.env.DB, updated), 200);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/branch_protections/{name}
  // (repoDeleteBranchProtection) — 204. Runtime-only 423 (mustNotBeArchived
  // IS upstream's delete middleware) stays undeclared per the contract.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/branch_protections/{name}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete a specific branch protection for the repository",
      operationId: "repoDeleteBranchProtection",
      request: {
        params: z.object({ ...ownerRepoParams, ...protectionNameParam }),
      },
      responses: {
        204: { description: "empty" },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      assertNotArchived(pair);
      const rule = requireRule(await findRuleByName(c.env.DB, pair.repo.id, c.req.valid("param").name));
      await drizzle(c.env.DB).delete(protectedBranches).where(eq(protectedBranches.id, rule.id));
      // The fan-out runs on delete too (upstream skips it there; a deleted
      // whitelist can only widen officialness — module-header note). The
      // evaluation config is the NO-RULE state (the service's
      // isUserOfficialReviewer null-arm: plain write access), matched over
      // the deleted rule's name so exactly the branches it protected
      // re-evaluate — evaluating the deleted rule's own config here would
      // preserve the very restriction that just went away.
      const noRuleState: ProtectionRow = { ...rule, rules: serializeRuleConfig(emptyRuleConfig()) };
      await recomputeLogged(c.env.DB, pair, noRuleState);
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/branch_protections/priority
  // (repoUpdateBranchProtectionPriories) — 204. Registered AFTER the {name}
  // family like upstream's group order; POST is method-disjoint from the
  // {name} routes, so no shadowing exists (only GET/PATCH/DELETE carry a
  // /{name} segment, and a rule literally named "priority" 404s/edits
  // exactly like upstream chi's fall-through).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/branch_protections/priority",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Update the priorities of branch protections for a repository.",
      operationId: "repoUpdateBranchProtectionPriories",
      request: {
        params: z.object(ownerRepoParams),
        body: { content: { "application/json": { schema: z.object({ ids: z.array(z.number().int()).optional().openapi({ description: "rule ids in their new priority order (1-based)" }) }) } } },
      },
      responses: {
        204: { description: "empty" },
        404: notFoundResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      assertNotArchived(pair);
      const ids = c.req.valid("json").ids ?? [];
      // UpdateProtectBranchPriorities (protected_branch.go:529-545): prio
      // starts at 1, each id renumbers in list order, foreign-repo ids
      // no-op through the repo_id guard — one D1 batch (the implicit tx).
      const [first, ...rest] = ids.map((id, index) =>
        drizzle(c.env.DB)
          .update(protectedBranches)
          .set({ priority: index + 1 })
          .where(and(eq(protectedBranches.id, id), eq(protectedBranches.repoId, pair.repo.id))),
      );
      if (first !== undefined) {
        await drizzle(c.env.DB).batch([first, ...rest]);
      }
      return c.body(null, 204);
    },
  );
}
