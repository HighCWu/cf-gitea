// scanLfsPointers RPC gate — SPEC-0015 §3.3 M3 (the census R11 boundary:
// upstream's settings-lfs pointers list, whose handler renders lfs.PointerBlob
// from lfs.SearchPointerBlobs — pointer_scanner.go:31's 4-stage pipeline,
// size-gate first / parse second). Run with tsx (see e2e/README.md):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-lfs-pointers.mjs
// Exits non-zero on any failed check.
//
// What makes this honest: the RPC is the REAL RepoCell.scanLfsPointers over a
// real GitStore (node:sqlite) seeded from REAL git fixtures, and the ORACLE is
// real git over the same fixture running the SAME pipeline stages ours runs —
// `git ls-tree -r -l` (stage 1+2: every tree entry + its blob size, the
// typeAndSize analog) with the ≤1024 gate applied (stage 3:
// BlobsLessThan1024FromCatFileBatchCheck's `size > 1024 → skip`, catfile.go:
// 49-51 — the name says "LessThan", the code keeps ≤, ours matches the CODE)
// and `git cat-file blob` for the raw bytes (stage 4's read). The PARSE stage
// is deliberately absent on BOTH sides: the ratified posture (SPEC §2.3) keeps
// the engine pointer-grammar-agnostic — it returns candidate bytes RAW and the
// worker parses with the landed parsePointer — so the oracle diff is the
// size-gated CANDIDATE SET, not a pointer list. A hand-crafted canonical
// pointer's git sha1 identity (sha1("blob <n>\0" + canonical text) — the
// landed pointerBlobSha1 recipe, SPEC-0006 §3.4) is verified against the
// fixture's real oid to pin the FindLFSFile consumer recipe for opts.oid.
//
// Pinned interpretation (ledger-ready): opts.oid filters on the GIT blob oid —
// the grammar-free reading of §3.3's "post-filters to that exact LFS oid AFTER
// parsing": the engine cannot compare the LFS sha256 INSIDE the bytes without
// a parser (exactly what §2.3 forbids). The canonical-pointer identity check
// pins the worker-side recipe: derive the target's git oid via pointerBlobSha1
// and pass it here; non-canonical pointers post-filter after the worker's own
// parse (the bytes are in the answer).
//
// Pinned divergences (ledger-ready):
//   - candidates are SIZE-gated, never content-gated: binary blobs and small
//     non-pointer text ride along for the worker to reject (upstream's
//     scanner parses inside the pipeline and emits only valid pointers).
//   - honest truncation: upstream's pipeline has no cap (a huge repo scans
//     whole, bounded only by the 30s-class git process); ours caps visited
//     entries at 20000 and rows at 500 and flags `truncated` — filling the
//     row cap EXACTLY is NOT truncation (a proven further candidate is).
//
// Covers, in order:
//   1.  candidate-set exactness vs `git ls-tree -r -l` + the ≤1024 gate: the
//       full run deep-equals the oracle rows (path/oid/size, tree order);
//       ref/commit/truncated fields; the 1024/1025 gate boundary pins ≤.
//   2.  raw bytes: every candidate's data byte-identical to `git cat-file
//       blob <oid>`; Uint8Array; byteLength === size; the two crafted
//       pointers carry their exact canonical text.
//   3.  size-gated, not content-gated: the binary blob and the plain
//       non-pointer files are candidates too (the worker rejects them; the
//       engine must not).
//   4.  the path-prefix arm: equals the full run sliced to the prefix (and
//       the ls-tree slice); a path pointing AT a file narrows to one row;
//       a non-matching path is the valid empty answer, not null, not
//       truncated.
//   5.  the oid arm (git blob oid): exact match → exactly that path; an
//       unknown oid → empty; the canonical-pointer identity (pointerBlobSha1
//       recipe) verified against the fixture and used as the FindLFSFile
//       query; an LFS sha256 (not a git oid) matches nothing.
//   6.  the candidates cap: 505 small files → 500 rows, truncated, and the
//       500 are the exact-500 run's tree-order prefix (the cap slices a
//       stable prefix, never an arbitrary set).
//   7.  exactly 500 candidates → truncated === false (filling the cap is not
//       truncation).
//   8.  the visited cap (MAX_LFS_SCAN_FILES): 20001 oversize entries →
//       candidates === [], truncated === true — the visited arm is its own
//       budget exit, independent of the row cap.
//   9.  null arms: unresolvable ref, empty repo (unborn HEAD); a budget exit
//       is never null (checks 6/8 pin the other ladder rung).
//   10. static tripwire (the check-grep.mjs convention): the RPC rides
//       rpcBind + withContentLease + resolveRef/peelToCommit and names its
//       three budget constants; LfsPointerScanResult is declared on repo.ts.
import { register } from "node:module";

// repo.ts extends DurableObject at module scope — the inert shim (the DO is
// constructed below with a fake ctx/env, same as check-grep.mjs).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

import { mkdirSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assert, assertEq, commitOid, git, loadGitRepoIntoStore, makeStore, scratchDir } from "./helpers/lib.mjs";

let planned = 0;
let failed = 0;
async function check(n, name, fn) {
  planned++;
  try {
    await fn();
    console.log(`CHECK ${n} PASS: ${name}`);
  } catch (err) {
    failed++;
    console.log(`CHECK ${n} FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- the real cell over a real store (check-grep.mjs's shape) ----------------

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

// ---- fixtures -----------------------------------------------------------------

// deterministic LFS oids — 64 lowercase hex chars each (the pointer.go grammar)
const LFS_OID_A = "a".repeat(64);
const LFS_OID_B = "b".repeat(64);
const LFS_OID_C = "c".repeat(64);
const POINTER_TEXT_A = `version https://git-lfs.github.com/spec/v1\noid sha256:${LFS_OID_A}\nsize 123456\n`;
const POINTER_TEXT_B = `version https://git-lfs.github.com/spec/v1\noid sha256:${LFS_OID_B}\nsize 789\n`;

// the rich mixed tree (checks 1-5, 9): real pointer files beside small text,
// a small binary, a symlink, the 1024/1025 gate boundary, and two oversize
// files — one pointer-shaped, one plain — the gate must exclude unseen
function buildRichFixture() {
  const dir = scratchDir("lfs-rich-");
  git(dir, "init -q -b main");
  const f = (name, content) => {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  };
  f("assets/model.lfs.ptr", POINTER_TEXT_A);
  f("assets/other.lfs.ptr", POINTER_TEXT_B);
  f("README.md", "cf-gitea re-serves the Gitea UI on Cloudflare Workers\n");
  f("src/main.ts", "export const main = true;\n");
  writeFileSync(join(dir, "logo.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x0a, 0x62, 0x69, 0x6e, 0x00]));
  // a symlink is a blob entry (mode 120000) — size-gated like any other
  mkdirSync(join(dir, "docs"), { recursive: true });
  symlinkSync("README.md", join(dir, "docs", "guide-link.md"));
  // the MetaFileMaxSize boundary: ≤ 1024 passes (upstream's code, catfile.go
  // 49-51 — despite the "LessThan1024" name), 1025 is gated out unseen
  f("gate1024.txt", "g".repeat(1024));
  f("gate1025.txt", "h".repeat(1025));
  // pointer-SHAPED but over the gate: a valid header + padding — upstream's
  // stage 2 excludes it before any parser could look; ours must too
  f("assets/huge.lfs.ptr", `version https://git-lfs.github.com/spec/v1\noid sha256:${LFS_OID_C}\nsize 2000000000\n${"x".repeat(1100)}`);
  f("big.txt", "y".repeat(2000));
  git(dir, "add -A");
  git(dir, `commit -qm "rich lfs fixture"`, { GIT_COMMITTER_DATE: "2026-03-01T00:00:00", GIT_AUTHOR_DATE: "2026-03-01T00:00:00" });
  return dir;
}

// the row-cap fixtures (checks 6-7): N small files each, identical per-index
// bytes so the 505-run's first 500 oids equal the exact-500 run's
function buildCapsFixture(n) {
  const dir = scratchDir("lfs-caps-");
  git(dir, "init -q -b main");
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `cap-${String(i).padStart(3, "0")}.md`), `candidate ${i}\n`);
  git(dir, "add -A");
  git(dir, `commit -qm "${n} candidate files"`);
  return dir;
}

// the visited-cap fixture (check 8): 20001 entries, ALL oversize — the row
// cap must stay untouched; the visited arm alone flags the truncation
function buildBigTreeFixture() {
  const dir = scratchDir("lfs-bigtree-");
  git(dir, "init -q -b main");
  for (let i = 0; i < 20001; i++) writeFileSync(join(dir, `big-${String(i).padStart(5, "0")}.bin`), "z".repeat(1100));
  git(dir, "add -A");
  git(dir, `commit -qm "20001 oversize entries"`);
  return dir;
}

const RICH = buildRichFixture();
const RICH_TIP = commitOid(RICH, "main");
const CAPS500 = buildCapsFixture(500);
const CAPS505 = buildCapsFixture(505);
const BIGTREE = buildBigTreeFixture();

// ---- the real-git oracle ---------------------------------------------------------

/** `git ls-tree -r -l <ref>` rows: every blob entry with its byte size, in
 *  git's depth-first tree order — the exact order flattenTree yields. */
function lsTreeRows(dir, ref) {
  const out = execSync(`git -C ${dir} ls-tree -r -l ${ref}`, {
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "inherit"],
  }).toString();
  const rows = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const m = /^(\d{6}) (\S+) ([0-9a-f]{40})\s+(\d+|-)\t(.*)$/.exec(line);
    if (!m) throw new Error(`unparsable ls-tree line: ${JSON.stringify(line)}`);
    rows.push({ mode: m[1], type: m[2], oid: m[3], size: m[4] === "-" ? -1 : parseInt(m[4], 10), path: m[5] });
  }
  return rows;
}

/** The stage-1+2+3 oracle: blob entries with the ≤1024 gate applied — the
 *  candidate set ours must return (the parse stage belongs to the worker). */
function oracleCandidates(dir, ref) {
  return lsTreeRows(dir, ref)
    .filter((r) => r.type === "blob" && r.size <= 1024)
    .map((r) => ({ path: r.path, oid: r.oid, size: r.size }));
}

function gitBlobBytes(dir, oid) {
  return execSync(`git -C ${dir} cat-file blob ${oid}`, {
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** Normalize a candidate row for deep-equal (bytes compared via byteLength
 *  here; check 2 does the byte-exact diff against cat-file). */
function rowsForEq(candidates) {
  return candidates.map((c) => ({ path: c.path, oid: c.oid, size: c.size }));
}

// ---- the checks ---------------------------------------------------------------

await check(1, "candidate-set exactness vs git ls-tree -r -l + the ≤1024 gate; ref/commit/truncated fields", async () => {
  const { cell } = await makeCell(RICH);
  const result = await cell.scanLfsPointers("main");
  assert(result !== null, "the rich run answered");
  const want = oracleCandidates(RICH, "main");
  assertEq(rowsForEq(result.candidates), want, "the candidate set equals the size-gated ls-tree set, in tree order");
  assertEq(result.truncated, false, "a small fixture never truncates");
  assertEq(result.ref, "refs/heads/main", "the answer names the resolved ref");
  assertEq(result.commit, RICH_TIP, "the answer carries the tip commit oid");
  // the fixture sanity: the oversize files really sit over the gate — the
  // oracle's exclusion of them is load-bearing, not vacuous
  const rows = lsTreeRows(RICH, "main");
  const huge = rows.find((r) => r.path === "assets/huge.lfs.ptr");
  const big = rows.find((r) => r.path === "big.txt");
  const gate1024 = rows.find((r) => r.path === "gate1024.txt");
  const gate1025 = rows.find((r) => r.path === "gate1025.txt");
  assert(huge.size > 1024 && big.size > 1024 && gate1025.size > 1024, "the oversize fixtures are over 1024 bytes");
  assertEq(gate1024.size, 1024, "the boundary file sits exactly at 1024");
  const gotPaths = result.candidates.map((c) => c.path);
  assert(!gotPaths.includes("assets/huge.lfs.ptr"), "the pointer-shaped oversize blob is gated out");
  assert(!gotPaths.includes("big.txt"), "the plain oversize blob is gated out");
  assert(!gotPaths.includes("gate1025.txt"), "1025 bytes is gated out");
  assert(gotPaths.includes("gate1024.txt"), "1024 bytes passes the gate (≤, upstream's code not its name)");
  // default ref = HEAD answers at the same tip
  const head = await cell.scanLfsPointers(undefined);
  assertEq(head.commit, RICH_TIP, "ref absent = HEAD");
  assertEq(head.ref, "refs/heads/main", "HEAD's symbolic name is the answer's ref");
});

await check(2, "raw bytes: every candidate byte-identical to git cat-file blob; the crafted pointers carry their exact text", async () => {
  const { cell } = await makeCell(RICH);
  const result = await cell.scanLfsPointers("main");
  assert(result !== null, "the rich run answered");
  for (const c of result.candidates) {
    assert(c.data instanceof Uint8Array, `data is a Uint8Array for ${c.path}`);
    assertEq(c.data.byteLength, c.size, `byteLength === the git size for ${c.path}`);
    const gitBytes = gitBlobBytes(RICH, c.oid);
    assertEq(Buffer.from(c.data).equals(gitBytes), true, `data byte-identical to git cat-file blob for ${c.path}`);
  }
  const byPath = new Map(result.candidates.map((c) => [c.path, c]));
  const model = byPath.get("assets/model.lfs.ptr");
  const other = byPath.get("assets/other.lfs.ptr");
  assert(model !== undefined && other !== undefined, "both crafted pointers are candidates");
  assertEq(Buffer.from(model.data).toString("utf8"), POINTER_TEXT_A, "model.lfs.ptr carries the exact canonical text");
  assertEq(Buffer.from(other.data).toString("utf8"), POINTER_TEXT_B, "other.lfs.ptr carries the exact canonical text");
});

await check(3, "size-gated, not content-gated: binary and plain non-pointer blobs are candidates (the worker rejects them)", async () => {
  const { cell } = await makeCell(RICH);
  const result = await cell.scanLfsPointers("main");
  assert(result !== null, "the rich run answered");
  const gotPaths = result.candidates.map((c) => c.path);
  // the engine NEVER parses: NUL-bearing bytes and plain prose ride along —
  // upstream's scanner parses inside its pipeline and emits pointers only;
  // that stage is the worker's here (the ratified §2.3 split)
  assert(gotPaths.includes("logo.bin"), "the small binary blob is a candidate");
  assert(gotPaths.includes("README.md"), "the small non-pointer text is a candidate");
  assert(gotPaths.includes("src/main.ts"), "the small source file is a candidate");
  assert(gotPaths.includes("docs/guide-link.md"), "the symlink blob is a candidate (size-gated like any)");
  assert(gotPaths.includes("assets/model.lfs.ptr"), "the valid pointer is a candidate");
});

await check(4, "path arm: equals the full run sliced to the prefix; a file path narrows to one row; no match is the empty answer", async () => {
  const { cell } = await makeCell(RICH);
  const full = await cell.scanLfsPointers("main");
  const assets = await cell.scanLfsPointers("main", { path: "assets" });
  assert(full !== null && assets !== null, "runs answered");
  const fullAssets = rowsForEq(full.candidates.filter((c) => c.path === "assets" || c.path.startsWith("assets/")));
  assertEq(rowsForEq(assets.candidates), fullAssets, "the prefix run is the full run sliced");
  const treeOid = execSync(`git -C ${RICH} rev-parse main^{tree}`).toString().trim();
  const assetsOid = execSync(`git -C ${RICH} rev-parse ${treeOid}:assets`).toString().trim();
  const wantAssets = oracleCandidates(RICH, assetsOid).map((c) => ({ ...c, path: "assets/" + c.path }));
  assertEq(rowsForEq(assets.candidates), wantAssets, "the prefix run equals the ls-tree slice of the subtree");
  const one = await cell.scanLfsPointers("main", { path: "assets/model.lfs.ptr" });
  assertEq(rowsForEq(one.candidates), [{ path: "assets/model.lfs.ptr", oid: assets.candidates.find((c) => c.path === "assets/model.lfs.ptr").oid, size: Buffer.byteLength(POINTER_TEXT_A) }], "a path pointing AT a file narrows to that row");
  const none = await cell.scanLfsPointers("main", { path: "zzz" });
  assertEq(none.candidates, [], "no path match is an empty answer, not null");
  assertEq(none.truncated, false, "an empty prefix is not truncation");
});

await check(5, "oid arm (git blob oid): exact match; unknown oid empty; the canonical-pointer identity pins the FindLFSFile recipe", async () => {
  const { cell } = await makeCell(RICH);
  const full = await cell.scanLfsPointers("main");
  const model = full.candidates.find((c) => c.path === "assets/model.lfs.ptr");
  // the exact git oid of the pointer file answers exactly its paths
  const hit = await cell.scanLfsPointers("main", { oid: model.oid });
  assertEq(rowsForEq(hit.candidates), [{ path: "assets/model.lfs.ptr", oid: model.oid, size: model.size }], "the git-oid filter answers exactly the referencing paths");
  assertEq(hit.truncated, false, "the oid-filtered run does not truncate");
  // the grammar-free reading of §3.3's FindLFSFile arm: a canonical pointer's
  // git oid is a pure function of the LFS (oid, size) — sha1("blob <n>\0" +
  // canonical text), the landed pointerBlobSha1 recipe (SPEC-0006 §3.4).
  // Verify against the REAL fixture oid, then use it as the query.
  const canonical = Buffer.from(POINTER_TEXT_A, "utf8");
  const derived = createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${canonical.length}\0`), canonical]))
    .digest("hex");
  assertEq(derived, model.oid, "sha1 of the canonical pointer bytes === the fixture's git oid (the pointerBlobSha1 identity)");
  const viaLfs = await cell.scanLfsPointers("main", { oid: derived });
  assertEq(rowsForEq(viaLfs.candidates), [{ path: "assets/model.lfs.ptr", oid: model.oid, size: model.size }], "the LFS-oid-derived git oid finds the in-tree paths — the FindLFSFile arm");
  // an oid that exists in neither namespace matches nothing (a valid empty set)
  assertEq(rowsForEq((await cell.scanLfsPointers("main", { oid: "f".repeat(40) })).candidates), [], "an unknown git oid answers empty");
  assertEq(rowsForEq((await cell.scanLfsPointers("main", { oid: "d".repeat(64) })).candidates), [], "a raw LFS sha256 is NOT a git oid — answers empty (the pinned semantics)");
});

await check(6, "the candidates cap: 505 small files → 500 rows, truncated, the exact-500 run's tree-order prefix", async () => {
  const { cell } = await makeCell(CAPS505);
  const result = await cell.scanLfsPointers("main");
  assert(result !== null, "the capped run answered");
  assertEq(result.candidates.length, 500, "rows capped at MAX_LFS_CANDIDATES");
  assertEq(result.truncated, true, "the proven 501st candidate flags the cap exit");
  const exact = await (await makeCell(CAPS500)).cell.scanLfsPointers("main");
  assertEq(exact.candidates.length, 500, "the exact-500 control answers 500 rows");
  assertEq(
    result.candidates.map((c) => c.path),
    exact.candidates.map((c) => c.path),
    "the cap slices the same tree-order prefix, never an arbitrary set"
  );
  // the ls-tree oracle is uncapped: it lists all 505 — the shortfall is ours
  assertEq(oracleCandidates(CAPS505, "main").length, 505, "the uncapped oracle lists all 505");
});

await check(7, "exactly 500 candidates → truncated === false (filling the cap is not truncation)", async () => {
  const { cell } = await makeCell(CAPS500);
  const result = await cell.scanLfsPointers("main");
  assert(result !== null, "the exactly-full run answered");
  assertEq(result.candidates.length, 500, "all 500 rows returned");
  assertEq(result.truncated, false, "no further candidate was proven — the honest complete answer");
});

await check(8, "the visited cap: 20001 oversize entries → empty candidates, truncated (the visited arm is its own exit)", async () => {
  const { cell } = await makeCell(BIGTREE);
  const result = await cell.scanLfsPointers("main");
  assert(result !== null, "the visited-capped run answered (a budget exit is never null)");
  assertEq(result.candidates, [], "nothing candidate-worthy existed — the row cap stays untouched");
  assertEq(result.truncated, true, "the visited cap tripped with entries unvisited — flagged");
  const gitCount = execSync(`git -C ${BIGTREE} ls-tree -r main`, { maxBuffer: 1 << 28 }).toString().trim().split("\n").length;
  assertEq(gitCount, 20001, "the uncapped git oracle counts all 20001 entries");
});

await check(9, "null arms: unresolvable ref, empty repo — while budget exits answer flagged (checks 6/8)", async () => {
  const { cell } = await makeCell(RICH);
  assertEq(await cell.scanLfsPointers("nosuchbranch"), null, "unresolvable ref");
  const emptyDir = scratchDir("lfs-empty-");
  git(emptyDir, "init -q -b main");
  const { cell: emptyCell } = await makeCell(emptyDir);
  assertEq(await emptyCell.scanLfsPointers(undefined), null, "empty repo (unborn HEAD)");
});

await check(10, "static tripwire: rpcBind + withContentLease + resolveRef/peelToCommit + the three budget constants; LfsPointerScanResult on repo.ts", async () => {
  const src = readFileSync(fileURLToPath(new URL("../src/repo.ts", import.meta.url)), "utf8");
  const body = src.slice(src.indexOf("async scanLfsPointers(ref?"), src.indexOf("private async api("));
  assert(body.length > 0, "the scanLfsPointers method found");
  assert(body.includes("this.rpcBind()"), "rpcBind first");
  assert(body.includes("this.withContentLease"), "the read-RPC lease wrapper");
  assert(body.includes("this.resolveRef(") && body.includes("this.peelToCommit("), "resolveRef/peelToCommit at entry (the blame idiom)");
  for (const c of ["MAX_LFS_SCAN_FILES", "MAX_LFS_CANDIDATES", "MAX_LFS_POINTER_BYTES"]) {
    assert(body.includes(c), `the ${c} budget constant rides the scan`);
  }
  assert(src.includes("export interface LfsPointerScanResult"), "LfsPointerScanResult declared on repo.ts");
  // NOTE: the mod.ts re-export (`LfsPointerScanResult` on the package boundary)
  // folds into the orchestrator's landing together with the EngineClient
  // wrapper — the dist-types/repo.d.ts declaration is generated by typecheck
  // and is the boundary this unit owns (the dispatch's engine-only scope).
  const mod = readFileSync(fileURLToPath(new URL("../src/mod.ts", import.meta.url)), "utf8");
  if (!mod.includes("LfsPointerScanResult")) console.log("      note: mod.ts LfsPointerScanResult re-export pending the orchestrator's combined landing (dist-types/repo.d.ts carries it)");
});

console.log(`\ncheck-lfs-pointers: ${planned - failed}/${planned} checks passed`);
if (failed > 0) {
  console.error(`FAILED: ${failed} check(s)`);
  process.exit(1);
}
