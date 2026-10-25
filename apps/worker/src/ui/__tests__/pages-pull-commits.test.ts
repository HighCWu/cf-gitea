/**
 * The PR commits tab route tests (SPEC-0008 U3 extension): the three-tab
 * menu's middle member — `/{owner}/{repo}/pulls/{index}/commits` (upstream
 * ViewPullCommits, routers/web/repo/pull.go:631-668; pages/pull-commits.tsx
 * cites the template arms line by line).
 *
 * Same harness posture as pages-wave2..16: the router is driven directly
 * with the synthetic ASSETS manifest over REAL pushed engine content
 * (testing/seed-repo.ts) — main, feature (main + 2 commits, PR #1's head
 * ref), bulk (feature + 52 more commits in the single linear pack, PR #2's
 * head ref — the pagination arm; its range is therefore 54 commits) —
 * seeded through the landed receive flow, the PR rows through the landed
 * IssuesService with fixed `now` values, anonymous reads throughout (the
 * page is a public read).
 *
 * Read posture under test: the merge-base..head range composition (the
 * pullRequestDiff order — cached row merge base first, the engine RPC as
 * the fallback), the engine's oldest-first walk reversed into the
 * commits_list display order, the fetched-page count degradation (module
 * header), the upstream NotFound arms (unknown index, non-pull row,
 * unresolvable refs/pull head), and the tab menu rendering all three
 * members with the active state.
 */

import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { issues, repositories, users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { IssuesService } from "../../issues/service";
import {
  buildHistoryPack,
  buildReceivePackBody,
  ensureSeededRepo,
  type SeedCommit,
} from "../testing/seed-repo";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`), uiEnv);
}

// --- fixtures -----------------------------------------------------------------

const REPO = "alice/pull-commits";

const README = "# pull-commits\n";

const FEATURE_A = "feature file a\n";
const FEATURE_B = "feature file b\n";
const BULK = "bulk branch line\n";

/** main (1 commit) + feature's two commits + the 52 bulk commits — one
 *  LINEAR history (the pack builder is single-stranded), so bulk branches
 *  off feature's head: tips indices are the fixture's contract (0 = main,
 *  2 = feature, 54 = bulk's head), PR #1's range is 2 commits and PR #2's
 *  is 54. Fixed times/contents → deterministic oids. */
const ALL_COMMITS: SeedCommit[] = [
  { message: "base: the main readme", time: T0, files: [{ path: "README.md", content: README }] },
  {
    message: "pc: first change",
    time: T0 + 60,
    files: [
      { path: "README.md", content: README },
      { path: "feature-a.txt", content: FEATURE_A },
    ],
  },
  {
    message: "pc: second change\n\nThe body line stays out of the subject.",
    time: T0 + 120,
    files: [
      { path: "README.md", content: README },
      { path: "feature-a.txt", content: FEATURE_A },
      { path: "feature-b.txt", content: FEATURE_B },
    ],
  },
  ...Array.from({ length: 52 }, (_, i): SeedCommit => ({
    message: `bulk: commit ${i + 1}`,
    time: T0 + 200 + i,
    files: [
      { path: "README.md", content: README },
      { path: "bulk.txt", content: BULK },
    ],
  })),
];

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

interface PullCommitsFixture {
  /** The pack's tips, oldest → newest (0 = main, 2 = feature, 54 = bulk). */
  tips: string[];
}

let fixture: PullCommitsFixture | null = null;

/**
 * Seed the block: the engine refs ONCE (guarded on refs/pull/1/head like
 * the wave-5 fixture — main at tips[0], feature at tips[2], bulk at
 * tips[54], the PR head refs for #1 and #2, deliberately NONE for #3),
 * then the D1 issue block through the landed service (PR #1 feature→main,
 * PR #2 bulk→main, PR #3 whose head ref never landed — the upstream
 * NotFound arm, and plain issue #4 — the non-pull 404 arm).
 */
async function ensurePullCommitsFixtures(): Promise<PullCommitsFixture> {
  if (fixture !== null) return fixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();
  await seedVerifiedUser({ username: "alice" });
  const owner = await db.select().from(users).where(eq(users.usernameLower, "alice")).get();
  if (owner === undefined) throw new Error("pull-commits owner row missing");

  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner.id, "ui-page-seed-pull-commits-refs")
    .run();
  const token = (await mintFor(owner.id, "ui-page-seed-pull-commits-refs", "write:repository")).plaintext;
  const refs = await env.REPO.getByName(REPO).listRefs();
  const refNames = new Set((refs?.refs ?? []).map((ref) => ref.name));
  if (!refNames.has("refs/pull/1/head")) {
    const { tips, pack } = await buildHistoryPack(ALL_COMMITS);
    const updates: { ref: string; oid: string }[] = [];
    if (!refNames.has("refs/heads/main")) updates.push({ ref: "refs/heads/main", oid: tips[0] as string });
    if (!refNames.has("refs/heads/feature")) updates.push({ ref: "refs/heads/feature", oid: tips[2] as string });
    if (!refNames.has("refs/heads/bulk")) updates.push({ ref: "refs/heads/bulk", oid: tips[54] as string });
    updates.push({ ref: "refs/pull/1/head", oid: tips[2] as string });
    updates.push({ ref: "refs/pull/2/head", oid: tips[54] as string });
    const response = await SELF.fetch(`https://test.local/${REPO}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
      body: buildReceivePackBody(updates, pack),
    });
    const body = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    if (response.status !== 200 || body.includes("ng ")) {
      throw new Error(`pull-commits ref push failed: ${response.status} ${body.slice(0, 400)}`);
    }
  }
  const seeded = await ensureSeededRepo({ owner: "alice", slug: "pull-commits", commits: ALL_COMMITS });

  const repo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "pull-commits")))
    .get();
  if (repo === undefined) throw new Error("pull-commits repo row missing");
  const existing = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, repo.id)).limit(1).all();
  if (existing.length === 0) {
    const svc = new IssuesService(env.DB);
    await svc.createPullRequest({
      repoId: repo.id,
      title: "pc: the feature PR",
      posterId: owner.id,
      headRepoId: repo.id,
      baseBranch: "main",
      headBranch: "feature",
      now: t(10),
    });
    await svc.createPullRequest({
      repoId: repo.id,
      title: "pc: the bulk PR",
      posterId: owner.id,
      headRepoId: repo.id,
      baseBranch: "main",
      headBranch: "bulk",
      now: t(20),
    });
    await svc.createPullRequest({
      repoId: repo.id,
      title: "pc: the head-ref-less PR",
      posterId: owner.id,
      headRepoId: repo.id,
      baseBranch: "main",
      headBranch: "ghost",
      now: t(30),
    });
    await svc.createIssue({ repoId: repo.id, title: "pc: a plain issue", posterId: owner.id, now: t(40) });
  }

  fixture = { tips: seeded.tips };
  return fixture;
}

beforeAll(async () => {
  await ensurePullCommitsFixtures();
});

// --- the parser family ----------------------------------------------------------

describe("PR commits parser family (parseUiRoute / handlesUiRoute)", () => {
  it("claims exactly /pulls/{index}/commits", () => {
    expect(parseUiRoute("/alice/pull-commits/pulls/1/commits")).toEqual({
      family: "pull-commits",
      owner: "alice",
      repo: "pull-commits",
      index: 1,
    });
    expect(handlesUiRoute("/alice/pull-commits/pulls/1/commits")).toBe(true);
  });

  it("never claims the issues family twin or the deeper tails", () => {
    // The commits tab hangs off the pulls group only (upstream web.go).
    expect(parseUiRoute("/alice/pull-commits/issues/1/commits")).toBeNull();
    expect(handlesUiRoute("/alice/pull-commits/issues/1/commits")).toBe(false);
    expect(parseUiRoute("/alice/pull-commits/pulls/1/commits/extra")).toBeNull();
  });
});

// --- the page -------------------------------------------------------------------

describe("PR commits page (/pulls/{index}/commits)", () => {
  it("renders the upstream page frame: discriminator, title bar, the three-tab menu with Commits active", async () => {
    const res = await fetchUi("/alice/pull-commits/pulls/1/commits");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      '<div role="main" aria-label="#1 - pc: the feature PR" class="page-content repository view issue pull commits">',
    );
    expect(html).toContain('<div class="ui container">');
    expect(html).toContain('<h1>pc: the feature PR <span class="index">#1</span></h1>');
    // The three members in tab_menu.tmpl's order, the real counts where the
    // page owns them, upstream's "-" branch where a count would cost the
    // engine read (the module header's symmetric degradation).
    expect(html).toContain('<a class="item" href="/alice/pull-commits/pulls/1">Conversation<span class="ui small label">0</span></a>');
    expect(html).toContain('<a class="active item" href="/alice/pull-commits/pulls/1/commits">Commits<span class="ui small label">2</span></a>');
    expect(html).toContain('<a class="item" href="/alice/pull-commits/pulls/1/files">Files Changed<span class="ui small label">-</span></a>');
    // The commits_table count line (the compare family's sha pair never renders here).
    expect(html).toContain('<div class="ui top attached header flex-left-right"><div class="flex-text-block">2 Commits</div></div>');
  });

  it("renders the range newest-first with the commits_list row shape", async () => {
    const { tips } = await ensurePullCommitsFixtures();
    const html = await (await fetchUi("/alice/pull-commits/pulls/1/commits")).text();
    // The commits_list table (components/commit-list) with its header row.
    expect(html).toContain('<table class="ui very basic table unstackable" id="commits-table">');
    expect(html).toContain('<tbody class="commit-list">');
    // Two rows, display order newest first (the engine walk is oldest first).
    const firstRow = html.indexOf("pc: second change");
    const secondRow = html.indexOf("pc: first change");
    expect(firstRow).toBeGreaterThan(-1);
    expect(secondRow).toBeGreaterThan(firstRow);
    // Subject links + the short-sha labels onto the commit view.
    expect(html).toContain(`<a href="/alice/pull-commits/commit/${tips[2]}">pc: second change</a>`);
    expect(html).toContain(`<a href="/alice/pull-commits/commit/${tips[1]}">pc: first change</a>`);
    expect(html).toContain(`<a href="/alice/pull-commits/commit/${tips[2]}" class="ui label commit-id-short" rel="nofollow">`);
    // The author cell (the seed's fixed person line) and a relative date.
    expect(html).toContain('<td class="author">Test User</td>');
    expect(html).toContain("<relative-time");
    // The multi-line message's body never leaks into the subject cell.
    expect(html).not.toContain("The body line stays out of the subject.");
  });

  it("the conversation page now renders the Commits tab with the empty-count branch", async () => {
    const res = await fetchUi("/alice/pull-commits/pulls/1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a class="active item" href="/alice/pull-commits/pulls/1">Conversation<span class="ui small label">0</span></a>');
    expect(html).toContain('<a class="item" href="/alice/pull-commits/pulls/1/commits">Commits<span class="ui small label">-</span></a>');
    expect(html).toContain('<a class="item" href="/alice/pull-commits/pulls/1/files">Files Changed<span class="ui small label">-</span></a>');
  });
});

// --- pagination -----------------------------------------------------------------

describe("PR commits pagination (the fetched-page degradation)", () => {
  it("pages the 54-commit range at the CommitsRangeSize, Older on page 1", async () => {
    const html = await (await fetchUi("/alice/pull-commits/pulls/2/commits")).text();
    expect(html).toContain("<div class=\"flex-text-block\">50 Commits</div>");
    // The oldest page first — and the linear fixture puts the two feature
    // commits INSIDE PR #2's range (bulk branches off feature's head in the
    // single-pack history): ordered = [pc:first, pc:second, bulk1..bulk52].
    expect(html).toContain(">bulk: commit 1</a>");
    expect(html).toContain(">bulk: commit 48</a>");
    expect(html).not.toContain(">bulk: commit 49</a>");
    expect(html).not.toContain(">bulk: commit 52</a>");
    expect(html).toContain('<a class="item navigation" href="/alice/pull-commits/pulls/2/commits?page=2">');
    expect(html).toContain("Older");
    expect(html).not.toContain("Newer");
  });

  it("page 2 carries the range tail and the Newer link", async () => {
    const res = await fetchUi("/alice/pull-commits/pulls/2/commits?page=2");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<div class=\"flex-text-block\">4 Commits</div>");
    // The remaining four commits, newest first.
    const at = (subject: string): number => html.indexOf(`>${subject}</a>`);
    expect(at("bulk: commit 52")).toBeGreaterThan(-1);
    expect(at("bulk: commit 52")).toBeLessThan(at("bulk: commit 51"));
    expect(at("bulk: commit 51")).toBeLessThan(at("bulk: commit 50"));
    expect(at("bulk: commit 50")).toBeLessThan(at("bulk: commit 49"));
    expect(html).not.toContain(">bulk: commit 48</a>");
    // The Newer link targets page 1 (no page param, the canonical URL).
    expect(html).toContain('<a class="item navigation" href="/alice/pull-commits/pulls/2/commits">');
    expect(html).toContain("Newer");
    expect(html).not.toContain("Older");
  });
});

// --- the 404 family -------------------------------------------------------------

describe("PR commits 404 arms (upstream ViewPullCommits NotFound posture)", () => {
  it("404-shells an unknown index, a negative index, and a non-pull row", async () => {
    expect((await fetchUi("/alice/pull-commits/pulls/99/commits")).status).toBe(404);
    expect((await fetchUi("/alice/pull-commits/pulls/-1/commits")).status).toBe(404);
    // Issue #4 addressed in the pulls family → 404 (the route is pulls-only;
    // the cross-family redirect stays the detail route's behavior).
    expect((await fetchUi("/alice/pull-commits/pulls/4/commits")).status).toBe(404);
  });

  it("404-shells the PR whose refs/pull head never landed (the HeadCommitID == \"\" arm)", async () => {
    const res = await fetchUi("/alice/pull-commits/pulls/3/commits");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("commits-table");
  });

  it("keeps the unclaimed issues-family twin engine-owned (404)", async () => {
    expect((await fetchUi("/alice/pull-commits/issues/1/commits")).status).toBe(404);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("PR commits a11y smoke", () => {
  it("the commits renders (both pages) and the three-tab conversation pass the structural rules", async () => {
    for (const path of ["/alice/pull-commits/pulls/1/commits", "/alice/pull-commits/pulls/2/commits?page=2", "/alice/pull-commits/pulls/1"]) {
      const res = await fetchUi(path);
      expect(res.status).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
