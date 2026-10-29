/**
 * The compare page's DEFERRED route-level matrix (pages/compare.tsx —
 * `GET+POST /{owner}/{repo}/compare[/{base}...{head}]` mounted at wave 13,
 * plus window-2e's .diff/.patch feed branch inside comparePage — NOT
 * re-pinned here; compare-feeds.test.tsx owns the feed contract). The base
 * arms belong to ui/__tests__/pages-wave13.test.ts (the parser claims incl.
 * the `..`/fork/junk nulls, the writer and anonymous renders over a PUBLIC
 * repo, the existing-PR segment, the degenerate GET pairs, the bad-ref
 * 404s, the bare URL's default...default, the POST
 * create/duplicate/degenerate arms, the anonymous-303 / non-writer-404 /
 * cross-origin-403 write gates and the empty-title re-render's kept body)
 * and to the committed goldens (compare-form/has-pr/nothing/commits.html).
 * THIS FILE adds only the arms that fixture posture cannot render, driven
 * over the mounted uiRouter on the branches.matrix minted-session pattern
 * (the execution context is awaited, so the create POST's inline
 * delivery-row half settles before the assertions) with a disjoint `w105*`
 * fixture family seeded through the REAL receive flow:
 *
 *   - the viewer gates on a PRIVATE repo (wave-13's fixtures are all
 *     public): anonymous and signed-in-stranger 404 shells on the GET — and
 *     on the POST, where a public repo would 303 onto /login (wave-13's
 *     arm): the invisible repo's existence stays hidden instead of leaking
 *     through the redirect; plus the signed-in OWNER's 200 render with the
 *     inline writer form;
 *   - the archived arms (route level): the owner's comparison renders
 *     read-only — the code-flavored head, the archived warning, no form —
 *     while the create POST 404-shells (the writer gate's archived half)
 *     and writes nothing;
 *   - the default-fallback LOAD arms (wave-13 pins the parser's null sides
 *     and the bare URL only): `/compare/{base}...` resolves the head to the
 *     default (main...main — the nothing arm, with the switch link carrying
 *     the resolved pair), `/compare/...{head}` and the single-ref
 *     `/compare/{head}` resolve the base to the default and the no-JS form
 *     posts to the RESOLVED pair URL (the round-trip re-parses to the same
 *     comparison); a D1 default naming no ref 404-shells the bare URL (the
 *     unresolvable-side arm — upstream parity: the branches list page's
 *     first-branch fallback is a list refinement, not a compare one) while
 *     explicit sides still resolve;
 *   - the tag-as-BASE arm (wave-13 pins tag-as-head only): comparable, so
 *     the commits table and the diff box render, but allowCreatePull's
 *     IsBranch pair folds the form for the signed-in writer and the POST
 *     refuses with the have-tag message;
 *   - the ?page clamp on this route (wave-13 pins only ?page=9 → 200):
 *     junk renders page 1's rows with no pagination, while a beyond-range
 *     page renders the empty table with the Newer link whose href is the
 *     compare URL itself (CommitsPagination's basePath = compareLink);
 *   - the form re-render + create ROUND TRIP with carried values: the
 *     empty-title refusal re-renders with the submitted empty title AND the
 *     kept body and writes nothing; the retried POST 303s onto the created
 *     PR (rows + cached headSha + the refs/pull/N/head CAS write), and the
 *     same compare URL then arms to the existing-PR segment — form gone;
 *   - (window-crosscompare) the TWO-DOT family: the old engine-owned claim
 *     pin FLIPPED — the `..` separator parses (ParseCompareRouterParam's
 *     first-`...`-else-first-`..` order) and DirectComparison renders the
 *     direct two-tip diff (CompareBase = the base tip, services/git/
 *     compare.go:83-89): the head-behind pair shows the 0-commit table
 *     beside the reverse delta, the equal-tips pair folds into the PLAIN
 *     nothing message (DirectComparison folds $allowCreatePR — the
 *     and_allow_empty_pr text never fires), the tag..branch pair renders
 *     read-only, and the POST stays separator-blind (pull.go:1318 has no
 *     DirectComparison gate — the hand-crafted `..` POST creates);
 *   - (window-crosscompare) the FORK forms: grammar forms 2/3/5/6 land —
 *     the sibling-repo head (explicit owner/name) renders with the
 *     cross-repo chrome (the head selector's full name, the base-prefixed
 *     head-side dropdown items, the head-repo switch link, CommitRepoLink
 *     sha links), the bare `{owner}:{ref}` form resolves through the
 *     fork-edge port, the same-repo owner/name alias folds back onto the
 *     base, a missing fork edge and an unreadable PRIVATE fork 404-shell
 *     (compare.go:182-188), and the cross-repo POST rides the landed
 *     create-compare seam (the merge base in the head cell, the head
 *     closure carried into the base cell, the headRepoId row,
 *     refs/pull/1/head in the base cell) — the fork round trip arms to the
 *     existing-PR segment. The BASE-side colon form stays engine-owned
 *     (parseHead is head-only upstream — the 404 shell is upstream's
 *     resolution miss).
 *   - (wave-129 matrix-4) the cross-branch edges: the EMPTY-DIFF arm (a
 *     head-at-merge-base pair folds into upstream's nothingToCompare state —
 *     compare.go:397-405 headCommitID == ci.CompareBase — the segment plus
 *     the folded diff box rendering, the create form surviving through the
 *     AllowEmptyPr gate (compare.tmpl:173) with the same-ref control arm
 *     folding it; the ORIGINALLY pinned landed shape folded only at same-tip
 *     and rendered the bare empty diff beside the live form — the divergence
 *     this arm's flip ported), and the ELLIPSIS direction (base...head diffs
 *     the head side, pinned through the sha pair's order + the hunk headers).
 */

import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { findPullRequestByIndex } from "../../api/services/pulls";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { pullRequests, repositories, users } from "../../db/schema";
import { settleCreatingRepo } from "../../git-http/gate";
import { RepoService } from "../../repos/service";
import { uiRouter, type UiAssetsFetcher } from "../index";
import type { UiManifest } from "../manifest";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";

// wave-129 full-run contention budget: this file's beforeAll seeding (the
// receive-flow w105* fixture family) measured a 4.51s hook share of the 30s
// default IN a green 8-worker full run (the suite's 260-isolate spawn storm
// spikes closures up to ~12x their solo time). File-local 90s budgets;
// vitest.config.ts keeps 30s for every other file. Membership: the measured
// >=4s in-run closure/hook set (full-suite junit run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// --- the minted-session route harness (the branches.matrix pattern) --------------

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
 *  loadCompareData / createPullFromForm → render, on the mounted uiRouter
 *  with the synthetic manifest; the execution context is awaited so
 *  waitUntil side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie for the fixture user (the value is never
 *  asserted — minted per call like the branches.matrix helper). */
async function cookieFor(username: string): Promise<string> {
  const user = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, username)).get();
  if (user === undefined) throw new Error(`w105 fixture user missing: ${username}`);
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, user.id)}`;
}

/** Anonymous GET (cookie omitted) or a minted-session GET. */
async function get(path: string, as?: string): Promise<Response> {
  return fetchUi(path, as === undefined ? undefined : { headers: { cookie: await cookieFor(as) } });
}

const formPost = (path: string, body: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: ORIGIN,
    ...(cookie === undefined ? {} : { cookie }),
  },
  body: new URLSearchParams(Object.entries(body)).toString(),
});

/** The open-PR row count for one fixture repo (the "nothing was written"
 *  half of every refusal arm). */
async function prRowCount(slug: string): Promise<number> {
  const row = (
    await drizzle(env.DB)
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, slug)))
      .get()
  )!;
  return (await drizzle(env.DB).select({ id: pullRequests.id }).from(pullRequests).where(eq(pullRequests.baseRepoId, row.id)).all())
    .length;
}

// --- fixtures -------------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — fixed, deterministic oids

const OWNER = "w105gal";
const STRANGER = "w105pal";

/** Four fixed commits: tips[0] root, tips[1] main's tip, tips[2] one ahead
 *  (feature/docs — the round-trip pair), tips[3] one ahead (feature/deep —
 *  the fallback/clamp arms' pair, PR-less so its arms stay order-free). */
const W105_COMMITS: SeedCommit[] = [
  { message: "w105: seed root", time: T0, files: [{ path: "f0.txt", content: "root\n" }] },
  { message: "w105: main tip", time: T0 + 60, files: [{ path: "f1.txt", content: "one\n" }] },
  { message: "w105: docs change", time: T0 + 120, files: [{ path: "f2.txt", content: "two\n" }] },
  { message: "w105: deep change", time: T0 + 180, files: [{ path: "f3.txt", content: "three\n" }] },
];

const MAIN_TIP = 1;
const DOCS_TIP = 2;
const DEEP_TIP = 3;

/** The fork's superset history: the base chain plus one fork-only commit —
 *  its closure is the object set the base cell LACKS, so the create arm's
 *  carryForkHeadIntoBase does real work (the fork-first flow's own seam). */
const FORK_COMMITS: SeedCommit[] = [
  ...W105_COMMITS,
  { message: "w105: fork-only change", time: T0 + 240, files: [{ path: "f4.txt", content: "fork\n" }] },
];
const FORK_TIP_INDEX = 4;

let w105Tips: string[] = [];
let w105ForkTip: string | null = null;

/** Idempotent repo seed (the branches.matrix recipe over this module's ref
 *  set): token mint, ONE multi-ref push (heads + the lightweight tag) when
 *  the cell is unborn, the D1 row create-or-settle, then the visibility /
 *  defaultBranch / isArchived pins. */
async function ensureRepo(
  slug: string,
  refs: { ref: string; tipIndex: number }[],
  tips: string[],
  pack: Uint8Array,
  options: { defaultBranch: string; isPrivate?: boolean; isArchived?: boolean },
): Promise<void> {
  const db = drizzle(env.DB);
  const repoName = `${OWNER}/${slug}`;
  const owner = (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get())!;

  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner.id, `w105-seed-${slug}`)
    .run();
  const token = (await mintFor(owner.id, `w105-seed-${slug}`, "write:repository")).plaintext;

  const engineRefs = await env.REPO.getByName(repoName).listRefs();
  if (engineRefs.head === null) {
    const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
      body: buildReceivePackBody(
        refs.map((entry) => ({ ref: entry.ref, oid: tips[entry.tipIndex] as string })),
        pack,
      ),
    });
    const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    if (response.status !== 200 || responseBody.includes("ng ")) {
      throw new Error(`w105 seed push failed (${slug}): ${response.status} ${responseBody.slice(0, 400)}`);
    }
  }

  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, slug)))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: owner.id, usernameLower: OWNER },
      name: slug,
      isPrivate: options.isPrivate === true,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, row.id, repoName);
    row = (await db.select().from(repositories).where(eq(repositories.id, row.id)).get()) ?? row;
  }
  const wantVisibility = options.isPrivate === true ? "private" : "public";
  if (row.visibility !== wantVisibility) {
    await db.update(repositories).set({ visibility: wantVisibility }).where(eq(repositories.id, row.id));
  }
  if (row.defaultBranch !== options.defaultBranch) {
    await db.update(repositories).set({ defaultBranch: options.defaultBranch }).where(eq(repositories.id, row.id));
  }
  if (row.isArchived !== (options.isArchived === true)) {
    await db.update(repositories).set({ isArchived: options.isArchived === true }).where(eq(repositories.id, row.id));
  }
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

  const { tips, pack } = await buildHistoryPack(W105_COMMITS);
  w105Tips = tips;

  const BASE_REFS = [
    { ref: "refs/heads/main", tipIndex: MAIN_TIP },
    { ref: "refs/heads/main-mirror", tipIndex: MAIN_TIP }, // EQUAL tips with main (the empty-PR create pair)
    { ref: "refs/heads/feature/docs", tipIndex: DOCS_TIP },
    { ref: "refs/heads/feature/deep", tipIndex: DEEP_TIP },
    { ref: "refs/tags/v1", tipIndex: MAIN_TIP }, // the tag sits AT main's tip
  ];

  // The main public repo (the fallback/clamp/round-trip arms).
  await ensureRepo("w105cmp", BASE_REFS, tips, pack, { defaultBranch: "main" });
  // The private repo (the gate arms need no rows).
  await ensureRepo("w105priv", BASE_REFS, tips, pack, { defaultBranch: "main", isPrivate: true });
  // The archived repo (the CanContentChange arms over a comparable pair).
  await ensureRepo("w105arch", BASE_REFS, tips, pack, { defaultBranch: "main", isArchived: true });
  // The ghost-default repo: the D1 default names no ref (the §4.9-adjacent
  // unresolvable-default arm — the bare URL must 404, explicit sides work).
  await ensureRepo("w105ghost", BASE_REFS, tips, pack, { defaultBranch: "ghost" });

  await ensureForkFixtures();
}

/** The cross-repo fixture family (the fork forms' arms): w105pal's PUBLIC
 *  fork of w105cmp carrying the superset history (main + the divergent
 *  feature/fork), forkParent riding the forks-matrix direct update, plus a
 *  PRIVATE empty fork for the head-read-grant arm. */
async function ensureForkFixtures(): Promise<void> {
  const db = drizzle(env.DB);
  const pal = (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, STRANGER)).get())!;
  const baseRow = (
    await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, "w105cmp")))
      .get()
  )!;

  const { tips: forkTips, pack: forkPack } = await buildHistoryPack(FORK_COMMITS);
  w105ForkTip = forkTips[FORK_TIP_INDEX] ?? null;

  const forkName = `${STRANGER}/w105fork`;
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?").bind(pal.id, "w105-seed-fork").run();
  const token = (await mintFor(pal.id, "w105-seed-fork", "write:repository")).plaintext;
  if ((await env.REPO.getByName(forkName).listRefs()).head === null) {
    const response = await SELF.fetch(`https://test.local/${forkName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
      body: buildReceivePackBody(
        [
          { ref: "refs/heads/main", oid: forkTips[MAIN_TIP] as string },
          { ref: "refs/heads/feature/fork", oid: forkTips[FORK_TIP_INDEX] as string },
        ],
        forkPack,
      ),
    });
    const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    if (response.status !== 200 || responseBody.includes("ng ")) {
      throw new Error(`w105 fork seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
    }
  }

  let forkRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, STRANGER), eq(repositories.slug, "w105fork")))
    .get();
  if (forkRow === undefined) {
    forkRow = await new RepoService(env.DB).create({
      owner: { id: pal.id, usernameLower: STRANGER },
      name: "w105fork",
      isPrivate: false,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, forkRow.id, forkName);
  }
  await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, forkRow.id));
  if (forkRow.forkParent !== baseRow.id) {
    await db.update(repositories).set({ forkParent: baseRow.id }).where(eq(repositories.id, forkRow.id));
  }

  // The private fork: an EMPTY ready row (the read grant misses before any
  // engine read — no git content needed).
  let privRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, STRANGER), eq(repositories.slug, "w105forkpriv")))
    .get();
  if (privRow === undefined) {
    privRow = await new RepoService(env.DB).create({
      owner: { id: pal.id, usernameLower: STRANGER },
      name: "w105forkpriv",
      isPrivate: true,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, privRow.id, `${STRANGER}/w105forkpriv`);
  }
  await db.update(repositories).set({ visibility: "private" }).where(eq(repositories.id, privRow.id));
  if (privRow.forkParent !== baseRow.id) {
    await db.update(repositories).set({ forkParent: baseRow.id }).where(eq(repositories.id, privRow.id));
  }
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the two-dot arm (the window-crosscompare flip of the engine-owned pin) -------

describe("w105 the two-dot family (DirectComparison)", () => {
  it("renders the direct base..head diff for a head-behind pair: 0 commits, the reverse delta, no form, live toggle", async () => {
    // feature/deep..main: CompareBase = the BASE tip (services/git/
    // compare.go:83-89 — never empty, so the no-common-history fold is
    // unreachable and the head==mergeBase fold misses: main is not the
    // CompareBase, deep's tip is). The range deep..main is EMPTY (commits_table's
    // 0 count) while the direct two-tip diff shows the REVERSE delta (f3
    // goes away), the `$showDiffBox := or .CommitCount .DiffShortStat.
    // NumFiles` shape. allowCreatePR folds at DirectComparison
    // (compare.tmpl:173) while allowCreatePull does NOT (compare.go:305-306
    // — CompareBase != "") → the pull-flavored header with no form.
    const mainTip = w105Tips[MAIN_TIP];
    const deepTip = w105Tips[DEEP_TIP];
    if (mainTip === undefined || deepTip === undefined) throw new Error("w105 seed: tips missing");
    const res = await get(`/${OWNER}/w105cmp/compare/feature/deep..main`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content repository diff compare pull");
    expect(html).toContain("Comparing changes");
    expect(html).not.toContain("New Pull Request");
    expect(html).not.toContain('id="new-issue"');
    expect(html).not.toContain("There are no differences to show");
    // The commits table: the 0 count beside the sha pair (the direct form's
    // separator rides the table too).
    expect(html).toContain("0 Commits");
    expect(html).toContain(`<div class="compare-separator">..</div>`);
    // The direct diff: the reverse delta (the snapshot trees — deep={f3}
    // against main={f1} — so f3 deletes and f1 adds going deep→main; the
    // mirrored (three-dot) hunks would flip the -/+ pair).
    expect(html).toContain('data-old-filename="f3.txt"');
    expect(html).toContain('data-new-filename="f1.txt"');
    expect(html).toContain('id="diff-file-boxes"');
    expect(html).toContain('<code class="code-inner">@@ -1,1 +0,0 @@</code>');
    expect(html).toContain('<code class="code-inner">@@ -0,0 +1,1 @@</code>');
    expect(html).toContain("1 additions");
    expect(html).toContain("1 deletions");
    // The separator switch is LIVE now: the href carries the OTHER
    // separator (compare.tmpl:99's $compareSeparatorSwitch) with the head
    // pair; the switch-head-base link keeps the plain ... shape.
    expect(html).toContain(`href="/${OWNER}/w105cmp/compare/feature/deep...main" title="Switch comparison type"`);
    expect(html).toContain(`href="/${OWNER}/w105cmp/compare/main...feature/deep" title="Switch head and base"`);
  });

  it("folds the equal-tips two-dot pair into the plain nothing message with no form", async () => {
    // main..main-mirror: CompareBase = the main tip = the head tip → the
    // compare.go:397-405 fold; DirectComparison folds $allowCreatePR, so the
    // segment shows the PLAIN branch-pair text (never the
    // and_allow_empty_pr text) and the form never renders.
    const res = await get(`/${OWNER}/w105cmp/compare/main..main-mirror`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("There are no differences to show. There is no need to create a pull request.");
    expect(html).not.toContain("These branches are equal");
    expect(html).not.toContain('id="new-issue"');
    expect(html).not.toContain('id="diff-file-boxes"');
  });

  it("renders the comparable tag..branch two-dot pair read-only", async () => {
    // v1..feature/docs: the tag base folds the branch-pair gate (code
    // flavor), the direct comparison stays comparable (1 commit + the docs
    // delta).
    const res = await get(`/${OWNER}/w105cmp/compare/v1..feature/docs`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Compare commits");
    expect(html).not.toContain("New Pull Request");
    expect(html).toContain("1 Commits");
    expect(html).toContain('id="diff-file-boxes"');
    expect(html).toContain(`<div class="compare-separator">..</div>`);
  });
});

// --- the fork forms (grammar forms 2/3/5/6 — the cross-repo compare) ---------------

describe("w105 the fork forms (the cross-repo compare)", () => {
  it("renders the sibling-repo head (explicit owner/name form) with the cross-repo chrome", async () => {
    // w105ghost is public and carries the IDENTICAL branch universe — the
    // head reads all run in ITS cell (services/git/compare.go:70-89: the
    // merge base, the range and the diff of GetCompareInfo live in
    // headGitRepo; forks/siblings with shared history need no carry).
    const pairPath = `/${OWNER}/w105cmp/compare/main...${OWNER}/w105ghost:feature/docs`;
    const res = await get(pairPath, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content repository diff compare pull");
    // The head selector shows the HEAD repo's full name; the form posts to
    // the fork-form URL (the round-trip re-parses to the same pair).
    expect(html).toContain(">pull from: <strong>w105gal/w105ghost:feature/docs</strong>");
    expect(html).toContain(`action="/${OWNER}/w105cmp/compare/main...w105gal/w105ghost:feature/docs" method="post"`);
    // The head-side dropdown lists the BASE repo's branches with the base
    // prefix (compare.tmpl:131-135); the base-side lists the head repo's
    // onto the head repo's page (compare.tmpl:60-64).
    expect(html).toContain(`href="/${OWNER}/w105cmp/compare/main...w105gal/w105cmp:feature/docs"`);
    expect(html).toContain(`href="/${OWNER}/w105ghost/compare/main...w105gal/w105ghost:feature/docs"`);
    // The switch link rides the HEAD repo with the base repo prefix
    // (compare.tmpl:29); the commits table's sha links ride CommitRepoLink =
    // the head repo (compare.go:383).
    expect(html).toContain(`href="/${OWNER}/w105ghost/compare/feature/docs...w105gal/w105cmp:main" title="Switch head and base"`);
    // The comparison itself: the ghost cell's docs delta.
    expect(html).toContain("1 Commits");
    expect(html).toContain('id="diff-file-boxes"');
    // The BASE-side colon form stays unclaimed (parseHead is head-only
    // upstream — the base ref names no repo; the 404 shell is upstream's
    // resolution miss).
    const baseSide = await get(`/${OWNER}/w105cmp/compare/${OWNER}/w105ghost:main...feature/docs`);
    expect(baseSide.status).toBe(404);
    expect(await baseSide.text()).toContain("404 Not Found");
  });

  it("resolves the bare fork-edge form onto the viewer-agnostic fork row and 404-shells the missing edge", async () => {
    // Grammar form 2: `w105pal:feature/fork` — the fork edge (FindHeadRepo →
    // the landed resolveHeadRepo port) finds pal's fork of w105cmp without
    // naming it.
    const pairPath = `/${OWNER}/w105cmp/compare/main...${STRANGER}:feature/fork`;
    const res = await get(pairPath, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">pull from: <strong>w105pal/w105fork:feature/fork</strong>");
    // An owner with NO fork of the base (and no same-slug repo) misses the
    // edge → the landed anti-enumeration 404 (the API route's documented
    // deviation from upstream's 400 message).
    const missing = await get(`/${OWNER}/w105cmp/compare/main...${STRANGER}-no-fork:main`, OWNER);
    expect(missing.status).toBe(404);
  });

  it("404-shells an unreadable private fork head (permHead.CanRead's not-exist arm)", async () => {
    // w105pal/w105forkpriv is PRIVATE: even the BASE owner fails the head
    // repo's §2.5 read grant — upstream's
    // `!permHead.CanRead(unit.TypeCode) → NewNotExistErrorf` 404
    // (compare.go:182-188), never a render.
    const res = await get(`/${OWNER}/w105cmp/compare/main...${STRANGER}/w105forkpriv:main`, OWNER);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("404 Not Found");
  });
});

// --- the viewer gates (the private-repo arms) --------------------------------------

describe("w105 viewer gates (the private-repo arms)", () => {
  it("404-shells the private repo's compare for anonymous and stranger sessions, GET and POST alike", async () => {
    const pairPath = `/${OWNER}/w105priv/compare/main...feature/docs`;
    // The GET: no read grant → the §2.5 shell, existence hidden. A session
    // buys no visibility (the branches matrix's arm, on this family).
    expect((await get(pairPath)).status).toBe(404);
    expect((await get(pairPath, STRANGER)).status).toBe(404);
    // The write: a public repo's anonymous POST 303s onto /login (wave-13's
    // gate arm); here the repo resolves first and never exists for the
    // viewer — no login redirect may leak the row's existence.
    const anonPost = await fetchUi(pairPath, formPost(pairPath, { title: "Nope" }));
    expect(anonPost.status).toBe(404);
    const strangerPost = await fetchUi(pairPath, formPost(pairPath, { title: "Nope" }, await cookieFor(STRANGER)));
    expect(strangerPost.status).toBe(404);
    // The refusals wrote nothing.
    expect(await prRowCount("w105priv")).toBe(0);
  });

  it("renders the signed-in owner's private compare with the inline writer form", async () => {
    const res = await get(`/${OWNER}/w105priv/compare/main...feature/docs`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The pull-flavored head rides the loaded grant over the private row.
    expect(html).toContain("page-content repository diff compare pull");
    expect(html).toContain("Comparing changes");
    expect(html).toContain(`action="/${OWNER}/w105priv/compare/main...feature/docs" method="post"`);
    expect(html).toContain("New Pull Request");
  });
});

// --- the archived arms (the CanContentChange route half) ----------------------------

describe("w105 archived arms (the read-only comparison)", () => {
  it("renders the owner's comparison read-only: the warning, no form, the code-flavored head", async () => {
    const res = await get(`/${OWNER}/w105arch/compare/main...feature/docs`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Signed in over a comparable branch pair, yet PageIsComparePull folds
    // (repo.isArchived): the pull-flavored head and the form never render.
    expect(html).toContain("Compare commits");
    expect(html).not.toContain("New Pull Request");
    expect(html).not.toContain('id="new-issue"');
    // The archived warning rides the state arms (comparable, no existing PR).
    expect(html).toContain("This repo is archived.");
    // The read surfaces stay: the commits table and the diff box.
    expect(html).toContain("1 Commits");
    expect(html).toContain('id="diff-file-boxes"');
  });

  it("404-shells the archived repo's create POST for the owner — nothing written, the ref intact", async () => {
    const pairPath = `/${OWNER}/w105arch/compare/main...feature/docs`;
    const res = await fetchUi(pairPath, formPost(pairPath, { title: "Nope" }, await cookieFor(OWNER)));
    expect(res.status).toBe(404);
    expect(await prRowCount("w105arch")).toBe(0);
    const refNames = (await env.REPO.getByName(`${OWNER}/w105arch`).listRefs()).refs.map((ref) => ref.name);
    expect(refNames).toContain("refs/heads/feature/docs");
    expect(refNames).not.toContain("refs/pull/1/head");
  });
});

// --- the default-fallback LOAD arms -------------------------------------------------

describe("w105 default-fallback arms (the load half of the null sides)", () => {
  it("resolves the empty head tail to the default: main...main renders the nothing arm", async () => {
    // wave-13 pins `/compare/main...` at the parser only (head: null); here
    // the load: headName falls to the default (main) — the pair is
    // main...main, comparable folds, and the switch link carries the
    // RESOLVED pair (the emitted URL always re-parses to the same pair).
    const res = await get(`/${OWNER}/w105cmp/compare/main...`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("There are no differences to show. There is no need to create a pull request.");
    expect(html).toContain(">base: <strong>w105gal/w105cmp:main</strong>");
    expect(html).toContain(">compare: <strong>w105gal/w105cmp:main</strong>");
    expect(html).toContain(`href="/${OWNER}/w105cmp/compare/main...main"`);
    expect(html).not.toContain('id="new-issue"');
  });

  it("resolves the empty base tail and the single-ref form to the default; the form posts to the resolved pair", async () => {
    for (const tail of ["...feature/deep", "feature/deep"]) {
      const res = await get(`/${OWNER}/w105cmp/compare/${tail}`, OWNER);
      expect(res.status, tail).toBe(200);
      const html = await res.text();
      // The load falls back to the default base (main): the comparable view
      // renders — and the no-JS form's action is the RESOLVED pair URL, not
      // the submitted shorthand, so the POST re-parses to the same
      // comparison (compareLink's invariant).
      expect(html, tail).toContain(`action="/${OWNER}/w105cmp/compare/main...feature/deep" method="post"`);
      expect(html, tail).toContain("New Pull Request");
      // feature/deep rides the linear chain: two commits ahead of main
      // (docs + deep), the range's count header reflects both.
      expect(html, tail).toContain("2 Commits");
      expect(html, tail).toContain(">merge into: <strong>w105gal/w105cmp:main</strong>");
      expect(html, tail).toContain(">pull from: <strong>w105gal/w105cmp:feature/deep</strong>");
    }
  });

  it("404-shells the bare compare when the D1 default names no ref; explicit sides still resolve", async () => {
    // The IfZero fallback uses the RAW default name: "ghost" resolves to no
    // branch/tag/oid — the unresolvable-side 404 (upstream parity; the
    // branches page's first-branch fallback is a list-page refinement).
    expect((await get(`/${OWNER}/w105ghost/compare`)).status).toBe(404);
    expect((await get(`/${OWNER}/w105ghost/compare/...feature/docs`)).status).toBe(404);
    // An explicit pair bypasses the fallback entirely.
    expect((await get(`/${OWNER}/w105ghost/compare/main...feature/docs`)).status).toBe(200);
  });
});

// --- the tag-as-BASE arm -------------------------------------------------------------

describe("w105 tag-as-base arm (the IsBranch pair)", () => {
  it("renders the comparable tag...branch pair read-only and refuses its POST with the have-tag message", async () => {
    const pairPath = `/${OWNER}/w105cmp/compare/v1...feature/docs`;
    // v1 sits at main's tip: comparable (the commits table + the diff box
    // render), but the base is not a branch — allowCreatePull folds, so
    // PageIsComparePull folds for the signed-in writer too (wave-13 pins
    // the tag-as-HEAD mirror only).
    const res = await get(pairPath, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Compare commits");
    expect(html).not.toContain("New Pull Request");
    expect(html).toContain("1 Commits");
    expect(html).toContain('id="diff-file-boxes"');
    // The POST never creates (parseCompareInfo's branch-pair arm).
    const post = await fetchUi(pairPath, formPost(pairPath, { title: "Tagged" }, await cookieFor(OWNER)));
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("There are no differences to show between the selected branches or tags.");
    expect(await prRowCount("w105cmp")).toBe(0);
  });
});

// --- the ?page clamp -----------------------------------------------------------------

describe("w105 ?page clamp (parsePageNumber on this route)", () => {
  it("renders page 1's rows for junk pages and the empty table + Newer for a beyond-range page", async () => {
    // wave-13 pins ?page=9 → 200 only; the clamp's two halves: junk renders
    // page 1 (the commit row present, no pagination at all)…
    const junk = await get(`/${OWNER}/w105cmp/compare/main...feature/deep?page=junk`, OWNER);
    expect(junk.status).toBe(200);
    const junkHtml = await junk.text();
    expect(junkHtml).toContain("w105: deep change</a>");
    expect(junkHtml).not.toContain("navigation_label");
    // …while a beyond-range page renders the empty table with the Newer
    // link whose href is the compare URL itself (CommitsPagination's
    // basePath = compareLink — the pagination shape on this family).
    const paged = await get(`/${OWNER}/w105cmp/compare/main...feature/deep?page=2`, OWNER);
    expect(paged.status).toBe(200);
    const pagedHtml = await paged.text();
    expect(pagedHtml).not.toContain("w105: deep change</a>");
    expect(pagedHtml).toContain(`class="item navigation" href="/${OWNER}/w105cmp/compare/main...feature/deep"`);
    expect(pagedHtml).toContain(">Newer</span>");
  });
});

// --- the cross-branch edges (wave-129 matrix-4) --------------------------------------
// The range direction + the nothingToCompare fold over the deep pair
// (feature/deep is TWO commits ahead of main, so its reverse is the fold
// shape):
//
//   - the EMPTY-DIFF arm (FIX-provenance): a pair whose head sits BEHIND the
//     base (head == merge-base) folds the whole comparison into upstream's
//     nothingToCompare state (compare.go:397-405 — headCommitID ==
//     ci.CompareBase, the merge base per services/git/compare.go:83-88; the
//     equal-tips case subsumes — the merge-base of equal tips is that tip):
//     the segment renders (the and_allow_empty_pr text — AllowEmptyPr holds:
//     supportEmptyPr = !AutodetectManualMerge is unlanded config → true,
//     acrossRepoPr = !IsSameRef → the resolved names differ) and the diff
//     box stays folded (compare.tmpl:171's `$showDiffBox`), while the
//     create form SURVIVES through the AllowEmptyPr gate (compare.tmpl:173's
//     `or $.AllowEmptyPr`). The same-ref CONTROL (main...main — IsSameRef
//     holds) keeps the plain text and folds the form. The ORIGINALLY pinned
//     landed shape folded only at same tip and rendered the bare empty diff
//     beside the live form with no segment — the divergence this flip
//     ported.
//   - the ELLIPSIS direction: base...head diffs the HEAD side —
//     readDiff(headTip, mergeBase) (the three-dot composition,
//     prepareCompareDiff's BeforeCommitID = ci.CompareBase / AfterCommitID =
//     headCommitID, compare.go:405-407) — pinned through the sha pair's
//     order and the head-side file boxes.
//   - the ACROSS-FORK colon form: claimed at window-crosscompare — the
//     sibling/fork heads resolve through the landed fork-edge port (the
//     dedicated describe below owns the arms); only the BASE-side colon
//     form stays engine-owned (parseHead is head-only upstream).

describe("w105 cross-branch edges (the empty range, the direction, the same-repo alias)", () => {
  it("the empty-diff arm: a head-at-merge-base pair folds into the nothing segment, the form surviving via AllowEmptyPr", async () => {
    // feature/deep...main: the merge base IS main's tip and the head adds
    // nothing — upstream's nothingToCompare fold (compare.go:397-405,
    // headCommitID == ci.CompareBase), ported at wave-129 (the originally
    // pinned landed shape folded only at same tip and rendered the bare
    // empty diff beside the live form with no segment — the disclosed
    // divergence above).
    const res = await get(`/${OWNER}/w105cmp/compare/feature/deep...main`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The pull-flavored head stays: upstream's allowCreatePull folds only at
    // CompareBase == "" (compare.go:305-306) and ours adds only the
    // equal-tips case (wave-13 pins that shape code-flavored).
    expect(html).toContain("Comparing changes");
    // The nothing segment renders — the AllowEmptyPr arm's text: the
    // resolved ref names differ, so acrossRepoPr holds (supportEmptyPr rides
    // the unlanded autodetect-manual-merge config as true).
    expect(html).toContain("These branches are equal. This PR will be empty.");
    expect(html).not.toContain("There are no differences to show");
    // The diff box folds: no commits table, no file boxes, no stats.
    expect(html).not.toContain('id="diff-file-boxes"');
    expect(html).not.toContain('class="ui top attached header flex-left-right"');
    expect(html).not.toContain("changed files");
    // The writer form survives the fold through AllowEmptyPr (compare.tmpl:
    // 173's `or $.AllowEmptyPr` — upstream renders the form on this shape
    // exactly when AllowEmptyPr holds).
    expect(html).toContain(`action="/${OWNER}/w105cmp/compare/feature/deep...main" method="post"`);
    expect(html).toContain("New Pull Request");
  });

  it("the AllowEmptyPr same-ref control: main...main keeps the plain text and folds the form", async () => {
    // IsSameRef (services/git/compare.go:41-43 — same repository AND the
    // same resolved ref) folds acrossRepoPr, so AllowEmptyPr is false and
    // compare.tmpl:173's or-arm fails: the plain nothing_to_compare text,
    // NO form. (The default-fallback arm above drives this shape through the
    // parser's empty-head default; this pins it spelled out as the
    // AllowEmptyPr-false half of the fold.)
    const res = await get(`/${OWNER}/w105cmp/compare/main...main`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("There are no differences to show. There is no need to create a pull request.");
    expect(html).not.toContain("These branches are equal");
    expect(html).not.toContain('id="new-issue"');
    expect(html).not.toContain("New Pull Request");
    expect(html).not.toContain('id="diff-file-boxes"');
  });

  it("the ellipsis direction: base...head shows the HEAD side's commits and additions", async () => {
    const mainTip = w105Tips[MAIN_TIP];
    const deepTip = w105Tips[DEEP_TIP];
    if (mainTip === undefined || deepTip === undefined) throw new Error("w105 seed: tips missing");
    const res = await get(`/${OWNER}/w105cmp/compare/main...feature/deep`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The header's sha pair runs base (main) → separator → head (deep): the
    // main-tip link exists ONLY in that pair. The choose-branch segment
    // carries its own separator earlier in the page, so the separator
    // ORDER is asserted from the base link onward (the commits-table pair).
    const baseAt = html.indexOf(`href="/${OWNER}/w105cmp/commit/${mainTip}"`);
    const separatorAt = html.indexOf('<div class="compare-separator">...</div>', baseAt);
    const headAt = html.indexOf(`href="/${OWNER}/w105cmp/commit/${deepTip}"`);
    expect(baseAt).toBeGreaterThanOrEqual(0);
    expect(baseAt).toBeLessThan(separatorAt);
    expect(separatorAt).toBeLessThan(headAt);
    // The range's file boxes are the HEAD side's delta going base→head:
    // f1.txt (on base, not on head) DELETES with the -1,1 +0,0 hunk; f3.txt
    // ADDS with the -0,0 +1,1 hunk. An inverted (base-side) diff would carry
    // the mirrored hunks.
    expect(html).toContain('data-new-filename="f3.txt"');
    expect(html).toContain('data-old-filename="f1.txt"');
    expect(html).toContain("<code class=\"code-inner\">@@ -1,1 +0,0 @@</code>");
    expect(html).toContain("<code class=\"code-inner\">@@ -0,0 +1,1 @@</code>");
    expect(html).toContain("1 additions");
    expect(html).toContain("1 deletions");
    expect(html).toContain("2 changed files");
    // The switch link carries the reversed pair (the emitted URL re-parses
    // to the swapped comparison — compareLink's invariant).
    expect(html).toContain(`href="/${OWNER}/w105cmp/compare/feature/deep...main"`);
    expect(html).toContain("Switch head and base");
    expect(html).not.toContain("View Pull Request"); // no PR on this pair
  });

  it("the same-repo owner/name alias folds back onto the base repo (GetHeadOwnerAndRepo's same-owner arm)", async () => {
    // `main...{OWNER}/w105cmp:feature/docs` — the head owner is the base
    // owner AND the name is the base slug: compare.go:161-163 + 169-171
    // fold the head back onto the base repo — the render equals the plain
    // pair's. (The window-crosscompare flip of the old engine-owned pin.)
    const res = await get(`/${OWNER}/w105cmp/compare/main...${OWNER}/w105cmp:feature/docs`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="/${OWNER}/w105cmp/compare/main...feature/docs" method="post"`);
    expect(html).toContain("New Pull Request");
    expect(html).toContain(">pull from: <strong>w105gal/w105cmp:feature/docs</strong>");
  });
});

// --- the empty-PR create loop (the POST half of the AllowEmptyPr gate) -------------
// wave-129 completes the compare-parity loop: the create side is tips-blind —
// upstream's web POST (routers/web/repo/pull.go:1318 CompareAndPullRequestPost)
// has NO empty-diff gate (the AllowEmptyPr render gate, compare.go:400-402, is
// the only control) — so the equal-tips ACROSS-REF pair the render admits now
// creates, and the SAME-ref pair keeps the landed refusal (the headName ===
// baseName gate, upstream's IsSameRef reduction, services/git/compare.go:41-43).

describe("w105 the empty-PR create loop (the POST half of AllowEmptyPr)", () => {
  it("creates the across-ref equal-tips PR through the rendered AllowEmptyPr form: 303, rows at the shared tip, the head ref, the has-PR round trip", async () => {
    // The render half (the 2c240fa-admitted arm): main...main-mirror holds
    // equal tips with DIFFERING names — acrossRepoPr true, the form survives
    // the fold beside the and_allow_empty_pr segment.
    const pairPath = `/${OWNER}/w105priv/compare/main...main-mirror`;
    const res = await get(pairPath, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("These branches are equal. This PR will be empty.");
    expect(html).toContain(`action="${pairPath}" method="post"`);
    // The POST: upstream's create side never asks the tips — the empty PR
    // creates and 303s onto its detail page (JSONRedirect parity).
    const mainTip = w105Tips[MAIN_TIP];
    if (mainTip === undefined) throw new Error("w105 seed: main tip missing");
    const post = await fetchUi(
      pairPath,
      formPost(pairPath, { title: "w105: the empty pr", content: "mirror promotion" }, await cookieFor(OWNER)),
    );
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe(`/${OWNER}/w105priv/pulls/1`);
    // The rows: zero-diff semantics — headSha IS the base's tip (the shared
    // commit), mergeBase stays null (the form create carries none; the lazy
    // mergeability check computes it).
    const repoRow = (
      await drizzle(env.DB)
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, "w105priv")))
        .get()
    )!;
    const joined = await findPullRequestByIndex(env.DB, repoRow.id, 1);
    expect(joined).not.toBeNull();
    expect(joined?.issue.title).toBe("w105: the empty pr");
    expect(joined?.issue.content).toBe("mirror promotion");
    expect(joined?.pullRequest).toMatchObject({
      headBranch: "main-mirror",
      baseBranch: "main",
      headSha: mainTip,
      mergeBase: null,
    });
    // The refs/pull/1/head CAS write landed at the shared tip.
    const refNames = (await env.REPO.getByName(`${OWNER}/w105priv`).listRefs()).refs.map((ref) => ref.name);
    expect(refNames).toContain("refs/pull/1/head");
    // The round trip: the same pair arms to the existing-PR segment — the
    // form is gone (pullArms survives the fold at equal tips; the segment
    // rides it + the existing row).
    const after = await get(pairPath, OWNER);
    expect(after.status).toBe(200);
    const afterHtml = await after.text();
    expect(afterHtml).toContain("w105: the empty pr");
    expect(afterHtml).toContain("#1");
    expect(afterHtml).toContain(`href="/${OWNER}/w105priv/pulls/1"`);
    expect(afterHtml).toContain("View Pull Request");
    expect(afterHtml).not.toContain("pullrequest-form");
  });

  it("keeps the same-ref refusal: the hand-crafted main...main POST re-renders the 422 message and writes nothing", async () => {
    // IsSameRef holds (same repository, same resolved ref): the refusal is
    // the headName === baseName gate's verbatim API-route message, rendered
    // as the standalone negative message (the form is folded on this pair —
    // the same-ref control above pins that render half). Upstream's web POST
    // would create here (tips-blind, no gate at all) — the landed refusal is
    // the disclosed divergence this arm PINS (the mission's kept arm).
    const pairPath = `/${OWNER}/w105cmp/compare/main...main`;
    const before = await prRowCount("w105cmp");
    const post = await fetchUi(pairPath, formPost(pairPath, { title: "Nope" }, await cookieFor(OWNER)));
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("Invalid PullRequest: There are no changes between the head and the base");
    expect(await prRowCount("w105cmp")).toBe(before);
  });
});

describe("w105 form re-render + PR-create round trip (carried values)", () => {
  it("re-renders the empty-title refusal with the submitted values carried and writes nothing", async () => {
    const pairPath = `/${OWNER}/w105cmp/compare/main...feature/docs`;
    const res = await fetchUi(
      pairPath,
      formPost(pairPath, { title: "", content: "w105: the kept body" }, await cookieFor(OWNER)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("A title is required.");
    // The submitted values ride the re-render (the login failure
    // convention): the EMPTY title in the input…
    expect(html).toContain('placeholder="Title" value=""/>');
    // …and the kept body in the textarea (wave-13 pins the kept body on the
    // reverse pair; this pins the empty-title input's carried arm beside it).
    expect(html).toContain(">w105: the kept body</textarea>");
    // The refusal wrote nothing (the title check precedes the create).
    expect(await prRowCount("w105cmp")).toBe(0);
  });

  it("creates on the retried POST, lands the head ref, and the compare URL arms to the has-PR segment", async () => {
    const pairPath = `/${OWNER}/w105cmp/compare/main...feature/docs`;
    const res = await fetchUi(
      pairPath,
      formPost(pairPath, { title: "w105: the round-trip pr", content: "second body" }, await cookieFor(OWNER)),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OWNER}/w105cmp/pulls/1`);

    // The rows: the issue + the PR row with the cached head tip.
    const docsTip = w105Tips[DOCS_TIP];
    if (docsTip === undefined) throw new Error("w105 seed: docs tip missing");
    const repoRow = (
      await drizzle(env.DB)
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, "w105cmp")))
        .get()
    )!;
    const joined = await findPullRequestByIndex(env.DB, repoRow.id, 1);
    expect(joined).not.toBeNull();
    expect(joined?.issue.title).toBe("w105: the round-trip pr");
    expect(joined?.issue.content).toBe("second body");
    expect(joined?.pullRequest.headBranch).toBe("feature/docs");
    expect(joined?.pullRequest.baseBranch).toBe("main");
    expect(joined?.pullRequest.headSha).toBe(docsTip);

    // The refs/pull/1/head CAS write landed.
    const refNames = (await env.REPO.getByName(`${OWNER}/w105cmp`).listRefs()).refs.map((ref) => ref.name);
    expect(refNames).toContain("refs/pull/1/head");

    // The round trip: the SAME compare URL now arms to the existing-PR
    // segment — title, index, the View link — and the form is gone, while
    // the diff below stays.
    const after = await get(pairPath, OWNER);
    expect(after.status).toBe(200);
    const afterHtml = await after.text();
    expect(afterHtml).toContain("w105: the round-trip pr");
    expect(afterHtml).toContain("#1");
    expect(afterHtml).toContain(`href="/${OWNER}/w105cmp/pulls/1"`);
    expect(afterHtml).toContain("View Pull Request");
    expect(afterHtml).not.toContain("pullrequest-form");
    expect(afterHtml).toContain('id="diff-file-boxes"');
  });
});

// --- the cross-repo PR-create loop (the fork arm's write half) ----------------------
// The fork flow's POST: the write rides the landed create-compare seam (the
// API POST /pulls fork path's own sequence — crossRepoCreateMergeBase in the
// head cell, carryForkHeadIntoBase into the base cell, the headRepoId row,
// the refs/pull/N/head CAS in the BASE cell). Rides w105ghost as the BASE so
// the w105cmp PR indexes above stay undisturbed. Runs LAST: it consumes the
// fixture fork's branch pair.

describe("w105 the cross-repo create loop (the fork head's PR)", () => {
  it("creates the fork-head PR through the rendered form: 303, the headRepoId row with the computed merge base, the carried head ref, the has-PR round trip", async () => {
    if (w105ForkTip === null) throw new Error("w105 seed: fork tip missing");
    const pairPath = `/${OWNER}/w105ghost/compare/main...${STRANGER}/w105fork:feature/fork`;
    // The render half: the writer form on the cross-repo pair (the ghost is
    // the base, the fork the head), the commits table reading the HEAD cell.
    const res = await get(pairPath, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="${pairPath}" method="post"`);
    expect(html).toContain("New Pull Request");
    expect(html).toContain("w105: fork-only change</a>"); // the head cell's range
    expect(html).toContain(`href="/${STRANGER}/w105fork/commit/${w105ForkTip}"`); // CommitRepoLink = the head repo
    // The POST: the landed fork seam — the merge base computes in the FORK
    // cell, the fork-only closure carries into the ghost cell, the row lands
    // with headRepoId = the fork, and refs/pull/1/head CAS-writes in the
    // GHOST cell at the fork tip.
    const post = await fetchUi(
      pairPath,
      formPost(pairPath, { title: "w105: the fork pr", content: "from the fork" }, await cookieFor(OWNER)),
    );
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe(`/${OWNER}/w105ghost/pulls/1`);
    const ghostRow = (
      await drizzle(env.DB)
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, "w105ghost")))
        .get()
    )!;
    const forkRow = (
      await drizzle(env.DB)
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, STRANGER), eq(repositories.slug, "w105fork")))
        .get()
    )!;
    const mainTip = w105Tips[MAIN_TIP];
    if (mainTip === undefined) throw new Error("w105 seed: main tip missing");
    const joined = await drizzle(env.DB)
      .select({ headRepoId: pullRequests.headRepoId, headBranch: pullRequests.headBranch, baseBranch: pullRequests.baseBranch, headSha: pullRequests.headSha, mergeBase: pullRequests.mergeBase })
      .from(pullRequests)
      .where(eq(pullRequests.baseRepoId, ghostRow.id))
      .get();
    expect(joined).toMatchObject({
      headRepoId: forkRow.id,
      headBranch: "feature/fork",
      baseBranch: "main",
      headSha: w105ForkTip,
      mergeBase: mainTip,
    });
    // The carried head ref in the GHOST cell (the carry made the fork-only
    // objects present there).
    const ghostRefs = (await env.REPO.getByName(`${OWNER}/w105ghost`).listRefs()).refs.map((ref) => ref.name);
    expect(ghostRefs).toContain("refs/pull/1/head");
    // The round trip: the same fork-form URL arms to the existing-PR
    // segment — the cross-repo duplicate check keyed on the HEAD repo.
    const after = await get(pairPath, OWNER);
    expect(after.status).toBe(200);
    const afterHtml = await after.text();
    expect(afterHtml).toContain("w105: the fork pr");
    expect(afterHtml).toContain("#1");
    expect(afterHtml).toContain(`href="/${OWNER}/w105ghost/pulls/1"`);
    expect(afterHtml).toContain("View Pull Request");
    expect(afterHtml).not.toContain("pullrequest-form");
  });
});

// --- the two-dot POST (runs LAST: it creates a w105cmp PR row, so every
// index-sensitive arm above must already have run) ---------------------------

describe("w105 the two-dot POST (the separator-blind create)", () => {
  it("keeps the POST separator-blind (upstream's tips- and separator-blind create): a hand-crafted .. POST creates", async () => {
    // pull.go:1318 CompareAndPullRequestPost has NO DirectComparison gate —
    // the form fold (compare.tmpl:173) is the only control — so the
    // hand-crafted main..feature/deep POST creates like its ... twin (a
    // different head branch than the round-trip pair, so the two rows stay
    // disjoint). The location index is whichever open PR count precedes it —
    // the row is asserted by its branch pair, not the index.
    const pairPath = `/${OWNER}/w105cmp/compare/main..feature/deep`;
    const deepTip = w105Tips[DEEP_TIP];
    if (deepTip === undefined) throw new Error("w105 seed: deep tip missing");
    const post = await fetchUi(pairPath, formPost(pairPath, { title: "w105: the twodot pr" }, await cookieFor(OWNER)));
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toMatch(new RegExp(`^/${OWNER}/w105cmp/pulls/\\d+$`));
    const repoRow = (
      await drizzle(env.DB)
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, "w105cmp")))
        .get()
    )!;
    const joined = await drizzle(env.DB)
      .select({ headBranch: pullRequests.headBranch, baseBranch: pullRequests.baseBranch, headSha: pullRequests.headSha, mergeBase: pullRequests.mergeBase })
      .from(pullRequests)
      .where(and(eq(pullRequests.baseRepoId, repoRow.id), eq(pullRequests.headBranch, "feature/deep")))
      .get();
    expect(joined).toMatchObject({ headBranch: "feature/deep", baseBranch: "main", headSha: deepTip });
  });
});
