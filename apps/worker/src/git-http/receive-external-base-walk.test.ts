/**
 * The TRUE-EXTERNAL thin-base receive walk — regression fixture for the
 * mirror-wall workload shape (L744 §3.2).
 *
 * The windowed-thin battery (receive-delta-base.test.ts) pins the arms that
 * used to fail deterministically — chain nodes outgrowing the ingest cache —
 * using packs whose delta bases point INTO the pack. The real mirror push
 * that stalled production is a different shape: ONE commit whose thin pack is
 * almost entirely REF_DELTA entries, every base a TRUE EXTERNAL (an object
 * only the server's object database holds, in none of the pack's own
 * entries), so the resolver materializes each base by walking the STORED
 * delta chains. The measured production window (cf-gitea-prod,
 * comfyui-frontend mirror, 2026-11-25 09:48Z) walked that pool one single-oid
 * `lookupObjects` DO RPC plus one R2 range read per hop
 * (`tryResolve` → `materializeForeign`) — 87 RPCs / 2m14s — and died on the
 * ~2.4min platform teardown line, while every local battery of the time
 * stayed green, because none of them exercised this shape.
 *
 * This battery pins the workload SHAPE, not the wall-clock cost (CI must not
 * reproduce 2m14s): the pack shape mirrors the measured real window, whose
 * parameters were extracted read-only from the mirror source repository
 * (comfyui-frontend, pending window `40cfc43c` over frozen tip `35a811c5`):
 *
 *   - 53 entries / 18,585 bytes: 1 commit + 8 full blobs + 3 full trees +
 *     41 REF_DELTA entries and ZERO ofs-delta entries;
 *   - all 41 REF_DELTA bases external (0 in-pack), all 41 distinct;
 *   - each base's stored delta chain depth in the receiving object database
 *     (hops from the base object down to a stored full object), read off the
 *     source repository's pack files as the structure proxy for the remote
 *     store's received-window packs: 1×17, 2×11, 3×4, 4×2, 5×2, 6×1, 9×1,
 *     0×3 (38 bases found packed, 3 loose-as-full — 41 total).
 *
 * Window 1 below pre-seeds the object database with that exact baseline:
 * 41 DISJOINT chains with the measured depth distribution (full blob, then
 * `depth` ofs-delta nodes on top, exactly the base-before-delta order git
 * writes), anchored by a tree + commit. Window 2 is the true-external thin
 * pack: 41 REF_DELTA entries — one per chain tip, zero ofs-delta, all bases
 * outside the pack — anchored by its own tree + commit.
 *
 * The assertions pin the walk's cost shape through the engine's own
 * subrequest metric line (`[receive <repo>] subrequests: ... lookups=N/M
 * ... rangeGets=...`, packages/git-engine src/mod.ts — the exact counter the
 * production evidence read "87" from):
 *
 *   - window 1 (self-contained baseline): `lookups=0/0 rangeGets=0` — a
 *     baseline push consults the object database ZERO times;
 *   - window 2 (true-external thin, the L761 wave-batched channel):
 *     `lookups=(max chain depth+1)+1 / Σ(1+depth)+1` and
 *     `rangeGets=Σ(1+depth)` — the object-database consults are WAVE-
 *     BATCHED: one batched `lookupObjects` RPC per chain wave (wave 0
 *     fetches every external base, wave k+1 the stored-chain bases of wave
 *     k's delta nodes), so the whole 41-base pool costs max-depth+1 RPCs
 *     instead of the 125 single-oid hop RPCs the measured window died on.
 *     The oid total N is unchanged — every chain node is still consulted
 *     exactly once; the +1 is the connectivity anti-check's single batched
 *     parent lookup; rangeGets is unchanged — one R2 range read per hop and
 *     per terminal full. A regression to the per-hop single-oid channel
 *     (126/126), a channel cut (bases unresolvable → unpack ng), or any
 *     other scheduling-shape change moves these counts — re-pin explicitly,
 *     citing the shape that justifies the new numbers.
 *
 * Non-goals: the cache-defeat arms (over-bound bases re-materializing) are
 * the windowed-thin battery's subject; anchor counts (3 trees / 8 full blobs
 * in the real pack) are collapsed to the minimal tree + commit here — they
 * do not affect the pinned per-hop base-resolution channel.
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_collaborators", "repo_units", "repo_counters", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

const RECEIVE_CT = "application/x-git-receive-pack-request";

// ---------------------------------------------------------------------------
// The measured shape (see the module comment for provenance).
// ---------------------------------------------------------------------------

/** Stored delta-chain depth per external base, the measured distribution. */
const BASE_CHAIN_DEPTHS: number[] = [
  ...Array<number>(17).fill(1),
  ...Array<number>(11).fill(2),
  ...Array<number>(4).fill(3),
  ...Array<number>(2).fill(4),
  ...Array<number>(2).fill(5),
  ...Array<number>(1).fill(6),
  ...Array<number>(1).fill(9),
  ...Array<number>(3).fill(0),
];

/** Lookups (and range reads) the walk spends per base: itself + every hop. */
const FOREIGN_WALKS = BASE_CHAIN_DEPTHS.reduce((sum, depth) => sum + 1 + depth, 0);
/** The connectivity anti-check's single batched lookup (the parent commit). */
const ANTI_CHECK_BATCHES = 1;
/** The object-database channel is WAVE-BATCHED: one batched `lookupObjects`
 *  RPC per chain wave — wave 0 fetches every external base, wave k+1 the
 *  stored-chain bases of wave k's delta nodes — so the pool costs
 *  max-chain-depth+1 waves, not Σ(1+depth) single-oid hops (the measured
 *  87-RPC / 2m14s shape that died on the ~2.4min teardown line). */
const EXPECTED_WAVES = Math.max(...BASE_CHAIN_DEPTHS) + 1;
const EXPECTED_LOOKUP_RPCS = EXPECTED_WAVES + ANTI_CHECK_BATCHES;
const EXPECTED_LOOKUP_OIDS = FOREIGN_WALKS + ANTI_CHECK_BATCHES;
const EXPECTED_RANGE_GETS = FOREIGN_WALKS;

// ---------------------------------------------------------------------------
// Byte fixtures (the delta-entry arms these need are not part of the shared
// lifecycle builder — same convention as the sibling push batteries).
// ---------------------------------------------------------------------------

function concatArrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha1(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", bytes));
}

async function sha1Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Deterministic pseudo-random body (deflate-resistant, git-blob-like).
 *  XOR (not OR) mixes the seed into the LCG state — OR is lossy and two
 *  near seeds can collapse to one state, i.e. to one body. */
function bodyOf(seed: number, length: number): Uint8Array {
  const body = new Uint8Array(length);
  let state = (seed ^ 0x12345678) & 0x7fffffff;
  for (let i = 0; i < body.length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    body[i] = (state >>> 16) & 0xff;
  }
  return body;
}

/** `base` with its last `tailLength` bytes replaced by a fresh tail — the
 *  shared prefix is what the fixture delta stream copies. */
function derivedBody(base: Uint8Array, seed: number, tailLength: number): Uint8Array {
  const tail = bodyOf(seed, tailLength);
  return concatArrays([base.subarray(0, base.length - tailLength), tail]);
}

function deltaVarint(n: number): Uint8Array {
  const bytes: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return new Uint8Array(bytes);
}

/** Copy-from-base opcode (offset ≤ 0xffffff, size in [1, 0xffff]). */
function copyOp(off: number, size: number): Uint8Array {
  let cmd = 0x80;
  const bytes: number[] = [];
  const offBytes = [off & 0xff, (off >>> 8) & 0xff, (off >>> 16) & 0xff];
  for (let i = 0; i < 3; i++) {
    if (offBytes[i] !== 0 || off >= 2 ** (8 * (i + 1))) {
      cmd |= 0x01 << i;
      bytes.push(offBytes[i] as number);
    }
  }
  const sizeBytes = [size & 0xff, (size >>> 8) & 0xff];
  for (let i = 0; i < 2; i++) {
    if (sizeBytes[i] !== 0 || size >= 2 ** (8 * (i + 1))) {
      cmd |= 0x10 << i;
      bytes.push(sizeBytes[i] as number);
    }
  }
  return new Uint8Array([cmd, ...bytes]);
}

/** git delta stream: copy the shared prefix, insert the rest as literals. */
function encodeDelta(base: Uint8Array, target: Uint8Array): Uint8Array {
  let keep = 0;
  const max = Math.min(base.length, target.length);
  while (keep < max && base[keep] === target[keep]) keep++;
  if (keep === 0) throw new Error("fixture delta shape needs a shared prefix");
  const tail = target.subarray(keep);
  const ops: Uint8Array[] = [];
  for (let off = 0; off < keep; off += 0xffff) {
    ops.push(copyOp(off, Math.min(keep - off, 0xffff)));
  }
  for (let i = 0; i < tail.length; i += 127) {
    const slice = tail.subarray(i, Math.min(i + 127, tail.length));
    ops.push(new Uint8Array([slice.length]), slice);
  }
  return concatArrays([deltaVarint(base.length), deltaVarint(target.length), ...ops]);
}

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

/** ofs-delta distance: git's subtract-one-per-continuation varint. */
function ofsHeader(distance: number): Uint8Array {
  const bytes: number[] = [distance & 0x7f];
  let n = distance >>> 7;
  while (n > 0) {
    n -= 1;
    bytes.unshift(0x80 | (n & 0x7f));
    n >>>= 7;
  }
  return new Uint8Array(bytes);
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function rawOid(oidHex: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

async function looseOid(typeName: string, body: Uint8Array): Promise<string> {
  return sha1(concatArrays([new TextEncoder().encode(`${typeName} ${body.length}\0`), body]));
}

function treeBodyOf(entries: { name: string; oid: string }[]): Uint8Array {
  return concatArrays(
    [...entries]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .flatMap((e) => [new TextEncoder().encode(`100644 ${e.name}\0`), rawOid(e.oid)]),
  );
}

async function treeOidOf(entries: { name: string; oid: string }[]): Promise<string> {
  return looseOid("tree", treeBodyOf(entries));
}

function commitBodyOf(tree: string, parent: string | null, message: string): Uint8Array {
  return new TextEncoder().encode(
    `tree ${tree}\n` +
      (parent ? `parent ${parent}\n` : "") +
      `author Test User <test@example.com> 1700000000 +0000\n` +
      `committer Test User <test@example.com> 1700000000 +0000\n\n` +
      message,
  );
}

async function commitOidOf(tree: string, parent: string | null, message: string): Promise<string> {
  return looseOid("commit", commitBodyOf(tree, parent, message));
}

type PackEntrySpec =
  | { kind: "full"; typeNum: number; body: Uint8Array }
  | { kind: "ofs"; baseEntryIndex: number; deltaBody: Uint8Array }
  | { kind: "ref"; baseOid: string; deltaBody: Uint8Array };

/** Assemble a pack v2 byte stream from typed entries, in base-before-delta
 *  order (git's own order, so ofs distances always point backward). */
async function assemblePack(specs: PackEntrySpec[]): Promise<Uint8Array> {
  const built = await Promise.all(
    specs.map(async (spec) => {
      if (spec.kind === "full") {
        return { spec, header: objectHeader(spec.typeNum, spec.body.length), payload: await zlibDeflate(spec.body) };
      }
      if (spec.kind === "ofs") {
        return { spec, header: objectHeader(6, spec.deltaBody.length), payload: await zlibDeflate(spec.deltaBody) };
      }
      return {
        spec,
        header: objectHeader(7, spec.deltaBody.length),
        payload: concatArrays([rawOid(spec.baseOid), await zlibDeflate(spec.deltaBody)]),
      };
    }),
  );
  const chunks: Uint8Array[] = [new TextEncoder().encode("PACK"), be32(2), be32(built.length)];
  let offset = 12;
  const starts: number[] = [];
  for (let i = 0; i < built.length; i++) {
    const e = built[i]!;
    starts.push(offset);
    if (e.spec.kind === "ofs") {
      const distance = offset - starts[e.spec.baseEntryIndex]!;
      const ofs = ofsHeader(distance);
      chunks.push(e.header, ofs, e.payload);
      offset += e.header.length + ofs.length + e.payload.length;
    } else {
      chunks.push(e.header, e.payload);
      offset += e.header.length + e.payload.length;
    }
  }
  chunks.push(await sha1Bytes(concatArrays(chunks)));
  return concatArrays(chunks);
}

// ---------------------------------------------------------------------------
// The windowed push flow
// ---------------------------------------------------------------------------

/** One receive over SELF: all-zero old oids (creates), `report-status` only
 *  (no side-band) so the response body is the plain status render. */
async function pushWindow(
  repoUrl: string,
  token: string,
  updates: { ref: string; oid: string }[],
  pack: Uint8Array,
): Promise<string> {
  const commandSection = updates
    .map((u, i) => {
      const payload = `0000000000000000000000000000000000000000 ${u.oid} ${u.ref}${i === 0 ? "\0report-status" : ""}`;
      return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
    })
    .join("");
  const body = concatArrays([new TextEncoder().encode(`${commandSection}0000`), pack]);
  const response = await SELF.fetch(`${repoUrl}/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
    body,
  });
  expect(response.status).toBe(200);
  return new TextDecoder().decode(await response.arrayBuffer());
}

/** Collect `[receive <repo>]` log lines while `run` executes. */
async function captureReceiveLogs(run: () => Promise<unknown>, repoPath: string): Promise<string[]> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return logs.filter((l) => l.startsWith(`[receive ${repoPath}]`));
}

function metricOf(lines: string[], key: "lookups" | "rangeGets"): string {
  const line = lines.find((l) => l.includes("subrequests:"));
  expect(line, `receive metric line for ${key}`).toBeDefined();
  const match = line!.match(new RegExp(`${key}=(\\S+)`));
  expect(match, `${key} in "${line}"`).not.toBeNull();
  return match![1]!;
}

describe("true-external thin-base receive walk (mirror-wall workload shape)", () => {
  it("resolves 41 external bases through wave-batched stored-chain materialization, and pins the walk's cost shape", async () => {
    const { plaintext: token } = await mintFor(
      (await seedVerifiedUser({ username: "extwalker" })).id,
      "thin-push",
      "write:repository",
    );
    const repoPath = "extwalker/true-ext-thin";
    const repoUrl = `https://test.local/${repoPath}.git`;

    // Window 1: the pre-seeded baseline — 41 disjoint chains with the
    // measured depth distribution; chain tips are the future external bases.
    const chains: Uint8Array[][] = BASE_CHAIN_DEPTHS.map((depth, c) => {
      const chain: Uint8Array[] = [bodyOf(0x5eed00 + c * 131 + 7, 256 + (c % 5) * 16)];
      for (let k = 1; k <= depth; k++) chain.push(derivedBody(chain[k - 1]!, 0x7a11 + c * 977 + k, 40));
      return chain;
    });
    const chainTips = chains.map((chain) => chain[chain.length - 1]!);
    const chainTipOids = await Promise.all(chainTips.map((b) => looseOid("blob", b)));
    // flat blob list (every chain node, in pack-entry order) for the baseline tree
    const flatBodies = chains.flat();
    const flatOids = await Promise.all(flatBodies.map((b) => looseOid("blob", b)));
    const baselineTreeEntries = flatOids.map((oid, i) => ({ name: `blob${String(i).padStart(3, "0")}.bin`, oid }));
    const baselineTree = await treeOidOf(baselineTreeEntries);
    const baselineMessage = "baseline (window 1: measured chain population)\n";
    const baselineCommit = await commitOidOf(baselineTree, null, baselineMessage);

    // per-chain first entry index inside the flat pack-entry list
    const chainStart = chains.map((_, c) => chains.slice(0, c).reduce((n, ch) => n + ch.length, 0));

    const baselinePack = await assemblePack([
      ...chains.flatMap((chain, c) =>
        chain.map((body, k): PackEntrySpec =>
          k === 0
            ? { kind: "full", typeNum: 3, body }
            : { kind: "ofs", baseEntryIndex: chainStart[c]! + k - 1, deltaBody: encodeDelta(chain[k - 1]!, body) },
        ),
      ),
      { kind: "full", typeNum: 2, body: treeBodyOf(baselineTreeEntries) },
      { kind: "full", typeNum: 1, body: commitBodyOf(baselineTree, null, baselineMessage) },
    ]);

    // --- window 1 over the real surface -------------------------------------
    const baselineLogs = await captureReceiveLogs(async () => {
      const first = await pushWindow(repoUrl, token, [{ ref: "refs/heads/main", oid: baselineCommit }], baselinePack);
      expect(first).toContain("unpack ok\n");
      expect(first).toContain("ok refs/heads/main\n");
    }, repoPath);
    // the baseline consults the object database ZERO times
    expect(baselineLogs.some((l) => l.includes("FAILED:"))).toBe(false);
    expect(metricOf(baselineLogs, "lookups")).toBe("0/0");
    expect(metricOf(baselineLogs, "rangeGets")).toBe("0");

    // Window 2: the true-external thin pack — one REF_DELTA per chain tip
    // (zero ofs-delta), every base held only by the object database.
    const derived = chainTips.map((tip, j) => derivedBody(tip, 0x9e3779b9 + j * 7919, 40));
    const derivedOids = await Promise.all(derived.map((b) => looseOid("blob", b)));
    const walkTreeEntries = derivedOids.map((oid, j) => ({ name: `file${String(j).padStart(2, "0")}.bin`, oid }));
    const walkTree = await treeOidOf(walkTreeEntries);
    const walkMessage = "window 2 (thin, true-external)\n";
    const walkCommit = await commitOidOf(walkTree, baselineCommit, walkMessage);

    const walkPack = await assemblePack([
      ...derived.map((target, j): PackEntrySpec => ({
        kind: "ref",
        baseOid: chainTipOids[j]!,
        deltaBody: encodeDelta(chainTips[j]!, target),
      })),
      { kind: "full", typeNum: 2, body: treeBodyOf(walkTreeEntries) },
      { kind: "full", typeNum: 1, body: commitBodyOf(walkTree, baselineCommit, walkMessage) },
    ]);

    const walkLogs = await captureReceiveLogs(async () => {
      const second = await pushWindow(repoUrl, token, [{ ref: "refs/heads/topic", oid: walkCommit }], walkPack);
      expect(second).toContain("unpack ok\n");
      expect(second).toContain("ok refs/heads/topic\n");
      expect(second).not.toContain("ng ");
    }, repoPath);

    // the shape today RESOLVES (behavior truth)...
    const refs = await env.REPO.getByName(repoPath).listRefs();
    expect(refs.refs.find((r) => r.name === "refs/heads/topic")?.target).toBe(walkCommit);

    // ...through the pinned wave-batched cost shape (cost truth):
    // max-depth+1 batched wave RPCs plus the anti-check's one parent batch
    // for Σ(1+depth)+1 oids total — every chain node still consulted exactly
    // once, but through the batched channel; one range read per hop plus
    // each terminal full.
    expect(walkLogs.some((l) => l.includes("FAILED:"))).toBe(false);
    expect(metricOf(walkLogs, "lookups")).toBe(`${EXPECTED_LOOKUP_RPCS}/${EXPECTED_LOOKUP_OIDS}`);
    expect(metricOf(walkLogs, "rangeGets")).toBe(String(EXPECTED_RANGE_GETS));
  });
});
