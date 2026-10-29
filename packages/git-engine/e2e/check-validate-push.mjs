// SPEC-0013 M2 gate — the engine-side `validatePush` hook contract. Run with
// tsx, the same mechanism as check-correctness-tier.mjs (see e2e/README.md):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-validate-push.mjs
// Exits non-zero on the first violated assertion.
//
// What makes this honest: the REAL Worker-side receive flow —
// createDurableGit().fetch over the real parsePushRequest/stagePack/scan/
// finalizeReceive pipeline, the DO RPCs executed by the REAL control plane
// over node:sqlite (including the new classifyReceive ancestry walk over
// lease-staged rows), R2 staged in memory. Real git is not needed here: the
// ancestry shapes (fast-forward vs divergent rewrite) are constructed
// commits, and the claim under test is the hook CONTRACT, not pack
// correctness (covered by the other receive checks).
//
// Covers, in order:
//   1.  no hook → byte-identical legacy flow (the seam's absence changes
//       nothing — the mirror/import/transitional posture).
//   2.  the hook receives the CLASSIFIED commands: create / fast-forward /
//       force-push (real ancestry over the lease-staged rows, ONE
//       classifyReceive RPC per push) / delete — index-aligned, with
//       { repo, pusher? } context.
//   3.  a rejected command renders its `reject` string as the report-status
//       ng message, NEVER applies, and its sibling in the same push lands.
//   4.  an all-rejected push skips finalize, releases the lease WITH a sweep
//       (no staging debris; the next push is not lease-blocked) and renders
//       all-ng.
//   5.  a throwing hook fails the whole request closed (500, refs unmoved,
//       lease released — a follow-up push works).
//   6.  a malformed verdict array (wrong length) fails CLOSED with the fixed
//       contract-violation message; `undefined` allows everything.
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
 *  exist server-side by the time the pack is pushed. */
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

// A: root. B: child of A (fast-forward shape). C: a DIVERGENT root (rewrite
// shape — pushing it over B is a force by ancestry, not by flag). D: child
// of C.
const A = commitOf("a root", [], "blob a\n");
const B = commitOf("b child of a", [A.oid], "blob b\n");
const C = commitOf("c divergent root", [], "blob c\n");
const D = commitOf("d child of c", [C.oid], "blob d\n");

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
  t.store.setR2(t.bucket, STORAGE); // pack byte reads (the scan, the ancestry walk)
  // the DO namespace stub: every RPC the receive flow makes (now including
  // classifyReceive and the entry's bindRepo), executed by the real control plane
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

function deletesOnlyBody(commands) {
  const lines = commands.map((c, i) => pkt(i === 0 ? `${c}\0report-status side-band-64k agent=git/2.43.0\n` : `${c}\n`));
  return Buffer.concat([...lines, FLUSH_PKT]);
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

/** Strip one layer of pkt-line framing: band-1/band-3 payloads pass through
 *  (minus the band byte), band-2 progress is dropped, plain payloads pass
 *  through whole — exactly one level per call. */
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

/** Parse a report-status response: side-band frames, then (when the report
 *  rode inside band-1, still pkt-line framed) the report framing itself. */
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

// ---- the checks --------------------------------------------------------------

await check("1. no hook: the create lands — legacy flow byte-identical", async () => {
  const t = makeRepo();
  const res = await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  assertEq(res.status, 200, "http status");
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  assertEq(report.unpack, null, "unpack");
  assertEq(report.results, [{ ref: "refs/heads/main", ok: true }], "report-status");
  assertEq(mainTip(t), A.oid, "main tip");
  assert(!t.rpcs.includes("classifyReceive"), "no classification RPC without the hook");
});

// The recording hook: captures invocations, applies the scripted verdicts.
let seen;
function recordingHook(verdictsFor) {
  return async (commands, ctx) => {
    seen.push({ commands: commands.map((c) => ({ ...c })), ctx: { ...ctx } });
    return verdictsFor(commands, ctx);
  };
}

await check("2. the hook receives the classified commands (create / fast-forward) with repo context", async () => {
  const t = makeRepo();
  await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  seen = [];
  const res = await postReceive(t, receiveBody([`${A.oid} ${B.oid} refs/heads/main`], B.pack.bytes), {
    validatePush: recordingHook((commands) => commands.map(() => ({}))),
  });
  assertEq(parseReport(new Uint8Array(await res.arrayBuffer())).results, [{ ref: "refs/heads/main", ok: true }], "applied");
  assertEq(seen.length, 1, "one hook invocation");
  assertEq(seen[0].commands, [{ ref: "refs/heads/main", old: A.oid, new: B.oid, kind: "fast-forward" }], "classified commands");
  assertEq(seen[0].ctx, { repo: REPO }, "hook context (no pusher on this call)");
  assertEq(mainTip(t), B.oid, "main tip after the fast-forward");
  // the classification rode ONE batched RPC, not one per command
  assertEq(t.rpcs.filter((r) => r === "classifyReceive").length, 1, "one classifyReceive RPC");
});

await check("3. force-push classification is real ancestry over the lease-staged rows; a create classifies as create", async () => {
  const t = makeRepo();
  await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  await postReceive(t, receiveBody([`${A.oid} ${B.oid} refs/heads/main`], B.pack.bytes));
  seen = [];
  // the divergent rewrite: old=B, new=C where C is a ROOT — genuinely
  // non-fast-forward, classified by the engine's ancestry walk
  const res = await postReceive(t, receiveBody([`${B.oid} ${C.oid} refs/heads/main`], C.pack.bytes), {
    validatePush: recordingHook((commands) => commands.map(() => ({}))),
  });
  assertEq(parseReport(new Uint8Array(await res.arrayBuffer())).results, [{ ref: "refs/heads/main", ok: true }], "rewrite applied");
  assertEq(seen[0].commands, [{ ref: "refs/heads/main", old: B.oid, new: C.oid, kind: "force-push" }], "force classification");
  assertEq(mainTip(t), C.oid, "main moved to the divergent root");
  // a create on another branch classifies as create (no ancestry RPC needed
  // for the deletes/creates, but the update in the same section forces the
  // batched call — kinds come back index-aligned)
  seen = [];
  await postReceive(t, receiveBody([`${ZERO_OID} ${C.oid} refs/heads/topic`], null), {
    validatePush: recordingHook((commands) => commands.map(() => ({}))),
  });
  assertEq(seen[0].commands, [{ ref: "refs/heads/topic", old: ZERO_OID, new: C.oid, kind: "create" }], "create classification");
});

await check("4. a rejected command renders its ng message, never applies, and its sibling lands (per-ref)", async () => {
  const t = makeRepo();
  await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  await postReceive(t, receiveBody([`${A.oid} ${B.oid} refs/heads/main`], B.pack.bytes));
  // main=B; the push carries TWO commands: the divergent rewrite of main
  // (rejected by the hook) and a create of topic at C (allowed) — the pack
  // serves both.
  const res = await postReceive(
    t,
    receiveBody([`${B.oid} ${C.oid} refs/heads/main`, `${ZERO_OID} ${C.oid} refs/heads/topic`], C.pack.bytes),
    {
      validatePush: (commands) => commands.map((c) => (c.ref === "refs/heads/main" ? { reject: "Branch main is protected from force push" } : {})),
    }
  );
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  assertEq(report.unpack, null, "unpack");
  assertEq(report.results, [
    { ref: "refs/heads/main", ok: false, msg: "Branch main is protected from force push" },
    { ref: "refs/heads/topic", ok: true },
  ], "per-ref verdicts in command order");
  assertEq(mainTip(t), B.oid, "the rejected ref never moved");
  assertEq(t.store.getRef("refs/heads/topic"), C.oid, "the sibling landed");
});

await check("5. an all-rejected push skips finalize, releases the lease with a sweep, and renders all-ng", async () => {
  const t = makeRepo();
  await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  const rpcsBefore = t.rpcs.length;
  const res = await postReceive(t, receiveBody([`${ZERO_OID} ${C.oid} refs/heads/gated`], C.pack.bytes), {
    validatePush: () => [{ reject: "Not allowed to push to protected branch gated" }],
  });
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  assertEq(report.results, [{ ref: "refs/heads/gated", ok: false, msg: "Not allowed to push to protected branch gated" }], "all-ng");
  assertEq(t.store.getRef("refs/heads/gated"), null, "ref absent");
  assert(t.rpcs.slice(rpcsBefore).includes("releaseReceive"), "lease released (no finalize)");
  assert(!t.rpcs.slice(rpcsBefore).includes("finalizeReceive"), "finalize skipped");
  // no staging debris: every staging object was swept
  for (const k of t.objects.keys()) {
    assert(!k.includes("/staging/"), `staging object survived: ${k}`);
  }
  // the lease is free: an immediate follow-up push (allowed this time) lands
  const res2 = await postReceive(t, receiveBody([`${ZERO_OID} ${C.oid} refs/heads/gated`], C.pack.bytes), {
    validatePush: () => undefined,
  });
  assertEq(parseReport(new Uint8Array(await res2.arrayBuffer())).results, [{ ref: "refs/heads/gated", ok: true }], "follow-up applied");
  assertEq(t.store.getRef("refs/heads/gated"), C.oid, "gated tip");
});

await check("6. deletes classify as delete; an allowed delete lands", async () => {
  const t = makeRepo();
  await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/scratch`], null));
  seen = [];
  const res = await postReceive(t, deletesOnlyBody([`${A.oid} ${ZERO_OID} refs/heads/scratch`]), {
    validatePush: recordingHook((commands) => commands.map(() => ({}))),
  });
  assertEq(parseReport(new Uint8Array(await res.arrayBuffer())).results, [{ ref: "refs/heads/scratch", ok: true }], "delete applied");
  assertEq(seen[0].commands, [{ ref: "refs/heads/scratch", old: A.oid, new: ZERO_OID, kind: "delete" }], "delete classification");
  assertEq(t.store.getRef("refs/heads/scratch"), null, "scratch gone");
  assertEq(t.rpcs.filter((r) => r === "classifyReceive").length, 0, "deletes-only pushes need no ancestry RPC");
});

await check("7. a throwing hook fails the whole request closed (500) and frees the lease", async () => {
  const t = makeRepo();
  await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  const res = await postReceive(t, receiveBody([`${A.oid} ${B.oid} refs/heads/main`], B.pack.bytes), {
    validatePush: () => {
      throw new Error("rule store unavailable");
    },
  });
  assertEq(res.status, 500, "fail-closed status");
  assertEq(mainTip(t), A.oid, "main unmoved");
  // the lease was released+swept by the outer catch: a follow-up push works
  const res2 = await postReceive(t, receiveBody([`${A.oid} ${B.oid} refs/heads/main`], B.pack.bytes), {
    validatePush: () => [{ reject: "still closed" }],
  });
  assertEq(parseReport(new Uint8Array(await res2.arrayBuffer())).results, [{ ref: "refs/heads/main", ok: false, msg: "still closed" }], "policy still decides");
});

await check("8. a malformed verdict array fails CLOSED with the fixed message; undefined allows", async () => {
  const t = makeRepo();
  await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  // wrong length → contract violation for the whole section
  const res = await postReceive(t, receiveBody([`${A.oid} ${B.oid} refs/heads/main`], B.pack.bytes), {
    validatePush: () => [],
  });
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  assertEq(report.results, [{ ref: "refs/heads/main", ok: false, msg: "push rejected: validatePush contract violation" }], "fail-closed message");
  assertEq(mainTip(t), A.oid, "main unmoved");
  // undefined → allow
  const res2 = await postReceive(t, receiveBody([`${A.oid} ${B.oid} refs/heads/main`], B.pack.bytes), {
    validatePush: () => undefined,
  });
  assertEq(parseReport(new Uint8Array(await res2.arrayBuffer())).results, [{ ref: "refs/heads/main", ok: true }], "undefined allows");
  assertEq(mainTip(t), B.oid, "main moved");
});

await check("9. the pusher identity rides the hook context (the in-process channel)", async () => {
  const t = makeRepo();
  await postReceive(t, receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  seen = [];
  await postReceive(
    t,
    receiveBody([`${A.oid} ${B.oid} refs/heads/main`], B.pack.bytes),
    { pusher: { id: 7, login: "mirroring" }, validatePush: recordingHook((commands) => commands.map(() => ({}))) }
  );
  assertEq(seen[0].ctx, { repo: REPO, pusher: { id: 7, login: "mirroring" } }, "ctx.pusher verbatim");
});

console.log(`\ncheck-validate-push: ${planned - failures.length}/${planned} checks passed`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
