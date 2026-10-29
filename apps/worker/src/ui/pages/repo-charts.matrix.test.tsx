/**
 * The repo chart pages' matrix (pages/repo-charts.tsx mounted through
 * uiRouter — the census R15 chart family, web.go:1633-1646). The page
 * module's doc carries the upstream citations; THIS file arms the census's
 * four test areas:
 *
 *   - the CLAIM pins: the six shapes (page GET + /data per literal) claim
 *     to `repo-charts` ahead of the /{period} arm (chi static-over-param,
 *     web.go:1631 vs 1633-1646), the period arm keeps claiming unknown
 *     segments (the R14 posture unchanged), and the junk tails
 *     (/{literal}/{junk}, /{period}/data) stay unclaimed — chi has no such
 *     routes;
 *   - the MOUNTS: upstream's verbatim chart divs (#repo-contributors-chart
 *     with repoLink/default-branch + the locale data attributes,
 *     #repo-code-frequency-chart / #repo-recent-commits-chart with the
 *     loading locale set), the PageData repoLink the latter two Vue
 *     components read — served in the head's #global-window-config JSON
 *     since R15 open issue 2 retired the page-body inline assignment
 *     (code_frequency.go:25, recent_commits.go:23), and
 *     the four-item tab strip with per-page active arm (repo/navbar.tmpl);
 *   - the /data SHAPES pinned against the seeded fixture (the
 *     engine-seeding idiom, real pushes): the full ContributorData map with
 *     the "total" pseudo-entry and the D1 decorations (the mapped user vs
 *     the ghost — contributors_graph.go:236-252's arms), the
 *     Go-map-sorted keys, and the total-weeks object the code-frequency and
 *     recent-commits routes both serve (web.go:1644's same-handler note);
 *   - the 404 arms + the visibility posture: MustBeNotEmpty (web.go:1648),
 *     the unborn default branch, the private-repo shell, and the
 *     no-202 posture (our synchronous RPC answers 200 on the first hit —
 *     upstream's ErrAwaitGeneration arm is the ratified divergence).
 *
 * Mount arms ride the repo-activity.matrix minted-session harness (per-test
 * D1 wipe + idempotent re-seed, REAL pushed content for the engine walk;
 * commit clocks are relative to the real now so the sunday-bucket
 * expectations are computed off the seeded unix stamps — the +0000-recorded
 * seed commits bucket to UTC Sundays, contributors_graph.go:258-261's
 * findLastSundayBeforeDate + UnixMilli arithmetic).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import type { RepoRow } from "../ui-context";

// The engine-seeding hooks push real packs through the receive flow (the
// repo-activity matrix's file-local budgets).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// --- the minted-session route harness (the repo-activity.matrix pattern) --------

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

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** The head config JSON parsed out of a full-document render (the
 * shell.test.tsx extractor): the matrix asserts the window.config bytes the
 * Vue components boot from — since R15 open issue 2 the PageData payload
 * rides this JSON (upstream WindowConfig's `"pageData"` arm,
 * context_template.go:162), and the page-body inline assignment is retired. */
function configJson(html: string): Record<string, unknown> {
  const match = /<script type="application\/json" id="global-window-config">([\s\S]*?)<\/script>/.exec(html);
  if (match === null) throw new Error(`no config tag in:\n${html}`);
  return JSON.parse(match[1] ?? "") as Record<string, unknown>;
}

// --- fixtures -------------------------------------------------------------------

const NOW_S = Math.floor(Date.now() / 1000);
const day = (n: number): number => NOW_S - n * 86_400;
const hour = (n: number): number => NOW_S - n * 3_600;

/** Go findLastSundayBeforeDate + UnixMilli (contributors_graph.go:258-261)
 *  over a +0000-recorded commit stamp: the containing week's Sunday 00:00
 *  UTC, in milliseconds — the engine's bucket key and the JSON key. */
function sundayMs(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - d.getUTCDay() * 86_400_000;
}

/** Four commits, two identities, each appending one README line (+1/−0 per
 *  commit): alice at −30d/−2d, bob at −9d/−1h. The −30d/−9d buckets differ
 *  from the −2d/−1h ones for any fixed now where the day-30/day-2 stamps
 *  fall in different week windows at least 3 weeks apart — always true. */
const CHARTS_COMMITS: SeedCommit[] = [
  {
    message: "charts: old root",
    time: day(30),
    files: [{ path: "README.md", content: "charts root\n" }],
    author: { name: "Alice Liddell", email: "alice@example.com" },
  },
  {
    message: "charts: bob nine days ago",
    time: day(9),
    files: [{ path: "README.md", content: "charts root\nnine\n" }],
    author: { name: "Bob Rove", email: "bob@nowhere.example" },
  },
  {
    message: "charts: alice two days ago",
    time: day(2),
    files: [{ path: "README.md", content: "charts root\nnine\ntwo\n" }],
    author: { name: "Alice Liddell", email: "alice@example.com" },
  },
  {
    message: "charts: bob tip",
    time: hour(1),
    files: [{ path: "README.md", content: "charts root\nnine\ntwo\ntip\n" }],
    author: { name: "Bob Rove", email: "bob@nowhere.example" },
  },
];

interface ChartsFixture {
  repo: RepoRow;
  aliceWeeks: number[];
  bobWeeks: number[];
}

/** The per-test fixture (the repo-activity.matrix idempotent pattern). Repo
 *  `charts-owner/charts` (main, CHARTS_COMMITS) with the OWNER row mapped
 *  to alice's commit email (email + displayName set — the DisplayName()
 *  decoration arm); bob stays unmapped (the ghost arm). */
async function seedChartsFixture(): Promise<ChartsFixture> {
  await seedVerifiedUser({ username: "charts-owner" });
  await ensureSeededRepo({ owner: "charts-owner", slug: "charts", commits: CHARTS_COMMITS });
  const db = drizzle(env.DB);
  const repoRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "charts-owner"), eq(repositories.slug, "charts")))
    .get();
  if (repoRow === undefined) throw new Error("charts repo row missing");
  if (repoRow.visibility !== "public" || repoRow.isEmpty) {
    await db.update(repositories).set({ visibility: "public", isEmpty: false }).where(eq(repositories.id, repoRow.id));
  }
  // The mapped-user arm: the owner's account email IS alice's commit email
  // (upstream GetUserByEmail's hit), with the full-name columns set so
  // DisplayName() reads the settings-form value.
  await db
    .update(users)
    .set({ email: "alice@example.com", displayName: "Charts Owner", fullName: "", avatarEmail: "alice@example.com" })
    .where(eq(users.usernameLower, "charts-owner"))
    .run();
  return {
    repo: repoRow,
    aliceWeeks: [sundayMs(day(30)), sundayMs(day(2))],
    bobWeeks: [sundayMs(day(9)), sundayMs(hour(1))],
  };
}

/** The never-pushed empty twin (the repo-activity fixture's RepoService arm). */
async function seedChartsEmpty(): Promise<void> {
  const owner = await seedVerifiedUser({ username: "chartsempty-owner" });
  await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "chartsempty-owner" },
    name: "empty",
    isPrivate: false,
    status: "ready",
  });
}

/** A public-but-unborn row (isEmpty flipped false with NO push). Upstream's
 *  chart PAGE handlers never touch git — only the /data routes do — so the
 *  page renders 200 here where the PULSE page 404s (activity.go:51-60's
 *  IsBranchExist arm lives in repo.Activity alone); the data route answers
 *  the loader's null (our 404 for upstream's ServerError 500 — the
 *  module-header divergence). */
async function seedChartsUnborn(): Promise<void> {
  const owner = await seedVerifiedUser({ username: "chartsunborn-owner" });
  const created = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "chartsunborn-owner" },
    name: "unborn",
    isPrivate: false,
    status: "ready",
  });
  await drizzle(env.DB).update(repositories).set({ visibility: "public", isEmpty: false }).where(eq(repositories.id, created.id));
}

/** A private twin with content: the seed lands public (ensureSeededRepo's
 *  own posture), so the visibility arm flips the row back to private. */
async function seedChartsPrivate(): Promise<void> {
  await seedVerifiedUser({ username: "chartspriv-owner" });
  await ensureSeededRepo({ owner: "chartspriv-owner", slug: "vault", commits: CHARTS_COMMITS });
  await drizzle(env.DB)
    .update(repositories)
    .set({ visibility: "private" })
    .where(and(eq(repositories.ownerNamespace, "chartspriv-owner"), eq(repositories.slug, "vault")));
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // FK order (the repo-activity.matrix wipe verbatim — this fixture writes
  // no issue/PR/release rows, the superset list keeps the neighbor shape).
  for (const table of [
    "release_assets",
    "releases",
    "webhook_deliveries",
    "webhooks",
    "repo_collaborators",
    "repo_settings",
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

// --- the claim pins -------------------------------------------------------------

describe("repo-charts claim pins (parseUiRoute / handlesUiRoute)", () => {
  it("claims the three page GETs (tail null) and the three /data tails", () => {
    for (const kind of ["contributors", "code-frequency", "recent-commits"] as const) {
      expect(parseUiRoute(`/octo/hello/activity/${kind}`)).toEqual({
        family: "repo-charts",
        owner: "octo",
        repo: "hello",
        kind,
        tail: null,
      });
      expect(parseUiRoute(`/octo/hello/activity/${kind}/data`)).toEqual({
        family: "repo-charts",
        owner: "octo",
        repo: "hello",
        kind,
        tail: "data",
      });
      expect(handlesUiRoute(`/octo/hello/activity/${kind}`)).toBe(true);
      expect(handlesUiRoute(`/octo/hello/activity/${kind}/data`)).toBe(true);
    }
  });

  it("keeps the R14 period arm on every non-literal segment (unknowns render weekly)", () => {
    // web.go:1630-1631's /{period} route is untouched by the chart group —
    // chi dispatches the static literals first, everything else is a period.
    expect(parseUiRoute("/octo/hello/activity/daily")).toEqual({
      family: "repo-activity",
      owner: "octo",
      repo: "hello",
      period: "daily",
    });
    expect(parseUiRoute("/octo/hello/activity/bogus")).toEqual({
      family: "repo-activity",
      owner: "octo",
      repo: "hello",
      period: "bogus",
    });
    expect(parseUiRoute("/octo/hello/activity")).toEqual({
      family: "repo-activity",
      owner: "octo",
      repo: "hello",
      period: null,
    });
  });

  it("stays unclaimed on the junk tails (chi registers only '' and '/data' per group)", () => {
    // web.go:1633-1646's groups have no deeper routes — the engine's 404
    // owns these.
    expect(parseUiRoute("/octo/hello/activity/contributors/extra")).toBeNull();
    expect(parseUiRoute("/octo/hello/activity/code-frequency/extra")).toBeNull();
    expect(parseUiRoute("/octo/hello/activity/recent-commits/extra/more")).toBeNull();
    // A PERIOD + /data is not a route either (the /{period} param has no
    // children) — the literal check guards the data-tail claim.
    expect(parseUiRoute("/octo/hello/activity/daily/data")).toBeNull();
    expect(parseUiRoute("/octo/hello/activity/bogus/data")).toBeNull();
    expect(handlesUiRoute("/octo/hello/activity/contributors/extra")).toBe(false);
    expect(handlesUiRoute("/octo/hello/activity/daily/data")).toBe(false);
  });
});

// --- the mount arms -------------------------------------------------------------

describe("the chart pages mount (the census's heatmap precedent: verbatim divs, official bundle renders)", () => {
  it("contributors mounts #repo-contributors-chart with repoLink/default-branch + the locale set; Contributors tab active", async () => {
    await seedChartsFixture();
    const res = await fetchUi("/charts-owner/charts/activity/contributors");
    expect(res.status).toBe(200);
    const html = await res.text();

    // The repo/activity shell (activity.tmpl:2's discriminator) + the page
    // title (contributors.go:21's navbar label).
    expect(html).toContain('class="page-content repository commits"');
    expect(html).toContain("<title>Contributors - charts-owner/charts</title>");

    // templates/repo/contributors.tmpl: the mount div verbatim.
    expect(html).toContain('id="repo-contributors-chart"');
    expect(html).toContain('data-repo-link="/charts-owner/charts"');
    expect(html).toContain('data-repo-default-branch-name="main"');
    expect(html).toContain('data-locale-filter-label="Contribution type:"');
    expect(html).toContain('data-locale-contribution-type-commits="Commits"');
    expect(html).toContain('data-locale-contribution-type-additions="Additions"');
    expect(html).toContain('data-locale-contribution-type-deletions="Deletions"');
    expect(html).toContain('data-locale-loading-title="Loading contributions…');
    expect(html).toContain('data-locale-loading-title-failed="Could not load contributions"');
    expect(html).toContain('data-locale-loading-info="This might take a bit…"');
    expect(html).toContain('data-locale-component-failed-to-load="An unexpected error happened."');
    expect(html).toContain('data-locale-chart-zoom-hint="drag: zoom, shift+drag: pan, double click: reset zoom"');

    // The tab strip (repo/navbar.tmpl:2-17): all four LIVE, Contributors
    // active, Pulse not.
    expect(html).toContain('href="/charts-owner/charts/activity">Pulse</a>');
    expect(html).toContain('class="active item" href="/charts-owner/charts/activity/contributors"');
    expect(html).toContain('href="/charts-owner/charts/activity/code-frequency">Code Frequency</a>');
    expect(html).toContain('href="/charts-owner/charts/activity/recent-commits">Recent Commits</a>');
    // Pulse inert (the repo header's Activity TAB is separately active —
    // assert the nav ITEM, not the bare class pair).
    expect(html).toContain('<a class="item" href="/charts-owner/charts/activity">Pulse</a>');
    // NO PageData arm on this page (contributors.go arms none): the head
    // config JSON serves the unarmed null, and the retired inline mechanism
    // (R15 open issue 2) emits no body script.
    expect(configJson(html).pageData).toBeNull();
    expect(html).not.toContain("window.config.pageData =");
  });

  it("code-frequency mounts its div + the PageData repoLink; Code Frequency tab active", async () => {
    await seedChartsFixture();
    const res = await fetchUi("/charts-owner/charts/activity/code-frequency");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Code Frequency - charts-owner/charts</title>");
    expect(html).toContain('id="repo-code-frequency-chart"');
    expect(html).toContain('data-locale-loading-title="Loading code frequency…"');
    expect(html).toContain('data-locale-loading-title-failed="Could not load code frequency"');
    // The PageData payload rides the head's #global-window-config JSON
    // (code_frequency.go:25 → window.config.pageData; the Vue reads
    // pageData.repoLink) — the inline body assignment is retired (R15 open
    // issue 2), so no body script exists on any chart page.
    expect(configJson(html).pageData).toEqual({ repoLink: "/charts-owner/charts" });
    expect(html).not.toContain("window.config.pageData =");
    expect(html).toContain('class="active item" href="/charts-owner/charts/activity/code-frequency"');
    expect(html).toContain('<a class="item" href="/charts-owner/charts/activity">Pulse</a>');
  });

  it("recent-commits mounts its div + the PageData repoLink; Recent Commits tab active", async () => {
    await seedChartsFixture();
    const res = await fetchUi("/charts-owner/charts/activity/recent-commits");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Recent Commits - charts-owner/charts</title>");
    expect(html).toContain('id="repo-recent-commits-chart"');
    expect(html).toContain('data-locale-loading-title="Loading recent commits…"');
    expect(html).toContain('data-locale-loading-title-failed="Could not load recent commits"');
    // The PageData repoLink in the head config JSON (recent_commits.go:23;
    // the inline body assignment retired — R15 open issue 2).
    expect(configJson(html).pageData).toEqual({ repoLink: "/charts-owner/charts" });
    expect(html).not.toContain("window.config.pageData =");
    expect(html).toContain('class="active item" href="/charts-owner/charts/activity/recent-commits"');
  });

  it("the pulse page's tab strip carries all four items with Pulse active (the R14 neighbor)", async () => {
    await seedChartsFixture();
    const res = await fetchUi("/charts-owner/charts/activity");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="active item" href="/charts-owner/charts/activity">Pulse</a>');
    expect(html).toContain('href="/charts-owner/charts/activity/contributors">Contributors</a>');
    expect(html).toContain('href="/charts-owner/charts/activity/code-frequency">Code Frequency</a>');
    expect(html).toContain('href="/charts-owner/charts/activity/recent-commits">Recent Commits</a>');
  });

  it("the static chart literals beat the earlier-registered /:period route (200, not the drift-guard 404)", async () => {
    // Precedence pin: `/:owner/:repo/activity/:period` is registered AFTER
    // the static lines but would still match — Hono's RegExpRouter ranks
    // statics first; a regression here lands in repoActivityPage's drift
    // guard (404 on a repo-charts route).
    await seedChartsFixture();
    const res = await fetchUi("/charts-owner/charts/activity/contributors");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="repo-contributors-chart"');
  });
});

// --- the /data shapes -----------------------------------------------------------

describe("the /data JSON routes (the Vue parsers' pinned shapes)", () => {
  it("contributors/data serves the Go-sorted ContributorData map: mapped user, ghost, total", async () => {
    const fx = await seedChartsFixture();
    const res = await fetchUi("/charts-owner/charts/activity/contributors/data");
    expect(res.status).toBe(200);
    // ctx.JSON's headers (base.go:115-117) + the zero-option prod cache
    // policy (httpcache.go:31-33).
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");

    const data = await res.json<Record<string, unknown>>();
    // encoding/json sorts map keys — "total" serves among the sorted emails.
    expect(Object.keys(data)).toEqual(["alice@example.com", "bob@nowhere.example", "total"]);

    // The MAPPED arm (contributors_graph.go:245-252): DisplayName wins,
    // login/home_link/avatar_link decorated, entry keyed by the (lowercased
    // primary) email.
    const alice = data["alice@example.com"] as Record<string, unknown>;
    expect(Object.keys(alice)).toEqual(["name", "login", "avatar_link", "home_link", "total_commits", "weeks"]);
    expect(alice.name).toBe("Charts Owner");
    expect(alice.login).toBe("charts-owner");
    expect(alice.home_link).toBe("/charts-owner");
    expect(alice.avatar_link).toMatch(/^https:\/\/test\.local\/avatars\/[0-9a-f]{64}$/);
    expect(alice.total_commits).toBe(2);
    const aliceWeeks = alice.weeks as Record<string, { week: number; additions: number; deletions: number; commits: number }>;
    expect(Object.keys(aliceWeeks).sort()).toEqual([...fx.aliceWeeks].sort().map(String));
    for (const week of fx.aliceWeeks) {
      expect(aliceWeeks[String(week)]).toEqual({ week, additions: 1, deletions: 0, commits: 1 });
    }

    // The GHOST arm (:236-239 → the frozen DISABLE_GRAVATAR default): the
    // git author name, empty login/home_link, the bundled avatar.
    const bob = data["bob@nowhere.example"] as Record<string, unknown>;
    expect(bob.name).toBe("Bob Rove");
    expect(bob.login).toBe("");
    expect(bob.home_link).toBe("");
    expect(bob.avatar_link).toBe("https://test.local/assets/img/avatar_default.png");
    expect(bob.total_commits).toBe(2);

    // The TOTAL pseudo-entry (:216-219 + :271-288): the zero decorations,
    // the merged weeks, all four commits.
    const total = data["total"] as Record<string, unknown>;
    expect(total.name).toBe("Total");
    expect(total.login).toBe("");
    expect(total.avatar_link).toBe("");
    expect(total.home_link).toBe("");
    expect(total.total_commits).toBe(4);
    const totalWeeks = total.weeks as Record<string, { week: number; additions: number; deletions: number; commits: number }>;
    const allWeeks = [...fx.aliceWeeks, ...fx.bobWeeks];
    expect(Object.keys(totalWeeks)).toEqual([...new Set(allWeeks)].sort((a, b) => a - b).map(String));
    let totalAdditions = 0;
    for (const week of [...new Set(allWeeks)]) {
      const bucket = totalWeeks[String(week)];
      if (bucket === undefined) throw new Error(`total weeks missing bucket ${week}`);
      expect(bucket.week).toBe(week); // the inline field the Vue reads (keys are strings)
      const commits = allWeeks.filter((w) => w === week).length;
      expect(bucket.commits).toBe(commits);
      expect(bucket.additions).toBe(commits); // each commit appends one line
      expect(bucket.deletions).toBe(0);
      totalAdditions += bucket.additions;
    }
    expect(totalAdditions).toBe(4);
  });

  it("code-frequency/data serves the TOTAL's weeks object alone (code_frequency.go:39)", async () => {
    const fx = await seedChartsFixture();
    const res = await fetchUi("/charts-owner/charts/activity/code-frequency/data");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");

    const weeks = await res.json<Record<string, { week: number; additions: number; deletions: number; commits: number }>>();
    // The DayDataObject: string week keys, each value carrying the inline
    // week + add/del/commits — RepoCodeFrequency.vue reads
    // Object.values(obj)[0].week and .additions/.deletions.
    const keys = Object.keys(weeks);
    // The fixture's four commits fold into three DISTINCT Sunday buckets
    // (the −2d and −1h stamps share a week window for any now where they do).
    const uniqueWeeks = [...new Set([...fx.aliceWeeks, ...fx.bobWeeks])].sort((a, b) => a - b);
    expect(keys).toEqual(uniqueWeeks.map(String));
    // The shared week carries BOTH commits (+2); the solo weeks +1 each.
    for (const key of keys) {
      const expectedCommits = [...fx.aliceWeeks, ...fx.bobWeeks].filter((w) => w === Number(key)).length;
      expect(weeks[key]).toEqual({ week: Number(key), additions: expectedCommits, deletions: 0, commits: expectedCommits });
    }
    // Ascending numeric key order — the Go map marshal's guarantee the
    // first-value read relies on (the >2^32 insertion-order hazard the
    // loader's explicit sort exists for).
    expect(Number(keys[0])).toBe(Math.min(...keys.map(Number)));
    expect(Number(keys[keys.length - 1])).toBe(Math.max(...keys.map(Number)));
  });

  it("recent-commits/data serves the SAME shape (web.go:1644 registers CodeFrequencyData for both)", async () => {
    await seedChartsFixture();
    const freqRes = await fetchUi("/charts-owner/charts/activity/code-frequency/data");
    const recentRes = await fetchUi("/charts-owner/charts/activity/recent-commits/data");
    expect(recentRes.status).toBe(200);
    // Byte-identical answers — one handler upstream, one loader here.
    expect(await recentRes.text()).toBe(await freqRes.text());
  });

  it("the first hit answers 200 — no upstream 202 ErrAwaitGeneration arm (the ratified synchronous posture)", async () => {
    await seedChartsFixture();
    const res = await fetchUi("/charts-owner/charts/activity/contributors/data");
    expect(res.status).toBe(200);
  });
});

// --- the 404 + visibility posture ------------------------------------------------

describe("the chart pages' 404 arms + visibility posture", () => {
  it("an anonymous viewer reads the public repo's charts (optSignIn posture)", async () => {
    await seedChartsFixture();
    for (const path of [
      "/charts-owner/charts/activity/contributors",
      "/charts-owner/charts/activity/code-frequency",
      "/charts-owner/charts/activity/recent-commits",
      "/charts-owner/charts/activity/contributors/data",
    ]) {
      const res = await fetchUi(path);
      expect(res.status).toBe(200);
    }
  });

  it("an invisible (private) repo 404-shells anonymous — pages and data alike", async () => {
    await seedChartsPrivate();
    for (const path of [
      "/chartspriv-owner/vault/activity/contributors",
      "/chartspriv-owner/vault/activity/contributors/data",
      "/chartspriv-owner/vault/activity/recent-commits/data",
    ]) {
      const res = await fetchUi(path);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("page-content"); // the 404 shell
    }
  });

  it("an empty repo 404-shells (MustBeNotEmpty, web.go:1648)", async () => {
    await seedChartsEmpty();
    for (const path of [
      "/chartsempty-owner/empty/activity/contributors",
      "/chartsempty-owner/empty/activity/contributors/data",
      "/chartsempty-owner/empty/activity/code-frequency/data",
    ]) {
      expect((await fetchUi(path)).status).toBe(404);
    }
  });

  it("an unborn non-empty repo: the page renders 200 (upstream's chart handlers never touch git), the data route 404s (the loader's null)", async () => {
    await seedChartsUnborn();
    // The PAGE: contributors.go:20-26/code_frequency.go:20-27/recent_commits.go:18-25
    // render the template unconditionally — no IsBranchExist arm (that lives
    // in repo.Activity alone, activity.go:51-60 — the pulse page's 404).
    const pageRes = await fetchUi("/chartsunborn-owner/unborn/activity/recent-commits");
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain('id="repo-recent-commits-chart"');
    // The DATA route: git log on the missing ref errors upstream (ServerError
    // 500); our loader's null answers the 404 shell (the aux-JSON divergence).
    const dataRes = await fetchUi("/chartsunborn-owner/unborn/activity/recent-commits/data");
    expect(dataRes.status).toBe(404);
  });
});
