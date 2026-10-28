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
 * The SPEC-0014 demo render gate is pinned OFF below for the same reason:
 * the bytes must not depend on the operator's local config surface.
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

import { actions, users } from "../../db/schema";
import { demoModeEnabled } from "../../services/demo-sweep";
import { __setRouteClockForTests, uiRouter } from "../index";
import { ensureSeededFixedIdRepo } from "../testing/seed-repo";
import { seedWikiPage } from "../testing/seed-wiki";
import {
  GOLDEN_CASES,
  GOLDEN_MARKER_END,
  GOLDEN_MARKER_START,
  type GoldenCase,
  T0,
  renderCase,
  renderRoute,
  setupGoldenFixtures,
  uiEnv,
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
 *  typing in raw-modules.d.ts). Two globs merged: the HTML page goldens AND
 *  the wave-golden-feeds XML envelopes (goldens/*.rss — the .rss extension
 *  is the content-honest label for the three feed goldens, and the glob arm
 *  is the ONE harness adaptation their non-HTML content type needed: the
 *  marker/update machinery itself is content-type-blind text extraction). */
const goldenBodies: Record<string, string> = {
  ...import.meta.glob("./goldens/*.html", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("./goldens/*.rss", { query: "?raw", import: "default", eager: true }),
};

/** Update mode = the regeneration script's sentinel file is present. The mjs
 *  removes it in a finally block; a stray copy flips this file into
 *  print-only mode (visible as non-asserting golden tests in the report). */
const updateMode =
  Object.keys(import.meta.glob("./goldens-update-mode*", { query: "?raw", import: "default", eager: true })).length > 0;

function goldenBody(file: string): string | undefined {
  return goldenBodies[`./goldens/${file}`];
}

/**
 * The demo render gate's harness pin (the 2026-10-28 "order/load flake"
 * diagnosis): BaseLayout renders the SPEC-0014 demo banner (+850 bytes on
 * EVERY page — shell.tsx's DemoBanner under `ctx.demoMode === true`) from
 * `demoModeEnabled(c.env)`, and `c.env` here is the harness uiEnv spread of
 * the vitest-plugin env — which carries the operator-local, UNCOMMITTED
 * config surface (wrangler.jsonc vars, per-name overridden by .dev.vars).
 * With the live-demo deployment's posture (DEMO_MODE "true" in the local
 * wrangler.jsonc) and no override line yet, every render carried the banner
 * bytes and ALL 64 committed-golden comparisons failed with a constant
 * +850 delta — reproduced exactly (probe config arming the binding: 64
 * failed | 10 passed). That was the gate-resilience unit's "order/load
 * flake": a local-config flip, not suite ordering — the solo run three
 * minutes later was green because the .dev.vars override had landed, not
 * because solo adjudicates a flake class. The goldens' subject is the
 * DEFAULT deployment's bytes (the committed example ships DEMO_MODE
 * "false"; §6.8's strict polarity keeps anything but the exact "true" OFF —
 * the banner wave's own "gate-off = zero DOM" invariant), so the gate is
 * pinned to the ABSENT arm: the goldens' bytes must not depend on the
 * operator's local config surface — the same fixture discipline as the
 * synthetic manifest above and the T0 pins in harness.ts (which stays
 * untouched: outside this file's ownership). The pin rides the harness's
 * exported uiEnv (the one object renderRoute/renderCase/the direct fetch
 * below hand to every render in this file), is set once at module scope,
 * and is self-checked through the REAL gate function: a polarity change
 * fails this setup loudly instead of failing 64 goldens with byte noise.
 * The cast is the demo tests' own env-copy shape (demo-sweep.test.ts's
 * `(copy as { DEMO_MODE: string })` + the `{ DEMO_MODE: undefined }`
 * absent arm) — the generated Env pins the deployed literal, the test must
 * express the absent arm. Byte-equality discipline untouched: no golden was
 * regenerated (gate-off renders are byte-stable — solo 74/74 before this
 * pin), ALLOW_SIGNUP stays unpinned (every one of the 64 failures was
 * exactly +850, so no other env-conditional byte family reaches committed
 * goldens), and a11y.test.ts parses the committed bytes, not live renders —
 * this file is the goldens/ directory's only live-render site (the
 * session-goldens/ login family has its own byte-compare render, outside
 * this file's ownership, with the same armed-gate exposure to fix
 * separately).
 */
(uiEnv as { DEMO_MODE?: string }).DEMO_MODE = undefined;
if (demoModeEnabled(uiEnv)) {
  throw new Error("goldens: the demo render gate pin failed — demoModeEnabled(uiEnv) must be false");
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
 * The wiki-view-home golden's fixture content (the seed below). Plain fixed
 * markdown — no links, no dates — so the markdown pipeline's render is a
 * pure function of these bytes (its wiki-mode link rewrites would otherwise
 * fold the request origin into the output; still deterministic, but the
 * plain form keeps the golden's determinism argument one line long).
 */
const WIKI_GOLDEN_HOME_CONTENT = [
  "# Home",
  "",
  "Welcome to the **golden-alt** wiki.",
  "",
  "Plain fixture paragraph for the view golden.",
  "",
].join("\n");

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
  // The wave-goldens-final profile-activity pin (the harness's createdAt-pin
  // precedent): the seed flows record action rows WITHOUT a draft createdAt
  // (services/issue-events.ts's drafts carry none; recordAction defaults to
  // new Date()), so the wall-clock stamp lands in the feed rows that
  // /alice?tab=activity renders through TimeSince. Pin ALICE'S PERFORMED rows
  // to the fixed epoch — key act_user_id = alice (her rows only; every other
  // principal's rows are inert for goldens). Inert for every pre-existing
  // golden: no committed page reads the actions table (dashboard's activity
  // line is the derived-thread projection over issues/comments; admin-monitor
  // stats counts no Action key), so this UPDATE moves no existing bytes.
  // Order stays deterministic without per-row timestamps: getFeedRows orders
  // created_at DESC, id DESC — equal stamps fall to the id tiebreak, and
  // autoincrement ids repeat identically every run (fresh DB, fixed seed
  // order).
  const aliceRow = await drizzle(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, "alice"))
    .get();
  if (aliceRow === undefined) throw new Error("golden owner row missing before the actions-row pin");
  await drizzle(env.DB)
    .update(actions)
    .set({ createdAt: new Date(T0 * 1000) })
    .where(eq(actions.actUserId, aliceRow.id));
  // The wiki-view-home golden's seed (the wave-wiki-fixedtime closure of the
  // wiki-start case comment's "UNLANDABLE" view arm, below): the FIXED-TIME
  // writer (ui/testing/seed-wiki.ts) lands golden-alt's Home page through the
  // LANDED createWikiPage op with the commit's author/committer stamps pinned
  // at write time (services/wiki.ts WikiWriteOptions.now — the wall clock
  // lived in the STORED git commit, so no render-site fixture could pin the
  // view's last-edited bytes). The stamp: T0 + 210 = 2023-11-14T22:16:50Z, an
  // unused fixture slot (the PR-diff commit sits at +180, the compare commit
  // at +240, the anvil issue at +200). golden-alt, not golden: the wiki-start
  // golden renders golden's EMPTY-wiki arm, and no repo-home/shell byte reads
  // the wiki cell (grep clean), so the seeded sibling moves zero committed
  // bytes.
  await seedWikiPage({
    owner: "alice",
    slug: "golden-alt",
    title: "Home",
    content: WIKI_GOLDEN_HOME_CONTENT,
    now: T0 + 210,
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
 * of the R6 rule (the block comment below holds the policy call); cron was
 * the one remaining skip until the wave-route-clock closure (the block
 * comment below holds both the policy call and the cron mechanism):
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
 *     - admin-monitor cron (TAKEN — the wave-route-clock closure): the
 *       skip's blocker was wall-clock bytes — the route hardcoded
 *       `new Date()` into loadAdminMonitorCron (ui/index.ts) and the Next
 *       Time column formats it, so no fixture could pin the page (not a
 *       policy question). The render-wallclock audit's follow-up 1 closed
 *       it: index.ts's module-scope route clock (`routeNow()` consulted at
 *       every rendered-byte loader call) + the test-only
 *       `__setRouteClockForTests` pin. The LAST admin golden — stats/queue
 *       landed in ff3b4fb. The case renders in its own describe below (the
 *       pin must WRAP the render — the seam is module-scope, not a
 *       per-request field, and harness.ts's GoldenCase stays outside this
 *       wave's exclusive ownership); its a11y coverage rides the
 *       EXPANSION_ARMS arm in a11y.test.ts like every expansion golden.
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
  // breakdown (1/0/2/0/0). cron rides the wave-route-clock closure in its
  // own describe below (the block comment above holds the mechanism).
  { file: "admin-monitor-stats.html", path: "/-/admin/monitor/stats", status: 200, signedIn: true, sessionUser: "morgan" },
  { file: "admin-monitor-queue.html", path: "/-/admin/monitor/queue", status: 200, signedIn: true, sessionUser: "morgan" },
  // ---------------------------------------------------------------------------
  // The wave-goldens-final batch — the four most chrome-rich surfaces still
  // without goldens, all through the real route path over the EXISTING seed
  // fixtures (plus the actions-row pin above). Selection audit over the
  // session's uncovered list:
  //
  //   - user-settings-repos (TAKEN): `/user/settings/repos`, the settings
  //     REPOS tab — the shared 12-item settings sidebar (the Repos item is
  //     the nav's newest) over the `.ui.list` of alice's three owned rows
  //     (golden/golden-alt/golden-ms, slug ASC — the landed order), each row
  //     the kind-icon chain + Owner/Name link + FormatByteSize size span.
  //     Regression-prone: the always-self owner filter (`owner_id = doer`,
  //     NO visibility filter) and the icon chain's arm selection.
  //   - user-settings-notifications (TAKEN): `/user/settings/notifications`,
  //     the preference page — the sidebar over TWO attached-segment forms
  //     (email + actions), both selects rendering their default-selected
  //     arms over the ABSENT user_settings rows (the creation defaults
  //     'enabled'/'failure-only'), the external docs anchor, both submit
  //     buttons. Deterministic: the page renders no timestamps at all.
  //   - wiki-start (TAKEN): `/alice/golden/wiki`, the wiki family's FIRST
  //     golden — the full repo chrome (breadcrumb header, tab strip with
  //     Code active, sidebar) over tplWikiStart's no-wiki arm (the book
  //     segment, the welcome lines, the writer-gated Create-the-First-Page
  //     button — signed-in owner alice, so the canWrite arm renders). Zero
  //     new seeds on golden: no OTHER repo in the harness carried wiki pages
  //     at this case's landing, so the start arm was the family's real
  //     default posture. The family's SEEDED page render (the view page over
  //     a created page) was UNLANDABLE at landing: services/wiki.ts
  //     wikiPerson stamped Date.now() into the wiki commit, so the view's
  //     last-edited TimeSince and the commit oid were wall-clock bytes — the
  //     same class as the admin-monitor cron skip. CLOSED by the follow-up
  //     wave-wiki-fixedtime: the write-path now seam (WikiWriteOptions.now)
  //     + the fixed-time writer (ui/testing/seed-wiki.ts) seeded golden-alt's
  //     Home page with pinned stamps — the wiki-view-home case below. golden
  //     itself keeps its empty-wiki cell, so this start arm's bytes are
  //     unchanged.
  //   - profile-activity (TAKEN): `/alice?tab=activity`, the profile
  //     ACTIVITY tab — the avatar card + the four-tab overview strip
  //     (activity active) over the action-feed pipeline's full item anatomy
  //     (actor anchor, per-type message segments, issue-title/comment
  //     bodies, TimeSince, the trailing glyph). The ONLY profile tab with
  //     real rows (the stars/followers tabs render the same profile chrome
  //     as empty arms — the least chrome per byte of the group, skipped on
  //     chrome-richness; the wave brief's "branches page" was stale —
  //     branches.html + branches-writer.html have been GOLDEN_CASES since
  //     wave 16). The feed rows are the seeds' action rows with the
  //     createdAt pin above (wall-clock → T0).
  // ---------------------------------------------------------------------------
  { file: "user-settings-repos.html", path: "/user/settings/repos", status: 200, signedIn: true },
  { file: "user-settings-notifications.html", path: "/user/settings/notifications", status: 200, signedIn: true },
  { file: "wiki-start.html", path: "/alice/golden/wiki", status: 200, signedIn: true },
  { file: "profile-activity.html", path: "/alice?tab=activity", status: 200, signedIn: true },
  // ---------------------------------------------------------------------------
  // The wave-wiki-fixedtime closure — the wiki family's seeded VIEW page, the
  // arm the wiki-start comment above documented as UNLANDABLE. The fixed-time
  // writer (ui/testing/seed-wiki.ts through the beforeAll's seed above) lands
  // golden-alt's Home page with the commit stamps pinned at write time, so
  // the last-edited relative-time bytes are fixtures: datetime = the pinned
  // ISO literal, text = the pinned tz-formatted literal, tense = "past"
  // (the 2023 stamp can never read future — stable for the fixtures'
  // lifetime), and the commit oid itself is deterministic (same tree bytes +
  // same person lines → same SHA-1). The render:
  //
  //   - `/alice/golden-alt/wiki` (rawTail "" → "Home") — the view arm over
  //     the ROOT commit the unborn-branch create lands (upstream's
  //     hasDefaultBranch == false posture): the page-dropdown row with the
  //     single-item menu (the seeded Home, the `selected` class), the
  //     dividing header with the commit-count history button (1) and the
  //     last-edited line ("alice edited this page" + the pinned
  //     relative-time — the doer is the route derivation of alice's row:
  //     username + the @noreply fallback), and the markdown content through
  //     the shared pipeline. SIGNED-IN OWNER (alice): the writer chrome
  //     renders — Edit/New/Delete buttons, the delete confirm modal, and the
  //     sidebar/footer edit pencil arms stay absent (no _Sidebar/_Footer
  //     seeded; the with-sidebar class keys on their presence).
  //   - Determinism riders: the sidebar/footer are "" (the empty arms), the
  //     commit_count is the fixture's 1 (countCommitsForPath over the root
  //     commit), and the metadata html_url/sub_url projections derive from
  //     the request origin but render nowhere in the view bytes.
  //   - Its a11y coverage: NOT auto-declared (a11y.test.ts arms are explicit
  //     per-file imports outside this wave's ownership — the same posture as
  //     wiki-start's landing).
  // ---------------------------------------------------------------------------
  { file: "wiki-view-home.html", path: "/alice/golden-alt/wiki", status: 200, signedIn: true },
];

describe("wave-129 expansion goldens", () => {
  for (const golden of NEW_GOLDEN_CASES) {
    it(`renders ${golden.file} byte-identical (${golden.status})`, async () => {
      await renderGoldenCase(golden);
    });
  }
});

/**
 * The admin-monitor-cron golden — the LAST admin golden (stats/queue landed
 * in ff3b4fb; this closes the family's documented skip, the block comment
 * above holds the mechanism). The skip's blocker was one hop above the
 * already-clock-injectable loader: the route hardcoded `new Date()` into
 * loadAdminMonitorCron, so the Next Time column was wall-clock bytes. The
 * wave-route-clock seam (index.ts's `routeNow()` + the test-only
 * `__setRouteClockForTests`) unlocks it: the render below runs under the
 * pinned clock, making the Next Time column a fixture —
 * T0 = 2023-11-14T22:13:20Z → the next 10-minute boundary of the
 * update_mirrors minute-step spec is 22:20:00 (formatMonitorFullTime's
 * UTC: "Nov 14, 2023 22:20:00").
 *
 * This lives in its OWN describe, not NEW_GOLDEN_CASES: the pin must wrap
 * the render (the seam is a module-scope override, not a per-request field),
 * and expressing that through the shared case loops would need a GoldenCase
 * clock field — harness.ts is outside this wave's exclusive ownership. The
 * try/finally restores the wall clock even on failure, so a broken golden
 * cannot leak the pin into sibling suites (module-level state, one file's
 * worker).
 */
const CRON_GOLDEN_CASE: GoldenCase = {
  file: "admin-monitor-cron.html",
  path: "/-/admin/monitor/cron",
  status: 200,
  signedIn: true,
  sessionUser: "morgan",
};

/** The Next Time literal the pinned clock renders (the derivation lives in
 *  the CRON_GOLDEN_CASE comment above) — the override arm asserts it. */
const CRON_PINNED_NEXT_TIME = "Nov 14, 2023 22:20:00";

/** The T0 channel stamp the pinned clock renders into the feed routes'
 *  `<pubDate>` (formatRfc1123z(T0) — 2023-11-14 was a Tuesday). */
const FEED_PINNED_CHANNEL_STAMP = "Tue, 14 Nov 2023 22:13:20 +0000";

describe("admin-monitor-cron golden (the wave-route-clock closure)", () => {
  it("renders admin-monitor-cron.html byte-identical (200) under the pinned route clock", async () => {
    __setRouteClockForTests(() => new Date(T0 * 1000));
    try {
      await renderGoldenCase(CRON_GOLDEN_CASE);
    } finally {
      __setRouteClockForTests(null);
    }
  });
});

/**
 * The route-clock override's own arm (the wave brief's set/unset behavior):
 * the seam is production-invisible only if the pin BOTH moves the rendered
 * bytes AND unset restores the wall clock. The 2023 literals can never
 * collide with a live render (the stamps predate every run), so `toContain`
 * / `not.toContain` are the robust discriminators — no timing flakes.
 */
describe("route-clock override arm (set/unset behavior)", () => {
  it("the pin fixes the cron page's Next Time; unsetting restores the wall clock; re-pinning is exact", async () => {
    __setRouteClockForTests(() => new Date(T0 * 1000));
    let pinned: string;
    try {
      pinned = (await renderCase(CRON_GOLDEN_CASE)).html;
    } finally {
      __setRouteClockForTests(null);
    }
    expect(pinned).toContain(CRON_PINNED_NEXT_TIME);

    // Unset = the wall clock: the 2023 stamp is gone, proving the override
    // actually gates these bytes (the golden above could not pass without
    // the pin reaching the route).
    const live = (await renderCase(CRON_GOLDEN_CASE)).html;
    expect(live).not.toContain(CRON_PINNED_NEXT_TIME);
    expect(live).not.toBe(pinned);

    // Re-pinning reproduces the pinned bytes exactly — no state bleed from
    // the wall-clock render through the module-scope variable.
    __setRouteClockForTests(() => new Date(T0 * 1000));
    let repinned: string;
    try {
      repinned = (await renderCase(CRON_GOLDEN_CASE)).html;
    } finally {
      __setRouteClockForTests(null);
    }
    expect(repinned).toBe(pinned);
  });

  it("the pin reaches the feed routes' channel stamps (the loader-default hop closed)", async () => {
    // The feed loaders defaulted `now` internally; the route call sites now
    // forward the route clock, so the CHANNEL stamp (not the seeded item
    // stamps) pins: releases.rss under T0 renders the fixed RFC-1123 literal.
    __setRouteClockForTests(() => new Date(T0 * 1000));
    let rss: string;
    try {
      rss = (await renderRoute("/alice/golden/releases.rss")).html;
    } finally {
      __setRouteClockForTests(null);
    }
    expect(rss).toContain(FEED_PINNED_CHANNEL_STAMP);

    const liveRss = (await renderRoute("/alice/golden/releases.rss")).html;
    expect(liveRss).not.toContain(FEED_PINNED_CHANNEL_STAMP);
  });
});

/**
 * The wave-golden-feeds batch — the three feed surfaces' first goldens, the
 * XML envelopes the route-clock closure (df348c8) made landable: every feed
 * loader's channel-date hop now flows from `routeNow()`, so the channel
 * stamps pin under the same seam the cron golden uses. All three render
 * through the real route path over the EXISTING seed fixtures — zero new
 * seeds, zero new pushes (the releases/tags twins anonymous, the user feed
 * signed-in as alice — the arm its population needs, case comment below):
 *
 *   - user-feed-alice (TAKEN): `/alice.rss` SIGNED-IN AS ALICE — the user
 *     ACTIVITY feed, the gorilla RSS envelope over the harness seed's
 *     action rows. The population is the profile-activity golden's exact
 *     three rows — the push-created create_repo actions for
 *     golden/golden-alt/golden-ms (the git-http push-settle emitter; the
 *     harness's IssuesService seeders record NO actions — that emitter
 *     lives in the API routes the harness never drives). The SIGNED-IN
 *     SELF arm is load-bearing, not cosmetic: push-created repos are born
 *     PRIVATE (gate.ts's DefaultPushCreatePrivate) and the harness flips
 *     only the repository ROW public after the push — the create_repo
 *     action rows keep the honest is_private=true of the private-born
 *     payload, so the ANONYMOUS feed over these fixtures is the empty
 *     channel (is_private=false filter). includePrivate = self
 *     (profile.go:43) is upstream's own arm for the principal's rows —
 *     the same choice the profile-activity golden makes. Determinism:
 *     the beforeAll actions-pin above stamps every act_user_id = alice
 *     row to T0 (equal stamps fall to getFeedRows' id tiebreak;
 *     autoincrement ids repeat identically every run), the absolute links
 *     derive from the request origin (https://test.local), and every op
 *     type is inside the wired 14-type set — the projection throws
 *     outside it, so a new unwired emitter in the seed fails loudly
 *     (500), never drifts silently. Channel stamp = the pinned clock →
 *     FEED_PINNED_CHANNEL_STAMP.
 *   - releases-feed (TAKEN): `/alice/golden/releases.rss` — the seeded
 *     release rows' feed: exactly the published v1 (the draft v2.0-rc1 is
 *     excluded UNCONDITIONALLY — upstream's IncludeDrafts-unset, no viewer
 *     parameter), exercising the release-item gorilla deltas (the
 *     always-empty <description>, the bare attribute-less <guid>, the
 *     CDATA note render through the markdown pipeline, the publisher-join
 *     author) and the channel's `/release`-singular link quirk. The item
 *     stamp is the create-time fixture (publishedUnix = T0+90).
 *   - tags-feed (TAKEN): `/alice/golden/tags.rss` — the engine tag universe
 *     joined with the D1 rows. The engine cell REUSES the harness's only
 *     tag-carrying repo (alice/golden's PUSHED refs/tags/v1 — ensureSeededRepo's
 *     tags param) instead of seeding a new one: a fresh tag-carrying repo
 *     would need another receive-pack push for one redundant arm. The join
 *     hits the release-backed arm (engine tag v1 <-> the seeded release row;
 *     release title/link under the default-true has_releases setting — the
 *     canReadReleases arm), channel "Tags for alice/golden" over the
 *     plural /tags link. The rowless-tag and releases-disabled arms stay
 *     with the smokes (the envelope's one golden needs the seeded-join
 *     posture to stay deterministic).
 *
 * XML-harness notes (the wave brief's non-HTML check):
 *   - The committed files carry the content-honest `.rss` extension;
 *     goldens.test.ts owns the `?raw` read, so the goldenBodies glob above
 *     grew the `./goldens/*.rss` arm. Nothing else assumed HTML:
 *     renderCase/renderRoute compare body TEXT (res.text()), and
 *     update-goldens.mjs is marker-based text extraction — no HTML
 *     parsing anywhere in the harness.
 *   - Known caveat (update-goldens.mjs is OUTSIDE this wave's ownership):
 *     the script enumerates/empties `goldens/*.html` only. `.rss` goldens
 *     are written through the union with the rendered marker names, so
 *     regeneration works, but a case REMOVED from FEED_GOLDEN_CASES leaves
 *     its stale file behind without the loud no-render failure the .html
 *     enumeration provides. The orchestrator should extend the script's
 *     `.html` filter when convenient.
 *   - Content-type determinism: the goldens assert the BODY (the envelope
 *     bytes); the a11y EXPANSION_ARMS are NOT applicable to these three —
 *     that suite parses goldens as HTML DOM trees (landmarks/headings/
 *     table-header rules) and RSS envelopes carry none of those structures,
 *     so no arms are declared for them in a11y.test.ts (the file is outside
 *     this wave's ownership anyway; its per-file `?raw` imports never see
 *     `.rss` names). The route's content-type header choice is pinned
 *     separately below (the gorilla writeFeed strings).
 */
const FEED_GOLDEN_CASES: GoldenCase[] = [
  { file: "user-feed-alice.rss", path: "/alice.rss", status: 200, signedIn: true },
  { file: "releases-feed.rss", path: "/alice/golden/releases.rss", status: 200 },
  { file: "tags-feed.rss", path: "/alice/golden/tags.rss", status: 200 },
];

describe("feed goldens (the wave-golden-feeds closures)", () => {
  for (const golden of FEED_GOLDEN_CASES) {
    it(`renders ${golden.file} byte-identical (200) under the pinned route clock`, async () => {
      // The channel stamps (RSS pubDate) are routeNow() bytes — the pin
      // must WRAP the render like the cron golden above (module-scope
      // seam, not a per-request field), and the try/finally restores the
      // wall clock even on failure so a broken golden cannot leak the pin
      // into sibling suites.
      __setRouteClockForTests(() => new Date(T0 * 1000));
      try {
        await renderGoldenCase(golden);
      } finally {
        __setRouteClockForTests(null);
      }
    });
  }

  it("serves the gorilla writeFeed content types on all three feed routes", async () => {
    // The case table pins the envelope BYTES; this pins the ROUTE's
    // content-type header choice (index.ts's per-family dispatch) — the
    // one non-body byte the XML surfaces carry that a body golden cannot
    // capture. The clock is irrelevant here (headers are clock-free), so
    // no pin wraps this arm.
    for (const [path, contentType] of [
      ["/alice.rss", "application/rss+xml;charset=utf-8"],
      ["/alice/golden/releases.rss", "application/rss+xml;charset=utf-8"],
      ["/alice/golden/tags.rss", "application/rss+xml;charset=utf-8"],
    ] as const) {
      const res = await uiRouter.fetch(new Request(`https://test.local${path}`), uiEnv);
      expect(res.headers.get("content-type"), path).toBe(contentType);
    }
  });
});

/**
 * The fixed-time writer's proof arm (the wave-wiki-fixedtime determinism
 * evidence — the write-path analogue of the route-clock override arm above):
 * the wiki view's last-edited bytes must be the SEEDED commit's pinned
 * stamps, not wall-clock bytes. timeSinceParts' datetime/text are pure
 * functions of the unix stamp, so the 2023 literals render exactly on every
 * machine and can never collide with a live render (the stamps predate every
 * run). The arm runs WITHOUT a route-clock pin on purpose: the wiki view's
 * TimeSince has no loader-level clock to pin (the stamp lives in the STORED
 * commit), which is precisely why the pin had to happen at write time.
 */
const WIKI_PINNED_DATETIME = "2023-11-14T22:16:50Z"; // T0 + 210 — the seed's now
const WIKI_PINNED_TEXT = "2023-11-14 22:16:50 +00:00"; // the +0000 tz form

const WIKI_VIEW_GOLDEN_CASE: GoldenCase = {
  file: "wiki-view-home.html",
  path: "/alice/golden-alt/wiki",
  status: 200,
  signedIn: true,
};

describe("wiki-view-home golden determinism (the fixed-time writer's proof)", () => {
  it("renders the seeded commit's pinned stamp, not wall-clock bytes", async () => {
    const { status, html } = await renderCase(WIKI_VIEW_GOLDEN_CASE);
    expect(status).toBe(200);
    // The datetime attribute and the tz-shifted text are the pinned stamp.
    expect(html).toContain(`datetime="${WIKI_PINNED_DATETIME}"`);
    expect(html).toContain(WIKI_PINNED_TEXT);
    // tense="past": the 2023 stamp sits before every run's wall clock, so
    // the one clock-reading attribute is stable for the fixtures' lifetime.
    expect(html).toContain('tense="past"');
    // The doer line carries the route derivation's identity (the "alice
    // edited this page" prefix completing the relative-time element).
    expect(html).toContain("alice edited this page");
  });

  it("renders identical bytes twice within one run (the stored pin needs no clock)", async () => {
    const first = await renderCase(WIKI_VIEW_GOLDEN_CASE);
    const second = await renderCase(WIKI_VIEW_GOLDEN_CASE);
    expect(second.status).toBe(first.status);
    expect(second.html).toBe(first.html);
  });
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
