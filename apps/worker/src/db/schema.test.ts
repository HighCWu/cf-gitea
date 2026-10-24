/**
 * Schema/migration parity (the 0005 consolidation of the service-side
 * DDL-in-waiting): a D1 freshly applied the generated migrations must accept
 * exactly the operations the superseded raw-DDL path
 * (`LFS_OBJECTS_DDL_STATEMENTS`, `ORG_DDL_STATEMENTS`) allowed, and the
 * Drizzle table objects must drive those same statements.
 *
 * Structure is asserted against `sqlite_master`/`PRAGMA table_info`
 * (composite PK, index names, column types/nullability/defaults — matching
 * the superseded constants verbatim), behavior through the two write paths
 * (raw prepared statements as the old services issued them, and Drizzle
 * queries over the schema tables): upserts, guarded updates, unique-violation
 * arbitration, declared defaults, and the ON DELETE CASCADE memberships and
 * redirects rely on.
 */

import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { lfsObjects, orgMembers, userRedirects, users } from "./schema";

beforeAll(applyAuthD1Migrations);

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const tableColumns = async (table: string): Promise<ColumnInfo[]> =>
  (await env.DB.prepare(`PRAGMA table_info(${table})`).all<ColumnInfo>()).results;

const indexNames = async (table: string): Promise<string[]> =>
  (
    await env.DB
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`)
      .bind(table)
      .all<{ name: string }>()
  ).results.map((row) => row.name);

/** Insert two plain user rows, return their ids (raw path — no auth service). */
async function seedUsers(...names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const name of names) {
    const result = await env.DB
      .prepare("INSERT INTO users (username, username_lower, created_at) VALUES (?, ?, unixepoch())")
      .bind(name, name.toLowerCase())
      .run();
    ids.push(Number(result.meta.last_row_id));
  }
  return ids;
}

describe("lfs_objects parity (superseded LFS_OBJECTS_DDL_STATEMENTS)", () => {
  it("has the raw-DDL structure: composite PK, column types, sweep index", async () => {
    const columns = await tableColumns("lfs_objects");
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["repo_id", "INTEGER", 1, 1],
      ["oid", "TEXT", 1, 2],
      ["size", "INTEGER", 1, 0],
      ["state", "TEXT", 1, 0],
      ["created_at", "INTEGER", 1, 0],
      ["updated_at", "INTEGER", 1, 0],
    ]);
    expect(await indexNames("lfs_objects")).toContain("idx_lfs_objects_repo_state_updated");
  });

  it("accepts the same writes via raw D1 and the drizzle schema", async () => {
    const db = drizzle(env.DB);

    // Raw path (the old ensureUploading statement): insert + conflict update.
    await env.DB
      .prepare(
        `INSERT INTO lfs_objects (repo_id, oid, size, state, created_at, updated_at)
         VALUES (?, ?, ?, 'uploading', ?, ?)
         ON CONFLICT (repo_id, oid) DO UPDATE
         SET size = excluded.size, state = 'uploading', updated_at = excluded.updated_at`,
      )
      .bind(1, "a".repeat(32), 10, 100, 100)
      .run();
    // Drizzle path: the same upsert through the schema table.
    await db
      .insert(lfsObjects)
      .values({ repoId: 1, oid: "a".repeat(32), size: 20, state: "uploading", createdAt: new Date(200_000), updatedAt: new Date(200_000) })
      .onConflictDoUpdate({
        target: [lfsObjects.repoId, lfsObjects.oid],
        set: { size: 20, state: "uploading", updatedAt: new Date(200_000) },
      });
    const row = await env.DB
      .prepare("SELECT repo_id, oid, size, state, created_at, updated_at FROM lfs_objects")
      .first<{ repo_id: number; oid: string; size: number; state: string; created_at: number; updated_at: number }>();
    expect(row).toEqual({ repo_id: 1, oid: "a".repeat(32), size: 20, state: "uploading", created_at: 100, updated_at: 200 });

    // PK is a real constraint on the migrated table: a bare duplicate fails.
    await expect(
      env.DB.prepare("INSERT INTO lfs_objects (repo_id, oid, size, state, created_at, updated_at) VALUES (1, ?, 5, 'verified', 1, 1)")
        .bind("a".repeat(32))
        .run(),
    ).rejects.toThrow();

    // Guarded flip/delete report changes through drizzle (verify/GC paths).
    const flipped = await db
      .update(lfsObjects)
      .set({ state: "verified", updatedAt: new Date(300_000) })
      .where(and(eq(lfsObjects.repoId, 1), eq(lfsObjects.oid, "a".repeat(32))))
      .returning({ oid: lfsObjects.oid });
    expect(flipped.map((r) => r.oid)).toEqual(["a".repeat(32)]);
    const deleted = await db
      .delete(lfsObjects)
      .where(and(eq(lfsObjects.repoId, 1), eq(lfsObjects.oid, "a".repeat(32))))
      .returning({ oid: lfsObjects.oid });
    expect(deleted).toHaveLength(1);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM lfs_objects").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});

describe("users org columns parity (superseded ORG_DDL_STATEMENTS ALTERs)", () => {
  it("defaults the new columns exactly like the raw ALTERs did", async () => {
    const [id] = await seedUsers("ParityUser");

    const row = await env.DB
      .prepare(
        `SELECT type, full_name, description, website, location, avatar_email,
                use_custom_avatar, num_members, repo_admin_change_team_access
         FROM users WHERE id = ?`,
      )
      .bind(id)
      .first<Record<string, unknown>>();
    expect(row).toEqual({
      type: "user",
      full_name: null,
      description: null,
      website: null,
      location: null,
      avatar_email: null,
      use_custom_avatar: 0,
      num_members: 0,
      repo_admin_change_team_access: 0,
    });
    expect(await indexNames("users")).toContain("users_type_idx");
  });

  it("accepts org-shaped rows through the drizzle schema", async () => {
    const db = drizzle(env.DB);
    await db.insert(users).values({
      username: "ParityOrg",
      usernameLower: "parityorg",
      type: "org",
      numMembers: 1,
      createdAt: new Date(),
    });
    const row = await env.DB
      .prepare("SELECT type, num_members, visibility, status FROM users WHERE username_lower = 'parityorg'")
      .first<{ type: string; num_members: number; visibility: string; status: string }>();
    // Pre-existing landed columns keep their defaults alongside the new ones.
    expect(row).toEqual({ type: "org", num_members: 1, visibility: "public", status: "active" });
  });
});

describe("org_members parity (superseded ORG_DDL_STATEMENTS table)", () => {
  it("declares the raw-DDL defaults and the (org_id, user_id) arbiter", async () => {
    const columns = new Map((await tableColumns("org_members")).map((c) => [c.name, c]));
    // drizzle-kit records the boolean default as the keyword literal `false`
    // (SQLite's 1/0 alias — behaviorally the raw DDL's DEFAULT 0, proven by
    // the insert-omitting-columns test below).
    expect(columns.get("is_public")).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "false" });
    expect(columns.get("role")).toMatchObject({ type: "TEXT", notnull: 1, dflt_value: "'member'" });
    expect(await indexNames("org_members")).toContain("org_members_org_user_uq");
  });

  it("defaults inserts like the raw DDL and arbitrates duplicates on both paths", async () => {
    const db = drizzle(env.DB);
    const ids = await seedUsers("ParityOrg2", "ParityMember");
    const orgId = ids[0]!;
    const userId = ids[1]!;

    // Raw path with omitted columns → declared defaults.
    await env.DB
      .prepare("INSERT INTO org_members (org_id, user_id, created_at) VALUES (?, ?, unixepoch())")
      .bind(orgId, userId)
      .run();
    const row = await env.DB
      .prepare("SELECT is_public, role FROM org_members WHERE org_id = ? AND user_id = ?")
      .bind(orgId, userId)
      .first<{ is_public: number; role: string }>();
    expect(row).toEqual({ is_public: 0, role: "member" });

    // Both write paths hit the UNIQUE arbiter (the §4.1/addMember race signal).
    await expect(
      env.DB
        .prepare("INSERT INTO org_members (org_id, user_id, created_at) VALUES (?, ?, unixepoch())")
        .bind(orgId, userId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db.insert(orgMembers).values({ orgId, userId, createdAt: new Date() }),
    ).rejects.toThrow();
  });

  it("cascades on user-row deletion (the declared ON DELETE CASCADE)", async () => {
    const db = drizzle(env.DB);
    const ids = await seedUsers("ParityOrg3", "ParityOwner");
    const orgId = ids[0]!;
    const ownerId = ids[1]!;
    await db.insert(orgMembers).values({ orgId, userId: ownerId, role: "owner", createdAt: new Date() });

    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(ownerId).run();
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM org_members WHERE org_id = ?").bind(orgId).first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});

describe("user_redirects parity (superseded ORG_DDL_STATEMENTS table)", () => {
  it("keeps one redirect per lower_name and cascades on the target user", async () => {
    const db = drizzle(env.DB);
    const ids = await seedUsers("ParityRenamed");
    const userId = ids[0]!;

    // Drizzle write, raw lookup — the renameOrg write rule / lookupUserRedirect seam.
    await db.insert(userRedirects).values({ lowerName: "parityold", redirectUserId: userId });
    expect(
      await env.DB.prepare("SELECT redirect_user_id FROM user_redirects WHERE lower_name = 'parityold'").first(),
    ).toEqual({ redirect_user_id: userId });

    // UNIQUE(lower_name): both paths refuse a second redirect at the name.
    await expect(
      env.DB.prepare("INSERT INTO user_redirects (lower_name, redirect_user_id) VALUES ('parityold', ?)").bind(userId).run(),
    ).rejects.toThrow();
    await expect(db.insert(userRedirects).values({ lowerName: "parityold", redirectUserId: userId })).rejects.toThrow();

    // ON DELETE CASCADE removes the alias with its owner.
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM user_redirects WHERE lower_name = 'parityold'").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});
