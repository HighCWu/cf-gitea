/**
 * The ORG REPOSITORIES family's DEFERRED route-level matrix (the polish wave,
 * after the wave-23 mount — pages/org-repos.tsx over index.ts's
 * orgRepositoriesPage handler): the MINTED-SESSION route arms driven through
 * `uiRouter.fetch()` on the real production path (parse → resolveUiSession →
 * the resolveOrgRepositories ladder → load → render — the org-teams matrix's
 * pattern), one fresh org world per test behind per-test table wipes. The
 * shared-fixture suites keep the base arms and are NOT repeated here:
 * ui/__tests__/pages-wave23.test.ts owns the bare-shape parser claim, the
 * anonymous public-org list, the owner's private-row admission, the
 * plain-user/unknown-owner 404s, the unclaimed `/-` siblings and the a11y
 * smoke; pages-wave6.test.ts owns the SHARED org-home DOM through the
 * `/{org}` URL (the empty placeholder for a repo-less org, the 16-repo
 * pagination split, the public-profile header). THIS file adds the arms
 * neither suite carries:
 *
 *   - the dash-namespace grammar pins wave-23 never pinned: the
 *     trailing-slash form classifying as the claim and 301ing onto the
 *     canonical URL (query preserved), the middleware's slashed-404 fold
 *     carrying the unclaimed deep tail onto its trimmed form (which stays an
 *     engine-owned plain 404 — never the 404 shell), and the case-mismatched
 *     literal plus undecodable segments parsing to null;
 *   - the org-visibility gates through THIS URL (wave-23 seeded a public org
 *     only): the private org's anonymous/outsider 404 shells against the
 *     member/owner/site-admin admissions, and the limited org's
 *     anonymous-404/any-signed-in-200 ladder;
 *   - the §4.7 listing arms beyond wave-23's owner row: the plain member
 *     WITHOUT a covering team stays public-only, while the team-granted
 *     member gains exactly the covered private row (the service's teamArm
 *     SQL through the UI list) and the site admin rides the isAdmin bypass;
 *   - the repo-list shape beyond wave-23's href probes: the org-header
 *     visibility badge pair, the Internal badge (a public repo under a
 *     private org), the Archived/Private row badges, the batched
 *     repo_settings description body, the open-pulls counter chip (the
 *     num_pulls − num_closed_pulls subtraction), and the Repositories tab's
 *     visible-count label;
 *   - the pagination grammar at the landed 15-per-page cap: an exact-count
 *     page renders pager-less, the Older/Newer hrefs (page 2's Newer folds
 *     onto the BARE org link — no ?page=1), the junk/zero page folds, and
 *     the beyond-end page's zero-repo placeholder (parsePageNumber's
 *     documented no-upper-clamp arm);
 *   - the keyword facet's documented NON-landing: `?q=` neither narrows the
 *     list nor renders the shared/repo/search box (the org-home reduction);
 *   - the renamed-org 307 through this URL: a public rename answers
 *     anonymously with the first-occurrence rewrite and the query preserved,
 *     while a private rename's coarse RedirectToUser gate 404-shells the
 *     anonymous arm and 307s only the signed-in owner.
 *
 * The fixture world is `reposmx` (petra owner; milan a plain member; greta a
 * member granted the Vault Crew read team over the private vault; vera an
 * outsider; adminmx the site admin; sana a plain member of the private
 * `secretx`), seeded through the LANDED OrgService/TeamsService/RepoService
 * arms — ids are captured at seed time, never hardcoded.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TeamsService } from "../../api/routes/org-teams";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, repoSettings } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
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

/** The route world's REAL rows: the public `reposmx` org (16 owner-visible
 *  repos — alpha + the private omega-vault + the archived zeta-archive + 13
 *  bulk — exactly one over the 15-per-page cap), the private `secretx` (the
 *  Internal-badge carrier open-work + hidden-work), the limited `laxorg`,
 *  and the two rename pairs (public + private). */
interface ReposWorld {
  ownerId: number; // petra
  memberId: number; // milan — reposmx member, no team
  grantedId: number; // greta — reposmx member, Vault Crew over omega-vault
  outsiderId: number; // vera — no membership anywhere
  adminId: number; // adminmx — site admin
  secretxMemberId: number; // sana — plain member of the private org
  reposOrg: OrgRecord;
}

async function seedReposWorld(): Promise<ReposWorld> {
  const owner = await seedVerifiedUser({ username: "petra" });
  const member = await seedVerifiedUser({ username: "milan" });
  const granted = await seedVerifiedUser({ username: "greta" });
  const outsider = await seedVerifiedUser({ username: "vera" });
  const admin = await seedVerifiedUser({ username: "adminmx", isAdmin: true });
  const secretxMember = await seedVerifiedUser({ username: "sana" });

  const orgs = new OrgService(env.DB);
  const reposOrg = await orgs.createOrg({
    name: "reposmx",
    ownerId: owner.id,
    visibility: "public",
    fullName: "Repos Matrix Forge",
    now: T0,
  });
  await orgs.addMember(reposOrg.id, member.id, { now: T0 });
  await orgs.addMember(reposOrg.id, granted.id, { now: T0 });

  const repoService = new RepoService(env.DB);
  const create = (ownerLower: string, ownerId: number, name: string, isPrivate: boolean) =>
    repoService.create({ owner: { id: ownerId, usernameLower: ownerLower }, name, isPrivate, status: "ready" });

  const alpha = await create("reposmx", reposOrg.id, "alpha", false);
  const omega = await create("reposmx", reposOrg.id, "omega-vault", true);
  const zeta = await create("reposmx", reposOrg.id, "zeta-archive", false);
  for (let index = 0; index < 13; index += 1) {
    await create("reposmx", reposOrg.id, `repo-${String(index).padStart(2, "0")}`, false);
  }

  // The row-shape carriers: alpha's batched description body, its open-pulls
  // subtraction (3 pulls − 1 closed → 2) and Updated line, zeta's archive.
  await drizzle(env.DB).insert(repoSettings).values({ repoId: alpha.id, description: "The public workhorse." }).run();
  await drizzle(env.DB)
    .update(repositories)
    .set({ numPulls: 3, numClosedPulls: 1, updatedAt: new Date(T0) })
    .where(eq(repositories.id, alpha.id))
    .run();
  await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, zeta.id)).run();

  // The §4.7 team arm: greta's read team covers exactly the private vault.
  const teamsService = new TeamsService(env.DB);
  const vaultCrew = await teamsService.createTeam(reposOrg, { name: "Vault Crew", permission: "read" });
  await teamsService.addTeamMember(vaultCrew, granted.id);
  await teamsService.addTeamRepo(vaultCrew, omega.id);

  // The private org: the public open-work (→ the Internal badge) + hidden-work.
  const secretx = await orgs.createOrg({ name: "secretx", ownerId: owner.id, visibility: "private", now: T0 });
  await orgs.addMember(secretx.id, secretxMember.id, { now: T0 });
  await create("secretx", secretx.id, "open-work", false);
  await create("secretx", secretx.id, "hidden-work", true);

  // The limited org: one public repo.
  const laxorg = await orgs.createOrg({ name: "laxorg", ownerId: owner.id, visibility: "limited", now: T0 });
  await create("laxorg", laxorg.id, "public-lax", false);

  // The rename pairs (the landed renameOrg arm writes the redirect rows).
  const oldPublic = await orgs.createOrg({ name: "oldrepos", ownerId: owner.id, visibility: "public", now: T0 });
  await orgs.renameOrg(oldPublic.id, "newrepos", { now: T0 });
  const oldSecret = await orgs.createOrg({ name: "oldsecret", ownerId: owner.id, visibility: "private", now: T0 });
  await orgs.renameOrg(oldSecret.id, "newsecret", { now: T0 });

  return {
    ownerId: owner.id,
    memberId: member.id,
    grantedId: granted.id,
    outsiderId: outsider.id,
    adminId: admin.id,
    secretxMemberId: secretxMember.id,
    reposOrg,
  };
}

// --- the mounted-route harness (the org-teams matrix pattern) -------------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → the org-repositories
 *  prologue → load → render, on the mounted uiRouter with the synthetic
 *  manifest; the execution context is awaited so waitUntil side-effects
 *  settle before assertions. */
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

// --- the dash-namespace claim pins ----------------------------------------------

describe("the dash-namespace grammar pins (the folds wave-23 never pinned)", () => {
  it("classifies the trailing-slash form as the claim and leaves the junk carriers engine-owned", () => {
    expect(parseUiRoute("/acme/-/repositories/")).toEqual({ family: "org-repositories", owner: "acme" });
    // A deep tail is NOT the family — no project/repo grammar reads under it.
    expect(parseUiRoute("/acme/-/repositories/extra")).toBeNull();
    // The tail literal is case-sensitive (raw[3] === "repositories").
    expect(parseUiRoute("/acme/-/Repositories")).toBeNull();
    // Undecodable segments are not ours (the parser's per-segment decode).
    expect(parseUiRoute("/acme/-/%zz")).toBeNull();
    expect(parseUiRoute("/acme/-/repositories/%zz")).toBeNull();
    expect(handlesUiRoute("/acme/-/repositories/")).toBe(true);
    expect(handlesUiRoute("/acme/-/repositories/extra")).toBe(false);
    expect(handlesUiRoute("/acme/-/code")).toBe(false); // the unclaimed survey tail
  });

  it("301s the trailing-slash GET onto the canonical URL with the query preserved", async () => {
    await seedReposWorld();
    const res = await getRoute("/reposmx/-/repositories/?page=2", null);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/reposmx/-/repositories?page=2`);
  });

  it("301s every slashed 404 onto its trimmed form; the trimmed deep tail stays a plain engine 404", async () => {
    await seedReposWorld();
    // The middleware answers any trailing-slash 404 (GET/HEAD) with the 301
    // onto the trimmed path — claimed or not.
    const slashed = await getRoute("/reposmx/-/repositories/extra/", null);
    expect(slashed.status).toBe(301);
    expect(slashed.headers.get("location")).toBe(`${ORIGIN}/reposmx/-/repositories/extra`);
    // The trimmed deep tail is UNCLAIMED → the plain engine 404 — never the
    // shell, never the org-home DOM.
    const tail = await getRoute("/reposmx/-/repositories/extra", null);
    expect(tail.status).toBe(404);
    const html = await tail.text();
    expect(html).not.toContain("status-page-error");
    expect(html).not.toContain("organization profile");
  });
});

// --- the org-visibility gates -----------------------------------------------------

describe("the org-visibility gates through /{org}/-/repositories", () => {
  let world: ReposWorld;

  beforeEach(async () => {
    world = await seedReposWorld();
  });

  it("404-shells an invisible private org for anonymous and outsider; admits member, owner, and site admin", async () => {
    for (const userId of [null, world.outsiderId]) {
      const res = await getRoute("/secretx/-/repositories", userId);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain("status-page-error"); // the shell — indistinguishable from missing
      expect(html).not.toContain("organization profile"); // existence never leaks
      expect(html).not.toContain("secretx/open-work");
    }
    // The membership arm: a plain member's row alone admits the page (the
    // membership test is row-existence, no role arm).
    expect((await getRoute("/secretx/-/repositories", world.secretxMemberId)).status).toBe(200);
    expect((await getRoute("/secretx/-/repositories", world.ownerId)).status).toBe(200);
    expect((await getRoute("/secretx/-/repositories", world.adminId)).status).toBe(200);
  });

  it("gates the limited org: anonymous 404, any signed-in viewer 200 with the Limited header badge", async () => {
    const anon = await getRoute("/laxorg/-/repositories", null);
    expect(anon.status).toBe(404);
    expect(await anon.text()).toContain("status-page-error");

    const authed = await getRoute("/laxorg/-/repositories", world.outsiderId);
    expect(authed.status).toBe(200);
    const html = await authed.text();
    expect(html).toContain('class="ui large basic horizontal label">Limited</span>');
    expect(html).toContain('href="/laxorg/public-lax"');
  });
});

// --- the §4.7 listing arms --------------------------------------------------------

describe("the §4.7 listing arms beyond wave-23's owner row", () => {
  let world: ReposWorld;

  beforeEach(async () => {
    world = await seedReposWorld();
  });

  it("a plain member without a covering team stays public-only at the exact page cap", async () => {
    const res = await getRoute("/reposmx/-/repositories", world.memberId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/reposmx/alpha"');
    expect(html).not.toContain('href="/reposmx/omega-vault"'); // the teamArm misses milan
    // 15 public rows exactly: the tab count is the VISIBLE total and the
    // pager never appears (page * size < total is false at the cap).
    expect(html).toContain('<div class="ui small label">15</div>');
    expect(html).not.toContain("navigation_label");
  });

  it("the team-granted member gains exactly the covered private row", async () => {
    const res = await getRoute("/reposmx/-/repositories", world.grantedId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/reposmx/omega-vault"'); // the Vault Crew grant
    expect(html).toContain(">Private</span>"); // the gained row's badge (a public org → no org badge)
    // The total grew to 16: the count label and the Older link appear.
    expect(html).toContain('<div class="ui small label">16</div>');
    expect(html).toContain("navigation_label");
  });

  it("the site admin sees the private rows (the isAdmin bypass)", async () => {
    const res = await getRoute("/reposmx/-/repositories", world.adminId);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/reposmx/omega-vault"');
  });
});

// --- the repo-list shape ----------------------------------------------------------

describe("the repo-list shape (the DOM arms wave-23's href probes never pinned)", () => {
  let world: ReposWorld;

  beforeEach(async () => {
    world = await seedReposWorld();
  });

  it("renders the row anatomy for the owner: badges, the description body, the open-pulls chip, the Updated line", async () => {
    const res = await getRoute("/reposmx/-/repositories", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content organization profile"');
    // 15 rows on page 1 (16 total, slug ASC).
    expect(html.split('<div class="item">').length - 1).toBe(15);
    // alpha's body: the batched repo_settings description…
    expect(html).toContain("The public workhorse.");
    // …and the pulls chip with the open subtraction (3 − 1 → 2).
    const alphaRow = html.split('href="/reposmx/alpha"')[1] ?? "";
    expect(alphaRow).toContain('href="/reposmx/alpha/pulls"');
    expect(alphaRow).toContain("<span>2</span>");
    expect(alphaRow).toContain('aria-label="Pull Requests"');
    // The Updated line rides the seeded timestamp (absent rows stay silent).
    expect(html).toContain("Updated");
  });

  it("badges the Internal row (a public repo under a private org) for an admitted plain member", async () => {
    const res = await getRoute("/secretx/-/repositories", world.secretxMemberId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/secretx/open-work"'); // the public row, member-visible
    expect(html).not.toContain('href="/secretx/hidden-work"'); // the private row: no covering team
    expect(html).toContain(">Internal</span>"); // upstream's Owner.Visibility.IsPrivate arm
    // The org-header Private badge (full class — distinct from a row badge).
    expect(html).toContain('class="ui large basic horizontal label">Private</span>');
  });

  it("renders the Archived badge on the lone second-page row", async () => {
    const res = await getRoute("/reposmx/-/repositories?page=2", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/reposmx/zeta-archive"');
    expect(html).toContain(">Archived</span>");
  });
});

// --- the pagination grammar -------------------------------------------------------

describe("the pagination grammar at the landed 15-per-page cap", () => {
  let world: ReposWorld;

  beforeEach(async () => {
    world = await seedReposWorld();
  });

  it("splits the 16 owner-visible rows 15+1 with the Older/Newer hrefs (page 2's Newer is the bare org link)", async () => {
    const page1 = await getRoute("/reposmx/-/repositories", world.ownerId);
    expect(page1.status).toBe(200);
    const html1 = await page1.text();
    expect(html1).toContain('href="/reposmx/alpha"'); // slug ASC: the first row
    expect(html1).not.toContain('href="/reposmx/zeta-archive"'); // the 16th row
    expect(html1).toContain('<span class="navigation_label">Older</span>');
    expect(html1).toContain('href="/reposmx?page=2"');
    expect(html1).not.toContain("Newer</span>"); // nothing older than page 1

    const page2 = await getRoute("/reposmx/-/repositories?page=2", world.ownerId);
    expect(page2.status).toBe(200);
    const html2 = await page2.text();
    expect(html2).toContain('href="/reposmx/zeta-archive"');
    expect(html2).not.toContain('href="/reposmx/alpha"');
    // page == 2 folds the Newer href onto the BARE org link (no ?page=1).
    expect(html2).toContain('href="/reposmx"><span class="navigation_label">Newer</span>');
    expect(html2).not.toContain("Older</span>"); // the split is exact: page 2 is the last
  });

  it("folds the junk and zero page params onto page 1", async () => {
    for (const query of ["?page=abc", "?page=0", "?page=-3"]) {
      const res = await getRoute(`/reposmx/-/repositories${query}`, world.ownerId);
      expect(res.status, query).toBe(200);
      expect(await res.text(), query).toContain('href="/reposmx/alpha"'); // page 1
    }
  });

  it("renders the beyond-end page as the zero-repo placeholder with no pager (the no-upper-clamp arm)", async () => {
    const res = await getRoute("/reposmx/-/repositories?page=9", world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    // parsePageNumber clamps low but has no upper clamp — an out-of-range
    // page empties the listing, and the shared org-home render answers with
    // the empty placeholder (the tab count still carries the true total).
    expect(html).toContain("No repositories yet.");
    expect(html).not.toContain("flex-divided-list");
    expect(html).not.toContain("navigation_label");
    expect(html).toContain('<div class="ui small label">16</div>');
  });
});

// --- the keyword facet's documented non-landing ------------------------------------

describe("the keyword facet's documented non-landing", () => {
  it("ignores ?q=: the list stays unnarrowed and no search box renders", async () => {
    await seedReposWorld();
    const res = await getRoute("/reposmx/-/repositories?q=alpha", null);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The anonymous-visible list is UNNARROWED — every public row renders.
    expect(html).toContain('href="/reposmx/alpha"');
    expect(html).toContain('href="/reposmx/zeta-archive"');
    // The shared/repo/search box is one of the org-home's documented
    // reductions: no q input anywhere in the document.
    expect(html).not.toContain('name="q"');
    // A miss-matching keyword is equally inert (no empty arm, no miss text).
    const miss = await getRoute("/reposmx/-/repositories?q=zzz-not-a-repo", null);
    expect(miss.status).toBe(200);
    expect(await miss.text()).toContain('href="/reposmx/alpha"');
  });
});

// --- the renamed-org seam -----------------------------------------------------------

describe("the renamed-org seam through this URL", () => {
  let world: ReposWorld;

  beforeEach(async () => {
    world = await seedReposWorld();
  });

  it("307s the public rename anonymously — first-occurrence rewrite, query preserved", async () => {
    const res = await getRoute("/oldrepos/-/repositories?page=2", null);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/newrepos/-/repositories?page=2");
    // The target answers behind the new name.
    expect((await getRoute("/newrepos/-/repositories", null)).status).toBe(200);
  });

  it("gates a private rename behind the coarse RedirectToUser arm: the anonymous arm reads a miss, the owner reads the 307", async () => {
    const anon = await getRoute("/oldsecret/-/repositories", null);
    expect(anon.status).toBe(404);
    expect(await anon.text()).toContain("status-page-error"); // indistinguishable from missing

    const owner = await getRoute("/oldsecret/-/repositories", world.ownerId);
    expect(owner.status).toBe(307);
    expect(owner.headers.get("location")).toBe("/newsecret/-/repositories");
  });
});
