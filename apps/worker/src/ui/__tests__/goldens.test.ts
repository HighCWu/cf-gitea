/**
 * U5 golden DOM snapshots (SPEC-0008 §5.2) + the determinism guard. The five
 * committed goldens (harness.GOLDEN_CASES) are byte-exact renders of the
 * three pages plus the 404 shell (with repo context) and the bare shell
 * (unknown owner/repo), produced through the real route path with the fixed
 * seed fixtures — same commit oids and dates on every machine.
 *
 * The goldens use the SYNTHETIC manifest (fixed pseudo-hashes), so they stay
 * stable across asset rebuilds — §5.2's hash normalization is unnecessary
 * here and intentionally absent: any byte difference is real DOM drift.
 *
 * Regeneration: workerd tests have no filesystem and no shell env vars, so
 * the env-var pattern is not available. Run instead:
 *
 *     node src/ui/__tests__/update-goldens.mjs
 *
 * which empties the goldens, drops the update sentinel, runs this file, and
 * extracts the marker-framed renders printed below back into the committed
 * files.
 *
 * The wave-129 expansion cases (NEW_GOLDEN_CASES below) are declared HERE,
 * not in harness.ts's GOLDEN_CASES: that table is iterated by a11y.test.ts
 * too, so entries added there would silently grow a sibling suite — and the
 * expansion needs a file-local fixture (morgan's site-admin promotion) that
 * the shared harness must not impose on it.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { users } from "../../db/schema";
import { ensureSeededFixedIdRepo } from "../testing/seed-repo";
import {
  GOLDEN_CASES,
  GOLDEN_MARKER_END,
  GOLDEN_MARKER_START,
  type GoldenCase,
  T0,
  renderCase,
  renderRoute,
  setupGoldenFixtures,
} from "./harness";

/**
 * The admin-repos golden's fixture row id (morgan/admin-golden — seeded via
 * ensureSeededFixedIdRepo below). The ID cell renders it verbatim, so the
 * literal IS the determinism (the a11y arm re-derives it from the committed
 * bytes; this export documents the single source). Valid v4 shape, all-zero
 * digit prefix — CAST(id AS INTEGER) = 0, inert under the service's id-order
 * sort stand-ins.
 */
export const ADMIN_GOLDEN_REPO_ID = "00000000-0000-4000-8000-000000000001";

/** Committed golden bytes, read through Vite's `?raw` transform (byte-exact;
 *  typing in raw-modules.d.ts). */
const goldenBodies: Record<string, string> = import.meta.glob("./goldens/*.html", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Update mode = the regeneration script's sentinel file is present. The mjs
 *  removes it in a finally block; a stray copy flips this file into
 *  print-only mode (visible as non-asserting golden tests in the report). */
const updateMode =
  Object.keys(import.meta.glob("./goldens-update-mode*", { query: "?raw", import: "default", eager: true })).length > 0;

function goldenBody(file: string): string | undefined {
  return goldenBodies[`./goldens/${file}`];
}

/** First differing byte offset, with a small window of both sides for the
 *  failure message (a plain `toBe` on 10 kB strings is unreadable). */
function diffWindow(html: string, committed: string): string {
  let at = 0;
  while (at < html.length && at < committed.length && html[at] === committed[at]) at += 1;
  const window = (text: string): string => JSON.stringify(text.slice(Math.max(0, at - 48), at + 48));
  return `first difference at byte ${at} (${html.length} vs ${committed.length} bytes)\n  render:  ${window(html)}\n  golden:  ${window(committed)}`;
}

setupGoldenFixtures();

/**
 * The wave-129 expansion's admin principal: morgan promoted to site admin so
 * `/-/admin/users` renders its table. Runs AFTER the harness's seeding
 * beforeAll (declaration order), so the row exists. MORGAN, not alice:
 * alice's signed-in goldens below (dashboard, notifications-*) would shift
 * bytes — pages/global-inbox.tsx's admin arm widens the inbox scope and
 * pages/dashboard.tsx feeds the flag into its visibility doer — while
 * morgan's riders (org-teams/org-team-detail/org-labels/settings-team-admin/
 * repo-create) consult isAdmin nowhere in their render paths, and the shell
 * has no admin-conditional chrome. The flag renders nowhere outside
 * /-/admin/* (no navbar link, no explore badge), so no other golden moves.
 */
beforeAll(async () => {
  await drizzle(env.DB).update(users).set({ isAdmin: true }).where(eq(users.usernameLower, "morgan"));
  // The admin-repos golden's fixture row (the case comment below): a PRIVATE
  // D1-only repo with the FIXED id — the ID cell the R6 gap is about renders
  // deterministically. Runs after the harness seeding (declaration order:
  // setupGoldenFixtures above registered first), so morgan's row exists.
  await ensureSeededFixedIdRepo({
    owner: "morgan",
    slug: "admin-golden",
    id: ADMIN_GOLDEN_REPO_ID,
    createdAt: new Date(T0 * 1000),
  });
});

/** The one copy of the §5.2 assertion/marker protocol, shared by both case
 *  tables below (identical body to the original inline loop — update mode
 *  prints the marker-framed render instead of asserting; a missing golden
 *  file outside update mode is the loud regeneration error; the byte
 *  comparison is the assertion of record). */
async function renderGoldenCase(golden: GoldenCase): Promise<void> {
  const { status, html } = await renderCase(golden);
  expect(status, golden.path).toBe(golden.status);

  const committed = goldenBody(golden.file);
  if (updateMode || committed === undefined) {
    // Regeneration path: print the marker-framed render for the update
    // script; no byte assertion (there is nothing to assert against on
    // the first run, and the sentinel says the operator asked for that).
    console.log(`${GOLDEN_MARKER_START}${golden.file}\n${html}\n${GOLDEN_MARKER_END}`);
    if (!updateMode) {
      throw new Error(
        `golden file goldens/${golden.file} is missing — regenerate with: node src/ui/__tests__/update-goldens.mjs`,
      );
    }
    return;
  }
  if (committed === "") {
    throw new Error(
      `golden file goldens/${golden.file} is empty (interrupted regeneration?) — rerun: node src/ui/__tests__/update-goldens.mjs`,
    );
  }
  if (html !== committed) {
    throw new Error(`render differs from goldens/${golden.file}: ${diffWindow(html, committed)}`);
  }
  expect(html).toBe(committed); // the assertion of record
}

describe("golden DOM snapshots (§5.2)", () => {
  for (const golden of GOLDEN_CASES) {
    it(`renders ${golden.file} byte-identical (${golden.status})`, async () => {
      await renderGoldenCase(golden);
    });
  }
});

/**
 * The wave-129 expansion cases — the four most regression-prone of the ~13
 * newly mounted surfaces, all rich-chrome full documents through the real
 * route path over the EXISTING seed fixtures (plus morgan's promotion):
 *
 *   - admin-users: `/-/admin/users`, the site-admin users table (the shared
 *     admin sidebar prologue + the paged, sortable, filter-parsing listing).
 *     Regression-prone because it pins the whole admin-gate arm
 *     (adminPagePrologue's non-admin 404 posture lives one gate away), the
 *     `users.type = "user"` filter (org rows must not leak into the table),
 *     and BOTH isAdmin label branches in one render — morgan's row carries
 *     the Admin basic label, alice's the plain link.
 *   - user-settings-account: `/user/settings/account`, the account tab
 *     (password form + the email-address section over the synthesized
 *     primary model — alice has no email rows, pinning the empty-table arm
 *     plus the add-email form). Regression-prone: the settingsGate posture
 *     and the tab-routing tail are the newest shared chrome in the family.
 *   - profile-watching: `/alice?tab=watching`, the profile WATCHING tab —
 *     the full profile grid + avatar card + tab strip + the shared repo
 *     list rendering alice's one watcher row (the wave-9 dashboard fixture's
 *     acme/anvil watch). Regression-prone: the ?tab= owner-home dispatch is
 *     one parser for five new pages, and the watching visibility arm
 *     (signed-in self view) is the fixture's only cross-owner watch.
 *   - milestone-detail: `/alice/golden-ms/milestone/2`, the wave-26
 *     milestone detail over golden-ms's v1.0 (the seed order makes its id 2
 *     — golden's issue fixture milestone takes id 1) with one open + one
 *     closed issue, so the 50% progress bar and BOTH issue-state arms render,
 *     signed-in owner so canWrite pins the Edit button. Regression-prone:
 *     the detail is the milestones LIST goldens' title-link target and the
 *     id-resolution arm (repo-scoped, non-numeric → 404) is new.
 *
 * The audit's queued R6 gap (the a11y suite can only SEE tables embedded in
 * goldens) added the admin listing pages below. admin-repos is TAKEN (the
 * wave-fixed-id-seed closure, via the positive-match search arm — the case
 * comment documents why the bare path stays unlandable); admin-monitor's
 * stats + queue surfaces were closed by the wave-theadless-policy refinement
 * of the R6 rule (the block comment below holds the policy call); cron
 * remains the one documented skip — the analysis lives here so the next
 * attempt starts from the mechanism, not from a fresh dead end:
 *
 *   - admin-orgs (TAKEN): `/-/admin/orgs`, the orgs list over the EXISTING
 *     org fixtures (acme + emptyorg — no new seeds; the R6 sweep already
 *     scoped its seven th cells). Deterministic: org rows are `users` rows
 *     (seeded integer ids, createdAt pinned to T0, and the Teams/Members/
 *     Repos cells are fixture-derived counts), so the bytes are stable.
 *   - admin-repos (TAKEN — wave-fixed-id-seed, through `?q=admin-golden`):
 *     the table's first column renders `repositories.id` verbatim and repo
 *     ids are `crypto.randomUUID()` at create (repos/service.ts:284) —
 *     per-run random, PRIMARY KEY, referenced by every metadata table, and
 *     baked into the immutable `storage_key = 'r_' || id`
 *     (repos/service.ts:303-306). The admin scope renders EVERY repositories
 *     row (services/repository.ts's is_admin short-circuit — upstream's
 *     `Private: true`), so the six harness repos' random ids leak into the
 *     bare `/-/admin/repos` bytes no matter what a new fixture pins — and
 *     the default sort's stand-in (`ORDER BY CAST(id AS INTEGER) DESC`,
 *     repository.ts:739-746, no tiebreaker) randomizes the row ORDER too:
 *     digit-leading UUIDs cast non-zero (verified: '550e8400-…' → 550,
 *     '123e4567-…' → 123; letter-leading → 0 — the admin-repos.matrix
 *     comment's "every CAST is 0" premise is wrong). Pinning the default
 *     view therefore needs EVERY harness repo id pinned — the three
 *     ensureSeededRepo call sites plus seedGoldenOrg's three
 *     RepoService.create calls, all in harness.ts, outside this wave's
 *     exclusive ownership (the original skip's "restructuring the harness
 *     seeds" caveat, unchanged). What THIS wave lands: the documented
 *     proper-fix seed arm — ensureSeededFixedIdRepo in testing/seed-repo.ts
 *     (the webhookDeliveries fixed-uuid precedent applied to a repositories
 *     row: direct insert with id + storage_key pinned) — feeding a PRIVATE
 *     morgan/admin-golden fixture consumed through the KEYWORD arm
 *     `?q=admin-golden`: the full admin chrome and the real 10-column table
 *     with exactly ONE deterministic row (the fixed ID cell, the Private
 *     label, the null-Updated empty arm, the T0-pinned Created). Unlike the
 *     zero-row arm the original skip note rejected, this renders a real
 *     table row — the coverage the R6 gap asks for.
 *   - admin-monitor (PARTIALLY TAKEN — stats + queue, wave-theadless-policy;
 *     cron STAYS skipped): the earlier skip's blocker was the R6 walker's
 *     "has no thead" violation on each page's thead-less table — the
 *     stop condition, reported instead of pinned. The policy call resolved
 *     it WITHOUT diverging from upstream: the defect R6 targets is a
 *     header-less DATA table (a records×columns grid with unnamed columns),
 *     while upstream renders key/value tables thead-less BY DESIGN at the
 *     pin (stats.tmpl's `<td width="200">{key}</td><td>{count}</td>` rows;
 *     dashboard.tmpl's label/run-button rows) — a11y.ts now exempts the
 *     definition-shape table (every row exactly one label td + one value td,
 *     no th, ≥1 row) with those cites. That un-blocked:
 *
 *     - admin-monitor-stats (TAKEN): `/-/admin/monitor/stats` — the Summary
 *       page over loadAdminMonitorStats's COUNT reads: every counter is a
 *       fixed SELECT over the harness seed (users/repos/issues/…), whose
 *       row sets the idempotent seeders pin — no wall clock, no randomUUID
 *       reaches a counted cell (repo ids are random but only COUNT(*) reads
 *       them). The 24 key/count rows render under upstream's exact sorted
 *       key names; system-comment rows (IssuesService event comments) are
 *       seeded with fixed `now`s, so the Comment count is fixture-derived
 *       like every other cell.
 *     - admin-monitor-queue (TAKEN): `/-/admin/monitor/queue` — the depth
 *       columns read the hooks seed's webhook_deliveries (pending 1 +
 *       delivered 2 → webhook-delivery inQueue 1) and the mirror seed's
 *       idle repo_mirrors row (→ repo-tasks inQueue 0), with the DLQ's
 *       countable-less `-` arm; the cf-gitea delivery-states segment
 *       renders the five schema states 1/0/2/0/0, zeros included (the log's
 *       full posture). The main queues table carries thead+scope (upstream
 *       queue.tmpl's own shape); the delivery-states segment is the
 *       definition shape the refined rule exempts.
 *     - admin-monitor cron (STILL SKIPPED — unchanged): the route passes
 *       `new Date()` (ui/index.ts loadAdminMonitorCron) and the Next Time
 *       column formats it, so no fixture can pin the page — wall-clock
 *       bytes, not a policy question.
 */
const NEW_GOLDEN_CASES: GoldenCase[] = [
  { file: "admin-users.html", path: "/-/admin/users", status: 200, signedIn: true, sessionUser: "morgan" },
  // The R6-audit wave's addition: the orgs list rides morgan's promotion like
  // admin-users (the shared admin gate) and the EXISTING org fixtures — no
  // new seeds, so no committed byte moves. admin-monitor is a documented
  // skip (the block comment above).
  { file: "admin-orgs.html", path: "/-/admin/orgs", status: 200, signedIn: true, sessionUser: "morgan" },
  // The wave-fixed-id-seed closure of the admin-repos skip (the block
  // comment above): the POSITIVE-MATCH keyword arm over the fixed-id
  // fixture row seeded in the beforeAll above — the full admin chrome and
  // the real 10-column table with exactly one deterministic row. The bare
  // `/-/admin/repos` path stays unlandable until every harness repo id is
  // pinned (six randomUUID() rows render + the CAST id-order stand-in
  // randomizes row order — the block comment above holds the mechanism).
  { file: "admin-repos.html", path: "/-/admin/repos?q=admin-golden", status: 200, signedIn: true, sessionUser: "morgan" },
  { file: "user-settings-account.html", path: "/user/settings/account", status: 200, signedIn: true },
  { file: "profile-watching.html", path: "/alice?tab=watching", status: 200, signedIn: true },
  { file: "milestone-detail.html", path: "/alice/golden-ms/milestone/2", status: 200, signedIn: true },
  // The wave-theadless-policy closures (the block comment above): the two
  // monitor surfaces the refined R6 rule un-blocked, riding morgan's
  // promotion like the other admin goldens. stats: the sorted key/count
  // definition-shape table over the harness seed's COUNT reads. queue: the
  // hooks seed's delivery depths (inQueue 1 / 0 / `-`) + the five-state
  // breakdown (1/0/2/0/0). cron stays skipped — wall-clock Next Time bytes.
  { file: "admin-monitor-stats.html", path: "/-/admin/monitor/stats", status: 200, signedIn: true, sessionUser: "morgan" },
  { file: "admin-monitor-queue.html", path: "/-/admin/monitor/queue", status: 200, signedIn: true, sessionUser: "morgan" },
];

describe("wave-129 expansion goldens", () => {
  for (const golden of NEW_GOLDEN_CASES) {
    it(`renders ${golden.file} byte-identical (${golden.status})`, async () => {
      await renderGoldenCase(golden);
    });
  }
});

describe("determinism (§5.2)", () => {
  it("renders the same route to identical bytes twice (no template caching, no request-state bleed)", async () => {
    const first = await renderRoute("/alice/golden");
    const second = await renderRoute("/alice/golden");
    expect(second.status).toBe(first.status);
    expect(second.html).toBe(first.html);
  });

  it("renders different fixture seeds to different bytes (guards against accidental template caching)", async () => {
    const golden = await renderRoute("/alice/golden");
    const alt = await renderRoute("/alice/golden-alt");
    expect(alt.status).toBe(200);
    expect(alt.html.length).toBeGreaterThan(0);
    expect(alt.html).not.toBe(golden.html);
  });
});
