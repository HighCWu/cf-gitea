/**
 * The pull-files single-commit module's smoke test (PORT-FIRST: ONE
 * happy path, no matrices — the polish wave owns the rest).
 *
 * Seeded over REAL engine content (the wave-29 receive-flow recipe; D1 from
 * the generated migrations): a PR with a mid-list commit asserts that its
 * files page loads the FIRST-PARENT diff range (before = the commit's own
 * parent, after = the commit — exactly one commit's changes, never the whole
 * PR range) and renders the tplPullFiles DOM; an unrelated-history PR whose
 * head IS a root commit asserts the DiffNotAvailable arm (the module
 * header's documented divergence — upstream ServerErrors there).
 *
 * HANDOFF NOTE (the mount recipe — the module is UNMOUNTED, the routes are
 * index-owned): in the pulls arm of the route discriminator, for
 * `rest.length === 3 && rest[1] === "files"`, AFTER compare-feeds'
 * `parsePullFilesRange(rest[2])` claim (the `pull-files-range` family):
 * `parsePullFilesSingleCommit(rest[2])` non-null → the `pull-files-single-
 * commit` family. Dispatcher: `loadPullFilesSingleCommit(c, repo.id,
 * route.index, route.segment)` — null → the 404 shell, else
 * `renderPullFilesSingleCommitPage({ ctx, data })` through
 * `respond(c.html(...))` (the pull-files family's exact shape). The bare
 * `/files` tail (upstream ViewPullFilesForAllCommitsOfPr) stays unclaimed.
 */

import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { Context } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { issues, repositories, users } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { T0 } from "../__tests__/harness";
import {
  loadPullFilesSingleCommit,
  parsePullFilesSingleCommit,
  renderPullFilesSingleCommitPage,
} from "./pull-files-single-commit";

// --- fixtures -------------------------------------------------------------------

/** Four fixed commits: c0 root, c1 = main tip (the PR merge base), c2 + c3
 *  = the topic tip's range (two commits ahead of main). The smoke's mid-list
 *  commit is c2: its single-commit page must show ONLY c2's own change. */
const PFS_COMMITS: SeedCommit[] = [
  { message: "pfs: root commit", time: T0, files: [{ path: "README.md", content: "pfs root\n" }] },
  { message: "pfs: c1 readme", time: T0 + 60, files: [{ path: "README.md", content: "pfs v1\n" }] },
  {
    message: "pfs: c2 app",
    time: T0 + 120,
    files: [
      { path: "README.md", content: "pfs v1\n" },
      { path: "src/app.ts", content: 'console.log("pfs c2");\n' },
    ],
  },
  {
    message: "pfs: c3 notes",
    time: T0 + 180,
    files: [
      { path: "README.md", content: "pfs v1\n" },
      { path: "src/app.ts", content: 'console.log("pfs c2");\n' },
      { path: "docs/notes.md", content: "# pfs notes\n" },
    ],
  },
];

const MAIN_TIP = 1; // main at c1 — c2/c3 are the PR range
const TOPIC_TIP = 3;
const MID_LIST = 2; // the smoke's single commit

/** An UNRELATED root (no merge base with the linear history) — PR #2's head,
 *  a ROOT commit reaching the page through the head escape (empty list). */
const LONELY_COMMITS: SeedCommit[] = [
  { message: "pfs: lonely root", time: T0 + 240, files: [{ path: "orphan.txt", content: "pfs lonely\n" }] },
];

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

async function pushRefs(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array, token: string): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`pfs seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** Idempotent seed (the wave-29 recipe): owner row, two pack pushes (main at
 *  c1; topic + refs/pull/1/head at c3; the lonely root + refs/pull/2/head),
 *  settle + public; PR #1 open (base main ← head topic), PR #2 open (base
 *  main ← head lonely — the ROOT-commit head arm). */
async function ensurePfsRepo(): Promise<{ tips: string[]; lonelyTip: string }> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const alice =
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) ??
    (await seedVerifiedUser({ username: "alice" }));
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, "ui-page-seed-pfscommit")
    .run();
  const token = (await mintFor(alice.id, "ui-page-seed-pfscommit", "write:repository")).plaintext;

  const repoName = "alice/pfscommit";
  const { tips, pack } = await buildHistoryPack(PFS_COMMITS);
  const lonely = await buildHistoryPack(LONELY_COMMITS);
  const refs = await env.REPO.getByName(repoName).listRefs();
  if (refs.head === null) {
    await pushRefs(
      repoName,
      [
        { ref: "refs/heads/main", oid: tips[MAIN_TIP] as string },
        { ref: "refs/heads/topic", oid: tips[TOPIC_TIP] as string },
        { ref: "refs/pull/1/head", oid: tips[TOPIC_TIP] as string },
      ],
      pack,
      token,
    );
  }
  const lonelyRef = (await env.REPO.getByName(repoName).listRefs()).refs.find((r) => r.name === "refs/heads/lonely");
  if (lonelyRef === undefined) {
    await pushRefs(
      repoName,
      [
        { ref: "refs/heads/lonely", oid: lonely.tips[0] as string },
        { ref: "refs/pull/2/head", oid: lonely.tips[0] as string },
      ],
      lonely.pack,
      token,
    );
  }

  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "pfscommit")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "pfscommit",
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

  const existing = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, row.id)).limit(1).get();
  if (existing === undefined) {
    const svc = new IssuesService(env.DB);
    await svc.createPullRequest({
      repoId: row.id,
      title: "pfs: the open pull",
      content: "Two commits ahead of main.",
      posterId: alice.id,
      headRepoId: row.id,
      baseBranch: "main",
      headBranch: "topic",
      now: new Date((T0 + 190) * 1000),
    });
    await svc.createPullRequest({
      repoId: row.id,
      title: "pfs: the lonely pull",
      content: "Head is an unrelated root commit.",
      posterId: alice.id,
      headRepoId: row.id,
      baseBranch: "main",
      headBranch: "lonely",
      now: new Date((T0 + 200) * 1000),
    });
  }
  return { tips, lonelyTip: lonely.tips[0] as string };
}

let pfsTips: string[] | null = null;
let pfsLonelyTip: string | null = null;

function tips(): string[] {
  if (pfsTips === null) throw new Error("fixtures not seeded");
  return pfsTips;
}

function lonelyTip(): string {
  if (pfsLonelyTip === null) throw new Error("fixtures not seeded");
  return pfsLonelyTip;
}

async function pfsRepoRow() {
  const row =
    (await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "pfscommit")))
      .get()) ?? null;
  if (row === null) throw new Error("pfscommit repo row missing");
  return row;
}

/** The hono context the loader takes (the family's re-wrap). */
function singleContext(index: number, sha: string): Context<{ Bindings: Env }> {
  return new Context(new Request(`https://test.local/alice/pfscommit/pulls/${index}/files/${sha}`), { env });
}

beforeAll(async () => {
  const seeded = await ensurePfsRepo();
  pfsTips = seeded.tips;
  pfsLonelyTip = seeded.lonelyTip;
});

// --- the smoke ------------------------------------------------------------------

describe("pull-files single-commit (the PORT-FIRST smoke)", () => {
  it("renders a mid-list commit's own file changes and the root-commit DiffNotAvailable arm", async () => {
    // The grammar admits the seeded full oid (lowercase 7..64 hex, anchored).
    const c2 = tips()[MID_LIST] as string;
    expect(parsePullFilesSingleCommit(c2)).toBe(c2);

    // The mid-list commit's page: before = its FIRST PARENT (c1), after = the
    // commit — exactly c2's own change (src/app.ts added), never the whole
    // PR range (docs/notes.md belongs to c3 and must not appear).
    const row = await pfsRepoRow();
    const data = await loadPullFilesSingleCommit(singleContext(1, c2), row.id, 1, c2);
    expect(data).not.toBeNull();
    if (data === null) return;
    expect(data.before).toBe(tips()[MAIN_TIP]);
    expect(data.after).toBe(c2);
    expect(data.issue.index).toBe(1);
    expect(data.issue.isPull).toBe(true);
    expect(data.files.map((view) => view.file.path)).toEqual(["src/app.ts"]);
    expect(data.totalAddition).toBeGreaterThan(0);
    expect(data.totalDeletion).toBe(0);

    const ctx: UiContext = {
      viewer: { kind: "anonymous" },
      origin: "https://test.local",
      assets: shellAssetsFromManifest(manifest),
      repo: row,
    };
    const html = renderPullFilesSingleCommitPage({ ctx, data });
    expect(html).toContain("repository view issue pull files diff");
    expect(html).toContain("#1 - pfs: the open pull");
    expect(html).toContain("diff-file-box");
    expect(html).toContain("src/app.ts");
    expect(html).not.toContain("docs/notes.md");

    // The root-commit arm: PR #2's head IS a root commit — the head escape
    // admits it (the list is empty, unrelated histories), there is no first
    // parent, and the page renders upstream's DiffNotAvailable arm (the
    // module header's documented divergence: upstream 500s here).
    const root = await loadPullFilesSingleCommit(singleContext(2, lonelyTip()), row.id, 2, lonelyTip());
    expect(root).not.toBeNull();
    if (root === null) return;
    expect(root.before).toBe("");
    expect(root.after).toBe(lonelyTip());
    expect(root.files).toEqual([]);
    const rootHtml = renderPullFilesSingleCommitPage({ ctx, data: root });
    expect(rootHtml).toContain("Diff Content Not Available");
    expect(rootHtml).toContain("#2 - pfs: the lonely pull");
  });
});
