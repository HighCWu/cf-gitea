/**
 * The B-56 approve-all-checks arm's route suite (ui/index.ts
 * actionsApproveAllChecks — web.go:1572's `m.Post("/approve-all-checks",
 * reqRepoActionsWriter, actions.ApproveAllChecks)` inside the /actions
 * group, view.go:1284-1316 at the pin), driven over the mounted uiRouter on
 * the release-tails matrix harness pattern (per-test D1 wipe + minted
 * sessions).
 *
 * Pins:
 *   - the parser claim (the exact 1-segment literal; deeper tails unclaimed;
 *     the GET twin at chi's 405);
 *   - the gate ladder (optSignIn's group: anonymous 404s — NEVER the login
 *     303; non-writer 404s; actions-disabled 404s; the empty repo 404s —
 *     MustBeNotEmpty);
 *   - the JSONOK dummy with NO statuses ({"ok":true} — view.go:1303-1305);
 *   - the awaiting subset approved through the LANDED approve service: the
 *     statuses' Actions target URLs name the runs (GetRunsFromCommitStatuses'
 *     parse — commit_status.go:245-264), the needApproval flag flips and the
 *     approver lands (approve.go:39-43), the done-status run skips
 *     (IsAwaitingApproval's silent continue — approve.go:47-49), and the
 *     foreign-repo status rows never parse (the owner/slug cut);
 *   - the flash arm's documented reduction (no session flash — no consumer
 *     upstream at this pin: grep over web_src/templates is empty).
 *
 * The status rows seed straight into commit_statuses with the writer's
 * targetUrl shapes (services/actions/trigger.ts: the repo-scoped
 * /actions/runs/{id}/jobs/{id} tail, relative AND origin-prefixed).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { actionRunAttempts, actionRunJobs, actionRuns, commitStatuses, repoSettings, repositories } from "../../db/schema";
import { ACTION_STATUS_SUCCESS, ACTION_STATUS_WAITING, insertActionRun } from "../../services/actions/model";
import { saveRepoSettings } from "../../api/services/repo-settings";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";

// --- the minted-session route harness (the release-tails matrix pattern) -------

const ORIGIN = "https://test.local";
const SHA = "ccccdddddddddddddddddddddddddddddddddddd";
const PAYLOAD = new TextEncoder().encode("jobs: {}\n");
const T0 = new Date(1_700_000_000 * 1000);

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

async function postForm(path: string, cookie: string | null, fields: Record<string, string>): Promise<Response> {
  return fetchUi(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      ...(cookie === null ? {} : { cookie }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

// --- fixtures ------------------------------------------------------------------

interface Fixture {
  ownerId: number;
  strangerId: number;
  ownerCookie: string;
  strangerCookie: string;
  repoId: string;
}

let fixture: Fixture | null = null;

async function seedFixture(): Promise<Fixture> {
  const owner = await seedVerifiedUser({ username: "aac-owner" });
  const stranger = await seedVerifiedUser({ username: "aac-stranger" });
  await drizzle(env.DB).insert(repositories).values({
    id: "repo-aac",
    storageKey: "r_aac",
    ownerNamespace: "aac-owner",
    ownerId: owner.id,
    slug: "demo",
    defaultBranch: "main",
    visibility: "public",
    isEmpty: false,
    createdAt: T0,
  });
  await saveRepoSettings(env.DB, "repo-aac", { hasActions: true }, T0);
  return {
    ownerId: owner.id,
    strangerId: stranger.id,
    ownerCookie: await sessionHeader(owner.id),
    strangerCookie: await sessionHeader(stranger.id),
    repoId: "repo-aac",
  };
}

async function theFixture(): Promise<Fixture> {
  if (fixture === null) fixture = await seedFixture();
  return fixture;
}

/** One run through the M1a staged insert; `needApproval` forces the fork-PR
 *  posture, `done` parks the run (and its attempt + jobs) on SUCCESS. */
async function seedRun(index: number, opts: { needApproval?: boolean; done?: boolean } = {}): Promise<number> {
  const { run, attempt, jobRows } = await insertActionRun(
    env.DB,
    {
      repoId: "repo-aac",
      ownerId: (await theFixture()).ownerId,
      workflowId: ".github/workflows/ci.yml",
      index,
      triggerUserId: (await theFixture()).ownerId,
      ref: "refs/heads/main",
      commitSha: SHA,
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
    },
    [{ jobId: "build", workflowPayload: PAYLOAD }],
  );
  if (opts.needApproval === true) {
    await drizzle(env.DB).update(actionRuns).set({ needApproval: true }).where(eq(actionRuns.id, run.id));
  }
  if (opts.done === true) {
    await drizzle(env.DB).update(actionRuns).set({ status: ACTION_STATUS_SUCCESS }).where(eq(actionRuns.id, run.id));
    await drizzle(env.DB).update(actionRunAttempts).set({ status: ACTION_STATUS_SUCCESS }).where(eq(actionRunAttempts.id, attempt.id));
    await drizzle(env.DB).update(actionRunJobs).set({ status: ACTION_STATUS_SUCCESS }).where(eq(actionRunJobs.id, jobRows[0]!.id));
  }
  return run.id;
}

/** One latest-per-context status row naming a run (the Actions writer's
 *  targetUrl shapes); `index` is the per-(repo, sha) ordinal — the UNIQUE
 *  key rides it, so callers pass distinct values. */
let statusIndex = 0;
async function seedStatus(runId: number, targetUrl: string, context = "ci/build"): Promise<void> {
  statusIndex += 1;
  await drizzle(env.DB).insert(commitStatuses).values({
    repoId: "repo-aac",
    sha: SHA,
    index: statusIndex,
    targetUrl,
    description: "In progress",
    context,
    state: "pending",
    creatorId: (await theFixture()).ownerId,
    createdAt: T0,
    updatedAt: T0,
  });
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  fixture = null;
  // FK order: leaf rows first (status rows carry no outbound FKs).
  for (const table of [
    "commit_statuses",
    "action_run_jobs",
    "action_run_attempts",
    "action_runs",
    "action_tasks",
    "action_tasks_versions",
    "repo_settings",
    "repo_units",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the parser claim ------------------------------------------------------------

describe("the approve-all-checks route claim", () => {
  it("claims the exact 1-segment literal; deeper tails and the badge siblings stay unclaimed", () => {
    expect(parseUiRoute("/octo/hello/actions/approve-all-checks")).toEqual({
      family: "actions-approve-all-checks",
      owner: "octo",
      repo: "hello",
    });
    expect(parseUiRoute("/octo/hello/actions/approve-all-checks/x")).toBeNull();
    expect(parseUiRoute("/octo/hello/actions/approve-all-check")).toBeNull();
    expect(handlesUiRoute("/octo/hello/actions/approve-all-checks")).toBe(true);
    expect(handlesUiRoute("/octo/hello/actions/approve-all-checks/x")).toBe(false);
  });

  it("mounts the GET twin at chi's 405 (POST-only upstream)", async () => {
    expect((await fetchUi("/aac-owner/demo/actions/approve-all-checks")).status).toBe(405);
  });
});

// --- the gate ladder -------------------------------------------------------------

describe("the approve-all-checks gate ladder", () => {
  it("404s anonymous and non-writers (optSignIn's group — NO login 303; reqRepoActionsWriter's NotFound)", async () => {
    await theFixture();
    // Anonymous: the actions group is optSignIn (web.go:1569-1571) — the
    // writer gate 404-shells, it never 303s onto login.
    const anonymous = await postForm("/aac-owner/demo/actions/approve-all-checks", null, { commit_id: SHA });
    expect(anonymous.status).toBe(404);
    // A signed non-writer: the same NotFound.
    const stranger = await postForm("/aac-owner/demo/actions/approve-all-checks", (await theFixture()).strangerCookie, {
      commit_id: SHA,
    });
    expect(stranger.status).toBe(404);
  });

  it("404-shells the actions-disabled repo and the empty repo", async () => {
    const { ownerCookie } = await theFixture();
    // MustEnableActions' repo-unit arm (the landed hasActions settings bit).
    await drizzle(env.DB).update(repoSettings).set({ hasActions: false }).where(eq(repoSettings.repoId, "repo-aac"));
    expect(
      (await postForm("/aac-owner/demo/actions/approve-all-checks", ownerCookie, { commit_id: SHA })).status,
    ).toBe(404);
    await drizzle(env.DB).update(repoSettings).set({ hasActions: true }).where(eq(repoSettings.repoId, "repo-aac"));
    // repo.MustBeNotEmpty (web.go:1571's group middleware).
    await drizzle(env.DB).update(repositories).set({ isEmpty: true }).where(eq(repositories.id, "repo-aac"));
    expect(
      (await postForm("/aac-owner/demo/actions/approve-all-checks", ownerCookie, { commit_id: SHA })).status,
    ).toBe(404);
  });
});

// --- the handler arms ------------------------------------------------------------

describe("the approve-all-checks handler (view.go:1284-1316)", () => {
  it("answers the JSONOK dummy when no status names a run (the empty arm, view.go:1303-1305)", async () => {
    const { ownerCookie } = await theFixture();
    // No status rows at all.
    const res = await postForm("/aac-owner/demo/actions/approve-all-checks", ownerCookie, { commit_id: SHA });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await res.json()).toStrictEqual({ ok: true });
    // A non-Actions target URL parses to nothing (the cut-prefix miss).
    await seedStatus(0, `${ORIGIN}/aac-owner/demo/commits/${SHA}`);
    expect(
      (await postForm("/aac-owner/demo/actions/approve-all-checks", ownerCookie, { commit_id: SHA })).status,
    ).toBe(200);
  });

  it("approves every awaiting-approval run the statuses name (flag flip + approver) and answers JSONOK", async () => {
    const { ownerCookie, ownerId } = await theFixture();
    const runA = await seedRun(1, { needApproval: true });
    const runB = await seedRun(2, { needApproval: true });
    // A done run at the same commit: IsAwaitingApproval's silent skip.
    await seedRun(3, { done: true });
    // The writer's two targetUrl shapes: the relative repo.Link() tail
    // (upstream's own writer) and the origin-prefixed absolute (the landed
    // trigger/dispatch writers).
    await seedStatus(runA, `/aac-owner/demo/actions/runs/${runA}/jobs/1`);
    await seedStatus(runB, `${ORIGIN}/aac-owner/demo/actions/runs/${runB}/jobs/2`, "ci/deploy");

    const res = await postForm("/aac-owner/demo/actions/approve-all-checks", ownerCookie, { commit_id: SHA });
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ ok: true });

    const runs = await drizzle(env.DB).select().from(actionRuns).all();
    const byId = new Map(runs.map((row) => [row.id, row]));
    expect(byId.get(runA)!.needApproval).toBe(false);
    expect(byId.get(runA)!.approvedBy).toBe(ownerId);
    expect(byId.get(runB)!.needApproval).toBe(false);
    expect(byId.get(runB)!.approvedBy).toBe(ownerId);
    // The done run skipped silently (approve.go:47-49) — untouched columns.
    const runs3 = runs.filter((row) => row.index === 3);
    expect(runs3.length).toBe(1);
    expect(runs3[0]!.needApproval).toBe(false); // the insert default, never flipped
    expect(runs3[0]!.approvedBy).toBe(0); // the insert default (ApprovedBy 0), never written
    // The blocked jobs released to WAITING (the v1-stage approve's release
    // walk) for the awaiting runs.
    const jobs = await drizzle(env.DB).select().from(actionRunJobs).all();
    expect(
      jobs
        .filter((job) => job.runId === runA || job.runId === runB)
        .every((job) => job.status === ACTION_STATUS_WAITING),
    ).toBe(true);
  });

  it("scopes the parse to the repo (a foreign repo's Actions URL never names a local run)", async () => {
    const { ownerCookie } = await theFixture();
    const runId = await seedRun(1, { needApproval: true });
    // A foreign repo's tail (the owner/slug cut fails → not our link).
    await seedStatus(runId, `/someone-else/other/actions/runs/${runId}/jobs/1`, "ci/foreign");
    const res = await postForm("/aac-owner/demo/actions/approve-all-checks", ownerCookie, { commit_id: SHA });
    expect(res.status).toBe(200);
    // The run stays awaiting (the empty runIds arm answered before the walk).
    const row = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)))[0]!;
    expect(row.needApproval).toBe(true);
    // The junk-segment shapes also parse to nothing (ParseInt's failure arms).
    await seedStatus(runId, `/aac-owner/demo/actions/runs/notanumber/jobs/1`, "ci/junk");
    expect(
      (await postForm("/aac-owner/demo/actions/approve-all-checks", ownerCookie, { commit_id: SHA })).status,
    ).toBe(200);
    expect((await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)))[0]!.needApproval).toBe(true);
  });

  it("merges the query into commit_id (ctx.FormString's body-then-query form)", async () => {
    const { ownerCookie } = await theFixture();
    const runId = await seedRun(1, { needApproval: true });
    await seedStatus(runId, `/aac-owner/demo/actions/runs/${runId}/jobs/1`);
    const context = createExecutionContext();
    const response = await uiRouter.fetch(
      new Request(`${ORIGIN}/aac-owner/demo/actions/approve-all-checks?commit_id=${SHA}`, {
        method: "POST",
        headers: { origin: ORIGIN, cookie: ownerCookie },
      }),
      routeEnv,
      context,
    );
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    expect((await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, runId)))[0]!.needApproval).toBe(false);
  });
});
