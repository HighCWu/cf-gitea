#!/usr/bin/env node
// build-gitea-assets.mjs — build the vendored Gitea frontend assets standalone (no Go)
// and emit the deployable tree for Workers Static Assets.
//
// Implements the procedure proven in docs/ui-tier2-plan.md §3: the gitea/ submodule's
// frontend (Vite 8) builds from committed sources only — web_src/, public/assets/img,
// public/assets/emoji.json, assets/*.json, and the build configs — so the whole build
// runs in a scratch directory outside the repo and never writes inside gitea/.
//
// Steps: copy inputs -> pnpm install --frozen-lockfile -> clean output entries ->
// pnpm exec vite build (production, sourcemaps off) -> verify manifest -> emit into
// the target directory -> verify the avatar fallback asset -> print inventory.
//
// Usage:
//   node scripts/build-gitea-assets.mjs [options]
//
// Options:
//   --gitea <dir>       Path to the gitea/ submodule.
//                       Default: <repo root>/gitea (repo root = parent of scripts/).
//   --out <dir>         Emit target for the built tree.
//                       Default: <repo root>/apps/worker/public/assets
//                       The script clears ONLY its own entry names inside --out
//                       (js/ css/ fonts/ img/ .vite/ licenses.txt emoji.json) and
//                       leaves anything else (e.g. a _headers file) untouched.
//   --work <dir>        Reuse an existing work/build directory instead of a fresh
//                       mkdtemp under os.tmpdir(). Must be outside the repository.
//   --skip-install      Skip `pnpm install` (assumes --work already has node_modules).
//   --sourcemaps        Keep sourcemaps (default: off — deploy setting; the vite
//                       config's "reduced" mode still writes maps for main bundles).
//   --pnpm <cmd>        pnpm executable (default: $PNPM or "pnpm").
//   --keep              Keep the work directory after a successful build.
//
// Requirements: node >= 22, pnpm >= 12.13 (gitea package.json engines), git submodule
// checked out. Zero npm dependencies beyond what the gitea build installs itself.
//
// Exit codes: 0 success; 1 usage/config error; build failures propagate pnpm's code.

import {spawnSync} from 'node:child_process';
import console from 'node:console';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, URL} from 'node:url';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function parseArgs(argv) {
  const opts = {
    gitea: path.join(repoRoot, 'gitea'),
    out: path.join(repoRoot, 'apps', 'worker', 'public', 'assets'),
    work: null,
    skipInstall: false,
    sourcemaps: false,
    pnpm: process.env.PNPM || 'pnpm',
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`missing value for ${arg}`);
      return argv[++i];
    };
    switch (arg) {
      case '--gitea': opts.gitea = path.resolve(next()); break;
      case '--out': opts.out = path.resolve(next()); break;
      case '--work': opts.work = path.resolve(next()); break;
      case '--skip-install': opts.skipInstall = true; break;
      case '--sourcemaps': opts.sourcemaps = true; break;
      case '--pnpm': opts.pnpm = next(); break;
      case '--keep': opts.keep = true; break;
      case '--help': case '-h':
        console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 30).join('\n'));
        process.exit(0);
        break; // eslint no-fallthrough: exit(0) never returns, default is unreachable
      default: fail(`unknown option: ${arg} (see --help)`);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`build-gitea-assets: ${message}`);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Input validation — the exact committed files the gitea vite build reads.
// See docs/ui-tier2-plan.md §2.3. If upstream stops committing a generated file
// (svg sprite, emoji.json, codemirror-languages.json, go-licenses.json), this
// list is where the failure must be reported precisely.
// ---------------------------------------------------------------------------

const gitea = opts.gitea;
const requiredInputs = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'vite.config.ts',
  'tailwind.config.ts',
  'tools/shared.ts',
  'assets/codemirror-languages.json',
  'assets/go-licenses.json',
  'public/assets/emoji.json',
  // The avatar fallback chain's terminal asset: src/services/avatars.ts
  // defaultAvatarLink() emits /assets/img/avatar_default.png as the redirect
  // target for EVERY by-hash avatar request at the frozen settings, and the
  // Workers Static Assets store (wrangler.jsonc assets.directory ./public)
  // serves it. If upstream stops committing it, the chain 404s at the edge —
  // reported here, loudly, at build time.
  'public/assets/img/avatar_default.png',
];
for (const rel of requiredInputs) {
  if (!existsSync(path.join(gitea, rel))) fail(`missing required input in gitea submodule: ${path.join(gitea, rel)}`);
}
if (!statSync(path.join(gitea, 'web_src')).isDirectory()) fail(`missing ${path.join(gitea, 'web_src')}`);
if (!statSync(path.join(gitea, 'public/assets/img')).isDirectory()) fail(`missing ${path.join(gitea, 'public/assets/img')} (run the svg generation into a scratch copy if upstream uncommitted it)`);

// Safety: never read-modify anything inside gitea/, never emit into gitea/.
const insideGitea = (p) => path.resolve(p).startsWith(path.resolve(gitea) + path.sep);
if (insideGitea(opts.out)) fail(`--out must be outside the gitea submodule: ${opts.out}`);
if (opts.work && insideGitea(opts.work)) fail(`--work must be outside the gitea submodule: ${opts.work}`);

// ---------------------------------------------------------------------------
// 1) Prepare the work directory and copy inputs
// ---------------------------------------------------------------------------

let work = opts.work;
if (work) {
  mkdirSync(work, {recursive: true});
} else {
  work = mkdtempSync(path.join(os.tmpdir(), 'gitea-assets-build-'));
}
const created = opts.work ? 'reused' : 'created';
console.log(`build-gitea-assets: work dir ${created}: ${work}`);

// Copying web_src fresh on every run keeps the work dir correct even after a
// submodule re-pin when reusing --work.
console.log('build-gitea-assets: copying inputs from gitea/ ...');
rmSync(path.join(work, 'web_src'), {recursive: true, force: true});
cpSync(path.join(gitea, 'web_src'), path.join(work, 'web_src'), {recursive: true});
mkdirSync(path.join(work, 'public/assets'), {recursive: true});
rmSync(path.join(work, 'public/assets/img'), {recursive: true, force: true});
cpSync(path.join(gitea, 'public/assets/img'), path.join(work, 'public/assets/img'), {recursive: true});
cpSync(path.join(gitea, 'public/assets/emoji.json'), path.join(work, 'public/assets/emoji.json'));
rmSync(path.join(work, 'assets'), {recursive: true, force: true});
cpSync(path.join(gitea, 'assets'), path.join(work, 'assets'), {recursive: true});
rmSync(path.join(work, 'tools'), {recursive: true, force: true});
mkdirSync(path.join(work, 'tools'));
cpSync(path.join(gitea, 'tools/shared.ts'), path.join(work, 'tools/shared.ts'));
for (const rel of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vite.config.ts', 'tailwind.config.ts']) {
  cpSync(path.join(gitea, rel), path.join(work, rel));
}

// ---------------------------------------------------------------------------
// 2) Install dependencies (gitea's own lockfile; its pnpm-workspace.yaml sets
//    ignoreScripts:true so no lifecycle scripts run)
// ---------------------------------------------------------------------------

const nodeModules = path.join(work, 'node_modules');
if (opts.skipInstall && existsSync(nodeModules)) {
  console.log('build-gitea-assets: --skip-install, reusing existing node_modules');
} else {
  console.log('build-gitea-assets: pnpm install --frozen-lockfile ...');
  const install = spawnSync(opts.pnpm, ['install', '--frozen-lockfile'], {cwd: work, stdio: 'inherit'});
  if (install.status !== 0) fail(`pnpm install failed with code ${install.status}`);
}

// ---------------------------------------------------------------------------
// 3) Clean the vite output entries (mirrors `make frontend`'s rm -rf), then build.
//    NOTE: public/assets/emoji.json is NOT cleaned — it is a build *input* that the
//    build also re-emits verbatim as an output asset at the same path.
// ---------------------------------------------------------------------------

const assetsDir = path.join(work, 'public', 'assets');
for (const entry of ['js', 'css', 'fonts', '.vite', 'licenses.txt']) {
  rmSync(path.join(assetsDir, entry), {recursive: true, force: true});
}

console.log(`build-gitea-assets: pnpm exec vite build (production, sourcemaps ${opts.sourcemaps ? 'on' : 'off'}) ...`);
const build = spawnSync(opts.pnpm, ['exec', 'vite', 'build'], {
  cwd: work,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    ENABLE_SOURCEMAP: opts.sourcemaps ? 'true' : 'false',
    // Do not inherit CI: vite.config enables a fail-on-warnings plugin when CI is set.
    CI: undefined,
  },
});
if (build.status !== 0) fail(`vite build failed with code ${build.status}`);

// ---------------------------------------------------------------------------
// 4) Verify the manifest — the same entries Gitea's Go templates resolve through
//    modules/public/manifest.go; our Hono JSX resolves them identically at runtime.
// ---------------------------------------------------------------------------

const manifestPath = path.join(assetsDir, '.vite', 'manifest.json');
if (!existsSync(manifestPath)) fail(`vite build produced no manifest at ${manifestPath}`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const requiredEntries = [
  'web_src/js/index.ts',
  'web_src/js/iife.ts',
  'web_src/js/swagger.ts',
  'web_src/js/external-render-frontend.ts',
  'web_src/js/external-render-helper.ts',
  'web_src/js/user-events.sharedworker.ts',
  ...readdirSync(path.join(gitea, 'web_src/css/themes'))
    .filter((f) => f.endsWith('.css'))
    .map((f) => `web_src/css/themes/${f}`),
];
const missing = requiredEntries.filter((key) => !manifest[key] || !existsSync(path.join(assetsDir, manifest[key].file)));
if (missing.length > 0) fail(`manifest is missing required entries: ${missing.join(', ')}`);

// ---------------------------------------------------------------------------
// 5) Emit into --out: everything vite produced plus the static img/ tree, minus
//    *.map. Only the script's own entry names are cleared in --out, so co-located
//    files (e.g. a _headers cache-policy file) survive re-emission.
// ---------------------------------------------------------------------------

const out = opts.out;
mkdirSync(out, {recursive: true});
for (const entry of ['js', 'css', 'fonts', 'img', '.vite', 'licenses.txt', 'emoji.json']) {
  rmSync(path.join(out, entry), {recursive: true, force: true});
}

let files = 0;
let bytes = 0;
const emit = (srcRel) => {
  const src = path.join(assetsDir, srcRel);
  if (!existsSync(src)) return;
  const dst = path.join(out, srcRel);
  if (statSync(src).isDirectory()) {
    cpSync(src, dst, {recursive: true});
  } else {
    cpSync(src, dst);
  }
};
emit('js');
emit('css');
emit('fonts');
emit('img');
emit('.vite');
emit('licenses.txt');
emit('emoji.json');

// Emission-side guard (mirror of the requiredInputs check): the img/ tree is
// copied recursively, so the file can only go missing if a future emit-list
// change stops covering it — fail loudly instead of shipping a build whose
// avatar fallback chain dead-ends in a 404.
if (!existsSync(path.join(out, 'img', 'avatar_default.png'))) {
  fail(`emitted tree is missing img/avatar_default.png — the avatar fallback chain's terminal asset (defaultAvatarLink -> /assets/img/avatar_default.png)`);
}

// Inventory of what was emitted (excluding maps, which are never emitted).
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      files++;
      bytes += statSync(p).size;
    }
  }
};
walk(out);

// ---------------------------------------------------------------------------
// 6) Report
// ---------------------------------------------------------------------------

const indexEntry = manifest['web_src/js/index.ts'];
const iifeEntry = manifest['web_src/js/iife.ts'];
console.log(`
build-gitea-assets: SUCCESS
  gitea pin : ${getGiteaPin()}
  emitted   : ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB -> ${out}
  index.js  : ${indexEntry.file}${indexEntry.css.length ? ` (css: ${indexEntry.css.join(', ')})` : ''}
  iife.js   : ${iifeEntry.file} (blocking; jQuery + Fomantic dropdown/api fork)
  themes    : ${requiredEntries.filter((k) => k.includes('themes/')).map((k) => manifest[k].file).join(', ')}

Head links for Hono JSX (resolved via assets/.vite/manifest.json, like
gitea's modules/public/manifest.go):
  <link rel="stylesheet" href="/assets/${indexEntry.css[0]}">
  <link rel="stylesheet" href="/assets/${manifest['web_src/css/themes/theme-gitea-light.css']?.file ?? '<theme css>'}">
  <script src="/assets/${iifeEntry.file}"></script>
  <script type="module" src="/assets/${indexEntry.file}"></script>
`);

// The submodule's .git is usually a *file* ("gitdir: <path>"), not a directory.
function getGiteaPin() {
  try {
    const gitPath = path.join(gitea, '.git');
    const gitDir = statSync(gitPath).isDirectory()
      ? gitPath
      : path.resolve(gitea, readFileSync(gitPath, 'utf8').trim().replace(/^gitdir:\s*/, ''));
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const commit = head.startsWith('ref:')
      ? readFileSync(path.join(gitDir, head.slice(4).trim()), 'utf8').trim()
      : head;
    return commit.slice(0, 12);
  } catch {
    return 'unknown';
  }
}
