/**
 * Tier-1 repo-label routes on real D1 (SPEC-0004 §2.4 rows: issueListLabels /
 * issueCreateLabel / issueGetLabel / issueEditLabel / issueDeleteLabel).
 * Pins the upstream gotchas: the #RRGGBB color 422 with the exact
 * NormalizeColor message, the hash-less wire color, id-or-name GET lookup,
 * repo-scoped ids, SetArchived semantics, and the 204-on-missing DELETE.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { issueLabels, labels, repositories, users } from "../db/schema";
import { createApiRouter } from "./router";
import { contractModelProperties } from "../compat/contract/frozen-contract";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["issue_labels", "labels", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

const LABEL_FIELDS = Object.keys(contractModelProperties("Label")).sort();

const TOKEN = "stub-token";
const authHeaders = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const ERROR_URL = "https://example.com/api/swagger";

let repoSeq = 400;

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

interface SeedLabelInput {
  name: string;
  color?: string;
  exclusive?: boolean;
  description?: string;
  numIssues?: number;
  numClosedIssues?: number;
}

async function seedLabel(repoId: string, input: SeedLabelInput): Promise<number> {
  const rows = await db()
    .insert(labels)
    .values({
      repoId,
      name: input.name,
      color: input.color ?? "#00aabb",
      exclusive: input.exclusive ?? false,
      description: input.description ?? "",
      numIssues: input.numIssues ?? 0,
      numClosedIssues: input.numClosedIssues ?? 0,
    })
    .returning({ id: labels.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("label seed failed");
  return row.id;
}

const router = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);
};

describe("POST /repos/{owner}/{repo}/labels (issueCreateLabel)", () => {
  it("creates a label with 201 and the exact contract Label field set", async () => {
    const owner = await seedUser("Alice");
    await seedRepo(owner.usernameLower, "visible");

    const res = await router()("/repos/Alice/visible/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "bug", color: "#00AABB", exclusive: true, description: "something broken", is_archived: true }),
    });

    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(LABEL_FIELDS);
    expect(body).toMatchObject({
      name: "bug",
      // wire color carries no '#' (convert.ToLabel TrimLeft)
      color: "00aabb",
      exclusive: true,
      description: "something broken",
      is_archived: true,
      url: `https://example.com/api/v1/repos/alice/visible/labels/${String(body.id)}`,
    });
    // stored in canonical #rrggbb form
    const stored = (await db().select().from(labels).all())[0];
    expect(stored?.color).toBe("#00aabb");
    expect(stored?.archivedAt).not.toBeNull();
  });

  it.each([
    // NormalizeColor: trim + lowercase + implicit '#', 3-char shorthand expands.
    ["ff0000", "ff0000"],
    ["  #FF0000  ", "ff0000"],
    ["f0a", "ff00aa"],
  ])("normalizes color %j to %j", async (raw, wire) => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const res = await router()("/repos/alice/visible/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "bug", color: raw }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ color: wire });
  });

  it("422s invalid colors with the exact upstream NormalizeColor message", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    // The message prints the NORMALIZED (trimmed, lowercased, hash-added)
    // input — 3/6-char inputs get the implicit '#' before validation.
    for (const [raw, message] of [
      ["red", "invalid color: #red"],
      ["#GGGGGG", "invalid color: #gggggg"],
      ["12345", "invalid color: 12345"],
      ["#12345", "invalid color: ##12345"],
    ] as const) {
      const res = await router()("/repos/alice/visible/labels", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ name: "bug", color: raw }),
      });
      expect(res.status, raw).toBe(422);
      expect(await res.json(), raw).toEqual({ message, url: ERROR_URL });
    }
  });

  it("422s the required name/color fields on bind failure", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const noName = await router()("/repos/alice/visible/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ color: "#00aabb" }),
    });
    expect(noName.status).toBe(422);
    expect((await noName.json<{ message: string }>()).message).toBe("invalid request body");

    const noColor = await router()("/repos/alice/visible/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "bug" }),
    });
    expect(noColor.status).toBe(422);
  });

  it("requires a token and a visible repository", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const anon = await router()("/repos/alice/visible/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bug", color: "#00aabb" }),
    });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ message: "token is required", url: ERROR_URL });

    const missing = await router()("/repos/alice/ghost/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ name: "bug", color: "#00aabb" }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});

describe("GET /repos/{owner}/{repo}/labels (issueListLabels)", () => {
  it("lists repo labels alphabetically with pagination headers", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedLabel(repoId, { name: "bug" });
    await seedLabel(repoId, { name: "enhancement" });
    await seedLabel(repoId, { name: "aaa" });
    // another repo's label stays repo-scoped
    const otherRepo = await seedRepo("alice", "other");
    await seedLabel(otherRepo, { name: "foreign" });

    const res = await router()("/repos/alice/visible/labels");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("3");
    const body = await res.json<Array<Record<string, unknown>>>();
    expect(body.map((l) => l.name)).toEqual(["aaa", "bug", "enhancement"]);
    expect(Object.keys(body[0]!).sort()).toEqual(LABEL_FIELDS);
    expect(body[0]).toMatchObject({ url: `https://example.com/api/v1/repos/alice/visible/labels/${String(body[0]?.id)}` });
  });

  it.each([
    ["mostissues", ["c", "b", "a"]], // num_issues - num_closed_issues DESC
    ["leastissues", ["a", "b", "c"]], // ASC
    ["reversealphabetically", ["c", "b", "a"]], // name DESC, id ASC
    ["unknown", ["a", "b", "c"]], // default: name ASC
  ])("honors the undeclared sort=%s param like upstream", async (sort, expected) => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedLabel(repoId, { name: "a", numIssues: 1, numClosedIssues: 1 }); // open 0
    await seedLabel(repoId, { name: "b", numIssues: 3, numClosedIssues: 1 }); // open 2
    await seedLabel(repoId, { name: "c", numIssues: 5, numClosedIssues: 1 }); // open 4

    const res = await router()(`/repos/alice/visible/labels?sort=${sort}`);
    expect((await res.json<Array<{ name: string }>>()).map((l) => l.name)).toEqual(expected);
  });

  it("paginates with the runtime headers", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedLabel(repoId, { name: "a" });
    await seedLabel(repoId, { name: "b" });
    await seedLabel(repoId, { name: "c" });

    const res = await router()("/repos/alice/visible/labels?limit=2&page=2");
    expect(res.headers.get("X-Total-Count")).toBe("3");
    expect(res.headers.get("Link")).toContain('rel="prev"');
    expect((await res.json<Array<{ name: string }>>()).map((l) => l.name)).toEqual(["c"]);
  });

  it("404s a missing repository", async () => {
    const res = await router()("/repos/alice/ghost/labels");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("keeps the list repo-only on an org-owned repo — org labels never union in (upstream asymmetry)", async () => {
    // Upstream ListLabels reads GetLabelsByRepoID (`Where("repo_id = ?")`,
    // routers/api/v1/repo/label.go:52 over models/issues/label.go:420-450):
    // even on an org-owned repo — whose issues DO carry the org's labels
    // through the attach arms (routers/api/v1/repo/issue_label.go:342-363) —
    // the admin list stays repo-scoped. GET /labels/{id} is repo-scoped too
    // (GetLabelInRepoByID, repo/label.go:102-107). Pinned so a future wave
    // doesn't "fix" the list into divergence.
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await env.DB.prepare("UPDATE users SET type = 'org' WHERE id = ?").bind(owner.id).run();
    await seedLabel(repoId, { name: "repo-only" });
    const orgLabel = await db()
      .insert(labels)
      .values({ repoId: null, orgId: owner.id, name: "org-wide", color: "#778899", description: "" })
      .returning({ id: labels.id })
      .all()
      .then((rows) => rows[0]!.id);

    const res = await router()("/repos/alice/visible/labels");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    const body = await res.json<Array<{ id: number; name: string }>>();
    expect(body.map((l) => l.name)).toEqual(["repo-only"]);
    expect(body.map((l) => l.id)).not.toContain(orgLabel);

    const miss = await router()(`/repos/alice/visible/labels/${String(orgLabel)}`);
    expect(miss.status).toBe(404);
  });
});

describe("GET /repos/{owner}/{repo}/labels/{id} (issueGetLabel)", () => {
  it("resolves by numeric id and by case-sensitive name", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, { name: "bug", color: "#ff0000" });

    const byId = await router()(`/repos/alice/visible/labels/${labelId}`);
    expect(byId.status).toBe(200);
    expect(await byId.json()).toMatchObject({ id: labelId, name: "bug", color: "ff0000" });

    const byName = await router()("/repos/alice/visible/labels/bug");
    expect(byName.status).toBe(200);
    expect(await byName.json()).toMatchObject({ id: labelId, name: "bug" });

    const wrongCase = await router()("/repos/alice/visible/labels/Bug");
    expect(wrongCase.status).toBe(404);
  });

  it("404s with the upstream ErrRepoLabelNotExist message (ids in the body)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedLabel(repoId, { name: "bug" });

    const missing = await router()("/repos/alice/visible/labels/99");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      message: `label does not exist [label_id: 99, repo_id: ${repoId}]`,
      url: ERROR_URL,
    });

    // non-numeric ids take the name branch — the reported label_id is 0.
    const nameMiss = await router()("/repos/alice/visible/labels/nosuch");
    expect(nameMiss.status).toBe(404);
    expect(await nameMiss.json()).toEqual({
      message: `label does not exist [label_id: 0, repo_id: ${repoId}]`,
      url: ERROR_URL,
    });
  });

  it("keeps ids repo-scoped (another repo's id is not found)", async () => {
    await seedUser("Alice");
    const repoId = await seedRepo("alice", "visible");
    const otherRepo = await seedRepo("alice", "other");
    const foreignId = await seedLabel(otherRepo, { name: "foreign" });

    const res = await router()(`/repos/alice/visible/labels/${foreignId}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      message: `label does not exist [label_id: ${foreignId}, repo_id: ${repoId}]`,
      url: ERROR_URL,
    });
  });
});

describe("PATCH /repos/{owner}/{repo}/labels/{id} (issueEditLabel)", () => {
  it("patches only the provided fields", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, { name: "bug", color: "#ff0000", description: "old" });

    const res = await router()(`/repos/alice/visible/labels/${labelId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ name: "defect", color: "#00ff00" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: labelId, name: "defect", color: "00ff00", description: "old" });
  });

  it("normalizes the edited color and 422s invalid ones with the upstream message", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, { name: "bug" });

    const good = await router()(`/repos/alice/visible/labels/${labelId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ color: "abc" }),
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ color: "aabbcc" });

    const bad = await router()(`/repos/alice/visible/labels/${labelId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ color: "nope" }),
    });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ message: "invalid color: nope", url: ERROR_URL });
  });

  it("applies SetArchived semantics (stamp on new archive, clear on unarchive)", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, { name: "bug" });

    const archived = await router()(`/repos/alice/visible/labels/${labelId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ is_archived: true }),
    });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ is_archived: true });
    const archivedAt = (await db().select().from(labels).where(eq(labels.id, labelId)).all())[0]?.archivedAt;
    expect(archivedAt).not.toBeNull();

    // A repeated archive keeps the original date; unarchive clears it.
    const still = await router()(`/repos/alice/visible/labels/${labelId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ is_archived: true }),
    });
    expect(still.status).toBe(200);
    expect((await db().select().from(labels).where(eq(labels.id, labelId)).all())[0]?.archivedAt).toEqual(archivedAt);

    const unarchived = await router()(`/repos/alice/visible/labels/${labelId}`, {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ is_archived: false }),
    });
    expect(unarchived.status).toBe(200);
    expect(await unarchived.json()).toMatchObject({ is_archived: false });
  });

  it("404s missing ids with the label message and has NO name fallback", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    await seedLabel(repoId, { name: "bug" });

    const missing = await router()("/repos/alice/visible/labels/99", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ name: "new" }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      message: `label does not exist [label_id: 99, repo_id: ${repoId}]`,
      url: ERROR_URL,
    });

    // PATCH parses the id strictly (ctx.PathParamInt64): a NAME does not match.
    const byName = await router()("/repos/alice/visible/labels/bug", {
      method: "PATCH",
      headers: authHeaders,
      body: JSON.stringify({ name: "new" }),
    });
    expect(byName.status).toBe(404);
    expect(await byName.json()).toEqual({
      message: `label does not exist [label_id: 0, repo_id: ${repoId}]`,
      url: ERROR_URL,
    });
    const unchanged = await db().select().from(labels).all();
    expect(unchanged[0]?.name).toBe("bug");
  });

  it("requires a token", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, { name: "bug" });

    const anon = await router()(`/repos/alice/visible/labels/${labelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new" }),
    });
    expect(anon.status).toBe(401);
    expect(await anon.json()).toEqual({ message: "token is required", url: ERROR_URL });
  });
});

describe("DELETE /repos/{owner}/{repo}/labels/{id} (issueDeleteLabel)", () => {
  it("deletes the label, its issue links, and answers 204", async () => {
    const owner = await seedUser("Alice");
    const repoId = await seedRepo(owner.usernameLower, "visible");
    const labelId = await seedLabel(repoId, { name: "bug" });
    await db().insert(issueLabels).values({ issueId: 77, labelId });

    const res = await router()(`/repos/alice/visible/labels/${labelId}`, { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await db().select().from(labels).all()).toHaveLength(0);
    expect(await db().select().from(issueLabels).all()).toHaveLength(0);

    const gone = await router()(`/repos/alice/visible/labels/${labelId}`);
    expect(gone.status).toBe(404);
  });

  it("answers 204 for a missing label too (upstream deleteLabel ignores zero rows)", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const res = await router()("/repos/alice/visible/labels/99", { method: "DELETE", headers: authHeaders });
    expect(res.status).toBe(204);
  });

  it("requires a token and a visible repository", async () => {
    await seedUser("Alice");
    await seedRepo("alice", "visible");

    const anon = await router()("/repos/alice/visible/labels/1", { method: "DELETE" });
    expect(anon.status).toBe(401);

    const missing = await router()("/repos/alice/ghost/labels/1", { method: "DELETE", headers: authHeaders });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});
