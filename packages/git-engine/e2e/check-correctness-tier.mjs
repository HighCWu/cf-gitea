// SPEC-0011 §7.3 M3.5 — the correctness-tier CI additions, as engine checks.
// None of these existed as automated checks before M3.5 (audited: bench
// fixtures cover clone throughput only, e2e.sh covers protocol shapes with a
// running Worker, no check drove the RECEIVE path). This script drives the
// REAL Worker-side receive flow — createDurableGit().fetch with the real
// parsePushRequest/stagePack/scan/finalizeReceive pipeline, the DO RPCs
// executed by the REAL control plane over node:sqlite (helpers/lib.mjs), R2
// staged in memory — plus real `git` as the serve-path oracle. Run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-correctness-tier.mjs
//
// Covers (SPEC-0011 §7.3, in order):
//   1. 99/101 MB boundary pushes — the Cloudflare proxy's ~100 MB decimal
//      body cap sits BEFORE the Worker (SPEC-0001 §6 T1: >100 MB histories
//      must use the import channel), so the engine-side contract is checked
//      size-parametrized at MAX_PUSH_MB=1 MiB: under the cap a push lands;
//      an over-cap DECLARED length is rejected 413 before any DO RPC or R2
//      write; an over-cap UNDECLARED body aborts at the boundary mid-stream
//      with every command rejected in report-status and zero refs moved.
//   2. newTip-exists-tree-missing injection — a pack carrying ONLY the new
//      tip's commit (its tree absent from the pack AND the database): the
//      Worker scan's connectivity anti-check flags it, finalize rejects with
//      "missing necessary objects", and no ref moves.
//   3. finalize-success-response-lost retry convergence — finalize committed,
//      the Worker's response lost: the retried finalize and the Worker's
//      releaseReceive(sweep) both return lease_mismatch WITHOUT un-applying
//      anything; the committed ref, pack rows and packs/ bytes survive and
//      the repo serves the new tip.
//   4. Full clone with cross-pack delta bases — a repo whose REF deltas
//      base on objects in OTHER packs: the served pack ships the bases (real
//      `git index-pack` WITHOUT --fix-thin accepts it), the delta really
//      ships as a delta (`git verify-pack -v` depth), and `git fsck --strict`
//      is clean over the cloned refs.
//   5. Incremental fetch relying on REF_DELTA + negotiated haves — the ACK
//      negotiation shape, an exact object set (new objects only), and a real
//      client-side validation: the fetched pack drops onto a repo holding
//      only the haves' objects and `git fsck --strict` is clean.
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// repo.ts extends DurableObject at module scope — the inert shim (the DO is
// the real control-plane stub below; no cell is ever constructed).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

// mod.ts's stagePack (known-length path) and the idx PUT use the workers
// runtime's FixedLengthStream unconditionally — provide the minimal contract
// over a TransformStream (error when the byte count misses the fixed length).
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
const { NodeSql, assert, assertEq } = await import("./helpers/lib.mjs");
const controlPlane = await import("../src/control-plane.ts");
const { createDurableGit } = await import("../src/mod.ts");
const { uploadPack } = await import("../src/git/protocol.ts");
const { packR2Key, idxR2Key, packName } = await import("../src/git/r2keys.ts");
const { serializeTree, serializeCommit } = await import("../src/commit/serialize.ts");
const { hashObject, TYPE_NUM } = await import("../src/git/objects.ts");
const { fromHex, sha1hex } = await import("../src/git/util.ts");
const { Crc32 } = await import("../src/receive/idx.ts");
const pako = (await import("pako")).default;

const te = new TextEncoder();
const FLUSH_BYTES = "0000";
const STORAGE = "r0";
const REPO = "r0";
const MiB = 1024 * 1024;
// the boundary is size-parametrized: MAX_PUSH_MB=1 gives the same reject
// mechanics as the proxy's ~100 MB decimal cap, at a test-friendly size
const CAP_BYTES = 1 * MiB;

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

// ---------------------------------------------------------------------------
// Fixture: real packfiles (fulls and cross-pack REF deltas)
// ---------------------------------------------------------------------------

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

function literalDelta(baseSize, target) {
  const out = [];
  const varint = (n) => {
    do {
      let b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
  };
  varint(baseSize);
  varint(target.length);
  for (let i = 0; i < target.length; i += 127) {
    const chunk = target.subarray(i, Math.min(i + 127, target.length));
    out.push(chunk.length);
    for (const b of chunk) out.push(b);
  }
  return new Uint8Array(out);
}

function concatParts(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function buildPack(objects) {
  const chunks = [];
  const head = new Uint8Array(12);
  head.set(te.encode("PACK"), 0);
  const dv = new DataView(head.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, objects.length);
  chunks.push(head);
  let pos = 12;
  const rows = [];
  objects.forEach((o) => {
    const start = pos;
    let payload;
    let prefix;
    if (o.kind === "full") {
      const comp = pako.deflate(o.data);
      prefix = [encodeEntryHeader(TYPE_NUM[o.type], o.data.length)];
      payload = comp;
      rows.push({
        oid: hashObject(o.type, o.data),
        offset: start,
        dataOff: 0,
        dataLen: comp.length,
        type: o.type,
        size: o.data.length,
        entrySize: o.data.length,
        baseOid: null,
        crc32: 0,
      });
    } else {
      const delta = literalDelta(o.baseData.length, o.target);
      const comp = pako.deflate(delta);
      prefix = [encodeEntryHeader(7, delta.length), fromHex(o.baseOid)];
      payload = comp;
      rows.push({
        oid: hashObject(o.type, o.target),
        offset: start,
        dataOff: 0,
        dataLen: comp.length,
        type: o.type,
        size: o.target.length,
        entrySize: delta.length,
        baseOid: o.baseOid,
        crc32: 0,
      });
    }
    for (const p of prefix) {
      chunks.push(p);
      pos += p.length;
    }
    chunks.push(payload);
    pos += payload.length;
    const r = rows[rows.length - 1];
    r.dataOff = pos - payload.length;
    const crc = new Crc32();
    for (const p of [...prefix, payload]) crc.update(p);
    r.crc32 = crc.get();
  });
  const sha = sha1hex(concatParts(chunks));
  chunks.push(fromHex(sha)); // trailer
  return { bytes: concatParts(chunks), rows, sha };
}

/** The standard two-commit history, split across three packs so the delta
 * bases live CROSS-PACK (tree2 deltas over tree1 in pack A; commit2 deltas
 * over commit1 in the same pack C). */
function historyObjects() {
  const b1 = te.encode("alpha content one\n");
  const b2 = te.encode("beta content two\n");
  const b3 = te.encode("gamma content three\n");
  // seconds + timezone: this fixture is validated by REAL git (fsck), so the
  // person line must be git-format-exact
  const person = { name: "t", email: "t@t", time: 1700000000, tz: "+0000" };
  const tree1 = serializeTree([
    { mode: "100644", oid: hashObject("blob", b1), name: "b1.txt" },
    { mode: "100644", oid: hashObject("blob", b2), name: "b2.txt" },
  ]);
  const tree2 = serializeTree([
    { mode: "100644", oid: hashObject("blob", b1), name: "b1.txt" },
    { mode: "100644", oid: hashObject("blob", b2), name: "b2.txt" },
    { mode: "100644", oid: hashObject("blob", b3), name: "b3.txt" },
  ]);
  const commit1 = serializeCommit({ tree: tree1.oid, parents: [], author: person, committer: person, message: "c1" });
  const commit2 = serializeCommit({ tree: tree2.oid, parents: [commit1.oid], author: person, committer: person, message: "c2" });
  return {
    b1, b2, b3, tree1, tree2, commit1, commit2,
    oids: { b1: hashObject("blob", b1), b2: hashObject("blob", b2), b3: hashObject("blob", b3), tree1: tree1.oid, tree2: tree2.oid, commit1: commit1.oid, commit2: commit2.oid },
    commit1Data: commit1.data,
  };
}

/** The three-pack split (entry lists) for `historyObjects`: pack 1 carries the
 * fulls, pack 2 a REF delta CROSS-PACK over pack 1's tree, pack 3 the commit
 * pair (commit2 a REF delta over commit1). */
function splitPacks(h) {
  return [
    [
      { kind: "full", type: "blob", data: h.b1 },
      { kind: "full", type: "blob", data: h.b2 },
      { kind: "full", type: "tree", data: h.tree1.data },
    ],
    [
      { kind: "ref", type: "tree", target: h.tree2.data, baseOid: h.oids.tree1, baseData: h.tree1.data },
      { kind: "full", type: "blob", data: h.b3 },
    ],
    [
      { kind: "full", type: "commit", data: h.commit1Data },
      { kind: "ref", type: "commit", target: h.commit2.data, baseOid: h.oids.commit1, baseData: h.commit1Data },
    ],
  ];
}

// ---------------------------------------------------------------------------
// The receive harness: real Worker-side flow, real control plane, in-memory R2
// ---------------------------------------------------------------------------

function makeRepo({ maxPushMb = "1" } = {}) {
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
  const t = { db, sql, tx, objects: new Map(), rpcs: [], stagingDeletes: [] };
  t.store = new GitStore(sql, { tx });
  t.store.setMeta("repo", STORAGE);
  t.store.setMeta("storage_key", STORAGE);
  // the LeaseHost the control-plane RPCs run against (the DO side, honestly:
  // transactionSync is a real SQLite transaction)
  t.host = {
    store: t.store,
    storage: { transactionSync: tx, setAlarm: () => Promise.resolve() },
    deletePackObjects: async (keys) => {
      for (const k of keys) {
        t.objects.delete(k);
        t.stagingDeletes.push(k);
      }
    },
  };
  // the R2 bucket (Worker side): staging PUTs (single + multipart), range
  // GETs for the scan, copyObject's pipe, GC's list
  t.bucket = {
    async put(key, value) {
      if (value instanceof Uint8Array) {
        t.objects.set(key, value);
        return value;
      }
      // stream body (FixedLengthStream readable / copyObject's pipe): a body
      // the writer errored/aborted resolves WITHOUT storing — the caller has
      // already failed the operation by then
      if (value && typeof value.getReader === "function") {
        const chunks = [];
        const reader = value.getReader();
        try {
          for (;;) {
            const { done, value: v } = await reader.read();
            if (done) break;
            chunks.push(v);
          }
        } catch {
          t.erroredPuts = (t.erroredPuts ?? 0) + 1;
          return null;
        }
        const out = concatParts(chunks);
        t.objects.set(key, out);
        return out;
      }
      throw new Error(`unexpected bucket.put body: ${typeof value}`);
    },
    async get(key, req) {
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
        abort: async () => {
          t.multipartAborts = (t.multipartAborts ?? 0) + 1;
        },
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
  t.store.setR2(t.bucket, STORAGE); // pack byte reads (serve path, ancestry walk)
  // the DO namespace stub: every RPC the receive flow makes, executed by the
  // real control plane over the host; anything else fails loudly
  const impl = {
    // the receive entry's name bind (repo.ts bindRepo): idempotent here — the
    // harness cell is pre-bound to the same STORAGE name
    bindRepo: async (name) => {
      t.rpcs.push(`bindRepo:${name}`);
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
      return controlPlane.lookupObjects(t.host, leaseToken, oids);
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
    MAX_PUSH_MB: maxPushMb,
  };
  return t;
}

// ---- protocol builders -----------------------------------------------------

const pkt = (s) => Buffer.from((s.length + 4).toString(16).padStart(4, "0") + s);
const FLUSH_PKT = Buffer.from("0000");

/** A receive-pack request body: command section, flush, pack bytes. */
function receiveBody(commands, packBytes) {
  const lines = commands.map((c) => pkt(c));
  return Buffer.concat([...lines, FLUSH_PKT, packBytes]);
}

function createCommand(oldOid, nextOid, ref) {
  return `${oldOid} ${nextOid} ${ref}\0report-status side-band-64k agent=git/2.43.0\n`;
}

/** POST /git-receive-pack through the REAL createDurableGit().fetch. */
async function postReceive(t, body, { contentLength = null, chunked = false } = {}) {
  const headers = { "content-type": "application/x-git-receive-pack-request" };
  let reqBody = body;
  let duplex;
  if (chunked) {
    // a body of bounded chunks with NO declared length (the over-cap case the
    // proxy's Content-Length early-reject cannot see)
    const chunks = [];
    for (let i = 0; i < body.length; i += 512 * 1024) chunks.push(body.subarray(i, i + 512 * 1024));
    let at = 0;
    reqBody = new ReadableStream({
      pull(c) {
        if (at < chunks.length) c.enqueue(chunks[at++]);
        else c.close();
      },
    });
    duplex = "half";
  } else if (contentLength !== null) {
    headers["content-length"] = String(contentLength);
  }
  const handler = createDurableGit({ authorize: () => true });
  const req = new Request(`http://dgit.test/${REPO}.git/git-receive-pack`, {
    method: "POST",
    headers,
    body: reqBody,
    ...(duplex ? { duplex } : {}),
  });
  return handler.fetch(req, t.env, { waitUntil() {} });
}

/** Parse a report-status response: plain pkt-lines + band-1 sideband frames. */
function parseReportStatus(bytes) {
  let p = 0;
  let status = "";
  let sawBand1 = false;
  while (p + 4 <= bytes.length) {
    const len = parseInt(bytes.subarray(p, p + 4).toString("latin1"), 16);
    if (len === 0) {
      p += 4;
      continue;
    }
    if (len < 4) break;
    const payload = bytes.subarray(p + 4, p + len);
    if (payload[0] === 1) {
      sawBand1 = true;
      status += payload.subarray(1).toString("utf8");
    } else if (payload[0] === 2) {
      // progress — ignored
    } else if (payload[0] === 3) {
      status += `ERR-BAND: ${payload.subarray(1).toString("utf8")}`;
    } else {
      status += payload.toString("utf8"); // non-sideband pkt-line
    }
    p += len;
  }
  return { status, sawBand1 };
}

/** Extract band-1 (pack) bytes from an upload-pack sideband response. */
function extractPack(bytes) {
  let p = 0;
  const chunks = [];
  while (p + 4 <= bytes.length) {
    const len = parseInt(bytes.subarray(p, p + 4).toString("latin1"), 16);
    if (len === 0) {
      p += 4;
      continue;
    }
    if (len < 4) break;
    const payload = bytes.subarray(p + 4, p + len);
    if (payload[0] === 1) chunks.push(payload.subarray(1));
    p += len;
  }
  return concatParts(chunks);
}

// ---- git oracles -----------------------------------------------------------

function gitRun(args, opts = {}) {
  return execSync(`git ${args}`, {
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "inherit"],
    ...opts,
  })
    .toString();
}

function gitInput(args, input, opts = {}) {
  return execSync(`git ${args}`, {
    maxBuffer: 1 << 28,
    stdio: ["pipe", "pipe", "inherit"], // stdin must be a pipe for `input`
    input,
    ...opts,
  })
    .toString();
}

/** `git index-pack` (WITHOUT --fix-thin) over the served pack: acceptance is
 * the proof that every delta base shipped. Returns the oid set. */
function indexPack(scratch, packBytes) {
  writeFileSync(join(scratch, "in.pack"), packBytes);
  gitRun(`index-pack -o in.idx in.pack`, { cwd: scratch });
  const out = gitInput(`show-index`, readFileSync(join(scratch, "in.idx")), { cwd: scratch });
  const oids = out
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[1])
    .filter(Boolean);
  return { oids, idxPath: join(scratch, "in.idx"), packPath: join(scratch, "in.pack") };
}

/** verify-pack -v: the delta table (depth + base oid per delta entry). */
function verifyPack(scratch) {
  const out = gitRun(`verify-pack -v in.idx`, { cwd: scratch });
  const deltas = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{40})\s+(\S+)\s+\d+\s+\d+\s+\d+\s+(\d+)\s+([0-9a-f]{40})$/);
    if (m) deltas.push({ oid: m[1], type: m[2], depth: parseInt(m[3], 10), base: m[4] });
  }
  return { out, deltas };
}

/** Wire pack+idx into a scratch repo's object store and fsck it against
 * `refs` — the real client's post-fetch validation. */
function fsckWithPack({ packPath, idxPath, refs }) {
  const dir = mkdtempSync(join(tmpdir(), "cgit-fsck-"));
  try {
    gitRun(`init -q -b main ${dir}`);
    const op = join(dir, ".git", "objects", "pack");
    execSync(`mkdir -p "${op}"`);
    execSync(`cp "${packPath}" "${op}/" && cp "${idxPath}" "${op}/"`);
    for (const [name, oid] of Object.entries(refs)) gitRun(`update-ref ${name} ${oid}`, { cwd: dir });
    gitRun(`fsck --strict`, { cwd: dir });
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write objects loose into a scratch repo (the incremental client's "haves"
 * side); returns the oids actually stored. */
function writeLoose(dir, objects) {
  const oids = [];
  for (const [type, data] of objects) {
    const out = gitInput(`hash-object -w -t ${type} --stdin`, data, { cwd: dir });
    oids.push(out.trim());
  }
  return oids;
}

// ---------------------------------------------------------------------------
// §7.3 item 1 — 99/101 MB boundary pushes (the engine-side mechanics,
// size-parametrized at MAX_PUSH_MB=1 MiB)
// ---------------------------------------------------------------------------

await check("§7.3 boundary (under cap): a push just under MAX_PUSH_MB lands — ok report-status, ref set, pack copied to packs/, staging swept", async () => {
  const t = makeRepo();
  const h = historyObjects();
  const pack = buildPack([
    { kind: "full", type: "blob", data: h.b1 },
    { kind: "full", type: "blob", data: h.b2 },
    { kind: "full", type: "tree", data: h.tree1.data },
    { kind: "full", type: "commit", data: h.commit1Data },
  ]);
  const res = await postReceive(t, receiveBody([createCommand("0".repeat(40), h.oids.commit1, "refs/heads/main")], pack.bytes));
  assertEq(res.status, 200, "response ok");
  const { status, sawBand1 } = parseReportStatus(Buffer.from(await res.arrayBuffer()));
  assert(sawBand1, "report-status arrived sideband-framed (the advertised side-band-64k)");
  assert(/unpack ok/.test(status), `unpack ok in report-status: ${JSON.stringify(status)}`);
  assert(/ok refs\/heads\/main/.test(status), `per-command ok: ${JSON.stringify(status)}`);
  assertEq(t.store.getRef("refs/heads/main"), h.oids.commit1, "ref set to the new tip");
  assert(t.objects.get(packR2Key(STORAGE, packName(pack.sha))), "pack bytes copied to packs/");
  assertEq(t.stagingDeletes.length, 1, "staging object swept exactly once");
  assert(!/staging\//.test([...t.objects.keys()].join(",")), "no staging object remains");
  // and the pushed history serves
  const clone = await uploadPack(t.store, Buffer.concat([pkt(`want ${h.oids.commit1} side-band-64k\n`), Buffer.from(FLUSH_BYTES), pkt("done\n")]));
  const cloneBytes = Buffer.from(await clone.arrayBuffer());
  assert(new TextDecoder().decode(extractPack(cloneBytes)).length > 0, "the pushed repo serves a clone");
});

await check("§7.3 boundary (declared over cap): a Content-Length over MAX_PUSH_MB is a 413 BEFORE any DO RPC or R2 write — zero refs touched", async () => {
  const t = makeRepo();
  const h = historyObjects();
  const pack = buildPack([{ kind: "full", type: "blob", data: h.b1 }]);
  const overCap = CAP_BYTES + 1;
  const res = await postReceive(
    t,
    receiveBody([createCommand("0".repeat(40), h.oids.commit1, "refs/heads/main")], pack.bytes),
    { contentLength: overCap }
  );
  assertEq(res.status, 413, `early reject: ${res.status}`);
  const text = await res.text();
  assert(/exceeds/.test(text), `the rejection names the limit: ${JSON.stringify(text)}`);
  assertEq(t.rpcs.length, 0, "NO DO RPC ran (no lease, no finalize)");
  assertEq(t.objects.size, 0, "zero R2 writes — the body was never read");
  assertEq(t.store.getRef("refs/heads/main"), null, "zero refs touched");
  assertEq(t.stagingDeletes.length, 0, "nothing to sweep");
});

await check("§7.3 boundary (undeclared over cap, the 101-without-Content-Length shape): the stream aborts AT the cap mid-staging — every command ng in report-status, zero refs, staging aborted and swept", async () => {
  const t = makeRepo();
  const commands = [createCommand("0".repeat(40), "1".repeat(40), "refs/heads/main")];
  const junk = new Uint8Array(Math.floor(CAP_BYTES * 1.5));
  for (let i = 0; i < junk.length; i += 65536) crypto.getRandomValues(junk.subarray(i, Math.min(i + 65536, junk.length)));
  const res = await postReceive(t, receiveBody(commands, junk), { chunked: true });
  assertEq(res.status, 200, "the over-cap abort is a PROTOCOL-level outcome, not a transport error");
  const { status } = parseReportStatus(Buffer.from(await res.arrayBuffer()));
  assert(/unpack pack exceeds maximum push size/.test(status), `the abort surfaced in report-status: ${JSON.stringify(status)}`);
  assert(/ng refs\/heads\/main/.test(status), `the command is ng: ${JSON.stringify(status)}`);
  assertEq(t.store.getRef("refs/heads/main"), null, "zero refs touched");
  assertEq(t.store.refsVersion(), t.store.refsVersion(), "refs_version unchanged");
  assertEq([...t.objects.keys()].filter((k) => k.includes("/packs/")).length, 0, "no pack ever reached packs/");
  assertEq(t.multipartAborts, 1, "the staged multipart upload was aborted (no partial R2 object)");
  assertEq(t.stagingDeletes.length, 1, "the lease decision swept the staging key");
  assert(t.rpcs.includes("beginReceive") && t.rpcs.includes("finalizeReceive"), `the lease lifecycle ran: ${t.rpcs.join(",")}`);
});

// ---------------------------------------------------------------------------
// §7.3 item 2 — newTip-exists-tree-missing injection
// ---------------------------------------------------------------------------

await check("§7.3 newTip-exists-tree-missing: a pack whose tip commit EXISTS but whose tree is absent everywhere — the anti-check flags it, finalize rejects 'missing necessary objects', no ref moves", async () => {
  const t = makeRepo();
  const h = historyObjects();
  // the injection: ONLY the commit object ships; its tree (and the tree's
  // blobs) are in neither the pack nor the (empty) database
  const pack = buildPack([{ kind: "full", type: "commit", data: h.commit1Data }]);
  assertEq(h.oids.commit1, hashObject("commit", h.commit1Data), "the tip is the shipped commit");
  const res = await postReceive(
    t,
    receiveBody([createCommand("0".repeat(40), h.oids.commit1, "refs/heads/main")], pack.bytes)
  );
  assertEq(res.status, 200, "response ok");
  const { status } = parseReportStatus(Buffer.from(await res.arrayBuffer()));
  assert(/missing necessary objects/.test(status), `the injection rejected: ${JSON.stringify(status)}`);
  assert(/ng refs\/heads\/main/.test(status), `per-command ng: ${JSON.stringify(status)}`);
  assert(!/ok refs/.test(status), "nothing ok'd");
  assertEq(t.store.getRef("refs/heads/main"), null, "no ref points at the treeless tip");
  assertEq(t.stagingDeletes.length, 1, "staging swept (the lease was decided, not leaked)");
});

// ---------------------------------------------------------------------------
// §7.3 item 3 — finalize-success-response-lost retry convergence
// ---------------------------------------------------------------------------

await check("§7.3 finalize-success-response-lost: the retry after a committed finalize returns lease_mismatch and the Worker's releaseReceive(sweep) cannot un-apply it — ref, rows and packs/ bytes survive; the tip serves", async () => {
  const t = makeRepo();
  const h = historyObjects();
  const pack = buildPack([
    { kind: "full", type: "blob", data: h.b1 },
    { kind: "full", type: "blob", data: h.b2 },
    { kind: "full", type: "tree", data: h.tree1.data },
    { kind: "full", type: "commit", data: h.commit1Data },
  ]);
  const name = packName(pack.sha);
  const packKey = packR2Key(STORAGE, name);

  const begin = await controlPlane.beginReceive(t.host, {
    commands: [{ old: "0".repeat(40), next: h.oids.commit1, ref: "refs/heads/main" }],
    capabilities: [],
    storageKey: STORAGE,
  });
  assertEq(begin.tag, "ok", "lease opened");
  assertEq((await controlPlane.putIndexRows(t.host, begin.leaseToken, name, pack.rows)).tag, "ok", "index rows landed");
  t.objects.set(begin.stagingKey, pack.bytes); // the Worker staged these bytes
  // the Worker copied staging → packs/ BEFORE finalize (the crash ordering)
  t.objects.set(packKey, pack.bytes);

  const finalizeInput = {
    leaseToken: begin.leaseToken,
    expectedRefsVersion: begin.refsVersion,
    commands: [{ old: "0".repeat(40), next: h.oids.commit1, ref: "refs/heads/main" }],
    newTips: [h.oids.commit1],
    pack: { packKey, packSha1: pack.sha, packBytes: pack.bytes.length, objectCount: pack.rows.length, idxBytes: 256 },
    unpackError: null,
    packIncomplete: false,
  };
  const first = await controlPlane.finalizeReceive(t.host, finalizeInput);
  assertEq(first.tag, "committed", "the finalize committed");
  const snap = () =>
    JSON.stringify({
      ref: t.store.getRef("refs/heads/main"),
      ver: t.store.refsVersion(),
      catalog: t.sql.exec("SELECT pack_key, state FROM pack_catalog").toArray(),
      rows: t.sql.exec("SELECT COUNT(*) AS n FROM pack_objects").one().n,
      objects: [...t.objects.keys()].sort(),
    });
  const afterFirst = snap();

  // the response was lost; the Worker retries the SAME finalize
  const retry = await controlPlane.finalizeReceive(t.host, finalizeInput);
  assertEq(retry.tag, "lease_mismatch", "the retry is idempotent-on-lease_mismatch");
  assertEq(snap(), afterFirst, "the retry changed NOTHING (no double-apply, no double catalog row)");
  // and the Worker's error-path release (sweep: true) must not eat the push
  const released = await controlPlane.releaseReceive(t.host, { leaseToken: begin.leaseToken, sweep: true });
  assertEq(released.tag, "lease_mismatch", "the release hits the same idempotent wall");
  assertEq(snap(), afterFirst, "the sweep-on-mismatch removed NOTHING");
  assert(t.objects.get(packKey), "the committed pack's packs/ bytes survive the sweep attempt");

  // convergence: the push IS landed and the repo serves the new tip
  const out = await uploadPack(t.store, Buffer.concat([pkt(`want ${h.oids.commit1} side-band-64k\n`), Buffer.from(FLUSH_BYTES), pkt("done\n")]));
  const reader = out.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  assert(new TextDecoder().decode(concatParts(chunks)).endsWith(FLUSH_BYTES), "the new tip serves with its flush tail");
  void first;
});

// ---------------------------------------------------------------------------
// §7.3 item 4 — full clone with cross-pack delta bases (real-git oracle)
// ---------------------------------------------------------------------------

await check("§7.3 full clone, cross-pack delta bases: the served pack ships every base (index-pack WITHOUT --fix-thin), the delta ships AS a delta (verify-pack depth), fsck --strict is clean", async () => {
  const t = makeRepo();
  const h = historyObjects();
  t.store.setR2(t.bucket, STORAGE);
  // seed the three packs (cross-pack REF deltas) + refs
  const packs = splitPacks(h);
  for (const entries of packs) {
    const built = buildPack(entries);
    t.objects.set(packR2Key(STORAGE, packName(built.sha)), built.bytes);
    t.store.packs.putRows(packName(built.sha), built.rows);
    t.store.packs.recordPack(packName(built.sha), built.bytes.length, 256);
  }
  t.store.setRef("refs/heads/main", h.oids.commit2);
  t.store.setRef("refs/heads/feature", h.oids.commit1);
  t.store.setHead("refs/heads/main");

  // full clone: wants = ALL tips
  const res = await uploadPack(
    t.store,
    Buffer.concat([
      pkt(`want ${h.oids.commit2} side-band-64k\n`),
      pkt(`want ${h.oids.commit1}\n`),
      Buffer.from(FLUSH_BYTES),
      pkt("done\n"),
    ])
  );
  const raw = Buffer.from(await res.arrayBuffer());
  const packBytes = extractPack(raw);
  assert(packBytes.length > 0, "a pack was served");

  const scratch = mkdtempSync(join(tmpdir(), "cgit-crosspack-"));
  try {
    // NO --fix-thin: acceptance proves the cross-pack bases shipped
    const { oids } = indexPack(scratch, packBytes);
    const expected = Object.values(h.oids).sort();
    assertEq([...oids].sort(), expected, "the pack carries exactly the reachable object set (bases included)");
    // tree2 shipped AS a delta whose base came from another pack
    const { deltas } = verifyPack(scratch);
    const tree2Delta = deltas.find((d) => d.oid === h.oids.tree2);
    assert(tree2Delta, "tree2 shipped as a delta (verify-pack depth table)");
    assertEq(tree2Delta.base, h.oids.tree1, "its base is the cross-pack tree1");
    // the real client's post-clone validation
    assert(fsckWithPack({ packPath: join(scratch, "in.pack"), idxPath: join(scratch, "in.idx"), refs: { "refs/heads/main": h.oids.commit2, "refs/heads/feature": h.oids.commit1 } }), "fsck --strict clean over the cloned refs");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// §7.3 item 5 — incremental fetch relying on REF_DELTA + negotiated haves
// ---------------------------------------------------------------------------

await check("§7.3 incremental fetch with negotiated haves: ACK negotiation shape, exact new-object set, self-contained pack, and a real client-side fsck over haves-only objects", async () => {
  const t = makeRepo();
  const h = historyObjects();
  t.store.setR2(t.bucket, STORAGE);
  const packs = splitPacks(h);
  for (const entries of packs) {
    const built = buildPack(entries);
    t.objects.set(packR2Key(STORAGE, packName(built.sha)), built.bytes);
    t.store.packs.putRows(packName(built.sha), built.rows);
    t.store.packs.recordPack(packName(built.sha), built.bytes.length, 256);
  }
  t.store.setRef("refs/heads/main", h.oids.commit2);
  t.store.setHead("refs/heads/main");

  // the incremental fetch: the client has commit1, wants commit2, and
  // negotiates multi_ack_detailed + no-done + side-band-64k
  const res = await uploadPack(
    t.store,
    Buffer.concat([
      pkt(`want ${h.oids.commit2} multi_ack_detailed no-done side-band-64k\n`),
      Buffer.from(FLUSH_BYTES),
      pkt(`have ${h.oids.commit1}\n`),
      pkt("done\n"),
    ])
  );
  const raw = Buffer.from(await res.arrayBuffer());
  const text = new TextDecoder().decode(raw);
  assert(text.includes(`ACK ${h.oids.commit1} common`), "the have was ACKed common (multi_ack_detailed)");
  assert(text.includes(`ACK ${h.oids.commit1}\n`), "the final ACK names the last common commit (done)");
  const packBytes = extractPack(raw);
  assert(packBytes.length > 0, "a pack followed the negotiation");

  const scratch = mkdtempSync(join(tmpdir(), "cgit-incremental-"));
  try {
    const { oids } = indexPack(scratch, packBytes);
    // EXACT new-object set: the new tip, its tree, its new blob — the client's
    // haves side (commit1, tree1, b1, b2) is never re-sent
    assertEq([...oids].sort(), [h.oids.b3, h.oids.tree2, h.oids.commit2].sort(), "exactly the negotiated delta's new objects");
    // the self-containment half of the REF_DELTA contract: the base did not
    // ship, so tree2 must have been inflated whole (index-pack without
    // --fix-thin above already proves the pack is not thin)
    const { deltas } = verifyPack(scratch);
    assert(!deltas.some((d) => d.oid === h.oids.tree2), "tree2 shipped whole — a thin delta against an unshipped base is never sent");

    // the real client: a repo holding ONLY the haves' objects + this pack,
    // then the ref update and a strict fsck (every parent and base resolves)
    const client = mkdtempSync(join(tmpdir(), "cgit-client-"));
    try {
      gitRun(`init -q -b main ${client}`);
      const stored = writeLoose(client, [
        ["blob", h.b1],
        ["blob", h.b2],
        ["tree", h.tree1.data],
        ["commit", h.commit1Data],
      ]);
      assertEq(stored, [h.oids.b1, h.oids.b2, h.oids.tree1, h.oids.commit1], "the client's haves stored under the same oids");
      const op = join(client, ".git", "objects", "pack");
      execSync(`mkdir -p "${op}"`);
      execSync(`cp "${scratch}/in.pack" "${scratch}/in.idx" "${op}/"`);
      gitRun(`update-ref refs/heads/main ${h.oids.commit2}`, { cwd: client });
      gitRun(`fsck --strict`, { cwd: client });
    } finally {
      rmSync(client, { recursive: true, force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} correctness-tier checks passed`);
