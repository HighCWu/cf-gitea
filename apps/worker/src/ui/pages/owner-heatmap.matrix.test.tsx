/**
 * The owner HEATMAP web JSON route's matrix (pages/owner-heatmap.ts over
 * index.ts's ownerHeatmapData handler — the census's R03 brief): the
 * mounted-route arms through `uiRouter.fetch()` (the explore92 pattern), in
 * the file's private `hm` fixture world:
 *
 *   - the claim pins: the exact 4-segment `/-/heatmap` tail parses, the
 *     deeper/bare tails stay unclaimed (the `-` namespace's disjoint
 *     literals — the ae32b1a rule the census's Open Issues #8 cites);
 *   - the web PAIR shape: `[[unixTs, count]...]` + `totalContributions` —
 *     NOT the API's `[{timestamp, contributions}]` objects (heatmap.go:22-30
 *     vs routers/api/v1/user/user.go:138-161), with the 900-second bucket
 *     arithmetic pinned on a seeded pair (two rows in one bucket → one pair
 *     of count 2) and the out-of-window row excluded;
 *   - the `IsUserVisibleToViewer` gate (heatmap.go:38-44): a private
 *     subject 404-shells anonymous and 200s for themself and a site admin;
 *     a public subject answers anonymous;
 *   - a renamed user 307s (the profile seam's redirect arm); an org name
 *     404s (the R06 boundary — the org-arm aggregation is not this wave's);
 *   - the widget slot: the activity tab renders `#user-heatmap.is-loading`
 *     with `data-heatmap-url="/{username}/-/heatmap"` + the four locale
 *     attributes — the official bundle's initHeatmap contract
 *     (web_src/js/features/heatmap.ts).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { comments, issues, repositories, users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { uiEnv } from "../__tests__/harness";

// --- fixtures -----------------------------------------------------------------

const NOW = Math.floor(Date.now() / 1000);
/** Two rows inside one 900-second bucket, one row outside the window. */
const BUCKET_START = Math.floor((NOW - 86_400 * 5) / 900) * 900;
const OUT_OF_WINDOW = NOW - (366 + 7) * 86_400 - 86_400; // beyond the 373-day window

interface Fixture {
  subjectId: number;
  privateSubjectId: number;
  adminCookie: number; // marker — the cookie is minted per use below
  repoId: string;
}

let fixture: Fixture | null = null;

async function ensureUser(username: string, visibility: "public" | "private", isAdmin = false): Promise<number> {
  const db = drizzle(env.DB);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, username)).get();
  if (existing !== undefined) return existing.id;
  const seeded = await db
    .insert(users)
    .values({ username, usernameLower: username, isAdmin, status: "active", visibility, createdAt: new Date() })
    .returning({ id: users.id });
  return (seeded[0] as { id: number }).id;
}

async function ensureFixtures(): Promise<Fixture> {
  if (fixture !== null) return fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const subjectId = await ensureUser("hm-subject", "public");
  const privateSubjectId = await ensureUser("hm-private", "private");
  await ensureUser("hm-admin", "public", true);

  const repoId = `r_hm-world`;
  const repoExists = await db.select({ id: repositories.id }).from(repositories).where(eq(repositories.id, repoId)).get();
  if (repoExists === undefined) {
    await db.insert(repositories).values({
      id: repoId,
      storageKey: repoId,
      ownerNamespace: "hm-subject",
      ownerId: subjectId,
      slug: "hm",
      visibility: "public",
    });
  }

  // The subject's rows: two in ONE bucket (the bucket pin) + one outside
  // the window (the exclusion pin); the private subject gets one in-window
  // row (their own session sees it — the gate's positive arm).
  const issueCount = await db.select({ id: issues.id }).from(issues).where(eq(issues.posterId, subjectId)).all();
  if (issueCount.length === 0) {
    await db.insert(issues).values([
      {
        repoId,
        index: 1,
        posterId: subjectId,
        title: "hm one",
        createdAt: new Date(BUCKET_START * 1000),
      },
      {
        repoId,
        index: 2,
        posterId: subjectId,
        title: "hm two",
        createdAt: new Date((BUCKET_START + 60) * 1000), // same bucket
      },
      {
        repoId,
        index: 3,
        posterId: subjectId,
        title: "hm old",
        createdAt: new Date(OUT_OF_WINDOW * 1000),
      },
    ]);
    // A comment row in a second bucket (the comment arm of the fold).
    const firstIssue = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, repoId)).limit(1).get();
    if (firstIssue === undefined) throw new Error("hm issue row missing");
    await db.insert(comments).values({
      type: 2,
      posterId: subjectId,
      issueId: firstIssue.id,
      content: "hm comment",
      createdAt: new Date((BUCKET_START + 900 * 10) * 1000), // the next bucket
    });
    await db.insert(issues).values({
      repoId,
      index: 4,
      posterId: privateSubjectId,
      title: "hm private",
      createdAt: new Date(BUCKET_START * 1000),
    });
  }

  fixture = { subjectId, privateSubjectId, adminCookie: 0, repoId };
  return fixture;
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the mounted-route harness -------------------------------------------------

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function withSession(username: string): Promise<RequestInit> {
  const db = drizzle(env.DB);
  const row = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, username)).get();
  if (row === undefined) throw new Error(`${username} row missing`);
  return { headers: { cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, row.id)}` } };
}

// --- the claim pins -------------------------------------------------------------

describe("the /{username}/-/heatmap claim pins", () => {
  it("claims the exact 4-segment tail and refuses the bare/broken namespace shapes", () => {
    expect(parseUiRoute("/hm-subject/-/heatmap")).toEqual({ family: "owner-heatmap", owner: "hm-subject" });
    expect(handlesUiRoute("/hm-subject/-/heatmap")).toBe(true);
    expect(parseUiRoute("/hm-subject/-/heatmap/extra")).toBeNull();
    // The bare `/-` stays the landed owner-home family's shape (pre-existing
    // posture — upstream's bare `/{username}/-` group has no route; not this
    // wave's arm to change).
    expect(parseUiRoute("/hm-subject/-")?.family).toBe("home");
    expect(parseUiRoute("/hm-subject/-/projects")).not.toBeNull(); // the landed sibling still claims
    expect(handlesUiRoute("/hm-subject/-/heatmap")).toBe(true);
  });
});

// --- the web pair shape ---------------------------------------------------------

describe("the web pair shape (writeHeatmapJSON's port)", () => {
  it("answers [[unixTs, count]...] + totalContributions with 900-second buckets and the window cut", async () => {
    const res = await fetchUi("/hm-subject/-/heatmap");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      totalContributions: 3, // two issues + one comment in-window; the old row excluded
      heatmapData: [
        [BUCKET_START, 2], // the two issue rows share the bucket
        [BUCKET_START + 9000, 1], // the comment's bucket
      ],
    });
  });

  it("answers an empty pair list for a subject with no in-window rows", async () => {
    await ensureUser("hm-empty", "public");
    const res = await fetchUi("/hm-empty/-/heatmap");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ heatmapData: [], totalContributions: 0 });
  });
});

// --- the visibility gate ----------------------------------------------------------

describe("the IsUserVisibleToViewer gate (heatmap.go:38-44)", () => {
  it("404-shells a private subject anonymous, and answers themself and a site admin", async () => {
    const anon = await fetchUi("/hm-private/-/heatmap");
    expect(anon.status).toBe(404);

    const self = await fetchUi("/hm-private/-/heatmap", await withSession("hm-private"));
    expect(self.status).toBe(200);
    expect(await self.json()).toEqual({ heatmapData: [[BUCKET_START, 1]], totalContributions: 1 });

    const admin = await fetchUi("/hm-private/-/heatmap", await withSession("hm-admin"));
    expect(admin.status).toBe(200);
  });

  it("307s a renamed user (the profile seam's redirect arm)", async () => {
    const db = drizzle(env.DB);
    await ensureUser("hm-original", "public");
    const row = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "hm-original")).get();
    if (row === undefined) throw new Error("hm-original row missing");
    // The landed seam reads user_redirects — insert the rename edge directly
    // (lower_name UNIQUE, redirect_user_id → users.id cascade).
    await env.DB.prepare("INSERT OR IGNORE INTO user_redirects (lower_name, redirect_user_id) VALUES (?, ?)")
      .bind("hm-oldname", row.id)
      .run();
    const res = await fetchUi("/hm-oldname/-/heatmap");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/hm-original/-/heatmap");
  });

  it("404s an org name (the R06 boundary — the org-scoped aggregation is not this wave's)", async () => {
    await ensureUser("hm-org", "public");
    await drizzle(env.DB).update(users).set({ type: "org" }).where(eq(users.usernameLower, "hm-org"));
    const res = await fetchUi("/hm-org/-/heatmap");
    expect(res.status).toBe(404);
  });
});

// --- the widget slot ---------------------------------------------------------------

describe("the activity tab's heatmap widget slot (user/heatmap.tmpl's div)", () => {
  it("renders #user-heatmap.is-loading with the JSON route and the locale data attributes", async () => {
    const res = await fetchUi("/hm-subject?tab=activity");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="user-heatmap"');
    expect(html).toContain('class="is-loading"');
    expect(html).toContain('data-heatmap-url="/hm-subject/-/heatmap"');
    expect(html).toContain('data-locale-total-contributions="%s contributions in the last 12 months"');
    expect(html).toContain('data-locale-no-contributions="No contributions"');
    expect(html).toContain('data-locale-more="More"');
    expect(html).toContain('data-locale-less="Less"');
    expect(html).toContain('class="activity-heatmap-container"');
  });
});
