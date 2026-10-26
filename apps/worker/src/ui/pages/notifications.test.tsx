/**
 * The notifications family's DEFERRED route-level matrix (pages/notifications.tsx
 * mounted at /notifications + the /notifications/status and /notifications/purge
 * POST arms — the wave-10 route tests in ui/__tests__/pages-wave10.test.ts own the
 * base arms: the anon GET 303s, the unread/read tab renders, the per-user mailbox,
 * the signed-in mark/pin round-trips read back through re-rendered pages, the
 * JSONRedirect purge, the 404-shell/empty-200/405 arms, the div-only fragment and
 * the count JSON. THIS FILE adds the arms wave10 does not carry, driven over the
 * mounted uiRouter with the deploy-keys 0b8d2bc matrix's minted-session pattern):
 *
 *   - the anon gate on the two POST arms: same-origin anonymous POSTs 303 onto the
 *     login round-trip with the REQUESTED path in redirect_to (the status tail and
 *     the purge tail) and nothing written (D1 read-back on notification_states);
 *   - the cross-origin 403s: sameOriginGuard runs FIRST — a mismatched Origin
 *     rejects with 403 before the session is even read (with or without a cookie)
 *     and the mailbox keeps its unread count;
 *   - the per-type tabs + pager shapes: the 20-per-page window over 21 threads,
 *     Older/Newer links that preserve ?type= on the read tab, the past-the-end
 *     clamp onto the last page (the re-rendered form action carries the clamped
 *     page), and the unknown-?type degrade to unread;
 *   - the status POST round-trips at the D1 level: the answered fragment keeps the
 *     posted tab/page/sequence context, the landed notification_states row for
 *     mark_as_read / pin / mark_as_unread (pin KEEPS the read marker — the
 *     SetNotificationStatus semantics — verified by the unchanged read_at_unix), a
 *     garbage id 404-shells through FormInt64's garbage→0, and the unread count
 *     read back through GET /notifications/new;
 *   - the purge arm's scope: the unread sweep lands read_at_unix rows for exactly
 *     the unread threads and leaves a PINNED row untouched (pinned survives the
 *     purge, data-status 3 stays on the unread tab), and the empty-mailbox purge
 *     is the same JSONRedirect no-op;
 *   - the thread-link shapes: a pull thread anchors /pulls/N (wave10 only pins the
 *     /issues/N shape) and the shared/issueicon glyph machine over the pull state
 *     (open / WIP draft / closed / merged) plus the closed-issue glyph.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { notificationStates, pullRequests } from "../../db/schema";
import type { UiManifest } from "../manifest";
import { uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { RepoRow } from "../ui-context";

// --- the minted-session route harness (the deploy-keys 0b8d2bc pattern) ---------

const ORIGIN = "https://test.local";

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

/** A urlencoded POST to one of the family's arms: the explicit cookie (null
 *  = anonymous) and Origin (null = cross-origin probe) are independent —
 *  the §2.8 guard and the session gate are separate layers. */
async function postArm(
  path: string,
  cookie: string | null,
  fields: Record<string, string> | null,
  origin: string | null = ORIGIN,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) headers.origin = origin;
  if (cookie !== null) headers.cookie = cookie;
  return fetchUi(path, {
    method: "POST",
    headers,
    body: fields === null ? undefined : new URLSearchParams(fields).toString(),
  });
}

// --- fixtures ------------------------------------------------------------------

const T0 = 1_770_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

let issueSeq = 0;

/** One unread mailbox thread for the repo owner: a foreign-posted issue (the
 *  poster arm of the recipient disjunction + the foreign-activity rule), at
 *  a deterministic time. Titles are unique so row-order assertions can key
 *  on the links, not the titles. */
async function seedThread(repoId: string, posterId: number, now: Date): Promise<{ id: number; index: number }> {
  issueSeq += 1;
  const issue = await new IssuesService(env.DB).createIssue({
    repoId,
    title: `ntf deferred thread #${issueSeq}`,
    content: "Foreign activity for the owner.",
    posterId,
    now,
  });
  return { id: issue.id, index: issue.index };
}

async function seedRepo(owner: { id: number; username: string }, slug: string): Promise<RepoRow> {
  return new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: owner.username.toLowerCase() },
    name: slug,
    isPrivate: false,
    status: "ready",
  });
}

/** The stored notification_states rows of one user, ordered by thread id
 *  (the D1 read-back the write assertions ride). */
async function stateRows(userId: number): Promise<Array<{ issueId: number; readAtUnix: number; pinned: boolean }>> {
  const rows = await drizzle(env.DB).select().from(notificationStates).where(eq(notificationStates.userId, userId)).all();
  return rows
    .map((row) => ({ issueId: row.issueId, readAtUnix: row.readAtUnix, pinned: row.pinned }))
    .sort((a, b) => a.issueId - b.issueId);
}

/** The unread count through the ROUTE (the bundle's live badge channel),
 *  not the module function — asserted inline (the wave-10 json pattern; no
 *  intermediate any assignment). */
async function expectUnreadCount(cookie: string, expected: number): Promise<void> {
  const res = await fetchUi("/notifications/new", { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ new: expected });
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // FK order: the state/subscription/watcher/comment/PR rows first, then the
  // per-repo counter (repo_counters → repositories is the one NON-cascade FK,
  // migration 0002 — it must go before its repo), issues before repositories,
  // repositories before users (sessions cascade from users — the deploy-keys
  // wipe precedent).
  for (const table of [
    "notification_states",
    "issue_subscriptions",
    "repo_watchers",
    "comments",
    "pull_requests",
    "issues",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the anon gate on the POST arms ---------------------------------------------

describe("the anon gate on the POST arms (the missing 303s)", () => {
  it("303s an anonymous same-origin POST /notifications/status onto the login round-trip with the requested path, nothing written", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "ntf");
    const thread = await seedThread(repo.id, bob.id, at(10));

    const res = await postArm("/notifications/status", null, {
      notification_id: String(thread.id),
      notification_action: "mark_as_read",
    });
    expect(res.status).toBe(303);
    // The redirect carries the POSTED path (loginRedirect(url.pathname) — the
    // settings anon-POST arm's pin).
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/notifications/status")}`);
    // D1 read-back: no state row landed for the anonymous "write".
    expect(await stateRows(alice.id)).toEqual([]);
    // And the route-level read-back: the thread is still unread.
    await expectUnreadCount(await sessionHeader(alice.id), 1);
  });

  it("303s an anonymous same-origin POST /notifications/purge onto the login round-trip and marks nothing", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "ntf");
    await seedThread(repo.id, bob.id, at(10));

    const res = await postArm("/notifications/purge", null, null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/notifications/purge")}`);
    expect(await stateRows(alice.id)).toEqual([]);
    await expectUnreadCount(await sessionHeader(alice.id), 1);
  });
});

// --- the cross-origin 403s (sameOriginGuard first) -------------------------------

describe("the cross-origin 403s (the guard fronts both POST arms)", () => {
  it("rejects a cross-origin POST /notifications/status with 403 before the session is read — cookie or not", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "ntf");
    const thread = await seedThread(repo.id, bob.id, at(10));
    const fields = { notification_id: String(thread.id), notification_action: "mark_as_read" };

    // With a VALID session cookie the guard still rejects first.
    const signed = await postArm("/notifications/status", await sessionHeader(alice.id), fields, "https://evil.example");
    expect(signed.status).toBe(403);
    expect(signed.headers.get("content-type")).toContain("text/plain");
    expect(await signed.text()).toContain("cross-origin request rejected");
    // And without any cookie the guard precedes the login 303 too (403, not 303).
    const anon = await postArm("/notifications/status", null, fields, "https://evil.example");
    expect(anon.status).toBe(403);
    // Nothing was written either way.
    expect(await stateRows(alice.id)).toEqual([]);
  });

  it("rejects a cross-origin POST /notifications/purge with 403 and the mailbox keeps its unread count", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "ntf");
    await seedThread(repo.id, bob.id, at(10));

    const res = await postArm("/notifications/purge", await sessionHeader(alice.id), null, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await stateRows(alice.id)).toEqual([]);
    await expectUnreadCount(await sessionHeader(alice.id), 1);
  });
});

// --- the per-type tabs + pager shapes --------------------------------------------

describe("the pager shapes (20-per-page window over 21 threads)", () => {
  /** alice + bob + one repo + 21 unread threads for alice, indexes 1..21 in
   *  creation order (the per-repo counter is per-fresh-repo), activities
   *  ascending; the thread ids ride along (the autoincrement survives the
   *  beforeEach row wipe, so ids are NEVER assumed to start at 1). */
  async function seedMailboxOf21(): Promise<{ alice: { id: number; username: string }; cookie: string; threadIds: number[] }> {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "ntf");
    const threadIds: number[] = [];
    for (let i = 1; i <= 21; i += 1) {
      threadIds.push((await seedThread(repo.id, bob.id, at(100 + i))).id);
    }
    return { alice, cookie: await sessionHeader(alice.id), threadIds };
  }

  it("page 1 renders exactly 20 rows with an Older link and no Newer", async () => {
    const { cookie } = await seedMailboxOf21();
    const res = await fetchUi("/notifications", { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect((html.match(/class="notifications-item"/g) ?? []).length).toBe(20);
    // The oldest thread (index 1) spilled to page 2.
    expect(html).not.toContain('href="/alice/ntf/issues/1"');
    // The pager: Older only, the page param without a type (the unread tab is
    // the default — pagerQuery emits no type for it).
    expect(html).toContain('href="/notifications?page=2"');
    expect(html).toContain('<span class="navigation_label">Older</span>');
    expect(html).not.toContain('<span class="navigation_label">Newer</span>');
    // The badge carries the full count, not the page's.
    expect(html).toContain('<div class="notifications-unread-count ui label">21</div>');
  });

  it("page 2 renders the remainder with a Newer link and no Older", async () => {
    const { cookie } = await seedMailboxOf21();
    const res = await fetchUi("/notifications?page=2", { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect((html.match(/class="notifications-item"/g) ?? []).length).toBe(1);
    expect(html).toContain('href="/alice/ntf/issues/1"');
    // Newer onto page 1 — the pager omits the default page param entirely.
    expect(html).toContain('<a class="item navigation" href="/notifications"><span class="navigation_label">Newer</span>');
    expect(html).not.toContain('<span class="navigation_label">Older</span>');
    // The row forms post back with the page context so the fresh fragment
    // keeps the tab/page.
    expect(html).toContain('action="/notifications/status?page=2"');
  });

  it("the read tab's pager preserves type=read in both directions", async () => {
    const { alice, cookie, threadIds } = await seedMailboxOf21();
    // All 21 threads read (direct state rows — the read-tab arrange; the write
    // round-trips are the status POST describe's business). One INSERT per row:
    // a 21-row multi-values insert crosses D1's 100-bind-variable cap.
    for (const issueId of threadIds) {
      await drizzle(env.DB).insert(notificationStates).values({
        userId: alice.id,
        issueId,
        readAtUnix: T0 + 50_000, // past every thread's activity → resolved read
        pinned: false,
        updatedAt: at(50_000),
      });
    }
    const page1 = await fetchUi("/notifications?type=read", { headers: { cookie } });
    const html1 = await page1.text();
    expect((html1.match(/class="notifications-item"/g) ?? []).length).toBe(20);
    // The renderer HTML-escapes the attribute's ampersand (&amp;) — the Older
    // link carries BOTH params with type first (pagerQuery's order).
    expect(html1).toContain('href="/notifications?type=read&amp;page=2"');
    expect(html1).toContain('<span class="navigation_label">Older</span>');
    const page2 = await fetchUi("/notifications?type=read&page=2", { headers: { cookie } });
    const html2 = await page2.text();
    expect((html2.match(/class="notifications-item"/g) ?? []).length).toBe(1);
    // Newer onto page 1 keeps ONLY type=read (the default page param drops).
    expect(html2).toContain('<a class="item navigation" href="/notifications?type=read"><span class="navigation_label">Newer</span>');
  });

  it("a requested page past the end clamps onto the last page", async () => {
    const { cookie } = await seedMailboxOf21();
    const res = await fetchUi("/notifications?page=99", { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Clamped to page 2: the single remainder row, the Newer link and the
    // form action carry the CLAMPED page (upstream's pager rebuild).
    expect((html.match(/class="notifications-item"/g) ?? []).length).toBe(1);
    expect(html).toContain('<a class="item navigation" href="/notifications"><span class="navigation_label">Newer</span>');
    expect(html).not.toContain('<span class="navigation_label">Older</span>');
    expect(html).toContain('action="/notifications/status?page=2"');
  });

  it("an unknown ?type degrades to the unread tab and a junk ?page clamps to 1", async () => {
    const { cookie } = await seedMailboxOf21();
    const res = await fetchUi("/notifications?type=past&page=abc", { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // The unread tab is the active one (parseNotificationPageType's degrade).
    expect(html).toContain('<a class="active item" href="/notifications?type=unread">');
    expect(html).toContain('<a class="item" href="/notifications?type=read">');
    // parsePageNumber's junk → 1: page 1 of 21 → exactly 20 rows + Older.
    expect((html.match(/class="notifications-item"/g) ?? []).length).toBe(20);
    expect(html).toContain('href="/notifications?page=2"');
  });
});

// --- the status POST round-trips at the D1 level ----------------------------------

describe("the status POST round-trips (fragment context + D1 read-back)", () => {
  it("mark_as_read answers the fresh fragment in the posted tab/page/sequence context and lands the state row", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "ntf");
    const thread = await seedThread(repo.id, bob.id, at(10));

    // The POST rides the read tab's query: the re-render keeps tab + sequence.
    const res = await postArm("/notifications/status?type=read&sequence-number=9", await sessionHeader(alice.id), {
      notification_id: String(thread.id),
      notification_action: "mark_as_read",
    });
    expect(res.status).toBe(200);
    const fragment = await res.text();
    expect(fragment.startsWith("<!DOCTYPE html>")).toBe(false); // the div fragment, not a page
    expect(fragment).toContain('id="notification_div"');
    expect(fragment).toContain('data-sequence-number="9"');
    expect(fragment).toContain('<a class="active item" href="/notifications?type=read">');
    expect(fragment).toContain(`id="notification_${thread.id}"`);
    expect(fragment).toContain('data-status="2"');

    // D1 read-back: the marker landed past the thread's activity, pin clear.
    const rows = await stateRows(alice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ issueId: thread.id, pinned: false });
    expect(rows[0]!.readAtUnix).toBeGreaterThanOrEqual(T0);
    await expectUnreadCount(await sessionHeader(alice.id), 0);
  });

  it("pin KEEPS the read marker (SetNotificationStatus semantics) and clears it on mark_as_unread", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "ntf");
    const thread = await seedThread(repo.id, bob.id, at(10));
    const cookie = await sessionHeader(alice.id);

    // Read first, capture the marker…
    await postArm("/notifications/status", cookie, { notification_id: String(thread.id), notification_action: "mark_as_read" });
    const readMarker = (await stateRows(alice.id))[0]!.readAtUnix;
    expect(readMarker).toBeGreaterThanOrEqual(T0);

    // …then pin: the D1 row keeps read_at_unix byte-identical (the pin arm
    // rewrites ONLY the pin flag), and the row is no longer counted unread.
    const pinned = await postArm("/notifications/status", cookie, { notification_id: String(thread.id), notification_action: "pin" });
    expect(pinned.status).toBe(200);
    expect(await stateRows(alice.id)).toEqual([{ issueId: thread.id, readAtUnix: readMarker, pinned: true }]);
    await expectUnreadCount(cookie, 0);

    // mark_as_unread REWRITES the marker to 0 and clears the pin.
    await postArm("/notifications/status", cookie, { notification_id: String(thread.id), notification_action: "mark_as_unread" });
    expect(await stateRows(alice.id)).toEqual([{ issueId: thread.id, readAtUnix: 0, pinned: false }]);
    await expectUnreadCount(cookie, 1);
  });

  it("a garbage id (FormInt64 garbage → 0) 404-shells and writes nothing", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "ntf");
    await seedThread(repo.id, bob.id, at(10));

    const res = await postArm("/notifications/status", await sessionHeader(alice.id), {
      notification_id: "not-a-number",
      notification_action: "mark_as_read",
    });
    expect(res.status).toBe(404); // the miss family — existence hidden
    expect(await stateRows(alice.id)).toEqual([]);
    await expectUnreadCount(await sessionHeader(alice.id), 1);
  });
});

// --- the purge arm's scope --------------------------------------------------------

describe("the purge arm's scope (unread sweep at the D1 level)", () => {
  it("purges exactly the unread threads, leaves a PINNED row untouched, and answers the JSONRedirect", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "ntf");
    const plain1 = await seedThread(repo.id, bob.id, at(10));
    const keepPinned = await seedThread(repo.id, bob.id, at(20));
    const plain2 = await seedThread(repo.id, bob.id, at(30));
    const cookie = await sessionHeader(alice.id);

    // Pin the middle thread (fresh pin on an unread thread: read_at_unix 0).
    await postArm("/notifications/status", cookie, { notification_id: String(keepPinned.id), notification_action: "pin" });

    const res = await postArm("/notifications/purge", cookie, null);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ redirect: "/notifications" });

    // D1 read-back: the two plain threads landed read markers; the pinned row
    // was NOT swept (the unread scope excludes pinned) and keeps its 0 marker.
    const rows = await stateRows(alice.id);
    expect(rows.map((row) => ({ issueId: row.issueId, pinned: row.pinned }))).toEqual([
      { issueId: plain1.id, pinned: false },
      { issueId: keepPinned.id, pinned: true },
      { issueId: plain2.id, pinned: false },
    ]);
    for (const row of rows) {
      if (!row.pinned) expect(row.readAtUnix).toBeGreaterThanOrEqual(T0);
    }
    expect(rows.find((row) => row.issueId === keepPinned.id)).toMatchObject({ readAtUnix: 0, pinned: true });

    // The page read-back: the badge reads 0 (pinned is excluded from the
    // count) while the pinned thread stays on the unread tab as data-status 3.
    await expectUnreadCount(cookie, 0);
    const page = await fetchUi("/notifications", { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('<div class="notifications-unread-count ui label tw-hidden">0</div>');
    expect(html).toContain(`id="notification_${keepPinned.id}"`);
    expect(html).toContain('data-status="3"');
    expect(html).not.toContain('data-status="1"');
  });

  it("an empty mailbox purge is the same JSONRedirect no-op with no rows written", async () => {
    const alice = await seedVerifiedUser({ username: "alice" });
    await seedRepo(alice, "ntf"); // the repo has no threads — the mailbox is empty
    const cookie = await sessionHeader(alice.id);

    const res = await postArm("/notifications/purge", cookie, null);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ redirect: "/notifications" });
    expect(await stateRows(alice.id)).toEqual([]);
  });
});

// --- the thread-link + glyph shapes ------------------------------------------------

describe("the thread-link and glyph shapes (pulls + the issueicon machine)", () => {
  /** alice + bob + one repo, returning the service for the pull arms. */
  async function seedScaffold(): Promise<{ alice: { id: number; username: string }; bob: { id: number; username: string }; repo: RepoRow; svc: IssuesService }> {
    const alice = await seedVerifiedUser({ username: "alice" });
    const bob = await seedVerifiedUser({ username: "bob" });
    const repo = await seedRepo(alice, "ntf");
    return { alice, bob, repo, svc: new IssuesService(env.DB) };
  }

  it("a pull thread anchors /pulls/N with the open-PR glyph; the WIP prefix degrades to the draft glyph", async () => {
    const { alice, bob, repo, svc } = await seedScaffold();
    const open = await svc.createPullRequest({
      repoId: repo.id,
      title: "ntf deferred pull",
      posterId: bob.id,
      headRepoId: repo.id,
      headBranch: "feature",
      baseBranch: "main",
      now: at(10),
    });
    const wip = await svc.createPullRequest({
      repoId: repo.id,
      title: "WIP: add the thing",
      posterId: bob.id,
      headRepoId: repo.id,
      headBranch: "wip-branch",
      baseBranch: "main",
      now: at(20),
    });

    const res = await fetchUi("/notifications", { headers: { cookie: await sessionHeader(alice.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // The pull family's link shape (wave10 pins only the /issues/N shape).
    expect(html).toContain(`href="/alice/ntf/pulls/${open.issue.index}"`);
    expect(html).not.toContain(`href="/alice/ntf/issues/${open.issue.index}"`);
    // The open, non-WIP pull: green open-PR glyph, data-status 1.
    expect(html).toContain('class="svg octicon-git-pull-request tw-text-green"');
    // The WIP-prefixed OPEN pull renders the draft glyph instead (the pure
    // title-prefix check — the draft branch of the state machine).
    expect(html).toContain('class="svg octicon-git-pull-request-draft tw-text-text-light"');
    expect(wip.issue.index).toBe(open.issue.index + 1);
  });

  it("closed and merged pulls and the closed issue carry their glyphs; the issue link stays /issues/N", async () => {
    const { alice, bob, repo, svc } = await seedScaffold();
    const closedPull = await svc.createPullRequest({
      repoId: repo.id,
      title: "ntf closed pull",
      posterId: bob.id,
      headRepoId: repo.id,
      headBranch: "closed-branch",
      baseBranch: "main",
      now: at(10),
    });
    await svc.closeIssue(closedPull.issue.id, { now: at(15) }); // closed, NOT merged

    const mergedPull = await svc.createPullRequest({
      repoId: repo.id,
      title: "ntf merged pull",
      posterId: bob.id,
      headRepoId: repo.id,
      headBranch: "merged-branch",
      baseBranch: "main",
      now: at(20),
    });
    await svc.closeIssue(mergedPull.issue.id, { now: at(25) });
    // The read-side merged stamp (the landed merge path needs engine content;
    // the page reads D1 only — the subscriptions-matrix stamp precedent).
    await drizzle(env.DB).update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.issueId, mergedPull.issue.id));

    const closedIssue = await svc.createIssue({
      repoId: repo.id,
      title: "ntf closed issue",
      posterId: bob.id,
      now: at(30),
    });
    await svc.closeIssue(closedIssue.id, { now: at(35) });

    const res = await fetchUi("/notifications", { headers: { cookie: await sessionHeader(alice.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // Closed pull (not merged): the red closed-PR glyph.
    expect(html).toContain('class="svg octicon-git-pull-request-closed tw-text-red"');
    // Merged pull: the purple merge glyph.
    expect(html).toContain('class="svg octicon-git-merge tw-text-purple"');
    // Closed issue: the red closed-issue glyph and the /issues/ link shape.
    expect(html).toContain('class="svg octicon-issue-closed tw-text-red"');
    expect(html).toContain(`href="/alice/ntf/issues/${closedIssue.index}"`);
    expect(html).not.toContain(`href="/alice/ntf/pulls/${closedIssue.index}"`);
    // Every row stays unread for alice (no state rows were written — closing
    // only adds a system comment): data-status 1 across the board.
    expect((html.match(/data-status="1"/g) ?? []).length).toBe(3);
  });
});
