/**
 * SPEC-0005 §5.1 unit tests for the issues data layer — real local D1 with
 * the generated migrations applied (beforeAll), tables reset per test.
 *
 * Concurrency cases run against workerd's D1, which serializes batched
 * writers per database exactly like production — that is the property the
 * §3.1 allocation and the §4.2 CAS semantics are built on.
 */

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  comments,
  issueLabels,
  issues,
  labels,
  repoCounters,
  repositories,
  PRStatus,
  releases,
  webhookDeliveries,
  webhooks,
} from "../db/schema";
import { CommentType } from "./comment-types";
import { IssueAlreadyChangedError, ReleaseAlreadyExistError } from "./errors";
import { ellipsisDisplayString, IssuesService, MAX_TITLE_DISPLAY_WIDTH } from "./service";
import { applyIssuesD1Migrations } from "./testing/apply-d1-migrations";
import { branchFilterAllows, emitWebhookDeliveries, webhookEventGroup, webhookHasEvent } from "./webhooks";

beforeAll(applyIssuesD1Migrations);

/** Tables this suite writes; repositories last (repo_counters carries its FK). */
const RESET_TABLES = [
  "webhook_deliveries",
  "webhooks",
  "releases",
  "comments",
  "issue_labels",
  "issues",
  "milestones",
  "labels",
  "pull_requests",
  "repo_counters",
  "repositories",
];

beforeEach(async () => {
  for (const table of RESET_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

let repoSeq = 0;

/** One repository row + its §3.1 counter row; returns the repo id. */
async function seedRepo(): Promise<string> {
  repoSeq += 1;
  const id = `r_test${repoSeq}`;
  await db()
    .insert(repositories)
    .values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace: "alice",
      slug: `repo${repoSeq}`,
      visibility: "public",
    })
    .returning()
    .all();
  await service().ensureRepoCounters(id);
  return id;
}

async function seedLabel(repoId: string, name = "bug"): Promise<number> {
  const rows = await db().insert(labels).values({ repoId, name }).returning({ id: labels.id }).all();
  const row = rows[0];
  if (row === undefined) throw new Error("label seed failed");
  return row.id;
}

async function repoRow(repoId: string) {
  const row = await db().select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (row === undefined) throw new Error("repo seed vanished");
  return row;
}

describe("§3.1/§4.1 number allocation", () => {
  it("gives 20 parallel creations a dense 1..20 permutation on one repo", async () => {
    const repoId = await seedRepo();
    const created = await Promise.all(
      Array.from({ length: 20 }, (_, i) => service().createIssue({ repoId, title: `issue ${i}` })),
    );

    const indexes = created.map((row) => row.index).sort((a, b) => a - b);
    expect(indexes).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(created.map((row) => row.id)).size).toBe(20);

    const repo = await repoRow(repoId);
    expect(repo.numIssues).toBe(20);
    const counter = await db().select().from(repoCounters).where(eq(repoCounters.repoId, repoId)).get();
    expect(counter?.issueIndex).toBe(20);
  });

  it("rolls the counter bump back when the insert fails — no gap", async () => {
    const repoId = await seedRepo();
    const svc = service();
    await svc.createIssue({ repoId, title: "one" });

    // Simulate a desynced counter: bumped state at 4 while index 5 is taken.
    await db().update(repoCounters).set({ issueIndex: 4 }).where(eq(repoCounters.repoId, repoId));
    await db().insert(issues).values({ repoId, index: 5, title: "ghost" }).returning().all();

    await expect(svc.createIssue({ repoId, title: "collides" })).rejects.toThrow(/UNIQUE constraint failed/);

    // The failed batch rolled its bump back: counter still 4, no new row.
    const counter = await db().select().from(repoCounters).where(eq(repoCounters.repoId, repoId)).get();
    expect(counter?.issueIndex).toBe(4);
    const indexes = (await db().select({ index: issues.index }).from(issues).where(eq(issues.repoId, repoId)).all())
      .map((row) => row.index)
      .sort((a, b) => a - b);
    expect(indexes).toEqual([1, 5]);

    // Repair (§3.1) re-syncs; creation resumes strictly above the taken index.
    expect(await svc.syncMaxIssueIndex(repoId, 5)).toBe(true);
    const next = await svc.createIssue({ repoId, title: "after repair" });
    expect(next.index).toBe(6);
  });

  it("never reuses an index after deletion (§2.2)", async () => {
    const repoId = await seedRepo();
    const svc = service();
    const a = await svc.createIssue({ repoId, title: "a" });
    await svc.createIssue({ repoId, title: "b" });
    await db().delete(issues).where(eq(issues.id, a.id)).run();

    const c = await svc.createIssue({ repoId, title: "c" });
    expect(c.index).toBe(3);
  });
});

describe("§4.2 close/reopen CAS", () => {
  it("a concurrent close race produces exactly one winner; the loser fully no-ops", async () => {
    const repoId = await seedRepo();
    const svc = service();
    const milestone = await svc.createMilestone({ repoId, name: "v1" });
    const labelId = await seedLabel(repoId);
    const issue = await svc.createIssue({
      repoId,
      title: "race",
      milestoneId: milestone.id,
      labelIds: [labelId],
    });
    const now = new Date();

    // Same explicit timestamp — the hardest case for the in-batch gating.
    const settled = await Promise.allSettled([
      svc.closeIssue(issue.id, { now }),
      svc.closeIssue(issue.id, { now }),
    ]);
    const losers = settled.filter((r) => r.status === "rejected");
    const winners = settled.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(IssueAlreadyChangedError);

    const after = await svc.getIssueById(issue.id);
    expect(after?.isClosed).toBe(true);
    expect(after?.numComments).toBe(1); // one close comment — not two

    const commentRows = await db().select().from(comments).where(eq(comments.issueId, issue.id)).all();
    expect(commentRows).toHaveLength(1);
    expect(commentRows[0]?.type).toBe(CommentType.Close);

    expect((await repoRow(repoId)).numClosedIssues).toBe(1);
    const ms = await svc.getMilestone(milestone.id);
    expect(ms?.numClosedIssues).toBe(1);
    expect(ms?.completeness).toBe(100);
    const label = await db().select().from(labels).where(eq(labels.id, labelId)).get();
    expect(label?.numClosedIssues).toBe(1);
  });

  it("reopen unwinds counters, writes the type-1 comment, and loses the second reopen", async () => {
    const repoId = await seedRepo();
    const svc = service();
    const labelId = await seedLabel(repoId);
    const issue = await svc.createIssue({ repoId, title: "cycle", labelIds: [labelId] });

    await svc.closeIssue(issue.id);
    const reopened = await svc.reopenIssue(issue.id);
    expect(reopened.isClosed).toBe(false);
    expect(reopened.closedAt).toBeNull();
    expect(reopened.numComments).toBe(2); // close + reopen comments

    const commentTypes = (await db().select({ type: comments.type }).from(comments).where(eq(comments.issueId, issue.id)).all())
      .map((row) => row.type)
      .sort((a, b) => a - b);
    expect(commentTypes).toEqual([CommentType.Reopen, CommentType.Close]);

    expect((await repoRow(repoId)).numClosedIssues).toBe(0);
    const label = await db().select().from(labels).where(eq(labels.id, labelId)).get();
    expect(label?.numClosedIssues).toBe(0);

    await expect(svc.reopenIssue(issue.id)).rejects.toBeInstanceOf(IssueAlreadyChangedError);
  });

  it("closing a PR moves num_closed_pulls, not num_closed_issues", async () => {
    const repoId = await seedRepo();
    const svc = service();
    const { issue } = await svc.createPullRequest({
      repoId,
      title: "pr",
      headRepoId: repoId,
      headBranch: "feature",
      baseBranch: "main",
    });
    await svc.closeIssue(issue.id);
    const repo = await repoRow(repoId);
    expect(repo.numClosedPulls).toBe(1);
    expect(repo.numClosedIssues).toBe(0);
  });
});

describe("comments", () => {
  it("addComment lands the row and the num_comments increment in one batch", async () => {
    const repoId = await seedRepo();
    const issue = await service().createIssue({ repoId, title: "commented" });

    const first = await service().addComment({ issueId: issue.id, posterId: 11, content: "first" });
    const second = await service().addComment({ issueId: issue.id, posterId: 12, content: "second" });

    const after = await service().getIssueById(issue.id);
    expect(after?.numComments).toBe(2);
    const rows = await db().select().from(comments).where(eq(comments.issueId, issue.id)).all();
    expect(rows.map((row) => row.content).sort()).toEqual(["first", "second"]);
    expect(rows.every((row) => row.type === CommentType.Comment)).toBe(true);
    expect(first.posterId).toBe(11);
    expect(second.type).toBe(CommentType.Comment);
  });
});

describe("PRs share the issue counter (§2.2)", () => {
  it("issue → PR → issue draws 1, 2, 3 from one sequence", async () => {
    const repoId = await seedRepo();
    const svc = service();

    const first = await svc.createIssue({ repoId, title: "issue one" });
    expect(first.index).toBe(1);

    const { issue, pullRequest } = await svc.createPullRequest({
      repoId,
      title: "the pull request",
      headRepoId: repoId,
      headBranch: "feature",
      baseBranch: "main",
    });
    expect(issue.index).toBe(2);
    expect(issue.isPull).toBe(true);
    expect(pullRequest.issueId).toBe(issue.id);
    expect(pullRequest.index).toBe(2);
    expect(pullRequest.status).toBe(PRStatus.Checking);
    expect(pullRequest.headBranch).toBe("feature");
    expect(pullRequest.baseBranch).toBe("main");

    const third = await svc.createIssue({ repoId, title: "issue two" });
    expect(third.index).toBe(3);

    const repo = await repoRow(repoId);
    expect(repo.numIssues).toBe(2);
    expect(repo.numPulls).toBe(1);
    const prRows = await db().select().from(issueLabels).all();
    expect(prRows).toHaveLength(0);
  });
});

describe("releases (§2.3, §4.11)", () => {
  it("maps a duplicate (repo, tag) to ErrReleaseAlreadyExist → 409", async () => {
    const repoId = await seedRepo();
    const svc = service();
    await svc.createRelease({ repoId, publisherId: 1, tagName: "v1.0.0", title: "one" });

    let caught: unknown;
    try {
      await svc.createRelease({ repoId, publisherId: 1, tagName: "v1.0.0" });
      expect.unreachable();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReleaseAlreadyExistError);
    expect((caught as ReleaseAlreadyExistError).message).toBe("release tag already exist [tag_name: v1.0.0]");
    expect((caught as ReleaseAlreadyExistError).status).toBe(409);

    // The same tag on a different repo is fine; case-insensitive twin rows
    // are distinct (lower_tag_name only backs lookup).
    const otherRepo = await seedRepo();
    await expect(svc.createRelease({ repoId: otherRepo, publisherId: 1, tagName: "v1.0.0" })).resolves.toMatchObject({
      tagName: "v1.0.0",
      lowerTagName: "v1.0.0",
    });
  });

  it("drafts store published_unix = 0; published releases get the publish time", async () => {
    const repoId = await seedRepo();
    const svc = service();
    const now = new Date("2026-10-24T00:00:00Z");
    const draft = await svc.createRelease({ repoId, publisherId: 1, tagName: "draft", isDraft: true, now });
    expect(draft.publishedUnix).toBe(0);
    const published = await svc.createRelease({ repoId, publisherId: 1, tagName: "v2", now });
    expect(published.publishedUnix).toBe(Math.floor(now.getTime() / 1000));
    const rows = await db().select().from(releases).where(eq(releases.repoId, repoId)).all();
    expect(rows).toHaveLength(2);
  });

  it("converts a tag-only record instead of conflicting (§2.3)", async () => {
    const repoId = await seedRepo();
    const svc = service();
    await svc.createRelease({ repoId, publisherId: 1, tagName: "v3", isTag: true, title: "" });
    const converted = await svc.createRelease({ repoId, publisherId: 1, tagName: "v3", title: "now a release" });
    expect(converted.isTag).toBe(false);
    expect(converted.title).toBe("now a release");
    const rows = await db().select().from(releases).where(eq(releases.repoId, repoId)).all();
    expect(rows).toHaveLength(1);
  });
});

describe("milestones (§3.2 basics)", () => {
  it("create updates num_milestones; close stamps closed_date and completeness; delete unlinks issues", async () => {
    const repoId = await seedRepo();
    const svc = service();
    const ms = await svc.createMilestone({ repoId, name: "m1" });
    expect((await repoRow(repoId)).numMilestones).toBe(1);

    const issue = await svc.createIssue({ repoId, title: "on milestone", milestoneId: ms.id });
    let stored = await svc.getMilestone(ms.id);
    expect(stored?.numIssues).toBe(1);
    expect(stored?.completeness).toBe(0);

    await svc.closeIssue(issue.id);
    stored = await svc.getMilestone(ms.id);
    expect(stored?.numClosedIssues).toBe(1);
    expect(stored?.completeness).toBe(100);

    const closed = await svc.updateMilestone(ms.id, { state: "closed" });
    expect(closed.isClosed).toBe(true);
    expect(closed.closedDateAt).not.toBeNull();

    expect(await svc.deleteMilestone(ms.id)).toBe(true);
    expect(await svc.getMilestone(ms.id)).toBeNull();
    const unlinked = await svc.getIssueById(issue.id);
    expect(unlinked?.milestoneId).toBeNull();
    expect((await repoRow(repoId)).numMilestones).toBe(0);
  });

  it("rejects a milestone from another repo at issue creation", async () => {
    const repoA = await seedRepo();
    const repoB = await seedRepo();
    const ms = await service().createMilestone({ repoId: repoA, name: "foreign" });
    await expect(service().createIssue({ repoId: repoB, title: "x", milestoneId: ms.id })).rejects.toThrow(
      /milestone does not exist/,
    );
  });
});

describe("labels (§3.2 counters)", () => {
  it("setLabel is idempotent and counts once; replaceLabels diffs with closed-state awareness", async () => {
    const repoId = await seedRepo();
    const svc = service();
    const bug = await seedLabel(repoId, "bug");
    const ui = await seedLabel(repoId, "ui");
    const issue = await svc.createIssue({ repoId, title: "labelled" });

    expect(await svc.setLabel(issue.id, bug)).toBe(true);
    expect(await svc.setLabel(issue.id, bug)).toBe(false);
    const label = await db().select().from(labels).where(eq(labels.id, bug)).get();
    expect(label?.numIssues).toBe(1);

    await svc.closeIssue(issue.id);
    const replaced = await svc.replaceLabels(issue.id, [ui]);
    expect(replaced).toEqual({ added: [ui], removed: [bug] });

    const bugRow = await db().select().from(labels).where(eq(labels.id, bug)).get();
    expect(bugRow?.numIssues).toBe(0);
    expect(bugRow?.numClosedIssues).toBe(0);
    const uiRow = await db().select().from(labels).where(eq(labels.id, ui)).get();
    expect(uiRow?.numIssues).toBe(1);
    expect(uiRow?.numClosedIssues).toBe(1);
  });

  it("rejects labels of another repo (§3.2 drop rule)", async () => {
    const repoA = await seedRepo();
    const repoB = await seedRepo();
    const foreign = await seedLabel(repoA, "foreign");
    const issue = await service().createIssue({ repoId: repoB, title: "x" });
    await expect(service().setLabel(issue.id, foreign)).rejects.toThrow(/label does not exist/);
  });
});

describe("title truncation (§2.2)", () => {
  it("EllipsisDisplayString port: 255 display-width cap, ellipsis suffix", () => {
    const truncated = ellipsisDisplayString("a".repeat(300), MAX_TITLE_DISPLAY_WIDTH);
    expect(Array.from(truncated)).toHaveLength(255);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.startsWith("a".repeat(100))).toBe(true);
    expect(ellipsisDisplayString("short", MAX_TITLE_DISPLAY_WIDTH)).toBe("short");
    // Non-ASCII counts as width 2; upstream's guarantee is that the result
    // never EXCEEDS the limit runes (CJK truncates to fewer runes).
    const cjk = ellipsisDisplayString("漢".repeat(300), MAX_TITLE_DISPLAY_WIDTH);
    expect(Array.from(cjk)).toHaveLength(128);
    expect(Array.from(cjk).length).toBeLessThanOrEqual(MAX_TITLE_DISPLAY_WIDTH);
  });

  it("createIssue stores the truncated title", async () => {
    const repoId = await seedRepo();
    const issue = await service().createIssue({ repoId, title: "t".repeat(300) });
    expect(Array.from(issue.title)).toHaveLength(255);
  });
});

describe("webhook fan-out (§3.5)", () => {
  it("writes one pending delivery per matching hook (repo ∪ owner ∪ system, active only)", async () => {
    const repoId = await seedRepo();
    await db()
      .insert(webhooks)
      .values([
        { repoId, url: "https://a.example", events: JSON.stringify({ send_everything: true }), isActive: true },
        { repoId, url: "https://b.example", events: JSON.stringify({ choose_events: true, events: { issues: true } }), isActive: true },
        { repoId, url: "https://c.example", events: JSON.stringify({ choose_events: true, events: { push: true } }), isActive: true },
        { repoId, url: "https://d.example", events: JSON.stringify({ send_everything: true }), isActive: false },
        { ownerId: 7, url: "https://e.example", events: JSON.stringify({ send_everything: true }), isActive: true },
        { isSystemWebhook: true, url: "https://f.example", events: JSON.stringify({ send_everything: true }), isActive: true },
      ])
      .returning()
      .all();

    const payload = { action: "opened", number: 1 };
    const result = await emitWebhookDeliveries(env.DB, {
      repoId,
      ownerId: 7,
      eventType: "issues",
      payload,
    });

    expect(result.deliveryIds).toHaveLength(4); // a, b, e, f
    const rows = await db().select().from(webhookDeliveries).all();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.state).toBe("pending");
      expect(row.eventType).toBe("issues");
      expect(row.eventGroup).toBe("issues");
      expect(row.uuid).toMatch(/[0-9a-f-]{36}/);
    }
    // §2.7 byte shape: 2-space pretty-print, serialized once per event.
    const expected = JSON.stringify(payload, null, 2);
    expect(rows.every((row) => row.payloadContent === expected)).toBe(true);
    expect(expected).toContain('  "action": "opened"');
  });

  it("enqueues through the optional producer callback (§3.5 step 4)", async () => {
    const repoId = await seedRepo();
    await db()
      .insert(webhooks)
      .values({ repoId, url: "https://a.example", events: JSON.stringify({ send_everything: true }), isActive: true })
      .returning()
      .all();
    const enqueued: number[][] = [];
    const result = await emitWebhookDeliveries(env.DB, { repoId, eventType: "release", payload: {} }, {
      enqueue: (ids) => {
        enqueued.push(ids);
      },
    });
    expect(enqueued).toEqual([result.deliveryIds]);
    expect(result.deliveryIds).toHaveLength(1);
  });

  it("branch filter gates ref-carrying events (push), not issue events", async () => {
    const repoId = await seedRepo();
    await db()
      .insert(webhooks)
      .values({
        repoId,
        url: "https://a.example",
        events: JSON.stringify({ send_everything: true, branch_filter: "release/*" }),
        isActive: true,
      })
      .returning()
      .all();

    const suppressed = await emitWebhookDeliveries(env.DB, {
      repoId,
      eventType: "push",
      payload: {},
      refName: "feature/x",
    });
    expect(suppressed.deliveryIds).toHaveLength(0);

    const delivered = await emitWebhookDeliveries(env.DB, {
      repoId,
      eventType: "push",
      payload: {},
      refName: "release/1.0",
    });
    expect(delivered.deliveryIds).toHaveLength(1);

    // No ref on the payload (issues etc.) — the filter has no effect.
    const unfiltered = await emitWebhookDeliveries(env.DB, { repoId, eventType: "issues", payload: {} });
    expect(unfiltered.deliveryIds).toHaveLength(1);
  });

  it("event matching helpers mirror upstream HasEvent/Event()", () => {
    expect(webhookHasEvent({ send_everything: true }, "push")).toBe(true);
    expect(webhookHasEvent({ push_only: true }, "push")).toBe(true);
    expect(webhookHasEvent({ push_only: true }, "issues")).toBe(false);
    expect(webhookHasEvent({ events: { issues: true } }, "issues")).toBe(true);
    expect(webhookHasEvent({ events: { issues: true } }, "issue_comment")).toBe(false);
    // The three review events share the pull_request_review flag (§2.6).
    expect(webhookHasEvent({ events: { pull_request_review: true } }, "pull_request_review_approved")).toBe(true);

    expect(webhookEventGroup("issue_label")).toBe("issues");
    expect(webhookEventGroup("pull_request_sync")).toBe("pull_request");
    expect(webhookEventGroup("pull_request_comment")).toBe("issue_comment");
    expect(webhookEventGroup("release")).toBe("release");

    expect(branchFilterAllows(undefined, "any")).toBe(true);
    expect(branchFilterAllows("**", "any")).toBe(true);
    expect(branchFilterAllows("main", "refs/heads/main")).toBe(true);
    expect(branchFilterAllows("main", "refs/heads/mainx")).toBe(false);
    expect(branchFilterAllows("refs/tags/v*", "refs/tags/v1")).toBe(true);
  });
});

describe("repo counter bootstrap", () => {
  it("ensureRepoCounters is idempotent and createIssue self-heals a missing row", async () => {
    const repoId = await seedRepo();
    await service().ensureRepoCounters(repoId);
    const counter = await db().select().from(repoCounters).where(eq(repoCounters.repoId, repoId)).get();
    expect(counter?.issueIndex).toBe(0);

    // A repo whose counter row was dropped still allocates correctly.
    await db().delete(repoCounters).where(eq(repoCounters.repoId, repoId)).run();
    const issue = await service().createIssue({ repoId, title: "self-healed" });
    expect(issue.index).toBe(1);
  });

  it("creating an issue for a missing repository fails cleanly", async () => {
    await expect(service().createIssue({ repoId: "r_missing", title: "x" })).rejects.toThrow();
    const rows = await db().select().from(issues).all();
    expect(rows).toHaveLength(0);
  });
});
