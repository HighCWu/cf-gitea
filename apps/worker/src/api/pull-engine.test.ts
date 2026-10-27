/**
 * The PR deferred family on REAL engine content (SPEC-0004 §2.4 rows
 * repoDownloadPullDiffOrPatch / repoGetPullRequestCommits /
 * repoGetPullRequestFiles / repoPullRequestIsMerged / repoMergePullRequest /
 * repoMergeUpstream + the mergeability rendering upgrade on
 * repoGetPullRequest; SPEC-0005 §3.4 semantics), plus the (C) commits family
 * (repoGetAllCommits / repoGetSingleCommit / repoDownloadCommitDiffOrPatch /
 * repoGetCommitPullRequest / repoCompareDiff).
 *
 * Content is REAL end to end: the ui/testing seed-repo push pattern seeds the
 * base history through the git-http receive flow; the topic branches and
 * their commits are then built through the API's own contents-write path
 * (commit builder → putApiObjects → commitApiChange), so the PR under test
 * exercises exactly the refs the engine serves. `refs/pull/N/head` lands at
 * creation through the receive-less commitApiChange (SPEC-0001b §4.4
 * mapping); GET …/{index} runs the lazy mergeability check and CAS-writes the
 * row; the merge styles land through executeMerge / rebaseOnto.
 *
 * Routes mount LOCALLY (the deferred router.ts one-liner's seam); the pulls
 * module is registered verbatim with the same arguments the one-liner uses.
 */

import { SELF, applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";

import { ensureSeededRepo, buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../ui/testing/seed-repo";
import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor } from "../auth/testing/seeds";
import { users, protectedBranches, repositories, comments, PRStatus, pullRequests } from "../db/schema";
import { CommentType } from "../issues/comment-types";
import { emptyRuleConfig, serializeRuleConfig } from "../services/branch-protection";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, STUB_USER, type AuthResolver } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { registerBranchRoutes } from "./routes/branches";
import { registerCommitRoutes } from "./routes/commits";
import { registerContentsRoutes } from "./routes/contents";
import { registerPullRoutes } from "./routes/pulls";
import { engineReads, refTipMap } from "./services/engine";
import { RepoService } from "../repos/service";
import type { User } from "./models/user";

// wave-129 full-run contention budget: this file's heaviest closure measured
// 26.64s of the 30s default IN a green 8-worker full run (the fork-head merge
// arms — and it fired the stochastic one-file-per-run timeout class under load,
// 2026-10-26). The suite's 260-isolate spawn storm spikes closures up to ~12x
// their solo time; these file-local 90s budgets restore headroom while
// vitest.config.ts keeps 30s for every other file. Membership: the measured
// >=4s in-run closure/hook set (full-suite junit run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const ORIGIN = "https://apisuite.test";
const TOKEN = "pull-engine-token";
const OWNER = "apisuite";
const SLUG = "pulls";
const REPO = `/repos/${OWNER}/${SLUG}`;

const T0 = 1_761_000_000;

const SEED_COMMITS: SeedCommit[] = [
  {
    message: "base: initial commit",
    time: T0,
    files: [
      { path: "README.md", content: "# pull engine suite\n" },
      { path: "shared.txt", content: "shared base\n" },
    ],
  },
  {
    message: "base: docs",
    time: T0 + 30,
    files: [
      { path: "README.md", content: "# pull engine suite\n" },
      { path: "shared.txt", content: "shared base\n" },
      { path: "docs/base.txt", content: "base doc\n" },
    ],
  },
];

let OWNER_ID = 1;
let TIP1 = "";
let TIP2 = "";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyAuthD1Migrations();
  const seeded = await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits: SEED_COMMITS });
  TIP1 = seeded.tips[0] as string;
  TIP2 = seeded.tips[1] as string;
  const row = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get();
  if (row === undefined) throw new Error("seed owner missing");
  OWNER_ID = row.id;
});

function identity(): User {
  return { ...STUB_USER, id: OWNER_ID, login: OWNER, full_name: OWNER, created: new Date(T0 * 1000).toISOString() };
}

const resolver: AuthResolver = { resolveToken: (token: string) => Promise.resolve(token === TOKEN ? identity() : null) };

function app(): OpenAPIHono<ApiEnv> {
  const a = new OpenAPIHono<ApiEnv>();
  a.onError(giteaErrorHandler);
  const requireAuth = createTokenAuthMiddleware(resolver);
  const optionalAuth = createOptionalTokenAuthMiddleware(resolver);
  registerPullRoutes(a, requireAuth, optionalAuth);
  registerCommitRoutes(a, requireAuth, optionalAuth);
  registerBranchRoutes(a, requireAuth, optionalAuth);
  registerContentsRoutes(a, requireAuth, optionalAuth);
  return a;
}


/** The parsed body of an in-process response, view-shaped for assertions. */
async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await res.text());
  return parsed as Record<string, unknown>;
}

const authed = (init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${TOKEN}` },
});
const jsonInit = (method: string, body: unknown): RequestInit =>
  authed({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = async (path: string): Promise<Response> => app().fetch(new Request(`${ORIGIN}${path}`), env);
const send = async (path: string, init: RequestInit): Promise<Response> => app().fetch(new Request(`${ORIGIN}${path}`, init), env);

/** Branch + one content commit through the API's own write paths. */
async function seedBranchWithCommit(branch: string, path: string, content: string): Promise<string> {
  const created = await send(`${REPO}/branches`, jsonInit("POST", { new_branch_name: branch }));
  expect(created.status).toBe(201);
  const written = await send(`${REPO}/contents/${path}`, jsonInit("POST", { content: btoa(content), branch, message: `${branch}: ${path}` }));
  expect(written.status).toBe(201);
  const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
  return tips.get(`refs/heads/${branch}`)?.target ?? "";
}

// ---------------------------------------------------------------------------
// Create + refs/pull/N/head + the lazy mergeability check
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/pulls — engine validation + refs/pull/N/head", () => {
  it("404s a missing head branch and a missing base (engine reads)", async () => {
    expect((await send(`${REPO}/pulls`, jsonInit("POST", { title: "x", head: "ghost", base: "main" }))).status).toBe(404);
    expect((await send(`${REPO}/pulls`, jsonInit("POST", { title: "x", head: "main", base: "ghost" }))).status).toBe(404);
    expect((await send(`${REPO}/pulls`, jsonInit("POST", { title: "x", head: "main", base: "main" }))).status).toBe(422);
  });

  it("creates the PR (201), lands refs/pull/1/head, caches head_sha", async () => {
    await seedBranchWithCommit("topic", "topic-a.txt", "topic a\n");
    await send(`${REPO}/contents/topic-b.txt`, jsonInit("POST", { content: btoa("topic b\n"), branch: "topic", message: "topic: b" }));

    const res = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Add topic files", head: "topic", base: "main", body: "please review" }));
    expect(res.status).toBe(201);
    const pr: Record<string, unknown> = await res.json();
    expect(pr.number).toBe(1);
    expect(pr.mergeable).toBeNull(); // checking — the lazy check has not run
    expect(((pr.head as Record<string, unknown>).ref) as string).toBe("refs/pull/1/head");
    expect(((pr.head as Record<string, unknown>).sha) as string).not.toBe("");

    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect(tips.get("refs/pull/1/head")?.target).toBe(tips.get("refs/heads/topic")?.target);

    // duplicate open targets → 409 (issue_id carries the index)
    expect((await send(`${REPO}/pulls`, jsonInit("POST", { title: "dup", head: "topic", base: "main" }))).status).toBe(409);
  });
});

describe("GET /repos/{owner}/{repo}/pulls/{index} — the lazy mergeability check", () => {
  it("fires checkMergeability on a checking row and renders the real mergeable pair", async () => {
    const res = await get(`${REPO}/pulls/1`);
    expect(res.status).toBe(200);
    const pr: Record<string, unknown> = await res.json();
    expect(pr.mergeable).toBe(true); // topic descends from main: clean merge
    expect(pr.merge_base).toBe(TIP2);
    expect(((pr.base as Record<string, unknown>).sha) as string).toBe(TIP2);
    expect(pr.draft).toBe(false);

    // the row CAS-updated: a second GET renders from the cache (same values)
    const again = (await jsonBody(await get(`${REPO}/pulls/1`)));
    expect(again.mergeable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PR diff / patch / commits / files
// ---------------------------------------------------------------------------

describe("PR diff, patch, commits, files", () => {
  it("renders the three-dot diff as raw text (.{diffType} dot-suffix path)", async () => {
    const diff = await get(`${REPO}/pulls/1.diff`);
    expect(diff.status).toBe(200);
    const text = await diff.text();
    expect(text).toContain("diff --git a/topic-a.txt b/topic-a.txt");
    expect(text).toContain("+topic a");

    const patch = await get(`${REPO}/pulls/1.patch`);
    expect(patch.status).toBe(200);
    const patchText = await patch.text();
    expect(patchText).toContain("Subject: [PATCH] topic: b"); // format-patch of the range head
    expect(patchText).toContain("diff --git a/topic-b.txt b/topic-b.txt");

    expect((await get(`${REPO}/pulls/1.zip`)).status).toBe(404);
  });

  it("lists the PR commits with the contract X-* header family and stats", async () => {
    const res = await get(`${REPO}/pulls/1/commits`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.headers.get("X-HasMore")).toBe("false");
    expect(res.headers.get("X-Page")).toBe("1");
    const commits: Array<Record<string, unknown>> = await res.json();
    expect(commits).toHaveLength(2);
    expect((commits[0]?.stats as Record<string, unknown>).total).toBeGreaterThan(0);
    expect((commits[0]?.files as Array<Record<string, unknown>>)[0]?.filename).toBe("topic-a.txt");
  });

  it("lists the changed files (ChangedFileList) with the X-* header family", async () => {
    const res = await get(`${REPO}/pulls/1/files?limit=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.headers.get("X-HasMore")).toBe("true");
    const files: Array<Record<string, unknown>> = await res.json();
    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toBe("topic-a.txt");
    expect(files[0]?.status).toBe("added");
  });

  it("paginates the changed files: page 2 carries the last file, a past-the-end page is empty (the X-HasMore flip)", async () => {
    // PR 1's range is topic-a.txt + topic-b.txt (2 files). The /files slice
    // is page/limit over the ordered range diff (routes/pulls.ts handler);
    // X-HasMore reads `files.length > page * limit` — exactly true on page 1
    // (2 > 1) and false from page 2 on (2 > 2).
    const page2 = await get(`${REPO}/pulls/1/files?limit=1&page=2`);
    expect(page2.status).toBe(200);
    expect(page2.headers.get("X-Page")).toBe("2");
    // The SO-FAR approximation rides the FULL file count, not the slice:
    // soFar = (page - 1) * limit + files.length = 1 + 2 (routes/pulls.ts
    // handler, the setCommitListHeaders module doc) — an upper bound.
    expect(page2.headers.get("X-Total-Count")).toBe("3");
    expect(page2.headers.get("X-HasMore")).toBe("false");
    const files: Array<Record<string, unknown>> = await page2.json();
    expect(files).toHaveLength(1);
    expect(files[0]?.filename).toBe("topic-b.txt");

    const past = await get(`${REPO}/pulls/1/files?limit=1&page=3`);
    expect(past.status).toBe(200);
    expect(past.headers.get("X-HasMore")).toBe("false");
    expect(await past.json<unknown[]>()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Conflict / WIP / gating
// ---------------------------------------------------------------------------

describe("merge gating — conflict, WIP, schedule", () => {
  it("a conflicting PR renders mergeable=false and merge answers 405", async () => {
    await seedBranchWithCommit("clash", "clash.txt", "from clash\n");
    // the same path on main with different content — add/add conflict
    const onMain = await send(`${REPO}/contents/clash.txt`, jsonInit("POST", { content: btoa("from main\n"), branch: "main", message: "main: clash.txt" }));
    expect(onMain.status).toBe(201);

    const res = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Clashing change", head: "clash", base: "main" }));
    expect(res.status).toBe(201);

    const render = await get(`${REPO}/pulls/2`);
    const pr: Record<string, unknown> = await render.json();
    expect(pr.mergeable).toBe(false);

    const merge = await send(`${REPO}/pulls/2/merge`, jsonInit("POST", { do: "merge" }));
    expect(merge.status).toBe(405);
    // the not-mergeable 405 carries the runtime APIError envelope (the
    // suite's empty-family conversion note)
    expect((await jsonBody(merge)).message).toBe("Please try again later");
  });

  it("WIP titles answer 405; the auto-merge schedule answers the declared 409", async () => {
    await seedBranchWithCommit("wip", "wip.txt", "wip\n");
    const created = await send(`${REPO}/pulls`, jsonInit("POST", { title: "WIP: pending work", head: "wip", base: "main" }));
    expect(created.status).toBe(201);
    const pr: Record<string, unknown> = await created.json();
    const index = pr.number as number;

    expect((await jsonBody(await get(`${REPO}/pulls/${index}`))).draft).toBe(true);
    const merge = await send(`${REPO}/pulls/${index}/merge`, jsonInit("POST", { do: "merge" }));
    expect(merge.status).toBe(405);
    expect((await jsonBody(merge)).message).toBe("Work in progress PRs cannot be merged");
    expect((await send(`${REPO}/pulls/${index}/merge`, jsonInit("POST", { do: "merge", merge_when_checks_succeed: true }))).status).toBe(409);
  });

  it("merge-upstream answers 404 while forks cannot exist", async () => {
    expect((await send(`${REPO}/merge-upstream`, jsonInit("POST", { branch: "main" }))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Merge styles
// ---------------------------------------------------------------------------

describe("POST …/merge — the styles over the engine's landing primitives", () => {
  it("merge: two-parent merge commit, row lands, issue closes, is-merged 204", async () => {
    const res = await send(`${REPO}/pulls/1/merge`, jsonInit("POST", { do: "merge", merge_title_field: "Merge pull request #1 from topic" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");

    const pr = await jsonBody(await get(`${REPO}/pulls/1`));
    expect(pr.merged).toBe(true);
    expect(pr.state).toBe("closed");
    expect(pr.merge_commit_sha).not.toBe("");
    expect(((pr.merged_by as Record<string, unknown>)?.login) as string).toBe(OWNER);

    expect((await get(`${REPO}/pulls/1/merge`)).status).toBe(204);

    // main advanced to a two-parent merge commit
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    const main = await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).readCommit(tips.get("refs/heads/main")?.target);
    expect(main?.parents).toHaveLength(2);
    expect((await jsonBody(await get(`${REPO}/pulls/1`))).merge_commit_sha).toBe(main?.oid);

    // re-merge → 405 (already merged)
    expect((await send(`${REPO}/pulls/1/merge`, jsonInit("POST", { do: "merge" }))).status).toBe(405);
  });

  it("fast-forward-only moves the base ref onto the head (no merge commit)", async () => {
    const ffTip = await seedBranchWithCommit("ff", "ff.txt", "ff\n");
    const created = await send(`${REPO}/pulls`, jsonInit("POST", { title: "FF change", head: "ff", base: "main" }));
    expect(created.status).toBe(201);
    const index = (await jsonBody(created)).number as number;

    expect((await send(`${REPO}/pulls/${index}/merge`, jsonInit("POST", { do: "fast-forward-only" }))).status).toBe(200);
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect(tips.get("refs/heads/main")?.target).toBe(ffTip);
    const main = await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).readCommit(ffTip);
    expect(main?.parents).toHaveLength(1); // FF: no merge commit
  });

  it("squash lands one parent on the base with the requested message", async () => {
    await seedBranchWithCommit("sq", "sq-a.txt", "sq a\n");
    await send(`${REPO}/contents/sq-b.txt`, jsonInit("POST", { content: btoa("sq b\n"), branch: "sq", message: "sq: b" }));
    const created = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Squash me", head: "sq", base: "main" }));
    const index = (await jsonBody(created)).number as number;

    expect((await send(`${REPO}/pulls/${index}/merge`, jsonInit("POST", { do: "squash", merge_title_field: "Squashed change (#5)" }))).status).toBe(200);
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    const main = await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).readCommit(tips.get("refs/heads/main")?.target);
    expect(main?.parents).toHaveLength(1);
    expect(main?.subject).toBe("Squashed change (#5)");
  });

  it("manually-merged marks the row against a verified ancestor", async () => {
    await seedBranchWithCommit("mm", "mm.txt", "mm\n");
    const created = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Merged by hand", head: "mm", base: "main" }));
    const index = (await jsonBody(created)).number as number;
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    const mainTip = tips.get("refs/heads/main")?.target as string;

    // a commit that is NOT an ancestor of base (the unmerged clash tip) → 405
    const clashTip = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs()).get("refs/heads/clash")?.target as string;
    const bad = await send(`${REPO}/pulls/${index}/merge`, jsonInit("POST", { do: "manually-merged", merge_commit_id: clashTip }));
    expect(bad.status).toBe(405);

    expect((await send(`${REPO}/pulls/${index}/merge`, jsonInit("POST", { do: "manually-merged", merge_commit_id: mainTip }))).status).toBe(200);
    const pr = await jsonBody(await get(`${REPO}/pulls/${index}`));
    expect(pr.merged).toBe(true);
    expect(pr.merge_commit_sha).toBe(mainTip);
  });
});

// ---------------------------------------------------------------------------
// (C) commits family
// ---------------------------------------------------------------------------

describe("commits family (repoGetAllCommits / repoGetSingleCommit / dot-diff / commit-pull / compare)", () => {
  it("lists commits with pagination + the X-* family; 409 on an empty repo", async () => {
    const res = await get(`${REPO}/commits?limit=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).not.toBeNull();
    expect(res.headers.get("Link")).not.toBeNull();
    const commits: Array<Record<string, unknown>> = await res.json();
    expect(commits).toHaveLength(2);
    expect((commits[0]?.stats as Record<string, unknown> | undefined)).toBeDefined();
    expect(((commits[0]?.commit as Record<string, unknown>).author as Record<string, unknown>).date).toBeDefined();

    // STRICT sha resolution: upstream GetAllCommits answers the APIErrorAuto
    // 404 for a non-empty sha GetCommit cannot resolve (commits.go:211-216) —
    // never the default branch's history (the old fallback's 200-with-tip).
    expect((await get(`${REPO}/commits?sha=zzz-ghost`)).status).toBe(404);

    await new RepoService(env.DB).create({
      owner: { id: OWNER_ID, usernameLower: OWNER },
      name: "empty-commits",
      isPrivate: false,
      status: "ready",
    });
    const emptyRes = await get(`/repos/${OWNER}/empty-commits/commits`);
    expect(emptyRes.status).toBe(409);
    const body: Record<string, unknown> = await emptyRes.json();
    expect(body.message).toBe("Git Repository is empty.");
  });

  it("renders a single commit by ref or sha; the dot-suffix diff/patch", async () => {
    const single = await get(`${REPO}/git/commits/main`);
    expect(single.status).toBe(200);
    const commit: Record<string, unknown> = await single.json();
    expect(commit.sha).not.toBe("");

    const bySha = await get(`${REPO}/git/commits/${String(commit.sha)}`);
    expect(bySha.status).toBe(200);
    expect((await jsonBody(bySha)).sha).toBe(commit.sha);
    expect((await get(`${REPO}/git/commits/${"d".repeat(40)}`)).status).toBe(404);
    // The non-hex unknown arm is upstream's getCommit 404 too
    // ("commit doesn't exist", commits.go:78-84) — never the default tip.
    expect((await get(`${REPO}/git/commits/zzz-ghost`)).status).toBe(404);

    const diff = await get(`${REPO}/git/commits/${String(commit.sha)}.diff`);
    expect(diff.status).toBe(200);
    expect(await diff.text()).toContain("diff --git ");
    const patch = await get(`${REPO}/git/commits/${String(commit.sha)}.patch`);
    expect(patch.status).toBe(200);
    expect(await patch.text()).toContain("Subject: [PATCH]");
  });

  it("resolves the PR behind a commit sha (the head_sha join)", async () => {
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    const topicTip = tips.get("refs/pull/1/head")?.target as string;
    const res = await get(`${REPO}/commits/${topicTip}/pull`);
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).number).toBe(1);
    expect((await get(`${REPO}/commits/${TIP1}/pull`)).status).toBe(404);
    // An unresolvable non-hex sha 404s the same way (getCommit-style refusal).
    expect((await get(`${REPO}/commits/zzz-ghost/pull`)).status).toBe(404);
  });

  it("compares base...head (JSON) and answers raw text for output=diff", async () => {
    // a fresh unmerged branch: exactly one commit ahead of the current main
    await seedBranchWithCommit("cmp", "cmp.txt", "cmp\n");
    const res = await get(`${REPO}/compare/main...cmp`);
    expect(res.status).toBe(200);
    const compare: Record<string, unknown> = await res.json();
    expect(compare.total_commits).toBe(1);
    expect((compare.commits as Array<Record<string, unknown>>)[0]?.sha).not.toBe("");

    const twoDot = await get(`${REPO}/compare/main..cmp`);
    expect(twoDot.status).toBe(200);

    const diff = await get(`${REPO}/compare/main...cmp?output=diff`);
    expect(diff.status).toBe(200);
    expect(await diff.text()).toContain("diff --git a/cmp.txt");

    expect((await get(`${REPO}/compare/main`)).status).toBe(400);
    expect((await get(`${REPO}/compare/main...ghost`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// delete_branch_after_merge — the default-branch head guard
// ---------------------------------------------------------------------------

describe("merge delete_branch_after_merge — the default-branch head guard", () => {
  it("refuses to delete the repo's default branch as PR head — merge lands, branch survives", async () => {
    // release starts at main's tip (POST /branches sources the default
    // branch), then main advances one commit past it so the PR is mergeable
    const branch = await send(`${REPO}/branches`, jsonInit("POST", { new_branch_name: "release" }));
    expect(branch.status).toBe(201);
    const advanced = await send(`${REPO}/contents/guard.txt`, jsonInit("POST", { content: btoa("guard\n"), branch: "main", message: "main: guard" }));
    expect(advanced.status).toBe(201);
    const mainTip = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs()).get("refs/heads/main")?.target as string;

    const created = await send(`${REPO}/pulls`, jsonInit("POST", { title: "main into release", head: "main", base: "release" }));
    expect(created.status).toBe(201);
    const index = (await jsonBody(created)).number as number;

    const merge = await send(`${REPO}/pulls/${index}/merge`, jsonInit("POST", { do: "merge", delete_branch_after_merge: true }));
    expect(merge.status).toBe(200);

    // the merge landed on the base (release moved to a two-parent commit)…
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    const release = await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).readCommit(tips.get("refs/heads/release")?.target);
    expect(release?.parents).toHaveLength(2);
    // …but the default-branch head SURVIVES (upstream CanDeleteBranchWithPermission
    // → ErrBranchIsDefault; the merge caller logs Debug and ignores it)
    expect(tips.get("refs/heads/main")?.target).toBe(mainTip);
    expect((await jsonBody(await get(`${REPO}/pulls/${index}`))).merged).toBe(true);
  });

  it("still deletes an ordinary head branch when delete_branch_after_merge is set", async () => {
    const headTip = await seedBranchWithCommit("delbranch", "del.txt", "del\n");
    const created = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Delete my branch", head: "delbranch", base: "main" }));
    expect(created.status).toBe(201);
    const index = (await jsonBody(created)).number as number;

    expect((await send(`${REPO}/pulls/${index}/merge`, jsonInit("POST", { do: "merge", delete_branch_after_merge: true }))).status).toBe(200);

    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect(tips.get("refs/heads/delbranch")).toBeUndefined();
    // the pull head ref survives the branch delete
    expect(tips.get(`refs/pull/${index}/head`)?.target).toBe(headTip);
  });
});

// ---------------------------------------------------------------------------
// delete_branch_after_merge — the shared-head and protected-branch guards
// ---------------------------------------------------------------------------

describe("merge delete_branch_after_merge — the shared-head and protected-branch guards", () => {
  it("keeps the head branch while another open PR shares it; deletes once clear; a different-branch control still deletes", async () => {
    const headTip = await seedBranchWithCommit("sharedhead", "sharedhead.txt", "shared head\n");
    const first = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Shared head one", head: "sharedhead", base: "main" }));
    expect(first.status).toBe(201);
    const firstIndex = (await jsonBody(first)).number as number;

    // a second OPEN PR from the same head onto a different base (the same
    // head+base pair answers 409): upstream's shared-head guard
    // (HasUnmergedPullRequestsByHeadInfo) matches by head repo+branch only,
    // so the second PR keeps the branch alive
    const rel = await send(`${REPO}/branches`, jsonInit("POST", { new_branch_name: "sharedrel" }));
    expect(rel.status).toBe(201);
    const second = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Shared head two", head: "sharedhead", base: "sharedrel" }));
    expect(second.status).toBe(201);
    const secondIndex = (await jsonBody(second)).number as number;

    // merging the FIRST shared-head PR with the delete flag: the branch
    // SURVIVES (the still-open second PR keeps it)…
    expect((await send(`${REPO}/pulls/${firstIndex}/merge`, jsonInit("POST", { do: "merge", delete_branch_after_merge: true }))).status).toBe(200);
    const tipsAfterFirst = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect(tipsAfterFirst.get("refs/heads/sharedhead")?.target).toBe(headTip);
    expect((await jsonBody(await get(`${REPO}/pulls/${secondIndex}`))).state).toBe("open");

    // …and merging the SECOND leaves no other open PR on the head: the
    // delete now fires
    expect((await send(`${REPO}/pulls/${secondIndex}/merge`, jsonInit("POST", { do: "merge", delete_branch_after_merge: true }))).status).toBe(200);
    expect(refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs()).get("refs/heads/sharedhead")).toBeUndefined();

    // control: a delete-branch merge on a DIFFERENT branch still deletes
    await seedBranchWithCommit("sharedctl", "sharedctl.txt", "shared control\n");
    const ctl = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Shared control", head: "sharedctl", base: "main" }));
    expect(ctl.status).toBe(201);
    const ctlIndex = (await jsonBody(ctl)).number as number;
    expect((await send(`${REPO}/pulls/${ctlIndex}/merge`, jsonInit("POST", { do: "merge", delete_branch_after_merge: true }))).status).toBe(200);
    expect(refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs()).get("refs/heads/sharedctl")).toBeUndefined();
  });

  it("keeps a rule-protected head branch the doer cannot delete; an unprotected control still deletes", async () => {
    await seedBranchWithCommit("protbranch", "prot.txt", "protected head\n");
    const created = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Protected head", head: "protbranch", base: "main" }));
    expect(created.status).toBe(201);
    const index = (await jsonBody(created)).number as number;

    // a first-match rule for the head branch carrying the ZERO config:
    // can_delete=false refuses every writer including the repo owner
    // (CanUserDelete → ErrBranchIsProtected); the branch+commit above landed
    // BEFORE the rule, so the write paths never see it
    const repoId = (await drizzle(env.DB).select({ id: repositories.id }).from(repositories).where(eq(repositories.slug, SLUG)).get())?.id;
    expect(repoId).toBeDefined();
    await drizzle(env.DB).insert(protectedBranches).values({
      repoId: repoId as string,
      ruleName: "protbranch",
      priority: 0,
      rules: serializeRuleConfig(emptyRuleConfig()),
      createdAt: new Date(T0 * 1000),
      updatedAt: new Date(T0 * 1000),
    });

    // the merge lands 200 (skip-not-error) and the protected branch SURVIVES
    expect((await send(`${REPO}/pulls/${index}/merge`, jsonInit("POST", { do: "merge", delete_branch_after_merge: true }))).status).toBe(200);
    expect(refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs()).get("refs/heads/protbranch")).toBeDefined();
    expect((await jsonBody(await get(`${REPO}/pulls/${index}`))).merged).toBe(true);

    // control: an UNPROTECTED branch still deletes under the same rule repo
    await seedBranchWithCommit("protctl", "protctl.txt", "protected control\n");
    const ctl = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Protected control", head: "protctl", base: "main" }));
    expect(ctl.status).toBe(201);
    const ctlIndex = (await jsonBody(ctl)).number as number;
    expect((await send(`${REPO}/pulls/${ctlIndex}/merge`, jsonInit("POST", { do: "merge", delete_branch_after_merge: true }))).status).toBe(200);
    expect(refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs()).get("refs/heads/protctl")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// delete_branch_after_merge — the fork-head arms (upstream
// DeleteBranchAfterMerge operates on pr.HeadRepo,
// services/repository/branch.go:812-822 — the fork's own branch, guards
// against the fork's state and the doer's permission THERE)
// ---------------------------------------------------------------------------

const RECEIVE_CT = "application/x-git-receive-pack-request";

/**
 * One deterministic feature commit on top of the suite's two-seed history
 * (full tree per commit, fixed time → stable oid across calls, so the same
 * pack can land in BOTH cells).
 */
function forkFeatureCommit(name: string, content: string, time: number): SeedCommit {
  return {
    message: `fork: ${name}`,
    time,
    files: [
      { path: "README.md", content: "# pull engine suite\n" },
      { path: "shared.txt", content: "shared base\n" },
      { path: "docs/base.txt", content: "base doc\n" },
      { path: name, content },
    ],
  };
}

/** Mint (delete-first, the ensureSeededRepo pattern) a push token for a user. */
async function mintPushToken(userId: number, name: string): Promise<string> {
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?").bind(userId, name).run();
  return (await mintFor(userId, name, "write:repository")).plaintext;
}

/**
 * Receive-push into a repo cell, creating only the refs that are absent —
 * the deterministic oids make a re-run a no-op (the ensureSeededRepo guard
 * pattern, kept because a create-over-existing ref command would be refused).
 */
async function pushRefsIfAbsent(engineRepo: string, token: string, updates: { ref: string; oid: string }[], pack: Uint8Array): Promise<void> {
  const have = new Set((await env.REPO.getByName(engineRepo).listRefs()).refs.map((ref) => ref.name));
  const missing = updates.filter((update) => !have.has(update.ref));
  if (missing.length === 0) return;
  const response = await SELF.fetch(`https://test.local/${engineRepo}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
    body: buildReceivePackBody(missing, pack),
  });
  const body = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || body.includes("ng ")) {
    throw new Error(`fork-seed push failed (${engineRepo}): ${response.status} ${body.slice(0, 400)}`);
  }
}

async function repoIdOf(owner: string, slug: string): Promise<string> {
  const row = await drizzle(env.DB)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, owner.toLowerCase()), eq(repositories.slug, slug)))
    .get();
  if (row === undefined) throw new Error(`repo row missing: ${owner}/${slug}`);
  return row.id;
}

/**
 * Seed a fork-head PR (two repos): `forkOwner/forkSlug` carries the suite's
 * base history plus ONE feature commit — on the fork's default `main` when
 * `onDefaultBranch`, else on `refs/heads/${forkBranch}`. Deterministic oids
 * keep a re-run a no-op over the persistent DO cells.
 *
 * Since a16f60e the fork PR IS API-reachable, so the PR itself goes through
 * the REAL POST /pulls fork path — head `owner/slug:branch` resolves the fork
 * (the suite owner reads it; the forks are public seeds), the merge base
 * computes IN THE FORK CELL (the FetchRemoteTempCommit base fetch included —
 * the base main has usually advanced past the fork point by fork-test time),
 * the head closure carries into the base cell, the row lands with its merge
 * base, and the route writes `refs/pull/N/head`. The 2e3db28 bypass — the
 * feature pack staged into the base cell behind a scratch `forkstage`
 * branch, the row created through IssuesService directly — is gone: none of
 * these tests constructs a state the API cannot produce (their subjects are
 * the merge-time head guards, all reachable states). What REMAINS seeded is
 * only the fork's content (repo rows + refs via the receive flow) — the pull
 * API creates PRs, it does not author repo content, so the fork's commits
 * must pre-exist for the same reason the suite's own branches do.
 */
async function seedForkHeadPr(options: {
  forkOwner: string;
  forkSlug: string;
  forkBranch: string;
  onDefaultBranch?: boolean;
  featurePath: string;
  featureContent: string;
}): Promise<{ index: number; forkRepoId: string; featureTip: string }> {
  const headBranch = options.onDefaultBranch === true ? "main" : options.forkBranch;
  const feature = forkFeatureCommit(options.featurePath, options.featureContent, T0 + 100);
  const { tips, pack } = await buildHistoryPack([...SEED_COMMITS, feature]);
  const featureTip = tips[2] as string;

  // the fork: base history + the feature ref (its default main carries the
  // feature commit directly in the onDefaultBranch variant)
  const forkCommits = options.onDefaultBranch === true ? [...SEED_COMMITS, feature] : SEED_COMMITS;
  await ensureSeededRepo({ owner: options.forkOwner, slug: options.forkSlug, commits: forkCommits });
  if (options.onDefaultBranch !== true) {
    const ownerRow = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, options.forkOwner.toLowerCase())).get();
    if (ownerRow === undefined) throw new Error("fork owner missing");
    const forkToken = await mintPushToken(ownerRow.id, `pull-engine-fork-push-${options.forkSlug}`);
    await pushRefsIfAbsent(`${options.forkOwner}/${options.forkSlug}`, forkToken, [{ ref: `refs/heads/${options.forkBranch}`, oid: featureTip }], pack);
  }

  // the PR: the real POST /pulls fork path (head `owner/slug:branch`) — the
  // fork-edge create runs the whole choreography (merge base in the fork
  // cell, head closure carried into the base cell, D1 row, refs/pull/N/head).
  const created = await send(`${REPO}/pulls`, jsonInit("POST", {
    title: `Fork change: ${options.featurePath}`,
    head: `${options.forkOwner}/${options.forkSlug}:${headBranch}`,
    base: "main",
  }));
  expect(created.status).toBe(201);
  const pr: Record<string, unknown> = await created.json();

  const forkRepoId = await repoIdOf(options.forkOwner, options.forkSlug);
  return { index: pr.number as number, forkRepoId, featureTip };
}

describe("merge delete_branch_after_merge — the fork-head arms", () => {
  it("deletes the FORK's head branch after the merge — the fork's default branch and the base survive", async () => {
    const seeded = await seedForkHeadPr({ forkOwner: OWNER, forkSlug: "fork-delete", forkBranch: "forktopic", featurePath: "fork-delete.txt", featureContent: "from the fork\n" });
    const mainTip = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs()).get("refs/heads/main")?.target as string;

    const merge = await send(`${REPO}/pulls/${seeded.index}/merge`, jsonInit("POST", { do: "merge", delete_branch_after_merge: true }));
    expect(merge.status).toBe(200);
    expect((await jsonBody(await get(`${REPO}/pulls/${seeded.index}`))).merged).toBe(true);

    // the fork's feature branch is GONE; the fork's own default branch stays
    const forkTips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: "fork-delete" }).listRefs());
    expect(forkTips.get("refs/heads/forktopic")).toBeUndefined();
    expect(forkTips.get("refs/heads/main")).toBeDefined();

    // the merge landed on the base (main advanced), which never loses a branch
    const baseTips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect(baseTips.get("refs/heads/main")?.target).not.toBe(mainTip);
    expect(baseTips.get(`refs/pull/${seeded.index}/head`)?.target).toBe(seeded.featureTip);
  });

  it("keeps the FORK's default branch as a fork PR head — the default arm reads the head repo's default", async () => {
    // the fork's main is AHEAD of the base main (the feature descends from
    // the shared base), so the PR is mergeable and head == fork default
    const seeded = await seedForkHeadPr({ forkOwner: OWNER, forkSlug: "fork-default", forkBranch: "main", onDefaultBranch: true, featurePath: "fork-default.txt", featureContent: "ahead on fork main\n" });

    const merge = await send(`${REPO}/pulls/${seeded.index}/merge`, jsonInit("POST", { do: "merge", delete_branch_after_merge: true }));
    expect(merge.status).toBe(200);

    // upstream CanDeleteBranchWithPermission evaluates
    // branch == pr.HeadRepo.DefaultBranch (branch.go:562-564) — the fork's
    // main SURVIVES; the merge still lands
    const forkTips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: "fork-default" }).listRefs());
    expect(forkTips.get("refs/heads/main")?.target).toBe(seeded.featureTip);
    expect((await jsonBody(await get(`${REPO}/pulls/${seeded.index}`))).merged).toBe(true);
  });

  it("keeps a fork-side rule-protected head branch — the protected arm reads the head repo's rules", async () => {
    const seeded = await seedForkHeadPr({ forkOwner: OWNER, forkSlug: "fork-protected", forkBranch: "protfork", featurePath: "fork-prot.txt", featureContent: "protected on the fork\n" });

    // the ZERO config on the FORK's repo id: can_delete=false refuses every
    // writer including the fork owner (CanUserDelete → ErrBranchIsProtected)
    await drizzle(env.DB).insert(protectedBranches).values({
      repoId: seeded.forkRepoId,
      ruleName: "protfork",
      priority: 0,
      rules: serializeRuleConfig(emptyRuleConfig()),
      createdAt: new Date(T0 * 1000),
      updatedAt: new Date(T0 * 1000),
    });

    const merge = await send(`${REPO}/pulls/${seeded.index}/merge`, jsonInit("POST", { do: "merge", delete_branch_after_merge: true }));
    expect(merge.status).toBe(200);

    // the fork-side rule (not any base rule) kept the branch; merged anyway
    const forkTips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: "fork-protected" }).listRefs());
    expect(forkTips.get("refs/heads/protfork")).toBeDefined();
    expect((await jsonBody(await get(`${REPO}/pulls/${seeded.index}`))).merged).toBe(true);
  });

  it("keeps the fork's head branch when the doer holds no write on the fork — the write arm is the head repo's", async () => {
    // a fork owned by a SECOND user; the suite owner (base maintainer) merges
    const seeded = await seedForkHeadPr({ forkOwner: "forkkeeper", forkSlug: "outside", forkBranch: "outsidetopic", featurePath: "outside.txt", featureContent: "outside fork\n" });

    const merge = await send(`${REPO}/pulls/${seeded.index}/merge`, jsonInit("POST", { do: "merge", delete_branch_after_merge: true }));
    expect(merge.status).toBe(200);

    // upstream CanDeleteBranch resolves GetDoerRepoPermission(pr.HeadRepo)
    // (branch.go:551-557) and refuses without CanWrite(unit.TypeCode) there
    // (branch.go:564-566) — the base maintainer holds no write on someone
    // else's fork, so the branch SURVIVES (the merge lands regardless)
    const forkTips = refTipMap(await engineReads(env, { ownerNamespace: "forkkeeper", slug: "outside" }).listRefs());
    expect(forkTips.get("refs/heads/outsidetopic")).toBeDefined();
    expect((await jsonBody(await get(`${REPO}/pulls/${seeded.index}`))).merged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// wave-129 batch 9 — the .diff/.patch download tails' EDGE arms (SPEC-0004
// §2.4 repoDownloadPullDiffOrPatch over services/pull-engine.ts's three-dot
// range + git-models.ts renderUnifiedDiff/renderPatch) and the /files range
// pagination + status arms (repoGetPullRequestFiles over toChangedFiles).
// The engine's truncation caps are DOCUMENTED: SPEC-0001b §3 row "caps:
// MAX_DIFF_FILES=100, MAX_DIFF_BLOB=512 KiB, truncated flag".
// ---------------------------------------------------------------------------

describe("PR .diff/.patch tails — the empty-range, binary and truncation-cap arms", () => {
  it("renders an EMPTY range as an empty .diff body and a header-only .patch mail", async () => {
    // Across-ref equal tips (the routes/pulls.test.ts empty-PR create arm):
    // the branch sits at main's exact tip, so the range diff is
    // renderUnifiedDiff([]) === "" — upstream `git diff base...head` with
    // nothing to show.
    const branch = await send(`${REPO}/branches`, jsonInit("POST", { new_branch_name: "empty-twin" }));
    expect(branch.status).toBe(201);
    const created = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Empty range tail", head: "empty-twin", base: "main" }));
    expect(created.status).toBe(201);
    const index = (await jsonBody(created)).number as number;

    const diff = await get(`${REPO}/pulls/${index}.diff`);
    expect(diff.status).toBe(200);
    expect(diff.headers.get("content-type")).toContain("text/plain");
    expect(await diff.text()).toBe("");

    const patch = await get(`${REPO}/pulls/${index}.patch`);
    expect(patch.status).toBe(200);
    const patchText = await patch.text();
    // The format-patch mail shape (git-models.ts renderPatch): the From-sep
    // header line, the [PATCH] subject, the --- divider — and NO file
    // sections.
    expect(patchText.startsWith("From ")).toBe(true);
    expect(patchText).toContain("Subject: [PATCH]");
    expect(patchText).toContain("---");
    expect(patchText).toContain("-- \n2.47.0"); // the format-patch signature tail
    expect(patchText).not.toContain("diff --git");
  });

  it("renders a binary change as the 'Binary files … differ' line in both tails", async () => {
    // A NUL byte inside the first 8000 bytes is the engine's isBinary probe
    // (git-engine git/diff.ts:145); the byte-exact write rides the contents
    // API's base64 decode. The PNG magic keeps the shape honest.
    const pngMagic = String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x1a);
    const tip = await seedBranchWithCommit("bindiff", "logo.bin", `${pngMagic}binary tail arm\n`);
    expect(tip).not.toBe("");
    const created = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Binary tail", head: "bindiff", base: "main" }));
    expect(created.status).toBe(201);
    const index = (await jsonBody(created)).number as number;

    const diff = await get(`${REPO}/pulls/${index}.diff`);
    expect(diff.status).toBe(200);
    const text = await diff.text();
    expect(text).toContain("diff --git a/logo.bin b/logo.bin");
    // A CREATED binary: the old side is /dev/null on the differ line
    // (renderUnifiedDiff's oldPath pick).
    expect(text).toContain("Binary files /dev/null and b/logo.bin differ");
    // No text section for the binary arm: no ---/+++ pair, no hunks.
    expect(text).not.toContain("--- a/logo.bin");
    expect(text).not.toContain("+++ b/logo.bin");
    expect(text).not.toContain("@@ -");

    const patch = await get(`${REPO}/pulls/${index}.patch`);
    expect(patch.status).toBe(200);
    const patchText = await patch.text();
    // The patch mail anchors on the range HEAD commit (seedBranchWithCommit's
    // `${branch}: ${path}` message) and carries the same binary line.
    expect(patchText).toContain("Subject: [PATCH] bindiff: logo.bin");
    expect(patchText).toContain("Binary files /dev/null and b/logo.bin differ");
  });

  it("caps one diff at the engine's documented MAX_DIFF_FILES=100 (SPEC-0001b §3)", async () => {
    // A fresh deterministic cell: main at the suite's base tip, a topic
    // branch changing 101 files in one commit. computeDiff walks the sorted
    // path union and stops after the cap (git-engine repo.ts
    // `if (files.length >= MAX_DIFF_FILES) truncated`), so the FIRST 100
    // sorted paths render and the 101st truncates out of every tail.
    const base = [SEED_COMMITS[0] as SeedCommit, SEED_COMMITS[1] as SeedCommit];
    const capFiles = Array.from({ length: 101 }, (_, i) => ({
      path: `cap/file-${String(i).padStart(3, "0")}.txt`,
      content: `cap ${i}\n`,
    }));
    const feature: SeedCommit = { message: "cap: the truncation storm", time: T0 + 200, files: [...(base[1] as SeedCommit).files, ...capFiles] };
    await ensureSeededRepo({ owner: OWNER, slug: "difftails", commits: base });
    const { tips, pack } = await buildHistoryPack([...base, feature]);
    const capTip = tips[2] as string;
    const token = await mintPushToken(OWNER_ID, "pull-engine-cap-push");
    await pushRefsIfAbsent(`${OWNER}/difftails`, token, [{ ref: "refs/heads/capstorm", oid: capTip }], pack);

    const created = await send(`/repos/${OWNER}/difftails/pulls`, jsonInit("POST", { title: "Cap storm", head: "capstorm", base: "main" }));
    expect(created.status).toBe(201);
    const index = (await jsonBody(created)).number as number;

    const diff = await get(`/repos/${OWNER}/difftails/pulls/${index}.diff`);
    expect(diff.status).toBe(200);
    const text = await diff.text();
    expect((text.match(/diff --git /g) ?? [])).toHaveLength(100);
    expect(text).toContain("cap/file-000.txt");
    expect(text).not.toContain("cap/file-100.txt"); // the 101st sorted path truncates

    const patch = await get(`/repos/${OWNER}/difftails/pulls/${index}.patch`);
    expect(patch.status).toBe(200);
    const patchText = await patch.text();
    expect(patchText).toContain("Subject: [PATCH] cap: the truncation storm");
    expect((patchText.match(/diff --git /g) ?? [])).toHaveLength(100);
  });

  it("maps the /files range arms: empty range, binary added, file removed — previous_filename always null (no rename detection)", async () => {
    // Find the two PR indexes from the list (the shared suite's counter is
    // never hardcoded — the file's own convention).
    const pulls = (await (await get(`${REPO}/pulls?state=all&limit=50`)).json<Array<Record<string, unknown>>>()).filter(
      (pr) => pr.title === "Binary tail" || pr.title === "Empty range tail",
    );
    const byTitle = new Map(pulls.map((pr) => [pr.title as string, pr.number as number]));
    const binaryIndex = byTitle.get("Binary tail");
    const emptyIndex = byTitle.get("Empty range tail");
    expect(binaryIndex).toBeDefined();
    expect(emptyIndex).toBeDefined();

    const binary = await get(`${REPO}/pulls/${binaryIndex}/files`);
    expect(binary.status).toBe(200);
    expect(binary.headers.get("X-Total-Count")).toBe("1");
    const binaryFiles: Array<Record<string, unknown>> = await binary.json();
    expect(binaryFiles[0]?.filename).toBe("logo.bin");
    expect(binaryFiles[0]?.status).toBe("added");
    expect(binaryFiles[0]?.previous_filename).toBeNull();

    // The deletion arm: a branch that deletes a file (old side present, new
    // side null → "removed").
    const delBranch = await send(`${REPO}/branches`, jsonInit("POST", { new_branch_name: "taildelete" }));
    expect(delBranch.status).toBe(201);
    const readme = await get(`${REPO}/contents/README.md?ref=taildelete`);
    expect(readme.status).toBe(200);
    const readmeSha = ((await jsonBody(readme)).sha) as string;
    const deleted = await send(`${REPO}/contents/README.md`, jsonInit("DELETE", { sha: readmeSha, branch: "taildelete", message: "taildelete: remove README" }));
    expect(deleted.status).toBe(200);
    const delPr = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Removal tail", head: "taildelete", base: "main" }));
    expect(delPr.status).toBe(201);
    const removalIndex = (await jsonBody(delPr)).number as number;

    const removal = await get(`${REPO}/pulls/${removalIndex}/files`);
    expect(removal.status).toBe(200);
    const removalFiles: Array<Record<string, unknown>> = await removal.json();
    expect(removalFiles[0]?.filename).toBe("README.md");
    expect(removalFiles[0]?.status).toBe("removed");
    expect(removalFiles[0]?.previous_filename).toBeNull();

    // The empty range lists zero files with the zero totals.
    const emptyFiles = await get(`${REPO}/pulls/${emptyIndex}/files`);
    expect(emptyFiles.status).toBe(200);
    expect(emptyFiles.headers.get("X-Total-Count")).toBe("0");
    expect(await emptyFiles.json<unknown[]>()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The PR-head SYNC round-trip (SPEC-0005 §3.4 "Sync pushes" — the engine
// review's c1 fix): a second push to a PR's head branch must move
// refs/pull/N/head (through the sync arm in services/webhooks-push.ts), the
// head_sha cache, re-arm the check, land the type-29 comment — and the MERGE
// must then consume the NEW tip. The pushes go through the REAL worker
// (SELF — index.ts's onPush wiring), so the production sync path runs.
// ---------------------------------------------------------------------------

const SYNC_TE = new TextEncoder();

function syncConcat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function syncHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function syncSha1(bytes: Uint8Array): Promise<string> {
  return syncHex(await crypto.subtle.digest("SHA-1", bytes));
}

async function syncSha1Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function rawOid(oidHex: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = Number.parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

/** The type/size varint header of one packed object entry. */
function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

const SYNC_OBJ_COMMIT = 1;
const SYNC_OBJ_TREE = 2;
const SYNC_OBJ_BLOB = 3;

/**
 * Build ONE commit chained on top of `parent` (the incremental-append shape
 * of a real branch update: the pack carries ONLY the new commit's objects —
 * its parent resolves from the receiving cell). File-local copy of the
 * webhooks-push suite's chain builder (seed-repo.ts keeps its byte helpers
 * private and can only chain from a null parent).
 */
async function buildAppendPack(
  parent: string,
  commit: { message: string; files: { path: string; content: string }[]; time: number },
): Promise<{ tip: string; pack: Uint8Array }> {
  const objects = new Map<string, { type: number; body: Uint8Array }>();
  const store = async (type: number, body: Uint8Array): Promise<string> => {
    const typeName = type === SYNC_OBJ_COMMIT ? "commit" : type === SYNC_OBJ_TREE ? "tree" : "blob";
    const raw = syncConcat(SYNC_TE.encode(`${typeName} ${body.length}\0`), body);
    const oid = await syncSha1(raw);
    objects.set(oid, { type, body });
    return oid;
  };
  const entries: { sortKey: string; bytes: Uint8Array }[] = [];
  for (const file of commit.files) {
    const blobOid = await store(SYNC_OBJ_BLOB, SYNC_TE.encode(file.content));
    entries.push({ sortKey: file.path, bytes: syncConcat(SYNC_TE.encode(`100644 ${file.path}\0`), rawOid(blobOid)) });
  }
  entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const treeOid = await store(SYNC_OBJ_TREE, syncConcat(...entries.map((e) => e.bytes)));
  const person = (who: "author" | "committer") => `${who} Sync User <sync@example.com> ${commit.time} +0000`;
  const commitBody = `tree ${treeOid}\nparent ${parent}\n${person("author")}\n${person("committer")}\n\n${commit.message}\n`;
  const tip = await store(SYNC_OBJ_COMMIT, SYNC_TE.encode(commitBody));
  const chunks: Uint8Array[] = [SYNC_TE.encode("PACK"), be32(2), be32(objects.size)];
  for (const obj of objects.values()) {
    chunks.push(objectHeader(obj.type, obj.body.length));
    chunks.push(await zlibDeflate(obj.body));
  }
  chunks.push(await syncSha1Bytes(syncConcat(...chunks)));
  return { tip, pack: syncConcat(...chunks) };
}

/** A receive-pack body with EXPLICIT old oids (the update-command shape —
 *  seed-repo.ts's buildReceivePackBody only writes create commands). */
function buildUpdateReceiveBody(updates: { old: string; oid: string; ref: string }[], pack: Uint8Array): Uint8Array {
  let section = "";
  updates.forEach((update, i) => {
    const line = i === 0 ? `${update.old} ${update.oid} ${update.ref}\0report-status side-band-64k` : `${update.old} ${update.oid} ${update.ref}`;
    section += `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
  });
  section += "0000";
  return syncConcat(SYNC_TE.encode(section), pack);
}

/** Push an UPDATE through the real worker (the production receive → onPush
 *  path) and assert every command applied. */
async function pushUpdate(engineRepo: string, token: string, updates: { old: string; oid: string; ref: string }[], pack: Uint8Array): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${engineRepo}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
    body: buildUpdateReceiveBody(updates, pack),
  });
  const body = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || body.includes("ng ")) {
    throw new Error(`update push failed (${engineRepo}): ${response.status} ${body.slice(0, 400)}`);
  }
}

/** Bounded poll for the drained onPush continuation (the sync arms run inside
 *  SELF's waitUntil — poll the durable effect instead of racing the drain). */
async function waitFor(effect: () => Promise<boolean>, what: string): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    if (await effect()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`sync effect not observed: ${what}`);
}

describe("the PR-head sync round-trip — a second push moves refs/pull/N/head and the merge eats the NEW tip", () => {
  it("create PR → push again → ref/head_sha/checking/comment move → merge lands the SECOND commit", async () => {
    // The topic branch through the API's own write path (the creation-tip
    // contract: refs/pull/N/head lands there through createPullHeadRef).
    const topicTip = await seedBranchWithCommit("sync-topic", "sync-a.txt", "sync a\n");
    const created = await send(`${REPO}/pulls`, jsonInit("POST", { title: "Sync round trip", head: "sync-topic", base: "main" }));
    expect(created.status).toBe(201);
    const index = (await jsonBody(created)).number as number;

    const refTips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect(refTips.get(`refs/pull/${index}/head`)?.target).toBe(topicTip);
    let prRow = await drizzle(env.DB).select().from(pullRequests).where(eq(pullRequests.index, index)).get();
    expect(prRow?.headSha).toBe(topicTip);

    // The SECOND push — a real receive through SELF (the production onPush
    // sync path), one appended commit on the API-authored tip.
    const ownerRow = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get();
    const token = await mintPushToken(ownerRow!.id, "pull-engine-sync-push");
    const append = await buildAppendPack(topicTip, {
      message: "sync: second",
      files: [{ path: "sync-second.txt", content: "second commit body\n" }],
      time: T0 + 500,
    });
    const beforeTip = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs()).get("refs/heads/sync-topic")?.target as string;
    await pushUpdate(`${OWNER}/${SLUG}`, token, [{ old: beforeTip, oid: append.tip, ref: "refs/heads/sync-topic" }], append.pack);

    // The ref moved (the sync arm's CAS — the merge reads THIS ref), the D1
    // arms landed (head_sha cache, status re-armed to checking), and the
    // type-29 comment carries the pushed delta.
    await waitFor(async () => refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs()).get(`refs/pull/${index}/head`)?.target === append.tip, "head ref moved");
    await waitFor(async () => (await drizzle(env.DB).select().from(pullRequests).where(eq(pullRequests.index, index)).get())?.headSha === append.tip, "head_sha cache moved");
    prRow = await drizzle(env.DB).select().from(pullRequests).where(eq(pullRequests.index, index)).get();
    expect(prRow?.status).toBe(PRStatus.Checking);
    const pushCommentRows = (await drizzle(env.DB).select().from(comments).where(eq(comments.issueId, prRow!.issueId)).all()).filter(
      (r) => r.type === CommentType.PullRequestPush,
    );
    expect(pushCommentRows).toHaveLength(1);
    expect(JSON.parse(pushCommentRows[0]!.content ?? "{}")).toEqual({ is_force_push: false, commit_ids: [append.tip] });

    // The re-arm fires: the GET observes checking, runs the read-only check,
    // CASes mergeable — and the merge then consumes the moved ref.
    const rendered = await jsonBody(await get(`${REPO}/pulls/${index}`));
    expect(rendered.mergeable).toBe(true);
    const merge = await send(`${REPO}/pulls/${index}/merge`, jsonInit("POST", { do: "merge", merge_title_field: "Merge sync round trip" }));
    expect(merge.status).toBe(200);

    // GOLD: the merge commit's SECOND parent is the NEW tip, and the merged
    // TREE carries the second commit's file — the merge executed against
    // refs/pull/N/head at its moved value, not the creation tip.
    const mainTip = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs()).get("refs/heads/main")?.target as string;
    const merged = await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).readCommit(mainTip);
    expect(merged?.parents[1]).toBe(append.tip);
    const blob = await env.REPO.getByName(`${OWNER}/${SLUG}`).readBlob(mainTip, "sync-second.txt");
    expect(blob === null ? null : new TextDecoder().decode(blob.data)).toBe("second commit body\n");
    // And the pre-merge diff surface reflected the NEW tip too (its file is
    // in the changed-files list).
    const filesBody = JSON.parse(await (await get(`${REPO}/pulls/${index}/files`)).text()) as Array<Record<string, unknown>>;
    expect(filesBody.some((f) => f.filename === "sync-second.txt")).toBe(true);
  });

  it("a fork-head push carries the new tip into the base cell and moves refs/pull/N/head there", async () => {
    const seeded = await seedForkHeadPr({ forkOwner: OWNER, forkSlug: "fork-sync", forkBranch: "syncfork", featurePath: "fork-sync.txt", featureContent: "fork sync one\n" });

    // A SECOND commit on the fork's branch — the deterministic chain gives
    // the same oids as the seed, tips[3] descending from tips[2] (the PR head).
    const featureA = forkFeatureCommit("fork-sync.txt", "fork sync one\n", T0 + 100);
    const featureB = forkFeatureCommit("fork-sync-second.txt", "fork sync two\n", T0 + 101);
    const { tips, pack } = await buildHistoryPack([...SEED_COMMITS, featureA, featureB]);
    const secondTip = tips[3] as string;
    expect(tips[2]).toBe(seeded.featureTip);

    const token = await mintPushToken((await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get())!.id, "pull-engine-fork-sync");
    await pushUpdate(`${OWNER}/fork-sync`, token, [{ old: seeded.featureTip, oid: secondTip, ref: "refs/heads/syncfork" }], pack);

    // The BASE cell's PR head ref moved to the fork's new tip — the sync arm's
    // fork carry (upstream FetchRemoteTempCommit) landed the objects, then the
    // CAS moved the ref; the head_sha cache followed.
    await waitFor(async () => refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs()).get(`refs/pull/${seeded.index}/head`)?.target === secondTip, "base-cell head ref moved");
    const carried = await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).readCommit(secondTip);
    expect(carried?.message).toContain("fork-sync-second");
    const prRow = await drizzle(env.DB).select().from(pullRequests).where(eq(pullRequests.index, seeded.index)).get();
    expect(prRow?.headSha).toBe(secondTip);
  });
});
