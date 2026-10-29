/**
 * Component-level U3 render tests for the shapes a REAL pushed fixture
 * cannot cheaply reach (pages/pages.test.ts covers the real-content paths):
 * the §4.3 too-large prompt (decided from the tree entry's size BEFORE
 * readBlob), the §3.5 `.notready` degradation cells, the A10-L batched
 * `listTreeCommits` enrichment (ONE engine call replacing the per-entry fan,
 * with the per-path fallback semantics), and the §4.4 home page without a
 * README. Engine data comes from synthetic EngineClient stubs; rendering via
 * hono/jsx renderToString — same harness as shell.test.tsx.
 *
 * w129 additions (wave-polish-matrix-6, 2026-10-27) — the repo home's
 * quick-start/empty-state deepening, in the home describe + the new
 * resolveHeadBranch describe (still stub-driven, the file's harness): the
 * §4.1 empty-TREE arm (refs resolve, zero entries), the clone-command and
 * create-by-push hint shapes (both <pre> blocks verbatim, the default-branch
 * echo), and the §4.9 resolveHeadBranch fallback chain (head-wins, stale
 * HEAD, non-branch HEAD, tags carried, no-branches null) plus the home
 * README's 512KiB cap boundary (the file-view §4.3 cap's home twin).
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import type { EngineClient } from "../engine";
import { enrichTreeCommits, ENRICH_MAX } from "../page-data";
import type { RefsResult, TreeEntryJson, CommitJson } from "@cf-gitea/git-engine";
import { loadFileViewData, FileViewPage } from "./file-view";
import { loadHomeData, HomePage, resolveHeadBranch } from "./home";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";

// --- fixtures ----------------------------------------------------------------

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const ctx: UiContext = {
  viewer: { kind: "anonymous" } satisfies Viewer,
  origin: "https://test.local",
  assets: shellAssetsFromManifest(manifest),
  repo: {
    id: "r_1",
    storageKey: "r_1",
    ownerNamespace: "octocat",
    ownerId: 1,
    slug: "hello",
    visibility: "public",
    defaultBranch: "main",
    isEmpty: false,
    isArchived: false,
    status: "ready",
    refsVersion: 1,
    backend: "self-hosted",
    numIssues: 0,
    numClosedIssues: 0,
    numPulls: 0,
    numClosedPulls: 0,
    numMilestones: 0,
    closeIssuesViaCommitInAnyBranch: false,
    createdAt: new Date(1700000000 * 1000),
    updatedAt: null,
    forkParent: null,
    isMirror: false,
    originalUrl: null,
    isTemplate: false,
    sizeKb: 0,
    numStars: 0,
    numWatches: 0,
    numForks: 0,
  } satisfies RepoRow,
};

function makeCommit(subject: string, oid: string): CommitJson {
  return {
    oid,
    tree: "1".repeat(40),
    parents: [],
    author: { name: "Test User", email: "test@example.com", time: 1700000000, tz: "+0000" },
    committer: { name: "Test User", email: "test@example.com", time: 1700000000, tz: "+0000" },
    subject,
    message: `${subject}\n`,
  };
}

function entry(name: string, overrides: Partial<TreeEntryJson> = {}): TreeEntryJson {
  return { name, mode: "100644", type: "blob", oid: "2".repeat(40), size: 10, ...overrides };
}

const refsResult: RefsResult = {
  head: "refs/heads/main",
  refs: [{ name: "refs/heads/main", target: "a".repeat(40) }],
};

/** Counting stub: records listLog path + batch calls, serves canned answers.
 *  The base `listTreeCommits` answers every path with the head commit (the
 *  success posture); batch-count/degradation tests override it. */
function stubEngine(
  overrides: Partial<EngineClient> = {},
  onListLog?: (path: string | undefined) => void,
  onBatch?: (paths: string[]) => void,
): EngineClient {
  const headCommit = makeCommit("head subject", "a".repeat(40));
  return {
    listRefs: () => Promise.resolve(refsResult),
    readCommit: () => Promise.resolve(headCommit),
    listLog: (_ref, opts) => {
      onListLog?.(opts?.path);
      return Promise.resolve({ commits: [headCommit], more: false });
    },
    listTree: () =>
      Promise.resolve({
        oid: "3".repeat(40),
        entries: [entry("README.md", { size: 20 }), entry("app.ts", { size: 30 })],
      }),
    readBlob: (_ref, path) =>
      Promise.resolve({ oid: "2".repeat(40), mode: "100644", data: new TextEncoder().encode(`content of ${path}`) }),
    listTreeCommits: (_ref, paths) => {
      onBatch?.(paths);
      return Promise.resolve({ commits: paths.map(() => headCommit) });
    },
    blame: () => Promise.resolve(null),
    grep: () => Promise.resolve(null), // refused-work posture: pages that never search
    activityStats: () => Promise.resolve(null), // the unresolvable-ref ladder
    ...overrides,
  };
}

const repo = ctx.repo as RepoRow;

// --- home degradation paths ----------------------------------------------------

describe("loadHomeData + HomePage degradation paths", () => {
  it("omits the README section entirely when no README entry exists (§4.4)", async () => {
    const engine = stubEngine({
      listTree: () =>
        Promise.resolve({ oid: "3".repeat(40), entries: [entry("app.ts"), entry("docs", { type: "tree", mode: "40000" })] }),
    });
    const data = await loadHomeData(engine, repo, ctx.origin);
    expect(data.readme).toBeNull();
    const html = renderToString(<HomePage ctx={ctx} data={data} />);
    expect(html).toContain('id="repo-files-table"');
    expect(html).not.toContain('id="readme"');
    expect(html).not.toContain("file-view");
  });

  it("renders the empty-repo page for unborn HEAD (§4.1): no crash on readCommit(null)", async () => {
    const engine = stubEngine({ listRefs: () => Promise.resolve({ head: null, refs: [] }) });
    const data = await loadHomeData(engine, repo, ctx.origin);
    expect(data.isEmpty).toBe(true);
    const html = renderToString(<HomePage ctx={ctx} data={data} />);
    expect(html).toContain('class="page-content repository quickstart"');
    expect(html).toContain("https://test.local/octocat/hello.git");
    expect(html).not.toContain("repo-files-table");
  });

  it("prefers the D1 default branch over the first branch when HEAD is unborn (§4.9)", async () => {
    const engine = stubEngine({
      listRefs: () =>
        Promise.resolve({
          head: null,
          refs: [
            { name: "refs/heads/develop", target: "b".repeat(40) },
            { name: "refs/heads/main", target: "a".repeat(40) },
          ],
        }),
    });
    const data = await loadHomeData(engine, repo, ctx.origin);
    expect(data.refs.headBranch).toBe("main");
  });

  it("degrades the empty TREE to the quick-start render with the refs intact (§4.1's zero-entries arm)", async () => {
    // Provenance: wave-polish-matrix-6 — the sibling of the unborn-HEAD arm
    // above: listRefs resolves a real HEAD but listTree answers zero entries
    // (an initialized repo with no files), loadHomeData returns the empty
    // shape WITH the resolved refs and the page renders the quick start.
    let commitCalls = 0;
    const engine = stubEngine({
      listTree: () => Promise.resolve({ oid: "3".repeat(40), entries: [] }),
      readCommit: () => {
        commitCalls++;
        return Promise.resolve(makeCommit("head subject", "a".repeat(40)));
      },
    });
    const data = await loadHomeData(engine, repo, ctx.origin);
    expect(data.isEmpty).toBe(true);
    expect(data.refs.headBranch).toBe("main"); // the refs survive the empty tree
    expect(data.entries).toEqual([]);
    expect(data.latestCommit).toBeNull(); // the empty shape wins over the read commit
    const html = renderToString(<HomePage ctx={ctx} data={data} />);
    expect(html).toContain('class="page-content repository quickstart"');
    expect(html).toContain("https://test.local/octocat/hello.git");
    expect(html).not.toContain("repo-files-table");
    // The read commit raced the tree read (Promise.all) but its subject
    // never renders — the empty-repo page replaces the whole body.
    expect(commitCalls).toBe(1);
    expect(html).not.toContain("head subject");
  });

  it("renders both quick-start command blocks verbatim with the clone URL and the push hint (the §4.1 shapes)", async () => {
    // Provenance: wave-polish-matrix-6 — the unborn arm above pins only the
    // clone URL; the two command <pre> blocks' shapes (the create-from-
    // scratch recipe and the push-existing hint) were unpinned.
    const engine = stubEngine({ listRefs: () => Promise.resolve({ head: null, refs: [] }) });
    const data = await loadHomeData(engine, repo, ctx.origin);
    const html = renderToString(<HomePage ctx={ctx} data={data} />);
    // The headline + the two block headers (upstream repo/empty.tmpl's
    // analog shapes).
    expect(html).toContain("This repository is empty. Push to create it");
    expect(html).toContain("Create a new repository on the command line");
    expect(html).toContain("Push an existing repository");
    // The create-from-scratch recipe: the full sequence with the origin
    // clone URL and the default-branch push hint.
    expect(html).toContain("touch README.md");
    expect(html).toContain("git init");
    expect(html).toContain("git add .");
    // The commit subject's quotes are HTML-escaped in the pre text (hono/jsx).
    expect(html).toContain("git commit -m &quot;first commit&quot;");
    expect(html).toContain("git remote add origin https://test.local/octocat/hello.git");
    expect(html).toContain("git push -u origin main");
    // The push-existing hint is the remote+push pair only (no init recipe).
    expect(html.match(/git remote add origin https:\/\/test\.local\/octocat\/hello\.git/g)?.length).toBe(2);
    expect(html.match(/git push -u origin main/g)?.length).toBe(2);
  });

  it("echoes the repo's D1 default branch in the push hint, not a hardcoded main", async () => {
    // Provenance: wave-polish-matrix-6 — the push hint's branch token rides
    // repo.defaultBranch (EmptyRepoPage's template literal); pinned with a
    // non-main default so a hardcoded "main" would fail.
    const trunkCtx: UiContext = { ...ctx, repo: { ...repo, defaultBranch: "trunk" } };
    const engine = stubEngine({ listRefs: () => Promise.resolve({ head: null, refs: [] }) });
    const data = await loadHomeData(engine, trunkCtx.repo as RepoRow, ctx.origin);
    const html = renderToString(<HomePage ctx={trunkCtx} data={data} />);
    expect(html).toContain("git push -u origin trunk");
    expect(html).not.toContain("git push -u origin main");
  });

  it("skips the README when the entry exceeds the 512KiB cap and never calls readBlob (the home twin of §4.3)", async () => {
    // Provenance: wave-polish-matrix-6 — loadHomeData's size gate
    // (`(readmeEntry.size ?? 0) <= 512 * 1024`) decides BEFORE readBlob like
    // file view's §4.3 prompt; the home arm was unpinned at both boundary
    // sides.
    let blobCalls = 0;
    const engine = stubEngine({
      listTree: () =>
        Promise.resolve({ oid: "3".repeat(40), entries: [entry("README.md", { size: 512 * 1024 + 1 })] }),
      readBlob: () => {
        blobCalls++;
        return Promise.resolve({ oid: "2".repeat(40), mode: "100644", data: new Uint8Array([1]) });
      },
    });
    const data = await loadHomeData(engine, repo, ctx.origin);
    expect(data.readme).toBeNull();
    expect(blobCalls).toBe(0);
    const html = renderToString(<HomePage ctx={ctx} data={data} />);
    expect(html).toContain('id="repo-files-table"'); // the listing still renders
    expect(html).not.toContain('id="readme"');
  });

  it("admits a README at exactly the 512KiB cap (the boundary's other side)", async () => {
    const engine = stubEngine({
      listTree: () => Promise.resolve({ oid: "3".repeat(40), entries: [entry("README.md", { size: 512 * 1024 })] }),
    });
    const data = await loadHomeData(engine, repo, ctx.origin);
    expect(data.readme).not.toBeNull();
    expect(data.readme?.variant).toBe("markup"); // the stub's markdown body renders
  });
});

// --- §4.9 resolveHeadBranch (the default-branch fallback chain) -------------------

describe("resolveHeadBranch (the §4.9 fallback chain, pure)", () => {
  it("the DO's HEAD wins when it names an existing branch", () => {
    // Provenance: wave-polish-matrix-6 — the chain's FIRST arm was only
    // exercised transitively (refsResult's head=main + defaultBranch=main
    // agree); the head-over-default precedence is pinned directly.
    const resolved = resolveHeadBranch(
      {
        head: "refs/heads/develop",
        refs: [
          { name: "refs/heads/main", target: "a".repeat(40) },
          { name: "refs/heads/develop", target: "b".repeat(40) },
        ],
      },
      "main",
    );
    expect(resolved.headBranch).toBe("develop");
    // branches split in the refs' own order (main first here).
    expect(resolved.branches).toEqual(["main", "develop"]);
  });

  it("a STALE HEAD (naming a deleted branch) falls to the D1 default branch, then the first branch", () => {
    // Provenance: wave-polish-matrix-6 — the stale-HEAD arm (head startsWith
    // refs/heads/ but the branch is gone) and the default-branch-missing
    // second fallback were unpinned.
    const stale = resolveHeadBranch(
      {
        head: "refs/heads/gone",
        refs: [
          { name: "refs/heads/main", target: "a".repeat(40) },
          { name: "refs/heads/develop", target: "b".repeat(40) },
        ],
      },
      "main",
    );
    expect(stale.headBranch).toBe("main");
    const noDefault = resolveHeadBranch(
      {
        head: "refs/heads/gone",
        refs: [
          { name: "refs/heads/topic", target: "c".repeat(40) },
          { name: "refs/heads/develop", target: "b".repeat(40) },
        ],
      },
      "trunk", // not among the branches → the first branch wins
    );
    expect(noDefault.headBranch).toBe("topic");
  });

  it("a non-branch HEAD (a tag) is ignored; branches and tags split correctly; no branches at all resolves null", () => {
    // Provenance: wave-polish-matrix-6 — the non-refs/heads HEAD arm and the
    // no-branches null (unborn) with tags-only refs were unpinned.
    const tagged = resolveHeadBranch(
      {
        head: "refs/tags/v1",
        refs: [
          { name: "refs/heads/main", target: "a".repeat(40) },
          { name: "refs/tags/v1", target: "d".repeat(40) },
        ],
      },
      "main",
    );
    expect(tagged.headBranch).toBe("main");
    expect(tagged.tags).toEqual(["v1"]);
    expect(tagged.branches).toEqual(["main"]);

    const unborn = resolveHeadBranch(
      { head: "refs/heads/main", refs: [{ name: "refs/tags/v1", target: "d".repeat(40) }] },
      "main",
    );
    expect(unborn.headBranch).toBeNull();
    expect(unborn.tags).toEqual(["v1"]);
    expect(unborn.branches).toEqual([]);
  });
});

// --- §3.5 enrichment (the A10-L batched listTreeCommits RPC) ---------------------

describe("§3.5 enrichment (A10-L: one batched RPC, per-path fallback)", () => {
  it("pays exactly ONE engine call replacing the per-entry listLog fan (the A10-L witness)", async () => {
    // The audit A10-L acceptance: the repo-home enrichment that parallel-fanned
    // up to ENRICH_MAX listLog RPCs per view now issues ONE listTreeCommits
    // call — and ZERO listLog calls when the batch answers every entry.
    const batchCalls: string[][] = [];
    let logCalls = 0;
    const entries = [
      entry("README.md", { size: 20 }),
      entry("app.ts", { size: 30 }),
      entry("docs", { type: "tree", mode: "40000" }),
    ];
    const engine = stubEngine({
      listTree: () => Promise.resolve({ oid: "3".repeat(40), entries }),
      listTreeCommits: (_ref, paths) => {
        batchCalls.push([...paths]);
        return Promise.resolve({ commits: paths.map(() => makeCommit("batch subject", "b".repeat(40))) });
      },
      listLog: () => {
        logCalls++;
        return Promise.resolve(null);
      },
    });
    const data = await loadHomeData(engine, repo, ctx.origin);
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual(["README.md", "app.ts", "docs"]); // entry-order root paths
    expect(logCalls).toBe(0); // the fan is gone on the answered path
    const html = renderToString(<HomePage ctx={ctx} data={data} />);
    expect(html).toContain("batch subject");
  });

  it("degrades to the §3.5 notready cell — batch null slots AND batch unavailability alike", async () => {
    // (a) the batch ANSWERS with null slots (the engine's per-path empty-page
    //     answer for a path no commit touched within its walk budget)
    const engineA = stubEngine({
      listTreeCommits: (_ref, paths) => Promise.resolve({ commits: paths.map(() => null) }),
    });
    const dataA = await loadHomeData(engineA, repo, ctx.origin);
    const htmlA = renderToString(<HomePage ctx={ctx} data={dataA} />);
    expect(htmlA).toContain('class="repo-file-cell message commit-summary notready"');
    expect(htmlA).not.toContain("data-fetch-url");
    // (b) the batch is unavailable (old boundary / transport null) — the
    //     documented interim per-path fan answers instead, failing per entry
    //     into the same cells; the latest-commit box still renders the tip
    const engineB = stubEngine({
      listTreeCommits: () => Promise.resolve(null),
      listLog: () => Promise.resolve(null),
    });
    const dataB = await loadHomeData(engineB, repo, ctx.origin);
    const htmlB = renderToString(<HomePage ctx={ctx} data={dataB} />);
    expect(htmlB).toContain('class="repo-file-cell message commit-summary notready"');
    expect(htmlB).not.toContain("data-fetch-url");
    expect(htmlB).not.toContain("data-fetch-trigger");
    expect(htmlB).toContain("head subject");
  });

  it("caps the ONE batch call at ENRICH_MAX paths; beyond-budget entries render notready", async () => {
    const entries = Array.from({ length: ENRICH_MAX + 10 }, (_u, i) => entry(`file${i}.txt`));
    const batchPaths: string[][] = [];
    const engine = stubEngine({
      listTree: () => Promise.resolve({ oid: "3".repeat(40), entries }),
      listTreeCommits: (_ref, paths) => {
        batchPaths.push([...paths]);
        return Promise.resolve({ commits: paths.map(() => makeCommit("batch subject", "b".repeat(40))) });
      },
    });
    const data = await loadHomeData(engine, repo, ctx.origin);
    expect(batchPaths).toHaveLength(1);
    expect(batchPaths[0]).toHaveLength(ENRICH_MAX); // the budget bounds the RPC's paths, not the page
    const html = renderToString(<HomePage ctx={ctx} data={data} />);
    expect(html.match(/notready/g)?.length).toBe(10);
  });

  it("when the batch is unavailable, the interim per-path fan still stops at ENRICH_MAX", async () => {
    // The documented fallback keeps its old budget discipline (§3.2's
    // subrequest bound applies to the degraded posture too).
    const entries = Array.from({ length: ENRICH_MAX + 10 }, (_u, i) => entry(`file${i}.txt`));
    const logPaths: (string | undefined)[] = [];
    const engine = stubEngine(
      {
        listTree: () => Promise.resolve({ oid: "3".repeat(40), entries }),
        listTreeCommits: () => Promise.resolve(null),
      },
      (path) => logPaths.push(path),
    );
    const data = await loadHomeData(engine, repo, ctx.origin);
    expect(logPaths).toHaveLength(ENRICH_MAX);
    const html = renderToString(<HomePage ctx={ctx} data={data} />);
    expect(html.match(/notready/g)?.length).toBe(10);
  });

  it("a batch index gap falls back to exactly the missed entries' own listLog calls", async () => {
    // The engine always covers the whole input today, but the contract keeps
    // the per-path fallback for any slot the batch leaves unanswered.
    const c1 = makeCommit("one", "1".repeat(40));
    const c2 = makeCommit("two", "2".repeat(40));
    const entries = [entry("one.txt"), entry("two.txt"), entry("three.txt")];
    const logCalls: string[] = [];
    const engine = stubEngine({
      listTreeCommits: () => Promise.resolve({ commits: [c1, c2] }), // slot 2 missing
      listLog: (_ref, opts) => {
        logCalls.push(opts?.path ?? "");
        return Promise.resolve({ commits: [makeCommit("three", "3".repeat(40))], more: false });
      },
    });
    const commits = await enrichTreeCommits(engine, "main", entries, (e) => e.name);
    expect(logCalls).toEqual(["three.txt"]); // exactly the missed entry fanned
    expect(commits.get("one.txt")?.oid).toBe(c1.oid);
    expect(commits.get("two.txt")?.oid).toBe(c2.oid);
    expect(commits.get("three.txt")?.subject).toBe("three");
  });

  it("a throwing batch degrades to the fan; a throwing per-path entry degrades to null", async () => {
    // Same null-degrade semantics as the interim path: never a rejection, so
    // one failed entry cannot sink the page.
    const entries = [entry("ok.txt"), entry("bad.txt")];
    const engine = stubEngine({
      listTreeCommits: () => Promise.reject(new Error("transport")),
      listLog: (_ref, opts) =>
        opts?.path === "bad.txt"
          ? Promise.reject(new Error("entry transport"))
          : Promise.resolve({ commits: [makeCommit("ok", "4".repeat(40))], more: false }),
    });
    const commits = await enrichTreeCommits(engine, "main", entries, (e) => e.name);
    expect(commits.get("ok.txt")?.subject).toBe("ok");
    expect(commits.get("bad.txt")).toBeNull();
  });

  it("prefixes sub-directory entry paths in the batch call for a nested listing", async () => {
    const batchPaths: string[][] = [];
    const engine = stubEngine({
      listTree: (_ref, path) =>
        Promise.resolve({
          oid: "3".repeat(40),
          entries: path === "docs" ? [entry("guide.md")] : [entry("docs", { type: "tree", mode: "40000" })],
        }),
      listTreeCommits: (_ref, paths) => {
        batchPaths.push([...paths]);
        return Promise.resolve({ commits: paths.map(() => makeCommit("batch subject", "b".repeat(40))) });
      },
    });
    const data = await loadFileViewData(engine, repo, ctx.origin, "branch/main/docs");
    if (!("kind" in data) || data.kind !== "tree") throw new Error("expected tree data");
    expect(batchPaths).toHaveLength(1);
    expect(batchPaths[0]).toEqual(["docs/guide.md"]);
    expect(data.dirPath).toBe("docs");
  });
});

// --- §4.3 size cap ----------------------------------------------------------------

describe("file view §4.3 display cap", () => {
  it("renders the too-large prompt from the tree size and never calls readBlob", async () => {
    let blobCalls = 0;
    const engine = stubEngine(
      {
        listTree: () =>
          Promise.resolve({
            oid: "3".repeat(40),
            entries: [entry("huge.bin", { size: 8_388_609 })],
          }),
        readBlob: () => {
          blobCalls++;
          return Promise.resolve(null);
        },
      },
    );
    const data = await loadFileViewData(engine, repo, ctx.origin, "branch/main/huge.bin");
    if (!("kind" in data) || data.kind !== "blob") throw new Error("expected blob data");
    expect(data.variant).toBe("too-large");
    expect(blobCalls).toBe(0);
    const html = renderToString(<FileViewPage ctx={ctx} data={data} />);
    expect(html).toContain("file-not-rendered-prompt");
    expect(html).toContain("The file is too large to be shown.");
    expect(html).toContain('href="/octocat/hello/raw/branch/main/huge.bin"');
  });

  it("renders an unknown-extension binary as the View Raw prompt", async () => {
    const engine = stubEngine({
      listTree: () => Promise.resolve({ oid: "3".repeat(40), entries: [entry("blob.bin", { size: 4 })] }),
      readBlob: () => Promise.resolve({ oid: "2".repeat(40), mode: "100644", data: new Uint8Array([0, 1, 2, 3]) }),
    });
    const data = await loadFileViewData(engine, repo, ctx.origin, "branch/main/blob.bin");
    if (!("kind" in data) || data.kind !== "blob") throw new Error("expected blob data");
    expect(data.variant).toBe("view-raw");
    const html = renderToString(<FileViewPage ctx={ctx} data={data} />);
    expect(html).toContain('<div class="view-raw">');
    expect(html).toContain("View Raw");
  });

  it("404s the notFound union for a missing path", async () => {
    const engine = stubEngine({ listTree: () => Promise.resolve({ oid: "3".repeat(40), entries: [] }) });
    const data = await loadFileViewData(engine, repo, ctx.origin, "branch/main/gone.txt");
    expect("notFound" in data).toBe(true);
  });
});
