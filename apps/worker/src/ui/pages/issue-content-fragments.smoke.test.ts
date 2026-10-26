/**
 * The issue-content-fragments module's smoke test (PORT-FIRST: ONE happy
 * path per implemented arm, no matrices — the polish wave owns the rest).
 *
 * Fixture discipline (the issues-search-aux D1-only pattern): the module is
 * UNMOUNTED — every handler is index-owned (the module header's mount
 * recipes carry the mapping) — so the tests drive the loaders and Response
 * builders DIRECTLY on real D1 (workerd, @cloudflare/vitest-plugin) over a
 * seeded user/repo/issue with labels, comment edits (the landed body-edit
 * services bump the content_version counters the overview reconstructs)
 * and attachment rows.
 *
 * - info: the converted-issue envelope + the rendered-labels HTML across
 *   all three RenderLabel arms in one render (regular, archived, scoped
 *   with order) and the missing-index 404 outcome.
 * - attachments: the comment_id = 0 predicate (a comment attachment must
 *   NOT ride the issue list) + the structs.Attachment wire shape.
 * - content-history/overview: the counter-based editedHistoryCountMap —
 *   the edited issue body, the twice-edited comment, the never-edited
 *   comment absent (upstream's HAVING count(1) > 1).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { issueAttachments, issueLabels, labels, repositories } from "../../db/schema";
import { changeIssueBody, updateCommentBody } from "../../api/services/issues";
import {
  contentHistoryOverviewFragmentResponse,
  issueAttachmentsFragmentResponse,
  issueInfoFragmentResponse,
  loadContentHistoryOverviewFragment,
  loadIssueAttachmentsFragment,
  loadIssueInfoFragment,
  resolveFragmentIssue,
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

  // Two comments: one edited twice (content_version 2), one never edited.
  const edited = await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "v0" });
  await updateCommentBody(env.DB, edited.id, "v1", at(30));
  await updateCommentBody(env.DB, edited.id, "v2", at(40));
  await svc.addComment({ issueId: issue.id, posterId: owner.id, content: "never edited" });

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

  it("content-history overview: the counter map keys the edited bodies only, valued at revision count", async () => {
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
});
