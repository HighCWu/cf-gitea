/**
 * The pull-files family's DEFERRED route-level matrix (the polish wave for
 * window-2e B2's NOW-MOUNTED surfaces, driven over the mounted uiRouter on
 * the compare.matrix minted-session pattern — the execution context is
 * awaited, fixtures seeded through the REAL receive flow):
 *
 *   - GET /{owner}/{repo}/pulls/{index}/files/{a}..{b}   pages/compare-feeds'
 *     `pull-files-range` family (pullFilesRangeRoute);
 *   - GET /{owner}/{repo}/pulls/{index}/commits/{sha}    pages/
 *     pull-files-single-commit's `pull-commit-files` family
 *     (pullCommitFilesRoute — upstream's web.go:1663 path; the `/files/{sha}`
 *     single tail is upstream's pattern miss and stays UNclaimed, the
 *     b48757e divergence);
 *   - GET /{owner}/{repo}/pulls/{index}/merge_box        pages/pull-merge-box's
 *     `pull-merge-box` fragment family (pullMergeBoxRoute).
 *
 * The MODULE suites own the deep arms and are NOT repeated here:
 * compare-feeds.test.tsx owns the range grammar, resolvePullFilesRange's
 * admission table and loadPullFilesRange's render/DiffNotAvailable/404
 * halves; pull-files-single-commit.smoke.test.ts owns the single-commit
 * happy path and the root-commit divergence at the loader; pull-merge-box
 * .test.tsx owns the loader's state→projection matrix and the fragment's
 * DOM contract. THIS file adds only the arms only the MOUNT can answer:
 *
 *   - the claim pins: the three parses ride their families, while the
 *     `/files/{sha}` single tail, the range segment under /commits and the
 *     UPPERCASE hex forms stay unclaimed → the 404 shell (the mounted
 *     consequence of the parser nulls the module suites pin);
 *   - the viewer gates on a PRIVATE repo: anonymous and signed-in-stranger
 *     404 shells on all three GETs (existence hidden), the signed-in owner's
 *     200 renders;
 *   - the route-level admission 404 family over REAL engine content: the
 *     short prefix, the merge-base AFTER side (the before side admits — the
 *     full-range contrast), the out-of-list root, the non-pull row, and the
 *     BROKEN PR (refs/pull/N/head unresolvable);
 *   - the render arms the mission names: the REVERSED pair's inverted diff
 *     beside the forward pair's stats, and the DiffNotAvailable arms
 *     (same-ref range, root-commit single at the route);
 *   - the merge-box route arms: the merged PR's EMPTY-200 stop signal with
 *     the exact fragment Response shape, the closed-unmerged render, and
 *     the open PR's fragment mount (no page chrome);
 *   - the cross-origin n/a: all three surfaces are GETs — a foreign Origin
 *     header renders identically (no same-origin guard on reads).
 */

import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { issues, PRStatus, pullRequests, repositories, users } from "../../db/schema";
import { settleCreatingRepo } from "../../git-http/gate";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import type { UiManifest } from "../manifest";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";

// wave-129 full-run contention budget: this file's beforeAll seeding (the
// receive-flow w111* fixture family) measured a 4.68s hook share of the 30s
// default IN a green 8-worker full run (the suite's 260-isolate spawn storm
// spikes closures up to ~12x their solo time). File-local 90s budgets;
// vitest.config.ts keeps 30s for every other file. Membership: the measured
// >=4s in-run closure/hook set (full-suite junit run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// --- the minted-session route harness (the compare.matrix pattern) ---------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → resolveUiRequest →
 *  the family handler → load → render, on the mounted uiRouter with the
 *  synthetic manifest; the execution context is awaited. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie for the fixture user (the value is never
 *  asserted — minted per call like the compare.matrix helper). */
async function cookieFor(username: string): Promise<string> {
  const user = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, username)).get();
  if (user === undefined) throw new Error(`w111 fixture user missing: ${username}`);
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, user.id)}`;
}

/** Anonymous GET (cookie omitted) or a minted-session GET. */
async function get(path: string, as?: string): Promise<Response> {
  return fetchUi(path, as === undefined ? undefined : { headers: { cookie: await cookieFor(as) } });
}

// --- fixtures -------------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — fixed, deterministic oids

const OWNER = "w111gal";
const STRANGER = "w111pal";

/** Four fixed commits: tips[0] root, tips[1] main's tip (the PR merge base),
 *  tips[2]/tips[3] the topic range. Every commit carries its FULL tree (the
 *  seed builder's convention) and adds exactly one file, so every pair's
 *  diff is a single named file: c2 adds f2.txt, c3 adds f3.txt. */
const W111_COMMITS: SeedCommit[] = [
  { message: "w111: seed root", time: T0, files: [{ path: "f0.txt", content: "w111 root\n" }] },
  {
    message: "w111: main tip",
    time: T0 + 60,
    files: [
      { path: "f0.txt", content: "w111 root\n" },
      { path: "f1.txt", content: "w111 one\n" },
    ],
  },
  {
    message: "w111: mid change",
    time: T0 + 120,
    files: [
      { path: "f0.txt", content: "w111 root\n" },
      { path: "f1.txt", content: "w111 one\n" },
      { path: "f2.txt", content: "w111 two\n" },
    ],
  },
  {
    message: "w111: tail change",
    time: T0 + 180,
    files: [
      { path: "f0.txt", content: "w111 root\n" },
      { path: "f1.txt", content: "w111 one\n" },
      { path: "f2.txt", content: "w111 two\n" },
      { path: "f3.txt", content: "w111 three\n" },
    ],
  },
];

const MAIN_TIP = 1;
const MID = 2;
const TOPIC_TIP = 3;

/** An UNRELATED root (no merge base with the linear history) — the lonely
 *  PR's head, reaching the single-commit page through the head escape. */
const LONELY_COMMITS: SeedCommit[] = [
  { message: "w111: lonely root", time: T0 + 240, files: [{ path: "lonely.txt", content: "w111 lonely\n" }] },
];

/** The wave-129 batch-9 RENAME+BINARY arm's commit — tips[4] atop the linear
 *  history (tips[0..3] stay byte-identical, so every existing oid holds): it
 *  DELETES f2.txt and adds f2-renamed.txt with the same content (the engine
 *  has no rename detection — git without -M — so the pair renders as a
 *  removed+added pair under their own paths) and adds a BINARY file (a NUL
 *  byte inside the first 8000 bytes is the engine's isBinary probe,
 *  git-engine git/diff.ts:145). */
const BINARM_COMMITS: SeedCommit[] = [
  ...W111_COMMITS,
  {
    message: "w111: rename+binary arm",
    time: T0 + 300,
    files: [
      { path: "f0.txt", content: "w111 root\n" },
      { path: "f1.txt", content: "w111 one\n" },
      { path: "f2-renamed.txt", content: "w111 two\n" },
      { path: "f3.txt", content: "w111 three\n" },
      { path: "bin/logo.bin", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x1a, 0x00, 0x00]) },
    ],
  },
];

/** The wave-129 batch-13 EDIT arm — tips[4]+tips[5] atop the linear history
 *  (tips[0..3] stay byte-identical, so every existing oid holds): tips[4]
 *  grows f1.txt from the one-line seed to nine lines, tips[5] then flips its
 *  FIRST and LAST lines while the middle seven stay put. tips[5]'s parent
 *  diff is the op stream del,add, eq×7, del,add — the two change clusters sit
 *  8 ops apart, past toHunks' 2×context(3) merge rule (git/diff.ts:105), so
 *  the commit page renders TWO hunks with real eq context — the shape the
 *  unified numbering grammar needs (left counts eq+del, right counts eq+add).
 *  (Two commits because the grammar needs a MODIFIED file with shared middle
 *  lines: the PR range page's merge-base diff against the one-line seed has
 *  none — it collapses to the single del+add hunk wave 5's family owns.) */
const EDITARM_COMMITS: SeedCommit[] = [
  ...W111_COMMITS,
  {
    message: "w111: grow f1 to nine lines",
    time: T0 + 360,
    files: [
      { path: "f0.txt", content: "w111 root\n" },
      { path: "f1.txt", content: "one-1\none-2\none-3\none-4\none-5\none-6\none-7\none-8\none-9\n" },
      { path: "f2.txt", content: "w111 two\n" },
      { path: "f3.txt", content: "w111 three\n" },
    ],
  },
  {
    message: "w111: edit f1 both ends",
    time: T0 + 420,
    files: [
      { path: "f0.txt", content: "w111 root\n" },
      { path: "f1.txt", content: "edit-1\none-2\none-3\none-4\none-5\none-6\none-7\none-8\nedit-9\n" },
      { path: "f2.txt", content: "w111 two\n" },
      { path: "f3.txt", content: "w111 three\n" },
    ],
  },
];

interface World {
  /** tips[0], tips[MAIN_TIP], tips[MID], tips[TOPIC_TIP] (BINARM's tips[4],
   *  EDITARM's tips[5] — distinct commits over the shared prefix). */
  root: string;
  mainTip: string;
  mid: string;
  topicTip: string;
  lonelyTip: string;
  binTip: string;
  editTip: string;
  /** The per-repo index allocation (one shared issue/PR sequence), captured
   *  at creation — never hardcoded. */
  pull: { topic: number; merged: number; closed: number; lonely: number; plainIssue: number; binarm: number; editarm: number };
  priv: number;
}

let world: World | null = null;

function w(): World {
  if (world === null) throw new Error("fixtures not seeded");
  return world;
}

async function pushRefs(
  repoName: string,
  updates: { ref: string; oid: string }[],
  pack: Uint8Array,
  token: string,
): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`w111 seed push failed (${repoName}): ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** The repo D1 row: create-or-settle, then the visibility / defaultBranch
 *  pins (the compare.matrix recipe, pushless — refs land after the PR rows
 *  own their indexes). */
async function ensureRepoRow(slug: string, isPrivate: boolean, ownerId: number): Promise<void> {
  const db = drizzle(env.DB);
  const repoName = `${OWNER}/${slug}`;
  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, slug)))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: ownerId, usernameLower: OWNER },
      name: slug,
      isPrivate,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, row.id, repoName);
    row = (await db.select().from(repositories).where(eq(repositories.id, row.id)).get()) ?? row;
  }
  const wantVisibility = isPrivate ? "private" : "public";
  if (row.visibility !== wantVisibility) {
    await db.update(repositories).set({ visibility: wantVisibility }).where(eq(repositories.id, row.id));
  }
  if (row.defaultBranch !== "main") {
    await db.update(repositories).set({ defaultBranch: "main" }).where(eq(repositories.id, row.id));
  }
}

async function repoIdOf(slug: string): Promise<string> {
  const row = await drizzle(env.DB)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, slug)))
    .get();
  if (row === undefined) throw new Error(`w111 repo row missing: ${slug}`);
  return row.id;
}

/** Idempotent PR/issue seeding for one repo: create-or-capture the row
 *  indexes, stamping each extension row with the test's state on the create
 *  path only (the stamps are re-runnable, the creations are not). */
async function seedPulls(ownerId: number): Promise<{ pull: World["pull"]; priv: number }> {
  const db = drizzle(env.DB);
  const svc = new IssuesService(env.DB);
  const now = new Date((T0 + 190) * 1000);

  const pullId = await repoIdOf("w111pull");
  const fresh = (await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, pullId)).limit(1).get()) === undefined;
  const pull: World["pull"] = { topic: 0, merged: 0, closed: 0, lonely: 0, plainIssue: 0, binarm: 0, editarm: 0 };
  if (fresh) {
    const topic = await svc.createPullRequest({
      repoId: pullId,
      title: "w111: the open pull",
      content: "Two commits ahead of main.",
      posterId: ownerId,
      headRepoId: pullId,
      baseBranch: "main",
      headBranch: "topic",
      now,
    });
    pull.topic = topic.issue.index;
    await db
      .update(pullRequests)
      .set({ status: PRStatus.Mergeable })
      .where(eq(pullRequests.id, topic.pullRequest.id));

    const merged = await svc.createPullRequest({
      repoId: pullId,
      title: "w111: the merged pull",
      content: "Has landed.",
      posterId: ownerId,
      headRepoId: pullId,
      baseBranch: "main",
      headBranch: "merged-branch",
      now,
    });
    pull.merged = merged.issue.index;
    await db
      .update(pullRequests)
      .set({ status: PRStatus.Mergeable, hasMerged: true, mergedCommitId: "f".repeat(40), mergerId: ownerId })
      .where(eq(pullRequests.id, merged.pullRequest.id));

    const closed = await svc.createPullRequest({
      repoId: pullId,
      title: "w111: the closed pull",
      content: "Closed without merging.",
      posterId: ownerId,
      headRepoId: pullId,
      baseBranch: "main",
      headBranch: "closed-branch",
      now,
    });
    pull.closed = closed.issue.index;
    await db.update(pullRequests).set({ status: PRStatus.Mergeable }).where(eq(pullRequests.id, closed.pullRequest.id));
    await svc.closeIssue(closed.issue.id, { actorId: ownerId, now });

    const lonely = await svc.createPullRequest({
      repoId: pullId,
      title: "w111: the lonely pull",
      content: "Head is an unrelated root commit.",
      posterId: ownerId,
      headRepoId: pullId,
      baseBranch: "main",
      headBranch: "lonely",
      now,
    });
    pull.lonely = lonely.issue.index;

    const plain = await svc.createIssue({ repoId: pullId, title: "w111: the plain issue", posterId: ownerId, now });
    pull.plainIssue = plain.index;

    // The wave-129 batch-9 rename+binary pull: head at the BINARM tip
    // (refs/heads/binarm — pushed below), base main.
    const binarm = await svc.createPullRequest({
      repoId: pullId,
      title: "w111: the rename+binary pull",
      content: "Deletes f2.txt under a new name and adds a binary file.",
      posterId: ownerId,
      headRepoId: pullId,
      baseBranch: "main",
      headBranch: "binarm",
      now,
    });
    pull.binarm = binarm.issue.index;

    // The wave-129 batch-13 edit pull: head at the EDITARM tip
    // (refs/heads/editarm — pushed below), base main; its diff is the
    // single modified f1.txt (two hunks).
    const editarm = await svc.createPullRequest({
      repoId: pullId,
      title: "w111: the edit pull",
      content: "Edits both ends of f1.txt.",
      posterId: ownerId,
      headRepoId: pullId,
      baseBranch: "main",
      headBranch: "editarm",
      now,
    });
    pull.editarm = editarm.issue.index;
    await db
      .update(pullRequests)
      .set({ status: PRStatus.Mergeable })
      .where(eq(pullRequests.id, editarm.pullRequest.id));
  } else {
    // Re-run against a seeded world: re-read the allocated indexes by title.
    const rows = await db.select({ index: issues.index, title: issues.title }).from(issues).where(eq(issues.repoId, pullId)).all();
    const indexByTitle = new Map(rows.map((row) => [row.title, row.index]));
    const idx = (title: string): number => {
      const found = indexByTitle.get(title);
      if (found === undefined) throw new Error(`w111 fixture issue missing: ${title}`);
      return found;
    };
    pull.topic = idx("w111: the open pull");
    pull.merged = idx("w111: the merged pull");
    pull.closed = idx("w111: the closed pull");
    pull.lonely = idx("w111: the lonely pull");
    pull.plainIssue = idx("w111: the plain issue");
    pull.binarm = idx("w111: the rename+binary pull");
    pull.editarm = idx("w111: the edit pull");
  }

  const privId = await repoIdOf("w111priv");
  const privRows = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, privId)).limit(1).get();
  let priv: number;
  if (privRows === undefined) {
    const privPr = await svc.createPullRequest({
      repoId: privId,
      title: "w111: the private pull",
      content: "Behind the visibility gate.",
      posterId: ownerId,
      headRepoId: privId,
      baseBranch: "main",
      headBranch: "topic",
      now,
    });
    priv = privPr.issue.index;
    await db
      .update(pullRequests)
      .set({ status: PRStatus.Mergeable })
      .where(eq(pullRequests.id, privPr.pullRequest.id));
  } else {
    const row = await db.select({ index: issues.index }).from(issues).where(eq(issues.repoId, privId)).get();
    priv = row!.index;
  }

  const brokenId = await repoIdOf("w111broken");
  const brokenRows = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, brokenId)).limit(1).get();
  if (brokenRows === undefined) {
    // NO refs/pull/N/head is ever pushed for this one — the broken PR.
    await svc.createPullRequest({
      repoId: brokenId,
      title: "w111: the broken pull",
      content: "Its head ref never landed.",
      posterId: ownerId,
      headRepoId: brokenId,
      baseBranch: "main",
      headBranch: "topic",
      now,
    });
  }

  return { pull, priv };
}

async function ensureFixtures(): Promise<void> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get()) === undefined) {
    await seedVerifiedUser({ username: OWNER });
  }
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, STRANGER)).get()) === undefined) {
    await seedVerifiedUser({ username: STRANGER });
  }
  const ownerId = (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get())!.id;

  await ensureRepoRow("w111pull", false, ownerId);
  await ensureRepoRow("w111priv", true, ownerId);
  await ensureRepoRow("w111broken", false, ownerId);

  const seeded = await seedPulls(ownerId);

  // The engine content: the linear pack (main + topic) per repo, the PR
  // head refs where they exist, and the lonely pack for w111pull only.
  const { tips, pack } = await buildHistoryPack(W111_COMMITS);
  const lonely = await buildHistoryPack(LONELY_COMMITS);
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(ownerId, "w111-seed")
    .run();
  const token = (await mintFor(ownerId, "w111-seed", "write:repository")).plaintext;
  for (const slug of ["w111pull", "w111priv", "w111broken"]) {
    const repoName = `${OWNER}/${slug}`;
    const refs = await env.REPO.getByName(repoName).listRefs();
    if (refs.head !== null) continue;
    const updates = [
      { ref: "refs/heads/main", oid: tips[MAIN_TIP] as string },
      { ref: "refs/heads/topic", oid: tips[TOPIC_TIP] as string },
    ];
    if (slug === "w111pull") {
      updates.push({ ref: `refs/pull/${seeded.pull.topic}/head`, oid: tips[TOPIC_TIP] as string });
    } else if (slug === "w111priv") {
      updates.push({ ref: `refs/pull/${seeded.priv}/head`, oid: tips[TOPIC_TIP] as string });
    } // w111broken: the PR's head ref never lands — the broken-PR world.
    await pushRefs(repoName, updates, pack, token);
  }
  const pullRefs = await env.REPO.getByName(`${OWNER}/w111pull`).listRefs();
  if (!pullRefs.refs.some((ref) => ref.name === "refs/heads/lonely")) {
    await pushRefs(
      `${OWNER}/w111pull`,
      [
        { ref: "refs/heads/lonely", oid: lonely.tips[0] as string },
        { ref: `refs/pull/${seeded.pull.lonely}/head`, oid: lonely.tips[0] as string },
      ],
      lonely.pack,
      token,
    );
  }

  // The wave-129 batch-9 rename+binary world: the BINARM pack's tips[0..3]
  // are byte-identical to the linear pack's (the shared history), tips[4] is
  // the rename+binary commit — the binarm PR's branch and head ref.
  const binarm = await buildHistoryPack(BINARM_COMMITS);
  if (!pullRefs.refs.some((ref) => ref.name === "refs/heads/binarm")) {
    await pushRefs(
      `${OWNER}/w111pull`,
      [
        { ref: "refs/heads/binarm", oid: binarm.tips[4] as string },
        { ref: `refs/pull/${seeded.pull.binarm}/head`, oid: binarm.tips[4] as string },
      ],
      binarm.pack,
      token,
    );
  }

  // The wave-129 batch-13 edit world: the EDITARM pack's tips[0..3] are
  // byte-identical to the linear pack's (the shared history), tips[5] is the
  // f1.txt edit commit — the editarm PR's branch and head ref.
  const editarmPack = await buildHistoryPack(EDITARM_COMMITS);
  if (!pullRefs.refs.some((ref) => ref.name === "refs/heads/editarm")) {
    await pushRefs(
      `${OWNER}/w111pull`,
      [
        { ref: "refs/heads/editarm", oid: editarmPack.tips[5] as string },
        { ref: `refs/pull/${seeded.pull.editarm}/head`, oid: editarmPack.tips[5] as string },
      ],
      editarmPack.pack,
      token,
    );
  }

  world = {
    root: tips[0] as string,
    mainTip: tips[MAIN_TIP] as string,
    mid: tips[MID] as string,
    topicTip: tips[TOPIC_TIP] as string,
    lonelyTip: lonely.tips[0] as string,
    binTip: binarm.tips[4] as string,
    editTip: editarmPack.tips[5] as string,
    pull: seeded.pull,
    priv: seeded.priv,
  };
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the claim pins (route level) -------------------------------------------------

describe("w111 claim pins (the three mounts and the unclaimed tails)", () => {
  it("claims the range, the /commits single-commit page, and the merge box", () => {
    const base = `/${OWNER}/w111pull/pulls/${w().pull.topic}`;
    expect(parseUiRoute(`${base}/files/${w().mid}..${w().topicTip}`)).toMatchObject({
      family: "pull-files-range",
      index: w().pull.topic,
      segment: `${w().mid}..${w().topicTip}`,
    });
    expect(parseUiRoute(`${base}/commits/${w().mid}`)).toMatchObject({
      family: "pull-commit-files",
      index: w().pull.topic,
      segment: w().mid,
    });
    expect(parseUiRoute(`${base}/merge_box`)).toMatchObject({ family: "pull-merge-box", index: w().pull.topic });
  });

  it("leaves the /files single-sha tail unclaimed (upstream's pattern miss) — the 404", async () => {
    // The documented b48757e divergence: the single-commit page lives at
    // /commits/{sha} only; a bare sha on the /files tail must keep answering
    // the 404, never a render. The hono segment regex DOES match a single
    // sha, so the handler runs and resolveUiSession's parser-null arm serves
    // hono's PLAIN `c.notFound()` body (never the page shell — a path the
    // parser does not claim is not rendered).
    const path = `/${OWNER}/w111pull/pulls/${w().pull.topic}/files/${w().mid}`;
    expect(parseUiRoute(path)).toBeNull();
    const res = await get(path);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("404 Not Found");
    expect(body).not.toContain("<!DOCTYPE html>");
  });

  it("keeps the range grammar and the lowercase-hex class off the other tails", async () => {
    const base = `/${OWNER}/w111pull/pulls/${w().pull.topic}`;
    // The {a}..{b} range under /commits claims nothing...
    const rangeUnderCommits = `${base}/commits/${w().mid}..${w().topicTip}`;
    expect(parseUiRoute(rangeUnderCommits)).toBeNull();
    expect((await get(rangeUnderCommits)).status).toBe(404);
    // ...and the hex class is LOWERCASE only, on both tails.
    const upperSingle = `${base}/commits/${w().topicTip.toUpperCase()}`;
    expect(parseUiRoute(upperSingle)).toBeNull();
    expect((await get(upperSingle)).status).toBe(404);
    const upperRange = `${base}/files/${w().mid.toUpperCase()}..${w().topicTip}`;
    expect(parseUiRoute(upperRange)).toBeNull();
    expect((await get(upperRange)).status).toBe(404);
  });
});

// --- the viewer gates (the private-repo arms) --------------------------------------

describe("w111 viewer gates (the private-repo arms)", () => {
  const shell404 = async (path: string, as?: string): Promise<void> => {
    const res = await get(path, as);
    expect(res.status, path).toBe(404);
    const body = await res.text();
    expect(body, path).toContain("status-page-error"); // the shell — existence hidden
    expect(body, path).not.toContain("w111: the private pull");
  };

  it("404-shells all three surfaces for anonymous and stranger; admits the owner", async () => {
    const base = `/${OWNER}/w111priv/pulls/${w().priv}`;
    const range = `${base}/files/${w().mainTip}..${w().topicTip}`;
    const single = `${base}/commits/${w().mid}`;
    const box = `${base}/merge_box`;
    for (const path of [range, single, box]) {
      await shell404(path);
      await shell404(path, STRANGER); // a session buys no visibility
    }
    // The owner's admissions: the range page, the single-commit page, the
    // fragment.
    const rangeOwner = await get(range, OWNER);
    expect(rangeOwner.status).toBe(200);
    expect(await rangeOwner.text()).toContain("repository view issue pull files diff");
    const singleOwner = await get(single, OWNER);
    expect(singleOwner.status).toBe(200);
    expect(await singleOwner.text()).toContain(`#${w().priv} - w111: the private pull`);
    const boxOwner = await get(box, OWNER);
    expect(boxOwner.status).toBe(200);
    expect(await boxOwner.text()).toContain("pull-merge-box");
  });
});

// --- the committed-range route: admission 404s + the render arms -------------------

describe("w111 committed-range route (admission 404 family + render arms)", () => {
  const range = (from: string, to: string): string =>
    `/${OWNER}/w111pull/pulls/${w().pull.topic}/files/${from}..${to}`;

  it("404s the short prefix, the merge-base AFTER side, and the out-of-list root", async () => {
    // A 7-hex prefix parses but never equals a full oid → the admission miss.
    expect((await get(range(w().topicTip.slice(0, 7), w().topicTip))).status).toBe(404);
    // The merge base is the BEFORE side's own arm (the contrast below); as
    // the AFTER side it is excluded from the half-open (base, head] list and
    // is not the head → the ambiguity 404.
    expect((await get(range(w().mainTip, w().mainTip))).status).toBe(404);
    // The root is an ancestor of the merge base — outside the PR's list on
    // both sides.
    expect((await get(range(w().root, w().topicTip))).status).toBe(404);
    expect((await get(range(w().mid, w().root))).status).toBe(404);
  });

  it("admits the full range (the merge base as the BEFORE side) and renders both files", async () => {
    const res = await get(range(w().mainTip, w().topicTip));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository view issue pull files diff");
    expect(html).toContain("2 changed files"); // c2 + c3: the whole (base, head] range
    expect(html).toContain('data-new-filename="f2.txt"');
    expect(html).toContain('data-new-filename="f3.txt"');
    expect(html).toContain("2 additions"); // the toolbar total: +1 + +1
  });

  it("renders the reversed pair with the diff inverted beside the forward pair", async () => {
    const forward = await get(range(w().mid, w().topicTip));
    expect(forward.status).toBe(200);
    const forwardHtml = await forward.text();
    expect(forwardHtml).toContain("1 changed files");
    expect(forwardHtml).toContain('data-new-filename="f3.txt"');
    expect(forwardHtml).toContain('<strong class="tw-text-diff-added-fg">+1</strong>');
    expect(forwardHtml).toContain("add-code");
    expect(forwardHtml).not.toContain("del-code");

    // The reversed pair admits both sides (both in the list) and renders the
    // REVERSED diff: f3.txt flips from added to removed.
    const reversed = await get(range(w().topicTip, w().mid));
    expect(reversed.status).toBe(200);
    const reversedHtml = await reversed.text();
    expect(reversedHtml).toContain("1 changed files");
    expect(reversedHtml).toContain('data-new-filename="f3.txt"');
    expect(reversedHtml).toContain('<strong class="tw-text-diff-removed-fg">-1</strong>');
    expect(reversedHtml).toContain("del-code");
    expect(reversedHtml).not.toContain("add-code");
  });

  it("renders the same-ref pair as the DiffNotAvailable arm", async () => {
    const res = await get(range(w().mid, w().mid));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Diff Content Not Available");
    expect(html).not.toContain('class="diff-file-box'); // no per-file boxes
  });
});

// --- the single-commit route: admission 404s + the route-level renders -------------

describe("w111 single-commit route (admission 404 family + renders)", () => {
  const single = (sha: string, repo = "w111pull", index = w().pull.topic): string =>
    `/${OWNER}/${repo}/pulls/${index}/commits/${sha}`;

  it("renders a mid-list commit at upstream's /commits path with exactly its own change", async () => {
    const res = await get(single(w().mid));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository view issue pull files diff");
    expect(html).toContain(`#${w().pull.topic} - w111: the open pull`);
    expect(html).toContain('data-new-filename="f2.txt"'); // c2's own file
    expect(html).not.toContain('data-new-filename="f1.txt"'); // the parent's: the FIRST-PARENT diff only
    expect(html).not.toContain('data-new-filename="f3.txt"'); // c3's: never the whole range
  });

  it("404s the short prefix, the merge base, an out-of-list sha, and the non-pull row", async () => {
    expect((await get(single(w().mid.slice(0, 7)))).status).toBe(404); // never equals a full oid
    expect((await get(single(w().mainTip))).status).toBe(404); // the merge base: the ambiguity refusal
    // A real commit oid outside the PR's (base, head] list: the lonely root
    // is unrelated to the topic PR and the topic head is not its descendant.
    expect((await get(single(w().lonelyTip))).status).toBe(404);
    expect((await get(single(w().root))).status).toBe(404); // on the base side
    // The plain issue's index under the pulls tail: the non-pull row 404s
    // (the family's no-redirect divergence).
    expect((await get(single(w().mid, "w111pull", w().pull.plainIssue))).status).toBe(404);
  });

  it("renders the unrelated root-commit head through the escape as DiffNotAvailable", async () => {
    const res = await get(single(w().lonelyTip, "w111pull", w().pull.lonely));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`#${w().pull.lonely} - w111: the lonely pull`);
    expect(html).toContain("Diff Content Not Available");
    expect(html).not.toContain('class="diff-file-box'); // no per-file boxes
  });

  it("404s the broken PR's two file pages (the unresolvable refs/pull head)", async () => {
    // The repo HAS main/topic at the same tips — the 404 comes from the
    // missing refs/pull/1/head exactly like upstream's HeadCommitID == "".
    expect((await get(`/${OWNER}/w111broken/pulls/1/files/${w().mainTip}..${w().topicTip}`)).status).toBe(404);
    expect((await get(`/${OWNER}/w111broken/pulls/1/commits/${w().topicTip}`)).status).toBe(404);
  });
});

// --- the merge-box route arms -------------------------------------------------------

describe("w111 merge-box route arms", () => {
  const box = (index: number, repo = "w111pull"): string => `/${OWNER}/${repo}/pulls/${index}/merge_box`;

  it("answers the merged PR with the EMPTY-200 stop signal and the exact fragment shape", async () => {
    const res = await get(box(w().pull.merged));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(""); // the reload loop's stop signal
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
  });

  it("renders the closed-unmerged arm", async () => {
    const res = await get(box(w().pull.closed));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Pull request closed");
    expect(html).toContain("Please reopen this pull request to perform a merge.");
    expect(html).toContain("pull-merge-box");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
  });

  it("mounts the open PR's fragment with no page chrome", async () => {
    const res = await get(box(w().pull.topic));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="timeline-item comment pull-merge-box"');
    expect(html).toContain('data-global-init="initRepoPullMergeBox"');
    expect(html).not.toContain("<!DOCTYPE html>"); // a fragment, never a page
  });

  it("404s the non-pull row's merge box", async () => {
    const res = await get(box(w().pull.plainIssue));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
  });
});

// --- the cross-origin n/a (GETs) ------------------------------------------------------

describe("w111 cross-origin n/a (GETs)", () => {
  it("renders all three GET surfaces identically under a foreign Origin header", async () => {
    const base = `/${OWNER}/w111pull/pulls/${w().pull.topic}`;
    for (const path of [`${base}/files/${w().mid}..${w().topicTip}`, `${base}/commits/${w().mid}`, `${base}/merge_box`]) {
      const res = await fetchUi(path, { headers: { origin: "https://evil.example" } });
      expect(res.status, path).toBe(200); // reads carry no same-origin guard
    }
  });
});

// --- the wave-129 batch-9 rename+binary arms ---------------------------------------

describe("w111 rename+binary arms (the range and single-commit pages over the BINARM commit)", () => {
  const binPr = (): string => `/${OWNER}/w111pull/pulls/${w().pull.binarm}`;

  it("renders the deleted+renamed pair and the binary file on the RANGE page (no rename detection — the documented degradation)", async () => {
    // mid (tips[2]) is in the PR's (base, head] list, binTip IS the head: the
    // pair admits. The range diff tips[2]→tips[4]: f2.txt removed,
    // f2-renamed.txt added, bin/logo.bin added (binary), and f3.txt added
    // (tips[3]'s change rides the range) — 4 files.
    const res = await get(`${binPr()}/files/${w().mid}..${w().binTip}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`#${w().pull.binarm} - w111: the rename+binary pull`);
    expect(html).toContain("4 changed files");
    // The removed side renders under its OWN path (del-code); the added side
    // under the new path (add-code). The engine has no rename detection
    // (git without -M — the pull-files.tsx module header's documented
    // degradation), so no old→new pairing anywhere: each box's
    // data-old-filename equals its data-new-filename equals its own path.
    expect(html).toContain('data-old-filename="f2.txt"');
    expect(html).toContain('data-new-filename="f2.txt"');
    expect(html).toContain("del-code");
    expect(html).toContain('data-new-filename="f2-renamed.txt"');
    expect(html).toContain("add-code");
    // The binary arm: the BIN mark replaces the +A/-D stats in the header
    // actions and the body renders the degraded branch, never a chroma table.
    expect(html).toContain('data-new-filename="bin/logo.bin"');
    expect(html).toContain("Binary file not shown.");
  });

  it("renders the same three-file anatomy on the SINGLE-COMMIT page (the first-parent diff)", async () => {
    // /commits/{binTip}: the parent diff tips[3]→tips[4] is the same
    // removed+added+binary triple — exactly one commit's own changes.
    const res = await get(`${binPr()}/commits/${w().binTip}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`#${w().pull.binarm} - w111: the rename+binary pull`);
    expect(html).toContain('data-new-filename="f2.txt"');
    expect(html).toContain("del-code");
    expect(html).toContain('data-new-filename="f2-renamed.txt"');
    expect(html).toContain("add-code");
    expect(html).toContain("Binary file not shown.");
    // The parent's own file (f3) is unchanged by this commit — never rendered.
    expect(html).not.toContain('data-new-filename="f3.txt"');
  });

  it("keeps the binary file off the text-diff vocabulary (no hunk rows in the binary box)", async () => {
    // The binary box renders the tw-p-3 degraded div; the unified table's
    // line rows exist only for the text files of the same page.
    const res = await get(`${binPr()}/files/${w().mid}..${w().binTip}`);
    const html = await res.text();
    expect(html).toContain("Binary file not shown.");
    // The removed/added text files still render unified rows.
    expect(html).toContain('class="chroma"');
  });
});

// --- w129 batch-13 additions (wave-polish-matrix-13): the unified diff's -------
// render edges. The suites above exercise the ROUTE arms over add/delete-only
// diffs (every seeded change creates or removes whole files), so the
// hunk-header grammar and the unified line-number grammar stayed unpinned:
// wave 5 pins only the created-file R-side anchors (pages-wave5.test.ts:556-
// 565), the batch-9 rename+binary world pins the box/degraded halves. The
// EDITARM pull gives the grammar its first route-level proof: its HEAD
// commit edits the EXISTING nine-line f1.txt at both ends (del,add, eq×7,
// del,add — two hunks with real eq context), so the SINGLE-COMMIT page (the
// parent diff tips[4]→tips[5]; the /files range page's merge-base diff has no
// shared lines and collapses to the single del+add hunk wave 5's family owns)
// carries the hunk-header and line-number grammar. Plus the documented reductions:
// the ?style=split / whitespace query family is not honored (the header's
// documented reduction), the static page renders no collapse/expander chrome
// (the blob_excerpt fragment owns expansion — pages-wave46), and no
// intra-line word-diff emphasis (the header's documented degrade: the plain
// text shape, no highlighting spans).

/** HashFilePathForWebUI (modules/git/utils.go:42-46) — sha1 hex of the path,
 *  the diff-{hash}L/R{n} anchor namespace (the wave-46 helper's shape). */
async function pathHash(path: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(path));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("w129-13 hunk grammar (the modified file's @@ headers and the unified numbering)", () => {
  // The single-commit page's parent diff (tips[3]→tips[4]) — one f1.txt box,
  // two hunks: exactly the modified-file anatomy the grammar needs.
  const editPage = () => `/${OWNER}/w111pull/pulls/${w().pull.editarm}/commits/${w().editTip}`;

  it("renders the two hunks' @@ header grammar with the upstream cell DOM (tag-code + blob-hunk)", async () => {
    // Provenance: wave-polish-matrix-13. The op stream (del,add, eq×7,
    // del,add) splits past toHunks' merge rule (git/diff.ts:105's
    // `i - end <= context * 2` with context 3): hunk 1 covers ops 0..4 →
    // aStart 1, aLen del+3eq = 4, bStart 1, bLen add+3eq = 4; hunk 2 covers
    // ops 6..10 → aStart 6, bStart 6, both len 4. The header text is the
    // loader's `@@ -a,aLen +b,bLen @@` shape (pull-files.tsx hunkView) in the
    // section_unified.tmpl:15-21 cell.
    const res = await get(editPage());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<tr class="tag-code" data-line-type="tag">');
    expect(html).toContain('<code class="code-inner">@@ -1,4 +1,4 @@</code>');
    expect(html).toContain('<code class="code-inner">@@ -6,4 +6,4 @@</code>');
  });

  it("numbers the rows the unified way: left counts eq+del, right counts eq+add, and the count continues ACROSS hunks", async () => {
    // Provenance: wave-polish-matrix-13. The numbering grammar (pull-files
    // .tsx hunkView: `left` advances on eq+del, `right` on eq+add, the blank
    // half carrying the falsy "" attribute like the template's branch) was
    // never pinned past wave 5's created-file R1 anchor. The exact cells:
    // hunk 1's del row (left 1, right ""), its add row (left "", right 1),
    // then hunk 2's first eq row (6, 6) — the continuation proves the
    // counters did NOT restart per hunk.
    const hash = await pathHash("f1.txt");
    const res = await get(editPage());
    const html = await res.text();
    // hunk 1: the del row — left 1, the right half blank, rel="" like the
    // template's falsy branches.
    expect(html).toContain(
      `<td class="lines-num lines-num-old" data-line-num="1"><span rel="diff-${hash}L1"></span></td>` +
        `<td class="lines-num lines-num-new" data-line-num=""><span rel=""></span></td>`,
    );
    // hunk 1: the add row — the mirror image.
    expect(html).toContain(
      `<td class="lines-num lines-num-old" data-line-num=""><span rel=""></span></td>` +
        `<td class="lines-num lines-num-new" data-line-num="1"><span rel="diff-${hash}R1"></span></td>`,
    );
    // hunk 2: its FIRST row (the eq context after the gap) continues the
    // count at 6/6 — the cross-hunk continuity.
    expect(html).toContain(
      `<td class="lines-num lines-num-old" data-line-num="6"><span rel="diff-${hash}L6"></span></td>` +
        `<td class="lines-num lines-num-new" data-line-num="6"><span rel="diff-${hash}R6"></span></td>`,
    );
    // hunk 2's tail: del at left 9 (right blank), add at right 9.
    expect(html).toContain(
      `<td class="lines-num lines-num-old" data-line-num="9"><span rel="diff-${hash}L9"></span></td>` +
        `<td class="lines-num lines-num-new" data-line-num=""><span rel=""></span></td>`,
    );
    expect(html).toContain(
      `<td class="lines-num lines-num-old" data-line-num=""><span rel=""></span></td>` +
        `<td class="lines-num lines-num-new" data-line-num="9"><span rel="diff-${hash}R9"></span></td>`,
    );
  });

  it("marks the del half rows lines-code-old and renders every line as one plain code-inner (no intra-line emphasis spans)", async () => {
    // Provenance: wave-polish-matrix-13. section_unified.tmpl's lines-code
    // arm carries `lines-code-old` on the old-half rows (the module's
    // `row.right === null` branch) — unpinned; and the header's documented
    // degrade holds: the content renders as the single plain text node (the
    // exact-equality matches leave no room for word-diff/highlight spans).
    const res = await get(editPage());
    const html = await res.text();
    // The del half's code cell carries the old-half class; the add half's
    // does not (right is set).
    expect(html).toContain(
      `<td class="chroma lines-code lines-code-old"><code class="code-inner">one-1</code></td>`,
    );
    expect(html).toContain(
      `<td class="chroma lines-code lines-code-old"><code class="code-inner">one-9</code></td>`,
    );
    expect(html).toContain(`<td class="chroma lines-code"><code class="code-inner">edit-1</code></td>`);
    // The eq rows render their shared content once.
    expect(html).toContain(`<td class="chroma lines-code"><code class="code-inner">one-2</code></td>`);
    // No emphasis vocabulary anywhere on the page.
    expect(html).not.toContain("diff-word-");
    expect(html).not.toContain("added-code");
    expect(html).not.toContain("deleted-code");
  });

  it("the query family (?style=split, ?whitespace=...) renders the identical unified shape — the dropdowns' reduction", async () => {
    // Provenance: wave-polish-matrix-13. The header documents the reduction
    // (pull-files.tsx: "the whitespace query family are not honored ... the
    // unified view is the only shape") — unpinned until now: the SPLIT query
    // must not produce a split table, and the whitespace values must not
    // change the row content.
    const base = editPage();
    const plain = await (await get(base)).text();
    const split = await (await get(`${base}?style=split`)).text();
    const ws = await (await get(`${base}?style=unified&whitespace=ignore-change&skip-to=1`)).text();
    for (const variant of [split, ws]) {
      expect(variant).toContain('class="file-body file-code unicode-escaped code-diff code-diff-unified"');
      expect(variant).not.toContain("code-diff-split");
      expect(variant).toContain('<code class="code-inner">@@ -1,4 +1,4 @@</code>');
      expect(variant).toContain('<code class="code-inner">@@ -6,4 +6,4 @@</code>');
      expect(variant).toContain('<code class="code-inner">one-2</code>');
    }
    expect(plain).toContain("code-diff-unified");
  });

  it("the static page renders no collapse/expander chrome — the blob_excerpt fragment owns expansion", async () => {
    // Provenance: wave-polish-matrix-13. The file-collapse interaction is
    // the JS island upstream folds through; the landed page renders every
    // hunk's rows expanded (the unified table fully materialized) and the
    // expander vocabulary exists only on the blob_excerpt fragment
    // (pages-wave46-fragment-mounts pins the fragment side).
    const res = await get(editPage());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("code-expander-button");
    expect(html).not.toContain("code-expander-buttons");
    expect(html).not.toContain("line-expanded");
    // All of the modified file's rendered lines are materialized: the two
    // changed ends plus the context rows each hunk carries (hunk 1's window
    // is ops 0..4 → one-1/edit-1/one-2/one-3/one-4, hunk 2's is ops 6..10 →
    // one-6/one-7/one-8/one-9/edit-9; the gap line one-5 sits outside BOTH
    // windows and renders nowhere — upstream's 3-line context shape).
    for (const line of ["edit-1", "one-2", "one-3", "one-4", "one-6", "one-7", "one-8", "edit-9"]) {
      expect(html).toContain(`<code class="code-inner">${line}</code>`);
    }
    expect(html).not.toContain('<code class="code-inner">one-5</code>');
    expect(html).not.toContain('<code class="code-inner">w111 one</code>');
  });
});
