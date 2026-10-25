/**
 * Pages wave 2 route tests (SPEC-0008 U3 extension): the `/tree` code-tree
 * family (pages/repo-home.tsx — upstream RedirectRepoTreeToSrc) and the
 * issues/pulls lists (pages/issues-list.tsx). Same harness posture as
 * pages.test.ts: the router is driven directly with the synthetic ASSETS
 * manifest, engine content is REALLY pushed (testing/seed-repo.ts), and the
 * issue block is seeded through the landed IssuesService / label service
 * with fixed `now` values — every render is byte-deterministic.
 *
 * Slugs are distinct from pages.test.ts ("pages"/"big") and the goldens
 * ("golden"/"golden-alt") so fixture rows never collide across files.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createRepoLabel, findRepoLabelByName } from "../../api/services/labels";
import { repositories, users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { IssuesService } from "../../issues/service";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";
import { issues } from "../../db/schema";

async function fetchUi(path: string): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`), uiEnv);
}

// --- fixtures -----------------------------------------------------------------

const WAVE2_COMMITS: SeedCommit[] = [
  {
    message: "seed: readme and docs",
    time: T0,
    files: [
      { path: "README.md", content: "# wave2 seed\n\nBody text.\n" },
      { path: "docs/guide.md", content: "# Guide\n\nWalkthrough.\n" },
    ],
  },
];

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

interface Wave2Issues {
  bugLabelId: number;
  enhancementLabelId: number;
}

let wave2Fixture: Wave2Issues | null = null;

/**
 * Seed the issue block for alice/wave2 through the landed services: two
 * labels, one milestone, one labeled+milestone+commented open issue, one
 * closed issue, 25 pagination issues (26 open items total), one pull
 * request. Every write passes a fixed `now` (deterministic event lines).
 *
 * Idempotent like ensureSeededRepo: any existing issue row for the repo
 * skips creation and rehydrates the fixture by name/index — the per-repo
 * issue-number sequence is monotonic, re-running would duplicate.
 */
async function ensureWave2Issues(): Promise<Wave2Issues> {
  if (wave2Fixture !== null) return wave2Fixture;
  const db = drizzle(env.DB);
  const repo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave2")))
    .get();
  if (repo === undefined) throw new Error("wave2 repo row missing");
  const owner = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get();
  if (owner === undefined) throw new Error("wave2 owner row missing");

  const rehydrate = async (): Promise<Wave2Issues> => {
    const bug = await findRepoLabelByName(env.DB, repo.id, "bug");
    const enhancement = await findRepoLabelByName(env.DB, repo.id, "enhancement");
    if (bug === null || enhancement === null) throw new Error("wave2 labels missing on rehydrate");
    return { bugLabelId: bug.id, enhancementLabelId: enhancement.id };
  };
  const existing = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, repo.id)).limit(1).all();
  if (existing.length > 0) {
    wave2Fixture = await rehydrate();
    return wave2Fixture;
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
  const enhancement = await createRepoLabel(env.DB, repo.id, {
    name: "enhancement",
    exclusive: false,
    color: "#84b6eb",
    description: "New feature or request",
    isArchived: false,
    now: t(0),
  });
  const milestone = await svc.createMilestone({ repoId: repo.id, name: "v1.0", now: t(0) });

  const labeled = await svc.createIssue({
    repoId: repo.id,
    title: "labeled milestone issue",
    posterId: owner.id,
    milestoneId: milestone.id,
    labelIds: [bug.id, enhancement.id],
    now: t(100),
  });
  const closed = await svc.createIssue({ repoId: repo.id, title: "closed early bird", posterId: owner.id, now: t(200) });
  await svc.closeIssue(closed.id, { now: t(250) });
  await svc.addComment({ issueId: labeled.id, posterId: owner.id, content: "Reproduced.", now: t(260) });
  for (let i = 1; i <= 25; i++) {
    await svc.createIssue({ repoId: repo.id, title: `pagination issue ${i}`, posterId: owner.id, now: t(300 + i) });
  }
  await svc.createPullRequest({
    repoId: repo.id,
    title: "pull: wave2 feature branch",
    posterId: owner.id,
    headRepoId: repo.id,
    baseBranch: "main",
    headBranch: "feature-wave2",
    now: t(400),
  });

  wave2Fixture = { bugLabelId: bug.id, enhancementLabelId: enhancement.id };
  return wave2Fixture;
}

/** A private sibling repo for the §2.5 negative paths (row only — no engine
 *  content is needed: resolution 404s before any page work). */
async function seedPrivateRepo(): Promise<void> {
  const db = drizzle(env.DB);
  const owner = await db
    .select({ ownerId: repositories.ownerId })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave2")))
    .get();
  const id = crypto.randomUUID();
  await db.insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: "alice",
    ownerId: owner?.ownerId,
    slug: "wave2-secret",
    visibility: "private",
  });
}

beforeAll(async () => {
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "wave2", commits: WAVE2_COMMITS });
  await seedPrivateRepo();
});

// --- pure parser surface --------------------------------------------------------

describe("wave-2 parser surface", () => {
  it.each([
    "/octo/hello/tree",
    "/octo/hello/tree/branch/main",
    "/octo/hello/tree/branch/feature/deep/dir",
    "/octo/hello/issues",
    "/octo/hello/pulls",
    "/octo/hello/issues/5", // wave 3: the detail family (single integer tail)
    "/octo/hello/pulls/7",
  ])("claims UI family: %s", (pathname) => {
    expect(handlesUiRoute(pathname)).toBe(true);
  });

  it.each([
    "/octo/hello/treeX/branch/main",
    "/octo/hello/issuesX",
    "/octo/hello/issues/new", // the rest of the detail space stays engine-owned
    "/octo/hello/issues/5/comments",
    "/octo/hello/issues/5x", // non-numeric index → engine 404 (chi PathParamInt64 parity)
    "/octo/hello/pulls/7/8",
    "/octo/hello/Issues", // family literals are lowercase-exact
  ])("does not claim: %s", (pathname) => {
    expect(handlesUiRoute(pathname)).toBe(false);
  });

  it("parses the tree suffix RAW (still-encoded — it is re-emitted verbatim)", () => {
    expect(parseUiRoute("/octo/hello/tree/branch/main/a%20b.txt")).toEqual({
      family: "tree",
      owner: "octo",
      repo: "hello",
      rawSuffix: "branch/main/a%20b.txt",
    });
    expect(parseUiRoute("/octo/hello/tree")).toEqual({ family: "tree", owner: "octo", repo: "hello", rawSuffix: "" });
    expect(parseUiRoute("/octo/hello/issues")).toEqual({ family: "issues", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/pulls")).toEqual({ family: "pulls", owner: "octo", repo: "hello" });
  });

  it("parses the wave-3 detail family: single integer tail, urlKind preserved (chi PathParamInt64 parity)", () => {
    expect(parseUiRoute("/octo/hello/issues/5")).toEqual({
      family: "issue-detail",
      owner: "octo",
      repo: "hello",
      urlKind: "issues",
      index: 5,
    });
    expect(parseUiRoute("/octo/hello/pulls/7")).toEqual({
      family: "issue-detail",
      owner: "octo",
      repo: "hello",
      urlKind: "pulls",
      index: 7,
    });
    // Leading zeros are base-10 (upstream ParseInt), a negative is admitted
    // at parse time and 404-shells on the row lookup.
    expect(parseUiRoute("/octo/hello/issues/007")).toMatchObject({ family: "issue-detail", index: 7 });
    expect(parseUiRoute("/octo/hello/issues/-1")).toMatchObject({ family: "issue-detail", index: -1 });
  });
});

// --- the /tree family (repo-home.tsx) -------------------------------------------

describe("tree family (code-tree redirect)", () => {
  it("303s onto /src with the RAW suffix and query preserved (upstream RedirectRepoTreeToSrc)", async () => {
    const res = await fetchUi("/alice/wave2/tree/branch/main/docs");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave2/src/branch/main/docs");

    const withQuery = await fetchUi("/alice/wave2/tree/branch/main?x=1");
    expect(withQuery.status).toBe(303);
    expect(withQuery.headers.get("location")).toBe("/alice/wave2/src/branch/main?x=1");

    // Encoded segments travel encoded; the /src parser re-decodes with the
    // landed rules and answers its own behaviors at the target.
    const encoded = await fetchUi("/alice/wave2/tree/branch/main/a%20b.txt");
    expect(encoded.headers.get("location")).toBe("/alice/wave2/src/branch/main/a%20b.txt");
  });

  it("redirects only after the §2.5 repo resolution: unknown repo 404-shells, never redirects", async () => {
    const res = await fetchUi("/nobody/nothing/tree/branch/main");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<div class="status-page-error">');
    expect(html).not.toContain("repo-header");
    expect(res.headers.get("location")).toBeNull();
  });

  it("404-shells private repos and the bare /tree (no upstream route)", async () => {
    const secret = await fetchUi("/alice/wave2-secret/tree/branch/main");
    expect(secret.status).toBe(404);
    expect(await secret.text()).toContain('<div class="status-page-error">');

    const bare = await fetchUi("/alice/wave2/tree");
    expect(bare.status).toBe(404);
    const bareHtml = await bare.text();
    expect(bareHtml).toContain("repo-header"); // repo context kept (§4.5)
    expect(bareHtml).toContain('<div class="status-page-error">');
  });

  it("the redirect target renders the tree listing (the /tree DOM is the file view's)", async () => {
    const redirect = await fetchUi("/alice/wave2/tree/branch/main/docs");
    const target = redirect.headers.get("location") ?? "";
    const res = await fetchUi(target);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository file list"');
    expect(html).toContain('<div id="repo-files-table">');
    // Sub-directory listing: the parent-link row (upstream view_list).
    expect(html).toContain('<a class="repo-file-line parent-link silenced" href="/alice/wave2/src/branch/main">');
    expect(html).toContain('title="guide.md">guide.md</a>');
  });
});

// --- the issues list -------------------------------------------------------------

describe("issues list page", () => {
  let fixture: Wave2Issues;

  beforeAll(async () => {
    fixture = await ensureWave2Issues();
  });

  it("renders the open list: upstream row shape, ordering, tab counts", async () => {
    const res = await fetchUi("/alice/wave2/issues");
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('<div role="main" aria-label="Issues" class="page-content repository issue-list">');
    expect(html).toContain("<title>Issues - alice/wave2</title>");
    expect(html).toContain('<div id="issue-list" class="flex-divided-list items-with-main">');

    // 26 open items → page 1 carries exactly the 20-row page size.
    const items = html.match(/<div class="item">/g) ?? [];
    expect(items).toHaveLength(20);
    // Newest first (created_unix DESC): the last-seeded pagination issue leads.
    expect(html).toContain(">pagination issue 25</a>");
    expect(html.indexOf("pagination issue 25")).toBeLessThan(html.indexOf("pagination issue 24"));
    // The labeled issue (oldest open) is on page 2 — asserted there.

    // Tab counts over the SAME filter set, both states always shown.
    expect(html).toContain(">26 Open</a>");
    expect(html).toContain(">1 Closed</a>");
    const tabs = html.slice(
      html.indexOf('<div class="small-menu-items ui compact tiny menu">'),
      html.indexOf('id="issue-list"'),
    );
    expect(tabs).toContain('<div class="small-menu-items ui compact tiny menu">');
    expect(tabs.indexOf('class="active item flex-text-inline"')).toBeGreaterThan(-1);
    expect(tabs.indexOf('class="active item flex-text-inline"')).toBeLessThan(tabs.indexOf('class="item flex-text-inline"'));

    // Event line: relative-time with the fixed seed timestamps + the verb
    // (state icons are the documented icon-allowlist degradation).
    expect(html).toContain('<relative-time prefix="" tense="past"');
    expect(html).toContain(">opened <relative-time"); // verb text (no icons this wave)
    // The `#{index}` index anchor of the leading row.
    expect(html).toContain('class="index flex-text-inline" href="/alice/wave2/issues/25">#25</a>');
  });

  it("paginates at 20 with state/filter-preserving links, clamping page < 1", async () => {
    const first = await (await fetchUi("/alice/wave2/issues")).text();
    expect(first).toContain('<a class="item navigation" href="/alice/wave2/issues?page=2"');
    expect(first).toContain("Older");
    expect(first).not.toContain("Newer");

    const second = await (await fetchUi("/alice/wave2/issues?page=2")).text();
    const secondItems = second.match(/<div class="item">/g) ?? [];
    expect(secondItems).toHaveLength(6); // 26 open − 20
    expect(second).toContain(">labeled milestone issue</a>");
    expect(second).not.toContain("Older");
    expect(second).toContain("Newer");
    expect(second).toContain('<a class="item navigation" href="/alice/wave2/issues"'); // page 1 is canonical

    // The labeled row's badges + milestone (plain-text degradation) + comment count.
    expect(second).toContain("background-color: #ee0701");
    expect(second).toContain("background-color: #84b6eb");
    expect(second).toContain(`href="?state=open&amp;labels=${fixture.bugLabelId}"`);
    expect(second).toContain('<span class="milestone flex-text-inline tw-max-w-[300px]">');
    expect(second).toContain(">v1.0</span>");
    expect(second).toContain('<a class="tw-no-underline muted flex-text-block" href="/alice/wave2/issues/1">1</a>');

    const clamped = await (await fetchUi("/alice/wave2/issues?page=0")).text();
    expect((clamped.match(/<div class="item">/g) ?? []).length).toBe(20);
  });

  it("serves the closed tab: active state, the closed row, counts unchanged", async () => {
    const html = await (await fetchUi("/alice/wave2/issues?state=closed")).text();
    const items = html.match(/<div class="item">/g) ?? [];
    expect(items).toHaveLength(1);
    expect(html).toContain(">closed early bird</a>");
    expect(html).toContain(">closed <relative-time"); // closed verb on the event line
    expect(html).toContain(">26 Open</a>"); // counts span both tabs
    expect(html).toContain(">1 Closed</a>");
    const tabs = html.slice(
      html.indexOf('<div class="small-menu-items ui compact tiny menu">'),
      html.indexOf('id="issue-list"'),
    );
    // The active tab is the SECOND one (closed).
    expect(tabs.indexOf('class="active item flex-text-inline"')).toBeGreaterThan(tabs.indexOf('class="item flex-text-inline"'));
    // The active closed tab echoes the state.
    expect(tabs).toContain('href="/alice/wave2/issues?state=closed"');
  });

  it("filters by label and milestone facets; dead-end facets degrade to the empty state", async () => {
    const byLabel = await (await fetchUi(`/alice/wave2/issues?labels=${fixture.bugLabelId}`)).text();
    expect((byLabel.match(/<div class="item">/g) ?? []).length).toBe(1);
    expect(byLabel).toContain(">labeled milestone issue</a>");
    // Tab links keep the facet.
    expect(byLabel).toContain(`href="/alice/wave2/issues?labels=${fixture.bugLabelId}"`);

    const byMilestone = await (await fetchUi("/alice/wave2/issues?milestone=v1.0")).text();
    expect((byMilestone.match(/<div class="item">/g) ?? []).length).toBe(1);
    expect(byMilestone).toContain('href="/alice/wave2/issues?milestone=1"');

    const closedPlusLabel = await (
      await fetchUi(`/alice/wave2/issues?state=closed&labels=${fixture.enhancementLabelId}`)
    ).text();
    expect((closedPlusLabel.match(/<div class="item">/g) ?? []).length).toBe(0);
    expect(closedPlusLabel).toContain('<h3 class="tw-my-4">No results</h3>');
    expect(closedPlusLabel).toContain("Try adjusting your search filters.");
  });

  it("renders the pulls list from the same rows: is_pull only, distinct chrome", async () => {
    const html = await (await fetchUi("/alice/wave2/pulls")).text();
    expect(html).toContain('<div role="main" aria-label="Pull Requests" class="page-content repository issue-list">');
    expect(html).toContain("<title>Pull Requests - alice/wave2</title>");
    const items = html.match(/<div class="item">/g) ?? [];
    expect(items).toHaveLength(1);
    expect(html).toContain(">pull: wave2 feature branch</a>");
    expect(html).toContain(">1 Open</a>");
    expect(html).toContain(">0 Closed</a>");
    expect(html).not.toContain("pagination issue");
    // The PR row's title/index links use the upstream issue-link family
    // (/issues/{index} — upstream redirects PR numbers there).
  });

  it("renders the empty state on an issue-less repo, deterministic bytes on repeat", async () => {
    const db = drizzle(env.DB);
    const owner = await db
      .select({ ownerId: repositories.ownerId })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave2")))
      .get();
    const id = crypto.randomUUID();
    await db.insert(repositories).values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace: "alice",
      ownerId: owner?.ownerId,
      slug: "wave2-empty",
      visibility: "public",
    });
    const first = await fetchUi("/alice/wave2-empty/issues");
    expect(first.status).toBe(200);
    const html = await first.text();
    expect(html).toContain('<h3 class="tw-my-4">No results</h3>');
    expect(html).toContain(">0 Open</a>");
    expect(html).toContain(">0 Closed</a>");
    expect(html).not.toContain('id="issue-list"');

    const second = await fetchUi("/alice/wave2-empty/issues");
    expect(await second.text()).toBe(html);
  });

  it("404-shells private repos and unknown repos; the live pages pass the §5.5 a11y smoke", async () => {
    const privateRes = await fetchUi("/alice/wave2-secret/issues");
    expect(privateRes.status).toBe(404);
    expect(await privateRes.text()).toContain('<div class="status-page-error">');

    const unknown = await fetchUi("/nobody/nothing/issues");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).not.toContain("repo-header");

    const live = await fetchUi("/alice/wave2/issues");
    expect(runA11y(await live.text())).toEqual([]);

    const pulls = await fetchUi("/alice/wave2/pulls");
    expect(runA11y(await pulls.text())).toEqual([]);

    const treeLanding = await fetchUi("/alice/wave2/src/branch/main/docs");
    expect(runA11y(await treeLanding.text())).toEqual([]);
  });
});
