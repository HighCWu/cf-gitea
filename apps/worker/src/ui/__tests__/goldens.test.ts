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
import {
  GOLDEN_CASES,
  GOLDEN_MARKER_END,
  GOLDEN_MARKER_START,
  type GoldenCase,
  renderCase,
  renderRoute,
  setupGoldenFixtures,
} from "./harness";

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
 * goldens) added the admin listing pages below. Two of the three candidates
 * are documented skips — the analyses live here so the next attempt starts
 * from the mechanism, not from a fresh dead end:
 *
 *   - admin-orgs (TAKEN): `/-/admin/orgs`, the orgs list over the EXISTING
 *     org fixtures (acme + emptyorg — no new seeds; the R6 sweep already
 *     scoped its seven th cells). Deterministic: org rows are `users` rows
 *     (seeded integer ids, createdAt pinned to T0, and the Teams/Members/
 *     Repos cells are fixture-derived counts), so the bytes are stable.
 *   - admin-repos (SKIPPED — no byte-deterministic fixture path): the table's
 *     first column renders `repositories.id` verbatim, and repo ids are
 *     `crypto.randomUUID()` at create (repos/service.ts:284) — per-run
 *     random, PRIMARY KEY, referenced by every metadata table, and baked into
 *     the immutable `storage_key = 'r_' || id` (repos/service.ts:303-306).
 *     Pinning them would mean restructuring the harness seeds and every
 *     referencing row (harness.ts is outside a goldens-only wave's scope;
 *     "cheap" does not apply). The zero-row search arm (`?q=` no match) IS
 *     deterministic but renders no table rows — it would fake the coverage
 *     this gap is about. Proper fix lives with the harness/page owners: a
 *     fixed-id seed arm in testing/seed-repo.ts (the webhookDeliveries
 *     fixed-uuid precedent) or an id-projection decision in admin-repos.tsx.
 *   - admin-monitor (SKIPPED — the cron/queue tables the audit names, per
 *     page): cron renders wall-clock bytes — the route passes
 *     `new Date()` (ui/index.ts loadAdminMonitorCron) and the Next Time
 *     column formats it, so no fixture can pin the page. stats and queue DO
 *     have existing deterministic fixture paths (stats is pure COUNT reads;
 *     queue reads the hooks seed's webhook_deliveries — pending 1, delivered
 *     2 — and the mirror seed's idle repo_mirrors row), but each renders a
 *     THEAD-LESS table (stats.tmpl's key/count rows; the queue page's
 *     delivery-states segment): the R6 walker's "has no thead" violation on
 *     first sight — the stop condition, reported instead of pinned. Upstream's
 *     stats.tmpl is itself thead-less, so the fix is a policy call for the
 *     page owner (diverge with a thead, or exempt the upstream-shape
 *     key/value table in a11y.ts), not a goldens-wave change.
 */
const NEW_GOLDEN_CASES: GoldenCase[] = [
  { file: "admin-users.html", path: "/-/admin/users", status: 200, signedIn: true, sessionUser: "morgan" },
  // The R6-audit wave's addition: the orgs list rides morgan's promotion like
  // admin-users (the shared admin gate) and the EXISTING org fixtures — no
  // new seeds, so no committed byte moves. admin-repos/admin-monitor are
  // documented skips (the block comment above).
  { file: "admin-orgs.html", path: "/-/admin/orgs", status: 200, signedIn: true, sessionUser: "morgan" },
  { file: "user-settings-account.html", path: "/user/settings/account", status: 200, signedIn: true },
  { file: "profile-watching.html", path: "/alice?tab=watching", status: 200, signedIn: true },
  { file: "milestone-detail.html", path: "/alice/golden-ms/milestone/2", status: 200, signedIn: true },
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
