/**
 * The mail notify hub's first surface, end to end (specs/email-outbound.md
 * §9): the real write path (`IssuesService.addComment` with a mail env —
 * upstream's CreateIssueComment receiver, services/mailer/notify.go:31-51,
 * fired from the model layer exactly like upstream's
 * services/issues/comments.go) landing one `email_outbox` row per resolved
 * recipient (dedupe key `issue-comment:<commentId>:<recipientId>`) + one
 * `{kind: "mail-outbox"}` queue message each (the recording spy — no real
 * provider, ever), then driven through the landed consumer to `sent`.
 *
 * The recipient resolution matrix pins upstream's
 * mailIssueCommentToParticipants (mail_issue.go:28-120) over our tables:
 * the actor exclusion (and the andyourown exception), the explicit-unwatch
 * exclusion, the preference prefilter through the typed `user_settings`
 * side store (absent row = 'enabled'), the mailable filter, the WIP
 * repo-watcher gate and the private-repo grant gate; plus the
 * empty-recipient skip.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Context } from "hono";
import { emptyTree, serializeCommit } from "@cf-gitea/git-engine";

import { WatchMode } from "../../api/services/repo-watchers";
import { engineCell, ZERO_OID } from "../../api/services/engine";
import { mergePullRequest } from "../../api/services/pull-engine";
import type { ApiEnv } from "../../api/env";

import {
  comments,
  emailInbound,
  emailOutbox,
  issues,
  issueAssignees,
  issueSubscriptions,
  repoCollaborators,
  repoWatchers,
  repositories,
  userSettings,
  users,
} from "../../db/schema";
import { IssuesService, type IssueRow, type PullRequestRow } from "../../issues/service";
import { CommentType } from "../../issues/comment-types";
import {
  createReplyToken,
  decodeReplyToken,
  handleIncomingEmail,
  type InboundEmailEnv,
  type InboundEmailMessage,
} from "./inbound";
import { isMailOutboxMessage, processMailOutbox, type MailOutboxMessage } from "./outbox";
import {
  notifyIssueAssigneeChanged,
  notifyIssueComment,
  notifyIssueCreated,
  notifyIssueStatusChanged,
  notifyIssueTitleChanged,
  notifyMergePullRequest,
  notifyPullRequestCodeComment,
  notifyPullRequestCreated,
  notifyPullRequestReview,
  notifyPullRequestReviewRequest,
  resolveIssueMailRecipients,
  type MailNotifyEnv,
} from "./notify";
import { issueMailFallbackSubject, renderIssueCommentMail } from "./templates";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const REPO_ID = "500";

const FIXTURE_USERS: Array<{ id: number; username: string; email: string | null; type?: string; status?: string }> = [
  { id: 1, username: "repoowner", email: "owner@example.com" },
  { id: 10, username: "poster", email: "poster@example.com" },
  { id: 20, username: "repowatcher", email: "rw@example.com" },
  { id: 30, username: "issuewatcher", email: "iw@example.com" },
  { id: 40, username: "participant", email: "part@example.com" },
  { id: 50, username: "assignee", email: "as@example.com" },
  { id: 60, username: "doer", email: "doer@example.com" },
  { id: 70, username: "unwatcher", email: "un@example.com" },
  { id: 80, username: "onmention", email: "om@example.com" },
  { id: 90, username: "noprefrow", email: "np@example.com" },
  { id: 95, username: "orgish", email: "org@example.com", type: "org" },
  { id: 96, username: "frozen", email: "fz@example.com", status: "prohibited" },
];

/** Recording Queue — counts sends AND captures every body. */
function spyQueue(): Queue & { sends: number; sendBodies: MailOutboxMessage[] } {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue = {
    sends: 0,
    sendBodies: [] as MailOutboxMessage[],
    send: (body: unknown) => {
      queue.sends += 1;
      queue.sendBodies.push(body as MailOutboxMessage);
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: MessageSendRequest[]) => {
      queue.sends += messages.length;
      for (const m of messages) queue.sendBodies.push(m.body as MailOutboxMessage);
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve(metadata.metrics),
  };
  return queue;
}

/** The armed env the hub (and the consumer) read. */
function armedEnv(
  overrides: Partial<MailNotifyEnv & { MAIL_PROVIDER?: string }> = {},
): MailNotifyEnv & { MAIL_PROVIDER?: string } {
  return {
    DB: env.DB,
    REPO_TASKS: spyQueue(),
    APP_URL: "https://mail.example",
    MAIL_ENABLED: "true",
    MAIL_PROVIDER: "dummy",
    MAIL_FROM: "Gitea <noreply@example.com>",
    ...overrides,
  };
}

const db = () => drizzle(env.DB);

async function seedRepo(visibility: "public" | "private" = "public"): Promise<void> {
  await db().insert(repositories).values({
    id: REPO_ID,
    storageKey: `r_${REPO_ID}`,
    ownerNamespace: "repoowner",
    ownerId: 1,
    slug: "repo",
    visibility,
    status: "ready",
  });
}

async function seedIssue(title = "Issue title"): Promise<IssueRow> {
  const service = new IssuesService(env.DB);
  await seedRepo();
  const issue = await service.createIssue({ repoId: REPO_ID, title, content: "body", posterId: 10 });
  await db().insert(repoWatchers).values([
    { repoId: REPO_ID, userId: 20 },
    { repoId: REPO_ID, userId: 70 },
    { repoId: REPO_ID, userId: 80 },
    { repoId: REPO_ID, userId: 95 },
    { repoId: REPO_ID, userId: 96 },
  ]);
  await db().insert(issueSubscriptions).values([
    { userId: 30, issueId: issue.id, isWatching: true, createdAt: new Date(0), updatedAt: new Date(0) },
    { userId: 70, issueId: issue.id, isWatching: false, createdAt: new Date(0), updatedAt: new Date(0) },
  ]);
  await db().insert(issueAssignees).values({ issueId: issue.id, assigneeId: 50 });
  // The participant (40) — a plain comment through a BARE service (no mail
  // env → no notify on this setup write).
  await service.addComment({ issueId: issue.id, posterId: 40, content: "earlier comment" });
  return issue;
}

beforeEach(async () => {
  for (const table of [
    "email_inbound",
    "email_outbox",
    "issue_subscriptions",
    "issue_assignees",
    "repo_watchers",
    "repo_collaborators",
    "repo_units",
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
        "INSERT INTO users (id, username, username_lower, email, status, type, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)",
      )
      .bind(user.id, user.username, user.username, user.email, user.status ?? "active", user.type ?? "user")
      .run();
  }
  // The typed preference side store: an explicit onmention row (80). Every
  // other fixture user has NO row — the absent-row-is-'enabled' default.
  await db().insert(userSettings).values({ userId: 80, emailNotificationsPreference: "onmention" });
});

// ---------------------------------------------------------------------------
// Template byte-shape (templates/mail/repo/issue/default.tmpl, comment arm)
// ---------------------------------------------------------------------------

describe("renderIssueCommentMail — default.tmpl comment-arm byte shape", () => {
  const render = () =>
    renderIssueCommentMail({
      subject: "Re: [owner/repo] T (#1)",
      bodyHtml: "<p>hi</p>\n",
      link: "https://x.example/owner/repo/issues/1#issuecomment-9",
      issueIndex: 1,
      appName: "Gitea",
      appUrl: "https://x.example/",
    });

  it("pins the Go-template whitespace trace verbatim (dropped ifs, the p block, the link line)", () => {
    const html = render();
    // The two dropped `{{if}}` lines leave "\t\n" each; the `<p>` block's
    // else-branch indents the body three tabs in and closes two; the
    // dropped `{{if .CanReply}}` leaves the bare link line.
    expect(html).toContain(
      "<body>\n\t\n\t\n\t<p>\n\t\t\n\t\t\t<p>hi</p>\n\n\t\t</p>\n\t\n\t<p><a href=\"https://x.example/owner/repo/issues/1#issuecomment-9\">#1</a>.</p>\n\t<table",
    );
    expect(html.startsWith("<!DOCTYPE html>\n<html>\n<head>\n\t<meta http-equiv=\"Content-Type\"")).toBe(true);
    expect(html.endsWith("</table>\n\n</body>\n</html>")).toBe(true);
    expect(html).toContain("<title>Re: [owner/repo] T (#1)</title>");
    expect(html).toContain('<a href="https://x.example/">Gitea</a>');
  });

  it("escapes the subject into the head title slot (html/template parity)", () => {
    const html = renderIssueCommentMail({
      subject: "Re: [o/r] A & B <x> (#2)",
      bodyHtml: "<p>hi</p>\n",
      link: "https://x.example/o/r/issues/2",
      issueIndex: 2,
      appName: "Gitea",
      appUrl: "https://x.example/",
    });
    expect(html).toContain("<title>Re: [o/r] A &amp; B &lt;x&gt; (#2)</title>");
  });

  it("issueMailFallbackSubject — mail_issue_common.go:34-36", () => {
    expect(issueMailFallbackSubject("user2/repo1", "issue1", 1)).toBe("[user2/repo1] issue1 (#1)");
  });
});

// ---------------------------------------------------------------------------
// Recipient resolution — mailIssueCommentToParticipants over our tables
// ---------------------------------------------------------------------------

describe("resolveIssueMailRecipients — the mailIssueCommentToParticipants port", () => {
  it("resolves watchers/poster/assignee/participant and drops the doer, the explicit unwatch, onmention, orgs, the frozen", async () => {
    const issue = await seedIssue();
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const repo = (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;
    const recipients = await resolveIssueMailRecipients(env.DB, { issue, repo, doer });
    // Upstream order: repo watcher 20 (kept; 70 explicit unwatch, 80
    // onmention, 95 org, 96 prohibited — dropped), poster 10, assignee 50,
    // participant 40, issue watcher 30; doer 60 (now a participant too)
    // excluded; 90 has no source here.
    expect(recipients.map((u) => u.id)).toEqual([20, 10, 50, 40, 30]);
  });

  it("doer with andyourown stays in when they hold a source (mail_issue.go:94-97)", async () => {
    const issue = await seedIssue();
    await db().insert(userSettings).values({ userId: 60, emailNotificationsPreference: "andyourown" });
    // The doer needs a recipient SOURCE (upstream mails the unfiltered set
    // ∪ mentions only): make them a participant.
    const bare = new IssuesService(env.DB);
    await bare.addComment({ issueId: issue.id, posterId: 60, content: "doer was here" });
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const repo = (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;
    const recipients = await resolveIssueMailRecipients(env.DB, { issue, repo, doer });
    expect(recipients.map((u) => u.id)).toContain(60);
  });

  it("WIP pull-request comments drop the repo watchers, keep the rest (mail_issue.go:70)", async () => {
    const issue = await seedIssue("WIP: draft thing");
    await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
    const fresh = (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const repo = (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;
    const recipients = await resolveIssueMailRecipients(env.DB, { issue: fresh, repo, doer });
    expect(recipients.map((u) => u.id)).toEqual([10, 50, 40, 30]);
  });

  it("pullCreate lifts the WIP gate for the repo watchers (mail_issue.go:67-76's ActionCreatePullRequest exception)", async () => {
    const issue = await seedIssue("WIP: draft thing");
    await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
    const fresh = (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const repo = (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;
    const recipients = await resolveIssueMailRecipients(env.DB, { issue: fresh, repo, doer, pullCreate: true });
    // Upstream's gate is `IsPull && IsWorkInProgress && ActionType !=
    // ActionCreatePullRequest` — false for the create mail, so watcher 20 is
    // back at the head of the source order (70 explicit unwatch, 80
    // onmention, 95 org, 96 prohibited stay out).
    expect(recipients.map((u) => u.id)).toEqual([20, 10, 50, 40, 30]);
  });

  it("absent user_settings row = the 'enabled' default (admin.go:32)", async () => {
    const issue = await seedIssue();
    // 90 has no subscription/watch source — give them one and confirm the
    // default preference admits them.
    await db().insert(repoWatchers).values({ repoId: REPO_ID, userId: 90 });
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const repo = (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;
    const recipients = await resolveIssueMailRecipients(env.DB, { issue, repo, doer });
    expect(recipients.map((u) => u.id)).toContain(90);
  });

  it("private repo: no grant drops everyone; a collaborator row (or site admin) passes (CheckRepoUnitUser)", async () => {
    const issue = await seedIssue();
    await db().update(repositories).set({ visibility: "private" }).where(eq(repositories.id, REPO_ID));
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const repo = (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;
    expect((await resolveIssueMailRecipients(env.DB, { issue, repo, doer })).map((u) => u.id)).toEqual([]);
    await db().insert(repoCollaborators).values({ repoId: REPO_ID, userId: 20, mode: "read" });
    expect((await resolveIssueMailRecipients(env.DB, { issue, repo, doer })).map((u) => u.id)).toEqual([20]);
  });

  it("a disabled issues unit excludes everyone (CanRead's unit half)", async () => {
    const issue = await seedIssue();
    await env.DB
      .prepare(
        "INSERT INTO repo_settings (repo_id, has_issues) VALUES (?, 0) ON CONFLICT (repo_id) DO UPDATE SET has_issues = 0",
      )
      .bind(REPO_ID)
      .run();
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const repo = (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;
    expect(await resolveIssueMailRecipients(env.DB, { issue, repo, doer })).toEqual([]);
  });

  it("empty recipient set: a poster-less issue with no sources resolves nobody", async () => {
    const service = new IssuesService(env.DB);
    await seedRepo();
    const issue = await service.createIssue({ repoId: REPO_ID, title: "lonely", content: null, posterId: null });
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const repo = (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;
    expect(await resolveIssueMailRecipients(env.DB, { issue, repo, doer })).toEqual([]);
  });
});

/**
 * The repo-watch MODE arms (migration 0053 — GetRepoWatchersIDs /
 * GetRepoCustomWatchersIDs / GetRepoIgnorersIDs, models/repo/watch.go:
 * 244-292, over mail_issue.go:67-92). seedIssue() seeds watchers 20, 70,
 * 80, 95, 96 at the mode defaults (Normal, every include true); these flip
 * individual rows and pin the resolution change.
 */
describe("resolveIssueMailRecipients — the repo-watch MODE arms (migration 0053)", () => {
  const setWatch = (userId: number, values: Partial<typeof repoWatchers.$inferInsert>) =>
    db().update(repoWatchers).set(values).where(and(eq(repoWatchers.repoId, REPO_ID), eq(repoWatchers.userId, userId)));

  async function resolve(issue: IssueRow): Promise<Array<{ id: number }>> {
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const repo = (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;
    return (await resolveIssueMailRecipients(env.DB, { issue, repo, doer })).map((u) => ({ id: u.id }));
  }

  const flipToPull = async (issue: IssueRow): Promise<IssueRow> => {
    await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
    return (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
  };

  it("an issues-only CUSTOM watcher rides issue mail at the head of the source order, drops off pull mail (watch.go:283-289's customOnly arm)", async () => {
    const issue = await seedIssue();
    await setWatch(20, { mode: WatchMode.Custom, includePullRequests: false, includeIssues: true, includeReleases: true });
    const issueIds = (await resolve(issue)).map((u) => u.id);
    expect(issueIds[0]).toBe(20); // still the watcher arm's head — NOT a separate recipient source
    const pullIds = (await resolve(await flipToPull(issue))).map((u) => u.id);
    expect(pullIds).not.toContain(20); // include_pull_requests false
  });

  it("a Normal watcher with include_issues=false drops off issue mail (GetRepoWatchersIDs' watchColName gate)", async () => {
    const issue = await seedIssue();
    await setWatch(20, { mode: WatchMode.Normal, includeIssues: false });
    expect((await resolve(issue)).map((u) => u.id)).not.toContain(20);
  });

  it("a custom watch lifts the onmention preference (mail_issue.go:141-146's customWatchers allowance)", async () => {
    const issue = await seedIssue();
    // The plain Normal seed does NOT lift onmention (the pre-mode drop arm).
    expect((await resolve(issue)).map((u) => u.id)).not.toContain(80);
    await setWatch(80, { mode: WatchMode.Custom, includePullRequests: false, includeIssues: true, includeReleases: true });
    const issueIds = (await resolve(issue)).map((u) => u.id);
    expect(issueIds).toContain(80); // issues custom watch → the onmention allowance
    expect((await resolve(await flipToPull(issue))).map((u) => u.id)).not.toContain(80); // pulls excluded
  });

  it("an ignorer (mode=Dont) receives nothing — muting outranks their assignee and participant sources (mail_issue.go:87-92)", async () => {
    const issue = await seedIssue();
    await setWatch(20, { mode: WatchMode.Dont });
    await db().insert(issueAssignees).values({ issueId: issue.id, assigneeId: 20 });
    const bare = new IssuesService(env.DB);
    await bare.addComment({ issueId: issue.id, posterId: 20, content: "the ignorer spoke" });
    expect((await resolve(issue)).map((u) => u.id)).not.toContain(20);
  });

  it("ignorers still visit under the WIP gate (upstream's ignorers block sits OUTSIDE the WIP if, mail_issue.go:85-92)", async () => {
    const issue = await seedIssue("WIP: draft thing");
    await flipToPull(issue);
    await setWatch(20, { mode: WatchMode.Dont });
    await db().insert(issueAssignees).values({ issueId: issue.id, assigneeId: 20 });
    expect((await resolve(issue)).map((u) => u.id)).not.toContain(20);
  });

  it("the WIP gate empties the custom set — an onmention custom watcher gets no allowance on a WIP pull", async () => {
    const issue = await seedIssue("WIP: draft thing");
    const fresh = await flipToPull(issue);
    await setWatch(80, { mode: WatchMode.Custom, includePullRequests: true, includeIssues: true, includeReleases: true });
    expect((await resolve(fresh)).map((u) => u.id)).not.toContain(80);
  });
});

// ---------------------------------------------------------------------------
// The vertical surface: write -> outbox rows -> consumer
// ---------------------------------------------------------------------------

describe("addComment notify arm — the CreateIssueComment receiver, end to end", () => {
  it("the write lands one outbox row per recipient with the right dedupe key + one queue message each", async () => {
    const issue = await seedIssue();
    const mailEnv = armedEnv();
    const service = new IssuesService(env.DB, mailEnv);
    const comment = await service.addComment({ issueId: issue.id, posterId: 60, content: "hello world" });

    const rows = await db().select().from(emailOutbox).all();
    expect(rows).toHaveLength(5);
    const ids = new Set(rows.map((row) => row.toAddr));
    expect(ids).toEqual(
      new Set(["rw@example.com", "poster@example.com", "as@example.com", "part@example.com", "iw@example.com"]),
    );
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.fromAddress).toBe("noreply@example.com");
      expect(row.fromDisplayName).toBe("doer");
      expect(row.subject).toBe(`Re: [repoowner/repo] Issue title (#${issue.index})`);
      expect(row.info).toBe(`Subject: Re: [repoowner/repo] Issue title (#${issue.index}), issue comments`);
      expect(row.dedupeKey).toBe(`issue-comment:${comment.id}:${recipientIdOf(row)}`);
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      expect(headers["Message-ID"]).toBe(
        `<repoowner/repo/issues/${issue.index}/comment/${comment.id}@mail.example>`,
      );
      expect(headers["In-Reply-To"]).toBe(`<repoowner/repo/issues/${issue.index}@mail.example>`);
      expect(headers["X-Gitea-Sender"]).toBe("doer");
      expect(headers["X-Gitea-Reason"]).toBe("issue");
      expect(headers["List-ID"]).toBe("repoowner/repo <repo.repoowner.mail.example>");
      expect(headers["X-Mailer"]).toBe("Gitea");
      // The rendered body rides the SAME template the consumer sends.
      expect(row.bodyHtml).toContain(`<p>hello world</p>`);
      expect(row.bodyHtml).toContain(
        `<a href="https://mail.example/repoowner/repo/issues/${issue.index}#issuecomment-${comment.id}">#${issue.index}</a>`,
      );
    }

    const spy = mailEnv.REPO_TASKS as unknown as { sends: number; sendBodies: MailOutboxMessage[] };
    expect(spy.sends).toBe(5);
    for (const body of spy.sendBodies) {
      expect(isMailOutboxMessage(body)).toBe(true);
      expect(rows.some((row) => row.id === body.mailId)).toBe(true);
    }
  });

  it("the queued message consumes to 'sent' through the landed consumer arm", async () => {
    const issue = await seedIssue();
    const mailEnv = armedEnv();
    const service = new IssuesService(env.DB, mailEnv);
    await service.addComment({ issueId: issue.id, posterId: 60, content: "hello world" });
    const spy = mailEnv.REPO_TASKS as unknown as { sendBodies: MailOutboxMessage[] };
    const outcome = await processMailOutbox(mailEnv, spy.sendBodies[0]!);
    expect(outcome).toEqual({ kind: "sent" });
    const row = await db().select().from(emailOutbox).where(eq(emailOutbox.id, spy.sendBodies[0]!.mailId)).get();
    expect(row!.status).toBe("sent");
    expect(row!.sentAt).toBeInstanceOf(Date);
  });

  it("the PR twin: is_pull flips the reason header and the WIP gate drops the repo watchers", async () => {
    const issue = await seedIssue("WIP: draft thing");
    await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
    const mailEnv = armedEnv();
    const service = new IssuesService(env.DB, mailEnv);
    await service.addComment({ issueId: issue.id, posterId: 60, content: "wip comment" });
    const rows = await db().select().from(emailOutbox).all();
    // Repo watchers 20/70/80/95/96 all WIP-gated; poster 10, assignee 50,
    // participant 40, issue watcher 30 stay (mail_issue.go:70 — the pull
    // path).
    expect(new Set(rows.map((row) => row.toAddr))).toEqual(
      new Set(["poster@example.com", "as@example.com", "part@example.com", "iw@example.com"]),
    );
    for (const row of rows) {
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      expect(headers["X-Gitea-Reason"]).toBe("pull");
      expect(headers["Message-ID"]).toBe(
        `<repoowner/repo/pulls/${issue.index}/comment/${commentIdOfDedupe(row.dedupeKey)}@mail.example>`,
      );
    }
  });

  it("MAIL_ENABLED off (the default posture) → the write succeeds, ZERO rows (fail-closed)", async () => {
    const issue = await seedIssue();
    const mailEnv = armedEnv({ MAIL_ENABLED: "false" });
    const service = new IssuesService(env.DB, mailEnv);
    const comment = await service.addComment({ issueId: issue.id, posterId: 60, content: "hello" });
    expect(comment.type).toBe(CommentType.Comment);
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
  });

  it("a malformed MAIL_FROM warns and skips — the write still succeeds (SPEC §5.2)", async () => {
    const issue = await seedIssue();
    const mailEnv = armedEnv({ MAIL_FROM: "no address here" });
    const service = new IssuesService(env.DB, mailEnv);
    const comment = await service.addComment({ issueId: issue.id, posterId: 60, content: "hello" });
    expect(comment.id).toBeGreaterThan(0);
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
  });

  it("no env → the arm is off entirely (every existing construction site's posture)", async () => {
    const issue = await seedIssue();
    const service = new IssuesService(env.DB);
    await service.addComment({ issueId: issue.id, posterId: 60, content: "hello" });
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
  });

  it("system-comment types never ride this arm (addComment type override)", async () => {
    const issue = await seedIssue();
    const mailEnv = armedEnv();
    const service = new IssuesService(env.DB, mailEnv);
    await service.addComment({ issueId: issue.id, posterId: 60, content: "label move", type: CommentType.Label });
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
    expect((mailEnv.REPO_TASKS as unknown as { sends: number }).sends).toBe(0);
  });

  it("empty-recipient skip: the comment lands, no rows, no queue sends", async () => {
    const service = new IssuesService(env.DB);
    await seedRepo();
    const issue = await service.createIssue({ repoId: REPO_ID, title: "lonely", content: null, posterId: null });
    const mailEnv = armedEnv();
    const armed = new IssuesService(env.DB, mailEnv);
    const comment = await armed.addComment({ issueId: issue.id, posterId: 60, content: "anyone?" });
    expect(comment.id).toBeGreaterThan(0);
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
    expect((mailEnv.REPO_TASKS as unknown as { sends: number }).sends).toBe(0);
  });
});

/** The recipient id encoded in the row's dedupe key (the LAST colon part —
 *  every family ends `:<recipientId>`; the prefix assertion lives in the
 *  per-arm tests). */
function recipientIdOf(row: { dedupeKey: string | null }): number {
  const id = Number((row.dedupeKey ?? "").split(":").at(-1));
  expect(Number.isInteger(id)).toBe(true);
  return id;
}

/** The comment id encoded in the row's dedupe key. */
function commentIdOfDedupe(dedupeKey: string | null): number {
  const id = Number(dedupeParts({ dedupeKey })[1]);
  expect(Number.isInteger(id)).toBe(true);
  return id;
}

function dedupeParts(row: { dedupeKey: string | null }): string[] {
  const parts = (row.dedupeKey ?? "").split(":");
  expect(parts[0]).toBe("issue-comment");
  return parts;
}

// ---------------------------------------------------------------------------
// The NewIssue arm (notify.go:53-58) — MailParticipants with
// ActionCreateIssue, doer = issue.Poster, comment = nil
// ---------------------------------------------------------------------------

describe("notifyIssueCreated — the NewIssue receiver", () => {
  it("the thread-root mail: no Re: prefix, plain Message-ID == In-Reply-To == References, no anchor in the link", async () => {
    const issue = await seedIssue();
    const now = new Date(1_700_000_000_000);
    const mailEnv = armedEnv();
    const poster = (await db().select().from(users).where(eq(users.id, 10)).get())!;
    const outcome = await notifyIssueCreated(mailEnv, { issue, doer: poster }, { now });
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    // Recipients over the seeded fixture issue: repo watcher 20, assignee 50,
    // participant 40, issue watcher 30 — the POSTER is the doer here
    // (notify.go:55 passes issue.Poster) and is excluded by mail_issue.go:
    // 94-97 (4 recipients, not 5).
    expect(new Set(rows.map((row) => row.toAddr))).toEqual(
      new Set(["rw@example.com", "as@example.com", "part@example.com", "iw@example.com"]),
    );
    for (const row of rows) {
      expect(row.subject).toBe(`[repoowner/repo] ${issue.title} (#${issue.index})`); // NO "Re: "
      expect(row.info).toBe(`Subject: [repoowner/repo] ${issue.title} (#${issue.index}), issue comments`);
      expect(row.dedupeKey).toBe(`issue-new:${issue.id}:${recipientIdOf(row)}`);
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      // ActionCreateIssue has NO Message-ID extra (mail_issue_common.go:285-294;
      // the mail_test.go:412 fixture) — the new mail IS the thread root, so all
      // three ids coincide (mail_test.go:127-133 pins the coincidence).
      expect(headers["Message-ID"]).toBe(`<repoowner/repo/issues/${issue.index}@mail.example>`);
      expect(headers["In-Reply-To"]).toBe(`<repoowner/repo/issues/${issue.index}@mail.example>`);
      expect(headers["References"]).toBe(`<repoowner/repo/issues/${issue.index}@mail.example>`);
      expect(headers["X-Gitea-Sender"]).toBe("poster");
      // The link carries no comment anchor (Comment nil, mail_issue_common.go:60-64).
      expect(row.bodyHtml).toContain(
        `<a href="https://mail.example/repoowner/repo/issues/${issue.index}">#${issue.index}</a>`,
      );
      expect(row.bodyHtml).not.toContain("issuecomment-");
      // The body IS the issue content (MailParticipants keeps it for the new arm).
      expect(row.bodyHtml).toContain("<p>body</p>");
    }
  });

  it("an empty description renders the mail.issue.action.new locale line instead", async () => {
    const service = new IssuesService(env.DB);
    await seedRepo();
    await db().insert(repoWatchers).values({ repoId: REPO_ID, userId: 20 });
    const issue = await service.createIssue({ repoId: REPO_ID, title: "empty", content: null, posterId: 10 });
    const mailEnv = armedEnv();
    const poster = (await db().select().from(users).where(eq(users.id, 10)).get())!;
    await notifyIssueCreated(mailEnv, { issue, doer: poster }, {});
    const rows = await db().select().from(emailOutbox).all();
    // Watcher 20 is the only source left once the poster/doer is excluded.
    expect(rows.map((row) => row.toAddr)).toEqual(["rw@example.com"]);
    for (const row of rows) {
      expect(row.bodyHtml).toContain("<b>poster</b> created #1.");
    }
  });

  it("consumes to 'sent' through the landed consumer arm", async () => {
    const issue = await seedIssue();
    const mailEnv = armedEnv();
    const poster = (await db().select().from(users).where(eq(users.id, 10)).get())!;
    await notifyIssueCreated(mailEnv, { issue, doer: poster }, {});
    const spy = mailEnv.REPO_TASKS as unknown as { sendBodies: MailOutboxMessage[] };
    const outcome = await processMailOutbox(mailEnv, spy.sendBodies[0]!);
    expect(outcome).toEqual({ kind: "sent" });
  });
});

// ---------------------------------------------------------------------------
// The IssueChangeStatus arm (notify.go:59-76) — MailParticipants with the
// close/reopen family (IsPull picks the PullRequest constants), doer = the
// actor; MailParticipants empties the content (mail_issue.go:180-185)
// ---------------------------------------------------------------------------

describe("notifyIssueStatusChanged — the IssueChangeStatus receiver", () => {
  it("close: Re: subject, /close/<ms> Message-ID over the plain thread reference, the closed action line as the body", async () => {
    const issue = await seedIssue();
    const now = new Date(1_700_000_000_000);
    const mailEnv = armedEnv();
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const outcome = await notifyIssueStatusChanged(mailEnv, { issue, doer, isClosed: true }, { now });
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    expect(new Set(rows.map((row) => row.toAddr))).toEqual(
      new Set(["rw@example.com", "poster@example.com", "as@example.com", "part@example.com", "iw@example.com"]),
    );
    for (const row of rows) {
      expect(row.subject).toBe(`Re: [repoowner/repo] ${issue.title} (#${issue.index})`);
      expect(row.info).toBe(`Subject: Re: [repoowner/repo] ${issue.title} (#${issue.index}), issue comments`);
      expect(row.dedupeKey).toBe(`issue-status:${issue.id}:close:${now.getTime()}:${recipientIdOf(row)}`);
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      // The close extra rides the compose-time unixMilli (mail_issue_common.go:
      // 286-289; the mail_test.go:446 fixture pins the /close/ prefix); the
      // thread reference stays plain (:165 — generated with ActionType(0)).
      expect(headers["Message-ID"]).toBe(`<repoowner/repo/issues/${issue.index}/close/${now.getTime()}@mail.example>`);
      expect(headers["In-Reply-To"]).toBe(`<repoowner/repo/issues/${issue.index}@mail.example>`);
      expect(headers["References"]).toBe(`<repoowner/repo/issues/${issue.index}@mail.example>`);
      expect(headers["X-Gitea-Sender"]).toBe("doer");
      // The content is EMPTIED for close (mail_issue.go:180-185): the body is
      // the action line, not the issue description.
      expect(row.bodyHtml).toContain("<b>doer</b> closed #1.");
      expect(row.bodyHtml).not.toContain("<p>body</p>");
    }
  });

  it("reopen: the /reopen/<ms> extra and the reopened line (the :462 fixture twin)", async () => {
    const issue = await seedIssue();
    const now = new Date(1_700_000_000_123);
    const mailEnv = armedEnv();
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    await notifyIssueStatusChanged(mailEnv, { issue, doer, isClosed: false }, { now });
    const rows = await db().select().from(emailOutbox).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      expect(headers["Message-ID"]).toBe(`<repoowner/repo/issues/${issue.index}/reopen/${now.getTime()}@mail.example>`);
      expect(row.bodyHtml).toContain("<b>doer</b> reopened #1.");
      expect(row.dedupeKey).toBe(`issue-status:${issue.id}:reopen:${now.getTime()}:${recipientIdOf(row)}`);
    }
  });

  it("the pull twin: /pulls/ path, reason 'pull', the WIP gate still drops the repo watchers", async () => {
    const issue = await seedIssue("WIP: draft thing");
    await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
    const fresh = (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
    const now = new Date(1_700_000_000_000);
    const mailEnv = armedEnv();
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    await notifyIssueStatusChanged(mailEnv, { issue: fresh, doer, isClosed: true }, { now });
    const rows = await db().select().from(emailOutbox).all();
    expect(new Set(rows.map((row) => row.toAddr))).toEqual(
      new Set(["poster@example.com", "as@example.com", "part@example.com", "iw@example.com"]),
    );
    for (const row of rows) {
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      expect(headers["X-Gitea-Reason"]).toBe("pull");
      expect(headers["Message-ID"]).toBe(`<repoowner/repo/pulls/${issue.index}/close/${now.getTime()}@mail.example>`);
      expect(row.subject).toBe(`Re: [repoowner/repo] WIP: draft thing (#${issue.index})`);
    }
  });

  it("MAIL_ENABLED off and disabled recipients behave like the comment arm", async () => {
    const issue = await seedIssue();
    const off = armedEnv({ MAIL_ENABLED: "false" });
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    expect((await notifyIssueStatusChanged(off, { issue, doer, isClosed: true }, {})).outcome).toBe("disabled");
    const malformed = armedEnv({ MAIL_FROM: "no address here" });
    expect((await notifyIssueStatusChanged(malformed, { issue, doer, isClosed: true }, {})).outcome).toBe("misconfigured");
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The NewPullRequest arm (notify.go:88-93) — MailParticipants over the PR's
// issue row with ActionCreatePullRequest, doer = pr.Issue.Poster; the
// repo-watcher WIP exception (mail_issue.go:67-76) is its one unique
// behavior (SPEC §10)
// ---------------------------------------------------------------------------

describe("notifyPullRequestCreated — the NewPullRequest receiver", () => {
  /** seedIssue + the is_pull flip (the PR twin of the issue fixtures). */
  async function seedPull(title = "a pull"): Promise<IssueRow> {
    const issue = await seedIssue(title);
    await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
    return (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
  }

  it("the pull thread-root mail: no Re: prefix, the PLAIN /pulls/ Message-ID (the mail_test.go:417-422 'Open Pull' fixture), no anchor, content kept", async () => {
    const pr = await seedPull();
    const mailEnv = armedEnv();
    const poster = (await db().select().from(users).where(eq(users.id, 10)).get())!;
    const outcome = await notifyPullRequestCreated(mailEnv, { issue: pr, doer: poster }, { now: new Date(1_700_000_000_000) });
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    // Same resolution core over the seeded fixture: repo watcher 20,
    // assignee 50, participant 40, issue watcher 30 — the POSTER is the
    // doer (notify.go:89 passes pr.Issue.Poster) and is excluded by
    // mail_issue.go:94-97.
    expect(new Set(rows.map((row) => row.toAddr))).toEqual(
      new Set(["rw@example.com", "as@example.com", "part@example.com", "iw@example.com"]),
    );
    for (const row of rows) {
      expect(row.subject).toBe(`[repoowner/repo] ${pr.title} (#${pr.index})`); // NO "Re: "
      expect(row.info).toBe(`Subject: [repoowner/repo] ${pr.title} (#${pr.index}), issue comments`);
      expect(row.dedupeKey).toBe(`pull-new:${pr.id}:${recipientIdOf(row)}`);
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      // ActionCreatePullRequest has NO Message-ID extra (mail_issue_common.go:
      // 285-294's switch has no case for it — the mail_test.go:417-422 "Open
      // Pull" fixture pins the plain prefix); the create mail IS the thread
      // root, so all three ids coincide, In-Reply-To/References generated
      // with ActionType(0) (:165).
      expect(headers["Message-ID"]).toBe(`<repoowner/repo/pulls/${pr.index}@mail.example>`);
      expect(headers["In-Reply-To"]).toBe(`<repoowner/repo/pulls/${pr.index}@mail.example>`);
      expect(headers["References"]).toBe(`<repoowner/repo/pulls/${pr.index}@mail.example>`);
      expect(headers["X-Gitea-Reason"]).toBe("pull");
      expect(headers["X-Gitea-Sender"]).toBe("poster");
      // The link carries no comment anchor and rides /pulls/ (Comment nil,
      // mail_issue_common.go:60-64; Issue.HTMLURL's IsPull half).
      expect(row.bodyHtml).toContain(
        `<a href="https://mail.example/repoowner/repo/pulls/${pr.index}">#${pr.index}</a>`,
      );
      expect(row.bodyHtml).not.toContain("issuecomment-");
      // MailParticipants KEEPS the content for ActionCreatePullRequest (NOT
      // in mail_issue.go:180-185's empty list) — the body IS the
      // description.
      expect(row.bodyHtml).toContain("<p>body</p>");
    }
  });

  it("the create-arm WIP exception: repo watchers stay IN on a WIP pull (the same pull drops them on the comment/status arms)", async () => {
    const pr = await seedPull("WIP: draft thing");
    const mailEnv = armedEnv();
    const poster = (await db().select().from(users).where(eq(users.id, 10)).get())!;
    await notifyPullRequestCreated(mailEnv, { issue: pr, doer: poster }, {});
    const rows = await db().select().from(emailOutbox).all();
    // Watcher 20 rides (mail_issue.go:70's negation for the create arm);
    // 70 explicit unwatch, 80 onmention, 95 org, 96 prohibited stay out.
    expect(new Set(rows.map((row) => row.toAddr))).toEqual(
      new Set(["rw@example.com", "as@example.com", "part@example.com", "iw@example.com"]),
    );
  });

  it("consumes to 'sent' through the landed consumer arm", async () => {
    const pr = await seedPull();
    const mailEnv = armedEnv();
    const poster = (await db().select().from(users).where(eq(users.id, 10)).get())!;
    await notifyPullRequestCreated(mailEnv, { issue: pr, doer: poster }, {});
    const spy = mailEnv.REPO_TASKS as unknown as { sendBodies: MailOutboxMessage[] };
    const outcome = await processMailOutbox(mailEnv, spy.sendBodies[0]!);
    expect(outcome).toEqual({ kind: "sent" });
  });

  it("MAIL_ENABLED off and malformed MAIL_FROM degrade like the sibling arms", async () => {
    const pr = await seedPull();
    const poster = (await db().select().from(users).where(eq(users.id, 10)).get())!;
    const off = armedEnv({ MAIL_ENABLED: "false" });
    expect((await notifyPullRequestCreated(off, { issue: pr, doer: poster }, {})).outcome).toBe("disabled");
    const malformed = armedEnv({ MAIL_FROM: "no address here" });
    expect((await notifyPullRequestCreated(malformed, { issue: pr, doer: poster }, {})).outcome).toBe("misconfigured");
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The IssueChangeTitle arm (notify.go:80-90) — a pull renamed WIP → non-WIP
// mails ActionPullRequestReadyForReview over the participants funnel; the
// receiver's gate keys on (oldTitle WIP) && (current title not WIP)
// ---------------------------------------------------------------------------

describe("notifyIssueTitleChanged — the IssueChangeTitle receiver", () => {
  /** seedIssue + the is_pull flip (the arm is pull-only upstream). */
  async function seedPull(title: string): Promise<IssueRow> {
    const issue = await seedIssue(title);
    await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
    return (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
  }

  it("the WIP → ready transition mail: Re: subject, the /ready/<ms> Message-ID over the plain thread reference, the kept description rides BELOW the ready line", async () => {
    const pr = await seedPull("WIP: draft thing");
    // The UPDATED row (the receiver runs post-update, issue.go:127 — the
    // gate's IsWorkInProgress half recomputes on the NEW title).
    const updated = { ...pr, title: "ready thing" };
    const now = new Date(1_700_000_000_000);
    const mailEnv = armedEnv();
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const outcome = await notifyIssueTitleChanged(mailEnv, { issue: updated, doer, oldTitle: "WIP: draft thing" }, { now });
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    // The FULL source set — the repo watchers RIDE because the new title is
    // non-WIP (resolveIssueMailRecipients' gate recomputes on it); doer 60
    // is excluded (mail_issue.go:94-97).
    expect(new Set(rows.map((row) => row.toAddr))).toEqual(
      new Set(["rw@example.com", "poster@example.com", "as@example.com", "part@example.com", "iw@example.com"]),
    );
    for (const row of rows) {
      expect(row.subject).toBe(`Re: [repoowner/repo] ready thing (#${pr.index})`);
      expect(row.info).toBe(`Subject: Re: [repoowner/repo] ready thing (#${pr.index}), issue comments`);
      expect(row.dedupeKey).toBe(`pull-ready:${pr.id}:ready_for_review:${now.getTime()}:${recipientIdOf(row)}`);
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      // The switch's dedicated case (mail_issue_common.go:303-304).
      expect(headers["Message-ID"]).toBe(`<repoowner/repo/pulls/${pr.index}/ready/${now.getTime()}@mail.example>`);
      expect(headers["In-Reply-To"]).toBe(`<repoowner/repo/pulls/${pr.index}@mail.example>`);
      expect(headers["References"]).toBe(`<repoowner/repo/pulls/${pr.index}@mail.example>`);
      expect(headers["X-Gitea-Reason"]).toBe("pull");
      expect(headers["X-Gitea-Sender"]).toBe("doer");
      // ActionPullRequestReadyForReview is NOT in MailParticipants' empty
      // list (mail_issue.go:179-185): the ready line renders above the kept
      // description.
      expect(row.bodyHtml).toContain("<b>doer</b> marked this pull request ready for review.");
      expect(row.bodyHtml).toContain("<p>body</p>");
    }
  });

  it("an empty description renders the ready line alone (byte-identical to the close/reopen shape)", async () => {
    const pr = await seedPull("WIP: lonely");
    await env.DB.prepare("UPDATE issues SET content = '' WHERE id = ?").bind(pr.id).run();
    const updated = { ...(await db().select().from(issues).where(eq(issues.id, pr.id)).get())!, title: "ready now" };
    const mailEnv = armedEnv();
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    await notifyIssueTitleChanged(mailEnv, { issue: updated, doer, oldTitle: "WIP: lonely" }, {});
    const rows = await db().select().from(emailOutbox).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.bodyHtml).toContain("<b>doer</b> marked this pull request ready for review.");
      expect(row.bodyHtml).not.toContain("<p>body</p>");
    }
  });

  it("gate-offs — a plain-issue rename, a non-WIP old title, a still-WIP new title: the receiver returns before MailParticipants", async () => {
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    // Non-pull: notify.go:85's issue.IsPull conjunct.
    const issue = await seedIssue("WIP: not a pull");
    expect(
      (await notifyIssueTitleChanged(armedEnv(), { issue: { ...issue, title: "renamed" }, doer, oldTitle: "WIP: not a pull" }, {})).outcome,
    ).toBe("no-recipients");
    // The same issue as a pull: old title not WIP → nothing; new title
    // still WIP → nothing.
    await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
    const pr = (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
    expect(
      (await notifyIssueTitleChanged(armedEnv(), { issue: { ...pr, title: "other" }, doer, oldTitle: "already ready" }, {})).outcome,
    ).toBe("no-recipients");
    expect(
      (await notifyIssueTitleChanged(armedEnv(), { issue: { ...pr, title: "WIP: still draft" }, doer, oldTitle: "WIP: still draft" }, {})).outcome,
    ).toBe("no-recipients");
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
  });

  it("consumes to 'sent' through the landed consumer arm; MAIL off / malformed degrade like the siblings", async () => {
    const pr = await seedPull("WIP: draft thing");
    const mailEnv = armedEnv();
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    await notifyIssueTitleChanged(mailEnv, { issue: { ...pr, title: "ready thing" }, doer, oldTitle: "WIP: draft thing" }, {});
    const spy = mailEnv.REPO_TASKS as unknown as { sendBodies: MailOutboxMessage[] };
    expect(await processMailOutbox(mailEnv, spy.sendBodies[0]!)).toEqual({ kind: "sent" });
    const off = armedEnv({ MAIL_ENABLED: "false" });
    expect((await notifyIssueTitleChanged(off, { issue: { ...pr, title: "ready thing" }, doer, oldTitle: "WIP: draft thing" }, {})).outcome).toBe("disabled");
    const malformed = armedEnv({ MAIL_FROM: "no address here" });
    expect((await notifyIssueTitleChanged(malformed, { issue: { ...pr, title: "ready thing" }, doer, oldTitle: "WIP: draft thing" }, {})).outcome).toBe("misconfigured");
  });
});

// ---------------------------------------------------------------------------
// The IssueChangeAssignee arm (notify.go:119-127 → SendIssueAssignedMail,
// mail_issue.go:200-232) — the one arm whose sole recipient is NOT the
// participants resolution: the added assignee, gated and mailed directly
// ---------------------------------------------------------------------------

describe("notifyIssueAssigneeChanged — the IssueChangeAssignee receiver", () => {
  /** A type-9 assignee comment over the seeded issue (the mail's anchor +
   *  Message-ID comment). */
  async function seedAssigneeComment(issueId: number, assigneeId: number, removed = false) {
    const rows = await db()
      .insert(comments)
      .values({
        type: CommentType.Assignees,
        posterId: 60,
        issueId,
        assigneeId,
        removedAssignee: removed ? 1 : 0,
        content: "",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })
      .returning();
    return rows[0]!;
  }

  it("the add mail: ONE row to the assignee, the assigned.tmpl line with the type-9 anchor, the /comment/<id> Message-ID, 'issue assigned' info", async () => {
    const issue = await seedIssue();
    const comment = await seedAssigneeComment(issue.id, 50);
    const assignee = (await db().select().from(users).where(eq(users.id, 50)).get())!;
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const outcome = await notifyIssueAssigneeChanged(armedEnv(), { issue, comment, doer, assignee, removed: false }, { now: new Date(1_700_000_000_000) });
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.toAddr).toBe("as@example.com");
    expect(row.subject).toBe(`Re: [repoowner/repo] ${issue.title} (#${issue.index})`);
    // SendIssueAssignedMail's batch info (mail_issue.go:222).
    expect(row.info).toBe(`Subject: Re: [repoowner/repo] ${issue.title} (#${issue.index}), issue assigned`);
    expect(row.dedupeKey).toBe(`issue-assigned:${comment.id}:50`);
    const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
    // Comment non-nil: the Message-ID carries the type-9 comment
    // (generateMessageIDForIssue's comment branch); the thread reference
    // stays plain (generated with ActionType(0)).
    expect(headers["Message-ID"]).toBe(`<repoowner/repo/issues/${issue.index}/comment/${comment.id}@mail.example>`);
    expect(headers["In-Reply-To"]).toBe(`<repoowner/repo/issues/${issue.index}@mail.example>`);
    expect(headers["References"]).toBe(`<repoowner/repo/issues/${issue.index}@mail.example>`);
    expect(headers["X-Gitea-Recipient"]).toBe("assignee");
    expect(headers["X-Gitea-Sender"]).toBe("doer");
    expect(headers["X-Gitea-Reason"]).toBe("issue");
    // assigned.tmpl's locale line — NO <b> wrapper, the single-quoted
    // HTMLFormat anchors, the #issuecomment anchor riding .Link.
    expect(row.bodyHtml).toContain(
      `doer assigned you to issue <a href='https://mail.example/repoowner/repo/issues/${issue.index}#issuecomment-${comment.id}'>#${issue.index}</a> in repository <a href='https://mail.example/repoowner/repo'>repoowner/repo</a>.`,
    );
    expect(row.bodyHtml).not.toContain("<b>doer</b>");
    expect(row.bodyHtml).not.toContain("<p>body</p>");
  });

  it("the pull twin: 'assigned you to pull request', the /pulls/ path and the pull reason", async () => {
    const issue = await seedIssue();
    await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
    const fresh = (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
    const comment = await seedAssigneeComment(issue.id, 50);
    const assignee = (await db().select().from(users).where(eq(users.id, 50)).get())!;
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    await notifyIssueAssigneeChanged(armedEnv(), { issue: fresh, comment, doer, assignee, removed: false }, {});
    const rows = await db().select().from(emailOutbox).all();
    expect(rows).toHaveLength(1);
    const headers = JSON.parse(rows[0]!.headers ?? "{}") as Record<string, string>;
    expect(headers["X-Gitea-Reason"]).toBe("pull");
    expect(headers["Message-ID"]).toBe(`<repoowner/repo/pulls/${issue.index}/comment/${comment.id}@mail.example>`);
    expect(rows[0]!.bodyHtml).toContain("doer assigned you to pull request <a href='");
  });

  it("the receiver gates — removed, self-assign, disabled preference, non-mailable mail NOTHING; onmention PASSES (notify.go:121's only-disabled gate)", async () => {
    const issue = await seedIssue();
    const comment = await seedAssigneeComment(issue.id, 50);
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const assignee = (await db().select().from(users).where(eq(users.id, 50)).get())!;
    const env0 = armedEnv();
    expect((await notifyIssueAssigneeChanged(env0, { issue, comment, doer, assignee, removed: true }, {})).outcome).toBe("no-recipients");
    expect((await notifyIssueAssigneeChanged(env0, { issue, comment, doer, assignee: doer, removed: false }, {})).outcome).toBe("no-recipients");
    await db().insert(userSettings).values({ userId: 50, emailNotificationsPreference: "disabled" });
    expect((await notifyIssueAssigneeChanged(env0, { issue, comment, doer, assignee, removed: false }, {})).outcome).toBe("no-recipients");
    await db().delete(userSettings).where(eq(userSettings.userId, 50));
    // Non-mailable: the SendIssueAssignedMail langMap filter (frozen 96).
    const frozen = (await db().select().from(users).where(eq(users.id, 96)).get())!;
    expect((await notifyIssueAssigneeChanged(env0, { issue, comment, doer, assignee: frozen, removed: false }, {})).outcome).toBe("no-recipients");
    // onmention is NOT disabled — the assigned mail reaches them (the
    // participants prefilter's enabled/andyourown rule does NOT apply here).
    const mentioner = (await db().select().from(users).where(eq(users.id, 80)).get())!;
    expect(
      (await notifyIssueAssigneeChanged(env0, { issue, comment, doer, assignee: mentioner, removed: false }, {})).outcome,
    ).toBe("enqueued");
    expect((await db().select().from(emailOutbox).all()).map((r) => r.toAddr)).toEqual(["om@example.com"]);
  });

  it("consumes to 'sent'; MAIL off / malformed degrade like the siblings", async () => {
    const issue = await seedIssue();
    const comment = await seedAssigneeComment(issue.id, 50);
    const assignee = (await db().select().from(users).where(eq(users.id, 50)).get())!;
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const mailEnv = armedEnv();
    await notifyIssueAssigneeChanged(mailEnv, { issue, comment, doer, assignee, removed: false }, {});
    const spy = mailEnv.REPO_TASKS as unknown as { sendBodies: MailOutboxMessage[] };
    expect(await processMailOutbox(mailEnv, spy.sendBodies[0]!)).toEqual({ kind: "sent" });
    const off = armedEnv({ MAIL_ENABLED: "false" });
    expect((await notifyIssueAssigneeChanged(off, { issue, comment, doer, assignee, removed: false }, {})).outcome).toBe("disabled");
    const malformed = armedEnv({ MAIL_FROM: "no address here" });
    expect((await notifyIssueAssigneeChanged(malformed, { issue, comment, doer, assignee, removed: false }, {})).outcome).toBe("misconfigured");
  });
});

// ---------------------------------------------------------------------------
// The MergePullRequest arm — the winning-merge mail (services/pull/merge.go:
// 385-412 markAsMergedPostProcess → notify.go:138-146 → MailParticipants with
// ActionMergePullRequest). The AutoMergePullRequest twin is STAGED
// (unreachable — no scheduled-merge store; SPEC §1.3).
// ---------------------------------------------------------------------------

describe("notifyMergePullRequest — the MergePullRequest receiver", () => {
  /** A PR issue over the seeded fixture (IsPull picks the pulls path
   *  everywhere; baseBranch feeds the merge line's %[3]s). */
  async function seedPullIssue(title = "Merge me"): Promise<IssueRow> {
    const issue = await seedIssue(title);
    await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
    return (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
  }

  it("the merge mail: Re: subject, the /merge/<ms> Message-ID over the plain reference, the merge line with the base branch, the emptied content, 'issue comments' info, pull-merge dedupe", async () => {
    const issue = await seedPullIssue();
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const now = new Date(1_700_000_045_678);
    const outcome = await notifyMergePullRequest(armedEnv(), { issue, doer, baseBranch: "main" }, { now });
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    // The participants resolution over the seeded fixture: repo watcher 20
    // first, then poster 10, assignee 50, participant 40, issue watcher 30;
    // unwatcher 70 and the doer (60) excluded.
    expect(rows.map((row) => row.toAddr)).toEqual(["rw@example.com", "poster@example.com", "as@example.com", "part@example.com", "iw@example.com"]);
    for (const row of rows) {
      expect(row.subject).toBe(`Re: [repoowner/repo] ${issue.title} (#${issue.index})`);
      expect(row.info).toBe(`Subject: Re: [repoowner/repo] ${issue.title} (#${issue.index}), issue comments`);
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      expect(headers["Message-ID"]).toBe(`<repoowner/repo/pulls/${issue.index}/merge/${now.getTime()}@mail.example>`);
      expect(headers["In-Reply-To"]).toBe(`<repoowner/repo/pulls/${issue.index}@mail.example>`);
      expect(headers["References"]).toBe(`<repoowner/repo/pulls/${issue.index}@mail.example>`);
      expect(headers["X-Gitea-Reason"]).toBe("pull");
      // MailParticipants empties the content for merge (mail_issue.go:184) —
      // the merge line IS the body; the issue description never renders.
      expect(row.bodyHtml).toContain(`<b>doer</b> merged #${issue.index} into main.`);
      expect(row.bodyHtml).not.toContain("<p>body</p>");
      expect(row.dedupeKey).toMatch(new RegExp(`^pull-merge:${issue.id}:merge:${now.getTime()}:\\d+$`));
    }
  });

  it("the merge line escapes the base branch like every plain-string locale arg (TrHTML)", async () => {
    const issue = await seedPullIssue();
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    await notifyMergePullRequest(armedEnv(), { issue, doer, baseBranch: 'rel<"1">&main' }, {});
    const rows = await db().select().from(emailOutbox).all();
    expect(rows[0]!.bodyHtml).toContain("merged #");
    expect(rows[0]!.bodyHtml).toContain("into rel&lt;&quot;1&quot;&gt;&amp;main.");
    expect(rows[0]!.bodyHtml).not.toContain('rel<"1">');
  });

  it("the WIP-titled pull's merge drops the repo watchers (pullCreate NOT set — mail_issue.go:67-76 without the create exception)", async () => {
    const issue = await seedPullIssue("WIP: merge me");
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const outcome = await notifyMergePullRequest(armedEnv(), { issue, doer, baseBranch: "main" }, {});
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    expect(rows.map((row) => row.toAddr)).not.toContain("rw@example.com");
    expect(rows.map((row) => row.toAddr)).toContain("poster@example.com");
  });

  it("consumes to 'sent'; MAIL off / malformed degrade like the siblings", async () => {
    const issue = await seedPullIssue();
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const mailEnv = armedEnv();
    await notifyMergePullRequest(mailEnv, { issue, doer, baseBranch: "main" }, {});
    const spy = mailEnv.REPO_TASKS as unknown as { sendBodies: MailOutboxMessage[] };
    expect(await processMailOutbox(mailEnv, spy.sendBodies[0]!)).toEqual({ kind: "sent" });
    const off = armedEnv({ MAIL_ENABLED: "false" });
    expect((await notifyMergePullRequest(off, { issue, doer, baseBranch: "main" }, {})).outcome).toBe("disabled");
    const malformed = armedEnv({ MAIL_FROM: "no address here" });
    expect((await notifyMergePullRequest(malformed, { issue, doer, baseBranch: "main" }, {})).outcome).toBe("misconfigured");
  });
});

describe("mergePullRequest's winning-merge emit — the real merge flow (pull-engine.ts, markAsMergedPostProcess shape)", () => {
  /**
   * The engine cell's minimal mergeable state: ONE commit on refs/heads/main
   * (the manually-merged ancestor check only needs the base tip present).
   * Each call seeds its OWN repo row + cell name — the DO namespace survives
   * across tests, so a shared name would collide on refs/heads/main.
   */
  async function seedMergablePull(repoId: string, ownerNamespace: string, slug: string): Promise<{
    issue: IssueRow;
    pr: PullRequestRow;
    pair: { repo: typeof repositories.$inferSelect; owner: typeof users.$inferSelect };
    mainTip: string;
  }> {
    await db().insert(repositories).values({
      id: repoId,
      storageKey: `r_${repoId}`,
      ownerNamespace,
      ownerId: 1,
      slug,
      visibility: "public",
      status: "ready",
    });
    await db().insert(repoWatchers).values({ repoId, userId: 20 });
    const service = new IssuesService(env.DB); // bare — no notify on setup writes
    const { issue, pullRequest } = await service.createPullRequest({
      repoId,
      title: "engine merge",
      content: "desc",
      posterId: 10,
      headRepoId: repoId,
      baseBranch: "main",
      headBranch: "topic",
    });
    const pair = {
      repo: (await db().select().from(repositories).where(eq(repositories.id, repoId)).get())!,
      owner: (await db().select().from(users).where(eq(users.id, 1)).get())!,
    };
    const cell = engineCell(env, pair.repo);
    const tree = emptyTree();
    const commit = serializeCommit({
      tree: tree.oid,
      parents: [],
      author: { name: "Seed", email: "seed@example.com", time: 1_700_000_000, tz: "+0000" },
      committer: { name: "Seed", email: "seed@example.com", time: 1_700_000_000, tz: "+0000" },
      message: "seed main\n",
    });
    const put = await cell.putApiObjects([tree, commit]);
    if (put.tag !== "ok") throw new Error(`seed put failed: ${put.tag}`);
    const moved = await cell.commitApiChange({ ref: "refs/heads/main", expectedOldOid: ZERO_OID, newOid: commit.oid });
    if (moved.tag !== "committed") throw new Error(`seed ref move failed: ${moved.tag}`);
    return { issue, pr: pullRequest, pair, mainTip: commit.oid };
  }

  /** A hono Context over the ARMED bindings (the merged env satisfies the
   *  Bindings interface; the literal-typed vars carry the armed values at
   *  runtime; APP_URL pinned to the hub's test origin). mergePullRequest
   *  reads env (the engine cell + the mail vars), never authUser
   *  (deleteBranchAfterMerge is false in these arms). */
  function mergeContext(bindings: ApiEnv["Bindings"]): Context<ApiEnv> {
    return new Context(new Request("https://mail.example/repos/x/y/pulls/1/merge"), { env: bindings });
  }

  function armedBindings(): ApiEnv["Bindings"] {
    return Object.assign({}, env, {
      APP_URL: "https://mail.example",
      MAIL_ENABLED: "true",
      MAIL_PROVIDER: "dummy",
      MAIL_FROM: "Gitea <noreply@example.com>",
      REPO_TASKS: spyQueue(),
    });
  }

  it("an armed merge lands pull-merge rows for the landing winner — and NO issue-status rows (the bare close never mails)", async () => {
    const { issue, pr, pair, mainTip } = await seedMergablePull("510", "repoowner", "merge-mail-a");
    const now = new Date(1_700_000_123_456);
    const { commitOid } = await mergePullRequest(mergeContext(armedBindings()), pair, issue, pr, {
      style: "manually-merged",
      message: "",
      deleteBranchAfterMerge: false,
      mergeCommitId: mainTip,
      doerId: 60,
      now,
    });
    expect(commitOid).toBe(mainTip);
    const rows = await db().select().from(emailOutbox).all();
    expect(rows).toHaveLength(2); // watcher 20 + poster 10; the doer excluded
    expect(rows.map((row) => row.toAddr)).toEqual(["rw@example.com", "poster@example.com"]);
    for (const row of rows) {
      expect(row.dedupeKey).toMatch(new RegExp(`^pull-merge:${issue.id}:merge:${now.getTime()}:\\d+$`));
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      expect(headers["Message-ID"]).toBe(`<repoowner/merge-mail-a/pulls/${issue.index}/merge/${now.getTime()}@mail.example>`);
    }
    // The close service inside the merge is constructed BARE — the merge's
    // ONLY mail is MergePullRequest, never IssueChangeStatus's close
    // (upstream: SetIssueAsClosed is model-level, merge.go:838).
    expect(rows.some((row) => row.dedupeKey?.startsWith(`issue-status:${issue.id}:`))).toBe(false);
  });

  it("the shipped mail-off posture merges with ZERO outbox rows (the emit site's fail-closed tripwire)", async () => {
    const { issue, pr, pair, mainTip } = await seedMergablePull("511", "repoowner", "merge-mail-b");
    const bindings = Object.assign({}, env, { REPO_TASKS: spyQueue() }); // MAIL_ENABLED="false" as shipped
    await mergePullRequest(mergeContext(bindings), pair, issue, pr, {
      style: "manually-merged",
      message: "",
      deleteBranchAfterMerge: false,
      mergeCommitId: mainTip,
      doerId: 60,
      now: new Date(1_700_000_123_456),
    });
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The service-level emit sites — IssuesService.createIssue / createPullRequest
// / closeIssue / reopenIssue (upstream fires from the model layer; the router
// never does)
// ---------------------------------------------------------------------------

describe("IssuesService notify arms — createIssue + close/reopen emits", () => {
  it("createIssue through an armed service lands issue-new rows; the poster/doer exclusion holds", async () => {
    await seedRepo();
    await db().insert(repoWatchers).values([
      { repoId: REPO_ID, userId: 20 },
      { repoId: REPO_ID, userId: 70 },
    ]);
    const now = new Date(1_700_000_000_000);
    const mailEnv = armedEnv();
    const service = new IssuesService(env.DB, mailEnv);
    const issue = await service.createIssue({ repoId: REPO_ID, title: "fresh", content: "desc", posterId: 10, now });
    const rows = await db().select().from(emailOutbox).all();
    // Both repo watchers (20, 70) are sources; poster 10 is the DOER
    // (notify.go:55 passes issue.Poster as the doer) and is excluded.
    expect(rows.map((row) => row.toAddr)).toEqual(["rw@example.com", "un@example.com"]);
    for (const row of rows) {
      expect(row.dedupeKey).toMatch(new RegExp(`^issue-new:${issue.id}:(20|70)$`));
      expect(row.subject).toBe("[repoowner/repo] fresh (#1)");
      expect(row.bodyHtml).toContain("<p>desc</p>");
    }
    expect((mailEnv.REPO_TASKS as unknown as { sends: number }).sends).toBe(2);
  });

  it("createPullRequest through an armed service lands pull-new rows (the NewPullRequest receiver, SPEC §10)", async () => {
    await seedRepo();
    await db().insert(repoWatchers).values([
      { repoId: REPO_ID, userId: 20 },
      { repoId: REPO_ID, userId: 70 },
    ]);
    const now = new Date(1_700_000_000_000);
    const mailEnv = armedEnv();
    const service = new IssuesService(env.DB, mailEnv);
    const { issue } = await service.createPullRequest({
      repoId: REPO_ID,
      title: "a pull",
      content: "pr desc",
      posterId: 10,
      headRepoId: REPO_ID,
      baseBranch: "main",
      headBranch: "topic",
      now,
    });
    const rows = await db().select().from(emailOutbox).all();
    // Both repo watchers are sources; poster 10 is the DOER (notify.go:89
    // passes pr.Issue.Poster) and is excluded.
    expect(rows.map((row) => row.toAddr)).toEqual(["rw@example.com", "un@example.com"]);
    for (const row of rows) {
      expect(row.dedupeKey).toMatch(new RegExp(`^pull-new:${issue.id}:(20|70)$`));
      expect(row.subject).toBe("[repoowner/repo] a pull (#1)"); // NO "Re: "
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      expect(headers["Message-ID"]).toBe(`<repoowner/repo/pulls/${issue.index}@mail.example>`);
      expect(headers["In-Reply-To"]).toBe(`<repoowner/repo/pulls/${issue.index}@mail.example>`);
      expect(headers["X-Gitea-Reason"]).toBe("pull");
      expect(row.bodyHtml).toContain("<p>pr desc</p>");
    }
    expect((mailEnv.REPO_TASKS as unknown as { sends: number }).sends).toBe(2);
  });

  it("closeIssue/reopenIssue through an armed service land issue-status rows (CAS winner only)", async () => {
    const service = new IssuesService(env.DB);
    await seedRepo();
    const issue = await service.createIssue({ repoId: REPO_ID, title: "cycle", content: "x", posterId: 10 });
    const now = new Date(1_700_000_000_000);
    const mailEnv = armedEnv();
    const armed = new IssuesService(env.DB, mailEnv);
    await armed.closeIssue(issue.id, { actorId: 60, now });
    let rows = await db().select().from(emailOutbox).all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.dedupeKey).toBe(`issue-status:${issue.id}:close:${now.getTime()}:${recipientIdOf(row)}`);
      expect(row.bodyHtml).toContain("closed #1.");
    }
    const before = rows.length;
    // The CAS loser (already closed) throws and emits nothing.
    await expect(armed.closeIssue(issue.id, { actorId: 60, now })).rejects.toThrow();
    expect(await db().select().from(emailOutbox).all()).toHaveLength(before);

    const reopenNow = new Date(1_700_000_100_000);
    await armed.reopenIssue(issue.id, { actorId: 60, now: reopenNow });
    rows = await db().select().from(emailOutbox).all();
    const reopenRows = rows.filter((row) => row.dedupeKey?.includes(":reopen:"));
    expect(reopenRows.length).toBeGreaterThan(0);
    for (const row of reopenRows) {
      expect(row.dedupeKey).toBe(`issue-status:${issue.id}:reopen:${reopenNow.getTime()}:${recipientIdOf(row)}`);
      expect(row.bodyHtml).toContain("reopened #1.");
    }
    // A second close cycle gets FRESH keys (the ms rides the key — upstream's
    // own uniqueness mechanism, mail_issue_common.go:286-293); the first
    // close's rows stay (dedupe never overwrites).
    const secondClose = new Date(1_700_000_200_000);
    await armed.closeIssue(issue.id, { actorId: 60, now: secondClose });
    rows = await db().select().from(emailOutbox).all();
    const secondKeys = rows
      .filter((row) => row.dedupeKey?.includes(`:close:${secondClose.getTime()}:`))
      .map((row) => row.dedupeKey);
    expect(secondKeys.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.dedupeKey?.includes(`:close:${now.getTime()}:`))).toBe(true);
  });

  it("no env → both arms are off (every existing construction site's posture)", async () => {
    const service = new IssuesService(env.DB);
    await seedRepo();
    const issue = await service.createIssue({ repoId: REPO_ID, title: "bare", content: null, posterId: 10 });
    await service.closeIssue(issue.id, { actorId: 60 });
    await service.reopenIssue(issue.id, { actorId: 60 });
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
  });

  it("a poster-less create (issue and pull) and an actor-less close skip the mail but keep the writes", async () => {
    const mailEnv = armedEnv();
    const service = new IssuesService(env.DB, mailEnv);
    await seedRepo();
    const issue = await service.createIssue({ repoId: REPO_ID, title: "ghost", content: null, posterId: null });
    expect(issue.id).toBeGreaterThan(0);
    const pr = await service.createPullRequest({
      repoId: REPO_ID,
      title: "ghost pull",
      content: null,
      posterId: null,
      headRepoId: REPO_ID,
      baseBranch: "main",
      headBranch: "topic",
    });
    expect(pr.issue.id).toBeGreaterThan(0);
    await service.closeIssue(issue.id, { actorId: null });
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
    expect((mailEnv.REPO_TASKS as unknown as { sends: number }).sends).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The slice-five emit sites — IssuesService.changeTitle (upstream
// ChangeTitle, issue.go:127) and IssuesService.changeAssignees (upstream
// UpdateAssignees' post-tx notify loops, assignee.go:155-166)
// ---------------------------------------------------------------------------

describe("IssuesService notify arms — changeTitle + changeAssignees emits", () => {
  it("changeTitle through an armed service: the WIP → ready rename lands pull-ready rows; a plain rename lands nothing", async () => {
    const bare = new IssuesService(env.DB);
    await seedRepo();
    await db().insert(repoWatchers).values({ repoId: REPO_ID, userId: 20 });
    const { issue } = await bare.createPullRequest({
      repoId: REPO_ID,
      title: "WIP: draft",
      content: "desc",
      posterId: 10,
      headRepoId: REPO_ID,
      baseBranch: "main",
      headBranch: "topic",
    });
    const now = new Date(1_700_000_000_000);
    const armed = new IssuesService(env.DB, armedEnv());
    const updated = await armed.changeTitle(issue, "ready thing", 60, now);
    expect(updated?.title).toBe("ready thing");
    let rows = await db().select().from(emailOutbox).all();
    // Watcher 20 + poster 10 (the doer 60 is excluded); the write itself
    // (title + the type-10 comment) is changeIssueTitle's, untouched.
    expect(new Set(rows.map((row) => row.toAddr))).toEqual(new Set(["rw@example.com", "poster@example.com"]));
    for (const row of rows) {
      expect(row.dedupeKey).toBe(`pull-ready:${issue.id}:ready_for_review:${now.getTime()}:${recipientIdOf(row)}`);
      expect(row.bodyHtml).toContain("<b>doer</b> marked this pull request ready for review.");
    }
    // A rename with NO WIP transition (either direction non-WIP → non-WIP)
    // mails nothing.
    const before = rows.length;
    await armed.changeTitle(updated!, "other thing", 60, new Date(1_700_000_100_000));
    rows = await db().select().from(emailOutbox).all();
    expect(rows).toHaveLength(before);
  });

  it("changeAssignees through an armed service: each add lands issue-assigned (the webhook emitter still rides the same receiver); removals mail nothing", async () => {
    const bare = new IssuesService(env.DB);
    await seedRepo();
    const issue = await bare.createIssue({ repoId: REPO_ID, title: "assigned", content: null, posterId: 10 });
    const mailEnv = armedEnv();
    const armed = new IssuesService(env.DB, mailEnv);
    const found = {
      repo: (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!,
      owner: (await db().select().from(users).where(eq(users.id, 1)).get())!,
    };
    const events: Array<[number, boolean]> = [];
    // The actor (60) differs from the assignee (20) — upstream's
    // doer.ID != assignee.ID gate keeps a self-assignment silent.
    await armed.changeAssignees(found, issue, ["repowatcher"], { id: 60, isAdmin: false }, (user, removed) => {
      events.push([user.id, removed]);
    });
    // Upstream's post-tx notify order: the webhook emitter runs, then the
    // mail arm (both IssueChangeAssignee receivers).
    expect(events).toEqual([[20, false]]);
    let rows = await db().select().from(emailOutbox).all();
    expect(rows.map((row) => row.toAddr)).toEqual(["rw@example.com"]);
    expect(rows[0]!.dedupeKey).toMatch(new RegExp(`^issue-assigned:\\d+:20$`));
    expect(rows[0]!.bodyHtml).toContain("doer assigned you to issue <a href='");
    // The removal arm: the receiver gates it (notify.go:121's !removed) —
    // the webhook still fires, the outbox does not grow.
    await armed.changeAssignees(found, issue, [], { id: 60, isAdmin: false }, (user, removed) => {
      events.push([user.id, removed]);
    });
    expect(events).toEqual([
      [20, false],
      [20, true],
    ]);
    rows = await db().select().from(emailOutbox).all();
    expect(rows.map((row) => row.toAddr)).toEqual(["rw@example.com"]);
    // A no-op set (already empty) notifies nothing.
    await armed.changeAssignees(found, issue, [], { id: 60, isAdmin: false }, (user, removed) => {
      events.push([user.id, removed]);
    });
    expect(events).toHaveLength(2);
    expect((mailEnv.REPO_TASKS as unknown as { sends: number }).sends).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The mentions batch (mail_issue.go:99-102 + :135-137 — SPEC §13's lift of
// the §8.2 reduction). Mentions arrive RESOLVED (services/mentions —
// upstream's FindAndUpdateIssueMentions in the write service), ride FIRST
// in the union (the mention batch mails before the participants batch),
// unlock the onmention preference for their own ids, and dodge only the
// POST-batch visited joins — explicit issue-unwatchers — while ignorers and
// the doer (batch-1 visited) still exclude.
// ---------------------------------------------------------------------------

describe("resolveIssueMailRecipients — the mentions batch (SPEC §13)", () => {
  const userOf = async (id: number) => (await db().select().from(users).where(eq(users.id, id)).get())!;
  const doerOf = () => userOf(60);
  const repoOf = async () => (await db().select().from(repositories).where(eq(repositories.id, REPO_ID)).get())!;

  it("a mention rides FIRST and unlocks the onmention preference (mail_issue.go:99-102, :135-137)", async () => {
    const issue = await seedIssue();
    const recipients = await resolveIssueMailRecipients(env.DB, {
      issue,
      repo: await repoOf(),
      doer: await doerOf(),
      mentions: [await userOf(80)],
    });
    // 80 heads the order (the mention batch), then the batch-2 sources —
    // watcher 20, poster 10, assignee 50, participant 40, issue watcher 30
    // (70 explicit unwatch, 95 org, 96 prohibited stay out). 80's onmention
    // preference passes ONLY because they are mentioned.
    expect(recipients.map((u) => u.id)).toEqual([80, 20, 10, 50, 40, 30]);
  });

  it("an onmention user named in the mentions param only — a different mention does not lift them (:137 fromMention is the batch flag)", async () => {
    const issue = await seedIssue();
    const recipients = await resolveIssueMailRecipients(env.DB, {
      issue,
      repo: await repoOf(),
      doer: await doerOf(),
      mentions: [await userOf(90)],
    });
    // 90 is mentioned (enabled pref, no source — comes in via the mention
    // batch); 80's onmention preference has neither a custom watch nor the
    // mention and stays out.
    expect(recipients.map((u) => u.id)).toEqual([90, 20, 10, 50, 40, 30]);
  });

  it("a mentioned explicit issue-unwatcher still receives the mention mail (visited joins AFTER the mention batch, :104-109)", async () => {
    const issue = await seedIssue();
    const recipients = await resolveIssueMailRecipients(env.DB, {
      issue,
      repo: await repoOf(),
      doer: await doerOf(),
      mentions: [await userOf(70)],
    });
    // 70 is the seeded explicit unwatcher (is_watching=false) AND a repo
    // watcher source — the mention batch mails them before the unwatcher
    // block joins visited; the batch-2 pass then visits them (one mail).
    expect(recipients.map((u) => u.id)).toEqual([70, 20, 10, 50, 40, 30]);
  });

  it("a mentioned doer stays excluded (the doer join precedes the mention batch, :94-97)", async () => {
    const issue = await seedIssue();
    const recipients = await resolveIssueMailRecipients(env.DB, {
      issue,
      repo: await repoOf(),
      doer: await doerOf(),
      mentions: [await doerOf()],
    });
    expect(recipients.map((u) => u.id)).toEqual([20, 10, 50, 40, 30]);
  });

  it("end to end: addComment('@onmention …') lands the onmention user the FIRST row (comments.go:81's threading)", async () => {
    const issue = await seedIssue();
    const mailEnv = armedEnv();
    const service = new IssuesService(env.DB, mailEnv);
    await service.addComment({ issueId: issue.id, posterId: 60, content: "hey @onmention take a look" });
    const rows = await db().select().from(emailOutbox).all();
    expect(rows.map((row) => row.toAddr)).toEqual([
      "om@example.com", // the mention, first
      "rw@example.com",
      "poster@example.com",
      "as@example.com",
      "part@example.com",
      "iw@example.com",
    ]);
    expect(rows[0]!.dedupeKey).toMatch(/^issue-comment:\d+:80$/);
  });

  it("end to end: a mention inside a code span does NOT resolve (the parser's code exclusion rides the emit)", async () => {
    const issue = await seedIssue();
    const mailEnv = armedEnv();
    const service = new IssuesService(env.DB, mailEnv);
    await service.addComment({ issueId: issue.id, posterId: 60, content: "see `@onmention` literal" });
    const rows = await db().select().from(emailOutbox).all();
    expect(rows.map((row) => row.toAddr)).toEqual(
      expect.arrayContaining(["rw@example.com", "poster@example.com"]),
    );
    expect(rows.map((row) => row.toAddr)).not.toContain("om@example.com");
  });
});

// ---------------------------------------------------------------------------
// The inbound fold (specs/email-inbound.md §9) — the per-recipient token
// carriers of mail_issue_common.go:181-202 over the three compose sites.
// Armed = MAIL_INBOUND_ENABLED=true + MAIL_INBOUND_SECRET +
// MAIL_INBOUND_REPLY_ADDRESS (validated); un-armed = the pre-fold bytes.
// ---------------------------------------------------------------------------

describe("notify inbound fold — the per-recipient token carriers (mail_issue_common.go:181-202)", () => {
  const INBOUND_SECRET = "notify-fold-secret";
  const REPLY_TEMPLATE = "reply+%{token}@mail.example";
  // The mint clock — the REAL present (the token's 1-year expiry is checked
  // against the real clock at decode, so a fixed historical date would
  // mint already-expired tokens; one Date instance shared by the embed and
  // the expected-mint keeps the byte pins exact at second granularity).
  const NOW = new Date();

  /** The armed compose env (outbound + inbound). */
  const inboundArm = (overrides: Partial<MailNotifyEnv> = {}): MailNotifyEnv =>
    armedEnv({
      MAIL_INBOUND_ENABLED: "true",
      MAIL_INBOUND_REPLY_ADDRESS: REPLY_TEMPLATE,
      MAIL_INBOUND_SECRET: INBOUND_SECRET,
      ...overrides,
    });

  /** The token inside a `reply+<token>@mail.example` address. */
  function tokenOf(address: string): string {
    const m = /^reply\+(.+)@mail\.example$/.exec(address);
    expect(m).not.toBeNull();
    return m![1]!;
  }

  /** The comment arm over the seeded fixture issue, inbound armed. */
  async function composeCommentArm(mailEnv: MailNotifyEnv) {
    const issue = await seedIssue();
    const bare = new IssuesService(env.DB); // no mail env — the setup write is quiet
    const comment = await bare.addComment({ issueId: issue.id, posterId: 60, content: "hello world" });
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const outcome = await notifyIssueComment(mailEnv, { issue, comment, doer }, { now: NOW });
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    expect(rows).toHaveLength(5);
    return { issue, comment, rows };
  }

  /** A fake inbound message in the inbound.test.ts shape (To + optional
   *  References + a unique Message-ID over a plain text body). */
  function inboundMessage(input: { to: string; references?: string; body?: string }): InboundEmailMessage {
    const messageId = `<fold-rt-${crypto.randomUUID()}@sender.example>`;
    const headers = new Headers({
      From: "repowatcher <rw@example.com>",
      To: input.to,
      Subject: "Re: [repoowner/repo] Issue title (#1)",
      Date: "Fri, 31 Oct 2026 00:00:00 +0000",
      "Message-ID": messageId,
    });
    if (input.references !== undefined) headers.set("References", input.references);
    const raw = [
      "From: repowatcher <rw@example.com>",
      `To: ${input.to}`,
      "Subject: Re: [repoowner/repo] Issue title (#1)",
      "Date: Fri, 31 Oct 2026 00:00:00 +0000",
      `Message-ID: ${messageId}`,
      'Content-Type: text/plain; charset="utf-8"',
      "",
      input.body ?? "a fresh reply body",
    ].join("\r\n");
    const bytes = new TextEncoder().encode(raw);
    return {
      from: "rw@example.com",
      to: input.to,
      headers,
      raw: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      rawSize: bytes.byteLength,
      setReject: () => {},
    };
  }

  /** The inbound handler env over the same D1 (the fan kept quiet — the
   *  closure asserts the comment, not the fan). */
  const closureEnv = (): InboundEmailEnv => ({
    DB: env.DB,
    APP_URL: "https://mail.example",
    MAIL_ENABLED: "false",
    MAIL_INBOUND_ENABLED: "true",
    MAIL_INBOUND_REPLY_ADDRESS: REPLY_TEMPLATE,
    MAIL_INBOUND_SECRET: INBOUND_SECRET,
  });

  it("the comment arm pins all four carriers byte-for-byte, per recipient (mail_issue_common.go:186-201)", async () => {
    const { issue, comment, rows } = await composeCommentArm(inboundArm());
    const threadId = `<repoowner/repo/issues/${issue.index}@mail.example>`;
    for (const row of rows) {
      const recipientId = recipientIdOf(row);
      const replyToken = await createReplyToken(INBOUND_SECRET, {
        userId: recipientId,
        refType: "comment",
        refId: comment.id,
        now: NOW,
      });
      const unsubToken = await createReplyToken(INBOUND_SECRET, {
        userId: recipientId,
        refType: "issue",
        refId: issue.id,
        family: "unsubscribe",
        now: NOW,
      });
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      // Reply-To = the template with the recipient's REPLY token
      // (:186-188); List-Post = the mailto of the same address (:189);
      // References = thread id + the reply- carrier, space-joined (:191,
      // mail_test.go:134's two-value list); List-Unsubscribe = the url arm
      // + the UNSUBSCRIBE-token mailto, comma-joined (:179+:195-201,
      // mail_test.go:137's two-value list).
      expect(row.replyTo).toBe(`reply+${replyToken}@mail.example`);
      expect(headers["List-Post"]).toBe(`<mailto:reply+${replyToken}@mail.example>`);
      expect(headers["References"]).toBe(`${threadId} <reply-${replyToken}@mail.example>`);
      expect(headers["List-Unsubscribe"]).toBe(
        `<https://mail.example/repoowner/repo/issues/${issue.index}>, <mailto:reply+${unsubToken}@mail.example>`,
      );
    }
  });

  it("every recipient's token is distinct and binds ITS OWN user + the comment ref", async () => {
    const { comment, rows } = await composeCommentArm(inboundArm());
    expect(new Set(rows.map((row) => row.replyTo)).size).toBe(5);
    for (const row of rows) {
      const decoded = await decodeReplyToken(INBOUND_SECRET, tokenOf(row.replyTo!));
      expect(decoded).toMatchObject({
        ok: true,
        userId: recipientIdOf(row),
        refType: "comment",
        refId: comment.id,
      });
      // The 1-year life, unexpired at decode (token.go:29, :117-119).
      expect(decoded.ok && decoded.expiresAt.getTime() > Date.now()).toBe(true);
    }
  });

  it("the comment-nil arms bind the ISSUE ref (notifyIssueCreated over the same funnel)", async () => {
    const issue = await seedIssue();
    const poster = (await db().select().from(users).where(eq(users.id, 10)).get())!;
    const outcome = await notifyIssueCreated(inboundArm(), { issue, doer: poster }, { now: NOW });
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    expect(new Set(rows.map((row) => row.toAddr))).toEqual(
      new Set(["rw@example.com", "as@example.com", "part@example.com", "iw@example.com"]),
    );
    const threadId = `<repoowner/repo/issues/${issue.index}@mail.example>`;
    for (const row of rows) {
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      expect(headers["References"]).toBe(`${threadId} <reply-${tokenOf(row.replyTo!)}@mail.example>`);
      const decoded = await decodeReplyToken(INBOUND_SECRET, tokenOf(row.replyTo!));
      expect(decoded).toMatchObject({ ok: true, userId: recipientIdOf(row), refType: "issue", refId: issue.id });
    }
  });

  it("the assigned arm rides the same carriers, the type-9 comment as the reply ref", async () => {
    const issue = await seedIssue();
    const seeded = (
      await db()
        .insert(comments)
        .values({
          type: CommentType.Assignees,
          posterId: 60,
          issueId: issue.id,
          assigneeId: 50,
          removedAssignee: 0,
          content: "",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        })
        .returning()
    )[0]!;
    const assignee = (await db().select().from(users).where(eq(users.id, 50)).get())!;
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const outcome = await notifyIssueAssigneeChanged(
      inboundArm(),
      { issue, comment: seeded, doer, assignee, removed: false },
      { now: NOW },
    );
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    expect(rows).toHaveLength(1);
    const headers = JSON.parse(rows[0]!.headers ?? "{}") as Record<string, string>;
    expect(headers["List-Post"]).toBe(`<mailto:${rows[0]!.replyTo}>`);
    const decoded = await decodeReplyToken(INBOUND_SECRET, tokenOf(rows[0]!.replyTo!));
    expect(decoded).toMatchObject({ ok: true, userId: 50, refType: "comment", refId: seeded.id });
  });

  it("un-armed (or misconfigured) the headers stay ABSENT — the pre-fold bytes, byte-identical", async () => {
    const { issue, comment } = await composeCommentArm(inboundArm());
    const threadId = `<repoowner/repo/issues/${issue.index}@mail.example>`;
    const issueUrl = `https://mail.example/repoowner/repo/issues/${issue.index}`;
    const doer = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const absent = async (mailEnv: MailNotifyEnv) => {
      await db().delete(emailOutbox);
      expect((await notifyIssueComment(mailEnv, { issue, comment, doer }, { now: NOW })).outcome).toBe("enqueued");
      for (const row of await db().select().from(emailOutbox).all()) {
        const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
        expect(row.replyTo).toBeNull();
        expect("List-Post" in headers).toBe(false);
        expect(headers["References"]).toBe(threadId);
        expect(headers["List-Unsubscribe"]).toBe(`<${issueUrl}>`);
      }
    };
    await absent(armedEnv()); // no MAIL_INBOUND_* at all
    await absent(armedEnv({ MAIL_INBOUND_ENABLED: "true" })); // secret + template missing
    await absent(
      armedEnv({
        MAIL_INBOUND_ENABLED: "true",
        MAIL_INBOUND_SECRET: INBOUND_SECRET,
        MAIL_INBOUND_REPLY_ADDRESS: "no-placeholder@example.com", // %{token} absent
      }),
    );
    await absent(
      armedEnv({
        MAIL_INBOUND_ENABLED: "true",
        MAIL_INBOUND_SECRET: INBOUND_SECRET,
        MAIL_INBOUND_REPLY_ADDRESS: "%{token}@mail.example <%{token}>", // display-name shape: invalid
      }),
    );
  });

  it("ROUND-TRIP via Reply-To: a reply sent to the minted address posts the recipient's comment", async () => {
    const { issue, rows } = await composeCommentArm(inboundArm());
    const row = rows.find((r) => recipientIdOf(r) === 20)!;
    const outcome = await handleIncomingEmail(closureEnv(), inboundMessage({ to: row.replyTo! }));
    if (outcome.outcome !== "comment-created") throw new Error(`expected comment-created, got ${outcome.outcome}`);
    const posted = await db().select().from(comments).where(eq(comments.id, outcome.commentId)).get();
    expect(posted!.posterId).toBe(20);
    expect(posted!.content).toBe("a fresh reply body");
    expect(posted!.issueId).toBe(issue.id);
  });

  it("ROUND-TRIP via References: the reply-all arm delivers the token when the client ignores Reply-To", async () => {
    const { rows } = await composeCommentArm(inboundArm());
    const row = rows.find((r) => recipientIdOf(r) === 50)!;
    const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
    const outcome = await handleIncomingEmail(
      closureEnv(),
      inboundMessage({ to: "as@example.com", references: headers["References"] }),
    );
    if (outcome.outcome !== "comment-created") throw new Error(`expected comment-created, got ${outcome.outcome}`);
    const posted = await db().select().from(comments).where(eq(comments.id, outcome.commentId)).get();
    expect(posted!.posterId).toBe(50);
  });

  it("the UNSUBSCRIBE token never verifies as a reply — a mail to it drops, never comments (SPEC §3.2's cross-family safety)", async () => {
    const { issue, rows } = await composeCommentArm(inboundArm());
    const headers = JSON.parse(rows[0]!.headers ?? "{}") as Record<string, string>;
    const unsubAddress = /<mailto:(.+?)>/.exec(headers["List-Unsubscribe"]!)![1]!;
    const unsubToken = tokenOf(unsubAddress);
    // The reply-family verify (what the pipeline runs) REJECTS it…
    expect(await decodeReplyToken(INBOUND_SECRET, unsubToken)).toEqual({ ok: false, reason: "invalid" });
    // …the unsubscribe family verifies it, bound to the issue.
    expect(await decodeReplyToken(INBOUND_SECRET, unsubToken, "unsubscribe")).toMatchObject({
      ok: true,
      userId: recipientIdOf(rows[0]!),
      refType: "issue",
      refId: issue.id,
    });
    // And the mail itself: the token search FINDS it, the decode rejects it.
    const before = (await db().select().from(comments).all()).length;
    const drop = await handleIncomingEmail(closureEnv(), inboundMessage({ to: unsubAddress }));
    expect(drop).toEqual({ outcome: "dropped-invalid-token" });
    expect((await db().select().from(comments).all()).length).toBe(before);
    const inboundRow = await db()
      .select()
      .from(emailInbound)
      .where(eq(emailInbound.tokenStatus, "invalid"))
      .get();
    expect(inboundRow).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The review family (SPEC §14.6) — PullRequestReview (:98-111),
// PullRequestCodeComment (:113-117, MailMentionsComment) and
// PullRequestReviewRequest (:129-136, SendIssueAssignedMail's twin). The
// firing points live in api/services/pull-reviews.ts (submitReview's tail /
// the request pair); these arms pin each receiver's compose + filters.
// ---------------------------------------------------------------------------

/** A pull-issue fixture + a type-22 review comment over it (the SubmitReview
 *  system comment: poster = the doer, content = the review body). */
async function seedReviewFixture(reviewContent: string, title = "Review me"): Promise<{
  issue: IssueRow;
  comment: typeof comments.$inferSelect;
  doer: Awaited<ReturnType<typeof userRow>>;
}> {
  const issue = await seedIssue(title);
  await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
  const fresh = (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
  const rows = await db()
    .insert(comments)
    .values({
      type: CommentType.Review,
      posterId: 60,
      issueId: issue.id,
      content: reviewContent,
      reviewId: 9001,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })
    .returning();
  return { issue: fresh, comment: rows[0]!, doer: await userRow(60) };
}

async function userRow(id: number) {
  return (await db().select().from(users).where(eq(users.id, id)).get())!;
}

describe("notifyPullRequestReview — the PullRequestReview receiver (notify.go:98-111)", () => {
  it("the approve mail: the funnel recipients (mentions FIRST), the approve action line + kept body, the /comment/<id> Message-ID over the plain reference, pull-review dedupe", async () => {
    // The review body mentions the assignee — the write service resolves
    // BEFORE the receiver fires (services/pull/review.go:310-314).
    const { issue, comment, doer } = await seedReviewFixture("lgtm, @assignee take a look");
    const mentions = [await userRow(50)];
    const outcome = await notifyPullRequestReview(armedEnv(), { issue, comment, reviewType: 1, doer, mentions }, { now: new Date(1_700_000_000_000) });
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    // Mention batch first (50), then the funnel order: repo watcher 20,
    // poster 10, assignee 50 (visited), participant 40, issue watcher 30;
    // unwatcher 70 + the doer 60 excluded.
    expect(rows.map((row) => row.toAddr)).toEqual(["as@example.com", "rw@example.com", "poster@example.com", "part@example.com", "iw@example.com"]);
    for (const row of rows) {
      expect(row.subject).toBe(`Re: [repoowner/repo] ${issue.title} (#${issue.index})`);
      expect(row.info).toBe(`Subject: Re: [repoowner/repo] ${issue.title} (#${issue.index}), issue comments`);
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      // The type-22 comment carries the anchor + Message-ID extra; the
      // thread reference stays plain (ActionType(0) + nil comment).
      expect(headers["Message-ID"]).toBe(`<repoowner/repo/pulls/${issue.index}/comment/${comment.id}@mail.example>`);
      expect(headers["In-Reply-To"]).toBe(`<repoowner/repo/pulls/${issue.index}@mail.example>`);
      expect(headers["References"]).toBe(`<repoowner/repo/pulls/${issue.index}@mail.example>`);
      expect(headers["X-Gitea-Reason"]).toBe("pull");
      expect(row.dedupeKey).toBe(`pull-review:${comment.id}:${recipientIdOf(row)}`);
      // default.tmpl's approve branch + the KEPT body (MailParticipantsComment
      // empties only the push type) — link anchor on the footer line.
      expect(row.bodyHtml).toContain("<b>doer</b> approved this pull request.");
      expect(row.bodyHtml).toContain(`#issuecomment-${comment.id}`);
    }
    // The mention line ONLY on the mention batch's copy (compose's
    // fromMention, mail_issue.go:101/115).
    const mentionCopy = rows.find((row) => row.toAddr === "as@example.com")!;
    expect(mentionCopy.bodyHtml).toContain("<b>doer</b> mentioned you:</p>");
    expect(rows.find((row) => row.toAddr === "rw@example.com")!.bodyHtml).not.toContain("mentioned you");
    // The body renders the review content with the mention resolved.
    expect(mentionCopy.bodyHtml).toContain("lgtm");
  });

  it("the reject verdict picks its locale line (actionToTemplate's CommentTypeReview branch, :248-257)", async () => {
    const { issue, comment, doer } = await seedReviewFixture("blocking: @repowatcher");
    const mentions = [await userRow(20)];
    await notifyPullRequestReview(armedEnv(), { issue, comment, reviewType: 3, doer, mentions }, {});
    const rows = await db().select().from(emailOutbox).all();
    // The review arm is the FULL funnel (the mentions ride first) — the
    // mentioned watcher 20, then poster 10, assignee 50, participant 40,
    // issue watcher 30.
    expect(rows.map((row) => row.toAddr)).toEqual(["rw@example.com", "poster@example.com", "as@example.com", "part@example.com", "iw@example.com"]);
    expect(rows[0]!.bodyHtml).toContain("<b>doer</b> requested changes on this pull request.");
    expect(rows[0]!.bodyHtml).toContain("blocking:");
    expect(rows[0]!.bodyHtml).toContain("<b>doer</b> mentioned you:</p>");
  });

  it("the comment verdict picks its locale line; no mentions — the plain funnel order", async () => {
    const { issue, comment, doer } = await seedReviewFixture("notes only");
    await notifyPullRequestReview(armedEnv(), { issue, comment, reviewType: 2, doer }, {});
    const rows = await db().select().from(emailOutbox).all();
    expect(rows.map((row) => row.toAddr)).toEqual(["rw@example.com", "poster@example.com", "as@example.com", "part@example.com", "iw@example.com"]);
    for (const row of rows) expect(row.bodyHtml).toContain("<b>doer</b> commented on this pull request.");
    expect(rows[0]!.bodyHtml).toContain("notes only");
  });

  it("a WIP-titled pull drops the repo watchers (ActionType(0) != ActionCreatePullRequest — no create exception)", async () => {
    const { issue, comment, doer } = await seedReviewFixture("wip approve", "WIP: review me");
    const outcome = await notifyPullRequestReview(armedEnv(), { issue, comment, reviewType: 1, doer }, {});
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    expect(rows.map((row) => row.toAddr)).not.toContain("rw@example.com");
    expect(rows.map((row) => row.toAddr)).toContain("poster@example.com");
  });

  it("consumes to 'sent'; MAIL off / malformed degrade like the siblings", async () => {
    const { issue, comment, doer } = await seedReviewFixture("ship it");
    const mailEnv = armedEnv();
    await notifyPullRequestReview(mailEnv, { issue, comment, reviewType: 1, doer }, {});
    const spy = mailEnv.REPO_TASKS as unknown as { sendBodies: MailOutboxMessage[] };
    expect(await processMailOutbox(mailEnv, spy.sendBodies[0]!)).toEqual({ kind: "sent" });
    const off = armedEnv({ MAIL_ENABLED: "false" });
    expect((await notifyPullRequestReview(off, { issue, comment, reviewType: 1, doer }, {})).outcome).toBe("disabled");
    const malformed = armedEnv({ MAIL_FROM: "no address here" });
    expect((await notifyPullRequestReview(malformed, { issue, comment, reviewType: 1, doer }, {})).outcome).toBe("misconfigured");
  });
});

describe("notifyPullRequestCodeComment — the MailMentionsComment receiver (notify.go:113-117)", () => {
  /** A type-21 code comment over the pull fixture (the pending-review
   *  comment the submission carries). */
  async function seedCodeComment(content: string) {
    const issue = await seedIssue("Code review");
    await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
    const fresh = (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
    const rows = await db()
      .insert(comments)
      .values({
        type: CommentType.Code,
        posterId: 60,
        issueId: issue.id,
        content,
        reviewId: 9002,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })
      .returning();
    return { issue: fresh, comment: rows[0]!, doer: await userRow(60) };
  }

  it("mails ONLY the mention batch — a non-mentioned watcher gets nothing, the mentioned unwatcher still does, the poster-doer never self-mails", async () => {
    // Mentioned: assignee 50 (enabled), unwatcher 70 (explicit-unwatch does
    // NOT exclude — MailMentionsComment's visited is ONLY the poster,
    // mail_comment.go:53), onmention 80 (fromMention=true admits),
    // poster 10 (not the doer). Not mentioned: watcher 20, participant 40,
    // issue watcher 30 — silent.
    const { issue, comment, doer } = await seedCodeComment("@assignee @unwatcher @onmention @poster look here");
    const mentions = [await userRow(50), await userRow(70), await userRow(80), await userRow(10)];
    const outcome = await notifyPullRequestCodeComment(armedEnv(), { issue, comment, doer, mentions }, { now: new Date(1_700_000_000_000) });
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    expect(rows.map((row) => row.toAddr)).toEqual(["as@example.com", "un@example.com", "om@example.com", "poster@example.com"]);
    for (const row of rows) {
      const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
      expect(headers["Message-ID"]).toBe(`<repoowner/repo/pulls/${issue.index}/comment/${comment.id}@mail.example>`);
      expect(row.dedupeKey).toBe(`pull-code-comment:${comment.id}:${recipientIdOf(row)}`);
      // actionToTemplate's CommentTypeCode branch → name "comment" → no
      // action line; the code comment's content IS the body; EVERY copy
      // carries the IsMention line (fromMention=true for the whole batch).
      expect(row.bodyHtml).not.toContain("approved this pull request");
      expect(row.bodyHtml).toContain("look here");
      expect(row.bodyHtml).toContain("<b>doer</b> mentioned you:</p>");
    }
  });

  it("the batch filters: disabled preference and non-mailable mentions drop, onmention passes (fromMention=true)", async () => {
    const { issue, comment, doer } = await seedCodeComment("@frozen @onmention");
    const mentions = [await userRow(96), await userRow(80)];
    const outcome = await notifyPullRequestCodeComment(armedEnv(), { issue, comment, doer, mentions }, {});
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    expect(rows.map((row) => row.toAddr)).toEqual(["om@example.com"]); // the frozen mention dropped, onmention admitted
  });

  it("zero survivors (no mentions) mail nothing; MAIL off degrades", async () => {
    const { issue, comment, doer } = await seedCodeComment("no mentions here");
    expect((await notifyPullRequestCodeComment(armedEnv(), { issue, comment, doer, mentions: [] }, {})).outcome).toBe("no-recipients");
    // The MAIL-off gate returns before any read — the same fixture is fine.
    const off = armedEnv({ MAIL_ENABLED: "false" });
    expect(
      (await notifyPullRequestCodeComment(off, { issue, comment, doer, mentions: [await userRow(50)] }, {})).outcome,
    ).toBe("disabled");
  });
});

describe("notifyPullRequestReviewRequest — the PullRequestReviewRequest receiver (notify.go:129-136)", () => {
  /** A type-27 review-request comment over the pull fixture (the add arm's
   *  row: poster = the requesting doer). */
  async function seedRequestComment() {
    const issue = await seedIssue("Request my review");
    await env.DB.prepare("UPDATE issues SET is_pull = 1 WHERE id = ?").bind(issue.id).run();
    const fresh = (await db().select().from(issues).where(eq(issues.id, issue.id)).get())!;
    const rows = await db()
      .insert(comments)
      .values({
        type: CommentType.ReviewRequest,
        posterId: 60,
        issueId: issue.id,
        assigneeId: 50,
        removedAssignee: 0,
        reviewId: 9003,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })
      .returning();
    return { issue: fresh, comment: rows[0]!, doer: await userRow(60), reviewer: await userRow(50) };
  }

  it("the add mail: ONE row to the reviewer, the rendered 'Requested to review <url>.' body over default.tmpl (CommentTypeReviewRequest → name 'default'), the /comment/<id> Message-ID, 'issue assigned' info", async () => {
    const { issue, comment, doer, reviewer } = await seedRequestComment();
    const outcome = await notifyPullRequestReviewRequest(armedEnv(), { issue, comment, doer, reviewer, isRequest: true }, { now: new Date(1_700_000_000_000) });
    expect(outcome.outcome).toBe("enqueued");
    const rows = await db().select().from(emailOutbox).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.toAddr).toBe("as@example.com");
    expect(row.subject).toBe(`Re: [repoowner/repo] ${issue.title} (#${issue.index})`);
    // SendIssueAssignedMail's batch info (mail_issue.go:222).
    expect(row.info).toBe(`Subject: Re: [repoowner/repo] ${issue.title} (#${issue.index}), issue assigned`);
    expect(row.dedupeKey).toBe(`pull-review-request:${comment.id}:50`);
    const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
    expect(headers["Message-ID"]).toBe(`<repoowner/repo/pulls/${issue.index}/comment/${comment.id}@mail.example>`);
    expect(headers["In-Reply-To"]).toBe(`<repoowner/repo/pulls/${issue.index}@mail.example>`);
    expect(headers["References"]).toBe(`<repoowner/repo/pulls/${issue.index}@mail.example>`);
    expect(headers["X-Gitea-Reason"]).toBe("pull");
    // The type-27 comment carries NO HasMailReplySupport (comment.go:196-201)
    // → the reply payload is nil: no action line in the body (name
    // "default"), the rendered ct IS the body, no mention line.
    expect(row.bodyHtml).toContain("Requested to review");
    expect(row.bodyHtml).toContain(`https://mail.example/repoowner/repo/pulls/${issue.index}`);
    expect(row.bodyHtml).not.toContain("<b>doer</b>");
    expect(row.bodyHtml).not.toContain("mentioned you");
    expect(row.replyTo).toBeNull();
  });

  it("the receiver gates — the removal self-gates off, self-request, disabled preference, non-mailable reviewer all mail NOTHING (notify.go:130-131)", async () => {
    const { issue, comment, doer, reviewer } = await seedRequestComment();
    const env0 = armedEnv();
    expect((await notifyPullRequestReviewRequest(env0, { issue, comment, doer, reviewer, isRequest: false }, {})).outcome).toBe("no-recipients");
    expect((await notifyPullRequestReviewRequest(env0, { issue, comment, doer, reviewer: doer, isRequest: true }, {})).outcome).toBe("no-recipients");
    await db().insert(userSettings).values({ userId: 50, emailNotificationsPreference: "disabled" });
    expect((await notifyPullRequestReviewRequest(env0, { issue, comment, doer, reviewer, isRequest: true }, {})).outcome).toBe("no-recipients");
    await db().delete(userSettings).where(eq(userSettings.userId, 50));
    const frozen = await userRow(96);
    expect((await notifyPullRequestReviewRequest(env0, { issue, comment, doer, reviewer: frozen, isRequest: true }, {})).outcome).toBe("no-recipients");
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
  });

  it("inbound armed: the nil reply payload keeps Reply-To/List-Post absent while the issue-bound unsubscribe token still rides (mail_issue_common.go:148-201)", async () => {
    const { issue, comment, doer, reviewer } = await seedRequestComment();
    const outcome = await notifyPullRequestReviewRequest(
      armedEnv({
        MAIL_INBOUND_ENABLED: "true",
        MAIL_INBOUND_REPLY_ADDRESS: "reply+%{token}@mail.example",
        MAIL_INBOUND_SECRET: "review-request-secret",
      }),
      { issue, comment, doer, reviewer, isRequest: true },
      { now: new Date() },
    );
    expect(outcome.outcome).toBe("enqueued");
    const row = (await db().select().from(emailOutbox).all())[0]!;
    expect(row.replyTo).toBeNull();
    const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
    expect(headers["List-Post"]).toBeUndefined();
    // References stays the bare thread (no reply-token carrier)…
    expect(headers["References"]).toBe(`<repoowner/repo/pulls/${issue.index}@mail.example>`);
    // …but List-Unsubscribe grew the mailto arm (the unsubscribe token is
    // independent of the reply payload, :195-201).
    expect(headers["List-Unsubscribe"]).toContain(`https://mail.example/repoowner/repo/pulls/${issue.index}`);
    expect(headers["List-Unsubscribe"]).toContain("<mailto:reply+");
  });

  it("consumes to 'sent'; MAIL off / malformed degrade like the siblings", async () => {
    const { issue, comment, doer, reviewer } = await seedRequestComment();
    const mailEnv = armedEnv();
    await notifyPullRequestReviewRequest(mailEnv, { issue, comment, doer, reviewer, isRequest: true }, {});
    const spy = mailEnv.REPO_TASKS as unknown as { sendBodies: MailOutboxMessage[] };
    expect(await processMailOutbox(mailEnv, spy.sendBodies[0]!)).toEqual({ kind: "sent" });
    const off = armedEnv({ MAIL_ENABLED: "false" });
    expect((await notifyPullRequestReviewRequest(off, { issue, comment, doer, reviewer, isRequest: true }, {})).outcome).toBe("disabled");
    const malformed = armedEnv({ MAIL_FROM: "no address here" });
    expect((await notifyPullRequestReviewRequest(malformed, { issue, comment, doer, reviewer, isRequest: true }, {})).outcome).toBe("misconfigured");
  });
});
