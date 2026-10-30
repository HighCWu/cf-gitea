// SPEC-0011 §7.3 M3.5 — the capability matrix, TEST-GENERATED (round 8's
// consistency gate; never hand-maintained). The advertised-capability table
// is derived from the LIVE handshakes — v0 upload-pack, v0 receive-pack and
// protocol-v2 (`advertisement()` over a real store) — and every advertised
// feature is mechanically required to map onto a REGISTERED PROOF that its
// request semantics are parsed-and-handled (or rejected fail-closed) on the
// real serve/control paths. A future edit that advertises a capability
// without a handler proof FAILS this check; a proof whose behavior drifts
// FAILS too. Run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-capability-matrix.mjs
//
// The matrix the runs generate (asserted, not asserted-by-hand):
//   v0 fetch : multi_ack_detailed no-done shallow side-band-64k
//              symref=HEAD:<head> agent=<name>/<version>
//   v0 push  : report-status report-status-v2 delete-refs side-band-64k
//              atomic ofs-delta push-options object-format=sha1
//              agent=<name>/<version>   (P2-8: the receive caps git 2.43.0
//              advertises, byte-observed; push-options per upstream Gitea's
//              unconditional receive.advertisePushOptions=true)
//   v2 fetch : version 2, agent, ls-refs=unborn, fetch=shallow filter
// Contrapositive pins: the ADVERTISED filter family (blob:none / blob:limit)
// is handled on the real serve path (tree-walked blobs omitted from the pack;
// a directly-wanted blob — the promisor lazy fetch — still ships), while
// filter specs outside the family (sparse:oid=, tree:<n>, combine:) and every
// v0 filter line are rejected fail-closed; within the advertised `shallow`
// feature the deepen family is handled-or-rejected per member (`deepen <n>`
// handled; deepen-since/deepen-not/deepen-relative rejected).
import { DatabaseSync } from "node:sqlite";

const { GitStore } = await import("../src/git/store.ts");
const { NodeSql, assert, assertEq } = await import("./helpers/lib.mjs");
const { advertisement, uploadPack, parseUploadRequest, parsePushCommands, parsePushOptions, renderStatus, ATOMIC_PUSH_FAILED } = await import("../src/git/protocol.ts");
const { beginReceive, finalizeReceive } = await import("../src/control-plane.ts");
const { serializeTree, serializeCommit } = await import("../src/commit/serialize.ts");
const { hashObject, TYPE_NUM } = await import("../src/git/objects.ts");
const { fromHex, sha1hex } = await import("../src/git/util.ts");
const { Crc32 } = await import("../src/receive/idx.ts");
const { walkPack } = await import("../src/receive/scan.ts");
const { DeltaResolver } = await import("../src/receive/delta.ts");
const pako = (await import("pako")).default;

const te = new TextEncoder();
const FLUSH_BYTES = "0000";
const ZERO = "0".repeat(40);

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
// Fixture: a loose-only two-commit history (no packs — the serve proofs need
// no lease guard), plus a receive-side control-plane host.
// ---------------------------------------------------------------------------

function makeStore() {
  const db = new DatabaseSync(":memory:");
  const sql = new NodeSql(db);
  const store = new GitStore(sql, {
    tx: (fn) => {
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  });
  return { db, sql, store };
}

function seedHistory(store) {
  const b1 = te.encode("alpha content\n");
  const b2 = te.encode("beta content\n");
  const person = { name: "t", email: "t@t", time: 1700000000, tz: "+0000" };
  const tree1 = serializeTree([{ mode: "100644", oid: hashObject("blob", b1), name: "b1.txt" }]);
  const tree2 = serializeTree([
    { mode: "100644", oid: hashObject("blob", b1), name: "b1.txt" },
    { mode: "100644", oid: hashObject("blob", b2), name: "b2.txt" },
  ]);
  const commit1 = serializeCommit({ tree: tree1.oid, parents: [], author: person, committer: person, message: "c1" });
  const commit2 = serializeCommit({ tree: tree2.oid, parents: [commit1.oid], author: person, committer: person, message: "c2" });
  for (const [type, data] of [["blob", b1], ["blob", b2], ["tree", tree1.data], ["tree", tree2.data], ["commit", commit1.data], ["commit", commit2.data]]) {
    store.put(hashObject(type, data), type, data);
  }
  store.setRef("refs/heads/main", commit2.oid);
  store.setRef("refs/heads/feature", commit1.oid);
  store.setHead("refs/heads/main");
  return {
    commit1: commit1.oid,
    commit2: commit2.oid,
    blobs: [hashObject("blob", b1), hashObject("blob", b2)],
  };
}

const { store, sql } = makeStore();
const h = seedHistory(store);

// ---- wire parsing (the TEST-GENERATED half) --------------------------------

function parsePktLines(bytes) {
  const lines = [];
  let p = 0;
  while (p + 4 <= bytes.length) {
    // Buffer.from: a plain Uint8Array's toString IGNORES the encoding argument
    const len = parseInt(Buffer.from(bytes.subarray(p, p + 4)).toString("latin1"), 16);
    if (len === 0) {
      lines.push(null); // flush
      p += 4;
      continue;
    }
    if (len < 4) break;
    lines.push(Buffer.from(bytes.subarray(p + 4, p + len)).toString("utf8").replace(/\n$/, ""));
    p += len;
  }
  return lines;
}

/** The advertised capability tokens, read off the LIVE advertisement bytes. */
function advertisedTokens(bytes, v2) {
  const lines = parsePktLines(bytes);
  const out = [];
  if (v2) {
    assert(lines[0] === "version 2", "a v2 advertisement opens with `version 2`");
    for (const l of lines.slice(1)) {
      if (l === null) break;
      if (l) out.push(l);
    }
    return out;
  }
  const first = lines.find((l) => l !== null && !l.startsWith("# service="));
  assert(first !== undefined, "the v0 advertisement carries a ref (or capabilities^{}) line");
  const nul = first.indexOf("\0");
  assert(nul >= 0, "the first v0 line carries the capability list after NUL");
  return first
    .slice(nul + 1)
    .split(" ")
    .filter(Boolean);
}

const V0_FETCH = advertisement(store, "git-upload-pack", false);
const V0_PUSH = advertisement(store, "git-receive-pack", false);
const V2 = advertisement(store, "git-upload-pack", true);
const table = {
  "v0 fetch (git-upload-pack)": advertisedTokens(V0_FETCH, false),
  "v0 push (git-receive-pack)": advertisedTokens(V0_PUSH, false),
  "v2 fetch (protocol v2)": advertisedTokens(V2, true),
};

// ---- request builders ------------------------------------------------------

const pkt = (s) => Buffer.from((s.length + 4).toString(16).padStart(4, "0") + s);
const FLUSH_PKT = Buffer.from("0000");
const v0 = (lines) => Buffer.concat([...lines.map(pkt), FLUSH_PKT]);
const v2 = (pre, args) => Buffer.concat([pkt("command=fetch"), ...pre.map(pkt), Buffer.from("0001"), ...args.map(pkt), FLUSH_PKT]);
const v2ls = (args) => Buffer.concat([pkt("command=ls-refs"), pkt("agent=git/2.43.0"), Buffer.from("0001"), ...args.map(pkt), FLUSH_PKT]);

async function responseText(res) {
  return Buffer.from(await res.arrayBuffer()).toString("utf8");
}

function extractBand1(bytes) {
  let p = 0;
  const chunks = [];
  for (;;) {
    if (p + 4 > bytes.length) break;
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
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// The PROOF registry: every advertised capability must resolve to one of
// these (exact token, else the family before `=`). A proof drives the REAL
// request path (uploadPack / control plane) and asserts the semantics.
// ---------------------------------------------------------------------------

const proofs = {};
const proof = (key, fn) => {
  proofs[key] = fn;
};

proof("multi_ack_detailed", async () => {
  // a have the server knows + done -> ACK <oid> common (per-have) and the
  // final ACK naming the last common commit, then the sideband pack
  const body = Buffer.concat([
    pkt(`want ${h.commit2} multi_ack_detailed side-band-64k`),
    FLUSH_PKT,
    pkt(`have ${h.commit1}`),
    pkt("done"),
  ]);
  const res = await uploadPack(store, body);
  const raw = Buffer.from(await res.arrayBuffer());
  const text = raw.toString("utf8");
  assert(text.includes(`ACK ${h.commit1} common`), `the have ACKed common: ${JSON.stringify(text.slice(0, 120))}`);
  assert(text.includes(`ACK ${h.commit1}\n`), "the final ACK names the last common commit");
  assert(extractBand1(raw).length > 0, "the pack followed the negotiation");
});

proof("no-done", async () => {
  // haves + no-done, NO done: the server answers ready + NAK + ACK and sends
  // the pack in the same response (the stateless-round trip saver)
  const body = Buffer.concat([pkt(`want ${h.commit2} multi_ack_detailed no-done side-band-64k`), FLUSH_PKT, pkt(`have ${h.commit1}`)]);
  const res = await uploadPack(store, body);
  const raw = Buffer.from(await res.arrayBuffer());
  const text = raw.toString("utf8");
  assert(text.includes(`ACK ${h.commit1} ready`), `ready without done: ${JSON.stringify(text.slice(0, 160))}`);
  assert(text.includes("NAK"), "NAK precedes the pack (wire shape)");
  assert(extractBand1(raw).length > 0, "the pack shipped in the same response (no-done honored)");
});

proof("shallow", async () => {
  // the ADVERTISED shallow feature: the deepen family is handled-or-rejected
  // per member — never silently ignored
  const depth = await uploadPack(store, v0([`want ${h.commit2} side-band-64k`, "deepen 1", "done"]));
  const depthText = await responseText(depth);
  assert(/shallow [0-9a-f]{40}/.test(depthText), `deepen 1 answered with a shallow section: ${JSON.stringify(depthText.slice(0, 160))}`);
  assert(!depthText.includes("ERR upload-pack"), "deepen <n> is never an ERR");
  for (const arg of ["deepen-since 2020-01-01", "deepen-not refs/heads/main", "deepen-relative"]) {
    const rej = await uploadPack(store, v0([`want ${h.commit2}`, arg, "done"]));
    const rejText = await responseText(rej);
    assert(rejText.includes(`ERR upload-pack: unsupported fetch argument '${arg.split(" ")[0]}'`), `${arg} rejected fail-closed: ${JSON.stringify(rejText)}`);
  }
});

proof("side-band-64k", async () => {
  // pack data arrives as band-1 frames, progress as band-2 (the advertised
  // framing, exercised on the real serve path) — this proof serves the
  // fetch handshake; the push handshake's sideband rides the report-status
  // proof below (renderStatus sideband framing)
  const res = await uploadPack(store, v0([`want ${h.commit2} side-band-64k`, "done"]));
  const raw = Buffer.from(await res.arrayBuffer());
  assert(extractBand1(raw).length > 0, "band-1 pack frames present");
  const text = raw.toString("latin1");
  assert(text.includes("Enumerating objects"), "band-2 progress frames present");
  assert(raw.toString("latin1").endsWith(FLUSH_BYTES), "the response ends with the flush tail");
});

proof("symref", async (token) => {
  // the advertised value IS the live HEAD, and ls-refs --symreports agrees
  assertEq(token, `symref=HEAD:${store.head()}`, "the advertised symref target is the live HEAD");
  const res = await uploadPack(store, v2ls(["symrefs", "peel"]));
  const text = await responseText(res);
  assert(text.includes(`symref-target:${store.head()}`), `ls-refs agrees with the advertisement: ${JSON.stringify(text.slice(0, 200))}`);
});

proof("agent", async (token) => {
  // key=value per git convention, name/version shape (the wire form both the
  // v0 capability list and the v2 capability update advertise)
  assert(/^agent=[^/\s]+\/\S+$/.test(token), `agent is name/version: ${token}`);
  // and a client's agent= capability update parses clean (never a fetch arg)
  const req = parseUploadRequest(v2(["agent=git/2.43.0", "object-format=sha1"], [`want ${h.commit2}`, "done"]));
  assertEq(req.badArgument, null, "agent= pre-DELIM is a capability update, not a fetch argument");
});

proof("version 2", async () => {
  // the v2 handshake's version line IS the first pkt-line (already asserted
  // at parse); here: a v2 fetch actually answers in v2 shape
  const res = await uploadPack(store, v2(["agent=git/2.43.0"], [`want ${h.commit2}`, "done"]));
  const text = await responseText(res);
  assert(text.includes("packfile\n"), `a v2 fetch answers with the packfile section: ${JSON.stringify(text.slice(0, 120))}`);
});

proof("ls-refs", async () => {
  const res = await uploadPack(store, v2ls(["symrefs", "peel"]));
  const text = await responseText(res);
  assert(text.includes("refs/heads/main"), `ls-refs lists refs: ${JSON.stringify(text.slice(0, 200))}`);
  assert(text.includes("refs/heads/feature"), "all refs listed");
  assert(text.includes(`symref-target:${store.head()}`), "symrefs honored");
  // the unborn arm (ls-refs=unborn): on an empty repo — HEAD's symref target
  // has no ref row — the `unborn`+`symrefs` arguments answer the literal
  // `unborn HEAD symref-target:<head>` line (git 2.43.0 byte shape); without
  // both arguments the empty repo answers flush-only
  const { store: empty } = makeStore();
  const born = await uploadPack(empty, v2ls(["symrefs", "unborn"]));
  assert(
    (await responseText(born)).includes(`unborn HEAD symref-target:${empty.head()}`),
    "the unborn HEAD advertisement names the symref target"
  );
  const noUnborn = await uploadPack(empty, v2ls(["symrefs"]));
  assertEq(parsePktLines(Buffer.from(await noUnborn.arrayBuffer())), [null], "symrefs without unborn on an empty repo answers flush-only");
});

proof("fetch", async () => {
  // the v2 fetch=shallow feature: deepen rides the shallow-info section and
  // still produces a packfile (the v2 shape of the shallow proof)
  const res = await uploadPack(store, v2(["agent=git/2.43.0"], [`want ${h.commit2}`, "deepen 1", "done"]));
  const text = await responseText(res);
  assert(text.includes("shallow-info\n"), `v2 deepen answers shallow-info: ${JSON.stringify(text.slice(0, 160))}`);
  assert(/shallow [0-9a-f]{40}/.test(text), "the shallow boundary is named");
  assert(text.includes("packfile\n"), "and the packfile follows");

  // ... and the filter feature of the SAME fetch family (the advertisement's
  // `fetch=shallow filter` value), on the real serve path: a blob:none fetch
  // of the history serves the commit/tree closure and OMITS every
  // tree-walked blob — the client learns those oids from the tree entries and
  // records them as promised (partial clone). The pack's object set is
  // resolved with the receive-side walker (the same machinery the OFS-delta
  // proof above uses).
  async function packOids(body) {
    const raw = Buffer.from(await (await uploadPack(store, body)).arrayBuffer());
    assert(Buffer.from(raw.subarray(0, 14)).toString("latin1").includes("packfile"), `a packfile section follows, not an ERR: ${JSON.stringify(raw.subarray(0, 24).toString("latin1"))}`);
    const band1 = extractBand1(raw);
    const host = {
      selfPackKey: "filtered",
      lookupObjects: async (oids) => oids.map(() => ({ found: false })),
      readEntryBytes: async (_key, off, len) => new Uint8Array(band1.subarray(off, off + len)),
      putRows: async () => ({ tag: "ok" }),
    };
    const resolver = new DeltaResolver(host, { cacheBytes: 16 * 1024 * 1024 });
    await walkPack({ body: new Response(band1).body, size: band1.length }, (entry) => resolver.onEntry(entry), {
      onHeader: (count) => resolver.init(count),
    });
    const out = await resolver.finish();
    // NOTE: not `incomplete` — that flag is the receive-path connectivity
    // anti-check (every non-blob's children must exist in-pack or in the
    // object database), and a filtered pack deliberately references the
    // omitted blobs from its trees. The declared count + the sent set below
    // are the proof.
    assertEq(out.objects, out.oids.size, "every declared entry resolved to an oid");
    const sent = new Set();
    for (let i = 0; i < out.oids.size; i++) sent.add(out.oids.atHex(i));
    return { declared: out.objects, sent };
  }
  const none = await packOids(v2(["agent=git/2.43.0"], ["no-progress", "filter blob:none", `want ${h.commit2}`, "done"]));
  assertEq(none.declared, 4, "blob:none declares only commits+trees (2 commits, 2 trees)");
  assert(!none.sent.has(h.blobs[0]) && !none.sent.has(h.blobs[1]), "blob:none omits every tree-walked blob");
  assert(none.sent.has(h.commit2) && none.sent.has(h.commit1), "commits still ship under the filter");
  // the promisor lazy-fetch arm: a want that IS a blob (the raw-oid round a
  // partial clone's checkout sends) bypasses the filter — the wanted blob
  // ships even under blob:none, and the relaxed want gate accepts a
  // non-tip want under a filter (upstream's has-object gate)
  const lazy = await packOids(v2(["agent=git/2.43.0"], ["no-progress", "filter blob:none", `want ${h.blobs[1]}`, "done"]));
  assertEq(lazy.declared, 1, "the directly-wanted blob ships (git's USER_REQUESTED carve-out)");
  assert(lazy.sent.has(h.blobs[1]), "the lazy fetch's blob is in the pack");
});

// --- receive proofs (control plane, real host) ------------------------------

function receiveHost() {
  const { store: rstore, sql: rsql } = makeStore();
  const tx = (fn) => {
    rsql.db.exec("BEGIN");
    try {
      const r = fn();
      rsql.db.exec("COMMIT");
      return r;
    } catch (err) {
      rsql.db.exec("ROLLBACK");
      throw err;
    }
  };
  const host = {
    store: rstore,
    storage: { transactionSync: tx, setAlarm: () => Promise.resolve() },
    deletePackObjects: async () => {},
  };
  return { host, rstore, rsql };
}

const NO_PACK = { packKey: "", packSha1: "", packBytes: 0, objectCount: 0, idxBytes: 0 };

proof("report-status", async () => {
  // a finalize's per-command results ARE the report-status payload; the
  // sideband framing of the report is the push handshake's side-band-64k
  const { host, rstore } = receiveHost();
  seedHistory(rstore);
  const begin = await beginReceive(host, {
    commands: [{ old: ZERO, next: h.commit2, ref: "refs/heads/new-branch" }],
    capabilities: ["report-status", "side-band-64k"],
  });
  assertEq(begin.tag, "ok", "lease opened");
  const fin = await finalizeReceive(host, {
    leaseToken: begin.leaseToken,
    expectedRefsVersion: begin.refsVersion,
    commands: [{ old: ZERO, next: h.commit2, ref: "refs/heads/new-branch" }],
    newTips: [h.commit2],
    pack: NO_PACK, // the tip's objects are already known: a rowless pack
    unpackError: null,
  });
  assertEq(fin.tag, "committed", "finalized");
  assertEq(fin.results[0].ok, true, "the command ok'd");
  const status = renderStatus(fin.results, null, true);
  const text = Buffer.from(status).toString("latin1");
  assert(text.includes("unpack ok"), "report-status carries the unpack line");
  assert(text.includes("ok refs/heads/new-branch"), "and the per-command ok");
  assert(text.includes("\x01"), "the report is band-1 sideband-framed (push side-band)");
  void rstore;
});

proof("delete-refs", async () => {
  const { host, rstore } = receiveHost();
  seedHistory(rstore);
  const begin = await beginReceive(host, {
    commands: [{ old: h.commit1, next: ZERO, ref: "refs/heads/feature" }],
    capabilities: ["delete-refs", "report-status"],
  });
  assertEq(begin.tag, "ok", "lease opened");
  const fin = await finalizeReceive(host, {
    leaseToken: begin.leaseToken,
    expectedRefsVersion: begin.refsVersion,
    commands: [{ old: h.commit1, next: ZERO, ref: "refs/heads/feature" }],
    newTips: [null],
    pack: NO_PACK,
    unpackError: null,
  });
  assertEq(fin.tag, "committed", "finalized");
  assertEq(fin.results[0].ok, true, "the delete ok'd");
  assertEq(rstore.getRef("refs/heads/feature"), null, "the advertised delete-refs capability is honored: the ref is gone");
});

proof("ofs-delta", async () => {
  // the push handshake advertises ofs-delta: the receive scanner must RESOLVE
  // type-6 OFS entries (a pack the scanner handles end to end)
  const base = te.encode("ofs-delta base content\n");
  const target = te.encode("ofs-delta base content CHANGED\n");
  // minimal in-pack OFS delta (literal-insert ops)
  const varint = (n, out) => {
    do {
      let b = n & 0x7f;
      n = Math.floor(n / 128);
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
  };
  const deltaParts = [];
  varint(base.length, deltaParts);
  varint(target.length, deltaParts);
  for (let i = 0; i < target.length; i += 127) {
    const chunk = target.subarray(i, Math.min(i + 127, target.length));
    deltaParts.push(chunk.length);
    deltaParts.push(...chunk);
  }
  const delta = new Uint8Array(deltaParts);

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
  function encodeOfs(d) {
    let n = d;
    const bytes = [n & 0x7f];
    n = Math.floor(n / 128);
    while (n > 0) {
      n -= 1;
      bytes.unshift(0x80 | (n & 0x7f));
      n = Math.floor(n / 128);
    }
    return new Uint8Array(bytes);
  }

  const head = new Uint8Array(12);
  head.set(te.encode("PACK"), 0);
  const dv = new DataView(head.buffer);
  dv.setUint32(4, 2);
  dv.setUint32(8, 2);
  const baseComp = pako.deflate(base);
  const baseHeader = encodeEntryHeader(TYPE_NUM.blob, base.length);
  const deltaComp = pako.deflate(delta);
  const deltaHeader = encodeEntryHeader(6, delta.length); // OBJ_OFS_DELTA
  const parts = [head, baseHeader, baseComp, deltaHeader, encodeOfs(baseHeader.length + baseComp.length), deltaComp];
  const bodyNoTrailer = Buffer.concat(parts.map((p) => Buffer.from(p)));
  const sha = sha1hex(new Uint8Array(bodyNoTrailer));
  const packBytes = Buffer.concat([bodyNoTrailer, Buffer.from(fromHex(sha))]);

  const rows = [];
  const resolved = await (async () => {
    const host = {
      selfPackKey: "staging",
      lookupObjects: async (oids) => oids.map(() => ({ found: false })),
      readEntryBytes: async (_key, off, len) => new Uint8Array(packBytes.subarray(off, off + len)),
      putRows: async (batch) => {
        rows.push(...batch);
        return { tag: "ok" };
      },
    };
    const resolver = new DeltaResolver(host, { cacheBytes: 16 * 1024 * 1024 });
    await walkPack({ body: new Response(packBytes).body, size: packBytes.length }, (entry) => resolver.onEntry(entry), {
      onHeader: (count) => resolver.init(count),
    });
    return resolver.finish();
  })();
  assertEq(resolved.incomplete, false, "the OFS pack resolves complete");
  assertEq(resolved.objects, 2, "both entries resolved");
  const oids = [];
  for (let i = 0; i < resolved.oids.size; i++) oids.push(resolved.oids.atHex(i));
  assert(oids.includes(hashObject("blob", target)), `the OFS delta target resolved to the right oid: ${oids.join(",")}`);
  assert(oids.includes(hashObject("blob", base)), "the base resolved too");
  assertEq(rows.length, 2, "index rows landed for both entries");
});

proof("report-status-v2", async () => {
  // the ADVERTISED v2 report: a client requesting ONLY report-status-v2 still
  // gets a status report, and — this engine runs no proc-receive, exactly
  // like upstream Gitea — the report carries ZERO option lines: the same
  // bytes git 2.43.0 sends for a non-rewritten push (byte-observed: a stock
  // 2.43.0 receive-pack answers `unpack ok` + `ok <ref>` with no `option`
  // lines; the v2 grammar's option lines exist to report proc-receive
  // rewrites). The full end-to-end flow (real Worker receive, sideband and
  // plain) is check-receive-caps.mjs checks 10-12.
  const { host, rstore } = receiveHost();
  seedHistory(rstore);
  const begin = await beginReceive(host, {
    commands: [{ old: ZERO, next: h.commit2, ref: "refs/heads/v2br" }],
    capabilities: ["report-status-v2", "side-band-64k"],
  });
  assertEq(begin.tag, "ok", "lease opened");
  const fin = await finalizeReceive(host, {
    leaseToken: begin.leaseToken,
    expectedRefsVersion: begin.refsVersion,
    commands: [{ old: ZERO, next: h.commit2, ref: "refs/heads/v2br" }],
    newTips: [h.commit2],
    pack: NO_PACK,
    unpackError: null,
  });
  assertEq(fin.tag, "committed", "finalized");
  // the report is band-1 framed and parses as report-status-v2 with zero
  // option lines (the grammar's base: `report-status *option-line`)
  const band1 = extractBand1(renderStatus(fin.results, null, true));
  const lines = parsePktLines(band1);
  assertEq(lines[0], "unpack ok", "the v2 report opens with the unpack line");
  assert(lines.some((l) => l === "ok refs/heads/v2br"), `the per-command ok follows: ${JSON.stringify(lines)}`);
  assert(lines.every((l) => l === null || !l.startsWith("option ")), "zero option lines (no proc-receive)");
  void rstore;
});

proof("atomic", async () => {
  // the ADVERTISED atomic: one failing command rejects the WHOLE section —
  // the failing command keeps its own message, the would-apply sibling gets
  // ATOMIC_PUSH_FAILED, and NO ref moves (git's ref-transaction abort,
  // execute_commands_atomic; byte-observed on git 2.43.0: `! [rejected] main
  // -> main (fetch first)` + `! [rejected] atom3 -> atom3 (atomic push
  // failed)`). Drives the REAL control plane finalize.
  const { host, rstore } = receiveHost();
  seedHistory(rstore);
  rstore.setRef("refs/heads/doomed", h.commit1); // the stale create: old=ZERO lies
  const commands = [
    { old: ZERO, next: h.commit2, ref: "refs/heads/fresh" },
    { old: ZERO, next: h.commit2, ref: "refs/heads/doomed" },
  ];
  const begin = await beginReceive(host, { commands, capabilities: ["atomic", "report-status"] });
  assertEq(begin.tag, "ok", "lease opened");
  const fin = await finalizeReceive(host, {
    leaseToken: begin.leaseToken,
    expectedRefsVersion: begin.refsVersion,
    commands,
    newTips: [h.commit2, h.commit2],
    pack: NO_PACK,
    unpackError: null,
    atomic: true,
  });
  // nothing applied + a "fetch first" present = the ref_conflict report
  assertEq(fin.tag, "ref_conflict", "an atomic all-fail section is the ref_conflict shape");
  const msgs = Object.fromEntries(fin.results.map((r) => [r.ref, { ok: r.ok, msg: r.message }]));
  assertEq(msgs["refs/heads/doomed"], { ok: false, msg: "fetch first" }, "the failing command keeps its own message");
  assertEq(msgs["refs/heads/fresh"], { ok: false, msg: ATOMIC_PUSH_FAILED }, "the would-apply sibling reports the atomic failure");
  assertEq(rstore.getRef("refs/heads/fresh"), null, "NOTHING applied: the sibling ref does not exist");
  assertEq(rstore.getRef("refs/heads/doomed"), h.commit1, "the doomed ref is untouched");
  // control: the SAME section without atomic applies the sibling per-ref
  const { host: host2, rstore: rstore2 } = receiveHost();
  seedHistory(rstore2);
  rstore2.setRef("refs/heads/doomed", h.commit1);
  const begin2 = await beginReceive(host2, { commands, capabilities: ["report-status"] });
  assertEq(begin2.tag, "ok", "control lease opened");
  const fin2 = await finalizeReceive(host2, {
    leaseToken: begin2.leaseToken,
    expectedRefsVersion: begin2.refsVersion,
    commands,
    newTips: [h.commit2, h.commit2],
    pack: NO_PACK,
    unpackError: null,
  });
  assertEq(fin2.tag, "committed", "non-atomic control commits");
  assertEq(rstore2.getRef("refs/heads/fresh"), h.commit2, "non-atomic: the sibling lands (per-ref default)");
  assertEq(rstore2.getRef("refs/heads/doomed"), h.commit1, "non-atomic: only the stale command rejects");
});

proof("push-options", async () => {
  // the ADVERTISED push-options: the section parser handles the documented
  // grammar (gitprotocol-pack: push-options = *PKT-LINE(push-option)
  // flush-pkt; each option is the pkt-line's raw bytes, NO count pkt-line —
  // byte-observed on git 2.43.0: `packet: push> key=value` / `push> 0000`).
  // The real Worker-side flow (options past the command flush reaching the
  // validatePush context and the onPush event) is check-receive-caps.mjs
  // checks 6-9.
  const section = Buffer.concat([pkt("key=value"), pkt("run=ci"), pkt("plain"), FLUSH_PKT]);
  assertEq(parsePushOptions(new Uint8Array(section)), ["key=value", "run=ci", "plain"], "each pkt-line is one option, in order");
  assertEq(parsePushOptions(new Uint8Array(FLUSH_PKT)), [], "an empty section (capability requested, no options) parses to []");
  // a trailing LF is chomped per line, the same chomp git's packet reader applies
  const sectionLf = Buffer.concat([pkt("key=value\n"), FLUSH_PKT]);
  assertEq(parsePushOptions(new Uint8Array(sectionLf)), ["key=value"], "a trailing LF per line is chomped (git packet-reader bug-compat)");
});

proof("object-format", async (token) => {
  // the ADVERTISED object-format=sha1 IS this store's format: every oid is
  // 40 hex (sha1), and a client command section carrying the capability
  // parses clean (real git 2.43 sends it on every push)
  assertEq(token, "object-format=sha1", "the advertised format is sha1");
  for (const r of store.refs()) assert(/^[0-9a-f]{40}$/.test(r.oid), `ref oids are sha1: ${r.oid}`);
  const { commands, caps } = parsePushCommands(
    new Uint8Array(
      Buffer.concat([
        pkt(`${ZERO} ${h.commit2} refs/heads/of-br\0report-status atomic object-format=sha1 agent=git/2.43.0\n`),
        FLUSH_PKT,
      ])
    )
  );
  assertEq(commands, [{ old: ZERO, next: h.commit2, ref: "refs/heads/of-br" }], "the command parses");
  assert(caps.includes("object-format=sha1"), "the client's object-format capability is recognized");
});

// ---------------------------------------------------------------------------
// 1. the generated table itself
// ---------------------------------------------------------------------------

await check("matrix: the v0 fetch advertisement parses into the advertised table (live bytes, not hand-maintained)", async () => {
  const caps = table["v0 fetch (git-upload-pack)"];
  for (const token of ["multi_ack_detailed", "no-done", "shallow", "side-band-64k"]) {
    assert(caps.includes(token), `advertised: ${token} (in ${JSON.stringify(caps)})`);
  }
  assert(caps.some((t) => t.startsWith("symref=HEAD:")), "advertised: symref=HEAD:<target>");
  assert(caps.some((t) => t.startsWith("agent=")), "advertised: agent=<name>/<version>");
  assert(!caps.includes("filter"), "filter is a protocol-v2 capability, not a v0 one");
  assert(!caps.includes("ofs-delta"), "ofs-delta is a push capability, not a fetch one");
});

await check("matrix: the v0 push advertisement parses into the advertised table", async () => {
  const caps = table["v0 push (git-receive-pack)"];
  for (const token of ["report-status", "report-status-v2", "delete-refs", "ofs-delta", "side-band-64k", "atomic", "push-options", "object-format=sha1"]) {
    assert(caps.includes(token), `advertised: ${token} (in ${JSON.stringify(caps)})`);
  }
  assert(caps.some((t) => t.startsWith("agent=")), "advertised: agent=<name>/<version>");
  assert(!caps.includes("shallow"), "shallow is a fetch capability, not a push one");
  assert(!caps.includes("quiet"), "quiet stays unadvertised (no honest live proof of progress suppression — NOTICE.md)");
});

await check("matrix: the v2 advertisement parses into the advertised table", async () => {
  const caps = table["v2 fetch (protocol v2)"];
  assert(caps.includes("ls-refs=unborn"), `advertised: ls-refs=unborn (in ${JSON.stringify(caps)})`);
  assert(caps.includes("fetch=shallow filter"), `advertised: fetch=shallow filter (in ${JSON.stringify(caps)})`);
  assert(caps.some((t) => t.startsWith("agent=")), "advertised: agent");
});

await check("matrix: the empty-repo advertisement is well-formed (capabilities^{} carries the full list)", async () => {
  const { store: empty } = makeStore();
  const bytes = advertisement(empty, "git-upload-pack", false);
  const lines = parsePktLines(bytes);
  const line = lines.find((l) => l !== null && !l.startsWith("# service="));
  assert(line.startsWith(`${ZERO} capabilities^{}\0`), `the empty-repo line shape: ${JSON.stringify(line?.slice(0, 60))}`);
  const caps = line.split("\0")[1].split(" ").filter(Boolean);
  for (const token of ["multi_ack_detailed", "no-done", "shallow", "side-band-64k"]) {
    assert(caps.includes(token), `the empty-repo advertisement keeps ${token}`);
  }
});

// ---------------------------------------------------------------------------
// 2. the CONSISTENCY GATE: every advertised token resolves to a proof
// ---------------------------------------------------------------------------

const unresolved = [];
const resolvedProofs = new Map(); // proofFn -> token it serves
for (const [handshake, tokens] of Object.entries(table)) {
  for (const token of tokens) {
    const key = proofs[token] ? token : token.split("=")[0];
    const fn = proofs[key];
    if (!fn) {
      unresolved.push(`${handshake}: ${token}`);
      continue;
    }
    if (!resolvedProofs.has(fn)) resolvedProofs.set(fn, { key, token, handshake });
  }
}

await check("gate: every advertised capability maps onto a handler proof (AdvertisedFeature ⇒ ParsedAndHandled) — no hand-maintained claims", async () => {
  assertEq(unresolved, [], `every advertised feature must have a proof; missing: ${unresolved.join("; ")}`);
  assert(resolvedProofs.size >= 13, `the generated matrix exercised ${resolvedProofs.size} proofs`);
});

// 3. run every proof
for (const [fn, { key, token, handshake }] of resolvedProofs) {
  await check(`proof [${handshake}] ${token} ⇒ handled (registry key: ${key})`, async () => {
    await fn(token);
  });
}

// ---------------------------------------------------------------------------
// 4. contrapositive pins
// ---------------------------------------------------------------------------

await check("contrapositive: filter specs OUTSIDE the advertised blob family are rejected fail-closed, never silently ignored", async () => {
  for (const spec of ["sparse:oid=HEAD", "tree:0", "combine:blob:none+blob:limit=1"]) {
    const v2res = await uploadPack(store, v2(["agent=git/2.43.0"], [`want ${h.commit2}`, `filter ${spec}`, "done"]));
    assert(
      (await responseText(v2res)).includes("ERR upload-pack: unsupported fetch argument 'filter'"),
      `an unimplemented filter spec (${spec}) is rejected in v2`
    );
  }
  // a filter line is a fetch-only argument: on a v0 request (no command=)
  // it is not recognized and fails closed too
  const v0res = await uploadPack(store, v0([`want ${h.commit2}`, "filter blob:none", "done"]));
  assert((await responseText(v0res)).includes("ERR upload-pack: unsupported fetch argument 'filter'"), "filter rejected in v0 too");
});

await check("contrapositive: unknown fetch arguments fail closed (the matrix's fail-closed half)", async () => {
  const res = await uploadPack(store, v0([`want ${h.commit2}`, "wait-with-whitespace", "done"]));
  assert((await responseText(res)).includes("ERR upload-pack: unsupported fetch argument"), "unknown argument rejected");
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} capability-matrix checks passed`);
