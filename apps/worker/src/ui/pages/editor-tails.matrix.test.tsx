/**
 * The editor tails' DEFERRED route-level matrix (window-2e C2b 1d834d6 — the
 * mounted tails: GET+POST /{owner}/{repo}/upload/*, /patch/*, /cherrypick/*
 * and the delete-confirm swap; driven over the mounted uiRouter on the
 * notifications 28b71b9 matrix's minted-session pattern, the collaboration
 * f8c84fc matrix the freshest reference). The MODULE suites own the DOM
 * contracts and the commit arms at bench level (pages/repo-editor-tails
 * .test.tsx, pages/repo-editor-cherrypick.smoke.test.tsx, services/
 * upload-staging.test.ts) — THIS FILE adds only what a mount can break:
 *
 *   - the claim pins: the three new tails parse their tail shapes, the
 *     cherrypick suffix is sha-gated (upstream web.go:1469's
 *     `{sha:([a-f0-9]{7,64})}` + required `/*` tail) and bare/underscored
 *     literals fall through to the engine;
 *   - the gates across all three mounted tails (the shared fileEditorGate):
 *     anonymous 303s carrying each requested path, anonymous same-origin
 *     POSTs 303ing with nothing written, the non-writer 404ing GET+POST
 *     before any write, the archived-repo refusal on both verbs for the
 *     owner (row-only repo — the gate precedes the loaders), and the
 *     cross-origin 403 fronting the POSTs;
 *
 * ## DISCLOSED RED (a REAL bug, escalated to the orchestrator — not greened)
 *
 * The cherrypick/patch POST handlers (ui/index.ts editorCherryPickPage /
 * editorPatchPage) never call `sameOriginGuard`, unlike every other write
 * family in the router ("sameOriginGuard-first POSTs" is the router's own
 * prologue convention; fileEditorSubmit/fileUploadSubmit both front it). The
 * matrix observed the miss END-TO-END: a cross-origin POST carrying only a
 * session cookie executed a cherry-pick REVERT (303 onto src/branch/main,
 * the specimen file deleted). The two cross-origin arms for those handlers
 * state the correct 403 convention and stay RED until the guard lands; the
 * upload POST's cross-origin arm (which HAS the guard) pins the convention
 * green beside them.
 *   - the delete-confirm swap THROUGH the mounted family: GET renders the
 *     dedicated delete.tmpl page (the `file editor delete` discriminator +
 *     the ALL-links breadcrumb) where the one-template render used to, and
 *     the service-refusal POST re-render carries the same dedicated page;
 *   - the upload GET renders (root + nested dropzone contract through the
 *     route) and the POST round-trips through the staging family: a
 *     multi-file commit (staging cleaned, the default message, the doer
 *     identity), the noop redirect back onto the form's branch, and the
 *     invalid re-renders (bad dir, ghost branch) with the carried form and
 *     the staging left intact;
 *   - the cherrypick GET+POST: the forward prefill (Cut's subject/body
 *     split), the `?cherry-pick-type=revert` arm, a fabricated-sha 404, the
 *     forward commit onto a second branch, the revert commit on main, and
 *     the ApiError re-render with the carried form;
 *   - the patch GET+POST: the patch.tmpl contract through the route, the
 *     CRLF→LF conversion (editor_apply_patch.go:40) with the "Apply Patch"
 *     default message, the custom summary/body assembly, the content-absent
 *     degenerate arm, and the unapplicable-patch re-render keeping the
 *     submitted content.
 *
 * Rerun posture (the family's): fixed-name uploads re-apply as create-or-
 * update, patch targets are unique per run, the revert heals a previously
 * reverted main through the landed new-file arm before re-reverting, and
 * every write arm read-backs live engine state.
 */

import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, users } from "../../db/schema";
import { deleteRepoUploadByUUID, newRepoUpload, repoUploadKey } from "../../services/upload-staging";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { engineClient, type EngineClient } from "../engine";
import { buildHistoryPack, buildReceivePackBody, ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { T0, uiEnv } from "../__tests__/harness";

// --- router helpers (the matrix pattern) -----------------------------------------

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

/** A form POST with the browser's same-origin header (the §2.8 guard's happy
 *  path — the router fixture origin); array values post multi-value. */
function formPost(fields: Record<string, string | string[]>): RequestInit {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://test.local",
    },
    body: params.toString(),
  };
}

const withCookie = (init: RequestInit, cookie: string): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

// --- fixtures -----------------------------------------------------------------

const TAILS_COMMITS: SeedCommit[] = [
  {
    message: "seed: readme + nested editor text",
    time: T0,
    files: [
      { path: "README.md", content: "# tails seed\n" },
      { path: "notes/editor.txt", content: "tails seed: line one\n" },
    ],
  },
];

/** Commit 2 is the cherry-pick/revert specimen: a multi-line message pins the
 *  Cut(TrimSpace(message)) prefill split, feature.txt the forward/revert ops.
 *  Seed commits carry FULL trees (seed-repo's writeTree), so commit 2 repeats
 *  README.md verbatim — its diff is feature.txt-added ONLY (a clean
 *  cherry-pick specimen, both directions). */
const PICK_COMMITS: SeedCommit[] = [
  {
    message: "seed: readme",
    time: T0,
    files: [{ path: "README.md", content: "# pick seed\n" }],
  },
  {
    message: "add feature file\n\nA body line for the prefill.",
    time: T0 + 100,
    files: [
      { path: "README.md", content: "# pick seed\n" },
      { path: "feature.txt", content: "feature\n" },
    ],
  },
];

/** A fabricated (but well-shaped) sha — the loader's readCommit answers null
 *  → 404 shell (the §4.1 arm; short prefixes 404 the same way). */
const GHOST_SHA = "0123456789abcdef0123456789abcdef01234567";

interface TailsFixture {
  ownerCookie: string;
  samCookie: string;
  /** The pick repo's tip (commit 2 — the cherry-pick specimen). */
  sha2: string;
}

let fixtures: TailsFixture | null = null;

async function ensureFixtures(): Promise<TailsFixture> {
  if (fixtures !== null) return fixtures;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();

  await ensureSeededRepo({ owner: "alice", slug: "edittails", commits: TAILS_COMMITS });
  const seededPick = await ensureSeededRepo({ owner: "alice", slug: "edittailspick", commits: PICK_COMMITS });

  const owner = await db.select().from(users).where(eq(users.usernameLower, "alice")).get();
  if (owner === undefined) throw new Error("alice row missing");
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "edittailsam")).get()) === undefined) {
    await seedVerifiedUser({ username: "edittailsam" });
  }
  const sam = await db.select().from(users).where(eq(users.usernameLower, "edittailsam")).get();
  if (sam === undefined) throw new Error("edittailsam row missing");

  // `side` at the pick repo's FIRST commit — the forward cherry-pick's target
  // (commit 2's diff applies onto it cleanly). Guarded like the harness seeds.
  const refNames = new Set(
    ((await env.REPO.getByName("alice/edittailspick").listRefs())?.refs ?? []).map((ref) => ref.name),
  );
  if (!refNames.has("refs/heads/side")) {
    await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
      .bind(owner.id, "edittails-matrix-side")
      .run();
    const token = (await mintFor(owner.id, "edittails-matrix-side", "write:repository")).plaintext;
    const { tips, pack } = await buildHistoryPack(PICK_COMMITS);
    const response = await SELF.fetch("https://test.local/alice/edittailspick.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
      body: buildReceivePackBody([{ ref: "refs/heads/side", oid: tips[0] as string }], pack),
    });
    const body = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    if (response.status !== 200 || body.includes("ng ")) {
      throw new Error(`edittailspick side push failed: ${response.status} ${body.slice(0, 400)}`);
    }
  }

  // A row-only PUBLIC ARCHIVED sibling (no engine content): the shared gate
  // 404s BEFORE any loader's engine reads (the file-editor matrix posture).
  const archived = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "edittails-archived")))
    .get();
  if (archived === undefined) {
    await db.insert(repositories).values({
      id: "r_edittails-archived",
      storageKey: "r_edittails-archived",
      ownerNamespace: "alice",
      ownerId: owner.id,
      slug: "edittails-archived",
      visibility: "public",
      isArchived: true,
    });
  }

  fixtures = {
    ownerCookie: await mintSession(env.DB, owner.id),
    samCookie: await mintSession(env.DB, sam.id),
    sha2: seededPick.tips[1] as string,
  };
  return fixtures;
}

// --- engine read-backs (fresh every call — the rerun posture) ---------------------

const tailsEngine = (): EngineClient => engineClient(env, "alice/edittails");
const pickEngine = (): EngineClient => engineClient(env, "alice/edittailspick");

async function blobOid(engine: EngineClient, branch: string, path: string): Promise<string | null> {
  return (await engine.readBlob(branch, path))?.oid ?? null;
}

async function blobText(engine: EngineClient, branch: string, path: string): Promise<string> {
  const blob = await engine.readBlob(branch, path);
  if (blob === null) throw new Error(`blob missing: ${branch}/${path}`);
  return new TextDecoder().decode(blob.data);
}

/** The newest commit touching `path` on `branch` (the write arms' message pin). */
async function lastMessageFor(engine: EngineClient, branch: string, path: string): Promise<string> {
  const log = await engine.listLog(branch, { path, ofs: 0, n: 1 });
  const commit = log?.commits[0];
  if (commit === undefined) throw new Error(`no commit touches ${branch}/${path}`);
  return commit.message;
}

async function branchTip(engine: EngineClient, branch: string): Promise<string> {
  const commit = await engine.readCommit(branch);
  if (commit === null) throw new Error(`branch tip missing: ${branch}`);
  return commit.oid;
}

/** A create-file unified diff for `name` (LF endings — the CRLF arm converts);
 *  every content line is a `+` line under a counted hunk header. */
function createPatch(name: string, lines: string[]): string {
  return [
    `diff --git a/${name} b/${name}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${name}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

/** An update-section diff whose base blob does not exist — the applier's
 *  deterministic refusal arm (diffpatch.ts: "… does not exist in the base
 *  tree", the APPLY_FAILURE_MESSAGE family). */
function unapplicablePatch(marker: string): string {
  return [
    `diff --git a/${marker}.txt b/${marker}.txt`,
    `--- a/${marker}.txt`,
    `+++ b/${marker}.txt`,
    "@@ -1,1 +1,2 @@",
    "-old line",
    "+new line",
    "",
  ].join("\n");
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the claim pins ----------------------------------------------------------------

describe("claim pins (the sha-gated cherrypick suffix, the bare literals)", () => {
  it("the three mounted tails claim their tail shapes", () => {
    expect(parseUiRoute("/octo/hello/upload/main/docs")).toEqual({
      family: "file-upload",
      owner: "octo",
      repo: "hello",
      refSuffix: "main/docs",
    });
    expect(parseUiRoute("/octo/hello/patch/main")).toEqual({
      family: "editor-patch",
      owner: "octo",
      repo: "hello",
      refSuffix: "main",
    });
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    expect(parseUiRoute(`/octo/hello/cherrypick/${sha}/main/x`)).toEqual({
      family: "editor-cherrypick",
      owner: "octo",
      repo: "hello",
      refSuffix: `${sha}/main/x`,
    });
    // The dispatcher's reach (§2.2) covers all three.
    expect(handlesUiRoute("/octo/hello/upload/main")).toBe(true);
    expect(handlesUiRoute("/octo/hello/patch/main")).toBe(true);
    expect(handlesUiRoute("/octo/hello/cherrypick/abcdef0/main")).toBe(true); // the 7-hex minimum
  });

  it("a malformed cherrypick suffix and the bare/underscored literals fall through to the engine", () => {
    // Upstream's `({sha:([a-f0-9]{7,64})})` gate + the required `/*` tail.
    expect(parseUiRoute("/octo/hello/cherrypick/zzzzzz/main")).toBeNull(); // non-hex
    expect(parseUiRoute("/octo/hello/cherrypick/abcdef/main")).toBeNull(); // 6 < 7 hex
    expect(parseUiRoute(`/octo/hello/cherrypick/${GHOST_SHA}`)).toBeNull(); // no branch tail
    // Bare literals fall through (upstream chi requires the `/*` tail too).
    expect(parseUiRoute("/octo/hello/upload")).toBeNull();
    expect(parseUiRoute("/octo/hello/patch")).toBeNull();
    expect(parseUiRoute("/octo/hello/cherrypick")).toBeNull();
    // Upstream's underscored literals stay unclaimed (the family's brief pins
    // the bare names — the file-editor matrix's twin arm).
    expect(parseUiRoute("/octo/hello/_upload/main")).toBeNull();
    expect(parseUiRoute("/octo/hello/_diffpatch/main")).toBeNull();
    expect(parseUiRoute(`/octo/hello/_cherrypick/${GHOST_SHA}/main`)).toBeNull();
  });
});

// --- the gates across the mounted tails ---------------------------------------------

describe("gates across the mounted tails (anon / non-writer / archived)", () => {
  it("anonymous GETs 303 onto the login round-trip carrying each tail's path", async () => {
    const { sha2 } = await ensureFixtures();
    const upload = await fetchUi("/alice/edittails/upload/main");
    expect(upload.status).toBe(303);
    expect(upload.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fedittails%2Fupload%2Fmain");

    const patch = await fetchUi("/alice/edittailspick/patch/main");
    expect(patch.status).toBe(303);
    expect(patch.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fedittailspick%2Fpatch%2Fmain");

    const pick = await fetchUi(`/alice/edittailspick/cherrypick/${sha2}/main`);
    expect(pick.status).toBe(303);
    expect(pick.headers.get("location")).toBe(
      `/login?redirect_to=%2Falice%2Fedittailspick%2Fcherrypick%2F${sha2}%2Fmain`,
    );
  });

  it("anonymous same-origin POSTs 303 onto login and write nothing", async () => {
    const { sha2 } = await ensureFixtures();
    const engine = pickEngine();
    const tipBefore = await branchTip(engine, "main");

    const upload = await fetchUi("/alice/edittails/upload/main", formPost({ tree_path: "x.txt", branch: "main" }));
    expect(upload.status).toBe(303);
    expect(upload.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fedittails%2Fupload%2Fmain");

    const patch = await fetchUi(
      "/alice/edittailspick/patch/main",
      formPost({ content: createPatch("anon-patch.txt", ["anon"]), branch: "main" }),
    );
    expect(patch.status).toBe(303);
    expect(patch.headers.get("location")).toContain("/login?");

    const pick = await fetchUi(
      `/alice/edittailspick/cherrypick/${sha2}/main`,
      formPost({ revert: "false", branch: "main" }),
    );
    expect(pick.status).toBe(303);
    expect(pick.headers.get("location")).toContain("/login?");

    expect(await branchTip(engine, "main")).toBe(tipBefore); // no anonymous write
  });

  it("a non-writer 404s GET and POST on every tail before any write (engine read-back)", async () => {
    const { sha2, samCookie } = await ensureFixtures();
    const sam = { headers: { cookie: `${SESSION_COOKIE_NAME}=${samCookie}` } };
    const engine = pickEngine();

    expect((await fetchUi("/alice/edittails/upload/main", sam)).status).toBe(404);
    expect((await fetchUi("/alice/edittailspick/patch/main", sam)).status).toBe(404);
    expect((await fetchUi(`/alice/edittailspick/cherrypick/${sha2}/main`, sam)).status).toBe(404);

    const post = await fetchUi(
      `/alice/edittailspick/cherrypick/${sha2}/main`,
      withCookie(formPost({ revert: "false", branch: "main" }), samCookie),
    );
    expect(post.status).toBe(404);
    expect(await blobOid(engine, "main", "feature.txt")).not.toBeNull(); // nothing reverted
  });

  it("an archived repo 404s both verbs for the owner (RepoMustNotBeArchived answers NotFound)", async () => {
    const { ownerCookie } = await ensureFixtures();
    const authed = { headers: { cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}` } };

    expect((await fetchUi("/alice/edittails-archived/upload/main", authed)).status).toBe(404);
    expect(
      (await fetchUi("/alice/edittails-archived/upload/main", withCookie(formPost({ branch: "main" }), ownerCookie)))
        .status,
    ).toBe(404);
    expect((await fetchUi("/alice/edittails-archived/patch/main", authed)).status).toBe(404);
    expect((await fetchUi(`/alice/edittails-archived/cherrypick/${GHOST_SHA}/main`, authed)).status).toBe(404);
  });
});

// --- the cross-origin guard fronts the POSTs -----------------------------------------
//
// RED ARMS (disclosed, escalated): the upload POST 403s as every write family
// does, but the cherrypick/patch POST handlers (ui/index.ts editorCherryPickPage
// /editorPatchPage) NEVER call sameOriginGuard — a cross-site POST with an
// ambient session cookie EXECUTES the write (the observed stray revert committed
// and deleted feature.txt). The asserts below state the family's documented
// convention ("sameOriginGuard-first POSTs", index.ts's own prologue comment);
// they stay RED until the handlers gain the guard.

describe("cross-origin POSTs 403 ahead of everything (the guard runs first)", () => {
  it("a cross-origin upload POST 403s even WITH a valid session cookie", async () => {
    const { ownerCookie } = await ensureFixtures();
    const upload = await fetchUi("/alice/edittails/upload/main", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}`,
      },
      body: new URLSearchParams({ tree_path: "evil.txt", branch: "main" }).toString(),
    });
    expect(upload.status).toBe(403);
    expect(upload.headers.get("content-type")).toContain("text/plain");
    expect(await upload.text()).toContain("cross-origin request rejected");
  });

  it("a cross-origin cherrypick POST 403s and writes nothing (RED: the POST handler skips the guard)", async () => {
    const { ownerCookie, sha2 } = await ensureFixtures();
    const engine = pickEngine();
    const tipBefore = await branchTip(engine, "main");
    const pick = await fetchUi(`/alice/edittailspick/cherrypick/${sha2}/main`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}`,
      },
      body: new URLSearchParams({ revert: "true", branch: "main" }).toString(),
    });
    expect(pick.status).toBe(403); // RED today: the unguarded POST 303s and commits the revert
    expect(await branchTip(engine, "main")).toBe(tipBefore);
  });

  it("a cross-origin patch POST 403s and writes nothing (RED: the POST handler skips the guard)", async () => {
    const { ownerCookie } = await ensureFixtures();
    const engine = pickEngine();
    const tipBefore = await branchTip(engine, "main");
    const patch = await fetchUi("/alice/edittailspick/patch/main", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}`,
      },
      body: new URLSearchParams({ content: createPatch("csrf-patch.txt", ["csrf"]), branch: "main" }).toString(),
    });
    expect(patch.status).toBe(403); // RED today: the unguarded POST 303s and commits the patch
    expect(await branchTip(engine, "main")).toBe(tipBefore);
  });
});

// --- the delete-confirm swap through the mounted family -------------------------------

describe("the delete-confirm swap (the dedicated page over the landed family)", () => {
  it("GET renders the delete.tmpl discriminator and the ALL-links breadcrumb, not the one-template page", async () => {
    const { ownerCookie } = await ensureFixtures();
    const res = await fetchUi("/alice/edittails/delete/main/notes/editor.txt", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    // The page discriminator the one-template render drops (delete.tmpl:2).
    expect(html).toContain('<div role="main" aria-label="notes/editor.txt" class="page-content repository file editor delete">');
    expect(html).not.toContain('class="page-content repository file editor edit"');
    // The family's action (delete.tmpl:9).
    expect(html).toContain('<form class="ui form form-fetch-action" method="post" action="/alice/edittails/delete/main/notes/editor.txt">');
    // EVERY breadcrumb segment is a plain link — the file segment included
    // (delete.tmpl:15-21; the one-template page's last segment is active text).
    expect(html).toContain('href="/alice/edittails/src/branch/main"');
    expect(html).toContain('href="/alice/edittails/src/branch/main/notes"');
    expect(html).toContain('href="/alice/edittails/src/branch/main/notes/editor.txt"');
    // The PageIsDelete placeholder + no content/filename affordances.
    expect(html).toContain('<input name="commit_summary" maxlength="100" placeholder="Delete &#39;notes/editor.txt&#39;"');
    expect(html).not.toContain('id="edit_area"');
    expect(html).not.toContain('id="file-name"');
    // The landed arm's CAS fields ride along (tree_path + the live blob sha).
    expect(html).toContain('<input type="hidden" name="tree_path" value="notes/editor.txt"/>');
    expect(html).toContain(`<input type="hidden" name="blob_sha" value="${await blobOid(tailsEngine(), "main", "notes/editor.txt")}"/>`);
    // The red cancel onto the file view (commit_form.tmpl:85).
    expect(html).toContain('<a class="ui button red" href="/alice/edittails/src/branch/main/notes/editor.txt">Cancel</a>');
  });

  it("the service-refusal POST re-render carries the dedicated page with the submitted values", async () => {
    const { ownerCookie } = await ensureFixtures();
    const res = await fetchUi(
      "/alice/edittails/delete/main/notes/editor.txt",
      withCookie(
        formPost({
          tree_path: "notes/editor.txt",
          branch: "ghost",
          blob_sha: (await blobOid(tailsEngine(), "main", "notes/editor.txt")) ?? "",
          commit_summary: "matrix keep",
        }),
        ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("branch does not exist [name: ghost]");
    // The swap covers the re-render arm too (the one-template page would say
    // `file editor edit` here).
    expect(html).toContain('class="page-content repository file editor delete"');
    expect(html).not.toContain('class="page-content repository file editor edit"');
    expect(html).toContain('value="matrix keep"'); // the submission survives
    expect(await blobOid(tailsEngine(), "main", "notes/editor.txt")).not.toBeNull(); // nothing deleted
  });
});

// --- the upload GET renders (the dropzone contract through the route) ------------------

describe("upload GET renders (the dropzone contract through the route)", () => {
  it("the root page renders the upload discriminator, the dropzone, and the empty add_subdir input", async () => {
    const { ownerCookie } = await ensureFixtures();
    const res = await fetchUi("/alice/edittails/upload/main", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('<div role="main" aria-label="Upload File" class="page-content repository file editor upload">');
    expect(html).toContain('<form class="ui form form-fetch-action repo-file-upload" method="post" action="/alice/edittails/upload/main">');
    // The dropzone contract (repo/upload.tmpl + AddUploadContextForRepo).
    expect(html).toContain('class="dropzone"');
    expect(html).toContain('data-upload-url="/alice/edittails/upload-file"');
    expect(html).toContain('data-remove-url="/alice/edittails/upload-remove"');
    expect(html).toContain('data-accepts=""');
    expect(html).toContain('data-max-file="5"');
    expect(html).toContain('data-max-size="50"');
    expect(html).toContain('data-need-uuid-link="false"');
    // At root the add_subdir input renders with the empty value (upstream's
    // getParentTreeFields arm) and the hidden tree_path closes the breadcrumb.
    expect(html).toContain('id="file-name" maxlength="255" value="" placeholder="Add a directory…"');
    expect(html).toContain('<input type="hidden" id="tree_path" name="tree_path" value=""/>');
    expect(html).toContain('placeholder="Upload files to &quot;/&quot;"');
    // No CAS field on upload (the loader carries no sha).
    expect(html).not.toContain('name="blob_sha"');
  });

  it("the nested page carries the dir in the action, the input value, and tree_path", async () => {
    const { ownerCookie } = await ensureFixtures();
    const res = await fetchUi("/alice/edittails/upload/main/notes", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/alice/edittails/upload/main/notes"');
    expect(html).toContain('id="file-name" maxlength="255" value="notes" placeholder="Add a directory…"');
    expect(html).toContain('<input type="hidden" id="tree_path" name="tree_path" value="notes"/>');
    expect(html).toContain('placeholder="Upload files to &quot;notes&quot;"');
    // The viewed dir's listing is the sidebar (the loader's root-listing arm
    // serves the same at every depth).
    expect(html).toContain('class="repo-view-file-tree-container"');
    expect(html).toContain("editor.txt");
  });

  it("an unresolvable branch 404s (the family's §4.1 arm through the route)", async () => {
    const { ownerCookie } = await ensureFixtures();
    const res = await fetchUi("/alice/edittails/upload/ghost", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}` },
    });
    expect(res.status).toBe(404);
  });
});

// --- the upload POST round-trips (the staging family's first route consumer) -----------

describe("upload POST round-trips through the staging family", () => {
  it("a multi-file POST commits the staged uuids under the target dir, cleans staging, 303s onto the branch", async () => {
    const { ownerCookie } = await ensureFixtures();
    const engine = tailsEngine();
    const u1 = await newRepoUpload(env.REPO_PACKS, "batch-a.txt", new TextEncoder().encode("alpha staged\n"));
    const u2 = await newRepoUpload(env.REPO_PACKS, "batch-b.txt", new TextEncoder().encode("beta staged\n"));

    const res = await fetchUi(
      "/alice/edittails/upload/main/notes",
      withCookie(
        formPost({
          tree_path: "notes",
          files: [u1.uuid, u2.uuid],
          commit_summary: "",
          commit_message: "",
          branch: "main",
        }),
        ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/edittails/src/branch/main");

    // Both staged files landed under the target dir, bytes verbatim.
    expect(await blobText(engine, "main", "notes/batch-a.txt")).toBe("alpha staged\n");
    expect(await blobText(engine, "main", "notes/batch-b.txt")).toBe("beta staged\n");
    // The staging cleanup ran (upload.go:108-113) — the uuids are consumed.
    expect(await env.REPO_PACKS.head(repoUploadKey(u1.uuid))).toBeNull();
    expect(await env.REPO_PACKS.head(repoUploadKey(u2.uuid))).toBeNull();
    // The default message (editor.go:467) + the doer identity (the family's
    // author = committer = the session viewer, the noreply fallback).
    const message = await lastMessageFor(engine, "main", "notes/batch-a.txt");
    expect(message.trim()).toBe('Upload files to "notes"');
    const log = await engine.listLog("main", { path: "notes/batch-a.txt", ofs: 0, n: 1 });
    expect(log?.commits[0]?.author).toMatchObject({ name: "alice", email: "alice@noreply.test.local" });
    expect(log?.commits[0]?.committer).toMatchObject({ name: "alice", email: "alice@noreply.test.local" });
  });

  it("a files-less POST is the noop arm — 303 back onto the form's branch (upload.go:78-80's nil)", async () => {
    const { ownerCookie } = await ensureFixtures();
    const res = await fetchUi(
      "/alice/edittails/upload/main",
      withCookie(formPost({ tree_path: "", commit_summary: "", branch: "main" }), ownerCookie), // no files field
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/edittails/upload/main");
  });

  it("an invalid target dir re-renders with the carried form and the staging left intact", async () => {
    const { ownerCookie } = await ensureFixtures();
    const staged = await newRepoUpload(env.REPO_PACKS, "doomed.txt", new TextEncoder().encode("doomed\n"));
    const res = await fetchUi(
      "/alice/edittails/upload/main",
      withCookie(
        formPost({
          tree_path: ".git",
          files: [staged.uuid],
          commit_summary: "matrix carry",
          branch: "main",
        }),
        ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("invalid file path");
    expect(html).toContain('class="page-content repository file editor upload"'); // the upload page re-rendered
    expect(html).toContain('value="matrix carry"'); // the carried form
    // The staged uuid was NOT consumed (the cleanup rides success only).
    expect(await env.REPO_PACKS.head(repoUploadKey(staged.uuid))).not.toBeNull();
    await deleteRepoUploadByUUID(env.REPO_PACKS, staged.uuid); // leave no scratch behind
  });

  it("a ghost target branch re-renders the service arm with the staged uuid unconsumed", async () => {
    const { ownerCookie } = await ensureFixtures();
    const staged = await newRepoUpload(env.REPO_PACKS, "ghosted.txt", new TextEncoder().encode("ghosted\n"));
    const res = await fetchUi(
      "/alice/edittails/upload/main",
      withCookie(
        formPost({
          tree_path: "",
          files: [staged.uuid],
          commit_summary: "",
          branch: "ghost",
        }),
        ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("branch does not exist [name: ghost]");
    expect(html).toContain('class="page-content repository file editor upload"');
    expect(await env.REPO_PACKS.head(repoUploadKey(staged.uuid))).not.toBeNull();
    await deleteRepoUploadByUUID(env.REPO_PACKS, staged.uuid);
  });
});

// --- the cherry-pick GET+POST ------------------------------------------------------

describe("cherry-pick GET (the forward prefill and the ?cherry-pick-type=revert arm)", () => {
  it("the forward page prefills Cut's subject/body split over the commit and targets the URL branch", async () => {
    const { ownerCookie, sha2 } = await ensureFixtures();
    const res = await fetchUi(`/alice/edittailspick/cherrypick/${sha2}/side`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('<div role="main" aria-label="add feature file" class="page-content repository file editor edit">');
    expect(html).toContain(`<form class="ui edit form form-fetch-action" method="post" action="/alice/edittailspick/cherrypick/${sha2}/side">`);
    expect(html).toContain('<input type="hidden" name="revert" value="false"/>');
    // The breadcrumb: "Cherry-pick {short sha} onto:" over the commit link and
    // the URL branch (cherry_pick.tmpl:12-22).
    expect(html).toContain("Cherry-pick ");
    expect(html).toContain(`<a class="ui primary sha label" href="/alice/edittailspick/commit/${sha2}">${sha2.slice(0, 7)}</a>`);
    expect(html).toContain(" onto:");
    expect(html).toContain('<a class="section" href="/alice/edittailspick/src/branch/side">side</a>');
    // The prefill: the subject alone in the summary, the body after the Cut.
    expect(html).toContain('<input name="commit_summary" maxlength="100" placeholder="Update " value="add feature file"');
    expect(html).toContain("A body line for the prefill.");
    // Both existing branches in the select; the URL branch preselected.
    expect(html).toContain('<option value="main">main</option>');
    expect(html).toContain('<option value="side" selected="">side</option>');
  });

  it("?cherry-pick-type=revert flips the hidden flag and the revert prefill (editor_cherry_pick.go:31)", async () => {
    const { ownerCookie, sha2 } = await ensureFixtures();
    const res = await fetchUi(`/alice/edittailspick/cherrypick/${sha2}/main?cherry-pick-type=revert`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<input type="hidden" name="revert" value="true"/>');
    expect(html).toContain("Revert ");
    expect(html).toContain(`value="revert ${sha2}"`);
    expect(html).toContain("revert add feature file"); // the body prefill's head
  });

  it("a well-shaped but unreachable sha 404s (the loader's readCommit arm)", async () => {
    const { ownerCookie } = await ensureFixtures();
    const res = await fetchUi(`/alice/edittailspick/cherrypick/${GHOST_SHA}/main`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("cherry-pick POST (the forward arm, the refusal re-render, the revert arm)", () => {
  it("the forward POST lands the picked change on the target branch (303, message = the prefill)", async () => {
    const { ownerCookie, sha2 } = await ensureFixtures();
    const engine = pickEngine();
    const res = await fetchUi(
      `/alice/edittailspick/cherrypick/${sha2}/side`,
      withCookie(
        formPost({
          revert: "false",
          commit_summary: "add feature file",
          commit_message: "A body line for the prefill.",
          branch: "side",
        }),
        ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/edittailspick/src/branch/side");
    expect(await blobText(engine, "side", "feature.txt")).toBe("feature\n");
    const message = await lastMessageFor(engine, "side", "feature.txt");
    expect(message.trim()).toBe("add feature file\n\nA body line for the prefill.");
  });

  it("a ghost target branch re-renders the ApiError text with the carried form at 200", async () => {
    const { ownerCookie, sha2 } = await ensureFixtures();
    const engine = pickEngine();
    const tipBefore = await branchTip(engine, "main");
    const res = await fetchUi(
      `/alice/edittailspick/cherrypick/${sha2}/main`,
      withCookie(
        formPost({
          revert: "false",
          commit_summary: "matrix pick keep",
          commit_message: "",
          branch: "ghost",
        }),
        ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("branch does not exist [name: ghost]");
    expect(html).toContain('value="matrix pick keep"'); // the carried form
    expect(html).toContain('<input type="hidden" name="revert" value="false"/>'); // the GET-loaded arm
    expect(await branchTip(engine, "main")).toBe(tipBefore); // nothing changed
  });

  it("the revert POST removes the picked file from main (303, the revert header default shape)", async () => {
    const { ownerCookie, sha2 } = await ensureFixtures();
    const engine = pickEngine();
    // Rerun convergence: heal a previously reverted main through the landed
    // new-file arm, so the reverse arm always has its file to remove.
    if ((await engine.readBlob("main", "feature.txt")) === null) {
      const heal = await fetchUi(
        "/alice/edittailspick/new/main",
        withCookie(formPost({ tree_path: "feature.txt", content: "feature\n", branch: "main" }), ownerCookie),
      );
      expect(heal.status).toBe(303);
    }

    const res = await fetchUi(
      `/alice/edittailspick/cherrypick/${sha2}/main`,
      withCookie(
        formPost({
          revert: "true",
          commit_summary: `revert ${sha2}`,
          commit_message: "revert add feature file",
          branch: "main",
        }),
        ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/edittailspick/src/branch/main");
    expect(await blobOid(engine, "main", "feature.txt")).toBeNull();
    const message = await lastMessageFor(engine, "main", "feature.txt");
    expect(message.trim()).toBe(`revert ${sha2}\n\nrevert add feature file`);
  });
});

// --- the patch GET+POST -------------------------------------------------------------

describe("patch GET (patch.tmpl through the route)", () => {
  it("renders the New Patch editor with the dummy binding fields and the plain textarea", async () => {
    const { ownerCookie } = await ensureFixtures();
    const res = await fetchUi("/alice/edittailspick/patch/main", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('<div role="main" aria-label="New Patch" class="page-content repository file editor edit">');
    expect(html).toContain('<form class="ui edit form form-fetch-action" method="post" action="/alice/edittailspick/patch/main"');
    // patch.tmpl:10-12's empty-commit-confirm data attributes (the apostrophe
    // escapes through hono/jsx).
    expect(html).toContain('data-text-empty-confirm-header="Commit an empty file"');
    expect(html).toContain('data-text-empty-confirm-content="The file you&#39;re about to commit is empty. Proceed?"');
    // The breadcrumb's binding satisfiers (patch.tmpl:15-27).
    expect(html).toContain("Patching:");
    expect(html).toContain('<input type="hidden" name="tree_path" value="__dummy_for_EditRepoFileForm.TreePath(Required)__"/>');
    expect(html).toContain('<input id="file-name" type="hidden" value="diff.patch"/>');
    // The single tab + the CodeMirror reduction (a plain visible textarea).
    expect(html).toContain("octicon-code");
    expect(html).toContain('<textarea id="edit_area" name="content" class="tw-font-mono" rows="20" spellcheck="false" data-id="repo-edittailspick-patch">');
    // The PageIsPatch placeholder; no CAS field on either tail.
    expect(html).toContain('<input name="commit_summary" maxlength="100" placeholder="Apply Patch" value=""');
    expect(html).not.toContain('name="blob_sha"');
  });

  it("an unresolvable branch 404s (the family's §4.1 arm through the route)", async () => {
    const { ownerCookie } = await ensureFixtures();
    const res = await fetchUi("/alice/edittailspick/patch/ghost", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("patch POST (CRLF→LF, the default message, the failure arms)", () => {
  it("a CRLF patch applies after the LF conversion and lands the Apply Patch default message", async () => {
    const { ownerCookie } = await ensureFixtures();
    const engine = pickEngine();
    const name = `patch-crlf-${Date.now()}.txt`;
    const res = await fetchUi(
      "/alice/edittailspick/patch/main",
      withCookie(
        formPost({
          content: createPatch(name, ["hello crlf"]).replaceAll("\n", "\r\n"),
          commit_summary: "",
          commit_message: "",
          branch: "main",
        }),
        ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/edittailspick/src/branch/main");
    const text = await blobText(engine, "main", name);
    expect(text).toBe("hello crlf\n"); // LF only — the \r\n pairs never reach the applier
    expect(text.includes("\r")).toBe(false);
    expect((await lastMessageFor(engine, "main", name)).trim()).toBe("Apply Patch");
  });

  it("a custom summary/body assembles upstream's GetCommitMessage shape", async () => {
    const { ownerCookie } = await ensureFixtures();
    const engine = pickEngine();
    const name = `patch-msg-${Date.now()}.txt`;
    const res = await fetchUi(
      "/alice/edittailspick/patch/main",
      withCookie(
        formPost({
          content: createPatch(name, ["hello message", "second line"]),
          commit_summary: "matrix patch subject",
          commit_message: "matrix patch body",
          branch: "main",
        }),
        ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(await blobText(engine, "main", name)).toBe("hello message\nsecond line\n");
    expect((await lastMessageFor(engine, "main", name)).trim()).toBe("matrix patch subject\n\nmatrix patch body");
  });

  it("a content-absent POST answers the degenerate arm (An error occurred.) and writes nothing", async () => {
    const { ownerCookie } = await ensureFixtures();
    const engine = pickEngine();
    const tipBefore = await branchTip(engine, "main");
    const res = await fetchUi(
      "/alice/edittailspick/patch/main",
      withCookie(formPost({ commit_summary: "", branch: "main" }), ownerCookie), // no content field
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("An error occurred."); // editor.go:357's degenerate arm
    expect(await branchTip(engine, "main")).toBe(tipBefore);
  });

  it("an unapplicable patch re-renders the apply-failure text with the submitted content kept", async () => {
    const { ownerCookie } = await ensureFixtures();
    const engine = pickEngine();
    const tipBefore = await branchTip(engine, "main");
    const marker = `patch-refused-${Date.now()}`;
    const res = await fetchUi(
      "/alice/edittailspick/patch/main",
      withCookie(
        formPost({ content: unapplicablePatch(marker), commit_summary: "", commit_message: "", branch: "main" }),
        ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("patch does not apply"); // the APPLY_FAILURE_MESSAGE family
    expect(html).toContain(`${marker}.txt`); // the submitted content survives the re-render
    expect(await branchTip(engine, "main")).toBe(tipBefore); // nothing committed
  });
});
