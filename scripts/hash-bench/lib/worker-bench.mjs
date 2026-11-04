/* global crypto, TextEncoder, performance, Response, WebAssembly -- workerd globals (this module executes INSIDE workerd, never in Node) */
/**
 * worker-bench.mjs — THE BENCH WORKER. This module is executed INSIDE
 * workerd (loaded by miniflare in lib/run-worker.mjs; never run under
 * plain Node), so every `performance.now()` sample it takes measures the
 * same isolate runtime the product ships on (workerd 1.20261023.1 via the
 * repo's pinned miniflare).
 *
 * MEASUREMENT MODEL (stated honestly in the report):
 * - Each sample is a WALL-time reading taken inside the isolate around a
 *   pure-CPU section (hash computation; no I/O, no timers).
 * - workerd isolates are single-threaded, so for these CPU-bound sections
 *   wall-in-isolate ≈ CPU time consumed by the isolate (nothing else runs
 *   in the isolate while the computation is pending, and the computation
 *   never awaits I/O).
 * - WebCrypto/wasm/native calls may bounce into workerd's C++ core, but
 *   that core CPU time still belongs to the same request until the call
 *   returns, so it is counted too.
 * - The `cpu-limit` op in lib/run-worker.mjs cross-checks wall≈CPU against
 *   workerd's OWN cpu_ms accounting (limits.cpuMs enforcement) — see the
 *   report's "what was measured" section.
 *
 * Ops (POST /bench, JSON body {op, params, count, warmup}):
 *   info          — runtime capabilities probe
 *   pbkdf2        — WebCrypto PBKDF2-HMAC-SHA256, the landed Phase A path
 *                   (same call shape as apps/worker/src/auth/password.ts
 *                   pbkdf2Sha256Hex: importKey + deriveBits per sample)
 *   pbkdf2-cap    — single deriveBits probe for an iteration count; used to
 *                   test whether local workerd enforces the Cloudflare
 *                   documented 100,000-iteration cap for PBKDF2
 *   bcrypt-hash   — hash-wasm bcrypt (wasm), full modular-crypt output
 *   bcrypt-verify — hash-wasm bcryptVerify against a precomputed hash
 *   scrypt        — node:crypto scryptSync (REQUIRES nodejs_compat; dynamic
 *                   import so the flags-free worker still boots)
 *   argon2        — hash-wasm argon2id (wasm), hex tag output (the upstream
 *                   stored shape: hex(digest), params in passwd_hash_algo)
 *
 * The vendor file is hash-wasm 4.12.0 (MIT), byte-identical to the npm
 * dist — see vendor/hash-wasm/PROVENANCE.txt.
 */

import { argon2id, bcrypt, bcryptVerify } from "../vendor/hash-wasm/index.esm.js.vendored";
// Static wasm module imports — the ONLY wasm shape workerd allows. workerd
// hard-blocks dynamic compilation (WebAssembly.compile(bytes) fails with
// "Wasm code generation disallowed by embedder", no compat flag), so
// hash-wasm's base64-embedded wasm can never run here as-is. The two
// binaries below were extracted byte-identical from the vendored hash-wasm
// bundle (lib/extract-wasm.mjs; provenance in vendor/hash-wasm/) and
// declared as CompiledWasm modules by lib/run-worker.mjs — the import
// yields the PRECOMPILED WebAssembly.Module.
import argon2Wasm from "../vendor/hash-wasm/argon2.wasm";
import bcryptWasm from "../vendor/hash-wasm/bcrypt.wasm";
// argon2id needs blake2b too: hash-wasm computes the argon2 H0 with its
// blake2b wasm build, so that binary must be statically declared as well.
import blake2bWasm from "../vendor/hash-wasm/blake2b.wasm";

/**
 * hash-wasm's loader calls WebAssembly.compile(decodedBase64Bytes) on
 * first use per algorithm. We redirect that to the precompiled static
 * modules, matched by byte length (6660 / 7442 / 16944 — unambiguous). A
 * length match against the extracted binaries IS the identity check:
 * the static bytes came out of this exact bundle (extract-wasm.mjs).
 */
const STATIC_WASM_BY_LENGTH = new Map([
  [6660, argon2Wasm],
  [7442, blake2bWasm],
  [16944, bcryptWasm],
]);
const nativeWasmCompile = WebAssembly.compile.bind(WebAssembly);
WebAssembly.compile = async (bytes) => {
  const mod = bytes instanceof Uint8Array ? STATIC_WASM_BY_LENGTH.get(bytes.byteLength) : undefined;
  if (mod !== undefined) return mod;
  return nativeWasmCompile(bytes);
};

/** Fixed bench inputs (deterministic; upstream hashes `password`-class
 * ASCII secrets over hex(16-byte) salts — user.go:555-565 GetUserSalt). */
const PASSWORD = "correct-horse-battery-staple";
const SALT_16 = new Uint8Array(16).map((_, i) => (i * 37 + 11) & 0xff);

/** workerd-native bytesToHex (same shape as password.ts bytesToHex). */
function bytesToHex(bytes) {
  let out = "";
  for (const byte of bytes) {
    out += (byte >> 4).toString(16);
    out += (byte & 0x0f).toString(16);
  }
  return out;
}

/** PBKDF2-HMAC-SHA256 — EXACTLY the landed Phase A call shape
 * (apps/worker/src/auth/password.ts pbkdf2Sha256Hex, password.ts:185-199):
 * importKey("raw"...) + deriveBits(..., keyLen*8) per invocation. */
async function pbkdf2Sha256Hex(password, saltBytes, iter, keyLen) {
  const passwordBytes = new TextEncoder().encode(password);
  const key = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: iter },
    key,
    keyLen * 8,
  );
  return bytesToHex(new Uint8Array(bits));
}

/** The bench ops. Each returns { samples: [ms...], meta }. */
const OPS = {
  async info() {
    let nodeCrypto;
    try {
      const nc = await import("node:crypto");
      nodeCrypto = { scryptSync: typeof nc.scryptSync };
    } catch (e) {
      nodeCrypto = { error: String(e.message || e).slice(0, 120) };
    }
    return {
      samples: [],
      meta: {
        webcrypto: typeof crypto?.subtle,
        webassembly: typeof WebAssembly,
        performanceNow: typeof performance?.now,
        nodeCrypto,
      },
    };
  },

  async "pbkdf2-cap"({ iterations }) {
    const t0 = performance.now();
    try {
      await pbkdf2Sha256Hex(PASSWORD, SALT_16, iterations, 50);
      return { samples: [performance.now() - t0], meta: { accepted: true, iterations } };
    } catch (e) {
      return {
        samples: [performance.now() - t0],
        meta: { accepted: false, iterations, error: String(e.message || e).slice(0, 200) },
      };
    }
  },

  async pbkdf2({ iter, keyLen = 50, count, warmup, fullDigest = false }) {
    for (let i = 0; i < warmup; i++) await pbkdf2Sha256Hex(PASSWORD, SALT_16, iter, keyLen);
    const samples = [];
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      await pbkdf2Sha256Hex(PASSWORD, SALT_16, iter, keyLen);
      samples.push(performance.now() - t0);
    }
    // Digest sanity echo (recomputed once untimed outside the loop — the
    // loop itself is pure timing). fullDigest for verify-parity.mjs.
    const digest = await pbkdf2Sha256Hex(PASSWORD, SALT_16, iter, keyLen);
    return {
      samples,
      meta: { digestPrefix: digest.slice(0, 16), digestFull: fullDigest ? digest : null, iter, keyLen },
    };
  },

  async "bcrypt-hash"({ costFactor, count, warmup, fullDigest = false }) {
    for (let i = 0; i < warmup; i++) {
      await bcrypt({ password: PASSWORD, salt: SALT_16, costFactor });
    }
    const samples = [];
    let firstHash = null;
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      const h = await bcrypt({ password: PASSWORD, salt: SALT_16, costFactor });
      samples.push(performance.now() - t0);
      if (firstHash === null) firstHash = h;
    }
    return {
      samples,
      meta: {
        hashPrefix: firstHash.slice(0, 29),
        hashFull: fullDigest ? firstHash : null,
        costFactor,
      },
    };
  },

  async "bcrypt-verify"({ costFactor, count, warmup }) {
    const hash = await bcrypt({ password: PASSWORD, salt: SALT_16, costFactor });
    for (let i = 0; i < warmup; i++) await bcryptVerify({ password: PASSWORD, hash });
    const samples = [];
    let ok = null;
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      ok = await bcryptVerify({ password: PASSWORD, hash });
      samples.push(performance.now() - t0);
    }
    const wrong = await bcryptVerify({ password: PASSWORD + "-wrong", hash });
    return { samples, meta: { verifyOk: ok, verifyWrongPwFalse: wrong === false, costFactor } };
  },

  async scrypt({ N, r, p, keyLen = 50, maxmemBytes = null, count, warmup, fullDigest = false }) {
    // node:crypto under nodejs_compat — dynamic import keeps this worker
    // loadable in the flags-free isolate too (the scrypt arm runs in its
    // own nodejs_compat worker; the product currently ships WITHOUT the
    // flag — wrangler.jsonc has no compatibility_flags entry).
    const { scryptSync } = await import("node:crypto");
    const opts = maxmemBytes === null ? { N, r, p } : { N, r, p, maxmem: maxmemBytes };
    for (let i = 0; i < warmup; i++) scryptSync(PASSWORD, SALT_16, keyLen, opts);
    const samples = [];
    let digest = null;
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      const buf = scryptSync(PASSWORD, SALT_16, keyLen, opts);
      samples.push(performance.now() - t0);
      if (digest === null) digest = bytesToHex(buf);
    }
    return {
      samples,
      meta: {
        N, r, p, maxmemBytes,
        memApproxMiB: round2((128 * N * r) / 2 ** 20),
        digestPrefix: digest.slice(0, 16),
        digestFull: fullDigest ? digest : null,
      },
    };
  },

  async argon2({ time, memoryKiB, parallelism, keyLen = 50, count, warmup, fullDigest = false }) {
    for (let i = 0; i < warmup; i++) {
      await argon2id({
        password: PASSWORD,
        salt: SALT_16,
        parallelism,
        iterations: time,
        memorySize: memoryKiB,
        hashLength: keyLen,
        outputType: "hex",
      });
    }
    const samples = [];
    let digest = null;
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      const hex = await argon2id({
        password: PASSWORD,
        salt: SALT_16,
        parallelism,
        iterations: time,
        memorySize: memoryKiB,
        hashLength: keyLen,
        outputType: "hex",
      });
      samples.push(performance.now() - t0);
      if (digest === null) digest = hex;
    }
    return {
      samples,
      meta: {
        time, memoryKiB, parallelism,
        approxMiB: round2(memoryKiB / 1024),
        digestPrefix: digest.slice(0, 16),
        digestFull: fullDigest ? digest : null,
      },
    };
  },
};

const round2 = (x) => Math.round(x * 100) / 100;

// NOTE: no non-handler exports here — workerd treats every entry-module
// export as a potential handler and rejects non-function values.

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("POST only\n", { status: 405 });
    }
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return Response.json({ ok: false, error: `bad json: ${e.message}` }, { status: 400 });
    }
    const { op, params = {}, count = 1, warmup = 0 } = body;
    const fn = OPS[op];
    if (!fn) {
      return Response.json({ ok: false, error: `unknown op ${op}` }, { status: 400 });
    }
    try {
      const result = await fn({ ...params, count, warmup });
      return Response.json({ ok: true, op, ...result });
    } catch (e) {
      // OOM / iteration-cap / allocation failures land here with workerd's
      // own message — the report quotes these verbatim.
      return Response.json(
        { ok: false, op, error: String(e.message || e).slice(0, 500) },
        { status: 500 },
      );
    }
  },
};
