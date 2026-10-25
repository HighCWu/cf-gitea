/**
 * The repository branches page, `/{owner}/{repo}/branches` — pages wave 16
 * (SPEC-0008 U3 extension; upstream templates/repo/branch/list.tmpl at the
 * pin, routers/web/repo/branch.go Branches + DeleteBranchPost, and the
 * /branches/delete route shape web.go:1478-1482 `m.Post("/delete",
 * repo.DeleteBranchPost)`).
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
 * `p.info` last-commit line (ShortSha link onto `/commit/{oid}` · subject ·
 * "Updated" TimeSince · author), and the `.commit-divergence` bar pair with
 * the commits_divergence_from / commits_no_divergence tooltips. The bars'
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
 * reduced to the landed model: no deleted-branch rows exist (no
 * `deleted_branches` table — the restore column cannot render), and
 * GetPullRequestTargetBranch folds to the default branch for a same-repo
 * target, so the first two arms are one `name != defaultBranch` check.
 * `rule.CanUserDelete` is the LANDED port (`canUserDelete`,
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
 * ## Reads consumed vs degraded
 *
 * - `listRefs()` — the branch universe (the API LIST's filter + sort).
 * - `readCommit(branch)` — the last-commit line per rendered row (page
 *   slice only); a failed read skips the line, never the row.
 * - `countDivergence(default, branch)` — the ahead/behind pair (SPEC-0001b
 *   §4.1's one-walk rev-list; upstream GetDivergingCommits' shape). A
 *   `missing`/failed read renders an empty divergence cell — upstream
 *   renders -1/-1 there; the honest absence beats a negative count.
 * - D1: `listRepoRules` once + `principalAccessOfRow` once per request (the
 *   API LIST's loadBranchProtectionContext composition); per-branch
 *   predicates only for the rendered slice.
 *
 * ## Reductions (documented divergences)
 *
 * - The writer's create-branch / rename / download / RSS buttons (upstream's
 *   IsWriter block) are unrendered: no modal flow, archive endpoint, feed or
 *   rename POST exists to target (the dead-link rule), and their glyphs are
 *   outside the icon allowlist.
 * - The PR column (LatestPullRequest state labels, the Included badge, the
 *   compare-changes button) is unrendered — the wave brief's row shape ends
 *   at the divergence cell; the compare surface is reachable from the
 *   branches dropdown and the PR list.
 * - The Switch Default Branch link renders for ADMIN viewers, not upstream's
 *   `IsWriter` — the settings page it targets is admin-gated here, and a
 *   link a writer follows into a 404 would break the dead-link rule.
 * - The search combo filters the ref universe by case-insensitive substring
 *   (upstream's SQL LIKE over the branch table — the engine keeps no branch
 *   rows); the default-branch section is unaffected, like upstream's
 *   separate GetBranchExisting read.
 * - The last-commit line renders the commit AUTHOR as plain text (the
 *   commit-list reduction): refs carry no pusher tracking, and avatar
 *   pipelines do not exist.
 * - The `octicon-git-commit` leading glyph of the info line is outside the
 *   allowlist (not granted) — the line renders without it, the compare
 *   page's icon-reduction precedent.
 */

import type { CommitJson } from "@cf-gitea/git-engine";

import {
  branchRef,
  engineCell,
  engineReads,
  refTipMap,
  type EngineDivergenceResult,
} from "../../api/services/engine";
import { emitWebhookDeliveries } from "../../issues/webhooks";
import { apiUserFromRow, toApiRepository, type RepositoryWithOwner, type UserRow } from "../../api/services/repository";
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
import { ExploreSearchForm } from "./explore";
import { TimeSince } from "../components/file-list";
import { commitLink, treeLink } from "../links";
import { shortSha } from "../page-data";
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
} as const;

/** Upstream `setting.Git.BranchesRangeSize` (modules/setting/git.go:45). */
export const BRANCHES_PAGE_SIZE = 20;

// ---------------------------------------------------------------------------
// Data loading (§3.2 — the landed reads, never a self-fetch)
// ---------------------------------------------------------------------------

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
  /** The list table's rows (the default branch excluded — upstream
   *  ExcludeBranchNames), keyword-filtered, one page. */
  rows: BranchRowView[];
}

/** The page doer's protection-context identity (anonymous → the all-false
 *  access — principalAccessOfRow's null arm). */
function protectionDoer(viewer: Viewer): { id: number; username: string; isAdmin: boolean } | null {
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
  // The API LIST's universe: refs/heads/ filtered, name-sorted (byte order —
  // the API route's comparator).
  const branchNames = (refs?.refs ?? [])
    .filter((ref) => ref.name.startsWith("refs/heads/"))
    .map((ref) => ref.name.slice("refs/heads/".length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // The §4.9 default-branch fallbacks (the ref-suffix resolver's convention):
  // the D1 default branch when it exists, else the first branch, else null.
  const defaultBranch = branchNames.includes(repo.defaultBranch) ? repo.defaultBranch : (branchNames[0] ?? null);

  // The protection context (the API LIST's loadBranchProtectionContext
  // composition): rules once, the doer's access pair once.
  const rules = await listRepoRules(db, repo.id);
  const access = await principalAccessOfRow(db, repo, protectionDoer(options.viewer));

  const defaultExtras =
    defaultBranch !== null ? await rowExtras(db, rules, access, defaultBranch, true) : null;
  const defaultCommit = defaultBranch !== null ? await reads.readCommit(defaultBranch) : null;

  // The keyword filter (case-insensitive substring — the search combo's
  // honest stand-in for upstream's SQL LIKE) over the non-default universe.
  const needle = options.keyword.trim().toLowerCase();
  const others = branchNames.filter((name) => name !== defaultBranch);
  const filtered = needle === "" ? others : others.filter((name) => name.toLowerCase().includes(needle));

  // Pagination (§4.11 clamps) over the filtered list; the reads run for the
  // rendered slice only (the page-data ENRICH_MAX budget discipline).
  const page = Math.max(options.page, 1);
  const start = (page - 1) * BRANCHES_PAGE_SIZE;
  const pageNames = filtered.slice(start, start + BRANCHES_PAGE_SIZE);
  const more = filtered.length > start + BRANCHES_PAGE_SIZE;

  const rows = await Promise.all(
    pageNames.map(async (name): Promise<BranchRowView> => {
      const extras = await rowExtras(db, rules, access, name, false);
      const [commit, divergence] = await Promise.all([
        reads.readCommit(name),
        readDivergence(reads, defaultBranch, name),
      ]);
      return { name, commit, divergence, ...extras };
    }),
  );

  return {
    keyword: options.keyword,
    page,
    more,
    defaultBranch,
    defaultIsProtected: defaultExtras?.isProtected ?? false,
    defaultRuleName: defaultExtras?.ruleName ?? "",
    defaultCommit,
    rows,
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
    await replayBranchDeleteWebhook(env, input, name);
  }
  // `already-absent` (currentOid null) lands here: the arm answers 204
  // without an event; the flash reads deleted.
  return { outcome: "deleted", name };
}

/** routes/branches.ts emitRefWebhook's port for the `delete` event: the
 *  upstream DeletePayload (notifier.go:858→:870 — pusher_type "user", ref
 *  the SHORT name), the delivery rows INLINE, only the Queue producer
 *  hanging off waitUntil when the binding is wired (the route's structural
 *  probe). */
async function replayBranchDeleteWebhook(env: Env, input: BranchDeleteInput, branchName: string): Promise<void> {
  const queueCandidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  const queue =
    typeof queueCandidate === "object" &&
    queueCandidate !== null &&
    typeof (queueCandidate as { sendBatch?: unknown }).sendBatch === "function"
      ? { sendBatch: (queueCandidate as { sendBatch: (messages: { body: WebhookDeliveryMessage }[]) => Promise<unknown> }).sendBatch.bind(queueCandidate) }
      : null;
  const viewer = { origin: input.origin, requester: apiUserFromRow(input.doer, { origin: input.origin, requester: null }) };
  try {
    await emitWebhookDeliveries(
      env.DB,
      {
        repoId: input.pair.repo.id,
        ownerId: input.pair.repo.ownerId,
        eventType: "delete",
        refName: branchRef(branchName),
        payload: {
          ref: branchName,
          ref_type: "branch",
          pusher_type: "user",
          repository: toApiRepository(viewer, input.pair),
          sender: apiUserFromRow(input.doer, viewer),
        },
      },
      {
        enqueue:
          queue !== null && input.waitUntil !== undefined
            ? (deliveryIds) => {
                input.waitUntil!(
                  queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(undefined, (error: unknown) => {
                    console.error(`[branches] delivery enqueue failed (delete): ${error instanceof Error ? error.message : String(error)}`);
                  }),
                );
              }
            : undefined,
      },
    );
  } catch (error) {
    console.error(`[branches] webhook fan-out failed (delete): ${error instanceof Error ? error.message : String(error)}`);
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

/** The `p.info` last-commit line (the template's shape minus the
 *  non-allowlisted leading glyph and the pusher namelink — the header's
 *  reductions): ShortSha link · subject · "Updated" TimeSince · author. */
function BranchCommitInfo(props: { repoLink: string; commit: CommitJson }) {
  const { commit } = props;
  return (
    <p class="info tw-flex tw-items-center tw-my-1">
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
 *  `?delete_error=&name=` carry upstream DeleteBranchPost's texts). */
function BranchesFlash(props: { deleted: string | null; errorKind: string | null; errorName: string }) {
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
  return null;
}

/** The full-document render (the render.tsx pattern). `canAdmin` gates the
 *  Switch Default Branch link (the settings page's own gate — the module
 *  header's divergence note). */
export function renderBranchesPage(options: { ctx: UiContext; data: BranchesData; canAdmin: boolean; flash: { deleted: string | null; errorKind: string | null; errorName: string } }): string {
  return renderPage(
    <BranchesPage ctx={options.ctx} data={options.data} canAdmin={options.canAdmin} flash={options.flash} />,
  );
}

/** The branches page (§2.4.1 discriminator: list.tmpl's literal
 *  `ui repository branches`). */
export function BranchesPage(props: { ctx: UiContext; data: BranchesData; canAdmin: boolean; flash: { deleted: string | null; errorKind: string | null; errorName: string } }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("BranchesPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
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
                  <td />
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
            {/* thead additive (the default section's note); the empty third
                th is the actions column (the mirror-table convention). */}
            <thead>
              <tr>
                <th scope="col" class="eight wide">
                  Branch
                </th>
                <th scope="col" class="two wide">
                  Commit divergence
                </th>
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
                  <td class="three wide">
                    <div class="tw-flex tw-flex-wrap tw-justify-end">
                      {row.canDelete ? <BranchDeleteForm repoLink={repoLink} name={row.name} /> : null}
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
