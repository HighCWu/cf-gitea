/* global console, process, Buffer -- Web/Node globals provided by Node >= 22 */
/**
 * extract-wasm.mjs — extract the embedded wasm binaries out of the vendored
 * hash-wasm ESM bundle into real .wasm files.
 *
 *   node scripts/hash-bench/lib/extract-wasm.mjs
 *
 * WHY: workerd (Cloudflare Workers' runtime, and therefore local miniflare)
 * hard-blocks DYNAMIC wasm compilation — WebAssembly.compile(bytes) /
 * WebAssembly.instantiate(bytes) fail with "Wasm code generation disallowed
 * by embedder", with no compatibility flag to lift it. The only supported
 * wasm shape on Workers is a STATICALLY IMPORTED .wasm module (bundled as a
 * CompiledWasm module, compiled at deploy/startup, handed to user code as a
 * precompiled WebAssembly.Module). hash-wasm's dist embeds its wasm as
 * base64 strings and calls WebAssembly.compile(decoded bytes) — which works
 * in Node/browsers but is exactly the blocked shape on Workers.
 *
 * This script pulls each `{name, data}` binary literal out of the bundle
 * and writes vendor/hash-wasm/<name>.wasm so the bench worker can import
 * them statically. The bytes are byte-identical to what hash-wasm ships
 * (same binary, different container) — SHA256s recorded in PROVENANCE.txt.
 *
 * Zero npm deps. Node >= 22.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.resolve(here, "..", "vendor", "hash-wasm");
// The bundle is stored as .js.vendored — byte-identical third-party dist
// output that must never be linted or served (see PROVENANCE.txt).
const bundlePath = path.join(vendorDir, "index.esm.js.vendored");

const bundle = fs.readFileSync(bundlePath, "utf8");

// The bundle (Rollup ESM output) holds one pair of globals per algorithm:
//   var name$N = "argon2";
//   var data$N = "<base64 wasm>";
// (hash-wasm assembles its internal { name, data } binary object from them.)
const re = /var\s+name[$\w]+\s*=\s*"([A-Za-z0-9_.-]+)"\s*;\s*var\s+data[$\w]+\s*=\s*"([A-Za-z0-9+/=]+)"/g;

const found = [];
let m;
while ((m = re.exec(bundle)) !== null) {
  found.push({ name: m[1], data: m[2] });
}
if (found.length === 0) {
  console.error("no embedded wasm literals found in the bundle — is this the hash-wasm dist file?");
  process.exit(1);
}

for (const { name, data } of found) {
  const bytes = Buffer.from(data, "base64");
  // wasm magic sanity: "\0asm" + version 0x01 0x00 0x00 0x00
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    console.error(`skip ${name}: not a wasm binary (magic mismatch)`);
    continue;
  }
  const out = path.join(vendorDir, `${name}.wasm`);
  fs.writeFileSync(out, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  console.log(`extracted ${name}.wasm: ${bytes.length} bytes  sha256 ${sha}`);
}
console.log(`done — ${found.length} embedded binary literal(s) inspected`);
