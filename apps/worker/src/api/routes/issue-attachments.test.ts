/**
 * Issue + comment attachment routes on real D1+R2 (upstream
 * routers/api/v1/repo/issue_attachment.go + issue_comment_attachment.go over
 * the migration-0014 `issue_attachments` table + the REPO_PACKS bucket).
 * Pins: the row-first streaming upload contract of routes/issue-attachments.ts
 * (row inserted before the bytes; `repos/<storage_key>/attachments/<id>/<name>`
 * key layout with the sanitized name segment; sha256 row checksum), the
 * inline multipart/octet-stream POST shapes with the upstream name priority
 * (query ?name= > multipart `name` field > part filename), the body-less
 * two-phase relay initiation (201 + Location) and its worker-internal
 * PUT/GET blob pair (411/413/download_count), the 413 threshold at the
 * service seam, the issue-404 / comment-404 / attachment-belongs-to 404
 * rules, the archived 423s, the poster-or-writer gates of both families
 * (incl. the locked-issue arm), and the 201-on-edit / 204-on-delete codes.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { issueAttachments, comments, issues, repositories, userBlocking } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import type { AuthResolver } from "../auth";
import { createOptionalTokenAuthMiddleware, createStubAuthResolver, createTokenAuthMiddleware, STUB_USER } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerIssueAttachmentRoutes, MAX_ISSUE_ATTACHMENT_BYTES, issueAttachmentKey, uploadIssueAttachment } from "./issue-attachments";
import { MAX_RELEASE_ASSET_BYTES, AssetTooLargeError } from "../services/release-assets";
import { addOrUpdateCollaborator } from "../services/repo-collaborators";
import { saveRepoSettings } from "../services/repo-settings";

const TOKEN = "stub-token";
const TOKEN_POSTER = "poster-token";
const TOKEN_READER = "collab-reader-token";
const ERROR_URL = "https://example.com/api/swagger";
const REPO_ID = "7402";
const REPO_PATH = "/repos/cf-gitea-stub/iss";
const auth = { Authorization: `token ${TOKEN}` };
const posterAuth = { Authorization: `token ${TOKEN_POSTER}` };
const readerAuth = { Authorization: `token ${TOKEN_READER}` };

interface TestIssue {
  id: number;
  index: number;
  posterId: number;
}

function makeApp(): (path: string | Request, init?: RequestInit) => Promise<Response> {
  const resolver: AuthResolver = {
    resolveToken: (token) => {
      if (token === TOKEN) return createStubAuthResolver().resolveToken(token);
      if (token === TOKEN_POSTER) {
        return Promise.resolve({ ...STUB_USER, id: 3, login: "issue-poster", full_name: "Issue Poster" });
      }
      if (token === TOKEN_READER) {
        return Promise.resolve({ ...STUB_USER, id: 2, login: "collab-reader", full_name: "Collab Reader" });
      }
      return Promise.resolve(null);
    },
  };
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerIssueAttachmentRoutes(
    app,
    createTokenAuthMiddleware(resolver),
    createOptionalTokenAuthMiddleware(resolver),
  );
  return (path, init) =>
    Promise.resolve(app.fetch(typeof path === "string" ? new Request(`https://example.com${path}`, init) : path, env));
}

async function storedBytes(key: string): Promise<Uint8Array> {
  const stored = await env.REPO_PACKS.get(key);
  if (stored === null) throw new Error(`missing R2 object: ${key}`);
  return new Uint8Array(await stored.arrayBuffer());
}

async function storedSize(key: string): Promise<number> {
  const head = await env.REPO_PACKS.head(key);
  if (head === null) throw new Error(`missing R2 object: ${key}`);
  return head.size;
}

/** A one-shot byte stream (typed; Blob.stream() is ReadableStream<any>). */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** The single row of a one-row result (test-failure when not exactly one). */
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row");
  return row;
}

/** Every object key under the test repo's attachment prefix. */
async function listAttachmentKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await env.REPO_PACKS.list({ prefix: "repos/r_7402/attachments/", cursor });
    for (const object of page.objects) keys.push(object.key);
    if (!page.truncated) return keys;
    cursor = page.cursor;
    if (cursor === undefined) return keys;
  }
}

/** Build a deterministic multipart/form-data body (RFC 7578 subset). */
function multipartBody(
  boundary: string,
  parts: { name: string; filename?: string; body: string }[],
): { bytes: Uint8Array; contentType: string } {
  const chunks: Uint8Array[] = [];
  const push = (text: string): void => {
    chunks.push(new TextEncoder().encode(text));
  };
  for (const part of parts) {
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${part.name}"`);
    if (part.filename !== undefined) push(`; filename="${part.filename}"`);
    push("\r\nContent-Type: application/octet-stream\r\n\r\n");
    push(part.body);
    push("\r\n");
  }
  push(`--${boundary}--\r\n`);
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, contentType: `multipart/form-data; boundary=${boundary}` };
}

let issueSeq = 0;

async function seedIssue(options: { posterId?: number; isPull?: boolean; isLocked?: boolean } = {}): Promise<TestIssue> {
  issueSeq += 1;
  const service = new IssuesService(env.DB);
  const now = new Date("2026-03-01T00:00:00Z");
  const row =
    options.isPull === true
      ? (await service.createPullRequest({
          repoId: REPO_ID,
          posterId: options.posterId ?? 1,
          title: `seed pr ${issueSeq}`,
          content: "seed body",
          headRepoId: REPO_ID,
          baseBranch: "main",
          headBranch: `feature-${issueSeq}`,
          now,
        })).issue
      : await service.createIssue({
          repoId: REPO_ID,
          posterId: options.posterId ?? 1,
          title: `seed issue ${issueSeq}`,
          content: "seed body",
          now,
        });
  if (options.isLocked === true) {
    await drizzle(env.DB).update(issues).set({ isLocked: true }).where(eq(issues.id, row.id));
  }
  return { id: row.id, index: row.index, posterId: row.posterId ?? 0 };
}

async function seedComment(issue: TestIssue, posterId = 1): Promise<number> {
  const now = new Date("2026-03-01T00:00:00Z");
  const rows = await drizzle(env.DB)
    .insert(comments)
    .values({
      type: CommentType.Comment,
      posterId,
      issueId: issue.id,
      content: "seed comment",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return only(rows).id;
}

async function seedAttachmentDirect(issue: TestIssue, name = "stored.bin"): Promise<{ id: number; key: string }> {
  const row = await uploadIssueAttachment({
    bucket: env.REPO_PACKS,
    d1: env.DB,
    storageKey: "r_7402",
    issueId: issue.id,
    commentId: 0,
    uploaderId: 1,
    name,
    content: streamOf(new TextEncoder().encode(`bytes of ${name}`)),
    multipart: false,
    declaredLength: `bytes of ${name}`.length,
  });
  return { id: row.id, key: row.r2Key ?? "" };
}

/** A stored comment-parented attachment ("comment bytes" of `name`). */
async function seedCommentAttachment(issue: TestIssue, commentId: number, name: string) {
  const payload = new TextEncoder().encode("comment bytes");
  return uploadIssueAttachment({
    bucket: env.REPO_PACKS,
    d1: env.DB,
    storageKey: "r_7402",
    issueId: issue.id,
    commentId,
    uploaderId: 1,
    name,
    content: streamOf(payload),
    multipart: false,
    declaredLength: payload.byteLength,
  });
}

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  issueSeq = 0;
  for (const table of [
    "issue_attachments",
    "comments",
    "issues",
    "repo_collaborators",
    "repo_settings",
    "repo_counters",
    "user_blocking",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (2, 'collab-reader', 'collab-reader', 0, 'active', 0)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (3, 'issue-poster', 'issue-poster', 0, 'active', 0)",
  ).run();
  await drizzle(env.DB).insert(repositories).values({
    id: REPO_ID,
    storageKey: "r_7402",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "iss",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await new IssuesService(env.DB).ensureRepoCounters(REPO_ID);
  await addOrUpdateCollaborator(env.DB, REPO_ID, 2, "read", new Date("2026-02-03T04:05:06Z"));
  for (const key of await listAttachmentKeys()) {
    await env.REPO_PACKS.delete(key);
  }
});

// ---------------------------------------------------------------------------
// The issue family
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/issues/{index}/assets (issueCreateIssueAttachment)", () => {
  it("uploads an octet-stream body: row-first landing, key layout, checksum", async () => {
    const issue = await seedIssue();
    const payload = new TextEncoder().encode("issue attachment bytes\n");
    const res = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets?name=trace.log`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": String(payload.byteLength) },
      body: payload,
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.name).toBe("trace.log");
    expect(body.size).toBe(payload.byteLength);
    expect(body.download_count).toBe(0);
    expect(body.id).toBeGreaterThan(0);
    expect(body.uuid).toBeTypeOf("string");
    expect(body.browser_download_url).toBe(`https://example.com/attachments/${String(body.uuid)}`);

    const row = only(await drizzle(env.DB).select().from(issueAttachments).all());
    expect(row.issueId).toBe(issue.id);
    expect(row.commentId).toBe(0);
    expect(row.uploaderId).toBe(1);
    expect(row.checksumSha256).toBe(await sha256Hex(payload));
    expect(row.r2Key).toBe(issueAttachmentKey("r_7402", row.id, "trace.log"));
    expect(row.r2Key).toMatch(/^repos\/r_7402\/attachments\/\d+\/trace\.log$/);
    expect(await storedBytes(row.r2Key ?? "")).toEqual(payload);
  });

  it("uploads a multipart file part; query ?name= overrides the part filename", async () => {
    const issue = await seedIssue();
    const { bytes, contentType } = multipartBody("compat-boundary-42", [
      { name: "attachment", filename: "heap dump.dmp", body: "multipart attachment bytes" },
    ]);
    const res = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets`, {
      method: "POST",
      headers: { ...auth, "Content-Type": contentType, "Content-Length": String(bytes.byteLength) },
      body: bytes,
    });
    expect(res.status).toBe(201);
    expect((await res.json<Record<string, unknown>>()).name).toBe("heap dump.dmp");
    const row = only(await drizzle(env.DB).select().from(issueAttachments).all());
    // the key segment is sanitized; the display name stays verbatim in D1
    expect(row.r2Key).toContain("heap_dump.dmp");
    expect(row.name).toBe("heap dump.dmp");

    const issue2 = await seedIssue();
    const withQuery = multipartBody("compat-boundary-42", [
      { name: "attachment", filename: "original.bin", body: "query wins" },
    ]);
    const resQuery = await makeApp()(`${REPO_PATH}/issues/${issue2.index}/assets?name=from-query`, {
      method: "POST",
      headers: { ...auth, "Content-Type": withQuery.contentType, "Content-Length": String(withQuery.bytes.byteLength) },
      body: withQuery.bytes,
    });
    expect(resQuery.status).toBe(201);
    expect((await resQuery.json<Record<string, unknown>>()).name).toBe("from-query");
  });

  it("400s when the name cannot be determined and when the multipart part is missing", async () => {
    const issue = await seedIssue();
    const noName = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": "3" },
      body: "abc",
    });
    expect(noName.status).toBe(400);
    expect(await noName.json()).toEqual({ message: "Could not determine name of attachment.", url: ERROR_URL });

    const noPart = multipartBody("compat-boundary-42", [{ name: "name", body: "x.zip" }]);
    const resPart = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets`, {
      method: "POST",
      headers: { ...auth, "Content-Type": noPart.contentType, "Content-Length": String(noPart.bytes.byteLength) },
      body: noPart.bytes,
    });
    expect(resPart.status).toBe(400);
    expect((await resPart.json<Record<string, unknown>>()).message).toBe("no attachment file in request");
    // no ghost rows from the failed creates
    expect(await drizzle(env.DB).select().from(issueAttachments).all()).toHaveLength(0);
  });

  it("411s a stream upload without Content-Length", async () => {
    const issue = await seedIssue();
    const request = new Request(`https://example.com${REPO_PATH}/issues/${issue.index}/assets?name=x.bin`, {
      method: "POST",
      headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Blob(["chunked bytes"]).stream(),
      duplex: "half",
    } as RequestInit);
    expect((await makeApp()(request)).status).toBe(411);
  });

  it("401s an anonymous caller and 403s a read-mode collaborator (runtime-only 403)", async () => {
    const issue = await seedIssue();
    const anon = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets?name=x`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: "x",
    });
    expect(anon.status).toBe(401);
    const reader = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets?name=x`, {
      method: "POST",
      headers: { ...readerAuth, "Content-Type": "application/octet-stream" },
      body: "x",
    });
    expect(reader.status).toBe(403);
    expect(await reader.json()).toEqual({
      message: "user should have permission to write issue",
      url: ERROR_URL,
    });
  });

  it("lets the issue poster attach without repo write access (canUserWriteIssueAttachment)", async () => {
    const issue = await seedIssue({ posterId: 3 });
    const res = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets?name=poster.bin`, {
      method: "POST",
      headers: { ...posterAuth, "Content-Type": "application/octet-stream", "Content-Length": "2" },
      body: "ok",
    });
    expect(res.status).toBe(201);
    expect((await res.json<Record<string, unknown>>()).name).toBe("poster.bin");
  });

  it("404s an unknown issue index and 423s an archived repo (mustNotBeArchived precedes the handler)", async () => {
    const issue = await seedIssue();
    // not archived yet: the missing index answers the issue 404
    const missing = await makeApp()(`${REPO_PATH}/issues/999/assets?name=x`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream" },
      body: "x",
    });
    expect(missing.status).toBe(404);
    // archived: the middleware-order 423 wins (before the handler's issue lookup)
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, REPO_ID));
    const archived = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets?name=x`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream" },
      body: "x",
    });
    expect(archived.status).toBe(423);
    expect(await archived.json()).toEqual({ message: "repo is archived", url: ERROR_URL });
    const archivedMissing = await makeApp()(`${REPO_PATH}/issues/999/assets?name=x`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream" },
      body: "x",
    });
    expect(archivedMissing.status).toBe(423);
  });

  it("attaches to pull requests too (the shared issue row)", async () => {
    const pr = await seedIssue({ isPull: true });
    const res = await makeApp()(`${REPO_PATH}/issues/${pr.index}/assets?name=pr.bin`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": "2" },
      body: "ok",
    });
    expect(res.status).toBe(201);
    const row = only(await drizzle(env.DB).select().from(issueAttachments).all());
    expect(row.issueId).toBe(pr.id);
  });

  it("412s nothing: the issues-disabled flag is not enforced (undeclared, unreachable)", async () => {
    const issue = await seedIssue();
    await saveRepoSettings(env.DB, REPO_ID, { hasIssues: false }, new Date());
    const res = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets?name=x.bin`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": "1" },
      body: "x",
    });
    expect(res.status).toBe(201);
  });
});

describe("GET /repos/{owner}/{repo}/issues/{index}/assets (issueListIssueAttachments)", () => {
  it("lists the issue's direct attachments in id order", async () => {
    const issue = await seedIssue();
    await seedAttachmentDirect(issue, "beta.log");
    await seedAttachmentDirect(issue, "alpha.log");
    const res = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets`);
    expect(res.status).toBe(200);
    const list = await res.json<Record<string, unknown>[]>();
    expect(list.map((entry) => entry.name)).toEqual(["beta.log", "alpha.log"]);
    for (const entry of list) {
      expect(entry.browser_download_url).toBe(`https://example.com/attachments/${String(entry.uuid)}`);
      expect(entry.download_count).toBe(0);
    }
  });

  it("hides comment attachments from the issue list and answers an empty list", async () => {
    const issue = await seedIssue();
    const commentId = await seedComment(issue);
    await seedCommentAttachment(issue, commentId, "in-comment.bin");
    const res = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("404s an unknown issue index with the ErrIssueNotExist message", async () => {
    const res = await makeApp()(`${REPO_PATH}/issues/999/assets`);
    expect(res.status).toBe(404);
    expect((await res.json<Record<string, unknown>>()).message).toContain("issue does not exist");
  });
});

describe("GET/PATCH/DELETE …/issues/{index}/assets/{attachment_id} (issueGet/Edit/DeleteIssueAttachment)", () => {
  it("gets one attachment and 404s cross-issue and comment-parent ids", async () => {
    const issue = await seedIssue();
    const other = await seedIssue();
    const attach = await seedAttachmentDirect(issue);
    const commentId = await seedComment(issue);
    const inComment = await seedCommentAttachment(issue, commentId, "comment.bin");

    const ok = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets/${attach.id}`);
    expect(ok.status).toBe(200);
    const body = await ok.json<Record<string, unknown>>();
    expect(body.id).toBe(attach.id);
    expect(body.name).toBe("stored.bin");
    expect(body.size).toBe("bytes of stored.bin".length);

    // another issue's index → "no such attachment in issue"
    const cross = await makeApp()(`${REPO_PATH}/issues/${other.index}/assets/${attach.id}`);
    expect(cross.status).toBe(404);
    expect((await cross.json<Record<string, unknown>>()).message).toBe("no such attachment in issue");
    // a comment attachment is not an issue attachment (comment_id != 0 arm)
    const commentParented = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets/${inComment.id}`);
    expect(commentParented.status).toBe(404);
    expect((await commentParented.json<Record<string, unknown>>()).message).toBe("no such attachment in issue");
    // unknown id → the ErrAttachmentNotExist text
    const missing = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets/9999`);
    expect(missing.status).toBe(404);
    expect((await missing.json<Record<string, unknown>>()).message).toBe("attachment does not exist [id: 9999, uuid: ]");
  });

  it("renames with PATCH (201 on edit, verbatim) and leaves the stored object keyed", async () => {
    const issue = await seedIssue();
    const attach = await seedAttachmentDirect(issue, "before.log");
    const res = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets/${attach.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "after.log" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.name).toBe("after.log");
    const row = only(await drizzle(env.DB).select().from(issueAttachments).all());
    expect(row.name).toBe("after.log");
    // the object keeps its landing key (upstream never moves the file either)
    expect(row.r2Key).toBe(attach.key);
    expect(await storedSize(attach.key)).toBe("bytes of before.log".length);
  });

  it("keeps the name when PATCH carries no/empty name; 422s a refused body shape", async () => {
    const issue = await seedIssue();
    const attach = await seedAttachmentDirect(issue, "keep.log");
    const empty = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets/${attach.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(201);
    expect((await empty.json<Record<string, unknown>>()).name).toBe("keep.log");

    // a wrong-typed field refuses the EditAttachmentOptions shape → the bind 422
    const refused = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets/${attach.id}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: 42 }),
    });
    expect(refused.status).toBe(422);
  });

  it("403s a reader's rename but allows the issue poster", async () => {
    const issue = await seedIssue({ posterId: 3 });
    const attach = await seedAttachmentDirect(issue, "poster.log");
    const reader = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets/${attach.id}`, {
      method: "PATCH",
      headers: { ...readerAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nope.log" }),
    });
    expect(reader.status).toBe(403);
    const poster = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets/${attach.id}`, {
      method: "PATCH",
      headers: { ...posterAuth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "yes.log" }),
    });
    expect(poster.status).toBe(201);
    expect((await poster.json<Record<string, unknown>>()).name).toBe("yes.log");
  });

  it("deletes: object gone first, then the row, 204 — and 404s repeats", async () => {
    const issue = await seedIssue();
    const attach = await seedAttachmentDirect(issue, "doomed.bin");
    const res = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets/${attach.id}`, { method: "DELETE", headers: auth });
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(issueAttachments).all()).toHaveLength(0);
    expect(await listAttachmentKeys()).toHaveLength(0);
    const repeat = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets/${attach.id}`, { method: "DELETE", headers: auth });
    expect(repeat.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The comment family
// ---------------------------------------------------------------------------

describe("the comment family (/repos/{owner}/{repo}/issues/comments/{id}/assets…)", () => {
  it("creates (201), lists, gets and deletes a comment attachment", async () => {
    const issue = await seedIssue();
    const commentId = await seedComment(issue);

    const created = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets?name=c.bin`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": "4" },
      body: "cccc",
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json<Record<string, unknown>>();
    expect(createdBody.name).toBe("c.bin");
    const attachmentId = createdBody.id as number;

    const row = only(await drizzle(env.DB).select().from(issueAttachments).all());
    expect(row.commentId).toBe(commentId);
    expect(row.issueId).toBe(issue.id);

    const list = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets`);
    expect(list.status).toBe(200);
    expect((await list.json<Record<string, unknown>[]>().then((entries) => entries.map((entry) => entry.id)))).toEqual([attachmentId]);

    const got = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets/${attachmentId}`);
    expect(got.status).toBe(200);
    expect((await got.json<Record<string, unknown>>()).name).toBe("c.bin");

    const deleted = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets/${attachmentId}`, {
      method: "DELETE",
      headers: auth,
    });
    expect(deleted.status).toBe(204);
    expect(await drizzle(env.DB).select().from(issueAttachments).all()).toHaveLength(0);
  });

  it("declares 403 on create: a reader is forbidden with the comment-edit message", async () => {
    const issue = await seedIssue();
    const commentId = await seedComment(issue);
    const res = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets?name=x`, {
      method: "POST",
      headers: { ...readerAuth, "Content-Type": "application/octet-stream" },
      body: "x",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user should have permission to edit comment", url: ERROR_URL });
  });

  it("lets the comment poster attach; a locked issue denies the poster without write", async () => {
    const issue = await seedIssue();
    const commentId = await seedComment(issue, 3); // poster 3's comment
    const ok = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets?name=by-poster.bin`, {
      method: "POST",
      headers: { ...posterAuth, "Content-Type": "application/octet-stream", "Content-Length": "2" },
      body: "ok",
    });
    expect(ok.status).toBe(201);

    // lock the issue: the poster-without-write arm of CanSelfChangeOrAccessContent
    await drizzle(env.DB).update(issues).set({ isLocked: true }).where(eq(issues.id, issue.id));
    const locked = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets?name=nope.bin`, {
      method: "POST",
      headers: { ...posterAuth, "Content-Type": "application/octet-stream", "Content-Length": "2" },
      body: "no",
    });
    expect(locked.status).toBe(403);
    // write access rides through the lock
    const writer = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets?name=writer.bin`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": "2" },
      body: "ok",
    });
    expect(writer.status).toBe(201);
  });

  it("404s an unknown comment id and cross-comment attachment ids", async () => {
    const issue = await seedIssue();
    const commentId = await seedComment(issue);
    const otherComment = await seedComment(issue);
    const created = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets?name=x.bin`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": "1" },
      body: "x",
    });
    const attachmentId = (await created.json<Record<string, unknown>>()).id as number;

    const missingComment = await makeApp()(`${REPO_PATH}/issues/comments/424242/assets`);
    expect(missingComment.status).toBe(404);
    expect((await missingComment.json<Record<string, unknown>>()).message).toBe("comment does not exist [id: 424242, issue_id: 0]");

    const cross = await makeApp()(`${REPO_PATH}/issues/comments/${otherComment}/assets/${attachmentId}`);
    expect(cross.status).toBe(404);
    expect((await cross.json<Record<string, unknown>>()).message).toBe("no such attachment in comment");

    // an issue-level attachment is not a comment attachment either
    const direct = await seedAttachmentDirect(issue);
    const issueParented = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets/${direct.id}`);
    expect(issueParented.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The worker-internal relay pair (outside the OpenAPI document)
// ---------------------------------------------------------------------------

describe("the two-phase relay (PUT/GET …/issues/attachments/{id}/blob)", () => {
  it("initiates with a body-less POST: 201 + Attachment + Location, no bytes yet", async () => {
    const issue = await seedIssue();
    const res = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets?name=relay.bin`, {
      method: "POST",
      headers: { ...auth },
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.name).toBe("relay.bin");
    expect(body.size).toBe(0);
    const location = res.headers.get("Location");
    expect(location).toBe(
      `https://example.com/api/v1/repos/cf-gitea-stub/iss/issues/attachments/${String(body.id)}/blob`,
    );
    const row = only(await drizzle(env.DB).select().from(issueAttachments).all());
    expect(row.r2Key).toBeNull();
    expect(await listAttachmentKeys()).toHaveLength(0);
  });

  it("relay PUTs the bytes with the write gate, then GET streams them back with the download count", async () => {
    const issue = await seedIssue();
    const init = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets?name=relay.bin`, {
      method: "POST",
      headers: { ...auth },
    });
    const attachmentId = (await init.json<Record<string, unknown>>()).id as number;
    const blobUrl = `${REPO_PATH}/issues/attachments/${attachmentId}/blob`;
    const payload = new TextEncoder().encode("relayed bytes here");

    const denied = await makeApp()(blobUrl, {
      method: "PUT",
      headers: { ...readerAuth, "Content-Type": "application/octet-stream" },
      body: payload,
    });
    expect(denied.status).toBe(403);

    const put = await makeApp()(blobUrl, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": String(payload.byteLength) },
      body: payload,
    });
    expect(put.status).toBe(200);
    const putBody = await put.json<Record<string, unknown>>();
    expect(putBody.state).toBe("ready");
    expect(putBody.bytes).toBe(payload.byteLength);
    expect(putBody.sha256).toBe(await sha256Hex(payload));

    const row = only(await drizzle(env.DB).select().from(issueAttachments).all());
    expect(row.r2Key).toBe(issueAttachmentKey("r_7402", row.id, "relay.bin"));
    expect(await storedBytes(row.r2Key ?? "")).toEqual(payload);

    const got = await makeApp()(blobUrl);
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(payload);
    expect(got.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(got.headers.get("Content-Disposition")).toContain("relay.bin");
    expect(await drizzle(env.DB).select().from(issueAttachments).then((rows) => rows[0]?.downloadCount)).toBe(1);
    const again = await makeApp()(blobUrl);
    expect(again.status).toBe(200);
    expect(await drizzle(env.DB).select().from(issueAttachments).then((rows) => rows[0]?.downloadCount)).toBe(2);
  });

  it("relay GET 404s a pending row and a lying relay PUT is capped/validated", async () => {
    const issue = await seedIssue();
    const init = await makeApp()(`${REPO_PATH}/issues/${issue.index}/assets?name=pending.bin`, {
      method: "POST",
      headers: { ...auth },
    });
    const attachmentId = (await init.json<Record<string, unknown>>()).id as number;
    const blobUrl = `${REPO_PATH}/issues/attachments/${attachmentId}/blob`;

    const pendingGet = await makeApp()(blobUrl);
    expect(pendingGet.status).toBe(404);

    const noLength = new Request(`https://example.com${blobUrl}`, {
      method: "PUT",
      headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/octet-stream" },
      body: new Blob(["chunked"]).stream(),
      duplex: "half",
    } as RequestInit);
    expect((await makeApp()(noLength)).status).toBe(411);

    const lying = await makeApp()(blobUrl, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Length": "100" },
      body: "short",
    });
    expect(lying.status).toBe(400);
  });

  it("relay PUT enforces the family gate for comment attachments and 413s over the cap at the service seam", async () => {
    const issue = await seedIssue();
    const commentId = await seedComment(issue);
    const init = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets?name=crelay.bin`, {
      method: "POST",
      headers: { ...auth },
    });
    const attachmentId = (await init.json<Record<string, unknown>>()).id as number;
    const blobUrl = `${REPO_PATH}/issues/attachments/${attachmentId}/blob`;
    const denied = await makeApp()(blobUrl, {
      method: "PUT",
      headers: { ...readerAuth, "Content-Type": "application/octet-stream" },
      body: "x",
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ message: "user should have permission to edit comment", url: ERROR_URL });

    const payload = new Uint8Array(64).fill(5);
    const rowsBefore = await drizzle(env.DB).select().from(issueAttachments).all();
    await expect(
      uploadIssueAttachment({
        bucket: env.REPO_PACKS,
        d1: env.DB,
        storageKey: "r_7402",
        issueId: issue.id,
        commentId: 0,
        uploaderId: 1,
        name: "too-big.bin",
        content: streamOf(payload),
        multipart: false,
        declaredLength: 64,
        maxBytes: 32,
      }),
    ).rejects.toBeInstanceOf(AssetTooLargeError);
    // the failed upload leaves no extra row (the pending relay row above stays)
    const rowsAfter = await drizzle(env.DB).select().from(issueAttachments).all();
    expect(rowsAfter).toHaveLength(rowsBefore.length);
    expect(rowsAfter.some((row) => row.name === "too-big.bin")).toBe(false);
    expect(await listAttachmentKeys()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Storage internals
// ---------------------------------------------------------------------------

describe("issue-attachment storage internals (SPEC-0005 §3.3 key family)", () => {
  it("builds the documented key and sanitizes the name segment", () => {
    expect(issueAttachmentKey("r_7402", 12, "dist (v2).zip")).toBe("repos/r_7402/attachments/12/dist_v2_.zip");
    expect(issueAttachmentKey("r_7402", 12, "../../etc/passwd")).toBe("repos/r_7402/attachments/12/.._etc_passwd");
    expect(issueAttachmentKey("r_7402", 12, "……")).toBe("repos/r_7402/attachments/12/attachment");
    expect(() => issueAttachmentKey("../evil", 1, "n")).toThrow();
    expect(() => issueAttachmentKey("r_7402", 0, "n")).toThrow();
    expect(MAX_ISSUE_ATTACHMENT_BYTES).toBe(512 * 1024 * 1024);
    expect(MAX_ISSUE_ATTACHMENT_BYTES).toBe(MAX_RELEASE_ASSET_BYTES); // the convention twin
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// The CreateIssueCommentAttachment blocked arm (issue_comment_attachment.go:
// 218-227 — ErrBlockedUser rides UpdateComment, AFTER the write-permission
// gate and AFTER the attachment row + bytes land; the repo-admin bypass is
// IsUserRepoAdmin, repo_permission.go:532).
// ---------------------------------------------------------------------------

describe("POST comment assets: the UpdateComment blocked arm", () => {
  it("403s a doer blocked by the repo owner and leaves the row behind (upstream lands the attachment before the check)", async () => {
    const issue = await seedIssue({ posterId: 3 });
    const commentId = await seedComment(issue, 2); // the reader's own comment — the write gate passes
    await drizzle(env.DB).insert(userBlocking).values({ blockerId: 1, blockeeId: 2, note: "", createdAt: new Date() });

    const res = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets?name=blocked.bin`, {
      method: "POST",
      headers: { ...readerAuth, "Content-Type": "application/octet-stream", "Content-Length": "2" },
      body: "no",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
    // Upstream's NewAttachment precedes the UpdateComment probe — the 403
    // does not roll the attachment back.
    const rows = await drizzle(env.DB).select().from(issueAttachments).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commentId).toBe(commentId);
  });

  it("a repo-admin doer bypasses the block (IsUserRepoAdmin)", async () => {
    const issue = await seedIssue({ posterId: 3 });
    const commentId = await seedComment(issue, 2);
    await drizzle(env.DB).insert(userBlocking).values({ blockerId: 1, blockeeId: 2, note: "", createdAt: new Date() });
    await addOrUpdateCollaborator(env.DB, REPO_ID, 2, "admin", new Date());

    const res = await makeApp()(`${REPO_PATH}/issues/comments/${commentId}/assets?name=admin.bin`, {
      method: "POST",
      headers: { ...readerAuth, "Content-Type": "application/octet-stream", "Content-Length": "2" },
      body: "ok",
    });
    expect(res.status).toBe(201);
  });
});
