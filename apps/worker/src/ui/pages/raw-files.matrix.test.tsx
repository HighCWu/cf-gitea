/**
 * The RAW + MEDIA byte families' route matrix (pages/raw-files.ts over
 * index.ts's rawMediaFile handler — the survey's two PARTIAL rows this wave
 * closes): the MINTED-SESSION route arms driven through `uiRouter.fetch()`
 * on the real production path (parse → resolveUiRequest → the MustBeNotEmpty
 * gate → the loader → the byte builders — the org-repos matrix's pattern),
 * one seeded repo world per suite. The wiki-raw smoke suite owns the shared
 * sniffer/ETag arms; THIS file pins the families' own grammar:
 *
 *   - the parser claims: the three typed wildcards + the 2-segment blob arm
 *     + the deprecated catch-all (≥1 segment) on BOTH heads, the bare
 *     `/raw`/`/media` literal staying unclaimed (chi's `/*` does not match
 *     the empty tail), the undecodable segment folding to null;
 *   - the RAW typed arm's bytes + headers through the mount: text forced
 *     plain, the PNG mime, the x-no-compression hint, the inline
 *     disposition with the real path base, the public 6 h cache (public
 *     repo + public owner), the quoted-oid ETag and the If-None-Match 304
 *     (headers-only — the wiki-raw exact-order port);
 *   - the lastModified walk: the tree path's latest-commit time stamps
 *     Last-Modified and answers the If-Modified-Since pair (older → 200,
 *     the stamp time → 304); a path untouched by the later commit proves
 *     the walk is path-filtered;
 *   - the deprecated guess arm's three resolutions (branch walk → 7..64-hex
 *     first segment → the default-branch fallback) through the mount;
 *   - the blob arm's boundary-gap reduction (the existence probe → 404 on
 *     any sha, the module header's documented divergence);
 *   - the MEDIA arm: a plain blob falls through (the raw bytes), a pointer
 *     WITHOUT a meta row falls through (upstream's nil-meta arm — the
 *     pointer text serves), and a pointer WITH a verified row + stored
 *     object serves the LFS bytes under the pointer-oid ETag and the
 *     zero-duration private cache stamp, 304ing on the pointer ETag;
 *   - the RAW arm's LFS posture (module header's audit note): upstream
 *     `/raw` is SingleDownload — NO LFS resolution — so the pointer file
 *     serves its POINTER TEXT with the git-blob-oid ETag (the parity guard
 *     against re-introducing the divergence findings-git-e2e F4 asked for);
 *   - the file view's LFS badge (file_info.tmpl:14 through pages/
 *     file-view.tsx's view.go:72-123 pointer probe): the badge renders on a
 *     seeded pointer file — with or without a meta row — beside the size in
 *     the same file-info-entry, and on nothing else (plain text, plain
 *     binary, malformed pointer);
 *   - the file view's raw/media link flip (view_file.go:210-212's
 *     RawFileLink overwrite): a pointer file's view actions link /media
 *     (parse-only — meta row or not), a regular file and the malformed
 *     pointer keep /raw.
 *
 * The fixture world is the `alice` owner's `rawserve` repo (public,
 * two commits: README.md then the PNG + the later README edit — the
 * lastModified path filter needs a commit that touches ONE path), seeded
 * through the landed receive flow (testing/seed-repo.ts). The LFS row rides
 * the landed state service; the bytes ride the real R2 binding
 * (env.REPO_PACKS, the lfs router test's RelayLfsStore posture).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories, users } from "../../db/schema";
import { LfsStateService } from "../../services/lfs/state";
import { RelayLfsStore, lfsKey } from "../../services/lfs/store";
import { generatePointer } from "../../services/lfs/pointer";
import { lfsRepoId } from "../../lfs/router";
import { ensureSeededRepo } from "../testing/seed-repo";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import type { UiManifest } from "../manifest";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

/** The LFS media fixtures: the pointer text is the GIT blob; the PNG bytes
 *  are the LFS object content (the sniffer answers image/png for them).
 *  `ghost.bin` carries a second pointer whose object is NEVER stored — the
 *  row-without-bytes race arm. */
const LFS_OID = "ab".repeat(32);
const POINTER_TEXT = new TextDecoder().decode(generatePointer(LFS_OID, PNG_BYTES.byteLength));
const GHOST_OID = "cd".repeat(32);
const GHOST_POINTER_TEXT = `version https://git-lfs.github.com/spec/v1\noid sha256:${GHOST_OID}\nsize 4\n`;
/** A MALFORMED pointer (valid version line, garbage oid): the parser's
 *  InvalidPointerError arm — upstream's IsValid() == false plain file. */
const BROKEN_POINTER_TEXT = "version https://git-lfs.github.com/spec/v1\noid sha256:nothex\nsize 4\n";

const COMMITS = [
  { message: "seed: readme", time: 1_700_000_000, files: [{ path: "README.md", content: "# rawserve v1\n" }] },
  {
    message: "seed: assets",
    time: 1_700_000_500,
    files: [
      { path: "README.md", content: "# rawserve v1\n" }, // cumulative trees — the builder's shape
      {
        path: "assets/logo.png",
        content: PNG_BYTES,
      },
      { path: "assets/big.bin", content: new TextEncoder().encode(POINTER_TEXT) },
      { path: "assets/ghost.bin", content: new TextEncoder().encode(GHOST_POINTER_TEXT) },
      { path: "assets/broken.bin", content: new TextEncoder().encode(BROKEN_POINTER_TEXT) },
      // README untouched by this commit — the lastModified walk must not
      // stamp the README with THIS commit's time.
      { path: "NOTES.txt", content: new TextEncoder().encode("notes\n") },
    ],
  },
  {
    message: "edit readme",
    time: 1_700_001_000,
    files: [
      { path: "README.md", content: "# rawserve v2\n" },
      { path: "assets/logo.png", content: PNG_BYTES },
      { path: "assets/big.bin", content: new TextEncoder().encode(POINTER_TEXT) },
      { path: "assets/ghost.bin", content: new TextEncoder().encode(GHOST_POINTER_TEXT) },
      { path: "assets/broken.bin", content: new TextEncoder().encode(BROKEN_POINTER_TEXT) },
      { path: "NOTES.txt", content: new TextEncoder().encode("notes\n") },
    ],
  },
];

let fixture: { repoId: string; storageKey: string; headOid: string } | null = null;

async function ensureFixtures(): Promise<{ repoId: string; storageKey: string; headOid: string }> {
  if (fixture !== null) return fixture;
  await applyAuthD1Migrations();
  const seeded = await ensureSeededRepo({ owner: "alice", slug: "rawserve", commits: COMMITS });
  const repoRow =
    (await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "rawserve")))
      .get()) ?? null;
  if (repoRow === null) throw new Error("rawserve repo row missing");
  const owner = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "alice")).get()) ?? null;
  if (owner === null) throw new Error("alice row missing");
  if (owner.visibility !== "public") throw new Error("alice must be public for the cache-stamp arms");
  fixture = { repoId: repoRow.id, storageKey: repoRow.storageKey, headOid: seeded.tips[seeded.tips.length - 1] as string };
  return fixture;
}

// --- the mounted-route harness (the org-repos matrix pattern) -----------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- 1. the parser claims ------------------------------------------------------

describe("the parser claims (upstream's five chi shapes per group)", () => {
  it("claims the typed arms, the blob arm, and the deprecated catch-all on both heads", () => {
    expect(parseUiRoute("/alice/rawserve/raw/branch/main/README.md")).toEqual({
      family: "raw-file",
      owner: "alice",
      repo: "rawserve",
      refType: "branch",
      refSuffix: "main/README.md",
    });
    expect(parseUiRoute("/alice/rawserve/raw/tag/v1/dir/file.bin")?.family).toBe("raw-file");
    expect(parseUiRoute("/alice/rawserve/raw/commit/0123456789abcdef0123456789abcdef01234567/file.txt")?.family).toBe(
      "raw-file",
    );
    expect(parseUiRoute("/alice/rawserve/raw/blob/0123456789abcdef0123456789abcdef01234567")).toEqual({
      family: "raw-file",
      owner: "alice",
      repo: "rawserve",
      sha: "0123456789abcdef0123456789abcdef01234567",
    });
    // The deprecated catch-all: ≥1 segment, the raw tail verbatim.
    expect(parseUiRoute("/alice/rawserve/raw/main/README.md")).toEqual({
      family: "raw-file",
      owner: "alice",
      repo: "rawserve",
      legacySuffix: "main/README.md",
    });
    // The media twins mirror the families.
    expect(parseUiRoute("/alice/rawserve/media/branch/main/README.md")?.family).toBe("media-file");
    expect(parseUiRoute("/alice/rawserve/media/blob/deadbeef")?.family).toBe("media-file");
    const legacy = parseUiRoute("/alice/rawserve/media/deep/path/file.bin");
    expect(legacy).toEqual({ family: "media-file", owner: "alice", repo: "rawserve", legacySuffix: "deep/path/file.bin" });
    expect(handlesUiRoute("/alice/rawserve/raw/main/README.md")).toBe(true);
  });

  it("leaves the bare literals and undecodable segments unclaimed (chi's empty-tail rule)", () => {
    expect(parseUiRoute("/alice/rawserve/raw")).toBeNull();
    expect(parseUiRoute("/alice/rawserve/media")).toBeNull();
    expect(parseUiRoute("/alice/rawserve/raw/%zz")).toBeNull();
    expect(parseUiRoute("/alice/rawserve/media/branch/%zz")).toBeNull();
    expect(handlesUiRoute("/alice/rawserve/raw")).toBe(false);
  });
});

// --- 2. the RAW typed arm through the mount ------------------------------------

describe("the raw typed arm (SingleDownload's port)", () => {
  it("serves text forced plain with the public static cache and the quoted-oid etag", async () => {
    const response = await fetchUi("/alice/rawserve/raw/branch/main/README.md");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-modals allow-popups allow-downloads",
    );
    expect(response.headers.get("content-disposition")).toBe("inline; filename=README.md");
    expect(response.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    expect(response.headers.get("cache-control")).toBe("public, max-age=21600");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("# rawserve v2\n");
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);

    // The 304 answers with the ETag ONLY (no Cache-Control — the wiki-raw
    // exact-order port).
    const notModified = await fetchUi("/alice/rawserve/raw/branch/main/README.md", {
      headers: { "if-none-match": etag as string },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);
    // The builder emits NO Cache-Control on the 304 (the wiki-raw
    // exact-order port); the shared uiRouter middleware stamps its
    // zero-option form on every header-less answer — the tree-wide posture.
    expect(notModified.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
  });

  it("keeps the browsable mime and stamps the no-compression hint for the PNG", async () => {
    const response = await fetchUi("/alice/rawserve/raw/branch/main/assets/logo.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-no-compression")).toBe("1");
    expect(response.headers.get("content-disposition")).toBe("inline; filename=logo.png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("serves the POINTER text for an LFS pointer file (SingleDownload has no LFS arm)", async () => {
    // The module header's audit note: upstream `/raw` is SingleDownload →
    // common.ServeBlob, no pointer probe — the pointer TEXT is the raw
    // content (the parity guard; /media is the resolver, tested below).
    const response = await fetchUi("/alice/rawserve/raw/branch/main/assets/big.bin");
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(POINTER_TEXT);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    // The ETag is the GIT blob oid (40 hex) — NOT the pointer oid.
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(etag).not.toBe(`"${LFS_OID}"`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=21600");
  });

  it("stamps Last-Modified from the path's latest commit and answers If-Modified-Since", async () => {
    const first = await fetchUi("/alice/rawserve/raw/branch/main/README.md");
    expect(first.status).toBe(200);
    // The README's latest touch is the THIRD commit (t=1_700_001_000).
    expect(first.headers.get("last-modified")).toBe(new Date(1_700_001_000 * 1000).toUTCString());
    const stamp = first.headers.get("last-modified") as string;

    // A newer If-Modified-Since → 304 (headers only); an OLDER one → 200.
    const fresh = await fetchUi("/alice/rawserve/raw/branch/main/README.md", {
      headers: { "if-modified-since": new Date(2_000_000_000 * 1000).toUTCString() },
    });
    expect(fresh.status).toBe(304);
    expect(fresh.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate"); // the middleware's stamp
    const stale = await fetchUi("/alice/rawserve/raw/branch/main/README.md", {
      headers: { "if-modified-since": new Date(1_600_000_000 * 1000).toUTCString() },
    });
    expect(stale.status).toBe(200);

    // The PNG's latest touch is the SECOND commit (t=1_700_000_500) — the
    // walk is path-filtered, not the tip.
    const png = await fetchUi("/alice/rawserve/raw/branch/main/assets/logo.png");
    expect(png.headers.get("last-modified")).toBe(new Date(1_700_000_500 * 1000).toUTCString());
    expect(stamp).not.toBe(png.headers.get("last-modified"));
  });
});

// --- 3. the deprecated guess arm (getRefNameLegacy) -----------------------------

describe("the deprecated catch-all arm (RepoRefByType(''))", () => {
  it("resolves branch walk, hex first segment, and the default-branch fallback", async () => {
    // Branch walk: "main" claims the first segment, treePath the rest.
    const viaBranch = await fetchUi("/alice/rawserve/raw/main/README.md");
    expect(viaBranch.status).toBe(200);
    expect(new TextDecoder().decode(await viaBranch.arrayBuffer())).toBe("# rawserve v2\n");

    // Hex first segment: the tip oid claims it, the rest is the tree path.
    const { headOid } = await ensureFixtures();
    const viaSha = await fetchUi(`/alice/rawserve/raw/${headOid}/assets/logo.png`);
    expect(viaSha.status).toBe(200);
    expect(viaSha.headers.get("content-type")).toBe("image/png");

    // The default-branch fallback: a non-branch non-hex first segment is
    // tree path under the default branch (the FIXME'd old-code behavior).
    const viaFallback = await fetchUi("/alice/rawserve/raw/assets/logo.png");
    expect(viaFallback.status).toBe(200);
    expect(viaFallback.headers.get("content-type")).toBe("image/png");
  });
});

// --- 4. the blob arm (the boundary-gap reduction) --------------------------------

describe("the blob arm's documented 404 (no object-by-oid read at the boundary)", () => {
  it("answers the 404 shell for unknown and resolvable shas alike", async () => {
    const unknown = await fetchUi("/alice/rawserve/raw/blob/0123456789abcdef0123456789abcdef01234567");
    expect(unknown.status).toBe(404);
    const { headOid } = await ensureFixtures();
    const resolvable = await fetchUi(`/alice/rawserve/raw/blob/${headOid}`);
    expect(resolvable.status).toBe(404);
  });
});

// --- 5. the MEDIA arm (ServeBlobOrLFS) --------------------------------------------

describe("the media arm (SingleDownloadOrLFS's port)", () => {
  it("falls through to the plain blob for non-pointer and pointer-without-meta content", async () => {
    // A plain blob: the raw bytes (no LFS probe hit).
    const plain = await fetchUi("/alice/rawserve/media/branch/main/README.md");
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(new TextDecoder().decode(await plain.arrayBuffer())).toBe("# rawserve v2\n");

    // A VALID pointer whose meta row is missing: upstream's nil-meta arm —
    // the pointer TEXT serves (GetLFSMetaObjectByOid's miss → ServeBlob).
    const pointerish = await fetchUi("/alice/rawserve/media/branch/main/assets/big.bin");
    expect(pointerish.status).toBe(200);
    expect(new TextDecoder().decode(await pointerish.arrayBuffer())).toBe(POINTER_TEXT);
  });

  it("serves the LFS object under the pointer-oid etag with the zero-duration private stamp", async () => {
    const current = await ensureFixtures();
    // The meta row + the stored object (the router test's RelayLfsStore
    // posture; the row is the idempotent verified upsert).
    await new LfsStateService(env.DB).insertVerified(lfsRepoId(current.repoId), LFS_OID, PNG_BYTES.byteLength, new Date(1_700_002_000_000));
    const store = new RelayLfsStore(env.REPO_PACKS);
    await store.put(lfsKey(current.storageKey, LFS_OID), PNG_BYTES);

    const response = await fetchUi("/alice/rawserve/media/branch/main/assets/big.bin");
    expect(response.status).toBe(200);
    // The pointer bytes resolved to the LFS content (image/png — browsable).
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
    // The second gate's stamps: the POINTER oid etag, the meta's updatedAt,
    // the empty-options zero-duration private Cache-Control.
    expect(response.headers.get("etag")).toBe(`"${LFS_OID}"`);
    // The 200's Last-Modified is the OBJECT's storage time
    // (ServeUserContentByFile's Stat().ModTime — the R2 upload just
    // happened), NOT the meta's updatedAt; the meta date rides the gate.
    const objectStamp = new Date(response.headers.get("last-modified") ?? "x");
    expect(Number.isNaN(objectStamp.getTime())).toBe(false);
    expect(Math.abs(objectStamp.getTime() - Date.now())).toBeLessThan(5 * 60 * 1000);
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");

    // The 304 rides the pointer etag and carries the META's updatedAt (the
    // second gate's stamp — the meta row was inserted at the fixed date).
    const notModified = await fetchUi("/alice/rawserve/media/branch/main/assets/big.bin", {
      headers: { "if-none-match": `"${LFS_OID}"` },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(`"${LFS_OID}"`);
    expect(notModified.headers.get("last-modified")).toBe(new Date(1_700_002_000_000).toUTCString());
    expect(notModified.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate"); // the middleware's stamp
  });

  it("degrades to the plain blob when the meta row exists but the object is gone", async () => {
    const current = await ensureFixtures();
    // Row without bytes (the uploading-state race) — the graceful arm.
    await new LfsStateService(env.DB).insertVerified(lfsRepoId(current.repoId), GHOST_OID, 4, new Date());
    const response = await fetchUi("/alice/rawserve/media/branch/main/assets/ghost.bin");
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(GHOST_POINTER_TEXT);
  });
});

// --- 6. the file view's LFS badge (file_info.tmpl:14) -----------------------------

describe("the file view's LFS badge (the view.go:72-123 pointer probe)", () => {
  const BADGE = '<span class="ui label">LFS</span>';

  it("renders the badge beside the size on a seeded pointer file", async () => {
    const response = await fetchUi("/alice/rawserve/src/branch/main/assets/big.bin");
    expect(response.status).toBe(200);
    const html = await response.text();
    // The exact file_info.tmpl:14 adjacency: the label inside the size's
    // file-info-entry, right after the file-info-size span (the pointer is
    // 127 bytes → "127 B").
    expect(html).toContain('<span class="file-info-size">127 B</span><span class="ui label">LFS</span>');
    expect(html).toContain(BADGE);
  });

  it("renders the badge with or without a meta row (view.go:104-110's error path keeps lfsMeta)", async () => {
    // big.bin carries a verified row + object by now (the media suite
    // inserted them); ghost.bin's object was NEVER stored — the badge is a
    // parse-only property, identical under both meta states.
    for (const path of ["assets/big.bin", "assets/ghost.bin"]) {
      const response = await fetchUi(`/alice/rawserve/src/branch/main/${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(BADGE);
    }
  });

  it("renders no badge on plain text, plain binary, or a malformed pointer", async () => {
    for (const path of ["README.md", "assets/logo.png", "NOTES.txt", "assets/broken.bin"]) {
      const response = await fetchUi(`/alice/rawserve/src/branch/main/${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(BADGE);
    }
  });
});

// --- 6b. the file view's raw/media link flip (view_file.go:210-212) ---------------

describe("the file view's raw/media link flip (view_file.go:210-212's RawFileLink overwrite)", () => {
  it("links an LFS-pointer file's raw/media actions to the /media family — meta row or not (the parse-only flip)", async () => {
    // big.bin rides the media suite's verified row + object; ghost.bin has
    // NO meta row — the flip keys on `fInfo.isLFSFile()` alone (the probe's
    // parse verdict), so both flip identically (the badge's parse-only
    // posture, now on the link too). Every RawFileLink consumer carries the
    // overwritten value (view_file.tmpl:2 root attr, :49 Raw button, :64
    // copy control, :123-135 media srcs — the composed URL mirrors
    // RepoLink + "/media/" + RefTypeNameSubURL + "/" + PathEscapeSegments
    // TreePath).
    for (const path of ["assets/big.bin", "assets/ghost.bin"]) {
      const response = await fetchUi(`/alice/rawserve/src/branch/main/${path}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      const mediaLink = `/alice/rawserve/media/branch/main/${path}`;
      expect(html).toContain(`data-raw-file-link="${mediaLink}"`);
      expect(html).toContain(`href="${mediaLink}"`);
      // The dead-link backstop: the flipped target serves on both arms
      // (big.bin → the LFS bytes, ghost.bin → the nil-meta pointer-text
      // fall-through — section 5 pins the bytes/headers).
      expect((await fetchUi(mediaLink)).status).toBe(200);
    }
  });

  it("keeps /raw on regular files AND the malformed pointer (SingleDownload has no LFS arm)", async () => {
    // The negatives: plain text, plain binary — and broken.bin, whose
    // pointer-shaped content FAILS the parse (the InvalidPointerError arm,
    // upstream's IsValid() == false plain file): a guard against flipping on
    // pointer-shaped bytes rather than a VALID pointer.
    for (const path of ["README.md", "NOTES.txt", "assets/logo.png", "assets/broken.bin"]) {
      const response = await fetchUi(`/alice/rawserve/src/branch/main/${path}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      const rawLink = `/alice/rawserve/raw/branch/main/${path}`;
      expect(html).toContain(`data-raw-file-link="${rawLink}"`);
      expect(html).toContain(`href="${rawLink}"`);
      expect(html).not.toContain(`data-raw-file-link="/alice/rawserve/media/`);
    }
  });
});

// --- 7. the 404 family ------------------------------------------------------------

describe("the 404 family (unresolvable refs and paths)", () => {
  it("404-shells unknown branches and missing paths on both families", async () => {
    for (const path of [
      "/alice/rawserve/raw/branch/nonexistent/README.md",
      "/alice/rawserve/raw/branch/main/missing.txt",
      "/alice/rawserve/media/branch/nonexistent/README.md",
      "/alice/rawserve/media/branch/main/missing.txt",
    ]) {
      const response = await fetchUi(path);
      expect(response.status).toBe(404);
    }
  });
});
