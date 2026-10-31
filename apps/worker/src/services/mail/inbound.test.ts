/**
 * The inbound-mail suite (specs/email-inbound.md §10) — service level:
 * the vitest plugin cannot deliver to the email() handler (SPEC §3.1),
 * so every test drives `handleIncomingEmail` with a fake
 * `InboundEmailMessage` over the real D1. Arms: the token mint/verify
 * matrix (§10.1), the header search (§10.2), the automatic-reply guard
 * (§10.3), the bounded MIME extractor + the quoted-reply trim (§10.4),
 * and the handler end to end — the comment round-trip through the LANDED
 * IssuesService (the notify fan rides the mail env), the Message-ID
 * dedupe, the spoofed-From/no-token rejections, the disabled-gate
 * zero-writes tripwire, the misconfiguration arms, the oversize reject,
 * the permission gates (public-reads-everyone vs the private grant vs the
 * locked-issue write), the empty-content drop and the missing-reference
 * drop (§10.5).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  comments,
  emailInbound,
  emailOutbox,
  issues,
  repoCollaborators,
  repoWatchers,
  repositories,
  users,
} from "../../db/schema";
import { IssuesService, type IssueRow } from "../../issues/service";
import {
  MAIL_INBOUND_MAX_MESSAGE_SIZE,
  MailInboundOversizeError,
  createReplyToken,
  decodeReplyToken,
  extractMailText,
  extractReplyText,
  extractTokenFromHeaders,
  handleIncomingEmail,
  isAutomaticReply,
  parseReplyAddressTemplate,
  replyAddressFor,
  type InboundEmailEnv,
  type InboundEmailMessage,
} from "./inbound";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const SECRET = "inbound-test-secret";
const NOW = new Date("2026-10-31T00:00:00Z");
const REPLY_TEMPLATE = "reply+%{token}@mail.example";
const APP_URL = "https://mail.example";

const db = () => drizzle(env.DB);

/** Recording Queue — counts sends AND captures every body. */
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

/** The armed env — inbound ON and outbound armed (so the round-trip fan
 *  runs); every override is per-test. */
function inboundEnv(overrides: Partial<InboundEmailEnv> = {}): InboundEmailEnv {
  return {
    DB: env.DB,
    REPO_TASKS: spyQueue(),
    APP_URL,
    MAIL_ENABLED: "true",
    MAIL_FROM: "Gitea <noreply@example.com>",
    MAIL_INBOUND_ENABLED: "true",
    MAIL_INBOUND_REPLY_ADDRESS: REPLY_TEMPLATE,
    MAIL_INBOUND_SECRET: SECRET,
    ...overrides,
  };
}

const FIXTURE_USERS: Array<{
  id: number;
  username: string;
  email: string | null;
  type?: string;
  status?: string;
  isAdmin?: boolean;
}> = [
  { id: 1, username: "repoowner", email: "owner@example.com" },
  { id: 2, username: "siteadmin", email: "admin@example.com", isAdmin: true },
  { id: 10, username: "poster", email: "poster@example.com" },
  { id: 11, username: "frozen", email: "fz@example.com", status: "prohibited" },
  { id: 12, username: "orgish", email: "org@example.com", type: "org" },
  { id: 20, username: "collaborator", email: "collab@example.com" },
  { id: 30, username: "plainuser", email: "plain@example.com" },
];

const PUBLIC_REPO = "600";
const PRIVATE_REPO = "601";

async function seedRepo(repoId: string, visibility: "public" | "private" = "public"): Promise<void> {
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: "repoowner",
    ownerId: 1,
    slug: repoId === PUBLIC_REPO ? "repo" : "secret",
    visibility,
    status: "ready",
  });
}

async function seedIssue(
  repoId = PUBLIC_REPO,
  visibility: "public" | "private" = "public",
  title = "Issue title",
): Promise<IssueRow> {
  await seedRepo(repoId, visibility);
  const service = new IssuesService(env.DB);
  const issue = await service.createIssue({ repoId, title, content: "body", posterId: 10 });
  // One repo watcher with an email (30) — the notify fan needs a mailable
  // recipient so the round-trip asserts rows.
  await db().insert(repoWatchers).values({ repoId, userId: 30 });
  return issue;
}

async function inboundRow(messageId: string) {
  return db().select().from(emailInbound).where(eq(emailInbound.messageId, messageId)).get();
}

// --- fake message helpers ---------------------------------------------------

interface RawMailInput {
  from?: string;
  to?: string;
  headers?: Record<string, string>;
  body: string;
  contentType?: string;
}

/** A minimal RFC 822 text (CRLF line ends — the extractor must split the
 *  CRLF header/body pair). */
function rawMail(input: RawMailInput): string {
  const headers: string[] = [
    `From: ${input.from ?? "Poster <poster@example.com>"}`,
    `To: ${input.to ?? "reply+TOKEN@mail.example"}`,
    `Subject: Re: [repoowner/repo] Issue title (#1)`,
    `Date: Fri, 31 Oct 2026 00:00:00 +0000`,
  ];
  for (const [k, v] of Object.entries(input.headers ?? {})) headers.push(`${k}: ${v}`);
  if (input.contentType !== undefined) headers.push(`Content-Type: ${input.contentType}`);
  return `${headers.join("\r\n")}\r\n\r\n${input.body}`;
}

function fakeMessage(
  raw: string,
  opts: { from?: string; to?: string; headers?: Record<string, string>; rawSize?: number } = {},
): { message: InboundEmailMessage; rejects: string[] } {
  const headers = new Headers();
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
  const bytes = new TextEncoder().encode(raw);
  const rejects: string[] = [];
  const message: InboundEmailMessage = {
    from: opts.from ?? "poster@example.com",
    to: opts.to ?? "reply+x@mail.example",
    headers,
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize: opts.rawSize ?? bytes.byteLength,
    setReject: (reason: string) => rejects.push(reason),
  };
  return { message, rejects };
}

/** The canonical GOOD mail: a text reply carrying `token` for `refId`. */
function goodMail(input: {
  token: string;
  extraHeaders?: Record<string, string>;
  body?: string;
  toHeader?: string;
  fromHeader?: string;
}): { message: InboundEmailMessage; messageId: string } {
  const messageId = `<reply-test-${Math.random().toString(36).slice(2)}@sender.example>`;
  const from = input.fromHeader ?? "Poster <poster@example.com>";
  const to = input.toHeader ?? `reply+${input.token}@mail.example`;
  const headers: Record<string, string> = {
    From: from,
    To: to,
    Subject: "Re: [repoowner/repo] Issue title (#1)",
    Date: "Fri, 31 Oct 2026 00:00:00 +0000",
    "Message-ID": messageId,
    "MIME-version": "1.0",
    ...(input.extraHeaders ?? {}),
  };
  const raw = rawMail({
    from,
    to,
    headers: { "Message-ID": messageId, "MIME-version": "1.0", ...(input.extraHeaders ?? {}) },
    body: input.body ?? "a fresh reply body",
    contentType: 'text/plain; charset="utf-8"',
  });
  // The runtime hands the Worker PARSED headers — the fake carries the
  // full set too (the raw string alone is not consulted for headers).
  return { ...fakeMessage(raw, { headers }), messageId };
}

async function validToken(input: { userId?: number; refType?: "issue" | "comment"; refId: number }): Promise<string> {
  return createReplyToken(SECRET, {
    userId: input.userId ?? 10,
    refType: input.refType ?? "issue",
    refId: input.refId,
    now: NOW,
  });
}

/** base64 without Node's Buffer (workerd — btoa over the byte string). */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
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
    await db().insert(users).values({
      id: user.id,
      username: user.username,
      usernameLower: user.username,
      email: user.email,
      status: (user.status ?? "active") as "active" | "prohibited",
      type: (user.type ?? "user") as "user" | "org",
      isAdmin: user.isAdmin ?? false,
      createdAt: new Date(0),
    });
  }
});

// ---------------------------------------------------------------------------
// §10.1 — the reply-address template + the token arms
// ---------------------------------------------------------------------------

describe("parseReplyAddressTemplate — upstream checkReplyToAddress rules", () => {
  it("accepts the placeholder exactly once in the user part", () => {
    expect(parseReplyAddressTemplate("reply+%{token}@mail.example")).toEqual({
      prefix: "reply+",
      suffix: "@mail.example",
    });
  });

  it("rejects empty, placeholder-less, duplicated-placeholder, host-side and named forms", () => {
    expect(parseReplyAddressTemplate("")).toBeNull();
    expect(parseReplyAddressTemplate("reply@mail.example")).toBeNull();
    expect(parseReplyAddressTemplate("reply+%{token}+%{token}@mail.example")).toBeNull();
    expect(parseReplyAddressTemplate("reply@%{token}mail.example")).toBeNull();
    expect(parseReplyAddressTemplate("Gitea <reply+%{token}@mail.example>")).toBeNull();
  });

  it("replyAddressFor substitutes once (mail_issue_common.go:186-187)", () => {
    expect(replyAddressFor(REPLY_TEMPLATE, "AB234")).toBe("reply+AB234@mail.example");
  });
});

describe("createReplyToken / decodeReplyToken — the token matrix (SPEC §3.2)", () => {
  it("round-trips issue and comment refs; the layout pins (52-char unpadded base32)", async () => {
    const issueToken = await validToken({ refId: 1234 });
    expect(issueToken).toMatch(/^[A-Z2-7]{52}$/);
    const issue = await decodeReplyToken(SECRET, issueToken);
    // 1 year from the mint clock (upstream tokenLifetimeInYears = 1).
    expect(issue).toEqual({
      ok: true,
      userId: 10,
      refType: "issue",
      refId: 1234,
      expiresAt: new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000),
    });
    const comment = await decodeReplyToken(
      SECRET,
      await createReplyToken(SECRET, { userId: 10, refType: "comment", refId: 77, now: NOW }),
    );
    expect(comment.ok && comment.refType === "comment" && comment.refId === 77).toBe(true);
  });

  it("rejects a flipped character and the wrong server secret with 'invalid'", async () => {
    const token = await validToken({ refId: 1 });
    // Flip inside the MAC's span (byte 31 = the tail; the FIRST chars are
    // the version/userId fields, where a flip is a malformed verdict).
    const last = token[token.length - 1]!;
    const flipped = token.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(await decodeReplyToken(SECRET, flipped)).toEqual({ ok: false, reason: "invalid" });
    // The wrong secret fails verification — the rotation kill switch.
    expect(await decodeReplyToken("another-secret", token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects truncated and non-base32 tokens with 'malformed'", async () => {
    const token = await validToken({ refId: 1 });
    expect(await decodeReplyToken(SECRET, token.slice(0, 50))).toEqual({ ok: false, reason: "malformed" });
    expect(await decodeReplyToken(SECRET, "!1234!1234!1234!1234!1234!1234!1234!1234!123")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("classifies a past-expiry token as 'expired' (upstream token.go:117-119)", async () => {
    const stale = await createReplyToken(SECRET, {
      userId: 10,
      refType: "issue",
      refId: 1,
      now: new Date(NOW.getTime() - 366 * 24 * 60 * 60 * 1000),
    });
    expect(await decodeReplyToken(SECRET, stale)).toEqual({ ok: false, reason: "expired" });
  });

  it("decodes a LOWERCASED token (RFC 5321 §2.4, token.go:79-81)", async () => {
    const token = await validToken({ refId: 5 });
    expect(await decodeReplyToken(SECRET, token.toLowerCase())).toEqual({
      ok: true,
      userId: 10,
      refType: "issue",
      refId: 5,
      expiresAt: new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000),
    });
  });
});

// ---------------------------------------------------------------------------
// §10.2 — the header search (upstream searchTokenInHeaders)
// ---------------------------------------------------------------------------

describe("extractTokenFromHeaders — To / Delivered-To / References", () => {
  const template = parseReplyAddressTemplate(REPLY_TEMPLATE)!;

  it("finds the token in a display-name To list", () => {
    const headers = new Headers({ To: "Poster <poster@example.com>, reply+TOK1@mail.example" });
    expect(extractTokenFromHeaders(headers, template, "mail.example")).toBe("TOK1");
  });

  it("falls through to Delivered-To", () => {
    const headers = new Headers({ To: "someone@example.com", "Delivered-To": "reply+TOK2@mail.example" });
    expect(extractTokenFromHeaders(headers, template, "mail.example")).toBe("TOK2");
  });

  it("finds the References reply-<token>@domain arm case-insensitively", () => {
    const headers = new Headers({ References: "<a@x.example> <reply-tok3@MAIL.EXAMPLE>" });
    expect(extractTokenFromHeaders(headers, template, "mail.example")).toBe("tok3");
  });

  it("returns '' for plain addresses, wrong-domain msg-ids and malformed references", () => {
    expect(extractTokenFromHeaders(new Headers({ To: "poster@example.com" }), template, "mail.example")).toBe("");
    expect(
      extractTokenFromHeaders(
        new Headers({ References: "<reply-TOK@other.example> <not-a-msg-id" }),
        template,
        "mail.example",
      ),
    ).toBe("");
  });
});

// ---------------------------------------------------------------------------
// §10.3 — the automatic-reply guard (upstream isAutomaticReply verbatim)
// ---------------------------------------------------------------------------

describe("isAutomaticReply — the loop guard", () => {
  it("drops Auto-Submitted (any value ≠ 'no'), X-Autoreply: yes, X-Autorespond", () => {
    expect(isAutomaticReply(new Headers({ "Auto-Submitted": "auto-generated" }))).toBe(true);
    expect(isAutomaticReply(new Headers({ "X-Autoreply": "yes" }))).toBe(true);
    expect(isAutomaticReply(new Headers({ "X-Autorespond": "at the beach" }))).toBe(true);
  });

  it("passes Auto-Submitted: no (the exact-case upstream arm) and plain mail", () => {
    expect(isAutomaticReply(new Headers({ "Auto-Submitted": "no" }))).toBe(false);
    expect(isAutomaticReply(new Headers())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §10.4 — the bounded MIME extractor + the quoted-reply trim
// ---------------------------------------------------------------------------

describe("extractMailText — the bounded MIME walk", () => {
  it("picks text/plain out of a multipart/alternative and decodes quoted-printable", async () => {
    const raw = [
      "From: a@b.c",
      "To: d@e.f",
      'Content-Type: multipart/alternative; boundary="bnd"',
      "",
      "--bnd",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "caf=C3=A9 reply =",
      "continues",
      "--bnd",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>html noise</p>",
      "--bnd--",
      "",
    ].join("\r\n");
    const bytes = new TextEncoder().encode(raw);
    const headers = new Headers({ "Content-Type": 'multipart/alternative; boundary="bnd"' });
    const text = await extractMailText(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      headers,
      MAIL_INBOUND_MAX_MESSAGE_SIZE,
    );
    expect(text).toBe("café reply continues");
  });

  it("decodes base64 with the charset ladder (iso-8859-1 halves; unknown label → utf-8 rung)", async () => {
    const b64 = toBase64("latinä body");
    const mk = (charset: string) => {
      const raw = rawMail({
        headers: { "Content-Transfer-Encoding": "base64" },
        contentType: `text/plain; charset="${charset}"`,
        body: b64,
      });
      const bytes = new TextEncoder().encode(raw);
      const headers = new Headers({
        "Content-Type": `text/plain; charset="${charset}"`,
        "Content-Transfer-Encoding": "base64",
      });
      return extractMailText(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        headers,
        MAIL_INBOUND_MAX_MESSAGE_SIZE,
      );
    };
    // iso-8859-1 decodes the utf-8 byte pair as two latin1 chars — the
    // honest lossy read of a mislabeled charset.
    expect(await mk("iso-8859-1")).toBe("latinÃ¤ body");
    // An unknown label falls to the utf-8 rung — the true text round-trips.
    expect(await mk("x-nonexistent-charset")).toBe("latinä body");
  });

  it("skips attachment parts and returns '' for html-only mail (no fallback)", async () => {
    const attachmentRaw = [
      'Content-Type: multipart/mixed; boundary="bb"',
      "",
      "--bb",
      "Content-Type: text/plain",
      "",
      "ignored body",
      "--bb",
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      "",
      "attachment text",
      "--bb--",
    ].join("\r\n");
    const bytes = new TextEncoder().encode(attachmentRaw);
    const text = await extractMailText(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      new Headers({ "Content-Type": 'multipart/mixed; boundary="bb"' }),
      MAIL_INBOUND_MAX_MESSAGE_SIZE,
    );
    expect(text).toBe("ignored body");

    const htmlOnly = rawMail({ contentType: "text/html; charset=utf-8", body: "<p>only html</p>" });
    const htmlBytes = new TextEncoder().encode(htmlOnly);
    expect(
      await extractMailText(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(htmlBytes);
            c.close();
          },
        }),
        new Headers({ "Content-Type": "text/html; charset=utf-8" }),
        MAIL_INBOUND_MAX_MESSAGE_SIZE,
      ),
    ).toBe("");
  });

  it("re-bounds the stream read (a lying rawSize cannot buffer the Worker)", async () => {
    const bytes = new TextEncoder().encode("x".repeat(2048));
    await expect(
      extractMailText(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(bytes);
            c.close();
          },
        }),
        new Headers(),
        1000,
      ),
    ).rejects.toBeInstanceOf(MailInboundOversizeError);
  });
});

describe("extractReplyText — the reply.go port (English arms)", () => {
  it("cuts at the attribution line and drops the trailing quote block", () => {
    const body = "a fresh reply\n\nOn Fri, Oct 30, 2026 at 5:00 PM Other <other@example.com> wrote:\n> earlier\n> text";
    expect(extractReplyText(body)).toBe("a fresh reply");
  });

  it("cuts at the signature delimiter, the separator rule and forwarded header blocks", () => {
    expect(extractReplyText("text\n\n-- \nsent from my phone")).toBe("text");
    expect(extractReplyText("text\n\n-------- Original Message --------\n> old")).toBe("text");
    expect(extractReplyText("text\n\nFrom: x@y.z\nTo: a@b.c\nSent: yesterday\nSubject: hi\n\nold")).toBe("text");
  });

  it("keeps a WHOLE-body quote (upstream's survivor arm) and trims plain text", () => {
    expect(extractReplyText("> all quoted\n> lines")).toBe("> all quoted\n> lines");
    expect(extractReplyText("  padded  ")).toBe("padded");
  });
});

// ---------------------------------------------------------------------------
// §10.5 — the handler end to end
// ---------------------------------------------------------------------------

describe("handleIncomingEmail — the pipeline", () => {
  it("creates the comment through the LANDED IssuesService and fans the notify hub", async () => {
    const issue = await seedIssue();
    const envSlice = inboundEnv();
    const token = await validToken({ refId: issue.id });
    const mail = goodMail({ token });
    const outcome = await handleIncomingEmail(envSlice, mail.message, { now: NOW });
    expect(outcome.outcome).toBe("comment-created");

    if (outcome.outcome !== "comment-created") throw new Error("unreachable");
    const created = await db().select().from(comments).where(eq(comments.id, outcome.commentId)).get();
    expect(created?.posterId).toBe(10);
    expect(created?.type).toBe(0);
    expect(created?.content).toBe("a fresh reply body");

    // The inbound log row: outcome + decode facts.
    const row = await inboundRow(mail.messageId);
    expect(row?.outcome).toBe("comment-created");
    expect(row?.tokenStatus).toBe("valid");
    expect(row?.userId).toBe(10);
    expect(row?.refType).toBe("issue");
    expect(row?.refId).toBe(issue.id);
    expect(row?.commentId).toBe(outcome.commentId);

    // The notify fan: the emitted comment produced outbox rows + queue
    // messages (the mail env seam round-trip, SPEC §6.11).
    const envQueue = envSlice.REPO_TASKS as Queue & { sends: number; sendBodies: unknown[] };
    const outboxRows = await db().select().from(emailOutbox).all();
    expect(outboxRows.length).toBeGreaterThan(0);
    expect(envQueue.sends).toBe(outboxRows.length);
    expect(envQueue.sendBodies[0]).toMatchObject({ kind: "mail-outbox" });
  });

  it("dedupes a redelivered Message-ID (at-least-once ⇒ one comment)", async () => {
    const issue = await seedIssue();
    const token = await validToken({ refId: issue.id });
    const mail = goodMail({ token });
    const envSlice = inboundEnv();
    const first = await handleIncomingEmail(envSlice, mail.message, { now: NOW });
    expect(first.outcome).toBe("comment-created");
    const second = await handleIncomingEmail(envSlice, mail.message, { now: NOW });
    expect(second).toEqual({ outcome: "dropped-duplicate" });
    const replies = await db().select().from(comments).where(eq(comments.issueId, issue.id)).all();
    expect(replies).toHaveLength(1);
    const created = await db().select().from(emailInbound).all();
    expect(created.filter((r) => r.outcome === "comment-created")).toHaveLength(1);
  });

  it("rejects a spoofed From WITHOUT a token and a forged token (From is never authority)", async () => {
    const issue = await seedIssue();
    const envSlice = inboundEnv();
    const noToken = goodMail({
      token: "",
      toHeader: "reply@mail.example",
      fromHeader: "Site Admin <siteadmin@example.com>",
    });
    expect(await handleIncomingEmail(envSlice, noToken.message, { now: NOW })).toEqual({ outcome: "dropped-no-token" });

    const forged = goodMail({
      token: "A".repeat(52),
      fromHeader: "Poster <poster@example.com>",
    });
    expect(await handleIncomingEmail(envSlice, forged.message, { now: NOW })).toEqual({
      outcome: "dropped-invalid-token",
    });
    expect(await db().select().from(comments).where(eq(comments.issueId, issue.id)).all()).toHaveLength(0);
  });

  it("drops an automatic reply BEFORE the token search even with a valid token (order pin)", async () => {
    const issue = await seedIssue();
    const token = await validToken({ refId: issue.id });
    const mail = goodMail({ token, extraHeaders: { "Auto-Submitted": "auto-generated" } });
    const outcome = await handleIncomingEmail(inboundEnv(), mail.message, { now: NOW });
    expect(outcome).toEqual({ outcome: "dropped-auto-reply" });
    const row = await inboundRow(mail.messageId);
    expect(row?.tokenStatus).toBe("none"); // the search never ran
  });

  it("the disabled gate writes NOTHING (zero-rows tripwire)", async () => {
    await seedIssue();
    const token = await validToken({ refId: 1 });
    const mail = goodMail({ token });
    const outcome = await handleIncomingEmail(inboundEnv({ MAIL_INBOUND_ENABLED: "false" }), mail.message, {
      now: NOW,
    });
    expect(outcome).toEqual({ outcome: "disabled" });
    expect(await db().select().from(emailInbound).all()).toHaveLength(0);
  });

  it("misconfiguration arms: missing secret and an invalid reply template record the row", async () => {
    await seedIssue();
    const token = await validToken({ refId: 1 });
    const noSecret = goodMail({ token });
    expect(
      await handleIncomingEmail(inboundEnv({ MAIL_INBOUND_SECRET: undefined }), noSecret.message, { now: NOW }),
    ).toEqual({
      outcome: "misconfigured",
      message: "[mail-inbound] MAIL_INBOUND_SECRET is missing",
    });
    const badTemplate = goodMail({ token });
    expect(
      await handleIncomingEmail(inboundEnv({ MAIL_INBOUND_REPLY_ADDRESS: "reply@mail.example" }), badTemplate.message, {
        now: NOW,
      }),
    ).toEqual({ outcome: "misconfigured", message: "[mail-inbound] MAIL_INBOUND_REPLY_ADDRESS is invalid" });
    const rows = await db().select().from(emailInbound).all();
    expect(rows.filter((r) => r.outcome === "dropped-misconfigured")).toHaveLength(2);
  });

  it("rejects oversized mail BEFORE any read (setReject, upstream MaximumMessageSize)", async () => {
    const issue = await seedIssue();
    const token = await validToken({ refId: issue.id });
    const messageId = `<oversize-${Math.random().toString(36).slice(2)}@sender.example>`;
    const to = `reply+${token}@mail.example`;
    const raw = rawMail({
      to,
      headers: { "Message-ID": messageId },
      body: "body",
      contentType: "text/plain; charset=utf-8",
    });
    const { message } = fakeMessage(raw, { rawSize: MAIL_INBOUND_MAX_MESSAGE_SIZE + 1, headers: { To: to, "Message-ID": messageId } });
    const outcome = await handleIncomingEmail(inboundEnv(), message, { now: NOW });
    expect(outcome).toEqual({ outcome: "rejected-oversize" });
    expect((await inboundRow(messageId))?.outcome).toBe("rejected-oversize");
  });

  it("the read gates: a public repo reads to everyone, a private repo needs a grant", async () => {
    // Public repo: the NO-GRANT user (30) comments fine (CheckRepoUnitUser
    // parity — a public repo reads to everyone, repo_permission.go:660-672).
    const issue = await seedIssue(PUBLIC_REPO);
    const publicMail = goodMail({ token: await validToken({ userId: 30, refId: issue.id }) });
    expect((await handleIncomingEmail(inboundEnv(), publicMail.message, { now: NOW })).outcome).toBe("comment-created");

    // Private repo without a grant: dropped-permission.
    const privateIssue = await seedIssue(PRIVATE_REPO, "private");
    const strangerMail = goodMail({ token: await validToken({ userId: 30, refId: privateIssue.id }) });
    expect(await handleIncomingEmail(inboundEnv(), strangerMail.message, { now: NOW })).toEqual({
      outcome: "dropped-permission",
    });

    // Private repo WITH a write grant (collaborator 20): comments.
    await db().insert(repoCollaborators).values({ repoId: PRIVATE_REPO, userId: 20, mode: "write" });
    const collabMail = goodMail({ token: await validToken({ userId: 20, refId: privateIssue.id }) });
    expect((await handleIncomingEmail(inboundEnv(), collabMail.message, { now: NOW })).outcome).toBe("comment-created");
  });

  it("a locked issue requires write (or site admin) — upstream incoming_handler.go:75-79", async () => {
    const issue = await seedIssue();
    await db().update(issues).set({ isLocked: true }).where(eq(issues.id, issue.id));
    const plainMail = goodMail({ token: await validToken({ userId: 30, refId: issue.id }) });
    expect(await handleIncomingEmail(inboundEnv(), plainMail.message, { now: NOW })).toEqual({
      outcome: "dropped-permission",
    });
    const adminMail = goodMail({ token: await validToken({ userId: 2, refId: issue.id }) });
    expect((await handleIncomingEmail(inboundEnv(), adminMail.message, { now: NOW })).outcome).toBe("comment-created");
  });

  it("expires, orgs, prohibited users and missing refs drop with the right verdicts", async () => {
    await seedIssue();
    const envSlice = inboundEnv();

    const expired = goodMail({
      token: await createReplyToken(SECRET, {
        userId: 10,
        refType: "issue",
        refId: 1,
        now: new Date(NOW.getTime() - 366 * 24 * 60 * 60 * 1000),
      }),
    });
    expect(await handleIncomingEmail(envSlice, expired.message, { now: NOW })).toEqual({
      outcome: "dropped-expired-token",
    });

    const orgToken = goodMail({ token: await validToken({ userId: 12, refId: 1 }) });
    expect(await handleIncomingEmail(envSlice, orgToken.message, { now: NOW })).toEqual({
      outcome: "dropped-invalid-token",
    });

    const frozenToken = goodMail({ token: await validToken({ userId: 11, refId: 1 }) });
    expect(await handleIncomingEmail(envSlice, frozenToken.message, { now: NOW })).toEqual({
      outcome: "dropped-invalid-token",
    });

    const missingToken = goodMail({ token: await validToken({ refId: 424242 }) });
    expect(await handleIncomingEmail(envSlice, missingToken.message, { now: NOW })).toEqual({
      outcome: "dropped-missing-ref",
    });

    const commentRefToken = goodMail({ token: await validToken({ refType: "comment", refId: 424242 }) });
    expect(await handleIncomingEmail(envSlice, commentRefToken.message, { now: NOW })).toEqual({
      outcome: "dropped-missing-ref",
    });
  });

  it("a comment-ref token resolves through the comment to its issue", async () => {
    const issue = await seedIssue();
    const bare = new IssuesService(env.DB);
    const earlier = await bare.addComment({ issueId: issue.id, posterId: 10, content: "earlier" });
    const token = await validToken({ refType: "comment", refId: earlier.id });
    const mail = goodMail({ token });
    const outcome = await handleIncomingEmail(inboundEnv(), mail.message, { now: NOW });
    expect(outcome.outcome).toBe("comment-created");
    const row = await inboundRow(mail.messageId);
    expect(row?.refType).toBe("comment");
    expect(row?.refId).toBe(earlier.id);
  });

  it("drops empty extracted content (html-only mail, upstream :112-114)", async () => {
    const issue = await seedIssue();
    const token = await validToken({ refId: issue.id });
    const messageId = `<html-only-${Math.random().toString(36).slice(2)}@sender.example>`;
    const to = `reply+${token}@mail.example`;
    const raw = rawMail({
      to,
      headers: { "Message-ID": messageId },
      contentType: "text/html; charset=utf-8",
      body: "<p>only html</p>",
    });
    const { message } = fakeMessage(raw, {
      headers: { To: to, "Message-ID": messageId, "Content-Type": "text/html; charset=utf-8" },
    });
    expect(await handleIncomingEmail(inboundEnv(), message, { now: NOW })).toEqual({ outcome: "dropped-empty" });
  });

  it("the Message-ID-less fallback key still collapses duplicates", async () => {
    const issue = await seedIssue();
    const token = await validToken({ refId: issue.id });
    const mk = () => {
      const to = `reply+${token}@mail.example`;
      const raw = rawMail({
        to,
        body: "no message id here",
        contentType: "text/plain; charset=utf-8",
      });
      return fakeMessage(raw, {
        headers: { To: to, Subject: "Re: [repoowner/repo] Issue title (#1)", "Content-Type": "text/plain; charset=utf-8" },
      }).message;
    };
    expect((await handleIncomingEmail(inboundEnv(), mk(), { now: NOW })).outcome).toBe("comment-created");
    expect((await handleIncomingEmail(inboundEnv(), mk(), { now: NOW })).outcome).toBe("dropped-duplicate");
  });

  it("logs Cloudflare's Authentication-Results only when the mx.cloudflare.net identifier matches", async () => {
    const issue = await seedIssue();
    const token = await validToken({ refId: issue.id });
    const good = goodMail({
      token,
      extraHeaders: { "Authentication-Results": "mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass" },
    });
    await handleIncomingEmail(inboundEnv(), good.message, { now: NOW });
    expect((await inboundRow(good.messageId))?.authResults).toContain("mx.cloudflare.net");

    const forged = goodMail({
      token: await validToken({ userId: 30, refId: issue.id }),
      extraHeaders: { "Authentication-Results": "evil.example; spf=pass" },
    });
    await handleIncomingEmail(inboundEnv(), forged.message, { now: NOW });
    expect((await inboundRow(forged.messageId))?.authResults).toBeNull();
  });

  it("lowercases the To-carried token end to end (an MTA-downcased local-part still works)", async () => {
    const issue = await seedIssue();
    const token = await validToken({ refId: issue.id });
    const mail = goodMail({ token, toHeader: `reply+${token.toLowerCase()}@mail.example` });
    expect((await handleIncomingEmail(inboundEnv(), mail.message, { now: NOW })).outcome).toBe("comment-created");
  });
});
