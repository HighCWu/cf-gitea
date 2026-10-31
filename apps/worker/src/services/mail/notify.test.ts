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
import { notifyIssueCreated, notifyIssueStatusChanged, resolveIssueMailRecipients, type MailNotifyEnv } from "./notify";
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
// The service-level emit sites — IssuesService.createIssue / closeIssue /
// reopenIssue (upstream fires from the model layer; the router never does)
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

  it("createPullRequest emits NOTHING (NewPullRequest is the pull-create arm, SPEC §1.3)", async () => {
    await seedRepo();
    const mailEnv = armedEnv();
    const service = new IssuesService(env.DB, mailEnv);
    await service.createPullRequest({
      repoId: REPO_ID,
      title: "a pull",
      content: "desc",
      posterId: 10,
      headRepoId: REPO_ID,
      baseBranch: "main",
      headBranch: "topic",
    });
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
    expect((mailEnv.REPO_TASKS as unknown as { sends: number }).sends).toBe(0);
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

  it("a poster-less create and an actor-less close skip the mail but keep the writes", async () => {
    const mailEnv = armedEnv();
    const service = new IssuesService(env.DB, mailEnv);
    await seedRepo();
    const issue = await service.createIssue({ repoId: REPO_ID, title: "ghost", content: null, posterId: null });
    expect(issue.id).toBeGreaterThan(0);
    await service.closeIssue(issue.id, { actorId: null });
    expect(await db().select().from(emailOutbox).all()).toHaveLength(0);
    expect((mailEnv.REPO_TASKS as unknown as { sends: number }).sends).toBe(0);
  });
});
