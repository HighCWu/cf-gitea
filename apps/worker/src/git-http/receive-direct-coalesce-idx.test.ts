import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  clearIdxV2Cache,
  coalescePackRanges,
  COALESCE_GAP_BYTES,
  COALESCE_MAX_WINDOW_BYTES,
  createDurableGit,
  loadPackIdxV2,
  lookupOidsInPackIdxs,
  parseIdxV2,
  R2_PUSH_PART_SIZE,
} from "@cf-gitea/git-engine";
import { checkRepoInvariants } from "../invariants/check";
import { buildPack, buildReceivePackBody } from "../repos/testing/git-pack";

const enc = new TextEncoder();
const dec = new TextDecoder();
const RECEIVE_CT = "application/x-git-receive-pack-request";
const UPLOAD_CT = "application/x-git-upload-pack-request";
const NOOP_CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function engine() {
  return createDurableGit<Env>({ authorize: () => true, ui: false, namespaces: true });
}

function directEnv(extra: Partial<Env> = {}): Env {
  return {
    ...env,
    RECEIVE_DIRECT_PACK_WRITE: "true",
    UPLOAD_PACK_WORKER_STREAM: "true",
    ...extra,
  };
}

function concatU8(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function pkt(payload: string): Uint8Array {
  const body = enc.encode(payload);
  return concatU8([enc.encode((body.length + 4).toString(16).padStart(4, "0")), body]);
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function rawOid(oidHex: string): Uint8Array {
  const out = new Uint8Array(20);
  for (let i = 0; i < 20; i++) out[i] = parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return out;
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

function buildLiteralDelta(baseLen: number, target: Uint8Array): Uint8Array {
  const header: number[] = [];
  const pushVarint = (v: number) => {
    let n = v;
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n > 0) b |= 0x80;
      header.push(b);
    } while (n > 0);
  };
  pushVarint(baseLen);
  pushVarint(target.length);
  const ops: number[] = [];
  for (let off = 0; off < target.length; off += 127) {
    const chunk = target.subarray(off, off + 127);
    ops.push(chunk.length);
    for (const byte of chunk) ops.push(byte);
  }
  return concatU8([new Uint8Array(header), new Uint8Array(ops)]);
}

async function captureLogs(fn: () => Promise<void>, repo: string): Promise<string[]> {
  const captured: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    const line = args.map((a) => String(a)).join(" ");
    if (line.includes(repo)) captured.push(line);
    orig(...args);
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return captured;
}

/** Construct a valid synthetic `.idx` v2 buffer (including 64-bit large-offset entries). */
async function buildSyntheticIdxV2(
  entries: Array<{ oid: string; offset: number; crc32: number }>,
  packSha1: string,
): Promise<Uint8Array> {
  const sorted = [...entries].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const fanout = new Uint32Array(256);
  for (const e of sorted) {
    const bucket = parseInt(e.oid.slice(0, 2), 16);
    fanout[bucket] = (fanout[bucket] ?? 0) + 1;
  }
  for (let i = 1; i < 256; i++) {
    fanout[i] = (fanout[i] ?? 0) + (fanout[i - 1] ?? 0);
  }

  const largeOffsets: number[] = [];
  const offWords = new Uint32Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    const off = sorted[i]!.offset;
    if (off >= 0x80000000) {
      offWords[i] = (0x80000000 | largeOffsets.length) >>> 0;
      largeOffsets.push(off);
    } else {
      offWords[i] = off >>> 0;
    }
  }

  const bodyLen = 8 + 1024 + sorted.length * 28 + largeOffsets.length * 8 + 20;
  const out = new Uint8Array(bodyLen + 20);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0xff744f63, false);
  dv.setUint32(4, 2, false);
  let p = 8;
  for (let i = 0; i < 256; i++) {
    dv.setUint32(p, fanout[i]!, false);
    p += 4;
  }
  for (const e of sorted) {
    out.set(rawOid(e.oid), p);
    p += 20;
  }
  for (const e of sorted) {
    dv.setUint32(p, e.crc32 >>> 0, false);
    p += 4;
  }
  for (let i = 0; i < sorted.length; i++) {
    dv.setUint32(p, offWords[i]!, false);
    p += 4;
  }
  for (const big of largeOffsets) {
    dv.setUint32(p, Math.floor(big / 0x100000000), false);
    dv.setUint32(p + 4, big >>> 0, false);
    p += 8;
  }
  out.set(rawOid(packSha1), p);
  p += 20;
  const sum = new Uint8Array(await crypto.subtle.digest("SHA-1", out.subarray(0, p)));
  out.set(sum, p);
  return out;
}

describe("SPEC-0024 M4.2 direct pack write, range coalescing & .idx v2 reader", () => {
  it("streams pushes directly to packs/pack-rx-<lease>.* with zero staging writes or copyObject, passes invariants, and sweeps aborted direct writes", async () => {
    expect(R2_PUSH_PART_SIZE).toBe(64 * 1024 * 1024);

    const h = engine();
    const repo = `m42/direct-${crypto.randomUUID().slice(0, 8)}`;
    const targetEnv = directEnv();
    const { oid, pack } = await buildPack();

    const logs = await captureLogs(async () => {
      const res = await h.fetch(
        new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
          method: "POST",
          headers: { "content-type": RECEIVE_CT },
          body: buildReceivePackBody([{ ref: "refs/heads/main", oid }], pack),
        }),
        targetEnv,
        NOOP_CTX,
      );
      expect(res.status).toBe(200);
      const text = dec.decode(new Uint8Array(await res.arrayBuffer()));
      expect(text).toContain("unpack ok");
      expect(text).toContain("ok refs/heads/main");
    }, repo);

    const metricLine = logs.find((l) => l.includes("subrequests:"));
    expect(metricLine).toBeDefined();
    expect(metricLine!).toContain("copies=0");

    // Verify no staging/ objects remain and pack-rx-<lease>.pack + .idx exist in packs/.
    const stagingListed = await env.REPO_PACKS.list({ prefix: `repos/${repo}/staging/` });
    expect(stagingListed.objects.length).toBe(0);
    const packsListed = await env.REPO_PACKS.list({ prefix: `repos/${repo}/packs/` });
    const packKeys = packsListed.objects.map((o) => o.key);
    expect(packKeys.some((k) => /\/packs\/pack-rx-[0-9a-f]{32}\.pack$/.test(k))).toBe(true);
    expect(packKeys.some((k) => /\/packs\/pack-rx-[0-9a-f]{32}\.idx$/.test(k))).toBe(true);

    // Clone succeeds against the direct-written pack.
    const cloneRes = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": UPLOAD_CT, "git-protocol": "version=2" },
        body: concatU8([
          pkt("command=fetch\n"),
          pkt("agent=git/2.43.0\n"),
          enc.encode("0001"),
          pkt(`want ${oid}\n`),
          pkt("done\n"),
          enc.encode("0000"),
        ]),
      }),
      targetEnv,
      NOOP_CTX,
    );
    expect(cloneRes.status).toBe(200);
    expect(new Uint8Array(await cloneRes.arrayBuffer()).length).toBeGreaterThan(32);

    // Invariants checker accepts the committed direct pack with 0 violations.
    const invReport = await checkRepoInvariants(targetEnv, { engineName: repo, storageKey: repo });
    expect(invReport.ok).toBe(true);
    expect(invReport.violations).toEqual([]);

    // Corrupt direct-write push (bad pack checksum) must sweep its uncommitted pack-rx-* object from packs/.
    const corruptPack = pack.slice();
    const lastIdx = corruptPack.length - 1;
    corruptPack[lastIdx] = (corruptPack[lastIdx] ?? 0) ^ 0xff;
    const fakeCommit = "a".repeat(40);
    const badRes = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": RECEIVE_CT },
        body: concatU8([
          pkt(`${oid} ${fakeCommit} refs/heads/main\0report-status side-band-64k\n`),
          enc.encode("0000"),
          corruptPack,
        ]),
      }),
      targetEnv,
      NOOP_CTX,
    );
    expect(badRes.status).toBe(200);
    const badText = dec.decode(new Uint8Array(await badRes.arrayBuffer()));
    expect(badText).toContain("pack checksum mismatch");

    const afterListed = await env.REPO_PACKS.list({ prefix: `repos/${repo}/packs/` });
    const afterPackFiles = afterListed.objects.filter((o) => o.key.endsWith(".pack"));
    expect(afterPackFiles.length).toBe(1);
  });

  it("coalesces adjacent pack range reads by gap/window and resolves 8 multi-blob thin bases with 1 R2 Range GET", async () => {
    expect(COALESCE_GAP_BYTES).toBe(256 * 1024);
    expect(COALESCE_MAX_WINDOW_BYTES).toBe(4 * 1024 * 1024);

    // Unit check: gap <= 256 KiB merges, gap > 256 KiB splits, window > 4 MiB splits, disjoint packs stay separate.
    const merged = coalescePackRanges([
      { oid: "o1", packKey: "pA", dataOff: 100, dataLen: 1000 },
      { oid: "o2", packKey: "pA", dataOff: 2000, dataLen: 1000 },
      { oid: "o3", packKey: "pA", dataOff: 2000 + 1000 + 300_000, dataLen: 500 },
      { oid: "o4", packKey: "pA", dataOff: 5_000_000, dataLen: 100 },
      { oid: "o5", packKey: "pA", dataOff: 5_100_000, dataLen: 4_100_000 },
      { oid: "o6", packKey: "pB", dataOff: 50, dataLen: 200 },
    ]);
    expect(merged.map((w) => ({ pack: w.packKey, start: w.start, len: w.length, n: w.items.length }))).toEqual([
      { pack: "pA", start: 100, len: 2900, n: 2 },
      { pack: "pA", start: 303_000, len: 500, n: 1 },
      { pack: "pA", start: 5_000_000, len: 100, n: 1 },
      { pack: "pA", start: 5_100_000, len: 4_100_000, n: 1 },
      { pack: "pB", start: 50, len: 200, n: 1 },
    ]);

    // End-to-end thin push referencing 8 distinct external base blobs in one pack -> coalesces to rangeGets=1.
    const h = engine();
    const repo = `m42/coalesce-${crypto.randomUUID().slice(0, 8)}`;
    const targetEnv = directEnv();

    const baseBlobs = Array.from({ length: 8 }, (_, i) => enc.encode(`base blob #${i} payload content\n`));
    const baseBlobOids = await Promise.all(
      baseBlobs.map((b) => sha1Hex(concatU8([enc.encode(`blob ${b.length}\0`), b]))),
    );
    const treeEntries1 = baseBlobOids
      .map((oid, i) => ({ name: `f${i}.txt`, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const tree1Body = concatU8(treeEntries1.map((e) => concatU8([enc.encode(`100644 ${e.name}\0`), rawOid(e.oid)])));
    const tree1Oid = await sha1Hex(concatU8([enc.encode(`tree ${tree1Body.length}\0`), tree1Body]));
    const commit1Body = enc.encode(
      `tree ${tree1Oid}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nc1\n`,
    );
    const commit1Oid = await sha1Hex(concatU8([enc.encode(`commit ${commit1Body.length}\0`), commit1Body]));

    const pack1Parts: Uint8Array[] = [enc.encode("PACK"), be32(2), be32(10)];
    for (const b of baseBlobs) {
      pack1Parts.push(objectHeader(3, b.length), await zlibDeflate(b));
    }
    pack1Parts.push(objectHeader(2, tree1Body.length), await zlibDeflate(tree1Body));
    pack1Parts.push(objectHeader(1, commit1Body.length), await zlibDeflate(commit1Body));
    pack1Parts.push(rawOid(await sha1Hex(concatU8(pack1Parts))));

    const res1 = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": RECEIVE_CT },
        body: buildReceivePackBody([{ ref: "refs/heads/main", oid: commit1Oid }], concatU8(pack1Parts)),
      }),
      targetEnv,
      NOOP_CTX,
    );
    expect(res1.status).toBe(200);
    expect(dec.decode(new Uint8Array(await res1.arrayBuffer()))).toContain("unpack ok");

    const updatedBlobs = baseBlobs.map((b, i) => concatU8([b, enc.encode(`delta v2 #${i}\n`)]));
    const updatedOids = await Promise.all(
      updatedBlobs.map((b) => sha1Hex(concatU8([enc.encode(`blob ${b.length}\0`), b]))),
    );
    const treeEntries2 = updatedOids
      .map((oid, i) => ({ name: `f${i}.txt`, oid }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    const tree2Body = concatU8(treeEntries2.map((e) => concatU8([enc.encode(`100644 ${e.name}\0`), rawOid(e.oid)])));
    const tree2Oid = await sha1Hex(concatU8([enc.encode(`tree ${tree2Body.length}\0`), tree2Body]));
    const commit2Body = enc.encode(
      `tree ${tree2Oid}\nparent ${commit1Oid}\nauthor A <a@b> 2 +0000\ncommitter A <a@b> 2 +0000\n\nc2\n`,
    );
    const commit2Oid = await sha1Hex(concatU8([enc.encode(`commit ${commit2Body.length}\0`), commit2Body]));

    const pack2Parts: Uint8Array[] = [enc.encode("PACK"), be32(2), be32(10)];
    for (let i = 0; i < 8; i++) {
      const delta = buildLiteralDelta(baseBlobs[i]!.length, updatedBlobs[i]!);
      pack2Parts.push(objectHeader(7, delta.length), rawOid(baseBlobOids[i]!), await zlibDeflate(delta));
    }
    pack2Parts.push(objectHeader(2, tree2Body.length), await zlibDeflate(tree2Body));
    pack2Parts.push(objectHeader(1, commit2Body.length), await zlibDeflate(commit2Body));
    pack2Parts.push(rawOid(await sha1Hex(concatU8(pack2Parts))));

    const logs = await captureLogs(async () => {
      const res2 = await h.fetch(
        new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
          method: "POST",
          headers: { "content-type": RECEIVE_CT },
          body: concatU8([
            pkt(`${commit1Oid} ${commit2Oid} refs/heads/main\0report-status side-band-64k\n`),
            enc.encode("0000"),
            concatU8(pack2Parts),
          ]),
        }),
        targetEnv,
        NOOP_CTX,
      );
      expect(res2.status).toBe(200);
      const t = dec.decode(new Uint8Array(await res2.arrayBuffer()));
      expect(t).toContain("unpack ok");
      expect(t).toContain("ok refs/heads/main");
    }, repo);

    const metricLine = logs.find((l) => l.includes("subrequests:") && l.includes("rangeGets="));
    expect(metricLine).toBeDefined();
    expect(metricLine!).toContain("rangeGets=1");
  });

  it("parses .idx v2 including 64-bit offsets >= 2^31 and performs Worker binary-search lookup across R2 sidecars", async () => {
    clearIdxV2Cache();
    const oidA = "00".repeat(20);
    const oidB = "7f".repeat(20);
    const oidC = "ff".repeat(20);
    const packSha = "aa".repeat(20);
    const bigOffset = 0x1_2345_6789;
    const idxBytes = await buildSyntheticIdxV2(
      [
        { oid: oidC, offset: bigOffset, crc32: 0x33333333 },
        { oid: oidA, offset: 12, crc32: 0x11111111 },
        { oid: oidB, offset: 4096, crc32: 0x22222222 },
      ],
      packSha,
    );

    const parsed = parseIdxV2(idxBytes);
    expect(parsed.objectCount).toBe(3);
    expect(parsed.packSha1).toBe(packSha);
    expect(parsed.lookupOid(oidA)).toEqual({ index: 0, offset: 12, crc32: 0x11111111 });
    expect(parsed.lookupOid(oidB)).toEqual({ index: 1, offset: 4096, crc32: 0x22222222 });
    expect(parsed.lookupOid(oidC)).toEqual({ index: 2, offset: bigOffset, crc32: 0x33333333 });
    expect(parsed.lookupOid("ab".repeat(20))).toBeNull();
    expect(parsed.allSortedOids()).toEqual([oidA, oidB, oidC]);

    const key = `repos/m42-idx-test/packs/pack-rx-${"12".repeat(16)}.idx`;
    await env.REPO_PACKS.put(key, idxBytes);
    const loaded = await loadPackIdxV2(env.REPO_PACKS, key);
    expect(loaded).not.toBeNull();
    expect(loaded!.lookupOid(oidC)?.offset).toBe(bigOffset);

    const multi = await lookupOidsInPackIdxs(
      env.REPO_PACKS,
      [{ packKey: "pack-test", idxKey: key }],
      [oidB, oidC, "de".repeat(20)],
    );
    expect(multi.get(oidB)).toEqual({ packKey: "pack-test", index: 1, offset: 4096, crc32: 0x22222222 });
    expect(multi.get(oidC)).toEqual({ packKey: "pack-test", index: 2, offset: bigOffset, crc32: 0x33333333 });
    expect(multi.has("de".repeat(20))).toBe(false);
  });
});
