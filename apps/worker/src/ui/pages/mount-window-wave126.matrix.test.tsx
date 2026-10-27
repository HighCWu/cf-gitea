/**
 * The wave-126 mount window's DEFERRED route-level matrix — the arms the
 * mounted families' module suites deferred to "the orchestrator's window"
 * (each module doc's HANDOFF NOTE), driven through the REAL routes on the
 * minted-session pattern (aux-fragments.matrix is the harness reference):
 *
 *   - the FEED TWINS' gate matrix (pages/releases-feed-xml.ts +
 *     pages/tags-feed-xml.ts): the content-type pairs on 200, the
 *     `releasesReadGate` pair (a releases-DISABLED repo 404s releases.rss
 *     but SERVES tags.rss — the twins' documented gate divergence,
 *     web.go:1502 vs :1504), and the MustBeNotEmpty empty-repo 404s for
 *     both;
 *   - the CONTENT-HISTORY list/detail dropdown arms
 *     (pages/issue-content-fragments.ts): the list JSON (results + the
 *     `{"results":null}` empty-200 comment-miss quirk) and the detail's
 *     JSON 404 body on a foreign history id — the module's loud rule that
 *     `historyNotFound` IS the JSON body, never the HTML shell;
 *   - the ADMIN TRIO's gates (pages/admin-users/orgs/repos.tsx through the
 *     shared adminPagePrologue): anonymous 303s onto the login round-trip,
 *     a signed-in non-admin 404-shells, the admin gets the page with the
 *     shared navbar's item marked active;
 *   - the SETTINGS PAIRS' route arms (pages/user-settings-account.tsx +
 *     pages/user-settings-notifications.tsx): anonymous 303s, the
 *     guard-first cross-origin 403 (the POST prologue precedes the
 *     session), the saved 303 targets, the invalid re-renders at 200 with
 *     the per-form error routing (the actions catalog rejecting a valid
 *     EMAIL value — the disjoint catalogs), and the nav-swap assertion
 *     (the shared navbar renders the item exactly once, marked active).
 *
 * Fixture posture: the feeds group seeds RAW D1 rows (the releases-feed
 * smoke's discipline — the releases feed never reads the engine, and the
 * tags feed's engine read degrades to the empty universe on the cell-less
 * fixture, exactly the §4.9 arm); wiped per test, re-seeded lazily. The
 * content-history group copies the aux matrix's FK-ordered wipe. The
 * admin/settings groups ride the auth migrations + seedVerifiedUser.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import {
  emailAddresses,
  issueContentHistory,
  repoSettings,
  repositories,
  users,
} from "../../db/schema";
import { updateCommentBody } from "../../api/services/issues";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { userSettingsNotificationsLocale } from "./user-settings-notifications";

// --- the minted-session route harness -----------------------------------------

/** Synthetic manifest shaped like the real Vite output (deterministic, no
 *  build dependence — the shared matrix fixture shape). */
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

/** A minted session cookie header for the user (the real mintSession path —
 *  the beforeEach users wipe cascades the sessions table, so cookies are
 *  minted per request). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A form POST through the mounted router (the readUrlEncodedForm content
 *  type; extra headers merge over the cookie). */
async function postForm(
  path: string,
  body: Record<string, string>,
  cookie?: string,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  return fetchUi(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
      ...extraHeaders,
    },
    body: new URLSearchParams(body).toString(),
  });
}

const T0 = 1_760_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

beforeAll(async () => {
  await applyAuthD1Migrations();
});

// =============================================================================
// Group 1 — the feed twins' gate matrix (raw D1 fixture, wiped per test)
// =============================================================================

const FEED_REPO_ID = "feed-repo-1";
const EMPTY_FEED_REPO_ID = "feed-repo-empty";

/** The raw rows: one PUBLIC non-empty repo, one PUBLIC EMPTY repo (the
 *  MustBeNotEmpty arm). The release rows behind v1.0.0 (publisher = the
 *  owner) plus one DRAFT row proving the unconditional exclusion through
 *  the route. */
async function seedFeedRows(): Promise<void> {
  const db = drizzle(env.DB);
  await db.insert(users).values({
    username: "feed-alice",
    usernameLower: "feed-alice",
    status: "active",
    visibility: "public",
    createdAt: at(0),
  });
  const alice = (await db.select().from(users).where(eq(users.usernameLower, "feed-alice")).get())!;
  await db.insert(repositories).values([
    {
      id: FEED_REPO_ID,
      storageKey: FEED_REPO_ID,
      ownerNamespace: "feed-alice",
      ownerId: alice.id,
      slug: "feedrepo",
      visibility: "public",
      isEmpty: false,
      createdAt: at(1),
    },
    {
      id: EMPTY_FEED_REPO_ID,
      storageKey: EMPTY_FEED_REPO_ID,
      ownerNamespace: "feed-alice",
      ownerId: alice.id,
      slug: "feedempty",
      visibility: "public",
      isEmpty: true,
      createdAt: at(1),
    },
  ]);
  await env.DB.prepare(
    "INSERT INTO releases (repo_id, publisher_id, tag_name, lower_tag_name, title, note, is_draft, is_prerelease, is_tag, created_unix, published_unix) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)",
  )
    .bind(FEED_REPO_ID, alice.id, "v1.0.0", "v1.0.0", "First release", "Notes", T0 + 10, T0 + 10)
    .run();
  await env.DB.prepare(
    "INSERT INTO releases (repo_id, publisher_id, tag_name, lower_tag_name, title, note, is_draft, is_prerelease, is_tag, created_unix, published_unix) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?)",
  )
    .bind(FEED_REPO_ID, alice.id, "v0.9.0-draft", "v0.9.0-draft", "Sneaky draft", "", T0 + 20, 0)
    .run();
}

describe("the feed twins through the mounted route (the gate matrix)", () => {
  beforeEach(async () => {
    for (const table of ["releases", "repo_settings", "repositories", "users"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
  });

  it("serves releases.rss/.atom with the gorilla-parity content types, drafts excluded", async () => {
    await seedFeedRows();
    const rss = await fetchUi("/feed-alice/feedrepo/releases.rss");
    expect(rss.status).toBe(200);
    expect(rss.headers.get("content-type")).toBe("application/rss+xml;charset=utf-8");
    const rssBody = await rss.text();
    expect(rssBody).toContain("<rss");
    expect(rssBody).toContain("First release");
    expect(rssBody).not.toContain("Sneaky draft"); // drafts excluded unconditionally

    const atom = await fetchUi("/feed-alice/feedrepo/releases.atom");
    expect(atom.status).toBe(200);
    expect(atom.headers.get("content-type")).toBe("application/atom+xml;charset=utf-8");
    expect(await atom.text()).toContain("<feed");
  });

  it("the KEY gate pair: a releases-DISABLED repo 404s releases.rss but SERVES tags.rss (web.go:1502 vs :1504)", async () => {
    await seedFeedRows();
    await drizzle(env.DB).insert(repoSettings).values({ repoId: FEED_REPO_ID, hasReleases: false });
    const releases = await fetchUi("/feed-alice/feedrepo/releases.rss");
    expect(releases.status).toBe(404); // CanRead(TypeReleases) false → the §4.5 shell
    expect(await releases.text()).toContain("status-page-error");
    const tags = await fetchUi("/feed-alice/feedrepo/tags.rss");
    expect(tags.status).toBe(200); // the tags group gates reqUnitCodeReader — NO releases gate
    expect(tags.headers.get("content-type")).toBe("application/rss+xml;charset=utf-8");
    // The tags channel rides the engine tag universe (EMPTY on this cell-less
    // fixture — the §4.9 degraded arm), so the channel is empty but still
    // 200: the gate divergence is the pin, not the item count.
  });

  it("the MustBeNotEmpty arm: an empty repo 404-shells BOTH twins", async () => {
    await seedFeedRows();
    for (const tail of ["releases.rss", "releases.atom", "tags.rss", "tags.atom"]) {
      const res = await fetchUi(`/feed-alice/feedempty/${tail}`);
      expect(res.status, tail).toBe(404);
      expect(await res.text(), tail).toContain("status-page-error");
    }
  });

  it("the dotted heads claim case-sensitively and nothing deeper", () => {
    expect(parseUiRoute("/o/r/releases.rss")).toMatchObject({ family: "release-feed-rss" });
    expect(parseUiRoute("/o/r/releases.atom")).toMatchObject({ family: "release-feed-atom" });
    expect(parseUiRoute("/o/r/tags.rss")).toMatchObject({ family: "tags-feed-rss" });
    expect(parseUiRoute("/o/r/tags.atom")).toMatchObject({ family: "tags-feed-atom" });
    expect(parseUiRoute("/o/r/releases.rss/extra")).toBeNull();
    expect(parseUiRoute("/o/r/tags.rss/extra")).toBeNull();
    expect(handlesUiRoute("/o/r/releases.rss")).toBe(true);
    expect(handlesUiRoute("/o/r/tags.atom")).toBe(true);
  });
});

// =============================================================================
// Group 2 — the content-history dropdown arms (D1 fixture, wiped per test)
// =============================================================================

interface HistoryFixture {
  ownerUsername: string;
  repoSlug: string;
  issueIndex: number;
  commentId: number;
  /** BOTH history rows the fixture produces: the comment-create marker
   *  (is_first_created) AND the edit row — the list answers both. */
  historyIds: number[];
}

describe("the content-history list/detail dropdown arms through the mounted route", () => {
  let historyFixture: HistoryFixture | undefined;

  beforeEach(async () => {
    // FK order: join/write rows first, then issues, then the per-repo
    // counter, then repositories/personal_access_tokens before users.
    for (const table of [
      "issue_attachments",
      "issue_labels",
      "issue_pins",
      "issue_subscriptions",
      "issue_content_history",
      "labels",
      "milestones",
      "comments",
      "pull_requests",
      "issues",
      "repo_counters",
      "repositories",
      "personal_access_tokens",
      "users",
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    historyFixture = undefined;
  });

  /** One public repo, one issue, one comment edited once (one history row). */
  async function ensureFixture(): Promise<HistoryFixture> {
    if (historyFixture !== undefined) return historyFixture;
    const poster = await seedVerifiedUser({ username: "w126-hist" });
    const service = new RepoService(env.DB);
    const repo = await service.create({
      owner: { id: poster.id, usernameLower: "w126-hist" },
      name: "histrepo",
      isPrivate: false,
      status: "ready",
    });
    const svc = new IssuesService(env.DB);
    const issue = await svc.createIssue({ repoId: repo.id, title: "history target", posterId: poster.id, now: at(10) });
    const comment = await svc.addComment({ issueId: issue.id, posterId: poster.id, content: "v0" });
    await updateCommentBody(env.DB, comment.id, "v1", at(20));
    const historyRows = await drizzle(env.DB)
      .select({ id: issueContentHistory.id })
      .from(issueContentHistory)
      .where(eq(issueContentHistory.commentId, comment.id))
      .all();
    if (historyRows.length === 0) throw new Error("fixture history rows missing");
    historyFixture = {
      ownerUsername: "w126-hist",
      repoSlug: "histrepo",
      issueIndex: issue.index,
      commentId: comment.id,
      historyIds: historyRows.map((row) => row.id),
    };
    return historyFixture;
  }

  it("serves the list JSON for an edited comment; a comment-miss answers the empty-200 `results: null` quirk", async () => {
    const fx = await ensureFixture();
    const res = await fetchUi(`/${fx.ownerUsername}/${fx.repoSlug}/issues/${fx.issueIndex}/content-history/list?comment_id=${fx.commentId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json<{ results: { name: string; value: number }[] | null }>();
    // BOTH rows: the comment-create marker + the edit (newest first).
    expect(body.results?.length).toBe(fx.historyIds.length);
    for (const id of fx.historyIds) {
      expect(body.results?.some((item) => item.value === id)).toBe(true);
    }

    // The unknown comment id → upstream's nil-marshals-to-null empty 200.
    const empty = await fetchUi(`/${fx.ownerUsername}/${fx.repoSlug}/issues/${fx.issueIndex}/content-history/list?comment_id=424242`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ results: null });
  });

  it("the detail's foreign history id IS the JSON 404 body — never the HTML shell (the module's loud rule)", async () => {
    const fx = await ensureFixture();
    const foreign = await fetchUi(
      `/${fx.ownerUsername}/${fx.repoSlug}/issues/${fx.issueIndex}/content-history/detail?comment_id=${fx.commentId}&history_id=987654`,
    );
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("content-type")).toContain("application/json");
    expect(await foreign.json()).toEqual({ message: "Can not find the content history" });

    // A REAL history id renders the diff payload at 200 — the builder strips
    // the `kind` discriminator (the payload is canSoftDelete + historyId +
    // prevHistoryId + diffHtml).
    const ok = await fetchUi(
      `/${fx.ownerUsername}/${fx.repoSlug}/issues/${fx.issueIndex}/content-history/detail?comment_id=${fx.commentId}&history_id=${fx.historyIds[0]}`,
    );
    expect(ok.status).toBe(200);
    const okBody = await ok.json<{ historyId: number; prevHistoryId: number; diffHtml: string }>();
    expect(okBody.historyId).toBe(fx.historyIds[0]);
    expect(typeof okBody.diffHtml).toBe("string");
  });

  it("an unknown issue index 404-shells both arms; FormInt64 junk parses as 0 (the empty-200)", async () => {
    const fx = await ensureFixture();
    for (const arm of ["list", "detail"]) {
      const res = await fetchUi(`/${fx.ownerUsername}/${fx.repoSlug}/issues/999/content-history/${arm}`);
      expect(res.status, arm).toBe(404);
      expect(await res.text(), arm).toContain("status-page-error");
    }
    const junkList = await fetchUi(`/${fx.ownerUsername}/${fx.repoSlug}/issues/${fx.issueIndex}/content-history/list?comment_id=junk`);
    expect(junkList.status).toBe(200);
    expect(await junkList.json()).toEqual({ results: null });
  });

  it("the negative-index posture: the parser claims `-?\\d+` but the mounted `\\d+` registration 404s PLAIN", async () => {
    const fx = await ensureFixture();
    expect(parseUiRoute(`/${fx.ownerUsername}/${fx.repoSlug}/issues/-1/content-history/list`)).toMatchObject({
      family: "issue-content-history-list",
      index: -1,
    });
    expect(handlesUiRoute(`/${fx.ownerUsername}/${fx.repoSlug}/issues/-1/content-history/list`)).toBe(true);
    const res = await fetchUi(`/${fx.ownerUsername}/${fx.repoSlug}/issues/-1/content-history/list`);
    expect(res.status).toBe(404); // the plain Hono 404 — the info/overview precedent
  });
});

// =============================================================================
// Group 3 — the admin trio's gates
// =============================================================================

describe("the admin listing pages' gates (the shared adminPagePrologue)", () => {
  let palId = 0;
  let adminId = 0;

  beforeEach(async () => {
    for (const table of ["email_addresses", "personal_access_tokens", "users"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    const admin = await seedVerifiedUser({ username: "w126-admin", isAdmin: true });
    const pal = await seedVerifiedUser({ username: "w126-pal" });
    adminId = admin.id;
    palId = pal.id;
  });

  it("anonymous 303s onto the login round-trip carrying the exact path", async () => {
    for (const path of ["/-/admin/users", "/-/admin/orgs", "/-/admin/repos"]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(303);
      expect(res.headers.get("location"), path).toBe(`/login?redirect_to=${encodeURIComponent(path)}`);
    }
  });

  it("a signed-in non-admin 404-shells (the hidden-surface NotFound posture)", async () => {
    const cookie = await sessionHeader(palId);
    for (const path of ["/-/admin/users", "/-/admin/orgs", "/-/admin/repos"]) {
      const res = await fetchUi(path, { headers: { cookie } });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toContain("status-page-error");
    }
  });

  it("the admin gets each page with the shared navbar's item marked active (the F7 fold)", async () => {
    const cookie = await sessionHeader(adminId);
    const expectations: [string, string][] = [
      ["/-/admin/users", 'class="active item" href="/-/admin/users"'],
      ["/-/admin/orgs", 'class="active item" href="/-/admin/orgs"'],
      ["/-/admin/repos", 'class="active item" href="/-/admin/repos"'],
    ];
    for (const [path, needle] of expectations) {
      const res = await fetchUi(path, { headers: { cookie } });
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html, path).toContain(needle);
      // The family nav renders exactly once per page (no scaffolding copy).
      expect(html.match(/class="flex-container-nav"/g)?.length, path).toBe(1);
    }
  });

  it("the parse claims carry the three listing families", () => {
    expect(parseUiRoute("/-/admin/users")).toEqual({ family: "admin-users" });
    expect(parseUiRoute("/-/admin/orgs")).toEqual({ family: "admin-orgs" });
    expect(parseUiRoute("/-/admin/repos")).toEqual({ family: "admin-repos" });
    expect(parseUiRoute("/-/admin/users/42")).toBeNull(); // static-before-dynamic: deeper tails unclaimed
    expect(handlesUiRoute("/-/admin/users")).toBe(true);
  });
});

// =============================================================================
// Group 4 — the settings pairs' route arms
// =============================================================================

describe("the settings account + notifications routes (the prologue + per-form error routing)", () => {
  let userId = 0;

  beforeEach(async () => {
    for (const table of ["email_addresses", "user_settings", "personal_access_tokens", "users"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    const user = await seedVerifiedUser({ username: "w126-set" });
    userId = user.id;
  });

  it("anonymous 303s on every GET and POST arm onto the login round-trip", async () => {
    for (const path of ["/user/settings/account", "/user/settings/notifications"]) {
      const res = await fetchUi(path);
      expect(res.status, `GET ${path}`).toBe(303);
      expect(res.headers.get("location"), `GET ${path}`).toBe(`/login?redirect_to=${encodeURIComponent(path)}`);
    }
    for (const path of [
      "/user/settings/account/email",
      "/user/settings/account/email/delete",
      "/user/settings/account/delete",
      "/user/settings/notifications/email",
      "/user/settings/notifications/actions",
    ]) {
      const res = await fetchUi(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "" });
      expect(res.status, `POST ${path}`).toBe(303);
      expect(res.headers.get("location"), `POST ${path}`).toBe(`/login?redirect_to=${encodeURIComponent(path)}`);
    }
  });

  it("the guard fires FIRST on the POSTs: a cross-origin POST 403s even with a valid session", async () => {
    const cookie = await sessionHeader(userId);
    for (const path of ["/user/settings/account/email", "/user/settings/notifications/email"]) {
      const res = await postForm(path, { email: "x@example.com", preference: "enabled" }, cookie, { origin: "https://evil.local" });
      expect(res.status, path).toBe(403);
    }
  });

  it("the account GET renders the shared navbar with Account active exactly once", async () => {
    const cookie = await sessionHeader(userId);
    const res = await fetchUi("/user/settings/account", { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.match(/class="active item" href="\/user\/settings\/account"/g)?.length).toBe(1);
    expect(html.match(/href="\/user\/settings\/account"/g)?.length).toBe(1); // the nav item renders once (no local copy)
    expect(html).toContain("Manage Email Addresses"); // the page's section header
  });

  it("the account email POST: a valid add 303s back; an invalid add re-renders 200 with the carried email", async () => {
    const cookie = await sessionHeader(userId);
    const added = await postForm("/user/settings/account/email", { email: "second@example.com" }, cookie);
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe("/user/settings/account");
    const rows = await drizzle(env.DB).select().from(emailAddresses).where(eq(emailAddresses.userId, userId)).all();
    expect(rows.map((row) => row.email)).toContain("second@example.com");

    const invalid = await postForm("/user/settings/account/email", { email: "not-an-email" }, cookie);
    expect(invalid.status).toBe(200); // the re-render, never a 303
    const html = await invalid.text();
    expect(html).toContain('value="not-an-email"'); // the carried form email
    const stillThere = await drizzle(env.DB).select().from(emailAddresses).where(eq(emailAddresses.userId, userId)).all();
    expect(stillThere.length).toBe(1); // nothing written
  });

  it("the account email DELETE is the idempotent silent-303 for both outcomes", async () => {
    const cookie = await sessionHeader(userId);
    const gone = await postForm("/user/settings/account/email/delete", { id: "424242" }, cookie);
    expect(gone.status).toBe(303);
    expect(gone.headers.get("location")).toBe("/user/settings/account");
    const junk = await postForm("/user/settings/account/email/delete", { id: "junk" }, cookie);
    expect(junk.status).toBe(303); // FormInt64 null → "missing" → the same 303
  });

  it("the notifications POSTs: saved 303s onto the tab; the invalid preference re-renders 200 with the PER-FORM error routing", async () => {
    const cookie = await sessionHeader(userId);
    const saved = await postForm("/user/settings/notifications/email", { preference: "onmention" }, cookie);
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/user/settings/notifications");

    // A valid EMAIL catalog value is invalid for ACTIONS (disjoint catalogs)
    // — the message renders inside the ACTIONS form (after its action attr),
    // not the email form's.
    const invalidActions = await postForm("/user/settings/notifications/actions", { preference: "enabled" }, cookie);
    expect(invalidActions.status).toBe(200);
    const actionsHtml = await invalidActions.text();
    const actionsMessage = userSettingsNotificationsLocale.invalid_data.replace("%v", "enabled");
    expect(actionsHtml).toContain(actionsMessage);
    expect(actionsHtml.indexOf(actionsMessage)).toBeGreaterThan(
      actionsHtml.indexOf('action="/user/settings/notifications/actions"'),
    );

    // The email arm's invalid likewise renders inside the EMAIL form
    // (before the actions form's marker).
    const invalidEmail = await postForm("/user/settings/notifications/email", { preference: "bogus" }, cookie);
    expect(invalidEmail.status).toBe(200);
    const emailHtml = await invalidEmail.text();
    const emailMessage = userSettingsNotificationsLocale.invalid_data.replace("%v", "bogus");
    expect(emailHtml).toContain(emailMessage);
    expect(emailHtml.indexOf(emailMessage)).toBeLessThan(emailHtml.indexOf('action="/user/settings/notifications/actions"'));
  });

  it("the notifications GET renders the shared navbar with Notifications active exactly once (the nav swap)", async () => {
    const cookie = await sessionHeader(userId);
    const res = await fetchUi("/user/settings/notifications", { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.match(/class="active item" href="\/user\/settings\/notifications"/g)?.length).toBe(1);
    expect(html.match(/href="\/user\/settings\/notifications"/g)?.length).toBe(1); // once — the scaffolding copy is DELETED
    expect(html).toContain(userSettingsNotificationsLocale.submit); // the form's button
  });
});

// =============================================================================
// Group 5 — the wiki-raw parse claims (the bare-tail 303 + the byte-arm
// route pins live in the wiki matrix's mounted reads; this pins the parse/
// registration pair)
// =============================================================================

describe("the wiki-raw claim pins", () => {
  it("the raw tail claims its family with the decoded join; the bare tail stays with the page family", () => {
    expect(parseUiRoute("/o/r/wiki/raw/deep/name.md")).toMatchObject({ family: "wiki-raw", rawTail: "deep/name.md" });
    expect(parseUiRoute("/o/r/wiki/raw")).toMatchObject({ family: "wiki" }); // chi's wildcard-miss
    expect(parseUiRoute("/o/r/wiki/raw/bad%2")).toBeNull(); // the bad-escape engine 404
    expect(handlesUiRoute("/o/r/wiki/raw/Home.md")).toBe(true);
  });
});
