/**
 * The pull auto-merge service (migration 0059's `pull_auto_merges` table —
 * upstream models/pull/automerge.go + services/automerge/automerge.go +
 * the merge-box's MWCS arms in routers/web/repo/pull.go).
 *
 * ## The lifecycle (upstream's, arm for arm)
 *
 *   SCHEDULE   web POST /pulls/{index}/merge with `merge_when_checks_succeed`
 *              (pull.go:1135-1149): the landed merge ladder's schedule arm —
 *              pages/pull-merge-box.tsx mergePullRequestFromWeb — deletes any
 *              existing row, inserts this one (models' ScheduleAutoMerge,
 *              models/pull/automerge.go:54-75) and creates the type-34 system comment
 *              (CreateAutoMergeComment, comment.go:1257) — then the FIRST
 *              check is enqueued (StartAutoMergeCheckByPullHead).
 *   CHECK      upstream runs a unique queue whose item pins
 *              `pr:{pullID}:{headCommitID}` and whose handler
 *              (handlePullRequestAutoMerge, services/automerge/automerge.go:
 *              132-251) re-checks everything at consume time. Ours:
 *              `{kind: "auto-merge-check",
 *              issueId}` messages on the standing REPO_TASKS queue — the cron
 *              producer (enqueueDueAutoMergeChecks) re-probes every scheduled
 *              row each tick, so a red PR that turns green merges on the
 *              tick after its last status flips (upstream is notify-driven;
 *              the interval is the landed adaptation — "crons enqueue,
 *              consumers work", AGENTS.md).
 *   CANCEL     web POST /pulls/{index}/cancel_auto_merge (pull.go:1251-1290):
 *              the landed cancel arm — pages/pull-merge-box.tsx
 *              cancelAutoMergeFromWeb — deletes the row and creates the
 *              type-35 comment (RemoveScheduledAutoMerge, services/automerge/
 *              automerge.go:91-100).
 *
 * ## The consume-time ladder (handlePullRequestAutoMerge's order)
 *
 *   not scheduled → skip; closed/merged → DELETE the row and skip; the
 *   stored quick check (not MERGEABLE — IsStatusMergeable has no Empty arm,
 *   models/issues/pull.go:446-448 / WIP) → skip; head branch missing →
 *   skip; the doer's merge permission gone → skip;
 *   the fresh mergeability check (ensurePullRequestChecked — the General
 *   re-check CheckPullMergeable runs at merge time) not mergeable → skip;
 *   required commit statuses not green at the CHECKED row's fresh sha
 *   (IsPullCommitStatusPass, commit_status.go:73 — the rule's required-
 *   context merge, ported below) → skip (THE schedule waits);
 *   branch protections failed → skip; an open dependency remains
 *   (CheckPullMergeable's final arm, check.go:219-222) → skip; otherwise
 *   MERGE with the row's style/message/delete-branch, DELETE the row,
 *   re-issue the merge webhook + feed action (the landed merge route's emit
 *   arms), and run the flagged delete-branch after merge
 *   (ShouldDeleteBranchAfterMerge's best-effort tail).
 *
 * A skip LEAVES the row scheduled (upstream's errSkipAutoMerge) — the next
 * tick re-probes. Only the closed/merged arm and the successful merge
 * delete it.
 *
 * ## Divergences (each cited at the seam)
 *
 * - The head-sha gate: upstream's queue item pins the sha it was enqueued
 *   for and skips when the ref moved (services/automerge/automerge.go:165-178);
 *   the cron re-probe has no stale item — it re-reads the LIVE head every
 *   tick (upstream itself re-gets the latest sha "to handle the case where
 *   the check of a previous push did not succeed", automerge.go:180-182 —
 *   the read itself sits inside IsPullCommitStatusPass, commit_status.go:
 *   126-135) and the status gate reads that fresh sha, never the row's
 *   stored one. The row's `sha` stays the schedule-time record.
 * - `MergedCommitID` (upstream's post-merge stamp) has no landed column —
 *   the merge's own `pull_requests.merged_commit_id` is the record.
 * - `EffectiveRequiredContexts` (the owner/admin mandated scoped checks,
 *   commit_status.go:88-97) has no landed source — the rule's stored
 *   `statusCheckContexts` are the only required contexts (the SPEC-0013
 *   §6 stored-only posture).
 * - The doer's noreply email fallback in the merge commit stamps rides a
 *   synthetic request origin — the queue consumer has no request (the
 *   merge-person fallback's hostname arm).
 */

import { eq, asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Context } from "hono";

import type { ApiEnv } from "../api/env";
import { ApiError } from "../api/errors";
import { ActionType, recordAction } from "../api/services/activity-feeds";
import { hasWorkInProgressPrefix, issueNoDependenciesLeft } from "../api/services/issues";
import { combinedStateOf, latestCommitStatuses } from "../api/services/commit-status";
import type { CommitStatusState } from "../api/models/commit-status";
import {
  deleteBranchAfterMerge,
  ensurePullRequestChecked,
  mergePullRequest,
  pullRequestDiffShortStat,
} from "../api/services/pull-engine";
import { findPullRequestByIndex, toApiPullRequest } from "../api/services/pulls";
import { engineReads } from "../api/services/engine";
import { findRepositoryById, toApiRepository } from "../api/services/repository";
import {
  checkPullBranchProtections,
  findRule,
  isUserMergeWhitelisted,
  parseRuleConfig,
  principalAccessOf,
  type ProtectedBranchConfig,
} from "./branch-protection";
import { emitIssueEvent } from "./issue-events";
import { issues, PRFlow, PRStatus, pullAutoMerges, pullRequests, users, type CommitStatusRow } from "../db/schema";
import type { User } from "../api/models/user";
import { CommentType } from "../issues/comment-types";
import { IssuesService, type IssueRow } from "../issues/service";

/** The scheduled row (upstream `pull.AutoMerge`). */
export type PullAutoMergeRow = typeof pullAutoMerges.$inferSelect;

// ---------------------------------------------------------------------------
// The required-context status combine (services/pull/commit_status.go)
// ---------------------------------------------------------------------------

const GLOB_SPECIAL = "*?[]{}\\,";

/** `createRequiredContextMatcher`'s glob walk (pull.go:584-594's compile —
 *  the same port pages/pull-merge-box.tsx renders with; one semantic, two
 *  consumers: the box DISPLAYS it, the consumer ENFORCES it). */
export function contextMatchesRequired(pattern: string, context: string): boolean {
  let out = "^";
  for (let pos = 0; pos < pattern.length; pos++) {
    const c = pattern[pos]!;
    if (c === "*") {
      if (pattern[pos + 1] === "*") {
        pos += 1;
        out += ".*";
      } else {
        out += ".*"; // no separators — `*` crosses `/` like upstream's status_check_contexts
      }
    } else if (c === "?") {
      out += ".";
    } else if (c === "[") {
      let cls = "[";
      pos += 1;
      if (pattern[pos] === "!" || pattern[pos] === "^") {
        cls += "^";
        pos += 1;
      }
      let closed = false;
      for (; pos < pattern.length; pos++) {
        const cc = pattern[pos]!;
        if (cc === "]") {
          if (cls === "[" || cls === "[^") return false; // `[]`/`[^]` — the error path
          cls += "]";
          closed = true;
          break;
        }
        cls += cc === "\\" ? `\\${pattern[++pos] ?? ""}` : cc;
      }
      if (!closed) return false; // unterminated class
      out += cls;
    } else if (c === "{") {
      out += "(?:";
      let depth = 1;
      let sub = "";
      for (pos += 1; pos < pattern.length; pos++) {
        const sc = pattern[pos]!;
        if (sc === "{") {
          depth += 1;
          sub += sc;
        } else if (sc === "}") {
          depth -= 1;
          if (depth === 0) break;
          sub += sc;
        } else {
          sub += GLOB_SPECIAL.includes(sc) && sc !== "," ? `\\${sc}` : sc;
        }
      }
      if (depth !== 0) return false; // unterminated `{...}`
      out += sub.replaceAll(",", "|");
      out += ")";
    } else if (GLOB_SPECIAL.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  try {
    return new RegExp(`${out}$`).test(context);
  } catch {
    return pattern === context; // the compile error path's exact-string fallback
  }
}

/** `MergeRequiredContextsCommitStatus` (services/pull/commit_status.go:26-68):
 *  no statuses → pending; no required contexts → the plain combine;
 *  otherwise the combine over the matched statuses, pending until EVERY
 *  context matched — unless the matched set already failed. */
export function mergeRequiredContextsCommitStatus(
  statuses: CommitStatusRow[],
  requiredContexts: string[],
): CommitStatusState {
  if (statuses.length === 0) return "pending";
  if (requiredContexts.length === 0) return combinedStateOf(statuses);
  const matched: CommitStatusRow[] = [];
  let allMatched = true;
  for (const pattern of requiredContexts) {
    let contextMatched = false;
    for (const status of statuses) {
      if (contextMatchesRequired(pattern, status.context)) {
        matched.push(status);
        contextMatched = true;
      }
    }
    allMatched = allMatched && contextMatched;
  }
  if (matched.length === 0) return "pending";
  const returned = combinedStateOf(matched);
  if (allMatched) return returned;
  return returned === "failure" ? "failure" : "pending";
}

/** `IsPullCommitStatusPass` (commit_status.go:73-101): no rule → true; the
 *  rule's required contexts (the landed `statusCheckContexts` — the
 *  EffectiveRequiredContexts scoped half has no source, module doc) merged
 *  over the latest statuses at the head sha must be `success`. */
export async function isPullCommitStatusPass(
  d1: D1Database,
  repoId: string,
  headSha: string | null,
  config: ProtectedBranchConfig | null,
): Promise<boolean> {
  if (config === null) return true; // pb == nil → true
  const required = config.statusCheckContexts;
  if (!config.enableStatusCheck && required.length === 0) return true; // nothing in effect
  if (headSha === null || headSha === "") return required.length === 0;
  const statuses = (await latestCommitStatuses(d1, repoId, headSha, 1, 100)).items;
  return mergeRequiredContextsCommitStatus(statuses, required) === "success";
}

// ---------------------------------------------------------------------------
// The model arms (models/pull/automerge.go)
// ---------------------------------------------------------------------------

/** `GetScheduledMergeByPullID` (automerge.go:80-88) — the row, or null. */
export async function getScheduledAutoMerge(d1: D1Database, issueId: number): Promise<PullAutoMergeRow | null> {
  return (await drizzle(d1).select().from(pullAutoMerges).where(eq(pullAutoMerges.issueId, issueId)).get()) ?? null;
}

interface ScheduleAutoMergeInput {
  issueId: number;
  doerId: number;
  sha: string;
  style: string;
  message: string;
  deleteBranchAfterMerge: boolean;
}

/** The bare insert (models' ScheduleAutoMerge's tail, models/pull/automerge.go:67-74). */
async function insertAutoMergeRow(d1: D1Database, input: ScheduleAutoMergeInput, now: Date): Promise<PullAutoMergeRow> {
  const rows = await drizzle(d1)
    .insert(pullAutoMerges)
    .values({
      issueId: input.issueId,
      doerId: input.doerId,
      sha: input.sha,
      mergeStyle: input.style,
      deleteBranchAfterMerge: input.deleteBranchAfterMerge,
      mergeMessage: input.message === "" ? null : input.message,
      createdUnix: Math.floor(now.getTime() / 1000),
    })
    .returning();
  return rows[0]!;
}

/** The schedule write (models' ScheduleAutoMerge + the web handler's
 *  delete-first, pull.go:1136): any existing row goes, then the insert. The
 *  type-34 comment rides the caller (the web ladder runs it inside its own
 *  outcome — same model split upstream: the model inserts, the service
 *  comments). */
export async function scheduleAutoMergeRow(
  d1: D1Database,
  input: ScheduleAutoMergeInput,
  now: Date,
): Promise<PullAutoMergeRow> {
  await drizzle(d1).delete(pullAutoMerges).where(eq(pullAutoMerges.issueId, input.issueId));
  return insertAutoMergeRow(d1, input, now);
}

/** The model's ScheduleAutoMerge WITHOUT the web handler's delete-first —
 *  the API arm's shape (api pull.go:994-1000): a standing row is KEPT and
 *  reported (upstream answers IsErrAlreadyScheduledToAutoMerge → 409; the
 *  model raises it from the GetScheduledMergeByPullID exists-check,
 *  models/pull/automerge.go:54-62). Returns null when a row was already
 *  standing (the caller answers the conflict); the type-34 comment rides the
 *  caller. */
export async function insertScheduledAutoMergeRow(
  d1: D1Database,
  input: ScheduleAutoMergeInput,
  now: Date,
): Promise<PullAutoMergeRow | null> {
  if ((await getScheduledAutoMerge(d1, input.issueId)) !== null) return null;
  return insertAutoMergeRow(d1, input, now);
}

/** `DeleteScheduledAutoMerge` (models/pull/automerge.go:90-91) — true when a row went. */
export async function deleteScheduledAutoMerge(d1: D1Database, issueId: number): Promise<boolean> {
  const rows = await drizzle(d1).delete(pullAutoMerges).where(eq(pullAutoMerges.issueId, issueId)).returning({ id: pullAutoMerges.id });
  return rows.length > 0;
}

/** `RemoveScheduledAutoMerge` (services/automerge/automerge.go:110-120): the
 *  delete + the type-35 comment ONLY when a row existed. */
export async function removeScheduledAutoMerge(
  d1: D1Database,
  issue: IssueRow,
  doerId: number,
  now: Date,
): Promise<boolean> {
  const deleted = await deleteScheduledAutoMerge(d1, issue.id);
  if (!deleted) return false;
  await new IssuesService(d1).addComment({
    issueId: issue.id,
    posterId: doerId,
    type: CommentType.PRUnscheduledToAutoMerge,
    content: "",
    now,
  });
  return true;
}

/** `CreateAutoMergeComment`'s scheduled half (comment.go:1257-1273): the
 *  bare type-34 system comment (empty content — upstream's CreateComment
 *  with no message). */
export async function createScheduledAutoMergeComment(d1: D1Database, issueId: number, doerId: number, now: Date): Promise<void> {
  await new IssuesService(d1).addComment({
    issueId,
    posterId: doerId,
    type: CommentType.PRScheduledToAutoMerge,
    content: "",
    now,
  });
}

// ---------------------------------------------------------------------------
// The queue message + producer (services/automerge/automerge.go Init's
// populateRecentAutoMergeItems shape — every scheduled row, every tick)
// ---------------------------------------------------------------------------

/** The REPO_TASKS message (upstream's `pr:{pullID}:{headCommitID}` queue
 *  item reduced to the row key — the consumer re-reads the live sha). */
export interface AutoMergeCheckMessage {
  kind: "auto-merge-check";
  issueId: number;
}

export function isAutoMergeCheckMessage(value: unknown): value is AutoMergeCheckMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as AutoMergeCheckMessage).kind === "auto-merge-check" &&
    typeof (value as AutoMergeCheckMessage).issueId === "number"
  );
}

/** The env slice the producer touches (the DemoSweepProducerEnv posture —
 *  optional members so the gate-off/unbound tests drive it structurally). */
export type AutoMergeProducerEnv = Partial<Pick<Env, "DB" | "REPO_TASKS">>;

/** Per-tick page size (the mirror producers' LIMIT 50). */
export const AUTO_MERGE_CHECK_PAGE_LIMIT = 50;

/**
 * The cron producer: SELECT the scheduled rows (oldest first — the mirror
 * producers' order), enqueue one check message per row. SELECT + enqueue
 * ONLY (the sub-hour cron's 30 s CPU budget, AGENTS.md) — the ladder runs
 * in the REPO_TASKS consumer. No CAS claim (unlike the mirror producer):
 * the row IS the state; the check is idempotent and a duplicate message
 * re-runs it harmlessly (the demo-sweep posture). Returns the number of
 * messages enqueued.
 */
export async function enqueueDueAutoMergeChecks(
  env: AutoMergeProducerEnv,
  options: { limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? AUTO_MERGE_CHECK_PAGE_LIMIT;
  const db = env.DB;
  const queue = env.REPO_TASKS;
  if (db === undefined || queue === undefined) {
    throw new Error("DB/REPO_TASKS not bound (wrangler.jsonc); the auto-merge cron producer cannot enqueue");
  }
  const due = await drizzle(db)
    .select({ issueId: pullAutoMerges.issueId })
    .from(pullAutoMerges)
    .orderBy(asc(pullAutoMerges.createdUnix))
    .limit(limit);
  if (due.length === 0) return 0; // the quiet-tick probe — zero sends
  const messages: AutoMergeCheckMessage[] = due.map((row) => ({ kind: "auto-merge-check", issueId: row.issueId }));
  for (let i = 0; i < messages.length; i += 100) {
    await queue.sendBatch(messages.slice(i, i + 100).map((message) => ({ body: message })));
  }
  console.log(`[auto-merge] enqueued ${messages.length} check(s)`);
  return messages.length;
}

// ---------------------------------------------------------------------------
// The consumer (services/automerge/automerge.go handlePullRequestAutoMerge)
// ---------------------------------------------------------------------------

/** The consumer's outcome (the skip classes are upstream's errSkipAutoMerge
 *  messages; a skip leaves the row scheduled). */
export type AutoMergeCheckOutcome =
  | "not-scheduled"
  | "deleted-closed-or-merged"
  | "skipped-not-mergeable"
  | "skipped-wip"
  | "skipped-head-branch-missing"
  | "skipped-status-checks"
  | "skipped-doer-missing"
  | "skipped-no-merge-permission"
  | "skipped-protections"
  | "skipped-dependencies"
  | "merge-failed"
  | "merged";

/** The tracked-waitUntil shim: the queue consumer has no ExecutionContext,
 *  so the emission's waitUntil arms are COLLECTED and awaited in-line — the
 *  deliveries still enqueue within the consumer's lifetime (a fire-and-
 *  forget waitUntil would risk the platform cutting the work when the
 *  handler returns). */
function trackedExecution(): { executionCtx: { waitUntil(promise: Promise<unknown>): void }; settle(): Promise<void> } {
  const tracked: Promise<unknown>[] = [];
  return {
    executionCtx: {
      waitUntil(promise: Promise<unknown>): void {
        tracked.push(promise);
      },
    },
    settle: () => Promise.allSettled(tracked).then(() => undefined),
  };
}

/** The synthetic request the consumer's engine/service calls ride (the
 *  merge-person hostname fallback's origin — no request exists here). */
function consumerApiContext(env: Env, doer: User): Context<ApiEnv> {
  const api = new Context<ApiEnv>(new Request("https://automerge.local/consumer", { method: "POST" }), { env });
  api.set("authUser", doer);
  return api;
}

/**
 * The check ladder for one scheduled row (upstream's order, module doc).
 * Never throws for EXPECTED states — a skip is a return; unexpected store/
 * engine failures throw (the queue retry signal, the mirror-sync posture).
 */
export async function handleAutoMergeCheck(env: Env, issueId: number, options: { now?: Date } = {}): Promise<AutoMergeCheckOutcome> {
  const now = options.now ?? new Date();
  const d1 = env.DB;
  const scheduled = await getScheduledAutoMerge(d1, issueId);
  if (scheduled === null) return "not-scheduled";

  const issueRows = await drizzle(d1).select().from(issues).where(eq(issues.id, issueId)).all();
  const issue = issueRows[0];
  if (issue === undefined) {
    // The PR is gone (the delete cascade does not know this table yet) —
    // nothing can ever merge; drop the schedule (upstream logs the lookup
    // error and leaves the row; our tick would re-probe forever).
    await deleteScheduledAutoMerge(d1, issueId);
    return "deleted-closed-or-merged";
  }
  const prRows = await drizzle(d1).select().from(pullRequests).where(eq(pullRequests.issueId, issueId)).all();
  const pr = prRows[0];
  if (pr === undefined) {
    await deleteScheduledAutoMerge(d1, issueId);
    return "deleted-closed-or-merged";
  }
  if (issue.isClosed || pr.hasMerged) {
    // closed or merged → delete the record and skip (automerge.go:136-141).
    await deleteScheduledAutoMerge(d1, issueId);
    return "deleted-closed-or-merged";
  }

  // The quick check on the STORED row (services/automerge/automerge.go:143-
  // 145): not mergeable or WIP → skip (the schedule waits; the next tick
  // re-probes). MERGEABLE ONLY — `pr.IsStatusMergeable()` is
  // `Status == PullRequestStatusMergeable` with NO Empty arm
  // (models/issues/pull.go:446-448): an Empty PR schedules (the Auto-type
  // gate is `!IsStatusMergeable() && !IsEmpty()`, check.go:170-172) but the
  // consumer skips it every tick, row kept — an empty diff never merges out
  // of a schedule.
  if (pr.status !== PRStatus.Mergeable) return "skipped-not-mergeable";
  if (hasWorkInProgressPrefix(issue.title)) return "skipped-wip";

  const pair = await findRepositoryById(d1, issue.repoId);
  if (pair === null) return "skipped-not-mergeable"; // the vanished base repo — nothing to merge into
  const headRepo = await findRepositoryById(d1, pr.headRepoId);

  // The head-branch existence check (automerge.go:183-196): Github flow →
  // the branch exists in the HEAD repo; AGit → the PR ref exists on base.
  // A failed (null) ref read is the missing arm — nothing to merge.
  if (pr.flow === PRFlow.Github) {
    if (headRepo === null) return "skipped-head-branch-missing";
    const refs = await engineReads(env, { ownerNamespace: headRepo.repo.ownerNamespace, slug: headRepo.repo.slug }).listRefs();
    if (refs === null || !refs.refs.some((entry) => entry.name === `refs/heads/${pr.headBranch}`)) return "skipped-head-branch-missing";
  } else if (pr.flow === PRFlow.AGit) {
    const refs = await engineReads(env, { ownerNamespace: pair.repo.ownerNamespace, slug: pair.repo.slug }).listRefs();
    if (refs === null || !refs.refs.some((entry) => entry.name === `refs/pull/${pr.index}/head`)) return "skipped-head-branch-missing";
  } else {
    return "skipped-not-mergeable"; // unsupported flow (upstream's default arm)
  }

  const rule = await findRule(d1, pair.repo.id, pr.baseBranch);
  const config = rule === null ? null : parseRuleConfig(rule.rules);

  // The scheduled doer (GetPossibleUserByID, automerge.go:211-214): a
  // vanished doer cannot merge (upstream errors — logged, row stays).
  const doerRows = await drizzle(d1).select().from(users).where(eq(users.id, scheduled.doerId)).all();
  const doerRow = doerRows[0];
  if (doerRow === undefined) return "skipped-doer-missing";
  const doer: User = { id: doerRow.id, login: doerRow.username, is_admin: doerRow.isAdmin, email: doerRow.email ?? undefined };

  // CheckPullMergeable's permission half at merge time (automerge.go:221-223
  // → check.go:155-160): the doer's base write + the merge whitelist.
  const access = await principalAccessOf(d1, pair.repo, doer);
  if (!(access.write && (config === null || (await isUserMergeWhitelisted(d1, config, access))))) {
    return "skipped-no-merge-permission";
  }

  // The fresh mergeability FIRST (CheckPullMergeTypeGeneral's mergeable-state
  // + IsChecking arms — the landed lazy check settles both). Upstream re-gets
  // the latest head sha before its status gate "to handle the case where the
  // check of a previous push did not succeed or was not finished yet"
  // (automerge.go:180-182; the live read sits INSIDE IsPullCommitStatusPass,
  // commit_status.go:126-135): the row's stored sha can lag a just-landed
  // push, and gating the statuses on it would merge the NEW head under the
  // OLD sha's green statuses — so the gate below reads the CHECKED row's sha.
  const api = consumerApiContext(env, doer);
  const checked = await ensurePullRequestChecked(api, pair, pr);
  if (checked.hasMerged) {
    await deleteScheduledAutoMerge(d1, issueId);
    return "deleted-closed-or-merged";
  }
  // Empty stays out of the fresh gate too: the quick check fixed the class
  // (Mergeable-only, automerge.go:146) — a PR that BECAME empty after
  // scheduling (the base absorbed the change) skips with the row kept, the
  // same wait-for-a-real-diff posture, never an empty commit out of a
  // schedule.
  if (checked.status !== PRStatus.Mergeable) return "skipped-not-mergeable";

  // IsPullCommitStatusPass — the schedule's whole point: wait here until
  // the required checks go green at the FRESH head sha (automerge.go:200-206).
  if (!(await isPullCommitStatusPass(d1, pair.repo.id, checked.headSha, config))) return "skipped-status-checks";

  // The branch protections at merge time (CheckPullMergeable General does
  // NOT skip them — approvals etc. must hold when green; the arm lives in
  // check.go:178-215, reached through the consumer's whole-ladder call,
  // automerge.go:221-223). The status-check arm inside now re-reads the SAME
  // fresh sha the explicit isPullCommitStatusPass gate above used.
  if (rule !== null) {
    const failure = await checkPullBranchProtections(d1, rule, { issueId, commitsBehind: checked.commitsBehind ?? 0, headSha: checked.headSha });
    if (failure !== null) return "skipped-protections";
  }

  // The open-dependency gate — CheckPullMergeable's FINAL arm (check.go:219-
  // 222, after the protections + signing arms), reached through the consumer's
  // whole-ladder call (automerge.go:221-223): an open blocker answers
  // errSkipAutoMerge ("pull request is not mergeable") and the scheduled row
  // STAYS — the blocker may still close while the checks hold green; the next
  // tick re-probes.
  if (!(await issueNoDependenciesLeft(d1, issueId))) return "skipped-dependencies";

  // Merge with the row's style/message/delete-branch (automerge.go:227-236).
  // A stored style outside the enum is corrupt data — skip (nothing to
  // merge with).
  const style = mergeStyleOf(scheduled.mergeStyle);
  if (style === null) return "skipped-not-mergeable";
  try {
    await mergePullRequest(api, pair, issue, checked, {
      style,
      message: scheduled.mergeMessage ?? "",
      deleteBranchAfterMerge: false, // the flag's arm runs AFTER the row delete, upstream's tail
      doerId: scheduled.doerId,
      now,
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // The FIXME upstream carries (automerge.go:232-235): the failure is
    // logged, the row STAYS scheduled (a transient conflict may clear).
    console.error(`[auto-merge] merge failed for issue ${issueId}: ${error.message}`);
    return "merge-failed";
  }

  // Merged — the record goes (the mission's "then deletes the row"; upstream
  // leaves the record to Merge()'s own cleanup arm).
  await deleteScheduledAutoMerge(d1, issueId);

  // The webhook + feed (the landed merge route's emit arms re-issued —
  // upstream fires them inside Merge's notify pass).
  try {
    const exec = trackedExecution();
    const merged = await findPullRequestByIndex(d1, pair.repo.id, checked.index);
    if (merged !== null) {
      const origin = "https://automerge.local";
      const viewer = { origin, requester: doer };
      const diffStats = await pullRequestDiffShortStat(api, pair, merged.pullRequest);
      const rendered = await toApiPullRequest(d1, viewer, pair, merged.issue, merged.pullRequest, "payload", diffStats === null ? undefined : { diffStats });
      await emitIssueEvent(
        { env, executionCtx: exec.executionCtx },
        {
          repoId: pair.repo.id,
          ownerId: pair.repo.ownerId,
          eventType: "pull_request",
          payload: {
            action: "closed",
            number: merged.issue.index,
            pull_request: rendered,
            repository: toApiRepository(viewer, pair),
            sender: doer,
            commit_id: merged.pullRequest.mergedCommitId ?? "",
          },
        },
        { now },
      );
      await recordAction(d1, {
        actUserId: scheduled.doerId,
        repoId: pair.repo.id,
        opType: ActionType.MergePullRequest,
        isPrivate: pair.repo.visibility === "private",
        content: `${merged.issue.index}|${merged.issue.title}`,
      });
    }
    await exec.settle();
  } catch (error) {
    console.error(`[auto-merge] post-merge emission failed (issue ${issueId}): ${error instanceof Error ? error.message : String(error)}`);
  }

  // The delete-branch tail (automerge.go:238-251): best-effort, never fails
  // the merge (upstream logs both the resolve and the delete arms).
  if (scheduled.deleteBranchAfterMerge) {
    try {
      const merged = await findPullRequestByIndex(d1, pair.repo.id, checked.index);
      if (merged !== null) {
        const result = await deleteBranchAfterMerge(api, pair, merged.issue, merged.pullRequest, {
          doerId: scheduled.doerId,
          now,
        });
        if (result.outcome === "failed") console.error(`[auto-merge] head-branch delete failed (issue ${issueId}): ${result.message}`);
      }
    } catch (error) {
      console.error(`[auto-merge] head-branch delete threw (issue ${issueId}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return "merged";
}

/** The stored style's enum read (repo_model.MergeStyle's binding — an
 *  out-of-enum row is corrupt data, the skip arm). */
const MERGE_STYLES = ["merge", "rebase", "rebase-merge", "squash", "fast-forward-only", "manually-merged"] as const;

function mergeStyleOf(raw: string): (typeof MERGE_STYLES)[number] | null {
  for (const style of MERGE_STYLES) {
    if (style === raw) return style;
  }
  return null;
}
