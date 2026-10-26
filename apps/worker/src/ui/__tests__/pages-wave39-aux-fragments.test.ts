/**
 * Pages wave 39 route tests — the aux-fragment batch minus its three
 * documented skips: the pasted-blob-URL redirect
 * (`/{owner}/{repo}/blob/*`, pages/repo-home.tsx's blobRedirectResponse, the
 * survey's row 1) and the two portable JSON fragments of row 5 — the
 * find-file feed (`/{owner}/{repo}/tree-list/{branch|tag|commit}/*`,
 * pages/tree-list-aux.ts) and the branches name feed
 * (`/{owner}/{repo}/branches/list`, pages/branches-list-aux.ts).
 *
 * Upstream contracts under test (the module docs carry the cites):
 * blob redirect — web.go:1757 repo.RedirectRepoBlobToCommit: the RAW
 * (still-encoded) suffix swaps verbatim onto `/src/commit/`, the query
 * travels, status 303 See Other (Base.Redirect's default,
 * services/context/base.go:157), post-resolution ordering (unknown/private
 * 404, never redirect), the bare `/blob` 404 shell (chi's `/*` needs the
 * slash — the wave-2 /tree twin). tree-list — web.go:1297-1306
 * repo.TreeList: the bare recursive file-path ARRAY (full paths, the
 * `ls-tree -r` name-field FIXME), dirs/submodules excluded, the
 * natural-sort order (the numeric-run port; byte-order would interleave
 * file10 before file2), the typed ref-tail resolution (branch walk + HEAD
 * swap / tag walk / hex commit shape; the tail's path half is ignored — the
 * handler walks the ROOT tree), the 404 family (empty repo, wrong-universe
 * ref, short/unknown oid — the full-oid divergence). branches/list —
 * web.go:1695 repo.GetBranchesList: the `{"results":[names]}` byte shape
 * (branchTagSearchResponse), default branch hoisted (repo.go:574-580), the
 * byte-order tail (the commit_time DESC divergence), MustBeNotEmpty.
 *
 * Documented skips (in test form): the row-5 fragments whose upstream byte
 * shape rides machinery this codebase has not landed stay engine-owned —
 * `/tree-view/*` (the ViewFileTreeStore JSON carries the fileicon theme
 * pool: material-icon-rules.json + material-icon-svgs.json + the enry
 * classifier, gitea/modules/fileicon/), `/blob_excerpt/{sha}` (the
 * tplBlobExcerpt HTML fragment over BuildBlobExcerptDiffSection hunk
 * expansion + PR code comments), `/lastcommit/*` (the tplRepoViewList HTML
 * fragment over per-entry GetCommitsInfo). Nothing fakes their shapes.
 *
 * Same harness posture as pages-wave32: the router driven directly with the
 * synthetic ASSETS manifest; engine content seeds through the REAL receive
 * flow with fixed timestamps (deterministic oids). Fixture repos
 * `alice/wave39aux` (main at c1 — the nested two-dir tree + the
 * file1/file2/file10 natural-sort triple; feature + feature-less
 * multi-segment `rel/1.0` at c0; tag v39 at c0) and `alice/wave39empty`
 * (never pushed — the MustBeNotEmpty / nil-Commit arms).
 */

import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { naturalSortCompare } from "../pages/tree-list-aux";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`), uiEnv);
}

// --- fixtures -----------------------------------------------------------------

/** Two fixed commits: c0 roots (README + the natural-sort triple), c1 adds
 *  the nested docs/src trees (= main). feature and rel/1.0 stop at c0. */
const WAVE39_COMMITS: SeedCommit[] = [
  {
    message: "wave39: root commit",
    time: T0,
    files: [
      { path: "README.md", content: "wave39 root readme\n" },
      { path: "file1.txt", content: "one\n" },
      { path: "file2.txt", content: "two\n" },
      { path: "file10.txt", content: "ten\n" },
    ],
  },
  {
    message: "wave39: add nested trees",
    time: T0 + 60,
    files: [
      { path: "README.md", content: "wave39 root readme\n" },
      { path: "file1.txt", content: "one\n" },
      { path: "file2.txt", content: "two\n" },
      { path: "file10.txt", content: "ten\n" },
      { path: "docs/deep/notes.md", content: "# wave39 notes\n" },
      { path: "src/app.ts", content: 'console.log("wave39");\n' },
      { path: "src/lib/util.go", content: "package lib\n" },
    ],
  },
];

const WAVE39_MAIN = 1; // main at c1; feature + rel/1.0 + tag v39 at c0

/** c1's recursive file universe in upstream's natural-sort order (the
 *  numeric run 1 < 2 < 10 — byte order would put file10 second). */
const WAVE39_C1_FILES = ["README.md", "docs/deep/notes.md", "file1.txt", "file2.txt", "file10.txt", "src/app.ts", "src/lib/util.go"];
/** c0's universe. */
const WAVE39_C0_FILES = ["README.md", "file1.txt", "file2.txt", "file10.txt"];

async function pushRefs(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array, token: string): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`wave39 seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** Idempotent seed (the wave-32 recipe): owner row, one pack push (main at
 *  c1; feature + feature/one-shaped rel/1.0 at c0; tag v39 at c0), settle +
 *  public; plus the never-pushed `alice/wave39empty` row. */
async function ensureWave39Repos(): Promise<{ tips: string[] }> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const alice =
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) ??
    (await seedVerifiedUser({ username: "alice" }));
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, "ui-page-seed-wave39")
    .run();
  const token = (await mintFor(alice.id, "ui-page-seed-wave39", "write:repository")).plaintext;

  const repoName = "alice/wave39aux";
  const refs = await env.REPO.getByName(repoName).listRefs();
  let tips: string[];
  if (refs.head === null) {
    const seeded = await buildHistoryPack(WAVE39_COMMITS);
    tips = seeded.tips;
    await pushRefs(
      repoName,
      [
        { ref: "refs/heads/main", oid: tips[WAVE39_MAIN] as string },
        { ref: "refs/heads/feature", oid: tips[0] as string },
        { ref: "refs/heads/rel/1.0", oid: tips[0] as string },
        { ref: "refs/tags/v39", oid: tips[0] as string },
      ],
      seeded.pack,
      token,
    );
  } else {
    tips = (await buildHistoryPack(WAVE39_COMMITS)).tips;
  }

  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave39aux")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wave39aux",
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

  // The never-pushed repo (the MustBeNotEmpty / nil-Commit arms).
  const emptyName = "alice/wave39empty";
  let emptyRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave39empty")))
    .get();
  if (emptyRow === undefined) {
    emptyRow = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wave39empty",
      isPrivate: false,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, emptyRow.id, emptyName);
  }
  if (emptyRow.visibility !== "public") {
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, emptyRow.id));
  }

  return { tips };
}

let wave39Tips: string[] | null = null;

async function tips(): Promise<string[]> {
  if (wave39Tips === null) wave39Tips = (await ensureWave39Repos()).tips;
  return wave39Tips;
}

beforeAll(async () => {
  await tips();
});

// --- the parser (the single owner of the route shape) ---------------------------

describe("wave-39 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the blob wildcard tail, raw suffix verbatim, bare URL included", () => {
    expect(parseUiRoute("/octo/hello/blob/main/README.md")).toEqual({
      family: "blob-redirect",
      owner: "octo",
      repo: "hello",
      rawSuffix: "main/README.md",
    });
    // The RAW tail: still-encoded text travels verbatim (PathParamRaw parity).
    expect(parseUiRoute("/octo/hello/blob/main/a%20b.txt")).toEqual({
      family: "blob-redirect",
      owner: "octo",
      repo: "hello",
      rawSuffix: "main/a%20b.txt",
    });
    // The bare URL: chi's `/blob/*` needs the slash — claimed here, the
    // dispatcher's 404-shell arm (the wave-2 /tree pair's posture).
    expect(parseUiRoute("/octo/hello/blob")).toEqual({ family: "blob-redirect", owner: "octo", repo: "hello", rawSuffix: "" });
    expect(handlesUiRoute("/octo/hello/blob/abc123")).toBe(true);
  });

  it("claims the typed tree-list tails and nothing else in the space", () => {
    expect(parseUiRoute("/octo/hello/tree-list/branch/feature/one/src")).toEqual({
      family: "tree-list-aux",
      owner: "octo",
      repo: "hello",
      refType: "branch",
      refSuffix: "feature/one/src",
    });
    expect(parseUiRoute("/octo/hello/tree-list/tag/v1.0/rc")).toEqual({
      family: "tree-list-aux",
      owner: "octo",
      repo: "hello",
      refType: "tag",
      refSuffix: "v1.0/rc",
    });
    expect(parseUiRoute(`/octo/hello/tree-list/commit/${"a".repeat(40)}/docs`)).toEqual({
      family: "tree-list-aux",
      owner: "octo",
      repo: "hello",
      refType: "commit",
      refSuffix: `${"a".repeat(40)}/docs`,
    });
    // Below the typed tail: chi's sub-routes need `/type/*`.
    expect(parseUiRoute("/octo/hello/tree-list")).toBeNull();
    expect(parseUiRoute("/octo/hello/tree-list/branch")).toBeNull();
    // The type literal is the route shape (web.go:1298-1300).
    expect(parseUiRoute("/octo/hello/tree-list/bogus/x")).toBeNull();
    expect(handlesUiRoute("/octo/hello/tree-list/branch/main")).toBe(true);
    expect(handlesUiRoute("/octo/hello/tree-list/bogus/main")).toBe(false);
  });

  it("claims the branches/list literal beside the wave-16 family", () => {
    expect(parseUiRoute("/octo/hello/branches/list")).toEqual({ family: "branches-list-aux", owner: "octo", repo: "hello" });
    // Deeper tails and the wave-16 claims stay put.
    expect(parseUiRoute("/octo/hello/branches/list/more")).toBeNull();
    expect(parseUiRoute("/octo/hello/branches")).toEqual({ family: "branches", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/branches/delete")).toEqual({ family: "branch-delete", owner: "octo", repo: "hello" });
    expect(handlesUiRoute("/octo/hello/branches/list")).toBe(true);
  });

  it("leaves the skipped row-5 fragments engine-owned (documented skips)", () => {
    // tree-view — the ViewFileTreeStore JSON rides the fileicon theme pool
    // (material icon rules/SVG assets + the enry classifier): not portable,
    // not faked.
    expect(handlesUiRoute("/octo/hello/tree-view/branch/main")).toBe(false);
    // blob_excerpt — the tplBlobExcerpt HTML fragment over
    // BuildBlobExcerptDiffSection hunk expansion + PR code comments.
    expect(handlesUiRoute(`/octo/hello/blob_excerpt/${"a".repeat(40)}`)).toBe(false);
    // lastcommit — the tplRepoViewList HTML fragment over per-entry
    // GetCommitsInfo.
    expect(handlesUiRoute(`/octo/hello/lastcommit/${"a".repeat(40)}/src`)).toBe(false);
  });
});

// --- the natural-sort port ------------------------------------------------------

describe("naturalSortCompare (modules/base/natural_sort.go port)", () => {
  it("orders number runs numerically and trims leading zeros", () => {
    expect(WAVE39_C0_FILES.slice(1).sort(naturalSortCompare)).toEqual(["file1.txt", "file2.txt", "file10.txt"]);
    // Zero-trimmed equal values tie into the whole-string byte fallback
    // ("000" collapses to "0"; "v02" < "v2" byte-wise).
    expect(naturalSortCompare("v02", "v2")).toBeLessThan(0);
    expect(naturalSortCompare("v1.02.3", "v1.2.03")).toBeLessThan(0);
    // Equal strings compare zero.
    expect(naturalSortCompare("same.txt", "same.txt")).toBe(0);
  });
});

// --- the blob redirect ----------------------------------------------------------

describe("GET /{owner}/{repo}/blob/* (RedirectRepoBlobToCommit)", () => {
  it("303s onto /src/commit/ with the raw suffix and the query verbatim", async () => {
    const res = await fetchUi("/alice/wave39aux/blob/main/README.md");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave39aux/src/commit/main/README.md");
    expect((await res.arrayBuffer()).byteLength).toBe(0); // empty body, like http.Redirect
    // The query travels (view_home.go:533-535).
    const queried = await fetchUi("/alice/wave39aux/blob/main/README.md?plain=1");
    expect(queried.status).toBe(303);
    expect(queried.headers.get("location")).toBe("/alice/wave39aux/src/commit/main/README.md?plain=1");
    // The raw suffix: still-encoded text re-emitted verbatim.
    const encoded = await fetchUi("/alice/wave39aux/blob/main/a%20b.txt");
    expect(encoded.headers.get("location")).toBe("/alice/wave39aux/src/commit/main/a%20b.txt");
    // Multi-segment tails re-parse to the same route.
    const deep = await fetchUi("/alice/wave39aux/blob/feature/src/app.ts");
    expect(deep.headers.get("location")).toBe("/alice/wave39aux/src/commit/feature/src/app.ts");
  });

  it("404-shells the bare /blob, an unknown repo, and a private repo", async () => {
    // The bare URL has no upstream route (chi needs the slash) — the tree
    // family's arm.
    expect((await fetchUi("/alice/wave39aux/blob")).status).toBe(404);
    expect((await fetchUi("/ghost/nope/blob/main/README.md")).status).toBe(404);
    const db = drizzle(env.DB);
    const row = (
      await db
        .select()
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave39aux")))
        .get()
    )!;
    await db.update(repositories).set({ visibility: "private" }).where(eq(repositories.id, row.id));
    expect((await fetchUi("/alice/wave39aux/blob/main/README.md")).status).toBe(404);
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  });
});

// --- the find-file aux JSON -----------------------------------------------------

describe("GET /{owner}/{repo}/tree-list/{branch|tag|commit}/* (TreeList)", () => {
  it("serves the bare recursive path array in natural-sort order", async () => {
    const res = await fetchUi("/alice/wave39aux/tree-list/branch/main");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    // Byte-exact: full paths, dirs and submodules excluded, the numeric run
    // 1 < 2 < 10 (byte order would interleave file10 before file2).
    expect(await res.text()).toBe(JSON.stringify(WAVE39_C1_FILES));
  });

  it("resolves branch → multi-segment branch → HEAD → tag → commit oid", async () => {
    const [c0] = (await tips()) as [string];
    // feature stops at c0: the walk reads THAT commit's tree.
    const feature = await fetchUi("/alice/wave39aux/tree-list/branch/feature");
    expect(feature.status).toBe(200);
    expect(await feature.text()).toBe(JSON.stringify(WAVE39_C0_FILES));
    // The multi-segment branch (no `rel` branch exists, so the shortest
    // existing prefix is `rel/1.0` itself).
    const deep = await fetchUi("/alice/wave39aux/tree-list/branch/rel/1.0");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe(JSON.stringify(WAVE39_C0_FILES));
    // The literal HEAD swaps in the default branch (repo.go:875-881).
    const head = await fetchUi("/alice/wave39aux/tree-list/branch/HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe(JSON.stringify(WAVE39_C1_FILES));
    // The tag-typed route reads the tag's commit.
    const tag = await fetchUi("/alice/wave39aux/tree-list/tag/v39");
    expect(tag.status).toBe(200);
    expect(await tag.text()).toBe(JSON.stringify(WAVE39_C0_FILES));
    // The commit-typed route reads the oid.
    const commit = await fetchUi(`/alice/wave39aux/tree-list/commit/${c0}`);
    expect(commit.status).toBe(200);
    expect(await commit.text()).toBe(JSON.stringify(WAVE39_C0_FILES));
    // The path tail only feeds the ref middleware — the walk is the ROOT
    // tree (treelist.go:26's SubTree("/")), so the response ignores it.
    const withPath = await fetchUi("/alice/wave39aux/tree-list/branch/main/src/deep/ignored");
    expect(withPath.status).toBe(200);
    expect(await withPath.text()).toBe(JSON.stringify(WAVE39_C1_FILES));
  });

  it("404s the wrong-universe, short-oid, unknown-oid, and empty-repo arms", async () => {
    const [c0] = (await tips()) as [string];
    // A tag name under the branch route: the forced-type middleware finds
    // no branch → "branch or tag not exist" (repo.go:976-979) — a hex shape
    // does not rescue it either (the branch walk never reaches the oid arm).
    expect((await fetchUi("/alice/wave39aux/tree-list/branch/v39")).status).toBe(404);
    expect((await fetchUi("/alice/wave39aux/tree-list/tag/main")).status).toBe(404);
    // The commit-typed route: short prefixes stay the documented full-oid
    // divergence (upstream GetCommit resolves them), unknown oids 404.
    expect((await fetchUi(`/alice/wave39aux/tree-list/commit/${c0.slice(0, 7)}`)).status).toBe(404);
    expect((await fetchUi(`/alice/wave39aux/tree-list/commit/${"f".repeat(40)}`)).status).toBe(404);
    // The empty repo: upstream's nil-Commit failure arm — the 404 family.
    expect((await fetchUi("/alice/wave39empty/tree-list/branch/main")).status).toBe(404);
  });
});

// --- the branches aux JSON ------------------------------------------------------

describe("GET /{owner}/{repo}/branches/list (GetBranchesList)", () => {
  it("serves the results array with the default branch hoisted", async () => {
    const res = await fetchUi("/alice/wave39aux/branches/list");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    // Byte-order tail (the commit_time DESC divergence), default hoisted
    // (repo.go:574-580). The universe: feature, main, rel/1.0.
    expect(await res.text()).toBe(JSON.stringify({ results: ["main", "feature", "rel/1.0"] }));
  });

  it("404s the empty repo (MustBeNotEmpty) and hides a private repo", async () => {
    expect((await fetchUi("/alice/wave39empty/branches/list")).status).toBe(404);
    const db = drizzle(env.DB);
    const row = (
      await db
        .select()
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave39aux")))
        .get()
    )!;
    await db.update(repositories).set({ visibility: "private" }).where(eq(repositories.id, row.id));
    expect((await fetchUi("/alice/wave39aux/branches/list")).status).toBe(404);
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  });
});
