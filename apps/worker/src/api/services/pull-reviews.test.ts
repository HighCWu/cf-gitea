/**
 * The pull-review write cores' unit arms (api/services/pull-reviews.ts —
 * the §14.6 extraction of routes/pull-reviews.ts's review-submission +
 * reviewer-request pipeline, specs/email-outbound.md).
 *
 * The ROUTE suite (api/routes/pull-reviews.test.ts) keeps the HTTP-level
 * pins UNCHANGED — that's the extraction's proof. These arms exercise the
 * SERVICE surface directly over real D1: the SubmitReview state machine
 * (fresh row vs pending conversion, ContentEmpty, the closed-PR gate, the
 * CreateReview side effects, the org team-request cleanup), the
 * reviewer-request pair (write / silent skip / closed-merged 403 / the
 * official-flag clear + restore quirk), and the mail seam's
 * threaded-but-silent posture (this wave emits no mail — the receivers ride
 * the next wave over the constructor's env, the IssuesService precedent).
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { CommentType } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import { ReviewType, comments, emailOutbox, issueUsers, issues, pullRequests, pullReviews, repositories, teamMembers, teams, users } from "../../db/schema";
import type { RepositoryWithOwner, UserRow } from "./repository";
import { ContentEmptyError, PullReviewsService, currentPendingReview, latestDecisionReview } from "./pull-reviews";

const T0 = new Date("2026-02-03T04:05:06Z");
const DOER = 1; // a plain user
const REVIEWER = 2; // a plain user (bob)
const OWNER = 4; // alice — the user-owned repos' owner row
const ORG = 5; // the org-owned repo's owner row

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "pull_reviews",
    "comments",
    "email_outbox",
    "issue_user",
    "team_members",
    "teams",
    "issue_labels",
    "pull_requests",
    "issues",
    "milestones",
    "labels",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const [id, username, isAdmin, type] of [
    [DOER, "doer", 0, "user"],
    [REVIEWER, "bob", 0, "user"],
    [3, "chief", 1, "user"],
    [OWNER, "alice", 0, "user"],
    [ORG, "org", 0, "org"],
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, is_admin, type, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', 0)",
    )
      .bind(id, username, username, isAdmin, type)
      .run();
  }
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);
const bare = () => new PullReviewsService(env.DB); // the no-env posture (today's callers)

/** Recording Queue — counts sends AND captures every body (the notify
 *  suite's shape; the armed seam's REPO_TASKS). */
function spyQueue(): Queue & { sends: number; sendBodies: unknown[] } {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue = {
    sends: 0,
    sendBodies: [] as unknown[],
    send: (body: unknown) => {
      queue.sends += 1;
      queue.sendBodies.push(body);
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: MessageSendRequest[]) => {
      queue.sends += messages.length;
      for (const m of messages) queue.sendBodies.push(m.body);
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve(metadata.metrics),
  };
  return queue;
}
const armed = () =>
  // The route posture (`new PullReviewsService(c.env.DB, c.env)` with the
  // MAIL_* vars armed) — the seam's env, the §14.6 receivers LIVE over it.
  new PullReviewsService(env.DB, {
    DB: env.DB,
    REPO_TASKS: spyQueue(),
    APP_URL: "https://mail.example",
    MAIL_ENABLED: "true",
    MAIL_FROM: "gitea@tests.invalid",
  });

let repoSeq = 4200;

async function seedRepo(ownerId: number): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: "alice",
    ownerId,
    slug: "visible",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: T0,
  });
  await service().ensureRepoCounters(id);
  return id;
}

async function foundOf(repoId: string): Promise<RepositoryWithOwner> {
  const repo = (await db().select().from(repositories).where(eq(repositories.id, repoId)).all())[0]!;
  const ownerId = repo.ownerId;
  if (ownerId === null) throw new Error(`seed repo ${repoId} has no owner`);
  const owner = (await db().select().from(users).where(eq(users.id, ownerId)).all())[0]!;
  return { repo, owner };
}

/** One open PR (poster bob) — the cores' issue/pullRequest inputs. */
async function seedPull(repoId: string, options: { closed?: boolean; merged?: boolean } = {}) {
  const { issue, pullRequest } = await service().createPullRequest({
    repoId,
    title: "reviewable change",
    posterId: REVIEWER,
    headRepoId: repoId,
    baseBranch: "main",
    headBranch: "feature",
  });
  if (options.closed === true) {
    await service().closeIssue(issue.id, { actorId: REVIEWER });
  }
  if (options.merged === true) {
    await db().update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.id, pullRequest.id));
  }
  return { issue, pullRequest };
}

async function reviewRows(issueId: number): Promise<Array<typeof pullReviews.$inferSelect>> {
  return db().select().from(pullReviews).where(eq(pullReviews.issueId, issueId)).all();
}

async function commentRows(issueId: number): Promise<Array<typeof comments.$inferSelect>> {
  return db().select().from(comments).where(eq(comments.issueId, issueId)).all();
}

async function numCommentsOf(issueId: number): Promise<number> {
  return (await db().select().from(issues).where(eq(issues.id, issueId)).all())[0]!.numComments;
}

async function userRow(id: number): Promise<UserRow> {
  return (await db().select().from(users).where(eq(users.id, id)).all())[0]!;
}

// ---------------------------------------------------------------------------
// submitReview — the SubmitReview port (models/issues/review.go:467–584)
// ---------------------------------------------------------------------------

describe("PullReviewsService.submitReview", () => {
  it("creates a fresh COMMENT review, lands the type-22 comment, bumps num_comments", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue } = await seedPull(repoId);
    const found = await foundOf(repoId);

    const review = await bare().submitReview(found, {
      doerId: DOER,
      doerRow: await userRow(DOER),
      issue,
      baseBranch: "main",
      reviewType: ReviewType.Comment,
      content: "looks fine overall",
      commitId: "abc123",
    });

    expect(review.type).toBe(ReviewType.Comment);
    expect(review.content).toBe("looks fine overall");
    expect(review.official).toBe(false);
    expect(review.dismissed).toBe(false);
    const rows = await reviewRows(issue.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(review.id);
    const sys = await commentRows(issue.id);
    expect(sys).toHaveLength(1);
    expect(sys[0]!.type).toBe(CommentType.Review);
    expect(sys[0]!.posterId).toBe(DOER);
    expect(sys[0]!.reviewId).toBe(review.id);
    expect(sys[0]!.content).toBe("looks fine overall");
    expect(await numCommentsOf(issue.id)).toBe(1);
  });

  it("422 ContentEmpty on a body-less non-approve submit with no pending review", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue } = await seedPull(repoId);
    const found = await foundOf(repoId);

    await expect(
      bare().submitReview(found, {
        doerId: DOER,
        doerRow: await userRow(DOER),
        issue,
        baseBranch: "main",
        reviewType: ReviewType.Comment,
        content: "   ",
        commitId: "abc123",
      }),
    ).rejects.toThrow(ContentEmptyError);
    // The wire error shape is the routes' 422 (ContentEmptyErr, review.go:455–465).
    await expect(
      bare().submitReview(found, {
        doerId: DOER,
        doerRow: await userRow(DOER),
        issue,
        baseBranch: "main",
        reviewType: ReviewType.Comment,
        content: "",
        commitId: "abc123",
      }),
    ).rejects.toMatchObject({ status: 422, message: "review requires a body or a comment" });
    expect(await reviewRows(issue.id)).toHaveLength(0);
  });

  it("422s approve/reject on a closed PR — the comment arm stays legal", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue } = await seedPull(repoId, { closed: true });
    // The core takes the CURRENT row (the route re-reads it per request) —
    // re-read past the seed's close so isClosed is the live state.
    const closedIssue = (await db().select().from(issues).where(eq(issues.id, issue.id)).all())[0]!;
    const found = await foundOf(repoId);
    const doerRow = await userRow(DOER);

    await expect(
      bare().submitReview(found, {
        doerId: DOER,
        doerRow,
        issue: closedIssue,
        baseBranch: "main",
        reviewType: ReviewType.Approve,
        content: "ship it",
        commitId: "abc123",
      }),
    ).rejects.toMatchObject({ status: 422, message: "can't submit review for a closed or merged PR" });

    const review = await bare().submitReview(found, {
      doerId: DOER,
      doerRow,
      issue: closedIssue,
      baseBranch: "main",
      reviewType: ReviewType.Comment,
      content: "noting on a closed PR",
      commitId: "abc123",
    });
    expect(review.type).toBe(ReviewType.Comment);
    expect(await reviewRows(issue.id)).toHaveLength(1);
  });

  it("converts the doer's pending review in place (GetCurrentReview arm)", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue } = await seedPull(repoId);
    const found = await foundOf(repoId);
    const pending = (
      await db()
        .insert(pullReviews)
        .values({ type: ReviewType.Pending, reviewerId: DOER, issueId: issue.id, content: "", commitId: "", createdAt: T0, updatedAt: T0 })
        .returning()
        .all()
    )[0]!;

    const review = await bare().submitReview(found, {
      doerId: DOER,
      doerRow: await userRow(DOER),
      issue,
      baseBranch: "main",
      reviewType: ReviewType.Comment,
      content: "submitting the draft",
      commitId: "def456",
    });

    expect(review.id).toBe(pending.id); // converted, not re-created
    expect(review.type).toBe(ReviewType.Comment);
    expect(review.content).toBe("submitting the draft");
    expect(review.commitId).toBe("def456");
    expect(await reviewRows(issue.id)).toHaveLength(1);
    // The type-22 comment anchors the converted row.
    expect((await commentRows(issue.id))[0]!.reviewId).toBe(pending.id);
    expect(await currentPendingReview(env.DB, issue.id, DOER)).toBeNull();
  });

  it("approve clears outstanding REQUEST rows, dismisses previous decisions, recomputes official fresh", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue } = await seedPull(repoId);
    const found = await foundOf(repoId);
    // The doer's leftovers: an outstanding REQUEST row and an undismissed
    // (falsely official) previous approve.
    await db().insert(pullReviews).values([
      { type: ReviewType.Request, reviewerId: DOER, issueId: issue.id, content: "", createdAt: T0, updatedAt: T0 },
      { type: ReviewType.Approve, reviewerId: DOER, issueId: issue.id, content: "old", official: true, commitId: "old", createdAt: T0, updatedAt: T0 },
    ]);

    const review = await bare().submitReview(found, {
      doerId: DOER,
      doerRow: await userRow(DOER), // a plain user — no write on alice's repo → NOT official
      issue,
      baseBranch: "main",
      reviewType: ReviewType.Approve,
      content: "ship it",
      commitId: "abc123",
    });

    const rows = await reviewRows(issue.id);
    expect(rows).toHaveLength(2); // the REQUEST row was CLEARED; the old approve survives DISMISSED
    expect(review.type).toBe(ReviewType.Approve);
    expect(review.official).toBe(false); // recomputed fresh: no write access, no rule
    expect(review.dismissed).toBe(false);
    const old = rows.find((row) => row.id !== review.id)!;
    expect(old.type).toBe(ReviewType.Approve);
    expect(old.dismissed).toBe(true); // CreateReview's dismissal (:408–412)
    expect(old.official).toBe(false); // the flag clear (:524–528)
    expect(await latestDecisionReview(env.DB, issue.id, DOER)).not.toBeNull();
  });

  it("an approve by the repo owner computes official=true (no rule → write access)", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue } = await seedPull(repoId);
    const found = await foundOf(repoId);

    const review = await bare().submitReview(found, {
      doerId: OWNER,
      doerRow: await userRow(OWNER),
      issue,
      baseBranch: "main",
      reviewType: ReviewType.Approve,
      content: "owner approve",
      commitId: "abc123",
    });
    expect(review.official).toBe(true);
  });

  it("approve by a team member clears that team's REQUEST row on an org repo; a stranger's does not", async () => {
    const repoId = await seedRepo(ORG);
    const { issue } = await seedPull(repoId);
    const found = await foundOf(repoId);
    const team = (
      await db()
        .insert(teams)
        .values({ orgId: ORG, lowerName: "devs", name: "devs" })
        .returning()
        .all()
    )[0]!;
    await db().insert(teamMembers).values({ orgId: ORG, teamId: team.id, userId: DOER });
    const teamRequest = (
      await db()
        .insert(pullReviews)
        .values({ type: ReviewType.Request, reviewerId: 0, reviewerTeamId: team.id, issueId: issue.id, content: "", createdAt: T0, updatedAt: T0 })
        .returning()
        .all()
    )[0]!;

    // A non-member's approve leaves the team row (:563–584 runs per the
    // doer's OWN team memberships).
    await bare().submitReview(found, {
      doerId: REVIEWER,
      doerRow: await userRow(REVIEWER),
      issue,
      baseBranch: "main",
      reviewType: ReviewType.Approve,
      content: "stranger approve",
      commitId: "abc123",
    });
    expect((await db().select().from(pullReviews).where(eq(pullReviews.id, teamRequest.id)).all())).toHaveLength(1);

    // The member's approve clears it.
    await bare().submitReview(found, {
      doerId: DOER,
      doerRow: await userRow(DOER),
      issue,
      baseBranch: "main",
      reviewType: ReviewType.Approve,
      content: "member approve",
      commitId: "abc123",
    });
    expect(await db().select().from(pullReviews).where(eq(pullReviews.id, teamRequest.id)).all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// addReviewRequest — models/issues/review.go:697–768
// ---------------------------------------------------------------------------

describe("PullReviewsService.addReviewRequest", () => {
  it("creates the REQUEST row with the type-27 comment and bumps num_comments", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue, pullRequest } = await seedPull(repoId);
    const found = await foundOf(repoId);
    const reviewer = await userRow(REVIEWER);

    const review = await bare().addReviewRequest(found, issue, pullRequest, reviewer, DOER);

    expect(review).not.toBeNull();
    expect(review!.type).toBe(ReviewType.Request);
    expect(review!.reviewerId).toBe(REVIEWER);
    expect(review!.official).toBe(false); // bob holds no write on alice's repo
    const sys = await commentRows(issue.id);
    expect(sys).toHaveLength(1);
    expect(sys[0]!.type).toBe(CommentType.ReviewRequest);
    expect(sys[0]!.posterId).toBe(DOER);
    expect(sys[0]!.assigneeId).toBe(REVIEWER);
    expect(sys[0]!.removedAssignee).toBe(0);
    expect(sys[0]!.reviewId).toBe(review!.id);
    expect(await numCommentsOf(issue.id)).toBe(1);
  });

  it("skips silently when the reviewer's latest decision row is already a REQUEST", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue, pullRequest } = await seedPull(repoId);
    const found = await foundOf(repoId);
    const reviewer = await userRow(REVIEWER);
    await bare().addReviewRequest(found, issue, pullRequest, reviewer, DOER);

    const again = await bare().addReviewRequest(found, issue, pullRequest, reviewer, DOER);

    expect(again).toBeNull();
    expect(await reviewRows(issue.id)).toHaveLength(1); // no second row
    expect(await commentRows(issue.id)).toHaveLength(1); // no second comment
    expect(await numCommentsOf(issue.id)).toBe(1);
  });

  it("403s a closed or merged PR (ErrReviewRequestOnClosedPR)", async () => {
    const repoId = await seedRepo(OWNER);
    const found = await foundOf(repoId);
    const reviewer = await userRow(REVIEWER);

    const closed = await seedPull(repoId, { closed: true });
    // Re-read past the seed's mutations — the core takes the CURRENT rows
    // (the route re-reads both per request).
    const closedIssue = (await db().select().from(issues).where(eq(issues.id, closed.issue.id)).all())[0]!;
    await expect(bare().addReviewRequest(found, closedIssue, closed.pullRequest, reviewer, DOER)).rejects.toMatchObject({
      status: 403,
      message: "cannot request a re-review on a closed or merged PR",
    });

    const merged = await seedPull(repoId, { merged: true });
    const mergedPr = (await db().select().from(pullRequests).where(eq(pullRequests.id, merged.pullRequest.id)).all())[0]!;
    await expect(bare().addReviewRequest(found, merged.issue, mergedPr, reviewer, DOER)).rejects.toMatchObject({
      status: 403,
    });
    expect(await reviewRows(closed.issue.id)).toHaveLength(0);
    expect(await reviewRows(merged.issue.id)).toHaveLength(0);
  });

  it("clears the official reviewer's prior decision flag and carries official ON the request row", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue, pullRequest } = await seedPull(repoId);
    const found = await foundOf(repoId);
    const reviewer = await userRow(OWNER); // the owner — official (write access, no rule)
    const oldApprove = (
      await db()
        .insert(pullReviews)
        .values({ type: ReviewType.Approve, reviewerId: OWNER, issueId: issue.id, content: "old", official: true, commitId: "old", createdAt: T0, updatedAt: T0 })
        .returning()
        .all()
    )[0]!;

    const review = await bare().addReviewRequest(found, issue, pullRequest, reviewer, DOER);

    expect(review!.official).toBe(true); // CreateReview's `Official: official` (:759)
    const rows = await db().select().from(pullReviews).where(eq(pullReviews.id, oldApprove.id)).all();
    expect(rows[0]!.official).toBe(false); // the official-flag clear (:741–746)
  });
});

// ---------------------------------------------------------------------------
// removeReviewRequest — models/issues/review.go:770–804
// ---------------------------------------------------------------------------

describe("PullReviewsService.removeReviewRequest", () => {
  it("removes the REQUEST row, lands the removal comment, restores the official flag", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue } = await seedPull(repoId);
    const found = await foundOf(repoId);
    const reviewer = await userRow(OWNER);
    // An official REQUEST row over an older non-official approve — the
    // restoreLatestOfficialReview quirk (:806–820) revives the approve.
    // Insertion ORDER matters: the request is the LATER row (id desc is the
    // latest-decision lookup), exactly the real add-after-approve flow.
    const oldApprove = (
      await db()
        .insert(pullReviews)
        .values({ type: ReviewType.Approve, reviewerId: OWNER, issueId: issue.id, content: "old", official: false, commitId: "old", createdAt: T0, updatedAt: T0 })
        .returning()
        .all()
    )[0]!;
    const request = (
      await db()
        .insert(pullReviews)
        .values({ type: ReviewType.Request, reviewerId: OWNER, issueId: issue.id, content: "", official: true, createdAt: T0, updatedAt: T0 })
        .returning()
        .all()
    )[0]!;

    const removed = await bare().removeReviewRequest(found, issue, "main", reviewer, DOER);

    expect(removed).toBe(true);
    expect(await db().select().from(pullReviews).where(eq(pullReviews.id, request.id)).all()).toHaveLength(0);
    expect((await db().select().from(pullReviews).where(eq(pullReviews.id, oldApprove.id)).all())[0]!.official).toBe(true);
    const sys = await commentRows(issue.id);
    expect(sys).toHaveLength(1);
    expect(sys[0]!.type).toBe(CommentType.ReviewRequest);
    expect(sys[0]!.posterId).toBe(DOER);
    expect(sys[0]!.assigneeId).toBe(OWNER);
    expect(sys[0]!.removedAssignee).toBe(1);
    expect(sys[0]!.reviewId).toBe(0); // the removal comment carries no review anchor (column default)
    expect(await numCommentsOf(issue.id)).toBe(1);
  });

  it("no-ops when the reviewer's latest decision row is not a REQUEST", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue } = await seedPull(repoId);
    const found = await foundOf(repoId);
    const reviewer = await userRow(REVIEWER);
    await db()
      .insert(pullReviews)
      .values({ type: ReviewType.Approve, reviewerId: REVIEWER, issueId: issue.id, content: "kept", commitId: "x", createdAt: T0, updatedAt: T0 });

    expect(await bare().removeReviewRequest(found, issue, "main", reviewer, DOER)).toBe(false);
    expect(await reviewRows(issue.id)).toHaveLength(1); // untouched
    expect(await commentRows(issue.id)).toHaveLength(0);
    expect(await numCommentsOf(issue.id)).toBe(0);
  });

  it("no-ops with no reviews at all", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue } = await seedPull(repoId);
    const found = await foundOf(repoId);
    expect(await bare().removeReviewRequest(found, issue, "main", await userRow(REVIEWER), DOER)).toBe(false);
    expect(await reviewRows(issue.id)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The mail seam — the §14.6 receivers LANDED: an ARMED constructor emits the
// review family over the constructor's env (the IssuesService posture), the
// mentions resolve + carrier persist run even BARE (unconditional, §13 —
// upstream runs FindAndUpdateIssueMentions with no mailer), and the bare
// constructor keeps its fail-closed silence.
// ---------------------------------------------------------------------------

describe("the mail seam (§14.6) — the armed emits, the bare silence", () => {
  /** The fixture users need deliverable addresses for the mailable filter. */
  async function giveEmails(...ids: number[]) {
    for (const id of ids) {
      await env.DB.prepare("UPDATE users SET email = ? WHERE id = ?")
        .bind(`user${id}@example.com`, id)
        .run();
    }
  }

  async function outboxRows() {
    return db().select().from(emailOutbox).all();
  }

  it("armed submitReview emits the PullRequestReview mail beside byte-identical writes (the funnel: the poster receives, the doer is excluded)", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue } = await seedPull(repoId);
    const found = await foundOf(repoId);
    await giveEmails(OWNER, REVIEWER);

    const review = await armed().submitReview(found, {
      doerId: OWNER,
      doerRow: await userRow(OWNER),
      issue,
      baseBranch: "main",
      reviewType: ReviewType.Approve,
      content: "lgtm @bob", // the mention resolves + persists BEFORE the notify half
      commitId: "abc123",
    });

    expect(review.official).toBe(true); // the writes are unchanged
    expect((await commentRows(issue.id)).map((row) => row.type)).toEqual([CommentType.Review]);
    expect(await numCommentsOf(issue.id)).toBe(1);
    // The review mail: ONE row to the PR poster (repo has no watchers;
    // the mention rides first but the doer-alice is excluded either way).
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.toAddr).toBe("user2@example.com");
    expect(row.subject).toBe(`Re: [alice/visible] reviewable change (#${issue.index})`);
    expect(row.dedupeKey).toBe(`pull-review:${(await commentRows(issue.id))[0]!.id}:${REVIEWER}`);
    expect(row.bodyHtml).toContain("<b>alice</b> approved this pull request.");
    expect(row.bodyHtml).toContain("lgtm");
    // The mention line on the mentioned recipient's copy.
    expect(row.bodyHtml).toContain("<b>alice</b> mentioned you:</p>");
    // The carrier persisted (the unconditional §13 half) — the resolve's
    // doer pre-seed means the write covers the DOER too (issue_update.go:
    // 575-696, resolved[doer] first — upstream's UpdateIssueMentions takes
    // the whole resolved set).
    const carrier = await db().select().from(issueUsers).all();
    expect(carrier.map((row) => row.userId).sort((a, b) => a - b)).toEqual([REVIEWER, OWNER]);
    expect(carrier.find((row) => row.userId === REVIEWER)!.isMentioned).toBe(true);
  });

  it("armed submitReview fans PullRequestCodeComment over the converted pending review's attached code comments (mentions-only — the poster here IS the mention)", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue } = await seedPull(repoId);
    const found = await foundOf(repoId);
    await giveEmails(OWNER, REVIEWER);
    // The route's create-arm shape: a pending review + its attached code
    // comment (the submit converts the pending row IN PLACE, so the code
    // comment stays attached to the submitted review's id).
    const pending = (
      await db()
        .insert(pullReviews)
        .values({ type: ReviewType.Pending, reviewerId: OWNER, issueId: issue.id, content: "", commitId: "", createdAt: T0, updatedAt: T0 })
        .returning()
        .all()
    )[0]!;
    await db().insert(comments).values({
      type: CommentType.Code,
      posterId: OWNER,
      issueId: issue.id,
      content: "@bob this dereference is unsafe",
      reviewId: pending.id,
      createdAt: T0,
      updatedAt: T0,
    });

    await armed().submitReview(found, {
      doerId: OWNER,
      doerRow: await userRow(OWNER),
      issue,
      baseBranch: "main",
      reviewType: ReviewType.Approve,
      content: "",
      commitId: "abc123",
    });

    // TWO mails: the review arm (the empty-body approve → the action line
    // only) + the code-comment arm (mentions-only: bob is mentioned, alice
    // is the doer — nobody else exists to receive).
    const rows = await outboxRows();
    expect(rows).toHaveLength(2);
    const reviewMail = rows.find((row) => row.dedupeKey!.startsWith("pull-review:"))!;
    const codeMail = rows.find((row) => row.dedupeKey!.startsWith("pull-code-comment:"))!;
    expect(reviewMail).toBeDefined();
    expect(codeMail).toBeDefined();
    expect(reviewMail.toAddr).toBe("user2@example.com");
    expect(reviewMail.bodyHtml).toContain("<b>alice</b> approved this pull request.");
    expect(codeMail.toAddr).toBe("user2@example.com");
    expect(codeMail.bodyHtml).toContain("this dereference is unsafe");
    expect(codeMail.bodyHtml).toContain("<b>alice</b> mentioned you:</p>");
  });

  it("armed addReviewRequest mails the reviewer 'Requested to review <url>.'; the armed removal self-gates SILENT (notify.go:130-131)", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue, pullRequest } = await seedPull(repoId);
    const found = await foundOf(repoId);
    await giveEmails(OWNER, REVIEWER);
    // The reviewer row read FRESH — the receiver gates IsMailable on the
    // passed row (upstream hands the loaded reviewer over).
    const reviewer = await userRow(REVIEWER);

    const request = await armed().addReviewRequest(found, issue, pullRequest, reviewer, OWNER);
    expect(request).not.toBeNull();
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.toAddr).toBe("user2@example.com");
    expect(row.subject).toBe(`Re: [alice/visible] reviewable change (#${issue.index})`);
    expect(row.info).toBe(`Subject: Re: [alice/visible] reviewable change (#${issue.index}), issue assigned`);
    expect(row.dedupeKey).toBe(`pull-review-request:${(await commentRows(issue.id))[0]!.id}:${REVIEWER}`);
    expect(row.replyTo).toBeNull(); // type-27 carries no HasMailReplySupport
    expect(row.bodyHtml).toContain(
      `Requested to review <a href="https://mail.example/alice/visible/pulls/${issue.index}"`,
    );
    expect(row.bodyHtml).not.toContain("<b>alice");

    // The removal fires the receiver with isRequest=false — self-gated off,
    // upstream-shaped (review_request.go:38 `comment != nil` still calls).
    const removed = await armed().removeReviewRequest(found, issue, "main", reviewer, OWNER);
    expect(removed).toBe(true);
    expect(await outboxRows()).toHaveLength(1);
  });

  it("the bare constructor (every existing call site's posture) writes identically, persists the mention carrier, and emits NOTHING", async () => {
    const repoId = await seedRepo(OWNER);
    const { issue } = await seedPull(repoId);
    const found = await foundOf(repoId);
    await giveEmails(OWNER, REVIEWER);

    const review = await bare().submitReview(found, {
      doerId: OWNER,
      doerRow: await userRow(OWNER),
      issue,
      baseBranch: "main",
      reviewType: ReviewType.Approve,
      content: "cc @bob quietly",
      commitId: "abc123",
    });
    expect(review.official).toBe(true);
    // The fail-closed posture: ZERO mail despite the mention.
    expect(await outboxRows()).toHaveLength(0);
    // ...but the unconditional carrier half still persisted (§13 — the
    // carrier feeds reads that work without a mailer), doer pre-seed row
    // included (issue_update.go:575-696).
    expect((await db().select().from(issueUsers).all()).map((row) => row.userId).sort((a, b) => a - b)).toEqual([REVIEWER, OWNER]);
  });
});
