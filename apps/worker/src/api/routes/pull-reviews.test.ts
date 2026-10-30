/**
 * PR review family on real D1 (the reviews-block contract rows over
 * migration 0018's `pull_reviews`). Standalone mount per the issue-tables-t2
 * convention — router.ts registration is the orchestrator's one-liner.
 *
 * Pins: the CRUD quartet (list/get/create/delete + the comments listing),
 * the state machine (self-approval 422, REQUEST_CHANGES body requirement,
 * ContentEmpty 422, the closed-PR submit 422, the pending-review lifecycle
 * create→submit, the only-pending/stay-pending 422s, pending-review privacy
 * on the GET arms, the official flag + previous-decision dismissal on
 * approve/reject, the deletion cascade + the request-row refusal), the
 * reviewer-request pair (201/[]-skip/204, the poster 422, the stranger-doer
 * 422, the closed-PR 403, the unknown-user 404, the self-decline escape),
 * the four webhook events (review approved/rejected/comment + review
 * requested/removed) with their payload shapes, and the SILENCE arms
 * (pending submissions, dismissal, review deletion emit nothing).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";
import { OpenAPIHono } from "@hono/zod-openapi";

import { comments, issues, pullReviews, repositories, webhookDeliveries, webhooks } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import { ZERO_OID, branchRef, engineReads, refTipMap } from "../services/engine";
import type { AuthResolver } from "../auth";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware } from "../auth";
import type { ApiEnv } from "../env";
import { giteaErrorHandler } from "../errors";
import { registerPullReviewRoutes } from "./pull-reviews";

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
    "pull_reviews",
    "comments",
    "issue_labels",
    "pull_requests",
    "issues",
    "milestones",
    "labels",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const [id, username, isAdmin] of [
    [1, "doer", 0],
    [2, "bob", 0],
    [3, "chief", 1],
    [4, "alice", 0], // the repo owner row — findRepositoryByPath inner-joins it
  ] as const) {
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (?, ?, ?, ?, 'active', 0)",
    )
      .bind(id, username, username, isAdmin)
      .run();
  }
  // The DO cells persist across tests (only D1 is wiped above), so a
  // previous test's seeded head ref would leak its tip into the next PR's
  // commit_id default — drop the pull refs for the one repo name this suite
  // uses (the pulls.test.ts precedent).
  const cell = env.REPO.getByName("alice/visible");
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
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

const OWNER = "alice";
const SLUG = "visible";
const DOER_TOKEN = "token-doer";
const ADMIN_TOKEN = "token-chief";
const POSTER_TOKEN = "token-bob";

const IDENTITY_TOKENS: Record<string, { id: number; login: string; is_admin: boolean }> = {
  [DOER_TOKEN]: { id: 1, login: "doer", is_admin: false },
  [POSTER_TOKEN]: { id: 2, login: "bob", is_admin: false },
  [ADMIN_TOKEN]: { id: 3, login: "chief", is_admin: true },
};

const resolver: AuthResolver = { resolveToken: (token: string) => Promise.resolve(IDENTITY_TOKENS[token] ?? null) };

/** Local mount — the deferred router.ts one-liner's exact seam. */
function app(): OpenAPIHono<ApiEnv> {
  const a = new OpenAPIHono<ApiEnv>();
  a.onError(giteaErrorHandler);
  registerPullReviewRoutes(a, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return a;
}

const router = () => {
  const a = app();
  // The local mount serves the registry paths relative to the /api/v1 mount
  // (the worker mounts it; tests fetch the bare router, pulls.test.ts style).
  return async (path: string, init?: RequestInit): Promise<Response> =>
    a.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
};

const authed = (token: string, init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${token}`, "Content-Type": "application/json" },
});

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

async function jsonArray(res: Response): Promise<Record<string, unknown>[]> {
  return JSON.parse(await res.text()) as Record<string, unknown>[];
}

let repoSeq = 3100;

async function seedRepo(): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: OWNER,
    slug: SLUG,
    visibility: "public",
    isArchived: false,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await service().ensureRepoCounters(id);
  return id;
}

/** Deterministic commit on a branch — the engine content the head-ref reads need. */
async function seedBranch(branch: string): Promise<string> {
  const pair = { ownerNamespace: OWNER, slug: SLUG };
  const cell = env.REPO.getByName(`${OWNER}/${SLUG}`);
  const tips = refTipMap(await engineReads(env, pair).listRefs());
  const existing = tips.get(branchRef(branch))?.target;
  if (existing !== undefined) return existing;
  const blob = new TextEncoder().encode(`# ${SLUG}\n`);
  const header = new TextEncoder().encode(`blob ${blob.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + blob.byteLength);
  bytes.set(header);
  bytes.set(blob, header.byteLength);
  const blobOid = [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const tree = serializeTree([{ mode: "100644", name: "README.md", oid: blobOid }]);
  const person = { name: "seed", email: "seed@reviews.invalid", time: 1761000000, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "seed\n" });
  const put = await cell.putApiObjects([
    { oid: blobOid, type: "blob", data: blob },
    { oid: tree.oid, type: "tree", data: tree.data },
    { oid: commit.oid, type: "commit", data: commit.data },
  ]);
  if (put.tag !== "ok") throw new Error(`seed putApiObjects failed: ${put.tag}`);
  const landed = await cell.commitApiChange({ ref: branchRef(branch), expectedOldOid: ZERO_OID, newOid: commit.oid });
  if (landed.tag !== "committed") throw new Error(`seed branch landing failed: ${landed.tag}`);
  return commit.oid;
}

/** One open PR on the given repo through the landed service (poster = bob by default). */
async function seedPull(repoId: string, options: { posterId?: number; closed?: boolean } = {}): Promise<{ issueId: number; index: number; prId: number }> {
  const { issue, pullRequest } = await service().createPullRequest({
    repoId,
    title: "reviewable change",
    posterId: options.posterId ?? 2,
    headRepoId: repoId,
    baseBranch: "main",
    headBranch: "feature",
  });
  if (options.closed === true) {
    await service().closeIssue(issue.id, { actorId: options.posterId ?? 2 });
  }
  return { issueId: issue.id, index: issue.index, prId: pullRequest.id };
}

/** Land `refs/pull/N/head` at a tip — what the API POST /pulls wave does. */
async function seedPullHeadRef(index: number, oid: string): Promise<void> {
  const cell = env.REPO.getByName(`${OWNER}/${SLUG}`);
  const landed = await cell.commitApiChange({ ref: `refs/pull/${index}/head`, expectedOldOid: ZERO_OID, newOid: oid });
  if (landed.tag !== "committed") throw new Error(`seed pull head landing failed: ${landed.tag}`);
}

/** Active webhook subscribed to the review family — the fan-out matcher target. */
async function seedHook(repoId: string): Promise<number> {
  const rows = await db()
    .insert(webhooks)
    .values({
      repoId,
      url: "https://hooks.invalid/reviews-test",
      events: JSON.stringify({
        choose_events: true,
        branch_filter: "*",
        events: { pull_request_review: true, pull_request_review_request: true },
      }),
      isActive: true,
      type: "gitea",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning({ id: webhooks.id })
    .all();
  return rows[0]!.id;
}

type DeliveryRow = typeof webhookDeliveries.$inferSelect;

async function deliveriesFor(hookId: number): Promise<DeliveryRow[]> {
  return db()
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.hookId, hookId))
    .all();
}

async function reviewRows(issueId: number): Promise<Array<typeof pullReviews.$inferSelect>> {
  return db().select().from(pullReviews).where(eq(pullReviews.issueId, issueId)).all();
}

// ---------------------------------------------------------------------------
// CRUD + the comments listing
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/pulls/{index}/reviews (repoCreatePullReview)", () => {
  it("creates a COMMENT review and renders the PullReview shape", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "COMMENT", body: "looks fine overall", commit_id: "abc123" }) }));
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.state).toBe("COMMENT");
    expect(body.body).toBe("looks fine overall");
    expect(body.commit_id).toBe("abc123");
    expect(body.official).toBe(false);
    expect(body.dismissed).toBe(false);
    expect(body.stale).toBe(false);
    expect(body.user).toMatchObject({ login: "doer" });
    expect(body.pull_request_url).toBe(`https://example.com/${OWNER}/${SLUG}/pulls/1`);
    expect(body.html_url).toBe(`https://example.com/${OWNER}/${SLUG}/pulls/1#pullrequestreview-1`);
    expect(body.comments_count).toBe(0);
    expect(typeof body.submitted_at).toBe("string");
  });

  it("lands the CommentTypeReview system comment and bumps num_comments", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "COMMENT", body: "note" }) }));
    const reviewId = ((await jsonBody(res)).id) as number;
    const rows = await db().select().from(comments).where(eq(comments.type, CommentType.Review)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reviewId).toBe(reviewId);
    const issue = (await db().select().from(issues).where(eq(issues.id, pr.issueId)).all())[0]!;
    expect(issue.numComments).toBe(1);
  });

  it("422s self-approval, body-less REQUEST_CHANGES, and the empty comment review", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const selfApprove = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(POSTER_TOKEN, { method: "POST", body: JSON.stringify({ event: "APPROVED" }) }));
    expect(selfApprove.status).toBe(422);
    expect((await jsonBody(selfApprove)).message).toBe("approve your own pull is not allowed");

    const noBody = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "REQUEST_CHANGES" }) }));
    expect(noBody.status).toBe(422);
    expect((await jsonBody(noBody)).message).toBe("review event REQUEST_CHANGES requires a body");

    const empty = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "COMMENT" }) }));
    expect(empty.status).toBe(422);
    expect((await jsonBody(empty)).message).toBe("review requires a body or a comment");
  });

  it("422s an approve/reject on a closed PR (ErrSubmitReviewOnClosedPR) while COMMENT stays legal", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId, { closed: true });
    const approve = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({ event: "APPROVED", body: "too late" }) }));
    expect(approve.status).toBe(422);
    expect((await jsonBody(approve)).message).toBe("can't submit review for a closed or merged PR");

    const comment = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "COMMENT", body: "still commentable" }) }));
    expect(comment.status).toBe(200);
  });

  it("creates pending code comments and converts them on submit (the CreatePullReview loop)", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, {
      method: "POST",
      body: JSON.stringify({
        event: "REQUEST_CHANGES",
        body: "fix this",
        comments: [
          { path: "src/a.go", body: "wrong", new_position: 12 },
          { path: "src/b.go", body: "also wrong", old_position: 3 },
        ],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.state).toBe("REQUEST_CHANGES");
    expect(body.comments_count).toBe(2);
    const reviewId = body.id as number;

    const codeComments = await db().select().from(comments).where(eq(comments.type, CommentType.Code)).all();
    expect(codeComments).toHaveLength(2);
    const lines = codeComments.map((row) => row.line ?? 0).sort((a, b) => a - b);
    expect(lines).toEqual([-3, 12]);
    for (const row of codeComments) expect(row.reviewId).toBe(reviewId);
  });

  it("renders the official flag for a write-access reviewer and dismisses the previous decision", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({ event: "APPROVED", body: "lgtm" }) }));
    const second = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({ event: "REQUEST_CHANGES", body: "actually no" }) }));
    expect(second.status).toBe(200);
    const rows = await reviewRows(pr.issueId);
    const approvals = rows.filter((row) => row.type === 1);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.dismissed).toBe(true); // CreateReview's previous-decision arm
    const rejection = rows.find((row) => row.type === 3)!;
    expect(rejection.official).toBe(true); // site admin = write access
    expect((await jsonBody(second)).official).toBe(true);
  });

  it("defaults an empty commit_id to the head ref tip", async () => {
    const run = router();
    const repoId = await seedRepo();
    const tip = await seedBranch("feature");
    const pr = await seedPull(repoId);
    await seedPullHeadRef(pr.index, tip);
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "COMMENT", body: "hi" }) }));
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).commit_id).toBe(tip);
  });
});

describe("GET list + single review arms (repoListPullReviews / repoGetPullReview)", () => {
  it("lists reviews in submission order with the pagination header and hides other users' pending rows", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "COMMENT", body: "first" }) }));
    // A pending row (created via the PENDING event with comments) — visible
    // to its reviewer, hidden from everyone else.
    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "PENDING", comments: [{ path: "a", body: "draft", new_position: 1 }] }) }));

    const anon = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`);
    expect(anon.status).toBe(200);
    expect(anon.headers.get("X-Total-Count")).toBe("1");
    // SetTotalCountHeader verbatim (services/context/base.go:73-77): the
    // expose append rides the count — and ListPullReviews calls no
    // SetLinkHeader (pull_review.go:98-103), so no Link header is sent.
    expect(anon.headers.get("Access-Control-Expose-Headers")).toBe("X-Total-Count");
    expect(anon.headers.get("Link")).toBe(null);
    const visible = await jsonArray(anon);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.state).toBe("COMMENT");

    const own = await jsonArray(await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN)));
    expect(own).toHaveLength(2); // the reviewer sees their pending row
    const pending = own.find((row) => row.state === "PENDING")!;
    expect(pending.html_url).toBe(""); // pending rows carry no anchor
  });

  it("404s a review of another PR and exposes a pending review to its reviewer only", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const created = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "PENDING", comments: [{ path: "a", body: "draft", new_position: 1 }] }) }));
    const reviewId = ((await jsonBody(created)).id) as number;

    const wrongPr = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/99/reviews/${reviewId}`);
    expect(wrongPr.status).toBe(404);
    const stranger = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${reviewId}`, authed(POSTER_TOKEN));
    expect(stranger.status).toBe(404);
    const reviewer = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${reviewId}`, authed(DOER_TOKEN));
    expect(reviewer.status).toBe(200);
    const missing = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/999`);
    expect(missing.status).toBe(404);
    expect((await jsonBody(missing)).message).toBe("review does not exist [id: 999]");
  });
});

describe("POST /repos/{owner}/{repo}/pulls/{index}/reviews/{id} (repoSubmitPullReview)", () => {
  it("submits a pending review and converts it in place", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const created = (await jsonBody(
      await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "PENDING", comments: [{ path: "a", body: "draft", new_position: 1 }] }) })),
    ));

    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${String(created.id)}`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "APPROVED", body: "ship it" }) }));
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).state).toBe("APPROVED");
    const rows = await reviewRows(pr.issueId);
    expect(rows.filter((row) => row.type === 0)).toHaveLength(0); // converted, not duplicated
    expect(rows.filter((row) => row.type === 1)).toHaveLength(1);
  });

  it("422s a second submit of a non-pending review", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const submitted = (await jsonBody(
      await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "COMMENT", body: "done" }) })),
    ));

    const again = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${String(submitted.id)}`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "APPROVED" }) }));
    expect(again.status).toBe(422);
    expect((await jsonBody(again)).message).toBe("only a pending review can be submitted");
  });

  it("422s when the submit event stays PENDING", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const created = (await jsonBody(
      await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "PENDING", comments: [{ path: "a", body: "draft", new_position: 1 }] }) })),
    ));
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${String(created.id)}`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "PENDING" }) }));
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).message).toBe("review stay pending");
  });
});

describe("DELETE /repos/{owner}/{repo}/pulls/{index}/reviews/{id} (repoDeletePullReview)", () => {
  it("cascades the review's comments and 403s strangers", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const created = (await jsonBody(
      await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "COMMENT", body: "to delete", comments: [{ path: "a", body: "c", new_position: 1 }] }) })),
    ));

    const stranger = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${String(created.id)}`, authed(POSTER_TOKEN, { method: "DELETE" }));
    expect(stranger.status).toBe(403);
    expect((await jsonBody(stranger)).message).toBe("no permission to delete comment");

    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${String(created.id)}`, authed(DOER_TOKEN, { method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(await reviewRows(pr.issueId)).toHaveLength(0);
    expect(await db().select().from(comments).where(eq(comments.reviewId, 1)).all()).toHaveLength(0); // code + review comments gone
  });

  it("refuses a request row with the upstream 500 (undeclared runtime-only response)", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const created = await jsonArray(
      await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/requested_reviewers`, authed(POSTER_TOKEN, { method: "POST", body: JSON.stringify({ reviewers: ["doer"] }) })),
    );
    const requestReviewId = created[0]!.id as number;
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${requestReviewId}`, authed(DOER_TOKEN, { method: "DELETE" }));
    expect(res.status).toBe(500);
    expect((await jsonBody(res)).message).toBe(`can not delete ReviewID: ${requestReviewId}`);
  });
});

describe("GET /repos/{owner}/{repo}/pulls/{index}/reviews/{id}/comments (repoGetPullReviewComments)", () => {
  it("lists the review's code comments in the PullReviewComment shape", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const created = (await jsonBody(
      await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "COMMENT", body: "with comments", comments: [{ path: "src/a.go", body: "hmm", new_position: 7 }] }) })),
    ));

    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${String(created.id)}/comments`);
    expect(res.status).toBe(200);
    const list = await jsonArray(res);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      body: "hmm",
      path: "src/a.go",
      position: 7,
      original_position: null,
      pull_request_review_id: created.id,
      diff_hunk: "",
      pull_request_url: `https://example.com/${OWNER}/${SLUG}/pulls/1`,
    });
  });
});

// ---------------------------------------------------------------------------
// The code-comment diff hunks — the GetCodeCommentPatch port
// (services/gitdiff/gitdiff.go:1600–1615): created code comments store the
// hunk cut around their line over the PR's three-dot range
// (CutDiffAroundLine, modules/git/diff.go:160–268, over the engine's
// structured hunks), falling back to the synthetic context patch at the
// side's context commit when the line is unchanged
// (GeneratePatchForUnchangedLine, gitdiff.go:1621–1668). The wire renders
// it through patch2diff → diff_hunk (convert/pull_review.go:115).
// ---------------------------------------------------------------------------

/** SHA-1 of one loose git object (header-prefixed) — the seedBranch recipe. */
async function looseOid(type: "blob" | "tree" | "commit", data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header);
  bytes.set(data, header.byteLength);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A commit with the given files, parented on `parent` (null = root) — real
 *  engine content the three-dot diff can cut hunks out of. */
async function seedFilesCommit(branch: string, files: Record<string, string>, parent: string | null): Promise<string> {
  const pair = { ownerNamespace: OWNER, slug: SLUG };
  const cell = env.REPO.getByName(`${OWNER}/${SLUG}`);
  const objects: Array<{ oid: string; type: "blob" | "tree" | "commit"; data: Uint8Array }> = [];
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  for (const [name, content] of Object.entries(files)) {
    const data = new TextEncoder().encode(content);
    const oid = await looseOid("blob", data);
    objects.push({ oid, type: "blob", data });
    entries.push({ mode: "100644", name, oid });
  }
  const tree = serializeTree(entries);
  objects.push({ oid: tree.oid, type: "tree", data: tree.data });
  const person = { name: "seed", email: "seed@reviews.invalid", time: 1761000000, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: parent === null ? [] : [parent], author: person, committer: person, message: "seed\n" });
  objects.push({ oid: commit.oid, type: "commit", data: commit.data });
  const put = await cell.putApiObjects(objects);
  if (put.tag !== "ok") throw new Error(`seed putApiObjects failed: ${put.tag}`);
  const tips = refTipMap(await engineReads(env, pair).listRefs());
  const landed = await cell.commitApiChange({ ref: branchRef(branch), expectedOldOid: tips.get(branchRef(branch))?.target ?? ZERO_OID, newOid: commit.oid });
  if (landed.tag !== "committed") throw new Error(`seed branch landing failed: ${landed.tag}`);
  return commit.oid;
}

describe("code-comment diff hunks (the GetCodeCommentPatch port)", () => {
  const FILE = "file.txt";
  const BASE_LINES = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10"];

  /** main = the 10-line file; feature (parented on main) edits L5–L7 and
   *  adds extra.txt — a real merge-base..head diff with an unchanged region
   *  (L1–L4, L8–L10) and a head-only file. */
  async function seedDiffScenario(): Promise<{ index: number }> {
    const repoId = await seedRepo();
    const mainTip = await seedFilesCommit("main", { [FILE]: `${BASE_LINES.join("\n")}\n` }, null);
    const edited = [...BASE_LINES];
    edited[4] = "L5-edited";
    edited[5] = "L6-edited";
    edited[6] = "L7-edited";
    const featureTip = await seedFilesCommit("feature", { [FILE]: `${edited.join("\n")}\n`, "extra.txt": "E1\nE2\n" }, mainTip);
    const pr = await seedPull(repoId);
    await seedPullHeadRef(pr.index, featureTip);
    return { index: pr.index };
  }

  it("cuts the hunk around a changed new-side line, keeps the full hunk near its start (old side), and synthesizes the unchanged-line patches", async () => {
    const { index } = await seedDiffScenario();
    const run = router();
    const created = (await jsonBody(
      await run(
        `/api/v1/repos/${OWNER}/${SLUG}/pulls/${index}/reviews`,
        authed(DOER_TOKEN, {
          method: "POST",
          body: JSON.stringify({
            event: "COMMENT",
            body: "hunk check",
            comments: [
              { path: FILE, body: "cut window", new_position: 6 },
              { path: FILE, body: "full hunk", old_position: 5 },
              { path: "extra.txt", body: "added-file no-cut", new_position: 1 },
              { path: "extra.txt", body: "merge-base side has no blob", old_position: 1 },
              { path: FILE, body: "beyond the blob", new_position: 99 },
            ],
          }),
        }),
      ),
    ));
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${index}/reviews/${String(created.id)}/comments`);
    expect(res.status).toBe(200);
    const list = await jsonArray(res);
    expect(list).toHaveLength(5);
    const byBody = new Map(list.map((row) => [row.body, row]));

    // Cut arm, new side: the hunk starts at L2 (3 context + 3 edits, git's
    // dels-then-adds block order), the target sits past CODE_COMMENT_LINES
    // into it — upstream keeps the trailing window of 4 kept lines ENDING at
    // the target with a recomputed @@ header (@@ -6,2 +5,2 @@: the
    // -L6/-L7/+L5-edited/+L6-edited tail of the block).
    expect(byBody.get("cut window")?.diff_hunk).toBe("@@ -6,2 +5,2 @@\n-L6\n-L7\n+L5-edited\n+L6-edited");
    // No-cut arm, old side: the target lands within 4 kept lines of the
    // hunk start — the ORIGINAL header and the kept prefix as-is.
    expect(byBody.get("full hunk")?.diff_hunk).toBe("@@ -2,9 +2,9 @@\n L2\n L3\n L4\n-L5");
    // No-cut arm on a NEW file: line 1 of extra.txt is itself an added line
    // inside the whole-file add hunk — the kept prefix fits, so the ORIGINAL
    // header renders as-is (the engine's pure-add hunk carries -0,0).
    expect(byBody.get("added-file no-cut")?.diff_hunk).toBe("@@ -0,0 +1,2 @@\n+E1");
    // Old side of a head-only file: the merge-base blob read misses — no
    // fabricated hunk.
    expect(byBody.get("merge-base side has no blob")?.diff_hunk).toBe("");
    // Beyond the blob: upstream's range read errors into "".
    expect(byBody.get("beyond the blob")?.diff_hunk).toBe("");
  });

  it("an unchanged new-side line synthesizes its context from the head tip", async () => {
    const { index } = await seedDiffScenario();
    const run = router();
    const created = (await jsonBody(
      await run(
        `/api/v1/repos/${OWNER}/${SLUG}/pulls/${index}/reviews`,
        authed(DOER_TOKEN, {
          method: "POST",
          body: JSON.stringify({ event: "COMMENT", body: "unchanged", comments: [{ path: FILE, body: "ctx", new_position: 1 }] }),
        }),
      ),
    ));
    const list = await jsonArray(await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${index}/reviews/${String(created.id)}/comments`));
    expect(list).toHaveLength(1);
    // L1 is outside every hunk (the diff starts at L2) — GeneratePatchForUn-
    // changedLine renders the 1-line window at the head tip.
    expect(list[0]!.diff_hunk).toBe("@@ -1,1 +1,1 @@\n L1\n");
  });

  it("a PR without a landed head ref captures nothing — diff_hunk stays empty (the degenerate arm)", async () => {
    const repoId = await seedRepo();
    await seedFilesCommit("main", { [FILE]: `${BASE_LINES.join("\n")}\n` }, null);
    const pr = await seedPull(repoId); // no seedPullHeadRef — no servable range
    const run = router();
    const created = (await jsonBody(
      await run(
        `/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`,
        authed(DOER_TOKEN, {
          method: "POST",
          body: JSON.stringify({ event: "COMMENT", body: "degenerate", comments: [{ path: FILE, body: "no range", new_position: 6 }] }),
        }),
      ),
    ));
    expect(created.id).toBeDefined(); // the review still lands (200, no 500)
    const list = await jsonArray(await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${String(created.id)}/comments`));
    expect(list).toHaveLength(1);
    expect(list[0]!.diff_hunk).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Dismissal arms
// ---------------------------------------------------------------------------

describe("POST …/reviews/{id}/dismissals + undismissals (repoDismissPullReview / repoUnDismissPullReview)", () => {
  async function seedApproval(): Promise<{ run: ReturnType<typeof router>; index: number; issueId: number; reviewId: number }> {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const created = (await jsonBody(
      await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({ event: "APPROVED", body: "lgtm" }) })),
    ));
    return { run, index: pr.index, issueId: pr.issueId, reviewId: created.id as number };
  }

  it("dismisses an approval as repo admin and lands the CommentTypeDismissReview comment", async () => {
    const { run, index, issueId, reviewId } = await seedApproval();
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${index}/reviews/${reviewId}/dismissals`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({ message: "stale approval", priors: true }) }));
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).dismissed).toBe(true);
    const dismissComments = await db().select().from(comments).where(eq(comments.type, CommentType.DismissReview)).all();
    expect(dismissComments).toHaveLength(1);
    expect(dismissComments[0]!.content).toBe("stale approval");
    expect((await db().select().from(issues).where(eq(issues.id, issueId)).all())[0]!.numComments).toBe(2); // review + dismissal
  });

  it("403s non-admins; undismissal flips back without a new comment; closed PRs 403", async () => {
    const { run, index, issueId, reviewId } = await seedApproval();

    const nonAdmin = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${index}/reviews/${reviewId}/dismissals`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({}) }));
    expect(nonAdmin.status).toBe(403);
    expect((await jsonBody(nonAdmin)).message).toBe("Must be repo admin");

    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${index}/reviews/${reviewId}/dismissals`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({}) }));
    expect(res.status).toBe(200);

    const un = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${index}/reviews/${reviewId}/undismissals`, authed(ADMIN_TOKEN, { method: "POST" }));
    expect(un.status).toBe(200);
    expect((await jsonBody(un)).dismissed).toBe(false);
    expect(await db().select().from(comments).where(eq(comments.type, CommentType.DismissReview)).all()).toHaveLength(1); // no new comment

    await service().closeIssue(issueId, { actorId: 2 });
    const closed = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${index}/reviews/${reviewId}/dismissals`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({}) }));
    expect(closed.status).toBe(403);
    expect((await jsonBody(closed)).message).toBe("can't dismiss a review associated to a closed or merged PR");
  });

  it("403s a COMMENT review (not an approve/reject row)", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const created = (await jsonBody(
      await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "COMMENT", body: "just saying" }) })),
    ));
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${String(created.id)}/dismissals`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({}) }));
    expect(res.status).toBe(403);
    expect((await jsonBody(res)).message).toBe("not need to dismiss this review because it's type is not Approve or change request");
  });
});

// ---------------------------------------------------------------------------
// Reviewer requests
// ---------------------------------------------------------------------------

describe("POST/DELETE …/requested_reviewers (repoCreatePullReviewRequests / repoDeletePullReviewRequests)", () => {
  it("creates REQUEST rows (201) and skips duplicates silently", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/requested_reviewers`, authed(POSTER_TOKEN, { method: "POST", body: JSON.stringify({ reviewers: ["doer"] }) }));
    expect(res.status).toBe(201);
    const created = await jsonArray(res);
    expect(created).toHaveLength(1);
    expect(created[0]!.state).toBe("REQUEST_REVIEW");
    expect(created[0]!.html_url).toBe(""); // request rows carry no anchor

    const repeat = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/requested_reviewers`, authed(POSTER_TOKEN, { method: "POST", body: JSON.stringify({ reviewers: ["doer"] }) }));
    expect(repeat.status).toBe(201);
    expect(await jsonArray(repeat)).toHaveLength(0); // silent skip

    const rows = await reviewRows(pr.issueId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.type).toBe(4);
    expect(rows[0]!.reviewerId).toBe(1);
  });

  it("removes a request (204), lands the add+remove comments, and restores the official flag", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    // chief approves first (site admin = official), then the poster requests
    // chief — the request clears the approval's official flag
    // (AddReviewRequest's official arm).
    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({ event: "APPROVED", body: "pre-approval" }) }));
    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/requested_reviewers`, authed(POSTER_TOKEN, { method: "POST", body: JSON.stringify({ reviewers: ["chief"] }) }));
    let rows = await reviewRows(pr.issueId);
    expect(rows.find((row) => row.type === 1)!.official).toBe(false); // cleared by the request

    // Removing the request restores the latest decision review's flag
    // (restoreLatestOfficialReview).
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/requested_reviewers`, authed(POSTER_TOKEN, { method: "DELETE", body: JSON.stringify({ reviewers: ["chief"] }) }));
    expect(res.status).toBe(204);
    rows = await reviewRows(pr.issueId);
    expect(rows.filter((row) => row.type === 4)).toHaveLength(0);
    expect(rows.find((row) => row.type === 1)!.official).toBe(true);
    const requestComments = await db().select().from(comments).where(eq(comments.type, CommentType.ReviewRequest)).all();
    expect(requestComments).toHaveLength(2); // add + remove
    expect(requestComments.map((row) => row.removedAssignee).sort()).toEqual([0, 1]);
  });

  it("422s the poster as reviewer, stranger doers, and org reviewers; 404s unknown users", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    const post = (body: Record<string, unknown>, token = POSTER_TOKEN) =>
      run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/requested_reviewers`, authed(token, { method: "POST", body: JSON.stringify(body) }));

    const posterReviewer = await post({ reviewers: ["bob"] });
    expect(posterReviewer.status).toBe(422);
    expect((await jsonBody(posterReviewer)).message).toContain("poster of pr can't be reviewer");

    const strangerDoer = await post({ reviewers: ["chief"] }, DOER_TOKEN);
    expect(strangerDoer.status).toBe(422);
    expect((await jsonBody(strangerDoer)).message).toContain("Doer can't choose reviewer");

    const unknown = await post({ reviewers: ["ghost"] });
    expect(unknown.status).toBe(404);
    expect((await jsonBody(unknown)).message).toBe("user doesn't exist: ghost");
  });

  it("403s a request on a closed PR (ErrReviewRequestOnClosedPR)", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId, { closed: true });
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/requested_reviewers`, authed(POSTER_TOKEN, { method: "POST", body: JSON.stringify({ reviewers: ["chief"] }) }));
    expect(res.status).toBe(403);
    expect((await jsonBody(res)).message).toBe("cannot request a re-review on a closed or merged PR");
  });

  it("lets a reviewer decline their own pending request (the self-removal escape)", async () => {
    const run = router();
    const repoId = await seedRepo();
    const pr = await seedPull(repoId);
    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/requested_reviewers`, authed(POSTER_TOKEN, { method: "POST", body: JSON.stringify({ reviewers: ["doer"] }) }));
    const res = await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/requested_reviewers`, authed(DOER_TOKEN, { method: "DELETE", body: JSON.stringify({ reviewers: ["doer"] }) }));
    expect(res.status).toBe(204); // canDoerChange is false for doer — the self-decline escape lets it through
    expect(await reviewRows(pr.issueId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The four webhook events + the silence arms
// ---------------------------------------------------------------------------

describe("pull_request_review_* + pull_request_review_request webhook emissions", () => {
  it("emits approved / rejected / comment with action reviewed, the review block, and the reviewer as sender", async () => {
    const run = router();
    const repoId = await seedRepo();
    const hookId = await seedHook(repoId);
    const pr = await seedPull(repoId);
    const post = (event: string, body: string) =>
      run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({ event, body }) }));

    await post("APPROVED", "lgtm");
    await post("REQUEST_CHANGES", "nope");
    await post("COMMENT", "fyi");

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((row) => row.eventType).sort()).toEqual([
      "pull_request_review_approved",
      "pull_request_review_comment",
      "pull_request_review_rejected",
    ]);
    const approved = deliveries.find((row) => row.eventType === "pull_request_review_approved")!;
    expect(approved.eventGroup).toBe("pull_request_approved");
    const payload = JSON.parse(approved.payloadContent) as Record<string, unknown>;
    expect(payload.action).toBe("reviewed");
    expect(payload.number).toBe(pr.index);
    expect(payload.commit_id).toBe("");
    const review = payload.review as Record<string, unknown>;
    expect(review).toEqual({ type: "pull_request_review_approved", content: "lgtm" });
    expect((payload.requested_reviewer as Record<string, unknown>).login).toBe("chief");
    expect((payload.sender as Record<string, unknown>).login).toBe("chief"); // the REVIEWER, not the poster
    expect((payload.pull_request as Record<string, unknown>).number).toBe(pr.index);
  });

  it("emits review_requested / review_request_removed per created/removed user request", async () => {
    const run = router();
    const repoId = await seedRepo();
    const hookId = await seedHook(repoId);
    const pr = await seedPull(repoId);

    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/requested_reviewers`, authed(POSTER_TOKEN, { method: "POST", body: JSON.stringify({ reviewers: ["chief"] }) }));
    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/requested_reviewers`, authed(POSTER_TOKEN, { method: "DELETE", body: JSON.stringify({ reviewers: ["chief"] }) }));

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((row) => row.eventType)).toEqual(["pull_request_review_request", "pull_request_review_request"]);
    const added = JSON.parse(deliveries[0]!.payloadContent) as Record<string, unknown>;
    const removed = JSON.parse(deliveries[1]!.payloadContent) as Record<string, unknown>;
    expect(added.action).toBe("review_requested");
    expect(removed.action).toBe("review_request_removed");
    expect((added.requested_reviewer as Record<string, unknown>).login).toBe("chief");
    expect((removed.requested_reviewer as Record<string, unknown>).login).toBe("chief");
    expect((added.sender as Record<string, unknown>).login).toBe("bob"); // the doer, unlike review events
    expect(added.review).toBeUndefined(); // request payloads carry no review block
  });

  it("stays silent on pending submissions, dismissals, and review deletion", async () => {
    const run = router();
    const repoId = await seedRepo();
    const hookId = await seedHook(repoId);
    const pr = await seedPull(repoId);

    // PENDING submission (event-less create is ContentEmpty 422 — no row, no event).
    const created = (await jsonBody(
      await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify({ event: "PENDING", comments: [{ path: "a", body: "draft", new_position: 1 }] }) })),
    ));
    // Dismissal + deletion of a submitted review.
    const comment = (await jsonBody(
      await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({ event: "APPROVED", body: "ok" }) })),
    ));
    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${String(comment.id)}/dismissals`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({ message: "hm" }) }));
    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${pr.index}/reviews/${String(created.id)}`, authed(DOER_TOKEN, { method: "DELETE" }));

    expect(await deliveriesFor(hookId)).toHaveLength(1); // only the approval
    const sole = (await deliveriesFor(hookId))[0]!;
    expect(sole.eventType).toBe("pull_request_review_approved");
  });

  /** The diff-stat scenario: main = the 10-line file; feature (child) edits
   *  L5–L7 and adds extra.txt (2 lines) — the three-dot range sums to 5 adds
   *  / 3 dels over 2 files (the hunk-suite seedDiffScenario's math). */
  async function seedTrioScenario(): Promise<{ run: ReturnType<typeof router>; repoId: string; hookId: number; index: number }> {
    const run = router();
    const repoId = await seedRepo();
    const hookId = await seedHook(repoId);
    const mainTip = await seedFilesCommit("main", { "file.txt": "L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\n" }, null);
    const featureTip = await seedFilesCommit(
      "feature",
      { "file.txt": "L1\nL2\nL3\nL4\nL5-edited\nL6-edited\nL7-edited\nL8\nL9\nL10\n", "extra.txt": "E1\nE2\n" },
      mainTip,
    );
    const pr = await seedPull(repoId);
    await seedPullHeadRef(pr.index, featureTip);
    return { run, repoId, hookId, index: pr.index };
  }

  it("carries the diff-stat trio on the reviewed payload over the real range diff (the GetDiffShortStat block is not gated on isPayload — convert/pull.go:31-34 + :230-254)", async () => {
    const { run, hookId, index } = await seedTrioScenario();

    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${index}/reviews`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify({ event: "APPROVED", body: "lgtm with stats" }) }));

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((row) => row.eventType)).toEqual(["pull_request_review_approved"]);
    const payload = JSON.parse(deliveries[0]!.payloadContent) as { pull_request: Record<string, unknown> };
    // file.txt: 3 adds + 3 dels; extra.txt: 2 adds → 5/3/2. A D1-only PR
    // (no engine refs) omits the fields (the omit arm, :247-250).
    expect(payload.pull_request).toMatchObject({ additions: 5, deletions: 3, changed_files: 2 });
  });

  it("carries the trio on the review_requested / review_request_removed payloads (one render feeding both)", async () => {
    const { run, hookId, index } = await seedTrioScenario();

    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${index}/requested_reviewers`, authed(POSTER_TOKEN, { method: "POST", body: JSON.stringify({ reviewers: ["chief"] }) }));
    await run(`/api/v1/repos/${OWNER}/${SLUG}/pulls/${index}/requested_reviewers`, authed(POSTER_TOKEN, { method: "DELETE", body: JSON.stringify({ reviewers: ["chief"] }) }));

    const deliveries = await deliveriesFor(hookId);
    expect(deliveries.map((row) => row.eventType)).toEqual(["pull_request_review_request", "pull_request_review_request"]);
    const added = JSON.parse(deliveries[0]!.payloadContent) as { pull_request: Record<string, unknown> };
    const removed = JSON.parse(deliveries[1]!.payloadContent) as { pull_request: Record<string, unknown> };
    // The add and remove payloads share the route's ONE conversion (the
    // upstream single converter recomputes per render — the shared render is
    // the cheaper adapter), so both carry the same 5/3/2.
    expect(added.pull_request).toMatchObject({ additions: 5, deletions: 3, changed_files: 2 });
    expect(removed.pull_request).toMatchObject({ additions: 5, deletions: 3, changed_files: 2 });
  });
});
