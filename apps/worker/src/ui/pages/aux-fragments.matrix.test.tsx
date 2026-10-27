/**
 * The window-2e B2 aux/fragment surfaces' DEFERRED route-level matrix —
 * the mounted route arms for the three families whose module suites own the
 * unit coverage (the coverage split this file completes):
 *
 *   - pages/issues-search-aux.test.ts drives the search/suggestions
 *     loaders + Response builders DIRECTLY on real D1 (the module is
 *     index-owned) — it owns the full param grammar (the tri-states, the
 *     milestone name/id resolution, the user-filter 404s, the project
 *     void postures, the RFC3339 windows, the clamped paging) and the
 *     two-pass GetSuggestion semantics down to the zero-marshalled
 *     envelope;
 *   - pages/issue-content-fragments.smoke.test.ts drives the info/
 *     attachments/content-history-overview loaders + builders directly —
 *     it owns the converted-issue envelope, the three RenderLabel arms,
 *     the comment_id = 0 attachment predicate and the counter-based
 *     editedHistoryCountMap;
 *   - pages/activity-author-data.smoke.test.ts drives the aggregation
 *     loader directly over a pushed engine repo — it owns the all-branch
 *     dedup, the mapped/ghost entries and the five-field marshal order.
 *
 * THIS FILE adds what only the MOUNTED ROUTE can prove, on the minted-
 * session pattern (issues-list.matrix is the harness reference):
 *
 *   - the gates through resolveUiRequest + the handlers: the search feed's
 *     reqSignIn (anonymous on a VISIBLE repo 303s onto the login round-
 *     trip carrying the exact path, while an INVISIBLE private repo 404-
 *     shells BEFORE the sign-in arm — repo resolution first, sessions buy
 *     no visibility for the signed-in non-owner, the owner passes), the
 *     optSignIn families (suggestions, the fragments, the alias) serving
 *     anonymous viewers on a public repo and 404-shelling on a private
 *     one;
 *   - the search feed's param grammar riding the real request URL: the
 *     422 PLAIN-TEXT arm (the Go time-parse message + trailing newline,
 *     text/plain; charset=utf-8), the state/type pass-through, the
 *     created_by=ghost 404 carrying the REAL rendered not-found shell
 *     (the route hands renderNotFound(ctx) into the builder — the module
 *     could only pin a hand-made string), and the full 200 header set;
 *   - the suggestions feed's route pass: the raw q rides UNTRIMMED
 *     (`?q=%202` — a leading space kills the index prepend AND the
 *     keyword pass, upstream FormValue) and the numeric-index prepend
 *     fires through the query string;
 *   - the fragments' 404 family through the routes: the unknown index on
 *     all three (info's module outcome, attachments'/overview's
 *     resolveFragmentIssue miss — each rendering the real shell), the
 *     shared-index NO-cross-check pins (a plain issue answers under
 *     /pulls/ and a PR under /issues/, upstream's own FIXME), the
 *     unclaimed content-history list/detail tails (plain Hono 404 — no
 *     snapshot store, the documented unrendered arm) and the
 *     attachments-alias 302 (exact Location; UNCONDITIONAL — junk uuid
 *     and unknown index still hand off, the alias never resolves the
 *     issue);
 *   - the claim pins, two layers (the wiki matrix's discipline):
 *     parseUiRoute's families (activity's optional period tail with its
 *     unclaimed deeper tail, the search/suggestions literals under the
 *     issues head only, the fragment tails' families vs the unclaimed
 *     list/detail), and the registration layer refusing what the parser
 *     admits (`/issues/-1/info` — the parser's `-?\d+` claims it, the
 *     mounted `\d+` pattern 404s it plain, status-parity with upstream's
 *     int64 miss);
 *   - activity_author_data through the mounted route over a pushed engine
 *     repo (the smoke's fixture discipline, distinct slugs): anonymous OK
 *     (no sign-in gate at all), the bare route + the UNKNOWN period
 *     segment both answering the weekly default 200 (no 4xx arm —
 *     upstream parity), daily filtering, the MustBeNotEmpty empty-repo
 *     404 shell, and the ctx.JSON content-type + zero-option Cache-
 *     Control pair served.
 *
 * Rerun posture: the D1-only group wipes its tables per test and re-seeds
 * lazily (the module smokes' discipline); the activity group's engine
 * fixture is idempotent (ensureSeededRepo verifies refs before pushing)
 * and re-stamps its D1 row, so reruns converge. No test deletes a seeded
 * row.
 *
 * ## DISCLOSED RED (a real mount bug this matrix exposes — the wiki-matrix
 * class): the eight `/issues/search` + `/issues/suggestions` route arms
 * assert upstream parity and fail until the orchestrator's registration
 * fix lands. `uiRouter.get("/:owner/:repo/issues/:index", uiPage)`
 * (index.ts:9621 — the wave-2 catch, `:index` UNCONSTRAINED) is registered
 * BEFORE the window-2e B2 statics `/:owner/:repo/issues/search` and
 * `/issues/suggestions` (index.ts:9684-9685), and this Hono pin's
 * RegExpRouter gives the earlier registration precedence (the wave-9
 * static-before-dynamic note verbatim: "a static registered after the
 * dynamic pair LOSES to it"). "/issues/search" therefore lands in uiPage
 * as `index="search"`; parseUiRoute claims family issues-search-aux, but
 * uiPage dispatches only the slice-1 families (`isSliceOneRoute`) and
 * answers the plain Hono 404 — both feed routes are UNREACHABLE dead
 * registrations (handlesUiRoute says true, so production dispatches into
 * the ui sub-app and 404s there; upstream's /issues/search is the new-
 * issue dependency search — Gitea serves it 200/422/404). Fix shape: hoist
 * the two statics above the `:index` catch (the wave-9 precedent — the
 * /issues/new + /issues/labels statics already sit before it). The arms
 * stay parity-asserting (the wiki matrix's "green since a58cad5"
 * discipline): they flip green with the reorder and pin the shadowing
 * forever after.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { issueAttachments, issueLabels, labels, repositories, users } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { changeIssueBody, updateCommentBody } from "../../api/services/issues";
import type { UiManifest } from "../manifest";
import { parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { RepoRow } from "../ui-context";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";

// --- the minted-session route harness (the issues-list matrix pattern) ---------

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

/** A minted session cookie header for the user (the real mintSession path,
 *  minted per request — the beforeEach users wipe cascades the sessions
 *  table, so a cross-test cookie would go stale). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

// --- the D1-only fixture (wiped per test, re-seeded lazily) ---------------------

const T0 = 1_760_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);
const ORIGIN = "https://test.local";

interface AuxFixture {
  alice: { id: number; username: string };
  bob: { id: number; username: string };
  gadget: RepoRow; // public, alice's — the fragments + anonymous arms
  vault: RepoRow; // private, alice's — the visibility-gate arms
  /** gadget's issue #1 — the fragments' target (labeled, edited body). */
  issueOneIndex: number;
  editedCommentId: number;
  /** gadget's PR #4 — the type=pulls + shared-index arms. */
  pullIndex: number;
}

let aux: AuxFixture | undefined;

async function ensureAuxFixture(): Promise<AuxFixture> {
  if (aux !== undefined) return aux;
  const alice = await seedVerifiedUser({ username: "aux-alice" });
  const bob = await seedVerifiedUser({ username: "aux-bob" });
  const service = new RepoService(env.DB);
  const gadget = await service.create({
    owner: { id: alice.id, usernameLower: "aux-alice" },
    name: "gadget",
    isPrivate: false,
    status: "ready",
  });
  const vault = await service.create({
    owner: { id: alice.id, usernameLower: "aux-alice" },
    name: "vault",
    isPrivate: true,
    status: "ready",
  });

  const svc = new IssuesService(env.DB);
  // gadget's threads: two open issues, one closed issue, one open PR —
  // titles carry no digits (the numeric-suggestion arms stay index-only).
  await svc.createIssue({ repoId: gadget.id, title: "alpha bug", content: "needle in body", posterId: alice.id, now: at(10) });
  await svc.createIssue({ repoId: gadget.id, title: "beta feature", posterId: bob.id, now: at(20) });
  const closed = await svc.createIssue({ repoId: gadget.id, title: "delta closed", posterId: alice.id, now: at(30) });
  await svc.closeIssue(closed.id, { now: at(35) });
  const pull = await svc.createPullRequest({
    repoId: gadget.id,
    title: "WIP: epsilon pull",
    posterId: alice.id,
    headRepoId: gadget.id,
    baseBranch: "main",
    headBranch: "feat",
    now: at(40),
  });
  const issueOne = await svc.createIssue({ repoId: gadget.id, title: "fragment target", posterId: alice.id, now: at(50) });

  // Labels: one on the fragment target (the issues-kind base link arm) and
  // one on the PR (the ROW-decides-base-link arm — a PR's rendered labels
  // anchor the /pulls filter even when fetched under /issues/).
  const insertedLabels = await drizzle(env.DB)
    .insert(labels)
    .values([
      { repoId: gadget.id, name: "bug", color: "#00aabb", description: "regular arm" },
      { repoId: gadget.id, name: "review", color: "#ee0701", description: "the pull's label" },
    ])
    .returning();
  await drizzle(env.DB).insert(issueLabels).values([
    { issueId: issueOne.id, labelId: insertedLabels[0]!.id },
    { issueId: pull.issue.id, labelId: insertedLabels[1]!.id },
  ]);
  const edited = await svc.addComment({ issueId: issueOne.id, posterId: alice.id, content: "v0" });
  await updateCommentBody(env.DB, edited.id, "v1", at(55));
  await svc.addComment({ issueId: issueOne.id, posterId: alice.id, content: "never edited" });
  await changeIssueBody(env.DB, issueOne, "the edited body", 0, at(56));
  await drizzle(env.DB).insert(issueAttachments).values([
    { uuid: "aaaaaaaa-bbbb-cccc-dddd-000000000001", issueId: issueOne.id, uploaderId: alice.id, name: "spec.pdf", size: 2048, downloadCount: 7, createdAt: at(60) },
    { uuid: "aaaaaaaa-bbbb-cccc-dddd-000000000002", issueId: issueOne.id, uploaderId: alice.id, name: "log.txt", size: 16, createdAt: at(61) },
    { uuid: "aaaaaaaa-bbbb-cccc-dddd-000000000003", issueId: issueOne.id, commentId: edited.id, uploaderId: alice.id, name: "comment-shot.png", size: 512, createdAt: at(62) },
  ]);

  // vault's single private thread (the visibility arms' existence proof).
  await svc.createIssue({ repoId: vault.id, title: "vault secret thread", posterId: alice.id, now: at(70) });

  aux = { alice, bob, gadget, vault, issueOneIndex: issueOne.index, editedCommentId: edited.id, pullIndex: pull.issue.index };
  return aux;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

// =============================================================================
// Group 1 — the D1-only families (feeds + fragments), wiped per test
// =============================================================================

describe("the aux feeds + fragments through the mounted route (D1 fixture)", () => {
  beforeEach(async () => {
    // FK order: join/write rows first, then issues, then the per-repo
    // counter (repo_counters → repositories is the one NON-cascade FK),
    // then repositories/personal_access_tokens before users (sessions
    // cascade from users).
    for (const table of [
      "issue_attachments",
      "issue_labels",
      "issue_pins",
      "issue_subscriptions",
      "labels",
      "milestones",
      "comments",
      "pull_requests",
      "issues",
      "repo_counters",
      "repo_settings",
      "repo_units",
      "repo_redirects",
      "repositories",
      "personal_access_tokens",
      "users",
    ]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    aux = undefined;
  });

  // --- the issues/search feed: reqSignIn + the invisible-repo precedence -----

  describe("issues/search — the reqSignIn gate and the visibility precedence", () => {
    it("anonymous on a VISIBLE repo 303s onto the login round-trip carrying the exact path", async () => {
      await ensureAuxFixture();
      const res = await fetchUi("/aux-alice/gadget/issues/search");
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        `/login?redirect_to=${encodeURIComponent("/aux-alice/gadget/issues/search")}`,
      );
    });

    it("anonymous on an INVISIBLE private repo 404-shells BEFORE the sign-in arm (repo resolution first)", async () => {
      await ensureAuxFixture();
      const res = await fetchUi("/aux-alice/vault/issues/search");
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('<div class="status-page-error">');
      expect(html).not.toContain("vault secret thread");
    });

    it("a signed-in NON-owner still 404-shells on the private repo's feed (sessions buy no visibility)", async () => {
      const fixture = await ensureAuxFixture();
      const res = await fetchUi("/aux-alice/vault/issues/search", {
        headers: { cookie: await sessionHeader(fixture.bob.id) },
      });
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('<div class="status-page-error">');
    });

    it("the signed-in OWNER passes both gates: the private feed answers 200 with the full header set", async () => {
      const fixture = await ensureAuxFixture();
      const res = await fetchUi("/aux-alice/vault/issues/search?state=all", {
        headers: { cookie: await sessionHeader(fixture.alice.id) },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
      expect(res.headers.get("x-total-count")).toBe("1");
      expect(res.headers.get("access-control-expose-headers")).toBe("X-Total-Count");
      expect(res.headers.get("link")).toBeNull(); // web Base never sends a Link header
      const body = await res.json<Array<{ number: number; title: string }>>();
      expect(body).toHaveLength(1);
      expect(body[0]?.number).toBe(1);
      expect(body[0]?.title).toBe("vault secret thread");
    });
  });

  // --- the issues/search feed: the param grammar through the real URL --------

  describe("issues/search — the param grammar through the route", () => {
    it("the 422 PLAIN-TEXT arm: the Go time-parse message + trailing newline (the loader→builder wiring)", async () => {
      const fixture = await ensureAuxFixture();
      const res = await fetchUi("/aux-alice/gadget/issues/search?since=nope", {
        headers: { cookie: await sessionHeader(fixture.alice.id) },
      });
      expect(res.status).toBe(422);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await res.text()).toBe(
        'parsing time "nope" as "2006-01-02T15:04:05Z07:00": cannot parse "nope" as "2006"\n',
      );
    });

    it("state/type ride the query string: ?state=closed → the closed thread, ?type=pulls → the PR", async () => {
      const fixture = await ensureAuxFixture();
      const drive = async (query: string): Promise<number[]> => {
        const res = await fetchUi(`/aux-alice/gadget/issues/search${query}`, {
          headers: { cookie: await sessionHeader(fixture.alice.id) },
        });
        expect(res.status, query).toBe(200);
        const body = await res.json<Array<{ number: number }>>();
        return body.map((issue) => issue.number);
      };
      expect(await drive("?state=closed")).toEqual([3]);
      expect(await drive("?type=pulls")).toEqual([fixture.pullIndex]);
      // FIVE threads in the fixture (alpha/beta/delta-closed/pull/fragment-
      // target) — the dead predecessor's blind counts assumed four (never
      // seen passing under the registration shadow).
      expect(await drive("?state=all")).toEqual([5, 4, 3, 2, 1]);
      expect(await drive("")).toEqual([5, 4, 2, 1]); // open-only incl. the OPEN pull, created-desc
    });

    it("created_by=ghost 404s with the REAL rendered not-found shell (renderNotFound rides the builder)", async () => {
      const fixture = await ensureAuxFixture();
      const res = await fetchUi("/aux-alice/gadget/issues/search?created_by=ghost", {
        headers: { cookie: await sessionHeader(fixture.alice.id) },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect(html).toContain('<div class="status-page-error">');
      expect(html).toContain("404 Not Found");
    });
  });

  // --- the issues/suggestions feed: optSignIn + the raw q --------------------

  describe("issues/suggestions — optSignIn and the raw-q pass through the route", () => {
    it("anonymous on a public repo answers 200 (optSignIn — no redirect), the zero-marshalled envelope served", async () => {
      await ensureAuxFixture();
      const fixture = await ensureAuxFixture();
      const res = await fetchUi("/aux-alice/gadget/issues/suggestions");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
      expect(res.headers.get("x-total-count")).toBeNull(); // IssueSuggestions never sets one
      const body = await res.json<Array<{ number: number; user: null; pull_request: unknown }>>();
      expect(body.map((item) => item.number)).toEqual([5, 4, 3, 2, 1]); // latest-updated, issues AND pulls (five threads — the blind-count fix)
      expect(body[0]?.user).toBeNull();
      // The PR meta rides ITS row (the newest thread is an issue now that
      // the fifth row exists — the blind-count fix's companion).
      const pullRow = body.find((item) => item.number === fixture.pullIndex);
      expect(pullRow?.pull_request).toEqual({ merged: false, merged_at: null, draft: true, html_url: "" });
    });

    it("anonymous on a private repo 404-shells (the visibility grant fronts the feed)", async () => {
      await ensureAuxFixture();
      const res = await fetchUi("/aux-alice/vault/issues/suggestions");
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('<div class="status-page-error">');
    });

    it("?q=2 prepends the exact-index hit through the query string", async () => {
      await ensureAuxFixture();
      const res = await fetchUi("/aux-alice/gadget/issues/suggestions?q=2");
      expect(res.status).toBe(200);
      const body = await res.json<Array<{ number: number }>>();
      expect(body.map((item) => item.number)).toEqual([2]); // no digit-titled threads → index-only hit
    });

    it("?q=%202 rides UNTRIMMED: the leading space kills the index arm AND the keyword pass (upstream FormValue)", async () => {
      await ensureAuxFixture();
      const res = await fetchUi("/aux-alice/gadget/issues/suggestions?q=%202");
      expect(res.status).toBe(200);
      const body = await res.json<Array<{ number: number }>>();
      expect(body).toEqual([]); // " 2" is not ParseInt-able and no title LIKEs "% 2%"
    });
  });

  // --- the fragments: info / attachments / content-history-overview ----------

  describe("the issue fragments through the route — 404 family, shared index, alias", () => {
    it("info answers under BOTH url kinds with the SAME row (the shared-index no-cross-check — upstream's FIXME)", async () => {
      const fixture = await ensureAuxFixture();
      for (const kind of ["issues", "pulls"]) {
        const res = await fetchUi(`/aux-alice/gadget/${kind}/${fixture.issueOneIndex}/info`);
        expect(res.status, kind).toBe(200);
        expect(res.headers.get("content-type"), kind).toBe("application/json;charset=utf-8");
        const payload = await res.json<{ convertedIssue: { number: number; title: string }; renderedLabels: string }>();
        expect(payload.convertedIssue.number).toBe(fixture.issueOneIndex);
        expect(payload.convertedIssue.title).toBe("fragment target");
        expect(payload.renderedLabels).toContain('<span class="labels-list">');
        expect(payload.renderedLabels).toContain(`href="/aux-alice/gadget/issues?labels=`);
      }
      // …and a PR index under the ISSUES kind (the cross-check's other half).
      const prUnderIssues = await fetchUi(`/aux-alice/gadget/issues/${fixture.pullIndex}/info`);
      expect(prUnderIssues.status).toBe(200);
      const prPayload = await prUnderIssues.json<{ convertedIssue: { number: number }; renderedLabels: string }>();
      expect(prPayload.convertedIssue.number).toBe(fixture.pullIndex);
      expect(prPayload.renderedLabels).toContain(`href="/aux-alice/gadget/pulls?labels=`); // the ROW decides the base link
    });

    it("info's unknown index renders the real 404 shell (the module outcome rides the mount)", async () => {
      await ensureAuxFixture();
      const res = await fetchUi("/aux-alice/gadget/issues/999/info");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await res.text()).toContain('<div class="status-page-error">');
    });

    it("attachments lists the DIRECT rows with the absolute browser_download_url; the comment-tied row stays out", async () => {
      const fixture = await ensureAuxFixture();
      const res = await fetchUi(`/aux-alice/gadget/issues/${fixture.issueOneIndex}/attachments`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
      const body = await res.json<Array<{ name: string; uuid: string; browser_download_url: string; download_count: number }>>();
      expect(body.map((row) => row.name)).toEqual(["spec.pdf", "log.txt"]); // comment_id > 0 excluded
      expect(body[0]?.browser_download_url).toBe(`${ORIGIN}/attachments/aaaaaaaa-bbbb-cccc-dddd-000000000001`);
      expect(body[0]?.download_count).toBe(7);
    });

    it("attachments' unknown index 404s through resolveFragmentIssue (the handler-side shell)", async () => {
      await ensureAuxFixture();
      const res = await fetchUi("/aux-alice/gadget/pulls/999/attachments");
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('<div class="status-page-error">');
    });

    it("content-history/overview serves the counter map under the pulls kind too (no cross-check); unknown index 404s", async () => {
      const fixture = await ensureAuxFixture();
      const res = await fetchUi(`/aux-alice/gadget/pulls/${fixture.issueOneIndex}/content-history/overview`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
      const payload = await res.json<{ i18n: Record<string, string>; editedHistoryCountMap: Record<string, number> }>();
      expect(payload.i18n).toEqual({
        textEdited: "edited",
        textDeleteFromHistory: "Delete from history",
        textDeleteFromHistoryConfirm: "Delete from history?",
        textOptions: "Options",
      });
      expect(Object.keys(payload.editedHistoryCountMap).sort((a, b) => Number(a) - Number(b))).toEqual([
        "0",
        String(fixture.editedCommentId),
      ]);
      expect(payload.editedHistoryCountMap["0"]).toBe(2); // 1 created + 1 edit

      const missing = await fetchUi("/aux-alice/gadget/issues/999/content-history/overview");
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain('<div class="status-page-error">');
    });

    it("the content-history list/detail tails stay UNCLAIMED — plain Hono 404, the documented unrendered arm", async () => {
      await ensureAuxFixture();
      for (const tail of ["list", "detail"]) {
        const res = await fetchUi(`/aux-alice/gadget/issues/1/content-history/${tail}`);
        expect(res.status, tail).toBe(404);
        expect(await res.text(), tail).toContain("404 Not Found"); // plain — never the rendered shell
      }
    });

    it("the read grant fronts EVERY fragment family: anonymous on a private repo 404-shells before any family logic", async () => {
      await ensureAuxFixture();
      // resolveUiRequest's visibility grant precedes the drift guard and the
      // loader — including the alias, whose 302 hand-off is unconditional
      // only AFTER the grant passes (public: junk rides; private: shell).
      for (const path of [
        "/aux-alice/vault/issues/1/info",
        "/aux-alice/vault/issues/1/attachments",
        "/aux-alice/vault/issues/1/content-history/overview",
        "/aux-alice/vault/issues/1/attachments/aaaaaaaa-bbbb-cccc-dddd-000000000001",
      ]) {
        const res = await fetchUi(path);
        expect(res.status, path).toBe(404);
        expect(await res.text(), path).toContain('<div class="status-page-error">');
      }
    });

    it("the attachments-alias 302s onto the site-level seam — UNCONDITIONALLY (junk uuid, unknown index, either kind)", async () => {
      await ensureAuxFixture();
      const real = await fetchUi("/aux-alice/gadget/issues/1/attachments/aaaaaaaa-bbbb-cccc-dddd-000000000001");
      expect(real.status).toBe(302);
      expect(real.headers.get("location")).toBe("/attachments/aaaaaaaa-bbbb-cccc-dddd-000000000001");

      // The alias never resolves the issue or the uuid — pure hand-off.
      const junk = await fetchUi("/aux-alice/gadget/pulls/999/attachments/junk-uuid-segment");
      expect(junk.status).toBe(302);
      expect(junk.headers.get("location")).toBe("/attachments/junk-uuid-segment");
    });
  });

  // --- the claim pins, two layers (the wiki matrix's discipline) --------------

  describe("claim pins — the parser's families and the registration's refusals", () => {
    it("parseUiRoute claims the aux families at their exact shapes", async () => {
      await ensureAuxFixture();
      expect(parseUiRoute("/o/r/issues/search")).toMatchObject({ family: "issues-search-aux", owner: "o", repo: "r" });
      expect(parseUiRoute("/o/r/issues/suggestions")).toMatchObject({ family: "issues-suggestions-aux" });
      // The literals hang off the ISSUES head only — /pulls/search is upstream's
      // pattern miss (unclaimed → the engine's 404).
      expect(parseUiRoute("/o/r/pulls/search")).toBeNull();
      expect(parseUiRoute("/o/r/issues/7/info")).toMatchObject({ family: "issue-info", urlKind: "issues", index: 7 });
      expect(parseUiRoute("/o/r/pulls/7/info")).toMatchObject({ family: "issue-info", urlKind: "pulls", index: 7 });
      expect(parseUiRoute("/o/r/issues/7/attachments/abc")).toMatchObject({
        family: "issue-attachments-alias",
        segment: "abc",
      });
      expect(parseUiRoute("/o/r/issues/7/content-history/overview")).toMatchObject({ family: "issue-content-overview" });
      // No snapshot store: the list/detail tails parse to NOTHING (unclaimed).
      expect(parseUiRoute("/o/r/issues/7/content-history/list")).toBeNull();
      expect(parseUiRoute("/o/r/issues/7/content-history/detail")).toBeNull();
    });

    it("parseUiRoute claims activity_author_data's optional period tail and nothing deeper", async () => {
      await ensureAuxFixture();
      expect(parseUiRoute("/o/r/activity_author_data")).toMatchObject({ family: "activity-author-data", owner: "o", repo: "r" });
      const withPeriod = parseUiRoute("/o/r/activity_author_data/daily");
      expect(withPeriod).toMatchObject({ family: "activity-author-data", owner: "o", repo: "r" });
      expect(withPeriod !== null && "segment" in withPeriod ? withPeriod.segment : undefined).toBe("daily");
      expect(parseUiRoute("/o/r/activity_author_data/daily/extra")).toBeNull(); // deeper tail unclaimed
    });

    it("the registration layer refuses what the parser admits: /issues/-1/info 404s PLAIN (status parity with the int64 miss)", async () => {
      await ensureAuxFixture();
      expect(parseUiRoute("/o/r/issues/-1/info")).not.toBeNull(); // the parser's -?\d+ claims it…
      const res = await fetchUi("/aux-alice/gadget/issues/-1/info"); // …the mounted \d+ pattern does not
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('<div class="status-page-error">'); // plain Hono 404, not the shell
    });

    it("the shadowing positive control: /issues/new (a static BEFORE the :index catch) reaches its handler", async () => {
      await ensureAuxFixture();
      // issueNewPage's anonymous arm 303s onto the login round-trip — proof
      // the catch's precedence is registration ORDER, not a broken pattern:
      // only the AFTER-registered B2 statics (search/suggestions) are dead.
      const res = await fetchUi("/aux-alice/gadget/issues/new");
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("/login?redirect_to=");
    });
  });
});

// =============================================================================
// Group 2 — activity_author_data through the mounted route (engine fixture)
// =============================================================================

const DAY_MS = 24 * 3_600_000;

/** Commit times ride REAL now — the mounted route calls the loader with the
 *  wall clock (no options.now), so the windows must sit relative to it (the
 *  smoke controls the clock directly; the route cannot). Evaluated per
 *  ensure call so a re-push after storage isolation lands in the same
 *  windows. */
function aamxCommits(): SeedCommit[] {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return [
    {
      // OUTSIDE even the weekly window — never counted.
      message: "aamx matrix: old root commit",
      time: nowSeconds - 30 * (DAY_MS / 1000),
      files: [{ path: "README.md", content: "aamx root\n" }],
      author: { name: "Alice Matrix", email: "aamx-owner@example.com" },
    },
    {
      // In weekly, outside daily — the ghost author's arm.
      message: "aamx matrix: shared commit",
      time: nowSeconds - 2 * (DAY_MS / 1000),
      files: [{ path: "README.md", content: "aamx root\nshared\n" }],
      author: { name: "Bob Rove", email: "bob@nowhere.example" },
    },
    {
      // In both windows — the mapped owner's arm.
      message: "aamx matrix: tip commit",
      time: nowSeconds - 3_600,
      files: [{ path: "README.md", content: "aamx root\nshared\ntip\n" }],
      author: { name: "Alice Matrix", email: "aamx-owner@example.com" },
    },
  ];
}

let aamxMigrationsApplied = false;

/** Idempotent engine fixture (the activity smoke's discipline, distinct
 *  slugs): the pushed public `aamx/aadata-matrix` with the owner's email
 *  mapped. Every call re-verifies the engine refs and re-stamps the D1 row
 *  — per-test storage isolation or an earlier group's wipe converge back
 *  onto the same fixture (the re-created row defaults isEmpty=true). */
async function ensureAamxFixture(): Promise<void> {
  if (!aamxMigrationsApplied) {
    await applyAuthD1Migrations();
    aamxMigrationsApplied = true;
  }
  await ensureSeededRepo({ owner: "aamx", slug: "aadata-matrix", commits: aamxCommits() });
  const db = drizzle(env.DB);
  await db.update(users).set({ email: "aamx-owner@example.com" }).where(eq(users.usernameLower, "aamx")).run();
  const row = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.ownerNamespace, "aamx"))
    .get();
  if (row === undefined) throw new Error("aamx fixture repo row missing");
  await db.update(repositories).set({ status: "ready", isEmpty: false, visibility: "public" }).where(eq(repositories.id, row.id)).run();
}

describe("activity_author_data through the mounted route (engine fixture)", () => {
  beforeAll(async () => {
    await ensureAamxFixture();
  });

  it("the bare route answers anonymous (no sign-in gate) with the ctx.JSON header pair and the mapped/ghost entries", async () => {
    await ensureAamxFixture();
    const res = await fetchUi("/aamx/aadata-matrix/activity_author_data");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    const body = await res.json<Array<{ name: string; login: string; avatar_link: string; home_link: string; commits: number }>>();
    expect(body).toHaveLength(2); // the 30-day-old root is outside the weekly window
    const alice = body.find((entry) => entry.login === "aamx");
    expect(alice).toMatchObject({ name: "aamx", login: "aamx", home_link: "/aamx", commits: 1 });
    expect(alice?.avatar_link).toMatch(/^https:\/\/test\.local\/avatars\/[0-9a-f]{64}$/);
    expect(body.find((entry) => entry.login === "")).toEqual({
      name: "Bob Rove",
      login: "",
      avatar_link: `${ORIGIN}/assets/img/avatar_default.png`,
      home_link: "",
      commits: 1,
    });
  });

  it("an UNKNOWN period segment rides the weekly default 200 — no 4xx arm (upstream parity)", async () => {
    await ensureAamxFixture();
    const bare = await fetchUi("/aamx/aadata-matrix/activity_author_data");
    const fortnightly = await fetchUi("/aamx/aadata-matrix/activity_author_data/fortnightly");
    expect(fortnightly.status).toBe(200);
    expect(await fortnightly.json()).toEqual(await bare.json()); // identical windows
  });

  it("the daily segment filters to the 1-hour window", async () => {
    await ensureAamxFixture();
    const res = await fetchUi("/aamx/aadata-matrix/activity_author_data/daily");
    expect(res.status).toBe(200);
    const body = await res.json<Array<{ login: string; commits: number }>>();
    expect(body).toHaveLength(1);
    expect(body[0]?.login).toBe("aamx"); // bob's 2-day-old commit is out
  });

  it("an EMPTY repo 404-shells (MustBeNotEmpty — the route re-renders the shell on the loader's null)", async () => {
    const owner = await seedVerifiedUser({ username: "aamx-empty" });
    await new RepoService(env.DB).create({
      owner: { id: owner.id, usernameLower: "aamx-empty" },
      name: "hollow",
      isPrivate: false,
      status: "ready",
    });
    const res = await fetchUi("/aamx-empty/hollow/activity_author_data");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div class="status-page-error">');
  });

  it("a deeper tail stays unclaimed — plain Hono 404 (the period pattern claims exactly one segment)", async () => {
    await ensureAamxFixture();
    const res = await fetchUi("/aamx/aadata-matrix/activity_author_data/weekly/extra");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("404 Not Found"); // plain — never the rendered shell
  });
});
