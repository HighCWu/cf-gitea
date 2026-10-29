// The receive entry's name binding — the degenerate `repos//` staging guard.
// Run with tsx, the same mechanism as check-push-origin.mjs (see e2e/README.md):
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-receive-name-bind.mjs
// Exits non-zero on the first violated assertion.
//
// The hazard (wiki-r2 open issue 2): the SPEC-0001a split moved the receive
// entry from the cell's fetch handler (which ran bindR2 on EVERY request —
// upstream dgit v0.0.8's own entry shape — persisting meta.repo before any
// key derivation) to the direct stub.beginReceive RPC, which never runs
// fetch. rpcBind can only rebind from an ALREADY-persisted name, so a direct
// receive-pack POST against a NEVER-FETCHED cell (no prior info/refs advert;
// the protocol permits it and the engine's create-by-push depends on it)
// resolved the EMPTY storage key in control-plane.ts's resolveStorageKey
// fallback chain (meta.storage_key ?? meta.repo ?? "") and staged at the
// degenerate `repos//` prefix — real bytes, unreachable namespace.
//
// The fix: mod.ts's receivePack binds the cell name (new RepoCell.bindRepo
// RPC) BEFORE beginReceive — restoring upstream's entry binding at the
// adapted entry. These checks drive the REAL Worker-side flow
// (createDurableGit().fetch over the real parse/stage/scan/finalize pipeline,
// real control plane over node:sqlite, R2 staged in memory) against a FRESH
// cell — no seeded meta, the exact never-fetched shape.
//
// Covers, in order:
//   1.  THE REPRODUCTION: header-less receive-pack POST (the direct,
//       no-preflight shape) on a fresh cell binds the name FIRST (bindRepo
//       precedes beginReceive on the RPC trace), stages and stores under
//       `repos/<do-name>/`, writes NO `repos//` key, lands the ref, and
//       persists meta.storage_key to the name (the documented migration).
//   2.  the wiki cell shape (`owner/proj.wiki` — the sibling cell is the
//       population that motivated the issue): same binding under the dotted
//       name; a later fetch entry would resolve the identical prefix
//       (bindR2 → storageKey() → meta.repo — the two entries converge).
//   3.  the D1-backed contact is UNCHANGED: with an `x-storage-key: r_...`
//       header the explicit r_<id> wins over the bound name (staging under
//       `repos/r_.../`, meta.storage_key = r_...), while meta.repo still
//       carries the cell name (SPEC-0001a §3 Step 3's resolution order).
//   4.  the advert-first path is byte-identical to before: a cell whose name
//       a prior fetch already bound (the seeded shape every pre-fix flow
//       relied on) takes the same name-addressed prefix with no header.
//   5.  static tripwires (the check-fault-matrix convention): the bind call
//       sits BEFORE the beginReceive call in receivePack; RepoCell.bindRepo
//       persists through bindR2 behind the sealed-cell guard; the staging
//       key has exactly ONE construction site (control-plane.ts's
//       beginReceive — the upload/clone path builds no staging keys, so the
//       degenerate prefix has no read-side door); the upload forward always
//       carries x-repo (the fetch entry binds before any upload resolves).
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
// (same shim as check-push-origin.mjs / check-correctness-tier.mjs).
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

// ---- fixture builders (fulls only — no deltas needed) -----------------------

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

/** One root commit with its own blob+tree. */
function commitOf(message, blobText) {
  const blob = te.encode(blobText);
  const blobOid = hashObject("blob", blob);
  const tree = serializeTree([{ mode: "100644", oid: blobOid, name: "f.txt" }]);
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: PERSON, committer: PERSON, message });
  const pack = buildPack([
    { type: "blob", data: blob },
    { type: "tree", data: tree.data },
    { type: "commit", data: commit.data },
  ]);
  return { oid: commit.oid, pack };
}

const A = commitOf("a root", "blob a\n");

// ---- the receive harness (real flow, real control plane, in-memory R2) ------
//
// `cellName` is the DO name (env.REPO.getByName argument — the URL name the
// Worker derived). `seedRepoName` pre-binds meta.repo (the shape a prior
// info/refs fetch leaves behind); null = the NEVER-FETCHED cell.

function makeRepo(cellName, seedRepoName) {
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
  const t = { db, sql, tx, objects: new Map(), rpcs: [], cellName };
  t.store = new GitStore(sql, { tx });
  if (seedRepoName !== null) t.store.setMeta("repo", seedRepoName);
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
  const impl = {
    // RepoCell.bindRepo's effect over the harness store (the static tripwire
    // in check 5 pins the real method to this shape): the fetch entry's
    // bindR2 — rebind R2 from the resolved storage key and persist the name.
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

/** POST /git-receive-pack through the REAL createDurableGit().fetch — the
 *  worker's mounting (`namespaces: true`, src/index.ts): the combined
 *  `owner/name` URL resolves to the combined DO name, exactly the shape a
 *  cf-gitea receive forward carries. `extraHeaders` carries the
 *  x-storage-key override (D1-backed contact). */
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

const mainTip = (t) => t.store.getRef("refs/heads/main");

// ---- the checks --------------------------------------------------------------

await check("1. REPRODUCTION: header-less POST on a never-fetched cell stages under the name, never repos//", async () => {
  const NAME = "alice/proj";
  const t = makeRepo(NAME, null);
  const rx = makePostReceive(t);
  const res = await rx.post("http://dgit.test", receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  assertEq(res.status, 200, "http status");
  await rx.flushWaits();
  // the bytes must live under the NAME-addressed prefix (asserted FIRST so a
  // regression prints the degenerate key itself as the evidence)
  const keys = [...t.objects.keys()];
  assert(keys.length > 0, "pack bytes landed in R2");
  for (const k of keys) {
    assert(k.startsWith(`repos/${NAME}/`), `staged under the name prefix, got ${k}`);
    assert(!k.startsWith("repos//"), `no degenerate prefix, got ${k}`);
  }
  // the entry binds the cell name BEFORE the lease opens (the fetch entry's
  // upstream ordering, carried to the direct-RPC entry)
  assertEq(t.rpcs[0], `bindRepo:${NAME}`, "bindRepo is the entry's first RPC");
  assertEq(t.rpcs[1], "beginReceive", "the lease opens after the bind");
  assertEq(mainTip(t), A.oid, "push applied (report-status ok)");
  // the resolution persists (the documented migration: meta.repo → meta.storage_key)
  assertEq(t.store.getMeta("storage_key"), NAME, "meta.storage_key persisted to the name");
});

await check("2. the wiki cell shape (dotted name) binds and stages under owner/proj.wiki", async () => {
  const NAME = "alice/proj.wiki";
  const t = makeRepo(NAME, null);
  const rx = makePostReceive(t);
  const res = await rx.post("http://dgit.test", receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  assertEq(res.status, 200, "http status");
  await rx.flushWaits();
  assertEq(t.rpcs[0], `bindRepo:${NAME}`, "the sibling cell binds its own dotted name");
  for (const k of t.objects.keys()) {
    assert(k.startsWith(`repos/${NAME}/`), `wiki prefix, got ${k}`);
    assert(!k.startsWith("repos//"), `no degenerate prefix, got ${k}`);
  }
  assertEq(mainTip(t), A.oid, "wiki push applied");
  // a LATER fetch entry would resolve the identical prefix (bindR2 →
  // storageKey() → meta.repo), so the two entries converge on one namespace.
  assertEq(t.store.getMeta("storage_key"), NAME, "the name the fetch entry would rebind");
});

await check("3. D1-backed contact unchanged: explicit x-storage-key wins over the bound name", async () => {
  const NAME = "bob/repo";
  const t = makeRepo(NAME, null);
  const rx = makePostReceive(t);
  const res = await rx.post(
    "http://dgit.test",
    receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes),
    { "x-storage-key": "r_123" }
  );
  assertEq(res.status, 200, "http status");
  await rx.flushWaits();
  assertEq(t.rpcs[0], `bindRepo:${NAME}`, "the bind still precedes the lease");
  for (const k of t.objects.keys()) {
    assert(k.startsWith("repos/r_123/"), `explicit r_<id> addressing, got ${k}`);
  }
  assertEq(t.store.getMeta("storage_key"), "r_123", "r_<id> persisted (SPEC-0001a §3 Step 3)");
  assertEq(t.store.getMeta("repo"), NAME, "meta.repo carries the cell name");
  assertEq(mainTip(t), A.oid, "push applied");
});

await check("4. the advert-first path is unchanged: a pre-bound cell takes the same prefix with no header", async () => {
  const NAME = "carol/old";
  const t = makeRepo(NAME, NAME); // meta.repo bound by a prior info/refs fetch
  const rx = makePostReceive(t);
  const res = await rx.post("http://dgit.test", receiveBody([`${ZERO_OID} ${A.oid} refs/heads/main`], A.pack.bytes));
  assertEq(res.status, 200, "http status");
  await rx.flushWaits();
  assertEq(t.rpcs[0], `bindRepo:${NAME}`, "the bind is unconditional (idempotent on a bound cell)");
  for (const k of t.objects.keys()) {
    assert(k.startsWith(`repos/${NAME}/`), `name-addressed prefix, got ${k}`);
  }
  assertEq(mainTip(t), A.oid, "push applied");
});

await check("5. static tripwires: bind-before-begin, one staging-key site, x-repo on every upload forward", async () => {
  const modSrc = readFileSync(fileURLToPath(new URL("../src/mod.ts", import.meta.url)), "utf8");
  const repoSrc = readFileSync(fileURLToPath(new URL("../src/repo.ts", import.meta.url)), "utf8");
  const cpSrc = readFileSync(fileURLToPath(new URL("../src/control-plane.ts", import.meta.url)), "utf8");
  // (a) receivePack binds the cell name BEFORE opening the lease — the
  //     beginReceive call must not precede the bind call
  const bindAt = modSrc.indexOf("await stub.bindRepo(repo)");
  const beginAt = modSrc.indexOf("await stub.beginReceive(");
  assert(bindAt !== -1, "receivePack binds the cell name (stub.bindRepo call present)");
  assert(beginAt !== -1, "receivePack opens the lease via stub.beginReceive");
  assert(bindAt < beginAt, "the bind precedes the beginReceive call in receivePack");
  // (b) RepoCell.bindRepo persists the name through bindR2, behind the
  //     sealed-cell guard (the harness stub replicates exactly this)
  assert(
    /async bindRepo\(repo: string\): Promise<void> \{\n[^}]*schemaState\.refused[^}]*return;[\s\S]*?this\.bindR2\(repo\);/.test(repoSrc),
    "bindRepo: sealed guard + bindR2 persistence"
  );
  // (c) ONE staging-key construction site — control-plane.ts's beginReceive
  //     (the r2keys builder, imported aliased); the Worker-side receive and
  //     the upload/clone path build no staging keys, so the degenerate
  //     prefix has no second door
  const cpSites = cpSrc.split("buildStagingKey(storageKey, leaseToken)").length - 1;
  assertEq(cpSites, 1, "exactly one stagingKey construction (control-plane beginReceive)");
  assert(!modSrc.includes("buildStagingKey("), "the Worker-side receive builds no staging key");
  // (d) the upload forward always sets x-repo — the fetch entry binds before
  //     any upload resolves a key (repo.ts fetch → bindR2)
  assert(modSrc.includes('fwd.headers.set("x-repo", repo)'), "upload forward carries x-repo");
});

console.log(`\ncheck-receive-name-bind: ${planned - failures.length}/${planned} checks passed`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join("; ")}`);
  process.exit(1);
}
