#!/usr/bin/env node
/* global crypto, TextEncoder, console, process -- Web globals provided by Node >= 22 */
/**
 * verify-parity.mjs — digest parity: workerd vs Node/reference, per
 * algorithm. The correctness companion to the benchmark CLIs (which only
 * measure TIME); run before trusting any bench-all.mjs numbers.
 *
 *   node scripts/hash-bench/verify-parity.mjs
 *
 * Checks (all over the SAME deterministic (password, salt) pair as the
 * benches — lib/worker-bench.mjs PASSWORD/SALT_16):
 *   1. pbkdf2:   workerd WebCrypto deriveBits hex
 *                == Node crypto.subtle (same call shape)
 *                == Node crypto.pbkdf2Sync (OpenSSL)
 *                at the landed default spec pbkdf2$50000$50 and the legacy
 *                pbkdf2$10000$50 arm.
 *   2. scrypt:   workerd node:crypto scryptSync (nodejs_compat isolate)
 *                == Node crypto.scryptSync, at (N=16384, r=8, p=2, len=50,
 *                maxmem explicit).
 *   3. argon2:   workerd hash-wasm wasm (static import)
 *                == Node hash-wasm wasm (same vendored binary, dynamic
 *                compile) at the upstream default (t=2, m=65536KiB, p=8,
 *                len=50). Upstream-parity of THIS binary against an
 *                independent implementation (@noble/hashes) was proven in
 *                the pre-landing prototype — vendor/hash-wasm/PROVENANCE.txt.
 *   4. bcrypt:   workerd hash-wasm wasm == Node hash-wasm wasm, full
 *                modular-crypt string, cost 4 (fast). Upstream-parity of
 *                the binary vs python3-bcrypt: PROVENANCE.txt.
 *
 * Exit 0 iff every check passes. Zero npm deps. Node >= 22.
 */
import { pbkdf2Sync, scryptSync } from "node:crypto";
import { createBenchWorker } from "./lib/run-worker.mjs";
import { loadVendorHashWasm } from "./lib/vendor-import.mjs";
import { printLine } from "./lib/stats.mjs";

const PASSWORD = "correct-horse-battery-staple";
const SALT_16 = new Uint8Array(16).map((_, i) => (i * 37 + 11) & 0xff);

function bytesToHex(bytes) {
  let out = "";
  for (const byte of bytes) {
    out += (byte >> 4).toString(16);
    out += (byte & 0x0f).toString(16);
  }
  return out;
}

/** The landed Phase A call shape, in plain Node (identical WebCrypto
 * semantics; Node >= 24 exposes crypto.subtle globally). */
async function pbkdf2WebCryptoHex(iter, keyLen) {
  const passwordBytes = new TextEncoder().encode(PASSWORD);
  const key = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: SALT_16, iterations: iter },
    key,
    keyLen * 8,
  );
  return bytesToHex(new Uint8Array(bits));
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  printLine(`parity ${name}`, null, `${ok ? "EQUAL" : "MISMATCH"} — ${detail}`);
}

const w = await createBenchWorker({ nodejsCompat: false });
try {
  // --- 1. pbkdf2 ---
  for (const iter of [10000, 50000]) {
    const wd = (await w.dispatch("pbkdf2", { iter, keyLen: 50, count: 1, warmup: 0, fullDigest: true })).meta.digestFull;
    const subtle = await pbkdf2WebCryptoHex(iter, 50);
    const openssl = bytesToHex(pbkdf2Sync(PASSWORD, SALT_16, iter, 50, "sha256"));
    check(`pbkdf2 iter=${iter} workerd==node-subtle`, wd === subtle, `len ${wd.length} hex`);
    check(`pbkdf2 iter=${iter} workerd==openssl`, wd === openssl, `len ${wd.length} hex`);
  }

  // --- 3. argon2 (flags-free worker; vendored wasm via static import) ---
  {
    const hw = await loadVendorHashWasm();
    const wd = (await w.dispatch("argon2", { time: 2, memoryKiB: 65536, parallelism: 8, keyLen: 50, count: 1, warmup: 0, fullDigest: true })).meta.digestFull;
    const node = await hw.argon2id({ password: PASSWORD, salt: SALT_16, parallelism: 8, iterations: 2, memorySize: 65536, hashLength: 50, outputType: "hex" });
    check("argon2 default workerd==node-wasm", wd === node, `${wd.length} hex chars (tag 50 B); noble-parity: PROVENANCE.txt`);
  }

  // --- 4. bcrypt (cost 4 keeps this check fast) ---
  {
    const hw = await loadVendorHashWasm();
    const wd = (await w.dispatch("bcrypt-hash", { costFactor: 4, count: 1, warmup: 0, fullDigest: true })).meta.hashFull;
    const node = await hw.bcrypt({ password: PASSWORD, salt: SALT_16, costFactor: 4 });
    check("bcrypt cost=4 workerd==node-wasm", wd === node, wd.slice(0, 29) + "... (python-bcrypt parity: PROVENANCE.txt)");
  }
} finally {
  await w.close();
}

// --- 2. scrypt (needs nodejs_compat isolate; run last, own worker) ---
{
  const ws = await createBenchWorker({ nodejsCompat: true });
  try {
    const params = { N: 16384, r: 8, p: 2, keyLen: 50, maxmemBytes: 32 * 1024 * 1024, count: 1, warmup: 0, fullDigest: true };
    const wd = (await ws.dispatch("scrypt", params)).meta.digestFull;
    const node = bytesToHex(scryptSync(PASSWORD, SALT_16, 50, { N: params.N, r: params.r, p: params.p, maxmem: params.maxmemBytes }));
    check("scrypt (16384,8,2) workerd==node", wd === node, `${wd.length} hex chars`);
  } finally {
    await ws.close();
  }
}

if (failures > 0) {
  console.error(`\nparity FAILED (${failures} mismatch(es))`);
  process.exit(1);
}
console.log("\nall parity checks passed — the bench numbers compare like-for-like digests");
