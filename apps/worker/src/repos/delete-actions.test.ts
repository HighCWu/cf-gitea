/**
 * Repo delete sweeps the repo's `action` rows (the wave-action-is-deleted
 * carried issue: the REDEPLOY11/12 probes hand-swept orphan action rows
 * twice after repo deletes because the delete batch never touched them).
 *
 * Upstream write arm (submodule pin): repo deletion HARD-DELETES the repo's
 * activity rows — `db.DeleteBeans(ctx, ..., &activities_model.Action{RepoID:
 * repo.ID}, ...)`, gitea/services/repository/delete.go:155-157 — it does NOT
 * write `is_deleted=1`: no production code path at the pin sets that flag
 * (the only `is_deleted` references on the action table are the read filters
 * and the index migrations). The landed schema contract agrees (db/schema.ts
 * actions docstring: "nothing sets it true ... repo deletion cascades rows
 * away with the repo row").
 *
 * Read-arm parity is upstream's GetFeeds is_deleted filter
 * (action_list.go:222-224 fast path, action.go:539-541 general path): ours
 * applies the same filter as feedCondition's first clause
 * (api/services/activity-feeds.ts) — pinned additively in
 * api/routes/activity-feeds.test.ts. This file proves the delete arm end to
 * end with a cross-repo fixture: the feeds that surfaced the doomed repo's
 * rows (the owner's user feed, a watcher's user feed, the org feed) stop
 * surfacing them while the SURVIVING repo's rows stay visible.
 *
 * New colocated file (not lifecycle.test.ts): that file is contested with a
 * sibling wave — see the wave ownership notes.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../auth/testing/seeds";
import { actions } from "../db/schema";
import { ActionType, getFeedRows, recordAction } from "../api/services/activity-feeds";
import { RepoService } from "./service";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "action",
    "personal_access_tokens",
    "protected_branches",
    "repo_units",
    "repo_transfer",
    "repo_redirects",
    "repo_counters",
    "repo_watchers",
    "stars",
    "repositories",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

/** A bare service: the delete batch is the arm under test — the engine
 *  steps (tombstone/registry/queue) are optional deps and skipped. */
function service(): RepoService {
  return new RepoService(env.DB);
}

/** The cross-repo fixture: an ORG-owned "doomed" repo carrying three events
 *  (create_repo + create_issue + comment_issue — 3 receiver copies each:
 *  the actor's original, the org owner's, the watcher's) plus a surviving
 *  user-owned "keeper" repo with one create_repo row. Returns the row ids
 *  and the receiver ids the feed assertions key on. */
async function seedFixture(): Promise<{
  aliceId: number;
  bobId: number;
  orgId: number;
  doomedId: string;
  keeperId: string;
}> {
  const alice = await seedVerifiedUser({ username: "Alice" });
  const bob = await seedVerifiedUser({ username: "Bob" });
  const org = await env.DB.prepare(
    "INSERT INTO users (username, username_lower, type, num_members, created_at) VALUES ('acme', 'acme', 'org', 1, ?) RETURNING id",
  )
    .bind(Math.floor(Date.now() / 1000))
    .first<{ id: number }>();
  const orgId = org!.id;

  const doomed = await service().create({
    owner: { id: orgId, usernameLower: "acme" },
    name: "doomed",
    isPrivate: false,
  });
  const keeper = await service().create({
    owner: { id: alice.id, usernameLower: "alice" },
    name: "keeper",
    isPrivate: false,
  });

  // Bob watches only the doomed repo: every doomed event fans him a copy.
  await env.DB.prepare("INSERT INTO repo_watchers (repo_id, user_id) VALUES (?, ?)").bind(doomed.id, bob.id).run();

  for (const [opType, content] of [
    [ActionType.CreateRepo, ""],
    [ActionType.CreateIssue, "1|it broke"],
    [ActionType.CommentIssue, "1|me too"],
  ] as const) {
    await recordAction(env.DB, {
      actUserId: alice.id,
      repoId: doomed.id,
      opType,
      isPrivate: false,
      content,
    });
  }
  await recordAction(env.DB, {
    actUserId: alice.id,
    repoId: keeper.id,
    opType: ActionType.CreateRepo,
    isPrivate: false,
  });

  return { aliceId: alice.id, bobId: bob.id, orgId, doomedId: doomed.id, keeperId: keeper.id };
}

describe("repo delete sweeps the repo's action rows (delete.go:157 DeleteBeans arm)", () => {
  it("hard-deletes every action row of the repo — originals and receiver copies alike — and leaves survivors untouched", async () => {
    const { aliceId, bobId, orgId, doomedId, keeperId } = await seedFixture();
    const db = drizzle(env.DB);
    const countFor = async (repoId: string): Promise<number> =>
      Number(
        (
          await env.DB.prepare("SELECT COUNT(*) AS n FROM action WHERE repo_id = ?").bind(repoId).first<{ n: number }>()
        )?.n,
      );

    // Pre-delete: 3 events x 3 receiver copies on the doomed repo (actor +
    // org owner + watcher), the keeper's single original row. is_deleted is
    // false everywhere — nothing writes it true (upstream has no writer; the
    // cascade is the delete).
    expect(await countFor(doomedId)).toBe(9);
    expect(await countFor(keeperId)).toBe(1);
    const flagged = await env.DB.prepare("SELECT COUNT(*) AS n FROM action WHERE is_deleted = 1").first<{ n: number }>();
    expect(flagged?.n).toBe(0);

    await service().deleteRepository(doomedId);

    // THE ARM: every doomed-repo row died in the delete batch (upstream's
    // `&activities_model.Action{RepoID: repo.ID}` DeleteBeans bean,
    // services/repository/delete.go:155-157) — originals AND fan-out copies,
    // so no operator hand-sweep is needed. The keeper's rows survive intact
    // and still read is_deleted=false (the flag stays a read-filter concern).
    expect(await countFor(doomedId)).toBe(0);
    expect(await countFor(keeperId)).toBe(1);
    const survivor = await db.select({ userId: actions.userId, isDeleted: actions.isDeleted }).from(actions).all();
    expect(survivor).toEqual([{ userId: aliceId, isDeleted: false }]);
    // The org + watcher user rows are untouched by the sweep (only the
    // doomed repo's action rows die).
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>().then((r) => Number(r?.n))).toBe(
      4, // alice, bob, acme, + the seeded 'assets' reservation row
    );
    expect(bobId).not.toBe(orgId); // fixture sanity
  });

  it("the feeds that surfaced the doomed repo's rows stop surfacing them; the survivor's rows stay visible", async () => {
    const { aliceId, bobId, orgId, doomedId, keeperId } = await seedFixture();

    const aliceFeed = () =>
      getFeedRows(env.DB, {
        kind: "user",
        requested: { id: aliceId },
        actor: { id: aliceId, isAdmin: false },
        includePrivate: true,
        onlyPerformedBy: false,
        page: 1,
        limit: 20,
      });
    const bobFeed = () =>
      getFeedRows(env.DB, {
        kind: "user",
        requested: { id: bobId },
        actor: { id: bobId, isAdmin: false },
        includePrivate: true,
        onlyPerformedBy: false,
        page: 1,
        limit: 20,
      });
    const orgFeed = () =>
      getFeedRows(env.DB, {
        kind: "org",
        requested: { id: orgId },
        actor: null,
        includePrivate: false,
        onlyPerformedBy: false,
        page: 1,
        limit: 20,
      });

    // Pre-delete: alice's feed surfaces the doomed repo's originals + the
    // keeper's row; bob's feed the doomed repo's watcher copies; the org
    // feed the org-owner copies.
    expect((await aliceFeed()).total).toBe(4);
    expect((await aliceFeed()).rows.map((row) => row.repoId).sort()).toEqual([doomedId, doomedId, doomedId, keeperId].sort());
    expect((await bobFeed()).total).toBe(3);
    expect((await orgFeed()).total).toBe(3);

    await service().deleteRepository(doomedId);

    // THE READ PROOF: the doomed repo's rows are gone from every feed that
    // previously surfaced them, and the keeper's row keeps its place (the
    // cross-repo fixture proves the sweep is repo-scoped, not a wipe).
    const aliceAfter = await aliceFeed();
    expect(aliceAfter.total).toBe(1);
    expect(aliceAfter.rows.map((row) => row.repoId)).toEqual([keeperId]);
    const bobAfter = await bobFeed();
    expect(bobAfter.total).toBe(0);
    expect(bobAfter.rows).toEqual([]);
    const orgAfter = await orgFeed();
    expect(orgAfter.total).toBe(0);
    expect(orgAfter.rows).toEqual([]);
  });
});
