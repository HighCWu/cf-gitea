/**
 * The repoApplyDiffPatch + repoCancelScheduledAutoMerge routes on REAL engine
 * content (SPEC-0004 §2.4 rows). Local mounts (the REG-MERGE-2 router.ts
 * one-liner is the deferred seam); the repo seeds through the real receive
 * flow, the PR row through the landed IssuesService.
 *
 * Pinned here: the unified-diff apply round-trip (modify + create + delete
 * through one patch → one commit on the branch, the "apply-patch" default
 * message), the apply-failure 422 (context mismatch / binary patch / empty
 * patch), the ErrBranchNotExist 404, the new_branch landing, and the
 * cancel-automerge mirror (missing PR → the ErrPullRequestNotExist message;
 * existing-but-never-scheduled PR → the constant 404 — this backend never
 * schedules auto-merges).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";

import { ensureSeededRepo } from "../ui/testing/seed-repo";
import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { repositories, users } from "../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, STUB_USER, type AuthResolver } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { registerArchiveRoutes } from "./routes/archive";
import { registerDiffPatchRoutes } from "./routes/diffpatch";
import { registerLanguageRoutes } from "./routes/languages";
import { registerPullAutoMergeRoutes } from "./routes/pull-automerge";
import { registerPullRoutes } from "./routes/pulls";
import { IssuesService } from "../issues/service";
import { engineReads } from "./services/engine";
import type { User } from "./models/user";

const ORIGIN = "https://diffpatch-suite.test";
const TOKEN = "diffpatch-suite-token";
const OWNER = "patcher";
const SLUG = "patched";
const REPO_PATH = `/repos/${OWNER}/${SLUG}`;
const T0 = 1_767_000_000;

const SEED_COMMITS = [
  {
    message: "seed: base",
    time: T0,
    files: [
      { path: "README.md", content: "alpha\nbeta\ngamma\n" },
      { path: "doomed.txt", content: "delete me\n" },
    ],
  },
];

let OWNER_ID = 1;
let REPO_ID = "";
let PR_INDEX = 0;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits: SEED_COMMITS });
  const row = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get();
  if (row === undefined) throw new Error("seed owner missing");
  OWNER_ID = row.id;
  const repoRow = await drizzle(env.DB)
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.slug, SLUG))
    .get();
  if (repoRow === undefined) throw new Error("seed repo row missing");
  REPO_ID = repoRow.id;

  // The cancel-automerge victim: a PR row over the seeded repo (the create
  // route's engine validation is not in play here — the service seeds the row).
  const service = new IssuesService(env.DB);
  const pr = await service.createPullRequest({
    repoId: REPO_ID,
    headRepoId: REPO_ID,
    baseBranch: "main",
    headBranch: "main",
    title: "never scheduled",
    posterId: OWNER_ID,
  });
  PR_INDEX = pr.issue.index;
});

function identity(): User {
  return { ...STUB_USER, id: OWNER_ID, login: OWNER, full_name: OWNER, created: new Date(T0 * 1000).toISOString() };
}

const resolver: AuthResolver = { resolveToken: (token: string) => Promise.resolve(token === TOKEN ? identity() : null) };

function app(): OpenAPIHono<ApiEnv> {
  const a = new OpenAPIHono<ApiEnv>();
  a.onError(giteaErrorHandler);
  const requireAuth = createTokenAuthMiddleware(resolver);
  registerDiffPatchRoutes(a, requireAuth);
  registerPullAutoMergeRoutes(a, requireAuth);
  return a;
}

const fetchRoute = (path: string, init?: RequestInit): Promise<Response> =>
  Promise.resolve(app().fetch(new Request(`${ORIGIN}${path}`, init), env));

/** The parsed body of an in-process response (the house JSON.parse pattern). */
async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

const authed = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------
// POST /repos/{owner}/{repo}/diffpatch
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/diffpatch (repoApplyDiffPatch)", () => {
  it("applies a multi-file unified diff as ONE commit and lands it on the branch", async () => {
    const patch = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "diff --git a/created.txt b/created.txt",
      "new file mode 100644",
      "index 0000000..3333333",
      "--- /dev/null",
      "+++ b/created.txt",
      "@@ -0,0 +1 @@",
      "+created by the patch",
      "diff --git a/doomed.txt b/doomed.txt",
      "deleted file mode 100644",
      "index 4444444..0000000",
      "--- a/doomed.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-delete me",
      "",
    ].join("\n");
    const res = await fetchRoute(`${REPO_PATH}/diffpatch`, authed("POST", { content: patch }));
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    const commit = body.commit as { sha: string; message: string; parents: Array<{ sha: string }> };
    expect(commit.message).toBe("apply-patch"); // the upstream default
    expect(commit.parents).toHaveLength(1);
    expect(body.content).toBeNull();
    expect(body.verification).toMatchObject({ verified: false, reason: "gpg.error.not_signed_commit" });

    // the landed tree: modified + created + deleted, one parent chain
    const reads = engineReads(env, { ownerNamespace: OWNER.toLowerCase(), slug: SLUG });
    const readme = await reads.readBlob(undefined, "README.md");
    expect(readme === null ? "" : new TextDecoder().decode(readme.data)).toBe("alpha\nBETA\ngamma\n");
    const created = await reads.readBlob(undefined, "created.txt");
    expect(created === null ? "" : new TextDecoder().decode(created.data)).toBe("created by the patch\n");
    expect(await reads.readBlob(undefined, "doomed.txt")).toBeNull();
    const head = await reads.readCommit(undefined);
    expect(head?.oid).toBe(commit.sha);
  });

  it("commits onto new_branch when given (base branch untouched)", async () => {
    const patch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1,3 +1,4 @@",
      " alpha",
      " BETA",
      " gamma",
      "+from a topic branch",
    ].join("\n");
    const res = await fetchRoute(`${REPO_PATH}/diffpatch`, authed("POST", { content: patch, new_branch: "patch-topic" }));
    expect(res.status).toBe(200);
    const reads = engineReads(env, { ownerNamespace: OWNER.toLowerCase(), slug: SLUG });
    const topic = await reads.readBlob("refs/heads/patch-topic", "README.md");
    expect(topic === null ? "" : new TextDecoder().decode(topic.data)).toBe("alpha\nBETA\ngamma\nfrom a topic branch\n");
    const main = await reads.readBlob("refs/heads/main", "README.md");
    expect(main === null ? "" : new TextDecoder().decode(main.data)).toBe("alpha\nBETA\ngamma\n");
  });

  it("422s a patch whose context does not match (and never lands a commit)", async () => {
    const patch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-no such line here",
      "+replacement",
    ].join("\n");
    const res = await fetchRoute(`${REPO_PATH}/diffpatch`, authed("POST", { content: patch }));
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).message).toContain("patch does not apply");
  });

  it("422s binary sections and empty patches", async () => {
    const binary = await fetchRoute(
      `${REPO_PATH}/diffpatch`,
      authed("POST", { content: "diff --git a/blob.bin b/blob.bin\nGIT binary patch\nliteral 10\n" }),
    );
    expect(binary.status).toBe(422);
    expect((await jsonBody(binary)).message).toContain("binary");

    const empty = await fetchRoute(`${REPO_PATH}/diffpatch`, authed("POST", { content: "not a patch at all\n" }));
    expect(empty.status).toBe(422);
    expect((await jsonBody(empty)).message).toContain("no file sections");
  });

  it("404s an unknown base branch with the ErrBranchNotExist message", async () => {
    const patch = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-alpha\n+ALPHA\n";
    const res = await fetchRoute(`${REPO_PATH}/diffpatch`, authed("POST", { content: patch, branch: "ghost" }));
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).message).toContain("branch does not exist [name: ghost]");
  });

  it("401s anonymous callers (requireAuth stand-in for upstream reqRepoWriter)", async () => {
    const res = await fetchRoute(`${REPO_PATH}/diffpatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("404s a missing repository", async () => {
    const res = await fetchRoute("/repos/patcher/ghost/diffpatch", authed("POST", { content: "x" }));
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).message).toBe("not found");
  });
});

// ---------------------------------------------------------------------------
// DELETE /repos/{owner}/{repo}/pulls/{index}/merge
// ---------------------------------------------------------------------------

describe("DELETE /repos/{owner}/{repo}/pulls/{index}/merge (repoCancelScheduledAutoMerge)", () => {
  it("answers the upstream not-scheduled 404 for an existing PR (this backend never schedules)", async () => {
    const res = await fetchRoute(`${REPO_PATH}/pulls/${PR_INDEX}/merge`, authed("DELETE", {}));
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).message).toBe("not found");
  });

  it("answers the ErrPullRequestNotExist 404 for a missing index", async () => {
    const res = await fetchRoute(`${REPO_PATH}/pulls/999/merge`, authed("DELETE", {}));
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).message).toContain("pull request does not exist");
  });

  it("401s anonymous callers", async () => {
    const res = await fetchRoute(`${REPO_PATH}/pulls/1/merge`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The registration scratch-mount (the router.ts one-liner is contended by the
// parallel registration wave, so this file proves the coexistence shape it
// will wire): pulls.ts owns GET/POST on /repos/{owner}/{repo}/pulls/{index}/
// merge; this module owns the DELETE. Mounting BOTH modules into one app must
// (a) generate one merged path item with three distinct operations and
// (b) keep every method routed to its owner.
// ---------------------------------------------------------------------------

describe("scratch mount: pulls.ts + the straggler registerX one-liners share one app", () => {
  /** The exact app shape createApiRouter will assemble after registration. */
  function fullApp(): OpenAPIHono<ApiEnv> {
    const a = new OpenAPIHono<ApiEnv>();
    a.onError(giteaErrorHandler);
    const requireAuth = createTokenAuthMiddleware(resolver);
    const optionalAuth = createOptionalTokenAuthMiddleware(resolver);
    registerPullRoutes(a, requireAuth, optionalAuth);
    registerDiffPatchRoutes(a, requireAuth);
    registerPullAutoMergeRoutes(a, requireAuth);
    registerArchiveRoutes(a, requireAuth, optionalAuth);
    registerLanguageRoutes(a, requireAuth, optionalAuth);
    return a;
  }

  it("generates one merged pulls/merge path item: get + post + delete, distinct operation ids", () => {
    const doc = fullApp().getOpenAPIDocument({
      openapi: "3.0.3",
      info: { title: "scratch", version: "0" },
    });
    const paths = doc.paths as Record<string, Record<string, { operationId?: string }>>;
    const mergeItem = paths["/repos/{owner}/{repo}/pulls/{index}/merge"];
    expect(Object.keys(mergeItem ?? {}).sort()).toEqual(["delete", "get", "post"]);
    expect(mergeItem?.get?.operationId).toBe("repoPullRequestIsMerged");
    expect(mergeItem?.post?.operationId).toBe("repoMergePullRequest");
    expect(mergeItem?.delete?.operationId).toBe("repoCancelScheduledAutoMerge");
    // and the other three straggler paths are in the same document
    expect(paths["/repos/{owner}/{repo}/archive/{archive}"]).toBeDefined();
    expect(paths["/repos/{owner}/{repo}/diffpatch"]).toBeDefined();
    expect(paths["/repos/{owner}/{repo}/languages"]).toBeDefined();
  });

  it("routes each method to its owner through the shared mount", async () => {
    const app = fullApp();
    const send = (path: string, init?: RequestInit): Promise<Response> =>
      Promise.resolve(app.fetch(new Request(`${ORIGIN}${path}`, init), env));

    // pulls.ts GET (not merged → its 404), my DELETE (never scheduled → 404)
    const get = await send(`${REPO_PATH}/pulls/${PR_INDEX}/merge`);
    expect(get.status).toBe(404);
    expect((await jsonBody(get)).message).toBe("not found");
    const del = await send(`${REPO_PATH}/pulls/${PR_INDEX}/merge`, authed("DELETE", {}));
    expect(del.status).toBe(404);
    expect((await jsonBody(del)).message).toBe("not found");
  });
});
