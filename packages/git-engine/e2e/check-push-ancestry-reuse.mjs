// The push ancestry walk's reuse contract (the receive-busy cost map's β
// arm): classifyReceive and finalize's validatePush walked the SAME bounded
// isAncestor over the SAME (old,next) — the verdict now rides the finalize
// input instead of being walked twice. Run with tsx, the same mechanism as
// check-validate-push.mjs:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-push-ancestry-reuse.mjs
// Exits non-zero when any check fails.
//
// Covers:
//   reuse  the unit contract: validatePush TRUSTS authoritative kinds — a
//          kind that contradicts the graph flips the forced flag without a
//          walk (this is the discriminator proving the verdict was reused,
//          not re-walked; before the reuse the extra argument was ignored
//          and both twins walked).
//   reuse  equivalence: for real FF / force / create / delete / mixed
//          sections, validatePush with classifyReceive's kinds produces the
//          SAME decisions as its own walk (the reused verdict equals the
//          walked verdict — same pure function, same immutable graph).
//   flow   through the REAL receive pipeline (createDurableGit().fetch →
//          real control plane, the check-validate-push.mjs posture): the
//          reused verdict is behavior-identical — a fast-forward stamps NO
//          gc-pending (a misaligned/over-eager kinds array would flip FF to
//          forced and stamp it: this pin catches exactly that regression),
//          a force stamps it, and a hook-filtered section re-aligns the
//          kinds to the commands finalize actually receives.

const { DatabaseSync } = await import("node:sqlite");
const { register } = await import("node:module");

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
const { NodeSql, assert, assertEq } = await import("./helpers/lib.mjs");
const controlPlane = await import("../src/control-plane.ts");
const { validatePush, isAncestor } = await import("../src/git/protocol.ts");
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

// ---- fixture builders (fulls only — no deltas needed for ancestry shapes) --

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

/** One root-or-child commit with its own blob+tree: `parents` are oids that
 *  exist server-side by the time the pack is pushed. `pieces` carries the
 *  raw objects so the unit harness can land them loose. */
function commitOf(message, parents, blobText) {
  const blob = te.encode(blobText);
  const blobOid = hashObject("blob", blob);
  const tree = serializeTree([{ mode: "100644", oid: blobOid, name: "f.txt" }]);
  const commit = serializeCommit({ tree: tree.oid, parents, author: PERSON, committer: PERSON, message });
  const objects = [
    { type: "blob", data: blob, oid: blobOid },
    { type: "tree", data: tree.data, oid: tree.oid },
    { type: "commit", data: commit.data, oid: commit.oid },
  ];
  const pack = buildPack([
    { type: "blob", data: blob },
    { type: "tree", data: tree.data },
    { type: "commit", data: commit.data },
  ]);
  return { oid: commit.oid, parents, message, objects, pack };
}

// A: root. B: child of A (fast-forward shape). C: a DIVERGENT root (rewrite
// shape — pushing it over B is a force by ancestry).
const A = commitOf("a root", [], "blob a\n");
const B = commitOf("b child of a", [A.oid], "blob b\n");
const C = commitOf("c divergent root", [], "blob c\n");

// ---- the unit harness (direct GitStore — no pipeline) ----------------------

function makeStore() {
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
  const t = { db, sql, tx };
  t.store = new GitStore(sql, { tx });
  t.store.setMeta("repo", STORAGE);
  t.store.setMeta("storage_key", STORAGE);
  t.host = {
    store: t.store,
    storage: { transactionSync: tx, setAlarm: () => Promise.resolve() },
    deletePackObjects: async () => {},
  };
  return t;
}

/** Land A + B + C's objects loose so store.get resolves the walks. */
function seedAncestry(store) {
  for (const c of [A, B, C]) {
    for (const o of c.objects) store.put(o.oid, o.type, o.data);
  }
  store.setRef("refs/heads/main", A.oid);
  store.setHead("refs/heads/main");
}

// ---- the flow harness (real pipeline — copied from check-validate-push.mjs)

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
    bindRepo: async (name) => {
      if (t.store.getMeta("repo") !== name) t.store.setMeta("repo", name);
    },
    beginReceive: async (input) => controlPlane.beginReceive(t.host, input),
    putIndexRows: async (leaseToken, name, rows) => controlPlane.putIndexRows(t.host, leaseToken, name, rows),
    lookupObjects: async (leaseToken, oids) => controlPlane.lookupObjects(t.host, leaseToken, oids),
    classifyReceive: async (input) => controlPlane.classifyReceive(t.host, input),
    finalizeReceive: async (input) => {
      t.finalizeInputs.push(input);
      return controlPlane.finalizeReceive(t.host, input);
    },
    releaseReceive: async (input) => controlPlane.releaseReceive(t.host, input),
  };
  t.finalizeInputs = [];
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

/** POST /git-receive-pack through the REAL createDurableGit().fetch. */
async function postReceive(t, body, internal) {
  const handler = createDurableGit({ authorize: () => true });
  const req = new Request(`http://dgit.test/${REPO}.git/git-receive-pack`, {
    method: "POST",
    headers: { "content-type": "application/x-git-receive-pack-request", "content-length": String(body.length) },
    body,
  });
  return handler.fetch(req, t.env, { waitUntil() {} }, internal);
}

/** Strip one layer of pkt-line framing (band-1/band-3 through, band-2
 *  dropped) — exactly one level per call. */
function unframe(bytes) {
  bytes = Buffer.from(bytes);
  const out = [];
  let p = 0;
  while (p + 4 <= bytes.length) {
    const len = parseInt(bytes.subarray(p, p + 4).toString("latin1"), 16);
    if (len === 0) {
      p += 4;
      continue;
    }
    if (len < 4) break;
    const payload = bytes.subarray(p + 4, p + len);
    if (payload[0] === 2) {
      // progress — ignored
    } else if (payload[0] === 3) {
      out.push(Buffer.from(`ERR-BAND: ${payload.subarray(1).toString("utf8")}`));
    } else if (payload[0] === 1) {
      out.push(payload.subarray(1));
    } else {
      out.push(payload);
    }
    p += len;
  }
  return Buffer.concat(out);
}

function parseReport(bytes) {
  let inner = unframe(bytes);
  const head = inner.subarray(0, 4).toString("latin1");
  if (/^[0-9a-f]{4}$/.test(head)) {
    const len = parseInt(head, 16);
    if (len >= 4 && len <= inner.length + 4) inner = unframe(inner);
  }
  const lines = inner.toString("utf8").split("\n").filter((l) => l.length > 0);
  const unpack = lines[0] === "unpack ok" ? null : (lines[0] ?? "").slice("unpack ".length) || null;
  const results = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("ok ")) results.push({ ref: line.slice(3), ok: true });
    else if (line.startsWith("ng ")) {
      const rest = line.slice(3);
      const sp = rest.indexOf(" ");
      results.push(sp === -1 ? { ref: rest, ok: false } : { ref: rest.slice(0, sp), ok: false, msg: rest.slice(sp + 1) });
    }
  }
  return { unpack, results };
}

const mainTip = (t) => t.store.getRef("refs/heads/main");

// ---------------------------------------------------------------------------
// reuse: the unit contract — validatePush trusts authoritative kinds
// ---------------------------------------------------------------------------

await check("reuse: validatePush trusts authoritative kinds — a contradicting kind flips forced without a walk (the reuse engaged)", async () => {
  const t = makeStore();
  seedAncestry(t.store);
  const scan = { packKey: null, packIncomplete: false };

  // the walked twin (no kinds): A is genuinely an ancestor of B → not forced
  const walked = await validatePush(t.store, [{ ref: "refs/heads/main", old: A.oid, next: B.oid }], null, scan);
  assertEq(walked.decisions[0].forced, false, "the walk answers fast-forward (not forced)");

  // the reused twin: an authoritative "force-push" kind CONTRADICTING the
  // graph is trusted wholesale — no walk happens (this is the contract that
  // makes the reuse observable; a walked verdict here would answer false)
  const reused = await validatePush(
    t.store,
    [{ ref: "refs/heads/main", old: A.oid, next: B.oid }],
    null,
    scan,
    ["force-push"]
  );
  assertEq(reused.decisions[0].forced, true, "the authoritative kind is trusted (reused, not re-walked)");

  // and the graph-contradicting direction: an authoritative "fast-forward"
  // over a genuinely divergent (old,next) is trusted as NOT forced (main
  // re-pointed at B so the CAS passes and the verdict line is reached)
  t.store.setRef("refs/heads/main", B.oid);
  const reusedFF = await validatePush(
    t.store,
    [{ ref: "refs/heads/main", old: B.oid, next: C.oid }],
    null,
    scan,
    ["fast-forward"]
  );
  assertEq(reusedFF.decisions[0].forced, false, "the authoritative fast-forward kind is trusted over a force-shaped graph");

  // creates/deletes never consult kinds (their verdicts continue above the
  // forced line) — a kinds array is inert on them
  t.store.setRef("refs/heads/side", A.oid);
  const del = await validatePush(t.store, [{ ref: "refs/heads/side", old: A.oid, next: ZERO_OID }], null, scan, ["delete"]);
  assertEq(del.decisions[0].del, true, "delete rides its own arm, kinds inert");
});

// ---------------------------------------------------------------------------
// reuse: equivalence — the reused verdict equals the walked verdict
// ---------------------------------------------------------------------------

await check("reuse: classifyReceive's kinds and validatePush's own walk agree on every shape (FF / force / create / delete / mixed)", async () => {
  const t = makeStore();
  seedAncestry(t.store);

  // a live receive lease (classifyReceive's only precondition)
  t.store.createLease("reusetok", "receive", Date.now() + 60_000, "{}");
  const commands = [
    { old: A.oid, next: B.oid }, // fast-forward
    { old: B.oid, next: C.oid }, // force (divergent root over a child)
    { old: ZERO_OID, next: C.oid }, // create
    { old: B.oid, next: ZERO_OID }, // delete
  ];
  const classified = await controlPlane.classifyReceive(t.host, { leaseToken: "reusetok", commands });
  assertEq(classified.tag, "ok", "classify answered");
  assertEq(classified.kinds, ["fast-forward", "force-push", "create", "delete"], "kinds match the graph");

  // full ref names for validatePush; every command lands on its own ref so
  // the CAS reads are independent
  const refs = ["refs/heads/ff", "refs/heads/force", "refs/heads/new", "refs/heads/gone"];
  t.store.setRef("refs/heads/ff", A.oid);
  t.store.setRef("refs/heads/force", B.oid);
  t.store.setRef("refs/heads/gone", B.oid);
  const full = commands.map((c, i) => ({ ref: refs[i], old: c.old, next: c.next }));
  const scan = { packKey: null, packIncomplete: false };

  const walked = await validatePush(t.store, full, null, scan);
  const reused = await validatePush(t.store, full, null, scan, classified.kinds);
  assertEq(reused.decisions, walked.decisions, "the reused verdict equals the walked verdict decision-for-decision");

  // the direct isAncestor oracle agrees with both
  assertEq(await isAncestor(t.store, A.oid, B.oid), true, "oracle: A is an ancestor of B");
  assertEq(await isAncestor(t.store, B.oid, C.oid), false, "oracle: B is not an ancestor of C");
});

// ---------------------------------------------------------------------------
// flow: the reused verdict is behavior-identical through the real pipeline
// ---------------------------------------------------------------------------

await check("flow: a fast-forward stamps NO gc-pending through the reused verdict (misaligned kinds would flip FF to forced — this pin catches it)", async () => {
  const t = makeRepo();
  await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  t.finalizeInputs.length = 0;
  const res = await postReceive(t, receiveBody([`${A.oid} ${B.oid} refs/heads/main`], B.pack.bytes), {
    validatePush: (commands) => commands.map(() => ({})),
  });
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  assertEq(report.results, [{ ref: "refs/heads/main", ok: true }], "the fast-forward applied");
  assertEq(mainTip(t), B.oid, "main tip moved");
  // THE pin: forced must stay false on the reused path — a FF that flips
  // forced stamps gc-pending and starts the whole blocking-GC cascade
  assert(t.store.getMeta("gc-pending") !== "1", "no gc-pending stamp on a fast-forward (forced stayed false)");
  const fin = t.finalizeInputs[0];
  assert(fin, "finalize ran");
  assertEq(fin.classifiedKinds, ["fast-forward"], "finalize received the authoritative kinds");
});

await check("flow: a force push stamps gc-pending exactly as before the reuse (needsGc semantics unchanged)", async () => {
  const t = makeRepo();
  await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  await postReceive(t, receiveBody([`${A.oid} ${B.oid} refs/heads/main`], B.pack.bytes));
  t.finalizeInputs.length = 0;
  const res = await postReceive(t, receiveBody([`${B.oid} ${C.oid} refs/heads/main`], C.pack.bytes), {
    validatePush: (commands) => commands.map(() => ({})),
  });
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  assertEq(report.results, [{ ref: "refs/heads/main", ok: true }], "the rewrite applied");
  assertEq(mainTip(t), C.oid, "main moved to the divergent root");
  assertEq(t.store.getMeta("gc-pending"), "1", "the force's gc-pending stamp still lands (forced stayed true)");
  const fin = t.finalizeInputs[0];
  assertEq(fin.classifiedKinds, ["force-push"], "finalize received the authoritative kinds");
});

await check("flow: a hook-filtered section re-aligns the kinds to the commands finalize receives (rejected sibling removed, kinds follow)", async () => {
  const t = makeRepo();
  await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  await postReceive(t, receiveBody([`${A.oid} ${B.oid} refs/heads/main`], B.pack.bytes));
  t.finalizeInputs.length = 0;
  // TWO commands: the force rewrite of main (rejected by the hook) and a
  // create of topic at C (allowed). finalize must receive ONLY the create —
  // with kinds re-aligned to it (the create's own kind), and the create's
  // outcome identical to its unfiltered twin.
  const res = await postReceive(
    t,
    receiveBody([`${B.oid} ${C.oid} refs/heads/main`, `${ZERO_OID} ${C.oid} refs/heads/topic`], C.pack.bytes),
    {
      validatePush: (commands) => commands.map((c) => (c.ref === "refs/heads/main" ? { reject: "protected" } : {})),
    }
  );
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  assertEq(report.results, [
    { ref: "refs/heads/main", ok: false, msg: "protected" },
    { ref: "refs/heads/topic", ok: true },
  ], "per-ref verdicts in command order");
  assertEq(mainTip(t), B.oid, "the rejected ref never moved");
  assertEq(t.store.getRef("refs/heads/topic"), C.oid, "the sibling landed");
  const fin = t.finalizeInputs[0];
  assert(fin, "finalize ran");
  assertEq(fin.commands.length, 1, "finalize received only the allowed command");
  assertEq(fin.classifiedKinds, ["create"], "the kinds array was re-aligned to the filtered section");
  // and the rejected force left no needsGc stamp (the section's only applied
  // command was a create — nothing stranded)
  assert(t.store.getMeta("gc-pending") !== "1", "no gc-pending from the rejected force (it never finalized)");
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} checks passed`);
