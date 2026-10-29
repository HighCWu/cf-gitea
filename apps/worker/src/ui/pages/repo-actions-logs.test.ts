/**
 * The job-log download arm's tests (the F-row tail GET #1 — the module
 * header's upstream pins): the resolution posture (ID-based only — "latest"
 * resolves, a legacy index URL misses), the throw arms verbatim (a foreign
 * job id, an unclaimed job, a vanished task, an expired log — ALL
 * upstream's ServerError class, never a 404), the filename port
 * (FileNameJoinFields/PathBaseStem's sanitization + truncation), the hot
 * and sealed byte reads over the M1b chunk store + R2, and the
 * ServeSetHeaders response contract. Module-loader tests (the pre-mount
 * house pattern — the route lands in the orchestrator's window, so the
 * arms run against the loaders directly).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { actionLogChunks, actionRunJobs, actionTasks, repositories } from "../../db/schema";
import { insertActionRun } from "../../services/actions/model";
import { formatLog } from "../../services/actions/logs";
import {
  actionsJobLogFilename,
  actionsJobLogsResponse,
  effectiveTaskId,
  fileNameJoinFields,
  loadActionsRunJobLogs,
  pathBaseStem,
} from "./repo-actions-logs";
import { encodeContentDisposition } from "../../web/attachments-serving";

/** The stringContaining escape hatch (the routes.test.ts precedent — the
 *  vitest asymmetric-matcher factories return `any`). */
const containing = (text: string): unknown => expect.stringContaining(text);

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const CLEANUP_TABLES = [
  "action_log_chunks",
  "action_run_jobs",
  "action_runs",
  "action_run_attempts",
  "action_tasks",
  "action_tasks_versions",
  "repositories",
  "users",
];

beforeEach(async () => {
  for (const table of CLEANUP_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const logs = await env.REPO_PACKS.list({ prefix: "actions/logs/" });
  if (logs.objects.length > 0) {
    await env.REPO_PACKS.delete(logs.objects.map((o) => o.key));
  }
});

const db = () => drizzle(env.DB);

const WORKFLOW_ID = ".github/workflows/ci.yml";
const SHA = "ccccdddddddddddddddddddddddddddddddddddd";
const PAYLOAD = new TextEncoder().encode("name: ci\njobs:\n  build:\n    steps:\n      - run: echo hi\n");

async function seedRepo(): Promise<string> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, is_empty, created_at) VALUES (?, ?, 'alice', 1, 'demo', 'main', 'public', 0, unixepoch())",
  ).bind("repo-demo", "repo-demo").run();
  const rows = await db().select().from(repositories).where(eq(repositories.id, "repo-demo"));
  const repo = rows[0];
  if (repo === undefined) throw new Error("fixture repository missing");
  return repo.id;
}

/** One run + one job, through the M1a staged insert. */
async function seedRun(repoId: string, index: number): Promise<{ runId: number; jobId: number }> {
  const { run, jobRows } = await insertActionRun(
    env.DB,
    {
      repoId,
      ownerId: 1,
      workflowId: WORKFLOW_ID,
      index,
      triggerUserId: 1,
      ref: "refs/heads/main",
      commitSha: SHA,
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
    },
    [{ jobId: "build", name: "build", runsOn: ["ubuntu-latest"], workflowPayload: PAYLOAD }],
  );
  const job = jobRows[0];
  if (job === undefined) throw new Error("job seed failed");
  return { runId: run.id, jobId: job.id };
}

/** A claimed task for the job (the dispatch claim's row shape) with the
 *  log columns the download reads. */
async function seedTask(
  jobId: number,
  repoId: string,
  opts: { logExpired?: boolean; logInStorage?: boolean; logFilename?: string } = {},
): Promise<number> {
  const now = new Date();
  const rows = await db()
    .insert(actionTasks)
    .values({
      jobId,
      attempt: 1,
      runnerId: 0,
      status: 6,
      started: now,
      repoId,
      ownerId: 1,
      commitSha: SHA,
      tokenHash: crypto.randomUUID(),
      logFilename: opts.logFilename ?? "alice/demo/ab/1.log",
      logInStorage: opts.logInStorage ?? false,
      logSize: 0,
      logExpired: opts.logExpired ?? false,
      created: now,
      updated: now,
    })
    .returning({ id: actionTasks.id });
  const task = rows[0];
  if (task === undefined) throw new Error("task seed failed");
  await db().update(actionRunJobs).set({ taskId: task.id }).where(eq(actionRunJobs.id, jobId));
  return task.id;
}

/** Chunk rows the way UpdateLog writes them (one row per append, the
 *  formatted line bytes), advancing the task's log counters. */
async function seedChunks(taskId: number, lines: string[]): Promise<void> {
  let seq = 0;
  let size = 0;
  for (const line of lines) {
    const bytes = new TextEncoder().encode(`${line}\n`);
    size += bytes.length;
    await db().insert(actionLogChunks).values({ taskId, seq: seq++, bytes });
  }
  await db().update(actionTasks).set({ logSize: size, logLength: lines.length }).where(eq(actionTasks.id, taskId));
}

// --- the filename port (FileNameJoinFields + PathBaseStem) -------------------

describe("actionsJobLogFilename (actions.go:126's FileNameJoinFields call)", () => {
  it("joins the stem, job name and task id with '-' and the .log extension", () => {
    expect(pathBaseStem(".github/workflows/ci.yml")).toBe("ci");
    expect(pathBaseStem("ci.yml")).toBe("ci");
    expect(pathBaseStem("noext")).toBe("noext");
    expect(actionsJobLogFilename("ci.yml", "build", 42)).toBe("ci-build-42.log");
    // The store's path-spelled workflow ids stem the same as bare ones.
    expect(actionsJobLogFilename(WORKFLOW_ID, "build", 42)).toBe("ci-build-42.log");
  });

  it("sanitizes dots/dashes in non-final fields and invalid chars everywhere", () => {
    expect(fileNameJoinFields(["my.workflow-1", "de<ploy>/x", 7, ".log"])).toBe("my_workflow_1-de_ploy__x-7.log");
  });

  it("truncates over-long stems against the 210-byte budget with the __ marker", () => {
    const long = "a".repeat(220);
    const out = fileNameJoinFields([long, "build", 7, ".log"]);
    // Field 0: budget 210 - 9 (3 remaining fields) → cut to 199 + "__";
    // field 1: budget 204, carried 201 → "b" cut to 1 + "__"; then "-7.log".
    expect(out).toBe(`${"a".repeat(199)}__-b__${"-7.log"}`);
  });
});

// --- the response contract (ServeSetHeaders) ---------------------------------

describe("actionsJobLogsResponse (the ServeSetHeaders contract)", () => {
  it("serves the attachment headers over the raw bytes", async () => {
    const bytes = new TextEncoder().encode("line one\nline two\n");
    const response = actionsJobLogsResponse(bytes, "ci-build-42.log");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe("attachment; filename=ci-build-42.log");
    expect(response.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it("encodes the disposition the content_disposition.go way (the landed port)", () => {
    // A token name renders the unquoted form; the safe name of a spaced,
    // non-ASCII name takes the quoted-string form + the RFC 2231 twin.
    expect(encodeContentDisposition("attachment", "plain.log")).toBe("attachment; filename=plain.log");
    expect(encodeContentDisposition("attachment", "wörk log.log")).toBe(
      `attachment; filename="w_rk log.log"; filename*=utf-8''w%C3%B6rk%20log.log`,
    );
  });
});

// --- EffectiveTaskID ----------------------------------------------------------

describe("effectiveTaskId (run_job.go:158-163)", () => {
  it("prefers the current claim, falls back to the reused source task", () => {
    expect(effectiveTaskId({ taskId: 9, sourceTaskId: 4 })).toBe(9);
    expect(effectiveTaskId({ taskId: 0, sourceTaskId: 4 })).toBe(4);
    expect(effectiveTaskId({ taskId: 0, sourceTaskId: 0 })).toBe(0);
  });
});

// --- the loader (Logs → DownloadActionsRunJobLogsWithID) ----------------------

describe("loadActionsRunJobLogs (view.go:1030 Logs + routers/common/actions.go)", () => {
  let repoId: string;

  beforeEach(async () => {
    repoId = await seedRepo();
  });

  it("serves the raw stored bytes of a hot (chunked) log", async () => {
    const { runId, jobId } = await seedRun(repoId, 1);
    const taskId = await seedTask(jobId, repoId);
    const line = formatLog(new Date(1_700_000_000_000), "hello world");
    await seedChunks(taskId, [line, "2026-01-01T00:00:00.0000000Z second"]);

    const outcome = await loadActionsRunJobLogs(env.DB, env, repoId, String(runId), String(jobId));
    expect(outcome.outcome).toBe("serve");
    if (outcome.outcome !== "serve") return;
    const text = new TextDecoder().decode(outcome.bytes);
    expect(text).toBe(`${line}\n2026-01-01T00:00:00.0000000Z second\n`);
    expect(outcome.filename).toBe("ci-build-" + taskId + ".log");
  });

  it("resolves the 'latest' literal (getCurrentRunByPathParam's ID-only posture)", async () => {
    const { jobId } = await seedRun(repoId, 1);
    const taskId = await seedTask(jobId, repoId);
    await seedChunks(taskId, [formatLog(new Date(), "x")]);

    const outcome = await loadActionsRunJobLogs(env.DB, env, repoId, "latest", String(jobId));
    expect(outcome.outcome).toBe("serve");
  });

  it("serves the sealed R2 object for a log_in_storage task", async () => {
    const { runId, jobId } = await seedRun(repoId, 1);
    const filename = "alice/demo/ab/9.log";
    await seedTask(jobId, repoId, { logInStorage: true, logFilename: filename });
    const body = new TextEncoder().encode("sealed line\n");
    await env.REPO_PACKS.put(`actions/logs/${filename}`, body);

    const outcome = await loadActionsRunJobLogs(env.DB, env, repoId, String(runId), String(jobId));
    expect(outcome.outcome).toBe("serve");
    if (outcome.outcome !== "serve") return;
    expect(new TextDecoder().decode(outcome.bytes)).toBe("sealed line\n");
  });

  it("404s a missing run — junk and unknown ids both miss (the ID-only posture)", async () => {
    await seedRun(repoId, 1);
    expect((await loadActionsRunJobLogs(env.DB, env, repoId, "999999", "999999")).outcome).toBe("not-found");
    expect((await loadActionsRunJobLogs(env.DB, env, repoId, "junk", "1")).outcome).toBe("not-found");
  });

  it("throws (upstream's ServerError arm) for a job id outside the run", async () => {
    const { runId, jobId } = await seedRun(repoId, 1);
    const other = await seedRun(repoId, 2);
    await seedTask(jobId, repoId);
    const outcome = await loadActionsRunJobLogs(env.DB, env, repoId, String(runId), String(other.jobId));
    expect(outcome).toMatchObject({ outcome: "throw" });
    if (outcome.outcome === "throw") {
      expect(outcome.reason).toContain("not found for run");
    }
  });

  it("throws 'job not started' for an unclaimed job (EffectiveTaskID 0)", async () => {
    const { runId, jobId } = await seedRun(repoId, 1);
    const outcome = await loadActionsRunJobLogs(env.DB, env, repoId, String(runId), String(jobId));
    expect(outcome).toMatchObject({ outcome: "throw", reason: containing("job not started") });
  });

  it("throws 'logs have been cleaned up' for an expired task", async () => {
    const { runId, jobId } = await seedRun(repoId, 1);
    await seedTask(jobId, repoId, { logExpired: true });
    const outcome = await loadActionsRunJobLogs(env.DB, env, repoId, String(runId), String(jobId));
    expect(outcome).toMatchObject({
      outcome: "throw",
      reason: containing("logs have been cleaned up"),
    });
  });

  it("throws on a sealed log whose R2 object is gone (openTaskLogs' fs-miss arm)", async () => {
    const { runId, jobId } = await seedRun(repoId, 1);
    await seedTask(jobId, repoId, { logInStorage: true, logFilename: "alice/demo/ff/999.log" });
    const outcome = await loadActionsRunJobLogs(env.DB, env, repoId, String(runId), String(jobId));
    expect(outcome).toMatchObject({ outcome: "throw", reason: containing("unable to open task logs") });
  });

  it("ignores the legacy run-index spelling (the ID-only asymmetry: an index miss is the 404)", async () => {
    await seedRun(repoId, 1);
    // index 1 collides with the row-id space only coincidentally; a plain
    // index-shaped URL for a run whose row id is elsewhere misses.
    const outcome = await loadActionsRunJobLogs(env.DB, env, repoId, "424242", "1");
    expect(outcome.outcome).toBe("not-found");
  });
});
