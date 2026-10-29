/**
 * The compare-feeds module's tests (the tick-10 bench row 2, the bench
 * pair — MOUNTED at 22599e4, window-2e B2): the two compare download arms
 * (`/{basehead}.diff|.patch` —
 * upstream compare.go:570-603) and the pull-files range surface
 * (`/pulls/{index}/files/{a}..{b}` — web.go:1672, pull.go:680-950) over REAL
 * seeded engine content (the wave-29 receive-flow recipe; D1 from the
 * generated migrations).
 *
 * Asserted contract: the byte shapes (the separator-aware unified diff; the
 * head-anchored git-am mail block with the signature tail; the EMPTY bodies
 * of the zero-mail / no-change ranges), the content-type + Cache-Control
 * pair (the diffpatch sibling's builder), the URL grammars' edge cases
 * (empty/missing sides, the head-side fork forms — the route parser's
 * grammar with the cross-repo downloads over bob's public/private forks,
 * lowercase-only 7..64 hex,
 * the anchored `..`), and viewPullFiles' admission arms (the half-open
 * "(base, head]" commit list, short-prefix 404s, same-ref and reversed
 * ranges, the broken-PR and unrelated-history 404s).
 *
 * MOUNT RECORD (the per-surface recipe — MOUNTED at 22599e4, window-2e B2,
 * the routes live in `index.ts`; the module header keeps this text as the
 * landed-shape recipe record):
 *   (a)/(b) — in the compare arm of the route discriminator, BEFORE the
 *   `family: "compare"` returns: decode the joined suffix (the arm's own
 *   convention), `parseCompareFeedTail(suffix)`; non-null → the new
 *   `compare-diffpatch` family carrying the stripped tail + ext. In the
 *   dispatcher: `loadCompareFeed(c.env, repo, route.tail, route.ext)` —
 *   `notFound` → the §4.5 shell (renderNotFound, 404), `noMergeBase` →
 *   `compareFeedServerErrorResponse()`, `body` →
 *   `compareFeedTextResponse(body)` (the diffpatch sibling's exact header
 *   pair). Mounted before the compare page family (the pre-mount
 *   suffixed-tail fall-through into the page's 404-at-resolution is gone).
 *   (c) — in the pulls arm, `rest.length === 3 && rest[1] === "files"`:
 *   `parsePullFilesRange(rest[2])` non-null → the `pull-files-range` family
 *   (the bare and single-commit `/files/{sha}` tails stay unclaimed — the
 *   single-commit route is upstream's ViewPullFilesForSingleCommit, not this
 *   row). Dispatcher: `loadPullFilesRange(c, repo.id, route.index,
 *   route.segment)` — null → the 404 shell, else
 *   `renderPullFilesRangePage({ ctx, data })` through `respond(c.html(...))`
 *   (the pull-files family's exact shape).
 */

import { env } from "cloudflare:test";
import { SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { Context } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { issues, repositories, users } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { engineReads } from "../../api/services/engine";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { T0 } from "../__tests__/harness";
import {
  compareFeedServerErrorResponse,
  compareFeedTextResponse,
  loadCompareFeed,
  loadPullFilesRange,
  parseCompareBaseHead,
  parseCompareFeedTail,
  parsePullFilesRange,
  renderPullFilesRangePage,
  resolvePullFilesRange,
  type CompareFeedResult,
} from "./compare-feeds";

/** Narrow a feed outcome to its body (cast-free: throws on the 404/500 arms
 *  and fails the test). */
function feedBody(feed: CompareFeedResult): string {
  if (feed.kind !== "body") throw new Error(`expected a download body, got ${feed.kind}`);
  return feed.body;
}

// --- fixtures -----------------------------------------------------------------

/** Four fixed commits: c0 root, c1 = main tip (the PR merge base), c2 + c3
 *  = the topic tip's range (two commits ahead of main). Fixed times →
 *  deterministic oids. */
const FEED_COMMITS: SeedCommit[] = [
  { message: "cmpfeeds: root commit", time: T0, files: [{ path: "README.md", content: "cmpfeeds root\n" }] },
  { message: "cmpfeeds: c1 readme", time: T0 + 60, files: [{ path: "README.md", content: "cmpfeeds v1\n" }] },
  {
    message: "cmpfeeds: c2 app",
    time: T0 + 120,
    files: [
      { path: "README.md", content: "cmpfeeds v1\n" },
      { path: "src/app.ts", content: 'console.log("cmpfeeds c2");\n' },
    ],
  },
  {
    message: "cmpfeeds: c3 notes\n\nA body line for the patch header.\n",
    time: T0 + 180,
    files: [
      { path: "README.md", content: "cmpfeeds v1\n" },
      { path: "src/app.ts", content: 'console.log("cmpfeeds c2");\n' },
      { path: "docs/notes.md", content: "# cmpfeeds notes\n" },
    ],
  },
];

const MAIN_TIP = 1; // main at c1 — c2/c3 are the PR range
const TOPIC_TIP = 3;

/** An UNRELATED root (no merge base with the linear history) — the
 *  no-merge-base download arm. */
const LONELY_COMMITS: SeedCommit[] = [
  { message: "cmpfeeds: lonely root", time: T0 + 240, files: [{ path: "orphan.txt", content: "cmpfeeds lonely\n" }] },
];

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

async function pushRefs(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array, token: string): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`cmpfeeds seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** Idempotent seed (the wave-29 recipe): owner row, two pack pushes (main at
 *  c1; topic + refs/pull/1/head at c3; the unrelated lonely root), settle +
 *  public; PR #1 open (base main ← head topic), PR #2 broken (head branch
 *  never pushed, no refs/pull/2/head), issue #3 non-pull. */
async function ensureCmpFeedsRepo(): Promise<{ tips: string[]; lonelyTip: string }> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const alice =
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) ??
    (await seedVerifiedUser({ username: "alice" }));
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, "ui-page-seed-cmpfeeds")
    .run();
  const token = (await mintFor(alice.id, "ui-page-seed-cmpfeeds", "write:repository")).plaintext;

  const repoName = "alice/cmpfeeds";
  const { tips, pack } = await buildHistoryPack(FEED_COMMITS);
  const lonely = await buildHistoryPack(LONELY_COMMITS);
  const refs = await env.REPO.getByName(repoName).listRefs();
  if (refs.head === null) {
    await pushRefs(
      repoName,
      [
        { ref: "refs/heads/main", oid: tips[MAIN_TIP] as string },
        { ref: "refs/heads/topic", oid: tips[TOPIC_TIP] as string },
        { ref: "refs/pull/1/head", oid: tips[TOPIC_TIP] as string },
      ],
      pack,
      token,
    );
  }
  const lonelyRef = (await env.REPO.getByName(repoName).listRefs()).refs.find((r) => r.name === "refs/heads/lonely");
  if (lonelyRef === undefined) {
    await pushRefs(repoName, [{ ref: "refs/heads/lonely", oid: lonely.tips[0] as string }], lonely.pack, token);
  }

  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "cmpfeeds")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "cmpfeeds",
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

  // The fork fixtures (the fork-form arms): bob's PUBLIC fork of
  // alice/cmpfeeds carrying the SHARED history (c0/c1 — the same oids; the
  // merge base never needs the carry) plus a divergent branch, and an EMPTY
  // PRIVATE fork for the §2.5 read-grant arm.
  feedBob =
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "bob")).get()) ??
    (await seedVerifiedUser({ username: "bob" }));
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(feedBob.id, "ui-page-seed-cmpfeeds-fork")
    .run();
  const forkToken = (await mintFor(feedBob.id, "ui-page-seed-cmpfeeds-fork", "write:repository")).plaintext;
  const FORK_TIP_COMMIT: SeedCommit = {
    message: "cmpfeeds: the fork diverges\n\nThe fork-only body line.\n",
    time: T0 + 300,
    files: [
      { path: "README.md", content: "cmpfeeds v1\n" },
      { path: "fork-only.md", content: "# from the fork\n" },
    ],
  };
  const { tips: forkTips, pack: forkPack } = await buildHistoryPack([
    FEED_COMMITS[0] as SeedCommit,
    FEED_COMMITS[1] as SeedCommit,
    FORK_TIP_COMMIT,
  ]);
  feedForkTip = forkTips[2] as string;
  if ((await env.REPO.getByName("bob/cmpfeeds").listRefs()).head === null) {
    await pushRefs(
      "bob/cmpfeeds",
      [
        { ref: "refs/heads/main", oid: forkTips[1] as string },
        { ref: "refs/heads/feature/fork", oid: feedForkTip },
      ],
      forkPack,
      forkToken,
    );
  }
  let forkRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "bob"), eq(repositories.slug, "cmpfeeds")))
    .get();
  if (forkRow === undefined) {
    forkRow = await new RepoService(env.DB).create({
      owner: { id: feedBob.id, usernameLower: "bob" },
      name: "cmpfeeds",
      isPrivate: false,
      status: "ready",
    });
  }
  if (forkRow.visibility !== "public") {
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, forkRow.id));
  }
  if (forkRow.forkParent !== row.id) {
    await db.update(repositories).set({ forkParent: row.id }).where(eq(repositories.id, forkRow.id));
  }

  // The private fork: an EMPTY ready row (the read grant misses before any
  // engine read — no git content needed).
  let privForkRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "bob"), eq(repositories.slug, "cmpfeedspriv")))
    .get();
  if (privForkRow === undefined) {
    privForkRow = await new RepoService(env.DB).create({
      owner: { id: feedBob.id, usernameLower: "bob" },
      name: "cmpfeedspriv",
      isPrivate: true,
      status: "ready",
    });
  }
  await db.update(repositories).set({ visibility: "private" }).where(eq(repositories.id, privForkRow.id));
  if (privForkRow.forkParent !== row.id) {
    await db.update(repositories).set({ forkParent: row.id }).where(eq(repositories.id, privForkRow.id));
  }

  // The rows: PR #1 open (its head ref IS pushed), PR #2 broken (head branch
  // missing → no refs/pull/2/head → the broken-PR arm), issue #3 non-pull.
  const existing = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, row.id)).limit(1).get();
  if (existing === undefined) {
    const svc = new IssuesService(env.DB);
    await svc.createPullRequest({
      repoId: row.id,
      title: "cmpfeeds: the open pull",
      content: "Two commits ahead of main.",
      posterId: alice.id,
      headRepoId: row.id,
      baseBranch: "main",
      headBranch: "topic",
      now: new Date((T0 + 190) * 1000),
    });
    await svc.createPullRequest({
      repoId: row.id,
      title: "cmpfeeds: the broken pull",
      content: "Head branch never pushed.",
      posterId: alice.id,
      headRepoId: row.id,
      baseBranch: "main",
      headBranch: "ghost-branch",
      now: new Date((T0 + 200) * 1000),
    });
    await svc.createIssue({
      repoId: row.id,
      title: "cmpfeeds: the plain issue",
      posterId: alice.id,
      now: new Date((T0 + 210) * 1000),
    });
  }
  return { tips, lonelyTip: lonely.tips[0] as string };
}

let feedTips: string[] | null = null;
let feedLonelyTip: string | null = null;
/** The fork fixture's divergent tip and owner row (the fork-form arms). */
let feedForkTip: string | null = null;
let feedBob: { id: number } | null = null;

function tips(): string[] {
  if (feedTips === null) throw new Error("fixtures not seeded");
  return feedTips;
}

function lonelyTip(): string {
  if (feedLonelyTip === null) throw new Error("fixtures not seeded");
  return feedLonelyTip;
}

function forkTip(): string {
  if (feedForkTip === null) throw new Error("fixtures not seeded");
  return feedForkTip;
}

/** The fork owner's session viewer (the plumbed-call shape of the loader). */
function bobViewer(): { kind: "user"; id: number; username: string; isAdmin: boolean } {
  if (feedBob === null) throw new Error("fixtures not seeded");
  return { kind: "user", id: feedBob.id, username: "bob", isAdmin: false };
}

/** The loader's repo subset over the seeded row. */
async function feedRepo() {
  const row =
    (await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "cmpfeeds")))
      .get()) ?? null;
  if (row === null) throw new Error("cmpfeeds repo row missing");
  return { ownerNamespace: row.ownerNamespace, slug: row.slug, isEmpty: row.isEmpty, defaultBranch: row.defaultBranch };
}

beforeAll(async () => {
  const seeded = await ensureCmpFeedsRepo();
  feedTips = seeded.tips;
  feedLonelyTip = seeded.lonelyTip;
});

// --- the pure grammars ---------------------------------------------------------

describe("parseCompareFeedTail (the router's suffix strip)", () => {
  it("strips one literal lowercase suffix, .diff first", () => {
    expect(parseCompareFeedTail("main...topic.diff")).toEqual({ basehead: "main...topic", ext: "diff" });
    expect(parseCompareFeedTail("main...topic.patch")).toEqual({ basehead: "main...topic", ext: "patch" });
    // One strip only: the remaining suffix rides the ref (upstream's
    // mutually-exclusive MatchPath regexes).
    expect(parseCompareFeedTail("x.patch.diff")).toEqual({ basehead: "x.patch", ext: "diff" });
    expect(parseCompareFeedTail("x.diff.patch")).toEqual({ basehead: "x.diff", ext: "patch" });
    // A bare tail is the compare PAGE's claim, not this family.
    expect(parseCompareFeedTail("main...topic")).toBeNull();
    // The suffix is case-sensitive (upstream's pattern miss → the catch-all).
    expect(parseCompareFeedTail("main...topic.DIFF")).toBeNull();
    expect(parseCompareFeedTail(".diff")).toEqual({ basehead: "", ext: "diff" });
  });
});

describe("parseCompareBaseHead (ParseCompareRouterParam reduced)", () => {
  it("splits on the first ... then .., else the whole tail is the head", () => {
    expect(parseCompareBaseHead("main...topic")).toEqual({
      base: "main",
      head: "topic",
      separator: "...",
      headOwner: null,
      headRepoName: null,
    });
    expect(parseCompareBaseHead("main..topic")).toEqual({
      base: "main",
      head: "topic",
      separator: "..",
      headOwner: null,
      headRepoName: null,
    });
    expect(parseCompareBaseHead("topic")).toEqual({
      base: null,
      head: "topic",
      separator: "...",
      headOwner: null,
      headRepoName: null,
    });
    // Empty sides fall back to the default branch (util.IfZero).
    expect(parseCompareBaseHead("...topic")).toEqual({
      base: null,
      head: "topic",
      separator: "...",
      headOwner: null,
      headRepoName: null,
    });
    expect(parseCompareBaseHead("main...")).toEqual({
      base: "main",
      head: null,
      separator: "...",
      headOwner: null,
      headRepoName: null,
    });
    expect(parseCompareBaseHead("")).toEqual({
      base: null,
      head: null,
      separator: "...",
      headOwner: null,
      headRepoName: null,
    });
  });

  it("parses the head-side fork forms (the route parser's grammar, parseHead)", () => {
    // Grammar form 2: the bare `{owner}:{ref}` head (the fork edge decides
    // the repo at load); form 3: the explicit `{owner}/{repo}:{ref}` head.
    expect(parseCompareBaseHead("other:topic")).toEqual({
      base: null,
      head: "topic",
      separator: "...",
      headOwner: "other",
      headRepoName: null,
    });
    expect(parseCompareBaseHead("other/repo:topic")).toEqual({
      base: null,
      head: "topic",
      separator: "...",
      headOwner: "other",
      headRepoName: "repo",
    });
    expect(parseCompareBaseHead("main...other:topic")).toEqual({
      base: "main",
      head: "topic",
      separator: "...",
      headOwner: "other",
      headRepoName: null,
    });
    // The two-dot separator carries the fork forms too.
    expect(parseCompareBaseHead("main..other:topic")).toEqual({
      base: "main",
      head: "topic",
      separator: "..",
      headOwner: "other",
      headRepoName: null,
    });
    // The empty-part folds (GetHeadOwnerAndRepo's empty-string branches):
    // an empty repo name is the bare fork form, an empty owner the bare
    // single-ref form.
    expect(parseCompareBaseHead("main...other/:feature")).toEqual({
      base: "main",
      head: "feature",
      separator: "...",
      headOwner: "other",
      headRepoName: null,
    });
    expect(parseCompareBaseHead(":feature")).toEqual({
      base: null,
      head: "feature",
      separator: "...",
      headOwner: null,
      headRepoName: null,
    });
    // A repo part with no owner (`/{repo}:{ref}`) is upstream's
    // unsupported-syntax invalid-argument → null (the 404 class); the BASE
    // part never carries a fork form (parseHead is head-only); dotted parts
    // stay refname impossibilities.
    expect(parseCompareBaseHead("main.../repo:feature")).toBeNull();
    expect(parseCompareBaseHead("other:main...feature")).toBeNull();
    expect(parseCompareBaseHead("ma..in...topic")).toBeNull();
    expect(parseCompareBaseHead("main...to..pic")).toBeNull();
  });
});

describe("parsePullFilesRange (web.go:1672's pattern)", () => {
  it("admits lowercase 7..64 hex pairs around a literal ..", () => {
    expect(parsePullFilesRange("aaaaaaa..bbbbbbb")).toEqual({ from: "aaaaaaa", to: "bbbbbbb" });
    const s64 = "a".repeat(64);
    expect(parsePullFilesRange(`${s64}..${"b".repeat(64)}`)).toEqual({ from: s64, to: "b".repeat(64) });
    expect(parsePullFilesRange(`${"a".repeat(6)}..bbbbbbb`)).toBeNull(); // too short
    expect(parsePullFilesRange(`${"a".repeat(65)}..bbbbbbb`)).toBeNull(); // too long
    expect(parsePullFilesRange("AAAAAAA..bbbbbbb")).toBeNull(); // lowercase only
    expect(parsePullFilesRange("aaaaaaa.BBBBBBB")).toBeNull(); // one dot
    expect(parsePullFilesRange("aaaaaaa...bbbbbbb")).toBeNull(); // three dots is the compare grammar
    expect(parsePullFilesRange("aaaaaaa..bbbbbbb..ccccccc")).toBeNull(); // anchored
    expect(parsePullFilesRange("aaaaaaa..")).toBeNull();
    expect(parsePullFilesRange("..bbbbbbb")).toBeNull();
  });
});

// --- surface (a)/(b): the compare downloads ------------------------------------

describe("loadCompareFeed .diff arms (compare.go:593-603)", () => {
  it("renders the merge-base diff for ... and byte-equal direct diff for .. in a linear range", async () => {
    const repo = await feedRepo();
    const dots = await loadCompareFeed(env, repo, "main...topic.diff", "diff");
    const dots2 = await loadCompareFeed(env, repo, "main..topic.diff", "diff");
    const body = feedBody(dots);
    // Merge base of main/topic is main's tip here, so both separators diff
    // c1→c3: the two added files, additions only.
    expect(body).toContain("diff --git a/src/app.ts b/src/app.ts");
    expect(body).toContain("diff --git a/docs/notes.md b/docs/notes.md");
    expect(body).toContain("+console.log");
    expect(body).toContain("+# cmpfeeds notes");
    expect(body).not.toContain("-console.log");
    expect(feedBody(dots2)).toBe(body);
  });

  it("keeps the separator semantics apart when the tips cross", async () => {
    const repo = await feedRepo();
    // topic...main: merge base = main's tip → the diff is c1→c1 = EMPTY.
    expect(await loadCompareFeed(env, repo, "topic...main.diff", "diff")).toEqual({ kind: "body", body: "" });
    // topic..main: the DIRECT diff c3→c1 — the range REVERSED.
    const two = await loadCompareFeed(env, repo, "topic..main.diff", "diff");
    expect(feedBody(two)).toContain("-console.log");
    // The unrelated pair rides the DIRECT arm (.. never consults the merge
    // base): lonely's tree (orphan.txt) vs main's (README v1) — one deleted,
    // one added file.
    const unrelated = await loadCompareFeed(env, repo, `lonely..main.diff`, "diff");
    const unrelatedBody = feedBody(unrelated);
    expect(unrelatedBody).toContain("-cmpfeeds lonely");
    expect(unrelatedBody).toContain("+cmpfeeds v1");
  });

  it("resolves oid sides (7..64-hex) through the same grammar", async () => {
    const repo = await feedRepo();
    const c2 = tips()[2] as string;
    const feed = await loadCompareFeed(env, repo, `main...${c2}.diff`, "diff");
    const body = feedBody(feed);
    expect(body).toContain("src/app.ts");
    expect(body).not.toContain("docs/notes.md");
  });
});

describe("loadCompareFeed .patch arms (compare.go:596, repo_compare.go:74-77)", () => {
  it("renders the head-anchored mail block with the signature tail", async () => {
    const repo = await feedRepo();
    const c3 = tips()[TOPIC_TIP] as string;
    const feed = await loadCompareFeed(env, repo, "main..topic.patch", "patch");
    const body = feedBody(feed);
    expect(body.startsWith(`From ${c3} Mon Sep 17 00:00:00 2001\n`)).toBe(true);
    expect(body).toContain("Subject: [PATCH] cmpfeeds: c3 notes");
    expect(body).toContain("+console.log");
    expect(body.endsWith("-- \n2.47.0\n")).toBe(true);
  });

  it("answers the zero-mail ranges with an EMPTY body (format-patch's shape)", async () => {
    const repo = await feedRepo();
    // ... with identical tips: the symmetric difference is empty.
    expect(await loadCompareFeed(env, repo, "main...main.patch", "patch")).toEqual({ kind: "body", body: "" });
    // .. with the head inside the base: no commits in base..head.
    expect(await loadCompareFeed(env, repo, "main..main.patch", "patch")).toEqual({ kind: "body", body: "" });
    expect(await loadCompareFeed(env, repo, "topic..main.patch", "patch")).toEqual({ kind: "body", body: "" });
  });

  it("refuses the no-merge-base ... download with the 500 class", async () => {
    const repo = await feedRepo();
    const lonely = lonelyTip();
    // .diff: upstream's `git diff -p A...B` is fatal without a merge base →
    // ServerError. .patch: upstream succeeds (the symmetric-difference mail
    // series) — the documented refusal divergence (module header).
    expect(await loadCompareFeed(env, repo, `main...${lonely}.diff`, "diff")).toEqual({ kind: "noMergeBase" });
    expect(await loadCompareFeed(env, repo, `main...${lonely}.patch`, "patch")).toEqual({ kind: "noMergeBase" });
  });
});

describe("loadCompareFeed 404 family + response builders", () => {
  it("404s the empty repo, unresolvable sides, and the unclaimed forms", async () => {
    const notFound = { kind: "notFound" };
    // MustBeNotEmpty (web.go:1309-1310) — an empty repo before any parse.
    expect(
      await loadCompareFeed(env, { ownerNamespace: "alice", slug: "cmpfeeds-empty", isEmpty: true, defaultBranch: "main" }, "main...main.diff", "diff"),
    ).toEqual(notFound);
    const repo = await feedRepo();
    expect(await loadCompareFeed(env, repo, "main...ghost.diff", "diff")).toEqual(notFound); // unresolvable side
    expect(await loadCompareFeed(env, repo, "other:topic.diff", "diff")).toEqual(notFound); // fork edge miss (no "other" user row)
    expect(await loadCompareFeed(env, repo, "ma..in...topic.diff", "diff")).toEqual(notFound); // dotted part
    expect(await loadCompareFeed(env, repo, "main...topic", "diff")).toEqual(notFound); // dispatcher drift: no suffix
    expect(await loadCompareFeed(env, repo, "main...topic.diff", "patch")).toEqual(notFound); // ext mismatch
  });

  it("emits the diffpatch sibling's header pair and the plain 500", () => {
    const res = compareFeedTextResponse("body");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    const err = compareFeedServerErrorResponse();
    expect(err.status).toBe(500);
    expect(err.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });
});

// --- the fork-form arms (the cross-repo downloads) -------------------------------

describe("loadCompareFeed fork-form arms (the cross-repo downloads)", () => {
  it("resolves the bare fork edge and diffs in the fork cell", async () => {
    const repo = await feedRepo();
    // The no-viewer call (the mounted dispatcher's shape): the PUBLIC fork
    // passes the anonymous read grant; the shared history (main's tip is the
    // merge base) keeps the walk carry-free, and the diff reads run in the
    // FORK cell (services/git/compare.go:70-89's headGitRepo).
    const feed = await loadCompareFeed(env, repo, "main...bob:feature/fork.diff", "diff");
    const body = feedBody(feed);
    expect(body).toContain("diff --git a/fork-only.md b/fork-only.md");
    expect(body).toContain("+# from the fork");
    expect(body).not.toContain("docs/notes.md"); // the base cell's files never leak
    // The signed-in viewer rides the same grant (the plumbed-call shape).
    expect(await loadCompareFeed(env, repo, "main...bob:feature/fork.diff", "diff", bobViewer())).toEqual(feed);
  });

  it("resolves the explicit owner/repo form and renders the fork's patch mail", async () => {
    const repo = await feedRepo();
    const feed = await loadCompareFeed(env, repo, "main..bob/cmpfeeds:feature/fork.patch", "patch");
    const body = feedBody(feed);
    expect(body.startsWith(`From ${forkTip()} Mon Sep 17 00:00:00 2001\n`)).toBe(true);
    expect(body).toContain("Subject: [PATCH] cmpfeeds: the fork diverges");
    expect(body.endsWith("-- \n2.47.0\n")).toBe(true);
  });

  it("folds the same-owner prefix back onto the base repo (GetHeadOwnerAndRepo's fold)", async () => {
    const repo = await feedRepo();
    expect(await loadCompareFeed(env, repo, "main...alice:topic.diff", "diff")).toEqual(
      await loadCompareFeed(env, repo, "main...topic.diff", "diff"),
    );
    expect(await loadCompareFeed(env, repo, "main...alice/cmpfeeds:topic.diff", "diff")).toEqual(
      await loadCompareFeed(env, repo, "main...topic.diff", "diff"),
    );
  });

  it("404s the unreadable private fork head (the §2.5 grant) and the unresolvable fork side", async () => {
    const repo = await feedRepo();
    const notFound = { kind: "notFound" };
    // No viewer rides the anonymous grant — the PRIVATE fork is invisible
    // (compare.go:182-189's permHead.CanRead miss, the not-exist shell).
    expect(await loadCompareFeed(env, repo, "main...bob/cmpfeedspriv:main.diff", "diff")).toEqual(notFound);
    // The owner viewer passes the grant, then the EMPTY fork's unborn head
    // misses at resolution — the same 404 shell, the honest arm.
    expect(await loadCompareFeed(env, repo, "main...bob/cmpfeedspriv:main.diff", "diff", bobViewer())).toEqual(notFound);
    // A fork-resolved head naming no ref in the fork cell misses too.
    expect(await loadCompareFeed(env, repo, "main...bob:ghost.diff", "diff")).toEqual(notFound);
  });
});

// --- surface (c): the pull-files range -----------------------------------------

/** The hono context the range loader takes (the diffpatch re-wrap). */
function rangeContext(): Context<{ Bindings: Env }> {
  return new Context(new Request("https://test.local/alice/cmpfeeds/pulls/1/files/aaaaaaaaaa..bbbbbbbbbb"), { env });
}

describe("resolvePullFilesRange (pull.go:707-731's admission arms)", () => {
  it("admits the half-open (base, head] list plus the head, and the list plus the base", async () => {
    const repo = await feedRepo();
    const [c1, c2, c3] = tips().slice(1) as [string, string, string];
    const reads = engineReads(env, repo);
    const refs = { base: c1, head: c3 };
    expect(await resolvePullFilesRange(reads, refs, c2, c3)).toEqual({ before: c2, after: c3 }); // list pair
    expect(await resolvePullFilesRange(reads, refs, c1, c3)).toEqual({ before: c1, after: c3 }); // before = merge base
    expect(await resolvePullFilesRange(reads, refs, c3, c3)).toEqual({ before: c3, after: c3 }); // same ref
    expect(await resolvePullFilesRange(reads, refs, c3, c2)).toEqual({ before: c3, after: c2 }); // reversed renders
    expect(await resolvePullFilesRange(reads, refs, c2, c1)).toBeNull(); // after = merge base: the half-open miss
    expect(await resolvePullFilesRange(reads, refs, "abc1234", c3)).toBeNull(); // short prefix never equals a full oid
    expect(await resolvePullFilesRange(reads, refs, c2, "0000000")).toBeNull(); // unknown endpoint
  });
});

describe("loadPullFilesRange + the range page render", () => {
  it("loads the range diff and renders the tplPullFiles DOM over it", async () => {
    const row =
      (await drizzle(env.DB)
        .select()
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "cmpfeeds")))
        .get()) ?? null;
    if (row === null) throw new Error("cmpfeeds repo row missing");
    const c2 = tips()[2] as string;
    const data = await loadPullFilesRange(rangeContext(), row.id, 1, `${c2}..${tips()[3] as string}`);
    expect(data).not.toBeNull();
    if (data === null) return;
    expect(data.before).toBe(c2);
    expect(data.issue.index).toBe(1);
    expect(data.issue.isPull).toBe(true);
    // c2..c3 is exactly c3's own change: the notes file added.
    expect(data.files.map((view) => view.file.path)).toEqual(["docs/notes.md"]);
    expect(data.totalAddition).toBeGreaterThan(0);

    const ctx: UiContext = {
      viewer: { kind: "anonymous" },
      origin: "https://test.local",
      assets: shellAssetsFromManifest(manifest),
      repo: row,
    };
    const html = renderPullFilesRangePage({ ctx, data });
    expect(html).toContain("repository view issue pull files diff");
    expect(html).toContain("#1 - cmpfeeds: the open pull");
    expect(html).toContain("diff-file-box");
    expect(html).toContain("docs/notes.md");
  });

  it("renders the empty range as DiffNotAvailable and 404s the broken arms", async () => {
    const row =
      (await drizzle(env.DB)
        .select()
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "cmpfeeds")))
        .get()) ?? null;
    if (row === null) throw new Error("cmpfeeds repo row missing");
    const c2 = tips()[2] as string;
    // Same-ref range: the empty diff → upstream's DiffNotAvailable render.
    const same = await loadPullFilesRange(rangeContext(), row.id, 1, `${c2}..${c2}`);
    expect(same).not.toBeNull();
    if (same === null) return;
    const ctx: UiContext = {
      viewer: { kind: "anonymous" },
      origin: "https://test.local",
      assets: shellAssetsFromManifest(manifest),
      repo: row,
    };
    expect(renderPullFilesRangePage({ ctx, data: same })).toContain("Diff Content Not Available");

    // Grammar miss → the 404 family.
    expect(await loadPullFilesRange(rangeContext(), row.id, 1, "ZZZZZZZ..bbbbbbb")).toBeNull();
    // PR #2's head ref never landed → the broken-PR arm (pull.go:697-700).
    expect(await loadPullFilesRange(rangeContext(), row.id, 2, `${c2}..${c2}`)).toBeNull();
    // The non-pull row (issue #3) — the family's no-redirect divergence.
    expect(await loadPullFilesRange(rangeContext(), row.id, 3, `${c2}..${c2}`)).toBeNull();
    // Missing row.
    expect(await loadPullFilesRange(rangeContext(), row.id, 99, `${c2}..${c2}`)).toBeNull();
  });
});
