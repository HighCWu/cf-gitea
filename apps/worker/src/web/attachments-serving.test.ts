/**
 * The site-level attachment-serving seam (src/web/attachments-serving.ts) on
 * real D1 + R2 — upstream routers/web/repo/attachment.go ServeAttachment at
 * the pin. Pins: the split-table uuid resolution (issue half → issue/PR unit,
 * release half → releases unit), the readGrant visibility matrix (public anon
 * / private reader / stranger-404, anti-enumeration), the scope check AFTER
 * the 404 arms (read:issue / read:repository → 403), the draft-release arm,
 * the download_count bump, the generic ETag private-cache 304s (ETag +
 * Last-Modified only, no Cache-Control), the sniffed content type with the
 * INLINE-by-default disposition (upstream sandboxes instead of forcing
 * downloads — the SVG-disabled arm is the only download one and it is dead at
 * frozen settings), the CSP variants, the R2 streaming with the 1024-byte
 * sniff pre-read, and the Go ports' wire forms (http.Error bodies,
 * mime.FormatMediaType disposition encoding, net/http sniff table).
 */

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { issueAttachments, issues, releaseAssets, releases, repositories, users } from "../db/schema";
import { IssuesService } from "../issues/service";
import { mintFor } from "../auth/testing/seeds";
import { uploadIssueAttachment } from "../api/routes/issue-attachments";
import {
  attachmentsServingRouter,
  detectContentType,
  encodeContentDisposition,
  goDetectContentType,
  PRIVATE_STATIC_CACHE_CONTROL,
  SERVE_CACHE_CONTROL,
} from "./attachments-serving";

const PUBLIC_REPO_ID = "9101";
const PUBLIC_STORAGE_KEY = "r_9101";
const PRIVATE_REPO_ID = "9102";
const PRIVATE_STORAGE_KEY = "r_9102";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "issue_attachments",
    "release_assets",
    "releases",
    "comments",
    "issues",
    "repo_collaborators",
    "repo_counters",
    "repo_settings",
    "personal_access_tokens",
    "auth_failures",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The serving key spaces of the shared bucket: every repo attachment tree.
  let cursor: string | undefined;
  do {
    const page = await env.REPO_PACKS.list({ cursor });
    for (const object of page.objects) {
      await env.REPO_PACKS.delete(object.key);
    }
    cursor = page.truncated === true ? page.cursor : undefined;
  } while (cursor !== undefined);
});

const db = () => drizzle(env.DB);

/** GET/HEAD against the bare serving router. */
const serve = async (path: string, init?: RequestInit): Promise<Response> =>
  attachmentsServingRouter.request(path, init, env);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SeedUserResult {
  id: number;
  usernameLower: string;
}

async function seedUser(username: string, isAdmin = false): Promise<SeedUserResult> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username,
      isAdmin,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, usernameLower: user.usernameLower };
}

async function seedRepo(id: string, storageKey: string, owner: SeedUserResult, visibility: "public" | "private"): Promise<void> {
  await db().insert(repositories).values({
    id,
    storageKey,
    ownerNamespace: owner.usernameLower,
    ownerId: owner.id,
    slug: `att-${id}`,
    visibility,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await new IssuesService(env.DB).ensureRepoCounters(id);
}

async function seedIssue(repoId: string, posterId: number, isPull = false): Promise<{ id: number; index: number }> {
  const service = new IssuesService(env.DB);
  const now = new Date("2026-03-01T00:00:00Z");
  const row =
    isPull === true
      ? (
          await service.createPullRequest({
            repoId,
            posterId,
            title: "seed pr",
            content: "",
            headRepoId: repoId,
            baseBranch: "main",
            headBranch: "feature",
            now,
          })
        ).issue
      : await service.createIssue({ repoId, posterId, title: "seed issue", content: "", now });
  return { id: row.id, index: row.index };
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

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A sniffable PNG-shaped payload (magic + padding). */
function pngPayload(pad = 24): Uint8Array {
  return new Uint8Array([...PNG_MAGIC, ...new Array<number>(pad).fill(0x00)]);
}

interface SeedAttachmentOptions {
  repoId: string;
  storageKey: string;
  issueId: number;
  name: string;
  content: Uint8Array;
  now?: Date;
  commentId?: number;
}

/** A stored issue attachment (the landed upload flow — realistic R2 keys). */
async function seedIssueAttachment(options: SeedAttachmentOptions) {
  return uploadIssueAttachment({
    bucket: env.REPO_PACKS,
    d1: env.DB,
    storageKey: options.storageKey,
    issueId: options.issueId,
    commentId: options.commentId ?? 0,
    uploaderId: 1,
    name: options.name,
    content: streamOf(options.content),
    multipart: false,
    declaredLength: options.content.byteLength,
    now: options.now ?? new Date("2026-03-02T03:04:05Z"),
  });
}

/** A stored release attachment half (direct rows; the release-assets family
 *  owns its own upload flow). Returns the uuid. */
async function seedReleaseAsset(options: {
  repoId: string;
  isDraft: boolean;
  name: string;
  content: Uint8Array;
}): Promise<string> {
  const uuid = crypto.randomUUID();
  const tag = `v-${uuid.slice(0, 8)}`;
  const inserted = await db()
    .insert(releases)
    .values({
      repoId: options.repoId,
      publisherId: 1,
      tagName: tag,
      lowerTagName: tag,
      isDraft: options.isDraft,
      createdAt: new Date("2026-03-02T00:00:00Z"),
    })
    .returning();
  const release = inserted[0];
  if (release === undefined) throw new Error("release seed failed");
  const key = `repos/r_${options.repoId}/release-assets/${uuid}/${options.name}`;
  await env.REPO_PACKS.put(key, options.content);
  await db().insert(releaseAssets).values({
    uuid,
    repoId: options.repoId,
    releaseId: release.id,
    uploaderId: 1,
    name: options.name,
    size: options.content.byteLength,
    r2Key: key,
    createdAt: new Date("2026-03-02T03:04:05Z"),
  });
  return uuid;
}

async function issueAttachmentRow(uuid: string) {
  const row = (await db().select().from(issueAttachments).where(eq(issueAttachments.uuid, uuid)).limit(1))[0];
  if (row === undefined) throw new Error("attachment row missing");
  return row;
}

// ---------------------------------------------------------------------------
// The Go port units (sniff table + disposition encoding)
// ---------------------------------------------------------------------------

describe("goDetectContentType (net/http/sniff.go port)", () => {
  it("matches the wire signatures", () => {
    expect(goDetectContentType(pngPayload())).toBe("image/png");
    expect(goDetectContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBe("image/jpeg");
    expect(goDetectContentType(new TextEncoder().encode("%PDF-1.7\n"))).toBe("application/pdf");
    expect(goDetectContentType(new TextEncoder().encode("PK\x03\x04payload"))).toBe("application/zip");
    expect(goDetectContentType(new TextEncoder().encode("<!DOCTYPE html><html>"))).toBe("text/html; charset=utf-8");
    // htmlSig is case-insensitive over the tag and needs a tag terminator
    expect(goDetectContentType(new TextEncoder().encode("  <h1>x"))).toBe("text/html; charset=utf-8");
    expect(goDetectContentType(new Uint8Array([0xff, 0xfe, 0x00, 0x00, 0x41]))).toBe("text/plain; charset=utf-16le");
    // the text fallback refuses control bytes
    expect(goDetectContentType(new TextEncoder().encode("plain text"))).toBe("text/plain; charset=utf-8");
    expect(goDetectContentType(new Uint8Array([0x00, 0x01, 0x02]))).toBe("application/octet-stream");
  });

  it("matches mp4 only via the ftyp box scan", () => {
    const mp4 = new Uint8Array(24);
    const view = new DataView(mp4.buffer);
    view.setUint32(0, 24); // boxSize
    mp4.set(new TextEncoder().encode("ftyp"), 4);
    mp4.set(new TextEncoder().encode("isom"), 8);
    mp4.set(new TextEncoder().encode("mp4"), 16); // compatible brand at 16
    expect(goDetectContentType(mp4)).toBe("video/mp4");
  });
});

describe("detectContentType (typesniffer.go port)", () => {
  it("extends the Go table with Gitea's arms", () => {
    expect(detectContentType(new Uint8Array(0)).contentType).toBe("text/plain");
    expect(detectContentType(new TextEncoder().encode("<svg xmlns='x'></svg>")).contentType).toBe("image/svg+xml");
    expect(detectContentType(new TextEncoder().encode("<?xml version='1.0'?><svg xmlns='x'/>")).contentType).toBe(
      "image/svg+xml",
    );
    // an "ID3"-prefixed text file re-detects as text
    const id3Text = new TextEncoder().encode("ID3 followed by words");
    expect(detectContentType(id3Text).contentType).toBe("text/plain; charset=utf-8");
  });

  it("ranks browsable binary, text-forced-plain, and octet-stream like the serve path", () => {
    expect(detectContentType(pngPayload()).isBrowsableBinaryType()).toBe(true);
    const text = detectContentType(new TextEncoder().encode("<html><body>hi"));
    expect(text.isBrowsableBinaryType()).toBe(false);
    expect(text.isText()).toBe(true);
    expect(detectContentType(new TextEncoder().encode("PK\x03\x04zip")).isBrowsableBinaryType()).toBe(false);
  });
});

describe("encodeContentDisposition (content_disposition.go + mime.FormatMediaType port)", () => {
  it("emits the token, quoted-string, and RFC 2231 forms", () => {
    expect(encodeContentDisposition("inline", "trace.log")).toBe("inline; filename=trace.log");
    expect(encodeContentDisposition("inline", "a b.txt")).toBe('inline; filename="a b.txt"');
    expect(encodeContentDisposition("inline", 'we"ird.txt')).toBe('inline; filename="we\\"ird.txt"');
    expect(encodeContentDisposition("inline", "café.txt")).toBe(
      "inline; filename=caf_.txt; filename*=utf-8''caf%C3%A9.txt",
    );
    // tab survives both halves (needsEncoding exempts it)
    expect(encodeContentDisposition("inline", "a\tb.txt")).toBe('inline; filename="a\tb.txt"');
    expect(encodeContentDisposition("attachment", "trace.log")).toBe("attachment; filename=trace.log");
  });
});

// ---------------------------------------------------------------------------
// The route: resolution matrix, headers, 404 arms, dispositions
// ---------------------------------------------------------------------------

describe("GET /attachments/{uuid} — resolution matrix", () => {
  it("serves a public-repo issue attachment to an anonymous GET with upstream serve headers", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const payload = pngPayload();
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "shot.png",
      content: payload,
    });

    const res = await serve(`/attachments/${row.uuid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline; filename=shot.png");
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-modals allow-popups allow-downloads",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    // the serve headers' zero-value cache form — NOT the etag handler's
    // private-static value (upstream sets then overwrites)
    expect(res.headers.get("cache-control")).toBe(SERVE_CACHE_CONTROL);
    expect(res.headers.get("etag")).toBe(`"${row.uuid}"`);
    // the 200-path Last-Modified is the FILE mtime (serve.go:238) — the R2
    // object's uploaded instant, not the row's created_unix
    expect(res.headers.get("last-modified")).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/);
    expect(res.headers.get("content-length")).toBe(String(payload.byteLength));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
    expect((await issueAttachmentRow(row.uuid)).downloadCount).toBe(1);
  });

  it("answers HEAD with the same headers and no body", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "shot.png",
      content: pngPayload(),
    });
    const res = await serve(`/attachments/${row.uuid}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("serves a private repo attachment to the owner (private reader) and hides it from strangers and anonymous", async () => {
    const owner = await seedUser("attach-owner");
    const stranger = await seedUser("attach-stranger");
    await seedRepo(PRIVATE_REPO_ID, PRIVATE_STORAGE_KEY, owner, "private");
    const issue = await seedIssue(PRIVATE_REPO_ID, owner.id);
    const payload = new TextEncoder().encode("private bytes");
    const row = await seedIssueAttachment({
      repoId: PRIVATE_REPO_ID,
      storageKey: PRIVATE_STORAGE_KEY,
      issueId: issue.id,
      name: "notes.txt",
      content: payload,
    });

    const ownerToken = (await mintFor(owner.id, "owner-read", "read:issue")).plaintext;
    const ownerRes = await serve(`/attachments/${row.uuid}`, {
      headers: { authorization: `token ${ownerToken}` },
    });
    expect(ownerRes.status).toBe(200);
    expect(new Uint8Array(await ownerRes.arrayBuffer())).toEqual(payload);
    expect((await issueAttachmentRow(row.uuid)).downloadCount).toBe(1);

    const strangerToken = (await mintFor(stranger.id, "stranger-read", "all")).plaintext;
    const strangerRes = await serve(`/attachments/${row.uuid}`, {
      headers: { authorization: `token ${strangerToken}` },
    });
    expect(strangerRes.status).toBe(404);
    expect(await strangerRes.text()).toBe("Not Found\n");
    // the 404 arm fires BEFORE the download bump (upstream order)
    expect((await issueAttachmentRow(row.uuid)).downloadCount).toBe(1);

    const anonRes = await serve(`/attachments/${row.uuid}`);
    expect(anonRes.status).toBe(404);
    expect((await issueAttachmentRow(row.uuid)).downloadCount).toBe(1);
  });

  it("serves a private repo attachment to a site admin and rides basic token auth", async () => {
    const owner = await seedUser("attach-owner");
    const admin = await seedUser("attach-admin", true);
    await seedRepo(PRIVATE_REPO_ID, PRIVATE_STORAGE_KEY, owner, "private");
    const issue = await seedIssue(PRIVATE_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PRIVATE_REPO_ID,
      storageKey: PRIVATE_STORAGE_KEY,
      issueId: issue.id,
      name: "notes.txt",
      content: new TextEncoder().encode("admin bytes"),
    });
    const adminToken = (await mintFor(admin.id, "admin-read", "read:issue")).plaintext;
    const res = await serve(`/attachments/${row.uuid}`, {
      headers: { authorization: `Basic ${btoa(`${adminToken}:`)}` },
    });
    expect(res.status).toBe(200);
  });

  it("404s an unknown uuid", async () => {
    const res = await serve(`/attachments/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("Not Found\n");
  });

  it("404s a pending relay row (r2_key still NULL)", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    await db().insert(issueAttachments).values({
      uuid: crypto.randomUUID(),
      issueId: issue.id,
      commentId: 0,
      uploaderId: owner.id,
      name: "pending.bin",
      r2Key: null,
      createdAt: new Date("2026-03-02T03:04:05Z"),
    });
    const pending = (await db().select().from(issueAttachments).all())[0];
    if (pending === undefined) throw new Error("pending seed failed");
    const res = await serve(`/attachments/${pending.uuid}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /attachments/{uuid} — scope checks (after the 404 arms)", () => {
  it("403s a token without read:issue on a VISIBLE issue attachment", async () => {
    const owner = await seedUser("attach-owner");
    const stranger = await seedUser("attach-stranger");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "shot.png",
      content: pngPayload(),
    });
    const repoOnlyToken = (await mintFor(stranger.id, "repo-only", "read:repository")).plaintext;
    const res = await serve(`/attachments/${row.uuid}`, {
      headers: { authorization: `token ${repoOnlyToken}` },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden\n");
    expect((await issueAttachmentRow(row.uuid)).downloadCount).toBe(0);
  });

  it("serves with read:issue, and with write:issue (write implies read)", async () => {
    const owner = await seedUser("attach-owner");
    const stranger = await seedUser("attach-stranger");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "shot.png",
      content: pngPayload(),
    });
    const readerToken = (await mintFor(stranger.id, "issue-reader", "read:issue")).plaintext;
    const readerRes = await serve(`/attachments/${row.uuid}`, {
      headers: { authorization: `token ${readerToken}` },
    });
    expect(readerRes.status).toBe(200);
    const writerToken = (await mintFor(stranger.id, "issue-writer", "write:issue")).plaintext;
    const writerRes = await serve(`/attachments/${row.uuid}`, {
      headers: { authorization: `token ${writerToken}` },
    });
    expect(writerRes.status).toBe(200);
  });

  it("degrades an invalid token to anonymous (private stays 404)", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PRIVATE_REPO_ID, PRIVATE_STORAGE_KEY, owner, "private");
    const issue = await seedIssue(PRIVATE_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PRIVATE_REPO_ID,
      storageKey: PRIVATE_STORAGE_KEY,
      issueId: issue.id,
      name: "notes.txt",
      content: new TextEncoder().encode("private"),
    });
    const res = await serve(`/attachments/${row.uuid}`, {
      headers: { authorization: "token not-a-real-token" },
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /attachments/{uuid} — PR units and comment attachments", () => {
  it("requires read:issue for a PR attachment (TypePullRequests arm)", async () => {
    const owner = await seedUser("attach-owner");
    const stranger = await seedUser("attach-stranger");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const pull = await seedIssue(PUBLIC_REPO_ID, owner.id, true);
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: pull.id,
      name: "diff.txt",
      content: new TextEncoder().encode("pr attachment"),
    });
    const noScopeToken = (await mintFor(stranger.id, "user-only", "read:user")).plaintext;
    const noScopeRes = await serve(`/attachments/${row.uuid}`, {
      headers: { authorization: `token ${noScopeToken}` },
    });
    expect(noScopeRes.status).toBe(403);
    const readerToken = (await mintFor(stranger.id, "pr-reader", "read:issue")).plaintext;
    const readerRes = await serve(`/attachments/${row.uuid}`, {
      headers: { authorization: `token ${readerToken}` },
    });
    expect(readerRes.status).toBe(200);
  });

  it("serves a comment attachment through the parent issue's unit", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      commentId: 17,
      name: "from-comment.log",
      content: new TextEncoder().encode("comment attachment bytes"),
    });
    const res = await serve(`/attachments/${row.uuid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});

describe("GET /attachments/{uuid} — the release half", () => {
  it("requires read:repository and serves published assets to readers", async () => {
    const owner = await seedUser("attach-owner");
    const stranger = await seedUser("attach-stranger");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const payload = new TextEncoder().encode("release asset bytes");
    const uuid = await seedReleaseAsset({ repoId: PUBLIC_REPO_ID, isDraft: false, name: "app.bin", content: payload });

    const issueScopeToken = (await mintFor(stranger.id, "issue-scope", "read:issue")).plaintext;
    const issueScopeRes = await serve(`/attachments/${uuid}`, {
      headers: { authorization: `token ${issueScopeToken}` },
    });
    expect(issueScopeRes.status).toBe(403);

    const repoReaderToken = (await mintFor(stranger.id, "repo-reader", "read:repository")).plaintext;
    const res = await serve(`/attachments/${uuid}`, {
      headers: { authorization: `token ${repoReaderToken}` },
    });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
    const assets = await db().select().from(releaseAssets).all();
    expect(assets[0]?.downloadCount).toBe(1);
  });

  it("404s draft-release assets without a write grant, serves them to the owner", async () => {
    const owner = await seedUser("attach-owner");
    const stranger = await seedUser("attach-stranger");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const uuid = await seedReleaseAsset({
      repoId: PUBLIC_REPO_ID,
      isDraft: true,
      name: "draft.bin",
      content: new TextEncoder().encode("draft bytes"),
    });

    const readerToken = (await mintFor(stranger.id, "draft-reader", "all")).plaintext;
    const readerRes = await serve(`/attachments/${uuid}`, {
      headers: { authorization: `token ${readerToken}` },
    });
    expect(readerRes.status).toBe(404);

    const ownerToken = (await mintFor(owner.id, "draft-owner", "read:repository")).plaintext;
    const ownerRes = await serve(`/attachments/${uuid}`, {
      headers: { authorization: `token ${ownerToken}` },
    });
    expect(ownerRes.status).toBe(200);
  });
});

describe("GET /attachments/{uuid} — cache arms", () => {
  it("answers If-None-Match with a bare 304 (ETag + Last-Modified, no Cache-Control)", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "shot.png",
      content: pngPayload(),
    });
    const res = await serve(`/attachments/${row.uuid}`, { headers: { "if-none-match": `"${row.uuid}"` } });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(`"${row.uuid}"`);
    expect(res.headers.get("last-modified")).toBe("Mon, 02 Mar 2026 03:04:05 GMT");
    // handleGenericETagTimeCache sets Cache-Control only on the miss path
    expect(res.headers.get("cache-control")).toBeNull();
    // the bump precedes the cache check, upstream order
    expect((await issueAttachmentRow(row.uuid)).downloadCount).toBe(1);
  });

  it("answers a matching If-Modified-Since at second precision and ignores IMS under If-None-Match", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "shot.png",
      content: pngPayload(),
    });
    const created = "Mon, 02 Mar 2026 03:04:05 GMT";
    const hit = await serve(`/attachments/${row.uuid}`, { headers: { "if-modified-since": created } });
    expect(hit.status).toBe(304);
    const oneSecondBefore = "Mon, 02 Mar 2026 03:04:04 GMT";
    const miss = await serve(`/attachments/${row.uuid}`, { headers: { "if-modified-since": oneSecondBefore } });
    expect(miss.status).toBe(200);
    // INM present → IMS MUST be ignored (httpcache.go:102-104); this INM does
    // not match, so the miss path serves 200 with the final cache form
    const ignored = await serve(`/attachments/${row.uuid}`, {
      headers: { "if-none-match": '"other"', "if-modified-since": created },
    });
    expect(ignored.status).toBe(200);
    expect(ignored.headers.get("cache-control")).toBe(SERVE_CACHE_CONTROL);
    expect(ignored.headers.get("etag")).toBe(`"${row.uuid}"`);
    // the intermediate private-static value never reaches the wire
    expect(PRIVATE_STATIC_CACHE_CONTROL).toBe("private, max-age=21600");
  });
});

describe("GET /attachments/{uuid} — sniffed content types and dispositions", () => {
  it("forces text attachments to text/plain with the utf-8 charset", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "notes.md",
      content: new TextEncoder().encode("# heading\n\n<body>words</body>\n"),
    });
    const res = await serve(`/attachments/${row.uuid}`);
    expect(res.status).toBe(200);
    // the sniffed text/html type is forced to text/plain (serve.go:120-123)
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("serves unrecognizable binary as octet-stream — inline disposition, sandbox CSP (NOT a download)", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "blob.bin",
      content: new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff]),
    });
    const res = await serve(`/attachments/${row.uuid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("inline; filename=blob.bin");
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-modals allow-popups allow-downloads",
    );
  });

  it("swaps the CSP for the PDF variant", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "doc.pdf",
      content: new TextEncoder().encode("%PDF-1.4 fake"),
    });
    const res = await serve(`/attachments/${row.uuid}`);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
  });

  it("encodes the display name (RFC 2231 twin for non-ASCII names)", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "rapport café.txt",
      content: new TextEncoder().encode("bonjour"),
    });
    const res = await serve(`/attachments/${row.uuid}`);
    expect(res.headers.get("content-disposition")).toBe(
      // the space forces the quoted safe-name form; the é encodes as its
      // UTF-8 byte pair in the RFC 2231 twin
      'inline; filename="rapport caf_.txt"; filename*=utf-8\'\'rapport%20caf%C3%A9.txt',
    );
  });

  it("streams bodies larger than the sniff window intact", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    // PNG magic (sniffed) + a body well past 1024 bytes with a countable tail
    const payload = new Uint8Array(4096);
    payload.set(PNG_MAGIC, 0);
    for (let i = 1024; i < payload.length; i += 1) {
      payload[i] = i % 251;
    }
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "big.png",
      content: payload,
    });
    const res = await serve(`/attachments/${row.uuid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(payload.byteLength);
    expect(Array.from(body)).toEqual(Array.from(payload));
  });
});

describe("GET /attachments/{uuid} — dangling-link 500 arm", () => {
  it("500s when the attachment's linked issue row is gone (GetAttachmentLinkedTypeAndRepoID ServerError)", async () => {
    const owner = await seedUser("attach-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const row = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "orphan.bin",
      content: pngPayload(),
    });
    await db().delete(issues).where(eq(issues.id, issue.id));
    const res = await serve(`/attachments/${row.uuid}`);
    expect(res.status).toBe(500);
  });
});
