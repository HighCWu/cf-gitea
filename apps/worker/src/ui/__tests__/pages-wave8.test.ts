/**
 * Pages wave 8 route tests (SPEC-0008 U3 extension): the web file editor —
 * the new/edit/delete forms (`/{owner}/{repo}/{new|edit|delete}/{branch}…`,
 * pages/file-editor.tsx) committing through the landed contents write
 * service (`applyFileChanges`), plus the file view's write chrome and the
 * push-webhook ride.
 *
 * Same harness posture as pages-wave2..7: the router is driven directly with
 * the synthetic ASSETS manifest, the engine content seeds through the REAL
 * receive flow (testing/seed-repo.ts), and the session wave's conventions
 * provide the identities (mintSession cookies — the wave-4 pattern).
 *
 * Auth/CSRF order under test (the wave-4 shape): every POST runs the §2.8
 * layer-2 Origin guard first, repo resolution 404-shells invisible repos
 * before the auth redirect could leak them, anonymous viewers 303 onto the
 * login round-trip, and the write predicate (canWriteRepo) 404-shells
 * non-writers and archived repos.
 *
 * Rerun posture: the POST-mutated fixtures converge — the create/delete
 * tests pre-clean their target through the editor's own delete POST (and
 * tolerate an already-absent file), the edit test re-reads the live blob sha
 * every run, and the webhook assertions match "some delivery row" rather
 * than exact counts (rows accumulate on persisted-storage runs).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { parseUiRoute, handlesUiRoute } from "../index";
import { repositories, users, webhookDeliveries, webhooks } from "../../db/schema";
import { uiRouter } from "../index";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

/** A form POST with the browser's Origin header (the §2.8 layer-2 guard's
 *  happy path — same-origin as the router fixture origin). */
function formPost(fields: Record<string, string | string[] | null>): RequestInit {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) continue; // absent field (the content-missing arm)
    for (const entry of Array.isArray(value) ? value : [value]) params.append(key, entry);
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

const WAVE8_TEXT = "editor seed: line one\nline two\n";
const WAVE8_EDITED = "editor seed: line one\nline two edited\n";

const WAVE8_COMMITS: SeedCommit[] = [
  {
    message: "seed: readme, editor text, binary",
    time: T0,
    files: [
      { path: "README.md", content: "# wave8 seed\n" },
      { path: "notes/editor.txt", content: WAVE8_TEXT },
      { path: "logo.bin", content: new Uint8Array([0x00, 0x01, 0x02, 0x00, 0xff]) },
    ],
  },
];

interface Wave8Fixture {
  ownerCookie: string;
  adminCookie: string;
  otherCookie: string;
}

let wave8Fixture: Wave8Fixture | null = null;

async function ensureWave8Fixtures(): Promise<Wave8Fixture> {
  if (wave8Fixture !== null) return wave8Fixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "wave8", commits: WAVE8_COMMITS });

  for (const extra of [
    { username: "wave8admin", isAdmin: true },
    { username: "wave8bob", isAdmin: false },
  ]) {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra.username)).get();
    if (existing === undefined) {
      await db.insert(users).values({
        username: extra.username,
        usernameLower: extra.username,
        isAdmin: extra.isAdmin,
        status: "active",
        visibility: "public",
        createdAt: new Date(),
      });
    }
  }
  const owner = await db.select().from(users).where(eq(users.usernameLower, "alice")).get();
  const admin = await db.select().from(users).where(eq(users.usernameLower, "wave8admin")).get();
  const bob = await db.select().from(users).where(eq(users.usernameLower, "wave8bob")).get();
  if (owner === undefined || admin === undefined || bob === undefined) throw new Error("wave8 identity rows missing");

  // A row-only PUBLIC EMPTY sibling (no engine content): the editor's
  // no-branch 404 and the archived refusal.
  const empty = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave8-empty")))
    .get();
  if (empty === undefined) {
    await db.insert(repositories).values({
      id: "r_wave8-empty",
      storageKey: "r_wave8-empty",
      ownerNamespace: "alice",
      ownerId: owner.id,
      slug: "wave8-empty",
      visibility: "public",
    });
  }

  wave8Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    adminCookie: await mintSession(env.DB, admin.id),
    otherCookie: await mintSession(env.DB, bob.id),
  };
  return wave8Fixture;
}

/** The main branch tip of the seeded repo (fresh every call). */
async function mainTip(): Promise<string> {
  const refs = await env.REPO.getByName("alice/wave8").listRefs();
  const hit = refs?.refs.find((ref) => ref.name === "refs/heads/main");
  if (hit === undefined) throw new Error("wave8 main branch missing");
  return hit.target;
}

/** The live blob oid of `path` (null = absent). */
async function blobOid(path: string): Promise<string | null> {
  const blob = await env.REPO.getByName("alice/wave8").readBlob("main", path);
  return blob?.oid ?? null;
}

async function blobText(path: string): Promise<string> {
  const blob = await env.REPO.getByName("alice/wave8").readBlob("main", path);
  if (blob === null) throw new Error(`wave8 blob missing: ${path}`);
  return new TextDecoder().decode(blob.data);
}

/** Pre-clean a create-test target through the editor's own delete POST —
 *  a no-op when the file is absent (the rerun-convergence posture). */
async function deleteFileIfExists(cookie: string, path: string): Promise<void> {
  const sha = await blobOid(path);
  if (sha === null) return;
  const res = await fetchUi(
    `/alice/wave8/delete/main/${path}`,
    withCookie(formPost({ tree_path: path, branch: "main", blob_sha: sha, commit_summary: "cleanup" }), cookie),
  );
  expect([303, 200]).toContain(res.status); // 200 = the CAS re-render; retry once below
  if (res.status === 200) {
    const fresh = await blobOid(path);
    if (fresh === null) return;
    await fetchUi(
      `/alice/wave8/delete/main/${path}`,
      withCookie(formPost({ tree_path: path, branch: "main", blob_sha: fresh }), cookie),
    );
  }
}

/** The send-everything repo hook the webhook-ride test reads (idempotent by
 *  URL — the row accumulates deliveries across persisted runs). */
async function ensureHook(repoId: string): Promise<number> {
  const existing = await drizzle(env.DB)
    .select({ id: webhooks.id })
    .from(webhooks)
    .where(and(eq(webhooks.repoId, repoId), eq(webhooks.url, "https://hooks.example.com/wave8")))
    .get();
  if (existing !== undefined) return existing.id;
  const inserted = await drizzle(env.DB)
    .insert(webhooks)
    .values({
      repoId,
      url: "https://hooks.example.com/wave8",
      events: JSON.stringify({ send_everything: true }),
      isActive: true,
    })
    .returning({ id: webhooks.id })
    .all();
  return inserted[0]!.id;
}

/** The seeded repo's D1 id (resolved like the wave-4 fixtures — never
 *  assumed). */
async function wave8RepoId(): Promise<string> {
  const row = await drizzle(env.DB)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave8")))
    .get();
  if (row === undefined) throw new Error("wave8 repo row missing");
  return row.id;
}

beforeAll(async () => {
  await ensureWave8Fixtures();
});

// --- the parsers (the single owner of the route shapes) -------------------------

describe("wave-8 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the editor literals with their branch+path tails", () => {
    expect(parseUiRoute("/octo/hello/new/main")).toEqual({
      family: "file-new",
      owner: "octo",
      repo: "hello",
      refSuffix: "main",
    });
    expect(parseUiRoute("/octo/hello/edit/feature/a/b.txt")).toEqual({
      family: "file-edit",
      owner: "octo",
      repo: "hello",
      refSuffix: "feature/a/b.txt",
    });
    expect(parseUiRoute("/octo/hello/delete/main/docs/guide.md")).toEqual({
      family: "file-delete",
      owner: "octo",
      repo: "hello",
      refSuffix: "main/docs/guide.md",
    });
    expect(handlesUiRoute("/octo/hello/edit/main/x.txt")).toBe(true);
  });

  it("leaves the bare literals and the neighboring spaces alone", () => {
    expect(parseUiRoute("/octo/hello/new")).toBeNull(); // upstream chi needs the /* tail
    expect(parseUiRoute("/octo/hello/edit")).toBeNull();
    expect(parseUiRoute("/octo/hello/delete")).toBeNull();
    expect(parseUiRoute("/octo/hello/issues/new")).toEqual({
      family: "issue-new",
      owner: "octo",
      repo: "hello",
    });
    expect(parseUiRoute("/octo/hello/milestones/1/edit")).toBeNull(); // the wave-6 table row, unchanged
    expect(handlesUiRoute("/octo/hello.git/git-receive-pack")).toBe(false); // protocol paths stay engine-owned
  });
});

// --- the new-file page (GET) ------------------------------------------------------

describe("new file page GET (/new/{branch})", () => {
  it("renders the editor form for the signed-in writer: name input, textarea, branch select, commit fields", async () => {
    const fixture = await ensureWave8Fixtures();
    const res = await fetchUi("/alice/wave8/new/main", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="New File" class="page-content repository file editor edit">');
    expect(html).toContain('<form class="ui edit form" method="post" action="/alice/wave8/new/main">');
    expect(html).toContain('<input id="file-name" name="tree_path" maxlength="255" required="" autocomplete="off" placeholder="Name your file…" value=""/>');
    expect(html).toContain('<textarea id="edit_area" name="content" class="tw-font-mono" rows="20"');
    expect(html).toContain('<input name="commit_summary" maxlength="100" placeholder="&#39;&lt;filename&gt;&#39;" value=""');
    expect(html).toContain('<select id="editor-target-branch" name="branch" class="ui selection dropdown">');
    expect(html).toContain('<option value="main" selected="">main</option>');
    expect(html).toContain('<button id="commit-button" type="submit" class="ui primary button">Commit Changes</button>');
    expect(html).toContain('<a class="ui button" href="/alice/wave8/src/branch/main">Cancel</a>');
  });

  it("prefills the name input from ?filename= and the dir prefix from the URL tail", async () => {
    const fixture = await ensureWave8Fixtures();
    const res = await fetchUi("/alice/wave8/new/main/notes?filename=hello.txt", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('value="notes/hello.txt"');
  });

  it("gates: anonymous 303 onto the login round-trip, unrelated viewer 404, site admin 200", async () => {
    const fixture = await ensureWave8Fixtures();
    const anon = await fetchUi("/alice/wave8/new/main");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fwave8%2Fnew%2Fmain");

    const other = await fetchUi("/alice/wave8/new/main", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.otherCookie}` },
    });
    expect(other.status).toBe(404);

    const admin = await fetchUi("/alice/wave8/new/main", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` },
    });
    expect(admin.status).toBe(200);
  });

  it("404-shells an invisible repo, an unresolvable branch, and an empty (branchless) repo", async () => {
    const fixture = await ensureWave8Fixtures();
    const secret = await fetchUi("/alice/wave8-secret/new/main", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(secret.status).toBe(404);

    const noBranch = await fetchUi("/alice/wave8/new/nope", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(noBranch.status).toBe(404);

    const emptyRepo = await fetchUi("/alice/wave8-empty/new/main", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(emptyRepo.status).toBe(404);
  });
});

// --- the new-file write (POST) ------------------------------------------------------

describe("new file POST (/new/{branch})", () => {
  const NOTE = "created from the web editor\n";

  it("403s a cross-origin POST before any repo work and 303s an anonymous POST onto login", async () => {
    await ensureWave8Fixtures();
    const cross = await fetchUi("/alice/wave8/new/main", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ tree_path: "x.txt" }).toString(),
    });
    expect(cross.status).toBe(403);
    expect(await cross.text()).toContain("cross-origin request rejected");

    const anon = await fetchUi("/alice/wave8/new/main", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ tree_path: "x.txt" }).toString(),
    });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fwave8%2Fnew%2Fmain");
  });

  it("creates the file through the landed contents service and 303s onto its view", async () => {
    const fixture = await ensureWave8Fixtures();
    await deleteFileIfExists(fixture.ownerCookie, "wave8-note.txt");
    const before = await mainTip();
    const res = await fetchUi(
      "/alice/wave8/new/main",
      withCookie(
        formPost({ tree_path: "wave8-note.txt", content: NOTE, branch: "main", commit_summary: "", commit_message: "" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave8/src/branch/main/wave8-note.txt");

    // The engine landed the change; the branch moved; the file view renders.
    expect(await blobText("wave8-note.txt")).toBe(NOTE);
    expect(await mainTip()).not.toBe(before);
    const view = await fetchUi("/alice/wave8/src/branch/main/wave8-note.txt");
    expect(view.status).toBe(200);
    expect(await view.text()).toContain("created from the web editor");

    // The default commit message (empty summary → "Add '{path}'; the engine's
    // canonical commit serializer terminates the message with \n). The file
    // view's history link target lists it.
    const log = await env.REPO.getByName("alice/wave8").listLog("main", { path: "wave8-note.txt", ofs: 0, n: 1 });
    expect(log?.commits[0]?.message).toBe("Add 'wave8-note.txt'\n");
  });

  it("carries the summary + body through upstream GetCommitMessage's assembly", async () => {
    const fixture = await ensureWave8Fixtures();
    await deleteFileIfExists(fixture.ownerCookie, "wave8-msg.txt");
    const res = await fetchUi(
      "/alice/wave8/new/main",
      withCookie(
        formPost({
          tree_path: "wave8-msg.txt",
          content: "x\n",
          branch: "main",
          commit_summary: "  summarized  ",
          commit_message: "  the body  ",
        }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    const log = await env.REPO.getByName("alice/wave8").listLog("main", { path: "wave8-msg.txt", ofs: 0, n: 1 });
    expect(log?.commits[0]?.message).toBe("summarized\n\nthe body\n");
  });

  it("re-renders at 200 with the service's arm on an existing path and on an empty name, values preserved", async () => {
    const fixture = await ensureWave8Fixtures();
    const exists = await fetchUi(
      "/alice/wave8/new/main",
      withCookie(
        formPost({ tree_path: "notes/editor.txt", content: "clash", branch: "main" }),
        fixture.ownerCookie,
      ),
    );
    expect(exists.status).toBe(200);
    const existsHtml = await exists.text();
    expect(existsHtml).toContain("content at path already exists [path: notes/editor.txt]");
    expect(existsHtml).toContain('value="notes/editor.txt"'); // the name keeps the submission
    expect(existsHtml).toContain("clash"); // the textarea keeps the submission

    const empty = await fetchUi(
      "/alice/wave8/new/main",
      withCookie(formPost({ tree_path: "", content: "body", branch: "main" }), fixture.ownerCookie),
    );
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("A file name is required.");

    const dots = await fetchUi(
      "/alice/wave8/new/main",
      withCookie(formPost({ tree_path: "a/../b.txt", content: "body", branch: "main" }), fixture.ownerCookie),
    );
    expect(dots.status).toBe(200);
    expect(await dots.text()).toContain("invalid file path");
  });

  it("re-renders with the service's 404 arm for a tampered target branch", async () => {
    const fixture = await ensureWave8Fixtures();
    const res = await fetchUi(
      "/alice/wave8/new/main",
      withCookie(formPost({ tree_path: "wave8-branchless.txt", content: "x", branch: "ghost" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("branch does not exist [name: ghost]");
  });

  it("404-shells a non-writer POST (no write, no file)", async () => {
    const fixture = await ensureWave8Fixtures();
    const res = await fetchUi(
      "/alice/wave8/new/main",
      withCookie(formPost({ tree_path: "wave8-bob.txt", content: "x", branch: "main" }), fixture.otherCookie),
    );
    expect(res.status).toBe(404);
    expect(await blobOid("wave8-bob.txt")).toBeNull();
  });
});

// --- the edit page + write ---------------------------------------------------------

describe("edit file page + POST (/edit/{branch}/{path})", () => {
  it("prefills the textarea with the file's current content and carries the blob sha", async () => {
    const fixture = await ensureWave8Fixtures();
    const res = await fetchUi("/alice/wave8/edit/main/notes/editor.txt", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form class="ui edit form" method="post" action="/alice/wave8/edit/main/notes/editor.txt">');
    expect(html).toContain("<textarea"); // the editor textarea renders
    expect(html).toContain("editor seed: line one");
    const sha = await blobOid("notes/editor.txt");
    expect(html).toContain(`value="${sha}"`); // the hidden CAS field
    expect(html).toContain('<input type="hidden" name="tree_path" value="notes/editor.txt"/>');
    expect(html).not.toContain('id="file-name"'); // the name is fixed on edit (no rename this slice)
  });

  it("refuses a binary file with the upstream message (no textarea, no commit form fields)", async () => {
    const fixture = await ensureWave8Fixtures();
    const res = await fetchUi("/alice/wave8/edit/main/logo.bin", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Files cannot be edited through the web interface.");
    expect(html).not.toContain('id="edit_area"'); // the editor is the refused part;
    // the commit form still renders below the refusal (edit.tmpl renders
    // commit_form regardless of NotEditableReason).
    expect(html).toContain('name="commit_summary"');
  });

  it("updates through the service and 303s onto the file view; the engine carries the new bytes", async () => {
    const fixture = await ensureWave8Fixtures();
    const sha = await blobOid("notes/editor.txt");
    const res = await fetchUi(
      "/alice/wave8/edit/main/notes/editor.txt",
      withCookie(
        formPost({
          tree_path: "notes/editor.txt",
          content: WAVE8_EDITED,
          branch: "main",
          blob_sha: sha,
          commit_summary: "edit from the web",
        }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave8/src/branch/main/notes/editor.txt");
    expect(await blobText("notes/editor.txt")).toBe(WAVE8_EDITED);

    const view = await fetchUi("/alice/wave8/src/branch/main/notes/editor.txt");
    expect(await view.text()).toContain("line two edited");
  });

  it("refuses a stale blob sha with the service's CAS arm and keeps the submission", async () => {
    const fixture = await ensureWave8Fixtures();
    const res = await fetchUi(
      "/alice/wave8/edit/main/notes/editor.txt",
      withCookie(
        formPost({
          tree_path: "notes/editor.txt",
          content: "stale editor draft\n",
          branch: "main",
          blob_sha: "0".repeat(40),
        }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("sha does not match");
    expect(html).toContain("stale editor draft"); // the draft survives the re-render
    // The stored file is untouched.
    expect(await blobText("notes/editor.txt")).toBe(WAVE8_EDITED);
  });
});

// --- the delete page + write ---------------------------------------------------------

describe("delete file page + POST (/delete/{branch}/{path})", () => {
  it("renders the confirmation form with the upstream delete placeholder", async () => {
    const fixture = await ensureWave8Fixtures();
    const res = await fetchUi("/alice/wave8/delete/main/notes/editor.txt", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form class="ui edit form" method="post" action="/alice/wave8/delete/main/notes/editor.txt">');
    expect(html).toContain("<h4>Delete &#39;notes/editor.txt&#39;</h4>");
    expect(html).toContain('<input name="commit_summary" maxlength="100" placeholder="Delete &#39;notes/editor.txt&#39;"');
    expect(html).not.toContain('id="edit_area"'); // no editor on the delete page
  });

  it("deletes through the service and 303s onto the containing tree; the file is gone", async () => {
    const fixture = await ensureWave8Fixtures();
    await deleteFileIfExists(fixture.ownerCookie, "wave8-gone.txt"); // converge persisted runs
    const created = await fetchUi(
      "/alice/wave8/new/main",
      withCookie(formPost({ tree_path: "wave8-gone.txt", content: "bye\n", branch: "main" }), fixture.ownerCookie),
    );
    expect(created.status).toBe(303);
    const sha = await blobOid("wave8-gone.txt");
    expect(sha).not.toBeNull();

    const res = await fetchUi(
      "/alice/wave8/delete/main/wave8-gone.txt",
      withCookie(formPost({ tree_path: "wave8-gone.txt", branch: "main", blob_sha: sha ?? "" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave8/src/branch/main");
    expect(await blobOid("wave8-gone.txt")).toBeNull();

    const tree = await fetchUi("/alice/wave8/src/branch/main");
    expect(tree.status).toBe(200);
    // The name is gone from the listing (the tree's latest-commit box still
    // shows the delete commit's own summary — that is the deletion).
    expect(await tree.text()).not.toContain('href="/alice/wave8/src/branch/main/wave8-gone.txt"');
  });

  it("re-renders with the service's missing-file arm when the path is already gone", async () => {
    const fixture = await ensureWave8Fixtures();
    const res = await fetchUi(
      "/alice/wave8/delete/main/wave8-never.txt",
      withCookie(
        formPost({ tree_path: "wave8-never.txt", branch: "main", blob_sha: "0".repeat(40) }),
        fixture.ownerCookie,
      ),
    );
    // The page loader 404-shells first: the confirm page cannot render for a
    // path that does not resolve (upstream NotFound on the entry miss too).
    expect(res.status).toBe(404);
  });
});

// --- the file view's write chrome -----------------------------------------------------

describe("file view write chrome (wave 8)", () => {
  it("shows the New File link and the Edit/Delete actions to a writer, nothing to anonymous", async () => {
    const fixture = await ensureWave8Fixtures();
    const writer = await fetchUi("/alice/wave8/src/branch/main", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(writer.status).toBe(200);
    const writerHtml = await writer.text();
    expect(writerHtml).toContain('href="/alice/wave8/new/main"');
    const blobView = await fetchUi("/alice/wave8/src/branch/main/notes/editor.txt", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    const blobHtml = await blobView.text();
    expect(blobHtml).toContain('href="/alice/wave8/edit/main/notes/editor.txt"');
    expect(blobHtml).toContain('href="/alice/wave8/delete/main/notes/editor.txt"');

    const anonHtml = await (await fetchUi("/alice/wave8/src/branch/main")).text();
    expect(anonHtml).not.toContain("/new/main");
    const anonBlob = await (await fetchUi("/alice/wave8/src/branch/main/notes/editor.txt")).text();
    expect(anonBlob).not.toContain("/edit/main/notes/editor.txt");
    expect(anonBlob).not.toContain("/delete/main/notes/editor.txt");
  });
});

// --- the push-webhook ride -------------------------------------------------------------

describe("push-webhook ride (the landed push family over the editor's delta)", () => {
  it("a file edit through the editor lands a push delivery naming the branch and the new tip", async () => {
    const fixture = await ensureWave8Fixtures();
    const hookId = await ensureHook(await wave8RepoId());
    const sha = await blobOid("notes/editor.txt");
    const before = await mainTip();
    const edited = `${WAVE8_EDITED}ride ${before.slice(0, 7)}\n`;
    const res = await fetchUi(
      "/alice/wave8/edit/main/notes/editor.txt",
      withCookie(
        formPost({ tree_path: "notes/editor.txt", content: edited, branch: "main", blob_sha: sha ?? "" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    const after = await mainTip();
    expect(after).not.toBe(before);

    // The delivery rows are written INLINE by the fan-out (awaited before the
    // 303) — no draining needed. The payload is the landed push family's
    // PushPayload: the branch ref, before→after oids, and the session viewer
    // as pusher/sender.
    const rows = await drizzle(env.DB).select().from(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId)).all();
    const push = rows
      .filter((row) => row.eventType === "push")
      .map((row) => JSON.parse(row.payloadContent) as {
        ref: string;
        before: string;
        after: string;
        pusher: { login: string } | null;
        commits: Array<{ id: string; message?: string }>;
        total_commits: number;
      })
      .find((payload) => payload.after === after);
    expect(push).toBeDefined();
    expect(push!.ref).toBe("refs/heads/main");
    expect(push!.before).toBe(before);
    expect(push!.pusher?.login).toBe("alice");
    expect(push!.total_commits).toBe(1);
    expect(push!.commits[0]?.message).toBe("Update 'notes/editor.txt'\n");
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-8 a11y smoke", () => {
  it("the editor pages pass the structural rules", async () => {
    const fixture = await ensureWave8Fixtures();
    const authed = { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` } };
    for (const path of [
      "/alice/wave8/new/main",
      "/alice/wave8/edit/main/notes/editor.txt",
      "/alice/wave8/delete/main/notes/editor.txt",
      "/alice/wave8/edit/main/logo.bin", // the refusal render
    ]) {
      const res = await fetchUi(path, authed);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
