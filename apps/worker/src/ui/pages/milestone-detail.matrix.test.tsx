/**
 * The milestone DETAIL page's deferred seams (pages/milestone-detail.tsx —
 * upstream `m.Get("/milestone/{id}", repo.MilestoneIssuesAndPulls)`,
 * web.go:1340, routers/web/repo/milestone.go:237-274, the SINGULAR reader
 * route; the plural /milestones group at web.go:1424 carries only the write
 * tails and never claimed a bare /{id} view).
 *
 * pages-wave26.test.ts already covers the route-level contract through HTTP
 * (the header block, the tabs + counts, the state/labels facets, the flip
 * arm, the writer/reader Edit arms, the unknown/garbage/foreign-id 404
 * shells, the `{id}/edit` combo). THIS file owns the seams that suite leaves
 * open, per the wave-125 brief:
 *
 *   - the loader's exported UNIT seams (parseMilestoneId,
 *     parseMilestoneIssueState, findRepoMilestoneById, loadMilestoneDetailData):
 *     rows filtered BY milestone, the state filter, the flip arm's resolved
 *     state, the overdue clock, the more flag, the null arms;
 *   - the DETAIL pager (the list page's shape at 21 issues): Older carrying
 *     ?page=2, page 2's Newer onto the bare basePath, the state and label
 *     facets kept on BOTH directions (page dropped when canonical — the
 *     module's href() reduction of upstream QueryBuild), junk ?page= as 1,
 *     the past-the-end no-upper-clamp arm;
 *   - the EMPTY state (a milestone with zero issues — wave26's "empty"
 *     fixture holds a closed issue for the flip arm, so the no-results arm
 *     is only reachable here).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { createRepoLabel } from "../../api/services/labels";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import type { UiManifest } from "../manifest";
import { uiRouter, type UiAssetsFetcher } from "../index";
import type { RepoRow } from "../ui-context";
import {
  findRepoMilestoneById,
  loadMilestoneDetailData,
  MILESTONE_ISSUES_PAGE_SIZE,
  parseMilestoneId,
  parseMilestoneIssueState,
} from "./milestone-detail";

// --- the minted-route harness (the milestones matrix's pattern) ------------------

/** Synthetic manifest shaped like the real Vite output (deterministic). */
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

/** The production path: the mounted uiRouter, the execution context awaited
 *  so waitUntil side-effects settle before the assertions. */
async function fetchUi(path: string): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

// --- fixtures ---------------------------------------------------------------------

const ORIGIN = "https://test.local";
const T0 = 1_780_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);
/** A clock AFTER every seeded deadline (the overdue arm's now). */
const LATE = at(900_000);

async function seedRepo(owner: { id: number; username: string }, slug: string): Promise<RepoRow> {
  return new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: owner.username.toLowerCase() },
    name: slug,
    isPrivate: false,
    status: "ready",
  });
}

interface DetailFixture {
  repo: RepoRow;
  other: RepoRow;
  pagerMilestoneId: number;
  closedPagerMilestoneId: number;
  labeledMilestoneId: number;
  labeledClosedTitle: string;
  flipMilestoneId: number;
  emptyMilestoneId: number;
  bugLabelId: number;
}

let fixtureCache: DetailFixture | null = null;

/** alice + two repos; the detail repo carries one milestone per seam:
 *  21 open (the default-state pager), 21 closed (the state-carrying pager),
 *  21 labeled open + 1 unlabeled closed (the label-carrying pager + the
 *  explicit all view), 1 closed only (the flip arm), 0 issues (the empty
 *  arm). The other repo exists for the repo-scoped 404 arm. */
async function ensureFixtures(): Promise<DetailFixture> {
  if (fixtureCache !== null) return fixtureCache;
  const alice = await seedVerifiedUser({ username: "alice" });
  const repo = await seedRepo(alice, "detail");
  const other = await seedRepo(alice, "other");
  const svc = new IssuesService(env.DB);

  const pager = await svc.createMilestone({ repoId: repo.id, name: "pager m", now: at(10) });
  for (let i = 1; i <= 21; i += 1) {
    await svc.createIssue({ repoId: repo.id, title: `pager issue ${String(i).padStart(2, "0")}`, posterId: alice.id, milestoneId: pager.id, now: at(100 + i) });
  }

  const closedPager = await svc.createMilestone({
    repoId: repo.id,
    name: "closed pager m",
    deadlineAt: new Date("2020-01-01T23:59:59Z"), // past — but the MILESTONE is closed, so never overdue
    now: at(20),
  });
  for (let i = 1; i <= 21; i += 1) {
    const issue = await svc.createIssue({ repoId: repo.id, title: `shut issue ${String(i).padStart(2, "0")}`, posterId: alice.id, milestoneId: closedPager.id, now: at(200 + i) });
    await svc.closeIssue(issue.id, { actorId: alice.id, now: at(300 + i) });
  }
  await svc.updateMilestone(closedPager.id, { state: "closed", now: at(310) });

  const labeled = await svc.createMilestone({ repoId: repo.id, name: "labeled m", now: at(30) });
  const bug = await createRepoLabel(env.DB, repo.id, {
    name: "bug",
    exclusive: false,
    color: "#ee0701",
    description: "Something is broken",
    isArchived: false,
    now: at(40),
  });
  for (let i = 1; i <= 21; i += 1) {
    await svc.createIssue({ repoId: repo.id, title: `tagged issue ${String(i).padStart(2, "0")}`, posterId: alice.id, milestoneId: labeled.id, labelIds: [bug.id], now: at(400 + i) });
  }
  const labeledClosed = await svc.createIssue({ repoId: repo.id, title: "the lone shut one", posterId: alice.id, milestoneId: labeled.id, now: at(500) });
  await svc.closeIssue(labeledClosed.id, { actorId: alice.id, now: at(501) });

  const flip = await svc.createMilestone({
    repoId: repo.id,
    name: "flip m",
    deadlineAt: new Date("2020-06-15T23:59:59Z"), // past — open, so overdue against LATE
    now: at(60),
  });
  const flipIssue = await svc.createIssue({ repoId: repo.id, title: "only closed here", posterId: alice.id, milestoneId: flip.id, now: at(600) });
  await svc.closeIssue(flipIssue.id, { actorId: alice.id, now: at(601) });

  const empty = await svc.createMilestone({ repoId: repo.id, name: "empty m", now: at(70) });
  await svc.createMilestone({ repoId: other.id, name: "other m", now: at(80) });

  fixtureCache = {
    repo,
    other,
    pagerMilestoneId: pager.id,
    closedPagerMilestoneId: closedPager.id,
    labeledMilestoneId: labeled.id,
    labeledClosedTitle: "the lone shut one",
    flipMilestoneId: flip.id,
    emptyMilestoneId: empty.id,
    bugLabelId: bug.id,
  };
  return fixtureCache;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  fixtureCache = null;
  // FK order: the join rows first, then issues, then the per-repo counter
  // (repo_counters → repositories is the one NON-cascade FK, migration 0002
  // — it must go before its repo), then milestones/repositories before users
  // (sessions cascade from users).
  for (const table of [
    "issue_labels",
    "issue_pins",
    "comments",
    "pull_requests",
    "issues",
    "labels",
    "repo_collaborators",
    "milestones",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the loader's unit seams --------------------------------------------------------

describe("milestone-detail loader unit seams", () => {
  it("parseMilestoneId admits only safe decimal segments (Go PathParamInt64's garbage → the not-found arm)", () => {
    expect(parseMilestoneId("12")).toBe(12);
    expect(parseMilestoneId("0")).toBe(0);
    expect(parseMilestoneId("")).toBeNull();
    expect(parseMilestoneId("abc")).toBeNull();
    expect(parseMilestoneId("12x")).toBeNull();
    expect(parseMilestoneId("1.5")).toBeNull();
    // Beyond Number.MAX_SAFE_INTEGER — the lookup would miss anyway; the
    // parser refuses it up front.
    expect(parseMilestoneId("99999999999999999999")).toBeNull();
  });

  it("parseMilestoneIssueState is upstream ParseIssueFilterStateIsClosed: 'all' disables, 'closed' closes, everything else is open", () => {
    expect(parseMilestoneIssueState(null)).toBe("open");
    expect(parseMilestoneIssueState("")).toBe("open");
    expect(parseMilestoneIssueState("open")).toBe("open");
    expect(parseMilestoneIssueState("junk")).toBe("open");
    expect(parseMilestoneIssueState("closed")).toBe("closed");
    expect(parseMilestoneIssueState("all")).toBe("all");
  });

  it("findRepoMilestoneById is repo-scoped: the same id is invisible under another repo (the foreign-id 404 arm)", async () => {
    const fx = await ensureFixtures();
    const found = await findRepoMilestoneById(env.DB, fx.repo.id, fx.pagerMilestoneId);
    expect(found?.name).toBe("pager m");
    // The id exists — but under the OTHER repo's scope it is null.
    expect(await findRepoMilestoneById(env.DB, fx.other.id, fx.pagerMilestoneId)).toBeNull();
    expect(await findRepoMilestoneById(env.DB, fx.repo.id, 4_242_424)).toBeNull();
  });

  it("loadMilestoneDetailData filters rows to the milestone, honors ?state=closed, and reports unfiltered tab totals", async () => {
    const fx = await ensureFixtures();
    const data = await loadMilestoneDetailData(
      env.DB, fx.repo, String(fx.pagerMilestoneId), new URLSearchParams(), ORIGIN, LATE,
    );
    expect(data).not.toBeNull();
    expect(data?.milestone.name).toBe("pager m");
    expect(data?.state).toBe("open");
    expect(data?.items).toHaveLength(MILESTONE_ISSUES_PAGE_SIZE);
    for (const item of data?.items ?? []) {
      expect(item.issue.title.startsWith("pager issue")).toBe(true); // no neighbor milestone's rows
      expect(item.issue.isClosed).toBe(false);
    }
    expect(data?.openCount).toBe(21);
    expect(data?.closedCount).toBe(0);
    expect(data?.more).toBe(true);

    const closed = await loadMilestoneDetailData(
      env.DB, fx.repo, String(fx.pagerMilestoneId), new URLSearchParams("state=closed"), ORIGIN, LATE,
    );
    expect(closed?.state).toBe("closed");
    expect(closed?.items).toHaveLength(0);
    // The tab totals stay unfiltered by the state facet.
    expect(closed?.openCount).toBe(21);
    expect(closed?.closedCount).toBe(0);
    expect(closed?.more).toBe(false);
  });

  it("loadMilestoneDetailData resolves the flip arm's 'all' state and the ?state=all explicit view", async () => {
    const fx = await ensureFixtures();
    // No state param + zero open + closed present → all (isShowClosed → None).
    const flipped = await loadMilestoneDetailData(
      env.DB, fx.repo, String(fx.flipMilestoneId), new URLSearchParams(), ORIGIN, LATE,
    );
    expect(flipped?.state).toBe("all");
    expect(flipped?.items.map((item) => item.issue.title)).toEqual(["only closed here"]);

    // The explicit all view on the mixed milestone carries BOTH states.
    const all = await loadMilestoneDetailData(
      env.DB, fx.repo, String(fx.labeledMilestoneId), new URLSearchParams("state=all"), ORIGIN, LATE,
    );
    expect(all?.state).toBe("all");
    expect(all?.openCount).toBe(21);
    expect(all?.closedCount).toBe(1);
    const states = new Set((all?.items ?? []).map((item) => item.issue.isClosed));
    expect(states.has(true)).toBe(true);
    expect(states.has(false)).toBe(true);
  });

  it("loadMilestoneDetailData parses the ?labels= facet and evaluates the overdue clock (open+past only)", async () => {
    const fx = await ensureFixtures();
    const labeled = await loadMilestoneDetailData(
      env.DB, fx.repo, String(fx.labeledMilestoneId), new URLSearchParams(`labels=${fx.bugLabelId}`), ORIGIN, LATE,
    );
    expect(labeled?.labelIds).toEqual([fx.bugLabelId]);
    expect(labeled?.items.every((item) => item.labels.some((label) => label.id === fx.bugLabelId))).toBe(true);

    // Open + past deadline → overdue; the same closed milestone never is.
    const flipped = await loadMilestoneDetailData(
      env.DB, fx.repo, String(fx.flipMilestoneId), new URLSearchParams(), ORIGIN, LATE,
    );
    expect(flipped?.overdue).toBe(true);
    const early = await loadMilestoneDetailData(
      env.DB, fx.repo, String(fx.flipMilestoneId), new URLSearchParams(), ORIGIN, new Date("2020-01-01T00:00:00Z"),
    );
    expect(early?.overdue).toBe(false);
    const shut = await loadMilestoneDetailData(
      env.DB, fx.repo, String(fx.closedPagerMilestoneId), new URLSearchParams(), ORIGIN, LATE,
    );
    expect(shut?.overdue).toBe(false);
  });

  it("loadMilestoneDetailData 404-arms: a garbage segment and a foreign-repo id both return null", async () => {
    const fx = await ensureFixtures();
    expect(await loadMilestoneDetailData(env.DB, fx.repo, "not-a-number", new URLSearchParams(), ORIGIN, LATE)).toBeNull();
    expect(await loadMilestoneDetailData(env.DB, fx.other, String(fx.pagerMilestoneId), new URLSearchParams(), ORIGIN, LATE)).toBeNull();
  });
});

// --- the render seams the wave-26 suite leaves open ----------------------------------

/** One detail row (each row carries exactly one large-title link). */
function rowCount(html: string): number {
  return (html.match(/class="list-item-large-title"/g) ?? []).length;
}

describe("the detail pager (21 issues — the Older/Newer shape with the facets)", () => {
  it("page 1 carries 20 rows and the Older link; page 2's Newer lands on the BARE basePath (the house convention)", async () => {
    const fx = await ensureFixtures();
    const base = `/alice/detail/milestone/${fx.pagerMilestoneId}`;
    const one = await (await fetchUi(base)).text();
    expect(rowCount(one)).toBe(20);
    expect(one).toContain(`<a class="item navigation" href="${base}?page=2"`);
    expect(one).toContain('<span class="navigation_label">Older</span>');
    expect(one).not.toContain('<span class="navigation_label">Newer</span>');

    const two = await (await fetchUi(`${base}?page=2`)).text();
    expect(rowCount(two)).toBe(1);
    // The Newer link drops the canonical page — the open default carries no
    // state facet, so the href is the bare basePath.
    expect(two).toContain(`<a class="item navigation" href="${base}"`);
    expect(two).toContain('<span class="navigation_label">Newer</span>');
    expect(two).not.toContain('<span class="navigation_label">Older</span>');
  });

  it("the closed view's pager keeps state=closed on BOTH directions (this page always carries the non-open facet)", async () => {
    const fx = await ensureFixtures();
    const base = `/alice/detail/milestone/${fx.closedPagerMilestoneId}`;
    const one = await (await fetchUi(`${base}?state=closed`)).text();
    expect(rowCount(one)).toBe(20);
    // The forward link carries the facet with the page param LAST,
    // ampersand HTML-escaped in the attribute.
    expect(one).toContain(`<a class="item navigation" href="${base}?state=closed&amp;page=2"`);

    const two = await (await fetchUi(`${base}?state=closed&page=2`)).text();
    expect(rowCount(two)).toBe(1);
    expect(two).toContain(`<a class="item navigation" href="${base}?state=closed"`);
    expect(two).not.toContain(`<a class="item navigation" href="${base}"`);
  });

  it("the labels facet rides the pager too (?labels=N&page=2; Newer drops only the page)", async () => {
    const fx = await ensureFixtures();
    const base = `/alice/detail/milestone/${fx.labeledMilestoneId}`;
    const one = await (await fetchUi(`${base}?labels=${fx.bugLabelId}`)).text();
    expect(rowCount(one)).toBe(20);
    expect(one).toContain(`<a class="item navigation" href="${base}?labels=${fx.bugLabelId}&amp;page=2"`);

    const two = await (await fetchUi(`${base}?labels=${fx.bugLabelId}&page=2`)).text();
    expect(rowCount(two)).toBe(1);
    expect(two).toContain(`<a class="item navigation" href="${base}?labels=${fx.bugLabelId}"`);
  });

  it("junk ?page= parses as 1; a past-the-end page renders row-less with ONLY the Newer link (no upper clamp)", async () => {
    const fx = await ensureFixtures();
    const base = `/alice/detail/milestone/${fx.pagerMilestoneId}`;
    const junk = await (await fetchUi(`${base}?page=abc`)).text();
    expect(rowCount(junk)).toBe(20);
    expect(junk).toContain(`<a class="item navigation" href="${base}?page=2"`);

    const pastRes = await fetchUi(`${base}?page=99`);
    expect(pastRes.status).toBe(200);
    const past = await pastRes.text();
    expect(rowCount(past)).toBe(0);
    // Page > 1 keeps the pager alive with ONLY the Newer link, onto page-1-
    // of-the-request (98 — the §4.11 no-upper-clamp posture, the list
    // page's convention).
    expect(past).toContain(`<a class="item navigation" href="${base}?page=98"`);
    expect(past).toContain('<span class="navigation_label">Newer</span>');
    expect(past).not.toContain('<span class="navigation_label">Older</span>');
  });
});

describe("the detail empty state (a milestone with zero issues)", () => {
  it("renders the no-results arm and no issue-list body; the pager stays hidden", async () => {
    const fx = await ensureFixtures();
    const res = await fetchUi(`/alice/detail/milestone/${fx.emptyMilestoneId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1 class=\"tw-flex-1 tw-m-0\">empty m</h1>");
    expect(html).toContain("No results");
    expect(html).toContain("Try adjusting your search filters.");
    expect(html).not.toContain('id="issue-list"');
    expect(html).not.toContain('<span class="navigation_label">');
    // Zero issues on BOTH sides: the flip arm must NOT fire (the URL carried
    // no state, but there are no closed issues to flip to all for).
    expect(html).toContain("?state=open");
  });
});
