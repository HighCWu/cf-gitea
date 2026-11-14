/**
 * The repo tab strip's STRUCTURAL GUARD (the 6b88549 usage-reported
 * regression's class): every page that renders a repo header must arm the
 * strip anchor its upstream family arms. Upstream arms the strip through
 * per-route `ctx.Data` flags (templates/repo/header.tmpl — :101
 * PageIsViewCode, :107 PageIsIssueList, :123 PageIsPullList, :132
 * PageIsActions, :140-144 IsPackagesPage, :149 IsProjectsPage, :157
 * PageIsReleaseList/PageIsTagList, :166 PageIsWiki, :178 PageIsActivity,
 * :187 PageIsRepoSettings — armed in routers/web per handler; the settings
 * flag is the group-level ctxDataSet on the whole /settings group,
 * web.go:1287); our port's seam is the per-page `activeTab` prop (the
 * shell's BaseLayout derives only the activity/settings pageClass special
 * cases — shell.tsx's BaseLayout — and RepoHeader defaults to "code").
 * A page that misses its prop falls to the Code default SILENTLY — exactly
 * the reported regression (the issues list stayed on Code). This file is
 * the net for the whole class: it drives the REAL router (the mounted
 * uiRouter — the issues-list matrix's fetchUi rig) over ONE representative
 * URL per page family and asserts the strip's active-anchor set equals the
 * audited expectation (which doubles as the "exactly ONE strip anchor
 * active per page" invariant).
 *
 * The audited table (each row derived at the upstream pin this session;
 * the sweep's full 35-row audit lives in the convergence-backlog §4 bullet):
 *
 *   view-code (upstream prepareRepoViewContent view_home.go:401, search.go:23,
 *     branch.go:45, compare.go:518 CompareDiff — CODE, not PullList) →
 *     home / src / blame / search / branches / compare: active `${LINK}`.
 *   commits family (OUR SPEC-0008 §2.4.1 strip addition; upstream arms
 *     PageIsViewCode + the sub-menu-only PageIsCommits, commit.go:60-65 and
 *     :108-109) → /commits and /graph: active `${LINK}/commits`.
 *   issue family (issue_list.go:672, issue_view.go:366, issue_new.go:104,
 *     issue_label.go:33, milestone.go:35/100/109) → issues list/detail/new/
 *     labels/milestones/milestone detail: active `${LINK}/issues`.
 *   pull family (issue_list.go:661, issue_view.go:359, pull.go:633/683) →
 *     pulls list/detail/files/commits: active `${LINK}/pulls`.
 *   actions family (actions.go:88, job_queue.go:17, view.go:206) → runs list/
 *     job queue/run view: active `${LINK}/actions` (the queue and the run
 *     view are the sweep's FIXES — they fell to the Code default).
 *   packages (packages.go:57 IsPackagesPage) → /packages: active
 *     `${LINK}/packages`.
 *   projects (projects.go:116/432/443 IsProjectsPage) → /projects: active
 *     `${LINK}/projects`.
 *   releases/tags (release.go:178 prepareReleasePageCommon; release.go:228
 *     TagsList PageIsTagList → the ONE releases anchor, header.tmpl:157) →
 *     /releases AND /tags: active `${LINK}/releases` (the tags page is the
 *     sweep's third FIX).
 *   wiki (web.go:1623, the whole /wiki group) → /wiki: active `${LINK}/wiki`.
 *   activity (activity.go:24, contributors.go:22, code_frequency.go:23,
 *     recent_commits.go:21) → /activity and /activity/contributors: active
 *     `${LINK}/activity` (the charts page rides BaseLayout's
 *     `repository commits` pageClass derivation).
 *   settings (web.go:1287, group-level PageIsRepoSettings) → /settings:
 *     active `${LINK}/settings` (the pageClass-prefix derivation).
 *
 * Port-posture rows pinned here AS code (upstream arms NO flag — its strip
 * shows no active anchor — while our RepoHeader always renders exactly one):
 *   commit view (commit.go:280 arms PageIsDiff only — the page passes
 *     activeTab="code" explicitly) and the social lists (view.go:362-380 arm
 *     nothing — /forks rides the default).
 * Recorded-only exclusions (not routable here without deeper fixtures, all
 * posture-pinned in their own batteries): the editor family (explicit code),
 * /fork and the artifact preview (upstream renders NO strip there at all),
 * the migrating page (upstream's IsBeingCreated header branch arms Code —
 * our default matches), the releases new/edit pages (upstream arms nothing;
 * the pages pass releases explicitly, golden family — untouched), and the
 * 404 shell.
 */

import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor } from "../../auth/testing/seeds";
import { buildHistoryPack, buildReceivePackBody, ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { IssuesService } from "../../issues/service";
import { insertActionRun } from "../../services/actions/model";
import { repoSettings, repositories, users } from "../../db/schema";
import type { UiManifest } from "../manifest";
import { uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";

// --- the fetchUi rig (the issues-list matrix's minted-session pattern) ----------

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

// --- the strip slice ------------------------------------------------------------

/** The strip renders inside the repo header's overflow-menu (shell.tsx's
 *  RepoHeader — the FIRST overflow-menu in every document, emitted before
 *  the page body). Everything the page's own sub-menus arm (the tags page's
 *  release_tag_header, the labels page's issue-navbar) lives AFTER it, so
 *  the slice isolates the strip anchors from the page-internal menus. */
function stripSlice(html: string): string {
  const start = html.indexOf('<overflow-menu class="ui secondary pointing menu">');
  const end = html.indexOf("</overflow-menu>", start);
  expect(start, "the repo header's tab strip must render").toBeGreaterThan(-1);
  expect(end, "the tab strip must close").toBeGreaterThan(start);
  return html.slice(start, end);
}

/** The strip's active anchors, in render order (the class precedes the href
 *  in every RepoHeader anchor). One entry per active anchor — the invariant
 *  is exactly one, and it must be the audited href. */
function activeStripHrefs(html: string): string[] {
  return [...stripSlice(html).matchAll(/class="active item" href="([^"]*)"/g)].map((m) => m[1] as string);
}

// --- the one world (seeded once, read-only after — no wipes) ---------------------

const OWNER = "tabowner";
const SLUG = "tabstrip";
const LINK = `/${OWNER}/${SLUG}`;
const T0 = 1_700_000_000;

/** Main's history (two commits — the tag v1 rides tips[1]); the topic
 *  branch REUSES the identical first two commits (byte-identical → same
 *  oids, so main's tip IS the PR's merge base) plus one topic commit. */
const BASE_COMMITS: SeedCommit[] = [
  { message: "tabstrip: initial commit", time: T0, files: [{ path: "README.md", content: "# tabstrip\n" }] },
  {
    message: "tabstrip: add app source",
    time: T0 + 60,
    files: [
      { path: "README.md", content: "# tabstrip\n" },
      { path: "app.ts", content: "export function main(): void {}\n" },
    ],
  },
];
const TOPIC_COMMITS: SeedCommit[] = [
  ...BASE_COMMITS,
  {
    message: "tabstrip: topic edit",
    time: T0 + 120,
    files: [
      { path: "README.md", content: "# tabstrip\n" },
      { path: "app.ts", content: "export function main(): void { /* topic */ }\n" },
    ],
  },
];

interface World {
  owner: { id: number; username: string };
  tips: string[];
  topicTip: string;
  issueIndex: number;
  milestoneId: number;
  prIndex: number;
  runId: number;
  sessionCookie: string;
}

let world: World | null = null;

function w(): World {
  if (world === null) throw new Error("fixtures not seeded");
  return world;
}

beforeAll(async () => {
  await applyAuthD1Migrations();

  // 1. The engine content: main + tag v1 (the idempotent receive-flow seed).
  const seeded = await ensureSeededRepo({
    owner: OWNER,
    slug: SLUG,
    commits: BASE_COMMITS,
    tags: [{ name: "v1", commitIndex: 1 }],
  });

  // 2. The D1 fixtures over the seeded repo row (the PR row FIRST — the
  //    topic push below names its refs/pull/{index}/head like the harness's
  //    PR-diff seed; createPullRequest is D1-only and needs no refs).
  const db = drizzle(env.DB);
  const repo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, SLUG)))
    .get();
  if (repo === undefined) throw new Error("tabstrip repo row missing after seeding");
  const owner = await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.usernameLower, OWNER)).get();
  if (owner === undefined) throw new Error("tabowner row missing after seeding");

  // The projects unit (creation seeds the settings row with the flag off —
  // the documented house divergence; the wave-45 fixture's upsert shape).
  await db
    .insert(repoSettings)
    .values({ repoId: repo.id, hasProjects: true })
    .onConflictDoUpdate({ target: repoSettings.repoId, set: { hasProjects: true } });

  const svc = new IssuesService(env.DB);
  const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);
  const issue = await svc.createIssue({ repoId: repo.id, title: "tabstrip: the pinned issue", posterId: owner.id, now: at(10) });
  const milestone = await svc.createMilestone({ repoId: repo.id, name: "tabstrip-v1", now: at(20) });
  const pull = await svc.createPullRequest({
    repoId: repo.id,
    title: "tabstrip: the pinned pull",
    posterId: owner.id,
    headRepoId: repo.id,
    headBranch: "topic",
    baseBranch: "main",
    now: at(30),
  });

  // 3. The topic branch + the pull head ref (guarded on the ref like the
  //    harness's PR-diff seed — the pack over the SHARED prefix keeps the
  //    merge base at main's tip).
  const refNames = new Set(((await env.REPO.getByName(`${OWNER}/${SLUG}`).listRefs()).refs ?? []).map((ref) => ref.name));
  let topicTip: string;
  if (refNames.has("refs/heads/topic")) {
    topicTip = (await buildHistoryPack(TOPIC_COMMITS)).tips[2] as string;
  } else {
    const { tips: topicTips, pack } = await buildHistoryPack(TOPIC_COMMITS);
    topicTip = topicTips[2] as string;
    await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
      .bind(owner.id, "ui-page-seed-tabstrip-topic")
      .run();
    const token = (await mintFor(owner.id, "ui-page-seed-tabstrip-topic", "write:repository")).plaintext;
    const response = await SELF.fetch(`https://test.local/${OWNER}/${SLUG}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
      body: buildReceivePackBody(
        [
          { ref: "refs/heads/topic", oid: topicTip },
          { ref: `refs/pull/${pull.issue.index}/head`, oid: topicTip },
        ],
        pack,
      ),
    });
    const body = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    if (response.status !== 200 || body.includes("ng ")) {
      throw new Error(`tabstrip topic push failed: ${response.status} ${body.slice(0, 400)}`);
    }
  }

  // One waiting run (the M1a staged insert — run + attempt + jobs), for the
  // run-view family representative.
  const { run } = await insertActionRun(
    env.DB,
    {
      repoId: repo.id,
      ownerId: owner.id,
      workflowId: ".github/workflows/ci.yml",
      index: 1,
      triggerUserId: owner.id,
      ref: "refs/heads/main",
      commitSha: seeded.tips[1] as string,
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
      title: "tabstrip run",
    },
    [{ jobId: "build", name: "build (tabstrip)", runsOn: ["ubuntu-latest"], workflowPayload: new TextEncoder().encode("jobs: {}\n") }],
  );

  world = {
    owner,
    tips: seeded.tips,
    topicTip,
    issueIndex: issue.index,
    milestoneId: milestone.id,
    prIndex: pull.issue.index,
    runId: run.id,
    sessionCookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, owner.id)}`,
  };
});

// --- the audited table (one representative URL per page family) ------------------

/** `owner` rides the minted owner session (the sign-in-gated arms: the new
 *  issue form and the settings page). */
interface StripCase {
  family: string;
  path: string;
  activeHref: string;
  owner?: boolean;
}

const CASES: StripCase[] = [
  // view-code (upstream arms PageIsViewCode on every one of these handlers).
  { family: "home", path: `${LINK}`, activeHref: LINK },
  { family: "file view", path: `${LINK}/src/branch/main/README.md`, activeHref: LINK },
  { family: "blame", path: `${LINK}/blame/branch/main/README.md`, activeHref: LINK },
  { family: "repo search", path: `${LINK}/search?q=zzz-no-match`, activeHref: LINK },
  { family: "branches", path: `${LINK}/branches`, activeHref: LINK },
  { family: "compare (ViewCode — compare.go:518, NOT PullList)", path: `${LINK}/compare/main...v1`, activeHref: LINK },
  // port posture: the commit view passes code explicitly (upstream arms no
  // strip flag — PageIsDiff only, commit.go:280).
  { family: "commit view (port posture — explicit code)", path: `${LINK}/commit/x`, activeHref: LINK },
  // port posture: the social lists arm nothing upstream; the default stands.
  { family: "forks (port posture — default code)", path: `${LINK}/forks`, activeHref: LINK },
  // the commits family (OUR SPEC-0008 §2.4.1 strip addition).
  { family: "commits list", path: `${LINK}/commits`, activeHref: `${LINK}/commits` },
  { family: "graph", path: `${LINK}/graph`, activeHref: `${LINK}/commits` },
  // the issue family.
  { family: "issues list (the usage-reported page)", path: `${LINK}/issues`, activeHref: `${LINK}/issues` },
  { family: "issue detail (issue_view.go:366)", path: `${LINK}/issues/x`, activeHref: `${LINK}/issues` },
  { family: "new issue (issue_new.go:104)", path: `${LINK}/issues/new`, activeHref: `${LINK}/issues`, owner: true },
  { family: "labels (issue_label.go:33)", path: `${LINK}/labels`, activeHref: `${LINK}/issues` },
  { family: "milestones (milestone.go:100)", path: `${LINK}/milestones`, activeHref: `${LINK}/issues` },
  { family: "milestone detail (milestone.go:35)", path: `${LINK}/milestone/x`, activeHref: `${LINK}/issues` },
  // the pull family.
  { family: "pulls list (the usage-reported twin)", path: `${LINK}/pulls`, activeHref: `${LINK}/pulls` },
  { family: "pull detail (issue_view.go:359)", path: `${LINK}/pulls/x`, activeHref: `${LINK}/pulls` },
  { family: "pull files (pull.go:683)", path: `${LINK}/pulls/x/files`, activeHref: `${LINK}/pulls` },
  { family: "pull commits (pull.go:633)", path: `${LINK}/pulls/x/commits`, activeHref: `${LINK}/pulls` },
  // the actions family (the queue + run view are the sweep's FIXES).
  { family: "actions runs list (actions.go:88)", path: `${LINK}/actions`, activeHref: `${LINK}/actions` },
  { family: "actions job queue (FIX — job_queue.go:17)", path: `${LINK}/actions/job_queue`, activeHref: `${LINK}/actions` },
  { family: "actions run view (FIX — view.go:206)", path: `${LINK}/actions/runs/x`, activeHref: `${LINK}/actions` },
  { family: "packages (packages.go:57 IsPackagesPage)", path: `${LINK}/packages`, activeHref: `${LINK}/packages` },
  { family: "projects (projects.go:116 IsProjectsPage)", path: `${LINK}/projects`, activeHref: `${LINK}/projects` },
  { family: "releases (release.go:178)", path: `${LINK}/releases`, activeHref: `${LINK}/releases` },
  { family: "tags (FIX — release.go:228 PageIsTagList arms the releases anchor)", path: `${LINK}/tags`, activeHref: `${LINK}/releases` },
  { family: "wiki (web.go:1623)", path: `${LINK}/wiki`, activeHref: `${LINK}/wiki` },
  { family: "activity (activity.go:24)", path: `${LINK}/activity`, activeHref: `${LINK}/activity` },
  { family: "activity charts (contributors.go:22 — the pageClass derivation)", path: `${LINK}/activity/contributors`, activeHref: `${LINK}/activity` },
  { family: "settings (web.go:1287 — the pageClass-prefix derivation)", path: `${LINK}/settings`, activeHref: `${LINK}/settings`, owner: true },
];

describe("the repo tab strip's structural guard (one representative URL per page family)", () => {
  for (const testCase of CASES) {
    it(`arms ${testCase.activeHref} on the ${testCase.family} page (${testCase.path})`, async () => {
      const fixture = w();
      const path = testCase.path
        .replace("/issues/x", `/issues/${fixture.issueIndex}`)
        .replace("/milestone/x", `/milestone/${fixture.milestoneId}`)
        .replace("/pulls/x/", `/pulls/${fixture.prIndex}/`)
        .replace("/pulls/x", `/pulls/${fixture.prIndex}`)
        .replace("/commit/x", `/commit/${fixture.tips[1] as string}`)
        .replace("/actions/runs/x", `/actions/runs/${fixture.runId}`);
      const res = await fetchUi(path, testCase.owner === true ? { headers: { cookie: fixture.sessionCookie } } : undefined);
      expect(res.status).toBe(200);
      const html = await res.text();
      // The whole invariant in one assertion: exactly ONE strip anchor is
      // active, and it is the family's audited href.
      expect(activeStripHrefs(html)).toEqual([testCase.activeHref]);
    });
  }
});

/** The topic tip is load-bearing for the pull family's diff arms — pin the
 *  fixture so a seed drift fails loudly here and not as a mystery 404. */
describe("the guard's fixtures", () => {
  it("seeded main, the v1 tag and the topic branch with the shared merge base", async () => {
    const fixture = w();
    const refs = (await env.REPO.getByName(`${OWNER}/${SLUG}`).listRefs()).refs ?? [];
    const names = new Set(refs.map((ref) => ref.name));
    expect(names.has("refs/heads/main")).toBe(true);
    expect(names.has("refs/tags/v1")).toBe(true);
    expect(names.has("refs/heads/topic")).toBe(true);
    expect(fixture.tips).toHaveLength(2);
    expect(fixture.topicTip).not.toBe(fixture.tips[1]);
  });
});
