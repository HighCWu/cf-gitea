/**
 * The push-integrated issue walk — census B-47 / §7.4 row I21.
 * Upstream at pin: `UpdateIssuesCommit` (services/issue/commit.go:126-238),
 * reached from the push-update QUEUE (`pushQueueHandleUpdates`,
 * services/repository/push.go:62-225 → :184) after a branch push lands:
 * every pushed commit's MESSAGE scans (`references.FindAllIssueReferences` —
 * the NON-markdown entry, references.go:330-339), each reference writes a
 * type-4 `commit_ref` comment (`CreateRefComment`, services/issue/comments.go:
 * 27-59) and actionable references close/reopen the target through
 * `CloseIssue`/`ReopenIssue` (services/issue/status.go), gated by the
 * `canclose`/`cancomment` ladder (commit.go:171-172), the self-reference
 * guard (:97-110), and the pushed repo's `CloseIssuesViaCommitInAnyBranch`
 * branch scope (:207-218).
 *
 * The upstream ordering, kept arm for arm:
 *   commits process OLDEST-first (the queue hands a newest-first list and
 *   the walk iterates `slices.Backward`, commit.go:127-128); within one
 *   commit the scan order is the reference order; per reference —
 *     1. repo resolution: a full `owner/name` reference resolves by path
 *        (missing → log WARN + continue, commit.go:140-149), anything else
 *        targets the PUSHED repo (:150-152);
 *     2. the target issue loads by (repo, index) — missing → silent
 *        continue (:153-158);
 *     3. the doer permission (`GetDoerRepoPermission(refRepo, doer)`, :160)
 *        and the per-commit dedupe `{issue.ID, action}` (:165-168);
 *     4. `canclose = IsAdmin || IsOwner || CanWriteIssuesOrPulls ||
 *        PosterID == doer` and `cancomment = canclose ||
 *        CanReadIssuesOrPulls` (:171-172); !cancomment → continue;
 *     5. the self-reference skip: a PR whose merged commit IS this commit
 *        never references itself (:180, isSelfReference :97-110);
 *     6. the type-4 ref comment: content
 *        `<a href="{repo.Link()}/commit/{sha}">{first line}</a>` with Go's
 *        html escaping (repo.Link() is AppSubURL-qualified — root-relative
 *        `/owner/repo` here, repo.go:559-561; the sha rides
 *        url.PathEscape, a no-op on hex), written through CreateRefComment:
 *        a doer blocked by the target's poster/owner continues unless they
 *        are a repo/site admin (`ErrBlockedUser`, comments.go:32-36 +
 *        commit.go:186-189), and a same-commit duplicate row silently
 *        skips (the (type=4, issue_id, commit_sha) existence check,
 *        comments.go:38-48 — THE re-push idempotency);
 *     7. the close ladder: `!canclose || (isPull && reopens)` → continue
 *        (PRs are never REOPENED by pushes, commit.go:193); non-actionable
 *        → continue (:198); the external-tracker arm (:203) is dead here —
 *        our schema carries no external-tracker unit (the xref.ts header's
 *        recorded convention); `!CloseIssuesViaCommitInAnyBranch` narrows
 *        the scope (:207-218): an issue pinned by `ref` closes only from
 *        that branch, an unpinned issue only from the DEFAULT branch; then
 *        a `closes` on an open issue logs its time-log first
 *        (`issueAddTime` → AddTime → a tracked_time row + the type-14
 *        `|<seconds>` comment, tracked_time.go:164-193) and closes;
 *        a `reopens` on a closed issue reopens.
 *
 * The notify arms: close/reopen fire `notify.IssueChangeStatus(doer,
 * commitID=sha, …)` (status.go:43/:56) — the `issues`/`pull_request`
 * closed/reopened webhook with `commit_id` (services/webhook/notifier.go:
 * 249-289) plus the feed action row (services/feed/notifier.go:66-97).
 * The type-4 ref comment itself fires NO webhook upstream (the plain-comment
 * notify lives in `CreateIssueComment`, comments.go:62-92, which this path
 * does not reach), and the model `CreateComment`'s `AddCrossReferences` arm
 * (models/issues/comment.go:920) stays B-46's recorded remainder — the
 * ref-comment content is not re-scanned here.
 *
 * Adaptation, recorded:
 * - This runs in the receive tail after the engine's response (the gate's
 *   `ctx.waitUntil` posture) — upstream's queue is the same post-response
 *   async position; the walk can never fail the push.
 * - The commit ranges come from the ENGINE'S EXISTING read RPCs (no new
 *   seam): a branch update walks `listCommitsRange(old, new, …)` — the
 *   `base..head` walk, already oldest-first (SPEC-0001b §4.1); a NEW branch
 *   (a zero old tip) walks `listLog(new, {ofs: 0, n: 10})` reversed —
 *   upstream `CommitsBeforeLimit(10)` (push.go:270). Upstream's new-branch
 *   walk also breaks at the first commit contained in >1 branch
 *   (commitsBefore, repo_commit.go:359-366); that contains-check is not
 *   reproducible over the read RPCs and is dropped — recorded, with the
 *   re-walk staying idempotent through the ref-comment dedupe and the
 *   close/reopen CAS. The update-range walk is PAGED with a total budget
 *   (upstream rev-lists unlimited; the budget is the Workers-CPU posture,
 *   the engine's own walk budgets' shape).
 * - The permission ladder folds through xref.ts's landed predicates:
 *   upstream's IsAdmin/IsOwner/CanWriteIssuesOrPulls all reduce to "repo
 *   access ≥ write" (GetIndividualUserRepoPermission collapses site admin
 *   and the owner onto AccessModeOwner, repo_permission.go:475); the
 *   poster disjunct rides the ids in hand. `IsUserRepoAdmin` for the
 *   block-arm bypass = site admin or access mode ≥ admin
 *   (repo_permission.go:532-552).
 * - Close/reopen run through IssuesService.closeIssue/reopenIssue — the
 *   landed CAS seam every other arm (API/UI/merge/branch-delete) uses, so
 *   the dependency gate and the counter moves are the shared behavior; a
 *   deps-blocked close PROPAGATES (upstream's CloseIssue errors also abort
 *   the walk, commit.go:227-229 — the tail logs, the applied push stands).
 *   The stopwatch-finish inside upstream's service CloseIssue
 *   (status.go:32-41) is not part of the landed seam on ANY arm — the
 *   shared recorded gap, not a divergence introduced here.
 * - The notify emissions use the push-family's env-parameterized posture
 *   (webhooks-push.ts:1389-1429): `emitWebhookDeliveries` + `recordAction`
 *   inline (already inside waitUntil), payloads rendered with the
 *   anonymous-viewer convention (`{origin, requester: null}` — the
 *   push-family precedent) and the pusher as the sender
 *   (`apiUserFromRow(pusherRow, viewer)` — upstream ToUser(doer, nil)).
 *   An identity-less push (pusherId null — the tail's defense posture)
 *   walks as anonymous and skips the notify arms (upstream cannot reach
 *   this: its pusher is always resolved).
 */

import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { CommitJson } from "@cf-gitea/git-engine";

import { comments, issues, pullRequests, trackedTimes, users } from "../../db/schema";
import { CommentType, RefAction } from "../../issues/comment-types";
import { IssuesService, type IssueRow } from "../../issues/service";
import { emitWebhookDeliveries } from "../../issues/webhooks";
import { appOrigin } from "../../services/webhooks-push";
import { issueActionDraft, type IssueEventEmission } from "../../services/issue-events";
import { ActionType, recordAction, type ActionDraft } from "./activity-feeds";
import { isUserBlockedBy } from "./blocks";
import { toApiIssue } from "./issues";
import { pullRequestDiffShortStatForEnv } from "./pull-engine";
import { toApiPullRequest } from "./pulls";
import {
  apiUserFromRow,
  doerRepoAccessMode,
  findRepositoryById,
  findRepositoryByPath,
  toApiRepository,
  type RepositoryRow,
  type RepositoryWithOwner,
  type Viewer,
} from "./repository";
import { canReadIssuesOrPulls, canWriteIssuesOrPulls, findAllIssueReferences, type XrefDoer } from "./xref";

/** The walk's env view — SettleEnv's exact shape (`Pick<Env, …>` + the
 *  optional AppURL var), so `appOrigin`'s chain and the diff-stat reads
 *  accept it and varless test views can still satisfy it structurally. */
export interface XrefPushEnv extends Pick<Env, "DB" | "REPO" | "REPO_PACKS" | "REPO_TASKS"> {
  /** Upstream `setting.AppURL` — optional (the APP_URL unit's precedence). */
  APP_URL?: string;
}

/** One pushed branch command (the walk's scope — upstream opts per update). */
export interface XrefPushUpdate {
  /** The pushed branch's full ref (`refs/heads/<branch>`). */
  ref: string;
  /** The command's old tip; all-zero = a NEW branch (upstream IsNewRef). */
  old: string;
  /** The command's new tip. */
  next: string;
}

export interface UpdateIssuesForPushInput {
  env: XrefPushEnv;
  /** The PUSHED repository's D1 row (the walk's `repo` argument). */
  repo: RepositoryRow;
  /** The engine cell name the REPO binding addresses (request casing). */
  engineRepo: string;
  /** The authenticated pusher's user id (upstream opts.PusherID). Null = an
   *  identity-less receive — the walk runs anonymous and skips the notify. */
  pusherId: number | null;
  /** The SHORT branch name (upstream opts.RefName()). */
  branch: string;
  update: XrefPushUpdate;
  /** The serving request's origin (the appOrigin chain's middle leg). */
  requestOrigin?: string;
  /** Test clock (the emission/timestamp seam). */
  now?: Date;
}

/**
 * Upstream `CommitsBeforeLimit(10)` (push.go:270 — pushNewBranch's walk).
 */
export const PUSH_NEW_BRANCH_COMMITS_LIMIT = 10;

/** The paged update-range walk's per-page size and total commit budget
 *  (upstream rev-lists unlimited; the budget is the documented Workers-CPU
 *  adaptation — see the module header). */
const WALK_PAGE_SIZE = 500;
const WALK_MAX_COMMITS = 2000;

// ---------------------------------------------------------------------------
// timeLogToAmount (commit.go:30-82)
// ---------------------------------------------------------------------------

const SECONDS_BY_MINUTE = 60;
const SECONDS_BY_HOUR = 60 * SECONDS_BY_MINUTE;
const SECONDS_BY_DAY = 8 * SECONDS_BY_HOUR;
const SECONDS_BY_WEEK = 5 * SECONDS_BY_DAY;
const SECONDS_BY_MONTH = 4 * SECONDS_BY_WEEK;

/** `reDuration` (:38) — one optional group per unit, `^`-anchored, `(?i)`. */
const DURATION_SOURCE =
  "^(?:(\\d+(?:[.,]\\d+)?)(?:mo))?(?:(\\d+(?:[.,]\\d+)?)(?:w))?(?:(\\d+(?:[.,]\\d+)?)(?:d))?(?:(\\d+(?:[.,]\\d+)?)(?:h))?(?:(\\d+(?:[.,]\\d+)?)(?:m))?$";

/**
 * `timeLogToAmount` (:41-82): the `@1h30m`-family duration parser with
 * upstream's collapsed unit seconds (minute/hour/day=8h/week=5d/month=4w).
 * Go parses the FIRST match of a global FindAllStringSubmatch — with the
 * `^`-anchored pattern that is the whole-string match or nothing; empty
 * groups contribute 0 exactly like upstream's `len(match[i]) > 0` skips,
 * and the float sum truncates into the int64 amount.
 */
export function timeLogToAmount(str: string): number {
  const m = new RegExp(DURATION_SOURCE, "i").exec(str);
  if (m === null) return 0;
  const months = parseDurationNumber(m[1]);
  const weeks = parseDurationNumber(m[2]);
  const days = parseDurationNumber(m[3]);
  const hours = parseDurationNumber(m[4]);
  const minutes = parseDurationNumber(m[5]);
  const a =
    months * SECONDS_BY_MONTH +
    weeks * SECONDS_BY_WEEK +
    days * SECONDS_BY_DAY +
    hours * SECONDS_BY_HOUR +
    minutes * SECONDS_BY_MINUTE;
  return Math.trunc(a);
}

/** Go's ParseFloat with the `,` → `.` swap (commit.go:53/:59/:65/:71/:77). */
function parseDurationNumber(group: string | undefined): number {
  if (group === undefined || group === "") return 0;
  const n = Number.parseFloat(group.replace(",", "."));
  return Number.isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// The comment-content string shapes (commit.go:184)
// ---------------------------------------------------------------------------

/** Go's `strings.SplitN(s, "\n", 2)[0]` — the commit message's first line. */
function firstLine(message: string): string {
  const cut = message.indexOf("\n");
  return cut === -1 ? message : message.slice(0, cut);
}

/** Go's `html.EscapeString`: `& < > " '` → `&amp; &lt; &gt; &#34; &#39;`. */
function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&#34;")
    .replaceAll("'", "&#39;");
}

/**
 * Go's `url.PathEscape` (encodePathSegment): every byte outside the
 * unreserved set percent-encodes. Legal namespaces/slugs pass the landed
 * name alphabet `[a-z0-9_.-]` — all unreserved — so the escape is an
 * identity on every name this walk can address; the helper keeps the
 * upstream call's shape for exactness.
 */
function pathEscape(s: string): string {
  let out = "";
  for (const b of new TextEncoder().encode(s)) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9._~-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * `repo.Link()` (repo.go:559-561) — AppSubURL + PathEscape(owner) + name.
 * AppSubURL is empty on our root-path install: `/owner/repo`.
 */
function repoLink(pair: RepositoryWithOwner): string {
  return `/${pathEscape(pair.repo.ownerNamespace)}/${pathEscape(pair.repo.slug)}`;
}

// ---------------------------------------------------------------------------
// The walk (UpdateIssuesCommit, commit.go:126-238)
// ---------------------------------------------------------------------------

/**
 * `UpdateIssuesCommit` for ONE pushed branch command. Never fails the push
 * by contract — the tail wraps and logs (upstream's queue handler logs,
 * push.go:52-58); a thrown error here is the deps-blocked-close abort
 * posture (the module header).
 */
export async function updateIssuesForPush(input: UpdateIssuesForPushInput): Promise<void> {
  const d1 = input.env.DB;
  const database = drizzle(d1);
  const now = input.now ?? new Date();

  // The doer (upstream's `pusher` user). A vanished user row rides the
  // anonymous posture (evaluateBranchProtection's precedent) — upstream
  // cannot reach this (GetPossibleUserByID errors the queue item).
  const pusherRow =
    input.pusherId === null
      ? null
      : ((await database.select().from(users).where(eq(users.id, input.pusherId)).limit(1).get()) ?? null);
  const doer: XrefDoer | null = pusherRow === null ? null : { id: pusherRow.id, isAdmin: pusherRow.isAdmin };

  const commits = await walkPushedCommits(input);
  if (commits === null) return;

  const appUrl = appOrigin(input.env, input.requestOrigin);

  // The pushed repo's branch-scope knob (`repo.CloseIssuesViaCommitInAnyBranch`
  // — the repositories column, SPEC-0005 §4.6; the D1 default false matches
  // upstream's column default).
  const anyBranch = input.repo.closeIssuesViaCommitInAnyBranch;

  const pushedPair = await findRepositoryById(d1, input.repo.id);
  if (pushedPair === null) {
    console.error(`[xref-push] ${input.repo.ownerNamespace}/${input.repo.slug}: repo row vanished — walk skipped`);
    return;
  }

  const service = new IssuesService(d1);

  // Commits process OLDEST-first (the module header).
  for (const c of commits) {
    // Per-commit dedupe `{issue.ID, action}` (commit.go:129-134/165-168).
    const refMarked = new Set<string>();

    // `FindAllIssueReferences(c.Message)` (commit.go:138) — the non-markdown
    // entry (xref.ts findAllIssueReferences, references.go:330-339).
    const refs = findAllIssueReferences(c.message, { appUrl });

    for (const ref of refs) {
      // 1. Repo resolution (:140-152): a full owner/name reference resolves
      //    by path; a miss warns and continues. The scanner lowercases the
      //    path parts (getCrossReference) — findRepositoryByPath matches the
      //    lowercase columns.
      let refRepo: RepositoryWithOwner;
      if (ref.owner !== "" && ref.name !== "") {
        const found = await findRepositoryByPath(d1, ref.owner, ref.name);
        if (found === null) {
          console.warn(
            `[xref-push] ${input.repo.ownerNamespace}/${input.repo.slug}: repository referenced in commit ${c.oid.slice(0, 7)} but does not exist: ${ref.owner}/${ref.name}`,
          );
          continue;
        }
        refRepo = found;
      } else {
        refRepo = pushedPair;
      }

      // 2. The target issue by (repo, index) (:153-158; getIssueFromRef
      //    :114-123 — a miss continues, a read error aborts).
      const refIssue = await database
        .select()
        .from(issues)
        .where(and(eq(issues.repoId, refRepo.repo.id), eq(issues.index, ref.index)))
        .limit(1)
        .get();
      if (refIssue === undefined) continue;

      // 3. The per-commit dedupe (:165-168) — after the target load, before
      //    the permission work (the upstream order's observable shape; the
      //    perm read is pure so the swap saves reads).
      const markKey = `${refIssue.id}:${ref.action}`;
      if (refMarked.has(markKey)) continue;
      refMarked.add(markKey);

      // 4. The canclose/cancomment ladder (:171-172), folded through the
      //    landed predicates (module header).
      const canclose = (await canWriteIssuesOrPulls(d1, refRepo.repo, doer)) || refIssue.posterId === input.pusherId;
      const cancomment = canclose || (await canReadIssuesOrPulls(d1, refRepo.repo, doer, refIssue.isPull));
      if (!cancomment) continue;

      // 5. The self-reference skip (:180; isSelfReference :97-110): a PR
      //    whose merged commit IS this commit never references itself.
      if (refIssue.isPull) {
        const pr = await database
          .select({ mergedCommitId: pullRequests.mergedCommitId })
          .from(pullRequests)
          .where(eq(pullRequests.issueId, refIssue.id))
          .limit(1)
          .get();
        if (pr !== undefined && pr.mergedCommitId !== null && pr.mergedCommitId === c.oid) continue;
      }

      // 6. The type-4 ref comment (:184-190) through CreateRefComment's
      //    arms (comments.go:27-59).
      const content = `<a href="${escapeHtml(repoLink(pushedPair))}/commit/${escapeHtml(pathEscape(c.oid))}">${escapeHtml(firstLine(c.message))}</a>`;
      const refComment = await createRefComment(d1, doer, pusherRow, refRepo, refIssue, content, c.oid, now);
      if (refComment === "blocked") continue; // ErrBlockedUser (commit.go:186-189)
      // a D1 error from createRefComment propagates (upstream's `return err`)

      // 7. The close ladder (:193-234).
      if (!canclose || (refIssue.isPull && ref.action === RefAction.Reopens)) continue; // PRs never reopen
      if (ref.action !== RefAction.Closes && ref.action !== RefAction.Reopens) continue;
      // The external-tracker arm (:203) is dead — no external-tracker unit
      // (module header).
      if (!anyBranch) {
        if (refIssue.ref !== null && refIssue.ref !== "") {
          const issueBranchName = refIssue.ref.replace(/^refs\/heads\//, "");
          if (input.branch !== issueBranchName) continue;
        } else if (input.branch !== input.repo.defaultBranch) {
          continue;
        }
      }

      if (ref.action === RefAction.Closes && !refIssue.isClosed) {
        if (ref.timeLog !== "") {
          await issueAddTime(d1, refIssue, input.pusherId, c, ref.timeLog);
        }
        const closed = await service.closeIssue(refIssue.id, { actorId: input.pusherId, now });
        await notifyStatusChange(input, pushedPair, pusherRow, closed, c.oid, true, now);
      } else if (ref.action === RefAction.Reopens && refIssue.isClosed) {
        const reopened = await service.reopenIssue(refIssue.id, { actorId: input.pusherId, now });
        await notifyStatusChange(input, pushedPair, pusherRow, reopened, c.oid, false, now);
      }
    }
  }
}

/**
 * The pushed range's commits, OLDEST-first; `null` = the walk cannot run
 * (the caller's log-and-skip arm).
 *
 * - New branch (a zero old tip): upstream CommitsBeforeLimit(10)
 *   (push.go:270) — `git log -10 <tip>`, newest-first; ours listLog(n:10)
 *   reversed. Upstream's multi-branch break (repo_commit.go:359-366) is not
 *   reproducible over the read RPCs — recorded (module header).
 * - Update: upstream CommitsBeforeUntil = `rev-list old..new` unlimited
 *   (push.go:279 → CommitsBetween, modules/git/commit.go:148-151); ours the
 *   engine's paged `base..head` walk (already oldest-first) with the budget.
 */
async function walkPushedCommits(input: UpdateIssuesForPushInput): Promise<CommitJson[] | null> {
  const cell = input.env.REPO.getByName(input.engineRepo);
  if (/^0+$/.test(input.update.old)) {
    let log: Awaited<ReturnType<typeof cell.listLog>>;
    try {
      // skipCacheWrite — the same scan-walk cache discipline as the webhook
      // walk's seam (webhooks-push.ts, the engine's NOTICE.md 2026-11-02
      // row): a log scan reads the FULL ancestry of the pushed branch, and
      // caching scanned ancestors would extend the serve cache's hot set one
      // walk past every pushed tip — the invariants checker's documented
      // detection horizon depends on never-advertised ancestors reading
      // through to R2.
      log = await cell.listLog(input.update.next, { ofs: 0, n: PUSH_NEW_BRANCH_COMMITS_LIMIT, skipCacheWrite: true });
    } catch (error) {
      console.error(
        `[xref-push] ${input.repo.ownerNamespace}/${input.repo.slug}: branch-create walk failed for ${input.update.ref}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    if (log === null) {
      console.error(
        `[xref-push] ${input.repo.ownerNamespace}/${input.repo.slug}: branch-create walk failed for ${input.update.ref} (${input.update.next.slice(0, 7)}) — tip unresolvable`,
      );
      return null;
    }
    return [...log.commits].reverse(); // newest-first → chronological
  }

  const commits: CommitJson[] = [];
  for (let page = 0; page * WALK_PAGE_SIZE < WALK_MAX_COMMITS; page++) {
    let range: Awaited<ReturnType<typeof cell.listCommitsRange>>;
    try {
      // skipCacheWrite — the same scan-walk cache discipline as the
      // branch-create arm above (the engine's NOTICE.md 2026-11-02 row): a
      // range walk reads the FULL old..new ancestry, and caching scanned
      // ancestors would extend the serve cache's hot set one walk past every
      // pushed tip — the invariants checker's documented detection horizon
      // depends on never-advertised ancestors reading through to R2.
      range = await cell.listCommitsRange(input.update.old, input.update.next, WALK_PAGE_SIZE, page, { skipCacheWrite: true });
    } catch (error) {
      console.error(
        `[xref-push] ${input.repo.ownerNamespace}/${input.repo.slug}: range walk failed for ${input.update.ref}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    if (range === null) {
      console.error(
        `[xref-push] ${input.repo.ownerNamespace}/${input.repo.slug}: range walk failed for ${input.update.ref} (${input.update.old.slice(0, 7)}..${input.update.next.slice(0, 7)}) — a side unresolvable`,
      );
      return null;
    }
    commits.push(...range.commits);
    if (!range.more) return commits;
  }
  console.warn(
    `[xref-push] ${input.repo.ownerNamespace}/${input.repo.slug}: range walk for ${input.update.ref} clipped at the ${WALK_MAX_COMMITS}-commit budget (the Workers-CPU adaptation)`,
  );
  return commits;
}

/**
 * `CreateRefComment` (comments.go:27-59) — the block arm, the
 * (type=4, issue_id, commit_sha) dedupe, the insert. Answers `"blocked"`
 * where upstream returns ErrBlockedUser (commit.go:186-189's continue);
 * rethrows D1 errors (upstream's `return err`).
 */
async function createRefComment(
  d1: D1Database,
  doer: XrefDoer | null,
  pusherRow: typeof users.$inferSelect | null,
  refRepo: RepositoryWithOwner,
  refIssue: IssueRow,
  content: string,
  commitSha: string,
  now: Date,
): Promise<"ok" | "blocked"> {
  if (commitSha === "") throw new Error("cannot create reference with empty commit SHA"); // comments.go:28-30

  // The block arm (:32-36): a doer blocked by the target's poster/owner
  // continues unless a repo/site admin (IsUserRepoAdmin — the module
  // header's fold; one access read).
  const blockerIds = [refIssue.posterId ?? undefined, refRepo.owner.id ?? undefined].filter((id): id is number => id !== undefined);
  if (doer !== null && (await isUserBlockedBy(d1, doer, ...blockerIds))) {
    const access = doer.isAdmin || (refRepo.repo.ownerId !== null && doer.id === refRepo.repo.ownerId)
      ? "admin"
      : await doerRepoAccessMode(d1, refRepo.repo, doer.id);
    if (access !== "admin" && access !== "owner") return "blocked";
  }

  // The same-commit dedupe (:38-48).
  const existing = await drizzle(d1)
    .select({ id: comments.id })
    .from(comments)
    .where(and(eq(comments.type, CommentType.CommitRef), eq(comments.issueId, refIssue.id), eq(comments.commitSha, commitSha)))
    .limit(1)
    .get();
  if (existing !== undefined) return "ok";

  // The insert (comments.go:50-58) — poster = the pusher, and the
  // num_comments/updated_unix bump follows the landed
  // counts-system-comments convention (xref.ts's writeStatements note;
  // upstream counts only Comment+Review types).
  await drizzle(d1).batch([
    drizzle(d1).insert(comments).values({
      type: CommentType.CommitRef,
      posterId: pusherRow?.id ?? null,
      issueId: refIssue.id,
      content,
      commitSha,
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1)
      .update(issues)
      .set({ numComments: sql`num_comments + 1`, updatedAt: now })
      .where(eq(issues.id, refIssue.id)),
  ]);
  return "ok";
}

/**
 * `issueAddTime` (commit.go:84-92) → `AddTime` (tracked_time.go:164-193):
 * the tracked_time row dated by the commit's AUTHOR time
 * (CommitToPushCommit's Timestamp, commits.go:128-138), then the type-14
 * `|<seconds>` comment carrying TimeID — the landed AddTime route's insert
 * shape (issue-tables-t2.ts:1549-1564). An amount of 0 writes nothing
 * (commit.go:86-88); an identity-less push writes nothing (upstream
 * requires a doer).
 */
async function issueAddTime(d1: D1Database, refIssue: IssueRow, pusherId: number | null, c: CommitJson, timeLog: string): Promise<void> {
  const amount = timeLogToAmount(timeLog);
  if (amount === 0 || pusherId === null) return;

  const now = new Date();
  const created = new Date(c.author.time * 1000);
  const [inserted] = await drizzle(d1)
    .insert(trackedTimes)
    .values({ issueId: refIssue.id, userId: pusherId, seconds: amount, createdAt: created })
    .returning({ id: trackedTimes.id });
  await drizzle(d1).batch([
    drizzle(d1).insert(comments).values({
      type: CommentType.AddTimeManual,
      posterId: pusherId,
      issueId: refIssue.id,
      content: `|${amount}`,
      timeId: inserted?.id ?? null,
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1)
      .update(issues)
      .set({ numComments: sql`num_comments + 1`, updatedAt: now })
      .where(eq(issues.id, refIssue.id)),
  ]);
}

/**
 * `notify.IssueChangeStatus(doer, commitID, issue, comment, closeOrReopen)`
 * (status.go:43/:56) — the `issues` / `pull_request` closed/reopened webhook
 * with `commit_id` (services/webhook/notifier.go:249-289) plus the feed
 * action row (services/feed/notifier.go:66-97), through the push-family's
 * env-parameterized emission (webhooks-push.ts:1389-1429). PR reopens never
 * reach the ladder (commit.go:193), so the PR arm is close-only.
 * Skipped for an identity-less push (module header).
 */
async function notifyStatusChange(
  input: UpdateIssuesForPushInput,
  pair: RepositoryWithOwner,
  pusherRow: typeof users.$inferSelect | null,
  row: IssueRow,
  commitSha: string,
  closed: boolean,
  now: Date,
): Promise<void> {
  if (pusherRow === null) return; // upstream cannot reach this (its pusher is always resolved)

  const d1 = input.env.DB;
  const viewer: Viewer = { origin: appOrigin(input.env, input.requestOrigin), requester: null };
  const sender = apiUserFromRow(pusherRow, viewer);
  const repository = toApiRepository(viewer, pair);
  const action = closed ? "closed" : "reopened";

  let payload: Record<string, unknown>;
  if (row.isPull) {
    // The PR render (notifier.go:252-270): ToPayloadPullRequest with the
    // diff-stat trio (the webhooks-push cascade's render, :1379-1387).
    const pr = await drizzle(d1)
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.issueId, row.id))
      .limit(1)
      .get();
    if (pr === undefined) {
      console.error(`[xref-push] ${pair.repo.ownerNamespace}/${pair.repo.slug}: PR row missing for issue ${row.id} — pull_request webhook skipped`);
      return;
    }
    const diffStats = await pullRequestDiffShortStatForEnv(input.env, pair, pr);
    const apiPull = await toApiPullRequest(d1, viewer, pair, row, pr, "payload", diffStats === null ? undefined : { diffStats });
    payload = { action, number: row.index, pull_request: apiPull, repository, sender, commit_id: commitSha };
  } else {
    // The issue render (notifier.go:271-285): ToAPIIssue — the default wire
    // render (the route's arm, routes/issues.ts:1789-1797).
    payload = { action, number: row.index, issue: await toApiIssue(d1, viewer, pair, row), repository, sender, commit_id: commitSha };
  }

  const emission: IssueEventEmission = {
    repoId: pair.repo.id,
    ownerId: pair.owner.id,
    eventType: row.isPull ? "pull_request" : "issues",
    payload,
  };
  try {
    await emitWebhookDeliveries(d1, { ...emission, refName: null }, { now });
  } catch (error) {
    console.error(
      `[xref-push] ${pair.repo.ownerNamespace}/${pair.repo.slug}: ${emission.eventType} webhook failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The feed action (feed/notifier.go:66-97) — issueActionDraft maps the
  // issue family; the PR close (the only PR shape that reaches here) rides
  // the webhooks-push cascade's direct draft (its :1409-1429 posture).
  let feedDraft: ActionDraft | null = issueActionDraft(emission);
  if (feedDraft === null && row.isPull && closed) {
    feedDraft = {
      actUserId: pusherRow.id,
      repoId: pair.repo.id,
      opType: ActionType.ClosePullRequest,
      isPrivate: pair.repo.visibility === "private",
      content: `${row.index}|`,
    };
  }
  if (feedDraft !== null) {
    try {
      await recordAction(d1, { ...feedDraft, createdAt: now });
    } catch (error) {
      console.error(
        `[xref-push] ${pair.repo.ownerNamespace}/${pair.repo.slug}: action row failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
