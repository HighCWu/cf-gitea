/**
 * The branches page's DEFERRED route-level matrix (pages/branches.tsx —
 * `GET /{owner}/{repo}/branches` mounted at wave 16, the writer forms + the
 * PR column added at 2995e02, plus the mounted write arm
 * `POST /{owner}/{repo}/branches/delete`). The base arms belong to
 * ui/__tests__/pages-wave17.test.ts (the parser claims, the list
 * DOM/order/badge arms, the delete write's full refusal matrix, the PR
 * column's four arms, the writer create/rename forms' render, the
 * pagination slice, the keyword filter, the display-param flashes and the
 * a11y smoke) and to the committed goldens (branches.html /
 * branches-writer.html — the anonymous and owner renders of a PUBLIC repo).
 * THIS FILE adds only the arms that fixture posture cannot render, driven
 * over the mounted uiRouter on the commits.matrix minted-session pattern
 * with a disjoint `w100*` fixture family seeded through the REAL receive
 * flow:
 *
 *   - the viewer gates on a PRIVATE repo (wave17's fixtures are all
 *     public): anonymous and signed-in-stranger 404 shells on the list —
 *     and on the DELETE write, where a public repo would 303 onto /login
 *     (wave17's arm) — existence stays hidden instead of leaking through
 *     the redirect; plus the signed-in OWNER's 200 render with the writer
 *     pair (create/rename) and the Switch Default Branch link
 *     (canAdminRepo's owner arm) over a default-only ref set;
 *   - the archived arms (upstream's `$.Repository.CanContentChange` half of
 *     the writer block, list.tmpl:34/163/185/199): the create/rename forms
 *     hide for the owner while the page stays publicly readable — and ONE
 *     DELIBERATELY RED test (the commits.matrix escalation-artifact
 *     convention for a tests-only wave): upstream hides the per-row DELETE
 *     button behind the SAME CanContentChange gate (list.tmpl:199 `{{if and
 *     $.IsWriter $.Repository.CanContentChange}}` wrapping `.CanDelete`),
 *     but pages/branches.tsx renders it on `row.canDelete` alone, and
 *     `rowExtras` never sees `repo.isArchived` — so an archived repo's
 *     writer is offered a button whose POST arm 404-shells (ui/index.ts
 *     branchDeleteSubmit's RepoMustNotBeArchived posture). The render seam
 *     and the write seam disagree, against BranchDeleteForm's own doc
 *     comment ("renders only when the write seam would accept"). LEFT RED
 *     deliberately; the fix belongs to the page owner (fold
 *     `!repo.isArchived` into the delete arm's render gate);
 *   - the §4.9 default-branch fallback route-level (wave17 pins the
 *     not-exist arm only): a repo whose D1 default branch names no ref
 *     falls back to the FIRST branch for the default section (the DEFAULT
 *     badge, the tree link, the writer create form's `from`), the list
 *     renders the remainder, and the not-exist segment stays hidden;
 *   - the divergence BARS (wave17 pins the tooltip texts only): upstream's
 *     Eval widths — the behind bar 100% / ahead bar 0% on a 1-behind row,
 *     the inverse on a 1-ahead row — and the 0/0 NaN the upstream template
 *     knowingly renders rendered as the honest 0% with the
 *     commits_no_divergence tooltip (the module header's improvement note);
 *   - the PR column's two deferred arms: a merged + MergeMovedOn branch
 *     that is ALSO ahead of the default renders the COMPARE button
 *     (wave17's moved-on fixture sits 0 ahead, so its cell renders nothing
 *     and the compare arm never fires there), and
 *     `repo_settings.has_pull_requests = false` (AllowsPulls false) empties
 *     the compare arm while the Included badge still renders (the Included
 *     arm carries no AllowsPulls gate upstream);
 *   - the display-only degrades wave17's flash pins leave open: the
 *     deletion_failed text (the CAS-moved arm's display half) and the
 *     junk/negative `?page` clamp to page 1 (parsePageNumber's §4.11
 *     posture on this route);
 *   - the claim pin: the rename write tail (`/branches/rename`) parses to
 *     null — engine-owned like `/_new/*` (wave17's parser block) until the
 *     mount wave lands the two POST arms. Per the wave brief, the
 *     unmounted POSTs' 404s are DOCUMENTED here (pages/branches.tsx's
 *     HANDOFF — render + upstream contract first, write arm second), never
 *     pinned: the mount wave flips them deliberately. Window-2e folds
 *     (635ce2e) mounted BOTH POST arms and the pin moved to the claimed
 *     shape;
 *   - the wave-129 write arms over a dedicated `w100wr` fixture (main +
 *     side, unarchived — the arms mutate refs, so the read-pinned repos
 *     above stand alone): the quick-create POST's success round-trip
 *     (`?created=` + the ref AT THE SOURCE TIP + the list row), the
 *     unknown-source DEFAULT-BRANCH FALLBACK (resolveNamedRef's documented
 *     "or the default branch" posture — ghost is not a refusal), the
 *     empty/colliding refusals and the archived + anonymous 404 shells, and
 *     the rename POST's round-trip (the ref swap verified through listRefs
 *     + `?renamed=`) with its refusal set (the plain owner's default-branch
 *     refusal — branch.go:443-447's site-admin arm — plus empty / missing /
 *     colliding / self pairs).
 */

import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { ZERO_OID } from "../../api/services/engine";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { issues, pullRequests, repositories, users } from "../../db/schema";
import { settleCreatingRepo } from "../../git-http/gate";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import type { UiManifest } from "../manifest";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";

// wave-129 full-run contention budget: this file's beforeAll seeding (the
// receive-flow w100* fixture family) measured a 6.26s hook share of the 30s
// default IN a green 8-worker full run (the suite's 260-isolate spawn storm
// spikes closures up to ~12x their solo time). File-local 90s budgets;
// vitest.config.ts keeps 30s for every other file. Membership: the measured
// >=4s in-run closure/hook set (full-suite junit run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// --- the minted-session route harness (the commits.matrix pattern) --------------

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
 *  loadBranchesData / branchDeleteSubmit → render, on the mounted uiRouter
 *  with the synthetic manifest; the execution context is awaited so
 *  waitUntil side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie for the fixture user (the value is never
 *  asserted — minted per call like the commits.matrix helper). */
async function cookieFor(username: string): Promise<string> {
  const user = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, username)).get();
  if (user === undefined) throw new Error(`w100 fixture user missing: ${username}`);
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

// --- fixtures -------------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — fixed, deterministic oids

const OWNER = "w100gal";
const STRANGER = "w100pal";

/** Four fixed commits: tips[0] root, tips[1] main's tip, tips[2] one ahead,
 *  tips[3] two ahead. Fixed times/contents → deterministic oids. */
const W100_COMMITS: SeedCommit[] = [
  { message: "w100: seed root", time: T0, files: [{ path: "f0.txt", content: "root\n" }] },
  { message: "w100: main tip", time: T0 + 60, files: [{ path: "f1.txt", content: "one\n" }] },
  { message: "w100: ahead commit", time: T0 + 120, files: [{ path: "f2.txt", content: "two\n" }] },
  { message: "w100: moved commit", time: T0 + 180, files: [{ path: "f3.txt", content: "three\n" }] },
];

const MAIN_TIP = 1;
const AHEAD_TIP = 2;
const MOVED_TIP = 3;
const ROOT_TIP = 0;

async function pushRefs(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array, token: string): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`w100 seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** Idempotent repo seed (the wave-17 ensure recipe over this module's ref
 *  set): token mint, ONE multi-ref push when the cell is unborn, the D1 row
 *  create-or-settle, then the visibility / defaultBranch / isArchived pins
 *  (determinism is a fixture property — the receive flow's own settle
 *  behavior is engine-owned). `refs` is the FULL branch list — a caller
 *  that omits `main` gets a repo whose D1 default pin can exercise the
 *  §4.9 fallback. */
async function ensureRepo(
  slug: string,
  refs: { name: string; tipIndex: number }[],
  tips: string[],
  pack: Uint8Array,
  options: { defaultBranch: string; isPrivate?: boolean; isArchived?: boolean },
): Promise<void> {
  const db = drizzle(env.DB);
  const repoName = `${OWNER}/${slug}`;
  const owner = (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get())!;

  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner.id, `w100-seed-${slug}`)
    .run();
  const token = (await mintFor(owner.id, `w100-seed-${slug}`, "write:repository")).plaintext;

  const engineRefs = await env.REPO.getByName(repoName).listRefs();
  if (engineRefs.head === null) {
    await pushRefs(
      repoName,
      refs.map((branch) => ({ ref: `refs/heads/${branch.name}`, oid: tips[branch.tipIndex] as string })),
      pack,
      token,
    );
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

  const { tips, pack } = await buildHistoryPack(W100_COMMITS);

  // The bars/PR-column repo: main + stale (1 behind) + ahead (1 ahead) +
  // flat (0/0, main's tip) + moved (2 ahead, carrying the moved-on PR).
  await ensureRepo(
    "w100br",
    [
      { name: "main", tipIndex: MAIN_TIP },
      { name: "stale", tipIndex: ROOT_TIP },
      { name: "ahead", tipIndex: AHEAD_TIP },
      { name: "flat", tipIndex: MAIN_TIP },
      { name: "moved", tipIndex: MOVED_TIP },
    ],
    tips,
    pack,
    { defaultBranch: "main" },
  );

  // The AllowsPulls repo: main + ahead (1 ahead) + flat (0/0), with
  // has_pull_requests flipped false (upsert — idempotent).
  await ensureRepo(
    "w100nopulls",
    [
      { name: "main", tipIndex: MAIN_TIP },
      { name: "ahead", tipIndex: AHEAD_TIP },
      { name: "flat", tipIndex: MAIN_TIP },
    ],
    tips,
    pack,
    { defaultBranch: "main" },
  );
  const nopullsRow = (
    await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, "w100nopulls")))
      .get()
  )!;
  await saveRepoSettings(env.DB, nopullsRow.id, { hasPullRequests: false }, new Date(T0 * 1000));

  // The private repo: main only — the gate arms need no rows.
  await ensureRepo("w100priv", [{ name: "main", tipIndex: MAIN_TIP }], tips, pack, { defaultBranch: "main", isPrivate: true });

  // The fallback repo: NO main ref — aaa (root) + zzz (main's tip), with
  // the D1 default pinned to a name no ref carries (the §4.9 fallback arm).
  await ensureRepo(
    "w100fallback",
    [
      { name: "aaa", tipIndex: ROOT_TIP },
      { name: "zzz", tipIndex: MAIN_TIP },
    ],
    tips,
    pack,
    { defaultBranch: "ghost" },
  );

  // The archived repo: main + side (1 ahead, unprotected) — the
  // CanContentChange arms.
  await ensureRepo(
    "w100arch",
    [
      { name: "main", tipIndex: MAIN_TIP },
      { name: "side", tipIndex: AHEAD_TIP },
    ],
    tips,
    pack,
    { defaultBranch: "main", isArchived: true },
  );

  // The write-arms repo (wave-129): main + side, unarchived — the mounted
  // _new/rename POST arms mutate its refs, so it stands alone from the
  // read-pinned repos above.
  await ensureRepo(
    "w100wr",
    [
      { name: "main", tipIndex: MAIN_TIP },
      { name: "side", tipIndex: AHEAD_TIP },
    ],
    tips,
    pack,
    { defaultBranch: "main" },
  );

  // The moved-on PR over w100br's `moved` branch (the wave-17 PR-column
  // seeding shape): MERGED, and its pull head sits at MAIN's tip — it
  // exists and differs from moved's own tip, so MergeMovedOn is TRUE.
  const brRow = (
    await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, "w100br")))
      .get()
  )!;
  const owner = (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get())!;
  if ((await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, brRow.id)).limit(1).all()).length === 0) {
    const moved = await new IssuesService(env.DB).createPullRequest({
      repoId: brRow.id,
      title: "w100: moved-on pr",
      posterId: owner.id,
      headRepoId: brRow.id,
      baseBranch: "main",
      headBranch: "moved",
    });
    await db.update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.id, moved.pullRequest.id));
    const mainTip = tips[MAIN_TIP];
    if (mainTip === undefined) throw new Error("w100 seed: main tip missing");
    const head = await env.REPO.getByName(`${OWNER}/w100br`).commitApiChange({
      ref: `refs/pull/${moved.pullRequest.index}/head`,
      expectedOldOid: ZERO_OID,
      newOid: mainTip,
    });
    if (head.tag !== "committed") throw new Error(`w100 seed: refs/pull/${moved.pullRequest.index}/head create failed`);
  }
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the claim pin ----------------------------------------------------------------

describe("w100 claim pin (the unmounted POST arms)", () => {
  it("parses the rename write tail to null — engine-owned until the mount wave (the HANDOFF)", () => {
    // pages/branches.tsx's HANDOFF: the create (`/branches/_new/branch/{from}`,
    // wave17's parser block) and rename POST arms are unmounted in
    // src/ui/index.ts — the parser claims only the bare list, `/delete` and
    // the wave-39 `/list` aux tail. Per the wave brief the resulting engine
    // 404s are DOCUMENTED, not pinned: the mount wave flips them
    // deliberately.
    // Window-2e folds (635ce2e) mounted the rename POST arm — the stale
    // null updated to the claimed shape (the settingsnav-fold's disclosure).
    expect(parseUiRoute(`/${OWNER}/w100br/branches/rename`)).toEqual({ family: "branch-rename", owner: OWNER, repo: "w100br" });
  });
});

// --- the viewer gates (the private-repo arms) -------------------------------------

describe("w100 viewer gates (the private-repo arms)", () => {
  it("404-shells the private repo's list for anonymous and stranger sessions, and its delete write too", async () => {
    // The list: no read grant → the §2.5 shell, existence hidden. A session
    // buys no visibility (the issues-list matrix's arm, on this family).
    expect((await get(`/${OWNER}/w100priv/branches`)).status).toBe(404);
    expect((await get(`/${OWNER}/w100priv/branches`, STRANGER)).status).toBe(404);
    // The write: a PUBLIC repo's anonymous POST 303s onto /login (wave17's
    // gate arm); here the repo resolves first and never exists for the
    // viewer — no login redirect may leak the row's existence.
    const anonPost = await fetchUi(`/${OWNER}/w100priv/branches/delete`, formPost(`/${OWNER}/w100priv/branches/delete`, { name: "main" }));
    expect(anonPost.status).toBe(404);
  });

  it("renders the signed-in owner's private list with the writer pair and the Switch link, no delete", async () => {
    const res = await get(`/${OWNER}/w100priv/branches`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content ui repository branches");
    expect(html).toContain('data-testid="branches-default-branch-list"');
    // The writer block rides the loaded grant over the private row: the
    // default section's create (from main) + rename pair …
    expect(html).toContain(`action="/${OWNER}/w100priv/branches/_new/branch/main"`);
    expect(html).toContain(`action="/${OWNER}/w100priv/branches/rename"`);
    // … and the Switch Default Branch link (canAdminRepo's owner arm — the
    // settings page's own gate, the module header's divergence note).
    expect(html).toContain("Switch Default Branch");
    // Default-only ref set: no non-default row, hence no delete form.
    expect(html).not.toContain(`action="/${OWNER}/w100priv/branches/delete"`);
  });
});

// --- the archived arms (the CanContentChange render gate) --------------------------

describe("w100 archived arms (the CanContentChange render gate)", () => {
  it("hides the writer create/rename pair for the owner and renders read-only for anonymous", async () => {
    const owner = await get(`/${OWNER}/w100arch/branches`, OWNER);
    expect(owner.status).toBe(200);
    const html = await owner.text();
    // The page itself stays readable upstream (archiving never hides the
    // view) and the writer block's CanContentChange half folds the create/
    // rename pair away for the owner.
    expect(html).toContain('data-testid="branches-default-branch-list"');
    expect(html).toContain(`href="/${OWNER}/w100arch/src/branch/side"`);
    expect(html).not.toContain('name="new_branch_name"');
    expect(html).not.toContain(`action="/${OWNER}/w100arch/branches/rename"`);
    // Anonymous: the same read-only posture (no grant hides the pair too).
    const anon = await get(`/${OWNER}/w100arch/branches`);
    expect(anon.status).toBe(200);
    expect(await anon.text()).not.toContain('name="new_branch_name"');
  });

  it("RED (escalation artifact): renders the delete button upstream's CanContentChange gate hides", async () => {
    // upstream list.tmpl:199 wraps the delete button in the SAME
    // `and $.IsWriter $.Repository.CanContentChange` gate as create/rename;
    // pages/branches.tsx renders it on `row.canDelete` alone (the archived
    // flag never reaches rowExtras), so the archived owner is offered a
    // button whose POST arm 404-shells — the render seam and the write seam
    // disagree (BranchDeleteForm's doc invariant broken). Tests-only wave:
    // left RED deliberately as the escalation artifact; the fix folds
    // `!repo.isArchived` into the delete render gate.
    const res = await get(`/${OWNER}/w100arch/branches`, OWNER);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(`action="/${OWNER}/w100arch/branches/delete"`);
  });

  it("404-shells the archived repo's delete write (the seam half of the disagreement)", async () => {
    // The write seam refuses what the render seam (wrongly) offers — pinned
    // so the mount/fix wave cannot silently drop the refusal either.
    const res = await fetchUi(
      `/${OWNER}/w100arch/branches/delete`,
      formPost(`/${OWNER}/w100arch/branches/delete`, { name: "side" }, await cookieFor(OWNER)),
    );
    expect(res.status).toBe(404);
    // The ref survives the refused write.
    const refNames = (await env.REPO.getByName(`${OWNER}/w100arch`).listRefs()).refs.map((ref) => ref.name);
    expect(refNames).toContain("refs/heads/side");
  });
});

// --- the §4.9 default-branch fallback ----------------------------------------------

describe("w100 default-branch fallback (the first-branch arm)", () => {
  it("falls back to the first branch for the default section and keeps the not-exist segment hidden", async () => {
    // w100fallback's D1 default names no ref ("ghost"); the loader falls
    // back to the alphabetically-first branch (aaa) for the default
    // section, the list carries the remainder (zzz) — and the not-exist
    // segment wave17 pins (for a ref-EMPTY repo) must NOT render here.
    const res = await get(`/${OWNER}/w100fallback/branches`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="branches-default-branch-list"');
    expect(html).not.toContain('data-testid="branches-default-branch-not-exist"');
    expect(html).not.toContain("does not exist");
    expect(html).toContain(`<a class="gt-ellipsis branch-name" href="/${OWNER}/w100fallback/src/branch/aaa">`);
    expect(html).toContain('<span class="ui basic label">Default</span>');
    expect(html).not.toContain("/src/branch/ghost");
    expect(html).toContain(`href="/${OWNER}/w100fallback/src/branch/zzz"`);
    expect(html).not.toContain(`href="/${OWNER}/w100fallback/src/branch/main"`);
    // The fallback default is the divergence base: zzz sits one ahead of aaa.
    expect(html).toContain("Commit divergence: 0 behind and 1 ahead of aaa");
    // The writer create form hangs off the FALLBACK default (from aaa).
    const ownerView = await get(`/${OWNER}/w100fallback/branches`, OWNER);
    expect(ownerView.status).toBe(200);
    expect(await ownerView.text()).toContain(`action="/${OWNER}/w100fallback/branches/_new/branch/aaa"`);
  });
});

// --- the divergence bars -------------------------------------------------------

describe("w100 divergence bars (the Eval widths)", () => {
  it("renders upstream's bar widths and the 0/0 NaN posture as an honest 0%", async () => {
    const res = await get(`/${OWNER}/w100br/branches`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // stale (1 behind, 0 ahead): the behind bar takes the full width, the
    // ahead bar none — upstream's Eval 100·count/(behind+ahead).
    expect(html).toContain('class="count count-behind">1<');
    expect(html).toContain("Commit divergence: 1 behind and 0 ahead of main");
    expect(html).toContain('bar bar-behind" style="width: 100%"');
    // ahead (0 behind, 1 ahead) and moved (0 behind, 2 ahead): the inverse.
    expect(html).toContain('class="count count-ahead">2<');
    expect(html).toContain('bar bar-ahead" style="width: 100%"');
    expect(html).toContain('bar bar-ahead" style="width: 0%"');
    // flat (0/0): upstream's template knowingly renders a NaN width — the
    // page replaces it with the honest 0% and the no-divergence tooltip
    // (the module header's improvement note).
    expect(html).toContain('bar bar-behind" style="width: 0%"');
    expect(html).toContain('data-tooltip-content="The same as branch main"');
  });
});

// --- the PR column's deferred arms -------------------------------------------------

describe("w100 PR column deferred arms", () => {
  it("renders the compare arm for a merged, moved-on PR whose branch is ahead", async () => {
    // wave17's moved-on fixture (stale) sits 0 ahead, so its cell renders
    // nothing and the compare arm never fires there. `moved` is 2 ahead
    // with a merged PR whose pull head sits past its tip: the cell plays
    // the compare arm instead of the Merged label.
    const res = await get(`/${OWNER}/w100br/branches`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="/${OWNER}/w100br/compare/main...moved?expand=1"`);
    // The moved-on PR's link/label arm stays suppressed — no #1 anywhere.
    expect(html).not.toContain(">#1</a>");
  });

  it("empties the compare arm when AllowsPulls is false while the Included badge still renders", async () => {
    // w100nopulls flips has_pull_requests off: the ahead-1 row loses its
    // compare button (AllowsPulls gates the arm upstream too) and the cell
    // renders nothing, while the 0/0 row's Included badge survives — the
    // Included arm carries no AllowsPulls gate upstream.
    const res = await get(`/${OWNER}/w100nopulls/branches`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="/${OWNER}/w100nopulls/src/branch/ahead"`);
    expect(html).not.toContain("compare/main...ahead");
    expect(html).not.toContain(">Compare</span>");
    expect(html).toContain("Included</span>");
  });
});

// --- the display-only degrades -------------------------------------------------

describe("w100 display-only degrades", () => {
  it("renders the deletion_failed flash text (the CAS arm's display half)", async () => {
    // wave17 pins the success/protected/default flashes; the failed text
    // (the CAS-moved outcome's display half) completes the quartet.
    const res = await get(`/${OWNER}/w100br/branches?delete_error=failed&name=stale`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Failed to delete branch &quot;stale&quot;.");
  });

  it("clamps junk and negative ?page values to the first page", async () => {
    // parsePageNumber's §4.11 posture on this route: non-numeric and < 1
    // both render page 1 — no Newer back-link, the full row set.
    for (const page of ["junk", "0", "-3"]) {
      const res = await get(`/${OWNER}/w100br/branches?page=${encodeURIComponent(page)}`);
      expect(res.status, page).toBe(200);
      const html = await res.text();
      expect(html).toContain(`href="/${OWNER}/w100br/src/branch/stale"`);
      expect(html, page).not.toContain("Newer");
    }
  });
});

// --- the mounted writer POST arms (Window-2e folds, 635ce2e) -----------------------

describe("w100 quick-create write (POST /branches/_new/branch/{from})", () => {
  it("creates the branch at the source tip, 303s ?created=, and the list renders the row", async () => {
    // upstream web.go:1477-1481 NewBranchPost (the writer forms' POST arm
    // the module header's HANDOFF deferred; the Window-2e fold mounted it).
    // w100wr: main@tips[1], side@tips[2] — the create hangs off main.
    const res = await fetchUi(
      `/${OWNER}/w100wr/branches/_new/branch/main`,
      formPost(`/${OWNER}/w100wr/branches/_new/branch/main`, { new_branch_name: "w100-made" }, await cookieFor(OWNER)),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OWNER}/w100wr/branches?created=w100-made`);
    // The engine half: the ref exists AT THE SOURCE TIP (RefsResult carries
    // `target`, the refTipMap's field).
    const tips = (await buildHistoryPack(W100_COMMITS)).tips;
    const made = (await env.REPO.getByName(`${OWNER}/w100wr`).listRefs()).refs.find(
      (ref) => ref.name === "refs/heads/w100-made",
    );
    expect(made?.target).toBe(tips[MAIN_TIP]);
    // The display half: the new row joins the list.
    const list = await get(`/${OWNER}/w100wr/branches`);
    expect(list.status).toBe(200);
    expect(await list.text()).toContain(`href="/${OWNER}/w100wr/src/branch/w100-made"`);
  });

  it("refuses the empty name, falls back to the default for an unknown source, refuses the colliding name (flash redirects)", async () => {
    const cookie = await cookieFor(OWNER);
    const empty = await fetchUi(
      `/${OWNER}/w100wr/branches/_new/branch/main`,
      formPost(`/${OWNER}/w100wr/branches/_new/branch/main`, { new_branch_name: "   " }, cookie),
    );
    expect(empty.status).toBe(303);
    expect(empty.headers.get("location")).toBe(`/${OWNER}/w100wr/branches?create_error=empty&name=`);
    // An UNKNOWN source is not a refusal: resolveNamedRef's documented
    // posture falls back to the DEFAULT branch (engine.ts's "or the default
    // branch" — the API's ?ref= default), so ghost→w100-fb lands at main.
    const tips = (await buildHistoryPack(W100_COMMITS)).tips;
    const fallback = await fetchUi(
      `/${OWNER}/w100wr/branches/_new/branch/ghost`,
      formPost(`/${OWNER}/w100wr/branches/_new/branch/ghost`, { new_branch_name: "w100-fb" }, cookie),
    );
    expect(fallback.status).toBe(303);
    expect(fallback.headers.get("location")).toBe(`/${OWNER}/w100wr/branches?created=w100-fb`);
    const fbRef = (await env.REPO.getByName(`${OWNER}/w100wr`).listRefs()).refs.find(
      (ref) => ref.name === "refs/heads/w100-fb",
    );
    expect(fbRef?.target).toBe(tips[MAIN_TIP]);
    const exists = await fetchUi(
      `/${OWNER}/w100wr/branches/_new/branch/main`,
      formPost(`/${OWNER}/w100wr/branches/_new/branch/main`, { new_branch_name: "side" }, cookie),
    );
    expect(exists.status).toBe(303);
    expect(exists.headers.get("location")).toBe(`/${OWNER}/w100wr/branches?create_error=exists&name=side`);
    // Nothing extra landed: exactly the seeded pair + the two created arms.
    const names = (await env.REPO.getByName(`${OWNER}/w100wr`).listRefs()).refs.map((ref) => ref.name).sort();
    expect(names).toEqual(["refs/heads/main", "refs/heads/side", "refs/heads/w100-fb", "refs/heads/w100-made"]);
  });

  it("404-shells the archived repo's create and the anonymous writer (the write seam's gates)", async () => {
    // The archived half: writerControls hides the form (the archived-arms
    // describe) AND the write seam refuses with the 404 shell.
    const archived = await fetchUi(
      `/${OWNER}/w100arch/branches/_new/branch/main`,
      formPost(`/${OWNER}/w100arch/branches/_new/branch/main`, { new_branch_name: "w100-arch" }, await cookieFor(OWNER)),
    );
    expect(archived.status).toBe(404);
    // The anonymous half: no write grant on the public repo → the 404 shell
    // (no login redirect — the write seam's posture differs from the delete
    // route's anonymous 303).
    const anon = await fetchUi(
      `/${OWNER}/w100wr/branches/_new/branch/main`,
      formPost(`/${OWNER}/w100wr/branches/_new/branch/main`, { new_branch_name: "w100-anon" }),
    );
    expect(anon.status).toBe(404);
    const names = (await env.REPO.getByName(`${OWNER}/w100wr`).listRefs()).refs.map((ref) => ref.name);
    expect(names).not.toContain("refs/heads/w100-arch");
    expect(names).not.toContain("refs/heads/w100-anon");
  });
});

describe("w100 rename write (POST /branches/rename)", () => {
  it("renames side onto side-two: the ref swaps at the old tip and the list renders the new name", async () => {
    // upstream branch.go RenameBranchPost (web.go:1486) — create-at-tip then
    // delete, the exact engine pair the Window-2e fold replays.
    const tips = (await buildHistoryPack(W100_COMMITS)).tips;
    const res = await fetchUi(
      `/${OWNER}/w100wr/branches/rename`,
      formPost(`/${OWNER}/w100wr/branches/rename`, { from: "side", to: "side-two" }, await cookieFor(OWNER)),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OWNER}/w100wr/branches?renamed=side-two`);
    const refs = (await env.REPO.getByName(`${OWNER}/w100wr`).listRefs()).refs;
    expect(refs.find((ref) => ref.name === "refs/heads/side")).toBeUndefined();
    expect(refs.find((ref) => ref.name === "refs/heads/side-two")?.target).toBe(tips[AHEAD_TIP]);
    const list = await get(`/${OWNER}/w100wr/branches`);
    expect(await list.text()).toContain(`href="/${OWNER}/w100wr/src/branch/side-two"`);
  });

  it("refuses the default branch for the plain owner (branch.go:443-447's admin-only arm)", async () => {
    // The OWNER session is a repo admin but NOT a site admin — upstream
    // RenameBranch keys the default-branch rename on the SITE admin flag,
    // so the owner's rename of `main` flashes the refusal and the refs stand.
    const res = await fetchUi(
      `/${OWNER}/w100wr/branches/rename`,
      formPost(`/${OWNER}/w100wr/branches/rename`, { from: "main", to: "main-two" }, await cookieFor(OWNER)),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OWNER}/w100wr/branches?rename_error=default&name=main`);
    const names = (await env.REPO.getByName(`${OWNER}/w100wr`).listRefs()).refs.map((ref) => ref.name);
    expect(names).toContain("refs/heads/main");
    expect(names).not.toContain("refs/heads/main-two");
  });

  it("refuses the empty, missing, colliding and self pairs with the flash redirects (refs untouched)", async () => {
    const post = async (from: string, to: string): Promise<Response> =>
      fetchUi(
        `/${OWNER}/w100wr/branches/rename`,
        formPost(`/${OWNER}/w100wr/branches/rename`, { from, to }, await cookieFor(OWNER)),
      );
    const empty = await post("", "whatever");
    expect(empty.headers.get("location")).toBe(`/${OWNER}/w100wr/branches?rename_error=empty&name=`);
    const missing = await post("ghost", "ghost-two");
    expect(missing.headers.get("location")).toBe(`/${OWNER}/w100wr/branches?rename_error=missing&name=ghost`);
    const collides = await post("side-two", "main");
    expect(collides.headers.get("location")).toBe(`/${OWNER}/w100wr/branches?rename_error=exists&name=side-two`);
    const self = await post("side-two", "side-two");
    expect(self.headers.get("location")).toBe(`/${OWNER}/w100wr/branches?rename_error=exists&name=side-two`);
    // Every response stays a redirect onto the list (never a shell) and the
    // ref set is unchanged by the whole quartet.
    for (const res of [empty, missing, collides, self]) expect(res.status).toBe(303);
    const names = (await env.REPO.getByName(`${OWNER}/w100wr`).listRefs()).refs.map((ref) => ref.name).sort();
    expect(names).toEqual(["refs/heads/main", "refs/heads/side-two", "refs/heads/w100-fb", "refs/heads/w100-made"]);
  });
});
