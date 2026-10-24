/**
 * Tier-2 issue write-family routes (routes/issue-write-t2.ts) on real D1:
 * the single-label detach (issueRemoveLabel) and the pin write trio
 * (pinIssue / unpinIssue / moveIssuePin) — the reads/writes around them live
 * in issues.test.ts / tier2-extras.test.ts.
 *
 * Standalone mount per family (the tier2-extras.test.ts convention): the
 * register function takes only requireAuth (every op here is a write), the
 * stub resolver maps the owner token to the seeded user id 1 and the
 * neighbor token to a non-writer row, so the writer gates are exercisable
 * without collaborator rows.
 *
 * Upstream behavior pins mirrored by these assertions are cited in the
 * route-module header (issue_label.go / issue_pin.go).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { comments, issueLabels, issuePins, issues, labels, repositories, users } from "../../db/schema";
import { createStubAuthResolver, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerIssueWriteT2Routes } from "./issue-write-t2";
import { IssuesService } from "../../issues/service";
import { createRepoLabel } from "../services/labels";
import { applyRepoExtrasDdl } from "../testing/repo-ddl";

const TOKEN = "stub-token"; // resolves to STUB_USER (id 1) — the repo owner
const TOKEN_NEIGHBOR = "neighbor-token"; // resolves to the non-writer neighbor
const NOW = new Date("2026-02-03T04:05:06Z");
const REPO_ID = "8200";

/** Neighbor's minimal User projection (the resolver seam). */
let neighborId = 0;

/** Issue handles (re-seeded per test). */
let issueA = { id: 0, index: 0 };
let issueB = { id: 0, index: 0 };

function resolver(): AuthResolver {
  return {
    resolveToken: (token) => {
      if (token === TOKEN) return createStubAuthResolver().resolveToken(token);
      if (token === TOKEN_NEIGHBOR) {
        return Promise.resolve({
          id: neighborId,
          login: "neighbor",
          email: "",
          full_name: "Neighbor",
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
          created: "2026-01-01T00:00:00Z",
          last_login: "0001-01-01T00:00:00Z",
          type: "User",
          visibility: "public",
        });
      }
      return Promise.resolve(null);
    },
  };
}

function familyApp(register: (app: OpenAPIHono<ApiEnv>) => void) {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  register(app);
  return async (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

const authed = (init?: RequestInit, token = TOKEN): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `token ${token}`);
  return { ...init, headers };
};

const send = familyApp((app) => registerIssueWriteT2Routes(app, createTokenAuthMiddleware(resolver())));

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyRepoExtrasDdl();
});

/** Fresh rows per test: owner + neighbor, one public repo, two issues. */
beforeEach(async () => {
  for (const table of [
    "webhook_deliveries",
    "webhooks",
    "reactions",
    "issue_subscriptions",
    "issue_pins",
    "comments",
    "issue_labels",
    "pull_requests",
    "issues",
    "labels",
    "milestones",
    "repo_topics",
    "repo_watchers",
    "repo_collaborators",
    "stars",
    "follows",
    "repo_counters",
    "commit_statuses",
    "repo_units",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }

  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  const neighbor = await drizzle(env.DB)
    .insert(users)
    .values({ username: "neighbor", usernameLower: "neighbor", status: "active", createdAt: NOW })
    .returning({ id: users.id })
    .all();
  neighborId = neighbor[0]!.id;

  await drizzle(env.DB).insert(repositories).values({
    id: REPO_ID,
    storageKey: `r_${REPO_ID}`,
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "writes",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: NOW,
  });

  const service = new IssuesService(env.DB);
  const a = await service.createIssue({ repoId: REPO_ID, title: "alpha", content: "first", posterId: 1 });
  const b = await service.createIssue({ repoId: REPO_ID, title: "beta", content: "second", posterId: 1 });
  issueA = { id: a.id, index: a.index };
  issueB = { id: b.id, index: b.index };
});

/** Attach a label to an issue and return the label row (a fresh repo-scoped
 *  label per call, the createRepoLabel service). */
async function seedAttachedLabel(issueId: number, name: string) {
  const label = await createRepoLabel(env.DB, REPO_ID, {
    name,
    exclusive: false,
    color: "#00aabb",
    description: "",
    isArchived: false,
    now: NOW,
  });
  await new IssuesService(env.DB).setLabel(issueId, label.id, { ownerOrgId: null });
  return label;
}

/** The issue_pins rows joined with their issue index, pin_order ASC (index
 *  ASC as the tiebreak so the issue/pull halves interleave deterministically). */
async function pinOrderPairs(): Promise<Array<{ index: number; pinOrder: number }>> {
  const rows = await drizzle(env.DB)
    .select({ index: issues.index, pinOrder: issuePins.pinOrder })
    .from(issuePins)
    .innerJoin(issues, eq(issues.id, issuePins.issueId))
    .orderBy(asc(issuePins.pinOrder), asc(issues.index))
    .all();
  return rows;
}

/** The system comments of one issue (type ordered). */
async function systemCommentTypes(issueId: number): Promise<number[]> {
  const rows = await drizzle(env.DB)
    .select({ type: comments.type })
    .from(comments)
    .where(eq(comments.issueId, issueId))
    .all();
  return rows.map((row) => row.type);
}

// ---------------------------------------------------------------------------
// issueRemoveLabel
// ---------------------------------------------------------------------------

describe("DELETE /repos/{owner}/{repo}/issues/{index}/labels/{id} (issueRemoveLabel)", () => {
  it("detaches the label (204), writes the label (7) removal comment and folds the counters", async () => {
    const label = await seedAttachedLabel(issueA.id, "bug");
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/labels/${label.id}`, authed({ method: "DELETE" }))).status).toBe(204);

    const links = await drizzle(env.DB).select().from(issueLabels).where(eq(issueLabels.issueId, issueA.id)).all();
    expect(links).toHaveLength(0);

    const labelRow = await drizzle(env.DB).select().from(labels).where(eq(labels.id, label.id)).limit(1).then((rows) => rows[0]);
    expect(labelRow?.numIssues).toBe(0); // was 1 after the attach

    const removalComments = await drizzle(env.DB)
      .select({ type: comments.type, content: comments.content, labelId: comments.labelId, posterId: comments.posterId })
      .from(comments)
      .where(and(eq(comments.issueId, issueA.id), eq(comments.type, 7)))
      .all();
    expect(removalComments).toEqual([
      { type: 7, content: "", labelId: label.id, posterId: 1 }, // content "" = the removed marker
    ]);
    const issueRow = await drizzle(env.DB).select().from(issues).where(eq(issues.id, issueA.id)).limit(1).then((rows) => rows[0]);
    expect(issueRow?.numComments).toBe(1); // the label comment folded in
  });

  it("is the silent 204 when the label exists but is not attached (no comment, no counter drift)", async () => {
    const label = await createRepoLabel(env.DB, REPO_ID, {
      name: "unattached",
      exclusive: false,
      color: "#112233",
      description: "",
      isArchived: false,
      now: NOW,
    });
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/labels/${label.id}`, authed({ method: "DELETE" }))).status).toBe(204);
    expect(await systemCommentTypes(issueA.id)).toEqual([]);
    const labelRow = await drizzle(env.DB).select().from(labels).where(eq(labels.id, label.id)).limit(1).then((rows) => rows[0]);
    expect(labelRow?.numIssues).toBe(0);
  });

  it("404s a label outside the repo (or org) with the upstream message; 404s a missing issue", async () => {
    // A foreign repo's label id is indistinguishable from a missing one.
    await drizzle(env.DB).insert(repositories).values({
      id: "8201",
      storageKey: "r_8201",
      ownerNamespace: "cf-gitea-stub",
      ownerId: 1,
      slug: "other",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: NOW,
    });
    const foreign = await createRepoLabel(env.DB, "8201", {
      name: "foreign",
      exclusive: false,
      color: "#445566",
      description: "",
      isArchived: false,
      now: NOW,
    });
    const miss = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/labels/${foreign.id}`, authed({ method: "DELETE" }));
    expect(miss.status).toBe(404);
    expect(((await miss.json<Record<string, unknown>>())).message).toBe(
      `label does not exist [label_id: ${foreign.id}, repo_id: ${REPO_ID}]`,
    );
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/labels/0`, authed({ method: "DELETE" }))).status).toBe(404);

    const badIndex = await send("/repos/cf-gitea-stub/writes/issues/999/labels/1", authed({ method: "DELETE" }));
    expect(badIndex.status).toBe(404);
    expect(((await badIndex.json<Record<string, unknown>>())).message).toContain("issue does not exist");
  });

  it("resolves owner-org labels through the org fallback (GetLabelInRepoOrOrgByID)", async () => {
    // The seeded owner row becomes an org (orgs ARE user rows upstream); the
    // namespace/ownership stays intact so the writer gate still passes.
    await env.DB.prepare("UPDATE users SET type = 'org' WHERE id = 1").run();
    const orgLabel = await drizzle(env.DB)
      .insert(labels)
      .values({ repoId: null, orgId: 1, name: "org-wide", exclusive: false, color: "#778899", description: "" })
      .returning()
      .then((rows) => rows[0]!);
    await new IssuesService(env.DB).setLabel(issueA.id, orgLabel.id, { ownerOrgId: 1 });

    const path = `/repos/cf-gitea-stub/writes/issues/${issueA.index}/labels/${orgLabel.id}`;
    expect((await send(path, authed({ method: "DELETE" }))).status).toBe(204);
    expect(await drizzle(env.DB).select().from(issueLabels).all()).toHaveLength(0);
  });

  it("gates on writers (bare 403) and archived repos (423)", async () => {
    const label = await seedAttachedLabel(issueA.id, "triage");
    expect(
      (await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/labels/${label.id}`, authed({ method: "DELETE" }, TOKEN_NEIGHBOR))).status,
    ).toBe(403);
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, REPO_ID));
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/labels/${label.id}`, authed({ method: "DELETE" }))).status).toBe(423);
  });
});

// ---------------------------------------------------------------------------
// pinIssue / unpinIssue
// ---------------------------------------------------------------------------

describe("POST/DELETE /repos/{owner}/{repo}/issues/{index}/pin (pinIssue/unpinIssue)", () => {
  it("pins (204) at max_order + 1 with the pin (36) comment, per issue/pull half", async () => {
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/pin`, authed({ method: "POST" }))).status).toBe(204);
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueB.index}/pin`, authed({ method: "POST" }))).status).toBe(204);
    expect(await pinOrderPairs()).toEqual([
      { index: issueA.index, pinOrder: 1 },
      { index: issueB.index, pinOrder: 2 },
    ]);
    expect(await systemCommentTypes(issueA.id)).toEqual([36]);

    // The pull half keeps its own order space.
    const service = new IssuesService(env.DB);
    const pull = await service.createPullRequest({
      repoId: REPO_ID,
      headRepoId: REPO_ID,
      baseBranch: "main",
      headBranch: "topic",
      title: "pin me",
      posterId: 1,
    });
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${pull.pullRequest.index}/pin`, authed({ method: "POST" }))).status).toBe(204);
    expect(await pinOrderPairs()).toEqual([
      { index: issueA.index, pinOrder: 1 },
      { index: pull.pullRequest.index, pinOrder: 1 }, // independent half
      { index: issueB.index, pinOrder: 2 },
    ]);
  });

  it("refuses a re-pin (500, the upstream undeclared arm) and the 4th pin of a half (the MaxPinned cap)", async () => {
    const service = new IssuesService(env.DB);
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/pin`, authed({ method: "POST" }))).status).toBe(204);

    const repin = await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/pin`, authed({ method: "POST" }));
    expect(repin.status).toBe(500);
    expect(((await repin.json<Record<string, unknown>>())).message).toBe("issue is already pinned");

    const c = await service.createIssue({ repoId: REPO_ID, title: "gamma", posterId: 1 });
    const d = await service.createIssue({ repoId: REPO_ID, title: "delta", posterId: 1 });
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueB.index}/pin`, authed({ method: "POST" }))).status).toBe(204);
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${c.index}/pin`, authed({ method: "POST" }))).status).toBe(204);
    const capped = await send(`/repos/cf-gitea-stub/writes/issues/${d.index}/pin`, authed({ method: "POST" }));
    expect(capped.status).toBe(500);
    expect(((await capped.json<Record<string, unknown>>())).message).toBe("the max number of pinned issues has been readched");
    expect(await drizzle(env.DB).select().from(issuePins).all()).toHaveLength(3);
  });

  it("unpins (204) with the unpin (37) comment; unpinning an unpinned issue is the silent 204", async () => {
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/pin`, authed({ method: "POST" }))).status).toBe(204);
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/pin`, authed({ method: "DELETE" }))).status).toBe(204);
    expect(await drizzle(env.DB).select().from(issuePins).all()).toHaveLength(0);
    expect(await systemCommentTypes(issueA.id)).toEqual([36, 37]);

    expect((await send(`/repos/cf-gitea-stub/writes/issues/${issueA.index}/pin`, authed({ method: "DELETE" }))).status).toBe(204);
    expect(await systemCommentTypes(issueA.id)).toEqual([36, 37]); // no extra comment
  });
});

// ---------------------------------------------------------------------------
// moveIssuePin
// ---------------------------------------------------------------------------

describe("PATCH /repos/{owner}/{repo}/issues/{index}/pin/{position} (moveIssuePin)", () => {
  /** Pin A, B, C in order (A tests create their own issues). */
  async function seedThreePins(): Promise<Array<number>> {
    const service = new IssuesService(env.DB);
    const c = await service.createIssue({ repoId: REPO_ID, title: "gamma", posterId: 1 });
    for (const index of [issueA.index, issueB.index, c.index]) {
      expect((await send(`/repos/cf-gitea-stub/writes/issues/${index}/pin`, authed({ method: "POST" }))).status).toBe(204);
    }
    return [issueA.index, issueB.index, c.index];
  }

  it("moves a pin down and up, shifting the neighbours by one", async () => {
    const [a, b, c] = await seedThreePins();
    expect(await pinOrderPairs()).toEqual([
      { index: a, pinOrder: 1 },
      { index: b, pinOrder: 2 },
      { index: c, pinOrder: 3 },
    ]);

    // C to the front: A and B shift down by one.
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${c}/pin/1`, authed({ method: "PATCH" }))).status).toBe(204);
    expect(await pinOrderPairs()).toEqual([
      { index: c, pinOrder: 1 },
      { index: a, pinOrder: 2 },
      { index: b, pinOrder: 3 },
    ]);

    // A to the back: B and C shift up by one.
    expect((await send(`/repos/cf-gitea-stub/writes/issues/${a}/pin/3`, authed({ method: "PATCH" }))).status).toBe(204);
    expect(await pinOrderPairs()).toEqual([
      { index: c, pinOrder: 1 },
      { index: b, pinOrder: 2 },
      { index: a, pinOrder: 3 },
    ]);
  });

  it("is the silent 204 on the same position; 500s a position < 1 (non-integers parse to 0) or an unpinned issue", async () => {
    const [a, b, c] = await seedThreePins();

    expect((await send(`/repos/cf-gitea-stub/writes/issues/${a}/pin/1`, authed({ method: "PATCH" }))).status).toBe(204);
    expect(await pinOrderPairs()).toEqual([
      { index: a, pinOrder: 1 },
      { index: b, pinOrder: 2 },
      { index: c, pinOrder: 3 },
    ]);

    for (const position of ["0", "-2", "abc"]) {
      const bad = await send(`/repos/cf-gitea-stub/writes/issues/${a}/pin/${position}`, authed({ method: "PATCH" }));
      expect(bad.status).toBe(500);
      expect(((await bad.json<Record<string, unknown>>())).message).toBe("The Position can't be lower than 1");
    }

    // A live but unpinned issue: GetIssuePin's ErrNotExist arm.
    const d = await new IssuesService(env.DB).createIssue({ repoId: REPO_ID, title: "delta", posterId: 1 });
    const unpinned = await send(`/repos/cf-gitea-stub/writes/issues/${d.index}/pin/1`, authed({ method: "PATCH" }));
    expect(unpinned.status).toBe(500);
    expect(((await unpinned.json<Record<string, unknown>>())).message).toBe("pin for the issue does not exist");

    // A missing issue answers the shared 404 before the pin machinery runs.
    expect((await send(`/repos/cf-gitea-stub/writes/issues/999/pin/1`, authed({ method: "PATCH" }))).status).toBe(404);
    expect(await pinOrderPairs()).toEqual([
      { index: a, pinOrder: 1 },
      { index: b, pinOrder: 2 },
      { index: c, pinOrder: 3 },
    ]);
  });

  it("gates every write on repo writers (403) and answers 401/404 per the shared guards", async () => {
    const pinPath = `/repos/cf-gitea-stub/writes/issues/${issueA.index}/pin`;
    expect((await send(pinPath, { method: "POST" })).status).toBe(401);
    expect((await send(pinPath, authed({ method: "POST" }, TOKEN_NEIGHBOR))).status).toBe(403);
    expect((await send(pinPath, authed({ method: "DELETE" }, TOKEN_NEIGHBOR))).status).toBe(403);
    const gate = await send(`${pinPath}/1`, authed({ method: "PATCH" }, TOKEN_NEIGHBOR));
    expect(gate.status).toBe(403);
    expect(((await gate.json<Record<string, unknown>>())).message).toBe(
      "user should be an owner or a collaborator with admin write of a repository",
    );

    expect((await send("/repos/cf-gitea-stub/ghost/issues/1/pin", authed({ method: "POST" }))).status).toBe(404);
    expect((await send(`/repos/cf-gitea-stub/writes/issues/999/pin`, authed({ method: "POST" }))).status).toBe(404);
    expect((await send(`/repos/cf-gitea-stub/writes/issues/999/pin`, authed({ method: "DELETE" }))).status).toBe(404);
  });
});
