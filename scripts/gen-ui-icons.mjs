#!/usr/bin/env node
// gen-ui-icons.mjs — generate apps/worker/src/ui/icons.generated.ts from the
// committed octicon SVG bodies in the gitea/ submodule (SPEC-0008 §2.4.1
// icons row: inline `<svg class="svg octicon-…">` like upstream `{{svg}}`).
//
// The allowlist below is the union of:
//   - every `octicon-…` name rendered via `<Icon name="octicon-…">` under
//     apps/worker/src/ui (grep there first when adding pages), and
//   - the seven U2 interim icons hand-embedded in icons.ts before this
//     generator existed (adds globe / file / file-directory-fill for the
//     upcoming file-list components).
// The committed facade src/ui/icons.ts re-exports the generated module and
// the generated file is GITIGNORED — on a fresh clone `pnpm gen:icons` (also
// wired as predev/prebuild/pretest and a CI step before typecheck) must run
// before typecheck/tests, exactly like the gitignored assets build output.
//
// Shell constraint: shell.tsx's Icon hardcodes viewBox="0 0 16 16" and a
// single `<path>`, so every allowlisted icon must be a single-path 16x16
// octicon; anything else fails here (same fail-fast as the assets build's
// input assertions). gitea/ is only ever READ — never written, never emitted
// into (AGENTS.md submodule hygiene).
//
// Usage:
//   node scripts/gen-ui-icons.mjs [options]
//
// Options:
//   --gitea <dir>   Path to the gitea/ submodule.
//                   Default: <repo root>/gitea (repo root = parent of scripts/).
//   --out <dir>     Directory that receives icons.generated.ts.
//                   Default: <repo root>/apps/worker/src/ui.
//
// Exit codes: 0 success; 1 usage error or missing/unusable icon input.

import console from 'node:console';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath, URL} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

// SPEC-0008 §2.4.1 icon allowlist (sorted; derivation in the header above).
const ALLOWLIST = [
  'octicon-code',
  'octicon-file',
  'octicon-file-directory-fill',
  'octicon-globe',
  'octicon-history',
  'octicon-repo',
  'octicon-three-bars',
];

// What shell.tsx's Icon component hardcodes; a body needing anything else
// must come with a shell.tsx change first, not a silent misrender here.
const REQUIRED_VIEWBOX = '0 0 16 16';
const GENERATED_NAME = 'icons.generated.ts';

function fail(message) {
  console.error(`gen-ui-icons: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    gitea: path.join(repoRoot, 'gitea'),
    out: path.join(repoRoot, 'apps', 'worker', 'src', 'ui'),
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
      case '--help': case '-h':
        console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 31).join('\n'));
        process.exit(0);
        break; // eslint no-fallthrough: exit(0) never returns, default is unreachable
      default: fail(`unknown option: ${arg} (see --help)`);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

// Submodule hygiene: read-only on gitea/, and never emit inside it (same
// guard shape as build-gitea-assets.mjs).
const insideGitea = (p) => path.resolve(p).startsWith(path.resolve(opts.gitea) + path.sep);
if (insideGitea(opts.out)) fail(`--out must be outside the gitea submodule: ${opts.out}`);

const svgDir = path.join(opts.gitea, 'public', 'assets', 'img', 'svg');
if (!existsSync(svgDir) || !statSync(svgDir).isDirectory()) {
  fail(`missing ${svgDir} (is the gitea/ submodule checked out? git submodule update --init)`);
}

// Extract one `<path d="…">` body per allowlisted icon; fail fast, listing
// every problem at once (missing file = same failure class as the assets
// build's required-input assertions).
const bodies = {};
const missing = [];
const unusable = [];
for (const name of ALLOWLIST) {
  const file = path.join(svgDir, `${name}.svg`);
  if (!existsSync(file)) {
    missing.push(name);
    continue;
  }
  const svg = readFileSync(file, 'utf8');
  const viewBox = /\bviewBox="([^"]+)"/.exec(svg)?.[1];
  if (viewBox !== REQUIRED_VIEWBOX) {
    unusable.push(`${name}.svg: viewBox "${viewBox ?? '<none>'}" != "${REQUIRED_VIEWBOX}" (Icon hardcodes it)`);
    continue;
  }
  const ds = [...svg.matchAll(/<path\b[^>]*?\bd="([^"]+)"/g)].map((m) => m[1]);
  if (ds.length !== 1) {
    unusable.push(`${name}.svg: expected exactly 1 <path d>, found ${ds.length} (single-path octicons only)`);
    continue;
  }
  bodies[name] = ds[0];
}
if (missing.length > 0) {
  fail(`missing icon file(s) in ${svgDir}: ${missing.map((n) => `${n}.svg`).join(', ')}`);
}
if (unusable.length > 0) {
  fail(`icon file(s) unusable by the shell's single-path 16x16 Icon:\n  ${unusable.join('\n  ')}`);
}

// Deterministic emission: fixed allowlist order, no timestamps — byte-identical
// output across runs, so regeneration is diff-clean.
const entries = ALLOWLIST.map((name) => {
  const d = bodies[name].replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `  "${name}": "${d}",`;
}).join('\n');

const generated = `/**
 * GENERATED by scripts/gen-ui-icons.mjs — do not edit by hand.
 * Regenerate with \`pnpm gen:icons\` (wired as predev/prebuild/pretest and a
 * CI step before typecheck). This file is GITIGNORED (SPEC-0008 §2.4.1):
 * the committed inputs are the pinned submodule's
 * gitea/public/assets/img/svg/octicon-<name>.svg bodies, the committed
 * facade is src/ui/icons.ts, which re-exports this module unchanged.
 *
 * Single-path 16x16 octicons only — shell.tsx's Icon hardcodes
 * viewBox="0 0 16 16" and one <path>; the generator asserts both.
 */

export const ICON_PATHS = {
${entries}
} as const;

export type IconName = keyof typeof ICON_PATHS;
`;

mkdirSync(opts.out, {recursive: true});
const outFile = path.join(opts.out, GENERATED_NAME);
writeFileSync(outFile, generated);

console.log(`gen-ui-icons: wrote ${outFile} (${ALLOWLIST.length} icons, ${generated.length} bytes, gitea pin inputs from ${svgDir})`);
