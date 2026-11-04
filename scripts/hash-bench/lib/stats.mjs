/* global console, process -- Web globals provided by Node >= 22 */
/**
 * stats.mjs — shared sample statistics + markdown table emit for the
 * hash-bench harness (PWD-3 Phase B, docs/research/hash-bench-phase-b.md).
 *
 * Zero npm deps (repo rule for scripts/*: every landed harness in this repo
 * — bench-run.mjs, deploy-probes.mjs — is stdlib-only Node >= 22).
 */

/** Ascending numeric sort helper. */
export const asc = (a, b) => a - b;

/** Nearest-rank percentile of a pre-sorted array (same convention as
 *  scripts/bench-run.mjs percentile()). */
export function percentile(sorted, p) {
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[idx];
}

/** Summary of a raw wall-ms sample array: {n, min, median, p95, max, mean}. */
export function summarize(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { n: 0, min: null, median: null, p95: null, max: null, mean: null };
  }
  const sorted = [...samples].sort(asc);
  const n = sorted.length;
  const mean = sorted.reduce((acc, v) => acc + v, 0) / n;
  return {
    n,
    min: round2(sorted[0]),
    median: round2(percentile(sorted, 0.5)),
    p95: round2(percentile(sorted, 0.95)),
    max: round2(sorted[n - 1]),
    mean: round2(mean),
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

/** Markdown table from rows of [col, col, ...] with a header. */
export function markdownTable(header, rows) {
  const head = `| ${header.join(" | ")} |`;
  const rule = `| ${header.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return [head, rule, body].join("\n");
}

/** Print one result line in the deploy-probes convention:
 * `  [pass] <id> (<ms> ms) — <detail>` (with ms omitted when not applicable). */
export function printLine(id, ms, detail) {
  const msPart = ms === undefined || ms === null ? "" : ` (${ms} ms)`;
  console.log(`  [pass] ${id}${msPart} — ${detail}`);
}

/** Shared CLI flag parser for the bench-* CLIs:
 *   [--samples N] [--no-cpu-probe] [--no-node]
 * Used by each CLI's main-guard so `node scripts/hash-bench/<x>.mjs` flags
 * actually apply (bench-all.mjs passes the same opts programmatically). */
export function parseBenchArgs(argv) {
  const opts = { samples: undefined, cpuProbe: true, node: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) {
        console.error(`missing value for ${a}`);
        process.exit(2);
      }
      return argv[++i];
    };
    if (a === "--samples") opts.samples = Number(next());
    else if (a === "--no-cpu-probe") opts.cpuProbe = false;
    else if (a === "--no-node") opts.node = false;
    else {
      console.error(`unknown argument: ${a} (supported: --samples N, --no-cpu-probe, --no-node)`);
      process.exit(2);
    }
  }
  if (opts.samples !== undefined && (!Number.isInteger(opts.samples) || opts.samples < 1)) {
    console.error("--samples must be a positive integer");
    process.exit(2);
  }
  return opts;
}
