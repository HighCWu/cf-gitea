/**
 * The milestones family's DEFERRED route-level matrix (pages/milestones.tsx
 * mounted at /:owner/:repo/milestones + /:owner/:repo/milestones/new, and
 * pages/milestone-detail.tsx's edit combo /:owner/:repo/milestones/{id}/edit —
 * pages wave 6, ui/__tests__/pages-wave6.test.ts, and wave 26,
 * ui/__tests__/pages-wave26.test.ts, own the base arms: the page frames, the
 * open/closed tabs with the golden counts, the row facts (progress, due
 * date, overdue red, the closed stamp), the form/write gates for the
 * anonymous/unrelated/site-admin fixtures, the create + edit round-trips
 * with their two validation messages, the archived POST refusal, the parser
 * claims and the detail page's arms. THIS FILE adds the arms those waves do
 * not carry, driven over the mounted uiRouter with the issues-list 88ac2ee
 * matrix's minted-session pattern):
 *
 *   - the viewer gates: wave6's list posture is anonymous-only on public
 *     repos — the minted-session pattern proves the signed-in OWNER renders
 *     their own PRIVATE repo's list (with the signed-in chrome) while a
 *     signed-in NON-owner still 404-shells, and the minted owner's private
 *     write surface round-trips (GET form + POST create + the list renders
 *     the row);
 *   - the gate DIVERGENCE the module headers document: a signed-in WRITE
 *     collaborator fails the new-form's admin reduction (no New Milestone
 *     button, GET /milestones/new 404-shells — the settingsGate/canAdminRepo
 *     arm) while passing the edit combo's faithful port (the per-row Edit
 *     link renders, GET/POST /milestones/{id}/edit admit — the
 *     repoLabelsWriteGate/canWriteRepo arm); a READ collaborator fails both;
 *   - the round-trips' deferred validation arms: whitespace-only and
 *     51-char titles (the trim convention + the server-side MaxSize(50)
 *     message — wave6/26 pin only the empty title), the non-padded deadline
 *     ("2030-3-5" — upstream's format attempts all reject), the kept-form
 *     re-renders, the create WITHOUT a due date landing on the null-deadline
 *     row, the edit POST that CLEARS a stored due date, and the §2.8
 *     cross-origin guard on the edit POST (wave6 pinned only the new form);
 *   - the tabs + ordering over REAL service-created rows: the active-tab
 *     marks (open default, ?state=closed flips, unknown ?state= degrades to
 *     open-active — parseMilestonesState's default branch), the tab glyphs
 *     (octicon-milestone / octicon-issue-closed), the unfiltered counts, and
 *     the deadline ASC, name ASC order with the no-deadline rows FIRST
 *     (SQLite NULLs-first = upstream's deadline_unix 0);
 *   - the pager over 21 rows: the Older link carrying ?page=2, page 2's
 *     Newer link onto the BARE basePath (the house unparameterized
 *     convention — releases + activity-feeds pin the same shape), the
 *     closed tab's Older keeping state=closed, junk ?page= parsing as 1,
 *     and a past-the-end page rendering the row-less list WITH the Newer
 *     link back (no upper clamp);
 *   - the row facts off the REAL counters (the attach path wave6's golden
 *     rows never exercise): 3 open + 1 closed issues through
 *     IssuesService.createIssue/closeIssue → "3 Open" / "1 Closed" / 25%
 *     progress and the "Updated" stamp;
 *   - the archived twins at route level: the list hides BOTH write controls
 *     but still renders, the new-form GET has no archived arm (only the POST
 *     refuses), the edit gate 404s even the OWNER (repoLabelsWriteGate's
 *     archived arm), and the detail page hides its Edit + New Issue buttons
 *     while keeping the milestone;
 *   - the claim pins: upstream's POST /milestones/{id}/delete (web.go:1430)
 *     and the bare-list POST stay engine-owned — unclaimed shapes answer the
 *     parent's 404 and the delete tail writes NOTHING (the milestone row
 *     survives in D1);
 *   - batch-11 deepening — the deadline parse shapes the waves leave open
 *     (parseMilestoneDeadline's full formatAttempts family, api/services/
 *     milestones.ts:42-62): the space-separated "yyyy-mm-dd HH:MM:SS" shape
 *     and both RFC3339 zone forms (Z and ±HH:MM) all land END-OF-DAY UTC of
 *     the DATE prefix (ApplyAPIDeadlineTimestamp), the zoneless RFC3339 and
 *     the slash shape reject with the upstream message, the sub-2-day
 *     deadlines CLEAR to null (upstream's "tolerate timezone difference"
 *     arm — 1970-01-02 drops, 1970-01-03 lands), the whitespace-padded
 *     value trims onto the date shape (parseMilestoneForm's trim), and the
 *     EDIT path shares the same parser (the offset form through
 *     /milestones/{id}/edit);
 *   - batch-11 deepening — the closed-state toggles' downstream rendering:
 *     a CLOSED milestone with a deadline renders the Closed stamp and never
 *     the due-date line or the overdue red (the row component's isClosed
 *     branch precedes the deadline arm; the overdue flag's !isClosed
 *     guard), reopening (updateMilestone state open — closedDateAt nulled,
 *     services/issues/service.ts) restores the red due-date line and drops
 *     the stamp, and a closed row with a cleared closed_date_unix renders
 *     the BARE Closed stamp (the closedDateAt !== null guard).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { addOrUpdateCollaborator } from "../../api/services/repo-collaborators";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { milestones, repositories } from "../../db/schema";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { RepoRow } from "../ui-context";

// --- the minted-session route harness (the issues-list 88ac2ee pattern) ---------

/** Synthetic manifest shaped like the real Vite output (the shared fixture
 *  shape — deterministic, no build dependence). */
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

/** The real production path: parse → resolveUiSession → the handler, on the
 *  mounted uiRouter with the synthetic manifest; the execution context is
 *  awaited so waitUntil side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the user (the real mintSession path,
 *  minted per request — the beforeEach users wipe cascades the sessions
 *  table, so a cross-test cookie would go stale; the value is never
 *  rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A same-origin urlencoded form POST (the §2.8 layer-2 guard accepts the
 *  matching Origin header; `cookie` is a full cookie header when given). */
function formPost(path: string, body: Record<string, string>, cookie?: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://test.local",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(body).toString(),
  };
}

/** The open/closed tab strip slice (the tabs render between the toolbar and
 *  the list body — this page has no #issue-list anchor to slice to). */
function tabsSlice(html: string): string {
  return html.slice(
    html.indexOf('<div class="small-menu-items ui compact tiny menu">'),
    html.indexOf('<div class="flex-divided-list milestone-list">'),
  );
}

/** The milestones page renders one `.item.flex-relaxed-list` per row. */
function rowCount(html: string): number {
  return (html.match(/class="item flex-relaxed-list"/g) ?? []).length;
}

// --- fixtures -------------------------------------------------------------------

const T0 = 1_770_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

async function seedRepo(owner: { id: number; username: string }, slug: string, isPrivate = false): Promise<RepoRow> {
  return new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: owner.username.toLowerCase() },
    name: slug,
    isPrivate,
    status: "ready",
  });
}

/** One milestone through the landed service (the counters' batch — the
 *  repositories.num_milestones bump rides along). */
async function seedMilestone(
  svc: IssuesService,
  repoId: string,
  name: string,
  offsetSeconds: number,
  extra?: { deadlineAt?: Date | null; content?: string },
): Promise<{ id: number }> {
  const row = await svc.createMilestone({
    repoId,
    name,
    content: extra?.content,
    deadlineAt: extra?.deadlineAt,
    now: at(offsetSeconds),
  });
  return { id: row.id };
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // FK order: the join rows first, then issues, then the per-repo counter
  // (repo_counters → repositories is the one NON-cascade FK, migration 0002
  // — it must go before its repo), then milestones/repositories before users
  // (sessions cascade from users).
  for (const table of [
    "issue_labels",
    "issue_pins",
    "comments",
    "pull_requests",
    "issues",
    "labels",
    "repo_collaborators",
    "milestones",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the viewer gates ------------------------------------------------------------

describe("the viewer gates (the minted-session arms the anonymous fixture posture lacks)", () => {
  it("the signed-in OWNER renders their own private repo's milestones list with the signed-in chrome", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "vault", true);
    const svc = new IssuesService(env.DB);
    const m = await seedMilestone(svc, repo.id, "vault plan", 10);

    const res = await fetchUi("/alice/vault/milestones", { headers: { cookie: await sessionHeader(alice.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">vault plan</a>");
    expect(html).toContain(`href="/alice/vault/milestone/${m.id}">vault plan</a>`);
    // The session resolved: the user navbar renders the notifications bell
    // and drops the anonymous Sign In item (the shell's viewer branch).
    expect(html).toContain('<a class="item" href="/notifications"');
    expect(html).not.toContain(">Sign In</a>");
  });

  it("a signed-in NON-owner still 404-shells on someone else's private repo (sessions buy no visibility)", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "vault", true);
    await seedMilestone(new IssuesService(env.DB), repo.id, "vault plan", 10);

    const res = await fetchUi("/alice/vault/milestones", { headers: { cookie: await sessionHeader(bob.id) } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<div class="status-page-error">');
    expect(html).not.toContain(">vault plan</a>");
  });

  it("the minted owner's private write surface round-trips: GET form, POST create with a due date, the list renders the row", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    await seedRepo(alice, "vault", true);
    const cookie = await sessionHeader(alice.id);

    const form = await fetchUi("/alice/vault/milestones/new", { headers: { cookie } });
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('action="/alice/vault/milestones/new"');

    const res = await fetchUi(
      "/alice/vault/milestones/new",
      formPost("/alice/vault/milestones/new", { title: "  vault m1  ", deadline: "2030-01-31", content: "The body." }, cookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/vault/milestones");

    // The write path: name trimmed, end-of-day UTC deadline (the landed
    // parser's normalization), content stored.
    const row = await drizzle(env.DB).select().from(milestones).where(eq(milestones.name, "vault m1")).get();
    expect(row?.content).toBe("The body.");
    expect(row?.deadlineAt?.toISOString()).toBe("2030-01-31T23:59:59.000Z");

    // The list renders the row for the minted owner (0 issues → 0% bar).
    const list = await fetchUi("/alice/vault/milestones", { headers: { cookie } });
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain(">vault m1</a>");
    expect(html).toContain(">0%</span>");
    expect(html).toContain("Jan 31, 2030");
  });

  it("the gate divergence: a WRITE collaborator fails the new-form's admin gate but passes the edit combo's writer gate; a READ collaborator fails both", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const carol = await seedVerifiedUser({ username: "carol" });
    const dave = await seedVerifiedUser({ username: "dave" });
    const repo = await seedRepo(alice, "grants");
    const svc = new IssuesService(env.DB);
    const m = await seedMilestone(svc, repo.id, "grants m1", 10, { deadlineAt: new Date("2090-05-10T23:59:59Z") });
    await addOrUpdateCollaborator(env.DB, repo.id, carol.id, "write", at(0));
    await addOrUpdateCollaborator(env.DB, repo.id, dave.id, "read", at(0));

    // Carol (write): the list's per-row Edit link renders but the New
    // Milestone button does not (the two predicates disagree exactly as the
    // landed gates do — milestones.tsx's admin reduction vs the edit combo's
    // faithful reqRepoIssuesOrPullsWriter port).
    const carolList = await fetchUi("/alice/grants/milestones", { headers: { cookie: await sessionHeader(carol.id) } });
    expect(carolList.status).toBe(200);
    const carolHtml = await carolList.text();
    expect(carolHtml).toContain(`href="/alice/grants/milestones/${m.id}/edit"`);
    expect(carolHtml).toContain("octicon-pencil");
    expect(carolHtml).not.toContain("/alice/grants/milestones/new");

    // Carol's new-form GET 404-shells (the settingsGate admin arm)…
    const carolNew = await fetchUi("/alice/grants/milestones/new", { headers: { cookie: await sessionHeader(carol.id) } });
    expect(carolNew.status).toBe(404);
    // …while the edit form admits her (the repoLabelsWriteGate writer arm).
    const carolEdit = await fetchUi(`/alice/grants/milestones/${m.id}/edit`, {
      headers: { cookie: await sessionHeader(carol.id) },
    });
    expect(carolEdit.status).toBe(200);
    expect(await carolEdit.text()).toContain("Edit Milestone");

    // Dave (read): no Edit link on the list and the edit form 404-shells.
    const daveList = await fetchUi("/alice/grants/milestones", { headers: { cookie: await sessionHeader(dave.id) } });
    expect(daveList.status).toBe(200);
    expect(await daveList.text()).not.toContain("/edit");
    const daveEdit = await fetchUi(`/alice/grants/milestones/${m.id}/edit`, {
      headers: { cookie: await sessionHeader(dave.id) },
    });
    expect(daveEdit.status).toBe(404);
  });
});

// --- the round-trips' deferred validation arms -------------------------------------

describe("the write round-trips' deferred arms (title limits, deadline shapes, kept forms)", () => {
  it("a whitespace-only title trims to the required message (the new-issue trim convention)", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "roundtrip");
    const cookie = await sessionHeader(alice.id);

    const res = await fetchUi("/alice/roundtrip/milestones/new", formPost("/alice/roundtrip/milestones/new", { title: "   " }, cookie));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("A title is required.");
    expect(await drizzle(env.DB).select().from(milestones).where(eq(milestones.repoId, repo.id)).all()).toHaveLength(0);
  });

  it("a 51-char title re-renders with the server-side MaxSize(50) message and the kept deadline/content", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    await seedRepo(alice, "roundtrip");
    const cookie = await sessionHeader(alice.id);
    const longTitle = "m".repeat(51);

    const res = await fetchUi(
      "/alice/roundtrip/milestones/new",
      formPost("/alice/roundtrip/milestones/new", { title: longTitle, deadline: "2030-02-01", content: "kept body" }, cookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Title must be at most 50 characters.");
    // The submitted values ride the re-render (the login-failure convention).
    expect(html).toContain(`value="${longTitle}"`);
    expect(html).toContain('value="2030-02-01"');
    expect(html).toContain("kept body");
  });

  it("a non-padded deadline rejects with the upstream invalid-format message and the kept title", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    await seedRepo(alice, "roundtrip");
    const cookie = await sessionHeader(alice.id);

    const res = await fetchUi(
      "/alice/roundtrip/milestones/new",
      formPost("/alice/roundtrip/milestones/new", { title: "ok", deadline: "2030-3-5" }, cookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    // Every one of upstream's format attempts requires the zero-padded
    // yyyy-mm-dd wall fields; the apostrophes render HTML-escaped (JSX).
    expect(html).toContain("Due date format must be &#39;yyyy-mm-dd&#39;.");
    expect(html).toContain('value="ok"');
  });

  it("a create WITHOUT a due date lands on the null-deadline row and the list renders No due date", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "roundtrip");
    const cookie = await sessionHeader(alice.id);

    const res = await fetchUi(
      "/alice/roundtrip/milestones/new",
      formPost("/alice/roundtrip/milestones/new", { title: "no deadline m" }, cookie),
    );
    expect(res.status).toBe(303);

    const row = await drizzle(env.DB).select().from(milestones).where(eq(milestones.repoId, repo.id)).get();
    expect(row?.deadlineAt).toBeNull();

    const list = await (await fetchUi("/alice/roundtrip/milestones")).text();
    expect(list).toContain(">no deadline m</a>");
    expect(list).toContain("No due date");
  });

  it("the edit POST with an empty deadline CLEARS a stored due date (the parser's cleared form)", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "roundtrip");
    const svc = new IssuesService(env.DB);
    const m = await seedMilestone(svc, repo.id, "clearable", 10, { deadlineAt: new Date("2090-05-10T23:59:59Z") });
    const cookie = await sessionHeader(alice.id);
    const editPath = `/alice/roundtrip/milestones/${m.id}/edit`;

    const res = await fetchUi(editPath, formPost(editPath, { title: "clearable", deadline: "" }, cookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/roundtrip/milestones");

    const row = await drizzle(env.DB).select().from(milestones).where(eq(milestones.id, m.id)).get();
    expect(row?.deadlineAt).toBeNull();

    const list = await (await fetchUi("/alice/roundtrip/milestones")).text();
    expect(list).toContain("No due date");
  });

  it("the edit POST re-renders with the MaxSize(50) message and the kept values, the stored name unchanged", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "roundtrip");
    const svc = new IssuesService(env.DB);
    const m = await seedMilestone(svc, repo.id, "stable name", 10);
    const cookie = await sessionHeader(alice.id);
    const editPath = `/alice/roundtrip/milestones/${m.id}/edit`;

    const res = await fetchUi(
      editPath,
      formPost(editPath, { title: "x".repeat(51), deadline: "2031-06-15", content: "kept edit body" }, cookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Title must be at most 50 characters.");
    expect(html).toContain(`value="${"x".repeat(51)}"`);
    expect(html).toContain('value="2031-06-15"');
    expect(html).toContain("kept edit body");

    // Nothing was written: the stored name survives untouched.
    const row = await drizzle(env.DB).select().from(milestones).where(eq(milestones.id, m.id)).get();
    expect(row?.name).toBe("stable name");
  });

  it("the §2.8 cross-origin guard 403s the edit POST before any write (wave6 pinned only the new form)", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "roundtrip");
    const svc = new IssuesService(env.DB);
    const m = await seedMilestone(svc, repo.id, "guarded m", 10);

    const res = await fetchUi(`/alice/roundtrip/milestones/${m.id}/edit`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
        cookie: await sessionHeader(alice.id),
      },
      body: "title=evil-write",
    });
    expect(res.status).toBe(403);

    const row = await drizzle(env.DB).select().from(milestones).where(eq(milestones.id, m.id)).get();
    expect(row?.name).toBe("guarded m");
  });
});

// --- the tabs + the ordering ---------------------------------------------------------

describe("the open/closed tabs and the deadline,name order (real service-created rows)", () => {
  /** alice + one public repo: 3 open milestones, 1 closed. */
  async function seedTabRepo(): Promise<{ openIds: number[]; closedId: number }> {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "tabs");
    const svc = new IssuesService(env.DB);
    const openIds: number[] = [];
    for (const name of ["tab a", "tab b", "tab c"]) {
      openIds.push((await seedMilestone(svc, repo.id, name, 10)).id);
    }
    const closed = await seedMilestone(svc, repo.id, "tab old", 20);
    await svc.updateMilestone(closed.id, { state: "closed", now: at(30) });
    return { openIds, closedId: closed.id };
  }

  it("the unfiltered counts, the active-tab marks and the glyphs; an unknown ?state= degrades to the open tab", async () => {
    await seedTabRepo();
    const open = await (await fetchUi("/alice/tabs/milestones")).text();
    // The tab totals are the unfiltered counts over both states.
    expect(open).toContain("3 Open</a>");
    expect(open).toContain("1 Closed</a>");
    // The OPEN tab is the active one (its class index precedes the plain
    // one) and carries the milestone glyph (PageIsMilestones — the closed
    // tab carries the issue-closed one).
    const openTabs = tabsSlice(open);
    const active = openTabs.indexOf('class="active item flex-text-inline"');
    const plain = openTabs.indexOf('class="item flex-text-inline"');
    expect(active).toBeGreaterThanOrEqual(0);
    expect(active).toBeLessThan(plain);
    expect(openTabs).toContain('class="svg octicon-milestone"');
    expect(openTabs).toContain('class="svg octicon-issue-closed"');

    // ?state=closed flips the active mark onto the closed tab.
    const closed = await (await fetchUi("/alice/tabs/milestones?state=closed")).text();
    const closedTabs = tabsSlice(closed);
    const activeClosed = closedTabs.indexOf('class="active item flex-text-inline"');
    const plainClosed = closedTabs.indexOf('class="item flex-text-inline"');
    expect(activeClosed).toBeGreaterThan(plainClosed);

    // An unknown state degrades to the open tab (parseMilestonesState's
    // default branch — upstream's isShowClosed := state == "closed").
    const junk = await (await fetchUi("/alice/tabs/milestones?state=all")).text();
    const junkTabs = tabsSlice(junk);
    expect(junkTabs.indexOf('class="active item flex-text-inline"')).toBeLessThan(
      junkTabs.indexOf('class="item flex-text-inline"'),
    );
    expect(rowCount(junk)).toBe(3);
  });

  it("the closed tab filters to the closed rows; the open tab drops them", async () => {
    const { closedId } = await seedTabRepo();
    const closed = await (await fetchUi("/alice/tabs/milestones?state=closed")).text();
    expect(rowCount(closed)).toBe(1);
    expect(closed).toContain(`href="/alice/tabs/milestone/${closedId}">tab old</a>`);
    expect(closed).not.toContain(">tab a</a>");
  });

  it("the rows order deadline ASC, name ASC with the no-deadline rows FIRST (SQLite NULLs-first = upstream's 0)", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "order");
    const svc = new IssuesService(env.DB);
    await seedMilestone(svc, repo.id, "m-zeta", 10, { deadlineAt: new Date("2090-05-10T23:59:59Z") });
    await seedMilestone(svc, repo.id, "m-alpha", 20, { deadlineAt: new Date("2090-05-10T23:59:59Z") });
    await seedMilestone(svc, repo.id, "m-nodate", 30);
    await seedMilestone(svc, repo.id, "m-early", 40, { deadlineAt: new Date("2089-01-01T23:59:59Z") });

    const html = await (await fetchUi("/alice/order/milestones")).text();
    const names = [...html.matchAll(/href="\/alice\/order\/milestone\/(\d+)">([^<]+)<\/a>/g)].map((match) => match[2]);
    // No deadline sorts before any deadline (upstream deadline_unix = 0);
    // the earlier deadline precedes the later; the same-deadline pair
    // tie-breaks by name (created zeta-first).
    expect(names).toEqual(["m-nodate", "m-early", "m-alpha", "m-zeta"]);
  });
});

// --- the pager -----------------------------------------------------------------------

describe("the pager (21 rows — the Older/Newer shape)", () => {
  /** alice + one repo: 21 OPEN milestones, 1 closed. */
  async function seedOpenPager(): Promise<void> {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "pager");
    const svc = new IssuesService(env.DB);
    for (let i = 1; i <= 21; i += 1) {
      await seedMilestone(svc, repo.id, `open m ${String(i).padStart(2, "0")}`, i);
    }
    const closed = await seedMilestone(svc, repo.id, "the closed m", 500);
    await svc.updateMilestone(closed.id, { state: "closed", now: at(510) });
  }

  /** alice + one repo: 21 CLOSED milestones, 1 open (the closed-tab pager). */
  async function seedClosedPager(): Promise<void> {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "closedpager");
    const svc = new IssuesService(env.DB);
    for (let i = 1; i <= 21; i += 1) {
      const m = await seedMilestone(svc, repo.id, `closed m ${String(i).padStart(2, "0")}`, i);
      await svc.updateMilestone(m.id, { state: "closed", now: at(600) });
    }
    await seedMilestone(svc, repo.id, "the lone open m", 700);
  }

  it("page 1 carries 20 rows and the Older link; page 2's Newer lands on the BARE basePath (the house convention)", async () => {
    await seedOpenPager();
    const one = await (await fetchUi("/alice/pager/milestones")).text();
    expect(rowCount(one)).toBe(20);
    expect(one).toContain('<a class="item navigation" href="/alice/pager/milestones?page=2"');
    expect(one).toContain('<span class="navigation_label">Older</span>');
    expect(one).not.toContain('<span class="navigation_label">Newer</span>');

    const two = await (await fetchUi("/alice/pager/milestones?page=2")).text();
    expect(rowCount(two)).toBe(1);
    expect(two).toContain(">open m 21</a>");
    // The Newer link drops the canonical page (and there is no state facet
    // to carry — the bare basePath, like the releases/activity-feeds pagers).
    expect(two).toContain('<a class="item navigation" href="/alice/pager/milestones"');
    expect(two).toContain('<span class="navigation_label">Newer</span>');
    expect(two).not.toContain('<span class="navigation_label">Older</span>');
  });

  it("a junk ?page= parses as 1 (parsePageNumber's non-numeric branch)", async () => {
    await seedOpenPager();
    const html = await (await fetchUi("/alice/pager/milestones?page=abc")).text();
    expect(rowCount(html)).toBe(20);
    expect(html).toContain('<a class="item navigation" href="/alice/pager/milestones?page=2"');
    expect(html).not.toContain('<span class="navigation_label">Newer</span>');
  });

  it("the closed tab's Older keeps state=closed; a past-the-end page renders row-less WITH the Newer link back (no upper clamp)", async () => {
    await seedClosedPager();
    const one = await (await fetchUi("/alice/closedpager/milestones?state=closed")).text();
    expect(rowCount(one)).toBe(20);
    // The forward link carries the facet with the page param LAST,
    // ampersand HTML-escaped in the attribute.
    expect(one).toContain('<a class="item navigation" href="/alice/closedpager/milestones?state=closed&amp;page=2"');

    const pastRes = await fetchUi("/alice/closedpager/milestones?state=closed&page=99");
    expect(pastRes.status).toBe(200);
    const past = await pastRes.text();
    expect(rowCount(past)).toBe(0);
    // Page > 1 keeps the pager alive with ONLY the Newer link, onto page-1-
    // of-the-request (98 — the §4.11 no-upper-clamp posture) WITH the state.
    expect(past).toContain(
      '<a class="item navigation" href="/alice/closedpager/milestones?state=closed&amp;page=98"',
    );
    expect(past).toContain('<span class="navigation_label">Newer</span>');
    expect(past).not.toContain('<span class="navigation_label">Older</span>');
  });
});

// --- the row facts off the real counters ----------------------------------------------

describe("the row facts off the REAL counters (the attach path the golden rows never exercise)", () => {
  it("3 open + 1 closed issues render 3 Open / 1 Closed / 25% with the Updated stamp", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "counters");
    const svc = new IssuesService(env.DB);
    const m = await seedMilestone(svc, repo.id, "shipped plan", 10);
    for (let i = 1; i <= 3; i += 1) {
      await svc.createIssue({ repoId: repo.id, title: `counter issue ${i}`, posterId: alice.id, milestoneId: m.id, now: at(i * 10) });
    }
    const done = await svc.createIssue({ repoId: repo.id, title: "counter done", posterId: alice.id, milestoneId: m.id, now: at(40) });
    await svc.closeIssue(done.id, { now: at(50) });

    const html = await (await fetchUi("/alice/counters/milestones")).text();
    // The maintained counters (recomputed in the same batch as every
    // attach/close) drive the row: 3 open, 1 closed, 25% completeness.
    expect(html).toContain("3 Open</div>");
    expect(html).toContain("1 Closed</div>");
    expect(html).toContain(">25%</span>");
    expect(html).toMatch(/<progress class="list-item-title-progress"[^>]*value="25"/);
    // The created row carries updatedAt → the "Updated" clock stamp renders.
    expect(html).toContain("Updated <relative-time");
  });
});

// --- the archived twins (route-level) ---------------------------------------------------

describe("the archived twins (the route-level arms beyond wave6's POST refusal)", () => {
  it("the archived list hides BOTH write controls but still renders; the new-form GET has no archived arm; the edit gate 404s even the owner", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "archrepo");
    const svc = new IssuesService(env.DB);
    const m = await seedMilestone(svc, repo.id, "archived plan", 10);
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, repo.id));
    const cookie = await sessionHeader(alice.id);

    // The list renders for the owner, minus the New button AND the per-row
    // Edit links (both gates' `&& !isArchived` arms).
    const list = await fetchUi("/alice/archrepo/milestones", { headers: { cookie } });
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain(">archived plan</a>");
    expect(html).not.toContain("/alice/archrepo/milestones/new");
    expect(html).not.toContain("/edit");

    // The new-form GET admits the admin on the archived repo (the
    // settingsGate has no archived arm — only the POST refuses).
    const form = await fetchUi("/alice/archrepo/milestones/new", { headers: { cookie } });
    expect(form.status).toBe(200);

    // The edit combo's gate (repoLabelsWriteGate) 404-shells the archived
    // repo — even for the owner.
    const edit = await fetchUi(`/alice/archrepo/milestones/${m.id}/edit`, { headers: { cookie } });
    expect(edit.status).toBe(404);
  });

  it("the archived DETAIL page hides its Edit and New Issue buttons while keeping the milestone", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "archrepo");
    const svc = new IssuesService(env.DB);
    const m = await seedMilestone(svc, repo.id, "archived plan", 10, { content: "The description." });
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, repo.id));

    const res = await fetchUi(`/alice/archrepo/milestone/${m.id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository milestone-issue-list"');
    expect(html).toContain(">archived plan</h1>");
    expect(html).toContain("The description.");
    expect(html).not.toContain(`/alice/archrepo/milestones/${m.id}/edit`);
    expect(html).not.toContain(`/issues/new?milestone=${m.id}`);
  });
});

// --- batch 11: the deadline parse shapes (the formatAttempts family) -----------------

describe("the deadline parse shapes beyond the padded date (batch 11)", () => {
  it("the space-separated datetime and the RFC3339-Z shape land END-OF-DAY UTC of the date prefix (ApplyAPIDeadlineTimestamp)", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "deadlines");
    const cookie = await sessionHeader(alice.id);
    const post = (title: string, deadline: string): Promise<Response> =>
      fetchUi("/alice/deadlines/milestones/new", formPost("/alice/deadlines/milestones/new", { title, deadline }, cookie));

    // The dateTime shape ("yyyy-mm-dd HH:MM:SS" — upstream's second format
    // attempt): the time-of-day is DISCARDED, the date ends the day.
    expect((await post("dt-space", "2031-02-03 10:20:30")).status).toBe(303);
    // The RFC3339 shape with the Z zone (upstream's third attempt).
    expect((await post("dt-z", "2031-02-04T05:06:07Z")).status).toBe(303);
    // A whitespace-PADDED value trims onto the date shape first
    // (parseMilestoneForm's trim — the <input type="date"> twin).
    expect((await post("dt-padded", " 2031-03-09 ")).status).toBe(303);

    const rows = await drizzle(env.DB).select().from(milestones).where(eq(milestones.repoId, repo.id)).all();
    const byName = new Map(rows.map((row) => [row.name, row.deadlineAt?.toISOString()]));
    expect(byName.get("dt-space")).toBe("2031-02-03T23:59:59.000Z");
    expect(byName.get("dt-z")).toBe("2031-02-04T23:59:59.000Z");
    expect(byName.get("dt-padded")).toBe("2031-03-09T23:59:59.000Z");
  });

  it("the zoneless RFC3339 shape and the slash shape reject with the upstream message, nothing stored", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "deadlines");
    const cookie = await sessionHeader(alice.id);

    // RFC3339 REQUIRES a zone (Z or ±HH:MM) — the zoneless form matches no
    // format attempt (upstream time.Parse(RFC3339) fails the same way).
    const zoneless = await fetchUi(
      "/alice/deadlines/milestones/new",
      formPost("/alice/deadlines/milestones/new", { title: "no-zone", deadline: "2031-02-06T05:06:07" }, cookie),
    );
    expect(zoneless.status).toBe(200);
    expect(await zoneless.text()).toContain("Due date format must be &#39;yyyy-mm-dd&#39;.");

    // The slash shape matches no attempt either (the prefix regex never
    // captures — the failure precedes any Date construction).
    const slashed = await fetchUi(
      "/alice/deadlines/milestones/new",
      formPost("/alice/deadlines/milestones/new", { title: "slashed", deadline: "2031/02/06" }, cookie),
    );
    expect(slashed.status).toBe(200);
    expect(await slashed.text()).toContain("Due date format must be &#39;yyyy-mm-dd&#39;.");

    expect(await drizzle(env.DB).select().from(milestones).where(eq(milestones.repoId, repo.id)).all()).toHaveLength(0);
  });

  it("the sub-2-day deadlines CLEAR to null (ApplyAPIDeadlineTimestamp's tolerate-timezone arm), day 3 lands", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "deadlines");
    const cookie = await sessionHeader(alice.id);
    const post = (title: string, deadline: string): Promise<Response> =>
      fetchUi("/alice/deadlines/milestones/new", formPost("/alice/deadlines/milestones/new", { title, deadline }, cookie));

    // 1970-01-02 end-of-day = unix 172799 < 172800 — upstream clears the
    // value ("tolerate timezone difference between server and client"),
    // answering a null deadline, NOT the invalid-format refusal.
    expect((await post("epoch-day-2", "1970-01-02")).status).toBe(303);
    // 1970-01-03 end-of-day = unix 259199 ≥ 172800 — kept verbatim.
    expect((await post("epoch-day-3", "1970-01-03")).status).toBe(303);

    const rows = await drizzle(env.DB).select().from(milestones).where(eq(milestones.repoId, repo.id)).all();
    const byName = new Map(rows.map((row) => [row.name, row.deadlineAt?.toISOString() ?? null]));
    expect(byName.get("epoch-day-2")).toBeNull();
    expect(byName.get("epoch-day-3")).toBe("1970-01-03T23:59:59.000Z");
  });

  it("the EDIT path shares the parser: an RFC3339 offset value lands end-of-day UTC of the date prefix", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "deadlines");
    const svc = new IssuesService(env.DB);
    const m = await seedMilestone(svc, repo.id, "offset edit", 10);
    const cookie = await sessionHeader(alice.id);
    const editPath = `/alice/deadlines/milestones/${m.id}/edit`;

    const res = await fetchUi(editPath, formPost(editPath, { title: "offset edit", deadline: "2031-02-05T05:06:07+05:00" }, cookie));
    expect(res.status).toBe(303);
    // The +05:00 zone never shifts the stored day: end-of-day UTC of the
    // DATE prefix (the same ApplyAPIDeadlineTimestamp arm the create runs).
    const row = await drizzle(env.DB).select().from(milestones).where(eq(milestones.id, m.id)).get();
    expect(row?.deadlineAt?.toISOString()).toBe("2031-02-05T23:59:59.000Z");
  });
});

// --- batch 11: the closed-state toggles' downstream rendering -------------------------

describe("the closed-state toggles' downstream rendering (batch 11)", () => {
  /** alice + one repo + one milestone with a fixed PAST deadline. */
  async function seedDatedRepo(name: string): Promise<{ aliceId: number; mId: number; svc: IssuesService }> {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, name);
    const svc = new IssuesService(env.DB);
    const m = await seedMilestone(svc, repo.id, "dated m", 10, { deadlineAt: new Date("2020-01-01T23:59:59Z") });
    return { aliceId: alice.id, mId: m.id, svc };
  }

  it("a CLOSED milestone with a deadline renders the Closed stamp — never the due-date line or the overdue red", async () => {
    const { mId, svc } = await seedDatedRepo("closedstates");
    await svc.updateMilestone(mId, { state: "closed", now: at(20) });

    // The open tab drops the closed row entirely.
    const open = await (await fetchUi("/alice/closedstates/milestones")).text();
    expect(open).not.toContain(">dated m</a>");

    // The closed tab renders the closed stamp; the isClosed branch PRECEDES
    // the deadline arm, so "Jan 1, 2020" (formatDueDate of the stored
    // deadline) and the overdue red never render.
    const closed = await (await fetchUi("/alice/closedstates/milestones?state=closed")).text();
    expect(closed).toContain(">dated m</a>");
    // The stamp is the clock glyph DIRECTLY followed by "Closed" (the row's
    // issue-count div renders "0 Closed" — the digit disambiguates).
    expect(closed).toMatch(/<\/svg> Closed/);
    expect(closed).toContain("Closed <relative-time");
    expect(closed).not.toContain("Jan 1, 2020");
    expect(closed).not.toContain("tw-text-red");
  });

  it("REOPENING restores the red due-date line and drops the closed stamp (updateMilestone's close→open arm clears closedDateAt)", async () => {
    const { mId, svc } = await seedDatedRepo("closedstates");
    await svc.updateMilestone(mId, { state: "closed", now: at(20) });
    await svc.updateMilestone(mId, { state: "open", now: at(30) });

    const html = await (await fetchUi("/alice/closedstates/milestones")).text();
    expect(html).toContain(">dated m</a>");
    // The past deadline renders again — red (the deadline is decades past).
    expect(html).toContain("Jan 1, 2020");
    expect(html).toContain("tw-text-red");
    // The closed stamp is gone (the row's "0 Closed" issue-count div is the
    // only remaining "Closed" text beside the tab count).
    expect(html).not.toMatch(/<\/svg> Closed/);
    expect(html).toContain("0 Closed</a>");
  });

  it("a closed row with a cleared closed_date_unix renders the BARE Closed stamp (the closedDateAt !== null guard)", async () => {
    const { mId, svc } = await seedDatedRepo("closedstates");
    await svc.updateMilestone(mId, { state: "closed", now: at(20) });
    // Upstream's ClosedUnix nil arm — a closed milestone whose close stamp
    // was never recorded (service-created rows always stamp it; the direct
    // tweak is the only way to reach the guard).
    await drizzle(env.DB).update(milestones).set({ closedDateAt: null }).where(eq(milestones.id, mId));

    const closed = await (await fetchUi("/alice/closedstates/milestones?state=closed")).text();
    expect(closed).toMatch(/<\/svg> Closed/);
    // The stamp renders WITHOUT its relative-time twin (the Updated stamp's
    // own <relative-time> still renders — the guard is per-branch).
    expect(closed).not.toContain("Closed <relative-time");
    expect(closed).toContain("Updated <relative-time");
  });
});

// --- the claim pins -----------------------------------------------------------------------

describe("the claim pins (the delete tail + the GET-only surface)", () => {
  it("the parser claims exactly the list/new/edit shapes; upstream's /milestones/{id}/delete stays unclaimed", () => {
    expect(parseUiRoute("/octo/hello/milestones")).toEqual({ family: "milestones", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/milestones/new")).toEqual({ family: "milestone-new", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/milestones/7/edit")).toEqual({
      family: "milestone-edit",
      owner: "octo",
      repo: "hello",
      id: "7",
    });
    // Upstream web.go:1430 registers POST /milestones/{id}/delete — this
    // slice renders no delete controls and claims no delete shape (the
    // dead-link rule), for any segment value.
    expect(parseUiRoute("/octo/hello/milestones/7/delete")).toBeNull();
    expect(handlesUiRoute("/octo/hello/milestones/7/delete")).toBe(false);
    expect(parseUiRoute("/octo/hello/milestones/delete")).toBeNull();
  });

  it("a live POST to the delete tail and to the bare list both 404 unwritten; the milestone row survives", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const repo = await seedRepo(alice, "claims");
    const svc = new IssuesService(env.DB);
    const m = await seedMilestone(svc, repo.id, "survivor", 10);
    const cookie = await sessionHeader(alice.id);

    const del = await fetchUi(`/alice/claims/milestones/${m.id}/delete`, formPost(`/alice/claims/milestones/${m.id}/delete`, {}, cookie));
    expect(del.status).toBe(404);

    const bareListPost = await fetchUi("/alice/claims/milestones", formPost("/alice/claims/milestones", { title: "nope" }, cookie));
    expect(bareListPost.status).toBe(404);

    // Neither miss wrote anything: the row is untouched in D1.
    const row = await drizzle(env.DB).select().from(milestones).where(eq(milestones.id, m.id)).get();
    expect(row?.name).toBe("survivor");
  });
});
