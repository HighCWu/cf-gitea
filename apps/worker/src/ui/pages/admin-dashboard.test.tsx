/**
 * The ADMIN DASHBOARD's tests (the bench-row UNMOUNTED module — the
 * admin-monitor.test.tsx harness): the loader over the landed cron registry,
 * the parse/apply matrix (the run arm drives the landed
 * `enqueueDueMirrorSyncs` producer against a recording queue — the sync.test.ts
 * stub), and the DOM contract of the page render — hono/jsx renderToString,
 * the module driven directly (no route yet: the HANDOFF NOTE in the module
 * header).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repoMirrors } from "../../db/schema";
import type { UiManifest } from "../manifest";
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
  await env.DB.prepare("DELETE FROM repo_mirrors").run();
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

  it("renders the reduced admin navbar — Maintenance open with Dashboard active, the live monitor items, nothing unlanded", async () => {
    const html = await pageHtml();
    expect(html).toContain('class="active item" href="/-/admin"'); // the active page (navbar.tmpl:8's arm)
    expect(html).toContain('href="/-/admin/monitor/stats"'); // the sibling family's live items
    expect(html).toContain('href="/-/admin/monitor/cron"');
    expect(html).toContain('href="/-/admin/monitor/queue"');
    expect(html).toContain('href="/-/admin/monitor/stacktrace"');
    expect(html).not.toContain("self_check"); // unlanded — the dead-link rule
    expect(html).not.toContain('href="/-/admin/users"');
    expect(html).not.toContain('href="/-/admin/repos"');
    expect(html).not.toContain('href="/-/admin/config"');
    expect(html).not.toContain('href="/-/admin/notices"');
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
