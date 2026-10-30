// readTag gate — the P3-11 annotated-tag read RPC (cf-gitea
// docs/residuals-v1.3.2.md item 11). Run with tsx (see e2e/README.md for the
// invocation pattern):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-tag-read.mjs
// Exits non-zero on the first violated assertion.
//
// What makes this honest: the RPC is the REAL RepoCell.readTag over a real
// GitStore (node:sqlite) whose objects/refs come from a REAL git fixture
// repository (the check-tree-commits.mjs seeding), and the ORACLE for the
// message field is real git — `git for-each-ref --format=%(contents)` for the
// unsigned annotated tag (git's own payload rendering), plus a HANDCRAFTED
// signed-armor tag object (hash-object -w -t tag) pinning the armor-strip
// against upstream's parsePayloadSignature discipline (modules/git/tag.go:29-57:
// upstream strips the signature from every tag payload it reads — the API
// message field excludes it).
//
// Covers, in order:
//   1.  the annotated tag's full TagJson: oid = the ref tip, object = the
//       tagged commit, type/tag/tagger parsed, message verbatim, with
//       `git for-each-ref %(contents)` as the message oracle.
//   2.  the signed-armor tag: message EXCLUDES the armor block (the last
//       full BEGIN/END pair wins), signature-side bytes never leak into the
//       message.
//   3.  splitTagSignature unit arms: no block → payload verbatim; a BEGIN
//       without a matching END → payload verbatim (an unterminated block is
//       not a signature).
//   4.  the null ladder: a lightweight tag's commit tip, a bare commit oid, a
//       tree oid, a blob oid, and a missing oid all answer null (the
//       readCommit posture).
//   5.  a tag-of-tag chain: the OUTER tag reads back with type "tag" and
//       object = the inner tag oid, and readCommit still peels the chain to
//       the commit (the peel cache path is untouched).
//   6.  ONE store.get per readTag — no peel walk, no tag-chain re-read.
//   7.  static tripwire (the check-tree-commits.mjs convention): readTag's
//       body parses via parseTag, strips via splitTagSignature exactly once,
//       and never calls peelToCommit.
import { register } from "node:module";

// repo.ts extends DurableObject at module scope — the inert shim (the DO is
// constructed below with a fake ctx/env, same as check-tree-commits.mjs).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, assertEq, git, loadGitRepoIntoStore, makeStore, scratchDir } from "./helpers/lib.mjs";

let planned = 0;
const failures = [];
async function check(name, fn) {
  planned++;
  try {
    await fn();
    console.log(`ok: ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- the real cell over a real store (check-tree-commits.mjs's shape) --------

async function contentCell(t) {
  const { RepoCell } = await import("../src/repo.ts");
  const cell = new RepoCell(
    { storage: { sql: t.sql, transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } },
    {}
  );
  cell.env = {};
  cell.ctx = { storage: { transactionSync: (fn) => fn(), setAlarm: () => Promise.resolve() } };
  t.store.setMeta("repo", "r0");
  return cell;
}

async function makeCell(fixtureDir) {
  const t = makeStore();
  loadGitRepoIntoStore(t, fixtureDir);
  return { t, cell: await contentCell(t) };
}

// ---- fixture: commits, an annotated tag, a signed-armor tag, a chain ---------

function buildTagFixture() {
  const dir = scratchDir("tag-read-");
  git(dir, "init -q -b main");
  writeFileSync(join(dir, "README.md"), "# tag-read\n");
  git(dir, "add -A");
  git(dir, `commit -aqm ${JSON.stringify("c1 base")}`, {
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00",
  });
  writeFileSync(join(dir, "a.txt"), "a1\n");
  git(dir, "add -A");
  git(dir, `commit -aqm ${JSON.stringify("c2 content")}`, {
    GIT_COMMITTER_DATE: "2026-01-02T00:00:00",
    GIT_AUTHOR_DATE: "2026-01-02T00:00:00",
  });
  const commit = git(dir, "rev-parse HEAD");

  // unsigned annotated tag, multi-paragraph message (two -m paragraphs — git
  // joins them with a blank line and appends the trailing newline; the git()
  // helper pins user.name=t user.email=t, and GIT_COMMITTER_DATE with an
  // EXPLICIT offset pins the tagger time + tz deterministically: shell
  // double-quotes never interpret \n escapes, so a literal \n inside -m
  // would corrupt the message)
  git(dir, `tag -a v1 -m "v1 release" -m "body line"`, { GIT_COMMITTER_DATE: "2026-01-03T00:00:00+0000" });
  const contentsOracle = git(dir, `for-each-ref --format="%(contents)" refs/tags/v1`);
  const v1TaggerTime = Math.floor(Date.parse("2026-01-03T00:00:00+00:00") / 1000);

  // handcrafted SIGNED tag object: the armor block upstream strips
  // (hash-object -w accepts arbitrary tag bytes; update-ref lands the ref;
  // the payload rides a file — the helper's execSync has no stdin channel)
  const signedPayload = [
    `object ${commit}`,
    "type commit",
    "tag signed-tag",
    "tagger t <t@t> 1767225600 +0000",
    "",
    "release notes",
    "",
    "-----BEGIN FAKE SIGNATURE-----",
    "armor line",
    "-----END FAKE SIGNATURE-----",
    "",
  ].join("\n");
  const payloadFile = join(dir, ".signed-tag-payload");
  writeFileSync(payloadFile, signedPayload);
  const signedOid = git(dir, `hash-object -t tag -w --stdin < ${JSON.stringify(payloadFile)}`);
  if (!/^[0-9a-f]{40}$/.test(signedOid)) throw new Error("hash-object failed for the signed tag");
  git(dir, `update-ref refs/tags/signed-tag ${signedOid}`);

  // a tag pointing at the TAG OBJECT (the chain readCommit must still peel)
  const v1Oid = git(dir, "rev-parse refs/tags/v1");
  git(dir, `tag -a outer -m "outer of v1" ${v1Oid}`, { GIT_COMMITTER_DATE: "2026-01-04T00:00:00+0000" });
  // a lightweight tag (a commit tip — readTag answers null for it)
  git(dir, "tag light HEAD");

  return { dir, commit, contentsOracle, signedOid, v1TaggerTime };
}

const FIXTURE = buildTagFixture();

// the object bytes of a tag ref straight from git (the source of truth)
function tagPayload(dir, ref) {
  return git(dir, `cat-file tag ${ref}`);
}

// ---- the checks ---------------------------------------------------------------

await check("1. annotated tag: full TagJson with git's %(contents) as the message oracle", async () => {
  const { cell } = await makeCell(FIXTURE.dir);
  const refs = await cell.listRefs();
  const tip = refs.refs.find((r) => r.name === "refs/tags/v1");
  assert(tip !== undefined, "v1 ref present");
  assert(tip.peeled !== undefined && tip.peeled === FIXTURE.commit, "the refs row peels to the commit");
  const tag = await cell.readTag(tip.target);
  assert(tag !== null, "readTag answers the annotated tip");
  assertEq(tag.oid, tip.target, "oid = the tag object (the refs-row target)");
  assertEq(tag.object, FIXTURE.commit, "object header = the tagged commit");
  assertEq(tag.type, "commit", "type header");
  assertEq(tag.tag, "v1", "tag header");
  assert(tag.tagger !== null, "tagger parsed");
  assertEq(tag.tagger.name, "t", "tagger name (the harness git identity)");
  assertEq(tag.tagger.email, "t@t", "tagger email");
  assertEq(tag.tagger.time, FIXTURE.v1TaggerTime, "tagger time = the GIT_COMMITTER_DATE stamp");
  assertEq(tag.tagger.tz, "+0000", "tagger tz");
  // the helper trims the exec output (git's own payload rendering loses only
  // the trailing newline the format's line terminator shares)
  assertEq(tag.message, `${FIXTURE.contentsOracle}\n`, "message equals git for-each-ref %(contents)");
  assertEq(tag.message, "v1 release\n\nbody line\n", "multi-paragraph payload verbatim");
  // parity control: readCommit still peels the same tip to the commit
  const peeled = await cell.readCommit(tip.target);
  assert(peeled !== null && peeled.oid === FIXTURE.commit, "readCommit peels through (untouched)");
});

await check("2. signed-armor tag: the message excludes the signature block (upstream parsePayloadSignature)", async () => {
  const { cell } = await makeCell(FIXTURE.dir);
  const refs = await cell.listRefs();
  const tip = refs.refs.find((r) => r.name === "refs/tags/signed-tag");
  assert(tip !== undefined, "signed-tag ref present");
  assertEq(tip.target, FIXTURE.signedOid, "the refs tip is the crafted object");
  const tag = await cell.readTag(tip.target);
  assert(tag !== null, "readTag answers the crafted tag");
  assertEq(tag.message, "release notes\n", "armor stripped, trailing newline kept");
  assert(!tag.message.includes("FAKE"), "no armor bytes in the message");
  assert(!tag.message.includes("armor line"), "no signature-body bytes in the message");
  // the raw object still carries the armor (the strip did not lose data —
  // git's own view of the object agrees with our parse of its payload)
  const raw = tagPayload(FIXTURE.dir, "refs/tags/signed-tag");
  assert(raw.includes("-----BEGIN FAKE SIGNATURE-----"), "the stored object keeps the armor");
});

await check("3. splitTagSignature arms: verbatim without a block; unterminated block is not a signature", async () => {
  const { splitTagSignature } = await import("../src/git/objects.ts");
  assertEq(splitTagSignature("plain message\n"), { message: "plain message\n", signature: null }, "no block");
  const unterminated = "msg\n\n-----BEGIN PGP SIGNATURE-----\narmor\n";
  assertEq(
    splitTagSignature(unterminated),
    { message: unterminated, signature: null },
    "BEGIN without END stays in the message"
  );
  const withSig = "msg\n-----BEGIN PGP SIGNATURE-----\narmor\n-----END PGP SIGNATURE-----";
  const split = splitTagSignature(withSig);
  assertEq(split.message, "msg", "the preceding newline rides the signature side");
  assertEq(split.signature, "-----BEGIN PGP SIGNATURE-----\narmor\n-----END PGP SIGNATURE-----", "the block verbatim");
});

await check("4. null ladder: lightweight tip / commit / tree / blob / missing", async () => {
  const { cell } = await makeCell(FIXTURE.dir);
  const refs = await cell.listRefs();
  const light = refs.refs.find((r) => r.name === "refs/tags/light");
  assert(light !== undefined && light.peeled === undefined, "light is a lightweight tip (no peel)");
  assertEq(await cell.readTag(light.target), null, "a commit tip is not a tag object");
  assertEq(await cell.readTag(FIXTURE.commit), null, "a bare commit oid answers null");
  const treeOid = git(FIXTURE.dir, "rev-parse HEAD^{tree}");
  assertEq(await cell.readTag(treeOid), null, "a tree oid answers null");
  const blobOid = git(FIXTURE.dir, "rev-parse HEAD:README.md");
  assertEq(await cell.readTag(blobOid), null, "a blob oid answers null");
  assertEq(await cell.readTag("1234567890123456789012345678901234567890"), null, "a missing oid answers null");
});

await check("5. tag-of-tag chain: the outer tag reads back with type tag; readCommit still peels to the commit", async () => {
  const { cell } = await makeCell(FIXTURE.dir);
  const refs = await cell.listRefs();
  const outer = refs.refs.find((r) => r.name === "refs/tags/outer");
  assert(outer !== undefined, "outer ref present");
  const outerTag = await cell.readTag(outer.target);
  assert(outerTag !== null, "readTag answers the outer tag");
  assertEq(outerTag.type, "tag", "the outer tag's object is a TAG object");
  const v1Tip = refs.refs.find((r) => r.name === "refs/tags/v1");
  assertEq(outerTag.object, v1Tip.target, "the chain points at the inner tag object");
  // and the peel path through a tag-of-tag still reaches the commit
  const peeled = await cell.readCommit(outer.target);
  assert(peeled !== null && peeled.oid === FIXTURE.commit, "readCommit peels the whole chain (untouched)");
});

await check("6. ONE store.get per readTag — no peel walk, no chain re-read", async () => {
  const { t, cell } = await makeCell(FIXTURE.dir);
  const refs = await cell.listRefs();
  const tip = refs.refs.find((r) => r.name === "refs/tags/v1");
  let reads = 0;
  const orig = cell.store.get.bind(cell.store);
  cell.store.get = (...args) => {
    reads++;
    return orig(...args);
  };
  const tag = await cell.readTag(tip.target);
  assert(tag !== null, "readTag answered");
  assertEq(reads, 1, "exactly one object read (loose read; the peel cache is not consulted)");
});

await check("7. static tripwire: parseTag + splitTagSignature once, never peelToCommit", async () => {
  const src = readFileSync(fileURLToPath(new URL("../src/repo.ts", import.meta.url)), "utf8");
  const body = src.slice(src.indexOf("async readTag("), src.indexOf("async listLog("));
  assert(body.includes("parseTag("), "readTag parses via the vendored parseTag");
  assertEq(body.split("splitTagSignature(").length - 1, 1, "exactly one signature-strip call site");
  assert(!body.includes("peelToCommit"), "readTag never peels");
});

console.log(`\ncheck-tag-read: ${planned - failures.length}/${planned} checks passed`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
