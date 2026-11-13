/**
 * Password hash WASM arms — census B-86 (argon2id + bcrypt VERIFY).
 *
 * Mirrors upstream at pin v29.0.0-dev-208-gfc493688:
 * - modules/auth/password/hash/argon2.go:38-42   hex(argon2.IDKey(pw, saltBytes, time, memory, threads, keyLen)) — the ID (argon2id) variant
 * - modules/auth/password/hash/bcrypt.go:30-32   the SPECIALIZED verifier: bcrypt.CompareHashAndPassword(hashedPassword, password) —
 *     the stored passwd column IS the full modular-crypt string "$2a$<cost>$<22><31>", which carries its own
 *     cost + salt; the users.salt column is UNUSED on this arm (hash.go:66's PasswordVerifier override)
 *
 * PLATFORM SHAPE (docs/research/hash-bench-phase-b.md §5.1, PWD-3): workerd
 * hard-blocks DYNAMIC wasm compilation (WebAssembly.compile(bytes) fails with
 * "Wasm code generation disallowed by embedder", no compatibility flag). The
 * only supported shape is a STATICALLY IMPORTED .wasm module — bundled as a
 * CompiledWasm module (wrangler's DEFAULT module rule maps every .wasm path),
 * the import yields the precompiled WebAssembly.Module, and instantiate(module)
 * accepts it. The binaries under ./vendor/ are byte-identical to what
 * hash-wasm@4.12.0 ships (see ./vendor/PROVENANCE.txt for the SHA256 chain
 * and the full upstream record at scripts/hash-bench/vendor/hash-wasm/).
 *
 * ADAPTED WRAPPER, NOT COPIED: hash-wasm's own JS loader cannot run here (it
 * embeds the binaries as base64 and calls the blocked WebAssembly.compile),
 * so the wrapper logic those functions carry was re-shaped into this module
 * against the SAME wasm call contracts:
 * - argon2.wasm:  memory + Hash_SetMemorySize(totalBytes) + Hash_GetBuffer()
 *                 + Hash_Calculate(inputLen, initParam, digestParam)
 * - bcrypt.wasm:  memory + Hash_GetBuffer() + bcrypt_verify(passwordLen)
 *                 (the 60-char crypt string at buffer offset 0, the password
 *                 at offset 60)
 * - blake2b.wasm: memory + Hash_GetBuffer() + Hash_Init(bits) +
 *                 Hash_Update(chunkLen) + Hash_Final(padding)
 * validated by the Phase-B benchmark and re-proven here by the Go-generated
 * known-answer fixtures in password-wasm-fixtures.json (password.test.ts).
 *
 * CONCURRENCY INVARIANT: workerd isolates are single-threaded and EVERY call
 * into this module is SYNCHRONOUS (instantiation included — the sync
 * `new WebAssembly.Instance(precompiledModule, {})` constructor), so a verify
 * runs to completion without yielding: it is atomic with respect to every
 * other request in the same isolate, and the shared wasm heaps can never
 * interleave. (Note: `WebAssembly.instantiate(module)` — the hash-wasm
 * wrapper's own instantiation shape — resolves to an EMPTY object under the
 * vitest plugin's workerd pipeline, so the sync constructor is also the
 * pipeline-proven path.)
 */

import argon2Wasm from "./vendor/argon2.wasm";
import blake2bWasm from "./vendor/blake2b.wasm";
import bcryptWasm from "./vendor/bcrypt.wasm";

/** hash-wasm's per-instance I/O scratch area (its MAX_HEAP): the wasm's
 * Hash_GetBuffer() offset + this bound is the region the wrapper reads and
 * writes through. */
const MAX_IO_BYTES = 16 * 1024;

/** The argon2 block-size constants the wasm contract is written against
 * (argon2 spec: 1024-byte blocks; the wasm fills memorySize/1024 blocks and
 * leaves the final XORed block at the buffer base). */
const ARGON2_BLOCK_BYTES = 1024;

/** Export surface of the three hash-wasm binaries this module drives
 * (introspected: `WebAssembly.Module.exports` — see PROVENANCE.txt). */
interface Argon2WasmExports {
  readonly memory: WebAssembly.Memory;
  Hash_SetMemorySize(totalBytes: number): void;
  Hash_GetBuffer(): number;
  Hash_Calculate(inputLength: number, initParam: number, digestParam: number): void;
}

interface BcryptWasmExports {
  readonly memory: WebAssembly.Memory;
  Hash_GetBuffer(): number;
  /** Non-zero when the password matches the crypt string in linear memory. */
  bcrypt_verify(passwordLength: number): number;
}

interface Blake2bWasmExports {
  readonly memory: WebAssembly.Memory;
  Hash_GetBuffer(): number;
  /** `bits` is the digest size in bits (8..512, unkeyed here). */
  Hash_Init(bits: number): void;
  /** Consumes `chunkLength` bytes previously written at the buffer offset. */
  Hash_Update(chunkLength: number): void;
  /** Writes the digest (Hash_Init's bits / 8 bytes) at the buffer offset. */
  Hash_Final(padding: number): void;
}

let blake2bExports: Blake2bWasmExports | null = null;

/**
 * Runtime-checked export readers. The generated `WebAssembly.Exports` is
 * `Record<string, ExportValue>` (workers-types keeps `Instance` non-generic),
 * and blind casts off it are exactly the `as unknown as` force AGENTS.md
 * forbids — so every member is read, existence- and typeof-checked, and only
 * then narrowed (a corrupt/mis-generated binary fails LOUDLY here instead of
 * trapping mid-verify).
 */
function fnOf<F>(exports: WebAssembly.Exports, binary: string, name: string): F {
  const value = exports[name];
  if (typeof value !== "function") {
    throw new Error(`password wasm: binary "${binary}" is missing the "${name}" function export`);
  }
  return value as F;
}

function memoryOf(exports: WebAssembly.Exports, binary: string): WebAssembly.Memory {
  const value = exports["memory"];
  if (!(value instanceof WebAssembly.Memory)) {
    throw new Error(`password wasm: binary "${binary}" is missing the "memory" export`);
  }
  return value;
}

function argon2ExportsOf(instance: WebAssembly.Instance): Argon2WasmExports {
  const e = instance.exports;
  return {
    memory: memoryOf(e, "argon2"),
    Hash_SetMemorySize: fnOf<(totalBytes: number) => void>(e, "argon2", "Hash_SetMemorySize"),
    Hash_GetBuffer: fnOf<() => number>(e, "argon2", "Hash_GetBuffer"),
    Hash_Calculate: fnOf<(inputLength: number, initParam: number, digestParam: number) => void>(
      e,
      "argon2",
      "Hash_Calculate",
    ),
  };
}

function bcryptExportsOf(instance: WebAssembly.Instance): BcryptWasmExports {
  const e = instance.exports;
  return {
    memory: memoryOf(e, "bcrypt"),
    Hash_GetBuffer: fnOf<() => number>(e, "bcrypt", "Hash_GetBuffer"),
    bcrypt_verify: fnOf<(passwordLength: number) => number>(e, "bcrypt", "bcrypt_verify"),
  };
}

function blake2bExportsOf(instance: WebAssembly.Instance): Blake2bWasmExports {
  const e = instance.exports;
  return {
    memory: memoryOf(e, "blake2b"),
    Hash_GetBuffer: fnOf<() => number>(e, "blake2b", "Hash_GetBuffer"),
    Hash_Init: fnOf<(bits: number) => void>(e, "blake2b", "Hash_Init"),
    Hash_Update: fnOf<(chunkLength: number) => void>(e, "blake2b", "Hash_Update"),
    Hash_Final: fnOf<(padding: number) => void>(e, "blake2b", "Hash_Final"),
  };
}

/**
 * The hash-wasm WASMInterface setupInterface touch: each freshly
 * instantiated wasm heap must see ONE Hash_GetBuffer() call before any other
 * function — it is what moves the internal heap pointer to the buffer base
 * (131072 on the argon2 binary; without it the pointer stays 0 and
 * Hash_SetMemorySize leaves the wasm's notion of its heap inconsistent —
 * the next Hash_Calculate traps "memory access out of bounds"). Calls into
 * these binaries MUST be preceded by this touch (per instance).
 */
function setupTouch(exports: { Hash_GetBuffer(): number }): void {
  exports.Hash_GetBuffer();
}

/**
 * Lazily instantiate the reused instance (blake2b) — SYNCHRONOUS (the sync
 * Instance constructor over a statically imported CompiledWasm module; see
 * the concurrency invariant above). Called before any compute section; a
 * no-op after the first use per isolate. The argon2 and bcrypt instances
 * are NOT kept here: hash-wasm's wrapper creates a fresh instance per
 * call for BOTH (WASMInterface inside argon2Internal/bcryptInternal), and
 * the bcrypt binary is empirically stateful across bcrypt_verify calls on
 * the same instance (the second verify reads a stale heap state and
 * returns false) — per-call instances are the proven shape.
 */
export function ensurePasswordWasm(): void {
  if (blake2bExports === null) {
    blake2bExports = blake2bExportsOf(new WebAssembly.Instance(blake2bWasm, {}));
    setupTouch(blake2bExports);
  }
}

/** Fresh linear-memory view (re-fetched per use: buffer identity is not
 * stable across potential grows). */
function memoryView(memory: WebAssembly.Memory): Uint8Array {
  return new Uint8Array(memory.buffer);
}

/** int32 little-endian scratch (hash-wasm's shared uint32View shape). */
const int32Scratch = new DataView(new ArrayBuffer(4));
function int32LE(value: number): Uint8Array {
  int32Scratch.setInt32(0, value, true);
  return new Uint8Array(int32Scratch.buffer);
}

/** blake2b streaming helpers (unkeyed): init / update / final. */
function blake2bInit(exports: Blake2bWasmExports, bits: number): void {
  exports.Hash_Init(bits);
}

function blake2bUpdate(exports: Blake2bWasmExports, data: Uint8Array): void {
  const view = memoryView(exports.memory);
  let read = 0;
  while (read < data.length) {
    const chunk = data.subarray(read, read + MAX_IO_BYTES);
    read += chunk.length;
    view.set(chunk, exports.Hash_GetBuffer());
    exports.Hash_Update(chunk.length);
  }
}

function blake2bFinal(exports: Blake2bWasmExports, digestBytes: number): Uint8Array {
  exports.Hash_Final(0);
  const offset = exports.Hash_GetBuffer();
  return memoryView(exports.memory).slice(offset, offset + digestBytes);
}

/**
 * The argon2 variable-length hash function H' (RFC 9106 §3.3), ported from
 * hash-wasm's hashFunc: unkeyed blake2b at `outLen * 8` bits for outLen ≤ 64,
 * the blake2b-512 V-chain expansion otherwise.
 */
function argon2HashPrime(blake2b: Blake2bWasmExports, input: Uint8Array, outLen: number): Uint8Array {
  if (outLen <= 64) {
    blake2bInit(blake2b, outLen * 8);
    blake2bUpdate(blake2b, int32LE(outLen));
    blake2bUpdate(blake2b, input);
    return blake2bFinal(blake2b, outLen);
  }
  const rounds = Math.ceil(outLen / 32) - 2;
  const out = new Uint8Array(outLen);
  blake2bInit(blake2b, 512);
  blake2bUpdate(blake2b, int32LE(outLen));
  blake2bUpdate(blake2b, input);
  let block = blake2bFinal(blake2b, 64);
  out.set(block.subarray(0, 32), 0);
  for (let i = 1; i < rounds; i++) {
    blake2bInit(blake2b, 512);
    blake2bUpdate(blake2b, block);
    block = blake2bFinal(blake2b, 64);
    out.set(block.subarray(0, 32), i * 32);
  }
  const partialBytes = outLen - 32 * rounds;
  blake2bInit(blake2b, partialBytes === 64 ? 512 : partialBytes * 8);
  blake2bUpdate(blake2b, block);
  block = blake2bFinal(blake2b, partialBytes === 64 ? 64 : partialBytes);
  out.set(block.subarray(0, partialBytes), rounds * 32);
  return out;
}

/** Parameters for one argon2id derivation (the stored spec's four uints). */
export interface Argon2idParams {
  time: number;
  memoryKiB: number;
  threads: number;
  keyLen: number;
}

/**
 * argon2id(passwordBytes, saltBytes, params) → the raw tag (caller hex-encodes).
 *
 * Byte-for-byte port of hash-wasm's argon2Internal for hashType "id" (the
 * type code 2), version 0x13 — the shape upstream's argon2.IDKey computes
 * (RFC 9106). Fully synchronous; the caller has run ensurePasswordWasm()
 * first.
 *
 * Divergences from hash-wasm's own option validation are deliberate Go-parity
 * choices: no minimum salt length (x/crypto/argon2 validates nothing — the
 * stored salts are 16-byte GetUserSalt output or the 10-byte legacy era) and
 * no minimum password length (IDKey("") is computable; empty rows never
 * reach verify via isPasswordSet anyway). Structural param validity is
 * enforced at PARSE time (password.ts), ahead of this module.
 */
export function argon2idBytes(
  passwordBytes: Uint8Array,
  saltBytes: Uint8Array,
  params: Argon2idParams,
): Uint8Array {
  const blake2b = blake2bExports;
  if (blake2b === null) {
    throw new Error("password wasm not initialized — call ensurePasswordWasm() first");
  }
  // Fresh instance per derivation (see ensurePasswordWasm's note) + the
  // setupInterface touch before Hash_SetMemorySize (the heap-pointer
  // invariant in setupTouch's comment).
  const argon2 = argon2ExportsOf(new WebAssembly.Instance(argon2Wasm, {}));
  setupTouch(argon2);

  const totalBytes = params.memoryKiB * ARGON2_BLOCK_BYTES + ARGON2_BLOCK_BYTES;
  argon2.Hash_SetMemorySize(totalBytes);
  const baseOffset = argon2.Hash_GetBuffer();

  // The 24-byte init vector the wasm reads at memorySize * 1024: six int32
  // LE fields [parallelism, keyLen, memoryKiB, time, version=0x13, type=2].
  const initVector = new Uint8Array(24);
  const initVectorView = new DataView(initVector.buffer);
  initVectorView.setInt32(0, params.threads, true);
  initVectorView.setInt32(4, params.keyLen, true);
  initVectorView.setInt32(8, params.memoryKiB, true);
  initVectorView.setInt32(12, params.time, true);
  initVectorView.setInt32(16, 0x13, true);
  initVectorView.setInt32(20, 2, true); // hashType "id" (getHashType default)
  memoryView(argon2.memory).set(initVector, baseOffset + params.memoryKiB * ARGON2_BLOCK_BYTES);

  // H0 = blake2b-512(IV || LE32(|P|) || P || LE32(|S|) || S || LE32(0) || LE32(0))
  // (no secret, no associated data — Gitea stores neither).
  blake2bInit(blake2b, 512);
  blake2bUpdate(blake2b, initVector);
  blake2bUpdate(blake2b, int32LE(passwordBytes.length));
  blake2bUpdate(blake2b, passwordBytes);
  blake2bUpdate(blake2b, int32LE(saltBytes.length));
  blake2bUpdate(blake2b, saltBytes);
  blake2bUpdate(blake2b, int32LE(0)); // secret length (empty secret)
  blake2bUpdate(blake2b, int32LE(0)); // associated-data length (empty)
  const h0 = blake2bFinal(blake2b, 64);

  // Seed each lane's first two blocks (H' expansions of H0 || LE32(0|1) || lane).
  const laneBlocks = Math.floor(params.memoryKiB / (params.threads * 4)) * 4;
  const param = new Uint8Array(72);
  param.set(h0, 0);
  for (let lane = 0; lane < params.threads; lane++) {
    param.set(int32LE(0), 64);
    param.set(int32LE(lane), 68);
    const view = memoryView(argon2.memory);
    view.set(argon2HashPrime(blake2b, param, ARGON2_BLOCK_BYTES), baseOffset + lane * laneBlocks * ARGON2_BLOCK_BYTES);
    param.set(int32LE(1), 64);
    view.set(
      argon2HashPrime(blake2b, param, ARGON2_BLOCK_BYTES),
      baseOffset + (lane * laneBlocks + 1) * ARGON2_BLOCK_BYTES,
    );
  }

  // The wasm fills the remaining blocks and leaves the XORed final block at
  // the buffer base; the tag is H' over that 1024-byte block.
  argon2.Hash_Calculate(0, params.memoryKiB, 0);
  const finalBlock = memoryView(argon2.memory).slice(baseOffset, baseOffset + ARGON2_BLOCK_BYTES);
  return argon2HashPrime(blake2b, finalBlock, params.keyLen);
}

/**
 * bcrypt verify — bcrypt.go:30-32's specialized arm: the 60-char modular
 * crypt string (in `hashedPassword`, the passwd COLUMN VALUE) carries its own
 * cost + salt; the users.salt column is never consulted.
 *
 * Every malformed / short / out-of-range-cost hash returns false — the exact
 * mapping of upstream CompareHashAndPassword's error returns
 * (ErrHashTooShort, InvalidHashPrefixError, HashVersionTooNewError,
 * InvalidCostError → failed login). The acceptance regex + cost window is
 * hash-wasm's validateHashCharacters (the PROVENANCE-validated pre-wasm
 * guard): version tags $2a$/$2b$/$2x$/$2y$ (the real crypt_blowfish family;
 * Go's decodeVersion never branches on the minor byte, so every tag Go
 * verifies is covered), cost 04..31.
 *
 * Passwords above 72 bytes are truncated to 72 before the wasm call — Go's
 * comparison copies the password into a 72-byte buffer (bcrypt.go
 * cipherData), i.e. only the first 72 bytes ever matter, and 72 is the
 * envelope the binary was PROVEN under (hash-wasm rejects above it; a throw
 * here would diverge from upstream's compare semantics).
 */
export function bcryptVerifyCrypt(passwordBytes: Uint8Array, hashedPassword: string): boolean {
  if (!/^\$2[axyb]\$[0-3][0-9]\$[./A-Za-z0-9]{53}$/.test(hashedPassword)) {
    return false;
  }
  if (hashedPassword[4] === "0" && Number(hashedPassword[5]) < 4) {
    return false; // costs 00..03 are outside bcrypt's legal window
  }
  if (hashedPassword[4] === "3" && Number(hashedPassword[5]) > 1) {
    return false; // costs 32..39 ditto
  }
  // Fresh instance per verify + the setupInterface touch (see the
  // statefulness note on ensurePasswordWasm).
  const bcrypt = bcryptExportsOf(new WebAssembly.Instance(bcryptWasm, {}));
  setupTouch(bcrypt);
  const truncated = passwordBytes.length > 72 ? passwordBytes.slice(0, 72) : passwordBytes;
  const offset = bcrypt.Hash_GetBuffer();
  const view = memoryView(bcrypt.memory);
  view.set(new TextEncoder().encode(hashedPassword), offset);
  view.set(truncated, offset + 60);
  return bcrypt.bcrypt_verify(truncated.length) !== 0;
}
