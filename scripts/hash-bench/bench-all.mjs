#!/usr/bin/env node
/* global console, process -- Web globals provided by Node >= 22 */
/**
 * bench-all.mjs — run every hash-bench CLI in sequence and write one JSON
 * results document (the reproducibility artifact behind
 * docs/research/hash-bench-phase-b.md).
 *
 *   node scripts/hash-bench/bench-all.mjs [--samples N] [--out <path>]
 *        [--skip pbkdf2,bcrypt,scrypt,argon2] [--cpu-probe]
 *
 * Results go to .bench-results/ (gitignored, same convention as
 * scripts/bench-run.mjs — measurements are host-relative and NEVER
 * committed; the report quotes the numbers with the harness command that
 * produced them and the box context).
 *
 * Zero npm deps. Node >= 22.
 */
import fs from "node:fs";
import path from "node:path";
import { run as runPbkdf2 } from "./bench-pbkdf2.mjs";
import { run as runBcrypt } from "./bench-bcrypt.mjs";
import { run as runScrypt } from "./bench-scrypt.mjs";
import { run as runArgon2 } from "./bench-argon2.mjs";
import { COMPAT_DATE, PRODUCT_CPU_MS, MEMORY_CEILING_MIB } from "./lib/run-worker.mjs";
import { repoRoot } from "./lib/miniflare-resolve.mjs";
import os from "node:os";

function parseArgs(argv) {
  const opts = {
    samples: undefined,
    out: null,
    skip: new Set(),
    cpuProbe: true,
    node: true,
  };
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
    else if (a === "--out") opts.out = path.resolve(next());
    else if (a === "--skip") for (const s of next().split(",")) opts.skip.add(s.trim());
    else if (a === "--no-cpu-probe") opts.cpuProbe = false;
    else if (a === "--no-node") opts.node = false;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const common = {
    ...(opts.samples !== undefined ? { samples: opts.samples } : {}),
    cpuProbe: opts.cpuProbe,
    node: opts.node,
  };

  console.log("hash-bench Phase B — all algorithms");
  console.log(`  host: ${os.platform()} ${os.arch()} cpus=${os.cpus().length} node ${process.version}`);
  console.log(`  target runtime: workerd via the repo's pinned miniflare (compat ${COMPAT_DATE}, product limits.cpu_ms ${PRODUCT_CPU_MS}, memory ceiling ${MEMORY_CEILING_MIB} MiB)`);

  const results = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      compatDate: COMPAT_DATE,
      productCpuMs: PRODUCT_CPU_MS,
      memoryCeilingMiB: MEMORY_CEILING_MIB,
    },
    note: "measurements are host-relative (local workerd via miniflare); the report quotes them with this command as the reproduction recipe",
    algorithms: {},
  };

  const steps = [
    ["pbkdf2", runPbkdf2],
    ["bcrypt", runBcrypt],
    ["scrypt", runScrypt],
    ["argon2", runArgon2],
  ];
  for (const [name, fn] of steps) {
    if (opts.skip.has(name)) {
      console.log(`\n[skip] ${name}`);
      continue;
    }
    console.log(`\n=== ${name} ===`);
    try {
      results.algorithms[name] = await fn(common);
      console.log(results.algorithms[name].markdown);
    } catch (e) {
      results.algorithms[name] = { fatal: e.message };
      console.error(`  [fatal] ${name}: ${e.message}`);
    }
  }

  const outDir = path.join(repoRoot, ".bench-results");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = opts.out ?? path.join(outDir, `hash-bench-phase-b-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
  console.log(`\nresults JSON: ${outPath}`);
}

main().catch((e) => {
  console.error(`[fatal] ${e.message}`);
  process.exit(1);
});
