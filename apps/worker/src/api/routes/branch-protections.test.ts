/**
 * SPEC-0013 M3 — the /branch_protections API family, route-level on real D1
 * (the pull-merge-protection.test.ts standalone-mount convention; the family
 * is pure D1 — no engine cells — except nothing at all: even the recompute
 * legs ride plain pull_requests/pull_reviews rows).
 *
 * Matrix: CRUD happy paths with upstream render shapes (the deprecated
 * branch_name, the approvals_whitelist_username singular quirk, the
 * push/deletion flag conjunctions, the deploy-key pseudo-id), the 422/404/
 * 403/423 error arms with upstream's exact message texts, the pointer
 * semantics of the edit arm (absent ≠ false, the post-patch re-conjunction,
 * the disabled-arm array clearing), the priority renumber (one batch,
 * foreign-repo ids no-op), the first-match interplay (a second rule + the
 * priority op reorder what findRule hands the gates), and the recompute
 * instrument firing on create/replace/delete (the M1 as-built "wired at
 * M3" note: the official flag flips against the seeded pull_reviews).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { protectedBranches, pullReviews, repoCollaborators, repositories, ReviewType, teamMembers, teamRepoAccess, teams, users } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { emptyRuleConfig, findRule, serializeRuleConfig } from "../../services/branch-protection";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import type { ApiEnv } from "../env";
import { giteaErrorHandler } from "../errors";
import { registerBranchProtectionRoutes } from "./branch-protections";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "protected_branches",
    "pull_reviews",
    "comments",
    "issue_labels",
    "pull_requests",
    "issues",
    "milestones",
    "labels",
    "repo_collaborators",
    "repo_counters",
    "team_members",
    "teams",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const [id, username, isAdmin, type] of [
    [1, "doer", 0, "user"], // a plain authenticated non-admin
    [2, "bob", 0, "user"], // a write collaborator
    [3, "chief", 1, "user"], // site admin
    [4, "alice", 0, "user"], // the repo owner (the family's admin)
    [5, "cara", 0, "user"], // a second write collaborator
    [20, "acme", 0, "org"], // the org owner
  ] as const) {
    await env.DB.prepare("INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (?, ?, ?, ?, 'active', ?, 0)")
      .bind(id, username, username, isAdmin, type)
      .run();
  }
});

const db = () => drizzle(env.DB);
const service = () => new IssuesService(env.DB);

const DOER_TOKEN = "token-doer";
const ALICE_TOKEN = "token-alice";
const CHIEF_TOKEN = "token-chief";

const IDENTITY_TOKENS: Record<string, { id: number; login: string; is_admin: boolean }> = {
  [DOER_TOKEN]: { id: 1, login: "doer", is_admin: false },
  [ALICE_TOKEN]: { id: 4, login: "alice", is_admin: false },
  [CHIEF_TOKEN]: { id: 3, login: "chief", is_admin: true },
};

const resolver: AuthResolver = { resolveToken: (token: string) => Promise.resolve(IDENTITY_TOKENS[token] ?? null) };

/** Local mount of the orchestrator's registration seam (requireAuth only —
 *  the whole family is reqToken+reqAdmin upstream). The registry paths are
 *  relative to the /api/v1 mount, so fetched paths strip the prefix. */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerBranchProtectionRoutes(app, createTokenAuthMiddleware(resolver));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const authed = (token: string, init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${token}`, "Content-Type": "application/json" },
});

const post = (path: string, body: unknown, token = ALICE_TOKEN): Promise<Response> =>
  router()(path, authed(token, { method: "POST", body: JSON.stringify(body) }));
const patch = (path: string, body: unknown, token = ALICE_TOKEN): Promise<Response> =>
  router()(path, authed(token, { method: "PATCH", body: JSON.stringify(body) }));
const del = (path: string, token = ALICE_TOKEN): Promise<Response> => router()(path, authed(token, { method: "DELETE" }));
const get = (path: string, token = ALICE_TOKEN): Promise<Response> => router()(path, authed(token));

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text()) as Record<string, unknown>;
}

let repoSeq = 8100;

/** One user-owned repo (alice/visibleN, public, not archived). */
async function seedRepo(options: { orgOwned?: boolean; archived?: boolean } = {}): Promise<{ slug: string; repoId: string }> {
  const repoId = String(repoSeq++);
  const slug = `visible${repoId}`;
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: options.orgOwned === true ? "acme" : "alice",
    ownerId: options.orgOwned === true ? 20 : 4,
    slug,
    visibility: "public",
    isArchived: options.archived === true,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await service().ensureRepoCounters(repoId);
  return { slug, repoId };
}

/**
 * The org's teams: `devs` by default; a second name avoids the
 * UNIQUE(org_id, lower_name) collision. With a repoId, the team holds a
 * team_repo_access row on it — the M4 sanitization's repo-access filter input.
 */
async function seedTeam(repoId?: string, name = "devs"): Promise<number> {
  const inserted = await db()
    .insert(teams)
    .values({ orgId: 20, lowerName: name, name, authorize: "write" })
    .returning({ id: teams.id })
    .all();
  const teamId = inserted[0]!.id;
  await db().insert(teamMembers).values({ orgId: 20, teamId, userId: 2 });
  if (repoId !== undefined) {
    await db().insert(teamRepoAccess).values({ orgId: 20, teamId, repoId });
  }
  return teamId;
}

/** Write collaborators bob + cara (the predicates' write-access arm). */
async function seedCollaborators(repoId: string): Promise<void> {
  await db().insert(repoCollaborators).values([
    { repoId, userId: 2, mode: "write" },
    { repoId, userId: 5, mode: "write" },
  ]);
}

async function seedRule(repoId: string, ruleName: string, config = emptyRuleConfig(), priority = 0): Promise<number> {
  const inserted = await db()
    .insert(protectedBranches)
    .values({
      repoId,
      ruleName,
      priority,
      rules: serializeRuleConfig(config),
      createdAt: new Date("2026-03-01T00:00:00Z"),
      updatedAt: new Date("2026-03-01T00:00:00Z"),
    })
    .returning({ id: protectedBranches.id })
    .all();
  return inserted[0]!.id;
}

/** One open PR with base `main` (rows only — no engine cells needed). */
async function seedPullRequest(repoId: string): Promise<{ issueId: number; index: number }> {
  const { issue } = await service().createPullRequest({
    repoId,
    title: "protectable change",
    posterId: 2,
    headRepoId: repoId,
    baseBranch: "main",
    headBranch: "feature",
  });
  return { issueId: issue.id, index: issue.index };
}

async function seedReview(issueId: number, reviewerId: number, official: boolean): Promise<void> {
  await db().insert(pullReviews).values({
    type: ReviewType.Approve,
    reviewerId,
    issueId,
    content: "",
    official,
    stale: false,
    dismissed: false,
    commitId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

const reviewOfficialOf = async (issueId: number, reviewerId: number): Promise<boolean | null> => {
  const rows = await db()
    .select({ official: pullReviews.official })
    .from(pullReviews)
    .where(and(eq(pullReviews.issueId, issueId), eq(pullReviews.reviewerId, reviewerId)))
    .all();
  return rows[0]?.official ?? null;
};

const ruleRowByName = async (repoId: string, ruleName: string): Promise<Record<string, unknown> | undefined> => {
  const rows = await db()
    .select()
    .from(protectedBranches)
    .where(and(eq(protectedBranches.repoId, repoId), eq(protectedBranches.ruleName, ruleName)))
    .all();
  const row = rows[0];
  return row === undefined ? undefined : { ...row, rules: JSON.parse(row.rules) as unknown };
};

const repoPath = (slug: string): string => `/api/v1/repos/alice/${slug}/branch_protections`;

describe("repoCreateBranchProtection", () => {
  it("201 happy path: renders upstream shapes and stores the upstream json keys", async () => {
    const { slug, repoId } = await seedRepo();
    // M4 sanitization: whitelisted principals need their access — bob/cara
    // are write collaborators so their lists survive (the M3-era verbatim
    // storage of unprivileged ids is exactly what M4 stopped).
    await seedCollaborators(repoId);
    const res = await post(repoPath(slug), {
      rule_name: "main",
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: ["bob"],
      required_approvals: 2,
      enable_approvals_whitelist: true,
      approvals_whitelist_username: ["BOB", "cara"],
      block_on_rejected_reviews: true,
    });
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.rule_name).toBe("main");
    expect(body.branch_name).toBe("main");
    expect(body.priority).toBe(1); // absent priority → MAX+1 (0 → 1)
    expect(body.enable_push).toBe(true);
    expect(body.enable_push_whitelist).toBe(true);
    expect(body.push_whitelist_usernames).toEqual(["bob"]);
    expect(body.required_approvals).toBe(2);
    // case-insensitive name resolution, id-order render
    expect(body.approvals_whitelist_username).toEqual(["bob", "cara"]);
    expect(body.block_on_rejected_reviews).toBe(true);
    expect(body.push_whitelist_deploy_keys).toBe(false);
    expect(typeof body.created_at).toBe("string");
    expect(new Date(body.created_at as string).getTime()).not.toBeNaN();
    // storage: the config under upstream's exact snake_case keys, ids resolved
    const stored = await ruleRowByName(repoId, "main");
    const rules = stored?.rules as Record<string, unknown>;
    expect(rules.can_push).toBe(true);
    expect(rules.whitelist_user_ids).toEqual([2]);
    expect(rules.approvals_whitelist_user_ids).toEqual([2, 5]);
    expect(rules.required_approvals).toBe(2);
  });

  it("falls back to the deprecated branch_name and conjoins the push/deletion flags", async () => {
    const { slug } = await seedRepo();
    const res = await post(repoPath(slug), {
      branch_name: "legacy",
      enable_push: true,
      enable_force_push: true,
      enable_deletion: true,
    });
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.rule_name).toBe("legacy");
    expect(body.enable_force_push).toBe(true);
    expect(body.enable_deletion).toBe(true);
    // enable_force_push_allowlist needs the allowlist flag too; deletion
    // allowlist likewise (branch.go:786-807's conjunctions)
    expect(body.enable_force_push_allowlist).toBe(false);
    expect(body.enable_deletion_allowlist).toBe(false);
  });

  it("400s the both-names-empty body (upstream runtime-only code)", async () => {
    await seedRepo();
    const res = await post(repoPath(`visible${repoSeq - 1}`), { enable_push: true });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).message).toBe("both rule_name and branch_name are empty");
  });

  it("403s the exact-name collision with upstream's message", async () => {
    const { slug } = await seedRepo();
    await post(repoPath(slug), { rule_name: "main" });
    const res = await post(repoPath(slug), { rule_name: "main" });
    expect(res.status).toBe(403);
    expect((await jsonBody(res)).message).toBe("Branch protection already exist");
  });

  it("422s unknown usernames and unknown org teams with upstream's texts", async () => {
    const { slug } = await seedRepo();
    const unknownUser = await post(repoPath(slug), { rule_name: "main", push_whitelist_usernames: ["ghost"] });
    expect(unknownUser.status).toBe(422);
    expect((await jsonBody(unknownUser)).message).toBe("user does not exist [uid: 0, name: ghost]");

    const orgRepo = await seedRepo({ orgOwned: true });
    await seedTeam();
    // the acme repo's admin is the site admin (alice owns only her own repos)
    const unknownTeam = await post(`/api/v1/repos/acme/${orgRepo.slug}/branch_protections`, { rule_name: "main", push_whitelist_teams: ["ghost"] }, CHIEF_TOKEN);
    expect(unknownTeam.status).toBe(422);
    expect((await jsonBody(unknownTeam)).message).toBe(`team does not exist [org_id 20, team_id 0, name: ghost]`);
  });

  it("resolves team names to ids on org-owned repos and stores the deploy-key pseudo-id", async () => {
    const { slug, repoId } = await seedRepo({ orgOwned: true });
    // the team holds repo access so the M4 sanitization keeps it
    const teamId = await seedTeam(repoId);
    const res = await post(`/api/v1/repos/acme/${slug}/branch_protections`, {
      rule_name: "main",
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: ["gitea:deploy-key"],
      push_whitelist_deploy_keys: true,
      push_whitelist_teams: ["devs"],
    }, CHIEF_TOKEN);
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.push_whitelist_deploy_keys).toBe(true);
    expect(body.push_whitelist_teams).toEqual(["devs"]);
    const stored = await ruleRowByName(repoId, "main");
    const rules = stored?.rules as Record<string, unknown>;
    expect(rules.whitelist_user_ids).toEqual([-3]);
    expect(rules.whitelist_team_ids).toEqual([teamId]);
  });

  it("404s an unknown repo and 403s a non-admin with upstream's reqAdmin text", async () => {
    await seedRepo();
    const missing = await post("/api/v1/repos/alice/ghost/branch_protections", { rule_name: "main" });
    expect(missing.status).toBe(404);

    const forbidden = await post(repoPath(`visible${repoSeq - 1}`), { rule_name: "main" }, DOER_TOKEN);
    expect(forbidden.status).toBe(403);
    expect((await jsonBody(forbidden)).message).toBe("user should be an owner or a collaborator with admin write of a repository");

    // a site admin passes reqAdmin
    const adminOk = await post(repoPath(`visible${repoSeq - 1}`), { rule_name: "main" }, CHIEF_TOKEN);
    expect(adminOk.status).toBe(201);
  });

  it("423s an archived repo", async () => {
    const { slug } = await seedRepo({ archived: true });
    const res = await post(repoPath(slug), { rule_name: "main" });
    expect(res.status).toBe(423);
  });
});

describe("repoGetBranchProtection + repoListBranchProtection", () => {
  it("200s the exact-name lookup; a glob rule renders an empty deprecated branch_name", async () => {
    const { slug, repoId } = await seedRepo();
    await seedRule(repoId, "release/*");
    // the rule name is a single path segment; the client percent-encodes it
    const res = await get(`${repoPath(slug)}/${encodeURIComponent("release/*")}`);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.rule_name).toBe("release/*");
    expect(body.branch_name).toBe(""); // IsRuleNameSpecial → empty deprecated field
  });

  it("404s an unknown rule name", async () => {
    const { slug } = await seedRepo();
    const res = await get(`${repoPath(slug)}/main`);
    expect(res.status).toBe(404);
  });

  it("200s the list in the service's first-match sort order (empty → [])", async () => {
    const { slug, repoId } = await seedRepo();
    const empty = await get(repoPath(slug));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual([]);

    await seedRule(repoId, "release/*", emptyRuleConfig(), 1);
    await seedRule(repoId, "main", emptyRuleConfig(), 2);
    const list = await (await get(repoPath(slug))).json<Array<Record<string, unknown>>>();
    expect(list.map((rule) => rule.rule_name)).toEqual(["release/*", "main"]);
    expect(list.map((rule) => rule.priority)).toEqual([1, 2]);
  });
});

describe("repoEditBranchProtection", () => {
  it("200s the pointer semantics: absent keeps, the push master cascades, arrays persist with a disabled whitelist", async () => {
    const { slug, repoId } = await seedRepo();
    await seedRule(repoId, "main", {
      ...emptyRuleConfig(),
      canPush: true,
      enableWhitelist: true,
      whitelistUserIds: [2],
    });
    const res = await patch(`${repoPath(slug)}/main`, { enable_push: true, enable_push_whitelist: false });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.enable_push).toBe(true); // the master stays on
    expect(body.enable_push_whitelist).toBe(false); // patched sub-flag
    expect(body.push_whitelist_usernames).toEqual(["bob"]); // the stored ids survive (upstream clears only bypass/deletion arrays)

    // upstream quirk (branch.go:894-913): a sub-flag patch WITHOUT the
    // master is nested under `EnablePush != nil` — it changes nothing
    const ignored = await patch(`${repoPath(slug)}/main`, { enable_push_whitelist: true });
    expect(ignored.status).toBe(200);
    expect((await jsonBody(ignored)).enable_push_whitelist).toBe(false);

    const off = await patch(`${repoPath(slug)}/main`, { enable_push: false });
    expect(off.status).toBe(200);
    const offBody = await jsonBody(off);
    expect(offBody.enable_push).toBe(false);
    expect(offBody.enable_push_whitelist).toBe(false); // the master clears its sub-flag
  });

  it("re-conjoins can_delete/enable_deletion_allowlist onto can_push after the patches", async () => {
    const { slug, repoId } = await seedRepo();
    await seedRule(repoId, "main", {
      ...emptyRuleConfig(),
      canPush: true,
      canDelete: true,
      enableDeletionAllowlist: true,
      deletionAllowlistUserIds: [2],
    });
    const res = await patch(`${repoPath(slug)}/main`, { enable_deletion: false });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.enable_deletion).toBe(false);
    expect(body.enable_deletion_allowlist).toBe(false); // the conjunction
    expect(body.deletion_allowlist_usernames).toEqual([]); // disabled arms clear their arrays
  });

  it("replaces whitelists when names are given (422 unknown) and keeps them when absent", async () => {
    const { slug, repoId } = await seedRepo();
    await seedCollaborators(repoId); // cara (5) holds write — the M4 write filter keeps her
    await seedRule(repoId, "main", { ...emptyRuleConfig(), enableMergeWhitelist: true, mergeWhitelistUserIds: [2] });

    const unknown = await patch(`${repoPath(slug)}/main`, { merge_whitelist_usernames: ["ghost"] });
    expect(unknown.status).toBe(422);
    expect((await jsonBody(unknown)).message).toBe("user does not exist [uid: 0, name: ghost]");

    const replaced = await patch(`${repoPath(slug)}/main`, { merge_whitelist_usernames: ["cara"] });
    expect(replaced.status).toBe(200);
    expect((await jsonBody(replaced)).merge_whitelist_usernames).toEqual(["cara"]);

    const kept = await patch(`${repoPath(slug)}/main`, { required_approvals: 1 });
    expect(kept.status).toBe(200);
    const keptBody = await jsonBody(kept);
    expect(keptBody.merge_whitelist_usernames).toEqual(["cara"]); // absent array keeps
    expect(keptBody.required_approvals).toBe(1);
  });

  it("404s an unknown rule name and 423s an archived repo", async () => {
    const { slug } = await seedRepo();
    expect((await patch(`${repoPath(slug)}/main`, { priority: 3 })).status).toBe(404);
    const archived = await seedRepo({ archived: true });
    await seedRule(archived.repoId, "main");
    expect((await patch(`/api/v1/repos/alice/${archived.slug}/branch_protections/main`, { priority: 3 })).status).toBe(423);
  });
});

describe("repoDeleteBranchProtection", () => {
  it("204s, removes the row, and 404s the name afterwards", async () => {
    const { slug, repoId } = await seedRepo();
    await seedRule(repoId, "main");
    expect((await del(`${repoPath(slug)}/main`)).status).toBe(204);
    expect((await get(`${repoPath(slug)}/main`)).status).toBe(404);
    expect(await ruleRowByName(repoId, "main")).toBeUndefined();
  });

  it("404s an unknown rule name", async () => {
    const { slug } = await seedRepo();
    expect((await del(`${repoPath(slug)}/main`)).status).toBe(404);
  });
});

describe("repoUpdateBranchProtectionPriories", () => {
  it("204s the renumber and flips the gates' first-match resolution", async () => {
    const { slug, repoId } = await seedRepo();
    const plainId = await seedRule(repoId, "main", emptyRuleConfig(), 1);
    const globId = await seedRule(repoId, "ma*", emptyRuleConfig(), 2);
    // before: the plain rule sorts first (priority 1)
    const before = await findRule(env.DB, repoId, "main");
    expect(before?.ruleName).toBe("main");

    const res = await post(`${repoPath(slug)}/priority`, { ids: [globId, plainId] });
    expect(res.status).toBe(204);
    const rows = await db().select().from(protectedBranches).where(eq(protectedBranches.repoId, repoId)).all();
    const priorities = new Map(rows.map((row) => [row.id, row.priority]));
    expect(priorities.get(globId)).toBe(1);
    expect(priorities.get(plainId)).toBe(2);
    // after: the glob rule is first-match for the same branch — what every
    // gate (merge/push/reviews) resolves changes with the reorder
    const after = await findRule(env.DB, repoId, "main");
    expect(after?.ruleName).toBe("ma*");
  });

  it("no-ops foreign-repo ids through the repo_id guard and 404s an unknown repo", async () => {
    const { slug, repoId } = await seedRepo();
    const other = await seedRepo();
    const foreignId = await seedRule(other.repoId, "main", emptyRuleConfig(), 9);
    const res = await post(`${repoPath(slug)}/priority`, { ids: [foreignId] });
    expect(res.status).toBe(204);
    const rows = await db().select().from(protectedBranches).where(eq(protectedBranches.id, foreignId)).all();
    expect(rows[0]?.priority).toBe(9); // untouched
    expect(await db().select().from(protectedBranches).where(eq(protectedBranches.repoId, repoId)).all()).toHaveLength(0);

    const missing = await post("/api/v1/repos/alice/ghost/branch_protections/priority", { ids: [] });
    expect(missing.status).toBe(404);
  });
});

describe("the recompute instrument (wired at M3)", () => {
  it("create: the whitelist rule recompute flips a non-whitelisted reviewer's official flag", async () => {
    const { slug, repoId } = await seedRepo();
    await seedCollaborators(repoId);
    const { issueId } = await seedPullRequest(repoId);
    // the reviews wave's write-access fallback made both collaborators official
    await seedReview(issueId, 2, true);
    await seedReview(issueId, 5, true);

    const res = await post(repoPath(slug), {
      rule_name: "main",
      enable_approvals_whitelist: true,
      approvals_whitelist_username: ["bob"],
    });
    expect(res.status).toBe(201);
    // cara is not in the whitelist → her stored flag recomputes to false
    expect(await reviewOfficialOf(issueId, 2)).toBe(true);
    expect(await reviewOfficialOf(issueId, 5)).toBe(false);
  });

  it("replace (PATCH): extending the whitelist recompute flips the flag back", async () => {
    const { slug, repoId } = await seedRepo();
    await seedCollaborators(repoId);
    const { issueId } = await seedPullRequest(repoId);
    await post(repoPath(slug), { rule_name: "main", enable_approvals_whitelist: true, approvals_whitelist_username: ["bob"] });
    await seedReview(issueId, 5, false);

    const res = await patch(`${repoPath(slug)}/main`, { approvals_whitelist_username: ["bob", "cara"] });
    expect(res.status).toBe(200);
    expect(await reviewOfficialOf(issueId, 5)).toBe(true);
  });

  it("delete: the rule's removal recomputes the no-rule state (write access counts again)", async () => {
    const { slug, repoId } = await seedRepo();
    await seedCollaborators(repoId);
    const { issueId } = await seedPullRequest(repoId);
    await post(repoPath(slug), { rule_name: "main", enable_approvals_whitelist: true, approvals_whitelist_username: ["bob"] });
    await seedReview(issueId, 5, false);

    const res = await del(`${repoPath(slug)}/main`);
    expect(res.status).toBe(204);
    // with the rule gone the whitelist arm evaporates: cara's write access
    // makes her official again (the recompute evaluates the no-rule config)
    expect(await reviewOfficialOf(issueId, 5)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SPEC-0013 M4 — the save-side whitelist sanitization through the API arms
// (UpdateProtectBranch :418-527: a resolved-but-unprivileged or vanished
// principal never persists).
// ---------------------------------------------------------------------------

describe("M4 save-side sanitization (create + edit arms)", () => {
  it("create drops users without repo-code write from the push/merge lists; the approvals list keeps explicit read access", async () => {
    const { slug, repoId } = await seedRepo();
    await seedCollaborators(repoId); // bob (2) + cara (5) write
    await db().insert(repoCollaborators).values({ repoId, userId: 1, mode: "read", createdAt: new Date(), updatedAt: new Date() });
    const res = await post(repoPath(slug), {
      rule_name: "main",
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: ["doer", "bob"], // reader + writer
      enable_merge_whitelist: true,
      merge_whitelist_usernames: ["doer"], // reader — dropped (CanWrite(TypeCode) :595-597)
      enable_approvals_whitelist: true,
      approvals_whitelist_username: ["doer", "bob"], // ANY explicit access keeps both (:549-568)
    });
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.push_whitelist_usernames).toEqual(["bob"]);
    expect(body.merge_whitelist_usernames).toEqual([]);
    expect(body.approvals_whitelist_username).toEqual(["doer", "bob"]);
    const rules = (await ruleRowByName(repoId, "main"))?.rules as Record<string, unknown>;
    expect(rules.whitelist_user_ids).toEqual([2]);
    expect(rules.merge_whitelist_user_ids).toEqual([]);
    expect(rules.approvals_whitelist_user_ids).toEqual([1, 2]);
  });

  it("create keeps the site admin (the admin matrix grant is write) and drops teams without repo access", async () => {
    const { slug, repoId } = await seedRepo({ orgOwned: true });
    const grantedTeam = await seedTeam(repoId, "devs");
    await seedTeam(undefined, "extras"); // no team_repo_access row on this repo
    const res = await post(`/api/v1/repos/acme/${slug}/branch_protections`, {
      rule_name: "main",
      enable_push: true,
      enable_push_whitelist: true,
      push_whitelist_usernames: ["chief"], // site admin — principalAccessOf's admin grant
      push_whitelist_teams: ["devs", "extras"],
    }, CHIEF_TOKEN);
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.push_whitelist_usernames).toEqual(["chief"]);
    expect(body.push_whitelist_teams).toEqual(["devs"]); // extras holds no access (:605-624)
    const rules = (await ruleRowByName(repoId, "main"))?.rules as Record<string, unknown>;
    expect(rules.whitelist_user_ids).toEqual([3]);
    expect(rules.whitelist_team_ids).toEqual([grantedTeam]);
  });

  it("edit keeps an UNCHANGED list verbatim — a vanished id survives an untouched list (the :575 short-circuit; the scrub owns it)", async () => {
    const { slug, repoId } = await seedRepo();
    await seedRule(repoId, "main", { ...emptyRuleConfig(), canPush: true, enableWhitelist: true, whitelistUserIds: [2] });
    await db().delete(users).where(eq(users.id, 2)); // bob vanishes
    const res = await patch(`${repoPath(slug)}/main`, { required_approvals: 1 });
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).push_whitelist_usernames).toEqual([]); // renders as nothing...
    const rules = (await ruleRowByName(repoId, "main"))?.rules as Record<string, unknown>;
    expect(rules.whitelist_user_ids).toEqual([2]); // ...but the storage keeps the list untouched
  });

  it("edit drops a vanished id once the list CHANGES (the §4.4 normalization — upstream errors the save, the spec pins drop)", async () => {
    const { slug, repoId } = await seedRepo();
    await seedCollaborators(repoId);
    await seedRule(repoId, "main", { ...emptyRuleConfig(), canPush: true, enableWhitelist: true, whitelistUserIds: [2, 5] });
    await db().delete(users).where(eq(users.id, 2)); // bob vanishes
    const res = await patch(`${repoPath(slug)}/main`, { push_whitelist_usernames: ["cara"] });
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).push_whitelist_usernames).toEqual(["cara"]);
    const rules = (await ruleRowByName(repoId, "main"))?.rules as Record<string, unknown>;
    expect(rules.whitelist_user_ids).toEqual([5]); // the vanished id is gone from storage
  });

  it("edit drops a DEMOTED principal when the list changes (the changed-list write filter)", async () => {
    const { slug, repoId } = await seedRepo();
    await seedCollaborators(repoId);
    // stored: cara only. An edit re-submitting the SAME set would short-circuit
    // (the :575 keep — upstream identical); the write filter fires on a list
    // that actually changed.
    await seedRule(repoId, "main", { ...emptyRuleConfig(), canPush: true, enableWhitelist: true, whitelistUserIds: [5] });
    await db().update(repoCollaborators).set({ mode: "read" }).where(and(eq(repoCollaborators.repoId, repoId), eq(repoCollaborators.userId, 5)));
    const res = await patch(`${repoPath(slug)}/main`, { push_whitelist_usernames: ["bob", "cara"] });
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).push_whitelist_usernames).toEqual(["bob"]);
    const rules = (await ruleRowByName(repoId, "main"))?.rules as Record<string, unknown>;
    expect(rules.whitelist_user_ids).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// SPEC-0013 M4 — priority op edge cases (UpdateProtectBranchPriorities
// :529-545 ports beyond the M3 happy path).
// ---------------------------------------------------------------------------

describe("priority op edge cases (M4)", () => {
  it("a partial id list renumbers only the listed rules; unlisted rules keep their priorities", async () => {
    const { slug, repoId } = await seedRepo();
    const a = await seedRule(repoId, "a", emptyRuleConfig(), 7);
    const b = await seedRule(repoId, "b", emptyRuleConfig(), 8);
    const c = await seedRule(repoId, "c", emptyRuleConfig(), 9);
    const res = await post(`${repoPath(slug)}/priority`, { ids: [b] });
    expect(res.status).toBe(204);
    const rows = await db().select().from(protectedBranches).where(eq(protectedBranches.repoId, repoId)).all();
    const priorityOf = new Map(rows.map((row) => [row.id, row.priority]));
    expect(priorityOf.get(b)).toBe(1); // renumbered from the list head
    expect(priorityOf.get(a)).toBe(7); // untouched
    expect(priorityOf.get(c)).toBe(9); // untouched
  });

  it("absent and empty id lists 204 with nothing written", async () => {
    const { slug, repoId } = await seedRepo();
    const a = await seedRule(repoId, "main", emptyRuleConfig(), 3);
    expect((await post(`${repoPath(slug)}/priority`, {})).status).toBe(204);
    expect((await post(`${repoPath(slug)}/priority`, { ids: [] })).status).toBe(204);
    const row = (await db().select().from(protectedBranches).where(eq(protectedBranches.id, a)).all())[0]!;
    expect(row.priority).toBe(3);
  });
});
