/**
 * The issue-attachment web WRITE arms' seam suite (PORT-FIRST: the two POST
 * handlers are driven DIRECTLY — the ui/index.ts fold is a recorded handoff
 * riding behind the flying sibling's index.ts ownership; the mount recipe
 * lives in the module header).
 *
 * Coverage split (the comment-attachments-fragment seam's discipline —
 * module-green is not route-live):
 *
 *   - THE UPLOAD ARM (attachment.go:47-79): the dropzone's multipart `file`
 *     part lands through the API family's row-first store seam UNLINKED
 *     (issue_id 0 / comment_id 0 — upstream's `&Attachment{Name, UploaderID,
 *     RepoID}`), the R2 object under the family key, the 200 `{"uuid"}`
 *     contract byte-shape, the ServerError class (non-multipart / no file
 *     part / malformed body / over-cap — attachment.go:66-72's fall-through)
 *     and the over-cap cleanup of both halves.
 *   - THE REMOVE ARM (attachment.go:82-132): the exact miss-400 body, the
 *     bare 403, the repo-mismatch 400 on the release half, the uploader
 *     fast-path, the per-half grants (linked → CanWriteIssuesOrPulls fold,
 *     unlinked → IsAdmin/IsOwner fold with the WRITE-collaborator 403 pin,
 *     release → CanWrite(Releases) fold), the dangling-issue 500, the
 *     row-then-object delete, and the pending (r2_key NULL) arm.
 *   - THE FORM-VALUE MERGE + THE DROPZONE FRAGMENT (upload.go:118-133,
 *     repo/upload.tmpl) — the dropzone JS contract's attribute shapes.
 *
 * Fixture discipline (the sibling D1-only pattern): tables wiped per test,
 * real users/repos/issues through the landed services, attachment rows
 * seeded straight into the split halves.
 *
 * Upstream citations (at the pin): web.go:1394-1395 + :1471-1473 (routes +
 * group gates), routers/web/repo/attachment.go:47-79 (UploadIssueAttachment)
 * and :82-132 (DeleteAttachment), services/attachment/attachment.go:19-115
 * (NewAttachment + the upload ladder), services/context/upload/upload.go:
 * 45-133 (Verify + the comment dropzone URLs), models/repo/attachment.go:
 * 87-89/:181-211 (the miss message + DeleteAttachment), modules/setting/
 * attachment.go:19-24 (the frozen defaults), web_src/js/features/dropzone.ts
 * (the {uuid} contract).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { renderToString } from "hono/jsx/dom/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { issueAttachments, releaseAssets, repoCollaborators, repositories } from "../../db/schema";
import { MAX_ISSUE_ATTACHMENT_BYTES } from "../../api/routes/issue-attachments";
import type { RepoRow } from "../ui-context";
import type { Viewer } from "../viewer";
import {
  CommentAttachmentsDropzone,
  ISSUE_ATTACHMENT_ACCEPTS,
  issueAttachmentRemoveResponse,
  issueAttachmentUploadResponse,
  removeAttachmentByUuid,
  removeAttachmentFormValue,
  uploadIssueAttachmentFromMultipart,
  type IssueAttachmentRemoveOutcome,
  type IssueAttachmentUploadOutcome,
} from "./issue-attachments-write";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_750_200_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

interface Seeded {
  ownerId: number;
  uploaderId: number;
  strangerId: number;
  collaboratorId: number;
  repoId: string;
  repo: RepoRow;
  issueId: number;
  /** The site-admin viewer — no D1 row needed (the grant matrix reads only
   *  the projected viewer for this arm). */
  adminViewer: Viewer;
  ownerViewer: Viewer;
  strangerViewer: Viewer;
  collaboratorViewer: Viewer;
  anonymousViewer: Viewer;
}

let seeded: Seeded | undefined;

async function seed(): Promise<Seeded> {
  if (seeded !== undefined) return seeded;
  const owner = await seedVerifiedUser({ username: "iawowner" });
  const uploader = await seedVerifiedUser({ username: "iawuploader" });
  const stranger = await seedVerifiedUser({ username: "iawstranger" });
  const collaborator = await seedVerifiedUser({ username: "iawcollab" });
  const repo = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "iawowner" },
    name: "iawrepo",
    isPrivate: false,
    status: "ready",
  });
  const issue = await new IssuesService(env.DB).createIssue({
    repoId: repo.id,
    title: "web attachment arms issue",
    content: "the body",
    posterId: owner.id,
    now: at(10),
  });
  const row = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, repo.id)).get())!;
  const asViewer = (user: { id: number; username: string }): Viewer => ({
    kind: "user",
    id: user.id,
    username: user.username,
    isAdmin: false,
  });
  seeded = {
    ownerId: owner.id,
    uploaderId: uploader.id,
    strangerId: stranger.id,
    collaboratorId: collaborator.id,
    repoId: repo.id,
    repo: row,
    issueId: issue.id,
    adminViewer: { kind: "user", id: 999_999, username: "iawsiteadmin", isAdmin: true },
    ownerViewer: asViewer(owner),
    strangerViewer: asViewer(stranger),
    collaboratorViewer: asViewer(collaborator),
    anonymousViewer: { kind: "anonymous" },
  };
  return seeded;
}

/** A write-mode collaborator row (the repo_collaborators PK insert). */
async function seedWriteCollaborator(repoId: string, userId: number): Promise<void> {
  await drizzle(env.DB).insert(repoCollaborators).values({ repoId, userId, mode: "write", createdAt: at(5) });
}

/** A multipart POST request the way Dropzone sends it (one `file` part with
 *  a filename; FormData's boundary rides the Content-Type). */
function dropzoneRequest(filename: string, bytes: Uint8Array): Request {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), filename);
  return new Request("https://test.local/o/r/issues/attachments", { method: "POST", body: form });
}

/** Seed one unlinked issue-half row (this module's upload shape) with the
 *  R2 object in place; returns the row. */
async function seedUnlinkedRow(
  repo: RepoRow,
  uploaderId: number,
  overrides?: Partial<typeof issueAttachments.$inferInsert>,
): Promise<typeof issueAttachments.$inferSelect> {
  const values = {
    uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000u1",
    issueId: 0,
    commentId: 0,
    uploaderId,
    name: "dropped.txt",
    size: 3,
    r2Key: `repos/${repo.storageKey}/attachments/9001/dropped.txt`,
    createdAt: at(50),
    ...overrides,
  };
  const inserted = await drizzle(env.DB).insert(issueAttachments).values(values).returning();
  const row = inserted[0]!;
  await env.REPO_PACKS.put(row.r2Key ?? "", new Uint8Array([1, 2, 3]));
  return row;
}

async function rowByUuid(uuid: string) {
  return (await drizzle(env.DB).select().from(issueAttachments).where(eq(issueAttachments.uuid, uuid)).limit(1))[0];
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  await env.REPO_PACKS.list({ prefix: "repos/" }).then(async (page) => {
    for (const object of page.objects) await env.REPO_PACKS.delete(object.key);
  });
  for (const table of [
    "issue_attachments",
    "release_assets",
    "repo_collaborators",
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

// --- the upload arm ------------------------------------------------------------

describe("uploadIssueAttachmentFromMultipart (attachment.go:47-79)", () => {
  it("ok: the dropzone `file` part lands unlinked (issue_id 0 / comment_id 0) through the landed store seam, bytes + row + key verbatim", async () => {
    const s = await seed();
    const bytes = new TextEncoder().encode("attachment payload bytes");
    const outcome = await uploadIssueAttachmentFromMultipart(env, s.repo, s.uploaderId, dropzoneRequest("notes draft.txt", bytes));
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error(outcome.kind);

    const row = await rowByUuid(outcome.uuid);
    expect(row).toBeDefined();
    // Upstream's insert shape (attachment.go:61-65): name + uploader; the
    // uuid is random, the link columns zero (REPO-LEVEL upload, before any
    // issue/comment exists).
    expect(row?.issueId).toBe(0);
    expect(row?.commentId).toBe(0);
    expect(row?.uploaderId).toBe(s.uploaderId);
    expect(row?.name).toBe("notes draft.txt");
    expect(row?.size).toBe(bytes.byteLength);
    expect(row?.r2Key).not.toBeNull();

    // The family R2 key (the API module's layout, shared purge prefix) with
    // the sanitized name segment.
    expect(row?.r2Key).toMatch(new RegExp(`^repos/${s.repo.storageKey}/attachments/${row?.id}/notes_draft\\.txt$`));
    const stored = await env.REPO_PACKS.get(row?.r2Key ?? "");
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  });

  it("the 200 response is the dropzone contract byte-shape: exactly {uuid} with the fragments-family headers", async () => {
    const s = await seed();
    const outcome = await uploadIssueAttachmentFromMultipart(env, s.repo, s.uploaderId, dropzoneRequest("a.png", new Uint8Array([9])));
    if (outcome.kind !== "ok") throw new Error(outcome.kind);
    const response = issueAttachmentUploadResponse(outcome);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    // ctx.JSON(map[string]string{"uuid"}) — the ONLY field the dropzone JS
    // reads (dropzone.ts:23 UploadResponse); no name/size fields.
    expect(await response.text()).toBe(JSON.stringify({ uuid: outcome.uuid }));
  });

  it("empty filename: upstream inserts the blank name verbatim; the R2 key segment degrades to 'attachment'", async () => {
    const s = await seed();
    const outcome = await uploadIssueAttachmentFromMultipart(env, s.repo, s.uploaderId, dropzoneRequest("", new Uint8Array([1])));
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error(outcome.kind);
    const row = await rowByUuid(outcome.uuid);
    expect(row?.name).toBe("");
    expect(row?.r2Key).toContain("/attachment");
  });

  it("non-multipart content type: the FormFile ServerError class → the plain-text 500 (upstream :53-57, kept web-faithful)", async () => {
    const s = await seed();
    const request = new Request("https://test.local/o/r/issues/attachments", {
      method: "POST",
      body: "not multipart",
      headers: { "content-type": "application/octet-stream" },
    });
    const outcome = await uploadIssueAttachmentFromMultipart(env, s.repo, s.uploaderId, request);
    expect(outcome).toMatchObject({ kind: "serverError" });
    const response = issueAttachmentUploadResponse(outcome);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("FormFile");
  });

  it("multipart body without a `file` part: the FormFile ServerError class (fields drained, not stored)", async () => {
    const s = await seed();
    const form = new FormData();
    form.append("content", new Blob(["just text"]), "content.txt");
    const outcome = await uploadIssueAttachmentFromMultipart(env, s.repo, s.uploaderId, new Request("https://test.local/x", { method: "POST", body: form }));
    expect(outcome.kind).toBe("serverError");
    expect(issueAttachmentUploadResponse(outcome).status).toBe(500);
  });

  it("malformed multipart body (boundary never found): the FormFile ServerError class", async () => {
    const s = await seed();
    const outcome = await uploadIssueAttachmentFromMultipart(
      env,
      s.repo,
      s.uploaderId,
      new Request("https://test.local/x", {
        method: "POST",
        body: "this is not a multipart body at all",
        headers: { "content-type": 'multipart/form-data; boundary="definitely-absent"' },
      }),
    );
    expect(outcome.kind).toBe("serverError");
    expect(issueAttachmentUploadResponse(outcome).status).toBe(500);
  });

  it(`over-cap: the streaming cap (${(MAX_ISSUE_ATTACHMENT_BYTES + 1).toString()} bytes requested through the test seam) → the ServerError fall-through (attachment.go:66-72) and BOTH halves cleaned up`, async () => {
    const s = await seed();
    const outcome = await uploadIssueAttachmentFromMultipart(
      env,
      s.repo,
      s.uploaderId,
      dropzoneRequest("big.bin", new Uint8Array(64)),
      16, // the test seam — a real over-cap without a 512 MiB body
    );
    expect(outcome.kind).toBe("serverError");
    expect(issueAttachmentUploadResponse(outcome).status).toBe(500);

    // The row-first landing's cleanup: no ghost row, no orphaned object.
    const rows = await drizzle(env.DB).select().from(issueAttachments).all();
    expect(rows).toHaveLength(0);
    const listed = await env.REPO_PACKS.list({ prefix: `repos/${s.repo.storageKey}/attachments/` });
    expect(listed.objects).toHaveLength(0);
  });

  it("the file part is found among OTHER parts (Dropzone may precede it) — trailing fields unparsed, the API family's loop shape", async () => {
    const s = await seed();
    const form = new FormData();
    form.append("content", "hello");
    form.append("file", new Blob([new Uint8Array([1, 2])]), "second.bin");
    const outcome = await uploadIssueAttachmentFromMultipart(env, s.repo, s.uploaderId, new Request("https://test.local/x", { method: "POST", body: form }));
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error(outcome.kind);
    const row = await rowByUuid(outcome.uuid);
    expect(row?.name).toBe("second.bin");
    expect(row?.size).toBe(2);
  });
});

// --- the remove arm --------------------------------------------------------------

describe("removeAttachmentByUuid (attachment.go:82-132)", () => {
  it("miss: an unknown uuid answers the exact ErrAttachmentNotExist 400 body (http.Error newline + nosniff)", async () => {
    const s = await seed();
    const outcome = await removeAttachmentByUuid(env, s.repo, s.ownerViewer, "no-such-uuid");
    expect(outcome).toEqual({ kind: "badRequest", message: "attachment does not exist [id: 0, uuid: no-such-uuid]" });
    const response = issueAttachmentRemoveResponse(outcome);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("attachment does not exist [id: 0, uuid: no-such-uuid]\n");
  });

  it("anonymous: the :90-93 bare 403 (dead through the mount — reqSignIn 303s first — kept in the seam)", async () => {
    const s = await seed();
    const row = await seedUnlinkedRow(s.repo, s.uploaderId);
    const outcome = await removeAttachmentByUuid(env, s.repo, s.anonymousViewer, row.uuid);
    expect(outcome).toEqual({ kind: "forbidden" });
    const response = issueAttachmentRemoveResponse(outcome);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden\n");
  });

  it("uploader fast-path: the uploader removes their own UNLINKED upload — row + R2 object gone, 200 {uuid}", async () => {
    const s = await seed();
    const row = await seedUnlinkedRow(s.repo, s.uploaderId);
    const outcome = await removeAttachmentByUuid(env, s.repo, { kind: "user", id: s.uploaderId, username: "iawuploader", isAdmin: false }, row.uuid);
    expect(outcome).toEqual({ kind: "ok", uuid: row.uuid });
    expect(await rowByUuid(row.uuid)).toBeUndefined();
    expect(await env.REPO_PACKS.get(row.r2Key ?? "")).toBeNull();
    const response = issueAttachmentRemoveResponse(outcome);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await response.text()).toBe(JSON.stringify({ uuid: row.uuid }));
  });

  it("unlinked row, non-uploader grants: the :116-121 IsAdmin/IsOwner arm — site admin and repo owner pass, a WRITE collaborator and a stranger 403", async () => {
    const s = await seed();
    await seedWriteCollaborator(s.repo.id, s.collaboratorId);

    const strangerRow = await seedUnlinkedRow(s.repo, s.uploaderId, { uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000s1" });
    expect(await removeAttachmentByUuid(env, s.repo, s.strangerViewer, strangerRow.uuid)).toEqual({ kind: "forbidden" });
    expect(await rowByUuid(strangerRow.uuid)).toBeDefined(); // the 403 leaves the row alone

    const collabRow = await seedUnlinkedRow(s.repo, s.uploaderId, { uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000s2" });
    expect(await removeAttachmentByUuid(env, s.repo, s.collaboratorViewer, collabRow.uuid)).toEqual({ kind: "forbidden" });

    const adminRow = await seedUnlinkedRow(s.repo, s.uploaderId, { uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000s3" });
    expect(await removeAttachmentByUuid(env, s.repo, s.adminViewer, adminRow.uuid)).toMatchObject({ kind: "ok" });

    const ownerRow = await seedUnlinkedRow(s.repo, s.uploaderId, { uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000s4" });
    expect(await removeAttachmentByUuid(env, s.repo, s.ownerViewer, ownerRow.uuid)).toMatchObject({ kind: "ok" });
  });

  it("linked row, non-uploader grants: CanWriteIssuesOrPulls — the SAME write collaborator who 403'd unlinked now passes", async () => {
    const s = await seed();
    await seedWriteCollaborator(s.repo.id, s.collaboratorId);
    const row = await seedUnlinkedRow(s.repo, s.uploaderId, { issueId: s.issueId });
    const outcome = await removeAttachmentByUuid(env, s.repo, s.collaboratorViewer, row.uuid);
    expect(outcome).toMatchObject({ kind: "ok" });
    expect(await rowByUuid(row.uuid)).toBeUndefined();
    expect(await env.REPO_PACKS.get(row.r2Key ?? "")).toBeNull();

    const strangerRow = await seedUnlinkedRow(s.repo, s.uploaderId, { issueId: s.issueId, uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000l2" });
    expect(await removeAttachmentByUuid(env, s.repo, s.strangerViewer, strangerRow.uuid)).toEqual({ kind: "forbidden" });
  });

  it("repo-mismatch: the release half's own repo_id answers the :95-98 400 body verbatim; the matching repo passes through to the grants", async () => {
    const s = await seed();
    await drizzle(env.DB).insert(releaseAssets).values({
      uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000r1",
      repoId: "r_foreign",
      releaseId: 1,
      uploaderId: s.uploaderId,
      name: "rel.zip",
      size: 5,
      r2Key: "release-assets/foreign/rel.zip",
      createdAt: at(60),
    });
    const foreign = await removeAttachmentByUuid(env, s.repo, { kind: "user", id: s.uploaderId, username: "iawuploader", isAdmin: false }, "aaaaaaaa-bbbb-cccc-dddd-0000000000r1");
    expect(foreign).toEqual({ kind: "badRequest", message: "attachment does not belong to this repository" });
    expect(await issueAttachmentRemoveResponse(foreign).text()).toBe("attachment does not belong to this repository\n");

    // The release half resolves for THIS repo: the owner passes CanWrite(Releases) and the row deletes.
    await drizzle(env.DB).insert(releaseAssets).values({
      uuid: "aaaaaaaa-bbbb-cccc-dddd-0000000000r2",
      repoId: s.repo.id,
      releaseId: 1,
      uploaderId: s.uploaderId,
      name: "rel2.zip",
      size: 5,
      r2Key: "release-assets/ours/rel2.zip",
      createdAt: at(61),
    });
    await env.REPO_PACKS.put("release-assets/ours/rel2.zip", new Uint8Array([4, 5]));
    const ours = await removeAttachmentByUuid(env, s.repo, s.ownerViewer, "aaaaaaaa-bbbb-cccc-dddd-0000000000r2");
    expect(ours).toMatchObject({ kind: "ok" });
    expect(await env.REPO_PACKS.get("release-assets/ours/rel2.zip")).toBeNull();
    const releaseRows = await drizzle(env.DB).select().from(releaseAssets).where(eq(releaseAssets.uuid, "aaaaaaaa-bbbb-cccc-dddd-0000000000r2"));
    expect(releaseRows).toHaveLength(0);
  });

  it("dangling owning issue row: the GetIssueByID ServerError 500 (:102-106)", async () => {
    const s = await seed();
    const row = await seedUnlinkedRow(s.repo, s.uploaderId, { issueId: 424242 }); // no issues row behind it
    const outcome = await removeAttachmentByUuid(env, s.repo, s.ownerViewer, row.uuid);
    expect(outcome.kind).toBe("serverError"); // GetIssueByID's ServerError body rides the detail field
    expect(issueAttachmentRemoveResponse(outcome).status).toBe(500);
  });

  it("the pending relay arm (r2_key NULL): the row-only delete succeeds — nothing stored to remove", async () => {
    const s = await seed();
    const row = await seedUnlinkedRow(s.repo, s.uploaderId, { r2Key: null });
    const outcome = await removeAttachmentByUuid(env, s.repo, { kind: "user", id: s.uploaderId, username: "iawuploader", isAdmin: false }, row.uuid);
    expect(outcome).toMatchObject({ kind: "ok" });
    expect(await rowByUuid(row.uuid)).toBeUndefined();
  });
});

// --- the form-value merge ----------------------------------------------------------

describe("removeAttachmentFormValue (ctx.FormString's body-first merge)", () => {
  it("the urlencoded body wins; the query is the fallback; neither → \"\" (the upstream miss path)", () => {
    const body = new URLSearchParams({ file: "body-uuid" });
    expect(removeAttachmentFormValue(body, new URL("https://test.local/o/r/issues/attachments/remove"))).toBe("body-uuid");
    expect(removeAttachmentFormValue(new URLSearchParams(), new URL("https://test.local/x?file=query-uuid"))).toBe("query-uuid");
    expect(removeAttachmentFormValue(new URLSearchParams(), new URL("https://test.local/x"))).toBe("");
  });
});

// --- the dropzone fragment ---------------------------------------------------------

describe("CommentAttachmentsDropzone (repo/upload.tmpl over upload.go:118-133)", () => {
  it("the attribute set is the dropzone JS contract: upload/remove repo-level URLs, the per-issue link URL with the index", () => {
    const onIssue = renderToString(<CommentAttachmentsDropzone repoLink="/o/r" issueIndex={7} />);
    expect(onIssue).toContain('class="dropzone"');
    expect(onIssue).toContain('data-upload-url="/o/r/issues/attachments"');
    expect(onIssue).toContain('data-remove-url="/o/r/issues/attachments/remove"');
    expect(onIssue).toContain('data-link-url="/o/r/issues/7/attachments"'); // upload.go:120-122's index branch
    expect(onIssue).toContain('data-need-uuid-link="true"');
    expect(onIssue).toContain('data-max-file="5"');
    expect(onIssue).toContain('data-max-size="100"');

    const onNewIssue = renderToString(<CommentAttachmentsDropzone repoLink="/o/r" />);
    expect(onNewIssue).toContain('data-link-url="/o/r/issues/attachments"'); // upload.go:123's bare branch
    expect(onNewIssue).toContain('data-accepts=".avif'); // the frozen AllowedTypes head
    expect(onNewIssue).toContain(`<div class="files"></div>`);
    expect(ISSUE_ATTACHMENT_ACCEPTS.endsWith(".zip")).toBe(true);
  });

  it("the locale attributes carry the dropzone.* strings (Dropzone's own {{filesize}}/{{maxFilesize}} tokens verbatim)", () => {
    const html = renderToString(<CommentAttachmentsDropzone repoLink="/o/r" />);
    expect(html).toContain('data-text-default-message="Drop files or click here to upload."');
    expect(html).toContain('data-text-invalid-input-type="You cannot upload files of this type."');
    expect(html).toContain('data-text-file-too-big="File size ({{filesize}} MB) exceeds the maximum size of ({{maxFilesize}} MB)."');
    expect(html).toContain('data-text-remove-file="Remove file"');
    expect(html).toContain('data-text-copy-link="Copy link"');
  });
});

// --- the upload outcome type sanity (the seams' exhaustiveness) ----------------------

describe("outcome builders", () => {
  it("both builders answer every outcome kind without drifting off the upstream statuses", () => {
    const upload: IssueAttachmentUploadOutcome = { kind: "serverError", detail: "x" };
    expect(issueAttachmentUploadResponse(upload).status).toBe(500);
    const outcomes: IssueAttachmentRemoveOutcome[] = [
      { kind: "ok", uuid: "u" },
      { kind: "badRequest", message: "m" },
      { kind: "forbidden" },
      { kind: "serverError", detail: "d" },
    ];
    expect(outcomes.map((outcome) => issueAttachmentRemoveResponse(outcome).status)).toEqual([200, 400, 403, 500]);
  });
});
