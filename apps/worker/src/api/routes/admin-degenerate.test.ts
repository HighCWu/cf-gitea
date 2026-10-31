/**
 * The five RUNTIME-ONLY admin ops (routes/admin-degenerate.ts — the
 * inventory's `wave-api-admin-degenerate` batch): adminCronList/adminCronRun
 * (GET/POST /admin/cron) over the scheduled dispatcher's arm census
 * (CRON_ARMS — the cron_state store's registry) with the runnable-producer
 * run gate, and the unadopted-repository trio (GET /admin/unadopted,
 * POST/DELETE /admin/unadopted/{owner}/{repo}) over the structurally-empty
 * unadopted set. Per-arm contract verification: every declared response code
 * of every op is exercised, including the two RUNTIME_ONLY_RESPONSES-documented
 * codes (the cron-run 403 and the unadopted-delete 404).
 *
 * Standalone mount per the tier2-extras.test.ts convention (the routes ARE
 * registered in router.ts by the orchestrator after this batch). The stub
 * resolver carries THREE tokens: the plain seed user (id 1), a non-admin
 * neighbor and the site admin ("root") — the whole module sits behind
 * requireAuth + the reqSiteAdmin gate, so both halves are exercisable.
 *
 * The cron-run arm's enqueue is verified against a RECORDING queue stub (the
 * api/mirror.test.ts pattern — nothing here performs a real queue send): a
 * due repo_mirrors row must flip idle→queued and land exactly one
 * {kind: "mirror-sync"} message; a not-due row must stay untouched (the
 * producer's next_sync_at != 0 filter). The manual run's recorded tick lands
 * in cron_state (the monitor's applyAdminMonitorCronForm shape) and the
 * census render merges those rows into prev/exec_times.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { cronState, repoMirrors, repositories, users } from "../../db/schema";
import { createStubAuthResolver, createTokenAuthMiddleware, STUB_USER, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerAdminDegenerateRoutes } from "./admin-degenerate";
import { applyRepoExtrasDdl } from "../testing/repo-ddl";

const NOW = new Date("2026-02-03T04:05:06Z");
const TOKEN = "stub-token"; // the plain seed user (id 1, non-admin)
const TOKEN_NEIGHBOR = "neighbor-token"; // a non-admin neighbor
const TOKEN_ADMIN = "admin-token"; // the site admin ("root")

let neighborId = 0;
let adminId = 0;

function resolver(): AuthResolver {
  const stub = createStubAuthResolver();
  return {
    resolveToken: (token) => {
      if (token === TOKEN) return stub.resolveToken(TOKEN);
      if (token === TOKEN_NEIGHBOR) {
        return Promise.resolve({ ...STUB_USER, id: neighborId, login: "neighbor" });
      }
      if (token === TOKEN_ADMIN) {
        return Promise.resolve({ ...STUB_USER, id: adminId, login: "root", is_admin: true });
      }
      return Promise.resolve(null);
    },
  };
}

interface RecordingQueue extends Queue {
  sent: unknown[];
}

/** MIRROR_SYNC_QUEUE stub — the api/mirror.test.ts recorder, with sendBatch
 *  ALSO recording (the cron producer enqueues via sendBatch — the wrapper
 *  shape is MessageSendBatch: {body, ...}). */
function recordingQueue(): RecordingQueue {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const sent: unknown[] = [];
  return {
    sent,
    send: (body: unknown) => {
      sent.push(body);
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: Iterable<MessageSendRequest<unknown>>) => {
      sent.push(...messages);
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
  };
}

function familyApp(queue?: RecordingQueue) {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerAdminDegenerateRoutes(app, createTokenAuthMiddleware(resolver()));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    // The queue override is the mirror.test.ts env-stub seam (the binding is
    // typed Queue, the recorder extends it — no cast).
    Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), { ...env, MIRROR_SYNC_QUEUE: queue ?? recordingQueue() }));
}

const authed = (init?: RequestInit, token = TOKEN_ADMIN): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `token ${token}`);
  return { ...init, headers };
};

const adminSend = familyApp();

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyRepoExtrasDdl();
});

/** Fresh rows per test: the plain stub user (id 1), a neighbor, the admin. */
beforeEach(async () => {
  for (const table of ["cron_state", "repo_mirrors", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }

  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  neighborId = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "neighbor", usernameLower: "neighbor", status: "active", createdAt: NOW })
      .returning({ id: users.id })
      .all()
  )[0]!.id;
  adminId = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "root", usernameLower: "root", isAdmin: true, status: "active", createdAt: NOW })
      .returning({ id: users.id })
      .all()
  )[0]!.id;
});

/** Insert a repo registry row owned by the given user id (raw — the engine is
 *  not involved in this batch; the admin-t2.test.ts seed shape). */
async function seedRepo(ownerId: number, ownerNamespace: string, slug: string, id: string): Promise<void> {
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    ownerId,
    slug,
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: NOW,
  });
}

/** Insert a repo_mirrors row (SPEC-0009): `due` controls next_sync_at (0 =
 *  unscheduled — the producer's filter excludes it). */
async function seedMirrorRow(repoId: string, due: boolean): Promise<void> {
  await drizzle(env.DB).insert(repoMirrors).values({
    repoId,
    intervalSeconds: 28800,
    enablePrune: true,
    remoteAddress: "https://src.example.com/mirror-me.git",
    syncState: "idle",
    nextSyncAt: due ? 1000 : 0,
  });
}

/** Insert a cron_state tick row (the scheduled handler's recorder shape) —
 *  `runs` completed ticks at `lastSuccessAt`. */
async function seedCronStateRow(arm: string, lastSuccessAt: Date, runs: number): Promise<void> {
  await drizzle(env.DB).insert(cronState).values({ arm, lastSuccessUnix: lastSuccessAt, runs });
}

// ---------------------------------------------------------------------------
// The admin gate (reqToken + reqSiteAdmin, api.go:1824-)
// ---------------------------------------------------------------------------

describe("admin gating", () => {
  it("401s anonymous callers with the reqToken body (runtime-only class — undeclared)", async () => {
    const res = await adminSend("/admin/cron");
    expect(res.status).toBe(401);
    const body: Record<string, unknown> = await res.json();
    expect(body.message).toBe("token is required");
    expect(String(body.url)).toContain("/api/swagger");
  });

  it("403s non-admins on every op with the reqSiteAdmin message", async () => {
    const checks: Array<[string, RequestInit]> = [
      ["/admin/cron", authed(undefined, TOKEN_NEIGHBOR)],
      ["/admin/cron/update_mirrors", authed({ method: "POST" }, TOKEN_NEIGHBOR)],
      ["/admin/cron/no-such-task", authed({ method: "POST" }, TOKEN_NEIGHBOR)],
      ["/admin/unadopted", authed(undefined, TOKEN_NEIGHBOR)],
      ["/admin/unadopted/neighbor/whatever", authed({ method: "POST" }, TOKEN_NEIGHBOR)],
      ["/admin/unadopted/neighbor/whatever", authed({ method: "DELETE" }, TOKEN_NEIGHBOR)],
    ];
    for (const [path, init] of checks) {
      const res = await adminSend(path, init);
      expect(res.status, path).toBe(403);
      const body: Record<string, unknown> = await res.json();
      expect(body.message, path).toBe("user should be the site admin");
    }
  });
});

// ---------------------------------------------------------------------------
// adminCronList — GET /admin/cron (cron.go ListCronTasks over the scheduled
// dispatcher's arm census — CRON_ARMS — with the cron_state ticks merged)
// ---------------------------------------------------------------------------

describe("adminCronList (GET /admin/cron)", () => {
  it("renders the full arm census under upstream's Cron shape (zero state when nothing recorded)", async () => {
    const res = await adminSend("/admin/cron", authed());
    expect(res.status).toBe(200);
    // The census: the step entry's three arms, then the hourly entry's four
    // (services/cron-state.ts CRON_ARMS order — the monitor's render order).
    expect(res.headers.get("X-Total-Count")).toBe("7");
    const list: Record<string, unknown>[] = await res.json();
    expect(list).toHaveLength(7);
    expect(list.map((entry) => entry.name)).toEqual([
      "update_mirrors",
      "update_push_mirrors",
      "stop_zombie_tasks",
      "demo_sweep",
      "delete_old_audit_events",
      "cleanup_packages",
      "cleanup_actions",
    ]);
    expect(list.map((entry) => entry.schedule)).toEqual([
      "*/10 * * * *",
      "*/10 * * * *",
      "*/10 * * * *",
      "0 * * * *",
      "0 * * * *",
      "0 * * * *",
      "0 * * * *",
    ]);
    // Nothing recorded yet → the Go zero pair on every arm.
    for (const entry of list) {
      expect(entry.prev).toBe("0001-01-01T00:00:00Z");
      expect(entry.exec_times).toBe(0);
    }
    // `next` is computed per spec shape: the step arms land on a future */10
    // UTC boundary, the hourly arms on a future top-of-the-hour boundary.
    for (const entry of list) {
      const next = new Date(String(entry.next));
      expect(Number.isNaN(next.getTime()), String(entry.name)).toBe(false);
      expect(next.getTime()).toBeGreaterThan(Date.now());
      expect(next.getUTCSeconds()).toBe(0);
      expect(next.getUTCMilliseconds()).toBe(0);
      if (entry.schedule === "*/10 * * * *") {
        expect(next.getUTCMinutes() % 10).toBe(0);
      } else {
        expect(next.getUTCMinutes()).toBe(0);
      }
    }
  });

  it("merges the recorded cron_state ticks (prev = last_success, exec_times = runs)", async () => {
    const tick = new Date("2026-02-03T04:05:06Z");
    await seedCronStateRow("update_mirrors", tick, 3);
    await seedCronStateRow("demo_sweep", new Date("2026-02-03T05:00:00Z"), 1);
    const res = await adminSend("/admin/cron", authed());
    expect(res.status).toBe(200);
    const list: Record<string, unknown>[] = await res.json();
    const mirrors = list.find((entry) => entry.name === "update_mirrors")!;
    expect(mirrors.prev).toBe("2026-02-03T04:05:06.000Z");
    expect(mirrors.exec_times).toBe(3);
    const sweep = list.find((entry) => entry.name === "demo_sweep")!;
    expect(sweep.prev).toBe("2026-02-03T05:00:00.000Z");
    expect(sweep.exec_times).toBe(1);
    // Rowless arms keep the never-fired posture.
    const zombie = list.find((entry) => entry.name === "stop_zombie_tasks")!;
    expect(zombie.prev).toBe("0001-01-01T00:00:00Z");
    expect(zombie.exec_times).toBe(0);
  });

  it("paginates like upstream (page beyond the set → empty, total kept)", async () => {
    const page2 = await adminSend("/admin/cron?page=2&limit=5", authed());
    expect(page2.status).toBe(200);
    expect(page2.headers.get("X-Total-Count")).toBe("7");
    const page2List: Record<string, unknown>[] = await page2.json();
    expect(page2List.map((entry) => entry.name)).toEqual(["cleanup_packages", "cleanup_actions"]);

    const page1 = await adminSend("/admin/cron?page=1&limit=1", authed());
    expect(page1.status).toBe(200);
    const firstPage: Record<string, unknown>[] = await page1.json();
    expect(firstPage.map((entry) => entry.name)).toEqual(["update_mirrors"]);
  });
});

// ---------------------------------------------------------------------------
// adminCronRun — POST /admin/cron/{task} (cron.go PostCronTask: unknown task
// 404; a runnable task executes its scheduled producer body and records the
// manual tick; a listed-but-unrunnable census arm 404s like an unknown one —
// the monitor's RUNNABLE_CRON_ARMS adjudication)
// ---------------------------------------------------------------------------

describe("adminCronRun (POST /admin/cron/{task})", () => {
  it("404s an unknown task with the APIErrorNotFound body", async () => {
    const res = await adminSend("/admin/cron/no-such-task", authed({ method: "POST" }));
    expect(res.status).toBe(404);
    const body: Record<string, unknown> = await res.json();
    expect(body.message).toBe("not found");
  });

  it("404s a listed-but-unrunnable census arm exactly like an unknown task, recording nothing", async () => {
    // stop_zombie_tasks IS in the list's census (its producer module is an
    // in-flight sibling's ownership) — the run gate answers the same 404.
    const res = await adminSend("/admin/cron/stop_zombie_tasks", authed({ method: "POST" }));
    expect(res.status).toBe(404);
    const body: Record<string, unknown> = await res.json();
    expect(body.message).toBe("not found");
    const rows = await drizzle(env.DB).select().from(cronState).all();
    expect(rows).toEqual([]);
  });

  it("runs the known task and answers 204 — no due mirrors, queue untouched, tick recorded", async () => {
    const queue = recordingQueue();
    const send = familyApp(queue);
    const res = await send("/admin/cron/update_mirrors", authed({ method: "POST" }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(queue.sent).toEqual([]);
    // The manual run records its completed tick (the monitor's form shape).
    const rows = await drizzle(env.DB).select().from(cronState).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.arm).toBe("update_mirrors");
    expect(rows[0]!.runs).toBe(1);
    expect(rows[0]!.lastSuccessUnix).not.toBeNull();
  });

  it("enqueues exactly the due mirrors (idle→queued CAS; not-due rows stay idle)", async () => {
    await seedRepo(1, "cf-gitea-stub", "mirror-me", "7401");
    await seedRepo(1, "cf-gitea-stub", "paused-mirror", "7402");
    await seedMirrorRow("7401", true); // next_sync_at = 1000 → due
    await seedMirrorRow("7402", false); // next_sync_at = 0 → excluded
    const queue = recordingQueue();
    const send = familyApp(queue);

    const res = await send("/admin/cron/update_mirrors", authed({ method: "POST" }));
    expect(res.status).toBe(204);

    expect(queue.sent).toEqual([{ body: { kind: "mirror-sync", repoId: "7401" } }]);
    const states = await drizzle(env.DB)
      .select({ repoId: repoMirrors.repoId, syncState: repoMirrors.syncState })
      .from(repoMirrors)
      .all();
    expect(Object.fromEntries(states.map((row) => [row.repoId, row.syncState]))).toEqual({
      "7401": "queued",
      "7402": "idle",
    });
  });

  it("increments exec_times across runs (runs += 1 per manual tick)", async () => {
    const queue = recordingQueue();
    const send = familyApp(queue);
    await send("/admin/cron/update_mirrors", authed({ method: "POST" }));
    await send("/admin/cron/update_mirrors", authed({ method: "POST" }));
    const rows = await drizzle(env.DB).select().from(cronState).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.runs).toBe(2);
  });

  it("runs the other four runnable arms — each a quiet no-op that records its tick", async () => {
    const queue = recordingQueue();
    const send = familyApp(queue);
    for (const task of ["update_push_mirrors", "demo_sweep", "delete_old_audit_events", "cleanup_packages"]) {
      // Each producer is self-gated (no mirrors / DEMO_MODE unset /
      // AUDIT_RETENTION_DAYS unset / no cleanup work) — 204, zero sends.
      const res = await send(`/admin/cron/${task}`, authed({ method: "POST" }));
      expect(res.status, task).toBe(204);
      expect(await res.text(), task).toBe("");
    }
    expect(queue.sent).toEqual([]);
    const rows = await drizzle(env.DB).select().from(cronState).all();
    expect(rows.map((row) => row.arm).sort()).toEqual([
      "cleanup_packages",
      "delete_old_audit_events",
      "demo_sweep",
      "update_push_mirrors",
    ]);
    for (const row of rows) {
      expect(row.runs).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// adminUnadoptedList — GET /admin/unadopted (adopt.go ListUnadoptedRepositories
// over the structurally-empty set — the honest-empty convention)
// ---------------------------------------------------------------------------

describe("adminUnadoptedList (GET /admin/unadopted)", () => {
  it("answers the always-empty StringSlice with total 0", async () => {
    const res = await adminSend("/admin/unadopted", authed());
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("0");
    const empty: unknown[] = await res.json();
    expect(empty).toEqual([]);
  });

  it("stays empty for any glob and even with registered repositories", async () => {
    await seedRepo(1, "cf-gitea-stub", "registered", "7403");
    for (const query of ["", "?query=cf-gitea-stub/*", "?query=registered&page=3"]) {
      const res = await adminSend(`/admin/unadopted${query}`, authed());
      expect(res.status, query).toBe(200);
      expect(res.headers.get("X-Total-Count"), query).toBe("0");
      const list: unknown[] = await res.json();
      expect(list, query).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// adminAdoptRepository — POST /admin/unadopted/{owner}/{repo} (adopt.go: every
// arm converges on APIErrorNotFound(); the 204 arm needs an on-disk unadopted
// directory, which no cf-gitea code path can produce)
// ---------------------------------------------------------------------------

describe("adminAdoptRepository (POST /admin/unadopted/{owner}/{repo})", () => {
  it("404s an unknown owner", async () => {
    const res = await adminSend("/admin/unadopted/ghost/repo", authed({ method: "POST" }));
    expect(res.status).toBe(404);
    const body: Record<string, unknown> = await res.json();
    expect(body.message).toBe("not found");
  });

  it("404s a known owner with no such repo (nothing is on disk to adopt)", async () => {
    const res = await adminSend("/admin/unadopted/neighbor/repo", authed({ method: "POST" }));
    expect(res.status).toBe(404);
    const body: Record<string, unknown> = await res.json();
    expect(body.message).toBe("not found");
  });

  it("404s an already-registered (adopted) repository", async () => {
    await seedRepo(1, "cf-gitea-stub", "adopted", "7404");
    const res = await adminSend("/admin/unadopted/cf-gitea-stub/adopted", authed({ method: "POST" }));
    expect(res.status).toBe(404);
    const body: Record<string, unknown> = await res.json();
    expect(body.message).toBe("not found");
  });
});

// ---------------------------------------------------------------------------
// adminDeleteUnadoptedRepository — DELETE /admin/unadopted/{owner}/{repo}
// (adopt.go: same convergence; the 404 is the RUNTIME_ONLY_RESPONSES entry —
// the contract documents {204,403} only)
// ---------------------------------------------------------------------------

describe("adminDeleteUnadoptedRepository (DELETE /admin/unadopted/{owner}/{repo})", () => {
  it("404s an unknown owner", async () => {
    const res = await adminSend("/admin/unadopted/ghost/repo", authed({ method: "DELETE" }));
    expect(res.status).toBe(404);
    const body: Record<string, unknown> = await res.json();
    expect(body.message).toBe("not found");
  });

  it("404s a known owner with no such repo (no unadopted files exist)", async () => {
    const res = await adminSend("/admin/unadopted/neighbor/repo", authed({ method: "DELETE" }));
    expect(res.status).toBe(404);
    const body: Record<string, unknown> = await res.json();
    expect(body.message).toBe("not found");
  });

  it("404s an already-registered repository", async () => {
    await seedRepo(neighborId, "neighbor", "kept", "7405");
    const res = await adminSend("/admin/unadopted/neighbor/kept", authed({ method: "DELETE" }));
    expect(res.status).toBe(404);
    const body: Record<string, unknown> = await res.json();
    expect(body.message).toBe("not found");
  });
});
