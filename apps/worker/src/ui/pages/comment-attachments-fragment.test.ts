/**
 * The comment-attachments fragment's seam suite (PORT-FIRST: the loader
 * arms — the visibility ladder, the comment-miss arm, the type gate, the
 * empty list — plus the wire arm).
 *
 * Coverage split (the issue-new-choose seam's discipline — module-green is
 * not route-live):
 *
 *   - THE MODULE ARMS: the loader and Response builder are driven DIRECTLY
 *     on real D1 (workerd, @cloudflare/vitest-plugin) over a seeded
 *     user/two repos/issue with comments across the HasAttachmentSupport
 *     type arms and attachment rows on both the comment and the
 *     direct-issue namespaces;
 *   - THE ROUTE MATRIX (the tick-16 follow-up — the mount landed in
 *     fa4fd0d): the LIVE uiRouter answers `GET
 *     /{owner}/{repo}/comments/{id}/attachments` and these arms pin what
 *     the MOUNT really serves — the with-attachments + empty 200s, the
 *     visibility ladder through resolveUiRequest (anonymous allowed on a
 *     visible repo — the group's optSignIn folds to repo visibility;
 *     invisible repos 404-shell anonymous and signed-in strangers alike
 *     while the owner's session passes), the miss arms' REAL rendered 404
 *     shell, the type gate's 500, the GET-only registration, and the
 *     claim-state pins through the live parseUiRoute/handlesUiRoute.
 *
 * Fixture discipline (the issue-content-fragments D1-only pattern): tables
 * are wiped per test and re-seeded lazily; the route arms ride the same
 * fixture plus a private repo + an unrelated viewer (the owner session is
 * minted per request — the users wipe cascades the sessions table).
 *
 * Upstream citations (at the pin): web.go:1337/1342 (route + group gates),
 * issue_comment.go:150-161 (getRepoIssueComment) and :306-326
 * (GetCommentAttachments), models/issues/comment.go:1082-1093
 * (GetCommentWithRepoID's repo cross-check) and :188-196
 * (HasAttachmentSupport), models/repo/attachment.go:158-162
 * (GetAttachmentsByCommentID), services/convert/attachment.go:23-51
 * (ToAttachment, the WebAssetDownloadURL arm).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { asc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { CommentType } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { issueAttachments, repositories } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { uiEnv } from "../__tests__/harness";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import {
  commentAttachmentsFragmentResponse,
  commentHasAttachmentSupport,
  loadCommentAttachmentsFragment,
  pathParamInt64,
} from "./comment-attachments-fragment";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_750_200_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);
const ORIGIN = "https://test.local";

interface Seeded {
  ownerId: number;
  repoId: string;
  otherRepoId: string;
  issueId: number;
  /** The plain comment (type 0) carrying two attachments. */
  fedCommentId: number;
  /** The plain comment with no attachments. */
  emptyCommentId: number;
  /** The system comment (Label, type 7) — the type gate's 500 arm. */
  labelCommentId: number;
  /** The DismissReview comment (type 32) — content support WITHOUT
   *  attachment support (the HasAttachmentSupport asymmetry). */
  dismissCommentId: number;
  /** The code-comment (type 21) and review (type 22) — the gate's pass arms. */
  codeCommentId: number;
  reviewCommentId: number;
  /** A comment of the OTHER repo — the foreign-repo id arm. */
  foreignCommentId: number;
  /** The direct-issue attachment row (comment_id = 0) that must stay out. */
  directAttachmentUuid: string;
  /** The PRIVATE repo — the mounted route's visibility-gate arms. */
  vaultRepoId: string;
  /** The vault's fed comment (one attachment) — the owner's pass arm. */
  vaultCommentId: number;
  /** The unrelated signed-in viewer — sessions buy no visibility. */
  strangerId: number;
}

let seeded: Seeded | undefined;

async function seed(): Promise<Seeded> {
  if (seeded !== undefined) return seeded;
  const owner = await seedVerifiedUser({ username: "cattachowner" });
  const repo = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "cattachowner" },
    name: "cattachrepo",
    isPrivate: false,
    status: "ready",
  });
  const otherRepo = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "cattachowner" },
    name: "cattachother",
    isPrivate: false,
    status: "ready",
  });
  const svc = new IssuesService(env.DB);
  const issue = await svc.createIssue({
    repoId: repo.id,
    title: "comment attachments seam issue",
    content: "the body",
    posterId: owner.id,
    now: at(10),
  });

  const fed = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "has files", now: at(20) });
  const empty = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "no files", now: at(21) });
  const label = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "changed labels", type: CommentType.Label, now: at(22) });
  const dismiss = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "dismissed", type: CommentType.DismissReview, now: at(23) });
  const code = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "code comment", type: CommentType.Code, now: at(24) });
  const review = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "review", type: CommentType.Review, now: at(25) });

  // The OTHER repo's comment: the same GLOBAL-id namespace, out of scope.
  const otherIssue = await svc.createIssue({
    repoId: otherRepo.id,
    title: "foreign issue",
    content: "elsewhere",
    posterId: owner.id,
    now: at(30),
  });
  const foreign = await svc.addComment({ issueId: otherIssue.id, posterId: owner.id, content: "foreign", now: at(31) });

  // Two attachments on the fed comment, one DIRECT on the issue (comment_id
  // = 0 — must NOT ride the comment arm, attachment.go:158-162's predicate).
  await drizzle(env.DB).insert(issueAttachments).values([
    { uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000a1", issueId: issue.id, commentId: fed.id, uploaderId: owner.id, name: "spec-a.pdf", size: 2048, downloadCount: 7, createdAt: at(60) },
    { uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000a2", issueId: issue.id, commentId: fed.id, uploaderId: owner.id, name: "log-a.txt", size: 16, createdAt: at(61) },
    { uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000a9", issueId: issue.id, commentId: 0, uploaderId: owner.id, name: "direct.bin", size: 1, createdAt: at(62) },
  ]);

  // The PRIVATE repo (the mounted route's visibility arms) with its own fed
  // comment carrying one attachment — the owner's pass arm needs content
  // behind the gate, the shell arms need a secret that must NOT leak.
  const stranger = await seedVerifiedUser({ username: "cattachstranger" });
  const vault = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "cattachowner" },
    name: "cattachvault",
    isPrivate: true,
    status: "ready",
  });
  const vaultIssue = await svc.createIssue({
    repoId: vault.id,
    title: "vault thread",
    content: "private body",
    posterId: owner.id,
    now: at(40),
  });
  const vaultComment = await svc.addComment({ issueId: vaultIssue.id, posterId: owner.id, content: "vault files", now: at(41) });
  await drizzle(env.DB).insert(issueAttachments).values({
    uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000b1",
    issueId: vaultIssue.id,
    commentId: vaultComment.id,
    uploaderId: owner.id,
    name: "vault-secret.bin",
    size: 3,
    createdAt: at(42),
  });

  seeded = {
    ownerId: owner.id,
    repoId: repo.id,
    otherRepoId: otherRepo.id,
    issueId: issue.id,
    fedCommentId: fed.id,
    emptyCommentId: empty.id,
    labelCommentId: label.id,
    dismissCommentId: dismiss.id,
    codeCommentId: code.id,
    reviewCommentId: review.id,
    foreignCommentId: foreign.id,
    directAttachmentUuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000a9",
    vaultRepoId: vault.id,
    vaultCommentId: vaultComment.id,
    strangerId: stranger.id,
  };
  return seeded;
}

async function repoRow(repoId: string) {
  const row = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repoId)).get())!;
  return row;
}

// --- the mounted-route harness (the issues-list matrix pattern) -----------------

/** The LIVE production path (parse → resolveUiRequest → handler) over the
 *  mounted uiRouter with the synthetic manifest (the sibling matrices'
 *  two-arg fetch — this handler attaches no waitUntil work). */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

/** A minted-session cookie header for the user (the real mintSession path,
 *  minted per request — the beforeEach users wipe cascades the sessions
 *  table, so a cross-test cookie would go stale). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "issue_attachments",
    "issue_content_history",
    "issue_labels",
    "labels",
    "issue_subscriptions",
    "comments",
    "issues",
    "repo_settings",
    "repo_counters",
    "repo_units",
    "repo_redirects",
    "repositories",
    "personal_access_tokens",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  seeded = undefined;
});

// --- the loader arms -------------------------------------------------------------

describe("loadCommentAttachmentsFragment (issue_comment.go:306-326)", () => {
  it("ok: the comment's attachments in pk order, the direct-issue attachment stays out", async () => {
    const s = await seed();
    const repo = await repoRow(s.repoId);
    const outcome = await loadCommentAttachmentsFragment(env.DB, repo, String(s.fedCommentId));
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    // GetAttachmentsByCommentID's predicate (attachment.go:158-162): ONLY
    // this comment's rows — the direct issue attachment (comment_id = 0)
    // and the sibling comments' rows stay out; pk order pinned.
    expect(outcome.attachments.map((row) => row.name)).toEqual(["spec-a.pdf", "log-a.txt"]);
    expect(outcome.attachments.some((row) => row.uuid === s.directAttachmentUuid)).toBe(false);
  });

  it("empty list: the ok outcome carries no rows and the wire arm marshals [] (never null)", async () => {
    const s = await seed();
    const repo = await repoRow(s.repoId);
    const outcome = await loadCommentAttachmentsFragment(env.DB, repo, String(s.emptyCommentId));
    expect(outcome).toEqual({ kind: "ok", attachments: [] });

    // upstream's make([]*api.Attachment, 0) seed (issue_comment.go:318).
    const response = commentAttachmentsFragmentResponse(ORIGIN, outcome);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("[]");
  });

  it("comment-miss arm: a nonexistent id, a garbage id, and a negative id all fold to notFound", async () => {
    const s = await seed();
    const repo = await repoRow(s.repoId);

    // The plain miss (ErrCommentNotExist → upstream ServerError, folded to
    // the 404 class — the tree-list/tree-view lookup-miss convention).
    const missing = await loadCommentAttachmentsFragment(env.DB, repo, "999999");
    expect(missing).toEqual({ kind: "notFound" });

    // PathParamInt64's garbage → 0 (base_path.go:35-38) → guaranteed miss.
    const garbage = await loadCommentAttachmentsFragment(env.DB, repo, "abc");
    expect(garbage).toEqual({ kind: "notFound" });

    const negative = await loadCommentAttachmentsFragment(env.DB, repo, "-5");
    expect(negative).toEqual({ kind: "notFound" });

    // The folded 404 renders the not-found shell the mount passes.
    const response = commentAttachmentsFragmentResponse(ORIGIN, missing, "<html>404 shell</html>");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe("<html>404 shell</html>");
  });

  it("visibility ladder: a foreign repo's comment id answers notFound (GetCommentWithRepoID's repo cross-check)", async () => {
    const s = await seed();
    const repo = await repoRow(s.repoId);
    // Same global id namespace, different repo — upstream's
    // `c.Issue.RepoID != repoID` arm (comment.go:1090-1092).
    const foreign = await loadCommentAttachmentsFragment(env.DB, repo, String(s.foreignCommentId));
    expect(foreign).toEqual({ kind: "notFound" });

    // The owning repo answers ok — the scope, not the id, decided.
    const otherRepo = await repoRow(s.otherRepoId);
    const owned = await loadCommentAttachmentsFragment(env.DB, otherRepo, String(s.foreignCommentId));
    expect(owned.kind).toBe("ok");
  });

  it("type gate: system comments 500; DismissReview is excluded; Code and Review pass", async () => {
    const s = await seed();
    const repo = await repoRow(s.repoId);

    // Label (type 7) has no attachment support → upstream's ServerError
    // (issue_comment.go:312-316), kept upstream-faithful as the plain 500.
    const label = await loadCommentAttachmentsFragment(env.DB, repo, String(s.labelCommentId));
    expect(label).toEqual({ kind: "unsupportedType", commentType: CommentType.Label });
    const labelResponse = commentAttachmentsFragmentResponse(ORIGIN, label);
    expect(labelResponse.status).toBe(500);
    expect(await labelResponse.text()).toBe(
      `GetCommentAttachments: comment type ${CommentType.Label} does not support attachments`,
    );

    // The HasContentSupport/HasAttachmentSupport asymmetry
    // (comment.go:180-196): DismissReview has content support but NO
    // attachment support — it must 500 like the system comments.
    const dismiss = await loadCommentAttachmentsFragment(env.DB, repo, String(s.dismissCommentId));
    expect(dismiss).toEqual({ kind: "unsupportedType", commentType: CommentType.DismissReview });

    // The pass arms: Code (21) and Review (22) load (empty) lists.
    const code = await loadCommentAttachmentsFragment(env.DB, repo, String(s.codeCommentId));
    expect(code).toEqual({ kind: "ok", attachments: [] });
    const review = await loadCommentAttachmentsFragment(env.DB, repo, String(s.reviewCommentId));
    expect(review).toEqual({ kind: "ok", attachments: [] });
  });
});

// --- the wire arm ------------------------------------------------------------------

describe("commentAttachmentsFragmentResponse (issue_comment.go:318-325)", () => {
  it("the structs.Attachment wire shape over the ok rows (the ToAttachment twin)", async () => {
    const s = await seed();
    const repo = await repoRow(s.repoId);
    const outcome = await loadCommentAttachmentsFragment(env.DB, repo, String(s.fedCommentId));
    if (outcome.kind !== "ok") throw new Error(`expected ok, got ${outcome.kind}`);

    const response = commentAttachmentsFragmentResponse(ORIGIN, outcome);
    expect(response.status).toBe(200);
    // ctx.JSON's content-type + the web middleware's zero-option prod
    // Cache-Control (the fragments-family header set).
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");

    const payload = await response.json<Array<{ id: number; name: string; created_at: string; download_count: number; size: number; uuid: string; browser_download_url: string }>>();
    expect(payload).toHaveLength(2);
    expect(payload[0]).toEqual({
      id: outcome.attachments[0]?.id,
      name: "spec-a.pdf",
      created_at: at(60).toISOString(),
      download_count: 7,
      size: 2048,
      uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000a1",
      browser_download_url: `${ORIGIN}/attachments/aaaaaaaa-bbbb-cccc-dddd-0000000000a1`,
    });
  });
});

// --- the parse + gate pins ---------------------------------------------------------

describe("pathParamInt64 + commentHasAttachmentSupport pins", () => {
  it("pathParamInt64: the PathParamInt64 port (garbage → 0, negatives pass, unsafe magnitudes → 0)", () => {
    expect(pathParamInt64("123")).toBe(123);
    expect(pathParamInt64("-5")).toBe(-5);
    expect(pathParamInt64("abc")).toBe(0);
    expect(pathParamInt64("")).toBe(0);
    expect(pathParamInt64("12abc")).toBe(0);
    expect(pathParamInt64("+5")).toBe(0); // the landed pathId twin's convention
    expect(pathParamInt64("99999999999999999999")).toBe(0); // not a safe integer
  });

  it("commentHasAttachmentSupport: exactly Comment/Code/Review (comment.go:188-196)", () => {
    expect(commentHasAttachmentSupport(CommentType.Comment)).toBe(true);
    expect(commentHasAttachmentSupport(CommentType.Code)).toBe(true);
    expect(commentHasAttachmentSupport(CommentType.Review)).toBe(true);
    expect(commentHasAttachmentSupport(CommentType.DismissReview)).toBe(false);
    expect(commentHasAttachmentSupport(CommentType.Reopen)).toBe(false);
    expect(commentHasAttachmentSupport(CommentType.Label)).toBe(false);
  });
});

// --- the mounted route (the tick-16 follow-up — module-green is not route-live) ----
//
// fa4fd0d landed the parse family + the registration; the tick-16 re-walk
// recorded that the route had NO request-level arm. The arms below drive the
// LIVE router (fetchUi) and pin what the MOUNT really answers — the module
// outcome union surfacing verbatim through resolveUiRequest's gates:
// optSignIn folds to repo visibility (anonymous allowed on a visible repo),
// invisible repos 404-shell, and the loader's outcome union rides the
// handler's renderNotFound injection.

describe("the mounted route GET /{owner}/{repo}/comments/{id}/attachments (the request-level matrix)", () => {
  it("the with-attachments arm: the LIVE router answers 200 with the structs.Attachment array (pk order, the request origin in the download URLs)", async () => {
    const s = await seed();
    // ANONYMOUS — the group's optSignIn folds to repo visibility, so the
    // public repo serves the fragment to a signed-out fetch (the official
    // bundle's dropzone read).
    const res = await fetchUi(`/cattachowner/cattachrepo/comments/${s.fedCommentId}/attachments`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");

    const rows = await drizzle(env.DB)
      .select({ id: issueAttachments.id })
      .from(issueAttachments)
      .where(eq(issueAttachments.commentId, s.fedCommentId))
      .orderBy(asc(issueAttachments.id))
      .all();
    const payload = await res.json<
      Array<{ id: number; name: string; created_at: string; download_count: number; size: number; uuid: string; browser_download_url: string }>
    >();
    expect(payload.map((row) => row.name)).toEqual(["spec-a.pdf", "log-a.txt"]); // attachment.go:158-162's predicate + id ASC
    expect(payload[0]).toEqual({
      id: rows[0]?.id,
      name: "spec-a.pdf",
      created_at: at(60).toISOString(),
      download_count: 7,
      size: 2048,
      uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000a1",
      browser_download_url: "https://test.local/attachments/aaaaaaaa-bbbb-cccc-dddd-0000000000a1", // the WebAssetDownloadURL arm over the REQUEST origin
    });
    expect(payload[1]?.browser_download_url).toBe("https://test.local/attachments/aaaaaaaa-bbbb-cccc-dddd-0000000000a2");
  });

  it("the empty arm: the route marshals [] — never null (upstream's make(…, 0) seed riding the mount)", async () => {
    const s = await seed();
    const res = await fetchUi(`/cattachowner/cattachrepo/comments/${s.emptyCommentId}/attachments`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await res.text()).toBe("[]");
  });

  it("the visibility ladder rides resolveUiRequest: anonymous AND a signed-in stranger 404-shell the private repo, the owner's session passes (200 with the vault attachment)", async () => {
    const s = await seed();
    const anonymous = await fetchUi(`/cattachowner/cattachvault/comments/${s.vaultCommentId}/attachments`);
    expect(anonymous.status).toBe(404); // existence hidden — NO login 303 (optSignIn, not reqSignIn)
    const anonHtml = await anonymous.text();
    expect(anonHtml).toContain('<div class="status-page-error">');
    expect(anonHtml).not.toContain("vault-secret.bin"); // the secret never leaks through the shell

    const stranger = await fetchUi(`/cattachowner/cattachvault/comments/${s.vaultCommentId}/attachments`, {
      headers: { cookie: await sessionHeader(s.strangerId) },
    });
    expect(stranger.status).toBe(404); // sessions buy no visibility
    expect(await stranger.text()).toContain('<div class="status-page-error">');

    const owner = await fetchUi(`/cattachowner/cattachvault/comments/${s.vaultCommentId}/attachments`, {
      headers: { cookie: await sessionHeader(s.ownerId) },
    });
    expect(owner.status).toBe(200); // the grant line the shells exist to guard
    const payload = await owner.json<Array<{ uuid: string; name: string }>>();
    expect(payload).toHaveLength(1);
    expect(payload[0]?.name).toBe("vault-secret.bin");
  });

  it("an unknown repo 404-shells with the rendered page (the parse claims the head for ANY owner/repo pair — existence is resolveUiRequest's)", async () => {
    await seed();
    const res = await fetchUi("/cattachowner/cattachnowhere/comments/1/attachments");
    expect(res.status).toBe(404);
    // Hono's c.html casing (uppercase UTF-8) — the resolveUiRequest shell,
    // distinct from the loader's own lowercase-utf-8 404 header below.
    expect(res.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    const html = await res.text();
    expect(html).toContain('<div class="status-page-error">');
    expect(html).toContain("404 Not Found");
  });

  it("the miss arms ride the route: a nonexistent, garbage, and negative id answer the REAL rendered 404 shell (the unconstrained :id reaches the loader's PathParamInt64 fold)", async () => {
    await seed();
    for (const [label, id] of [
      ["nonexistent", "999999"],
      ["garbage", "abc"],
      ["negative", "-5"],
    ] as const) {
      const res = await fetchUi(`/cattachowner/cattachrepo/comments/${id}/attachments`);
      expect(res.status, label).toBe(404);
      // The HANDLER's shell (renderNotFound rode the builder) — a router-
      // pattern miss would be Hono's plain text, so the content-type proves
      // the registration claimed the unconstrained segment.
      expect(res.headers.get("content-type"), label).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect(html, label).toContain('<div class="status-page-error">');
      expect(html, label).toContain("404 Not Found");
    }
  });

  it("the foreign-repo id 404-shells through the route (GetCommentWithRepoID's repo cross-check riding the mount)", async () => {
    const s = await seed();
    const res = await fetchUi(`/cattachowner/cattachrepo/comments/${s.foreignCommentId}/attachments`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div class="status-page-error">');
  });

  it("the type gate's 500 through the route: the label comment's plain-text ServerError body verbatim", async () => {
    const s = await seed();
    const res = await fetchUi(`/cattachowner/cattachrepo/comments/${s.labelCommentId}/attachments`);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe(
      `GetCommentAttachments: comment type ${CommentType.Label} does not support attachments`,
    );
  });

  it("GET-only: a POST on the claimed URL misses the registration (the parse is method-blind, the mounted GET pattern is not — upstream chi answers 405 there, the module header's disclosed divergence)", async () => {
    const s = await seed();
    const res = await fetchUi(`/cattachowner/cattachrepo/comments/${s.fedCommentId}/attachments`, { method: "POST" });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("text/html"); // the router's plain miss — not the handler's shell
    expect(await res.text()).not.toContain("spec-a.pdf");
  });
});

// --- the claim state (the sibling issue-new-choose seam's pin discipline) ----------

describe("the claim state (parseUiRoute + handlesUiRoute through the live parser)", () => {
  it("the repo-level comments head is CLAIMED: the family rides the raw id segment", () => {
    expect(parseUiRoute("/cattachowner/cattachrepo/comments/42/attachments")).toEqual({
      family: "comment-attachments",
      owner: "cattachowner",
      repo: "cattachrepo",
      segment: "42",
    });
    expect(handlesUiRoute("/cattachowner/cattachrepo/comments/42/attachments")).toBe(true);
  });

  it("the guards overclaim nothing: bare/misspelled/deeper/case shapes stay as they are, the issue-level twins keep their families", () => {
    // The length-2 + exact-literal guard claims ONLY `comments/{id}/attachments`.
    expect(parseUiRoute("/cattachowner/cattachrepo/comments/42/attachments/extra")).toBeNull();
    expect(parseUiRoute("/cattachowner/cattachrepo/comments/42/attachment")).toBeNull();
    expect(parseUiRoute("/cattachowner/cattachrepo/comments/42/Attachments")).toBeNull(); // lowercase-exact literals
    expect(parseUiRoute("/cattachowner/cattachrepo/comment/42/attachments")).toBeNull();
    expect(parseUiRoute("/cattachowner/cattachrepo/commentsx/42/attachments")).toBeNull();
    // The issue-level namespaces (a different head) keep their fragment/write
    // families — the new repo-level head must not disturb them.
    expect(parseUiRoute("/cattachowner/cattachrepo/issues/1/comments")).toMatchObject({ family: "issue-comment" });
    expect(parseUiRoute("/cattachowner/cattachrepo/issues/1/attachments")).toMatchObject({ family: "issue-attachments" });
    expect(parseUiRoute("/cattachowner/cattachrepo/pulls/2/attachments")).toMatchObject({ family: "issue-attachments" });
  });
});
