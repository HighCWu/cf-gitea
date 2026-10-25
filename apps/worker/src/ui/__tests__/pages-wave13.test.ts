/**
 * Pages wave 13 route tests (SPEC-0008 U3 extension): the compare family —
 * the comparison view (`/{owner}/{repo}/compare[/{base}...{head}]`, the
 * FIRST-`...` split) and the INLINE new-PR form whose POST rides the same
 * URL (upstream CompareDiff + CompareAndPullRequestPost, web.go:1307-1315;
 * pages/compare.tsx's header cites the landed arms line by line).
 *
 * Same harness posture as pages-wave2..12: the router is driven directly
 * with the synthetic ASSETS manifest over REAL pushed engine content
 * (testing/seed-repo.ts) — main + two ahead branches + an unrelated-root
 * orphan + a tag at main's tip, and one OPEN PR row between main and the
 * deploy branch (the has-PR / duplicate arms) — everything seeded through
 * the landed receive flow and services with fixed values, identities riding
 * minted session cookies.
 *
 * Gate posture under test: the page reads for every viewer who can see the
 * repo (anonymous included); the FORM and the POST are writer-gated
 * (`canWriteRepo` — the file-editor predicate, the documented divergence
 * from upstream's reqUnitPullsReader); the create arms run in the landed
 * API route's order (same-branch 422 message, no common history, equal
 * tips, non-branch pairs, duplicate open PR, empty title), success 303s
 * onto the created PR's detail page with the refs/pull/N/head ref landed.
 */

import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { pullRequests, repositories, users } from "../../db/schema";
import { findPullRequestByIndex } from "../../api/services/pulls";
import { IssuesService } from "../../issues/service";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";
import { buildHistoryPack, buildReceivePackBody, ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";

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
  body: new URLSearchParams(body).toString(),
});

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

// --- fixtures -----------------------------------------------------------------

const README = "# cmp repo\n\nShared base content.\n";
const GUIDE = "# Guide\n\nBase guide text.\n";

const MAIN_COMMITS: SeedCommit[] = [
  { message: "initial commit: add the readme", time: T0, files: [{ path: "README.md", content: README }] },
  {
    message: "docs: describe the seed",
    time: T0 + 60,
    files: [
      { path: "README.md", content: README },
      { path: "docs/guide.md", content: GUIDE },
    ],
  },
];

/** One commit ahead of main, WITH a message body (the single-commit body
 *  prefill arm). */
const DOCS_TIP: SeedCommit = {
  message: "docs: single change\n\nThe body line rides the prefill.",
  time: T0 + 120,
  files: [
    { path: "README.md", content: README },
    { path: "docs/guide.md", content: `${GUIDE}Docs change line.\n` },
  ],
};

/** Two commits ahead of main (the multi-commit range + the fixture PR's head). */
const DEPLOY_TIP_1: SeedCommit = {
  message: "deploy: add the pipeline",
  time: T0 + 180,
  files: [
    { path: "README.md", content: README },
    { path: "docs/guide.md", content: GUIDE },
    { path: "deploy.yml", content: "on: push\n" },
  ],
};
const DEPLOY_TIP_2: SeedCommit = {
  message: "deploy: tune the config",
  time: T0 + 240,
  files: [
    { path: "README.md", content: README },
    { path: "docs/guide.md", content: GUIDE },
    { path: "deploy.yml", content: "on: push\nconcurrency: cmp\n" },
  ],
};

/** An UNRELATED root — the no-common-history arm. */
const ORPHAN_COMMITS: SeedCommit[] = [
  { message: "orphan: unrelated root", time: T0 + 300, files: [{ path: "only.txt", content: "orphan\n" }] },
];

interface Wave13Fixture {
  aliceCookie: string;
  palCookie: string; // a signed-in NON-writer
  repoId: string;
  docsTipOid: string;
  mainTipOid: string;
  fixturePrIndex: number;
}

let wave13Fixture: Wave13Fixture | null = null;

/** Push one branch (full pack, the real receive flow) — idempotent by ref
 *  existence, the seedGoldenPullDiff guard pattern. */
async function pushBranch(
  slug: string,
  ref: string,
  commits: SeedCommit[],
  tokenName: string,
  userId: number,
): Promise<string[]> {
  const refs = await env.REPO.getByName(`alice/${slug}`).listRefs();
  const refNames = new Set((refs?.refs ?? []).map((entry) => entry.name));
  if (refNames.has(ref)) {
    const { tips } = await buildHistoryPack(commits);
    return tips;
  }
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?").bind(userId, tokenName).run();
  const token = (await mintFor(userId, tokenName, "write:repository")).plaintext;
  const { tips, pack } = await buildHistoryPack(commits);
  const response = await SELF.fetch(`https://test.local/alice/${slug}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody([{ ref, oid: tips[tips.length - 1] as string }], pack),
  });
  const body = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || body.includes("ng ")) {
    throw new Error(`wave13 branch push failed (${ref}): ${response.status} ${body.slice(0, 400)}`);
  }
  return tips;
}

async function ensureWave13Fixtures(): Promise<Wave13Fixture> {
  if (wave13Fixture !== null) return wave13Fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "wave13pal")).get()) === undefined) {
    await seedVerifiedUser({ username: "wave13pal" });
  }
  const pal = (await db.select().from(users).where(eq(users.usernameLower, "wave13pal")).get())!;

  // The base repo: main + the v1 tag AT main's tip (the same-tip tag state).
  // (ensureSeededRepo seeds the alice owner row when missing.)
  const seeded = await ensureSeededRepo({
    owner: "alice",
    slug: "cmp",
    commits: MAIN_COMMITS,
    tags: [{ name: "v1", commitIndex: 1 }],
  });
  const alice = (await db.select().from(users).where(eq(users.usernameLower, "alice")).get())!;

  // The ahead branches (full packs; the first two commits are byte-identical
  // to MAIN_COMMITS → the same oids, so main's tip is the merge base).
  const docsTips = await pushBranch("cmp", "refs/heads/feature/docs", [...MAIN_COMMITS, DOCS_TIP], "ui-page-seed-cmp-docs", alice.id);
  const deployTips = await pushBranch(
    "cmp",
    "refs/heads/feature/deploy",
    [...MAIN_COMMITS, DEPLOY_TIP_1, DEPLOY_TIP_2],
    "ui-page-seed-cmp-deploy",
    alice.id,
  );
  // The unrelated root (its own pack — a self-contained second root).
  await pushBranch("cmp", "refs/heads/orphan", ORPHAN_COMMITS, "ui-page-seed-cmp-orphan", alice.id);

  const repoRow = (
    await db
      .select({ id: repositories.id, visibility: repositories.visibility })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "cmp")))
      .get()
  )!;
  if (repoRow.visibility !== "public") {
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, repoRow.id));
  }

  // The OPEN PR between main and the deploy branch (the has-PR segment +
  // the duplicate-create arm). headSha = the pushed deploy tip.
  let fixturePr = await findPullRequestByIndex(env.DB, repoRow.id, 1);
  if (fixturePr === null) {
    await new IssuesService(env.DB).createPullRequest({
      repoId: repoRow.id,
      headRepoId: repoRow.id,
      baseBranch: "main",
      headBranch: "feature/deploy",
      title: "deploy: the fixture PR",
      posterId: alice.id,
      headSha: deployTips[deployTips.length - 1],
      now: t(400),
    });
    fixturePr = await findPullRequestByIndex(env.DB, repoRow.id, 1);
    if (fixturePr === null) throw new Error("wave13 fixture PR row missing after create");
  }

  wave13Fixture = {
    aliceCookie: await mintSession(env.DB, alice.id),
    palCookie: await mintSession(env.DB, pal.id),
    repoId: repoRow.id,
    docsTipOid: docsTips[docsTips.length - 1] as string,
    mainTipOid: seeded.tips[seeded.tips.length - 1] as string,
    fixturePrIndex: fixturePr.pullRequest.index,
  };
  return wave13Fixture;
}

beforeAll(async () => {
  await ensureWave13Fixtures();
});

// --- the parsers (the single owner of the route shapes) -------------------------

describe("wave-13 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the bare URL, the ... split, and the single-ref form", () => {
    expect(parseUiRoute("/alice/cmp/compare")).toEqual({ family: "compare", owner: "alice", repo: "cmp", base: null, head: null });
    expect(parseUiRoute("/alice/cmp/compare/main...feature/docs")).toEqual({
      family: "compare",
      owner: "alice",
      repo: "cmp",
      base: "main",
      head: "feature/docs",
    });
    // Slash-bearing refnames: the decoded tail splits on the FIRST separator.
    expect(parseUiRoute("/alice/cmp/compare/main...feature/docs/deep")).toEqual({
      family: "compare",
      owner: "alice",
      repo: "cmp",
      base: "main",
      head: "feature/docs/deep",
    });
    // Empty sides fall back to the default branch at load (the parser keeps
    // the nulls).
    expect(parseUiRoute("/alice/cmp/compare/...feature/docs")).toEqual({
      family: "compare",
      owner: "alice",
      repo: "cmp",
      base: null,
      head: "feature/docs",
    });
    expect(parseUiRoute("/alice/cmp/compare/main...")).toEqual({
      family: "compare",
      owner: "alice",
      repo: "cmp",
      base: "main",
      head: null,
    });
    // The single-ref form: the whole tail is the HEAD (upstream's family).
    expect(parseUiRoute("/alice/cmp/compare/main")).toEqual({
      family: "compare",
      owner: "alice",
      repo: "cmp",
      base: null,
      head: "main",
    });
    expect(handlesUiRoute("/alice/cmp/compare/main...feature/docs")).toBe(true);
    // The trailing-slash form classifies to the same shape (the middleware
    // 301s it to the canonical URL).
    expect(parseUiRoute("/alice/cmp/compare/")).toEqual({ family: "compare", owner: "alice", repo: "cmp", base: null, head: null });
  });

  it("leaves the .. family, fork forms, and junk with the engine", () => {
    // The two-dot (DirectComparison) family is not a landed surface.
    expect(parseUiRoute("/alice/cmp/compare/main..feature/docs")).toBeNull();
    // Fork-form heads (colon-bearing sides) — forks cannot exist yet.
    expect(parseUiRoute("/alice/cmp/compare/main...alice/cmp:feature/docs")).toBeNull();
    expect(parseUiRoute("/alice/cmp/compare/other:main...feature/docs")).toBeNull();
    // Deeper junk: an empty tail segment never parses.
    expect(parseUiRoute("/alice/cmp/compare/main//docs")).toBeNull();
  });
});

// --- the comparison view ---------------------------------------------------------

describe("GET /{owner}/{repo}/compare/{base}...{head} (the comparison view)", () => {
  it("renders the signed-in writer view: form, prefill, summary, commits, diff", async () => {
    const fixture = await ensureWave13Fixtures();
    const res = await fetchUi("/alice/cmp/compare/main...feature/docs", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    // The discriminator + the pull-flavored head (upstream compare.tmpl:2,9-11).
    expect(html).toContain("page-content repository diff compare pull");
    expect(html).toContain("Comparing changes");
    expect(html).toContain("merge into:"); // repo.pulls.compare_base
    expect(html).toContain("pull from:"); // repo.pulls.compare_compare
    // The selectors carry both universes; the switch link swaps the pair.
    expect(html).toContain(">alice/cmp:main</a>");
    expect(html).toContain(">alice/cmp:feature/docs</a>");
    expect(html).toContain(">alice/cmp:v1</a>"); // tags list in the dropdowns
    expect(html).toContain('href="/alice/cmp/compare/feature/docs...main"'); // switch head and base
    // The INLINE form (upstream's flow shape — the action is the compare URL).
    expect(html).toContain('action="/alice/cmp/compare/main...feature/docs" method="post"');
    // The prefill: the range's FIRST (oldest) commit subject + its body.
    expect(html).toContain('value="docs: single change"');
    expect(html).toContain("The body line rides the prefill.");
    // The base/head summary (the brief's arm).
    expect(html).toContain("alice/cmp:main");
    // The commits table: one commit + the sha pair labels.
    expect(html).toContain("1 Commits");
    expect(html).toContain('class="ui green sha label tw-mx-0"');
    expect(html).toContain("docs: single change</a>"); // the commit row subject
    // The diff box: the changed file renders through the pull-files box DOM.
    expect(html).toContain('id="diff-file-boxes"');
    expect(html).toContain(">docs/guide.md</a>");
    expect(html).toContain("diff-file-box file-content");
    // The submit button.
    expect(html).toContain("New Pull Request");
  });

  it("renders the anonymous comparison: no form, the code-flavored head", async () => {
    await ensureWave13Fixtures();
    const res = await fetchUi("/alice/cmp/compare/main...feature/docs");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content repository diff compare pull");
    expect(html).toContain("Compare commits"); // action.compare_commits_general
    expect(html).not.toContain("New Pull Request");
    expect(html).not.toContain('id="new-issue"');
    // The commits + diff still render for the reader.
    expect(html).toContain("1 Commits");
    expect(html).toContain('id="diff-file-boxes"');
  });

  it("renders the existing-PR segment for a pair whose PR is open", async () => {
    const fixture = await ensureWave13Fixtures();
    const res = await fetchUi("/alice/cmp/compare/main...feature/deploy", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    // The has-PR segment (compare.tmpl:185-195): title, index, the View link.
    expect(html).toContain("deploy: the fixture PR");
    expect(html).toContain("#1");
    expect(html).toContain('href="/alice/cmp/pulls/1"');
    expect(html).toContain("View Pull Request");
    // The form never renders beside an existing PR.
    expect(html).not.toContain("pullrequest-form");
    // The diff still renders below the segment.
    expect(html).toContain('id="diff-file-boxes"');
    expect(html).toContain("2 Commits");
  });

  it("blocks creation honestly for the degenerate pairs", async () => {
    const fixture = await ensureWave13Fixtures();
    // Same tip, both branches: the nothing-to-compare message.
    const same = await fetchUi("/alice/cmp/compare/main...main", withCookie(fixture.aliceCookie));
    expect(same.status).toBe(200);
    expect(await same.text()).toContain("There are no differences to show. There is no need to create a pull request.");
    // Same tip through the TAG: the have-tag variant.
    const tag = await fetchUi("/alice/cmp/compare/main...v1", withCookie(fixture.aliceCookie));
    expect(tag.status).toBe(200);
    const tagHtml = await tag.text();
    expect(tagHtml).toContain("There are no differences to show between the selected branches or tags.");
    expect(tagHtml).not.toContain("diff-detail-box"); // no commits table, no diff
    expect(tagHtml).not.toContain("commits-table");
    // Unrelated roots: the same honest segment (no diff box to render).
    const orphan = await fetchUi("/alice/cmp/compare/main...orphan", withCookie(fixture.aliceCookie));
    expect(orphan.status).toBe(200);
    expect(await orphan.text()).toContain("There are no differences to show. There is no need to create a pull request.");
  });

  it("renders the non-branch pairs without the form and 404-shells unresolvable sides", async () => {
    const fixture = await ensureWave13Fixtures();
    // An oid head resolves (the commit arm) but never offers the form.
    const oid = await fetchUi(`/alice/cmp/compare/main...${fixture.docsTipOid}`, withCookie(fixture.aliceCookie));
    expect(oid.status).toBe(200);
    const oidHtml = await oid.text();
    expect(oidHtml).toContain("Compare commits"); // not PageIsComparePull
    expect(oidHtml).not.toContain("New Pull Request");
    // Unresolvable sides 404-shell (ResolveRefWithSuffix's not-found arm).
    const badHead = await fetchUi("/alice/cmp/compare/main...nope", withCookie(fixture.aliceCookie));
    expect(badHead.status).toBe(404);
    const badBase = await fetchUi("/alice/cmp/compare/nope...main", withCookie(fixture.aliceCookie));
    expect(badBase.status).toBe(404);
  });

  it("renders the bare URL as the default...default comparison and paginates the range", async () => {
    const fixture = await ensureWave13Fixtures();
    // The bare pair is main...main — nothing to compare, the code-flavored
    // head (not PageIsComparePull), the plain selector labels.
    const res = await fetchUi("/alice/cmp/compare", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Compare commits");
    expect(html).toContain(">base: <strong>alice/cmp:main</strong>");
    expect(html).toContain("There are no differences to show. There is no need to create a pull request.");
    // ?page= beyond the range stays a 200 with an honest empty table.
    const paged = await fetchUi("/alice/cmp/compare/main...feature/docs?page=9", withCookie(fixture.aliceCookie));
    expect(paged.status).toBe(200);
  });
});

// --- the new-PR write ------------------------------------------------------------

describe("POST /{owner}/{repo}/compare/{base}...{head} (the new-PR write)", () => {
  it("creates through the landed service arms and 303s onto the PR page", async () => {
    const fixture = await ensureWave13Fixtures();
    const res = await fetchUi(
      "/alice/cmp/compare/main...feature/docs",
      formPost("/alice/cmp/compare/main...feature/docs", { title: "docs: the created PR", content: "Body text." }, fixture.aliceCookie),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe("/alice/cmp/pulls/2"); // the fixture PR drew index 1

    // The rows: the issue (is_pull) + the PR row (checking, headSha cached).
    const joined = await findPullRequestByIndex(env.DB, fixture.repoId, 2);
    expect(joined).not.toBeNull();
    expect(joined?.issue.title).toBe("docs: the created PR");
    expect(joined?.issue.content).toBe("Body text.");
    expect(joined?.pullRequest.headBranch).toBe("feature/docs");
    expect(joined?.pullRequest.baseBranch).toBe("main");
    expect(joined?.pullRequest.headSha).toBe(fixture.docsTipOid);

    // The head ref landed (the refs/pull/N/head CAS write).
    const refs = await env.REPO.getByName("alice/cmp").listRefs();
    expect((refs?.refs ?? []).map((entry) => entry.name)).toContain("refs/pull/2/head");

    // The created PR's page renders (the 303 target).
    const detail = await fetchUi(location, withCookie(fixture.aliceCookie));
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain("docs: the created PR");
  });

  it("re-renders the duplicate arm with the landed 409 message", async () => {
    const fixture = await ensureWave13Fixtures();
    const res = await fetchUi(
      "/alice/cmp/compare/main...feature/deploy",
      formPost("/alice/cmp/compare/main...feature/deploy", { title: "deploy: again" }, fixture.aliceCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("pull request already exists for these targets");
    // The pair's PR already exists, so the page arms to the has-PR segment —
    // the refusal rides the error message, not a form re-render.
    expect(html).toContain("View Pull Request");
  });

  it("blocks the degenerate pairs per the service's arms", async () => {
    const fixture = await ensureWave13Fixtures();
    // Same-branch: the landed 422 message.
    const same = await fetchUi(
      "/alice/cmp/compare/main...main",
      formPost("/alice/cmp/compare/main...main", { title: "Same" }, fixture.aliceCookie),
    );
    expect(same.status).toBe(200);
    expect(await same.text()).toContain("Invalid PullRequest: There are no changes between the head and the base");
    // No common history: upstream's no_common_history message.
    const orphan = await fetchUi(
      "/alice/cmp/compare/main...orphan",
      formPost("/alice/cmp/compare/main...orphan", { title: "Orphan" }, fixture.aliceCookie),
    );
    expect(orphan.status).toBe(200);
    expect(await orphan.text()).toContain("These branches do not share a common merge base.");
    // A non-branch pair never creates.
    const tag = await fetchUi(
      "/alice/cmp/compare/main...v1",
      formPost("/alice/cmp/compare/main...v1", { title: "Tagged" }, fixture.aliceCookie),
    );
    expect(tag.status).toBe(200);
    expect(await tag.text()).toContain("There are no differences to show between the selected branches or tags.");
    // The empty title re-renders (the new-issue convention) with the kept
    // body — the form still renders for this creatable pair (the REVERSE
    // direction: the create test above already put a PR on docs→main).
    const empty = await fetchUi(
      "/alice/cmp/compare/feature/docs...main",
      formPost("/alice/cmp/compare/feature/docs...main", { title: "", content: "the kept body" }, fixture.aliceCookie),
    );
    expect(empty.status).toBe(200);
    const emptyHtml = await empty.text();
    expect(emptyHtml).toContain("A title is required.");
    expect(emptyHtml).toContain("the kept body");
  });

  it("gates the write: anonymous 303, non-writer 404, cross-origin 403", async () => {
    const fixture = await ensureWave13Fixtures();
    // The create test ran first (file-order storage) — the refusals below
    // must add nothing to that baseline.
    const before = (
      await drizzle(env.DB)
        .select({ id: pullRequests.id })
        .from(pullRequests)
        .where(eq(pullRequests.baseRepoId, fixture.repoId))
        .all()
    ).length;
    const anon = await fetchUi(
      "/alice/cmp/compare/main...feature/docs",
      formPost("/alice/cmp/compare/main...feature/docs", { title: "Nope" }),
    );
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login?redirect_to=");

    const pal = await fetchUi(
      "/alice/cmp/compare/main...feature/docs",
      formPost("/alice/cmp/compare/main...feature/docs", { title: "Nope" }, fixture.palCookie),
    );
    expect(pal.status).toBe(404);

    const crossOrigin = await fetchUi(
      "/alice/cmp/compare/main...feature/docs",
      formPost("/alice/cmp/compare/main...feature/docs", { title: "Nope" }, fixture.aliceCookie, "https://evil.example"),
    );
    expect(crossOrigin.status).toBe(403);

    // The refusals wrote nothing.
    const after = (
      await drizzle(env.DB)
        .select({ id: pullRequests.id })
        .from(pullRequests)
        .where(eq(pullRequests.baseRepoId, fixture.repoId))
        .all()
    ).length;
    expect(after).toBe(before);
  });

  it("answers the bare URL's POST and the GET on the POST family with chi's shapes", async () => {
    const fixture = await ensureWave13Fixtures();
    const barePost = await fetchUi("/alice/cmp/compare", formPost("/alice/cmp/compare", { title: "Nope" }, fixture.aliceCookie));
    expect(barePost.status).toBe(405);
    const tailGet = await fetchUi("/alice/cmp/compare/main...feature/docs", { method: "POST" });
    // The POST without a form body re-renders through the arms (empty title
    // for an anonymous viewer is the login 303 — the gate runs first).
    expect(tailGet.status).toBe(303);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-13 a11y smoke", () => {
  it("every new page passes the structural rules for its gate-admitted viewer", async () => {
    const fixture = await ensureWave13Fixtures();
    for (const [path, init] of [
      ["/alice/cmp/compare/main...feature/docs", withCookie(fixture.aliceCookie)],
      ["/alice/cmp/compare/main...feature/docs", undefined],
      ["/alice/cmp/compare/main...feature/deploy", withCookie(fixture.aliceCookie)],
      ["/alice/cmp/compare/main...v1", undefined],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
