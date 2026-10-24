// P0 gate: parse-level recognition of the deepen family (G1), combination
// safety (G4), and full-clone-cache unreachability (G3) — run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-deepen-parse.mjs
// Exits non-zero on the first violated assertion. The ERR rendering these
// verdicts drive (G2) is verified against a real git client in the landing
// report (G5); parseUploadRequest is the single gate both paths read.
import { parseUploadRequest } from "../src/git/protocol.ts";

const OID = "1234567890123456789012345678901234567890";
const OID2 = "fedcba09fedcba09fedcba09fedcba09fedcba09";
const pkt = (s) => Buffer.concat([Buffer.from(s.length + 4 >= 16 ? "" : ""), Buffer.from((s.length + 4).toString(16).padStart(4, "0")), Buffer.from(s)]);

const FLUSH = Buffer.from("0000");
function v0(lines) {
  return Buffer.concat([...lines.map(pkt), FLUSH]);
}
function v2(pre, args) {
  return Buffer.concat([
    pkt("command=fetch"),
    ...pre.map(pkt),
    Buffer.from("0001"), // DELIM
    ...args.map(pkt),
    FLUSH,
  ]);
}
let failures = 0;
function check(name, cond) {
  if (cond) console.log(`ok: ${name}`);
  else {
    failures++;
    console.log(`FAIL: ${name}`);
  }
}

// G1: every deepen-family argument is parsed-or-rejected, in both phases
const since = parseUploadRequest(v0([`want ${OID}`, "deepen-since 2020-01-01", "done"]));
check("G1 deepen-since rejected (v0)", since.badArgument === "deepen-since" && since.deepen.kind === "unsupported");
const not = parseUploadRequest(v0([`want ${OID}`, `deepen-not refs/heads/x`, "done"]));
check("G1 deepen-not rejected (v0)", not.badArgument === "deepen-not" && not.deepen.kind === "unsupported");
const rel = parseUploadRequest(v2([], ["deepen-relative", `want ${OID}`, "done"]));
check("G1 deepen-relative rejected (v2 args phase)", rel.badArgument === "deepen-relative" && rel.deepen.kind === "unsupported");
const filt = parseUploadRequest(v2([], [`want ${OID}`, "filter blob:none", "done"]));
check("G1 filter rejected (partial clone unimplemented)", filt.badArgument === "filter");
const unknown = parseUploadRequest(v0([`want ${OID}`, "deepen-mystery 3", "done"]));
check("G1 unknown fetch argument fails closed", unknown.badArgument === "deepen-mystery");

// supported forms stay supported
const depth = parseUploadRequest(v0([`want ${OID}`, "deepen 3", "done"]));
check("G1 deepen <n> still supported (v0)", depth.badArgument === null && depth.deepen.kind === "depth" && depth.deepen.depth === 3);
const depthV2 = parseUploadRequest(v2(["agent=git/2.43", "object-format=sha1"], [`want ${OID}`, "deepen 5", "done"]));
check("G1 deepen <n> supported (v2, capability updates pre-DELIM untouched)", depthV2.badArgument === null && depthV2.deepen.depth === 5 && depthV2.command === "fetch");
const plain = parseUploadRequest(v0([`want ${OID}`, "done"]));
check("G1 plain fetch parses clean", plain.badArgument === null && plain.deepen.kind === "none" && plain.done);

// phase awareness: capability updates are never fetch arguments; the same
// line past the DELIM is an unknown fetch argument and IS rejected
const capLine = parseUploadRequest(v2(["agent=git/2.43"], [`want ${OID}`, "done"]));
check("phase-aware: agent= pre-DELIM is a capability update", capLine.badArgument === null);
const capLate = parseUploadRequest(v2([], [`want ${OID}`, "agent=git/2.43", "done"]));
check("phase-aware: agent= post-DELIM is an unknown fetch argument", capLate.badArgument === "agent=git/2.43");

// G4: combination safety — a unsupported deepen-family argument is sticky;
// a later `deepen <n>` never overwrites it into a silent depth/full fetch
const comboA = parseUploadRequest(v0([`want ${OID}`, "deepen 10", "deepen-since 2020-01-01", "done"]));
check("G4 deepen 10 + deepen-since -> unsupported (not depth)", comboA.badArgument === "deepen-since" && comboA.deepen.kind === "unsupported");
const comboB = parseUploadRequest(v0([`want ${OID}`, "deepen-since 2020-01-01", "deepen 10", "done"]));
check("G4 deepen-since + deepen 10 -> stays unsupported (no field overwrite)", comboB.badArgument === "deepen-since" && comboB.deepen.kind === "unsupported");

// G3: the full-clone cache predicate is unreachable for such requests. The
// fast path's fullClone conditions (mod.ts serveCloneFromR2) are: wants,
// no haves, done, deepen none, no shallows — the poisoning combo satisfies
// ALL of them except the deepen mode, which the parser refuses to report as
// "none" — plus the explicit badArgument short-circuit ahead of the probe.
const poison = parseUploadRequest(v2([], [`want ${OID}`, `want ${OID2}`, "deepen-since 2020-01-01", "done"]));
const predicateWithoutGuard =
  poison.wants.length > 0 &&
  poison.wants.every((w) => /^[0-9a-f]{40}$/.test(w)) &&
  poison.haves.length === 0 &&
  poison.done &&
  poison.clientShallows.length === 0;
check("G3 poisoning combo: every other cache-predicate condition holds", predicateWithoutGuard);
check("G3 poisoning combo: deepen mode is not 'none' + badArgument set (cache unreachable)", poison.deepen.kind === "unsupported" && !!poison.badArgument);

// G4-adjacent: the client's existing shallow boundaries remain orthogonal
const shallowLines = parseUploadRequest(v0([`want ${OID}`, `shallow ${OID2}`, "deepen 2", "done"]));
check("shallow <oid> lines still parsed alongside deepen <n>", shallowLines.clientShallows.length === 1 && shallowLines.deepen.depth === 2 && !shallowLines.badArgument);

if (failures) {
  console.log(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nall deepen-parse checks passed");

// G5 support: a real v2 ls-refs request carries value-taking arguments
// ("ref-prefix <prefix>") — they must stay recognized as knownIgnorable
const lsRefs = parseUploadRequest(
  Buffer.concat([
    pkt("command=ls-refs"),
    pkt("agent=git/2.43"),
    Buffer.from("0001"),
    pkt("peel"),
    pkt("symrefs"),
    pkt("ref-prefix refs/heads/"),
    pkt("ref-prefix refs/tags/"),
    FLUSH,
  ])
);
check("G5 ls-refs request with ref-prefix values parses clean", lsRefs.badArgument === null && lsRefs.command === "ls-refs");
if (failures) process.exit(1);
