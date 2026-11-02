/**
 * Pure unit pins over services/git-models.ts for the ㉑ P2 wire-shape fixes:
 *
 *   - W1 — ContentsResponse.mode is ALWAYS emitted (upstream's field is a
 *     non-pointer, non-omitempty string — modules/structs/repo_file.go:143,
 *     populated entry.Mode().String() at content.go:136); it was dropped even
 *     though the value already arrived on opts.
 *   - W2 — the blob-inlining cap is upstream's `setting.API.DefaultMaxBlobSize`
 *     (modules/setting/api.go:21): 10 MiB, over-cap files answer
 *     content/encoding null (GetBlobBySHA, content.go:233) — the former 1 MiB
 *     MAX_CONTENTS_RENDER_BYTES was an unsanctioned threshold divergence.
 *   - W3 — PayloadCommit.added/removed/modified are ALWAYS emitted, null when
 *     unenriched (upstream's Go fields carry no omitempty — hook.go:171-175 —
 *     and nil slices marshal null); the enrichment spread overwrites them with
 *     the arrays.
 *
 * No D1, no engine: the converters are pure URL/field composition (the same
 * posture as git-models-tags.test.ts).
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_BLOB_SIZE, toContentsEntry, toPayloadCommit } from "./git-models";
import type { RepositoryWithOwner } from "./repository";

const PAIR = {
  repo: { ownerNamespace: "owner", slug: "repo", defaultBranch: "main" },
  owner: {},
} as unknown as RepositoryWithOwner;
const ORIGIN = "http://localhost:3000";

function entryOpts(overrides: Partial<Parameters<typeof toContentsEntry>[0]> = {}): Parameters<typeof toContentsEntry>[0] {
  return {
    path: "README.md",
    name: "README.md",
    mode: "100644",
    oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    type: "file",
    size: 12,
    content: new TextEncoder().encode("hello\nworld\n"),
    ...overrides,
  };
}

describe("ContentsResponse.mode is always emitted (W1)", () => {
  it("a regular file carries its raw git mode", () => {
    const out = toContentsEntry(entryOpts(), PAIR, ORIGIN);
    expect(Object.hasOwn(out, "mode")).toBe(true);
    expect(out.mode).toBe("100644");
  });

  it("an executable file carries 100755", () => {
    const out = toContentsEntry(entryOpts({ mode: "100755" }), PAIR, ORIGIN);
    expect(out.mode).toBe("100755");
  });

  it("a directory entry carries the tree mode (upstream renders Mode for every entry type)", () => {
    const out = toContentsEntry(
      entryOpts({ path: "docs", name: "docs", mode: "40000", type: "dir", size: null, content: null }),
      PAIR,
      ORIGIN,
    );
    expect(Object.hasOwn(out, "mode")).toBe(true);
    expect(out.mode).toBe("40000");
  });

  it("a symlink and a submodule carry their modes too", () => {
    const link = toContentsEntry(
      entryOpts({ mode: "120000", type: "symlink", size: 11, content: new TextEncoder().encode("target/file"), target: "target/file" }),
      PAIR,
      ORIGIN,
    );
    expect(link.mode).toBe("120000");
    const sub = toContentsEntry(
      entryOpts({ path: "vendor/lib", name: "lib", mode: "160000", type: "submodule", size: null, content: null }),
      PAIR,
      ORIGIN,
    );
    expect(sub.mode).toBe("160000");
  });
});

describe("the blob-inlining cap is upstream's DefaultMaxBlobSize (W2)", () => {
  it("adopts upstream's 10 MiB default (setting.API.DefaultMaxBlobSize, api.go:21)", () => {
    expect(DEFAULT_MAX_BLOB_SIZE).toBe(10485760);
  });

  it("an over-cap file answers content/encoding null — upstream GetBlobBySHA's early-return shape", () => {
    const big = new Uint8Array(DEFAULT_MAX_BLOB_SIZE + 1);
    const out = toContentsEntry(entryOpts({ size: big.byteLength, content: big }), PAIR, ORIGIN);
    expect(out.content).toBeNull();
    expect(out.encoding).toBeNull();
  });

  it("an at-cap file still inlines (upstream: `>` is the over-cap comparison)", () => {
    const exact = new Uint8Array(DEFAULT_MAX_BLOB_SIZE);
    const out = toContentsEntry(entryOpts({ size: exact.byteLength, content: exact }), PAIR, ORIGIN);
    expect(out.encoding).toBe("base64");
    expect(out.content).not.toBeNull();
  });

  it("an under-cap file inlines base64 (the compat fixtures cover this end-to-end; the unit pin holds the encoding value)", () => {
    const out = toContentsEntry(entryOpts(), PAIR, ORIGIN);
    expect(out.encoding).toBe("base64");
    expect(out.content).toBe(btoa("hello\nworld\n"));
  });
});

describe("PayloadCommit diff lists are always emitted (W3)", () => {
  const commit = {
    oid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    tree: "cccccccccccccccccccccccccccccccccccccccc",
    parents: [],
    subject: "subject",
    message: "subject\n\nbody\n",
    author: { name: "Doer", email: "doer@example.com", time: 1700000000, tz: "+0000" },
    committer: { name: "Doer", email: "doer@example.com", time: 1700000000, tz: "+0000" },
  };

  it("the unenriched converter carries all three keys as null — not omitted", () => {
    const out = toPayloadCommit(commit, PAIR, new Map(), ORIGIN);
    expect(Object.hasOwn(out, "added")).toBe(true);
    expect(Object.hasOwn(out, "removed")).toBe(true);
    expect(Object.hasOwn(out, "modified")).toBe(true);
    expect(out.added).toBeNull();
    expect(out.removed).toBeNull();
    expect(out.modified).toBeNull();
  });

  it("the enrichment spread overwrites the nulls with the arrays (the CommitFileLists intersection shape)", () => {
    const enriched = {
      ...toPayloadCommit(commit, PAIR, new Map(), ORIGIN),
      added: ["docs/new.md"],
      removed: [],
      modified: ["README.md"],
    };
    expect(enriched.added).toEqual(["docs/new.md"]);
    expect(enriched.removed).toEqual([]);
    expect(enriched.modified).toEqual(["README.md"]);
  });
});
