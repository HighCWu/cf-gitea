/* global Buffer -- Node >= 22 global */
/**
 * vendor-import.mjs — load the vendored hash-wasm ESM bundle into PLAIN
 * NODE for the context benches and parity checks.
 *
 * The vendor file is stored as index.esm.js.vendored (not a lintable
 * module extension — see vendor/hash-wasm/PROVENANCE.txt: it is
 * byte-identical third-party dist output and must never be linted or
 * shipped). workerd loads it fine because lib/run-worker.mjs declares it
 * explicitly as an ESModule with its absolute path; plain Node's import()
 * needs a real module extension, so this helper reads the bytes and
 * imports them through a data: URL (stdlib-only, no loader config).
 *
 * Zero npm deps. Node >= 22.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const vendorBundle = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "vendor",
  "hash-wasm",
  "index.esm.js.vendored",
);

let cached = null;

/** Import the vendored bundle (cached; one decode per process). */
export async function loadVendorHashWasm() {
  if (!cached) {
    const source = fs.readFileSync(vendorBundle, "utf8");
    const url = `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
    cached = await import(url);
  }
  return cached;
}

/** Absolute path of the vendored bundle (for extract-wasm.mjs + docs). */
export function vendorBundlePath() {
  return vendorBundle;
}
