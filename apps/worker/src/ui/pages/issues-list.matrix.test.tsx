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
 *   - the New Pull Request tail (the webui-parity wave): the pulls list's
 *     list-header button (list.tmpl:27) in its three viewer states — the
 *     writer (owner / site admin) the live compare target
 *     (MakeDefaultCompareLink's same-repo fold, `{default}...{default}`),
 *     the signed-in non-owner upstream's `disabled` class over the same
 *     link, anonymous the /login round-trip onto the compare page — plus
 *     the archived arm's Compare-commits button (list.tmpl:31-33, pulls
 *     only) and the non-master default branch riding the target;
 *   - the claim pin: the issues head's new/labels tails parse into their own
 *     families while the pulls head has NO such tails (unclaimed → engine
 *     404; upstream registers /pulls/new (claimed by the window-2e folds) but no /pulls/labels).
 *   - (wave-129 matrix-4) the typed query combinations: labels×milestone
 *     intersect (AND), a missed milestone inside a composition degrades to
 *     the labels-only list, both facets ride the pager in listHref's emit
 *     order, duplicate ?state= takes the first value, case-mismatched
 *     ?state= degrades to open, and the upstream poster/assignee params are
 *     inert on this surface.
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
import { pullRequests, repoCollaborators, repositories, users } from "../../db/schema";
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

  it("the milestone renders as the upstream row LINK — /milestone/{id} + octicon-milestone (issuelist.tmpl:98-104 — the webui-parity row fix)", async () => {
    // Provenance: the v1.3.2 review-webui window. The row's milestone was a
    // bare `<span>` (the module header's "no milestone page exists" reduction
    // — stale since the milestone pages landed, ca4eb58): no link, no glyph.
    // Upstream: `<a class="milestone flex-text-inline tw-max-w-[300px]"
    // href="{RepoLink}/milestone/{id}">{{svg "octicon-milestone" 14}}<span
    // class="gt-ellipsis">{name}</span></a>`.
    const { milestoneId } = await seedFilterRepo();
    const html = await (await fetchUi("/alice/filters/issues")).text();
    expect(html).toContain(`<a class="milestone flex-text-inline tw-max-w-[300px]" href="/alice/filters/milestone/${milestoneId}">`);
    expect(html).toContain('width="14" height="14" class="svg octicon-milestone"');
    expect(html).toContain('<span class="gt-ellipsis">v2.0</span></a>');
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
    // The pulls list renders NO New Issue button (issues-only tail) — its
    // own creation button is the new-pr-button twin (the anon arm: the
    // /login round-trip onto the compare target; pinned in the New Pull
    // Request tail describe).
    expect(pulls).not.toContain('href="/alice/pullpages/issues/new"');
    expect(pulls).toContain(
      '<a class="ui small primary button new-pr-button issue-list-new" href="/login?redirect_to=%2Falice%2Fpullpages%2Fcompare%2Fmain...main">New Pull Request</a>',
    );

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

  it("PR rows render the upstream .branches base→head pair (issuelist.tmpl:78-96 — the webui-parity row fix)", async () => {
    // Provenance: the v1.3.2 review-webui window. The rows previously ended
    // at the event line: PR rows carried no `.branches` at all (the pull
    // extension's branch pair was loaded only as the has_merged flag). The
    // upstream shape renders BASE first, then the 12px
    // gitea-double-chevron-left, then HEAD — each a
    // `/src/branch/{PathEscapeSegments branch}` link wrapping a
    // `truncated-name` span, the whole trio inside
    // `div.branches.flex-text-inline`. Both hrefs ride THIS repo: no forks,
    // so upstream's cross-repo `OwnerName:` prefix arm never fires.
    await seedPullRepo();
    const pulls = await (await fetchUi("/alice/pullpages/pulls")).text();
    expect(pulls).toContain(
      '<div class="branch"><a href="/alice/pullpages/src/branch/main"><span class="truncated-name">main</span></a></div>',
    );
    expect(pulls).toContain('width="12" height="12" class="svg gitea-double-chevron-left"');
    expect(pulls).toContain(
      '<div class="branch"><a href="/alice/pullpages/src/branch/open-branch"><span class="truncated-name">open-branch</span></a></div>',
    );
    // Order: the base link precedes the chevron, the chevron precedes head.
    expect(pulls.indexOf("/alice/pullpages/src/branch/main")).toBeLessThan(pulls.indexOf("gitea-double-chevron-left"));
    expect(pulls.indexOf("gitea-double-chevron-left")).toBeLessThan(pulls.indexOf("/alice/pullpages/src/branch/open-branch"));
    // The plain-issue list renders NO branches div (the pair is PR-row-only).
    const issues = await (await fetchUi("/alice/pullpages/issues")).text();
    expect(issues).not.toContain('class="branches flex-text-inline"');
  });
});

// --- the typed query combinations ------------------------------------------------
// wave-129 matrix-4: the landed query surface (issues-list.tsx's loader —
// `?state=`/`?page=`/`?labels=`/`?milestone=` ONLY, "reduced to the params
// this page actually honors") composed: the label AND milestone facets must
// intersect (upstream ListIssues applies both to one query —
// routers/api/v1/repo/issue.go's LabelIDs + MilestoneIDs over the same
// issue list), a missed milestone inside a composition degrades to the
// LABEL-filtered list (not the unfiltered one), both facets ride the pager
// in listHref's emit order, duplicate ?state= takes the FIRST value (Go
// FormString parity), and the upstream poster/assignee params are inert
// here (no QueryBuild on this surface — the documented reduction).

describe("the typed query combinations (facets compose AND, degrade together)", () => {
  /** alice + one public repo: 21 OPEN issues labeled bug AND sitting in the
   *  milestone v3.1, 1 CLOSED issue with the same pair, plus 1 open issue
   *  labeled enh WITHOUT the milestone — every combination arm's mirror. */
  async function seedComboRepo(): Promise<{ bugId: number; enhId: number; milestoneId: number }> {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "combos");
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
    const milestone = await svc.createMilestone({ repoId: repo.id, name: "v3.1", now: at(0) });
    for (let i = 1; i <= 21; i += 1) {
      await seedIssue(svc, repo.id, alice.id, `combo issue ${i}`, i, { labelIds: [bug.id], milestoneId: milestone.id });
    }
    const closed = await seedIssue(svc, repo.id, alice.id, "combo closed issue", 500, { labelIds: [bug.id], milestoneId: milestone.id });
    await svc.closeIssue(closed.id, { now: at(510) });
    await seedIssue(svc, repo.id, alice.id, "loose enh issue", 600, { labelIds: [enh.id] });
    return { bugId: bug.id, enhId: enh.id, milestoneId: milestone.id };
  }

  it("the label AND milestone facets intersect; the tabs echo both in listHref order with the id", async () => {
    const { bugId, milestoneId } = await seedComboRepo();
    const res = await fetchUi(`/alice/combos/issues?labels=${bugId}&milestone=v3.1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The AND answer: 21 open + 1 closed — the loose enh issue (label but no
    // milestone) is excluded by the milestone half.
    expect(html).toContain("21 Open</a>");
    expect(html).toContain("1 Closed</a>");
    expect((html.match(/<div class="item">/g) ?? []).length).toBe(20);
    expect(html).not.toContain(">loose enh issue</a>");
    // The milestone resolved BY NAME echoes as the numeric id (listHref's
    // shape), labels first, milestone second.
    expect(tabsSlice(html)).toContain(`href="/alice/combos/issues?labels=${bugId}&amp;milestone=${milestoneId}"`);
    // The numeric-id form of the SAME composition answers identically.
    const byId = await (await fetchUi(`/alice/combos/issues?labels=${bugId}&milestone=${milestoneId}`)).text();
    expect(byId).toContain("21 Open</a>");
    // The row's label badge echoes ONLY state+labels — the badge anchor's
    // exact bytes never carry the milestone facet (the row renderer's href).
    expect(html).toContain(`<a class="item" href="?state=open&amp;labels=${bugId}">`);
    expect(html).not.toContain(`?state=open&amp;labels=${bugId}&amp;milestone=`);
  });

  it("a missed milestone inside a composition degrades to the LABEL-filtered list, not the unfiltered one", async () => {
    const { bugId } = await seedComboRepo();
    // milestoneIdsByRepoEntries' miss is discarded → the milestone half
    // drops but the labels half STILL applies: 21 open bug rows, not the 22
    // unfiltered, not zero.
    const res = await fetchUi(`/alice/combos/issues?labels=${bugId}&milestone=no-such-milestone`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("21 Open</a>");
    expect(html).toContain("1 Closed</a>");
    expect((html.match(/<div class="item">/g) ?? []).length).toBe(20);
    // And the echo drops the discarded half: the tabs carry labels only.
    expect(tabsSlice(html)).toContain(`href="/alice/combos/issues?labels=${bugId}"`);
    expect(tabsSlice(html)).not.toContain("milestone=");
  });

  it("both facets ride the pager in listHref's emit order (labels, milestone, page)", async () => {
    const { bugId, milestoneId } = await seedComboRepo();
    const page1 = await (await fetchUi(`/alice/combos/issues?labels=${bugId}&milestone=${milestoneId}`)).text();
    // Older keeps BOTH facets with page last.
    expect(page1).toContain(`href="/alice/combos/issues?labels=${bugId}&amp;milestone=${milestoneId}&amp;page=2"`);
    const page2 = await (await fetchUi(`/alice/combos/issues?labels=${bugId}&milestone=${milestoneId}&page=2`)).text();
    expect((page2.match(/<div class="item">/g) ?? []).length).toBe(1);
    // Newer resets the canonical page (page-1 = 1 is never emitted).
    expect(page2).toContain(`<a class="item navigation" href="/alice/combos/issues?labels=${bugId}&amp;milestone=${milestoneId}"`);
    expect(page2).toContain('<span class="navigation_label">Newer</span>');
    expect(page2).not.toContain('<span class="navigation_label">Older</span>');
    // The closed tab under BOTH facets + page 2 echoes state first, pageless.
    expect(tabsSlice(page2)).toContain(
      `href="/alice/combos/issues?state=closed&amp;labels=${bugId}&amp;milestone=${milestoneId}"`,
    );
  });

  it("duplicate ?state= params take the FIRST value (Go FormString parity)", async () => {
    await seedComboRepo();
    const res = await fetchUi("/alice/combos/issues?state=closed&state=open");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The CLOSED tab is the active one (URLSearchParams.get returns the
    // first occurrence — upstream's ctx.FormString reads the same one)…
    const tabs = tabsSlice(html);
    const active = tabs.indexOf('class="active item flex-text-inline"');
    const plain = tabs.indexOf('class="item flex-text-inline"');
    expect(active).toBeGreaterThanOrEqual(0);
    expect(active).toBeGreaterThan(plain); // the closed tab sits second in the DOM
    // …and the rows are the closed page (the single closed combo issue).
    expect((html.match(/<div class="item">/g) ?? []).length).toBe(1);
    expect(html).toContain(">combo closed issue</a>");
  });

  it("a non-lowercase ?state= degrades to the open tab (the exact-match parse)", async () => {
    await seedComboRepo();
    const res = await fetchUi("/alice/combos/issues?state=Closed");
    expect(res.status).toBe(200);
    const html = await res.text();
    const tabs = tabsSlice(html);
    const active = tabs.indexOf('class="active item flex-text-inline"');
    const plain = tabs.indexOf('class="item flex-text-inline"');
    expect(active).toBeGreaterThanOrEqual(0);
    expect(active).toBeLessThan(plain); // the OPEN tab (first in the DOM) is active
    expect((html.match(/<div class="item">/g) ?? []).length).toBe(20);
    expect(html).not.toContain(">combo closed issue</a>");
  });

  it("the upstream poster/assignee params are inert: no filter, no facet echo", async () => {
    await seedComboRepo();
    // Upstream's ViewIssues honors poster and assigned poster through the
    // QueryBuild (routers/web/repo/issue ViewIssues' PosterID/AssignedID
    // params); the landed surface honors labels+milestone only — the params
    // must neither filter nor echo.
    const res = await fetchUi("/alice/combos/issues?poster=alice&assignee=alice");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The UNFILTERED open set: 22 rows worth (21 combo + the loose enh), so
    // the pager shows Older and the tabs echo no facet at all.
    expect(html).toContain("22 Open</a>");
    expect(html).toContain("1 Closed</a>");
    expect(tabsSlice(html)).toContain('href="/alice/combos/issues"');
    expect(tabsSlice(html)).not.toContain("labels=");
    expect(tabsSlice(html)).not.toContain("poster=");
    expect(tabsSlice(html)).not.toContain("assignee=");
  });
});



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

// --- the New Pull Request tail (the pulls list's list-header button) ------

describe("the New Pull Request tail (list.tmpl:27-33's three viewer states over the pulls tab)", () => {
  /** alice + one public repo (unarchived) — the button states' fixture. */
  async function seedButtonRepo(slug: string): Promise<RepoRow> {
    const alice = await seedVerifiedUser({ username: "alice" });
    return seedRepo(alice, slug);
  }

  it("the writer (the repo owner) renders the live compare target; the signed-in non-owner upstream's disabled class over the same link", async () => {
    await seedButtonRepo("prbutton");
    const alice = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get();
    const writer = await (
      await fetchUi("/alice/prbutton/pulls", { headers: { cookie: await sessionHeader(alice!.id) } })
    ).text();
    // MakeDefaultCompareLink's same-repo fold: base = the PR-unit target
    // (unlanded config → the default branch), head = the bare branch name.
    expect(writer).toContain(
      '<a class="ui small primary button new-pr-button issue-list-new" href="/alice/prbutton/compare/main...main">New Pull Request</a>',
    );
    expect(writer).not.toContain("issue-list-new disabled");

    const bob = await seedVerifiedUser({ username: "bob" });
    const reader = await (
      await fetchUi("/alice/prbutton/pulls", { headers: { cookie: await sessionHeader(bob.id) } })
    ).text();
    // The `{{if not .PullRequestCtx.CanCreateNewPull}}disabled{{end}}` arm.
    expect(reader).toContain(
      '<a class="ui small primary button new-pr-button issue-list-new disabled" href="/alice/prbutton/compare/main...main">New Pull Request</a>',
    );
  });

  it("a site-admin stranger renders the live link (the static grant's admin arm)", async () => {
    await seedButtonRepo("pradmin");
    const root = await seedVerifiedUser({ username: "root", isAdmin: true });
    const html = await (
      await fetchUi("/alice/pradmin/pulls", { headers: { cookie: await sessionHeader(root.id) } })
    ).text();
    expect(html).toContain(
      '<a class="ui small primary button new-pr-button issue-list-new" href="/alice/pradmin/compare/main...main">New Pull Request</a>',
    );
    expect(html).not.toContain("issue-list-new disabled");
  });

  it("a write-granted collaborator renders the live link (the dispatch-threaded D1 grant — the static-arms-only limit retired)", async () => {
    const repo = await seedButtonRepo("prcollab");
    const carol = await seedVerifiedUser({ username: "carol" });
    await drizzle(env.DB)
      .insert(repoCollaborators)
      .values({ repoId: repo.id, userId: carol.id, mode: "write", createdAt: new Date(), updatedAt: new Date() });
    const html = await (
      await fetchUi("/alice/prcollab/pulls", { headers: { cookie: await sessionHeader(carol.id) } })
    ).text();
    // canWriteRepo's collaborator arm (repo-access.ts via sessionRepoGrant) —
    // the index.ts dispatch threads data.canWriteIssues, so CanCreateNewPull
    // is true for carol despite neither static arm (not admin, not owner).
    expect(html).toContain(
      '<a class="ui small primary button new-pr-button issue-list-new" href="/alice/prcollab/compare/main...main">New Pull Request</a>',
    );
    expect(html).not.toContain("issue-list-new disabled");
    // The control arm: a stranger WITHOUT the row keeps upstream's disabled.
    const mallory = await seedVerifiedUser({ username: "mallory" });
    const stranger = await (
      await fetchUi("/alice/prcollab/pulls", { headers: { cookie: await sessionHeader(mallory.id) } })
    ).text();
    expect(stranger).toContain("issue-list-new disabled");
  });

  it("the anonymous viewer gets the live /login round-trip onto the compare target", async () => {
    await seedButtonRepo("pranon");
    const html = await (await fetchUi("/alice/pranon/pulls")).text();
    expect(html).toContain(
      '<a class="ui small primary button new-pr-button issue-list-new" href="/login?redirect_to=%2Falice%2Fpranon%2Fcompare%2Fmain...main">New Pull Request</a>',
    );
    expect(html).not.toContain("issue-list-new disabled");
  });

  it("the archived twin renders the Compare-commits button (list.tmpl:31-33's exact classes) and the issues list renders neither", async () => {
    const repo = await seedButtonRepo("prarch");
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, repo.id));
    const pulls = await (await fetchUi("/alice/prarch/pulls")).text();
    // The upstream `{{/* archived, view compare page only */}}` arm — keep
    // the template's doubled `small primary small` classes verbatim.
    expect(pulls).toContain(
      '<a class="ui small primary small button issue-list-new" href="/alice/prarch/compare/main...main">Compare commits</a>',
    );
    expect(pulls).not.toContain("new-pr-button");

    // The archived issues list renders no header button at all (the
    // `{{if not .PageIsIssueList}}` guard).
    const issues = await (await fetchUi("/alice/prarch/issues")).text();
    expect(issues).not.toContain("issue-list-new");
  });

  it("a non-master default branch rides the compare target (MakeDefaultCompareLink's branch echo)", async () => {
    const repo = await seedButtonRepo("prtrunk");
    await drizzle(env.DB).update(repositories).set({ defaultBranch: "trunk" }).where(eq(repositories.id, repo.id));
    const alice = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get();
    const html = await (
      await fetchUi("/alice/prtrunk/pulls", { headers: { cookie: await sessionHeader(alice!.id) } })
    ).text();
    expect(html).toContain('href="/alice/prtrunk/compare/trunk...trunk"');
  });
});

// --- the claim pin -----------------------------------------------------------------------

describe("the claim pin (issues vs pulls heads, new/labels tails)", () => {
  it("the pulls head has NO new/labels tails — unclaimed, engine-owned (upstream registers none)", () => {
    // Window-2e folds claim the pulls/new redirect (web.go:1314 registers
    // it — the issue-new agent's stale-comment catch).
    expect(handlesUiRoute("/octo/hello/pulls/new")).toBe(true);
    expect(handlesUiRoute("/octo/hello/pulls/labels")).toBe(false);
    expect(parseUiRoute("/octo/hello/pulls/new")).toEqual({ family: "pulls-new-redirect", owner: "octo", repo: "hello" });
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
