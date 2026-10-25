/**
 * Protocol/negotiation family for the differential battery: the deepen-family
 * strict-reject pin, tag/branch negotiation shapes, ls-remote advertisement
 * patterns, fetch --prune, byte-thresholded incremental fetch, and the
 * capability-matrix dump (Round-8: AdvertisedFeature ⇒ ParsedAndHandled,
 * test-generated rather than hand-maintained).
 *
 * Cross-references: docs/design/m3-design-inputs.md Rounds 7-9 (the deepen
 * family + capability matrix), docs/design/p0-evidence.md (probe pattern:
 * exit status + .git/shallow + the ERR pkt-line reject shape).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

import path from "node:path";

import { REMOTE_ERROR_RE } from "./rules.mjs";
import { bulkAppendix, bulkFileContent } from "./seed.mjs";

/** The server's protocol-shaped ERR text for unsupported fetch arguments
 *  (locale-independent server wording, stable since the P0 stopgap). */
const UNSUPPORTED_ARG_RE = /unsupported fetch argument/;

/** Byte thresholds for the incremental-fetch case (calibrated against the
 *  bulk seed: base pack ≈ 51 KiB, 12 incompressible ~6.5 KiB blobs; the
 *  increment is 2 commits + 2 root trees + 2 bulk/ subtrees + 2 blobs, one
 *  of which is a modified blob that a thin-packing server can send as a
 *  REF_DELTA against the clone). */
const INCREMENTAL_MAX_DELTA_BYTES = 48 * 1024;
const INCREMENTAL_MAX_FRACTION = 0.4;
const INCREMENTAL_MAX_RECEIVED = 10;

/** Byte size of every regular file under .git/objects (packs AND loose
 *  objects — a fetch under transfer.unpackLimit unpacks into loose objects
 *  instead of a pack, so the pack dir alone is not a valid delta metric). */
function objectsState(dir) {
  const root = path.join(dir, ".git", "objects");
  const out = { bytes: 0, files: [] };
  const walk = (sub) => {
    for (const e of readdirSync(sub, { withFileTypes: true })) {
      const p = path.join(sub, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = statSync(p);
        out.bytes += st.size;
        out.files.push(`${path.relative(root, p)} ${st.size}`);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** .git/shallow raw content (null when absent — not shallow). */
async function shallowFile(t, cwd) {
  const p = path.join(cwd, ".git", "shallow");
  return existsSync(p) ? readFile(p, "utf8") : null;
}

/** Parse v0 upload-pack advert capabilities from a GIT_TRACE_PACKET stderr:
 *  the first ref line carries them behind a literal `\0` in the trace's
 *  pkt-line rendering. Returns null when the exchange was not v0 upload-pack. */
function parseV0Caps(trace) {
  for (const line of String(trace ?? "").split("\n")) {
    if (/packet:\s+\S+< # service=git-receive-pack/.test(line)) return null;
    const m = line.match(/packet:\s+\S+< \S+ \S+\\0(.*)$/);
    if (m) return m[1].trim().split(/\s+/).filter(Boolean);
  }
  return null;
}

/** Parse a v2 capability advertisement from a GIT_TRACE_PACKET stderr: the
 *  contiguous `git< ` payload block up to the first 0000 flush, deduped. */
function parseV2Caps(trace) {
  const out = [];
  for (const line of String(trace ?? "").split("\n")) {
    const m = line.match(/packet:\s+\S+< (.*)$/);
    if (!m) continue;
    const payload = m[1];
    if (/^0000$/.test(payload)) break;
    out.push(payload.replace(/\r$/, ""));
  }
  return [...new Set(out)];
}

/** The symref-target the ls-refs response carried for HEAD (informational). */
function parseV2HeadSymref(trace) {
  const m = String(trace ?? "").match(/packet:\s+\S+< \S+ HEAD symref-target:(\S+)/);
  return m ? m[1] : null;
}

export const PROTOCOL_CASES = [
  {
    id: "deepen-strict-reject",
    title: "deepen family: strict reject of unsupported modes",
    seed: "history",
    describe:
      "clone --shallow-since/--shallow-exclude and fetch --deepen=1 (deepen-relative) must be " +
      "CLEANLY REJECTED (git exit 128, no repo dir, server ERR pkt-line) or implemented as a " +
      "correct shallow result — a silent full clone or any other terminal state fails. Pins the " +
      "P0-stopgap declared state; shallow-ok is the compatible end-state (Round-8), so the case " +
      "never blocks implementation, only wrong semantics.",
    async run(t) {
      const dir1 = t.join(t.caseDir, "since");
      const r1 = await t.git(["clone", "-q", `--shallow-since=${t.constants.shallowSinceCutoff}`, t.url, dir1]);
      t.note("since_stderr_tail", t.tail(r1.stderr, 300));
      let implemented = 0;
      if (!r1.ok && !existsSync(dir1)) {
        t.check("since-reject-exit-128", r1.code === 128, `exit ${r1.code}, expected 128`);
        t.check("since-reject-no-repo-dir", true, "no repo dir left behind");
        t.check("since-reject-err-pktline", REMOTE_ERROR_RE.test(r1.stderr), "stderr carries the remote-error (ERR pkt-line) signature");
        t.check("since-reject-names-argument", UNSUPPORTED_ARG_RE.test(r1.stderr) && /deepen-since/.test(r1.stderr),
          "ERR names 'deepen-since' as the unsupported fetch argument");
      } else if (r1.ok && existsSync(dir1)) {
        const p = await t.probe(dir1, "since-clone-implemented");
        t.check("since-shallow-boundary", Array.isArray(p.shallow) && p.shallow.length >= 1,
          `.git/shallow = ${JSON.stringify(p.shallow)}, expected >= 1 boundary`);
        t.check("since-implemented-subset", p.commit_count !== null && p.commit_count <= 3 && p.object_count < t.seed.expectedObjects,
          `commits = ${p.commit_count}, objects = ${p.object_count}, expected the shallow subset (<= 3 commits)`);
        implemented++;
        t.note("implemented", "shallow-since honored — battery was pinned to the transitional reject; revisit rule deepen-family-strict-reject");
      } else {
        t.check("since-terminal-shape", false,
          `clone --shallow-since exit ${r1.code}, dir present = ${existsSync(dir1)} — neither clean reject nor implemented shallow`);
      }

      const dir2 = t.join(t.caseDir, "exclude");
      const r2 = await t.git(["clone", "-q", "--shallow-exclude=refs/heads/side", t.url, dir2]);
      t.note("exclude_stderr_tail", t.tail(r2.stderr, 300));
      if (!r2.ok && !existsSync(dir2)) {
        t.check("exclude-reject-exit-128", r2.code === 128, `exit ${r2.code}, expected 128`);
        t.check("exclude-reject-no-repo-dir", true, "no repo dir left behind");
        t.check("exclude-reject-err-pktline", REMOTE_ERROR_RE.test(r2.stderr), "stderr carries the remote-error (ERR pkt-line) signature");
        t.check("exclude-reject-names-argument", UNSUPPORTED_ARG_RE.test(r2.stderr) && /deepen-not/.test(r2.stderr),
          "ERR names 'deepen-not' as the unsupported fetch argument");
      } else if (r2.ok && existsSync(dir2)) {
        const p = await t.probe(dir2, "exclude-clone-implemented");
        t.check("exclude-shallow-boundary", Array.isArray(p.shallow) && p.shallow.length >= 1,
          `.git/shallow = ${JSON.stringify(p.shallow)}, expected >= 1 boundary`);
        t.check("exclude-implemented-subset", p.commit_count !== null && p.commit_count <= 3 && p.object_count < t.seed.expectedObjects,
          `commits = ${p.commit_count}, objects = ${p.object_count}, expected the shallow subset (<= 3 commits)`);
        implemented++;
      } else {
        t.check("exclude-terminal-shape", false,
          `clone --shallow-exclude exit ${r2.code}, dir present = ${existsSync(dir2)} — neither clean reject nor implemented shallow`);
      }

      // The supported path must stay green: depth-1 clone, then --deepen=1
      // (deepen-relative) — the G4 combination: rejected on ours (sticky
      // unsupported mode), the shallow boundary must be UNCHANGED.
      const dir3 = t.join(t.caseDir, "depth");
      const r3 = await t.git(["clone", "-q", "--depth=1", t.url, dir3]);
      t.collectCwd = dir3;
      t.expectOk(r3, "depth1-clone-exit", `git clone --depth=1 exit ${r3.code}`);
      const p3 = await t.probe(dir3, "after-depth1");
      t.check("depth1-boundary", Array.isArray(p3?.shallow) && p3.shallow.length >= 1,
        `.git/shallow = ${JSON.stringify(p3?.shallow)}`);
      t.check("depth1-single-commit", p3?.commit_count === 1, `commit count = ${p3?.commit_count}`);
      const shallowBefore = await shallowFile(t, dir3);
      const d = await t.git(["fetch", "--deepen=1", "origin"], { cwd: dir3 });
      t.note("deepen_stderr_tail", t.tail(d.stderr, 300));
      if (!d.ok) {
        t.check("deepen-reject-exit-128", d.code === 128, `exit ${d.code}, expected 128`);
        t.check("deepen-reject-names-argument", REMOTE_ERROR_RE.test(d.stderr) && UNSUPPORTED_ARG_RE.test(d.stderr) && /deepen-relative/.test(d.stderr),
          "ERR names 'deepen-relative' (the sticky unsupported deepen mode)");
        const shallowAfter = await shallowFile(t, dir3);
        t.check("deepen-reject-shallow-unchanged", shallowAfter === shallowBefore,
          `.git/shallow unchanged after the rejected deepen (G4: no silent depth/full fetch)`);
      } else if (d.ok) {
        const p = await t.probe(dir3, "after-deepen-implemented");
        t.check("deepen-implemented-correct", p?.commit_count === 2,
          `commit count after --deepen=1 = ${p?.commit_count}, expected 2 when implemented`);
        implemented++;
      }

      // --unshallow (supported) restores the full history either way.
      const u = await t.git(["fetch", "-q", "--unshallow", "origin"], { cwd: dir3 });
      t.expectOk(u, "unshallow-exit", `git fetch --unshallow exit ${u.code}`);
      const p4 = await t.probe(dir3, "after-unshallow");
      t.check("unshallow-full-history", p4?.commit_count === t.seed.expectedCommits && p4.shallow === null,
        `commits = ${p4?.commit_count}, .git/shallow = ${JSON.stringify(p4?.shallow)}`);
      const f = await t.git(["fsck", "--strict"], { cwd: dir3 });
      t.expectOk(f, "fsck-after-unshallow", `git fsck --strict exit ${f.code}`);

      // Case outcome: clean-reject pins the current declared state;
      // shallow-ok records that an unsupported mode became implemented
      // (battery green, rule text to revisit). Only a fully-green record
      // earns either — any failed hard check leaves the outcome to the
      // harness (-> fail).
      if (t.record.checks.some((c) => !c.soft && !c.pass)) return;
      if (implemented === 0) t.record.outcome = "clean-reject";
      else t.record.outcome = "shallow-ok";
    },
  },
  {
    id: "clone-tags-notags",
    title: "clone --tags vs --no-tags, advert peeling oids",
    seed: "history",
    describe: "the tag negotiation flags must agree with the advert: --no-tags fetches no local tags, " +
      "--tags does; the advert's peeled refs/tags/v1^{} oid equals v1^{commit} client-side",
    async run(t) {
      const dirT = t.join(t.caseDir, "with-tags");
      const rT = await t.git(["clone", "-q", "--tags", t.url, dirT]);
      t.expectOk(rT, "clone-tags-exit", `git clone --tags exit ${rT.code}`);
      const tagsT = (await t.git(["tag", "-l"], { cwd: dirT })).stdout.trim().split("\n").filter(Boolean).sort();
      t.check("tags-clone-has-v1", tagsT.join(",") === "v1", `git tag -l = [${tagsT.join(", ")}], expected [v1]`);

      const dirN = t.join(t.caseDir, "no-tags");
      const rN = await t.git(["clone", "-q", "--no-tags", t.url, dirN]);
      t.collectCwd = dirN;
      t.expectOk(rN, "clone-notags-exit", `git clone --no-tags exit ${rN.code}`);
      const tagsN = (await t.git(["tag", "-l"], { cwd: dirN })).stdout.trim().split("\n").filter(Boolean);
      t.check("notags-clone-has-no-tags", tagsN.length === 0, `git tag -l = [${tagsN.join(", ")}], expected none`);
      const remotesN = await t.localRefs(dirN);
      t.check("notags-clone-has-branches", "refs/remotes/origin/main" in remotesN && "refs/remotes/origin/side" in remotesN,
        "branch remote-tracking refs still arrive under --no-tags");

      // The advert is unaffected by client flags, and its peeled entry must
      // match the client-side peel of the annotated tag.
      const remote = await t.remoteRefs();
      t.check("advert-has-v1", "refs/tags/v1" in remote.refs, "refs/tags/v1 in ls-remote");
      t.check("advert-has-v1-peeled", "refs/tags/v1^{}" in remote.refs, "peeled refs/tags/v1^{} in ls-remote");
      const v1Obj = (await t.git(["rev-parse", "v1"], { cwd: dirT })).stdout.trim();
      const v1Commit = (await t.git(["rev-parse", "v1^{commit}"], { cwd: dirT })).stdout.trim();
      t.check("advert-tag-oid-is-tag-object", remote.refs["refs/tags/v1"] === v1Obj,
        `advert refs/tags/v1 = ${remote.refs["refs/tags/v1"]}, rev-parse v1 = ${v1Obj}`);
      t.check("advert-peeled-oid-is-commit", remote.refs["refs/tags/v1^{}"] === v1Commit,
        `advert refs/tags/v1^{{}} = ${remote.refs["refs/tags/v1^{}"]}, rev-parse v1^{{commit}} = ${v1Commit}`);
    },
  },
  {
    id: "fetch-single-refspec",
    title: "single-branch clone + explicit single-refspec fetch",
    seed: "history",
    describe: "clone --single-branch brings only main; fetch origin refs/heads/side:refs/heads/side " +
      "materializes exactly that ref at the advertised oid, touching nothing else",
    async run(t) {
      const dir = t.join(t.caseDir, "single");
      const r = await t.git(["clone", "-q", "--single-branch", "--branch", "main", t.url, dir]);
      t.collectCwd = dir;
      t.expectOk(r, "single-branch-clone-exit", `git clone --single-branch exit ${r.code}`);
      const refs0 = await t.localRefs(dir);
      t.check("single-clone-only-main", "refs/remotes/origin/main" in refs0 && !("refs/remotes/origin/side" in refs0),
        `origin/side ${"refs/remotes/origin/side" in refs0 ? "unexpectedly present" : "absent"} after --single-branch`);

      const remote = await t.remoteRefs();
      const sideOid = remote.refs["refs/heads/side"];
      t.check("advert-has-side", Boolean(sideOid), `refs/heads/side = ${sideOid ?? "MISSING"} in ls-remote`);

      const f = await t.git(["fetch", "origin", "refs/heads/side:refs/heads/side"], { cwd: dir });
      t.expectOk(f, "single-refspec-fetch-exit", `git fetch refs/heads/side:refs/heads/side exit ${f.code}`);
      const refs1 = await t.localRefs(dir);
      t.check("side-materialized-at-advertised-oid", refs1["refs/heads/side"] === sideOid,
        `local refs/heads/side = ${refs1["refs/heads/side"]}, advertised ${sideOid}`);
      t.check("main-untouched", refs1["refs/remotes/origin/main"] === refs0["refs/remotes/origin/main"],
        "the single-refspec fetch did not move origin/main");
      t.check("no-remote-tracking-for-side", !("refs/remotes/origin/side" in refs1),
        "an explicit refspec fetch creates no remote-tracking ref (stock git behavior)");
      const fs = await t.git(["fsck", "--strict"], { cwd: dir });
      t.expectOk(fs, "fsck-after-fetch", `git fsck --strict exit ${fs.code}`);
    },
  },
  {
    id: "ls-remote-patterns",
    title: "ls-remote advertisement patterns",
    seed: "history",
    describe: "full listing, --heads/--tags filtering, exact + glob patterns, --exit-code on a miss, --symref",
    async run(t) {
      // git ls-remote [options] <repository> [<patterns>...]: options before
      // the URL, patterns after it.
      const ls = async (opts, patterns = []) =>
        await t.git(["ls-remote", ...opts, t.url, ...patterns], { cwd: t.caseDir });
      const names = (r) => r.stdout.split("\n").filter(Boolean).map((l) => l.trim().split(/\s+/, 2)[1]).filter(Boolean);

      const all = await ls([]);
      t.expectOk(all, "ls-remote-exit", `ls-remote exit ${all.code}`);
      const allNames = names(all).sort();
      t.check("advert-exact-ref-set",
        JSON.stringify(allNames) === JSON.stringify(["HEAD", "refs/heads/main", "refs/heads/side", "refs/tags/v1", "refs/tags/v1^{}"]),
        `advert = [${allNames.join(", ")}]`);

      const heads = await ls(["--heads"]);
      t.check("heads-only", JSON.stringify(names(heads).sort()) === JSON.stringify(["refs/heads/main", "refs/heads/side"]),
        `--heads = [${names(heads).join(", ")}]`);
      const tags = await ls(["--tags"]);
      t.check("tags-only", JSON.stringify(names(tags).sort()) === JSON.stringify(["refs/tags/v1", "refs/tags/v1^{}"]),
        `--tags = [${names(tags).join(", ")}]`);

      const exact = await ls([], ["refs/heads/main"]);
      t.check("exact-pattern-single-line", exact.ok && names(exact).join(",") === "refs/heads/main",
        `pattern refs/heads/main -> [${names(exact).join(", ")}]`);
      const glob = await ls([], ["refs/tags/v*"]);
      t.check("glob-pattern-peeled", glob.ok && JSON.stringify(names(glob).sort()) === JSON.stringify(["refs/tags/v1", "refs/tags/v1^{}"]),
        `pattern refs/tags/v* -> [${names(glob).join(", ")}]`);

      const miss = await ls(["--exit-code"], ["refs/heads/absent"]);
      t.check("miss-exit-2-empty", !miss.ok && miss.code === 2 && miss.stdout.trim() === "",
        `--exit-code on a miss: exit ${miss.code}, stdout ${miss.stdout.trim() ? "non-empty" : "empty"} (expected 2 + empty)`);

      const symref = await ls(["--symref"], ["HEAD"]);
      t.expectOk(symref, "symref-exit", `ls-remote --symref HEAD exit ${symref.code}`);
      const first = symref.stdout.split("\n")[0] ?? "";
      t.check("symref-line-shape", /^ref: refs\/heads\/\S+\tHEAD$/.test(first.trim()),
        `first line = ${JSON.stringify(first)} (HEAD target is informational, head-default-branch-info rule)`);
    },
  },
  {
    id: "fetch-prune",
    title: "fetch --prune after upstream delete",
    seed: "simple",
    describe: "a deleted upstream branch keeps its stale remote-tracking ref until fetch --prune removes it",
    async run(t) {
      await t.git(["branch", "extra"], { cwd: t.seedDir });
      const push = await t.git(["push", "-q", t.authUrl, "main", "extra"], { cwd: t.seedDir });
      t.expectOk(push, "setup-push-exit", `push main+extra exit ${push.code}`);

      const dir = t.join(t.caseDir, "clone");
      const clone = await t.git(["clone", "-q", t.url, dir]);
      t.collectCwd = dir;
      t.expectOk(clone, "clone-exit", `git clone exit ${clone.code}`);
      const refs0 = await t.localRefs(dir);
      t.check("origin-extra-present", "refs/remotes/origin/extra" in refs0, "refs/remotes/origin/extra after clone");

      const del = await t.git(["push", "-q", t.authUrl, ":refs/heads/extra"], { cwd: t.seedDir });
      t.expectOk(del, "upstream-delete-exit", `push :refs/heads/extra exit ${del.code}`);
      const remote = await t.remoteRefs();
      t.check("upstream-gone", !("refs/heads/extra" in remote.refs), "refs/heads/extra gone from the advert");

      const refs1 = await t.localRefs(dir);
      t.check("stale-tracking-ref-remains", "refs/remotes/origin/extra" in refs1,
        "the stale remote-tracking ref survives until --prune (stock git behavior)");
      const pr = await t.git(["fetch", "--prune", "origin"], { cwd: dir });
      t.expectOk(pr, "prune-fetch-exit", `git fetch --prune exit ${pr.code}`);
      const refs2 = await t.localRefs(dir);
      t.check("pruned", !("refs/remotes/origin/extra" in refs2), "refs/remotes/origin/extra gone after --prune");
      t.check("main-survives-prune", "refs/remotes/origin/main" in refs2, "refs/remotes/origin/main intact");
      const fs = await t.git(["fsck"], { cwd: dir });
      t.expectOk(fs, "fsck-after-prune", `git fsck exit ${fs.code}`);
    },
  },
  {
    id: "incremental-bulk-fetch",
    title: "clone-then-fetch transfers only the delta (byte threshold)",
    seed: "bulk",
    describe: "two server-side commits over a ~60 KiB history; the second fetch must move a small pack " +
      "(byte threshold + fraction of the base pack), few objects (negotiated haves), and fsck clean; " +
      "thin-pack REF_DELTA usage in the new pack is recorded (server-optional, informational)",
    async run(t) {
      const dir = t.join(t.caseDir, "c");
      const r = await t.git(["clone", "-q", "--progress", t.url, dir]);
      t.collectCwd = dir;
      t.expectOk(r, "clone-exit", `git clone exit ${r.code}`);
      const base = await t.probe(dir, "after-clone");
      t.check("base-object-count", base?.object_count === t.seed.expectedObjects,
        `full clone objects = ${base?.object_count}, expected ${t.seed.expectedObjects}`);
      const before = objectsState(dir);
      t.note("base_objects_bytes", before.bytes);
      t.note("base_objects_files", before.files);
      if (base?.object_count !== t.seed.expectedObjects) return;

      // Server-side increment: add bulk/f13, then append the deterministic
      // appendix to bulk/f12 (fixed dates -> deterministic oids).
      t.writeFile(t.seedDir, "bulk/f13", bulkFileContent(13));
      let c = await t.git(["add", "-A"], { cwd: t.seedDir });
      let m = await t.git(["commit", "-qm", "bulk increment one (f13)"], { cwd: t.seedDir, env: {
        GIT_AUTHOR_DATE: "2026-10-22T09:00:00 +0000", GIT_COMMITTER_DATE: "2026-10-22T09:00:00 +0000",
      } });
      if (!c.ok || !m.ok) {
        t.check("server-commit-1", false, `seed worktree commit failed: ${t.tail((c.stderr || "") + (m.stderr || ""), 200)}`);
        return;
      }
      t.writeFile(t.seedDir, "bulk/f12", bulkFileContent(12) + bulkAppendix);
      await t.git(["add", "-A"], { cwd: t.seedDir });
      m = await t.git(["commit", "-qm", "bulk increment two (f12 appendix)"], { cwd: t.seedDir, env: {
        GIT_AUTHOR_DATE: "2026-10-22T10:00:00 +0000", GIT_COMMITTER_DATE: "2026-10-22T10:00:00 +0000",
      } });
      if (!m.ok) {
        t.check("server-commit-2", false, `seed worktree commit failed: ${t.tail(m.stderr, 200)}`);
        return;
      }
      const push = await t.git(["push", "-q", t.authUrl, "main"], { cwd: t.seedDir });
      t.expectOk(push, "server-push-exit", `server-side push exit ${push.code}`);

      const f = await t.git(["fetch", "--progress", "origin"], { cwd: dir });
      t.expectOk(f, "incremental-fetch-exit", `git fetch exit ${f.code}`);
      const counts = t.parseFetchProgress(f.stderr);
      const after = await t.probe(dir, "after-fetch");
      const state = objectsState(dir);
      const deltaBytes = state.bytes - before.bytes;
      const newObjects = state.files.filter((x) => !before.files.includes(x));
      const newPacks = newObjects.filter((x) => x.includes("pack-"));
      t.note("delta_bytes", deltaBytes);
      t.note("delta_new_object_files", newObjects.length);
      t.note("delta_new_pack_files", newPacks);
      t.note("delta_loose_objects", newObjects.length - newPacks.length);
      t.note("fetch_enumerated", counts.enumerated);
      t.note("fetch_received", counts.received);

      const smallness = counts.received ?? counts.serverTotal ?? counts.enumerated;
      t.check("received-only-delta-objects", smallness !== null && smallness > 0 && smallness <= INCREMENTAL_MAX_RECEIVED,
        `incremental object signal = ${smallness} (expected 8: 2 commits + 2 trees + 2 subtrees + 2 blobs; <= ${INCREMENTAL_MAX_RECEIVED})`);
      t.check("delta-byte-threshold", deltaBytes > 0 && deltaBytes <= INCREMENTAL_MAX_DELTA_BYTES,
        `object-store growth = ${deltaBytes} bytes, threshold ${INCREMENTAL_MAX_DELTA_BYTES} (base ${before.bytes})`);
      t.check("delta-byte-fraction", before.bytes > 0 && deltaBytes <= before.bytes * INCREMENTAL_MAX_FRACTION,
        `object-store growth = ${deltaBytes} bytes <= ${INCREMENTAL_MAX_FRACTION} of base ${before.bytes} bytes (a full re-send would be ~${before.bytes})`);
      t.check("object-count-after-fetch", after?.object_count === t.seed.expectedObjects + 8,
        `objects after fetch = ${after?.object_count}, expected ${t.seed.expectedObjects + 8}`);

      // REF_DELTA reliance is server-optional (a non-thin small pack is
      // legal), and a fetch under transfer.unpackLimit unpacks loose
      // client-side (no pack at all) — so this is recorded, not asserted.
      const newPackPath = newPacks.length > 0 ? path.join(dir, ".git", "objects", newPacks[0].split(" ")[0]) : null;
      if (newPackPath && newPackPath.endsWith(".pack") && existsSync(newPackPath)) {
        const vp = await t.git(["verify-pack", "-v", newPackPath], { cwd: dir });
        const deltaEntries = vp.stdout.split("\n").filter((l) => /^\S+ (blob|tree|commit) \d+ \d+ \d+ \d+ \S+$/.test(l.trim()));
        t.note("ref_delta_entries_in_new_pack", deltaEntries.length);
        t.note("ref_delta_note", deltaEntries.length > 0
          ? "new pack carries delta objects (thin pack / REF_DELTA against negotiated bases)"
          : "new pack has no delta objects — non-thin small pack, acceptable");
      }

      const mg = await t.git(["merge", "-q", "--ff-only", "origin/main"], { cwd: dir });
      t.expectOk(mg, "ff-merge-exit", `merge --ff-only exit ${mg.code}`);
      const fs = await t.git(["fsck", "--strict"], { cwd: dir });
      t.expectOk(fs, "fsck-after-incremental-fetch", `git fsck --strict exit ${fs.code}`);
    },
  },
  {
    id: "advert-capability-matrix",
    title: "capability-matrix dump: v0+v2 handshake advertisements",
    seed: "history",
    describe: "GIT_TRACE_PACKET handshakes for both protocol versions are parsed into the report " +
      "(advertised capability lines per endpoint — the Round-8 test-generated matrix input); asserts: " +
      "version lines parse, ours NEVER advertises filter, ours advertises the agent capability in " +
      "git's key=value convention (agent=<name>/<version>), and advertised shallow implies the deepen " +
      "family is handled-or-rejected (proven in-place with a depth-1 probe)",
    async run(t) {
      const isOurs = t.endpointKind === "ours";

      // v2 handshake.
      const v2 = await t.git(["-c", "protocol.version=2", "ls-remote", t.url], { cwd: t.caseDir, env: { GIT_TRACE_PACKET: "1" } });
      t.expectOk(v2, "v2-ls-remote-exit", `protocol v2 ls-remote exit ${v2.code}`);
      const v2Caps = parseV2Caps(v2.stderr);
      t.note("advert_v2_caps", v2Caps);
      t.note("advert_v2_head_symref", parseV2HeadSymref(v2.stderr));
      t.check("v2-version-line", v2Caps.includes("version 2"), `v2 advert = [${v2Caps.join(" | ")}]`);
      const v2FetchArgs = (v2Caps.find((l) => l.startsWith("fetch=")) ?? "").split("=").slice(1).join("=").split(/\s+/).filter(Boolean);
      t.note("advert_v2_fetch_args", v2FetchArgs);

      // v0 handshake.
      const v0 = await t.git(["-c", "protocol.version=0", "ls-remote", t.url], { cwd: t.caseDir, env: { GIT_TRACE_PACKET: "1" } });
      t.expectOk(v0, "v0-ls-remote-exit", `protocol v0 ls-remote exit ${v0.code}`);
      const v0Caps = parseV0Caps(v0.stderr) ?? [];
      t.note("advert_v0_caps", v0Caps);
      t.check("v0-caps-present", v0Caps.length > 0, `v0 caps = [${v0Caps.join(" ")}]`);

      const capTokens = new Set([...v0Caps, ...v2Caps.flatMap((l) => l.split("=")[0].split(/\s+/)), ...v2FetchArgs]);
      const filterAdvertised = capTokens.has("filter");
      const shallowAdvertised = capTokens.has("shallow") || v2FetchArgs.includes("shallow");
      t.note("filter_advertised", filterAdvertised);
      t.note("shallow_advertised", shallowAdvertised);
      // git convention: the agent capability is a key=value token
      // (agent=<name>/<version>) in both the v2 capability advert and the v0
      // capability list. Ours used to advertise a bare `dgit/0.3` token
      // (differential-matrix quirk, recorded 2026-10-25, fixed in the engine);
      // the key=value form is the recorded expectation, asserted on ours below.
      const agentToken = [...v0Caps, ...v2Caps].find((c) => /^agent=/.test(c)) ?? null;
      t.note("agent_token", agentToken);

      // THE Round-8 assertion: unadvertised-and-rejected beats
      // plausible-but-wrong — ours must never advertise filter (partial
      // clone is not implemented; advertising it would invite silent
      // wrong-semantics fetches).
      if (isOurs) {
        t.check("ours-never-advertises-filter", !filterAdvertised,
          `filter in advert: v0 caps = [${v0Caps.filter((c) => c === "filter").join("")}], v2 fetch args = [${v2FetchArgs.join(" ")}]`);
        t.check("ours-advertises-agent-key-value", agentToken !== null && /^agent=[^/\s]+\/\S/.test(agentToken),
          `agent capability = ${String(agentToken)} — expected the key=value form agent=<name>/<version> per git convention`);
      } else {
        t.note("filter_check_scope", "the never-advertise-filter assertion applies to ours only; this endpoint's advert is recorded for the matrix");
      }

      // Advertised shallow ⇒ the deepen family is handled-or-rejected,
      // proven in-place: a depth-1 clone must shallow-clone correctly or
      // fail with a protocol-shaped reject — never a silent full clone.
      if (shallowAdvertised) {
        const dir = t.join(t.caseDir, "depth-probe");
        const c = await t.git(["clone", "-q", "--depth=1", t.url, dir]);
        if (c.ok) {
          const p = await t.probe(dir, "shallow-implication-probe");
          t.check("shallow-advertised-implies-handled", Array.isArray(p?.shallow) && p.shallow.length >= 1,
            `depth-1 clone exit 0 but .git/shallow = ${JSON.stringify(p?.shallow)} — advertised shallow with silent full-clone semantics`);
        } else if (REMOTE_ERROR_RE.test(c.stderr)) {
          t.check("shallow-advertised-implies-handled", true,
            "depth-1 clone cleanly rejected (protocol-shaped ERR) — handled-by-rejection");
        } else {
          t.check("shallow-advertised-implies-handled", false,
            `depth-1 clone failed without a protocol-shaped error: exit ${c.code}, ${t.tail(c.stderr, 160)}`);
        }
      }
    },
  },
];
