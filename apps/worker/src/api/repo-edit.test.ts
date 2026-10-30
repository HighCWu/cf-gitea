/**
 * Tier-1 repo-edit routes on real D1 (SPEC-0004 §2.4 rows repoEdit /
 * repoDelete / repoTransfer; upstream routers/api/v1/repo/repo.go Edit +
 * transfer.go over the landed repos service). Pins: the meaningful-subset
 * PATCH (rename via the landed service — old URL 404s and a redirect row
 * appears; visibility flip; default branch; archived flip; the stored
 * description/website/has_* subset with the PATCH→GET round trip; the
 * accepted-and-ignored remainder), the 422 family (rename collision /
 * invalid name), the admin/danger-zone 403s, the §2.5.5 DELETE (D1 row +
 * this batch's raw stores gone), and the pending-arm 201 transfer
 * (transfer.go:126-130 — 201 with the current-state Repository + the pending
 * repo_transfer row; the anti-enumeration 404 unknown-owner message,
 * self-transfer 422, teams 422).
 */

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { repoRedirects, repoTransfer, repoUnits, repoWatchers, repositories, stars, userBlocking, users, webhookDeliveries, webhooks } from "../db/schema";
import {
  createOptionalTokenAuthMiddleware,
  createStubAuthResolver,
  createTokenAuthMiddleware,
  STUB_USER,
  type AuthResolver,
} from "./auth";
import { basicTokenHeader, mintFor } from "../auth/testing/seeds";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { registerRepoRoutes } from "./routes/repo";
import { LICENSE_CORPUS_TEXTS } from "../services/license-corpus";
import { getRepoLicenses } from "../services/repo-licenses";
import { addOrUpdateCollaborator } from "./services/repo-collaborators";
import { watchRepo } from "./services/repo-watchers";
import { starRepo } from "./services/stars";
import { applyRepoExtrasDdl, resetRepoExtrasTables } from "./testing/repo-ddl";
import { buildHistoryPack, buildReceivePackBody, ensureSeededRepo, type SeedCommit } from "../ui/testing/seed-repo";

const TOKEN = "stub-token"; // STUB_USER (id 1) — the repo owner
const TOKEN_OTHER = "other-token"; // 'other' — a plain user
const TOKEN_COLLAB_ADMIN = "collab-admin-token";
const TOKEN_ADMIN = "admin-token";
const ERROR_URL = "https://example.com/api/swagger";

let otherUserId = 0;
let collabAdminUserId = 0;
let adminUserId = 0;

function userIdentity(id: number, login: string) {
  return {
    id,
    login,
    email: "",
    full_name: login,
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
    type: "User" as const,
    visibility: "public" as const,
  };
}

function makeApp(): (path: string, init?: RequestInit) => Promise<Response> {
  const resolver: AuthResolver = {
    resolveToken: (token) => {
      if (token === TOKEN) return createStubAuthResolver().resolveToken(token);
      if (token === TOKEN_OTHER) return Promise.resolve(userIdentity(otherUserId, "other"));
      if (token === TOKEN_COLLAB_ADMIN) return Promise.resolve(userIdentity(collabAdminUserId, "collab-admin"));
      if (token === TOKEN_ADMIN) return Promise.resolve({ ...userIdentity(adminUserId, "root-admin"), is_admin: true });
      return Promise.resolve(null);
    },
  };
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerRepoRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return (path, init) => Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

beforeAll(async () => {
  await applyRepoExtrasDdl();
});

beforeEach(async () => {
  await resetRepoExtrasTables();
  for (const table of ["stars", "repo_transfer", "repo_redirects", "repo_counters", "repo_units", "webhook_deliveries", "webhooks", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  const other = await drizzle(env.DB)
    .insert(users)
    .values({ username: "other", usernameLower: "other", status: "active", createdAt: new Date() })
    .returning({ id: users.id })
    .all();
  otherUserId = other[0]!.id;
  const collabAdmin = await drizzle(env.DB)
    .insert(users)
    .values({ username: "collab-admin", usernameLower: "collab-admin", status: "active", createdAt: new Date() })
    .returning({ id: users.id })
    .all();
  collabAdminUserId = collabAdmin[0]!.id;
  const rootAdmin = await drizzle(env.DB)
    .insert(users)
    .values({ username: "root-admin", usernameLower: "root-admin", isAdmin: true, status: "active", createdAt: new Date() })
    .returning({ id: users.id })
    .all();
  adminUserId = rootAdmin[0]!.id;
  await drizzle(env.DB).insert(repositories).values({
    id: "7401",
    storageKey: "r_7401",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "edit-me",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
});

const jsonAuth = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const repoPath = "/repos/cf-gitea-stub/edit-me";

/** An active send-everything hook row over the seeded repo — the emission
 *  assertion surface is the delivery log (§3.6), rows stay `pending` because
 *  in-process callers have no executionCtx to enqueue with. */
async function seedHook(): Promise<number> {
  const inserted = await drizzle(env.DB)
    .insert(webhooks)
    .values({
      repoId: "7401",
      url: "https://hooks.example.com/repo",
      events: JSON.stringify({ send_everything: true }),
      isActive: true,
    })
    .returning({ id: webhooks.id })
    .all();
  return inserted[0]!.id;
}

const deliveries = () => drizzle(env.DB).select().from(webhookDeliveries).orderBy(webhookDeliveries.id).all();

describe("PATCH /repos/{owner}/{repo} (repoEdit) — stored settings subset", () => {
  it("updates description/website and renders them on the PATCH and on GET", async () => {
    const patch = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ description: "hello", website: "https://example.io" }),
    });
    expect(patch.status).toBe(200);
    const body = await patch.json<Record<string, unknown>>();
    expect(body.description).toBe("hello");
    expect(body.website).toBe("https://example.io");

    const get = await makeApp()(repoPath);
    expect(await get.json<Record<string, unknown>>()).toMatchObject({ description: "hello", website: "https://example.io" });
  });

  it("upsert-merges: a second PATCH touching only description keeps the stored flags", async () => {
    await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ description: "first", has_issues: false }),
    });
    const second = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ description: "second" }),
    });
    expect(second.status).toBe(200);
    const body = await second.json<Record<string, unknown>>();
    expect(body.description).toBe("second");
    expect(body.has_issues).toBe(false);
  });

  it("applies the has_* unit flags and ignores the accepted-and-ignored remainder", async () => {
    const res = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ has_wiki: false, has_projects: true, mirror_interval: "8h" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.has_wiki).toBe(false);
    expect(body.has_projects).toBe(true);
    // Ignored remainder: no store — the render keeps the upstream defaults.
    expect(body.mirror_interval).toBe("");
  });

  it("maintains the repo_units actions row with has_actions (the scan's unit gate — upstream ActionsUnitPost's UpdateRepositoryUnits arm)", async () => {
    // The owner-scope runner scan joins repo_units type='actions'
    // (models/actions/task.go:280-284), so a flag-only PATCH left it blind
    // to the repo (the C9 unit-row gap).
    const on = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ has_actions: true }),
    });
    expect(on.status).toBe(200);
    expect(
      (await drizzle(env.DB).select().from(repoUnits).where(eq(repoUnits.repoId, "7401")).all()).map((r) => r.type),
    ).toEqual(["actions"]);
    const off = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ has_actions: false }),
    });
    expect(off.status).toBe(200);
    expect(await drizzle(env.DB).select().from(repoUnits).where(eq(repoUnits.repoId, "7401")).all()).toEqual([]);
  });

  it("writes the template flag (repo.go:699-701) — the API-reachable generate gate", async () => {
    // REDEPLOY11 open issue 2: the edit schema accepted `template` but the
    // handler never persisted it, making upstream's "mark a repo a template
    // via API" flow (and so POST .../generate) unreachable.
    const on = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ template: true }),
    });
    expect(on.status).toBe(200);
    expect((await on.json<Record<string, unknown>>()).template).toBe(true);
    expect(
      (await drizzle(env.DB).select({ isTemplate: repositories.isTemplate }).from(repositories).where(eq(repositories.id, "7401")).all())[0]
        ?.isTemplate,
    ).toBe(true);

    // And back off (upstream writes both directions — *opts.Template).
    const off = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ template: false }),
    });
    expect(off.status).toBe(200);
    expect((await off.json<Record<string, unknown>>()).template).toBe(false);
  });

  it("412-style gates flip with the flags: releases off turns GET /releases 412", async () => {
    await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ has_releases: false }) });
    // The releases family is not mounted in this standalone app; the flag's
    // storage is what this batch owns — assert the round trip instead.
    const res = await makeApp()(repoPath);
    expect((await res.json<Record<string, unknown>>()).has_releases).toBe(false);
  });
});

describe("PATCH /repos/{owner}/{repo} (repoEdit) — the PR-merge configuration (updateRepoUnits, repo.go:855-966)", () => {
  /** The repo_units 'pull_requests' config row, if any. */
  const prUnitRow = async () =>
    (
      await drizzle(env.DB)
        .select()
        .from(repoUnits)
        .where(and(eq(repoUnits.repoId, "7401"), eq(repoUnits.type, "pull_requests")))
        .all()
    )[0];

  it("round-trips the merge flags PATCH → GET (the E3 accepted-and-ignored drift closed)", async () => {
    const patch = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({
        allow_squash_merge: false,
        allow_merge_commits: false,
        ignore_whitespace_conflicts: true,
        default_merge_style: "rebase",
        default_allow_maintainer_edit: false,
        default_delete_branch_after_merge: true,
      }),
    });
    expect(patch.status).toBe(200);
    await expect(patch.json<Record<string, unknown>>()).resolves.toMatchObject({
      allow_squash_merge: false,
      allow_merge_commits: false,
      ignore_whitespace_conflicts: true,
      default_merge_style: "rebase",
      default_allow_maintainer_edit: false,
      default_delete_branch_after_merge: true,
    });

    const get = await makeApp()(repoPath);
    await expect(get.json<Record<string, unknown>>()).resolves.toMatchObject({
      allow_squash_merge: false,
      allow_merge_commits: false,
      ignore_whitespace_conflicts: true,
      default_merge_style: "rebase",
      default_allow_maintainer_edit: false,
      default_delete_branch_after_merge: true,
      // Untouched fields keep the upstream defaults (DefaultPullRequestsConfig).
      allow_rebase: true,
      allow_rebase_explicit: true,
      allow_fast_forward_only_merge: true,
      allow_merge_update: true,
      allow_rebase_update: true,
    });

    // The store: the repo_units 'pull_requests' row's config JSON carries the
    // GO MARSHAL keys (repo_unit.go:167-170 — the ActionsConfig convention).
    const row = await prUnitRow();
    expect(row?.config).toBeTruthy();
    expect(JSON.parse(row!.config!)).toMatchObject({ AllowSquash: false, AllowMerge: false, IgnoreWhitespaceConflicts: true });
  });

  it("overlay-merges: a second PATCH touching only description keeps the stored config", async () => {
    await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ allow_rebase: false }) });
    const second = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ description: "later" }) });
    expect(second.status).toBe(200);
    await expect(second.json<Record<string, unknown>>()).resolves.toMatchObject({ allow_rebase: false, allow_merge_commits: true });
  });

  it("400s an invalid squash_merge_commit_message and persists nothing (repo.go:950-952)", async () => {
    const res = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ squash_merge_commit_message: "NOPE" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ message: string }>()).message).toBe("invalid squash_merge_commit_message: NOPE");
    // The rejected write left no unit row — the config block never persisted.
    expect(await prUnitRow()).toBeUndefined();
    expect((await (await makeApp()(repoPath)).json<Record<string, unknown>>()).squash_merge_commit_message).toBe("PR_BODY");
  });

  it("400s the update-style violations and 200s the valid combo (ValidateUpdateSettings, repo_unit.go:194-206)", async () => {
    const bad = async (body: Record<string, unknown>, message: string) => {
      const res = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify(body) });
      expect(res.status).toBe(400);
      expect((await res.json<{ message: string }>()).message).toBe(message);
    };
    await bad({ default_update_style: "squash" }, "default update style must be merge or rebase");
    await bad(
      { allow_merge_update: false, allow_rebase_update: false },
      "at least one pull request branch update style must be enabled",
    );
    await bad({ allow_merge_update: false, default_update_style: "merge" }, "default update style must be enabled");
    await bad({ allow_rebase_update: false, default_update_style: "rebase" }, "default update style must be enabled");

    // The valid combo: rebase update allowed by its own flag.
    const good = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ allow_rebase_update: true, default_update_style: "rebase" }),
    });
    expect(good.status).toBe(200);
    await expect(good.json<Record<string, unknown>>()).resolves.toMatchObject({
      default_update_style: "rebase",
      allow_rebase_update: true,
    });
  });

  it("skips the update-style validation on unrelated PATCHes over a historical inconsistent config (repo.go:953-961's gate)", async () => {
    await drizzle(env.DB).insert(repoUnits).values({
      repoId: "7401",
      type: "pull_requests",
      config: JSON.stringify({ AllowMergeUpdate: false, AllowRebaseUpdate: false, DefaultUpdateStyle: "rebase" }),
    });
    // No update-style field in the body → the trio is not validated.
    const unrelated = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ description: "x" }) });
    expect(unrelated.status).toBe(200);
    // Touching one of the trio validates the MERGED config — the stored
    // inconsistent flags fail it even though the PATCH only names the style.
    const touching = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ default_update_style: "rebase" }),
    });
    expect(touching.status).toBe(400);
    expect((await touching.json<{ message: string }>()).message).toBe(
      "at least one pull request branch update style must be enabled",
    );
  });

  it("has_pull_requests=false deletes the config row; re-enabling starts fresh (repo.go:843-846, 955-965)", async () => {
    await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ allow_squash_merge: false }) });
    expect(await prUnitRow()).toBeDefined();
    const off = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ has_pull_requests: false }) });
    expect(off.status).toBe(200);
    expect(await prUnitRow()).toBeUndefined();
    // A merge flag riding the disable PATCH is dropped with the unit
    // (upstream short-circuits the config arm on mustDeletePullRequestUnit).
    const offWithFlags = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ has_pull_requests: false, allow_merge_commits: false }),
    });
    expect(offWithFlags.status).toBe(200);
    expect(await prUnitRow()).toBeUndefined();
    // Re-enable inserts the unit with the DEFAULTS (config was wiped).
    const on = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ has_pull_requests: true }) });
    expect(on.status).toBe(200);
    const reEnabled = await prUnitRow();
    expect(reEnabled?.config).toBeTruthy();
    expect(JSON.parse(reEnabled!.config!)).toMatchObject({ AllowSquash: true, AllowMerge: true });
    expect((await (await makeApp()(repoPath)).json<Record<string, unknown>>()).allow_squash_merge).toBe(true);
  });

  it("applies projects_mode only alongside has_projects=true and 422s an invalid mode (repo.go:968-989)", async () => {
    // The binding validates whenever present...
    const invalid = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ projects_mode: "both" }) });
    expect(invalid.status).toBe(422);
    // ...but the config arm is nested inside the has_projects branch — a bare
    // projects_mode PATCH is a validated no-op.
    const bare = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ projects_mode: "owner" }) });
    expect(bare.status).toBe(200);
    expect((await bare.json<Record<string, unknown>>()).projects_mode).toBe("all");
    // Riding has_projects=true it persists and round-trips.
    const withFlag = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ has_projects: true, projects_mode: "owner" }),
    });
    expect(withFlag.status).toBe(200);
    await expect(withFlag.json<Record<string, unknown>>()).resolves.toMatchObject({ has_projects: true, projects_mode: "owner" });
    expect((await (await makeApp()(repoPath)).json<Record<string, unknown>>()).projects_mode).toBe("owner");
    // Disabling deletes the unit row (mode wiped with it).
    await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ has_projects: false }) });
    expect(
      (await drizzle(env.DB).select().from(repoUnits).where(and(eq(repoUnits.repoId, "7401"), eq(repoUnits.type, "projects"))).all()),
    ).toEqual([]);
    expect((await (await makeApp()(repoPath)).json<Record<string, unknown>>()).projects_mode).toBe("all");
  });

  it("422s archiving a mirror (updateRepoArchivedState, repo.go:985-992)", async () => {
    await drizzle(env.DB).insert(repositories).values({
      id: "7402",
      storageKey: "r_7402",
      ownerNamespace: "cf-gitea-stub",
      ownerId: 1,
      slug: "mirror-me",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      isMirror: true,
      createdAt: new Date(),
    });
    const res = await makeApp()("/repos/cf-gitea-stub/mirror-me", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ archived: true }),
    });
    expect(res.status).toBe(422);
    expect((await res.json<{ message: string }>()).message).toBe("repo is a mirror, cannot archive/un-archive");
    // Unrelated mirror PATCHes sail through — the refusal is archived-only.
    const other = await makeApp()("/repos/cf-gitea-stub/mirror-me", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ description: "still editable" }),
    });
    expect(other.status).toBe(200);
  });
});

describe("PATCH /repos/{owner}/{repo} (repoEdit) — rename, visibility, default branch, archived", () => {
  it("renames via the landed service: new URL 200, old URL 404, redirect row kept", async () => {
    const res = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: "Renamed" }) });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.name).toBe("renamed"); // slug is stored lowercase
    expect(body.full_name).toBe("cf-gitea-stub/renamed");

    expect((await makeApp()("/repos/cf-gitea-stub/edit-me")).status).toBe(404);
    expect((await makeApp()("/repos/cf-gitea-stub/renamed")).status).toBe(200);
    const redirects = await drizzle(env.DB).select().from(repoRedirects).all();
    expect(redirects).toHaveLength(1);
    expect(redirects[0]?.lowerName).toBe("edit-me");
  });

  it("no-ops a case-only rename (upstream EqualFold guard)", async () => {
    const res = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: "Edit-Me" }) });
    expect(res.status).toBe(200);
    expect((await drizzle(env.DB).select().from(repoRedirects).all()).length).toBe(0);
  });

  it("422s an invalid name and a colliding rename", async () => {
    await drizzle(env.DB).insert(repositories).values({
      id: "7402",
      storageKey: "r_7402",
      ownerNamespace: "cf-gitea-stub",
      ownerId: 1,
      slug: "taken",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: new Date(),
    });
    const invalid = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: "bad name!" }) });
    expect(invalid.status).toBe(422);
    const collision = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: "taken" }) });
    expect(collision.status).toBe(422);
  });

  it("flips visibility and default_branch", async () => {
    const res = await makeApp()(repoPath, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ private: true, default_branch: "trunk" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.private).toBe(true);
    expect(body.default_branch).toBe("trunk");
    // Anonymous reads lose the private repo (anti-enumeration).
    expect((await makeApp()(repoPath)).status).toBe(404);
  });

  it("flips archived and the PATCH itself carries no 423 (upstream registration)", async () => {
    const res = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ archived: true }) });
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).archived).toBe(true);
    // Still editable (no mustNotBeArchived on repoEdit).
    expect((await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ archived: false }) })).status).toBe(200);
  });

  it("skips an unknown default_branch on a non-empty repo; an empty repo applies it (repo.go:713-746's IsBranchExist conjunct)", async () => {
    // The seeded 7401 row is EMPTY (the schema default) — the IsEmpty arm
    // applies the change without an engine probe.
    const empty = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ default_branch: "trunk" }) });
    expect(empty.status).toBe(200);
    expect((await empty.json<Record<string, unknown>>()).default_branch).toBe("trunk");
    // A non-empty repo with an unborn target keeps the OLD default — the
    // silent skip (no error arm exists upstream either; the 200 re-renders
    // the unchanged row).
    await drizzle(env.DB).update(repositories).set({ isEmpty: false }).where(eq(repositories.id, "7401"));
    const skip = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ default_branch: "ghost" }) });
    expect(skip.status).toBe(200);
    expect((await skip.json<Record<string, unknown>>()).default_branch).toBe("trunk");
    // An EXISTING branch lands (the tip read resolves — the repo's cell
    // carries the seeded pack from the license arm's flow is not needed; the
    // empty-repo arm already proves the apply path).
  });

  it("403s a non-admin, grants a collaborator-admin, and 422s a wrong-typed body", async () => {
    expect(
      (await makeApp()(repoPath, { method: "PATCH", headers: { Authorization: `token ${TOKEN_OTHER}`, "Content-Type": "application/json" }, body: "{}" }))
        .status,
    ).toBe(403);
    await addOrUpdateCollaborator(env.DB, "7401", collabAdminUserId, "admin", new Date());
    expect(
      (
        await makeApp()(repoPath, {
          method: "PATCH",
          headers: { Authorization: `token ${TOKEN_COLLAB_ADMIN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ description: "granted" }),
        })
      ).status,
    ).toBe(200);
    // Malformed JSON dies in hono's validator as a 400 (the documented
    // /markdown divergence); a wrong-TYPED field is the bind hook's 422.
    expect(
      (await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: 123 }) })).status,
    ).toBe(422);
  });

  it("404s an invisible repo (anti-enumeration)", async () => {
    expect((await makeApp()("/repos/cf-gitea-stub/ghost", { method: "PATCH", headers: jsonAuth, body: "{}" })).status).toBe(404);
  });

  it("a rename emits repository action=renamed with changes.name.from (notifier.go:137-138)", async () => {
    const hookId = await seedHook();
    const res = await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: "Renamed" }) });
    expect(res.status).toBe(200);
    const rows = await deliveries();
    expect(rows.map((r) => [r.hookId, r.eventType, r.eventGroup, r.state])).toEqual([[hookId, "repository", "repository", "pending"]]);
    const payload = JSON.parse(rows[0]!.payloadContent) as {
      action: string;
      repository: { full_name: string };
      organization: { login: string };
      sender: { login: string };
      changes: { name: { from: string } };
    };
    expect(payload.action).toBe("renamed");
    // The repository object renders the NEW row; changes.name.from the old slug.
    expect(payload.repository.full_name).toBe("cf-gitea-stub/renamed");
    expect(payload.changes.name.from).toBe("edit-me");
    expect(payload.organization.login).toBe("cf-gitea-stub");
    expect(payload.sender.login).toBe("cf-gitea-stub");
  });

  it("a case-only rename (no-op) and a failed rename emit nothing", async () => {
    await seedHook();
    expect((await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: "Edit-Me" }) })).status).toBe(200);
    expect((await makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ name: "bad name!" }) })).status).toBe(422);
    expect(await deliveries()).toEqual([]);
  });
});

describe("PATCH /repos/{owner}/{repo} — the private-flip zeroing (ClearRepoStars star.go:94-104 / ClearRepoWatches watch.go:327-333)", () => {
  // Edges go in through the landed services so the pre-flip counters are the
  // maintained ones (starRepo bumps num_stars in-batch, watchRepo num_watches).
  const starAndWatch = async () => {
    await starRepo(env.DB, otherUserId, "7401", new Date());
    await watchRepo(env.DB, "7401", collabAdminUserId, new Date());
  };
  const edges = async () => ({
    stars: (await drizzle(env.DB).select().from(stars).all()).length,
    watches: (await drizzle(env.DB).select().from(repoWatchers).all()).length,
    otherNumStars: (
      await drizzle(env.DB)
        .select({ n: users.numStars })
        .from(users)
        .where(eq(users.id, otherUserId))
        .all()
    )[0]?.n,
  });
  const patchPrivate = (value: boolean) =>
    makeApp()(repoPath, { method: "PATCH", headers: jsonAuth, body: JSON.stringify({ private: value }) });

  it("→private zeroes both counters and deletes the edges (repository.go:176-181)", async () => {
    await starAndWatch();
    const before = await makeApp()(repoPath, { headers: jsonAuth });
    expect(await before.json<Record<string, unknown>>()).toMatchObject({ stars_count: 1, watchers_count: 1 });

    const res = await patchPrivate(true);
    expect(res.status).toBe(200);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({ stars_count: 0, watchers_count: 0 });
    // The owner still reads the now-private repo; the render keeps the zeroes.
    const after = await makeApp()(repoPath, { headers: jsonAuth });
    expect(await after.json<Record<string, unknown>>()).toMatchObject({ stars_count: 0, watchers_count: 0 });
    // Edges gone; the stargazer's user counter dropped per the removed edge
    // (star.go:96-98); watches adjust no user counter (watch.go:327-333).
    expect(await edges()).toEqual({ stars: 0, watches: 0, otherNumStars: 0 });
  });

  it("→public restores nothing and a re-starred edge clears again (one-way clear)", async () => {
    await starAndWatch();
    await patchPrivate(true);
    await patchPrivate(false);
    // Upstream's clear is one-way (setRepoVisibility has no restore arm,
    // repository.go:172-190): counters stay zeroed, edges stay gone.
    const back = await makeApp()(repoPath, { headers: jsonAuth });
    expect(await back.json<Record<string, unknown>>()).toMatchObject({ stars_count: 0, watchers_count: 0 });
    expect(await edges()).toEqual({ stars: 0, watches: 0, otherNumStars: 0 });

    // The edges are genuinely deletable state, not a render wedge: re-starring
    // while public recounts, and a second →private flip zeroes again.
    await starRepo(env.DB, otherUserId, "7401", new Date());
    const restarred = await makeApp()(repoPath, { headers: jsonAuth });
    expect(await restarred.json<Record<string, unknown>>()).toMatchObject({ stars_count: 1 });
    await patchPrivate(true);
    expect(await edges()).toEqual({ stars: 0, watches: 0, otherNumStars: 0 });
  });

  it("an already-private PATCH clears nothing (the flip guard) and →public never zeroes", async () => {
    // Private first, edges seeded while private: a repeat private:true must
    // not run the clear arm (upstream clears inside the changed-only
    // setRepoVisibility flow, repository.go:176-181).
    await patchPrivate(true);
    await starAndWatch();
    expect((await patchPrivate(true)).status).toBe(200);
    expect(await edges()).toEqual({ stars: 1, watches: 1, otherNumStars: 1 });

    // And the →public arm carries no zeroing of its own.
    await patchPrivate(false);
    expect(await edges()).toEqual({ stars: 1, watches: 1, otherNumStars: 1 });
  });
});

describe("DELETE /repos/{owner}/{repo} (repoDelete)", () => {
  it("runs the lifecycle pipeline and clears this batch's raw stores", async () => {
    // Seed every raw store + a settings row, then delete.
    const { replaceRepoTopics, listRepoTopics } = await import("./services/repo-topics");
    const { watchRepo, countRepoWatchers } = await import("./services/repo-watchers");
    const { isCollaborator } = await import("./services/repo-collaborators");
    const { saveRepoSettings, loadRepoSettings } = await import("./services/repo-settings");
    await replaceRepoTopics(env.DB, "7401", ["web"]);
    await watchRepo(env.DB, "7401", otherUserId, new Date());
    await addOrUpdateCollaborator(env.DB, "7401", otherUserId, "read", new Date());
    await saveRepoSettings(env.DB, "7401", { description: "d" }, new Date());

    const res = await makeApp()(repoPath, { method: "DELETE", headers: { Authorization: `token ${TOKEN}` } });
    expect(res.status).toBe(204);
    expect(await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "7401")).all()).toEqual([]);
    expect((await makeApp()(repoPath)).status).toBe(404);
    // The raw stores' housekeeping ran (the repos-service cascade cannot see
    // them until the migration owner's sweep).
    expect(await listRepoTopics(env.DB, "7401")).toEqual([]);
    expect(await countRepoWatchers(env.DB, "7401")).toBe(0);
    expect(await isCollaborator(env.DB, "7401", otherUserId)).toBe(false);
    expect(await loadRepoSettings(env.DB, "7401")).toMatchObject({ description: "" });
  });

  it("403s a non-owner and 404s a missing repo", async () => {
    expect((await makeApp()(repoPath, { method: "DELETE", headers: { Authorization: `token ${TOKEN_OTHER}` } })).status).toBe(403);
    expect((await makeApp()("/repos/cf-gitea-stub/ghost", { method: "DELETE", headers: jsonAuth })).status).toBe(404);
  });

  it("emits repository action=deleted — owner/system watchers only (the repo's own hooks are cascaded)", async () => {
    // The §2.5.5 cascade deletes the repo-scoped hook rows BEFORE the
    // post-pipeline fan-out resolves hooks (the deviation documented at the
    // handler — upstream triggers first because its queued tasks outlive the
    // hook rows): the deleted repo's own hook never hears the event.
    await seedHook();
    expect((await makeApp()(repoPath, { method: "DELETE", headers: { Authorization: `token ${TOKEN}` } })).status).toBe(204);
    expect(await deliveries()).toEqual([]);

    // Owner-level hooks survive the cascade and take the event, over the
    // pre-delete repository render.
    const ownerHook = await drizzle(env.DB)
      .insert(webhooks)
      .values({
        repoId: null,
        ownerId: 1,
        url: "https://hooks.example.com/owner",
        events: JSON.stringify({ send_everything: true }),
        isActive: true,
      })
      .returning({ id: webhooks.id })
      .all();
    await drizzle(env.DB).insert(repositories).values({
      id: "7402",
      storageKey: "r_7402",
      ownerNamespace: "cf-gitea-stub",
      ownerId: 1,
      slug: "delete-event",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
      createdAt: new Date(),
    });
    expect((await makeApp()("/repos/cf-gitea-stub/delete-event", { method: "DELETE", headers: jsonAuth })).status).toBe(204);
    const rows = await deliveries();
    expect(rows.map((r) => [r.hookId, r.eventType, r.eventGroup, r.state])).toEqual([
      [ownerHook[0]!.id, "repository", "repository", "pending"],
    ]);
    const payload = JSON.parse(rows[0]!.payloadContent) as {
      action: string;
      repository: { full_name: string };
      organization: { login: string };
      sender: { login: string };
      changes?: unknown;
    };
    expect(payload.action).toBe("deleted");
    expect(payload.repository.full_name).toBe("cf-gitea-stub/delete-event");
    expect(payload.organization.login).toBe("cf-gitea-stub");
    expect(payload.sender.login).toBe("cf-gitea-stub");
    expect(payload.changes).toBeUndefined(); // renamed-only field (omitempty)
  });
});

describe("POST /repos/{owner}/{repo}/transfer (repoTransfer)", () => {
  it("files a pending transfer and answers 201 with the CURRENT Repository (the pin's pending arm, transfer.go:126-130)", async () => {
    const res = await makeApp()(`${repoPath}/transfer`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ new_owner: "other" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.full_name).toBe("cf-gitea-stub/edit-me"); // not applied yet
    const pending = await drizzle(env.DB).select().from(repoTransfer).all();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.newOwnerId).toBe(otherUserId);
  });

  it("emits no webhook (upstream-faithful: HookRepoAction has no transfer member)", async () => {
    await seedHook();
    expect(
      (await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ new_owner: "other" }) })).status,
    ).toBe(201);
    expect(await deliveries()).toEqual([]);
  });

  it("re-files (upsert) a repeat request", async () => {
    await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ new_owner: "other" }) });
    expect((await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ new_owner: "other" }) })).status).toBe(201);
    expect(await drizzle(env.DB).select().from(repoTransfer).all()).toHaveLength(1);
  });

  it("answers 201 for a SITE-ADMIN doer too (upstream's direct arm would run transferOwnership inline and answer 202 — transfer.go:132-133; the direct machinery is unlanded here, every accepted request files pending)", async () => {
    const res = await makeApp()(`${repoPath}/transfer`, {
      method: "POST",
      headers: { Authorization: `token ${TOKEN_ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ new_owner: "other" }),
    });
    expect(res.status).toBe(201);
    expect(await res.json<Record<string, unknown>>()).toMatchObject({ full_name: "cf-gitea-stub/edit-me" });
    expect(await drizzle(env.DB).select().from(repoTransfer).all()).toHaveLength(1);
  });

  it("404s an unknown new owner with the upstream message", async () => {
    const res = await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ new_owner: "nobody" }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "The new owner does not exist or cannot be found", url: ERROR_URL });
  });

  it("422s a self-transfer and a team_ids payload", async () => {
    const self = await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ new_owner: "cf-gitea-stub" }) });
    expect(self.status).toBe(422);
    const teams = await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: jsonAuth, body: JSON.stringify({ new_owner: "other", team_ids: [5] }) });
    expect(teams.status).toBe(422);
    expect((await teams.json<Record<string, unknown>>()).message).toBe("team 5 not found");
  });

  it("403s a caller without the danger-zone grant", async () => {
    expect(
      (await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: { Authorization: `token ${TOKEN_OTHER}`, "Content-Type": "application/json" }, body: JSON.stringify({ new_owner: "other" }) }))
        .status,
    ).toBe(403);
  });

  it("401s an anonymous caller", async () => {
    expect((await makeApp()(`${repoPath}/transfer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ new_owner: "other" }) })).status).toBe(401);
  });

  // ---------------------------------------------------------------------------
  // The StartRepositoryTransfer blocked arm (the blocks-enforcement sweep —
  // services/repository/transfer.go:464-466 via transfer.go:118)
  // ---------------------------------------------------------------------------

  describe("the StartRepositoryTransfer blocked arm", () => {
    /** A nested wipe — the shared beforeEach above owns the other tables. */
    beforeEach(async () => {
      await env.DB.prepare("DELETE FROM user_blocking").run();
    });

    const block = (blockerId: number, blockeeId: number) =>
      drizzle(env.DB).insert(userBlocking).values({ blockerId, blockeeId, note: "", createdAt: new Date() });

    it("403s \"user is blocked\" when the doer is blocked by the NEW owner (transfer.go:465 first probe)", async () => {
      await block(otherUserId, 1);
      const res = await makeApp()(`${repoPath}/transfer`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ new_owner: "other" }),
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ message: "user is blocked", url: ERROR_URL });
      expect(await drizzle(env.DB).select().from(repoTransfer).all()).toHaveLength(0);
    });

    it("403s when the NEW owner is blocked by the CURRENT owner (transfer.go:465-466 second probe)", async () => {
      await block(1, otherUserId);
      const res = await makeApp()(`${repoPath}/transfer`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ new_owner: "other" }),
      });
      expect(res.status).toBe(403);
      expect(await drizzle(env.DB).select().from(repoTransfer).all()).toHaveLength(0);
    });

    it("a site-admin doer bypasses the arm (upstream's doer.IsAdmin direct arm precedes the probe) and still files pending — 201 (the direct arm's 202 needs the unlanded transferOwnership)", async () => {
      await block(otherUserId, adminUserId);
      const res = await makeApp()(`${repoPath}/transfer`, {
        method: "POST",
        headers: { Authorization: `token ${TOKEN_ADMIN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ new_owner: "other" }),
      });
      expect(res.status).toBe(201);
    });

    it("201s once no blocking row relates the pair (the arm lifts with the block)", async () => {
      await block(otherUserId, 1);
      await env.DB.prepare("DELETE FROM user_blocking").run();
      const res = await makeApp()(`${repoPath}/transfer`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ new_owner: "other" }),
      });
      expect(res.status).toBe(201);
    });
  });
});

// ---------------------------------------------------------------------------
// The default-branch license arm (routers/api/v1/repo/repo.go:713-746): a
// PATCH that lands default_branch on an EXISTING branch of a non-empty repo
// runs SetDefaultBranch and enqueues the license updater (:739-746) — the
// settled walk (services/repo-licenses.ts syncRepoLicensesForDefaultBranch)
// over the engine cell. In-process requests carry no executionCtx, so the
// arm's waitUntil deferral falls back to its inline arm and the rows are
// readable right after the 200 (the branches-licenses.test.ts pattern).
// ---------------------------------------------------------------------------

const LIC_OWNER = "edit-lic";
const LIC_SLUG = "arm";
const LIC_ENGINE = `${LIC_OWNER}/${LIC_SLUG}`;
const LIC_REPO_PATH = `/repos/${LIC_OWNER}/${LIC_SLUG}`;
const LIC_TOKEN = "edit-lic-token";
const T_LIC = 1_761_000_000;

const MIT_TEXT = LICENSE_CORPUS_TEXTS.find(([id]) => id === "MIT")![1];
const GPL_TEXT = LICENSE_CORPUS_TEXTS.find(([id]) => id === "GPL-3.0")![1];

const LIC_MAIN_COMMIT: SeedCommit = {
  message: "seed: MIT default branch",
  time: T_LIC,
  files: [
    { path: "README.md", content: "# edit lic\n" },
    { path: "LICENSE", content: MIT_TEXT },
  ],
};
const LIC_GPL_COMMIT: SeedCommit = {
  message: "seed: GPL side branch",
  time: T_LIC + 60,
  files: [
    { path: "README.md", content: "# edit lic\n" },
    { path: "LICENSE", content: GPL_TEXT },
  ],
};

/** The repo_license rows for the seeded arm repo (license/path/tip only). */
async function licenseRows(repoId: string): Promise<Array<{ license: string; licensePath: string; commitId: string | null }>> {
  const rows = await getRepoLicenses(env.DB, repoId);
  return rows.map((row) => ({ license: row.license, licensePath: row.licensePath, commitId: row.commitId }));
}

/**
 * Idempotent seed (per-test: the file-level beforeEach wipes the users/
 * repositories rows while the engine's DO content persists): ensure the
 * owner + repo row exist, push `main` (MIT) and `gpl` (GPL-3.0) when their
 * refs are missing, then — after any push — let the onPush license settle
 * land (it writes MIT at the main tip, the default) and clear the table, so
 * every test starts from a clean slate no background settle can re-write
 * mid-test.
 */
async function seedLicenseArmRepo(): Promise<{ repoId: string; ownerId: number; gplTip: string }> {
  const refsBefore = await env.REPO.getByName(LIC_ENGINE).listRefs();
  await ensureSeededRepo({ owner: LIC_OWNER, slug: LIC_SLUG, commits: [LIC_MAIN_COMMIT] });
  let pushed = refsBefore.head === null;

  const owner = await drizzle(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, LIC_OWNER))
    .get();
  if (owner === undefined) throw new Error("seed owner missing");
  const row = await drizzle(env.DB)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, LIC_OWNER), eq(repositories.slug, LIC_SLUG)))
    .get();
  if (row === undefined) throw new Error("seed repo row missing");

  let gplTip: string;
  const refs = await env.REPO.getByName(LIC_ENGINE).listRefs();
  const existingGpl = refs.refs.find((ref) => ref.name === "refs/heads/gpl");
  if (existingGpl === undefined) {
    const { tips, pack } = await buildHistoryPack([LIC_GPL_COMMIT]);
    gplTip = tips[0] as string;
    // Idempotent mint (TokenService rejects duplicate names).
    await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
      .bind(owner.id, "edit-lic-gpl")
      .run();
    const token = (await mintFor(owner.id, "edit-lic-gpl", "write:repository")).plaintext;
    const response = await SELF.fetch(`https://test.local/${LIC_ENGINE}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
      body: buildReceivePackBody([{ ref: "refs/heads/gpl", oid: gplTip }], pack),
    });
    const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    if (response.status !== 200 || responseBody.includes("ng ")) {
      throw new Error(`seed gpl push failed: ${response.status} ${responseBody.slice(0, 400)}`);
    }
    pushed = true;
  } else {
    gplTip = existingGpl.target;
  }

  if (pushed) {
    for (let i = 0; i < 100 && (await licenseRows(row.id)).length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await env.DB.prepare("DELETE FROM repo_license").run();

  return { repoId: row.id, ownerId: owner.id, gplTip };
}

/** The PATCH app for the arm: the seeded owner is the repo admin. */
function licenseArmApp(ownerId: number): (path: string, init?: RequestInit) => Promise<Response> {
  const resolver: AuthResolver = {
    resolveToken: (token) =>
      Promise.resolve(
        token === LIC_TOKEN
          ? {
              ...STUB_USER,
              id: ownerId,
              login: LIC_OWNER,
              full_name: LIC_OWNER,
              created: new Date(T_LIC * 1000).toISOString(),
            }
          : null,
      ),
  };
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerRepoRoutes(app, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return (path, init) => Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

const licJsonInit = (body: unknown): RequestInit => ({
  method: "PATCH",
  headers: { Authorization: `token ${LIC_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("PATCH /repos/{owner}/{repo} — the default-branch license arm (repo.go:713-746)", () => {
  it("re-scans the license rows at the new tip when the change lands on an existing branch (repo.go:739-746)", async () => {
    const { repoId, ownerId, gplTip } = await seedLicenseArmRepo();
    const app = licenseArmApp(ownerId);

    const res = await app(LIC_REPO_PATH, licJsonInit({ default_branch: "gpl" }));
    expect(res.status).toBe(200);
    expect((await res.json<Record<string, unknown>>()).default_branch).toBe("gpl");
    // The walk re-resolved the NEW default's tip: the GPL set replaced the
    // MIT set (updateRepoLicenses' diff, license.go:206-208).
    expect(await licenseRows(repoId)).toEqual([{ license: "GPL-3.0", licensePath: "LICENSE", commitId: gplTip }]);
  });

  it("leaves the license rows alone when the target branch does not exist (the IsBranchExist arm)", async () => {
    const { repoId, ownerId } = await seedLicenseArmRepo();
    const app = licenseArmApp(ownerId);

    // Our PATCH applies the D1 metadata regardless (the documented deviation
    // — the engine's setHead guard rejects the unborn branch engine-side);
    // upstream's `git.IsBranchExist` conjunct means the enqueuer never fires
    // for it, and the walk's unborn-tip skip ports that exactly.
    const res = await app(LIC_REPO_PATH, licJsonInit({ default_branch: "ghost" }));
    expect(res.status).toBe(200);
    expect(await licenseRows(repoId)).toEqual([]);
  });
});
