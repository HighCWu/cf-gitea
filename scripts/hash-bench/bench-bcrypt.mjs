#!/usr/bin/env node
/* global console, process, performance -- Web globals provided by Node >= 22 */
/**
 * bench-bcrypt.mjs — bcrypt (wasm via hash-wasm 4.12.0) CPU cost per
 * hash/verify in workerd, at the upstream default cost and the 2^n ladder.
 *
 *   node scripts/hash-bench/bench-bcrypt.mjs [--samples N] [--no-node]
 *
 * Upstream default at pin fc49368845: cost 10 — bcrypt$10
 * (gitea/modules/auth/password/hash/setting.go:24 alias;
 * gitea/modules/auth/password/hash/bcrypt.go:40-42 hardwired default,
 * "MUST NOT BE CHANGED"). Upstream STORES the full modular-crypt string
 * (bcrypt.go:25-27) and verifies against the hash-embedded params via
 * bcrypt.CompareHashAndPassword (bcrypt.go:29-31) — the ONLY registered
 * hasher with a specialized verifier (hash.go:66).
 *
 * The bench implementation is hash-wasm's bcrypt wasm build (vendored,
 * vendor/hash-wasm/ — provenance + cross-validation vs python bcrypt in
 * PROVENANCE.txt). Workerd has no native bcrypt; any Phase B/C adoption
 * rides wasm or pure JS, so a wasm build is the representative shape.
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
  const samples = opts.samples ?? 25;
  const doNode = opts.node !== false;
  const rows = [];
  const ladder = [];
  let engineNote;
  let crossCheck;

  const w = await createBenchWorker({ nodejsCompat: false });
  try {
    engineNote = `miniflare ${w.miniflareVersion} (compat ${COMPAT_DATE}, flags-free isolate = the product posture); bcrypt = hash-wasm 4.12.0 wasm (vendored)`;

    // Determinism + workerd-vs-node digest equality arm: same inputs must
    // produce the identical modular-crypt string in workerd and in plain
    // Node (both run the same vendored wasm; catches workerd wasm-runtime
    // divergence). Hash generated here, cross-checked in the Node section.
    const r10h = await w.dispatch("bcrypt-hash", { costFactor: 10, count: 1, warmup: 0 });
    if (!r10h.ok) throw new Error(`bcrypt cost-10 warmup failed: ${r10h.error}`);
    const hash10 = r10h.meta.hashPrefix;
    // The equality arm runs at cost 4 (fast): workerd returns the
    // modular-crypt PREFIX only (size discipline in the worker op); the
    // Node side re-derives the full string and compares the prefix.
    const rc4 = await w.dispatch("bcrypt-hash", { costFactor: 4, count: 1, warmup: 0 });
    const r10v = await w.dispatch("bcrypt-verify", { costFactor: 10, count: 1, warmup: 0 });
    if (!r10v.ok || r10v.meta.verifyOk !== true || r10v.meta.verifyWrongPwFalse !== true) {
      throw new Error(`bcrypt self-verify failed in workerd: ${JSON.stringify(r10v.meta ?? r10v.error)}`);
    }

    // --- the ladder: cost 8 / 10 (upstream default) / 12 ---
    const ladderDefs = [
      { cost: 8, count: samples },
      { cost: 10, count: Math.max(12, samples) },
      { cost: 12, count: Math.max(6, Math.round(samples / 4)) },
    ];
    for (const { cost, count } of ladderDefs) {
      const warmup = cost >= 12 ? 1 : 2;
      const h = await w.dispatch("bcrypt-hash", { costFactor: cost, count, warmup }, { timeoutMs: 300000 });
      if (!h.ok) {
        rows.push([`cost ${cost}`, "hash", "ERROR", "ERROR", "-", h.error]);
        ladder.push({ cost, op: "hash", error: h.error });
        continue;
      }
      const hs = summarize(h.samples);
      const v = await w.dispatch("bcrypt-verify", { costFactor: cost, count, warmup }, { timeoutMs: 300000 });
      const vs = v.ok ? summarize(v.samples) : null;
      ladder.push({
        cost,
        hash: hs,
        verify: vs,
        verifyOk: v.ok ? v.meta.verifyOk : null,
        hashPrefix: h.meta.hashPrefix,
      });
      rows.push([`cost ${cost}${cost === 10 ? " (upstream default)" : ""}`, "verify", vs ? vs.median : "ERROR", vs ? vs.p95 : "-", vs ? vs.n : "-", vs ? `${vs.min}–${vs.max}` : v.error]);
      rows.push([`cost ${cost}`, "hash", hs.median, hs.p95, hs.n, `${hs.min}–${hs.max}`]);
      printLine(`bcrypt verify cost=${cost}`, vs?.median, `median ${vs?.median} ms, p95 ${vs?.p95} ms (n=${vs?.n})`);
      printLine(`bcrypt hash   cost=${cost}`, hs.median, `median ${hs.median} ms (hash ≈ verify work; stored shape = full modular-crypt string)`);
    }
    crossCheck = {
      workerdHashPrefixCost10: hash10,
      workerdCost4Prefix: rc4.ok ? rc4.meta.hashPrefix : null,
      selfVerifyCost10Ok: r10v.ok && r10v.meta.verifyOk === true,
    };
  } finally {
    await w.close();
  }

  // --- Node-side context + digest-equality cross-check ---
  const nodeRows = [];
  if (doNode) {
    const hw = await loadVendorHashWasm();
    const PASSWORD = "correct-horse-battery-staple";
    const SALT_16 = new Uint8Array(16).map((_, i) => (i * 37 + 11) & 0xff);
    // digest equality: cost 4 string from workerd vs the same in Node
    if (crossCheck?.workerdCost4Prefix) {
      const nodeHash = await hw.bcrypt({ password: PASSWORD, salt: SALT_16, costFactor: 4 });
      const equal = nodeHash.startsWith(crossCheck.workerdCost4Prefix);
      crossCheck.nodeHashEqualsWorkerd = equal;
      crossCheck.nodeHashCost4 = nodeHash;
      printLine("digest equality", null, equal
        ? "workerd wasm hash == plain-Node wasm hash (same vendored build, deterministic)"
        : `MISMATCH: workerd ${crossCheck.workerdCost4Prefix} vs node ${nodeHash}`);
    }
    for (const cost of [8, 10, 12]) {
      const count = cost === 12 ? 6 : Math.max(12, samples);
      const t = [];
      for (let i = 0; i < count; i++) {
        const t0 = performance.now();
        await hw.bcrypt({ password: PASSWORD, salt: SALT_16, costFactor: cost });
        t.push(performance.now() - t0);
      }
      const s = summarize(t);
      nodeRows.push({ arm: `node hash-wasm bcrypt cost=${cost}`, ...s });
      printLine(`node context cost=${cost}`, s.median, `median ${s.median} ms (context only, Node ${process.version})`);
    }
  }

  const md = [
    `workerd isolate: ${engineNote}`,
    "",
    markdownTable(
      ["arm", "op", "median ms", "p95 ms", "n", "min–max ms"],
      rows,
    ),
  ];
  if (nodeRows.length > 0) {
    md.push("", `Node ${process.version} context (NOT platform numbers):`, markdownTable(["arm", "median ms", "p95 ms", "n"], nodeRows.map((r) => [r.arm, r.median, r.p95, r.n])));
  }

  return {
    algorithm: "bcrypt",
    engine: { runtime: "workerd", via: "miniflare", note: engineNote, compatibilityDate: COMPAT_DATE, implementation: "hash-wasm 4.12.0 wasm (vendored)" },
    measured: "wall-in-isolate around full hash / bcryptVerify calls (modular-crypt in/out)",
    ladder,
    crossCheck,
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
