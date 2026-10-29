/**
 * Job summaries (SPEC-0012 §2.6, M1b) — the GITHUB_STEP_SUMMARY store,
 * ported from models/actions/run_job_summary.go + routers/api/actions/
 * job_summary.go.
 *
 * Caps: per-step 1 MiB and aggregate-per-job-attempt 1 MiB ("matches
 * GitHub's documented cap"). The aggregate check is best-effort upstream
 * (a tx would not serialize concurrent step uploads — no row-level lock on
 * the parent job); ours mirrors that deliberately. content_size is stored
 * explicitly (the LENGTH()-counts-characters trap, run_job_summary.go:44-48).
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRunJobSummaries } from "../../db/schema";

type D1 = D1Database;

/** JobSummaryContentTypeMarkdown (run_job_summary.go:19). */
export const JOB_SUMMARY_CONTENT_TYPE_MARKDOWN = "text/markdown";

/** MaxJobSummarySize (run_job_summary.go:23-24). */
export const MAX_JOB_SUMMARY_SIZE = 1024 * 1024;

/** MaxJobSummaryAggregateSize (run_job_summary.go:26-29). */
export const MAX_JOB_SUMMARY_AGGREGATE_SIZE = 1024 * 1024;

export type JobSummaryRow = typeof actionRunJobSummaries.$inferSelect;

export class JobSummaryAggregateExceededError extends Error {}

/**
 * UpsertActionRunJobSummary (run_job_summary.go:77-115): validate, check
 * the aggregate (excluding this step — the upsert replaces its size), then
 * the ON CONFLICT upsert over the summary_key.
 */
export async function upsertJobSummary(
  d1: D1,
  repoId: string,
  runId: number,
  runAttemptId: number,
  jobId: number,
  stepIndex: number,
  contentType: string,
  content: Uint8Array,
): Promise<void> {
  if (runId <= 0 || jobId <= 0 || repoId === "" || stepIndex < 0) {
    throw new Error("invalid summary");
  }
  if (content.length === 0) {
    // Treat empty summaries as a no-op; the runner may create SUMMARY.md
    // but never write to it.
    return;
  }
  if (content.length > MAX_JOB_SUMMARY_SIZE) {
    throw new Error("invalid summary");
  }
  if (contentType !== JOB_SUMMARY_CONTENT_TYPE_MARKDOWN) {
    throw new Error("invalid summary");
  }

  const db = drizzle(d1);
  const otherRows = await db
    .select({ total: sql<number>`COALESCE(SUM(${actionRunJobSummaries.contentSize}), 0)` })
    .from(actionRunJobSummaries)
    .where(
      and(
        eq(actionRunJobSummaries.repoId, repoId),
        eq(actionRunJobSummaries.runId, runId),
        eq(actionRunJobSummaries.runAttemptId, runAttemptId),
        eq(actionRunJobSummaries.jobId, jobId),
        sql`${actionRunJobSummaries.stepIndex} <> ${stepIndex}`,
      ),
    );
  const otherSize = Number(otherRows[0]?.total ?? 0);
  if (otherSize + content.length > MAX_JOB_SUMMARY_AGGREGATE_SIZE) {
    throw new JobSummaryAggregateExceededError("job summary aggregate size exceeded");
  }

  const now = new Date();
  const text = new TextDecoder().decode(content);
  await db
    .insert(actionRunJobSummaries)
    .values({
      repoId,
      runId,
      runAttemptId,
      jobId,
      stepIndex,
      content: text,
      contentType,
      contentSize: content.length,
      created: now,
      updated: now,
    })
    .onConflictDoUpdate({
      target: [
        actionRunJobSummaries.repoId,
        actionRunJobSummaries.runId,
        actionRunJobSummaries.runAttemptId,
        actionRunJobSummaries.jobId,
        actionRunJobSummaries.stepIndex,
      ],
      set: { content: text, contentType, contentSize: content.length, updated: now },
    });
}

/** DeleteActionRunJobSummary (run_job_summary.go:128-137). */
export async function deleteJobSummary(
  d1: D1,
  repoId: string,
  runId: number,
  runAttemptId: number,
  jobId: number,
  stepIndex: number,
): Promise<void> {
  await drizzle(d1)
    .delete(actionRunJobSummaries)
    .where(
      and(
        eq(actionRunJobSummaries.repoId, repoId),
        eq(actionRunJobSummaries.runId, runId),
        eq(actionRunJobSummaries.runAttemptId, runAttemptId),
        eq(actionRunJobSummaries.jobId, jobId),
        eq(actionRunJobSummaries.stepIndex, stepIndex),
      ),
    );
}

/** ListActionRunJobSummaries (run_job_summary.go:140-158). */
export async function listJobSummaries(
  d1: D1,
  repoId: string,
  runId: number,
  runAttemptId: number,
  jobId: number,
): Promise<JobSummaryRow[]> {
  return drizzle(d1)
    .select()
    .from(actionRunJobSummaries)
    .where(
      and(
        eq(actionRunJobSummaries.repoId, repoId),
        eq(actionRunJobSummaries.runId, runId),
        eq(actionRunJobSummaries.runAttemptId, runAttemptId),
        jobId > 0 ? eq(actionRunJobSummaries.jobId, jobId) : undefined,
      ),
    )
    .orderBy(asc(actionRunJobSummaries.jobId), asc(actionRunJobSummaries.stepIndex));
}

/**
 * normalizeJobSummaryContentType (job_summary.go:96-106): absent or the
 * octet-stream default accepts as markdown; any parsed media type other
 * than text/markdown is rejected.
 */
export function normalizeJobSummaryContentType(contentType: string): string | null {
  if (contentType === "" || contentType === "application/octet-stream") {
    return JOB_SUMMARY_CONTENT_TYPE_MARKDOWN;
  }
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType === "" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(mediaType)) {
    return null;
  }
  if (mediaType !== JOB_SUMMARY_CONTENT_TYPE_MARKDOWN) {
    return null;
  }
  return JOB_SUMMARY_CONTENT_TYPE_MARKDOWN;
}
