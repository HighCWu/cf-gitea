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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
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
import { IssuesService, type IssueRow } from "../../issues/service";
import { CommentType } from "../../issues/comment-types";
import { isMailOutboxMessage, processMailOutbox, type MailOutboxMessage } from "./outbox";
import { resolveIssueMailRecipients, type MailNotifyEnv } from "./notify";
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

/** The recipient id encoded in the row's dedupe key. */
function recipientIdOf(row: { dedupeKey: string | null }): number {
  const id = Number(dedupeParts(row)[2]);
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
