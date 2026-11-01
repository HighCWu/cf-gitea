/**
 * Pages wave 29 route tests — the diffpatch file download family
 * (`/{owner}/{repo}/commit/{sha}.{diff|patch}` + `/{owner}/{repo}/pulls/
 * {index}.{diff|patch}`, pages/diffpatch-files.ts): the parity survey's row
 * 4 — upstream web.go:1760 repo.RawDiff (commit.go:430-460) and
 * web.go:1657-1658 DownloadPullDiff/Patch (pull.go:1469-1501), the four
 * raw-text routes the web mux serves (no /api/v1 op).
 *
 * Same harness posture as pages-wave18: the router is driven directly with
 * the synthetic ASSETS manifest; engine content seeds through the REAL
 * receive flow with fixed timestamps (deterministic oids). One fixture repo
 * keeps the matrix off every other suite's rows: `alice/wave29dp` — main at
 * c1 (the PR merge base), feature + refs/pull/{1,2}/head at c2, PR #1 open,
 * PR #2 closed (upstream GetPullRequestByIndex serves every state,
 * pull.go:1485-1494's arm).
 *
 * The asserted contract: the sniffed-equal content type
 * (`text/plain; charset=utf-8`), the web context middleware's zero-option
 * prod Cache-Control (context.go:189), the plain unified diff body, the
 * git-am mail header (From/Date/Subject) with the commit arm's
 * `--no-signature` parity (diff.go:73) and the pull arm's signature tail,
 * the short-prefix 404 divergence (the engine's reachable-FULL-oid rule),
 * and the 404 family (missing sha/PR, non-pull row, private repo).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { issues, repositories, users } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { SELF } from "cloudflare:test";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";
import { T0, uiEnv } from "./harness";
import { serializeCommit } from "@cf-gitea/git-engine";
import { engineReads } from "../../api/services/engine";

async function fetchUi(path: string): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`), uiEnv);
}

// --- fixtures -----------------------------------------------------------------

/** Three fixed commits: the root (README), the two-file edit (= main = the
 *  PR merge base), and the PR head (adds docs/notes.md). Fixed times →
 *  deterministic oids. */
const WAVE29_COMMITS: SeedCommit[] = [
  { message: "wave29: root commit", time: T0, files: [{ path: "README.md", content: "wave29 root readme\n" }] },
  {
    message: "wave29: edit readme and add source",
    time: T0 + 60,
    files: [
      { path: "README.md", content: "wave29 readme v2\n" },
      { path: "src/app.ts", content: 'console.log("wave29");\n' },
    ],
  },
  {
    message: "wave29: pr head\n\nA body line for the patch header.\n",
    time: T0 + 120,
    files: [
      { path: "README.md", content: "wave29 readme v2\n" },
      { path: "src/app.ts", content: 'console.log("wave29");\n' },
      { path: "docs/notes.md", content: "# wave29 notes\n" },
    ],
  },
];

const WAVE29_MAIN = 1; // main at c1 — c2 is one ahead (the PR range)

async function pushRefs(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array, token: string): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`wave29 seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** Idempotent seed (the wave-18 recipe): owner row, one pack push (main at
 *  c1, feature + both PR head refs at c2), settle + public, PR #1 open and
 *  PR #2 closed (D1-only rows — createPullRequest writes no engine refs). */
async function ensureWave29Repo(): Promise<{ tips: string[] }> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const alice =
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) ??
    (await seedVerifiedUser({ username: "alice" }));
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, "ui-page-seed-wave29dp")
    .run();
  const token = (await mintFor(alice.id, "ui-page-seed-wave29dp", "write:repository")).plaintext;

  const repoName = "alice/wave29dp";
  const refs = await env.REPO.getByName(repoName).listRefs();
  if (refs.head === null) {
    const { tips, pack } = await buildHistoryPack(WAVE29_COMMITS);
    await pushRefs(
      repoName,
      [
        { ref: "refs/heads/main", oid: tips[WAVE29_MAIN] as string },
        { ref: "refs/heads/feature", oid: tips[2] as string },
        { ref: "refs/pull/1/head", oid: tips[2] as string },
        { ref: "refs/pull/2/head", oid: tips[2] as string },
      ],
      pack,
      token,
    );
  }

  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave29dp")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wave29dp",
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

  // The PR rows: #1 open, #2 closed (pull.go:1485 GetPullRequestByIndex —
  // no state filter). Idempotent on the repo's first issue row.
  const existing = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, row.id)).limit(1).get();
  if (existing === undefined) {
    const svc = new IssuesService(env.DB);
    await svc.createPullRequest({
      repoId: row.id,
      title: "wave29: the open pull",
      content: "Adds the notes file.",
      posterId: alice.id,
      headRepoId: row.id,
      baseBranch: "main",
      headBranch: "feature",
      now: new Date((T0 + 130) * 1000),
    });
    const closed = await svc.createPullRequest({
      repoId: row.id,
      title: "wave29: the closed pull",
      content: "Same range, closed state.",
      posterId: alice.id,
      headRepoId: row.id,
      baseBranch: "main",
      headBranch: "feature",
      now: new Date((T0 + 140) * 1000),
    });
    await svc.closeIssue(closed.issue.id, { now: new Date((T0 + 150) * 1000) });
  }
  return { tips: (await buildHistoryPack(WAVE29_COMMITS)).tips };
}

let wave29Tips: string[] | null = null;

async function tips(): Promise<string[]> {
  if (wave29Tips === null) wave29Tips = (await ensureWave29Repo()).tips;
  return wave29Tips;
}

beforeAll(async () => {
  await tips();
});

// --- the parser (the single owner of the route shape) ---------------------------

describe("wave-29 parser family (parseUiRoute / handlesUiRoute)", () => {
  it("lifts the hex-shaped dotted commit segment into the download family", () => {
    expect(parseUiRoute("/octo/hello/commit/5bde6b37197b62bf146fa01ac0bb3f0ee78aa3c0.diff")).toEqual({
      family: "commit-diffpatch",
      owner: "octo",
      repo: "hello",
      sha: "5bde6b37197b62bf146fa01ac0bb3f0ee78aa3c0",
      ext: "diff",
    });
    expect(parseUiRoute("/octo/hello/commit/abc1234.patch")).toEqual({
      family: "commit-diffpatch",
      owner: "octo",
      repo: "hello",
      sha: "abc1234",
      ext: "patch",
    });
    // 64-hex is the upstream pattern's top bound (web.go:1760).
    expect(parseUiRoute(`/octo/hello/commit/${"a".repeat(64)}.diff`)?.family).toBe("commit-diffpatch");
    expect(parseUiRoute(`/octo/hello/commit/${"a".repeat(65)}.diff`)?.family).toBe("commit-view"); // too long → the view shell
    // The trailing-slash form classifies to the same shape (the 301 middleware).
    expect(parseUiRoute("/octo/hello/commit/abc1234.diff/")).toEqual({
      family: "commit-diffpatch",
      owner: "octo",
      repo: "hello",
      sha: "abc1234",
      ext: "diff",
    });
    expect(handlesUiRoute("/octo/hello/commit/abc1234.patch")).toBe(true);
  });

  it("keeps every non-dotted-hex segment with the wave-18 commit view", () => {
    // A non-hex dotted form is upstream's pattern miss — the view's shell.
    expect(parseUiRoute("/octo/hello/commit/foo.diff")).toEqual({ family: "commit-view", owner: "octo", repo: "hello", sha: "foo.diff" });
    expect(parseUiRoute("/octo/hello/commit/HEAD.diff")).toEqual({ family: "commit-view", owner: "octo", repo: "hello", sha: "HEAD.diff" });
    // Too-short/dotted-only-prefix shapes stay with the view as well.
    expect(parseUiRoute("/octo/hello/commit/abc.diff")).toEqual({ family: "commit-view", owner: "octo", repo: "hello", sha: "abc.diff" });
    // Undotted shapes are untouched.
    expect(parseUiRoute("/octo/hello/commit/abc1234")).toEqual({ family: "commit-view", owner: "octo", repo: "hello", sha: "abc1234" });
    expect(parseUiRoute("/octo/hello/commit/abc1234.diff/x")).toBeNull(); // deeper tails engine-owned
  });

  it("claims the dotted numeric pulls tail and nothing else in the space", () => {
    expect(parseUiRoute("/octo/hello/pulls/7.diff")).toEqual({
      family: "pull-diffpatch",
      owner: "octo",
      repo: "hello",
      index: 7,
      ext: "diff",
    });
    expect(parseUiRoute("/octo/hello/pulls/7.patch")).toEqual({
      family: "pull-diffpatch",
      owner: "octo",
      repo: "hello",
      index: 7,
      ext: "patch",
    });
    // "007" parses as 7 (PathParamInt64 parity, the issue-detail convention).
    const seven = parseUiRoute("/octo/hello/pulls/007.diff");
    expect(seven?.family === "pull-diffpatch" ? seven.index : undefined).toBe(7);
    // Negative, junk, wrong-ext and deeper tails stay engine-owned (the
    // unregistered-route 404 — upstream's chi pattern misses them the same).
    expect(parseUiRoute("/octo/hello/pulls/-1.diff")).toBeNull();
    expect(parseUiRoute("/octo/hello/pulls/abc.diff")).toBeNull();
    expect(parseUiRoute("/octo/hello/pulls/7.exe")).toBeNull();
    expect(parseUiRoute("/octo/hello/pulls/7.diff/x")).toBeNull();
    expect(handlesUiRoute("/octo/hello/pulls/7.diff")).toBe(true);
    expect(handlesUiRoute("/octo/hello/pulls/-1.diff")).toBe(false);
  });
});

// --- the commit downloads -------------------------------------------------------

/** The D11 fixture: a MERGE commit over the seeded history (parents [c1, c2],
 *  tree = c2's), landed through the engine's public write RPCs (the
 *  push-stale pattern — putApiObjects + a fresh-ref commitApiChange). Fixed
 *  times → a deterministic oid, so the idempotent seed can read it back. */
const MERGE_TIME = T0 + 600;
const MERGE_MESSAGE = "Merge branch 'feature' into main\n";
const ZERO_OID = "0".repeat(40);

describe("GET /{owner}/{repo}/commit/{sha}.{diff|patch} — the merge arms (D11)", () => {
  async function seedMerge(): Promise<{ mergeOid: string; c1: string; c2: string }> {
    const [, c1, c2] = (await tips()) as [string, string, string];
    const reads = engineReads(env, { ownerNamespace: "alice", slug: "wave29dp" });
    const head = await reads.readCommit(c2);
    if (head === null) throw new Error("wave29 c2 unreadable");
    const person = { name: "Test User", email: "test@example.com", time: MERGE_TIME, tz: "+0000" };
    const merge = serializeCommit({
      tree: head.tree,
      parents: [c1, c2],
      author: person,
      committer: person,
      message: MERGE_MESSAGE,
    });
    const existing = await reads.readCommit(merge.oid);
    if (existing === null) {
      const cell = env.REPO.getByName("alice/wave29dp");
      const put = await cell.putApiObjects([{ oid: merge.oid, type: "commit", data: merge.data }]);
      if (put.tag !== "ok") throw new Error(`merge putApiObjects failed: ${put.tag}`);
      const landed = await cell.commitApiChange({ ref: "refs/heads/merge-topic", expectedOldOid: ZERO_OID, newOid: merge.oid });
      if (landed.tag !== "committed") throw new Error(`merge ref landing failed: ${landed.tag}`);
    }
    return { mergeOid: merge.oid, c1, c2 };
  }

  it("renders a MERGE commit's .patch as the non-merge side-commit series (format-patch skips merges)", async () => {
    const { mergeOid, c2 } = await seedMerge();
    const res = await fetchUi(`/alice/wave29dp/commit/${mergeOid}.patch`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // upstream RawDiffPatch for a merge: format-patch <merge>...<parent0>
    // walks parent0..<merge> and mails every NON-MERGE commit — the merge
    // itself is NEVER a mail (verified against the binary; a merge-only range
    // prints zero bytes). Here the side series is {c2} — one bare-[PATCH]
    // mail (single-mail series stay unnumbered), no merge mail.
    expect(body.startsWith(`From ${c2} Mon Sep 17 00:00:00 2001\n`)).toBe(true);
    expect(body).toContain("Subject: [PATCH] wave29: pr head");
    expect(body).not.toContain(`From ${mergeOid} `);
    expect(body).not.toContain("Merge branch 'feature'");
    // --no-signature: the commit download strips the signature tail
    expect(body).not.toContain("\n-- \n");
  });

  it("keeps a merge commit's .diff on the first-parent tree diff (RawDiffNormal)", async () => {
    const { mergeOid } = await seedMerge();
    const res = await fetchUi(`/alice/wave29dp/commit/${mergeOid}.diff`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // diff <parent0> <merge> — the second-parent side's tree delta
    expect(body).toContain("diff --git a/docs/notes.md b/docs/notes.md");
    expect(body).not.toContain("docs/notes.md b/docs/notes.md\ndiff --git a/src/app.ts");
  });
});

describe("GET /{owner}/{repo}/commit/{sha}.{diff|patch}", () => {
  it("serves the plain unified diff with the upstream content type and cache header", async () => {
    const [, c1] = (await tips()) as [string, string];
    const res = await fetchUi(`/alice/wave29dp/commit/${c1}.diff`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    const body = await res.text();
    // The GetRawDiff RawDiffNormal arm's shape (diff vs the first parent).
    expect(body).toContain("diff --git a/README.md b/README.md");
    expect(body).toContain("--- a/README.md");
    expect(body).toContain("+++ b/README.md");
    // git omits the `,1` single-line hunk count (the D3 byte fix — recorded
    // real-git output: a one-line file edit prints `@@ -1 +1 @@`)
    expect(body).toContain("@@ -1 +1 @@");
    expect(body).toContain("-wave29 root readme");
    expect(body).toContain("+wave29 readme v2");
    // The created file carries git's new-file form — and the index line has
    // NO mode column there (the mode lives on the new-file-mode line, D3).
    expect(body).toContain("new file mode 100644");
    const newIndex = body.indexOf("new file mode 100644");
    expect(body.slice(newIndex, newIndex + 60)).toMatch(/^new file mode 100644\nindex 0000000\.\.[0-9a-f]{7}\n/);
    expect(body).toContain("+console.log(\"wave29\");");
  });

  it("serves the git-am mail shape WITHOUT the signature tail (--no-signature)", async () => {
    const [, c1] = (await tips()) as [string, string];
    const res = await fetchUi(`/alice/wave29dp/commit/${c1}.patch`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await res.text();
    // format-patch's mail header (modules/git/diff.go:73's --no-signature arm).
    expect(body.startsWith(`From ${c1} Mon Sep 17 00:00:00 2001\n`)).toBe(true);
    expect(body).toContain("From: Test User <test@example.com>");
    expect(body).toMatch(/^Date: [A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} \+0000$/m);
    expect(body).toContain("Subject: [PATCH] wave29: edit readme and add source");
    expect(body).toContain("---\ndiff --git a/README.md b/README.md");
    // --no-signature: no trailing `-- \n{version}` block.
    expect(body).not.toContain("\n-- \n");
  });

  it("serves the root commit's whole-tree diff (git show arm)", async () => {
    const [root] = (await tips()) as [string];
    const res = await fetchUi(`/alice/wave29dp/commit/${root}.diff`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("diff --git a/README.md b/README.md");
    expect(body).toContain("new file mode 100644");
    expect(body).toContain("+wave29 root readme");
    expect(body).not.toContain("src/app.ts");
  });

  it("404s the short-prefix, unknown and junk shas (the pattern + engine arms)", async () => {
    const [, c1] = (await tips()) as [string, string];
    // The short-prefix divergence: upstream RevParse resolves 7..39-hex, the
    // engine answers full reachable oids only (the commit view's note).
    for (const sha of [c1.slice(0, 7), c1.slice(0, 39), "f".repeat(40), "foo.diff", "HEAD.diff"]) {
      const res = await fetchUi(`/alice/wave29dp/commit/${sha}`);
      expect(res.status, sha).toBe(404);
    }
  });

  it("hides a private repo behind the shared 404 shell", async () => {
    const db = drizzle(env.DB);
    const row = (
      await db
        .select()
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave29dp")))
        .get()
    )!;
    const [, c1] = (await tips()) as [string, string];
    await db.update(repositories).set({ visibility: "private" }).where(eq(repositories.id, row.id));
    const res = await fetchUi(`/alice/wave29dp/commit/${c1}.diff`);
    expect(res.status).toBe(404);
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  });
});

// --- the pull downloads ---------------------------------------------------------

describe("GET /{owner}/{repo}/pulls/{index}.{diff|patch}", () => {
  it("serves the PR range's plain unified diff", async () => {
    const res = await fetchUi("/alice/wave29dp/pulls/1.diff");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    const body = await res.text();
    // The merge_base...refs/pull/1/head range: only the notes file changed.
    expect(body).toContain("diff --git a/docs/notes.md b/docs/notes.md");
    expect(body).toContain("new file mode 100644");
    expect(body).toContain("+# wave29 notes");
    expect(body).not.toContain("README.md");
    expect(body).not.toContain("src/app.ts");
  });

  it("serves the PR patch mail shape WITH the signature tail (GetPatch)", async () => {
    const [, , c2] = (await tips()) as [string, string, string];
    const res = await fetchUi("/alice/wave29dp/pulls/1.patch");
    expect(res.status).toBe(200);
    const body = await res.text();
    // The head commit's mail block over the range diff (the landed API
    // family's single-block rendering; GetPatch keeps git's signature).
    expect(body.startsWith(`From ${c2} Mon Sep 17 00:00:00 2001\n`)).toBe(true);
    expect(body).toContain("Subject: [PATCH] wave29: pr head");
    expect(body).toContain("A body line for the patch header.");
    expect(body).toContain("diff --git a/docs/notes.md b/docs/notes.md");
    // the mail tail is git's stream end: the version line plus the final
    // newline (real git 2.43.0 `format-patch --stdout -1` ends `2.43.0\n\n`)
    expect(body.endsWith("-- \n2.47.0\n\n")).toBe(true);
  });

  it("serves a CLOSED pull (GetPullRequestByIndex has no state filter)", async () => {
    const res = await fetchUi("/alice/wave29dp/pulls/2.diff");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("diff --git a/docs/notes.md b/docs/notes.md");
  });

  it("404s a missing PR, a non-pull issue and the junk tails", async () => {
    // Pull #99 does not exist.
    expect((await fetchUi("/alice/wave29dp/pulls/99.diff")).status).toBe(404);
    expect((await fetchUi("/alice/wave29dp/pulls/99.patch")).status).toBe(404);
    // The junk tail never reaches the UI (engine-owned → the gate's 404
    // through the sub-app's drift guard when driven directly).
    expect((await fetchUi("/alice/wave29dp/pulls/7.exe")).status).toBe(404);
    expect((await fetchUi("/alice/wave29dp/pulls/-1.diff")).status).toBe(404);
  });

  it("hides a private repo behind the shared 404 shell", async () => {
    const db = drizzle(env.DB);
    const row = (
      await db
        .select()
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave29dp")))
        .get()
    )!;
    await db.update(repositories).set({ visibility: "private" }).where(eq(repositories.id, row.id));
    const res = await fetchUi("/alice/wave29dp/pulls/1.diff");
    expect(res.status).toBe(404);
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  });
});
