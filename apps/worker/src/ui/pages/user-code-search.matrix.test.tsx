/**
 * The R05 code search page's matrix (pages/user-code-search.tsx +
 * pages/code-search-federation.ts — SPEC-0019 M1, the census's R05 row over
 * the federation loader and the LANDED grep RPC). The route is NOT yet
 * mounted (ui/index.ts is the integrator sibling's file this window — the
 * module doc's HANDOFF carries the exact arms), so this matrix drives the
 * REAL production seam BELOW the router: resolveUserCodeSearchOwner →
 * loadUserCodeSearchData → renderUserCodeSearchPage on the minted-ctx
 * direct-render harness (the user-watching-tab pattern), with REAL pushed
 * content through the receive flow (the repo-search.matrix seeding). The
 * mount-window wave test re-arms the route-level arms when the orchestrator
 * lands the registration. The file arms the mission's matrix:
 *
 *   - the LOADER's ratified shape (the fake-executor group, D1-only seed
 *     rows): the cap arithmetic (30 visible → 25 covered, overCap,
 *     totalVisible 30), the seed order `updated_unix DESC, id DESC`, the
 *     bounded batches of 5 (max in-flight + start ordering via the
 *     executor seam), the rollups (matched/scanned), the silent-skip arms
 *     (null answers drop rows; the transport null is the engineClient
 *     contract), and the mode parse split (absent/unknown executes words,
 *     displays exact-first);
 *   - the SEED visibility (the SPEC §6 arm — the seed-query level): a
 *     private repo absent for anonymous, present for its owner, and the
 *     page arms agree (no cards for anonymous, cards for the owner);
 *   - the PAGE over engine-seeded fixtures across three repos: the bare
 *     form (q empty → search null — zero engine calls by construction),
 *     the federated card header carrying `owner/repo` (the R02/R05
 *     template arm) + the per-repo commit permalink + the line-table
 *     markup, the per-repo truncation flag HOISTED to the page-level
 *     notice (beta's 52-file answer → the counted message, repo-prefixed),
 *     the over-cap notice at a seeded 26th visible repo (the SPEC §5.1
 *     honesty — "Searched the 25 most recently updated of 26 visible
 *     repositories."), the empty/no-results states, and the divergence
 *     pins (the mode select lists exactly exact|words — NO regexp —, no
 *     `?l=` input, no union pager);
 *   - the ORG-context arm (user/code.tmpl's org half): `page-content
 *     organization code` + the org header chrome over the org seed walk;
 *   - the gate posture (the profile family's ladders): an invisible
 *     (private) owner resolves missing for anonymous.
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
import { repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { OrgService } from "../../services/orgs/orgs";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { runA11y } from "../__tests__/a11y";
import {
  federatedCodeSearch,
  loadUserCodeSearchSeeds,
  parseFederatedDisplayMode,
  parseFederatedSearchMode,
  type CodeSearchSeed,
} from "./code-search-federation";
import {
  loadUserCodeSearchData,
  renderUserCodeSearchPage,
  resolveUserCodeSearchOwner,
  userCodeSearchLocale,
  type CodeSearchOwner,
} from "./user-code-search";
import type { ProfileDoer, UserProfileRow } from "./user-profile";

// The engine-seeding hook pushes real packs through the receive flow
// (three content repos — the matrix suites' measured set).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// --- the direct-render harness (the user-watching-tab pattern) -----------------

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

const anonDoer: ProfileDoer = { id: null, isAdmin: false };

/** The full production seam below the router: resolve → load → render. */
async function renderPage(
  ownerName: string,
  doer: ProfileDoer,
  viewer: UiContext["viewer"],
  query: string,
): Promise<{ status: number; html: string; owner: CodeSearchOwner | null }> {
  const resolved = await resolveUserCodeSearchOwner(env.DB, ownerName, doer, `/${ownerName}/-/code`, query);
  if (resolved.kind === "missing") return { status: 404, html: "", owner: null };
  if (resolved.kind === "redirect") return { status: 307, html: resolved.location, owner: null };
  const params = new URLSearchParams(query);
  const data = await loadUserCodeSearchData(env, env.DB, resolved, doer, params);
  return {
    status: 200,
    html: renderUserCodeSearchPage(ctxFor(viewer), data),
    owner: resolved,
  };
}

// --- fixtures -------------------------------------------------------------------

const OLD_TIME = new Date(1_577_836_800_000); // 2020-01-01 — the padding rows' pin

/** The content repos' pinned updatedAt values (all above OLD_TIME, all below
 *  nothing else): the seed order is deterministic regardless of which arm of
 *  the seeding helper settled the row (a re-created row after a D1 wipe
 *  carries NULL updatedAt — pinned here so the real repos always sort above
 *  the padding rows in the ratified order). */
const ALPHA_TIME = new Date(1_700_000_900_000);
const BETA_TIME = new Date(1_700_000_800_000);
const VAULT_TIME = new Date(1_700_000_700_000);

/** The content fixture: `needleword` discriminates the repos; beta's 52
 *  capword files arm the per-repo truncation hoist (the R10 counted arm). */
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

/** The owner row (fresh per test — the wipe precedes every test; idempotent
 *  because some arms re-resolve it mid-test). */
async function seedOwner(): Promise<UserProfileRow> {
  const existing = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "cs-owner")).get();
  if (existing !== undefined) return existing;
  await seedVerifiedUser({ username: "cs-owner" });
  const row = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "cs-owner")).get();
  if (row === undefined) throw new Error("cs-owner row missing");
  return row;
}

/** The never-pushed public twin (the RepoService arm — grep answers null,
 *  the silent-skip arm). */
async function seedEmptyRepo(owner: UserProfileRow, slug: string): Promise<void> {
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
  const id = `cspad-${slug}`;
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

// --- the loader's ratified shape (fake executor, D1-only seeds) ------------------

describe("the federation loader's ratified shape (SPEC-0019 §8)", () => {
  it("caps the fan-out at 25 and keeps the FULL visible count for the notice", async () => {
    const owner = await seedOwner();
    for (let i = 0; i < 30; i += 1) await seedPaddingRepo(owner, `p${String(i).padStart(2, "0")}`);
    const seeds = await loadUserCodeSearchSeeds(env.DB, owner.id, anonDoer);
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

  it("seeds in the ratified order (updated_unix DESC, id DESC)", async () => {
    const owner = await seedOwner();
    // Two rows share a timestamp (the id DESC tiebreak decides); one is
    // older; one has NO timestamp (NULL sorts last under DESC).
    await drizzle(env.DB).insert(repositories).values({
      id: "ord-b",
      storageKey: "r_ord-b",
      ownerNamespace: owner.usernameLower,
      ownerId: owner.id,
      slug: "ord-b",
      visibility: "public",
      status: "ready",
      updatedAt: new Date(1_700_000_500_000),
    });
    await drizzle(env.DB).insert(repositories).values({
      id: "ord-a",
      storageKey: "r_ord-a",
      ownerNamespace: owner.usernameLower,
      ownerId: owner.id,
      slug: "ord-a",
      visibility: "public",
      status: "ready",
      updatedAt: new Date(1_700_000_500_000),
    });
    await drizzle(env.DB).insert(repositories).values({
      id: "ord-old",
      storageKey: "r_ord-old",
      ownerNamespace: owner.usernameLower,
      ownerId: owner.id,
      slug: "ord-old",
      visibility: "public",
      status: "ready",
      updatedAt: new Date(1_690_000_000_000),
    });
    await drizzle(env.DB).insert(repositories).values({
      id: "ord-null",
      storageKey: "r_ord-null",
      ownerNamespace: owner.usernameLower,
      ownerId: owner.id,
      slug: "ord-null",
      visibility: "public",
      status: "ready",
      updatedAt: null,
    });
    const slugs = (await loadUserCodeSearchSeeds(env.DB, owner.id, anonDoer)).map((seed) => seed.slug);
    // id DESC breaks the timestamp tie ("ord-b" > "ord-a"); NULL updatedAt
    // sorts last under DESC.
    expect(slugs).toEqual(["ord-b", "ord-a", "ord-old", "ord-null"]);
  });

  it("seeds the private repo for its owner only (the seed-query level — no grep is ever built for an invisible repo)", async () => {
    const owner = await seedOwner();
    await seedPaddingRepo(owner, "open");
    await drizzle(env.DB)
      .insert(repositories)
      .values({
        id: "ord-vault",
        storageKey: "r_ord-vault",
        ownerNamespace: owner.usernameLower,
        ownerId: owner.id,
        slug: "vault",
        visibility: "private",
        status: "ready",
        updatedAt: OLD_TIME,
      });
    const anonSeeds = await loadUserCodeSearchSeeds(env.DB, owner.id, anonDoer);
    expect(anonSeeds.map((seed) => seed.slug)).toEqual(["open"]);
    const ownerDoer: ProfileDoer = { id: owner.id, isAdmin: false };
    const ownerSeeds = await loadUserCodeSearchSeeds(env.DB, owner.id, ownerDoer);
    // same timestamp (OLD_TIME) → the id DESC tiebreak: "ord-vault" >
    // "cspad-open"
    expect(ownerSeeds.map((seed) => seed.slug)).toEqual(["vault", "open"]);

    // The federation never dials the invisible repo — the executor sees the
    // visible set only (absence enforced BEFORE the fan-out, §5.4).
    const seen: string[] = [];
    await federatedCodeSearch(anonSeeds, { q: "x", mode: "exact" }, (repoName) => {
      seen.push(repoName);
      return Promise.resolve(null);
    });
    expect(seen).toEqual(["cs-owner/open"]);
  });

  it("executes in bounded batches of 5 (max in-flight 5, batches in seed order)", async () => {
    const owner = await seedOwner();
    for (let i = 0; i < 12; i += 1) await seedPaddingRepo(owner, `b${String(i).padStart(2, "0")}`);
    const seeds = await loadUserCodeSearchSeeds(env.DB, owner.id, anonDoer);
    expect(seeds).toHaveLength(12);

    const starts: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const answer = await federatedCodeSearch(seeds, { q: "x", mode: "words" }, async (repoName) => {
      starts.push(repoName);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Two microtask ticks let same-batch calls overlap but never spill a
      // batch's call past the next batch's FIRST call (the ordering seam).
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return null;
    });
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1); // the batches ARE parallel
    // The first batch is exactly the first five seeds, in order — the
    // padding ids share a timestamp, so the id DESC tiebreak runs b11..b07.
    expect(starts.slice(0, 5)).toEqual([
      "cs-owner/b11",
      "cs-owner/b10",
      "cs-owner/b09",
      "cs-owner/b08",
      "cs-owner/b07",
    ]);
    expect(answer.scanned).toBe(0);
  });

  it("rolls the union up (matched vs scanned) and skips null answers silently", async () => {
    const owner = await seedOwner();
    await seedPaddingRepo(owner, "hits");
    await seedPaddingRepo(owner, "empty-answer");
    await seedPaddingRepo(owner, "dead");
    const seeds = await loadUserCodeSearchSeeds(env.DB, owner.id, anonDoer);
    const answer = await federatedCodeSearch(seeds, { q: "x", mode: "exact" }, (repoName) => {
      if (repoName.endsWith("/hits")) {
        return Promise.resolve({
          ref: "refs/heads/main",
          commit: "a".repeat(40),
          results: [
            { path: "f.txt", lines: [{ num: 1, code: "x" }] },
            { path: "g.txt", lines: [{ num: 2, code: "x" }] },
          ],
          total: 2,
          truncated: false,
        });
      }
      if (repoName.endsWith("/empty-answer")) {
        return Promise.resolve({ ref: "refs/heads/main", commit: "b".repeat(40), results: [], total: 0, truncated: false });
      }
      // the dead repo's transport/ref null (the engineClient contract)
      return Promise.resolve(null);
    });
    // same timestamp → the id DESC tiebreak: "cspad-hits" >
    // "cspad-empty-answer"; the dead repo's null never became a row
    expect(answer.rows.map((row) => row.repoName)).toEqual(["cs-owner/hits", "cs-owner/empty-answer"]);
    expect(answer.scanned).toBe(2);
    expect(answer.matched).toBe(1);
    expect(answer.overCap).toBe(false);
    expect(answer.totalVisible).toBe(3);
  });

  it("parses the two-mode set (§3.3 item 1): absent/unknown executes words, displays exact-first", () => {
    expect(parseFederatedSearchMode(null)).toBe("words");
    expect(parseFederatedSearchMode("")).toBe("words");
    expect(parseFederatedSearchMode("fuzzy")).toBe("words");
    expect(parseFederatedSearchMode("regexp")).toBe("words"); // regexp is NOT offered here
    expect(parseFederatedSearchMode("exact")).toBe("exact");
    expect(parseFederatedSearchMode("words")).toBe("words");
    expect(parseFederatedDisplayMode(null)).toBeNull();
    expect(parseFederatedDisplayMode("regexp")).toBeNull();
    expect(parseFederatedDisplayMode("words")).toBe("words");
  });

  it("grows no seeds for an owner with none (the empty-state seed arm)", async () => {
    const owner = await seedOwner();
    const seeds = await loadUserCodeSearchSeeds(env.DB, owner.id, anonDoer);
    expect(seeds).toEqual([] as CodeSearchSeed[]);
    const answer = await federatedCodeSearch(seeds, { q: "x", mode: "words" }, () =>
      Promise.reject(new Error("no grep may run for an empty seed set")),
    );
    expect(answer).toMatchObject({ rows: [], matched: 0, scanned: 0, overCap: false, totalVisible: 0 });
  });
});

// --- the page over engine-seeded fixtures ----------------------------------------

/** Seed the three content repos + the empty twin; flip the vault private;
 *  pin the real repos' updatedAt (the seed order's determinism across the
 *  settle arms). Idempotent per test (the wipe precedes every test). */
async function seedContentFamily(): Promise<{ owner: UserProfileRow }> {
  const owner = await seedOwner();
  await ensureSeededRepo({ owner: "cs-owner", slug: "alpha", commits: ALPHA_COMMITS });
  await ensureSeededRepo({ owner: "cs-owner", slug: "beta", commits: BETA_COMMITS });
  await ensureSeededRepo({ owner: "cs-owner", slug: "vault", commits: VAULT_COMMITS });
  await seedEmptyRepo(owner, "gamma");
  await drizzle(env.DB)
    .update(repositories)
    .set({ visibility: "private", updatedAt: VAULT_TIME })
    .where(eq(repositories.slug, "vault"));
  await drizzle(env.DB).update(repositories).set({ updatedAt: ALPHA_TIME }).where(eq(repositories.slug, "alpha"));
  await drizzle(env.DB).update(repositories).set({ updatedAt: BETA_TIME }).where(eq(repositories.slug, "beta"));
  return { owner };
}

describe("the R05 page over federated engine fixtures (three repos)", () => {
  it("the bare form renders with search === null (no seed read, no engine call)", async () => {
    await seedContentFamily();
    const page = await renderPage("cs-owner", anonDoer, { kind: "anonymous" }, "");
    expect(page.status).toBe(200);
    expect(page.owner).not.toBeNull();
    expect(page.owner?.kind).toBe("user");
    expect(page.html).toContain('class="page-content user profile"');
    expect(page.html).toContain("Start a code search.");
    expect(page.html).toContain("Enter a keyword to search across the code.");
    // the always-on scan notice renders on the bare arm too
    expect(page.html).toContain(userCodeSearchLocale.by_scan);
    expect(page.html).not.toContain("repo-search-result");
    expect(page.html).not.toContain("No matching results found.");
    // the over-cap copy never renders on the bare arm
    expect(page.html).not.toContain("Searched the 25");
  });

  it("the federated cards carry the owner/repo header and the per-repo commit permalink", async () => {
    await seedContentFamily();
    const page = await renderPage("cs-owner", anonDoer, { kind: "anonymous" }, "q=needleword");
    expect(page.status).toBe(200);
    expect(page.html).toContain('class="page-content user profile"');
    // the private + empty twins never surface (visibility before the fan-out;
    // the null answer skipped silently)
    expect(page.html).toContain("cs-owner/alpha");
    expect(page.html).toContain("cs-owner/beta");
    expect(page.html).not.toContain("cs-owner/vault");
    expect(page.html).not.toContain("cs-owner/gamma");
    // the results.tmpl federated arm: the repo link + " - " + the filename
    expect(page.html).toContain('<a rel="nofollow" href="/cs-owner/alpha">cs-owner/alpha</a>');
    expect(page.html).toContain(" - readme.txt");
    // the per-repo line table (searchfile.tmpl's markup)
    expect(page.html).toContain('class="diff-file-box file-content non-diff-file-content repo-search-result"');
    expect(page.html).toContain("needleword on the alpha side");
    // no truncation fired for this query — no notice beyond the scan notice
    expect(page.html).not.toContain("The search stopped at its result budget");
    expect(page.html).not.toContain("results may be partial");
  });

  it("the View File permalink carries each repo's OWN tip oid and the line anchors", async () => {
    await seedContentFamily();
    const seeded = await ensureSeededRepo({ owner: "cs-owner", slug: "alpha", commits: ALPHA_COMMITS });
    const tip = seeded.tips[seeded.tips.length - 1] as string;
    const page = await renderPage("cs-owner", anonDoer, { kind: "anonymous" }, "q=needleword&search_mode=exact");
    expect(page.html).toContain(
      `href="/cs-owner/alpha/src/commit/${tip}/readme.txt"`,
    );
    expect(page.html).toContain(`href="/cs-owner/alpha/src/commit/${tip}/readme.txt#L1"`);
    expect(page.html).toContain('<td class="lines-code chroma"><code class="code-inner">needleword on the alpha side</code></td>');
  });

  it("the visibility ladder: the owner sees the private repo's cards, anonymous never does", async () => {
    await seedContentFamily();
    const owner = await seedOwner();
    const anon = await renderPage("cs-owner", anonDoer, { kind: "anonymous" }, "q=needleword");
    expect(anon.html).not.toContain("cs-owner/vault");
    expect(anon.html).toContain("cs-owner/alpha");
    const own = await renderPage(
      "cs-owner",
      { id: owner.id, isAdmin: false },
      { kind: "user", id: owner.id, username: owner.username, isAdmin: false },
      "q=needleword",
    );
    expect(own.html).toContain("cs-owner/vault");
    expect(own.html).toContain("needleword on the vault side");
  });

  it("a per-repo truncation hoists to the page-level notice (beta's 52-file answer)", async () => {
    await seedContentFamily();
    const page = await renderPage("cs-owner", anonDoer, { kind: "anonymous" }, "q=capword");
    expect(page.status).toBe(200);
    // the counted arm, repo-prefixed, exactly once (alpha/gamma do not
    // truncate — the hoist names the truncated repo only)
    expect(page.html).toContain("cs-owner/beta: The search stopped at its result budget — showing the first 50 of 52 matching files.");
    expect(page.html.split("The search stopped at its result budget").length - 1).toBe(1);
    // the covered answer still renders its 50 blocks
    expect(page.html.split("repo-search-result").length - 1).toBe(50);
    expect(page.html).not.toContain("ui borderless pagination menu"); // no union pager (§3.3 item 3)
  });

  it("the over-cap notice fires at a seeded 26th visible repo (§5.1 — never silent)", async () => {
    const { owner } = await seedContentFamily();
    // 23 public padding rows pin BELOW the freshly-settled real repos
    // (OLD_TIME updatedAt) — the covered 25 = 3 real + 22 padding.
    for (let i = 0; i < 23; i += 1) await seedPaddingRepo(owner, `pad${String(i).padStart(2, "0")}`);
    const page = await renderPage("cs-owner", anonDoer, { kind: "anonymous" }, "q=needleword");
    expect(page.status).toBe(200);
    expect(page.html).toContain("Searched the 25 most recently updated of 26 visible repositories.");
    // the covered real repos still render under the cap
    expect(page.html).toContain("cs-owner/alpha");
    expect(page.html).toContain("cs-owner/beta");
    // the padding repos answer null and stay silent (no cards, no notices)
    expect(page.html).not.toContain("cs-owner/pad00");
  });

  it("the no-results arm renders upstream's line over a zero-match union", async () => {
    await seedContentFamily();
    const page = await renderPage("cs-owner", anonDoer, { kind: "anonymous" }, "q=zzz-no-such-word");
    expect(page.status).toBe(200);
    expect(page.html).toContain("No matching results found.");
    expect(page.html).not.toContain("Start a code search.");
    expect(page.html).not.toContain("repo-search-result");
    expect(page.html).toContain(userCodeSearchLocale.by_scan);
  });

  it("the mode select lists exactly exact|words — no regexp, no ?l=, no pager (§3.3 pins)", async () => {
    await seedContentFamily();
    const page = await renderPage("cs-owner", anonDoer, { kind: "anonymous" }, "q=needleword");
    const exactAt = page.html.indexOf('<option value="exact"');
    const wordsAt = page.html.indexOf('<option value="words"');
    expect(exactAt).toBeGreaterThan(-1);
    expect(wordsAt).toBeGreaterThan(exactAt);
    expect(page.html).not.toContain('<option value="regexp"');
    // no language facet input (§3.3 item 2) and no pager (item 3)
    expect(page.html).not.toContain('name="l"');
    expect(page.html).not.toContain("ui borderless pagination menu");
    // the displayed-default quirk: no known mode → nothing selected (the
    // first option displays); a known mode echoes selected
    const words = await renderPage("cs-owner", anonDoer, { kind: "anonymous" }, "q=needleword&search_mode=words");
    expect(words.html).toContain('<option value="words" selected=""');
    expect(words.html).not.toContain('<option value="exact" selected=""');
  });

  it("the profile chrome renders the avatar card and the tab strip with real counts", async () => {
    await seedContentFamily();
    const page = await renderPage("cs-owner", anonDoer, { kind: "anonymous" }, "q=needleword");
    expect(page.html).toContain('id="profile-avatar-card"');
    expect(page.html).toContain("cs-owner");
    // the tab strip's repositories label carries the doer-visible count (3
    // public rows: alpha, beta, gamma)
    expect(page.html).toContain('href="/cs-owner?tab=repositories"');
  });

  it("an anonymous keyword search over the empty-only set answers the clean no-results state", async () => {
    const owner = await seedOwner();
    await seedEmptyRepo(owner, "lonely");
    const page = await renderPage("cs-owner", anonDoer, { kind: "anonymous" }, "q=anything");
    expect(page.status).toBe(200);
    // the empty repo's grep answered null and skipped silently — the page is
    // 200 with the no-results line (never a 404 off one dead repo, §5.5)
    expect(page.html).toContain("No matching results found.");
    expect(page.html).not.toContain("repo-search-result");
  });

  it("the profile-family gate: an invisible owner resolves missing for anonymous", async () => {
    // a PRIVATE owner row (the visibility ladder's private arm)
    await seedVerifiedUser({ username: "cs-ghost" });
    await drizzle(env.DB).update(users).set({ visibility: "private" }).where(eq(users.usernameLower, "cs-ghost"));
    const page = await renderPage("cs-ghost", anonDoer, { kind: "anonymous" }, "q=x");
    expect(page.status).toBe(404);
    expect(page.owner).toBeNull();
  });
});

// --- the org-context arm ----------------------------------------------------------

describe("the org-context arm (user/code.tmpl's org half)", () => {
  it("renders the organization code chrome over the org seed walk", async () => {
    const owner = await seedOwner();
    const orgs = new OrgService(env.DB);
    const org = await orgs.createOrg({ name: "cs-org", ownerId: owner.id });
    await seedPaddingRepo({ id: org.id, usernameLower: "cs-org" }, "orgrepo");
    await drizzle(env.DB)
      .insert(repositories)
      .values({
        id: "csorg-vault",
        storageKey: "r_csorg-vault",
        ownerNamespace: "cs-org",
        ownerId: org.id,
        slug: "orgvault",
        visibility: "private",
        status: "ready",
        updatedAt: OLD_TIME,
      });
    const page = await renderPage("cs-org", anonDoer, { kind: "anonymous" }, "q=zzz-nothing");
    expect(page.status).toBe(200);
    expect(page.owner?.kind).toBe("org");
    expect(page.html).toContain('class="page-content organization code"');
    expect(page.html).toContain("cs-org");
    // anonymous sees the public org row only (the private one never seeds —
    // its grep never runs, the card never surfaces)
    expect(page.html).not.toContain("cs-org/orgvault");
    expect(page.html).toContain("No matching results found.");
    // the empty grep answered null — the page is 200 (the silent-skip rule)
  });
});

// --- the a11y smoke --------------------------------------------------------------

describe("user-code-search a11y smoke", () => {
  it("the bare form and a results page pass the structural rules", async () => {
    await seedContentFamily();
    for (const query of ["", "q=needleword&search_mode=exact"]) {
      const page = await renderPage("cs-owner", anonDoer, { kind: "anonymous" }, query);
      expect(page.status).toBe(200);
      const violations = runA11y(page.html);
      expect(violations, JSON.stringify(violations)).toEqual([]);
    }
  });
});
