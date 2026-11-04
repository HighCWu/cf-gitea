#!/usr/bin/env node
/* global console, process, performance -- Web globals provided by Node >= 22 */
/**
 * bench-argon2.mjs — argon2id (hash-wasm 4.12.0 wasm, vendored) at the
 * upstream default parameters in workerd.
 *
 *   node scripts/hash-bench/bench-argon2.mjs [--samples N] [--no-node]
 *
 * Upstream default at pin fc49368845: Argon2id (golang.org/x/crypto/argon2
 * IDKey), time=2, memory=65536 KiB (64 MiB), threads=8, keyLen=50 — spec
 * "argon2$2$65536$8$50" (gitea/modules/auth/password/hash/setting.go:23
 * alias; argon2.go:47-52 hardwired defaults; argon2.go:43 comment "using
 * 64MiB in total"). Upstream stores hex(tag) with params in the
 * passwd_hash_algo column (argon2 has NO specialized verifier —
 * hash.go:63-79 recompute + constant-time compare), so the bench measures
 * the full hash call and treats hash≈verify.
 *
 * The wasm build runs single-threaded: upstream's threads=8 becomes 8
 * lanes processed serially (same total work, no parallel speedup) — noted
 * in the report. Viable-approach question (mission): hash-wasm's wasm
 * build runs hermetically in workerd with NO runtime dependency added to
 * the product (vendored file, no npm install) — this CLI is the proof.
 *
 * Cross-validation: vendor/hash-wasm/PROVENANCE.txt records the two
 * independent digest equality checks (vs @noble/hashes argon2id and the
 * python bcrypt / scrypt pairs) run in the scratch prototype before the
 * vendor file landed.
 *
 * Zero npm deps. Node >= 22.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchWorker, COMPAT_DATE } from "./lib/run-worker.mjs";
import { summarize, markdownTable, printLine, parseBenchArgs } from "./lib/stats.mjs";
import { loadVendorHashWasm } from "./lib/vendor-import.mjs";

const thisFile = fileURLToPath(import.meta.url);

export async function run(opts = {}) {
  const samples = opts.samples ?? 10;
  const doNode = opts.node !== false;
  const rows = [];
  const ladder = [];
  let engineNote;

  const w = await createBenchWorker({ nodejsCompat: false });
  try {
    engineNote = `miniflare ${w.miniflareVersion} (compat ${COMPAT_DATE}, flags-free isolate = the product posture); argon2id = hash-wasm 4.12.0 wasm (vendored, single-threaded lanes)`;

    // --- upstream default: t=2, m=65536 KiB (64 MiB), p=8, keyLen=50 ---
    const def = await w.dispatch("argon2", { time: 2, memoryKiB: 65536, parallelism: 8, keyLen: 50, count: samples, warmup: 1 }, { retries: 0, timeoutMs: 300000 });
    if (!def.ok) {
      rows.push(["upstream DEFAULT (argon2$2$65536$8$50)", "64.0", "OOM/FAIL", "-", "-", def.error]);
      ladder.push({ time: 2, memoryKiB: 65536, parallelism: 8, fits: false, error: def.error });
      printLine("argon2 DEFAULT t=2 m=65536KiB p=8", null, `FAILED: ${def.error}`);
    } else {
      const s = summarize(def.samples);
      ladder.push({ time: 2, memoryKiB: 65536, parallelism: 8, fits: true, ...s, digestPrefix: def.meta.digestPrefix });
      rows.push(["upstream DEFAULT (argon2$2$65536$8$50)", "64.0", s.median, s.p95, s.n, `${s.min}–${s.max}`]);
      printLine("argon2 DEFAULT t=2 m=65536KiB p=8 (64 MiB)", s.median, `median ${s.median} ms, p95 ${s.p95} ms (n=${s.n})`);
    }

    // --- shape rungs (half memory; double time) ---
    const rungs = [
      { time: 2, memoryKiB: 32768, parallelism: 8 }, // 32 MiB
      { time: 4, memoryKiB: 32768, parallelism: 8 }, // 32 MiB, 2x passes
    ];
    for (const { time, memoryKiB, parallelism } of rungs) {
      const mib = Math.round((memoryKiB / 1024) * 10) / 10;
      const r = await w.dispatch("argon2", { time, memoryKiB, parallelism, keyLen: 50, count: Math.max(5, Math.round(samples / 2)), warmup: 1 }, { timeoutMs: 300000 });
      if (!r.ok) {
        rows.push([`t=${time} m=${memoryKiB}KiB p=${parallelism} (${mib} MiB)`, String(mib), "OOM/FAIL", "-", "-", r.error]);
        ladder.push({ time, memoryKiB, parallelism, fits: false, error: r.error });
        printLine(`argon2 t=${time} m=${memoryKiB}KiB p=${parallelism}`, null, `FAILED: ${r.error}`);
        continue;
      }
      const s = summarize(r.samples);
      ladder.push({ time, memoryKiB, parallelism, fits: true, ...s, digestPrefix: r.meta.digestPrefix });
      rows.push([`t=${time} m=${memoryKiB}KiB p=${parallelism}`, String(mib), s.median, s.p95, s.n, `${s.min}–${s.max}`]);
      printLine(`argon2 t=${time} m=${memoryKiB}KiB p=${parallelism} (${mib} MiB)`, s.median, `median ${s.median} ms (n=${s.n})`);
    }
  } finally {
    await w.close();
  }

  // --- Node-side context (same vendored wasm in plain Node) ---
  const nodeRows = [];
  if (doNode) {
    const hw = await loadVendorHashWasm();
    const PASSWORD = "correct-horse-battery-staple";
    const SALT_16 = new Uint8Array(16).map((_, i) => (i * 37 + 11) & 0xff);
    for (const [time, memoryKiB, parallelism] of [[2, 65536, 8], [2, 32768, 8]]) {
      const t = [];
      for (let i = 0; i < Math.max(5, Math.round(samples / 2)); i++) {
        const t0 = performance.now();
        await hw.argon2id({ password: PASSWORD, salt: SALT_16, parallelism, iterations: time, memorySize: memoryKiB, hashLength: 50, outputType: "hex" });
        t.push(performance.now() - t0);
      }
      const s = summarize(t);
      nodeRows.push({ arm: `node hash-wasm argon2id t=${time} m=${memoryKiB} p=${parallelism}`, ...s });
      printLine(`node context t=${time} m=${memoryKiB} p=${parallelism}`, s.median, `median ${s.median} ms (context only, Node ${process.version})`);
    }
  }

  const md = [
    `workerd isolate: ${engineNote}`,
    "",
    markdownTable(
      ["params (m KiB)", "MiB", "median ms", "p95 ms", "n", "min–max ms / error"],
      rows,
    ),
  ];
  if (nodeRows.length > 0) {
    md.push("", `Node ${process.version} context (NOT platform numbers):`, markdownTable(["arm", "median ms", "p95 ms", "n"], nodeRows.map((r) => [r.arm, r.median, r.p95, r.n])));
  }

  return {
    algorithm: "argon2",
    engine: { runtime: "workerd", via: "miniflare", note: engineNote, compatibilityDate: COMPAT_DATE, implementation: "hash-wasm 4.12.0 wasm (vendored), single-threaded lanes" },
    measured: "wall-in-isolate around full argon2id hash calls (hex tag out; upstream verify = recompute + constant-time compare, so hash ≈ verify)",
    ladder,
    nodeContext: nodeRows,
    markdown: md.join("\n"),
  };
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
