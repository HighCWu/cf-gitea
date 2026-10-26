/**
 * The GLOBAL INBOX pages' SMOKE tests (PORT-FIRST — one happy path per
 * tab, no matrices): the module is UNMOUNTED — the route arms are
 * index-owned (the module header's HANDOFF NOTE carries the recipe) — so
 * the tests drive the loaders + full-document renders DIRECTLY on real D1
 * (workerd, @cloudflare/vitest-plugin).
 *
 * The shared fixture seeds the viewer across THREE repos: their own
 * `alice/alpha` (public), the collaborated `bob/beta` (public — the
 * repo_collaborators edge), and the inaccessible `bob/secret` (private,
 * no grant) — every tab's happy path asserts the first two repos' rows
 * render and the private repo's row is EXCLUDED (the cross-repo scope,
 * the module header's perm filter).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { addOrUpdateCollaborator } from "../../api/services/repo-collaborators";
import { createRepoMilestone } from "../../api/services/milestones";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  loadDashboardMilestonesData,
  loadOverviewIssuesData,
  renderDashboardMilestonesPage,
  renderOverviewIssuesPage,
} from "./global-inbox";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_750_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

/** Synthetic manifest shaped like the real Vite output (the harness
 *  fixture — deterministic, no build dependence). */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

interface Seeded {
  alice: { id: number; username: string };
  aliceViewer: Extract<Viewer, { kind: "user" }>;
  alphaRepoId: string;
  betaRepoId: string;
}

let seeded: Seeded | undefined;

async function seed(): Promise<Seeded> {
  if (seeded !== undefined) return seeded;
  const alice = await seedVerifiedUser({ username: "alice" });
  const bob = await seedVerifiedUser({ username: "bob" });
  const repos = new RepoService(env.DB);
  const alpha = await repos.create({
    owner: { id: alice.id, usernameLower: "alice" },
    name: "alpha",
    isPrivate: false,
    status: "ready",
  });
  const beta = await repos.create({
    owner: { id: bob.id, usernameLower: "bob" },
    name: "beta",
    isPrivate: false,
    status: "ready",
  });
  const secret = await repos.create({
    owner: { id: bob.id, usernameLower: "bob" },
    name: "secret",
    isPrivate: true,
    status: "ready",
  });
  // The collaboration edge puts beta in the viewer's scope (the owned ∪
  // collaborated read path — the module header's perm filter).
  await addOrUpdateCollaborator(env.DB, beta.id, alice.id, "write", at(0));

  const svc = new IssuesService(env.DB);
  // Milestones first: the issue attachments feed the maintained counters
  // (the progress-bar facts).
  const v1 = await createRepoMilestone(new IssuesService(env.DB), alpha.id, {
    title: "v1.0",
    description: "",
    deadlineAt: null,
    state: "open",
    now: at(5),
  });
  await createRepoMilestone(new IssuesService(env.DB), beta.id, {
    title: "v2.0",
    description: "",
    deadlineAt: null,
    state: "open",
    now: at(6),
  });
  await createRepoMilestone(new IssuesService(env.DB), secret.id, {
    title: "s9",
    description: "",
    deadlineAt: null,
    state: "open",
    now: at(7),
  });

  await svc.createIssue({
    repoId: alpha.id,
    title: "Alpha bug",
    posterId: alice.id,
    milestoneId: v1.id,
    now: at(10),
  });
  await svc.createPullRequest({
    repoId: alpha.id,
    title: "Alpha improve",
    posterId: alice.id,
    headRepoId: alpha.id,
    headBranch: "feature",
    baseBranch: "main",
    now: at(15),
  });
  await svc.createIssue({
    repoId: beta.id,
    title: "Beta task",
    posterId: bob.id,
    now: at(20),
  });
  await svc.createIssue({
    repoId: secret.id,
    title: "Secret issue",
    posterId: bob.id,
    now: at(25),
  });

  seeded = {
    alice,
    aliceViewer: { kind: "user", id: alice.id, username: "alice", isAdmin: false },
    alphaRepoId: alpha.id,
    betaRepoId: beta.id,
  };
  return seeded;
}

function ctxFor(viewer: Viewer): UiContext {
  return {
    viewer,
    origin: "https://test.local",
    assets: shellAssetsFromManifest(manifest),
  };
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "issue_labels",
    "issue_assignees",
    "issue_dependency",
    "issue_subscriptions",
    "pull_reviews",
    "pull_requests",
    "repo_watchers",
    "repo_collaborators",
    "milestones",
    "comments",
    "issues",
    "repo_counters",
    "repo_units",
    "repo_redirects",
    "repo_settings",
    "repositories",
    "personal_access_tokens",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  seeded = undefined;
});

// --- the /issues tab -----------------------------------------------------------

describe("GET /issues (loadOverviewIssuesData issues arm + renderOverviewIssuesPage)", () => {
  it("lists the seeded issues across the two visible repos and EXCLUDES the private repo's row", async () => {
    const state = await seed();
    const data = await loadOverviewIssuesData(env.DB, state.aliceViewer, "issues", new URLSearchParams());
    // The default arm is your_repositories, default sort recentupdate —
    // the beta issue (stamped latest) first, the alpha issue second; the
    // PR does not belong on the issues tab.
    expect(data.items.map((item) => item.title)).toEqual(["Beta task", "Alpha bug"]);
    expect(data.items.map((item) => `${item.ownerNamespace}/${item.slug}#${item.index}`)).toEqual([
      "bob/beta#1",
      "alice/alpha#1",
    ]);
    expect(data.items.some((item) => item.title === "Secret issue")).toBe(false);
    expect(data.openCount).toBe(2);
    expect(data.closedCount).toBe(0);
    expect(data.armCounts.your_repositories).toBe(2);

    const html = renderOverviewIssuesPage(ctxFor(state.aliceViewer), data);
    expect(html).toContain("dashboard issues"); // the §2.4.1 discriminator
    expect(html).toContain('href="/issues">In your repositories <strong>2</strong></a>'); // the nav's default arm, live count
    expect(html).toContain("Beta task");
    expect(html).toContain("bob/beta#1");
    expect(html).toContain("alice/alpha#1");
    expect(html).not.toContain("Secret issue");
    expect(html).not.toContain("bob/secret");
  });
});

// --- the /pulls tab ------------------------------------------------------------

describe("GET /pulls (loadOverviewIssuesData pulls arm + renderOverviewIssuesPage)", () => {
  it("lists the seeded PR and EXCLUDES the private repo's rows and the plain issues", async () => {
    const state = await seed();
    const data = await loadOverviewIssuesData(env.DB, state.aliceViewer, "pulls", new URLSearchParams());
    expect(data.items.map((item) => item.title)).toEqual(["Alpha improve"]);
    expect(data.items[0]?.isPull).toBe(true);
    expect(data.items.some((item) => item.title === "Secret issue")).toBe(false);
    expect(data.items.some((item) => item.title === "Alpha bug")).toBe(false);

    const html = renderOverviewIssuesPage(ctxFor(state.aliceViewer), data);
    expect(html).toContain("dashboard issues"); // the shared template serves both lists
    expect(html).toContain('href="/pulls?type=review_requested">Review requested <strong>0</strong></a>'); // the pulls-only review arms
    expect(html).toContain("Alpha improve");
    expect(html).not.toContain("Secret issue");
    expect(html).not.toContain("Alpha bug");
  });
});

// --- the /milestones tab ---------------------------------------------------------

describe("GET /milestones (loadDashboardMilestonesData + renderDashboardMilestonesPage)", () => {
  it("lists the seeded milestones across the two visible repos with their repo labels, and EXCLUDES the private repo's milestone", async () => {
    const state = await seed();
    const data = await loadDashboardMilestonesData(env.DB, state.aliceViewer, new URLSearchParams(), at(100));
    // The default sort (closestduedate: deadline ASC, name ASC) — both
    // deadlines null, so the names order.
    expect(data.items.map((item) => item.row.name)).toEqual(["v1.0", "v2.0"]);
    expect(data.items.some((item) => item.row.name === "s9")).toBe(false);
    // The attached issue feeds the maintained counters — the open count
    // is a real number, not a degradation.
    expect(data.items[0]?.openIssues).toBe(1);
    expect(data.items[0]?.ownerNamespace).toBe("alice");
    // The sidebar: one entry per milestone-bearing VISIBLE repo, counts
    // over the current state; the private repo is absent.
    expect(data.repoMenu.map((repo) => `${repo.ownerNamespace}/${repo.slug}`)).toEqual([
      "alice/alpha",
      "bob/beta",
    ]);
    expect(data.repoMenu.every((repo) => repo.count === 1)).toBe(true);
    expect(data.total).toBe(2);

    const html = renderDashboardMilestonesPage(ctxFor(state.aliceViewer), data);
    expect(html).toContain("dashboard issues repository milestones"); // the §2.4.1 discriminator
    expect(html).toContain("v1.0");
    expect(html).toContain('class="ui large label"');
    expect(html).toContain("alice/alpha");
    expect(html).toContain("bob/beta");
    expect(html).not.toContain("s9");
    expect(html).not.toContain("bob/secret");
  });
});
