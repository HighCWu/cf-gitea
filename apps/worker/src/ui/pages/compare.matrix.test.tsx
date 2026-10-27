/**
 * The compare page's DEFERRED route-level matrix (pages/compare.tsx —
 * `GET+POST /{owner}/{repo}/compare[/{base}...{head}]` mounted at wave 13,
 * plus window-2e's .diff/.patch feed branch inside comparePage — NOT
 * re-pinned here; compare-feeds.test.tsx owns the feed contract). The base
 * arms belong to ui/__tests__/pages-wave13.test.ts (the parser claims incl.
 * the `..`/fork/junk nulls, the writer and anonymous renders over a PUBLIC
 * repo, the existing-PR segment, the degenerate GET pairs, the bad-ref
 * 404s, the bare URL's default...default, the POST
 * create/duplicate/degenerate arms, the anonymous-303 / non-writer-404 /
 * cross-origin-403 write gates and the empty-title re-render's kept body)
 * and to the committed goldens (compare-form/has-pr/nothing/commits.html).
 * THIS FILE adds only the arms that fixture posture cannot render, driven
 * over the mounted uiRouter on the branches.matrix minted-session pattern
 * (the execution context is awaited, so the create POST's inline
 * delivery-row half settles before the assertions) with a disjoint `w105*`
 * fixture family seeded through the REAL receive flow:
 *
 *   - the viewer gates on a PRIVATE repo (wave-13's fixtures are all
 *     public): anonymous and signed-in-stranger 404 shells on the GET — and
 *     on the POST, where a public repo would 303 onto /login (wave-13's
 *     arm): the invisible repo's existence stays hidden instead of leaking
 *     through the redirect; plus the signed-in OWNER's 200 render with the
 *     inline writer form;
 *   - the archived arms (route level): the owner's comparison renders
 *     read-only — the code-flavored head, the archived warning, no form —
 *     while the create POST 404-shells (the writer gate's archived half)
 *     and writes nothing;
 *   - the default-fallback LOAD arms (wave-13 pins the parser's null sides
 *     and the bare URL only): `/compare/{base}...` resolves the head to the
 *     default (main...main — the nothing arm, with the switch link carrying
 *     the resolved pair), `/compare/...{head}` and the single-ref
 *     `/compare/{head}` resolve the base to the default and the no-JS form
 *     posts to the RESOLVED pair URL (the round-trip re-parses to the same
 *     comparison); a D1 default naming no ref 404-shells the bare URL (the
 *     unresolvable-side arm — upstream parity: the branches list page's
 *     first-branch fallback is a list refinement, not a compare one) while
 *     explicit sides still resolve;
 *   - the tag-as-BASE arm (wave-13 pins tag-as-head only): comparable, so
 *     the commits table and the diff box render, but allowCreatePull's
 *     IsBranch pair folds the form for the signed-in writer and the POST
 *     refuses with the have-tag message;
 *   - the ?page clamp on this route (wave-13 pins only ?page=9 → 200):
 *     junk renders page 1's rows with no pagination, while a beyond-range
 *     page renders the empty table with the Newer link whose href is the
 *     compare URL itself (CommitsPagination's basePath = compareLink);
 *   - the form re-render + create ROUND TRIP with carried values: the
 *     empty-title refusal re-renders with the submitted empty title AND the
 *     kept body and writes nothing; the retried POST 303s onto the created
 *     PR (rows + cached headSha + the refs/pull/N/head CAS write), and the
 *     same compare URL then arms to the existing-PR segment — form gone;
 *   - the claim pin (route level): the `..` two-dot family and the
 *     `{owner}/{repo}:{head}` fork forms stay engine-owned — wave-13 pins
 *     the parser nulls; this pins the mounted consequence (the 404 shells
 *     on GET and POST) so the documented divergence cannot silently flip.
 *   - (wave-129 matrix-4) the cross-branch edges: the EMPTY-DIFF arm (a
 *     head-at-merge-base pair folds into upstream's nothingToCompare state —
 *     compare.go:397-405 headCommitID == ci.CompareBase — the segment plus
 *     the folded diff box rendering, the create form surviving through the
 *     AllowEmptyPr gate (compare.tmpl:173) with the same-ref control arm
 *     folding it; the ORIGINALLY pinned landed shape folded only at same-tip
 *     and rendered the bare empty diff beside the live form — the divergence
 *     this arm's flip ported), the ELLIPSIS direction (base...head diffs the
 *     head side, pinned through the sha pair's order + the hunk headers),
 *     and the across-fork colon form staying engine-owned even with both
 *     repos and branches present.
 */

import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { findPullRequestByIndex } from "../../api/services/pulls";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { pullRequests, repositories, users } from "../../db/schema";
import { settleCreatingRepo } from "../../git-http/gate";
import { RepoService } from "../../repos/service";
import { parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import type { UiManifest } from "../manifest";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";

// wave-129 full-run contention budget: this file's beforeAll seeding (the
// receive-flow w105* fixture family) measured a 4.51s hook share of the 30s
// default IN a green 8-worker full run (the suite's 260-isolate spawn storm
// spikes closures up to ~12x their solo time). File-local 90s budgets;
// vitest.config.ts keeps 30s for every other file. Membership: the measured
// >=4s in-run closure/hook set (full-suite junit run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// --- the minted-session route harness (the branches.matrix pattern) --------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → resolveUiRequest →
 *  loadCompareData / createPullFromForm → render, on the mounted uiRouter
 *  with the synthetic manifest; the execution context is awaited so
 *  waitUntil side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie for the fixture user (the value is never
 *  asserted — minted per call like the branches.matrix helper). */
async function cookieFor(username: string): Promise<string> {
  const user = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, username)).get();
  if (user === undefined) throw new Error(`w105 fixture user missing: ${username}`);
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, user.id)}`;
}

/** Anonymous GET (cookie omitted) or a minted-session GET. */
async function get(path: string, as?: string): Promise<Response> {
  return fetchUi(path, as === undefined ? undefined : { headers: { cookie: await cookieFor(as) } });
}

const formPost = (path: string, body: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: ORIGIN,
    ...(cookie === undefined ? {} : { cookie }),
  },
  body: new URLSearchParams(Object.entries(body)).toString(),
});

/** The open-PR row count for one fixture repo (the "nothing was written"
 *  half of every refusal arm). */
async function prRowCount(slug: string): Promise<number> {
  const row = (
    await drizzle(env.DB)
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, slug)))
      .get()
  )!;
  return (await drizzle(env.DB).select({ id: pullRequests.id }).from(pullRequests).where(eq(pullRequests.baseRepoId, row.id)).all())
    .length;
}

// --- fixtures -------------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — fixed, deterministic oids

const OWNER = "w105gal";
const STRANGER = "w105pal";

/** Four fixed commits: tips[0] root, tips[1] main's tip, tips[2] one ahead
 *  (feature/docs — the round-trip pair), tips[3] one ahead (feature/deep —
 *  the fallback/clamp arms' pair, PR-less so its arms stay order-free). */
const W105_COMMITS: SeedCommit[] = [
  { message: "w105: seed root", time: T0, files: [{ path: "f0.txt", content: "root\n" }] },
  { message: "w105: main tip", time: T0 + 60, files: [{ path: "f1.txt", content: "one\n" }] },
  { message: "w105: docs change", time: T0 + 120, files: [{ path: "f2.txt", content: "two\n" }] },
  { message: "w105: deep change", time: T0 + 180, files: [{ path: "f3.txt", content: "three\n" }] },
];

const MAIN_TIP = 1;
const DOCS_TIP = 2;
const DEEP_TIP = 3;

let w105Tips: string[] = [];

/** Idempotent repo seed (the branches.matrix recipe over this module's ref
 *  set): token mint, ONE multi-ref push (heads + the lightweight tag) when
 *  the cell is unborn, the D1 row create-or-settle, then the visibility /
 *  defaultBranch / isArchived pins. */
async function ensureRepo(
  slug: string,
  refs: { ref: string; tipIndex: number }[],
  tips: string[],
  pack: Uint8Array,
  options: { defaultBranch: string; isPrivate?: boolean; isArchived?: boolean },
): Promise<void> {
  const db = drizzle(env.DB);
  const repoName = `${OWNER}/${slug}`;
  const owner = (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get())!;

  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner.id, `w105-seed-${slug}`)
    .run();
  const token = (await mintFor(owner.id, `w105-seed-${slug}`, "write:repository")).plaintext;

  const engineRefs = await env.REPO.getByName(repoName).listRefs();
  if (engineRefs.head === null) {
    const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
      body: buildReceivePackBody(
        refs.map((entry) => ({ ref: entry.ref, oid: tips[entry.tipIndex] as string })),
        pack,
      ),
    });
    const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    if (response.status !== 200 || responseBody.includes("ng ")) {
      throw new Error(`w105 seed push failed (${slug}): ${response.status} ${responseBody.slice(0, 400)}`);
    }
  }

  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, slug)))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: owner.id, usernameLower: OWNER },
      name: slug,
      isPrivate: options.isPrivate === true,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, row.id, repoName);
    row = (await db.select().from(repositories).where(eq(repositories.id, row.id)).get()) ?? row;
  }
  const wantVisibility = options.isPrivate === true ? "private" : "public";
  if (row.visibility !== wantVisibility) {
    await db.update(repositories).set({ visibility: wantVisibility }).where(eq(repositories.id, row.id));
  }
  if (row.defaultBranch !== options.defaultBranch) {
    await db.update(repositories).set({ defaultBranch: options.defaultBranch }).where(eq(repositories.id, row.id));
  }
  if (row.isArchived !== (options.isArchived === true)) {
    await db.update(repositories).set({ isArchived: options.isArchived === true }).where(eq(repositories.id, row.id));
  }
}

async function ensureFixtures(): Promise<void> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);

  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get()) === undefined) {
    await seedVerifiedUser({ username: OWNER });
  }
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, STRANGER)).get()) === undefined) {
    await seedVerifiedUser({ username: STRANGER });
  }

  const { tips, pack } = await buildHistoryPack(W105_COMMITS);
  w105Tips = tips;

  const BASE_REFS = [
    { ref: "refs/heads/main", tipIndex: MAIN_TIP },
    { ref: "refs/heads/feature/docs", tipIndex: DOCS_TIP },
    { ref: "refs/heads/feature/deep", tipIndex: DEEP_TIP },
    { ref: "refs/tags/v1", tipIndex: MAIN_TIP }, // the tag sits AT main's tip
  ];

  // The main public repo (the fallback/clamp/round-trip arms).
  await ensureRepo("w105cmp", BASE_REFS, tips, pack, { defaultBranch: "main" });
  // The private repo (the gate arms need no rows).
  await ensureRepo("w105priv", BASE_REFS, tips, pack, { defaultBranch: "main", isPrivate: true });
  // The archived repo (the CanContentChange arms over a comparable pair).
  await ensureRepo("w105arch", BASE_REFS, tips, pack, { defaultBranch: "main", isArchived: true });
  // The ghost-default repo: the D1 default names no ref (the §4.9-adjacent
  // unresolvable-default arm — the bare URL must 404, explicit sides work).
  await ensureRepo("w105ghost", BASE_REFS, tips, pack, { defaultBranch: "ghost" });
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the claim pin (route level) ---------------------------------------------------

describe("w105 claim pin (the engine-owned compare tails)", () => {
  it("404-shells the two-dot family and the fork form on GET and POST alike", async () => {
    // wave-13 pins the parser nulls; this pins the mounted consequence: the
    // two-dot DirectComparison family and the cross-repo fork forms are a
    // DOCUMENTED divergence (not a landed surface — SPEC-0008's slice), so
    // the routes must keep answering the 404 shell, never a render.
    expect(parseUiRoute(`/${OWNER}/w105cmp/compare/main..feature/deep`)).toBeNull();
    expect((await get(`/${OWNER}/w105cmp/compare/main..feature/deep`)).status).toBe(404);
    expect((await get(`/${OWNER}/w105cmp/compare/main...${OWNER}/w105cmp:feature/deep`)).status).toBe(404);
    // The POST family answers the unclaimed tail with the same shell (the
    // form can never be pointed at a two-dot URL, even by hand).
    const post = await fetchUi(
      `/${OWNER}/w105cmp/compare/main..feature/deep`,
      formPost(`/${OWNER}/w105cmp/compare/main..feature/deep`, { title: "Nope" }, await cookieFor(OWNER)),
    );
    expect(post.status).toBe(404);
    expect(await prRowCount("w105cmp")).toBe(0);
  });
});

// --- the viewer gates (the private-repo arms) --------------------------------------

describe("w105 viewer gates (the private-repo arms)", () => {
  it("404-shells the private repo's compare for anonymous and stranger sessions, GET and POST alike", async () => {
    const pairPath = `/${OWNER}/w105priv/compare/main...feature/docs`;
    // The GET: no read grant → the §2.5 shell, existence hidden. A session
    // buys no visibility (the branches matrix's arm, on this family).
    expect((await get(pairPath)).status).toBe(404);
    expect((await get(pairPath, STRANGER)).status).toBe(404);
    // The write: a public repo's anonymous POST 303s onto /login (wave-13's
    // gate arm); here the repo resolves first and never exists for the
    // viewer — no login redirect may leak the row's existence.
    const anonPost = await fetchUi(pairPath, formPost(pairPath, { title: "Nope" }));
    expect(anonPost.status).toBe(404);
    const strangerPost = await fetchUi(pairPath, formPost(pairPath, { title: "Nope" }, await cookieFor(STRANGER)));
    expect(strangerPost.status).toBe(404);
    // The refusals wrote nothing.
    expect(await prRowCount("w105priv")).toBe(0);
  });

  it("renders the signed-in owner's private compare with the inline writer form", async () => {
    const res = await get(`/${OWNER}/w105priv/compare/main...feature/docs`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The pull-flavored head rides the loaded grant over the private row.
    expect(html).toContain("page-content repository diff compare pull");
    expect(html).toContain("Comparing changes");
    expect(html).toContain(`action="/${OWNER}/w105priv/compare/main...feature/docs" method="post"`);
    expect(html).toContain("New Pull Request");
  });
});

// --- the archived arms (the CanContentChange route half) ----------------------------

describe("w105 archived arms (the read-only comparison)", () => {
  it("renders the owner's comparison read-only: the warning, no form, the code-flavored head", async () => {
    const res = await get(`/${OWNER}/w105arch/compare/main...feature/docs`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Signed in over a comparable branch pair, yet PageIsComparePull folds
    // (repo.isArchived): the pull-flavored head and the form never render.
    expect(html).toContain("Compare commits");
    expect(html).not.toContain("New Pull Request");
    expect(html).not.toContain('id="new-issue"');
    // The archived warning rides the state arms (comparable, no existing PR).
    expect(html).toContain("This repo is archived.");
    // The read surfaces stay: the commits table and the diff box.
    expect(html).toContain("1 Commits");
    expect(html).toContain('id="diff-file-boxes"');
  });

  it("404-shells the archived repo's create POST for the owner — nothing written, the ref intact", async () => {
    const pairPath = `/${OWNER}/w105arch/compare/main...feature/docs`;
    const res = await fetchUi(pairPath, formPost(pairPath, { title: "Nope" }, await cookieFor(OWNER)));
    expect(res.status).toBe(404);
    expect(await prRowCount("w105arch")).toBe(0);
    const refNames = (await env.REPO.getByName(`${OWNER}/w105arch`).listRefs()).refs.map((ref) => ref.name);
    expect(refNames).toContain("refs/heads/feature/docs");
    expect(refNames).not.toContain("refs/pull/1/head");
  });
});

// --- the default-fallback LOAD arms -------------------------------------------------

describe("w105 default-fallback arms (the load half of the null sides)", () => {
  it("resolves the empty head tail to the default: main...main renders the nothing arm", async () => {
    // wave-13 pins `/compare/main...` at the parser only (head: null); here
    // the load: headName falls to the default (main) — the pair is
    // main...main, comparable folds, and the switch link carries the
    // RESOLVED pair (the emitted URL always re-parses to the same pair).
    const res = await get(`/${OWNER}/w105cmp/compare/main...`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("There are no differences to show. There is no need to create a pull request.");
    expect(html).toContain(">base: <strong>w105gal/w105cmp:main</strong>");
    expect(html).toContain(">compare: <strong>w105gal/w105cmp:main</strong>");
    expect(html).toContain(`href="/${OWNER}/w105cmp/compare/main...main"`);
    expect(html).not.toContain('id="new-issue"');
  });

  it("resolves the empty base tail and the single-ref form to the default; the form posts to the resolved pair", async () => {
    for (const tail of ["...feature/deep", "feature/deep"]) {
      const res = await get(`/${OWNER}/w105cmp/compare/${tail}`, OWNER);
      expect(res.status, tail).toBe(200);
      const html = await res.text();
      // The load falls back to the default base (main): the comparable view
      // renders — and the no-JS form's action is the RESOLVED pair URL, not
      // the submitted shorthand, so the POST re-parses to the same
      // comparison (compareLink's invariant).
      expect(html, tail).toContain(`action="/${OWNER}/w105cmp/compare/main...feature/deep" method="post"`);
      expect(html, tail).toContain("New Pull Request");
      // feature/deep rides the linear chain: two commits ahead of main
      // (docs + deep), the range's count header reflects both.
      expect(html, tail).toContain("2 Commits");
      expect(html, tail).toContain(">merge into: <strong>w105gal/w105cmp:main</strong>");
      expect(html, tail).toContain(">pull from: <strong>w105gal/w105cmp:feature/deep</strong>");
    }
  });

  it("404-shells the bare compare when the D1 default names no ref; explicit sides still resolve", async () => {
    // The IfZero fallback uses the RAW default name: "ghost" resolves to no
    // branch/tag/oid — the unresolvable-side 404 (upstream parity; the
    // branches page's first-branch fallback is a list-page refinement).
    expect((await get(`/${OWNER}/w105ghost/compare`)).status).toBe(404);
    expect((await get(`/${OWNER}/w105ghost/compare/...feature/docs`)).status).toBe(404);
    // An explicit pair bypasses the fallback entirely.
    expect((await get(`/${OWNER}/w105ghost/compare/main...feature/docs`)).status).toBe(200);
  });
});

// --- the tag-as-BASE arm -------------------------------------------------------------

describe("w105 tag-as-base arm (the IsBranch pair)", () => {
  it("renders the comparable tag...branch pair read-only and refuses its POST with the have-tag message", async () => {
    const pairPath = `/${OWNER}/w105cmp/compare/v1...feature/docs`;
    // v1 sits at main's tip: comparable (the commits table + the diff box
    // render), but the base is not a branch — allowCreatePull folds, so
    // PageIsComparePull folds for the signed-in writer too (wave-13 pins
    // the tag-as-HEAD mirror only).
    const res = await get(pairPath, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Compare commits");
    expect(html).not.toContain("New Pull Request");
    expect(html).toContain("1 Commits");
    expect(html).toContain('id="diff-file-boxes"');
    // The POST never creates (parseCompareInfo's branch-pair arm).
    const post = await fetchUi(pairPath, formPost(pairPath, { title: "Tagged" }, await cookieFor(OWNER)));
    expect(post.status).toBe(200);
    expect(await post.text()).toContain("There are no differences to show between the selected branches or tags.");
    expect(await prRowCount("w105cmp")).toBe(0);
  });
});

// --- the ?page clamp -----------------------------------------------------------------

describe("w105 ?page clamp (parsePageNumber on this route)", () => {
  it("renders page 1's rows for junk pages and the empty table + Newer for a beyond-range page", async () => {
    // wave-13 pins ?page=9 → 200 only; the clamp's two halves: junk renders
    // page 1 (the commit row present, no pagination at all)…
    const junk = await get(`/${OWNER}/w105cmp/compare/main...feature/deep?page=junk`, OWNER);
    expect(junk.status).toBe(200);
    const junkHtml = await junk.text();
    expect(junkHtml).toContain("w105: deep change</a>");
    expect(junkHtml).not.toContain("navigation_label");
    // …while a beyond-range page renders the empty table with the Newer
    // link whose href is the compare URL itself (CommitsPagination's
    // basePath = compareLink — the pagination shape on this family).
    const paged = await get(`/${OWNER}/w105cmp/compare/main...feature/deep?page=2`, OWNER);
    expect(paged.status).toBe(200);
    const pagedHtml = await paged.text();
    expect(pagedHtml).not.toContain("w105: deep change</a>");
    expect(pagedHtml).toContain(`class="item navigation" href="/${OWNER}/w105cmp/compare/main...feature/deep"`);
    expect(pagedHtml).toContain(">Newer</span>");
  });
});

// --- the cross-branch edges (wave-129 matrix-4) --------------------------------------
// The range direction + the nothingToCompare fold over the deep pair
// (feature/deep is TWO commits ahead of main, so its reverse is the fold
// shape):
//
//   - the EMPTY-DIFF arm (FIX-provenance): a pair whose head sits BEHIND the
//     base (head == merge-base) folds the whole comparison into upstream's
//     nothingToCompare state (compare.go:397-405 — headCommitID ==
//     ci.CompareBase, the merge base per services/git/compare.go:83-88; the
//     equal-tips case subsumes — the merge-base of equal tips is that tip):
//     the segment renders (the and_allow_empty_pr text — AllowEmptyPr holds:
//     supportEmptyPr = !AutodetectManualMerge is unlanded config → true,
//     acrossRepoPr = !IsSameRef → the resolved names differ) and the diff
//     box stays folded (compare.tmpl:171's `$showDiffBox`), while the
//     create form SURVIVES through the AllowEmptyPr gate (compare.tmpl:173's
//     `or $.AllowEmptyPr`). The same-ref CONTROL (main...main — IsSameRef
//     holds) keeps the plain text and folds the form. The ORIGINALLY pinned
//     landed shape folded only at same tip and rendered the bare empty diff
//     beside the live form with no segment — the divergence this flip
//     ported.
//   - the ELLIPSIS direction: base...head diffs the HEAD side —
//     readDiff(headTip, mergeBase) (the three-dot composition,
//     prepareCompareDiff's BeforeCommitID = ci.CompareBase / AfterCommitID =
//     headCommitID, compare.go:405-407) — pinned through the sha pair's
//     order and the head-side file boxes.
//   - the ACROSS-FORK colon form: `{owner}/{repo}:{ref}` sides stay
//     unclaimed even when both repos and branches exist (w105cmp and the
//     public w105ghost carry IDENTICAL branch universes — a 404 here is
//     structural, not fixture-missing).

describe("w105 cross-branch edges (the empty range, the direction, the fork form)", () => {
  it("the empty-diff arm: a head-at-merge-base pair folds into the nothing segment, the form surviving via AllowEmptyPr", async () => {
    // feature/deep...main: the merge base IS main's tip and the head adds
    // nothing — upstream's nothingToCompare fold (compare.go:397-405,
    // headCommitID == ci.CompareBase), ported at wave-129 (the originally
    // pinned landed shape folded only at same tip and rendered the bare
    // empty diff beside the live form with no segment — the disclosed
    // divergence above).
    const res = await get(`/${OWNER}/w105cmp/compare/feature/deep...main`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The pull-flavored head stays: upstream's allowCreatePull folds only at
    // CompareBase == "" (compare.go:305-306) and ours adds only the
    // equal-tips case (wave-13 pins that shape code-flavored).
    expect(html).toContain("Comparing changes");
    // The nothing segment renders — the AllowEmptyPr arm's text: the
    // resolved ref names differ, so acrossRepoPr holds (supportEmptyPr rides
    // the unlanded autodetect-manual-merge config as true).
    expect(html).toContain("These branches are equal. This PR will be empty.");
    expect(html).not.toContain("There are no differences to show");
    // The diff box folds: no commits table, no file boxes, no stats.
    expect(html).not.toContain('id="diff-file-boxes"');
    expect(html).not.toContain('class="ui top attached header flex-left-right"');
    expect(html).not.toContain("changed files");
    // The writer form survives the fold through AllowEmptyPr (compare.tmpl:
    // 173's `or $.AllowEmptyPr` — upstream renders the form on this shape
    // exactly when AllowEmptyPr holds).
    expect(html).toContain(`action="/${OWNER}/w105cmp/compare/feature/deep...main" method="post"`);
    expect(html).toContain("New Pull Request");
  });

  it("the AllowEmptyPr same-ref control: main...main keeps the plain text and folds the form", async () => {
    // IsSameRef (services/git/compare.go:41-43 — same repository AND the
    // same resolved ref) folds acrossRepoPr, so AllowEmptyPr is false and
    // compare.tmpl:173's or-arm fails: the plain nothing_to_compare text,
    // NO form. (The default-fallback arm above drives this shape through the
    // parser's empty-head default; this pins it spelled out as the
    // AllowEmptyPr-false half of the fold.)
    const res = await get(`/${OWNER}/w105cmp/compare/main...main`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("There are no differences to show. There is no need to create a pull request.");
    expect(html).not.toContain("These branches are equal");
    expect(html).not.toContain('id="new-issue"');
    expect(html).not.toContain("New Pull Request");
    expect(html).not.toContain('id="diff-file-boxes"');
  });

  it("the ellipsis direction: base...head shows the HEAD side's commits and additions", async () => {
    const mainTip = w105Tips[MAIN_TIP];
    const deepTip = w105Tips[DEEP_TIP];
    if (mainTip === undefined || deepTip === undefined) throw new Error("w105 seed: tips missing");
    const res = await get(`/${OWNER}/w105cmp/compare/main...feature/deep`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The header's sha pair runs base (main) → separator → head (deep): the
    // main-tip link exists ONLY in that pair. The choose-branch segment
    // carries its own separator earlier in the page, so the separator
    // ORDER is asserted from the base link onward (the commits-table pair).
    const baseAt = html.indexOf(`href="/${OWNER}/w105cmp/commit/${mainTip}"`);
    const separatorAt = html.indexOf('<div class="compare-separator">...</div>', baseAt);
    const headAt = html.indexOf(`href="/${OWNER}/w105cmp/commit/${deepTip}"`);
    expect(baseAt).toBeGreaterThanOrEqual(0);
    expect(baseAt).toBeLessThan(separatorAt);
    expect(separatorAt).toBeLessThan(headAt);
    // The range's file boxes are the HEAD side's delta going base→head:
    // f1.txt (on base, not on head) DELETES with the -1,1 +0,0 hunk; f3.txt
    // ADDS with the -0,0 +1,1 hunk. An inverted (base-side) diff would carry
    // the mirrored hunks.
    expect(html).toContain('data-new-filename="f3.txt"');
    expect(html).toContain('data-old-filename="f1.txt"');
    expect(html).toContain("<code class=\"code-inner\">@@ -1,1 +0,0 @@</code>");
    expect(html).toContain("<code class=\"code-inner\">@@ -0,0 +1,1 @@</code>");
    expect(html).toContain("1 additions");
    expect(html).toContain("1 deletions");
    expect(html).toContain("2 changed files");
    // The switch link carries the reversed pair (the emitted URL re-parses
    // to the swapped comparison — compareLink's invariant).
    expect(html).toContain(`href="/${OWNER}/w105cmp/compare/feature/deep...main"`);
    expect(html).toContain("Switch head and base");
    expect(html).not.toContain("View Pull Request"); // no PR on this pair
  });

  it("the across-fork colon form stays engine-owned even with both repos and branches present", async () => {
    // w105ghost is public and carries the SAME branch universe — the colon
    // side cannot fall back to "the fixture does not exist": the parse
    // nulls the fork form (wave-13's claim), the router hands the tail to
    // the engine, and the engine answers its plain-text 404 (never a UI
    // render).
    const headSide = await get(`/${OWNER}/w105cmp/compare/main...${OWNER}/w105ghost:feature/docs`);
    expect(headSide.status).toBe(404);
    expect(await headSide.text()).toContain("404 Not Found");
    const baseSide = await get(`/${OWNER}/w105cmp/compare/${OWNER}/w105ghost:main...feature/docs`);
    expect(baseSide.status).toBe(404);
    expect(await baseSide.text()).toContain("404 Not Found");
  });
});

// --- the form re-render + create round trip ------------------------------------------

describe("w105 form re-render + PR-create round trip (carried values)", () => {
  it("re-renders the empty-title refusal with the submitted values carried and writes nothing", async () => {
    const pairPath = `/${OWNER}/w105cmp/compare/main...feature/docs`;
    const res = await fetchUi(
      pairPath,
      formPost(pairPath, { title: "", content: "w105: the kept body" }, await cookieFor(OWNER)),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("A title is required.");
    // The submitted values ride the re-render (the login failure
    // convention): the EMPTY title in the input…
    expect(html).toContain('placeholder="Title" value=""/>');
    // …and the kept body in the textarea (wave-13 pins the kept body on the
    // reverse pair; this pins the empty-title input's carried arm beside it).
    expect(html).toContain(">w105: the kept body</textarea>");
    // The refusal wrote nothing (the title check precedes the create).
    expect(await prRowCount("w105cmp")).toBe(0);
  });

  it("creates on the retried POST, lands the head ref, and the compare URL arms to the has-PR segment", async () => {
    const pairPath = `/${OWNER}/w105cmp/compare/main...feature/docs`;
    const res = await fetchUi(
      pairPath,
      formPost(pairPath, { title: "w105: the round-trip pr", content: "second body" }, await cookieFor(OWNER)),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OWNER}/w105cmp/pulls/1`);

    // The rows: the issue + the PR row with the cached head tip.
    const docsTip = w105Tips[DOCS_TIP];
    if (docsTip === undefined) throw new Error("w105 seed: docs tip missing");
    const repoRow = (
      await drizzle(env.DB)
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, "w105cmp")))
        .get()
    )!;
    const joined = await findPullRequestByIndex(env.DB, repoRow.id, 1);
    expect(joined).not.toBeNull();
    expect(joined?.issue.title).toBe("w105: the round-trip pr");
    expect(joined?.issue.content).toBe("second body");
    expect(joined?.pullRequest.headBranch).toBe("feature/docs");
    expect(joined?.pullRequest.baseBranch).toBe("main");
    expect(joined?.pullRequest.headSha).toBe(docsTip);

    // The refs/pull/1/head CAS write landed.
    const refNames = (await env.REPO.getByName(`${OWNER}/w105cmp`).listRefs()).refs.map((ref) => ref.name);
    expect(refNames).toContain("refs/pull/1/head");

    // The round trip: the SAME compare URL now arms to the existing-PR
    // segment — title, index, the View link — and the form is gone, while
    // the diff below stays.
    const after = await get(pairPath, OWNER);
    expect(after.status).toBe(200);
    const afterHtml = await after.text();
    expect(afterHtml).toContain("w105: the round-trip pr");
    expect(afterHtml).toContain("#1");
    expect(afterHtml).toContain(`href="/${OWNER}/w105cmp/pulls/1"`);
    expect(afterHtml).toContain("View Pull Request");
    expect(afterHtml).not.toContain("pullrequest-form");
    expect(afterHtml).toContain('id="diff-file-boxes"');
  });
});
