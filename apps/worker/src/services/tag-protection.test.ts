/**
 * Protected-tag service (inventory batch 8) over real D1 — the
 * EnsureCompiledPattern port (the regex arm's UNANCHORED MatchString vs the
 * glob arm's anchored no-separator walk, protected_tag.go:36-53), the
 * compile-error propagation (the branch family's quoted-literal fallback
 * deliberately absent), the IsUserAllowedModifyTag arms (user id / team
 * membership / empty allowlists) and IsUserAllowedToControlTag's
 * break-on-allow loop (a later allowing rule rescues an earlier denying one,
 * protected_tag.go:126-149), plus the row loaders.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { protectedTags, repositories, teamMembers, teams } from "../db/schema";
import { IssuesService } from "../issues/service";
import {
  compileTagPattern,
  findProtectedTagById,
  findProtectedTagByNamePattern,
  isTagControlAllowed,
  isUserAllowedModifyTag,
  listProtectedTags,
  parseAllowlistIds,
  serializeAllowlistIds,
} from "./tag-protection";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["protected_tags", "team_members", "teams", "repo_counters", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const [id, username, type] of [
    [1, "doer", "user"],
    [2, "bob", "user"],
    [3, "alice", "user"],
    [20, "acme", "org"],
  ] as const) {
    await env.DB.prepare("INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (?, ?, ?, 0, 'active', ?, 0)")
      .bind(id, username, username, type)
      .run();
  }
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

let repoSeq = 8800;

async function seedRepo(): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: "alice",
    slug: `tagp${id}`,
    visibility: "public",
    isArchived: false,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await service().ensureRepoCounters(id);
  return id;
}

async function seedTeam(name = "devs", memberIds: number[] = []): Promise<number> {
  const inserted = await db()
    .insert(teams)
    .values({ orgId: 20, lowerName: name, name, authorize: "write" })
    .returning({ id: teams.id })
    .all();
  const teamId = inserted[0]!.id;
  for (const userId of memberIds) {
    await db().insert(teamMembers).values({ orgId: 20, teamId, userId });
  }
  return teamId;
}

async function seedTag(options: {
  repoId: string;
  namePattern: string;
  userIds?: number[];
  teamIds?: number[];
}): Promise<number> {
  const now = new Date();
  const inserted = await db()
    .insert(protectedTags)
    .values({
      repoId: options.repoId,
      namePattern: options.namePattern,
      allowlistUserIds: serializeAllowlistIds(options.userIds ?? []),
      allowlistTeamIds: serializeAllowlistIds(options.teamIds ?? []),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: protectedTags.id })
    .all();
  return inserted[0]!.id;
}

// ---------------------------------------------------------------------------
// compileTagPattern — the EnsureCompiledPattern arms (protected_tag.go:36-45).
// ---------------------------------------------------------------------------

describe("compileTagPattern", () => {
  it("glob arm: anchored, `*` matches any character INCLUDING `/` (no separators)", () => {
    const glob = compileTagPattern("v*"); // ^v.*$ — `.*` may be empty
    expect(glob.test("v1.0")).toBe(true);
    expect(glob.test("v")).toBe(true);
    expect(glob.test("xv1")).toBe(false); // anchored
    expect(glob.test("w1")).toBe(false);
    expect(glob.test("v1/2")).toBe(true); // tag names may carry slashes; no separator class
  });

  it("glob arm: `?` is one arbitrary char, classes and alternation compile", () => {
    expect(compileTagPattern("v?").test("v1")).toBe(true);
    expect(compileTagPattern("v?").test("v10")).toBe(false);
    expect(compileTagPattern("v[0-9]").test("v7")).toBe(true);
    expect(compileTagPattern("v[0-9]").test("vx")).toBe(false);
    expect(compileTagPattern("v{1,2}").test("v2")).toBe(true);
    expect(compileTagPattern("v{1,2}").test("v3")).toBe(false);
  });

  it("regex arm: wrapped in slashes, UNANCHORED MatchString (protected_tag.go:51-53)", () => {
    const regex = compileTagPattern("/-stable/");
    expect(regex.test("v1-stable")).toBe(true); // substring match — no anchors
    expect(regex.test("v1-beta")).toBe(false);
    expect(compileTagPattern("/^v\\d+$/").test("v12")).toBe(true);
    expect(compileTagPattern("/^v\\d+$/").test("av12")).toBe(false);
  });

  it("compile errors PROPAGATE — no quoted-literal fallback (the branch family's :108-111 arm is absent here)", () => {
    expect(() => compileTagPattern("[unclosed")).toThrow();
    expect(() => compileTagPattern("[]")).toThrow(); // Go RE2 rejects the empty class
    expect(() => compileTagPattern("dangling\\")).toThrow();
    expect(() => compileTagPattern("/([unclosed/")).toThrow(); // the regex arm too
  });
});

// ---------------------------------------------------------------------------
// The allowlist JSON columns.
// ---------------------------------------------------------------------------

describe("allowlist serialization", () => {
  it("round-trips ids and tolerates corrupt cells (Go unmarshal zero-fill)", () => {
    expect(parseAllowlistIds(serializeAllowlistIds([2, 5, 9]))).toEqual([2, 5, 9]);
    expect(parseAllowlistIds("not json")).toEqual([]);
    expect(parseAllowlistIds('{"a":1}')).toEqual([]);
    expect(parseAllowlistIds('["str", 3, null]')).toEqual([3]);
  });
});

// ---------------------------------------------------------------------------
// IsUserAllowedModifyTag + IsUserAllowedToControlTag over real rows.
// ---------------------------------------------------------------------------

describe("isUserAllowedModifyTag", () => {
  it("user-id hit, team-membership hit, and the empty-allowlist denial", async () => {
    const repoId = await seedRepo();
    const teamId = await seedTeam("devs", [2]);
    const byUser = await db().select().from(protectedTags).where(eq(protectedTags.id, await seedTag({ repoId, namePattern: "*", userIds: [1] }))).all();
    expect(await isUserAllowedModifyTag(env.DB, byUser[0]!, 1)).toBe(true);
    expect(await isUserAllowedModifyTag(env.DB, byUser[0]!, 2)).toBe(false);

    const byTeam = await db().select().from(protectedTags).where(eq(protectedTags.id, await seedTag({ repoId, namePattern: "*", teamIds: [teamId] }))).all();
    expect(await isUserAllowedModifyTag(env.DB, byTeam[0]!, 2)).toBe(true); // bob is in devs
    expect(await isUserAllowedModifyTag(env.DB, byTeam[0]!, 1)).toBe(false);

    const empty = await db().select().from(protectedTags).where(eq(protectedTags.id, await seedTag({ repoId, namePattern: "*" }))).all();
    expect(await isUserAllowedModifyTag(env.DB, empty[0]!, 1)).toBe(false);
  });
});

describe("isTagControlAllowed (IsUserAllowedToControlTag, protected_tag.go:126-149)", () => {
  it("no matching rule → allowed; matching rule with empty allowlists → denied", async () => {
    const repoId = await seedRepo();
    await seedTag({ repoId, namePattern: "release-*" });
    const rules = await listProtectedTags(env.DB, repoId);
    expect(await isTagControlAllowed(env.DB, rules, "v1.0", 1)).toBe(true);
    expect(await isTagControlAllowed(env.DB, rules, "release-1", 1)).toBe(false);
  });

  it("the break-on-allow loop: a later allowing rule rescues an earlier denying one", async () => {
    const repoId = await seedRepo();
    await seedTag({ repoId, namePattern: "release-*" }); // denies everyone
    await seedTag({ repoId, namePattern: "release-1*", userIds: [2] }); // allows bob
    const rules = await listProtectedTags(env.DB, repoId);
    expect(await isTagControlAllowed(env.DB, rules, "release-11", 2)).toBe(true); // rescued
    expect(await isTagControlAllowed(env.DB, rules, "release-11", 1)).toBe(false); // still denied
    expect(await isTagControlAllowed(env.DB, rules, "release-20", 2)).toBe(false); // only the denying rule matches
  });

  it("an invalid stored pattern THROWS (upstream pre-receive fails the push — fail closed)", async () => {
    const repoId = await seedRepo();
    await seedTag({ repoId, namePattern: "[unclosed" });
    const rules = await listProtectedTags(env.DB, repoId);
    // The error fires even when the name would not have matched: the compile
    // happens per rule inside the loop (EnsureCompiledPattern precedes the
    // match upstream too, protected_tag.go:134-136).
    await expect(isTagControlAllowed(env.DB, rules, "anything", 1)).rejects.toThrow("invalid protected tag pattern");
  });

  it("the regex arm enforces unanchored matches through the decision loop", async () => {
    const repoId = await seedRepo();
    await seedTag({ repoId, namePattern: "/-rc\\d+$/" });
    const rules = await listProtectedTags(env.DB, repoId);
    expect(await isTagControlAllowed(env.DB, rules, "v2-rc1", 1)).toBe(false);
    expect(await isTagControlAllowed(env.DB, rules, "v2", 1)).toBe(true);
  });
});

describe("row loaders", () => {
  it("listProtectedTags is repo-scoped and id-ordered; find* look up by id and exact pattern", async () => {
    const repoId = await seedRepo();
    const other = await seedRepo();
    const first = await seedTag({ repoId, namePattern: "a-*" });
    const second = await seedTag({ repoId, namePattern: "b-*" });
    await seedTag({ repoId: other, namePattern: "a-*" });

    const rows = await listProtectedTags(env.DB, repoId);
    expect(rows.map((row) => row.id)).toEqual([first, second]);

    expect((await findProtectedTagById(env.DB, first))?.namePattern).toBe("a-*");
    expect(await findProtectedTagById(env.DB, 999999)).toBeNull();
    expect((await findProtectedTagByNamePattern(env.DB, repoId, "b-*"))?.id).toBe(second);
    expect(await findProtectedTagByNamePattern(env.DB, repoId, "zzz-*")).toBeNull(); // the other repo's a-* never leaks
    expect(await findProtectedTagByNamePattern(env.DB, other, "b-*")).toBeNull();
  });
});
