/**
 * Pages wave 54 route tests — the blame family
 * (`/{owner}/{repo}/blame/{branch|tag|commit}/{ref}/{path}`,
 * pages/blame.tsx): upstream web.go:1729-1733's blame group → repo.RefBlame
 * (routers/web/repo/blame.go) over the engine's census R08 `blame()` read
 * RPC, rendered in blame.tmpl's shape (the line-numbered + commit-annotated
 * grid: per-part sidebar with sha/message/author/age on each part's first
 * row, the previous-sha "view blame prior" links, L{n} anchors, lines-code
 * cells) plus the census's file-view Blame anchor
 * (components/file-content.tsx's view_file.tmpl:54 button, gated by the
 * engine's blame budget).
 *
 * Same harness posture as pages-wave2..53: the router is driven directly
 * with the synthetic ASSETS manifest; engine content seeds through the REAL
 * receive flow (testing/seed-repo.ts's pack primitives) with fixed timestamps
 * so the oids and rendered stamps are deterministic. One fixture repo keeps
 * the matrix off any other suite's rows: `alice/wave54blame` (four commits —
 * the story chain with an interleaved foreign-file commit, a binary file,
 * and an over-MAX_BLAME_LINES file).
 *
 * The attribution CORRECTNESS lives at the engine gate
 * (packages/git-engine/e2e/check-blame.mjs — real `git blame --porcelain`
 * oracle); this suite pins the page: the rendered shape, the upstream
 * annotation fields (blame-info/blame-message/blame-avatar/blame-time,
 * lines-num/lines-code, top-line-blame per part), the prior links, the
 * action row, and the 404 arms (empty tree path, missing path, binary,
 * unresolvable ref, private repo).
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
import { runA11y } from "./a11y";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

// --- fixtures -----------------------------------------------------------------

const STORY_V1 = "line one\nline two\nline three\n";
const STORY_V2 = "line one\nline two EDITED\nline three\nline four\n";
const STORY_V3 = `${STORY_V2}line five\n`;

/** Four fixed commits: the story chain (born → foreign file interleaved →
 *  edit → append), a binary file, and a 5001-line file (the over-budget
 *  anchor arm). Fixed times → deterministic oids. */
const WAVE54_COMMITS: SeedCommit[] = [
  { message: "wave54: story born", time: T0, files: [{ path: "story.txt", content: STORY_V1 }] },
  {
    message: "wave54: foreign file",
    time: T0 + 60,
    files: [
      { path: "story.txt", content: STORY_V1 },
      { path: "other.txt", content: "unrelated\n" },
    ],
  },
  {
    message: "wave54: edit story",
    time: T0 + 120,
    files: [
      { path: "story.txt", content: STORY_V2 },
      { path: "other.txt", content: "unrelated\n" },
    ],
  },
  {
    message: "wave54: append story",
    time: T0 + 180,
    files: [
      { path: "story.txt", content: STORY_V3 },
      { path: "other.txt", content: "unrelated\n" },
      // the null byte puts it in the view-raw media family
      { path: "logo.png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]) },
      // 5001 lines: the engine's MAX_BLAME_LINES bail (the anchor's no-dead-link arm)
      { path: "big.txt", content: `${Array.from({ length: 5001 }, (_v, i) => `row ${i}`).join("\n")}\n` },
    ],
  },
];

async function pushRefs(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array, token: string): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`wave54 seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** Idempotent seed (the ensureSeededRepo recipe): owner row, one pack push,
 *  settle + public + the createdAt pin. */
async function ensureWave54Repo(): Promise<{ tips: string[] }> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  let alice = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get();
  if (alice === undefined) alice = await seedVerifiedUser({ username: "alice" });
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, "ui-page-seed-wave54blame")
    .run();
  const token = (await mintFor(alice.id, "ui-page-seed-wave54blame", "write:repository")).plaintext;

  const repoName = "alice/wave54blame";
  const refs = await env.REPO.getByName(repoName).listRefs();
  if (refs.head === null) {
    const { tips, pack } = await buildHistoryPack(WAVE54_COMMITS);
    await pushRefs(repoName, [{ ref: "refs/heads/main", oid: tips[3] as string }], pack, token);
  }

  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave54blame")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wave54blame",
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
  return { tips: (await buildHistoryPack(WAVE54_COMMITS)).tips };
}

let wave54Tips: string[] | null = null;

async function tips(): Promise<string[]> {
  if (wave54Tips === null) wave54Tips = (await ensureWave54Repo()).tips;
  return wave54Tips;
}

beforeAll(async () => {
  await tips();
});

// --- the parser (the single owner of the route shape) ---------------------------

describe("wave-54 parser family (parseUiRoute / handlesUiRoute)", () => {
  it("claims the typed tails (branch/tag/commit) with the full decoded rest", () => {
    expect(parseUiRoute("/octo/hello/blame/branch/main/story.txt")).toEqual({
      family: "blame",
      owner: "octo",
      repo: "hello",
      refSuffix: "branch/main/story.txt",
    });
    expect(parseUiRoute("/octo/hello/blame/commit/5bde6b37197b62bf146fa01ac0bb3f0ee78aa3c0/pkg/app.ts")).toEqual({
      family: "blame",
      owner: "octo",
      repo: "hello",
      refSuffix: "commit/5bde6b37197b62bf146fa01ac0bb3f0ee78aa3c0/pkg/app.ts",
    });
    // a bare refType tail is claimed (chi's `/*` matches the empty tail) —
    // the loader's empty-TreePath arm answers it with the 404 shell
    expect(parseUiRoute("/octo/hello/blame/branch")).toEqual({
      family: "blame",
      owner: "octo",
      repo: "hello",
      refSuffix: "branch",
    });
    expect(handlesUiRoute("/octo/hello/blame/tag/v1/docs/x.md")).toBe(true);
  });

  it("leaves the bare /blame with the engine (no upstream route)", () => {
    expect(parseUiRoute("/octo/hello/blame")).toBeNull();
  });
});

// --- the page -------------------------------------------------------------------

describe("GET /{owner}/{repo}/blame/{refType}/{ref}/{path} (the blame view)", () => {
  it("renders the blame grid with the upstream annotation fields", async () => {
    const [born, foreign, edit, append] = await tips();
    const res = await fetchUi("/alice/wave54blame/blame/branch/main/story.txt");
    expect(res.status).toBe(200);
    const html = await res.text();
    // view.tmpl:2's discriminator gains `blame`
    expect(html).toContain("page-content repository file list blame");
    // one row per line, numbered absolutely (L1..L5 spans)
    expect(html).toContain('<span id="L1" data-line-number="1"></span>');
    expect(html).toContain('<span id="L5" data-line-number="5"></span>');
    expect(html).toContain('rel="L3" class="lines-code blame-code chroma"');
    expect(html).toContain("line two EDITED");
    expect(html).toContain("line five");
    // the code cells carry the escaped content
    expect(html.split("<td").filter((s) => s.startsWith(' class="lines-num"')).length).toBe(5);
    // the part sidebar renders on each run's FIRST row only. The interleaved
    // edit makes the RUNS alternate (born / edit / born / edit / append — 5
    // runs over 3 distinct commits), which is exactly git blame's shape.
    expect(html.split('class="top-line-blame"').length - 1).toBe(5);
    expect(html.split('class="blame-info"').length - 1).toBe(5);
    expect(html.split('<div class="blame-avatar">Test User</div>').length - 1).toBe(5);
    // the commit annotation: subject anchors onto the commit page — the born
    // and edit runs each own two lines, the append run one
    expect(html.split(`href="/alice/wave54blame/commit/${append}"`).length - 1).toBe(1);
    expect(html.split(`href="/alice/wave54blame/commit/${edit}"`).length - 1).toBe(2);
    expect(html.split(`href="/alice/wave54blame/commit/${born}"`).length - 1).toBe(2);
    expect(html).toContain('<div class="blame-avatar">Test User</div>');
    expect(html).toContain('<div class="blame-time not-mobile">');
    expect(html).toContain("<relative-time");
    // the previous-sha links: the append part's prior is the EDIT commit, the
    // edit part's prior is the FOREIGN commit (git's immediate-parent
    // semantic — the foreign commit carries the file); the creation part
    // carries none
    expect(html).toContain(`href="/alice/wave54blame/blame/commit/${edit}/story.txt"`);
    expect(html).toContain(`href="/alice/wave54blame/blame/commit/${foreign}/story.txt"`);
    expect(html).toContain('data-tooltip-content="View blame prior to this change"');
    // and the creation commit's oid never appears as a prior target
    expect(html).not.toContain(`blame/commit/${born}/story.txt`);
    // the action row (blame.tmpl:19-27): Raw, Permalink (branch view), Normal
    // View, History
    expect(html).toContain('href="/alice/wave54blame/raw/branch/main/story.txt"');
    expect(html).toContain(`href="/alice/wave54blame/src/commit/${append}/story.txt"`);
    expect(html).toContain(">Permalink</a>");
    expect(html).toContain('href="/alice/wave54blame/src/branch/main/story.txt"');
    expect(html).toContain(">Normal View</a>");
    expect(html).toContain('href="/alice/wave54blame/commits?path=story.txt"');
    expect(html).toContain(">History</a>");
    // no truncated-walk notice on the ordinary chain
    expect(html).not.toContain("Line attribution covers the newest commits only");
  });

  it("renders through the commit-sha ref arm without the Permalink button", async () => {
    const [, , , append] = await tips();
    const res = await fetchUi(`/alice/wave54blame/blame/commit/${append}/story.txt`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("line two EDITED");
    // blame.tmpl:21-23: the Permalink button renders for branch/tag refs only
    expect(html).not.toContain(">Permalink</a>");
  });

  it("404-shells the empty tree path, a missing path, a binary file, and an unresolvable ref", async () => {
    const append = (await tips())[3];
    // blame.go:48-51's TreePath=="" arm (the bare-refType tail resolves, the
    // path is empty)
    expect((await fetchUi("/alice/wave54blame/blame/branch")).status).toBe(404);
    expect((await fetchUi("/alice/wave54blame/blame/branch/main")).status).toBe(404);
    expect((await fetchUi("/alice/wave54blame/blame/branch/main/gone.txt")).status).toBe(404);
    // a directory path and the binary file — the engine's null ladder
    expect((await fetchUi("/alice/wave54blame/blame/branch/main/docs")).status).toBe(404);
    expect((await fetchUi("/alice/wave54blame/blame/branch/main/logo.png")).status).toBe(404);
    // unresolvable ref
    expect((await fetchUi("/alice/wave54blame/blame/branch/nope/story.txt")).status).toBe(404);
    // a hex-shaped commit ref the engine cannot resolve
    expect((await fetchUi(`/alice/wave54blame/blame/commit/${"0".repeat(40)}/story.txt`)).status).toBe(404);
    void append;
  });

  it("hides a private repo behind the shared 404 shell", async () => {
    const db = drizzle(env.DB);
    const row = (
      await db
        .select()
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave54blame")))
        .get()
    )!;
    await db.update(repositories).set({ visibility: "private" }).where(eq(repositories.id, row.id));
    const res = await fetchUi("/alice/wave54blame/blame/branch/main/story.txt");
    expect(res.status).toBe(404);
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  });
});

// --- the census's file-view Blame anchor ------------------------------------------

describe("the file-view Blame anchor (view_file.tmpl:54, budget-gated)", () => {
  it("renders the Blame button between Raw and History on a blameable file view", async () => {
    const res = await fetchUi("/alice/wave54blame/src/branch/main/story.txt");
    expect(res.status).toBe(200);
    const html = await res.text();
    const rawIdx = html.indexOf(">Raw</a>");
    const blameIdx = html.indexOf(">Blame</a>");
    const historyIdx = html.indexOf(">History</a>");
    expect(blameIdx).toBeGreaterThan(rawIdx);
    expect(blameIdx).toBeLessThan(historyIdx);
    expect(html).toContain('<a class="ui mini basic button" href="/alice/wave54blame/blame/branch/main/story.txt">');
  });

  it("stays off the binary view and the over-MAX_BLAME_LINES view (no dead links)", async () => {
    const binary = await fetchUi("/alice/wave54blame/src/branch/main/logo.png");
    expect(binary.status).toBe(200);
    expect(await binary.text()).not.toContain(">Blame</a>");
    const big = await fetchUi("/alice/wave54blame/src/branch/main/big.txt");
    expect(big.status).toBe(200);
    expect(await big.text()).not.toContain(">Blame</a>");
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-54 a11y smoke", () => {
  it("the blame page passes the structural rules", async () => {
    const res = await fetchUi("/alice/wave54blame/blame/branch/main/story.txt");
    expect(res.status).toBe(200);
    const violations = runA11y(await res.text());
    expect(violations, JSON.stringify(violations)).toEqual([]);
  });
});
