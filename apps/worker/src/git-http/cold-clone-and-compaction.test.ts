import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createDurableGit } from "@cf-gitea/git-engine";
import { handleRepoTasks } from "../repos/purge";
import { ZERO_OID, buildReceivePackBody } from "../repos/testing/git-pack";

const enc = new TextEncoder();
const dec = new TextDecoder();
const RECEIVE_CT = "application/x-git-receive-pack-request";
const UPLOAD_CT = "application/x-git-upload-pack-request";
const NOOP_CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const TEST_SECRET = "test-bundle-signing-secret-m44-0123456789";

function engine() {
  return createDurableGit<Env>({ authorize: () => true, ui: false, namespaces: true });
}

function m44Env(extra: Record<string, string | R2Bucket | undefined> = {}): Env {
  return {
    ...env,
    ...({
      UPLOAD_PACK_WORKER_STREAM: "true",
      COMPACTION_QUEUE_ENABLED: "true",
      RECEIVE_DIRECT_PACK_WRITE: "true",
      BUNDLE_URI_ENABLED: "true",
      BUNDLE_SIGNING_SECRET: TEST_SECRET,
      BUNDLE_MIN_BYTES: "1",
      ...extra,
    } as unknown as Partial<Env>),
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

function parsePktLines(bytes: Uint8Array): string[] {
  const lines: string[] = [];
  let off = 0;
  while (off + 4 <= bytes.length) {
    const hex = dec.decode(bytes.subarray(off, off + 4));
    if (hex === "0000" || hex === "0001") {
      lines.push(hex);
      off += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > bytes.length) break;
    lines.push(dec.decode(bytes.subarray(off + 4, off + len)).replace(/\n$/, ""));
    off += len;
  }
  return lines;
}

function extractSidebandPack(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let off = 0;
  while (off + 4 <= bytes.length) {
    const hex = dec.decode(bytes.subarray(off, off + 4));
    if (hex === "0000" || hex === "0001") {
      off += 4;
      continue;
    }
    const len = parseInt(hex, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > bytes.length) break;
    const payload = bytes.subarray(off + 4, off + len);
    if (payload.length > 0 && payload[0] === 1 && payload.length > 1) {
      chunks.push(payload.subarray(1));
    }
    off += len;
  }
  return concatU8(chunks);
}

async function sha1Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  return [...(await sha1Bytes(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
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

async function buildCommitPack(opts: {
  fileName: string;
  content: string;
  message: string;
  parentOid?: string;
  time: number;
}): Promise<{ oid: string; blobOid: string; blobLen: number; pack: Uint8Array }> {
  const blob = enc.encode(opts.content);
  const blobOid = await sha1Hex(concatU8([enc.encode(`blob ${blob.length}\0`), blob]));
  const treeBody = concatU8([enc.encode(`100644 ${opts.fileName}\0`), rawOid(blobOid)]);
  const treeOid = await sha1Hex(concatU8([enc.encode(`tree ${treeBody.length}\0`), treeBody]));
  const parentLine = opts.parentOid ? `parent ${opts.parentOid}\n` : "";
  const commitBody = enc.encode(
    `tree ${treeOid}\n` +
      parentLine +
      `author Test User <test@example.com> ${opts.time} +0000\n` +
      `committer Test User <test@example.com> ${opts.time} +0000\n\n` +
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
  chunks.push(await sha1Bytes(concatU8(chunks)));
  return { oid: commitOid, blobOid, blobLen: blob.length, pack: concatU8(chunks) };
}

async function buildThinDeltaCommitPack(opts: {
  fileName: string;
  baseBlobOid: string;
  baseBlobLength: number;
  content: string;
  message: string;
  parentOid: string;
  time: number;
}): Promise<{ oid: string; blobOid: string; blobLen: number; pack: Uint8Array }> {
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
  chunks.push(objectHeader(7, deltaBytes.length), rawOid(opts.baseBlobOid), await zlibDeflate(deltaBytes));
  chunks.push(objectHeader(2, treeBody.length), await zlibDeflate(treeBody));
  chunks.push(objectHeader(1, commitBody.length), await zlibDeflate(commitBody));
  chunks.push(await sha1Bytes(concatU8(chunks)));
  return { oid: commitOid, blobOid, blobLen: newBlob.length, pack: concatU8(chunks) };
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
}

function buildV2FetchRequest(wants: string[]): Uint8Array {
  return concatU8([
    pkt("command=fetch\n"),
    enc.encode("0001"),
    pkt("thin-pack\n"),
    pkt("ofs-delta\n"),
    ...wants.map((w) => pkt(`want ${w}\n`)),
    pkt("done\n"),
    enc.encode("0000"),
  ]);
}

async function assertValidPack(pack: Uint8Array, expectedCount: number): Promise<void> {
  expect(pack.length).toBeGreaterThanOrEqual(32);
  expect(dec.decode(pack.subarray(0, 4))).toBe("PACK");
  const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  expect(dv.getUint32(4, false)).toBe(2);
  expect(dv.getUint32(8, false)).toBe(expectedCount);
  const digest = await sha1Bytes(pack.subarray(0, pack.length - 20));
  expect(pack.subarray(pack.length - 20)).toEqual(digest);
}

function spyR2Bucket(inner: R2Bucket): {
  bucket: R2Bucket;
  gets: Array<{ key: string; ranged: boolean }>;
} {
  const gets: Array<{ key: string; ranged: boolean }> = [];
  const bucket: R2Bucket = {
    head: (key) => inner.head(key),
    get: (key: string, options?: R2GetOptions) => {
      gets.push({ key, ranged: Boolean(options && "range" in options && options.range !== undefined) });
      return inner.get(key, options);
    },
    put: (key, value, options) => inner.put(key, value, options),
    createMultipartUpload: (key, options) => inner.createMultipartUpload(key, options),
    resumeMultipartUpload: (key, uploadId) => inner.resumeMultipartUpload(key, uploadId),
    delete: (keys) => inner.delete(keys),
    list: (options) => inner.list(options),
  };
  return { bucket, gets };
}

async function runCompactTask(targetEnv: Env, repo: string): Promise<void> {
  let acked = 0;
  let retried = 0;
  await handleRepoTasks(
    {
      queue: "repo-tasks",
      messages: [
        {
          id: `m44-compact-${crypto.randomUUID().slice(0, 8)}`,
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
    targetEnv,
  );
  expect(acked).toBe(1);
  expect(retried).toBe(0);
}

describe("SPEC-0024 M4.4 Worker cold-clone & cold-compaction closure", () => {
  it("streams cold multi-pack full clones via worker-cold-stream without prior warm-up or compaction", async () => {
    const h = engine();
    const repo = `alice/m44-cold3-${crypto.randomUUID().slice(0, 8)}`;
    const pushEnv = m44Env();

    const p1 = await buildCommitPack({
      fileName: "a.txt",
      content: "alpha payload\n",
      message: "c1",
      time: 1700002000,
    });
    const p2 = await buildThinDeltaCommitPack({
      fileName: "b.txt",
      content: "alpha payload delta v2\n",
      baseBlobOid: p1.blobOid,
      baseBlobLength: p1.blobLen,
      message: "c2",
      parentOid: p1.oid,
      time: 1700002100,
    });
    const p3 = await buildCommitPack({
      fileName: "c.txt",
      content: "gamma payload\n",
      message: "c3",
      parentOid: p2.oid,
      time: 1700002200,
    });
    await pushPack(h, pushEnv, repo, "refs/heads/main", ZERO_OID, p1.oid, p1.pack);
    await pushPack(h, pushEnv, repo, "refs/heads/main", p1.oid, p2.oid, p2.pack);
    await pushPack(h, pushEnv, repo, "refs/heads/main", p2.oid, p3.oid, p3.pack);

    const spy = spyR2Bucket(env.REPO_PACKS);
    const cloneRes = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": UPLOAD_CT, "git-protocol": "version=2" },
        body: buildV2FetchRequest([p3.oid]),
      }),
      m44Env({ REPO_PACKS: spy.bucket, WORKER_COLD_CLONE_MIN_BYTES: "0" }),
      NOOP_CTX,
    );
    expect(cloneRes.status).toBe(200);
    expect(cloneRes.headers.get("x-upload-plane")).toBe("worker-cold-stream");
    const pack = extractSidebandPack(new Uint8Array(await cloneRes.arrayBuffer()));
    await assertValidPack(pack, 9);
    expect(spy.gets.length).toBeLessThanOrEqual(6);
    expect(spy.gets.some((g) => g.ranged)).toBe(false);
  });

  it("switches fragmented >= 8-pack cold repos onto worker-cold-stream with default thresholds", async () => {
    const h = engine();
    const repo = `alice/m44-cold8-${crypto.randomUUID().slice(0, 8)}`;
    const targetEnv = m44Env();

    let prev = ZERO_OID;
    for (let i = 1; i <= 8; i++) {
      const c = await buildCommitPack({
        fileName: `f${i}.txt`,
        content: `payload-${i}\n`,
        message: `commit ${i}`,
        ...(prev === ZERO_OID ? {} : { parentOid: prev }),
        time: 1700003000 + i * 60,
      });
      await pushPack(h, targetEnv, repo, "refs/heads/main", prev, c.oid, c.pack);
      prev = c.oid;
    }

    const res = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": UPLOAD_CT, "git-protocol": "version=2" },
        body: buildV2FetchRequest([prev]),
      }),
      targetEnv,
      NOOP_CTX,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upload-plane")).toBe("worker-cold-stream");
    const pack = extractSidebandPack(new Uint8Array(await res.arrayBuffer()));
    await assertValidPack(pack, 24);
  });

  it("certifies cleanReachable during cold compaction -> immediate .bundle + 1-read worker-passthrough", async () => {
    const h = engine();
    const repo = `alice/m44-cert-${crypto.randomUUID().slice(0, 8)}`;
    const targetEnv = m44Env();

    const p1 = await buildCommitPack({
      fileName: "init.txt",
      content: "hello cold compact\n",
      message: "init",
      time: 1700004000,
    });
    const p2 = await buildCommitPack({
      fileName: "next.txt",
      content: "second cold compact\n",
      message: "second",
      parentOid: p1.oid,
      time: 1700004100,
    });
    await pushPack(h, targetEnv, repo, "refs/heads/main", ZERO_OID, p1.oid, p1.pack);
    await pushPack(h, targetEnv, repo, "refs/heads/main", p1.oid, p2.oid, p2.pack);

    await runCompactTask(targetEnv, repo);

    const stub = targetEnv.REPO.getByName(repo);
    expect((await stub.getRepoBundleInfo(repo)).bundle).not.toBeNull();

    const spy = spyR2Bucket(env.REPO_PACKS);
    const firstClone = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": UPLOAD_CT, "git-protocol": "version=2" },
        body: buildV2FetchRequest([p2.oid]),
      }),
      m44Env({ REPO_PACKS: spy.bucket }),
      NOOP_CTX,
    );
    expect(firstClone.status).toBe(200);
    expect(firstClone.headers.get("x-upload-plane")).toBe("worker-passthrough");
    const pack = extractSidebandPack(new Uint8Array(await firstClone.arrayBuffer()));
    expect(spy.gets.length).toBe(1);
    await assertValidPack(pack, 6);

    const advert = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/info/refs?service=git-upload-pack`, {
        headers: { "git-protocol": "version=2" },
      }),
      targetEnv,
      NOOP_CTX,
    );
    expect(parsePktLines(new Uint8Array(await advert.arrayBuffer()))).toContain("bundle-uri");
  });

  it("excludes force-push orphans on cold clones & cold compaction and uses .pref+.idx fast path post-compaction", async () => {
    const h = engine();
    const repo = `alice/m44-orphan-${crypto.randomUUID().slice(0, 8)}`;
    const pushEnv = m44Env();

    const secret = await buildCommitPack({
      fileName: "secret.txt",
      content: "TOP-SECRET-ORPHAN-PAYLOAD\n",
      message: "secret root",
      time: 1700005000,
    });
    const replacement = await buildCommitPack({
      fileName: "clean.txt",
      content: "clean replacement\n",
      message: "clean root",
      time: 1700005100,
    });
    await pushPack(h, pushEnv, repo, "refs/heads/main", ZERO_OID, secret.oid, secret.pack);
    await pushPack(h, pushEnv, repo, "refs/heads/main", secret.oid, replacement.oid, replacement.pack);

    // Cold clone before compaction excludes orphan objects.
    const preClone = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": UPLOAD_CT, "git-protocol": "version=2" },
        body: buildV2FetchRequest([replacement.oid]),
      }),
      m44Env({ WORKER_COLD_CLONE_MIN_BYTES: "0" }),
      NOOP_CTX,
    );
    expect(preClone.status).toBe(200);
    expect(preClone.headers.get("x-upload-plane")).toBe("worker-cold-stream");
    const prePack = extractSidebandPack(new Uint8Array(await preClone.arrayBuffer()));
    await assertValidPack(prePack, 3);

    // Cold compaction with reachable uncached retains both packs' objects -> closure (3) < emitted (6) -> no bundle!
    await runCompactTask(pushEnv, repo);
    const stub = pushEnv.REPO.getByName(repo);
    expect((await stub.getRepoBundleInfo(repo)).bundle).toBeNull();

    // Post-compaction cold clone uses .pref + .idx fast path (1 .pack get + .pref + .idx) and still emits only 3 objects.
    const spy = spyR2Bucket(env.REPO_PACKS);
    const postClone = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": UPLOAD_CT, "git-protocol": "version=2" },
        body: buildV2FetchRequest([replacement.oid]),
      }),
      m44Env({ REPO_PACKS: spy.bucket, WORKER_COLD_CLONE_MIN_BYTES: "0" }),
      NOOP_CTX,
    );
    expect(postClone.status).toBe(200);
    expect(postClone.headers.get("x-upload-plane")).toBe("worker-cold-stream");
    const postPack = extractSidebandPack(new Uint8Array(await postClone.arrayBuffer()));
    await assertValidPack(postPack, 3);

    const packGets = spy.gets.filter((g) => g.key.endsWith(".pack"));
    const prefGets = spy.gets.filter((g) => g.key.endsWith(".pref"));
    const idxGets = spy.gets.filter((g) => g.key.endsWith(".idx"));
    expect(packGets.length).toBe(1);
    expect(prefGets.length).toBe(1);
    expect(idxGets.length).toBe(1);
  });
});
