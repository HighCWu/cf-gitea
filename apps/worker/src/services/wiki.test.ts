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
 *
 * Two more families share the file's fixtures (both landed with the service
 * changes they pin):
 *
 *   - the SLASHED-TITLE read family (the engine-path seam): a title with a
 *     "/" ("guide/intro") stores the flat blob `guide%2Fintro.md` — the
 *     codec's QueryEscaped name, upstream's own legacy shape — and every
 *     read arm now resolves it back through the one shared encode: the
 *     create no longer 500s "vanished after create", the page/revision/
 *     raw-equivalent reads serve it, the pages list renders the decoded
 *     title, and the write arms (edit/rename/delete) round-trip. The
 *     non-ASCII title class ("页面" → "%E9%A1%B5%E9%9D%A2") is the same
 *     escape class and pinned beside it.
 *   - the AUDIT arm (upstream wiki.go:378 `audit.Record(RepositoryWikiDelete,
 *     repo)`): the row lands with the rendered message, actor = the doer's
 *     user row, repository scope (no org arm for user repos), origin ui;
 *     the emit is NOT conditional on the storage sweep (the no-op sweep of
 *     an already-emptied wiki still records), and a failed insert is
 *     caught-and-logged (upstream writeEvent's posture) — deleteWiki still
 *     resolves with the flag reset. The emitAudit import is wrapped in a
 *     delegating vi.fn (real insert by default) so the failure arm can
 *     reject exactly once without disturbing the row-shape assertions.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { ApiError } from "../api/errors";
import { loadRepoSettings } from "../api/services/repo-settings";
import { branchRef, refTipMap } from "../api/services/engine";
import { buildFileChangeCommit } from "../api/services/git-models";
import type { RepositoryWithOwner } from "../api/services/repository";
import { auditEvents, repositories, users } from "../db/schema";
import { emitAudit } from "./audit";
import {
  createWikiPage,
  deleteWiki,
  deleteWikiPage,
  editWikiPage,
  listWikiPageRevisions,
  listWikiPages,
  readWikiPage,
  wikiBranch,
  wikiCell,
  wikiReads,
  type WikiDoer,
} from "./wiki";
import { ensureSeededRepo } from "../ui/testing/seed-repo";

// emitAudit wrapped (real behavior by default) so the catch-and-log arm can
// force ONE rejection; see the module doc's audit-arm paragraph.
vi.mock("./audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./audit")>();
  return { ...actual, emitAudit: vi.fn(actual.emitAudit) };
});

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

/** Repo pair builder — one seeded repo per suite (deletewiki/slashwiki/auditwiki). */
async function seededPair(slug: string): Promise<RepositoryWithOwner> {
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug, commits: SEED_COMMITS });
  const repoRow =
    (await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, slug)))
      .get()) ?? null;
  if (repoRow === null) throw new Error(`${slug} repo row missing`);
  const owner = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "alice")).get()) ?? null;
  if (owner === null) throw new Error("alice row missing");
  return { repo: repoRow, owner };
}

let pair: RepositoryWithOwner | null = null;

async function ensureFixtures(): Promise<RepositoryWithOwner> {
  if (pair !== null) return pair;
  pair = await seededPair("deletewiki");
  return pair;
}

let slashPair: RepositoryWithOwner | null = null;

async function ensureSlashFixtures(): Promise<RepositoryWithOwner> {
  if (slashPair !== null) return slashPair;
  slashPair = await seededPair("slashwiki");
  return slashPair;
}

let auditPair: RepositoryWithOwner | null = null;

async function ensureAuditFixtures(): Promise<RepositoryWithOwner> {
  if (auditPair !== null) return auditPair;
  auditPair = await seededPair("auditwiki");
  return auditPair;
}

/** The audit rows of one repo's wiki deletes, newest first. */
async function findWikiDeleteRows(scopeId: string) {
  return drizzle(env.DB)
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, "repository:wiki:delete"), eq(auditEvents.scopeId, scopeId)))
    .orderBy(desc(auditEvents.createdUnix), desc(auditEvents.id))
    .all();
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

// --- the slashed-title read family (the engine-path seam) ---------------------

describe("slashed titles (the flat codec's engine-path seam)", () => {
  it("round-trips guide/intro through create, read, list, edit, revisions, rename and delete", async () => {
    const currentPair = await ensureSlashFixtures();
    const v1 = new TextEncoder().encode("# intro v1\n");

    // THE REGRESSION: the create used to land the flat blob and then 500
    // "wiki page vanished after create" — the read-back found nothing. It
    // resolves now, and the returned page is the read-back page.
    const created = await createWikiPage(
      env,
      currentPair,
      DOER,
      { title: "guide/intro", content: v1, message: "" },
      ORIGIN,
    );
    expect(created.title).toBe("guide/intro");
    expect(created.sub_url).toBe("guide%2Fintro"); // the WebPath, not the title
    expect(created.html_url).toBe(`${ORIGIN}/alice/slashwiki/wiki/guide%2Fintro`);
    expect(created.content_base64).toBe(btoa("# intro v1\n"));

    // The read arm (the API route resolves the raw WebPath).
    const page = await readWikiPage(env, currentPair, "guide%2Fintro", ORIGIN);
    expect(page).not.toBeNull();
    expect(page?.title).toBe("guide/intro");
    expect(page?.content_base64).toBe(btoa("# intro v1\n"));
    expect(page?.commit_count).toBe(1);
    // The last-commit row resolves through the encoded log filter (it was
    // null before the fix — the decoded filter never matched the flat name).
    expect(page?.last_commit?.message).toBe('Add "guide/intro"\n');

    // The list arm: the tree listing shows the FLAT blob name and the row
    // renders the DECODED title — symmetric.
    const list = await listWikiPages(env, currentPair, 1, 30, ORIGIN);
    expect(list.pages.map((entry) => entry.title)).toEqual(["guide/intro"]);
    expect(list.totalEntries).toBe(1);
    expect(list.pages[0]?.sub_url).toBe("guide%2Fintro");
    expect(list.pages[0]?.last_commit?.message).toBe('Add "guide/intro"\n');

    // The edit arm (in-place) — content replaced, revision count grows.
    const v2 = new TextEncoder().encode("# intro v2\n");
    const edited = await editWikiPage(env, currentPair, DOER, "guide%2Fintro", { content: v2, message: "", title: "" }, ORIGIN);
    expect(edited.title).toBe("guide/intro");
    expect(edited.content_base64).toBe(btoa("# intro v2\n"));
    expect(edited.commit_count).toBe(2);

    // The revisions arm — newest first, both messages the exact templates.
    const revisions = await listWikiPageRevisions(env, currentPair, "guide%2Fintro", 1);
    expect(revisions).not.toBeNull();
    expect(revisions?.count).toBe(2);
    expect(revisions?.commits.map((commit) => commit.message)).toEqual([
      'Update "guide%2Fintro"\n',
      'Add "guide/intro"\n',
    ]);

    // The rename arm: the flat blob moves (write seam, literal names) to a
    // plain title's name; the old WebPath goes not-found, the new serves.
    const renamed = await editWikiPage(
      env,
      currentPair,
      DOER,
      "guide%2Fintro",
      { content: v2, message: "", title: "renamed guide" },
      ORIGIN,
    );
    expect(renamed.title).toBe("renamed guide");
    const renamedPage = await readWikiPage(env, currentPair, "renamed-guide", ORIGIN);
    expect(renamedPage?.title).toBe("renamed guide");
    expect(await readWikiPage(env, currentPair, "guide%2Fintro", ORIGIN)).toBeNull();

    // The delete arm — present-page delete lands; a second delete on the
    // vanished name is the 404 class.
    await deleteWikiPage(env, currentPair, DOER, "renamed-guide");
    expect(await readWikiPage(env, currentPair, "renamed-guide", ORIGIN)).toBeNull();
    const boom = await deleteWikiPage(env, currentPair, DOER, "guide%2Fintro").catch((error: unknown) => error);
    expect(boom).toBeInstanceOf(ApiError);
    expect((boom as ApiError).status).toBe(404);
  });

  it("a non-ASCII title (the same escape class) round-trips: 页面 stores %E9%A1%B5%E9%9D%A2 and reads back", async () => {
    const currentPair = await ensureSlashFixtures();
    const created = await createWikiPage(
      env,
      currentPair,
      DOER,
      { title: "页面", content: new TextEncoder().encode("# han\n"), message: "" },
      ORIGIN,
    );
    expect(created.title).toBe("页面");
    // The read through the coded WebPath (what the route resolves)…
    const page = await readWikiPage(env, currentPair, "%E9%A1%B5%E9%9D%A2", ORIGIN);
    expect(page?.title).toBe("页面");
    expect(page?.content_base64).toBe(btoa("# han\n"));
    // …and the list's decoded rendering.
    const list = await listWikiPages(env, currentPair, 1, 30, ORIGIN);
    expect(list.pages.map((entry) => entry.title).sort()).toEqual(["页面"]);
  });
});

// --- the delete-wiki audit arm (RepositoryWikiDelete, wiki.go:378) ------------

describe("deleteWiki's audit arm (RepositoryWikiDelete)", () => {
  it("writes the row with the rendered message — actor the doer, repository scope, origin ui — even on a no-op sweep", async () => {
    const currentPair = await ensureFixtures();
    const alice =
      (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "alice")).get()) ?? null;
    if (alice === null) throw new Error("alice row missing");

    // The deletewiki repo is already swept (empty tree, flag false): the
    // run below is a no-op sweep — the row still records (upstream's Record
    // is DeleteWiki's final statement, unconditional on the storage arm).
    const rowsBefore = await findWikiDeleteRows(currentPair.repo.id);
    await deleteWiki(env, env.DB, currentPair, DOER);
    const rowsAfter = await findWikiDeleteRows(currentPair.repo.id);
    expect(rowsAfter.length).toBe(rowsBefore.length + 1);

    const row = rowsAfter[0];
    if (row === undefined) throw new Error("expected the fresh wiki-delete audit row");
    expect(row.action).toBe("repository:wiki:delete");
    expect(row.message).toBe("Deleted wiki of repository alice/deletewiki.");
    expect(row.actorId).toBe(alice.id);
    expect(row.actorName).toBe("alice");
    expect(row.actorCredential).toBeNull();
    expect(row.impersonatorId).toBe(0);
    expect(row.scopeType).toBe("repository");
    expect(row.scopeId).toBe(currentPair.repo.id);
    expect(row.scopeName).toBe("alice/deletewiki");
    expect(row.origin).toBe("ui");
    expect(row.metadata).toBeNull();

    // The emit input rode the seam with the rendered vars (the mock wraps
    // the real insert, so calls are observable without changing behavior).
    const emitted = vi.mocked(emitAudit).mock.calls.map((call) => call[1]).at(-1);
    expect(emitted?.action).toBe("repository:wiki:delete");
    expect(emitted?.vars).toEqual({ scope: "alice/deletewiki" });
  });

  it("a failed audit insert is caught-and-logged — deleteWiki still resolves with the flag reset", async () => {
    const currentPair = await ensureAuditFixtures();
    expect((await loadRepoSettings(env.DB, currentPair.repo.id)).hasWiki).toBe(true);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.mocked(emitAudit).mockRejectedValueOnce(new Error("d1 down"));
      await expect(deleteWiki(env, env.DB, currentPair, DOER)).resolves.toBeUndefined();
      // The failure was logged by the AUDIT arm's own catch (the "[audit]
      // wiki-delete row failed" prefix) — not the sweep's: the emit sits
      // OUTSIDE the sweep's try/catch (upstream's Record is DeleteWiki's
      // final statement, wiki.go:378; writeEvent's InsertEvent arm logs,
      // event.go:138-141). Asserted before mockRestore — restoring clears
      // the captured calls.
      expect(errorSpy.mock.calls.some((call) => String(call[0]).includes("[audit] wiki-delete row failed"))).toBe(
        true,
      );
    } finally {
      errorSpy.mockRestore();
    }
    // Step 1 landed (the flag reset is NOT rolled back by the audit failure
    // — upstream's UpdateRepositoryUnits either), no throw.
    expect((await loadRepoSettings(env.DB, currentPair.repo.id)).hasWiki).toBe(false);
    expect(await findWikiDeleteRows(currentPair.repo.id)).toHaveLength(0);
  });
});
