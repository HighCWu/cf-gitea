/**
 * Pages wave 5 route tests (SPEC-0008 U3 extension): the detail-page write
 * paths — the comment POST (+ its `status` close/reopen rider), the sidebar
 * label write — and the PR files diff view (pages/issue-detail.tsx +
 * pages/pull-files.tsx).
 *
 * Same harness posture as pages-wave4: the router is driven directly with
 * the synthetic ASSETS manifest, fixtures seed through the landed services
 * with fixed `now` values, and identities ride minted session cookies. The
 * "wave5" repo carries REAL pushed engine content (its own receive-pack,
 * seed-repo.ts's exported primitives) so the files page composes the same
 * `merge_base...refs/pull/N/head` range the API diff routes serve; a
 * row-only sibling covers the write negative paths.
 *
 * Write posture under test (the wave-4 order, per action): sameOriginGuard
 * FIRST, then repo resolution (invisible repos 404 before any redirect),
 * then the viewer/predicate gates, then the landed service, then the 303.
 */

import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { findRepoLabelByName, createRepoLabel } from "../../api/services/labels";
import { issueLabels, issues, labels, repositories, users } from "../../db/schema";
import { uiRouter } from "../index";
import { IssuesService } from "../../issues/service";
import {
  buildHistoryPack,
  buildReceivePackBody,
  ensureSeededRepo,
  type SeedCommit,
} from "../testing/seed-repo";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

/** A form POST with the browser's Origin header (the §2.8 guard's happy
 *  path — same-origin as the router fixture origin). */
function formPost(fields: Record<string, string | string[]>): RequestInit {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) params.append(key, entry);
  }
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://test.local",
    },
    body: params.toString(),
  };
}

const withCookie = (init: RequestInit, cookie: string): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

// --- fixtures -----------------------------------------------------------------

const WAVE5_COMMITS: SeedCommit[] = [
  { message: "c1: base readme", time: T0, files: [{ path: "README.md", content: "# wave5\n" }] },
  {
    message: "c2: add app",
    time: T0 + 60,
    files: [
      { path: "README.md", content: "# wave5\n" },
      { path: "app.ts", content: "export const v = 1;\n" },
    ],
  },
  {
    message: "c3: change app, add docs",
    time: T0 + 120,
    files: [
      { path: "README.md", content: "# wave5\n" },
      { path: "app.ts", content: "export const v = 2;\n" },
      { path: "docs/new.md", content: "# New doc\n" },
    ],
  },
];

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

interface Wave5Fixture {
  ownerCookie: string; // alice — the repo owner
  adminCookie: string; // wave5admin — site admin
  otherCookie: string; // wave5bob — unrelated viewer, poster of issue #2
  bugLabelId: number;
}

let wave5Fixture: Wave5Fixture | null = null;

/**
 * Seed the wave-5 block: the engine repo (main at c1, feature at c3, the PR
 * head ref at c3 — the diff range is the c1..c3 two-file delta), PR #1 over
 * it, plain issue #2 (posted by bob — the poster-state grant case), a bug
 * label, and the three identities.
 *
 * The engine refs push ONCE (guarded on refs.head like seed-repo); the D1
 * issue block is idempotent like the wave-4 fixtures.
 */
async function ensureWave5Fixtures(): Promise<Wave5Fixture> {
  if (wave5Fixture !== null) return wave5Fixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();
  // The owner row FIRST (my engine push must precede ensureSeededRepo so the
  // seeded main lands at MY tip choice — see the push below).
  await seedVerifiedUser({ username: "alice" });
  const owner = await db.select().from(users).where(eq(users.usernameLower, "alice")).get();
  if (owner === undefined) throw new Error("wave5 owner row missing");

  // The engine side of the diff fixture: main sits at c1 (the merge base),
  // feature + the PR head ref at c3. Pushed through the REAL receive flow
  // (the seed token pattern — a fresh mint under a wave-5 name) BEFORE
  // ensureSeededRepo, whose own push is then skipped (refs.head is set) and
  // which only settles the push-created D1 row public.
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner.id, "ui-page-seed-wave5-refs")
    .run();
  const token = (await mintFor(owner.id, "ui-page-seed-wave5-refs", "write:repository")).plaintext;
  const refs = await env.REPO.getByName("alice/wave5").listRefs();
  const refNames = new Set((refs?.refs ?? []).map((ref) => ref.name));
  if (!refNames.has("refs/pull/1/head")) {
    const { tips, pack } = await buildHistoryPack(WAVE5_COMMITS);
    // First run: main does not exist yet — seed it at the merge base too.
    // Recovery run (engine persisted, D1 rolled back or reordered): main
    // already points at the merge base (only this fixture ever pushes it),
    // and the feature/pull refs are simply missing — add them.
    const updates = refNames.has("refs/heads/main")
      ? [
          { ref: "refs/heads/feature", oid: tips[2] as string },
          { ref: "refs/pull/1/head", oid: tips[2] as string },
        ]
      : [
          { ref: "refs/heads/main", oid: tips[0] as string },
          { ref: "refs/heads/feature", oid: tips[2] as string },
          { ref: "refs/pull/1/head", oid: tips[2] as string },
        ];
    const response = await SELF.fetch("https://test.local/alice/wave5.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
      body: buildReceivePackBody(updates, pack),
    });
    const body = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    if (response.status !== 200 || body.includes("ng ")) {
      throw new Error(`wave5 ref push failed: ${response.status} ${body.slice(0, 400)}`);
    }
  }
  await ensureSeededRepo({ owner: "alice", slug: "wave5", commits: WAVE5_COMMITS });

  // The D1 issue block: PR #1 (head feature → base main), issue #2 (bob's —
  // the poster grant), the shared bug label.
  const repo = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave5")))
    .get();
  if (repo === undefined) throw new Error("wave5 repo row missing");
  for (const extra of [
    { username: "wave5admin", isAdmin: true },
    { username: "wave5bob", isAdmin: false },
  ]) {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra.username)).get();
    if (existing === undefined) {
      await db.insert(users).values({
        username: extra.username,
        usernameLower: extra.username,
        isAdmin: extra.isAdmin,
        status: "active",
        visibility: "public",
        createdAt: new Date(),
      });
    }
  }
  const admin = await db.select().from(users).where(eq(users.usernameLower, "wave5admin")).get();
  const bob = await db.select().from(users).where(eq(users.usernameLower, "wave5bob")).get();
  if (admin === undefined || bob === undefined) throw new Error("wave5 identity rows missing");

  const svc = new IssuesService(env.DB);
  const existingIssue = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, repo.id)).limit(1).get();
  let bugLabelId: number;
  const existingLabel = await findRepoLabelByName(env.DB, repo.id, "bug");
  if (existingIssue === undefined || existingLabel === null) {
    const bug = await createRepoLabel(env.DB, repo.id, {
      name: "bug",
      exclusive: false,
      color: "#ee0701",
      description: "Something is broken",
      isArchived: false,
      now: t(0),
    });
    await svc.createPullRequest({
      repoId: repo.id,
      title: "wave5: feature change",
      content: "Changes the app.",
      posterId: owner.id,
      headRepoId: repo.id,
      baseBranch: "main",
      headBranch: "feature",
      now: t(10),
    });
    await svc.createIssue({ repoId: repo.id, title: "wave5: bob's issue", posterId: bob.id, now: t(20) });
    bugLabelId = bug.id;
  } else {
    bugLabelId = existingLabel.id;
  }

  wave5Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    adminCookie: await mintSession(env.DB, admin.id),
    otherCookie: await mintSession(env.DB, bob.id),
    bugLabelId,
  };
  return wave5Fixture;
}

beforeAll(async () => {
  await ensureWave5Fixtures();
});

// --- the comment POST ------------------------------------------------------------

describe("comment POST (/{issues|pulls}/{index}/comments)", () => {
  it("403s a cross-origin POST before any repo work (§2.8 layer 2)", async () => {
    const res = await fetchUi("/alice/wave5/issues/2/comments", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ content: "cross-origin" }).toString(),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
  });

  it("303s an anonymous POST onto the login round-trip (no write)", async () => {
    const res = await fetchUi("/alice/wave5/issues/2/comments", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ content: "anonymous" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fwave5%2Fissues%2F2%2Fcomments");
  });

  it("GET answers chi's 405 (POST-only family)", async () => {
    const res = await fetchUi("/alice/wave5/issues/2/comments");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("creates through the landed service and 303s onto the comment anchor", async () => {
    const fixture = await ensureWave5Fixtures();
    const res = await fetchUi(
      "/alice/wave5/issues/2/comments",
      withCookie(formPost({ content: "A **web** comment." }), fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/alice\/wave5\/issues\/2#issuecomment-\d+$/);

    // The comment renders through the §3.4 pipeline on the detail page.
    const html = await (await fetchUi("/alice/wave5/issues/2")).text();
    expect(html).toContain("A <strong>web</strong> comment.");
    const anchor = location.split("#")[1] ?? "";
    expect(html).toContain(`id="${anchor}"`);
  });

  it("re-renders at 200 with the upstream empty-comment message (no row)", async () => {
    const fixture = await ensureWave5Fixtures();
    const before = await drizzle(env.DB).select({ id: issues.id, num: issues.numComments }).from(issues).all();
    const res = await fetchUi(
      "/alice/wave5/issues/2/comments",
      withCookie(formPost({ content: "" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">No comment provided.</div>');
    // The empty draft round-trips as the (empty) textarea; the form stays.
    expect(html).toContain('<form class="ui form" id="comment-form" action="/alice/wave5/issues/2/comments" method="post">');
    const after = await drizzle(env.DB).select({ id: issues.id, num: issues.numComments }).from(issues).all();
    expect(after).toEqual(before);
  });

  it("rides the status field: close through the landed transition, 303 back, then reopen", async () => {
    const fixture = await ensureWave5Fixtures();
    const close = await fetchUi(
      "/alice/wave5/issues/2/comments",
      withCookie(formPost({ content: "", status: "close" }), fixture.ownerCookie),
    );
    expect(close.status).toBe(303);
    expect(close.headers.get("location")).toBe("/alice/wave5/issues/2");

    const closedHtml = await (await fetchUi("/alice/wave5/issues/2", { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` } })).text();
    expect(closedHtml).toContain("closed this issue");
    expect(closedHtml).toContain('<div class="ui red label issue-state-label">');

    // The toggle flips with the state (reopen branch: green icon, Reopen text).
    expect(closedHtml).toContain('id="status-button"');
    expect(closedHtml).toContain('<span class="status-button-text">Reopen Issue</span>');

    const reopen = await fetchUi(
      "/alice/wave5/issues/2/comments",
      withCookie(formPost({ content: "", status: "reopen" }), fixture.ownerCookie),
    );
    expect(reopen.status).toBe(303);
    const reopenedHtml = await (await fetchUi("/alice/wave5/issues/2", { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` } })).text();
    expect(reopenedHtml).toContain("reopened this issue");
    expect(reopenedHtml).toContain('<span class="status-button-text">Close Issue</span>');
  });

  it("ignores the status rider for a non-poster non-writer but still takes their comment", async () => {
    const fixture = await ensureWave5Fixtures();
    // On alice's PR, bob is neither the poster nor a writer: the rider is
    // IGNORED (upstream: the button wouldn't render for him). A status-only
    // empty POST still 303s (issue_comment.go:84-88 only rejects when NO
    // status field came) — the canonical page, state untouched.
    const stateAttempt = await fetchUi(
      "/alice/wave5/pulls/1/comments",
      withCookie(formPost({ content: "", status: "close" }), fixture.otherCookie),
    );
    expect(stateAttempt.status).toBe(303);
    expect(stateAttempt.headers.get("location")).toBe("/alice/wave5/pulls/1");

    // …and bob's comment goes through WITHOUT a state change.
    const comment = await fetchUi(
      "/alice/wave5/pulls/1/comments",
      withCookie(formPost({ content: "bob was here", status: "close" }), fixture.otherCookie),
    );
    expect(comment.status).toBe(303);
    expect(comment.headers.get("location")).toMatch(/^\/alice\/wave5\/pulls\/1#issuecomment-\d+$/);
    const html = await (await fetchUi("/alice/wave5/pulls/1")).text();
    expect(html).toContain("bob was here");
    // The PR stays OPEN (the rider was ignored).
    expect(html).toContain('<div class="ui green label issue-state-label">');
  });

  it("404-shells an unknown index", async () => {
    const fixture = await ensureWave5Fixtures();
    const res = await fetchUi(
      "/alice/wave5/issues/99/comments",
      withCookie(formPost({ content: "x" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div class="status-page-error">');
  });

  it("lands a PR comment on the PR's canonical page anchor (row family wins)", async () => {
    const fixture = await ensureWave5Fixtures();
    const res = await fetchUi(
      "/alice/wave5/pulls/1/comments",
      withCookie(formPost({ content: "PR remark" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/alice\/wave5\/pulls\/1#issuecomment-\d+$/);
  });
});

// --- the status-button + comment-form rendering gates ----------------------------

describe("detail-page write chrome", () => {
  it("anonymous sees the sign-in warning and no form (upstream shape)", async () => {
    const html = await (await fetchUi("/alice/wave5/issues/2")).text();
    expect(html).toContain('<div class="ui warning message"><a href="/login?redirect_to=%2Falice%2Fwave5%2Fissues%2F2">Sign in</a> to join this conversation.</div>');
    expect(html).not.toContain('id="comment-form"');
    expect(html).not.toContain('id="status-button"');
    expect(html).not.toContain('name="label_ids"');
  });

  it("the poster sees the status button; the unrelated viewer does not", async () => {
    const fixture = await ensureWave5Fixtures();
    // bob posted issue #2 — his form carries the toggle…
    const bobHtml = await (await fetchUi("/alice/wave5/issues/2", { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.otherCookie}` } })).text();
    expect(bobHtml).toContain('id="status-button"');
    // …while on alice's PR bob gets a form but no toggle.
    const prHtml = await (await fetchUi("/alice/wave5/pulls/1", { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.otherCookie}` } })).text();
    expect(prHtml).toContain('id="comment-form"');
    expect(prHtml).not.toContain('id="status-button"');
  });

  it("a merged PR shows the merged label only — no toggle, no merge box", async () => {
    const fixture = await ensureWave5Fixtures();
    // Merge PR #1 through the landed service (the merge-execution path needs
    // a mergeable range; the D1-only merged flag suffices for the render).
    const db = drizzle(env.DB);
    const repo = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave5")))
      .get();
    const prIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.repoId, repo?.id ?? ""), eq(issues.isPull, true)))
      .get();
    if (prIssue === undefined) throw new Error("wave5 PR row missing");
    const { pullRequests } = await import("../../db/schema");
    await db
      .update(pullRequests)
      .set({ hasMerged: true, mergedAt: t(900), mergerId: (await db.select().from(users).where(eq(users.usernameLower, "alice")).get())?.id ?? null })
      .where(eq(pullRequests.issueId, prIssue.id));
    try {
      const html = await (await fetchUi("/alice/wave5/pulls/1", { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` } })).text();
      expect(html).toContain('<div class="ui purple label issue-state-label">');
      expect(html).toContain("Merged");
      expect(html).not.toContain('id="status-button"');
      expect(html).not.toContain("pull-merge-box");
      // The comment form itself stays (comments on merged PRs are legal).
      expect(html).toContain('id="comment-form"');
    } finally {
      await db.update(pullRequests).set({ hasMerged: false, mergedAt: null, mergerId: null }).where(eq(pullRequests.issueId, prIssue.id));
    }
  });
});

// --- the label write ---------------------------------------------------------------

describe("label POST (/issues/labels)", () => {
  it("403s a cross-origin POST first, 303s anonymous onto the login round-trip", async () => {
    const cross = await fetchUi("/alice/wave5/issues/labels", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ issue_ids: "2" }).toString(),
    });
    expect(cross.status).toBe(403);

    const anon = await fetchUi("/alice/wave5/issues/labels", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ issue_ids: "2" }).toString(),
    });
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fwave5%2Fissues%2Flabels");
  });

  it("GET answers chi's 405; a non-admin viewer 404-shells", async () => {
    const fixture = await ensureWave5Fixtures();
    const get = await fetchUi("/alice/wave5/issues/labels");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");

    const other = await fetchUi(
      "/alice/wave5/issues/labels",
      withCookie(formPost({ issue_ids: "2" }), fixture.otherCookie),
    );
    expect(other.status).toBe(404);
  });

  it("replaces the label set through the landed service and re-renders the badges", async () => {
    const fixture = await ensureWave5Fixtures();
    const db = drizzle(env.DB);
    const repo = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave5")))
      .get();
    const issue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.repoId, repo?.id ?? ""), eq(issues.isPull, false)))
      .get();
    if (issue === undefined) throw new Error("wave5 plain issue missing");

    const attach = await fetchUi(
      "/alice/wave5/issues/labels",
      withCookie(formPost({ issue_ids: String(issue.id), label_ids: String(fixture.bugLabelId) }), fixture.ownerCookie),
    );
    expect(attach.status).toBe(303);
    expect(attach.headers.get("location")).toBe(`/alice/wave5/issues/${issue.index}`);

    const rows = await db.select().from(issueLabels).where(eq(issueLabels.issueId, issue.id)).all();
    expect(rows.map((row) => row.labelId)).toEqual([fixture.bugLabelId]);

    // The sidebar renders the badge (ContrastColor inline styles)…
    const html = await (await fetchUi(`/alice/wave5/issues/${issue.index}`)).text();
    expect(html).toContain("background-color: #ee0701");

    // …and resubmitting WITHOUT the checkbox detaches (the diff-based replace).
    const detach = await fetchUi(
      "/alice/wave5/issues/labels",
      withCookie(formPost({ issue_ids: String(issue.id) }), fixture.ownerCookie),
    );
    expect(detach.status).toBe(303);
    const after = await db.select().from(issueLabels).where(eq(issueLabels.issueId, issue.id)).all();
    expect(after).toHaveLength(0);
    const counter = await db.select({ num: labels.numIssues }).from(labels).where(eq(labels.id, fixture.bugLabelId)).get();
    expect(Number(counter?.num ?? 0)).toBe(0);
  });

  it("404-shells a foreign issue_ids value", async () => {
    const fixture = await ensureWave5Fixtures();
    const res = await fetchUi(
      "/alice/wave5/issues/labels",
      withCookie(formPost({ issue_ids: "999999" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(404);
  });

  it("surfaces the service's NoSuchLabel message for a foreign label id", async () => {
    const fixture = await ensureWave5Fixtures();
    const db = drizzle(env.DB);
    const repo = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave5")))
      .get();
    const issue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.repoId, repo?.id ?? ""), eq(issues.isPull, false)))
      .get();
    const res = await fetchUi(
      "/alice/wave5/issues/labels",
      withCookie(formPost({ issue_ids: String(issue?.id ?? 0), label_ids: "424242" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("label does not exist [label_id: 424242, repo_id:");
  });
});

// --- the PR files page ---------------------------------------------------------

describe("PR files page (/pulls/{index}/files)", () => {
  it("renders the upstream page frame: discriminator, title bar, files-active tab menu", async () => {
    const res = await fetchUi("/alice/wave5/pulls/1/files");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="#1 - wave5: feature change" class="page-content repository view issue pull files diff">');
    expect(html).toContain('<div class="ui container fluid padded">');
    expect(html).toContain("<h1>wave5: feature change <span class=\"index\">#1</span></h1>");
    expect(html).toContain('<a class="item" href="/alice/wave5/pulls/1">Conversation<span class="ui small label">');
    expect(html).toContain('<a class="active item" href="/alice/wave5/pulls/1/files">Files Changed<span class="ui small label">2</span></a>');
    // The summary line (upstream stats_desc, ShowDiffSummaryInToolbar branch).
    expect(html).toContain("changed files");
  });

  it("renders line-level hunks with the upstream unified DOM", async () => {
    const html = await (await fetchUi("/alice/wave5/pulls/1/files")).text();
    // One box per changed file, keyed by the sha1 NameHash shape…
    expect(html).toContain('class="diff-file-box file-content tw-mt-0"');
    expect(html).toMatch(/id="diff-[0-9a-f]{40}"/);
    // …the header DOM (name anchor + created-entry label)…
    expect(html).toContain('class="diff-file-header sticky-2nd-row ui top attached header"');
    expect(html).toContain('class="muted file-link tw-font-mono"');
    expect(html).toContain('<span class="ui label">Regular</span>');
    // …the per-file stats and the unified table skeleton…
    expect(html).toContain('class="diff-stats-add-bar"');
    expect(html).toContain('<table class="chroma">');
    expect(html).toContain('<colgroup><col width="50"/><col width="50"/><col width="10"/><col width="10"/><col/></colgroup>');
    // …hunk header rows (tag-code + blob-hunk) and add rows with the marker.
    expect(html).toContain('<tr class="tag-code" data-line-type="tag">');
    expect(html).toContain('class="chroma lines-code blob-hunk"');
    expect(html).toContain('<tr class="add-code" data-line-type="add">');
    expect(html).toContain('data-type-marker="+"');
    expect(html).toContain('<code class="code-inner">export const v = 2;</code>');
    expect(html).toContain('<code class="code-inner"># New doc</code>');
    // The `data-line-num`/`rel` anchor pairs carry the R-side numbers.
    expect(html).toMatch(/rel="diff-[0-9a-f]{40}R1"/);
    // No del rows in this range (both files are created).
    expect(html).not.toContain('data-line-type="del"');
  });

  it("404-shells an unknown index, a non-pull row, and keeps deeper tails engine-owned", async () => {
    expect((await fetchUi("/alice/wave5/pulls/99/files")).status).toBe(404);
    // Issue #2 addressed in the files family → 404 (the route is pulls-only;
    // the cross-family redirect stays the detail route's behavior).
    expect((await fetchUi("/alice/wave5/pulls/2/files")).status).toBe(404);
    // The deeper commits sub-tails stay engine-owned (the bare
    // /pulls/{index}/commits tab is its own family — pages-pull-commits.test.ts).
    const deep = await fetchUi("/alice/wave5/pulls/1/commits/nope");
    expect(deep.status).toBe(404);
    expect(await deep.text()).not.toContain("diff-file-box");
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-5 a11y smoke", () => {
  it("the files page and the signed-in detail pages pass the structural rules", async () => {
    const fixture = await ensureWave5Fixtures();
    for (const path of ["/alice/wave5/pulls/1/files", "/alice/wave5/issues/2"]) {
      const res = await fetchUi(path);
      expect(res.status).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
    // The signed-in renders (comment form + status button; the owner also
    // carries the sidebar label form).
    const authed = await fetchUi("/alice/wave5/issues/2", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(authed.status).toBe(200);
    expect(runA11y(await authed.text())).toEqual([]);
  });
});
