/**
 * Schema/migration parity (the 0005 consolidation of the service-side
 * DDL-in-waiting, extended by the 0007, 0008, 0009 and 0010 sweeps): a D1
 * freshly applied the generated migrations must accept exactly the operations
 * the superseded raw-DDL paths (`LFS_OBJECTS_DDL_STATEMENTS`,
 * `ORG_DDL_STATEMENTS`, the batch-7
 * `REPO_TOPICS/REPO_WATCHERS/REPO_COLLABORATORS/REPO_SETTINGS/
 * FOLLOWS_DDL_STATEMENTS`, the straggler `STARS`/`USER_SETTINGS`/
 * `FORKS_DDL_STATEMENTS`, and the mirror wave's pinned §3.1 DDL that
 * services/mirror/sync.ts read raw) allowed, and the Drizzle table objects
 * must drive those same statements.
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
import { and, eq, inArray, lte, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import {
  follows,
  lfsObjects,
  orgMembers,
  repoCollaborators,
  repoMirrors,
  repoSettings,
  repoTopics,
  repoWatchers,
  repositories,
  stars,
  userRedirects,
  userSettings,
  users,
} from "./schema";

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

describe("batch-7 stores parity (superseded REPO_*_DDL_STATEMENTS)", () => {
  it("repo_topics: composite PK structure and the diffed-replace write rule", async () => {
    const db = drizzle(env.DB);
    const columns = await tableColumns("repo_topics");
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["repo_id", "TEXT", 1, 1],
      ["topic", "TEXT", 1, 2],
    ]);

    // Drizzle path: the replace delta (delete removed + insert added).
    await db.batch([
      db.insert(repoTopics).values({ repoId: "t1", topic: "go" }),
      db.insert(repoTopics).values({ repoId: "t1", topic: "web" }),
    ]);
    await db.delete(repoTopics).where(and(eq(repoTopics.repoId, "t1"), eq(repoTopics.topic, "web")));
    const kept = await env.DB.prepare("SELECT topic FROM repo_topics WHERE repo_id = 't1'").all<{ topic: string }>();
    expect(kept.results).toEqual([{ topic: "go" }]);

    // The (repo_id, topic) PK arbitrates duplicates on the raw path too.
    await expect(
      env.DB.prepare("INSERT INTO repo_topics (repo_id, topic) VALUES ('t1', 'go')").run(),
    ).rejects.toThrow();
  });

  it("repo_watchers: composite PK, user index, first-created_at upsert", async () => {
    const db = drizzle(env.DB);
    const columns = await tableColumns("repo_watchers");
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["repo_id", "TEXT", 1, 1],
      ["user_id", "INTEGER", 1, 2],
      ["created_at", "INTEGER", 0, 0],
    ]);
    expect(await indexNames("repo_watchers")).toContain("idx_repo_watchers_user");

    // DO NOTHING keeps the FIRST created_at on repeat watches.
    await db.insert(repoWatchers).values({ repoId: "w1", userId: 7, createdAt: new Date(1000) });
    await db.insert(repoWatchers).values({ repoId: "w1", userId: 7, createdAt: new Date(5000) }).onConflictDoNothing();
    expect(
      await env.DB.prepare("SELECT created_at FROM repo_watchers WHERE repo_id = 'w1'").first<{ created_at: number }>(),
    ).toEqual({ created_at: 1 });
  });

  it("repo_collaborators: composite PK, 'write' default, upsert arbitration", async () => {
    const db = drizzle(env.DB);
    const columns = await tableColumns("repo_collaborators");
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["repo_id", "TEXT", 1, 1],
      ["user_id", "INTEGER", 1, 2],
      ["mode", "TEXT", 1, 0],
      ["created_at", "INTEGER", 0, 0],
      ["updated_at", "INTEGER", 0, 0],
    ]);
    expect(await indexNames("repo_collaborators")).toContain("idx_repo_collaborators_user");

    // Raw insert with omitted columns → the raw DDL's DEFAULT 'write'.
    await env.DB.prepare("INSERT INTO repo_collaborators (repo_id, user_id) VALUES ('c1', 3)").run();
    expect(
      await env.DB.prepare("SELECT mode FROM repo_collaborators WHERE repo_id = 'c1'").first<{ mode: string }>(),
    ).toEqual({ mode: "write" });

    // Both paths arbitrate the (repo_id, user_id) upsert.
    await expect(
      env.DB.prepare("INSERT INTO repo_collaborators (repo_id, user_id) VALUES ('c1', 3)").run(),
    ).rejects.toThrow();
    await db
      .insert(repoCollaborators)
      .values({ repoId: "c1", userId: 3, mode: "admin", createdAt: new Date(2000), updatedAt: new Date(2000) })
      .onConflictDoUpdate({
        target: [repoCollaborators.repoId, repoCollaborators.userId],
        set: { mode: "admin", updatedAt: new Date(2000) },
      });
    expect(
      await env.DB.prepare("SELECT mode FROM repo_collaborators WHERE repo_id = 'c1'").first<{ mode: string }>(),
    ).toEqual({ mode: "admin" });
  });

  it("repo_settings: 1:1 PK row, declared defaults on omitted columns", async () => {
    const db = drizzle(env.DB);
    const columns = await tableColumns("repo_settings");
    expect(columns.map((c) => [c.name, c.type, c.notnull])).toEqual([
      ["repo_id", "TEXT", 1],
      ["description", "TEXT", 1],
      ["website", "TEXT", 1],
      ["has_issues", "INTEGER", 1],
      ["has_wiki", "INTEGER", 1],
      ["has_pull_requests", "INTEGER", 1],
      ["has_releases", "INTEGER", 1],
      ["has_projects", "INTEGER", 1],
      ["has_packages", "INTEGER", 1],
      ["has_actions", "INTEGER", 1],
      ["updated_at", "INTEGER", 0],
    ]);

    // Insert omitting every defaulted column → upstream defaults (the raw
    // DDL's 1/0; drizzle-kit records the `true`/`false` keyword aliases).
    await db.insert(repoSettings).values({ repoId: "s1" });
    expect(
      await env.DB
        .prepare(
          `SELECT description, website, has_issues, has_projects, has_actions
           FROM repo_settings WHERE repo_id = 's1'`,
        )
        .first<Record<string, unknown>>(),
    ).toEqual({ description: "", website: "", has_issues: 1, has_projects: 0, has_actions: 0 });

    // The repo_id PK arbitrates the PATCH upsert.
    await expect(db.insert(repoSettings).values({ repoId: "s1" })).rejects.toThrow();
  });

  it("follows: UNIQUE pair + reverse index, cascade on either user", async () => {
    const db = drizzle(env.DB);
    const ids = await seedUsers("ParityFollower", "ParityFollowed");
    const followerId = ids[0]!;
    const followedId = ids[1]!;

    const columns = await tableColumns("follows");
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["id", "INTEGER", 1, 1],
      ["user_id", "INTEGER", 1, 0],
      ["follow_id", "INTEGER", 1, 0],
      ["created_at", "INTEGER", 1, 0],
    ]);
    expect(await indexNames("follows")).toContain("follows_user_follow_uq");
    expect(await indexNames("follows")).toContain("follows_follow_idx");

    // Drizzle write (followUser's guarded insert), raw UNIQUE check.
    await db.insert(follows).values({ userId: followerId, followId: followedId, createdAt: new Date(3000) });
    await expect(
      env.DB
        .prepare("INSERT INTO follows (user_id, follow_id, created_at) VALUES (?, ?, 0)")
        .bind(followerId, followedId)
        .run(),
    ).rejects.toThrow();

    // ON DELETE CASCADE fires on both edges (the declared FKs).
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(followerId).run();
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM follows WHERE follow_id = ?").bind(followedId).first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});

describe("stars parity (superseded STARS_DDL_STATEMENTS)", () => {
  it("has the raw-DDL structure: autoincrement id, pair arbiter, repo index", async () => {
    const columns = await tableColumns("stars");
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["id", "INTEGER", 1, 1],
      ["user_id", "INTEGER", 1, 0],
      ["repo_id", "TEXT", 1, 0],
      ["created_at", "INTEGER", 1, 0],
    ]);
    expect(await indexNames("stars")).toContain("stars_user_repo_uq");
    expect(await indexNames("stars")).toContain("stars_repo_idx");
  });

  it("accepts the same writes via raw D1 and the drizzle schema, cascades on the user", async () => {
    const db = drizzle(env.DB);
    const ids = await seedUsers("ParityStargazer");
    const userId = ids[0]!;

    // Raw path (starRepo's guarded insert): DO NOTHING keeps the FIRST
    // created_at on repeat stars.
    await env.DB.prepare("INSERT INTO stars (user_id, repo_id, created_at) VALUES (?, ?, 100)").bind(userId, "p1").run();
    await env.DB
      .prepare(
        "INSERT INTO stars (user_id, repo_id, created_at) VALUES (?, ?, 500) ON CONFLICT (user_id, repo_id) DO NOTHING",
      )
      .bind(userId, "p1")
      .run();
    // Drizzle path: a second edge plus the same guarded repeat
    // (starRepo's onConflictDoNothing on the pair). Timestamp-mode dates
    // store as unix seconds (new Date(200_000) → 200).
    await db.insert(stars).values({ userId, repoId: "p2", createdAt: new Date(200_000) });
    await db
      .insert(stars)
      .values({ userId, repoId: "p2", createdAt: new Date(600_000) })
      .onConflictDoNothing({ target: [stars.userId, stars.repoId] });
    const starRows = await env.DB
      .prepare("SELECT repo_id, created_at FROM stars ORDER BY created_at")
      .all<{ repo_id: string; created_at: number }>();
    expect(starRows.results).toEqual([
      { repo_id: "p1", created_at: 100 },
      { repo_id: "p2", created_at: 200 },
    ]);

    // UNIQUE(user_id, repo_id) is a real constraint on both paths: a bare
    // duplicate (no DO NOTHING arm) fails.
    await expect(
      env.DB.prepare("INSERT INTO stars (user_id, repo_id, created_at) VALUES (?, ?, 900)").bind(userId, "p1").run(),
    ).rejects.toThrow();
    await expect(db.insert(stars).values({ userId, repoId: "p2", createdAt: new Date(900_000) })).rejects.toThrow();

    // ON DELETE CASCADE fires on the user edge (the declared FK); repo-scoped
    // rows go through the deleteRepository cascade (src/repos/service.ts).
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM stars").first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe("user_settings parity (superseded USER_SETTINGS_DDL_STATEMENTS)", () => {
  it("has the raw-DDL structure: 1:1 user PK and upstream creation defaults", async () => {
    const columns = await tableColumns("user_settings");
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["user_id", "INTEGER", 1, 1],
      ["theme", "TEXT", 1, 0],
      ["language", "TEXT", 1, 0],
      ["diff_view_style", "TEXT", 1, 0],
      ["hide_email", "INTEGER", 1, 0],
      ["hide_activity", "INTEGER", 1, 0],
    ]);
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("theme")?.dflt_value).toBe("'gitea-auto'");
    expect(byName.get("language")?.dflt_value).toBe("''");
    expect(byName.get("diff_view_style")?.dflt_value).toBe("''");
    // drizzle-kit records the boolean default as the keyword literal `false`
    // (SQLite's 1/0 alias — behaviorally the raw DDL's DEFAULT 0, proven by
    // the insert-omitting-columns test below).
    expect(byName.get("hide_email")?.dflt_value).toBe("false");
    expect(byName.get("hide_activity")?.dflt_value).toBe("false");
  });

  it("defaults inserts like the raw DDL, upserts on the user PK, cascades on the user", async () => {
    const db = drizzle(env.DB);
    const ids = await seedUsers("ParitySettings", "ParitySettings2");
    const userId = ids[0]!;
    const otherId = ids[1]!;

    // Raw insert omitting every defaulted column → upstream creation values
    // (theme 'gitea-auto', empty style/language, private flags 0).
    await env.DB.prepare("INSERT INTO user_settings (user_id) VALUES (?)").bind(userId).run();
    expect(
      await env.DB
        .prepare("SELECT theme, language, diff_view_style, hide_email, hide_activity FROM user_settings WHERE user_id = ?")
        .bind(userId)
        .first<Record<string, unknown>>(),
    ).toEqual({ theme: "gitea-auto", language: "", diff_view_style: "", hide_email: 0, hide_activity: 0 });

    // The PATCH write (saveUserSettings): drizzle upsert on the user_id PK,
    // non-presented fields keeping their stored value.
    await db
      .insert(userSettings)
      .values({ userId, theme: "gitea-dark", hideEmail: true })
      .onConflictDoUpdate({ target: userSettings.userId, set: { theme: "gitea-dark", hideEmail: true } });
    expect(
      await env.DB
        .prepare("SELECT theme, language, hide_email FROM user_settings WHERE user_id = ?")
        .bind(userId)
        .first<Record<string, unknown>>(),
    ).toEqual({ theme: "gitea-dark", language: "", hide_email: 1 });

    // Drizzle insert omitting the defaulted columns → the schema defaults.
    await db.insert(userSettings).values({ userId: otherId });
    expect(
      await env.DB.prepare("SELECT theme, hide_activity FROM user_settings WHERE user_id = ?").bind(otherId).first(),
    ).toEqual({ theme: "gitea-auto", hide_activity: 0 });

    // ON DELETE CASCADE fires on the user edge (the declared FK).
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    const remaining = await env.DB.prepare("SELECT user_id FROM user_settings").all<{ user_id: number }>();
    expect(remaining.results).toEqual([{ user_id: otherId }]);
  });
});

describe("repositories fork_parent parity (superseded FORKS_DDL_STATEMENTS)", () => {
  it("appends the edge as the last column — nullable TEXT, no default, source index", async () => {
    const columns = await tableColumns("repositories");
    // The full physical order: the ALTER ADD COLUMN constraint puts
    // fork_parent LAST and pins migration 0009 additive-only (no
    // pre-existing column may drift). Migration 0010 appends the mirror
    // columns after it — same additive rule (SPEC-0009 §3.1).
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["id", "TEXT", 1, 1],
      ["storage_key", "TEXT", 1, 0],
      ["owner_namespace", "TEXT", 1, 0],
      ["slug", "TEXT", 1, 0],
      ["visibility", "TEXT", 1, 0],
      ["refs_version", "INTEGER", 1, 0],
      ["backend", "TEXT", 1, 0],
      ["created_at", "INTEGER", 1, 0],
      ["num_issues", "INTEGER", 1, 0],
      ["num_closed_issues", "INTEGER", 1, 0],
      ["num_pulls", "INTEGER", 1, 0],
      ["num_closed_pulls", "INTEGER", 1, 0],
      ["num_milestones", "INTEGER", 1, 0],
      ["close_issues_via_commit_in_any_branch", "INTEGER", 1, 0],
      ["owner_id", "INTEGER", 0, 0],
      ["default_branch", "TEXT", 1, 0],
      ["is_empty", "INTEGER", 1, 0],
      ["is_archived", "INTEGER", 1, 0],
      ["status", "TEXT", 1, 0],
      ["updated_at", "INTEGER", 0, 0],
      ["fork_parent", "TEXT", 0, 0],
      ["is_mirror", "INTEGER", 1, 0],
      ["original_url", "TEXT", 0, 0],
      // wave-api-badges-licenses-template: the template flag (upstream
      // Repository.IsTemplate) — appended LAST like every ALTER sweep.
      ["is_template", "INTEGER", 1, 0],
    ]);
    // The appended columns keep the ALTER ADD COLUMN constraints: is_mirror
    // is NOT NULL with the keyword-alias default (`false` = 0), original_url
    // nullable with NO default — the bare `ADD COLUMN original_url text`:
    // pre-existing rows read NULL (fork_parent above reads the same way).
    // is_template (0027) is NOT NULL DEFAULT false like is_mirror.
    expect(columns.at(-3)?.dflt_value).toBe("false");
    expect(columns.at(-2)?.dflt_value).toBeNull();
    expect(columns.at(-1)?.dflt_value).toBe("false");
    expect(await indexNames("repositories")).toContain("repositories_fork_parent_idx");
  });

  it("accepts the same edge writes via raw D1 and the drizzle schema, serves the fork scans", async () => {
    const db = drizzle(env.DB);
    const ownerId = (await seedUsers("ParityForker"))[0]!;
    await env.DB
      .prepare(
        "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility) VALUES ('pf_src', 'r_pf_src', 'parityforker', ?, 'src', 'public')",
      )
      .bind(ownerId)
      .run();
    await env.DB
      .prepare(
        "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility) VALUES ('pf_fork', 'r_pf_fork', 'parityforker', ?, 'fork', 'public')",
      )
      .bind(ownerId)
      .run();

    // Raw write path — createFork's superseded stamp statement.
    await env.DB.prepare("UPDATE repositories SET fork_parent = ?1 WHERE id = ?2").bind("pf_src", "pf_fork").run();
    // Raw read paths — findForkByOwner's one-fork-per-owner arbitration
    // SELECT and listForks' source scan.
    expect(
      await env.DB
        .prepare("SELECT id, owner_namespace, slug FROM repositories WHERE fork_parent = ?1 AND owner_id = ?2 LIMIT 1")
        .bind("pf_src", ownerId)
        .first<Record<string, unknown>>(),
    ).toEqual({ id: "pf_fork", owner_namespace: "parityforker", slug: "fork" });
    expect(
      await env.DB.prepare("SELECT count(*) AS total FROM repositories WHERE fork_parent = ?1").bind("pf_src").first<{ total: number }>(),
    ).toEqual({ total: 1 });

    // Drizzle write path — createFork's merged .set stamp (unstamp first,
    // then restamp with the upstream-copied metadata in the same update).
    await db.update(repositories).set({ forkParent: null }).where(eq(repositories.id, "pf_fork"));
    expect(
      await env.DB.prepare("SELECT fork_parent FROM repositories WHERE id = 'pf_fork'").first<{ fork_parent: string | null }>(),
    ).toEqual({ fork_parent: null });
    await db
      .update(repositories)
      .set({ forkParent: "pf_src", updatedAt: new Date(100_000) })
      .where(eq(repositories.id, "pf_fork"));

    // Drizzle read paths — findForkByOwner/listForks' swapped queries.
    expect(
      await db
        .select({ id: repositories.id, slug: repositories.slug })
        .from(repositories)
        .where(and(eq(repositories.forkParent, "pf_src"), eq(repositories.ownerId, ownerId)))
        .get(),
    ).toEqual({ id: "pf_fork", slug: "fork" });
    expect(
      await db.select({ id: repositories.id }).from(repositories).where(eq(repositories.forkParent, "pf_src")).all(),
    ).toEqual([{ id: "pf_fork" }]);

    // No delete-cascade row: the edge dies with the repositories row itself.
    await env.DB.prepare("DELETE FROM repositories WHERE id = 'pf_fork'").run();
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM repositories WHERE fork_parent = 'pf_src'").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });
});

describe("repositories is_mirror/original_url parity (SPEC-0009 §3.1, migration 0010)", () => {
  it("defaults inserts to plain repos and round-trips the mirror stamp", async () => {
    const db = drizzle(env.DB);

    // Insert omitting the appended columns → non-mirror defaults (the raw
    // ALTERs' behavior for every pre-0010 row: is_mirror 0, original_url NULL).
    await env.DB
      .prepare(
        "INSERT INTO repositories (id, storage_key, owner_namespace, slug, visibility) VALUES ('im_plain', 'r_im_plain', 'paritymirror', 'plain', 'public')",
      )
      .run();
    expect(
      await env.DB.prepare("SELECT is_mirror, original_url FROM repositories WHERE id = 'im_plain'").first(),
    ).toEqual({ is_mirror: 0, original_url: null });

    // Drizzle stamp (the mirror-PATCH/migrate wave's write), raw read back.
    await db
      .update(repositories)
      .set({ isMirror: true, originalUrl: "https://git.example.com/upstream.git" })
      .where(eq(repositories.id, "im_plain"));
    expect(
      await env.DB
        .prepare("SELECT is_mirror, original_url FROM repositories WHERE id = 'im_plain'")
        .first<{ is_mirror: number; original_url: string | null }>(),
    ).toEqual({ is_mirror: 1, original_url: "https://git.example.com/upstream.git" });
  });
});

describe("repo_mirrors parity (the mirror wave's pinned §3.1 DDL, migration 0010)", () => {
  it("has the pinned-DDL structure: defaults, the sync_state CHECK, the repo_id arbiter", async () => {
    const columns = await tableColumns("repo_mirrors");
    expect(columns.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["id", "INTEGER", 1, 1],
      ["repo_id", "TEXT", 1, 0],
      ["interval_seconds", "INTEGER", 1, 0],
      ["enable_prune", "INTEGER", 1, 0],
      ["lfs_enabled", "INTEGER", 1, 0],
      ["lfs_endpoint", "TEXT", 0, 0],
      ["remote_address", "TEXT", 1, 0],
      ["credentials_username", "TEXT", 0, 0],
      ["credentials_ciphertext", "TEXT", 0, 0],
      ["sync_state", "TEXT", 1, 0],
      ["next_sync_at", "INTEGER", 1, 0],
      ["last_sync_at", "INTEGER", 0, 0],
      ["last_error", "TEXT", 0, 0],
      ["created_at", "INTEGER", 1, 0],
      ["updated_at", "INTEGER", 1, 0],
    ]);
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("interval_seconds")?.dflt_value).toBe("28800");
    // drizzle-kit records the boolean defaults as the keyword literals
    // (`true`/`false` — SQLite's 1/0 aliases, proven by the insert-omitting
    // test below); sync_state defaults to the CHECK's base state.
    expect(byName.get("enable_prune")?.dflt_value).toBe("true");
    expect(byName.get("lfs_enabled")?.dflt_value).toBe("false");
    expect(byName.get("sync_state")?.dflt_value).toBe("'idle'");
    expect(byName.get("next_sync_at")?.dflt_value).toBe("0");
    expect(byName.get("created_at")?.dflt_value).toBe("unixepoch()");
    expect(byName.get("updated_at")?.dflt_value).toBe("unixepoch()");

    // UNIQUE(repo_id) — one pull mirror per repo (upstream GetMirrorByRepoID
    // assumes ≤ 1) — and the idle|queued|syncing CHECK in the table DDL.
    expect(await indexNames("repo_mirrors")).toContain("repo_mirrors_repo_id_unique");
    const ddl = await env.DB
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'repo_mirrors'")
      .first<{ sql: string }>();
    expect(ddl?.sql).toContain("repo_mirrors_sync_state_check");
  });

  it("defaults inserts like the pinned DDL and arbitrates one-mirror-per-repo on both paths", async () => {
    const db = drizzle(env.DB);

    // Raw insert omitting every defaulted column → upstream creation values.
    await env.DB
      .prepare("INSERT INTO repo_mirrors (repo_id, remote_address) VALUES ('pm1', 'https://src.example.com/up.git')")
      .run();
    expect(
      await env.DB
        .prepare(
          `SELECT interval_seconds, enable_prune, lfs_enabled, sync_state, next_sync_at, last_sync_at, last_error
           FROM repo_mirrors WHERE repo_id = 'pm1'`,
        )
        .first<Record<string, unknown>>(),
    ).toEqual({
      interval_seconds: 28800,
      enable_prune: 1,
      lfs_enabled: 0,
      sync_state: "idle",
      next_sync_at: 0,
      last_sync_at: null,
      last_error: null,
    });

    // UNIQUE(repo_id): both write paths refuse a second pull mirror.
    await expect(
      env.DB.prepare("INSERT INTO repo_mirrors (repo_id, remote_address) VALUES ('pm1', 'https://other.example.com/x.git')").run(),
    ).rejects.toThrow();
    await expect(
      db.insert(repoMirrors).values({ repoId: "pm1", remoteAddress: "https://other.example.com/x.git" }),
    ).rejects.toThrow();

    // The sync_state CHECK is a real constraint (a raw out-of-enum write fails).
    await expect(
      env.DB.prepare("INSERT INTO repo_mirrors (repo_id, remote_address, sync_state) VALUES ('pm2', 'https://x', 'bogus')").run(),
    ).rejects.toThrow();
  });

  it("drives the §2.6 sync-state machine through the sync service's drizzle CAS shapes", async () => {
    const db = drizzle(env.DB);
    await db.insert(repoMirrors).values({
      repoId: "pm3",
      remoteAddress: "https://src.example.com/m.git",
      intervalSeconds: 600,
      nextSyncAt: 1000,
    });

    // Cron producer CAS: idle → queued, only from idle — the enqueue guard
    // (a second producer racing the first moves 0 rows).
    const enqueueCas = (repoId: string) =>
      db
        .update(repoMirrors)
        .set({ syncState: "queued", updatedAt: new Date() })
        .where(and(eq(repoMirrors.repoId, repoId), eq(repoMirrors.syncState, "idle")))
        .returning({ repoId: repoMirrors.repoId })
        .all();
    expect((await enqueueCas("pm3")).map((r) => r.repoId)).toEqual(["pm3"]);
    expect(await enqueueCas("pm3")).toEqual([]);

    // Consumer claim CAS: queued|idle → syncing (re-guard over the enqueue —
    // the mirror-sync API can race the cron producer).
    const claimCas = (repoId: string) =>
      db
        .update(repoMirrors)
        .set({ syncState: "syncing", updatedAt: new Date() })
        .where(and(eq(repoMirrors.repoId, repoId), inArray(repoMirrors.syncState, ["idle", "queued"])))
        .returning({ repoId: repoMirrors.repoId })
        .all();
    expect(await claimCas("pm3")).toHaveLength(1);

    // Failure settle: back to idle with the sanitized last_error;
    // next_sync_at stays due so the next cron retries (upstream posture,
    // mirror_pull.go:303-308).
    await db
      .update(repoMirrors)
      .set({ lastError: "mirror sync failed: boom", syncState: "idle", updatedAt: new Date() })
      .where(and(eq(repoMirrors.repoId, "pm3"), eq(repoMirrors.syncState, "syncing")));
    expect(
      await env.DB.prepare("SELECT sync_state, next_sync_at, last_error FROM repo_mirrors WHERE repo_id = 'pm3'").first(),
    ).toEqual({ sync_state: "idle", next_sync_at: 1000, last_error: "mirror sync failed: boom" });

    // The due scan picks the failed row back up
    // (`next_sync_at <= now AND != 0 AND idle`, oldest-synced first).
    expect(
      await db
        .select({ repoId: repoMirrors.repoId })
        .from(repoMirrors)
        .where(and(lte(repoMirrors.nextSyncAt, 2000), ne(repoMirrors.nextSyncAt, 0), eq(repoMirrors.syncState, "idle")))
        .orderBy(repoMirrors.repoId)
        .all(),
    ).toEqual([{ repoId: "pm3" }]);

    // Success settle: last_sync_at = now, next_sync_at = now + interval,
    // last_error cleared — CAS'd on 'syncing' so an abort/delete race can
    // never resurrect the row state.
    await claimCas("pm3");
    await db
      .update(repoMirrors)
      .set({ lastSyncAt: 5000, nextSyncAt: 5000 + 600, syncState: "idle", lastError: null, updatedAt: new Date() })
      .where(and(eq(repoMirrors.repoId, "pm3"), eq(repoMirrors.syncState, "syncing")));
    expect(
      await env.DB.prepare("SELECT sync_state, last_sync_at, next_sync_at, last_error FROM repo_mirrors WHERE repo_id = 'pm3'").first(),
    ).toEqual({ sync_state: "idle", last_sync_at: 5000, next_sync_at: 5600, last_error: null });

    // A disabled interval (0) settles unscheduled — and the due scan's
    // `next_sync_at != 0` guard keeps it out.
    await db.update(repoMirrors).set({ intervalSeconds: 0 }).where(eq(repoMirrors.repoId, "pm3"));
    await db
      .update(repoMirrors)
      .set({ syncState: "syncing", updatedAt: new Date() })
      .where(and(eq(repoMirrors.repoId, "pm3"), eq(repoMirrors.syncState, "idle")));
    await db
      .update(repoMirrors)
      .set({ lastSyncAt: 6000, nextSyncAt: 0, syncState: "idle", lastError: null, updatedAt: new Date() })
      .where(and(eq(repoMirrors.repoId, "pm3"), eq(repoMirrors.syncState, "syncing")));
    expect(
      await db
        .select({ repoId: repoMirrors.repoId })
        .from(repoMirrors)
        .where(and(lte(repoMirrors.nextSyncAt, 9000), ne(repoMirrors.nextSyncAt, 0), eq(repoMirrors.syncState, "idle")))
        .all(),
    ).toEqual([]);
  });
});
