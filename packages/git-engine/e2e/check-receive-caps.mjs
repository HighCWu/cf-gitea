// P2-8 receive-pack capability gate — `atomic`, `push-options`, `report-status-v2`
// (docs/residuals-v1.3.2.md P2-8; docs/usability/parity-review-git.md §2.3, D2).
// Run with tsx, the same mechanism as check-validate-push.mjs (see e2e/README.md):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-receive-caps.mjs
// Exits non-zero on the first violated assertion.
//
// What makes this honest: the REAL Worker-side receive flow —
// createDurableGit().fetch over the real parsePushRequest (now two-phase:
// command list, then the push-options section) / stagePack / scan /
// finalizeReceive pipeline, the DO RPCs executed by the REAL control plane
// over node:sqlite, R2 staged in memory — with the wire shapes taken from
// git 2.43.0 byte-observations (local receive-pack handshakes under
// GIT_TRACE_PACKET=2; see the per-check comments and NOTICE.md):
//   - advertisement: `report-status report-status-v2 delete-refs
//     side-band-64k atomic ofs-delta push-options object-format=sha1 agent=…`
//   - push-options: pkt-lines between the command list's flush and the
//     packfile, raw string per line, section terminated by a flush — NO
//     count pkt-line (gitprotocol-pack: push-options = *PKT-LINE(push-option)
//     flush-pkt; observed: `packet: push> key=value` / `push> 0000`).
//   - atomic failure report: the failing ref keeps its own ng message, the
//     would-apply siblings get `ng <ref> atomic push failed` (observed:
//     `! [rejected] main -> main (fetch first)` +
//     `! [rejected] atom3 -> atom3 (atomic push failed)`).
//   - report-status-v2 without proc-receive: zero option lines — the report
//     is `unpack ok` + ok/ng (observed on a stock 2.43.0 push; upstream
//     Gitea runs no proc-receive either).
//
// Covers, in order:
//   1.  the advertisement (through the real handler) carries the new tokens.
//   2.  atomic, CAS-doomed sibling: a stale-old command forces the WHOLE
//       section to fail — sibling reports "atomic push failed", the doomed
//       one its own "fetch first", NO ref moves, no onPush event.
//   3.  the same push without `atomic`: the sibling lands (per-ref default).
//   4.  atomic + hook rejection: both commands report ng, finalize is
//       SKIPPED (all-rejected path: lease released with a sweep), nothing
//       applies, and a follow-up push is not lease-blocked.
//   5.  the same hooked push without `atomic`: the allowed sibling lands.
//   6.  push options reach the validatePush hook context and the onPush
//       event verbatim; the ref lands.
//   7.  an empty push-options section (capability requested, no options)
//       parses clean.
//   8.  no push-options capability: no section, hook context has no
//       pushOptions key (the legacy byte-identical parse).
//   9.  push options + a real pack + a declared Content-Length: the section
//       bytes never leak into the staged pack (the push lands and the pack
//       scans — a mis-sized hint would fail the trailer check all-ng).
//   10. report-status-v2 requested (sideband): the report is present,
//       `unpack ok` first, ok/ng per command, zero `option` lines.
//   11. report-status-v2 requested (no sideband): plain pkt-line report.
//   12. a real git 2.43 client's full cap list (report-status report-status-v2
//       side-band-64k atomic object-format=sha1 agent=…) on one push lands.
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
// (same shim as check-validate-push.mjs).
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

// ---- fixture builders (fulls only — the capability semantics need no deltas)

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

/** One root-or-child commit with its own blob+tree; `parents` exist
 *  server-side by the time the pack is pushed. */
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

// A: root. B: child of A (fast-forward shape).
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
  const t = { db, sql, tx, objects: new Map(), rpcs: [], waits: [] };
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
  // the DO namespace stub: every RPC the receive flow makes, executed by the
  // real control plane over the host
  const impl = {
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
      }
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

/**
 * A receive-pack request body: command section (first line carries the caps
 * after NUL), flush, THEN the push-options section when `options` is given
 * (gitprotocol-pack: after the command flush, before the packfile), then the
 * pack. Caps default to the real git 2.43 client's list for a plain push.
 */
const CLIENT_CAPS = "report-status report-status-v2 side-band-64k object-format=sha1 agent=git/2.43.0";

function receiveBody(commands, { caps = CLIENT_CAPS, options = null, packBytes = null } = {}) {
  const lines = commands.map((c, i) => pkt(i === 0 ? `${c}\0${caps}\n` : `${c}\n`));
  const parts = [...lines, FLUSH_PKT];
  if (options !== null) {
    parts.push(...options.map((o) => pkt(o)));
    parts.push(FLUSH_PKT);
  }
  if (packBytes !== null) parts.push(packBytes);
  return Buffer.concat(parts);
}

/** POST /git-receive-pack through the REAL createDurableGit().fetch. The
 *  ExecutionContext COLLECTS waitUntil promises so the onPush event (fired
 *  off the response path) is observable after awaiting them. */
function makePostReceive(t, onPush) {
  const handler = createDurableGit({ authorize: () => true, ...(onPush ? { onPush } : {}) });
  return async (body, internal) => {
    t.waits.length = 0;
    const req = new Request(`http://dgit.test/${REPO}.git/git-receive-pack`, {
      method: "POST",
      headers: { "content-type": "application/x-git-receive-pack-request", "content-length": String(body.length) },
      body,
    });
    const res = await handler.fetch(req, t.env, { waitUntil: (p) => t.waits.push(p) }, internal);
    await Promise.all(t.waits);
    return res;
  };
}

/** Strip one layer of pkt-line framing: band-1 payloads pass through (minus
 *  the band byte), band-2 progress dropped, band-3 kept, plain pass-through. */
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

/** Parse a report-status(-v2) response into { unpack, results, optionLines }.
 *  Handles side-band framing and the nested report framing. */
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
  const optionLines = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("option ")) optionLines.push(line);
    else if (line.startsWith("ok ")) results.push({ ref: line.slice(3), ok: true });
    else if (line.startsWith("ng ")) {
      const rest = line.slice(3);
      const sp = rest.indexOf(" ");
      results.push(sp === -1 ? { ref: rest, ok: false } : { ref: rest.slice(0, sp), ok: false, msg: rest.slice(sp + 1) });
    }
  }
  return { unpack, results, optionLines };
}

/** The report TEXT: strip the side-band framing, then the report's own
 *  pkt-line framing (renderStatus emits pkt-lines in both cases). */
function reportText(bytes) {
  let inner = unframe(bytes);
  const head = inner.subarray(0, 4).toString("latin1");
  if (/^[0-9a-f]{4}$/.test(head)) {
    const len = parseInt(head, 16);
    if (len >= 4 && len <= inner.length + 4) inner = unframe(inner);
  }
  return inner.toString("utf8");
}

// ---- the checks ---------------------------------------------------------------

await check("1. the real advertisement carries report-status-v2, atomic, push-options, object-format=sha1", async () => {
  const t = makeRepo();
  // the live advertisement bytes over the real store (the cell's fetch handler
  // needs a full DO; the advertisement() bytes ARE what it serves — the full
  // handler path is e2e.sh's, against a running worker)
  const { advertisement } = await import("../src/git/protocol.ts");
  const bytes = advertisement(t.store, "git-receive-pack", false);
  const text = Buffer.from(bytes).toString("utf8");
  const nul = text.indexOf("\0");
  assert(nul >= 0, "an advertisement line carries the NUL-caps shape");
  const caps = text.slice(nul + 1).split("\n")[0].split(" ").filter(Boolean);
  for (const token of ["report-status", "report-status-v2", "delete-refs", "side-band-64k", "atomic", "ofs-delta", "push-options", "object-format=sha1"]) {
    assert(caps.includes(token), `advertised: ${token} (in ${JSON.stringify(caps)})`);
  }
  assert(caps.some((c) => c.startsWith("agent=")), "advertised: agent=");
  // the worker gate's create-by-push probe (dummyAdvertisement,
  // apps/worker/src/git-http/respond.ts) MIRRORS this capability list — the
  // client's --atomic/-o decisions read the PROBE bytes for a not-yet-created
  // repo, so the two lists must move in lockstep
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const respondSrc = readFileSync(
    join(dirname(new URL(import.meta.url).pathname), "../../../apps/worker/src/git-http/respond.ts"),
    "utf8"
  );
  const m = respondSrc.match(/const capabilities = "([^"]+)";/);
  assert(m, "dummyAdvertisement carries a capabilities string");
  const dummyTokens = m[1].split(" ").filter((x) => !x.startsWith("agent="));
  const liveTokens = caps.filter((x) => !x.startsWith("agent="));
  assertEq(dummyTokens, liveTokens, "dummyAdvertisement mirrors the live receive capability list (agent excluded)");
});

await check("2. atomic, CAS-doomed sibling: the whole section fails, the sibling reports 'atomic push failed'", async () => {
  const t = makeRepo();
  const post = makePostReceive(t);
  // land A for real, then strand a stale create: refs/heads/doomed exists
  // while the client sends old=ZERO (it believes a create)
  await post(receiveBody([`${ZERO_OID} ${A.oid} refs/heads/a`], { packBytes: A.pack.bytes }));
  t.store.setRef("refs/heads/doomed", A.oid);
  t.rpcs.length = 0;
  const post2 = makePostReceive(t);
  const caps = "report-status side-band-64k atomic object-format=sha1 agent=git/2.43.0";
  const res = await post2(receiveBody([`${ZERO_OID} ${A.oid} refs/heads/fresh`, `${ZERO_OID} ${A.oid} refs/heads/doomed`], { caps }));
  assertEq(res.status, 200, "http status");
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  assertEq(report.unpack, null, "unpack ok");
  assertEq(
    report.results.map((r) => [r.ref, r.ok, r.msg]),
    [
      ["refs/heads/fresh", false, "atomic push failed"],
      ["refs/heads/doomed", false, "fetch first"],
    ],
    "atomic report: failing command keeps its message, the sibling the atomic failure (git 2.43.0 observed shape)"
  );
  assertEq(t.store.getRef("refs/heads/fresh"), null, "NOTHING applied: the sibling ref does not exist");
  assertEq(t.store.getRef("refs/heads/doomed"), A.oid, "the doomed ref is untouched");
});

await check("3. the same push WITHOUT atomic: the sibling lands (per-ref default semantics)", async () => {
  const t = makeRepo();
  const post = makePostReceive(t);
  await post(receiveBody([`${ZERO_OID} ${A.oid} refs/heads/a`], { packBytes: A.pack.bytes }));
  t.store.setRef("refs/heads/doomed", A.oid);
  const post2 = makePostReceive(t);
  const caps = "report-status side-band-64k object-format=sha1 agent=git/2.43.0";
  const res = await post2(receiveBody([`${ZERO_OID} ${A.oid} refs/heads/fresh`, `${ZERO_OID} ${A.oid} refs/heads/doomed`], { caps }));
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  assertEq(
    report.results.map((r) => [r.ref, r.ok, r.msg]),
    [
      ["refs/heads/fresh", true, undefined],
      ["refs/heads/doomed", false, "fetch first"],
    ],
    "non-atomic: the healthy command applies, the stale one alone rejects"
  );
  assertEq(t.store.getRef("refs/heads/fresh"), A.oid, "the sibling landed");
});

await check("4. atomic + hook rejection: finalize skipped, all-ng, lease released (a follow-up push works)", async () => {
  const t = makeRepo();
  const post = makePostReceive(t);
  await post(receiveBody([`${ZERO_OID} ${A.oid} refs/heads/a`], { packBytes: A.pack.bytes }));
  t.rpcs.length = 0;
  const post2 = makePostReceive(t);
  const caps = "report-status side-band-64k atomic object-format=sha1 agent=git/2.43.0";
  const res = await post2(
    receiveBody([`${ZERO_OID} ${A.oid} refs/heads/hooked`, `${ZERO_OID} ${A.oid} refs/heads/free`], { caps }),
    { validatePush: (commands) => commands.map((c) => (c.ref === "refs/heads/hooked" ? { reject: "hooked is protected" } : {})) }
  );
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  assertEq(
    report.results.map((r) => [r.ref, r.ok, r.msg]),
    [
      ["refs/heads/hooked", false, "hooked is protected"],
      ["refs/heads/free", false, "atomic push failed"],
    ],
    "hook-declined keeps its message, the would-apply sibling the atomic failure"
  );
  assert(!t.rpcs.includes("finalizeReceive"), "an all-rejected atomic section never finalizes");
  assert(t.rpcs.includes("releaseReceive"), "the lease is released instead");
  assertEq(t.store.getRef("refs/heads/free"), null, "nothing applied");
  // the lease was released with a sweep, so the next push is not lease-blocked
  const res2 = await post2(receiveBody([`${ZERO_OID} ${A.oid} refs/heads/after`], { packBytes: A.pack.bytes }));
  assertEq(parseReport(new Uint8Array(await res2.arrayBuffer())).results, [{ ref: "refs/heads/after", ok: true }], "follow-up push lands");
});

await check("5. the same hooked push WITHOUT atomic: the allowed sibling lands", async () => {
  const t = makeRepo();
  const post = makePostReceive(t);
  await post(receiveBody([`${ZERO_OID} ${A.oid} refs/heads/a`], { packBytes: A.pack.bytes }));
  const post2 = makePostReceive(t);
  const caps = "report-status side-band-64k object-format=sha1 agent=git/2.43.0";
  const res = await post2(
    receiveBody([`${ZERO_OID} ${A.oid} refs/heads/hooked`, `${ZERO_OID} ${A.oid} refs/heads/free`], { caps }),
    { validatePush: (commands) => commands.map((c) => (c.ref === "refs/heads/hooked" ? { reject: "hooked is protected" } : {})) }
  );
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  assertEq(
    report.results.map((r) => [r.ref, r.ok, r.msg]),
    [
      ["refs/heads/hooked", false, "hooked is protected"],
      ["refs/heads/free", true, undefined],
    ],
    "non-atomic: the allowed sibling applies"
  );
  assertEq(t.store.getRef("refs/heads/free"), A.oid, "the sibling landed");
});

async function echoFixture() {
  const t = makeRepo();
  const post = makePostReceive(t);
  await post(receiveBody([`${ZERO_OID} ${A.oid} refs/heads/a`], { packBytes: A.pack.bytes }));
  return { t, post };
}

await check("6. push options reach the validatePush hook context and the onPush event verbatim; the push lands", async () => {
  const { t, post } = await echoFixture();
  const events = [];
  const post2 = makePostReceive(t, (event) => events.push(event));
  const seen = [];
  const caps = "report-status side-band-64k push-options object-format=sha1 agent=git/2.43.0";
  const res = await post2(
    receiveBody([`${A.oid} ${B.oid} refs/heads/a`], { caps, options: ["key=value", "run=ci"], packBytes: B.pack.bytes }),
    { validatePush: async (commands, ctx) => {
        seen.push({ ...ctx });
        return commands.map(() => ({}));
      } }
  );
  assertEq(parseReport(new Uint8Array(await res.arrayBuffer())).results, [{ ref: "refs/heads/a", ok: true }], "the push landed");
  assertEq(seen.length, 1, "one hook invocation");
  assertEq(seen[0].pushOptions, ["key=value", "run=ci"], "hook context carries the options verbatim");
  assertEq(events.length, 1, "one onPush event");
  assertEq(events[0].pushOptions, ["key=value", "run=ci"], "the event carries the options verbatim");
  assertEq(t.store.getRef("refs/heads/a"), B.oid, "the ref moved");
});

await check("7. an empty push-options section (capability requested, flush only) parses clean", async () => {
  const { t, post } = await echoFixture();
  const seen = [];
  const caps = "report-status side-band-64k push-options object-format=sha1 agent=git/2.43.0";
  const res = await post(
    receiveBody([`${A.oid} ${B.oid} refs/heads/a`], { caps, options: [], packBytes: B.pack.bytes }),
    { validatePush: async (commands, ctx) => {
        seen.push({ ...ctx });
        return commands.map(() => ({}));
      } }
  );
  assertEq(parseReport(new Uint8Array(await res.arrayBuffer())).results, [{ ref: "refs/heads/a", ok: true }], "the push landed");
  assert(!("pushOptions" in seen[0]), "no options sent means no pushOptions key in the hook context");
});

await check("8. no push-options capability: no section is parsed (the legacy byte-identical parse)", async () => {
  const { t, post } = await echoFixture();
  const seen = [];
  const caps = "report-status side-band-64k object-format=sha1 agent=git/2.43.0";
  const res = await post(
    receiveBody([`${A.oid} ${B.oid} refs/heads/a`], { caps, packBytes: B.pack.bytes }),
    { validatePush: async (commands, ctx) => {
        seen.push({ ...ctx });
        return commands.map(() => ({}));
      } }
  );
  assertEq(parseReport(new Uint8Array(await res.arrayBuffer())).results, [{ ref: "refs/heads/a", ok: true }], "the push landed");
  assert(!("pushOptions" in seen[0]), "no capability, no pushOptions key");
});

await check("9. push options + a real pack + declared Content-Length: the section never leaks into the staged pack", async () => {
  const { t, post } = await echoFixture();
  const caps = "report-status side-band-64k push-options object-format=sha1 agent=git/2.43.0";
  // a mis-sized hint (options bytes counted as pack) fails the trailer
  // verification in stagePack and renders all-ng — landing with ok PROVES the
  // hint math counts the options section as consumed
  const res = await post(
    receiveBody([`${A.oid} ${B.oid} refs/heads/a`], { caps, options: ["key=value"], packBytes: B.pack.bytes })
  );
  assertEq(parseReport(new Uint8Array(await res.arrayBuffer())).results, [{ ref: "refs/heads/a", ok: true }], "the push landed with a clean unpack");
  assert(t.rpcs.includes("putIndexRows"), "the pack was scanned (index rows landed)");
  assertEq(t.store.getRef("refs/heads/a"), B.oid, "the ref moved to the packed commit");
});

await check("10. report-status-v2 (sideband): the report is present, unpack ok first, ok/ng per command, ZERO option lines", async () => {
  const t = makeRepo();
  const post = makePostReceive(t);
  const caps = "report-status-v2 side-band-64k object-format=sha1 agent=git/2.43.0";
  const res = await post(receiveBody([`${ZERO_OID} ${A.oid} refs/heads/v2br`], { caps, packBytes: A.pack.bytes }));
  assertEq(res.status, 200, "http status");
  const rawBytes = new Uint8Array(await res.arrayBuffer());
  const report = parseReport(rawBytes);
  assertEq(report.unpack, null, "unpack ok");
  assertEq(report.results, [{ ref: "refs/heads/v2br", ok: true }], "the v2-only request is honored with a report");
  assertEq(report.optionLines, [], "no option lines: this engine runs no proc-receive, exactly like upstream Gitea");
  // the wire shape itself: unpack ok, then the ok line, then the flush
  const text = reportText(rawBytes);
  assert(text.startsWith("unpack ok\n"), `the report opens with unpack ok: ${JSON.stringify(text.slice(0, 40))}`);
  assert(text.includes(`ok refs/heads/v2br\n`), "the per-command ok line follows");
  assert(!text.includes("option "), "no option lines on the wire");
});

await check("11. report-status-v2 (no sideband): plain pkt-line report", async () => {
  const t = makeRepo();
  const post = makePostReceive(t);
  const caps = "report-status-v2 object-format=sha1 agent=git/2.43.0";
  const res = await post(receiveBody([`${ZERO_OID} ${A.oid} refs/heads/v2plain`], { caps, packBytes: A.pack.bytes }));
  const rawBytes = new Uint8Array(await res.arrayBuffer());
  const text = reportText(rawBytes);
  assert(text.startsWith("unpack ok\n"), `a plain report opens with unpack ok: ${JSON.stringify(text.slice(0, 40))}`);
  assert(text.includes("ok refs/heads/v2plain\n"), "the ok line follows");
  // and the parse agrees
  assertEq(parseReport(rawBytes).results, [{ ref: "refs/heads/v2plain", ok: true }], "parsed");
});

await check("12. a real git 2.43 client's full cap list (v1+v2+atomic+object-format) on one push lands", async () => {
  const t = makeRepo();
  const post = makePostReceive(t);
  const caps = "report-status report-status-v2 side-band-64k atomic object-format=sha1 agent=git/2.43.0";
  const res = await post(receiveBody([`${ZERO_OID} ${A.oid} refs/heads/full`], { caps, packBytes: A.pack.bytes }));
  const report = parseReport(new Uint8Array(await res.arrayBuffer()));
  assertEq(report.unpack, null, "unpack ok");
  assertEq(report.results, [{ ref: "refs/heads/full", ok: true }], "applied");
  assertEq(t.store.getRef("refs/heads/full"), A.oid, "the ref landed");
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} receive-caps checks passed`);
