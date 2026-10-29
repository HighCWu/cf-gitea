/**
 * The lastcommit fragment tests (pages-wave43 fixture discipline): REAL
 * pushed engine content — `ensureSeededRepo` pushes the packs through the
 * landed receive flow — driving the loader + builder DIRECTLY (the route
 * arm is index-owned, a later index.ts window; the handoff note in the
 * module doc carries the mapping).
 *
 * The fixture history gives every row a DIFFERENT last commit (commit 3
 * touches app.ts, commit 2 the README, commit 1 everything else), which is
 * the whole point of the per-entry commit-info loader: the batched walk must
 * attribute each path to its own newest commit, not the tip.
 *
 * The A10-L adoption witness arm (the final describe) is stub-driven — the
 * render.test.tsx A10-L block's harness — because the real fixture cannot
 * observe RPC counts: it pins ONE listTreeCommits replacing the per-path
 * listLog fan (logCalls 0 in the common case), the treePath slot riding
 * paths[0], and the degrade semantics (null/unavailable/throwing batches
 * fall back to the legacy fan; index gaps ride their own listLog; identical
 * rows either way).
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { CommitJson, TreeEntryJson } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import type { EngineClient } from "../engine";
import { ENRICH_MAX } from "../page-data";
import {
  lastCommitFragmentHtml,
  lastCommitFragmentResponse,
  loadLastCommitFragment,
  loadLastCommitFragmentFrom,
  parseLastCommitTail,
  parseRefSubUrl,
  type LastCommitFragmentData,
} from "./repo-lastcommit-fragment";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z

const README_V1 = "# frag one\n";
const README_V2 = "# frag two\n";
const APP_V1 = "export const a = 1;\n";
const APP_V2 = "export const a = 2;\n";
const GUIDE = "# Guide\n";

/** Every commit carries the full tree (the seed builder's shape): commit 1
 *  seeds everything, commit 2 touches ONLY the README, commit 3 ONLY app.ts
 *  — so the tip listing must attribute README.md → commit 2, app.ts →
 *  commit 3, everything else → commit 1. The item-*.txt names exercise the
 *  NaturalSortCompare port (2 before 10) and README.md sorts before the
 *  item files by code point ('R' < 'i'). */
const FRAG_COMMITS: SeedCommit[] = [
  {
    message: "seed the tree",
    time: T0,
    files: [
      { path: "README.md", content: README_V1 },
      { path: "app.ts", content: APP_V1 },
      { path: "docs/guide.md", content: GUIDE },
      { path: "item-1.txt", content: "one\n" },
      { path: "item-2.txt", content: "two\n" },
      { path: "item-10.txt", content: "ten\n" },
    ],
  },
  {
    message: "touch the README only",
    time: T0 + 120,
    files: [
      { path: "README.md", content: README_V2 },
      { path: "app.ts", content: APP_V1 },
      { path: "docs/guide.md", content: GUIDE },
      { path: "item-1.txt", content: "one\n" },
      { path: "item-2.txt", content: "two\n" },
      { path: "item-10.txt", content: "ten\n" },
    ],
  },
  {
    message: "touch the app only",
    time: T0 + 240,
    files: [
      { path: "README.md", content: README_V2 },
      { path: "app.ts", content: APP_V2 },
      { path: "docs/guide.md", content: GUIDE },
      { path: "item-1.txt", content: "one\n" },
      { path: "item-2.txt", content: "two\n" },
      { path: "item-10.txt", content: "ten\n" },
    ],
  },
];

/** 32 single-commit files: entries 31..32 of the root listing fall past the
 *  shared ENRICH_MAX budget and must come back `.notready` (no RPC). */
const WIDE_COMMITS: SeedCommit[] = [
  {
    message: "wide tree",
    time: T0,
    files: Array.from({ length: 32 }, (_unused, i) => ({
      path: `f-${String(i).padStart(2, "0")}.txt`,
      content: `file ${i}\n`,
    })),
  },
];

let fragTips: string[] = [];
let wideTips: string[] = [];

const FRAG_REPO = { ownerNamespace: "alice", slug: "lastcommit-frag", isEmpty: false, defaultBranch: "main" };
const WIDE_REPO = { ownerNamespace: "alice", slug: "lastcommit-wide", isEmpty: false, defaultBranch: "main" };

beforeAll(async () => {
  await applyAuthD1Migrations(); // the push-create flow needs the users/tokens tables
  fragTips = (await ensureSeededRepo({ owner: "alice", slug: "lastcommit-frag", commits: FRAG_COMMITS })).tips;
  wideTips = (await ensureSeededRepo({ owner: "alice", slug: "lastcommit-wide", commits: WIDE_COMMITS })).tips;
});

/** Guard helper (the index.test.ts seed style — no non-null assertions). */
function expectData(data: LastCommitFragmentData | null): LastCommitFragmentData {
  if (data === null) throw new Error("loader returned null where content was expected");
  return data;
}

// --- the loader (GetCommitsInfo port) ----------------------------------------

describe("loadLastCommitFragment", () => {
  it("attributes each entry to its own last commit, dirs first then natural order", async () => {
    const tip = fragTips[fragTips.length - 1] as string;
    const data = expectData(await loadLastCommitFragment(env, FRAG_REPO, tip, "", "branch/main"));

    // treeLastCommit for the root listing is the commit itself
    // (commit_info.go:104-107's `util.Iif(treePath == "", commit, revs[""])`).
    expect(data.treeLastCommit?.oid).toBe(tip);
    expect(data.commit.oid).toBe(tip);
    expect(data.treePath).toBe("");

    expect(
      data.rows.map((row) => [row.entry.name, row.commit?.oid] as const),
    ).toEqual([
      ["docs", fragTips[0]], // the dir's tree never changed after commit 1
      ["README.md", fragTips[1]], // commit 2 ("touch the README only")
      ["app.ts", fragTips[2]], // commit 3 ("touch the app only")
      ["item-1.txt", fragTips[0]],
      ["item-2.txt", fragTips[0]],
      ["item-10.txt", fragTips[0]],
    ]);
  });

  it("sorts a sub-directory listing with the treePath's own last commit first in the batch", async () => {
    const tip = fragTips[fragTips.length - 1] as string;
    const data = expectData(await loadLastCommitFragment(env, FRAG_REPO, tip, "docs", "branch/main"));

    // The "docs" path itself was last touched by commit 1 (its subtree oid
    // froze when guide.md stopped changing) — the walk's slot 0.
    expect(data.treeLastCommit?.oid).toBe(fragTips[0]);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.entry.name).toBe("guide.md");
    expect(data.rows[0]?.commit?.oid).toBe(fragTips[0]);
  });

  it("404s the family: unknown sha, short sha, missing treePath, empty repo", async () => {
    // A well-formed oid the engine cannot resolve (readCommit's null).
    expect(await loadLastCommitFragment(env, FRAG_REPO, "f".repeat(40), "", "branch/main")).toBeNull();
    // The short-prefix arm: upstream's shape admits 7..64 hex, the engine
    // resolves full oids only (the landed full-oid divergence).
    const tip = fragTips[fragTips.length - 1] as string;
    expect(await loadLastCommitFragment(env, FRAG_REPO, tip.slice(0, 7), "", "branch/main")).toBeNull();
    // A treePath that resolves to nothing (HandleGitError's 404 arm).
    expect(await loadLastCommitFragment(env, FRAG_REPO, tip, "nope", "branch/main")).toBeNull();
    // The empty-repo gate (RepoRefByType's early return).
    expect(
      await loadLastCommitFragment(env, { ...FRAG_REPO, isEmpty: true }, tip, "", "branch/main"),
    ).toBeNull();
  });

  it("keeps past-budget entries as notready rows without engine calls", async () => {
    const tip = wideTips[wideTips.length - 1] as string;
    const data = expectData(await loadLastCommitFragment(env, WIDE_REPO, tip, "", "branch/main"));

    expect(data.rows).toHaveLength(32);
    for (const row of data.rows.slice(0, 30)) expect(row.commit?.oid).toBe(tip);
    for (const row of data.rows.slice(30)) expect(row.commit).toBeNull(); // f-30, f-31
    expect(data.rows[29]?.entry.name).toBe("f-29.txt");
    expect(data.rows[30]?.entry.name).toBe("f-30.txt");
  });
});

// --- refSubUrl (view.go:236-243) ----------------------------------------------

describe("parseRefSubUrl", () => {
  it("parses the branch/tag/commit shapes and falls back to the commit context", () => {
    const sha = "a".repeat(40);
    expect(parseRefSubUrl("branch/main", sha)).toEqual({ refType: "branch", ref: "main" });
    expect(parseRefSubUrl("branch/feature/foo", sha)).toEqual({ refType: "branch", ref: "feature/foo" });
    expect(parseRefSubUrl("tag/v1.0", sha)).toEqual({ refType: "tag", ref: "v1.0" });
    expect(parseRefSubUrl(`commit/${sha}`, "b".repeat(40))).toEqual({ refType: "commit", ref: sha });
    // The degenerate arms (module doc): upstream emits the cleaned string
    // verbatim ("/src/." et al.) — the port falls back to the path commit.
    expect(parseRefSubUrl("", sha)).toEqual({ refType: "commit", ref: sha });
    expect(parseRefSubUrl(".", sha)).toEqual({ refType: "commit", ref: sha });
    expect(parseRefSubUrl("nonsense", sha)).toEqual({ refType: "commit", ref: sha });
    expect(parseRefSubUrl("branch/", sha)).toEqual({ refType: "commit", ref: sha });
  });
});

describe("parseLastCommitTail", () => {
  it("splits the hex first segment from the treePath, else misses", () => {
    const sha = "c0ffee0123456789abcdef0123456789abcdef01";
    expect(parseLastCommitTail(`${sha}/docs/guide.md`)).toEqual({ commitRef: sha, treePath: "docs/guide.md" });
    expect(parseLastCommitTail(sha)).toEqual({ commitRef: sha, treePath: "" });
    expect(parseLastCommitTail(`HEAD/docs`)).toBeNull(); // the landed commit-arm convention
    expect(parseLastCommitTail("zzz/file.txt")).toBeNull();
    expect(parseLastCommitTail("abc")).toBeNull(); // 3 hex < the 7-shape floor
  });
});

// --- the fragment bytes (view_list.tmpl) ---------------------------------------

describe("lastCommitFragmentHtml + lastCommitFragmentResponse", () => {
  it("renders the standalone #repo-files-table with the header box, no loader attrs", async () => {
    const tip = fragTips[fragTips.length - 1] as string;
    const data = expectData(await loadLastCommitFragment(env, FRAG_REPO, tip, "", "branch/main"));
    const html = lastCommitFragmentHtml(data, "/alice/lastcommit-frag");

    // Standalone fragment: the template element only, no doctype/layout.
    expect(html.startsWith('<div id="repo-files-table">')).toBe(true);
    expect(html).not.toContain("<!DOCTYPE");
    expect(html.endsWith("</div>")).toBe(true);

    // The last-commit header row: the treeLastCommit's subject + TimeSince.
    expect(html).toContain('<div class="repo-file-line repo-file-last-commit">');
    expect(html).toContain("touch the app only");
    expect(html).toContain('<div class="latest-commit">');
    expect(html).toContain('<relative-time prefix="" tense="past" datetime="2023-11-14T22:17:20Z"');

    // The landed §3.5 contract: no data-fetch attributes even though the
    // fragment is the loader's own answer (the module doc's flip note).
    expect(html).not.toContain("data-fetch-url");

    // Six rows: dirs-first natural order, per-entry commit links + ages.
    const names = [...html.matchAll(/class="entry-name" href="([^"]*)"[^>]*>([^<]+)</g)].map((m) => m[2]);
    expect(names).toEqual(["docs", "README.md", "app.ts", "item-1.txt", "item-2.txt", "item-10.txt"]);
    expect(html).toContain('<a href="/alice/lastcommit-frag/commit/');
    expect(html).toContain("touch the README only");
    expect(html).toContain('<div class="repo-file-cell name muted-links">');
    expect(html).toContain('<div class="repo-file-cell message commit-summary">');
    expect(html).toContain('<div class="repo-file-cell age">');
    expect(html).not.toContain("notready");
  });

  it("carries the refSubUrl link context and the parent row on sub-directory listings", async () => {
    const tip = fragTips[fragTips.length - 1] as string;
    const data = expectData(await loadLastCommitFragment(env, FRAG_REPO, tip, "docs", "branch/main"));
    const html = lastCommitFragmentHtml(data, "/alice/lastcommit-frag");

    // HasParentPath's row — href = BranchLink for a top-level directory
    // (upstream's ParentPath is unset there, view_home.go:414-417).
    expect(html).toContain('<a class="repo-file-line parent-link silenced" href="/alice/lastcommit-frag/src/branch/main">');
    // Entry links under TreeLink.
    expect(html).toContain(
      '<a class="entry-name" href="/alice/lastcommit-frag/src/branch/main/docs/guide.md" title="guide.md">guide.md</a>',
    );
    // The row's commit message links through the /commit family.
    expect(html).toContain('<a href="/alice/lastcommit-frag/commit/');
    expect(html).toContain("seed the tree");
  });

  it("renders the commit-sha link context from the refSubUrl value", async () => {
    const tip = fragTips[fragTips.length - 1] as string;
    const data = expectData(await loadLastCommitFragment(env, FRAG_REPO, tip, "", `commit/${tip}`));
    const html = lastCommitFragmentHtml(data, "/alice/lastcommit-frag");
    expect(html).toContain(`href="/alice/lastcommit-frag/src/commit/${tip}/README.md"`);
  });

  it("marks past-budget rows with the muted notready cell (no loader attrs)", async () => {
    const tip = wideTips[wideTips.length - 1] as string;
    const data = expectData(await loadLastCommitFragment(env, WIDE_REPO, tip, "", "branch/main"));
    const html = lastCommitFragmentHtml(data, "/alice/lastcommit-wide");

    const items = html.match(/<div class="repo-file-item">/g) ?? [];
    expect(items).toHaveLength(32);
    expect(html.match(/notready/g)).toHaveLength(2); // f-30, f-31 past ENRICH_MAX
    expect(html).toContain('<div class="repo-file-cell message commit-summary notready">');
    expect(html).not.toContain("data-fetch-url");
  });

  it("answers the ctx.HTML content type + the web middleware cache stamp", async () => {
    const tip = fragTips[fragTips.length - 1] as string;
    const data = expectData(await loadLastCommitFragment(env, FRAG_REPO, tip, "", "branch/main"));
    const res = lastCommitFragmentResponse(lastCommitFragmentHtml(data, "/alice/lastcommit-frag"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
  });
});

// --- the A10-L adoption witness (stub-driven, the render.test.tsx harness) -----

/**
 * The fragment loader's A10-L witness — render.test.tsx's A10-L block twin on
 * the fragment seam (`loadLastCommitFragmentFrom` + counting EngineClient
 * stubs): the per-path listLog fan is GONE in the common case (ONE
 * listTreeCommits carrying the ENRICH_MAX path set, treePath slot first),
 * and the degrade semantics match the established consumer (page-data.ts
 * enrichTreeCommits) exactly. The real-fixture describes above prove the
 * rendered output is unchanged end to end; these pins prove the RPC shape.
 */

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

/** Counting stub client (render.test.tsx's stubEngine shape): records listLog
 *  paths + batch path sets, serves canned answers. The base `listTreeCommits`
 *  answers every path with the batch commit (the success posture); the
 *  degradation tests override it. */
function stubClient(
  overrides: Partial<EngineClient> = {},
  onListLog?: (path: string | undefined) => void,
  onBatch?: (paths: string[]) => void,
): EngineClient {
  const head = makeCommit("head subject", "a".repeat(40));
  const batchCommit = makeCommit("batch subject", "b".repeat(40));
  return {
    listRefs: () => Promise.resolve({ head: "refs/heads/main", refs: [] }),
    readCommit: () => Promise.resolve(head),
    listLog: (_ref, opts) => {
      onListLog?.(opts?.path);
      return Promise.resolve({ commits: [head], more: false });
    },
    listTree: (_ref, path) =>
      Promise.resolve({
        oid: "3".repeat(40),
        entries: path === "docs" ? [entry("guide.md")] : [entry("README.md", { size: 20 }), entry("app.ts", { size: 30 })],
      }),
    readBlob: () => Promise.resolve(null),
    listTreeCommits: (_ref, paths) => {
      onBatch?.(paths ?? []);
      return Promise.resolve({ commits: (paths ?? []).map(() => batchCommit) });
    },
    blame: () => Promise.resolve(null),
    grep: () => Promise.resolve(null), // refused-work posture: pages that never search
    activityStats: () => Promise.resolve(null), // the unresolvable-ref ladder
    ...overrides,
  };
}

function rowSummary(data: LastCommitFragmentData): [string, string | null][] {
  return data.rows.map((row) => [row.entry.name, row.commit?.oid ?? null]);
}

describe("loadLastCommitFragmentFrom — the A10-L adoption witness", () => {
  it("pays exactly ONE listTreeCommits and ZERO listLog when the batch answers (the A10-L witness)", async () => {
    const batchCalls: string[][] = [];
    const logPaths: (string | undefined)[] = [];
    const engine = stubClient(
      {
        listTreeCommits: (_ref, paths) => {
          batchCalls.push([...(paths ?? [])]);
          return Promise.resolve({ commits: (paths ?? []).map(() => makeCommit("batch subject", "b".repeat(40))) });
        },
        listLog: (_ref, opts) => {
          logPaths.push(opts?.path);
          return Promise.resolve(null);
        },
      },
    );
    const data = expectData(await loadLastCommitFragmentFrom(engine, FRAG_REPO, "a".repeat(40), "", "branch/main"));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual(["README.md", "app.ts"]); // entry-order root paths
    expect(logPaths).toHaveLength(0); // the fan is gone on the answered path
    // Identical rendered posture: rows carry the batch's commits, the root
    // listing's header box still the read commit itself.
    const html = lastCommitFragmentHtml(data, "/alice/lastcommit-frag");
    expect(html).toContain("batch subject");
    expect(html).toContain("head subject");
    expect(rowSummary(data)).toEqual([
      ["README.md", "b".repeat(40)],
      ["app.ts", "b".repeat(40)],
    ]);
    expect(data.treeLastCommit?.oid).toBe("a".repeat(40));
  });

  it("carries the treePath slot FIRST in the batch for a sub-directory listing", async () => {
    const batchCalls: string[][] = [];
    let logCalls = 0;
    const treeCommit = makeCommit("tree slot", "c".repeat(40));
    const engine = stubClient(
      {
        listTreeCommits: (_ref, paths) => {
          batchCalls.push([...(paths ?? [])]);
          const commits = (paths ?? []).map((_p, i) => (i === 0 ? treeCommit : makeCommit("entry slot", "d".repeat(40))));
          return Promise.resolve({ commits });
        },
        listLog: () => {
          logCalls++;
          return Promise.resolve(null);
        },
      },
    );
    const data = expectData(await loadLastCommitFragmentFrom(engine, FRAG_REPO, "a".repeat(40), "docs", "branch/main"));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toEqual(["docs", "docs/guide.md"]); // the tree slot rides paths[0]
    expect(logCalls).toBe(0);
    expect(data.treeLastCommit?.oid).toBe("c".repeat(40)); // slot 0 = the treePath's own commit
    expect(rowSummary(data)).toEqual([["guide.md", "d".repeat(40)]]);
  });

  it("degrades a null / unavailable batch to the legacy fan with IDENTICAL rows", async () => {
    // (a) the batch resolves null (transport failure) — every budgeted path
    //     rides the 8-wide listLog fan, answering the same rows the batch arm
    //     produced above
    const logPaths: (string | undefined)[] = [];
    const engineA = stubClient({ listTreeCommits: () => Promise.resolve(null) }, (path) => logPaths.push(path));
    const dataA = expectData(await loadLastCommitFragmentFrom(engineA, FRAG_REPO, "a".repeat(40), "", "branch/main"));
    expect(logPaths).toEqual(["README.md", "app.ts"]); // exactly the budgeted path set
    expect(rowSummary(dataA)).toEqual([
      ["README.md", "a".repeat(40)],
      ["app.ts", "a".repeat(40)],
    ]);
    // (b) the batch method is ABSENT (an old boundary / stub) — the presence
    //     guard takes the same fallback without touching the missing method
    const engineB = stubClient();
    delete (engineB as Partial<EngineClient>).listTreeCommits;
    const dataB = expectData(await loadLastCommitFragmentFrom(engineB, FRAG_REPO, "a".repeat(40), "", "branch/main"));
    expect(rowSummary(dataB)).toEqual(rowSummary(dataA));
  });

  it("degrades a throwing batch to the fan; a throwing fan entry degrades to null", async () => {
    // Same null-degrade semantics as the established consumer: never a
    // rejection, so one failed entry cannot sink the fragment — the batch
    // falls back to the fan, and the fan's own failed entry lands null.
    const engine = stubClient({
      listTreeCommits: () => Promise.reject(new Error("transport")),
      listLog: (_ref, opts) =>
        opts?.path === "app.ts"
          ? Promise.reject(new Error("entry transport"))
          : Promise.resolve({ commits: [makeCommit("ok", "4".repeat(40))], more: false }),
    });
    const data = expectData(await loadLastCommitFragmentFrom(engine, FRAG_REPO, "a".repeat(40), "", "branch/main"));
    expect(rowSummary(data)).toEqual([
      ["README.md", "4".repeat(40)],
      ["app.ts", null], // the failed fan entry → the .notready cell
    ]);
    expect(lastCommitFragmentHtml(data, "/alice/lastcommit-frag")).toContain("notready");
  });

  it("an index-gap slot rides exactly the missed path's own listLog call", async () => {
    const c1 = makeCommit("one", "1".repeat(40));
    const fanCommit = makeCommit("fanned", "5".repeat(40));
    const logPaths: (string | undefined)[] = [];
    const engine = stubClient({
      listTreeCommits: () => Promise.resolve({ commits: [c1] }), // slot 1 missing
      listLog: (_ref, opts) => {
        logPaths.push(opts?.path);
        return Promise.resolve({ commits: [fanCommit], more: false });
      },
    });
    const data = expectData(await loadLastCommitFragmentFrom(engine, FRAG_REPO, "a".repeat(40), "", "branch/main"));
    expect(logPaths).toEqual(["app.ts"]); // exactly the missed slot fanned
    expect(rowSummary(data)).toEqual([
      ["README.md", "1".repeat(40)],
      ["app.ts", "5".repeat(40)],
    ]);
  });

  it("caps the ONE batch call at ENRICH_MAX paths; past-budget rows stay notready without RPCs", async () => {
    const entries = Array.from({ length: 32 }, (_unused, i) => entry(`f-${String(i).padStart(2, "0")}.txt`));
    const batchCalls: string[][] = [];
    let logCalls = 0;
    const engine = stubClient(
      {
        listTree: () => Promise.resolve({ oid: "3".repeat(40), entries }),
        listTreeCommits: (_ref, paths) => {
          batchCalls.push([...(paths ?? [])]);
          return Promise.resolve({ commits: (paths ?? []).map(() => makeCommit("batch subject", "b".repeat(40))) });
        },
        listLog: () => {
          logCalls++;
          return Promise.resolve(null);
        },
      },
    );
    const data = expectData(await loadLastCommitFragmentFrom(engine, FRAG_REPO, "a".repeat(40), "", "branch/main"));
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]).toHaveLength(ENRICH_MAX); // the budget bounds the RPC's paths
    expect(logCalls).toBe(0);
    expect(data.rows).toHaveLength(32);
    for (const row of data.rows.slice(0, ENRICH_MAX)) expect(row.commit?.oid).toBe("b".repeat(40));
    for (const row of data.rows.slice(ENRICH_MAX)) expect(row.commit).toBeNull(); // f-30, f-31
    expect(lastCommitFragmentHtml(data, "/alice/lastcommit-wide").match(/notready/g)).toHaveLength(2);
  });
});
