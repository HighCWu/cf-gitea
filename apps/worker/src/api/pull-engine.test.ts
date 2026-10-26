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

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";

import { ensureSeededRepo, type SeedCommit } from "../ui/testing/seed-repo";
import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { users } from "../db/schema";
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
