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
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import {
  lastCommitFragmentHtml,
  lastCommitFragmentResponse,
  loadLastCommitFragment,
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
