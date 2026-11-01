/**
 * The pull auto-merge service's tests (services/pull-automerge.ts — the MWCS
 * schedule's consumer, migration 0059's `pull_auto_merges`): the consumer
 * ladder driven DIRECTLY over real D1 + the real engine cells (the
 * pull-merge-box write-arm harness shape — landCommit/landPullRef against
 * the RepoCell), plus the cron producer's enqueue and the purge dispatch's
 * ack wiring.
 *
 * The mission matrix:
 *   - schedule → RED stays: the required check pending → the row SURVIVES
 *     the check (upstream's errSkipAutoMerge);
 *   - green merges: the required check success → the row is consumed, the
 *     PR merged (the landed mergePullRequest with the row's
 *     style/message), the issue closed with the merge_pull comment;
 *   - closed/merged rows delete; a missing row is the not-scheduled arm;
 *   - the producer enqueues one message per scheduled row (and zero for an
 *     empty table) through a recording queue spy (the demo-sweep shape).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { createCommitStatus } from "../api/services/commit-status";
import { findPullRequestByIndex } from "../api/services/pulls";
import { ZERO_OID, branchRef, pullHeadRef } from "../api/services/engine";
import { comments, PRStatus, protectedBranches, pullAutoMerges, pullRequests, users } from "../db/schema";
import { IssuesService } from "../issues/service";
import { CommentType } from "../issues/comment-types";
import { emptyRuleConfig, serializeRuleConfig } from "./branch-protection";
import { RepoService } from "../repos/service";
import { handleRepoTasks } from "../repos/purge";
import {
  deleteScheduledAutoMerge,
  enqueueDueAutoMergeChecks,
  getScheduledAutoMerge,
  handleAutoMergeCheck,
  scheduleAutoMergeRow,
} from "./pull-automerge";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000;

const alice = { kind: "user", id: 201, username: "alice", isAdmin: false } as const;

let repoId = "";
const prIds: Record<string, number> = {};
const issueIds: Record<string, number> = {};
let rootOid = "";
let headOid = "";

function d1(): ReturnType<typeof drizzle> {
  return drizzle(env.DB);
}

async function gitObjectOid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function landCommit(
  ref: string,
  input: { parents: string[]; message: string; fileName: string; content: string },
): Promise<string> {
  const cell = env.REPO.getByName("alice/amrepo");
  const blob = new TextEncoder().encode(input.content);
  const blobOid = await gitObjectOid("blob", blob);
  const tree = serializeTree([{ mode: "100644", name: input.fileName, oid: blobOid }]);
  const person = { name: "seed", email: "seed@amrepo.invalid", time: T0, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: input.parents, author: person, committer: person, message: `${input.message}\n` });
  const put = await cell.putApiObjects([
    { oid: blobOid, type: "blob", data: blob },
    { oid: tree.oid, type: "tree", data: tree.data },
    { oid: commit.oid, type: "commit", data: commit.data },
  ]);
  if (put.tag !== "ok") throw new Error(`seed putApiObjects failed: ${put.tag}`);
  const landed = await cell.commitApiChange({ ref, expectedOldOid: ZERO_OID, newOid: commit.oid });
  if (landed.tag !== "committed") throw new Error(`seed ref landing failed: ${ref} (${landed.tag})`);
  return commit.oid;
}

/** Seed one mergeable PR (real pull ref + head sha) and schedule it. */
async function seedScheduledPr(name: string, style: string, deleteBranch = false): Promise<number> {
  const service = new IssuesService(env.DB);
  const { issue, pullRequest } = await service.createPullRequest({
    repoId,
    title: `feat: ${name}`,
    posterId: alice.id,
    headRepoId: repoId,
    baseBranch: "main",
    headBranch: `${name}-branch`,
    now: new Date((T0 + 60) * 1000),
  });
  prIds[name] = pullRequest.id;
  issueIds[name] = issue.id;
  await d1()
    .update(pullRequests)
    .set({ status: PRStatus.Mergeable, headSha: headOid })
    .where(eq(pullRequests.id, pullRequest.id));
  await env.REPO.getByName("alice/amrepo").commitApiChange({ ref: pullHeadRef(pullRequest.index), expectedOldOid: ZERO_OID, newOid: headOid });
  await env.REPO.getByName("alice/amrepo").commitApiChange({ ref: branchRef(`${name}-branch`), expectedOldOid: ZERO_OID, newOid: headOid });
  // The schedule itself (the row the web arm would have written).
  await scheduleAutoMergeRow(env.DB, {
    issueId: issue.id,
    doerId: alice.id,
    sha: headOid,
    style,
    message: `feat: ${name} (#${pullRequest.index})`,
    deleteBranchAfterMerge: deleteBranch,
  }, new Date((T0 + 61) * 1000));
  return pullRequest.index;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
  await d1().insert(users).values([
    { id: alice.id, username: "alice", usernameLower: "alice", displayName: "Alice Doe", createdAt: new Date(T0 * 1000) },
  ]);
  const repo = await new RepoService(env.DB).create({
    owner: { id: alice.id, usernameLower: "alice" },
    name: "amrepo",
    isPrivate: false,
    status: "ready",
  });
  repoId = repo.id;
  // The rule: one required context (ci/build) — the schedule waits on it.
  await d1().insert(protectedBranches).values({
    repoId,
    ruleName: "main",
    priority: 0,
    rules: serializeRuleConfig({ ...emptyRuleConfig(), enableStatusCheck: true, statusCheckContexts: ["ci/build"] }),
    createdAt: new Date(T0 * 1000),
    updatedAt: new Date(T0 * 1000),
  });
  rootOid = await landCommit(branchRef("main"), { parents: [], message: "root", fileName: "README.md", content: "# amrepo\n" });
  headOid = await landCommit(branchRef("checks-branch"), { parents: [rootOid], message: "work", fileName: "feat.ts", content: "export {}\n" });
  await env.REPO.getByName("alice/amrepo").setHead("main");
});

// --- the consumer ladder -------------------------------------------------------

describe("handleAutoMergeCheck (the consume-time ladder)", () => {
  it("answers not-scheduled without a row", async () => {
    expect(await handleAutoMergeCheck(env, 4_000_001)).toBe("not-scheduled");
  });

  it("keeps the row scheduled while the required check is red", async () => {
    const index = await seedScheduledPr("redpr", "merge");
    const found = (await findPullRequestByIndex(env.DB, repoId, index))!;
    // No statuses yet — the required context is pending.
    expect(await handleAutoMergeCheck(env, found.issue.id)).toBe("skipped-status-checks");
    // A FAILING required check keeps it waiting too.
    await createCommitStatus(env.DB, {
      repoId,
      sha: headOid,
      state: "failure",
      targetUrl: "",
      description: "build broke",
      context: "ci/build",
      creatorId: alice.id,
    });
    expect(await handleAutoMergeCheck(env, found.issue.id)).toBe("skipped-status-checks");
    expect(await getScheduledAutoMerge(env.DB, found.issue.id)).not.toBeNull();
    expect(found.pullRequest.hasMerged).toBe(false);
  });

  it("merges when the required check goes green and consumes the row", async () => {
    const index = await seedScheduledPr("greenpr", "squash");
    const found = (await findPullRequestByIndex(env.DB, repoId, index))!;
    await createCommitStatus(env.DB, {
      repoId,
      sha: headOid,
      state: "success",
      targetUrl: "https://ci.example.com/build/2",
      description: "build ok",
      context: "ci/build",
      creatorId: alice.id,
    });
    expect(await handleAutoMergeCheck(env, found.issue.id)).toBe("merged");
    // The row is consumed; the PR is merged with the row's style; the issue
    // closed with the merge_pull system comment.
    expect(await getScheduledAutoMerge(env.DB, found.issue.id)).toBeNull();
    const after = (await findPullRequestByIndex(env.DB, repoId, index))!;
    expect(after.pullRequest.hasMerged).toBe(true);
    expect(after.pullRequest.mergedCommitId).not.toBeNull();
    expect(after.issue.isClosed).toBe(true);
    const rows = await d1().select().from(comments).where(eq(comments.issueId, found.issue.id)).all();
    expect(rows.some((row) => row.type === CommentType.MergePull)).toBe(true);
  });

  it("deletes the schedule of a closed PR and answers not-mergeable for a conflicted one", async () => {
    // Closed with a live schedule → the row goes (upstream's first arm).
    const closedIndex = await seedScheduledPr("closedpr", "merge");
    const closed = (await findPullRequestByIndex(env.DB, repoId, closedIndex))!;
    await new IssuesService(env.DB).closeIssue(closed.issue.id, { actorId: alice.id, now: new Date((T0 + 120) * 1000) });
    expect(await handleAutoMergeCheck(env, closed.issue.id)).toBe("deleted-closed-or-merged");
    expect(await getScheduledAutoMerge(env.DB, closed.issue.id)).toBeNull();

    // A conflicted PR (the stored quick check) → skip, row stays.
    const conflictIndex = await seedScheduledPr("conflictdpr", "merge");
    const conflicted = (await findPullRequestByIndex(env.DB, repoId, conflictIndex))!;
    await d1().update(pullRequests).set({ status: PRStatus.Conflict }).where(eq(pullRequests.id, conflicted.pullRequest.id));
    expect(await handleAutoMergeCheck(env, conflicted.issue.id)).toBe("skipped-not-mergeable");
    expect(await getScheduledAutoMerge(env.DB, conflicted.issue.id)).not.toBeNull();
  });

  it("skips on a missing head branch without consuming the row", async () => {
    const index = await seedScheduledPr("nobranch", "merge");
    const found = (await findPullRequestByIndex(env.DB, repoId, index))!;
    // The PR's head branch never existed in git (only the pull ref did).
    await d1().update(pullRequests).set({ headBranch: "ghost-branch" }).where(eq(pullRequests.id, found.pullRequest.id));
    expect(await handleAutoMergeCheck(env, found.issue.id)).toBe("skipped-head-branch-missing");
    expect(await getScheduledAutoMerge(env.DB, found.issue.id)).not.toBeNull();
  });

  it("drops a schedule whose PR row vanished", async () => {
    const index = await seedScheduledPr("vanished", "merge");
    const found = (await findPullRequestByIndex(env.DB, repoId, index))!;
    await d1().delete(pullRequests).where(eq(pullRequests.id, found.pullRequest.id));
    expect(await handleAutoMergeCheck(env, found.issue.id)).toBe("deleted-closed-or-merged");
    expect(await getScheduledAutoMerge(env.DB, found.issue.id)).toBeNull();
  });
});

// --- the producer ---------------------------------------------------------------

/** Recording Queue — the demo-sweep spy shape (sendBatch bodies captured). */
function spyQueue(): Queue & { bodies: unknown[][] } {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue = {
    bodies: [] as unknown[][],
    send: (body: unknown) => {
      queue.bodies.push([body]);
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: MessageSendRequest[]) => {
      queue.bodies.push(messages.map((message) => message.body));
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve(metadata.metrics),
  };
  return queue;
}

describe("enqueueDueAutoMergeChecks (the cron producer)", () => {
  it("enqueues one check per scheduled row and nothing for an empty table", async () => {
    const queue = spyQueue();
    const producerEnv: Partial<Pick<Env, "DB" | "REPO_TASKS">> = { DB: env.DB, REPO_TASKS: queue };
    // A live row (the conflicted PR's schedule still stands).
    const before = await enqueueDueAutoMergeChecks(producerEnv, {});
    expect(before).toBeGreaterThanOrEqual(1);
    const flat = queue.bodies.flat() as { kind: string; issueId: number }[];
    expect(flat.every((message) => message.kind === "auto-merge-check")).toBe(true);
    expect(flat.some((message) => message.issueId === issueIds.conflictdpr)).toBe(true);
    // Empty table → zero sends (the quiet-tick probe).
    const rows = await d1().select().from(pullAutoMerges).all();
    for (const row of rows) await deleteScheduledAutoMerge(env.DB, row.issueId);
    const after = await enqueueDueAutoMergeChecks(producerEnv, {});
    expect(after).toBe(0);
    expect(queue.bodies.length).toBe(1); // no NEW batch since the first
  });
});

// --- the purge dispatch wiring ---------------------------------------------------

/** Fabricated MessageBatch with ack/retry recorders (purge.test.ts shape). */
function fabricatedBatch(bodies: { id: string; body: unknown }[]) {
  const acked: string[] = [];
  const retried: string[] = [];
  const batch = {
    queue: "repo-tasks",
    messages: bodies.map(({ id, body }) => ({
      id,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => {
        acked.push(id);
      },
      retry: () => {
        retried.push(id);
      },
    })),
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    retryAll: () => {
      retried.push("all");
    },
    ackAll: () => {
      acked.push("all");
    },
  };
  return { batch, acked, retried };
}

describe("REPO_TASKS auto-merge-check dispatch", () => {
  it("routes the message through the ladder and acks (the not-scheduled arm)", async () => {
    const { batch, acked, retried } = fabricatedBatch([{ id: "am1", body: { kind: "auto-merge-check", issueId: 4_000_042 } }]);
    await handleRepoTasks(batch, env);
    expect(acked).toEqual(["am1"]);
    expect(retried).toEqual([]);
  });
});
