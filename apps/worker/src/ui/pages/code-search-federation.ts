/**
 * The code-search FEDERATION LOADER (SPEC-0019 §3.1 — the census's R02/R05
 * revisit, the v1 "demand-scan federation" verdict at §2.4(c)): the shared
 * worker-side module both code-search pages call — the owner-scoped seed
 * queries (R05's user/org halves; M2's R02 instance arm lands here too) and
 * the bounded fan-out over the LANDED grep RPC.
 *
 *   GET /{username}/-/code   web.go:1166 → user.CodeSearch (this module's
 *                            consumer: pages/user-code-search.tsx)
 *   GET /explore/code        web.go:558 → explore.Code (SPEC-0019 M2)
 *
 * ## The ratified shape (SPEC-0019 §8 — all six resolved per proposal)
 *
 * - The fan-out CAP is the constant 25 (question 2 — one grep per repo keeps
 *   a full page inside Workers Free's 50-subrequest budget with headroom; a
 *   paid deployment raising it is a one-constant change, still no var). The
 *   cap is a first-class honesty surface: the FULL visible count rides the
 *   answer for the over-cap notice, never a silent truncation (§5.1).
 * - The seed order is `updated_unix DESC, id DESC` (question 3 — recency
 *   bias, deterministic across requests, the explore listing's vocabulary).
 * - The fan-out executes in bounded batches of 5 (question 6 — near-parallel
 *   latency ≈5 scan-depths worst case, bounded concurrent DO pressure, a
 *   trivially testable ordering seam).
 *
 * ## The data plane is EXISTING machinery only (§1 out-of-scope)
 *
 * No new engine RPC, no D1 table, no storage namespace: the seed is a
 * straight Drizzle read over `repositories` (the visibility idioms of §2.5 —
 * never a self-fetch, SPEC-0008 §3.2), and each repo answers through
 * `engineClient(env, name).grep(defaultBranch, {q, mode})` (the SPEC-0015
 * §3.1 contract: ≤50 blocks, the honest pre-cap `total`, the `truncated`
 * flag, 2,000-blob / 200,000-line-step budgets). The federation adds NO new
 * budget surface of its own (§5.6) — a monorepo yields an honest partial
 * inside its own DO.
 *
 * ## Modes (§3.3 item 1 — the ledgered reduction)
 *
 * These pages render exact|words ONLY (the indexer pages'
 * `SearchModesExactWords` set), NOT regexp — upstream's indexed path has no
 * regexp mode, and adding the grep-only mode here would make the three
 * code-search pages inconsistent. The parse split mirrors R10's
 * (pages/repo-search.tsx): absent/unknown EXECUTES words (gitgrep.go:28-35's
 * fall-through) while the select DISPLAYS its first option (exact) when the
 * URL names no known mode (combo.tmpl's `{{$selected := index .SearchModes
 * 0}}` quirk).
 *
 * ## Failure posture (§3.1 step 3 / §5.5)
 *
 * Empty repos, unborn branches, and transport failures answer `null` and
 * SKIP silently — a federated page can never 404 off one dead repo
 * (contrast: R10's single-repo page 404-shells). A repo deleted between the
 * seed query and its grep contributes nothing: visibility is enforced BEFORE
 * the fan-out (§5.4 — the seed queries are the ONLY authority), and dead
 * rows never surface afterwards (upstream cleans deleted-repo results
 * post-search, explore/code.go:110-120 — ours never surfaces them).
 */

import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { GrepResult } from "@cf-gitea/git-engine";

import type { OrgDoer } from "../../api/services/org-repos";
import { repositories } from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import type { ProfileDoer } from "./user-profile";

// ---------------------------------------------------------------------------
// The ratified constants (SPEC-0019 §8 questions 2 + 6)
// ---------------------------------------------------------------------------

/** The fan-out cap (question 2): at most this many repos are grep-scanned
 *  per query; the rest ride the over-cap notice. One grep per repo keeps the
 *  full page inside Workers Free's 50-subrequest budget with headroom (the
 *  seed is one D1 query, the render is local — §5.2's math). */
export const CODE_SEARCH_FAN_OUT_CAP = 25;

/** The bounded-batch width (question 6): the fan-out runs ceil(cap / 5) =
 *  5 batches worst case, each awaiting its greps together — near-parallel
 *  latency, bounded concurrent DO pressure. */
export const CODE_SEARCH_BATCH_SIZE = 5;

// ---------------------------------------------------------------------------
// Seeds — the visible repo set (§3.1 step 1 + §5.4)
// ---------------------------------------------------------------------------

/** The per-repo facts the federation needs (the seed projection stays
 *  metadata-only — content never crosses the seed query). */
export interface CodeSearchSeed {
  ownerNamespace: string;
  slug: string;
  defaultBranch: string;
  /** The archived badge on the result card (results.tmpl's
   *  `{{if $repo.IsArchived}}` arm — the federated card header carries it). */
  isArchived: boolean;
}

/** The combined engine name the RPC addresses (`owner/repo` — the gate's
 *  `getByName` convention; the seed rows are already the RESOLVED D1
 *  spellings, so /ALICE/hello and /alice/hello reach the same cell). */
export function codeSearchSeedName(seed: CodeSearchSeed): string {
  return `${seed.ownerNamespace}/${seed.slug}`;
}

/**
 * The USER-owner seed query — the profile page's owner-repo visibility
 * filter verbatim (the user-profile.tsx WHERE the SPEC §2.5 names): every
 * row for the owner themself or a site admin, `visibility = 'public'` rows
 * for everyone else. ONE D1 query, ordered by the ratified seed order
 * (`updated_unix DESC, id DESC` — question 3; SQLite sorts NULL updated_at
 * last under DESC). The query is the ONLY visibility authority: no grep is
 * ever issued for an invisible repo (§5.4). Private owners visible through
 * the follow/co-member ladder expose their PUBLIC rows only here — the
 * owner-visibility half of upstream's PublicRepoUnderPublicOwnerCond shape
 * already ran in the profile resolution.
 */
export async function loadUserCodeSearchSeeds(d1: D1Database, ownerId: number, doer: ProfileDoer): Promise<CodeSearchSeed[]> {
  const seePrivate = doer.id !== null && (doer.isAdmin || doer.id === ownerId);
  const where = seePrivate
    ? eq(repositories.ownerId, ownerId)
    : and(eq(repositories.ownerId, ownerId), eq(repositories.visibility, "public"));
  return drizzle(d1)
    .select({
      ownerNamespace: repositories.ownerNamespace,
      slug: repositories.slug,
      defaultBranch: repositories.defaultBranch,
      isArchived: repositories.isArchived,
    })
    .from(repositories)
    .where(where)
    .orderBy(desc(repositories.updatedAt), desc(repositories.id))
    .all();
}

/** The org listing's page walk size (the org service's MAX_PAGE_SIZE — one
 *  50-row read per page; a set over the cap needs the FULL visible list to
 *  pick the recency-ordered top slice honestly). */
const ORG_SEED_PAGE_SIZE = 50;

/**
 * The ORG-owner seed query — the landed org listing's visibility predicate
 * (`OrgService.listOrgRepos`: owner members and admins see every row,
 * everyone else the public rows plus the team-granted arm) collected over
 * its pages, then ordered by the ratified seed order in memory. The page
 * walk is the org arm's seed cost (upstream's
 * `FindUserCodeAccessibleOwnerRepoIDs` materializes the id list the same
 * way): typical orgs finish inside the first 50-row page, and the loop
 * stops at the listing's own total.
 */
export async function loadOrgCodeSearchSeeds(d1: D1Database, org: OrgRecord, doer: OrgDoer): Promise<CodeSearchSeed[]> {
  const orgs = new OrgService(d1);
  const lister = { id: doer.id, isAdmin: doer.isAdmin };
  const collected: (CodeSearchSeed & { id: string; updatedAt: Date | null })[] = [];
  let total = Number.POSITIVE_INFINITY;
  for (let page = 1; collected.length < total; page += 1) {
    const listing = await orgs.listOrgRepos(org.id, lister, { page, pageSize: ORG_SEED_PAGE_SIZE });
    total = listing.total;
    for (const row of listing.items) {
      collected.push({
        id: row.id,
        ownerNamespace: row.ownerNamespace,
        slug: row.slug,
        defaultBranch: row.defaultBranch,
        isArchived: row.isArchived,
        updatedAt: row.updatedAt,
      });
    }
    if (listing.items.length === 0) break; // drift guard — never spin on a short count
  }
  // The ratified order in memory (question 3): `updated_unix DESC, id DESC`.
  // The ids are TEXT — the same lexicographic comparison the SQL arm's ORDER
  // BY performs; NULL updated_at sorts last under DESC (SQLite's NULLs-first
  // ASC folds to NULLs-last here), matching loadUserCodeSearchSeeds' bytes.
  collected.sort((a, b) => {
    const at = a.updatedAt === null ? 0 : Math.floor(a.updatedAt.getTime() / 1000);
    const bt = b.updatedAt === null ? 0 : Math.floor(b.updatedAt.getTime() / 1000);
    if (at !== bt) return bt - at;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return collected.map(({ id: _id, updatedAt: _updatedAt, ...seed }) => seed);
}

// ---------------------------------------------------------------------------
// Modes (§3.3 item 1 — exact|words only)
// ---------------------------------------------------------------------------

/** The federated pages' execution modes (the indexer pages'
 *  SearchModesExactWords set — NO regexp; §3.3 item 1's ledgered reduction). */
const FEDERATED_SEARCH_MODES = ["exact", "words"] as const;
export type FederatedSearchMode = (typeof FEDERATED_SEARCH_MODES)[number];

/** The EXECUTED mode — gitgrep.go:28-35's fall-through: exact maps by name,
 *  EVERYTHING else (absent, empty, unknown — regexp included, it is not
 *  offered here) executes as words. */
export function parseFederatedSearchMode(raw: string | null): FederatedSearchMode {
  for (const mode of FEDERATED_SEARCH_MODES) {
    if (raw === mode) return mode;
  }
  return "words";
}

/** The DISPLAYED mode — the raw URL value when it names a known mode, else
 *  `null` (combo.tmpl's first-item display; a native select without an
 *  explicit selected attribute shows its first option). */
export function parseFederatedDisplayMode(raw: string | null): FederatedSearchMode | null {
  for (const mode of FEDERATED_SEARCH_MODES) {
    if (raw === mode) return mode;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The fan-out (§3.1 steps 2-4)
// ---------------------------------------------------------------------------

/** One per-repo answer row (§3.1 step 4's `{repo, grep}` pair). Rows exist
 *  only for repos whose grep ANSWERED (non-null) — skipped repos are absent,
 *  never surfacing as empty cards. */
export interface FederatedGrepRow {
  seed: CodeSearchSeed;
  /** The combined engine name (the card header's `owner/repo` link target
   *  and the RPC address). */
  repoName: string;
  grep: GrepResult;
}

/** The union answer (§3.1 step 4): the per-repo rows in seed order plus the
 *  `{matched, scanned, overCap, cap, totalVisible}` rollup the notices read. */
export interface FederatedCodeSearch {
  /** The answered rows, seed order preserved (each carries its own ≤50
   *  blocks and honesty fields — a repo's answer never spills into the
   *  next row's). */
  rows: FederatedGrepRow[];
  /** Repos whose grep produced ≥1 result block (the union's real hits). */
  matched: number;
  /** Repos that answered at all (non-null — zero-result scans included;
   *  the skipped arms — empty repo / unborn branch / transport — count
   *  nowhere). */
  scanned: number;
  /** The visible set exceeded the cap — the over-cap notice renders and
   *  names the covered slice (§5.1: NEVER a silent truncation). */
  overCap: boolean;
  /** The cap constant (the notice's covered-count number). */
  cap: number;
  /** The FULL doer-visible repo count — the over-cap notice's M. */
  totalVisible: number;
}

/**
 * Execute the federation (§3.1 steps 2-4): cap the ordered seed set, run the
 * greps in bounded batches of `CODE_SEARCH_BATCH_SIZE` (each batch awaited
 * together, batches in seed order — the testable ordering seam), skip the
 * null answers silently, and roll the union up. `grepRepo` is the per-repo
 * seam the pages inject (`(name, ref, opts) => engineClient(env,
 * name).grep(ref, opts)`) and the tests instrument — a seed whose grep
 * throws is the transport-failure arm ONLY where the injected seam already
 * nulls it (the engineClient contract); a throw escaping here propagates
 * (the pages' seam never lets one).
 */
export async function federatedCodeSearch(
  seeds: CodeSearchSeed[],
  query: { q: string; mode: FederatedSearchMode },
  grepRepo: (repoName: string, ref: string, opts: { q: string; mode: FederatedSearchMode }) => Promise<GrepResult | null>,
): Promise<FederatedCodeSearch> {
  const cap = CODE_SEARCH_FAN_OUT_CAP;
  const totalVisible = seeds.length;
  const covered = seeds.slice(0, cap);
  const overCap = totalVisible > cap;

  const rows: FederatedGrepRow[] = [];
  let scanned = 0;
  for (let start = 0; start < covered.length; start += CODE_SEARCH_BATCH_SIZE) {
    const batch = covered.slice(start, start + CODE_SEARCH_BATCH_SIZE);
    const answers = await Promise.all(
      batch.map(async (seed) => ({
        seed,
        grep: await grepRepo(codeSearchSeedName(seed), seed.defaultBranch, { q: query.q, mode: query.mode }),
      })),
    );
    for (const { seed, grep } of answers) {
      if (grep === null) continue; // the silent skip (§3.1 step 3)
      scanned += 1;
      rows.push({ seed, repoName: codeSearchSeedName(seed), grep });
    }
  }

  const matched = rows.reduce((count, row) => (row.grep.results.length > 0 ? count + 1 : count), 0);
  return { rows, matched, scanned, overCap, cap, totalVisible };
}
