/**
 * The Actions workflow toggle + dispatch audit emit arms' tests
 * (services/actions/audit-arms.ts — the Wave I-a deferred family): the
 * registry trio's verbatim templates, both emit shapes' full row (the
 * RecordWorkflowToggle / DispatchActionWorkflow ports), the origin and
 * credential variants (the web vs API arms), the impersonation pass-through,
 * and the swallow-on-failure posture (upstream writeEvent's log-not-fail,
 * event.go:136-140).
 *
 * Real local D1 (workerd, @cloudflare/vitest-plugin), the
 * applyAuthD1Migrations idiom; only `audit_event` is touched.
 */

import { env } from "cloudflare:test";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { users } from "../../db/schema";
import { actionFilters, findAuditEvents, messageTemplate, renderMessage, AuditActions } from "../audit";
import { emitWorkflowDispatchAudit, emitWorkflowToggleAudit } from "./audit-arms";

const REPO = { id: "repo-uuid-1", ownerNamespace: "alice", slug: "alpha" };
const ACTOR = { id: 7, username: "alice" };

function db(): DrizzleD1Database {
  return drizzle(env.DB);
}

beforeEach(async () => {
  await applyAuthD1Migrations();
  await env.DB.prepare("DELETE FROM audit_event").run();
});

describe("the actions:workflow registry trio (action.go:196-198)", () => {
  it("registers the verbatim ids and templates", () => {
    expect(messageTemplate("actions:workflow:enable")).toBe("Enabled Actions workflow {workflow} in repository {scope}.");
    expect(messageTemplate("actions:workflow:disable")).toBe("Disabled Actions workflow {workflow} in repository {scope}.");
    expect(messageTemplate("actions:workflow:dispatch")).toBe("Dispatched Actions workflow {workflow} on {ref} in repository {scope}.");
    expect(AuditActions.ActionsWorkflowEnable).toBe("actions:workflow:enable");
    expect(AuditActions.ActionsWorkflowDisable).toBe("actions:workflow:disable");
    expect(AuditActions.ActionsWorkflowDispatch).toBe("actions:workflow:dispatch");
  });

  it("renders {workflow}, {ref} and {scope}; the family prefix filter derives", () => {
    expect(renderMessage(AuditActions.ActionsWorkflowEnable, { workflow: "build.yml", scope: "alice/alpha" })).toBe(
      "Enabled Actions workflow build.yml in repository alice/alpha.",
    );
    expect(renderMessage(AuditActions.ActionsWorkflowDispatch, { workflow: "build.yml", ref: "main", scope: "alice/alpha" })).toBe(
      "Dispatched Actions workflow build.yml on main in repository alice/alpha.",
    );
    // the 3-segment ids derive their 2-segment family prefix (actionFilters'
    // i=2 loop — the same derivation audit.test.ts pins for repository:wiki)
    expect(actionFilters()).toContain("actions:workflow");
  });
});

describe("emitWorkflowToggleAudit (RecordWorkflowToggle, workflow.go:53-60)", () => {
  it("the enable arm records the full row: action, rendered message, repo scope, metadata", async () => {
    await emitWorkflowToggleAudit(env.DB, {
      repo: REPO,
      workflowId: "build.yml",
      isEnable: true,
      actor: ACTOR,
      ipAddress: "203.0.113.9",
    });
    const rows = await findAuditEvents(db(), { scopeType: "repository", scopeId: REPO.id });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("actions:workflow:enable");
    expect(row.actorId).toBe(7);
    expect(row.actorName).toBe("alice");
    expect(row.actorCredential).toBeNull(); // the web toggle rides a session
    expect(row.scopeName).toBe("alice/alpha");
    expect(row.origin).toBe("ui"); // the default (the web arm)
    expect(row.message).toBe("Enabled Actions workflow build.yml in repository alice/alpha.");
    expect(JSON.parse(row.metadata ?? "")).toEqual({ workflow: "build.yml" });
    expect(row.ipAddress).toBe("203.0.113.9");
  });

  it("the disable arm flips the action id and message by polarity", async () => {
    await emitWorkflowToggleAudit(env.DB, { repo: REPO, workflowId: "deploy.yml", isEnable: false, actor: ACTOR });
    const rows = await findAuditEvents(db(), { scopeType: "repository", scopeId: REPO.id });
    expect(rows[0]!.action).toBe("actions:workflow:disable");
    expect(rows[0]!.message).toBe("Disabled Actions workflow deploy.yml in repository alice/alpha.");
  });

  it("the API twin's variant: origin api + the access-token credential", async () => {
    await emitWorkflowToggleAudit(env.DB, {
      repo: REPO,
      workflowId: "build.yml",
      isEnable: true,
      actor: ACTOR,
      origin: "api",
      actorCredential: "access-token:3",
    });
    const row = (await findAuditEvents(db(), { scopeType: "repository", scopeId: REPO.id }))[0]!;
    expect(row.origin).toBe("api");
    expect(row.actorCredential).toBe("access-token:3");
  });

  it("threads the impersonator pair when the session is impersonated", async () => {
    await emitWorkflowToggleAudit(env.DB, {
      repo: REPO,
      workflowId: "build.yml",
      isEnable: true,
      actor: ACTOR,
      impersonator: { id: 1, username: "root" },
    });
    const row = (await findAuditEvents(db(), { scopeType: "repository", scopeId: REPO.id }))[0]!;
    expect(row.impersonatorId).toBe(1);
    expect(row.impersonatorName).toBe("root");
  });
});

describe("emitWorkflowDispatchAudit (DispatchActionWorkflow's tail, workflow.go:192-193)", () => {
  it("records the dispatch row: the RAW ref, the numeric run_id in the metadata", async () => {
    await emitWorkflowDispatchAudit(env.DB, {
      repo: REPO,
      workflowId: "build.yml",
      ref: "feature/x", // the RAW form value — NOT the normalized refs/heads/… the run row stores
      runId: 42,
      actor: ACTOR,
    });
    const rows = await findAuditEvents(db(), { scopeType: "repository", scopeId: REPO.id });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("actions:workflow:dispatch");
    expect(row.message).toBe("Dispatched Actions workflow build.yml on feature/x in repository alice/alpha.");
    const metadata = JSON.parse(row.metadata ?? "") as { ref: string; run_id: number; workflow: string };
    expect(metadata).toEqual({ ref: "feature/x", run_id: 42, workflow: "build.yml" });
    expect(metadata.run_id).toBe(42); // numeric, like upstream's int64 pair
  });

  it("accepts a string run id (the schema's id drift posture)", async () => {
    await emitWorkflowDispatchAudit(env.DB, {
      repo: REPO,
      workflowId: "build.yml",
      ref: "main",
      runId: "7",
      actor: ACTOR,
      origin: "api",
    });
    const row = (await findAuditEvents(db(), { scopeType: "repository", scopeId: REPO.id }))[0]!;
    expect(JSON.parse(row.metadata ?? "")).toEqual({ ref: "main", run_id: "7", workflow: "build.yml" });
    expect(row.origin).toBe("api");
  });
});

describe("the impersonation derivation (the Wave K9 threading — impersonatorRef over the id-only session column)", () => {
  const T0 = new Date("2026-01-01T00:00:00Z");

  beforeEach(async () => {
    // The admin behind the impersonated session. The session row carries
    // only its id (migration 0058's impersonator_user_id — the viewer's
    // impersonatorUserId), so the helper's ONE users read has a row to
    // resolve (upstream AuthShared's GetUserByID, routers/common/auth.go:
    // 37-45). Delete-first: the local D1 outlives a single test here, the
    // seed must stay idempotent.
    await env.DB.prepare("DELETE FROM users WHERE id = 1").run();
    await db().insert(users).values({ id: 1, username: "root", usernameLower: "root", status: "active", createdAt: T0 });
  });

  it("the toggle arm derives the admin's name from the id-only form", async () => {
    await emitWorkflowToggleAudit(env.DB, {
      repo: REPO,
      workflowId: "build.yml",
      isEnable: true,
      actor: ACTOR,
      impersonatorUserId: 1,
    });
    const row = (await findAuditEvents(db(), { scopeType: "repository", scopeId: REPO.id }))[0]!;
    expect(row.impersonatorId).toBe(1);
    expect(row.impersonatorName).toBe("root");
    // the derivation leaves the rest of the row untouched
    expect(row.actorId).toBe(7);
    expect(row.actorName).toBe("alice");
    expect(row.message).toBe("Enabled Actions workflow build.yml in repository alice/alpha.");
  });

  it("the dispatch arm derives identically", async () => {
    await emitWorkflowDispatchAudit(env.DB, {
      repo: REPO,
      workflowId: "build.yml",
      ref: "main",
      runId: 42,
      actor: ACTOR,
      impersonatorUserId: 1,
    });
    const row = (await findAuditEvents(db(), { scopeType: "repository", scopeId: REPO.id }))[0]!;
    expect(row.impersonatorId).toBe(1);
    expect(row.impersonatorName).toBe("root");
    expect(row.message).toBe("Dispatched Actions workflow build.yml on main in repository alice/alpha.");
  });

  it("a vanished impersonator row degrades to id-only — the emit still lands", async () => {
    const errSpy = vi.spyOn(console, "error");
    await emitWorkflowDispatchAudit(env.DB, {
      repo: REPO,
      workflowId: "build.yml",
      ref: "main",
      runId: 42,
      actor: ACTOR,
      impersonatorUserId: 99999, // no users row — the admin's row is gone
    });
    const row = (await findAuditEvents(db(), { scopeType: "repository", scopeId: REPO.id }))[0]!;
    expect(row.impersonatorId).toBe(99999); // the id STAYS on the row
    expect(row.impersonatorName).toBeNull();
    expect(row.actorId).toBe(7); // the rest of the row is intact
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unable to resolve impersonator 99999"));
  });

  it("the same-id fold records NOT impersonated (refs.go:31-36)", async () => {
    await emitWorkflowToggleAudit(env.DB, {
      repo: REPO,
      workflowId: "build.yml",
      isEnable: true,
      actor: ACTOR,
      impersonatorUserId: 7, // === actor.id
    });
    const row = (await findAuditEvents(db(), { scopeType: "repository", scopeId: REPO.id }))[0]!;
    expect(row.impersonatorId).toBe(0);
    expect(row.impersonatorName).toBeNull();
  });

  it("the unimpersonated arm stays the zero row", async () => {
    await emitWorkflowToggleAudit(env.DB, { repo: REPO, workflowId: "build.yml", isEnable: true, actor: ACTOR });
    const row = (await findAuditEvents(db(), { scopeType: "repository", scopeId: REPO.id }))[0]!;
    expect(row.impersonatorId).toBe(0);
    expect(row.impersonatorName).toBeNull();
  });
});

describe("the swallow-on-failure posture (event.go:136-140)", () => {
  /** The tripwire D1: throws on first touch — the emit must resolve, not
   *  reject, and the error must surface in the log only. */
  function d1ThatThrows(): D1Database {
    return new Proxy(
      {},
      {
        get(_target, prop) {
          throw new Error(`D1 failure injected: .${String(prop)}`);
        },
      },
    ) as D1Database;
  }

  it("a failed toggle emit resolves, logging only", async () => {
    const errSpy = vi.spyOn(console, "error");
    await expect(
      emitWorkflowToggleAudit(d1ThatThrows(), { repo: REPO, workflowId: "build.yml", isEnable: true, actor: ACTOR }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("workflow toggle audit event"), expect.any(Error));
  });

  it("a failed dispatch emit resolves, logging only", async () => {
    const errSpy = vi.spyOn(console, "error");
    await expect(
      emitWorkflowDispatchAudit(d1ThatThrows(), { repo: REPO, workflowId: "build.yml", ref: "main", runId: 1, actor: ACTOR }),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("workflow dispatch audit event"), expect.any(Error));
  });
});
