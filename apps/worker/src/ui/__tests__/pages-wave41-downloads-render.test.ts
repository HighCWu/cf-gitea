/**
 * Pages wave 41 route tests — three survey arms in one wave:
 *
 *   1. the releases download tail (`/{owner}/{repo}/releases/attachments/
 *      {uuid}` + `/{owner}/{repo}/releases/download/{vTag}/{fileName}`,
 *      pages/release-downloads.ts — the survey's top-5 #1, upstream
 *      web.go:1513-1514: repo.GetAttachment → ServeAttachment +
 *      repo.RedirectDownload);
 *   2. the rendered blob views (`/{owner}/{repo}/render/{branch|tag|commit}/
 *      *` + `/render/blob/{sha}`, pages/render-files.ts — the survey's
 *      row 3, upstream web.go:1715-1719 repo.RenderFile);
 *   3. the ctx.Redirect fetch-action arm on BOTH redirect twins
 *      (pages/repo-home.tsx — upstream server_request.go:246-248 +
 *      base.go:153-156: a non-empty `X-Gitea-Fetch-Action` header answers
 *      200 `{"redirect": …}` instead of the 303).
 *
 * Upstream contracts under test (the module docs carry the cites):
 * downloads — the ServeAttachment gates (uuid lookup, the URL-repo match,
 * the DRAFT gate riding release-write access), IncreaseDownloadCount, the
 * httpcache pair (`"{uuid}"` ETag, If-None-Match / If-Modified-Since → 304
 * with `private, max-age=21600`), the sniffed 200 matrix (text forced to
 * `text/plain` — user HTML never renders as a page — browsable binaries keep
 * their mime, the sandbox CSP with the audio/video deletion, nosniff, the
 * inline disposition encoding, the zero-option prod Cache-Control overwrite),
 * RedirectDownload's EXACT tag find (case-sensitive, tag-only rows excluded,
 * drafts for writers only) and the `latest` alias (GetLatestReleaseByRepoID);
 * render — the standalone HTML fragment (`text/html; charset=utf-8`, the
 * MarkupRenderDefaultSandbox CSP), the markdown-family renderability set
 * (setting/markup.go:83's default), the "Unable to find renderer" 400 class
 * for every other file, the degenerate `/render/blob/{sha}` arm (resolvable
 * → 400, unknown → 404), the mode-"file" relative-link rewriting;
 * fetch-action — the JSON arm on /tree and /blob, the 303 without the
 * header, post-resolution ordering (an unknown repo 404s before any
 * redirect, header or not).
 *
 * Same harness posture as pages-wave39: the router driven directly with the
 * synthetic ASSETS manifest; engine content seeds through the REAL receive
 * flow with fixed timestamps (deterministic oids); release/asset rows ride
 * the LANDED services (IssuesService.createRelease + uploadReleaseAsset —
 * the octet-stream relay into the real REPO_PACKS binding). Fixture repos
 * `alice/wave41dl` (main at c1; tag v41 at c0) and `alice/wave41empty`
 * (never pushed — the MustBeNotEmpty arms).
 */

import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { IssuesService } from "../../issues/service";
import { uploadReleaseAsset } from "../../api/services/release-assets";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { releaseAssets, releases, repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { blobRedirectResponse, isFetchActionRequest, treeRedirectResponse } from "../pages/repo-home";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (path: string, cookie: string): RequestInit => ({
  headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

const withHeader = (path: string, header: string): RequestInit => ({
  headers: { "x-gitea-fetch-action": header },
});

// --- fixtures -----------------------------------------------------------------

const WAVE41_README = "# wave41 title\n\nSee the [notes](docs/notes.md) for more.\n";
const WAVE41_NOTES = "# wave41 notes\n\nNested markdown body.\n";

/** c0 roots (README + notes + source), c1 edits the README (= main); tag
 *  v41 pins c0 (the RedirectDownload tag arm + the render tag arm). */
const WAVE41_COMMITS: SeedCommit[] = [
  {
    message: "wave41: root commit",
    time: T0,
    files: [
      { path: "README.md", content: WAVE41_README },
      { path: "docs/notes.md", content: WAVE41_NOTES },
      { path: "app.ts", content: 'console.log("wave41");\n' },
    ],
  },
  {
    message: "wave41: edit readme",
    time: T0 + 60,
    files: [
      { path: "README.md", content: `${WAVE41_README}\nEdited at c1.\n` },
      { path: "docs/notes.md", content: WAVE41_NOTES },
      { path: "app.ts", content: 'console.log("wave41");\n' },
    ],
  },
];

const WAVE41_MAIN = 1;

interface Wave41Fixture {
  aliceCookie: string;
  /** The published v41 release's row id. */
  v41Id: number;
  /** The draft release's row id. */
  draftId: number;
  txtUuid: string;
  htmlUuid: string;
  pngUuid: string;
  draftUuid: string;
  /** main's full tip oid (the render commit arm). */
  tip: string;
  repoId: string;
}

async function pushRefs(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array, token: string): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`wave41 seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** The asset upload through the LANDED relay (the octet-stream arm — one
 *  hash-and-forward pass into the real R2 binding). */
async function seedAsset(repoId: string, storageKey: string, releaseId: number, uploaderId: number, name: string, bytes: Uint8Array, now: Date): Promise<string> {
  const row = await uploadReleaseAsset({
    bucket: env.REPO_PACKS,
    d1: env.DB,
    repoId,
    storageKey,
    releaseId,
    uploaderId,
    name,
    content: new Blob([bytes]).stream() as ReadableStream<Uint8Array>,
    multipart: false,
    declaredLength: bytes.byteLength,
    now,
  });
  return row.uuid;
}

async function ensureWave41Repos(): Promise<Wave41Fixture> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const alice =
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) ??
    (await seedVerifiedUser({ username: "alice" }));
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, "ui-page-seed-wave41")
    .run();
  const token = (await mintFor(alice.id, "ui-page-seed-wave41", "write:repository")).plaintext;

  const repoName = "alice/wave41dl";
  const refs = await env.REPO.getByName(repoName).listRefs();
  let tips: string[];
  if (refs.head === null) {
    const seeded = await buildHistoryPack(WAVE41_COMMITS);
    tips = seeded.tips;
    await pushRefs(
      repoName,
      [
        { ref: "refs/heads/main", oid: tips[WAVE41_MAIN] as string },
        { ref: "refs/tags/v41", oid: tips[0] as string },
      ],
      seeded.pack,
      token,
    );
  } else {
    tips = (await buildHistoryPack(WAVE41_COMMITS)).tips;
  }

  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave41dl")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wave41dl",
      isPrivate: false,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, row.id, repoName);
    row = (await db.select().from(repositories).where(eq(repositories.id, row.id)).get()) ?? row;
  }
  if (row.visibility !== "public") {
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  }
  if (row.defaultBranch !== "main") {
    await db.update(repositories).set({ defaultBranch: "main" }).where(eq(repositories.id, row.id));
  }

  // The never-pushed repo (the MustBeNotEmpty arms).
  const emptyName = "alice/wave41empty";
  let emptyRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave41empty")))
    .get();
  if (emptyRow === undefined) {
    emptyRow = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wave41empty",
      isPrivate: false,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, emptyRow.id, emptyName);
  }
  if (emptyRow.visibility !== "public") {
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, emptyRow.id));
  }

  // The release fixtures through the LANDED create arm + the asset relay.
  const svc = new IssuesService(env.DB);
  const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);
  const existing = await db.select({ id: releases.id }).from(releases).where(eq(releases.repoId, row.id)).limit(1).all();
  let v41Id: number;
  let draftId: number;
  let txtUuid: string;
  let htmlUuid: string;
  let pngUuid: string;
  let draftUuid: string;
  if (existing.length === 0) {
    const v41 = await svc.createRelease({
      repoId: row.id,
      publisherId: alice.id,
      tagName: "v41",
      target: "main",
      title: "Wave41 release",
      note: "First wave41 release.",
      isDraft: false,
      isPrerelease: false,
      now: t(90),
    });
    const draft = await svc.createRelease({
      repoId: row.id,
      publisherId: alice.id,
      tagName: "draft-rc",
      target: "main",
      title: "Wave41 draft",
      note: "Draft release.",
      isDraft: true,
      isPrerelease: false,
      now: t(120),
    });
    v41Id = v41.id;
    draftId = draft.id;
    txtUuid = await seedAsset(row.id, row.storageKey, v41.id, alice.id, "notes.txt", new TextEncoder().encode("plain asset body\n"), t(95));
    htmlUuid = await seedAsset(row.id, row.storageKey, v41.id, alice.id, "report.html", new TextEncoder().encode("<!DOCTYPE html><html><body><script>boom()</script></body></html>"), t(96));
    pngUuid = await seedAsset(
      row.id,
      row.storageKey,
      v41.id,
      alice.id,
      "pic.png",
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
      t(97),
    );
    draftUuid = await seedAsset(row.id, row.storageKey, draft.id, alice.id, "draft-secret.txt", new TextEncoder().encode("draft only\n"), t(125));
  } else {
    const rows = await db.select().from(releases).where(eq(releases.repoId, row.id)).all();
    const v41 = rows.find((release) => release.tagName === "v41");
    const draft = rows.find((release) => release.tagName === "draft-rc");
    if (v41 === undefined || draft === undefined) throw new Error("wave41 release rows missing");
    v41Id = v41.id;
    draftId = draft.id;
    const assets = await db.select().from(releaseAssets).where(eq(releaseAssets.repoId, row.id)).all();
    const byName = (name: string): string => {
      const found = assets.find((asset) => asset.name === name);
      if (found === undefined) throw new Error(`wave41 asset row missing: ${name}`);
      return found.uuid;
    };
    txtUuid = byName("notes.txt");
    htmlUuid = byName("report.html");
    pngUuid = byName("pic.png");
    draftUuid = byName("draft-secret.txt");
  }

  const cookie = await mintSession(env.DB, alice.id);
  return { aliceCookie: cookie, v41Id, draftId, txtUuid, htmlUuid, pngUuid, draftUuid, tip: tips[WAVE41_MAIN] as string, repoId: row.id };
}

let wave41Fixture: Wave41Fixture | null = null;

async function fixture(): Promise<Wave41Fixture> {
  if (wave41Fixture === null) wave41Fixture = await ensureWave41Repos();
  return wave41Fixture;
}

beforeAll(async () => {
  await fixture();
});

// --- the parser (the single owner of the route shape) ---------------------------

describe("wave-41 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the attachment serve at the exact chi shape (one segment)", () => {
    expect(parseUiRoute("/octo/hello/releases/attachments/abc-123")).toEqual({
      family: "release-attachment",
      owner: "octo",
      repo: "hello",
      uuid: "abc-123",
    });
    expect(parseUiRoute("/octo/hello/releases/attachments/a%2Fb")).toEqual({
      family: "release-attachment",
      owner: "octo",
      repo: "hello",
      uuid: "a/b",
    });
    // Deeper tails are upstream's pattern miss → engine-owned.
    expect(parseUiRoute("/octo/hello/releases/attachments/abc/def")).toBeNull();
    expect(handlesUiRoute("/octo/hello/releases/attachments/abc-123")).toBe(true);
  });

  it("claims the download redirect at the exact chi shape (two segments)", () => {
    expect(parseUiRoute("/octo/hello/releases/download/v1.0/pkg.zip")).toEqual({
      family: "release-download",
      owner: "octo",
      repo: "hello",
      vTag: "v1.0",
      fileName: "pkg.zip",
    });
    // A literal slash in either param is 3 segments after `download` — no
    // upstream route (chi's single-segment params).
    expect(parseUiRoute("/octo/hello/releases/download/v1.0/dir/pkg.zip")).toBeNull();
    expect(parseUiRoute("/octo/hello/releases/download/v1.0")).toBeNull();
  });

  it("claims the render typed wildcards and the blob arm, nothing else in the space", () => {
    expect(parseUiRoute("/octo/hello/render/branch/feature/one/docs/a.md")).toEqual({
      family: "render-file",
      owner: "octo",
      repo: "hello",
      refType: "branch",
      refSuffix: "feature/one/docs/a.md",
    });
    expect(parseUiRoute("/octo/hello/render/tag/v1.0/rc/README.md")).toMatchObject({ refType: "tag", refSuffix: "v1.0/rc/README.md" });
    expect(parseUiRoute("/octo/hello/render/commit/abc1234/x.md")).toMatchObject({ refType: "commit", refSuffix: "abc1234/x.md" });
    expect(parseUiRoute("/octo/hello/render/blob/abc1234")).toMatchObject({ family: "render-file", sha: "abc1234" });
    // The bare URL, a missing tail and unknown literals stay unclaimed.
    expect(parseUiRoute("/octo/hello/render")).toBeNull();
    expect(parseUiRoute("/octo/hello/render/branch")).toBeNull();
    expect(parseUiRoute("/octo/hello/render/blob")).toBeNull();
    expect(parseUiRoute("/octo/hello/render/other/x.md")).toBeNull();
    expect(parseUiRoute("/octo/hello/render/blob/a/b")).toBeNull();
  });
});

// --- item 3: the ctx.Redirect fetch-action arm (BOTH twins) ----------------------

describe("fetch-action redirects (repo-home.tsx — base.go:153-156)", () => {
  it("answers the 303 without the header (the established wave-2 arm)", async () => {
    const res = await fetchUi("/alice/wave41dl/tree/branch/main");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave41dl/src/branch/main");
  });

  it("answers 200 {redirect} JSON for a fetch-action /tree request", async () => {
    const res = await fetchUi("/alice/wave41dl/tree/branch/main", withHeader("/alice/wave41dl/tree/branch/main", "1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await res.json()).toEqual({ redirect: "/alice/wave41dl/src/branch/main" });
  });

  it("answers the same arm on the /blob twin", async () => {
    const res = await fetchUi("/alice/wave41dl/blob/abc123", withHeader("/alice/wave41dl/blob/abc123", "fetch"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirect: "/alice/wave41dl/src/commit/abc123" });
  });

  it("never leaks an unknown repo through either arm (post-resolution ordering)", async () => {
    const tree = await fetchUi("/nobody/nothing/tree/branch/main", withHeader("/nobody/nothing/tree/branch/main", "1"));
    expect(tree.status).toBe(404);
    const blob = await fetchUi("/nobody/nothing/blob/abc", withHeader("/nobody/nothing/blob/abc", "1"));
    expect(blob.status).toBe(404);
  });

  it("carries the pure builders' arms at unit level", async () => {
    expect(isFetchActionRequest(new Request("https://x/", { headers: { "x-gitea-fetch-action": "1" } }))).toBe(true);
    expect(isFetchActionRequest(new Request("https://x/"))).toBe(false);
    const json = treeRedirectResponse("/o/r", "branch/main", "?x=1", true);
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const plain = treeRedirectResponse("/o/r", "branch/main", "", false);
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toBe("/o/r/src/branch/main");
    const blobJson = blobRedirectResponse("/o/r", "abc", "", true);
    expect(blobJson.status).toBe(200);
    expect(await blobJson.json()).toEqual({ redirect: "/o/r/src/commit/abc" });
  });
});

// --- item 1: the releases download tail ------------------------------------------

describe("release attachment serve (web.go:1513 → ServeAttachment)", () => {
  it("streams the asset with the sniffed text/plain matrix + nosniff + sandbox + inline disposition", async () => {
    const { txtUuid } = await fixture();
    const res = await fetchUi(`/alice/wave41dl/releases/attachments/${txtUuid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals allow-popups allow-downloads");
    expect(res.headers.get("content-disposition")).toBe("inline; filename=notes.txt");
    expect(res.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    expect(res.headers.get("etag")).toBe(`"${txtUuid}"`);
    expect(res.headers.get("content-length")).toBe("17");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(res.headers.get("last-modified")).toMatch(/GMT$/);
    expect(await res.text()).toBe("plain asset body\n");
  });

  it("forces user HTML to text/plain (the never-render-as-a-page rule)", async () => {
    const { htmlUuid } = await fixture();
    const res = await fetchUi(`/alice/wave41dl/releases/attachments/${htmlUuid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals allow-popups allow-downloads");
  });

  it("keeps browsable binaries inline with their mime (the png sniff)", async () => {
    const { pngUuid } = await fixture();
    const res = await fetchUi(`/alice/wave41dl/releases/attachments/${pngUuid}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline; filename=pic.png");
  });

  it("moves IncreaseDownloadCount per serve", async () => {
    const { txtUuid } = await fixture();
    const db = drizzle(env.DB);
    const before = (await db.select().from(releaseAssets).where(eq(releaseAssets.uuid, txtUuid)).get())?.downloadCount ?? 0;
    await fetchUi(`/alice/wave41dl/releases/attachments/${txtUuid}`);
    const after = (await db.select().from(releaseAssets).where(eq(releaseAssets.uuid, txtUuid)).get())?.downloadCount ?? 0;
    expect(after).toBe(before + 1);
  });

  it("answers the httpcache pair: If-None-Match → 304 with the 6h private cache; If-Modified-Since too", async () => {
    const { txtUuid } = await fixture();
    const inm = await fetchUi(`/alice/wave41dl/releases/attachments/${txtUuid}`, {
      headers: { "if-none-match": `"${txtUuid}"` },
    });
    expect(inm.status).toBe(304);
    expect(inm.headers.get("cache-control")).toBe("private, max-age=21600");
    expect(inm.headers.get("etag")).toBe(`"${txtUuid}"`);
    // The comma-list + W/ tolerance (checkIfNoneMatchIsValid).
    const list = await fetchUi(`/alice/wave41dl/releases/attachments/${txtUuid}`, {
      headers: { "if-none-match": `W/"other", "${txtUuid}"` },
    });
    expect(list.status).toBe(304);
    // If-Modified-Since (ignored when INM is present — httpcache.go:104-113);
    // the timestamp round-trips through the 200's own Last-Modified header.
    const fresh = await fetchUi(`/alice/wave41dl/releases/attachments/${txtUuid}`);
    const lastModified = fresh.headers.get("last-modified") ?? "";
    const ims = await fetchUi(`/alice/wave41dl/releases/attachments/${txtUuid}`, {
      headers: { "if-modified-since": lastModified },
    });
    expect(ims.status).toBe(304);
    const stale = await fetchUi(`/alice/wave41dl/releases/attachments/${txtUuid}`, {
      headers: { "if-modified-since": "Mon, 01 Jan 1990 00:00:00 GMT" },
    });
    expect(stale.status).toBe(200);
  });

  it("404-shells the unknown uuid, the foreign-repo uuid and the draft's uuid for anonymous", async () => {
    const { draftUuid } = await fixture();
    const unknown = await fetchUi("/alice/wave41dl/releases/attachments/nope-0000");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('<div class="status-page-error">');
    const foreign = await fetchUi(`/alice/wave41empty/releases/attachments/${draftUuid}`);
    expect(foreign.status).toBe(404);
    const draft = await fetchUi(`/alice/wave41dl/releases/attachments/${draftUuid}`);
    expect(draft.status).toBe(404); // the draft gate (attachment.go:295-311)
  });

  it("serves the draft's asset to a release-writer (the write-grant arm)", async () => {
    const { draftUuid, aliceCookie } = await fixture();
    const res = await fetchUi(`/alice/wave41dl/releases/attachments/${draftUuid}`, withCookie(`/alice/wave41dl/releases/attachments/${draftUuid}`, aliceCookie));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("draft only\n");
  });
});

describe("release download redirect (web.go:1514 → RedirectDownload)", () => {
  it("serves the release's asset by exact tag + name", async () => {
    const { txtUuid } = await fixture();
    const res = await fetchUi("/alice/wave41dl/releases/download/v41/notes.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("plain asset body\n");
    expect(res.headers.get("etag")).toBe(`"${txtUuid}"`);
  });

  it("matches the tag EXACTLY (case-sensitive — FindReleases' tag_name In)", async () => {
    const res = await fetchUi("/alice/wave41dl/releases/download/V41/notes.txt");
    expect(res.status).toBe(404);
  });

  it("404s the missing file name", async () => {
    const res = await fetchUi("/alice/wave41dl/releases/download/v41/missing.txt");
    expect(res.status).toBe(404);
  });

  it("serves through the `latest` alias (GetLatestReleaseByRepoID)", async () => {
    const res = await fetchUi("/alice/wave41dl/releases/download/latest/notes.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("plain asset body\n");
    const miss = await fetchUi("/alice/wave41dl/releases/download/latest/missing.txt");
    expect(miss.status).toBe(404);
  });

  it("404-shells the empty repo (the group's MustBeNotEmpty)", async () => {
    const res = await fetchUi("/alice/wave41empty/releases/download/v41/notes.txt");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div class="status-page-error">');
  });

  it("404s when the releases unit is disabled (reqRepoReleaseReader)", async () => {
    const { repoId } = await fixture();
    await saveRepoSettings(env.DB, repoId, { hasReleases: false }, new Date());
    try {
      const res = await fetchUi("/alice/wave41dl/releases/download/v41/notes.txt");
      expect(res.status).toBe(404);
      const attach = await fetchUi("/alice/wave41dl/releases/attachments/x");
      expect(attach.status).toBe(404);
    } finally {
      await saveRepoSettings(env.DB, repoId, { hasReleases: true }, new Date());
    }
  });
});

// --- item 2: the rendered blob views ---------------------------------------------

describe("render family (web.go:1715-1719 → RenderFile)", () => {
  it("renders a markdown file as the standalone fragment with the sandbox CSP", async () => {
    const res = await fetchUi("/alice/wave41dl/render/branch/main/README.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads",
    );
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    const html = await res.text();
    expect(html).toContain("<h1");
    expect(html).toContain(`id="user-content-wave41-title"`);
    // The mode-"file" rewriting: the relative link against the render context.
    expect(html).toContain(`href="https://test.local/alice/wave41dl/src/branch/main/docs/notes.md"`);
  });

  it("renders nested paths and the tag + commit ref arms", async () => {
    const nested = await fetchUi("/alice/wave41dl/render/branch/main/docs/notes.md");
    expect(nested.status).toBe(200);
    expect(await nested.text()).toContain("Nested markdown body.");

    const tag = await fetchUi("/alice/wave41dl/render/tag/v41/README.md");
    expect(tag.status).toBe(200);

    const { tip } = await fixture();
    const commit = await fetchUi(`/alice/wave41dl/render/commit/${tip}/README.md`);
    expect(commit.status).toBe(200);
    // The short-sha arm 404s here — the engine boundary resolves full oids
    // only (the tree-list module's documented full-oid divergence; upstream's
    // RepoRefByType accepts the 7-hex shape and GetCommit resolves it).
    const short = await fetchUi(`/alice/wave41dl/render/commit/${tip.slice(0, 7)}/README.md`);
    expect(short.status).toBe(404);
  });

  it("answers the no-renderer 400 class for non-markdown files (plain text, nosniff)", async () => {
    const res = await fetchUi("/alice/wave41dl/render/branch/main/app.ts");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("Unable to find renderer\n");
  });

  it("answers the degenerate blob arm: resolvable sha → 400, unknown → 404", async () => {
    const { tip } = await fixture();
    const known = await fetchUi(`/alice/wave41dl/render/blob/${tip}`);
    expect(known.status).toBe(400);
    expect(await known.text()).toBe("Unable to find renderer\n");
    const unknown = await fetchUi(`/alice/wave41dl/render/blob/${"f".repeat(40)}`);
    expect(unknown.status).toBe(404);
  });

  it("404-shells the unresolvable ref, the missing path and the empty repo", async () => {
    const missingRef = await fetchUi("/alice/wave41dl/render/branch/nope/README.md");
    expect(missingRef.status).toBe(404);
    const missingPath = await fetchUi("/alice/wave41dl/render/branch/main/docs/missing.md");
    expect(missingPath.status).toBe(404);
    const empty = await fetchUi("/alice/wave41empty/render/branch/main/README.md");
    expect(empty.status).toBe(404);
    expect(await empty.text()).toContain('<div class="status-page-error">');
  });

  it("leaves the unclaimed render shapes unclaimed (engine-owned)", () => {
    expect(handlesUiRoute("/alice/wave41dl/render")).toBe(false);
    expect(handlesUiRoute("/alice/wave41dl/render/other/x.md")).toBe(false);
  });
});
