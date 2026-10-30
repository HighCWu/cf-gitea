/**
 * Pages wave 32 route tests — the archive download family
 * (`/{owner}/{repo}/archive/{ref}.{zip|tar.gz}`, pages/archive-files.ts,
 * the survey's row 1) + the commit view's aux JSON
 * (`/{owner}/{repo}/commit/{sha}/load-branches-and-tags`,
 * pages/commit-contained-refs.ts, the survey's row 3).
 *
 * Upstream contracts under test (the module docs carry the cites):
 * archive — web.go:1689 repo.Download over services/repository/archiver:
 * the octet-stream + nosniff pair, the attachment filename
 * `{slug}-{ref-with-dashes}.{ext}`, the weak ETag `W/"{oid}-{fmt}-true"`
 * with the 304 arm (private, max-age=21600), the 200's zero-option prod
 * Cache-Control, the Nix immutable Link header keyed by the RESOLVED oid,
 * the ustar/zip bytes over the landed streaming builder (repo-name prefix),
 * the `?path=` walk filter, the 400 class (unknown suffix / bundle / bare
 * `/archive`) and the 404 family (empty repo, unresolvable ref, private).
 * aux JSON — web.go:1740 repo.LoadBranchesAndTags: the ContainedLinks byte
 * shape {branches,tags,default_branch} with {name,web_link} entries, the
 * containment matrix (a commit behind a branch tip vs the tip itself,
 * multiple tags one commit, name-sorted), the JSON content type + the
 * middleware Cache-Control stamp, the 404 arms (empty repo, short prefix —
 * the full-oid divergence, unknown oid, non-hex sha → engine-owned).
 *
 * Same harness posture as pages-wave29: the router driven directly with the
 * synthetic ASSETS manifest; engine content seeds through the REAL receive
 * flow with fixed timestamps (deterministic oids). Fixture repos
 * `alice/wave32arc` (main at c1 + tag v1; feature at c2 + tags rel/1.0, v2;
 * branch feature/one at c2 for the multi-segment tail) and
 * `alice/wave32empty` (never pushed — the MustBeNotEmpty arms).
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
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: { headers?: Record<string, string> }): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

// --- fixtures -----------------------------------------------------------------

/** Three fixed commits: root (README), the two-file edit (= main, = tag v1),
 *  and the docs addition (= feature, = tags rel/1.0 + v2). */
const WAVE32_COMMITS: SeedCommit[] = [
  { message: "wave32: root commit", time: T0, files: [{ path: "README.md", content: "wave32 root readme\n" }] },
  {
    message: "wave32: edit readme and add source",
    time: T0 + 60,
    files: [
      { path: "README.md", content: "wave32 readme v2\n" },
      { path: "src/app.ts", content: 'console.log("wave32");\n' },
    ],
  },
  {
    message: "wave32: add docs",
    time: T0 + 120,
    files: [
      { path: "README.md", content: "wave32 readme v2\n" },
      { path: "src/app.ts", content: 'console.log("wave32");\n' },
      { path: "docs/notes.md", content: "# wave32 notes\n" },
    ],
  },
];

const WAVE32_MAIN = 1; // main + v1 at c1 — c2 is one ahead (feature + rel/1.0 + v2)

async function pushRefs(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array, token: string): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`wave32 seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** Idempotent seed (the wave-29 recipe): owner row, one pack push (main at
 *  c1, feature + feature/one at c2, tags v1@c1 rel/1.0@c2 v2@c2), settle +
 *  public; plus the never-pushed `alice/wave32empty` row. */
async function ensureWave32Repos(): Promise<{ tips: string[] }> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const alice =
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) ??
    (await seedVerifiedUser({ username: "alice" }));
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, "ui-page-seed-wave32")
    .run();
  const token = (await mintFor(alice.id, "ui-page-seed-wave32", "write:repository")).plaintext;

  const repoName = "alice/wave32arc";
  const refs = await env.REPO.getByName(repoName).listRefs();
  let tips: string[];
  if (refs.head === null) {
    const seeded = await buildHistoryPack(WAVE32_COMMITS);
    tips = seeded.tips;
    await pushRefs(
      repoName,
      [
        { ref: "refs/heads/main", oid: tips[WAVE32_MAIN] as string },
        { ref: "refs/heads/feature", oid: tips[2] as string },
        { ref: "refs/heads/feature/one", oid: tips[2] as string },
        { ref: "refs/tags/v1", oid: tips[1] as string },
        { ref: "refs/tags/rel/1.0", oid: tips[2] as string },
        { ref: "refs/tags/v2", oid: tips[2] as string },
      ],
      seeded.pack,
      token,
    );
  } else {
    tips = (await buildHistoryPack(WAVE32_COMMITS)).tips;
  }

  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave32arc")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wave32arc",
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
  const emptyName = "alice/wave32empty";
  let emptyRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave32empty")))
    .get();
  if (emptyRow === undefined) {
    emptyRow = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wave32empty",
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

let wave32Tips: string[] | null = null;

async function tips(): Promise<string[]> {
  if (wave32Tips === null) wave32Tips = (await ensureWave32Repos()).tips;
  return wave32Tips;
}

beforeAll(async () => {
  await tips();
});

// --- the parser (the single owner of the route shape) ---------------------------

describe("wave-32 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the archive wildcard tail, slashes and bare URL included", () => {
    expect(parseUiRoute("/octo/hello/archive/main.zip")).toEqual({
      family: "repo-archive",
      owner: "octo",
      repo: "hello",
      refExt: "main.zip",
    });
    // Multi-segment ref names re-parse to the same route (chi's `*` tail).
    expect(parseUiRoute("/octo/hello/archive/feature/x.tar.gz")).toEqual({
      family: "repo-archive",
      owner: "octo",
      repo: "hello",
      refExt: "feature/x.tar.gz",
    });
    // The bare URL: chi's `/*` matches the empty tail and the empty string
    // is SplitArchiveNameType's unknown-format arm.
    expect(parseUiRoute("/octo/hello/archive")).toEqual({
      family: "repo-archive",
      owner: "octo",
      repo: "hello",
      refExt: "",
    });
    expect(parseUiRoute("/octo/hello/archive/")).toEqual({
      family: "repo-archive",
      owner: "octo",
      repo: "hello",
      refExt: "",
    });
    expect(handlesUiRoute("/octo/hello/archive/main.bundle")).toBe(true);
  });

  it("claims the hex-shaped load-branches-and-tags tail and nothing else in the commit space", () => {
    expect(parseUiRoute("/octo/hello/commit/5bde6b37197b62bf146fa01ac0bb3f0ee78aa3c0/load-branches-and-tags")).toEqual({
      family: "commit-contained-refs",
      owner: "octo",
      repo: "hello",
      sha: "5bde6b37197b62bf146fa01ac0bb3f0ee78aa3c0",
    });
    expect(parseUiRoute("/octo/hello/commit/abc1234/load-branches-and-tags")).toEqual({
      family: "commit-contained-refs",
      owner: "octo",
      repo: "hello",
      sha: "abc1234",
    });
    // 64-hex is the pattern's top bound (web.go:1740).
    expect(parseUiRoute(`/octo/hello/commit/${"a".repeat(64)}/load-branches-and-tags`)?.family).toBe("commit-contained-refs");
    // 65-hex fails the SHAPE → engine-owned (upstream's pattern miss), not
    // the view claim (the tail makes it a different shape than wave-18's).
    expect(parseUiRoute(`/octo/hello/commit/${"a".repeat(65)}/load-branches-and-tags`)).toBeNull();
    // A non-hex sha with the literal tail: upstream's pattern miss too.
    expect(parseUiRoute("/octo/hello/commit/foo/load-branches-and-tags")).toBeNull();
    // Other 5-segment tails stay engine-owned.
    expect(parseUiRoute("/octo/hello/commit/abc1234/cherry-pick")).toBeNull();
    // The undotted single-segment shapes are untouched (wave-18's claim).
    expect(parseUiRoute("/octo/hello/commit/abc1234")).toEqual({ family: "commit-view", owner: "octo", repo: "hello", sha: "abc1234" });
    expect(handlesUiRoute("/octo/hello/commit/abc1234/load-branches-and-tags")).toBe(true);
    expect(handlesUiRoute("/octo/hello/commit/foo/load-branches-and-tags")).toBe(false);
  });
});

// --- the archive download -------------------------------------------------------

describe("GET /{owner}/{repo}/archive/{ref}.{tar.gz|zip}", () => {
  it("streams the tar.gz with the upstream header matrix", async () => {
    const [, c1] = (await tips()) as [string, string];
    const res = await fetchUi("/alice/wave32arc/archive/main.tar.gz");
    expect(res.status).toBe(200);
    // serveSetHeaderContentRelated's empty-ContentType arm: octet-stream +
    // nosniff for BOTH formats (the sniffed gzip type never appears).
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // GetArchiveName's attachment form: {repo.Name}-{ref-with-dashes}.{ext}.
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="wave32arc-main.tar.gz"');
    expect(res.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    // The weak ETag over the RESOLVED commit + format + the always-on prefix.
    expect(res.headers.get("etag")).toBe(`W/"${c1}-tar.gz-true"`);
    // The 200's Cache-Control: ServeSetHeaders' zero-option prod form
    // OVERWRITES the private-static 6h value the ETag check set.
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    // The Nix immutable-rev link, keyed by the resolved oid (Repo.APIURL()).
    expect(res.headers.get("link")).toBe(
      `<https://test.local/api/v1/repos/alice/wave32arc/archive/${c1}.tar.gz?rev=${c1}>; rel="immutable"`,
    );
    // The gzip magic + the inflated ustar: the lowercased repo-NAME prefix
    // (upstream --prefix=<repo.Name>/, no owner segment), the full paths,
    // the blob bytes (main = c1's two-file tree).
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    const gunzipped = new Response(bytes).body?.pipeThrough(new DecompressionStream("gzip")) ?? null;
    if (gunzipped === null) throw new Error("archive response lost its body");
    const inflated = new TextDecoder().decode(await new Response(gunzipped).arrayBuffer());
    expect(inflated).toContain("wave32arc/README.md");
    expect(inflated).not.toContain("alice/");
    expect(inflated).toContain("wave32 readme v2");
    expect(inflated).toContain("wave32arc/src/app.ts");
    expect(inflated).not.toContain("docs/notes.md"); // c2's file is not in main's tree
  });

  it("streams the zip with the STORE magic and the resolved-oid ETag", async () => {
    const [, , c2] = (await tips()) as [string, string, string];
    const res = await fetchUi("/alice/wave32arc/archive/feature.zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="wave32arc-feature.zip"');
    expect(res.headers.get("etag")).toBe(`W/"${c2}-zip-true"`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The local-file-header magic PK\x03\x04; the archive-parity wave moved
    // the entries STORE → DEFLATE (git archive's own posture, archive-zip.c
    // deflates every non-empty entry) — the header's method field now reads
    // 8 while the entry NAMES stay literal. The file CONTENT is a deflate
    // stream here, so its literal assert moved to archive.test.ts's
    // dedicated DEFLATE pins (round-trip + CRC verified there).
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // Method 8 (deflate) in the first local header, little-endian at :8.
    expect((bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8)).toBe(8);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("wave32arc/docs/notes.md");
  });

  it("resolves branch → multi-segment branch → tag → full oid (404 otherwise)", async () => {
    const [root, c1, c2] = (await tips()) as [string, string, string];
    // The tag name (peeled through nothing — a lightweight tag).
    const tagRes = await fetchUi("/alice/wave32arc/archive/v1.tar.gz");
    expect(tagRes.status).toBe(200);
    expect(tagRes.headers.get("etag")).toBe(`W/"${c1}-tar.gz-true"`);
    // The multi-segment branch: the wildcard tail reassembles the ref.
    const deepRes = await fetchUi("/alice/wave32arc/archive/feature/one.zip");
    expect(deepRes.status).toBe(200);
    expect(deepRes.headers.get("content-disposition")).toBe('attachment; filename="wave32arc-feature-one.zip"');
    expect(deepRes.headers.get("etag")).toBe(`W/"${c2}-zip-true"`);
    // A full oid resolves like upstream GetCommit.
    const oidRes = await fetchUi(`/alice/wave32arc/archive/${root}.tar.gz`);
    expect(oidRes.status).toBe(200);
    expect(oidRes.headers.get("etag")).toBe(`W/"${root}-tar.gz-true"`);
    // An unresolvable ref: `unrecognized repository reference` 404 (the shell).
    expect((await fetchUi("/alice/wave32arc/archive/nope.zip")).status).toBe(404);
    expect((await fetchUi(`/alice/wave32arc/archive/${"f".repeat(40)}.zip`)).status).toBe(404);
  });

  it("answers the 400 class: unknown suffix, bundle refusal, the bare tail", async () => {
    // SplitArchiveNameType's unknown arm — ctx.HTTPError's plain text.
    const unknown = await fetchUi("/alice/wave32arc/archive/main.rar");
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await unknown.text()).toBe("unknown format: main.rar\n");
    // The bare `/archive` tail: SplitArchiveNameType("") is the same arm.
    const bare = await fetchUi("/alice/wave32arc/archive");
    expect(bare.status).toBe(400);
    expect(await bare.text()).toBe("unknown format: \n");
    // The bundle refusal (the API seam's documented divergence).
    const bundle = await fetchUi("/alice/wave32arc/archive/main.bundle");
    expect(bundle.status).toBe(400);
    expect(await bundle.text()).toBe("bundle archives are not supported\n");
  });

  it("answers the 304 arm with the private-static cache control", async () => {
    const [, c1] = (await tips()) as [string, string];
    const etag = `W/"${c1}-tar.gz-true"`;
    const notModified = await fetchUi("/alice/wave32arc/archive/main.tar.gz", {
      headers: { "if-none-match": etag },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);
    // HandleGenericETagPrivateCache's CacheControlForPrivateStatic — the 6h
    // STATIC_CACHE_TIME the 200 overwrites.
    expect(notModified.headers.get("cache-control")).toBe("private, max-age=21600");
    expect((await notModified.arrayBuffer()).byteLength).toBe(0);
    // The validator compares W/-insensitively over a comma list (and `*`).
    const weakless = await fetchUi("/alice/wave32arc/archive/main.tar.gz", {
      headers: { "if-none-match": `"${c1}-tar.gz-true", "junk"` },
    });
    expect(weakless.status).toBe(304);
    const star = await fetchUi("/alice/wave32arc/archive/main.tar.gz", { headers: { "if-none-match": "*" } });
    expect(star.status).toBe(304);
    // A mismatching validator re-serves the 200.
    const miss = await fetchUi("/alice/wave32arc/archive/main.tar.gz", {
      headers: { "if-none-match": 'W/"deadbeef-tar.gz-true"' },
    });
    expect(miss.status).toBe(200);
  });

  it("filters the walk with the ?path= pathspec", async () => {
    const res = await fetchUi("/alice/wave32arc/archive/main.zip?path=src");
    expect(res.status).toBe(200);
    const text = new TextDecoder().decode(await res.arrayBuffer());
    expect(text).toContain("wave32arc/src/app.ts");
    expect(text).not.toContain("README.md");
  });

  it("404s the empty repo (MustBeNotEmpty) and hides a private repo", async () => {
    expect((await fetchUi("/alice/wave32empty/archive/main.zip")).status).toBe(404);
    const db = drizzle(env.DB);
    const row = (
      await db
        .select()
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave32arc")))
        .get()
    )!;
    await db.update(repositories).set({ visibility: "private" }).where(eq(repositories.id, row.id));
    expect((await fetchUi("/alice/wave32arc/archive/main.zip")).status).toBe(404);
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  });
});

// --- the commit aux JSON --------------------------------------------------------

describe("GET /{owner}/{repo}/commit/{sha}/load-branches-and-tags", () => {
  it("serves the ContainedLinks shape with the containment matrix", async () => {
    const [, c1, c2] = (await tips()) as [string, string, string];
    // c1: behind feature AND AT main; every tag whose tip descends from it
    // contains it too (v1 at c1 itself, rel/1.0 + v2 at c2 — the
    // `git tag --contains` semantics verbatim). Name-sorted entries, the
    // byte-exact Go marshal order (branches, tags, default_branch).
    const c1Res = await fetchUi(`/alice/wave32arc/commit/${c1}/load-branches-and-tags`);
    expect(c1Res.status).toBe(200);
    expect(c1Res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(c1Res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(await c1Res.text()).toBe(
      `{"branches":[{"name":"feature","web_link":"/alice/wave32arc/src/branch/feature"},` +
        `{"name":"feature/one","web_link":"/alice/wave32arc/src/branch/feature/one"},` +
        `{"name":"main","web_link":"/alice/wave32arc/src/branch/main"}],` +
        `"tags":[{"name":"rel/1.0","web_link":"/alice/wave32arc/src/tag/rel/1.0"},` +
        `{"name":"v1","web_link":"/alice/wave32arc/src/tag/v1"},` +
        `{"name":"v2","web_link":"/alice/wave32arc/src/tag/v2"}],` +
        `"default_branch":"main"}`,
    );
    // c2: only the feature tips contain it (main sits BEHIND); v1 (at c1)
    // does not contain it — an ancestor is not a container.
    const c2Res = await fetchUi(`/alice/wave32arc/commit/${c2}/load-branches-and-tags`);
    expect(c2Res.status).toBe(200);
    expect(await c2Res.text()).toBe(
      `{"branches":[{"name":"feature","web_link":"/alice/wave32arc/src/branch/feature"},` +
        `{"name":"feature/one","web_link":"/alice/wave32arc/src/branch/feature/one"}],` +
        `"tags":[{"name":"rel/1.0","web_link":"/alice/wave32arc/src/tag/rel/1.0"},` +
        `{"name":"v2","web_link":"/alice/wave32arc/src/tag/v2"}],` +
        `"default_branch":"main"}`,
    );
  });

  it("404s the short-prefix, unknown, non-hex and empty-repo arms", async () => {
    const [, c1] = (await tips()) as [string, string];
    // The full-oid divergence: upstream RevParse resolves 7..39-hex prefixes
    // inside ListOccurrences, the engine answers full reachable oids only.
    expect((await fetchUi(`/alice/wave32arc/commit/${c1.slice(0, 7)}/load-branches-and-tags`)).status).toBe(404);
    expect((await fetchUi(`/alice/wave32arc/commit/${c1.slice(0, 39)}/load-branches-and-tags`)).status).toBe(404);
    // A hex-shaped sha that resolves to nothing (upstream 500s here — the
    // ServerError divergence the module doc carries; our 404-family answer).
    expect((await fetchUi(`/alice/wave32arc/commit/${"f".repeat(40)}/load-branches-and-tags`)).status).toBe(404);
    // A non-hex sha with the literal tail: upstream's pattern miss →
    // engine-owned (the gate's 404 through the sub-app's drift guard when
    // driven directly).
    expect((await fetchUi("/alice/wave32arc/commit/foo/load-branches-and-tags")).status).toBe(404);
    // MustBeNotEmpty: the empty repo 404s.
    expect((await fetchUi(`/alice/wave32empty/commit/${"a".repeat(40)}/load-branches-and-tags`)).status).toBe(404);
  });
});
