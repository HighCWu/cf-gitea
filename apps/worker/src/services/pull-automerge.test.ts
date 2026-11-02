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
 *   - an Empty PR schedules but never merges (the quick check is
 *     Mergeable-only) and an open dependency skips with the row kept until
 *     the blocker closes (check.go:219-222's consumer arm);
 *   - the expected-head gate (automerge.go:175-177): a post-schedule push
 *     skips with the row kept — the live ref must still be the scheduled
 *     sha, and the old sha's green statuses never merge the new head;
 *   - the status gate's flag-off rule passes even with stored contexts
 *     (commit_status.go:81-94) and pages past the newest 100 contexts
 *     (commit_status.go:144's ListOptionsAll);
 *   - the producer enqueues one message per scheduled row (and zero for an
 *     empty table) through a recording queue spy (the demo-sweep shape) and
 *     drains the WHOLE table — pages past any fixed limit.
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
import { comments, issueDependencies, PRStatus, protectedBranches, pullAutoMerges, pullRequests, users } from "../db/schema";
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
  isPullCommitStatusPass,
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

/** One CHILD commit on `branch` (parent = parentOid) with a single file — a
 *  tip DISTINCT from the shared headOid so a test's merge attempt is the
 *  first one of that content (the shared head gets squash-merged by the
 *  green-pr test, which would refuse a second merge of the same tree). */
async function landChildCommitOnBranch(branch: string, parentOid: string, fileName: string, content: string): Promise<string> {
  const cell = env.REPO.getByName("alice/amrepo");
  const blob = new TextEncoder().encode(content);
  const blobOid = await gitObjectOid("blob", blob);
  const tree = serializeTree([{ mode: "100644", name: fileName, oid: blobOid }]);
  const person = { name: "seed", email: "seed@amrepo.invalid", time: T0 + 200, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: [parentOid], author: person, committer: person, message: `${fileName}\n` });
  const put = await cell.putApiObjects([
    { oid: blobOid, type: "blob", data: blob },
    { oid: tree.oid, type: "tree", data: tree.data },
    { oid: commit.oid, type: "commit", data: commit.data },
  ]);
  if (put.tag !== "ok") throw new Error(`child putApiObjects failed: ${put.tag}`);
  const landed = await cell.commitApiChange({ ref: branchRef(branch), expectedOldOid: parentOid, newOid: commit.oid });
  if (landed.tag !== "committed") throw new Error(`child ref landing failed: ${branch} (${landed.tag})`);
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

  it("an Empty PR schedules but never auto-merges (the quick check is Mergeable-only, automerge.go:143-145)", async () => {
    const index = await seedScheduledPr("emptypr", "merge");
    const found = (await findPullRequestByIndex(env.DB, repoId, index))!;
    // EVERYTHING else green: the required check passes — an Empty row must
    // still never merge (models/issues/pull.go:446-448: IsStatusMergeable has
    // no Empty arm; the schedule accepted it via check.go:170-172).
    await createCommitStatus(env.DB, {
      repoId,
      sha: headOid,
      state: "success",
      targetUrl: "",
      description: "build ok",
      context: "ci/build",
      creatorId: alice.id,
    });
    await d1().update(pullRequests).set({ status: PRStatus.Empty }).where(eq(pullRequests.id, found.pullRequest.id));
    expect(await handleAutoMergeCheck(env, found.issue.id)).toBe("skipped-not-mergeable");
    expect(await getScheduledAutoMerge(env.DB, found.issue.id)).not.toBeNull();
    expect(found.pullRequest.hasMerged).toBe(false);
  });

  it("an open dependency skips the merge with the row kept (check.go:219-222); closing the blocker releases it", async () => {
    const index = await seedScheduledPr("blockedpr", "merge");
    const found = (await findPullRequestByIndex(env.DB, repoId, index))!;
    // A tip DISTINCT from the shared headOid (already squash-merged by the
    // green-pr test) so this test's merge arms are first-of-their-content.
    const tip = await landChildCommitOnBranch("blockedpr-branch", headOid, "blocked.ts", "// blocked work\n");
    await d1().update(pullRequests).set({ headSha: tip }).where(eq(pullRequests.id, found.pullRequest.id));
    await env.REPO.getByName("alice/amrepo").commitApiChange({ ref: pullHeadRef(found.pullRequest.index), expectedOldOid: headOid, newOid: tip });
    // The expected-head gate reads the LIVE ref against the SCHEDULED sha —
    // re-pin the schedule to the pushed tip (the re-schedule arm a real
    // push flow carries) so the dependency arm below is what's under test.
    await d1().update(pullAutoMerges).set({ sha: tip }).where(eq(pullAutoMerges.issueId, found.issue.id));
    await createCommitStatus(env.DB, {
      repoId,
      sha: tip,
      state: "success",
      targetUrl: "",
      description: "build ok",
      context: "ci/build",
      creatorId: alice.id,
    });
    const blocker = await new IssuesService(env.DB).createIssue({
      repoId,
      title: "blocker",
      content: null,
      posterId: alice.id,
      labelIds: [],
      milestoneId: null,
    });
    // The "blocked by" edge (issue_id = the scheduled PR's issue).
    await d1().insert(issueDependencies).values({ userId: alice.id, issueId: found.issue.id, dependencyId: blocker.id, createdAt: new Date((T0 + 130) * 1000) });
    expect(await handleAutoMergeCheck(env, found.issue.id)).toBe("skipped-dependencies");
    expect(await getScheduledAutoMerge(env.DB, found.issue.id)).not.toBeNull();
    expect(found.pullRequest.hasMerged).toBe(false);

    // The REVERSE edge never blocks: the PR BLOCKING another open issue is
    // the dependency_id side, and IssueNoDependenciesLeft reads only
    // issue_id = self — the release below merges WITH this edge standing.
    const downstream = await new IssuesService(env.DB).createIssue({
      repoId,
      title: "downstream",
      content: null,
      posterId: alice.id,
      labelIds: [],
      milestoneId: null,
    });
    await d1().insert(issueDependencies).values({ userId: alice.id, issueId: downstream.id, dependencyId: found.issue.id, createdAt: new Date((T0 + 131) * 1000) });

    // Closing the blocker releases the wait — the next tick merges.
    await new IssuesService(env.DB).closeIssue(blocker.id, { actorId: alice.id, now: new Date((T0 + 140) * 1000) });
    expect(await handleAutoMergeCheck(env, found.issue.id)).toBe("merged");
    expect(await getScheduledAutoMerge(env.DB, found.issue.id)).toBeNull();
  });

  it("a post-schedule push skips with the row kept — the live head left the scheduled sha (automerge.go:175-177)", async () => {
    const index = await seedScheduledPr("racepr", "merge");
    const found = (await findPullRequestByIndex(env.DB, repoId, index))!;
    // Green ci/build ONLY at the schedule-time sha (headOid) — the exact
    // state a just-landed push makes stale.
    await createCommitStatus(env.DB, {
      repoId,
      sha: headOid,
      state: "success",
      targetUrl: "",
      description: "build ok",
      context: "ci/build",
      creatorId: alice.id,
    });
    // The push lands AFTER the schedule: the refs move and the row re-arms
    // to `checking` (the push flow's re-arm posture — the Checking CAS in the
    // merge engine's push path).
    const racedOid = await landChildCommitOnBranch("racepr-branch", headOid, "race.ts", "// raced work\n");
    await env.REPO.getByName("alice/amrepo").commitApiChange({ ref: pullHeadRef(index), expectedOldOid: headOid, newOid: racedOid });
    await d1().update(pullRequests).set({ status: PRStatus.Checking }).where(eq(pullRequests.id, found.pullRequest.id));

    // Tick 1 on the checking row: the stored quick check waits (a checking
    // row is not IsStatusMergeable, automerge.go:143-145).
    expect(await handleAutoMergeCheck(env, found.issue.id)).toBe("skipped-not-mergeable");
    expect(await getScheduledAutoMerge(env.DB, found.issue.id)).not.toBeNull();

    // Tick 2 — the row settles Mergeable at the NEW sha: the expected-head
    // gate reads the LIVE ref (racedOid) against the SCHEDULED sha (headOid)
    // and skips BEFORE any status read — the old sha's green ci/build never
    // merges the pushed head, and the row stays scheduled (upstream's queue
    // item pins its sha; a fresh MWCS schedule re-arms the new head).
    await d1().update(pullRequests).set({ status: PRStatus.Mergeable, headSha: racedOid }).where(eq(pullRequests.id, found.pullRequest.id));
    expect(await handleAutoMergeCheck(env, found.issue.id)).toBe("skipped-head-sha-changed");
    expect(await getScheduledAutoMerge(env.DB, found.issue.id)).not.toBeNull();
    expect((await findPullRequestByIndex(env.DB, repoId, index))!.pullRequest.hasMerged).toBe(false);
  });

  it("drops a schedule whose PR row vanished", async () => {
    const index = await seedScheduledPr("vanished", "merge");
    const found = (await findPullRequestByIndex(env.DB, repoId, index))!;
    await d1().delete(pullRequests).where(eq(pullRequests.id, found.pullRequest.id));
    expect(await handleAutoMergeCheck(env, found.issue.id)).toBe("deleted-closed-or-merged");
    expect(await getScheduledAutoMerge(env.DB, found.issue.id)).toBeNull();
  });
});

// --- the required-context gate ---------------------------------------------------

describe("isPullCommitStatusPass (commit_status.go:73-101)", () => {
  it("the flag-off rule passes even with stored contexts (commit_status.go:81-94 — with no scoped source nothing else is in effect)", async () => {
    const sha = "c".repeat(40);
    const flagOff = { ...emptyRuleConfig(), enableStatusCheck: false, statusCheckContexts: ["ci/build"] };
    const flagOn = { ...emptyRuleConfig(), enableStatusCheck: true, statusCheckContexts: ["ci/build"] };
    // Red ci/build at the sha: the flag ON enforces it, the flag OFF passes.
    await createCommitStatus(env.DB, { repoId, sha, state: "failure", targetUrl: "", description: "build broke", context: "ci/build", creatorId: alice.id });
    expect(await isPullCommitStatusPass(env.DB, repoId, sha, flagOff)).toBe(true);
    expect(await isPullCommitStatusPass(env.DB, repoId, sha, flagOn)).toBe(false);
  });

  it("pages past the newest 100 contexts (commit_status.go:144's ListOptionsAll) — the oldest required context still gates", async () => {
    const sha = "d".repeat(40);
    const config = { ...emptyRuleConfig(), enableStatusCheck: true, statusCheckContexts: ["ctx-oldest"] };
    // The required context lands FIRST — 105 later contexts push it off the
    // newest-100 window; a capped read would answer pending forever.
    await createCommitStatus(env.DB, { repoId, sha, state: "success", targetUrl: "", description: "", context: "ctx-oldest", creatorId: alice.id });
    for (let i = 0; i < 105; i++) {
      await createCommitStatus(env.DB, { repoId, sha, state: "failure", targetUrl: "", description: "", context: `noise-${i}`, creatorId: alice.id });
    }
    expect(await isPullCommitStatusPass(env.DB, repoId, sha, config)).toBe(true);
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

  it("drains the WHOLE scheduled table each tick — pages past any fixed limit (no oldest-50 starvation)", async () => {
    const queue = spyQueue();
    const producerEnv: Partial<Pick<Env, "DB" | "REPO_TASKS">> = { DB: env.DB, REPO_TASKS: queue };
    // 120 synthetic rows (issueIds far from the fixtures'); pageSize 50
    // forces three pages — a capped read would enqueue exactly the oldest 50
    // every tick and starve the rest.
    const synthetic: number[] = [];
    for (let i = 0; i < 120; i++) {
      const issueId = 4_100_000 + i;
      synthetic.push(issueId);
      await d1().insert(pullAutoMerges).values({
        issueId,
        doerId: alice.id,
        sha: "a".repeat(40),
        mergeStyle: "merge",
        deleteBranchAfterMerge: false,
        mergeMessage: null,
        createdUnix: T0 + 500 + i,
      });
    }
    const count = await enqueueDueAutoMergeChecks(producerEnv, { pageSize: 50 });
    expect(count).toBe(120);
    const flat = queue.bodies.flat() as { kind: string; issueId: number }[];
    const seen = new Set(flat.map((message) => message.issueId));
    for (const issueId of synthetic) expect(seen.has(issueId)).toBe(true);
    // The oldest row leads (the keyset order, asc createdUnix).
    expect(flat[0]!.issueId).toBe(4_100_000);
    // Cleanup — the suite's other producers start from a drained table.
    for (const issueId of synthetic) await deleteScheduledAutoMerge(env.DB, issueId);
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
