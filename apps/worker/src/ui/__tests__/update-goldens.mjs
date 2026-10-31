/**
 * Regenerate the U5 golden snapshots (SPEC-0008 §5.2). Run from apps/worker:
 *
 *     node src/ui/__tests__/update-goldens.mjs
 *
 * Why not `GOLDEN_UPDATE=1`: the UI tests run in workerd
 * (@cloudflare/vitest-plugin), where tests have no filesystem writes and
 * shell env vars do not reach the worker (verified 2026-10-24 — the worker's
 * `process.env` carries only miniflare bindings and Vite's own vars). The
 * flow below is the "tiny mjs" pattern instead:
 *
 *   1. empty every goldens/*.html (the tests read them via Vite `?raw`),
 *   2. create the update sentinel that flips goldens.test.ts into
 *      print-only mode (marker-framed renders on stdout),
 *   3. run vitest on the golden file and extract the markers,
 *   4. write the renders back byte-exactly and drop the sentinel.
 *
 * The committed files ARE the reviewed artifact (§5.2); re-baseline on every
 * submodule re-pin after re-checking the §2.4 DOM contract (§5.4).
 */

/* global console, process -- Node globals (repo lint convention: no node env in the flat config) */

import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const goldensDir = join(here, "goldens");
const sentinel = join(here, "goldens-update-mode");
const workerDir = join(here, "..", "..", "..");

// .html + the .rss/.atom feed envelopes (abd512f / the .atom twins, 19d15a1's
// one-line pattern): a removed case must go loud (the sentinel walk), never
// leave a stale file the tests still read whole.
const goldenFiles = readdirSync(goldensDir).filter(
  (name) => name.endsWith(".html") || name.endsWith(".rss") || name.endsWith(".atom"),
);
for (const name of goldenFiles) {
  writeFileSync(join(goldensDir, name), "");
}
writeFileSync(sentinel, "update");

let output;
try {
  output = execFileSync(
    "pnpm",
    ["exec", "vitest", "run", "src/ui/__tests__/goldens.test.ts", "--disable-console-intercept"],
    { cwd: workerDir, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
  );
} finally {
  rmSync(sentinel, { force: true });
}

const rendered = new Map();
const marker = /@@GOLDEN:([^\n]+)\n([\s\S]*?)\n@@END-GOLDEN@@/g;
for (const match of output.matchAll(marker)) {
  rendered.set(match[1], match[2]);
}

let failed = false;
// The union: pre-existing files (emptied above — a case removed from
// GOLDEN_CASES still fails loudly) PLUS newly rendered names (a case added
// to GOLDEN_CASES has no file to enumerate before the run).
const names = [...new Set([...goldenFiles, ...rendered.keys()])];
for (const name of names) {
  const body = rendered.get(name);
  if (body === undefined) {
    console.error(`FAIL: no render captured for goldens/${name}`);
    failed = true;
    continue;
  }
  writeFileSync(join(goldensDir, name), body);
  console.log(`updated goldens/${name} (${body.length} bytes)`);
}
if (rendered.size === 0) {
  console.error("FAIL: no golden renders captured — did goldens.test.ts run?\n" + output.slice(-2000));
  process.exit(1);
}
process.exit(failed ? 1 : 0);
