/**
 * The wiki RAW byte arm's smoke tests (PORT-FIRST MODE: one happy path per
 * arm — the four-candidate probe order, the sniffed content types, the ETag
 * 304, and both 404 arms; the module doc + services/wiki.ts carry the
 * knob-by-knob mapping — no route exists yet, the HANDOFF RECIPE in
 * pages/wiki-raw.ts is the mount wave's). Real engine content: the repo
 * seeds through the landed receive flow (testing/seed-repo.ts), the wiki
 * PAGE lands through the landed service op (createWikiPage), and the
 * non-`.md` raw files (the "image for example" arm + the QueryUnescape
 * fallback name, both unreachable through the page writer) land straight
 * into the sibling `alice/wikiraw.wiki` cell through the same primitives the
 * service's applyWikiChanges uses (buildBlobObject/serializeTree/
 * serializeCommit + putApiObjects/commitApiChange CAS on the ZERO_OID
 * create-on-empty base).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { serializeCommit, serializeTree, type ApiObject } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories, users } from "../../db/schema";
import { ZERO_OID, branchRef, refTipMap } from "../../api/services/engine";
import { buildBlobObject, buildFileChangeCommit, type FileChange } from "../../api/services/git-models";
import type { RepositoryWithOwner } from "../../api/services/repository";
import { createWikiPage, wikiBranch, wikiCell, wikiReads, type WikiDoer } from "../../services/wiki";
import { ensureSeededRepo } from "../testing/seed-repo";
import { loadWikiRawBlob, wikiRawBlobResponse } from "./wiki-raw";

// --- fixtures -----------------------------------------------------------------

const DOER: WikiDoer = { name: "alice", email: "alice@noreply.test.local" };
const ORIGIN = "https://test.local";
const HOME_TEXT = "# Home for raw\n";

/** The repo's own seed commit (push-create needs one; the wiki content is
 *  separate, in the sibling `alice/wikiraw.wiki` cell). */
const SEED_COMMITS = [
  {
    message: "seed: readme",
    time: 1_700_000_000,
    files: [{ path: "README.md", content: "# wikiraw seed\n" }],
  },
];

/** The PNG magic — all the sniffer needs for the image class. */
const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

const SEED_MESSAGE = "seed: raw fixtures";

let pair: RepositoryWithOwner | null = null;

async function ensureFixtures(): Promise<RepositoryWithOwner> {
  if (pair !== null) return pair;
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "wikiraw", commits: SEED_COMMITS });
  const repoRow =
    (await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wikiraw")))
      .get()) ?? null;
  if (repoRow === null) throw new Error("wikiraw repo row missing");
  const owner = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "alice")).get()) ?? null;
  if (owner === null) throw new Error("alice row missing");
  pair = { repo: repoRow, owner };
  return pair;
}

/**
 * Land the non-`.md` raw fixtures straight into the wiki cell — the two arms
 * of services/wiki.ts applyWikiChanges (born branch: a root commit over the
 * ZERO_OID CAS base, the engine seating HEAD; existing branch:
 * buildFileChangeCommit over the observed tip). These names are unreachable
 * through the page writer (it always writes coded `.md` paths), exactly the
 * shapes a git-pushed upstream wiki carries.
 */
async function seedRawWikiEntries(entries: { path: string; content: Uint8Array }[]): Promise<void> {
  const currentPair = await ensureFixtures();
  const person = { name: DOER.name, email: DOER.email, time: 1_700_000_100, tz: "+0000" };
  const ref = branchRef(wikiBranch(currentPair));
  const reads = wikiReads(env, currentPair);
  const tips = refTipMap(await reads.listRefs());
  const tip = tips.get(ref);
  const changes: FileChange[] = entries.map((entry) => ({ operation: "create", path: entry.path, content: entry.content }));

  let objects: ApiObject[];
  let commitOid: string;
  let expectedOld: string;

  if (tip === undefined) {
    const root = new Map<string, { mode: string; oid: string }>();
    objects = [];
    for (const change of changes) {
      const blob = await buildBlobObject(change.content ?? new Uint8Array());
      objects.push(blob);
      root.set(change.path, { mode: "100644", oid: blob.oid });
    }
    const tree = serializeTree([...root.entries()].map(([name, e]) => ({ name, mode: e.mode, oid: e.oid })));
    objects.push({ oid: tree.oid, type: tree.type, data: tree.data });
    const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: SEED_MESSAGE });
    objects.push({ oid: commit.oid, type: commit.type, data: commit.data });
    commitOid = commit.oid;
    expectedOld = ZERO_OID;
  } else {
    const built = await buildFileChangeCommit(reads, tip.target, changes, {
      message: SEED_MESSAGE,
      author: person,
      committer: person,
    });
    if (built === null) throw new Error("wiki branch vanished mid-seed");
    const failed = built.outcomes.find((outcome) => !outcome.ok);
    if (failed !== undefined) throw new Error(`seed change refused: ${failed.error ?? "unknown"}`);
    objects = built.objects;
    commitOid = built.commitOid;
    expectedOld = tip.target;
  }

  const cell = wikiCell(env, currentPair);
  const stored = await cell.putApiObjects(objects);
  if (stored.tag !== "ok") throw new Error(`putApiObjects refused: ${stored.tag}`);
  const landed = await cell.commitApiChange({ ref, expectedOldOid: expectedOld, newOid: commitOid });
  if (landed.tag !== "committed") throw new Error(`commitApiChange refused: ${landed.tag}`);
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- 1. the absent-wiki 404 arm (wiki.go:600-604's not-exist class) -----------

describe("smoke: the absent-wiki arm", () => {
  it("answers null before any wiki write", async () => {
    const currentPair = await ensureFixtures();
    expect(await loadWikiRawBlob(env, currentPair, "Home")).toBeNull();
  });
});

// --- 2. the page rounds (coded path + the `.md` pass-through) -----------------

describe("smoke: the coded-path rounds over a created page", () => {
  it("creates Home through the service and serves its raw bytes twice", async () => {
    const currentPair = await ensureFixtures();
    const page = await createWikiPage(
      env,
      currentPair,
      DOER,
      { title: "Home", content: new TextEncoder().encode(HOME_TEXT), message: "" },
      ORIGIN,
    );
    expect(page.title).toBe("Home");

    // Round 1, the coded path (WebPath "Home" → GitPath "Home.md").
    const blob = await loadWikiRawBlob(env, currentPair, "Home");
    expect(blob).not.toBeNull();
    if (blob === null) throw new Error("unreachable");
    expect(new TextDecoder().decode(blob.data)).toBe(HOME_TEXT);
    expect(blob.oid).toMatch(/^[0-9a-f]{40}$/);

    // The `.md` tail passes through the codec raw (WebPathToGitPath's
    // `.md` arm) — the SAME blob.
    const mdBlob = await loadWikiRawBlob(env, currentPair, "Home.md");
    expect(mdBlob?.oid).toBe(blob.oid);

    // The 200: text forces plain (serve.go:118-134), the "." disposition
    // quirk (path.Base of the never-set TreePath), the public 6 h cache
    // (public repo + public owner), the quoted-oid ETag.
    const response = wikiRawBlobResponse(blob, { cacheIsPublic: true, ifNoneMatch: null });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts allow-modals allow-popups allow-downloads",
    );
    expect(response.headers.get("content-disposition")).toBe("inline; filename=.");
    expect(response.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    expect(response.headers.get("content-length")).toBe(String(blob.data.byteLength));
    expect(response.headers.get("etag")).toBe(`"${blob.oid}"`);
    expect(response.headers.get("cache-control")).toBe("public, max-age=21600");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(blob.data);

    // The 304: If-None-Match answers with the ETag ONLY (httpcache.go:96-101
    // returns before SetCacheControlInHeader) — list + W/ forms match too.
    const notModified = wikiRawBlobResponse(blob, { cacheIsPublic: true, ifNoneMatch: `"${blob.oid}"` });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(`"${blob.oid}"`);
    expect(notModified.headers.get("cache-control")).toBeNull();
    const weakList = wikiRawBlobResponse(blob, { cacheIsPublic: true, ifNoneMatch: `W/"other", "${blob.oid}"` });
    expect(weakList.status).toBe(304);
    // A mismatching etag falls through to the 200.
    const fresh = wikiRawBlobResponse(blob, { cacheIsPublic: true, ifNoneMatch: '"deadbeef"' });
    expect(fresh.status).toBe(200);

    // The private variant (a private repo/owner): CacheControlIsPublic's
    // other arm (serve.go:40-42).
    const privated = wikiRawBlobResponse(blob, { cacheIsPublic: false, ifNoneMatch: null });
    expect(privated.headers.get("cache-control")).toBe("private, max-age=21600");
  });

  it("answers null for a missing page on an existing wiki", async () => {
    const currentPair = await ensureFixtures();
    expect(await loadWikiRawBlob(env, currentPair, "Nope")).toBeNull();
  });
});

// --- 3. the non-`.md` round + the QueryUnescape fallback (direct-cell seeds) --

describe("smoke: the trimmed round and the unescape fallback", () => {
  it("serves a git-pushed image via the .md-trimmed probe and a spaced name via QueryUnescape", async () => {
    await seedRawWikiEntries([
      { path: "pic.png", content: PNG_BYTES },
      { path: "My Notes.md", content: new TextEncoder().encode("spaced\n") },
    ]);
    const currentPair = await ensureFixtures();

    // "pic.png" probes "pic.png.md" (miss) then the TrimSuffix round's
    // "pic.png" (hit) — WikiRaw's image arm (wiki.go:620-628).
    const image = await loadWikiRawBlob(env, currentPair, "pic.png");
    expect(image).not.toBeNull();
    if (image === null) throw new Error("unreachable");
    expect(image.data).toEqual(PNG_BYTES);
    const imageResponse = wikiRawBlobResponse(image, { cacheIsPublic: true, ifNoneMatch: null });
    expect(imageResponse.headers.get("content-type")).toBe("image/png"); // browsable binary keeps its mime

    // "My+Notes.md" codes to itself (PathUnescape keeps the +) and misses;
    // findEntryForFile's QueryUnescape ("+"→space) finds the git-pushed
    // "My Notes.md" (wiki.go:90-95).
    const spaced = await loadWikiRawBlob(env, currentPair, "My+Notes.md");
    expect(spaced).not.toBeNull();
    if (spaced === null) throw new Error("unreachable");
    expect(new TextDecoder().decode(spaced.data)).toBe("spaced\n");
  });
});
