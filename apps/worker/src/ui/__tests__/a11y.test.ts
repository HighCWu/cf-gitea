/**
 * §5.5 accessibility smoke over the committed goldens (no browser), plus
 * unit pins for the hand-rolled walker (a11y.ts) so the smoke itself cannot
 * silently mis-parse. Runs purely on the committed bytes — no seeding, no
 * engine, no rendering.
 */

import { describe, expect, it } from "vitest";

import { accessibleName, descendants, getElementById, parseHtmlTree, runA11y } from "./a11y";
// Pages wave 129: the four expansion goldens (goldens.test.ts's
// NEW_GOLDEN_CASES) — covered EXPLICITLY by the expansion arms below, never
// through harness.ts's GOLDEN_CASES (that table feeds the smoke loop above
// too; entries added there would silently grow this suite without review).
import adminMonitorCronGolden from "./goldens/admin-monitor-cron.html?raw";
import adminMonitorQueueGolden from "./goldens/admin-monitor-queue.html?raw";
import adminMonitorStatsGolden from "./goldens/admin-monitor-stats.html?raw";
import adminOrgsGolden from "./goldens/admin-orgs.html?raw";
import adminReposGolden from "./goldens/admin-repos.html?raw";
import adminUsersGolden from "./goldens/admin-users.html?raw";
import bareShellGolden from "./goldens/bare-shell.html?raw";
import branchesGolden from "./goldens/branches.html?raw";
import commitViewGolden from "./goldens/commit-view.html?raw";
import commitViewRootGolden from "./goldens/commit-view-root.html?raw";
import branchesWriterGolden from "./goldens/branches-writer.html?raw";
import commitsGolden from "./goldens/commits.html?raw";
import compareCommitsGolden from "./goldens/compare-commits.html?raw";
import compareFormGolden from "./goldens/compare-form.html?raw";
import compareHasPrGolden from "./goldens/compare-has-pr.html?raw";
import compareNothingGolden from "./goldens/compare-nothing.html?raw";
import dashboardGolden from "./goldens/dashboard.html?raw";
import exploreReposGolden from "./goldens/explore-repos.html?raw";
import exploreUsersGolden from "./goldens/explore-users.html?raw";
import fileViewCodeGolden from "./goldens/file-view-code.html?raw";
import fileViewTeamWriterGolden from "./goldens/file-view-team-writer.html?raw";
import homeGolden from "./goldens/home.html?raw";
import issueDetailGolden from "./goldens/issue-detail.html?raw";
import issuesClosedGolden from "./goldens/issues-closed.html?raw";
import issuesOpenGolden from "./goldens/issues-open.html?raw";
import landingGolden from "./goldens/landing.html?raw";
import labelsGolden from "./goldens/labels.html?raw";
import labelsWriterGolden from "./goldens/labels-writer.html?raw";
import milestonesClosedGolden from "./goldens/milestones-closed.html?raw";
import milestoneDetailGolden from "./goldens/milestone-detail.html?raw";
import milestonesOpenGolden from "./goldens/milestones-open.html?raw";
import notFoundRepoGolden from "./goldens/not-found-repo.html?raw";
import orgLabelsGolden from "./goldens/org-labels.html?raw";
import orgTeamDetailGolden from "./goldens/org-team-detail.html?raw";
import orgTeamsGolden from "./goldens/org-teams.html?raw";
import notificationsReadGolden from "./goldens/notifications-read.html?raw";
import notificationsUnreadGolden from "./goldens/notifications-unread.html?raw";
import orgHomeEmptyGolden from "./goldens/org-home-empty.html?raw";
import orgHomeGolden from "./goldens/org-home.html?raw";
import pullCommitsGolden from "./goldens/pull-commits.html?raw";
import pullDetailGolden from "./goldens/pull-detail.html?raw";
import pullFilesGolden from "./goldens/pull-files.html?raw";
import pullReviewSignedInGolden from "./goldens/pull-review-signed-in.html?raw";
import profileActivityGolden from "./goldens/profile-activity.html?raw";
import profileWatchingGolden from "./goldens/profile-watching.html?raw";
import pullsOpenGolden from "./goldens/pulls-open.html?raw";
// Pages wave 19: the creation pages — the new-repository form (the
// org-bearing owner select) and the new-organization form.
import orgCreateGolden from "./goldens/org-create.html?raw";
import repoCreateGolden from "./goldens/repo-create.html?raw";
import releaseDetailGolden from "./goldens/release-detail.html?raw";
import releaseNewGolden from "./goldens/release-new.html?raw";
import releasesGolden from "./goldens/releases.html?raw";
import releasesWriterGolden from "./goldens/releases-writer.html?raw";
import settingsBranchesGolden from "./goldens/settings-branches.html?raw";
import settingsHookDetailGolden from "./goldens/settings-hook-detail.html?raw";
import settingsMirrorGolden from "./goldens/settings-mirror.html?raw";
import settingsTeamAdminGolden from "./goldens/settings-team-admin.html?raw";
import treeDirGolden from "./goldens/tree-dir.html?raw";
import userProfileGolden from "./goldens/user-profile.html?raw";
import userSettingsAccountGolden from "./goldens/user-settings-account.html?raw";
import userSettingsNotificationsGolden from "./goldens/user-settings-notifications.html?raw";
import userSettingsProfileGolden from "./goldens/user-settings-profile.html?raw";
import userSettingsReposGolden from "./goldens/user-settings-repos.html?raw";
import wikiStartGolden from "./goldens/wiki-start.html?raw";
import { GOLDEN_CASES } from "./harness";

const goldens: Record<string, string> = {
  "home.html": homeGolden,
  "commits.html": commitsGolden,
  "file-view-code.html": fileViewCodeGolden,
  "tree-dir.html": treeDirGolden,
  "issues-open.html": issuesOpenGolden,
  "issues-closed.html": issuesClosedGolden,
  "pulls-open.html": pullsOpenGolden,
  "issue-detail.html": issueDetailGolden,
  "pull-detail.html": pullDetailGolden,
  "pull-review-signed-in.html": pullReviewSignedInGolden,
  "pull-files.html": pullFilesGolden,
  // The PR commits tab (the three-tab menu completion).
  "pull-commits.html": pullCommitsGolden,
  "org-home.html": orgHomeGolden,
  "org-home-empty.html": orgHomeEmptyGolden,
  "user-profile.html": userProfileGolden,
  "milestones-open.html": milestonesOpenGolden,
  "milestones-closed.html": milestonesClosedGolden,
  "not-found-repo.html": notFoundRepoGolden,
  "bare-shell.html": bareShellGolden,
  "landing.html": landingGolden,
  // Pages wave 25: the repo labels page — the anonymous list and the
  // signed-in owner view (the GOLDEN_CASES entries above; the owner-arm
  // bytes hardening).
  "labels.html": labelsGolden,
  "labels-writer.html": labelsWriterGolden,
  "dashboard.html": dashboardGolden,
  "explore-repos.html": exploreReposGolden,
  "explore-users.html": exploreUsersGolden,
  "notifications-unread.html": notificationsUnreadGolden,
  "notifications-read.html": notificationsReadGolden,
  "settings-mirror.html": settingsMirrorGolden,
  // Pages wave 12: the org teams list + detail slices and the user
  // settings profile (the GOLDEN_CASES entries above).
  "org-teams.html": orgTeamsGolden,
  "org-team-detail.html": orgTeamDetailGolden,
  "user-settings-profile.html": userSettingsProfileGolden,
  // Pages wave 14: the org labels management page and the per-hook page
  // (the GOLDEN_CASES entries above).
  "org-labels.html": orgLabelsGolden,
  "settings-hook-detail.html": settingsHookDetailGolden,
  // Pages wave 15: the protected-branches settings panel (the GOLDEN_CASES
  // entry above).
  "settings-branches.html": settingsBranchesGolden,
  // Pages wave 13: the compare family (the plain comparison, the writer's
  // new-PR form view, the has-PR pair, the same-tip tag state).
  "compare-commits.html": compareCommitsGolden,
  "compare-form.html": compareFormGolden,
  "compare-has-pr.html": compareHasPrGolden,
  "compare-nothing.html": compareNothingGolden,
  // The team-grant render gates (SPEC-0007 §3.5's UI half): the signed-in
  // write-team member's file view and the org owner's settings page.
  "file-view-team-writer.html": fileViewTeamWriterGolden,
  "settings-team-admin.html": settingsTeamAdminGolden,
  // Pages wave 16: the repo branches page — the anonymous list and the
  // signed-in owner view (the GOLDEN_CASES entries above).
  "branches.html": branchesGolden,
  "branches-writer.html": branchesWriterGolden,
  // Pages wave 18: the commit view — main's tip (parents + the binary BIN
  // arm) and the root commit (the no-parents arm, whole-tree diff).
  "commit-view.html": commitViewGolden,
  "commit-view-root.html": commitViewRootGolden,
  // Pages wave 19: the creation forms (the signed-in renders — the
  // anonymous arms 303 and have no golden).
  "repo-create.html": repoCreateGolden,
  "org-create.html": orgCreateGolden,
  // Pages wave 20: the releases family — the anonymous list (the draft
  // hidden), the writer list (the draft's Draft label + the New Release
  // button), the v1 detail and the writer create form.
  "releases.html": releasesGolden,
  "releases-writer.html": releasesWriterGolden,
  "release-detail.html": releaseDetailGolden,
  "release-new.html": releaseNewGolden,
};

function classList(el: { attrs: Record<string, string> }): string[] {
  return (el.attrs.class ?? "").split(/\s+/).filter(Boolean);
}

function hasClass(el: { attrs: Record<string, string> }, cls: string): boolean {
  return classList(el).includes(cls);
}

// --- the smoke over every golden ------------------------------------------------

describe("§5.5 a11y smoke over the goldens", () => {
  for (const golden of GOLDEN_CASES) {
    it(`${golden.file} passes the structural rules`, () => {
      const violations = runA11y(goldens[golden.file] ?? "");
      expect(violations, `${golden.file}: ${JSON.stringify(violations)}`).toEqual([]);
    });
  }

  it("home carries exactly one h1 — the README heading (deviation note: the shell has no repo-name h1)", () => {
    const root = parseHtmlTree(homeGolden);
    const h1s = descendants(root).filter((el) => el.tag === "h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.attrs.id).toBe("user-content-hello-cf-gitea");
  });

  it("#repo-files-table is the upstream div shape with complete row cells (not an HTML table)", () => {
    const root = parseHtmlTree(homeGolden);
    const table = getElementById(root, "repo-files-table");
    expect(table).not.toBeNull();
    expect(table?.tag).toBe("div");
    expect(descendants(table ?? root).some((el) => hasClass(el, "repo-file-last-commit"))).toBe(true);

    const items = descendants(table ?? root).filter((el) => hasClass(el, "repo-file-item"));
    expect(items).toHaveLength(4); // README.md, app.ts, docs/, logo.png
    for (const item of items) {
      const cells = descendants(item);
      expect(cells.some((el) => hasClass(el, "repo-file-cell") && hasClass(el, "name")), "name cell").toBe(true);
      expect(
        cells.some((el) => hasClass(el, "repo-file-cell") && hasClass(el, "message") && hasClass(el, "commit-summary")),
        "message cell",
      ).toBe(true);
      expect(cells.some((el) => hasClass(el, "repo-file-cell") && hasClass(el, "age")), "age cell").toBe(true);
    }
  });

  it("the blob file view has no file list and keeps the enhancement registry", () => {
    const root = parseHtmlTree(fileViewCodeGolden);
    expect(getElementById(root, "repo-files-table")).toBeNull();
    expect(getElementById(root, "commits-table")).toBeNull();
    expect(descendants(root).some((el) => el.attrs["data-global-init"] === "initRepoFileView")).toBe(true);
  });

  it("#issue-list is the upstream divided-list shape with header/body/trailing blocks", () => {
    const root = parseHtmlTree(issuesOpenGolden);
    const list = getElementById(root, "issue-list");
    expect(list).not.toBeNull();
    const items = descendants(list ?? root).filter((el) => el.tag === "div" && hasClass(el, "item"));
    expect(items).toHaveLength(2); // two open issues; the closed one and the PR are filtered out
    for (const item of items) {
      const inner = descendants(item);
      expect(inner.some((el) => hasClass(el, "item-main")), "item-main").toBe(true);
      expect(inner.some((el) => hasClass(el, "item-header")), "item-header").toBe(true);
      expect(inner.some((el) => hasClass(el, "item-body")), "item-body").toBe(true);
    }
    // The labeled row carries both badges with the upstream inline-contrast
    // style; the milestone badge is the degraded plain-text span (no dead
    // /milestone/{id} link, issues-list.tsx header comment).
    const badges = descendants(list ?? root).filter((el) => hasClass(el, "labels-list"));
    expect(badges).toHaveLength(1);
    const labelSpans = descendants(badges[0] ?? root).filter((el) => hasClass(el, "ui") && hasClass(el, "label"));
    expect(labelSpans).toHaveLength(2);
    expect(labelSpans[0]?.attrs.style).toContain("background-color: #ee0701");
    expect(labelSpans[0]?.attrs.style).toContain("color: #fff");
    expect(descendants(list ?? root).some((el) => hasClass(el, "milestone"))).toBe(true);
    // Tabs: open active with the filtered count; pulls are excluded.
    const tabs = descendants(root).filter((el) => hasClass(el, "small-menu-items"));
    expect(tabs).toHaveLength(1);
    const tabItems = descendants(tabs[0] ?? root).filter((el) => el.tag === "a" && hasClass(el, "item"));
    expect(tabItems.map((el) => hasClass(el, "active"))).toEqual([true, false]);
    expect(tabItems[0] ? accessibleName(tabItems[0]) : "").toBe("2 Open");
    expect(tabItems[1] ? accessibleName(tabItems[1]) : "").toBe("1 Closed");
  });
});

// --- the wave-129 expansion arms (explicit; deliberately not the shared table) ---

/**
 * The wave-129 expansion goldens (goldens.test.ts's NEW_GOLDEN_CASES — the
 * four most regression-prone of the newly mounted surfaces) get a11y coverage
 * HERE, as explicit local cases: they are deliberately absent from
 * harness.ts's GOLDEN_CASES because the smoke loop above iterates that table
 * too — entries added there would silently grow this suite without review.
 * The same no-silent-growth rule, made deliberate: this arm table lands
 * together with its assertions and is reviewed as one unit.
 *
 * Every case pins the shared §2.4.1 shell contract (nav#navbar's label,
 * exactly one [role="main"] carrying its aria-label plus the page
 * discriminator class tokens, the footer landmark) and the runA11y state of
 * the committed bytes; the surface-specific arms (sidebar menus, repo/user
 * header, tab-strip accessible-name shapes) follow the loop.
 */

interface ExpansionArm {
  file: string;
  golden: string;
  /** The §2.4.1 discriminator: role=main's aria-label plus the class tokens
   *  after the leading "page-content". */
  mainAriaLabel: string;
  mainClassTokens: string[];
  /** Declared count of R6 "<th> without scope" violations in the committed
   *  bytes — 9 for admin-users (the KNOWN GAP below), 0 elsewhere. */
  thWithoutScope: number;
}

const EXPANSION_ARMS: ExpansionArm[] = [
  // GAP CLOSED (the orchestrator's fix landed same-day): admin-users' nine
  // th cells carry scope="col" (the commit-list.tsx:47 precedent) and the
  // golden regenerated — all four surfaces now assert FULLY clean runA11y.
  { file: "admin-users.html", golden: adminUsersGolden, mainAriaLabel: "User Account Management", mainClassTokens: ["admin", "user"], thWithoutScope: 0 },
  { file: "user-settings-account.html", golden: userSettingsAccountGolden, mainAriaLabel: "Account", mainClassTokens: ["user", "settings", "account"], thWithoutScope: 0 },
  { file: "profile-watching.html", golden: profileWatchingGolden, mainAriaLabel: "alice", mainClassTokens: ["user", "profile"], thWithoutScope: 0 },
  { file: "milestone-detail.html", golden: milestoneDetailGolden, mainAriaLabel: "v1.0", mainClassTokens: ["repository", "milestone-issue-list"], thWithoutScope: 0 },
  // admin-orgs (the goldens-admin-tables wave): the R6 net's first sight of
  // the org table found 2×R5 — the settings pencil's icon-only anchor lacked
  // aria-label; fixed with the peer-icon-anchor precedent (releases.tsx:870),
  // golden regenerated, landed clean.
  { file: "admin-orgs.html", golden: adminOrgsGolden, mainAriaLabel: "Organizations", mainClassTokens: ["admin", "user"], thWithoutScope: 0 },
  // admin-repos (the wave-fixed-id-seed closure — the positive-match `?q=`
  // arm over the fixed-id fixture repo, goldens.test.ts's block comment):
  // the R6 net's first sight of the repos table found NO violation to
  // pre-fix — every anchor on the page carries a name (the row's Owner/Name
  // anchors are text; the SortHeader anchors are text + aria-hidden svg; the
  // two icon-only navbar anchors carry aria-labels), and all ten th cells
  // carry scope (the admin-users gap-closed posture held here from birth).
  { file: "admin-repos.html", golden: adminReposGolden, mainAriaLabel: "Repositories", mainClassTokens: ["admin"], thWithoutScope: 0 },
  // admin-monitor stats + queue (the wave-theadless-policy closure — the
  // queued policy call): the R6 net's first sight of both pages is CLEAN
  // under the REFINED rule — no rule needed a pre-fix. The pages' thead-less
  // tables (the stats key/count rows; the queue page's delivery-states
  // segment) are the definition shape the refined R6 exempts with upstream's
  // stats.tmpl cite (each row = one label td + one value td, no th, no
  // column dimension to scope — see a11y.ts's header comment); the queue
  // page's main table carries thead+scope (upstream queue.tmpl's own shape).
  { file: "admin-monitor-stats.html", golden: adminMonitorStatsGolden, mainAriaLabel: "Stats", mainClassTokens: ["admin", "monitor"], thWithoutScope: 0 },
  { file: "admin-monitor-queue.html", golden: adminMonitorQueueGolden, mainAriaLabel: "Queues", mainClassTokens: ["admin", "monitor"], thWithoutScope: 0 },
  // admin-monitor-cron (the wave-route-clock closure — goldens.test.ts's own
  // describe holds the mechanism): the R6 net's first sight of the cron page
  // is CLEAN with no pre-fix needed — the table has carried thead + scope=col
  // on every header cell since the module landed (cron.tmpl:12-17's shape),
  // the icon-only run button carries its accessible name via title="Run"
  // (the queue page's `-` arm precedent: name-from-title on a form control),
  // and the hidden `from=monitor` input renders no label surface. The page
  // needed NO a11y pre-fix — the skip was purely the wall-clock Next Time
  // column, which the route-clock pin removed.
  { file: "admin-monitor-cron.html", golden: adminMonitorCronGolden, mainAriaLabel: "Cron Tasks", mainClassTokens: ["admin", "monitor"], thWithoutScope: 0 },
  // wave-goldens-final (the batch's selection audit lives in goldens.test.ts's
  // case comment): the four most chrome-rich surfaces still without goldens.
  // First-sight verdicts, same protocol as the orgs/repos rows above:
  //
  //   - user-settings-repos + user-settings-notifications: NO violation to
  //     pre-fix — every anchor carries text (the shared settings sidebar's
  //     items, the row Owner/Name anchors, the docs link), and neither page
  //     renders a table (R6 moot, thWithoutScope 0 by absence).
  //   - wiki-start: NO violation to pre-fix — the repo chrome's icon-only
  //     anchors (bell, New Repository/Organization, the view-page pencils on
  //     the view arm — absent here) all carry aria-labels; the start segment
  //     is text + the writer's text button. No tables.
  //   - profile-activity: NO violation to pre-fix — the feed's actor/repo
  //     anchors are text; every glyph (avatar, the trailing op icon, the
  //     strip icons) is an aria-hidden svg OUTSIDE anchors; the navbar's
  //     icon-only anchors carry aria-labels. No tables.
  { file: "user-settings-repos.html", golden: userSettingsReposGolden, mainAriaLabel: "Repositories", mainClassTokens: ["user", "settings", "repos"], thWithoutScope: 0 },
  { file: "user-settings-notifications.html", golden: userSettingsNotificationsGolden, mainAriaLabel: "Notifications", mainClassTokens: ["user", "settings"], thWithoutScope: 0 },
  { file: "wiki-start.html", golden: wikiStartGolden, mainAriaLabel: "Wiki", mainClassTokens: ["repository", "wiki", "start"], thWithoutScope: 0 },
  { file: "profile-activity.html", golden: profileActivityGolden, mainAriaLabel: "alice", mainClassTokens: ["user", "profile"], thWithoutScope: 0 },
];

describe("wave-129 expansion arms (explicit cases, not the shared table)", () => {
  /** The shared §2.4.1 shell contract every expansion surface inherits. */
  function assertShellArms(golden: string, arm: ExpansionArm): void {
    const root = parseHtmlTree(golden);
    const all = descendants(root);
    const navbar = all.find((el) => el.tag === "nav" && el.attrs.id === "navbar");
    expect(navbar, "nav#navbar present").toBeDefined();
    expect(navbar?.attrs["aria-label"]).toBe("Navigation Bar");
    const mains = all.filter((el) => el.attrs.role === "main");
    expect(mains, "exactly one [role=main]").toHaveLength(1);
    const main = mains[0] ?? root;
    expect(main.attrs["aria-label"]).toBe(arm.mainAriaLabel);
    const tokens = classList(main);
    expect(tokens[0], "the leading page-content token").toBe("page-content");
    expect(tokens.slice(1), "the §2.4.1 page discriminator tokens").toEqual(arm.mainClassTokens);
    const footer = all.find((el) => el.tag === "footer");
    expect(footer, "footer landmark present").toBeDefined();
    expect(footer?.attrs["aria-label"]).toBe("Footer");
  }

  for (const arm of EXPANSION_ARMS) {
    it(`${arm.file}: shell landmarks, the §2.4.1 discriminator, and the declared runA11y state`, () => {
      assertShellArms(arm.golden, arm);
      const violations = runA11y(arm.golden);
      expect(
        violations.filter((v) => v.rule !== "R6-table-headers"),
        `${arm.file}: every non-table rule must stay clean: ${JSON.stringify(violations)}`,
      ).toEqual([]);
      expect(violations.filter((v) => v.rule === "R6-table-headers")).toHaveLength(arm.thWithoutScope);
    });
  }

  it("admin-users: the admin sidebar names every arm (User Accounts active) and the page heading is the Total line", () => {
    const root = parseHtmlTree(adminUsersGolden);
    const nav = descendants(root).find((el) => hasClass(el, "flex-container-nav"));
    expect(nav, "the admin sidebar nav").toBeDefined();
    const items = descendants(nav ?? root).filter((el) => el.tag === "a");
    expect(items.map((el) => accessibleName(el))).toEqual([
      "Dashboard",
      "Organizations",
      "User Accounts",
      "Repositories",
      "Stats",
      "Cron Tasks",
      "Queues",
      "Trace",
    ]);
    const active = items.filter((el) => hasClass(el, "active"));
    expect(active.map((el) => accessibleName(el))).toEqual(["User Accounts"]);
    expect(active[0]?.attrs.href).toBe("/-/admin/users");
    // The page's only heading is the section header carrying the total; a
    // lone heading can neither skip a level (R2) nor double the h1 (R1).
    const headings = descendants(root).filter((el) => /^h[1-6]$/.test(el.tag));
    expect(headings.map((el) => accessibleName(el))).toEqual(["User Account Management (Total: 4)"]);
  });

  it("admin-users: the users table's header cells are named — and all nine carry scope (the closed gap's membership arm)", () => {
    const root = parseHtmlTree(adminUsersGolden);
    const table = descendants(root).find((el) => el.tag === "table");
    expect(table, "the users table").toBeDefined();
    const thead = (table ?? root).children.find((el) => el.tag === "thead");
    expect(thead, "the users table has a thead").toBeDefined();
    const ths = descendants(thead ?? root).filter((el) => el.tag === "th");
    expect(ths.map((el) => accessibleName(el))).toEqual([
      "ID",
      "Username",
      "Email Address",
      "Authentication Source",
      "Activated",
      "Restricted",
      "2FA",
      "Created",
      "Last Sign-In",
    ]);
    // The gap's fix flipped to membership: every header cell now carries
    // scope="col" (the fix landed with the golden regeneration — see the
    // EXPANSION_ARMS note above).
    expect(ths.every((el) => el.attrs.scope === "col"), "every th carries scope=col (the closed gap)").toBe(true);
  });

  it("admin-repos: the admin sidebar names every arm (Repositories active), the ten headers are named and scoped, and the fixture row pins the fixed id", () => {
    const root = parseHtmlTree(adminReposGolden);
    const nav = descendants(root).find((el) => hasClass(el, "flex-container-nav"));
    expect(nav, "the admin sidebar nav").toBeDefined();
    const items = descendants(nav ?? root).filter((el) => el.tag === "a");
    expect(items.map((el) => accessibleName(el))).toEqual([
      "Dashboard",
      "Organizations",
      "User Accounts",
      "Repositories",
      "Stats",
      "Cron Tasks",
      "Queues",
      "Trace",
    ]);
    const active = items.filter((el) => hasClass(el, "active"));
    expect(active.map((el) => accessibleName(el))).toEqual(["Repositories"]);
    expect(active[0]?.attrs.href).toBe("/-/admin/repos");
    // The page's only heading is the section header carrying the FILTERED
    // total (the keyword arm's one matching row — the wave-fixed-id-seed
    // design, goldens.test.ts's block comment).
    const headings = descendants(root).filter((el) => /^h[1-6]$/.test(el.tag));
    expect(headings.map((el) => accessibleName(el))).toEqual(["Repository Management (Total: 1)"]);

    // The repos table: ten header cells, every one named and scope-carrying
    // (five via the text + aria-hidden-svg SortHeader anchors, five plain).
    const table = descendants(root).find((el) => el.tag === "table");
    expect(table, "the repos table").toBeDefined();
    const thead = (table ?? root).children.find((el) => el.tag === "thead");
    expect(thead, "the repos table has a thead").toBeDefined();
    const ths = descendants(thead ?? root).filter((el) => el.tag === "th");
    expect(ths.map((el) => accessibleName(el))).toEqual([
      "ID",
      "Owner",
      "Name",
      "Watchers",
      "Stars",
      "Forks",
      "Issues",
      "Size",
      "Updated",
      "Created",
    ]);
    expect(ths.every((el) => el.attrs.scope === "col"), "every th carries scope=col").toBe(true);

    // The single fixture row (goldens.test.ts's ensureSeededFixedIdRepo
    // seed): the ID cell renders the FIXED uuid verbatim — the R6 gap's
    // whole point — beside the text anchors and the Private label (the
    // fixture is private, so no anonymous-listing golden ever moved).
    const bodyRow = descendants(table ?? root).find((el) => el.tag === "tr" && descendants(el).some((c) => c.tag === "td"));
    expect(bodyRow, "the tbody row").toBeDefined();
    const tds = descendants(bodyRow ?? root).filter((el) => el.tag === "td");
    expect(tds).toHaveLength(10);
    expect(accessibleName(tds[0] ?? ({} as never))).toBe("00000000-0000-4000-8000-000000000001");
    expect(
      tds[1] ? descendants(tds[1]).filter((el) => el.tag === "a").map((el) => [el.attrs.href, accessibleName(el)]) : [],
    ).toEqual([["/morgan", "morgan"]]);
    expect(
      tds[2] ? descendants(tds[2]).filter((el) => el.tag === "a").map((el) => [el.attrs.href, accessibleName(el)]) : [],
    ).toEqual([["/morgan/admin-golden", "admin-golden"]]);
    const labels = tds[2] ? descendants(tds[2]).filter((el) => hasClass(el, "ui") && hasClass(el, "label")) : [];
    expect(labels.map((el) => accessibleName(el))).toEqual(["Private"]);
    // The null-Updated arm renders the empty cell; Created is T0-pinned.
    expect(accessibleName(tds[8] ?? ({} as never))).toBe("");
    expect(accessibleName(tds[9] ?? ({} as never))).toBe("Nov 14, 2023");
  });

  it("admin-monitor-stats: the admin sidebar names every arm (Stats active) and the Summary table is the definition shape the refined R6 exempts", () => {
    const root = parseHtmlTree(adminMonitorStatsGolden);
    const nav = descendants(root).find((el) => hasClass(el, "flex-container-nav"));
    expect(nav, "the admin sidebar nav").toBeDefined();
    const items = descendants(nav ?? root).filter((el) => el.tag === "a");
    expect(items.map((el) => accessibleName(el))).toEqual([
      "Dashboard",
      "Organizations",
      "User Accounts",
      "Repositories",
      "Stats",
      "Cron Tasks",
      "Queues",
      "Trace",
    ]);
    const active = items.filter((el) => hasClass(el, "active"));
    expect(active.map((el) => accessibleName(el))).toEqual(["Stats"]);
    expect(active[0]?.attrs.href).toBe("/-/admin/monitor/stats");
    // The page's only heading is the Summary section header; a lone heading
    // can neither skip a level (R2) nor double the h1 (R1).
    const headings = descendants(root).filter((el) => /^h[1-6]$/.test(el.tag));
    expect(headings.map((el) => accessibleName(el))).toEqual(["Summary"]);

    // The stats table is the definition shape — every row one label td +
    // one value td, no thead, no th — upstream stats.tmpl's thead-less
    // render at the pin. The structural pins below keep the exemption
    // honest: if any row ever grows a third cell (or a th appears), the
    // shape test fails total and the refined rule fires again.
    const tables = descendants(root).filter((el) => el.tag === "table");
    expect(tables, "the Summary table is the page's only table").toHaveLength(1);
    const table = tables[0] ?? root;
    expect(table.children.some((el) => el.tag === "thead"), "no thead (the upstream shape)").toBe(false);
    const rows = descendants(table).filter((el) => el.tag === "tr");
    expect(rows, "the landed-counter key list, sorted (admin.go:287)").toHaveLength(24);
    for (const row of rows) {
      expect(row.children.map((el) => el.tag)).toEqual(["td", "td"]);
    }
    expect(rows.map((row) => accessibleName(row.children[0] ?? root))).toEqual([
      "Attachment",
      "Comment",
      "CommitStatus",
      "Follow",
      "HookTask",
      "Issue",
      "IssueClosed",
      "IssueOpen",
      "Label",
      "Milestone",
      "Mirror",
      "Oauth",
      "Org",
      "Project",
      "ProjectColumn",
      "PublicKey",
      "Release",
      "Repo",
      "Star",
      "Team",
      "UsersActive",
      "UsersNotActive",
      "Watch",
      "Webhook",
    ]);
  });

  it("admin-monitor-queue: the queues table keeps thead+scope, the depths pin the seed states, and the delivery-states segment is the definition shape", () => {
    const root = parseHtmlTree(adminMonitorQueueGolden);
    const nav = descendants(root).find((el) => hasClass(el, "flex-container-nav"));
    expect(nav, "the admin sidebar nav").toBeDefined();
    const items = descendants(nav ?? root).filter((el) => el.tag === "a");
    expect(items.map((el) => accessibleName(el))).toEqual([
      "Dashboard",
      "Organizations",
      "User Accounts",
      "Repositories",
      "Stats",
      "Cron Tasks",
      "Queues",
      "Trace",
    ]);
    const active = items.filter((el) => hasClass(el, "active"));
    expect(active.map((el) => accessibleName(el))).toEqual(["Queues"]);
    expect(active[0]?.attrs.href).toBe("/-/admin/monitor/queue");
    // Two same-level section headers — the R2 walk stays flat.
    const headings = descendants(root).filter((el) => /^h[1-6]$/.test(el.tag));
    expect(headings.map((el) => accessibleName(el))).toEqual(["Queues", "Webhook delivery states"]);

    // The main queues table: upstream queue.tmpl's own shape — thead with
    // every th scoped, three landed-source rows. The depths pin the goldens
    // fixture state (goldens.test.ts's case comment): the hooks seed's
    // pending 1 → webhook-delivery inQueue 1, the mirror seed's idle row →
    // repo-tasks 0, and the DLQ's countable-less `-` arm.
    const tables = descendants(root).filter((el) => el.tag === "table");
    expect(tables, "the queues table + the delivery-states segment").toHaveLength(2);
    const queueTable = tables[0] ?? root;
    const thead = queueTable.children.find((el) => el.tag === "thead");
    expect(thead, "the queues table has a thead").toBeDefined();
    const ths = descendants(thead ?? root).filter((el) => el.tag === "th");
    expect(ths.map((el) => accessibleName(el))).toEqual(["Name", "Type", "Number in Queue"]);
    expect(ths.every((el) => el.attrs.scope === "col"), "every th carries scope=col").toBe(true);
    const queueRows = descendants(queueTable).filter((el) => el.tag === "tr" && el.children.some((c) => c.tag === "td"));
    expect(
      queueRows.map((row) => row.children.map((cell) => accessibleName(cell))),
    ).toEqual([
      ["webhook-delivery", "cloudflare-queue", "1"],
      ["repo-tasks", "cloudflare-queue", "0"],
      ["webhook-delivery-dlq", "cloudflare-queue", "-"],
    ]);

    // The cf-gitea delivery-states segment: the definition shape the refined
    // R6 exempts (no thead, every row exactly label td + value td), over the
    // hooks seed's log — all five schema states in lifecycle order, zeros
    // included (the log's full posture).
    const statesTable = tables[1] ?? root;
    expect(statesTable.children.some((el) => el.tag === "thead"), "no thead (the stats.tmpl idiom)").toBe(false);
    const stateRows = descendants(statesTable).filter((el) => el.tag === "tr");
    expect(stateRows).toHaveLength(5);
    for (const row of stateRows) {
      expect(row.children.map((el) => el.tag)).toEqual(["td", "td"]);
    }
    expect(stateRows.map((row) => row.children.map((cell) => accessibleName(cell)))).toEqual([
      ["pending", "1"],
      ["delivering", "0"],
      ["delivered", "2"],
      ["skipped", "0"],
      ["failed", "0"],
    ]);
  });

  it("user-settings-account: the settings sidebar names every arm (Account active) and the three section headings hold level", () => {
    const root = parseHtmlTree(userSettingsAccountGolden);
    const nav = descendants(root).find((el) => hasClass(el, "flex-container-nav"));
    expect(nav, "the settings sidebar nav").toBeDefined();
    const items = descendants(nav ?? root).filter((el) => el.tag === "a");
    expect(items.map((el) => accessibleName(el))).toEqual([
      "Profile",
      "Account",
      "Notifications",
      "Appearance",
      "Security",
      "Applications",
      "SSH / GPG Keys",
      "Secrets",
      "Variables",
      "Webhooks",
      "Organizations",
      "Repositories",
    ]);
    const active = items.filter((el) => hasClass(el, "active"));
    expect(active.map((el) => accessibleName(el))).toEqual(["Account"]);
    expect(active[0]?.attrs.href).toBe("/user/settings/account");
    // The Password / Email / Delete sections are same-level h4s — the R2
    // walk stays flat (asserted element-level so a later h2/h3 mix is a
    // deliberate review here, not a silent smoke pass).
    const headings = descendants(root).filter((el) => /^h[1-6]$/.test(el.tag));
    expect(headings.map((el) => [el.tag, accessibleName(el)])).toEqual([
      ["h4", "Password"],
      ["h4", "Manage Email Addresses"],
      ["h4", "Delete Your Account"],
    ]);
  });

  it("profile-watching: the profile tab strip marks Watched Repositories active, and the avatar card + the single watched-repo row render", () => {
    const root = parseHtmlTree(profileWatchingGolden);
    // The signed-in self-view strip: three arms (the anonymous Starred arm is
    // not offered on the watching tab), the ?tab=watching arm active. Names
    // are the walker's exact accessible names — the count label joins its
    // anchor text with no separator ("Repositories3").
    const strip = descendants(root).find((el) => el.tag === "overflow-menu");
    expect(strip, "the profile tab strip").toBeDefined();
    const tabs = descendants(strip ?? root).filter((el) => el.tag === "a");
    expect(tabs.map((el) => [el.attrs.href, hasClass(el, "active"), accessibleName(el)])).toEqual([
      ["/alice?tab=repositories", false, "Repositories3"],
      ["/alice?tab=activity", false, "Public Activity"],
      ["/alice?tab=watching", true, "Watched Repositories"],
    ]);
    // The user header: the avatar card renders (the profile page's identity
    // block), and the shared repo list's single row names the one watched
    // repo — the wave-9 dashboard fixture's cross-owner acme/anvil watch.
    expect(getElementById(root, "profile-avatar-card")).not.toBeNull();
    const titles = descendants(root).filter((el) => hasClass(el, "item-title"));
    expect(
      titles.flatMap((el) => descendants(el).filter((inner) => inner.tag === "a").map((a) => [a.attrs.href, accessibleName(a)])),
    ).toEqual([["/acme/anvil", "anvil"]]);
  });

  it("milestone-detail: the repo header breadcrumb names owner and repo, the h1 is the milestone title, and the repo tab strip names every tab (Code active)", () => {
    const root = parseHtmlTree(milestoneDetailGolden);
    const header = descendants(root).find((el) => hasClass(el, "repo-header"));
    expect(header, "the repo header").toBeDefined();
    expect(descendants(header ?? root).filter((el) => el.tag === "a").map((el) => [el.attrs.href, accessibleName(el)])).toEqual([
      ["/alice", "alice"],
      ["/alice/golden-ms", "golden-ms"],
    ]);
    // The page's single heading is the milestone title (R1's exactly-one
    // holds here like home's README h1).
    const headings = descendants(root).filter((el) => /^h[1-6]$/.test(el.tag));
    expect(headings.map((el) => accessibleName(el))).toEqual(["v1.0"]);
    // The canWrite arm's controls are named (signed-in owner golden).
    expect(descendants(root).filter((el) => el.tag === "a").filter((el) => hasClass(el, "button")).map((el) => accessibleName(el))).toEqual([
      "Edit",
      "New Issue",
    ]);
    const strip = descendants(root).find((el) => el.tag === "overflow-menu");
    expect(strip, "the repo tab strip").toBeDefined();
    expect(descendants(strip ?? root).filter((el) => el.tag === "a").map((el) => [hasClass(el, "active"), accessibleName(el)])).toEqual([
      [true, "Code"],
      [false, "Issues1"],
      [false, "Pull Requests"],
      [false, "Releases"],
      [false, "Commits"],
    ]);
  });

  // ---------------------------------------------------------------------------
  // wave-goldens-final surface arms (the EXPANSION_ARMS note above holds the
  // first-sight verdicts; the selection audit lives in goldens.test.ts).
  // ---------------------------------------------------------------------------

  it("user-settings-repos: the settings sidebar names every arm (Repositories active) and the list pins alice's three rows with sizes", () => {
    const root = parseHtmlTree(userSettingsReposGolden);
    const nav = descendants(root).find((el) => hasClass(el, "flex-container-nav"));
    expect(nav, "the settings sidebar nav").toBeDefined();
    const items = descendants(nav ?? root).filter((el) => el.tag === "a");
    expect(items.map((el) => accessibleName(el))).toEqual([
      "Profile",
      "Account",
      "Notifications",
      "Appearance",
      "Security",
      "Applications",
      "SSH / GPG Keys",
      "Secrets",
      "Variables",
      "Webhooks",
      "Organizations",
      "Repositories",
    ]);
    const active = items.filter((el) => hasClass(el, "active"));
    expect(active.map((el) => accessibleName(el))).toEqual(["Repositories"]);
    expect(active[0]?.attrs.href).toBe("/user/settings/repos");
    // The page's only heading is the section header (a lone heading can
    // neither skip a level (R2) nor double the h1 (R1)).
    const headings = descendants(root).filter((el) => /^h[1-6]$/.test(el.tag));
    expect(headings.map((el) => accessibleName(el))).toEqual(["Repositories"]);
    // The list: alice's three owned rows, slug ASC (the landed order) —
    // each the kind icon (public → octicon-repo, aria-hidden), the
    // Owner/Name anchor and the FormatByteSize size span (the settled KiB
    // column times 1024: golden 8 KiB, the two single-commit seeds 1 KiB).
    const list = descendants(root).find((el) => hasClass(el, "ui") && hasClass(el, "list"));
    expect(list, "the repos list").toBeDefined();
    const rows = descendants(list ?? root).filter((el) => hasClass(el, "flex-text-block"));
    expect(rows).toHaveLength(3);
    expect(
      rows.flatMap((row) => descendants(row).filter((el) => el.tag === "a" && hasClass(el, "name")).map((a) => [a.attrs.href, accessibleName(a)])),
    ).toEqual([
      ["/alice/golden", "alice/golden"],
      ["/alice/golden-alt", "alice/golden-alt"],
      ["/alice/golden-ms", "alice/golden-ms"],
    ]);
    expect(rows.flatMap((row) => descendants(row).filter((el) => el.tag === "span").map((s) => accessibleName(s)))).toEqual([
      "8.0 kiB",
      "1.0 kiB",
      "1.0 kiB",
    ]);
    expect(rows.flatMap((row) => descendants(row).filter((el) => el.tag === "svg").map((s) => s.attrs.class))).toEqual([
      "svg octicon-repo",
      "svg octicon-repo",
      "svg octicon-repo",
    ]);
  });

  it("user-settings-notifications: the sidebar marks Notifications active, the two forms' selects pin the creation defaults, and both submit buttons are named", () => {
    const root = parseHtmlTree(userSettingsNotificationsGolden);
    const nav = descendants(root).find((el) => hasClass(el, "flex-container-nav"));
    expect(nav, "the settings sidebar nav").toBeDefined();
    const items = descendants(nav ?? root).filter((el) => el.tag === "a");
    const active = items.filter((el) => hasClass(el, "active"));
    expect(active.map((el) => accessibleName(el))).toEqual(["Notifications"]);
    expect(active[0]?.attrs.href).toBe("/user/settings/notifications");
    // Two same-level section headers — the R2 walk stays flat.
    const headings = descendants(root).filter((el) => /^h[1-6]$/.test(el.tag));
    expect(headings.map((el) => accessibleName(el))).toEqual(["Notifications", "Actions"]);
    // The two forms (the navbar's /logout form exists too on signed-in
    // pages — filtered out here): the email POST and the actions POST, each
    // carrying one native select whose SELECTED option pins the absent-row
    // creation defaults ('enabled' / 'failure-only' — the side store's
    // defaults), plus one submit button each.
    const forms = descendants(root).filter((el) => el.tag === "form" && (el.attrs.action ?? "").startsWith("/user/settings/notifications"));
    expect(forms.map((f) => f.attrs.action)).toEqual(["/user/settings/notifications/email", "/user/settings/notifications/actions"]);
    const selects = descendants(root).filter((el) => el.tag === "select" && el.attrs.name === "preference");
    expect(selects).toHaveLength(2);
    expect(
      selects.map((sel) =>
        descendants(sel)
          .filter((el) => el.tag === "option" && el.attrs.selected !== undefined)
          .map((o) => o.attrs.value),
      ),
    ).toEqual([["enabled"], ["failure-only"]]);
    const submits = forms.flatMap((f) => descendants(f).filter((el) => el.tag === "button" && el.attrs.type === "submit"));
    expect(submits.map((b) => accessibleName(b))).toEqual(["Set Email Preference", "Set Email Preference"]);
    // The actions description's literal external docs anchor is named by its
    // text (the appearance-module GitHub-link pattern).
    const external = descendants(root).filter((el) => el.tag === "a" && (el.attrs.href ?? "").startsWith("https://docs.gitea.com/usage"));
    expect(external.map((a) => accessibleName(a))).toEqual(["Gitea Actions"]);
  });

  it("wiki-start: the repo chrome renders the start arm — breadcrumb, tab strip (Code active), the welcome h2 and the writer's create button", () => {
    const root = parseHtmlTree(wikiStartGolden);
    // The repo header breadcrumb names owner and repo.
    const header = descendants(root).find((el) => hasClass(el, "repo-header"));
    expect(header, "the repo header").toBeDefined();
    expect(descendants(header ?? root).filter((el) => el.tag === "a").map((el) => [el.attrs.href, accessibleName(el)])).toEqual([
      ["/alice", "alice"],
      ["/alice/golden", "golden"],
    ]);
    // The start segment: the single heading (h2, no h1 on the page — R1's
    // at-most-one holds) plus the welcome line.
    const headings = descendants(root).filter((el) => /^h[1-6]$/.test(el.tag));
    expect(headings.map((el) => accessibleName(el))).toEqual(["Welcome to the Wiki."]);
    // The signed-in owner arm: the writer-gated Create-the-First-Page button.
    expect(
      descendants(root)
        .filter((el) => el.tag === "a" && hasClass(el, "button"))
        .map((el) => [el.attrs.href, accessibleName(el)]),
    ).toEqual([["/alice/golden/wiki?action=_new", "Create the First Page"]]);
    // The repo tab strip names every tab with its count (Code active) —
    // golden's counts (2 open issues, 1 PR) differ from milestone-detail's
    // golden-ms strip.
    const strip = descendants(root).find((el) => el.tag === "overflow-menu");
    expect(strip, "the repo tab strip").toBeDefined();
    expect(descendants(strip ?? root).filter((el) => el.tag === "a").map((el) => [hasClass(el, "active"), accessibleName(el)])).toEqual([
      [true, "Code"],
      [false, "Issues2"],
      [false, "Pull Requests1"],
      [false, "Releases"],
      [false, "Commits"],
    ]);
  });

  it("profile-activity: the overview strip marks Public Activity active, the avatar card renders, and the three create-repo rows carry the pinned epoch", () => {
    const root = parseHtmlTree(profileActivityGolden);
    // The signed-in self-view strip: four arms, the ?tab=activity arm active.
    // Names are the walker's exact accessible names — the count label joins
    // its anchor text with no separator ("Repositories3").
    const strip = descendants(root).find((el) => el.tag === "overflow-menu");
    expect(strip, "the profile tab strip").toBeDefined();
    const tabs = descendants(strip ?? root).filter((el) => el.tag === "a");
    expect(tabs.map((el) => [el.attrs.href, hasClass(el, "active"), accessibleName(el)])).toEqual([
      ["/alice?tab=repositories", false, "Repositories3"],
      ["/alice?tab=activity", true, "Public Activity"],
      ["/alice?tab=stars", false, "Starred Repositories"],
      ["/alice?tab=watching", false, "Watched Repositories"],
    ]);
    // The user header: the avatar card renders; the feed carries the seeds'
    // three create-repo rows (the ONLY alice-performed action rows — the
    // issue family records no actions), newest-id first under the equal
    // pinned stamps.
    expect(getElementById(root, "profile-avatar-card")).not.toBeNull();
    const feed = getElementById(root, "activity-feed");
    expect(feed, "the feed container").not.toBeNull();
    const items = descendants(feed ?? root).filter((el) => hasClass(el, "item-main"));
    expect(items).toHaveLength(3);
    expect(
      items.flatMap((item) =>
        descendants(item)
          .filter((el) => el.tag === "a" && (el.attrs.title ?? "") === "")
          .map((a) => [a.attrs.href, accessibleName(a)]),
      ),
    ).toEqual([
      ["/alice", "alice"],
      ["/alice/golden-ms", "alice/golden-ms"],
      ["/alice", "alice"],
      ["/alice/golden-alt", "alice/golden-alt"],
      ["/alice", "alice"],
      ["/alice/golden", "alice/golden"],
    ]);
    // The createdAt pin (goldens.test.ts's beforeAll): every row's TimeSince
    // renders the fixed epoch, not the seed run's wall clock.
    const stamps = descendants(feed ?? root).filter((el) => el.tag === "relative-time");
    expect(stamps).toHaveLength(3);
    for (const stamp of stamps) {
      expect(stamp.attrs.datetime).toBe("2023-11-14T22:13:20Z");
    }
  });
});

// --- walker unit pins -------------------------------------------------------------

describe("a11y walker pins", () => {
  it("reads accessible names: text, aria-label precedence, aria-hidden exclusion", () => {
    expect(accessibleName(parseHtmlTree('<a href="/x">Label</a>').children[0] ?? ({} as never))).toBe("Label");
    expect(
      accessibleName(parseHtmlTree('<a href="/x"><span aria-hidden="true">icon</span>Label</a>').children[0] ?? ({} as never)),
    ).toBe("Label");
    expect(accessibleName(parseHtmlTree('<a href="/x" aria-label="Buy">no text</a>').children[0] ?? ({} as never))).toBe("Buy");
    // A hidden anchor is skipped by R5 (runA11y), and a VISIBLE-only child
    // still names its anchor when a sibling is hidden.
    expect(
      runA11y('<html><body><a href="/x" aria-hidden="true"><svg/></a></body></html>').filter((v) => v.rule === "R5-link-name"),
    ).toEqual([]);
    expect(runA11y('<html><body><a href="/x"><span aria-hidden="true">i</span></a></body></html>').map((v) => v.rule)).toContain(
      "R5-link-name",
    );
  });

  it("treats script/style bodies as raw text (config JSON, error collector, hostile <)", () => {
    const violations = runA11y(
      '<html><body><script>if (a < b && "</div>".length) x();</script><style>a > b { color: red }</style>' +
        '<img src="/i.png"><a href="/x">ok</a></body></html>',
    );
    // The stray < inside the script body did not derail the walk: the img is
    // still found (R4) and the anchor still has its name (no R5). (Landmark
    // violations are expected on this synthetic snippet and not asserted.)
    expect(violations.filter((v) => v.rule !== "R3-landmarks").map((v) => v.rule)).toEqual(["R4-img-alt"]);
  });

  it("keeps quoted `>` inside attribute values and parses self-closing/void tags", () => {
    const root = parseHtmlTree('<div><a title="a > b" href="/x" >t</a><img src="/y.png" alt="y"/><br/></div>');
    const anchor = root.children[0]?.children[0];
    expect(anchor?.attrs.title).toBe("a > b");
    expect(anchor?.attrs.href).toBe("/x");
    expect(root.children[0]?.children.map((el) => el.tag)).toEqual(["a", "img", "br"]);
  });

  it("flags upward heading skips, not downward returns", () => {
    const skip = runA11y("<html><body><h1>a</h1><h3>b</h3></body></html>");
    expect(skip.filter((v) => v.rule === "R2-no-skip").map((v) => `${v.rule} ${v.detail}`)).toEqual([
      "R2-no-skip <h1> followed by <h3>",
    ]);
    expect(runA11y("<html><body><h3>a</h3><h1>b</h1></body></html>").some((v) => v.rule === "R2-no-skip")).toBe(false);
  });

  it("enforces the landmark triad", () => {
    expect(runA11y("<html><body><p>nothing</p></body></html>").filter((v) => v.rule === "R3-landmarks")).toHaveLength(3);
    expect(
      runA11y(
        '<html><body><nav id="navbar" aria-label="n"></nav><div role="main" aria-label="m"></div><footer></footer></body></html>',
      ),
    ).toEqual([]);
  });

  it("requires thead + explicit scope on real tables, exempting the code-view line table", () => {
    const noScope = runA11y("<html><body><table><thead><tr><th>a</th></tr></thead></table></body></html>");
    expect(noScope.filter((v) => v.rule === "R6-table-headers")).toHaveLength(1);
    expect(
      runA11y('<html><body><table><thead><tr><th scope="col">a</th></tr></thead></table></body></html>').some(
        (v) => v.rule === "R6-table-headers",
      ),
    ).toBe(false);
    // A thead-less table outside the exemption is a violation…
    const headerless = runA11y("<html><body><table><tbody><tr><td>a</td></tr></tbody></table></body></html>");
    expect(headerless.filter((v) => v.rule === "R6-table-headers")).toHaveLength(1);
    // …while the code-view line table (presentational, upstream shape) is not.
    const codeView = runA11y(
      '<html><body><div class="file-view code-view"><table><tbody><tr><td class="lines-num">1</td></tr></tbody></table></div></body></html>',
    );
    expect(codeView.filter((v) => v.rule === "R6-table-headers")).toEqual([]);
    // The wave-5 diff line table (presentational, same shape) is exempt too.
    const codeDiff = runA11y(
      '<html><body><div class="file-body file-code code-diff code-diff-unified"><table><tbody><tr class="add-code"><td class="lines-num"></td></tr></tbody></table></div></body></html>',
    );
    expect(codeDiff.filter((v) => v.rule === "R6-table-headers")).toEqual([]);
    // The wave-theadless-policy refinement: the DEFINITION-SHAPE table (every
    // row exactly one label td + one value td, no th, at least one row) is
    // exempt — upstream renders key/value tables thead-less BY DESIGN at the
    // pin (stats.tmpl's key/count rows; dashboard.tmpl's label/run-button
    // rows; a11y.ts's header comment holds the policy call).
    const definitionShape = runA11y(
      "<html><body><table><tbody><tr><td>Attachment</td><td>1</td></tr><tr><td>Comment</td><td>4</td></tr></tbody></table></body></html>",
    );
    expect(definitionShape.filter((v) => v.rule === "R6-table-headers")).toEqual([]);
    // The shape test is total — every OTHER thead-less shape still fires:
    // a three-cell row is a records×columns grid without headers…
    const threeCells = runA11y("<html><body><table><tbody><tr><td>a</td><td>b</td><td>c</td></tr></tbody></table></body></html>");
    expect(threeCells.filter((v) => v.rule === "R6-table-headers")).toHaveLength(1);
    // …a th anywhere means a scoppable header dimension that lost its thead…
    const strayTh = runA11y("<html><body><table><tbody><tr><th>a</th><td>b</td></tr></tbody></table></body></html>");
    expect(strayTh.filter((v) => v.rule === "R6-table-headers")).toHaveLength(1);
    // …and the vacuous zero-row match must not exempt an empty broken table.
    const zeroRows = runA11y("<html><body><table><tbody></tbody></table></body></html>");
    expect(zeroRows.filter((v) => v.rule === "R6-table-headers")).toHaveLength(1);
  });

  it("counts h1 and tolerates entity-bearing text", () => {
    const two = runA11y("<html><body><h1>a</h1><h1>b &amp; c</h1></body></html>");
    expect(two.filter((v) => v.rule === "R1-single-h1")).toHaveLength(1);
  });
});
