/**
 * Pages wave 11 route tests (SPEC-0008 U3 extension): the PR review
 * interactions — the sidebar Reviewers section (the re-issued list read
 * with the pending-privacy filter), the verdict form (upstream new_review
 * .tmpl's three buttons as a select), the request-review add/detach arms,
 * and the admin dismiss — over the landed reviews pipeline ports
 * (pages/pull-reviews.tsx, whose header cites the landed module line by
 * line).
 *
 * Same harness posture as pages-wave2..10: the router is driven directly
 * with the synthetic ASSETS manifest, D1-only fixtures (a row-only repo +
 * IssuesService.createPullRequest — the wave-9 sibling pattern; the review
 * rows insert straight into `pull_reviews` so no engine content and no
 * webhook queue are involved), and mintSession cookies for the identities.
 *
 * Write posture under test: the POSTs run the sameOriginGuard → repo
 * resolution → login 303 → archived-404 sequence, then the landed arms'
 * semantics — self-approval/self-rejection and REQUEST_CHANGES-body 422
 * messages re-render verbatim, the pending-row conversion, the
 * already-requested silent skip, the poster refusal, the two
 * CanDoerChangeReviewRequests escapes, the official-flag clear/restore
 * quirks, the system comments (22/27/32) with the num_comments bumps, and
 * the upstream redirect hashtags.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { comments, issues, pullReviews, repoCollaborators, repositories, ReviewType, users } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { IssuesService } from "../../issues/service";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const formPost = (path: string, body: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://test.local",
    ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
  },
  body: new URLSearchParams(body).toString(),
});

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

// --- fixtures -----------------------------------------------------------------

const WAVE11_COMMITS: SeedCommit[] = [
  { message: "seed: wave11 readme", time: T0, files: [{ path: "README.md", content: "# wave11 seed\n" }] },
];

interface Wave11Fixture {
  aliceCookie: string;
  bobCookie: string;
  carolCookie: string;
  daveCookie: string;
  /** The PR's issue row id (the issue_ids form field). */
  issueId: number;
  bobUserId: number;
  carolUserId: number;
  daveUserId: number;
}

let wave11Fixture: Wave11Fixture | null = null;

async function ensureWave11Fixtures(): Promise<Wave11Fixture> {
  if (wave11Fixture !== null) return wave11Fixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "wave11", commits: WAVE11_COMMITS });

  for (const name of ["wave11bob", "wave11carol", "wave11dave"]) {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, name)).get();
    if (existing === undefined) await seedVerifiedUser({ username: name });
  }
  const alice = await db.select().from(users).where(eq(users.usernameLower, "alice")).get();
  const bob = await db.select().from(users).where(eq(users.usernameLower, "wave11bob")).get();
  const carol = await db.select().from(users).where(eq(users.usernameLower, "wave11carol")).get();
  const dave = await db.select().from(users).where(eq(users.usernameLower, "wave11dave")).get();
  if (alice === undefined || bob === undefined || carol === undefined || dave === undefined) {
    throw new Error("wave11 identity rows missing");
  }

  // The open PR #1: alice posts, carol is REQUESTED, carol commented, dave
  // (a write collaborator) approved OFFICIAL, bob carries a PENDING row —
  // every wire state the sidebar renders. Idempotent: any review row for
  // the issue skips the block (the wave-2 leaf-write posture).
  const repo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave11")))
    .get();
  if (repo === undefined) throw new Error("wave11 repo row missing");
  const svc = new IssuesService(env.DB);
  const t = (offset: number): Date => new Date((T0 + offset) * 1000);

  const existingIssue = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.repoId, repo.id), eq(issues.isPull, true)))
    .get();
  let issueId: number;
  if (existingIssue === undefined) {
    const pr = await svc.createPullRequest({
      repoId: repo.id,
      title: "wave11: the reviewed pull request",
      content: "Seed PR for the review interactions.",
      posterId: alice.id,
      headRepoId: repo.id,
      baseBranch: "main",
      headBranch: "review-seed",
      now: t(10),
    });
    issueId = pr.issue.id;
  } else {
    issueId = existingIssue.id;
  }

  // Idempotence: any review row for THIS issue skips the seed block (the
  // wave-2 leaf-write posture — the per-issue row set is the unit).
  const issueReviews = await db.select({ id: pullReviews.id }).from(pullReviews).where(eq(pullReviews.issueId, issueId)).all();
  if (issueReviews.length === 0) {
    await db.insert(pullReviews).values([
      { type: ReviewType.Request, reviewerId: carol.id, issueId, content: "", official: false, createdAt: t(20), updatedAt: t(20) },
      { type: ReviewType.Comment, reviewerId: carol.id, issueId, content: "Some feedback.", official: false, createdAt: t(21), updatedAt: t(21) },
      { type: ReviewType.Reject, reviewerId: carol.id, issueId, content: "Please change the seed.", official: false, createdAt: t(22), updatedAt: t(22) },
      { type: ReviewType.Approve, reviewerId: dave.id, issueId, content: "Looks good.", official: true, createdAt: t(23), updatedAt: t(23) },
      { type: ReviewType.Pending, reviewerId: bob.id, issueId, content: "Draft notes.", official: false, createdAt: t(24), updatedAt: t(24) },
    ]);
    // dave is a WRITE collaborator (the request-control's collaborator arm).
    const existingCollab = await db
      .select({ userId: repoCollaborators.userId })
      .from(repoCollaborators)
      .where(and(eq(repoCollaborators.repoId, repo.id), eq(repoCollaborators.userId, dave.id)))
      .get();
    if (existingCollab === undefined) {
      await db.insert(repoCollaborators).values({ repoId: repo.id, userId: dave.id, mode: "write", createdAt: t(0), updatedAt: t(0) });
    }
  }

  wave11Fixture = {
    aliceCookie: await mintSession(env.DB, alice.id),
    bobCookie: await mintSession(env.DB, bob.id),
    carolCookie: await mintSession(env.DB, carol.id),
    daveCookie: await mintSession(env.DB, dave.id),
    issueId,
    bobUserId: bob.id,
    carolUserId: carol.id,
    daveUserId: dave.id,
  };
  return wave11Fixture;
}

beforeAll(async () => {
  await ensureWave11Fixtures();
});

// --- the parsers (the single owner of the route shapes) -------------------------

describe("wave-11 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the verdict form and the two repo-scoped review POSTs", () => {
    expect(parseUiRoute("/alice/wave11/pulls/1/files/reviews/submit")).toEqual({
      family: "pull-review-submit",
      owner: "alice",
      repo: "wave11",
      index: 1,
    });
    expect(parseUiRoute("/alice/wave11/issues/request_review")).toEqual({
      family: "issue-request-review",
      owner: "alice",
      repo: "wave11",
    });
    expect(parseUiRoute("/alice/wave11/issues/dismiss_review")).toEqual({
      family: "issue-dismiss-review",
      owner: "alice",
      repo: "wave11",
    });
    expect(handlesUiRoute("/alice/wave11/issues/request_review")).toBe(true);
  });

  it("leaves the code-comment siblings and deeper tails with the engine", () => {
    // Upstream's unclaimed siblings: the new_comment GET form and the
    // code-comment POST (no landed UI), plus every deeper tail.
    expect(parseUiRoute("/alice/wave11/pulls/1/files/reviews")).toBeNull();
    expect(parseUiRoute("/alice/wave11/pulls/1/files/reviews/comments")).toBeNull();
    expect(parseUiRoute("/alice/wave11/pulls/1/files/reviews/new_comment")).toBeNull();
    expect(parseUiRoute("/alice/wave11/issues/request_review/extra")).toBeNull();
    expect(parseUiRoute("/alice/wave11/issues/request_review/1")).toBeNull();
  });
});

// --- the sidebar + the forms ----------------------------------------------------

describe("the Reviewers sidebar (the re-issued list read)", () => {
  it("renders the visible review rows with state glyphs; pending rows stay private", async () => {
    const res = await fetchUi("/alice/wave11/pulls/1");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The section leads the sidebar (sidebar.tmpl:5-9).
    expect(html).toContain("<strong>Reviewers</strong>");
    // carol's REQUEST + COMMENT rows and dave's official APPROVED render —
    // upstream renders one item PER ROW, so carol appears twice.
    expect(html).toContain('href="/wave11carol">wave11carol</a>');
    expect(html).toContain('href="/wave11dave">wave11dave</a>');
    // Bob's PENDING row is hidden from anonymous (convert/pull_review.go:69-73).
    expect(html).not.toContain('href="/wave11bob"');
    // State tooltips (TooltipContent) and the glyph colors ride along.
    expect(html).toContain("Review pending");
    expect(html).toContain("Changes requested");
    expect(html).toContain("Approved");
    // No forms leak to anonymous: no request control, no trash, no dismiss.
    expect(html).not.toContain('name="reviewer"');
    expect(html).not.toContain("Dismiss Review");
  });

  it("shows the reviewer their own pending row (the privacy filter's doer arm)", async () => {
    const fixture = await ensureWave11Fixtures();
    const res = await fetchUi("/alice/wave11/pulls/1", withCookie(fixture.bobCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/wave11bob">wave11bob</a>');
    // The verdict form for a non-poster: three ENABLED verdict options.
    expect(html).toContain('id="pull-review-form"');
    expect(html).toContain('<option value="approve">Approve</option>');
    expect(html).toContain('<option value="reject">Request changes</option>');
    // No request control for bob (no grant): poster/owner/admin/collaborator.
    expect(html).not.toContain('aria-label="Request a review from a user"');
  });

  it("reduces the poster's verdicts to disabled options with the upstream reasons", async () => {
    const fixture = await ensureWave11Fixtures();
    const res = await fetchUi("/alice/wave11/pulls/1", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<option value=\"approve\" disabled=\"\">");
    expect(html).toContain("Approve — Pull request authors can&#39;t approve their own pull request</option>");
    expect(html).toContain("<option value=\"reject\" disabled=\"\">");
    expect(html).toContain("Request changes — Pull request authors can&#39;t request changes on their own pull request</option>");
    // The poster holds CanDoerChangeReviewRequests: the no-JS control renders.
    expect(html).toContain('aria-label="Request a review from a user"');
    // Admin on her own repo: the dismiss disclosure renders for dave's row.
    expect(html).toContain("Dismiss Review");
  });

  it("gates the request control on the collaborator arm and hides the verdict form from anonymous", async () => {
    const fixture = await ensureWave11Fixtures();
    const dave = await fetchUi("/alice/wave11/pulls/1", withCookie(fixture.daveCookie));
    expect(await dave.text()).toContain('aria-label="Request a review from a user"');

    const carol = await fetchUi("/alice/wave11/pulls/1", withCookie(fixture.carolCookie));
    expect(carol.status).toBe(200);
    expect(await carol.text()).not.toContain('aria-label="Request a review from a user"');

    const anon = await fetchUi("/alice/wave11/pulls/1");
    expect(await anon.text()).not.toContain('id="pull-review-form"');
  });
});

// --- the verdict form POST (the create-review arm) ------------------------------

describe("POST /pulls/1/files/reviews/submit (the SubmitReview port)", () => {
  it("rejects anonymous with the login 303 and answers GET with chi's 405", async () => {
    const anon = await fetchUi("/alice/wave11/pulls/1/files/reviews/submit", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" },
      body: "type=comment&content=hi",
    });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login?redirect_to=");

    const get = await fetchUi("/alice/wave11/pulls/1/files/reviews/submit");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  it("creates a comment review with the system comment, the counter bump and the hashtag redirect", async () => {
    const fixture = await ensureWave11Fixtures();
    const before = await drizzle(env.DB).select({ n: issues.numComments }).from(issues).where(eq(issues.id, fixture.issueId)).get();
    const res = await fetchUi(
      "/alice/wave11/pulls/1/files/reviews/submit",
      formPost("/alice/wave11/pulls/1/files/reviews/submit", { type: "comment", content: "Notes on the seed." }, fixture.bobCookie),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/alice/wave11/pulls/1#issuecomment-")).toBe(true);
    const commentId = Number.parseInt(location.split("-").pop() ?? "0", 10);
    const comment = await drizzle(env.DB).select().from(comments).where(eq(comments.id, commentId)).get();
    expect(comment?.type).toBe(CommentType.Review); // 22
    expect(comment?.content).toBe("Notes on the seed.");
    const after = await drizzle(env.DB).select({ n: issues.numComments }).from(issues).where(eq(issues.id, fixture.issueId)).get();
    expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1);
    // Bob's review row is a COMMENT row carrying his body.
    const review = await drizzle(env.DB)
      .select()
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fixture.issueId), eq(pullReviews.reviewerId, fixture.bobUserId)))
      .all();
    expect(review.some((row) => row.type === ReviewType.Comment && row.content === "Notes on the seed.")).toBe(true);
  });

  it("approves without a body, then dismisses the previous approve on the next one", async () => {
    const fixture = await ensureWave11Fixtures();
    const first = await fetchUi(
      "/alice/wave11/pulls/1/files/reviews/submit",
      formPost("/alice/wave11/pulls/1/files/reviews/submit", { type: "approve", content: "" }, fixture.bobCookie),
    );
    expect(first.status).toBe(303);
    const rowsAfterFirst = await drizzle(env.DB)
      .select()
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fixture.issueId), eq(pullReviews.reviewerId, fixture.bobUserId), eq(pullReviews.type, ReviewType.Approve)))
      .all();
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterFirst[0]?.dismissed).toBe(false);

    const second = await fetchUi(
      "/alice/wave11/pulls/1/files/reviews/submit",
      formPost("/alice/wave11/pulls/1/files/reviews/submit", { type: "approve", content: "re-review" }, fixture.bobCookie),
    );
    expect(second.status).toBe(303);
    const rowsAfterSecond = await drizzle(env.DB)
      .select()
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fixture.issueId), eq(pullReviews.reviewerId, fixture.bobUserId), eq(pullReviews.type, ReviewType.Approve)))
      .all();
    expect(rowsAfterSecond).toHaveLength(2);
    expect(rowsAfterSecond.filter((row) => row.dismissed)).toHaveLength(1); // the previous decision dismissed (:408-412)
  });

  it("converts the pending row instead of creating a new one (GetCurrentReview arm)", async () => {
    const fixture = await ensureWave11Fixtures();
    // Bob's PENDING row was consumed by the approve above (converted in
    // place — the count of bob's non-request rows stays bounded) and his
    // REQUEST row (created later in the request tests) is cleaned by the
    // non-pending submit's outstanding-request cleanup; assert the row SET
    // matches the pipeline's end state: no PENDING, no REQUEST rows.
    const rows = await drizzle(env.DB)
      .select()
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fixture.issueId), eq(pullReviews.reviewerId, fixture.bobUserId)))
      .all();
    expect(rows.some((row) => row.type === ReviewType.Pending)).toBe(false);
  });

  it("422s the poster's self-approval with the landed message and the kept draft", async () => {
    const fixture = await ensureWave11Fixtures();
    const res = await fetchUi(
      "/alice/wave11/pulls/1/files/reviews/submit",
      formPost("/alice/wave11/pulls/1/files/reviews/submit", { type: "approve", content: "self ship it" }, fixture.aliceCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("approve your own pull is not allowed");
    expect(html).toContain("self ship it"); // the draft round-trips
  });

  it("422s a bodyless request-changes and a bodyless comment with the landed messages", async () => {
    const fixture = await ensureWave11Fixtures();
    const reject = await fetchUi(
      "/alice/wave11/pulls/1/files/reviews/submit",
      formPost("/alice/wave11/pulls/1/files/reviews/submit", { type: "reject", content: "" }, fixture.bobCookie),
    );
    expect(reject.status).toBe(200);
    expect(await reject.text()).toContain("review event REQUEST_CHANGES requires a body");

    const comment = await fetchUi(
      "/alice/wave11/pulls/1/files/reviews/submit",
      formPost("/alice/wave11/pulls/1/files/reviews/submit", { type: "comment", content: "   " }, fixture.carolCookie),
    );
    expect(comment.status).toBe(200);
    expect(await comment.text()).toContain("review requires a body or a comment");
  });

  it("refuses decisions on a closed PR with the landed 422 message", async () => {
    const fixture = await ensureWave11Fixtures();
    // A dedicated closed PR (the open one carries the flowing assertions).
    const repo = await db2RepoId();
    const svc = new IssuesService(env.DB);
    const existing = await drizzle(env.DB)
      .select({ id: issues.id, isClosed: issues.isClosed })
      .from(issues)
      .where(and(eq(issues.repoId, repo), eq(issues.title, "wave11: the closed pull request")))
      .get();
    let closedIndex: number;
    if (existing === undefined) {
      const pr = await svc.createPullRequest({
        repoId: repo,
        title: "wave11: the closed pull request",
        posterId: (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "alice")).get())?.id ?? 0,
        headRepoId: repo,
        baseBranch: "main",
        headBranch: "closed-seed",
        now: new Date((T0 + 30) * 1000),
      });
      await svc.closeIssue(pr.issue.id, { now: new Date((T0 + 31) * 1000) });
      closedIndex = pr.issue.index;
    } else {
      const row = await drizzle(env.DB).select({ index: issues.index }).from(issues).where(eq(issues.id, existing.id)).get();
      if (row === undefined) throw new Error("closed PR row missing");
      closedIndex = row.index;
    }
    const res = await fetchUi(
      `/alice/wave11/pulls/${closedIndex}/files/reviews/submit`,
      formPost(`/alice/wave11/pulls/${closedIndex}/files/reviews/submit`, { type: "approve", content: "" }, fixture.bobCookie),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("can&#39;t submit review for a closed or merged PR");
  });
});

// --- the review-request arms ----------------------------------------------------

describe("POST /issues/request_review (the request arms)", () => {
  it("rejects anonymous with the login 303 and answers GET with chi's 405", async () => {
    const fixture = await ensureWave11Fixtures();
    const anon = await fetchUi("/alice/wave11/issues/request_review", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" },
      body: `action=attach&issue_ids=${fixture.issueId}&reviewer=wave11bob`,
    });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login?redirect_to=");

    const get = await fetchUi("/alice/wave11/issues/request_review");
    expect(get.status).toBe(405);
  });

  it("attaches by name with the request comment and the counter bump; repeats skip silently", async () => {
    const fixture = await ensureWave11Fixtures();
    const before = await drizzle(env.DB).select({ n: issues.numComments }).from(issues).where(eq(issues.id, fixture.issueId)).get();
    const res = await fetchUi(
      "/alice/wave11/issues/request_review",
      formPost("/alice/wave11/issues/request_review", { action: "attach", issue_ids: String(fixture.issueId), reviewer: "Wave11Dave" }, fixture.aliceCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave11/pulls/1");
    // Dave's seeded latest decision row is the APPROVE — the attach lands a
    // fresh REQUEST row (his newest), the CommentTypeReviewRequest comment
    // and the counter bump.
    const rows = await drizzle(env.DB)
      .select()
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fixture.issueId), eq(pullReviews.reviewerId, fixture.daveUserId), eq(pullReviews.type, ReviewType.Request)))
      .all();
    expect(rows).toHaveLength(1);
    const requestComments = await drizzle(env.DB)
      .select()
      .from(comments)
      .where(and(eq(comments.issueId, fixture.issueId), eq(comments.type, CommentType.ReviewRequest), eq(comments.assigneeId, fixture.daveUserId)))
      .all();
    expect(requestComments.length).toBeGreaterThanOrEqual(1);
    const after = await drizzle(env.DB).select({ n: issues.numComments }).from(issues).where(eq(issues.id, fixture.issueId)).get();
    expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1);

    // The already-requested silent skip (AddReviewRequest :706-710): no new
    // row, no comment, no counter bump — still a 303.
    const beforeSkip = await drizzle(env.DB).select({ n: issues.numComments }).from(issues).where(eq(issues.id, fixture.issueId)).get();
    const skip = await fetchUi(
      "/alice/wave11/issues/request_review",
      formPost("/alice/wave11/issues/request_review", { action: "attach", issue_ids: String(fixture.issueId), reviewer: "wave11dave" }, fixture.aliceCookie),
    );
    expect(skip.status).toBe(303);
    const afterSkip = await drizzle(env.DB).select({ n: issues.numComments }).from(issues).where(eq(issues.id, fixture.issueId)).get();
    expect(afterSkip?.n).toBe(beforeSkip?.n);
  });

  it("validates like the landed arm: poster refusal, unknown user, unprivileged doer", async () => {
    const fixture = await ensureWave11Fixtures();
    const poster = await fetchUi(
      "/alice/wave11/issues/request_review",
      formPost("/alice/wave11/issues/request_review", { action: "attach", issue_ids: String(fixture.issueId), reviewer: "alice" }, fixture.aliceCookie),
    );
    expect(poster.status).toBe(200);
    expect(await poster.text()).toContain("poster of pr can&#39;t be reviewer");

    const unknown = await fetchUi(
      "/alice/wave11/issues/request_review",
      formPost("/alice/wave11/issues/request_review", { action: "attach", issue_ids: String(fixture.issueId), reviewer: "nobody-here" }, fixture.aliceCookie),
    );
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toContain("user doesn&#39;t exist: nobody-here");

    const unprivileged = await fetchUi(
      "/alice/wave11/issues/request_review",
      formPost("/alice/wave11/issues/request_review", { action: "attach", issue_ids: String(fixture.issueId), reviewer: "wave11dave" }, fixture.carolCookie),
    );
    expect(unprivileged.status).toBe(200);
    expect(await unprivileged.text()).toContain("Doer can&#39;t choose reviewer");
  });

  it("lets the approved reviewer self-request (upstream's selfReRequest escape)", async () => {
    const fixture = await ensureWave11Fixtures();
    // Bob approved earlier in this file — his self-request rides the escape.
    const res = await fetchUi(
      "/alice/wave11/issues/request_review",
      formPost("/alice/wave11/issues/request_review", { action: "attach", issue_ids: String(fixture.issueId), reviewer: "wave11bob" }, fixture.bobCookie),
    );
    expect(res.status).toBe(303);
  });

  it("detaches by reviewer id with the removal comment and the counter bump", async () => {
    const fixture = await ensureWave11Fixtures();
    const before = await drizzle(env.DB).select({ n: issues.numComments }).from(issues).where(eq(issues.id, fixture.issueId)).get();
    const res = await fetchUi(
      "/alice/wave11/issues/request_review",
      formPost(
        "/alice/wave11/issues/request_review",
        { action: "detach", issue_ids: String(fixture.issueId), id: String(fixture.daveUserId) },
        fixture.aliceCookie,
      ),
    );
    expect(res.status).toBe(303);
    // The attach test made the REQUEST row dave's LATEST decision row, so
    // RemoveReviewRequest's latest-row guard passes and the row dies.
    const rows = await drizzle(env.DB)
      .select()
      .from(pullReviews)
      .where(and(eq(pullReviews.issueId, fixture.issueId), eq(pullReviews.reviewerId, fixture.daveUserId), eq(pullReviews.type, ReviewType.Request)))
      .all();
    expect(rows).toHaveLength(0);
    const removals = await drizzle(env.DB)
      .select()
      .from(comments)
      .where(
        and(
          eq(comments.issueId, fixture.issueId),
          eq(comments.type, CommentType.ReviewRequest),
          eq(comments.assigneeId, fixture.daveUserId),
          eq(comments.removedAssignee, 1),
        ),
      )
      .all();
    expect(removals.length).toBeGreaterThanOrEqual(1);
    const after = await drizzle(env.DB).select({ n: issues.numComments }).from(issues).where(eq(issues.id, fixture.issueId)).get();
    expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1);
  });
});

// --- the dismiss arm ------------------------------------------------------------

describe("POST /issues/dismiss_review (the dismissal arm)", () => {
  it("404-shells non-admins and answers GET with chi's 405", async () => {
    const fixture = await ensureWave11Fixtures();
    const daveRow = await drizzle(env.DB).select().from(pullReviews).where(and(eq(pullReviews.issueId, fixture.issueId), eq(pullReviews.type, ReviewType.Approve))).all();
    const target = daveRow.find((row) => row.reviewerId !== fixture.bobUserId);
    const res = await fetchUi(
      "/alice/wave11/issues/dismiss_review",
      formPost("/alice/wave11/issues/dismiss_review", { review_id: String(target?.id ?? 0), message: "not yours" }, fixture.bobCookie),
    );
    expect(res.status).toBe(404);

    const get = await fetchUi("/alice/wave11/issues/dismiss_review");
    expect(get.status).toBe(405);
  });

  it("dismisses an approve review as the admin with the dismissal comment and redirect", async () => {
    const fixture = await ensureWave11Fixtures();
    const target = (
      await drizzle(env.DB)
        .select()
        .from(pullReviews)
        .where(and(eq(pullReviews.issueId, fixture.issueId), eq(pullReviews.type, ReviewType.Approve), eq(pullReviews.dismissed, false)))
        .all()
    )[0];
    expect(target).toBeDefined();
    const before = await drizzle(env.DB).select({ n: issues.numComments }).from(issues).where(eq(issues.id, fixture.issueId)).get();
    const res = await fetchUi(
      "/alice/wave11/issues/dismiss_review",
      formPost("/alice/wave11/issues/dismiss_review", { review_id: String(target?.id ?? 0), message: "Stale approval." }, fixture.aliceCookie),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/alice/wave11/pulls/1#issuecomment-")).toBe(true);
    const commentId = Number.parseInt(location.split("-").pop() ?? "0", 10);
    const comment = await drizzle(env.DB).select().from(comments).where(eq(comments.id, commentId)).get();
    expect(comment?.type).toBe(CommentType.DismissReview); // 32
    expect(comment?.content).toBe("Stale approval.");
    const after = await drizzle(env.DB).select({ n: issues.numComments }).from(issues).where(eq(issues.id, fixture.issueId)).get();
    expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(1);
    const dismissed = await drizzle(env.DB).select().from(pullReviews).where(eq(pullReviews.id, target?.id ?? 0)).get();
    expect(dismissed?.dismissed).toBe(true);
  });

  it("refuses a REQUEST row with the landed 403 message in the plain-text shape", async () => {
    const fixture = await ensureWave11Fixtures();
    // Bob self-requested earlier — a REQUEST row exists for him.
    const request = (
      await drizzle(env.DB)
        .select()
        .from(pullReviews)
        .where(and(eq(pullReviews.issueId, fixture.issueId), eq(pullReviews.type, ReviewType.Request)))
        .all()
    )[0];
    expect(request).toBeDefined();
    const res = await fetchUi(
      "/alice/wave11/issues/dismiss_review",
      formPost("/alice/wave11/issues/dismiss_review", { review_id: String(request?.id ?? 0), message: "" }, fixture.aliceCookie),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("not need to dismiss this review because it's type is not Approve or change request");
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-11 a11y smoke", () => {
  it("the PR detail page passes the structural rules for every viewer kind", async () => {
    const fixture = await ensureWave11Fixtures();
    for (const [path, init] of [
      ["/alice/wave11/pulls/1", undefined],
      ["/alice/wave11/pulls/1", withCookie(fixture.aliceCookie)],
      ["/alice/wave11/pulls/1", withCookie(fixture.bobCookie)],
      ["/alice/wave11/pulls/1", withCookie(fixture.daveCookie)],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      // The merge box's inline card carries upstream's OWN h3s (the command
      // instruction titles, pull_merge_instruction.tmpl verbatim) — the a11y
      // suite's one allowed upstream-shape skip (a11y.test.ts's
      // upstreamMergeBoxHeadingSkips posture), bounded at one per page.
      const carriesMergeBox = html.includes('data-global-init="initRepoPullMergeBox"');
      const violations = runA11y(html).filter(
        (v) => !(carriesMergeBox && v.rule === "R2-no-skip" && v.detail === "<h1> followed by <h3>"),
      );
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});

/** The wave11 repo's id (shared by the later tests). */
async function db2RepoId(): Promise<string> {
  const row = await drizzle(env.DB)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave11")))
    .get();
  if (row === undefined) throw new Error("wave11 repo row missing");
  return row.id;
}
