import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createDurableGit,
  UPLOAD_KEEPALIVE_FRAME,
  type Env,
  type RepoCell,
} from "@cf-gitea/git-engine";
import { ZERO_OID, buildPack, buildReceivePackBody } from "../repos/testing/git-pack";

const enc = new TextEncoder();
const dec = new TextDecoder();
const UPLOAD_CT = "application/x-git-upload-pack-request";
const RECEIVE_CT = "application/x-git-receive-pack-request";
const NOOP_CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function engine() {
  return createDurableGit<Env>({ authorize: () => true, ui: false, namespaces: true });
}

function workerStreamEnv(extra: Partial<Env> = {}): Env {
  return {
    ...env,
    UPLOAD_PACK_WORKER_STREAM: "true",
    GIT_UPLOAD_KEEPALIVE_MS: "20000",
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

/** Build a standalone commit pack with a configurable file/message/parent. */
async function buildCustomPack(opts: {
  fileName: string;
  content: string;
  message: string;
  parentOid?: string;
  time?: number;
}): Promise<{ oid: string; pack: Uint8Array }> {
  const blob = enc.encode(opts.content);
  const blobSha = await sha1Hex(concatU8([enc.encode(`blob ${blob.length}\0`), blob]));
  const treeBody = concatU8([enc.encode(`100644 ${opts.fileName}\0`), rawOid(blobSha)]);
  const treeSha = await sha1Hex(concatU8([enc.encode(`tree ${treeBody.length}\0`), treeBody]));
  const time = opts.time ?? 1700000100;
  const parentLine = opts.parentOid ? `parent ${opts.parentOid}\n` : "";
  const commitBody = enc.encode(
    `tree ${treeSha}\n` +
      parentLine +
      `author Test User <test@example.com> ${time} +0000\n` +
      `committer Test User <test@example.com> ${time} +0000\n\n` +
      `${opts.message}\n`,
  );
  const commitSha = await sha1Hex(concatU8([enc.encode(`commit ${commitBody.length}\0`), commitBody]));
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
  return { oid: commitSha, pack: concatU8(chunks) };
}

function buildV2FetchRequest(wantOids: string[], extras: string[] = []): Uint8Array {
  const parts: Uint8Array[] = [
    pkt("command=fetch\n"),
    pkt("agent=git/2.43.0\n"),
    pkt("object-format=sha1\n"),
    enc.encode("0001"),
  ];
  for (const w of wantOids) parts.push(pkt(`want ${w}\n`));
  for (const ex of extras) parts.push(pkt(`${ex}\n`));
  parts.push(pkt("done\n"), enc.encode("0000"));
  return concatU8(parts);
}

function buildV0UploadRequest(wantOids: string[], caps: string[], extras: string[] = []): Uint8Array {
  const capSuffix = caps.length ? ` ${caps.join(" ")}` : "";
  const parts: Uint8Array[] = [pkt(`want ${wantOids[0]}${capSuffix}\n`)];
  for (let i = 1; i < wantOids.length; i++) {
    parts.push(pkt(`want ${wantOids[i]}\n`));
  }
  for (const ex of extras) parts.push(pkt(`${ex}\n`));
  parts.push(enc.encode("0000"), pkt("done\n"));
  return concatU8(parts);
}

interface ParsedSidebandResponse {
  preambles: string[];
  pack: Uint8Array;
  progress: string[];
  errors: string[];
  keepaliveCount: number;
  trailingFlush: boolean;
}

function parseSidebandUploadResponse(raw: Uint8Array): ParsedSidebandResponse {
  let off = 0;
  const preambles: string[] = [];
  const packParts: Uint8Array[] = [];
  const progress: string[] = [];
  const errors: string[] = [];
  let keepaliveCount = 0;
  let trailingFlush = false;

  while (off + 4 <= raw.length) {
    const head = dec.decode(raw.subarray(off, off + 4));
    if (head === "0000") {
      trailingFlush = true;
      off += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > raw.length) {
      throw new Error(`malformed pkt-line at offset ${off}: head=${JSON.stringify(head)}`);
    }
    const payload = raw.subarray(off + 4, off + len);
    off += len;
    if (len === 5 && payload[0] === 1) {
      keepaliveCount++;
      continue;
    }
    const text = dec.decode(payload);
    if (preambles.length === 0 && (text === "packfile\n" || text === "NAK\n" || text.startsWith("ACK "))) {
      preambles.push(text);
      continue;
    }
    const band = payload[0];
    const body = payload.subarray(1);
    if (band === 1) packParts.push(body);
    else if (band === 2) progress.push(dec.decode(body));
    else if (band === 3) errors.push(dec.decode(body));
    else preambles.push(text);
  }
  return {
    preambles,
    pack: concatU8(packParts),
    progress,
    errors,
    keepaliveCount,
    trailingFlush,
  };
}

function parsePlainV0Response(raw: Uint8Array): { preamble: string; pack: Uint8Array } {
  const len = parseInt(dec.decode(raw.subarray(0, 4)), 16);
  return {
    preamble: dec.decode(raw.subarray(4, len)),
    pack: raw.subarray(len),
  };
}

async function assertValidPack(pack: Uint8Array, expectedObjects: number): Promise<void> {
  expect(pack.length).toBeGreaterThanOrEqual(32);
  expect(dec.decode(pack.subarray(0, 4))).toBe("PACK");
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  expect(view.getUint32(4, false)).toBe(2);
  expect(view.getUint32(8, false)).toBe(expectedObjects);
  const body = pack.subarray(0, pack.length - 20);
  const trailer = pack.subarray(pack.length - 20);
  const expectedSum = rawOid(await sha1Hex(body));
  expect(trailer).toEqual(expectedSum);
}

interface R2Spy {
  bucket: R2Bucket;
  gets: string[];
  createMultiparts: string[];
}

function spyR2(
  inner: R2Bucket,
  onGet?: (key: string, body: ReadableStream<Uint8Array>) => ReadableStream<Uint8Array>,
): R2Spy {
  const gets: string[] = [];
  const createMultiparts: string[] = [];
  const bucket: R2Bucket = {
    async head(key: string) {
      return inner.head(key);
    },
    get: async (key: string, options?: R2GetOptions) => {
      gets.push(key);
      const obj = await inner.get(key, options as R2GetOptions & { onlyIf?: R2Conditional });
      if (!obj || !("body" in obj) || !onGet) return obj;
      const wrappedBody = onGet(key, obj.body as ReadableStream<Uint8Array>);
      return {
        key: obj.key,
        version: obj.version,
        size: obj.size,
        etag: obj.etag,
        httpEtag: obj.httpEtag,
        checksums: obj.checksums,
        uploaded: obj.uploaded,
        httpMetadata: obj.httpMetadata,
        customMetadata: obj.customMetadata,
        range: obj.range,
        storageClass: obj.storageClass,
        ssecKeyMd5: obj.ssecKeyMd5,
        body: wrappedBody,
        get bodyUsed() {
          return wrappedBody.locked;
        },
        async arrayBuffer() {
          return new Response(wrappedBody).arrayBuffer();
        },
        async bytes() {
          return new Uint8Array(await new Response(wrappedBody).arrayBuffer());
        },
        async text() {
          return new Response(wrappedBody).text();
        },
        async json<T>() {
          return new Response(wrappedBody).json<T>();
        },
        async blob() {
          return new Response(wrappedBody).blob();
        },
        writeHttpMetadata(headers: Headers) {
          obj.writeHttpMetadata(headers);
        },
      };
    },
    async put(key: string, value: Parameters<R2Bucket["put"]>[1], options?: R2PutOptions) {
      return inner.put(key, value, options);
    },
    async createMultipartUpload(key: string, options?: R2MultipartOptions) {
      createMultiparts.push(key);
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
  return { bucket, gets, createMultiparts };
}

function wrapRepoNs(
  inner: DurableObjectNamespace<RepoCell>,
  onPlanId: (planId: string) => void,
): DurableObjectNamespace<RepoCell> {
  return {
    newUniqueId: inner.newUniqueId.bind(inner),
    idFromName: inner.idFromName.bind(inner),
    idFromString: inner.idFromString.bind(inner),
    get: inner.get.bind(inner),
    jurisdiction: inner.jurisdiction.bind(inner),
    getByName(name: string, options?: DurableObjectNamespaceGetDurableObjectOptions) {
      const stub = inner.getByName(name, options);
      return new Proxy(stub, {
        get(target, prop, receiver) {
          if (prop === "planWorkerWarmFullClone") {
            return async (repo: string, wants: string[]) => {
              const res = await target.planWorkerWarmFullClone(repo, wants);
              if (res.tag === "leased") onPlanId(res.planId);
              return res;
            };
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          if (typeof value === "function") {
            return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(target, args);
          }
          return value;
        },
      });
    },
  };
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
  let body: Uint8Array;
  if (oldOid === ZERO_OID) {
    body = buildReceivePackBody([{ ref, oid: newOid }], pack);
  } else {
    body = concatU8([
      pkt(`${oldOid} ${newOid} ${ref}\0report-status side-band-64k\n`),
      enc.encode("0000"),
      pack,
    ]);
  }
  const req = new Request(`https://engine.internal/${repo}.git/git-receive-pack`, {
    method: "POST",
    headers: { "content-type": RECEIVE_CT },
    body,
  });
  const res = await handler.fetch(req, targetEnv, NOOP_CTX);
  expect(res.status).toBe(200);
  const text = dec.decode(new Uint8Array(await res.arrayBuffer()));
  expect(text).toContain("unpack ok");
  expect(text).toContain(`ok ${ref}`);
}

async function postUpload(
  handler: ReturnType<typeof engine>,
  targetEnv: Env,
  repo: string,
  body: Uint8Array,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const req = new Request(`https://engine.internal/${repo}.git/git-upload-pack`, {
    method: "POST",
    headers: { "content-type": UPLOAD_CT, ...extraHeaders },
    body,
  });
  return handler.fetch(req, targetEnv, NOOP_CTX);
}

describe("SPEC-0024 M4.0 Worker streaming upload-pack", () => {
  it("streams single-pack warm full clones via worker-passthrough (1 R2.get, 0 multipart) across v2, v0 sideband, and plain v0", async () => {
    const h = engine();
    const repo = `m40/single-${crypto.randomUUID().slice(0, 8)}`;
    const { oid, pack } = await buildPack();
    const baseEnv = workerStreamEnv();
    await pushPack(h, baseEnv, repo, "refs/heads/main", ZERO_OID, oid, pack);

    // Cold clone warms `reachable` without writing a synchronous clone-cache multipart object.
    const spyWarm = spyR2(env.REPO_PACKS);
    const coldRes = await postUpload(
      h,
      workerStreamEnv({ REPO_PACKS: spyWarm.bucket }),
      repo,
      buildV2FetchRequest([oid]),
      { "git-protocol": "version=2" },
    );
    expect(coldRes.status).toBe(200);
    expect(coldRes.headers.get("x-upload-plane")).toBeNull();
    const coldParsed = parseSidebandUploadResponse(new Uint8Array(await coldRes.arrayBuffer()));
    await assertValidPack(coldParsed.pack, 3);
    expect(spyWarm.createMultiparts.length).toBe(0);

    // Warm v2 fetch -> worker-passthrough with exactly 1 R2.get and 0 multipart uploads.
    const spyV2 = spyR2(env.REPO_PACKS);
    const v2Res = await postUpload(
      h,
      workerStreamEnv({ REPO_PACKS: spyV2.bucket }),
      repo,
      buildV2FetchRequest([oid]),
      { "git-protocol": "version=2" },
    );
    expect(v2Res.status).toBe(200);
    expect(v2Res.headers.get("x-upload-plane")).toBe("worker-passthrough");
    const v2Bytes = new Uint8Array(await v2Res.arrayBuffer());
    const v2Parsed = parseSidebandUploadResponse(v2Bytes);
    expect(v2Parsed.preambles).toEqual(["packfile\n"]);
    expect(v2Parsed.trailingFlush).toBe(true);
    expect(v2Parsed.errors).toEqual([]);
    await assertValidPack(v2Parsed.pack, 3);
    expect(spyV2.gets.length).toBe(1);
    expect(spyV2.createMultiparts.length).toBe(0);

    // Warm v0 side-band-64k -> worker-passthrough with NAK preamble + flush.
    const spyV0Sb = spyR2(env.REPO_PACKS);
    const v0SbRes = await postUpload(
      h,
      workerStreamEnv({ REPO_PACKS: spyV0Sb.bucket }),
      repo,
      buildV0UploadRequest([oid], ["side-band-64k", "ofs-delta"]),
    );
    expect(v0SbRes.status).toBe(200);
    expect(v0SbRes.headers.get("x-upload-plane")).toBe("worker-passthrough");
    const v0SbParsed = parseSidebandUploadResponse(new Uint8Array(await v0SbRes.arrayBuffer()));
    expect(v0SbParsed.preambles).toEqual(["NAK\n"]);
    expect(v0SbParsed.trailingFlush).toBe(true);
    await assertValidPack(v0SbParsed.pack, 3);
    expect(spyV0Sb.gets.length).toBe(1);
    expect(spyV0Sb.createMultiparts.length).toBe(0);

    // Warm v0 plain (no side-band-64k) -> worker-passthrough with raw NAK + PACK.
    const spyPlain = spyR2(env.REPO_PACKS);
    const plainRes = await postUpload(
      h,
      workerStreamEnv({ REPO_PACKS: spyPlain.bucket }),
      repo,
      buildV0UploadRequest([oid], ["ofs-delta"]),
    );
    expect(plainRes.status).toBe(200);
    expect(plainRes.headers.get("x-upload-plane")).toBe("worker-passthrough");
    const plainParsed = parsePlainV0Response(new Uint8Array(await plainRes.arrayBuffer()));
    expect(plainParsed.preamble).toBe("NAK\n");
    await assertValidPack(plainParsed.pack, 3);
    expect(spyPlain.gets.length).toBe(1);
  });

  it("streams multi-pack fast-forward repos via worker-stream (at most 1 R2.get per pack, valid merged pack)", async () => {
    const h = engine();
    const repo = `m40/multi-${crypto.randomUUID().slice(0, 8)}`;
    const baseEnv = workerStreamEnv();
    const p1 = await buildCustomPack({ fileName: "a.txt", content: "first\n", message: "c1", time: 1700000100 });
    await pushPack(h, baseEnv, repo, "refs/heads/main", ZERO_OID, p1.oid, p1.pack);

    // Warm reachable via cold clone on commit 1.
    const warm1 = await postUpload(h, baseEnv, repo, buildV2FetchRequest([p1.oid]), { "git-protocol": "version=2" });
    expect(warm1.status).toBe(200);
    await warm1.arrayBuffer();

    // Second fast-forward push lands a second pack and extends `reachable` (staying warm).
    const p2 = await buildCustomPack({
      fileName: "b.txt",
      content: "second\n",
      message: "c2",
      parentOid: p1.oid,
      time: 1700000200,
    });
    await pushPack(h, baseEnv, repo, "refs/heads/main", p1.oid, p2.oid, p2.pack);

    const spy = spyR2(env.REPO_PACKS);
    const res = await postUpload(
      h,
      workerStreamEnv({ REPO_PACKS: spy.bucket }),
      repo,
      buildV2FetchRequest([p2.oid]),
      { "git-protocol": "version=2" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upload-plane")).toBe("worker-stream");
    const parsed = parseSidebandUploadResponse(new Uint8Array(await res.arrayBuffer()));
    expect(parsed.preambles).toEqual(["packfile\n"]);
    expect(parsed.trailingFlush).toBe(true);
    await assertValidPack(parsed.pack, 6);
    expect(spy.gets.length).toBe(2);
    expect(new Set(spy.gets).size).toBe(2);
    expect(spy.createMultiparts.length).toBe(0);
  });

  it("enforces fail-closed G3 protocol guards, bypasses shallow/filtered/incremental requests, and omits orphaned commits after force-push", async () => {
    const h = engine();
    const repo = `m40/guards-${crypto.randomUUID().slice(0, 8)}`;
    const baseEnv = workerStreamEnv();
    const p1 = await buildCustomPack({ fileName: "old.txt", content: "old\n", message: "old", time: 1700000100 });
    await pushPack(h, baseEnv, repo, "refs/heads/main", ZERO_OID, p1.oid, p1.pack);
    const warmOld = await postUpload(h, baseEnv, repo, buildV2FetchRequest([p1.oid]), { "git-protocol": "version=2" });
    await warmOld.arrayBuffer();

    // 1. Poisoned deepen-since -> fail-closed ERR with 0 R2 reads.
    const spyBad = spyR2(env.REPO_PACKS);
    const badRes = await postUpload(
      h,
      workerStreamEnv({ REPO_PACKS: spyBad.bucket }),
      repo,
      buildV2FetchRequest([p1.oid], ["deepen-since 1700000000"]),
      { "git-protocol": "version=2" },
    );
    expect(dec.decode(new Uint8Array(await badRes.arrayBuffer()))).toContain("ERR ");
    expect(spyBad.gets.length).toBe(0);

    // 2. Shallow / filtered / incremental haves bypass Worker streaming cleanly.
    const shallowRes = await postUpload(h, baseEnv, repo, buildV2FetchRequest([p1.oid], ["deepen 1"]), {
      "git-protocol": "version=2",
    });
    expect(shallowRes.headers.get("x-upload-plane")).toBeNull();
    expect(shallowRes.status).toBe(200);
    await shallowRes.arrayBuffer();

    const filterRes = await postUpload(h, baseEnv, repo, buildV2FetchRequest([p1.oid], ["filter blob:none"]), {
      "git-protocol": "version=2",
    });
    expect(filterRes.headers.get("x-upload-plane")).toBeNull();
    expect(filterRes.status).toBe(200);
    await filterRes.arrayBuffer();

    const haveRes = await postUpload(h, baseEnv, repo, buildV2FetchRequest([p1.oid], [`have ${p1.oid}`]), {
      "git-protocol": "version=2",
    });
    expect(haveRes.headers.get("x-upload-plane")).toBeNull();
    expect(haveRes.status).toBe(200);
    await haveRes.arrayBuffer();

    // 3. Force-push invalidates `reachable`; subsequent clone sends ONLY the new branch objects.
    const p2 = await buildCustomPack({ fileName: "new.txt", content: "new\n", message: "new", time: 1700000200 });
    await pushPack(h, baseEnv, repo, "refs/heads/main", p1.oid, p2.oid, p2.pack);

    // First post-force-push clone falls back to cold walk (omits orphaned p1 commit/tree/blob -> 3 objects, not 6).
    const postForce1 = await postUpload(h, baseEnv, repo, buildV2FetchRequest([p2.oid]), {
      "git-protocol": "version=2",
    });
    expect(postForce1.status).toBe(200);
    expect(postForce1.headers.get("x-upload-plane")).toBeNull();
    const parsed1 = parseSidebandUploadResponse(new Uint8Array(await postForce1.arrayBuffer()));
    await assertValidPack(parsed1.pack, 3);

    // Second post-force-push clone warms onto Worker streaming without orphaned objects.
    const postForce2 = await postUpload(h, baseEnv, repo, buildV2FetchRequest([p2.oid]), {
      "git-protocol": "version=2",
    });
    expect(postForce2.status).toBe(200);
    expect(["worker-passthrough", "worker-stream"]).toContain(postForce2.headers.get("x-upload-plane"));
    const parsed2 = parseSidebandUploadResponse(new Uint8Array(await postForce2.arrayBuffer()));
    await assertValidPack(parsed2.pack, 3);
  });

  it("aborts multi-pack worker-stream before trailing FLUSH when the read lease is released/rejected mid-stream (SPEC-0011 Property A)", async () => {
    const h = engine();
    const repo = `m40/lease-${crypto.randomUUID().slice(0, 8)}`;
    const baseEnv = workerStreamEnv();
    const p1 = await buildCustomPack({ fileName: "f1.txt", content: "111\n", message: "c1", time: 1700000100 });
    await pushPack(h, baseEnv, repo, "refs/heads/main", ZERO_OID, p1.oid, p1.pack);
    const warm1 = await postUpload(h, baseEnv, repo, buildV2FetchRequest([p1.oid]), { "git-protocol": "version=2" });
    await warm1.arrayBuffer();
    const p2 = await buildCustomPack({
      fileName: "f2.txt",
      content: "222\n",
      message: "c2",
      parentOid: p1.oid,
      time: 1700000200,
    });
    await pushPack(h, baseEnv, repo, "refs/heads/main", p1.oid, p2.oid, p2.pack);

    let capturedPlanId = "";
    const wrappedNs = wrapRepoNs(env.REPO, (planId) => {
      capturedPlanId = planId;
    });

    let revoked = false;
    const spy = spyR2(env.REPO_PACKS, (_key, body) => {
      if (!revoked) {
        revoked = true;
        const origReader = body.getReader();
        return new ReadableStream<Uint8Array>({
          async pull(ctrl) {
            if (capturedPlanId) {
              await env.REPO.getByName(repo).releaseReadLease(capturedPlanId);
              capturedPlanId = "";
            }
            const next = await origReader.read();
            if (next.done) ctrl.close();
            else ctrl.enqueue(next.value);
          },
        });
      }
      return body;
    });

    const res = await postUpload(
      h,
      workerStreamEnv({ REPO: wrappedNs, REPO_PACKS: spy.bucket }),
      repo,
      buildV2FetchRequest([p2.oid]),
      { "git-protocol": "version=2" },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upload-plane")).toBe("worker-stream");

    const chunks: Uint8Array[] = [];
    let errored = false;
    const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } catch {
      errored = true;
    }
    expect(errored).toBe(true);
    const partial = concatU8(chunks);
    expect(dec.decode(partial.subarray(Math.max(0, partial.length - 4)))).not.toBe("0000");
  });

  it("emits idle-gated 0005\\x01 keepalives on delayed sideband streams and never on plain v0", async () => {
    const h = engine();
    const repo = `m40/keepalive-${crypto.randomUUID().slice(0, 8)}`;
    const baseEnv = workerStreamEnv();
    const { oid, pack } = await buildPack();
    await pushPack(h, baseEnv, repo, "refs/heads/main", ZERO_OID, oid, pack);
    const warm = await postUpload(h, baseEnv, repo, buildV2FetchRequest([oid]), { "git-protocol": "version=2" });
    await warm.arrayBuffer();

    const makeDelayedSpy = () =>
      spyR2(env.REPO_PACKS, (_key, body) => {
        const orig = body.getReader();
        let delayed = false;
        return new ReadableStream<Uint8Array>({
          async pull(ctrl) {
            if (!delayed) {
              delayed = true;
              await new Promise((r) => setTimeout(r, 175));
            }
            const next = await orig.read();
            if (next.done) ctrl.close();
            else ctrl.enqueue(next.value);
          },
        });
      });

    // Sideband v2 at GIT_UPLOAD_KEEPALIVE_MS=50 emits >=1 exact 0005\x01 frame before pack completion.
    const sbSpy = makeDelayedSpy();
    const sbRes = await postUpload(
      h,
      workerStreamEnv({ REPO_PACKS: sbSpy.bucket, GIT_UPLOAD_KEEPALIVE_MS: "50" }),
      repo,
      buildV2FetchRequest([oid]),
      { "git-protocol": "version=2" },
    );
    expect(sbRes.status).toBe(200);
    expect(sbRes.headers.get("x-upload-plane")).toBe("worker-passthrough");
    const sbBytes = new Uint8Array(await sbRes.arrayBuffer());
    const sbParsed = parseSidebandUploadResponse(sbBytes);
    expect(sbParsed.keepaliveCount).toBeGreaterThanOrEqual(1);
    expect(sbParsed.trailingFlush).toBe(true);
    await assertValidPack(sbParsed.pack, 3);
    expect(dec.decode(UPLOAD_KEEPALIVE_FRAME)).toBe("0005\x01");

    // Plain v0 must NEVER emit 0005\x01 keepalive packets.
    const plainSpy = makeDelayedSpy();
    const plainRes = await postUpload(
      h,
      workerStreamEnv({ REPO_PACKS: plainSpy.bucket, GIT_UPLOAD_KEEPALIVE_MS: "50" }),
      repo,
      buildV0UploadRequest([oid], ["ofs-delta"]),
    );
    expect(plainRes.status).toBe(200);
    expect(plainRes.headers.get("x-upload-plane")).toBe("worker-passthrough");
    const plainBytes = new Uint8Array(await plainRes.arrayBuffer());
    const plainParsed = parsePlainV0Response(plainBytes);
    expect(plainParsed.preamble).toBe("NAK\n");
    await assertValidPack(plainParsed.pack, 3);
  });
});
