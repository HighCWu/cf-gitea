#!/usr/bin/env node
/* global console, process, performance -- Web globals provided by Node >= 22 */
/**
 * bench-pbkdf2.mjs — PBKDF2-HMAC-SHA256 CPU cost per verify in workerd.
 *
 *   node scripts/hash-bench/bench-pbkdf2.mjs [--samples N] [--no-cpu-probe] [--no-node]
 *
 * Measures the upstream arms the product must support:
 *   - legacy bare "pbkdf2"  = iter 10000 / keyLen 50
 *     (gitea/modules/auth/password/hash/pbkdf2.go:44-47 at pin fc49368845)
 *   - configured default    = "pbkdf2$50000$50" (v2)
 *     (gitea/modules/auth/password/hash/setting.go:26,30)
 *   - pbkdf2_hi             = "pbkdf2$320000$50" (setting.go:33)
 * The measured call is EXACTLY the landed Phase A path
 * (apps/worker/src/auth/password.ts pbkdf2Sha256Hex: importKey + deriveBits
 * per verify, WebCrypto SHA-256) inside the pinned workerd
 * (miniflare 5.20261023.0-beta -> workerd 1.20261023.1, flags-free isolate =
 * the product's current wrangler.jsonc posture).
 *
 * Output: stdout markdown table (+ structured results when imported by
 * bench-all.mjs). No files written by this CLI alone.
 *
 * Zero npm deps. Node >= 22.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchWorker, COMPAT_DATE } from "./lib/run-worker.mjs";
import { summarize, markdownTable, printLine, parseBenchArgs } from "./lib/stats.mjs";

const thisFile = fileURLToPath(import.meta.url);

/** The deterministic bench inputs — MUST match lib/worker-bench.mjs so
 *  Node-side context numbers hash the same (password, salt) pair. */
const PASSWORD = "correct-horse-battery-staple";
const SALT_16 = new Uint8Array(16).map((_, i) => (i * 37 + 11) & 0xff);

/** @returns {Promise<object>} structured results (markdown string included). */
export async function run(opts = {}) {
  const samples = opts.samples ?? 25;
  const doCpuProbe = opts.cpuProbe !== false;
  const doNode = opts.node !== false;
  const rows = [];
  const ladder = [];
  const probes = [];
  const caps = [];
  let engineNote;

  const w = await createBenchWorker({ nodejsCompat: false });
  try {
    const info = await w.info();
    engineNote = `miniflare ${w.miniflareVersion} (compat ${COMPAT_DATE}, flags-free isolate = the product posture; node:crypto ${info.nodeCrypto?.error ? "ABSENT" : "present"})`;

    // --- iteration-cap probe (Cloudflare documents PBKDF2 iterations
    // capped at 100000 on the production WebCrypto implementation; local
    // workerd behavior measured here, production parity flagged) ---
    for (const iterations of [100000, 100001, 200000, 320000]) {
      const r = await w.dispatch("pbkdf2-cap", { iterations }, { retries: 0 });
      const accepted = r.ok ? r.meta.accepted === true : false;
      const error = r.ok ? (r.meta.error ?? null) : r.error;
      caps.push({ iterations, accepted, error, wallMs: r.samples?.[0] != null ? Math.round(r.samples[0] * 100) / 100 : null });
      printLine(`pbkdf2-cap iter=${iterations}`, r.samples?.[0] ?? null, accepted ? "accepted" : `REJECTED: ${error}`);
    }

    // --- the ladder ---
    const ladderDefs = [
      { label: "legacy bare (pbkdf2$10000$50)", iter: 10000, count: samples },
      { label: "v2 default (pbkdf2$50000$50)", iter: 50000, count: samples },
      { label: "cap-edge (pbkdf2$100000$50)", iter: 100000, count: Math.max(8, Math.round(samples / 2.5)) },
      { label: "hi (pbkdf2$320000$50)", iter: 320000, count: Math.max(8, Math.round(samples / 2.5)) },
    ];
    for (const { label, iter, count } of ladderDefs) {
      const warmup = iter >= 320000 ? 1 : 3;
      const r = await w.dispatch("pbkdf2", { iter, keyLen: 50, count, warmup }, {
        timeoutMs: 120000 + Math.round((count * iter) / 50),
      });
      if (!r.ok) {
        rows.push([label, "iter=" + iter, "ERROR", "ERROR", "-", `error: ${r.error}`]);
        ladder.push({ label, iter, keyLen: 50, error: r.error });
        continue;
      }
      const s = summarize(r.samples);
      ladder.push({ label, iter, keyLen: 50, ...s, digestPrefix: r.meta.digestPrefix });
      rows.push([label, "iter=" + iter, s.median, s.p95, s.n, `${s.min}–${s.max}`]);
      printLine(`pbkdf2 ${label}`, s.median, `median ${s.median} ms, p95 ${s.p95} ms (n=${s.n})`);
    }

    // --- CPU-accounting cross-check against workerd's own cpu_ms limit ---
    if (doCpuProbe) {
      const baseline = await cpuEstimate(w, "pbkdf2", { iter: 1, keyLen: 50, count: 1, warmup: 0 });
      probes.push({ what: "baseline iter=1 (request+startup CPU floor)", ...baseline });
      for (const iter of [50000, 320000]) {
        const r = await cpuEstimate(w, "pbkdf2", { iter, keyLen: 50, count: 1, warmup: 0 });
        probes.push({ what: `iter=${iter}`, ...r });
        const delta = baseline.estimate !== null && r.estimate !== null ? r.estimate - baseline.estimate : null;
        printLine(`cpu-probe iter=${iter}`, null, r.enforced
          ? `smallest passing cpuMs limit ${r.estimate} (baseline ${baseline.estimate}) -> op CPU ≈ ${delta !== null ? delta + " ms" : "n/a"}`
          : `cpu limits appear NOT enforced locally (${r.error ?? "no boundary found"})`);
      }
    }
  } finally {
    await w.close();
  }

  // --- Node-side context (NOT platform numbers; different engine) ---
  const nodeRows = [];
  if (doNode) {
    const { pbkdf2Sync } = await import("node:crypto");
    for (const iter of [10000, 50000, 320000]) {
      const count = iter >= 320000 ? 8 : samples;
      const t = [];
      for (let i = 0; i < count; i++) {
        const t0 = performance.now();
        pbkdf2Sync(PASSWORD, SALT_16, iter, 50, "sha256");
        t.push(performance.now() - t0);
      }
      const s = summarize(t);
      nodeRows.push({ arm: `node:crypto pbkdf2Sync iter=${iter}`, ...s });
      printLine(`node context iter=${iter}`, s.median, `median ${s.median} ms (context only, Node ${process.version})`);
    }
  }

  const md = [
    `workerd isolate: ${engineNote}`,
    "",
    markdownTable(
      ["arm (spec)", "params", "median ms", "p95 ms", "n", "min–max ms"],
      rows,
    ),
  ];
  if (nodeRows.length > 0) {
    md.push("", `Node ${process.version} context (NOT platform numbers):`, markdownTable(["arm", "median ms", "p95 ms", "n"], nodeRows.map((r) => [r.arm, r.median, r.p95, r.n])));
  }

  return {
    algorithm: "pbkdf2",
    engine: { runtime: "workerd", via: "miniflare", note: engineNote, compatibilityDate: COMPAT_DATE },
    measured: "wall-in-isolate around the Phase A verify path (importKey+deriveBits+hex); single-threaded isolate, no I/O inside the timed section — wall ≈ CPU",
    ladder,
    iterationCapProbe: caps,
    cpuAccountingProbe: probes,
    nodeContext: nodeRows,
    markdown: md.join("\n"),
  };
}

/**
 * Binary-search the smallest cpuMs isolate limit under which one op run
 * completes. Reads CPU consumption out of workerd's OWN accounting
 * (limits.cpuMs -> "Worker exceeded CPU time limit." failures), crossing
 * the wall≈CPU assumption with the runtime's own counter. Returns
 * { enforced, estimate, error }: estimate = smallest passing limit (a
 * strict UPPER bound floor: op CPU < estimate + granularity).
 */
async function cpuEstimate(worker, op, params, { lo = 1, hi = 900, steps = 9 } = {}) {
  let lastError = null;
  const predicate = async (limit) => {
    const r = await worker.cpuProbe(op, params, limit);
    if (!r.within) lastError = r.error;
    return r.within;
  };
  if (!(await predicate(hi))) {
    return { enforced: false, estimate: null, error: `fails even at cpuMs=${hi}: ${lastError}` };
  }
  if (await predicate(lo)) {
    return { enforced: null, estimate: lo, error: null }; // below measurable floor
  }
  let a = lo;
  let b = hi;
  for (let i = 0; i < steps && b - a > 1; i++) {
    const mid = Math.round((a + b) / 2);
    if (await predicate(mid)) b = mid;
    else a = mid;
  }
  return { enforced: true, estimate: b, error: lastError };
}

/* main-guard: same pattern as scripts/bench-run.mjs so bench-all can import run(). */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === thisFile;
if (isMain) {
  run(parseBenchArgs(process.argv.slice(2)))
    .then((res) => console.log(res.markdown))
    .catch((e) => {
      console.error(`[fatal] ${e.message}`);
      process.exit(1);
    });
}
