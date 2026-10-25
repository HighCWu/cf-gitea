/**
 * SPEC-0013 M2 — push-time per-ref protection through the real git-HTTP
 * surface: the gate supplies the engine's `validatePush` call option on
 * every D1-resolved receive forward (gate.ts protectedBranchValidator), the
 * engine classifies each command (create/delete/fast-forward/force-push)
 * and renders the verdicts as report-status ng lines before finalize.
 *
 * Pinned here, end to end over SELF.fetch + real D1/DO/R2 bindings:
 *   - every enforced arm rejects with upstream's exact text
 *     (hook_pre_receive.go preReceiveBranch :123-313, the §2.3(a) wording the
 *     SPEC pins): direct-push, force (both variants), deletion, and the
 *     absolute default-branch-deletion refusal;
 *   - the whitelisted pusher passes (whitelist_user_ids arm of CanUserPush);
 *   - an unprotected branch in the SAME push is untouched (per-ref, not
 *     per-request: the rejected ref renders ng and its sibling lands);
 *   - the classifications are real ancestry: the force cases push genuinely
 *     divergent commits (not flag-shaped requests);
 *   - the enforcement boundary: receives composed the way the mirror sync
 *     and the import pipeline build them (createDurableGit WITHOUT the
 *     callback, engine.fetch with no call options) enforce NOTHING — the
 *     same posture as the pusher-identity seam.
 *
 * The engine-side hook contract (classification correctness, verdict
 * normalization, fail-closed arms, all-rejected lease convergence) has its
 * own tsx check: packages/git-engine/e2e/check-validate-push.mjs.
 */

import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDurableGit } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { emptyRuleConfig, serializeRuleConfig, type ProtectedBranchConfig } from "../services/branch-protection";
import { protectedBranches } from "../db/schema";
import { RepoService } from "../repos/service";
import { ZERO_OID } from "../repos/testing/git-pack";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["protected_branches", "repo_collaborators", "repo_units", "repo_counters", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

const RECEIVE_CT = "application/x-git-receive-pack-request";

// ---------------------------------------------------------------------------
// Pack builders — like repos/testing/git-pack.ts but parameterized: distinct
// content per commit (real distinct oids) and explicit parents, so the
// fast-forward and force-push cases carry REAL ancestry shapes.
// ---------------------------------------------------------------------------

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

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function rawOid(oidHex: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

/** One self-contained commit (blob + tree + commit) and its pack. The blob
 *  content embeds the message, so every call yields a DISTINCT oid; parents
 *  must already exist server-side (or in an earlier push of the same test). */
async function buildCommitPack(message: string, parents: string[]): Promise<{ oid: string; pack: Uint8Array }> {
  const blob = new TextEncoder().encode(`content: ${message}\n`);
  const blobSha = await sha1(concatArrays([new TextEncoder().encode(`blob ${blob.length}\0`), blob]));

  const treeBody = concatArrays([new TextEncoder().encode(`100644 file.txt\0`), rawOid(blobSha)]);
  const treeSha = await sha1(concatArrays([new TextEncoder().encode(`tree ${treeBody.length}\0`), treeBody]));

  const time = 1700000000;
  const parentLines = parents.map((p) => `parent ${p}\n`).join("");
  const commitBody = new TextEncoder().encode(
    `tree ${treeSha}\n` +
      parentLines +
      `author Test User <test@example.com> ${time} +0000\n` +
      `committer Test User <test@example.com> ${time} +0000\n\n` +
      `${message}\n`,
  );
  const oid = await sha1(concatArrays([new TextEncoder().encode(`commit ${commitBody.length}\0`), commitBody]));

  const entries: { type: number; body: Uint8Array }[] = [
    { type: 3, body: blob }, // OBJ_BLOB
    { type: 2, body: treeBody }, // OBJ_TREE
    { type: 1, body: commitBody }, // OBJ_COMMIT
  ];
  const chunks: Uint8Array[] = [new TextEncoder().encode("PACK"), be32(2), be32(entries.length)];
  for (const entry of entries) {
    chunks.push(objectHeader(entry.type, entry.body.length));
    chunks.push(await zlibDeflate(entry.body));
  }
  chunks.push(await sha1Bytes(concatArrays(chunks)));
  return { oid, pack: concatArrays(chunks) };
}

// ---------------------------------------------------------------------------
// Receive builders + report-status parsing (side-band framed, like a real
// git client: caps ride the first command).
// ---------------------------------------------------------------------------

interface ReceiveCommand {
  ref: string;
  old: string;
  oid: string;
}

function receiveBody(commands: ReceiveCommand[], pack: Uint8Array | null): Uint8Array {
  let section = "";
  commands.forEach((c, i) => {
    const caps = i === 0 ? "\0report-status side-band-64k" : "";
    const line = `${c.old} ${c.oid} ${c.ref}${caps}`;
    section += `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
  });
  section += "0000";
  const head = new TextEncoder().encode(section);
  return pack === null ? head : concatArrays([head, pack]);
}

interface ReportLine {
  ref: string;
  ok: boolean;
  msg?: string;
}

/** Strip one layer of pkt-line framing (band-1 minus its band byte, progress
 *  dropped, plain payloads whole) — one level per call. */
function unframe(bytes: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  let p = 0;
  while (p + 4 <= bytes.length) {
    const len = parseInt(String.fromCharCode(...bytes.subarray(p, p + 4)), 16);
    if (len === 0) {
      p += 4;
      continue;
    }
    if (len < 4) break;
    const payload = bytes.subarray(p + 4, p + len);
    if (payload[0] === 1 || payload[0] === 3) out.push(payload.subarray(1));
    else if (payload[0] === 2) {
      // progress — ignored
    } else out.push(payload);
    p += len;
  }
  return concatArrays(out);
}

/** Unframe the side-band layer, then (the report rode inside band-1, still
 *  pkt-line framed) the report framing itself, then parse the lines. */
function parseReportStatus(bytes: Uint8Array): { unpack: string | null; lines: ReportLine[] } {
  let inner = unframe(bytes);
  const head = String.fromCharCode(...inner.subarray(0, 4));
  if (/^[0-9a-f]{4}$/.test(head)) {
    const len = parseInt(head, 16);
    if (len >= 4 && len <= inner.length + 4) inner = unframe(inner);
  }
  const lines = new TextDecoder()
    .decode(inner)
    .split("\n")
    .filter((l) => l.length > 0);
  const unpack = lines[0] === "unpack ok" ? null : (lines[0] ?? "").slice("unpack ".length) || null;
  const out: ReportLine[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("ok ")) {
      out.push({ ref: line.slice(3), ok: true });
    } else if (line.startsWith("ng ")) {
      const rest = line.slice(3);
      const sp = rest.indexOf(" ");
      out.push(sp === -1 ? { ref: rest, ok: false } : { ref: rest.slice(0, sp), ok: false, msg: rest.slice(sp + 1) });
    }
  }
  return { unpack, lines: out };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let slugSeq = 0;

interface Fixture {
  repoId: string;
  storageKey: string;
  engineName: string;
  aliceId: number;
  aliceToken: string;
  /** the first commit, pushed to refs/heads/main (create classification) */
  c1: string;
}

/** alice's repo with one commit on main. Alice is the repo's writer (the
 *  git matrix's row-8 grant is owner/org-team only — repo_collaborators are
 *  an API-level surface), so the whitelist cases below discriminate on the
 *  RULE's whitelist, not on repo-level access. */
async function seedRepo(): Promise<Fixture> {
  const slug = `bp${++slugSeq}`;
  const alice = await seedVerifiedUser({ username: "Alice" });
  const created = await new RepoService(env.DB).create({
    owner: { id: alice.id, usernameLower: "alice" },
    name: slug,
    isPrivate: false,
  });
  const aliceToken = (await mintFor(alice.id, "w", "write:repository")).plaintext;

  const { oid, pack } = await buildCommitPack("c1 root commit", []);
  const response = await SELF.fetch(`https://example.com/alice/${slug}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(aliceToken), "content-type": RECEIVE_CT },
    body: receiveBody([{ ref: "refs/heads/main", old: ZERO_OID, oid }], pack),
  });
  expect(response.status).toBe(200);
  const report = parseReportStatus(new Uint8Array(await response.arrayBuffer()));
  expect(report.unpack).toBeNull();
  expect(report.lines).toEqual([{ ref: "refs/heads/main", ok: true }]);

  return { repoId: created.id, storageKey: created.storageKey, engineName: `alice/${slug}`, aliceId: alice.id, aliceToken, c1: oid };
}

async function setRule(repoId: string, ruleName: string, config: Partial<ProtectedBranchConfig>): Promise<void> {
  await drizzle(env.DB).insert(protectedBranches).values({
    repoId,
    ruleName,
    priority: 0,
    rules: serializeRuleConfig({ ...emptyRuleConfig(), ...config }),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** The engine DO's current refs (the ground truth behind report-status). */
async function engineRefs(engineName: string): Promise<Map<string, string>> {
  const listed = await env.REPO.getByName(engineName).listRefs();
  return new Map(listed.refs.map((r) => [r.name, r.target]));
}

async function push(
  url: string,
  token: string,
  commands: ReceiveCommand[],
  pack: Uint8Array | null,
): Promise<{ report: ReturnType<typeof parseReportStatus>; status: number }> {
  const response = await SELF.fetch(url, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
    body: receiveBody(commands, pack),
  });
  // every policy outcome this suite exercises rides report-status with a
  // 200 — a matrix refusal (401/403/404) or engine 500 must fail loudly
  // here, never parse as an empty report
  if (response.status !== 200) {
    throw new Error(`push answered ${response.status}: ${await response.text()}`);
  }
  return { report: parseReportStatus(new Uint8Array(await response.arrayBuffer())), status: response.status };
}

// ---------------------------------------------------------------------------
// The enforced arms — upstream's exact texts (SPEC-0013 §2.3(a))
// ---------------------------------------------------------------------------

describe("SPEC-0013 M2: push-time per-ref protection through the gate's validatePush callback", () => {
  it("rejects a writer's direct push to a protected branch with upstream's text (can_push unset)", async () => {
    const fx = await seedRepo();
    await setRule(fx.repoId, "main", {}); // can_push false: the upstream default
    const { oid, pack } = await buildCommitPack("c2 child of c1", [fx.c1]);

    const { report } = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/heads/main", old: fx.c1, oid },
    ], pack);

    expect(report.unpack).toBeNull();
    expect(report.lines).toEqual([
      { ref: "refs/heads/main", ok: false, msg: "Not allowed to push to protected branch main" },
    ]);
    // the ref never moved
    expect((await engineRefs(fx.engineName)).get("refs/heads/main")).toBe(fx.c1);
  });

  it("the whitelisted user pushes; a writer outside the whitelist does not", async () => {
    const fx = await seedRepo();
    await setRule(fx.repoId, "main", { canPush: true, enableWhitelist: true, whitelistUserIds: [fx.aliceId] });
    const { oid: c2, pack } = await buildCommitPack("c2 by whitelisted alice", [fx.c1]);

    const allowed = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/heads/main", old: fx.c1, oid: c2 },
    ], pack);
    expect(allowed.report.lines).toEqual([{ ref: "refs/heads/main", ok: true }]);
    expect((await engineRefs(fx.engineName)).get("refs/heads/main")).toBe(c2);

    // The same rule with a whitelist that misses the writer: write access
    // alone is not whitelisted (CanUserPush's explicit-user arm only).
    await drizzle(env.DB)
      .update(protectedBranches)
      .set({ rules: serializeRuleConfig({ ...emptyRuleConfig(), canPush: true, enableWhitelist: true, whitelistUserIds: [fx.aliceId + 1000] }) })
      .where(eq(protectedBranches.repoId, fx.repoId));
    const { oid: c3, pack: pack3 } = await buildCommitPack("c3 by non-whitelisted alice", [c2]);
    const denied = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/heads/main", old: c2, oid: c3 },
    ], pack3);
    expect(denied.report.lines).toEqual([
      { ref: "refs/heads/main", ok: false, msg: "Not allowed to push to protected branch main" },
    ]);
    expect((await engineRefs(fx.engineName)).get("refs/heads/main")).toBe(c2);
  });

  it("an unprotected branch in the same push is untouched: per-ref rejection, sibling lands", async () => {
    const fx = await seedRepo();
    await setRule(fx.repoId, "main", { canPush: false });
    const { oid: c2, pack } = await buildCommitPack("c2 for the protected ref", [fx.c1]);

    const { report } = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/heads/main", old: fx.c1, oid: c2 }, // rejected by the rule
      { ref: "refs/heads/feature", old: ZERO_OID, oid: fx.c1 }, // no rule: create at the existing tip (no pack needed for it)
    ], pack);

    expect(report.unpack).toBeNull();
    // results stay in command order
    expect(report.lines).toEqual([
      { ref: "refs/heads/main", ok: false, msg: "Not allowed to push to protected branch main" },
      { ref: "refs/heads/feature", ok: true },
    ]);
    const refs = await engineRefs(fx.engineName);
    expect(refs.get("refs/heads/main")).toBe(fx.c1);
    expect(refs.get("refs/heads/feature")).toBe(fx.c1);
  });

  it("force pushes: refuse-outright text when can_force_push is unset, refusal variant when the predicate fails, allow when it holds", async () => {
    const fx = await seedRepo();
    // the rewrite target exists server-side first (staged through the
    // unprotected scratch branch with its own pack), so every force command
    // below is judged on REAL ancestry, not on a missing object
    const { oid: divergent, pack: divergentPack } = await buildCommitPack("divergent root (a rewrite)", []);
    await setRule(fx.repoId, "main", { canPush: true }); // scratch is not matched by the rule
    const staged = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/heads/scratch", old: ZERO_OID, oid: divergent },
    ], divergentPack);
    expect(staged.report.lines).toEqual([{ ref: "refs/heads/scratch", ok: true }]);
    const forceCommand = { ref: "refs/heads/main", old: fx.c1, oid: divergent };

    // (a) can_force_push unset → the outright refusal, before any predicate.
    const a = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [forceCommand], null);
    expect(a.report.lines).toEqual([{ ref: "refs/heads/main", ok: false, msg: "Branch main is protected from force push" }]);

    // (b) can_force_push set but the push predicate fails → the force variant.
    await drizzle(env.DB).update(protectedBranches).set({ rules: serializeRuleConfig({ ...emptyRuleConfig(), canPush: false, canForcePush: true }) }).where(eq(protectedBranches.repoId, fx.repoId));
    const b = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [forceCommand], null);
    expect(b.report.lines).toEqual([{ ref: "refs/heads/main", ok: false, msg: "Not allowed to force-push to protected branch main" }]);

    // (c) can_force_push set and the predicate holds → the rewrite lands
    // (a genuinely non-fast-forward ancestry).
    await drizzle(env.DB).update(protectedBranches).set({ rules: serializeRuleConfig({ ...emptyRuleConfig(), canPush: true, canForcePush: true }) }).where(eq(protectedBranches.repoId, fx.repoId));
    const c = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [forceCommand], null);
    expect(c.report.lines).toEqual([{ ref: "refs/heads/main", ok: true }]);
    expect((await engineRefs(fx.engineName)).get("refs/heads/main")).toBe(divergent);
  });

  it("deleting a protected branch without can_delete refuses with upstream's text; with it, lands; the default branch refuses absolutely", async () => {
    const fx = await seedRepo();
    // feature exists (create at the existing tip), then a rule arms deletion.
    const made = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/heads/feature", old: ZERO_OID, oid: fx.c1 },
    ], null);
    expect(made.report.lines).toEqual([{ ref: "refs/heads/feature", ok: true }]);

    await setRule(fx.repoId, "feature", { canPush: true }); // can_delete unset
    const denied = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/heads/feature", old: fx.c1, oid: ZERO_OID },
    ], null);
    expect(denied.report.lines).toEqual([{ ref: "refs/heads/feature", ok: false, msg: "Branch feature is protected from deletion" }]);
    expect((await engineRefs(fx.engineName)).has("refs/heads/feature")).toBe(true);

    await drizzle(env.DB).update(protectedBranches).set({ rules: serializeRuleConfig({ ...emptyRuleConfig(), canPush: true, canDelete: true }) }).where(eq(protectedBranches.repoId, fx.repoId));
    const allowed = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/heads/feature", old: fx.c1, oid: ZERO_OID },
    ], null);
    expect(allowed.report.lines).toEqual([{ ref: "refs/heads/feature", ok: true }]);
    expect((await engineRefs(fx.engineName)).has("refs/heads/feature")).toBe(false);

    // The default branch refuses deletion ABSOLUTELY (upstream :140-143 —
    // before the rule lookup, no rule required).
    const defected = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/heads/main", old: fx.c1, oid: ZERO_OID },
    ], null);
    expect(defected.report.lines).toEqual([
      { ref: "refs/heads/main", ok: false, msg: "Branch main is the default branch and cannot be deleted" },
    ]);
    expect((await engineRefs(fx.engineName)).get("refs/heads/main")).toBe(fx.c1);
  });

  it("classification is per-ref and glob-aware: a create on a glob-protected branch is rejected by the create arm", async () => {
    const fx = await seedRepo();
    await setRule(fx.repoId, "release/**", { canPush: false }); // glob (crosses '/')

    const { report } = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/heads/release/1", old: ZERO_OID, oid: fx.c1 },
    ], null);
    expect(report.lines).toEqual([
      { ref: "refs/heads/release/1", ok: false, msg: "Not allowed to push to protected branch release/1" },
    ]);
    expect((await engineRefs(fx.engineName)).has("refs/heads/release/1")).toBe(false);
  });

  it("the enforcement boundary: a receive composed like the mirror sync/import pipeline (no callback) enforces nothing", async () => {
    const fx = await seedRepo();
    await setRule(fx.repoId, "main", {}); // would refuse every push through the gate
    // stage the rewrite target through the gate first (scratch is not
    // matched by the main rule; the pack carries the commit)
    const { oid: divergent, pack: divergentPack } = await buildCommitPack("mirror-written divergent root", []);
    const scratch = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/heads/scratch", old: ZERO_OID, oid: divergent },
    ], divergentPack);
    expect(scratch.report.lines).toEqual([{ ref: "refs/heads/scratch", ok: true }]);

    // services/mirror/sync.ts's construction: its own engine handler without
    // the callback, engine.fetch with NO call options, x-storage-key set,
    // gate-cleared mark, plain report-status (no side-band).
    const mirrorEngine = createDurableGit<Env>({ authorize: () => true, ui: false, namespaces: true });
    const line = `${fx.c1} ${divergent} refs/heads/main\0report-status`;
    const section = `${(line.length + 4).toString(16).padStart(4, "0")}${line}0000`;
    const body = new TextEncoder().encode(section);
    const mirrored = await mirrorEngine.fetch(
      new Request(`https://mirror.internal/${fx.engineName}.git/git-receive-pack`, {
        method: "POST",
        headers: {
          "content-type": RECEIVE_CT,
          "x-storage-key": fx.storageKey,
          "content-length": String(body.length),
        },
        body,
      }),
      env,
      {} as ExecutionContext, // sync.ts's NOOP_CTX shape (webhooks-push.test.ts)
    );
    expect(mirrored.status).toBe(200);
    // plain (unframed) report-status: the force rewrite APPLIED — no rules
    // were ever consulted, exactly the documented boundary posture.
    const text = new TextDecoder().decode(new Uint8Array(await mirrored.arrayBuffer()));
    expect(text).toContain("unpack ok");
    expect(text).toContain(`ok refs/heads/main`);
    expect((await engineRefs(fx.engineName)).get("refs/heads/main")).toBe(divergent);
  });
});
