/**
 * Tier-1 PR-block routes on real D1 (SPEC-0004 §2.4 rows repoListPullRequests
 * / repoCreatePullRequest / repoGetPullRequest / repoEditPullRequest /
 * repoGetPullRequestByBaseHead; behavior per SPEC-0005 §2.4). Pins:
 * the shared per-repo index sequence (issues?type=pulls lists the PR; PR
 * indexes interleave with issue indexes), the ToPullRequest field fidelity
 * (url/html_url on the /pulls/ path, head.ref = refs/pull/N/head, mergeable
 * NULL until the engine wave, the merged trio only when merged, WIP draft),
 * the upstream list quirks (absent/garbage state lists BOTH states; sort
 * falls back silently), POST's head==base 422 and duplicate-target 409
 * (issue_id carries the INDEX), the PATCH 201 quirk + merged-state 412
 * precondition + content_version CAS 409, the base/head column lookup, and
 * the webhook triggers (pull_request opened/edited/closed/reopened via
 * emitWebhookDeliveries — rows land inline, the Queue enqueue is the
 * executionCtx-guarded no-op under app.request).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import { comments, issueLabels, issues, labels, milestones, pullRequests, pullReviews, repoCounters, repositories, ReviewType, users, webhookDeliveries, webhooks } from "../db/schema";
import { CommentType } from "../issues/comment-types";
import { IssuesService } from "../issues/service";
import { ZERO_OID, branchRef, engineReads, refTipMap } from "./services/engine";
import { createApiRouter } from "./router";
import { contractModelProperties } from "../compat/contract/frozen-contract";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "webhook_deliveries",
    "webhooks",
    "reactions",
    "issue_subscriptions",
    "issue_pins",
    "pull_requests",
    "pull_reviews",
    "comments",
    "issue_labels",
    "issues",
    "milestones",
    "labels",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The stub token identity is STUB_USER (id 1); pin an explicit id-1 row.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  // The DO cells persist across tests (only D1 is wiped above), so a previous
  // test's createPull left `refs/pull/N/head` behind — the next PR with the
  // same per-repo index would CAS-conflict on the head-ref landing (a 500).
  // Drop them for every repo name this suite creates PRs on; the seed helper
  // re-creates the branches idempotently.
  for (const [ownerLower, slug] of [["alice", "visible"], ["cf-gitea-stub", "visible"]] as const) {
    const cell = env.REPO.getByName(`${ownerLower}/${slug}`);
    const { refs } = await cell.listRefs();
    for (const ref of refs) {
      if (!ref.name.startsWith("refs/pull/")) {
        continue;
      }
      const deleted = await cell.deleteApiRef({ ref: ref.name, expectedOid: ref.target });
      if (deleted.tag === "invalid") {
        throw new Error(`seed ref cleanup failed: ${ref.name} (${deleted.reason})`);
      }
    }
  }
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

const PULL_FIELDS = Object.keys(contractModelProperties("PullRequest")).sort();
const PULL_BRANCH_FIELDS = Object.keys(contractModelProperties("PRBranchInfo")).sort();

const TOKEN = "stub-token";
const authHeaders = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const jsonHeaders = { "Content-Type": "application/json" };
const ERROR_URL = "https://example.com/api/swagger";

let repoSeq = 900;

async function seedUser(username: string): Promise<{ id: number; usernameLower: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, usernameLower: user.usernameLower };
}

async function seedRepo(ownerNamespace: string, slug: string, options: { archived?: boolean } = {}): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    slug,
    visibility: "public",
    isArchived: options.archived ?? false,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await service().ensureRepoCounters(id);
  return id;
}

/** Worker-side object hash (workerd crypto.subtle; putApiObjects re-verifies). */
async function gitObjectOid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Real engine content for the POST family: batch 8 added branch-existence
 * ENGINE reads to repoCreatePullRequest (parseCompareInfo step 1), so a PR
 * creation 404s against a bare D1-seeded repo. One deterministic root commit
 * lands on `main` through the same public RPCs the API layer uses
 * (putApiObjects → commitApiChange; the compat suite's seed pattern), and the
 * named branches point at it. Idempotent: the DO cell outlives the per-test
 * D1 wipes, so already-present refs are left alone. Returns the shared branch
 * tip — the commit oid the head-sha assertions pin.
 */
async function seedEngineBranches(ownerLower: string, slug: string, branches: string[]): Promise<string> {
  const pair = { ownerNamespace: ownerLower, slug };
  const cell = env.REPO.getByName(`${ownerLower}/${slug}`);
  const tips = refTipMap(await engineReads(env, pair).listRefs());
  const land = async (ref: string, oid: string): Promise<void> => {
    const result = await cell.commitApiChange({ ref, expectedOldOid: ZERO_OID, newOid: oid });
    if (result.tag !== "committed") {
      throw new Error(`seed ref landing failed: ${ref} (${result.tag})`);
    }
  };
  let tip = tips.get(branchRef("main"))?.target;
  if (tip === undefined) {
    const blob = new TextEncoder().encode(`# ${slug}\n`);
    const blobOid = await gitObjectOid("blob", blob);
    const tree = serializeTree([{ mode: "100644", name: "README.md", oid: blobOid }]);
    const person = { name: "seed", email: "seed@pulls.invalid", time: 1761000000, tz: "+0000" };
    const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "seed\n" });
    const put = await cell.putApiObjects([
      { oid: blobOid, type: "blob", data: blob },
      { oid: tree.oid, type: "tree", data: tree.data },
      { oid: commit.oid, type: "commit", data: commit.data },
    ]);
    if (put.tag !== "ok") {
      throw new Error(`seed putApiObjects failed: ${put.tag}`);
    }
    tip = commit.oid;
    await land(branchRef("main"), commit.oid);
    const head = await cell.setHead("main");
    if (head.tag !== "ok") {
      throw new Error("seed setHead failed");
    }
  }
  for (const branch of branches) {
    if (tips.get(branchRef(branch)) === undefined) {
      await land(branchRef(branch), tip);
    }
  }
  return tip;
}

async function seedLabel(repoId: string, name: string): Promise<number> {
  const rows = await db()
    .insert(labels)
    .values({ repoId, name, color: "#00aabb", description: "", numIssues: 0, numClosedIssues: 0 })
    .returning({ id: labels.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("label seed failed");
  return row.id;
}

async function seedMilestone(repoId: string, name: string): Promise<number> {
  const rows = await db()
    .insert(milestones)
    .values({ repoId, name, content: "", createdAt: new Date(), updatedAt: new Date() })
    .returning({ id: milestones.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("milestone seed failed");
  return row.id;
}

/** Active webhook subscribed to the given events — the fan-out matcher target. */
async function seedHook(repoId: string, events: string[]): Promise<number> {
  const rows = await db()
    .insert(webhooks)
    .values({
      repoId,
      url: "https://hooks.invalid/pull-test",
      events: JSON.stringify({ choose_events: true, branch_filter: "*", events: Object.fromEntries(events.map((e) => [e, true])) }),
      isActive: true,
      type: "gitea",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: webhooks.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("hook seed failed");
  return row.id;
}

const router = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`https://example.com${path}`, init), env);
};

/** One issue through the landed service (indexes allocate 1, 2, …). */
async function seedIssue(repoId: string, title: string, options: { posterId?: number; closed?: boolean } = {}): Promise<{ id: number; index: number }> {
  const row = await service().createIssue({ repoId, title, posterId: options.posterId ?? null });
  if (options.closed === true) {
    await service().closeIssue(row.id, { actorId: options.posterId ?? null });
  }
  return { id: row.id, index: row.index };
}

/** One PR through the landed service (same shared counter). */
async function seedPull(
  repoId: string,
  title: string,
  options: { posterId?: number; baseBranch?: string; headBranch?: string; closed?: boolean } = {},
): Promise<{ id: number; index: number; prId: number }> {
  const { issue, pullRequest } = await service().createPullRequest({
    repoId,
    title,
    posterId: options.posterId ?? null,
    headRepoId: repoId,
    baseBranch: options.baseBranch ?? "main",
    headBranch: options.headBranch ?? "feature",
  });
  if (options.closed === true) {
    await service().closeIssue(issue.id, { actorId: options.posterId ?? null });
  }
  return { id: issue.id, index: issue.index, prId: pullRequest.id };
}

type DeliveryRow = typeof webhookDeliveries.$inferSelect;

async function deliveriesFor(hookId: number): Promise<DeliveryRow[]> {
  return db()
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.hookId, hookId))
    .all();
}

async function createPull(path: string, body: Record<string, unknown>): Promise<Response> {
  return router()(path, { method: "POST", headers: authHeaders, body: JSON.stringify(body) });
}

async function patchPull(path: string, body: Record<string, unknown>): Promise<Response> {
  return router()(path, { method: "PATCH", headers: authHeaders, body: JSON.stringify(body) });
}

// ---------------------------------------------------------------------------
// POST /repos/{owner}/{repo}/pulls (repoCreatePullRequest)
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/pulls (repoCreatePullRequest)", () => {
  it("creates a PR with 201 and the exact contract PullRequest field set", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const featureTip = await seedEngineBranches(owner.usernameLower, "visible", ["feature"]);

    const res = await createPull("/repos/Alice/visible/pulls", {
      title: "created by the suite",
      body: "some body",
      head: "feature",
      base: "main",
    });

    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    // Upstream's api.PullRequest omits the four omitempty fields at runtime
    // (additions/deletions/changed_files/review_comments — the diff stats
    // stay unset without the engine); everything else renders. The emitted
    // key set is exactly PULL_FIELDS minus that quartet.
    const emitted = Object.keys(body).sort();
    expect(emitted.filter((k) => !PULL_FIELDS.includes(k))).toEqual([]);
    expect(emitted).toEqual(
      PULL_FIELDS.filter((k) => !["additions", "changed_files", "deletions", "review_comments"].includes(k)),
    );
    expect(body).toMatchObject({
      number: 1, // shared per-repo sequence
      title: "created by the suite",
      body: "some body",
      state: "open",
      draft: false,
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      merged_by: null,
      mergeable: null, // engine wave: unknown, per upstream's checking semantics
      merge_base: "",
      allow_maintainer_edit: true,
      labels: [],
      requested_reviewers: [],
      requested_reviewers_teams: [],
      user: { login: "cf-gitea-stub" },
      url: "https://example.com/alice/visible/pulls/1", // Issue.HTMLURL quirk: the HTML path
      html_url: "https://example.com/alice/visible/pulls/1",
      diff_url: "https://example.com/alice/visible/pulls/1.diff",
      patch_url: "https://example.com/alice/visible/pulls/1.patch",
      closed_at: null,
      due_date: null,
      milestone: null,
    });
    expect(body.id).toBeTypeOf("number");
    expect(Object.keys(body.base as Record<string, unknown>).sort()).toEqual(PULL_BRANCH_FIELDS);
    expect(body.base).toMatchObject({ label: "main", ref: "main", sha: "", repo_id: Number(repoId) });
    expect((body.base as Record<string, unknown>).repo).toMatchObject({ name: "visible", full_name: "alice/visible" });
    expect(Object.keys(body.head as Record<string, unknown>).sort()).toEqual(PULL_BRANCH_FIELDS);
    expect(body.head).toMatchObject({
      label: "feature",
      ref: "refs/pull/1/head", // GetGitHeadRefName — the base-repo PR head ref
      sha: featureTip, // head_sha cache: the branch tip read at creation
      repo_id: Number(repoId),
    });
  });

  it("draws the PR index from the shared counter and lists via issues?type=pulls", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedEngineBranches(owner.usernameLower, "visible", ["feature"]);
    const issue = await seedIssue(repoId, "a plain issue");
    const res = await createPull("/repos/Alice/visible/pulls", { title: "a pr", head: "feature", base: "main" });
    expect(res.status).toBe(201);
    const { number } = await res.json<{ number: number }>();
    expect(number).toBe(issue.index + 1); // one per-repo sequence

    const nextIssue = await seedIssue(repoId, "second issue");
    expect(nextIssue.index).toBe(issue.index + 2); // the PR consumed its slot

    const counters = await db().select().from(repoCounters).all();
    expect(counters[0]?.issueIndex).toBe(3);

    // The issues list doubles as the PR listing (GET /issues?type=pulls).
    const pulls = await router()("/repos/alice/visible/issues?type=pulls");
    expect(pulls.headers.get("X-Total-Count")).toBe("1");
    const prIssue = await pulls.json<Array<{ number: number; title: string; pull_request: { merged: boolean; html_url: string } | null }>>();
    expect(prIssue[0]?.number).toBe(number);
    expect(prIssue[0]?.title).toBe("a pr");
    // The embedded PullRequestMeta.html_url rides the landed issues converter
    // (issue HTMLURL — the issues path, the batch-5 landing).
    expect(prIssue[0]?.pull_request).toMatchObject({ merged: false, html_url: `https://example.com/alice/visible/issues/${number}` });

    // PRs also render through the plain issue get (they ARE issues). The
    // embedded PullRequestMeta.html_url rides the landed issues converter
    // (issue HTMLURL — the issues path, the batch-5 landing).
    const asIssue = await router()(`/repos/alice/visible/issues/${number}`);
    expect((await asIssue.json<{ pull_request: { html_url: string } | null }>()).pull_request?.html_url).toBe(
      `https://example.com/alice/visible/issues/${number}`,
    );
  });

  it("attaches milestone and labels (unknown label ids silently dropped)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    // f2/f3: the later calls' head branches must RESOLVE (the engine reads run
    // before the milestone/due-date validation they pin).
    await seedEngineBranches(owner.usernameLower, "visible", ["feature", "f2", "f3"]);
    const labelId = await seedLabel(repoId, "bug");
    const milestoneId = await seedMilestone(repoId, "v1");

    const res = await createPull("/repos/Alice/visible/pulls", {
      title: "enriched",
      head: "feature",
      base: "main",
      labels: [labelId, 999], // GetLabelsInRepoByIDs drops the miss (unlike POST /issues)
      milestone: milestoneId,
      due_date: "2030-01-02",
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ labels: Array<{ id: number }>; milestone: { id: number } | null; due_date: string | null }>();
    expect(body.labels.map((l) => l.id)).toEqual([labelId]);
    expect(body.milestone?.id).toBe(milestoneId);
    expect(body.due_date).toBe("2030-01-02T23:59:59.000Z");

    const unknownMilestone = await createPull("/repos/Alice/visible/pulls", { title: "x", head: "f2", base: "main", milestone: 99 });
    expect(unknownMilestone.status).toBe(404);
    expect(await unknownMilestone.json()).toEqual({
      message: `milestone does not exist [id: 99, repo_id: ${repoId}]`,
      url: ERROR_URL,
    });
  });

  it("422s head == base, 409s duplicate open targets (issue_id = the index), 400s bad due_date", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedEngineBranches(owner.usernameLower, "visible", ["feature", "f3"]); // f3: the bad-date call's head must resolve

    const same = await createPull("/repos/Alice/visible/pulls", { title: "x", head: "main", base: "main" });
    expect(same.status).toBe(422);
    expect((await same.json<{ message: string }>()).message).toBe(
      "Invalid PullRequest: There are no changes between the head and the base",
    );

    const first = await seedPull(repoId, "open one");
    const duplicate = await createPull("/repos/Alice/visible/pulls", { title: "dupe", head: "feature", base: "main" });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json<{ message: string }>()).message).toBe(
      `pull request already exists for these targets [id: ${first.prId}, issue_id: ${first.index}, head_repo_id: ${repoId}, ` +
        `base_repo_id: ${repoId}, head_branch: feature, base_branch: main]`,
    );

    // A CLOSED PR with the same targets is not a duplicate (GetUnmerged filters is_closed).
    await service().closeIssue(first.id, { actorId: owner.id });
    const afterClose = await createPull("/repos/Alice/visible/pulls", { title: "recycled", head: "feature", base: "main" });
    expect(afterClose.status).toBe(201);

    const badDate = await createPull("/repos/Alice/visible/pulls", { title: "x", head: "f3", base: "main", due_date: "nope" });
    expect(badDate.status).toBe(400);
  });

  it("resolves the fork-form head and 404s unknown head repos / foreign base forms", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedEngineBranches(owner.usernameLower, "visible", ["feature"]);

    const sameOwnerForkForm = await createPull("/repos/Alice/visible/pulls", { title: "fork form", head: "alice:feature", base: "main" });
    expect(sameOwnerForkForm.status).toBe(201);
    expect((await sameOwnerForkForm.json<{ head: { repo_id: number; label: string } }>().then((b) => b.head))).toMatchObject({
      repo_id: Number(repoId),
      label: "feature",
    });

    const ghost = await createPull("/repos/Alice/visible/pulls", { title: "x", head: "ghost:feature", base: "main" });
    expect(ghost.status).toBe(404);
    expect(await ghost.json()).toEqual({ message: "not found", url: ERROR_URL });

    const foreignBase = await createPull("/repos/Alice/visible/pulls", { title: "x", head: "feature2", base: "other:main" });
    expect(foreignBase.status).toBe(404);
  });

  it("requires a token, a visible repo, and an unarchived repo; 422s bind failures", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");
    await seedRepo("alice", "frozen", { archived: true });

    const anon = await router()("/repos/Alice/visible/pulls", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "x", head: "f", base: "m" }) });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ message: "token is required", url: ERROR_URL });

    const missing = await createPull("/repos/alice/ghost/pulls", { title: "x", head: "f", base: "m" });
    expect(missing.status).toBe(404);

    const archived = await createPull("/repos/alice/frozen/pulls", { title: "x", head: "f", base: "m" });
    expect(archived.status).toBe(423);
    expect(await archived.json()).toEqual({ message: "repo is archived", url: ERROR_URL });

    const bind = await createPull("/repos/alice/visible/pulls", { head: "f", base: "m" }); // no title
    expect(bind.status).toBe(422);
  });

  it("emits the pull_request opened webhook to subscribed active hooks only", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedEngineBranches(owner.usernameLower, "visible", ["feature"]);
    const wrongHook = await seedHook(repoId, ["issues"]); // not subscribed
    await seedHook(repoId, ["pull_request"]);

    const res = await createPull("/repos/Alice/visible/pulls", { title: "fan-out target", head: "feature", base: "main" });
    expect(res.status).toBe(201);
    const { number } = await res.json<{ number: number }>();

    expect(await deliveriesFor(wrongHook)).toHaveLength(0);
    const all = await db().select().from(webhookDeliveries).all();
    expect(all).toHaveLength(1);
    expect(all[0]?.eventType).toBe("pull_request");
    expect(all[0]?.eventGroup).toBe("pull_request");
    const payload = JSON.parse(all[0]!.payloadContent) as Record<string, unknown>;
    // §2.7 PullRequestPayload field set, 2-space serialized.
    expect(Object.keys(payload).sort()).toEqual(["action", "commit_id", "number", "pull_request", "repository", "sender"]);
    expect(payload).toMatchObject({ action: "opened", number });
    const payloadPull = Object.keys(payload.pull_request as Record<string, unknown>).sort();
    expect(payloadPull.filter((k) => !PULL_FIELDS.includes(k))).toEqual([]);
    expect(all[0]!.payloadContent).toContain('\n  "action": "opened"');
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/pulls (repoListPullRequests)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/pulls (repoListPullRequests)", () => {
  it("lists PRs with pagination headers and the exact contract field set", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedIssue(repoId, "a plain issue"); // never listed here
    await seedPull(repoId, "first pr");
    await seedPull(repoId, "second pr");

    const res = await router()("/repos/alice/visible/pulls?limit=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.headers.get("Link")).toContain('rel="next"');
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body).toHaveLength(1);
    // created DESC (applySorts default)
    expect(body[0]?.title).toBe("second pr");
    const emitted = Object.keys(body[0]!).sort();
    expect(emitted.filter((k) => !PULL_FIELDS.includes(k))).toEqual([]);
    expect(emitted).toEqual(PULL_FIELDS.filter((k) => !["additions", "changed_files", "deletions", "review_comments"].includes(k)));
    // The list converter passes assignees through raw (null), the single one empties it.
    expect(body[0]?.assignees ?? null).toBeNull();
  });

  it("state filters match ONLY open/closed — absent/all/garbage list both (upstream quirk)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedPull(repoId, "open one");
    await seedPull(repoId, "closed one", { closed: true });

    const open = await router()("/repos/alice/visible/pulls?state=open");
    expect(open.headers.get("X-Total-Count")).toBe("1");
    expect((await open.json<Array<{ title: string }>>())[0]?.title).toBe("open one");

    const closed = await router()("/repos/alice/visible/pulls?state=closed");
    expect(closed.headers.get("X-Total-Count")).toBe("1");

    // No param / "all" / garbage → no is_closed filter at all.
    for (const state of [null, "all", "bogus"]) {
      const both = await router()(`/repos/alice/visible/pulls${state === null ? "" : `?state=${state}`}`);
      expect(both.headers.get("X-Total-Count")).toBe("2");
    }
  });

  it("filters by base_branch, milestone, labels (any-of), poster and sort", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const bug = await seedLabel(repoId, "bug");
    const v1 = await seedMilestone(repoId, "v1");
    const targeted = await seedPull(repoId, "targeted", { posterId: owner.id, baseBranch: "develop", headBranch: "topic" });
    await db().update(issues).set({ milestoneId: v1 }).where(eq(issues.id, targeted.id));
    await db().insert(issueLabels).values({ issueId: targeted.id, labelId: bug });
    await seedPull(repoId, "plain", { headBranch: "plain" });

    const byBase = await router()("/repos/alice/visible/pulls?base_branch=develop");
    expect((await byBase.json<Array<{ title: string }>>()).map((p) => p.title)).toEqual(["targeted"]);

    const byMilestone = await router()(`/repos/alice/visible/pulls?milestone=${v1}`);
    expect(byMilestone.headers.get("X-Total-Count")).toBe("1");

    const byLabel = await router()(`/repos/alice/visible/pulls?labels=${bug}`);
    expect(byLabel.headers.get("X-Total-Count")).toBe("1");

    const byPoster = await router()("/repos/alice/visible/pulls?poster=Alice");
    expect(byPoster.headers.get("X-Total-Count")).toBe("1");

    const bySort = await router()("/repos/alice/visible/pulls?sort=oldest");
    expect((await bySort.json<Array<{ title: string }>>()).map((p) => p.title)).toEqual(["targeted", "plain"]);

    const unknownPoster = await router()("/repos/alice/visible/pulls?poster=ghost");
    expect(unknownPoster.status).toBe(400);
    expect(await unknownPoster.json()).toEqual({ message: "user does not exist [uid: 0, name: ghost]", url: ERROR_URL });
  });

  it("non-integer label filters answer the declared upstream 500 (StringsToInt64s)", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "visible");
    const res = await router()("/repos/alice/visible/pulls?labels=not-an-int");
    expect(res.status).toBe(500);
    expect((await res.json<{ message: string }>()).message).toBe("");
  });

  it("404s an invisible repository", async () => {
    await seedUser("Alice");
    const res = await router()("/repos/alice/ghost/pulls");
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/pulls/{index} (repoGetPullRequest)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/pulls/{index} (repoGetPullRequest)", () => {
  it("renders WIP-titled PRs as drafts", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedPull(repoId, "WIP: careful");

    const res = await router()("/repos/alice/visible/pulls/1");
    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({ draft: true, state: "open" });
  });

  it("renders the merged trio only when merged", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const pr = await seedPull(repoId, "merged one", { posterId: owner.id });
    await db()
      .update(pullRequests)
      .set({ hasMerged: true, mergedCommitId: "abc123", mergerId: owner.id, mergedAt: new Date("2026-05-06T07:08:09Z") })
      .where(eq(pullRequests.id, pr.prId));

    const res = await router()("/repos/alice/visible/pulls/1");
    expect(await res.json<Record<string, unknown>>()).toMatchObject({
      merged: true,
      merged_at: "2026-05-06T07:08:09.000Z",
      merge_commit_sha: "abc123",
      merged_by: { login: "Alice" },
    });
  });

  it("renders requested_reviewers from the review-request rows (the pull-reviews consult)", async () => {
    const owner = await seedUser("Alice");
    const reviewer = await seedUser("bob");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const pr = await seedPull(repoId, "needs review", { posterId: owner.id });
    // A review-REQUEST row (migration 0018's pull_reviews, type=4) — what
    // routes/pull-reviews.ts's requested_reviewersOf consult reads.
    await db().insert(pullReviews).values({
      type: ReviewType.Request,
      reviewerId: reviewer.id,
      issueId: pr.id,
      content: "",
      createdAt: new Date("2026-06-01T00:00:00Z"),
      updatedAt: new Date("2026-06-01T00:00:00Z"),
    });

    const res = await router()("/repos/alice/visible/pulls/1");
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).requested_reviewers).toEqual([
      expect.objectContaining({ login: "bob" }),
    ]);
  });

  it("404s a plain-issue index from the shared space and garbage indexes", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedIssue(repoId, "an issue, not a pr");

    const notPr = await router()("/repos/alice/visible/pulls/1");
    expect(notPr.status).toBe(404);
    expect(await notPr.json()).toEqual({
      message: `pull request does not exist [id: 0, repo_id: ${repoId}, index: 1]`,
      url: ERROR_URL,
    });

    const garbage = await router()("/repos/alice/visible/pulls/abc");
    expect(garbage.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// PATCH /repos/{owner}/{repo}/pulls/{index} (repoEditPullRequest) — 201 quirk
// ---------------------------------------------------------------------------

describe("PATCH /repos/{owner}/{repo}/pulls/{index} (repoEditPullRequest)", () => {
  it("answers 201 (upstream quirk) and applies title/body edits with change comments + webhooks", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const pr = await seedPull(repoId, "before", { posterId: 1 });
    const hookId = await seedHook(repoId, ["pull_request"]);

    const res = await patchPull("/repos/alice/visible/pulls/1", { title: "after", body: "new body" });
    expect(res.status).toBe(201);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({ number: 1, title: "after", body: "new body", content_version: 1 });

    const rows = await db().select().from(comments).where(eq(comments.issueId, pr.id)).all();
    expect(rows.map((r) => r.type)).toEqual([CommentType.ChangeTitle]);
    expect(rows[0]?.oldTitle).toBe("before");

    const payloads = (await deliveriesFor(hookId)).map((d) => JSON.parse(d.payloadContent) as { action: string; changes?: Record<string, { title?: { from: string }; body?: { from: string } }> });
    expect(payloads.map((p) => p.action)).toEqual(["edited", "edited"]);
    expect(payloads[0]?.changes).toEqual({ title: { from: "before" } });
    expect(payloads[1]?.changes).toEqual({ body: { from: "" } });
  });

  it("renaming to a WIP title flips draft (the title-prefix contract)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedPull(repoId, "plain title", { posterId: 1 });

    const res = await patchPull("/repos/alice/visible/pulls/1", { title: "WIP: still cooking" });
    expect(res.status).toBe(201);
    expect((await res.json<{ draft: boolean }>()).draft).toBe(true);
  });

  it("transitions state with system comments and closed/reopened webhooks", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const pr = await seedPull(repoId, "lifecycle", { posterId: 1 });
    const hookId = await seedHook(repoId, ["pull_request"]);

    const close = await patchPull("/repos/alice/visible/pulls/1", { state: "closed" });
    expect(close.status).toBe(201);
    expect((await close.json<{ state: string }>()).state).toBe("closed");

    const reopen = await patchPull("/repos/alice/visible/pulls/1", { state: "open" });
    expect(reopen.status).toBe(201);
    expect((await reopen.json<{ state: string; closed_at: string | null }>().then((b) => b.closed_at))).toBeNull();

    const types = (await db().select().from(comments).where(eq(comments.issueId, pr.id)).all()).map((r) => r.type);
    expect(types).toEqual([CommentType.Close, CommentType.Reopen]);

    const actions = (await deliveriesFor(hookId)).map((d) => (JSON.parse(d.payloadContent) as { action: string }).action);
    expect(actions).toEqual(["closed", "reopened"]);
  });

  it("412s state changes on merged PRs with the upstream message", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const pr = await seedPull(repoId, "merged", { posterId: 1 });
    await db().update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.id, pr.prId));

    const res = await patchPull("/repos/alice/visible/pulls/1", { state: "closed" });
    expect(res.status).toBe(412);
    expect(await res.json()).toEqual({ message: "cannot change state of this pull request, it was already merged", url: ERROR_URL });
  });

  it("moves the milestone, replaces labels (misses dropped) and updates allow_maintainer_edit", async () => {
    // The milestone/labels/allow-edit writes are writer-gated upstream
    // (CanWrite TypePullRequests) — run as the repo OWNER (the stub identity
    // owning its own repo).
    const repoId = await seedRepo("cf-gitea-stub", "visible");
    await seedEngineBranches("cf-gitea-stub", "visible", ["feature"]);
    const a = await seedLabel(repoId, "alpha");
    const b = await seedLabel(repoId, "beta");
    const v1 = await seedMilestone(repoId, "v1");
    await createPull("/repos/cf-gitea-stub/visible/pulls", { title: "editable", head: "feature", base: "main", labels: [a] });

    const res = await patchPull("/repos/cf-gitea-stub/visible/pulls/1", { milestone: v1, labels: [b, 999], allow_maintainer_edit: false });
    expect(res.status).toBe(201);
    const body = await res.json<{ labels: Array<{ id: number }>; milestone: { id: number } | null; allow_maintainer_edit: boolean }>();
    expect(body.labels.map((l) => l.id)).toEqual([b]); // unknown id dropped
    expect(body.milestone?.id).toBe(v1);
    expect(body.allow_maintainer_edit).toBe(false);

    const stored = await db().select().from(pullRequests).all();
    expect(stored[0]?.allowMaintainerEdit).toBe(false);
  });

  it("CAS-guards body edits on content_version with 409", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedPull(repoId, "cas", { posterId: 1 });

    const stale = await patchPull("/repos/alice/visible/pulls/1", { body: "raced", content_version: 5 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ message: "the issue is already changed", url: ERROR_URL });

    const fresh = await patchPull("/repos/alice/visible/pulls/1", { body: "sequenced", content_version: 0 });
    expect(fresh.status).toBe(201);
  });

  it("403s non-poster non-owner editors and 404s missing PRs; 422s bind failures", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const repoId = await seedRepo(alice.usernameLower, "visible");
    await seedPull(repoId, "bobs pr", { posterId: bob.id });

    const forbidden = await patchPull("/repos/alice/visible/pulls/1", { title: "hijack" });
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json<{ message: string }>()).message).toBe("");

    const missing = await patchPull("/repos/alice/visible/pulls/9", { title: "x" });
    expect(missing.status).toBe(404);

    const bind = await patchPull("/repos/alice/visible/pulls/1", { content_version: "not a number" });
    expect(bind.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/pulls/{base}/{head} (repoGetPullRequestByBaseHead)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/pulls/{base}/{head} (repoGetPullRequestByBaseHead)", () => {
  it("looks the PR up on the base/head columns (plain and fork-form heads)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const pr = await seedPull(repoId, "by refs", { baseBranch: "develop", headBranch: "topic" });

    const res = await router()("/repos/alice/visible/pulls/develop/topic");
    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({ number: pr.index, title: "by refs" });

    const forkForm = await router()("/repos/alice/visible/pulls/develop/alice:topic");
    expect(forkForm.status).toBe(200);
  });

  it("404s misses and unknown fork repos", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedPull(repoId, "exists", { baseBranch: "main", headBranch: "feature" });

    const wrongBranch = await router()("/repos/alice/visible/pulls/main/other");
    expect(wrongBranch.status).toBe(404);
    expect(await wrongBranch.json()).toEqual({ message: "not found", url: ERROR_URL });

    const ghostFork = await router()("/repos/alice/visible/pulls/main/ghost:feature");
    expect(ghostFork.status).toBe(404);
  });
});
