/**
 * The org members family's DEFERRED route-level matrix (pages/org-members.tsx
 * mounted at /org/{org}/members — pages wave 23,
 * ui/__tests__/pages-wave23.test.ts owns the base arms: the exact-shape parse
 * claims, the public-org anonymous/owner/non-member/member PublicOnly arms,
 * the lowercase-keyword narrow + its empty arm, the unknown-org/user/tail
 * 404s and the a11y smoke. THIS FILE adds the arms wave23 does not carry,
 * driven over the mounted uiRouter with the issues-list 88ac2ee matrix's
 * minted-session pattern):
 *
 *   - the invisible-org gates: wave23's fixtures are public-org-only — the
 *     PRIVATE org 404-shells for anonymous AND for a signed-in non-member
 *     (orgVisibleToDoer's membership arm: sessions buy no visibility) while
 *     the signed-in plain member renders the full listing WITHOUT the owner
 *     prompt, the owner gets the prompt, and a SITE ADMIN non-member sees the
 *     role lines + prompt with no membership at all (the doerIsAdminFullAccess
 *     / isOrgOwnerViewer isAdmin arms wave23 has no fixture for); the LIMITED
 *     org hides from the anonymous viewer but renders public-only for any
 *     signed-in principal;
 *   - the pager over a 22-member org (wave23's 3-member fixture never leaves
 *     page 1): 20 rows + Older / the 2-row remainder + Newer / the
 *     past-the-end page rendering the no-results row WITH a Newer link back
 *     (parsePageNumber's no-upper-clamp posture) / junk ?page= clamping to 1;
 *   - the keyword-preserving pager: the Older/Newer hrefs carry `q=` first and
 *     `page=` last (the pageHref order), and the search input re-renders the
 *     keyword on every page;
 *   - the keyword grammar arms wave23's lowercase needle misses: the
 *     case-insensitive needle over lower_name AND lower(full_name) (the
 *     applyKeywordFilter pair, org.go:184-193), the trim-before-match (the
 *     input echoes the TRIMMED keyword), and the public filter riding the
 *     keyword query (a private membership matching the needle stays hidden
 *     from anonymous viewers but renders under the owner's keyword arm);
 *   - batch 5's query-shape arms: a WHITESPACE-ONLY q trims to the empty
 *     keyword and falls to the landed service read (the full public roster,
 *     never the no-results arm), and the keyword needle's WORKING boundary —
 *     48 chars, the largest needle whose `%needle%` LIKE fits D1's
 *     documented 50-byte pattern cap (services/user.ts:81) — renders 200
 *     with the whole-needle echo. The loader's `.slice(0, 255)` sits beyond
 *     that cap: needles of 49..255 chars throw inside D1 and 500 the route
 *     (disclosed in the test, reported — a page-module fix, not a test one).
 *   - the row shape under the owner's full view: the person glyph is a
 *     non-link placeholder (the org-home avatar-slot rule), the second-owner
 *     membership renders a SECOND shield-lock (the addMember role primitive),
 *     the Hidden badge markup, the userId-ASC row order, and the DEAD-CONTROL
 *     pin — upstream's /members/action/* visibility toggle and the Leave /
 *     Remove buttons (web.go:989, members.tmpl:51-71) render nowhere, so the
 *     page has no write surface (no cross-origin posture to test — the only
 *     form is the GET search box);
 *   - the rename-redirect arm: a renamed org 307s with path+query preserved
 *     (RedirectToUser's first-occurrence replace), a renamed PRIVATE org
 *     404-shells for anonymous (the coarse non-public gate) while a signed-in
 *     non-member still 307s — and the redirect target then 404s on the
 *     visibility collapse;
 *   - the claim pin: the literal `org` first segment shadows the dynamic
 *     owner parse (a repository-shaped /org/{repo}/members path claims into
 *     this family and then 404s on resolution — upstream registers the /org
 *     group ahead of the dynamic pairs), and the 3-segment /org/members head
 *     falls to the home family with owner "org" — a create-time reserved
 *     name that resolves to nothing → the route-level 404.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { orgMembers, users } from "../../db/schema";
import { OrgService } from "../../services/orgs/orgs";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";

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
 *  minted per request — the value is never rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** The member-list body slice (from the list container to the pager, when one
 *  renders) — navbar/menu chrome shares class names with nothing in here. */
function listSlice(html: string): string {
  const start = html.indexOf('flex-divided-list items-with-main');
  const end = html.indexOf('center page buttons');
  return html.slice(start, end === -1 ? undefined : end);
}

/** The `<div class="item">` row count — on this page the only divs with the
 *  bare item class are member rows and the empty-state row (the navbar/menu
 *  items are anchors, the pager items are `<a class="item navigation">`). */
function rowCount(html: string): number {
  return (html.match(/<div class="item">/g) ?? []).length;
}

// --- fixtures -------------------------------------------------------------------

const T0 = 1_700_000_000;

/** The ensure-once fixture pattern (pages-wave23's recipe): each describe's
 *  seeder runs exactly once per file — the org/user names are UNIQUE, so a
 *  re-run would collide, not converge. */
function once(seed: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | null = null;
  return () => {
    if (done === null) done = seed();
    return done;
  };
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

// --- the invisible-org gates (private + limited) -----------------------------------

describe("the invisible-org gates (private + limited, the arms wave23's public fixture lacks)", () => {
  /** A private + a limited org with the full viewer roster: owner, plain
   *  member (default-private membership), outsider, site admin. */
  const seedGateOrgs = once(async (): Promise<void> => {
    const orgs = new OrgService(env.DB);
    const owner = await seedVerifiedUser({ username: "gate-owner" });
    const member = await seedVerifiedUser({ username: "gate-member" });
    await seedVerifiedUser({ username: "gate-out" });
    await seedVerifiedUser({ username: "gate-admin", isAdmin: true });
    const priv = await orgs.createOrg({
      name: "gate-priv",
      ownerId: owner.id,
      visibility: "private",
      now: new Date(T0 * 1000),
    });
    await orgs.addMember(priv.id, member.id, { isPublic: false, now: new Date((T0 + 10) * 1000) });
    const ltd = await orgs.createOrg({
      name: "gate-ltd",
      ownerId: owner.id,
      visibility: "limited",
      now: new Date((T0 + 20) * 1000),
    });
    const ltdPub = await seedVerifiedUser({ username: "ltd-pub" });
    const ltdPriv = await seedVerifiedUser({ username: "ltd-priv" });
    await orgs.addMember(ltd.id, ltdPub.id, { isPublic: true, now: new Date((T0 + 30) * 1000) });
    await orgs.addMember(ltd.id, ltdPriv.id, { isPublic: false, now: new Date((T0 + 40) * 1000) });
  });

  it("the PRIVATE org 404-shells for the anonymous viewer (invisible = missing)", async () => {
    await seedGateOrgs();
    const res = await fetchUi("/org/gate-priv/members");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<div class="status-page-error">');
    expect(html).not.toContain('href="/gate-owner"');
  });

  it("the PRIVATE org 404-shells for a signed-in NON-member too (sessions buy no visibility)", async () => {
    await seedGateOrgs();
    const out = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "gate-out")).get();
    const res = await fetchUi("/org/gate-priv/members", { headers: { cookie: await sessionHeader(out!.id) } });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('href="/gate-owner"');
  });

  it("the signed-in plain MEMBER renders the full private listing — role lines, no owner prompt", async () => {
    await seedGateOrgs();
    const member = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "gate-member")).get();
    const res = await fetchUi("/org/gate-priv/members", { headers: { cookie: await sessionHeader(member!.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/gate-owner"');
    expect(html).toContain('href="/gate-member"');
    // The member is a non-owner viewer: role lines render (publicOnly=false —
    // the membership arm), the prompt row does not.
    expect(html).toContain("Member Role:");
    expect(html).toContain('<span class="ui basic small label">Hidden</span>');
    expect(html).not.toContain("Members are managed through teams.");
    expect(html).not.toContain('href="/gate-priv/teams"');
  });

  it("the OWNER of the private org gets the manage prompt on top of the full listing", async () => {
    await seedGateOrgs();
    const owner = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "gate-owner")).get();
    const res = await fetchUi("/org/gate-priv/members", { headers: { cookie: await sessionHeader(owner!.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Members are managed through teams.");
    expect(html).toContain('href="/gate-priv/teams"');
  });

  it("a SITE ADMIN non-member sees role lines + prompt with NO membership (the two admin arms)", async () => {
    await seedGateOrgs();
    const admin = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "gate-admin")).get();
    const res = await fetchUi("/org/gate-priv/members", { headers: { cookie: await sessionHeader(admin!.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // The listing drops its public-only scope on the admin full-access arm…
    expect(html).toContain('href="/gate-owner"');
    expect(html).toContain('href="/gate-member"');
    expect(html).toContain("Member Role:");
    expect(html).toContain("octicon-shield-lock");
    expect(html).toContain('<span class="ui basic small label">Hidden</span>');
    // …and the prompt rides isOrgOwnerViewer's isAdmin branch (no membership
    // row exists for gate-admin at all).
    expect(html).toContain("Members are managed through teams.");
    expect(html).toContain('href="/gate-priv/teams"');
  });

  it("the LIMITED org hides from the anonymous viewer but renders PUBLIC-ONLY for a signed-in non-member", async () => {
    await seedGateOrgs();
    expect((await fetchUi("/org/gate-ltd/members")).status).toBe(404);
    const out = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "gate-out")).get();
    const res = await fetchUi("/org/gate-ltd/members", { headers: { cookie: await sessionHeader(out!.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/ltd-pub"');
    expect(html).not.toContain('href="/ltd-priv"');
    expect(html).not.toContain("Member Role:");
  });
});

// --- the pager (wave23's fixture never leaves page 1) -------------------------------

describe("the pager over a 22-member org (20-per-page, no upper clamp)", () => {
  /** owner + pmem-01..pmem-21, ALL memberships flipped public — the anonymous
   *  viewer sees all 22 rows, seeded in id order (owner first). */
  const seedPagerOrg = once(async (): Promise<void> => {
    const orgs = new OrgService(env.DB);
    const owner = await seedVerifiedUser({ username: "pmem-owner" });
    const org = await orgs.createOrg({
      name: "pagemembers",
      ownerId: owner.id,
      visibility: "public",
      now: new Date(T0 * 1000),
    });
    for (let i = 1; i <= 21; i += 1) {
      const member = await seedVerifiedUser({ username: `pmem-${String(i).padStart(2, "0")}` });
      await orgs.addMember(org.id, member.id, { isPublic: true, now: new Date((T0 + i) * 1000) });
    }
    // The creator's own row is default-private (the create arm) — flip the
    // whole org public so the anonymous counts are the member counts.
    await drizzle(env.DB).update(orgMembers).set({ isPublic: true }).where(eq(orgMembers.orgId, org.id));
  });

  it("page 1: 20 rows, the Older link onto page 2, no Newer, owner first (userId ASC)", async () => {
    await seedPagerOrg();
    const res = await fetchUi("/org/pagemembers/members");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(rowCount(html)).toBe(20);
    expect(html).toContain('<a class="item navigation" href="/org/pagemembers/members?page=2"');
    expect(html).toContain('<span class="navigation_label">Older</span>');
    expect(html).not.toContain('<span class="navigation_label">Newer</span>');
    // The rows run userId ASC — the org creator (seeded first) heads the list.
    const list = listSlice(html);
    const ownerAt = list.indexOf('href="/pmem-owner"');
    const firstAt = list.indexOf('href="/pmem-01"');
    expect(ownerAt).toBeGreaterThanOrEqual(0);
    expect(ownerAt).toBeLessThan(firstAt);
    expect(list).not.toContain('href="/pmem-20"');
  });

  it("page 2: the remainder rows, Newer back onto page 1, no Older", async () => {
    await seedPagerOrg();
    const res = await fetchUi("/org/pagemembers/members?page=2");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(rowCount(html)).toBe(2);
    expect(listSlice(html)).toContain('href="/pmem-20"');
    expect(listSlice(html)).toContain('href="/pmem-21"');
    expect(html).toContain('<a class="item navigation" href="/org/pagemembers/members?page=1"');
    expect(html).toContain('<span class="navigation_label">Newer</span>');
    expect(html).not.toContain('<span class="navigation_label">Older</span>');
  });

  it("a past-the-end page renders the no-results row WITH a Newer link back (no upper clamp)", async () => {
    await seedPagerOrg();
    const res = await fetchUi("/org/pagemembers/members?page=99");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The empty arm replaces the rows…
    expect(html).toContain("No matching results found.");
    expect(listSlice(html)).not.toContain('href="/pmem-01"');
    // …but page > 1 keeps the pager alive with ONLY the Newer link (the
    // requested page − 1; more is false, so no Older).
    expect(html).toContain('<a class="item navigation" href="/org/pagemembers/members?page=98"');
    expect(html).toContain('<span class="navigation_label">Newer</span>');
    expect(html).not.toContain('<span class="navigation_label">Older</span>');
  });

  it("junk ?page= parses as page 1 (parsePageNumber's non-numeric branch)", async () => {
    await seedPagerOrg();
    const res = await fetchUi("/org/pagemembers/members?page=abc");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(rowCount(html)).toBe(20);
    expect(html).toContain('<a class="item navigation" href="/org/pagemembers/members?page=2"');
    expect(html).not.toContain('<span class="navigation_label">Newer</span>');
  });

  it("the keyword-preserving pager: q= rides Older/Newer FIRST, page LAST, and re-renders", async () => {
    await seedPagerOrg();
    // q=pmem matches all 22 usernames (the owner's included) — the keyword
    // arm paginates over the SAME 20-per-page.
    const page1 = await (await fetchUi("/org/pagemembers/members?q=pmem")).text();
    expect(rowCount(page1)).toBe(20);
    expect(page1).toContain('href="/org/pagemembers/members?q=pmem&amp;page=2"');
    const page2 = await (await fetchUi("/org/pagemembers/members?q=pmem&page=2")).text();
    expect(rowCount(page2)).toBe(2);
    expect(page2).toContain('href="/org/pagemembers/members?q=pmem&amp;page=1"');
    expect(page2).toContain('<span class="navigation_label">Newer</span>');
    expect(page2).not.toContain('<span class="navigation_label">Older</span>');
    // The search input echoes the keyword on the paged render too.
    expect(page2).toContain('value="pmem"');
  });
});

// --- the keyword grammar (case-insensitivity, full_name, trim, public filter) -------

describe("the keyword grammar arms (the needle pair org.go:184-193)", () => {
  /** c-skywalker carries the fullName "Sky Walker" (public membership),
   *  c-skyhidden matches the same needles with a PRIVATE membership,
   *  c-other matches neither. */
  const seedKeywordOrg = once(async (): Promise<void> => {
    const orgs = new OrgService(env.DB);
    const owner = await seedVerifiedUser({ username: "korg-owner" });
    const org = await orgs.createOrg({
      name: "korg",
      ownerId: owner.id,
      visibility: "public",
      now: new Date(T0 * 1000),
    });
    const sky = await seedVerifiedUser({ username: "c-skywalker" });
    await drizzle(env.DB).update(users).set({ fullName: "Sky Walker" }).where(eq(users.id, sky.id));
    await orgs.addMember(org.id, sky.id, { isPublic: true, now: new Date((T0 + 10) * 1000) });
    const hidden = await seedVerifiedUser({ username: "c-skyhidden" });
    await orgs.addMember(org.id, hidden.id, { isPublic: false, now: new Date((T0 + 20) * 1000) });
    const other = await seedVerifiedUser({ username: "c-other" });
    await drizzle(env.DB).update(users).set({ fullName: "Brand Other" }).where(eq(users.id, other.id));
    await orgs.addMember(org.id, other.id, { isPublic: true, now: new Date((T0 + 30) * 1000) });
  });

  it("an UPPERCASE needle matches case-insensitively over lower_name and lower(full_name)", async () => {
    await seedKeywordOrg();
    // usernameLower arm…
    const byName = await (await fetchUi("/org/korg/members?q=C-SKYWALKER")).text();
    expect(byName).toContain('href="/c-skywalker"');
    expect(byName).not.toContain('href="/c-other"');
    // …and the full_name arm (needle lowercased against lower(full_name)).
    const byFullName = await (await fetchUi("/org/korg/members?q=SKY WALK")).text();
    expect(byFullName).toContain('href="/c-skywalker"');
    expect(byFullName).not.toContain('href="/c-other"');
  });

  it("the keyword TRIMS before matching and the input echoes the trimmed value", async () => {
    await seedKeywordOrg();
    const res = await fetchUi("/org/korg/members?q=%20%20C-SKY%20%20");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/c-skywalker"');
    // The form re-renders the TRIMMED keyword (case preserved), not the raw
    // padded query.
    expect(html).toContain('value="C-SKY"');
    expect(html).not.toContain('value="%20%20C-SKY%20%20"');
  });

  it("the public filter RIDES the keyword query: a private match stays hidden from anonymous viewers", async () => {
    await seedKeywordOrg();
    // Both c-skywalker and c-skyhidden match "sky" — the publicOnly where
    // clause keeps only the public membership in the anonymous keyword arm.
    const anon = await (await fetchUi("/org/korg/members?q=sky")).text();
    expect(anon).toContain('href="/c-skywalker"');
    expect(anon).not.toContain('href="/c-skyhidden"');
    // The owner's keyword arm drops the public filter (the twin read's
    // non-public branch): both matches render.
    const owner = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "korg-owner")).get();
    const ownerView = await fetchUi("/org/korg/members?q=sky", { headers: { cookie: await sessionHeader(owner!.id) } });
    expect(ownerView.status).toBe(200);
    const ownerHtml = await ownerView.text();
    expect(ownerHtml).toContain('href="/c-skywalker"');
    expect(ownerHtml).toContain('href="/c-skyhidden"');
    expect(rowCount(ownerHtml)).toBe(2);
  });

  it("a WHITESPACE-ONLY q trims to the empty keyword — the unfiltered listing, never the no-results arm", async () => {
    await seedKeywordOrg();
    // loadOrgMembersData trims then branches: "" falls to the landed service
    // read (listOrgMemberRows), so the anonymous viewer gets the full PUBLIC
    // roster — the trim-before-match collapse, not a keyword LIKE of spaces.
    const res = await fetchUi("/org/korg/members?q=%20%20%20");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/c-skywalker"');
    expect(html).toContain('href="/c-other"');
    expect(html).not.toContain("No matching results found.");
    // The public roster is the two explicitly-public memberships — the
    // owner membership createOrg seeds is not public (the publicOnly where
    // keeps it anonymous-side invisible, the same picture the ?q=sky arm
    // above shows).
    expect(rowCount(html)).toBe(2);
    expect(html).not.toContain("navigation_label"); // 4 members < the 20 cap → no pager
  });

  it("the keyword needle works up to the D1 LIKE cap the loader documents nowhere: 48 chars render, the needle echoes whole", async () => {
    await seedKeywordOrg();
    // The keyword arm's twin read LIKEs `%needle%` — and D1 caps LIKE
    // patterns at 50 bytes (services/user.ts:81's documented cap, the
    // reason the /users search service uses instr()). A 48-char needle is
    // the largest that fits (48 + the two % = 50): the page answers 200,
    // the needle matches no member's name, and the input echoes the value
    // whole (it is below the loader's 255 slice).
    const needle = "a".repeat(48);
    const res = await fetchUi(`/org/korg/members?q=${needle}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No matching results found."); // no member name carries the needle
    expect(html).toContain(`value="${needle}"`); // the echo is the untouched needle
    // DISCLOSED LIMITATION (not pinned — a source-side candidate): needles
    // of 49..255 chars throw inside D1 (the LIKE pattern crosses 50 bytes)
    // and the route answers the plain 500 — the loader's `.slice(0, 255)`
    // sits beyond the usable cap, so its truncation boundary is
    // unreachable in effect. Upstream has no such cap (Go LIKE handles long
    // patterns); the fix belongs to the page module (clamp to 48 or switch
    // to the instr() shape) and is reported to the orchestrator.
  });
});

// --- the row shape under the owner's full view ---------------------------------------

describe("the row shape (avatar placeholder, second-owner shield, ordering, dead controls)", () => {
  /** d-owner + a SECOND owner (the addMember role primitive) + a public and a
   *  private plain member — the richest roster the row shape can sit on. */
  const seedShapeOrg = once(async (): Promise<void> => {
    const orgs = new OrgService(env.DB);
    const owner = await seedVerifiedUser({ username: "d-owner" });
    const org = await orgs.createOrg({
      name: "dorg",
      ownerId: owner.id,
      visibility: "public",
      now: new Date(T0 * 1000),
    });
    const second = await seedVerifiedUser({ username: "d-second" });
    await orgs.addMember(org.id, second.id, { role: "owner", isPublic: true, now: new Date((T0 + 10) * 1000) });
    const pub = await seedVerifiedUser({ username: "d-pub" });
    await orgs.addMember(org.id, pub.id, { isPublic: true, now: new Date((T0 + 20) * 1000) });
    const priv = await seedVerifiedUser({ username: "d-priv" });
    await orgs.addMember(org.id, priv.id, { isPublic: false, now: new Date((T0 + 30) * 1000) });
  });

  async function ownerViewHtml(): Promise<string> {
    await seedShapeOrg();
    const owner = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "d-owner")).get();
    const res = await fetchUi("/org/dorg/members", { headers: { cookie: await sessionHeader(owner!.id) } });
    expect(res.status).toBe(200);
    return res.text();
  }

  it("the avatar slot is the person GLYPH, never a link (the name link carries navigation)", async () => {
    const html = await ownerViewHtml();
    // Four rows, four placeholder glyphs.
    expect(rowCount(html)).toBe(4);
    expect((html.match(/octicon-person/g) ?? []).length).toBe(4);
    // Each row's leading slot holds the svg and nothing link-shaped.
    for (const segment of html.split('<div class="item-leading">').slice(1)) {
      const slot = segment.slice(0, segment.indexOf("</div>"));
      expect(slot).toContain("octicon-person");
      expect(slot).not.toContain("href=");
    }
  });

  it("two owner-role memberships render TWO shields; plain members render the bare Member line", async () => {
    const html = await ownerViewHtml();
    // d-owner (create arm) + d-second (the role primitive) — exactly two
    // shield-lock glyphs on the page.
    expect((html.match(/octicon-shield-lock/g) ?? []).length).toBe(2);
    expect((html.match(/Member Role:/g) ?? []).length).toBe(4);
    expect(html).toContain("Owner");
    // The Hidden badge marks exactly the two default-private memberships
    // (d-owner's own row and d-priv) with the upstream label markup.
    expect((html.match(/<span class="ui basic small label">Hidden<\/span>/g) ?? []).length).toBe(2);
  });

  it("rows run userId ASC (the creator, then the adds in seed order)", async () => {
    const html = await ownerViewHtml();
    const list = listSlice(html);
    const at = (name: string): number => list.indexOf(`href="/${name}"`);
    expect(at("d-owner")).toBeGreaterThanOrEqual(0);
    expect(at("d-owner")).toBeLessThan(at("d-second"));
    expect(at("d-second")).toBeLessThan(at("d-pub"));
    expect(at("d-pub")).toBeLessThan(at("d-priv"));
  });

  it("the /members/action write family (visibility toggle, leave, remove) renders NOWHERE", async () => {
    const html = await ownerViewHtml();
    // Upstream members.tmpl:51-71 + web.go:989 — the unported write family.
    // Dead controls are forbidden (§2.4.1), so nothing may hint at them.
    expect(html).not.toContain("members/action");
    expect(html).not.toContain(">Leave</button>");
    expect(html).not.toContain(">Remove</button>");
    expect(html).not.toContain("data-modal-confirm");
    // Consequently the page carries NO write surface: the only form is the
    // GET search box (cross-origin has nothing to protect here).
    expect(html).toContain('<form class="ui form ignore-dirty tw-my-4" method="get"');
  });
});

// --- the rename-redirect arm ----------------------------------------------------------

describe("the rename-redirect arm (RedirectToUser through the members route)", () => {
  it("a renamed PUBLIC org 307s with the owner segment rewritten and the query preserved", async () => {
    const orgs = new OrgService(env.DB);
    const owner = await seedVerifiedUser({ username: "r-owner" });
    const org = await orgs.createOrg({
      name: "r-old-name",
      ownerId: owner.id,
      visibility: "public",
      now: new Date(T0 * 1000),
    });
    const pub = await seedVerifiedUser({ username: "r-pub" });
    await orgs.addMember(org.id, pub.id, { isPublic: true, now: new Date((T0 + 10) * 1000) });
    await orgs.renameOrg(org.id, "r-new-name", { now: new Date((T0 + 20) * 1000) });

    const res = await fetchUi("/org/r-old-name/members?q=pub");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/org/r-new-name/members?q=pub");

    // The target serves the listing under the new name (the anonymous
    // public-only row).
    const followed = await fetchUi("/org/r-new-name/members?q=pub");
    expect(followed.status).toBe(200);
    expect(await followed.text()).toContain('href="/r-pub"');
  });

  it("a renamed PRIVATE org 404-shells for anonymous (the coarse non-public gate) but 307s signed-in — and the target then collapses", async () => {
    const orgs = new OrgService(env.DB);
    const owner = await seedVerifiedUser({ username: "rp-owner" });
    const out = await seedVerifiedUser({ username: "rp-out" });
    const org = await orgs.createOrg({
      name: "rp-old",
      ownerId: owner.id,
      visibility: "private",
      now: new Date(T0 * 1000),
    });
    await orgs.renameOrg(org.id, "rp-new", { now: new Date((T0 + 10) * 1000) });

    // Anonymous: a non-public redirect target reads as a plain miss.
    expect((await fetchUi("/org/rp-old/members")).status).toBe(404);

    // Signed-in non-member: the coarse gate passes any doer → 307; the
    // TARGET then 404s on the visibility collapse (no membership).
    const redirected = await fetchUi("/org/rp-old/members", { headers: { cookie: await sessionHeader(out.id) } });
    expect(redirected.status).toBe(307);
    expect(redirected.headers.get("location")).toBe("/org/rp-new/members");
    const followed = await fetchUi("/org/rp-new/members", { headers: { cookie: await sessionHeader(out.id) } });
    expect(followed.status).toBe(404);
  });
});

// --- the claim pin (the shapes wave23's pin does not cover) -----------------------------

describe("the claim pin (the literal-shadow and 3-segment heads)", () => {
  it("the literal `org` first segment SHADOWS the dynamic owner parse — /org/{repo}/members claims into this family", async () => {
    // Upstream registers the /org group ahead of the dynamic pairs, so a
    // repository path /org/{repo}/members never resolves as owner "org" —
    // the parser claims it into org-members and resolution 404s it.
    expect(parseUiRoute("/org/any-repo-name/members")).toEqual({ family: "org-members", owner: "any-repo-name" });
    expect(handlesUiRoute("/org/any-repo-name/members")).toBe(true);
    expect((await fetchUi("/org/any-repo-name/members")).status).toBe(404);
  });

  it("the 3-segment /org/members head falls to the home family — owner 'org' resolves to nothing → 404", async () => {
    // NOT a parser null: the dynamic owner parse claims the 3-segment shape
    // with owner "org" (the wave23 pin's other half) — a create-time reserved
    // name, so the route-level resolution 404-shells it.
    expect(parseUiRoute("/org/members")).toEqual({ family: "home", owner: "org", repo: "members", refSuffix: null });
    expect(handlesUiRoute("/org/members")).toBe(true);
    expect((await fetchUi("/org/members")).status).toBe(404);
  });
});
