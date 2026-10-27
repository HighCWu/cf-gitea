/**
 * The content-history write-path hooks (specs/issue-content-history.md §3)
 * over the landed edit services — upstream `ChangeIssueContent`
 * (models/issues/issue_update.go:315-350), `UpdateComment`
 * (services/issue/comments.go:97-140), `DeleteComment`
 * (models/issues/comment.go:1208-1219) and `KeepLimitedContentHistory`
 * (models/issues/content_history.go:56-106).
 *
 * Fixture discipline: real D1 (workerd, @cloudflare/vitest-plugin), the
 * migrations via the TEST_MIGRATIONS harness, one seeded user/repo/issue
 * per test (beforeEach wipes; the memoized seed is per-test fresh).
 *
 * - issue body: the lazy first-revision back-fill (poster + created stamp,
 *   is_first_created) exactly once, edited revisions attributed to the
 *   actor, the CAS miss saves NOTHING, and the 20-revision retention
 *   collapses surplus middle revisions keeping both ends.
 * - comment: the gate (content change AND content-support type), the same
 *   lazy back-fill, actor attribution, and the delete hook removing the
 *   comment's revisions with the comment.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { CommentType } from "../../issues/comment-types";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { comments, issueContentHistory } from "../../db/schema";
import { changeIssueBody, deleteComment, updateCommentBody } from "./issues";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_750_100_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

interface Seeded {
  ownerId: number;
  editorId: number;
  repoId: string;
  issue: Awaited<ReturnType<IssuesService["createIssue"]>>;
}

let seeded: Seeded | undefined;

async function seed(): Promise<Seeded> {
  if (seeded !== undefined) return seeded;
  const owner = await seedVerifiedUser({ username: "histowner" });
  const editor = await seedVerifiedUser({ username: "histeditor" });
  const repo = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "histowner" },
    name: "histrepo",
    isPrivate: false,
    status: "ready",
  });
  const issue = await new IssuesService(env.DB).createIssue({
    repoId: repo.id,
    title: "history hooks issue",
    content: "the body",
    posterId: owner.id,
    now: at(10),
  });
  seeded = { ownerId: owner.id, editorId: editor.id, repoId: repo.id, issue };
  return seeded;
}

async function revisions(issueId: number, commentId = 0) {
  return drizzle(env.DB)
    .select()
    .from(issueContentHistory)
    .where(and(eq(issueContentHistory.issueId, issueId), eq(issueContentHistory.commentId, commentId)))
    .orderBy(asc(issueContentHistory.editedAt))
    .all();
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "issue_content_history",
    "issue_subscriptions",
    "comments",
    "issues",
    "repo_settings",
    "repo_counters",
    "repo_units",
    "repo_redirects",
    "repositories",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  seeded = undefined;
});

// --- the hooks -----------------------------------------------------------------

describe("issue content history write-path hooks", () => {
  it("issue body edit: lazy first-revision back-fill once, edited revisions attributed to the actor", async () => {
    const s = await seed();

    // First edit: the back-fill ("the body" at the issue's created stamp,
    // attributed to the poster) + the edited revision (attributed to the
    // acting editor).
    const first = await changeIssueBody(env.DB, s.issue, "v1", 0, at(50), s.editorId);
    expect(first).not.toBeNull();
    let rows = await revisions(s.issue.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      posterId: s.ownerId,
      contentText: "the body",
      isFirstCreated: true,
    });
    expect(rows[0]?.editedAt.getTime()).toBe(at(10).getTime());
    expect(rows[1]).toMatchObject({ posterId: s.editorId, contentText: "v1", isFirstCreated: false });
    expect(rows[1]?.editedAt.getTime()).toBe(at(50).getTime());

    // Second edit: no second back-fill, the edited revision appended (no
    // actor → the issue poster fallback, SPEC §5.1).
    if (first === null) return;
    const second = await changeIssueBody(env.DB, first, "v2", 1, at(60));
    expect(second).not.toBeNull();
    rows = await revisions(s.issue.id);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.isFirstCreated)).toHaveLength(1);
    expect(rows[2]).toMatchObject({ posterId: s.ownerId, contentText: "v2", isFirstCreated: false });
  });

  it("issue body edit: a stale CAS version saves nothing (no revisions, no content)", async () => {
    const s = await seed();
    const stale = await changeIssueBody(env.DB, s.issue, "lost", 99, at(50), s.editorId);
    expect(stale).toBeNull();
    // The CAS UPDATE runs before any history write — nothing was ever saved.
    expect(await revisions(s.issue.id)).toHaveLength(0);
    const reread = await new IssuesService(env.DB).getIssueById(s.issue.id);
    expect(reread?.content).toBe("the body");
  });

  it("comment edit: gated on content change AND content-support type; the delete hook removes the revisions", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const comment = await svc.addComment({ issueId: s.issue.id, posterId: s.ownerId, content: "v0", now: at(20) });

    // Same content → no history (upstream needsContentHistory gate).
    await updateCommentBody(env.DB, comment.id, "v0", at(25), s.editorId);
    expect(await revisions(s.issue.id, comment.id)).toHaveLength(0);

    // Content change on a content-support comment → the lazy back-fill +
    // the edited revision attributed to the actor.
    await updateCommentBody(env.DB, comment.id, "v1", at(30), s.editorId);
    const rows = await revisions(s.issue.id, comment.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ posterId: s.ownerId, contentText: "v0", isFirstCreated: true });
    expect(rows[0]?.editedAt.getTime()).toBe(at(20).getTime());
    expect(rows[1]).toMatchObject({ posterId: s.editorId, contentText: "v1", isFirstCreated: false });

    // A system comment (ChangeTitle) has no content support: no history even
    // when its content changes.
    const systemComment = await svc.addComment({
      issueId: s.issue.id,
      posterId: s.ownerId,
      content: "",
      type: CommentType.ChangeTitle,
      now: at(35),
    });
    await updateCommentBody(env.DB, systemComment.id, "rewritten", at(40), s.editorId);
    expect(await revisions(s.issue.id, systemComment.id)).toHaveLength(0);

    // The delete hook: the comment's revisions never outlive the comment.
    const reloaded = (await drizzle(env.DB).select().from(comments).where(eq(comments.id, comment.id)).all())[0];
    expect(reloaded).toBeDefined();
    if (reloaded === undefined) return;
    await deleteComment(env.DB, reloaded, at(45));
    expect(await revisions(s.issue.id, comment.id)).toHaveLength(0);
    // The other namespaces are untouched.
    expect(await revisions(s.issue.id, systemComment.id)).toHaveLength(0);
  });

  it("retention: 26 revisions collapse to 20, middle-out with both ends kept", async () => {
    const s = await seed();
    // 1 back-fill + 25 edits = 26 rows → 6 surplus middle deletions. With
    // equal 10 s edit intervals (and a 90 s back-fill gap), upstream's
    // smallest-interval-to-predecessor rule deletes v1,v3,v5,v7,v9,v11 —
    // merging the odd revisions into their predecessors — keeping
    // created("the body"), v0,v2,v4,v6,v8,v10 and v12..v24.
    let current = s.issue;
    for (let i = 0; i < 25; i++) {
      const next = await changeIssueBody(env.DB, current, `v${i}`, current.contentVersion, at(100 + i * 10), s.ownerId);
      expect(next).not.toBeNull();
      if (next === null) return;
      current = next;
    }
    const rows = await revisions(s.issue.id);
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ contentText: "the body", isFirstCreated: true });
    expect(rows[1]).toMatchObject({ contentText: "v0", isFirstCreated: false });
    expect(rows[6]).toMatchObject({ contentText: "v10", isFirstCreated: false });
    expect(rows[7]).toMatchObject({ contentText: "v12", isFirstCreated: false });
    expect(rows[19]).toMatchObject({ contentText: "v24", isFirstCreated: false });
  });
});
