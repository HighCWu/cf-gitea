/**
 * Read-family cases for the differential battery: clone shapes and the
 * shallow family. Each case runs REAL git CLI commands against the endpoint
 * and asserts via `t.check`; per-command exit/stderr and repository-state
 * probes (.git/shallow, object counts) are recorded by the harness.
 *
 * Cross-reference: docs/design/p0-evidence.md (probe pattern: exit status +
 * .git/shallow), docs/design/m3-design-inputs.md Round-7 item 4 (the
 * deepen-since silent-full-clone bug class these two cases guard).
 */

/**
 * Shared skeleton for a plain full clone: clone, probe, collect.
 * Used by clone-fresh and clone-fsck (the latter adds fsck --strict).
 */
async function fullCloneCase(t, { withFsck }) {
  const dir = t.join(t.caseDir, "clone");
  const r = await t.git(["clone", "-q", t.url, dir]);
  t.collectCwd = dir;
  t.expectOk(r, "clone-exit", `git clone exit ${r.code}`);
  const p = await t.probe(dir, "after-clone");
  const refs = await t.localRefs(dir);
  if (p) {
    t.check("object-count-full", p.object_count === t.seed.expectedObjects,
      `rev-list --objects --all = ${p.object_count}, expected ${t.seed.expectedObjects}`);
    t.check("commit-count-full", p.commit_count === t.seed.expectedCommits,
      `rev-list --count --all = ${p.commit_count}, expected ${t.seed.expectedCommits}`);
    t.check("no-shallow-file", p.shallow === null, `.git/shallow = ${JSON.stringify(p.shallow)}`);
  } else {
    t.check("clone-dir-exists", false, "clone directory missing; no probe possible");
  }
  // A clone materializes local branches only for HEAD; other seeded branches
  // arrive as remote-tracking refs, tags as-is.
  const cloneSideRef = (ref) => ref.startsWith("refs/tags/") ? ref : `refs/remotes/origin/${ref.slice("refs/heads/".length)}`;
  const missing = t.seed.expectedRefs.filter((ref) => !(cloneSideRef(ref) in refs));
  t.check("seed-refs-present", missing.length === 0,
    missing.length === 0 ? `all seed refs present (${t.seed.expectedRefs.join(", ")})` : `clone refs missing: ${missing.join(", ")}`);
  if (withFsck) {
    const f = await t.git(["fsck", "--strict"], { cwd: dir });
    t.expectOk(f, "fsck-strict-exit", `git fsck --strict exit ${f.code}: ${t.tail(f.stderr, 200)}`);
  }
}

export const READ_CASES = [
  {
    id: "clone-fresh",
    title: "fresh full clone",
    seed: "history",
    describe: "git clone of a freshly pushed multi-ref repo (main + side + tag v1)",
    async run(t) {
      await fullCloneCase(t, { withFsck: false });
    },
  },
  {
    id: "clone-fsck",
    title: "full clone + fsck --strict",
    seed: "history",
    describe: "full clone followed by git fsck --strict (connectivity + validity)",
    async run(t) {
      await fullCloneCase(t, { withFsck: true });
    },
  },
  {
    id: "shallow-depth1",
    title: "--depth=1 shallow clone, deepen, unshallow",
    seed: "history",
    describe: "the SUPPORTED shallow path must stay correct: boundary in .git/shallow, deepen, unshallow",
    async run(t) {
      const dir = t.join(t.caseDir, "shallow");
      const r = await t.git(["clone", "-q", "--depth=1", t.url, dir]);
      t.collectCwd = dir;
      t.expectOk(r, "depth1-clone-exit", `git clone --depth=1 exit ${r.code}`);
      const p1 = await t.probe(dir, "after-depth1");
      if (p1) {
        t.check("shallow-boundary-exists", Array.isArray(p1.shallow) && p1.shallow.length >= 1,
          `.git/shallow = ${JSON.stringify(p1.shallow)} (expected >= 1 boundary oid)`);
        t.check("depth1-single-commit", p1.commit_count === 1, `commit count = ${p1.commit_count}, expected 1`);
        t.check("depth1-subset", p1.object_count !== null && p1.object_count < t.seed.expectedObjects,
          `object count = ${p1.object_count}, expected < ${t.seed.expectedObjects}`);
      } else {
        t.check("clone-dir-exists", false, "clone directory missing; no probe possible");
      }

      const d = await t.git(["fetch", "-q", "--depth=3", "origin"], { cwd: dir });
      t.expectOk(d, "deepen-exit", `git fetch --depth=3 exit ${d.code}`);
      const p2 = await t.probe(dir, "after-deepen-3");
      t.check("deepen-3-commits", p2 !== null && p2.commit_count === 3,
        `commit count after deepen = ${p2?.commit_count}, expected 3`);

      const u = await t.git(["fetch", "-q", "--unshallow", "origin"], { cwd: dir });
      t.expectOk(u, "unshallow-exit", `git fetch --unshallow exit ${u.code}`);
      const p3 = await t.probe(dir, "after-unshallow");
      t.check("unshallow-full-history", p3 !== null && p3.commit_count === t.seed.expectedCommits,
        `commit count after unshallow = ${p3?.commit_count}, expected ${t.seed.expectedCommits}`);
      t.check("unshallow-removes-shallow", p3 !== null && p3.shallow === null,
        `.git/shallow after unshallow = ${JSON.stringify(p3?.shallow)}, expected null`);
      const f = await t.git(["fsck", "--strict"], { cwd: dir });
      t.expectOk(f, "fsck-after-unshallow", `git fsck --strict exit ${f.code}`);
    },
  },
  {
    id: "shallow-since",
    title: "--shallow-since (deepen-since)",
    seed: "history",
    // The battery's declared acceptance: correct shallow result OR clean
    // failure — a silent full clone is the P0 bug class and fails the run.
    shallowAcceptance: {
      commits: 5, objects: 16, shallowCommits: 3,
    },
    describe: "clone --shallow-since: commits 3-5 (dated 10-18..10-21) in, commits 1-2 behind the boundary",
    async run(t) {
      const dir = t.join(t.caseDir, "since");
      const r = await t.git(["clone", "-q", `--shallow-since=${t.constants.shallowSinceCutoff}`, t.url, dir]);
      t.collectCwd = dir;
      t.check("clone-terminal-exit", true,
        `git clone --shallow-since exit ${r.code} (0 = implemented, non-zero = rejected)`);
      const p = await t.probe(dir, "after-clone");
      t.note("clone_stderr_tail", t.tail(r.stderr, 300));
      if (r.ok) {
        t.check("shallow-subset-commits", p?.commit_count === 3,
          `commit count = ${p?.commit_count}, expected 3 when shallow-since is implemented`, { soft: true });
      }
    },
  },
  {
    id: "shallow-exclude",
    title: "--shallow-exclude (deepen-not)",
    seed: "history",
    shallowAcceptance: {
      commits: 5, objects: 16, shallowCommits: 3,
    },
    describe: "clone --shallow-exclude=refs/heads/side: main history without commit 2 and its ancestors",
    async run(t) {
      const dir = t.join(t.caseDir, "exclude");
      const r = await t.git(["clone", "-q", "--shallow-exclude=refs/heads/side", t.url, dir]);
      t.collectCwd = dir;
      t.check("clone-terminal-exit", true,
        `git clone --shallow-exclude exit ${r.code} (0 = implemented, non-zero = rejected)`);
      const p = await t.probe(dir, "after-clone");
      t.note("clone_stderr_tail", t.tail(r.stderr, 300));
      if (r.ok) {
        t.check("shallow-subset-commits", p?.commit_count === 3,
          `commit count = ${p?.commit_count}, expected 3 when shallow-exclude is implemented`, { soft: true });
      }
    },
  },
  {
    id: "fetch-incremental",
    title: "incremental fetch stays small",
    seed: "simple",
    describe: "one new commit on the server, then git fetch: the received pack must be a small delta",
    async run(t) {
      const dir = t.join(t.caseDir, "c");
      const r = await t.git(["clone", "-q", t.url, dir]);
      t.collectCwd = dir;
      t.expectOk(r, "clone-exit", `git clone exit ${r.code}`);
      const base = await t.probe(dir, "after-clone");
      t.check("base-object-count", base !== null && base.object_count === t.seed.expectedObjects,
        `full clone object count = ${base?.object_count}, expected ${t.seed.expectedObjects}`);
      if (base === null) return; // clone failed; the remaining steps cannot run

      // One new commit server-side (from the seed worktree; fixed date = deterministic oid).
      t.writeFile(t.seedDir, "extra.txt", "incremental addition\n");
      const c = await t.git(["add", "-A"], { cwd: t.seedDir });
      const m = await t.git(["commit", "-qm", "incremental commit one"],
        { cwd: t.seedDir, env: { GIT_AUTHOR_DATE: "2026-10-22T09:00:00 +0000", GIT_COMMITTER_DATE: "2026-10-22T09:00:00 +0000" } });
      if (!c.ok || !m.ok) {
        t.check("server-side-commit", false, `seed worktree commit failed: ${t.tail((c.stderr || "") + (m.stderr || ""), 200)}`);
        return;
      }
      const push = await t.git(["push", "-q", t.authUrl, "main"], { cwd: t.seedDir });
      t.expectOk(push, "server-push-exit", `server-side push exit ${push.code}`);

      // The measured incremental fetch (--progress forces progress lines on a pipe).
      const f = await t.git(["fetch", "--progress", "origin"], { cwd: dir });
      t.expectOk(f, "fetch-exit", `git fetch exit ${f.code}`);
      const counts = t.parseFetchProgress(f.stderr);
      t.note("fetch_enumerated", counts.enumerated);
      t.note("fetch_server_total", counts.serverTotal);
      t.note("fetch_received", counts.received);
      // Smallness metric: the server-side enumeration count is the one signal
      // every server emits ("remote: Enumerating objects: N" — the engine's
      // sideband progress and Gitea's git upload-pack alike); git suppresses
      // the client's "Receiving objects" meter for tiny packs. Prefer the
      // client count when present, fall back to remote Total, then enumerated.
      const smallness = counts.received ?? counts.serverTotal ?? counts.enumerated;
      t.check("fetch-is-small", smallness !== null && smallness > 0 && smallness <= 5,
        `incremental size signal = ${smallness} objects ` +
        `(enumerated = ${counts.enumerated}, remote Total = ${counts.serverTotal}, received = ${counts.received}; ` +
        `expected 3: commit+tree+blob; <= 5 allowed; full repo = ${t.seed.expectedObjects})`);
      const after = await t.probe(dir, "after-fetch");
      t.check("fetch-object-count", after !== null && after.object_count === t.seed.expectedObjects + 3,
        `object count after fetch = ${after?.object_count}, expected ${t.seed.expectedObjects + 3}`);
      const mg = await t.git(["merge", "-q", "--ff-only", "origin/main"], { cwd: dir });
      t.expectOk(mg, "ff-merge-exit", `merge --ff-only exit ${mg.code}`);
      const fs = await t.git(["fsck"], { cwd: dir });
      t.expectOk(fs, "fsck-after-fetch", `git fsck exit ${fs.code}`);
    },
  },
];
