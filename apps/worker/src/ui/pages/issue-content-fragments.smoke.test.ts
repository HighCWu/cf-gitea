/**
 * The issue-content-fragments module's smoke test (PORT-FIRST: ONE happy
 * path per implemented arm, no matrices — the polish wave owns the rest).
 *
 * Fixture discipline (the issues-search-aux D1-only pattern): the module is
 * UNMOUNTED — every handler is index-owned (the module header's mount
 * recipes carry the mapping) — so the tests drive the loaders and Response
 * builders DIRECTLY on real D1 (workerd, @cloudflare/vitest-plugin) over a
 * seeded user/repo/issue with labels, comment edits (the landed body-edit
 * services carry the content-history write hooks — specs/
 * issue-content-history.md §3 — so the seed produces real snapshot rows)
 * and attachment rows.
 *
 * - info: the converted-issue envelope + the rendered-labels HTML across
 *   all three RenderLabel arms in one render (regular, archived, scoped
 *   with order) and the missing-index 404 outcome.
 * - attachments: the comment_id = 0 predicate (a comment attachment must
 *   NOT ride the issue list) + the structs.Attachment wire shape.
 * - content-history/overview: the editedHistoryCountMap queried from the
 *   snapshot table (upstream's HAVING count(1) > 1) — the edited issue
 *   body, the twice-edited comment, the never-edited comment absent.
 * - content-history/list: the dropdown payload across the edited/created
 *   action arms, edited_unix DESC, the user-row join, the empty namespace
 *   `{"results": null}` arm, and FormInt64 parse semantics.
 * - content-history/detail: the diffHtml render (exact dmp spans),
 *   prevHistoryId chaining, the canSoftDelete arms (anonymous/owner/
 *   comment-poster), the JSON 404 on a foreign history id, and the
 *   orphaned-comment empty-200 quirk.
 * - content-history/soft-delete: the write arm's response map (the `{"ok":
 *   true}` 200, the JSON 403 denial, the HTML-shell 404s, the two
 *   empty-200 quirks), the row flip (is_deleted + the EMPTIED body), and
 *   the visibility flips it causes in the sibling read arms (the deleted
 *   marker in the list, the prev-chain skip in detail, the unfiltered
 *   overview count) — plus the actor-attribution end-to-end (an editor's
 *   revision, attributed through the hooks' actorId arm, is soft-deletable
 *   by that editor alone).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { issueAttachments, issueContentHistory, issueLabels, labels, comments, repositories, users } from "../../db/schema";
import { changeIssueBody, softDeleteIssueContentHistory, updateCommentBody } from "../../api/services/issues";
import {
  contentHistoryDetailFragmentResponse,
  contentHistoryListFragmentResponse,
  contentHistoryOverviewFragmentResponse,
  contentHistorySoftDeleteFragmentResponse,
  formInt64,
  issueAttachmentsFragmentResponse,
  issueInfoFragmentResponse,
  loadContentHistoryDetailFragment,
  loadContentHistoryListFragment,
  loadContentHistoryOverviewFragment,
  loadIssueAttachmentsFragment,
  loadIssueInfoFragment,
  resolveFragmentIssue,
  softDeleteContentHistoryFragment,
} from "./issue-content-fragments";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_750_100_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);
const ORIGIN = "https://test.local";
const ANONYMOUS = { kind: "anonymous" } as const;

interface Seeded {
  ownerId: number;
  repoId: string;
  repoLink: string;
  issue: Awaited<ReturnType<IssuesService["createIssue"]>>;
  editedCommentId: number;
}

let seeded: Seeded | undefined;

async function seed(): Promise<Seeded> {
  if (seeded !== undefined) return seeded;
  const owner = await seedVerifiedUser({ username: "fragowner" });
  const repo = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "fragowner" },
    name: "fragrepo",
    isPrivate: false,
    status: "ready",
  });
  const svc = new IssuesService(env.DB);
  const issue = await svc.createIssue({
    repoId: repo.id,
    title: "fragment smoke issue",
    content: "the body",
    posterId: owner.id,
    now: at(10),
  });

  // The three RenderLabel arms (util_render.go:71-131) on one issue.
  const inserted = await drizzle(env.DB)
    .insert(labels)
    .values([
      { repoId: repo.id, name: "bug", color: "#00aabb", description: "regular arm" },
      { repoId: repo.id, name: "stale", color: "#ffffff", description: "archived arm", archivedAt: at(20) },
      { repoId: repo.id, name: "priority/high", color: "#ee0701", exclusive: true, exclusiveOrder: 3, description: "scoped arm" },
    ])
    .returning();
  await drizzle(env.DB).insert(issueLabels).values(inserted.map((row) => ({ issueId: issue.id, labelId: row.id })));

  // Two comments: one edited twice (content_version 2), one never edited —
  // with explicit stamps so the snapshot revisions' edited_unix order is
  // deterministic (created < edit1 < edit2).
  const edited = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "v0", now: at(25) });
  await updateCommentBody(env.DB, edited.id, "v1", at(30));
  await updateCommentBody(env.DB, edited.id, "v2", at(40));
  await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "never edited", now: at(26) });

  // The issue body edited once (content_version 1).
  await changeIssueBody(env.DB, issue, "the edited body", 0, at(50));

  // Direct attachments: two on the issue, one on the edited comment (the
  // comment one must NOT answer the issue arm — attachment.go:135-141).
  await drizzle(env.DB).insert(issueAttachments).values([
    { uuid: "aaaaaaaa-bbbb-cccc-dddd-000000000001", issueId: issue.id, uploaderId: owner.id, name: "spec.pdf", size: 2048, downloadCount: 7, createdAt: at(60) },
    { uuid: "aaaaaaaa-bbbb-cccc-dddd-000000000002", issueId: issue.id, uploaderId: owner.id, name: "log.txt", size: 16, createdAt: at(61) },
    { uuid: "aaaaaaaa-bbbb-cccc-dddd-000000000003", issueId: issue.id, commentId: edited.id, uploaderId: owner.id, name: "comment-shot.png", size: 512, createdAt: at(62) },
  ]);

  seeded = { ownerId: owner.id, repoId: repo.id, repoLink: "/fragowner/fragrepo", issue, editedCommentId: edited.id };
  return seeded;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "issue_content_history",
    "issue_attachments",
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

// --- the three implemented arms -----------------------------------------------

describe("issue content fragments", () => {
  it("info: converts the issue and renders all three label arms; a missing index 404s", async () => {
    const s = await seed();
    const repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, s.repoId)).get())!;
    const outcome = await loadIssueInfoFragment(env.DB, repo, "issues", s.issue.index, ORIGIN, ANONYMOUS, s.repoLink);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;

    // convertedIssue = toApiIssue (the sidebar refresh envelope's Issue).
    expect(outcome.convertedIssue.number).toBe(s.issue.index);
    expect(outcome.convertedIssue.title).toBe("fragment smoke issue");
    expect(outcome.convertedIssue.body).toBe("the edited body");
    expect(outcome.convertedIssue.content_version).toBe(1);
    expect(outcome.convertedIssue.state).toBe("open");

    // renderedLabels: labels-list wrapper, ?links onto the issues filter,
    // the regular arm, the archived arm, the scoped arm with its order div.
    const html = outcome.renderedLabels;
    expect(html).toMatch(/^<span class="labels-list">.*<\/span>$/);
    expect(html).toContain(`<a class="item" href="${s.repoLink}/issues?labels=`);
    expect(html).toContain(
      `<span class="ui label " style="color: #fff !important; background-color: #00aabb !important;" data-tooltip-content title="regular arm"><span class="gt-ellipsis">bug</span></span>`,
    );
    expect(html).toContain(`<span class="ui label archived-label"`);
    expect(html).toContain(`title="(Archived) archived arm"`);
    expect(html).toContain(`class="ui label  scope-parent"`);
    expect(html).toContain(`<div class="ui label scope-right">3</div>`);

    // The wire arm: ctx.JSON 200 {convertedIssue, renderedLabels}.
    const response = issueInfoFragmentResponse(outcome);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const payload = await response.json<{ convertedIssue: { number: number }; renderedLabels: string }>();
    expect(payload.convertedIssue.number).toBe(s.issue.index);
    expect(payload.renderedLabels).toBe(html);

    // Missing index → the 404 outcome (the mount renders the not-found shell).
    const missing = await loadIssueInfoFragment(env.DB, repo, "issues", 999, ORIGIN, ANONYMOUS, s.repoLink);
    expect(missing).toEqual({ kind: "notFound" });
    expect(issueInfoFragmentResponse(missing, "<html>404</html>").status).toBe(404);
  });

  it("attachments: lists the issue's DIRECT attachments only, in the structs.Attachment shape", async () => {
    const s = await seed();
    const repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, s.repoId)).get())!;
    const issue = await resolveFragmentIssue(env.DB, repo, s.issue.index);
    expect(issue).not.toBeNull();
    if (issue === null) return;

    const rows = await loadIssueAttachmentsFragment(env.DB, issue.id);
    // The comment attachment (comment_id > 0) stays out (attachment.go:135-141).
    expect(rows.map((row) => row.name)).toEqual(["spec.pdf", "log.txt"]);

    const response = issueAttachmentsFragmentResponse(ORIGIN, rows);
    expect(response.status).toBe(200);
    const payload = await response.json<Array<{ id: number; name: string; size: number; download_count: number; uuid: string; browser_download_url: string }>>();
    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({
      name: "spec.pdf",
      size: 2048,
      download_count: 7,
      uuid: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
      browser_download_url: `${ORIGIN}/attachments/aaaaaaaa-bbbb-cccc-dddd-000000000001`,
    });
  });

  it("content-history overview: the snapshot-table map keys the edited bodies only, valued at revision count", async () => {
    const s = await seed();
    const repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, s.repoId)).get())!;
    const issue = await resolveFragmentIssue(env.DB, repo, s.issue.index);
    expect(issue).not.toBeNull();
    if (issue === null) return;

    const data = await loadContentHistoryOverviewFragment(env.DB, issue);
    expect(data.i18n).toEqual({
      textEdited: "edited",
      textDeleteFromHistory: "Delete from history",
      textDeleteFromHistoryConfirm: "Delete from history?",
      textOptions: "Options",
    });
    // Issue body edited once → key "0" at 2 revisions (1 first-created + 1
    // edit); the twice-edited comment → 3; the never-edited comment absent
    // (upstream's HAVING count(1) > 1).
    const keys = Object.keys(data.editedHistoryCountMap).sort((a, b) => Number(a) - Number(b));
    expect(keys).toEqual(["0", String(s.editedCommentId)] as string[]);
    expect(data.editedHistoryCountMap["0"]).toBe(2);
    expect(data.editedHistoryCountMap[String(s.editedCommentId)]).toBe(3);

    const response = contentHistoryOverviewFragmentResponse(data);
    expect(response.status).toBe(200);
    const payload = await response.json<typeof data>();
    expect(payload.editedHistoryCountMap).toEqual(data.editedHistoryCountMap);
  });

  it("content-history list: the dropdown payload per revision, edited_unix DESC, null when empty", async () => {
    const s = await seed();
    const repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, s.repoId)).get())!;
    const issue = await resolveFragmentIssue(env.DB, repo, s.issue.index);
    expect(issue).not.toBeNull();
    if (issue === null) return;

    // The fullName segment arm needs a non-empty full name.
    await drizzle(env.DB).update(users).set({ fullName: "Frag Owner" }).where(eq(users.id, s.ownerId));

    // The issue-body namespace (comment_id = 0): edited@50 first (DESC),
    // created@10 second with the `created` action.
    const bodyList = await loadContentHistoryListFragment(env.DB, issue, 0);
    expect(bodyList.results).toHaveLength(2);
    const bodyResults = bodyList.results!;
    expect(bodyResults[1]?.name).toContain("created");
    expect(bodyResults[0]?.name).toContain("edited");
    // The item HTML: avatar fast-link + strong userName (no fullName on the
    // created revision's segment? both rows join the same user row, so the
    // segment rides both) + the relative-time stamp.
    expect(bodyResults[0]?.name).toContain(`<img loading="lazy" alt class="ui avatar tw-align-middle tw-mr-2" src="/user/avatar/fragowner/0" title="fragowner" width="24" height="24">`);
    expect(bodyResults[0]?.name).toContain("<strong>fragowner</strong>");
    expect(bodyResults[0]?.name).toContain(`(<span class="tw-inline-flex tw-max-w-[160px]"><span class="gt-ellipsis">Frag Owner</span></span>)`);
    expect(bodyResults[0]?.name).toMatch(/<relative-time prefix="" tense="past" datetime="\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z" data-tooltip-content data-tooltip-interactive="true">/);
    // The values are the history ids, newest first (the detail test chains
    // on them).
    const historyRows = await drizzle(env.DB)
      .select({ id: issueContentHistory.id, editedAt: issueContentHistory.editedAt })
      .from(issueContentHistory)
      .all();
    expect(historyRows).toHaveLength(5); // 2 body + 3 comment revisions

    // The comment namespace: v2@40, v1@30, created@25 — the created arm last.
    const commentList = await loadContentHistoryListFragment(env.DB, issue, s.editedCommentId);
    expect(commentList.results).toHaveLength(3);
    const commentNames = commentList.results!.map((item) => item.name);
    expect(commentNames[2]).toContain("created");
    expect(commentNames[0]).toContain("edited");
    expect(commentNames[0]).toContain("<strong>fragowner</strong>");

    // The never-edited comment's namespace is empty → upstream's nil slice.
    const emptyNamespace = await loadContentHistoryListFragment(env.DB, issue, 999999);
    expect(emptyNamespace).toEqual({ results: null });
    const response = contentHistoryListFragmentResponse(emptyNamespace);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify({ results: null }));

    // FormInt64 parse semantics (Go FormInt64: garbage → 0).
    expect(formInt64(null)).toBe(0);
    expect(formInt64("abc")).toBe(0);
    expect(formInt64("-7")).toBe(-7);
    expect(formInt64(String(s.editedCommentId))).toBe(s.editedCommentId);
  });

  it("content-history detail: the diff payload, canSoftDelete arms, the JSON 404 and the orphan quirk", async () => {
    const s = await seed();
    const repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, s.repoId)).get())!;
    const issue = await resolveFragmentIssue(env.DB, repo, s.issue.index);
    expect(issue).not.toBeNull();
    if (issue === null) return;
    const ownerViewer = { kind: "user", id: s.ownerId, username: "fragowner", isAdmin: false } as const;

    // The body namespace revisions, oldest first: "the body"@10, "the edited body"@50.
    const bodyRevisions = await drizzle(env.DB)
      .select({ id: issueContentHistory.id, contentText: issueContentHistory.contentText, editedAt: issueContentHistory.editedAt })
      .from(issueContentHistory)
      .all();
    const body = bodyRevisions
      .filter((row) => row.contentText.startsWith("the "))
      .sort((a, b) => a.editedAt.getTime() - b.editedAt.getTime());
    expect(body.map((row) => row.contentText)).toEqual(["the body", "the edited body"]);
    const createdId = body[0]?.id;
    const editedId = body[1]?.id;
    expect(createdId).toBeDefined();
    expect(editedId).toBeDefined();
    if (createdId === undefined || editedId === undefined) return;

    // The latest revision diffs against its predecessor: "the body" →
    // "the edited body" renders as equal("the ") + insert("edited ") +
    // equal("body") — the dmp port's exact spans.
    const detail = await loadContentHistoryDetailFragment(env, repo, issue, ownerViewer, 0, editedId);
    expect(detail).toMatchObject({
      kind: "ok",
      canSoftDelete: true, // the repo owner's write grant
      historyId: editedId,
      prevHistoryId: createdId,
    });
    if (detail.kind !== "ok") return;
    expect(detail.diffHtml).toBe(`<pre class="chroma">the <span class="gi">edited </span>body</pre>`);
    const response = contentHistoryDetailFragmentResponse(detail);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const payload = await response.json<{ canSoftDelete: boolean; historyId: number; prevHistoryId: number; diffHtml: string }>();
    expect(payload.diffHtml).toBe(detail.diffHtml);

    // The first-created revision has NO predecessor: prevHistoryId 0, diff
    // against "" (whole insert).
    const first = await loadContentHistoryDetailFragment(env, repo, issue, ownerViewer, 0, createdId);
    expect(first).toMatchObject({ kind: "ok", prevHistoryId: 0 });
    if (first.kind === "ok") expect(first.diffHtml).toBe(`<pre class="chroma"><span class="gi">the body</span></pre>`);

    // Anonymous non-writer → canSoftDelete false.
    const anonymous = await loadContentHistoryDetailFragment(env, repo, issue, ANONYMOUS, 0, editedId);
    expect(anonymous).toMatchObject({ kind: "ok", canSoftDelete: false });

    // The comment-poster arm: a non-owner poster can soft-delete their own
    // comment's revisions.
    const poster = await seedVerifiedUser({ username: "fragposter" });
    const svc = new IssuesService(env.DB);
    const posterComment = await svc.addComment({ issueId: issue.id, posterId: poster.id, content: "poster v0", now: at(70) });
    await updateCommentBody(env.DB, posterComment.id, "poster v1", at(80));
    const posterRevisions = await drizzle(env.DB)
      .select({ id: issueContentHistory.id, editedAt: issueContentHistory.editedAt })
      .from(issueContentHistory)
      .all();
    const posterLatest = posterRevisions
      .filter((row) => row.editedAt.getTime() === at(80).getTime())
      .map((row) => row.id)[0];
    expect(posterLatest).toBeDefined();
    if (posterLatest === undefined) return;
    const posterViewer = { kind: "user", id: poster.id, username: "fragposter", isAdmin: false } as const;
    const posterDetail = await loadContentHistoryDetailFragment(env, repo, issue, posterViewer, posterComment.id, posterLatest);
    expect(posterDetail).toMatchObject({ kind: "ok", canSoftDelete: true });
    // The comment namespace diff: "poster v1" → v0? the LATEST revision is
    // "poster v1" against prev "poster v0" — the whole "0"→"1" char swap.
    if (posterDetail.kind === "ok") {
      expect(posterDetail.diffHtml).toBe(`<pre class="chroma">poster v<span class="gd">0</span><span class="gi">1</span></pre>`);
    }

    // A foreign history id → the JSON 404 (NOT the HTML shell).
    const missing = await loadContentHistoryDetailFragment(env, repo, issue, ownerViewer, 0, 999999);
    expect(missing).toEqual({ kind: "historyNotFound" });
    const missingResponse = contentHistoryDetailFragmentResponse(missing);
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.text()).toBe(JSON.stringify({ message: "Can not find the content history" }));

    // The orphaned-comment quirk (upstream logs and returns an EMPTY 200):
    // only reachable by fabricating a history row with no comment row.
    const orphanDate = at(90);
    const inserted = await drizzle(env.DB)
      .insert(issueContentHistory)
      .values({ issueId: issue.id, commentId: 424242, posterId: s.ownerId, editedAt: orphanDate, contentText: "orphan", isFirstCreated: false })
      .returning({ id: issueContentHistory.id });
    const orphanId = inserted[0]?.id;
    expect(orphanId).toBeDefined();
    if (orphanId === undefined) return;
    const orphan = await loadContentHistoryDetailFragment(env, repo, issue, ownerViewer, 424242, orphanId);
    expect(orphan).toEqual({ kind: "orphanedComment" });
    const orphanResponse = contentHistoryDetailFragmentResponse(orphan);
    expect(orphanResponse.status).toBe(200);
    expect(await orphanResponse.text()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The deferred arms (the polish wave): the 20-revision retention limiter's
// boundary, the soft-delete row's read-side markers, and the canSoftDelete
// gate's revision-poster family — each provenance-cited against the upstream
// content-history model (models/issues/content_history.go at the pin).
// ---------------------------------------------------------------------------

/** All history rows of one namespace, oldest first (the limiter's SELECT
 *  shape — content_history.go:74-79's ORDER BY edited_unix ASC read). */
async function namespaceRows(commentId: number): Promise<Array<{ id: number; editedAt: Date; isFirstCreated: boolean }>> {
  const rows = await drizzle(env.DB)
    .select({ id: issueContentHistory.id, editedAt: issueContentHistory.editedAt, isFirstCreated: issueContentHistory.isFirstCreated })
    .from(issueContentHistory)
    .where(eq(issueContentHistory.commentId, commentId))
    .all();
  return rows.sort((a, b) => a.editedAt.getTime() - b.editedAt.getTime());
}

describe("the 20-revision retention limiter's boundary (content_history.go:56-106)", () => {
  it("exactly 20 revisions: nothing is dropped — the cap is inclusive (KeepLimitedContentHistory's `<= limit` return)", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const comment = await svc.addComment({ issueId: s.issue.id, posterId: s.ownerId, content: "limiter v0", now: at(100) });
    // The lazy back-fill makes the first edit insert TWO rows (created + the
    // edit); 19 edits total → exactly 20 revisions, one per second.
    for (let i = 1; i <= 19; i++) {
      await updateCommentBody(env.DB, comment.id, `limiter v${i}`, at(100 + i));
    }
    const rows = await namespaceRows(comment.id);
    expect(rows).toHaveLength(20); // content_history.go:78's `if len <= limit return`
    expect(rows[0]?.isFirstCreated).toBe(true); // the created revision survives
    expect(rows[19]?.editedAt.getTime()).toBe(at(119).getTime()); // the newest survives
  });

  it("the 21st revision: ONE smallest-interval middle is hard-deleted — first and last are never deleted (:86-101)", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const comment = await svc.addComment({ issueId: s.issue.id, posterId: s.ownerId, content: "limiter v0", now: at(100) });
    for (let i = 1; i <= 20; i++) {
      await updateCommentBody(env.DB, comment.id, `limiter v${i}`, at(100 + i));
    }
    const rows = await namespaceRows(comment.id);
    expect(rows).toHaveLength(20); // 21 - 1 surplus (outDatedCount, :80)
    // Uniform 1 s intervals → every middle interval ties, and the scan keeps
    // the EARLIEST minimum (strict `<`, :90) — the second-oldest revision is
    // the deleted one.
    const times = rows.map((row) => row.editedAt.getTime());
    expect(times).toEqual([
      at(100).getTime(), // the first-created revision — NEVER deleted (:92-93)
      ...Array.from({ length: 18 }, (_, i) => at(102 + i).getTime()), // @101 is gone
      at(120).getTime(), // the newest revision — NEVER deleted (:94's last index)
    ]);
    expect(rows[0]?.isFirstCreated).toBe(true);
  });

  it("the overview count reads the SATURATED namespace: 20 (the map rides the same rows, issue_content_history.go:38-39)", async () => {
    const s = await seed();
    const svc = new IssuesService(env.DB);
    const comment = await svc.addComment({ issueId: s.issue.id, posterId: s.ownerId, content: "limiter v0", now: at(100) });
    for (let i = 1; i <= 20; i++) {
      await updateCommentBody(env.DB, comment.id, `limiter v${i}`, at(100 + i));
    }
    const data = await loadContentHistoryOverviewFragment(env.DB, s.issue);
    expect(data.editedHistoryCountMap[String(comment.id)]).toBe(20); // still > 1 — the dropdown badge
  });
});

describe("the soft-deleted revision's read-side arms (the dropdown's deleted marker + the unfiltered count)", () => {
  it("the list marks a deleted revision with the <i data-history-is-deleted> element (issue_content_history.go:56-63)", async () => {
    const s = await seed();
    const repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, s.repoId)).get())!;
    const issue = await resolveFragmentIssue(env.DB, repo, s.issue.index);
    expect(issue).not.toBeNull();
    if (issue === null) return;
    await drizzle(env.DB)
      .insert(issueContentHistory)
      .values({ issueId: issue.id, commentId: 0, posterId: s.ownerId, editedAt: at(60), contentText: "removed draft", isFirstCreated: false, isDeleted: true });

    const list = await loadContentHistoryListFragment(env.DB, issue, 0);
    expect(list.results).toHaveLength(3);
    const names = list.results!.map((item) => item.name);
    expect(names.filter((name) => name.includes('<i data-history-is-deleted="1">deleted</i>'))).toHaveLength(1);
    // The live revisions keep the plain action arms.
    expect(names.filter((name) => name.includes("created"))).toHaveLength(1);
    expect(names.filter((name) => name.includes("edited"))).toHaveLength(1);
  });

  it("the overview counts deleted revisions (NO is_deleted filter — content_history.go:110-133's verbatim GROUP BY)", async () => {
    const s = await seed();
    const repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, s.repoId)).get())!;
    const issue = await resolveFragmentIssue(env.DB, repo, s.issue.index);
    expect(issue).not.toBeNull();
    if (issue === null) return;
    await drizzle(env.DB)
      .insert(issueContentHistory)
      .values({ issueId: issue.id, commentId: 0, posterId: s.ownerId, editedAt: at(60), contentText: "removed draft", isFirstCreated: false, isDeleted: true });

    const data = await loadContentHistoryOverviewFragment(env.DB, s.issue);
    expect(data.editedHistoryCountMap["0"]).toBe(3); // 2 live + 1 soft-deleted
  });
});

describe("the canSoftDelete gate's revision-poster family (content_history.go:84-110)", () => {
  it("a viewer who merely EDITED the comment (the revision's poster, neither issue- nor comment-poster) can soft-delete their revision; a stranger cannot", async () => {
    const s = await seed();
    const repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, s.repoId)).get())!;
    const issue = await resolveFragmentIssue(env.DB, repo, s.issue.index);
    expect(issue).not.toBeNull();
    if (issue === null) return;
    const svc = new IssuesService(env.DB);
    const editor = await seedVerifiedUser({ username: "frageditor" });
    const stranger = await seedVerifiedUser({ username: "fragstranger" });

    // The owner posts; the EDITOR rewrites it via the actorId arm — the
    // revision row's poster is the editor, not the comment poster.
    const comment = await svc.addComment({ issueId: issue.id, posterId: s.ownerId, content: "owner wrote", now: at(110) });
    await updateCommentBody(env.DB, comment.id, "editor rewrote", at(111), editor.id);
    const rows = await namespaceRows(comment.id);
    expect(rows).toHaveLength(2);
    const editRevision = rows[1]!; // @111 — posterId = the editor (issues.ts:883 actorId ?? prior.posterId)

    const editorViewer = { kind: "user", id: editor.id, username: "frageditor", isAdmin: false } as const;
    const editorDetail = await loadContentHistoryDetailFragment(env, repo, issue, editorViewer, comment.id, editRevision.id);
    expect(editorDetail).toMatchObject({ kind: "ok", canSoftDelete: true }); // :105's history.PosterID arm

    const strangerViewer = { kind: "user", id: stranger.id, username: "fragstranger", isAdmin: false } as const;
    const strangerDetail = await loadContentHistoryDetailFragment(env, repo, issue, strangerViewer, comment.id, editRevision.id);
    expect(strangerDetail).toMatchObject({ kind: "ok", canSoftDelete: false }); // no grant, no poster match
  });
});

// ---------------------------------------------------------------------------
// The soft-delete POST arm (issue_content_history.go:183-236
// SoftDeleteContentHistory — upstream web.go:1391, the reqSignIn'd UPDATE
// group): the loader's guard order verbatim, the row flip, and the
// visibility flips across the sibling read arms.
// ---------------------------------------------------------------------------

describe("the soft-delete POST arm (issue_content_history.go:183-236)", () => {
  it("the owner hides a body revision: the write empties the snapshot, and every read arm reflects the flip", async () => {
    const s = await seed();
    const repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, s.repoId)).get())!;
    const issue = await resolveFragmentIssue(env.DB, repo, s.issue.index);
    expect(issue).not.toBeNull();
    if (issue === null) return;
    const ownerViewer = { kind: "user", id: s.ownerId, username: "fragowner", isAdmin: false } as const;

    // The body namespace: created@10 ("the body") + edited@50 ("the edited body").
    const bodyRevisions = await drizzle(env.DB)
      .select({ id: issueContentHistory.id, editedAt: issueContentHistory.editedAt })
      .from(issueContentHistory)
      .all();
    const editedId = bodyRevisions
      .filter((row) => row.editedAt.getTime() === at(50).getTime())
      .map((row) => row.id)[0];
    expect(editedId).toBeDefined();
    if (editedId === undefined) return;

    // The owner rides the repo-write grant arm of canSoftDeleteContentHistory.
    const outcome = await softDeleteContentHistoryFragment(env, repo, issue, ownerViewer, 0, editedId);
    expect(outcome).toEqual({ kind: "deleted" });
    const response = contentHistorySoftDeleteFragmentResponse(outcome);
    expect(response.status).toBe(200); // ALWAYS 200 — :233-235 writes ctx.JSON(200, {"ok": …})
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await response.text()).toBe(JSON.stringify({ ok: true }));

    // The row flip (content_history.go:184-186): is_deleted + the body
    // EMPTIED to "" (never NULL).
    const row = await drizzle(env.DB).select().from(issueContentHistory).where(eq(issueContentHistory.id, editedId)).get();
    expect(row?.isDeleted).toBe(true);
    expect(row?.contentText).toBe("");

    // The detail arm still RESOLVES the deleted revision (the target is not
    // is_deleted-filtered) — but its content is gone, so the diff runs
    // against the surviving predecessor as a pure delete.
    const detailAfter = await loadContentHistoryDetailFragment(env, repo, issue, ownerViewer, 0, editedId);
    expect(detailAfter).toMatchObject({ kind: "ok", historyId: editedId });
    if (detailAfter.kind === "ok") {
      expect(detailAfter.diffHtml).toBe(`<pre class="chroma"><span class="gd">the body</span></pre>`);
    }

    // The list arm keeps the entry with the deleted marker (the dropdown
    // refuses detail on it — repo-issue-content.ts:121).
    const list = await loadContentHistoryListFragment(env.DB, issue, 0);
    expect(list.results).toHaveLength(2);
    expect(list.results![0]?.name).toContain('<i data-history-is-deleted="1">deleted</i>');

    // The overview still counts it (no is_deleted filter, content_history.go:117-122).
    const overview = await loadContentHistoryOverviewFragment(env.DB, issue);
    expect(overview.editedHistoryCountMap["0"]).toBe(2);

    // Service parity: a no-match id is NOT an error (xorm's Update affects
    // zero rows and returns nil — the ok arm, :231-235).
    expect(await softDeleteIssueContentHistory(env.DB, 999999)).toBe(true);
  });

  it("a soft-deleted MIDDLE revision drops out of the prev-diff chain; the actorId-attributed editor can hide their own revision", async () => {
    const s = await seed();
    const repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, s.repoId)).get())!;
    const issue = await resolveFragmentIssue(env.DB, repo, s.issue.index);
    expect(issue).not.toBeNull();
    if (issue === null) return;
    const svc = new IssuesService(env.DB);
    const poster = await seedVerifiedUser({ username: "fragposter" });
    const editor = await seedVerifiedUser({ username: "frageditor" });

    // The poster posts; the EDITOR rewrites twice through the hooks' actorId
    // arm — both edit revisions' poster_id is the editor (the §5.1
    // attribution); the first-created back-fill stays poster-attributed.
    const comment = await svc.addComment({ issueId: issue.id, posterId: poster.id, content: "v0", now: at(110) });
    await updateCommentBody(env.DB, comment.id, "v1", at(111), editor.id);
    await updateCommentBody(env.DB, comment.id, "v2", at(112), editor.id);
    const rows = await namespaceRows(comment.id);
    expect(rows).toHaveLength(3);
    const createdRevision = rows[0]!; // @110 — "v0" (poster-attributed back-fill)
    const middleRevision = rows[1]!; // @111 — "v1" (editor-attributed)
    const latestRevision = rows[2]!; // @112 — "v2" (editor-attributed)

    // Attribution end-to-end: BOTH edit entries NAME the editor.
    const listBefore = await loadContentHistoryListFragment(env.DB, issue, comment.id);
    expect(listBefore.results).toHaveLength(3);
    expect(listBefore.results![0]?.name).toContain("<strong>frageditor</strong>");
    expect(listBefore.results![1]?.name).toContain("<strong>frageditor</strong>");
    expect(listBefore.results![2]?.name).toContain("<strong>fragposter</strong>");

    // Baseline chain: the latest revision diffs against the middle one.
    const before = await loadContentHistoryDetailFragment(
      env,
      repo,
      issue,
      { kind: "user", id: s.ownerId, username: "fragowner", isAdmin: false },
      comment.id,
      latestRevision.id,
    );
    expect(before).toMatchObject({ kind: "ok", prevHistoryId: middleRevision.id });
    if (before.kind === "ok") {
      expect(before.diffHtml).toBe(`<pre class="chroma">v<span class="gd">1</span><span class="gi">2</span></pre>`);
    }

    // The EDITOR — neither the issue poster nor the comment poster, only
    // the MIDDLE revision's poster — hides it through the
    // history.PosterID arm of canSoftDeleteContentHistory (:104).
    const editorViewer = { kind: "user", id: editor.id, username: "frageditor", isAdmin: false } as const;
    expect(await softDeleteContentHistoryFragment(env, repo, issue, editorViewer, comment.id, middleRevision.id)).toEqual({ kind: "deleted" });
    const flipped = await drizzle(env.DB).select().from(issueContentHistory).where(eq(issueContentHistory.id, middleRevision.id)).get();
    expect(flipped?.isDeleted).toBe(true);
    expect(flipped?.contentText).toBe("");

    // The visibility flip: the latest revision's prev chain SKIPS the
    // deleted middle and now diffs against the first-created revision.
    const after = await loadContentHistoryDetailFragment(env, repo, issue, editorViewer, comment.id, latestRevision.id);
    expect(after).toMatchObject({ kind: "ok", prevHistoryId: createdRevision.id });
    if (after.kind === "ok") {
      expect(after.diffHtml).toBe(`<pre class="chroma">v<span class="gd">0</span><span class="gi">2</span></pre>`);
    }

    // The deleted middle itself still resolves (the target is NOT
    // is_deleted-filtered) — its emptied body diffs as a pure delete
    // against the surviving predecessor.
    const middle = await loadContentHistoryDetailFragment(env, repo, issue, editorViewer, comment.id, middleRevision.id);
    expect(middle).toMatchObject({ kind: "ok", historyId: middleRevision.id, prevHistoryId: createdRevision.id });
    if (middle.kind === "ok") {
      expect(middle.diffHtml).toBe(`<pre class="chroma"><span class="gd">v0</span></pre>`);
    }

    // The list keeps all three entries; the hidden one carries the marker.
    const listAfter = await loadContentHistoryListFragment(env.DB, issue, comment.id);
    expect(listAfter.results).toHaveLength(3);
    expect(listAfter.results!.filter((item) => item.name.includes('<i data-history-is-deleted="1">deleted</i>'))).toHaveLength(1);
  });

  it("the guard arms: stranger 403, anonymous + scope mismatches the HTML 404, the two misses the empty-200 quirks", async () => {
    const s = await seed();
    const repo = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, s.repoId)).get())!;
    const issue = await resolveFragmentIssue(env.DB, repo, s.issue.index);
    expect(issue).not.toBeNull();
    if (issue === null) return;
    const ownerViewer = { kind: "user", id: s.ownerId, username: "fragowner", isAdmin: false } as const;
    const stranger = await seedVerifiedUser({ username: "fragstranger" });
    const strangerViewer = { kind: "user", id: stranger.id, username: "fragstranger", isAdmin: false } as const;

    const bodyRevisions = await drizzle(env.DB)
      .select({ id: issueContentHistory.id, editedAt: issueContentHistory.editedAt })
      .from(issueContentHistory)
      .all();
    const editedId = bodyRevisions
      .filter((row) => row.editedAt.getTime() === at(50).getTime())
      .map((row) => row.id)[0];
    expect(editedId).toBeDefined();
    if (editedId === undefined) return;

    // A signed-in stranger without any grant or poster match → the JSON 403
    // (:224-229) — the body the bundle toasts (repo-issue-content.ts:54).
    const forbidden = await softDeleteContentHistoryFragment(env, repo, issue, strangerViewer, 0, editedId);
    expect(forbidden).toEqual({ kind: "forbidden" });
    const forbiddenResponse = contentHistorySoftDeleteFragmentResponse(forbidden);
    expect(forbiddenResponse.status).toBe(403);
    expect(await forbiddenResponse.text()).toBe(JSON.stringify({ message: "Can not delete the content history" }));
    const unflipped = await drizzle(env.DB).select().from(issueContentHistory).where(eq(issueContentHistory.id, editedId)).get();
    expect(unflipped?.isDeleted).toBe(false); // the denial wrote NOTHING

    // Anonymous → ctx.NotFound(nil) (:188-191) — the HTML shell 404.
    const anonymous = await softDeleteContentHistoryFragment(env, repo, issue, ANONYMOUS, 0, editedId);
    expect(anonymous).toEqual({ kind: "notFound" });
    const anonymousResponse = contentHistorySoftDeleteFragmentResponse(anonymous, "<html>404</html>");
    expect(anonymousResponse.status).toBe(404);
    expect(anonymousResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await anonymousResponse.text()).toBe("<html>404</html>");

    // Global history-id miss (:200-203) — the log-and-return EMPTY 200.
    const missing = await softDeleteContentHistoryFragment(env, repo, issue, ownerViewer, 0, 999999);
    expect(missing).toEqual({ kind: "orphanedHistory" });
    const missingResponse = contentHistorySoftDeleteFragmentResponse(missing);
    expect(missingResponse.status).toBe(200);
    expect(await missingResponse.text()).toBe("");

    // comment_id mismatch (:208-211): a body revision requested under the
    // comment namespace is a ctx.NotFound HTML 404.
    const commentMismatch = await softDeleteContentHistoryFragment(env, repo, issue, ownerViewer, s.editedCommentId, editedId);
    expect(commentMismatch).toEqual({ kind: "notFound" });

    // A history row of ANOTHER issue (:204-207) — same HTML 404.
    const foreignInserted = await drizzle(env.DB)
      .insert(issueContentHistory)
      .values({ issueId: 999999, commentId: 0, posterId: s.ownerId, editedAt: at(130), contentText: "foreign", isFirstCreated: false })
      .returning({ id: issueContentHistory.id });
    const foreignId = foreignInserted[0]?.id;
    expect(foreignId).toBeDefined();
    if (foreignId === undefined) return;
    expect(await softDeleteContentHistoryFragment(env, repo, issue, ownerViewer, 0, foreignId)).toEqual({ kind: "notFound" });

    // The comment-scope guard (:217-220): the history row marries a comment
    // id whose ROW lives on another issue — the comment resolves, the scope
    // check fails.
    const otherIssue = await new IssuesService(env.DB).createIssue({
      repoId: repo.id,
      title: "the other issue",
      content: "",
      posterId: s.ownerId,
      now: at(131),
    });
    await drizzle(env.DB).insert(comments).values({ id: 424242, type: 0, issueId: otherIssue.id, posterId: s.ownerId, content: "elsewhere" });
    const marriedInserted = await drizzle(env.DB)
      .insert(issueContentHistory)
      .values({ issueId: issue.id, commentId: 424242, posterId: s.ownerId, editedAt: at(132), contentText: "married", isFirstCreated: false })
      .returning({ id: issueContentHistory.id });
    const marriedId = marriedInserted[0]?.id;
    expect(marriedId).toBeDefined();
    if (marriedId === undefined) return;
    expect(await softDeleteContentHistoryFragment(env, repo, issue, ownerViewer, 424242, marriedId)).toEqual({ kind: "notFound" });

    // The orphaned-comment quirk (:213-216): the married comment id with NO
    // row — the EMPTY 200.
    const orphanInserted = await drizzle(env.DB)
      .insert(issueContentHistory)
      .values({ issueId: issue.id, commentId: 424243, posterId: s.ownerId, editedAt: at(133), contentText: "orphaned", isFirstCreated: false })
      .returning({ id: issueContentHistory.id });
    const orphanId = orphanInserted[0]?.id;
    expect(orphanId).toBeDefined();
    if (orphanId === undefined) return;
    const orphaned = await softDeleteContentHistoryFragment(env, repo, issue, ownerViewer, 424243, orphanId);
    expect(orphaned).toEqual({ kind: "orphanedComment" });
    const orphanedResponse = contentHistorySoftDeleteFragmentResponse(orphaned);
    expect(orphanedResponse.status).toBe(200);
    expect(await orphanedResponse.text()).toBe("");
  });
});
