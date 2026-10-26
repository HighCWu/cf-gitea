/**
 * The editor tails module's tests (pages wave 55, the UNMOUNTED bench pair):
 * delete.tmpl's faithful confirm DOM over the LANDED delete arm (the rendered
 * field set POSTs through the real router → 303, the file gone) and
 * upload.tmpl's confirm DOM (bench-only — no write family, the HANDOFF NOTE),
 * plus the loader/parser seams. Real engine content via the receive-flow seed
 * (testing/seed-repo.ts), D1 from the generated migrations; the full-document
 * renders go through the module's renderPage (no route exists, the module
 * header) — the POST round-trip is the one place the router is driven, to
 * prove "writes as form-POSTs where the arms exist".
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { engineClient } from "../engine";
import { uiEnv } from "../__tests__/harness";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import {
  EDITOR_UPLOAD_MAX_FILES,
  EDITOR_UPLOAD_MAX_SIZE_MB,
  editorTailsLocale,
  editorFormFromData,
  loadEditorUploadData,
  loadFileEditorData,
  parseUploadForm,
  renderEditorDeletePage,
  renderEditorUploadPage,
  uploadFilesToDirMessage,
  uploadFormFromData,
} from "./repo-editor-tails";

// --- fixtures -----------------------------------------------------------------

const TAILS_COMMITS: SeedCommit[] = [
  {
    message: "seed: readme + nested editor text",
    time: 1_700_000_000,
    files: [
      { path: "README.md", content: "# tails seed\n" },
      { path: "notes/editor.txt", content: "tails seed: line one\n" },
    ],
  },
];

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const selfViewer: Extract<UiContext["viewer"], { kind: "user" }> = {
  kind: "user",
  id: 1,
  username: "alice",
  isAdmin: false,
};

let fixtures: {
  ctx: UiContext;
  repoRow: typeof repositories.$inferSelect;
  ownerCookie: string;
} | null = null;

async function ensureFixtures(): Promise<NonNullable<typeof fixtures>> {
  if (fixtures !== null) return fixtures;
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "editortails", commits: TAILS_COMMITS });
  const repoRow =
    (await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "editortails")))
      .get()) ?? null;
  if (repoRow === null) throw new Error("editortails repo row missing");
  const owner = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "alice")).get();
  if (owner === undefined) throw new Error("alice row missing");
  const value = {
    ctx: {
      viewer: { ...selfViewer, id: owner.id },
      origin: "https://test.local",
      assets: shellAssetsFromManifest(manifest),
      repo: repoRow,
    },
    repoRow,
    ownerCookie: await mintSession(env.DB, owner.id),
  };
  fixtures = value;
  return value;
}

/** The engine client over the seeded cell (the page loader's seam). */
function tailsEngine() {
  return engineClient(env, "alice/editortails");
}

/** The live blob oid of `path` on main (null = absent). */
async function blobOid(path: string): Promise<string | null> {
  const blob = await env.REPO.getByName("alice/editortails").readBlob("main", path);
  return blob?.oid ?? null;
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the pure helpers -----------------------------------------------------------

describe("the upload message + form seams (pure)", () => {
  it("uploadFilesToDirMessage ports repo.editor.upload_files_to_dir with the IfZero arm", () => {
    expect(uploadFilesToDirMessage("notes")).toBe('Upload files to "notes"'); // locale_en-US.json:1317
    expect(uploadFilesToDirMessage("")).toBe('Upload files to "/"'); // editor.go:467 util.IfZero(TreePath, "/")
  });

  it("the dropzone budget carries the setting defaults", () => {
    expect(EDITOR_UPLOAD_MAX_FILES).toBe(5); // modules/setting/repository.go:178
    expect(EDITOR_UPLOAD_MAX_SIZE_MB).toBe(50); // repository.go:177
  });

  it("parseUploadForm reads the upstream field names with the files[] multi-value", () => {
    const params = new URLSearchParams();
    params.append("tree_path", "notes");
    params.append("files", "uuid-1");
    params.append("files", "uuid-2");
    params.append("commit_summary", "  batch  ");
    params.append("commit_message", "the body");
    params.append("branch", " main ");
    expect(parseUploadForm(params)).toEqual({
      treePath: "notes",
      files: ["uuid-1", "uuid-2"],
      summary: "  batch  ",
      body: "the body",
      branch: "main",
    });
    // Absent fields read empty (UploadRepoFileForm's zero values).
    expect(parseUploadForm(new URLSearchParams())).toEqual({
      treePath: "",
      files: [],
      summary: "",
      body: "",
      branch: "",
    });
  });

  it("uploadFormFromData seeds the GET's initial values (no files, the target branch)", async () => {
    const { repoRow } = await ensureFixtures();
    const data = await loadEditorUploadData(tailsEngine(), repoRow, "main/notes");
    if ("notFound" in data) throw new Error("expected upload data");
    expect(uploadFormFromData(data)).toEqual({
      treePath: "notes",
      files: [],
      summary: "",
      body: "",
      branch: "main",
    });
  });
});

// --- the upload loader -----------------------------------------------------------

describe("loadEditorUploadData (the family loader's new-arm projection)", () => {
  it("resolves the branch and the target dir with its listing", async () => {
    const { repoRow } = await ensureFixtures();
    const root = await loadEditorUploadData(tailsEngine(), repoRow, "main");
    if ("notFound" in root) throw new Error("expected root upload data");
    expect(root.branch).toBe("main");
    expect(root.treePath).toBe("");
    expect(root.siblings.map((entry) => entry.name).sort()).toEqual(["README.md", "notes"]);

    const nested = await loadEditorUploadData(tailsEngine(), repoRow, "main/notes");
    if ("notFound" in nested) throw new Error("expected nested upload data");
    expect(nested.treePath).toBe("notes");
    expect(nested.siblings.map((entry) => entry.name)).toEqual(["editor.txt"]);
  });

  it("404-shells an unresolvable branch (the family's §4.1 arm)", async () => {
    const { repoRow } = await ensureFixtures();
    expect(await loadEditorUploadData(tailsEngine(), repoRow, "ghost")).toEqual({ notFound: true });
  });
});

// --- the DELETE confirm page (delete.tmpl at the pin) -----------------------------

describe("renderEditorDeletePage (delete.tmpl's faithful DOM)", () => {
  it("renders the editor-delete discriminator, the all-links breadcrumb, and the landed arm's form", async () => {
    const { ctx, repoRow } = await ensureFixtures();
    const data = await loadFileEditorData(tailsEngine(), repoRow, "delete", "main/notes/editor.txt", null);
    if ("notFound" in data) throw new Error("expected delete data");
    const html = renderEditorDeletePage({ ctx, data, form: editorFormFromData(data), error: null });

    // The page discriminator the landed one-template page drops (delete.tmpl:2).
    expect(html).toContain('<div role="main" aria-label="notes/editor.txt" class="page-content repository file editor delete">');
    // The form class + the LANDED delete arm as its action (delete.tmpl:9).
    expect(html).toContain('<form class="ui form form-fetch-action" method="post" action="/alice/editortails/delete/main/notes/editor.txt">');
    // EVERY breadcrumb segment is a plain link, file included (delete.tmpl:15-21).
    expect(html).toContain('href="/alice/editortails/src/branch/main"');
    expect(html).toContain('href="/alice/editortails/src/branch/main/notes"');
    expect(html).toContain('href="/alice/editortails/src/branch/main/notes/editor.txt"');
    // No filename input, no content arm (delete.tmpl renders none).
    expect(html).not.toContain('id="file-name"');
    expect(html).not.toContain('id="edit_area"');
    // The commit fields the landed arm reads: summary (PageIsDelete
    // placeholder, commit_form.tmpl:14), body, branch select, tree_path +
    // blob_sha (the CAS), submit + the RED cancel (commit_form.tmpl:85).
    expect(html).toContain('<input name="commit_summary" maxlength="100" placeholder="Delete &#39;notes/editor.txt&#39;"');
    const sha = await blobOid("notes/editor.txt");
    expect(html).toContain('<input type="hidden" name="tree_path" value="notes/editor.txt"/>');
    expect(html).toContain(`<input type="hidden" name="blob_sha" value="${sha}"/>`);
    expect(html).toContain('<select id="editor-tail-target-branch" name="branch" class="ui selection dropdown">');
    expect(html).toContain('<option value="main" selected="">main</option>');
    expect(html).toContain('<button id="commit-button" type="submit" class="ui primary button">Commit Changes</button>');
    expect(html).toContain('<a class="ui button red" href="/alice/editortails/src/branch/main/notes/editor.txt">Cancel</a>');
    // The sidebar chrome renders beside the form (upload.tmpl/delete.tmpl's
    // view_file_tree include — the landed server-side list).
    expect(html).toContain('class="repo-view-file-tree-container"');
    expect(html).toContain("editor.txt");
  });

  it("re-renders a service arm inline through the error message slot", async () => {
    const { ctx, repoRow } = await ensureFixtures();
    const data = await loadFileEditorData(tailsEngine(), repoRow, "delete", "main/notes/editor.txt", null);
    if ("notFound" in data) throw new Error("expected delete data");
    const html = renderEditorDeletePage({
      ctx,
      data,
      form: editorFormFromData(data),
      error: "sha does not match [given: x, expected: y]",
    });
    expect(html).toContain('<div class="ui negative message">sha does not match [given: x, expected: y]</div>');
  });
});

// --- the delete form's POST round-trip (the arm exists → form-POST) ---------------

describe("the delete confirm's field set against the LANDED delete arm", () => {
  /** Pre-clean a create-test target through the landed delete arm (a no-op
   *  when absent — the wave-8 rerun-convergence posture). */
  async function deleteFileIfExists(path: string): Promise<void> {
    await ensureFixtures();
    const sha = await blobOid(path);
    if (sha === null) return;
    await fetchUi(`/alice/editortails/delete/main/${path}`, {
      tree_path: path,
      branch: "main",
      blob_sha: sha,
      commit_summary: "cleanup",
    });
  }

  async function fetchUi(path: string, fields: Record<string, string>): Promise<Response> {
    const { ownerCookie } = fixtures!;
    return await uiRouter.fetch(
      new Request(`https://test.local${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://test.local",
          cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}`,
        },
        body: new URLSearchParams(fields).toString(),
      }),
      uiEnv,
    );
  }

  it("posts exactly the rendered fields and lands the deletion (303, blob gone)", async () => {
    const { ownerCookie } = await ensureFixtures();
    await deleteFileIfExists("tails-gone.txt");
    // Create through the landed new-file arm (the family's other member).
    const created = await fetchUi("/alice/editortails/new/main", {
      tree_path: "tails-gone.txt",
      content: "delete me\n",
      branch: "main",
    });
    expect(created.status).toBe(303);
    const sha = await blobOid("tails-gone.txt");
    expect(sha).not.toBeNull();

    // The DELETE confirm's exact field set (what renderEditorDeletePage
    // emits) through the landed arm.
    const res = await fetchUi("/alice/editortails/delete/main/tails-gone.txt", {
      tree_path: "tails-gone.txt",
      branch: "main",
      blob_sha: sha ?? "",
      commit_summary: "",
      commit_message: "",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/editortails/src/branch/main");
    expect(await blobOid("tails-gone.txt")).toBeNull();

    // Sanity: the owner cookie really was required (an anonymous POST 303s
    // onto the login round-trip — the family's gate, not this module's arm).
    const anon = await uiRouter.fetch(
      new Request("https://test.local/alice/editortails/delete/main/tails-gone.txt", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" },
        body: new URLSearchParams({ tree_path: "tails-gone.txt", branch: "main" }).toString(),
      }),
      uiEnv,
    );
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login?");
    expect(ownerCookie).not.toBe("");
  });
});

// --- the UPLOAD confirm page (upload.tmpl at the pin; bench-only) ------------------

describe("renderEditorUploadPage (upload.tmpl's faithful DOM, documented-unrendered write)", () => {
  it("renders the editor-upload discriminator, the dropzone contract, and the add_subdir breadcrumb at root", async () => {
    const { ctx, repoRow } = await ensureFixtures();
    const data = await loadEditorUploadData(tailsEngine(), repoRow, "main");
    if ("notFound" in data) throw new Error("expected upload data");
    const html = renderEditorUploadPage({ ctx, data, form: uploadFormFromData(data), error: null });

    // The page discriminator (upload.tmpl:2) + the form class (upload.tmpl:9)
    // with the family's bare-literal action — UNCLAIMED (the header).
    expect(html).toContain('<div role="main" aria-label="Upload File" class="page-content repository file editor upload">');
    expect(html).toContain('<form class="ui form form-fetch-action repo-file-upload" method="post" action="/alice/editortails/upload/main">');
    // The dropzone contract (repo/upload.tmpl + AddUploadContextForRepo,
    // upload.go:139-149 — UploadLinkUrl unset upstream, omitted here).
    expect(html).toContain('class="dropzone"');
    expect(html).toContain('data-upload-url="/alice/editortails/upload-file"');
    expect(html).toContain('data-remove-url="/alice/editortails/upload-remove"');
    expect(html).toContain('data-accepts=""');
    expect(html).toContain(`data-max-file="${EDITOR_UPLOAD_MAX_FILES}"`);
    expect(html).toContain(`data-max-size="${EDITOR_UPLOAD_MAX_SIZE_MB}"`);
    expect(html).toContain('data-need-uuid-link="false"');
    expect(html).toContain(`data-text-default-message="${editorTailsLocale.dropzone_default_message}"`);
    expect(html).toContain(`data-text-remove-file="${editorTailsLocale.dropzone_remove_file}"`);
    expect(html).toContain(`data-text-copy-link="${editorTailsLocale.copy_link}"`);
    expect(html).toContain('<div class="files"></div>');
    // The breadcrumb: at root getParentTreeFields yields ONE empty name —
    // the input still renders (value ""), NOT required (the PageIsUpload
    // arm, common_breadcrumb.tmpl:8), with the filename_help tooltip.
    expect(html).toContain('id="file-name" maxlength="255" value="" placeholder="Add a directory…"');
    expect(html).not.toContain('id="file-name" maxlength="255" required');
    // hono/jsx escapes the single quotes inside the attribute value.
    expect(html).toContain(`data-tooltip-content="${editorTailsLocale.filename_help.replaceAll("'", "&#39;")}"`);
    expect(html).toContain("octicon-info");
    // The hidden tree_path + the or-Cancel tail (common_breadcrumb.tmpl:14-15).
    expect(html).toContain('<input type="hidden" id="tree_path" name="tree_path" value=""/>');
    expect(html).toContain("<span>or <a href=\"/alice/editortails/src/branch/main\">Cancel</a></span>");
    // The commit form: the PageIsUpload placeholder + the branch select.
    expect(html).toContain('placeholder="Upload files to &quot;/&quot;"');
    expect(html).toContain('<option value="main" selected="">main</option>');
    // No CAS field on upload (the loader carries no sha), no content arm.
    expect(html).not.toContain('name="blob_sha"');
    expect(html).not.toContain('id="edit_area"');
  });

  it("nests the action, the breadcrumb input value, and the tree_path under the target dir", async () => {
    const { ctx, repoRow } = await ensureFixtures();
    const data = await loadEditorUploadData(tailsEngine(), repoRow, "main/notes");
    if ("notFound" in data) throw new Error("expected upload data");
    const html = renderEditorUploadPage({ ctx, data, form: uploadFormFromData(data), error: null });
    expect(html).toContain('action="/alice/editortails/upload/main/notes"');
    // The visible input carries the dir's own last segment (upstream renders
    // TreeNames' tail into it — the JS merges it into tree_path client-side).
    expect(html).toContain('id="file-name" maxlength="255" value="notes" placeholder="Add a directory…"');
    expect(html).toContain('<input type="hidden" id="tree_path" name="tree_path" value="notes"/>');
    expect(html).toContain('placeholder="Upload files to &quot;notes&quot;"');
    expect(html).toContain('href="/alice/editortails/src/branch/main/notes"');
  });
});
