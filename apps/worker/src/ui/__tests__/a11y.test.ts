/**
 * §5.5 accessibility smoke over the committed goldens (no browser), plus
 * unit pins for the hand-rolled walker (a11y.ts) so the smoke itself cannot
 * silently mis-parse. Runs purely on the committed bytes — no seeding, no
 * engine, no rendering.
 */

import { describe, expect, it } from "vitest";

import { accessibleName, descendants, getElementById, parseHtmlTree, runA11y } from "./a11y";
import bareShellGolden from "./goldens/bare-shell.html?raw";
import commitsGolden from "./goldens/commits.html?raw";
import compareCommitsGolden from "./goldens/compare-commits.html?raw";
import compareFormGolden from "./goldens/compare-form.html?raw";
import compareHasPrGolden from "./goldens/compare-has-pr.html?raw";
import compareNothingGolden from "./goldens/compare-nothing.html?raw";
import dashboardGolden from "./goldens/dashboard.html?raw";
import exploreReposGolden from "./goldens/explore-repos.html?raw";
import exploreUsersGolden from "./goldens/explore-users.html?raw";
import fileViewCodeGolden from "./goldens/file-view-code.html?raw";
import homeGolden from "./goldens/home.html?raw";
import issueDetailGolden from "./goldens/issue-detail.html?raw";
import issuesClosedGolden from "./goldens/issues-closed.html?raw";
import issuesOpenGolden from "./goldens/issues-open.html?raw";
import landingGolden from "./goldens/landing.html?raw";
import milestonesClosedGolden from "./goldens/milestones-closed.html?raw";
import milestonesOpenGolden from "./goldens/milestones-open.html?raw";
import notFoundRepoGolden from "./goldens/not-found-repo.html?raw";
import orgTeamDetailGolden from "./goldens/org-team-detail.html?raw";
import orgTeamsGolden from "./goldens/org-teams.html?raw";
import notificationsReadGolden from "./goldens/notifications-read.html?raw";
import notificationsUnreadGolden from "./goldens/notifications-unread.html?raw";
import orgHomeEmptyGolden from "./goldens/org-home-empty.html?raw";
import orgHomeGolden from "./goldens/org-home.html?raw";
import pullDetailGolden from "./goldens/pull-detail.html?raw";
import pullFilesGolden from "./goldens/pull-files.html?raw";
import pullReviewSignedInGolden from "./goldens/pull-review-signed-in.html?raw";
import pullsOpenGolden from "./goldens/pulls-open.html?raw";
import settingsMirrorGolden from "./goldens/settings-mirror.html?raw";
import treeDirGolden from "./goldens/tree-dir.html?raw";
import userProfileGolden from "./goldens/user-profile.html?raw";
import userSettingsProfileGolden from "./goldens/user-settings-profile.html?raw";
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
  "org-home.html": orgHomeGolden,
  "org-home-empty.html": orgHomeEmptyGolden,
  "user-profile.html": userProfileGolden,
  "milestones-open.html": milestonesOpenGolden,
  "milestones-closed.html": milestonesClosedGolden,
  "not-found-repo.html": notFoundRepoGolden,
  "bare-shell.html": bareShellGolden,
  "landing.html": landingGolden,
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
  // Pages wave 13: the compare family (the plain comparison, the writer's
  // new-PR form view, the has-PR pair, the same-tip tag state).
  "compare-commits.html": compareCommitsGolden,
  "compare-form.html": compareFormGolden,
  "compare-has-pr.html": compareHasPrGolden,
  "compare-nothing.html": compareNothingGolden,
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
  });

  it("counts h1 and tolerates entity-bearing text", () => {
    const two = runA11y("<html><body><h1>a</h1><h1>b &amp; c</h1></body></html>");
    expect(two.filter((v) => v.rule === "R1-single-h1")).toHaveLength(1);
  });
});
