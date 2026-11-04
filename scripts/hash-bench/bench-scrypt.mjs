#!/usr/bin/env node
/* global console, process, performance -- Web globals provided by Node >= 22 */
/**
 * bench-scrypt.mjs — scrypt (node:crypto scryptSync under nodejs_compat)
 * in workerd: the upstream default-params probes, the maxmem behavior, and
 * the largest-fitting param ladder.
 *
 *   node scripts/hash-bench/bench-scrypt.mjs [--samples N] [--no-node]
 *
 * Upstream default at pin fc49368845: N=65536 (1<<16), r=16, p=2, keyLen=50
 * — spec "scrypt$65536$16$2$50" (gitea/modules/auth/password/hash/
 * setting.go:25 alias; scrypt.go:42-47 hardwired default; the code comment
 * at scrypt.go:45 itself notes "this default config will use 128MiB").
 * scrypt working memory ≈ 128*N*r bytes = 128*65536*16 = EXACTLY 128 MiB —
 * the Workers standard isolate memory ceiling. THREE independent platform
 * constraints are probed here:
 *   1. workerd's node:crypto scrypt DEFAULT maxmem ≈ 1 MiB (cost check
 *      1048576) — far below Node's 32 MiB default (workerd#6639); passing
 *      an explicit maxmem lifts the check.
 *   2. the ~16 MiB working-set boundary observed beyond the cost check
 *      (rungs above fail with a bare "Scrypt failed" until maxmem is set).
 *   3. the 128 MiB isolate memory ceiling — the default params' working
 *      set alone equals it, so they can never fit regardless of maxmem.
 *
 * REQUIRES nodejs_compat (node:crypto) — this arm boots a SEPARATE isolate
 * with ["nodejs_compat"]; the product currently ships WITHOUT the flag
 * (wrangler.jsonc has no compatibility_flags entry), which is itself a
 * Phase C prerequisite, flagged in the report.
 *
 * Zero npm deps. Node >= 22.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBenchWorker, COMPAT_DATE } from "./lib/run-worker.mjs";
import { summarize, markdownTable, printLine, parseBenchArgs } from "./lib/stats.mjs";

const thisFile = fileURLToPath(import.meta.url);

const PASSWORD = "correct-horse-battery-staple";
const SALT_16 = new Uint8Array(16).map((_, i) => (i * 37 + 11) & 0xff);

export async function run(opts = {}) {
  const samples = opts.samples ?? 5;
  const doNode = opts.node !== false;
  const rows = [];
  const ladder = [];
  let engineNote;

  const w = await createBenchWorker({ nodejsCompat: true });
  try {
    engineNote = `miniflare ${w.miniflareVersion} (compat ${COMPAT_DATE}, ["nodejs_compat"] isolate — the scrypt arm REQUIRES the flag; product ships without it); scrypt = workerd's native node:crypto implementation`;

    const dispatchScrypt = async ({ N, r, p, maxmemBytes = null, count = 1, warmup = 0 }) =>
      w.dispatch("scrypt", { N, r, p, keyLen: 50, maxmemBytes, count, warmup }, { retries: 0, timeoutMs: 300000 });
    const memMiB = (N, r) => Math.round(((128 * N * r) / 2 ** 20) * 100) / 100;

    // --- pass 1: upstream default params, as-shipped workerd (default
    // maxmem) — expect the cost-check rejection ---
    {
      const def = await dispatchScrypt({ N: 65536, r: 16, p: 2 });
      const detail = def.ok ? `RAN, ${Math.round(def.samples[0])} ms single sample` : `FAILED: ${def.error}`;
      printLine("pass 1: DEFAULT N=65536 r=16 p=2 (working set 128.00 MiB), workerd default maxmem", null, detail);
      if (def.ok) {
        const s = summarize(def.samples);
        rows.push(["upstream DEFAULT (scrypt$65536$16$2$50), default maxmem", "128.00", s.median, s.p95, s.n, `${s.min}–${s.max}`]);
        ladder.push({ pass: 1, N: 65536, r: 16, p: 2, approxMiB: 128, fits: true, ...s });
      } else {
        rows.push(["upstream DEFAULT (scrypt$65536$16$2$50), default maxmem", "128.00", "FAIL", "-", "-", def.error]);
        ladder.push({ pass: 1, N: 65536, r: 16, p: 2, approxMiB: 128, fits: false, error: def.error });
      }
    }

    // --- pass 2: the ladder, workerd default maxmem (as-shipped behavior) ---
    const rungs = [
      { N: 131072, r: 8, p: 2 },  // 128 MiB (same ceiling, different shape)
      { N: 65536, r: 8, p: 2 },   // 64 MiB
      { N: 32768, r: 16, p: 2 },  // 64 MiB
      { N: 32768, r: 8, p: 2 },   // 32 MiB
      { N: 16384, r: 16, p: 2 },  // 32 MiB
      { N: 16384, r: 8, p: 2 },   // 16 MiB (the mission's example rung)
    ];
    for (const { N, r, p } of rungs) {
      const mib = memMiB(N, r);
      const res = await dispatchScrypt({ N, r, p, count: samples });
      if (!res.ok) {
        rows.push([`N=${N} r=${r} p=${p} (${mib} MiB), default maxmem`, String(mib), "FAIL", "-", "-", res.error]);
        ladder.push({ pass: 2, N, r, p, approxMiB: mib, maxmem: "default", fits: false, error: res.error });
        printLine(`pass 2: N=${N} r=${r} p=${p} (${mib} MiB), default maxmem`, null, `FAILED: ${res.error}`);
      } else {
        const s = summarize(res.samples);
        rows.push([`N=${N} r=${r} p=${p} (${mib} MiB), default maxmem`, String(mib), s.median, s.p95, s.n, `${s.min}–${s.max}`]);
        ladder.push({ pass: 2, N, r, p, approxMiB: mib, maxmem: "default", fits: true, ...s, digestPrefix: res.meta.digestPrefix });
        printLine(`pass 2: N=${N} r=${r} p=${p} (${mib} MiB), default maxmem`, s.median, `median ${s.median} ms (n=${s.n})`);
      }
    }

    // --- pass 3: same ladder with an explicit maxmem (Node-parity opt-in;
    // 192 MiB covers the OpenSSL 128*N*r*p check for every <=64 MiB rung) ---
    const MAXMEM = 192 * 1024 * 1024;
    for (const { N, r, p } of rungs.filter((x) => memMiB(x.N, x.r) <= 64)) {
      const mib = memMiB(N, r);
      const res = await dispatchScrypt({ N, r, p, maxmemBytes: MAXMEM, count: samples });
      if (!res.ok) {
        rows.push([`N=${N} r=${r} p=${p} (${mib} MiB), maxmem=192MiB`, String(mib), "FAIL", "-", "-", res.error]);
        ladder.push({ pass: 3, N, r, p, approxMiB: mib, maxmem: MAXMEM, fits: false, error: res.error });
        printLine(`pass 3: N=${N} r=${r} p=${p} (${mib} MiB), maxmem=192MiB`, null, `FAILED: ${res.error}`);
      } else {
        const s = summarize(res.samples);
        rows.push([`N=${N} r=${r} p=${p} (${mib} MiB), maxmem=192MiB`, String(mib), s.median, s.p95, s.n, `${s.min}–${s.max}`]);
        ladder.push({ pass: 3, N, r, p, approxMiB: mib, maxmem: MAXMEM, fits: true, ...s, digestPrefix: res.meta.digestPrefix });
        printLine(`pass 3: N=${N} r=${r} p=${p} (${mib} MiB), maxmem=192MiB`, s.median, `median ${s.median} ms, p95 ${s.p95} ms (n=${s.n})`);
      }
    }

    // --- pass 4: the 128 MiB working-set shapes with the maxmem check
    // lifted PAST the OpenSSL accounting (128*N*r*p = 256 MiB <= 320 MiB),
    // so the remaining failure — if any — is the real isolate ceiling ---
    for (const [N, r, p] of [[65536, 16, 2], [131072, 8, 2]]) {
      const mib = memMiB(N, r);
      const PASS4_MAXMEM = 320 * 1024 * 1024;
      const res = await dispatchScrypt({ N, r, p, maxmemBytes: PASS4_MAXMEM, count: 1 });
      const detail = res.ok ? `RAN?! ${Math.round(res.samples[0])} ms` : `FAILED: ${res.error}`;
      printLine(`pass 4: N=${N} r=${r} p=${p} (${mib} MiB working set), maxmem=320MiB`, null, detail);
      ladder.push({ pass: 4, N, r, p, approxMiB: mib, maxmem: PASS4_MAXMEM, fits: res.ok, error: res.ok ? null : res.error });
      rows.push([`N=${N} r=${r} p=${p} (${mib} MiB), maxmem=320MiB`, String(mib), res.ok ? "ran" : "FAIL", "-", "-", res.ok ? `${Math.round(res.samples[0])} ms single sample` : res.error]);
    }
  } finally {
    await w.close();
  }

  // --- Node-side context (same ladder; NOT platform numbers) ---
  const nodeRows = [];
  if (doNode) {
    const { scryptSync } = await import("node:crypto");
    for (const [N, r, p] of [[65536, 16, 2], [65536, 8, 2], [32768, 8, 2], [16384, 8, 2]]) {
      // Node-parity pass: explicit maxmem (Node's own default is 32 MiB,
      // which fails the big rungs for a DIFFERENT reason than workerd).
      const t = [];
      let err = null;
      for (let i = 0; i < samples; i++) {
        try {
          const t0 = performance.now();
          scryptSync(PASSWORD, SALT_16, 50, { N, r, p, maxmem: 192 * 1024 * 1024 });
          t.push(performance.now() - t0);
        } catch (e) {
          err = e.message;
          break;
        }
      }
      if (err !== null) {
        nodeRows.push({ arm: `node scryptSync N=${N} r=${r} p=${p} maxmem=192MiB`, error: err });
        printLine(`node context N=${N} r=${r} p=${p}`, null, `failed: ${err}`);
        continue;
      }
      const s = summarize(t);
      nodeRows.push({ arm: `node scryptSync N=${N} r=${r} p=${p} maxmem=192MiB`, ...s });
      printLine(`node context N=${N} r=${r} p=${p}`, s.median, `median ${s.median} ms (context only, Node ${process.version})`);
    }
  }

  const md = [
    `workerd isolate: ${engineNote}`,
    "",
    markdownTable(
      ["params / pass", "working-set MiB", "median ms", "p95 ms", "n", "min–max ms / error"],
      rows,
    ),
  ];
  if (nodeRows.length > 0) {
    md.push("", `Node ${process.version} context (NOT platform numbers; maxmem=192MiB):`, markdownTable(["arm", "median ms", "p95 ms", "n", "error"], nodeRows.map((r) => [r.arm, r.median ?? "-", r.p95 ?? "-", r.n ?? "-", r.error ?? "-"])));
  }

  return {
    algorithm: "scrypt",
    engine: { runtime: "workerd", via: "miniflare", note: engineNote, compatibilityDate: COMPAT_DATE, implementation: "node:crypto scryptSync (nodejs_compat REQUIRED)" },
    measured: "wall-in-isolate around scryptSync (synchronous CPU-bound; wall = CPU by construction); memory fit judged by workerd allocation behavior at the 128 MiB isolate ceiling",
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
