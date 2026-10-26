/**
 * Component-level U3 render tests for the shapes a REAL pushed fixture
 * cannot cheaply reach (pages/pages.test.ts covers the real-content paths):
 * the §4.3 too-large prompt (decided from the tree entry's size BEFORE
 * readBlob), the §3.5 `.notready` degradation cells, the ENRICH_MAX RPC
 * budget, and the §4.4 home page without a README. Engine data comes from
 * synthetic EngineClient stubs; rendering via hono/jsx renderToString —
 * same harness as shell.test.tsx.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import type { EngineClient } from "../engine";
import { ENRICH_MAX } from "../page-data";
import type { RefsResult, TreeEntryJson, CommitJson } from "@cf-gitea/git-engine";
import { loadFileViewData, FileViewPage } from "./file-view";
import { loadHomeData, HomePage } from "./home";
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

/** Counting stub: records listLog path calls, serves canned answers. */
function stubEngine(overrides: Partial<EngineClient> = {}, onListLog?: (path: string | undefined) => void): EngineClient {
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
});

// --- §3.5 enrichment fallback ---------------------------------------------------

describe("§3.5 enrichment fallback (interim listLog path)", () => {
  it("renders .notready message cells without the data-fetch loader when enrichment fails", async () => {
    const engine = stubEngine({ listLog: () => Promise.resolve(null) });
    const data = await loadHomeData(engine, repo, ctx.origin);
    const html = renderToString(<HomePage ctx={ctx} data={data} />);
    expect(html).toContain('class="repo-file-cell message commit-summary notready"');
    expect(html).not.toContain("data-fetch-url");
    expect(html).not.toContain("data-fetch-trigger");
    // The latest-commit box still renders the ref tip.
    expect(html).toContain("head subject");
  });

  it("stops the per-entry listLog fan-out at ENRICH_MAX entries", async () => {
    const entries = Array.from({ length: ENRICH_MAX + 10 }, (_u, i) => entry(`file${i}.txt`));
    const logPaths: (string | undefined)[] = [];
    const engine = stubEngine(
      { listTree: () => Promise.resolve({ oid: "3".repeat(40), entries }) },
      (path) => logPaths.push(path),
    );
    const data = await loadHomeData(engine, repo, ctx.origin);
    expect(logPaths).toHaveLength(ENRICH_MAX);
    // Entries beyond the budget carry no commit → the notready cell.
    const html = renderToString(<HomePage ctx={ctx} data={data} />);
    expect(html.match(/notready/g)?.length).toBe(10);
  });

  it("prefixes sub-directory entry paths when enriching a nested listing", async () => {
    const logPaths: (string | undefined)[] = [];
    const engine = stubEngine(
      {
        listTree: (_ref, path) =>
          Promise.resolve({
            oid: "3".repeat(40),
            entries: path === "docs" ? [entry("guide.md")] : [entry("docs", { type: "tree", mode: "40000" })],
          }),
      },
      (path) => logPaths.push(path),
    );
    const data = await loadFileViewData(engine, repo, ctx.origin, "branch/main/docs");
    if (!("kind" in data) || data.kind !== "tree") throw new Error("expected tree data");
    expect(logPaths).toContain("docs/guide.md");
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
    expect(html).toContain('href="/api/v1/repos/octocat/hello/raw/huge.bin?ref=main"');
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
