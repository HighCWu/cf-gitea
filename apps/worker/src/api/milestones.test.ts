/**
 * Tier-1 repo-milestone routes on real D1 (SPEC-0004 §2.4 rows:
 * issueGetMilestonesList / issueCreateMilestone / issueGetMilestone /
 * issueEditMilestone / issueDeleteMilestone), wrapping the landed IssuesService
 * for mutations. Pins the upstream gotchas: the open state default, the
 * end-of-day deadline normalization, the id-or-name (ParseInt base 0)
 * resolution, the pointer-rule PATCH fields, and milestone 404s as the plain
 * `not found` body.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { issues, milestones, repoCounters, repositories, users } from "../db/schema";
import { createApiRouter } from "./router";
import { contractModelProperties } from "../compat/contract/frozen-contract";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["issues", "milestones", "repo_counters", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

const MILESTONE_FIELDS = Object.keys(contractModelProperties("Milestone")).sort();

const TOKEN = "stub-token";
const authHeaders = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const ERROR_URL = "https://example.com/api/swagger";

let repoSeq = 500;

async function seedUser(username: string): Promise<{ id: number; usernameLower: string }> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, usernameLower: user.usernameLower };
}

async function seedRepo(ownerNamespace: string, slug: string): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    slug,
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  return id;
}

interface SeedMilestoneInput {
  name: string;
  isClosed?: boolean;
  deadline?: string | null;
  numIssues?: number;
  numClosedIssues?: number;
}

async function seedMilestone(repoId: string, input: SeedMilestoneInput): Promise<number> {
  const rows = await db()
    .insert(milestones)
    .values({
      repoId,
      name: input.name,
      content: "",
      isClosed: input.isClosed ?? false,
      closedDateAt: input.isClosed ? new Date("2026-03-01T00:00:00Z") : null,
      numIssues: input.numIssues ?? 0,
      numClosedIssues: input.numClosedIssues ?? 0,
      deadlineAt: input.deadline === undefined ? null : input.deadline === null ? null : new Date(input.deadline),
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: milestones.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("milestone seed failed");
  return row.id;
}

const router = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
};

describe("POST /repos/{owner}/{repo}/milestones (issueCreateMilestone)", () => {
  it("creates an open milestone with 201 and the exact contract Milestone field set", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "visible");

    const res = await router()("/repos/Alice/visible/milestones", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "v1.0", description: "first release" }),
    });

    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(MILESTONE_FIELDS);
    expect(typeof body.id).toBe("number");
    expect(body).toMatchObject({
      title: "v1.0",
      description: "first release",
      state: "open", // the state default
      open_issues: 0,
      closed_issues: 0,
      closed_at: null,
      due_on: null,
    });
    expect(body.created_at).toBeTypeOf("string");
    expect(body.updated_at).toBeTypeOf("string");
  });

  it("normalizes due_on to the END OF THAT DAY (upstream ApplyAPIDeadlineTimestamp)", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const dateOnly = await router()("/repos/alice/visible/milestones", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "m1", due_on: "2026-01-15" }),
    });
    expect(dateOnly.status).toBe(201);
    expect(await dateOnly.json()).toMatchObject({ due_on: "2026-01-15T23:59:59.000Z" });

    // RFC3339 input lands on the same wall-clock day's 23:59:59.
    const rfc3339 = await router()("/repos/alice/visible/milestones", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "m2", due_on: "2026-02-20T10:30:00Z" }),
    });
    expect(rfc3339.status).toBe(201);
    expect(await rfc3339.json()).toMatchObject({ due_on: "2026-02-20T23:59:59.000Z" });

    // "2006-01-02 15:04:05" is the second accepted format.
    const spaced = await router()("/repos/alice/visible/milestones", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "m3", due_on: "2026-03-08 08:00:00" }),
    });
    expect(spaced.status).toBe(201);
    expect(await spaced.json()).toMatchObject({ due_on: "2026-03-08T23:59:59.000Z" });
  });

  it("accepts state=closed at creation and stamps closed_at", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const res = await router()("/repos/alice/visible/milestones", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "done", state: "closed" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ state: string; closed_at: string | null }>();
    expect(body.state).toBe("closed");
    expect(body.closed_at).toBeTypeOf("string");
  });

  it("400s an invalid due_on format with the upstream message (runtime-only status)", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const res = await router()("/repos/alice/visible/milestones", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "m", due_on: "tomorrow" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "invalid date format: tomorrow", url: ERROR_URL });
  });

  it("requires a token and a visible repository", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const anon = await router()("/repos/alice/visible/milestones", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "m" }),
    });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ message: "token is required", url: ERROR_URL });

    const missing = await router()("/repos/alice/ghost/milestones", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "m" }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("GET /repos/{owner}/{repo}/milestones (issueGetMilestonesList)", () => {
  it("defaults to the open state and supports closed/all (unknown values read open)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedMilestone(repoId, { name: "open-one" });
    await seedMilestone(repoId, { name: "shipped", isClosed: true });

    const def = await router()("/repos/alice/visible/milestones");
    expect(def.status).toBe(200);
    expect(def.headers.get("X-Total-Count")).toBe("1");
    expect((await def.json<Array<{ title: string }>>()).map((m) => m.title)).toEqual(["open-one"]);

    const closed = await router()("/repos/alice/visible/milestones?state=closed");
    expect((await closed.json<Array<{ title: string }>>()).map((m) => m.title)).toEqual(["shipped"]);

    const all = await router()("/repos/alice/visible/milestones?state=all");
    expect(all.headers.get("X-Total-Count")).toBe("2");

    // ParseIssueFilterStateIsClosed: unknown state → open.
    const unknown = await router()("/repos/alice/visible/milestones?state=bogus");
    expect(unknown.headers.get("X-Total-Count")).toBe("1");
  });

  it("orders by deadline ASC then name ASC and filters by name case-insensitively", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedMilestone(repoId, { name: "zeta", deadline: "2026-06-01T00:00:00Z" });
    await seedMilestone(repoId, { name: "alpha", deadline: "2026-06-01T00:00:00Z" });
    await seedMilestone(repoId, { name: "early", deadline: "2026-01-01T00:00:00Z" });
    await seedMilestone(repoId, { name: "no-deadline" });

    const res = await router()("/repos/alice/visible/milestones?state=all");
    expect(res.headers.get("X-Total-Count")).toBe("4");
    // no deadline sorts first (unix 0 / NULL < any timestamp), then deadline, then name.
    expect((await res.json<Array<{ title: string }>>()).map((m) => m.title)).toEqual([
      "no-deadline",
      "early",
      "alpha",
      "zeta",
    ]);

    const byName = await router()("/repos/alice/visible/milestones?name=ALPH");
    expect(byName.headers.get("X-Total-Count")).toBe("1");
    expect((await byName.json<Array<{ title: string }>>())[0]?.title).toBe("alpha");

    // The name arm must not cap (the 943e1e9 org-members class — D1's
    // 50-byte LIKE pattern limit): a 200-char needle answers the clean
    // empty list, not a D1_ERROR 500.
    const longName = await router()(`/repos/alice/visible/milestones?name=${"z".repeat(200)}`);
    expect(longName.status).toBe(200);
    expect(longName.headers.get("X-Total-Count")).toBe("0");
  });

  it("paginates with the runtime headers and the exact contract field set", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedMilestone(repoId, { name: "a" });
    await seedMilestone(repoId, { name: "b" });

    const res = await router()("/repos/alice/visible/milestones?limit=1&page=2&state=all");
    expect(res.headers.get("X-Total-Count")).toBe("2");
    expect(res.headers.get("Link")).toContain('rel="prev"');
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(Object.keys(body[0]!).sort()).toEqual(MILESTONE_FIELDS);
    expect(body[0]).toMatchObject({ state: "open", closed_at: null, due_on: null });
  });

  it("404s a missing repository", async () => {
    const res = await router()("/repos/alice/ghost/milestones");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("GET /repos/{owner}/{repo}/milestones/{id} (issueGetMilestone)", () => {
  it("resolves by id, by name, and by name after a missing numeric id", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const id = await seedMilestone(repoId, { name: "v1.0", numIssues: 4, numClosedIssues: 1 });

    const byId = await router()(`/repos/alice/visible/milestones/${id}`);
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject({ id, title: "v1.0", open_issues: 3, closed_issues: 1 });

    const byName = await router()("/repos/alice/visible/milestones/v1.0");
    expect(byName.status).toBe(200);
    expect(await byName.json()).toMatchObject({ id, title: "v1.0" });

    // getMilestoneByIDOrName falls through to the name lookup when a numeric
    // id does not exist — a milestone literally named "999999" is reachable
    // through its name.
    const namedNumber = await seedMilestone(repoId, { name: "999999" });
    const fallthrough = await router()("/repos/alice/visible/milestones/999999");
    expect(fallthrough.status).toBe(200);
    expect(await fallthrough.json()).toMatchObject({ id: namedNumber, title: "999999" });
  });

  it("parses the id with strconv base 0 (0x hex form resolves too)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const id = await seedMilestone(repoId, { name: "hex" });

    const res = await router()(`/repos/alice/visible/milestones/0x${id.toString(16)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, title: "hex" });
  });

  it("404s missing and repo-foreign milestones with the plain body", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");
    const otherRepo = await seedRepo("alice", "other");
    const foreignId = await seedMilestone(otherRepo, { name: "foreign" });

    const missing = await router()("/repos/alice/visible/milestones/999998");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });

    const foreign = await router()(`/repos/alice/visible/milestones/${foreignId}`);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("PATCH /repos/{owner}/{repo}/milestones/{id} (issueEditMilestone)", () => {
  it("patches title/description and transitions state both ways", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const id = await seedMilestone(repoId, { name: "v1", numIssues: 2, numClosedIssues: 1 });

    const close = await router()(`/repos/alice/visible/milestones/${id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ title: "v1.0", description: "final", state: "closed" }),
    });
    expect(close.status).toBe(200);
    const closed = await close.json<{ state: string; closed_at: string | null; title: string; description: string }>();
    expect(closed).toMatchObject({ state: "closed", title: "v1.0", description: "final" });
    expect(closed.closed_at).toBeTypeOf("string");

    const reopen = await router()(`/repos/alice/visible/milestones/${id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ state: "open" }),
    });
    expect(reopen.status).toBe(200);
    const reopened = await reopen.json<{ state: string; closed_at: string | null; open_issues: number; closed_issues: number }>();
    expect(reopened).toMatchObject({ state: "open", closed_at: null });
    // counters untouched
    expect(reopened).toMatchObject({ open_issues: 1, closed_issues: 1 });
  });

  it("ignores an empty title and keeps fields absent from the patch (pointer rule)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const id = await seedMilestone(repoId, { name: "v1", deadline: "2026-06-01T00:00:00Z" });

    const res = await router()(`/repos/alice/visible/milestones/${id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ title: "", description: "desc only" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ title: string; description: string; due_on: string | null }>();
    expect(body.title).toBe("v1"); // empty title ignored (len(form.Title) > 0)
    expect(body.description).toBe("desc only");
    expect(body.due_on).toBe("2026-06-01T00:00:00.000Z"); // due_on absent → unchanged
  });

  it("supports the due_on tri-state (absent keep, null clear, value set)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const id = await seedMilestone(repoId, { name: "v1", deadline: "2026-06-01T00:00:00Z" });

    const clear = await router()(`/repos/alice/visible/milestones/${id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ due_on: null }),
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toMatchObject({ due_on: null });

    const set = await router()(`/repos/alice/visible/milestones/${id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ due_on: "2026-12-24" }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ due_on: "2026-12-24T23:59:59.000Z" });
  });

  it("400s an invalid due_on and 404s missing milestones", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const id = await seedMilestone(repoId, { name: "v1" });

    const badDate = await router()(`/repos/alice/visible/milestones/${id}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ due_on: "not-a-date" }),
    });
    expect(badDate.status).toBe(400);
    expect(await badDate.json()).toEqual({ message: "invalid date format: not-a-date", url: ERROR_URL });

    const missing = await router()("/repos/alice/visible/milestones/999997", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ title: "x" }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("requires a token", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const id = await seedMilestone(repoId, { name: "v1" });

    const anon = await router()(`/repos/alice/visible/milestones/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ message: "token is required", url: ERROR_URL });
  });
});

describe("DELETE /repos/{owner}/{repo}/milestones/{id} (issueDeleteMilestone)", () => {
  it("deletes the milestone, unlinks its issues, and answers 204", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const id = await seedMilestone(repoId, { name: "v1" });
    await db().insert(repoCounters).values({ repoId, issueIndex: 1 });
    await db().insert(issues).values({ repoId, index: 1, title: "linked", milestoneId: id });

    const res = await router()(`/repos/alice/visible/milestones/${id}`, { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await db().select().from(milestones).all()).toHaveLength(0);
    const issue = (await db().select().from(issues).all())[0];
    expect(issue?.milestoneId).toBeNull(); // upstream unlinks the milestone's issues
  });

  it("404s a missing milestone (the id resolves BEFORE the delete, unlike labels)", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const res = await router()("/repos/alice/visible/milestones/999996", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});
