// P2-8 attr-macro checks — the .gitattributes language (patterns, matching,
// MACRO ATTRIBUTES) differential-tested against a REAL git 2.43 oracle, run
// with tsx (see check-deepen-parse.mjs for the invocation pattern):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-archive-attrs.mjs
//
// The oracle for every fixture is a real `git archive HEAD` over a real
// fixture repo: git's FILE entry list must equal ours exactly. Our side is
// the engine's matcher (src/git/attributes.ts — the P2-8 boundary decision
// moved the language engine-side from the worker's archive walk, which
// compiled rules inline since 5365236) driven over the same tree by a
// 30-line walk emulator that mirrors the worker's collectArchiveEntries:
// per-level .gitattributes loads along the walked chain, one threaded macro
// registry, directory matches prune subtrees. Where git's answer is content-
// shaped (export-subst through a macro chain) the check extracts the file
// from git's tar and pins expanded-vs-literal plus our exportSubstActive
// flag.
//
// The fixture matrix IS the probe matrix (every arm byte-observed on stock
// git 2.43.0, docs/research/attr-macro-boundary.md): the builtin binary
// macro, user macros, transitive chains, the re-include arm, use-above-
// definition, redefinition last-wins, within-line right-to-left resolution,
// cross-file registry threading, top-level-only definitions, silent cycle
// stop, value/unset/! non-expansion, `!attr` bodies, and dir-pattern prunes
// through macros.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { assert, assertEq, git, scratchDir } from "./helpers/lib.mjs";
import {
  createAttrMacros,
  exportIgnoreExcluded,
  exportSubstActive,
  parseGitattributes,
} from "../src/git/attributes.ts";

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

// ---- fixture + oracle helpers -----------------------------------------------

function makeAttrRepo(name, files) {
  const dir = scratchDir(`attrs-${name}-`);
  git(dir, "init -q");
  for (const f of files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
  git(dir, "add -A");
  git(dir, "commit -qm x");
  return dir;
}

/** git's tar, listed and extracted: file entries only (directories — paths
 *  with a trailing slash — and git's pax_global_header extended entry are
 *  not part of our walk's file set). */
function gitArchive(dir) {
  const out = join(scratchDir("attrs-tar-"), "out.tar");
  execSync(`git -C ${dir} archive HEAD > ${out}`, { stdio: ["ignore", "ignore", "inherit"], maxBuffer: 1 << 26 });
  const names = execSync(`tar -tf ${out}`, { maxBuffer: 1 << 24 })
    .toString()
    .split("\n")
    .filter((n) => n !== "" && !n.endsWith("/") && n !== "pax_global_header");
  return { out, names };
}

function gitArchiveFile(tarPath, path) {
  return execSync(`tar -xOf ${tarPath} ${path}`, { maxBuffer: 1 << 24 }).toString();
}

/** The worker walk's stand-in over a real fixture repo: pre-order ls-tree
 *  (-r -t), per-directory rule chains, one threaded macro registry, subtree
 *  pruning on directory matches. Returns the kept file paths plus the
 *  export-subst flags. */
function ourArchive(dir) {
  const entries = git(dir, "ls-tree -r -t HEAD")
    .split("\n")
    .filter((l) => l !== "")
    .map((line) => {
      const [meta, path] = line.split("\t");
      const type = meta.split(" ")[1];
      return { path, type };
    });
  const macros = createAttrMacros();
  const rulesByDir = new Map([["", []]]);
  const pruned = [];
  const files = [];
  const subst = [];
  const parentDir = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  for (const e of entries) {
    if (pruned.some((p) => e.path === p || e.path.startsWith(`${p}/`))) continue;
    const entryDir = parentDir(e.path);
    if (e.type === "tree") {
      // entryDir is the tree's PARENT: the rules in force at the tree itself.
      // The tree's own key (what its children will look up) inherits them.
      const inherited = rulesByDir.get(entryDir) ?? [];
      if (!rulesByDir.has(e.path)) rulesByDir.set(e.path, [...inherited]);
      if (exportIgnoreExcluded(inherited, e.path, true)) {
        pruned.push(e.path);
        continue;
      }
      continue;
    }
    let rules = rulesByDir.get(entryDir) ?? [];
    if (e.path === ".gitattributes" || e.path.endsWith("/.gitattributes")) {
      const text = git(dir, `show HEAD:${e.path}`);
      rules = [...rules, ...parseGitattributes(text, entryDir, macros)];
      rulesByDir.set(entryDir, rules);
    }
    if (exportIgnoreExcluded(rules, e.path, false)) continue;
    files.push(e.path);
    if (exportSubstActive(rules, e.path, false)) subst.push(e.path);
  }
  return { files, subst };
}

function assertMatchesGit(dir, label) {
  const ours = ourArchive(dir);
  const theirs = gitArchive(dir);
  assertEq(
    JSON.stringify(ours.files.sort()),
    JSON.stringify(theirs.names.sort()),
    `${label}: our archive entry set must equal git archive's`,
  );
  return { ours, theirs };
}

// ---- 1. baseline + the builtin binary macro ---------------------------------

await check("baseline: no attributes at all archives every file", () => {
  const dir = makeAttrRepo("baseline", [
    { path: "a.txt", content: "a\n" },
    { path: "sub/b.txt", content: "b\n" },
  ]);
  assertMatchesGit(dir, "baseline");
});

await check("builtin binary macro: archive-neutral alone, no export-ignore side effects", () => {
  const dir = makeAttrRepo("binary-builtin", [
    { path: ".gitattributes", content: "f.png binary\n" },
    { path: "f.png", content: "PNG\n" },
    { path: "g.txt", content: "g\n" },
  ]);
  assertMatchesGit(dir, "binary-builtin");
});

// ---- 2. user macros → export-ignore (the core observable) -------------------

await check("user macro excludes: `[attr]arc export-ignore` + `secret* arc`", () => {
  const dir = makeAttrRepo("user-macro", [
    { path: ".gitattributes", content: "[attr]arc export-ignore\nsecret* arc\n" },
    { path: "secret.txt", content: "s\n" },
    { path: "keep.txt", content: "k\n" },
  ]);
  const { ours } = assertMatchesGit(dir, "user-macro");
  assert(ours.files.includes("keep.txt"), "keep.txt survives");
  assert(!ours.files.includes("secret.txt"), "secret.txt excluded via the macro");
});

await check("transitive macro chain a → b → export-ignore", () => {
  const dir = makeAttrRepo("chain", [
    { path: ".gitattributes", content: "[attr]a b\n[attr]b export-ignore\nf a\n" },
    { path: "f", content: "x\n" },
    { path: "g", content: "y\n" },
  ]);
  assertMatchesGit(dir, "chain");
});

await check("macro re-include arm: `[attr]keep -export-ignore` beats an earlier line at file level", () => {
  const dir = makeAttrRepo("reinclude", [
    { path: ".gitattributes", content: "*.log export-ignore\n[attr]keep -export-ignore\nkeep.log keep\n" },
    { path: "keep.log", content: "k\n" },
    { path: "drop.log", content: "d\n" },
  ]);
  assertMatchesGit(dir, "reinclude");
});

await check("a directory-level export-ignore prunes the subtree even when a macro re-includes a file inside", () => {
  // git 2.43 pinned: `/dir export-ignore` prunes dir/ whole (the archive
  // never reads deeper attributes inside a pruned subtree); check-attr says
  // dir/keep.txt's export-ignore is unset — the ARCHIVE answer is still
  // "pruned", which is exactly the walk's directory prune.
  const dir = makeAttrRepo("dirprune-vs-macro", [
    { path: ".gitattributes", content: "/dir export-ignore\n[attr]keep -export-ignore\ndir/keep.txt keep\n" },
    { path: "dir/keep.txt", content: "k\n" },
    { path: "dir/drop.txt", content: "d\n" },
  ]);
  assertMatchesGit(dir, "dirprune-vs-macro");
});

// ---- 3. ordering: across lines, within a line, across files -----------------

await check("expansion rides the expanding line: a later explicit line wins over an earlier macro", () => {
  const dir = makeAttrRepo("k1", [
    { path: ".gitattributes", content: "[attr]m export-ignore\nf m\nf -export-ignore\n" },
    { path: "f", content: "x\n" },
  ]);
  assertMatchesGit(dir, "k1");
});

await check("expansion rides the expanding line: a later macro line wins over an earlier explicit one", () => {
  const dir = makeAttrRepo("k2", [
    { path: ".gitattributes", content: "f -export-ignore\nf m\n[attr]m export-ignore\n" },
    { path: "f", content: "x\n" },
    { path: "g", content: "y\n" },
  ]);
  assertMatchesGit(dir, "k2");
});

await check("within one line tokens resolve right-to-left; the rightmost macro wins", () => {
  const dir = makeAttrRepo("k3", [
    { path: ".gitattributes", content: "[attr]m -export-ignore\nf m export-ignore\n" },
    { path: "f", content: "x\n" },
  ]);
  assertMatchesGit(dir, "k3 (explicit rightmost beats the macro body)");
  const dir2 = makeAttrRepo("k4", [
    { path: ".gitattributes", content: "[attr]m -export-ignore\nf export-ignore m\n" },
    { path: "f", content: "x\n" },
  ]);
  assertMatchesGit(dir2, "k4 (the macro body beats the leftward explicit token)");
});

await check("plain duplicate tokens resolve right-to-left (git fill_one's reversed walk)", () => {
  const dir = makeAttrRepo("z1", [
    { path: ".gitattributes", content: "f export-ignore -export-ignore\n" },
    { path: "f", content: "x\n" },
  ]);
  assertMatchesGit(dir, "z1");
  const dir2 = makeAttrRepo("z2", [
    { path: ".gitattributes", content: "f -export-ignore export-ignore\n" },
    { path: "f", content: "x\n" },
  ]);
  assertMatchesGit(dir2, "z2");
});

await check("two macros on one line: the rightmost wins on conflict", () => {
  const dir = makeAttrRepo("z3", [
    { path: ".gitattributes", content: "[attr]a export-ignore\n[attr]b -export-ignore\nf a b\n" },
    { path: "f", content: "x\n" },
  ]);
  assertMatchesGit(dir, "z3");
  const dir2 = makeAttrRepo("z4", [
    { path: ".gitattributes", content: "[attr]a export-ignore\n[attr]b -export-ignore\nf b a\n" },
    { path: "f", content: "x\n" },
  ]);
  assertMatchesGit(dir2, "z4");
});

await check("parse-then-resolve: a use line ABOVE the `[attr]` definition still expands", () => {
  const dir = makeAttrRepo("late-def", [
    { path: ".gitattributes", content: "f m\n[attr]m export-ignore\n" },
    { path: "f", content: "x\n" },
    { path: "g", content: "y\n" },
  ]);
  assertMatchesGit(dir, "late-def");
});

await check("redefinition: the LAST `[attr]m` definition wins", () => {
  const dir = makeAttrRepo("redef", [
    { path: ".gitattributes", content: "[attr]m export-ignore\n[attr]m -export-ignore\nf m\n" },
    { path: "f", content: "x\n" },
    { path: "g", content: "y\n" },
  ]);
  assertMatchesGit(dir, "redef");
});

await check("a root macro reaches a deeper .gitattributes' rules (registry threading)", () => {
  const dir = makeAttrRepo("cross-file", [
    { path: ".gitattributes", content: "[attr]arc export-ignore\n" },
    { path: "lib/.gitattributes", content: "f arc\n" },
    { path: "lib/f", content: "x\n" },
    { path: "lib/g", content: "y\n" },
  ]);
  assertMatchesGit(dir, "cross-file");
});

await check("root macro chain vs a deeper direct -export-ignore: the deeper file's own line wins", () => {
  const dir = makeAttrRepo("r2", [
    { path: ".gitattributes", content: "[attr]arc export-ignore\n*.go arc\n" },
    { path: "lib/.gitattributes", content: "keep.go -export-ignore\n" },
    { path: "lib/keep.go", content: "k\n" },
    { path: "lib/gen.go", content: "g\n" },
  ]);
  assertMatchesGit(dir, "r2");
});

// ---- 4. definition scope + pathological bodies ------------------------------

await check("a `[attr]` definition inside a deeper .gitattributes is IGNORED (top-level-only)", () => {
  const dir = makeAttrRepo("subdir-def", [
    { path: "lib/.gitattributes", content: "[attr]x export-ignore\nf x\n" },
    { path: "lib/f", content: "x\n" },
    { path: "lib/g", content: "y\n" },
  ]);
  assertMatchesGit(dir, "subdir-def");
});

await check("macro cycles terminate silently (a → b → a), no hang, no archive effect", () => {
  const dir = makeAttrRepo("cycle", [
    { path: ".gitattributes", content: "[attr]a b\n[attr]b a\nf a\n" },
    { path: "f", content: "x\n" },
    { path: "g", content: "y\n" },
  ]);
  assertMatchesGit(dir, "cycle");
});

await check("value, unset and ! forms on a path never expand the macro", () => {
  const dir = makeAttrRepo("forms", [
    { path: ".gitattributes", content: "[attr]m export-ignore\nf1 m=123\nf2 -m\nf3 !m\nf4 m\n" },
    { path: "f1", content: "1\n" },
    { path: "f2", content: "2\n" },
    { path: "f3", content: "3\n" },
    { path: "f4", content: "4\n" },
  ]);
  assertMatchesGit(dir, "forms");
});

await check("`!attr` inside a macro body is the unspecified value (re-opens the attribute)", () => {
  const dir = makeAttrRepo("body-bang", [
    { path: ".gitattributes", content: "*.q export-ignore\n[attr]m !export-ignore\nf.q m\n" },
    { path: "f.q", content: "x\n" },
    { path: "g.q", content: "y\n" },
  ]);
  assertMatchesGit(dir, "body-bang");
});

await check("undefined macro names are ordinary attributes: no expansion, no archive effect", () => {
  const dir = makeAttrRepo("undefined", [
    { path: ".gitattributes", content: "f undefinedmacro\n" },
    { path: "f", content: "x\n" },
  ]);
  assertMatchesGit(dir, "undefined");
});

await check("a user `[attr]binary` REPLACES the builtin; binary chains carry archive attrs", () => {
  const dir = makeAttrRepo("binary-override", [
    { path: ".gitattributes", content: "[attr]binary export-ignore\nf.png binary\n" },
    { path: "f.png", content: "PNG\n" },
    { path: "g", content: "y\n" },
  ]);
  assertMatchesGit(dir, "binary-override");
  const dir2 = makeAttrRepo("binary-chain", [
    { path: ".gitattributes", content: "[attr]a binary export-ignore\nf.png a\n" },
    { path: "f.png", content: "PNG\n" },
    { path: "g", content: "y\n" },
  ]);
  assertMatchesGit(dir2, "binary-chain");
});

await check("dir-only patterns prune through a macro (`dir/ arc`)", () => {
  const dir = makeAttrRepo("dir-macro", [
    { path: ".gitattributes", content: "[attr]arc export-ignore\ndir/ arc\n" },
    { path: "dir/f", content: "x\n" },
    { path: "top", content: "y\n" },
  ]);
  assertMatchesGit(dir, "dir-macro");
});

// ---- 5. export-subst through a macro (content-shaped oracle) ----------------

await check("macro-carried export-subst expands $Format in git's archive and flags our side", () => {
  const dir = makeAttrRepo("subst-macro", [
    { path: ".gitattributes", content: "[attr]v export-subst\nVERSION v\n" },
    { path: "VERSION", content: "ver=$Format:%H$\n" },
  ]);
  const { ours, theirs } = assertMatchesGit(dir, "subst-macro");
  const content = gitArchiveFile(theirs.out, "VERSION");
  assert(content.startsWith("ver=") && content.length === "ver=".length + 40 + 1, `git archive EXPANDED the marker through the macro (got ${JSON.stringify(content)})`);
  assert(ours.subst.includes("VERSION"), "our matcher flags VERSION exportSubstActive via the macro");
});

await check("two-level macro chain to export-subst still expands", () => {
  const dir = makeAttrRepo("subst-chain", [
    { path: ".gitattributes", content: "[attr]a b\n[attr]b export-subst\nVERSION a\n" },
    { path: "VERSION", content: "v=$Format:%h$\n" },
  ]);
  const { ours, theirs } = assertMatchesGit(dir, "subst-chain");
  const content = gitArchiveFile(theirs.out, "VERSION");
  assert(content.startsWith("v=") && content.length === "v=".length + 7 + 1, `git archive expanded through the chain (got ${JSON.stringify(content)})`);
  assert(ours.subst.includes("VERSION"), "our matcher flags the chained export-subst");
});

// ---- summary ----------------------------------------------------------------

console.log(`\nattrs-vs-git: ${planned - failures.length}/${planned} checks passed`);
if (failures.length > 0) {
  console.log(`FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
