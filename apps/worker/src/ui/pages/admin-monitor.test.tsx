/**
 * The ADMIN MONITOR family's tests (the bench-row module, MOUNTED since
 * window-2c e31c0cf — GET /-/admin/monitor/{stats,cron,queue,stacktrace} +
 * POST cron at ui/index.ts): the stats/queue loaders over real D1 (generated
 * migrations in beforeAll; the counts read the same tables the API families
 * write), the cron registry/parse/apply matrix (the run arms drive the landed
 * CRON_RUN_BODIES producers against recording queues — the sync.test.ts
 * stub), and the DOM contract of the four page renders —
 * hono/jsx renderToString, the module driven directly. The deferred-test
 * matrix also drives the real routes (the org-blocked matrix's minted-session
 * uiRouter pattern): the adminPagePrologue's anonymous-303 / non-admin-404-
 * shell posture on GET and POST, the admin's four 200s with each pageClass
 * discriminator, the cron run POST's no-JS re-render with the positive flash
 * (op=update_mirrors) and the unknown-op negative flash, the guard-first
 * cross-origin 403, and the route-claim pin (the bare monitor tail, junk
 * page names and deeper tails unclaimed → the engine's 404).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import {
  auditEvents,
  comments,
  commitStatuses,
  follows,
  issueAttachments,
  issues,
  labels,
  milestones,
  oauth2Applications,
  packageCleanupRules,
  projectColumns,
  projects,
  publicKeys,
  pushMirrors,
  releaseAssets,
  releases,
  repoMirrors,
  repoWatchers,
  repositories,
  stars,
  teams,
  users,
  webhookDeliveries,
  webhooks,
} from "../../db/schema";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest } from "../ui-context";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import {
  AdminMonitorCronPage,
  AdminMonitorQueuePage,
  AdminMonitorStatsPage,
  AdminMonitorTracePage,
  adminMonitorLocale,
  applyAdminMonitorCronForm,
  formatMonitorFullTime,
  loadAdminMonitorCron,
  loadAdminMonitorCronRunState,
  loadAdminMonitorQueues,
  loadAdminMonitorStats,
  parseAdminMonitorCronForm,
  renderAdminMonitorCronPage,
} from "./admin-monitor";
import { AdminFamilyNav } from "./admin-users";
import { armsForEntry, listCronState, recordArmsFailure, recordArmsSuccess } from "../../services/cron-state";

const LATER = new Date("2026-01-01T13:00:00Z");

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The signed-in site admin viewing the pages (the route stage's gate —
 *  verifyAuthWithOptionsWeb SignInRequired+AdminRequired — is the wiring
 *  wave's posture; the module trusts its inputs like every landed load
 *  function). */
const viewer: Viewer = { kind: "user", id: 1, username: "admin", isAdmin: true };
const ctx: UiContext = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };

const AT = new Date("2026-01-01T00:00:00Z");

/** Tables the fixtures write (the blocked-users harness's cleanup list;
 *  "sessions" explicit — the mounted-route matrix below mints session rows,
 *  the applications-tab reset's posture). Children first: the batch-12 arms
 *  seed teams/projects/columns/stars/watchers/commit-statuses whose rows
 *  reference the users/repositories rows the sweep also clears. */
const FIXTURE_TABLES = [
  "audit_event",
  "comments",
  "commit_statuses",
  "cron_state",
  "follows",
  "issue_attachments",
  "issues",
  "labels",
  "milestones",
  "oauth2_application",
  "package_cleanup_rules",
  "project_columns",
  "projects",
  "public_keys",
  "push_mirrors",
  "release_assets",
  "releases",
  "repo_mirrors",
  "repo_watchers",
  "repositories",
  "sessions",
  "stars",
  "teams",
  "users",
  "webhook_deliveries",
  "webhooks",
];

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of FIXTURE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the stats loader ----------------------------------------------------------

describe("loadAdminMonitorStats (GetStatistic's landed-table subset, sorted keys)", () => {
  it("an empty store answers all-zero counters under the exact key list", async () => {
    const { stats } = await loadAdminMonitorStats(env.DB);
    expect(stats).toEqual([
      ["Attachment", 0],
      ["Comment", 0],
      ["CommitStatus", 0],
      ["Follow", 0],
      ["HookTask", 0],
      ["Issue", 0],
      ["IssueClosed", 0],
      ["IssueOpen", 0],
      ["Label", 0],
      ["Milestone", 0],
      ["Mirror", 0],
      ["Oauth", 0],
      ["Org", 0],
      ["Project", 0],
      ["ProjectColumn", 0],
      ["PublicKey", 0],
      ["Release", 0],
      ["Repo", 0],
      ["Star", 0],
      ["Team", 0],
      ["UsersActive", 0],
      ["UsersNotActive", 0],
      ["Watch", 0],
      ["Webhook", 0],
    ]);
  });

  it("counts the landed tables under upstream's key names", async () => {
    const db = drizzle(env.DB);
    const userRows = await db
      .insert(users)
      .values([
        { username: "alice", usernameLower: "alice", type: "user", status: "active", createdAt: AT },
        { username: "bob", usernameLower: "bob", type: "user", status: "active", createdAt: AT },
        { username: "carol", usernameLower: "carol", type: "user", status: "prohibited", createdAt: AT },
        { username: "acme", usernameLower: "acme", type: "org", status: "active", createdAt: AT },
      ])
      .returning({ id: users.id })
      .all();
    await db
      .insert(repositories)
      .values([
        { id: "r1", storageKey: "r_r1", ownerNamespace: "alice", ownerId: userRows[0]!.id, slug: "one", visibility: "public", createdAt: AT },
        { id: "r2", storageKey: "r_r2", ownerNamespace: "alice", ownerId: userRows[0]!.id, slug: "two", visibility: "public", createdAt: AT },
      ])
      .run();
    await db
      .insert(issues)
      .values([
        { repoId: "r1", index: 1, title: "a", isClosed: false, createdAt: AT },
        { repoId: "r1", index: 2, title: "b", isClosed: false, createdAt: AT },
        { repoId: "r2", index: 1, title: "c", isClosed: true, createdAt: AT },
      ])
      .run();
    await db.insert(comments).values([{ type: 0, issueId: 1, posterId: userRows[0]!.id, content: "x", createdAt: AT }]).run();
    await db.insert(follows).values([{ userId: userRows[0]!.id, followId: userRows[1]!.id, createdAt: AT }]).run();
    const hookRows = await db
      .insert(webhooks)
      .values([{ repoId: "r1", url: "https://hook.test", events: "{}", isActive: true, createdAt: AT }])
      .returning({ id: webhooks.id })
      .all();
    await db
      .insert(webhookDeliveries)
      .values([
        { hookId: hookRows[0]!.id, repoId: "r1", uuid: "u1", eventType: "issues", eventGroup: "issues", payloadContent: "{}", state: "delivered", createdAt: AT },
        { hookId: hookRows[0]!.id, repoId: "r1", uuid: "u2", eventType: "issues", eventGroup: "issues", payloadContent: "{}", state: "pending", createdAt: AT },
      ])
      .run();
    const releaseRows = await db
      .insert(releases)
      .values([{ repoId: "r1", publisherId: userRows[0]!.id, tagName: "v1", lowerTagName: "v1", title: "v1", createdAt: AT }])
      .returning({ id: releases.id })
      .all();
    await db
      .insert(releaseAssets)
      .values([{ uuid: "ra1", repoId: "r1", releaseId: releaseRows[0]!.id, name: "a.zip", r2Key: "r1/ra1", createdAt: AT }])
      .run();
    await db
      .insert(issueAttachments)
      .values([{ uuid: "ia1", issueId: 1, uploaderId: userRows[0]!.id, name: "note.txt", createdAt: AT }])
      .run();

    const { stats } = await loadAdminMonitorStats(env.DB);
    const byKey = new Map(stats);
    // Users split active/not-active; orgs are the Org counter (never Users*).
    expect(byKey.get("UsersActive")).toBe(2);
    expect(byKey.get("UsersNotActive")).toBe(1);
    expect(byKey.get("Org")).toBe(1);
    expect(byKey.get("Repo")).toBe(2);
    expect(byKey.get("Issue")).toBe(3); // the open + closed sum (statistic.go:122)
    expect(byKey.get("IssueOpen")).toBe(2);
    expect(byKey.get("IssueClosed")).toBe(1);
    expect(byKey.get("Comment")).toBe(1);
    expect(byKey.get("Follow")).toBe(1);
    expect(byKey.get("Webhook")).toBe(1);
    expect(byKey.get("HookTask")).toBe(2); // the delivery-log rows are upstream's hook_task
    expect(byKey.get("Release")).toBe(1);
    expect(byKey.get("Attachment")).toBe(2); // issue_attachments + release_assets summed
    // The keys stay sorted (MonitorStats' sort.Strings, admin.go:287).
    const keys = stats.map(([key]) => key);
    expect(keys).toEqual([...keys].sort());
  });

  // wave-polish-matrix-12 — the MIGRATION-PLACEHOLDER fixture edge: the
  // ledger seeds two permanently-prohibited principals (the un-takeable
  // 'assets' reservation, 0003_glossy_turbo.sql, and the deploy-key system
  // user id -3, 0020_mute_nocturne.sql). The beforeEach wipe removes them,
  // so this arm restores the migrations' exact INSERTs and pins where the
  // derivations file them: UsersNotActive (type user + status prohibited) —
  // never UsersActive, never Org.
  it("the migration-placeholder principals land in UsersNotActive — never UsersActive or Org", async () => {
    await env.DB
      .prepare(
        "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (-3, 'gitea:deploy-key', 'gitea:deploy-key', 0, 'prohibited', 0)",
      )
      .run();
    await env.DB
      .prepare(
        "INSERT INTO users (username, username_lower, is_admin, status, created_at) VALUES ('assets', 'assets', 0, 'prohibited', 0)",
      )
      .run();

    const { stats } = await loadAdminMonitorStats(env.DB);
    const byKey = new Map(stats);
    expect(byKey.get("UsersNotActive")).toBe(2);
    expect(byKey.get("UsersActive")).toBe(0);
    expect(byKey.get("Org")).toBe(0);
    expect(byKey.get("Repo")).toBe(0);
    expect(byKey.get("Issue")).toBe(0);
  });

  // wave-polish-matrix-12 — the counters the first fixture pass never seeded:
  // one row each for the ten remaining derivations (Label/Milestone/Team/
  // Project/ProjectColumn/PublicKey/Oauth/Star/Watch/CommitStatus) plus the
  // Mirror counter (repo_mirrors, unseeded until now) — each counter reads
  // EXACTLY its own table (the org row is a user-table row of type org; the
  // star and watcher are distinct tables; Oauth reads the landed
  // oauth2_applications — upstream hardcodes 0, statistic.go:104).
  it("counts each remaining derivation's own table — labels, milestones, teams, projects, keys, oauth, stars, watches, statuses, mirrors", async () => {
    const db = drizzle(env.DB);
    const userRows = await db
      .insert(users)
      .values([
        { username: "alice", usernameLower: "alice", type: "user", status: "active", createdAt: AT },
        { username: "acme", usernameLower: "acme", type: "org", status: "active", createdAt: AT },
      ])
      .returning({ id: users.id })
      .all();
    const alice = userRows[0]!.id;
    const acme = userRows[1]!.id;
    await db
      .insert(repositories)
      .values([{ id: "r1", storageKey: "r_r1", ownerNamespace: "alice", ownerId: alice, slug: "one", visibility: "public", createdAt: AT }])
      .run();
    await db.insert(teams).values({ orgId: acme, lowerName: "devs", name: "devs", authorize: "read" }).run();
    await db.insert(labels).values({ repoId: "r1", name: "bug", color: "#ff0000" }).run();
    await db.insert(milestones).values({ repoId: "r1", name: "v1" }).run();
    const projectRows = await db
      .insert(projects)
      .values({ title: "Board", ownerId: alice, creatorId: alice, type: 1, createdAt: AT, updatedAt: AT })
      .returning({ id: projects.id })
      .all();
    await db
      .insert(projectColumns)
      .values({ title: "Todo", projectId: projectRows[0]!.id, creatorId: alice, createdAt: AT, updatedAt: AT })
      .run();
    await db
      .insert(publicKeys)
      .values({ ownerId: alice, name: "laptop", fingerprint: "SHA256:abc", content: "ssh-ed25519 AAAA test", createdAt: AT, updatedAt: AT })
      .run();
    await db
      .insert(oauth2Applications)
      .values({ uid: alice, name: "cli", clientId: "client-1", clientSecret: "hashed", createdAt: AT, updatedAt: AT })
      .run();
    await db.insert(stars).values({ userId: alice, repoId: "r1", createdAt: AT }).run();
    await db.insert(repoWatchers).values({ repoId: "r1", userId: alice, createdAt: AT }).run();
    await db.insert(commitStatuses).values({ repoId: "r1", sha: "a".repeat(40), state: "success" }).run();
    await db.insert(repoMirrors).values({ repoId: "m1", remoteAddress: "https://src.test/x.git", intervalSeconds: 600 }).run();

    const { stats } = await loadAdminMonitorStats(env.DB);
    const byKey = new Map(stats);
    expect(byKey.get("Label")).toBe(1);
    expect(byKey.get("Milestone")).toBe(1);
    expect(byKey.get("Team")).toBe(1);
    expect(byKey.get("Project")).toBe(1);
    expect(byKey.get("ProjectColumn")).toBe(1);
    expect(byKey.get("PublicKey")).toBe(1);
    expect(byKey.get("Oauth")).toBe(1);
    expect(byKey.get("Star")).toBe(1);
    expect(byKey.get("Watch")).toBe(1);
    expect(byKey.get("CommitStatus")).toBe(1);
    expect(byKey.get("Mirror")).toBe(1);
    // The user-table split again, with the org present: active users vs the
    // Org counter never blend.
    expect(byKey.get("UsersActive")).toBe(1);
    expect(byKey.get("Org")).toBe(1);
    // Nothing leaked into the attachment sum or the delivery log.
    expect(byKey.get("Attachment")).toBe(0);
    expect(byKey.get("HookTask")).toBe(0);
  });
});

// --- the cron registry + form ---------------------------------------------------

const NOW = new Date("2026-01-01T12:07:33Z");

describe("loadAdminMonitorCron (the FULL landed arm census — the usability F3 listing)", () => {
  it("carries all seven landed arms with their wrangler schedules in registry order", () => {
    const { entries } = loadAdminMonitorCron(NOW);
    expect(entries.map((entry) => [entry.name, entry.spec])).toEqual([
      ["update_mirrors", "*/10 * * * *"],
      ["update_push_mirrors", "*/10 * * * *"],
      ["stop_zombie_tasks", "*/10 * * * *"],
      ["demo_sweep", "0 * * * *"],
      ["delete_old_audit_events", "0 * * * *"],
      ["cleanup_packages", "0 * * * *"],
      ["cleanup_actions", "0 * * * *"],
    ]);
    // The never-fired posture without recorded state (the sync loader's
    // shape): prev null, zero executions, the empty-Status result arm.
    for (const entry of entries) {
      expect(entry.prev).toBeNull();
      expect(entry.execTimes).toBe(0);
      expect(entry.result).toEqual({ status: "none", message: null, at: null });
    }
    // The run button renders ONLY on the run-capable arms (the landed run
    // bodies — admin-degenerate's CRON_RUN_BODIES posture; never a dead
    // control); the two actions-family census arms stay bodyless.
    expect(entries.filter((entry) => entry.runnable).map((entry) => entry.name)).toEqual([
      "update_mirrors",
      "update_push_mirrors",
      "demo_sweep",
      "delete_old_audit_events",
      "cleanup_packages",
    ]);
  });

  it("computes Next for BOTH landed spec families from the real expressions", () => {
    const { entries } = loadAdminMonitorCron(NOW);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    // minute-step: the next 10-minute UTC boundary.
    expect(byName.get("update_mirrors")!.next).toEqual(new Date("2026-01-01T12:10:00Z"));
    // exact-minute-hourly: the next top-of-hour (the parser family the
    // hourly entry's spec needed).
    expect(byName.get("demo_sweep")!.next).toEqual(new Date("2026-01-01T13:00:00Z"));
  });

  it("an on-boundary now yields the NEXT step (the producer convention)", () => {
    const { entries } = loadAdminMonitorCron(new Date("2026-01-01T12:10:00Z"));
    expect(entries[0]!.next).toEqual(new Date("2026-01-01T12:20:00Z"));
  });

  it("an on-the-hour now yields the NEXT hour for the hourly family", () => {
    const { entries } = loadAdminMonitorCron(new Date("2026-01-01T13:00:00Z"));
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get("demo_sweep")!.next).toEqual(new Date("2026-01-01T14:00:00Z"));
  });
});

describe("loadAdminMonitorCronRunState (the state-bearing loader — the route swap target)", () => {
  it("an empty cron_state answers the sync loader's never-fired census exactly", async () => {
    const stateful = await loadAdminMonitorCronRunState(env.DB, NOW);
    expect(stateful.entries).toEqual(loadAdminMonitorCron(NOW).entries);
  });

  it("merges recorded ticks: prev/execTimes from successes, the Result triple from the last tick", async () => {
    // The scheduled handler's exact calls: the step entry succeeded twice,
    // then the hourly entry failed on its FIRST recorded tick.
    await recordArmsSuccess(env.DB, armsForEntry("*/10 * * * *"), { now: NOW });
    await recordArmsSuccess(env.DB, armsForEntry("*/10 * * * *"), { now: LATER });
    await recordArmsFailure(env.DB, armsForEntry("0 * * * *"), new Error("DB/REPO_TASKS not bound"), { now: NOW });

    const { entries } = await loadAdminMonitorCronRunState(env.DB, NOW);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    // A completed-tick arm: prev = the last success, executions counted.
    const mirrors = byName.get("update_mirrors")!;
    expect(mirrors.prev).toEqual(LATER);
    expect(mirrors.execTimes).toBe(2);
    expect(mirrors.result).toEqual({ status: "finished", message: null, at: null });

    // An error-stamped arm (never succeeded): the `-` prev, the x glyph's
    // inputs carried.
    const sweep = byName.get("demo_sweep")!;
    expect(sweep.prev).toBeNull();
    expect(sweep.execTimes).toBe(0);
    expect(sweep.result).toEqual({
      status: "error",
      message: "DB/REPO_TASKS not bound",
      at: NOW,
    });
    // The whole failed entry is stamped (the granularity note): every
    // hourly arm carries the error, no hourly arm moved last_success.
    expect(byName.get("cleanup_actions")!.result.status).toBe("error");
    expect(byName.get("cleanup_actions")!.prev).toBeNull();
  });

  it("a success AFTER a failure replaces the error posture (the last tick decides)", async () => {
    await recordArmsFailure(env.DB, armsForEntry("*/10 * * * *"), new Error("first tick threw"), { now: NOW });
    await recordArmsSuccess(env.DB, armsForEntry("*/10 * * * *"), { now: LATER });
    const { entries } = await loadAdminMonitorCronRunState(env.DB, NOW);
    const mirrors = entries.find((entry) => entry.name === "update_mirrors")!;
    expect(mirrors.result).toEqual({ status: "finished", message: null, at: null });
    expect(mirrors.prev).toEqual(LATER);
    expect(mirrors.execTimes).toBe(1);
  });

  it("renders the last-run state per arm: prev timestamp, executions, the check/x glyphs", async () => {
    await recordArmsSuccess(env.DB, armsForEntry("*/10 * * * *"), { now: NOW });
    await recordArmsFailure(env.DB, armsForEntry("0 * * * *"), new Error("producer probes failed"), { now: NOW });
    const { entries } = await loadAdminMonitorCronRunState(env.DB, NOW);
    const html = renderToString(<AdminMonitorCronPage ctx={ctx} data={{ entries }} flash={null} />);
    // The finished arm renders the check glyph and the recorded prev.
    expect(html).toContain(`>${formatMonitorFullTime(NOW)}</td>`);
    expect(html).toContain('class="svg octicon-check"');
    // The error arm renders the x glyph with the stored one-liner tooltip.
    expect(html).toContain('data-tooltip-content="producer probes failed"');
    expect(html).toContain('class="svg octicon-x"');
    // Exactly FIVE run buttons (the runnable arms) among seven rows.
    expect((html.match(/name="op" value=/g) ?? []).length).toBe(5);
  });
});

describe("parseAdminMonitorCronForm (the run button + hidden from=monitor)", () => {
  it("parses the run post", () => {
    expect(parseAdminMonitorCronForm(new URLSearchParams({ op: "update_mirrors", from: "monitor" }))).toEqual({
      op: "update_mirrors",
      from: "monitor",
    });
  });

  it("an absent op parses as the failed binding", () => {
    expect(parseAdminMonitorCronForm(new URLSearchParams({ from: "monitor" })).op).toBeNull();
  });
});

describe("applyAdminMonitorCronForm (DashboardPost's task arm over the landed producer)", () => {
  /** MIRROR_SYNC_QUEUE stub — records sendBatch bodies (the sync.test.ts
   *  shape; the test-file copy is the precedent). */
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

  /** One bare repositories row (the stats fixtures' registry shape). */
  async function seedRepoRow(id: string, ownerId: number, ownerNamespace: string, slug: string, createdAt: Date): Promise<void> {
    await drizzle(env.DB)
      .insert(repositories)
      .values({ id, storageKey: `r_${id}`, ownerNamespace, ownerId, slug, visibility: "public", createdAt })
      .run();
  }

  it("the known task runs the landed producer — run = enqueue, row flips queued, tick recorded", async () => {
    await seedDueMirror();
    const queue = recordingQueue();
    const result = await applyAdminMonitorCronForm({ ...env, MIRROR_SYNC_QUEUE: queue }, { op: "update_mirrors", from: "monitor" }, { now: NOW });
    expect(result).toEqual({ outcome: "applied", message: "Started Task: Update Mirrors" });
    expect(queue.batches).toEqual([[{ kind: "mirror-sync", repoId: "7401" }]]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("queued");
    // The manual run records ITS tick (upstream ExecTimes counts the
    // dashboard trigger too — tasks.go:95-97) on the update_mirrors row.
    const state = await listCronState(env.DB);
    expect(state.get("update_mirrors")).toMatchObject({ runs: 1, lastSuccess: NOW, lastError: null });
  });

  it("update_push_mirrors runs its producer — the due push mirror enqueues, row flips queued, tick recorded", async () => {
    const db = drizzle(env.DB);
    const owner = (
      await db
        .insert(users)
        .values({ username: "pusher", usernameLower: "pusher", type: "user", status: "active", createdAt: AT })
        .returning({ id: users.id })
        .all()
    )[0]!.id;
    await seedRepoRow("p1", owner, "pusher", "push-me", AT);
    await db
      .insert(pushMirrors)
      .values({
        repoId: "p1",
        remoteName: "remote_mirror_abc123",
        remoteAddress: "https://dest.test/pusher/push-me.git",
        intervalSeconds: 600,
        createdAt: AT,
        nextSyncAt: Math.floor(NOW.getTime() / 1000) - 60, // due a minute ago
        syncState: "idle",
      })
      .run();
    const queue = recordingQueue();
    const result = await applyAdminMonitorCronForm(
      { ...env, MIRROR_SYNC_QUEUE: queue },
      { op: "update_push_mirrors", from: "monitor" },
      { now: NOW },
    );
    expect(result).toEqual({ outcome: "applied", message: "Started Task: Update Push Mirrors" });
    // The push producer's message shape (the CAS claim wins the enqueue).
    expect(queue.batches).toEqual([[{ kind: "push-mirror-sync", repoId: "p1", pushMirrorId: 1 }]]);
    const row = await db.select().from(pushMirrors).all();
    expect(row[0]!.syncState).toBe("queued");
    // The manual run records ITS tick on the update_push_mirrors row.
    const state = await listCronState(env.DB);
    expect(state.get("update_push_mirrors")).toMatchObject({ runs: 1, lastSuccess: NOW, lastError: null });
  });

  it("demo_sweep runs its producer — DEMO_MODE-armed, the stale non-admin repo enqueues, tick recorded", async () => {
    const db = drizzle(env.DB);
    const owner = (
      await db
        .insert(users)
        .values({ username: "demoer", usernameLower: "demoer", type: "user", status: "active", createdAt: AT })
        .returning({ id: users.id })
        .all()
    )[0]!.id;
    // Older than the 72 h window (the cut is now − 72 h; a fresh row escapes).
    await seedRepoRow("d1", owner, "demoer", "stale", new Date(NOW.getTime() - 100 * 60 * 60 * 1000));
    const tasks = recordingQueue();
    // DEMO_MODE armed explicitly — hermetic against the local config posture
    // (the vitest plugin injects the wrangler VARS into the test env). The
    // var is literal-typed in the generated Env — the same documented
    // mutation-hole override the audit test below uses.
    const armed: Env = { ...env, REPO_TASKS: tasks };
    (armed as { DEMO_MODE?: string }).DEMO_MODE = "true";
    const result = await applyAdminMonitorCronForm(
      armed,
      { op: "demo_sweep", from: "monitor" },
      { now: NOW },
    );
    expect(result).toEqual({ outcome: "applied", message: "Started Task: Demo Sweep" });
    expect(tasks.batches).toEqual([[{ kind: "demo-sweep", repoId: "d1" }]]);
    const state = await listCronState(env.DB);
    expect(state.get("demo_sweep")).toMatchObject({ runs: 1, lastSuccess: NOW, lastError: null });
  });

  it("delete_old_audit_events runs its producer — armed retention, the expired audit row enqueues one sweep, tick recorded", async () => {
    // The var is literal-typed in the generated Env — the documented
    // mutation-hole override (audit.test.ts:604) pins the window hermetically.
    const tasks = recordingQueue();
    const armed: Env = { ...env, REPO_TASKS: tasks };
    (armed as { AUDIT_RETENTION_DAYS?: string }).AUDIT_RETENTION_DAYS = "7";
    await drizzle(env.DB)
      .insert(auditEvents)
      .values({
        action: "repository:create",
        actorId: 1,
        scopeType: "system",
        origin: "system",
        createdUnix: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000), // past the 7 d window
      })
      .run();
    const result = await applyAdminMonitorCronForm(armed, { op: "delete_old_audit_events", from: "monitor" }, { now: NOW });
    expect(result).toEqual({ outcome: "applied", message: "Started Task: Delete audit events older than the retention period" });
    expect(tasks.batches).toEqual([[{ kind: "audit-retention" }]]);
    const state = await listCronState(env.DB);
    expect(state.get("delete_old_audit_events")).toMatchObject({ runs: 1, lastSuccess: NOW, lastError: null });
  });

  it("cleanup_packages runs its producer — an enabled rule probe enqueues one sweep, tick recorded", async () => {
    await drizzle(env.DB)
      .insert(packageCleanupRules)
      .values({ enabled: true, type: "", createdUnix: AT, updatedUnix: AT })
      .run();
    const tasks = recordingQueue();
    // REPO_PACKS rides the real (empty) bucket — the spool probe misses, the
    // rule probe alone arms the single enqueue.
    const result = await applyAdminMonitorCronForm(
      { ...env, REPO_TASKS: tasks },
      { op: "cleanup_packages", from: "monitor" },
      { now: NOW },
    );
    expect(result).toEqual({ outcome: "applied", message: "Started Task: Clean up expired packages" });
    expect(tasks.batches).toEqual([[{ kind: "package-cleanup" }]]);
    const state = await listCronState(env.DB);
    expect(state.get("cleanup_packages")).toMatchObject({ runs: 1, lastSuccess: NOW, lastError: null });
  });

  it("an unknown task answers task.unknown WITHOUT running anything", async () => {
    await seedDueMirror();
    const queue = recordingQueue();
    const result = await applyAdminMonitorCronForm({ ...env, MIRROR_SYNC_QUEUE: queue }, { op: "destroy_old_packages", from: "monitor" }, { now: NOW });
    expect(result).toEqual({ outcome: "invalid", message: "Unknown task: destroy_old_packages" });
    expect(queue.batches).toEqual([]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("idle"); // untouched
    const state = await listCronState(env.DB);
    expect(state.size).toBe(0); // never a tick for an unknown op
  });

  it("a failed binding funnels to the unknown arm (never runs)", async () => {
    const queue = recordingQueue();
    const result = await applyAdminMonitorCronForm({ ...env, MIRROR_SYNC_QUEUE: queue }, { op: null, from: "monitor" }, { now: NOW });
    expect(result).toEqual({ outcome: "invalid", message: "Unknown task: " });
    expect(queue.batches).toEqual([]);
  });

  it("the still-bodyless census arms answer task.unknown exactly like an unknown op — nothing runs, no tick", async () => {
    // stop_zombie_tasks and cleanup_actions ARE in the rendered census (the
    // scheduled dispatcher's lens) but their producer modules are an in-flight
    // sibling's ownership — the form's run gate answers the unknown flash for
    // both, never a wrong body (the API twin's listed-but-unrunnable posture).
    await seedDueMirror();
    const queue = recordingQueue();
    for (const op of ["stop_zombie_tasks", "cleanup_actions"]) {
      const result = await applyAdminMonitorCronForm({ ...env, MIRROR_SYNC_QUEUE: queue }, { op, from: "monitor" }, { now: NOW });
      expect(result, op).toEqual({ outcome: "invalid", message: `Unknown task: ${op}` });
    }
    expect(queue.batches).toEqual([]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("idle"); // untouched
    const state = await listCronState(env.DB);
    expect(state.size).toBe(0); // never a tick for a bodyless arm
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the monitor family DOM (templates/admin/*.tmpl at the pin)", () => {
  it("stats: the pageClass discriminator + the Summary header + width-200 key rows", async () => {
    const data = await loadAdminMonitorStats(env.DB);
    const html = renderToString(<AdminMonitorStatsPage ctx={ctx} data={data} />);
    expect(html).toContain('class="page-content admin monitor"'); // the §2.4.1 discriminator
    expect(html).toContain(`>${adminMonitorLocale.statistic}</h4>`);
    expect(html).toContain('<td width="200">UsersActive</td>');
    // The full-document render matches the component path.
    expect(renderAdminMonitorCronPage({ ctx, data: loadAdminMonitorCron(NOW), flash: null })).toContain(
      'class="page-content admin monitor"',
    );
  });

  it("cron: the form wraps the table, the run button carries op/name/title, from=monitor hidden", () => {
    const data = loadAdminMonitorCron(NOW);
    const html = renderToString(<AdminMonitorCronPage ctx={ctx} data={data} flash={null} />);
    expect(html).toContain('action="/-/admin/monitor/cron"');
    expect(html).toContain('method="post"');
    expect(html).toContain('name="op" value="update_mirrors"');
    expect(html).toContain(`title="${adminMonitorLocale.operationRun}"`);
    expect(html).toContain('name="from" value="monitor"');
    expect(html).toContain("*/10 * * * *");
    expect(html).toContain(`>${adminMonitorLocale.taskUpdateMirrors}</td>`);
    // The computed Next renders in upstream's FullTime shape; the never-fired
    // Previous and the empty-Status Result render their `-` / em-dash arms.
    expect(html).toContain(`<td>${formatMonitorFullTime(new Date("2026-01-01T12:10:00Z"))}</td>`);
    expect(html).toContain("<td>-</td>");
    expect(html).toContain("<td>—</td>");
  });

  it("cron: the no-JS flash banner renders with its kind", () => {
    const data = loadAdminMonitorCron(NOW);
    const positive = renderToString(
      <AdminMonitorCronPage ctx={ctx} data={data} flash={{ kind: "positive", text: "Started Task: Update Mirrors" }} />,
    );
    expect(positive).toContain('class="ui positive message"');
    expect(positive).toContain("Started Task: Update Mirrors");
    const negative = renderToString(
      <AdminMonitorCronPage ctx={ctx} data={data} flash={{ kind: "negative", text: "Unknown task: nope" }} />,
    );
    expect(negative).toContain('class="ui negative message"');
  });

  it("queue: the sourced columns only, the DLQ `-` arm, the delivery-state segment", async () => {
    const data = await loadAdminMonitorQueues(env.DB);
    const html = renderToString(<AdminMonitorQueuePage ctx={ctx} data={data} />);
    expect(html).toContain(`>${adminMonitorLocale.queues}</h4>`);
    expect(html).toContain("<td>webhook-delivery</td>");
    expect(html).toContain("<td>repo-tasks</td>");
    expect(html).toContain("<td>webhook-delivery-dlq</td>");
    expect(html).toContain("<td>cloudflare-queue</td>");
    // The empty-store depths (0, 0, and the countable-less `-`).
    expect(html).toContain("<td>0</td>");
    expect(html).toContain("<td>-</td>");
    // The cf-gitea delivery-state breakdown segment with all five states.
    expect(html).toContain(`>${adminMonitorLocale.deliveryStates}</h4>`);
    for (const state of ["pending", "delivering", "delivered", "skipped", "failed"]) {
      expect(html).toContain(`<td width="200">${state}</td>`);
    }
    // NO dead queue-management controls (the reduction — no manage page).
    expect(html).not.toContain("Review / Add Workers");
    expect(html).not.toContain("remove-all-items");
  });

  it("queue: the depths count the landed D1 state (delivery log + mirror producer)", async () => {
    const db = drizzle(env.DB);
    const hookRows = await db
      .insert(webhooks)
      .values([{ repoId: "r1", url: "https://hook.test", events: "{}", isActive: true, createdAt: AT }])
      .returning({ id: webhooks.id })
      .all();
    let uuid = 0;
    const delivery = (state: "pending" | "delivering" | "delivered" | "skipped" | "failed") => ({
      hookId: hookRows[0]!.id,
      repoId: "r1",
      uuid: `u${++uuid}`,
      eventType: "issues",
      eventGroup: "issues",
      payloadContent: "{}",
      state,
      createdAt: AT,
    });
    await db
      .insert(webhookDeliveries)
      .values([
        delivery("pending"),
        delivery("pending"),
        delivery("delivering"),
        delivery("delivered"),
        delivery("skipped"),
        delivery("failed"),
      ])
      .run();
    await db
      .insert(repoMirrors)
      .values([
        { repoId: "a", remoteAddress: "https://src.test/a.git", syncState: "queued", nextSyncAt: 1 },
        { repoId: "b", remoteAddress: "https://src.test/b.git", syncState: "syncing", nextSyncAt: 1 },
        { repoId: "c", remoteAddress: "https://src.test/c.git", syncState: "idle", nextSyncAt: 1 },
      ])
      .run();
    const data = await loadAdminMonitorQueues(env.DB);
    expect(data.queues).toEqual([
      { name: "webhook-delivery", type: "cloudflare-queue", inQueue: 3 }, // 2 pending + 1 delivering
      { name: "repo-tasks", type: "cloudflare-queue", inQueue: 2 }, // 1 queued + 1 syncing
      { name: "webhook-delivery-dlq", type: "cloudflare-queue", inQueue: null },
    ]);
    expect(data.deliveryStates).toEqual([
      ["pending", 2],
      ["delivering", 1],
      ["delivered", 1],
      ["skipped", 1],
      ["failed", 1],
    ]);
    const html = renderToString(<AdminMonitorQueuePage ctx={ctx} data={data} />);
    expect(html).toContain("<td>3</td>");
    expect(html).toContain("<td>2</td>");
  });

  // wave-polish-matrix-12 — the depths move with the STATE LIFECYCLE: the
  // consumer-side transitions (a delivery pending→delivering→delivered; a
  // mirror idle→queued→syncing→idle — the real drivers are the queue
  // consumers' own suites) re-read through the loader as exact depth moves:
  // in-flight leaves at the OUTCOME write, the repo-tasks depth counts the
  // two in-process states and drops on the settle back to idle.
  it("the depths track the lifecycle: delivery pending→delivering→delivered, mirror idle→queued→syncing→idle", async () => {
    const db = drizzle(env.DB);
    const hookRows = await db
      .insert(webhooks)
      .values([{ repoId: "r1", url: "https://hook.test", events: "{}", isActive: true, createdAt: AT }])
      .returning({ id: webhooks.id })
      .all();
    const deliveryRows = await db
      .insert(webhookDeliveries)
      .values([
        { hookId: hookRows[0]!.id, repoId: "r1", uuid: "u1", eventType: "issues", eventGroup: "issues", payloadContent: "{}", state: "pending", createdAt: AT },
      ])
      .returning({ id: webhookDeliveries.id })
      .all();
    const mirrorRows = await db
      .insert(repoMirrors)
      .values([{ repoId: "a", remoteAddress: "https://src.test/a.git", syncState: "idle", nextSyncAt: 1 }])
      .returning({ id: repoMirrors.id })
      .all();

    const depthOf = async (name: string): Promise<number | null> =>
      (await loadAdminMonitorQueues(env.DB)).queues.find((row) => row.name === name)?.inQueue ?? null;

    // idle mirror + pending delivery: the delivery is in-flight, the idle
    // mirror is not.
    expect(await depthOf("webhook-delivery")).toBe(1);
    expect(await depthOf("repo-tasks")).toBe(0);

    // The cron producer's enqueue flips the mirror queued — repo-tasks gains it.
    await db.update(repoMirrors).set({ syncState: "queued" }).where(eq(repoMirrors.id, mirrorRows[0]!.id));
    expect(await depthOf("repo-tasks")).toBe(1);

    // The consumer's claim: delivering/queued — both still in-flight.
    await db.update(repoMirrors).set({ syncState: "syncing" }).where(eq(repoMirrors.id, mirrorRows[0]!.id));
    await db.update(webhookDeliveries).set({ state: "delivering" }).where(eq(webhookDeliveries.id, deliveryRows[0]!.id));
    expect(await depthOf("repo-tasks")).toBe(1);
    expect(await depthOf("webhook-delivery")).toBe(1);

    // The settle arms: the outcome write and the settle back to idle — both
    // depths drain to zero, the DLQ counter stays uncountable.
    await db.update(webhookDeliveries).set({ state: "delivered" }).where(eq(webhookDeliveries.id, deliveryRows[0]!.id));
    await db.update(repoMirrors).set({ syncState: "idle" }).where(eq(repoMirrors.id, mirrorRows[0]!.id));
    expect(await depthOf("webhook-delivery")).toBe(0);
    expect(await depthOf("repo-tasks")).toBe(0);
    expect(await depthOf("webhook-delivery-dlq")).toBeNull();
  });

  it("trace: the honest-absence note and NO dead controls (tabs, cancel, diagnosis)", () => {
    const html = renderToString(<AdminMonitorTracePage ctx={ctx} />);
    expect(html).toContain('class="page-content admin monitor"');
    expect(html).toContain(adminMonitorLocale.traceUnavailable);
    // No tab strip, no cancel link-actions, no diagnosis form, no counts.
    expect(html).not.toContain("Goroutines");
    expect(html).not.toContain("link-action");
    expect(html).not.toContain("/-/admin/monitor/diagnosis");
    expect(html).not.toContain("/-/admin/monitor/perftrace");
    expect(html).not.toContain("cancel/");
  });

  it("nav: the shared family navbar with the monitor items active/open, audit_logs omitted (the F7 fold)", () => {
    const html = renderToString(<AdminFamilyNav active="stats" />);
    expect(html).toContain('class="flex-container-nav"');
    expect(html).toContain('<details class="item" open="">'); // the group containing the active page
    expect(html).toContain(`>${adminMonitorLocale.monitoring}</summary>`);
    expect(html).toContain('class="active item" href="/-/admin/monitor/stats"');
    expect(html).toContain('href="/-/admin/monitor/cron"');
    expect(html).toContain('href="/-/admin/monitor/queue"');
    expect(html).toContain('href="/-/admin/monitor/stacktrace"');
    // The unported audit_logs page is a dead link — never rendered.
    expect(html).not.toContain("/-/admin/monitor/audit_logs");
  });
});

// --- fixture sanity ---------------------------------------------------------------

describe("the fixture store", () => {
  it("the cleanup list covers every seeded table", async () => {
    await drizzle(env.DB)
      .insert(users)
      .values([{ username: "solo", usernameLower: "solo", type: "user", status: "active", createdAt: AT }])
      .run();
    const rows = await drizzle(env.DB).select().from(users).all();
    expect(rows).toHaveLength(1);
  });
});

// --- the mounted-route harness (window-2c e31c0cf; the blocked-users-matrix pattern) --

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

/** MIRROR_SYNC_QUEUE stub — records sendBatch bodies (the sync.test.ts
 *  shape, the describe above's local twin) so the cron run POST's producer
 *  enqueue is observed hermetically, never the miniflare queue. */
function routeRecordingQueue(): Queue & { batches: unknown[][] } {
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

const routeQueue = routeRecordingQueue();
const routeEnv: RouteEnv = {
  ...env,
  MIRROR_SYNC_QUEUE: routeQueue,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → the admin prologue →
 *  load → render, on the mounted uiRouter with the synthetic manifest; the
 *  execution context is awaited so waitUntil side-effects settle before
 *  assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the user id (the real mintSession
 *  path, minted per request — the beforeEach users wipe cascades the
 *  sessions table, so a cross-test cache would go stale; the value is never
 *  rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A principal row (`isAdmin` decides the admin prologue's gate — the
 *  flag is re-read from the users row per request, so it lives in the
 *  seed); returns the fresh id (never hardcoded). */
async function seedPrincipal(username: string, isAdmin: boolean): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({ username, usernameLower: username.toLowerCase(), isAdmin, createdAt: AT })
    .returning({ id: users.id })
    .all();
  return rows[0]!.id;
}

async function adminSessionHeader(): Promise<string> {
  return sessionHeader(await seedPrincipal("root", true));
}

/** The admin's GET of one monitor page through the real route. */
async function monitorGet(path: string): Promise<Response> {
  return fetchUi(path, { headers: { cookie: await adminSessionHeader() } });
}

/** A urlencoded POST to the cron page through the real route (default: the
 *  browser's same-origin Origin header — the §2.8 guard's happy path — and
 *  an admin cookie). */
async function cronPost(fields: Record<string, string>, cookie?: string, origin: string = ORIGIN): Promise<Response> {
  return fetchUi("/-/admin/monitor/cron", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** One seeded due pull mirror (idle + due a minute ago — the route's run arm
 *  executes the producer on the real clock, unlike the apply describe's
 *  injected `now`). */
async function seedRouteDueMirror(): Promise<void> {
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

// --- the mounted routes (window-2c: GET monitor/{stats,cron,queue,stacktrace} + POST cron) ---

describe("the mounted monitor routes (GET stats/cron/queue/stacktrace + POST cron)", () => {
  beforeEach(() => {
    routeQueue.batches.length = 0; // the recorder is a module const — reset per test
  });

  it("303s an anonymous GET onto the login round-trip (the admin prologue's SignInRequired arm)", async () => {
    const res = await fetchUi("/-/admin/monitor/stats");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/admin/monitor/stats")}`);
  });

  it("303s an anonymous same-origin cron POST onto the login round-trip too (guard passes, then the gate; nothing enqueued)", async () => {
    await seedRouteDueMirror();
    const res = await cronPost({ op: "update_mirrors", from: "monitor" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/admin/monitor/cron")}`);
    expect(routeQueue.batches).toEqual([]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("idle");
  });

  it("404-shells a signed-in non-admin's GET (the AdminRequired hidden-surface posture)", async () => {
    const cookie = await sessionHeader(await seedPrincipal("bob", false));
    const res = await fetchUi("/-/admin/monitor/stats", { headers: { cookie } });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error"); // the 404 shell
    expect(html).not.toContain("page-content admin monitor"); // never the monitor content
  });

  it("404-shells a signed-in non-admin's cron POST before any write (the gate fronts the write arm too)", async () => {
    await seedRouteDueMirror();
    const cookie = await sessionHeader(await seedPrincipal("bob", false));
    const res = await cronPost({ op: "update_mirrors", from: "monitor" }, cookie);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(routeQueue.batches).toEqual([]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("idle"); // untouched
  });

  it("renders the admin's stats GET at 200 with the monitor pageClass and the active nav item", async () => {
    const res = await monitorGet("/-/admin/monitor/stats");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content admin monitor"'); // the §2.4.1 discriminator
    expect(html).toContain('class="active item" href="/-/admin/monitor/stats"');
    expect(html).toContain(`>${adminMonitorLocale.statistic}</h4>`); // the Summary header
  });

  it("renders the admin's cron GET at 200 with the run form and no flash", async () => {
    const res = await monitorGet("/-/admin/monitor/cron");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content admin monitor"');
    expect(html).toContain('class="active item" href="/-/admin/monitor/cron"');
    expect(html).toContain('action="/-/admin/monitor/cron"'); // the POST-to-page-URL divergence
    expect(html).toContain(`>${adminMonitorLocale.cron}</h4>`);
    expect(html).not.toContain('class="ui positive message"'); // flash: null on GET
    expect(html).not.toContain('class="ui negative message"');
  });

  it("renders the admin's queue GET at 200 with the landed queue rows", async () => {
    const res = await monitorGet("/-/admin/monitor/queue");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content admin monitor"');
    expect(html).toContain('class="active item" href="/-/admin/monitor/queue"');
    expect(html).toContain(`>${adminMonitorLocale.queues}</h4>`);
    expect(html).toContain("<td>webhook-delivery</td>");
  });

  it("renders the admin's stacktrace GET at 200 with the honest-absence note", async () => {
    const res = await monitorGet("/-/admin/monitor/stacktrace");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content admin monitor"');
    expect(html).toContain('class="active item" href="/-/admin/monitor/stacktrace"');
    expect(html).toContain(adminMonitorLocale.traceUnavailable);
  });

  it("a known-op cron POST re-renders at 200 with the positive flash and enqueues (the mirror row flips queued)", async () => {
    await seedRouteDueMirror();
    const res = await cronPost({ op: "update_mirrors", from: "monitor" }, await adminSessionHeader());
    expect(res.status).toBe(200); // the no-JS re-render (upstream redirects; no flash queue)
    const html = await res.text();
    expect(html).toContain('class="ui positive message"');
    expect(html).toContain("Started Task: Update Mirrors"); // task.started over the locale name
    expect(routeQueue.batches).toEqual([[{ kind: "mirror-sync", repoId: "7401" }]]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("queued"); // run = enqueue + the CAS claim
  });

  it("an unknown-op cron POST re-renders at 200 with the negative flash and never enqueues", async () => {
    await seedRouteDueMirror();
    const res = await cronPost({ op: "destroy_old_packages", from: "monitor" }, await adminSessionHeader());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("Unknown task: destroy_old_packages"); // task.unknown carries the raw op
    expect(routeQueue.batches).toEqual([]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("idle"); // untouched
  });

  it("rejects a cross-origin cron POST with 403 before any write (sameOriginGuard first)", async () => {
    await seedRouteDueMirror();
    const res = await cronPost(
      { op: "update_mirrors", from: "monitor" },
      await adminSessionHeader(),
      "https://evil.example",
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(routeQueue.batches).toEqual([]);
    const row = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(row[0]!.syncState).toBe("idle"); // nothing was written
  });
});

// --- the route claim pin (parse ↔ registration — the blocked-users-matrix pin) ------

describe("the route claim pin (the admin family claims the four monitor pages only)", () => {
  it("parses the four page shapes with their page discriminators", () => {
    expect(parseUiRoute("/-/admin/monitor/stats")).toEqual({ family: "admin-monitor", page: "stats" });
    expect(parseUiRoute("/-/admin/monitor/cron")).toEqual({ family: "admin-monitor", page: "cron" });
    expect(parseUiRoute("/-/admin/monitor/queue")).toEqual({ family: "admin-monitor", page: "queue" });
    expect(parseUiRoute("/-/admin/monitor/stacktrace")).toEqual({ family: "admin-monitor", page: "trace" });
    expect(handlesUiRoute("/-/admin/monitor/stats")).toBe(true);
    expect(handlesUiRoute("/-/admin/monitor/cron")).toBe(true);
    expect(handlesUiRoute("/-/admin/monitor/queue")).toBe(true);
    expect(handlesUiRoute("/-/admin/monitor/stacktrace")).toBe(true);
  });

  it("the bare monitor tail, junk page names and deeper tails stay unclaimed — the engine's 404", async () => {
    for (const path of ["/-/admin/monitor", "/-/admin/monitor/statz", "/-/admin/monitor/stats/extra"]) {
      expect(parseUiRoute(path)).toBeNull();
      expect(handlesUiRoute(path)).toBe(false); // the dispatcher passes it to the engine
      const res = await fetchUi(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("page-content admin monitor");
    }
  });
});
