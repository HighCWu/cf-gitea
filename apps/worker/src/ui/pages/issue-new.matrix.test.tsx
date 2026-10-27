/**
 * The ISSUE-NEW family's DEFERRED route-level matrix (pages/new-issue.tsx —
 * the wave-4 family, `/{owner}/{repo}/issues/new` GET+POST). The coverage
 * split this file completes:
 *
 *   - ui/__tests__/pages-wave4.test.ts owns the base arms: the signed-in
 *     form render (title/textarea/label checkboxes/milestone select), the
 *     anonymous GET+POST 303s with the exact login round-trip paths, the
 *     anonymous private-repo 404 shell, the cookie-less cross-origin POST
 *     403, the happy-path create (303 onto the detail page, the rendered
 *     label badge + milestone), the empty-title re-render, and the foreign
 *     label id's IssueError re-render;
 *   - pages-wave26.test.ts pins the `?milestone=` happy preselect (the open
 *     id carries `selected`) and the milestone-detail button that emits it;
 *   - pages-wave16.test.ts pins the GET's read-gate posture status-only
 *     (a read-granted non-writer renders 200 — "the new-issue gate is not a
 *     write gate");
 *   - pages/issues-list.matrix.test.tsx owns the issues-list New button
 *     (hidden on archived repos) and the issues-vs-pulls heads' claim pin
 *     (the BARE `/pulls/new` unclaimed);
 *   - services/issue-events.test.ts owns the created issue's "opened"
 *     webhook fan-out (and its absence on the failed write).
 *
 * THIS FILE adds the arms none of those carry, driven over the mounted
 * uiRouter on the minted-session pattern (org-labels.matrix is the reference):
 *
 *   - the gates' deferred write arms: a signed-in non-writer completes the
 *     FULL round-trip (wave16 pinned the GET status only), the private repo
 *     404-shells a signed-in unrelated viewer (wave4 pinned the anonymous
 *     arm), an anonymous same-origin POST at the invisible repo 404-shells
 *     BEFORE the login 303 could leak it, and the archived twin renders the
 *     GET (the refusal is the POST's) with the empty pickers while its POST
 *     re-renders the verbatim upstream message and writes nothing;
 *   - the round-trip's deferred parser arms: the whitespace-only title
 *     trims to the required re-render, the `?milestone=` degenerate ids
 *     (non-numeric / zero / CLOSED / unknown) select nothing, and one POST
 *     pins label_ids dedupe + junk filtering, milestone_id garbage
 *     degradation and empty-content-NULL with D1 read-backs;
 *   - the CSRF guard's valid-session arm (wave4 pinned cookie-less): a
 *     cross-origin POST carrying a REAL session 403s before the write, and
 *     at the invisible repo the guard's 403 precedes the 404 shell;
 *   - the window-2e /pulls/new redirect (635ce2e): the 307's tail exactness
 *     + query preservation, the bare tail's wildcard miss, and the family's
 *     parse-claim state. THE TAIL PINS ARE RED — see the escalation comment
 *     on the describe block (two REAL bugs found, work stopped per the
 *     tests-only brief).
 *
 * Rerun posture: D1-only fixtures (the family never reads the engine),
 * unique slugs, the create targets' expected indexes computed from the live
 * row count (never hardcoded), and no test deletes a seeded row.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { createRepoLabel } from "../../api/services/labels";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { issueLabels, issues, repositories, users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { uiEnv } from "../__tests__/harness";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { RepoRow } from "../ui-context";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

/** A form POST with the browser's same-origin header (the §2.8 guard's
 *  happy path — the router fixture origin). */
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

/** The cross-origin write shape with an optional session (the guard's 403
 *  arm — the valid-session variant is this file's deferred arm). */
const crossOriginPost = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://evil.example",
    ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
  },
  body: new URLSearchParams(fields).toString(),
});

// --- fixtures (D1-only — the new-issue family never reads the engine) -------------

const OWNER = "nimx";
const REPO = "newmx"; // the round-trip + preselect repo (public, pickers loaded)
const PRIVATE_REPO = "newmx-priv"; // the existence arms
const ARCH_REPO = "newmx-arch"; // the archived twin (pickers stay empty)

interface IssueNewFixture {
  ownerCookie: string;
  otherCookie: string;
  otherId: number;
  repo: RepoRow;
  privateRepo: RepoRow;
  archRepo: RepoRow;
  bugLabelId: number;
  openMilestoneId: number;
  closedMilestoneId: number;
}

let issueNewFixture: IssueNewFixture | null = null;

async function seedRepo(owner: { id: number; usernameLower: string }, slug: string, isPrivate = false): Promise<RepoRow> {
  return new RepoService(env.DB).create({
    owner,
    name: slug,
    isPrivate,
    status: "ready",
  });
}

async function countIssues(repoId: string): Promise<number> {
  return (await drizzle(env.DB).select({ id: issues.id }).from(issues).where(eq(issues.repoId, repoId)).all()).length;
}

async function issueByIndex(repoId: string, index: number) {
  return drizzle(env.DB)
    .select()
    .from(issues)
    .where(and(eq(issues.repoId, repoId), eq(issues.index, index)))
    .get();
}

async function ensureIssueNewFixtures(): Promise<IssueNewFixture> {
  if (issueNewFixture !== null) return issueNewFixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();

  // The principals: the repo owner and an unrelated signed-in viewer (the
  // gate's non-writer arm — no grant of any kind on the fixtures).
  for (const principal of [
    { username: "nimx", isAdmin: false },
    { username: "ninobody", isAdmin: false },
  ] as const) {
    if (
      (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, principal.username)).get()) ===
      undefined
    ) {
      await seedVerifiedUser({ username: principal.username, isAdmin: principal.isAdmin });
    }
  }
  const owner = (await db.select().from(users).where(eq(users.usernameLower, "nimx")).get())!;
  const other = (await db.select().from(users).where(eq(users.usernameLower, "ninobody")).get())!;

  const ownerRef = { id: owner.id, usernameLower: owner.usernameLower };
  const repo = await seedRepo(ownerRef, REPO);
  const privateRepo = await seedRepo(ownerRef, PRIVATE_REPO, true);
  const archRepo = await seedRepo(ownerRef, ARCH_REPO);
  // The archived twin is a direct D1 stamp (RepoService always creates
  // unarchived — the issues-list matrix's pattern; the flag stays: the
  // suite wants it archived and the slug is unique to this file).
  await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, archRepo.id));

  // The pickers on the main repo: one label, one OPEN and one CLOSED
  // milestone (the ?milestone= degenerate arms).
  const svc = new IssuesService(env.DB);
  const label = await createRepoLabel(env.DB, repo.id, {
    name: "bug",
    exclusive: false,
    color: "#ee0701",
    description: "Something is broken",
    isArchived: false,
    now: new Date(1_770_000_000_000),
  });
  const open = await svc.createMilestone({ repoId: repo.id, name: "v1.0", now: new Date(1_770_000_000_000) });
  const closed = await svc.createMilestone({ repoId: repo.id, name: "v0.9", now: new Date(1_770_000_001_000) });
  await svc.updateMilestone(closed.id, { state: "closed", now: new Date(1_770_000_002_000) });

  issueNewFixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    otherCookie: await mintSession(env.DB, other.id),
    otherId: other.id,
    repo,
    privateRepo,
    archRepo,
    bugLabelId: label.id,
    openMilestoneId: open.id,
    closedMilestoneId: closed.id,
  };
  return issueNewFixture;
}

beforeAll(async () => {
  await ensureIssueNewFixtures();
});

// --- the gates' deferred write arms -------------------------------------------------

describe("the gates' deferred write arms (wave16 pinned the GET status only)", () => {
  it("a signed-in non-writer completes the FULL round-trip: the form renders and the POST files the issue under their own id", async () => {
    const fixture = await ensureIssueNewFixtures();
    const form = await fetchUi(`/${OWNER}/${REPO}/issues/new`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.otherCookie}` },
    });
    expect(form.status).toBe(200);
    expect(await form.text()).toContain(`action="/${OWNER}/${REPO}/issues/new" method="post"`);

    const before = await countIssues(fixture.repo.id);
    const res = await fetchUi(
      `/${OWNER}/${REPO}/issues/new`,
      withCookie(formPost({ title: "filed by a plain viewer" }), fixture.otherCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OWNER}/${REPO}/issues/${before + 1}`);

    const row = await issueByIndex(fixture.repo.id, before + 1);
    expect(row?.title).toBe("filed by a plain viewer");
    expect(row?.posterId).toBe(fixture.otherId); // the session viewer, not the owner
  });

  it("the private repo 404-shells a signed-in unrelated viewer (wave4 pinned the anonymous arm)", async () => {
    const fixture = await ensureIssueNewFixtures();
    const res = await fetchUi(`/${OWNER}/${PRIVATE_REPO}/issues/new`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.otherCookie}` },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div class="status-page-error">');
  });

  it("an anonymous same-origin POST at the invisible repo 404-shells BEFORE the login 303 (existence never leaks through the redirect)", async () => {
    await ensureIssueNewFixtures();
    const res = await fetchUi(`/${OWNER}/${PRIVATE_REPO}/issues/new`, formPost({ title: "anon at private" }));
    expect(res.status).toBe(404); // not the 303 an anonymous PUBLIC POST gets
    expect(await res.text()).toContain('<div class="status-page-error">');
    // The public twin keeps the documented 303 (the wave-4 pin, re-anchored
    // beside the negative arm).
    const publicAnon = await fetchUi(`/${OWNER}/${REPO}/issues/new`, formPost({ title: "anon at public" }));
    expect(publicAnon.status).toBe(303);
    expect(publicAnon.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/${OWNER}/${REPO}/issues/new`)}`,
    );
  });

  it("the archived twin: the GET still renders (the refusal is the POST's) with the EMPTY pickers, and the POST re-renders the verbatim message writing nothing", async () => {
    const fixture = await ensureIssueNewFixtures();
    const before = await countIssues(fixture.archRepo.id);

    const get = await fetchUi(`/${OWNER}/${ARCH_REPO}/issues/new`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(get.status).toBe(200); // no archived gate on the GET
    const getHtml = await get.text();
    expect(getHtml).toContain(`action="/${OWNER}/${ARCH_REPO}/issues/new" method="post"`);
    // The empty-pickers arm (this repo has no labels/milestones): the
    // "No labels" placeholder and the bare No-Milestone select.
    expect(getHtml).toContain('>No labels</span>');
    expect(getHtml).toContain('<option value="">No Milestone</option>');
    expect(getHtml).not.toContain('name="label_ids"');

    const post = await fetchUi(
      `/${OWNER}/${ARCH_REPO}/issues/new`,
      withCookie(formPost({ title: "archived attempt", content: "kept body" }), fixture.ownerCookie),
    );
    expect(post.status).toBe(200);
    const html = await post.text();
    expect(html).toContain('<div class="ui negative message">repo is archived</div>'); // upstream mustNotBeArchived verbatim
    expect(html).toContain('value="archived attempt"'); // the submission is kept
    expect(html).toContain("kept body");
    expect(await countIssues(fixture.archRepo.id)).toBe(before); // nothing written
  });
});

// --- the round-trip's deferred parser arms -------------------------------------------

describe("the round-trip's deferred parser arms", () => {
  it("a whitespace-only title trims to the required re-render; the body survives, nothing is written", async () => {
    const fixture = await ensureIssueNewFixtures();
    const before = await countIssues(fixture.repo.id);
    const res = await fetchUi(
      `/${OWNER}/${REPO}/issues/new`,
      withCookie(formPost({ title: "   ", content: "kept body" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">A title is required.</div>');
    expect(html).toContain("kept body");
    expect(html).not.toContain('value="   "'); // the trim happened BEFORE the re-render
    expect(await countIssues(fixture.repo.id)).toBe(before);
  });

  it("the ?milestone= preselect degrades to none on a non-numeric, zero, CLOSED, or unknown id — no option carries selected", async () => {
    const fixture = await ensureIssueNewFixtures();
    for (const [label, milestone] of [
      ["non-numeric", "abc"],
      ["zero", "0"],
      ["closed", String(fixture.closedMilestoneId)], // the select lists OPEN milestones only
      ["unknown", "424242"],
    ] as const) {
      const res = await fetchUi(`/${OWNER}/${REPO}/issues/new?milestone=${milestone}`, {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
      });
      expect(res.status, label).toBe(200);
      const html = await res.text();
      const select = html.slice(html.indexOf('id="new-issue-milestone"'), html.indexOf("</select>"));
      expect(select, label).not.toContain("selected"); // the open id arm is wave26's pin
    }
  });

  it("one POST pins the multi-value parser: label_ids dedupe + junk filter, milestone_id garbage degrades to none, empty content stores NULL", async () => {
    const fixture = await ensureIssueNewFixtures();
    const before = await countIssues(fixture.repo.id);
    const res = await fetchUi(
      `/${OWNER}/${REPO}/issues/new`,
      withCookie(
        formPost({
          title: "parser arms",
          label_ids: [String(fixture.bugLabelId), String(fixture.bugLabelId), "abc", "-4", "0"],
          milestone_id: "abc",
          content: "",
        }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303); // the junk never reached the service (no IssueError)
    expect(res.headers.get("location")).toBe(`/${OWNER}/${REPO}/issues/${before + 1}`);

    const row = await issueByIndex(fixture.repo.id, before + 1);
    expect(row?.content).toBeNull(); // "" stores NULL (the service's nulling)
    expect(row?.milestoneId).toBeNull(); // non-numeric degraded to none
    const links = await drizzle(env.DB)
      .select({ labelId: issueLabels.labelId })
      .from(issueLabels)
      .where(eq(issueLabels.issueId, row?.id ?? -1))
      .all();
    expect(links.map((link) => link.labelId)).toEqual([fixture.bugLabelId]); // deduped, junk dropped
  });
});

// --- the CSRF guard's valid-session arms ----------------------------------------------

describe("the CSRF guard's valid-session arms (wave4 pinned the cookie-less 403)", () => {
  it("a cross-origin POST carrying a REAL session 403s before the write; at the invisible repo it 403s before the 404 shell", async () => {
    const fixture = await ensureIssueNewFixtures();
    const before = await countIssues(fixture.repo.id);

    const authed = await fetchUi(
      `/${OWNER}/${REPO}/issues/new`,
      crossOriginPost({ title: "evil with cookie" }, fixture.ownerCookie),
    );
    expect(authed.status).toBe(403); // the guard fronts the valid session
    expect(authed.headers.get("content-type")).toContain("text/plain");
    expect(await authed.text()).toContain("cross-origin request rejected");

    const atPrivate = await fetchUi(
      `/${OWNER}/${PRIVATE_REPO}/issues/new`,
      crossOriginPost({ title: "evil at private" }, fixture.otherCookie),
    );
    expect(atPrivate.status).toBe(403); // NOT the 404 shell — the guard runs before repo resolution
    expect(await atPrivate.text()).toContain("cross-origin request rejected");

    expect(await countIssues(fixture.repo.id)).toBe(before); // neither evil arm wrote
  });
});

// --- the window-2e /pulls/new redirect (635ce2e) ---------------------------------------
//
// ESCALATION (tests-only brief — two REAL bugs, work stopped):
//
//   BUG 1 (RED pins below — pullsNewRedirect's tail is off by one):
//   `pullsNewRedirect` extracts the wildcard as
//   `pathname.split("/").slice(4)` — for `/o/r/pulls/new/foo` that slice is
//   `["new", "foo"]` (index 0 is the leading empty segment), so the redirect
//   target duplicates the literal: `/o/r/compare/new/foo` instead of
//   `/o/r/compare/foo`. Upstream's `ctx.Params("*")` (pull.go:1302) is
//   everything AFTER `/pulls/new/`, and upstream's own integration test
//   pins `GET /user2/repo1/pulls/new/foo → /user2/repo1/compare/...`
//   (pull_compare_test.go:26). The correct extraction is slice(5). As
//   shipped, every follow lands on the compare page with a nonexistent
//   head ref ("new/foo").
//
//   BUG 2 (the claim-gap pin below): the family is UNREACHABLE through the
//   real dispatcher anyway — `parseUiRoute` never claims any pulls/new
//   shape, and src/index.ts consults `handlesUiRoute` BEFORE Hono, so
//   `/{owner}/{repo}/pulls/new/*` falls to gitHttpGate → the engine's 404.
//   The mounted uiRouter redirect is dead code in production. (Window-2e
//   added parse arms for its SIBLING folds branch-create/branch-rename but
//   not this one; the issues-list matrix's "upstream registers no
//   /pulls/new" rationale is stale — web.go:1314 registers it.)

describe("the window-2e /pulls/new redirect (635ce2e) — RED: the tail is off by one", () => {
  it("the tailed GET 307s onto /compare with the tail exact and the query preserved", async () => {
    await ensureIssueNewFixtures();
    const res = await fetchUi(`/${OWNER}/${REPO}/pulls/new/foo?expand=1`);
    expect(res.status).toBe(307);
    // Upstream: ctx.Params("*") = "foo" → /compare/foo (the compare page
    // treats a separator-less tail as the head — the single-ref family).
    expect(res.headers.get("location")).toBe(`/${OWNER}/${REPO}/compare/foo?expand=1`);
  });

  it("a multi-segment tail (the base...head shape a compare link emits) survives whole", async () => {
    await ensureIssueNewFixtures();
    const res = await fetchUi(`/${OWNER}/${REPO}/pulls/new/main...topic`);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`/${OWNER}/${REPO}/compare/main...topic`);
  });

  it("the bare /pulls/new stays a miss (chi's wildcard needs the tail — upstream too)", async () => {
    await ensureIssueNewFixtures();
    const res = await fetchUi(`/${OWNER}/${REPO}/pulls/new`);
    expect(res.status).toBe(404); // no redirect: the * pattern does not match the bare literal
  });

  it("the claim: parseUiRoute claims the pulls/new shapes — the redirect is reachable through the real dispatcher (fixed)", () => {
    // The parse layer is the dispatcher gate's single source of route truth
    // (src/index.ts consults handlesUiRoute BEFORE Hono). The escalated gap
    // (no claim → every /pulls/new/* request fell to gitHttpGate → the
    // engine's 404, the uiRouter redirect dead code) is CLOSED: the folds
    // follow-up added the pulls-new-redirect family. Pins flipped to the
    // claimed shapes with provenance.
    expect(parseUiRoute(`/${OWNER}/${REPO}/pulls/new/foo`)).toEqual({
      family: "pulls-new-redirect",
      owner: OWNER,
      repo: REPO,
    });
    expect(parseUiRoute(`/${OWNER}/${REPO}/pulls/new/main...topic`)).toEqual({
      family: "pulls-new-redirect",
      owner: OWNER,
      repo: REPO,
    });
    expect(handlesUiRoute(`/${OWNER}/${REPO}/pulls/new/foo`)).toBe(true);
  });
});
