/**
 * The search-aux JSON feeds' DEFERRED route-level matrix — the polish wave's
 * piece of the coverage split (pages/search-aux.ts, mounted at
 * `GET /repo/search` + `GET /explore/topics/search`, index.ts:9509/9679):
 *
 *   - pages/search-aux.smoke.test.ts drives BOTH feed loaders + Response
 *     builders DIRECTLY on real bindings — it owns the happy-path wire
 *     shapes (the zero-padded api.Repository, the raw-model commit-status
 *     shell, the topic envelope) and explicitly defers the rest: "the
 *     polish wave owns the error arms … the route arm is index-owned".
 *     Until this file the two feeds had NO mounted-route test at all — no
 *     gate dispatch, no route-owned error arm, not even the positive claim
 *     pins (explore.matrix.test.ts pins the unclaimed NEIGHBORS and says
 *     "the claimed 4-segment aux is search-aux's own pin").
 *
 * THIS FILE adds what only the MOUNTED ROUTE can prove, on the aux-
 * fragments matrix harness (the minted-session pattern, synthetic ASSETS
 * manifest):
 *
 *   - the claim pins: parseUiRoute's exact families for both literals
 *     (including the static-beats-dynamic shadow — `/repo/search` claims
 *     ahead of the owner/repo pair that would read owner=repo, repo=search)
 *     and the deeper tails staying engine-owned;
 *   - the gates: /repo/search's reqSignIn (anonymous 303s onto the login
 *     round-trip carrying the exact path — never a JSON envelope), the
 *     topics feed's optExploreSignIn (anonymous served, no gate), the
 *     signed-in visibility grant (the default `private=true` resolution
 *     does NOT bypass it — a signed-in non-owner still misses the private
 *     row), and both registrations' GET-only edge (POST → the plain 404);
 *   - the route-owned error arms: the SearchAuxParamError → 422 plain-text
 *     mapping (upstream ctx.HTTPError's never-JSON posture) with the exact
 *     Go-%q message strings, and the §4.13 trailing-slash 301 onto the
 *     canonical literal;
 *   - the wire grammar through the real request URL: feed 1's FormTrim (a
 *     padded keyword still matches) against feed 2's FormString no-trim
 *     divergence (a padded keyword matches nothing), the count_only
 *     builder swap (body exactly `{"ok":true}` under the full header
 *     quartet), the topics paging (X-Total-Count counts the matches, not
 *     the page) and the ASCII-case-insensitive keyword;
 *   - batch 5's query-shape arms: the ABSENT q on both feeds (the
 *     unfiltered scope — feed 1 rides the keyword-less plainjane row and
 *     stays visibility-collapsed for the outsider; feed 2 rides alphatopic),
 *     the WHITESPACE-ONLY q split (feed 1's FormTrim collapses it to the
 *     unfiltered scope; feed 2's FormString keeps it a legal no-match
 *     needle). No truncation boundary exists to pin: neither feed's keyword
 *     is length-capped upstream (repo.go:430 FormTrim, topic.go:22
 *     FormString — no documented truncation at this pin).
 *
 * Fixture: the `auxjson` namespace is this file's private world (distinct
 * from every sibling fixture — the smoke's `search-aux-smoke` rows and the
 * aux-fragments matrix's `aux-alice` repos match neither feed's keyword),
 * idempotent per the seed-repo convention: one pushed repo carrying a
 * commit-status row on main's tip, two D1-only repos (public + private)
 * beside it — the keyword `searchmark` lives in all three SLUGS (the LIKE
 * match is the repo name, not the owner segment), so every count pins
 * exactly — and four topic rows over three topics across the public two
 * (zetatopic ×2, then the two 1-count rows in name order). Reruns
 * converge; no test deletes a row.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { commitStatuses, repoTopics, repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import type { WebSearchAuxItem } from "./search-aux";

// --- the minted-session route harness (the aux-fragments matrix pattern) -------

/** Synthetic manifest shaped like the real Vite output (deterministic, no
 *  build dependence — the shared matrix fixture shape). */
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
 *  minted per request — no cross-test cookie can go stale). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

// --- fixture -------------------------------------------------------------------

const T0 = 1_710_000_000; // 2024-03-09T16:00:00Z — the harness epoch

const AUXJSON_COMMITS: SeedCommit[] = [
  {
    message: "aux-json matrix: root commit",
    time: T0,
    files: [{ path: "README.md", content: "# aux-json matrix\n" }],
  },
];

interface AuxJsonFixture {
  owner: { id: number; username: string };
  outsider: { id: number; username: string };
  tip: string;
  statusRepoId: string;
}

/** Idempotent seed: the `auxjson` owner + outsider, the pushed public
 *  `auxjson/searchmark-statuscarrying` (main at the root commit, a success
 *  commit status on the tip), the D1-only `auxjson/searchmark-plain` +
 *  private `auxjson/searchmark-vaulted` (no engine push — the null-status
 *  arm) + keyword-less public `auxjson/plainjane` (the empty-q arm's proof
 *  row: unfiltered scope exceeds every keyword count), and the topic rows
 *  zetatopic ×2 / zetaalpha ×1 / zetabetter ×1 / alphatopic ×1 (repo_count
 *  DESC + the name tiebreak; "zeta" collides with no sibling fixture's
 *  keyword, and alphatopic is the topics feed's empty-q proof row). */
async function ensureAuxJsonFixture(): Promise<AuxJsonFixture> {
  await applyAuthD1Migrations();
  const seeded = await ensureSeededRepo({
    owner: "auxjson",
    slug: "searchmark-statuscarrying",
    commits: AUXJSON_COMMITS,
  });
  const tip = seeded.tips[seeded.tips.length - 1];
  if (tip === undefined) throw new Error("seed produced no tips");

  const db = drizzle(env.DB);
  const ownerRow = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "auxjson")).get();
  if (ownerRow === undefined) throw new Error("auxjson owner row missing");
  const existingOutsider = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, "auxjson-outsider"))
    .get();
  const outsider =
    existingOutsider !== undefined
      ? { id: existingOutsider.id, username: "auxjson-outsider" }
      : await seedVerifiedUser({ username: "auxjson-outsider" });

  const statusRepo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "auxjson"), eq(repositories.slug, "searchmark-statuscarrying")))
    .get();
  if (statusRepo === undefined) throw new Error("seeded repo row missing");

  // The two D1-only rows (public + private — no engine cell, so the feed's
  // listRefs read misses and the status renders null, the smoke's -b arm)
  // plus the keyword-less plainjane (the empty-q proof row).
  for (const spec of [
    { name: "searchmark-plain", isPrivate: false },
    { name: "searchmark-vaulted", isPrivate: true },
    { name: "plainjane", isPrivate: false },
  ] as const) {
    const existing = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "auxjson"), eq(repositories.slug, spec.name)))
      .get();
    if (existing === undefined) {
      await new RepoService(env.DB).create({
        owner: { id: ownerRow.id, usernameLower: "auxjson" },
        name: spec.name,
        isPrivate: spec.isPrivate,
        status: "ready",
      });
    }
  }

  const existingStatus = await db
    .select({ id: commitStatuses.id })
    .from(commitStatuses)
    .where(and(eq(commitStatuses.repoId, statusRepo.id), eq(commitStatuses.sha, tip)))
    .get();
  if (existingStatus === undefined) {
    await db.insert(commitStatuses).values({
      repoId: statusRepo.id,
      sha: tip,
      targetUrl: "https://ci.example/auxjson/1",
      context: "ci/auxjson",
      state: "success",
      creatorId: ownerRow.id,
      createdAt: new Date(T0 * 1000),
      updatedAt: new Date(T0 * 1000),
    });
  }

  const existingTopics = await db
    .select({ topic: repoTopics.topic })
    .from(repoTopics)
    .where(eq(repoTopics.repoId, statusRepo.id))
    .all();
  if (existingTopics.length === 0) {
    const plain = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "auxjson"), eq(repositories.slug, "searchmark-plain")))
      .get();
    if (plain === undefined) throw new Error("D1-only plain row missing");
    await db.insert(repoTopics).values([
      { repoId: statusRepo.id, topic: "zetatopic" },
      { repoId: statusRepo.id, topic: "alphatopic" },
      { repoId: plain.id, topic: "zetatopic" },
      { repoId: plain.id, topic: "zetaalpha" },
      { repoId: plain.id, topic: "zetabetter" },
    ]);
  }

  return { owner: { id: ownerRow.id, username: "auxjson" }, outsider, tip, statusRepoId: statusRepo.id };
}

let fixture: AuxJsonFixture;

beforeAll(async () => {
  fixture = await ensureAuxJsonFixture();
});

// --- the claim pins (parseUiRoute / handlesUiRoute) ------------------------------

describe("the search-aux claim pins (parseUiRoute / handlesUiRoute)", () => {
  it("claims /repo/search exactly, shadowing the owner/repo pair it prefixes", () => {
    // The static literal wins over the dynamic /:owner/:repo parse (the
    // wave-19 registration-order rule): upstream's /repo group registers
    // ahead of the dynamic pairs (web.go:1097-1103), so a repository named
    // "search" under an owner named "repo" reads as the AUX FEED, not a
    // repo page.
    expect(parseUiRoute("/repo/search")).toEqual({ family: "repo-search-aux" });
    expect(handlesUiRoute("/repo/search")).toBe(true);
    // The deeper tail stays engine-owned (the aux shape is exactly three
    // segments).
    expect(parseUiRoute("/repo/search/extra")).toBeNull();
    expect(handlesUiRoute("/repo/search/extra")).toBe(false);
  });

  it("claims /explore/topics/search exactly — the positive pin explore.matrix deferred to this file", () => {
    expect(parseUiRoute("/explore/topics/search")).toEqual({ family: "explore-topic-search-aux" });
    expect(handlesUiRoute("/explore/topics/search")).toBe(true);
    // The unclaimed NEIGHBORS (/explore/topics, the deeper tail) are
    // explore.matrix.test.ts's own pins — not repeated here.
  });
});

// --- feed 1: GET /repo/search through the mounted route --------------------------

describe("GET /repo/search through the mounted route", () => {
  it("reqSignIn: anonymous 303s onto the login round-trip carrying the exact path, never a JSON envelope", async () => {
    const res = await fetchUi("/repo/search");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/repo/search")}`);
    expect(await res.text()).toBe("");
  });

  it("serves the signed-in owner the full wire envelope: the header quartet, the alpha order, the status shell", async () => {
    const res = await fetchUi("/repo/search?q=searchmark", {
      headers: { cookie: await sessionHeader(fixture.owner.id) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    // Three rows match q=searchmark for the OWNER: searchmark-plain,
    // searchmark-statuscarrying AND the private searchmark-vaulted (the
    // signed-in default `private=true` — repo .go:436's IsSigned conjunct,
    // resolved by the route gate).
    expect(res.headers.get("x-total-count")).toBe("3");
    expect(res.headers.get("access-control-expose-headers")).toBe("X-Total-Count");

    const body = await res.json<{ ok: boolean; data: WebSearchAuxItem[] }>();
    expect(body.ok).toBe(true);
    expect(body.data.map((item) => item.repository.full_name)).toEqual([
      "auxjson/searchmark-plain",
      "auxjson/searchmark-statuscarrying",
      "auxjson/searchmark-vaulted",
    ]);
    // The private row rides for its owner (private=true on the wire).
    expect(body.data[2]?.repository.private).toBe(true);
    // The pushed row carries the tip's combined status; the D1-only rows
    // render the no-omitempty nulls.
    expect(body.data[1]?.latest_commit_status?.State).toBe("success");
    expect(body.data[1]?.latest_commit_status?.TargetURL).toBe("https://ci.example/auxjson/1");
    expect(body.data[1]?.latest_commit_status?.SHA).toBe(fixture.tip);
    expect(body.data[1]?.locale_latest_commit_status).toBe("Success");
    expect(body.data[0]?.latest_commit_status).toBeNull();
    expect(body.data[0]?.locale_latest_commit_status).toBe("");
  });

  it("the visibility grant fronts the default private=true: a signed-in NON-owner misses the private row", async () => {
    const res = await fetchUi("/repo/search?q=searchmark", {
      headers: { cookie: await sessionHeader(fixture.outsider.id) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("2");
    const body = await res.json<{ ok: boolean; data: WebSearchAuxItem[] }>();
    expect(body.data.map((item) => item.repository.full_name)).toEqual([
      "auxjson/searchmark-plain",
      "auxjson/searchmark-statuscarrying",
    ]);
  });

  it("count_only swaps the builder: body exactly {\"ok\":true} under the full header quartet", async () => {
    const res = await fetchUi("/repo/search?q=searchmark&count_only=1", {
      headers: { cookie: await sessionHeader(fixture.owner.id) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("x-total-count")).toBe("3");
    expect(res.headers.get("access-control-expose-headers")).toBe("X-Total-Count");
    // repo.go:507-515's JSONOK dummy — no data key at all.
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("maps SearchAuxParamError to the 422 plain-text arm with the exact Go-%q messages", async () => {
    const cookie = { headers: { cookie: await sessionHeader(fixture.owner.id) } };
    const badMode = await fetchUi("/repo/search?mode=bogus", cookie);
    expect(badMode.status).toBe(422);
    expect(badMode.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await badMode.text()).toBe('Invalid search mode: "bogus"');
    const badOrder = await fetchUi("/repo/search?sort=alpha&order=sideways", cookie);
    expect(badOrder.status).toBe(422);
    expect(await badOrder.text()).toBe('Invalid sort order: "sideways"');
    const badSort = await fetchUi("/repo/search?sort=bogus", cookie);
    expect(badSort.status).toBe(422);
    expect(await badSort.text()).toBe('Invalid sort mode: "bogus"');
    // The gate: order validates only when sort is set — a lone order is
    // upstream's dead param, answered 200.
    const loneOrder = await fetchUi("/repo/search?q=searchmark&order=sideways", cookie);
    expect(loneOrder.status).toBe(200);
  });

  it("rides the real query grammar: feed 1's q is FormTrim — a padded keyword still matches", async () => {
    const res = await fetchUi("/repo/search?q=%20searchmark%20", {
      headers: { cookie: await sessionHeader(fixture.owner.id) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("3");
  });

  it("an ABSENT q is the unfiltered scope: the keyword-less plainjane row rides, the private row rides for its owner only", async () => {
    // repo.go:430's FormTrim — an empty keyword feeds SearchRepository's
    // no-keyword arm. plainjane (no `searchmark` in the slug) is what makes
    // this arm distinguishable from every keyword-scoped count above.
    const ownerRes = await fetchUi("/repo/search", {
      headers: { cookie: await sessionHeader(fixture.owner.id) },
    });
    expect(ownerRes.status).toBe(200);
    expect(ownerRes.headers.get("x-total-count")).toBe("4");
    const ownerBody = await ownerRes.json<{ ok: boolean; data: WebSearchAuxItem[] }>();
    // Default alpha order: the keyword-less row sorts FIRST.
    expect(ownerBody.data.map((item) => item.repository.full_name)).toEqual([
      "auxjson/plainjane",
      "auxjson/searchmark-plain",
      "auxjson/searchmark-statuscarrying",
      "auxjson/searchmark-vaulted",
    ]);

    // The outsider's unfiltered scope stays visibility-collapsed: three
    // public rows, the vaulted row never leaks (the signed-in default
    // private=true does not bypass the grant).
    const outsiderRes = await fetchUi("/repo/search", {
      headers: { cookie: await sessionHeader(fixture.outsider.id) },
    });
    expect(outsiderRes.headers.get("x-total-count")).toBe("3");
    const outsiderBody = await outsiderRes.json<{ data: WebSearchAuxItem[] }>();
    expect(outsiderBody.data.map((item) => item.repository.full_name)).not.toContain("auxjson/searchmark-vaulted");
  });

  it("a WHITESPACE-ONLY q trims to the empty keyword — the same unfiltered scope, not a no-match reply", async () => {
    // FormTrim collapses "%20%20" to "": the count equals the absent-q arm,
    // never the padded-keyword arm's filter (repo.go:430).
    const res = await fetchUi("/repo/search?q=%20%20", {
      headers: { cookie: await sessionHeader(fixture.owner.id) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("4");
    const body = await res.json<{ data: WebSearchAuxItem[] }>();
    expect(body.data.map((item) => item.repository.full_name)).toContain("auxjson/plainjane");
  });

  it("GET-only registration: POST misses into the plain 404; the §4.13 slash arm 301s onto the canonical literal", async () => {
    const cookie = { headers: { cookie: await sessionHeader(fixture.owner.id) } };
    expect((await fetchUi("/repo/search", { method: "POST", ...cookie })).status).toBe(404);
    // §4.13's default mode (index.ts:9443): the slashed URL first 404s the
    // mounted literal, then trimTrailingSlash re-issues the 301 onto the
    // canonical ABSOLUTE url — never an in-place rewrite.
    const slashed = await fetchUi("/repo/search/", cookie);
    expect(slashed.status).toBe(301);
    expect(slashed.headers.get("location")).toBe("https://test.local/repo/search");
    // And the redirect target is the live feed (the canonical fetch) — the
    // UNFILTERED count now that plainjane joined the fixture (batch 5's
    // empty-q proof row): 4 in-scope rows for the owner.
    expect((await fetchUi("/repo/search", cookie)).headers.get("x-total-count")).toBe("4");
  });
});

// --- feed 2: GET /explore/topics/search through the mounted route ----------------

describe("GET /explore/topics/search through the mounted route", () => {
  it("optExploreSignIn: anonymous is served the topics envelope, repo_count DESC with the name tiebreak", async () => {
    const res = await fetchUi("/explore/topics/search?q=zeta");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(res.headers.get("x-total-count")).toBe("3");
    expect(res.headers.get("access-control-expose-headers")).toBe("X-Total-Count");

    const body = await res.json<{
      topics: Array<{ id: number; topic_name: string; repo_count: number; created: string; updated: string }>;
    }>();
    // repo_count DESC (models/repo/topic.go:189), the name tiebreak on the
    // two 1-count rows.
    expect(body.topics.map((topic) => [topic.topic_name, topic.repo_count])).toEqual([
      ["zetatopic", 2],
      ["zetaalpha", 1],
      ["zetabetter", 1],
    ]);
    // TopicResponse's full key set: the FNV-1a id twin is a number, and the
    // unlanded timestamps render the documented GO_ZERO_TIME.
    expect(typeof body.topics[0]?.id).toBe("number");
    expect(body.topics[0]?.created).toBe("0001-01-01T00:00:00Z");
    expect(body.topics[0]?.updated).toBe("0001-01-01T00:00:00Z");
  });

  it("the keyword is ASCII-case-insensitive across the real URL", async () => {
    const res = await fetchUi("/explore/topics/search?q=ZETA");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("3");
  });

  it("feed 2's q is FormString — UNTRIMMED, the documented feed-1 divergence: a padded keyword matches nothing", async () => {
    const res = await fetchUi("/explore/topics/search?q=%20zeta%20");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("0");
    expect(await res.json()).toEqual({ topics: [] });
  });

  it("an ABSENT q is the unfiltered topics feed — the keyword-less alphatopic row rides", async () => {
    // topic.go:22's FormString with no param → the empty keyword →
    // FindTopicOptions' no-filter arm. alphatopic (no "zeta") is the proof
    // row: the unfiltered total exceeds every q=zeta count above.
    const res = await fetchUi("/explore/topics/search");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("4");
    const body = await res.json<{ topics: Array<{ topic_name: string; repo_count: number }> }>();
    // repo_count DESC first (zetatopic's 2), then the three 1-count rows in
    // the name tiebreak's ASC — alphatopic leads them.
    expect(body.topics.map((topic) => [topic.topic_name, topic.repo_count])).toEqual([
      ["zetatopic", 2],
      ["alphatopic", 1],
      ["zetaalpha", 1],
      ["zetabetter", 1],
    ]);
  });

  it("a WHITESPACE-ONLY q is a legal untrimmed needle — it filters, it never collapses", async () => {
    // The FormString no-trim divergence's other half: "%20" stays a one-space
    // needle (no topic name carries a space) — a no-match reply, NOT the
    // unfiltered feed feed 1's same input produces.
    const res = await fetchUi("/explore/topics/search?q=%20");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("0");
    expect(await res.json()).toEqual({ topics: [] });
  });

  it("paging slices the page, never the count: X-Total-Count stays over the full match set", async () => {
    const res = await fetchUi("/explore/topics/search?q=zeta&limit=1&page=2");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBe("3");
    const body = await res.json<{ topics: Array<{ topic_name: string }> }>();
    expect(body.topics.map((topic) => topic.topic_name)).toEqual(["zetaalpha"]);
  });

  it("GET-only registration: POST misses into the plain 404", async () => {
    expect((await fetchUi("/explore/topics/search", { method: "POST" })).status).toBe(404);
  });
});
