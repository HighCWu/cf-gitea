/**
 * Issues/PRs/releases service — SPEC-0005 §3 (data-layer write semantics).
 *
 * Every mutation is ONE `db.batch([...])`: D1 executes batches as a single
 * SQLite transaction and serializes writers, which is what makes the §3.1
 * allocation (counter bump + insert, atomically), the §4.1 no-gap guarantee
 * (a failed insert rolls its bump back) and the §4.2 close/reopen CAS race
 * (loser's dependent statements no-op) hold without a Durable Object.
 *
 * The CAS-dependent statements inside one batch are chained through SQLite's
 * `changes()` function: each gated statement is written as
 * `... WHERE <key> AND (SELECT changes()) > 0`, so it modifies exactly one
 * row when the previous statement won and zero rows when it lost — the gate
 * value propagates down the statement list. A D1 batch never aborts on
 * zero-row statements, so the loser's batch commits as a no-op and the
 * caller detects the loss via the CAS statement's empty `.returning()` rows.
 *
 * D1 access goes through Drizzle only (AGENTS.md); the `sql` fragments used
 * here are exactly the cases drizzle cannot express (changes() gating,
 * allocation subqueries) and live only in this service, never in routes.
 */

import { and, asc, eq, getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import {
  comments,
  issueLabels,
  issues,
  labels,
  milestones,
  pullRequests,
  releases,
  repoCounters,
  repositories,
  users,
  PRFlow,
  PRStatus,
} from "../db/schema";
import { CommentType, type CommentTypeValue } from "./comment-types";
import {
  IssueAlreadyChangedError,
  IssueNotExistError,
  MilestoneNotExistError,
  NoSuchLabelError,
  ReleaseAlreadyExistError,
  RepositoryNotExistError,
} from "./errors";
import { changeIssueTitle, replaceIssueAssignees } from "../api/services/issues";
import { findRepositoryById, type RepositoryWithOwner, type UserRow } from "../api/services/repository";
import {
  notifyIssueAssigneeChanged,
  notifyIssueComment,
  notifyIssueCreated,
  notifyIssueStatusChanged,
  notifyIssueTitleChanged,
  notifyPullRequestCreated,
  type MailNotifyEnv,
} from "../services/mail/notify";
import { updateIssueMentions } from "../services/mentions/carrier";
import { findIssueMentions } from "../services/mentions/service";

export type IssueRow = typeof issues.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type LabelRow = typeof labels.$inferSelect;
export type MilestoneRow = typeof milestones.$inferSelect;
export type ReleaseRow = typeof releases.$inferSelect;

/** §2.2: titles are truncated at 255 display-width characters. */
export const MAX_TITLE_DISPLAY_WIDTH = 255;

/** Statement type accepted by drizzle's D1 `batch`. */
type BatchStatement = Parameters<DrizzleD1Database["batch"]>[number][number];

/** The public `db.batch` signature requires a non-empty tuple. */
type BatchStatements = [BatchStatement, ...BatchStatement[]];

/**
 * Narrow one positional result of `db.batch` (typed `unknown` by drizzle) to
 * its row array. Runtime-checked: drizzle's D1 batch maps `.returning()`
 * statements to arrays of mapped rows (d1/session.js `mapResult`).
 */
function batchRows<T>(result: unknown, what: string): T[] {
  if (!Array.isArray(result)) {
    throw new Error(`unexpected D1 batch result for ${what}`);
  }
  return result as T[];
}

/** SQLite binds no booleans/dates: normalize raw `sql` parameters. */
function bindValue(value: unknown): number | string | null {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (value === undefined) return null;
  return value as number | string | null;
}

function toUnix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Port of `util.EllipsisDisplayString` (gitea/modules/util/truncate.go) with
 * the ASCII-width approximation for non-ASCII runes (width 2): truncates to
 * `limit` display-width characters and appends `…`; the result never exceeds
 * `limit` code points.
 */
export function ellipsisDisplayString(str: string, limit: number): string {
  if (limit < 1) return "";
  const runes = Array.from(str);
  const widthOf = (rune: string): number => ((rune.codePointAt(0) ?? 0) <= 0xff ? 1 : 2);
  let width = 0;
  let fits = true;
  for (const rune of runes) {
    width += widthOf(rune);
    if (width > limit) {
      fits = false;
      break;
    }
  }
  if (fits) return str;
  let keep = 0;
  let keptWidth = 0;
  while (keep < runes.length && keptWidth + widthOf(runes[keep]!) <= limit - 1) {
    keptWidth += widthOf(runes[keep]!);
    keep++;
  }
  return `${runes.slice(0, keep).join("")}…`;
}

/** True when a driver error's cause chain carries this UNIQUE violation. */
export function isUniqueViolation(error: unknown, ...columns: string[]): boolean {
  let text = error instanceof Error ? error.message : String(error);
  let cause: unknown = error;
  while (cause instanceof Error && cause.cause !== undefined) {
    cause = cause.cause;
    text += ` ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  return text.includes("UNIQUE constraint failed") && columns.every((c) => text.includes(c));
}

/** True when the label may attach to this repo (repo label or owner-org label). */
function labelAppliesToRepo(label: LabelRow, repoId: string, ownerOrgId: number | null): boolean {
  if (label.repoId === repoId) return true;
  return ownerOrgId !== null && label.repoId === null && label.orgId === ownerOrgId;
}

export interface CreateIssueInput {
  repoId: string;
  title: string;
  content?: string | null;
  posterId?: number | null;
  milestoneId?: number | null;
  /** Label ids to attach at creation; validated before the batch. */
  labelIds?: number[];
  /** Owner org id for the org-label drop rule (§3.2 labels paragraph). */
  ownerOrgId?: number | null;
  /** Branch reference for close-via-commit gating (§4.6). */
  ref?: string | null;
  now?: Date;
}

export interface CreatePullRequestInput extends CreateIssueInput {
  headRepoId: string;
  baseBranch: string;
  headBranch: string;
  /** Merge base sha when already known (engine read); null until checked. */
  mergeBase?: string | null;
  /** Initial `refs/pull/N/head` target cache, when known at creation. */
  headSha?: string | null;
  allowMaintainerEdit?: boolean;
  flow?: (typeof PRFlow)[keyof typeof PRFlow];
}

export interface TransitionOptions {
  actorId?: number | null;
  /** System comment type override — the merge path writes MergePull (§2.4). */
  commentType?: CommentTypeValue;
  now?: Date;
}

export interface AddCommentInput {
  issueId: number;
  posterId?: number | null;
  content: string;
  /** Defaults to a plain user comment (type 0). */
  type?: CommentTypeValue;
  now?: Date;
}

export interface LabelOperationOptions {
  ownerOrgId?: number | null;
  now?: Date;
}

export interface CreateMilestoneInput {
  repoId: string;
  name: string;
  content?: string | null;
  deadlineAt?: Date | null;
  now?: Date;
}

export interface UpdateMilestonePatch {
  name?: string;
  content?: string | null;
  deadlineAt?: Date | null;
  /** Lifecycle state; closing stamps closed_date_unix (upstream PATCH semantics). */
  state?: "open" | "closed";
  now?: Date;
}

export interface CreateReleaseInput {
  repoId: string;
  publisherId: number;
  tagName: string;
  target?: string | null;
  title?: string;
  note?: string;
  isDraft?: boolean;
  isPrerelease?: boolean;
  /** Pure tag record (§2.3); a release creation converts it (§4.11). */
  isTag?: boolean;
  now?: Date;
}

export interface ReplaceLabelsResult {
  added: number[];
  removed: number[];
}

export type MilestoneStateFilter = "open" | "closed" | "all";

export class IssuesService {
  private readonly db: DrizzleD1Database;
  private readonly d1: D1Database;
  /**
   * The mail-notify arms' env (specs/email-outbound.md §8): when present,
   * the write paths fan the notify mail through the receiver arms —
   * `addComment` the plain-comment one (upstream CreateIssueComment,
   * services/mailer/notify.go:31-51), `createIssue` the NewIssue one
   * (:53-58), `closeIssue`/`reopenIssue` the IssueChangeStatus one (:59-76)
   * and `createPullRequest` the NewPullRequest one (:88-93) — notify fires
   * from the model layer, never the router. Absent (every existing
   * construction site passes D1 only) the arms are off — the same
   * fail-closed posture as `MAIL_ENABLED != "true"`, so callers are
   * untouched.
   */
  private readonly mailEnv?: MailNotifyEnv;

  constructor(d1: D1Database, mailEnv?: MailNotifyEnv) {
    this.d1 = d1;
    this.db = drizzle(d1);
    this.mailEnv = mailEnv;
  }

  // ---------------------------------------------------------------------------
  // Counter bootstrap / repair (§3.1)
  // ---------------------------------------------------------------------------

  /**
   * Create the repo's counter row (`issue_index = 0`); idempotent. Called
   * with the repository creation; `createIssue` also self-heals it as the
   * first batch statement (ON CONFLICT DO NOTHING — race-safe under D1's
   * single-writer serialization).
   */
  async ensureRepoCounters(repoId: string): Promise<void> {
    try {
      await this.db
        .insert(repoCounters)
        .values({ repoId, issueIndex: 0 })
        .onConflictDoNothing()
        .returning({ repoId: repoCounters.repoId })
        .all();
    } catch (error) {
      if (this.isForeignKeyViolation(error)) throw new RepositoryNotExistError(repoId);
      throw error;
    }
  }

  private isForeignKeyViolation(error: unknown): boolean {
    let text = error instanceof Error ? error.message : String(error);
    let cause: unknown = error;
    while (cause instanceof Error && cause.cause !== undefined) {
      cause = cause.cause;
      text += ` ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    return text.includes("FOREIGN KEY constraint failed");
  }

  /**
   * Repair path (§3.1, upstream `SyncMaxResourceIndex`): re-sync the counter
   * to at least `maxIndex` after a manual row delete or an import. Never
   * rewinds (counters are never reused, §2.2). Returns true when moved.
   */
  async syncMaxIssueIndex(repoId: string, maxIndex: number): Promise<boolean> {
    const result = await this.db
      .update(repoCounters)
      .set({ issueIndex: maxIndex })
      .where(and(eq(repoCounters.repoId, repoId), sql`${repoCounters.issueIndex} < ${maxIndex}`))
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async getIssueById(id: number): Promise<IssueRow | null> {
    const row = await this.db.select().from(issues).where(eq(issues.id, id)).get();
    return row ?? null;
  }

  async getIssueByIndex(repoId: string, index: number): Promise<IssueRow | null> {
    const row = await this.db
      .select()
      .from(issues)
      .where(and(eq(issues.repoId, repoId), eq(issues.index, index)))
      .get();
    return row ?? null;
  }

  async getMilestone(id: number): Promise<MilestoneRow | null> {
    const row = await this.db.select().from(milestones).where(eq(milestones.id, id)).get();
    return row ?? null;
  }

  async listMilestones(repoId: string, state: MilestoneStateFilter = "open"): Promise<MilestoneRow[]> {
    const conditions = [eq(milestones.repoId, repoId)];
    if (state !== "all") conditions.push(eq(milestones.isClosed, state === "closed"));
    return this.db
      .select()
      .from(milestones)
      .where(and(...conditions))
      .orderBy(asc(milestones.id))
      .all();
  }

  // ---------------------------------------------------------------------------
  // Issue + PR creation (§3.1 allocation, §2.2/§2.4 semantics)
  // ---------------------------------------------------------------------------

  /**
   * Create an issue: one batch = [counter bootstrap, counter bump RETURNING,
   * issue INSERT with the allocated index, repo/milestone/label counters].
   * Concurrent creations serialize in D1 and draw strictly sequential
   * indexes; a failed insert rolls its bump back (§4.1).
   */
  async createIssue(input: CreateIssueInput): Promise<IssueRow> {
    const { statements, resultIndex } = await this.issueCreationStatements(input, { isPull: false });
    const results = await this.db.batch(statements);
    const rows = batchRows<IssueRow>(results[resultIndex.issueInsert], "issue insert");
    if (rows[0] === undefined) {
      throw new Error("issue creation batch committed without returning rows");
    }
    await this.notifyMailNewIssue(rows[0], input.now ?? new Date());
    return rows[0];
  }

  /**
   * Create a pull request: the issue row (`is_pull = 1`) and the
   * `pull_requests` row share ONE batch with the counter allocation — PRs and
   * issues draw from one per-repo sequence (§2.2/§3.1) — and the PR row lands
   * with `status = checking` (§3.4). Repo counter: `num_pulls`.
   */
  async createPullRequest(input: CreatePullRequestInput): Promise<{ issue: IssueRow; pullRequest: PullRequestRow }> {
    const { statements, resultIndex } = await this.issueCreationStatements(input, { isPull: true });
    // 4: pull_requests row — placed directly after the issues insert; its
    // issue_id/index resolve inside the transaction from that row.
    const indexSub = this.issueIndexSubquery(input.repoId);
    statements.splice(
      resultIndex.issueInsert + 1,
      0,
      this.db
        .insert(pullRequests)
        .values({
          issueId: this.issueIdSubquery(input.repoId, indexSub),
          index: indexSub,
          status: PRStatus.Checking,
          headRepoId: input.headRepoId,
          baseRepoId: input.repoId,
          headBranch: input.headBranch,
          baseBranch: input.baseBranch,
          mergeBase: input.mergeBase ?? null,
          headSha: input.headSha ?? null,
          allowMaintainerEdit: input.allowMaintainerEdit ?? false,
          flow: input.flow ?? PRFlow.Github,
        })
        .returning(),
    );
    const results = await this.db.batch(statements);
    const issue = batchRows<IssueRow>(results[resultIndex.issueInsert], "issue insert")[0];
    const pullRequest = batchRows<PullRequestRow>(results[resultIndex.issueInsert + 1], "pull request insert")[0];
    if (issue === undefined || pullRequest === undefined) {
      throw new Error("issue/PR creation batch committed without returning rows");
    }
    await this.notifyMailNewPullRequest(issue, input.now ?? new Date());
    return { issue, pullRequest };
  }

  /** Build the full creation batch; shared by createIssue/createPullRequest. */
  private async issueCreationStatements(
    input: CreateIssueInput,
    options: { isPull: boolean },
  ): Promise<{ statements: BatchStatements; resultIndex: { issueInsert: number } }> {
    const now = input.now ?? new Date();
    const title = ellipsisDisplayString(input.title, MAX_TITLE_DISPLAY_WIDTH);
    const labelIds = [...new Set(input.labelIds ?? [])];

    if (input.milestoneId != null) {
      await this.validateMilestone(input.milestoneId, input.repoId);
    }
    if (labelIds.length > 0) {
      await this.validateLabels(labelIds, input.repoId, input.ownerOrgId ?? null);
    }

    const indexSub = this.issueIndexSubquery(input.repoId);
    const statements: BatchStatements = [
      // 0: race-safe bootstrap (§3.1 — normally created with the repository).
      this.db.insert(repoCounters).values({ repoId: input.repoId }).onConflictDoNothing(),
      // 1: allocate — bump + read in one statement (§3.1).
      this.db
        .update(repoCounters)
        .set({ issueIndex: sql`issue_index + 1` })
        .where(eq(repoCounters.repoId, input.repoId))
        .returning({ allocated: repoCounters.issueIndex }),
      // 2: insert with the freshly bumped index (same transaction ⇒ visible).
      this.db
        .insert(issues)
        .values({
          repoId: input.repoId,
          index: indexSub,
          posterId: input.posterId ?? null,
          title,
          content: input.content ?? null,
          isPull: options.isPull,
          ref: input.ref ?? "",
          milestoneId: input.milestoneId ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
      // 3: repo counters — pulls are counted separately from issues (§3.2).
      this.db
        .update(repositories)
        .set(options.isPull ? { numPulls: sql`num_pulls + 1` } : { numIssues: sql`num_issues + 1` })
        .where(eq(repositories.id, input.repoId)),
    ];
    const resultIndex = { issueInsert: 2 };

    if (input.milestoneId != null) {
      // Milestone/label counters count PRs too (upstream updateIssueNumbers).
      statements.push(
        this.db
          .update(milestones)
          .set({
            numIssues: sql`num_issues + 1`,
            completeness: sql`CASE WHEN num_issues + 1 > 0 THEN num_closed_issues * 100 / (num_issues + 1) ELSE 0 END`,
          })
          .where(eq(milestones.id, input.milestoneId)),
      );
    }
    for (const labelId of labelIds) {
      statements.push(
        this.db.insert(issueLabels).values({ issueId: this.issueIdSubquery(input.repoId, indexSub), labelId }).onConflictDoNothing(),
      );
      // Gate the counter on the link insert having actually added a row.
      statements.push(
        this.db
          .update(labels)
          .set({ numIssues: sql`num_issues + 1` })
          .where(and(eq(labels.id, labelId), sql`(SELECT changes()) > 0`)),
      );
    }
    return { statements, resultIndex };
  }

  private issueIndexSubquery(repoId: string): SQL {
    return sql`(SELECT issue_index FROM repo_counters WHERE repo_id = ${repoId})`;
  }

  private issueIdSubquery(repoId: string, indexSub: SQL): SQL {
    return sql`(SELECT id FROM issues WHERE repo_id = ${repoId} AND "index" = ${indexSub})`;
  }

  private async validateMilestone(milestoneId: number, repoId: string): Promise<void> {
    const milestone = await this.getMilestone(milestoneId);
    if (milestone === null || milestone.repoId !== repoId) {
      throw new MilestoneNotExistError({ id: milestoneId, repoId });
    }
  }

  private async validateLabels(labelIds: number[], repoId: string, ownerOrgId: number | null): Promise<void> {
    const found = await this.db.select().from(labels).where(inArray(labels.id, labelIds)).all();
    const byId = new Map(found.map((label) => [label.id, label]));
    for (const labelId of labelIds) {
      const label = byId.get(labelId);
      if (label === undefined || !labelAppliesToRepo(label, repoId, ownerOrgId)) {
        throw new NoSuchLabelError(labelId, repoId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Close / reopen (§4.2 CAS)
  // ---------------------------------------------------------------------------

  /**
   * Close an issue (CAS `WHERE is_closed = 0`), write the close system
   * comment and move repo/milestone/label counters — all in one batch. The
   * CAS loser gets `IssueAlreadyChangedError` (§4.2 → 409) and its batch has
   * fully no-opped (no stray comment, no counter drift).
   */
  async closeIssue(issueId: number, options: TransitionOptions = {}): Promise<IssueRow> {
    return this.transitionClosed(issueId, true, { commentType: CommentType.Close, ...options });
  }

  /** Reopen (CAS `WHERE is_closed = 1`), writing the reopen comment (type 1). */
  async reopenIssue(issueId: number, options: TransitionOptions = {}): Promise<IssueRow> {
    return this.transitionClosed(issueId, false, { commentType: CommentType.Reopen, ...options });
  }

  private async transitionClosed(issueId: number, close: boolean, options: TransitionOptions): Promise<IssueRow> {
    const issue = await this.getIssueById(issueId);
    if (issue === null) throw new IssueNotExistError({ id: issueId });
    const now = options.now ?? new Date();
    const commentType = options.commentType ?? (close ? CommentType.Close : CommentType.Reopen);
    const labelIds = (
      await this.db.select({ labelId: issueLabels.labelId }).from(issueLabels).where(eq(issueLabels.issueId, issueId)).all()
    ).map((row) => row.labelId);

    const gate = sql`(SELECT changes()) > 0`;
    // Upstream completeness formula (models/issues/milestone.go:73–81) with
    // the delta of this close/reopen applied inside the division.
    const milestoneSet = close
      ? {
          numClosedIssues: sql`num_closed_issues + 1`,
          completeness: sql`CASE WHEN num_issues > 0 THEN (num_closed_issues + 1) * 100 / num_issues WHEN is_closed = 1 THEN 100 ELSE 0 END`,
        }
      : {
          numClosedIssues: sql`MAX(num_closed_issues - 1, 0)`,
          completeness: sql`CASE WHEN num_issues > 0 THEN MAX(num_closed_issues - 1, 0) * 100 / num_issues WHEN is_closed = 1 THEN 100 ELSE 0 END`,
        };

    const statements: BatchStatements = [
      // 0: CAS — the only statement that decides win/lose (§4.2).
      this.db
        .update(issues)
        .set({
          isClosed: close,
          closedAt: close ? now : null,
          updatedAt: now,
          numComments: sql`num_comments + 1`, // the system comment, folded in
        })
        .where(and(eq(issues.id, issueId), eq(issues.isClosed, !close)))
        .returning(),
      // 1: gated system comment (row appears only for the winner).
      this.db.insert(comments).select(this.systemCommentSelect(commentType, options.actorId ?? null, issueId, now, gate)),
      // 2: repo counter — pulls split from issues (§3.2).
      this.db
        .update(repositories)
        .set(
          issue.isPull
            ? close
              ? { numClosedPulls: sql`num_closed_pulls + 1` }
              : { numClosedPulls: sql`MAX(num_closed_pulls - 1, 0)` }
            : close
              ? { numClosedIssues: sql`num_closed_issues + 1` }
              : { numClosedIssues: sql`MAX(num_closed_issues - 1, 0)` },
        )
        .where(and(eq(repositories.id, issue.repoId), gate)),
    ];
    if (issue.milestoneId != null) {
      statements.push(
        this.db.update(milestones).set(milestoneSet).where(and(eq(milestones.id, issue.milestoneId), gate)),
      );
    }
    for (const labelId of labelIds) {
      statements.push(
        this.db
          .update(labels)
          .set({ numClosedIssues: milestoneSet.numClosedIssues })
          .where(and(eq(labels.id, labelId), gate)),
      );
    }

    const results = await this.db.batch(statements);
    const updated = batchRows<IssueRow>(results[0], "issue CAS update");
    if (updated.length === 0) {
      // CAS loser: every gated statement above has modified zero rows.
      throw new IssueAlreadyChangedError();
    }
    await this.notifyMailIssueStatus(updated[0]!, close, options.actorId ?? null, now);
    return updated[0]!;
  }

  /**
   * `issue_service.ChangeTitle` (services/issue/issue.go:86-128) — the title
   * write through the shared changeIssueTitle plus the IssueChangeTitle
   * receiver arm: upstream notifies AFTER the update with the UPDATED issue
   * and oldTitle (issue.go:127), so the mail sees the new title and the
   * receiver's WIP-transition gate keys on the pair (notifyIssueTitleChanged).
   * Best-effort — the write above stays committed.
   */
  async changeTitle(issue: IssueRow, title: string, actorId: number | null, now: Date): Promise<IssueRow | null> {
    const oldTitle = issue.title;
    const updated = await changeIssueTitle(this.d1, issue, title, actorId, now);
    if (updated !== null) await this.notifyMailTitleChanged(updated, oldTitle, actorId, now);
    return updated;
  }

  /** The IssueChangeTitle receiver arm's caller — best-effort, never throws
   *  (the errors log; the write above stays committed). */
  private async notifyMailTitleChanged(issue: IssueRow, oldTitle: string, actorId: number | null, now: Date): Promise<void> {
    if (this.mailEnv === undefined) return;
    if (actorId === null) return;
    try {
      const doer = (await this.db.select().from(users).where(eq(users.id, actorId)).get()) ?? null;
      if (doer === null) {
        console.error(`[issues] title notify skipped: actor row missing [id: ${actorId}]`);
        return;
      }
      const outcome = await notifyIssueTitleChanged(this.mailEnv, { issue, doer, oldTitle }, { now });
      if (outcome.outcome === "enqueued" && outcome.enqueue.some((e) => e.outcome === "pending-unqueued")) {
        console.warn(`[issues] title notify: some rows stayed pending-unqueued (issue ${issue.id})`);
      }
    } catch (error) {
      console.error(`[issues] title notify failed (issue ${issue.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * UpdateAssignees' notify position (services/issue/assignee.go:94-166) —
   * the shared replaceIssueAssignees write core with this service's
   * IssueChangeAssignee receivers fanned in: upstream's notify dispatch
   * hands each actually-changed assignee to BOTH the webhook and the mail
   * notifier (notifier.go:161-202 / mailer/notify.go:119-127), so the
   * caller's webhook emitter runs first and the mail arm rides after, per
   * assignee, removals before adds (the core's post-tx order). Best-effort —
   * the writes stay committed.
   */
  async changeAssignees(
    found: RepositoryWithOwner,
    issue: IssueRow,
    names: string[],
    doer: { id: number; isAdmin: boolean },
    onAssignee: (user: UserRow, removed: boolean) => Promise<void> | void,
  ): Promise<void> {
    await replaceIssueAssignees(this.d1, found, issue, names, doer, async (user, removed, comment) => {
      await onAssignee(user, removed);
      await this.notifyMailAssigneeChanged(issue, comment, user, removed, doer.id);
    });
  }

  /** The IssueChangeAssignee receiver arm's caller — best-effort, never
   *  throws (the receiver gates removed/self/preference itself). */
  private async notifyMailAssigneeChanged(issue: IssueRow, comment: CommentRow, assignee: UserRow, removed: boolean, doerId: number): Promise<void> {
    if (this.mailEnv === undefined) return;
    try {
      const doer = (await this.db.select().from(users).where(eq(users.id, doerId)).get()) ?? null;
      if (doer === null) {
        console.error(`[issues] assignee notify skipped: doer row missing [id: ${doerId}]`);
        return;
      }
      const outcome = await notifyIssueAssigneeChanged(this.mailEnv, { issue, comment, doer, assignee, removed });
      if (outcome.outcome === "enqueued" && outcome.enqueue.some((e) => e.outcome === "pending-unqueued")) {
        console.warn(`[issues] assignee notify: some rows stayed pending-unqueued (comment ${comment.id})`);
      }
    } catch (error) {
      console.error(`[issues] assignee notify failed (comment ${comment.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * The expression list for a FROM-less gated `INSERT ... SELECT`, matching
   * drizzle's `comments` column order (buildInsertQuery lists every column
   * for select-based inserts). Unlisted columns fall back to their declared
   * default (NOT NULL) or NULL; `id` stays NULL for autoincrement.
   */
  private systemCommentSelect(
    type: CommentTypeValue,
    posterId: number | null,
    issueId: number,
    now: Date,
    gate: SQL,
  ): SQL {
    const values: Record<string, unknown> = {
      type,
      posterId,
      issueId,
      content: "",
      createdAt: now,
    };
    const exprs: SQL[] = Object.entries(getTableColumns(comments)).map(([key, column]) => {
      if (key in values) return sql`${bindValue(values[key])}`;
      if (column.primary) return sql`null`;
      if (column.notNull) return sql`${bindValue(column.default)}`;
      return sql`null`;
    });
    return sql`SELECT ${sql.join(exprs, sql`, `)} WHERE ${gate}`;
  }

  // ---------------------------------------------------------------------------
  // Comments (§2.2)
  // ---------------------------------------------------------------------------

  /**
   * Add a comment: the comment row and the `num_comments` increment (plus
   * `updated_unix`) land in one batch. Lock gating is a route-level
   * permission check (§2.2); the service stays permission-free.
   *
   * The mail-notify arm (specs/email-outbound.md §8): a plain type-0 comment
   * fanned to the notify hub when the constructor carries a mail env —
   * upstream fires `notify.CreateIssueComment` inside the comment-create
   * service too (services/issues/comments.go → services/notify), never from
   * the router. Awaited inline (the register-notify posture: the outbox
   * INSERT is the durable record), failures caught and logged — a mailer
   * outage must never fail the write (upstream logs at the receiver,
   * notify.go:48-50). The system-comment types (close/reopen/labels/…) ride
   * their own notify arms, not this one (SPEC §1.3 follow-ups).
   */
  async addComment(input: AddCommentInput): Promise<CommentRow> {
    const issue = await this.getIssueById(input.issueId);
    if (issue === null) throw new IssueNotExistError({ id: input.issueId });
    const now = input.now ?? new Date();
    const results = await this.db.batch([
      this.db
        .insert(comments)
        .values({
          type: input.type ?? CommentType.Comment,
          posterId: input.posterId ?? null,
          issueId: input.issueId,
          content: input.content,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
      this.db
        .update(issues)
        .set({ numComments: sql`num_comments + 1`, updatedAt: now })
        .where(eq(issues.id, input.issueId)),
    ] as const);
    const rows = batchRows<CommentRow>(results[0], "comment insert");
    if (rows[0] === undefined) throw new Error("comment batch committed without returning rows");
    await this.notifyCommentCreated(issue, rows[0], input, now);
    return rows[0];
  }

  /** The FULL FindAndUpdateIssueMentions (upstream runs the whole function
   *  in the issue service BEFORE the notify fires — services/issue/
   *  comments.go:81, issue.go:68, pull.go:184 — and hands the resolved
   *  users to the receiver): parse + visibility resolution
   *  (services/mentions) then the issue_user carrier upsert
   *  (updateIssueMentions — upstream's persistence arm, issue_update.go:567
   *  → issue_user.go:64-86). Best-effort: a resolution or carrier failure
   *  degrades the notify fan-out, never the write. */
  private async resolveMailMentions(issue: IssueRow, doer: UserRow, content: string): Promise<UserRow[]> {
    const pair = await findRepositoryById(this.d1, issue.repoId);
    if (pair === null) return [];
    const mentions = await findIssueMentions(this.d1, { repo: pair.repo, issue, doer, content });
    if (mentions.length > 0) {
      await updateIssueMentions(this.d1, issue.id, mentions);
    }
    return mentions;
  }

  /** The CreateIssueComment receiver arm — best-effort, never throws (the
   *  errors log; the write above stays committed). The mentions arm runs
   *  UNCONDITIONALLY (upstream's CreateIssueComment runs
   *  FindAndUpdateIssueMentions with no mail-env notion, services/issue/
   *  comments.go:81): the carrier rows feed the notifications mailbox's
   *  mention arm and the mentioned filters with no mailer configured.
   *  Only the notify half stays mail-gated. */
  private async notifyCommentCreated(
    issue: IssueRow,
    comment: CommentRow,
    input: AddCommentInput,
    now: Date,
  ): Promise<void> {
    if ((input.type ?? CommentType.Comment) !== CommentType.Comment) return;
    if (input.posterId === null || input.posterId === undefined) return;
    try {
      const doer = (await this.db.select().from(users).where(eq(users.id, input.posterId)).get()) ?? null;
      if (doer === null) {
        console.error(`[issues] comment notify skipped: doer row missing [id: ${input.posterId}]`);
        return;
      }
      const mentions = await this.resolveMailMentions(issue, doer, comment.content ?? "");
      if (this.mailEnv === undefined) return;
      const outcome = await notifyIssueComment(this.mailEnv, { issue, comment, doer, mentions }, { now });
      if (outcome.outcome === "enqueued" && outcome.enqueue.some((e) => e.outcome === "pending-unqueued")) {
        console.warn(
          `[issues] comment notify: some rows stayed pending-unqueued (comment ${comment.id})`,
        );
      }
    } catch (error) {
      console.error(
        `[issues] comment notify failed (comment ${comment.id}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The NewIssue receiver arm (specs/email-outbound.md §8; upstream
   * services/mailer/notify.go:53-58, fired from the issue-create service
   * with doer = issue.Poster). Only issues ride it — pull creation is the
   * separate NewPullRequest receiver (notify.go:88-93,
   * `notifyMailNewPullRequest` below), and upstream's NewIssue arm is the
   * issue arm. The mentions arm runs UNCONDITIONALLY (upstream's CreateIssue
   * runs FindAndUpdateIssueMentions with no mail-env notion,
   * services/issue/issue.go:68 — see notifyCommentCreated); only the notify
   * half stays mail-gated. Best-effort, never throws (the write above stays
   * committed).
   */
  private async notifyMailNewIssue(issue: IssueRow, now: Date): Promise<void> {
    if (issue.isPull) return;
    if (issue.posterId === null) return;
    try {
      const doer = (await this.db.select().from(users).where(eq(users.id, issue.posterId)).get()) ?? null;
      if (doer === null) {
        console.error(`[issues] new-issue notify skipped: poster row missing [id: ${issue.posterId}]`);
        return;
      }
      // Upstream services/issue/issue.go:68 — the issue body's mentions.
      const mentions = await this.resolveMailMentions(issue, doer, issue.content ?? "");
      if (this.mailEnv === undefined) return;
      const outcome = await notifyIssueCreated(this.mailEnv, { issue, doer, mentions }, { now });
      if (outcome.outcome === "enqueued" && outcome.enqueue.some((e) => e.outcome === "pending-unqueued")) {
        console.warn(`[issues] new-issue notify: some rows stayed pending-unqueued (issue ${issue.id})`);
      }
    } catch (error) {
      console.error(
        `[issues] new-issue notify failed (issue ${issue.id}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The NewPullRequest receiver arm (specs/email-outbound.md §10; upstream
   * services/mailer/notify.go:88-93 — MailParticipants over the PR's issue
   * row with ActionCreatePullRequest, doer = pr.Issue.Poster). Fires from
   * the PR-create service exactly like upstream's model-layer notify; the
   * compose is the thread-root "new" arm with IsPull = true and the
   * repo-watcher WIP gate lifted (mail_issue.go:67-76's create-arm
   * exception). The mentions arm runs UNCONDITIONALLY (upstream's
   * CreatePullRequest runs FindAndUpdateIssueMentions with no mail-env
   * notion, services/pull/pull.go:184 — see notifyCommentCreated); only
   * the notify half stays mail-gated. Best-effort, never throws (the
   * write above stays committed).
   */
  private async notifyMailNewPullRequest(issue: IssueRow, now: Date): Promise<void> {
    if (issue.posterId === null) return;
    try {
      const doer = (await this.db.select().from(users).where(eq(users.id, issue.posterId)).get()) ?? null;
      if (doer === null) {
        console.error(`[issues] new-pull notify skipped: poster row missing [id: ${issue.posterId}]`);
        return;
      }
      // Upstream services/pull/pull.go:184 — the PR body's mentions.
      const mentions = await this.resolveMailMentions(issue, doer, issue.content ?? "");
      if (this.mailEnv === undefined) return;
      const outcome = await notifyPullRequestCreated(this.mailEnv, { issue, doer, mentions }, { now });
      if (outcome.outcome === "enqueued" && outcome.enqueue.some((e) => e.outcome === "pending-unqueued")) {
        console.warn(`[issues] new-pull notify: some rows stayed pending-unqueued (issue ${issue.id})`);
      }
    } catch (error) {
      console.error(
        `[issues] new-pull notify failed (issue ${issue.id}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * The IssueChangeStatus receiver arm (upstream services/mailer/notify.go:
   * 59-76 — the closed/reopened family via MailParticipants, doer = the
   * actor; the IsPull branch picks the PullRequest activities constants).
   * CAS winners only — the loser's batch no-opped and upstream never
   * notifies a lost transition either. Best-effort, never throws.
   */
  private async notifyMailIssueStatus(issue: IssueRow, isClosed: boolean, actorId: number | null, now: Date): Promise<void> {
    if (this.mailEnv === undefined) return;
    if (actorId === null) return;
    try {
      const doer = (await this.db.select().from(users).where(eq(users.id, actorId)).get()) ?? null;
      if (doer === null) {
        console.error(`[issues] status notify skipped: actor row missing [id: ${actorId}]`);
        return;
      }
      const outcome = await notifyIssueStatusChanged(this.mailEnv, { issue, doer, isClosed }, { now });
      if (outcome.outcome === "enqueued" && outcome.enqueue.some((e) => e.outcome === "pending-unqueued")) {
        console.warn(`[issues] status notify: some rows stayed pending-unqueued (issue ${issue.id})`);
      }
    } catch (error) {
      console.error(
        `[issues] status notify failed (issue ${issue.id}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Labels (§3.2 counters)
  // ---------------------------------------------------------------------------

  /** Attach one label; true when newly attached (idempotent re-add = false). */
  async setLabel(issueId: number, labelId: number, options: LabelOperationOptions = {}): Promise<boolean> {
    const issue = await this.getIssueById(issueId);
    if (issue === null) throw new IssueNotExistError({ id: issueId });
    const label = await this.db.select().from(labels).where(eq(labels.id, labelId)).get();
    if (label === undefined || !labelAppliesToRepo(label, issue.repoId, options.ownerOrgId ?? null)) {
      throw new NoSuchLabelError(labelId, issue.repoId);
    }
    const now = options.now ?? new Date();
    const closedBump = issue.isClosed
      ? { numClosedIssues: sql`num_closed_issues + 1` }
      : {};
    const results = await this.db.batch([
      this.db.insert(issueLabels).values({ issueId, labelId }).onConflictDoNothing().returning({ labelId: issueLabels.labelId }),
      this.db
        .update(labels)
        .set({ numIssues: sql`num_issues + 1`, ...closedBump })
        .where(and(eq(labels.id, labelId), sql`(SELECT changes()) > 0`)),
      this.db.update(issues).set({ updatedAt: now }).where(eq(issues.id, issueId)),
    ] as const);
    return batchRows<{ labelId: number }>(results[0], "issue_labels insert").length > 0;
  }

  /**
   * Replace the full label set (upstream `ReplaceIssueLabels`): diff-based —
   * detached labels leave, new labels join — with closed-state-aware counter
   * maintenance, all in one batch.
   */
  async replaceLabels(issueId: number, labelIds: number[], options: LabelOperationOptions = {}): Promise<ReplaceLabelsResult> {
    const issue = await this.getIssueById(issueId);
    if (issue === null) throw new IssueNotExistError({ id: issueId });
    const requested = [...new Set(labelIds)];
    if (requested.length > 0) {
      await this.validateLabels(requested, issue.repoId, options.ownerOrgId ?? null);
    }
    const current = (
      await this.db.select({ labelId: issueLabels.labelId }).from(issueLabels).where(eq(issueLabels.issueId, issueId)).all()
    ).map((row) => row.labelId);
    const toAdd = requested.filter((id) => !current.includes(id));
    const toRemove = current.filter((id) => !requested.includes(id));
    const now = options.now ?? new Date();

    const counterDecrement = issue.isClosed
      ? { numIssues: sql`num_issues - 1`, numClosedIssues: sql`num_closed_issues - 1` }
      : { numIssues: sql`num_issues - 1` };
    const counterIncrement = issue.isClosed
      ? { numIssues: sql`num_issues + 1`, numClosedIssues: sql`num_closed_issues + 1` }
      : { numIssues: sql`num_issues + 1` };

    // The issues touch is unconditional and must not sit between gated
    // statements — keep it first; the label pairs below are self-gating.
    const statements: BatchStatements = [
      this.db.update(issues).set({ updatedAt: now }).where(eq(issues.id, issueId)),
    ];
    for (const labelId of toRemove) {
      statements.push(
        this.db
          .delete(issueLabels)
          .where(and(eq(issueLabels.issueId, issueId), eq(issueLabels.labelId, labelId))),
      );
      statements.push(
        this.db
          .update(labels)
          .set(counterDecrement)
          .where(and(eq(labels.id, labelId), sql`(SELECT changes()) > 0`)),
      );
    }
    for (const labelId of toAdd) {
      statements.push(
        this.db.insert(issueLabels).values({ issueId, labelId }).onConflictDoNothing(),
      );
      statements.push(
        this.db
          .update(labels)
          .set(counterIncrement)
          .where(and(eq(labels.id, labelId), sql`(SELECT changes()) > 0`)),
      );
    }
    statements.push(this.db.update(issues).set({ updatedAt: now }).where(eq(issues.id, issueId)));
    await this.db.batch(statements);
    return { added: toAdd, removed: toRemove };
  }

  // ---------------------------------------------------------------------------
  // Milestones (§3.2 basics)
  // ---------------------------------------------------------------------------

  async createMilestone(input: CreateMilestoneInput): Promise<MilestoneRow> {
    const now = input.now ?? new Date();
    const results = await this.db.batch([
      this.db
        .insert(milestones)
        .values({
          repoId: input.repoId,
          name: input.name,
          content: input.content ?? "",
          deadlineAt: input.deadlineAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
      this.db
        .update(repositories)
        .set({ numMilestones: sql`num_milestones + 1` })
        .where(eq(repositories.id, input.repoId)),
    ] as const);
    const rows = batchRows<MilestoneRow>(results[0], "milestone insert");
    if (rows[0] === undefined) throw new Error("milestone batch committed without returning rows");
    return rows[0];
  }

  /** Patch name/content/deadline and/or the lifecycle state; recomputes
   *  completeness (upstream `BeforeUpdate` formula). */
  async updateMilestone(id: number, patch: UpdateMilestonePatch): Promise<MilestoneRow> {
    const existing = await this.getMilestone(id);
    if (existing === null) throw new MilestoneNotExistError({ id });
    const now = patch.now ?? new Date();
    const set: Partial<typeof milestones.$inferInsert> = {
      name: patch.name ?? existing.name,
      content: patch.content !== undefined ? patch.content : existing.content,
      deadlineAt: patch.deadlineAt !== undefined ? patch.deadlineAt : existing.deadlineAt,
      updatedAt: now,
    };
    if (patch.state !== undefined && (patch.state === "closed") !== existing.isClosed) {
      const closing = patch.state === "closed";
      set.isClosed = closing;
      set.closedDateAt = closing ? now : null;
    }
    // Completeness recomputes on every patch (upstream `BeforeUpdate` formula).
    const rows = await this.db
      .update(milestones)
      .set({
        ...set,
        completeness: sql`CASE WHEN num_issues > 0 THEN num_closed_issues * 100 / num_issues WHEN is_closed = 1 THEN 100 ELSE 0 END`,
      })
      .where(eq(milestones.id, id))
      .returning()
      .all();
    const row = rows[0];
    if (row === undefined) throw new MilestoneNotExistError({ id });
    return row;
  }

  /**
   * Delete a milestone: its issues are unlinked (upstream behavior), the row
   * is removed and the repo's `num_milestones` drops, in one batch. False
   * when the milestone does not exist.
   */
  async deleteMilestone(id: number): Promise<boolean> {
    const existing = await this.getMilestone(id);
    if (existing === null) return false;
    await this.db.batch([
      this.db
        .update(issues)
        .set({ milestoneId: null, updatedAt: new Date() })
        .where(eq(issues.milestoneId, id)),
      this.db.delete(milestones).where(eq(milestones.id, id)),
      this.db
        .update(repositories)
        .set({ numMilestones: sql`MAX(num_milestones - 1, 0)` })
        .where(eq(repositories.id, existing.repoId)),
    ] as const);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Releases (§2.3, §4.11)
  // ---------------------------------------------------------------------------

  /**
   * Create a release. Duplicate `(repo_id, tag_name)` →
   * `ReleaseAlreadyExistError` (409, §4.11); a pre-existing tag-only record
   * (`is_tag`) is converted into a release instead (§2.3). Drafts get
   * `published_unix = 0` — the `release` webhook fires only at publish time
   * (§2.3; the emit call itself is the route's job).
   */
  async createRelease(input: CreateReleaseInput): Promise<ReleaseRow> {
    const now = input.now ?? new Date();
    const tagName = input.tagName;
    const lowerTagName = tagName.toLowerCase();
    const isDraft = input.isDraft ?? false;

    const existing = await this.db
      .select()
      .from(releases)
      .where(and(eq(releases.repoId, input.repoId), eq(releases.tagName, tagName)))
      .get();
    if (existing !== undefined) {
      if (!existing.isTag) throw new ReleaseAlreadyExistError(tagName);
      // §2.3: first release edit converts the pure tag record.
      const converted = await this.db
        .update(releases)
        .set({
          publisherId: input.publisherId,
          target: input.target ?? existing.target,
          title: input.title ?? "",
          note: input.note ?? "",
          isDraft,
          isPrerelease: input.isPrerelease ?? false,
          isTag: false,
          publishedUnix: isDraft ? 0 : toUnix(now),
        })
        .where(eq(releases.id, existing.id))
        .returning()
        .all();
      const row = converted[0];
      if (row === undefined) throw new ReleaseAlreadyExistError(tagName);
      return row;
    }

    try {
      const rows = await this.db
        .insert(releases)
        .values({
          repoId: input.repoId,
          publisherId: input.publisherId,
          tagName,
          lowerTagName,
          target: input.target ?? "",
          title: input.title ?? "",
          note: input.note ?? "",
          isDraft,
          isPrerelease: input.isPrerelease ?? false,
          isTag: input.isTag ?? false,
          createdAt: now,
          publishedUnix: isDraft ? 0 : toUnix(now),
        })
        .returning()
        .all();
      const row = rows[0];
      if (row === undefined) throw new Error("release insert committed without returning rows");
      return row;
    } catch (error) {
      // Race-safe: a concurrent create hit the (repo_id, tag_name) unique
      // index between our pre-check and the insert.
      if (isUniqueViolation(error, "releases.repo_id", "releases.tag_name")) {
        throw new ReleaseAlreadyExistError(tagName);
      }
      throw error;
    }
  }
}
