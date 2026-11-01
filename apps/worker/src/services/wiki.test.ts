/**
 * The wiki service's whole-wiki delete arm (services/wiki.ts deleteWiki —
 * upstream wiki_service.DeleteWiki, services/wiki/wiki.go:365-381, driven by
 * the settings page's `delete-wiki` danger action). Real engine content: the
 * repo seeds through the landed receive flow (testing/seed-repo.ts), the
 * pages land through the landed createWikiPage op, a PUSH-SHAPED nested tree
 * lands through the same cell primitives applyWikiChanges uses, and the
 * suite drives deleteWiki directly over real bindings —
 *
 *   - the composed sweep: three top-level pages plus a real nested
 *     `docs/deep.md` subtree (the git-pushed wiki shape — the page writer's
 *     flat codec cannot produce one) all become unreadable — the pages list
 *     empties, page reads null, and the walk's DESCENT is what reaches the
 *     nested blob — the tombstone commit "Delete wiki" lands on the branch
 *     tip, and `repo_settings.has_wiki` flips false (upstream's
 *     UpdateRepositoryUnits(…, remove TypeWiki) against our landed unit-flag
 *     reduction);
 *   - the flag-first order and best-effort posture: the reset applies even
 *     when the wiki never existed (unborn branch — no commit, no throw),
 *     the upstream flash-success shape;
 *   - history retention (the DOCUMENTED divergence from upstream's
 *     whole-repo file delete): the branch survives the sweep, so a re-enable
 *     starts from an empty tree, and a second deleteWiki run is a no-op
 *     sweep (zero paths → no commit) over the already-reset flag.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { loadRepoSettings } from "../api/services/repo-settings";
import { branchRef, refTipMap } from "../api/services/engine";
import { buildFileChangeCommit } from "../api/services/git-models";
import type { RepositoryWithOwner } from "../api/services/repository";
import { repositories, users } from "../db/schema";
import {
  createWikiPage,
  deleteWiki,
  listWikiPages,
  readWikiPage,
  wikiBranch,
  wikiCell,
  wikiReads,
  type WikiDoer,
} from "./wiki";
import { ensureSeededRepo } from "../ui/testing/seed-repo";

// --- fixtures -----------------------------------------------------------------

const ORIGIN = "https://test.local";
const DOER: WikiDoer = { name: "alice", email: "alice@noreply.test.local" };

const SEED_COMMITS = [
  {
    message: "seed: readme",
    time: 1_700_000_000,
    files: [{ path: "README.md", content: "# deletewiki seed\n" }],
  },
];

let pair: RepositoryWithOwner | null = null;

async function ensureFixtures(): Promise<RepositoryWithOwner> {
  if (pair !== null) return pair;
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "deletewiki", commits: SEED_COMMITS });
  const repoRow =
    (await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "deletewiki")))
      .get()) ?? null;
  if (repoRow === null) throw new Error("deletewiki repo row missing");
  const owner = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "alice")).get()) ?? null;
  if (owner === null) throw new Error("alice row missing");
  pair = { repo: repoRow, owner };
  return pair;
}

/**
 * Land one path into the wiki cell over the observed tip — the same
 * putApiObjects/commitApiChange primitives applyWikiChanges uses (the
 * wiki-raw smoke test's seeding posture), for shapes the page writer cannot
 * produce: a real nested `docs/deep.md` subtree, exactly what a git-pushed
 * upstream wiki carries.
 */
async function seedCellBlob(path: string, content: string): Promise<void> {
  const currentPair = await ensureFixtures();
  const reads = wikiReads(env, currentPair);
  const tips = refTipMap(await reads.listRefs());
  const tip = tips.get(branchRef(wikiBranch(currentPair)));
  if (tip === undefined) throw new Error("seedCellBlob needs a born wiki branch");
  const person = { name: DOER.name, email: DOER.email, time: 1_700_000_100, tz: "+0000" };
  const built = await buildFileChangeCommit(
    reads,
    tip.target,
    [{ operation: "create", path, content: new TextEncoder().encode(content) }],
    { message: "seed: nested fixture", author: person, committer: person },
  );
  if (built === null) throw new Error("wiki branch vanished mid-seed");
  const failed = built.outcomes.find((outcome) => !outcome.ok);
  if (failed !== undefined) throw new Error(`seed change refused: ${failed.error ?? "unknown"}`);
  const cell = wikiCell(env, currentPair);
  const stored = await cell.putApiObjects(built.objects);
  if (stored.tag !== "ok") throw new Error(`putApiObjects refused: ${stored.tag}`);
  const landed = await cell.commitApiChange({
    ref: branchRef(wikiBranch(currentPair)),
    expectedOldOid: tip.target,
    newOid: built.commitOid,
  });
  if (landed.tag !== "committed") throw new Error(`commitApiChange refused: ${landed.tag}`);
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the composed sweep --------------------------------------------------------

describe("deleteWiki (wiki_service.DeleteWiki port)", () => {
  it("sweeps every page (top-level, slash-coded, and nested), lands the tombstone commit, and resets has_wiki", async () => {
    const currentPair = await ensureFixtures();
    const encoder = new TextEncoder();
    // Three pages through the landed op…
    await createWikiPage(env, currentPair, DOER, { title: "Home", content: encoder.encode("# Home\n"), message: "" }, ORIGIN);
    await createWikiPage(env, currentPair, DOER, { title: "Second Page", content: encoder.encode("# Two\n"), message: "" }, ORIGIN);
    await createWikiPage(env, currentPair, DOER, { title: "Third", content: encoder.encode("# Three\n"), message: "" }, ORIGIN);
    // …plus a real nested subtree — the git-PUSHED wiki shape (the cell twin
    // accepts arbitrary trees; the page writer's flat codec cannot produce
    // one), the reason the sweep's walk descends.
    await seedCellBlob("docs/deep.md", "# Deep\n");

    const before = await listWikiPages(env, currentPair, 1, 30, ORIGIN);
    expect(before.pages.map((page) => page.title).sort()).toEqual(["Home", "Second Page", "Third"]);
    expect(before.totalEntries).toBe(4); // the three blobs + the docs tree (upstream counts dirs)
    expect(await readWikiPage(env, currentPair, "docs/deep", ORIGIN)).not.toBeNull();
    // The landed wiki flag starts enabled (the schema's default).
    expect((await loadRepoSettings(env.DB, currentPair.repo.id)).hasWiki).toBe(true);

    await deleteWiki(env, env.DB, currentPair, DOER);

    // The read model is empty — top-level and nested alike.
    const after = await listWikiPages(env, currentPair, 1, 30, ORIGIN);
    expect(after.pages).toEqual([]);
    expect(after.totalEntries).toBe(0);
    for (const wikiName of ["Home", "Second-Page", "Third", "docs/deep"]) {
      expect(await readWikiPage(env, currentPair, wikiName, ORIGIN)).toBeNull();
    }
    // The wiki flag reset (upstream's unit disable — wiki.go:367).
    expect((await loadRepoSettings(env.DB, currentPair.repo.id)).hasWiki).toBe(false);

    // The tombstone commit rides the branch tip (the divergence's marker:
    // history retained, tree emptied).
    const reads = wikiReads(env, currentPair);
    const tips = refTipMap(await reads.listRefs());
    const tip = tips.get(branchRef(wikiBranch(currentPair)));
    expect(tip).toBeDefined();
    const log = await reads.listLog(tip!.target, { ofs: 0, n: 1 });
    // The engine's CommitJson preserves the stored bytes: git commits end the
    // message with a newline.
    expect(log?.commits[0]?.message).toBe("Delete wiki\n");
    // The commit identity is the doer (the per-page arm's convention).
    expect(log?.commits[0]?.author.name).toBe(DOER.name);
  });

  it("resets the flag even when the wiki never existed (unborn branch — no commit, no throw)", async () => {
    const currentPair = await ensureFixtures();
    // A repo with no wiki writes: the sibling cell's default branch is unborn.
    await ensureSeededRepo({ owner: "alice", slug: "wiki-less", commits: SEED_COMMITS });
    const bare =
      (await drizzle(env.DB)
        .select()
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wiki-less")))
        .get()) ?? null;
    if (bare === null) throw new Error("wiki-less repo row missing");
    const barePair: RepositoryWithOwner = { repo: bare, owner: currentPair.owner };
    expect((await loadRepoSettings(env.DB, bare.id)).hasWiki).toBe(true);

    await expect(deleteWiki(env, env.DB, barePair, DOER)).resolves.toBeUndefined();

    expect((await loadRepoSettings(env.DB, bare.id)).hasWiki).toBe(false);
    // No branch was provisioned by the sweep (upstream's git.DeleteRepository
    // over a never-initialized wiki is the same no-op).
    const reads = wikiReads(env, barePair);
    const tips = refTipMap(await reads.listRefs());
    expect(tips.get(branchRef(wikiBranch(barePair)))).toBeUndefined();
  });

  it("a second run over a swept wiki is a no-op sweep (zero paths, no new commit, flag stays false)", async () => {
    const currentPair = await ensureFixtures();
    const reads = wikiReads(env, currentPair);
    const tipsBefore = refTipMap(await reads.listRefs());
    const tipBefore = tipsBefore.get(branchRef(wikiBranch(currentPair)));
    if (tipBefore === undefined) throw new Error("expected the swept tombstone tip");
    const logBefore = await reads.listLog(tipBefore.target, { ofs: 0, n: 1 });

    await deleteWiki(env, env.DB, currentPair, DOER);

    const tipsAfter = refTipMap(await wikiReads(env, currentPair).listRefs());
    const tipAfter = tipsAfter.get(branchRef(wikiBranch(currentPair)));
    // Zero blob paths → no commit landed; the tombstone tip stands unchanged
    // (same oid AND the same top commit — the sweep added nothing).
    expect(tipAfter?.target).toBe(tipBefore.target);
    const logAfter = await wikiReads(env, currentPair).listLog(tipBefore.target, { ofs: 0, n: 1 });
    expect(logAfter?.commits[0]?.oid).toBe(logBefore?.commits[0]?.oid);
    expect((await loadRepoSettings(env.DB, currentPair.repo.id)).hasWiki).toBe(false);
  });
});
