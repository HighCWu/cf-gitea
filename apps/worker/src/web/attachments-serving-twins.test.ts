/**
 * The repo-scoped attachment twins (src/web/attachments-serving.ts, the
 * additive route arms) on real D1 + R2 — upstream web.go:1513
 * `/{username}/{reponame}/releases/attachments/{uuid}` (the releases group's
 * `optSignIn, RepoAssignment, MustBeNotEmpty, reqRepoReleaseReader` chain) and
 * web.go:1529-1532 `/{username}/{reponame}/attachments/{uuid}` (bare
 * `optSignIn, RepoAssignment` — "to maintain compatibility with old
 * attachments"), both through `repo.GetAttachment` → ServeAttachment riding
 * the LANDED shared serve pipeline (the site route's decision table: sniffed
 * content type, INLINE disposition, sandbox CSP, the ETag private-cache 304
 * arms, the download bump).
 *
 * Pinned here: the twins' route-gate differences vs the site route — the LIVE
 * repo-mismatch arm (a foreign uuid 404s through a repo-scoped URL), the
 * release twin's MustBeNotEmpty + the releases-unit gate (hasReleases false →
 * 404 for every viewer, writer included), the compat twin's EMPTY-repo serve
 * (no MustBeNotEmpty) and its releases-disabled divergence (recorded: the
 * shared handler arms do not carry upstream's per-unit consult), the
 * permission matrix (anon/public, collaborator read/write, stranger, draft
 * writers-only, token scopes AFTER the 404 arms), the chi verb shape (405 +
 * `Allow: GET` — a plain m.Get registration has no optionsCorsHandler, unlike
 * the site route's bare-405 OPTIONS), and the 304 cache arms on the new
 * routes (ETag + Last-Modified ONLY — no Cache-Control; the empty-valued
 * If-None-Match still consults If-Modified-Since; Go time.Parse-exact IMS
 * validation).
 */

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { issueAttachments, releaseAssets, releases, repoCollaborators, repositories, repoSettings, users } from "../db/schema";
import { IssuesService } from "../issues/service";
import { mintFor } from "../auth/testing/seeds";
import { mintSession, SESSION_COOKIE_NAME } from "../ui/session";
import { uploadIssueAttachment } from "../api/routes/issue-attachments";
import { attachmentsServingRouter, SERVE_CACHE_CONTROL } from "./attachments-serving";

const PUBLIC_REPO_ID = "9301";
const PUBLIC_STORAGE_KEY = "r_9301";
const PRIVATE_REPO_ID = "9302";
const PRIVATE_STORAGE_KEY = "r_9302";
const OTHER_REPO_ID = "9303";
const OTHER_STORAGE_KEY = "r_9303";

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
    "repo_units",
    "personal_access_tokens",
    "auth_failures",
    "sessions",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
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

/** GET/HEAD/OPTIONS against the serving router (both twins live here). */
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

async function seedRepo(
  id: string,
  storageKey: string,
  owner: SeedUserResult,
  visibility: "public" | "private",
  slug: string,
  options?: { isEmpty?: boolean },
): Promise<void> {
  await db().insert(repositories).values({
    id,
    storageKey,
    ownerNamespace: owner.usernameLower,
    ownerId: owner.id,
    slug,
    visibility,
    // isEmpty defaults TRUE at the column — the twins pin the non-empty shape
    // explicitly, so seed the flag unless the test wants the empty repo.
    isEmpty: options?.isEmpty ?? false,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await new IssuesService(env.DB).ensureRepoCounters(id);
}

/** The releases-unit OFF arm (upstream's disabled TypeReleases unit — the
 *  reqRepoReleaseReader consult; only settable via repoEdit's has_releases
 *  on this surface, so the test writes the settings row directly). */
async function seedReleasesDisabled(repoId: string): Promise<void> {
  await db().insert(repoSettings).values({ repoId, hasReleases: false });
}

async function seedCollaborator(repoId: string, userId: number, mode: "read" | "write"): Promise<void> {
  await db().insert(repoCollaborators).values({ repoId, userId, mode });
}

async function seedIssue(repoId: string, posterId: number): Promise<{ id: number }> {
  const service = new IssuesService(env.DB);
  const row = await service.createIssue({
    repoId,
    posterId,
    title: "seed issue",
    content: "",
    now: new Date("2026-03-01T00:00:00Z"),
  });
  return { id: row.id };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngPayload(pad = 24): Uint8Array {
  return new Uint8Array([...PNG_MAGIC, ...new Array<number>(pad).fill(0x00)]);
}

async function seedIssueAttachment(options: {
  repoId: string;
  storageKey: string;
  issueId: number;
  name: string;
  content: Uint8Array;
  uploaderId?: number;
}): Promise<string> {
  const row = await uploadIssueAttachment({
    bucket: env.REPO_PACKS,
    d1: env.DB,
    storageKey: options.storageKey,
    issueId: options.issueId,
    commentId: 0,
    uploaderId: options.uploaderId ?? 1,
    name: options.name,
    content: streamOf(options.content),
    multipart: false,
    declaredLength: options.content.byteLength,
    now: new Date("2026-03-02T03:04:05Z"),
  });
  return row.uuid;
}

/** The CREATED_AT every release-half fixture carries (the 304 arms' Last-
 *  Modified source — the row's createdAt, attachment.go:228-230). */
const RELEASE_CREATED_AT = new Date("2026-03-02T03:04:05Z");

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
    createdAt: RELEASE_CREATED_AT,
  });
  return uuid;
}

/** The unlinked release-half shape (release_id 0 — the staged-but-unattached
 *  upload). Direct row + R2 put; the repoId column is the mismatch arm's
 *  only source on this half. */
async function seedUnlinkedReleaseAsset(options: {
  repoId: string;
  uploaderId: number | null;
  name: string;
  content: Uint8Array;
}): Promise<string> {
  const uuid = crypto.randomUUID();
  const key = `repos/r_${options.repoId}/release-assets/${uuid}/${options.name}`;
  await env.REPO_PACKS.put(key, options.content);
  await db().insert(releaseAssets).values({
    uuid,
    repoId: options.repoId,
    releaseId: 0,
    uploaderId: options.uploaderId,
    name: options.name,
    size: options.content.byteLength,
    r2Key: key,
    createdAt: RELEASE_CREATED_AT,
  });
  return uuid;
}

async function releaseAssetRow(uuid: string) {
  const row = (await db().select().from(releaseAssets).where(eq(releaseAssets.uuid, uuid)).limit(1))[0];
  if (row === undefined) throw new Error("release asset row missing");
  return row;
}

async function issueAttachmentRow(uuid: string) {
  const row = (await db().select().from(issueAttachments).where(eq(issueAttachments.uuid, uuid)).limit(1))[0];
  if (row === undefined) throw new Error("attachment row missing");
  return row;
}

// ---------------------------------------------------------------------------
// The RELEASE twin — web.go:1513, the releases group's gates
// ---------------------------------------------------------------------------

describe("GET /{owner}/{repo}/releases/attachments/{uuid} — the release twin", () => {
  it("serves a release asset to an anonymous viewer on a public repo through the shared pipeline", async () => {
    const owner = await seedUser("twins-release-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    const payload = pngPayload();
    const uuid = await seedReleaseAsset({ repoId: PUBLIC_REPO_ID, isDraft: false, name: "bundle.png", content: payload });

    const res = await serve(`/${owner.usernameLower}/pub/releases/attachments/${uuid}`);
    expect(res.status).toBe(200);
    // The LANDED decision table (the port's whole point — not the ui wave-41
    // module's reduced sniffer): sniffed image/png, INLINE, sandbox CSP.
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline; filename=bundle.png");
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-modals allow-popups allow-downloads",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    expect(res.headers.get("cache-control")).toBe(SERVE_CACHE_CONTROL);
    expect(res.headers.get("etag")).toBe(`"${uuid}"`);
    expect(res.headers.get("content-length")).toBe(String(payload.byteLength));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
    expect((await releaseAssetRow(uuid)).downloadCount).toBe(1);
  });

  it("forces sniffed text to text/plain; charset=utf-8 (user HTML never renders as a page)", async () => {
    const owner = await seedUser("twins-release-text");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    const payload = new TextEncoder().encode("<html><body>looks like a page</body></html>");
    const uuid = await seedReleaseAsset({ repoId: PUBLIC_REPO_ID, isDraft: false, name: "notes.html", content: payload });

    const res = await serve(`/${owner.usernameLower}/pub/releases/attachments/${uuid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe("inline; filename=notes.html");
  });

  it("walks the visibility matrix: anon 404 / stranger 404 / collaborator-read 200 on a private repo", async () => {
    const owner = await seedUser("twins-release-priv");
    const stranger = await seedUser("twins-release-stranger");
    const reader = await seedUser("twins-release-reader");
    await seedRepo(PRIVATE_REPO_ID, PRIVATE_STORAGE_KEY, owner, "private", "priv");
    await seedCollaborator(PRIVATE_REPO_ID, reader.id, "read");
    const uuid = await seedReleaseAsset({ repoId: PRIVATE_REPO_ID, isDraft: false, name: "asset.bin", content: pngPayload() });
    const path = `/${owner.usernameLower}/priv/releases/attachments/${uuid}`;

    const anon = await serve(path);
    expect(anon.status).toBe(404); // RepoAssignment's visibility gate — anti-enumeration
    expect(await anon.text()).toBe("Not Found\n");

    const strangerToken = (await mintFor(stranger.id, "twins-stranger", "all")).plaintext;
    expect((await serve(path, { headers: { authorization: `token ${strangerToken}` } })).status).toBe(404);

    const readerToken = (await mintFor(reader.id, "twins-reader", "read:repository")).plaintext;
    const readerRes = await serve(path, { headers: { authorization: `token ${readerToken}` } });
    expect(readerRes.status).toBe(200);
    expect(new Uint8Array(await readerRes.arrayBuffer())).toEqual(pngPayload());
  });

  it("404s a DRAFT release's asset for readers and anonymous; serves release-writers and the owner", async () => {
    const owner = await seedUser("twins-release-draft");
    const writer = await seedUser("twins-release-writer");
    const reader = await seedUser("twins-release-draft-reader");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    await seedCollaborator(PUBLIC_REPO_ID, writer.id, "write");
    await seedCollaborator(PUBLIC_REPO_ID, reader.id, "read");
    const uuid = await seedReleaseAsset({ repoId: PUBLIC_REPO_ID, isDraft: true, name: "draft.bin", content: pngPayload() });
    const path = `/${owner.usernameLower}/pub/releases/attachments/${uuid}`;

    expect((await serve(path)).status).toBe(404); // anonymous

    const readerToken = (await mintFor(reader.id, "twins-draft-reader", "read:repository")).plaintext;
    expect((await serve(path, { headers: { authorization: `token ${readerToken}` } })).status).toBe(404);

    const writerToken = (await mintFor(writer.id, "twins-draft-writer", "read:repository")).plaintext;
    expect((await serve(path, { headers: { authorization: `token ${writerToken}` } })).status).toBe(200);

    const ownerToken = (await mintFor(owner.id, "twins-draft-owner", "read:repository")).plaintext;
    expect((await serve(path, { headers: { authorization: `token ${ownerToken}` } })).status).toBe(200);
  });

  it("404s every viewer on a releases-disabled repo — the unit grants nobody (reqRepoReleaseReader)", async () => {
    const owner = await seedUser("twins-release-unit");
    const reader = await seedUser("twins-release-unit-reader");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    await seedCollaborator(PUBLIC_REPO_ID, reader.id, "read");
    await seedReleasesDisabled(PUBLIC_REPO_ID);
    const uuid = await seedReleaseAsset({ repoId: PUBLIC_REPO_ID, isDraft: false, name: "asset.bin", content: pngPayload() });
    const path = `/${owner.usernameLower}/pub/releases/attachments/${uuid}`;

    // Upstream perm.CanRead(TypeReleases) reads the repo's ENABLED units — a
    // disabled unit grants nobody, writer included (permission.go:64-75; the
    // landed releasesReadGate posture). Owner included: anon-equivalent gate.
    expect((await serve(path)).status).toBe(404);
    const ownerToken = (await mintFor(owner.id, "twins-unit-owner", "all")).plaintext;
    expect((await serve(path, { headers: { authorization: `token ${ownerToken}` } })).status).toBe(404);
    const readerToken = (await mintFor(reader.id, "twins-unit-reader", "all")).plaintext;
    expect((await serve(path, { headers: { authorization: `token ${readerToken}` } })).status).toBe(404);
    // the route gates run BEFORE the handler — no download bump on the gate 404
    expect((await releaseAssetRow(uuid)).downloadCount).toBe(0);
  });

  it("404s an EMPTY repo for the owner (MustBeNotEmpty) before any uuid lookup — the compat twin contrast", async () => {
    const owner = await seedUser("twins-release-empty");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub", { isEmpty: true });
    // The release half needs a releases row — an empty repo with a release
    // asset is odd but upstream's gates run on the REPO row, not the data.
    const uuid = await seedReleaseAsset({ repoId: PUBLIC_REPO_ID, isDraft: false, name: "asset.bin", content: pngPayload() });

    expect((await serve(`/${owner.usernameLower}/pub/releases/attachments/${uuid}`)).status).toBe(404);
    // THE CONTRAST: web.go:1529's compat group carries NO MustBeNotEmpty —
    // the same uuid through the compat twin serves (the handler's own checks
    // govern there).
    const compat = await serve(`/${owner.usernameLower}/pub/attachments/${uuid}`);
    expect(compat.status).toBe(200);
    expect(new Uint8Array(await compat.arrayBuffer())).toEqual(pngPayload());
  });

  it("404s a foreign repo's uuid through the twins (the LIVE repo-mismatch arm)", async () => {
    const owner = await seedUser("twins-release-mm");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    await seedRepo(OTHER_REPO_ID, OTHER_STORAGE_KEY, owner, "public", "other");
    const uuid = await seedReleaseAsset({ repoId: OTHER_REPO_ID, isDraft: false, name: "other.bin", content: pngPayload() });

    // attachment.go:154-157 — ctx.Repo.Repository != nil && repoID mismatch →
    // 404. The SITE route serves the same uuid (no RepoAssignment — GP's
    // suite pins that side); the repo-scoped twins hide it.
    expect((await serve(`/${owner.usernameLower}/pub/releases/attachments/${uuid}`)).status).toBe(404);
    expect((await serve(`/${owner.usernameLower}/pub/attachments/${uuid}`)).status).toBe(404);
    expect((await serve(`/${owner.usernameLower}/other/attachments/${uuid}`)).status).toBe(200);
  });

  it("404s a missing repo and a missing uuid through the release twin", async () => {
    const owner = await seedUser("twins-release-miss");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    const uuid = await seedReleaseAsset({ repoId: PUBLIC_REPO_ID, isDraft: false, name: "a.bin", content: pngPayload() });

    expect((await serve(`/${owner.usernameLower}/nosuch/releases/attachments/${uuid}`)).status).toBe(404);
    expect((await serve(`/nobody/pub/releases/attachments/${uuid}`)).status).toBe(404);
    expect((await serve(`/${owner.usernameLower}/pub/releases/attachments/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it("serves an ISSUE-linked uuid too — the route gate pre-gates the releases unit, not the handler's linked unit", async () => {
    const owner = await seedUser("twins-release-issue");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const payload = new TextEncoder().encode("issue log line");
    const uuid = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "log.txt",
      content: payload,
    });

    const res = await serve(`/${owner.usernameLower}/pub/releases/attachments/${uuid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
    // the bump lands on the ISSUE half (the linked walk's own row)
    expect((await issueAttachmentRow(uuid)).downloadCount).toBe(1);
  });

  it("checks token scope AFTER the 404 arms: releases need read:repository — 403, then 200 with it", async () => {
    const owner = await seedUser("twins-release-scope");
    const stranger = await seedUser("twins-release-scope-stranger");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    const uuid = await seedReleaseAsset({ repoId: PUBLIC_REPO_ID, isDraft: false, name: "a.bin", content: pngPayload() });
    const path = `/${owner.usernameLower}/pub/releases/attachments/${uuid}`;

    // The 404 arms pass on the public repo (readable stranger), so the scope
    // check answers the 403 — attachmentReadScope(releases) = read:repository
    // (attachment.go:25-34), CheckTokenScopes after the 404s (:205-210).
    const issueScopeToken = (await mintFor(stranger.id, "twins-scope-issue", "read:issue")).plaintext;
    const denied = await serve(path, { headers: { authorization: `token ${issueScopeToken}` } });
    expect(denied.status).toBe(403);
    expect(await denied.text()).toBe("Forbidden\n");

    const repoScopeToken = (await mintFor(stranger.id, "twins-scope-repo", "read:repository")).plaintext;
    const ok = await serve(path, { headers: { authorization: `token ${repoScopeToken}` } });
    expect(ok.status).toBe(200);
  });

  it("answers HEAD with the serve headers and no body; OPTIONS/POST-class with chi's 405 + Allow: GET", async () => {
    const owner = await seedUser("twins-release-verbs");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    const payload = pngPayload();
    const uuid = await seedReleaseAsset({ repoId: PUBLIC_REPO_ID, isDraft: false, name: "a.png", content: payload });
    const path = `/${owner.usernameLower}/pub/releases/attachments/${uuid}`;

    const head = await serve(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(head.headers.get("content-length")).toBe(String(payload.byteLength));
    expect(head.headers.get("etag")).toBe(`"${uuid}"`);
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    // A plain m.Get registration (NO optionsCorsHandler — unlike web.go:912):
    // chi's methodNotAllowedHandler writes Allow from the node's registered
    // methods — "GET" alone, OPTIONS included in the mismatches.
    for (const method of ["OPTIONS", "POST", "PUT", "DELETE", "PATCH"] as const) {
      const res = await serve(path, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET");
      expect((await res.arrayBuffer()).byteLength, method).toBe(0);
    }
    // no mismatch re-ran the download
    expect((await releaseAssetRow(uuid)).downloadCount).toBe(1); // HEAD's GET ride only
  });

  it("answers the 304 arms: ETag + Last-Modified ONLY (no Cache-Control), weak/`*` INM, the empty-INM IMS consult, Go-exact IMS parsing", async () => {
    const owner = await seedUser("twins-release-cache");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    const uuid = await seedReleaseAsset({ repoId: PUBLIC_REPO_ID, isDraft: false, name: "a.bin", content: pngPayload() });
    const path = `/${owner.usernameLower}/pub/releases/attachments/${uuid}`;
    // The 304's Last-Modified is the ROW's createdAt (the pre-serve handler's
    // value — the 200 path overwrites it with the file mtime).
    const created = RELEASE_CREATED_AT.toUTCString();

    const exact = await serve(path, { headers: { "if-none-match": `"${uuid}"` } });
    expect(exact.status).toBe(304);
    expect(exact.headers.get("etag")).toBe(`"${uuid}"`);
    expect(exact.headers.get("last-modified")).toBe(created);
    // httpcache.go:115's SetCacheControlInHeader runs only on the miss path —
    // the 304 carries ONLY the pair (the ui wave-41 module's 304 Cache-Control
    // was the predecessor defect this replace fixes).
    expect(exact.headers.get("cache-control")).toBeNull();

    expect(
      (await serve(path, { headers: { "if-none-match": `W/"${uuid}"` } })).status,
    ).toBe(304); // weak-stripped list compare
    expect((await serve(path, { headers: { "if-none-match": "*" } })).status).toBe(304);

    // An EMPTY-VALUED If-None-Match still consults If-Modified-Since (upstream
    // Header.Get == "" — the GP-fixed defect class, pinned on the new route).
    const emptyInm = await serve(path, { headers: { "if-none-match": "", "if-modified-since": created } });
    expect(emptyInm.status).toBe(304);

    // Go time.Parse-exact: "31 Feb" fails the day-in-month range (no JS
    // rollover) → the miss path serves 200.
    const bogusDate = await serve(path, { headers: { "if-modified-since": "Sat, 31 Feb 2024 00:00:00 GMT" } });
    expect(bogusDate.status).toBe(200);

    // A date strictly BEFORE the created instant misses → 200 (created
    // 03:04:05Z is NEWER than the since date — not unmodified).
    const stale = await serve(path, { headers: { "if-modified-since": "Mon, 02 Mar 2026 00:00:00 GMT" } });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("cache-control")).toBe(SERVE_CACHE_CONTROL);
  });

  it("serves the unlinked release-half asset to its uploader only, and mismatch-404s it under a foreign repo URL", async () => {
    const uploader = await seedUser("twins-release-unlinked-up");
    const owner = await seedUser("twins-release-unlinked-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    await seedRepo(OTHER_REPO_ID, OTHER_STORAGE_KEY, owner, "public", "other");
    const payload = pngPayload();
    const uuid = await seedUnlinkedReleaseAsset({ repoId: PUBLIC_REPO_ID, uploaderId: uploader.id, name: "stage.bin", content: payload });
    const cookie = await mintSession(env.DB, uploader.id);

    // TypeInvalid arm under a RESOLVED URL repo: uploader-only (same verdict
    // as the site route; ctx.IsSigned exists under optSignIn here too).
    const own = await serve(`/${owner.usernameLower}/pub/releases/attachments/${uuid}`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(own.status).toBe(200);
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(payload);

    // release_assets carries repoId — the mismatch arm 404s the foreign URL
    // even for the uploader (upstream's attach.RepoID fallback).
    expect(
      (
        await serve(`/${owner.usernameLower}/other/attachments/${uuid}`, {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
        })
      ).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The COMPAT twin — web.go:1529-1532, bare RepoAssignment
// ---------------------------------------------------------------------------

describe("GET /{owner}/{repo}/attachments/{uuid} — the compat twin", () => {
  it("serves an issue attachment to anonymous on a public repo with the shared-pipeline headers", async () => {
    const owner = await seedUser("twins-compat-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const payload = pngPayload();
    const uuid = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "shot.png",
      content: payload,
    });

    const res = await serve(`/${owner.usernameLower}/pub/attachments/${uuid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline; filename=shot.png");
    expect(res.headers.get("cache-control")).toBe(SERVE_CACHE_CONTROL);
    expect(res.headers.get("etag")).toBe(`"${uuid}"`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);
    expect((await issueAttachmentRow(uuid)).downloadCount).toBe(1);
  });

  it("walks the visibility matrix with the SESSION credential: anon 404 / session reader 200 / stranger 404", async () => {
    const owner = await seedUser("twins-compat-priv");
    const stranger = await seedUser("twins-compat-stranger");
    const reader = await seedUser("twins-compat-reader");
    await seedRepo(PRIVATE_REPO_ID, PRIVATE_STORAGE_KEY, owner, "private", "priv");
    await seedCollaborator(PRIVATE_REPO_ID, reader.id, "read");
    const issue = await seedIssue(PRIVATE_REPO_ID, owner.id);
    const uuid = await seedIssueAttachment({
      repoId: PRIVATE_REPO_ID,
      storageKey: PRIVATE_STORAGE_KEY,
      issueId: issue.id,
      name: "notes.txt",
      content: new TextEncoder().encode("private notes"),
    });
    const path = `/${owner.usernameLower}/priv/attachments/${uuid}`;

    expect((await serve(path)).status).toBe(404);

    const readerCookie = await mintSession(env.DB, reader.id);
    const ok = await serve(path, { headers: { cookie: `${SESSION_COOKIE_NAME}=${readerCookie}` } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("private notes");

    const strangerToken = (await mintFor(stranger.id, "twins-compat-stranger-t", "all")).plaintext;
    expect((await serve(path, { headers: { authorization: `token ${strangerToken}` } })).status).toBe(404);
  });

  it("404s a draft release asset for readers, serves release-writers (the handler's draft arm)", async () => {
    const owner = await seedUser("twins-compat-draft");
    const writer = await seedUser("twins-compat-draft-writer");
    const reader = await seedUser("twins-compat-draft-reader");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    await seedCollaborator(PUBLIC_REPO_ID, writer.id, "write");
    await seedCollaborator(PUBLIC_REPO_ID, reader.id, "read");
    const uuid = await seedReleaseAsset({ repoId: PUBLIC_REPO_ID, isDraft: true, name: "draft.bin", content: pngPayload() });
    const path = `/${owner.usernameLower}/pub/attachments/${uuid}`;

    expect((await serve(path)).status).toBe(404);
    const readerToken = (await mintFor(reader.id, "twins-cd-reader", "all")).plaintext;
    expect((await serve(path, { headers: { authorization: `token ${readerToken}` } })).status).toBe(404);
    const writerToken = (await mintFor(writer.id, "twins-cd-writer", "all")).plaintext;
    expect((await serve(path, { headers: { authorization: `token ${writerToken}` } })).status).toBe(200);
  });

  it("SERVES on an EMPTY repo (no MustBeNotEmpty in the compat group — web.go:1529's whole shape)", async () => {
    const owner = await seedUser("twins-compat-empty");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub", { isEmpty: true });
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const payload = new TextEncoder().encode("bytes on an empty repo");
    const uuid = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "a.txt",
      content: payload,
    });

    const res = await serve(`/${owner.usernameLower}/pub/attachments/${uuid}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("bytes on an empty repo");
  });

  it("SERVES a release asset on a releases-disabled repo — the RECORDED divergence (the shared handler arms do not carry upstream's per-unit consult; the release twin's route gate does)", async () => {
    const owner = await seedUser("twins-compat-unit");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    await seedReleasesDisabled(PUBLIC_REPO_ID);
    const uuid = await seedReleaseAsset({ repoId: PUBLIC_REPO_ID, isDraft: false, name: "asset.bin", content: pngPayload() });

    // Upstream's ServeAttachment CanRead(TypeReleases) consults the repo's
    // units → 404 upstream. The landed shared pipeline (the site route's
    // arms, GP's port) does not carry the per-unit consult, and this twin
    // rides it — family-consistent with the site route, disclosed in the
    // module section header. The RELEASE twin 404s the same uuid (its route
    // gate IS the unit consult — pinned above).
    const res = await serve(`/${owner.usernameLower}/pub/attachments/${uuid}`);
    expect(res.status).toBe(200);
  });

  it("404s a missing repo and a missing uuid (RepoAssignment runs before the uuid lookup)", async () => {
    const owner = await seedUser("twins-compat-miss");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const uuid = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "a.txt",
      content: pngPayload(),
    });

    expect((await serve(`/${owner.usernameLower}/nosuch/attachments/${uuid}`)).status).toBe(404);
    expect((await serve(`/nobody/pub/attachments/${uuid}`)).status).toBe(404);
    expect((await serve(`/${owner.usernameLower}/pub/attachments/${crypto.randomUUID()}`)).status).toBe(404);
  });

  it("404s an unlinked ISSUE-half asset for anonymous; serves the uploader (the mismatch check is structurally absent on this half — recorded divergence)", async () => {
    const uploader = await seedUser("twins-compat-unlinked-up");
    const owner = await seedUser("twins-compat-unlinked-owner");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    const payload = pngPayload();
    const uuid = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: 0,
      name: "preview.png",
      content: payload,
      uploaderId: uploader.id,
    });
    const cookie = await mintSession(env.DB, uploader.id);

    expect((await serve(`/${owner.usernameLower}/pub/attachments/${uuid}`)).status).toBe(404);
    // issue_attachments has NO repoId column (upstream's attach.RepoID
    // fallback has no local source) — the uploader can still dereference via
    // a foreign repo URL; everyone else 404s at the TypeInvalid arm.
    const own = await serve(`/${owner.usernameLower}/pub/attachments/${uuid}`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(own.status).toBe(200);
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(payload);
  });

  it("answers HEAD with headers only and the mismatch verbs with chi's 405 + Allow: GET", async () => {
    const owner = await seedUser("twins-compat-verbs");
    await seedRepo(PUBLIC_REPO_ID, PUBLIC_STORAGE_KEY, owner, "public", "pub");
    const issue = await seedIssue(PUBLIC_REPO_ID, owner.id);
    const payload = pngPayload();
    const uuid = await seedIssueAttachment({
      repoId: PUBLIC_REPO_ID,
      storageKey: PUBLIC_STORAGE_KEY,
      issueId: issue.id,
      name: "a.png",
      content: payload,
    });
    const path = `/${owner.usernameLower}/pub/attachments/${uuid}`;

    const head = await serve(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("image/png");
    expect(head.headers.get("content-length")).toBe(String(payload.byteLength));
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    for (const method of ["OPTIONS", "POST", "PUT", "DELETE", "PATCH"] as const) {
      const res = await serve(path, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET");
    }
  });
});
