import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createDurableGit,
  encodeOfsDistance,
  encodePackRefIndex,
  extractObjectRefBytes,
  parsePackRefIndex,
  prefR2Key,
  walkClosureWithPref,
} from "@cf-gitea/git-engine";
import { ZERO_OID, buildReceivePackBody } from "../repos/testing/git-pack";
import { handleRepoTasks } from "../repos/purge";

const enc = new TextEncoder();
const dec = new TextDecoder();
const RECEIVE_CT = "application/x-git-receive-pack-request";
const UPLOAD_CT = "application/x-git-upload-pack-request";
const NOOP_CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function engine() {
  return createDurableGit<Env>({ authorize: () => true, ui: false, namespaces: true });
}

function m41Env(extra: Partial<Env> = {}): Env {
  return {
    ...env,
    UPLOAD_PACK_WORKER_STREAM: "true",
    GIT_UPLOAD_KEEPALIVE_MS: "20000",
    COMPACTION_QUEUE_ENABLED: "true",
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

/** Git pack-format OFS_DELTA decoder matching builtin/unpack-objects.c. */
function decodeOfsDistance(encoded: Uint8Array): { dist: number; length: number } {
  let pos = 0;
  let c = encoded[pos++]!;
  let dist = c & 0x7f;
  while ((c & 0x80) !== 0) {
    dist += 1;
    c = encoded[pos++]!;
    dist = (dist << 7) + (c & 0x7f);
  }
  return { dist, length: pos };
}

/** Encode a minimal Git binary delta replacing `base` with `target`. */
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

async function buildFullCommitPack(opts: {
  fileName: string;
  content: string;
  message: string;
  parentOid?: string;
  time?: number;
}): Promise<{ oid: string; blobOid: string; pack: Uint8Array }> {
  const blob = enc.encode(opts.content);
  const blobOid = await sha1Hex(concatU8([enc.encode(`blob ${blob.length}\0`), blob]));
  const treeBody = concatU8([enc.encode(`100644 ${opts.fileName}\0`), rawOid(blobOid)]);
  const treeOid = await sha1Hex(concatU8([enc.encode(`tree ${treeBody.length}\0`), treeBody]));
  const time = opts.time ?? 1700000100;
  const parentLine = opts.parentOid ? `parent ${opts.parentOid}\n` : "";
  const commitBody = enc.encode(
    `tree ${treeOid}\n` +
      parentLine +
      `author Test User <test@example.com> ${time} +0000\n` +
      `committer Test User <test@example.com> ${time} +0000\n\n` +
      `${opts.message}\n`,
  );
  const commitOid = await sha1Hex(concatU8([enc.encode(`commit ${commitBody.length}\0`), commitBody]));
  const entries = [
    { type: 3, body: blob },
    { type: 2, body: treeBody },
    { type: 1, body: commitBody },
  ];
  const chunks: Uint8Array[] = [enc.encode("PACK"), be32(2), be32(entries.length)];
  for (const e of entries) {
    chunks.push(objectHeader(e.type, e.body.length));
    chunks.push(await zlibDeflate(e.body));
  }
  chunks.push(rawOid(await sha1Hex(concatU8(chunks))));
  return { oid: commitOid, blobOid, pack: concatU8(chunks) };
}

/** Build a thin pack where the blob is emitted as a REF_DELTA referencing `baseBlobOid`. */
async function buildThinDeltaCommitPack(opts: {
  fileName: string;
  baseBlobOid: string;
  baseBlobLength: number;
  content: string;
  message: string;
  parentOid: string;
  time: number;
}): Promise<{ oid: string; blobOid: string; pack: Uint8Array }> {
  const newBlob = enc.encode(opts.content);
  const blobOid = await sha1Hex(concatU8([enc.encode(`blob ${newBlob.length}\0`), newBlob]));
  const deltaBytes = buildLiteralDelta(opts.baseBlobLength, newBlob);
  const treeBody = concatU8([enc.encode(`100644 ${opts.fileName}\0`), rawOid(blobOid)]);
  const treeOid = await sha1Hex(concatU8([enc.encode(`tree ${treeBody.length}\0`), treeBody]));
  const commitBody = enc.encode(
    `tree ${treeOid}\n` +
      `parent ${opts.parentOid}\n` +
      `author Test User <test@example.com> ${opts.time} +0000\n` +
      `committer Test User <test@example.com> ${opts.time} +0000\n\n` +
      `${opts.message}\n`,
  );
  const commitOid = await sha1Hex(concatU8([enc.encode(`commit ${commitBody.length}\0`), commitBody]));

  const chunks: Uint8Array[] = [enc.encode("PACK"), be32(2), be32(3)];
  // Entry 1: REF_DELTA (type 7) over baseBlobOid
  chunks.push(objectHeader(7, deltaBytes.length), rawOid(opts.baseBlobOid), await zlibDeflate(deltaBytes));
  // Entry 2: full tree
  chunks.push(objectHeader(2, treeBody.length), await zlibDeflate(treeBody));
  // Entry 3: full commit
  chunks.push(objectHeader(1, commitBody.length), await zlibDeflate(commitBody));
  chunks.push(rawOid(await sha1Hex(concatU8(chunks))));
  return { oid: commitOid, blobOid, pack: concatU8(chunks) };
}

async function pushPack(
  handler: ReturnType<typeof engine>,
  targetEnv: Env,
  repo: string,
  ref: string,
  oldOid: string,
  newOid: string,
  pack: Uint8Array,
): Promise<void> {
  const body =
    oldOid === ZERO_OID
      ? buildReceivePackBody([{ ref, oid: newOid }], pack)
      : concatU8([pkt(`${oldOid} ${newOid} ${ref}\0report-status side-band-64k\n`), enc.encode("0000"), pack]);
  const res = await handler.fetch(
    new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
      method: "POST",
      headers: { "content-type": RECEIVE_CT },
      body,
    }),
    targetEnv,
    NOOP_CTX,
  );
  expect(res.status).toBe(200);
  const text = dec.decode(new Uint8Array(await res.arrayBuffer()));
  expect(text).toContain("unpack ok");
  expect(text).toContain(`ok ${ref}`);
}

function buildV2FetchRequest(wantOids: string[]): Uint8Array {
  return concatU8([
    pkt("command=fetch\n"),
    pkt("agent=git/2.43.0\n"),
    pkt("object-format=sha1\n"),
    enc.encode("0001"),
    ...wantOids.map((w) => pkt(`want ${w}\n`)),
    pkt("done\n"),
    enc.encode("0000"),
  ]);
}

function spyR2Bucket(
  inner: R2Bucket,
  opts?: { failKeySuffix?: string },
): { bucket: R2Bucket; gets: string[] } {
  const gets: string[] = [];
  const bucket: R2Bucket = {
    async head(key: string) {
      return inner.head(key);
    },
    get: async (key: string, options?: R2GetOptions) => {
      gets.push(key);
      return inner.get(key, options as R2GetOptions & { onlyIf?: R2Conditional });
    },
    async put(key: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) {
      if (opts?.failKeySuffix && key.endsWith(opts.failKeySuffix)) {
        throw new Error(`injected R2 write failure on ${key}`);
      }
      return inner.put(key, value, options);
    },
    async createMultipartUpload(key: string, options?: R2MultipartOptions) {
      return inner.createMultipartUpload(key, options);
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      return inner.resumeMultipartUpload(key, uploadId);
    },
    async delete(keys: string | string[]) {
      return inner.delete(keys);
    },
    async list(options?: R2ListOptions) {
      return inner.list(options);
    },
  };
  return { bucket, gets };
}

function assertPackHeader(packBytes: Uint8Array, expectedCount: number): void {
  const view = new DataView(packBytes.buffer, packBytes.byteOffset, packBytes.byteLength);
  expect(dec.decode(packBytes.subarray(0, 4))).toBe("PACK");
  expect(view.getUint32(4, false)).toBe(2);
  expect(view.getUint32(8, false)).toBe(expectedCount);
  expect(packBytes.length).toBeGreaterThanOrEqual(32);
}

describe("SPEC-0024 M4.1 Queue streaming compaction, OFS_DELTA & .pref sidecars", () => {
  it("encodes OFS_DELTA backward distances across varint boundaries identically to Git", () => {
    const boundaries = [1, 127, 128, 129, 255, 256, 16511, 16512, 16513, 1_000_000];
    for (const d of boundaries) {
      const encoded = encodeOfsDistance(d);
      const decoded = decodeOfsDistance(encoded);
      expect(decoded.length).toBe(encoded.length);
      expect(decoded.dist).toBe(d);
    }
    expect(() => encodeOfsDistance(0)).toThrow();
    expect(() => encodeOfsDistance(-5)).toThrow();
  });

  it("round-trips binary .pref sidecars and computes exact closure while skipping 160000 gitlinks", async () => {
    const blob = enc.encode("hello pref\n");
    const blobOid = await sha1Hex(concatU8([enc.encode(`blob ${blob.length}\0`), blob]));
    const gitlinkOid = "deadbeef".repeat(5);
    const treeBody = concatU8([
      enc.encode("100644 hello.txt\0"),
      rawOid(blobOid),
      enc.encode("160000 submod\0"),
      rawOid(gitlinkOid),
    ]);
    const treeOid = await sha1Hex(concatU8([enc.encode(`tree ${treeBody.length}\0`), treeBody]));
    const commitBody = enc.encode(
      `tree ${treeOid}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\n\nmsg\n`,
    );
    const commitOid = await sha1Hex(concatU8([enc.encode(`commit ${commitBody.length}\0`), commitBody]));
    const tagBody = enc.encode(
      `object ${commitOid}\ntype commit\ntag v1\ntagger A <a@b> 1 +0000\n\nrelease\n`,
    );
    const tagOid = await sha1Hex(concatU8([enc.encode(`tag ${tagBody.length}\0`), tagBody]));

    const entries = [
      { oid: blobOid, type: "blob" as const, refs: extractObjectRefBytes("blob", blob) },
      { oid: treeOid, type: "tree" as const, refs: extractObjectRefBytes("tree", treeBody) },
      { oid: commitOid, type: "commit" as const, refs: extractObjectRefBytes("commit", commitBody) },
      { oid: tagOid, type: "tag" as const, refs: extractObjectRefBytes("tag", tagBody) },
    ];
    const packSha1 = "11".repeat(20);
    const idxSha1 = "22".repeat(20);
    const encoded = encodePackRefIndex({ entries, packBytes: 4096, packSha1, idxSha1 });
    const parsed = parsePackRefIndex(encoded, packSha1);

    expect(parsed.objectCount).toBe(4);
    expect(parsed.packBytes).toBe(4096);
    expect(parsed.packSha1).toBe(packSha1);
    expect(parsed.idxSha1).toBe(idxSha1);

    const sortedOids = entries.map((e) => e.oid).sort();
    const closure = walkClosureWithPref([{ sortedOids, pref: parsed }], [tagOid]);
    expect([...closure].sort()).toEqual([blobOid, commitOid, tagOid, treeOid].sort());
    expect(closure.has(gitlinkOid)).toBe(false);
  });

  it("compacts multiple packs into one clean OFS_DELTA + .idx + .pref pack via REPO_TASKS, upgrades clone to worker-passthrough, and cleans retired .pref on gcNow", async () => {
    const h = engine();
    const repo = `m41/compact-${crypto.randomUUID().slice(0, 8)}`;
    const baseEnv = m41Env();

    const p1 = await buildFullCommitPack({
      fileName: "shared.txt",
      content: "shared base content line\n".repeat(4),
      message: "commit 1",
      time: 1700000100,
    });
    await pushPack(h, baseEnv, repo, "refs/heads/main", ZERO_OID, p1.oid, p1.pack);

    // Push 2: cross-pack REF_DELTA referencing p1.blobOid.
    const p2 = await buildThinDeltaCommitPack({
      fileName: "shared.txt",
      baseBlobOid: p1.blobOid,
      baseBlobLength: enc.encode("shared base content line\n".repeat(4)).length,
      content: `${"shared base content line\n".repeat(4)}second revision line\n`,
      message: "commit 2 (cross-pack delta)",
      parentOid: p1.oid,
      time: 1700000200,
    });
    await pushPack(h, baseEnv, repo, "refs/heads/main", p1.oid, p2.oid, p2.pack);

    // Push 3: fast-forward commit 3.
    const p3 = await buildFullCommitPack({
      fileName: "extra.txt",
      content: "third pack file\n",
      message: "commit 3",
      parentOid: p2.oid,
      time: 1700000300,
    });
    await pushPack(h, baseEnv, repo, "refs/heads/main", p2.oid, p3.oid, p3.pack);

    // Warm reachable before compaction -> cleanReachable will mark output pack clean & reachable!
    const warmRes = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": UPLOAD_CT, "git-protocol": "version=2" },
        body: buildV2FetchRequest([p3.oid]),
      }),
      baseEnv,
      NOOP_CTX,
    );
    expect(warmRes.status).toBe(200);
    await warmRes.arrayBuffer();

    const spyCompact = spyR2Bucket(env.REPO_PACKS);
    let acked = 0;
    let retried = 0;
    await handleRepoTasks(
      {
        queue: "repo-tasks",
        messages: [
          {
            id: "msg-compact-1",
            timestamp: new Date(),
            attempts: 1,
            body: { kind: "pack-compact", repo, force: true },
            ack: () => {
              acked++;
            },
            retry: () => {
              retried++;
            },
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch<unknown>,
      m41Env({ REPO_PACKS: spyCompact.bucket }),
    );
    expect(acked).toBe(1);
    expect(retried).toBe(0);
    // Exactly 1 R2.get per input pack (3 packs).
    expect(spyCompact.gets.length).toBe(3);

    // Verify catalog collapsed to 1 active pack with cleanReachable=true, prefBytes > 0, tier=1, and OFS_DELTA encoded.
    const stub = env.REPO.getByName(repo);
    const catalog = await stub.listPackCatalog({ cursor: null, limit: 20 });
    expect(catalog.tag).toBe("ok");
    if (catalog.tag !== "ok") throw new Error("catalog error");
    const active = catalog.rows.filter((r) => r.state === "active");
    const retired = catalog.rows.filter((r) => r.state === "retired");
    expect(active.length).toBe(1);
    expect(retired.length).toBe(3);
    const outPack = active[0]!;
    expect(outPack.object_count).toBe(9);
    const outPackObj = await env.REPO_PACKS.get(`repos/${repo}/packs/${outPack.pack_key}.pack`);
    expect(outPackObj).not.toBeNull();
    const outPackBytes = new Uint8Array(await outPackObj!.arrayBuffer());
    assertPackHeader(outPackBytes, 9);

    // Confirm the thin blob row was rewritten with OFS_DELTA (header type 6) in the compacted pack.
    const catPage = await stub.listCatalogPage("", 20);
    const activePage = catPage.packs.find((p) => p.packKey === outPack.pack_key);
    expect(activePage).toBeDefined();
    const deltaRow = activePage!.rows.find((r) => r.oid === p2.blobOid);
    expect(deltaRow).toBeDefined();
    expect(deltaRow!.baseOid).toBe(p1.blobOid);
    expect((outPackBytes[deltaRow!.offset]! >> 4) & 7).toBe(6);

    // Verify .pref sidecar exists and decodes with all 9 compacted objects.
    const prefObj = await env.REPO_PACKS.get(prefR2Key(repo, outPack.pack_key));
    expect(prefObj).not.toBeNull();
    const prefBytes = new Uint8Array(await prefObj!.arrayBuffer());
    const prefView = parsePackRefIndex(prefBytes);
    expect(prefView.objectCount).toBe(9);

    // Subsequent full clone now upgrades from worker-stream (3 gets) to worker-passthrough (1 R2.get)!
    const spyClone = spyR2Bucket(env.REPO_PACKS);
    const cloneRes = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": UPLOAD_CT, "git-protocol": "version=2" },
        body: buildV2FetchRequest([p3.oid]),
      }),
      m41Env({ REPO_PACKS: spyClone.bucket }),
      NOOP_CTX,
    );
    expect(cloneRes.status).toBe(200);
    expect(cloneRes.headers.get("x-upload-plane")).toBe("worker-passthrough");
    await cloneRes.arrayBuffer();
    expect(spyClone.gets.length).toBe(1);

    // GC deletes retired input packs + sidecars.
    const gcRes = await stub.gcNow();
    expect(gcRes.tag).toBe("collected");
    if (gcRes.tag === "collected") {
      expect(gcRes.deleted.sort()).toEqual(retired.map((r) => r.pack_key).sort());
    }
  });

  it("defers when receive lease is live and cleans up orphan R2/staging state on write abort", async () => {
    const h = engine();
    const repo = `m41/faults-${crypto.randomUUID().slice(0, 8)}`;
    const baseEnv = m41Env();

    const p1 = await buildFullCommitPack({ fileName: "a.txt", content: "one\n", message: "c1", time: 1700000100 });
    await pushPack(h, baseEnv, repo, "refs/heads/main", ZERO_OID, p1.oid, p1.pack);
    const p2 = await buildFullCommitPack({
      fileName: "b.txt",
      content: "two\n",
      message: "c2",
      parentOid: p1.oid,
      time: 1700000200,
    });
    await pushPack(h, baseEnv, repo, "refs/heads/main", p1.oid, p2.oid, p2.pack);

    // 1. Live receive lease -> Queue consumer retries with delaySeconds=30.
    const stub = env.REPO.getByName(repo);
    const begin = await stub.beginReceive({
      commands: [{ ref: "refs/heads/main", old: p2.oid, next: p2.oid }],
      capabilities: [],
      packBytesHint: null,
    });
    expect(begin.tag).toBe("ok");
    if (begin.tag !== "ok") throw new Error("expected ok receive lease");

    const retries: Array<{ delaySeconds?: number } | undefined> = [];
    await handleRepoTasks(
      {
        queue: "repo-tasks",
        messages: [
          {
            id: "msg-defer",
            timestamp: new Date(),
            attempts: 1,
            body: { kind: "pack-compact", repo, force: true },
            ack: () => {},
            retry: (opts?: QueueRetryOptions) => retries.push(opts),
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch<unknown>,
      baseEnv,
    );
    expect(retries).toEqual([{ delaySeconds: 30 }]);

    await stub.releaseReceive({ leaseToken: begin.leaseToken, sweep: false });

    // 2. Injected R2 put failure on `.pref` aborts compaction cleanly, leaving active packs untouched and no orphan `.pack`.
    const failSpy = spyR2Bucket(env.REPO_PACKS, { failKeySuffix: ".pref" });
    const retriedFail: number[] = [];
    await handleRepoTasks(
      {
        queue: "repo-tasks",
        messages: [
          {
            id: "msg-fail-pref",
            timestamp: new Date(),
            attempts: 1,
            body: { kind: "pack-compact", repo, force: true },
            ack: () => {},
            retry: () => retriedFail.push(1),
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch<unknown>,
      m41Env({ REPO_PACKS: failSpy.bucket }),
    );
    expect(retriedFail.length).toBe(1);

    const catalogAfter = await stub.listPackCatalog({ cursor: null, limit: 20 });
    expect(catalogAfter.tag).toBe("ok");
    if (catalogAfter.tag === "ok") {
      expect(catalogAfter.rows.filter((r) => r.state === "active").length).toBe(2);
    }
    const listed = await env.REPO_PACKS.list({ prefix: `repos/${repo}/packs/` });
    const packFiles = listed.objects.filter((o) => o.key.endsWith(".pack"));
    expect(packFiles.length).toBe(2);
  });
});
