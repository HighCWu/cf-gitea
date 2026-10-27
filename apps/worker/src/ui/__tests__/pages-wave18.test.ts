/**
 * Pages wave 18 route tests — the commit view family
 * (`/{owner}/{repo}/commit/{sha}`, pages/commit-view.tsx): upstream
 * templates/repo/commit_page.tmpl + web.go:1739's repo.Diff over the LANDED
 * reads (engineReads readCommit + readDiff — the parity survey's #1
 * dead-end, the target of every commits-log / branches-list / PR-commits
 * ShortSha link), rendered through the wave-5/13 diff components
 * (DiffFileBox/diffFileViews) and the stats bar.
 *
 * Same harness posture as pages-wave2..17: the router is driven directly
 * with the synthetic ASSETS manifest; engine content seeds through the REAL
 * receive flow (testing/seed-repo.ts's pack primitives, now with the
 * identity overrides this wave added) with fixed timestamps so the oids and
 * rendered stamps are deterministic. One fixture repo keeps the matrix off
 * any other suite's rows: `alice/wave18cv` (three commits — a root, a
 * two-file edit, and a different-committer commit authored by alice's
 * email, exercising the profile-link arm).
 *
 * The sha arms under test: the happy full-oid renders, the root commit's
 * no-parents arm, the non-hex and unresolvable-hex 404 shells, and the
 * short-prefix divergence (the engine's reachable-FULL-oid rule refuses
 * 7..39-hex where upstream's RevParse resolves — pages/commit-view.tsx's
 * documented divergence; the emitted links are always full oids).
 */

import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

// --- fixtures -----------------------------------------------------------------

/** Three fixed commits: the root (README only), the two-file edit, and the
 *  different-committer commit (authored by alice's mapped email — the
 *  profile-link arm — with a message body). Fixed times → deterministic
 *  oids and rendered stamps. */
const WAVE18_COMMITS: SeedCommit[] = [
  { message: "wave18: root commit", time: T0, files: [{ path: "README.md", content: "wave18 root readme\n" }] },
  {
    message: "wave18: edit readme and add source",
    time: T0 + 60,
    files: [
      { path: "README.md", content: "wave18 readme v2\n" },
      { path: "src/app.ts", content: 'console.log("wave18");\n' },
    ],
  },
  {
    message: "wave18: different committer\n\nA body line for the commit view.\n",
    time: T0 + 120,
    author: { name: "Alice", email: "alice@example.com" },
    committer: { name: "Commit Ter", email: "committer@example.com" },
    files: [
      { path: "README.md", content: "wave18 readme v2\n" },
      { path: "src/app.ts", content: 'console.log("wave18");\n' },
      { path: "notes/approvals.md", content: "# Approvals\n" },
    ],
  },
];

const WAVE18_MAIN = 2; // main points at tips[2] — the whole chain (root,
// tip, different-committer commit) is reachable through it

async function pushRefs(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array, token: string): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`wave18 seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** Idempotent seed (the ensureSeededRepo recipe): owner row, one pack push,
 *  settle + public + the createdAt pin, and alice's email (the
 *  usernamesByEmail profile-link fixture — her row ships emailless). */
async function ensureWave18Repo(): Promise<{ tips: string[] }> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const alice =
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) ??
    (await seedVerifiedUser({ username: "alice" }));
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) === undefined) {
    throw new Error("alice row missing after the wave-18 seed");
  }
  await db.update(users).set({ email: "alice@example.com" }).where(eq(users.id, alice.id));
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, "ui-page-seed-wave18cv")
    .run();
  const token = (await mintFor(alice.id, "ui-page-seed-wave18cv", "write:repository")).plaintext;

  const repoName = "alice/wave18cv";
  const refs = await env.REPO.getByName(repoName).listRefs();
  if (refs.head === null) {
    const { tips, pack } = await buildHistoryPack(WAVE18_COMMITS);
    await pushRefs(repoName, [{ ref: "refs/heads/main", oid: tips[WAVE18_MAIN] as string }], pack, token);
  }

  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave18cv")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wave18cv",
      isPrivate: false,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, row.id, repoName);
    row = (await db.select().from(repositories).where(eq(repositories.id, row.id)).get()) ?? row;
  }
  if (row.visibility !== "public") {
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  }
  if (row.defaultBranch !== "main") {
    await db.update(repositories).set({ defaultBranch: "main" }).where(eq(repositories.id, row.id));
  }
  await db.update(repositories).set({ createdAt: new Date(T0 * 1000) }).where(eq(repositories.id, row.id));
  return { tips: (await buildHistoryPack(WAVE18_COMMITS)).tips };
}

let wave18Tips: string[] | null = null;

async function tips(): Promise<string[]> {
  if (wave18Tips === null) wave18Tips = (await ensureWave18Repo()).tips;
  return wave18Tips;
}

beforeAll(async () => {
  await tips();
});

// --- the parser (the single owner of the route shape) ---------------------------

describe("wave-18 parser family (parseUiRoute / handlesUiRoute)", () => {
  it("claims the exact single-segment tail", () => {
    expect(parseUiRoute("/octo/hello/commit/5bde6b37197b62bf146fa01ac0bb3f0ee78aa3c0")).toEqual({
      family: "commit-view",
      owner: "octo",
      repo: "hello",
      sha: "5bde6b37197b62bf146fa01ac0bb3f0ee78aa3c0",
    });
    expect(parseUiRoute("/octo/hello/commit/HEAD")).toEqual({ family: "commit-view", owner: "octo", repo: "hello", sha: "HEAD" });
    // The trailing-slash form classifies to the same shape.
    expect(parseUiRoute("/octo/hello/commit/5bde6b37197b62bf146fa01ac0bb3f0ee78aa3c0/")).toEqual({
      family: "commit-view",
      owner: "octo",
      repo: "hello",
      sha: "5bde6b37197b62bf146fa01ac0bb3f0ee78aa3c0",
    });
    expect(handlesUiRoute("/octo/hello/commit/abc1234")).toBe(true);
  });

  it("decodes the sha segment (an escaped form arrives decoded)", () => {
    expect(parseUiRoute("/octo/hello/commit/%61bc123")?.family === "commit-view").toBe(true);
    const route = parseUiRoute("/octo/hello/commit/%61bc123");
    expect(route).toEqual({ family: "commit-view", owner: "octo", repo: "hello", sha: "abc123" });
  });

  it("leaves every other tail with the engine (upstream's unregistered-route 404)", () => {
    expect(parseUiRoute("/octo/hello/commit")).toBeNull(); // the bare literal
    // (wave 32 lifted the hex-shaped `/load-branches-and-tags` tail into the
    // commit-contained-refs family — its contract lives in
    // pages-wave32-archive-commit-aux.test.ts.)
    expect(parseUiRoute("/octo/hello/commit/5bde6b37197b62bf146fa01ac0bb3f0ee78aa3c0/extra")).toBeNull();
    expect(parseUiRoute("/octo/hello/commit/abc1234/extra")).toBeNull();
  });
});

// --- the page -------------------------------------------------------------------

describe("GET /{owner}/{repo}/commit/{sha} (the commit view)", () => {
  it("renders the header, parents, files-changed line and the diff boxes", async () => {
    const [root, tip] = (await tips()) as [string, string];
    const res = await fetchUi(`/alice/wave18cv/commit/${tip}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // commit_page.tmpl's discriminator + the header segment.
    expect(html).toContain("page-content repository diff");
    expect(html).toContain('<span class="commit-summary" title="wave18: edit readme and add source">');
    // The identity line (committer is author here) + the fixed stamp.
    expect(html).toContain(">Test User committed");
    // The parents arm: the count, the parent's ShortSha label onto its page.
    expect(html).toContain("1 parent");
    expect(html).toContain(`<a class="ui label commit-id-short" href="/alice/wave18cv/commit/${root}">${root.slice(0, 10)}</a>`);
    // The commit's own sha label (copy-less plain ShortSha).
    expect(html).toContain(`<a class="ui label commit-id-short" href="/alice/wave18cv/commit/${tip}">${tip.slice(0, 10)}</a>`);
    // Browse Source onto the /src/commit family (SourceCommitURL's shape).
    expect(html).toContain(`href="/alice/wave18cv/src/commit/${tip}"`);
    expect(html).toContain("Browse Source");
    // The diff short-stat segment: "2 files changed" + the stats bar.
    expect(html).toContain("2 files changed");
    expect(html).toContain("diff-stats-bar");
    // The diff boxes (the wave-5 vocabulary): one box per file with the
    // unified chroma table.
    expect(html.split('class="diff-file-box file-content tw-mt-0"').length - 1).toBe(2);
    expect(html).toContain("chroma lines-code");
    expect(html).not.toContain('<pre class="commit-body">'); // single-line subject
  });

  it("renders the root commit without the parents section", async () => {
    const [root] = (await tips()) as [string];
    const res = await fetchUi(`/alice/wave18cv/commit/${root}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("wave18: root commit");
    expect(html).not.toContain("1 parent");
    expect(html).not.toContain(">parents<");
    // The whole-tree diff renders (the engine's root-commit semantic).
    expect(html).toContain("1 file changed");
    expect(html).toContain("README.md");
  });

  it("renders the authored-and-committed line, the profile link, and the body", async () => {
    const [, , third] = (await tips()) as [string, string, string];
    const res = await fetchUi(`/alice/wave18cv/commit/${third}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // CommitterIsAuthor=false: authored_committed_at with the strong
    // committer name; the author's email maps to alice → the profile link.
    expect(html).toContain("authored and");
    expect(html).toContain('<a href="/alice">Alice</a>');
    expect(html).toContain("<strong>Commit Ter</strong>");
    // The message body pre (commit_page.tmpl's commit-body branch).
    expect(html).toContain('<pre class="commit-body">');
    expect(html).toContain("A body line for the commit view.");
    // "1 parent" still (the third commit has the second as its parent).
    expect(html).toContain("1 parent");
  });

  it("404-shells the non-hex, unresolvable-hex and short-prefix shas", async () => {
    const tip = (await tips())[1] as string;
    // (wave 29 lifted the dotted `${tip}.patch` shape into the diffpatch
    // download family — its 200 contract lives in
    // pages-wave29-diffpatch-files.test.ts.)
    for (const sha of ["HEAD", "nothex", "z".repeat(40), "0".repeat(40), tip.slice(0, 7)]) {
      const res = await fetchUi(`/alice/wave18cv/commit/${sha}`);
      expect(res.status, sha).toBe(404);
    }
    // (wave 32 lifted the hex-shaped `/load-branches-and-tags` tail into the
    // commit-contained-refs family — its 200 contract lives in
    // pages-wave32-archive-commit-aux.test.ts; a NON-hex sha with the tail
    // keeps the engine-owned miss below.)
    const aux = await fetchUi("/alice/wave18cv/commit/nothex/load-branches-and-tags");
    expect(aux.status).toBe(404);
  });

  it("hides a private repo behind the shared 404 shell", async () => {
    const db = drizzle(env.DB);
    const row = (
      await db
        .select()
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave18cv")))
        .get()
    )!;
    await db.update(repositories).set({ visibility: "private" }).where(eq(repositories.id, row.id));
    const res = await fetchUi(`/alice/wave18cv/commit/${(await tips())[1]}`);
    expect(res.status).toBe(404);
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  });

  it("w129-b10: the verify and CI-status template slots render nothing (the no-backing-data degradation, byte-pinned)", async () => {
    // Provenance: wave-polish-matrix-10 (2026-10-27). commit-view.tsx's
    // module header documents the two unrendered upstream slots —
    // `commit_statuses` (CI) and `commit_sign_badge` (the verification
    // badge) — "no backing data model … the commit-list precedent"; the
    // parent shapes beside them are pinned above, these two absences were
    // not. Also pins the header-buttons reduction: exactly ONE button
    // (Browse Source) renders — the revert/cherry-pick/tag dropdown is a
    // writer JS island (the same header's documented omission).
    const tip = (await tips())[1] as string;
    const res = await fetchUi(`/alice/wave18cv/commit/${tip}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The sign-badge slot: no verification chrome of any shape.
    expect(html).not.toContain("commit-sign-badge");
    expect(html).not.toContain(">Verified<");
    expect(html).not.toContain("commit-signature");
    // The CI-status slot: no status box between the identity bar and the
    // diff boxes.
    expect(html).not.toContain("commit-statuses");
    expect(html).not.toContain("ci-status");
    // The header buttons: one anchor only.
    expect(html.split('class="ui tiny button"').length - 1).toBe(1);
    expect(html).toContain("Browse Source");
    expect(html).not.toContain("Revert"); // the operations island stays dead
    expect(html).not.toContain("Cherry-pick");
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-18 a11y smoke", () => {
  it("every new page passes the structural rules for its viewer", async () => {
    const cookie = await mintSession(env.DB, (await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get())!.id);
    const tip = (await tips())[1] as string;
    for (const [path, init] of [
      [`/alice/wave18cv/commit/${tip}`, undefined],
      [`/alice/wave18cv/commit/${tip}`, withCookie(cookie)],
      [`/alice/wave18cv/commit/${(await tips())[0]}`, undefined],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
