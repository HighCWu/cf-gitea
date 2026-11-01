/**
 * The user-json-aux module tests (the issues-search-aux fixture discipline):
 * the module is UNMOUNTED — both feed handlers are index-owned (the module
 * header's HANDOFF carries the fold recipe) — so the tests drive the
 * parsers, loaders, and Response builders DIRECTLY on real D1 + real
 * bindings (workerd, @cloudflare/vitest-plugin) over seeded
 * users/orgs/repos/issues/stopwatches.
 *
 * Feed 1 asserts the web /user/stopwatches grammar from the pin's handler
 * (stop_watch.go:16-40): the RAW FormInt page (0 = UNPAGED — the API twin's
 * <=0→1 clamp does not exist here), the ToCorrectPageSize limit clamp, the
 * full-row X-Total-Count (skipped rows still count), the ToStopWatches
 * skip arms (missing issue, unreadable repo), the seconds/duration
 * derivation and the bare-array envelope. Feed 2 asserts
 * /user/search_candidates' SearchUsers read (search.go:18-35): the
 * username_lower + full_name keyword pair, the orgs Types arm, the
 * IsActive 'active' pin, the BuildCanSeeUserCondition ladder (anonymous
 * public-only; the signed-in self/limited arms; the org-membership arm the
 * orgs flag unlocks; the admin no-filter), the `name ASC` order, the
 * no-pagination quirk (MembersPagingNum dead) and the count-less
 * `{"data":[…]}` envelope.
 *
 * The two reqSignIn/optExploreSignIn postures (mission arms): feed 1's
 * anonymous caller is the DISPATCHER's 303-onto-/user/login (web.go:766 —
 * index-owned, the module has no anonymous loader path; the nearest
 * module-visible arm, the zero-row doer, is pinned clean); feed 2's
 * anonymous caller IS SERVED (optExploreSignIn with both settings
 * default-off) and its public-only ceiling is pinned through the loader.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { IssuesService } from "../../issues/service";
import { RepoService } from "../../repos/service";
import type { User } from "../../api/models/user";
import { toApiUser } from "../../api/auth";
import type { Viewer } from "../../api/services/repository";
import { issueStopwatches, orgMembers, users } from "../../db/schema";
import {
  loadUserSearchCandidatesAux,
  loadUserStopwatchesAux,
  parseUserSearchCandidatesQuery,
  parseUserStopwatchesQuery,
  userSearchCandidatesResponse,
  userStopwatchesAuxResponse,
} from "./user-json-aux";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

/** The viewer the dispatcher builds for the session user row (HANDOFF §2 —
 *  the repoSearchAuxRoute bridge verbatim): the row's AuthUser slice through
 *  the auth mapper's toApiUser (the authed arm is always true there, so
 *  is_admin/active render the row's real values — the admin arm needs it),
 *  fed back as the requester. */
async function viewerFor(usernameLower: string): Promise<Viewer> {
  const row = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, usernameLower)).get();
  if (row === undefined) throw new Error(`viewer row missing: ${usernameLower}`);
  return {
    origin: ORIGIN,
    requester: toApiUser({
      id: row.id,
      username: row.username,
      usernameLower: row.usernameLower,
      email: row.email,
      displayName: row.displayName,
      location: row.location,
      website: row.website,
      description: row.description,
      isAdmin: row.isAdmin,
      status: row.status,
      createdAt: row.createdAt,
    }),
  };
}

const ANONYMOUS_VIEWER: Viewer = { origin: ORIGIN, requester: null };

interface CandidateFixture {
  swatch: { id: number; username: string };
  peeker: { id: number; username: string };
}

/** The shared candidate/stopwatch world. Idempotent per test (beforeEach
 *  wipes + this re-seeds): swatch (the stopwatch doer), the keyword family
 *  (candB/canda public, candlim limited, candpriv private, canddead
 *  prohibited, candadmin admin, zzqqq full_name-only match, candorg public
 *  org, candprivorg private org with peeker a member), swatch's public repo
 *  with the timed issue, and swatch's three stopwatch rows — public (the
 *  rendered one), private-repo (the unreadable skip), ghost issue (the
 *  missing-issue skip). */
async function ensureFixture(): Promise<CandidateFixture> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const swatch = await seedVerifiedUser({ username: "swatch" });
  const peeker = await seedVerifiedUser({ username: "peeker" });
  await seedVerifiedUser({ username: "candadmin", isAdmin: true });
  await seedVerifiedUser({ username: "candB" });
  await seedVerifiedUser({ username: "canda" });
  await seedVerifiedUser({ username: "canddead", status: "prohibited" });

  // The non-default rows seedVerifiedUser cannot express: the limited and
  // private candidate users, the full_name-only match, the two org rows,
  // peeker's membership in the private org.
  await db.insert(users).values([
    { username: "candlim", usernameLower: "candlim", visibility: "limited", createdAt: new Date() },
    { username: "candpriv", usernameLower: "candpriv", visibility: "private", createdAt: new Date() },
    { username: "zzqqq", usernameLower: "zzqqq", fullName: "Candor Example", createdAt: new Date() },
    { username: "candorg", usernameLower: "candorg", type: "org", createdAt: new Date() },
    { username: "candprivorg", usernameLower: "candprivorg", type: "org", visibility: "private", createdAt: new Date() },
  ]);
  const privOrg = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "candprivorg")).get();
  if (privOrg === undefined) throw new Error("priv org row missing");
  await db.insert(orgMembers).values({ orgId: privOrg.id, userId: peeker.id, createdAt: new Date() });

  // swatch's public repo + the timed issue.
  const repo = await new RepoService(env.DB).create({
    owner: { id: swatch.id, usernameLower: "swatch" },
    name: "swatchrepo",
    isPrivate: false,
    status: "ready",
  });
  const issue = await new IssuesService(env.DB).createIssue({
    repoId: repo.id,
    title: "timed bug",
    posterId: swatch.id,
    now: new Date(),
  });

  // The unreadable-repo skip arm: a PRIVATE repo owned by the private
  // candidate (swatch holds no grant), carrying the second stopwatch row.
  const candPrivRow = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "candpriv")).get();
  if (candPrivRow === undefined) throw new Error("candpriv row missing");
  const privRepo = await new RepoService(env.DB).create({
    owner: { id: candPrivRow.id, usernameLower: "candpriv" },
    name: "privrepo",
    isPrivate: true,
    status: "ready",
  });
  const privIssue = await new IssuesService(env.DB).createIssue({
    repoId: privRepo.id,
    title: "unreachable bug",
    posterId: candPrivRow.id,
    now: new Date(),
  });

  // The three stopwatch rows in id order: public (renders), private-repo
  // (skips), ghost issue (skips). ~7500 s elapsed on the rendered row →
  // "2 hours 5 mins".
  await db.insert(issueStopwatches).values([
    { issueId: issue.id, userId: swatch.id, createdAt: new Date(Date.now() - 7500 * 1000) },
    { issueId: privIssue.id, userId: swatch.id, createdAt: new Date(Date.now() - 80 * 1000) },
    { issueId: 999_999_999, userId: swatch.id, createdAt: new Date(Date.now() - 50 * 1000) },
  ]);

  return { swatch, peeker };
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "stopwatch",
    "issues",
    "repo_settings",
    "repo_counters",
    "repo_units",
    "repo_redirects",
    "org_members",
    "follows",
    "repositories",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

// --- the pure parsers ---------------------------------------------------------

describe("parse helpers", () => {
  it("parseUserStopwatchesQuery: RAW FormInt page (0 = unpaged) + ToCorrectPageSize limit (<=0 → 30, >50 → 50)", () => {
    expect(parseUserStopwatchesQuery(new URL("https://x/user/stopwatches"))).toEqual({ page: 0, limit: 30 });
    expect(parseUserStopwatchesQuery(new URL("https://x/user/stopwatches?page=abc&limit=0"))).toEqual({ page: 0, limit: 30 });
    expect(parseUserStopwatchesQuery(new URL("https://x/user/stopwatches?limit=999"))).toEqual({ page: 0, limit: 50 });
    expect(parseUserStopwatchesQuery(new URL("https://x/user/stopwatches?page=2&limit=7"))).toEqual({ page: 2, limit: 7 });
    // page=0 stays 0 — the unpaged sentinel, NOT the API twin's clamp to 1.
    expect(parseUserStopwatchesQuery(new URL("https://x/user/stopwatches?page=0")).page).toBe(0);
  });

  it("parseUserSearchCandidatesQuery: FormTrim q + FormBool orgs, NO page/limit (the no-pagination quirk)", () => {
    expect(parseUserSearchCandidatesQuery(new URL("https://x/user/search_candidates"))).toEqual({ keyword: "", orgs: false });
    expect(parseUserSearchCandidatesQuery(new URL("https://x/user/search_candidates?q=%20cand%20"))).toEqual({ keyword: "cand", orgs: false });
    expect(parseUserSearchCandidatesQuery(new URL("https://x/user/search_candidates?orgs=true"))).toEqual({ keyword: "", orgs: true });
    expect(parseUserSearchCandidatesQuery(new URL("https://x/user/search_candidates?orgs=1")).orgs).toBe(true);
    expect(parseUserSearchCandidatesQuery(new URL("https://x/user/search_candidates?orgs=0")).orgs).toBe(false);
    // Page params the handler never reads — PageSize 20 (MembersPagingNum)
    // is dead upstream (search.go never sets Page, and SearchUsers pages
    // only `if Page > 0`).
    expect("page" in parseUserSearchCandidatesQuery(new URL("https://x/user/search_candidates?page=3"))).toBe(false);
  });
});

// --- feed 1: GET /user/stopwatches ----------------------------------------------

describe("loadUserStopwatchesAux — the web /user/stopwatches grammar", () => {
  it("happy: the rendered row, the seconds/duration derivation, the full-row X-Total-Count with skips", async () => {
    const f = await ensureFixture();
    const viewer = await viewerFor("swatch");
    const { total, data } = await loadUserStopwatchesAux(env, f.swatch.id, viewer, { page: 0, limit: 30 });
    // THREE stopwatch rows count (CountUserStopwatches is unpaginated and
    // upstream counts before the per-row skips); exactly ONE renders — the
    // private-repo row skips (unreadable repo) and the ghost row skips
    // (missing issue).
    expect(total).toBe(3);
    expect(data).toHaveLength(1);
    const item = data[0];
    expect(item?.issue_index).toBe(1);
    expect(item?.issue_title).toBe("timed bug");
    expect(item?.repo_owner_name).toBe("swatch");
    expect(item?.repo_name).toBe("swatchrepo");
    expect(item?.created).toBeTypeOf("string");
    // seconds derive from created_unix at read time (~7500 s seeded; the
    // tolerance is the clock tick between seed and load).
    expect(item?.seconds).toBeGreaterThanOrEqual(7500);
    expect(item?.seconds).toBeLessThanOrEqual(7510);
    // util.SecToHours over ~7500 s: 2 hours 5 minutes (seconds ∈
    // [7500, 7510] keeps hours=2, minutes=5).
    expect(item?.duration).toBe("2 hours 5 minutes");
  });

  it("the Response builder: bare StopWatches array + SetTotalCountHeader over the ctx.JSON envelope", async () => {
    const f = await ensureFixture();
    const viewer = await viewerFor("swatch");
    const { total, data } = await loadUserStopwatchesAux(env, f.swatch.id, viewer, { page: 0, limit: 30 });
    const response = userStopwatchesAuxResponse(total, data);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(response.headers.get("x-total-count")).toBe("3");
    expect(response.headers.get("access-control-expose-headers")).toBe("X-Total-Count");
    const body = await response.json<Array<Record<string, unknown>>>();
    // A bare JSON array (StopWatches) — no envelope object.
    expect(Array.isArray(body)).toBe(true);
    expect(Object.keys(body[0] ?? {})).toEqual([
      "created",
      "seconds",
      "duration",
      "issue_index",
      "issue_title",
      "repo_owner_name",
      "repo_name",
    ]);
  });

  it("paging: page rides RAW (1-paged slice, unpaged default) while the count stays full-row", async () => {
    const f = await ensureFixture();
    const viewer = await viewerFor("swatch");
    // page=1&limit=1 → the first row (id order) renders; count stays 3.
    const page1 = await loadUserStopwatchesAux(env, f.swatch.id, viewer, { page: 1, limit: 1 });
    expect(page1.total).toBe(3);
    expect(page1.data.map((item) => item.issue_title)).toEqual(["timed bug"]);
    // page=2&limit=1 → the private-repo row alone — skipped: empty data,
    // count STILL 3 (the skip is post-count).
    const page2 = await loadUserStopwatchesAux(env, f.swatch.id, viewer, { page: 2, limit: 1 });
    expect(page2.total).toBe(3);
    expect(page2.data).toEqual([]);
    // page=3&limit=1 → the ghost-issue row — skipped the same way.
    const page3 = await loadUserStopwatchesAux(env, f.swatch.id, viewer, { page: 3, limit: 1 });
    expect(page3.total).toBe(3);
    expect(page3.data).toEqual([]);
    // page=0 → UNPAGED (stopwatch.go:79's `if Page > 0` gate) — all three
    // rows read regardless of the limit clamp; the happy test pins the
    // rendered outcome.
  });

  it("empty + anonymous arms: a zero-row doer is the clean empty feed; the anonymous caller never reaches the loader (reqSignIn's 303 is index-owned)", async () => {
    const f = await ensureFixture();
    // The zero-row doer (peeker owns no stopwatch): total 0, data [].
    const viewer = await viewerFor("peeker");
    const empty = await loadUserStopwatchesAux(env, f.peeker.id, viewer, { page: 0, limit: 30 });
    expect(empty).toEqual({ total: 0, data: [] });
    const response = userStopwatchesAuxResponse(empty.total, empty.data);
    expect(response.headers.get("x-total-count")).toBe("0");
    expect((await response.text())).toBe("[]");
    // reqSignIn (web.go:766): upstream redirects the anonymous caller onto
    // the login round-trip BEFORE the handler runs — the module exposes no
    // anonymous loader path (the loader is typed on the resolved session
    // doer's id); the 303 itself is the dispatcher's arm (HANDOFF §2).
    // The nearest module-visible arm — a doer id with no rows — is the
    // clean empty feed above, never an error shell.
  });
});

// --- feed 2: GET /user/search_candidates ----------------------------------------

/** Drive the candidates loader (the mount builds this URL). */
async function candidates(
  query: string,
  viewer: Viewer,
): Promise<{ data: User[] }> {
  const url = new URL(`https://test.local/user/search_candidates${query}`);
  return loadUserSearchCandidatesAux(env, viewer, parseUserSearchCandidatesQuery(url));
}

const logins = (data: User[]): Array<string | undefined> => data.map((item) => item.login);

describe("loadUserSearchCandidatesAux — the web /user/search_candidates grammar", () => {
  it("happy anonymous: the public-active candidate set, name-ASC order, the full_name keyword arm", async () => {
    await ensureFixture();
    const { data } = await candidates("?q=cand", ANONYMOUS_VIEWER);
    // candB before canda — SearchOrderByAlphabetically is literal `name ASC`
    // (the DISPLAY-cased username; the lower_name sort would flip the pair).
    // candadmin is itself a public user matching the needle; zzqqq matches
    // ONLY via LOWER(full_name) ("Candor Example").
    expect(data.map((item) => item.login)).toEqual(["candB", "canda", "candadmin", "zzqqq"]);
    // Excluded from this anonymous set: candlim (limited — public-only
    // ceiling), candpriv (private), canddead (prohibited — IsActive
    // Some(true)), both orgs (orgs defaults false).
    const first = data[0];
    expect(first?.type).toBe("User");
    expect(first?.username).toBe(first?.login); // the MarshalJSON compat key
    expect(first?.avatar_url).toBe(`${ORIGIN}/avatars/candb`);
    expect(first?.html_url).toBe(`${ORIGIN}/candB`);
    expect(first?.full_name).toBe("");
    // The anonymous render: the noreply placeholder built over the row id,
    // never the real email.
    expect(first?.email).toBe(`${first?.id}+candb@users.noreply.gitea.invalid`);
    // zzqqq's full_name renders "" — the canonical serializer (apiUserFromRow)
    // renders the full_name key from users.display_name, while the SEARCH
    // matches users.full_name ("Candor Example"); the inclusion above is the
    // full_name keyword arm's pin, the empty render the landed serializer's.
    const fullNamed = data[3];
    expect(fullNamed?.full_name).toBe("");
  });

  it("the envelope: {\"data\":[…]} with NO X-Total-Count (the handler discards the count)", async () => {
    await ensureFixture();
    const result = await candidates("?q=cand", ANONYMOUS_VIEWER);
    const response = userSearchCandidatesResponse(result);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(response.headers.get("x-total-count")).toBeNull();
    const body = await response.json<{ data: User[] }>();
    expect(Object.keys(body)).toEqual(["data"]);
    expect(body.data).toHaveLength(4);
  });

  it("empty + trim arms: a padded q trims to the same set, a no-match q is the clean {\"data\":[]}", async () => {
    await ensureFixture();
    const padded = await candidates("?q=%20cand%20", ANONYMOUS_VIEWER);
    expect(padded.data).toHaveLength(4); // FormTrim strips the padding
    const none = await candidates("?q=nomatch", ANONYMOUS_VIEWER);
    expect(none).toEqual({ data: [] });
  });

  it("orgs=true adds the org rows to the Types filter; the keyword stays case-insensitive", async () => {
    await ensureFixture();
    const withOrgs = await candidates("?q=cand&orgs=true", ANONYMOUS_VIEWER);
    // candorg (public org) joins; candprivorg (private org) stays hidden
    // from the anonymous ceiling.
    expect(logins(withOrgs.data)).toEqual(["candB", "canda", "candadmin", "candorg", "zzqqq"]);
    const org = withOrgs.data[3];
    expect(org?.type).toBe("Organization");
    // The ASCII-case-insensitive needle (search.go:68's ToLower).
    const upper = await candidates("?q=CANDB", ANONYMOUS_VIEWER);
    expect(logins(upper.data)).toEqual(["candB"]);
  });

  it("anonymous vs signed-in: the visibility ladder (limited needs a doer, private needs self/membership/admin)", async () => {
    await ensureFixture();
    // Anonymous q=cand orgs=true: limited candlim and private candprivorg
    // hidden (the !canViewPrivate public-only AND-arm).
    const anon = await candidates("?q=cand&orgs=true", ANONYMOUS_VIEWER);
    expect(logins(anon.data)).toEqual(["candB", "canda", "candadmin", "candorg", "zzqqq"]);

    // A signed-in doer: limited surfaces (visibility != private), AND the
    // membership arm fires — peeker belongs to candprivorg, so the private
    // org rides the q=cand set too (search.go:177, unlocked by THIS feed's
    // orgs arm).
    const peekerViewer = await viewerFor("peeker");
    const signed = await candidates("?q=cand&orgs=true", peekerViewer);
    expect(logins(signed.data)).toEqual(["candB", "canda", "candadmin", "candlim", "candorg", "candprivorg", "zzqqq"]);

    // The membership arm narrows cleanly: peeker's needle on the private
    // org's name surfaces exactly it — orgs=true required, without it the
    // Types filter ([Individual] only, search.go:19-22) excludes every org
    // row before the visibility cond runs. candpriv (a private USER) never
    // surfaces — the search-side SQL cond has no follow arm.
    const member = await candidates("?q=candprivorg&orgs=true", peekerViewer);
    expect(logins(member.data)).toEqual(["candprivorg"]);
    const memberNoOrgs = await candidates("?q=candprivorg", peekerViewer);
    expect(memberNoOrgs).toEqual({ data: [] });

    // A non-member signed-in doer still misses the private org — even with
    // the orgs flag (the membership arm is the only door into a private org).
    const outsider = await viewerFor("canda");
    const noMember = await candidates("?q=candprivorg&orgs=true", outsider);
    expect(noMember).toEqual({ data: [] });

    // The self arm (search.go:181): the private candidate sees themself.
    const selfViewer = await viewerFor("candpriv");
    const self = await candidates("?q=candpriv", selfViewer);
    expect(logins(self.data)).toEqual(["candpriv"]);
    expect(self.data[0]?.active).toBe(true); // the authed render arm
    expect(self.data[0]?.email).toBe(""); // NULL email renders "" when authed

    // The admin no-filter arm (search.go:176's !IsAdmin gate skipped):
    // EVERYTHING matching surfaces regardless of visibility.
    const adminViewer = await viewerFor("candadmin");
    const admin = await candidates("?q=cand&orgs=true", adminViewer);
    expect(logins(admin.data)).toEqual(["candB", "canda", "candadmin", "candlim", "candorg", "candpriv", "candprivorg", "zzqqq"]);
  });

  it("the IsActive pin: a prohibited account never candidates, even for the admin", async () => {
    await ensureFixture();
    const adminViewer = await viewerFor("candadmin");
    const dead = await candidates("?q=canddead", adminViewer);
    expect(dead).toEqual({ data: [] });
  });

  it("the whitespace-only q trims to the UNFILTERED public universe (the FormTrim collapse)", async () => {
    await ensureFixture();
    const blank = await candidates("?q=%20%20%20", ANONYMOUS_VIEWER);
    // Every public-active user row, keyword-less: the two public candidates,
    // swatch, peeker (candadmin is admin but still a public USER — visible;
    // limited/private/prohibited/orgs never surface anonymously).
    expect(logins(blank.data)).toEqual(["candB", "canda", "candadmin", "peeker", "swatch", "zzqqq"]);
  });

  it("the no-pagination quirk: 25 matches render in ONE feed (MembersPagingNum 20 is dead)", async () => {
    await ensureFixture();
    const db = drizzle(env.DB);
    // One insert per row — D1 caps the SQL-variable count on a 25-row batch.
    for (let index = 0; index < 25; index += 1) {
      const name = `bulkuser${String(index).padStart(2, "0")}`;
      await db.insert(users).values({ username: name, usernameLower: name, createdAt: new Date() });
    }
    const result = await candidates("?q=bulkuser", ANONYMOUS_VIEWER);
    // Upstream never pages this feed: Page stays 0 and SearchUsers applies
    // no LIMIT (search.go:162-164) — all 25 render, NOT the PageSize-20 cap.
    expect(result.data).toHaveLength(25);
    expect(logins(result.data)[0]).toBe("bulkuser00");
    expect(logins(result.data)[24]).toBe("bulkuser24");
  });
});
