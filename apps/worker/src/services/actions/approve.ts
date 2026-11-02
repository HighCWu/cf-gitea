/**
 * The approve service (SPEC-0012's C5 run-mutation arm — the run-viewer's
 * approve POST, web.go:1590) — ported from services/actions/approve.go
 * (upstream pin fc493688) at the M1 store's stage, the same v1 subset the
 * API surface's approve port landed (api/routes/repo-actions.ts's
 * approveRun, citing approve.go:25-140).
 *
 * THE V1-BOUNDARY VERDICT. Upstream ApproveRuns (approve.go:25-187) is one
 * transaction over per-run arms; at this store's truth the arms reduce to:
 *
 *   1. the awaiting-approval skip (approve.go:36-38 — IsAwaitingApproval,
 *      run.go:84-86): a run that does not await approval is a silent no-op
 *      (the web handler still answers JSONOK — view.go:1057-1066's shape),
 *   2. the flag flip (approve.go:39-43): need_approval=false +
 *      approved_by=doer — THE two columns the run-viewer's "Approve" arm
 *      exists to write,
 *   3. the needs-less BLOCKED-job release (approve.go:106-132 minus the
 *      M3 arms): approval unblocks every job at once, but only the
 *      needs-carrying jobs wait for the emitter — a no-needs BLOCKED job
 *      is approval-blocked pure and simple, so it flips BLOCKED→WAITING
 *      through the guarded update (approve.go:127's builder.Eq — the CAS
 *      a concurrent cancel wins), while
 *   4. the M3 arms stay staged with the rerun module's disclosures
 *      (services/actions/rerun.ts header): the `if:` re-decision
 *      (evaluateJobIf, approve.go:84-98), the attempt's concurrency-group
 *      re-check (PrepareToStartRunWithConcurrency, approve.go:53-62), the
 *      runs-on validation (invalidRunsOn, approve.go:103-116), the
 *      max-parallel slot map (applyMaxParallel, approve.go:69-73,
 *      123) and the reusable-caller expansion (approve.go:136-144) — v1
 *      rows never carry the decided-if/concurrency/caller state those arms
 *      read (SPEC §1.4), and the trigger insert writes the same
 *      waiting/pending/blocked shapes directly,
 *   5. the post-flip tails (approve.go:153-163): the emitter pass
 *      (EmitJobsIfReadyByRun) rides the v1 substitute pair the landed
 *      emitter stage established — the dispatch wake
 *      (hasWaitingJobsToPick → increaseTaskVersion, the UpdateRunJob
 *      hook's bump arm) + the re-aggregate (refreshRunStatus,
 *      run_job.go:567-600).
 */

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRunJobs, actionRuns } from "../../db/schema";
import {
  ACTION_STATUS_BLOCKED,
  ACTION_STATUS_WAITING,
  increaseTaskVersion,
  type D1,
  type RunJobRow,
  type RunRow,
} from "./model";
import { hasWaitingJobsToPick, isDoneStatus, refreshRunStatus } from "./update";

/** The service's rejection arms, each citing its upstream arm. The web
 *  handler's resolution (getCurrentRunByPathParam's repo-scoped read)
 *  answers the miss arms before the service runs; the rejections here are
 *  the internal-misuse posture (the rerun module's convention). */
export type ApproveRejection =
  /** approve.go:32's repo-scoped GetRunByRepoAndID miss — the run row
   *  outside the caller's repo. */
  | "repo-mismatch"
  /** approve.go:180-182's post-write reload miss ("run %d no longer exists
   *  after approval") — the concurrent-delete race. */
  | "run-missing";

export type ApproveOutcome =
  | { ok: true; approved: boolean; run: RunRow }
  | { ok: false; reason: ApproveRejection; message: string };

/** IsAwaitingApproval (run.go:84-86) — needApproval && !Status.IsDone(). */
export function isAwaitingApproval(run: Pick<RunRow, "needApproval" | "status">): boolean {
  return run.needApproval && !isDoneStatus(run.status);
}

/** GetLatestAttemptJobsByRun (run_job.go:264-274): the latest attempt's
 *  jobs, id ASC; the legacy arm matches run_attempt_id = 0 rows. */
async function latestAttemptJobsOfRun(d1: D1, run: RunRow): Promise<RunJobRow[]> {
  return drizzle(d1)
    .select()
    .from(actionRunJobs)
    .where(and(eq(actionRunJobs.runId, run.id), eq(actionRunJobs.runAttemptId, run.latestAttemptId)))
    .orderBy(asc(actionRunJobs.id));
}

/**
 * ApproveRuns (approve.go:25-187) at the v1 store's stage, single-run (the
 * web handler passes one id — view.go:1061's `[]int64{run.ID}`): the
 * awaiting-approval skip is a `approved: false` no-op, the flip writes the
 * two columns, the needs-less BLOCKED jobs release to WAITING through the
 * CAS update, and the wake + re-aggregate tails fire only when something
 * released (approve.go:153-163's v1 substitute pair). The run row returns
 * re-read (approve.go:167-186's reload tail) in every arm, so the caller
 * never sees a stale flag.
 */
export async function approveRun(d1: D1, repoId: string, run: RunRow, doerId: number): Promise<ApproveOutcome> {
  if (repoId === "" || run.repoId !== repoId) {
    // approve.go:32 — the repo-scoped read's miss arm.
    return { ok: false, reason: "repo-mismatch", message: `run ${run.id} does not belong to repo ${repoId}` };
  }

  const db = drizzle(d1);
  const now = new Date();

  // approve.go:36-38 — a run that does not await approval skips silently
  // (the web handler still answers its JSONOK dummy).
  if (!isAwaitingApproval(run)) {
    return { ok: true, approved: false, run };
  }

  // approve.go:39-43 — UpdateRun(ctx, run, "need_approval", "approved_by").
  await db
    .update(actionRuns)
    .set({ needApproval: false, approvedBy: doerId, updated: now })
    .where(eq(actionRuns.id, run.id));

  // approve.go:45 + 75-132 — the release walk over the latest attempt's
  // jobs. Only approval-blocked NEEDS-LESS jobs release here
  // (approve.go:77's `Status != Blocked || len(Needs) > 0` skip); the
  // needs-carrying jobs wait for the emitter pass (job_emitter.go's
  // needs flip, the M3 seam). The M3 arms inside the loop — the `if:`
  // re-decision, the runs-on validation, the job-level concurrency and
  // the slot map — stage with the module header (v1 rows never carry the
  // state they read).
  const jobs = await latestAttemptJobsOfRun(d1, run);
  let released = 0;
  for (const job of jobs) {
    if (job.status !== ACTION_STATUS_BLOCKED) continue;
    let needs: unknown;
    try {
      needs = JSON.parse(job.needs);
    } catch {
      needs = [];
    }
    if (Array.isArray(needs) && needs.length > 0) continue; // approve.go:77
    // approve.go:127 — the guarded update (builder.Eq{"status": Blocked}):
    // a concurrent terminal write wins the CAS and the row does not count.
    const updated = await db
      .update(actionRunJobs)
      .set({ status: ACTION_STATUS_WAITING, updated: now })
      .where(and(eq(actionRunJobs.id, job.id), eq(actionRunJobs.status, ACTION_STATUS_BLOCKED)))
      .returning({ id: actionRunJobs.id });
    released += updated.length;
  }

  // approve.go:153-163's v1 substitute: the dispatch wake fires when
  // waiting work remains (run_job.go:504-527's hook-bump arm), the
  // aggregate re-aggregates (run_job.go:567-600). Nothing released — a
  // blocked attempt or an empty job list — and the run's columns are the
  // only change; the status write is skipped (the API port's shape).
  if (released > 0) {
    if (await hasWaitingJobsToPick(d1, run.repoId)) {
      await increaseTaskVersion(d1, run.ownerId, run.repoId);
    }
    await refreshRunStatus(d1, run.repoId, run.id, run.latestAttemptId);
  }

  // approve.go:167-186 — the reload tail: the caller reads the run back.
  const rows = await db.select().from(actionRuns).where(eq(actionRuns.id, run.id)).limit(1);
  const reloaded = rows[0];
  if (reloaded === undefined) {
    return { ok: false, reason: "run-missing", message: `run ${run.id} no longer exists after approval` };
  }
  return { ok: true, approved: true, run: reloaded };
}
