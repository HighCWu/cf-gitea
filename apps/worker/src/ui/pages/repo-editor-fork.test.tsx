/**
 * The fork-to-edit seam's tests (census gap #13 — pages/repo-editor-fork.tsx,
 * the flow the wave-8 header documented as 404-shell). Real engine content
 * via the receive-flow seed (testing/seed-repo.ts), D1 from the generated
 * migrations; the renders go through the modules' renderPage and the POST
 * round-trip drives BOTH the seam write (createForkToEdit over the real
 * queue/registry bindings — the fork row + its outcomes) and the LANDED
 * fork editor route (the re-post onto the fork: the base-rendered blob sha
 * commits onto the fork's own /edit route, the fork's blob changes, the
 * base's stays):
 *
 *   - the pure seams: editorForkTargetAction (TargetFormAction's shapes —
 *     root/nested/_cherrypick/query passthrough), editorForkReturnTarget
 *     (the no-JS reload validation — in-repo verbatim, cross-repo and
 *     protocol-relative refused), parseEditorForkForm, and
 *     uniqueEditorForkName's EXACT quirky sequence (upstream's
 *     double-increment loop tries name, name-1, name-3 — name-2 never);
 *   - the prompt render (fork.tmpl's DOM at the pin);
 *   - the create round trip on real cells (created → the 'creating' row
 *     with the fork edge; the second call → the GetUserFork existing arm);
 *   - the WillSubmitToFork arm on a SETTLED fork: the overlay (the fork's
 *     branches in the commit select), the banner, the re-post onto the
 *     fork's editor route;
 *   - the already-writer arm unchanged (no overlay → the base action, no
 *     banner) and the anonymous arm unchanged (the editor GET still 303s
 *     onto the login round-trip — the fold does not move that arm).
 *
 * Rerun posture (the wave-26 fork tests'): the create test runs against the
 * plugin's rolled-back storage, so the first call answers `created`; the
 * same-file follow-up pins the `existing` arm; the unique-name probe row is
 * a fixed-id bare row deleted before and after.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { findForkByOwner } from "../../api/services/forks";
import { repositories, users } from "../../db/schema";
import { uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { engineClient } from "../engine";
import { uiEnv } from "../__tests__/harness";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { canWriteRepo, editorFormFromData, loadFileEditorData, renderFileEditorPage } from "./file-editor";
import {
  loadEditorUploadData,
  renderEditorDeletePage,
  renderEditorUploadPage,
  uploadFormFromData,
} from "./repo-editor-tails";
import {
  createForkToEdit,
  editorForkLocale,
  editorForkReturnTarget,
  editorForkTargetAction,
  loadEditorForkOverlay,
  parseEditorForkForm,
  renderEditorForkPrompt,
  resolveEditorForkBranch,
  uniqueEditorForkName,
} from "./repo-editor-fork";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";

// --- fixtures -----------------------------------------------------------------

/** The SAME commits seed both cells (deterministic builder → identical
 *  oids), so the fork-targeting page's BASE-rendered blob sha is the CAS
 *  the fork's own editor POST accepts (a fresh fork's tip = base tip). */
const EDORK_COMMITS: SeedCommit[] = [
  {
    message: "seed: readme + nested editor text",
    time: 1_700_000_000,
    files: [
      { path: "README.md", content: "# edork seed\n" },
      { path: "notes/editor.txt", content: "edork seed: line one\n" },
    ],
  },
];

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type UserViewer = Extract<UiContext["viewer"], { kind: "user" }>;

interface EdorkFixtures {
  baseRow: typeof repositories.$inferSelect;
  /** edforksam's SETTLED fork (same content, fork edge stamped, public). */
  forkRow: typeof repositories.$inferSelect;
  samViewer: UserViewer;
  samCookie: string;
  /** edforkpat — holds no fork (the create round trip's doer). */
  patViewer: UserViewer;
  patCookie: string;
  samCtx: UiContext;
}

let fixtures: EdorkFixtures | null = null;

async function ensureEdorkFixtures(): Promise<EdorkFixtures> {
  if (fixtures !== null) return fixtures;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();
  // The base + the settled fork: the SAME history pushed into both cells
  // (identical oids), the fork edge + visibility stamped (the compare-
  // matrix fixture pattern).
  await ensureSeededRepo({ owner: "alice", slug: "edork", commits: EDORK_COMMITS });
  await ensureSeededRepo({ owner: "edforksam", slug: "edork", commits: EDORK_COMMITS });

  // The fork-less doer (the create round trip) — the matrix tests'
  // extra-identity insert.
  const patExisting = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "edforkpat")).get();
  if (patExisting === undefined) {
    await db.insert(users).values({
      username: "edforkpat",
      usernameLower: "edforkpat",
      isAdmin: false,
      status: "active",
      visibility: "public",
      createdAt: new Date(),
    });
  }

  const baseRow = (await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "edork")))
    .get())!;
  let forkRow = (await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "edforksam"), eq(repositories.slug, "edork")))
    .get())!;
  if (forkRow.forkParent !== baseRow.id) {
    await db.update(repositories).set({ forkParent: baseRow.id }).where(eq(repositories.id, forkRow.id));
    forkRow = (await db.select().from(repositories).where(eq(repositories.id, forkRow.id)).get())!;
  }
  const sam = await db.select().from(users).where(eq(users.usernameLower, "edforksam")).get();
  const pat = await db.select().from(users).where(eq(users.usernameLower, "edforkpat")).get();
  if (sam === undefined || pat === undefined) throw new Error("fork doer rows missing");

  const samViewer: UserViewer = { kind: "user", id: sam.id, username: "edforksam", isAdmin: false };
  const patViewer: UserViewer = { kind: "user", id: pat.id, username: "edforkpat", isAdmin: false };
  const samCtx: UiContext = {
    viewer: samViewer,
    origin: "https://test.local",
    assets: shellAssetsFromManifest(manifest),
    repo: baseRow,
  };
  fixtures = {
    baseRow,
    forkRow,
    samViewer,
    samCookie: await mintSession(env.DB, sam.id),
    patViewer,
    patCookie: await mintSession(env.DB, pat.id),
    samCtx,
  };
  return fixtures;
}

/** The live blob oid of `path` in the given cell (null = absent). */
async function blobOid(engineRepo: string, path: string): Promise<string | null> {
  const blob = await env.REPO.getByName(engineRepo).readBlob("main", path);
  return blob?.oid ?? null;
}

beforeAll(async () => {
  await ensureEdorkFixtures();
});

// --- the pure seams -------------------------------------------------------------

describe("editorForkTargetAction (TargetFormAction's port, services/context/repo.go:251-258)", () => {
  it("targets the fork's DEFAULT branch with from_base_branch carrying the base branch", () => {
    expect(
      editorForkTargetAction({
        forkLink: "/edforksam/edork",
        editorLiteral: "edit",
        forkDefaultBranch: "main",
        treePath: "notes/editor.txt",
        baseBranch: "main",
        query: "",
      }),
    ).toBe("/edforksam/edork/edit/main/notes/editor.txt?from_base_branch=main");
  });

  it("an empty treePath emits no trailing slash (the §4.13 canonical-URL rule — upstream's tail keeps a `main/` slash; we never emit one)", () => {
    expect(
      editorForkTargetAction({
        forkLink: "/edforksam/edork",
        editorLiteral: "new",
        forkDefaultBranch: "main",
        treePath: "",
        baseBranch: "feature/x",
        query: "",
      }),
    ).toBe("/edforksam/edork/new/main?from_base_branch=feature%2Fx");
  });

  it("_cherrypick carries the sha between the literal and the branch (web.go:1469; upstream passes the underscore literal verbatim — repo.go:258-259)", () => {
    expect(
      editorForkTargetAction({
        forkLink: "/edforksam/edork",
        editorLiteral: "_cherrypick",
        sha: "abc1234",
        forkDefaultBranch: "main",
        treePath: "",
        baseBranch: "main",
        query: "",
      }),
    ).toBe("/edforksam/edork/_cherrypick/abc1234/main?from_base_branch=main");
  });

  it("appends the current page's query after from_base_branch (upstream's RawQuery passthrough)", () => {
    expect(
      editorForkTargetAction({
        forkLink: "/edforksam/edork",
        editorLiteral: "upload",
        forkDefaultBranch: "main",
        treePath: "notes",
        baseBranch: "main",
        query: "filename=x.txt",
      }),
    ).toBe("/edforksam/edork/upload/main/notes?from_base_branch=main&filename=x.txt");
  });
});

describe("editorForkReturnTarget (the no-JS reload reduction)", () => {
  const repoLink = "/alice/edork";

  it("carries a same-repo site-relative return_uri verbatim (the reload)", () => {
    expect(editorForkReturnTarget("/alice/edork/edit/main/notes/editor.txt", repoLink, "main")).toBe(
      "/alice/edork/edit/main/notes/editor.txt",
    );
    expect(editorForkReturnTarget("/alice/edork/edit/main?filename=x", repoLink, "main")).toBe(
      "/alice/edork/edit/main?filename=x",
    );
  });

  it("refuses cross-repo and protocol-relative values onto the editor root fallback", () => {
    expect(editorForkReturnTarget("/other/repo/edit/main", repoLink, "main")).toBe("/alice/edork/edit/main");
    // The prefix check is slash-anchored: a sibling repo sharing the slug prefix refuses.
    expect(editorForkReturnTarget("/alice/edork-edit/main", repoLink, "main")).toBe("/alice/edork/edit/main");
    expect(editorForkReturnTarget("//evil.example/x", repoLink, "main")).toBe("/alice/edork/edit/main");
    expect(editorForkReturnTarget("https://evil.example/x", repoLink, "main")).toBe("/alice/edork/edit/main");
    expect(editorForkReturnTarget("", repoLink, "main")).toBe("/alice/edork/edit/main");
  });
});

describe("the form parse + the unique-name port", () => {
  it("parseEditorForkForm reads return_uri and nothing else", () => {
    const params = new URLSearchParams({ return_uri: "/alice/edork/edit/main" });
    expect(parseEditorForkForm(params)).toEqual({ returnUri: "/alice/edork/edit/main" });
    expect(parseEditorForkForm(new URLSearchParams())).toEqual({ returnUri: "" });
  });

  it("uniqueEditorForkName ports the quirky sequence exactly: name, name-1, name-3 — name-2 never tried (editor_util.go:114-131)", async () => {
    await ensureEdorkFixtures();
    // Fresh name: returned as-is.
    expect(await uniqueEditorForkName(env.DB, "alice", "totally-free-name")).toBe("totally-free-name");
    // Taken name: the FIRST postfix candidate is -1.
    expect(await uniqueEditorForkName(env.DB, "alice", "edork")).toBe("edork-1");
    // The double-increment quirk: with BOTH edork and edork-1 present the
    // next TRIED candidate is -3 (-2 is skipped — the loop body's i++ rides
    // the header's i++). A bare fixed-id row stands in for edork-1.
    const db = drizzle(env.DB);
    const fixedId = "r_edork-unique-probe";
    await db.delete(repositories).where(eq(repositories.id, fixedId)).run();
    await db.insert(repositories).values({
      id: fixedId,
      storageKey: fixedId,
      ownerNamespace: "alice",
      ownerId: null,
      slug: "edork-1",
      visibility: "public",
    });
    try {
      expect(await uniqueEditorForkName(env.DB, "alice", "edork")).toBe("edork-3");
    } finally {
      await db.delete(repositories).where(eq(repositories.id, fixedId)).run();
    }
  });
});

// --- the prompt render (fork.tmpl at the pin) ------------------------------------

describe("renderEditorForkPrompt (fork.tmpl's DOM)", () => {
  it("renders the bare repository discriminator, the /_fork action, and the hidden return_uri", async () => {
    const { samCtx } = await ensureEdorkFixtures();
    const html = renderEditorForkPrompt({
      ctx: samCtx,
      branch: "main",
      returnUri: "/alice/edork/edit/main/notes/editor.txt",
      error: null,
    });
    // fork.tmpl:4 — the page-content class is bare `repository` (no
    // `file editor` tail) inside the plain `.ui.container`.
    expect(html).toContain('<div role="main" aria-label="Fork Repository to Propose Changes" class="page-content repository">');
    expect(html).toContain('<form class="ui form form-fetch-action" method="post" action="/alice/edork/_fork/main">');
    // The no-JS reload reduction (module header) — upstream's form carries
    // no fields because the bundle reloads.
    expect(html).toContain('<input type="hidden" name="return_uri" value="/alice/edork/edit/main/notes/editor.txt"/>');
    expect(html).toContain(`<h3>${editorForkLocale.fork_create}</h3>`);
    expect(html).toContain(`<p>${editorForkLocale.fork_create_description}</p>`);
    expect(html).toContain('<button type="submit" class="ui primary button">Fork Repository</button>');
  });

  it("escapes a slash-bearing branch in the action (PathEscapeSegments)", async () => {
    const { samCtx } = await ensureEdorkFixtures();
    const html = renderEditorForkPrompt({ ctx: samCtx, branch: "feature/x", returnUri: "/alice/edork/edit/feature/x", error: null });
    expect(html).toContain('action="/alice/edork/_fork/feature/x"');
  });

  it("renders the error slot for the invalid-arm re-render (base/alert's slot)", async () => {
    const { samCtx } = await ensureEdorkFixtures();
    const html = renderEditorForkPrompt({ ctx: samCtx, branch: "main", returnUri: "/alice/edork/edit/main", error: "user is blocked" });
    expect(html).toContain('<div class="ui negative message">user is blocked</div>');
  });
});

// --- the branch resolution --------------------------------------------------------

describe("resolveEditorForkBranch (the shared RepoRefByType arm)", () => {
  it("resolves the branch on the base cell and 404-shapes an unresolvable tail", async () => {
    const { baseRow } = await ensureEdorkFixtures();
    const engine = engineClient(env, `${baseRow.ownerNamespace}/${baseRow.slug}`);
    expect(await resolveEditorForkBranch(engine, baseRow, "main")).toBe("main");
    expect(await resolveEditorForkBranch(engine, baseRow, "ghost")).toBeNull();
  });
});

// --- the create round trip (real cells, the ForkToEditPost port) -------------------

describe("createForkToEdit (ForkToEditPost over the landed fork service)", () => {
  it("creates the doer's fork — the 'creating' row, the fork edge, the default-branch copy (the async replication posture)", async () => {
    const { baseRow, patViewer } = await ensureEdorkFixtures();
    const result = await createForkToEdit(env, env.DB, baseRow, patViewer);
    expect(result.outcome).toBe("created");
    const fork = await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "edforkpat"), eq(repositories.slug, "edork")))
      .get();
    expect(fork).toBeDefined();
    expect(fork?.forkParent).toBe(baseRow.id);
    expect(fork?.status).toBe("creating"); // createFork's 202 contract (the consumer settles it)
    expect(fork?.defaultBranch).toBe(baseRow.defaultBranch); // upstream's SingleBranch/DefaultBranch copy
  });

  it("a second call answers the one-fork-per-owner probe (GetUserFork, fork.go:75-82)", async () => {
    const { baseRow, patViewer } = await ensureEdorkFixtures();
    const second = await createForkToEdit(env, env.DB, baseRow, patViewer);
    expect(second.outcome).toBe("existing");
    expect(patViewer.username).toBe("edforkpat");
  });
});

// --- the WillSubmitToFork arm on the settled fork ---------------------------------

describe("the fork-targeting editor (the overlay + the re-post onto the fork)", () => {
  it("the reader probe finds the settled fork and the write predicate still refuses the base", async () => {
    const { baseRow, forkRow, samViewer } = await ensureEdorkFixtures();
    expect(await canWriteRepo(env, baseRow, samViewer)).toBe(false); // the reader precondition
    expect(forkRow.forkParent).toBe(baseRow.id);
    expect(await findForkByOwner(env.DB, baseRow.id, samViewer.id)).toEqual({
      id: forkRow.id,
      ownerNamespace: "edforksam",
      slug: "edork",
    });
  });

  it("the overlay targets the fork's editor route and the commit select lists the fork's branches", async () => {
    const { samCtx, baseRow, forkRow } = await ensureEdorkFixtures();
    const baseEngine = engineClient(env, `${baseRow.ownerNamespace}/${baseRow.slug}`);
    const data = await loadFileEditorData(baseEngine, baseRow, "edit", "main/notes/editor.txt", null);
    if ("notFound" in data) throw new Error("expected base edit data");
    const action = editorForkTargetAction({
      forkLink: `/${forkRow.ownerNamespace}/${forkRow.slug}`,
      editorLiteral: "edit",
      forkDefaultBranch: forkRow.defaultBranch,
      treePath: data.treePath,
      baseBranch: data.branch,
      query: "",
    });
    const forkEngine = engineClient(env, `${forkRow.ownerNamespace}/${forkRow.slug}`);
    const overlay = await loadEditorForkOverlay(forkEngine, forkRow, action);
    if (overlay === null) throw new Error("expected overlay");
    expect(overlay.fullName).toBe("edforksam/edork");
    expect(overlay.branches).toEqual(["main"]);

    const form = { ...editorFormFromData(data), branch: overlay.defaultBranch };
    const html = renderFileEditorPage({ ctx: samCtx, data, form, error: null, fork: overlay });
    // TargetFormAction (the fork's editor route) + the banner (common_top
    // tmpl's WillSubmitToFork blue message, the <b><a>FullName</a></b> link).
    expect(html).toContain(`<form class="ui edit form" method="post" action="${action}">`);
    expect(html).toContain('<div class="ui blue message">');
    expect(html).toContain('<b><a href="/edforksam/edork">edforksam/edork</a></b>');
    expect(html).toContain(editorForkLocale.fork_edit_prefix.trim());
    expect(html).toContain(editorForkLocale.fork_edit_suffix);
    // The commit select lists the FORK's branches (the POST lands there).
    expect(html).toContain('<option value="main" selected="">main</option>');
    // The breadcrumb + sidebar + cancel stay BASE-anchored (upstream's
    // ctx.Repo stays the base under WillSubmitToFork).
    expect(html).toContain('href="/alice/edork/src/branch/main"');
    expect(html).toContain('href="/alice/edork/src/branch/main/notes/editor.txt"');
    // The textarea content is the BASE blob's text (upstream reads ctx.Repo).
    expect(html).toContain("edork seed: line one");
  });

  it("the re-post lands the edit on the FORK (its blob changes, the base's stays)", async () => {
    const { samCookie } = await ensureEdorkFixtures();
    const baseSha = await blobOid("alice/edork", "notes/editor.txt");
    expect(baseSha).not.toBeNull();

    // The fork-targeting form's exact submission: the FORK's editor route,
    // the base-rendered blob sha (identical oid — fresh-fork tip equality),
    // the fork's default branch.
    const res = await uiRouter.fetch(
      new Request("https://test.local/edforksam/edork/edit/main/notes/editor.txt", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://test.local",
          cookie: `${SESSION_COOKIE_NAME}=${samCookie}`,
        },
        body: new URLSearchParams({
          tree_path: "notes/editor.txt",
          content: "edited through the fork\n",
          branch: "main",
          blob_sha: baseSha ?? "",
          commit_summary: "via the fork",
        }).toString(),
      }),
      uiEnv,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/edforksam/edork/src/branch/main/notes/editor.txt");

    const forkAfter = await env.REPO.getByName("edforksam/edork").readBlob("main", "notes/editor.txt");
    expect(new TextDecoder().decode(forkAfter?.data ?? new Uint8Array())).toBe("edited through the fork\n");
    // The BASE blob is untouched — the write landed on the fork only.
    expect(await blobOid("alice/edork", "notes/editor.txt")).toBe(baseSha);
  });
});

// --- the unchanged arms ------------------------------------------------------------

describe("the already-writer and anonymous arms (unchanged by the fork flow)", () => {
  it("no overlay: the base action, no banner, no fork shapes (the byte-identity arm)", async () => {
    const { samCtx, baseRow } = await ensureEdorkFixtures();
    const engine = engineClient(env, `${baseRow.ownerNamespace}/${baseRow.slug}`);
    const data = await loadFileEditorData(engine, baseRow, "edit", "main/notes/editor.txt", null);
    if ("notFound" in data) throw new Error("expected edit data");
    const html = renderFileEditorPage({ ctx: samCtx, data, form: editorFormFromData(data), error: null });
    expect(html).toContain('<form class="ui edit form" method="post" action="/alice/edork/edit/main/notes/editor.txt">');
    expect(html).not.toContain('<div class="ui blue message">');
    expect(html).not.toContain("_fork/");
  });

  it("the delete tail accepts the overlay (the fork's action + banner); the upload tail keeps the dropzone BASE-anchored", async () => {
    const { samCtx, baseRow, forkRow } = await ensureEdorkFixtures();
    const baseEngine = engineClient(env, `${baseRow.ownerNamespace}/${baseRow.slug}`);
    const data = await loadFileEditorData(baseEngine, baseRow, "delete", "main/notes/editor.txt", null);
    if ("notFound" in data) throw new Error("expected delete data");
    const action = editorForkTargetAction({
      forkLink: `/${forkRow.ownerNamespace}/${forkRow.slug}`,
      editorLiteral: "delete",
      forkDefaultBranch: forkRow.defaultBranch,
      treePath: data.treePath,
      baseBranch: data.branch,
      query: "",
    });
    const forkEngine = engineClient(env, `${forkRow.ownerNamespace}/${forkRow.slug}`);
    const overlay = await loadEditorForkOverlay(forkEngine, forkRow, action);
    if (overlay === null) throw new Error("expected overlay");
    const html = renderEditorDeletePage({
      ctx: samCtx,
      data,
      form: { ...editorFormFromData(data), branch: overlay.defaultBranch },
      error: null,
      fork: overlay,
    });
    expect(html).toContain(`<form class="ui form form-fetch-action" method="post" action="${action}">`);
    expect(html).toContain('<div class="ui blue message">');

    const uploadData = await loadEditorUploadData(baseEngine, baseRow, "main/notes");
    if ("notFound" in uploadData) throw new Error("expected upload data");
    const uploadAction = editorForkTargetAction({
      forkLink: `/${forkRow.ownerNamespace}/${forkRow.slug}`,
      editorLiteral: "upload",
      forkDefaultBranch: forkRow.defaultBranch,
      treePath: uploadData.treePath,
      baseBranch: uploadData.branch,
      query: "",
    });
    const uploadHtml = renderEditorUploadPage({
      ctx: samCtx,
      data: uploadData,
      form: { ...uploadFormFromData(uploadData), branch: overlay.defaultBranch },
      error: null,
      fork: { ...overlay, action: uploadAction },
    });
    expect(uploadHtml).toContain(`<form class="ui form form-fetch-action repo-file-upload" method="post" action="${uploadAction}">`);
    // The dropzone stays base-anchored — upstream's {{.RepoLink}} arm
    // (repo/upload.tmpl; ctx.Repo stays base under WillSubmitToFork).
    expect(uploadHtml).toContain('data-upload-url="/alice/edork/upload-file"');
    expect(uploadHtml).toContain('<div class="ui blue message">');
  });

  it("the anonymous editor GET still 303s onto the login round-trip (the gate arm the fold does not move)", async () => {
    await ensureEdorkFixtures();
    const res = await uiRouter.fetch(
      new Request("https://test.local/alice/edork/edit/main/notes/editor.txt", { headers: { origin: "https://test.local" } }),
      uiEnv,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fedork%2Fedit%2Fmain%2Fnotes%2Feditor.txt");
  });
});
