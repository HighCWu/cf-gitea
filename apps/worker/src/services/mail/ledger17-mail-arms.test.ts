/**
 * The ledger ⑰ mail pass's behavioral pins (docs/compat/v1.5.2-ledger.md
 * §1.4 — specs/email-outbound.md §15's as-built record): the M1 pair's
 * receivers end to end (`notifyPullReviewDismiss` — the review_dismissed
 * mail over the type-32 comment with its inline `.ReviewComments` excerpts;
 * `notifyPullRequestPushCommits` — the push mail over the emptied type-29
 * content), the A2 notify-mail register gate (ENABLE_NOTIFY_MAIL on top of
 * MAIL_ENABLED, mailer.go:33-35), the A3 admin short-circuit inside the
 * unit fold (CheckRepoUnitUser, repo_permission.go:663-665), and the M7
 * `watchIfAuto` writer (models/repo/watch.go:310-323).
 *
 * Harness: the notify.test.ts conventions — real D1, the recording spy
 * queue, one seeded public repo whose issue rows flip is_pull per fixture.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  comments,
  emailOutbox,
  issues,
  repoWatchers,
  repositories,
  userSettings,
  users,
} from "../../db/schema";
import { IssuesService, type IssueRow } from "../../issues/service";
import { CommentType } from "../../issues/comment-types";
import { WatchMode, watchIfAuto } from "../../api/services/repo-watchers";
import {
  notifyIssueComment,
  notifyPullRequestPushCommits,
  notifyPullReviewDismiss,
  resolveIssueMailRecipients,
  type MailNotifyEnv,
} from "./notify";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const REPO_ID = "610";

const FIXTURE_USERS: Array<{ id: number; username: string; email: string | null; fullName?: string }> = [
  // id 1 = the repo OWNER (the owner join matches users.username_lower to
  // repositories.owner_namespace — repository.ts's repositoryWithOwnerQuery).
  { id: 1, username: "repoowner", email: "owner@example.com" },
  { id: 10, username: "poster", email: "poster@example.com" },
  { id: 20, username: "repowatcher", email: "rw@example.com" },
  { id: 30, username: "issuewatcher", email: "iw@example.com" },
  { id: 60, username: "doer", email: "doer@example.com", fullName: "The Admin" },
  { id: 90, username: "reviewer", email: "reviewer@example.com", fullName: "Mister X" },
];

/** Recording Queue — counts sends AND captures every body. */
function makeSpyQueue(): Queue & { sends: number; sendBodies: unknown[] } {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue: Queue & { sends: number; sendBodies: unknown[] } = {
    sends: 0,
    sendBodies: [],
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

/** The armed env — BOTH gate vars set (the A2 fixture; the gate-off arms
 *  override ENABLE_NOTIFY_MAIL away). */
function armedEnv(overrides: Partial<MailNotifyEnv> = {}): MailNotifyEnv {
  const queue = makeSpyQueue();
  return {
    DB: env.DB,
    REPO_TASKS: queue,
    APP_URL: "https://mail.example",
    MAIL_ENABLED: "true",
    ENABLE_NOTIFY_MAIL: "true",
    MAIL_FROM: "Gitea <noreply@example.com>",
    ...overrides,
  };
}

const db = () => drizzle(env.DB);

async function userRow(id: number) {
  return (await db().select().from(users).where(eq(users.id, id)).get())!;
}

async function seedRepo(): Promise<void> {
  await db().insert(repositories).values({
    id: REPO_ID,
    storageKey: `r_${REPO_ID}`,
    ownerNamespace: "repoowner",
    ownerId: 1,
    slug: "repo",
    visibility: "public",
    status: "ready",
  });
}

/** A pull issue with the funnel's watcher rows (repo watcher 20; issue
 *  watcher 30 added per fixture) — upstream order: repo watcher, poster,
 *  participants, issue watcher. */
async function seedPull(title = "Review me"): Promise<IssueRow> {
  const service = new IssuesService(env.DB);
  await seedRepo();
  const issue = await service.createIssue({ repoId: REPO_ID, title, content: "body", posterId: 10 });
  await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
  await db().insert(repoWatchers).values([{ repoId: REPO_ID, userId: 20 }]);
  await db().insert(userSettings).values({ userId: 30, emailNotificationsPreference: "enabled" }).onConflictDoNothing();
  return (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
}

/** Attach an issue-watch row AFTER the issue exists (the seedIssue shape). */
async function watchIssue(issueId: number, userId: number): Promise<void> {
  const { issueSubscriptions } = await import("../../db/schema");
  await db().insert(issueSubscriptions).values({
    userId,
    issueId,
    isWatching: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
}

const NOW = new Date(1_700_000_000_000);

beforeEach(async () => {
  for (const table of [
    "email_outbox",
    "issue_subscriptions",
    "repo_watchers",
    "repo_settings",
    "comments",
    "issues",
    "repo_counters",
    "repositories",
    "user_settings",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const user of FIXTURE_USERS) {
    await env.DB
      .prepare(
        "INSERT INTO users (id, username, username_lower, email, full_name, status, type, created_at) VALUES (?, ?, ?, ?, ?, 'active', 'user', 0)",
      )
      .bind(user.id, user.username, user.username, user.email, user.fullName ?? "")
      .run();
  }
});

// ---------------------------------------------------------------------------
// A2 — the notify-mail register gate (mailer.go:33-35): the participant
// fan-out needs ENABLE_NOTIFY_MAIL on TOP of MAIL_ENABLED.
// ---------------------------------------------------------------------------

describe("A2 — the ENABLE_NOTIFY_MAIL register gate (mailer.go:33-35)", () => {
  it("MAIL_ENABLED alone (the var unset) → every participant arm answers disabled, ZERO rows", async () => {
    const issue = await seedPull();
    const comment = (
      await db()
        .insert(comments)
        .values({ type: CommentType.Comment, posterId: 60, issueId: issue.id, content: "hi", createdAt: NOW, updatedAt: NOW })
        .returning()
    )[0]!;
    const doer = await userRow(60);
    const env_ = armedEnv({ ENABLE_NOTIFY_MAIL: undefined });
    expect((await notifyIssueComment(env_, { issue, comment, doer })).outcome).toBe("disabled");
    expect((await notifyPullReviewDismiss(env_, {
      issue,
      comment: { ...comment, type: CommentType.DismissReview, reviewId: 9001 },
      doer,
      reviewer: await userRow(90),
    })).outcome).toBe("disabled");
    expect((await notifyPullRequestPushCommits(env_, {
      issue,
      comment: { ...comment, type: CommentType.PullRequestPush, content: '{"is_force_push":false,"commit_ids":["a"]}' },
      doer,
      headBranch: "topic",
      isForcePush: false,
      commits: [{ sha: "a".repeat(40), title: "One" }],
    })).outcome).toBe("disabled");
    expect((await db().select().from(emailOutbox).all()).length).toBe(0);
  });

  it("the var set on top of MAIL_ENABLED arms the fan (the same arm, both vars)", async () => {
    const issue = await seedPull();
    const comment = (
      await db()
        .insert(comments)
        .values({ type: CommentType.Comment, posterId: 60, issueId: issue.id, content: "hi", createdAt: NOW, updatedAt: NOW })
        .returning()
    )[0]!;
    const outcome = await notifyIssueComment(armedEnv(), { issue, comment, doer: await userRow(60) });
    expect(outcome.outcome).toBe("enqueued");
    expect((await db().select().from(emailOutbox).all()).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// A3 — the unit fold's admin short-circuit (repo_permission.go:663-665): a
// disabled unit drops only the NON-admins.
// ---------------------------------------------------------------------------

describe("A3 — CheckRepoUnitUser's admin short-circuit in the unit fold", () => {
  it("a disabled pulls unit keeps the SITE ADMIN watcher, drops the non-admins", async () => {
    const issue = await seedPull(); // is_pull → the unit half is has_pull_requests
    await watchIssue(issue.id, 30);
    await db().update(users).set({ isAdmin: true }).where(eq(users.id, 20)); // the repo watcher is a site admin
    await env.DB
      .prepare(
        "INSERT INTO repo_settings (repo_id, has_pull_requests) VALUES (?, 0) ON CONFLICT (repo_id) DO UPDATE SET has_pull_requests = 0",
      )
      .bind(REPO_ID)
      .run();
    const doer = await userRow(60);
    const repo = (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;
    const ids = (await resolveIssueMailRecipients(env.DB, { issue, repo, doer })).map((u) => u.id);
    expect(ids).toEqual([20]); // the admin short-circuit outranks the unit half
  });

  it("with the unit ENABLED the fold still admits everyone the grant admits (the short-circuit is invisible)", async () => {
    const issue = await seedPull();
    await watchIssue(issue.id, 30);
    const doer = await userRow(60);
    const repo = (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;
    const ids = (await resolveIssueMailRecipients(env.DB, { issue, repo, doer })).map((u) => u.id);
    // Funnel order: repo watcher 20, poster 10, issue watcher 30 (the doer
    // 60 excluded — not andyourown).
    expect(ids).toEqual([20, 10, 30]);
  });
});

// ---------------------------------------------------------------------------
// M1 + M3 — the PullReviewDismiss arm: the review_dismissed mail over the
// type-32 comment, the review's inline code comments riding as
// .ReviewComments (mail_issue_common.go:93-100).
// ---------------------------------------------------------------------------

describe("notifyPullReviewDismiss — the PullReviewDismiss receiver (notify.go:182-189)", () => {
  /** The dismissal fixture: the pull, the review's two inline code comments
   *  (type 21 over review 9001), the type-32 dismissal comment. */
  async function seedDismissal(dismissMessage: string) {
    const issue = await seedPull();
    await watchIssue(issue.id, 30);
    const now = new Date(0);
    await db().insert(comments).values([
      {
        type: CommentType.Code,
        posterId: 90,
        issueId: issue.id,
        content: "first note",
        treePath: "src/a.txt",
        patch: "diff --git a/src/a.txt b/src/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
        reviewId: 9001,
        createdAt: now,
        updatedAt: now,
      },
      {
        type: CommentType.Code,
        posterId: 90,
        issueId: issue.id,
        content: "second **note**",
        treePath: "src/b.txt",
        patch: "diff --git a/src/b.txt b/src/b.txt\n@@ -1 +1 @@\n-c\n+d\n",
        reviewId: 9001,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const dismissed = (
      await db()
        .insert(comments)
        .values({
          type: CommentType.DismissReview,
          posterId: 60,
          issueId: issue.id,
          content: dismissMessage,
          reviewId: 9001,
          createdAt: NOW,
          updatedAt: NOW,
        })
        .returning()
    )[0]!;
    return { issue, dismissed };
  }

  it("the review_dismissed mail: both display names on the action line, the kept message, the inline excerpts, the type-32 anchor", async () => {
    const { issue, dismissed } = await seedDismissal("needs another look");
    const outcome = await notifyPullReviewDismiss(
      armedEnv(),
      { issue, comment: dismissed, doer: await userRow(60), reviewer: await userRow(90) },
      { now: NOW },
    );
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    // The full participants funnel (mentions nil): repo watcher 20, poster
    // 10, the REVIEWER 90 (a participant — their type-21 comments ride the
    // participants arm), issue watcher 30; the dismissing doer excluded.
    expect(rows.map((row) => row.toAddr)).toEqual(["rw@example.com", "poster@example.com", "reviewer@example.com", "iw@example.com"]);
    for (const row of rows) {
      expect(row.subject).toBe(`Re: [repoowner/repo] ${issue.title} (#${issue.index})`);
      expect(row.dedupeKey).toBe(`pull-review-dismissed:${dismissed.id}:${recipientIdOf(row)}`);
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      expect(headers["Message-ID"]).toBe(`<repoowner/repo/pulls/${issue.index}/comment/${dismissed.id}@mail.example>`);
      // The action line — %[1]s the dismissing admin, %[2]s the dismissed
      // reviewer (both DisplayNameWithFullName; the locale's <b> wraps
      // %[1]s only).
      expect(row.bodyHtml).toContain(
        "<b>doer (The Admin)</b> dismissed last review from reviewer (Mister X) for this pull request.",
      );
      // The KEPT dismiss message renders beneath the line (the body branch).
      expect(row.bodyHtml).toContain("needs another look");
      // M3: the review's inline excerpts — the tree-path line, the RAW patch
      // in the <pre>, the rendered content. NO reply half (inbound unarmed).
      expect(row.bodyHtml).toContain("In src/a.txt:");
      expect(row.bodyHtml).toContain("diff --git a/src/a.txt b/src/a.txt");
      expect(row.bodyHtml).toContain("second <strong>note</strong>");
      expect(row.bodyHtml).not.toContain("or reply to this email directly");
    }
  });
});

// ---------------------------------------------------------------------------
// M1 — the PullRequestPushCommits arm: the push mail over the EMPTIED
// type-29 content (mail_comment.go:24-26), the push line + commit list, and
// the CanReply exclusion (mail_issue_common.go:122).
// ---------------------------------------------------------------------------

describe("notifyPullRequestPushCommits — the PullRequestPushCommits receiver (notify.go:158-180)", () => {
  const SHA1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const SHA2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  async function seedPushComment(isForcePush: boolean): Promise<{ issue: IssueRow; comment: typeof comments.$inferSelect }> {
    const issue = await seedPull("Push me");
    await watchIssue(issue.id, 30);
    const comment = (
      await db()
        .insert(comments)
        .values({
          type: CommentType.PullRequestPush,
          posterId: 60,
          issueId: issue.id,
          content: JSON.stringify(
            isForcePush ? { is_force_push: true, commit_ids: [SHA1, SHA2] } : { is_force_push: false, commit_ids: [SHA1, SHA2] },
          ),
          createdAt: NOW,
          updatedAt: NOW,
        })
        .returning()
    )[0]!;
    return { issue, comment };
  }

  it("a normal push: the TrN push line, the emptied body, the commit list with ShortSha links, the pull-push dedupe", async () => {
    const { issue, comment } = await seedPushComment(false);
    const outcome = await notifyPullRequestPushCommits(
      armedEnv(),
      {
        issue,
        comment,
        doer: await userRow(60),
        headBranch: "topic",
        isForcePush: false,
        commits: [
          { sha: SHA1, title: "First commit" },
          { sha: SHA2, title: "Second commit" },
        ],
      },
      { now: NOW },
    );
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    expect(rows.map((row) => row.toAddr)).toEqual(["rw@example.com", "poster@example.com", "iw@example.com"]);
    for (const row of rows) {
      // push_n over the count — NO trailing period (the locale's own shape);
      // the doer's DisplayNameWithFullName rides %[1]s.
      expect(row.bodyHtml).toContain("<b>doer (The Admin)</b> pushed 2 commits to topic");
      // The type-29 content is EMPTIED — the raw PushActionContent JSON
      // never renders.
      expect(row.bodyHtml).not.toContain("is_force_push");
      // The commit <ul>: base-repo commit links + MessageTitle.
      expect(row.bodyHtml).toContain(`href="https://mail.example/repoowner/repo/commit/${SHA1}">aaaaaaaaaa</a> - First commit`);
      expect(row.bodyHtml).toContain(`href="https://mail.example/repoowner/repo/commit/${SHA2}">bbbbbbbbbb</a> - Second commit`);
      expect(row.dedupeKey).toBe(`pull-push:${comment.id}:${recipientIdOf(row)}`);
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      expect(headers["Message-ID"]).toBe(`<repoowner/repo/pulls/${issue.index}/comment/${comment.id}@mail.example>`);
    }
  });

  it("a force push: the boundary-anchor line, the EMPTY commit list shell", async () => {
    const { issue, comment } = await seedPushComment(true);
    await notifyPullRequestPushCommits(
      armedEnv(),
      {
        issue,
        comment,
        doer: await userRow(60),
        headBranch: "topic",
        isForcePush: true,
        commits: [], // upstream leaves Commits nil for the boundary pair
        oldCommit: SHA1,
        newCommit: SHA2,
      },
      { now: NOW },
    );
    const rows = await db().select().from(emailOutbox).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.bodyHtml).toContain(
        `<b>doer (The Admin)</b> force-pushed the <b>topic</b> from <a href='https://mail.example/repoowner/repo/commit/${SHA1}'><b>aaaaaaaaaa</b></a> to <a href='https://mail.example/repoowner/repo/commit/${SHA2}'><b>bbbbbbbbbb</b></a>.`,
      );
      expect(row.bodyHtml).not.toContain("<li>"); // the bare <ul> shell
    }
  });

  it("the push mail NEVER advertises reply-by-email — even with the inbound arm up (mail_issue_common.go:122)", async () => {
    const { issue, comment } = await seedPushComment(false);
    const inbound = armedEnv({
      MAIL_INBOUND_ENABLED: "true",
      MAIL_INBOUND_REPLY_ADDRESS: "reply+%{token}@mail.example",
      MAIL_INBOUND_SECRET: "test-secret",
    });
    await notifyPullRequestPushCommits(
      inbound,
      { issue, comment, doer: await userRow(60), headBranch: "topic", isForcePush: false, commits: [{ sha: SHA1, title: "One" }] },
      { now: NOW },
    );
    const rows = await db().select().from(emailOutbox).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.bodyHtml).not.toContain("or reply to this email directly");
  });
});

// ---------------------------------------------------------------------------
// M7 — watchIfAuto (models/repo/watch.go:310-323): the AUTO_WATCH_ON_CHANGES
// push-path flip.
// ---------------------------------------------------------------------------

describe("watchIfAuto — the WatchIfAuto port (watch.go:310-323)", () => {
  const NOW2 = new Date(1_700_000_100_000);

  it("knob on + a write + no watch row → the Auto row lands and num_watches bumps", async () => {
    const service = new IssuesService(env.DB);
    await seedRepo();
    await service.createIssue({ repoId: REPO_ID, title: "x", content: null, posterId: 10 });
    await watchIfAuto(env.DB, REPO_ID, 90, true, true, NOW2);
    const row = await db().select().from(repoWatchers).where(eq(repoWatchers.repoId, REPO_ID)).all();
    expect(row.map((r) => ({ userId: r.userId, mode: r.mode }))).toEqual([{ userId: 90, mode: WatchMode.Auto }]);
    const repo = (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;
    expect(repo.numWatches).toBe(1);
  });

  it("an existing row of ANY mode is the no-op (watch.go:319-321); the knob off / a non-write stay silent", async () => {
    const service = new IssuesService(env.DB);
    await seedRepo();
    await service.createIssue({ repoId: REPO_ID, title: "x", content: null, posterId: 10 });
    await db().insert(repoWatchers).values({ repoId: REPO_ID, userId: 90, mode: WatchMode.Dont });
    await watchIfAuto(env.DB, REPO_ID, 90, true, true, NOW2); // Dont survives
    let row = await db().select().from(repoWatchers).where(eq(repoWatchers.repoId, REPO_ID)).all();
    expect(row.map((r) => r.mode)).toEqual([WatchMode.Dont]);

    await env.DB.prepare("DELETE FROM repo_watchers").run();
    await watchIfAuto(env.DB, REPO_ID, 90, false, true, NOW2); // knob off
    await watchIfAuto(env.DB, REPO_ID, 90, true, false, NOW2); // not a write
    row = await db().select().from(repoWatchers).all();
    expect(row.length).toBe(0);
  });
});

/** The outbox row's recipient id from its dedupe key. */
function recipientIdOf(row: typeof emailOutbox.$inferSelect): number {
  return Number((row.dedupeKey ?? "").split(":").pop());
}
