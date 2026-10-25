/**
 * Pages wave 10 route tests (SPEC-0008 U3 extension): the notifications
 * family (`/notifications` + `/notifications/new` + the status/purge writes
 * — upstream web.go:1784-1791's reqSignIn group over the derived-thread
 * model, pages/notifications.tsx) and the mirror settings panel
 * (`/{owner}/{repo}/settings/mirror` — upstream options.tmpl's Mirror
 * Settings section at the brief's dedicated sub-page, pages/settings.tsx).
 *
 * Same harness posture as pages-wave2..9: the router is driven directly with
 * the synthetic ASSETS manifest, D1 seeds through the landed services /
 * direct row inserts (the notifications page reads D1 only), and the session
 * wave's conventions provide the identities (mintSession cookies — the
 * wave-4 pattern).
 *
 * Visibility under test: the per-user mailbox (the recipient disjunction —
 * owner/watcher/poster/subscriber/commenter arms — and the foreign-activity
 * rule that keeps a poster's own issue out of their own mailbox), the
 * mark/unread/pin state machine through the POST arms, the mark-all purge,
 * the mirror panel's admin gate, and the honest absences (the API's missing
 * settings-write arm, the non-mirror empty state).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { issues, repositories, repoMirrors, users } from "../../db/schema";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { isWatchingRepo, watchRepo } from "../../api/services/repo-watchers";
import { IssuesService } from "../../issues/service";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie =
  (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

/** A urlencoded POST with the session cookie + the §2.8 Origin (the header
 *  merge the withCookie/form spreads would otherwise lose). */
const postForm = (cookie: string, fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: {
    cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://test.local",
  },
  body: new URLSearchParams(fields).toString(),
});

// --- fixtures -----------------------------------------------------------------

interface Wave10Fixture {
  aliceCookie: string;
  bobCookie: string;
  carolCookie: string;
  /** The two mailbox thread ids (issue rows), alice's repo scoped. */
  issueAId: number; // poster carol on alice's repo — thread for alice (owner) + bob (watcher)
  issueBId: number; // poster alice, commented by bob — thread for both
  mirrorRepoId: string;
  archivedMirrorRepoId: string;
}

let wave10Fixture: Wave10Fixture | null = null;

/** A public repository row without engine content (the wave-9 row-only
 *  pattern) — the mailbox and the mirror panel read D1 only. */
async function ensureRowRepo(
  owner: { id: number; usernameLower: string },
  slug: string,
  opts?: { isPrivate?: boolean; isArchived?: boolean },
): Promise<string> {
  const db = drizzle(env.DB);
  const existing = await db.select({ id: repositories.id }).from(repositories).where(eq(repositories.slug, slug)).get();
  if (existing !== undefined) return existing.id;
  const id = `r_wave10-${slug}`;
  await db.insert(repositories).values({
    id,
    storageKey: id,
    ownerNamespace: owner.usernameLower,
    ownerId: owner.id,
    slug,
    visibility: opts?.isPrivate ? "private" : "public",
    isArchived: opts?.isArchived ?? false,
    isEmpty: true,
  });
  return id;
}

async function ensureWave10Fixtures(): Promise<Wave10Fixture> {
  if (wave10Fixture !== null) return wave10Fixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();

  // alice (the repo owner / admin viewer) through the auth seeds — this file
  // runs in isolated storage and shares no fixtures with the other waves.
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) === undefined) {
    await seedVerifiedUser({ username: "alice" });
  }
  for (const extra of ["wave10bob", "wave10carol"] as const) {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra)).get();
    if (existing === undefined) {
      await db.insert(users).values({
        username: extra,
        usernameLower: extra,
        isAdmin: false,
        status: "active",
        visibility: "public",
        createdAt: new Date(T0 * 1000),
      });
    }
  }
  const alice = await db.select().from(users).where(eq(users.usernameLower, "alice")).get();
  const bob = await db.select().from(users).where(eq(users.usernameLower, "wave10bob")).get();
  const carol = await db.select().from(users).where(eq(users.usernameLower, "wave10carol")).get();
  if (alice === undefined || bob === undefined || carol === undefined) throw new Error("wave10 identity rows missing");

  const aliceOwner = { id: alice.id, usernameLower: "alice" };
  const mxRepoId = await ensureRowRepo(aliceOwner, "wave10-mx");
  const mirrorRepoId = await ensureRowRepo(aliceOwner, "wave10-mirror");
  await ensureRowRepo(aliceOwner, "wave10-plain");
  const archivedMirrorRepoId = await ensureRowRepo(aliceOwner, "wave10-archived", { isArchived: true });

  // bob watches alice's mailbox repo (the recipient disjunction's watcher arm).
  if (!(await isWatchingRepo(env.DB, mxRepoId, bob.id))) {
    await watchRepo(env.DB, mxRepoId, bob.id, new Date(T0 * 1000));
  }

  // The two threads, every write at a fixed time (§5.2 determinism):
  //  A — poster carol on alice's repo: alice (owner) + bob (watcher) get a
  //      thread; CAROL DOES NOT (her own creation is the only activity —
  //      the foreign-activity rule).
  //  B — poster alice, commented by bob: both hold the thread (poster's
  //      foreign comment / commenter's foreign creation).
  const svc = new IssuesService(env.DB);
  const existingIssues = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, mxRepoId)).all();
  let issueAId: number;
  let issueBId: number;
  if (existingIssues.length === 0) {
    const issueA = await svc.createIssue({
      repoId: mxRepoId,
      title: "wave10: carol files the mailbox thread",
      content: "Foreign activity for the owner and the watcher.",
      posterId: carol.id,
      now: new Date((T0 + 10) * 1000),
    });
    const issueB = await svc.createIssue({
      repoId: mxRepoId,
      title: "wave10: alice's thread gains bob's comment",
      content: "The commenter arm.",
      posterId: alice.id,
      now: new Date((T0 + 20) * 1000),
    });
    await svc.addComment({
      issueId: issueB.id,
      posterId: bob.id,
      content: "Foreign activity for the poster.",
      now: new Date((T0 + 30) * 1000),
    });
    issueAId = issueA.id;
    issueBId = issueB.id;
  } else {
    // Idempotent re-entry: the lowest ids are the seeded pair (the per-repo
    // counter is monotonic — creation order IS id order here).
    const sorted = existingIssues.map((row) => row.id).sort((x, y) => x - y);
    issueAId = sorted[0] as number;
    issueBId = sorted[1] as number;
  }

  // The mirror rows (the seedGoldenMirror shape — pinned timestamps).
  const seedMirror = async (repoId: string, remoteAddress: string): Promise<void> => {
    const existing = await db.select({ repoId: repoMirrors.repoId }).from(repoMirrors).where(eq(repoMirrors.repoId, repoId)).get();
    if (existing !== undefined) return;
    await db.insert(repoMirrors).values({
      repoId,
      intervalSeconds: 28800,
      enablePrune: true,
      lfsEnabled: false,
      lfsEndpoint: null,
      remoteAddress,
      credentialsUsername: null,
      credentialsCiphertext: null,
      syncState: "idle",
      nextSyncAt: T0 + 28800,
      lastSyncAt: T0,
      lastError: null,
      createdAt: new Date(T0 * 1000),
      updatedAt: new Date((T0 + 60) * 1000),
    });
  };
  await seedMirror(mirrorRepoId, "https://mirrors.invalid/wave10.git");
  await seedMirror(archivedMirrorRepoId, "https://mirrors.invalid/archived.git");

  wave10Fixture = {
    aliceCookie: await mintSession(env.DB, alice.id),
    bobCookie: await mintSession(env.DB, bob.id),
    carolCookie: await mintSession(env.DB, carol.id),
    issueAId,
    issueBId,
    mirrorRepoId,
    archivedMirrorRepoId,
  };
  return wave10Fixture;
}

beforeAll(async () => {
  await ensureWave10Fixtures();
});

// --- the parsers (the single owner of the route shapes) -------------------------

describe("wave-10 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the notifications literals and the mirror settings tail", () => {
    expect(parseUiRoute("/notifications")).toEqual({ family: "notifications" });
    expect(parseUiRoute("/notifications/new")).toEqual({ family: "notification-new" });
    expect(parseUiRoute("/notifications/status")).toEqual({ family: "notification-status" });
    expect(parseUiRoute("/notifications/purge")).toEqual({ family: "notification-purge" });
    expect(parseUiRoute("/alice/wave10-mirror/settings/mirror")).toEqual({
      family: "settings-mirror",
      owner: "alice",
      repo: "wave10-mirror",
    });
    expect(handlesUiRoute("/notifications/purge")).toBe(true);
    expect(handlesUiRoute("/alice/wave10-mirror/settings/mirror")).toBe(true);
  });

  it("leaves the deeper notifications tails and the same-cased namespace alone", () => {
    // subscriptions/watching have no page this slice — the engine answers,
    // exactly upstream's unregistered-route 404.
    expect(parseUiRoute("/notifications/subscriptions")).toBeNull();
    expect(parseUiRoute("/notifications/watching")).toBeNull();
    // The literals bind case-sensitively (the explore precedent).
    expect(parseUiRoute("/NOTIFICATIONS")).toEqual({ family: "owner-home", owner: "NOTIFICATIONS" });
  });
});

// --- the mailbox page -----------------------------------------------------------

describe("notifications page (/notifications)", () => {
  it("303s anonymous viewers onto the login round-trip", async () => {
    const res = await fetchUi("/notifications");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Fnotifications");
  });

  it("renders the unread tab with the derived threads, the tab badge and the mark-all button", async () => {
    const fixture = await ensureWave10Fixtures();
    const res = await fetchUi("/notifications", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    // The §2.4.1 discriminator + upstream's role=main id/sequence attrs.
    expect(html).toContain('<div role="main" aria-label="Notifications" class="page-content user notification" id="notification_div"');
    // The unread tab is active and carries the count badge; read is not.
    expect(html).toContain('<a class="active item" href="/notifications?type=unread">');
    expect(html).toContain('<div class="notifications-unread-count ui label">2</div>');
    expect(html).toContain('<a class="item" href="/notifications?type=read">');
    // Both threads (owner arm + poster arm), newest activity first: B (T0+30)
    // before A (T0+10); each row anchors its subject page with #index.
    expect(html.indexOf("/alice/wave10-mx/issues/2")).toBeLessThan(html.indexOf("/alice/wave10-mx/issues/1"));
    expect(html).toContain("wave10: carol files the mailbox thread");
    expect(html).toContain("wave10: alice&#39;s thread gains bob&#39;s comment");
    expect(html).toContain('<span class="tw-text-text-light-3">#1</span>');
    // data-status 1 (unread), the pin + mark-as-read buttons in the row form.
    expect(html).toContain('data-status="1"');
    expect(html).toContain('value="mark_as_read"');
    expect(html).toContain('value="pin"');
    // The mark-all button (the unread tab with a positive count).
    expect(html).toContain('data-url="/notifications/purge"');
    // The navbar bell carries the count (head_navbar_icons.tmpl shape).
    expect(html).toContain('<a class="item" href="/notifications" data-tooltip-content="Notifications"');
    expect(html).toContain('<span class="notification_count">2</span>');
  });

  it("is a per-user mailbox: the commenter sees the threads, the poster-with-no-foreign-activity does not", async () => {
    const fixture = await ensureWave10Fixtures();
    // Bob (watcher + commenter): both threads.
    const bob = await fetchUi("/notifications", withCookie(fixture.bobCookie));
    expect(bob.status).toBe(200);
    const bobHtml = await bob.text();
    expect(bobHtml).toContain("wave10: carol files the mailbox thread");
    expect(bobHtml).toContain('<span class="notification_count">2</span>');

    // Carol: the poster of A with no foreign-authored activity on it — no
    // mailbox entry (the derived model's foreign-activity rule), the empty
    // placeholder, the hidden bell badge and NO mark-all button.
    const carol = await fetchUi("/notifications", withCookie(fixture.carolCookie));
    expect(carol.status).toBe(200);
    const carolHtml = await carol.text();
    expect(carolHtml).toContain("No unread notifications.");
    expect(carolHtml).not.toContain("wave10: carol files the mailbox thread");
    expect(carolHtml).toContain('<span class="notification_count tw-hidden">0</span>');
    expect(carolHtml).not.toContain('data-url="/notifications/purge"');
  });

  it("renders the read tab's empty placeholder and keeps ?type active", async () => {
    const fixture = await ensureWave10Fixtures();
    const res = await fetchUi("/notifications?type=read", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a class="active item" href="/notifications?type=read">');
    expect(html).toContain("No read notifications.");
  });

  it("marks a thread read through POST /notifications/status and answers the fresh div fragment", async () => {
    const fixture = await ensureWave10Fixtures();
    const post = await fetchUi("/notifications/status", postForm(fixture.aliceCookie, { notification_id: String(fixture.issueAId), notification_action: "mark_as_read" }));
    expect(post.status).toBe(200);
    const fragment = await post.text();
    expect(fragment.startsWith("<!DOCTYPE html>")).toBe(false);
    expect(fragment).toContain('id="notification_div"');
    // The written row LEFT the unread tab…
    const unread = await fetchUi("/notifications", withCookie(fixture.aliceCookie));
    const unreadHtml = await unread.text();
    expect(unreadHtml).toContain('<div class="notifications-unread-count ui label">1</div>');
    expect(unreadHtml).not.toContain(`id="notification_${fixture.issueAId}"`);
    // …and shows on the read tab as data-status 2 with the mark-as-unread button.
    const read = await fetchUi("/notifications?type=read", withCookie(fixture.aliceCookie));
    const readHtml = await read.text();
    expect(readHtml).toContain(`id="notification_${fixture.issueAId}"`);
    expect(readHtml).toContain('data-status="2"');
    expect(readHtml).toContain('value="mark_as_unread"');

    // Back to unread (the bell button branch).
    const back = await fetchUi("/notifications/status", postForm(fixture.aliceCookie, { notification_id: String(fixture.issueAId), notification_action: "mark_as_unread" }));
    expect(back.status).toBe(200);
    const restored = await fetchUi("/notifications", withCookie(fixture.aliceCookie));
    expect(await restored.text()).toContain('<div class="notifications-unread-count ui label">2</div>');
  });

  it("pins a thread: pinned shows on both tabs with the pin mark, the pin button gone", async () => {
    const fixture = await ensureWave10Fixtures();
    const post = await fetchUi("/notifications/status", postForm(fixture.bobCookie, { notification_id: String(fixture.issueBId), notification_action: "pin" }));
    expect(post.status).toBe(200);
    // Pinned counts as non-unread (Unread = !(read || pinned)) — the badge
    // drops from 2 to 1 (issue A stays unread; the pinned row itself is
    // excluded from the unread count like notifyNewAvailable's arm).
    const unread = await fetchUi("/notifications", withCookie(fixture.bobCookie));
    const unreadHtml = await unread.text();
    expect(unreadHtml).toContain('<div class="notifications-unread-count ui label">1</div>');
    expect(unreadHtml).toContain(`id="notification_${fixture.issueBId}"`);
    expect(unreadHtml).toContain('data-status="3"');
    expect(unreadHtml).toContain('class="svg octicon-pin tw-text-blue"');
    // The pinned row keeps only mark-as-read in its form.
    const rowStart = unreadHtml.indexOf(`id="notification_${fixture.issueBId}"`);
    const rowEnd = unreadHtml.indexOf("notifications-item", rowStart + 10);
    const row = unreadHtml.slice(rowStart, rowEnd);
    expect(row).toContain('value="mark_as_read"');
    expect(row).not.toContain('value="pin"');
    // Pinned rows surface on the read tab too (queryStatus + Pinned).
    const read = await fetchUi("/notifications?type=read", withCookie(fixture.bobCookie));
    expect((await read.text())).toContain(`id="notification_${fixture.issueBId}"`);

    // Cleanup for the purge test below: back to unread.
    await fetchUi("/notifications/status", postForm(fixture.bobCookie, { notification_id: String(fixture.issueBId), notification_action: "mark_as_unread" }));
  });

  it("purges the mailbox through POST /notifications/purge with the JSONRedirect answer", async () => {
    const fixture = await ensureWave10Fixtures();
    const post = await fetchUi("/notifications/purge", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.bobCookie}`, origin: "https://test.local" },
    });
    expect(post.status).toBe(200);
    expect(post.headers.get("content-type")).toContain("application/json");
    expect(await post.json()).toEqual({ redirect: "/notifications" });
    const after = await fetchUi("/notifications", withCookie(fixture.bobCookie));
    const afterHtml = await after.text();
    expect(afterHtml).toContain('<div class="notifications-unread-count ui label tw-hidden">');
    expect(afterHtml).toContain("No unread notifications.");
    // …and the read tab carries the purged rows.
    const read = await fetchUi("/notifications?type=read", withCookie(fixture.bobCookie));
    expect((await read.text())).toContain(`id="notification_${fixture.issueAId}"`);
  });

  it("404-shells a POST for a thread outside the caller's mailbox and ignores unknown actions", async () => {
    const fixture = await ensureWave10Fixtures();
    // A nonexistent thread id.
    const missing = await fetchUi("/notifications/status", postForm(fixture.aliceCookie, { notification_id: "999999", notification_action: "mark_as_read" }));
    expect(missing.status).toBe(404);
    // Carol authored issue A with no foreign activity — no mailbox entry for
    // her; the write refuses (existence hidden).
    const notMine = await fetchUi("/notifications/status", postForm(fixture.carolCookie, { notification_id: String(fixture.issueAId), notification_action: "mark_as_read" }));
    expect(notMine.status).toBe(404);
    // Unknown action — the empty 200 (upstream `default: return`).
    const unknown = await fetchUi("/notifications/status", postForm(fixture.aliceCookie, { notification_id: String(fixture.issueAId), notification_action: "detonate" }));
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toBe("");
    // GET on the POST-only tails — chi's 405.
    expect((await fetchUi("/notifications/status")).status).toBe(405);
    expect((await fetchUi("/notifications/purge")).status).toBe(405);
  });

  it("serves the div-only fragment and passes the sequence number through", async () => {
    const fixture = await ensureWave10Fixtures();
    const res = await fetchUi("/notifications?div-only=1&sequence-number=7", withCookie(fixture.carolCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(false);
    expect(html).toContain('id="notification_div"');
    expect(html).toContain('data-sequence-number="7"');
    expect(html).not.toContain("<html");
    // The page arm carries the same passthrough.
    const page = await fetchUi("/notifications?sequence-number=12", withCookie(fixture.carolCookie));
    expect((await page.text())).toContain('data-sequence-number="12"');
  });

  it("serves the unread count JSON with the upstream degrade", async () => {
    const fixture = await ensureWave10Fixtures();
    const anon = await fetchUi("/notifications/new");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Fnotifications%2Fnew");
    const res = await fetchUi("/notifications/new", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ new: 2 });
  });
});

// --- the mirror settings panel ---------------------------------------------------

describe("mirror settings panel (/settings/mirror)", () => {
  it("303s anonymous viewers onto the login round-trip and 404-shells non-admins", async () => {
    const anon = await fetchUi("/alice/wave10-mirror/settings/mirror");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fwave10-mirror%2Fsettings%2Fmirror");
    const fixture = await ensureWave10Fixtures();
    const other = await fetchUi("/alice/wave10-mirror/settings/mirror", withCookie(fixture.bobCookie));
    expect(other.status).toBe(404);
    expect(await other.text()).toContain("404 Not Found");
  });

  it("renders the mirror table, status lines and the honest absence for the admin", async () => {
    const fixture = await ensureWave10Fixtures();
    const res = await fetchUi("/alice/wave10-mirror/settings/mirror", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="Mirror Settings" class="page-content repository settings mirror">');
    // The settings navbar gained the Mirror item (last, after Webhooks).
    expect(html).toContain('<a class="active item" href="/alice/wave10-mirror/settings/mirror">Mirror Settings</a>');
    expect(html.indexOf("/settings/hooks")).toBeLessThan(html.indexOf("/settings/mirror"));
    // The upstream table: address | Pull | last update | Synchronize Now.
    expect(html).toContain('<th class="tw-w-2/5" scope="col">Mirrored repository</th>');
    expect(html).toContain("<td>https://mirrors.invalid/wave10.git</td>");
    expect(html).toContain("<td>Pull</td>");
    expect(html).toContain("Synchronize Now");
    // The status lines: sync state, the pinned next/last sync, interval + prune.
    expect(html).toContain("Sync state: idle");
    expect(html).toContain("Interval: 8h0m0s");
    expect(html).toContain("Prune (Remove obsolete remote-tracking references): ✓");
    expect(html).not.toContain("Last error");
    // The honest absence (no PUT arm — no edit form controls rendered).
    expect(html).toContain("Editing the interval, prune or source address is not supported yet");
    expect(html).not.toContain('<input id="interval"');
    expect(html).not.toContain('<input id="enable_prune"');
  });

  it("renders the not-a-mirror empty state and the archived warning", async () => {
    const fixture = await ensureWave10Fixtures();
    const plain = await fetchUi("/alice/wave10-plain/settings/mirror", withCookie(fixture.aliceCookie));
    expect(plain.status).toBe(200);
    const plainHtml = await plain.text();
    expect(plainHtml).toContain("This repository is not a pull mirror.");
    expect(plainHtml).toContain("POST /api/v1/repos/{owner}/{repo}/migrate");

    const archived = await fetchUi("/alice/wave10-archived/settings/mirror", withCookie(fixture.aliceCookie));
    expect(archived.status).toBe(200);
    expect((await archived.text())).toContain("Mirrors are not available if the repo is archived.");
  });

  it("queues a sync through the POST and renders the queued flash on redirect", async () => {
    const fixture = await ensureWave10Fixtures();
    const post = await fetchUi("/alice/wave10-mirror/settings/mirror", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.aliceCookie}`, origin: "https://test.local" },
    });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/alice/wave10-mirror/settings/mirror?sync=queued");
    const page = await fetchUi("/alice/wave10-mirror/settings/mirror?sync=queued", withCookie(fixture.aliceCookie));
    const html = await page.text();
    expect(html).toContain("Pulling changes from the remote https://mirrors.invalid/wave10.git at the moment.");
    // The flash is display-only: without the param the message is absent.
    const plain = await fetchUi("/alice/wave10-mirror/settings/mirror", withCookie(fixture.aliceCookie));
    expect((await plain.text())).not.toContain("Pulling changes from the remote");
  });

  it("404-shells the POST refusals (not a mirror / archived) and gates anonymous viewers", async () => {
    const fixture = await ensureWave10Fixtures();
    const notMirror = await fetchUi("/alice/wave10-plain/settings/mirror", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.aliceCookie}`, origin: "https://test.local" },
    });
    expect(notMirror.status).toBe(404);
    const archived = await fetchUi("/alice/wave10-archived/settings/mirror", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.aliceCookie}`, origin: "https://test.local" },
    });
    expect(archived.status).toBe(404);
    const anon = await fetchUi("/alice/wave10-mirror/settings/mirror", {
      method: "POST",
      headers: { origin: "https://test.local" },
    });
    expect(anon.status).toBe(303);
    const other = await fetchUi("/alice/wave10-mirror/settings/mirror", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.bobCookie}`, origin: "https://test.local" },
    });
    expect(other.status).toBe(404);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-10 a11y smoke", () => {
  it("the new pages pass the structural rules", async () => {
    const fixture = await ensureWave10Fixtures();
    for (const [path, init] of [
      ["/notifications", withCookie(fixture.aliceCookie)],
      ["/notifications?type=read", withCookie(fixture.aliceCookie)],
      ["/notifications", withCookie(fixture.carolCookie)], // the empty render
      ["/alice/wave10-mirror/settings/mirror", withCookie(fixture.aliceCookie)],
      ["/alice/wave10-plain/settings/mirror", withCookie(fixture.aliceCookie)],
    ] as Array<[string, RequestInit]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
