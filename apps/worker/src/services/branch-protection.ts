/**
 * Protected-branch rule service (SPEC-0013 §3.2) — pure-D1 module consumed by
 * the merge RPC gate (api/routes/pulls.ts), the reviews interplay
 * (api/routes/pull-reviews.ts) and the head-push legs (services/webhooks-push.ts).
 *
 * MODEL — one `protected_branches` row per rule (SPEC-0013 §3.1, the port of
 * gitea/models/git/protected_branch.go:30–42): a repo id, a rule name ("a
 * branch name or a glob match to branch name", upstream column `branch_name`),
 * a priority, and ONE JSON blob (`rules`) holding the ProtectedBranchConfig
 * verbatim under upstream's exact snake_case json keys
 * (protected_branch.go:45–80) so contract rendering (M3) is a read-and-echo.
 *
 * MATCHING — first match wins over a sorted list
 * (protected_branch_list.go:27–54): sort by priority, then
 * plain-name-before-glob, then creation order; plain (non-special) names
 * match case-insensitively (strings.EqualFold, protected_branch.go:117–119),
 * special names compile as globs with `/` as separator
 * (glob.Compile(name, '/'), protected_branch.go:107); an invalid glob falls
 * back to a quoted-literal match (:108–111) — never a panic, never a broad
 * match. `IsRuleNameSpecial` = contains any of `* ? \ [ ] { }`
 * (modules/glob glob.go IsSpecialByte).
 *
 * The glob port (compileGlob below) mirrors modules/glob's plain
 * `Compile(pattern, separators...)` — the variant protected branches use —
 * by translating the pattern to a JS RegExp under the same rules: `*` is a
 * non-separator wildcard (`[^/]*`), `**` matches anything (`.*`), `?` one
 * non-separator char, `[...]` a character class (`!` inverts), `{a,b}`
 * alternation, `\` escapes, regex metacharacters are escaped, and the result
 * is fully anchored. Compile errors (unterminated class/alternation, dangling
 * escape, empty class — Go's RE2 rejects `[]`) trigger the QuoteMeta literal
 * fallback, so a stored-but-invalid pattern can never match broadly (§4.2).
 *
 * PREDICATES — the §2.1 ports, each citing its upstream function: canUserPush
 * (:135–158), canUserForcePush (:162–185), canUserDelete (:189–215),
 * isUserMergeWhitelisted (:218–238), canBypassBranchProtection (:242–261),
 * isUserOfficialReviewer (:264–289). The permission input is the existing
 * `repositoryPermissions` + `collaboratorModeOf` pair (the composition
 * pull-reviews.ts's reduced isOfficialReviewer already used); team arms
 * resolve through the SPEC-0007 `team_members` rows (the org-scoped
 * membership select of pull-reviews.ts:809–831).
 *
 * MERGE GATE — checkPullBranchProtections ports CheckPullBranchProtections
 * (services/pull/merge.go:694–742) over the landed `pull_reviews` table; the
 * returned string is the upstream 405 body VERBATIM (ErrNotReadyToMerge's
 * Error() renders only the message, modules/util/error.go:56–58). The
 * status-check, codeowner and protected-file arms are stored-but-unenforced
 * (SPEC-0013 §6 — no status consumer, no CODEOWNERS, no file walking).
 *
 * SANITIZATION (SPEC-0013 M4) — the save-side whitelist normalization port of
 * UpdateProtectBranch (protected_branch.go:418–527): every user allowlist runs
 * through updateUserWhitelist (:572–601 — keep only repo-code WRITE users,
 * deploy-key/Actions pseudo-ids excepted :580–583), the approvals allowlist
 * through updateApprovalWhitelist (:549–568 — keep users with ANY explicit
 * unit access, GetUserIDsWithAnyUnitAccess :553–556), every team allowlist
 * through updateTeamWhitelist (:605–624 — keep teams holding repo access,
 * GetTeamsWithAccessToAnyRepoUnit :609–612). Upstream's SliceSortedEqual
 * short-circuit (:575/:551/:608) ports too: a list the edit did not change
 * keeps its stored ids verbatim. One recorded normalization (§4.4): a VANISHED
 * principal is DROPPED — upstream's literal arm errors the whole save
 * (GetUserByID wrapped failure, :585–589); this port follows the SPEC's
 * drop-not-fail reading, making the scrub (below) the only other writer of
 * stale ids.
 *
 * DELETION SCRUB (SPEC-0013 M4) — the RemoveUserIDFromProtectedBranch /
 * RemoveTeamIDFromProtectedBranch ports (:648–693, removeIDsFromProtectedBranch):
 * a deleted principal is stripped from every allowlist column of every affected
 * rule in one config rewrite (changed rows only, `config` column only —
 * upstream's `.Cols("config")` leaves updated_unix alone). Callers are the
 * delete cascades: user delete (services/user/delete.go:134–155 — the
 * "***** START: Branch Protections *****" sweep, batched 50 because ids are
 * JSON-serialized and unfilterable server-side; we page the same size), team
 * delete (services/org/team.go:191–210 — scoped to the ORG's repos via the
 * `repo_id IN (SELECT id FROM repository WHERE owner_id = ?)` builder), repo
 * delete (services/repository/delete.go:171 — the rows die wholesale with the
 * repo; repos/service.ts's cascade). Divergence, per the SPEC's "every
 * allowlist column": the port scrubs all SIX user and SIX team arrays —
 * upstream's five-array sweep predates the bypass allowlist and misses
 * bypass_allowlist_user_ids/team_ids (:654–668).
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { User } from "../api/models/user";
import { repositoryPermissions, type RepositoryRow, type Viewer } from "../api/services/repository";
import { collaboratorModeOf } from "../api/services/repo-collaborators";
import { issues, protectedBranches, pullRequests, pullReviews, repositories, ReviewType, teamMembers, teamRepoAccess, teams, users } from "../db/schema";

// ---------------------------------------------------------------------------
// The system pseudo-principals (user_system.go:51) — resolvable by name at the
// API edge (branch.go:712-724) and carved out of the whitelist sanitization
// (protected_branch.go:580-583). The route module imports these so the two
// sites cannot drift.
// ---------------------------------------------------------------------------

export const DEPLOY_KEY_USER_ID = -3; // user_model.DeployKeyUserID
export const ACTIONS_USER_ID = -2; // user_model.ActionsUserID

// ---------------------------------------------------------------------------
// The config JSON (protected_branch.go:45–80) — upstream's exact keys.
// ---------------------------------------------------------------------------

/** `ProtectedBranchConfig` — every field with its upstream json key. */
export interface ProtectedBranchConfig {
  canPush: boolean;
  enableWhitelist: boolean;
  whitelistUserIds: number[];
  whitelistTeamIds: number[];
  enableMergeWhitelist: boolean;
  mergeWhitelistUserIds: number[];
  mergeWhitelistTeamIds: number[];
  enableBypassAllowlist: boolean;
  bypassAllowlistUserIds: number[];
  bypassAllowlistTeamIds: number[];
  canForcePush: boolean;
  enableForcePushAllowlist: boolean;
  forcePushAllowlistUserIds: number[];
  forcePushAllowlistTeamIds: number[];
  canDelete: boolean;
  enableDeletionAllowlist: boolean;
  deletionAllowlistUserIds: number[];
  deletionAllowlistTeamIds: number[];
  enableStatusCheck: boolean;
  statusCheckContexts: string[];
  enableApprovalsWhitelist: boolean;
  approvalsWhitelistUserIds: number[];
  approvalsWhitelistTeamIds: number[];
  requiredApprovals: number;
  blockOnRejectedReviews: boolean;
  blockOnOfficialReviewRequests: boolean;
  blockOnCodeownerReviews: boolean;
  blockOnOutdatedBranch: boolean;
  dismissStaleApprovals: boolean;
  ignoreStaleApprovals: boolean;
  requireSignedCommits: boolean;
  protectedFilePatterns: string;
  unprotectedFilePatterns: string;
  blockAdminMergeOverride: boolean;
}

/** The zero config — upstream creates rules with `&ProtectedBranchConfig{}`. */
export function emptyRuleConfig(): ProtectedBranchConfig {
  return {
    canPush: false,
    enableWhitelist: false,
    whitelistUserIds: [],
    whitelistTeamIds: [],
    enableMergeWhitelist: false,
    mergeWhitelistUserIds: [],
    mergeWhitelistTeamIds: [],
    enableBypassAllowlist: false,
    bypassAllowlistUserIds: [],
    bypassAllowlistTeamIds: [],
    canForcePush: false,
    enableForcePushAllowlist: false,
    forcePushAllowlistUserIds: [],
    forcePushAllowlistTeamIds: [],
    canDelete: false,
    enableDeletionAllowlist: false,
    deletionAllowlistUserIds: [],
    deletionAllowlistTeamIds: [],
    enableStatusCheck: false,
    statusCheckContexts: [],
    enableApprovalsWhitelist: false,
    approvalsWhitelistUserIds: [],
    approvalsWhitelistTeamIds: [],
    requiredApprovals: 0,
    blockOnRejectedReviews: false,
    blockOnOfficialReviewRequests: false,
    blockOnCodeownerReviews: false,
    blockOnOutdatedBranch: false,
    dismissStaleApprovals: false,
    ignoreStaleApprovals: false,
    requireSignedCommits: false,
    protectedFilePatterns: "",
    unprotectedFilePatterns: "",
    blockAdminMergeOverride: false,
  };
}

/** The upstream snake_case key for every config field — the single mapping
 *  the storage contract (SPEC-0013 §3.1 "read-and-echo") owns. */
const RULE_CONFIG_JSON_KEYS = {
  canPush: "can_push",
  enableWhitelist: "enable_whitelist",
  whitelistUserIds: "whitelist_user_ids",
  whitelistTeamIds: "whitelist_team_ids",
  enableMergeWhitelist: "enable_merge_whitelist",
  mergeWhitelistUserIds: "merge_whitelist_user_ids",
  mergeWhitelistTeamIds: "merge_whitelist_team_ids",
  enableBypassAllowlist: "enable_bypass_allowlist",
  bypassAllowlistUserIds: "bypass_allowlist_user_ids",
  bypassAllowlistTeamIds: "bypass_allowlist_team_ids",
  canForcePush: "can_force_push",
  enableForcePushAllowlist: "enable_force_push_allowlist",
  forcePushAllowlistUserIds: "force_push_allowlist_user_ids",
  forcePushAllowlistTeamIds: "force_push_allowlist_team_ids",
  canDelete: "can_delete",
  enableDeletionAllowlist: "enable_deletion_allowlist",
  deletionAllowlistUserIds: "deletion_allowlist_user_ids",
  deletionAllowlistTeamIds: "deletion_allowlist_team_ids",
  enableStatusCheck: "enable_status_check",
  statusCheckContexts: "status_check_contexts",
  enableApprovalsWhitelist: "enable_approvals_whitelist",
  approvalsWhitelistUserIds: "approvals_whitelist_user_ids",
  approvalsWhitelistTeamIds: "approvals_whitelist_team_ids",
  requiredApprovals: "required_approvals",
  blockOnRejectedReviews: "block_on_rejected_reviews",
  blockOnOfficialReviewRequests: "block_on_official_review_requests",
  blockOnCodeownerReviews: "block_on_codeowner_reviews",
  blockOnOutdatedBranch: "block_on_outdated_branch",
  dismissStaleApprovals: "dismiss_stale_approvals",
  ignoreStaleApprovals: "ignore_stale_approvals",
  requireSignedCommits: "require_signed_commits",
  protectedFilePatterns: "protected_file_patterns",
  unprotectedFilePatterns: "unprotected_file_patterns",
  blockAdminMergeOverride: "block_admin_merge_override",
} as const satisfies Record<keyof ProtectedBranchConfig, string>;

/** The storage encoding — upstream's exact snake_case json keys verbatim
 *  (protected_branch.go:45–80). The M3 API writer stores through this. */
export function serializeRuleConfig(config: ProtectedBranchConfig): string {
  const raw: Record<string, unknown> = {};
  for (const [key, jsonKey] of Object.entries(RULE_CONFIG_JSON_KEYS)) {
    raw[jsonKey] = config[key as keyof ProtectedBranchConfig];
  }
  return JSON.stringify(raw);
}

/** Tolerant JSON decode — a Go unmarshal zero-fills missing fields. */
export function parseRuleConfig(json: string): ProtectedBranchConfig {
  const base = emptyRuleConfig();
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return base;
  }
  const bool = (key: string): boolean => raw[key] === true;
  const ids = (key: string): number[] => {
    const value = raw[key];
    return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id)) : [];
  };
  const strings = (key: string): string[] => {
    const value = raw[key];
    return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
  };
  const required = raw.required_approvals;
  return {
    canPush: bool("can_push"),
    enableWhitelist: bool("enable_whitelist"),
    whitelistUserIds: ids("whitelist_user_ids"),
    whitelistTeamIds: ids("whitelist_team_ids"),
    enableMergeWhitelist: bool("enable_merge_whitelist"),
    mergeWhitelistUserIds: ids("merge_whitelist_user_ids"),
    mergeWhitelistTeamIds: ids("merge_whitelist_team_ids"),
    enableBypassAllowlist: bool("enable_bypass_allowlist"),
    bypassAllowlistUserIds: ids("bypass_allowlist_user_ids"),
    bypassAllowlistTeamIds: ids("bypass_allowlist_team_ids"),
    canForcePush: bool("can_force_push"),
    enableForcePushAllowlist: bool("enable_force_push_allowlist"),
    forcePushAllowlistUserIds: ids("force_push_allowlist_user_ids"),
    forcePushAllowlistTeamIds: ids("force_push_allowlist_team_ids"),
    canDelete: bool("can_delete"),
    enableDeletionAllowlist: bool("enable_deletion_allowlist"),
    deletionAllowlistUserIds: ids("deletion_allowlist_user_ids"),
    deletionAllowlistTeamIds: ids("deletion_allowlist_team_ids"),
    enableStatusCheck: bool("enable_status_check"),
    statusCheckContexts: strings("status_check_contexts"),
    enableApprovalsWhitelist: bool("enable_approvals_whitelist"),
    approvalsWhitelistUserIds: ids("approvals_whitelist_user_ids"),
    approvalsWhitelistTeamIds: ids("approvals_whitelist_team_ids"),
    requiredApprovals: typeof required === "number" && Number.isSafeInteger(required) && required > 0 ? required : 0,
    blockOnRejectedReviews: bool("block_on_rejected_reviews"),
    blockOnOfficialReviewRequests: bool("block_on_official_review_requests"),
    blockOnCodeownerReviews: bool("block_on_codeowner_reviews"),
    blockOnOutdatedBranch: bool("block_on_outdated_branch"),
    dismissStaleApprovals: bool("dismiss_stale_approvals"),
    ignoreStaleApprovals: bool("ignore_stale_approvals"),
    requireSignedCommits: bool("require_signed_commits"),
    protectedFilePatterns: typeof raw.protected_file_patterns === "string" ? raw.protected_file_patterns : "",
    unprotectedFilePatterns: typeof raw.unprotected_file_patterns === "string" ? raw.unprotected_file_patterns : "",
    blockAdminMergeOverride: bool("block_admin_merge_override"),
  };
}

// ---------------------------------------------------------------------------
// The glob port (modules/glob, the plain `Compile(pattern, '/')` variant).
// ---------------------------------------------------------------------------

/** IsSpecialByte (glob.go) — the byte set that makes a rule name "special". */
function isSpecialByte(c: string): boolean {
  return c === "*" || c === "?" || c === "\\" || c === "[" || c === "]" || c === "{" || c === "}";
}

/** IsRuleNameSpecial (protected_branch.go:87–94). */
export function isRuleNameSpecial(ruleName: string): boolean {
  return [...ruleName].some(isSpecialByte);
}

/** QuoteMeta (glob.go) — escapes every glob meta character. */
function quoteMeta(s: string): string {
  return [...s].map((c) => (isSpecialByte(c) ? `\\${c}` : c)).join("");
}

/** compileChars (glob.go) — one `[...]` class; throws on the RE2-invalid
 *  shapes Go's regexp.Compile rejects downstream. */
function compileChars(pattern: string[], pos: number, out: string[]): number {
  out.push("[");
  if (pos < pattern.length && pattern[pos] === "!") {
    pos += 1;
    out.push("^");
  }
  while (pos < pattern.length) {
    const c = pattern[pos]!;
    pos += 1;
    if (c === "]") {
      if (out[out.length - 1] === "[" || out[out.length - 1] === "^") {
        // `[]` / `[^]` — Go RE2 errors ("missing closing ]"); JS would silently
        // build an always/never-matching class. Take the error path instead.
        throw new Error("empty character class");
      }
      out.push("]");
      return pos;
    }
    if (c === "\\") {
      if (pos >= pattern.length) {
        throw new Error("unterminated character class escape");
      }
      out.push("\\", pattern[pos]!);
      pos += 1;
    } else {
      out.push(c);
    }
  }
  throw new Error("unterminated character class");
}

/** compile (glob.go) — the recursive pattern walk; throws on invalid input. */
function compileGlobPattern(pattern: string[], separators: string[]): string {
  const nonSeparatorChars = separators.length > 0 ? `[^${separators.map((s) => s.replace(/[\\\]]/g, "\\$&")).join("")}]` : ".";
  const out: string[] = [];
  const walk = (pos: number, subPattern: boolean): number => {
    while (pos < pattern.length) {
      const c = pattern[pos]!;
      pos += 1;
      if (subPattern && c === "}") {
        out.push(")");
        return pos;
      }
      switch (c) {
        case "*":
          if (pos < pattern.length && pattern[pos] === "*") {
            pos += 1;
            out.push(".*");
          } else {
            out.push(nonSeparatorChars, "*");
          }
          break;
        case "?":
          out.push(nonSeparatorChars);
          break;
        case "+":
          out.push("\\+");
          break;
        case "[":
          pos = compileChars(pattern, pos, out);
          break;
        case "{":
          out.push("(");
          pos = walk(pos, true);
          break;
        case ",":
          out.push(subPattern ? "|" : ",");
          break;
        case "\\":
          if (pos >= pattern.length) {
            throw new Error("no character to escape");
          }
          out.push("\\", pattern[pos]!);
          pos += 1;
          break;
        case ".":
        case "^":
        case "$":
        case "(":
        case ")":
        case "|":
          out.push("\\", c);
          break;
        default:
          out.push(c);
      }
    }
    if (subPattern) {
      throw new Error("unterminated character class"); // unterminated `{...}`
    }
    return pos;
  };
  out.push("^");
  walk(0, false);
  out.push("$");
  return out.join("");
}

/**
 * A compiled rule name: plain names match case-insensitively; special names
 * compile with `/` as separator, invalid globs fall back to the quoted
 * literal (protected_branch.go:107–111).
 */
export interface CompiledRuleName {
  ruleName: string;
  plain: boolean;
  regexp: RegExp;
}

export function compileRuleName(ruleName: string): CompiledRuleName {
  if (!isRuleNameSpecial(ruleName)) {
    return { ruleName, plain: true, regexp: new RegExp(`^${quoteMeta(ruleName)}$`, "i") };
  }
  let source: string;
  try {
    source = compileGlobPattern([...ruleName], ["/"]);
    // The QuoteMeta fallback can itself never fail (every meta byte is
    // escaped), so a plain RegExp-construction failure takes it too.
    return { ruleName, plain: false, regexp: new RegExp(source) };
  } catch {
    return { ruleName, plain: false, regexp: new RegExp(`^${quoteMeta(ruleName)}$`) };
  }
}

/** Match (protected_branch.go:115–124) — EqualFold for plain names. */
export function ruleMatches(rule: CompiledRuleName, branchName: string): boolean {
  return rule.regexp.test(branchName);
}

// ---------------------------------------------------------------------------
// Rule loading — the first-match resolution
// (protected_branch_list.go:27–54 + :92–98).
// ---------------------------------------------------------------------------

/** D1 row of `protected_branches` (src/db/schema.ts). */
export type ProtectedBranchRow = typeof protectedBranches.$inferSelect;

function compiledOf(rule: ProtectedBranchRow): CompiledRuleName {
  return compileRuleName(rule.ruleName);
}

/**
 * FindRepoProtectedBranchRules + sort (protected_branch_list.go:27–54):
 * priority, then plain-name-before-glob, then creation order (upstream loads
 * ASC(created_unix) and its unstable Slice tie-breaks on CreatedUnix — the
 * id tie-break preserves that insertion order when timestamps collide).
 */
export async function listRepoRules(d1: D1Database, repoId: string): Promise<ProtectedBranchRow[]> {
  const rows = await drizzle(d1)
    .select()
    .from(protectedBranches)
    .where(eq(protectedBranches.repoId, repoId))
    .orderBy(asc(protectedBranches.createdAt), asc(protectedBranches.id))
    .all();
  const compiled = rows.map((row) => ({ row, name: compiledOf(row) }));
  compiled.sort((a, b) => {
    if (a.row.priority !== b.row.priority) return a.row.priority - b.row.priority;
    if (a.name.plain !== b.name.plain) return a.name.plain ? -1 : 1;
    const createdDiff = (a.row.createdAt?.getTime() ?? 0) - (b.row.createdAt?.getTime() ?? 0);
    return createdDiff !== 0 ? createdDiff : a.row.id - b.row.id;
  });
  return compiled.map((entry) => entry.row);
}

/**
 * GetFirstMatchProtectedBranchRule (protected_branch_list.go:92–98) — the
 * first matching rule for the branch, or null (unprotected; every gate
 * treats null as "no per-ref notion", protected_branch_list.go:101–107).
 */
export async function findRule(d1: D1Database, repoId: string, branchName: string): Promise<ProtectedBranchRow | null> {
  const rules = await listRepoRules(d1, repoId);
  for (const rule of rules) {
    if (ruleMatches(compiledOf(rule), branchName)) {
      return rule;
    }
  }
  return null;
}

/**
 * FindAllMatchedBranches (protected_branch_list.go:57–89) over a branch-name
 * list (the rule-change recheck's branch universe — §3.4's "matched branches
 * via the branches listing").
 */
export function matchedBranchNamesForRule(ruleName: string, branchNames: readonly string[]): string[] {
  const compiled = compileRuleName(ruleName);
  return branchNames.filter((name) => ruleMatches(compiled, name));
}

// ---------------------------------------------------------------------------
// The permission input — the repositoryPermissions + collaboratorModeOf pair.
// ---------------------------------------------------------------------------

/** The reduced ACL input every predicate consumes. */
export interface PrincipalAccess {
  /** 0 for anonymous (every predicate answers false upstream with no user). */
  userId: number;
  /** repo-code write (`CanWrite(unit.TypeCode)`) — the matrix push/admin
   *  grant or a write/admin collaborator row. */
  write: boolean;
  /** repo admin (`IsUserRepoAdmin`) — the matrix admin grant or a
   *  collaborator-admin row. */
  admin: boolean;
}

/**
 * The access pair for one user over one repo — the composition
 * pull-reviews.ts:367–375 already used for the reduced isOfficialReviewer,
 * extracted so gate and reviews read one table set. A site admin holds both
 * (upstream's effective AccessModeOwner for admins).
 */
export async function principalAccessOf(d1: D1Database, repo: RepositoryRow, requester: User | null): Promise<PrincipalAccess> {
  const userId = requester?.id ?? null;
  if (requester === null || userId === null) {
    return { userId: 0, write: false, admin: false };
  }
  if (requester.is_admin === true) {
    return { userId, write: true, admin: true };
  }
  const viewer: Viewer = { origin: "", requester };
  const permissions = repositoryPermissions(viewer, repo);
  const mode = await collaboratorModeOf(d1, repo.id, userId);
  return {
    userId,
    write: permissions.admin === true || permissions.push === true || mode === "write" || mode === "admin",
    admin: permissions.admin === true || mode === "admin",
  };
}

/**
 * The users-ROW variant: `apiUserFromRow` hardcodes `is_admin: false` (the
 * upstream ToUserWithAccessMode embedded-user quirk), so callers holding a
 * UserRow must project `isAdmin` explicitly — the reviews arms evaluate the
 * REVIEWER's row, not a request viewer.
 */
export async function principalAccessOfRow(d1: D1Database, repo: RepositoryRow, reviewer: { id: number | null; username: string; isAdmin: boolean | null } | null): Promise<PrincipalAccess> {
  if (reviewer === null || reviewer.id === null) {
    return { userId: 0, write: false, admin: false };
  }
  return principalAccessOf(d1, repo, { id: reviewer.id, login: reviewer.username, is_admin: reviewer.isAdmin === true });
}

/** organization.IsUserInTeams — membership in ANY of the teams. */
export async function isUserInTeams(d1: D1Database, userId: number, teamIds: readonly number[]): Promise<boolean> {
  if (teamIds.length === 0) return false;
  const rows = await drizzle(d1)
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, [...teamIds])))
    .limit(1)
    .all();
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Predicate ports (§2.1 — protected_branch.go).
// ---------------------------------------------------------------------------

/** CanUserPush (:135–158) — the M2 push gate's predicate, ported with the family. */
export async function canUserPush(d1: D1Database, config: ProtectedBranchConfig, access: PrincipalAccess): Promise<boolean> {
  if (!config.canPush) return false;
  if (!config.enableWhitelist) return access.write;
  if (config.whitelistUserIds.includes(access.userId)) return true;
  if (config.whitelistTeamIds.length === 0) return false;
  return isUserInTeams(d1, access.userId, config.whitelistTeamIds);
}

/** CanUserForcePush (:162–185) — force flag, then allowlist AND push predicate. */
export async function canUserForcePush(d1: D1Database, config: ProtectedBranchConfig, access: PrincipalAccess): Promise<boolean> {
  if (!config.canForcePush) return false;
  if (!config.enableForcePushAllowlist) return canUserPush(d1, config, access);
  const allowlisted =
    config.forcePushAllowlistUserIds.includes(access.userId) ||
    (config.forcePushAllowlistTeamIds.length > 0 && (await isUserInTeams(d1, access.userId, config.forcePushAllowlistTeamIds)));
  if (!allowlisted) return false;
  return canUserPush(d1, config, access);
}

/** CanUserDelete (:189–215) — write + can_delete + push predicate + allowlist. */
export async function canUserDelete(d1: D1Database, config: ProtectedBranchConfig, access: PrincipalAccess): Promise<boolean> {
  if (!access.write || !config.canDelete) return false;
  if (!config.enableDeletionAllowlist) return canUserPush(d1, config, access);
  const allowlisted =
    config.deletionAllowlistUserIds.includes(access.userId) ||
    (config.deletionAllowlistTeamIds.length > 0 && (await isUserInTeams(d1, access.userId, config.deletionAllowlistTeamIds)));
  if (!allowlisted) return false;
  return canUserPush(d1, config, access);
}

/**
 * IsUserMergeWhitelisted (:218–238) — without the whitelist the answer is
 * plain write access; with it, explicit user/team membership only. This is
 * upstream's isUserAllowedToMerge arm when a rule exists
 * (services/pull/merge.go:671–691).
 */
export async function isUserMergeWhitelisted(d1: D1Database, config: ProtectedBranchConfig, access: PrincipalAccess): Promise<boolean> {
  if (!config.enableMergeWhitelist) return access.write;
  if (config.mergeWhitelistUserIds.includes(access.userId)) return true;
  if (config.mergeWhitelistTeamIds.length === 0) return false;
  return isUserInTeams(d1, access.userId, config.mergeWhitelistTeamIds);
}

/**
 * CanBypassBranchProtection (:242–261) — repo admin unless
 * block_admin_merge_override, else the bypass allowlist (user/team). This is
 * the `force_merge` escape's predicate (check.go:192–207).
 */
export async function canBypassBranchProtection(d1: D1Database, config: ProtectedBranchConfig, access: PrincipalAccess): Promise<boolean> {
  if (access.admin && !config.blockAdminMergeOverride) return true;
  if (!config.enableBypassAllowlist) return false;
  if (config.bypassAllowlistUserIds.includes(access.userId)) return true;
  if (config.bypassAllowlistTeamIds.length === 0) return false;
  return isUserInTeams(d1, access.userId, config.bypassAllowlistTeamIds);
}

/**
 * IsUserOfficialReviewer (:264–289) — without the approvals whitelist anyone
 * with code-unit WRITE counts; with it, the approvals whitelist (user/team)
 * counts. A null rule (unprotected branch) keeps the landed write-access
 * fallback (models/issues/review.go:276–306, the arm the reviews wave
 * deferred).
 */
export async function isUserOfficialReviewer(
  d1: D1Database,
  config: ProtectedBranchConfig | null,
  access: PrincipalAccess,
): Promise<boolean> {
  if (config === null || !config.enableApprovalsWhitelist) return access.write;
  if (config.approvalsWhitelistUserIds.includes(access.userId)) return true;
  if (config.approvalsWhitelistTeamIds.length === 0) return false;
  return isUserInTeams(d1, access.userId, config.approvalsWhitelistTeamIds);
}

// ---------------------------------------------------------------------------
// Approval counting (models/issues/pull.go:760–826) over `pull_reviews`.
// ---------------------------------------------------------------------------

/**
 * GetGrantedApprovalsCount (:770–785) — reviews `type=Approve AND official
 * AND NOT dismissed`, plus `stale=false` ONLY when ignore_stale_approvals is
 * set (:775–777). One count against `pull_reviews_issue_idx`.
 */
export async function grantedApprovalsCount(d1: D1Database, issueId: number, config: ProtectedBranchConfig): Promise<number> {
  const rows = await drizzle(d1)
    .select({ value: sql<number>`count(*)` })
    .from(pullReviews)
    .where(
      config.ignoreStaleApprovals
        ? and(
            eq(pullReviews.issueId, issueId),
            eq(pullReviews.type, ReviewType.Approve),
            eq(pullReviews.official, true),
            eq(pullReviews.dismissed, false),
            eq(pullReviews.stale, false),
          )
        : and(
            eq(pullReviews.issueId, issueId),
            eq(pullReviews.type, ReviewType.Approve),
            eq(pullReviews.official, true),
            eq(pullReviews.dismissed, false),
          ),
    )
    .all();
  return Number(rows[0]?.value ?? 0);
}

/** MergeBlockedByRejectedReview (:788–803) — any official undismissed reject. */
export async function mergeBlockedByRejectedReview(d1: D1Database, issueId: number): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: pullReviews.id })
    .from(pullReviews)
    .where(
      and(
        eq(pullReviews.issueId, issueId),
        eq(pullReviews.type, ReviewType.Reject),
        eq(pullReviews.official, true),
        eq(pullReviews.dismissed, false),
      ),
    )
    .limit(1)
    .all();
  return rows.length > 0;
}

/** MergeBlockedByOfficialReviewRequests (:807–821) — any official request row. */
export async function mergeBlockedByOfficialReviewRequests(d1: D1Database, issueId: number): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: pullReviews.id })
    .from(pullReviews)
    .where(and(eq(pullReviews.issueId, issueId), eq(pullReviews.type, ReviewType.Request), eq(pullReviews.official, true)))
    .limit(1)
    .all();
  return rows.length > 0;
}

/** MergeBlockedByOutdatedBranch (:824–826) — block flag AND CommitsBehind > 0. */
export function mergeBlockedByOutdatedBranch(config: ProtectedBranchConfig, commitsBehind: number): boolean {
  return config.blockOnOutdatedBranch && commitsBehind > 0;
}

// ---------------------------------------------------------------------------
// The merge gate core (services/pull/merge.go:694–742).
// ---------------------------------------------------------------------------

export interface PullBranchProtectionInput {
  issueId: number;
  /** `pull_requests.commits_behind` — the mergeability check's count. */
  commitsBehind: number;
}

/**
 * CheckPullBranchProtections (merge.go:694–742) — the rule's decision for one
 * PR: null = mergeable, or the upstream 405 body VERBATIM (the
 * ErrNotReadyToMerge message texts). Order mirrors upstream: approvals,
 * rejected reviews, official review requests, outdated branch.
 */
export async function checkPullBranchProtections(d1: D1Database, rule: ProtectedBranchRow, input: PullBranchProtectionInput): Promise<string | null> {
  const config = parseRuleConfig(rule.rules);
  // IsPullCommitStatusPass (:707–713) — no status consumer exists (SPEC-0013
  // §6): the arm is stored-only, never enforced.
  if (config.requiredApprovals > 0 && (await grantedApprovalsCount(d1, input.issueId, config)) < config.requiredApprovals) {
    return "Does not have enough approvals";
  }
  if (config.blockOnRejectedReviews && (await mergeBlockedByRejectedReview(d1, input.issueId))) {
    return "There are requested changes";
  }
  if (config.blockOnOfficialReviewRequests && (await mergeBlockedByOfficialReviewRequests(d1, input.issueId))) {
    return "There are official review requests";
  }
  if (mergeBlockedByOutdatedBranch(config, input.commitsBehind)) {
    return "The head branch is behind the base branch";
  }
  // block_on_codeowner_reviews (:729–731) and MergeBlockedByProtectedFiles
  // (:737–739) — §6 omissions.
  return null;
}

// ---------------------------------------------------------------------------
// The rule-change recheck (services/pull/protected_branch.go:13–47, §3.4's
// "retroactive official recompute").
// ---------------------------------------------------------------------------

export interface RecomputeOptions {
  /** Log sink override (tests); default console.error. */
  log?: (message: string) => void;
}

/**
 * Re-evaluates the `official` flags of every OPEN PR whose base branch the
 * rule matches, after a rule create/update. Upstream re-runs the PR check
 * pipeline (CheckPRsForBaseBranch); for cf-gitea the minimal faithful pass is
 * a bounded D1 rewrite of the stored denormalization (§3.4): per open PR on
 * the repo whose base matches (plain name → the one branch; glob → the open
 * PRs' distinct base branches — the only universe whose flags matter), every
 * decision review's flag recomputes through isUserOfficialReviewer. Returns
 * the number of flags rewritten (the OQ-3 budget instrument).
 */
export async function recomputeOfficialForRule(d1: D1Database, repo: RepositoryRow, rule: ProtectedBranchRow, options: RecomputeOptions = {}): Promise<number> {
  const log = options.log ?? ((message: string) => console.error(message));
  const config = parseRuleConfig(rule.rules);
  const compiled = compiledOf(rule);
  const openPrs = await drizzle(d1)
    .select({ issueId: issues.id, baseBranch: pullRequests.baseBranch })
    .from(pullRequests)
    .innerJoin(issues, eq(issues.id, pullRequests.issueId))
    .where(and(eq(pullRequests.baseRepoId, repo.id), eq(pullRequests.hasMerged, false), eq(issues.isClosed, false)))
    .all();

  let rewritten = 0;
  for (const pr of openPrs) {
    if (!ruleMatches(compiled, pr.baseBranch)) continue;
    const reviews = await drizzle(d1)
      .select({ id: pullReviews.id, reviewerId: pullReviews.reviewerId, official: pullReviews.official })
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, pr.issueId), inArray(pullReviews.type, [ReviewType.Approve, ReviewType.Reject])))
      .all();
    for (const review of reviews) {
      if (review.reviewerId === 0) continue; // team-request-shaped rows carry no reviewer
      const reviewer = (await drizzle(d1).select().from(users).where(eq(users.id, review.reviewerId)).limit(1).all())[0];
      if (reviewer === undefined) {
        // Vanished principal — leave the stored flag (§4.4's scrub is M4).
        log(`[branch-protection] rule ${rule.ruleName} recompute: reviewer ${review.reviewerId} row missing — skipped`);
        continue;
      }
      const access = await principalAccessOfRow(d1, repo, reviewer);
      const official = await isUserOfficialReviewer(d1, config, access);
      if (official === review.official) continue;
      await drizzle(d1).update(pullReviews).set({ official }).where(eq(pullReviews.id, review.id));
      rewritten += 1;
    }
  }
  return rewritten;
}

// ---------------------------------------------------------------------------
// Save-side whitelist sanitization (SPEC-0013 M4 — UpdateProtectBranch,
// protected_branch.go:418–527, via updateUserWhitelist :572–601,
// updateApprovalWhitelist :549–568, updateTeamWhitelist :605–624).
// ---------------------------------------------------------------------------

/** util.SliceSortedEqual — order-insensitive list equality (the :575/:551/:608
 *  short-circuit inputs). */
function sortedIdsEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((value, index) => value === right[index]);
}

/** GetUserByID + GetIndividualUserRepoPermission(...).CanWrite(TypeCode)
 *  (:585–597) over our ACL pair: the users row must exist (a vanished id
 *  fails the filter — the §4.4 drop normalization; upstream's literal arm
 *  errors the save) and hold repo-code write (the matrix push/admin grant or
 *  a write/admin collaborator row — principalAccessOfRow's composition). */
async function userHasRepoCodeWrite(d1: D1Database, repo: RepositoryRow, userId: number): Promise<boolean> {
  const row = (await drizzle(d1).select().from(users).where(eq(users.id, userId)).limit(1).all())[0];
  if (row === undefined) return false;
  const access = await principalAccessOfRow(d1, repo, row);
  return access.write;
}

/** updateApprovalWhitelist's GetUserIDsWithAnyUnitAccess (:553–556) — an
 *  EXPLICIT access row at read or above (owner, site admin, any collaborator
 *  row). A public repo's implicit pull does NOT count, matching upstream's
 *  access-table semantics. Ownership matches the way the whole module's
 *  permission input does: the ownerId cell OR the owner-namespace login
 *  (repositoryPermissions' isRepositoryOwner, repository.ts:100-102). */
async function userHasAnyUnitAccess(d1: D1Database, repo: RepositoryRow, userId: number): Promise<boolean> {
  const row = (
    await drizzle(d1)
      .select({ isAdmin: users.isAdmin, usernameLower: users.usernameLower })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .all()
  )[0];
  if (row === undefined) return false;
  if (row.isAdmin === true || repo.ownerId === userId || row.usernameLower === repo.ownerNamespace) return true;
  return (await collaboratorModeOf(d1, repo.id, userId)) !== "none";
}

/** GetTeamsWithAccessToAnyRepoUnit (:609–612) over our model: a team of the
 *  repo's org holds access through a materialized team_repo_access row OR the
 *  includes_all coverage union (the teams read path's same union). */
async function teamIdsWithRepoAccess(d1: D1Database, repo: RepositoryRow): Promise<Set<number>> {
  if (repo.ownerId === null) return new Set();
  const orgTeams = await drizzle(d1)
    .select({ id: teams.id, includesAll: teams.includesAllRepositories })
    .from(teams)
    .where(eq(teams.orgId, repo.ownerId))
    .all();
  const granted = new Set(
    (await drizzle(d1).select({ teamId: teamRepoAccess.teamId }).from(teamRepoAccess).where(eq(teamRepoAccess.repoId, repo.id)).all()).map(
      (row) => row.teamId,
    ),
  );
  return new Set(orgTeams.filter((team) => team.includesAll === true || granted.has(team.id)).map((team) => team.id));
}

/**
 * updateUserWhitelist port (:572–601): an unchanged list keeps its stored ids
 * verbatim (:575–577 — the deletion scrub, not the save, owns already-stored
 * stale ids); a changed list keeps the two pseudo-principals (:580–583) and
 * drops every user without repo-code write — demoted (:595–597) or vanished
 * (the §4.4 drop normalization) alike.
 */
export async function sanitizeUserWhitelist(d1: D1Database, repo: RepositoryRow, current: readonly number[], incoming: readonly number[]): Promise<number[]> {
  if (sortedIdsEqual(current, incoming)) return [...current];
  const kept: number[] = [];
  for (const id of incoming) {
    if (id === ACTIONS_USER_ID || id === DEPLOY_KEY_USER_ID) {
      kept.push(id);
      continue;
    }
    if (await userHasRepoCodeWrite(d1, repo, id)) {
      kept.push(id);
    }
  }
  return kept;
}

/**
 * updateApprovalWhitelist port (:549–568): unchanged short-circuit, else keep
 * every user holding ANY explicit unit access (:560–563 — no pseudo-id
 * carve-out here; upstream's approvals filter has none either).
 */
export async function sanitizeApprovalWhitelist(d1: D1Database, repo: RepositoryRow, current: readonly number[], incoming: readonly number[]): Promise<number[]> {
  if (sortedIdsEqual(current, incoming)) return [...current];
  const kept: number[] = [];
  for (const id of incoming) {
    if (await userHasAnyUnitAccess(d1, repo, id)) {
      kept.push(id);
    }
  }
  return kept;
}

/**
 * updateTeamWhitelist port (:605–624): unchanged short-circuit, else keep only
 * the teams that still hold repo access (:615–619 — a vanished team or one
 * that lost its grant is dropped; ids outside the repo's org can never hold
 * access and drop unconditionally).
 */
export async function sanitizeTeamWhitelist(d1: D1Database, repo: RepositoryRow, current: readonly number[], incoming: readonly number[]): Promise<number[]> {
  if (sortedIdsEqual(current, incoming)) return [...current];
  const withAccess = await teamIdsWithRepoAccess(d1, repo);
  return incoming.filter((id) => withAccess.has(id));
}

/**
 * UpdateProtectBranch's twelve allowlist assignments (:438–493) in upstream
 * order — five user lists plus bypass through updateUserWhitelist, the
 * approvals list through updateApprovalWhitelist, all six team lists through
 * updateTeamWhitelist. Mutates `config` in place (the route's post-merge
 * config) and returns it; `stored` is the config AS LOADED from the row
 * (the short-circuit's comparison side — an edit that leaves a list untouched
 * keeps its stored ids exactly like upstream). The create arm passes the
 * zero config as `stored`: every non-empty fresh list differs, so every
 * create sanitizes (upstream's new-rule branch runs the same filters).
 */
export async function sanitizeRuleWhitelists(d1: D1Database, repo: RepositoryRow, config: ProtectedBranchConfig, stored: ProtectedBranchConfig): Promise<ProtectedBranchConfig> {
  config.whitelistUserIds = await sanitizeUserWhitelist(d1, repo, stored.whitelistUserIds, config.whitelistUserIds);
  config.forcePushAllowlistUserIds = await sanitizeUserWhitelist(d1, repo, stored.forcePushAllowlistUserIds, config.forcePushAllowlistUserIds);
  config.deletionAllowlistUserIds = await sanitizeUserWhitelist(d1, repo, stored.deletionAllowlistUserIds, config.deletionAllowlistUserIds);
  config.mergeWhitelistUserIds = await sanitizeUserWhitelist(d1, repo, stored.mergeWhitelistUserIds, config.mergeWhitelistUserIds);
  config.approvalsWhitelistUserIds = await sanitizeApprovalWhitelist(d1, repo, stored.approvalsWhitelistUserIds, config.approvalsWhitelistUserIds);
  config.bypassAllowlistUserIds = await sanitizeUserWhitelist(d1, repo, stored.bypassAllowlistUserIds, config.bypassAllowlistUserIds);
  config.whitelistTeamIds = await sanitizeTeamWhitelist(d1, repo, stored.whitelistTeamIds, config.whitelistTeamIds);
  config.forcePushAllowlistTeamIds = await sanitizeTeamWhitelist(d1, repo, stored.forcePushAllowlistTeamIds, config.forcePushAllowlistTeamIds);
  config.deletionAllowlistTeamIds = await sanitizeTeamWhitelist(d1, repo, stored.deletionAllowlistTeamIds, config.deletionAllowlistTeamIds);
  config.mergeWhitelistTeamIds = await sanitizeTeamWhitelist(d1, repo, stored.mergeWhitelistTeamIds, config.mergeWhitelistTeamIds);
  config.approvalsWhitelistTeamIds = await sanitizeTeamWhitelist(d1, repo, stored.approvalsWhitelistTeamIds, config.approvalsWhitelistTeamIds);
  config.bypassAllowlistTeamIds = await sanitizeTeamWhitelist(d1, repo, stored.bypassAllowlistTeamIds, config.bypassAllowlistTeamIds);
  return config;
}

// ---------------------------------------------------------------------------
// Deletion scrub (SPEC-0013 M4 — removeIDsFromProtectedBranch :640–684 and its
// two cascade callers: services/user/delete.go:134–155,
// services/org/team.go:191–210).
// ---------------------------------------------------------------------------

/** Upstream pages 50 per fetch (delete.go:138) — the port keeps the bound. */
const SCRUB_PAGE_SIZE = 50;

/** The six user allowlist arrays upstream's sweep covers (:654–668), widened
 *  to the bypass pair per the SPEC's "every allowlist column". */
function scrubUserIdFromConfig(config: ProtectedBranchConfig, userId: number): boolean {
  const before =
    config.whitelistUserIds.length +
    config.forcePushAllowlistUserIds.length +
    config.deletionAllowlistUserIds.length +
    config.approvalsWhitelistUserIds.length +
    config.mergeWhitelistUserIds.length +
    config.bypassAllowlistUserIds.length;
  config.whitelistUserIds = config.whitelistUserIds.filter((id) => id !== userId);
  config.forcePushAllowlistUserIds = config.forcePushAllowlistUserIds.filter((id) => id !== userId);
  config.deletionAllowlistUserIds = config.deletionAllowlistUserIds.filter((id) => id !== userId);
  config.approvalsWhitelistUserIds = config.approvalsWhitelistUserIds.filter((id) => id !== userId);
  config.mergeWhitelistUserIds = config.mergeWhitelistUserIds.filter((id) => id !== userId);
  config.bypassAllowlistUserIds = config.bypassAllowlistUserIds.filter((id) => id !== userId);
  const after =
    config.whitelistUserIds.length +
    config.forcePushAllowlistUserIds.length +
    config.deletionAllowlistUserIds.length +
    config.approvalsWhitelistUserIds.length +
    config.mergeWhitelistUserIds.length +
    config.bypassAllowlistUserIds.length;
  return after !== before; // the rewrite only fires when something changed (:669-683)
}

/** The team mirror of scrubUserIdFromConfig (:655–668's team half + bypass). */
function scrubTeamIdFromConfig(config: ProtectedBranchConfig, teamId: number): boolean {
  const before =
    config.whitelistTeamIds.length +
    config.forcePushAllowlistTeamIds.length +
    config.deletionAllowlistTeamIds.length +
    config.approvalsWhitelistTeamIds.length +
    config.mergeWhitelistTeamIds.length +
    config.bypassAllowlistTeamIds.length;
  config.whitelistTeamIds = config.whitelistTeamIds.filter((id) => id !== teamId);
  config.forcePushAllowlistTeamIds = config.forcePushAllowlistTeamIds.filter((id) => id !== teamId);
  config.deletionAllowlistTeamIds = config.deletionAllowlistTeamIds.filter((id) => id !== teamId);
  config.approvalsWhitelistTeamIds = config.approvalsWhitelistTeamIds.filter((id) => id !== teamId);
  config.mergeWhitelistTeamIds = config.mergeWhitelistTeamIds.filter((id) => id !== teamId);
  config.bypassAllowlistTeamIds = config.bypassAllowlistTeamIds.filter((id) => id !== teamId);
  const after =
    config.whitelistTeamIds.length +
    config.forcePushAllowlistTeamIds.length +
    config.deletionAllowlistTeamIds.length +
    config.approvalsWhitelistTeamIds.length +
    config.mergeWhitelistTeamIds.length +
    config.bypassAllowlistTeamIds.length;
  return after !== before;
}

/** The config-column-only rewrite (:669–683's `.Cols("config")` — updated_unix
 *  deliberately untouched, so the render's updated_at keeps the admin's last
 *  deliberate edit). */
async function rewriteRuleConfig(d1: D1Database, ruleId: number, config: ProtectedBranchConfig): Promise<void> {
  await drizzle(d1).update(protectedBranches).set({ rules: serializeRuleConfig(config) }).where(eq(protectedBranches.id, ruleId));
}

/**
 * RemoveUserIDFromProtectedBranch over EVERY rule (delete.go:134–155): ids
 * live inside the JSON blob, so the sweep pages all rules (50 at a time,
 * upstream's batchSize) and rewrites the changed ones. Returns the number of
 * rules rewritten. Pseudo-principal ids are refused — they are never users
 * and must survive every scrub.
 */
export async function scrubUserFromAllRules(d1: D1Database, userId: number): Promise<number> {
  if (userId <= 0) return 0;
  let rewritten = 0;
  for (let offset = 0; ; offset += SCRUB_PAGE_SIZE) {
    const rows = await drizzle(d1)
      .select()
      .from(protectedBranches)
      .orderBy(asc(protectedBranches.id))
      .limit(SCRUB_PAGE_SIZE)
      .offset(offset)
      .all();
    if (rows.length === 0) break;
    for (const row of rows) {
      const config = parseRuleConfig(row.rules);
      if (!scrubUserIdFromConfig(config, userId)) continue;
      await rewriteRuleConfig(d1, row.id, config);
      rewritten += 1;
    }
  }
  return rewritten;
}

/**
 * RemoveTeamIDFromProtectedBranch scoped like the DeleteTeam caller
 * (team.go:196–205): only the ORG's repos' rules can reference the team
 * (`repo_id IN (SELECT id FROM repository WHERE owner_id = t.OrgID)`), so the
 * sweep is scoped the same way. Returns the number of rules rewritten.
 */
export async function scrubTeamFromOrgRules(d1: D1Database, orgId: number, teamId: number): Promise<number> {
  if (teamId <= 0) return 0;
  // The caller's scope (team.go:198-201's builder): repo_id IN (the org's repos).
  const repoIds = (await drizzle(d1).select({ id: repositories.id }).from(repositories).where(eq(repositories.ownerId, orgId)).all()).map(
    (row) => row.id,
  );
  if (repoIds.length === 0) return 0;
  let rewritten = 0;
  for (let offset = 0; ; offset += SCRUB_PAGE_SIZE) {
    const rows = await drizzle(d1)
      .select()
      .from(protectedBranches)
      .where(inArray(protectedBranches.repoId, repoIds))
      .orderBy(asc(protectedBranches.id))
      .limit(SCRUB_PAGE_SIZE)
      .offset(offset)
      .all();
    if (rows.length === 0) break;
    for (const row of rows) {
      const config = parseRuleConfig(row.rules);
      if (!scrubTeamIdFromConfig(config, teamId)) continue;
      await rewriteRuleConfig(d1, row.id, config);
      rewritten += 1;
    }
  }
  return rewritten;
}
