#!/usr/bin/env node
/* global process, console -- Node globals (repo lint convention: no node env in the flat config); the rest rides node: imports */
/**
 * upstream-drift.mjs — the Gitea Upstream Drift Analyzer (zero npm deps, Node >= 20, system git).
 *
 *   node scripts/upstream-drift.mjs --from <sha> --to <sha> [--html out.html]
 *   node scripts/upstream-drift.mjs --current                # recorded gitlink vs the working submodule HEAD
 *   node scripts/upstream-drift.mjs --selftest               # inline fixtures + a real temp-git fixture
 *
 * Automates what the behavioral census (docs/compat/behavioral-census.md) does
 * manually: map a gitea/ submodule re-pin's changes onto OUR landed pages and
 * tests through the upstream citation anchors the codebase carries in its
 * comments and test descriptions (`header.tmpl:107`,
 * `routers/web/repo/milestone.go:35`, `issue_list.go:661/672`,
 * `services/issue/pull.go:253-310`, bare shorthand `(:82-85 ...)` bound to the
 * nearest explicit path in the same comment block).
 *
 * Read-only over gitea/ and apps/worker/src/. Reports three severity buckets:
 *   (a) CITED-LINE MOVED      — the cite's line number shifted; refresh + re-check
 *   (b) CITED REGION CHANGED  — text under the cite changed; re-derive the port
 *   (c) FILE ADDED/REMOVED    — new/removed upstream surface (dead cites)
 * plus an informational section for changed upstream surface no cite covers.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GITEA_DIR = path.join(ROOT, 'gitea');
const SRC_DIR = path.join(ROOT, 'apps', 'worker', 'src');
const SCOPE_ROOTS = ['templates', 'routers', 'services', 'models'];
const GIT_ARGS = ['-c', 'core.quotepath=off'];
const MAX_BUFFER = 128 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Regexes — the citation grammar
// ---------------------------------------------------------------------------

/** Explicit cite: path-ish token ending .go/.tmpl, colon, line spec
 *  (`milestone.go:35`, `list.tmpl:25/31`, `pull.go:253-310`,
 *  `errpage.go:114/118-122`, `security/2fa.go:62,100,282`). */
const RE_EXPLICIT_CITE =
  /([A-Za-z0-9_][A-Za-z0-9_/.-]*\.(?:go|tmpl)):(\d+(?:-\d+)?(?:[/,]\d+(?:-\d+)?)*)/g;

/** Shorthand cite: bare `:NNN` / `:NN-NN` / `:NN/NN` NOT preceded by a path
 *  or word char (rejects `https://`, `12:30`, and the tail of explicit cites). */
const RE_SHORTHAND_CITE =
  /(?<![A-Za-z0-9_/.-]):(\d+(?:-\d+)?(?:[/,]\d+(?:-\d+)?)*)/g;

/** Unified-diff hunk header; counts may be omitted (`@@ -138 +138 @@` = 1). */
const RE_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// ---------------------------------------------------------------------------
// Git plumbing
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return execFileSync('git', [...GIT_ARGS, ...args], {
    cwd,
    maxBuffer: MAX_BUFFER,
    encoding: 'utf8',
  });
}

function verifyCommit(giteaDir, sha) {
  try {
    git(giteaDir, ['rev-parse', '--verify', `${sha}^{commit}`]);
  } catch {
    console.error(`upstream-drift: '${sha}' is not a commit inside gitea/ (fetch the submodule first)`);
    process.exit(1);
  }
}

/** `diff --name-status --no-renames -z` → [{status, path, oldPath}].
 *  Renames are DISABLED so R degrades to a D+A pair — exactly the bucket-(c)
 *  model (the old path's cites die, the new path is fresh surface). */
function parseNameStatus(raw) {
  const parts = raw.split('\0');
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const p = parts[i + 1];
    if (!status || !p) continue;
    files.push({ status, path: p, oldPath: p });
  }
  return files.filter((f) => ['A', 'D', 'M', 'T'].includes(f.status));
}

/** Unified diff (-U0) → Map(newOrOldPath → hunks[{oldStart,oldCount,newStart,newCount}]).
 *  Deleted files (+++ /dev/null) need no hunks — bucket (c) handles them. */
function parseHunksFromUnified(diffText) {
  const byFile = new Map();
  let current = null;
  for (const lineRaw of diffText.split('\n')) {
    const line = lineRaw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      current = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    if (current === null) continue;
    const m = RE_HUNK.exec(line);
    if (m) {
      const hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
      };
      const list = byFile.get(current) ?? [];
      list.push(hunk);
      byFile.set(current, list);
    }
  }
  return byFile;
}

/** `diff --numstat` → Map(path → {plus, minus}) ('-' for binary = null). */
function parseNumstat(raw) {
  const out = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const t1 = line.indexOf('\t');
    const t2 = line.indexOf('\t', t1 + 1);
    if (t2 < 0) continue;
    const plus = line.slice(0, t1);
    const minus = line.slice(t1 + 1, t2);
    const p = line.slice(t2 + 1);
    out.set(p, {
      plus: plus === '-' ? null : Number(plus),
      minus: minus === '-' ? null : Number(minus),
    });
  }
  return out;
}

/** All three diff views in one pass. scopeRoots is parameterizable so the
 *  selftest can drive the same plumbing against a tiny fixture repo. */
function collectUpstreamDiff(giteaDir, fromSha, toSha, scopeRoots = SCOPE_ROOTS) {
  const nameStatus = parseNameStatus(
    git(giteaDir, [
      'diff', '--name-status', '--no-renames', '-z', fromSha, toSha, '--', ...scopeRoots,
    ]),
  );
  const unified = git(giteaDir, [
    'diff', '-U0', '--no-color', '--no-renames',
    '--src-prefix=a/', '--dst-prefix=b/', fromSha, toSha, '--', ...scopeRoots,
  ]);
  const numstat = parseNumstat(
    git(giteaDir, [
      'diff', '--numstat', '--no-renames', fromSha, toSha, '--', ...scopeRoots,
    ]),
  );
  return { nameStatus, hunksByFile: parseHunksFromUnified(unified), numstat };
}

function formatHunk(h) {
  return `@@ -${h.oldStart}${h.oldCount === 1 ? '' : `,${h.oldCount}`} +${h.newStart}${h.newCount === 1 ? '' : `,${h.newCount}`} @@`;
}

// ---------------------------------------------------------------------------
// Citation extraction (the index)
// ---------------------------------------------------------------------------

/** Start index of a trailing `//` line comment — the first `//` NOT preceded
 *  by `:` (so `https://host` in a string never reads as a comment). */
function findLineCommentStart(line) {
  let idx = line.indexOf('//');
  while (idx > 0 && line[idx - 1] === ':') idx = line.indexOf('//', idx + 1);
  return idx;
}

/** Per-line comment SEGMENT (substring, or null when the line carries no
 *  comment). Block comments own their whole lines; jsdoc `*` continuation
 *  lines count whole; a trailing `// ...` contributes only its tail, so the
 *  shorthand scan never sees code colons like `foo("12:30")`. */
function commentSegments(lines) {
  const segments = new Array(lines.length).fill(null);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inBlock) {
      segments[i] = lines[i];
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('//')) {
      segments[i] = lines[i].slice(lines[i].indexOf('//'));
    } else if (t.startsWith('/*') || t.startsWith('*')) {
      segments[i] = lines[i];
      if (t.startsWith('/*') && t.indexOf('*/') < 0) inBlock = true;
    } else {
      const c = findLineCommentStart(lines[i]);
      if (c >= 0) segments[i] = lines[i].slice(c);
    }
  }
  return segments;
}

/** Line spec (`25/31`, `253-310`, `114/118-122`, `62,100,282`) → [{lo,hi}]. */
function parseLineSpec(spec) {
  const elements = [];
  for (const part of spec.split(/[/,]/)) {
    const dash = part.indexOf('-');
    if (dash > 0) {
      const lo = Number(part.slice(0, dash));
      const hi = Number(part.slice(dash + 1));
      elements.push({ lo, hi: hi >= lo ? hi : lo });
    } else {
      const n = Number(part);
      elements.push({ lo: n, hi: n });
    }
  }
  return elements;
}

/** Extract every upstream citation site from one of OUR source files.
 *  Explicit path cites are scanned on ALL lines (the test suites carry them in
 *  `it("... (container.go:116-130)")` descriptions); bare `:NNN` shorthand is
 *  scanned on comment segments only and bound to the nearest explicit cite in
 *  the same comment block (contiguous lines carrying comment segments — a
 *  trailing `// ...` on a code line participates like a full comment line). */
function extractCitations(relFile, text) {
  const lines = text.split('\n');
  const segments = commentSegments(lines);
  const cites = [];
  const seen = new Set();

  // Pass 1 — explicit cites (all lines), spans kept for masking so pass 2
  // never re-matches an explicit cite's tail as shorthand.
  const explicitByLine = new Map(); // lineIdx -> [{token, col, len}]
  for (let i = 0; i < lines.length; i++) {
    RE_EXPLICIT_CITE.lastIndex = 0;
    let m;
    while ((m = RE_EXPLICIT_CITE.exec(lines[i])) !== null) {
      const elements = parseLineSpec(m[2]);
      const list = explicitByLine.get(i) ?? [];
      list.push({ token: m[1], col: m.index, len: m[0].length });
      explicitByLine.set(i, list);
      const key = `${relFile}|${i + 1}|${m[1]}|${m[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        cites.push({
          ourFile: relFile,
          ourLine: i + 1,
          token: m[1],
          elements,
          kind: 'explicit',
          citeText: m[0],
        });
      }
    }
  }

  // Blocks = maximal runs of lines carrying a comment segment.
  const blockOf = new Array(lines.length).fill(-1);
  const blockExplicit = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const bi = blockExplicit.length;
    const entries = [];
    for (const li of run) {
      blockOf[li] = bi;
      for (const e of explicitByLine.get(li) ?? []) entries.push({ line: li, col: e.col, token: e.token });
    }
    entries.sort((a, b) => a.line - b.line || a.col - b.col);
    blockExplicit.push(entries);
    run = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (segments[i] !== null) run.push(i);
    else flush();
  }
  flush();

  // Pass 2 — shorthand cites (comment segments only), bound per block.
  for (let i = 0; i < lines.length; i++) {
    if (segments[i] === null) continue;
    // Mask every explicit span on this line, then scan only the segment slice.
    let masked = lines[i];
    for (const e of explicitByLine.get(i) ?? []) {
      masked = masked.slice(0, e.col) + ' '.repeat(e.len) + masked.slice(e.col + e.len);
    }
    const segStart = lines[i].length - segments[i].length;
    const segText = masked.slice(segStart);
    RE_SHORTHAND_CITE.lastIndex = 0;
    let m;
    while ((m = RE_SHORTHAND_CITE.exec(segText)) !== null) {
      const elements = parseLineSpec(m[1]);
      const entries = blockOf[i] >= 0 ? blockExplicit[blockOf[i]] : [];
      const before = entries.filter((e) => e.line < i || (e.line === i && e.col < segStart + m.index));
      const anchor = before.length ? before[before.length - 1] : entries[0];
      const key = `${relFile}|${i + 1}|${anchor ? anchor.token : ''}|${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cites.push({
        ourFile: relFile,
        ourLine: i + 1,
        token: anchor ? anchor.token : null,
        elements,
        kind: anchor ? 'shorthand' : 'unbound',
        citeText: m[0],
      });
    }
  }
  return cites;
}

function walkSources(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// Path resolution (token → upstream file at the cite-side commit)
// ---------------------------------------------------------------------------

function makeResolver(treePaths, lineCounts) {
  return function resolveToken(token, maxLine) {
    const t = token.replace(/^gitea\//, '');
    const matches = treePaths.filter((p) => p === t || p.endsWith(`/${t}`));
    if (matches.length === 1) return { path: matches[0], candidates: matches, narrowed: false };
    if (matches.length === 0) return { path: null, candidates: [], unresolved: true };
    // Ambiguous basename — narrow by line-count plausibility (a cite past a
    // candidate's EOF cannot point at it). lineCounts: Map(path -> lines).
    const plausible = matches.filter((p) => {
      const n = lineCounts.get(p);
      return n === undefined ? true : maxLine <= n;
    });
    if (plausible.length === 1) return { path: plausible[0], candidates: matches, narrowed: true };
    return { path: null, candidates: matches, ambiguous: true };
  };
}

// ---------------------------------------------------------------------------
// Classification math (which cited lines moved/changed)
// ---------------------------------------------------------------------------
//
// A hunk `@@ -a,b +c,d @@` removes/rewrites old lines [a, a+b) and puts new
// lines at [c, c+d). For zero counts git names the line BEFORE the gap:
// `-s,0` = insertion after old line s; `+s,0` = deletion after new line s.
//
// citeSide='from' → cites are valid at the FROM tree (forward re-pin):
//   element inside an old-side affected range  → CITED REGION CHANGED;
//   element after hunks with net delta ≠ 0     → CITED-LINE MOVED.
// citeSide='to' → cites are valid at the TO tree (the pin the census derives
// against); the same math runs on the new-side ranges, mirrored.

function classifyElement(hunks, lo, hi, citeSide) {
  const pts = hunks.map((h) =>
    citeSide === 'from'
      ? { start: h.oldStart, count: h.oldCount, delta: h.newCount - h.oldCount }
      : { start: h.newStart, count: h.newCount, delta: h.oldCount - h.newCount },
  );
  pts.sort((a, b) => a.start - b.start);
  let shift = 0;
  let changed = false;
  let split = false;
  for (const p of pts) {
    const affectedHi = p.count > 0 ? p.start + p.count - 1 : null;
    const afterBoundary = p.count > 0 ? affectedHi : p.start;
    if (affectedHi !== null && lo <= affectedHi && hi >= p.start) {
      changed = true;
      continue;
    }
    if (lo > afterBoundary) {
      shift += p.delta;
    } else if (hi > afterBoundary) {
      split = true; // cited range straddles an edit boundary — treat as changed
    }
  }
  if (changed) return { verdict: 'changed' };
  if (split) return { verdict: 'changed', split: true };
  if (shift !== 0) return { verdict: 'moved', shift };
  return { verdict: 'untouched' };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function shortSha(sha) {
  return sha.slice(0, 10);
}

function censusHint(relFile) {
  const norm = relFile.split(path.sep).join('/');
  if (isTestFile(path.basename(norm))) return `tests under src/${path.posix.dirname(norm) || '.'}`;
  if (norm.startsWith('ui/pages/')) {
    const stem = path.basename(norm).replace(/\.(tsx|ts)$/, '').split('.')[0];
    return `pages family: ${stem}`;
  }
  if (norm.startsWith('ui/components/')) return 'ui components';
  if (norm.startsWith('ui/')) return 'ui shell';
  const top = norm.split('/').slice(0, 2).join('/');
  return `module: src/${top}`;
}

function coreStem(base) {
  let s = base.replace(/\.(tsx|ts)$/, '');
  if (s.endsWith('.test')) s = s.slice(0, -'.test'.length);
  return s.replace(/\.(matrix|flash|smoke|type|aux)$/, '');
}

function isTestFile(base) {
  return /\.(matrix|flash|smoke)?\.?test\.(tsx|ts)$/.test(base) && base.includes('.test.');
}

/** Core analysis. Inputs are plain data so --selftest can drive it without git. */
function analyze(input) {
  const { nameStatus, hunksByFile, numstat, cites, resolveToken, citeSide } = input;

  const citesByPath = new Map(); // upstream path -> [cite]
  const unresolvedTokens = new Map(); // token -> count
  const unbound = [];
  const ambiguous = [];
  const ambiguousInWindow = []; // ambiguous cites whose candidates DID change — unattributable drift
  const statusByPath = new Map(nameStatus.map((f) => [f.path, f.status]));
  for (const cite of cites) {
    if (!cite.token) {
      unbound.push(cite);
      continue;
    }
    const maxLine = Math.max(...cite.elements.map((e) => e.hi));
    const res = resolveToken(cite.token, maxLine);
    if (res.path) {
      cite.resolved = res.path;
      cite.narrowed = res.narrowed;
      const list = citesByPath.get(res.path) ?? [];
      list.push(cite);
      citesByPath.set(res.path, list);
    } else if (res.ambiguous) {
      cite.candidates = res.candidates;
      // Window narrowing: the drift report only cares about candidates that
      // changed. Exactly one in-window candidate → attribute (marked);
      // several → the drift hit is real but unattributable — report honestly.
      const inWindow = res.candidates.filter((p) => statusByPath.has(p));
      if (inWindow.length === 1) {
        cite.resolved = inWindow[0];
        cite.windowNarrowed = true;
        const list = citesByPath.get(inWindow[0]) ?? [];
        list.push(cite);
        citesByPath.set(inWindow[0], list);
      } else if (inWindow.length > 1) {
        cite.inWindow = inWindow;
        ambiguousInWindow.push(cite);
        ambiguous.push(cite);
      } else {
        ambiguous.push(cite);
      }
    } else {
      unresolvedTokens.set(cite.token, (unresolvedTokens.get(cite.token) ?? 0) + 1);
    }
  }

  const bucketA = []; // CITED-LINE MOVED
  const bucketB = []; // CITED REGION CHANGED
  const bucketC = []; // FILE ADDED/REMOVED
  const uncited = []; // changed upstream surface with no citation coverage
  const intactByFile = []; // per changed upstream file: cites untouched

  for (const f of nameStatus) {
    const hunks = hunksByFile.get(f.path) ?? [];
    const ns = numstat.get(f.path) ?? { plus: null, minus: null };
    const hits = citesByPath.get(f.path) ?? [];

    if (f.status === 'A' || f.status === 'D') {
      bucketC.push({
        upFile: f.path,
        status: f.status,
        cites: hits,
        plus: ns.plus,
        minus: ns.minus,
      });
      if (!hits.length) uncited.push({ upFile: f.path, status: f.status, plus: ns.plus, minus: ns.minus });
      continue;
    }

    if (!hits.length) {
      uncited.push({ upFile: f.path, status: f.status, plus: ns.plus, minus: ns.minus });
      continue;
    }

    let affected = 0;
    for (const cite of hits) {
      const details = [];
      const moves = []; // per-element upstream position + shift (moved elements)
      let worst = 'untouched';
      for (const el of cite.elements) {
        const v = classifyElement(hunks, el.lo, el.hi, citeSide);
        if (v.verdict !== 'untouched') {
          details.push(`${el.lo === el.hi ? el.lo : `${el.lo}-${el.hi}`}:${v.verdict === 'changed' ? 'changed' : `moved(${v.shift > 0 ? '+' : ''}${v.shift})`}`);
          if (v.verdict === 'changed') worst = 'changed';
          else if (worst !== 'changed') worst = 'moved';
          if (v.verdict === 'moved') moves.push({ lo: el.lo, hi: el.hi, shift: v.shift });
        }
      }
      if (worst === 'untouched') continue;
      affected++;
      const row = {
        upFile: f.path,
        ourFile: cite.ourFile,
        ourLine: cite.ourLine,
        citeText: cite.citeText,
        details: details.join(', '),
        worst,
        moves,
        hint: censusHint(cite.ourFile) + hintMarkers(cite),
      };
      if (worst === 'changed') bucketB.push(row);
      else bucketA.push(row);
    }
    if (affected > 0) intactByFile.push({ upFile: f.path, affected, intact: hits.length - affected });
    else intactByFile.push({ upFile: f.path, affected: 0, intact: hits.length });
  }

  // Tests likely in scope — name-stem matching over our own tree.
  const ourFiles = input.ourFileList; // [{rel, base, isTest, stem}]
  const testsByStem = new Map();
  for (const f of ourFiles) {
    if (!f.isTest) continue;
    const list = testsByStem.get(f.stem) ?? [];
    list.push(f.rel);
    testsByStem.set(f.stem, list);
  }
  const hitFiles = new Map(); // rel -> {hint}
  for (const row of [...bucketA, ...bucketB]) hitFiles.set(row.ourFile, { hint: row.hint });
  for (const row of bucketC) for (const c of row.cites) hitFiles.set(c.ourFile, { hint: censusHint(c.ourFile) });
  for (const c of ambiguousInWindow) hitFiles.set(c.ourFile, { hint: censusHint(c.ourFile) });
  const testsInScope = [];
  for (const [rel, meta] of hitFiles) {
    const base = path.basename(rel);
    const stem = coreStem(base);
    const tests = (testsByStem.get(stem) ?? []).filter((t) => t !== rel);
    if (isTestFile(base)) tests.unshift(`${rel} (this test file)`);
    testsInScope.push({ ourFile: rel, hint: meta.hint, tests });
  }
  testsInScope.sort((a, b) => a.ourFile.localeCompare(b.ourFile));

  return { bucketA, bucketB, bucketC, uncited, intactByFile, unresolvedTokens, unbound, ambiguous, ambiguousInWindow, hitFiles, testsInScope };
}

// ---------------------------------------------------------------------------
// Report rendering (markdown + minimal HTML)
// ---------------------------------------------------------------------------

function escCell(s) {
  return String(s).replace(/\|/g, '\\|');
}

function mdTable(header, rows) {
  const out = [];
  out.push(`| ${header.join(' | ')} |`);
  out.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const r of rows) out.push(`| ${r.map(escCell).join(' | ')} |`);
  return out;
}

function describeMove(row, citeSide, otherShaShort) {
  const moves = row.moves ?? [];
  if (!moves.length) return row.details;
  const shifts = [...new Set(moves.map((mv) => mv.shift))];
  const lo = Math.min(...moves.map((mv) => mv.lo));
  const hi = Math.max(...moves.map((mv) => mv.hi));
  if (shifts.length === 1) {
    const s = shifts[0];
    const from = lo === hi ? `${lo}` : `${lo}-${hi}`;
    const to = lo === hi ? `${lo + s}` : `${lo + s}-${hi + s}`;
    const side = citeSide === 'from'
      ? `the cited text now sits at upstream line ${to} in ${otherShaShort}`
      : `the cited text is valid at the TO side; in ${otherShaShort} it sits at upstream line ${to}`;
    return `${from}:moved(${s > 0 ? '+' : ''}${s}) — ${side}`;
  }
  return `${row.details} — element-wise positions differ; read the Elements column`;
}

function hintMarkers(cite) {
  const m = [];
  if (cite.narrowed) m.push('line-count-narrowed');
  if (cite.windowNarrowed) m.push('window-narrowed');
  return m.length ? ` (${m.join(', ')})` : '';
}

function renderMarkdown(report) {
  const { window: win, citeSide, citeSideReason, res, stats, otherShaShort } = report;
  const md = [];

  md.push(`# Upstream drift: gitea/ ${shortSha(win.from)}..${shortSha(win.to)}`);
  md.push('');
  md.push(`Generated by \`scripts/upstream-drift.mjs\` on ${new Date().toISOString().slice(0, 10)} — ` +
    'the behavioral census\'s drift mapping, automated. Scope: `templates/**/*.tmpl` + `routers/` + `services/` + `models/` ' +
    '(controller-side surface: templates and their data sources).');
  md.push('');
  md.push(`**Cite side: ${citeSide}** — ${citeSideReason}`);
  md.push('');

  md.push('## Summary');
  md.push('');
  md.push(`- Window: \`${shortSha(win.from)}\` → \`${shortSha(win.to)}\` (${win.fromSubject} → ${win.toSubject})`);
  md.push(`- Upstream files touched: **${stats.upFiles}** (${stats.mMod} modified, ${stats.mAdd} added, ${stats.mDel} deleted, ${stats.mType} type-changed)`);
  md.push(`- Citation index: **${stats.citeSites}** cite sites in **${stats.ourCiteFiles}** of our files ` +
    `(${stats.explicit} explicit, ${stats.shorthand} shorthand, ${stats.unbound} unbound shorthand, ` +
    `${stats.unresolved} unresolved, ${stats.ambiguous} ambiguous)`);
  md.push(`- (a) CITED-LINE MOVED: **${res.bucketA.length}** cite sites across ${new Set(res.bucketA.map((r) => r.ourFile)).size} our files`);
  md.push(`- (b) CITED REGION CHANGED: **${res.bucketB.length}** cite sites across ${new Set(res.bucketB.map((r) => r.ourFile)).size} our files`);
  md.push(`- (c) FILE ADDED/REMOVED: **${res.bucketC.length}** upstream files (${res.bucketC.filter((r) => r.status === 'A').length} added / ${res.bucketC.filter((r) => r.status === 'D').length} removed)`);
  md.push(`- Changed upstream surface with NO citation coverage: **${res.uncited.length}** files`);
  md.push(`- Our files with affected cites: **${res.hitFiles.size}**; tests likely in scope (stem match): **${res.testsInScope.filter((t) => t.tests.length).length}**`);
  md.push(`- Ambiguous cites whose candidates changed (unattributable drift, informational): **${res.ambiguousInWindow.length}**`);
  md.push('');

  const taskA = () => `refresh the cite against ${shortSha(win.to)} (or re-anchor to a stable symbol) and re-check the derivation`;
  const taskB = () => 're-derive the ported behavior — the text the cite anchors changed in this window';
  const taskCA = (r) => `new upstream surface (+${r.plus ?? '?'}) — review for port scope against the board`;
  const taskCD = (r) => `upstream surface removed (-${r.minus ?? '?'}) — ${r.cites.length} dead cite(s): re-derive against the successor surface or retire the port`;

  md.push('## (a) CITED-LINE MOVED');
  md.push('');
  if (res.bucketA.length) {
    md.push('The cite still points at intact text, but the line number shifted in this window. ' +
      'The cite text needs refreshing AND the derivation must be re-checked (shifts can hide renames and reorderings).');
    md.push('');
    md.push(...mdTable(
      ['Upstream file', 'Move', 'Our file:line', 'Cite as written', 'Elements', 'Census hint', 'Suggested task'],
      res.bucketA.map((r) => [
        r.upFile, describeMove(r, citeSide, otherShaShort),
        `${r.ourFile}:${r.ourLine}`, `\`${r.citeText}\``, r.details || r.citeText, r.hint, taskA(r),
      ]),
    ));
  } else {
    md.push('_None._');
  }
  md.push('');

  md.push('## (b) CITED REGION CHANGED');
  md.push('');
  if (res.bucketB.length) {
    md.push('The cited line(s) sit inside a changed hunk — the ported behavior may diverge. Re-derive against the new text.');
    md.push('');
    md.push(...mdTable(
      ['Upstream file', 'Changed hunks', 'Our file:line', 'Cite as written', 'Elements', 'Census hint', 'Suggested task'],
      res.bucketB.map((r) => [
        r.upFile, r.hunkText, `${r.ourFile}:${r.ourLine}`, `\`${r.citeText}\``, r.details || r.citeText, r.hint + (r.narrowed ? ' (narrowed)' : ''), taskB(r),
      ]),
    ));
  } else {
    md.push('_None._');
  }
  md.push('');

  md.push('## (c) FILE ADDED / REMOVED');
  md.push('');
  if (res.bucketC.length) {
    const rows = [];
    for (const r of res.bucketC) {
      const ourList = [...new Set(r.cites.map((c) => `${c.ourFile}:${c.ourLine}`))];
      rows.push([
        r.upFile,
        r.status === 'A' ? 'added' : 'removed',
        r.cites.length ? r.cites.length : '—',
        ourList.length ? ourList.slice(0, 6).join(', ') + (ourList.length > 6 ? ` (+${ourList.length - 6} more)` : '') : '—',
        r.status === 'A' ? taskCA(r) : taskCD(r),
      ]);
    }
    md.push(...mdTable(['Upstream file', 'Status', 'Our cites', 'Our files:lines', 'Suggested task'], rows));
  } else {
    md.push('_None._');
  }
  md.push('');

  md.push('## Ambiguous cites into changed upstream files (informational)');
  md.push('');
  if (res.ambiguousInWindow.length) {
    md.push('These cite sites carry a basename matching SEVERAL upstream files, and more than one ' +
      'candidate changed in this window — the drift hit is real but cannot be attributed to one file automatically. ' +
      'A human resolves the candidate from context.');
    md.push('');
    md.push(...mdTable(
      ['Our file:line', 'Cite as written', 'In-window candidates', 'Census hint'],
      res.ambiguousInWindow.map((c) => [
        `${c.ourFile}:${c.ourLine}`, `\`${c.citeText}\``, c.inWindow.join(', '), censusHint(c.ourFile),
      ]),
    ));
  } else {
    md.push('_None — every ambiguous cite has at most one changed candidate in the window (those were window-narrowed)._');
  }
  md.push('');

  md.push('## Uncited changed surface (informational)');
  md.push('');
  md.push('Upstream files this window touched that NO citation in our tree covers. ' +
    'Either the surface is genuinely unported, or our cites predate it — both worth a board glance when the count is large.');
  md.push('');
  if (res.uncited.length) {
    md.push(...mdTable(
      ['Upstream file', 'Status', '+lines', '-lines'],
      res.uncited.map((r) => [r.upFile, r.status === 'A' ? 'added' : r.status === 'D' ? 'removed' : 'modified', r.plus ?? '—', r.minus ?? '—']),
    ));
  } else {
    md.push('_None — every changed upstream file carries at least one citation._');
  }
  md.push('');

  md.push('## Tests likely in scope (name-stem match)');
  md.push('');
  if (res.testsInScope.length) {
    md.push(...mdTable(
      ['Our file with affected cites', 'Census hint', 'Test files (stem match)'],
      res.testsInScope.map((t) => [t.ourFile, t.hint, t.tests.length ? t.tests.join(', ') : '— (no stem-matched test file)']),
    ));
  } else {
    md.push('_No affected cite sites._');
  }
  md.push('');

  md.push('## Census-board hints');
  md.push('');
  const hintCounts = new Map();
  for (const [, meta] of res.hitFiles) hintCounts.set(meta.hint, (hintCounts.get(meta.hint) ?? 0) + 1);
  if (hintCounts.size) {
    for (const [h, n] of [...hintCounts.entries()].sort((a, b) => b[1] - a[1])) md.push(`- ${h} — ${n} file(s) with affected cites`);
  } else {
    md.push('_No hits._');
  }
  md.push('');

  md.push('## Index health (diagnostics)');
  md.push('');
  md.push(`- Cites intact (untouched verdicts) on modified files with hits: ${res.intactByFile.reduce((a, r) => a + r.intact, 0)} ` +
    `across ${res.intactByFile.length} file(s)`);
  if (res.unbound.length) {
    md.push(`- Unbound shorthand cites (no explicit path anywhere in their comment block): ${res.unbound.length} — e.g. ${res.unbound.slice(0, 5).map((c) => `\`${c.ourFile}:${c.ourLine}\``).join(', ')}`);
  }
  if (res.ambiguous.length) {
    const uniq = new Map();
    for (const c of res.ambiguous) uniq.set(`${c.citeText}|${c.candidates.join(',')}`, c);
    const shown = [...uniq.values()].slice(0, 8).map((c) => `\`${c.citeText}\` (${c.candidates.join(', ')})`).join('; ');
    md.push(`- Ambiguous cites (basename matches several upstream files, none window-narrowable; ${res.ambiguous.length} sites in ${uniq.size} distinct shapes, sample): ${shown}`);
  }
  if (res.unresolvedTokens.size) {
    const shown = [...res.unresolvedTokens.entries()].slice(0, 10).map(([t, n]) => `\`${t}\` x${n}`).join(', ');
    md.push(`- Unresolved path tokens (not in the scope tree — out-of-scope cites or typos): ${[...res.unresolvedTokens.values()].reduce((a, b) => a + b, 0)} sites, ${shown}`);
  }
  md.push('');

  return md.join('\n');
}

// Attach per-file hunk text to rows right before rendering (keeps analyze() pure).
function decorateRows(res, hunksByFile) {
  const hunkTextOf = (file) => {
    const hs = hunksByFile.get(file) ?? [];
    const shown = hs.slice(0, 8).map(formatHunk).join('; ');
    return hs.length > 8 ? `${shown} (+${hs.length - 8} more)` : shown || '(whole-file)';
  };
  for (const r of [...res.bucketA, ...res.bucketB]) {
    r.hunkText = hunkTextOf(r.upFile);
  }
}

function renderHtml(mdText, title) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
  const lines = mdText.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('| ') && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      out.push('<table>');
      const cells = (l) => l.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => inline(esc(c.trim())));
      out.push(`<thead><tr>${cells(line).map((c) => `<th>${c}</th>`).join('')}</tr></thead>`);
      i += 2;
      const body = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        body.push(`<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join('')}</tr>`);
        i++;
      }
      out.push(`<tbody>${body.join('')}</tbody></table>`);
      continue;
    }
    const h = /^(#{1,4}) (.+)$/.exec(line);
    if (h) {
      out.push(`<h${h[1].length}>${inline(esc(h[2]))}</h${h[1].length}>`);
      i++;
      continue;
    }
    if (/^- +/.test(line)) {
      const items = [];
      while (i < lines.length && /^- +/.test(lines[i])) {
        items.push(`<li>${inline(esc(lines[i].replace(/^- +/, '')))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (line.trim() === '---') {
      out.push('<hr>');
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    out.push(`<p>${inline(esc(line))}</p>`);
    i++;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 1400px; padding: 0 1rem; color: #1a1a1a; }
table { border-collapse: collapse; margin: 0.6rem 0 1.2rem; font-size: 0.88rem; }
th, td { border: 1px solid #bbb; padding: 0.3rem 0.5rem; text-align: left; vertical-align: top; }
th { background: #f2f2f2; }
code { background: #f4f4f4; padding: 0.05rem 0.25rem; border-radius: 3px; font-size: 0.85em; }
h1 { border-bottom: 2px solid #333; padding-bottom: 0.3rem; }
h2 { border-bottom: 1px solid #ccc; padding-bottom: 0.2rem; margin-top: 2rem; }
</style>
</head>
<body>
${out.join('\n')}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Selftest — inline fixtures (pure) + a real temp-git fixture (plumbing)
// ---------------------------------------------------------------------------

function selftest() {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, detail) => {
    if (cond) {
      pass++;
      console.log(`  [pass] ${name}`);
    } else {
      fail++;
      console.error(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };

  console.log('upstream-drift selftest');

  // --- 1. hunk-header parser (omitted counts, zero counts) ---
  console.log('[1] hunk parser');
  const hunks = parseHunksFromUnified([
    'diff --git a/x.go b/x.go',
    'index 111..222 100644',
    '--- a/x.go',
    '+++ b/x.go',
    '@@ -2,0 +3,1 @@',
    '+inserted',
    '@@ -6 +7 @@',
    '-old beta',
    '+new beta',
    '@@ -9,3 +9,0 @@',
    '-gamma1',
    '-gamma2',
    '-gamma3',
  ].join('\n'));
  const hx = hunks.get('x.go') ?? [];
  check('three hunks parsed', hx.length === 3, `got ${hx.length}`);
  check('insertion hunk', JSON.stringify(hx[0]) === JSON.stringify({ oldStart: 2, oldCount: 0, newStart: 3, newCount: 1 }), JSON.stringify(hx[0]));
  check('omitted counts default to 1', JSON.stringify(hx[1]) === JSON.stringify({ oldStart: 6, oldCount: 1, newStart: 7, newCount: 1 }), JSON.stringify(hx[1]));
  check('deletion hunk', JSON.stringify(hx[2]) === JSON.stringify({ oldStart: 9, oldCount: 3, newStart: 9, newCount: 0 }), JSON.stringify(hx[2]));

  // --- 2. classification math (hand-derived ground truth) ---
  console.log('[2] classification math');
  const H = hx;
  // FROM-side (forward re-pin; cites valid in the old file):
  check('from:3 moved +1', classifyElement(H, 3, 3, 'from').verdict === 'moved' && classifyElement(H, 3, 3, 'from').shift === 1);
  check('from:6 changed', classifyElement(H, 6, 6, 'from').verdict === 'changed');
  check('from:7 moved +1 too (the top insertion precedes it)', classifyElement(H, 7, 7, 'from').verdict === 'moved' && classifyElement(H, 7, 7, 'from').shift === 1);
  check('from:9 changed (deleted region)', classifyElement(H, 9, 9, 'from').verdict === 'changed');
  check('from:12 moved -2 (lands at new 10)', classifyElement(H, 12, 12, 'from').verdict === 'moved' && classifyElement(H, 12, 12, 'from').shift === -2);
  // TO-side (baseline; cites valid in the new file), mirrored math:
  check('to:4 moved -1 (old position 3)', classifyElement(H, 4, 4, 'to').verdict === 'moved' && classifyElement(H, 4, 4, 'to').shift === -1);
  check('to:7 changed', classifyElement(H, 7, 7, 'to').verdict === 'changed');
  check('to:9 moved -1 (maps to old 8; the zero-count boundary is strict L > start, else the deletion would push it +3)', classifyElement(H, 9, 9, 'to').verdict === 'moved' && classifyElement(H, 9, 9, 'to').shift === -1);
  check('to:10 moved +2 (old position 12)', classifyElement(H, 10, 10, 'to').verdict === 'moved' && classifyElement(H, 10, 10, 'to').shift === 2);
  check('range straddling an insertion boundary counts as changed', classifyElement(H, 2, 5, 'from').verdict === 'changed');

  // --- 3. citation extraction (all conventions) ---
  console.log('[3] citation extraction');
  const fixtureSrc = [
    '// ports upstream routers/web/repo/widget.go:20-30 verbatim',
    '/**',
    ' * header block citing list.tmpl:25/31 and web.go:779.',
    ' * shorthand continuation :789 and (:800-802 tails).',
    ' */',
    'const x = 1; // trailing cite milestone.go:35',
    'const y = 2; // shorthand after the same line-block: :40-44',
    'it("ports container.go:116-130", () => {});',
    'const guard = "12:30 https://x/y a:bc 10:5";',
    '/* single-line block twin editor_uploader.go:51-60 */',
  ].join('\n');
  const cites = extractCitations('src/fixture.ts', fixtureSrc);
  const byText = new Map(cites.map((c) => [`${c.ourLine}:${c.citeText}`, c]));
  check('explicit dir cite', byText.has('1:routers/web/repo/widget.go:20-30'), JSON.stringify([...byText.keys()]));
  check('range elements', JSON.stringify(byText.get('1:routers/web/repo/widget.go:20-30')?.elements) === JSON.stringify([{ lo: 20, hi: 30 }]));
  check('slash multi-line elements', JSON.stringify(byText.get('3:list.tmpl:25/31')?.elements) === JSON.stringify([{ lo: 25, hi: 25 }, { lo: 31, hi: 31 }]));
  check('shorthand bound to nearest explicit in block', byText.get('4::789')?.token === 'web.go');
  check('paren shorthand with range', byText.get('4::800-802')?.token === 'web.go');
  check('trailing comment explicit', byText.has('6:milestone.go:35'));
  check('trailing shorthand binds within its block', byText.get('7::40-44')?.token === 'milestone.go');
  check('non-comment explicit cite (test description)', byText.has('8:container.go:116-130'));
  check('no cites from the guard line', cites.every((c) => c.ourLine !== 9), JSON.stringify(cites.filter((c) => c.ourLine === 9).map((c) => c.citeText)));
  check('single-line block comment cite', byText.has('10:editor_uploader.go:51-60'));
  check('comma+range spec parses', JSON.stringify(parseLineSpec('62,100,282')) === JSON.stringify([{ lo: 62, hi: 62 }, { lo: 100, hi: 100 }, { lo: 282, hi: 282 }]));
  check('mixed slash+range spec parses', JSON.stringify(parseLineSpec('114/118-122')) === JSON.stringify([{ lo: 114, hi: 114 }, { lo: 118, hi: 122 }]));

  // --- 4. resolver (suffix match + plausibility narrowing) ---
  console.log('[4] path resolver');
  const treePaths = [
    'templates/org/header.tmpl',
    'templates/repo/header.tmpl',
    'routers/web/repo/milestone.go',
    'services/packages/packages.go',
    'routers/web/repo/packages.go',
    'routers/api/v1/admin/packages.go',
  ];
  const counts = new Map([
    ['templates/org/header.tmpl', 200],
    ['templates/repo/header.tmpl', 120],
    ['routers/web/repo/milestone.go', 400],
    ['services/packages/packages.go', 600],
    ['routers/web/repo/packages.go', 700],
    ['routers/api/v1/admin/packages.go', 300],
  ]);
  const resolveToken = makeResolver(treePaths, counts);
  check('unique suffix resolves', resolveToken('milestone.go', 35).path === 'routers/web/repo/milestone.go');
  check('full path resolves', resolveToken('templates/repo/header.tmpl', 1).path === 'templates/repo/header.tmpl');
  check('ambiguous narrowed by line count', resolveToken('header.tmpl', 150).path === 'templates/org/header.tmpl');
  check('still ambiguous when several plausible', resolveToken('packages.go', 131).path === null && resolveToken('packages.go', 131).ambiguous === true);
  check('out-of-scope token unresolved', resolveToken('nope.go', 5).unresolved === true);

  // --- 5. REAL temp-git fixture — exercises the actual diff plumbing end to end ---
  console.log('[5] real temp-git fixture');
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'upstream-drift-selftest-'));
  try {
    const oldText = [
      'package web',
      '',
      '// alpha docs',
      'func alpha() {}',
      '',
      '// beta docs',
      'func beta() {}',
      '',
      '// gamma docs',
      'func gamma() {}',
      '',
      '// delta docs',
      'func delta() {}',
      '// end',
    ].join('\n');
    const newText = [
      'package web',
      '',
      '// header inserted upstream',
      '// alpha docs',
      'func alpha() {}',
      '',
      '// beta docs CHANGED',
      'func beta() {}',
      '',
      '// delta docs',
      'func delta() {}',
      '// end',
    ].join('\n');
    const run = (args) => execFileSync('git', ['-c', 'core.quotepath=off', '-c', 'user.email=d@e', '-c', 'user.name=d', ...args], { cwd: tmp, encoding: 'utf8' });
    run(['init', '-q']);
    run(['checkout', '-q', '-b', 'main']);
    writeFileSync(path.join(tmp, 'thing.go'), oldText);
    run(['add', '.']);
    run(['commit', '-q', '-m', 'old']);
    const fromSha = run(['rev-parse', 'HEAD']).trim();
    writeFileSync(path.join(tmp, 'thing.go'), newText);
    run(['add', '.']);
    run(['commit', '-q', '-m', 'new']);
    const toSha = run(['rev-parse', 'HEAD']).trim();

    const diff = collectUpstreamDiff(tmp, fromSha, toSha, ['thing.go']);
    check('name-status sees one modified file', diff.nameStatus.length === 1 && diff.nameStatus[0].status === 'M' && diff.nameStatus[0].path === 'thing.go');
    const fh = diff.hunksByFile.get('thing.go') ?? [];
    check('temp-git hunks match hand-derived headers',
      fh.length === 3 &&
      JSON.stringify(fh[0]) === JSON.stringify({ oldStart: 2, oldCount: 0, newStart: 3, newCount: 1 }) &&
      JSON.stringify(fh[1]) === JSON.stringify({ oldStart: 6, oldCount: 1, newStart: 7, newCount: 1 }) &&
      JSON.stringify(fh[2]) === JSON.stringify({ oldStart: 9, oldCount: 3, newStart: 9, newCount: 0 }),
      JSON.stringify(fh));
    check('numstat counts (+2 header/beta-edit, -4 beta-edit/3 gamma lines)', diff.numstat.get('thing.go')?.plus === 2 && diff.numstat.get('thing.go')?.minus === 4, JSON.stringify([...diff.numstat.entries()]));

    // End-to-end analyze() on the fixture with a mini "our tree".
    const ourFileList = [{ rel: 'src/fixture.ts', base: 'fixture.ts', isTest: false, stem: 'fixture' }];
    const fixtureCites = extractCitations('src/fixture.ts', [
      '// pins thing.go:3 (alpha docs), thing.go:6 (beta), thing.go:7,',
      '// thing.go:9 (gamma) and thing.go:12 (delta docs)',
    ].join('\n'));
    const res = analyze({
      nameStatus: diff.nameStatus,
      hunksByFile: diff.hunksByFile,
      numstat: diff.numstat,
      cites: fixtureCites,
      resolveToken: makeResolver(['thing.go'], new Map([['thing.go', 14]])),
      citeSide: 'from',
      ourFileList,
    });
    check('analyze bucket-a sizes', res.bucketA.length === 3 && res.bucketB.length === 2, `A=${res.bucketA.length} B=${res.bucketB.length}`);
    check('alpha cite moved +1', res.bucketA.some((r) => r.citeText.includes(':3') && r.details.includes('moved(+1)')), JSON.stringify(res.bucketA.map((r) => r.citeText)));
    check('delta cite moved -2', res.bucketA.some((r) => r.citeText.includes(':12') && r.details.includes('moved(-2)')));
    check('beta+gamma cites region-changed', res.bucketB.length === 2 && res.bucketB.every((r) => r.worst === 'changed'));
    check('func-beta cite moved +1 (insertion upstream of it)', res.bucketA.some((r) => r.citeText.includes(':7') && r.details.includes('moved(+1)')));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`selftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function usage() {
  console.error(`usage:
  node scripts/upstream-drift.mjs --from <sha> --to <sha> [--html out.html]
  node scripts/upstream-drift.mjs --current
  node scripts/upstream-drift.mjs --selftest`);
}

function parseArgs(argv) {
  const args = { html: null, selftest: false, current: false, from: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--html') args.html = argv[++i] ?? null;
    else if (a === '--selftest') args.selftest = true;
    else if (a === '--current') args.current = true;
    else if (a === '--from') args.from = argv[++i] ?? null;
    else if (a === '--to') args.to = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else { console.error(`unknown argument: ${a}`); usage(); process.exit(1); }
  }
  return args;
}

function commitSubject(giteaDir, sha) {
  try {
    return git(giteaDir, ['log', '-1', '--format=%s', sha]).trim().slice(0, 72);
  } catch {
    return '(unknown)';
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) {
    process.exit(selftest() ? 0 : 2);
  }

  let fromSha;
  let toSha;
  if (args.current) {
    const lsTree = git(ROOT, ['ls-tree', 'HEAD', 'gitea']).trim();
    const m = /^160000 commit (\S+)\t/.exec(lsTree);
    if (!m) {
      console.error('upstream-drift: could not read the gitea/ gitlink from the parent HEAD (is the submodule initialized?)');
      process.exit(1);
    }
    fromSha = m[1];
    toSha = git(GITEA_DIR, ['rev-parse', 'HEAD']).trim();
    if (fromSha === toSha) {
      console.log(`upstream-drift: the working submodule HEAD (${shortSha(toSha)}) matches the recorded pin — zero drift to analyze.`);
    }
  } else {
    if (!args.from || !args.to) {
      usage();
      process.exit(1);
    }
    // Resolve BOTH refs to full shas up front — a `sha~N`-style --from would
    // otherwise ride the raw string into the report header (rendering as the
    // to-sha and looking like an empty window) and into downstream plumbing.
    fromSha = git(GITEA_DIR, ['rev-parse', '--verify', `${args.from}^{commit}`]).trim();
    toSha = git(GITEA_DIR, ['rev-parse', '--verify', `${args.to}^{commit}`]).trim();
  }
  verifyCommit(GITEA_DIR, fromSha);
  verifyCommit(GITEA_DIR, toSha);

  // Which side are our cites valid on? The census derives them against the
  // pin — the working submodule HEAD.
  const headSha = git(GITEA_DIR, ['rev-parse', 'HEAD']).trim();
  let citeSide;
  let citeSideReason;
  if (toSha === headSha) {
    citeSide = 'to';
    citeSideReason = `TO == the working submodule HEAD (${shortSha(headSha)}) — the pin our citations were derived against.`;
  } else if (fromSha === headSha) {
    citeSide = 'from';
    citeSideReason = `FROM == the working submodule HEAD (${shortSha(headSha)}) — the current pin; drift is analyzed forward.`;
  } else {
    citeSide = 'to';
    citeSideReason = `neither endpoint is the working HEAD (${shortSha(headSha)}); defaulting to the newer endpoint — treat move distances as approximate.`;
  }
  const otherSha = citeSide === 'to' ? fromSha : toSha;

  const diff = collectUpstreamDiff(GITEA_DIR, fromSha, toSha);
  const treePaths = git(GITEA_DIR, ['ls-tree', '-r', '--name-only', citeSide === 'to' ? toSha : fromSha, '--', ...SCOPE_ROOTS])
    .split('\n')
    .filter(Boolean);

  // Citation index over our tree.
  const srcFiles = walkSources(SRC_DIR);
  const ourFileList = [];
  const allCites = [];
  for (const abs of srcFiles) {
    const rel = path.relative(SRC_DIR, abs);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const base = path.basename(rel);
    ourFileList.push({ rel, base, isTest: isTestFile(base), stem: coreStem(base) });
    for (const c of extractCitations(rel, text)) allCites.push(c);
  }

  // Line-count cache for ambiguity narrowing (lazy per candidate file).
  const lineCounts = new Map();
  const resolveToken = makeResolver(treePaths, lineCounts);
  const origResolve = resolveToken;
  const resolverWithCounts = (token, maxLine) => {
    // pre-populate counts for every suffix candidate that matters
    const t = token.replace(/^gitea\//, '');
    for (const p of treePaths) {
      if ((p === t || p.endsWith(`/${t}`)) && !lineCounts.has(p)) {
        try {
          const body = git(GITEA_DIR, ['show', `${citeSide === 'to' ? toSha : fromSha}:${p}`]);
          lineCounts.set(p, body.split('\n').length);
        } catch {
          lineCounts.set(p, Number.MAX_SAFE_INTEGER); // unreadable → never exclude
        }
      }
    }
    return origResolve(token, maxLine);
  };

  const res = analyze({
    nameStatus: diff.nameStatus,
    hunksByFile: diff.hunksByFile,
    numstat: diff.numstat,
    cites: allCites,
    resolveToken: resolverWithCounts,
    citeSide,
    ourFileList,
  });
  decorateRows(res, diff.hunksByFile);

  const stats = {
    upFiles: diff.nameStatus.length,
    mMod: diff.nameStatus.filter((f) => f.status === 'M' || f.status === 'T').length,
    mAdd: diff.nameStatus.filter((f) => f.status === 'A').length,
    mDel: diff.nameStatus.filter((f) => f.status === 'D').length,
    mType: diff.nameStatus.filter((f) => f.status === 'T').length,
    citeSites: allCites.length,
    ourCiteFiles: new Set(allCites.map((c) => c.ourFile)).size,
    explicit: allCites.filter((c) => c.kind === 'explicit').length,
    shorthand: allCites.filter((c) => c.kind === 'shorthand').length,
    unbound: allCites.filter((c) => c.kind === 'unbound').length,
    unresolved: [...res.unresolvedTokens.values()].reduce((a, b) => a + b, 0),
    ambiguous: res.ambiguous.length,
  };

  const report = {
    window: {
      from: fromSha,
      to: toSha,
      fromSubject: commitSubject(GITEA_DIR, fromSha),
      toSubject: commitSubject(GITEA_DIR, toSha),
    },
    citeSide,
    citeSideReason,
    otherShaShort: shortSha(otherSha),
    res,
    stats,
  };
  const md = renderMarkdown(report);

  if (args.html) {
    const html = renderHtml(md, `Upstream drift ${shortSha(fromSha)}..${shortSha(toSha)}`);
    writeFileSync(args.html, html);
    console.log(`upstream-drift: wrote HTML report to ${args.html}`);
    console.log(`window ${shortSha(fromSha)}..${shortSha(toSha)} — (a) moved: ${res.bucketA.length}, (b) changed: ${res.bucketB.length}, (c) add/del: ${res.bucketC.length}, uncited: ${res.uncited.length}`);
  } else {
    console.log(md);
  }
}

main();
