import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  bundleR2Key,
  createDurableGit,
  formatGitBundleV2Header,
  parseHttpByteRange,
  serveBundleDownload,
  signBundleToken,
  verifyBundleToken,
} from "@cf-gitea/git-engine";
import { checkRepoInvariants } from "../invariants/check";
import { handleRepoTasks } from "../repos/purge";
import { ZERO_OID, buildReceivePackBody } from "../repos/testing/git-pack";
import { parseBundleRoute } from "./parse";

const enc = new TextEncoder();
const dec = new TextDecoder();
const RECEIVE_CT = "application/x-git-receive-pack-request";
const UPLOAD_CT = "application/x-git-upload-pack-request";
const NOOP_CTX = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const TEST_SECRET = "test-bundle-signing-secret-0123456789abcdef";

function engine() {
  return createDurableGit<Env>({ authorize: () => true, ui: false, namespaces: true });
}

function m43Env(extra: Record<string, string> = {}): Env {
  return {
    ...env,
    ...({
      UPLOAD_PACK_WORKER_STREAM: "true",
      COMPACTION_QUEUE_ENABLED: "true",
      RECEIVE_DIRECT_PACK_WRITE: "true",
      BUNDLE_URI_ENABLED: "true",
      BUNDLE_SIGNING_SECRET: TEST_SECRET,
      BUNDLE_MIN_BYTES: "1",
      BUNDLE_TOKEN_TTL_SEC: "900",
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

async function buildCommitPack(opts: {
  fileName: string;
  content: string;
  message: string;
  parentOid?: string;
  time: number;
}): Promise<{ oid: string; pack: Uint8Array }> {
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
  chunks.push(rawOid(await sha1Hex(concatU8(chunks))));
  return { oid: commitOid, pack: concatU8(chunks) };
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

describe("SPEC-0024 M4.3 bundle-uri unit helpers", () => {
  it("formatGitBundleV2Header orders HEAD first, sorts refs, and terminates with a blank line", () => {
    const oidA = "a".repeat(40);
    const oidB = "b".repeat(40);
    const oidHead = "c".repeat(40);
    const header = dec.decode(
      formatGitBundleV2Header([
        { name: "refs/tags/v1.0", oid: oidB },
        { name: "HEAD", oid: oidHead },
        { name: "refs/heads/main", oid: oidA },
      ]),
    );
    expect(header).toBe(
      `# v2 git bundle\n${oidHead} HEAD\n${oidA} refs/heads/main\n${oidB} refs/tags/v1.0\n\n`,
    );
  });

  it("signBundleToken & verifyBundleToken validate HMAC-SHA256 signature, path safety, and expiry", async () => {
    const now = 1_700_000_000;
    const token = await signBundleToken(
      { r: "alice/m43-unit", s: "r_123", b: "v1-packabc", e: now + 900 },
      TEST_SECRET,
    );
    expect(await verifyBundleToken(token, TEST_SECRET, now)).toEqual({
      r: "alice/m43-unit",
      s: "r_123",
      b: "v1-packabc",
      e: now + 900,
    });
    expect(await verifyBundleToken(token, "wrong-secret", now)).toBeNull();
    expect(await verifyBundleToken(token, TEST_SECRET, now + 900)).toBeNull();

    const dot = token.indexOf(".");
    const tampered = `${token.slice(0, dot + 1)}A${token.slice(dot + 2)}`;
    expect(await verifyBundleToken(tampered, TEST_SECRET, now)).toBeNull();

    const badStorage = await signBundleToken(
      { r: "alice/m43-unit", s: "../escape", b: "v1-packabc", e: now + 900 },
      TEST_SECRET,
    );
    expect(await verifyBundleToken(badStorage, TEST_SECRET, now)).toBeNull();
  });

  it("parseHttpByteRange handles closed, open, suffix, and invalid Range specs", () => {
    expect(parseHttpByteRange("bytes=0-31", 100)).toEqual({ kind: "ok", start: 0, end: 31 });
    expect(parseHttpByteRange("bytes=10-999", 100)).toEqual({ kind: "ok", start: 10, end: 99 });
    expect(parseHttpByteRange("bytes=25-", 100)).toEqual({ kind: "ok", start: 25, end: 99 });
    expect(parseHttpByteRange("bytes=-16", 100)).toEqual({ kind: "ok", start: 84, end: 99 });
    expect(parseHttpByteRange("bytes=0-1,2-3", 100)).toEqual({ kind: "invalid" });
    expect(parseHttpByteRange("bytes=50-10", 100)).toEqual({ kind: "invalid" });
    expect(parseHttpByteRange("bytes=100-105", 100)).toEqual({ kind: "invalid" });
  });

  it("parseBundleRoute parses GET/HEAD bundle URLs and rejects POST or malformed shapes", () => {
    expect(parseBundleRoute("/alice/demo.git/bundle/tok.sig", "GET")).toEqual({
      owner: "alice",
      repo: "demo",
      token: "tok.sig",
    });
    expect(parseBundleRoute("/alice/demo/bundle/tok.sig", "HEAD")).toEqual({
      owner: "alice",
      repo: "demo",
      token: "tok.sig",
    });
    expect(parseBundleRoute("/alice/demo.git/bundle/tok.sig", "POST")).toBeNull();
    expect(parseBundleRoute("/alice/demo.git/bundle/tok/extra", "GET")).toBeNull();
  });
});

describe("SPEC-0024 M4.3 bundle-uri compaction, serving & anti-leakage", () => {
  it("materializes v2 bundle on compaction, serves signed Range GETs, preserves on fast-forward, and invalidates/GCs on force-push", async () => {
    const h = engine();
    const targetEnv = m43Env();
    const repo = "alice/m43-bundle-it";

    // 1. Push two commits across two packs so compaction consolidates into 1 pack.
    const c1 = await buildCommitPack({
      fileName: "a.txt",
      content: "commit one payload\n",
      message: "commit 1",
      time: 1700001000,
    });
    const c2 = await buildCommitPack({
      fileName: "b.txt",
      content: "commit two payload\n",
      message: "commit 2",
      parentOid: c1.oid,
      time: 1700001100,
    });
    await pushPack(h, targetEnv, repo, "refs/heads/main", ZERO_OID, c1.oid, c1.pack);
    await pushPack(h, targetEnv, repo, "refs/heads/main", c1.oid, c2.oid, c2.pack);

    // Warm reachable before compaction so the consolidated pack qualifies as cleanReachable.
    const warmRes = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": UPLOAD_CT, "git-protocol": "version=2" },
        body: concatU8([
          pkt("command=fetch\n"),
          enc.encode("0001"),
          pkt("thin-pack\n"),
          pkt("ofs-delta\n"),
          pkt(`want ${c2.oid}\n`),
          pkt("done\n"),
          enc.encode("0000"),
        ]),
      }),
      targetEnv,
      NOOP_CTX,
    );
    expect(warmRes.status).toBe(200);
    await warmRes.arrayBuffer();

    // 2. Compact via Queue consumer with BUNDLE_URI_ENABLED="true" -> writes .bundle to R2.
    let acked = 0;
    await handleRepoTasks(
      {
        queue: "repo-tasks",
        messages: [
          {
            id: "m43-compact-1",
            timestamp: new Date(),
            attempts: 1,
            body: { kind: "pack-compact", repo, force: true },
            ack: () => {
              acked++;
            },
            retry: () => {},
          },
        ],
        ackAll: () => {},
        retryAll: () => {},
      } as unknown as MessageBatch<unknown>,
      targetEnv,
    );
    expect(acked).toBe(1);

    const stub = targetEnv.REPO.getByName(repo);
    const info = await stub.getRepoBundleInfo(repo);
    expect(info.bundle).not.toBeNull();
    const expectedR2Key = bundleR2Key(info.storageKey, info.bundle!.id);
    expect(info.bundle!.r2Key).toBe(expectedR2Key);

    const r2Bundle = await targetEnv.REPO_PACKS.get(expectedR2Key);
    expect(r2Bundle).not.toBeNull();
    const fullBundleBytes = new Uint8Array(await r2Bundle!.arrayBuffer());
    const bundleTextPrefix = dec.decode(fullBundleBytes.subarray(0, 256));
    expect(bundleTextPrefix.startsWith("# v2 git bundle\n")).toBe(true);
    expect(bundleTextPrefix).toContain(`${c2.oid} HEAD\n`);
    expect(bundleTextPrefix).toContain(`${c2.oid} refs/heads/main\n`);
    const packMagicOffset = fullBundleBytes.findIndex(
      (_, i, arr) =>
        i + 7 < arr.length &&
        arr[i] === 0x50 &&
        arr[i + 1] === 0x41 &&
        arr[i + 2] === 0x43 &&
        arr[i + 3] === 0x4b &&
        arr[i + 4] === 0 &&
        arr[i + 5] === 0 &&
        arr[i + 6] === 0 &&
        arr[i + 7] === 2,
    );
    expect(packMagicOffset).toBeGreaterThan(20);

    // Repo invariants remain 0 violations with bundles/ present.
    const invReport = await checkRepoInvariants(targetEnv, { engineName: repo, storageKey: repo });
    expect(invReport.ok).toBe(true);
    expect(invReport.violations).toEqual([]);

    // 3. Protocol v2 info/refs gates bundle-uri advertisement on flag + secret + ready bundle.
    const disabledAdvert = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/info/refs?service=git-upload-pack`, {
        headers: { "git-protocol": "version=2" },
      }),
      m43Env({ BUNDLE_URI_ENABLED: "false" }),
      NOOP_CTX,
    );
    expect(parsePktLines(new Uint8Array(await disabledAdvert.arrayBuffer()))).not.toContain("bundle-uri");

    const enabledAdvert = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/info/refs?service=git-upload-pack`, {
        headers: { "git-protocol": "version=2" },
      }),
      targetEnv,
      NOOP_CTX,
    );
    expect(parsePktLines(new Uint8Array(await enabledAdvert.arrayBuffer()))).toContain("bundle-uri");

    // 4. POST /git-upload-pack with command=bundle-uri yields signed bundle URI + creationToken.
    const uriCmdRes = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": UPLOAD_CT, "git-protocol": "version=2" },
        body: concatU8([pkt("command=bundle-uri\n"), enc.encode("0000")]),
      }),
      targetEnv,
      NOOP_CTX,
    );
    expect(uriCmdRes.status).toBe(200);
    const uriLines = parsePktLines(new Uint8Array(await uriCmdRes.arrayBuffer()));
    expect(uriLines).toContain("bundle.version=1");
    expect(uriLines).toContain("bundle.mode=all");
    const uriLine = uriLines.find((l) => l.startsWith("bundle.base.uri="));
    expect(uriLine).toBeDefined();
    expect(uriLines.some((l) => l.startsWith("bundle.base.creationToken="))).toBe(true);
    const bundleUrl = uriLine!.slice("bundle.base.uri=".length);

    // 5. HEAD + full GET + Range GET (206) + out-of-bounds Range (416).
    const headRes = await h.fetch(new Request(bundleUrl, { method: "HEAD" }), targetEnv, NOOP_CTX);
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get("accept-ranges")).toBe("bytes");
    expect(headRes.headers.get("cache-control")).toBe("private, max-age=900");
    expect(headRes.headers.get("content-length")).toBe(String(fullBundleBytes.length));

    const getRes = await h.fetch(new Request(bundleUrl, { method: "GET" }), targetEnv, NOOP_CTX);
    expect(getRes.status).toBe(200);
    expect(new Uint8Array(await getRes.arrayBuffer())).toEqual(fullBundleBytes);

    const rangeRes = await h.fetch(
      new Request(bundleUrl, { method: "GET", headers: { range: "bytes=0-31" } }),
      targetEnv,
      NOOP_CTX,
    );
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("content-range")).toBe(`bytes 0-31/${fullBundleBytes.length}`);
    expect(new Uint8Array(await rangeRes.arrayBuffer())).toEqual(fullBundleBytes.subarray(0, 32));

    const oobRes = await h.fetch(
      new Request(bundleUrl, { method: "GET", headers: { range: `bytes=${fullBundleBytes.length}-` } }),
      targetEnv,
      NOOP_CTX,
    );
    expect(oobRes.status).toBe(416);

    // 6. Security checks: tampered token -> 403, expired token -> 403, cross-repo replay -> 403, flag off -> 404.
    const urlObj = new URL(bundleUrl);
    const token = urlObj.pathname.split("/").pop()!;
    const tamperedUrl = bundleUrl.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect((await h.fetch(new Request(tamperedUrl), targetEnv, NOOP_CTX)).status).toBe(403);

    const expiredToken = await signBundleToken(
      { r: repo, s: info.storageKey, b: info.bundle!.id, e: Math.floor(Date.now() / 1000) - 10 },
      TEST_SECRET,
    );
    expect(
      (await h.fetch(new Request(`https://engine.internal/${repo}.git/bundle/${expiredToken}`), targetEnv, NOOP_CTX))
        .status,
    ).toBe(403);

    // Seed another repo and replay repo A's token against repo B.
    const otherRepo = "alice/m43-other-it";
    const otherCommit = await buildCommitPack({
      fileName: "other.txt",
      content: "other\n",
      message: "other",
      time: 1700001200,
    });
    await pushPack(h, targetEnv, otherRepo, "refs/heads/main", ZERO_OID, otherCommit.oid, otherCommit.pack);
    expect(
      (await h.fetch(new Request(`https://engine.internal/${otherRepo}.git/bundle/${token}`), targetEnv, NOOP_CTX))
        .status,
    ).toBe(403);

    expect(
      (await h.fetch(new Request(bundleUrl), m43Env({ BUNDLE_URI_ENABLED: "false" }), NOOP_CTX)).status,
    ).toBe(404);

    // 7. Fast-forward push preserves latest_bundle & advertisement.
    const c3 = await buildCommitPack({
      fileName: "c.txt",
      content: "commit three ff\n",
      message: "commit 3",
      parentOid: c2.oid,
      time: 1700001300,
    });
    await pushPack(h, targetEnv, repo, "refs/heads/main", c2.oid, c3.oid, c3.pack);
    expect((await stub.getRepoBundleInfo(repo)).bundle?.id).toBe(info.bundle!.id);

    // 8. Force-push clears latest_bundle (anti-leakage), stops advertising bundle-uri, and GC deletes R2 .bundle.
    const orphanForce = await buildCommitPack({
      fileName: "orphan-replacement.txt",
      content: "rewritten root\n",
      message: "force rewrite",
      time: 1700001400,
    });
    await pushPack(h, targetEnv, repo, "refs/heads/main", c3.oid, orphanForce.oid, orphanForce.pack);
    expect((await stub.getRepoBundleInfo(repo)).bundle).toBeNull();

    const afterForceAdvert = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/info/refs?service=git-upload-pack`, {
        headers: { "git-protocol": "version=2" },
      }),
      targetEnv,
      NOOP_CTX,
    );
    expect(parsePktLines(new Uint8Array(await afterForceAdvert.arrayBuffer()))).not.toContain("bundle-uri");

    const afterForceCmd = await h.fetch(
      new Request(`https://engine.internal/${repo}.git/git-upload-pack`, {
        method: "POST",
        headers: { "content-type": UPLOAD_CT, "git-protocol": "version=2" },
        body: concatU8([pkt("command=bundle-uri\n"), enc.encode("0000")]),
      }),
      targetEnv,
      NOOP_CTX,
    );
    expect(parsePktLines(new Uint8Array(await afterForceCmd.arrayBuffer()))).toEqual(["0000"]);

    const gcRes = await stub.gcNow();
    expect(gcRes.tag).toBe("collected");
    if (gcRes.tag === "collected") {
      expect(gcRes.bundlesDeleted).toContain(expectedR2Key);
    }
    expect(await targetEnv.REPO_PACKS.get(expectedR2Key)).toBeNull();
  });

  it("streams large bundle GET and Range 206 responses via segmented stall-resilient R2 reads while keeping small bundles single-GET (M4.13)", async () => {
    const payload = new Uint8Array(100);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 19 + 7) & 0xff;

    const createTestBucket = (stallAtOffset: number | null) => {
      const getCalls: Array<{ key: string; range?: { offset?: number; length?: number } }> = [];
      let stalledOnce = false;
      const bucket = {
        head: () =>
          Promise.resolve({
            size: payload.length,
            httpEtag: '"bundle-etag"',
          } as unknown as R2Object),
        get: (key: string, options?: R2GetOptions) => {
          const range = options?.range as { offset?: number; length?: number } | undefined;
          getCalls.push({ key, range });
          const start = range?.offset ?? 0;
          const len = range?.length ?? payload.length - start;
          const slice = payload.subarray(start, start + len);
          return Promise.resolve({
            size: payload.length,
            httpEtag: '"bundle-etag"',
            body: new ReadableStream<Uint8Array>({
              start(ctrl) {
                if (stallAtOffset !== null && start === stallAtOffset && !stalledOnce) {
                  stalledOnce = true;
                  // Emit partial 10 bytes then stall past 40ms timeout.
                  ctrl.enqueue(slice.subarray(0, 10));
                  return;
                }
                ctrl.enqueue(slice);
                ctrl.close();
              },
            }),
          } as unknown as R2ObjectBody);
        },
      } as unknown as R2Bucket;
      return { bucket, getCalls };
    };

    // 1. Small bundle (size <= segmentBytes) preserves 1 plain R2.get.
    const smallState = createTestBucket(null);
    const smallRes = await serveBundleDownload(
      new Request("https://engine.internal/alice/r.git/bundle/tok"),
      smallState.bucket,
      "r_small",
      "b1",
      { segmentBytes: 128 },
    );
    expect(smallRes.status).toBe(200);
    expect(smallRes.headers.get("content-length")).toBe("100");
    expect(new Uint8Array(await smallRes.arrayBuffer())).toEqual(payload);
    expect(smallState.getCalls).toEqual([{ key: bundleR2Key("r_small", "b1"), range: undefined }]);

    // 2. Large plain GET streams in 40B segments and recovers via Range GET after a mid-segment stall.
    const fullState = createTestBucket(40);
    const fullRes = await serveBundleDownload(
      new Request("https://engine.internal/alice/r.git/bundle/tok"),
      fullState.bucket,
      "r_big",
      "b2",
      { segmentBytes: 40, readTimeoutMs: 40, maxRetriesPerSegment: 2 },
    );
    expect(fullRes.status).toBe(200);
    expect(fullRes.headers.get("content-length")).toBe("100");
    expect(fullRes.headers.get("etag")).toBe('"bundle-etag"');
    expect(new Uint8Array(await fullRes.arrayBuffer())).toEqual(payload);
    expect(fullState.getCalls.map((c) => c.range)).toEqual([
      { offset: 0, length: 40 },
      { offset: 40, length: 40 },
      { offset: 50, length: 30 },
      { offset: 80, length: 20 },
    ]);

    // 3. Large Range 206 (`bytes=25-`, len=75 > 40B) streams segments `[25..65)` and `[65..100)` with stall recovery.
    const rangeState = createTestBucket(25);
    const rangeRes = await serveBundleDownload(
      new Request("https://engine.internal/alice/r.git/bundle/tok", {
        headers: { range: "bytes=25-" },
      }),
      rangeState.bucket,
      "r_big",
      "b2",
      { segmentBytes: 40, readTimeoutMs: 40, maxRetriesPerSegment: 2 },
    );
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("content-range")).toBe("bytes 25-99/100");
    expect(rangeRes.headers.get("content-length")).toBe("75");
    expect(new Uint8Array(await rangeRes.arrayBuffer())).toEqual(payload.subarray(25));
    expect(rangeState.getCalls.map((c) => c.range)).toEqual([
      { offset: 25, length: 40 },
      { offset: 35, length: 30 },
      { offset: 65, length: 35 },
    ]);
  });
});
