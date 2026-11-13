/**
 * The ADMIN DASHBOARD's tests (the admin-monitor.test.tsx harness): the loader
 * over the landed cron registry, the parse/apply matrix (the run arms drive
 * the landed producers against a recording queue — the sync.test.ts stub —
 * and the B-68 portable op drives the landed inactive-accounts sweep), and
 * the DOM contract of the page render — hono/jsx renderToString.
 *
 * The deferred matrix (the polish wave, after the window-2c mount e31c0cf):
 * the MOUNTED route arms driven through `uiRouter.fetch()` with a minted
 * session (GET /-/admin, POST /-/admin) — the anonymous 303 onto the login
 * round-trip, the signed-in non-admin's 404 shell, the admin GET's live rows
 * with the STANDING fixed ops as posture TEXT (no dead buttons), the
 * known-op POSTs' 200 re-render with the positive flash, the unknown-op
 * POST's negative task-unknown flash, and the cross-origin POST's plain 403
 * (upstream web.go:779's SignInRequired+AdminRequired gate).
 *
 * B-68 (2026-11-13): the fixed list's PORTABLE member `delete_inactive_accounts`
 * is a live row + POST arm over services/user-accounts.ts deleteInactiveAccounts;
 * every rendered registry button now really runs (the composed monitor
 * dispatch — the dead-control gap closed); the SSH resync pair renders
 * NOTHING (upstream's own dashboard.tmpl:31 conditional at the platform's
 * Disabled posture); the posture note narrowed to the standing ten.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repoMirrors } from "../../db/schema";
import type { UiManifest } from "../manifest";
import { locale } from "../locale";
import { uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import {
  AdminDashboardPage,
  adminDashboardLocale,
  applyAdminDashboardForm,
  loadAdminDashboardData,
  parseAdminDashboardForm,
  renderAdminDashboardPage,
} from "./admin-dashboard";
import { adminFamilyLocale } from "./admin-users";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The signed-in site admin viewing the page (the route stage's gate —
 *  verifyAuthWithOptionsWeb SignInRequired+AdminRequired — is the wiring
 *  wave's posture; the module trusts its inputs like every landed load
 *  function). */
const viewer: Viewer = { kind: "user", id: 1, username: "admin", isAdmin: true };
const ctx: UiContext = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };

const NOW = new Date("2026-01-01T00:00:00Z");

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // repo_mirrors: the loader/apply fixtures. users+sessions: the minted-session
  // route arms (the session.test.ts cleanup list's auth half). cron_state: the
  // composed registry dispatch records manual-run ticks (the B-68 compose).
  // repositories: the sweep's owner-skip fixture.
  for (const table of ["repo_mirrors", "users", "sessions", "cron_state", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the loader (the landed cron registry) -------------------------------------

describe("loadAdminDashboardData (the landed registry, the monitor loader's rows)", () => {
  it("answers the SIX runnable maintenance rows with computed next fires (the census absorption 067449a grew the set, W8's 2b15f6f added cleanup_hook_task_table — the pinned spec shapes per arm)", async () => {
    const { maintenance } = await loadAdminDashboardData(NOW);
    // The runnable registry (CRON_RUN_BODIES): update_mirrors, update_push_mirrors,
    // demo_sweep, delete_old_audit_events, cleanup_packages,
    // cleanup_hook_task_table — the census order.
    expect(maintenance.map((row) => row.name)).toEqual([
      "update_mirrors",
      "update_push_mirrors",
      "demo_sweep",
      "delete_old_audit_events",
      "cleanup_packages",
      "cleanup_hook_task_table",
    ]);
    expect(maintenance[0]!.spec).toBe("*/10 * * * *");
    expect(maintenance[0]!.next).toEqual(new Date("2026-01-01T00:10:00Z")); // the next UTC step
    // The second step arm (update_push_mirrors rides the same */10 entry).
    expect(maintenance[1]!.name).toBe("update_push_mirrors");
    expect(maintenance[1]!.spec).toBe("*/10 * * * *");
    expect(maintenance[1]!.next).toEqual(new Date("2026-01-01T00:10:00Z"));
    // The four hourly arms (0 * * * * — the top of the next hour).
    const hourly = maintenance.slice(2);
    expect(hourly.map((row) => row.name)).toEqual([
      "demo_sweep",
      "delete_old_audit_events",
      "cleanup_packages",
      "cleanup_hook_task_table",
    ]);
    for (const row of hourly) {
      expect(row.spec).toBe("0 * * * *");
      expect(row.next).toEqual(new Date("2026-01-01T01:00:00Z"));
    }
    for (const row of maintenance) {
      expect(row.prev).toBeNull(); // never fired — the registry keeps no history
      expect(row.execTimes).toBe(0);
    }
  });
});

// --- the POST parse -------------------------------------------------------------

describe("parseAdminDashboardForm (the run form's op field)", () => {
  it("extracts the op; an absent op is the failed-binding null", () => {
    expect(parseAdminDashboardForm(new URLSearchParams("op=update_mirrors"))).toEqual({ op: "update_mirrors" });
    expect(parseAdminDashboardForm(new URLSearchParams())).toEqual({ op: null });
    expect(parseAdminDashboardForm(new URLSearchParams("from=monitor"))).toEqual({ op: null });
  });
});

// --- the POST apply (DashboardPost's cron arm over the landed producer) ---------

describe("applyAdminDashboardForm (DashboardPost's cron arm over the landed producer)", () => {
  /** MIRROR_SYNC_QUEUE stub — records sendBatch bodies (the sync.test.ts
   *  shape; the admin-monitor.test.tsx copy is the precedent). */
  function recordingQueue(): Queue & { batches: unknown[][] } {
    const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
    const batches: unknown[][] = [];
    return {
      batches,
      send: () => Promise.resolve({ metadata }),
      sendBatch: (messages: MessageSendRequest[]) => {
        batches.push(messages.map((m) => m.body));
        return Promise.resolve({ metadata });
      },
      metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
    };
  }

  /** One seeded due mirror (the producer's due-SELECT arm: idle + due). */
  async function seedDueMirror(): Promise<void> {
    await drizzle(env.DB)
      .insert(repoMirrors)
      .values({
        repoId: "7401",
        remoteAddress: "https://src.test/owner/repo.git",
        intervalSeconds: 600,
        nextSyncAt: Math.floor(NOW.getTime() / 1000) - 60, // due a minute ago
        syncState: "idle",
      })
      .run();
  }

  it("the known task runs the landed producer — run = enqueue, row flips queued", async () => {
    await seedDueMirror();
    const queue = recordingQueue();
    const result = await applyAdminDashboardForm({ ...env, MIRROR_SYNC_QUEUE: queue }, { op: "update_mirrors" }, { now: NOW });
    expect(result).toEqual({ outcome: "applied", message: "Started Task: Update Mirrors" });
    expect(queue.batches).toEqual([[{ kind: "mirror-sync", repoId: "7401" }]]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("queued");
  });

  it("an unknown task — including upstream's queue ops — answers task.unknown WITHOUT running anything", async () => {
    await seedDueMirror();
    const queue = recordingQueue();
    const result = await applyAdminDashboardForm({ ...env, MIRROR_SYNC_QUEUE: queue }, { op: "sync_repo_branches" }, { now: NOW });
    expect(result).toEqual({ outcome: "invalid", message: "Unknown task: sync_repo_branches" });
    expect(queue.batches).toEqual([]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("idle"); // untouched
  });

  it("a failed binding funnels to the unknown arm (never runs)", async () => {
    const queue = recordingQueue();
    const result = await applyAdminDashboardForm({ ...env, MIRROR_SYNC_QUEUE: queue }, { op: null }, { now: NOW });
    expect(result).toEqual({ outcome: "invalid", message: "Unknown task: " });
    expect(queue.batches).toEqual([]);
  });

  it("a rendered registry arm runs its REAL body through the composed monitor dispatch (the dead-control fix — demo_sweep's gate-off producer, not task.unknown)", async () => {
    const queue = recordingQueue();
    const result = await applyAdminDashboardForm({ ...env, MIRROR_SYNC_QUEUE: queue }, { op: "demo_sweep" }, { now: NOW });
    // demo_sweep's body runs (the DEMO_MODE gate off → zero enqueues) and the
    // flash is task.started with the monitor dispatch's locale name — before
    // B-68 this POST answered task.unknown with the button rendered, a dead
    // control.
    expect(result).toEqual({ outcome: "applied", message: "Started Task: Demo Sweep" });
    expect(queue.batches).toEqual([]);
    // The composed dispatch recorded the manual-run tick (upstream's
    // ExecTimes counts run STARTS on the shared RunWithUser path).
    const ticks = await env.DB.prepare("SELECT arm, runs FROM cron_state WHERE arm = 'demo_sweep'").all<{ arm: string; runs: number }>();
    expect(ticks.results).toEqual([{ arm: "demo_sweep", runs: 1 }]);
  });

  it("the SSH pair's ops answer task.unknown — platform-forced, no run body exists to answer them", async () => {
    const result = await applyAdminDashboardForm(env, { op: "resync_all_sshkeys" }, { now: NOW });
    expect(result).toEqual({ outcome: "invalid", message: "Unknown task: resync_all_sshkeys" });
  });
});

// --- the B-68 portable op (delete_inactive_accounts over the landed sweep) -------

describe("applyAdminDashboardForm op=delete_inactive_accounts (the B-68 sweep)", () => {
  /** The sweep's five fixture shapes (services/user-accounts.ts
   *  deleteInactiveAccounts' predicate + skip guards): an aged prohibited
   *  human (the candidate), a fresh prohibited human, an aged prohibited
   *  OWNER, an aged ACTIVE human and an aged SYSTEM-shaped row (prohibited
   *  non-admin with no email — the NON_SYSTEM_USER_ROW exclusion). */
  async function seedSweepUsers(): Promise<void> {
    await env.DB
      .prepare(
        "INSERT INTO users (id, username, username_lower, email, status, is_admin, type, created_at) VALUES " +
          // the candidate: prohibited, human (email set), older than the 180-minute window
          "(101, 'stale', 'stale', 'stale@test.local', 'prohibited', 0, 'user', strftime('%s','2025-06-01')), " +
          // fresh prohibition: younger than the 180-minute window (an hour before NOW)
          "(102, 'fresh', 'fresh', 'fresh@test.local', 'prohibited', 0, 'user', strftime('%s','2025-12-31 23:00:00')), " +
          // aged prohibited but OWNS a repo (the IsErrUserOwnRepos skip)
          "(103, 'oldowner', 'oldowner', 'oldowner@test.local', 'prohibited', 0, 'user', strftime('%s','2025-06-01')), " +
          // aged ACTIVE human (never a candidate)
          "(104, 'ordinary', 'ordinary', 'ordinary@test.local', 'active', 0, 'user', strftime('%s','2025-06-01')), " +
          // the system-principal shape (prohibited + non-admin + no email)
          "(105, 'assets-twin', 'assets-twin', NULL, 'prohibited', 0, 'user', strftime('%s','2025-06-01'))",
      )
      .run();
    await env.DB
      .prepare(
        "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, visibility) VALUES " +
          "('swrepo', 'r_swrepo', 'oldowner', 103, 'swrepo', 'public')",
      )
      .run();
  }

  async function survivingIds(): Promise<number[]> {
    const rows = await env.DB.prepare("SELECT id FROM users ORDER BY id").all<{ id: number }>();
    return rows.results.map((row) => row.id);
  }

  it("deletes ONLY the aged prohibited non-owner human — the recent, the owner, the active and the system-shaped survive", async () => {
    await seedSweepUsers();
    const result = await applyAdminDashboardForm(env, { op: "delete_inactive_accounts" }, { now: NOW });
    expect(result).toEqual({
      outcome: "applied",
      message: "Started Task: Delete all unactivated accounts",
    });
    expect(await survivingIds()).toEqual([102, 103, 104, 105]);
    // The owner's repo row is untouched (the skip guard ran BEFORE any cascade).
    const repos = await env.DB.prepare("SELECT id FROM repositories").all<{ id: string }>();
    expect(repos.results.map((row) => row.id)).toEqual(["swrepo"]);
  });

  it("a second run is idempotent — the sweep's answer stays applied with nothing left to delete", async () => {
    await seedSweepUsers();
    await applyAdminDashboardForm(env, { op: "delete_inactive_accounts" }, { now: NOW });
    const second = await applyAdminDashboardForm(env, { op: "delete_inactive_accounts" }, { now: NOW });
    expect(second).toEqual({ outcome: "applied", message: "Started Task: Delete all unactivated accounts" });
    expect(await survivingIds()).toEqual([102, 103, 104, 105]);
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the dashboard DOM (templates/admin/dashboard.tmpl at the pin)", () => {
  async function pageHtml(flash: { kind: "positive" | "negative"; text: string } | null = null): Promise<string> {
    const data = await loadAdminDashboardData(NOW);
    return renderToString(<AdminDashboardPage ctx={ctx} data={data} flash={flash} />);
  }

  it("renders the pageClass discriminator, the two attached sections, the B-68 portable row, and the landed run rows", async () => {
    const html = await pageHtml();
    expect(html).toContain('class="page-content admin dashboard"'); // layout_head's pageClass (§2.4.1)
    expect(html).toContain(`>${adminDashboardLocale.maintenanceOperations}</h4>`);
    expect(html).toContain(`>${adminDashboardLocale.systemStatus}</h4>`);
    expect(html).toContain('<form method="post" action="/-/admin">'); // dashboard.tmpl:12, upstream's exact target
    // The B-68 portable member — dashboard.tmpl:14-17's FIRST row as a live
    // button (the label is upstream's locale string verbatim).
    expect(html).toContain("Delete all unactivated accounts");
    expect(html).toContain('<button type="submit" class="ui primary button" name="op" value="delete_inactive_accounts">');
    expect(html).toContain("Update Mirrors"); // the registry row name (admin.dashboard.update_mirrors)
    expect(html).toContain('<button type="submit" class="ui primary button" name="op" value="update_mirrors">');
    expect(html).toContain(`>${adminDashboardLocale.operationRun}</button>`); // the Run label
  });

  it("renders the honest posture — the narrowed standing-ops note and the system-status note, never fake data", async () => {
    const html = await pageHtml();
    expect(html).toContain("The remaining fixed maintenance operations"); // the B-68 narrowed note
    expect(html).toContain("sync_repo_branches"); // the standing members, disclosed as text
    expect(html).toContain(adminDashboardLocale.systemStatusPosture.replaceAll("'", "&#39;")); // the escaped render
    expect(html).not.toContain("Goroutine"); // no fabricated runtime dl (system_status.tmpl's rows)
    expect(html).not.toContain("Heap"); // no fabricated memstats
    expect(html).not.toContain("is now available"); // the NeedUpdate hint renders nothing (card 1)
  });

  it("renders no dead controls — the standing ops appear as text only, never as buttons; the SSH pair hides entirely (upstream's conditional)", async () => {
    const html = await pageHtml();
    expect(html).toContain('value="delete_inactive_accounts"'); // the B-68 portable member IS a live button
    expect(html).not.toContain('value="delete_repo_archives"');
    expect(html).not.toContain('value="delete_missing_repos"');
    expect(html).not.toContain('value="git_gc_repos"');
    expect(html).not.toContain('value="reinit_missing_repos"');
    expect(html).not.toContain('value="sync_external_users"');
    expect(html).not.toContain('value="repo_health_check"');
    expect(html).not.toContain('value="delete_generated_repository_avatars"');
    expect(html).not.toContain('value="sync_repo_branches"');
    expect(html).not.toContain('value="sync_repo_tags"');
    // dashboard.tmpl:31-40's conditional at the Disabled posture — the rows
    // AND their labels render NOTHING (no partial disclosure).
    expect(html).not.toContain('value="resync_all_sshkeys"');
    expect(html).not.toContain('value="resync_all_sshprincipals"');
    expect(html).not.toContain("authorized_keys");
    expect(html).not.toContain("authorized_principals");
  });

  it("renders the shared admin navbar — Maintenance open with Dashboard active, every landed family item, nothing unlanded (the F7 fold)", async () => {
    const html = await pageHtml();
    expect(html).toContain('class="active item" href="/-/admin"'); // the active page (navbar.tmpl:8's arm)
    expect(html).toContain('href="/-/admin/monitor/stats"'); // the live monitor items
    expect(html).toContain('href="/-/admin/monitor/cron"');
    expect(html).toContain('href="/-/admin/monitor/queue"');
    expect(html).toContain('href="/-/admin/monitor/stacktrace"');
    // The fold's new groups: Identity & Access (orgs/users) + Assets (repos).
    // The `&` renders escaped (hono/jsx text escaping).
    expect(html).toContain("Identity &amp; Access");
    expect(html).toContain(adminFamilyLocale.assets);
    expect(html).toContain('href="/-/admin/users"');
    expect(html).toContain('href="/-/admin/orgs"');
    expect(html).toContain('href="/-/admin/repos"');
    // The OPEN group is the active page's (Maintenance); the sibling groups
    // stay closed (navbar.tmpl's per-group PageIs* conditions).
    expect(html).toContain(`<details class="item" open=""><summary>${adminFamilyLocale.maintenance}</summary>`);
    expect(html).not.toContain(`<details class="item" open=""><summary>${adminFamilyLocale.monitoring}</summary>`);
    expect(html).not.toContain(`<details class="item" open=""><summary>${adminFamilyLocale.identityAccess}</summary>`);
    expect(html).not.toContain("self_check"); // unlanded — the dead-link rule
    expect(html).toContain('href="/-/admin/config"'); // SPEC-0018 §3.2's Configuration group (the Summary item)
    expect(html).toContain('href="/-/admin/notices"'); // SPEC-0018 §3.1's top-level item
  });

  it("the flash arm renders the POST answer banner inside the form (the no-JS convention)", async () => {
    const positive = await pageHtml({ kind: "positive", text: "Started Task: Update Mirrors" });
    expect(positive).toContain('<div class="ui positive message">Started Task: Update Mirrors</div>');
    const negative = await pageHtml({ kind: "negative", text: "Unknown task: x" });
    expect(negative).toContain('<div class="ui negative message">Unknown task: x</div>');
    expect(await pageHtml()).not.toContain("ui positive message");
    expect(await pageHtml()).not.toContain("ui negative message");
  });

  it("the full-document render path matches the component path", async () => {
    const data = await loadAdminDashboardData(NOW);
    const html = renderAdminDashboardPage({ ctx, data, flash: null });
    expect(html).toContain('class="page-content admin dashboard"');
    expect(html).toContain("Update Mirrors");
    expect(html).toContain(adminDashboardLocale.systemStatusPosture.replaceAll("'", "&#39;")); // the escaped render
  });
});

// --- the mounted route arms (the window-2c mount, driven through uiRouter.fetch) --

type DashboardUiTestEnv = Omit<Env, "ASSETS" | "MIRROR_SYNC_QUEUE"> & {
  ASSETS?: UiAssetsFetcher;
  MIRROR_SYNC_QUEUE?: Queue;
};

const dashboardAssets: UiAssetsFetcher = {
  fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })),
};

const dashboardUiEnv: DashboardUiTestEnv = { ...env, ASSETS: dashboardAssets };

/** Upstream's fixed maintenance ops (admin.go:161-191) that STAND — the
 *  posture paragraph's TEXT payload, NEVER a Run button (the B-68 split:
 *  delete_inactive_accounts left the set for the live row; the SSH pair is
 *  upstream's own conditional-hide and renders nothing at all). */
const STANDING_FIXED_OPS = [
  "delete_repo_archives",
  "delete_missing_repos",
  "git_gc_repos",
  "resync_all_hooks",
  "reinit_missing_repos",
  "sync_external_users",
  "repo_health_check",
  "delete_generated_repository_avatars",
  "sync_repo_branches",
  "sync_repo_tags",
] as const;

describe("the mounted /-/admin route arms (window-2c)", () => {
  /** MIRROR_SYNC_QUEUE stub — records sendBatch bodies (the
   *  applyAdminDashboardForm describe's shape; the admin-monitor copy is the
   *  precedent). */
  function recordingQueue(): Queue & { batches: unknown[][] } {
    const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
    const batches: unknown[][] = [];
    return {
      batches,
      send: () => Promise.resolve({ metadata }),
      sendBatch: (messages: MessageSendRequest[]) => {
        batches.push(messages.map((m) => m.body));
        return Promise.resolve({ metadata });
      },
      metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
    };
  }

  /** The route gate's two non-anonymous principals: the site admin (user 1)
   *  and a signed-in plain member (user 2 — AdminRequired's 404 arm). */
  beforeEach(async () => {
    await env.DB
      .prepare(
        "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES " +
          "(1, 'admin', 'admin', 'Site Admin', 1, unixepoch()), " +
          "(2, 'member', 'member', 'Plain Member', 0, unixepoch())",
      )
      .run();
  });

  /** One seeded due mirror — the route's apply runs at REAL now (the handler
   *  passes no `now`), so the row is due a minute before the wall clock. */
  async function seedDueMirror(): Promise<void> {
    await drizzle(env.DB)
      .insert(repoMirrors)
      .values({
        repoId: "7401",
        remoteAddress: "https://src.test/owner/repo.git",
        intervalSeconds: 600,
        nextSyncAt: Math.floor(Date.now() / 1000) - 60,
        syncState: "idle",
      })
      .run();
  }

  async function getAdminRoute(cookie: string | null): Promise<Response> {
    return uiRouter.fetch(
      new Request(`${ORIGIN}/-/admin`, {
        headers: cookie === null ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      }),
      dashboardUiEnv,
    );
  }

  async function postAdminRoute(
    fields: Record<string, string>,
    cookie: string,
    overrides: { env?: DashboardUiTestEnv; origin?: string } = {},
  ): Promise<Response> {
    return uiRouter.fetch(
      new Request(`${ORIGIN}/-/admin`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: overrides.origin ?? ORIGIN, // sameOriginGuard's matching-origin arm
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        },
        body: new URLSearchParams(fields).toString(),
      }),
      overrides.env ?? dashboardUiEnv,
    );
  }

  it("GET 200 for the site admin — the live rows and the STANDING fixed ops as TEXT, never dead buttons", async () => {
    const res = await getAdminRoute(await mintSession(env.DB, 1));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content admin dashboard"');
    expect(html).toContain('<form method="post" action="/-/admin">');
    // The landed registry's update_mirrors row: cell and Run button, each
    // rendered exactly once.
    expect(html.split("<td>Update Mirrors</td>").length - 1).toBe(1);
    expect(html.split('value="update_mirrors"').length - 1).toBe(1);
    // The B-68 portable member: the live fixed row, rendered exactly once
    // (the label is upstream's locale string).
    expect(html.split("<td>Delete all unactivated accounts</td>").length - 1).toBe(1);
    expect(html.split('value="delete_inactive_accounts"').length - 1).toBe(1);
    // The posture paragraph carries the STANDING upstream ops as TEXT.
    expect(html).toContain(adminDashboardLocale.maintenancePosture.replaceAll("'", "&#39;"));
    for (const op of STANDING_FIXED_OPS) {
      expect(html).toContain(op); // disclosed as text ...
      expect(html).not.toContain(`value="${op}"`); // ... never a dead button
    }
    // The SSH pair: dashboard.tmpl:31's conditional renders NOTHING (the
    // platform's Disabled posture) — neither buttons nor text.
    expect(html).not.toContain("authorized_keys");
  });

  it("POST op=delete_inactive_accounts runs the landed sweep — the aged prohibited non-owner goes, the guarded and system-shaped survive", async () => {
    await env.DB
      .prepare(
        "INSERT INTO users (id, username, username_lower, email, status, is_admin, type, created_at) VALUES " +
          "(201, 'stale2', 'stale2', 'stale2@test.local', 'prohibited', 0, 'user', strftime('%s','2025-06-01')), " +
          "(202, 'keeper', 'keeper', 'keeper@test.local', 'active', 0, 'user', strftime('%s','2025-06-01')), " +
          "(203, 'assets-twin2', 'assets-twin2', NULL, 'prohibited', 0, 'user', strftime('%s','2025-06-01'))",
      )
      .run();
    const res = await postAdminRoute({ op: "delete_inactive_accounts" }, await mintSession(env.DB, 1));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui positive message">Started Task: Delete all unactivated accounts</div>');
    expect(html).toContain('<form method="post" action="/-/admin">'); // the fresh re-render
    const ids = await env.DB.prepare("SELECT id FROM users ORDER BY id").all<{ id: number }>();
    expect(ids.results.map((row) => row.id)).toEqual([1, 2, 202, 203]); // the session principals + the survivors
  });

  it("POST op=demo_sweep runs the registry body (the composed dispatch) — positive flash, not task.unknown", async () => {
    const res = await postAdminRoute({ op: "demo_sweep" }, await mintSession(env.DB, 1));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui positive message">Started Task: Demo Sweep</div>');
  });

  it("GET 303s the anonymous viewer onto the login round-trip (web.go:779's SignInRequired)", async () => {
    const res = await getAdminRoute(null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/admin")}`);
  });

  it("GET 404-shells the signed-in non-admin (AdminRequired's hidden-surface posture)", async () => {
    const res = await getAdminRoute(await mintSession(env.DB, 2));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain(locale.error404_box_title); // the 404 shell, not the dashboard
    expect(html).not.toContain('class="page-content admin dashboard"');
    expect(html).not.toContain("Update Mirrors");
  });

  it("POST op=update_mirrors re-renders 200 with the positive flash and the producer ran", async () => {
    await seedDueMirror();
    const queue = recordingQueue();
    const res = await postAdminRoute({ op: "update_mirrors" }, await mintSession(env.DB, 1), {
      env: { ...dashboardUiEnv, MIRROR_SYNC_QUEUE: queue },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui positive message">Started Task: Update Mirrors</div>');
    expect(html).toContain('<form method="post" action="/-/admin">'); // the fresh re-render
    expect(queue.batches).toEqual([[{ kind: "mirror-sync", repoId: "7401" }]]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("queued");
  });

  it("POST an unknown op re-renders 200 with the negative task-unknown flash and runs nothing", async () => {
    await seedDueMirror();
    const queue = recordingQueue();
    const res = await postAdminRoute({ op: "sync_repo_branches" }, await mintSession(env.DB, 1), {
      env: { ...dashboardUiEnv, MIRROR_SYNC_QUEUE: queue },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">Unknown task: sync_repo_branches</div>');
    expect(queue.batches).toEqual([]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("idle"); // untouched
  });

  it("POST from a cross-origin origin answers the plain 403 before the gate and runs nothing", async () => {
    await seedDueMirror();
    const queue = recordingQueue();
    const res = await postAdminRoute({ op: "update_mirrors" }, await mintSession(env.DB, 1), {
      env: { ...dashboardUiEnv, MIRROR_SYNC_QUEUE: queue },
      origin: "https://evil.test",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(queue.batches).toEqual([]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("idle"); // untouched
  });
});
