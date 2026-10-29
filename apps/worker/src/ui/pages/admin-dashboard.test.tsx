/**
 * The ADMIN DASHBOARD's tests (the admin-monitor.test.tsx harness): the loader
 * over the landed cron registry, the parse/apply matrix (the run arm drives
 * the landed `enqueueDueMirrorSyncs` producer against a recording queue — the
 * sync.test.ts stub), and the DOM contract of the page render — hono/jsx
 * renderToString.
 *
 * The deferred matrix (the polish wave, after the window-2c mount e31c0cf):
 * the MOUNTED route arms driven through `uiRouter.fetch()` with a minted
 * session (GET /-/admin, POST /-/admin) — the anonymous 303 onto the login
 * round-trip, the signed-in non-admin's 404 shell, the admin GET's one live
 * maintenance row with upstream's 13 fixed ops as posture TEXT (no dead
 * buttons), the known-op POST's 200 re-render with the positive flash, the
 * unknown-op POST's negative task-unknown flash, and the cross-origin POST's
 * plain 403 (upstream web.go:779's SignInRequired+AdminRequired gate).
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
  // route arms (the session.test.ts cleanup list's auth half).
  for (const table of ["repo_mirrors", "users", "sessions"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the loader (the landed cron registry) -------------------------------------

describe("loadAdminDashboardData (the landed registry, the monitor loader's rows)", () => {
  it("answers the one landed maintenance row with the computed next fire", async () => {
    const { maintenance } = await loadAdminDashboardData(NOW);
    expect(maintenance).toHaveLength(1);
    expect(maintenance[0]!.name).toBe("update_mirrors");
    expect(maintenance[0]!.spec).toBe("*/10 * * * *");
    expect(maintenance[0]!.next).toEqual(new Date("2026-01-01T00:10:00Z")); // the next UTC step
    expect(maintenance[0]!.prev).toBeNull(); // never fired — the registry keeps no history
    expect(maintenance[0]!.execTimes).toBe(0);
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
});

// --- the DOM --------------------------------------------------------------------

describe("the dashboard DOM (templates/admin/dashboard.tmpl at the pin)", () => {
  async function pageHtml(flash: { kind: "positive" | "negative"; text: string } | null = null): Promise<string> {
    const data = await loadAdminDashboardData(NOW);
    return renderToString(<AdminDashboardPage ctx={ctx} data={data} flash={flash} />);
  }

  it("renders the pageClass discriminator, the two attached sections, and the landed run row", async () => {
    const html = await pageHtml();
    expect(html).toContain('class="page-content admin dashboard"'); // layout_head's pageClass (§2.4.1)
    expect(html).toContain(`>${adminDashboardLocale.maintenanceOperations}</h4>`);
    expect(html).toContain(`>${adminDashboardLocale.systemStatus}</h4>`);
    expect(html).toContain('<form method="post" action="/-/admin">'); // dashboard.tmpl:12, upstream's exact target
    expect(html).toContain("Update Mirrors"); // the row name (admin.dashboard.update_mirrors)
    expect(html).toContain('<button type="submit" class="ui primary button" name="op" value="update_mirrors">');
    expect(html).toContain(`>${adminDashboardLocale.operationRun}</button>`); // the Run label
  });

  it("renders the honest posture — the fixed-list note and the system-status note, never fake data", async () => {
    const html = await pageHtml();
    expect(html).toContain("delete_inactive_accounts"); // the fixed list, disclosed as text
    expect(html).toContain(adminDashboardLocale.systemStatusPosture.replaceAll("'", "&#39;")); // the escaped render
    expect(html).not.toContain("Goroutine"); // no fabricated runtime dl (system_status.tmpl's rows)
    expect(html).not.toContain("Heap"); // no fabricated memstats
    expect(html).not.toContain("is now available"); // the NeedUpdate hint renders nothing (card 1)
  });

  it("renders no dead controls — the unlanded ops appear as text only, never as buttons", async () => {
    const html = await pageHtml();
    expect(html).not.toContain('value="delete_inactive_accounts"');
    expect(html).not.toContain('value="delete_repo_archives"');
    expect(html).not.toContain('value="git_gc_repos"');
    expect(html).not.toContain('value="resync_all_sshkeys"');
    expect(html).not.toContain('value="sync_repo_branches"');
    expect(html).not.toContain('value="sync_repo_tags"');
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
    expect(html).not.toContain('href="/-/admin/config"');
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

/** Upstream's 13 fixed maintenance ops (admin.go:161-191) — the posture
 *  paragraph's TEXT payload, NEVER a Run button (the module header, card 2). */
const UPSTREAM_FIXED_OPS = [
  "delete_inactive_accounts",
  "delete_repo_archives",
  "delete_missing_repos",
  "git_gc_repos",
  "resync_all_sshkeys",
  "resync_all_sshprincipals",
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

  it("GET 200 for the site admin — the ONE live row and the 13 fixed ops as TEXT, never buttons", async () => {
    const res = await getAdminRoute(await mintSession(env.DB, 1));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content admin dashboard"');
    expect(html).toContain('<form method="post" action="/-/admin">');
    // The landed registry's ONE row: the update_mirrors cell and its Run
    // button, each rendered exactly once.
    expect(html.split("<td>Update Mirrors</td>").length - 1).toBe(1);
    expect(html.split('value="update_mirrors"').length - 1).toBe(1);
    // The posture paragraph carries all 13 upstream ops as TEXT.
    expect(html).toContain(adminDashboardLocale.maintenancePosture.replaceAll("'", "&#39;"));
    for (const op of UPSTREAM_FIXED_OPS) {
      expect(html).toContain(op); // disclosed as text ...
      expect(html).not.toContain(`value="${op}"`); // ... never a dead button
    }
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
