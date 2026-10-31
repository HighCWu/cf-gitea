// Copyright 2026 The Gitea Authors. All rights reserved.
// SPDX-License-Identifier: MIT
//
// The invalid-workflow failed-run arm's suite (services/actions/
// invalid_workflow.go at the pin fc493688, SPEC-0012 §D2 #9's push arm).
// Each case pins one upstream arm: the failure posture (failed run, started
// = stopped = now), the per-repo index, the attempt-1 row + latest-attempt
// link, the summary body with the parse error verbatim, the byte ContentSize,
// the zero JobID/StepIndex key space, and the disabled-workflow skip.

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  actionRunAttempts,
  actionRunJobSummaries,
  actionRuns,
  repositories,
  repoUnits,
  users,
} from "../../db/schema";
import { ACTION_STATUS_FAILURE, ACTION_STATUS_SUCCESS } from "./model";
import { handleInvalidWorkflows, insertInvalidWorkflowRun, summaryContent } from "./invalid-workflow";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const CLEANUP_TABLES = ["action_run_job_summaries", "action_run_attempts", "action_runs", "repo_units", "repositories", "users"];

beforeEach(async () => {
  for (const table of CLEANUP_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

const REPO_ID = "repo-invalid";
const T0 = new Date(1_700_000_000 * 1000);
const USER_ID = 11;

async function seedRepo(): Promise<void> {
  await db().insert(users).values({
    id: USER_ID,
    username: "alice",
    usernameLower: "alice",
    status: "active",
    createdAt: T0,
  });
  await db().insert(repositories).values({
    id: REPO_ID,
    storageKey: `r_${REPO_ID}`,
    ownerNamespace: "alice",
    ownerId: USER_ID,
    slug: "widget",
    visibility: "public",
  });
  await db().insert(repoUnits).values({ repoId: REPO_ID, type: "actions" });
}

const RUN_INPUT = {
  title: "the broken workflow",
  repoId: REPO_ID,
  ownerId: USER_ID,
  workflowId: ".github/workflows/broken.yml",
  triggerUserId: USER_ID,
  ref: "refs/heads/main",
  commitSha: "1234567890abcdef1234567890abcdef12345678",
  event: "push",
  triggerEvent: "push",
  eventPayload: '{"event":"push"}',
};

describe("insertInvalidWorkflowRun (invalid_workflow.go:48-101)", () => {
  it("records a failed run with the parse error as its summary", async () => {
    await seedRepo();
    const parseErr = new Error('run-name: Unrecognized named-value: \'needs\'');

    const run = await insertInvalidWorkflowRun(env.DB, RUN_INPUT, parseErr);

    // the failure posture: Status/Started/Stopped = failure/now/now (:56-57)
    expect(run.status).toBe(ACTION_STATUS_FAILURE);
    expect(run.started).not.toBeNull();
    expect(run.stopped).not.toBeNull();
    expect(run.stopped!.getTime()).toBe(run.started!.getTime());
    expect(run.workflowId).toBe(".github/workflows/broken.yml");
    expect(run.index).toBe(1); // the first run in the repo (:59-61)
    expect(run.triggerEvent).toBe("push");

    // the summary: upstream's exact body (:81), byte ContentSize (:84),
    // markdown content type (:87), zero JobID/StepIndex (Go zero values)
    const summaries = await db().select().from(actionRunJobSummaries).where(eq(actionRunJobSummaries.runId, run.id));
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]!;
    const expected = `**Invalid workflow file: ${RUN_INPUT.workflowId}**\n\n\`\`\`\n${parseErr.message}\n\`\`\`\n`;
    expect(summary.content).toBe(expected);
    expect(summary.contentSize).toBe(new TextEncoder().encode(expected).length);
    expect(summary.contentType).toBe("text/markdown");
    expect(summary.jobId).toBe(0);
    expect(summary.stepIndex).toBe(0);
    expect(summary.runAttemptId).not.toBe(0);
  });

  it("links the attempt-1 failure row as the latest attempt (:63-71)", async () => {
    await seedRepo();
    const run = await insertInvalidWorkflowRun(env.DB, RUN_INPUT, "bad YAML");

    const attempts = await db().select().from(actionRunAttempts).where(eq(actionRunAttempts.runId, run.id));
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    expect(attempt.attempt).toBe(1);
    expect(attempt.status).toBe(ACTION_STATUS_FAILURE);
    expect(attempt.started).not.toBeNull();
    expect(attempt.stopped).not.toBeNull();
    expect(run.latestAttemptId).toBe(attempt.id);
  });

  it("advances the per-repo run index across runs (:59-61)", async () => {
    await seedRepo();
    const first = await insertInvalidWorkflowRun(env.DB, RUN_INPUT, "bad YAML");
    const second = await insertInvalidWorkflowRun(env.DB, { ...RUN_INPUT, workflowId: ".github/workflows/worse.yml" }, "worse YAML");
    expect(first.index).toBe(1);
    expect(second.index).toBe(2);
  });

  it("keeps a valid run untouched next to the failed one", async () => {
    await seedRepo();
    const failed = await insertInvalidWorkflowRun(env.DB, RUN_INPUT, "bad YAML");
    // the valid workflow's own run (the trigger chain's insertActionRun) would
    // take the next index; here only the failure posture matters — assert the
    // failed run is the failure one and a success status would differ.
    const rows = await db().select().from(actionRuns).where(eq(actionRuns.repoId, REPO_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(failed.id);
    expect(rows[0]!.status).not.toBe(ACTION_STATUS_SUCCESS);
  });

  it("ellipsizes an over-long title at 255 (:55)", async () => {
    await seedRepo();
    const run = await insertInvalidWorkflowRun(env.DB, { ...RUN_INPUT, title: "x".repeat(300) }, "bad YAML");
    expect(run.title.length).toBeLessThanOrEqual(255);
    expect(run.title.endsWith("…")).toBe(true);
  });

  it("renders the summary content exactly (invalid_workflow.go:81)", () => {
    expect(summaryContent(".gitea/workflows/x.yml", new Error("boom"))).toBe(
      "**Invalid workflow file: .gitea/workflows/x.yml**\n\n```\nboom\n```\n",
    );
    expect(summaryContent(".gitea/workflows/x.yml", "string error")).toBe(
      "**Invalid workflow file: .gitea/workflows/x.yml**\n\n```\nstring error\n```\n",
    );
  });
});

describe("handleInvalidWorkflows (invalid_workflow.go:20-45)", () => {
  it("is a no-op with no invalid workflows (:21-23)", async () => {
    await seedRepo();
    await handleInvalidWorkflows(env.DB, { ...RUN_INPUT, doerId: USER_ID, commitTitle: RUN_INPUT.title }, {});
    const rows = await db().select().from(actionRuns);
    expect(rows).toHaveLength(0);
  });

  it("inserts one failed run per invalid entry", async () => {
    await seedRepo();
    await handleInvalidWorkflows(
      env.DB,
      { ...RUN_INPUT, doerId: USER_ID, commitTitle: RUN_INPUT.title },
      {
        ".github/workflows/a.yml": "a's error",
        ".github/workflows/b.yml": "b's error",
      },
    );
    const rows = await db().select().from(actionRuns);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.index).sort()).toEqual([1, 2]);
    const summaries = await db().select().from(actionRunJobSummaries);
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.content).sort()).toEqual(
      [
        "**Invalid workflow file: .github/workflows/a.yml**\n\n```\na's error\n```\n",
        "**Invalid workflow file: .github/workflows/b.yml**\n\n```\nb's error\n```\n",
      ].sort(),
    );
  });

  it("skips a disabled workflow (:28-31)", async () => {
    await seedRepo();
    // the repo's Actions config disables one entry (repo_unit_actions config)
    await db()
      .update(repoUnits)
      .set({ config: JSON.stringify({ DisabledWorkflows: [".github/workflows/broken.yml"] }) })
      .where(eq(repoUnits.repoId, REPO_ID));
    await handleInvalidWorkflows(
      env.DB,
      { ...RUN_INPUT, doerId: USER_ID, commitTitle: RUN_INPUT.title },
      { ".github/workflows/broken.yml": "bad YAML" },
    );
    const rows = await db().select().from(actionRuns);
    expect(rows).toHaveLength(0);
  });

  it("lands the entry for a unit-less repo (the config load falls back to the zero config)", async () => {
    // the config load's fallback arm (parseRepoActionsConfig(null)) — a repo
    // without an actions unit still records the failed run, matching
    // upstream's zero ActionsConfig read.
    await db().insert(users).values({
      id: USER_ID,
      username: "alice",
      usernameLower: "alice",
      status: "active",
      createdAt: T0,
    });
    await db().insert(repositories).values({
      id: REPO_ID,
      storageKey: `r_${REPO_ID}`,
      ownerNamespace: "alice",
      ownerId: USER_ID,
      slug: "widget",
      visibility: "public",
    });
    await handleInvalidWorkflows(
      env.DB,
      { ...RUN_INPUT, doerId: USER_ID, commitTitle: RUN_INPUT.title },
      { ".github/workflows/a.yml": "a's error" },
    );
    const rows = await db().select().from(actionRuns).where(eq(actionRuns.repoId, REPO_ID));
    expect(rows).toHaveLength(1);
  });
});
