/**
 * Protected-tag push-time enforcement (inventory batch 8) through the real
 * git-HTTP surface — the gate's `validatePush` callback now walks TAG refs
 * with the IsUserAllowedToControlTag port (gate.ts's tag arm; upstream
 * hook_pre_receive.go preReceiveTag:308-339). Pinned end to end over
 * SELF.fetch + real D1/DO/R2 bindings, the branch-protection-push.test.ts
 * way:
 *   - a pattern-matching tag create is rejected with upstream's exact text
 *     ("Tag %s is protected", :337) while an unmatched sibling tag in the
 *     SAME push lands (per-ref, not per-request);
 *   - the allowlist arms (user id, team membership) let the matching tag
 *     through;
 *   - the delete arm enforces the same check (a protected tag cannot be
 *     deleted by a non-allowlisted pusher);
 *   - the regex arm (`/…/` patterns, protected_tag.go:38-41) enforces
 *     unanchored.
 *
 * The branch arms of the same callback have their own suite
 * (branch-protection-push.test.ts); this file owns only the tag arm.
 */

import { SELF, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { protectedTags, teamMembers, teams } from "../db/schema";
import { buildPack, ZERO_OID } from "../repos/testing/git-pack";
import { RepoService } from "../repos/service";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["protected_tags", "protected_branches", "team_members", "teams", "repo_collaborators", "repo_units", "repo_counters", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

const RECEIVE_CT = "application/x-git-receive-pack-request";

// ---------------------------------------------------------------------------
// Receive builders + report-status parsing (side-band framed, like a real
// git client: caps ride the first command; local copies — the sibling suite's
// helpers are file-private).
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let slugSeq = 0;

interface Fixture {
  repoId: string;
  engineName: string;
  aliceId: number;
  aliceToken: string;
  /** the root commit, pushed to refs/heads/main */
  c1: string;
}

async function seedRepo(): Promise<Fixture> {
  const slug = `tp${++slugSeq}`;
  const alice = await seedVerifiedUser({ username: "Alice" });
  const created = await new RepoService(env.DB).create({
    owner: { id: alice.id, usernameLower: "alice" },
    name: slug,
    isPrivate: false,
  });
  const aliceToken = (await mintFor(alice.id, "w", "write:repository")).plaintext;

  const { oid, pack } = await buildPack();
  const response = await SELF.fetch(`https://example.com/alice/${slug}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(aliceToken), "content-type": RECEIVE_CT },
    body: receiveBody([{ ref: "refs/heads/main", old: ZERO_OID, oid }], pack),
  });
  expect(response.status).toBe(200);
  const report = parseReportStatus(new Uint8Array(await response.arrayBuffer()));
  expect(report.unpack).toBeNull();
  expect(report.lines).toEqual([{ ref: "refs/heads/main", ok: true }]);

  return { repoId: created.id, engineName: `alice/${slug}`, aliceId: alice.id, aliceToken, c1: oid };
}

/** One protected_tags rule (the raw storage shape — JSON TEXT allowlists). */
async function setProtectedTag(repoId: string, namePattern: string, userIds: number[] = [], teamIds: number[] = []): Promise<void> {
  const now = new Date();
  await drizzle(env.DB).insert(protectedTags).values({
    repoId,
    namePattern,
    allowlistUserIds: JSON.stringify(userIds),
    allowlistTeamIds: JSON.stringify(teamIds),
    createdAt: now,
    updatedAt: now,
  });
}

/** The engine DO's current refs (the ground truth behind report-status). */
async function engineRefs(engineName: string): Promise<Map<string, string>> {
  const listed = await env.REPO.getByName(engineName).listRefs();
  return new Map(listed.refs.map((r) => [r.name, r.target]));
}

async function push(url: string, token: string, commands: ReceiveCommand[], pack: Uint8Array | null): Promise<ReturnType<typeof parseReportStatus>> {
  const response = await SELF.fetch(url, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
    body: receiveBody(commands, pack),
  });
  if (response.status !== 200) {
    throw new Error(`push answered ${response.status}: ${await response.text()}`);
  }
  return parseReportStatus(new Uint8Array(await response.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// The enforced tag arms — upstream's exact texts.
// ---------------------------------------------------------------------------

describe("batch-8: push-time protected-tag enforcement through the gate's validatePush callback", () => {
  it("rejects a matching tag create with upstream's text; an unmatched sibling tag in the same push lands", async () => {
    const fx = await seedRepo();
    await setProtectedTag(fx.repoId, "release-*");

    const report = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/tags/release-1", old: ZERO_OID, oid: fx.c1 },
      { ref: "refs/tags/v1.0", old: ZERO_OID, oid: fx.c1 },
    ], null);

    expect(report.unpack).toBeNull();
    expect(report.lines).toEqual([
      { ref: "refs/tags/release-1", ok: false, msg: "Tag release-1 is protected" },
      { ref: "refs/tags/v1.0", ok: true },
    ]);
    const refs = await engineRefs(fx.engineName);
    expect(refs.has("refs/tags/release-1")).toBe(false);
    expect(refs.get("refs/tags/v1.0")).toBe(fx.c1);
  });

  it("the allowlisted user's matching tag lands; a non-allowlisted user's does not", async () => {
    const fx = await seedRepo();
    await setProtectedTag(fx.repoId, "release-*", [fx.aliceId]);

    const allowed = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/tags/release-1", old: ZERO_OID, oid: fx.c1 },
    ], null);
    expect(allowed.lines).toEqual([{ ref: "refs/tags/release-1", ok: true }]);
    expect((await engineRefs(fx.engineName)).get("refs/tags/release-1")).toBe(fx.c1);

    // The same rule with a whitelist that misses the pusher: write access
    // alone is not allowlisted (IsUserAllowedModifyTag is allowlist-only —
    // repo write was already required by the gate's matrix).
    await drizzle(env.DB)
      .update(protectedTags)
      .set({ allowlistUserIds: JSON.stringify([fx.aliceId + 1000]) })
      .where(eq(protectedTags.repoId, fx.repoId));
    const denied = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/tags/release-2", old: ZERO_OID, oid: fx.c1 },
    ], null);
    expect(denied.lines).toEqual([{ ref: "refs/tags/release-2", ok: false, msg: "Tag release-2 is protected" }]);
    expect((await engineRefs(fx.engineName)).has("refs/tags/release-2")).toBe(false);
  });

  it("the team-membership allowlist arm lets a matching tag through", async () => {
    const fx = await seedRepo();
    const team = await drizzle(env.DB)
      .insert(teams)
      .values({ orgId: fx.aliceId, lowerName: "devs", name: "devs", authorize: "write" })
      .returning({ id: teams.id })
      .all();
    const teamId = team[0]!.id;
    await drizzle(env.DB).insert(teamMembers).values({ orgId: fx.aliceId, teamId, userId: fx.aliceId });
    await setProtectedTag(fx.repoId, "release-*", [], [teamId]);

    const report = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/tags/release-1", old: ZERO_OID, oid: fx.c1 },
    ], null);
    expect(report.lines).toEqual([{ ref: "refs/tags/release-1", ok: true }]);
  });

  it("deleting a protected tag without the allowlist refuses with upstream's text; the delete arm runs on every kind", async () => {
    const fx = await seedRepo();
    // the tag exists first (alice allowlisted), then the allowlist empties.
    await setProtectedTag(fx.repoId, "release-*", [fx.aliceId]);
    const made = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/tags/release-1", old: ZERO_OID, oid: fx.c1 },
    ], null);
    expect(made.lines).toEqual([{ ref: "refs/tags/release-1", ok: true }]);

    await drizzle(env.DB).update(protectedTags).set({ allowlistUserIds: "[]" }).where(eq(protectedTags.repoId, fx.repoId));
    const denied = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/tags/release-1", old: fx.c1, oid: ZERO_OID },
    ], null);
    expect(denied.lines).toEqual([{ ref: "refs/tags/release-1", ok: false, msg: "Tag release-1 is protected" }]);
    expect((await engineRefs(fx.engineName)).get("refs/tags/release-1")).toBe(fx.c1);

    // The allowlisted pusher deletes it.
    await drizzle(env.DB).update(protectedTags).set({ allowlistUserIds: JSON.stringify([fx.aliceId]) }).where(eq(protectedTags.repoId, fx.repoId));
    const allowed = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/tags/release-1", old: fx.c1, oid: ZERO_OID },
    ], null);
    expect(allowed.lines).toEqual([{ ref: "refs/tags/release-1", ok: true }]);
    expect((await engineRefs(fx.engineName)).has("refs/tags/release-1")).toBe(false);
  });

  it("the regex arm (/…/ patterns) enforces unanchored matches at push time", async () => {
    const fx = await seedRepo();
    await setProtectedTag(fx.repoId, "/-rc\\d+/");

    const report = await push(`https://example.com/${fx.engineName}.git/git-receive-pack`, fx.aliceToken, [
      { ref: "refs/tags/v2-rc1", old: ZERO_OID, oid: fx.c1 },
      { ref: "refs/tags/v2", old: ZERO_OID, oid: fx.c1 },
    ], null);
    expect(report.lines).toEqual([
      { ref: "refs/tags/v2-rc1", ok: false, msg: "Tag v2-rc1 is protected" },
      { ref: "refs/tags/v2", ok: true },
    ]);
  });
});
