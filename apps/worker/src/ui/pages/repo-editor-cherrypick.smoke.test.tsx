/**
 * The cherry-pick/patch tails' smoke (pages wave 72, PORT-FIRST — ONE happy
 * path per page, the whole test requirement): the cherry-pick page's revert
 * happy path (render → the rendered field set through the landed commit
 * arm → the file gone) and the patch page's create happy path (render →
 * patch commit lands). Real engine content via the receive-flow seed
 * (testing/seed-repo.ts), D1 from the generated migrations; the writes go
 * through the module's own commit arms (no route exists — the HANDOFF
 * NOTE's wiring wave owns the 303 mapping).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { engineClient } from "../engine";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import {
  cherrypickLocale,
  cherryPickFormFromData,
  commitCherryPickFromForm,
  commitPatchFromForm,
  loadEditorCherryPickData,
  loadEditorPatchData,
  parseCherryPickForm,
  patchFormFromData,
  parsePatchForm,
  renderEditorCherryPickPage,
  renderEditorPatchPage,
} from "./repo-editor-cherrypick";

// --- fixtures -----------------------------------------------------------------

const PICK_COMMITS: SeedCommit[] = [
  {
    message: "seed: readme",
    time: 1_700_000_000,
    files: [{ path: "README.md", content: "# pick seed\n" }],
  },
  {
    message: "add feature file",
    time: 1_700_000_100,
    files: [{ path: "feature.txt", content: "feature\n" }],
  },
];

/** The patch page's POST body — the target file name is unique per run
 *  (the rerun-convergence posture: a fresh create every run, the wave-8
 *  pre-clean idea without a second write arm). */
function patchText(name: string): string {
  return [
    `diff --git a/${name} b/${name}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${name}`,
    "@@ -0,0 +1 @@",
    "+hello patch",
    "",
  ].join("\n");
}

/** A create-file patch body for `path` (the rerun heal arm). */
function createFilePatch(path: string, content: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1@`,
    `+${content.replace(/\n$/, "")}`,
    "",
  ].join("\n");
}

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

let fixtures: {
  ctx: UiContext;
  repoRow: typeof repositories.$inferSelect;
  userRow: typeof users.$inferSelect;
  sha2: string;
} | null = null;

async function ensureFixtures(): Promise<NonNullable<typeof fixtures>> {
  if (fixtures !== null) return fixtures;
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "editorcherrypick", commits: PICK_COMMITS });
  const repoRow =
    (await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "editorcherrypick")))
      .get()) ?? null;
  if (repoRow === null) throw new Error("editorcherrypick repo row missing");
  const userRow = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "alice")).get();
  if (userRow === undefined) throw new Error("alice row missing");
  const tip = await engineClient(env, "alice/editorcherrypick").readCommit("main");
  if (tip === null) throw new Error("seed tip missing");
  fixtures = {
    ctx: {
      viewer: { kind: "user", id: userRow.id, username: "alice", isAdmin: false },
      origin: "https://test.local",
      assets: shellAssetsFromManifest(manifest),
      repo: repoRow,
    },
    repoRow,
    userRow,
    sha2: tip.oid,
  };
  return fixtures;
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the cherry-pick page (cherry_pick.tmpl) — happy path -----------------------

describe("the cherry-pick page's revert happy path", () => {
  it("renders the revert confirm over the commit and the rendered field set lands the reverse commit", async () => {
    const { ctx, repoRow, userRow, sha2 } = await ensureFixtures();
    const engine = engineClient(env, "alice/editorcherrypick");

    // GET: the revert selection renders the hidden flag, the sha breadcrumb,
    // and the revert prefill (editor_cherry_pick.go:31-38).
    const data = await loadEditorCherryPickData(engine, repoRow, `${sha2}/main`, "revert");
    if ("notFound" in data) throw new Error("expected cherry-pick data");
    const form = cherryPickFormFromData(data);
    const html = renderEditorCherryPickPage({ ctx, data, form, error: null });

    expect(html).toContain('<div role="main" aria-label="add feature file" class="page-content repository file editor edit">');
    expect(html).toContain(`<form class="ui edit form form-fetch-action" method="post" action="/alice/editorcherrypick/cherrypick/${sha2}/main">`);
    expect(html).toContain('<input type="hidden" name="revert" value="true"/>');
    // The breadcrumb: "Revert {sha link} onto:" + the repo + branch sections
    // + the or-Cancel tail onto the commit URL (cherry_pick.tmpl:12-22).
    expect(html).toContain("Revert ");
    expect(html).toContain(`<a class="ui primary sha label" href="/alice/editorcherrypick/commit/${sha2}">${sha2.slice(0, 7)}</a>`);
    expect(html).toContain(" onto:");
    expect(html).toContain('<a class="section" href="/alice/editorcherrypick/src/branch/main">main</a>');
    expect(html).toContain(`<span>or <a href="/alice/editorcherrypick/commit/${sha2}">Cancel</a></span>`);
    // The commit form: the revert prefill + the branch select + the red cancel.
    expect(html).toContain(`<input name="commit_summary" maxlength="100" placeholder="Update " value="revert ${sha2}"`);
    expect(html).toContain('<option value="main" selected="">main</option>');
    expect(html).toContain('<button id="commit-button" type="submit" class="ui primary button">Commit Changes</button>');
    // The cancel rides the template's $shaurl (cherry_pick.tmpl:20), not the
    // branch link.
    expect(html).toContain(`<a class="ui button red" href="/alice/editorcherrypick/commit/${sha2}">Cancel</a>`);

    // POST: the rendered field set (revert + summary + body + branch) through
    // the landed commit arm — the added file is removed on main. Rerun
    // convergence: a previous run's revert may already have removed the file
    // (DO storage can outlive a run) — heal it through the module's own
    // patch arm first.
    if ((await engine.readBlob("main", "feature.txt")) === null) {
      const heal = await commitPatchFromForm(
        env,
        new Request("https://test.local/alice/editorcherrypick/patch/main", { method: "POST" }),
        repoRow,
        userRow,
        { content: createFilePatch("feature.txt", "feature\n"), summary: "heal feature", body: "", branch: "main" },
      );
      expect(heal.outcome).toBe("committed");
    }
    const params = new URLSearchParams();
    params.set("revert", "true");
    params.set("commit_summary", form.summary);
    params.set("commit_message", form.body);
    params.set("branch", form.branch);
    const values = parseCherryPickForm(params);
    const result = await commitCherryPickFromForm(
      env,
      new Request(`https://test.local/alice/editorcherrypick/cherrypick/${sha2}/main`, { method: "POST" }),
      repoRow,
      userRow,
      sha2,
      values,
    );
    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") throw new Error(result.message);
    expect(result.branch).toBe("main");
    const gone = await engine.readBlob("main", "feature.txt");
    expect(gone).toBeNull();
    // The default-message fallback never fired (the form carried the prefill).
    const landed = await engine.readCommit("main");
    expect(landed?.message.startsWith("revert ")).toBe(true);
  });
});

// --- the patch page (patch.tmpl) — happy path -----------------------------------

describe("the patch page's create happy path", () => {
  it("renders the New Patch editor and the rendered field set lands the patch commit", async () => {
    const { ctx, repoRow, userRow } = await ensureFixtures();
    const engine = engineClient(env, "alice/editorcherrypick");

    // GET: the PageIsPatch editor over the branch.
    const data = await loadEditorPatchData(engine, repoRow, "main");
    if ("notFound" in data) throw new Error("expected patch data");
    const form = patchFormFromData(data);
    const html = renderEditorPatchPage({ ctx, data, form, error: null });

    expect(html).toContain('<div role="main" aria-label="New Patch" class="page-content repository file editor edit">');
    expect(html).toContain('<form class="ui edit form form-fetch-action" method="post" action="/alice/editorcherrypick/patch/main"');
    expect(html).toContain(`data-text-empty-confirm-header="${cherrypickLocale.commit_empty_file_header}"`);
    // hono/jsx escapes the apostrophe inside the attribute value.
    expect(html).toContain(`data-text-empty-confirm-content="${cherrypickLocale.commit_empty_file_text.replaceAll("'", "&#39;")}"`);
    // The breadcrumb: Patching: + the hidden dummy tree_path + #file-name
    // (patch.tmpl:15-27).
    expect(html).toContain("Patching:");
    expect(html).toContain('<input type="hidden" name="tree_path" value="__dummy_for_EditRepoFileForm.TreePath(Required)__"/>');
    expect(html).toContain('<input id="file-name" type="hidden" value="diff.patch"/>');
    // The single tab + the visible monospace textarea (the CodeMirror
    // reduction).
    expect(html).toContain("octicon-code");
    expect(html).toContain("New Patch");
    expect(html).toContain('<textarea id="edit_area" name="content" class="tw-font-mono" rows="20" spellcheck="false" data-id="repo-editorcherrypick-patch">');
    // The commit form: the PageIsPatch placeholder (repo.editor.patch) + the
    // red cancel onto the branch (commit_form.tmpl:85).
    expect(html).toContain('<input name="commit_summary" maxlength="100" placeholder="Apply Patch" value=""');
    expect(html).toContain('<a class="ui button red" href="/alice/editorcherrypick/src/branch/main">Cancel</a>');

    // POST: the rendered field set (content + branch, empty summary → the
    // "Apply Patch" default) through the landed commit arm. The target file
    // name is unique per run, so a rerun always re-creates fresh.
    const patchName = `pick-patch-${Date.now()}.txt`;
    const params = new URLSearchParams();
    params.set("content", patchText(patchName));
    params.set("commit_summary", "");
    params.set("commit_message", "");
    params.set("branch", "main");
    const values = parsePatchForm(params);
    const result = await commitPatchFromForm(
      env,
      new Request("https://test.local/alice/editorcherrypick/patch/main", { method: "POST" }),
      repoRow,
      userRow,
      values,
    );
    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") throw new Error(result.message);
    expect(result.branch).toBe("main");
    const blob = await engine.readBlob("main", patchName);
    expect(blob === null ? null : new TextDecoder().decode(blob.data)).toBe("hello patch\n");
    // The default message fired (editor_apply_patch.go:34; git stores the
    // trailing newline — the API route's message.trim() convention).
    const landed = await engine.readCommit("main");
    expect(landed?.message.trim()).toBe("Apply Patch");
  });
});
