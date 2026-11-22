/**
 * Windowed thin-pack receive — cross-pack delta bases (the missing-delta-base
 * regression).
 *
 * A windowed incremental push lands in several receives: the first window's
 * pack is self-contained, later windows arrive as THIN packs whose REF_DELTA
 * entries are based on objects only the FIRST window stored. The resolver
 * (packages/git-engine src/receive/delta.ts) must therefore reach outside its
 * own pack for those bases — finish()'s externals pass batch-looks them up
 * through the object database, exactly the channel the connectivity
 * anti-check uses. Two arms used to fail deterministically once the window's
 * delta chains grew past the resolver's in-memory bounds:
 *   - a base whose content fits the ingest cache but whose CHAIN NODE
 *     (the delta applied on top of it) is bigger than the per-object cache
 *     bound: the next delta on that node re-materialized the chain through
 *     the in-memory index only and threw `missing delta base <oid>` for an
 *     oid the repository holds;
 *   - a base bigger than the cache's per-object bound outright: its
 *     materialized content can never stick in the cache, so the straggler
 *     fixpoint lost the externals pass's answer and threw
 *     `cannot resolve N delta object(s): missing base`.
 * Both rejects are engine-side: git's own thin-pack protocol offers no
 * client workaround (a bigger window only adds more chains), which is what
 * made windowed delivery of a large repository structurally impossible.
 *
 * Pinned here over the real git-HTTP surface (SELF.fetch, real R2 packs and
 * real engine DOs): window 1 stores a large blob; window 2 pushes a thin
 * pack — REF_DELTA on the stored blob, then an OFS_DELTA chained on that
 * node, per arm above — and must land. The pack bytes are hand-built (the
 * gitclient/local-fixture convention: the delta stream is a copy-prefix +
 * insert-literal shape; applyDelta is the engine's own parser).
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_collaborators", "repo_units", "repo_counters", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

const RECEIVE_CT = "application/x-git-receive-pack-request";

// ---------------------------------------------------------------------------
// Byte fixtures (local to this battery like the sibling push fixtures — the
// delta-entry arms these need are not part of the shared lifecycle builder).
// ---------------------------------------------------------------------------

function concatArrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha1(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", bytes));
}

async function sha1Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Deterministic pseudo-random body of `mib` MiB (deflate-resistant, so the
 *  pack entries carry real bulk like a large repository's assets). */
function bulkyBody(mib: number): Uint8Array {
  const body = new Uint8Array(mib * 1024 * 1024);
  let state = 0x12345678;
  for (let i = 0; i < body.length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    body[i] = (state >>> 16) & 0xff;
  }
  return body;
}

/** `target` = `base` with its last `tailLength` bytes replaced by a fresh
 *  pseudo-random tail (`seed` separates successive derivations) — the shared
 *  prefix is what the fixture delta stream copies. */
function derivedBody(base: Uint8Array, seed: number, tailLength: number): Uint8Array {
  const tail = new Uint8Array(tailLength);
  let state = seed;
  for (let i = 0; i < tailLength; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    tail[i] = (state >>> 16) & 0xff;
  }
  return concatArrays([base.subarray(0, base.length - tailLength), tail]);
}

function deltaVarint(n: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return new Uint8Array(bytes);
}

/** Copy-from-base opcode (offset ≤ 0xffffff, size in [1, 0xffff]). */
function copyOp(off: number, size: number): Uint8Array {
  let cmd = 0x80;
  const bytes: number[] = [];
  const offBytes = [off & 0xff, (off >>> 8) & 0xff, (off >>> 16) & 0xff];
  for (let i = 0; i < 3; i++) {
    if (offBytes[i] !== 0 || off >= 2 ** (8 * (i + 1))) {
      cmd |= 0x01 << i;
      bytes.push(offBytes[i] as number);
    }
  }
  const sizeBytes = [size & 0xff, (size >>> 8) & 0xff];
  for (let i = 0; i < 2; i++) {
    if (sizeBytes[i] !== 0 || size >= 2 ** (8 * (i + 1))) {
      cmd |= 0x10 << i;
      bytes.push(sizeBytes[i] as number);
    }
  }
  return new Uint8Array([cmd, ...bytes]);
}

/** git delta stream: copy the shared prefix, insert the rest as literals. */
function encodeDelta(base: Uint8Array, target: Uint8Array): Uint8Array {
  let keep = 0;
  const max = Math.min(base.length, target.length);
  while (keep < max && base[keep] === target[keep]) keep++;
  if (keep === 0) throw new Error("fixture delta shape needs a shared prefix");
  const tail = target.subarray(keep);
  const ops: Uint8Array[] = [];
  for (let off = 0; off < keep; off += 0xffff) {
    ops.push(copyOp(off, Math.min(keep - off, 0xffff)));
  }
  for (let i = 0; i < tail.length; i += 127) {
    const slice = tail.subarray(i, Math.min(i + 127, tail.length));
    ops.push(new Uint8Array([slice.length]), slice);
  }
  return concatArrays([deltaVarint(base.length), deltaVarint(target.length), ...ops]);
}

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

/** ofs-delta distance: git's subtract-one-per-continuation varint, decoded
 *  by the scanner as `off = (byte + 1) * 128 + next` per continuation. */
function ofsHeader(distance: number): Uint8Array {
  const bytes: number[] = [distance & 0x7f];
  let n = distance >>> 7;
  while (n > 0) {
    n -= 1;
    bytes.unshift(0x80 | (n & 0x7f));
    n >>>= 7;
  }
  return new Uint8Array(bytes);
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function rawOid(oidHex: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

async function looseOid(typeName: string, body: Uint8Array): Promise<string> {
  return sha1(concatArrays([new TextEncoder().encode(`${typeName} ${body.length}\0`), body]));
}

/** A window-1 style SELF-CONTAINED pack: one bulky blob + tree + commit. */
async function buildSelfContainedPack(
  path: string,
  body: Uint8Array,
): Promise<{ commitOid: string; blobOid: string; pack: Uint8Array }> {
  const blobOid = await looseOid("blob", body);
  const treeBody = concatArrays([new TextEncoder().encode(`100644 ${path}\0`), rawOid(blobOid)]);
  const treeOid = await looseOid("tree", treeBody);
  const time = 1700000000;
  const commitBody = new TextEncoder().encode(
    `tree ${treeOid}\n` +
      `author Test User <test@example.com> ${time} +0000\n` +
      `committer Test User <test@example.com> ${time} +0000\n\n` +
      "window 1\n",
  );
  const commitOid = await looseOid("commit", commitBody);
  const entries: { type: number; body: Uint8Array }[] = [
    { type: 3, body },
    { type: 2, body: treeBody },
    { type: 1, body: commitBody },
  ];
  const chunks: Uint8Array[] = [new TextEncoder().encode("PACK"), be32(2), be32(entries.length)];
  for (const entry of entries) {
    chunks.push(objectHeader(entry.type, entry.body.length));
    chunks.push(await zlibDeflate(entry.body));
  }
  chunks.push(await sha1Bytes(concatArrays(chunks)));
  return { commitOid, blobOid, pack: concatArrays(chunks) };
}

/**
 * A window-2 style THIN pack. `baseBody` is the exact blob a previous window
 * stored (`baseOid` names it on the wire); it is NOT among the pack's own
 * entries. Entries, in git's base-before-delta order:
 *   0. REF_DELTA base `baseOid` → `derived`  (a chain node bigger than the
 *      resolver's per-object cache bound when `derived` is several MiB)
 *   1. OFS_DELTA on entry 0 → `leaf`         (forces a chain re-
 *      materialization through the base link at fixpoint time)
 *   2. tree referencing the REF_DELTA's result oid (the connectivity anchor)
 *   3. commit on that tree
 */
async function buildThinPack(options: {
  path: string;
  baseOid: string;
  baseBody: Uint8Array;
  derived: Uint8Array;
  leaf: Uint8Array;
}): Promise<{ commitOid: string; pack: Uint8Array }> {
  const derivedOid = await looseOid("blob", options.derived);
  const treeBody = concatArrays([new TextEncoder().encode(`100644 ${options.path}\0`), rawOid(derivedOid)]);
  const treeOid = await looseOid("tree", treeBody);
  const time = 1700000001;
  const commitBody = new TextEncoder().encode(
    `tree ${treeOid}\n` +
      `author Test User <test@example.com> ${time} +0000\n` +
      `committer Test User <test@example.com> ${time} +0000\n\n` +
      "window 2 (thin)\n",
  );
  const commitOid = await looseOid("commit", commitBody);

  const rawDeltaOne = encodeDelta(options.baseBody, options.derived);
  const rawDeltaTwo = encodeDelta(options.derived, options.leaf);
  const deltaOne = await zlibDeflate(rawDeltaOne);
  const deltaTwo = await zlibDeflate(rawDeltaTwo);

  // Assembled entry by entry so the OFS_DELTA's backward distance can point
  // at entry 0 exactly (the scanner computes base = entryOffset - distance).
  // Entry headers declare the INFLATED size; byte offsets walk the compressed
  // regions.
  const entryZeroHeader = objectHeader(7, rawDeltaOne.length);
  const entryOneOffset = 12 + entryZeroHeader.length + 20 + deltaOne.length;
  const chunks: Uint8Array[] = [new TextEncoder().encode("PACK"), be32(2), be32(4)];
  chunks.push(entryZeroHeader, rawOid(options.baseOid), deltaOne);
  chunks.push(objectHeader(6, rawDeltaTwo.length), ofsHeader(entryOneOffset - 12), deltaTwo);
  chunks.push(objectHeader(2, treeBody.length), await zlibDeflate(treeBody));
  chunks.push(objectHeader(1, commitBody.length), await zlibDeflate(commitBody));
  chunks.push(await sha1Bytes(concatArrays(chunks)));
  return { commitOid, pack: concatArrays(chunks) };
}

// ---------------------------------------------------------------------------
// The windowed push flow
// ---------------------------------------------------------------------------

/** One receive over SELF: all-zero old oids (creates), `report-status` only
 *  (no side-band) so the response body is the plain status render. */
async function pushWindow(
  repoUrl: string,
  token: string,
  updates: { ref: string; oid: string }[],
  pack: Uint8Array,
): Promise<string> {
  const commandSection = updates
    .map((u, i) => {
      const payload = `0000000000000000000000000000000000000000 ${u.oid} ${u.ref}${i === 0 ? "\0report-status" : ""}`;
      return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
    })
    .join("");
  const body = concatArrays([new TextEncoder().encode(`${commandSection}0000`), pack]);
  const response = await SELF.fetch(`${repoUrl}/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
    body,
  });
  expect(response.status).toBe(200);
  return new TextDecoder().decode(await response.arrayBuffer());
}

describe("windowed thin-pack receive (cross-pack delta bases)", () => {
  it("resolves a thin chain whose node outgrew the per-object cache bound", async () => {
    const { plaintext: token } = await mintFor(
      (await seedVerifiedUser({ username: "windower" })).id,
      "thin-push",
      "write:repository",
    );
    const repoUrl = "https://test.local/windower/thin-chain.git";

    // Window 1: a 3 MiB blob the next window will delta against.
    const base = bulkyBody(3);
    const windowOne = await buildSelfContainedPack("assets/blob.bin", base);
    const first = await pushWindow(repoUrl, token, [{ ref: "refs/heads/main", oid: windowOne.commitOid }], windowOne.pack);
    expect(first).toContain("unpack ok\n");
    expect(first).toContain("ok refs/heads/main\n");

    // Window 2: a thin pack. The REF_DELTA's result (~3 MiB) is over the
    // resolver's cache-entry bound, so the OFS_DELTA chained on it must
    // re-materialize the chain node — whose base link points OUT of the pack.
    const derived = derivedBody(base, 0x9e3779b9, 64);
    const leaf = derivedBody(derived, 0xc0ffee11, 64);
    const thin = await buildThinPack({
      path: "assets/blob.bin",
      baseOid: windowOne.blobOid,
      baseBody: base,
      derived,
      leaf,
    });
    const second = await pushWindow(repoUrl, token, [{ ref: "refs/heads/topic", oid: thin.commitOid }], thin.pack);
    expect(second).toContain("unpack ok\n");
    expect(second).toContain("ok refs/heads/topic\n");
    expect(second).not.toContain("ng ");

    const refs = await env.REPO.getByName("windower/thin-chain").listRefs();
    expect(refs.refs.find((r) => r.name === "refs/heads/topic")?.target).toBe(thin.commitOid);
  });

  it("resolves an external base whose content exceeds the cache's per-object bound", async () => {
    const { plaintext: token } = await mintFor(
      (await seedVerifiedUser({ username: "windower2" })).id,
      "thin-push",
      "write:repository",
    );
    const repoUrl = "https://test.local/windower2/thin-big.git";

    // Window 1: a 5 MiB blob — over the ingest cache's per-object bound, so
    // its materialized form can never be cached between resolver passes.
    const base = bulkyBody(5);
    const windowOne = await buildSelfContainedPack("assets/big.bin", base);
    const first = await pushWindow(repoUrl, token, [{ ref: "refs/heads/main", oid: windowOne.commitOid }], windowOne.pack);
    expect(first).toContain("unpack ok\n");

    // Window 2: a single REF_DELTA against the stored blob, anchored by its
    // own commit/tree — resolvable only through a fresh object-database
    // lookup + foreign materialization at fixpoint time.
    const derived = derivedBody(base, 0x9e3779b9, 64);
    const leaf = derivedBody(derived, 0xc0ffee11, 64);
    const thin = await buildThinPack({
      path: "assets/big.bin",
      baseOid: windowOne.blobOid,
      baseBody: base,
      derived,
      leaf,
    });
    const second = await pushWindow(repoUrl, token, [{ ref: "refs/heads/topic", oid: thin.commitOid }], thin.pack);
    expect(second).toContain("unpack ok\n");
    expect(second).toContain("ok refs/heads/topic\n");
    expect(second).not.toContain("ng ");
  });
});
