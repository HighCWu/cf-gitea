/**
 * The file-editor family's DEFERRED route-level matrix (pages/file-editor.tsx —
 * the _edit/_new/_delete web arms, mounted since wave 8; the wave-8 route tests
 * in ui/__tests__/pages-wave8.test.ts own the base arms: the new-file gates,
 * the root create round-trip + its message assembly, the edit prefill and the
 * fabricated-stale-sha re-render, the binary GET refusal, the root delete
 * round-trip, the file-view write chrome, the webhook ride, the a11y smoke.
 * THIS FILE adds the arms wave8 does not carry, driven over the mounted
 * uiRouter on the notifications 28b71b9 matrix's minted-session pattern):
 *
 *   - the gates on the edit/delete arms (wave8 gated only /new): anonymous
 *     303s carrying the requested path, non-writer 404s BEFORE any write
 *     (engine read-back), the site-admin 200s, and the archived-repo refusal
 *     on BOTH verbs for the owner (upstream RepoMustNotBeArchived answers
 *     NotFound; the gate precedes the loader, so a row-only repo suffices);
 *   - the cross-origin 403s on the edit/delete POSTs: sameOriginGuard runs
 *     FIRST — a valid session cookie still 403s, a cookie-less cross-origin
 *     POST 403s rather than 303ing onto login, and nothing is written;
 *   - the create round-trip's deferred pieces: a NESTED tree_path 303s onto
 *     the nested file view with the commit's IDENTITY pinned (author =
 *     committer = the session viewer; a null-email row renders the
 *     `{login}@noreply.{hostname}` fallback), and a content-absent POST reads
 *     as the empty file (the parse's documented new-arm);
 *   - the edit round-trip's sha-CAS semantics (the hidden blob_sha field is
 *     the pinned guard): a commit touching OTHER files does not block the
 *     edit (blob granularity — the documented divergence from upstream's
 *     last_commit guard), an ABSENT blob_sha carries no CAS at all (the
 *     builder's conditional arm), a binary file's edit URL re-renders the
 *     refusal on POST without writing, and the content-absent degenerate arm
 *     answers upstream's "An error occurred." with the blob untouched;
 *   - the delete arm's deferred pieces: a nested delete 303s onto the
 *     containing SUBTREE (not the root), and a tampered target branch
 *     re-renders the service's arm with the submitted summary carried;
 *   - the claim pin: the new-family dir tail parses into the refSuffix walk
 *     and upstream's underscored literals (_edit/_new/_delete) stay
 *     unclaimed (the brief pins the bare names).
 *
 * Rerun posture (wave8's): every POST-mutated path pre-cleans through the
 * editor's own delete POST (tolerating an already-absent file), the edit
 * tests re-read the live blob sha every run, and the unconditional-write
 * tests pin exact contents so reruns converge.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories, users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { T0, uiEnv } from "../__tests__/harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

/** A form POST with the browser's same-origin header (the §2.8 guard's
 *  happy path — the router fixture origin). */
function formPost(fields: Record<string, string | null>): RequestInit {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) continue; // absent field (the content/sha-missing arms)
    params.append(key, value);
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

const FEDITOR_TEXT = "feditor seed: line one\nline two\n";

const FEDITOR_COMMITS: SeedCommit[] = [
  {
    message: "seed: readme, guide, editor text, binary",
    time: T0,
    files: [
      { path: "README.md", content: "# feditor seed\n" },
      { path: "docs/guide.md", content: "# guide\n\nWalkthrough.\n" },
      { path: "notes/editor.txt", content: FEDITOR_TEXT },
      { path: "logo.bin", content: new Uint8Array([0x00, 0x01, 0x02, 0x00, 0xff]) },
    ],
  },
];

interface FeditorFixture {
  ownerCookie: string;
  adminCookie: string;
  otherCookie: string;
}

let feditorFixture: FeditorFixture | null = null;

async function ensureFeditorFixtures(): Promise<FeditorFixture> {
  if (feditorFixture !== null) return feditorFixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "feditor", commits: FEDITOR_COMMITS });

  for (const extra of [
    { username: "feditorroot", isAdmin: true },
    { username: "feditorsam", isAdmin: false },
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
  const admin = await db.select().from(users).where(eq(users.usernameLower, "feditorroot")).get();
  const other = await db.select().from(users).where(eq(users.usernameLower, "feditorsam")).get();
  if (owner === undefined || admin === undefined || other === undefined) throw new Error("feditor identity rows missing");

  // A row-only PUBLIC ARCHIVED sibling (no engine content): the archived
  // refusal 404s at the shared gate, BEFORE the loader's engine reads.
  const archived = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "feditor-archived")))
    .get();
  if (archived === undefined) {
    await db.insert(repositories).values({
      id: "r_feditor-archived",
      storageKey: "r_feditor-archived",
      ownerNamespace: "alice",
      ownerId: owner.id,
      slug: "feditor-archived",
      visibility: "public",
      isArchived: true,
    });
  }

  feditorFixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    adminCookie: await mintSession(env.DB, admin.id),
    otherCookie: await mintSession(env.DB, other.id),
  };
  return feditorFixture;
}

// --- engine read-backs (fresh every call — the rerun posture) -------------------

async function mainTip(): Promise<string> {
  const refs = await env.REPO.getByName("alice/feditor").listRefs();
  const hit = refs?.refs.find((ref) => ref.name === "refs/heads/main");
  if (hit === undefined) throw new Error("feditor main branch missing");
  return hit.target;
}

/** The live blob oid of `path` (null = absent). */
async function blobOid(path: string): Promise<string | null> {
  const blob = await env.REPO.getByName("alice/feditor").readBlob("main", path);
  return blob?.oid ?? null;
}

async function blobText(path: string): Promise<string> {
  const blob = await env.REPO.getByName("alice/feditor").readBlob("main", path);
  if (blob === null) throw new Error(`feditor blob missing: ${path}`);
  return new TextDecoder().decode(blob.data);
}

/** Pre-clean a create-test target through the editor's own delete POST —
 *  a no-op when the file is absent (the wave-8 convergence posture). */
async function deleteFileIfExists(cookie: string, path: string): Promise<void> {
  const sha = await blobOid(path);
  if (sha === null) return;
  const res = await fetchUi(
    `/alice/feditor/delete/main/${path}`,
    withCookie(formPost({ tree_path: path, branch: "main", blob_sha: sha, commit_summary: "cleanup" }), cookie),
  );
  expect([303, 200]).toContain(res.status); // 200 = the CAS re-render; retry once below
  if (res.status === 200) {
    const fresh = await blobOid(path);
    if (fresh === null) return;
    await fetchUi(
      `/alice/feditor/delete/main/${path}`,
      withCookie(formPost({ tree_path: path, branch: "main", blob_sha: fresh }), cookie),
    );
  }
}

beforeAll(async () => {
  await ensureFeditorFixtures();
});

// --- the claim pin ----------------------------------------------------------------

describe("claim pin (the family's parse shapes wave8 does not carry)", () => {
  it("the new-family dir tail parses into the refSuffix walk (branch + dir in one tail)", () => {
    expect(parseUiRoute("/octo/hello/new/main/docs")).toEqual({
      family: "file-new",
      owner: "octo",
      repo: "hello",
      refSuffix: "main/docs",
    });
    expect(handlesUiRoute("/octo/hello/new/main/docs")).toBe(true);
    expect(handlesUiRoute("/octo/hello/delete/main/x.txt")).toBe(true);
  });

  it("upstream's underscored literals stay unclaimed (the brief pins the bare names)", () => {
    expect(parseUiRoute("/octo/hello/_edit/main/x.txt")).toBeNull();
    expect(parseUiRoute("/octo/hello/_new/main")).toBeNull();
    expect(parseUiRoute("/octo/hello/_delete/main/x.txt")).toBeNull();
  });
});

// --- the gates on the edit/delete arms ---------------------------------------------

describe("gates on the edit/delete arms (wave8 gated only /new)", () => {
  it("anonymous GETs 303 onto the login round-trip carrying each requested path", async () => {
    await ensureFeditorFixtures();
    const edit = await fetchUi("/alice/feditor/edit/main/notes/editor.txt");
    expect(edit.status).toBe(303);
    expect(edit.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Ffeditor%2Fedit%2Fmain%2Fnotes%2Feditor.txt");

    const del = await fetchUi("/alice/feditor/delete/main/docs/guide.md");
    expect(del.status).toBe(303);
    expect(del.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Ffeditor%2Fdelete%2Fmain%2Fdocs%2Fguide.md");
  });

  it("a non-writer 404s both GETs; the site admin renders both", async () => {
    const fixture = await ensureFeditorFixtures();
    const samEdit = await fetchUi("/alice/feditor/edit/main/notes/editor.txt", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.otherCookie}` },
    });
    expect(samEdit.status).toBe(404);
    const samDelete = await fetchUi("/alice/feditor/delete/main/docs/guide.md", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.otherCookie}` },
    });
    expect(samDelete.status).toBe(404);

    const adminEdit = await fetchUi("/alice/feditor/edit/main/notes/editor.txt", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` },
    });
    expect(adminEdit.status).toBe(200);
    const adminDelete = await fetchUi("/alice/feditor/delete/main/docs/guide.md", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` },
    });
    expect(adminDelete.status).toBe(200);
  });

  it("an anonymous same-origin POST edit 303s onto login with the POSTed path and writes nothing", async () => {
    await ensureFeditorFixtures();
    const before = await blobText("notes/editor.txt");
    const res = await fetchUi(
      "/alice/feditor/edit/main/notes/editor.txt",
      formPost({ tree_path: "notes/editor.txt", content: "anon draft\n", branch: "main" }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Ffeditor%2Fedit%2Fmain%2Fnotes%2Feditor.txt");
    expect(await blobText("notes/editor.txt")).toBe(before); // no anonymous write
  });

  it("a non-writer POST 404s before any write on both arms (engine read-back)", async () => {
    const fixture = await ensureFeditorFixtures();
    const before = await blobText("notes/editor.txt");
    const edit = await fetchUi(
      "/alice/feditor/edit/main/notes/editor.txt",
      withCookie(formPost({ tree_path: "notes/editor.txt", content: "sam draft\n", branch: "main" }), fixture.otherCookie),
    );
    expect(edit.status).toBe(404);
    expect(await blobText("notes/editor.txt")).toBe(before);

    const del = await fetchUi(
      "/alice/feditor/delete/main/docs/guide.md",
      withCookie(formPost({ tree_path: "docs/guide.md", branch: "main", blob_sha: (await blobOid("docs/guide.md")) ?? "" }), fixture.otherCookie),
    );
    expect(del.status).toBe(404);
    expect(await blobOid("docs/guide.md")).not.toBeNull();
  });

  it("an archived repo 404s BOTH verbs for the owner (RepoMustNotBeArchived answers NotFound)", async () => {
    const fixture = await ensureFeditorFixtures();
    const authed = { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` } };
    const get = await fetchUi("/alice/feditor-archived/edit/main/notes/editor.txt", authed);
    expect(get.status).toBe(404);
    const post = await fetchUi(
      "/alice/feditor-archived/edit/main/notes/editor.txt",
      withCookie(formPost({ tree_path: "notes/editor.txt", content: "x", branch: "main" }), fixture.ownerCookie),
    );
    expect(post.status).toBe(404);
    const del = await fetchUi("/alice/feditor-archived/delete/main/notes/editor.txt", authed);
    expect(del.status).toBe(404);
  });
});

// --- the cross-origin 403s on the write arms -----------------------------------------

describe("cross-origin 403s on the edit/delete POSTs (the guard fronts the family)", () => {
  it("a cross-origin POST edit 403s even WITH a valid session cookie and writes nothing", async () => {
    const fixture = await ensureFeditorFixtures();
    const before = await blobText("notes/editor.txt");
    const tipBefore = await mainTip();
    const res = await fetchUi("/alice/feditor/edit/main/notes/editor.txt", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}`,
      },
      body: new URLSearchParams({ tree_path: "notes/editor.txt", content: "evil draft\n", branch: "main" }).toString(),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await blobText("notes/editor.txt")).toBe(before);
    expect(await mainTip()).toBe(tipBefore);
  });

  it("a cross-origin POST delete 403s with the cookie and the file survives; cookie-less cross-origin 403s before the login 303", async () => {
    const fixture = await ensureFeditorFixtures();
    const sha = await blobOid("docs/guide.md");
    expect(sha).not.toBeNull();
    const del = await fetchUi("/alice/feditor/delete/main/docs/guide.md", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}`,
      },
      body: new URLSearchParams({ tree_path: "docs/guide.md", branch: "main", blob_sha: sha ?? "" }).toString(),
    });
    expect(del.status).toBe(403);
    expect(await del.text()).toContain("cross-origin request rejected");
    expect(await blobOid("docs/guide.md")).not.toBeNull();

    // The guard runs FIRST: a cookie-less cross-origin POST is a 403, not the
    // anonymous 303 the same-origin arm answers.
    const anon = await fetchUi("/alice/feditor/edit/main/notes/editor.txt", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ tree_path: "notes/editor.txt", content: "x", branch: "main" }).toString(),
    });
    expect(anon.status).toBe(403);
  });
});

// --- the create round-trip's deferred pieces ------------------------------------------

describe("the create round-trip's deferred pieces (nested target + identity + content-absent)", () => {
  it("a nested tree_path 303s onto the nested file view; the commit's identity is the session viewer with the noreply fallback", async () => {
    const fixture = await ensureFeditorFixtures();
    await deleteFileIfExists(fixture.ownerCookie, "docs/matrix-nested.txt");
    const res = await fetchUi(
      "/alice/feditor/new/main",
      withCookie(
        formPost({ tree_path: "docs/matrix-nested.txt", content: "nested from the web\n", branch: "main" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/feditor/src/branch/main/docs/matrix-nested.txt");
    expect(await blobText("docs/matrix-nested.txt")).toBe("nested from the web\n");

    // The commit identity: author = committer = the SESSION viewer (alice's
    // email column is null → the `{login}@noreply.{hostname}` fallback), the
    // default message carrying the FULL cleaned path.
    const log = await env.REPO.getByName("alice/feditor").listLog("main", { path: "docs/matrix-nested.txt", ofs: 0, n: 1 });
    const commit = log?.commits[0];
    expect(commit?.author).toMatchObject({ name: "alice", email: "alice@noreply.test.local" });
    expect(commit?.committer).toMatchObject({ name: "alice", email: "alice@noreply.test.local" });
    expect(commit?.message).toBe("Add 'docs/matrix-nested.txt'\n");
  });

  it("a content-absent POST new reads as the empty file (the parse's documented new-arm)", async () => {
    const fixture = await ensureFeditorFixtures();
    await deleteFileIfExists(fixture.ownerCookie, "matrix-empty.txt");
    const res = await fetchUi(
      "/alice/feditor/new/main",
      withCookie(formPost({ tree_path: "matrix-empty.txt", branch: "main" }), fixture.ownerCookie), // no content field
    );
    expect(res.status).toBe(303);
    const blob = await env.REPO.getByName("alice/feditor").readBlob("main", "matrix-empty.txt");
    expect(blob).not.toBeNull();
    expect(new TextDecoder().decode(blob!.data)).toBe("");
  });
});

// --- the edit round-trip's sha-CAS semantics -------------------------------------------

describe("the edit round-trip's sha-CAS semantics (the pinned blob_sha guard)", () => {
  it("a commit touching OTHER files does not block the edit (blob-granularity CAS — the documented divergence)", async () => {
    const fixture = await ensureFeditorFixtures();
    const sha0 = await blobOid("docs/guide.md");
    const tip0 = await mainTip();
    expect(sha0).not.toBeNull();

    // A foreign commit moves main through the editor's own create arm.
    await deleteFileIfExists(fixture.ownerCookie, "matrix-side.txt");
    const side = await fetchUi(
      "/alice/feditor/new/main",
      withCookie(formPost({ tree_path: "matrix-side.txt", content: "side commit\n", branch: "main" }), fixture.ownerCookie),
    );
    expect(side.status).toBe(303);
    expect(await mainTip()).not.toBe(tip0);

    // The stale TIP but live BLOB sha still commits: the CAS guards the blob,
    // not the branch (upstream's last_commit would have refused).
    const res = await fetchUi(
      "/alice/feditor/edit/main/docs/guide.md",
      withCookie(
        formPost({
          tree_path: "docs/guide.md",
          content: "guide rewritten after a side commit\n",
          branch: "main",
          blob_sha: sha0 ?? "",
        }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/feditor/src/branch/main/docs/guide.md");
    expect(await blobText("docs/guide.md")).toBe("guide rewritten after a side commit\n");
  });

  it("an ABSENT blob_sha field carries no CAS at all (the builder's conditional arm)", async () => {
    const fixture = await ensureFeditorFixtures();
    const res = await fetchUi(
      "/alice/feditor/edit/main/notes/editor.txt",
      withCookie(
        formPost({ tree_path: "notes/editor.txt", content: "absent-sha rewrite\n", branch: "main" }), // no blob_sha
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(await blobText("notes/editor.txt")).toBe("absent-sha rewrite\n");
  });

  it("a binary file's edit URL re-renders the refusal on POST without writing (the notEditableReason POST arm)", async () => {
    const fixture = await ensureFeditorFixtures();
    const tipBefore = await mainTip();
    const res = await fetchUi(
      "/alice/feditor/edit/main/logo.bin",
      withCookie(
        formPost({
          tree_path: "logo.bin",
          content: "text sneaked in\n",
          branch: "main",
          blob_sha: (await blobOid("logo.bin")) ?? "",
        }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Files cannot be edited through the web interface.");
    expect(await mainTip()).toBe(tipBefore); // no commit attempted
  });

  it("a content-absent POST edit answers the degenerate arm (An error occurred.) with the blob untouched", async () => {
    const fixture = await ensureFeditorFixtures();
    const before = await blobText("notes/editor.txt");
    const res = await fetchUi(
      "/alice/feditor/edit/main/notes/editor.txt",
      withCookie(
        formPost({
          tree_path: "notes/editor.txt",
          branch: "main",
          blob_sha: (await blobOid("notes/editor.txt")) ?? "", // no content field
        }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("An error occurred.");
    expect(await blobText("notes/editor.txt")).toBe(before);
  });
});

// --- the delete arm's deferred pieces ---------------------------------------------------

describe("the delete arm's deferred pieces (nested target + carried re-render)", () => {
  it("a nested delete 303s onto the containing SUBTREE, not the root; the file is gone", async () => {
    const fixture = await ensureFeditorFixtures();
    await deleteFileIfExists(fixture.ownerCookie, "docs/matrix-deep.txt");
    const created = await fetchUi(
      "/alice/feditor/new/main",
      withCookie(formPost({ tree_path: "docs/matrix-deep.txt", content: "deep bye\n", branch: "main" }), fixture.ownerCookie),
    );
    expect(created.status).toBe(303);
    const sha = await blobOid("docs/matrix-deep.txt");
    expect(sha).not.toBeNull();

    const res = await fetchUi(
      "/alice/feditor/delete/main/docs/matrix-deep.txt",
      withCookie(formPost({ tree_path: "docs/matrix-deep.txt", branch: "main", blob_sha: sha ?? "" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/feditor/src/branch/main/docs");
    expect(await blobOid("docs/matrix-deep.txt")).toBeNull();
  });

  it("a tampered target branch re-renders the service's arm at 200 with the submitted summary carried", async () => {
    const fixture = await ensureFeditorFixtures();
    const res = await fetchUi(
      "/alice/feditor/delete/main/notes/editor.txt",
      withCookie(
        formPost({
          tree_path: "notes/editor.txt",
          branch: "ghost",
          blob_sha: (await blobOid("notes/editor.txt")) ?? "",
          commit_summary: "matrix keep",
        }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("branch does not exist [name: ghost]");
    expect(html).toContain('value="matrix keep"'); // the submission survives the re-render
    expect(await blobOid("notes/editor.txt")).not.toBeNull(); // nothing deleted
  });
});
