// PushEvent.origin gate — the request-origin channel on the engine's onPush
// event. Run with tsx, the same mechanism as check-validate-push.mjs (see
// e2e/README.md):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-push-origin.mjs
// Exits non-zero on the first violated assertion.
//
// What makes this honest: the REAL Worker-side receive flow —
// createDurableGit().fetch over the real parse/stage/scan/finalize pipeline
// (real control plane over node:sqlite, R2 staged in memory), with the onPush
// hook wired through a waitUntil-collecting ExecutionContext so the fired
// event can be awaited after the response (the engine fires the hook off the
// response path; a no-op waitUntil like the other checks use would lose it).
//
// Covers, in order:
//   1.  origin flows: a push to http://dgit.test fires the hook with
//       event.origin === "http://dgit.test" (scheme + authority of the LIVE
//       request, derived at the emission site — receivePack holds req).
//   2.  the full authority is carried: port and https scheme survive
//       (https://dgit.test:8443 → "https://dgit.test:8443") — the value is
//       URL.origin of the request, never the bare host.
//   3.  origin rides the FULL event shape: coexists with pusherId/pusherLogin
//       (the internal call argument), repo, updates, commitTime — the whole
//       event object is pinned, so the additive field changed nothing else.
//   4.  deletes-only pushes (no pack bytes) fire the hook with origin too.
//   5.  a throwing onPush hook still never fails an applied push (the
//       origin-bearing event stays off the response path, inside waitUntil).
//   6.  THE ABSENCE LEG (static tripwire, the check-fault-matrix.mjs
//       convention): no request-less emission path exists today — the only
//       emission site is inside receivePack, which always holds a live
//       request — so runtime absence is unreachable through the public flow.
//       The optional contract is pinned structurally instead: the emission
//       site must spread origin CONDITIONALLY (`...(origin !== undefined ?
//       { origin } : {})`) so a future emitter without a parsable request URL
//       omits the key entirely (absent, never null/empty-string), and the
//       `requestOrigin` helper must keep its non-http(s) → undefined guard.
import { DatabaseSync } from "node:sqlite";
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// repo.ts extends DurableObject at module scope — the inert shim (the DO is
// the real control-plane stub below; no cell is ever constructed).
const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

// mod.ts's stagePack (known-length path) and the idx PUT use the workers
// runtime's FixedLengthStream — the minimal contract over a TransformStream
// (same shim as check-correctness-tier.mjs).
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
const STORAGE = "r0";
const REPO = "r0";

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

// ---- fixture builders (fulls only — no deltas needed) -----------------------

function concatParts(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off = off + p.length;
  }
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

function buildPack(objects) {
  const chunks = [];
  const head = new Uint8Array(12);
  head.set(te.encode("PACK"), 0);
  const dv = new DataView(head.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, objects.length);
  chunks.push(head);
  objects.forEach((o) => {
    chunks.push(encodeEntryHeader(TYPE_NUM[o.type], o.data.length));
    chunks.push(pako.deflate(o.data));
  });
  const sha = sha1hex(concatParts(chunks));
  chunks.push(fromHex(sha)); // trailer
  return { bytes: concatParts(chunks), sha };
}

const PERSON = { name: "t", email: "t@t", time: 1700000000, tz: "+0000" };

/** One root-or-child commit with its own blob+tree. */
function commitOf(message, parents, blobText) {
  const blob = te.encode(blobText);
  const blobOid = hashObject("blob", blob);
  const tree = serializeTree([{ mode: "100644", oid: blobOid, name: "f.txt" }]);
  const commit = serializeCommit({ tree: tree.oid, parents, author: PERSON, committer: PERSON, message });
  const pack = buildPack([
    { type: "blob", data: blob },
    { type: "tree", data: tree.data },
    { type: "commit", data: commit.data },
  ]);
  return { oid: commit.oid, pack };
}

const A = commitOf("a root", [], "blob a\n");
const B = commitOf("b child of a", [A.oid], "blob b\n");

// ---- the receive harness (real flow, real control plane, in-memory R2) -----

function makeRepo() {
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
  const t = { db, sql, tx, objects: new Map(), rpcs: [] };
  t.store = new GitStore(sql, { tx });
  t.store.setMeta("repo", STORAGE);
  t.store.setMeta("storage_key", STORAGE);
  t.host = {
    store: t.store,
    storage: { transactionSync: tx, setAlarm: () => Promise.resolve() },
    deletePackObjects: async (keys) => {
      for (const k of keys) t.objects.delete(k);
    },
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
  t.store.setR2(t.bucket, STORAGE);
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

/**
 * POST /git-receive-pack through the REAL createDurableGit().fetch with the
 * onPush hook wired. The ExecutionContext COLLECTS waitUntil promises (the
 * engine fires the hook off the response path); `flushWaits` awaits them so
 * the test can observe the fired events after each response.
 */
function makePostReceive(t, onPush) {
  const waits = [];
  const handler = createDurableGit({ authorize: () => true, onPush });
  const post = (base, body, internal) =>
    handler.fetch(
      new Request(`${base}/${REPO}.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": "application/x-git-receive-pack-request", "content-length": String(body.length) },
        body,
      }),
      t.env,
      { waitUntil: (p) => waits.push(p) },
      internal
    );
  return {
    post,
    flushWaits: async () => {
      await Promise.allSettled(waits);
      waits.length = 0;
    },
  };
}

const mainTip = (t) => t.store.getRef("refs/heads/main");

// ---- the checks --------------------------------------------------------------

await check("1. origin flows: the hook fires with the live request's origin", async () => {
  const t = makeRepo();
  const events = [];
  const rx = makePostReceive(t, (event) => events.push(event));
  const res = await rx.post("http://dgit.test", receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  assertEq(res.status, 200, "http status");
  await rx.flushWaits();
  assertEq(events.length, 1, "one onPush invocation");
  assertEq(events[0].origin, "http://dgit.test", "event.origin = request origin");
  assertEq(typeof events[0].origin, "string", "origin is a string, never null/empty sentinel");
  assertEq(mainTip(t), A.oid, "push applied");
});

await check("2. the full authority is carried: port and https scheme survive", async () => {
  const t = makeRepo();
  const events = [];
  const rx = makePostReceive(t, (event) => events.push(event));
  await rx.post("https://dgit.test:8443", receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  await rx.flushWaits();
  assertEq(events[0].origin, "https://dgit.test:8443", "scheme + authority verbatim");
  // and a second receive on a DIFFERENT origin carries THAT one (no caching
  // of the first origin anywhere on the emission path)
  await rx.post("http://other.host.example", receiveBody([`${A.oid} ${B.oid} refs/heads/main`], B.pack.bytes));
  await rx.flushWaits();
  assertEq(events[1].origin, "http://other.host.example", "per-request origin, not memoized");
  assertEq(mainTip(t), B.oid, "both pushes applied");
});

await check("3. origin rides the full event shape (with the pusher call argument)", async () => {
  const t = makeRepo();
  const events = [];
  const rx = makePostReceive(t, (event) => events.push(event));
  await rx.post(
    "http://dgit.test",
    receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes),
    { pusher: { id: 7, login: "mirroring" } }
  );
  await rx.flushWaits();
  assertEq(events.length, 1, "one onPush invocation");
  assertEq(events[0].repo, REPO, "event.repo");
  assertEq(events[0].pusherId, 7, "event.pusherId");
  assertEq(events[0].pusherLogin, "mirroring", "event.pusherLogin");
  assertEq(events[0].updates, [{ ref: "refs/heads/main", old: ZERO_OID, new: A.oid }], "event.updates");
  assertEq(typeof events[0].commitTime, "number", "event.commitTime present");
  assertEq(events[0].origin, "http://dgit.test", "event.origin alongside the identity fields");
  assertEq(Object.keys(events[0]).sort(), ["commitTime", "origin", "pusherId", "pusherLogin", "repo", "updates"], "exact event key set");
});

await check("4. deletes-only pushes (no pack bytes) fire the hook with origin too", async () => {
  const t = makeRepo();
  const events = [];
  const rx = makePostReceive(t, (event) => events.push(event));
  await rx.post("http://dgit.test", receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  await rx.flushWaits();
  assertEq(events.length, 1, "seed push fired once");
  events.length = 0;
  await rx.post("https://dgit.test", receiveBody([`${A.oid} ${ZERO_OID} refs/heads/main`], null));
  await rx.flushWaits();
  assertEq(events.length, 1, "delete fired the hook");
  assertEq(events[0].origin, "https://dgit.test", "delete event origin");
  assertEq(events[0].updates, [{ ref: "refs/heads/main", old: A.oid, new: ZERO_OID }], "delete updates");
  assertEq(mainTip(t), null, "ref deleted");
});

await check("5. a throwing onPush hook never fails an applied push (origin-bearing event stays in waitUntil)", async () => {
  const t = makeRepo();
  const rx = makePostReceive(t, () => {
    throw new Error("webhook fan-out exploded");
  });
  const res = await rx.post("http://dgit.test", receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  assertEq(res.status, 200, "response unaffected by the hook throw");
  await rx.flushWaits(); // the rejected waitUntil settles here, off the response
  assertEq(mainTip(t), A.oid, "push applied anyway");
});

await check("6. absence leg (static tripwire): conditional spread + non-http(s) guard in src/mod.ts", async () => {
  // No request-less emission path exists today (the only emission site is
  // receivePack, which always holds a live request), so runtime absence is
  // unreachable through the public flow. Pin the structural contract instead:
  const src = readFileSync(fileURLToPath(new URL("../src/mod.ts", import.meta.url)), "utf8");
  // (a) the emission site spreads origin CONDITIONALLY — a future emitter
  //     without a parsable request URL omits the key (never null/"")
  assert(
    src.includes("...(origin !== undefined ? { origin } : {})"),
    "emission site must spread origin conditionally"
  );
  // (b) the helper degrades to undefined for non-http(s) URLs (URL.origin is
  //     the string "null" for exotic schemes — never ship that)
  assert(src.includes('u.protocol === "http:" || u.protocol === "https:"'), "non-http(s) guard present");
  // (c) and only ONE emission site constructs PushEvent (the optional field's
  //     absence semantics stay single-sourced)
  const sites = src.split("const event: PushEvent = {").length - 1;
  assertEq(sites, 1, "exactly one PushEvent construction site");
});

console.log(`\ncheck-push-origin: ${planned - failures.length}/${planned} checks passed`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
