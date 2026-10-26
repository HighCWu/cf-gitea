/**
 * Pages wave 17 route tests — the repository branches family
 * (`/{owner}/{repo}/branches` + its `/branches/delete` write,
 * pages/branches.tsx): upstream templates/repo/branch/list.tmpl + web.go
 * :1478-1482's delete route over the LANDED reads (engineReads listRefs /
 * readCommit / countDivergence) and the LANDED protection service
 * (listRepoRules + principalAccessOfRow + canUserPush/canUserDelete — the
 * SPEC-0013 §3.6 render extras this page consumes, the wave-15 badge's
 * first consumer).
 *
 * Same harness posture as pages-wave2..15: the router is driven directly
 * with the synthetic ASSETS manifest; engine content seeds through the REAL
 * receive flow (testing/seed-repo.ts's pack primitives) with fixed
 * timestamps so the oids and rendered stamps are deterministic; identities
 * ride minted session cookies. Two fixture repos keep the GET/POST matrix
 * off any other suite's rows: `alice/wave17br` (five branches across the
 * divergence/protection matrix + three rules) and `alice/wave17many` (main
 * + 21 bulk refs — the pagination slice).
 *
 * Gate postures under test: the anonymous-capable list (public repo, no
 * controls), the writer's CanDelete buttons (upstream loadOneBranch's
 * arms — hidden on the default branch, on protected branches whose rule
 * refuses, shown on an armed rule the doer may delete through), the delete
 * write's refusals (default / protected / missing / CAS-moved) flashing
 * upstream DeleteBranchPost's exact texts, and the M2 predicate the API
 * DELETE arm predates (the UI never offers a protection-defeating path).
 * The wave-branches-reductions pass adds: the writer's create/rename inline
 * forms (upstream's exact routes/fields — the POST arms are unmounted, the
 * module header's HANDOFF; only the RENDER matrix is asserted here), the PR
 * column's four arms (Included badge, compare button, the Open/Closed/
 * Merged state labels, and MergeMovedOn emptying a merged-ahead-0 cell),
 * and the info line's octicon-git-commit mark.
 */

import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { issues, protectedBranches, pullRequests, repositories, users } from "../../db/schema";
import { ZERO_OID } from "../../api/services/engine";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { emptyRuleConfig, serializeRuleConfig } from "../../services/branch-protection";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

const formPost = (path: string, body: Record<string, string>, cookie?: string, origin = "https://test.local"): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...(origin === "" ? {} : { origin }),
    ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
  },
  body: new URLSearchParams(Object.entries(body)).toString(),
});

// --- fixtures -----------------------------------------------------------------

/** Four fixed commits: main sits at tips[1], docs-seed/release/1 at tips[2]
 *  (1 ahead of main), stale at tips[0] (1 behind), feature/one at tips[3]
 *  (2 ahead). Fixed times → deterministic oids and rendered stamps. */
const WAVE17_COMMITS: SeedCommit[] = [1, 2, 3, 4].map((n, index) => ({
  message: `wave17: commit ${n}`,
  time: T0 + index * 60,
  files: [{ path: `f${n}.txt`, content: `content ${n}\n` }],
}));

const WAVE17_MAIN_TIP = 1; // tips index the default branch points at

/** One push through the REAL receive flow: `updates` land verbatim (the
 *  seed-repo helpers build the pack; ensureSeededRepo only ever lands main,
 *  and this fixture needs the multi-branch ref set). */
async function pushRefs(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array, token: string): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`wave17 seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** Idempotent multi-branch seed (the ensureSeededRepo recipe with this
 *  module's ref set): owner row, one pack push, settle + public + the
 *  createdAt pin (§5.2 determinism is a fixture property). */
async function ensureWave17Repo(slug: string, extraBranches: { ref: string; tipIndex: number }[]): Promise<{ tips: string[] }> {
  const db = drizzle(env.DB);
  const repoName = `alice/${slug}`;
  const alice =
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) ??
    (() => {
      throw new Error("alice row missing before the wave-17 seed");
    })();
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, `ui-page-seed-${slug}`)
    .run();
  const token = (await mintFor(alice.id, `ui-page-seed-${slug}`, "write:repository")).plaintext;

  const refs = await env.REPO.getByName(repoName).listRefs();
  if (refs.head === null) {
    const { tips, pack } = await buildHistoryPack(WAVE17_COMMITS);
    await pushRefs(
      repoName,
      [{ ref: "refs/heads/main", oid: tips[WAVE17_MAIN_TIP] as string }, ...extraBranches.map((b) => ({ ref: b.ref, oid: tips[b.tipIndex] as string }))],
      pack,
      token,
    );
  }

  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, slug)))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: slug,
      isPrivate: false,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, row.id, repoName);
    row = (await db.select().from(repositories).where(eq(repositories.id, row.id)).get()) ?? row;
  }
  if (row.visibility !== "public") {
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  }
  // The default-branch pin: the first push settles the row's default_branch
  // from the engine's HEAD, and a MULTI-ref first push lands HEAD on the
  // alphabetically-first ref here — pin "main" like every other deterministic
  // column (§5.2 determinism is a fixture property; the receive flow's own
  // settle behavior is engine-owned, not this page's).
  if (row.defaultBranch !== "main") {
    await db.update(repositories).set({ defaultBranch: "main" }).where(eq(repositories.id, row.id));
  }
  await db.update(repositories).set({ createdAt: new Date(T0 * 1000) }).where(eq(repositories.id, row.id));
  return { tips: (await buildHistoryPack(WAVE17_COMMITS)).tips };
}

interface Wave17Fixture {
  aliceCookie: string;
  bobCookie: string;
}

let wave17Fixture: Wave17Fixture | null = null;

async function ensureWave17Fixtures(): Promise<Wave17Fixture> {
  if (wave17Fixture !== null) return wave17Fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  for (const extra of [
    { username: "alice", isAdmin: false },
    { username: "wave17bob", isAdmin: false },
  ] as const) {
    if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra.username)).get()) === undefined) {
      await seedVerifiedUser({ username: extra.username });
    }
  }

  // The matrix repo: main + docs-seed + stale + feature/one + release/1.
  const { tips } = await ensureWave17Repo("wave17br", [
    { ref: "refs/heads/docs-seed", tipIndex: 2 },
    { ref: "refs/heads/stale", tipIndex: 0 },
    { ref: "refs/heads/feature/one", tipIndex: 3 },
    { ref: "refs/heads/release/1", tipIndex: 2 },
  ]);
  // The pagination repo: main + 21 bulk refs (page 1 fills exactly, page 2
  // carries the remainder with more=false).
  const manyExtras = Array.from({ length: 21 }, (_, i) => ({ ref: `refs/heads/p-${String(i + 1).padStart(2, "0")}`, tipIndex: WAVE17_MAIN_TIP }));
  await ensureWave17Repo("wave17many", manyExtras);

  // The rules (direct D1 inserts, T0-pinned — the wave-15 block's shape):
  // "main" protected with approvals (the default section's badge), the glob
  // "release/*" with push AND deletion armed + alice allowlisted (the
  // protected-but-deletable arm), and "docs-seed" bare-armed (deletion
  // refused).
  const repoRow = (await db.select().from(repositories).where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave17br"))).get())!;
  const alice = (await db.select().from(users).where(eq(users.usernameLower, "alice")).get())!;
  if ((await db.select({ id: protectedBranches.id }).from(protectedBranches).where(eq(protectedBranches.repoId, repoRow.id)).limit(1).all()).length === 0) {
    await db.insert(protectedBranches).values([
      {
        repoId: repoRow.id,
        ruleName: "main",
        priority: 1,
        rules: serializeRuleConfig({ ...emptyRuleConfig(), requiredApprovals: 1 }),
        createdAt: new Date(T0 * 1000),
        updatedAt: new Date(T0 * 1000),
      },
      {
        repoId: repoRow.id,
        ruleName: "release/*",
        priority: 2,
        rules: serializeRuleConfig({ ...emptyRuleConfig(), canPush: true, canDelete: true, enableWhitelist: true, whitelistUserIds: [alice.id] }),
        createdAt: new Date((T0 + 1) * 1000),
        updatedAt: new Date((T0 + 1) * 1000),
      },
      {
        repoId: repoRow.id,
        ruleName: "docs-seed",
        priority: 3,
        rules: serializeRuleConfig(emptyRuleConfig()),
        createdAt: new Date((T0 + 2) * 1000),
        updatedAt: new Date((T0 + 2) * 1000),
      },
    ]);
  }

  // The PR-column fixtures (IssuesService.createPullRequest — the pure D1
  // creation batch, no webhook fan-out; the pull head ref lands through the
  // engine cell like any ref write). The arm matrix:
  //   wave17br feature/one → OPEN (#1) — the green Open label arm
  //   wave17br release/1   → MERGED (#2), pull head == its tip →
  //                          MergeMovedOn FALSE — the purple Merged label arm
  //   wave17br stale       → MERGED (#3), pull head moved past its tip →
  //                          MergeMovedOn TRUE + ahead 0 — the template's
  //                          empty-cell arm (asserted by purple's ABSENCE)
  //   wave17br docs-seed   → no PR, ahead 1 — the compare-button arm
  //                          (the no-PR half; the merged+movedOn half of the
  //                          compare arm is stale's would-be render)
  //   wave17many p-21      → CLOSED — the red Closed label arm (ahead 0
  //                          renders arm C regardless)
  //   wave17many p-01..p-20 → ahead 0, no PR — the Included badge arm.
  if ((await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, repoRow.id)).limit(1).all()).length === 0) {
    const pullRequestsService = new IssuesService(env.DB);
    await pullRequestsService.createPullRequest({
      repoId: repoRow.id,
      title: "wave17: open pr",
      posterId: alice.id,
      headRepoId: repoRow.id,
      baseBranch: "main",
      headBranch: "feature/one",
    });
    const mergedIntact = await pullRequestsService.createPullRequest({
      repoId: repoRow.id,
      title: "wave17: merged pr",
      posterId: alice.id,
      headRepoId: repoRow.id,
      baseBranch: "main",
      headBranch: "release/1",
    });
    await db.update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.id, mergedIntact.pullRequest.id));
    // The pull head EQUALS release/1's tip (tips[2]) — merged, not moved on.
    const releaseTip = tips[2];
    if (releaseTip === undefined) throw new Error("wave17 seed: tips[2] missing");
    const releaseHead = await env.REPO.getByName("alice/wave17br").commitApiChange({
      ref: `refs/pull/${mergedIntact.pullRequest.index}/head`,
      expectedOldOid: ZERO_OID,
      newOid: releaseTip,
    });
    if (releaseHead.tag !== "committed") throw new Error(`wave17 seed: refs/pull/${mergedIntact.pullRequest.index}/head create failed`);

    const movedOn = await pullRequestsService.createPullRequest({
      repoId: repoRow.id,
      title: "wave17: moved-on pr",
      posterId: alice.id,
      headRepoId: repoRow.id,
      baseBranch: "main",
      headBranch: "stale",
    });
    await db.update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.id, movedOn.pullRequest.id));
    // The pull head sits at main's tip (tips[1]) — PAST stale's tip (tips[0]):
    // MergeMovedOn TRUE, and stale is 0 ahead so the cell renders nothing.
    const mainTip = tips[1];
    if (mainTip === undefined) throw new Error("wave17 seed: tips[1] missing");
    const movedHead = await env.REPO.getByName("alice/wave17br").commitApiChange({
      ref: `refs/pull/${movedOn.pullRequest.index}/head`,
      expectedOldOid: ZERO_OID,
      newOid: mainTip,
    });
    if (movedHead.tag !== "committed") throw new Error(`wave17 seed: refs/pull/${movedOn.pullRequest.index}/head create failed`);
  }
  const manyRow = (await db.select().from(repositories).where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave17many"))).get())!;
  if (manyRow !== undefined && (await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, manyRow.id)).limit(1).all()).length === 0) {
    const closedMany = await new IssuesService(env.DB).createPullRequest({
      repoId: manyRow.id,
      title: "wave17: closed pr",
      posterId: alice.id,
      headRepoId: manyRow.id,
      baseBranch: "main",
      headBranch: "p-21",
    });
    await db.update(issues).set({ isClosed: true }).where(eq(issues.id, closedMany.issue.id));
  }

  wave17Fixture = {
    aliceCookie: await mintSession(env.DB, alice.id),
    bobCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave17bob")).get())!.id),
  };
  return wave17Fixture;
}

beforeAll(async () => {
  await ensureWave17Fixtures();
});

// --- the parsers (the single owner of the route shapes) -------------------------

describe("wave-17 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the branches list and the delete tail", () => {
    expect(parseUiRoute("/octo/hello/branches")).toEqual({ family: "branches", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/branches/delete")).toEqual({ family: "branch-delete", owner: "octo", repo: "hello" });
    // The trailing-slash form classifies to the same shape.
    expect(parseUiRoute("/octo/hello/branches/")).toEqual({ family: "branches", owner: "octo", repo: "hello" });
    expect(handlesUiRoute("/octo/hello/branches")).toBe(true);
  });

  it("leaves the deeper tails with the engine (upstream's unregistered-route 404)", () => {
    expect(parseUiRoute("/octo/hello/branches/abc")).toBeNull();
    // Window-2e folds mounted the create form's POST arm — the stale null
    // updated to the claimed shape (provenance: the folds commit).
    expect(parseUiRoute("/octo/hello/branches/_new/branch/main")).toEqual({
      family: "branch-create",
      owner: "octo",
      repo: "hello",
      from: "main",
    });
    expect(parseUiRoute("/octo/hello/branches/restore")).toBeNull();
    expect(parseUiRoute("/octo/hello/branches/delete/more")).toBeNull();
  });
});

// --- the list page ---------------------------------------------------------------

describe("GET /{owner}/{repo}/branches (the list)", () => {
  it("renders anonymously over a public repo: the sections, the DEFAULT badge, the shield, no controls", async () => {
    const res = await fetchUi("/alice/wave17br/branches");
    expect(res.status).toBe(200);
    const html = await res.text();
    // list.tmpl's literal discriminator + the two section headers.
    expect(html).toContain("page-content ui repository branches");
    expect(html).toContain("Default Branch");
    expect(html).toContain('data-testid="branches-default-branch-list"');
    expect(html).toContain("Branches</h4>");
    // The DEFAULT badge (the brief's marker) and the default row's tree link.
    expect(html).toContain('<span class="ui basic label">Default</span>');
    expect(html).toContain('href="/alice/wave17br/src/branch/main"');
    // The default branch is protected by the "main" rule: the shield glyph
    // + the rule name (the wave-15 badge's consumer).
    expect(html).toContain("svg octicon-shield-lock");
    expect(html).toContain('<span class="ui tiny basic label">main</span>');
    // The list excludes the default branch and sorts by name.
    expect(html).toContain('href="/alice/wave17br/src/branch/docs-seed"');
    expect(html).toContain('href="/alice/wave17br/src/branch/feature/one"');
    expect(html).toContain('href="/alice/wave17br/src/branch/release/1"');
    expect(html).toContain('href="/alice/wave17br/src/branch/stale"');
    expect(html.indexOf(">docs-seed<")).toBeLessThan(html.indexOf(">feature/one<"));
    expect(html.indexOf(">feature/one<")).toBeLessThan(html.indexOf(">release/1<"));
    expect(html.indexOf(">release/1<")).toBeLessThan(html.indexOf(">stale<"));
    // The last-commit lines (subject + short sha + Updated stamp + author).
    expect(html).toContain("wave17: commit 4");
    expect(html).toContain("Updated");
    expect(html).toContain(">Test User</span>");
    // The divergence tooltips carry upstream's texts with the counts.
    expect(html).toContain("Commit divergence: 0 behind and 1 ahead of main");
    expect(html).toContain("Commit divergence: 1 behind and 0 ahead of main");
    expect(html).toContain("Commit divergence: 0 behind and 2 ahead of main");
    // The glob rule arms release/1: the badge + the glob rule name.
    expect(html).toContain('<span class="ui tiny basic label">release/*</span>');
    // Anonymous: no delete forms, no Switch Default Branch link.
    expect(html).not.toContain('action="/alice/wave17br/branches/delete"');
    expect(html).not.toContain("Switch Default Branch");
    // The search combo renders with the submitted keyword kept.
    expect(html).toContain('name="q"');
    // No pagination under one page.
    expect(html).not.toContain(" Older");
  });

  it("renders the writer's CanDelete buttons per upstream's list rules", async () => {
    const fixture = await ensureWave17Fixtures();
    const res = await fetchUi("/alice/wave17br/branches", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    // The admin link onto the landed settings page (upstream's IsWriter
    // link, admin-gated here — the module header's divergence note).
    expect(html).toContain('href="/alice/wave17br/settings/branches"');
    // Delete forms: the unprotected rows + the armed release/* rule (the
    // rule's canUserDelete passes for alice); NOT on docs-seed (its rule
    // disarms deletion — canUserDelete refuses) and never on the default.
    // (The value probes pin the DELETE form's hidden field specifically —
    // the rename forms' hidden `from` fields legitimately carry the same
    // branch names.)
    expect(html).toContain('action="/alice/wave17br/branches/delete"');
    const forms = html.split('action="/alice/wave17br/branches/delete"').length - 1;
    expect(forms).toBe(3); // feature/one, release/1, stale
    expect(html).toContain('name="name" value="release/1"');
    expect(html).toContain('name="name" value="stale"');
    expect(html).not.toContain('name="name" value="docs-seed"');
    expect(html).not.toContain('name="name" value="main"');
  });

  it("renders the writer's create/rename inline forms with upstream's routes and fields", async () => {
    const fixture = await ensureWave17Fixtures();
    const res = await fetchUi("/alice/wave17br/branches", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    // Create: upstream's POST /branches/_new/branch/{from} with the required
    // new_branch_name input — the default section (from main) + every row.
    expect(html).toContain('action="/alice/wave17br/branches/_new/branch/main"');
    expect(html).toContain('action="/alice/wave17br/branches/_new/branch/feature/one"');
    expect(html).toContain('action="/alice/wave17br/branches/_new/branch/docs-seed"');
    expect(html.split('name="new_branch_name"').length - 1).toBe(5); // default + 4 rows
    expect(html).toContain("octicon-git-branch");
    expect(html).toContain('aria-label="Create new branch from &quot;main&quot;"');
    // Rename: upstream's POST /branches/rename with hidden from + required to.
    expect(html.split('action="/alice/wave17br/branches/rename"').length - 1).toBe(5);
    expect(html).toContain('name="from" value="main"');
    expect(html).toContain('name="from" value="docs-seed"');
    expect(html).toContain('name="to"');
    expect(html).toContain("octicon-pencil");
    // The tooltips carry upstream's locale texts.
    expect(html).toContain('aria-label="Rename Branch &quot;feature/one&quot;"');
    // CanPull (the write grant — forks cannot exist): the compare button
    // reads upstream's repo.pulls.compare_changes for the writer.
    expect(html).toContain(">New Pull Request</span>");
    expect(html).not.toContain(">Compare</span>");
  });

  it("renders the PR column's four arms (labels, compare, Included, moved-on empty)", async () => {
    const res = await fetchUi("/alice/wave17br/branches");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The info line's octicon-git-commit mark (the wave-61 audit's glyph).
    expect(html).toContain("svg octicon-git-commit");
    // feature/one → OPEN: the #1 link + the green Open label.
    expect(html).toContain('href="/alice/wave17br/pulls/1"');
    expect(html).toContain(">#1</a>");
    expect(html).toContain('class="ui green large label"');
    expect(html).toContain(">Open</a>");
    // release/1 → MERGED with the pull head AT its tip (MergeMovedOn false):
    // the #2 link + the purple Merged label with the merge glyph.
    expect(html).toContain(">#2</a>");
    expect(html).toContain('class="ui purple large label"');
    expect(html).toContain(">Merged</a>");
    expect(html).toContain("octicon-git-merge");
    // stale → MERGED with the pull head PAST its tip (MergeMovedOn true) and
    // 0 ahead: the cell renders NOTHING — asserted by the absence of a
    // second merged row's #3 (the link arm never fires for a moved-on PR).
    expect(html).not.toContain(">#3</a>");
    // docs-seed → no PR, 1 ahead, anonymous (CanPull false): the compare
    // button reads upstream's action.compare_branch onto the default
    // compare link with ?expand=1.
    expect(html).toContain('href="/alice/wave17br/compare/main...docs-seed?expand=1"');
    expect(html).toContain(">Compare</span>");
    expect(html).not.toContain(">New Pull Request</span>");
    // No Included badge in THIS repo (every no-PR row is either ahead>0 or
    // moved-on): the Included arm shows in wave17many below.
    expect(html).not.toContain("Included</span>");
  });

  it("renders the Included badge for ahead-0 no-PR rows and the Closed label arm", async () => {
    const page1 = await fetchUi("/alice/wave17many/branches");
    expect(page1.status).toBe(200);
    const html = await page1.text();
    // p-01..p-20 (ahead 0, no PR): the orange Included label with upstream's
    // included_desc tooltip; p-21 carries the CLOSED PR instead (page 2).
    expect(html).toContain('data-tooltip-content="This branch is part of the default branch"');
    expect(html).toContain("Included</span>");
    expect(html.split("Included</span>").length - 1).toBe(20);

    const page2 = await fetchUi("/alice/wave17many/branches?page=2");
    expect(page2.status).toBe(200);
    const secondHtml = await page2.text();
    expect(secondHtml).toContain(">p-21<");
    expect(secondHtml).toContain('href="/alice/wave17many/pulls/1"');
    expect(secondHtml).toContain('class="ui red large label"');
    expect(secondHtml).toContain(">Closed</a>");
    expect(secondHtml).toContain("octicon-git-pull-request-closed");
    expect(secondHtml).not.toContain("Included</span>"); // p-21's PR takes the arm
  });

  it("renders no controls for a signed-in non-writer", async () => {
    const fixture = await ensureWave17Fixtures();
    const res = await fetchUi("/alice/wave17br/branches", withCookie(fixture.bobCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Default Branch");
    expect(html).not.toContain('action="/alice/wave17br/branches/delete"');
    expect(html).not.toContain("Switch Default Branch");
    // The writer block (create/rename) is equally absent for a non-writer —
    // the PR column's reader labels still render.
    expect(html).not.toContain('name="new_branch_name"');
    expect(html).not.toContain('action="/alice/wave17br/branches/rename"');
    expect(html).toContain('class="ui green large label"'); // feature/one's open PR
    expect(html).toContain(">Compare</span>"); // docs-seed's compare arm, CanPull false
  });

  it("filters by the ?q= keyword and keeps the default section", async () => {
    const res = await fetchUi("/alice/wave17br/branches?q=feature");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="branches-default-branch-list"');
    expect(html).toContain('href="/alice/wave17br/src/branch/feature/one"');
    expect(html).not.toContain('href="/alice/wave17br/src/branch/docs-seed"');
    expect(html).not.toContain('href="/alice/wave17br/src/branch/stale"');
    expect(html).toContain('value="feature"');
  });

  it("paginates at BranchesRangeSize (20) with the Older/Newer pager", async () => {
    const first = await fetchUi("/alice/wave17many/branches");
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml.split("branch-name").length - 1).toBe(21); // 20 rows + the default row's anchor class
    expect(firstHtml).toContain("page=2");
    expect(firstHtml).toContain("Older");
    // Page 1 carries p-01..p-18 (sorted: main excluded, then the p-* names).
    expect(firstHtml).toContain(">p-01<");
    expect(firstHtml).not.toContain(">p-21<");

    const second = await fetchUi("/alice/wave17many/branches?page=2");
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(secondHtml).toContain(">p-21<"); // the remainder renders
    expect(secondHtml).toContain("Newer");
    expect(secondHtml).not.toContain("Older"); // more=false past the end
  });

  it("renders the not-exist segment for an empty repo's default branch", async () => {
    // A row-only repo (no engine content): the D1 default branch has no ref.
    await applyAuthD1Migrations();
    const db = drizzle(env.DB);
    const alice = (await db.select().from(users).where(eq(users.usernameLower, "alice")).get())!;
    if (
      (await db
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave17empty")))
        .get()) === undefined
    ) {
      await new RepoService(env.DB).create({ owner: { id: alice.id, usernameLower: "alice" }, name: "wave17empty", isPrivate: false, status: "ready" });
    }
    const res = await fetchUi("/alice/wave17empty/branches");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-testid="branches-default-branch-not-exist"');
    expect(html).toContain("Default branch &quot;main&quot; does not exist.");
  });

  it("renders the deletion flashes from the display-only params", async () => {
    const success = await fetchUi("/alice/wave17br/branches?deleted=stale");
    expect(await success.text()).toContain('Branch &quot;stale&quot; has been deleted.');
    const refused = await fetchUi("/alice/wave17br/branches?delete_error=protected&name=docs-seed");
    expect(await refused.text()).toContain('Branch &quot;docs-seed&quot; is protected. It cannot be deleted.');
    const defaulted = await fetchUi("/alice/wave17br/branches?delete_error=default&name=main");
    expect(await defaulted.text()).toContain("is the default or pull request target branch");
  });
});

// --- the delete write ------------------------------------------------------------

describe("POST /{owner}/{repo}/branches/delete (the write)", () => {
  it("deletes a deletable branch through the landed arm, webhook and flash riding", async () => {
    const fixture = await ensureWave17Fixtures();
    const res = await fetchUi(
      "/alice/wave17br/branches/delete",
      formPost("/alice/wave17br/branches/delete", { name: "stale" }, fixture.aliceCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave17br/branches?deleted=stale");
    // The ref is gone from the engine.
    const refNames = (await env.REPO.getByName("alice/wave17br").listRefs()).refs.map((ref) => ref.name);
    expect(refNames).not.toContain("refs/heads/stale");
    // The flash renders on the redirect target.
    const list = await fetchUi("/alice/wave17br/branches?deleted=stale", withCookie(fixture.aliceCookie));
    expect(await list.text()).toContain('Branch &quot;stale&quot; has been deleted.');
  });

  it("deletes through an armed protection rule (upstream's CanUserDelete arm)", async () => {
    const fixture = await ensureWave17Fixtures();
    const res = await fetchUi(
      "/alice/wave17br/branches/delete",
      formPost("/alice/wave17br/branches/delete", { name: "release/1" }, fixture.aliceCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave17br/branches?deleted=release%2F1");
    const refNames = (await env.REPO.getByName("alice/wave17br").listRefs()).refs.map((ref) => ref.name);
    expect(refNames).not.toContain("refs/heads/release/1");
  });

  it("refuses the default branch, a disarmed protected branch, and a missing name", async () => {
    const fixture = await ensureWave17Fixtures();
    const defaulted = await fetchUi(
      "/alice/wave17br/branches/delete",
      formPost("/alice/wave17br/branches/delete", { name: "main" }, fixture.aliceCookie),
    );
    expect(defaulted.status).toBe(303);
    expect(defaulted.headers.get("location")).toBe("/alice/wave17br/branches?delete_error=default&name=main");

    const refused = await fetchUi(
      "/alice/wave17br/branches/delete",
      formPost("/alice/wave17br/branches/delete", { name: "docs-seed" }, fixture.aliceCookie),
    );
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toBe("/alice/wave17br/branches?delete_error=protected&name=docs-seed");

    const missing = await fetchUi(
      "/alice/wave17br/branches/delete",
      formPost("/alice/wave17br/branches/delete", { name: "ghost" }, fixture.aliceCookie),
    );
    expect(missing.status).toBe(404);

    // Every refusal left the refs intact.
    const refNames = (await env.REPO.getByName("alice/wave17br").listRefs()).refs.map((ref) => ref.name);
    expect(refNames).toContain("refs/heads/main");
    expect(refNames).toContain("refs/heads/docs-seed");
  });

  it("gates the write: anonymous 303, non-writer 404, cross-origin 403, GET 405", async () => {
    const fixture = await ensureWave17Fixtures();
    const anon = await fetchUi("/alice/wave17br/branches/delete", formPost("/alice/wave17br/branches/delete", { name: "feature/one" }));
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fwave17br%2Fbranches%2Fdelete");

    const pal = await fetchUi(
      "/alice/wave17br/branches/delete",
      formPost("/alice/wave17br/branches/delete", { name: "feature/one" }, fixture.bobCookie),
    );
    expect(pal.status).toBe(404);

    const crossOrigin = await fetchUi(
      "/alice/wave17br/branches/delete",
      formPost("/alice/wave17br/branches/delete", { name: "feature/one" }, fixture.aliceCookie, "https://evil.example"),
    );
    expect(crossOrigin.status).toBe(403);

    const wrongMethod = await fetchUi("/alice/wave17br/branches/delete");
    expect(wrongMethod.status).toBe(405);

    // The gated attempts deleted nothing.
    const refNames = (await env.REPO.getByName("alice/wave17br").listRefs()).refs.map((ref) => ref.name);
    expect(refNames).toContain("refs/heads/feature/one");
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-17 a11y smoke", () => {
  it("every new page passes the structural rules for its viewer", async () => {
    const fixture = await ensureWave17Fixtures();
    for (const [path, init] of [
      ["/alice/wave17br/branches", undefined],
      ["/alice/wave17br/branches", withCookie(fixture.aliceCookie)],
      ["/alice/wave17br/branches?q=feature", undefined],
      ["/alice/wave17many/branches?page=2", undefined],
      ["/alice/wave17empty/branches", undefined],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
