/**
 * The issues-search-aux module tests (the notification-subscriptions
 * fixture discipline): the module is UNMOUNTED — both feed handlers are
 * index-owned (the module header's mount recipe carries the mapping) — so
 * the tests drive the parsers, loaders, and Response builders DIRECTLY on
 * real D1 + real bindings (workerd, @cloudflare/vitest-plugin) over seeded
 * repos/issues/labels/milestones/PRs.
 *
 * Feed A asserts the web /issues/search grammar from the pin's handler
 * (issue_list.go:196-308): the state/type tri-states, the fixed
 * created-desc order, the milestone name-then-id resolution, the
 * username→404 filter arms, the assignee/project void postures, the
 * RFC3339 422 (before-first), the X-Total-Count header set and the
 * full-Issue envelope. Feed B asserts GetSuggestion's two passes
 * (suggestion.go:16-73): the latest-5 arm, the title-only keyword pass,
 * the isPull-blind exact-index prepend, the zero-marshalled envelope and
 * the PR pull_request block.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { pullRequests } from "../../db/schema";
import {
  clampedPaging,
  issuesSearchResponse,
  issuesSuggestionsResponse,
  loadIssuesSearchAux,
  loadIssuesSuggestionsAux,
  parseIssueIndexKeyword,
  parseIssuesSearchQuery,
  parseProjectIdsParam,
  suggestionsIsPullFilter,
  type IssuesAuxViewer,
  type IssuesSearchAuxOutcome,
} from "./issues-search-aux";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_750_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);
const rfc = (offsetSeconds: number): string => at(offsetSeconds).toISOString();

const viewer: IssuesAuxViewer = { id: 1, username: "origin", isAdmin: false };
const ORIGIN = "https://test.local";

interface Seeded {
  origin: { id: number; username: string };
  other: { id: number; username: string };
  repoId: string;
  /** index → row id map for the created threads (issues AND pulls). */
  indexes: Map<number, { id: number; title: string; isPull: boolean }>;
}

let seeded: Seeded | undefined;

async function seed(): Promise<Seeded> {
  if (seeded !== undefined) return seeded;
  const origin = await seedVerifiedUser({ username: "origin" });
  const other = await seedVerifiedUser({ username: "other" });
  const repo = await new RepoService(env.DB).create({
    owner: { id: origin.id, usernameLower: "origin" },
    name: "alphabet",
    isPrivate: false,
    status: "ready",
  });
  const svc = new IssuesService(env.DB);
  const indexes = new Map<number, { id: number; title: string; isPull: boolean }>();
  const track = (index: number, row: { id: number; title: string }, isPull = false): void => {
    indexes.set(index, { id: row.id, title: row.title, isPull });
  };
  // Six threads, staggered created/updated stamps, alphabetic titles (the
  // digit-keyword tests rely on no title matching a bare number).
  track(1, await svc.createIssue({ repoId: repo.id, title: "alpha bug", posterId: origin.id, now: at(10) }));
  track(2, await svc.createIssue({ repoId: repo.id, title: "beta feature", posterId: other.id, now: at(20) }));
  track(3, await svc.createIssue({ repoId: repo.id, title: "gamma", content: "needle in body", posterId: origin.id, now: at(30) }));
  const closed = await svc.createIssue({ repoId: repo.id, title: "delta closed", posterId: origin.id, now: at(40) });
  track(4, closed);
  await svc.closeIssue(closed.id, { now: at(45) });
  track(5, (await svc.createPullRequest({ repoId: repo.id, title: "WIP: epsilon pull", posterId: origin.id, headRepoId: repo.id, baseBranch: "main", headBranch: "feat", now: at(50) })).issue, true);
  const merged = await svc.createPullRequest({ repoId: repo.id, title: "zeta pull", posterId: origin.id, headRepoId: repo.id, baseBranch: "main", headBranch: "main2", now: at(60) });
  track(6, merged.issue, true);
  await drizzle(env.DB).update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.issueId, merged.issue.id));

  seeded = { origin, other, repoId: repo.id, indexes };
  return seeded;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "issue_labels",
    "issue_subscriptions",
    "milestones",
    "pull_requests",
    "comments",
    "issues",
    "repo_settings",
    "repo_counters",
    "repo_units",
    "repo_redirects",
    "repositories",
    "personal_access_tokens",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  seeded = undefined;
});

// --- the pure parsers ---------------------------------------------------------

describe("parse helpers", () => {
  it("parseProjectIdsParam: FormStringInt64s semantics — empties skipped, one bad entry poisons the whole list to nil", () => {
    expect(parseProjectIdsParam(null)).toEqual([]);
    expect(parseProjectIdsParam("")).toEqual([]);
    expect(parseProjectIdsParam("-1")).toEqual([-1]);
    expect(parseProjectIdsParam("3,,5")).toEqual([3, 5]);
    expect(parseProjectIdsParam("3,abc")).toEqual([]); // poisoned → NO filter, not [3]
    expect(parseProjectIdsParam("abc")).toEqual([]);
  });

  it("parseIssueIndexKeyword: strconv.ParseInt — signs and leading zeros parse, junk and overflow error to 0", () => {
    expect(parseIssueIndexKeyword("7")).toBe(7);
    expect(parseIssueIndexKeyword("+7")).toBe(7);
    expect(parseIssueIndexKeyword("007")).toBe(7);
    expect(parseIssueIndexKeyword("-7")).toBe(-7); // parsed; the >0 gate discards it
    expect(parseIssueIndexKeyword("7abc")).toBe(0);
    expect(parseIssueIndexKeyword(" 7")).toBe(0); // ParseInt has no trim
    expect(parseIssueIndexKeyword("99999999999999999999")).toBe(0); // int64 overflow
  });

  it("suggestionsIsPullFilter: the unit-read narrowing (issue_suggestions.go:19-27)", () => {
    expect(suggestionsIsPullFilter(true, true)).toBeNull();
    expect(suggestionsIsPullFilter(false, false)).toBeNull();
    expect(suggestionsIsPullFilter(true, false)).toBe(false);
    expect(suggestionsIsPullFilter(false, true)).toBe(true);
  });

  it("clampedPaging: FormInt + ToCorrectPageSize (<=0 → 30, >50 → 50; page <=0 → 1)", () => {
    expect(clampedPaging(new URL("http://x/alphabet/issues/search"))).toEqual({ page: 1, limit: 30 });
    expect(clampedPaging(new URL("http://x/alphabet/issues/search?page=0&limit=0")).limit).toBe(30);
    expect(clampedPaging(new URL("http://x/alphabet/issues/search?limit=999")).limit).toBe(50);
    expect(clampedPaging(new URL("http://x/alphabet/issues/search?limit=7&page=3"))).toEqual({ page: 3, limit: 7 });
    expect(clampedPaging(new URL("http://x/alphabet/issues/search?limit=7.5&page=abc"))).toEqual({ page: 1, limit: 30 });
  });

  it("parseIssuesSearchQuery: the before-first 422 order and the trimmed keyword", () => {
    const badBoth = parseIssuesSearchQuery(new URL("http://x/issues/search?before=nope&since=also-nope"));
    expect(badBoth.ok).toBe(false);
    if (!badBoth.ok) {
      // GetQueryBeforeSince parses BEFORE first (utils.go:12-16) — the
      // message cites the before value.
      expect(badBoth.unprocessable).toBe('parsing time "nope" as "2006-01-02T15:04:05Z07:00": cannot parse "nope" as "2006"');
    }
    const ok = parseIssuesSearchQuery(new URL("http://x/issues/search?q=%20bug+report%20&type=pulls"));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.query.keyword).toBe("bug report"); // FormTrim strips the OUTER spaces only (+ is a space)
      expect(ok.query.isPull).toBe(true);
      expect(ok.query.isClosed).toBe(false);
      expect(ok.query.milestoneEntries).toEqual([""]); // strings.Split of "" → [""]
      expect(ok.query.since).toBeNull();
      expect(ok.query.before).toBeNull();
    }
  });
});

// --- feed A: /issues/search -----------------------------------------------------

/** Drive the loader with query params (the mount builds this URL). */
async function search(params: string): Promise<IssuesSearchAuxOutcome> {
  const s = await seed();
  return loadIssuesSearchAux(env, { id: s.repoId, isArchived: false }, viewer, ORIGIN, new URL(`http://x/alphabet/issues/search${params}`));
}

describe("loadIssuesSearchAux — the web /issues/search grammar", () => {
  it("default arm: open issues+pulls, fixed created-desc order, the full Issue envelope", async () => {
    const result = await search("");
    expect(result.kind).toBe("feed");
    if (result.kind !== "feed") return;
    expect(result.total).toBe(5); // #4 is closed
    expect(result.issues.map((issue) => issue.number)).toEqual([6, 5, 3, 2, 1]); // SortByCreatedDesc
    const first = result.issues[0];
    if (first === undefined) throw new Error("first issue missing");
    expect(first.title).toBe("zeta pull");
    expect(first.state).toBe("open");
    expect(first.user?.login).toBe("origin");
    expect(first.html_url).toBe(`${ORIGIN}/origin/alphabet/issues/6`);
    const repository = first.repository;
    if (repository == null) throw new Error("repository meta missing");
    expect(repository.name).toBe("alphabet");
    expect(repository.owner).toBe("origin");
    expect(repository.full_name).toBe("origin/alphabet");
    expect(typeof repository.id).toBe("number"); // the numeric rendering of the text registry id
  });

  it("state and type tri-states (ParseIssueFilterStateIsClosed / ParseIssueFilterTypeIsPull)", async () => {
    const closed = await search("?state=closed");
    if (closed.kind !== "feed") throw new Error("closed arm");
    expect(closed.issues.map((issue) => issue.number)).toEqual([4]);

    const all = await search("?state=all");
    if (all.kind !== "feed") throw new Error("all arm");
    expect(all.total).toBe(6);

    const unknownState = await search("?state=weird");
    if (unknownState.kind !== "feed") throw new Error("unknown-state arm");
    expect(unknownState.total).toBe(5); // unknown degrades to open

    const pulls = await search("?type=pulls");
    if (pulls.kind !== "feed") throw new Error("pulls arm");
    expect(pulls.issues.map((issue) => issue.number)).toEqual([6, 5]);

    const issues = await search("?type=issues&state=all");
    if (issues.kind !== "feed") throw new Error("issues arm");
    expect(issues.total).toBe(4);

    const unknownType = await search("?type=neither");
    if (unknownType.kind !== "feed") throw new Error("unknown-type arm");
    expect(unknownType.total).toBe(5); // no filter
  });

  it("keyword: FormTrim q over title AND content (the landed [ok] search machinery)", async () => {
    const byTitle = await search("?q=ALPHA"); // case-insensitive
    if (byTitle.kind !== "feed") throw new Error("title arm");
    expect(byTitle.issues.map((issue) => issue.number)).toEqual([1]);

    const byContent = await search("?q=needle"); // #3's content only
    if (byContent.kind !== "feed") throw new Error("content arm");
    expect(byContent.issues.map((issue) => issue.number)).toEqual([3]);

    const trimmed = await search("?q=%20gamma%20");
    if (trimmed.kind !== "feed") throw new Error("trim arm");
    expect(trimmed.total).toBe(1);

    // A WHITESPACE-ONLY q trims to the empty keyword → the UNFILTERED feed
    // (issue_list.go:202 FormTrim — the trimmed arm collapses to the default
    // read, never a no-match reply).
    const blank = await search("?q=%20%20%20&state=all");
    if (blank.kind !== "feed") throw new Error("blank arm");
    expect(blank.total).toBe(6);
  });

  it("milestones: names first then numeric ids, repo-scoped, misses discarded (own repo — no pollution of the shared fixture)", async () => {
    const s = await seed();
    const repo = await new RepoService(env.DB).create({
      owner: { id: s.origin.id, usernameLower: "origin" },
      name: "tracker",
      isPrivate: false,
      status: "ready",
    });
    const svc = new IssuesService(env.DB);
    const milestone = await svc.createMilestone({ repoId: repo.id, name: "v1.0", now: at(0) });
    const tracked = await svc.createIssue({ repoId: repo.id, title: "milestoned", posterId: s.origin.id, milestoneId: milestone.id, now: at(70) });

    const drive = (params: string): Promise<IssuesSearchAuxOutcome> =>
      loadIssuesSearchAux(env, { id: repo.id, isArchived: false }, viewer, ORIGIN, new URL(`http://x/origin/tracker/issues/search${params}`));

    const byName = await drive("?milestones=v1.0");
    if (byName.kind !== "feed") throw new Error("name arm");
    expect(byName.issues.map((issue) => issue.number)).toEqual([tracked.index]);

    const byId = await drive(`?milestones=${milestone.id}`);
    if (byId.kind !== "feed") throw new Error("id arm");
    expect(byId.total).toBe(1);

    const mixed = await drive(`?milestones=v9.9,${milestone.id}`); // misses discarded
    if (mixed.kind !== "feed") throw new Error("mixed arm");
    expect(mixed.total).toBe(1);

    const empty = await drive("?milestones="); // [""] → discarded → no filter
    if (empty.kind !== "feed") throw new Error("empty arm");
    expect(empty.total).toBe(1);
  });

  it("created_by: an existing login filters to the poster; an unknown login is the 404 arm", async () => {
    const s = await seed();
    const byPoster = await search(`?created_by=${s.other.username}&state=all`);
    if (byPoster.kind !== "feed") throw new Error("poster arm");
    expect(byPoster.issues.map((issue) => issue.number)).toEqual([2]);

    const unknown = await search("?created_by=ghost&state=all");
    expect(unknown).toEqual({ kind: "notFound", login: "ghost" });
  });

  it("assigned_by / mentioned_by: existing logins conjoin to the empty set (no assignee data), unknown logins 404", async () => {
    const s = await seed();
    const assigned = await search(`?assigned_by=${s.origin.username}&state=all`);
    expect(assigned).toEqual({ kind: "feed", issues: [], total: 0 });

    const mentioned = await search(`?mentioned_by=${s.origin.username}&state=all`);
    expect(mentioned).toEqual({ kind: "feed", issues: [], total: 0 });

    const unknown = await search("?mentioned_by=ghost");
    expect(unknown).toEqual({ kind: "notFound", login: "ghost" });

    // created_by ∧ assigned_by stays the empty conjunction (never just the poster arm).
    const both = await search(`?created_by=${s.origin.username}&assigned_by=${s.origin.username}&state=all`);
    expect(both).toEqual({ kind: "feed", issues: [], total: 0 });
  });

  it("project: [-1] is the NoProjectOnly no-op, concrete ids match the empty set, a poisoned list filters nothing", async () => {
    const all = await search("?state=all&project=-1");
    if (all.kind !== "feed") throw new Error("nopproject arm");
    expect(all.total).toBe(6);

    const concrete = await search("?state=all&project=5");
    expect(concrete).toEqual({ kind: "feed", issues: [], total: 0 });

    const poisoned = await search("?state=all&project=3,abc");
    if (poisoned.kind !== "feed") throw new Error("poisoned arm");
    expect(poisoned.total).toBe(6); // nil list → no filter
  });

  it("since/before: RFC3339 updated-windows on the landed row stamps", async () => {
    const since = await search(`?since=${encodeURIComponent(rfc(42))}&state=all`); // updated at 45/50/60
    if (since.kind !== "feed") throw new Error("since arm");
    expect(since.issues.map((issue) => issue.number)).toEqual([6, 5, 4]);

    const before = await search(`?before=${encodeURIComponent(rfc(25))}&state=all`); // updated at 10/20
    if (before.kind !== "feed") throw new Error("before arm");
    expect(before.issues.map((issue) => issue.number)).toEqual([2, 1]);
  });

  it("pagination: page/limit ride the clamped pair and X-Total-Count counts the whole filter", async () => {
    const page2 = await search("?state=all&limit=2&page=2");
    if (page2.kind !== "feed") throw new Error("page arm");
    expect(page2.total).toBe(6);
    expect(page2.issues.map((issue) => issue.number)).toEqual([4, 3]);

    const response = issuesSearchResponse(page2);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(response.headers.get("x-total-count")).toBe("6");
    expect(response.headers.get("access-control-expose-headers")).toBe("X-Total-Count");
    expect(response.headers.get("link")).toBeNull(); // web Base never sends a Link header
    const body: Array<{ number: number }> = await response.json();
    expect(body).toHaveLength(2);
  });

  it("the Response builders' error arms: 422 plain text (http.Error) and the 404 shell passthrough", async () => {
    const bad = await search("?since=nope");
    expect(bad.kind).toBe("unprocessable");
    if (bad.kind !== "unprocessable") return;
    const unprocessable = issuesSearchResponse(bad);
    expect(unprocessable.status).toBe(422);
    expect(unprocessable.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await unprocessable.text()).toBe('parsing time "nope" as "2006-01-02T15:04:05Z07:00": cannot parse "nope" as "2006"\n');

    const missing = await search("?created_by=ghost");
    if (missing.kind !== "notFound") throw new Error("notFound arm");
    const notFound = issuesSearchResponse(missing, "<html>not found</html>");
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await notFound.text()).toBe("<html>not found</html>");
  });
});

// --- feed B: /issues/suggestions -------------------------------------------------

describe("loadIssuesSuggestionsAux — GetSuggestion", () => {
  it("empty keyword: the 5 latest-updated threads, issues AND pulls (FindLatestUpdatedIssues)", async () => {
    const s = await seed();
    const suggestions = await loadIssuesSuggestionsAux(env, s.repoId, null, "");
    expect(suggestions.map((item) => item.number)).toEqual([6, 5, 4, 3, 2]); // updated_unix DESC
    expect(suggestions).toHaveLength(5); // pageSize 5 — #1 falls off
  });

  it("keyword: title-ONLY case-insensitive LIKE, updated DESC then index DESC (issue.go:535-542)", async () => {
    const s = await seed();
    // "needle" lives only in #3's CONTENT — the suggestion pass must NOT see it.
    const contentOnly = await loadIssuesSuggestionsAux(env, s.repoId, null, "needle");
    expect(contentOnly).toEqual([]);

    // "a" matches alpha(1)/beta(2)/gamma(3)/delta(4)/zeta(6) — "WIP: epsilon
    // pull" has no "a". Five matches fill all five slots, updated DESC.
    const keyword = await loadIssuesSuggestionsAux(env, s.repoId, null, "A");
    expect(keyword.map((item) => item.number)).toEqual([6, 4, 3, 2, 1]);

    // The query-shape arms (issue_suggestions.go:17 — FormValue, NEVER
    // trimmed): a whitespace-ONLY q is a legal needle, not the empty one.
    // Three spaces match no seeded title (none carries a triple space) and
    // the numeric-index arm never fires on a non-`[+-]?\d+` needle.
    const blank = await loadIssuesSuggestionsAux(env, s.repoId, null, "   ");
    expect(blank).toEqual([]);
    // A SINGLE space matches every space-bearing title — every seeded title
    // but #3 "gamma" carries one — updated DESC, filling all five slots
    // (issue.go:535's title-only BuildCaseInsensitiveLike passes the raw q
    // through untouched).
    const oneSpace = await loadIssuesSuggestionsAux(env, s.repoId, null, " ");
    expect(oneSpace.map((item) => item.number)).toEqual([6, 5, 4, 2, 1]);

    // The keyword arm must not cap (the 943e1e9 org-members class — D1's
    // 50-byte LIKE pattern limit): a 200-char needle passes the boundary
    // as the clean no-match answer, not a D1_ERROR throw.
    const longNeedle = await loadIssuesSuggestionsAux(env, s.repoId, null, "z".repeat(200));
    expect(longNeedle).toEqual([]);
  });

  it("the exact-index hit is PREPENDED even when the title does not match and the pass ignores isPull", async () => {
    const s = await seed();
    // q="2": no title contains a digit — the keyword pass is empty, #2 arrives via GetIssueByIndex.
    const byIndex = await loadIssuesSuggestionsAux(env, s.repoId, null, "2");
    expect(byIndex.map((item) => item.number)).toEqual([2]);

    // #5 is a PULL — an issues-only narrowing still surfaces the index hit (suggestion.go:30-37).
    const pullIndexIssuesOnly = await loadIssuesSuggestionsAux(env, s.repoId, false, "5");
    expect(pullIndexIssuesOnly.map((item) => item.number)).toEqual([5]);

    // Non-numeric keywords never hit the index arm.
    const junk = await loadIssuesSuggestionsAux(env, s.repoId, null, "alpha");
    expect(junk.map((item) => item.number)).toEqual([1]);
    const negative = await loadIssuesSuggestionsAux(env, s.repoId, null, "-1"); // parsed but <= 0
    expect(negative).toEqual([]);

    // A numeric index past the repo's range adds nothing.
    const missing = await loadIssuesSuggestionsAux(env, s.repoId, null, "99");
    expect(missing).toEqual([]);
  });

  it("the index hit keeps the pageSize at 5 total (4 keyword slots + the prepend)", async () => {
    const s = await seed();
    // Own repo: five digit-titled threads so the numeric keyword's LIKE
    // pass has more matches than the 4 remaining slots. The repo's index 2
    // is itself digit-titled — it must appear ONCE (the prepend), its
    // keyword duplicate excluded by id.
    const repo = await new RepoService(env.DB).create({
      owner: { id: s.origin.id, usernameLower: "origin" },
      name: "digit-titles",
      isPrivate: false,
      status: "ready",
    });
    const svc = new IssuesService(env.DB);
    for (let i = 0; i < 5; i += 1) {
      await svc.createIssue({ repoId: repo.id, title: `batch 2 item ${i}`, posterId: s.origin.id, now: at(80 + i) });
    }
    const mixed = await loadIssuesSuggestionsAux(env, repo.id, null, "2");
    expect(mixed).toHaveLength(5);
    expect(mixed.map((item) => item.number)).toEqual([2, 5, 4, 3, 1]); // prepend + the 4 latest matches
    expect(mixed.filter((item) => item.number === 2)).toHaveLength(1); // no duplicate
  });

  it("the isPull narrowing filters the keyword pass and the latest pass alike", async () => {
    const s = await seed();
    const pulls = await loadIssuesSuggestionsAux(env, s.repoId, true, "");
    expect(pulls.map((item) => item.number)).toEqual([6, 5]);
    const issues = await loadIssuesSuggestionsAux(env, s.repoId, false, "");
    expect(issues.map((item) => item.number)).toEqual([4, 3, 2, 1]);
  });

  it("suggestions carry the zero-marshalled Issue envelope; PRs add the GetSuggestion pull_request block", async () => {
    const s = await seed();
    const [merged, wip, plain] = await Promise.all([
      loadIssuesSuggestionsAux(env, s.repoId, null, "zeta"),
      loadIssuesSuggestionsAux(env, s.repoId, null, "epsilon"),
      loadIssuesSuggestionsAux(env, s.repoId, null, "gamma"),
    ]);
    expect(merged).toHaveLength(1);
    const zeta = merged[0];
    if (zeta === undefined) throw new Error("zeta missing");
    expect(zeta).toEqual({
      id: s.indexes.get(6)?.id,
      url: "",
      html_url: "",
      number: 6,
      user: null,
      title: "zeta pull",
      body: "",
      ref: "",
      assets: null,
      labels: null,
      milestone: null,
      projects: null,
      assignee: null,
      assignees: null,
      state: "open",
      is_locked: false,
      comments: 0,
      created_at: "0001-01-01T00:00:00Z",
      updated_at: "0001-01-01T00:00:00Z",
      closed_at: null,
      due_date: null,
      time_estimate: 0,
      pull_request: { merged: true, merged_at: null, draft: false, html_url: "" },
      repository: null,
      pin_order: 0,
      content_version: 0,
    });

    expect(wip[0]?.pull_request).toEqual({ merged: false, merged_at: null, draft: true, html_url: "" }); // "WIP: " prefix
    expect(plain[0]?.pull_request).toBeNull(); // plain issues carry no block
    expect(plain[0]?.state).toBe("open");

    const closed = await loadIssuesSuggestionsAux(env, s.repoId, null, "delta");
    expect(closed[0]?.state).toBe("closed");
  });

  it("issuesSuggestionsResponse: ctx.JSON headers, NO X-Total-Count (IssueSuggestions never sets one)", async () => {
    const response = issuesSuggestionsResponse([
      {
        id: 1,
        url: "",
        html_url: "",
        number: 1,
        user: null,
        title: "t",
        body: "",
        ref: "",
        assets: null,
        labels: null,
        milestone: null,
        projects: null,
        assignee: null,
        assignees: null,
        state: "open",
        is_locked: false,
        comments: 0,
        created_at: "0001-01-01T00:00:00Z",
        updated_at: "0001-01-01T00:00:00Z",
        closed_at: null,
        due_date: null,
        time_estimate: 0,
        pull_request: null,
        repository: null,
        pin_order: 0,
        content_version: 0,
      },
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(response.headers.get("x-total-count")).toBeNull();
    const body: Array<{ title: string }> = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0]?.title).toBe("t");
  });
});
