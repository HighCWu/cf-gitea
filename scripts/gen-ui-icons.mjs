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
// Shell constraint: shell.tsx's Icon hardcodes viewBox="0 0 16 16" and
// renders one `<path>` per extracted d body, so every allowlisted icon must
// be a 16x16 octicon with AT LEAST one `<path>`; single- and multi-path
// bodies coexist (the wave-4 extension: octicon-issue-opened/-closed carry
// two paths each). Anything else fails here (same fail-fast as the assets
// build's input assertions). gitea/ is only ever READ — never written, never
// emitted into (AGENTS.md submodule hygiene).
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
// Wave 3 (issue/PR detail + tab strip) adds the issue-family glyphs: PR state
// machine (open/closed/draft), merge, the reopen event dot and the sidebar
// milestone mark. Wave 4 (pages wave 4) restores the issue-state glyphs the
// wave-3 header deferred: octicon-issue-opened / octicon-issue-closed carry
// TWO <path> elements each, which the multi-path Icon now carries (the
// single-path-era degradation notes in issues-list.tsx / issue-detail.tsx
// were retired with it). Wave 6 (org home + milestones) adds the org-profile
// header glyphs (organization avatar placeholder, location/link/email rows),
// the milestone row marks (calendar due date, clock closed/updated stamps)
// and the closed-issue tab count (check). Wave 7 (user profile) adds the
// profile avatar placeholder glyph (octicon-person — the org placeholder's
// user twin). Wave 8 (web file editor) adds the file-view write actions'
// glyphs (view_file.tmpl:72-84 CanContentChange block): pencil (edit), trash
// (delete) and the tree chrome's New File mark (plus). Wave 10
// (notifications page + mirror panel) adds the notifications family's
// glyphs (the navbar bell, the mark-all checklist, the row pin mark, the
// empty-tab inbox, the mark-as-unread bell reuse) and the mirror panel's
// sync mark is the existing clock — the five additions below cover the
// notifications grep under apps/worker/src/ui. Wave-star-watch-counters
// (the repo social fork rows) adds the shared/repo/list:45-46 trailing
// stars mark (octicon-star). Wave 16 (the repo branches
// page) adds the protection mark the list rows render when a first-match
// rule governs the branch (list.tmpl's `{{if .IsProtected}}{{svg
// "octicon-shield-lock"}}` — the render extras' consumer, SPEC-0013 §3.6).
// Wave 20 (the releases family) adds the header.tmpl:158 tab glyph
// (octicon-tag) and the release list/detail entry glyphs the survey's #4
// family renders: the commit ShortSha mark (octicon-git-commit — the
// wave-16 refusal is superseded: the release meta row's commit link is the
// family's headline feature), the attachment row's package mark, the source
// row's zip mark and the download-count tooltip's info mark (release/
// list.tmpl:14,84,89,99,104).
const ALLOWLIST = [
  'octicon-bell',
  'octicon-calendar',
  'octicon-check',
  'octicon-checklist',
  'octicon-clock',
  'octicon-code',
  'octicon-file-zip',
  'octicon-git-commit',
  'octicon-info',
  'octicon-package',
  'octicon-search',
  'octicon-star',
  'octicon-tag',
  'octicon-dot-fill',
  'octicon-file',
  'octicon-file-directory-fill',
  'octicon-git-merge',
  'octicon-git-pull-request',
  'octicon-git-pull-request-closed',
  'octicon-git-pull-request-draft',
  'octicon-globe',
  'octicon-history',
  'octicon-inbox',
  'octicon-issue-closed',
  'octicon-issue-opened',
  'octicon-link',
  'octicon-location',
  'octicon-mail',
  'octicon-milestone',
  'octicon-organization',
  'octicon-pencil',
  'octicon-person',
  'octicon-pin',
  'octicon-plus',
  'octicon-repo',
  'octicon-shield-lock',
  'octicon-three-bars',
  'octicon-trash',
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
        console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 32).join('\n'));
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

// Extract every `<path d="…">` body per allowlisted icon; fail fast, listing
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
  if (ds.length === 0) {
    unusable.push(`${name}.svg: no <path d> found (Icon renders one <path> per body)`);
    continue;
  }
  bodies[name] = ds;
}
if (missing.length > 0) {
  fail(`missing icon file(s) in ${svgDir}: ${missing.map((n) => `${n}.svg`).join(', ')}`);
}
if (unusable.length > 0) {
  fail(`icon file(s) unusable by the shell's 16x16 multi-path Icon:\n  ${unusable.join('\n  ')}`);
}

// Deterministic emission: fixed allowlist order, no timestamps — byte-identical
// output across runs, so regeneration is diff-clean. Every value is the
// icon's `<path d>` list (single-path icons keep exactly one entry, so their
// rendered DOM is unchanged).
const entries = ALLOWLIST.map((name) => {
  const ds = bodies[name].map((d) => `"${d.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(', ');
  return `  "${name}": [${ds}],`;
}).join('\n');

const generated = `/**
 * GENERATED by scripts/gen-ui-icons.mjs — do not edit by hand.
 * Regenerate with \`pnpm gen:icons\` (wired as predev/prebuild/pretest and a
 * CI step before typecheck). This file is GITIGNORED (SPEC-0008 §2.4.1):
 * the committed inputs are the pinned submodule's
 * gitea/public/assets/img/svg/octicon-<name>.svg bodies, the committed
 * facade is src/ui/icons.ts, which re-exports this module unchanged.
 *
 * 16x16 octicons, one entry per \`<path d>\` body (single- and multi-path
 * both allowed) — shell.tsx's Icon hardcodes viewBox="0 0 16 16" and renders
 * one <path> per entry; the generator asserts the viewbox and non-emptiness.
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
