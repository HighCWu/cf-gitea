// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// Port of gitea/services/actions/invalid_workflow.go at the pin fc493688 —
// SPEC-0012 §D2 #9's push arm (tier S): a workflow that fails the
// detection-time static validation (`ValidateWorkflowStatic`) is recorded by
// a push as a FAILED RUN with the parse error as its summary, gated upstream
// at services/actions/notifier_helper.go:284-286 and surfaced in the run list
// (routers/web/repo/actions/actions.go:559-569).
//
// The two post-insert arms of upstream's insertInvalidWorkflowRun are STAGED
// seams, not omissions — their owning machinery does not exist in this tree
// yet:
//
//   - createWorkflowCommitStatus (invalid_workflow.go:88-93 →
//     services/actions/commit_status.go) — the commit-status service is the
//     M3 P-tier landing; the trigger caller wires the status once it lands.
//   - NotifyWorkflowRunStatusUpdate (:95-97) — the notifier census
//     (services/actions/notifier.go:41-784) is likewise the P-tier landing.
//
// The run-index is upstream's GetNextResourceIndex(ctx, "action_run_index",
// RepoID) (invalid_workflow.go:59-61); cf-gitea's M3-free reduction is
// max(index)+1 over the repo's runs (the landed dispatch pattern,
// src/api/routes/repo-actions.ts:1255-1261), with the
// UNIQUE(repo_id, index) arbitration (action_runs_repo_index_uq) as the
// concurrent-push backstop — upstream's named sequence avoids the collision
// where this one surfaces it; recorded as the known staging divergence.

import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionRunAttempts, actionRunJobSummaries, actionRuns } from "../../db/schema";
import { loadRepoActionsConfig } from "./config";
import { ACTION_STATUS_FAILURE, ellipsisDisplayString } from "./model";
import type { RunRow } from "./model";

/** The run fields upstream's handleInvalidWorkflows assembles from the push
 * notify input (invalid_workflow.go:33-41). The caller (the trigger chain) —
 * which owns the notify input — fills these. */
export interface InvalidWorkflowRunInput {
  /** commit.MessageTitle(). */
  title: string;
  repoId: string;
  ownerId: number;
  /** The workflow entry path, e.g. ".github/workflows/ci.yml". */
  workflowId: string;
  /** input.Doer.ID. */
  triggerUserId: number;
  /** ref.String(). */
  ref: string;
  /** commit.ID.String(). */
  commitSha: string;
  /** The webhook event type (input.Event). */
  event: string;
  /** string(input.Event). */
  triggerEvent: string;
  /** The encoded event payload JSON (input.EncodedPayload()). */
  eventPayload: string;
}

/** The parse error surface: the static-validation error the workflow failed
 * with, rendered into the summary. */
export type InvalidWorkflowParseError = Error | string;

const MARKDOWN = "text/markdown";

/** summaryContent renders upstream's summary body (invalid_workflow.go:81). */
export function summaryContent(workflowId: string, parseErr: InvalidWorkflowParseError): string {
  const message = parseErr instanceof Error ? parseErr.message : parseErr;
  return `**Invalid workflow file: ${workflowId}**\n\n\`\`\`\n${message}\n\`\`\`\n`;
}

/** insertInvalidWorkflowRun records run as failed with parseErr as its
 * summary (invalid_workflow.go:48-101): title ellipsized, Status/Started/
 * Stopped = failure/now/now, index from the per-repo counter, attempt-1 row,
 * the run's latest-attempt link, then the summary row. */
export async function insertInvalidWorkflowRun(
  d1: D1Database,
  run: InvalidWorkflowRunInput,
  parseErr: InvalidWorkflowParseError,
): Promise<RunRow> {
  const db = drizzle(d1);
  const now = new Date();

  // The per-repo index (the M3-free max+1 reduction, repo-actions.ts:1261).
  const indexRows = await db
    .select({ maxIndex: actionRuns.index })
    .from(actionRuns)
    .where(eq(actionRuns.repoId, run.repoId))
    .orderBy(desc(actionRuns.index))
    .limit(1);
  const index = (indexRows[0]?.maxIndex ?? 0) + 1;

  const content = summaryContent(run.workflowId, parseErr);
  const contentSize = new TextEncoder().encode(content).length; // byte length, not units

  const runRows = await db
    .insert(actionRuns)
    .values({
      title: ellipsisDisplayString(run.title, 255), // invalid_workflow.go:55, models/util's 255 ellipsis
      repoId: run.repoId,
      ownerId: run.ownerId,
      workflowId: run.workflowId,
      index,
      triggerUserId: run.triggerUserId,
      ref: run.ref,
      commitSha: run.commitSha,
      event: run.event,
      eventPayload: run.eventPayload,
      triggerEvent: run.triggerEvent,
      status: ACTION_STATUS_FAILURE,
      started: now,
      stopped: now,
      workflowRepoId: run.repoId, // WorkflowRepoID: input.Repo.ID (invalid_workflow.go:40)
      workflowCommitSha: run.commitSha, // WorkflowCommitSHA: commit.ID.String()
      latestAttemptId: 0, // linked after the attempt row, as upstream's tx does
      created: now,
      updated: now,
    })
    .returning();
  const runRow = runRows[0];
  if (runRow === undefined) {
    throw new Error("actions: invalid-workflow run insert returned no row");
  }

  const attemptRows = await db
    .insert(actionRunAttempts)
    .values({
      repoId: run.repoId,
      runId: runRow.id,
      attempt: 1,
      triggerUserId: run.triggerUserId,
      status: ACTION_STATUS_FAILURE,
      started: now,
      stopped: now,
      created: now,
      updated: now,
    })
    .returning();
  const attemptRow = attemptRows[0];
  if (attemptRow === undefined) {
    throw new Error("actions: invalid-workflow attempt insert returned no row");
  }
  await db
    .update(actionRuns)
    .set({ latestAttemptId: attemptRow.id, updated: now })
    .where(eq(actionRuns.id, runRow.id));

  // The summary row: JobID/StepIndex are Go's zero values on upstream's
  // struct literal (invalid_workflow.go:82-87) — 0/0 here, under the
  // UNIQUE(summary_key) space the per-step writer never touches for 0.
  await db.insert(actionRunJobSummaries).values({
    repoId: run.repoId,
    runId: runRow.id,
    runAttemptId: attemptRow.id,
    jobId: 0,
    stepIndex: 0,
    content,
    contentType: MARKDOWN,
    contentSize,
    created: now,
    updated: now,
  });

  // invalid_workflow.go:88-97 — the commit-status and notifier arms are the
  // staged seams documented in the module header (their owning services are
  // the P-tier landing; the trigger caller wires them).

  return { ...runRow, latestAttemptId: attemptRow.id };
}

/** handleInvalidWorkflows ports the dispatch loop (invalid_workflow.go:20-45):
 * one failed run per invalid workflow entry, skipping the entries the repo's
 * Actions config disables (invalid_workflow.go:28-30). `invalid` maps the
 * entry path to its static-validation error; insertion errors are LOGGED and
 * swallowed per entry, not fatal to the push (upstream logs at :75-77/:91-93). */
export async function handleInvalidWorkflows(
  d1: D1Database,
  input: {
    repoId: string;
    ownerId: number;
    doerId: number;
    ref: string;
    commitSha: string;
    commitTitle: string;
    event: string;
    eventPayload: string;
  },
  invalid: Record<string, InvalidWorkflowParseError>,
): Promise<void> {
  if (Object.keys(invalid).length === 0) {
    return;
  }
  const cfg = await loadRepoActionsConfig(d1, input.repoId);
  for (const [entryName, parseErr] of Object.entries(invalid)) {
    if (cfg.disabledWorkflows.includes(entryName)) {
      continue; // actionsConfig.IsWorkflowDisabled(entryName), invalid_workflow.go:29-31
    }
    try {
      await insertInvalidWorkflowRun(
        d1,
        {
          title: input.commitTitle,
          repoId: input.repoId,
          ownerId: input.ownerId,
          workflowId: entryName,
          triggerUserId: input.doerId,
          ref: input.ref,
          commitSha: input.commitSha,
          event: input.event,
          triggerEvent: input.event,
          eventPayload: input.eventPayload,
        },
        parseErr,
      );
    } catch (error) {
      console.error(`insert run for invalid workflow ${JSON.stringify(entryName)}: ${String(error)}`);
    }
  }
}
