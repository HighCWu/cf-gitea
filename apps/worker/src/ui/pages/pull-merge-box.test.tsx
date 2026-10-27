/**
 * The pull merge box fragment module's tests (bench tick-10 row 4, the
 * UNMOUNTED `GET /{owner}/{repo}/pulls/{index}/merge_box` module): the
 * loader's state→projection matrix over REAL D1 rows (the landed merge
 * state — `pull_requests` status/conflicts/divergence, the
 * branch-protection rule config, stored commit statuses, official review
 * rows) and the fragment's DOM contract against the pinned
 * pull_merge_box.tmpl arm-for-arm. Real D1 via the vitest plugin (generated
 * migrations in beforeAll); the loader + builder driven DIRECTLY (the route
 * arm is index-owned — the HANDOFF NOTE in the module header).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createCommitStatus } from "../../api/services/commit-status";
import { findPullRequestByIndex } from "../../api/services/pulls";
import {
  PRFlow,
  PRStatus,
  protectedBranches,
  pullRequests,
  pullReviews,
  repositories,
  ReviewType,
  users,
} from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { emptyRuleConfig, serializeRuleConfig } from "../../services/branch-protection";
import { RepoService } from "../../repos/service";
import type { RepoRow } from "../ui-context";
import {
  loadPullMergeBoxData,
  pullMergeBoxFragmentHtml,
  pullMergeBoxFragmentResponse,
  shellEscape,
  type PullMergeBoxData,
} from "./pull-merge-box";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";

const alice = { kind: "user", id: 101, username: "alice", isAdmin: false } as const;
const bob = { kind: "user", id: 102, username: "bob", isAdmin: false } as const;
const anonymous = { kind: "anonymous" } as const;

let plainRepoId = "";
let gatedRepoId = "";
let db: ReturnType<typeof drizzle> | null = null;
const prIds: Record<string, number> = {};
const issueIds: Record<string, number> = {};
/** Every fixture PR's repo — the protection rule lives ONLY on the gated
 *  repo so the plain-repo arms render rule-free. */
const prRepo: Record<string, string> = {};
const repoOf = (name: string): string => prRepo[name]!;

function d1(): ReturnType<typeof drizzle> {
  if (db === null) throw new Error("beforeAll has not run");
  return db;
}

/** Create one PR through the landed service (status starts `checking`), then
 *  stamp the extension row with the test's state. */
async function seedPr(
  name: string,
  input: {
    title: string;
    headBranch: string;
    headRepoId?: string;
    flow?: (typeof PRFlow)[keyof typeof PRFlow];
    posterId?: number;
    /** matrix-4: a non-default base targets a DIFFERENT protection rule
     *  (findRule(d1, repoId, pr.baseBranch)); the loader reads the row, never
     *  the engine, so the branch need not exist in git. */
    baseBranch?: string;
  },
  state: Partial<{ status: number; conflictedFiles: string | null; commitsBehind: number; headSha: string | null }>,
  repoId: string = plainRepoId,
): Promise<void> {
  const service = new IssuesService(env.DB);
  const { issue, pullRequest } = await service.createPullRequest({
    repoId,
    title: input.title,
    posterId: input.posterId ?? bob.id,
    headRepoId: input.headRepoId ?? repoId,
    baseBranch: input.baseBranch ?? "main",
    headBranch: input.headBranch,
    flow: input.flow,
    now: new Date((T0 + 60) * 1000),
  });
  prIds[name] = pullRequest.id;
  issueIds[name] = issue.id;
  prRepo[name] = repoId;
  await d1()
    .update(pullRequests)
    .set({
      status: state.status ?? PRStatus.Mergeable,
      conflictedFiles: state.conflictedFiles ?? null,
      commitsBehind: state.commitsBehind ?? 0,
      headSha: state.headSha ?? null,
    })
    .where(eq(pullRequests.id, pullRequest.id));
}

beforeAll(async () => {
  await applyAuthD1Migrations();
  db = drizzle(env.DB);
  await db.insert(users).values([
    // Explicit high ids — the migrations seed ids 1 ('assets') and -3.
    { id: alice.id, username: "alice", usernameLower: "alice", displayName: "Alice Doe", createdAt: new Date(T0 * 1000) },
    { id: bob.id, username: "bob", usernameLower: "bob", displayName: "Bob Banner", createdAt: new Date(T0 * 1000) },
  ]);
  const repo = await new RepoService(env.DB).create({
    owner: { id: alice.id, usernameLower: "alice" },
    name: "mergetest",
    isPrivate: false,
    status: "ready",
  });
  plainRepoId = repo.id;
  // The gated twin: the protection rule lives ONLY here (a rule on the plain
  // repo's main would reach every fixture PR — the loader ports upstream's
  // rule-first blocker computation).
  const gated = await new RepoService(env.DB).create({
    owner: { id: alice.id, usernameLower: "alice" },
    name: "gated",
    isPrivate: false,
    status: "ready",
  });
  gatedRepoId = gated.id;
  // The fork head's repo (bob's copy) for the fork-instruction arm.
  const fork = await new RepoService(env.DB).create({
    owner: { id: bob.id, usernameLower: "bob" },
    name: "forky",
    isPrivate: false,
    status: "ready",
  });

  // Open mergeable, same-repo: the can-auto-merge prompt + commands.
  await seedPr("mergeable", { title: "feat: mergeable", headBranch: "feature" }, { status: PRStatus.Mergeable });
  // Conflicted with 12 listed files: the 10-cap + "..." reduction.
  const twelve = JSON.stringify(Array.from({ length: 12 }, (_v, i) => `dir/file-${i + 1}.ts`));
  await seedPr("conflict", { title: "fix: conflict", headBranch: "conflicted" }, { status: PRStatus.Conflict, conflictedFiles: twelve });
  // Checking: the reload attrs + the spinner blocker.
  await seedPr("checking", { title: "chore: checking", headBranch: "checking" }, { status: PRStatus.Checking });
  // Closed-unmerged: the ClosedInfo arm INSTEAD of every section.
  await seedPr("closed", { title: "docs: closed", headBranch: "closed" }, { status: PRStatus.Mergeable });
  await new IssuesService(env.DB).closeIssue(issueIds.closed!, { actorId: alice.id, now: new Date((T0 + 120) * 1000) });
  // WIP title: the work-in-progress line + the normal icon color.
  await seedPr("wip", { title: "WIP: experiment", headBranch: "wip" }, { status: PRStatus.Mergeable });
  // Ancestor / Empty / Error: one blocker item each.
  await seedPr("ancestor", { title: "misc: ancestor", headBranch: "ancestor" }, { status: PRStatus.Ancestor });
  await seedPr("empty", { title: "misc: empty", headBranch: "empty" }, { status: PRStatus.Empty });
  await seedPr("error", { title: "misc: error", headBranch: "error" }, { status: PRStatus.Error });
  // Merged: no box at all.
  await seedPr("merged", { title: "misc: merged", headBranch: "merged" }, { status: PRStatus.Mergeable });
  await db
    .update(pullRequests)
    .set({ hasMerged: true, mergedCommitId: "f".repeat(40), mergerId: alice.id })
    .where(eq(pullRequests.id, prIds.merged!));
  // Broken (head repo row gone): the data_broken blocker, no instructions.
  await seedPr("broken", { title: "misc: broken", headBranch: "broken", headRepoId: "repo-gone" }, { status: PRStatus.Mergeable });
  // Fork head: the {owner}- prefixed local branch + the fork fetch URL.
  await seedPr("fork", { title: "feat: fork", headBranch: "feature", headRepoId: fork.id }, { status: PRStatus.Mergeable });
  // AGit flow: the refs/pull fetch line.
  await seedPr("agit", { title: "misc: agit", headBranch: "agit-branch", flow: PRFlow.AGit }, { status: PRStatus.Mergeable });
  // Status checks: rule + stored statuses on the head sha — on the GATED repo.
  await seedPr("statuses", { title: "ci: gated", headBranch: "ci-gated" }, { status: PRStatus.Mergeable, headSha: "a".repeat(40) }, gatedRepoId);
  await db.insert(protectedBranches).values({
    repoId: gatedRepoId,
    ruleName: "main",
    priority: 0,
    rules: serializeRuleConfig({
      ...emptyRuleConfig(),
      enableStatusCheck: true,
      statusCheckContexts: ["ci/build", "ci/deploy", "deploy/*"],
      requiredApprovals: 2,
    }),
    createdAt: new Date(T0 * 1000),
    updatedAt: new Date(T0 * 1000),
  });
  await createCommitStatus(env.DB, {
    repoId: gatedRepoId,
    sha: "a".repeat(40),
    state: "success",
    targetUrl: "https://ci.example.com/build/1",
    description: "build ok",
    context: "ci/build",
    creatorId: alice.id,
  });
  await createCommitStatus(env.DB, {
    repoId: gatedRepoId,
    sha: "a".repeat(40),
    state: "success",
    targetUrl: "",
    description: "shipped",
    context: "deploy/ship", // matches the deploy/* glob → required
    creatorId: alice.id,
  });
  await createCommitStatus(env.DB, {
    repoId: gatedRepoId,
    sha: "a".repeat(40),
    state: "failure",
    targetUrl: "",
    description: "lint failed",
    context: "extra/optional", // no rule context → optional
    creatorId: alice.id,
  });
  // One official approval (of the 2 required) on the gated PR.
  await db.insert(pullReviews).values({
    type: ReviewType.Approve,
    reviewerId: alice.id,
    issueId: issueIds.statuses!,
    official: true,
    createdAt: new Date(T0 * 1000),
    updatedAt: new Date(T0 * 1000),
  });
});

// --- helpers -----------------------------------------------------------------

const repoRowCache = new Map<string, RepoRow>();
async function repoRow(id: string): Promise<RepoRow> {
  let row = repoRowCache.get(id);
  if (row === undefined) {
    const rows = await d1().select().from(repositories).where(eq(repositories.id, id)).all();
    row = rows[0]!;
    repoRowCache.set(id, row);
  }
  return row;
}

async function indexPr(name: string): Promise<number> {
  const rows = await d1().select().from(pullRequests).where(eq(pullRequests.id, prIds[name]!)).all();
  return rows[0]!.index;
}

/** Load + project one fixture PR (fresh rows — the seed's updates landed). */
async function load(
  name: string,
  viewer: typeof alice | typeof bob | typeof anonymous = alice,
): Promise<PullMergeBoxData | null> {
  const found = await findPullRequestByIndex(env.DB, repoOf(name), await indexPr(name));
  if (found === null) throw new Error(`fixture ${name} missing`);
  return loadPullMergeBoxData(env.DB, {
    repo: await repoRow(repoOf(name)),
    issue: found.issue,
    pr: found.pullRequest,
    viewer,
    origin: ORIGIN,
  });
}

/** The loader's two collections by index — [commit-blockers XOR protection-
 *  blockers, merge-prompts] (the render skips EMPTY sections itself). */
function sectionOf(data: PullMergeBoxData, section: 0 | 1) {
  return data.infoSections[section] ?? [];
}

// --- the loader projections ----------------------------------------------------

describe("loadPullMergeBoxData projections", () => {
  it("nulls the non-pull rows and the merged PR", async () => {
    const service = new IssuesService(env.DB);
    const plain = await service.createIssue({ repoId: plainRepoId, title: "plain issue", posterId: bob.id, now: new Date(T0 * 1000) });
    // The PR row is unread for non-pull issues (the isPull gate fires first) —
    // any landed row rides along.
    const anyPr = (await findPullRequestByIndex(env.DB, plainRepoId, await indexPr("mergeable")))!.pullRequest;
    expect(
      await loadPullMergeBoxData(env.DB, {
        repo: await repoRow(plainRepoId),
        issue: plain,
        pr: anyPr,
        viewer: alice,
        origin: ORIGIN,
      }),
    ).toBeNull();
    expect(await load("merged")).toBeNull();
  });

  it("projects the open mergeable PR: green icon, auto-merge prompt, same-repo commands", async () => {
    const data = await load("mergeable");
    expect(data).not.toBeNull();
    expect(data!.reloadingInterval).toBe(0);
    expect(data!.issueLink).toBe("/alice/mergetest/pulls/1");
    expect(data!.timelineIconClass).toBe("tw-text-green");
    expect(data!.closedInfo).toBeNull();
    // Section 1 = the merge prompts (commit/protection blockers empty).
    const prompts = sectionOf(data!, 1);
    expect(prompts.map((item) => item.info)).toContain("This pull request can be merged automatically.");
    expect(prompts[0]!.icon).toBe("octicon-check");
    // The command instructions: same-repo fetch from origin + the six merge
    // styles + the push line + the autodetect warning.
    expect(data!.commands).not.toBeNull();
    expect(data!.commands!.checkoutLines).toEqual(["git fetch -u origin feature:feature", "git checkout feature"]);
    expect(data!.commands!.mergeBlocks.map((block) => block.style)).toEqual([
      "merge",
      "rebase",
      "rebase-merge",
      "squash",
      "fast-forward-only",
      "manually-merged",
    ]);
    expect(data!.commands!.mergeBlocks[0]!.hidden).toBe(false);
    expect(data!.commands!.mergeBlocks[1]!.hidden).toBe(true);
    expect(data!.commands!.mergePushLine).toBe("git push origin main");
    expect(data!.commands!.showMergeWarning).toBe(true);
    expect(data!.statusChecks).toBeNull();
  });

  it("withholds the merge grant from a non-write viewer (no_merge_access item)", async () => {
    const data = await load("mergeable", bob);
    // The protection-blocker section carries the access note; the merge
    // prompt still renders (upstream's canMergeNow ignores the grant).
    const blockers = sectionOf(data!, 0);
    expect(blockers.map((item) => item.info)).toContain("You are not authorized to merge this pull request.");
    expect(blockers[0]!.icon).toBe("octicon-info");
    expect(sectionOf(data!, 1).map((item) => item.info)).toContain("This pull request can be merged automatically.");
    // Anonymous — same zero-access shape.
    const anon = await load("mergeable", anonymous);
    expect(sectionOf(anon!, 0).map((item) => item.info)).toContain("You are not authorized to merge this pull request.");
  });

  it("caps the conflicted file list at ten plus '...'", async () => {
    const data = await load("conflict");
    const blockers = sectionOf(data!, 0);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.info).toBe("This pull request has changes conflicting with the target branch.");
    expect(blockers[0]!.listItems).toEqual([
      ...Array.from({ length: 10 }, (_v, i) => `dir/file-${i + 1}.ts`),
      "...",
    ]);
    // Conflicted renders the NORMAL icon color (upstream's IsFilesConflicted arm).
    expect(data!.timelineIconClass).toBe("tw-text-text-light");
  });

  it("marks the checking PR with the reload attrs and the spinner blocker", async () => {
    const data = await load("checking");
    expect(data!.reloadingInterval).toBe(5000);
    expect(data!.issueLink).toBe("/alice/mergetest/pulls/3");
    const blockers = sectionOf(data!, 0);
    expect(blockers[0]!.info).toBe("Checking for merge conflicts…");
    expect(blockers[0]!.icon).toBe("gitea-running");
    expect(blockers[0]!.iconClass).toBe("rotate-clockwise");
    expect(data!.timelineIconClass).toBe("tw-text-yellow");
  });

  it("renders the closed arm instead of every blocker section", async () => {
    const data = await load("closed");
    expect(data!.closedInfo).toEqual({
      title: "Pull request closed",
      body: "Please reopen this pull request to perform a merge.",
    });
    expect(data!.infoSections.filter((entries) => entries.length > 0)).toEqual([]);
    expect(data!.statusChecks).toBeNull();
    expect(data!.commands).toBeNull();
    expect(data!.timelineIconClass).toBe("tw-text-text-light");
  });

  it("flags the WIP title with the normal icon color and no toggle button", async () => {
    const data = await load("wip");
    expect(data!.isWorkInProgress).toBe(true);
    expect(data!.timelineIconClass).toBe("tw-text-text-light");
  });

  it("projects the ancestor, empty, error and broken arms", async () => {
    const ancestor = await load("ancestor");
    expect(sectionOf(ancestor!, 0).map((item) => item.info)).toContain(
      "This branch is already included in the target branch. There is nothing to merge.",
    );
    expect(ancestor!.timelineIconClass).toBe("tw-text-red");

    const empty = await load("empty");
    expect(sectionOf(empty!, 0).map((item) => item.info)).toContain(
      "The changes on this branch are already on the target branch. This will be an empty commit.",
    );
    expect(sectionOf(empty!, 0)[0]!.icon).toBe("octicon-alert");
    expect(empty!.timelineIconClass).toBe("tw-text-text-light");

    const error = await load("error");
    const infos = sectionOf(error!, 0).map((item) => item.info);
    expect(infos).toContain("This pull request cannot be merged automatically due to conflicts.");
    expect(infos).toContain("Merge manually to resolve the conflicts.");
    expect(error!.timelineIconClass).toBe("tw-text-red");

    const broken = await load("broken");
    expect(sectionOf(broken!, 0).map((item) => item.info)).toContain(
      "This pull request is broken due to missing fork information.",
    );
    expect(broken!.commands).toBeNull();
  });

  it("renders the fork instructions with the owner-prefixed local branch", async () => {
    const data = await load("fork");
    expect(data!.commands!.checkoutLines).toEqual([
      "git fetch -u https://test.local/bob/forky feature:bob-feature",
      "git checkout bob-feature",
    ]);
    // Alice holds no write in bob's fork → no merge instructions.
    expect(data!.commands!.mergeBlocks).toEqual([]);
    expect(data!.commands!.mergePushLine).toBeNull();
    // bob (the fork owner) sees them.
    const asBob = await load("fork", bob);
    expect(asBob!.commands!.mergeBlocks).toHaveLength(6);
    expect(asBob!.commands!.mergePushLine).toBe("git push origin main");
  });

  it("renders the AGit flow's refs/pull fetch line", async () => {
    const data = await load("agit");
    expect(data!.commands!.checkoutLines).toEqual([
      `git fetch -u origin refs/pull/${await indexPr("agit")}/head:agit-branch`,
      "git checkout agit-branch",
    ]);
  });

  it("projects the stored status checks: prompt, Required labels, missing contexts, blockers", async () => {
    const data = await load("statuses");
    const checks = data!.statusChecks!;
    // The required checks' state: ci/build success + deploy/ship success, but
    // ci/deploy missing → pending until EVERY context matches.
    expect(checks.prompt).toBe("Some checks are pending");
    const build = checks.items.find((item) => item.context === "ci/build")!;
    expect(build.required).toBe(true);
    expect(build.state).toBe("success");
    expect(build.targetUrl).toBe("https://ci.example.com/build/1");
    const optional = checks.items.find((item) => item.context === "extra/optional")!;
    expect(optional.required).toBe(false);
    expect(optional.state).toBe("failure");
    const globbed = checks.items.find((item) => item.context === "deploy/ship")!;
    expect(globbed.required).toBe(true); // the deploy/* glob matches
    expect(checks.missingRequired).toEqual(["ci/deploy"]);
    // The protection blockers: missing/pending required check + the
    // approvals shortfall ("1 of 2 official approvals granted").
    const blockers = sectionOf(data!, 0).map((item) => item.info);
    expect(blockers).toContain("Required status checks are missing or pending");
    expect(blockers).toContain(
      "This pull request doesn't have enough required approvals yet. 1 of 2 official approvals granted.",
    );
    // The plain combined state is failure (the optional lint) → red icon.
    expect(data!.timelineIconClass).toBe("tw-text-red");
    // Alice (repo admin, no blockAdminMergeOverride) can bypass → the
    // administrator prompt text.
    expect(sectionOf(data!, 1).map((item) => item.info)).toContain(
      "As an administrator, you may still merge this pull request.",
    );
  });

  it("hides the bypass prompt from a viewer who cannot bypass", async () => {
    const data = await load("statuses", bob);
    expect(sectionOf(data!, 1)).toEqual([]);
    expect(sectionOf(data!, 0).map((item) => item.info)).toContain("You are not authorized to merge this pull request.");
  });
});

// --- the fragment DOM contract -------------------------------------------------

describe("pullMergeBoxFragmentHtml DOM contract", () => {
  it("renders the root card, avatar color and reloading attrs", async () => {
    const html = pullMergeBoxFragmentHtml(await load("mergeable"));
    expect(html).toContain('<div class="timeline-item comment pull-merge-box" data-global-init="initRepoPullMergeBox">');
    expect(html).toContain('<div class="timeline-avatar tw-text-green">');
    expect(html).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="40" height="40" class="svg octicon-git-merge"');
    expect(html).not.toContain("data-pull-merge-box-reloading-interval");
    expect(html).not.toContain("data-pull-link");
    // The inner segment/divided-list chain.
    expect(html).toContain('<div class="ui segment fitted avatar-content-left-arrow">');
    expect(html).toContain('<div class="merge-section flex-divided-list items-px-default">');
  });

  it("emits the checking PR's reload loop attributes", async () => {
    const html = pullMergeBoxFragmentHtml(await load("checking"));
    expect(html).toContain('data-pull-merge-box-reloading-interval="5000"');
    expect(html).toContain('data-pull-link="/alice/mergetest/pulls/3"');
    expect(html).toContain('class="svg gitea-running rotate-clockwise"');
  });

  it("never renders the merge form island, delete button, or update arm", async () => {
    for (const name of ["mergeable", "statuses", "wip"] as const) {
      const html = pullMergeBoxFragmentHtml(await load(name));
      expect(html).not.toContain("pull-request-merge-form");
      expect(html).not.toContain("data-merge-form-props");
      expect(html).not.toContain("delete-branch-after-merge");
      expect(html).not.toContain("out-of-date with the base branch");
      expect(html).not.toContain("initPullRequestWipToggle");
      expect(html).not.toContain("/cleanup");
    }
  });

  it("renders the closed arm's h3 + body", async () => {
    const html = pullMergeBoxFragmentHtml(await load("closed"));
    expect(html).toContain('<h3 class="tw-mb-2">Pull request closed</h3>');
    expect(html).toContain("<div>Please reopen this pull request to perform a merge.</div>");
  });

  it("renders the info items with icons and the detail list", async () => {
    const html = pullMergeBoxFragmentHtml(await load("conflict"));
    expect(html).toContain('<div class="flex-text-block"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" class="svg octicon-x"');
    expect(html).toContain("This pull request has changes conflicting with the target branch.");
    expect(html).toContain('<ul class="tw-pl-[36px]">');
    expect((html.match(/<li>/g) ?? []).length).toBe(11);
    expect(html).toContain("<li>dir/file-10.ts</li>");
    expect(html).toContain("<li>...</li>");
    expect(html).not.toContain("dir/file-11.ts");
  });

  it("renders the WIP line with the x icon", async () => {
    const html = pullMergeBoxFragmentHtml(await load("wip"));
    expect(html).toContain('<div class="item flex-left-right"><div class="flex-text-block">');
    expect(html).toContain("This pull request is marked as a work in progress.");
  });

  it("renders the status-check section arm-for-arm", async () => {
    const html = pullMergeBoxFragmentHtml(await load("statuses"));
    // The toggle row: prompt + the hide-all button with its data attrs.
    expect(html).toContain('<div class="item flex-left-right commit-status-toggle">');
    expect(html).toContain("Some checks are pending");
    expect(html).toContain('<button type="button" data-global-click="onCommitStatusChecksToggle" class="btn interact-fg"');
    expect(html).toContain('data-show-all="Show all checks"');
    expect(html).toContain('data-hide-all="Hide all checks"');
    expect(html).toContain(">Hide all checks</button>");
    // The status list rows.
    expect(html).toContain('<div class="item tw-p-0"><div class="commit-status-list flex-divided-list items-px-default">');
    expect(html).toContain('<div class="item commit-status-item">');
    expect(html).toContain('<div class="gt-ellipsis">ci/build <span class="tw-text-text-light-2">build ok</span></div>');
    // Required labels: ci/build + deploy/ship (glob), never extra/optional;
    // the missing ci/deploy rides its own dot-fill row.
    expect((html.match(/<div class="ui label">Required<\/div>/g) ?? []).length).toBe(3);
    expect(html).toContain('<div class="gt-ellipsis">ci/deploy</div>');
    // The Details link rides a non-empty target URL only.
    expect((html.match(/<a href="https:\/\/ci.example.com\/build\/1">Details<\/a>/g) ?? []).length).toBe(1);
    // The failure icon matrix: the optional lint row carries octicon-x red at 18.
    expect(html).toContain('class="svg octicon-x commit-status icon tw-text-red"');
  });

  it("renders the command instructions with the six style blocks", async () => {
    const html = pullMergeBoxFragmentHtml(await load("mergeable"));
    expect(html).toContain("<details><summary class=\"tw-pl-1\"><span class=\"tw-pl-2\">View command line instructions</span></summary>");
    expect(html).toContain("<h3 class=\"tw-m-0\">Checkout</h3>");
    expect(html).toContain("<div>git fetch -u origin feature:feature</div>");
    expect(html).toContain("<h3 class=\"tw-m-0\">Merge</h3>");
    expect(html).toContain('data-pull-merge-style="merge"');
    expect((html.match(/class="tw-hidden" data-pull-merge-style=/g) ?? []).length).toBe(5);
    expect(html).toContain("<div>git push origin main</div>");
    expect(html).toContain("Warning: This operation cannot merge pull request because");
  });

  it("renders the empty string for the ShowMergeBox=false arm", () => {
    expect(pullMergeBoxFragmentHtml(null)).toBe("");
  });
});

// --- the fragment Response + the escape port -----------------------------------

describe("pullMergeBoxFragmentResponse + shellEscape", () => {
  it("carries the fragment content type and cache-control", async () => {
    const res = pullMergeBoxFragmentResponse("<div>x</div>");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    const empty = pullMergeBoxFragmentResponse("");
    expect(await empty.text()).toBe("");
  });

  it("ports util.ShellEscape's three forms", () => {
    expect(shellEscape("")).toBe("");
    expect(shellEscape("feature")).toBe("feature");
    expect(shellEscape("feature-2.0_x")).toBe("feature-2.0_x"); // clean chars stay plain
    expect(shellEscape("feature branch")).toBe('"feature branch"'); // double-quote form
    expect(shellEscape("#branch")).toBe('"#branch"'); // leading comment
    expect(shellEscape("it's")).toBe('"it\'s"'); // ' escapes inside double quotes
    expect(shellEscape("a!b")).toBe("'a!b'"); // ! forces the single-quote form
    expect(shellEscape("it's\n")).toBe("'it'\\''s\n'"); // single-quote coalescing
    expect(shellEscape("a$b\\c\"d")).toBe('"a\\$b\\\\c\\"d"'); // the double-quote escaper set
    expect(shellEscape("~/bin/branch")).toBe("~/bin/branch"); // the ~ expansion prefix stays bare
    expect(shellEscape("~we ird")).toBe('"~we ird"'); // ~ section unclean (no /) → fully quoted
  });
});

// --- the protection interplay (the deferred rule-config arms) --------------------
// wave-129 matrix-4: the rule-config knobs the base fixture family does not
// carry — blockOnOutdatedBranch (issue_view.go:1102-1105, the
// MergeBlockedByOutdatedBranch arm), the bypass prompt's two forms
// (pull_merge_box.go:167-175: canBypassProtectionAsAdmin = isRepoAdmin &&
// !BlockAdminMergeOverride, issue_view.go:993), the whitelisted approvals
// text (issue_view.go:1082), the required-check FAILURE blocker (vs the
// taken missing/pending arm), the statuses-free and empty-sha rule arms, and
// the conflictedFiles tolerant decode's empty arm. Each new rule lives on its
// OWN base-branch name so the shared "main" rule and the "statuses" fixture
// stay untouched.

describe("the protection interplay (the deferred rule-config arms)", () => {
  /** Two additional rules on the gated repo, keyed by base-branch name:
   *  "release" — the bypass-allowlist pair WITH BlockAdminMergeOverride (the
   *  admin flips to the allowlist prompt form); "lock" — BlockAdminMergeOverride
   *  + block_on_outdated_branch + required status checks, NO bypass list (the
   *  admin is locked out of the bypass entirely). */
  beforeAll(async () => {
    await d1().insert(protectedBranches).values([
      {
        repoId: gatedRepoId,
        ruleName: "release",
        priority: 1,
        rules: serializeRuleConfig({
          ...emptyRuleConfig(),
          requiredApprovals: 1,
          enableBypassAllowlist: true,
          bypassAllowlistUserIds: [alice.id, bob.id],
          blockAdminMergeOverride: true,
        }),
        createdAt: new Date(T0 * 1000),
        updatedAt: new Date(T0 * 1000),
      },
      {
        repoId: gatedRepoId,
        ruleName: "lock",
        priority: 2,
        rules: serializeRuleConfig({
          ...emptyRuleConfig(),
          requiredApprovals: 1,
          blockAdminMergeOverride: true,
          enableStatusCheck: true,
          statusCheckContexts: ["ci/gate", "ci/second"],
          blockOnOutdatedBranch: true,
        }),
        createdAt: new Date(T0 * 1000),
        updatedAt: new Date(T0 * 1000),
      },
    ]);
    // The fixtures, in rule order:
    //  release: alice+bob bypass the approvals shortfall (the allowlist prompt form).
    await seedPr("bypassrelease", { title: "ci: release bypass", headBranch: "rel/a", baseBranch: "release" }, {}, gatedRepoId);
    //  lock/outdated: commitsBehind>0 under block_on_outdated_branch, no sha
    //  (the status block is skipped — only the outdated blocker answers).
    await seedPr(
      "outdated",
      { title: "ci: outdated lock", headBranch: "lock/a", baseBranch: "lock" },
      { commitsBehind: 5, headSha: null },
      gatedRepoId,
    );
    //  lock/ci: a MATCHED required check FAILED (one of two contexts stored,
    //  failing) — the matched-failure arm of MergeRequiredContextsCommitStatus
    //  (services/pull/commit_status.go:26-68: a partial match never pending-
    //  masks a failure).
    await seedPr(
      "lockci",
      { title: "ci: lock failing check", headBranch: "lock/b", baseBranch: "lock" },
      { headSha: "c".repeat(40) },
      gatedRepoId,
    );
    await createCommitStatus(env.DB, {
      repoId: gatedRepoId,
      sha: "c".repeat(40),
      state: "failure",
      targetUrl: "",
      description: "gate red",
      context: "ci/gate",
      creatorId: alice.id,
    });
    //  main/behind: commits_behind 5 under the MAIN rule (no
    //  block_on_outdated_branch) — the outdated blocker must NOT fire.
    await seedPr("behind", { title: "ci: behind unblocked", headBranch: "ci-behind" }, { commitsBehind: 5 }, gatedRepoId);
    //  main/no-status: rule contexts exist, NO status rows — every context
    //  lands missingRequired (status_items.tmpl's MissingRequiredChecks).
    await seedPr("nostatus", { title: "ci: no statuses", headBranch: "ci-bare" }, { headSha: "d".repeat(40) }, gatedRepoId);
    //  main/empty-sha: the headCommitID=="" early return — the whole status
    //  block (and its blockers) never evaluate.
    await seedPr("nulsha", { title: "ci: empty sha", headBranch: "ci-nulsha" }, { headSha: "" }, gatedRepoId);
    //  main/closed: the closed early-return precedes the rule's evaluation.
    await seedPr("gatedclosed", { title: "ci: closed on gated", headBranch: "ci-closed" }, {}, gatedRepoId);
    await new IssuesService(env.DB).closeIssue(issueIds.gatedclosed!, { actorId: alice.id, now: new Date((T0 + 130) * 1000) });
    //  plain-repo dirty arm: the conflictedFiles decode's tolerant halves.
    await seedPr("badjson", { title: "fix: bad json conflicts", headBranch: "bad-json" }, { status: PRStatus.Conflict, conflictedFiles: "{not json" });
    await seedPr(
      "mixedjson",
      { title: "fix: mixed json conflicts", headBranch: "mixed-json" },
      { status: PRStatus.Conflict, conflictedFiles: '["kept.ts", 42, null]' },
    );
  });

  it("flips the admin's bypass prompt to the allowlist form under BlockAdminMergeOverride", async () => {
    // Alice owns the repo (access.admin) and sits on the bypass allowlist:
    // canBypassProtection still answers true, but canBypassProtectionAsAdmin
    // = isRepoAdmin && !BlockAdminMergeOverride = FALSE — the prompt takes
    // the allowlist form, not the administrator form (issue_view.go:993).
    const asAlice = await load("bypassrelease");
    const alicePrompts = sectionOf(asAlice!, 1).map((item) => item.info);
    expect(alicePrompts).toContain("You are allowed to bypass branch protection rules for this merge.");
    expect(alicePrompts).not.toContain("As an administrator, you may still merge this pull request.");
    // The shortfall itself still renders (granted 0 of required 1).
    expect(sectionOf(asAlice!, 0).map((item) => item.info)).toContain(
      "This pull request doesn't have enough required approvals yet. 0 of 1 official approvals granted.",
    );
    // Bob bypasses the same rule through the same list (no admin claim — the
    // plain allowlist arm).
    const asBob = await load("bypassrelease", bob);
    expect(sectionOf(asBob!, 1).map((item) => item.info)).toContain(
      "You are allowed to bypass branch protection rules for this merge.",
    );
  });

  it("blocks the outdated branch only when the rule carries block_on_outdated_branch", async () => {
    // Under the "lock" rule (block_on_outdated_branch: true) the stale head
    // lands its own protection blocker…
    const locked = await load("outdated");
    const lockedInfos = sectionOf(locked!, 0).map((item) => item.info);
    expect(lockedInfos).toContain("This pull request is blocked because it's outdated.");
    // …and with the override set and no bypass list, alice gets NO prompt at
    // all (canMergeNow folds — pull_merge_box.go:167's outer if).
    expect(sectionOf(locked!, 1)).toEqual([]);
    // The negative twin: the SAME divergence (commits_behind 5) under the
    // "main" rule (no block_on_outdated_branch) stays unblocked-by-outdated —
    // its blockers are the approvals pair only.
    const behind = await load("behind");
    expect(sectionOf(behind!, 0).map((item) => item.info)).not.toContain(
      "This pull request is blocked because it's outdated.",
    );
    expect(sectionOf(behind!, 0).map((item) => item.info)).toContain(
      "This pull request doesn't have enough required approvals yet. 0 of 2 official approvals granted.",
    );
  });

  it("lands the outdated blocker WITHOUT the required-check pair when the head sha is empty", async () => {
    // The empty headSha skips the whole status block (pull.go's
    // headCommitID=="" early return), so enableStatusCheck stays false and
    // the required-check blockers never evaluate — the rule's OTHER arms
    // (outdated here) still answer.
    const data = await load("outdated");
    const infos = sectionOf(data!, 0).map((item) => item.info);
    expect(infos).not.toContain("Required status checks did not pass");
    expect(infos).not.toContain("Required status checks are missing or pending");
    expect(data!.statusChecks).toBeNull();
  });

  it("projects the MATCHED-failure required check: failure prompt, blocker, missing twin, red icon", async () => {
    // One of two contexts stored, failing: MergeRequiredContextsCommitStatus
    // refuses to pending-mask the failure (the partial-match arm), so the
    // prompt takes the failure form and the FAILED-context blocker lands
    // (pull.go:487-493's error items), with ci/second riding missingRequired.
    const data = await load("lockci");
    const checks = data!.statusChecks!;
    expect(checks.prompt).toBe("Some required checks failed");
    expect(checks.items).toHaveLength(1);
    expect(checks.items[0]).toMatchObject({ context: "ci/gate", state: "failure", required: true });
    expect(checks.missingRequired).toEqual(["ci/second"]);
    const infos = sectionOf(data!, 0).map((item) => item.info);
    expect(infos).toContain("Required status checks did not pass");
    expect(infos).not.toContain("Required status checks are missing or pending");
    expect(data!.timelineIconClass).toBe("tw-text-red");
    // Override set, no bypass list: the failing rule shows no bypass prompt.
    expect(sectionOf(data!, 1)).toEqual([]);
  });

  it("renders the rule's full missing list when the head sha has no stored statuses", async () => {
    const data = await load("nostatus");
    const checks = data!.statusChecks!;
    expect(checks.items).toEqual([]);
    expect(checks.missingRequired).toEqual(["ci/build", "ci/deploy", "deploy/*"]);
    expect(checks.prompt).toBe("Some checks are pending"); // empty statuses → pending
    expect(sectionOf(data!, 0).map((item) => item.info)).toContain("Required status checks are missing or pending");
    // The icon: no stored statuses → null combined state, and the icon walk
    // consults the status states only when they exist — so the warning arm
    // never fires and the hasBlockers red wins (mergeBoxIconClass's guard).
    expect(data!.timelineIconClass).toBe("tw-text-red");
  });

  it("skips the status section entirely for an empty-string head sha under a status-checking rule", async () => {
    const data = await load("nulsha");
    expect(data!.statusChecks).toBeNull();
    const infos = sectionOf(data!, 0).map((item) => item.info);
    expect(infos).not.toContain("Required status checks did not pass");
    expect(infos).not.toContain("Required status checks are missing or pending");
    // The rule's approvals arm still evaluated (0 of 2 on the main rule).
    expect(infos).toContain("This pull request doesn't have enough required approvals yet. 0 of 2 official approvals granted.");
  });

  it("the closed arm wins on a RULED repo: no status section, no blockers, no commands", async () => {
    // prepareMergeBoxInfoItems' closed early-return precedes every blocker
    // computation — even under the main rule (approvals + status checks) the
    // closed box carries ONLY the ClosedInfo pair (issue_view.go:1071-1076).
    const data = await load("gatedclosed");
    expect(data!.closedInfo).toEqual({
      title: "Pull request closed",
      body: "Please reopen this pull request to perform a merge.",
    });
    expect(data!.statusChecks).toBeNull();
    expect(data!.infoSections.filter((entries) => entries.length > 0)).toEqual([]);
    expect(data!.commands).toBeNull();
    expect(data!.timelineIconClass).toBe("tw-text-text-light");
  });

  it("degrades undecodable and non-string conflictedFiles lists to the no-listed-files arm", async () => {
    // prepareMergeBoxInfoItems' conflicted branch over a garbage JSON blob:
    // the tolerant decode yields [] → the locale's literal no-listed item
    // (pull_merge_box.go:110).
    const bad = await load("badjson");
    const badBlockers = sectionOf(bad!, 0);
    expect(badBlockers).toHaveLength(1);
    expect(badBlockers[0]!.info).toBe("This pull request has changes conflicting with the target branch.");
    expect(badBlockers[0]!.listItems).toEqual(["(No conflicting files listed)"]);
    expect(bad!.timelineIconClass).toBe("tw-text-text-light");
    // A decodable array drops the non-string entries (the typed filter).
    const mixed = await load("mixedjson");
    expect(sectionOf(mixed!, 0)[0]!.listItems).toEqual(["kept.ts"]);
    expect(htmlConflictedList(pullMergeBoxFragmentHtml(await load("badjson")))).toBe("(No conflicting files listed)");
  });
});

/** The single rendered conflict-detail <li> (the DOM half of the empty arm). */
function htmlConflictedList(html: string): string {
  const match = /<ul class="tw-pl-\[36px\]"><li>([^<]*)<\/li><\/ul>/.exec(html);
  return match === null ? "" : match[1]!;
}
