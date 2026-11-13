/**
 * The B-65 receivers' per-arm battery (services/mail/notify.ts's three
 * census arms, behavior pin fc4936884584):
 *
 *   - `notifyNewRelease` (notify.go:191-203 → mail_release.go:33-119): the
 *     draft/prerelease skip, the release-watch pool (include_releases gate +
 *     the custom-watch set feeding the on-mention allowance), the
 *     publisher / on-mention / releases-unit DeleteFunc, the mailable
 *     filter, the subject / Message-ID / no-metadata-headers bytes, the
 *     attachment rows, the dedupe identity.
 *   - `notifyRepoPendingTransfer` (notify.go:204-209 → mail_repo.go:27-103):
 *     the org fan per the canCreateOrgRepo grant set (owner bridge, team
 *     grants, the mailable filter), the user arm, the to_you/to subjects,
 *     the UID info line, the no-Message-ID posture, the dedupe identity
 *     (the pending row's own id), the missing-pending-row skip.
 *   - `notifyWorkflowRunStatusUpdate` (notify.go:210-215 →
 *     mail_workflow_run.go:152-177): the done/skipped gate, the mailable
 *     gate, the KV preference matrix (disabled / failure-only default / all
 *     × success/failure/cancelled/skipped), the latest-attempt recipient
 *     resolution, the jobs-not-done no-mail, the failures-first sort, the
 *     subject / Message-ID / both-sides-recipient headers / metadata bytes,
 *     the dedupe identity.
 *
 * Plus the repo.ts transfer-route emit pin (the wiring under test): POST
 * /repos/{owner}/{repo}/transfer through the REAL router lands one
 * repo-transfer-notify row per recipient with the mail env armed, and ZERO
 * rows with the shipped mail-off posture — the route's catch-and-log seam
 * must never fail the 201 either way.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import type { ApiEnv } from "../../api/env";
import type { User } from "../../api/models/user";
import {
  createOptionalTokenAuthMiddleware,
  createTokenAuthMiddleware,
  type AuthResolver,
} from "../../api/auth";
import { mintFor } from "../../auth/testing/seeds";
import { giteaErrorHandler } from "../../api/errors";
import { registerRepoRoutes } from "../../api/routes/repo";
import { applyRepoExtrasDdl } from "../../api/testing/repo-ddl";
import {
  ACTION_STATUS_CANCELLED,
  ACTION_STATUS_FAILURE,
  ACTION_STATUS_RUNNING,
  ACTION_STATUS_SKIPPED,
  ACTION_STATUS_SUCCESS,
} from "../actions/model";
import {
  actionRunAttempts,
  actionRunJobs,
  actionRuns,
  emailOutbox,
  orgMembers,
  releaseAssets,
  repoSettings,
  repoTransfer,
  repoWatchers,
  repositories,
  teamMembers,
  teams,
  userSettings,
  users,
} from "../../db/schema";
import { IssuesService, type ReleaseRow } from "../../issues/service";
import { formatByteSize } from "./templates";
import {
  notifyNewRelease,
  notifyRepoPendingTransfer,
  notifyWorkflowRunStatusUpdate,
  type MailNotifyEnv,
} from "./notify";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyRepoExtrasDdl();
});

const REPO_ID = "600";
const ORG_ID = 95;

const FIXTURE_USERS: Array<{
  id: number;
  username: string;
  email: string | null;
  type?: string;
  status?: string;
}> = [
  { id: 1, username: "repoowner", email: "owner@example.com" },
  { id: 20, username: "releasewatcher", email: "rw@example.com" },
  { id: 60, username: "publisher", email: "pub@example.com" },
  { id: 80, username: "onmention", email: "om@example.com" },
  { id: 95, username: "orgish", email: null, type: "org" },
  { id: 96, username: "frozen", email: "fz@example.com", status: "prohibited" },
  { id: 100, username: "transferee", email: "tr@example.com" },
  { id: 110, username: "orgowner", email: "oo@example.com" },
  { id: 120, username: "teamgrant", email: "tg@example.com" },
  { id: 130, username: "plainmember", email: "pm@example.com" },
  { id: 140, username: "orgfrozen", email: "of@example.com", status: "prohibited" },
  { id: 150, username: "teamownerrole", email: "tor@example.com" },
  { id: 200, username: "attempttrigger", email: "at@example.com" },
  { id: 210, username: "runtrigger", email: "rt@example.com" },
  { id: 300, username: "other", email: "other@example.com" },
];

/** Recording Queue — counts sends AND captures every body. */
function spyQueue(): Queue & { sends: number; sendBodies: Array<{ kind: string; mailId: number }> } {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const queue = {
    sends: 0,
    sendBodies: [] as Array<{ kind: string; mailId: number }>,
    send: (body: unknown) => {
      queue.sends += 1;
      queue.sendBodies.push(body as { kind: string; mailId: number });
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: MessageSendRequest[]) => {
      queue.sends += messages.length;
      for (const m of messages) queue.sendBodies.push(m.body as { kind: string; mailId: number });
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve(metadata.metrics),
  };
  return queue;
}

/** The A2 dual gate: the notify-mail receiver registers only on top of a
 *  live mail service (mailer.go:33-35) — both vars ride the armed fixture. */
function armedEnv(overrides: Partial<MailNotifyEnv> = {}): MailNotifyEnv {
  return {
    DB: env.DB,
    REPO_TASKS: spyQueue(),
    APP_URL: "https://mail.example",
    MAIL_ENABLED: "true",
    ENABLE_NOTIFY_MAIL: "true",
    MAIL_FROM: "Gitea <noreply@example.com>",
    ...overrides,
  };
}

const db = () => drizzle(env.DB);

const SEED_TIME = new Date("2026-05-01T00:00:00Z");

async function seedRepo(): Promise<void> {
  await db().insert(repositories).values({
    id: REPO_ID,
    storageKey: `r_${REPO_ID}`,
    ownerNamespace: "repoowner",
    ownerId: 1,
    slug: "repo",
    visibility: "public",
    status: "ready",
  });
}

async function seedRelease(row: {
  tagName: string;
  isDraft?: boolean;
  isPrerelease?: boolean;
  note?: string;
  publisherId?: number;
}): Promise<ReleaseRow> {
  const release = await new IssuesService(env.DB).createRelease({
    repoId: REPO_ID,
    publisherId: row.publisherId ?? 60,
    tagName: row.tagName,
    target: "main",
    title: `Release ${row.tagName}`,
    note: row.note ?? "",
    isDraft: row.isDraft ?? false,
    isPrerelease: row.isPrerelease ?? false,
  });
  return release;
}

async function seedPendingTransfer(newOwnerId: number): Promise<{ id: number }> {
  const rows = await db()
    .insert(repoTransfer)
    .values({ repoId: REPO_ID, doerId: 1, newOwnerId, createdAt: SEED_TIME })
    .returning({ id: repoTransfer.id })
    .all();
  return rows[0]!;
}

async function outboxRows(): Promise<Array<typeof emailOutbox.$inferSelect>> {
  return db().select().from(emailOutbox).all();
}

beforeEach(async () => {
  for (const table of [
    "email_outbox",
    "release_assets",
    "releases",
    "repo_transfer",
    "org_members",
    "team_members",
    "teams",
    "user_settings",
    "user_settings_kv",
    "action_run_attempts",
    "action_run_jobs",
    "action_runs",
    "repo_watchers",
    "repo_settings",
    "issues",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const user of FIXTURE_USERS) {
    await env.DB
      .prepare(
        "INSERT INTO users (id, username, username_lower, email, status, type, created_at) VALUES (?, ?, ?, ?, ?, ?, 0)",
      )
      .bind(user.id, user.username, user.username, user.email, user.status ?? "active", user.type ?? "user")
      .run();
  }
  // The org grant set: the owner bridge (110), the unmailable owner (140),
  // a plain membership (130). The team grant arms: team 10
  // can_create_org_repo (member 120), team 11 no grant (member 130), team
  // 12 authorize='owner' (member 150).
  await db().insert(orgMembers).values([
    { orgId: ORG_ID, userId: 110, role: "owner", isPublic: false, createdAt: SEED_TIME },
    { orgId: ORG_ID, userId: 140, role: "owner", isPublic: false, createdAt: SEED_TIME },
    { orgId: ORG_ID, userId: 130, role: "member", isPublic: false, createdAt: SEED_TIME },
  ]);
  await db().insert(teams).values([
    { id: 10, orgId: ORG_ID, lowerName: "creators", name: "creators", canCreateOrgRepo: true, authorize: "none" },
    { id: 11, orgId: ORG_ID, lowerName: "plain", name: "plain", canCreateOrgRepo: false, authorize: "none" },
    { id: 12, orgId: ORG_ID, lowerName: "ownerrole", name: "ownerrole", canCreateOrgRepo: false, authorize: "owner" },
  ]);
  await db().insert(teamMembers).values([
    { orgId: ORG_ID, teamId: 10, userId: 120 },
    { orgId: ORG_ID, teamId: 11, userId: 130 },
    { orgId: ORG_ID, teamId: 12, userId: 150 },
  ]);
});

// ---------------------------------------------------------------------------
// notifyNewRelease — the NewRelease arm (notify.go:191-203)
// ---------------------------------------------------------------------------

describe("notifyNewRelease — the NewRelease receiver (notify.go:191-203)", () => {
  it("a draft and a prerelease skip before any query (notify.go:194-197)", async () => {
    await seedRepo();
    const draft = await seedRelease({ tagName: "v1.0", isDraft: true });
    const pre = await seedRelease({ tagName: "v2.0", isPrerelease: true });
    expect((await notifyNewRelease(armedEnv(), { release: draft, publisher: (await db().select().from(users).where(eq(users.id, 60)).get())! })).outcome).toBe(
      "no-recipients",
    );
    expect((await notifyNewRelease(armedEnv(), { release: pre, publisher: (await db().select().from(users).where(eq(users.id, 60)).get())! })).outcome).toBe(
      "no-recipients",
    );
    expect(await outboxRows()).toHaveLength(0);
  });

  it("mails the release-watch pool: the watcher gets ONE row with the release bytes; the publisher never self-mails", async () => {
    await seedRepo();
    await db().insert(repoWatchers).values([
      { repoId: REPO_ID, userId: 20 }, // the release watcher
      { repoId: REPO_ID, userId: 60 }, // the publisher watches too
    ]);
    const release = await seedRelease({ tagName: "v1.0" });
    const publisher = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    const outcome = await notifyNewRelease(armedEnv(), { release, publisher });
    expect(outcome).toMatchObject({ outcome: "enqueued", recipientIds: [20] });
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.toAddr).toBe("rw@example.com");
    expect(row.subject).toBe("v1.0 in repoowner/repo released");
    expect(row.info).toBe("v1.0 in repoowner/repo released");
    expect(row.fromAddress).toBe("noreply@example.com");
    expect(row.fromDisplayName).toBe("publisher"); // mailFromDisplayName: no full name → username
    const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
    expect(Object.keys(headers)).toEqual(["Message-ID"]); // NO metadata/sender headers on this arm
    expect(headers["Message-ID"]).toBe("<repoowner/repo/releases/" + release.id + "@mail.example>");
    expect(row.dedupeKey).toBe(`new-release:${release.id}:20`);
    expect(row.bodyHtml).toContain("v1.0");
    expect(row.bodyHtml).toContain("Release v1.0"); // the Title line
  });

  it("the include_releases gate drops a watcher whose row excludes releases (watch.go:266-282)", async () => {
    await seedRepo();
    await db().insert(repoWatchers).values([{ repoId: REPO_ID, userId: 20, includeReleases: false }]);
    const release = await seedRelease({ tagName: "v1.0" });
    expect(
      (await notifyNewRelease(armedEnv(), { release, publisher: (await db().select().from(users).where(eq(users.id, 60)).get())! }))
        .outcome,
    ).toBe("no-recipients");
    expect(await outboxRows()).toHaveLength(0);
  });

  it("an onmention preference receives only with a custom watch (mail_release.go:57-79's GetMailableUsersByIDs mention arm)", async () => {
    await seedRepo();
    await db().insert(userSettings).values({ userId: 80, emailNotificationsPreference: "onmention" });
    // A plain full watch: NOT custom → the onmention user drops.
    await db().insert(repoWatchers).values([{ repoId: REPO_ID, userId: 80 }]);
    const plain = await seedRelease({ tagName: "v1.0" });
    expect(
      (await notifyNewRelease(armedEnv(), { release: plain, publisher: (await db().select().from(users).where(eq(users.id, 60)).get())! }))
        .outcome,
    ).toBe("no-recipients");
    // A CUSTOM watch (any include false) unlocks the allowance — flip the row.
    await db()
      .update(repoWatchers)
      .set({ includeIssues: false })
      .where(and(eq(repoWatchers.repoId, REPO_ID), eq(repoWatchers.userId, 80)));
    const custom = await seedRelease({ tagName: "v2.0" });
    expect(
      (await notifyNewRelease(armedEnv(), { release: custom, publisher: (await db().select().from(users).where(eq(users.id, 60)).get())! }))
        .outcome,
    ).toBe("enqueued");
    expect((await outboxRows()).map((row) => row.toAddr)).toEqual(["om@example.com"]);
  });

  it("the releases unit gate drops non-admins when the unit is off (CheckRepoUnitUser's unit half; the admin short-circuit is the A3 fold in notify.test.ts)", async () => {
    await seedRepo();
    await db().insert(repoWatchers).values([
      { repoId: REPO_ID, userId: 20 },
      { repoId: REPO_ID, userId: 1 },
    ]);
    await db().insert(repoSettings).values({ repoId: REPO_ID, hasReleases: false });
    const release = await seedRelease({ tagName: "v1.0" });
    expect(
      (await notifyNewRelease(armedEnv(), { release, publisher: (await db().select().from(users).where(eq(users.id, 60)).get())! }))
        .outcome,
    ).toBe("no-recipients");
    expect(await outboxRows()).toHaveLength(0);
  });

  it("the mailable filter: a frozen watcher and a disabled preference both drop (GetMailableUsersByIDs)", async () => {
    await seedRepo();
    await db().insert(repoWatchers).values([
      { repoId: REPO_ID, userId: 96 }, // prohibited
      { repoId: REPO_ID, userId: 20 },
    ]);
    await db().insert(userSettings).values({ userId: 20, emailNotificationsPreference: "disabled" });
    const release = await seedRelease({ tagName: "v1.0" });
    expect(
      (await notifyNewRelease(armedEnv(), { release, publisher: (await db().select().from(users).where(eq(users.id, 60)).get())! }))
        .outcome,
    ).toBe("no-recipients");
    expect(await outboxRows()).toHaveLength(0);
  });

  it("the body renders the attachment rows with the absolute /attachments/ URL and the IBytes size (mail_release.go:98-107)", async () => {
    await seedRepo();
    await db().insert(repoWatchers).values([{ repoId: REPO_ID, userId: 20 }]);
    const release = await seedRelease({ tagName: "v1.0", note: "## notes" });
    await db().insert(releaseAssets).values({
      uuid: "asset-uuid-1",
      repoId: REPO_ID,
      releaseId: release.id,
      name: "bundle.zip",
      size: 15 * 1024 * 1024,
      r2Key: `r2/asset-uuid-1`,
    });
    await notifyNewRelease(armedEnv(), { release, publisher: (await db().select().from(users).where(eq(users.id, 60)).get())! });
    const row = (await outboxRows())[0]!;
    expect(row.bodyHtml).toContain("https://mail.example/attachments/asset-uuid-1");
    expect(row.bodyHtml).toContain("bundle.zip");
    expect(row.bodyHtml).toContain(formatByteSize(15 * 1024 * 1024));
    expect(row.bodyHtml).toContain("https://mail.example/repoowner/repo/releases/tag/v1.0");
  });

  it("the gate-offs: MAIL_ENABLED off → disabled (zero rows); a malformed MAIL_FROM → misconfigured", async () => {
    await seedRepo();
    await db().insert(repoWatchers).values([{ repoId: REPO_ID, userId: 20 }]);
    const release = await seedRelease({ tagName: "v1.0" });
    const publisher = (await db().select().from(users).where(eq(users.id, 60)).get())!;
    expect((await notifyNewRelease(armedEnv({ MAIL_ENABLED: "false" }), { release, publisher })).outcome).toBe("disabled");
    expect((await notifyNewRelease(armedEnv({ MAIL_FROM: "not-an-address" }), { release, publisher })).outcome).toBe("misconfigured");
    expect(await outboxRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// notifyRepoPendingTransfer — the RepoPendingTransfer arm (notify.go:204-209)
// ---------------------------------------------------------------------------

describe("notifyRepoPendingTransfer — the RepoPendingTransfer receiver (notify.go:204-209)", () => {
  it("the user arm: the target user alone gets the to_you mail with the UID info line and NO Message-ID", async () => {
    await seedRepo();
    const transfer = await seedPendingTransfer(100);
    const doer = (await db().select().from(users).where(eq(users.id, 1)).get())!;
    const newOwner = (await db().select().from(users).where(eq(users.id, 100)).get())!;
    const outcome = await notifyRepoPendingTransfer(armedEnv(), { repoId: REPO_ID, doer, newOwner });
    expect(outcome).toMatchObject({ outcome: "enqueued", recipientIds: [100] });
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.toAddr).toBe("tr@example.com");
    expect(row.subject).toBe(`repoowner would like to transfer "repoowner/repo" to you`);
    expect(row.info).toBe("UID: 100, repository pending transfer notification");
    expect(row.headers).toBeNull(); // no Message-ID, no metadata headers upstream
    expect(row.dedupeKey).toBe(`repo-transfer-notify:${transfer.id}:100`);
    expect(row.bodyHtml).toContain("To accept or reject it");
    expect(row.fromDisplayName).toBe("repoowner"); // no full name → the bare username form
  });

  it("the org arm fans per the canCreateOrgRepo grant set: the owner bridge, both team grants; the plain member and the unmailable owner stay out (mail_repo.go:31-54)", async () => {
    await seedRepo();
    await seedPendingTransfer(ORG_ID);
    const doer = (await db().select().from(users).where(eq(users.id, 1)).get())!;
    const newOwner = (await db().select().from(users).where(eq(users.id, ORG_ID)).get())!;
    const outcome = await notifyRepoPendingTransfer(armedEnv(), { repoId: REPO_ID, doer, newOwner });
    expect(outcome.outcome).toBe("enqueued");
    if (outcome.outcome !== "enqueued") return; // narrow
    expect([...outcome.recipientIds].sort((a, b) => a - b)).toEqual([110, 120, 150]); // owner bridge + both team grants
    const rows = await outboxRows();
    expect(rows).toHaveLength(3);
    // The org subject names the org as destination ("to <org display>").
    for (const row of rows) {
      expect(row.subject).toBe(`repoowner would like to transfer "repoowner/repo" to orgish`);
    }
  });

  it("a non-mailable target drops the mail (IsMailable — the email-notification PREFERENCE does not gate this arm, mail_repo.go's only filter); a missing pending row skips (the off-path guard)", async () => {
    await seedRepo();
    await seedPendingTransfer(96); // prohibited — not mailable
    const doer = (await db().select().from(users).where(eq(users.id, 1)).get())!;
    const frozenOwner = (await db().select().from(users).where(eq(users.id, 96)).get())!;
    expect((await notifyRepoPendingTransfer(armedEnv(), { repoId: REPO_ID, doer, newOwner: frozenOwner })).outcome).toBe("no-recipients");
    // The disabled PREFERENCE does NOT drop the user arm (upstream's filter
    // is IsMailable alone) — the preference matrix belongs to the watcher
    // fan-out arms, not the transfer mail.
    await db().delete(repoTransfer);
    await seedPendingTransfer(100);
    await db().insert(userSettings).values({ userId: 100, emailNotificationsPreference: "disabled" });
    const target = (await db().select().from(users).where(eq(users.id, 100)).get())!;
    expect((await notifyRepoPendingTransfer(armedEnv(), { repoId: REPO_ID, doer, newOwner: target })).outcome).toBe("enqueued");
    // No pending row at all → the degradation rule, zero rows.
    await db().delete(repoTransfer);
    expect((await notifyRepoPendingTransfer(armedEnv(), { repoId: REPO_ID, doer, newOwner: target })).outcome).toBe("no-recipients");
    expect(await outboxRows()).toHaveLength(1); // only the enabled-pref arm above
  });

  it("a re-drive of the same pending request dedupes (the row-id dedupe identity); MAIL off degrades like the sibling arms", async () => {
    await seedRepo();
    await seedPendingTransfer(100);
    const doer = (await db().select().from(users).where(eq(users.id, 1)).get())!;
    const newOwner = (await db().select().from(users).where(eq(users.id, 100)).get())!;
    await notifyRepoPendingTransfer(armedEnv(), { repoId: REPO_ID, doer, newOwner });
    const second = await notifyRepoPendingTransfer(armedEnv(), { repoId: REPO_ID, doer, newOwner });
    expect(second.outcome === "enqueued" && second.enqueue.every((e) => e.outcome === "deduped")).toBe(true);
    expect(await outboxRows()).toHaveLength(1);
    expect((await notifyRepoPendingTransfer(armedEnv({ MAIL_ENABLED: "false" }), { repoId: REPO_ID, doer, newOwner })).outcome).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// notifyWorkflowRunStatusUpdate — the WorkflowRunStatusUpdate arm
// ---------------------------------------------------------------------------

/** Seed a settled run (default: one failed job, trigger 210, no attempt). */
async function seedRun(row: {
  status: number;
  jobStatuses?: number[];
  triggerUserId?: number;
  latestAttemptId?: number;
  ref?: string;
  workflowId?: string;
  index?: number;
}): Promise<{ run: typeof actionRuns.$inferSelect }> {
  const now = SEED_TIME;
  const inserted = await db()
    .insert(actionRuns)
    .values({
      repoId: REPO_ID,
      ownerId: 1,
      index: row.index ?? 1,
      workflowId: row.workflowId ?? "ci.yml",
      ref: row.ref ?? "refs/heads/main",
      commitSha: "1234567890abcdef1234567890abcdef12345678",
      status: row.status,
      triggerUserId: row.triggerUserId ?? 210,
      latestAttemptId: row.latestAttemptId ?? 0,
      created: now,
      updated: now,
    })
    .returning()
    .all();
  const run = inserted[0]!;
  const statuses = row.jobStatuses ?? [row.status];
  let attempt = run.latestAttemptId;
  if (attempt <= 0 && statuses.some((s) => s !== row.status)) {
    // Job rows carry the run's own attempt id when the run has none — the
    // receiver's fallback query filters runId only.
    attempt = 0;
  }
  await db().insert(actionRunJobs).values(
    statuses.map((status, i) => ({
      runId: run.id,
      repoId: REPO_ID,
      ownerId: 1,
      name: i === 0 ? "build" : "deploy",
      status,
      runAttemptId: attempt,
      workflowPayload: new TextEncoder().encode("{}"),
      started: now,
      stopped: now,
      created: now,
      updated: now,
    })),
  );
  return { run };
}

describe("notifyWorkflowRunStatusUpdate — the WorkflowRunStatusUpdate receiver (notify.go:210-215)", () => {
  it("gate 1: a running or skipped run never mails (mail_workflow_run.go:159)", async () => {
    await seedRepo();
    const running = await seedRun({ status: ACTION_STATUS_RUNNING });
    const skipped = await seedRun({ status: ACTION_STATUS_SKIPPED, index: 2 });
    expect((await notifyWorkflowRunStatusUpdate(armedEnv(), { run: running.run })).outcome).toBe("no-recipients");
    expect((await notifyWorkflowRunStatusUpdate(armedEnv({ MAIL_ENABLED: "false", ENABLE_NOTIFY_MAIL: "false" }), { run: skipped.run })).outcome).toBe(
      "no-recipients",
    );
    expect(await outboxRows()).toHaveLength(0);
  });

  it("the KV pref matrix, default failure-only: a failure mails, a success does not (setting_options.go:23)", async () => {
    await seedRepo();
    const failure = await seedRun({ status: ACTION_STATUS_FAILURE, jobStatuses: [ACTION_STATUS_FAILURE], index: 1 });
    const success = await seedRun({ status: ACTION_STATUS_SUCCESS, jobStatuses: [ACTION_STATUS_SUCCESS], index: 2 });
    expect((await notifyWorkflowRunStatusUpdate(armedEnv(), { run: failure.run })).outcome).toBe("enqueued");
    expect((await notifyWorkflowRunStatusUpdate(armedEnv(), { run: success.run })).outcome).toBe("no-recipients");
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toAddr).toBe("rt@example.com");
  });

  it("the KV pref matrix, explicit values: disabled never sends; 'all' sends every done status (mail_workflow_run.go:164-175)", async () => {
    await seedRepo();
    await db().insert(userSettings).values({ userId: 210, actionsEmailNotificationsPreference: "disabled" });
    const failure = await seedRun({ status: ACTION_STATUS_FAILURE, jobStatuses: [ACTION_STATUS_FAILURE] });
    expect((await notifyWorkflowRunStatusUpdate(armedEnv(), { run: failure.run })).outcome).toBe("no-recipients");

    await db().update(userSettings).set({ actionsEmailNotificationsPreference: "all" }).where(eq(userSettings.userId, 210));
    const success = await seedRun({ status: ACTION_STATUS_SUCCESS, jobStatuses: [ACTION_STATUS_SUCCESS], index: 2 });
    const cancelled = await seedRun({ status: ACTION_STATUS_CANCELLED, jobStatuses: [ACTION_STATUS_CANCELLED], index: 3 });
    expect((await notifyWorkflowRunStatusUpdate(armedEnv(), { run: success.run })).outcome).toBe("enqueued");
    expect((await notifyWorkflowRunStatusUpdate(armedEnv(), { run: cancelled.run })).outcome).toBe("enqueued");
    // A skipped run stays silent even on 'all' (gate 1 outranks the pref).
    const skipped = await seedRun({ status: ACTION_STATUS_SKIPPED, jobStatuses: [ACTION_STATUS_SKIPPED], index: 4 });
    expect((await notifyWorkflowRunStatusUpdate(armedEnv(), { run: skipped.run })).outcome).toBe("no-recipients");
    expect(await outboxRows()).toHaveLength(2);
  });

  it("the recipient is the LATEST attempt's trigger user when the run carries one (services/actions/notify.go:71-85)", async () => {
    await seedRepo();
    const now = SEED_TIME;
    const attempt = await db()
      .insert(actionRunAttempts)
      .values({ repoId: REPO_ID, runId: 0, attempt: 1, triggerUserId: 200, status: ACTION_STATUS_FAILURE, created: now, updated: now })
      .returning({ id: actionRunAttempts.id })
      .all();
    // seedRun gives the job rows runAttemptId = latestAttemptId (the
    // receiver's attempt filter).
    const { run } = await seedRun({
      status: ACTION_STATUS_FAILURE,
      jobStatuses: [ACTION_STATUS_FAILURE],
      triggerUserId: 210,
      latestAttemptId: attempt[0]!.id,
    });
    const outcome = await notifyWorkflowRunStatusUpdate(armedEnv(), { run });
    expect(outcome).toMatchObject({ outcome: "enqueued", recipientIds: [200] });
    expect((await outboxRows())[0]!.toAddr).toBe("at@example.com");
  });

  it("jobs not all done → NO mail at all (mail_workflow_run.go:67-71)", async () => {
    await seedRepo();
    const { run } = await seedRun({
      status: ACTION_STATUS_FAILURE,
      jobStatuses: [ACTION_STATUS_FAILURE, ACTION_STATUS_RUNNING],
    });
    expect((await notifyWorkflowRunStatusUpdate(armedEnv(), { run })).outcome).toBe("no-recipients");
    expect(await outboxRows()).toHaveLength(0);
  });

  it("the failure-only default with a non-failure recipient pref… a success under 'all' pins the Success subject, Message-ID, the both-sides recipient headers and the metadata block (mail_workflow_run.go:125-152)", async () => {
    await seedRepo();
    await db().insert(userSettings).values({ userId: 210, actionsEmailNotificationsPreference: "all" });
    const { run } = await seedRun({ status: ACTION_STATUS_SUCCESS, jobStatuses: [ACTION_STATUS_SUCCESS] });
    const outcome = await notifyWorkflowRunStatusUpdate(armedEnv(), { run });
    expect(outcome).toMatchObject({ outcome: "enqueued", recipientIds: [210] });
    const row = (await outboxRows())[0]!;
    expect(row.subject).toBe(`[repoowner/repo] Success: ci.yml (main - 1234567890)`);
    expect(row.info).toBe(row.subject);
    expect(row.fromDisplayName).toBe("runtrigger"); // from = the RECIPIENT's display name
    const headers = JSON.parse(row.headers ?? "{}") as Record<string, string>;
    expect(headers["Message-ID"]).toBe("<repoowner/repo/actions/runs/1@mail.example>"); // over the run INDEX
    expect(headers["X-Gitea-Sender"]).toBe("runtrigger"); // generateSenderRecipientHeaders(recipient, recipient)
    expect(headers["X-Gitea-Recipient"]).toBe("runtrigger");
    expect(headers["X-GitHub-Recipient-Address"]).toBe("rt@example.com");
    expect(headers["List-ID"]).toBe(`repoowner/repo <repo.repoowner.mail.example>`);
    expect(headers["X-Mailer"]).toBe("Gitea");
    expect(row.dedupeKey).toBe(`workflow-run-status:${run.id}:0:210`);
    expect(row.bodyHtml).toContain("https://mail.example/repoowner/repo/actions/runs/1");
  });

  it("failures sort first in the job table (mail_workflow_run.go:77-82) and the cancelled subject spells Canceled (one L)", async () => {
    await seedRepo();
    await db().insert(userSettings).values({ userId: 210, actionsEmailNotificationsPreference: "all" });
    const mixed = await seedRun({ status: ACTION_STATUS_FAILURE, jobStatuses: [ACTION_STATUS_SUCCESS, ACTION_STATUS_FAILURE], index: 5 });
    const cancelled = await seedRun({ status: ACTION_STATUS_CANCELLED, jobStatuses: [ACTION_STATUS_CANCELLED], index: 6, ref: "refs/tags/v9" });
    await notifyWorkflowRunStatusUpdate(armedEnv(), { run: mixed.run });
    await notifyWorkflowRunStatusUpdate(armedEnv(), { run: cancelled.run });
    const rows = await outboxRows();
    expect(rows).toHaveLength(2);
    const mixedRow = rows.find((r) => r.subject.includes("Failure"))!;
    // Failures sort first: the failing job's row renders ABOVE the
    // succeeding one (the seed order was build=SUCCESS, deploy=FAILURE).
    expect(mixedRow.bodyHtml.indexOf("deploy")).toBeLessThan(mixedRow.bodyHtml.indexOf("build"));
    const cancelledRow = rows.find((r) => r.subject.includes("Canceled"))!;
    expect(cancelledRow.subject).toBe(`[repoowner/repo] Canceled: ci.yml (v9 - 1234567890)`); // PrettyRef: refs/tags → short name
  });

  it("a prohibited recipient and the gate-offs degrade like the sibling arms", async () => {
    await seedRepo();
    const { run } = await seedRun({ status: ACTION_STATUS_FAILURE, jobStatuses: [ACTION_STATUS_FAILURE], triggerUserId: 96 });
    expect((await notifyWorkflowRunStatusUpdate(armedEnv(), { run })).outcome).toBe("no-recipients"); // not mailable
    const second = await seedRun({ status: ACTION_STATUS_FAILURE, jobStatuses: [ACTION_STATUS_FAILURE], index: 2 });
    expect((await notifyWorkflowRunStatusUpdate(armedEnv({ ENABLE_NOTIFY_MAIL: undefined }), { run: second.run })).outcome).toBe("disabled");
    expect(await outboxRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The repo.ts transfer-route emit pin (the wiring under test)
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/transfer — the notifyRepoPendingTransfer emit (repo.ts wiring)", () => {
  let ownerToken = "";

  /** The owner's token identity — login MUST match the repo's
   *  ownerNamespace (isRepositoryOwner reads requester.login). */
  function ownerIdentity(): User {
    return {
      id: 1,
      login: "repoowner",
      email: "",
      full_name: "",
      avatar_url: "",
      html_url: "",
      language: "en-US",
      location: "",
      website: "",
      description: "",
      active: true,
      is_admin: false,
      prohibit_login: false,
      restricted: false,
      login_name: "",
      source_id: 0,
      followers_count: 0,
      following_count: 0,
      starred_repos_count: 0,
      created: SEED_TIME.toISOString(),
      last_login: "0001-01-01T00:00:00Z",
      type: "User",
      visibility: "public",
    };
  }

  function routeApp(): (path: string, init?: RequestInit, reqEnv?: Record<string, unknown>) => Promise<Response> {
    const resolver: AuthResolver = {
      resolveToken: (token) => (token === ownerToken ? Promise.resolve(ownerIdentity()) : Promise.resolve(null)),
    };
    const app = new OpenAPIHono<ApiEnv>();
    app.onError(giteaErrorHandler);
    registerRepoRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
    return async (path, init, reqEnv) =>
      Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), Object.assign({}, env, reqEnv)));
  }

  beforeEach(async () => {
    const minted = await mintFor(1, "transfer-owner-token");
    ownerToken = minted.plaintext;
  });

  it("an armed route files the pending row AND lands the transfer mail to the target user; the shipped mail-off posture lands ZERO rows", async () => {
    await seedRepo();
    const send = routeApp();
    const form = JSON.stringify({ new_owner: "other" });
    const armed = await send(
      "/repos/repoowner/repo/transfer",
      { method: "POST", body: form, headers: { Authorization: `token ${ownerToken}`, "Content-Type": "application/json" } },
      {
        MAIL_ENABLED: "true",
        ENABLE_NOTIFY_MAIL: "true",
        MAIL_FROM: "Gitea <noreply@example.com>",
        APP_URL: "https://mail.example",
        REPO_TASKS: spyQueue(),
      },
    );
    expect(armed.status).toBe(201); // the pending arm — the mail must never fail it
    const pending = await db().select().from(repoTransfer).all();
    expect(pending).toHaveLength(1);
    const rows = await outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toAddr).toBe("other@example.com");
    // The route fetches the DOER ROW for the receiver (users.id 1 = the
    // repoowner fixture), so the subject carries that display name — not
    // the token identity's login.
    expect(rows[0]!.subject).toBe(`repoowner would like to transfer "repoowner/repo" to you`);
    expect(rows[0]!.dedupeKey).toBe(`repo-transfer-notify:${pending[0]!.id}:300`);

    // The shipped posture: the same POST with the env untouched — the 201
    // stands, zero rows (the emit's fail-closed tripwire).
    const plain = await send("/repos/repoowner/repo/transfer", {
      method: "POST",
      body: JSON.stringify({ new_owner: "transferee" }),
      headers: { Authorization: `token ${ownerToken}`, "Content-Type": "application/json" },
    });
    expect(plain.status).toBe(409); // the pending-duplicate of the FIRST request — repo busy
    await db().delete(repoTransfer);
    const plain2 = await send("/repos/repoowner/repo/transfer", {
      method: "POST",
      body: JSON.stringify({ new_owner: "transferee" }),
      headers: { Authorization: `token ${ownerToken}`, "Content-Type": "application/json" },
    });
    expect(plain2.status).toBe(201);
    expect(await outboxRows()).toHaveLength(1); // still only the armed arm's row
  });
});
