#!/usr/bin/env node
/* global Buffer, console, process -- Node globals (repo lint convention: no node env in the flat config) */
/**
 * Self-tests for scripts/verify-commit.mjs.
 *
 * Builds a scratch git repo in the OS temp dir via plumbing (git init,
 * config, a HEAD commit with a minimal tsconfig + ts file), points its
 * `tsc` at the REAL repo's TypeScript install, then verifies the gate:
 *
 *   1. a clean candidate (--paths on an unmodified committed file) PASSES;
 *   2. a candidate introducing a type error FAILS with exit 1 while the
 *      SCRATCH repo's working tree stays byte-identical and the real index
 *      is untouched (porcelain status identical before/after), and no temp
 *      worktree survives;
 *   3. staged-index mode (no --paths) verifies the staged content and fails
 *      on a staged type error;
 *   4. a docs-only pathspec skips with exit 0.
 *
 * The scratch repo is fully owned by this test — the real repo is only read
 * (its typescript binary via absolute symlink). Run: `node
 * scripts/verify-commit.test.mjs`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REAL_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REAL_TSC = path.join(REAL_REPO, 'apps/worker/node_modules/.bin/tsc');
const GATE = path.join(REAL_REPO, 'scripts', 'verify-commit.mjs');

let failures = 0;
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-commit-selftest-'));
const repo = path.join(scratchRoot, 'repo');

function git(args, opts = {}) {
  const res = spawnSync('git', args, { cwd: repo, encoding: 'utf8', ...opts });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${res.status}): ${(res.stderr || '').trim()}`);
  }
  return res.stdout;
}

function runGate(args) {
  return spawnSync(process.execPath, [GATE, ...args], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function tmpSessionDirs() {
  return fs.readdirSync(os.tmpdir()).filter((e) => e.startsWith('verify-commit-')).sort();
}

function porcelain() {
  return spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout;
}

function worktreeCount() {
  const out = git(['worktree', 'list', '--porcelain']);
  return out.split('\n').filter((l) => l.startsWith('worktree ')).length;
}

// ---------------------------------------------------------------------------
// Build the scratch repo
// ---------------------------------------------------------------------------

fs.mkdirSync(repo, { recursive: true });
git(['init', '-b', 'main']);
git(['config', 'user.name', 'verify-commit-selftest']);
git(['config', 'user.email', 'selftest@local']);
fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
fs.writeFileSync(path.join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n');
fs.writeFileSync(
  path.join(repo, 'README.md'),
  '# scratch\n\nDocs-only file for the fast-path test.\n',
);
fs.mkdirSync(path.join(repo, 'apps/app/src'), { recursive: true });
fs.writeFileSync(
  path.join(repo, 'apps/app/package.json'),
  JSON.stringify({ name: 'scratch-app', private: true, type: 'module', scripts: { typecheck: 'tsc --noEmit' } }, null, 2) + '\n',
);
fs.writeFileSync(
  path.join(repo, 'apps/app/tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['src/**/*.ts'] }, null, 2) + '\n',
);
const GOOD_TS = 'export const good: number = 1;\n';
const BAD_TS = 'const broken: string = 123;\nexport { broken };\n';
const okTs = path.join(repo, 'apps/app/src/ok.ts');
fs.writeFileSync(okTs, GOOD_TS);
// The scratch package's tsc is the REAL repo's TypeScript (absolute symlink);
// verify-commit must wire this node_modules into its candidate worktree.
fs.mkdirSync(path.join(repo, 'apps/app/node_modules/.bin'), { recursive: true });
fs.symlinkSync(REAL_TSC, path.join(repo, 'apps/app/node_modules/.bin/tsc'));
git(['add', '-A']);
const tree = git(['write-tree']).trim();
const head = spawnSync('git', ['commit-tree', tree, '-m', 'initial'], {
  cwd: repo,
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'selftest', GIT_AUTHOR_EMAIL: 'selftest@local',
    GIT_COMMITTER_NAME: 'selftest', GIT_COMMITTER_EMAIL: 'selftest@local',
  },
}).stdout.trim();
git(['update-ref', 'refs/heads/main', head]);

if (!fs.existsSync(REAL_TSC)) {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
  console.error('ABORT: real repo has no apps/worker/node_modules/.bin/tsc — run `pnpm install` in the main repo first');
  process.exit(2);
}

const baselineTmp = tmpSessionDirs();

// ---------------------------------------------------------------------------
// Test 1: clean candidate (--paths, unmodified committed file) passes
// ---------------------------------------------------------------------------
{
  const res = runGate(['--paths', 'apps/app/src/ok.ts']);
  check('clean candidate exits 0', res.status === 0, `status=${res.status}\nstdout=${res.stdout}\nstderr=${res.stderr}`);
  check('clean candidate prints PASS', res.stdout.includes('PASS'), res.stdout);
  check('clean candidate shows candidate table', res.stdout.includes('apps/app/src/ok.ts'), res.stdout);
}

// ---------------------------------------------------------------------------
// Test 2: docs-only pathspec hits the fast path (exit 0, skip line)
// ---------------------------------------------------------------------------
{
  const res = runGate(['--paths', 'README.md']);
  check('docs-only candidate exits 0', res.status === 0, `status=${res.status}\nstdout=${res.stdout}`);
  check('docs-only candidate prints skip line', res.stdout.includes('skip'), res.stdout);
}

// ---------------------------------------------------------------------------
// Test 3: a type-error candidate FAILS (exit 1) while the scratch working
// tree stays byte-identical and no state outside the candidate leaks
// ---------------------------------------------------------------------------
{
  fs.writeFileSync(okTs, BAD_TS); // the candidate's working-tree snapshot
  // Baselines are captured AFTER the mutation: byte-identity asserts the GATE
  // left the snapshot content exactly as the test wrote it.
  const candidateBytes = fs.readFileSync(okTs);
  const porcelainBefore = porcelain();
  const res = runGate(['--paths', 'apps/app/src/ok.ts']);
  check('type-error candidate exits 1', res.status === 1, `status=${res.status}\nstdout=${res.stdout}`);
  check('type-error candidate reports tsc diagnostics', /error TS\d+/.test(res.stdout), res.stdout);
  check('type-error candidate prints FAIL verdict', res.stdout.includes('FAIL'), res.stdout);
  check('scratch working tree byte-identical after the run', fs.readFileSync(okTs).equals(candidateBytes));
  check('scratch git state (index+worktree) untouched by the gate', porcelain() === porcelainBefore);
  check('no temp worktree survives in the scratch repo', worktreeCount() === 1, `count=${worktreeCount()}`);
  check('gate cleaned up its temp session dirs', JSON.stringify(tmpSessionDirs()) === JSON.stringify(baselineTmp),
    `baseline=${JSON.stringify(baselineTmp)} now=${JSON.stringify(tmpSessionDirs())}`);
  // restore for the next test
  fs.writeFileSync(okTs, GOOD_TS);
}

// ---------------------------------------------------------------------------
// Test 4: staged-index mode (no --paths) verifies the STAGED content
// ---------------------------------------------------------------------------
{
  fs.writeFileSync(okTs, BAD_TS);
  git(['add', 'apps/app/src/ok.ts']); // stage the broken content (index = bad)
  const candidateBytes = fs.readFileSync(okTs);
  const porcelainStaged = porcelain();
  const res = runGate([]);
  check('staged type-error candidate exits 1', res.status === 1, `status=${res.status}\nstdout=${res.stdout}`);
  check('staged mode reports tsc diagnostics', /error TS\d+/.test(res.stdout), res.stdout);
  check('staged mode labels itself in output', res.stdout.includes('staged-index'), res.stdout);
  check('staged mode left the working tree byte-identical', fs.readFileSync(okTs).equals(candidateBytes));
  check('staged mode left the real index untouched', porcelain() === porcelainStaged);
  check('no temp worktree survives (staged mode)', worktreeCount() === 1);
  // clean the scratch index + working tree back to HEAD
  git(['reset', '--hard', 'HEAD']);
  check('reset restored the good content', fs.readFileSync(okTs).equals(Buffer.from(GOOD_TS)));
}

// ---------------------------------------------------------------------------
// Test 5: exit code 2 on a pathspec that matches nothing (usage error)
// ---------------------------------------------------------------------------
{
  const res = runGate(['--paths', 'does/not/exist.ts']);
  check('pathspec matching nothing exits 2', res.status === 2, `status=${res.status}\nstdout=${res.stdout}`);
}

// ---------------------------------------------------------------------------
// Cleanup + verdict
// ---------------------------------------------------------------------------
fs.rmSync(scratchRoot, { recursive: true, force: true });

if (failures > 0) {
  console.error(`verify-commit.test.mjs: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('verify-commit.test.mjs: all self-tests passed');
