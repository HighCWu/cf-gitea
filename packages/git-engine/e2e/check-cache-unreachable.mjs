// G3 DIRECT evidence (the external reviewer's independent-audit condition):
// the parse-struct conditions (check-deepen-parse.mjs) plus the code-order
// fact (`if (req.badArgument) return null;` before the fullClone predicate)
// are INDIRECT — nothing proved the `currentPackKey` RPC is never CALLED.
// This check drives the REAL public serve path over a counting DO stub and
// asserts exactly that, with a non-vacuous control case. Run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-cache-unreachable.mjs
// Exits non-zero on the first violated assertion.
//
// Seam: the public caller — `createDurableGit().fetch` — is the production
// call site of the module-private `serveCloneFromR2` (mod.ts: the buffered
// /git-upload-pack branch), so stubbing the bindings and invoking the handler
// exercises routing, the auth gate, body buffering, and the fast path itself
// with ZERO engine source change: `serveCloneFromR2` stays module-private.
// The counting stub IS the DurableObjectStub the engine would RPC into, so
// its `currentPackKey` call count is the RPC call count.
//
// `cloudflare:workers` shim: mod.ts's import graph (src/repo.ts) extends
// `DurableObject` at module scope. The check never constructs a cell — the
// DO is the counting stub below — so a resolve hook maps the specifier to an
// inert base class, registered before the dynamic imports (static imports
// would evaluate before the hook lands).
import { register } from "node:module";

const hook =
  "export function resolve(s,c,n){return s==='cloudflare:workers'" +
  "?{url:'data:text/javascript,export class DurableObject{}',shortCircuit:true}" +
  ":n(s,c)}";
register("data:text/javascript," + encodeURIComponent(hook), import.meta.url);

const { createDurableGit } = await import("../src/mod.ts");
const { parseUploadRequest } = await import("../src/git/protocol.ts");

const OID = "1234567890123456789012345678901234567890";
const OID2 = "fedcba09fedcba09fedcba09fedcba09fedcba09";
// the engine routes /<name>.git/... to the bare name (URLPattern `{.git}?`)
const REPO = "r0";

// Request builders — same v2 shape as check-deepen-parse.mjs (duplicated, not
// imported: sibling check scripts are runnable units with top-level effects).
const pkt = (s) => Buffer.from((s.length + 4).toString(16).padStart(4, "0") + s);
const FLUSH = Buffer.from("0000");
function v2(args) {
  return Buffer.concat([
    pkt("command=fetch"),
    Buffer.from("0001"), // DELIM
    ...args.map(pkt),
    FLUSH,
  ]);
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failures = 0;
function check(name, cond) {
  if (cond) console.log(`ok: ${name}`);
  else {
    failures++;
    console.log(`FAIL: ${name}`);
  }
}

// The DO stub: `currentPackKey` and `fetch` are spied; ANY other property
// call is recorded too, so guard drift to a different RPC fails loudly.
function doStub(log) {
  const props = new Map();
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== "string") return undefined;
        if (!props.has(prop)) {
          if (prop === "currentPackKey") {
            props.set(prop, async (repo, wants) => {
              log.currentPackKey.push({ repo, wants: [...wants] });
              return log.packKey; // null = cache miss; a key = probe succeeds
            });
          } else if (prop === "fetch") {
            props.set(prop, async () => {
              log.doFetch++;
              return new Response("DO-PATH", { status: 200 });
            });
          } else {
            props.set(prop, async (...args) => {
              log.otherRpc.push({ rpc: prop, argc: args.length });
              throw new Error(`unexpected DO RPC: ${prop}`);
            });
          }
        }
        return props.get(prop);
      },
    }
  );
}

// REPO_PACKS: every R2 method records and then throws if called, except a
// scripted `get` for the control case's cache read.
function r2Bucket(log, scriptGet) {
  const bucket = {};
  for (const m of ["head", "get", "put", "delete", "list", "createMultipartUpload", "resumeMultipartUpload"]) {
    bucket[m] = async (...args) => {
      log.r2.push(m);
      if (typeof args[0] === "string") log.r2Keys.push(args[0]);
      if (m === "get" && scriptGet) return scriptGet(...args);
      throw new Error(`unexpected R2 interaction: REPO_PACKS.${m}`);
    };
  }
  return bucket;
}

const INFO = { name: REPO, desc: "", owner: "", section: "", priv: 0, idle: 0, ver: 1 };
const CLONE_URL = `http://dgit.test/${REPO}.git/git-upload-pack`;
function newLog() {
  return { currentPackKey: [], doFetch: 0, otherRpc: [], r2: [], r2Keys: [], packKey: null };
}
function makeEnv(log, scriptGet) {
  return {
    REPO_PACKS: r2Bucket(log, scriptGet),
    REPO: { getByName: () => doStub(log) },
    REGISTRY: { getByName: () => ({ get: async () => INFO }) },
  };
}
function uploadPackRequest(body) {
  return new Request(CLONE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-upload-pack-request",
      "content-length": String(body.length),
    },
    body,
  });
}

// Auth-gate pass (public read) via the public DurableGitOptions seam.
const handler = createDurableGit({ authorize: () => true });
const CTX = { waitUntil() {} };

// ---- the poisoned request: deepen-since + wants all-tips + no haves + done,
// the exact bytes check-deepen-parse.mjs proves satisfy every OTHER
// fullClone cache-predicate condition. What is asserted is the PROPERTY the
// reviewer asked for — the RPC is never CALLED — not a particular guard:
// serveCloneFromR2 enforces it redundantly (the badArgument short-circuit AND
// the fullClone predicate's deepen==="none" member; a mutation exercise that
// removed the short-circuit alone still passed, removing BOTH fails the zero-
// calls assertion below — the check is sensitive to a real unreachability
// regression, not wired to one line).
const poisonBody = v2([`want ${OID}`, `want ${OID2}`, "deepen-since 2020-01-01", "done"]);
const poison = parseUploadRequest(poisonBody);
check(
  "G3-direct poisoned: parse verdict present (badArgument=deepen-since, deepen unsupported) — the parse-struct precondition",
  poison.badArgument === "deepen-since" && poison.deepen.kind === "unsupported"
);

const logA = newLog();
const resA = await handler.fetch(uploadPackRequest(poisonBody), makeEnv(logA), CTX);
check("G3-direct poisoned: currentPackKey RPC called ZERO times", logA.currentPackKey.length === 0);
check("G3-direct poisoned: zero R2 bucket interactions", logA.r2.length === 0 && logA.r2Keys.length === 0);
check("G3-direct poisoned: no other DO RPC attempted", logA.otherRpc.length === 0);
const textA = await resA.text();
check(
  "G3-direct poisoned: serve path returned null — no cache response, the request fell through to the DO (where the ERR is rendered)",
  resA.headers.get("x-pack-cache") === null && textA === "DO-PATH" && logA.doFetch === 1
);

// ---- the control: a LEGAL full-clone request reaches currentPackKey exactly
// once and is served from the R2 cache — the stub is wired, not vacuous.
const legalBody = v2([`want ${OID}`, "done"]);
const legal = parseUploadRequest(legalBody);
check(
  "G3-direct control: legal full clone satisfies the fullClone predicate",
  legal.badArgument === null &&
    legal.wants.length === 1 &&
    legal.haves.length === 0 &&
    legal.done &&
    legal.deepen.kind === "none" &&
    legal.clientShallows.length === 0 &&
    legal.command === "fetch"
);

// minimal fake pack (magic + version + count — only the framing is under test)
const FAKE_PACK = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 3]);
const logB = newLog();
logB.packKey = "repos/r0/clone-cache/k.pack";
const resB = await handler.fetch(
  uploadPackRequest(legalBody),
  makeEnv(logB, async () => ({
    body: new Response(FAKE_PACK).body,
    size: FAKE_PACK.length,
    customMetadata: { objects: "3" },
  })),
  CTX
);
check(
  "G3-direct control: currentPackKey called exactly once, with the repo and the request's wants",
  logB.currentPackKey.length === 1 && logB.currentPackKey[0].repo === REPO && eq(logB.currentPackKey[0].wants, [OID])
);
check(
  "G3-direct control: R2 touched exactly once — the cache GET of the probed key",
  eq(logB.r2, ["get"]) && eq(logB.r2Keys, [logB.packKey])
);
check("G3-direct control: the DO is never contacted for bytes", logB.doFetch === 0 && logB.otherRpc.length === 0);
const textB = await resB.text();
check(
  "G3-direct control: cache response served (x-pack-cache: hit, upload-pack content type, v2 packfile frame + flush)",
  resB.headers.get("x-pack-cache") === "hit" &&
    resB.headers.get("content-type") === "application/x-git-upload-pack-result" &&
    textB.startsWith("000dpackfile\n") &&
    textB.endsWith("0000")
);

if (failures) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall cache-unreachable checks passed");
