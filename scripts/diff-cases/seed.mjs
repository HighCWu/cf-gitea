/**
 * Deterministic seed repositories for the differential test battery.
 *
 * Every seed fixes content, author/committer identities and dates, so the
 * resulting commit/tree/blob/tag oids are IDENTICAL no matter which endpoint
 * the seed is pushed to. That property is what makes cross-endpoint reports
 * comparable field by field (refs and object counts must match exactly for
 * full clones; see scripts/diff-cases/rules.mjs for the declared exceptions).
 *
 * A seed builder receives the case toolbelt `t` (see scripts/diff-test.mjs)
 * and builds a worktree at `t.seedDir`, then pushes to the case repo. Push
 * (and, on a `theirs` endpoint, any repo-creation fallback) is orchestrated
 * by the harness; the builder only produces local history.
 */

/** Fixed author/committer identity for every seed commit (determinism). */
export const SEED_IDENTITY = ["Diff Tester", "diff@test.invalid"];

/** Commit dates for the five-commit history seed, oldest first (ISO with explicit offset). */
const HISTORY_DATES = [
  "2026-10-15T10:00:00 +0000",
  "2026-10-16T10:00:00 +0000",
  "2026-10-18T10:00:00 +0000",
  "2026-10-20T10:00:00 +0000",
  "2026-10-21T10:00:00 +0000",
];

/** The cutoff the `shallow-since` case clones with: commits 3-5 are inside, 1-2 outside. */
export const SHALLOW_SINCE_CUTOFF = "2026-10-17T00:00:00Z";

/**
 * Deterministic incompressible-ish content for the bulk seed: an LCG hex
 * grid (fixed seed per file index, no Math.random). ~6.5 KiB per file with
 * high per-line entropy so pack sizes stay comparable across endpoints and
 * the incremental-fetch byte threshold has real mass to measure against.
 */
export function bulkFileContent(i) {
  let s = (0x9e3779b9 ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0;
  const lines = [];
  for (let l = 0; l < 96; l++) {
    let row = "";
    for (let c = 0; c < 8; c++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      row += s.toString(16).padStart(8, "0");
    }
    lines.push(`${l.toString(16).padStart(2, "0")}:${row}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The deterministic appendix the incremental-fetch case appends to bulk/f12
 *  (a modified blob gives a thin-packing server a REF_DELTA opportunity). */
export const bulkAppendix = (() => {
  let s = 0xdeadbeef;
  const lines = [];
  for (let l = 0; l < 24; l++) {
    let row = "";
    for (let c = 0; c < 8; c++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      row += s.toString(16).padStart(8, "0");
    }
    lines.push(`append-${l}:${row}`);
  }
  return `${lines.join("\n")}\n`;
})();

export const SEEDS = {
  /**
   * history: 5 commits on main (one file added per commit, fixed dates),
   * branch `side` at commit 2 (the --shallow-exclude target), annotated tag
   * `v1` at commit 3. Full clone object count: 5 commits + 5 trees + 5 blobs
   * + 1 tag object = 16; commit count 5.
   */
  history: {
    expectedCommits: 5,
    expectedObjects: 16,
    async build(t) {
      const { git } = t;
      const env = (date) => ({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      let r = await git(["init", "-q", "-b", "main", t.seedDir], { cwd: t.caseDir });
      if (!r.ok) throw new Error(`seed: git init failed: ${r.stderr}`);
      const [name, email] = SEED_IDENTITY;
      for (let i = 1; i <= 5; i++) {
        await git(["config", "user.name", name], { cwd: t.seedDir });
        await git(["config", "user.email", email], { cwd: t.seedDir });
        const file = t.writeFile(t.seedDir, `f${i}.txt`, `history file ${i}\nline two of ${i}\n`);
        if (!file) throw new Error(`seed: could not write f${i}.txt`);
        r = await git(["add", "-A"], { cwd: t.seedDir });
        if (!r.ok) throw new Error(`seed: git add failed: ${r.stderr}`);
        r = await git(["commit", "-qm", `history commit ${i} (dated ${HISTORY_DATES[i - 1].slice(0, 10)})`],
          { cwd: t.seedDir, env: env(HISTORY_DATES[i - 1]) });
        if (!r.ok) throw new Error(`seed: git commit ${i} failed: ${r.stderr}`);
        if (i === 2) await git(["branch", "side"], { cwd: t.seedDir });
        if (i === 3) await git(["tag", "-a", "v1", "-m", "history tag one"], { cwd: t.seedDir, env: env(HISTORY_DATES[2]) });
      }
      return { refs: ["refs/heads/main", "refs/heads/side", "refs/tags/v1"] };
    },
  },

  /**
   * simple: 2 commits on main (fixed dates), no branches/tags. Full clone
   * object count: 2 + 2 + 2 = 6; commit count 2. Mutating cases build on it.
   */
  simple: {
    expectedCommits: 2,
    expectedObjects: 6,
    async build(t) {
      const { git } = t;
      const dates = ["2026-10-20T09:00:00 +0000", "2026-10-21T09:00:00 +0000"];
      const [name, email] = SEED_IDENTITY;
      let r = await git(["init", "-q", "-b", "main", t.seedDir], { cwd: t.caseDir });
      if (!r.ok) throw new Error(`seed: git init failed: ${r.stderr}`);
      await git(["config", "user.name", name], { cwd: t.seedDir });
      await git(["config", "user.email", email], { cwd: t.seedDir });
      const files = [["base.txt", "simple base\n"], ["plus.txt", "more\n"]];
      for (let i = 0; i < files.length; i++) {
        if (!t.writeFile(t.seedDir, files[i][0], files[i][1])) throw new Error(`seed: could not write ${files[i][0]}`);
        r = await git(["add", "-A"], { cwd: t.seedDir });
        if (!r.ok) throw new Error(`seed: git add failed: ${r.stderr}`);
        r = await git(["commit", "-qm", `simple commit ${i + 1}`], { cwd: t.seedDir, env: {
          GIT_AUTHOR_DATE: dates[i], GIT_COMMITTER_DATE: dates[i],
        } });
        if (!r.ok) throw new Error(`seed: git commit ${i + 1} failed: ${r.stderr}`);
      }
      return { refs: ["refs/heads/main"] };
    },
  },

  /**
   * bulk: 12 commits on main, each adding one incompressible ~6.5 KiB file
   * (bulk/f01..f12, LCG hex). Full clone object count: 12 commits + 12 root
   * trees + 12 bulk/ subtrees + 12 blobs = 48; commit count 12. Gives the
   * incremental-fetch case a byte threshold with enough mass to distinguish
   * a delta pack from a full re-send.
   */
  bulk: {
    expectedCommits: 12,
    expectedObjects: 48,
    async build(t) {
      const { git } = t;
      const dates = Array.from({ length: 12 }, (_, i) =>
        `2026-10-${String(10 + i).padStart(2, "0")}T08:00:00 +0000`);
      const [name, email] = SEED_IDENTITY;
      let r = await git(["init", "-q", "-b", "main", t.seedDir], { cwd: t.caseDir });
      if (!r.ok) throw new Error(`seed: git init failed: ${r.stderr}`);
      await git(["config", "user.name", name], { cwd: t.seedDir });
      await git(["config", "user.email", email], { cwd: t.seedDir });
      for (let i = 1; i <= 12; i++) {
        if (!t.writeFile(t.seedDir, `bulk/f${String(i).padStart(2, "0")}`, bulkFileContent(i))) {
          throw new Error(`seed: could not write bulk/f${String(i).padStart(2, "0")}`);
        }
        r = await git(["add", "-A"], { cwd: t.seedDir });
        if (!r.ok) throw new Error(`seed: git add failed: ${r.stderr}`);
        r = await git(["commit", "-qm", `bulk commit ${i} (f${String(i).padStart(2, "0")})`],
          { cwd: t.seedDir, env: { GIT_AUTHOR_DATE: dates[i - 1], GIT_COMMITTER_DATE: dates[i - 1] } });
        if (!r.ok) throw new Error(`seed: git commit ${i} failed: ${r.stderr}`);
      }
      return { refs: ["refs/heads/main"] };
    },
  },
};
