/**
 * SPEC-0015 §5 — the audit seam's worker battery: the action registry +
 * template rendering, the emit seam (row shape + metadata encoding), the
 * paged read by scope (filter arms + exact keyset continuation), the
 * composite-index plan witness (EXPLAIN — the d1-index-engineering
 * discipline), the slice-one instrumentation's transactional coupling
 * (RepoService.create / OrgService.createOrg — a failed write emits
 * nothing), and the retention producer/consumer pair (SPEC-0015 §4.3).
 *
 * Real local D1 (workerd, @cloudflare/vitest-plugin) with the
 * applyAuthD1Migrations idiom; storage is isolated per test, so every D1
 * test re-applies the migrations (the helper's documented caution). The only
 * stubs are the recording Queue (the demo-sweep.test.ts spyQueue shape) and
 * the gate-off D1 tripwire (same file's proxy — throws on first touch).
 */

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { auditEvents } from "../db/schema";
import { OrgNameCollisionError } from "./orgs/errors";
import { OrgService } from "./orgs/orgs";
import { RepoNameCollisionError, RepoService } from "../repos/service";
import { DEMO_SWEEP_CRON, handleScheduledCron } from "./demo-sweep";
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  AuditActions,
  actionFilters,
  auditEventInsert,
  auditRetentionDaysFromEnv,
  defineAction,
  emitAudit,
  enqueueDueAuditRetention,
  findAuditEvents,
  isAuditRetentionMessage,
  messageTemplate,
  pruneExpiredAuditEvents,
  renderMessage,
} from "./audit";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Fixed clock for the retention halves. */
const NOW = new Date("2026-06-01T12:00:00Z");

function db(): DrizzleD1Database {
  return drizzle(env.DB);
}

/** Recording Queue — counts send/sendBatch AND captures every body
 *  (demo-sweep.test.ts's shape). */
function spyQueue(): Queue & {
  sends: number;
  sendBodies: unknown[];
  sendBatchCalls: number;
  bodies: unknown[][];
} {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue = {
    sends: 0,
    sendBodies: [] as unknown[],
    sendBatchCalls: 0,
    bodies: [] as unknown[][],
    send: (body: unknown) => {
      queue.sends += 1;
      queue.sendBodies.push(body);
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: MessageSendRequest[]) => {
      queue.sendBatchCalls += 1;
      queue.bodies.push(messages.map((m) => m.body));
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve(metadata.metrics),
  };
  return queue;
}

/** The gate-off tripwire (demo-sweep.test.ts's proxy): throws on the FIRST
 *  property touch, so any prepare/batch/exec by gated-off code fails the
 *  test naming what was touched. */
function d1ThatThrows(): D1Database {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`D1 touched while the retention gate is off: .${String(prop)}`);
      },
    },
  ) as D1Database;
}

const totalSends = (queue: ReturnType<typeof spyQueue>): number => queue.sends + queue.sendBatchCalls;

/** The producer env with explicit overrides (the var is not in the generated
 *  Env yet — the AuditRetentionEnv slice carries it as an optional). */
function retentionEnv(
  overrides: { AUDIT_RETENTION_DAYS?: string },
  queue?: Queue,
  dbOverride?: D1Database,
): Parameters<typeof enqueueDueAuditRetention>[0] {
  return { DB: dbOverride ?? env.DB, REPO_TASKS: queue ?? spyQueue(), ...overrides };
}

const cronController = (cron: string): ScheduledController => ({ cron }) as ScheduledController;

async function seedUser(id: number, username: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (?, ?, ?, 0, 'active', 'user', 0)",
  )
    .bind(id, username, username)
    .run();
}

/** Direct event seed (emitAudit is exercised separately in the seam tests). */
async function seedEvent(fields: {
  action: string;
  actorId?: number;
  scopeType: "system" | "user" | "organization" | "repository";
  scopeId: string;
  origin?: "ui" | "api" | "cli" | "system";
  createdUnix: number;
  impersonatorId?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_event (action, actor_id, actor_name, impersonator_id, scope_type, scope_id, scope_name, origin, message, created_unix)
     VALUES (?, ?, 'seeder', ?, ?, ?, 'seeded', ?, 'seeded', ?)`,
  )
    .bind(
      fields.action,
      // 100: a neutral actor id kept DISTINCT from the impersonation test's
      // actor 9 / impersonator 1 — the actor-OR arm must match exactly one
      // row per id.
      fields.actorId ?? 100,
      fields.impersonatorId ?? 0,
      fields.scopeType,
      fields.scopeId,
      fields.origin ?? "api",
      fields.createdUnix,
    )
    .run();
}

const DAY = 24 * 60 * 60;

beforeEach(async () => {
  // Per-test storage isolation resets the D1 schema — re-apply (the helper's
  // documented caution). EMPIRICAL NOTE (this run): rows from sibling tests
  // in this file DO leak into later tests in the same workerd instance, so
  // every D1 test additionally starts from emptied tables (children before
  // parents for the FK chains).
  await applyAuthD1Migrations();
  for (const table of ["org_members", "repo_counters", "repo_redirects", "repositories", "user_redirects", "users", "audit_event"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The registry + renderer (pure)
// ---------------------------------------------------------------------------

describe("audit action registry (SPEC-0015 §4.2)", () => {
  it("renders a registered template, substituting known vars and leaving unknown tokens literal", () => {
    expect(renderMessage(AuditActions.RepositoryCreate, { scope: "alice/alpha" })).toBe(
      "Created repository alice/alpha.",
    );
    expect(renderMessage(AuditActions.OrganizationTeamMemberAdd, { scope: "acme", member: "bob" })).toBe(
      "Added user bob to team acme/{team}.", // {team} missing → literal (the documented divergence from Go's <no value>)
    );
  });

  it("messageTemplate returns the registered template; unregistered ids throw", () => {
    expect(messageTemplate("repository:create")).toBe("Created repository {scope}.");
    expect(messageTemplate("repository:nonexistent")).toBeUndefined();
    expect(() => renderMessage("repository:nonexistent", {})).toThrow(/unregistered audit action/);
    expect(() => defineAction("repository:create", "again")).toThrow(/duplicate audit action/);
  });

  it("actionFilters derives family prefixes from 3+-segment actions only, sorted (upstream action.go:38-57)", () => {
    const filters = actionFilters();
    // exact actions are filters
    expect(filters).toContain("repository:create");
    // 3+-segment actions derive prefixes: organization:team:member:add →
    // organization:team + organization:team:member
    expect(filters).toContain("organization:team");
    expect(filters).toContain("organization:team:member");
    // the one-segment family root is NOT a filter (upstream's i=2 loop start)
    expect(filters).not.toContain("repository");
    expect(filters).not.toContain("organization");
    // sorted
    expect([...filters].sort()).toEqual(filters);
  });
});

// ---------------------------------------------------------------------------
// The emit seam (real D1)
// ---------------------------------------------------------------------------

describe("emitAudit seam (SPEC-0015 §4.2)", () => {
  it("records the full row: numeric scope ids normalize to strings, metadata JSON-encodes, message renders", async () => {
    const d1 = db();
    await emitAudit(d1, {
      action: AuditActions.RepositoryVisibility,
      actorId: 7,
      actorName: "alice",
      actorCredential: "access-token:3",
      impersonatorId: 9,
      impersonatorName: "root",
      scopeType: "repository",
      scopeId: "uuid-123",
      scopeName: "alice/alpha",
      origin: "api",
      vars: { scope: "alice/alpha", visibility: "private" },
      metadata: { old: "public" },
      ipAddress: "203.0.113.9",
      timestamp: new Date(1_750_000_000_000),
    });
    const rows = await d1.select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("repository:visibility:update");
    expect(row.actorId).toBe(7);
    expect(row.actorName).toBe("alice");
    expect(row.actorCredential).toBe("access-token:3");
    expect(row.impersonatorId).toBe(9);
    expect(row.impersonatorName).toBe("root");
    expect(row.scopeType).toBe("repository");
    expect(row.scopeId).toBe("uuid-123");
    expect(row.scopeName).toBe("alice/alpha");
    expect(row.origin).toBe("api");
    expect(row.message).toBe("Changed visibility of repository alice/alpha to private.");
    expect(JSON.parse(row.metadata ?? "")).toEqual({ old: "public" });
    expect(row.ipAddress).toBe("203.0.113.9");
    // mode: "timestamp" stores unix SECONDS
    expect(Math.floor(new Date(1_750_000_000_000).getTime() / 1000)).toBe(Math.floor(row.createdUnix.getTime() / 1000));
  });

  it("defaults: empty actor_name '', impersonator 0, null credential/metadata/ip, absent vars render bare tokens", async () => {
    const d1 = db();
    await emitAudit(d1, {
      action: AuditActions.OrganizationCreate,
      actorId: 3,
      scopeType: "organization",
      scopeId: 5, // numeric normalization path
      origin: "ui",
    });
    const row = (await d1.select().from(auditEvents).all())[0]!;
    expect(row.actorName).toBe("");
    expect(row.impersonatorId).toBe(0);
    expect(row.actorCredential).toBeNull();
    expect(row.scopeId).toBe("5");
    expect(row.metadata).toBeNull();
    expect(row.ipAddress).toBeNull();
    expect(row.message).toBe("Created organization {scope}.");
  });

  it("auditEventInsert composes into the caller's batch — a failed batch rolls the audit rows back", async () => {
    const d1 = db();
    // The org/repo creates exercise this shape with their own statements;
    // here directly: a batch whose LAST statement violates the audit_event
    // PK rolls back EVERY row of the batch — including the audit rows of
    // statements that "succeeded" before it.
    const base = {
      action: "repository:create",
      actorId: 1,
      actorName: "",
      impersonatorId: 0,
      scopeType: "repository" as const,
      scopeId: "doomed",
      scopeName: null,
      origin: "api" as const,
      message: "m",
      metadata: null,
      ipAddress: null,
      createdUnix: NOW,
    };
    await expect(
      d1.batch([
        auditEventInsert(d1, {
          action: AuditActions.RepositoryCreate,
          actorId: 1,
          scopeType: "repository",
          scopeId: "keep-me",
          origin: "api",
          vars: { scope: "keep" },
          timestamp: NOW,
        }),
        d1.insert(auditEvents).values({ ...base, id: 500 }),
        d1.insert(auditEvents).values({ ...base, id: 500 }), // PK collision → the batch fails
      ]),
    ).rejects.toThrow();
    const rows = await d1.select().from(auditEvents).all();
    expect(rows).toHaveLength(0); // even the first statement's row rolled back
  });
});

// ---------------------------------------------------------------------------
// The paged read + the composite-index witness
// ---------------------------------------------------------------------------

describe("findAuditEvents (upstream FindEvents parity)", () => {
  beforeEach(async () => {
    // Two repos, one org; timestamps clustered so the id tiebreak matters:
    // same-second rows across pages, plus an impersonated event.
    const base = Math.floor(NOW.getTime() / 1000);
    await seedEvent({ action: "repository:create", scopeType: "repository", scopeId: "r1", createdUnix: base - 300 });
    await seedEvent({ action: "repository:visibility:update", scopeType: "repository", scopeId: "r1", createdUnix: base - 200 });
    await seedEvent({ action: "repository:archive", scopeType: "repository", scopeId: "r1", createdUnix: base - 200 });
    await seedEvent({ action: "organization:create", scopeType: "organization", scopeId: "5", createdUnix: base - 100 });
    await seedEvent({
      action: "user:impersonation:start",
      scopeType: "user",
      scopeId: "7",
      createdUnix: base - 50,
      actorId: 9,
      impersonatorId: 1,
    });
  });

  it("pages one scope newest-first (filter + order)", async () => {
    const rows = await findAuditEvents(db(), { scopeType: "repository", scopeId: "r1" });
    expect(rows.map((r) => r.action)).toEqual([
      "repository:archive", // same second as visibility — higher id wins on DESC tiebreak
      "repository:visibility:update",
      "repository:create",
    ]);
  });

  it("exact keyset continuation never repeats nor skips same-second rows", async () => {
    const d1 = db();
    const page1 = await findAuditEvents(d1, { scopeType: "repository", scopeId: "r1", limit: 2 });
    expect(page1).toHaveLength(2);
    const last = page1[page1.length - 1]!;
    const page2 = await findAuditEvents(d1, {
      scopeType: "repository",
      scopeId: "r1",
      limit: 2,
      cursor: { createdUnix: last.createdUnix, id: last.id },
    });
    expect(page2).toHaveLength(1);
    const seen = [...page1, page2[0]!].map((r) => r.id);
    expect(new Set(seen).size).toBe(3); // no dupes
  });

  it("actionPrefix filters the family; exact action wins when both given", async () => {
    const family = await findAuditEvents(db(), { actionPrefix: "repository" });
    expect(family.every((r) => r.action.startsWith("repository:"))).toBe(true);
    expect(family).toHaveLength(3);
    const exact = await findAuditEvents(db(), { action: "repository:create", actionPrefix: "repository" });
    expect(exact.map((r) => r.action)).toEqual(["repository:create"]);
  });

  it("actorId matches impersonated events too (the upstream OR arm)", async () => {
    const byAdmin = await findAuditEvents(db(), { actorId: 1 });
    expect(byAdmin.map((r) => r.action)).toEqual(["user:impersonation:start"]);
    const byActor = await findAuditEvents(db(), { actorId: 9 });
    expect(byActor.map((r) => r.action)).toEqual(["user:impersonation:start"]);
  });

  it("scope filters narrow independently (type without id still filters)", async () => {
    const orgs = await findAuditEvents(db(), { scopeType: "organization" });
    expect(orgs.map((r) => r.scopeId)).toEqual(["5"]);
  });

  it("EXPLAIN witness: the scoped keyset page uses idx_audit_event_scope_created as an ordered range — no sort step", async () => {
    // The d1-index-engineering discipline (docs/research/d1-index-engineering.md
    // §1/§2.1): EXPLAIN through a plain prepare IS the gate, and every probe
    // statement text is made unique with a fresh comment tag — D1 caches
    // compiled plans by SQL text, so a recycled string can report a stale plan.
    const base = Math.floor(NOW.getTime() / 1000);
    const explainSeq = Date.now();
    const sqlText = `EXPLAIN QUERY PLAN SELECT id FROM audit_event
 WHERE scope_type = ? AND scope_id = ?
   AND (created_unix < ? OR (created_unix = ? AND id < ?))
 ORDER BY created_unix DESC, id DESC LIMIT 30 /* audit-scope-page-witness-${explainSeq} */`;
    const plan = await env.DB.prepare(sqlText)
      .bind("repository", "r1", base - 200, base - 200, 1)
      .all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail).join(" | ");
    // COVERING: the witness selects `id` alone, which the composite carries
    // (the d1-index-engineering note's issues-heatmap covering precedent).
    expect(details).toMatch(/USING (COVERING )?INDEX idx_audit_event_scope_created \(scope_type=\? AND scope_id=\?\)/);
    // the ORDER BY must be served by the index (backwards scan), not a sort
    expect(details).not.toMatch(/TEMP B-TREE/);
  });

  it("EXPLAIN witness: the retention probe and the family-prefix filter ride their indexes", async () => {
    const base = Math.floor(NOW.getTime() / 1000);
    const seq = Date.now();
    const probe = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM audit_event WHERE created_unix < ? LIMIT 1 /* audit-retention-probe-witness-${seq} */`,
    )
      .bind(base - 90 * DAY)
      .all<{ detail: string }>();
    expect(probe.results.map((r) => r.detail).join(" | ")).toMatch(/USING (COVERING )?INDEX idx_audit_event_created/);
    const prefix = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM audit_event WHERE action LIKE 'repository:%' /* audit-prefix-witness-${seq} */`,
    )
      .all<{ detail: string }>();
    // SQLite words the LIKE-prefix optimization as an index SCAN carrying the
    // range — the plan names the action index either way (SEARCH or SCAN).
    expect(prefix.results.map((r) => r.detail).join(" | ")).toMatch(
      /USING (COVERING )?INDEX idx_audit_event_action/,
    );
  });
});

// ---------------------------------------------------------------------------
// Slice-one instrumentation — the transactional coupling (§4.2 + §5)
// ---------------------------------------------------------------------------

describe("slice-one instrumentation", () => {
  it("RepoService.create emits repository:create inside the create batch", async () => {
    await seedUser(42, "alice");
    const svc = new RepoService(env.DB);
    const repo = await svc.create({ owner: { id: 42, usernameLower: "alice" }, name: "alpha", isPrivate: false });
    const rows = await findAuditEvents(db(), { scopeType: "repository", scopeId: repo.id });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("repository:create");
    expect(row.actorId).toBe(42);
    expect(row.actorName).toBe("alice");
    expect(row.scopeName).toBe("alice/alpha");
    expect(row.message).toBe("Created repository alice/alpha.");
    expect(row.origin).toBe("api"); // the service-level v1 default
    expect(JSON.parse(row.metadata ?? "")).toEqual({ visibility: "public", status: "ready" });
  });

  it("an explicit origin hint overrides the default", async () => {
    const svc = new RepoService(env.DB);
    const repo = await svc.create({
      owner: { id: 42, usernameLower: "alice" },
      name: "beta",
      isPrivate: true,
      origin: "ui",
    });
    const rows = await findAuditEvents(db(), { scopeType: "repository", scopeId: repo.id });
    expect(rows[0]!.origin).toBe("ui");
    expect(JSON.parse(rows[0]!.metadata ?? "")).toEqual({ visibility: "private", status: "ready" });
  });

  it("a failed repo create emits nothing (transactional coupling)", async () => {
    await seedUser(42, "alice");
    const svc = new RepoService(env.DB);
    await svc.create({ owner: { id: 42, usernameLower: "alice" }, name: "alpha", isPrivate: false });
    await expect(
      svc.create({ owner: { id: 42, usernameLower: "alice" }, name: "alpha", isPrivate: true }),
    ).rejects.toThrow(RepoNameCollisionError);
    const all = await db().select().from(auditEvents).all();
    expect(all).toHaveLength(1); // only the successful create's event
  });

  it("OrgService.createOrg emits organization:create — scope_id resolves to the in-batch org id (text)", async () => {
    await seedUser(7, "bob");
    const svc = new OrgService(env.DB);
    const org = await svc.createOrg({ name: "acme", ownerId: 7 });
    const rows = await findAuditEvents(db(), { scopeType: "organization", scopeId: String(org.id) });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("organization:create");
    expect(row.actorId).toBe(7);
    expect(row.actorName).toBe("bob"); // the in-batch subquery snapshot
    expect(row.scopeId).toBe(String(org.id)); // the scalar-subquery + cast proof
    expect(row.scopeName).toBe("acme");
    expect(row.message).toBe("Created organization acme.");
  });

  it("a failed org create emits nothing (transactional coupling)", async () => {
    await seedUser(7, "bob");
    const svc = new OrgService(env.DB);
    await svc.createOrg({ name: "acme", ownerId: 7 });
    await expect(svc.createOrg({ name: "acme", ownerId: 7 })).rejects.toThrow(OrgNameCollisionError);
    const all = await db().select().from(auditEvents).all();
    expect(all).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Retention (§4.3) — the producer gate + the consumer prune
// ---------------------------------------------------------------------------

describe("retention producer (enqueueDueAuditRetention)", () => {
  it("auditRetentionDaysFromEnv: strict positive-integer parse, else null", () => {
    expect(auditRetentionDaysFromEnv({ AUDIT_RETENTION_DAYS: "90" })).toBe(90);
    expect(auditRetentionDaysFromEnv({ AUDIT_RETENTION_DAYS: "0" })).toBeNull();
    expect(auditRetentionDaysFromEnv({ AUDIT_RETENTION_DAYS: "-7" })).toBeNull();
    expect(auditRetentionDaysFromEnv({ AUDIT_RETENTION_DAYS: "true" })).toBeNull();
    expect(auditRetentionDaysFromEnv({ AUDIT_RETENTION_DAYS: " 90" })).toBeNull(); // no trim — the strict gate
    expect(auditRetentionDaysFromEnv({})).toBeNull();
  });

  it("disarmed: zero reads (the tripwire D1 is never touched), zero sends, zero logs", async () => {
    const logSpy = vi.spyOn(console, "log");
    const queue = spyQueue();
    // The tripwire DB throws on first touch — any probe by gated-off code
    // fails the test naming what was touched.
    const env0 = retentionEnv({ AUDIT_RETENTION_DAYS: undefined }, queue, d1ThatThrows());
    await expect(enqueueDueAuditRetention(env0, { now: NOW })).resolves.toBe(0);
    expect(totalSends(queue)).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("armed + nothing expired: probes once, enqueues nothing, logs the compact line", async () => {
    const logSpy = vi.spyOn(console, "log");
    const queue = spyQueue();
    const base = Math.floor(NOW.getTime() / 1000);
    await seedEvent({ action: "repository:create", scopeType: "repository", scopeId: "r1", createdUnix: base - 10 * DAY });
    const enqueued = await enqueueDueAuditRetention(
      { DB: env.DB, REPO_TASKS: queue, AUDIT_RETENTION_DAYS: "90" },
      { now: NOW },
    );
    expect(enqueued).toBe(0);
    expect(totalSends(queue)).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[audit-retention] 0 due"));
  });

  it("armed + expired rows: exactly one {kind: audit-retention} message", async () => {
    const queue = spyQueue();
    const base = Math.floor(NOW.getTime() / 1000);
    await seedEvent({ action: "repository:create", scopeType: "repository", scopeId: "r1", createdUnix: base - 91 * DAY });
    await seedEvent({ action: "repository:create", scopeType: "repository", scopeId: "r1", createdUnix: base - 10 * DAY });
    const enqueued = await enqueueDueAuditRetention(
      { DB: env.DB, REPO_TASKS: queue, AUDIT_RETENTION_DAYS: "90" },
      { now: NOW },
    );
    expect(enqueued).toBe(1);
    expect(totalSends(queue)).toBe(1);
    expect(queue.bodies[0]!).toEqual([{ kind: "audit-retention" }]);
    expect(isAuditRetentionMessage(queue.bodies[0]![0])).toBe(true);
    expect(isAuditRetentionMessage({ kind: "other" })).toBe(false);
  });

  it("armed but unbound is a config bug — throws", async () => {
    await expect(
      enqueueDueAuditRetention({ AUDIT_RETENTION_DAYS: "90" }, { now: NOW }),
    ).rejects.toThrow(/not bound/);
  });
});

describe("retention consumer (pruneExpiredAuditEvents)", () => {
  const base = Math.floor(NOW.getTime() / 1000);

  beforeEach(async () => {
    await seedEvent({ action: "repository:create", scopeType: "repository", scopeId: "old", createdUnix: base - 91 * DAY });
    await seedEvent({ action: "repository:archive", scopeType: "repository", scopeId: "old", createdUnix: base - 100 * DAY });
    await seedEvent({ action: "repository:create", scopeType: "repository", scopeId: "new", createdUnix: base - 89 * DAY });
    await seedEvent({ action: "organization:create", scopeType: "organization", scopeId: "5", createdUnix: base });
  });

  it("deletes exactly the expired rows; a second pass is a no-op (idempotent)", async () => {
    const env0 = { DB: env.DB };
    const first = await pruneExpiredAuditEvents(env0, { now: NOW, days: 90 });
    expect(first).toBe(2);
    const remaining = await db().select().from(auditEvents).all();
    expect(remaining.map((r) => r.scopeId).sort()).toEqual(["5", "new"]);
    await expect(pruneExpiredAuditEvents(env0, { now: NOW, days: 90 })).resolves.toBe(0);
  });

  it("page cap: bounded bites per invocation, the redelivery finishes the job", async () => {
    for (let i = 0; i < 5; i++) {
      await seedEvent({
        action: "repository:create",
        scopeType: "repository",
        scopeId: `old${i}`,
        createdUnix: base - 91 * DAY,
      });
    }
    const env0 = { DB: env.DB };
    const bite = await pruneExpiredAuditEvents(env0, { now: NOW, days: 90, pageSize: 2, maxPages: 2 });
    expect(bite).toBe(4); // 2 pages x 2 rows — the cap held the invocation
    const finish = await pruneExpiredAuditEvents(env0, { now: NOW, days: 90, pageSize: 2, maxPages: 40 });
    expect(finish).toBe(3); // the remaining old row + the beforeEach pair
  });

  it("window default: the consumer applies 90 days when the var is absent", async () => {
    expect(DEFAULT_AUDIT_RETENTION_DAYS).toBe(90);
    const deleted = await pruneExpiredAuditEvents({ DB: env.DB }, { now: NOW });
    expect(deleted).toBe(2); // 91 + 100 days old; the 89-day row survives
  });
});

// ---------------------------------------------------------------------------
// The dispatcher block (demo-sweep.ts hourly entry)
// ---------------------------------------------------------------------------

describe("handleScheduledCron audit-retention dispatch", () => {
  /** The dispatcher env with the gate vars overridden — the demo-sweep.test.ts
   *  mutation pattern (wrangler types declared vars by their literal config
   *  value, so a spread override alone cannot flip them). */
  function dispatcherEnv(dbOverride: D1Database, queue: Queue): Env {
    const copy = { ...env, DB: dbOverride, REPO_TASKS: queue };
    (copy as { DEMO_MODE: string }).DEMO_MODE = "false";
    // AUDIT_RETENTION_DAYS is not in the generated Env yet — the mutation
    // pattern carries it; "" is INVALID by the strict parse, pinning the
    // producer disarmed regardless of any future config default.
    (copy as { DEMO_MODE: string; AUDIT_RETENTION_DAYS?: string }).AUDIT_RETENTION_DAYS = "";
    return copy;
  }

  it("hourly entry with both gates off: zero D1 reads (tripwire), zero sends, zero logs", async () => {
    const logSpy = vi.spyOn(console, "log");
    const queue = spyQueue();
    const copy = dispatcherEnv(d1ThatThrows(), queue);
    await expect(handleScheduledCron(cronController(DEMO_SWEEP_CRON), copy)).resolves.toBeUndefined();
    expect(totalSends(queue)).toBe(0);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("hourly entry armed: expired rows fan out exactly one message", async () => {
    const base = Math.floor(NOW.getTime() / 1000);
    await seedEvent({ action: "repository:create", scopeType: "repository", scopeId: "old", createdUnix: base - 91 * DAY });
    const queue = spyQueue();
    const copy = dispatcherEnv(env.DB, queue);
    (copy as { DEMO_MODE: string; AUDIT_RETENTION_DAYS?: string }).AUDIT_RETENTION_DAYS = "90";
    await handleScheduledCron(cronController(DEMO_SWEEP_CRON), copy);
    expect(totalSends(queue)).toBe(1);
    expect(queue.bodies[0]!).toEqual([{ kind: "audit-retention" }]);
  });
});
