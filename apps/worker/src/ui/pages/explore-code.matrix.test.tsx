/**
 * The R02 explore code search page's matrix (pages/explore-code.tsx +
 * pages/code-search-federation.ts — SPEC-0019 M2, the census's R02 row over
 * the federation loader and the LANDED grep RPC). The route is NOT yet
 * mounted (ui/index.ts is the integrator sibling's file this window — the
 * module doc's HANDOFF carries the exact arms, and pages/explore.matrix.test.ts
 * pins /explore/code UNCLAIMED until then), so this matrix drives the REAL
 * production seam BELOW the router: loadExploreCodeSearchData →
 * renderExploreCodePage on the minted-ctx direct-render harness (the
 * user-code-search.matrix pattern), with REAL pushed content through the
 * receive flow (the repo-search.matrix seeding). The mount window re-arms
 * the route-level arms when the orchestrator lands the registration. The
 * file arms the mission's matrix:
 *
 *   - the INSTANCE seed (this milestone's new logic — the explore repos
 *     posture mirrored): the visibility ladder (anonymous = public rows of
 *     every owner; the owner sees their own private; a COLLABORATOR sees the
 *     granted private through the re-issued grant EXISTS arm; a SITE ADMIN
 *     is unfiltered — upstream code.go:55-66's isAdmin arm), the ratified
 *     seed order across OWNERS (`updated_unix DESC, id DESC`), the cap
 *     arithmetic through the loader (30 visible → 25 covered, overCap,
 *     totalVisible 30), the public-repo-under-private-owner reduction pin
 *     (the explore listing's own scope — PublicRepoUnderPublicOwnerCond is
 *     the alternative posture, not taken), and the empty-set arm;
 *   - the PAGE over engine-seeded fixtures across TWO owners: the bare
 *     form (q empty → search null — zero engine calls by construction,
 *     code.go:40-43's early return), the instance scope's point (the
 *     guest's union spans both owners' public repos while the private vault
 *     never surfaces), the per-repo truncation hoist (beta's 52-file
 *     answer → the counted message, repo-prefixed), the over-cap notice at
 *     a seeded 26th visible repo (§5.1 — "Searched the 25 most recently
 *     updated of 26 visible repositories."), the no-results arm over a
 *     zero-match union, the silent-skip arm over an empty-only instance,
 *     and the divergence pins (the mode select lists exactly exact|words —
 *     NO regexp —, no `?l=` input, no union pager);
 *   - the CHROME: `page-content explore users` (explore/code.tmpl:3's own
 *     template line) with the navbar's Code tab ACTIVE here and inert on
 *     the repos page;
 *   - the a11y smoke.
 *
 * The ratified disposition (§8 question 1) shipped the capped PAGE — there
 * is NO redirect arm to test (upstream's default-config 302 to /explore is
 * the recorded alternative we did not take, code.go:26-29).
 *
 * Fixture posture: per-test D1 wipe + idempotent re-seed (the
 * repo-search.matrix discipline), REAL packs through the receive flow for
 * the three content repos, direct D1 rows for the empty/padding fixtures
 * (pinned updatedAt — the seed order's determinism).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repoCollaborators, repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { runA11y } from "../__tests__/a11y";
import { federatedCodeSearch } from "./code-search-federation";
import { loadExploreReposData, renderExploreReposPage } from "./explore";
import {
  exploreCodeDoer,
  loadExploreCodeSearchData,
  loadExploreCodeSearchSeeds,
  renderExploreCodePage,
  type ExploreCodeDoer,
} from "./explore-code";
import { userCodeSearchLocale } from "./user-code-search";

// The engine-seeding hook pushes real packs through the receive flow
// (three content repos — the matrix suites' measured set).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// --- the direct-render harness (the user-code-search.matrix pattern) -----------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

function ctxFor(viewer: UiContext["viewer"]): UiContext {
  return { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };
}

const ANON_VIEWER: UiContext["viewer"] = { kind: "anonymous" };

/** The full production seam below the router: load → render. */
async function renderPage(viewer: UiContext["viewer"], query: string): Promise<string> {
  const data = await loadExploreCodeSearchData(env, env.DB, viewer, new URLSearchParams(query));
  return renderExploreCodePage(ctxFor(viewer), data);
}

/** The explore repos page (the chrome cross-check — the navbar's inert twin). */
async function renderReposPage(viewer: UiContext["viewer"], query: string): Promise<string> {
  const data = await loadExploreReposData(env.DB, viewer, new URLSearchParams(query));
  return renderExploreReposPage(ctxFor(viewer), data);
}

// --- fixtures -------------------------------------------------------------------

const OLD_TIME = new Date(1_577_836_800_000); // 2020-01-01 — the padding rows' pin

/** The content repos' pinned updatedAt values (all above OLD_TIME): the seed
 *  order is deterministic regardless of which arm of the seeding helper
 *  settled the row. */
const ALPHA_TIME = new Date(1_700_000_900_000);
const BETA_TIME = new Date(1_700_000_800_000);
const VAULT_TIME = new Date(1_700_000_700_000);

/** The content fixture: `needleword` discriminates the repos; beta's 52
 *  capword files arm the per-repo truncation hoist (the R10 counted arm).
 *  The repos span TWO owners — the instance scope's point. */
const ALPHA_COMMITS: SeedCommit[] = [
  {
    message: "alpha: fixture born",
    time: 1_700_000_000,
    files: [{ path: "readme.txt", content: "needleword on the alpha side\n" }],
  },
];
const BETA_COMMITS: SeedCommit[] = [
  {
    message: "beta: fixture born",
    time: 1_700_000_100,
    files: [
      { path: "notes.txt", content: "needleword on the beta side\n" },
      ...Array.from({ length: 52 }, (_v, i) => ({
        path: `many/m-${String(i).padStart(2, "0")}.txt`,
        content: "capword\n",
      })),
    ],
  },
];
const VAULT_COMMITS: SeedCommit[] = [
  {
    message: "vault: fixture born",
    time: 1_700_000_200,
    files: [{ path: "secret.txt", content: "needleword on the vault side\n" }],
  },
];

interface EccFixture {
  ownerA: { id: number; username: string; usernameLower: string };
  ownerB: { id: number; username: string; usernameLower: string };
}

/** The two owner rows (fresh per test — the wipe precedes every test;
 *  idempotent because some arms re-resolve them mid-test). */
async function seedOwners(): Promise<EccFixture> {
  const load = async (name: string) => {
    const row = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, name)).get();
    if (row === undefined) throw new Error(`${name} row missing`);
    return { id: row.id, username: row.username, usernameLower: row.usernameLower };
  };
  await seedVerifiedUser({ username: "ecc-owner" });
  await seedVerifiedUser({ username: "ecc-mate" });
  return { ownerA: await load("ecc-owner"), ownerB: await load("ecc-mate") };
}

/** The never-pushed public twin (the RepoService arm — grep answers null,
 *  the silent-skip arm). */
async function seedEmptyRepo(owner: { id: number; usernameLower: string }, slug: string): Promise<void> {
  await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: owner.usernameLower },
    name: slug,
    isPrivate: false,
    status: "ready",
  });
}

/** A D1-only padding row with a pinned id + updatedAt (the seed order's
 *  determinism: OLD_TIME sorts the pad rows below the freshly-settled real
 *  repos; the fixed TEXT ids make the id-DESC tiebreak deterministic). */
async function seedPaddingRepo(owner: { id: number; usernameLower: string }, slug: string): Promise<void> {
  const id = `eccpad-${slug}`;
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: owner.usernameLower,
    ownerId: owner.id,
    slug,
    visibility: "public",
    defaultBranch: "main",
    isEmpty: true,
    status: "ready",
    updatedAt: OLD_TIME,
  });
}

/** The private vault under owner B (direct D1 — the visibility ladder's
 *  private arm; content is pushed separately by the page fixtures). */
async function seedVaultRow(ownerB: { id: number; usernameLower: string }): Promise<void> {
  await drizzle(env.DB).insert(repositories).values({
    id: "ecc-vault",
    storageKey: "r_ecc-vault",
    ownerNamespace: ownerB.usernameLower,
    ownerId: ownerB.id,
    slug: "vault",
    visibility: "private",
    status: "ready",
    updatedAt: VAULT_TIME,
  });
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // FK order (the repo-search.matrix wipe).
  for (const table of [
    "release_assets",
    "releases",
    "webhook_deliveries",
    "webhooks",
    "repo_collaborators",
    "repo_settings",
    "issue_labels",
    "issue_pins",
    "comments",
    "pull_requests",
    "issues",
    "labels",
    "milestones",
    "repo_counters",
    "team_repo_access",
    "team_members",
    "teams",
    "org_members",
    "user_redirects",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the instance seed (the explore repos posture — M2's new logic) --------------

describe("the instance seed (SPEC-0019 §3.1 step 1's R02 arm)", () => {
  it("seeds the public rows of EVERY owner for anonymous (the instance scope)", async () => {
    const { ownerA, ownerB } = await seedOwners();
    await seedPaddingRepo(ownerA, "a-open");
    await seedPaddingRepo(ownerB, "b-open");
    const seeds = await loadExploreCodeSearchSeeds(env.DB, exploreCodeDoer(ANON_VIEWER));
    // same timestamp → the id DESC tiebreak runs the B row first
    expect(seeds.map((seed) => seed.slug)).toEqual(["b-open", "a-open"]);
    expect(seeds.map((seed) => seed.ownerNamespace)).toEqual(["ecc-mate", "ecc-owner"]);
  });

  it("orders by the ratified pair across owners (updated_unix DESC, id DESC)", async () => {
    const { ownerA, ownerB } = await seedOwners();
    await drizzle(env.DB).insert(repositories).values({
      id: "ecc-ord-b",
      storageKey: "r_ecc-ord-b",
      ownerNamespace: ownerB.usernameLower,
      ownerId: ownerB.id,
      slug: "ord-b",
      visibility: "public",
      status: "ready",
      updatedAt: new Date(1_700_000_500_000),
    });
    await drizzle(env.DB).insert(repositories).values({
      id: "ecc-ord-a",
      storageKey: "r_ecc-ord-a",
      ownerNamespace: ownerA.usernameLower,
      ownerId: ownerA.id,
      slug: "ord-a",
      visibility: "public",
      status: "ready",
      updatedAt: new Date(1_700_000_500_000),
    });
    await drizzle(env.DB).insert(repositories).values({
      id: "ecc-ord-old",
      storageKey: "r_ecc-ord-old",
      ownerNamespace: ownerA.usernameLower,
      ownerId: ownerA.id,
      slug: "ord-old",
      visibility: "public",
      status: "ready",
      updatedAt: new Date(1_690_000_000_000),
    });
    await drizzle(env.DB).insert(repositories).values({
      id: "ecc-ord-null",
      storageKey: "r_ecc-ord-null",
      ownerNamespace: ownerB.usernameLower,
      ownerId: ownerB.id,
      slug: "ord-null",
      visibility: "public",
      status: "ready",
      updatedAt: null,
    });
    const slugs = (await loadExploreCodeSearchSeeds(env.DB, exploreCodeDoer(ANON_VIEWER))).map((seed) => seed.slug);
    // the timestamp tie breaks by id DESC ("ecc-ord-b" > "ecc-ord-a");
    // NULL updatedAt sorts last under DESC
    expect(slugs).toEqual(["ord-b", "ord-a", "ord-old", "ord-null"]);
  });

  it("runs the visibility ladder: owner sees the private, a collaborator sees it through the grant, admin is unfiltered", async () => {
    const { ownerA, ownerB } = await seedOwners();
    await seedPaddingRepo(ownerA, "a-open");
    await seedVaultRow(ownerB);

    const anonSlugs = (await loadExploreCodeSearchSeeds(env.DB, exploreCodeDoer(ANON_VIEWER))).map((seed) => seed.slug);
    expect(anonSlugs).toEqual(["a-open"]); // the vault is absent for anonymous

    const ownerSlugs = (
      await loadExploreCodeSearchSeeds(env.DB, { id: ownerB.id, isAdmin: false, usernameLower: ownerB.usernameLower })
    ).map((seed) => seed.slug);
    expect(ownerSlugs).toEqual(["vault", "a-open"]); // B's own private sorts above OLD_TIME

    // The COLLABORATOR arm: a repo_collaborators row admits user A to B's
    // private vault (the re-issued grant EXISTS arm — upstream's
    // UserCollaborationRepoCond). The federation never dials an invisible
    // repo: the executor's seen set IS the seed set (§5.4).
    await drizzle(env.DB).insert(repoCollaborators).values({ repoId: "ecc-vault", userId: ownerA.id });
    const collabSeeds = await loadExploreCodeSearchSeeds(env.DB, {
      id: ownerA.id,
      isAdmin: false,
      usernameLower: ownerA.usernameLower,
    });
    expect(collabSeeds.map((seed) => seed.slug)).toEqual(["vault", "a-open"]);
    const seen: string[] = [];
    await federatedCodeSearch(collabSeeds, { q: "x", mode: "exact" }, (repoName) => {
      seen.push(repoName);
      return Promise.resolve(null);
    });
    expect(seen).toEqual(["ecc-mate/vault", "ecc-owner/a-open"]);

    // The ADMIN arm: unfiltered (code.go:55-66 — the search runs without a
    // repoIDs guard), including every owner's privates.
    const adminSlugs = (await loadExploreCodeSearchSeeds(env.DB, { id: 999_999, isAdmin: true, usernameLower: null })).map(
      (seed) => seed.slug,
    );
    expect(adminSlugs).toEqual(["vault", "a-open"]);
  });

  it("seeds a public repo under a private-visibility owner (the explore-listing parity — the recorded reduction)", async () => {
    // Upstream's PublicRepoUnderPublicOwnerCond (repo_list.go:755-763) would
    // narrow the anonymous set to genuinely-public pairs; the landed explore
    // repos posture lists a public repo under a private owner with the
    // Private badge instead, and this seed mirrors the listing (the module
    // header's recorded reduction: the code page is never narrower — nor
    // wider — than the instance's own discovery surface for the same viewer).
    const { ownerA } = await seedOwners();
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.usernameLower, "ecc-owner"));
    await seedPaddingRepo(ownerA, "under-private-owner");

    const anonSeeds = await loadExploreCodeSearchSeeds(env.DB, exploreCodeDoer(ANON_VIEWER));
    expect(anonSeeds.map((seed) => seed.slug)).toEqual(["under-private-owner"]);

    // the repos listing admits the same row for the same viewer (the parity
    // this seed is built on)
    const reposHtml = await renderReposPage(ANON_VIEWER, "q=under-private-owner");
    expect(reposHtml).toContain('href="/ecc-owner/under-private-owner"');
  });

  it("caps through the loader: 30 visible → 25 covered greps, overCap with the FULL count", async () => {
    const { ownerA } = await seedOwners();
    for (let i = 0; i < 30; i += 1) await seedPaddingRepo(ownerA, `p${String(i).padStart(2, "0")}`);
    const seeds = await loadExploreCodeSearchSeeds(env.DB, exploreCodeDoer(ANON_VIEWER));
    expect(seeds).toHaveLength(30);

    const seen: string[] = [];
    const answer = await federatedCodeSearch(seeds, { q: "x", mode: "words" }, (repoName) => {
      seen.push(repoName);
      return Promise.resolve(null);
    });
    expect(seen).toHaveLength(25); // exactly the cap — never more
    expect(answer.rows).toHaveLength(0);
    expect(answer.overCap).toBe(true);
    expect(answer.cap).toBe(25);
    expect(answer.totalVisible).toBe(30);
  });

  it("grows no seeds for an empty instance (the anonymous bare instance)", async () => {
    await seedOwners();
    const seeds = await loadExploreCodeSearchSeeds(env.DB, exploreCodeDoer(ANON_VIEWER));
    expect(seeds).toEqual([]);
    const answer = await federatedCodeSearch(seeds, { q: "x", mode: "words" }, () =>
      Promise.reject(new Error("no grep may run for an empty seed set")),
    );
    expect(answer).toMatchObject({ rows: [], matched: 0, scanned: 0, overCap: false, totalVisible: 0 });
  });
});

// --- the page over federated engine fixtures (two owners) -------------------------

/** Seed the two-owner content family: A's alpha (public) + gamma (never
 *  pushed, public); B's beta (public, 52 capword files) + the private vault
 *  (pushed). Pins updatedAt on the real rows (the seed order's determinism
 *  across the settle arms). */
async function seedContentFamily(): Promise<EccFixture> {
  const fixture = await seedOwners();
  await ensureSeededRepo({ owner: "ecc-owner", slug: "alpha", commits: ALPHA_COMMITS });
  await seedEmptyRepo(fixture.ownerA, "gamma");
  await ensureSeededRepo({ owner: "ecc-mate", slug: "beta", commits: BETA_COMMITS });
  await ensureSeededRepo({ owner: "ecc-mate", slug: "vault", commits: VAULT_COMMITS });
  await drizzle(env.DB)
    .update(repositories)
    .set({ visibility: "private", updatedAt: VAULT_TIME })
    .where(eq(repositories.slug, "vault"));
  await drizzle(env.DB).update(repositories).set({ updatedAt: ALPHA_TIME }).where(eq(repositories.slug, "alpha"));
  await drizzle(env.DB).update(repositories).set({ updatedAt: BETA_TIME }).where(eq(repositories.slug, "beta"));
  await drizzle(env.DB)
    .update(repositories)
    .set({ updatedAt: OLD_TIME })
    .where(eq(repositories.slug, "gamma"));
  return fixture;
}

describe("the R02 page over federated engine fixtures (two owners)", () => {
  it("the bare form renders with search === null (no seed read, no engine call — code.go:40-43)", async () => {
    await seedContentFamily();
    const html = await renderPage(ANON_VIEWER, "");
    expect(html).toContain('class="page-content explore users"'); // explore/code.tmpl:3's own class
    expect(html).toContain("Start a code search.");
    expect(html).toContain("Enter a keyword to search across the code.");
    // the always-on scan notice renders on the bare arm too
    expect(html).toContain(userCodeSearchLocale.by_scan);
    expect(html).not.toContain("repo-search-result");
    expect(html).not.toContain("No matching results found.");
    // the over-cap copy never renders on the bare arm
    expect(html).not.toContain("Searched the 25");
    // the navbar's Code tab is ACTIVE on this page
    expect(html).toContain('<a class="active item" href="/explore/code">');
  });

  it("the instance scope: the guest's union spans BOTH owners' public repos; the private vault never surfaces", async () => {
    await seedContentFamily();
    const html = await renderPage(ANON_VIEWER, "q=needleword");
    expect(html).toContain("ecc-owner/alpha");
    expect(html).toContain("ecc-mate/beta");
    expect(html).toContain('<a rel="nofollow" href="/ecc-owner/alpha">ecc-owner/alpha</a>');
    expect(html).toContain('<a rel="nofollow" href="/ecc-mate/beta">ecc-mate/beta</a>');
    expect(html).toContain("needleword on the alpha side");
    expect(html).toContain("needleword on the beta side");
    // the private + never-pushed twins never surface (visibility before the
    // fan-out; the null answer skipped silently)
    expect(html).not.toContain("ecc-mate/vault");
    expect(html).not.toContain("ecc-owner/gamma");
    expect(html).not.toContain("results may be partial");
  });

  it("the visibility ladder through the page: the owner and the collaborator see the vault, anonymous never does", async () => {
    const { ownerA } = await seedContentFamily();
    const mate = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "ecc-mate")).get();
    if (mate === undefined) throw new Error("ecc-mate row missing");
    const mateViewer: UiContext["viewer"] = {
      kind: "user",
      id: mate.id,
      username: mate.username,
      isAdmin: mate.isAdmin,
    };
    const own = await renderPage(mateViewer, "q=needleword");
    expect(own).toContain("ecc-mate/vault");
    expect(own).toContain("needleword on the vault side");

    // the COLLABORATOR arm: a repo_collaborators row admits owner A to B's
    // private vault — the grant EXISTS arm is the only door (the pushed
    // vault row's id is push-create's, resolved here)
    const vaultRow = await drizzle(env.DB)
      .select({ id: repositories.id })
      .from(repositories)
      .where(eq(repositories.slug, "vault"))
      .get();
    if (vaultRow === undefined) throw new Error("vault row missing");
    await drizzle(env.DB).insert(repoCollaborators).values({ repoId: vaultRow.id, userId: ownerA.id });
    const ownerRow = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "ecc-owner")).get();
    if (ownerRow === undefined) throw new Error("ecc-owner row missing");
    const collabHtml = await renderPage(
      { kind: "user", id: ownerRow.id, username: ownerRow.username, isAdmin: ownerRow.isAdmin },
      "q=needleword",
    );
    expect(collabHtml).toContain("ecc-mate/vault");

    const anon = await renderPage(ANON_VIEWER, "q=needleword");
    expect(anon).not.toContain("ecc-mate/vault");
  });

  it("the admin searches UNFILTERED (code.go:55-66's isAdmin arm)", async () => {
    await seedContentFamily();
    const admin = await seedVerifiedUser({ username: "ecc-admin", isAdmin: true });
    const html = await renderPage(
      { kind: "user", id: admin.id, username: admin.username, isAdmin: true },
      "q=needleword",
    );
    expect(html).toContain("ecc-mate/vault"); // someone else's private, no grant
    expect(html).toContain("ecc-owner/alpha");
  });

  it("a per-repo truncation hoists to the page-level notice (beta's 52-file answer)", async () => {
    await seedContentFamily();
    const html = await renderPage(ANON_VIEWER, "q=capword");
    // the counted arm, repo-prefixed, exactly once (alpha does not truncate —
    // the hoist names the truncated repo only)
    expect(html).toContain(
      "ecc-mate/beta: The search stopped at its result budget — showing the first 50 of 52 matching files.",
    );
    expect(html.split("The search stopped at its result budget").length - 1).toBe(1);
    // the covered answer still renders its 50 blocks
    expect(html.split("repo-search-result").length - 1).toBe(50);
    expect(html).not.toContain("ui borderless pagination menu"); // no union pager (§3.3 item 3)
  });

  it("the over-cap notice fires at a seeded 26th visible repo (§5.1 — never silent)", async () => {
    const { ownerA } = await seedContentFamily();
    // 23 public padding rows pin BELOW the freshly-settled real repos
    // (OLD_TIME updatedAt): 3 public reals + 23 padding = 26 visible for
    // anonymous — the covered 25 = alpha/beta/gamma-order top slice.
    for (let i = 0; i < 23; i += 1) await seedPaddingRepo(ownerA, `pad${String(i).padStart(2, "0")}`);
    const html = await renderPage(ANON_VIEWER, "q=needleword");
    expect(html).toContain("Searched the 25 most recently updated of 26 visible repositories.");
    // the covered real repos still render under the cap
    expect(html).toContain("ecc-owner/alpha");
    expect(html).toContain("ecc-mate/beta");
    // the padding repos answer null and stay silent (no cards, no notices)
    expect(html).not.toContain("ecc-owner/pad00");
  });

  it("the no-results arm renders upstream's line over a zero-match union", async () => {
    await seedContentFamily();
    const html = await renderPage(ANON_VIEWER, "q=zzz-no-such-word");
    expect(html).toContain("No matching results found.");
    expect(html).not.toContain("Start a code search.");
    expect(html).not.toContain("repo-search-result");
    expect(html).toContain(userCodeSearchLocale.by_scan);
  });

  it("an empty-only instance answers the clean no-results state (the silent skip, §5.5)", async () => {
    const { ownerA } = await seedOwners();
    await seedEmptyRepo(ownerA, "lonely");
    const html = await renderPage(ANON_VIEWER, "q=anything");
    // the empty repo's grep answered null and skipped silently — the page is
    // 200 with the no-results line (never a 404 off one dead repo)
    expect(html).toContain("No matching results found.");
    expect(html).not.toContain("repo-search-result");
  });

  it("the mode select lists exactly exact|words — no regexp, no ?l=, no pager (§3.3 pins)", async () => {
    await seedContentFamily();
    const html = await renderPage(ANON_VIEWER, "q=needleword");
    const exactAt = html.indexOf('<option value="exact"');
    const wordsAt = html.indexOf('<option value="words"');
    expect(exactAt).toBeGreaterThan(-1);
    expect(wordsAt).toBeGreaterThan(exactAt);
    expect(html).not.toContain('<option value="regexp"');
    // no language facet input (§3.3 item 2) and no pager (item 3)
    expect(html).not.toContain('name="l"');
    expect(html).not.toContain("ui borderless pagination menu");
    // the displayed-default quirk: no known mode → nothing selected (the
    // first option displays); a known mode echoes selected
    const words = await renderPage(ANON_VIEWER, "q=needleword&search_mode=words");
    expect(words).toContain('<option value="words" selected=""');
    expect(words).not.toContain('<option value="exact" selected=""');
  });

  it("the archived badge rides the federated card header (results.tmpl's arm)", async () => {
    await seedContentFamily();
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.slug, "alpha"));
    const html = await renderPage(ANON_VIEWER, "q=needleword");
    expect(html).toContain("Archived");
  });

  it("the navbar chrome: the Code tab is inert on the repos page, active here", async () => {
    await seedContentFamily();
    const reposHtml = await renderReposPage(ANON_VIEWER, "q=alpha");
    expect(reposHtml).toContain('<a class="active item" href="/explore/repos">');
    expect(reposHtml).toContain('<a class="item" href="/explore/code">'); // present, not active
    const codeHtml = await renderPage(ANON_VIEWER, "q=needleword");
    expect(codeHtml).toContain('<a class="active item" href="/explore/code">');
    expect(codeHtml).toContain('<a class="item" href="/explore/repos">'); // the strip's other items stay
  });
});

// --- the a11y smoke --------------------------------------------------------------

describe("explore-code a11y smoke", () => {
  it("the bare form and a results page pass the structural rules", async () => {
    await seedContentFamily();
    for (const query of ["", "q=needleword&search_mode=exact"]) {
      const html = await renderPage(ANON_VIEWER, query);
      const violations = runA11y(html);
      expect(violations, JSON.stringify(violations)).toEqual([]);
    }
  });
});

// --- the doer seam ---------------------------------------------------------------

describe("exploreCodeDoer (the viewer → seed-doer seam)", () => {
  it("maps anonymous to the null id and lowercases the user's login", () => {
    expect(exploreCodeDoer(ANON_VIEWER)).toEqual({ id: null, isAdmin: false, usernameLower: null } satisfies ExploreCodeDoer);
    expect(exploreCodeDoer({ kind: "user", id: 7, username: "MixedCase", isAdmin: true })).toEqual({
      id: 7,
      isAdmin: true,
      usernameLower: "mixedcase",
    });
  });
});
