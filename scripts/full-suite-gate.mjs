#!/usr/bin/env node
// full-suite-gate — composite gate for the apps/worker vitest suite at the
// ws1009 scale (see docs/testing/suite-stability.md).
//
// The suite does not complete honestly in one run: every file whose runner
// dies at startup to the workerd WebSocket-1009 "Message is too large" pool
// death never runs, and vitest reports it only as an unhandled error. This
// gate produces the only honest "everything ran and passed" signal available
// today:
//
//   phase 1  run the FULL suite once; attribute every file to exactly one of
//            { ran, died-at-startup, failed-tests }.
//   phase 2  re-run EXACTLY the attributed death set (+ any file whose only
//            failures are Test/Hook timeouts — the known death-churn class)
//            in a second vitest invocation. Small batches pass deterministically.
//   guard    if a re-run itself kills files with ws1009 (death-on-rebatch:
//            fewer files, smaller warm graph), re-batch exactly once more;
//            deaths persisting after that guard round fail the gate with the
//            count — never silently skipped.
//
// Verdict is PASS (exit 0) only when:
//   - phase 1 has zero UNATTRIBUTED failures. An assertion failure (any failed
//     test that is not a pure Test/Hook timeout) fails the gate immediately
//     and is never retried away.
//   - every file is accounted for: ran, or death-attributed. Files absent
//     from both the results and the death attributions fail the gate.
//   - unhandled errors do not exceed the attributed death count.
//   - the final re-run is fully green: zero failed tests, zero unhandled
//     errors, zero runner deaths, zero unaccounted files.
//
// Reporter notes (measured on vitest 5.0.5 + @cloudflare/vitest-plugin, full
// 260-file run 2026-10-27):
//   - runner deaths are attributed ONLY in the default-reporter text:
//     "Caused by: Error: Worker exited unexpectedly during started state
//     while running test file <abs-path>" (1 line, 3x 1009 lines per death).
//   - the JSON reporter emits a STUB testResult (status "passed", zero
//     assertionResults, empty message) for every discovered file that never
//     ran — stubs must not count as "ran".
//   - the JSON reporter is lossy for failed SUITES (e.g. a beforeAll hook
//     timeout): the file is "failed" but its tests are marked "skipped" with
//     no failure messages anywhere. The text log's "FAIL <file> > <suite>"
//     blocks carry the real error line and are the classification source of
//     truth for those.
//   - files that fail at COLLECTION time (import error, e.g. a broken barrel
//     mid-edit) come through as a failed file with a file-level message and
//     no failed assertions; they classify as non-timeout failures — fatal,
//     never retried away. That is the honest treatment: a re-run over a
//     broken import graph is not green.
//
// Usage:
//   node scripts/full-suite-gate.mjs [--baseline-json <path>] [--max-retries <n>]
//
// Flags:
//   --baseline-json <path>  write a JSON evidence record (per-phase counts,
//                           file sets, wall times, tree state) to <path>.
//                           Phase logs + raw vitest JSON land next to it.
//                           Default: artifacts go to a temp dir.
//   --max-retries <n>       re-run rounds after phase 1 (default 1). The
//                           death-on-rebatch guard grants exactly ONE extra
//                           round beyond the budget, once per gate run.
//
// No dependencies beyond node: builtins. Read-only wrt the repo: it never
// modifies vitest.config.ts, tests, or any source; it only runs vitest and
// parses its output.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'apps', 'worker');

// A runner death is attributed by this exact vitest line (state observed is
// always "started"; kept generic in case upstream changes the state name).
const DEATH_LINE_RE =
  /^Caused by: Error: Worker exited unexpectedly(?: during [a-z]+ state)? while running test file (.+?)\s*$/gm;

// The churn-timeout class (testTimeout/hookTimeout are 30s in vitest.config.ts).
const TIMEOUT_MSG_RE = /(?:Test|Hook) timed out in \d+ms/;

// " FAIL  <file> > <suite/test>" (also bare " FAIL  <file>") in the error
// listing sections; the error line follows within a few lines.
const FAIL_LINE_RE = /^ *FAIL +(\S+)(?: .*)? *\r?$/;
// First line of a failure block: "Error: ...", "AssertionError: ...", etc.
const ERROR_LINE_RE = /^[A-Za-z]*Error\b[^a-z]/;

// vitest default include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'] and default
// excludes (node_modules/dist/cypress/dot-dirs/config files). Kept in sync
// with vitest defaults because apps/worker/vitest.config.ts overrides neither.
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIP_DIR_RE =
  /^(node_modules|dist|dist-types|cypress|\.git|\.idea|\.cache|\.output|\.temp|\.wrangler)$/;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { baselineJson: null, maxRetries: 1, solo: false, soloConcurrency: 4, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline-json') {
      opts.baselineJson = argv[++i];
      if (!opts.baselineJson) throw new Error('--baseline-json requires a path');
    } else if (a === '--solo') {
      opts.solo = true;
    } else if (a === '--solo-concurrency') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error('--solo-concurrency requires an integer 1..16');
      opts.soloConcurrency = n;
    } else if (a === '--max-retries') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 0) throw new Error('--max-retries requires a non-negative integer');
      opts.maxRetries = n;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// File discovery (vitest-default include semantics, walk without deps)
// ---------------------------------------------------------------------------

export function enumerateExpectedTests() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_RE.test(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
        out.push(relWorker(full));
      }
    }
  };
  walk(WORKER);
  return out.sort();
}

export function relWorker(absOrRelPath) {
  const p = path.isAbsolute(absOrRelPath) ? absOrRelPath : path.resolve(WORKER, absOrRelPath);
  return path.relative(WORKER, p);
}

// ---------------------------------------------------------------------------
// Vitest invocation
// ---------------------------------------------------------------------------

function resolveVitestEntry() {
  const mjs = path.join(WORKER, 'node_modules', 'vitest', 'vitest.mjs');
  if (fs.existsSync(mjs)) return { file: mjs, kind: 'module' };
  const bin = path.join(WORKER, 'node_modules', '.bin', 'vitest');
  if (fs.existsSync(bin)) return { file: bin, kind: 'bin' };
  throw new Error(`vitest not found under ${WORKER}/node_modules — run pnpm install`);
}

function runVitest({ fileFilters, logPath, jsonPath }) {
  const entry = resolveVitestEntry();
  const vitestArgs = [
    'run',
    '--reporter=default',
    '--reporter=json',
    `--outputFile=${jsonPath}`,
    ...fileFilters,
  ];
  // node <vitest.mjs> ... or exec the shebang'd .bin wrapper directly.
  const command = entry.kind === 'module' ? process.execPath : entry.file;
  const spawnArgs = entry.kind === 'module' ? [entry.file, ...vitestArgs] : vitestArgs;

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, 'w');
  const started = Date.now();
  console.log(`[gate] spawning vitest (${fileFilters.length || 'all'} files) -> ${logPath}`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, spawnArgs, {
      cwd: WORKER,
      stdio: ['ignore', out, out],
      env: process.env,
    });
    child.on('error', (err) => {
      fs.closeSync(out);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      fs.closeSync(out);
      resolve({ code, signal, wallMs: Date.now() - started });
    });
  });
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

export function parseLogText(logText) {
  const deaths = new Set();
  for (const m of logText.matchAll(DEATH_LINE_RE)) deaths.add(relWorker(m[1]));

  let summaryTotal = null;
  const filesLine = logText.match(/^ *Test Files +(.+?) +\((\d+)\) *\r?$/m);
  if (filesLine) summaryTotal = Number(filesLine[2]);

  let unhandledErrors = null;
  const errorsLine = logText.match(/^ *Errors +(\d+) errors? *\r?$/m);
  if (errorsLine) unhandledErrors = Number(errorsLine[1]);
  else {
    const caught = logText.match(/Vitest caught (\d+) unhandled errors/);
    if (caught) unhandledErrors = Number(caught[1]);
  }

  const durationLine = logText.match(/^ *Duration +([\d.]+)s/m);

  return {
    deaths,
    summaryTotal,
    unhandledErrors,
    vitestDurationS: durationLine ? Number(durationLine[1]) : null,
  };
}

// Failure blocks in the text log: "FAIL <file> > <name>" followed (within a
// few lines) by the error's first line ("Error: ...", "AssertionError: ...").
// Returns Map<relFile, string[]>. This is the only source that captures
// failed SUITES (hook timeouts), which the JSON reporter loses entirely.
export function extractFailErrors(logText) {
  const map = new Map();
  const lines = logText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FAIL_LINE_RE);
    if (!m) continue;
    let errLine = null;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (ERROR_LINE_RE.test(t)) errLine = t;
      break;
    }
    if (!errLine) continue;
    const file = relWorker(m[1]);
    if (!map.has(file)) map.set(file, []);
    map.get(file).push(errLine);
  }
  return map;
}

export function parseJsonReport(jsonPath) {
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, 'utf8');
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { parseError: String(err) };
  }
  const ranFiles = new Set();
  const stubFiles = new Set();
  const failedFiles = new Map(); // file -> { msgs: string[], failedTests: number }
  for (const tr of json.testResults || []) {
    const file = relWorker(tr.name);
    const msgs = [];
    let failedTests = 0;
    for (const ar of tr.assertionResults || []) {
      if (ar.status === 'failed') {
        failedTests += 1;
        msgs.push(...(ar.failureMessages || []).map(String));
      }
    }
    if (tr.message) msgs.push(String(tr.message));
    // The JSON reporter stubs every discovered-but-never-ran file as
    // "passed" with zero assertionResults and no message.
    if ((tr.assertionResults || []).length === 0 && msgs.length === 0) {
      stubFiles.add(file);
      continue;
    }
    ranFiles.add(file);
    if (tr.status === 'failed' && msgs.length > 0) failedFiles.set(file, { msgs, failedTests });
  }
  return {
    parseError: null,
    ranFiles,
    stubFiles,
    failedFiles,
    counts: {
      numPassedTests: json.numPassedTests ?? null,
      numFailedTests: json.numFailedTests ?? null,
      numPendingTests: json.numPendingTests ?? null,
      numTodoTests: json.numTodoTests ?? null,
      success: Boolean(json.success),
    },
  };
}

// A failed file is class 'timeout' only when EVERY failure message it carries
// (JSON assertion messages + text-log FAIL-block error lines) is a Test/Hook
// timeout (the known death-churn class). Anything else — a real assertion, an
// unknown error shape, a failed file with no messages at all — is class
// 'assertion' and fails the gate without retry.
export function classifyFailedFile({ jsonMsgs = [], logErrs = [], failedTests = null }) {
  const msgs = [...jsonMsgs, ...logErrs];
  if (msgs.length === 0) {
    return {
      cls: 'assertion',
      failedTests,
      samples: ['(file reported failed with no failure messages — unknown failure class)'],
    };
  }
  const allTimeout = msgs.every((m) => TIMEOUT_MSG_RE.test(m));
  // Lead the samples with non-timeout messages: they are why a mixed file is
  // fatal, and the interesting part of the evidence.
  const ordered = [...msgs.filter((m) => !TIMEOUT_MSG_RE.test(m)), ...msgs.filter((m) => TIMEOUT_MSG_RE.test(m))];
  return {
    cls: allTimeout ? 'timeout' : 'assertion',
    failedTests,
    samples: ordered.slice(0, 3).map((m) => m.split('\n')[0].slice(0, 160)),
  };
}

// ---------------------------------------------------------------------------
// Phase classification
// ---------------------------------------------------------------------------

export function classifyPhase({ label, logText, jsonReport, expectedFiles }) {
  const parsedLog = parseLogText(logText);

  const phase = {
    label,
    deaths: new Set(),
    rawDeathLines: parsedLog.deaths.size,
    deathOverResults: new Set(),
    ranFiles: new Set(),
    passedFiles: new Set(),
    timeoutFiles: new Set(),
    assertionFiles: new Map(),
    stubFiles: new Set(),
    missingFiles: new Set(),
    extraMatchedFiles: new Set(),
    unhandledErrors: parsedLog.unhandledErrors,
    summaryTotal: parsedLog.summaryTotal,
    vitestDurationS: parsedLog.vitestDurationS,
    jsonCounts: null,
    jsonParseError: null,
  };

  // Death attribution comes from the text log. A death line means the file's
  // runner died at startup — even if the JSON reporter carries an entry for
  // it, the death wins (the file is re-run; the re-run decides).
  const deaths = parsedLog.deaths;

  if (!jsonReport || jsonReport.parseError) {
    phase.jsonParseError = jsonReport?.parseError ?? 'JSON report missing or empty';
  } else {
    phase.jsonCounts = jsonReport.counts;
    phase.ranFiles = jsonReport.ranFiles;
    phase.stubFiles = jsonReport.stubFiles;
    const failureInfo = new Map(jsonReport.failedFiles);
    // Merge text-log FAIL-block errors (the only source for failed suites).
    for (const [file, errs] of extractFailErrors(logText)) {
      if (deaths.has(file)) continue;
      const prev = failureInfo.get(file) ?? { msgs: [], failedTests: 0 };
      failureInfo.set(file, { msgs: [...prev.msgs, ...errs], failedTests: prev.failedTests });
    }
    // A file with FAIL blocks but a passing JSON status is still a failure.
    for (const f of failureInfo.keys()) phase.ranFiles.add(f);

    for (const [file, info] of failureInfo) {
      if (deaths.has(file)) continue;
      const cls = classifyFailedFile({ jsonMsgs: info.msgs, failedTests: info.failedTests });
      if (cls.cls === 'timeout') phase.timeoutFiles.add(file);
      else phase.assertionFiles.set(file, cls);
    }
  }

  for (const f of deaths) {
    if (phase.ranFiles.has(f)) phase.deathOverResults.add(f);
    phase.ranFiles.delete(f);
    phase.timeoutFiles.delete(f);
    phase.assertionFiles.delete(f);
    phase.deaths.add(f);
  }

  for (const f of phase.ranFiles) {
    if (!phase.timeoutFiles.has(f) && !phase.assertionFiles.has(f)) phase.passedFiles.add(f);
  }

  // Unaccounted files: neither ran nor death-attributed. In phase 1 the
  // expected set is the repo glob; in re-runs it is the filter set.
  for (const f of expectedFiles) {
    if (!phase.ranFiles.has(f) && !phase.deaths.has(f)) phase.missingFiles.add(f);
  }
  for (const f of phase.ranFiles) {
    if (!expectedFiles.has(f)) phase.extraMatchedFiles.add(f);
  }

  return phase;
}

export function phaseRow(phase) {
  return {
    ran: phase.ranFiles.size,
    passed: phase.passedFiles.size,
    timeoutFiles: phase.timeoutFiles.size,
    assertionFiles: phase.assertionFiles.size,
    deaths: phase.deaths.size,
    missing: phase.missingFiles.size,
    unhandledErrors: phase.unhandledErrors,
    failedTests: phase.jsonCounts?.numFailedTests ?? null,
  };
}

// Fatal problems are gate-failing and never retried; notes are informational.
export function phaseProblems(phase) {
  const fatal = [];
  const notes = [];
  const label = phase.label;
  if (phase.jsonParseError) {
    fatal.push(`${label}: vitest JSON report unusable (${phase.jsonParseError})`);
  }
  if (phase.missingFiles.size > 0) {
    const names = [...phase.missingFiles];
    fatal.push(
      `${label}: ${names.length} file(s) neither ran nor have a runner-death attribution: ` +
        names.slice(0, 10).join(', ') +
        (names.length > 10 ? `, +${names.length - 10} more` : '')
    );
  }
  if (phase.summaryTotal != null) {
    const accounted = phase.ranFiles.size + phase.deaths.size;
    if (accounted < phase.summaryTotal) {
      fatal.push(
        `${label}: summary accounts for ${phase.summaryTotal} files but only ${accounted} are attributed ` +
          `(ran ${phase.ranFiles.size} + deaths ${phase.deaths.size}) — ${phase.summaryTotal - accounted} unaccounted`
      );
    }
  }
  if (phase.unhandledErrors != null && phase.unhandledErrors > phase.deaths.size) {
    fatal.push(
      `${label}: ${phase.unhandledErrors} unhandled errors exceed ${phase.deaths.size} attributed runner ` +
        'deaths — unattributed unhandled error(s) present'
    );
  }
  if (phase.assertionFiles.size > 0) {
    const names = [...phase.assertionFiles.keys()];
    fatal.push(
      `${label}: ${names.length} file(s) with non-timeout failures (assertion or collection error; never ` +
        `retried away): ` +
        names.slice(0, 10).join(', ') +
        (names.length > 10 ? `, +${names.length - 10} more` : '')
    );
  }
  if (phase.unhandledErrors != null && phase.unhandledErrors < phase.deaths.size) {
    notes.push(
      `${label}: NOTE ${phase.unhandledErrors} unhandled errors < ${phase.deaths.size} attributed deaths ` +
        '(unexpected shape; review the log)'
    );
  }
  if (phase.extraMatchedFiles.size > 0) {
    notes.push(
      `${label}: NOTE filter matched ${phase.extraMatchedFiles.size} extra file(s) beyond the pending set ` +
        '(over-broad name match; they also had to pass)'
    );
  }
  return { fatal, notes };
}

// ---------------------------------------------------------------------------
// Retry rounds (phase 2 ..) with the death-on-rebatch guard.
// Exported for unit tests: runOne(label, files) must execute one vitest round
// and return a classified phase; pending is the phase-1 death ∪ timeout set.
// ---------------------------------------------------------------------------

export async function driveRounds({ pending, maxRetries, runOne, startRound = 2 }) {
  const reasons = [];
  const phases = [];
  let budgetUsed = 0;
  let guardUsed = false;
  let round = startRound;
  pending = new Set(pending);

  while (pending.size > 0) {
    const isGuardRound = guardUsed || budgetUsed >= maxRetries;
    if (isGuardRound) guardUsed = true;
    const label = isGuardRound ? `phase${round}-guard-rebatch` : `phase${round}-rerun`;
    const files = [...pending].sort();
    console.log(
      `[gate] re-running ${files.length} file(s) (${isGuardRound ? 'death-on-rebatch guard round' : 're-run'})`
    );
    const phase = await runOne(label, files);
    phases.push(phase);
    round += 1;

    const { fatal, notes } = phaseProblems(phase);
    for (const n of notes) reasons.push(n);
    if (fatal.length > 0) {
      // Assertion failures, unaccounted files, and unattributed errors are
      // immediate fails — never retried away.
      return { verdict: 'FAIL', reasons: [...reasons, ...fatal], phases };
    }

    if (phase.deaths.size > 0) {
      // Death-on-rebatch: this re-batch itself killed files with ws1009.
      if (isGuardRound) {
        return {
          verdict: 'FAIL',
          reasons: [
            ...reasons,
            `${label}: deaths persist after the death-on-rebatch guard: ${phase.deaths.size} file(s) still kill ` +
              'their runner — failing honestly instead of skipping them',
          ],
          phases,
        };
      }
      budgetUsed += 1;
      pending = new Set([...phase.deaths, ...phase.timeoutFiles]);
      continue;
    }

    if (phase.timeoutFiles.size > 0) {
      return {
        verdict: 'FAIL',
        reasons: [
          ...reasons,
          `${label}: re-run not fully green — ${phase.timeoutFiles.size} file(s) still time out without ` +
            `runner deaths: ${[...phase.timeoutFiles].slice(0, 10).join(', ')}` +
            (phase.timeoutFiles.size > 10 ? `, +${phase.timeoutFiles.size - 10} more` : ''),
        ],
        phases,
      };
    }

    console.log(`[gate] ${label}: fully green (${phase.ranFiles.size} files, 0 deaths, 0 unhandled)`);
    return { verdict: 'PASS', reasons, phases };
  }

  return { verdict: 'PASS', reasons, phases };
}

// ---------------------------------------------------------------------------
// Git tree state (read-only evidence)
// ---------------------------------------------------------------------------

function gitState() {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const dirty = status.status === 0 ? status.stdout.split('\n').filter(Boolean) : [];
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    dirtyFileCount: dirty.length,
    dirtyFiles: dirty,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printSummaryTable({ phases, verdict, reasons, totalWallMs }) {
  console.log('\n== full-suite gate ==');
  for (const p of phases) {
    const r = phaseRow(p);
    const wall = ((p.wallMs ?? 0) / 1000).toFixed(1);
    console.log(
      `${p.label.padEnd(26)} ran ${String(r.ran).padStart(4)}  pass ${String(r.passed).padStart(4)}  ` +
        `timeout-files ${String(r.timeoutFiles).padStart(3)}  assert-files ${String(r.assertionFiles).padStart(3)}  ` +
        `deaths ${String(r.deaths).padStart(4)}  missing ${String(r.missing).padStart(3)}  ` +
        `unhandled ${String(r.unhandledErrors ?? '?').padStart(4)}  wall ${wall}s`
    );
  }
  console.log(`total wall ${(totalWallMs / 1000).toFixed(1)}s`);
  console.log(`verdict: ${verdict}`);
  for (const reason of reasons) console.log(`  - ${reason}`);
}

function phaseEvidence(phase) {
  return {
    label: phase.label,
    wallMs: phase.wallMs,
    exitCode: phase.exitCode,
    vitestDurationS: phase.vitestDurationS,
    logPath: phase.logPath,
    jsonPath: phase.jsonPath,
    summaryTotal: phase.summaryTotal,
    rawDeathLines: phase.rawDeathLines,
    deathOverResults: [...phase.deathOverResults],
    counts: phaseRow(phase),
    jsonCounts: phase.jsonCounts,
    jsonParseError: phase.jsonParseError || undefined,
    deathFiles: [...phase.deaths].sort(),
    ranFiles: [...phase.ranFiles].sort(),
    stubFiles: [...phase.stubFiles].sort(),
    timeoutFiles: [...phase.timeoutFiles].sort(),
    assertionFiles: Object.fromEntries(
      [...phase.assertionFiles.entries()].map(([f, info]) => [
        f,
        { failedTests: info.failedTests, samples: info.samples },
      ])
    ),
    missingFiles: [...phase.missingFiles].sort(),
    extraMatchedFiles: [...phase.extraMatchedFiles].sort(),
  };
}

// ---------------------------------------------------------------------------
// Solo adjudication (--solo): every pending file gets its OWN vitest process.
// Rationale (measured, see docs/testing/suite-stability.md + the falsified
// Plan A in docs/research/ws1009-graph-sizing.md): a fresh process
// first-connects an EMPTY warm snapshot, so solo runs are structurally immune
// to ws1009; batch re-runs are not (each batch re-ships the same ~cap-sized
// common core and kills again — death-on-rebatch does not converge).
// A solo death is unexpected: retry once, then fail honestly.
// ---------------------------------------------------------------------------

export async function soloAdjudication({ pending, runOne, concurrency = 4, startRound = 2, onResult = () => {} }) {
  const files = [...pending].sort();
  const outcomes = new Map(); // file -> { status: 'pass' | 'fail', reason? , rounds }
  const phases = [];
  let idx = 0;
  let verdict = 'PASS';
  const reasons = [];

  const workers = Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= files.length) break;
      const file = files[i];
      let outcome;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const label = `phase${startRound}-solo/${String(i).padStart(3, '0')}${attempt > 1 ? '-retry' : ''}`;
        const phase = await runOne(label, [file]);
        phases.push(phase);
        if (phase.deaths.size > 0 && attempt === 1) {
          outcome = { status: 'retry', phase };
          continue; // one retry for an unexpected solo death
        }
        const { fatal } = phaseProblems(phase);
        if (phase.deaths.size === 0 && phase.timeoutFiles.size === 0 && fatal.length === 0) {
          outcome = { status: 'pass', phase };
        } else {
          const detail =
            phase.deaths.size > 0 ? `died solo (${phase.deaths.size} death(s))`
            : phase.timeoutFiles.size > 0 ? 'timed out solo'
            : `failed solo: ${fatal.join('; ').slice(0, 200)}`;
          outcome = { status: 'fail', reason: detail, phase };
        }
        break;
      }
      const status = outcome.status === 'retry' ? 'fail' : outcome.status;
      const reason = outcome.status === 'retry' ? 'died solo twice' : outcome.reason;
      outcomes.set(file, { status, reason, rounds: outcome.phase ? 1 : 0 });
      onResult(file, status);
      if (status === 'fail') verdict = 'FAIL';
    }
  });
  await Promise.all(workers);

  const failed = [...outcomes.entries()].filter(([, o]) => o.status === 'fail');
  if (failed.length > 0) {
    reasons.push(
      `solo adjudication: ${failed.length}/${files.length} file(s) failed their OWN process run: ` +
        failed.slice(0, 10).map(([f, o]) => `${f} (${o.reason})`).join('; ') +
        (failed.length > 10 ? ` … +${failed.length - 10} more` : '')
    );
  }
  return { verdict, reasons, phases, outcomes };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      'Usage: node scripts/full-suite-gate.mjs [--baseline-json <path>] [--max-retries <n>]\n' +
      '       [--solo [--solo-concurrency <n>]]  --solo: phase 2 adjudicates every death/timeout file as its OWN\n' +
      '       vitest process (a fresh process first-connects an EMPTY warm snapshot — the only structural cure for\n' +
      '       death-on-rebatch, which batch re-runs cannot escape: each batch re-ships the same common core).\n' +
      '       A solo death is retried once, then fails honestly; solo assertion/timeout failures fail immediately.\n' +
        'See the header comment in scripts/full-suite-gate.mjs and docs/testing/suite-stability.md.'
    );
    return 0;
  }

  const gateStarted = Date.now();
  const artifactDir = opts.baselineJson
    ? path.resolve(path.dirname(opts.baselineJson))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'full-suite-gate-'));
  fs.mkdirSync(artifactDir, { recursive: true });

  const expected = enumerateExpectedTests();
  const tree = gitState();
  console.log(
    `[gate] tree: HEAD ${tree.head ?? '(unknown)'}, ${tree.dirtyFileCount} dirty file(s); ` +
      `expected test files: ${expected.length}; artifacts: ${artifactDir}`
  );
  if (tree.dirtyFileCount > 0) {
    console.log('[gate] NOTE dirty tree — the verdict is for this working tree, not a clean HEAD.');
  }

  const reasons = [];
  const phases = [];
  let soloOutcomes = null;

  const runOne = async (label, fileFilters) => {
    const logPath = path.join(artifactDir, `${label}.log`);
    const jsonPath = path.join(artifactDir, `${label}.json`);
    const proc = await runVitest({ fileFilters, logPath, jsonPath });
    const logText = fs.readFileSync(logPath, 'utf8');
    const jsonReport = parseJsonReport(jsonPath);
    const expectedSet = new Set(fileFilters.map((f) => relWorker(f)));
    if (expectedSet.size === 0) for (const f of expected) expectedSet.add(f);
    const phase = classifyPhase({ label, logText, jsonReport, expectedFiles: expectedSet });
    phase.wallMs = proc.wallMs;
    phase.exitCode = proc.code;
    phase.logPath = logPath;
    phase.jsonPath = jsonPath;
    const r = phaseRow(phase);
    console.log(
      `[gate] ${label}: exit ${proc.code}, wall ${(proc.wallMs / 1000).toFixed(1)}s — ` +
        `ran ${r.ran}, pass ${r.passed}, timeout-files ${r.timeoutFiles}, assert-files ${r.assertionFiles}, ` +
        `deaths ${r.deaths}, missing ${r.missing}, unhandled ${r.unhandledErrors ?? '?'}`
    );
    return phase;
  };

  // ---- phase 1: the full suite ----
  const phase1 = await runOne('phase1-full-suite', []);
  phases.push(phase1);
  let verdict;

  const { fatal: fatal1, notes: notes1 } = phaseProblems(phase1);
  for (const n of notes1) reasons.push(n);
  // --solo refinement: phase-1 ASSERTION files enter solo adjudication instead of
  // short-circuiting — measured population behavior (wave8 -> mirror/sync ->
  // lifecycle, one different load-flaky file per run): a solo-red assertion
  // reproduces and FAILS (real regressions still die here); a solo-green one is
  // recorded load-attributed, never silently dropped. Accounting fatals
  // (missing/unaccounted/unhandled) still fail immediately in every mode.
  const blocking1 = opts.solo
    ? fatal1.filter((r) => !r.includes('non-timeout failures'))
    : fatal1;
  if (blocking1.length > 0) {
    verdict = 'FAIL';
    reasons.push(...blocking1);
  } else {
    const pending = new Set([...phase1.deaths, ...phase1.timeoutFiles]);
    if (opts.solo && phase1.assertionFiles.size > 0) {
      for (const f of phase1.assertionFiles.keys()) pending.add(f);
      reasons.push(
        `phase1: ${phase1.assertionFiles.size} assertion file(s) enter solo adjudication (--solo) — ` +
          'solo red fails (real regression); solo green is recorded load-attributed'
      );
    }
    if (pending.size === 0) {
      verdict = 'PASS';
    } else if (opts.maxRetries === 0) {
      verdict = 'FAIL';
      reasons.push(
        `phase1 left ${pending.size} file(s) unrun/timeout-flapped but --max-retries is 0 — no re-run budget`
      );
    } else if (opts.solo) {
      console.log(
        `[gate] solo adjudication: ${pending.size} file(s), ${opts.soloConcurrency} concurrent process(es) — ` +
          'each file runs in its OWN vitest process (empty first-connect snapshot)'
      );
      let done = 0;
      const solo = await soloAdjudication({
        pending,
        runOne,
        concurrency: opts.soloConcurrency,
        onResult: (file, status) => {
          done += 1;
          if (status === 'fail' || done % 10 === 0 || done === pending.size) {
            console.log(`[gate] solo ${done}/${pending.size}: ${status === 'pass' ? 'ok' : 'FAIL'} ${path.relative(WORKER, file)}`);
          }
        },
      });
      verdict = solo.verdict;
      reasons.push(...solo.reasons);
      phases.push(...solo.phases);
      soloOutcomes = solo.outcomes;
    } else {
      const rounds = await driveRounds({ pending, maxRetries: opts.maxRetries, runOne });
      verdict = rounds.verdict;
      reasons.push(...rounds.reasons);
      phases.push(...rounds.phases);
    }
  }

  if (verdict === 'PASS') {
    const ranTotal = phases.reduce((n, p) => n + p.ranFiles.size, 0);
    console.log(`[gate] every file ran green across ${phases.length} phase(s) (${ranTotal} file-runs total)`);
  }

  const totalWallMs = Date.now() - gateStarted;
  printSummaryTable({ phases, verdict, reasons, totalWallMs });

  if (opts.baselineJson) {
    const evidence = {
      generatedAt: new Date().toISOString(),
      tool: 'scripts/full-suite-gate.mjs',
      flags: { maxRetries: opts.maxRetries, solo: opts.solo, soloConcurrency: opts.soloConcurrency },
      tree,
      expectedTestFiles: expected.length,
      verdict,
      reasons,
      totalWallMs,
      soloOutcomes: soloOutcomes
        ? Object.fromEntries([...soloOutcomes.entries()].map(([f, o]) => [relWorker(f), o.status]))
        : null,
      phases: phases.map(phaseEvidence),
    };
    fs.mkdirSync(path.dirname(path.resolve(opts.baselineJson)), { recursive: true });
    fs.writeFileSync(opts.baselineJson, JSON.stringify(evidence, null, 2) + '\n');
    console.log(`evidence written: ${path.resolve(opts.baselineJson)}`);
  } else {
    console.log(`artifacts (logs + raw vitest JSON): ${artifactDir}`);
  }

  return verdict === 'PASS' ? 0 : 1;
}

// Allow parser unit tests to import this module without executing the gate.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const code = await main();
  process.exit(code);
}
