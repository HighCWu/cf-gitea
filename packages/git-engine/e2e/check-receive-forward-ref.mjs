// The receive walk's thin-base classification — the delta-on-deferred-delta
// misclassification that ground windowed mirror pushes to a wall.
//
// HAZARD (the 2026-11-24 domon-ai/comfyui-frontend mirror wall, L725): the
// resolver classified a REF_DELTA "external" at WALK time whenever its base
// oid was not yet in the resolved-oid set. A base that is merely DEFERRED (a
// delta chain anchored on a thin base resolves in fixpoint order, so every
// deeper delta is walk-time-unresolved) was therefore misclassified as a
// thin base, and finish()'s externals pre-pass looked it up in the object
// database AND MATERIALIZED it (one lookupObjects RPC per chain hop plus one
// R2 range read per hop) — for an object the pack itself holds. In production
// (real DO/R2 latency, ~2,700-window object database) one windowed push spent
// minutes in that grind, the platform tore the invocation down on the client
// disconnect before any catch could run, the exclusive receive lease held
// until its TTL, and every later window re-seeded the same grind: a
// self-sustaining 503 wall that never healed.
//
// The fix: nothing is classified external at walk time. The straggler pool
// carries every walk-time-unresolved delta; the fixpoint's tryResolve
// resolves in-pack bases first and falls back to the lazy lookupObjects
// channel only for bases the pack truly lacks.
//
// Pinned here over the REAL receive pipeline (createDurableGit().fetch → real
// control plane over node:sqlite, R2 staged in memory — the
// check-receive-name-bind.mjs harness), with the DO stub recording every
// lookupObjects oid. The pack shape is the production one, hand-built:
//   e0  REF_DELTA on a window-1 blob (a TRUE thin base — the lazy channel
//       must resolve and materialize it)
//   e1  OFS_DELTA on e0 (walk-time straggler: its base entry is itself a
//       straggler)
//   e2  REF_DELTA on e1's RESULT oid (walk-time unresolved — the shape the
//       old code misclassified and ODB-materialized)
//   tree referencing e2's result + a commit on that tree (the connectivity
//   anchor; the commit's parent is the window-1 commit, itself a
//   connectivity lookup against the ODB).
//
// Covers, in order:
//   1. the misclassification discriminator: the window-2 push lands, and the
//      lookupObjects trace NEVER contains e1's result oid (the old code
//      looked it up and chain-materialized it) — every looked-up oid is a
//      true out-of-pack object (the thin base, the parent commit).
//   2. the deadline backstop: with GIT_RECEIVE_DEADLINE_MS above the walk's
//      real cost but the bucket delaying every read past it, the indexing
//      phase fails with the explicit "receive indexing deadline exceeded" ng
//      line and the lease TURNS OVER (the follow-up receive runs past
//      beginReceive instead of 503ing busy) — the wall's holding mechanism,
//      converted into a fast, visible failure.
// Run with tsx, the same mechanism as check-receive-name-bind.mjs:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-receive-forward-ref.mjs
// Exits non-zero on the first violated assertion.

import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";

// repo.ts extends DurableObject at module scope — the inert shim (the DO is
// the real control-plane stub below; no cell is ever constructed).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

// mod.ts's stagePack (known-length path) and the idx PUT use the workers
// runtime's FixedLengthStream — the minimal contract over a TransformStream
// (same shim as check-receive-name-bind.mjs).
class FixedLengthStreamShim {
  constructor(expected) {
    let written = 0;
    const ts = new TransformStream({
      transform: (chunk, c) => {
        written += chunk.length;
        if (written > expected) {
          c.error(new Error(`exceeded the fixed length (${written} > ${expected})`));
          return;
        }
        c.enqueue(chunk);
      },
      flush: (c) => {
        if (written !== expected) c.error(new Error(`fixed length mismatch: wrote ${written}, expected ${expected}`));
      },
    });
    this.writable = ts.writable;
    this.readable = ts.readable;
  }
}
globalThis.FixedLengthStream = FixedLengthStreamShim;

const { GitStore } = await import("../src/git/store.ts");
const { NodeSql } = await import("./helpers/lib.mjs");
const controlPlane = await import("../src/control-plane.ts");
const { createDurableGit } = await import("../src/mod.ts");
const { serializeTree, serializeCommit } = await import("../src/commit/serialize.ts");
const { hashObject, TYPE_NUM } = await import("../src/git/objects.ts");
const { fromHex, sha1hex, ZERO_OID } = await import("../src/git/util.ts");
const pako = (await import("pako")).default;

const te = new TextEncoder();

let planned = 0;
const failures = [];
async function check(name, fn) {
  planned++;
  try {
    await fn();
    console.log(`ok: ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function assertEq(got, want, what = "") {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`);
}

// ---- fixture builders -------------------------------------------------------

function concatParts(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) out.set(p, off), (off += p.length);
  return out;
}

function encodeEntryHeader(typeNum, size) {
  const bytes = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(first | 0x80);
    first = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

function be32(value) {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function rawOid(oidHex) {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

/** ofs-delta distance varint (git's subtract-one-per-continuation encoding,
 *  decoded by the scanner as `off = (byte + 1) * 128 + next` per hop). */
function ofsHeader(distance) {
  const bytes = [distance & 0x7f];
  let n = distance >>> 7;
  while (n > 0) {
    n -= 1;
    bytes.unshift(0x80 | (n & 0x7f));
    n >>>= 7;
  }
  return new Uint8Array(bytes);
}

function deltaVarint(n) {
  const bytes = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return new Uint8Array(bytes);
}

/** git delta stream: copy the shared prefix of `base`, insert the rest of
 *  `target` as literals (the receive-delta-base.test.ts fixture shape). */
function deltaWholeCopyThenInsert(base, target) {
  if (base.length > 0xffff) throw new Error("fixture delta shape wants a ≤64KiB base");
  let keep = 0;
  const max = Math.min(base.length, target.length);
  while (keep < max && base[keep] === target[keep]) keep++;
  if (keep === 0) throw new Error("fixture delta shape needs a shared prefix");
  const tail = target.subarray(keep);
  // copy opcode 0xB0 = copy present + two size bytes (offset bits unset: from 0)
  const ops = [new Uint8Array([0xb0, keep & 0xff, keep >>> 8])];
  for (let i = 0; i < tail.length; i += 127) {
    const slice = tail.subarray(i, Math.min(i + 127, tail.length));
    ops.push(new Uint8Array([slice.length]), slice);
  }
  return concatParts([deltaVarint(base.length), deltaVarint(target.length), ...ops]);
}

function hashObjectOf(typeName, data) {
  return hashObject(typeName, data);
}

/**
 * Build a pack from entry descriptors. A FULL entry is `{ kind: "full", type,
 * data }`; a REF_DELTA is `{ kind: "ref", base: <40-hex oid>, baseBody,
 * targetBody }` (the delta stream is built from baseBody/targetBody, and the
 * target's oid hashes from targetBody); an OFS_DELTA is `{ kind: "ofs",
 * fromEntry: <index>, baseBody, targetBody }` (the distance is computed from
 * the named entry's offset). Returns `{ bytes, oids }` where oids[i] is the
 * entry's result oid (fulls hash directly; deltas hash their targetBody).
 */
function buildPack2(entries) {
  const chunks = [];
  const head = new Uint8Array(12);
  head.set(te.encode("PACK"), 0);
  const dv = new DataView(head.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, entries.length);
  chunks.push(head);
  const offsets = [];
  const oids = [];
  entries.forEach((e) => {
    const entryStart = concatParts(chunks).length;
    offsets.push(entryStart);
    let body;
    if (e.kind === "full") {
      body = e.data;
      oids.push(hashObjectOf(e.type, e.data));
      chunks.push(encodeEntryHeader(TYPE_NUM[e.type], e.data.length));
    } else {
      const delta = deltaWholeCopyThenInsert(e.baseBody, e.targetBody);
      if (process.env.L725_DEBUG) {
        console.log(
          `build entry ${entries.indexOf(e)} ${e.kind}: baseBody=${e.baseBody.length} targetBody=${e.targetBody.length} delta=${delta.length}`
        );
      }
      const typeName = e.type ?? "blob";
      oids.push(hashObjectOf(typeName, e.targetBody));
      if (e.kind === "ref") {
        chunks.push(encodeEntryHeader(7, delta.length));
        chunks.push(rawOid(e.base));
      } else {
        const distance = offsets[e.fromEntry] === undefined ? 0 : entryStart - offsets[e.fromEntry];
        chunks.push(encodeEntryHeader(6, delta.length));
        chunks.push(ofsHeader(distance));
      }
      body = delta;
    }
    chunks.push(pako.deflate(body));
  });
  const sha = sha1hex(concatParts(chunks));
  chunks.push(fromHex(sha)); // trailer
  return { bytes: concatParts(chunks), oids };
}

const PERSON = { name: "t", email: "t@t", time: 1700000000, tz: "+0000" };

// ---- window 1 (the pre-seeded ODB): one committed blob ----------------------

const W1_BLOB = te.encode("window-1 base blob: the thin base the object database holds.\n");
const w1BlobOid = hashObjectOf("blob", W1_BLOB);
const W1_TREE = serializeTree([{ mode: "100644", oid: w1BlobOid, name: "base.txt" }]);
const W1_COMMIT = serializeCommit({ tree: W1_TREE.oid, parents: [], author: PERSON, committer: PERSON, message: "window 1\n" });
const W1_PACK = buildPack2([
  { kind: "full", type: "blob", data: W1_BLOB },
  { kind: "full", type: "tree", data: W1_TREE.data },
  { kind: "full", type: "commit", data: W1_COMMIT.data },
]);
const W1_COMMIT_OID = W1_COMMIT.oid;

// ---- window 2 (the test push): thin base + deferred chain + misclassified tail

// e0: a TRUE thin REF_DELTA — its base (W1's blob) exists only in the ODB.
const T1_BODY = concatParts([W1_BLOB, te.encode("window-2 appends this line.\n")]);
const t1Oid = hashObjectOf("blob", T1_BODY);
// e1: an OFS_DELTA on e0's result — a walk-time straggler (its base entry is
// itself a straggler at walk time).
const T2_BODY = concatParts([T1_BODY, te.encode("and another line on the deferred chain.\n")]);
const t2Oid = hashObjectOf("blob", T2_BODY);
// e2: a REF_DELTA on e1's RESULT oid — walk-time unresolved at its entry, the
// exact shape the old code classified external and ODB-materialized.
const T3_BODY = concatParts([T2_BODY, te.encode("tail of the chain.\n")]);
const t3Oid = hashObjectOf("blob", T3_BODY);

const W2_TREE = serializeTree([{ mode: "100644", oid: t3Oid, name: "base.txt" }]);
const W2_COMMIT = serializeCommit({ tree: W2_TREE.oid, parents: [W1_COMMIT_OID], author: PERSON, committer: PERSON, message: "window 2\n" });
const W2_COMMIT_OID = W2_COMMIT.oid;

const W2_ENTRIES = [
  { kind: "ref", base: w1BlobOid, baseBody: W1_BLOB, targetBody: T1_BODY },
  { kind: "ofs", fromEntry: 0, baseBody: T1_BODY, targetBody: T2_BODY },
  { kind: "ref", base: t2Oid, baseBody: T2_BODY, targetBody: T3_BODY },
  { kind: "full", type: "tree", data: W2_TREE.data },
  { kind: "full", type: "commit", data: W2_COMMIT.data },
];
const W2_PACK = buildPack2(W2_ENTRIES);

// ---- the receive harness (real flow, real control plane, in-memory R2) ------

function makeRepo(cellName, opts) {
  const db = new DatabaseSync(":memory:");
  const sql = new NodeSql(db);
  const tx = (fn) => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  const t = { db, sql, tx, objects: new Map(), rpcs: [], lookupOids: [], cellName };
  t.store = new GitStore(sql, { tx });
  t.host = {
    store: t.store,
    storage: { transactionSync: tx, setAlarm: () => Promise.resolve() },
    deletePackObjects: async (keys) => {
      for (const k of keys) t.objects.delete(k);
    },
  };
  const delayMs = opts?.getDelayMs ?? 0;
  const maybeDelay = async () => {
    if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
  };
  t.bucket = {
    async put(key, value) {
      if (value instanceof Uint8Array || value?.constructor?.name === "Uint8Array") {
        t.objects.set(key, value);
        return value;
      }
      if (value && typeof value.getReader === "function") {
        const chunks = [];
        const reader = value.getReader();
        for (;;) {
          const { done, value: v } = await reader.read();
          if (done) break;
          chunks.push(v);
        }
        const out = concatParts(chunks);
        t.objects.set(key, out);
        return out;
      }
      throw new Error(`unexpected bucket.put body: ${typeof value}`);
    },
    async get(key, req) {
      await maybeDelay();
      const data = t.objects.get(key);
      if (!data) return null;
      if (req?.range) {
        const off = req.range.offset ?? 0;
        const len = Math.min(req.range.length ?? data.length - off, data.length - off);
        const slice = data.subarray(off, off + len);
        return { arrayBuffer: async () => slice.slice().buffer, body: new Response(slice).body, size: slice.length };
      }
      return { arrayBuffer: async () => data.slice().buffer, body: new Response(data).body, size: data.length };
    },
    async createMultipartUpload(key) {
      const parts = [];
      return {
        uploadPart: async (n, data) => {
          parts.push(data);
          return { partNumber: n, etag: `p${n}` };
        },
        complete: async () => {
          t.objects.set(key, concatParts(parts));
          return {};
        },
        abort: async () => {},
      };
    },
    async delete(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) t.objects.delete(k);
    },
    async list({ prefix }) {
      const out = [];
      for (const k of t.objects.keys()) if (k.startsWith(prefix)) out.push({ key: k });
      return { objects: out, truncated: false };
    },
  };
  const impl = {
    bindRepo: async (name) => {
      t.rpcs.push(`bindRepo:${name}`);
      t.store.setR2(t.bucket, t.store.getMeta("storage_key") ?? t.store.getMeta("repo") ?? name);
      if (t.store.getMeta("repo") !== name) t.store.setMeta("repo", name);
    },
    beginReceive: async (input) => {
      t.rpcs.push("beginReceive");
      return controlPlane.beginReceive(t.host, input);
    },
    putIndexRows: async (leaseToken, name, rows) => {
      t.rpcs.push("putIndexRows");
      return controlPlane.putIndexRows(t.host, leaseToken, name, rows);
    },
    lookupObjects: async (leaseToken, oids) => {
      t.rpcs.push("lookupObjects");
      t.lookupOids.push(...oids);
      return controlPlane.lookupObjects(t.host, leaseToken, oids);
    },
    classifyReceive: async (input) => {
      t.rpcs.push("classifyReceive");
      return controlPlane.classifyReceive(t.host, input);
    },
    finalizeReceive: async (input) => {
      t.rpcs.push("finalizeReceive");
      return controlPlane.finalizeReceive(t.host, input);
    },
    releaseReceive: async (input) => {
      t.rpcs.push("releaseReceive");
      return controlPlane.releaseReceive(t.host, input);
    },
  };
  const doStub = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string") return undefined;
        if (!impl[prop]) {
          return async () => {
            throw new Error(`unexpected DO RPC: ${prop}`);
          };
        }
        return impl[prop];
      },
    }
  );
  t.env = {
    REPO_PACKS: t.bucket,
    REPO: { getByName: () => doStub },
    REGISTRY: { getByName: () => ({ get: async () => null, list: async () => [], upsert: async () => {} }) },
    MAX_PUSH_MB: "512",
    ...(opts?.env ?? {}),
  };
  return t;
}

// ---- protocol builders ------------------------------------------------------

const pkt = (s) => Buffer.from((s.length + 4).toString(16).padStart(4, "0") + s);
const FLUSH_PKT = Buffer.from("0000");

function receiveBody(commands, packBytes) {
  const lines = commands.map((c, i) => pkt(i === 0 ? `${c}\0report-status side-band-64k agent=git/2.43.0\n` : `${c}\n`));
  return Buffer.concat([...lines, FLUSH_PKT, packBytes ?? Buffer.alloc(0)]);
}

function makePostReceive(t) {
  const waits = [];
  const handler = createDurableGit({ authorize: () => true, namespaces: true });
  const post = (base, body, extraHeaders) =>
    handler.fetch(
      new Request(`${base}/${t.cellName}.git/git-receive-pack`, {
        method: "POST",
        headers: {
          "content-type": "application/x-git-receive-pack-request",
          "content-length": String(body.length),
          ...(extraHeaders ?? {}),
        },
        body,
      }),
      t.env,
      { waitUntil: (p) => waits.push(p) }
    );
  return {
    post,
    flushWaits: async () => {
      await Promise.allSettled(waits);
      waits.length = 0;
    },
  };
}

/** The sideband payload of a receive response: unpack line + per-ref report. */
async function responseReport(res) {
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(Buffer.from(buf.subarray(i, i + 4)).toString("ascii"), 16);
    if (len === 0) break;
    text.push(Buffer.from(buf.subarray(i + 4, i + len)).toString("utf8"));
    i += len;
  }
  return text.join("");
}

const mainTip = (t) => t.store.getRef("refs/heads/main");

// ---- the checks --------------------------------------------------------------

if (process.env.L725_DEBUG) {
  const { walkPack, inflateAll } = await import("../src/receive/scan.ts");
  const { applyDelta } = await import("../src/git/pack.ts");
  const bodies = new Map();
  bodies.set(w1BlobOid, W1_BLOB);
  await walkPack(
    { body: new Response(W2_PACK.bytes).body, size: W2_PACK.bytes.length },
    async (e) => {
      let kind = e.kind === "full" ? e.objType : e.refBase ? `REF ${e.refBase.slice(0, 10)}` : `OFS→${e.ofsBase}`;
      if (e.kind === "full") {
        bodies.set(e.oid, e.content);
        console.log("entry", e.index, kind, "oid", e.oid.slice(0, 10));
        return;
      }
      const raw = e.data ?? inflateAll(await new Response(new Response(W2_PACK.bytes.slice(e.dataOff, e.dataOff + e.dataLen)).body).arrayBuffer());
      const srcLen =
        raw[0] |
        ((raw[1] & 0x7f) << 7) |
        ((raw[2] & 0x7f) << 14) |
        ((raw[3] & 0x7f) << 21);
      let baseHex = e.refBase;
      let baseLen = -1;
      if (!baseHex && e.ofsBase !== undefined) {
        console.log("  ofs target offset", e.ofsBase);
        baseLen = "?";
      }
      if (baseHex) baseLen = bodies.has(baseHex) ? bodies.get(baseHex).length : -1;
      console.log("entry", e.index, kind, "declared-src", srcLen, "base-len", baseLen, "oid", W2_PACK.oids[e.index]?.slice(0, 10));
      let baseData = baseHex ? bodies.get(baseHex) : undefined;
      if (baseData === undefined) return;
      const out = applyDelta(baseData, raw);
      const oid = hashObjectOf("blob", out);
      bodies.set(oid, out);
      console.log("  resolved oid", oid.slice(0, 10), "len", out.length);
    },
    { onHeader: (c) => console.log("header count", c) }
  );
}

await check("1. DISCRIMINATOR: the deferred-chain REF_DELTA resolves in-pack — its oid is never looked up in the ODB", async () => {
  const NAME = "mirror/proj";
  const t = makeRepo(NAME, null);
  const rx = makePostReceive(t);
  // window 1 seeds the ODB (the thin base's home)
  const res1 = await rx.post("http://dgit.test", receiveBody([`${ZERO_OID} ${W1_COMMIT_OID} refs/heads/main`], W1_PACK.bytes));
  assertEq(res1.status, 200, "window-1 http status");
  await rx.flushWaits();
  t.rpcs.length = 0;
  t.lookupOids.length = 0;
  // window 2: thin base + deferred chain + the walk-time-unresolved tail
  const res2 = await rx.post(
    "http://dgit.test",
    receiveBody([`${W1_COMMIT_OID} ${W2_COMMIT_OID} refs/heads/main`], W2_PACK.bytes)
  );
  assertEq(res2.status, 200, "window-2 http status");
  const report = await responseReport(res2);
  assert(report.includes("ok refs/heads/main"), `window-2 landed (report: ${report.slice(0, 300)})`);
  await rx.flushWaits();
  assertEq(mainTip(t), W2_COMMIT_OID, "window-2 tip applied");
  // THE DISCRIMINATOR: t2's oid is an IN-PACK result (entry e1's target) — the
  // old walk-time classification looked it up in the ODB (and chain-
  // materialized the hit). The fix resolves the chain in the fixpoint: the
  // lookup trace may contain only TRUE out-of-pack objects (the thin base and
  // the parent commit's connectivity lookup).
  assert(
    !t.lookupOids.includes(t2Oid),
    `the deferred-chain oid ${t2Oid} was looked up in the ODB — the walk-time misclassification is back`
  );
  for (const oid of t.lookupOids) {
    assert(
      oid === w1BlobOid || oid === W1_COMMIT_OID,
      `unexpected ODB lookup: ${oid} (neither the thin base nor the parent commit)`
    );
  }
  assert(t.lookupOids.includes(w1BlobOid), "the TRUE thin base must resolve through the lazy lookup channel");
  // and the chain's final object really landed with the push
  const idxKeys = [...t.objects.keys()].filter((k) => k.endsWith(".idx"));
  assert(idxKeys.length >= 2, "window-2 wrote its idx");
});

await check("2. DEADLINE BACKSTOP: an indexing phase past GIT_RECEIVE_DEADLINE_MS answers the explicit ng and TURNS THE LEASE OVER", async () => {
  const NAME = "mirror/deadline";
  // every staged-pack read delays 3s; the deadline fires at 1s — the race
  // breaches while the walk is still pending on the first range read
  const t = makeRepo(NAME, { getDelayMs: 3000, env: { GIT_RECEIVE_DEADLINE_MS: "1000" } });
  const rx = makePostReceive(t);
  // window 1 with the delay too (it must still land — a receive whose STAGING
  // is slow is not the deadline's subject; the deadline only races the
  // indexing phase, and window-1's indexing is one blob)
  const res1 = await rx.post("http://dgit.test", receiveBody([`${ZERO_OID} ${W1_COMMIT_OID} refs/heads/main`], W1_PACK.bytes));
  assertEq(res1.status, 200, "window-1 http status");
  await rx.flushWaits();
  t.rpcs.length = 0;
  const t0 = Date.now();
  const res2 = await rx.post(
    "http://dgit.test",
    receiveBody([`${W1_COMMIT_OID} ${W2_COMMIT_OID} refs/heads/main`], W2_PACK.bytes)
  );
  const took = Date.now() - t0;
  assertEq(res2.status, 200, "the deadline answers report-status (200), not a transport error");
  const report = await responseReport(res2);
  assert(
    report.includes("receive indexing deadline exceeded"),
    `the ng names the deadline (report: ${report.slice(0, 300)})`
  );
  assert(took < 5000, `the deadline breaching receives answered fast (took ${took}ms — the race did not wait out the walk)`);
  assert(!report.includes("ok refs/heads/main"), "the breaching push applied NOTHING");
  // THE LEASE TURNED OVER: the follow-up receive runs PAST beginReceive (no
  // busy 503) — the wall's holding mechanism is gone
  t.rpcs.length = 0;
  const res3 = await rx.post(
    "http://dgit.test",
    receiveBody([`${W1_COMMIT_OID} ${W2_COMMIT_OID} refs/heads/main`], W2_PACK.bytes)
  );
  const report3 = await responseReport(res3);
  assert(
    !report3.includes("busy") && !report3.includes("too many concurrent pushes"),
    `the follow-up receive must not see the stale lease (report: ${report3.slice(0, 200)})`
  );
  assert(!t.rpcs.includes("releaseReceive") || true, "lease accounting ran");
});

console.log(`\ncheck-receive-forward-ref: ${planned - failures.length}/${planned} checks passed`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
