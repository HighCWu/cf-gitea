/**
 * The pull merge box fragment module's tests (bench tick-10 row 4, the
 * `GET /{owner}/{repo}/pulls/{index}/merge_box` module, MOUNTED at
 * 22599e4, window-2e B2): the
 * loader's state→projection matrix over REAL D1 rows (the landed merge
 * state — `pull_requests` status/conflicts/divergence, the
 * branch-protection rule config, stored commit statuses, official review
 * rows) and the fragment's DOM contract against the pinned
 * pull_merge_box.tmpl arm-for-arm. Real D1 via the vitest plugin (generated
 * migrations in beforeAll); the loader + builder driven DIRECTLY (the route
 * arm is index-owned — the mount record in the module header).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { Context } from "hono";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createCommitStatus } from "../../api/services/commit-status";
import { findPullRequestByIndex } from "../../api/services/pulls";
import { ZERO_OID, branchRef, engineReads, refTipMap, pullHeadRef } from "../../api/services/engine";
import {
  comments,
  issues,
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
import { CommentType } from "../../issues/comment-types";
import { emptyRuleConfig, serializeRuleConfig } from "../../services/branch-protection";
import { getScheduledAutoMerge } from "../../services/pull-automerge";
import { RepoService } from "../../repos/service";
import type { RepoRow } from "../ui-context";
import {
  cancelAutoMergeFromWeb,
  changeTargetBranchFromWeb,
  cleanupPullRequestFromWeb,
  loadPullMergeBoxData,
  mergePullRequestFromWeb,
  parseMergePullRequestWebForm,
  parseTargetBranchForm,
  parseUpdateBranchStyle,
  pullMergeBoxFragmentHtml,
  pullMergeBoxFragmentResponse,
  setAllowMaintainerEditFromWeb,
  shellEscape,
  updatePullRequestFromWeb,
  type PullMergeBoxData,
  type PullMergeBoxWriteContext,
} from "./pull-merge-box";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";

const alice = { kind: "user", id: 101, username: "alice", isAdmin: false } as const;
const bob = { kind: "user", id: 102, username: "bob", isAdmin: false } as const;
const cara = { kind: "user", id: 103, username: "cara", isAdmin: false } as const;
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
    { id: cara.id, username: "cara", usernameLower: "cara", displayName: "Cara Null", createdAt: new Date(T0 * 1000) },
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

/** Load + project one fixture PR (fresh rows — the seed's updates landed).
 *  The engine seam rides the REAL DO cells (the deletable tip checks read
 *  them; the row-only fixtures' branches don't exist in git, exactly the
 *  degradation the module doc discloses). */
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
    listTips: (pair) => engineReads(env, pair).listRefs(),
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

  it("never renders the Vue island or the cleanup link on an open box", async () => {
    for (const name of ["mergeable", "statuses", "wip"] as const) {
      const html = pullMergeBoxFragmentHtml(await load(name));
      // The Vue island stays unrendered (the no-JS form replaced it — the
      // write-arm tests below pin its fields); the merged box's cleanup link
      // and the update arm stay off these fixtures (no merged rows, no
      // commits-behind), as does the WIP toggle button.
      expect(html).not.toContain("pull-request-merge-form");
      expect(html).not.toContain("data-merge-form-props");
      expect(html).not.toContain("/cleanup");
      expect(html).not.toContain("out-of-date with the base branch");
      expect(html).not.toContain("initPullRequestWipToggle");
    }
  });

  it("renders the no-JS merge form with upstream's field names for a permitted viewer", async () => {
    const html = pullMergeBoxFragmentHtml(await load("mergeable"));
    expect(html).toContain('<form class="ui form form-fetch-action" action="/alice/mergetest/pulls/1/merge" method="post">');
    expect(html).toContain('name="head_commit_id" value=""'); // the head_sha cache is null on this fixture
    expect(html).toContain('name="merge_when_checks_succeed" value="false"');
    expect(html).toContain('name="force_merge" value="false"');
    // The composed default title (composeMergeMessage's default arm).
    expect(html).toContain(
      `name="merge_title_field" value="Merge pull request &#39;feat: mergeable&#39; (#${await indexPr("mergeable")}) from feature into main"`,
    );
    expect(html).toContain('<textarea name="merge_message_field" rows="5" placeholder="Add an optional extended description…">');
    // The style select (the dropdown's no-JS stand-in) + the submit text.
    expect(html).toContain('<select name="do">');
    expect(html).toContain('<option value="merge" selected="">');
    for (const style of ["rebase", "rebase-merge", "squash", "fast-forward-only"]) {
      expect(html).toContain(`<option value="${style}">`);
    }
    expect(html).toContain("<button type=\"submit\" class=\"ui primary button\">Create merge commit</button>");
  });

  it("withholds the merge form from a non-write viewer and the delete checkbox from a missing branch", async () => {
    const asBob = pullMergeBoxFragmentHtml(await load("mergeable", bob));
    expect(asBob).not.toContain('action="/alice/mergetest/pulls/1/merge"');
    // The checkbox gate: the fixture's head branch does not exist in git
    // (the engine seam answers), so even the owner's render has none.
    const html = pullMergeBoxFragmentHtml(await load("mergeable"));
    expect(html).not.toContain("delete_branch_after_merge");
    expect(html).not.toContain("delete-branch-after-merge");
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


// --- the web write arms (census gap #2) -----------------------------------------
// The POST ladders over REAL engine cells: a dedicated repo carries real
// branch tips (root commit R on main; the divergent feature tip C), the PR
// rows are stamped to the matching states, and every write drives the module
// seams with constructed contexts (the house's non-mounted handler test
// convention — the mounted arms are index-owned, the handoff recipe rides the
// module report).

let writeRepoId = "";
const writePrIds: Record<string, number> = {};
const writeIssueIds: Record<string, number> = {};
let rootOid = "";
let featureOid = "";

const writeRepoOf = async (): Promise<RepoRow> => repoRow(writeRepoId);

/** Worker-side object hash + one commit landed on a ref (the pulls.test.ts
 *  seed twin). */
async function gitObjectOid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function landCommit(
  repo: { ownerNamespace: string; slug: string },
  ref: string,
  input: { parents: string[]; message: string; fileName: string; content: string; /** The ref's CURRENT tip when moving an existing branch. */ replaceOid?: string },
): Promise<string> {
  const cell = env.REPO.getByName(`${repo.ownerNamespace}/${repo.slug}`);
  const blob = new TextEncoder().encode(input.content);
  const blobOid = await gitObjectOid("blob", blob);
  const tree = serializeTree([{ mode: "100644", name: input.fileName, oid: blobOid }]);
  const person = { name: "seed", email: "seed@mergetest.invalid", time: 1_700_000_000, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: input.parents, author: person, committer: person, message: `${input.message}\n` });
  const put = await cell.putApiObjects([
    { oid: blobOid, type: "blob", data: blob },
    { oid: tree.oid, type: "tree", data: tree.data },
    { oid: commit.oid, type: "commit", data: commit.data },
  ]);
  if (put.tag !== "ok") throw new Error(`seed putApiObjects failed: ${put.tag}`);
  const landed = await cell.commitApiChange({ ref, expectedOldOid: input.replaceOid ?? ZERO_OID, newOid: commit.oid });
  if (landed.tag !== "committed") throw new Error(`seed ref landing failed: ${ref} (${landed.tag})`);
  return commit.oid;
}

async function landPullRef(index: number, oid: string): Promise<void> {
  const landed = await env.REPO.getByName("alice/wrepo").commitApiChange({ ref: pullHeadRef(index), expectedOldOid: ZERO_OID, newOid: oid });
  if (landed.tag !== "committed") throw new Error(`pull ref landing failed (${landed.tag})`);
}

async function seedWritePr(
  name: string,
  input: { title: string; headBranch: string; baseBranch?: string; posterId?: number },
  state: Partial<{ status: number; headSha: string | null; commitsBehind: number; conflictedFiles: string | null }>,
): Promise<number> {
  const service = new IssuesService(env.DB);
  const { issue, pullRequest } = await service.createPullRequest({
    repoId: writeRepoId,
    title: input.title,
    posterId: input.posterId ?? bob.id,
    headRepoId: writeRepoId,
    baseBranch: input.baseBranch ?? "main",
    headBranch: input.headBranch,
    now: new Date((T0 + 200) * 1000),
  });
  writePrIds[name] = pullRequest.id;
  writeIssueIds[name] = issue.id;
  await d1()
    .update(pullRequests)
    .set({
      status: state.status ?? PRStatus.Mergeable,
      headSha: state.headSha ?? null,
      commitsBehind: state.commitsBehind ?? 0,
      conflictedFiles: state.conflictedFiles ?? null,
    })
    .where(eq(pullRequests.id, pullRequest.id));
  return pullRequest.index;
}

/** The constructed write context (the mounted route's `c` with the resolved
 *  rows — the session/anonymous gates precede, so the viewer is always a
 *  user). */
async function writeCtx(prName: string, viewer: typeof alice | typeof bob | typeof cara): Promise<PullMergeBoxWriteContext> {
  const index = await writeIndex(prName);
  const found = await findPullRequestByIndex(env.DB, writeRepoId, index);
  if (found === null) throw new Error(`fixture ${prName} missing`);
  return {
    c: new Context(new Request(`${ORIGIN}/alice/wrepo/pulls/${index}`, { method: "POST" }), { env }),
    repo: await writeRepoOf(),
    issue: found.issue,
    pr: found.pullRequest,
    viewer,
  };
}

async function writeIndex(name: string): Promise<number> {
  const rows = await d1().select().from(pullRequests).where(eq(pullRequests.id, writePrIds[name]!)).all();
  return rows[0]!.index;
}

const mergeFormOf = (overrides: Record<string, string | undefined> = {}) => {
  const params = new URLSearchParams({ do: "merge", force_merge: "false", merge_when_checks_succeed: "false" });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    params.set(key, value);
  }
  return parseMergePullRequestWebForm(params);
};

describe("the web write arms", () => {
  beforeAll(async () => {
    const repo = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wrepo",
      isPrivate: false,
      status: "ready",
    });
    writeRepoId = repo.id;
    const pair = { ownerNamespace: "alice", slug: "wrepo" };
    // R on main; the divergent C on feature; the release branch (the
    // target-branch fixture's target) at R.
    rootOid = await landCommit(pair, branchRef("main"), { parents: [], message: "root", fileName: "README.md", content: "# wrepo\n" });
    featureOid = await landCommit(pair, branchRef("feature"), { parents: [rootOid], message: "feature work", fileName: "feat.ts", content: "export {}\n" });
    const okOid = await landCommit(pair, branchRef("okbranch"), { parents: [rootOid], message: "ok work", fileName: "ok.ts", content: "ok\n" });
    await landCommit(pair, branchRef("release"), { parents: [rootOid], message: "release cut", fileName: "VERSION", content: "1.0.0\n" });
    await env.REPO.getByName("alice/wrepo").setHead("main");

    // The PR rows. ok/manual/behind get real pull refs below; the refusal
    // fixtures refuse before any engine read matters.
    await seedWritePr("ok", { title: "feat: ok", headBranch: "okbranch" }, { headSha: okOid });
    await seedWritePr("wip", { title: "WIP: stalled", headBranch: "feature" }, { headSha: featureOid });
    await seedWritePr("conflicted", { title: "fix: conflicted", headBranch: "feature" }, { status: PRStatus.Conflict, headSha: featureOid });
    await seedWritePr("closedpr", { title: "feat: closed", headBranch: "feature" }, { headSha: featureOid });
    await new IssuesService(env.DB).closeIssue(writeIssueIds.closedpr!, { actorId: alice.id, now: new Date((T0 + 210) * 1000) });
    await seedWritePr("manual", { title: "misc: manual", headBranch: "feature" }, { headSha: rootOid });
    await seedWritePr("behind", { title: "feat: behind", headBranch: "feature" }, { headSha: rootOid, commitsBehind: 1 });
    await seedWritePr("fresh", { title: "feat: fresh", headBranch: "feature" }, { headSha: featureOid, commitsBehind: 0 });
    await seedWritePr("edits", { title: "feat: edits", headBranch: "feature", posterId: bob.id }, { headSha: featureOid });
    await seedWritePr("editsok", { title: "feat: edits ok", headBranch: "feature", posterId: alice.id }, { headSha: featureOid });
    await seedWritePr("retarget", { title: "feat: retarget", headBranch: "feature", posterId: bob.id }, { headSha: featureOid });

    await landPullRef(await writeIndex("ok"), okOid);
    await landPullRef(await writeIndex("manual"), rootOid);
    await landPullRef(await writeIndex("behind"), rootOid);

    // The main advance LAST: base tip moves past R (the behind PR's live
    // divergence) while the refs above stay put.
    await landCommit(pair, branchRef("main"), { parents: [rootOid], message: "main advance", fileName: "NEXT.md", content: "next\n", replaceOid: rootOid });
  });

  it("merges an open mergeable PR: redirect, merged row, close comment", async () => {
    const ctx = await writeCtx("ok", alice);
    const result = await mergePullRequestFromWeb(ctx, mergeFormOf({ merge_title_field: "", merge_message_field: "" }));
    expect(result).toEqual({ outcome: "redirect", location: `/alice/wrepo/pulls/${await writeIndex("ok")}` });
    const after = (await findPullRequestByIndex(env.DB, writeRepoId, await writeIndex("ok")))!;
    expect(after.pullRequest.hasMerged).toBe(true);
    expect(after.pullRequest.mergedCommitId).not.toBeNull();
    expect(after.issue.isClosed).toBe(true);
    // The merge_pull system comment (the close service's write).
    const rows = await d1().select().from(comments).where(eq(comments.issueId, after.issue.id)).all();
    expect(rows.some((row) => row.type === CommentType.MergePull)).toBe(true);
  });

  it("refuses the merge for a non-write viewer (the update_not_allowed flash)", async () => {
    const ctx = await writeCtx("conflicted", bob);
    const result = await mergePullRequestFromWeb(ctx, mergeFormOf());
    expect(result).toEqual({ outcome: "error", message: "You are not allowed to update branch" });
  });

  it("maps CheckPullMergeable's refusal arms to their flash texts", async () => {
    expect(await mergePullRequestFromWeb(await writeCtx("wip", alice), mergeFormOf())).toEqual({
      outcome: "error",
      message: "This pull request cannot be merged because it is marked as being a work in progress.",
    });
    expect(await mergePullRequestFromWeb(await writeCtx("closedpr", alice), mergeFormOf())).toEqual({
      outcome: "error",
      message: "The pull request has been closed.",
    });
    expect(await mergePullRequestFromWeb(await writeCtx("conflicted", alice), mergeFormOf())).toEqual({
      outcome: "error",
      message: "This pull request is not ready to be merged. Check review status and status checks.",
    });
    expect(await mergePullRequestFromWeb(await writeCtx("conflicted", alice), mergeFormOf({ do: "explode" }))).toEqual({
      outcome: "error",
      message: "You cannot use this merge option for this pull request.",
    });
    expect(await mergePullRequestFromWeb(await writeCtx("conflicted", alice), mergeFormOf({ merge_when_checks_succeed: "true" }))).toEqual({
      outcome: "error",
      message: "This pull request is not ready to be merged. Check review status and status checks.",
    });
  });

  it("marks a manually-merged PR from an ancestor commit id", async () => {
    const ctx = await writeCtx("manual", alice);
    const result = await mergePullRequestFromWeb(ctx, mergeFormOf({ do: "manually-merged", merge_commit_id: rootOid }));
    expect(result).toEqual({ outcome: "redirect", location: `/alice/wrepo/pulls/${await writeIndex("manual")}` });
    const after = (await findPullRequestByIndex(env.DB, writeRepoId, await writeIndex("manual")))!;
    expect(after.pullRequest.hasMerged).toBe(true);
    expect(after.pullRequest.mergedCommitId).toBe(rootOid);
  });

  it("refuses a manually-merged mark whose commit is not on the base (wrong_commit_id)", async () => {
    // A side-branch commit is never an ancestor of main (the merge-base
    // verification's refusal arm).
    const sideOid = await landCommit({ ownerNamespace: "alice", slug: "wrepo" }, branchRef("sidebranch"), {
      parents: [rootOid],
      message: "side work",
      fileName: "side.ts",
      content: "side\n",
    });
    const ctx = await writeCtx("fresh", alice);
    const result = await mergePullRequestFromWeb(ctx, mergeFormOf({ do: "manually-merged", merge_commit_id: sideOid }));
    expect(result).toEqual({ outcome: "error", message: "commit ID must be a commit ID on the target branch" });
  });

  it("answers the not-scheduled 404 for cancel_auto_merge", async () => {
    expect(await cancelAutoMergeFromWeb(await writeCtx("fresh", alice))).toEqual({ outcome: "not-found" });
  });

  it("schedules the auto merge when checks must succeed: row, type-34 comment, redirect", async () => {
    // A dedicated mergeable fixture (the earlier tests mutate their own).
    await seedWritePr("amgreen", { title: "feat: amgreen", headBranch: "feature" }, { headSha: featureOid });
    const index = await writeIndex("amgreen");
    const before = (await d1().select().from(comments).all()).filter((row) => row.type === CommentType.PRScheduledToAutoMerge).length;
    const result = await mergePullRequestFromWeb(await writeCtx("amgreen", alice), mergeFormOf({ do: "squash", merge_when_checks_succeed: "true" }));
    expect(result).toEqual({ outcome: "redirect", location: `/alice/wrepo/pulls/${index}` });
    const found = (await findPullRequestByIndex(env.DB, writeRepoId, index))!;
    const scheduled = await getScheduledAutoMerge(env.DB, found.issue.id);
    expect(scheduled).not.toBeNull();
    expect(scheduled!.doerId).toBe(alice.id);
    expect(scheduled!.mergeStyle).toBe("squash");
    expect(scheduled!.sha).toBe(featureOid);
    expect(scheduled!.mergeMessage).toContain("feat: amgreen");
    // The PR itself is NOT merged by the schedule arm.
    expect(found.pullRequest.hasMerged).toBe(false);
    // The type-34 system comment (CreateAutoMergeComment's scheduled half).
    const after = (await d1().select().from(comments).all()).filter((row) => row.type === CommentType.PRScheduledToAutoMerge).length;
    expect(after).toBe(before + 1);
  });

  it("renders the pending schedule: the info message + the cancel form + the reduced MWCS hidden", async () => {
    const index = await writeIndex("amgreen");
    const found = (await findPullRequestByIndex(env.DB, writeRepoId, index))!;
    const data = await loadPullMergeBoxData(env.DB, {
      repo: await writeRepoOf(),
      issue: found.issue,
      pr: found.pullRequest,
      viewer: alice,
      origin: ORIGIN,
      listTips: (pair) => engineReads(env, pair).listRefs(),
    });
    expect(data!.mergeForm!.pendingAutoMerge?.doerName).toBe("alice");
    expect(typeof data!.mergeForm!.pendingAutoMerge?.createdUnix).toBe("number");
    expect(data!.mergeForm!.mergeWhenChecksSucceed).toBe(false); // canMergeNow on the clean fixture
    const html = pullMergeBoxFragmentHtml(data);
    expect(html).toContain('class="ui info message"');
    expect(html).toContain("scheduled this pull request to auto merge when all checks succeed");
    expect(html).toContain(`<form action="/alice/wrepo/pulls/${index}/cancel_auto_merge" method="post" class="tw-ml-4">`);
    expect(html).toContain("Cancel auto merge");
  });

  it("re-scheduling resets the single row (the handler's delete-first)", async () => {
    const index = await writeIndex("amgreen");
    await mergePullRequestFromWeb(await writeCtx("amgreen", alice), mergeFormOf({ do: "merge", merge_when_checks_succeed: "true" }));
    const found = (await findPullRequestByIndex(env.DB, writeRepoId, index))!;
    const scheduled = await getScheduledAutoMerge(env.DB, found.issue.id);
    expect(scheduled!.mergeStyle).toBe("merge");
    const commentsRows = await d1().select().from(comments).where(eq(comments.issueId, found.issue.id)).all();
    expect(commentsRows.filter((row) => row.type === CommentType.PRScheduledToAutoMerge).length).toBe(2);
  });

  it("refuses the schedule for a WIP PR and a conflicted PR (no row lands)", async () => {
    await seedWritePr("amwip", { title: "WIP: amwip", headBranch: "feature" }, { headSha: featureOid });
    const wip = await mergePullRequestFromWeb(await writeCtx("amwip", alice), mergeFormOf({ merge_when_checks_succeed: "true" }));
    expect(wip).toEqual({ outcome: "error", message: "This pull request cannot be merged because it is marked as being a work in progress." });
    const conflict = await mergePullRequestFromWeb(await writeCtx("conflicted", alice), mergeFormOf({ merge_when_checks_succeed: "true" }));
    expect(conflict).toEqual({
      outcome: "error",
      message: "This pull request is not ready to be merged. Check review status and status checks.",
    });
    for (const name of ["amwip", "conflicted"]) {
      const found = (await findPullRequestByIndex(env.DB, writeRepoId, await writeIndex(name)))!;
      expect(await getScheduledAutoMerge(env.DB, found.issue.id)).toBeNull();
    }
  });

  it("renders the MWCS-hidden true + the button suffix when the merge cannot happen now", async () => {
    // A rule whose blockers alice (the admin) canNOT bypass: the approvals
    // blocker stands and canMergeNow flips false — the Vue arm where the
    // only offered action is the auto merge.
    const repo = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "forcegated",
      isPrivate: false,
      status: "ready",
    });
    const forceRepoId = repo.id;
    await d1().insert(protectedBranches).values({
      repoId: forceRepoId,
      ruleName: "main",
      priority: 0,
      rules: serializeRuleConfig({ ...emptyRuleConfig(), requiredApprovals: 1, blockAdminMergeOverride: true }),
      createdAt: new Date(T0 * 1000),
      updatedAt: new Date(T0 * 1000),
    });
    await seedWritePr("amblocked", { title: "feat: amblocked", headBranch: "feature" }, { headSha: featureOid });
    // Move the row onto the force-gated repo (seedWritePr pins writeRepoId).
    await d1()
      .update(pullRequests)
      .set({ headRepoId: forceRepoId, baseRepoId: forceRepoId })
      .where(eq(pullRequests.id, writePrIds.amblocked!));
    await d1()
      .update(issues)
      .set({ repoId: forceRepoId })
      .where(eq(issues.id, writeIssueIds.amblocked!));
    const found = (await findPullRequestByIndex(env.DB, forceRepoId, await writeIndex("amblocked")))!;
    const data = await loadPullMergeBoxData(env.DB, {
      repo: (await d1().select().from(repositories).where(eq(repositories.id, forceRepoId)).all())[0]!,
      issue: found.issue,
      pr: found.pullRequest,
      viewer: alice,
      origin: ORIGIN,
      listTips: (pair) => engineReads(env, pair).listRefs(),
    });
    expect(data!.mergeForm!.mergeWhenChecksSucceed).toBe(true);
    expect(data!.mergeForm!.forceMerge).toBe(false); // canMergeNow false — no force escape either
    const html = pullMergeBoxFragmentHtml(data);
    expect(html).toContain('name="merge_when_checks_succeed" value="true"');
    expect(html).toContain("Create merge commit (When checks succeed)");
  });

  it("cancels the schedule: scheduler redirect + row gone + type-35; the permissionless 403 twin", async () => {
    const index = await writeIndex("amgreen");
    const found = (await findPullRequestByIndex(env.DB, writeRepoId, index))!;
    // bob holds no write on alice's repo → the permission-denied error text.
    expect(await cancelAutoMergeFromWeb(await writeCtx("amgreen", bob))).toEqual({
      outcome: "error",
      message: "user has no permission to cancel the scheduled auto merge",
    });
    expect(await getScheduledAutoMerge(env.DB, found.issue.id)).not.toBeNull();
    // The scheduler cancels: redirect, row gone, the type-35 comment.
    expect(await cancelAutoMergeFromWeb(await writeCtx("amgreen", alice))).toEqual({
      outcome: "redirect",
      location: `/alice/wrepo/pulls/${index}`,
    });
    expect(await getScheduledAutoMerge(env.DB, found.issue.id)).toBeNull();
    const rows = await d1().select().from(comments).where(eq(comments.issueId, found.issue.id)).all();
    expect(rows.some((row) => row.type === CommentType.PRUnscheduledToAutoMerge)).toBe(true);
    // The second cancel finds no row → the upstream NotFound arm.
    expect(await cancelAutoMergeFromWeb(await writeCtx("amgreen", alice))).toEqual({ outcome: "not-found" });
  });

  it("updates the head branch by merge: redirect, moved ref, checking row", async () => {
    const before = refTipMap(await engineReads(env, { ownerNamespace: "alice", slug: "wrepo" }).listRefs()).get(branchRef("feature"))!.target;
    const ctx = await writeCtx("behind", alice);
    expect(parseUpdateBranchStyle("merge")).toBe("merge");
    expect(parseUpdateBranchStyle("rebase")).toBe("rebase");
    expect(parseUpdateBranchStyle("squash")).toBeNull();
    const result = await updatePullRequestFromWeb(ctx, "merge");
    expect(result).toEqual({ outcome: "redirect", location: `/alice/wrepo/pulls/${await writeIndex("behind")}` });
    const after = refTipMap(await engineReads(env, { ownerNamespace: "alice", slug: "wrepo" }).listRefs()).get(branchRef("feature"))!.target;
    expect(after).not.toBe(before);
    const row = (await findPullRequestByIndex(env.DB, writeRepoId, await writeIndex("behind")))!;
    expect(row.pullRequest.status).toBe(PRStatus.Checking);
    expect(row.pullRequest.headSha).toBe(after);
  });

  it("refuses the update for a non-write viewer and the up-to-date twin", async () => {
    expect(await updatePullRequestFromWeb(await writeCtx("behind", bob), "merge")).toEqual({
      outcome: "error",
      message: "You are not allowed to update branch",
    });
    // The up-to-date twin: fresh's pull ref rides main's live tip → behind 0.
    const mainTip = refTipMap(await engineReads(env, { ownerNamespace: "alice", slug: "wrepo" }).listRefs()).get(branchRef("main"))!.target;
    await landPullRef(await writeIndex("fresh"), mainTip);
    expect(await updatePullRequestFromWeb(await writeCtx("fresh", alice), "rebase")).toEqual({
      outcome: "error",
      message: "Unable to update pull request",
    });
  });

  it("toggles allow_maintainer_edit for a poster with head write; refuses the others", async () => {
    // bob posted `edits` but holds no write in alice's repo → refused.
    expect(await setAllowMaintainerEditFromWeb(await writeCtx("edits", bob), { allowMaintainerEdit: true })).toEqual({
      outcome: "error",
      message: "user not allowed to do this action",
    });
    // alice holds the write but is not the poster → refused (edits.go's
    // poster-first gate).
    expect(await setAllowMaintainerEditFromWeb(await writeCtx("edits", alice), { allowMaintainerEdit: true })).toEqual({
      outcome: "error",
      message: "user not allowed to do this action",
    });
    // The poster WITH head write.
    expect(await setAllowMaintainerEditFromWeb(await writeCtx("editsok", alice), { allowMaintainerEdit: true })).toEqual({
      outcome: "redirect",
      location: `/alice/wrepo/pulls/${await writeIndex("editsok")}`,
    });
    const row = (await findPullRequestByIndex(env.DB, writeRepoId, await writeIndex("editsok")))!;
    expect(row.pullRequest.allowMaintainerEdit).toBe(true);
  });

  it("cleans up the merged PR's branch: redirect, ref gone, type-11 comment", async () => {
    const ctx = await writeCtx("ok", alice);
    const result = await cleanupPullRequestFromWeb(ctx);
    expect(result).toEqual({ outcome: "redirect", location: `/alice/wrepo/pulls/${await writeIndex("ok")}` });
    const tips = refTipMap(await engineReads(env, { ownerNamespace: "alice", slug: "wrepo" }).listRefs());
    expect(tips.get(branchRef("okbranch"))).toBeUndefined();
    const after = (await findPullRequestByIndex(env.DB, writeRepoId, await writeIndex("ok")))!;
    const rows = await d1().select().from(comments).where(eq(comments.issueId, after.issue.id)).all();
    expect(rows.some((row) => row.type === CommentType.DeleteBranch && row.oldRef === "okbranch")).toBe(true);
  });

  it("refuses the cleanup when the branch moved past the pull ref", async () => {
    // A dedicated merged PR on its own branch; the branch then gains a
    // commit the pull ref never saw → the has_new_commits flash.
    const index = await seedWritePr("stuck", { title: "misc: stuck", headBranch: "stuck" }, { headSha: rootOid });
    const stuckOid = await landCommit({ ownerNamespace: "alice", slug: "wrepo" }, branchRef("stuck"), {
      parents: [rootOid],
      message: "stuck base",
      fileName: "STUCK.md",
      content: "s\n",
    });
    await landPullRef(index, stuckOid);
    await d1().update(pullRequests).set({ hasMerged: true, mergedCommitId: rootOid, mergerId: alice.id }).where(eq(pullRequests.id, writePrIds.stuck!));
    await landCommit({ ownerNamespace: "alice", slug: "wrepo" }, branchRef("stuck"), {
      parents: [stuckOid],
      message: "post-merge push",
      fileName: "STUCK2.md",
      content: "s2\n",
      replaceOid: stuckOid,
    });
    const ctx = await writeCtx("stuck", alice);
    const result = await cleanupPullRequestFromWeb(ctx);
    expect(result.outcome === "error" && result.message.includes("new commits have been added after merging")).toBe(true);
  });

  it("retargets a PR: redirect, new base, checking row", async () => {
    const ctx = await writeCtx("retarget", bob);
    const result = await changeTargetBranchFromWeb(ctx, parseTargetBranchForm(new URLSearchParams({ target_branch: "release" })));
    expect(result).toEqual({ outcome: "redirect", location: `/alice/wrepo/pulls/${await writeIndex("retarget")}` });
    const row = (await findPullRequestByIndex(env.DB, writeRepoId, await writeIndex("retarget")))!;
    expect(row.pullRequest.baseBranch).toBe("release");
    expect(row.pullRequest.status).toBe(PRStatus.Checking);
  });

  it("maps ChangeTargetBranch's refusals", async () => {
    // Missing target branch.
    expect(await changeTargetBranchFromWeb(await writeCtx("fresh", alice), parseTargetBranchForm(new URLSearchParams({ target_branch: "nope" })))).toEqual({
      outcome: "error",
      message: "Target branch does not exist.",
    });
    // The same-branch no-op (retarget's base IS release now).
    expect(await changeTargetBranchFromWeb(await writeCtx("retarget", bob), parseTargetBranchForm(new URLSearchParams({ target_branch: "release" })))).toEqual({
      outcome: "redirect",
      location: `/alice/wrepo/pulls/${await writeIndex("retarget")}`,
    });
    // A closed PR refuses (409 flash text).
    await d1().update(issues).set({ isClosed: true }).where(eq(issues.id, writeIssueIds.editsok!));
    expect(await changeTargetBranchFromWeb(await writeCtx("editsok", alice), parseTargetBranchForm(new URLSearchParams({ target_branch: "release" })))).toEqual({
      outcome: "error",
      message: "The pull request has been closed.",
    });
    // A non-writer, non-poster viewer is the shell-hidden refusal. (bob IS
    // fresh's poster — the gate passes and the duplicate-PR 409 fires
    // instead, pinned above as the retarget refusal.)
    expect(
      await changeTargetBranchFromWeb(await writeCtx("fresh", bob), parseTargetBranchForm(new URLSearchParams({ target_branch: "release" }))),
    ).toEqual({ outcome: "error", message: "A pull request between these branches already exists: alice/wrepo#10" });
    expect(await changeTargetBranchFromWeb(await writeCtx("fresh", cara), parseTargetBranchForm(new URLSearchParams({ target_branch: "release" })))).toEqual({
      outcome: "not-found",
    });
  });
});

// --- the merged box's cleanup arm (the second ShowMergeBox half) ----------------

describe("the merged box renders the cleanup delete", () => {
  it("renders the merged ClosedInfo pair, the purple icon and the delete form", async () => {
    const index = await seedWritePr("gone", { title: "misc: merged deletable", headBranch: "wipdelete", posterId: alice.id }, { status: PRStatus.Mergeable });
    const branchOid = await landCommit({ ownerNamespace: "alice", slug: "wrepo" }, branchRef("wipdelete"), {
      parents: [rootOid],
      message: "doomed",
      fileName: "DOOMED.md",
      content: "gone soon\n",
    });
    await landPullRef(index, branchOid);
    await d1()
      .update(pullRequests)
      .set({ hasMerged: true, mergedCommitId: rootOid, mergerId: alice.id, headSha: branchOid })
      .where(eq(pullRequests.id, writePrIds.gone!));
    await d1().update(issues).set({ isClosed: true }).where(eq(issues.id, writeIssueIds.gone!));

    const found = (await findPullRequestByIndex(env.DB, writeRepoId, index))!;
    const data = await loadPullMergeBoxData(env.DB, {
      repo: await writeRepoOf(),
      issue: found.issue,
      pr: found.pullRequest,
      viewer: alice,
      origin: ORIGIN,
      listTips: (pair) => engineReads(env, pair).listRefs(),
    });
    expect(data).not.toBeNull();
    expect(data!.timelineIconClass).toBe("tw-text-purple");
    expect(data!.closedInfo!.title).toBe("Pull request successfully merged and closed");
    expect(data!.deleteBranch).toEqual({ link: `/alice/wrepo/pulls/${index}/cleanup`, headTarget: "wipdelete" });
    const html = pullMergeBoxFragmentHtml(data);
    expect(html).toContain("The branch <code>wipdelete</code> can now be deleted.");
    expect(html).toContain(`<form action="/alice/wrepo/pulls/${index}/cleanup" method="post">`);
    expect(html).toContain('class="ui button link-action delete-branch-after-merge"');
    // A viewer without head write sees no box at all.
    const asBob = await loadPullMergeBoxData(env.DB, {
      repo: await writeRepoOf(),
      issue: found.issue,
      pr: found.pullRequest,
      viewer: bob,
      origin: ORIGIN,
      listTips: (pair) => engineReads(env, pair).listRefs(),
    });
    expect(asBob).toBeNull();
  });
});
