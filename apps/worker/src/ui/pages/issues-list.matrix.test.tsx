/**
 * The issues/pulls list family's DEFERRED route-level matrix (pages/
 * issues-list.tsx mounted at /:owner/:repo/issues + /:owner/:repo/pulls —
 * pages wave 2 (SPEC-0008 U3 extension, ui/__tests__/pages-wave2.test.ts)
 * owns the base arms: the parse claims, the open-list row shape/ordering,
 * the closed tab, the 20-per-page pager with its page<1 clamp, the
 * single-label and by-name milestone facets, the empty state, the anon
 * private/unknown 404s and the a11y smoke. THIS FILE adds the arms wave2
 * does not carry, driven over the mounted uiRouter with the notifications
 * 28b71b9 matrix's minted-session pattern):
 *
 *   - the viewer gates: wave2's private-repo 404 is anonymous-only — the
 *     minted-session pattern proves the signed-in OWNER renders their own
 *     private repo's list (readGrant's isOwner arm) while a signed-in
 *     NON-owner still 404-shells (sessions buy no visibility) and the
 *     signed-in chrome (the navbar bell, no Sign In) rides the page;
 *   - the state/page degrade shapes: unknown ?state= degrades to the open
 *     tab (parseListState's default branch), junk ?page= parses as 1, and
 *     a past-the-end page renders the empty state WITH a Newer link back
 *     (the §4.11 no-upper-clamp note — no last-page clamp, unlike the
 *     notifications page);
 *   - the facet-preserving pager over 21 labeled issues: tab counts computed
 *     over the SAME facet (21 Open / 1 Closed), the Older/Newer links and
 *     the closed tab carrying labels (+state) through, and the closed row's
 *     label badge echoing state=closed;
 *   - the filter-parsing arms: parseLabelIds' drop-then-apply (garbage-only
 *     ?labels= filters nothing; a mixed list keeps the valid ids), the
 *     any-of (OR) multi-label semantics (indexer IncludedLabelIDs parity —
 *     wave2 pinned single-label only), the milestone numeric-id fallback
 *     (name first, id second) and the discarded-miss degrade to UNFILTERED;
 *   - the keyword shape: the page has no search box (documented v1
 *     degradation) and ?q= is inert — a non-matching needle still renders
 *     the full list (the keyword grammar lives on the /issues/search aux
 *     feed, issues-search-aux.test.ts's module);
 *   - the pulls family: the Open tab's PR glyph (vs the issues list's
 *     issue-opened), the row state machine on the list (open green / WIP
 *     draft / closed red / merged purple — wave2 pinned none; the
 *     notifications matrix pinned the same machine on ITS page), PR rows
 *     anchoring the /issues/{index} family (upstream redirects PR numbers
 *     there — wave2's comment, asserted here), the pulls closed tab over
 *     closed+merged extensions, and the absent New Issue button + comment
 *     counter;
 *   - the New Issue tail: the issue-list-new button on the issues list,
 *     hidden on archived repos (the upstream IsArchived gate — RepoService
 *     always creates unarchived, so the archived twin is a direct D1 stamp);
 *   - the claim pin: the issues head's new/labels tails parse into their own
 *     families while the pulls head has NO such tails (unclaimed → engine
 *     404, upstream registers no /pulls/new or /pulls/labels).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { createRepoLabel } from "../../api/services/labels";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { pullRequests, repositories } from "../../db/schema";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { RepoRow } from "../ui-context";

// --- the minted-session route harness (the notifications 28b71b9 pattern) -------

/** Synthetic manifest shaped like the real Vite output (the shared fixture
 *  shape — deterministic, no build dependence). */
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

/** The real production path: parse → resolveUiSession → the handler, on the
 *  mounted uiRouter with the synthetic manifest; the execution context is
 *  awaited so waitUntil side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the user (the real mintSession path,
 *  minted per request — the beforeEach users wipe cascades the sessions
 *  table, so a cross-test cookie would go stale; the value is never
 *  rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** The open/closed tab strip slice (wave2's extraction — the tabs render
 *  between the toolbar and the list body). */
function tabsSlice(html: string): string {
  return html.slice(
    html.indexOf('<div class="small-menu-items ui compact tiny menu">'),
    html.indexOf('id="issue-list"'),
  );
}

// --- fixtures -------------------------------------------------------------------

const T0 = 1_770_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

async function seedRepo(owner: { id: number; username: string }, slug: string, isPrivate = false): Promise<RepoRow> {
  return new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: owner.username.toLowerCase() },
    name: slug,
    isPrivate,
    status: "ready",
  });
}

/** One plain open issue (unique title, deterministic time). */
async function seedIssue(
  svc: IssuesService,
  repoId: string,
  posterId: number,
  title: string,
  offsetSeconds: number,
  extra?: { labelIds?: number[]; milestoneId?: number },
): Promise<{ id: number; index: number }> {
  const issue = await svc.createIssue({
    repoId,
    title,
    posterId,
    labelIds: extra?.labelIds,
    milestoneId: extra?.milestoneId,
    now: at(offsetSeconds),
  });
  return { id: issue.id, index: issue.index };
}

async function seedPull(
  svc: IssuesService,
  repoId: string,
  posterId: number,
  title: string,
  offsetSeconds: number,
  branch: string,
): Promise<{ issue: { id: number; index: number } }> {
  const pull = await svc.createPullRequest({
    repoId,
    title,
    posterId,
    headRepoId: repoId,
    headBranch: branch,
    baseBranch: "main",
    now: at(offsetSeconds),
  });
  return { issue: { id: pull.issue.id, index: pull.issue.index } };
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // FK order: the join/write rows first, then issues, then the per-repo
  // counter (repo_counters → repositories is the one NON-cascade FK,
  // migration 0002 — it must go before its repo), then labels/milestones/
  // repositories before users (sessions cascade from users).
  for (const table of [
    "issue_labels",
    "issue_pins",
    "comments",
    "pull_requests",
    "issues",
    "labels",
    "milestones",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the viewer gates -------------------------------------------------------------

describe("the viewer gates (the signed-in arms wave2's anonymous posture lacks)", () => {
  it("the signed-in OWNER renders their own private repo's issues list with the signed-in chrome", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "vault", true);
    const svc = new IssuesService(env.DB);
    const issue = await seedIssue(svc, repo.id, alice.id, "vault secret thread", 10);

    const res = await fetchUi("/alice/vault/issues", { headers: { cookie: await sessionHeader(alice.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">vault secret thread</a>");
    expect(html).toContain(`href="/alice/vault/issues/${issue.index}">#${issue.index}</a>`);
    // The session resolved: the user navbar renders the notifications bell
    // and drops the anonymous Sign In item (the shell's viewer branch).
    expect(html).toContain('<a class="item" href="/notifications"');
    expect(html).not.toContain(">Sign In</a>");
  });

  it("a signed-in NON-owner still 404-shells on someone else's private repo (sessions buy no visibility)", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "vault", true);
    await seedIssue(new IssuesService(env.DB), repo.id, alice.id, "vault secret thread", 10);

    const res = await fetchUi("/alice/vault/issues", { headers: { cookie: await sessionHeader(bob.id) } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<div class="status-page-error">');
    expect(html).not.toContain(">vault secret thread</a>");
  });

  it("a signed-in viewer renders a public repo's pulls list the same way (the family shares the gate)", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "pubrepo");
    await seedPull(new IssuesService(env.DB), repo.id, bob.id, "pub pull", 10, "feature");

    const res = await fetchUi("/alice/pubrepo/pulls", { headers: { cookie: await sessionHeader(bob.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">pub pull</a>");
    expect(html).toContain('<a class="item" href="/notifications"');
    expect(html).not.toContain(">Sign In</a>");
  });
});

// --- the state/page degrade shapes -------------------------------------------------

describe("the state/page degrade shapes (the no-upper-clamp pager)", () => {
  /** alice + one public repo: 21 open issues, 1 closed — exactly one page
   *  over, indexes in creation order. */
  async function seedPagerRepo(): Promise<{ repo: RepoRow; svc: IssuesService }> {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "pager");
    const svc = new IssuesService(env.DB);
    for (let i = 1; i <= 21; i += 1) {
      await seedIssue(svc, repo.id, alice.id, `pager issue ${i}`, i);
    }
    const closed = await seedIssue(svc, repo.id, alice.id, "pager closed issue", 500);
    await svc.closeIssue(closed.id, { now: at(510) });
    return { repo, svc };
  }

  it("an unknown ?state= degrades to the open tab (parseListState's default branch)", async () => {
    await seedPagerRepo();
    const res = await fetchUi("/alice/pager/issues?state=all");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The OPEN tab is the active one (the closed tab would carry the active
    // class — wave2's closed-tab slicing, inverted).
    const tabs = tabsSlice(html);
    const active = tabs.indexOf('class="active item flex-text-inline"');
    const plain = tabs.indexOf('class="item flex-text-inline"');
    expect(active).toBeGreaterThanOrEqual(0);
    expect(active).toBeLessThan(plain);
    // And the rows are the open list (20-row page 1), not the closed one.
    expect((html.match(/<div class="item">/g) ?? []).length).toBe(20);
    expect(html).toContain(">pager issue 21</a>");
    expect(html).not.toContain(">pager closed issue</a>");
  });

  it("a junk ?page= parses as 1 (parsePageNumber's non-numeric branch)", async () => {
    await seedPagerRepo();
    const res = await fetchUi("/alice/pager/issues?page=abc");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect((html.match(/<div class="item">/g) ?? []).length).toBe(20);
    expect(html).toContain('<a class="item navigation" href="/alice/pager/issues?page=2"');
    expect(html).not.toContain('<span class="navigation_label">Newer</span>');
  });

  it("a past-the-end page renders the empty state WITH a Newer link back (no last-page clamp)", async () => {
    await seedPagerRepo();
    const res = await fetchUi("/alice/pager/issues?page=99");
    expect(res.status).toBe(200);
    const html = await res.text();
    // No rows → the empty state replaces the list body…
    expect(html).toContain('<h3 class="tw-my-4">No results</h3>');
    expect(html).not.toContain('id="issue-list"');
    // …but page > 1 keeps the pager alive with ONLY the Newer link, onto
    // page-1-of-the-request (98 — the §4.11 no-upper-clamp note; the
    // notifications page clamps instead, a documented difference).
    expect(html).toContain('<a class="item navigation" href="/alice/pager/issues?page=98"');
    expect(html).toContain('<span class="navigation_label">Newer</span>');
    expect(html).not.toContain('<span class="navigation_label">Older</span>');
  });
});

// --- the facet-preserving pager ----------------------------------------------------

describe("the facet-preserving pager (tab counts over the same facet)", () => {
  /** alice + one public repo: 21 OPEN issues labeled bug, 1 CLOSED issue
   *  labeled bug — the filter facets ride every link shape. */
  async function seedFacetRepo(): Promise<{ bugId: number }> {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "facets");
    const svc = new IssuesService(env.DB);
    const bug = await createRepoLabel(env.DB, repo.id, {
      name: "bug",
      exclusive: false,
      color: "#ee0701",
      description: "Something is broken",
      isArchived: false,
      now: at(0),
    });
    for (let i = 1; i <= 21; i += 1) {
      await seedIssue(svc, repo.id, alice.id, `faceted issue ${i}`, i, { labelIds: [bug.id] });
    }
    const closed = await seedIssue(svc, repo.id, alice.id, "faceted closed issue", 500, { labelIds: [bug.id] });
    await svc.closeIssue(closed.id, { now: at(510) });
    return { bugId: bug.id };
  }

  it("page 1 under a label facet: counts over the SAME facet, Older keeps the labels param", async () => {
    const { bugId } = await seedFacetRepo();
    const res = await fetchUi(`/alice/facets/issues?labels=${bugId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The tab totals are computed over the SAME label filter, both states.
    expect(html).toContain("21 Open</a>");
    expect(html).toContain("1 Closed</a>");
    // The active open tab echoes the facet; page resets (upstream QueryBuild).
    expect(tabsSlice(html)).toContain(`href="/alice/facets/issues?labels=${bugId}"`);
    // The Older link carries the facet with the page param LAST (listHref's
    // order: labels then page), ampersand HTML-escaped in the attribute.
    expect(html).toContain(`href="/alice/facets/issues?labels=${bugId}&amp;page=2"`);
    expect((html.match(/<div class="item">/g) ?? []).length).toBe(20);
  });

  it("page 2 under the facet: the Newer link keeps the labels param and drops the canonical page", async () => {
    const { bugId } = await seedFacetRepo();
    const res = await fetchUi(`/alice/facets/issues?labels=${bugId}&page=2`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect((html.match(/<div class="item">/g) ?? []).length).toBe(1);
    expect(html).toContain(">faceted issue 1</a>");
    expect(html).toContain(`<a class="item navigation" href="/alice/facets/issues?labels=${bugId}"`);
    expect(html).toContain('<span class="navigation_label">Newer</span>');
    expect(html).not.toContain('<span class="navigation_label">Older</span>');
  });

  it("the closed tab under the facet: state+labels ride the links, the closed row's badge echoes state=closed", async () => {
    const { bugId } = await seedFacetRepo();
    const res = await fetchUi(`/alice/facets/issues?state=closed&labels=${bugId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("21 Open</a>");
    expect(html).toContain("1 Closed</a>");
    // The active closed tab echoes BOTH facets, state first (listHref's order).
    expect(tabsSlice(html)).toContain(`href="/alice/facets/issues?state=closed&amp;labels=${bugId}"`);
    // The open tab keeps the label facet without a state param (open is the
    // default and never emitted).
    expect(tabsSlice(html)).toContain(`href="/alice/facets/issues?labels=${bugId}"`);
    // The closed row's label badge echoes the row's own (active) state.
    expect(html).toContain(`href="?state=closed&amp;labels=${bugId}"`);
    expect(html).toContain(">faceted closed issue</a>");
  });
});

// --- the filter-parsing arms --------------------------------------------------------

describe("the filter-parsing arms (drop-then-apply, any-of labels, milestone id fallback)", () => {
  /** alice + one public repo: L labeled bug+enhancement with milestone v2.0,
   *  Q labeled enhancement only, P unlabeled — all open; C labeled bug,
   *  closed. Label/milestone ids are captured (autoincrement ids NEVER
   *  restart across the wipe). */
  async function seedFilterRepo(): Promise<{ bugId: number; enhId: number; milestoneId: number }> {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "filters");
    const svc = new IssuesService(env.DB);
    const bug = await createRepoLabel(env.DB, repo.id, {
      name: "bug",
      exclusive: false,
      color: "#ee0701",
      description: "Something is broken",
      isArchived: false,
      now: at(0),
    });
    const enh = await createRepoLabel(env.DB, repo.id, {
      name: "enhancement",
      exclusive: false,
      color: "#84b6eb",
      description: "New feature or request",
      isArchived: false,
      now: at(0),
    });
    const milestone = await svc.createMilestone({ repoId: repo.id, name: "v2.0", now: at(0) });
    await seedIssue(svc, repo.id, alice.id, "labeled filtered issue", 10, {
      labelIds: [bug.id, enh.id],
      milestoneId: milestone.id,
    });
    await seedIssue(svc, repo.id, alice.id, "enhanced filtered issue", 20, { labelIds: [enh.id] });
    await seedIssue(svc, repo.id, alice.id, "plain filtered issue", 30);
    const closed = await seedIssue(svc, repo.id, alice.id, "closed filtered issue", 40, { labelIds: [bug.id] });
    await svc.closeIssue(closed.id, { now: at(50) });
    return { bugId: bug.id, enhId: enh.id, milestoneId: milestone.id };
  }

  it("a garbage-only ?labels= drops every entry and filters NOTHING; a mixed list keeps the valid ids", async () => {
    const { bugId } = await seedFilterRepo();
    // All garbage (non-numeric, zero, negative, empty entries) → [] → the
    // unfiltered open list (L, Q, P).
    const garbage = await (await fetchUi("/alice/filters/issues?labels=abc,0,-1,,")).text();
    expect((garbage.match(/<div class="item">/g) ?? []).length).toBe(3);
    expect(garbage).toContain(">plain filtered issue</a>");
    // Mixed: the valid id survives the drop-then-apply → only the open
    // bug-labeled row (L; C is closed).
    const mixed = await (await fetchUi(`/alice/filters/issues?labels=abc,${bugId}`)).text();
    expect((mixed.match(/<div class="item">/g) ?? []).length).toBe(1);
    expect(mixed).toContain(">labeled filtered issue</a>");
  });

  it("a multi-label facet is ANY-of (OR) — either label matches (indexer IncludedLabelIDs parity)", async () => {
    const { bugId, enhId } = await seedFilterRepo();
    const res = await fetchUi(`/alice/filters/issues?labels=${bugId},${enhId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // L (bug+enh) and Q (enh only) both match; neither carries both ids.
    expect(html).toContain(">labeled filtered issue</a>");
    expect(html).toContain(">enhanced filtered issue</a>");
    expect((html.match(/<div class="item">/g) ?? []).length).toBe(2);
  });

  it("the milestone facet resolves a NUMERIC id as a fallback (name first, id second)", async () => {
    const { milestoneId } = await seedFilterRepo();
    // By id (no milestone is named after the digits): the L row only.
    const res = await fetchUi(`/alice/filters/issues?milestone=${milestoneId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect((html.match(/<div class="item">/g) ?? []).length).toBe(1);
    expect(html).toContain(">labeled filtered issue</a>");
    // The tabs echo the milestone id back.
    expect(tabsSlice(html)).toContain(`href="/alice/filters/issues?milestone=${milestoneId}"`);
  });

  it("a discarded milestone miss degrades to the UNFILTERED list; an empty ?milestone= filters nothing", async () => {
    await seedFilterRepo();
    // Unknown name → GetMilestoneByRepoIDANDName misses are discarded → no
    // filter at all (not an empty result set).
    const missed = await (await fetchUi("/alice/filters/issues?milestone=no-such-milestone")).text();
    expect((missed.match(/<div class="item">/g) ?? []).length).toBe(3);
    expect(missed).toContain(">plain filtered issue</a>");
    // The bare param is skipped entirely (milestoneParam !== "").
    const empty = await (await fetchUi("/alice/filters/issues?milestone=")).text();
    expect((empty.match(/<div class="item">/g) ?? []).length).toBe(3);
  });
});

// --- the keyword shape ---------------------------------------------------------------

describe("the keyword shape (?q= is inert; the search box is not rendered)", () => {
  it("a non-matching ?q= still renders the full list — the page has no keyword path v1", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "qshape");
    const svc = new IssuesService(env.DB);
    await seedIssue(svc, repo.id, alice.id, "needle haystack one", 10);
    await seedIssue(svc, repo.id, alice.id, "unrelated second", 20);

    const res = await fetchUi("/alice/qshape/issues?q=zzz-no-such-needle");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The keyword is NOT applied (keyword: "" hardcoded — the search grammar
    // belongs to the /issues/search aux feed): both rows render, including
    // one that cannot match the needle.
    expect((html.match(/<div class="item">/g) ?? []).length).toBe(2);
    expect(html).toContain(">unrelated second</a>");
    // And the upstream search/filter box markup is absent (the documented
    // dead-UI degradation — no search route existed when the page landed).
    expect(html).not.toContain('class="filter menu"');
    expect(html).not.toContain("issue-list-search");
  });
});

// --- the pulls family ------------------------------------------------------------------

describe("the pulls family (the row state machine + the /issues link family)", () => {
  /** alice + one public repo: an open PR, a WIP-prefixed open PR, a closed
   *  (NOT merged) PR, a merged PR (direct hasMerged stamp — the landed merge
   *  path needs engine content; the page reads D1 only), and a plain issue
   *  that must stay off the pulls pages. */
  async function seedPullRepo(): Promise<{ open: number; wip: number; closed: number; merged: number }> {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "pullpages");
    const svc = new IssuesService(env.DB);
    const open = await seedPull(svc, repo.id, alice.id, "pull open", 10, "open-branch");
    const wip = await seedPull(svc, repo.id, alice.id, "WIP: pull draft", 20, "wip-branch");
    const closed = await seedPull(svc, repo.id, alice.id, "pull closed", 30, "closed-branch");
    await svc.closeIssue(closed.issue.id, { now: at(35) });
    const merged = await seedPull(svc, repo.id, alice.id, "pull merged", 40, "merged-branch");
    await svc.closeIssue(merged.issue.id, { now: at(45) });
    await drizzle(env.DB).update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.issueId, merged.issue.id));
    await seedIssue(svc, repo.id, alice.id, "plain pullpages issue", 50);
    return { open: open.issue.index, wip: wip.issue.index, closed: closed.issue.index, merged: merged.issue.index };
  }

  it("the Open tab carries the PR glyph (vs the issues list's issue-opened) and the rows render the open/WIP state machine", async () => {
    const indexes = await seedPullRepo();
    const pulls = await (await fetchUi("/alice/pullpages/pulls")).text();
    expect(pulls).toContain("2 Open</a>");
    expect(pulls).toContain("2 Closed</a>");
    // The Open tab's glyph is the pull-request icon (PageIsPullList parity —
    // the issues list's tab carries octicon-issue-opened, asserted below).
    expect(tabsSlice(pulls)).toContain('class="svg octicon-git-pull-request"');
    // The rows: open green / WIP draft grey (the title-prefix branch).
    expect(pulls).toContain('class="svg octicon-git-pull-request tw-text-green"');
    expect(pulls).toContain('class="svg octicon-git-pull-request-draft tw-text-text-light"');
    // PR rows anchor the /issues/{index} family (upstream redirects PR
    // numbers there) — never /pulls/{index}.
    expect(pulls).toContain(`href="/alice/pullpages/issues/${indexes.open}"`);
    expect(pulls).not.toContain(`href="/alice/pullpages/pulls/${indexes.open}"`);
    // The plain issue never leaks onto the pulls list.
    expect(pulls).not.toContain(">plain pullpages issue</a>");
    // No comments were seeded: no trailing comment counters at all.
    expect(pulls).not.toContain("item-trailing");
    // The pulls list renders NO New Issue button (issues-only tail).
    expect(pulls).not.toContain("issue-list-new");

    // The issues list twin: the Open tab's glyph is the issue icon there,
    // and the PR rows are excluded from BOTH of its counts (1 open plain
    // issue, 0 closed — the closed PRs stay pulls-only).
    const issues = await (await fetchUi("/alice/pullpages/issues?state=closed")).text();
    expect(tabsSlice(issues)).toContain('class="svg octicon-issue-opened"');
    expect(tabsSlice(issues)).toContain("1 Open</a>");
    expect(tabsSlice(issues)).toContain("0 Closed</a>");
  });

  it("the pulls closed tab renders the closed-red and merged-purple extensions over is_pull rows", async () => {
    const indexes = await seedPullRepo();
    const res = await fetchUi("/alice/pullpages/pulls?state=closed");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect((html.match(/<div class="item">/g) ?? []).length).toBe(2);
    // Closed-but-not-merged: the red closed-PR glyph; merged: the purple
    // merge glyph (the has_merged extension read — the loader's batch).
    expect(html).toContain('class="svg octicon-git-pull-request-closed tw-text-red"');
    expect(html).toContain('class="svg octicon-git-merge tw-text-purple"');
    expect(html).toContain(`>pull closed</a>`);
    expect(html).toContain(`>pull merged</a>`);
    // The closed tab href echoes state=closed; the open tab drops it.
    expect(tabsSlice(html)).toContain('href="/alice/pullpages/pulls?state=closed"');
    expect(tabsSlice(html)).toContain('href="/alice/pullpages/pulls"');
    // The plain closed issue stays off the pulls closed tab (is_pull filter).
    expect(html).not.toContain(">plain pullpages issue</a>");
    expect(indexes.merged).toBe(indexes.closed + 1);
  });
});

// --- the New Issue tail ----------------------------------------------------------------

describe("the New Issue tail (the archived gate wave2's fixture cannot reach)", () => {
  it("the issues list renders the New Issue button; the archived twin hides it but keeps the list", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "tailz");
    const svc = new IssuesService(env.DB);
    await seedIssue(svc, repo.id, alice.id, "tailz thread", 10);

    const live = await (await fetchUi("/alice/tailz/issues")).text();
    expect(live).toContain('<a class="ui small primary button issue-list-new" href="/alice/tailz/issues/new">');
    expect(live).toContain(">tailz thread</a>");

    // Stamp the archived flag (RepoService always creates unarchived; the
    // upstream `if not .Repository.IsArchived` gate hides ONLY the button —
    // archived repos keep readable lists).
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, repo.id));
    const archived = await fetchUi("/alice/tailz/issues");
    expect(archived.status).toBe(200);
    const html = await archived.text();
    expect(html).not.toContain("issue-list-new");
    expect(html).toContain(">tailz thread</a>");
    expect(html).toContain("1 Open</a>");
  });
});

// --- the claim pin -----------------------------------------------------------------------

describe("the claim pin (issues vs pulls heads, new/labels tails)", () => {
  it("the pulls head has NO new/labels tails — unclaimed, engine-owned (upstream registers none)", () => {
    expect(handlesUiRoute("/octo/hello/pulls/new")).toBe(false);
    expect(handlesUiRoute("/octo/hello/pulls/labels")).toBe(false);
    expect(parseUiRoute("/octo/hello/pulls/new")).toBeNull();
    expect(parseUiRoute("/octo/hello/pulls/labels")).toBeNull();
  });

  it("the issues head's labels tail parses into its own family (the wave-5 POST-only write)", () => {
    expect(parseUiRoute("/octo/hello/issues/labels")).toEqual({ family: "issue-labels", owner: "octo", repo: "hello" });
    expect(handlesUiRoute("/octo/hello/issues/labels")).toBe(true);
    // …while the pulls head's integer tails keep the detail family (the
    // wave-2 pin, re-anchored beside the tails): no bare-literal shadowing.
    expect(parseUiRoute("/octo/hello/pulls/9")).toEqual({
      family: "issue-detail",
      owner: "octo",
      repo: "hello",
      urlKind: "pulls",
      index: 9,
    });
  });
});
