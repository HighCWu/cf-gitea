#!/usr/bin/env node
/* global process -- Node globals (repo lint convention: no node env in the flat config) */
/**
 * verify-commit.mjs — pre-commit verification gate for cf-gitea.
 *
 * Typechecks EXACTLY the state a pathspec commit would land: HEAD + the
 * working-tree content of the given paths (or the staged index when no
 * --paths is given). Fully isolated: touches NEITHER the working tree,
 * NOR the real index, NOR any ref. This closes the failure mode seen twice
 * in the week of 2026-10-26:
 *   (1) a JSON comment shipped broken because an earlier gate in the commit
 *       chain failed but the commit ran anyway;
 *   (2) 8fd9961 landed a sibling agent's mid-flight compare.tsx snapshot —
 *       the local typecheck had passed against the DIRTY WORKING TREE while
 *       the COMMITTED state was broken (CI red for 4 runs).
 * Root cause in both: verification ran against a state different from what
 * got committed. This gate verifies the candidate committed state itself.
 *
 * USAGE
 *   node scripts/verify-commit.mjs [--paths <pathspec>...]
 *
 *   --paths <pathspec>...
 *       Simulates `git commit -- <pathspec>...`: the candidate tree is HEAD
 *       plus the CURRENT WORKING-TREE content of every index-known path
 *       matching the pathspecs (untracked-never-staged files are NOT part of
 *       a candidate, exactly as in git commit; they are listed as a warning).
 *       Nothing is staged; the real index is never written.
 *   (no --paths)
 *       Verifies the actual STAGED index (what a plain `git commit` would
 *       land). The index is only read, never written.
 *
 * SNAPSHOT SEMANTICS (sibling safety)
 *   The repo routinely carries a large in-flight UI wave with several agents
 *   editing the working tree concurrently. With --paths, the candidate paths'
 *   working-tree content is read ONCE, at invocation, into blob objects; the
 *   verdict applies to THAT snapshot. Edits landing after invocation are not
 *   covered. Re-run immediately before committing.
 *
 * ISOLATION MECHANICS (side-effect-free)
 *   1. Candidate path blobs are snapshotted with `git hash-object -w` (writes
 *      loose objects only — standard plumbing, gc-safe, no ref/index/worktree
 *      change).
 *   2. A TEMP index (GIT_INDEX_FILE in the OS temp dir) is built with
 *      `read-tree HEAD` + `update-index --cacheinfo` for the candidate paths —
 *      the repo's real index is never touched.
 *   3. `write-tree` + `commit-tree -p HEAD` materialize a candidate commit.
 *      No ref is created or updated.
 *   4. `git worktree add --detach` checks the candidate commit out under the
 *      OS temp dir; the worktree is removed and pruned in ALL exit paths
 *      (including signals). node_modules dirs are symlinked in (workspace
 *      links re-pointed INTO the worktree), and gitignored GENERATED files
 *      the typecheck imports are copied from the main tree
 *      (apps/worker/src/ui/icons.generated.ts, apps/worker/
 *      worker-configuration.d.ts). wrangler.jsonc / .dev.vars are NOT needed
 *      for this typecheck-only scope (worker-configuration.d.ts carries what
 *      `wrangler types` would emit; .dev.vars is runtime-only) — they are
 *      copied only in the cold-start fallback where the main tree has no
 *      worker-configuration.d.ts yet and `wrangler types` must be run inside
 *      the worktree.
 *
 * SCOPE (v1)
 *   `pnpm typecheck`-equivalent only: every workspace package (from
 *   pnpm-workspace.yaml) whose package.json has a `typecheck` script of the
 *   shape `[wrangler types &&] tsc <args>` is run against the candidate
 *   worktree — packages/* before apps/* (workspace dependency direction),
 *   mirroring `pnpm -r` topological order. A `--full` flag (full-suite gate
 *   inside the worktree) is DELIBERATELY OMITTED: scripts/full-suite-gate.mjs
 *   needs real vitest/workerd bindings, local D1 migrations and account-local
 *   config that a bare candidate worktree cannot honestly provide; wiring it
 *   here would produce misleading verdicts. Revisit only with a SPEC.
 *
 * FAST PATH
 *   When no candidate path matches /\.(ts|tsx)$/ under apps/ or packages/,
 *   the gate prints a one-line skip and exits 0 (docs-only commits).
 *
 * EXIT CODES
 *   0 — the candidate committed-state typechecks (or docs-only skip)
 *   1 — verification FAILURE: the candidate committed-state does not
 *       typecheck; a diff-of-states summary of what the commit WOULD land
 *       is printed
 *   2 — usage/environment error (bad flags, unborn HEAD, pathspec matched
 *       nothing, unsupported typecheck script shape, missing node_modules —
 *       run `pnpm install` in the main repo first)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const SESSION_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-commit-'));

const state = {
  repoRoot: null,
  worktreePath: null,
  worktreeAdded: false,
};

let CLEANED_UP = false;

function cleanup() {
  if (CLEANED_UP) return;
  CLEANED_UP = true;
  if (state.worktreeAdded) {
    try {
      runGit(['worktree', 'remove', '--force', state.worktreePath], null, true);
    } catch { /* best effort — prune below still detaches the metadata */ }
    try {
      runGit(['worktree', 'prune'], null, true);
    } catch { /* ignore */ }
  }
  try {
    fs.rmSync(SESSION_TMP, { recursive: true, force: true });
  } catch { /* ignore */ }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    cleanup();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

function die(code, message) {
  // process.exit bypasses the module-scope finally — clean up explicitly so a
  // die() after `worktree add` never leaks the worktree registration either.
  cleanup();
  process.stderr.write(`verify-commit: ${message}\n`);
  process.exit(code);
}

/** Run git in the repo. Throws with stderr on failure unless `soft`. */
function runGit(args, extraEnv = null, soft = false, cwd = state.repoRoot) {
  const env = { ...process.env, ...(extraEnv || {}) };
  const res = spawnSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0 && !soft) {
    throw new Error(`git ${args.join(' ')} failed (${res.status}): ${(res.stderr || res.stdout || '').trim()}`);
  }
  return { status: res.status, stdout: (res.stdout || ''), stderr: (res.stderr || '') };
}

/** Split NUL-delimited git output into paths. */
function nulSplit(text) {
  return text.split('\0').filter((p) => p.length > 0);
}

function isTsUnderAppsOrPackages(p) {
  return /\.(ts|tsx)$/.test(p) && (p.startsWith('apps/') || p.startsWith('packages/'));
}

// ---------------------------------------------------------------------------
// Workspace discovery (dynamic — never hardcoded per package)
// ---------------------------------------------------------------------------

/** Parse the committed pnpm-workspace.yaml `packages:` globs. Supports the
 *  simple `dir` and `dir/*` shapes this repo uses; anything else is reported. */
function workspacePackageDirs(repoRoot) {
  const yaml = fs.readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
  const globs = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*(.+?)\s*$/);
    if (!m) break;
    globs.push(m[1].replace(/^['"]|['"]$/g, ''));
  }
  if (globs.length === 0) die(2, 'pnpm-workspace.yaml has no `packages:` globs — cannot discover workspace packages');
  const dirs = [];
  for (const g of globs) {
    if (/^[^*]*\/\*$/.test(g)) {
      const parent = g.replace(/\/\*$/, '');
      const abs = path.join(repoRoot, parent);
      if (!fs.existsSync(abs)) continue;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (e.isDirectory() && fs.existsSync(path.join(abs, e.name, 'package.json'))) {
          dirs.push(`${parent}/${e.name}`);
        }
      }
    } else if (!g.includes('*')) {
      if (fs.existsSync(path.join(repoRoot, g, 'package.json'))) dirs.push(g);
    } else {
      die(2, `unsupported pnpm-workspace.yaml glob "${g}" — verify-commit supports "dir" and "dir/*" only`);
    }
  }
  return [...new Set(dirs)].sort();
}

// ---------------------------------------------------------------------------
// node_modules wiring into the candidate worktree
// ---------------------------------------------------------------------------

/**
 * True when `linkAbs` (a symlink inside some node_modules) points at a
 * workspace package of this repo — i.e. a pnpm workspace LINK that must be
 * re-pointed into the candidate worktree instead of the main tree (otherwise
 * `@cf-gitea/git-engine` would resolve to the main tree's engine, silently
 * verifying stale sources).
 */
function isWorkspaceLink(linkAbs, realpathed, repoRoot, worktreeRoot) {
  if (os.platform() === 'win32') return false; // junctions: not supported, not our platform
  const underRepo = realpathed === repoRoot || realpathed.startsWith(repoRoot + path.sep);
  const inNodeModules = realpathed.includes(`${path.sep}node_modules${path.sep}`);
  const inWorktree = realpathed === worktreeRoot || realpathed.startsWith(worktreeRoot + path.sep);
  return underRepo && !inNodeModules && !inWorktree;
}

/**
 * Mirror one node_modules dir into the worktree.
 * - Fast path: no workspace links anywhere below (depth-capped) → symlink the
 *   whole dir to the main tree's (absolute).
 * - Otherwise: materialize a real dir; per child, symlink to the main tree's
 *   entry, except workspace links which re-point to the same relative path
 *   INSIDE the worktree (candidate sources).
 */
function wireNodeModules(mainNm, wtNm, repoRoot, worktreeRoot) {
  const collectLinks = (dir, depth) => {
    if (depth > 4) return false;
    let found = false;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        let rp;
        try { rp = fs.realpathSync(child); } catch { continue; }
        if (isWorkspaceLink(child, rp, repoRoot, worktreeRoot)) return true;
      } else if (e.isDirectory() && e.name !== '.bin') {
        found = found || collectLinks(child, depth + 1);
      }
    }
    return found;
  };
  fs.rmSync(wtNm, { recursive: true, force: true });
  if (!collectLinks(mainNm, 0)) {
    fs.symlinkSync(mainNm, wtNm, 'dir');
    return;
  }
  fs.mkdirSync(wtNm, { recursive: true });
  const walk = (mainDir, wtDir, depth) => {
    for (const e of fs.readdirSync(mainDir, { withFileTypes: true })) {
      const mainChild = path.join(mainDir, e.name);
      const wtChild = path.join(wtDir, e.name);
      if (e.isSymbolicLink()) {
        let rp = null;
        try { rp = fs.realpathSync(mainChild); } catch { /* dangling: plain copy */ }
        if (rp && isWorkspaceLink(mainChild, rp, repoRoot, worktreeRoot)) {
          const wtTarget = path.join(worktreeRoot, path.relative(repoRoot, rp));
          fs.symlinkSync(wtTarget, wtChild, 'dir');
        } else {
          fs.symlinkSync(rp || mainChild, wtChild);
        }
      } else if (e.isDirectory() && depth < 4) {
        fs.mkdirSync(wtChild);
        walk(mainChild, wtChild, depth + 1);
      } else {
        fs.symlinkSync(mainChild, wtChild);
      }
    }
  };
  walk(mainNm, wtNm, 0);
}

/**
 * Copy the gitignored GENERATED files the committed code imports and the
 * typecheck needs (they can never be part of a commit, so the main tree's
 * copy is the only source). Returns whether worker-configuration.d.ts (what
 * `wrangler types` emits) could be provided.
 */
function copyGeneratedFiles(repoRoot, worktreeRoot) {
  // apps/worker/src/ui/icons.generated.ts — the ONLY gitignored file under
  // apps/worker/src (verified via `git status --ignored apps/worker/src`);
  // imported by committed ui/icons.ts and fileicon.ts. Regenerated by
  // `pnpm gen:icons` — copied here generate-free.
  const generated = [
    'apps/worker/src/ui/icons.generated.ts',
  ];
  let wranglerTypesProvided = false;
  for (const rel of generated) {
    const src = path.join(repoRoot, rel);
    if (fs.existsSync(src)) {
      const dst = path.join(worktreeRoot, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
  const wranglerDts = 'apps/worker/worker-configuration.d.ts';
  const src = path.join(repoRoot, wranglerDts);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(worktreeRoot, wranglerDts));
    wranglerTypesProvided = true;
  }
  return wranglerTypesProvided;
}

// ---------------------------------------------------------------------------
// Typecheck targets (translate package.json `typecheck` scripts)
// ---------------------------------------------------------------------------

/**
 * Translate a package's `typecheck` script into { needsWranglerTypes, tscArgs }.
 * Supported shape: `[wrangler types &&] tsc <args>` (the two shapes this repo
 * uses: engine `tsc -p tsconfig.build.json`, worker `wrangler types && tsc
 * --noEmit`). Any other shape is a hard error — never silently skipped.
 */
function translateTypecheckScript(script) {
  const parts = script.split('&&').map((p) => p.trim()).filter((p) => p.length > 0);
  const wranglerParts = parts.filter((p) => p === 'wrangler types');
  const tscParts = parts.filter((p) => p === 'tsc' || p.startsWith('tsc '));
  if (wranglerParts.length > 1 || tscParts.length !== 1 || parts.length !== wranglerParts.length + tscParts.length) {
    return null;
  }
  if (wranglerParts.length === 1 && parts[0] !== 'wrangler types') {
    return null; // wrangler step must come first (it generates the Env types)
  }
  if (parts[parts.length - 1] !== tscParts[0]) {
    return null; // the tsc invocation must be the last step
  }
  return {
    needsWranglerTypes: wranglerParts.length === 1,
    tscArgs: tscParts[0].split(/\s+/).slice(1),
  };
}

// ---------------------------------------------------------------------------
// Candidate construction
// ---------------------------------------------------------------------------

function headModeOf(repoPath) {
  const out = runGit(['ls-tree', 'HEAD', '--', repoPath]).stdout.trim();
  if (!out) return null;
  return out.split('\t')[0].split(' ')[0];
}

function fsModeOfFile(abs) {
  return (fs.statSync(abs).mode & 0o111) !== 0 ? '100755' : '100644';
}

/** Enumerate the candidate entries for --paths mode (snapshot at invocation). */
function enumeratePathsMode(pathspecs) {
  const matched = nulSplit(runGit(['ls-files', '-z', '--', ...pathspecs]).stdout);
  const untracked = nulSplit(runGit(['ls-files', '-z', '--others', '--exclude-standard', '--', ...pathspecs]).stdout);
  if (matched.length === 0 && untracked.length === 0) {
    die(2, `pathspec matched no files at all: ${pathspecs.join(' ')}`);
  }
  if (untracked.length > 0) {
    process.stdout.write(
      `verify-commit: WARNING — ${untracked.length} untracked (never-staged) path(s) match the pathspec and are NOT part of the candidate, exactly as in \`git commit -- <paths>\`:\n` +
      untracked.map((p) => `  ? ${p}`).join('\n') + '\n',
    );
  }
  if (matched.length === 0) {
    die(2, 'pathspec matched only untracked files — `git commit -- <paths>` would refuse; nothing to verify');
  }
  const entries = [];
  for (const p of matched) {
    const wtFile = path.join(state.repoRoot, p);
    const inHead = headModeOf(p);
    if (!fs.existsSync(wtFile)) {
      if (inHead) entries.push({ path: p, action: 'delete', headMode: inHead });
      // index-new + already deleted from the working tree = net no-op vs HEAD
      continue;
    }
    const blob = runGit(['hash-object', '-w', `--path=${p}`, wtFile]).stdout.trim();
    entries.push({
      path: p,
      action: 'set',
      blob,
      mode: inHead || fsModeOfFile(wtFile),
      headMode: inHead,
    });
  }
  return entries;
}

/** Enumerate the candidate entries for staged-index mode (index vs HEAD). */
function enumerateStagedMode() {
  const changed = nulSplit(runGit(['diff-index', '--name-only', '-z', 'HEAD']).stdout);
  const entries = [];
  for (const p of changed) {
    const ls = runGit(['ls-files', '-s', '--', p]).stdout.trim();
    const headEntry = headModeOf(p);
    if (!ls) {
      entries.push({ path: p, action: 'delete', headMode: headEntry });
      continue;
    }
    const [mode, blob] = ls.split('\t')[0].split(' ');
    entries.push({ path: p, action: 'set', blob, mode, headMode: headEntry });
  }
  return entries;
}

/** Materialize the candidate tree + temp commit. Returns { tree, commit }. */
function buildCandidateCommit(head, entries, snapshotAt) {
  let tree;
  if (entries.length === 0) {
    tree = runGit(['rev-parse', `${head}^{tree}`]).stdout.trim();
    return { tree, commit: head };
  }
  const tmpIndex = path.join(SESSION_TMP, `index-${randomUUID()}`);
  const idxEnv = { GIT_INDEX_FILE: tmpIndex };
  runGit(['read-tree', head], idxEnv);
  for (const e of entries) {
    if (e.action === 'set') {
      runGit(['update-index', '--add', '--cacheinfo', `${e.mode},${e.blob},${e.path}`], idxEnv);
    } else {
      runGit(['update-index', '--force-remove', '--', e.path], idxEnv);
    }
  }
  tree = runGit(['write-tree'], idxEnv).stdout.trim();
  try { fs.rmSync(tmpIndex, { force: true }); } catch { /* ignore */ }
  const message = `verify-commit candidate tree (snapshot ${snapshotAt.toISOString()}) — temp plumbing, NOT a real commit`;
  const commit = runGit(
    ['commit-tree', tree, '-p', head, '-m', message],
    {
      GIT_AUTHOR_NAME: 'verify-commit',
      GIT_AUTHOR_EMAIL: 'verify-commit@local',
      GIT_COMMITTER_NAME: 'verify-commit',
      GIT_COMMITTER_EMAIL: 'verify-commit@local',
    },
  ).stdout.trim();
  return { tree, commit };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(`verify-commit — pre-commit verification gate (typechecks the candidate committed state)

USAGE
  node scripts/verify-commit.mjs [--paths <pathspec>...]
  node scripts/verify-commit.mjs --help

MODES
  --paths <pathspec>...   Candidate = HEAD + the WORKING-TREE content of every
                          index-known path matching the pathspecs (simulates
                          \`git commit -- <paths>\`; stages nothing). Untracked
                          never-staged matches are warned about, never included.
  (no --paths)            Candidate = the actual STAGED index (read-only).

SNAPSHOT SEMANTICS
  Safe to run while sibling agents edit the working tree: with --paths the
  candidate paths' content is read ONCE at invocation into blob objects. The
  verdict covers THAT snapshot only — re-run right before committing.

ISOLATION
  Temp index (GIT_INDEX_FILE) + write-tree/commit-tree (no ref) + detached
  temp worktree under the OS temp dir, removed and pruned on every exit path.
  Neither the working tree, nor the real index, nor any ref is touched.
  node_modules are symlinked in (workspace links re-pointed into the worktree);
  gitignored generated files (icons.generated.ts, worker-configuration.d.ts)
  are copied from the main tree. wrangler.jsonc/.dev.vars are only copied in
  the cold-start fallback where the main tree lacks worker-configuration.d.ts.

SCOPE (v1)
  \`pnpm typecheck\`-equivalent (workspace packages with a
  \`[wrangler types &&] tsc ...\` typecheck script; packages/* before apps/*).
  A --full flag is deliberately omitted: the full-suite gate needs real
  vitest/workerd bindings and account-local config a bare candidate worktree
  cannot honestly provide.

EXIT CODES
  0  candidate committed-state typechecks (or docs-only fast-path skip)
  1  verification failure — diff-of-states summary printed
  2  usage/environment error
`);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return 0;
  }
  const pathspecs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--paths') {
      // everything after --paths up to the next flag belongs to the pathspec list
      for (i++; i < argv.length && !argv[i].startsWith('--'); i++) pathspecs.push(argv[i]);
      if (i >= argv.length) break;
      // re-process the flag we stopped at
      if (argv[i] !== '--paths') die(2, `unknown or misplaced argument: ${argv[i]}`);
      i--; // the for-loop's i++ makes us re-enter on this --paths
      continue;
    }
    die(2, `unknown argument: ${argv[i]} (a --full flag is deliberately omitted — see --help)`);
  }

  state.repoRoot = runGit(['rev-parse', '--show-toplevel']).stdout.trim();
  const snapshotAt = new Date();

  const headRes = runGit(['rev-parse', '--verify', 'HEAD'], null, true);
  if (headRes.status !== 0) {
    die(2, 'unborn HEAD (no commits yet) — nothing to build a candidate on; make the initial commit first');
  }
  const head = headRes.stdout.trim();

  const usePathsMode = pathspecs.length > 0;
  const entries = usePathsMode ? enumeratePathsMode(pathspecs) : enumerateStagedMode();

  // Fast path: docs-only candidates never reach tsc.
  const tsCandidates = entries.filter((e) => isTsUnderAppsOrPackages(e.path));
  if (tsCandidates.length === 0) {
    process.stdout.write(
      `verify-commit: skip — no candidate path under apps/ or packages/ matches *.ts|*.tsx (docs-only commit); nothing to typecheck\n`,
    );
    return 0;
  }

  const { tree, commit } = buildCandidateCommit(head, entries, snapshotAt);

  // Candidate worktree (detached temp commit; removed on every exit path).
  state.worktreePath = path.join(SESSION_TMP, 'wt');
  runGit(['worktree', 'add', '--detach', state.worktreePath, commit]);
  state.worktreeAdded = true;
  const wt = state.worktreePath;

  // Wire node_modules (discovered dynamically from pnpm-workspace.yaml globs).
  const pkgs = workspacePackageDirs(state.repoRoot);
  const nmDirs = [];
  const rootNm = path.join(state.repoRoot, 'node_modules');
  if (fs.existsSync(rootNm)) nmDirs.push({ main: rootNm, rel: 'node_modules' });
  for (const pkg of pkgs) {
    const nm = path.join(state.repoRoot, pkg, 'node_modules');
    if (fs.existsSync(nm)) nmDirs.push({ main: nm, rel: path.join(pkg, 'node_modules') });
  }
  if (nmDirs.length === 0) {
    die(2, 'no node_modules found in the main tree — run `pnpm install` in the main repo first');
  }
  for (const { main, rel } of nmDirs) {
    wireNodeModules(main, path.join(wt, rel), state.repoRoot, wt);
  }
  const wranglerTypesProvided = copyGeneratedFiles(state.repoRoot, wt);

  // Typecheck targets (translated from each package's `typecheck` script).
  const targets = [];
  for (const pkg of pkgs) {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(state.repoRoot, pkg, 'package.json'), 'utf8'));
    const script = pkgJson?.scripts?.typecheck;
    if (!script) continue;
    const translated = translateTypecheckScript(script);
    if (!translated) {
      die(2, `unsupported typecheck script shape in ${pkg}/package.json: "${script}" — verify-commit supports "[wrangler types &&] tsc <args>" only (extend translateTypecheckScript if the repo grows a new shape)`);
    }
    const tscBin = path.join(wt, pkg, 'node_modules', '.bin', 'tsc');
    if (!fs.existsSync(tscBin)) {
      die(2, `${pkg}: no node_modules/.bin/tsc in the main tree — run \`pnpm install\` in the main repo first`);
    }
    targets.push({ pkg, tscBin, tscArgs: translated.tscArgs, needsWranglerTypes: translated.needsWranglerTypes });
  }
  const wranglerTargets = targets.filter((t) => t.needsWranglerTypes && !wranglerTypesProvided);
  if (wranglerTargets.length > 0) {
    // Cold start: the main tree has no worker-configuration.d.ts yet — run
    // `wrangler types` INSIDE the worktree (needs the account-local
    // wrangler.jsonc copied in; .dev.vars is runtime-only and NOT needed here).
    const cfgRel = 'apps/worker/wrangler.jsonc';
    const cfgSrc = path.join(state.repoRoot, cfgRel);
    if (!fs.existsSync(cfgSrc)) {
      die(2, `main tree has neither ${'apps/worker/worker-configuration.d.ts'} nor ${cfgRel} — run \`pnpm typecheck\` once in the main repo (or \`pnpm setup:deploy\`) and retry`);
    }
    fs.copyFileSync(cfgSrc, path.join(wt, cfgRel));
    const wranglerBin = path.join(wt, 'apps/worker/node_modules/.bin/wrangler');
    if (!fs.existsSync(wranglerBin)) {
      die(2, 'no wrangler binary in the main tree — run `pnpm install` in the main repo first');
    }
    const res = spawnSync(wranglerBin, ['types'], {
      cwd: path.join(wt, 'apps/worker'),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.status !== 0) {
      die(2, `wrangler types failed inside the candidate worktree:\n${res.stdout || ''}\n${res.stderr || ''}`);
    }
  }

  // --- diff-of-states summary: what this candidate commit WOULD land --------
  const table = entries.map((e) => {
    const vs = e.action === 'delete' ? 'D' : (e.headMode ? 'M' : 'A');
    const cand = e.action === 'delete' ? '(deleted)' : `${e.blob.slice(0, 12)} ${e.mode}`;
    const src = e.action === 'delete' ? 'absent from working tree at snapshot' : 'working-tree content at snapshot';
    return `  ${vs} ${e.path}\n      candidate: ${cand}   source: ${src}`;
  });
  process.stdout.write(
    `verify-commit: candidate ${usePathsMode ? `for pathspec commit (--paths)` : `for staged-index commit`}\n` +
    `  base HEAD: ${head}\n  candidate tree: ${tree}  temp commit: ${commit}\n` +
    `  snapshot taken: ${snapshotAt.toISOString()} (later working-tree edits are NOT covered)\n` +
    `  candidate paths vs HEAD:\n${table.join('\n')}\n`,
  );

  let failed = false;
  // Typecheck targets, packages/* before apps/* (workspace dependency
  // direction — mirrors `pnpm -r` topological order for this workspace shape;
  // the engine's dist-types boundary must be emitted BEFORE the worker's
  // program resolves @cf-gitea/git-engine, or the worker would compile engine
  // SOURCES under the worker's stricter tsconfig — noise error classes the
  // real `pnpm typecheck` never sees).
  const rank = (pkg) => (pkg.startsWith('packages/') ? 0 : 1);
  targets.sort((a, b) => rank(a.pkg) - rank(b.pkg) || a.pkg.localeCompare(b.pkg));
  for (const t of targets) {
    const args = [...t.tscArgs, '--pretty', 'false'];
    const res = spawnSync(t.tscBin, args, { cwd: path.join(wt, t.pkg), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const ok = res.status === 0;
    process.stdout.write(`verify-commit: typecheck ${t.pkg}: ${ok ? 'PASS' : 'FAIL'}  (tsc ${t.tscArgs.join(' ')})\n`);
    if (!ok) {
      failed = true;
      const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
      if (out) process.stdout.write(`--- ${t.pkg} diagnostics (candidate committed-state) ---\n${out}\n--- end ${t.pkg} ---\n`);
    }
  }

  if (failed) {
    process.stdout.write(
      `verify-commit: FAIL — the candidate COMMITTED state (above table) does not typecheck. Do not commit it; fix and re-run. Note: this verdict is about the snapshot taken at ${snapshotAt.toISOString()}.\n`,
    );
    return 1;
  }
  process.stdout.write(`verify-commit: PASS — the candidate COMMITTED state typechecks (snapshot ${snapshotAt.toISOString()}).\n`);
  return 0;
}

let exitCode;
try {
  exitCode = main();
} catch (err) {
  process.stderr.write(`verify-commit: environment error: ${err?.message || err}\n`);
  exitCode = 2;
} finally {
  cleanup();
}
process.exit(exitCode);
