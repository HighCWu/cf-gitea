/**
 * The ORG HOME page's DEFERRED route-level matrix (the polish wave, after
 * the wave-6 mount — pages/org-home.tsx over index.ts's ownerHomePage ORG
 * half): the MINTED-SESSION route arms driven through `uiRouter.fetch()` on
 * the real production path (parse → resolveUiSession → the resolveOrgHome
 * ladder → loadOrgHomeData → render — the org-repos matrix 3c596f9's
 * pattern), one fresh org world per test behind per-test table wipes. The
 * older suites own the base arms and are NOT repeated here:
 * ui/__tests__/pages-wave6.test.ts owns the `/{org}` golden shape (the
 * public header block, the reduced single-tab menu, the empty placeholder,
 * the anon/owner private-org pair, the limited anon/stranger pair, the
 * 15+1 pagination split, the plain-user dispatch, the public-rename 307,
 * the /login non-shadow); pages-wave7.test.ts + pages/user-profile.matrix
 * .test.ts own the owner-home FAMILY claim pin (the parse refusals, the
 * mixed-case USER resolve, the org name ignoring ?tab=activity) and
 * pages/org-repos.matrix.test.tsx owns the SAME service seam through the
 * `/{org}/-/repositories` URL. THIS file adds the arms neither suite
 * carries through the `/{org}` URL itself:
 *
 *   - the visibility-gate CONTINUATION: the private org's signed-in
 *     OUTSIDER 404-shell beside the member/owner/site-admin admissions,
 *     and the limited org's full signed-in ladder with the full-class
 *     header badges;
 *   - the org-header shapes wave-6's golden header never pinned: the
 *     EMAIL row's `{{if and .IsSigned .Org.Email}}` gate (anonymous never
 *     sees it, any signed-in viewer does — the website row's
 *     target/rel attributes ride along), the display-name fallback to the
 *     username on a fullName-less org, the bare header (no description /
 *     location / website / email rows at all), the public org rendering NO
 *     visibility badge, and the mixed-case ORG resolve through the
 *     case-folded lookup (display case preserved in the DOM and the links);
 *   - the repo-list SHAPE through /{org}: the anonymous 15-row cap
 *     rendering pager-less at the exact cap, the Internal badge (a public
 *     repo under a private org) for the admitted plain member, the batched
 *     repo_settings description body, the open-pulls chip (the
 *     num_pulls − num_closed_pulls subtraction, the 0/0 → 0 floor), the
 *     Updated relative-time line, and the Archived row badge;
 *   - the pagination GRAMMAR through /{org}: page 2's Newer folding onto
 *     the BARE org link, the junk/zero/negative page folds, the beyond-end
 *     page's zero-repo placeholder with the count label keeping the true
 *     total, and the pager anchors staying canonical under a ?tab= query
 *     (the tab never leaks into an anchor);
 *   - the member-and-team strip NON-rendering (the documented v1
 *     reduction): even the org-owner viewer — upstream's
 *     `ShowMemberAndTeamTab` arm — gets no sidebar, no new-repo/migrate
 *     buttons, no view-as dropdown, no members/teams links, against a
 *     world that HAS members and a team;
 *   - the renamed-org seam through /{org} beyond wave-6's public pair:
 *     the multi-param query preservation and the PRIVATE rename's coarse
 *     RedirectToUser split (anonymous folds into the miss, ANY signed-in
 *     principal — even a stranger — reads the 307);
 *   - and the /{org} claim pin: the single segment claims, and the
 *     trailing-slash form 301s onto the canonical URL whose GET renders
 *     the org home.
 *
 * The fixture world is `ohm` (ohm-owner; ohm-member a plain member of the
 * public `ohmpub`; ohm-granted a member whose Vault Crew read team covers
 * exactly the private omega-vault; ohm-outsider a stranger; ohm-admin the
 * site admin; ohm-secmember a plain member of the private `ohmsec`), seeded
 * through the LANDED OrgService/TeamsService/RepoService arms — ids are
 * captured at seed time, never hardcoded. ohmpub carries 16 repos (exactly
 * one over the 15-per-page cap): alpha (the shape carrier), omega-vault
 * (private), zeta-archive (archived) + 13 bulk — so the ANONYMOUS list
 * lands on exactly 15 public rows (pager-less at the cap) while the owner's
 * 16-row view splits 15+1.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TeamsService } from "../../api/routes/org-teams";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, repoSettings } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { UiManifest } from "../manifest";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** Tables the fixtures touch (children first — the blocked-users harness's
 *  cleanup-list convention; "sessions" explicit because every request mints
 *  a session row). */
const FIXTURE_TABLES = [
  "team_repo_access",
  "team_members",
  "teams",
  "repo_settings",
  "repo_counters",
  "repositories",
  "org_members",
  "user_redirects",
  "sessions",
  "users",
];

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of FIXTURE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

/** The route world's REAL rows: the public `ohmpub` (full profile fields +
 *  16 repos), the private `ohmsec` (the Internal-badge carrier open-work +
 *  hidden-work), the limited `ohmlax`, the bare repo-less `OhmCase`
 *  (display-case name, every profile field null), and the two rename pairs
 *  (public + private). */
interface OrgHomeWorld {
  ownerId: number; // ohm-owner
  memberId: number; // ohm-member — ohmpub member, no team
  grantedId: number; // ohm-granted — ohmpub member, Vault Crew over omega-vault
  outsiderId: number; // ohm-outsider — no membership anywhere
  adminId: number; // ohm-admin — site admin
  secmemberId: number; // ohm-secmember — plain member of ohmsec
  ohmpub: OrgRecord;
}

async function seedOrgHomeWorld(): Promise<OrgHomeWorld> {
  const owner = await seedVerifiedUser({ username: "ohm-owner" });
  const member = await seedVerifiedUser({ username: "ohm-member" });
  const granted = await seedVerifiedUser({ username: "ohm-granted" });
  const outsider = await seedVerifiedUser({ username: "ohm-outsider" });
  const admin = await seedVerifiedUser({ username: "ohm-admin", isAdmin: true });
  const secmember = await seedVerifiedUser({ username: "ohm-secmember" });

  const orgs = new OrgService(env.DB);
  const ohmpub = await orgs.createOrg({
    name: "ohmpub",
    ownerId: owner.id,
    visibility: "public",
    fullName: "Ohm Public Forge",
    description: "Public ohm works.",
    location: "Ohmville",
    website: "https://ohm.example",
    email: "ohm@ohm.example",
    now: T0,
  });
  await orgs.addMember(ohmpub.id, member.id, { now: T0 });
  await orgs.addMember(ohmpub.id, granted.id, { now: T0 });

  const repoService = new RepoService(env.DB);
  const create = (ownerLower: string, ownerId: number, name: string, isPrivate: boolean) =>
    repoService.create({ owner: { id: ownerId, usernameLower: ownerLower }, name, isPrivate, status: "ready" });

  const alpha = await create("ohmpub", ohmpub.id, "alpha", false);
  const omega = await create("ohmpub", ohmpub.id, "omega-vault", true);
  const zeta = await create("ohmpub", ohmpub.id, "zeta-archive", false);
  for (let index = 0; index < 13; index += 1) {
    await create("ohmpub", ohmpub.id, `repo-${String(index).padStart(2, "0")}`, false);
  }

  // The row-shape carriers: alpha's batched description body, its open-pulls
  // subtraction (3 pulls − 1 closed → 2) and its Updated timestamp.
  await drizzle(env.DB).insert(repoSettings).values({ repoId: alpha.id, description: "The public workhorse." }).run();
  await drizzle(env.DB)
    .update(repositories)
    .set({ numPulls: 3, numClosedPulls: 1, updatedAt: new Date(T0) })
    .where(eq(repositories.id, alpha.id))
    .run();
  await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, zeta.id)).run();

  // The team arm: ohm-granted's read team covers exactly the private vault.
  const teamsService = new TeamsService(env.DB);
  const vaultCrew = await teamsService.createTeam(ohmpub, { name: "Vault Crew", permission: "read" });
  await teamsService.addTeamMember(vaultCrew, granted.id);
  await teamsService.addTeamRepo(vaultCrew, omega.id);

  // The private org: the public open-work (→ the Internal badge) + hidden-work.
  const ohmsec = await orgs.createOrg({ name: "ohmsec", ownerId: owner.id, visibility: "private", now: T0 });
  await orgs.addMember(ohmsec.id, secmember.id, { now: T0 });
  await create("ohmsec", ohmsec.id, "open-work", false);
  await create("ohmsec", ohmsec.id, "hidden-work", true);

  // The limited org: one public repo.
  const ohmlax = await orgs.createOrg({ name: "ohmlax", ownerId: owner.id, visibility: "limited", now: T0 });
  await create("ohmlax", ohmlax.id, "public-lax", false);

  // The bare org: display-case name, NO profile fields, NO repos.
  await orgs.createOrg({ name: "OhmCase", ownerId: owner.id, visibility: "public", now: T0 });

  // The rename pairs (the landed renameOrg arm writes the redirect rows).
  const oldPublic = await orgs.createOrg({
    name: "ohmoldpub",
    ownerId: owner.id,
    visibility: "public",
    fullName: "Renamed Public Forge",
    now: T0,
  });
  await orgs.renameOrg(oldPublic.id, "ohmnewpub", { now: T0 });
  const oldSecret = await orgs.createOrg({ name: "ohmoldsec", ownerId: owner.id, visibility: "private", now: T0 });
  await orgs.renameOrg(oldSecret.id, "ohmnewsec", { now: T0 });

  return {
    ownerId: owner.id,
    memberId: member.id,
    grantedId: granted.id,
    outsiderId: outsider.id,
    adminId: admin.id,
    secmemberId: secmember.id,
    ohmpub,
  };
}

// --- the mounted-route harness (the org-repos matrix pattern) -------------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → the owner-home
 *  handler's ORG half → load → render, on the mounted uiRouter with the
 *  synthetic manifest; the execution context is awaited so waitUntil
 *  side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A GET through the mount (`userId: null` is the anonymous arm). */
async function getRoute(path: string, userId: number | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (userId !== null) {
    headers.cookie = `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
  }
  return fetchUi(path, { headers });
}

// --- the visibility-gate continuation ---------------------------------------------

describe("the visibility-gate continuation through /{org}", () => {
  let world: OrgHomeWorld;

  beforeEach(async () => {
    world = await seedOrgHomeWorld();
  });

  it("404-shells the private org for the signed-in OUTSIDER too; admits member, owner, and site admin", async () => {
    // wave-6 owns the anonymous arm of this ladder; the signed-in stranger
    // folds into the SAME miss (membership is the only private-org key).
    const outsider = await getRoute("/ohmsec", world.outsiderId);
    expect(outsider.status).toBe(404);
    const shell = await outsider.text();
    expect(shell).toContain("status-page-error"); // the shell — indistinguishable from missing
    expect(shell).not.toContain("organization profile"); // existence never leaks
    expect(shell).not.toContain("open-work");

    // The admissions: a plain member's row alone (no role arm), the owner,
    // and the site admin (the isAdmin bypass).
    expect((await getRoute("/ohmsec", world.secmemberId)).status).toBe(200);
    expect((await getRoute("/ohmsec", world.ownerId)).status).toBe(200);
    const adminView = await getRoute("/ohmsec", world.adminId);
    expect(adminView.status).toBe(200);
    expect(await adminView.text()).toContain('href="/ohmsec/hidden-work"'); // the admin sees private rows
  });

  it("walks the limited org's full signed-in ladder with the full-class Limited badge", async () => {
    expect((await getRoute("/ohmlax", null)).status).toBe(404); // wave-6's arm, re-guarded per world
    for (const userId of [world.outsiderId, world.memberId, world.ownerId, world.adminId]) {
      const res = await getRoute("/ohmlax", userId);
      expect(res.status, String(userId)).toBe(200); // any authenticated viewer
      expect(await res.text(), String(userId)).toContain(
        'class="ui large basic horizontal label">Limited</span>',
      );
    }
  });

  it("renders NO visibility badge on the public org (exactly upstream)", async () => {
    const res = await getRoute("/ohmpub", null);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("ui large basic horizontal label");
  });
});

// --- the org-header shapes ---------------------------------------------------------

describe("the org-header shapes beyond wave-6's golden header", () => {
  let world: OrgHomeWorld;

  beforeEach(async () => {
    world = await seedOrgHomeWorld();
  });

  it("gates the EMAIL row behind signed-in-ness; the location and website rows stay public", async () => {
    // The upstream `{{if and .IsSigned .Org.Email}}` gate: the anonymous
    // document never carries the address, while the location span and the
    // website link (with its target/rel attributes) render for everyone.
    const anon = await getRoute("/ohmpub", null);
    expect(anon.status).toBe(200);
    const anonHtml = await anon.text();
    expect(anonHtml).not.toContain("ohm@ohm.example");
    expect(anonHtml).toContain("<span>Ohmville</span>");
    expect(anonHtml).toContain('target="_blank" rel="me" href="https://ohm.example"');

    // ANY signed-in viewer (even a stranger) reads the email row.
    const signed = await getRoute("/ohmpub", world.outsiderId);
    expect(signed.status).toBe(200);
    expect(await signed.text()).toContain('<a class="muted" href="mailto:ohm@ohm.example">ohm@ohm.example</a>');
  });

  it("falls back to the username for the display name and renders the bare header on a fieldless org", async () => {
    // OhmCase: fullName null → DisplayName() is the stored username; with
    // description/location/website/email all null the identity block keeps
    // only the name row — no render-content, and the optional-rows wrapper
    // renders EMPTY (upstream's always-present `<div>` around the
    // `{{if .Org.Location}}` / website / email arms).
    const res = await getRoute("/ohmcase", null);
    expect(res.status).toBe(200);
    const html = await res.text();
    const identity = (html.split('class="flex-relaxed-list tw-flex-1"')[1] ?? "").split("overflow-menu")[0];
    expect(html).toContain('<span class="tw-text-2xl">OhmCase</span>');
    expect(identity).not.toContain("render-content markup");
    expect(identity).toContain("<div></div>"); // the optional-rows wrapper is empty
    expect(identity).not.toContain("octicon-location");
    expect(identity).not.toContain("octicon-link");
    expect(identity).not.toContain("mailto:");
    // The repo-less org: the empty placeholder, no pager, and the
    // `{{if .RepoCount}}` label absent at zero.
    expect(html).toContain("No repositories yet.");
    expect(html).not.toContain("ui small label");
    expect(html).not.toContain("navigation_label");
  });

  it("resolves a mixed-case org name through the case-folded lookup, keeping the display case", async () => {
    // The parser keeps the raw segment; getOrgByUsername lowercases it, so
    // /OHMCASE renders the SAME org — display case preserved in the header
    // and in the link the reduced menu builds from the stored username.
    expect(handlesUiRoute("/OHMCASE")).toBe(true);
    const mixed = await getRoute("/OHMCASE", null);
    expect(mixed.status).toBe(200);
    const html = await mixed.text();
    expect(html).toContain("organization profile");
    expect(html).toContain('<span class="tw-text-2xl">OhmCase</span>');
    expect(html).toContain('href="/OhmCase"');
    // The canonical lowercase spelling answers identically.
    expect((await getRoute("/ohmcase", null)).status).toBe(200);
  });
});

// --- the repo-list shape through /{org} ---------------------------------------------

describe("the repo-list shape through /{org}", () => {
  let world: OrgHomeWorld;

  beforeEach(async () => {
    world = await seedOrgHomeWorld();
  });

  it("caps the anonymous list at exactly 15 public rows, pager-less at the cap", async () => {
    // 16 seeded, one private: the anonymous visible total is EXACTLY the
    // page cap — `more` is false, so no pager renders even though the owner
    // world has a second page.
    const res = await getRoute("/ohmpub", null);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.split('<div class="item">').length - 1).toBe(15);
    expect(html).not.toContain("navigation_label");
    // The tab count is the VISIBLE total (15, not 16).
    expect(html).toContain('<div class="ui small label">15</div>');
    // A public org's anonymous list wears no row badges at all.
    expect(html).not.toContain(">Private<");
    expect(html).not.toContain(">Internal<");
    expect(html).toContain('href="/ohmpub/zeta-archive"'); // the 15th public row is on page 1 here
  });

  it("renders the alpha row anatomy: description body, the open-pulls chip, the Updated line", async () => {
    const res = await getRoute("/ohmpub", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The batched repo_settings description…
    expect(html).toContain("The public workhorse.");
    // …and the pulls chip with the open subtraction (3 − 1 → 2) linked to
    // the live /pulls page.
    const alphaRow = html.split('href="/ohmpub/alpha"')[1] ?? "";
    expect(alphaRow).toContain('href="/ohmpub/alpha/pulls"');
    expect(alphaRow).toContain('aria-label="Pull Requests"');
    expect(alphaRow).toContain("<span>2</span>");
    // The Updated line rides the seeded timestamp through relative-time.
    expect(alphaRow).toContain("Updated");
    expect(alphaRow).toContain("<relative-time");
  });

  it("renders the 0/0 floor on a counter-less row and the Archived badge", async () => {
    const res = await getRoute("/ohmpub", null);
    expect(res.status).toBe(200);
    const html = await res.text();
    // zeta-archive is the LAST anonymous row, so the suffix slice is its own.
    const zetaRow = html.split('href="/ohmpub/zeta-archive"')[1] ?? "";
    expect(zetaRow).toContain(">Archived</span>");
    expect(zetaRow).toContain("<span>0</span>"); // 0 − 0 floors to 0, still rendered
  });

  it("badges the Internal row (a public repo under a private org) for the admitted plain member", async () => {
    const res = await getRoute("/ohmsec", world.secmemberId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/ohmsec/open-work"'); // the public row, member-visible
    expect(html).not.toContain('href="/ohmsec/hidden-work"'); // the private row: no covering team
    expect(html).toContain(">Internal</span>"); // upstream's Owner.Visibility.IsPrivate arm
    // The org-header Private badge (full class — distinct from a row badge).
    expect(html).toContain('class="ui large basic horizontal label">Private</span>');
  });

  it("admits the team-granted member to exactly the covered private row through /{org}", async () => {
    // The same §4.7 teamArm the org-repos matrix pins through the sibling
    // URL, proving the ORG HOME list rides it too: ohm-granted gains exactly
    // omega-vault (16 visible → the pager appears), ohm-member stays at the
    // 15 public rows.
    const granted = await getRoute("/ohmpub", world.grantedId);
    expect(granted.status).toBe(200);
    const grantedHtml = await granted.text();
    expect(grantedHtml).toContain('href="/ohmpub/omega-vault"');
    expect(grantedHtml).toContain(">Private</span>"); // the gained row's badge (a public org → no org badge)
    expect(grantedHtml).toContain('<div class="ui small label">16</div>');
    expect(grantedHtml).toContain("navigation_label");

    const plain = await getRoute("/ohmpub", world.memberId);
    expect(plain.status).toBe(200);
    const plainHtml = await plain.text();
    expect(plainHtml).not.toContain('href="/ohmpub/omega-vault"'); // the teamArm misses the plain member
    expect(plainHtml).not.toContain("navigation_label");
  });
});

// --- the pagination grammar through /{org} -------------------------------------------

describe("the pagination grammar through /{org}", () => {
  let world: OrgHomeWorld;

  beforeEach(async () => {
    world = await seedOrgHomeWorld();
  });

  it("splits the owner's 16 rows 15+1 with page 2's Newer folded onto the BARE org link", async () => {
    const page1 = await getRoute("/ohmpub", world.ownerId);
    expect(page1.status).toBe(200);
    const html1 = await page1.text();
    expect(html1).toContain('href="/ohmpub/alpha"'); // slug ASC: the first row
    expect(html1).not.toContain('href="/ohmpub/zeta-archive"'); // the 16th row
    expect(html1).toContain('<span class="navigation_label">Older</span>');
    expect(html1).toContain('href="/ohmpub?page=2"');
    expect(html1).not.toContain("Newer</span>"); // nothing older than page 1

    const page2 = await getRoute("/ohmpub?page=2", world.ownerId);
    expect(page2.status).toBe(200);
    const html2 = await page2.text();
    expect(html2).toContain('href="/ohmpub/zeta-archive"');
    expect(html2).not.toContain('href="/ohmpub/alpha"');
    // page == 2 folds the Newer href onto the BARE org link (no ?page=1).
    expect(html2).toContain('href="/ohmpub"><span class="navigation_label">Newer</span>');
    expect(html2).not.toContain("Older</span>"); // the split is exact: page 2 is the last
  });

  it("folds the junk, zero, and negative page params onto page 1", async () => {
    for (const query of ["?page=abc", "?page=0", "?page=-3"]) {
      const res = await getRoute(`/ohmpub${query}`, world.ownerId);
      expect(res.status, query).toBe(200);
      expect(await res.text(), query).toContain('href="/ohmpub/alpha"'); // page 1
    }
  });

  it("renders the beyond-end page as the zero-repo placeholder with the true count kept", async () => {
    const res = await getRoute("/ohmpub?page=9", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    // parsePageNumber clamps low but has no upper clamp — an out-of-range
    // page empties the listing, and the shared render answers with the
    // empty placeholder (the tab count still carries the true total).
    expect(html).toContain("No repositories yet.");
    expect(html).not.toContain("flex-divided-list");
    expect(html).not.toContain("navigation_label");
    expect(html).toContain('<div class="ui small label">16</div>');
  });

  it("keeps the pager anchors canonical under a ?tab= query (the tab never leaks)", async () => {
    // The org name ignores ?tab= (the user-profile matrix's arm); HERE the
    // pager side is pinned: the anchors are built from the bare org link,
    // so neither the Newer fold nor the Older link carries the tab.
    const res = await getRoute("/ohmpub?tab=activity&page=2", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("organization profile"); // still the org home
    expect(html).toContain('href="/ohmpub"><span class="navigation_label">Newer</span>');
    expect(html).not.toContain("?tab="); // no anchor carries the tab
  });
});

// --- the member-and-team strip non-rendering ------------------------------------------

describe("the member-and-team strip non-rendering (the documented v1 reduction)", () => {
  it("renders no sidebar, no create buttons, no view-as dropdown — even for the org owner", async () => {
    const world = await seedOrgHomeWorld();
    // The org HAS members and a team (seeded above), so upstream's
    // `ShowMemberAndTeamTab` arm WOULD render the five-wide column for this
    // viewer — the reduction keeps it out along with the create-repo /
    // migrate buttons and the members/teams links.
    const res = await getRoute("/ohmpub", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("five wide column");
    expect(html).not.toContain("repo/create?org=");
    expect(html).not.toContain("repo/migrate?org=");
    expect(html).not.toContain("view_as");
    expect(html).not.toContain('href="/ohmpub/members"');
    expect(html).not.toContain('href="/ohmpub/teams"');
  });
});

// --- the renamed-org seam through /{org} -----------------------------------------------

describe("the renamed-org seam through /{org}", () => {
  let world: OrgHomeWorld;

  beforeEach(async () => {
    world = await seedOrgHomeWorld();
  });

  it("307s the public rename with a multi-param query preserved; the target renders", async () => {
    const res = await getRoute("/ohmoldpub?x=1&y=2", null);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/ohmnewpub?x=1&y=2");
    // The target answers behind the new name with the org-home DOM.
    const target = await getRoute("/ohmnewpub", null);
    expect(target.status).toBe(200);
    expect(await target.text()).toContain("<title>Renamed Public Forge - cf-gitea</title>");
  });

  it("gates the private rename behind the coarse RedirectToUser arm: anonymous folds into the miss, ANY signed-in principal reads the 307", async () => {
    const anon = await getRoute("/ohmoldsec", null);
    expect(anon.status).toBe(404);
    expect(await anon.text()).toContain("status-page-error"); // indistinguishable from missing

    // "We must be signed in to see limited or private organizations"
    // (context_response.go:41–44) — the gate is signed-in-ness, not
    // membership, so even a stranger reads the redirect (upstream parity).
    const stranger = await getRoute("/ohmoldsec", world.outsiderId);
    expect(stranger.status).toBe(307);
    expect(stranger.headers.get("location")).toBe("/ohmnewsec");

    expect((await getRoute("/ohmoldsec", world.ownerId)).headers.get("location")).toBe("/ohmnewsec");
    // The new name itself keeps the private ladder: anonymous still misses.
    expect((await getRoute("/ohmnewsec", null)).status).toBe(404);
  });
});

// --- the fork/mirror glyph interplay + the private-org row-badge pair + the empty private org ---

/** The polish-wave block: the last unclaimed /{org} arms. The glyph arm
 *  seeds real fork/mirror edges; the badge-pair arm walks the owner's view of
 *  the private org; the posture arm stands up a repo-less private org. */
describe("the fork/mirror glyphs, the private-org row-badge pair, and the empty private org (the polish wave)", () => {
  let world: OrgHomeWorld;

  beforeEach(async () => {
    world = await seedOrgHomeWorld();
    // The fork + mirror edges on ohmpub (public, so both rows land on page 1
    // of the owner's slug-ASC list): fork_parent points at the source row,
    // is_mirror is the pull-mirror flag — exactly the D1 state upstream's
    // repo/icon.tmpl branches on ($.IsMirror / $.ForkID).
    const repoService = new RepoService(env.DB);
    const create = (name: string) =>
      repoService.create({
        owner: { id: world.ohmpub.id, usernameLower: "ohmpub" },
        name,
        isPrivate: false,
        status: "ready",
      });
    const source = await drizzle(env.DB)
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "ohmpub"), eq(repositories.slug, "alpha")))
      .get();
    const fork = await create("a-fork");
    const mirror = await create("a-mirror");
    await drizzle(env.DB)
      .update(repositories)
      .set({ forkParent: source?.id ?? fork.id })
      .where(eq(repositories.id, fork.id))
      .run();
    await drizzle(env.DB).update(repositories).set({ isMirror: true }).where(eq(repositories.id, mirror.id)).run();
  });

  it("renders the mirror/fork/plain glyphs per icon.tmpl's chain — mirror row octicon-mirror, fork row octicon-repo-forked, plain row octicon-repo", async () => {
    const res = await getRoute("/ohmpub", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Each `<div class="item">` chunk carries its own row's item-leading
    // glyph (rendered BEFORE the name link) + its own link.
    const chunks = html.split('<div class="item">');
    // Mirror first (icon.tmpl's `{{else if $.IsMirror}}` arm precedes the
    // fork arm — a hypothetical mirror+fork row would render the mirror
    // glyph): the mirror row's chunk carries octicon-mirror only.
    const mirrorRow = chunks.find((chunk) => chunk.includes('href="/ohmpub/a-mirror"'));
    expect(mirrorRow, "a-mirror").toBeDefined();
    expect(mirrorRow, "a-mirror").toContain('class="svg octicon-mirror"'); // the $.IsMirror arm
    expect(mirrorRow, "a-mirror").toContain('width="24"'); // repo/icon.tmpl's 24px slot
    expect(mirrorRow, "a-mirror").not.toContain("octicon-repo-forked");
    expect(mirrorRow, "a-mirror").not.toContain('class="svg octicon-repo"');
    // The fork row's chunk carries octicon-repo-forked only ($.IsFork).
    const forkRow = chunks.find((chunk) => chunk.includes('href="/ohmpub/a-fork"'));
    expect(forkRow, "a-fork").toBeDefined();
    expect(forkRow, "a-fork").toContain('class="svg octicon-repo-forked"'); // the $.IsFork arm
    expect(forkRow, "a-fork").toContain('width="24"'); // the same 24px slot
    expect(forkRow, "a-fork").not.toContain("octicon-mirror");
    expect(forkRow, "a-fork").not.toContain('class="svg octicon-repo"');
    // The plain row keeps the else arm (FLIPPED 2026-10-27: the earlier
    // characterization pinned the fallback glyph on fork/mirror rows and
    // flagged the divergence — OrgRepoListItem now ports icon.tmpl's
    // mirror → fork → plain branch, so the pins below hold the fixed
    // shape).
    const plainRow = chunks.find((chunk) => chunk.includes('href="/ohmpub/alpha"'));
    expect(plainRow, "alpha").toBeDefined();
    expect(plainRow, "alpha").toContain('class="svg octicon-repo"'); // the else arm
    expect(plainRow, "alpha").toContain('width="24"'); // the same 24px slot
    expect(plainRow, "alpha").not.toContain("octicon-mirror");
    expect(plainRow, "alpha").not.toContain("octicon-repo-forked");
  });

  it("shows a private org's owner BOTH row badges — Private on the hidden row, Internal on the public row", async () => {
    // The secmember view (above) only admits open-work; the owner's ladder
    // admits hidden-work too, exercising the badge branch order upstream's
    // list.tmpl pins: a repo's own private badge wins over the
    // Owner.Visibility.IsPrivate Internal arm.
    const res = await getRoute("/ohmsec", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    const chunks = html.split('<div class="item">');
    expect(chunks).toHaveLength(3); // the pre-row chrome + exactly two rows
    const hiddenRow = chunks[1] ?? "";
    const openRow = chunks[2] ?? "";
    expect(hiddenRow).toContain('href="/ohmsec/hidden-work"');
    expect(hiddenRow).toContain(">Private</span>"); // the row's own badge
    expect(hiddenRow).not.toContain(">Internal</span>"); // ...which preempts the Internal arm
    expect(openRow).toContain('href="/ohmsec/open-work"');
    expect(openRow).toContain(">Internal</span>"); // the public row under the private org
    expect(openRow).not.toContain(">Private</span>");
    // The org-header Private badge rides along (the full-class arm).
    expect(chunks[0]).toContain('class="ui large basic horizontal label">Private</span>');
  });

  it("postures the empty PRIVATE org: anonymous 404-shells it, the owner reads the empty placeholder", async () => {
    const orgs = new OrgService(env.DB);
    await orgs.createOrg({ name: "ohmvoid", ownerId: world.ownerId, visibility: "private", now: T0 });

    // Anonymous: the same indistinguishable miss as any invisible org.
    const anon = await getRoute("/ohmvoid", null);
    expect(anon.status).toBe(404);
    const shell = await anon.text();
    expect(shell).toContain("status-page-error");
    expect(shell).not.toContain("organization profile");

    // The owner: the page renders with the header badge and the placeholder
    // — the empty-org posture OhmCase pins for a PUBLIC org, held behind the
    // private gate, with no rows, no pager, and no count label at zero.
    const owner = await getRoute("/ohmvoid", world.ownerId);
    expect(owner.status).toBe(200);
    const html = await owner.text();
    expect(html).toContain("organization profile");
    expect(html).toContain('class="ui large basic horizontal label">Private</span>');
    expect(html).toContain("No repositories yet.");
    expect(html).not.toContain("flex-divided-list");
    expect(html).not.toContain("navigation_label");
    expect(html).not.toContain("ui small label");
  });
});

// --- the /{org} claim pin ----------------------------------------------------------------

describe("the /{org} claim pin (the trailing-slash fold onto the canonical org home)", () => {
  it("claims the single segment and 301s the trailing-slash form onto the canonical URL", async () => {
    const world = await seedOrgHomeWorld();
    expect(handlesUiRoute(`/${world.ohmpub.username}`)).toBe(true);

    // The slashed form is not a claim — the middleware folds it onto the
    // trimmed path (§4.13), and the canonical GET renders the org home.
    const slashed = await getRoute("/ohmpub/", null);
    expect(slashed.status).toBe(301);
    expect(slashed.headers.get("location")).toBe(`${ORIGIN}/ohmpub`);
    const canonical = await getRoute("/ohmpub", null);
    expect(canonical.status).toBe(200);
    expect(await canonical.text()).toContain("organization profile");
  });
});
