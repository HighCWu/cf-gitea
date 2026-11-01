/**
 * branch-restore module tests — the RESTORE half of the recorded 3-step
 * trigger, driven DIRECTLY over the real workerd bindings (the
 * branch-feed smoke twin's harness posture: the route arm is
 * index-owned; the branches header's HANDOFF carries the mount recipe):
 *
 *   1. The real-engine ROUND-TRIP: a REAL delete (applyBranchDelete, the
 *      arm's PRE-CAS row) → the ref gone, the row holding the recorded
 *      sha + actor + a sane stamp → applyBranchRestore of that id → the
 *      ref back AT the sha, the restored row no longer rendering in the
 *      deleted section (the live-ref filter — upstream's push-sync
 *      un-flag observable).
 *   2. The re-delete overwrite: the same name deleted again at a NEW tip
 *      → still ONE (repo, name) row recording the NEW sha (the schema's
 *      upsert contract).
 *   3. The restore-when-already-exists arm: the name re-pushed before the
 *      restore → the CAS create-on-empty refuses (ref_conflict) → the
 *      already_exists outcome, the live tip untouched.
 *   4. The missing arms: an unknown name deletes missing with NO row; an
 *      unknown id, a WRONG-REPO id and a NON-WRITER all restore missing
 *      (the 404 shell's arms — existence stays hidden).
 *   5. The protected-name refusal: a rule matching the name folds the
 *      restore into refused-protected (upstream's push-hook refusal —
 *      the flash folds into restore_failed downstream), the ref stays
 *      gone.
 *   6. The loader's deleted arm over loadBranchesData: the deleted_unix
 *      DESC, name ASC order (the documented divergence — the substrate
 *      carries no commit_time), the keyword filter composing, the PR
 *      cell's row carrying MergeMovedOn against the STORED sha
 *      (loadOneBranch's `headCommit := dbBranch.CommitID`), and the form
 *      parse (FormInt64's posture).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findRepositoryById } from "../../api/services/repository";
import { ZERO_OID } from "../../api/services/engine";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { deletedBranches, protectedBranches, pullRequests, repositories, users } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { emptyRuleConfig, serializeRuleConfig } from "../../services/branch-protection";
import { buildHistoryPack, ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import type { RepoRow } from "../ui-context";
import type { Viewer } from "../viewer";
import { applyBranchDelete, loadBranchesData, type BranchDeleteInput } from "./branches";
import { applyBranchRestore, parseBranchRestoreForm } from "./branch-restore";

// --- fixtures ----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — the harness epoch
const ORIGIN = "https://restore.test";
const OWNER = "alice";
const STRANGER = "restorer-pal";
const SLUG = "branchrestore";
const OTHER_SLUG = "branchrestore2";

/** Three main-line commits: root, topic's tip, main's tip — ensureSeededRepo
 *  pushes main at the LAST tip, so the restore source (topic) sits at a
 *  DIFFERENT sha than the default's, proving the round-trip replays the
 *  recorded sha rather than the default's. */
const SEED_COMMITS: SeedCommit[] = [
  { message: "restore: root", time: T0, files: [{ path: "README.md", content: "root\n" }] },
  { message: "restore: topic tip", time: T0 + 60, files: [{ path: "f1.txt", content: "one\n" }] },
  { message: "restore: main tip", time: T0 + 120, files: [{ path: "f2.txt", content: "two\n" }] },
];
const ROOT_TIP = 0;
const TOPIC_TIP = 1;
const MAIN_TIP = 2;

interface RestoreFixture {
  repo: RepoRow;
  otherRepo: RepoRow;
  tips: string[];
  ownerId: number;
  viewer: Viewer;
  stranger: Viewer;
  doerRow: typeof users.$inferSelect;
}

async function repoRow(ownerNamespace: string, slug: string): Promise<RepoRow> {
  const row = await drizzle(env.DB)
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, ownerNamespace), eq(repositories.slug, slug)))
    .get();
  if (row === undefined) throw new Error(`restore fixture missing: ${ownerNamespace}/${slug}`);
  return row;
}

/**
 * Idempotent fixture: the two seeded repos (the real receive flow pushes
 * main; the pack stores every commit object, so the extra branch refs are
 * plain engine CAS-creates), the wanted refs converged at their exact tips
 * (a prior arm's deletes and restores leave refs gone or moved — each one
 * is (re)created, a moved one cleared first), and the per-test D1 state
 * (substrate rows + protection rules) wiped.
 */
async function seedFixture(): Promise<RestoreFixture> {
  const ownerUser =
    (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, OWNER)).get()) ??
    (await (async () => {
      await seedVerifiedUser({ username: OWNER });
      return (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, OWNER)).get())!;
    })());
  if ((await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, STRANGER)).get()) === undefined) {
    await seedVerifiedUser({ username: STRANGER });
  }
  const strangerRow = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, STRANGER)).get())!;

  await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits: SEED_COMMITS });
  await ensureSeededRepo({ owner: OWNER, slug: OTHER_SLUG, commits: SEED_COMMITS.slice(0, 1) });

  const tips = (await buildHistoryPack(SEED_COMMITS)).tips;
  const repo = await repoRow(OWNER, SLUG);
  const otherRepo = await repoRow(OWNER, OTHER_SLUG);

  // The extra branches converge at their exact tips (the receive flow's
  // pack stored all three commit objects with main's push).
  const cell = env.REPO.getByName(`${OWNER}/${SLUG}`);
  const wanted = [
    { ref: "refs/heads/topic", oid: tips[TOPIC_TIP] as string },
    { ref: "refs/heads/deep/feat", oid: tips[ROOT_TIP] as string },
  ];
  const current = new Map((await cell.listRefs()).refs.map((ref) => [ref.name, ref.target]));
  for (const entry of wanted) {
    const at = current.get(entry.ref);
    if (at === entry.oid) continue;
    if (at !== undefined) {
      const removed = await cell.deleteApiRef({ ref: entry.ref, expectedOid: at });
      if (removed.tag === "invalid") throw new Error(`restore seed: ${entry.ref} clear failed`);
    }
    const created = await cell.commitApiChange({ ref: entry.ref, expectedOldOid: ZERO_OID, newOid: entry.oid });
    if (created.tag !== "committed") throw new Error(`restore seed: ${entry.ref} create failed (${created.tag})`);
  }

  // Per-test D1 state: substrate rows and protection rules go.
  await env.DB.prepare("DELETE FROM deleted_branches WHERE repo_id = ?").bind(repo.id).run();
  await env.DB.prepare("DELETE FROM deleted_branches WHERE repo_id = ?").bind(otherRepo.id).run();
  await env.DB.prepare("DELETE FROM protected_branches WHERE repo_id = ?").bind(repo.id).run();

  const viewer: Viewer = { kind: "user", id: ownerUser.id, username: ownerUser.username, isAdmin: false };
  const stranger: Viewer = { kind: "user", id: strangerRow.id, username: strangerRow.username, isAdmin: false };
  return { repo, otherRepo, tips, ownerId: ownerUser.id, viewer, stranger, doerRow: ownerUser };
}

let fixture: RestoreFixture;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  fixture = await seedFixture();
});

/** The write input the handlers resolve once (the doer row + the pair). */
async function restoreInput(repo: RepoRow): Promise<BranchDeleteInput> {
  const pair = await findRepositoryById(env.DB, repo.id);
  if (pair === null) throw new Error("restore fixture: pair missing");
  return { pair, doer: fixture.doerRow, origin: ORIGIN, waitUntil: undefined };
}

async function deletedRowFor(repo: RepoRow, name: string): Promise<typeof deletedBranches.$inferSelect> {
  const row = await drizzle(env.DB)
    .select()
    .from(deletedBranches)
    .where(and(eq(deletedBranches.repoId, repo.id), eq(deletedBranches.name, name)))
    .get();
  if (row === undefined) throw new Error(`restore fixture: no deleted row for ${name}`);
  return row;
}

// --- the chain ---------------------------------------------------------------

describe("the delete→row→restore chain (migration 0059's substrate, the real engine cell)", () => {
  it("the delete lands the PRE-CAS row (sha + actor + stamp); the restore replays the ref AT the sha", async () => {
    const input = await restoreInput(fixture.repo);
    const before = Math.floor(Date.now() / 1000);
    expect(await applyBranchDelete(env, fixture.repo, fixture.viewer, "topic", input)).toEqual({ outcome: "deleted", name: "topic" });
    const after = Math.floor(Date.now() / 1000);
    // The ref is gone; the row holds the RECORDED sha (topic's tip, not
    // main's), the actor and a sane unix stamp.
    const names = (await env.REPO.getByName(`${OWNER}/${SLUG}`).listRefs()).refs.map((ref) => ref.name);
    expect(names).not.toContain("refs/heads/topic");
    const row = await deletedRowFor(fixture.repo, "topic");
    expect(row.commitId).toBe(fixture.tips[TOPIC_TIP]);
    expect(row.commitId).not.toBe(fixture.tips[MAIN_TIP]);
    expect(row.deletedById).toBe(fixture.ownerId);
    expect(row.deletedUnix).toBeGreaterThanOrEqual(before);
    expect(row.deletedUnix).toBeLessThanOrEqual(after);

    // THE ROUND-TRIP: the restore of the recorded id brings the ref back
    // AT THE SHA.
    expect(await applyBranchRestore(env, fixture.repo, fixture.viewer, row.id, input)).toEqual({ outcome: "restored", name: "topic" });
    const tip = (await env.REPO.getByName(`${OWNER}/${SLUG}`).listRefs()).refs.find((ref) => ref.name === "refs/heads/topic");
    expect(tip?.target).toBe(fixture.tips[TOPIC_TIP]);
    // And the restored row stops rendering (the live-ref filter — the
    // push-sync un-flag observable; the row itself survives).
    const data = await loadBranchesData(env, env.DB, fixture.repo, { page: 1, keyword: "", viewer: fixture.viewer });
    expect(data.deletedRows.map((deleted) => deleted.name)).toEqual([]);
    const survivors = await drizzle(env.DB).select({ id: deletedBranches.id }).from(deletedBranches).where(eq(deletedBranches.repoId, fixture.repo.id)).all();
    expect(survivors).toHaveLength(1);
  });

  it("the re-delete overwrites the (repo, name) row with the NEW sha (the upsert contract)", async () => {
    const input = await restoreInput(fixture.repo);
    await applyBranchDelete(env, fixture.repo, fixture.viewer, "topic", input);
    const first = await deletedRowFor(fixture.repo, "topic");
    // A plain push of the same name re-creates the ref at ANOTHER tip; the
    // next delete overwrites the row.
    const recreated = await env.REPO.getByName(`${OWNER}/${SLUG}`).commitApiChange({
      ref: "refs/heads/topic",
      expectedOldOid: ZERO_OID,
      newOid: fixture.tips[MAIN_TIP] as string,
    });
    expect(recreated.tag).toBe("committed");
    expect(await applyBranchDelete(env, fixture.repo, fixture.viewer, "topic", input)).toEqual({ outcome: "deleted", name: "topic" });
    const rows = await drizzle(env.DB)
      .select()
      .from(deletedBranches)
      .where(and(eq(deletedBranches.repoId, fixture.repo.id), eq(deletedBranches.name, "topic")))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commitId).toBe(fixture.tips[MAIN_TIP]);
    expect(rows[0]?.id).toBe(first.id); // the SAME row updated, not a second
  });

  it("restore-when-already-exists: the name re-pushed before the restore → the already_exists arm, tip untouched", async () => {
    const input = await restoreInput(fixture.repo);
    await applyBranchDelete(env, fixture.repo, fixture.viewer, "topic", input);
    const row = await deletedRowFor(fixture.repo, "topic");
    const rePushed = await env.REPO.getByName(`${OWNER}/${SLUG}`).commitApiChange({
      ref: "refs/heads/topic",
      expectedOldOid: ZERO_OID,
      newOid: fixture.tips[MAIN_TIP] as string,
    });
    expect(rePushed.tag).toBe("committed");
    // The create-on-empty CAS reads the live ref → ref_conflict → the arm.
    expect(await applyBranchRestore(env, fixture.repo, fixture.viewer, row.id, input)).toEqual({ outcome: "already-exists", name: "topic" });
    const tip = (await env.REPO.getByName(`${OWNER}/${SLUG}`).listRefs()).refs.find((ref) => ref.name === "refs/heads/topic");
    expect(tip?.target).toBe(fixture.tips[MAIN_TIP]); // the live tip stands
  });

  it("the missing arms: an unknown name deletes missing with NO row; unknown id, wrong-repo id, non-writer all restore missing", async () => {
    const input = await restoreInput(fixture.repo);
    // The unknown name: the arm's declared 404 AND no substrate row (the
    // PRE-CAS write only fires after the tip lookup).
    expect(await applyBranchDelete(env, fixture.repo, fixture.viewer, "ghost", input)).toEqual({ outcome: "missing", name: "ghost" });
    const rows = await drizzle(env.DB).select({ id: deletedBranches.id }).from(deletedBranches).where(eq(deletedBranches.repoId, fixture.repo.id)).all();
    expect(rows).toHaveLength(0);
    // A real row, then the three restore misses.
    await applyBranchDelete(env, fixture.repo, fixture.viewer, "topic", input);
    const row = await deletedRowFor(fixture.repo, "topic");
    expect(await applyBranchRestore(env, fixture.repo, fixture.viewer, 4_000_000, input)).toEqual({ outcome: "missing", branchId: 4_000_000 });
    // The WRONG repo: the other fixture with its own pair, an id from THIS one.
    const otherInput = await restoreInput(fixture.otherRepo);
    expect(await applyBranchRestore(env, fixture.otherRepo, fixture.viewer, row.id, otherInput)).toEqual({ outcome: "missing", branchId: row.id });
    // The NON-WRITER: the stranger misses (reqRepoCodeWriter's posture —
    // existence stays hidden behind the same 404 arm).
    expect(await applyBranchRestore(env, fixture.repo, fixture.stranger, row.id, input)).toEqual({ outcome: "missing", branchId: row.id });
    // The ref stays gone through the whole quartet.
    const names = (await env.REPO.getByName(`${OWNER}/${SLUG}`).listRefs()).refs.map((ref) => ref.name);
    expect(names).not.toContain("refs/heads/topic");
  });

  it("the protected-name refusal: a rule on the name folds the restore into refused-protected, the ref stays gone", async () => {
    const input = await restoreInput(fixture.repo);
    await applyBranchDelete(env, fixture.repo, fixture.viewer, "topic", input);
    const row = await deletedRowFor(fixture.repo, "topic");
    // A first-match rule on the restored name (the wave-15 block's direct
    // D1 insert shape, bare-armed) — the write seam's defense-in-depth
    // twin of the template's `{{if not .IsProtected}}` render gate.
    await drizzle(env.DB).insert(protectedBranches).values({
      repoId: fixture.repo.id,
      ruleName: "topic",
      priority: 1,
      rules: serializeRuleConfig(emptyRuleConfig()),
      createdAt: new Date(T0 * 1000),
      updatedAt: new Date(T0 * 1000),
    });
    expect(await applyBranchRestore(env, fixture.repo, fixture.viewer, row.id, input)).toEqual({ outcome: "refused-protected", name: "topic" });
    const names = (await env.REPO.getByName(`${OWNER}/${SLUG}`).listRefs()).refs.map((ref) => ref.name);
    expect(names).not.toContain("refs/heads/topic");
  });
});

// --- the loader's deleted arm + the form parse --------------------------------

describe("the loader's deleted arm (loadBranchesData) + parseBranchRestoreForm", () => {
  it("deleted rows sort deleted_unix DESC then name ASC, the keyword filter composes, and the PR row reads MergeMovedOn against the STORED sha", async () => {
    const input = await restoreInput(fixture.repo);
    // A merged PR headed at `topic` with its pull head at MAIN's tip: after
    // the delete, the pull head exists and differs from the STORED sha —
    // MergeMovedOn must be true (upstream's headCommit := dbBranch.CommitID;
    // a live-ref tip map would make the check vacuous for a deleted row).
    const pr = await new IssuesService(env.DB).createPullRequest({
      repoId: fixture.repo.id,
      title: "restore: moved-on pr",
      posterId: fixture.ownerId,
      headRepoId: fixture.repo.id,
      baseBranch: "main",
      headBranch: "topic",
    });
    await drizzle(env.DB).update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.id, pr.pullRequest.id));
    const head = await env.REPO.getByName(`${OWNER}/${SLUG}`).commitApiChange({
      ref: `refs/pull/${pr.pullRequest.index}/head`,
      expectedOldOid: ZERO_OID,
      newOid: fixture.tips[MAIN_TIP] as string,
    });
    expect(head.tag).toBe("committed");

    // Two deletes; the wall-clock stamps are pinned to fixed values (the
    // same-second tie would leave only the name tiebreak observable).
    await applyBranchDelete(env, fixture.repo, fixture.viewer, "topic", input);
    await applyBranchDelete(env, fixture.repo, fixture.viewer, "deep/feat", input);
    const topicRow = await deletedRowFor(fixture.repo, "topic");
    const featRow = await deletedRowFor(fixture.repo, "deep/feat");
    await drizzle(env.DB).update(deletedBranches).set({ deletedUnix: T0 - 100 }).where(eq(deletedBranches.id, topicRow.id));
    await drizzle(env.DB).update(deletedBranches).set({ deletedUnix: T0 - 50 }).where(eq(deletedBranches.id, featRow.id));

    // The order arm: the newer deletion first, the name tiebreak behind it.
    const data = await loadBranchesData(env, env.DB, fixture.repo, { page: 1, keyword: "", viewer: fixture.viewer });
    expect(data.rows.map((row) => row.name)).toEqual([]); // live: default excluded, the rest deleted
    expect(data.deletedRows.map((row) => row.name)).toEqual(["deep/feat", "topic"]);
    expect(data.deletedRows[1]?.deletedByName).toBe(OWNER); // the actor join
    expect(data.deletedRows[1]?.isProtected).toBe(false);
    expect(data.deletedRows[1]?.latestPr?.hasMerged).toBe(true);
    expect(data.deletedRows[1]?.latestPr?.mergeMovedOn).toBe(true);
    // The keyword arm composes over the deleted names.
    const filtered = await loadBranchesData(env, env.DB, fixture.repo, { page: 1, keyword: "TOP", viewer: fixture.viewer });
    expect(filtered.deletedRows.map((row) => row.name)).toEqual(["topic"]);
    expect(filtered.rows).toEqual([]);
  });

  it("parseBranchRestoreForm mirrors FormInt64: integers pass (negatives included — the lookup misses), junk and empties go null", () => {
    expect(parseBranchRestoreForm(new URLSearchParams("branch_id=7"))).toBe(7);
    expect(parseBranchRestoreForm(new URLSearchParams("branch_id=-3"))).toBe(-3);
    expect(parseBranchRestoreForm(new URLSearchParams("branch_id=9999999999999999999999"))).toBeNull();
    expect(parseBranchRestoreForm(new URLSearchParams("branch_id=junk"))).toBeNull();
    expect(parseBranchRestoreForm(new URLSearchParams("name=topic"))).toBeNull();
    expect(parseBranchRestoreForm(new URLSearchParams())).toBeNull();
    expect(parseBranchRestoreForm(new URLSearchParams("branch_id=7&name=x"))).toBe(7);
  });
});
