/**
 * Pages wave 3 route tests (SPEC-0008 U3 extension): the issue/PR detail
 * pages (pages/issue-detail.tsx) over `/issues/{index}` + `/pulls/{index}` —
 * the upstream type/URL cross-redirect, the title bar, the shared markdown
 * bodies, the comment/event timeline, the reduced sidebar and the cached
 * mergeability summary. Same harness posture as pages-wave2.test.ts: the
 * router is driven directly with the synthetic ASSETS manifest and the
 * issue block is seeded through the landed IssuesService / label service
 * with fixed `now` values — every render is byte-deterministic.
 *
 * The detail page is pure D1 (no engine reads), so a row-only sibling repo
 * covers the negative §2.5 paths. Slugs are distinct from the other files
 * ("wave3" / "wave3-secret") so fixture rows never collide.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createRepoLabel, findRepoLabelByName } from "../../api/services/labels";
import { issues, repositories, users } from "../../db/schema";
import { uiRouter } from "../index";
import { IssuesService } from "../../issues/service";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`), uiEnv);
}

// --- fixtures -----------------------------------------------------------------

const WAVE3_COMMITS: SeedCommit[] = [
  {
    message: "seed: readme",
    time: T0,
    files: [{ path: "README.md", content: "# wave3 seed\n" }],
  },
];

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

/** Fixture handles rehydrated after (potentially rolled-back) seeding. */
interface Wave3Fixture {
  bugLabelId: number;
}

let wave3Fixture: Wave3Fixture | null = null;

/**
 * Seed the wave-3 issue block: one label, one milestone, one fully-loaded
 * issue (labels + milestone + markdown body + a comment, closed then
 * reopened — the full lifecycle timeline), one bare issue, one open PR and
 * one closed PR, plus a mirrored-import row with no user poster. Every
 * write passes a fixed `now` (deterministic event lines and counts).
 *
 * Idempotent like ensureWave2Issues: any existing issue row skips creation.
 */
async function ensureWave3Issues(): Promise<Wave3Fixture> {
  if (wave3Fixture !== null) return wave3Fixture;
  const db = drizzle(env.DB);
  const repo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave3")))
    .get();
  if (repo === undefined) throw new Error("wave3 repo row missing");
  const owner = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get();
  if (owner === undefined) throw new Error("wave3 owner row missing");

  const rehydrate = async (): Promise<Wave3Fixture> => {
    const bug = await findRepoLabelByName(env.DB, repo.id, "bug");
    if (bug === null) throw new Error("wave3 labels missing on rehydrate");
    return { bugLabelId: bug.id };
  };
  const existing = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, repo.id)).limit(1).all();
  if (existing.length > 0) {
    wave3Fixture = await rehydrate();
    return wave3Fixture;
  }

  const svc = new IssuesService(env.DB);
  const bug = await createRepoLabel(env.DB, repo.id, {
    name: "bug",
    exclusive: false,
    color: "#ee0701",
    description: "Something is broken",
    isArchived: false,
    now: t(0),
  });
  const milestone = await svc.createMilestone({ repoId: repo.id, name: "v2.0", now: t(0) });

  // Issue #1: the full-lifecycle detail fixture (created → commented →
  // closed → reopened; numComments folds every system comment in).
  const lifecycle = await svc.createIssue({
    repoId: repo.id,
    title: "wave3: renderer crashes on empty tree",
    content: "Steps:\n\n- open the **tree** page\n- see it crash\n\nSee [the guide](docs/guide.md) for context.",
    posterId: owner.id,
    milestoneId: milestone.id,
    labelIds: [bug.id],
    now: t(100),
  });
  await svc.addComment({ issueId: lifecycle.id, posterId: owner.id, content: "Reproduced on **two** machines.", now: t(150) });
  await svc.closeIssue(lifecycle.id, { now: t(200) });
  await svc.reopenIssue(lifecycle.id, { now: t(250) });

  // Issue #2: bare (no body, no labels, no milestone) → no-content variant.
  await svc.createIssue({ repoId: repo.id, title: "wave3: bare issue", posterId: owner.id, now: t(300) });

  // Issue #3: open PR (checking mergeability — the cached-state render).
  await svc.createPullRequest({
    repoId: repo.id,
    title: "wave3: feature branch",
    posterId: owner.id,
    headRepoId: repo.id,
    baseBranch: "main",
    headBranch: "feature-wave3",
    content: "Implements the thing.",
    now: t(400),
  });

  // Issue #4: closed PR → Closed state label, no merge box.
  const closedPull = await svc.createPullRequest({
    repoId: repo.id,
    title: "wave3: closed pull",
    posterId: owner.id,
    headRepoId: repo.id,
    baseBranch: "main",
    headBranch: "closed-branch",
    now: t(500),
  });
  await svc.closeIssue(closedPull.issue.id, { now: t(550) });

  // Issue #5: mirrored import — no user poster, original_author carries the
  // display name (upstream renders it instead of the poster link).
  await db.insert(issues).values({
    repoId: repo.id,
    index: 5,
    title: "wave3: imported issue",
    isPull: false,
    originalAuthor: "legacy-user",
    createdAt: t(600),
    updatedAt: t(600),
  });

  wave3Fixture = { bugLabelId: bug.id };
  return wave3Fixture;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "wave3", commits: WAVE3_COMMITS });
  // A private sibling for the §2.5 negative paths (row only — resolution
  // 404s before any page work).
  const db = drizzle(env.DB);
  const source = await db
    .select({ ownerId: repositories.ownerId })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave3")))
    .get();
  const id = crypto.randomUUID();
  await db.insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: "alice",
    ownerId: source?.ownerId,
    slug: "wave3-secret",
    visibility: "private",
  });
});

// --- the issue detail page ------------------------------------------------------

describe("issue detail page (/issues/{index})", () => {
  let fixture: Wave3Fixture;

  beforeAll(async () => {
    fixture = await ensureWave3Issues();
  });

  it("renders the upstream title bar: h1 + #index, state label, meta line with comment count", async () => {
    const res = await fetchUi("/alice/wave3/issues/1");
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('<title>#1 - wave3: renderer crashes on empty tree - alice/wave3</title>');
    expect(html).toContain('<div role="main" aria-label="#1 - wave3: renderer crashes on empty tree" class="page-content repository view issue pull">');
    expect(html).toContain('<div class="issue-title-header">');
    expect(html).toContain("<h1>wave3: renderer crashes on empty tree <span class=\"index\">#1</span></h1>");
    // Reopened → the open state label with its issue-opened glyph (2-path,
    // carried by the wave-4 multi-path Icon).
    expect(html).toContain('<div class="ui green label issue-state-label">');
    expect(html).toContain('class="svg octicon-issue-opened"');
    expect(html).toContain(" Open</div>");
    // Meta line: opened + fixed-epoch relative-time + poster (plain text) + count.
    expect(html).toContain('<span class="time-desc">opened <relative-time prefix="" tense="past"');
    expect(html).toContain(" by alice · 3 comments</span>");
    // The issues tab is active, pulls is not.
    expect(html).toContain('<a class="active item" href="/alice/wave3/issues" data-shortcut-keys="g i">');
    expect(html).toContain('<a class="item" href="/alice/wave3/pulls" data-shortcut-keys="g p">');
  });

  it("renders the description through the shared markdown pipeline (comment mode)", async () => {
    const html = await (await fetchUi("/alice/wave3/issues/1")).text();
    expect(html).toContain('<div id="issue-');
    expect(html).toContain('class="timeline-item comment issue-content-comment"');
    // Emphasis + the relative link rewritten onto the branch-prefixed /src
    // pages (the §3.4 posture; the pipeline's default-branch fallback).
    expect(html).toContain("open the <strong>tree</strong> page");
    expect(html).toContain('<a href="https://test.local/alice/wave3/src/branch/main/docs/guide.md" rel="nofollow">the guide</a>');
    // The comment body renders through the same pipeline.
    expect(html).toContain("Reproduced on <strong>two</strong> machines.");
  });

  it("renders the timeline: comment card + close/reopen event lines with anchors", async () => {
    const html = await (await fetchUi("/alice/wave3/issues/1")).text();
    expect(html).toContain('<div id="issuecomment-1" class="timeline-item comment">');
    // Close event (red badge carrying the 2-path octicon-issue-closed —
    // wave-4 multi-path Icon; the seeded transition carries no actor, so the
    // verb stands alone).
    expect(html).toContain('<div id="event-2" class="timeline-item event">');
    expect(html).toContain('<span class="badge tw-bg-red tw-text-white"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" class="svg octicon-issue-closed"');
    expect(html).toContain('closed this issue <a id="event-2" href="#event-2"');
    // Reopen event (green badge with the dot glyph).
    expect(html).toContain('<span class="badge tw-bg-green tw-text-white">');
    expect(html).toContain('class="svg octicon-dot-fill"');
    expect(html).toContain('reopened this issue <a id="event-3" href="#event-3"');
    // Chronology: the comment precedes the close, the close precedes the reopen.
    const commentAt = html.indexOf('id="issuecomment-');
    const closeAt = html.indexOf("closed this issue");
    const reopenAt = html.indexOf("reopened this issue");
    expect(commentAt).toBeGreaterThan(-1);
    expect(closeAt).toBeGreaterThan(commentAt);
    expect(reopenAt).toBeGreaterThan(closeAt);
  });

  it("renders the reduced sidebar: label badges into the live filters, plain-text milestone", async () => {
    const html = await (await fetchUi("/alice/wave3/issues/1")).text();
    expect(html).toContain('<div class="issue-content-right ui segment">');
    // The ContrastColor badge with the upstream inline styles…
    expect(html).toContain("background-color: #ee0701");
    expect(html).toContain("color: #fff");
    // …linking into the live list filter (wave-2 QueryBuild parity)…
    expect(html).toContain(`<a class="item" href="/alice/wave3/issues?labels=${fixture.bugLabelId}">`);
    // …and the milestone as plain text (no /milestone/{id} dead link) with
    // the single-path milestone glyph.
    expect(html).toContain('<span class="item"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="18" height="18" class="svg octicon-milestone tw-shrink-0"');
    expect(html).toContain(">v2.0</span>");
    expect(html).not.toContain("/milestone/");
    // The edit dropdowns (write actions) are not rendered.
    expect(html).not.toContain('class="ui dropdown full-width');
  });

  it("renders the no-content variant for a body-less issue", async () => {
    const html = await (await fetchUi("/alice/wave3/issues/2")).text();
    expect(html).toContain('<span class="no-content">No description provided.</span>');
    expect(html).toContain('<span class="item empty-list">No labels</span>');
    expect(html).toContain('<span class="item empty-list">No Milestone</span>');
    // Meta line without a comment pluralization error at 0.
    expect(html).toContain(" by alice · 0 comments</span>");
  });

  it("renders the mirrored-import poster as plain original_author text", async () => {
    const html = await (await fetchUi("/alice/wave3/issues/5")).text();
    expect(html).toContain("opened <relative-time");
    expect(html).toContain(" by legacy-user · 0 comments</span>");
    expect(html).not.toContain(" by null");
  });

  it("is byte-deterministic on repeat renders", async () => {
    const first = await fetchUi("/alice/wave3/issues/1");
    const second = await fetchUi("/alice/wave3/issues/1");
    expect(await second.text()).toBe(await first.text());
  });
});

// --- the PR twin (/pulls/{index}) ----------------------------------------------

describe("pull request detail (/pulls/{index})", () => {
  beforeAll(async () => {
    await ensureWave3Issues();
  });

  it("renders the open PR: state label with the PR glyph, branch-pair desc, cached mergeability box", async () => {
    const res = await fetchUi("/alice/wave3/pulls/3");
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('<title>#3 - wave3: feature branch - alice/wave3</title>');
    expect(html).toContain('<div class="ui green label issue-state-label">');
    expect(html).toContain('class="svg octicon-git-pull-request"');
    // Upstream pull-desc: poster + wants-to-merge with <code> branch names
    // (unlinked, no commit count — engine reads, issue-detail.tsx header).
    expect(html).toContain('<span id="pull-desc-display" class="pull-desc">alice wants to merge <code>feature-wave3</code> into <code>main</code></span>');
    // The reduced merge box with the checking note (cached row state).
    expect(html).toContain('class="timeline-item comment pull-merge-box"');
    expect(html).toContain("Pull request mergeability is being computed.");
    expect(html).toContain('class="timeline-avatar"');
    expect(html).toContain('class="svg octicon-git-merge"');
    // The pulls tab is active.
    expect(html).toContain('<a class="active item" href="/alice/wave3/pulls" data-shortcut-keys="g p">');
    // The PR body renders through the shared pipeline.
    expect(html).toContain("Implements the thing.");
    // Wave 5: the reduced tab menu (Conversation + Files — the Commits page
    // does not exist, its tab is not a dead link emitted; text-only items,
    // the tab octicons are outside the generated allowlist).
    expect(html).toContain('<div class="ui pull tabs container">');
    expect(html).toContain('<a class="active item" href="/alice/wave3/pulls/3">Conversation<span class="ui small label">0</span></a>');
    expect(html).toContain('<a class="item" href="/alice/wave3/pulls/3/files">Files Changed<span class="ui small label">-</span></a>');
    // …and no Commits tab (that page does not exist — no dead links).
    expect(html).not.toContain('/alice/wave3/pulls/3/commits');
  });

  it("renders the closed PR: closed state with the closed-PR glyph and no merge box", async () => {
    const html = await (await fetchUi("/alice/wave3/pulls/4")).text();
    expect(html).toContain('<div class="ui red label issue-state-label">');
    expect(html).toContain('class="svg octicon-git-pull-request-closed"');
    expect(html).toContain(" Closed</div>");
    // The close EVENT line uses the pull verb…
    expect(html).toContain('closed this pull request <a id="event-4" href="#event-4"');
    // …and the merge box is a live-PR-only section.
    expect(html).not.toContain("pull-merge-box");
  });

  it("303s the upstream type/URL match in both directions (issue_view.go:347-352)", async () => {
    // A PR addressed in the issues family redirects onto its pulls link…
    const pr = await fetchUi("/alice/wave3/issues/3");
    expect(pr.status).toBe(303);
    expect(pr.headers.get("location")).toBe("/alice/wave3/pulls/3");
    // …and an issue addressed in the pulls family redirects onto issues.
    const issue = await fetchUi("/alice/wave3/pulls/1");
    expect(issue.status).toBe(303);
    expect(issue.headers.get("location")).toBe("/alice/wave3/issues/1");
  });
});

// --- negative paths ---------------------------------------------------------

describe("issue detail negative paths", () => {
  beforeAll(async () => {
    await ensureWave3Issues();
  });

  it("404-shells an unknown index with the repo context kept (§4.5)", async () => {
    const res = await fetchUi("/alice/wave3/issues/99");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<div class="status-page-error">');
    expect(html).toContain("repo-header");
  });

  it("404-shells a negative index admitted by the parser (chi ParseInt parity)", async () => {
    const res = await fetchUi("/alice/wave3/issues/-1");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div class="status-page-error">');
  });

  it("leaves non-numeric and deeper tails engine-owned (404 from the sub-app, never a page)", async () => {
    // (/issues/new became the wave-4 form family — pages-wave4.test.ts owns
    // its behavior; it no longer 404s here.)
    for (const path of ["/alice/wave3/issues/abc"]) {
      const res = await fetchUi(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("issue-title-header");
    }
    // (/issues/{n}/comments became the wave-5 write family — its GET answers
    // chi's 405; pages-wave5.test.ts owns the POST behavior.)
  });

  it("404-shells private repos before any issue work (§2.5)", async () => {
    const res = await fetchUi("/alice/wave3-secret/issues/1");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<div class="status-page-error">');
    expect(html).not.toContain("repo-header");
  });
});

// --- the §5.5 a11y smoke ----------------------------------------------------

describe("wave-3 a11y smoke", () => {
  beforeAll(async () => {
    await ensureWave3Issues();
  });

  it("the live issue and PR pages pass the structural rules", async () => {
    for (const path of ["/alice/wave3/issues/1", "/alice/wave3/pulls/3", "/alice/wave3/issues/2"]) {
      const violations = runA11y(await (await fetchUi(path)).text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
