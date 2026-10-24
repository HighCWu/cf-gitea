/**
 * Write-family cases: push semantics. All operate out of the seed worktree
 * (identity + dates fixed there, so rewritten oids stay deterministic across
 * endpoints) and verify server state via ls-remote plus, where a client view
 * matters, a fresh clone.
 */

export const WRITE_CASES = [
  {
    id: "push-force",
    title: "force push (non-FF rejection, then forced rewrite)",
    seed: "simple",
    describe: "plain push of a rewritten tip must be rejected; push --force must replace the tip",
    async run(t) {
      // Rewrite the tip locally: amend with a new message at a fixed date.
      const amendDate = "2026-10-22T10:00:00 +0000";
      const m = await t.git(["commit", "-q", "--amend", "-m", "rewritten tip (force-push case)"], {
        cwd: t.seedDir,
        env: { GIT_AUTHOR_DATE: amendDate, GIT_COMMITTER_DATE: amendDate },
      });
      if (!m.ok) {
        t.check("amend", false, `git commit --amend failed: ${t.tail(m.stderr, 200)}`);
        return;
      }
      const newTip = (await t.git(["rev-parse", "HEAD"], { cwd: t.seedDir })).stdout.trim();

      const plain = await t.git(["push", t.authUrl, "main"], { cwd: t.seedDir });
      t.check("non-ff-rejected", !plain.ok, `plain push of rewritten tip exit ${plain.code} (expected non-zero)`);
      t.note("non_ff_stderr_tail", t.tail(plain.stderr, 300));

      const forced = await t.git(["push", "-q", "--force", t.authUrl, "main"], { cwd: t.seedDir });
      t.expectOk(forced, "force-push-exit", `git push --force exit ${forced.code}`);
      t.collectCwd = t.seedDir;

      const remote = await t.remoteRefs();
      t.check("remote-tip-rewritten", remote.refs["refs/heads/main"] === newTip,
        `remote refs/heads/main = ${remote.refs["refs/heads/main"]}, local rewritten tip = ${newTip}`);
    },
  },
  {
    id: "push-multi",
    title: "multi-ref push in one command",
    seed: "simple",
    describe: "git push <url> main b1 b2 — three branch refs created by a single receive",
    async run(t) {
      const env = { GIT_AUTHOR_DATE: "2026-10-22T11:00:00 +0000", GIT_COMMITTER_DATE: "2026-10-22T11:00:00 +0000" };
      await t.git(["checkout", "-qb", "b1"], { cwd: t.seedDir });
      t.writeFile(t.seedDir, "b1.txt", "branch one\n");
      await t.git(["add", "-A"], { cwd: t.seedDir });
      const r = await t.git(["commit", "-qm", "branch one commit"], { cwd: t.seedDir, env });
      if (!r.ok) {
        t.check("b1-commit", false, `commit on b1 failed: ${t.tail(r.stderr, 200)}`);
        return;
      }
      await t.git(["checkout", "-q", "main"], { cwd: t.seedDir });
      await t.git(["checkout", "-qb", "b2"], { cwd: t.seedDir });
      t.writeFile(t.seedDir, "b2.txt", "branch two\n");
      await t.git(["add", "-A"], { cwd: t.seedDir });
      const r2 = await t.git(["commit", "-qm", "branch two commit"], { cwd: t.seedDir, env });
      if (!r2.ok) {
        t.check("b2-commit", false, `commit on b2 failed: ${t.tail(r2.stderr, 200)}`);
        return;
      }
      await t.git(["checkout", "-q", "main"], { cwd: t.seedDir });

      const push = await t.git(["push", "-q", t.authUrl, "main", "b1", "b2"], { cwd: t.seedDir });
      t.expectOk(push, "multi-push-exit", `git push main b1 b2 exit ${push.code}`);
      t.collectCwd = t.seedDir;

      const remote = await t.remoteRefs();
      for (const branch of ["main", "b1", "b2"]) {
        t.check(`remote-has-${branch}`, `refs/heads/${branch}` in remote.refs,
          `refs/heads/${branch} ${`refs/heads/${branch}` in remote.refs ? "present" : "MISSING"} on the remote`);
      }
      const local = await t.localRefs(t.seedDir);
      const mismatch = ["refs/heads/main", "refs/heads/b1", "refs/heads/b2"]
        .filter((ref) => local[ref] !== remote.refs[ref]);
      t.check("remote-oids-match-local", mismatch.length === 0,
        mismatch.length === 0 ? "all three pushed oids match ls-remote" : `oid mismatch on: ${mismatch.join(", ")}`);
    },
  },
  {
    id: "tags-push-clone",
    title: "tag push + fresh clone sees tags",
    seed: "simple",
    describe: "push an annotated and a lightweight tag, then clone and verify both arrive",
    async run(t) {
      const tagEnv = { GIT_COMMITTER_DATE: "2026-10-22T12:00:00 +0000" };
      let r = await t.git(["tag", "-a", "v1", "-m", "annotated tag one"], { cwd: t.seedDir, env: tagEnv });
      if (!r.ok) {
        t.check("annotated-tag", false, `git tag -a failed: ${t.tail(r.stderr, 200)}`);
        return;
      }
      r = await t.git(["tag", "lw"], { cwd: t.seedDir });
      if (!r.ok) {
        t.check("lightweight-tag", false, `git tag failed: ${t.tail(r.stderr, 200)}`);
        return;
      }
      const push = await t.git(["push", "-q", t.authUrl, "main", "v1", "lw"], { cwd: t.seedDir });
      t.expectOk(push, "tag-push-exit", `git push main v1 lw exit ${push.code}`);

      const dir = t.join(t.caseDir, "clone");
      const clone = await t.git(["clone", "-q", t.url, dir]);
      t.collectCwd = dir;
      t.expectOk(clone, "clone-exit", `fresh clone exit ${clone.code}`);
      const tags = (await t.git(["tag", "-l"], { cwd: dir })).stdout.trim().split("\n").filter(Boolean).sort();
      t.check("clone-has-both-tags", tags.join(",") === "lw,v1", `git tag -l = [${tags.join(", ")}], expected [lw, v1]`);

      const remote = await t.remoteRefs();
      t.check("remote-has-v1", "refs/tags/v1" in remote.refs, "refs/tags/v1 in ls-remote");
      t.check("remote-has-v1-peeled", "refs/tags/v1^{}" in remote.refs, "peeled refs/tags/v1^{} in ls-remote");
      t.check("remote-has-lw", "refs/tags/lw" in remote.refs, "refs/tags/lw in ls-remote");
    },
  },
  {
    id: "delete-ref",
    title: "delete ref via push :refspec",
    seed: "simple",
    describe: "push an extra branch, delete it with :refs/heads/extra, confirm it is gone",
    async run(t) {
      await t.git(["branch", "extra"], { cwd: t.seedDir });
      const push = await t.git(["push", "-q", t.authUrl, "main", "extra"], { cwd: t.seedDir });
      t.expectOk(push, "setup-push-exit", `push main+extra exit ${push.code}`);
      let remote = await t.remoteRefs();
      t.check("extra-present-before", "refs/heads/extra" in remote.refs, "refs/heads/extra before delete");

      const del = await t.git(["push", "-q", t.authUrl, ":refs/heads/extra"], { cwd: t.seedDir });
      t.expectOk(del, "delete-push-exit", `git push :refs/heads/extra exit ${del.code}`);
      t.collectCwd = t.seedDir;

      remote = await t.remoteRefs();
      t.check("extra-absent-after", !("refs/heads/extra" in remote.refs),
        `refs/heads/extra ${"refs/heads/extra" in remote.refs ? "STILL PRESENT" : "gone"} after delete`);
      t.check("main-survives-delete", "refs/heads/main" in remote.refs, "refs/heads/main still present");
    },
  },
];
