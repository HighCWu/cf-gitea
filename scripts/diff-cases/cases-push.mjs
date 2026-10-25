/**
 * Push-family cases — validated against OURS ONLY in this wave (the battery's
 * optional theirs run is read-only): branch create/ff/force/delete lifecycle,
 * tag push/move semantics, and the receive-pack --atomic consistency probe.
 *
 * On a non-ours endpoint the case records `ours_only_skip` in the notes and
 * runs nothing; rules.mjs's push-family-ours-only rule makes that shape
 * explainable in --compare. Any side that DOES run the family must come out
 * clean (enforced rule).
 */

const ATOMIC_REFUSAL_RE = /--atomic/; // both locales name the flag ("接收端不支持原子推送（--atomic）")

/** Parse the v0 receive-pack advert capabilities from a GIT_TRACE_PACKET stderr. */
function parseReceiveCaps(trace) {
  for (const line of String(trace ?? "").split("\n")) {
    if (/packet:\s+\S+< # service=git-upload-pack/.test(line)) return null;
    const m = line.match(/packet:\s+\S+< \S+ \S+\\0(.*)$/);
    if (m) return m[1].trim().split(/\s+/).filter(Boolean);
  }
  return null;
}

/** Ours-only gate: records the skip and returns true when the case should
 *  return early (non-ours endpoint). */
function skipOnTheirs(t) {
  if (t.endpointKind === "ours") return false;
  t.note("ours_only_skip",
    "push family validated against ours only this wave; the optional theirs run stays read-only " +
    "(rules.mjs push-family-ours-only)");
  t.check("ours-only-skip", true, "skipped by design on a non-ours endpoint", { soft: true });
  return true;
}

export const PUSH_CASES = [
  {
    id: "push-lifecycle",
    title: "branch create / ff / non-ff reject / force / delete",
    seed: "simple",
    describe: "one branch through its whole server-side lifecycle: create at an existing tip, " +
      "fast-forward, rewritten-tip rejection, forced overwrite, delete",
    async run(t) {
      if (skipOnTheirs(t)) return;
      const url = t.authUrl;
      const mainTip = (await t.git(["rev-parse", "HEAD"], { cwd: t.seedDir })).stdout.trim();

      // Create: push a new branch name at the current tip.
      const create = await t.git(["push", "-q", url, `refs/heads/main:refs/heads/feature`], { cwd: t.seedDir });
      t.expectOk(create, "branch-create-exit", `push main:feature exit ${create.code}`);
      let remote = await t.remoteRefs();
      t.check("branch-created-at-tip", remote.refs["refs/heads/feature"] === mainTip,
        `refs/heads/feature = ${remote.refs["refs/heads/feature"]}, expected ${mainTip}`);

      // Fast-forward: append a commit (fixed date -> deterministic) and push.
      t.writeFile(t.seedDir, "ff.txt", "fast-forward addition\n");
      await t.git(["add", "-A"], { cwd: t.seedDir });
      const cm = await t.git(["commit", "-qm", "ff commit"], { cwd: t.seedDir, env: {
        GIT_AUTHOR_DATE: "2026-10-22T11:00:00 +0000", GIT_COMMITTER_DATE: "2026-10-22T11:00:00 +0000",
      } });
      if (!cm.ok) {
        t.check("ff-commit", false, `git commit failed: ${t.tail(cm.stderr, 200)}`);
        return;
      }
      const ffTip = (await t.git(["rev-parse", "HEAD"], { cwd: t.seedDir })).stdout.trim();
      const ff = await t.git(["push", "-q", url, "main"], { cwd: t.seedDir });
      t.expectOk(ff, "ff-push-exit", `fast-forward push exit ${ff.code}`);
      remote = await t.remoteRefs();
      t.check("ff-tip-advanced", remote.refs["refs/heads/main"] === ffTip,
        `refs/heads/main = ${remote.refs["refs/heads/main"]}, expected ${ffTip}`);
      t.check("feature-untouched-by-ff", remote.refs["refs/heads/feature"] === mainTip,
        "the ff push did not move refs/heads/feature");

      // Non-FF: rewrite the tip, plain push must be rejected.
      const amendDate = "2026-10-22T12:00:00 +0000";
      const am = await t.git(["commit", "-q", "--amend", "-m", "rewritten tip (push-lifecycle)"], {
        cwd: t.seedDir, env: { GIT_AUTHOR_DATE: amendDate, GIT_COMMITTER_DATE: amendDate },
      });
      if (!am.ok) {
        t.check("amend", false, `git commit --amend failed: ${t.tail(am.stderr, 200)}`);
        return;
      }
      const rewrittenTip = (await t.git(["rev-parse", "HEAD"], { cwd: t.seedDir })).stdout.trim();
      const plain = await t.git(["push", url, "main"], { cwd: t.seedDir });
      t.check("non-ff-rejected", !plain.ok, `plain push of rewritten tip exit ${plain.code} (expected non-zero)`);
      t.note("non_ff_stderr_tail", t.tail(plain.stderr, 300));

      // Force: the rewrite lands only with --force.
      const forced = await t.git(["push", "-q", "--force", url, "main"], { cwd: t.seedDir });
      t.expectOk(forced, "force-push-exit", `git push --force exit ${forced.code}`);
      remote = await t.remoteRefs();
      t.check("forced-tip-rewritten", remote.refs["refs/heads/main"] === rewrittenTip,
        `refs/heads/main = ${remote.refs["refs/heads/main"]}, expected ${rewrittenTip}`);

      // Delete.
      const del = await t.git(["push", "-q", url, ":refs/heads/feature"], { cwd: t.seedDir });
      t.expectOk(del, "branch-delete-exit", `push :refs/heads/feature exit ${del.code}`);
      remote = await t.remoteRefs();
      t.check("branch-deleted", !("refs/heads/feature" in remote.refs), "refs/heads/feature gone");
      t.check("main-survives-delete", "refs/heads/main" in remote.refs, "refs/heads/main intact");
      t.collectCwd = t.seedDir;
    },
  },
  {
    id: "push-tags-move",
    title: "lightweight + annotated tag push, peel oids, tag move",
    seed: "simple",
    describe: "a lightweight tag advertises with no peeled line and equals the commit; an annotated " +
      "tag advertises the tag object plus its peeled commit; moving a tag is rejected without --force",
    async run(t) {
      if (skipOnTheirs(t)) return;
      const url = t.authUrl;
      const tagEnv = { GIT_COMMITTER_DATE: "2026-10-22T13:00:00 +0000" };
      const tip = (await t.git(["rev-parse", "HEAD"], { cwd: t.seedDir })).stdout.trim();

      let r = await t.git(["tag", "lw"], { cwd: t.seedDir });
      r = r.ok ? await t.git(["tag", "-a", "v1", "-m", "annotated one (push-tags-move)"], { cwd: t.seedDir, env: tagEnv }) : r;
      if (!r.ok) {
        t.check("tag-creation", false, `git tag failed: ${t.tail(r.stderr, 200)}`);
        return;
      }
      const v1Obj = (await t.git(["rev-parse", "v1"], { cwd: t.seedDir })).stdout.trim();
      const push = await t.git(["push", "-q", url, "main", "lw", "v1"], { cwd: t.seedDir });
      t.expectOk(push, "tag-push-exit", `push main lw v1 exit ${push.code}`);

      const remote = await t.remoteRefs();
      t.check("lw-advertised-at-commit", remote.refs["refs/tags/lw"] === tip,
        `refs/tags/lw = ${remote.refs["refs/tags/lw"]}, expected the tip ${tip}`);
      t.check("lw-not-peeled", !("refs/tags/lw^{}" in remote.refs),
        "a lightweight tag advertises no peeled line");
      t.check("annotated-advertised-as-tag-object", remote.refs["refs/tags/v1"] === v1Obj,
        `refs/tags/v1 = ${remote.refs["refs/tags/v1"]}, expected tag object ${v1Obj}`);
      t.check("annotated-peeled-is-commit", remote.refs["refs/tags/v1^{}"] === tip,
        `refs/tags/v1^{{}} = ${remote.refs["refs/tags/v1^{}"]}, expected the tip ${tip}`);

      // Move: retag v1 at a new commit; the plain push must be rejected.
      t.writeFile(t.seedDir, "move.txt", "tag move target\n");
      await t.git(["add", "-A"], { cwd: t.seedDir });
      const cm = await t.git(["commit", "-qm", "tag move commit"], { cwd: t.seedDir, env: {
        GIT_AUTHOR_DATE: "2026-10-22T14:00:00 +0000", GIT_COMMITTER_DATE: "2026-10-22T14:00:00 +0000",
      } });
      if (!cm.ok) {
        t.check("move-commit", false, `git commit failed: ${t.tail(cm.stderr, 200)}`);
        return;
      }
      const newTip = (await t.git(["rev-parse", "HEAD"], { cwd: t.seedDir })).stdout.trim();
      r = await t.git(["tag", "-a", "-f", "v1", "-m", "moved annotated (push-tags-move)"], { cwd: t.seedDir, env: tagEnv });
      if (!r.ok) {
        t.check("tag-recreate", false, `git tag -f failed: ${t.tail(r.stderr, 200)}`);
        return;
      }
      const v1Moved = (await t.git(["rev-parse", "v1"], { cwd: t.seedDir })).stdout.trim();
      const plain = await t.git(["push", url, "v1"], { cwd: t.seedDir });
      t.check("tag-move-rejected", !plain.ok, `plain push of moved tag exit ${plain.code} (expected non-zero)`);
      t.note("tag_move_stderr_tail", t.tail(plain.stderr, 300));
      const forced = await t.git(["push", "-q", "--force", url, "v1"], { cwd: t.seedDir });
      t.expectOk(forced, "tag-force-push-exit", `git push --force v1 exit ${forced.code}`);
      const remote2 = await t.remoteRefs();
      t.check("tag-moved", remote2.refs["refs/tags/v1"] === v1Moved && remote2.refs["refs/tags/v1^{}"] === newTip,
        `refs/tags/v1 = ${remote2.refs["refs/tags/v1"]} (peeled ${remote2.refs["refs/tags/v1^{}"]}), expected ${v1Moved} (peeled ${newTip})`);
      t.collectCwd = t.seedDir;
    },
  },
  {
    id: "push-atomic",
    title: "receive-pack advert: --atomic consistency probe",
    seed: "simple",
    describe: "GIT_TRACE_PACKET push handshake captured into the report; --atomic is consistent with " +
      "its advertisement: advertised => an atomic two-branch push works; unadvertised => the git CLI " +
      "declines client-side (never a partial push)",
    async run(t) {
      if (skipOnTheirs(t)) return;
      const url = t.authUrl;

      // Handshake probe: --dry-run still performs full ref discovery.
      const probe = await t.git(["push", "--dry-run", url, "refs/heads/main:refs/heads/_probe"], {
        cwd: t.seedDir, env: { GIT_TRACE_PACKET: "1" },
      });
      t.expectOk(probe, "advert-probe-exit", `push --dry-run exit ${probe.code}`);
      const caps = parseReceiveCaps(probe.stderr) ?? [];
      t.note("advert_receive_pack_caps", caps);
      t.check("receive-caps-parsed", caps.length > 0, `receive-pack caps = [${caps.join(" ")}]`);
      t.check("receive-delete-refs-advertised", caps.includes("delete-refs"),
        "delete-refs advertised (the :refspec delete family relies on it)");
      const atomicAdvertised = caps.includes("atomic");
      t.note("atomic_advertised", atomicAdvertised);

      if (!atomicAdvertised) {
        // Unadvertised: the client must decline before anything is sent.
        const a = await t.git(["push", "--atomic", url,
          "refs/heads/main:refs/heads/_atomic_a", "refs/heads/main:refs/heads/_atomic_b"], { cwd: t.seedDir });
        t.check("atomic-unadvertised-refused", !a.ok, `push --atomic exit ${a.code} (expected non-zero when unadvertised)`);
        t.check("atomic-refusal-names-flag", ATOMIC_REFUSAL_RE.test(a.stderr),
          "refusal names --atomic (client-side decline, locale-independent)");
        t.note("atomic_stderr_tail", t.tail(a.stderr, 300));
        const remote = await t.remoteRefs();
        t.check("no-partial-atomic-push", !("refs/heads/_atomic_a" in remote.refs) && !("refs/heads/_atomic_b" in remote.refs),
          "neither branch landed (no partial application)");
      } else {
        // Advertised: the atomic two-branch create must work.
        const a = await t.git(["push", "-q", "--atomic", url,
          "refs/heads/main:refs/heads/_atomic_a", "refs/heads/main:refs/heads/_atomic_b"], { cwd: t.seedDir });
        t.expectOk(a, "atomic-push-exit", `push --atomic (advertised) exit ${a.code}`);
        const remote = await t.remoteRefs();
        t.check("atomic-both-branches-created",
          remote.refs["refs/heads/_atomic_a"] === remote.refs["refs/heads/_atomic_b"] && Boolean(remote.refs["refs/heads/_atomic_a"]),
          `both atomic branches created at ${remote.refs["refs/heads/_atomic_a"] ?? "MISSING"}`);
      }
      t.collectCwd = t.seedDir;
    },
  },
];
