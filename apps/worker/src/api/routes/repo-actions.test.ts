/**
 * The repo-level Actions extras (routes/repo-actions.ts — the board's P1-9
 * row) on real D1 + the real engine: all 8 contract ops over the
 * standalone-mount convention (the routes register in router.ts by the
 * orchestrator after this batch — the file header's HANDOFF).
 *
 * Per-op pins, upstream-exact at fc493688:
 *   - ActionsListRepositoryWorkflows (action.go:859-896): the ActionWorkflow
 *     wire (yaml name, state over the ActionsConfig list, the commit-author
 *     timestamps, the url/html_url/badge_url shapes, Go-zero deleted_at),
 *     the first-existing-dir walk (the .github/workflows fallback repo), the
 *     no-workflow-dir 200/0 arm (workflows.go:92-95), the 401/403 gates.
 *   - ActionsGetWorkflow (action.go:898-930): 200 shape + the 404
 *     `workflow "x" not found` text (APIErrorAuto's ErrorUnwrapForUser).
 *   - ActionsListWorkflowRuns (action.go:932-1036): the run wire
 *     (ActionWorkflowRun, convert.go:276-348 — explicit-null
 *     previous_attempt_url, queued/completed+conclusion statuses, actor /
 *     repository renders, pull_requests []), the no-runs git-lookup
 *     fallthrough (404 when the file is gone), the filter ladder
 *     (status/actor/branch/event/head_sha, the 400 invalid-status and the
 *     404 user-not-exist texts, shared/action.go:100-123 + :151-163) and the
 *     pagination headers.
 *   - ActionsDisableWorkflow / ActionsEnableWorkflow (action.go:1038-1104
 *     + workflow.go:30-52): the 204s, the store readback through the LANDED
 *     ActionsConfig (append-if-absent / SliceRemoveAll, no duplicate on
 *     re-disable), the state flip on the workflow wire, the 404s.
 *   - ActionsDispatchWorkflow (action.go:1106-1178 + workflow.go:64-190):
 *     the 204 / return_run_details 200 RunDetails, the run row (waiting,
 *     workflow_dispatch, the resolved full ref, the commit-subject title),
 *     the job rows from the YAML (runs-on), the inputs merge (defaults,
 *     provided values, the boolean coercion), the 422 ladder (Ref: Required
 *     binder text, has-no-workflow_dispatch, invalid workflow), the 404s
 *     (ref miss, workflow miss, the scoped effective-source gate), the 403
 *     disabled check ordering.
 *   - THE SCOPED DISPATCH TWIN (the v1.5.4 K14 wave — action.go:1120-1123's
 *     query param + workflow.go:237-268's scoped arm): a non-empty
 *     scoped_workflow_source_repo_id (the TEXT source id verbatim, ""/"0" =
 *     repo-level — the WEB arm's recorded adaptation) dispatches the SOURCE
 *     repo's default-branch .gitea/scoped_workflows content: the effective-
 *     source gate 404s a non-registered id, the validation ladder runs over
 *     the SOURCE content, the inputs merge reads the SOURCE declarations,
 *     and the run records the content-source parity columns
 *     (is_scoped_run/workflow_repo_id/workflow_commit_sha — the SOURCE sha
 *     beside the consumer ref's commit_sha). The scoped opt-out (the
 *     WEB-side toggle's store) 403s the dispatch; a REQUIRED workflow
 *     ignores the opt-out (workflow.go:89-92's conjunction).
 *   - THE API TOGGLE'S SCOPED ABSENCE (the pin's decision — LAND NOTHING):
 *     upstream's enable/disable swagger declares owner/repo/workflow_id
 *     only (action.go:1047-1084/:1194-1230) and the handlers never read the
 *     param (:1081/:1230 — the scoped mutators are the WEB handler's
 *     view.go:1338-1361 branch); the API toggle ignores a passed param —
 *     the CONSUMER's repo-level workflow flips, the scoped opt-out map
 *     stays untouched, and a REQUIRED scoped registration refuses nothing
 *     on the API (the web-only JSONError never arms here).
 *   - getWorkflowJob (action.go:1702-1752): the ActionWorkflowJob wire
 *     (convert.go:545-590), the repo-mismatch 404 "not found", the junk-id
 *     404.
 *   - downloadActionsRunJobLogs (actions_run.go:15-51 + common/actions.go:
 *     98-132): the 200 attachment (text/plain; charset=utf-8, the
 *     FileNameJoinFields filename, the chunk bytes verbatim, the sealed-R2
 *     arm), the 404 ladder (repo-miss text, job not started, logs expired).
 *   - The audit arms (v1.5.4 — RecordWorkflowToggle, workflow.go:49; the
 *     dispatch's RecordAs tail, workflow.go:192-193, both through
 *     services/actions/audit-arms.ts): each successful write emits its row —
 *     origin "api", the requester as actor, the "access-token:<id>"
 *     credential (the rig's resolveAuth stand-in carries the token row), the
 *     RAW ref + numeric run_id in the dispatch metadata; a failed write
 *     emits nothing.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { MiddlewareHandler } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { ensureSeededRepo, type SeedCommit } from "../../ui/testing/seed-repo";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import {
  actionLogChunks,
  actionRunAttempts,
  actionRunJobs,
  actionRuns,
  actionTasks,
  auditEvents,
  repoCounters,
  repoSettings,
  repoUnits,
  users,
} from "../../db/schema";
import { insertActionRun } from "../../services/actions/model";
import { loadRepoActionsConfig, toggleRepoActionsWorkflow } from "../../services/actions/config";
import { scopedWorkflowSourcesStore } from "../../services/actions/scoped-workflow-sources";
import { createTokenAuthMiddleware, extractTokenHeader, STUB_USER, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerRepoActionsRoutes } from "./repo-actions";

const T0 = 1_770_000_000;

const CI_YML = `name: CI
on:
  push:
  workflow_dispatch:
    inputs:
      greeting:
        description: "The greeting"
        default: "hello"
      flag:
        description: "A flag"
        type: boolean
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

const NOTIFY_YML = `name: Notify
on:
  push:
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: echo notify
`;

// Unparseable YAML — the list renders the FILE name (the parse-fail arm,
// convert.go:633-635); the dispatch answers the invalid-workflow 422.
const BROKEN_YML = `: : {
  jobs: [[[
`;

const SUITE_COMMITS: SeedCommit[] = [
  {
    message: "seed: workflows",
    time: T0,
    files: [
      { path: "README.md", content: "# actions suite\n" },
      { path: ".gitea/workflows/ci.yml", content: CI_YML },
      { path: ".gitea/workflows/notify.yml", content: NOTIFY_YML },
      { path: ".gitea/workflows/broken.yml", content: BROKEN_YML },
    ],
  },
  {
    message: "seed: docs",
    time: T0 + 60,
    files: [
      { path: "README.md", content: "# actions suite\n" },
      { path: ".gitea/workflows/ci.yml", content: CI_YML },
      { path: ".gitea/workflows/notify.yml", content: NOTIFY_YML },
      { path: ".gitea/workflows/broken.yml", content: BROKEN_YML },
      { path: "docs/x.txt", content: "docs\n" },
    ],
  },
];

// The scoped twin's SOURCE repo: the SCOPED_WORKFLOW_DIRS walk (.gitea/
// scoped_workflows — services/actions/scoped-workflows.ts's default) with a
// dispatchable ci.yml whose inputs differ from the CONSUMER's ci.yml (the
// content-source proof), a push-only file (the has-no-dispatch 422 arm over
// the SOURCE content) and a broken file (the invalid 422 arm).
const SCOPED_CI_YML = `name: ScopedCI
on:
  workflow_dispatch:
    inputs:
      note:
        description: "The note"
        default: "from-source"
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo scoped
`;

const SCOPED_SOURCE_COMMITS: SeedCommit[] = [
  {
    message: "seed: scoped workflows",
    time: T0 + 90,
    files: [
      { path: "README.md", content: "# scoped source\n" },
      { path: ".gitea/scoped_workflows/ci.yml", content: SCOPED_CI_YML },
      { path: ".gitea/scoped_workflows/push-only.yml", content: NOTIFY_YML },
      { path: ".gitea/scoped_workflows/broken.yml", content: BROKEN_YML },
    ],
  },
];

const FALLBACK_COMMIT: SeedCommit = {
  message: "seed: github workflows dir",
  time: T0 + 30,
  files: [
    { path: "README.md", content: "# fallback\n" },
    { path: ".github/workflows/deploy.yml", content: "name: Deploy\non: push\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo deploy\n" },
  ],
};

const EMPTY_COMMIT: SeedCommit = {
  message: "seed: no workflows",
  time: T0 + 45,
  files: [{ path: "README.md", content: "# empty\n" }],
};

const OWNER = "alice";

let ALICE_ID = 0;
let BOB_ID = 0;
let ADMIN_ID = 0;
let SUITE_REPO_ID = "";
let EMPTY_REPO_ID = "";
let TIP_MAIN = "";
/** The scoped twin's SOURCE repo (the TEXT repositories.id the dispatch
 *  param carries verbatim — the schema's own TEXT adaptation) + its default
 *  branch HEAD (the workflow_commit_sha parity column's value). */
let SOURCE_REPO_ID = "";
let SOURCE_TIP = "";
const ORIGIN = "https://example.com";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyAuthD1Migrations();

  const seeded = await ensureSeededRepo({ owner: OWNER, slug: "actions-suite", commits: SUITE_COMMITS, tags: [{ name: "v1", commitIndex: 1 }] });
  TIP_MAIN = seeded.tips[1] as string;
  await ensureSeededRepo({ owner: OWNER, slug: "actions-fallback", commits: [FALLBACK_COMMIT] });
  await ensureSeededRepo({ owner: OWNER, slug: "actions-empty", commits: [EMPTY_COMMIT] });
  const scopedSource = await ensureSeededRepo({ owner: OWNER, slug: "scoped-source", commits: SCOPED_SOURCE_COMMITS });
  SOURCE_TIP = scopedSource.tips[0] as string;

  const bob = await seedVerifiedUser({ username: "bob" });
  const admin = await seedVerifiedUser({ username: "act-admin", isAdmin: true });
  BOB_ID = bob.id;
  ADMIN_ID = admin.id;

  const db = drizzle(env.DB);
  const suiteRow = await db.select().from((await import("../../db/schema")).repositories).where(eq((await import("../../db/schema")).repositories.slug, "actions-suite")).get();
  if (suiteRow === undefined) throw new Error("suite repo row missing");
  SUITE_REPO_ID = suiteRow.id;
  const ownerRow = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get();
  if (ownerRow === undefined) throw new Error("owner row missing");
  ALICE_ID = ownerRow.id;

  // The actions-unit posture: the settings row arms the reader/writer gates
  // (loadRepoSettings.hasActions); the unit row is the ActionsConfig store's
  // write home (saveRepoActionsConfig's COLS("config") update). The push-
  // create settle seeds the settings row with the default-units flip's
  // ACTIONS-ON posture — the suite repo keeps it; the EMPTY repo is flipped
  // to the DISABLED posture (settings flag + the unit row deleted) to arm
  // the reqRepoReader(TypeActions) 403 pins.
  await db
    .insert(repoSettings)
    .values({ repoId: SUITE_REPO_ID, hasActions: true })
    .onConflictDoUpdate({ target: repoSettings.repoId, set: { hasActions: true } });
  await db.insert(repoUnits).values({ repoId: SUITE_REPO_ID, type: "actions" }).onConflictDoNothing();

  const emptyRow = await db.select().from((await import("../../db/schema")).repositories).where(eq((await import("../../db/schema")).repositories.slug, "actions-empty")).get();
  if (emptyRow === undefined) throw new Error("empty repo row missing");
  EMPTY_REPO_ID = emptyRow.id;
  await db.update(repoSettings).set({ hasActions: false }).where(eq(repoSettings.repoId, EMPTY_REPO_ID));
  await db.delete(repoUnits).where(eq(repoUnits.repoId, EMPTY_REPO_ID));

  // The scoped twin's SOURCE registration: the instance-level row (owner_id
  // 0 — effective for every consumer owner) over the source repo's TEXT id.
  // addSource is idempotent (the exists pre-check), so the D-8
  // double-execution rides calm. The registration survives the run-family
  // wipe below on purpose — the sources table is not run state.
  const sourceRow = await db.select().from((await import("../../db/schema")).repositories).where(eq((await import("../../db/schema")).repositories.slug, "scoped-source")).get();
  if (sourceRow === undefined) throw new Error("scoped-source repo row missing");
  SOURCE_REPO_ID = sourceRow.id;
  await scopedWorkflowSourcesStore(env.DB).addSource(0, SOURCE_REPO_ID);

  // The M3 trigger wiring (6cdc698) rides the engine's onPush seam — fired
  // in waitUntil AFTER the receive answers — so the seeds' REAL pushes above
  // insert trigger runs of their own (ci.yml / notify.yml / deploy.yml all
  // declare `on: push`), possibly a beat AFTER the push returns. The run
  // family and the run_index counters wipe so the suites below start from
  // the empty-run posture their fixtures were written against (they seed
  // their own runs); the wipe loops until a pass stays empty across a settle
  // window, so a late waitUntil insert cannot survive it.
  const wipeRunFamily = async (): Promise<number> => {
    for (const table of ["action_run_job_summaries", "action_run_attempts", "action_run_jobs", "action_runs", "repo_counters"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    const left = await env.DB.prepare("SELECT count(*) AS n FROM action_runs").first<{ n: number }>();
    return left?.n ?? 0;
  };
  // The settle barrier (the v1.5.3 gate rounds' hardening): the tight
  // 20-attempt loop raced a consumer insert that landed between its last
  // wipe and the first describe (observed R2/R3 under full-suite load —
  // total_count 1 in the zero-run test). The barrier now SPACES its
  // attempts and demands TWO consecutive clean passes, so a late insert
  // lands inside the window and dies with the next wipe.
  let consecutiveClean = 0;
  for (let attempt = 0; attempt < 20 && consecutiveClean < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const left = await wipeRunFamily();
    consecutiveClean = left === 0 ? consecutiveClean + 1 : 0;
  }
  if (consecutiveClean < 2) {
    throw new Error("the seeds' trigger runs never settled — the run-family wipe did not converge");
  }
});

// ---------------------------------------------------------------------------
// The rig — the orchestrator one-liner's seam (the secrets-variables.test
// convention): local OpenAPIHono mount, token auth bound to the seeded rows.
// ---------------------------------------------------------------------------

const resolver: AuthResolver = {
  resolveToken: (token: string) => {
    if (token === "alice-token") return Promise.resolve(identity(ALICE_ID, OWNER));
    if (token === "bob-token") return Promise.resolve(identity(BOB_ID, "bob"));
    if (token === "admin-token") return Promise.resolve(identity(ADMIN_ID, "act-admin", true));
    return Promise.resolve(null);
  },
};

function identity(id: number, login: string, isAdmin = false): User {
  return { ...STUB_USER, id, login, username: login, is_admin: isAdmin };
}

/** The rig's token-row ids — the resolveAuth stand-in's AuthToken.id per
 *  presented credential (the audit arms' "access-token:<id>" pin source). */
const RIG_TOKEN_IDS: Record<string, number> = { "alice-token": 11, "bob-token": 12, "admin-token": 13 };

/**
 * The family middleware: the standalone createTokenAuthMiddleware (the 401
 * ladder) PLUS the production resolveAuth's AuthInfo attachment — at
 * /api/v1/* resolveAuth always publishes `auth` carrying the verified token
 * row (SPEC-0002 §2.5), and the API audit arms derive their
 * "access-token:<id>" credential from it (the oauth2-apps.ts auditActorOf
 * house shape). The stand-in maps the presented credential to a fixed rig
 * row id; `user` stays null — identity rides `authUser`, the arms read the
 * token row only.
 */
const requireToken: MiddlewareHandler<ApiEnv> = async (c, next) => {
  await createTokenAuthMiddleware(resolver)(c, async () => {
    const presented = extractTokenHeader(c.req.header("Authorization"));
    const tokenId = presented === null ? undefined : RIG_TOKEN_IDS[presented];
    c.set("auth", {
      user: null,
      token:
        tokenId === undefined
          ? null
          : {
              id: tokenId,
              userId: 0,
              name: presented ?? "",
              prefix: "cfg_rig",
              scopes: "all",
              expiresAt: null,
              lastUsedAt: null,
              createdAt: new Date(),
            },
      scope: null,
      isBasicAuth: false,
    });
    await next();
  });
};

function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerRepoActionsRoutes(app, requireToken);
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`${ORIGIN}${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const get = (path: string, token?: string): Promise<Response> =>
  router()(path, { headers: token === undefined ? {} : { Authorization: `token ${token}` } });

const put = (path: string, token?: string): Promise<Response> =>
  router()(path, { method: "PUT", headers: token === undefined ? {} : { Authorization: `token ${token}` } });

const post = (path: string, body: unknown, token: string, query = ""): Promise<Response> =>
  router()(`${path}${query}`, {
    method: "POST",
    headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const SUITE = `/repos/${OWNER}/actions-suite`;
const FALLBACK = `/repos/${OWNER}/actions-fallback`;
const EMPTY = `/repos/${OWNER}/actions-empty`;

// ---------------------------------------------------------------------------
// ActionsListRepositoryWorkflows (action.go:859-896)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/actions/workflows (ActionsListRepositoryWorkflows)", () => {
  it("lists the .gitea/workflows entries with the ActionWorkflow wire (200)", async () => {
    const res = await get(`${SUITE}/actions/workflows`, "alice-token");
    expect(res.status).toBe(200);
    const body = await res.json<{ workflows: Array<Record<string, unknown>>; total_count: number }>();
    expect(body.total_count).toBe(3);
    const names = body.workflows.map((w) => w.id as string).sort();
    expect(names).toEqual(["broken.yml", "ci.yml", "notify.yml"]);

    const ci = body.workflows.find((w) => w.id === "ci.yml") as Record<string, unknown>;
    expect(ci.name).toBe("CI"); // the YAML name (convert.go:629-632)
    expect(ci.path).toBe(".gitea/workflows/ci.yml");
    expect(ci.state).toBe("active");
    expect(ci.url).toBe(`${ORIGIN}/api/v1/repos/alice/actions-suite/actions/workflows/ci.yml`);
    expect(ci.html_url).toBe(`${ORIGIN}/alice/actions-suite/src/branch/main/.gitea/workflows/ci.yml`);
    expect(ci.badge_url).toBe(`${ORIGIN}/alice/actions-suite/actions/workflows/ci.yml/badge.svg?branch=main`);
    // The commit-author timestamps (convert.go:616-622) — the TIP commit's
    // author time (the default branch's commit 2, seeded at T0+60).
    expect(ci.created_at).toBe(new Date((T0 + 60) * 1000).toISOString());
    expect(ci.updated_at).toBe(new Date((T0 + 60) * 1000).toISOString());
    expect(ci.deleted_at).toBe("0001-01-01T00:00:00Z"); // never set — Go-zero

    const broken = body.workflows.find((w) => w.id === "broken.yml") as Record<string, unknown>;
    expect(broken.name).toBe("broken.yml"); // the parse-fail arm keeps the file name
  });

  it("falls back to .github/workflows when .gitea/workflows does not exist", async () => {
    const res = await get(`${FALLBACK}/actions/workflows`, "alice-token");
    expect(res.status).toBe(200);
    const body = await res.json<{ workflows: Array<{ id: string; name: string }>; total_count: number }>();
    expect(body.total_count).toBe(1);
    expect(body.workflows[0]?.id).toBe("deploy.yml");
    expect(body.workflows[0]?.name).toBe("Deploy");
  });

  it("answers 200 with an empty list when no workflow dir exists (workflows.go:92-95)", async () => {
    const res = await get(`${EMPTY}/actions/workflows`, "alice-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workflows: [], total_count: 0 });
  });

  it("gates: 401 anonymous, 403 on the disabled actions unit (non-admin), admin passes", async () => {
    expect((await get(`${SUITE}/actions/workflows`)).status).toBe(401);
    // actions-empty carries no repo_settings row — loadRepoSettings' default
    // hasActions=false — so the non-admin reader hits the unit gate.
    const denied = await get(`${EMPTY}/actions/workflows`, "bob-token");
    expect(denied.status).toBe(403);
    expect((await denied.json<{ message: string }>()).message).toBe(
      "user should have specific read permission or be a repo admin or a site admin",
    );
    expect((await get(`${EMPTY}/actions/workflows`, "admin-token")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// ActionsGetWorkflow (action.go:898-930)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id} (ActionsGetWorkflow)", () => {
  it("serves one workflow by file name (200, the list item's shape)", async () => {
    const res = await get(`${SUITE}/actions/workflows/ci.yml`, "alice-token");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.id).toBe("ci.yml");
    expect(body.name).toBe("CI");
    expect(body.state).toBe("active");
    expect(body.path).toBe(".gitea/workflows/ci.yml");
    expect(body.badge_url).toBe(`${ORIGIN}/alice/actions-suite/actions/workflows/ci.yml/badge.svg?branch=main`);
  });

  it("404s an unknown workflow with the not-exist text", async () => {
    const res = await get(`${SUITE}/actions/workflows/ghost.yml`, "alice-token");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      message: 'workflow "ghost.yml" not found',
      url: `${ORIGIN}/api/swagger`,
    });
  });

  it("gates: 401 anonymous, 403 on the disabled unit", async () => {
    expect((await get(`${SUITE}/actions/workflows/ci.yml`)).status).toBe(401);
    expect((await get(`${EMPTY}/actions/workflows/x.yml`, "bob-token")).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// ActionsDisableWorkflow / ActionsEnableWorkflow (action.go:1038-1104)
// ---------------------------------------------------------------------------

describe("PUT .../disable + .../enable (the LANDED ActionsConfig store)", () => {
  it("disable answers 204 and appends to the config's DisabledWorkflows once", async () => {
    expect((await put(`${SUITE}/actions/workflows/ci.yml/disable`, "alice-token")).status).toBe(204);
    const cfg = await loadRepoActionsConfig(env.DB, SUITE_REPO_ID);
    expect(cfg.disabledWorkflows).toEqual(["ci.yml"]);
    // Idempotent: a re-disable is a no-op append (repo_unit_actions.go:103-106).
    expect((await put(`${SUITE}/actions/workflows/ci.yml/disable`, "alice-token")).status).toBe(204);
    const cfgAfter = await loadRepoActionsConfig(env.DB, SUITE_REPO_ID);
    expect(cfgAfter.disabledWorkflows).toEqual(["ci.yml"]);
  });

  it("the disabled workflow renders state disabled_manually; siblings stay active", async () => {
    const res = await get(`${SUITE}/actions/workflows`, "alice-token");
    const body = await res.json<{ workflows: Array<{ id: string; state: string }> }>();
    expect(body.workflows.find((w) => w.id === "ci.yml")?.state).toBe("disabled_manually");
    expect(body.workflows.find((w) => w.id === "notify.yml")?.state).toBe("active");
  });

  it("enable answers 204 and clears the entry (SliceRemoveAll)", async () => {
    expect((await put(`${SUITE}/actions/workflows/ci.yml/enable`, "alice-token")).status).toBe(204);
    const cfg = await loadRepoActionsConfig(env.DB, SUITE_REPO_ID);
    expect(cfg.disabledWorkflows).toEqual([]);
    const res = await get(`${SUITE}/actions/workflows/ci.yml`, "alice-token");
    expect((await res.json<{ state: string }>()).state).toBe("active");
  });

  it("404s an unknown workflow on both arms", async () => {
    for (const arm of ["disable", "enable"]) {
      const res = await put(`${SUITE}/actions/workflows/ghost.yml/${arm}`, "alice-token");
      expect(res.status).toBe(404);
      expect((await res.json<{ message: string }>()).message).toBe('workflow "ghost.yml" not found');
    }
  });

  it("gates: the writer arm 403s a plain reader (bob) — reqRepoWriter's message", async () => {
    const res = await put(`${SUITE}/actions/workflows/ci.yml/disable`, "bob-token");
    expect(res.status).toBe(403);
    expect((await res.json<{ message: string }>()).message).toBe("user should have a permission to write to a repo");
    expect((await put(`${SUITE}/actions/workflows/ci.yml/disable`)).status).toBe(401);
  });

  afterAll(async () => {
    // D-8 posture (the audit describe's re-enable note): a mid-test failure
    // must not strand a disabled entry into a re-execution's state pins.
    await put(`${SUITE}/actions/workflows/ci.yml/enable`, "alice-token");
  });
});

// ---------------------------------------------------------------------------
// The API toggle's scoped ABSENCE (the pin's decision — upstream's
// enable/disable API surface carries NO scoped param: the swagger declares
// owner/repo/workflow_id only, action.go:1047-1084/:1194-1230, and the
// handlers never read the param — :1081/:1230 call the repo-level-only
// actions_service.EnableOrDisableWorkflow, workflow.go:30-52; the scoped
// mutators + the required-refusal are the WEB handler's view.go:1338-1361
// branch). LAND NOTHING on the toggle — pin the ignored-param behavior.
// ---------------------------------------------------------------------------

describe("PUT .../disable + .../enable ignore scoped_workflow_source_repo_id (the API surface's recorded absence)", () => {
  afterAll(async () => {
    // D-8 posture + the stranded-state defense: the repo-level toggle back
    // to enabled; the scoped opt-out map and the registration's configs
    // cleared (repo_units + the sources table survive every barrier).
    await put(`${SUITE}/actions/workflows/ci.yml/enable`, "alice-token");
    await scopedWorkflowSourcesStore(env.DB).setSourceConfigs(0, SOURCE_REPO_ID, {});
    await toggleRepoActionsWorkflow(env.DB, SUITE_REPO_ID, ALICE_ID, {
      workflowId: "ci.yml",
      isEnable: true,
      scopedWorkflowSourceRepoId: SOURCE_REPO_ID,
    });
  });

  it("a scoped param on the disable wire toggles the CONSUMER's repo-level workflow; the opt-out map stays empty", async () => {
    // the registration marks ci.yml REQUIRED — the WEB disable would refuse
    // (view.go:1338-1344's scoped_required_cannot_disable JSONError); the
    // API never consults the registration.
    await scopedWorkflowSourcesStore(env.DB).setSourceConfigs(0, SOURCE_REPO_ID, { "ci.yml": { required: true, patterns: ["*"] } });
    const res = await put(
      `${SUITE}/actions/workflows/ci.yml/disable?scoped_workflow_source_repo_id=${SOURCE_REPO_ID}`,
      "alice-token",
    );
    expect(res.status).toBe(204); // no required-refusal — the API has no scoped branch to arm
    const cfg = await loadRepoActionsConfig(env.DB, SUITE_REPO_ID);
    expect(cfg.disabledWorkflows).toEqual(["ci.yml"]); // the repo-level entry flipped
    expect(cfg.disabledScopedWorkflows).toEqual({}); // the opt-out map untouched
    // the enable arm rides the same absence.
    expect(
      (await put(`${SUITE}/actions/workflows/ci.yml/enable?scoped_workflow_source_repo_id=${SOURCE_REPO_ID}`, "alice-token")).status,
    ).toBe(204);
    const cfgAfter = await loadRepoActionsConfig(env.DB, SUITE_REPO_ID);
    expect(cfgAfter.disabledWorkflows).toEqual([]);
    expect(cfgAfter.disabledScopedWorkflows).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// ActionsListWorkflowRuns (action.go:932-1036)
// ---------------------------------------------------------------------------

/** The three run rows the runs suite shares (inserted once, in order). */
let runAId = 0;
let runBId = 0;

describe("GET .../workflows/{workflow_id}/runs (ActionsListWorkflowRuns)", () => {
  afterAll(async () => {
    // D-8 (the v1.5.2 gate R3/R4 flake): under 466-worker load the harness
    // can re-execute this file against the same D1 — the small fixed
    // indexes this describe seeds (1/2/3) then collide on UNIQUE and every
    // later assert cascades off the stale rows. Wiping the actions tables
    // at the describe's END guarantees the next describe (and any
    // re-execution) starts from empty; this file's worker owns its D1
    // exclusively, so the unfiltered deletes touch nothing else.
    const db = drizzle(env.DB);
    await db.delete(actionRunAttempts);
    await db.delete(actionRunJobs);
    await db.delete(actionRuns);
    // the counter row goes too: nextRunIndex bootstraps at the repo max
    // (the module header's note), so the next allocate starts at 1 exactly
    // like a fresh file — the dispatches describe's empty-set bootstrap
    // below stays coherent.
    await db.delete(repoCounters).where(eq(repoCounters.repoId, SUITE_REPO_ID));
  });

  it("404s a workflow that has no runs AND no file; 200/0 when the file exists", async () => {
    // notify.yml exists in the tree but has no runs yet — the git-lookup
    // fallthrough answers an EMPTY list (action.go:1022-1031).
    const exists = await get(`${SUITE}/actions/workflows/notify.yml/runs`, "alice-token");
    expect(exists.status).toBe(200);
    expect(await exists.json()).toEqual({ total_count: 0, workflow_runs: [] });
    // ghost.yml neither runs nor exists — the not-found arm.
    const missing = await get(`${SUITE}/actions/workflows/ghost.yml/runs`, "alice-token");
    expect(missing.status).toBe(404);
    expect((await missing.json<{ message: string }>()).message).toBe('workflow "ghost.yml" not found');
  });

  it("lists the workflow's runs newest-first with the ActionWorkflowRun wire (200)", async () => {
    const db = drizzle(env.DB);
    const { run: runA } = await insertActionRun(env.DB, {
      repoId: SUITE_REPO_ID,
      ownerId: ALICE_ID,
      workflowId: "ci.yml",
      index: 1,
      triggerUserId: ALICE_ID,
      ref: "refs/heads/main",
      commitSha: "a".repeat(40),
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
      title: "seed: docs",
    }, [{ jobId: "build", runsOn: ["ubuntu-latest"], workflowPayload: new TextEncoder().encode("name: CI\njobs:\n  build: {}\n") }]);
    const { run: runB } = await insertActionRun(env.DB, {
      repoId: SUITE_REPO_ID,
      ownerId: ALICE_ID,
      workflowId: "ci.yml",
      index: 2,
      triggerUserId: ALICE_ID,
      ref: "refs/heads/topic",
      commitSha: "b".repeat(40),
      event: "workflow_dispatch",
      eventPayload: "{}",
      triggerEvent: "workflow_dispatch",
      title: "seed: docs",
    }, [{ jobId: "build", runsOn: ["ubuntu-latest"], workflowPayload: new TextEncoder().encode("name: CI\njobs:\n  build: {}\n") }]);
    await insertActionRun(env.DB, {
      repoId: SUITE_REPO_ID,
      ownerId: ALICE_ID,
      workflowId: "notify.yml",
      index: 3,
      triggerUserId: ALICE_ID,
      ref: "refs/heads/main",
      commitSha: TIP_MAIN,
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
      title: "seed: docs",
    }, [{ jobId: "notify", runsOn: ["ubuntu-latest"], workflowPayload: new TextEncoder().encode("jobs:\n  notify: {}\n") }]);
    runAId = runA.id;
    runBId = runB.id;
    // runB completes: the run AND its attempt row flip to success — the
    // converter reads the ATTEMPT's status (ToActionWorkflowRun,
    // convert.go:299-306, exactly how a real completion lands). The run
    // row's returned latestAttemptId is 0 (captured pre-update), so the
    // attempt resolves by runId.
    await db.update(actionRuns).set({ status: 1 }).where(eq(actionRuns.id, runB.id));
    await db.update(actionRunAttempts).set({ status: 1 }).where(eq(actionRunAttempts.runId, runB.id));

    const res = await get(`${SUITE}/actions/workflows/ci.yml/runs`, "alice-token");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("2");
    const body = await res.json<{ total_count: number; workflow_runs: Array<Record<string, unknown>> }>();
    expect(body.total_count).toBe(2);
    // repo-scoped order: `index DESC` (run_list.go:142-149).
    expect(body.workflow_runs.map((r) => r.id)).toEqual([runBId, runAId]); // runC (notify.yml) excluded

    const run = body.workflow_runs[0] as Record<string, unknown>;
    const runUrl = run.url as string;
    expect(run.url).toBe(`${ORIGIN}/api/v1/repos/alice/actions-suite/actions/runs/${runBId}`);
    expect(run.previous_attempt_url).toBeNull(); // explicit null — attempt 1
    expect(run.html_url).toBe(`${ORIGIN}/alice/actions-suite/actions/runs/${runBId}`);
    expect(run.jobs_url).toBe(`${runUrl}/jobs`);
    expect(run.logs_url).toBe(`${runUrl}/logs`);
    expect(run.artifacts_url).toBe(`${runUrl}/artifacts`);
    expect(run.cancel_url).toBe(`${runUrl}/cancel`);
    expect(run.rerun_url).toBe(`${runUrl}/rerun`);
    expect(run.display_title).toBe("seed: docs");
    expect(run.path).toBe("ci.yml@refs/heads/topic");
    expect(run.event).toBe("workflow_dispatch");
    expect(run.run_attempt).toBe(1);
    expect(run.run_number).toBe(2);
    expect(run.head_sha).toBe("b".repeat(40));
    expect(run.head_branch).toBe("topic");
    expect(run.status).toBe("completed");
    expect(run.conclusion).toBe("success");
    expect(run.pull_requests).toEqual([]);
    expect((run.actor as Record<string, unknown>).login).toBe(OWNER);
    // repository.id is the repoIdNumber seam render — the seeded row's UUID
    // id is non-numeric, the documented 0.
    expect((run.repository as Record<string, unknown>).id).toBe(0);
    // Unset instants render Go-zero (the timestamps' zero-default).
    expect(run.started_at).toBe("0001-01-01T00:00:00Z");
    expect(run.completed_at).toBe("0001-01-01T00:00:00Z");
  });

  it("filters: status (with the 400 invalid text), actor (404 text), branch, event, head_sha", async () => {
    const queued = await get(`${SUITE}/actions/workflows/ci.yml/runs?status=queued`, "alice-token");
    expect(queued.status).toBe(200);
    expect((await queued.json<{ workflow_runs: Array<{ id: number }> }>()).workflow_runs.map((r) => r.id)).toEqual([runAId]);

    const completed = await get(`${SUITE}/actions/workflows/ci.yml/runs?status=completed`, "alice-token");
    expect((await completed.json<{ workflow_runs: Array<{ id: number }> }>()).workflow_runs.map((r) => r.id)).toEqual([runBId]);

    const bad = await get(`${SUITE}/actions/workflows/ci.yml/runs?status=bogus`, "alice-token");
    expect(bad.status).toBe(400);
    expect((await bad.json<{ message: string }>()).message).toBe("invalid status bogus");

    const actor = await get(`${SUITE}/actions/workflows/ci.yml/runs?actor=alice`, "alice-token");
    expect((await actor.json<{ total_count: number }>()).total_count).toBe(2);
    const ghost = await get(`${SUITE}/actions/workflows/ci.yml/runs?actor=ghost`, "alice-token");
    expect(ghost.status).toBe(404);
    expect((await ghost.json<{ message: string }>()).message).toBe("user does not exist [uid: 0, name: ghost]");

    const branch = await get(`${SUITE}/actions/workflows/ci.yml/runs?branch=main`, "alice-token");
    expect((await branch.json<{ workflow_runs: Array<{ id: number }> }>()).workflow_runs.map((r) => r.id)).toEqual([runAId]);

    const event = await get(`${SUITE}/actions/workflows/ci.yml/runs?event=workflow_dispatch`, "alice-token");
    expect((await event.json<{ workflow_runs: Array<{ id: number }> }>()).workflow_runs.map((r) => r.id)).toEqual([runBId]);

    const sha = await get(`${SUITE}/actions/workflows/ci.yml/runs?head_sha=${"a".repeat(40)}`, "alice-token");
    expect((await sha.json<{ workflow_runs: Array<{ id: number }> }>()).workflow_runs.map((r) => r.id)).toEqual([runAId]);
  });

  it("paginates with the X-Total-Count and Link headers (limit/page)", async () => {
    const page1 = await get(`${SUITE}/actions/workflows/ci.yml/runs?limit=1`, "alice-token");
    expect(page1.headers.get("X-Total-Count")).toBe("2");
    expect(page1.headers.get("Link")).toContain('rel="next"');
    const body1 = await page1.json<{ workflow_runs: Array<{ id: number }> }>();
    expect(body1.workflow_runs).toHaveLength(1);
    expect(body1.workflow_runs[0]?.id).toBe(runBId);

    const page2 = await get(`${SUITE}/actions/workflows/ci.yml/runs?limit=1&page=2`, "alice-token");
    expect(page2.headers.get("Link")).toContain('rel="prev"');
    expect(page2.headers.get("Link")).toContain('rel="first"');
    const body2 = await page2.json<{ workflow_runs: Array<{ id: number }> }>();
    expect(body2.workflow_runs[0]?.id).toBe(runAId);
  });

  it("gates: 401 anonymous, 403 on the disabled unit", async () => {
    expect((await get(`${SUITE}/actions/workflows/ci.yml/runs`)).status).toBe(401);
    expect((await get(`${EMPTY}/actions/workflows/x.yml/runs`, "bob-token")).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// ActionsDispatchWorkflow (action.go:1106-1178 + workflow.go:64-190)
// ---------------------------------------------------------------------------

describe("POST .../workflows/{workflow_id}/dispatches (ActionsDispatchWorkflow)", () => {
  afterAll(async () => {
    // D-8 (the v1.5.2 gate R3/R4 flake): under 466-worker load the harness
    // can re-execute this file against the same D1 — the small fixed
    // indexes this describe seeds (1/2/3) then collide on UNIQUE and every
    // later assert cascades off the stale rows. Wiping the actions tables
    // at the describe's END guarantees the next describe (and any
    // re-execution) starts from empty; this file's worker owns its D1
    // exclusively, so the unfiltered deletes touch nothing else.
    const db = drizzle(env.DB);
    await db.delete(actionRunAttempts);
    await db.delete(actionRunJobs);
    await db.delete(actionRuns);
    // the counter row goes too: nextRunIndex bootstraps at the repo max
    // (the module header's note), so the next allocate starts at 1 exactly
    // like a fresh file — the dispatches describe's empty-set bootstrap
    // below stays coherent.
    await db.delete(repoCounters).where(eq(repoCounters.repoId, SUITE_REPO_ID));
    // the scoped twin's stranded-state defense (the audit describe's
    // re-enable posture): a mid-test failure could leave the scoped opt-out
    // flag or the registration's required mark behind — either would poison
    // a re-execution's repo-level dispatch pins (repo_units + the sources
    // table survive every barrier in this file).
    await scopedWorkflowSourcesStore(env.DB).setSourceConfigs(0, SOURCE_REPO_ID, {});
    await toggleRepoActionsWorkflow(env.DB, SUITE_REPO_ID, ALICE_ID, {
      workflowId: "ci.yml",
      isEnable: true,
      scopedWorkflowSourceRepoId: SOURCE_REPO_ID,
    });
    await toggleRepoActionsWorkflow(env.DB, SUITE_REPO_ID, ALICE_ID, {
      workflowId: "ci.yml",
      isEnable: true,
      scopedWorkflowSourceRepoId: "0",
    });
  });

  it("dispatches with defaults (204), inserting the waiting run + job rows", async () => {
    const before = await drizzle(env.DB)
      .select({ index: actionRuns.index })
      .from(actionRuns)
      .where(eq(actionRuns.repoId, SUITE_REPO_ID));
    // the before-set may be EMPTY (the runs describe's D-8 wipe): the counter
    // row is gone with it, so the first allocate bootstraps at 1.
    const expectedIndex = before.length === 0 ? 1 : Math.max(...before.map((r) => r.index)) + 1;

    const res = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "main" }, "alice-token");
    expect(res.status).toBe(204);
    const rows = await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.workflowId, "ci.yml")).all();
    const dispatched = rows.find((r) => r.index === expectedIndex);
    expect(dispatched).toBeDefined();
    // the index rode the repo_counters.run_index CAS (nextRunIndex — the
    // counter bootstraps at the repo max, then bumps; the module header's
    // note)
    const counter = await drizzle(env.DB).select().from(repoCounters).where(eq(repoCounters.repoId, SUITE_REPO_ID)).get();
    expect(counter?.runIndex).toBe(dispatched?.index);
    expect(dispatched?.status).toBe(5); // waiting
    expect(dispatched?.event).toBe("workflow_dispatch");
    expect(dispatched?.triggerEvent).toBe("workflow_dispatch");
    expect(dispatched?.ref).toBe("refs/heads/main");
    expect(dispatched?.commitSha).toBe(TIP_MAIN);
    expect(dispatched?.title).toBe("seed: docs"); // the commit's message title
    expect(dispatched?.triggerUserId).toBe(ALICE_ID);
    const payload = JSON.parse(dispatched?.eventPayload ?? "{}") as { inputs: Record<string, string> };
    // dispatchEventInputs renders CoerceToString over every input
    // (workflow.go:210-216) — the booleans stringify ("false"/"true").
    expect(payload.inputs).toEqual({ greeting: "hello", flag: "false" });

    const jobRows = await drizzle(env.DB).select().from(actionRunJobs).where(eq(actionRunJobs.runId, dispatched?.id ?? 0)).all();
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.jobId).toBe("build");
    expect(jobRows[0]?.name).toBe("build");
    expect(JSON.parse(jobRows[0]?.runsOn ?? "[]")).toEqual(["ubuntu-latest"]);
    expect(new TextDecoder().decode((jobRows[0]?.workflowPayload as Uint8Array) ?? new Uint8Array(0))).toContain("jobs:");
  });

  it("merges the provided inputs over the defaults and coerces boolean type", async () => {
    const res = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "main", inputs: { greeting: "hi", flag: "TRUE" } }, "alice-token");
    expect(res.status).toBe(204);
    const rows = await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.workflowId, "ci.yml")).all();
    const latest = rows.sort((a, b) => b.index - a.index)[0];
    const payload = JSON.parse(latest?.eventPayload ?? "{}") as { inputs: Record<string, unknown>; ref: string };
    expect(payload.inputs.greeting).toBe("hi");
    expect(payload.inputs.flag).toBe("true"); // ParseYamlBool("TRUE") → true → CoerceToString
    expect(payload.ref).toBe("main");
  });

  it("return_run_details=true answers the RunDetails body (200)", async () => {
    const res = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "main" }, "alice-token", "?return_run_details=true");
    expect(res.status).toBe(200);
    const body = await res.json<{ workflow_run_id: number; run_url: string; html_url: string }>();
    const runRow = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.id, body.workflow_run_id)).get());
    expect(runRow?.id).toBe(body.workflow_run_id);
    expect(body.run_url).toBe(`${ORIGIN}/api/v1/repos/alice/actions-suite/actions/runs/${body.workflow_run_id}`);
    expect(body.html_url).toBe(`${ORIGIN}/alice/actions-suite/actions/runs/${body.workflow_run_id}`);
  });

  it("dispatches a TAG by its full ref; a BARE tag name 404s (the spoof-test parity)", async () => {
    const res = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "refs/tags/v1" }, "alice-token");
    expect(res.status).toBe(204);
    const rows = await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.workflowId, "ci.yml")).all();
    const latest = rows.sort((a, b) => b.index - a.index)[0];
    expect(latest?.ref).toBe("refs/tags/v1");
    expect(latest?.commitSha).toBe(TIP_MAIN);
    // A bare name that only exists as a tag misses (upstream's spoof test:
    // ref "spoof" against refs/tags/refs/heads/spoof answers 404,
    // actions_trigger_test.go:989-999 — the else arm treats it as a branch).
    const bare = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "v1" }, "alice-token");
    expect(bare.status).toBe(404);
    expect((await bare.json<{ message: string }>()).message).toBe('ref "v1" doesn\'t exist');
  });

  it("422s: the binder's Ref Required, a workflow without the trigger, an invalid document", async () => {
    const noRef = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, {}, "alice-token");
    expect(noRef.status).toBe(422);
    expect((await noRef.json<{ message: string }>()).message).toBe("Ref: Required");

    // notify.yml parses but declares only `on: push` — the
    // has-no-workflow_dispatch arm (workflow.go:141-146).
    const noTrigger = await post(`${SUITE}/actions/workflows/notify.yml/dispatches`, { ref: "main" }, "alice-token");
    expect(noTrigger.status).toBe(422);
    expect((await noTrigger.json<{ message: string }>()).message).toBe(
      'workflow "notify.yml" has no workflow_dispatch event trigger',
    );

    const invalid = await post(`${SUITE}/actions/workflows/broken.yml/dispatches`, { ref: "main" }, "alice-token");
    expect(invalid.status).toBe(422);
    expect((await invalid.json<{ message: string }>()).message).toContain('invalid workflow "broken.yml":');
  });

  it("404s: an unknown ref, an unknown workflow, the scoped effective-source gate", async () => {
    const badRef = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "nope" }, "alice-token");
    expect(badRef.status).toBe(404);
    expect((await badRef.json<{ message: string }>()).message).toBe('ref "nope" doesn\'t exist');

    const badWorkflow = await post(`${SUITE}/actions/workflows/ghost.yml/dispatches`, { ref: "main" }, "alice-token");
    expect(badWorkflow.status).toBe(404);
    expect((await badWorkflow.json<{ message: string }>()).message).toBe('workflow "ghost.yml" not found');

    // A non-registered source id rides the scoped arm's first gate —
    // IsScopedWorkflowSourceEffective's miss answers the not-found text
    // (workflow.go:241-249; the formerly recorded "scoped reduction" 404 is
    // superseded by the landed twin).
    const scoped = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "main" }, "alice-token", "?scoped_workflow_source_repo_id=1");
    expect(scoped.status).toBe(404);
    expect((await scoped.json<{ message: string }>()).message).toBe('workflow "ci.yml" not found');
  });

  it("403s a disabled workflow — the disabled check runs BEFORE the ref resolution", async () => {
    expect((await put(`${SUITE}/actions/workflows/ci.yml/disable`, "alice-token")).status).toBe(204);
    const res = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "main" }, "alice-token");
    expect(res.status).toBe(403);
    expect((await res.json<{ message: string }>()).message).toBe("workflow is disabled");
    // A missing ref on a disabled workflow STILL answers the disabled 403
    // (the check's order — workflow.go:83-98 precedes the ref arms).
    const noRef = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "nonexistent-branch" }, "alice-token");
    expect(noRef.status).toBe(403);
    expect((await put(`${SUITE}/actions/workflows/ci.yml/enable`, "alice-token")).status).toBe(204);
  });

  // -------------------------------------------------------------------------
  // The SCOPED DISPATCH TWIN (action.go:1120-1123's query param +
  // workflow.go:237-268's scoped arm — the K14 landing; the WEB arm's TEXT
  // adaptation rides verbatim: ""/"0" = repo-level, otherwise the source
  // repo's TEXT id through config.ts's scopedSourceRepoParam).
  // -------------------------------------------------------------------------

  it("the scoped twin: a '0' param stays repo-level (FormInt64's zero arm)", async () => {
    const res = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "main" }, "alice-token", "?scoped_workflow_source_repo_id=0");
    expect(res.status).toBe(204);
    const latest = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.workflowId, "ci.yml")).all()).sort(
      (a, b) => b.index - a.index,
    )[0];
    expect(latest?.isScopedRun).toBe(false);
    expect(latest?.workflowRepoId).toBe("");
    expect(latest?.workflowCommitSha).toBe("");
    // the consumer's OWN ci.yml content dispatched (the greeting input — the
    // source's ci.yml declares `note` instead).
    const payload = JSON.parse(latest?.eventPayload ?? "{}") as { inputs: Record<string, string> };
    expect(payload.inputs).toEqual({ greeting: "hello", flag: "false" });
  });

  it("the scoped twin dispatches the SOURCE's content and records the parity columns", async () => {
    const res = await post(
      `${SUITE}/actions/workflows/ci.yml/dispatches`,
      { ref: "main", inputs: { note: "override" } },
      "alice-token",
      `?scoped_workflow_source_repo_id=${SOURCE_REPO_ID}`,
    );
    expect(res.status).toBe(204);
    const latest = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.workflowId, "ci.yml")).all()).sort(
      (a, b) => b.index - a.index,
    )[0];
    // the content-source parity columns (workflow.go:139-142/:260-263):
    // is_scoped_run + the SOURCE repo row + the SOURCE default-branch sha,
    // beside the consumer ref's own commit_sha.
    expect(latest?.isScopedRun).toBe(true);
    expect(latest?.workflowRepoId).toBe(SOURCE_REPO_ID);
    expect(latest?.workflowCommitSha).toBe(SOURCE_TIP);
    expect(latest?.commitSha).toBe(TIP_MAIN);
    expect(latest?.ref).toBe("refs/heads/main");
    expect(latest?.title).toBe("seed: docs"); // the CONSUMER commit's message title
    // the SOURCE content validated and merged its inputs (ScopedCI's `note`
    // — the CONSUMER ci.yml's greeting/flag pair proves the content source).
    const payload = JSON.parse(latest?.eventPayload ?? "{}") as { inputs: Record<string, string> };
    expect(payload.inputs).toEqual({ note: "override" });
  });

  it("the scoped twin's ladder validates the SOURCE content (no-dispatch 422, broken 422)", async () => {
    const noTrigger = await post(
      `${SUITE}/actions/workflows/push-only.yml/dispatches`,
      { ref: "main" },
      "alice-token",
      `?scoped_workflow_source_repo_id=${SOURCE_REPO_ID}`,
    );
    expect(noTrigger.status).toBe(422);
    expect((await noTrigger.json<{ message: string }>()).message).toBe(
      'workflow "push-only.yml" has no workflow_dispatch event trigger',
    );

    const invalid = await post(
      `${SUITE}/actions/workflows/broken.yml/dispatches`,
      { ref: "main" },
      "alice-token",
      `?scoped_workflow_source_repo_id=${SOURCE_REPO_ID}`,
    );
    expect(invalid.status).toBe(422);
    expect((await invalid.json<{ message: string }>()).message).toContain('invalid workflow "broken.yml":');
  });

  it("the scoped twin's disabled check: the opt-out 403s (before the ref resolution); a REQUIRED workflow ignores the opt-out", async () => {
    // the opt-out flag rides the WEB toggle's service arm (the API toggle
    // has no scoped branch — the recorded absence).
    expect(
      await toggleRepoActionsWorkflow(env.DB, SUITE_REPO_ID, ALICE_ID, {
        workflowId: "ci.yml",
        isEnable: false,
        scopedWorkflowSourceRepoId: SOURCE_REPO_ID,
      }),
    ).toBe("saved");
    const optedOut = await post(
      `${SUITE}/actions/workflows/ci.yml/dispatches`,
      { ref: "main" },
      "alice-token",
      `?scoped_workflow_source_repo_id=${SOURCE_REPO_ID}`,
    );
    expect(optedOut.status).toBe(403);
    expect((await optedOut.json<{ message: string }>()).message).toBe("workflow is disabled");
    // the check's order: a missing ref STILL answers the opt-out 403
    // (workflow.go:84-99 precedes the ref arms).
    const noRef = await post(
      `${SUITE}/actions/workflows/ci.yml/dispatches`,
      { ref: "nonexistent-branch" },
      "alice-token",
      `?scoped_workflow_source_repo_id=${SOURCE_REPO_ID}`,
    );
    expect(noRef.status).toBe(403);

    // IsScopedWorkflowOptedOut's conjunction: flagged disabled AND not
    // required — a REQUIRED workflow dispatches through the stranded flag
    // (workflow.go:89-92).
    await scopedWorkflowSourcesStore(env.DB).setSourceConfigs(0, SOURCE_REPO_ID, { "ci.yml": { required: true, patterns: ["*"] } });
    const required = await post(
      `${SUITE}/actions/workflows/ci.yml/dispatches`,
      { ref: "main" },
      "alice-token",
      `?scoped_workflow_source_repo_id=${SOURCE_REPO_ID}`,
    );
    expect(required.status).toBe(204);

    // restore: drop the required mark, clear the opt-out flag.
    await scopedWorkflowSourcesStore(env.DB).setSourceConfigs(0, SOURCE_REPO_ID, {});
    expect(
      await toggleRepoActionsWorkflow(env.DB, SUITE_REPO_ID, ALICE_ID, {
        workflowId: "ci.yml",
        isEnable: true,
        scopedWorkflowSourceRepoId: SOURCE_REPO_ID,
      }),
    ).toBe("saved");
    // the cleared opt-out dispatches again.
    const cleared = await post(
      `${SUITE}/actions/workflows/ci.yml/dispatches`,
      { ref: "main" },
      "alice-token",
      `?scoped_workflow_source_repo_id=${SOURCE_REPO_ID}`,
    );
    expect(cleared.status).toBe(204);
  });

  it("gates: the writer arm 403s bob; anonymous 401", async () => {
    const res = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "main" }, "bob-token");
    expect(res.status).toBe(403);
    expect((await res.json<{ message: string }>()).message).toBe("user should have a permission to write to a repo");
    expect((await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "main" }, "x")).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// getWorkflowJob (action.go:1702-1752)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/actions/jobs/{job_id} (getWorkflowJob)", () => {
  afterAll(async () => {
    // D-8 (the v1.5.2 gate R3/R4 flake): under 466-worker load the harness
    // can re-execute this file against the same D1 — the small fixed
    // indexes this describe seeds (1/2/3) then collide on UNIQUE and every
    // later assert cascades off the stale rows. Wiping the actions tables
    // at the describe's END guarantees the next describe (and any
    // re-execution) starts from empty; this file's worker owns its D1
    // exclusively, so the unfiltered deletes touch nothing else.
    const db = drizzle(env.DB);
    await db.delete(actionRunAttempts);
    await db.delete(actionRunJobs);
    await db.delete(actionRuns);
    // the counter row goes too: nextRunIndex bootstraps at the repo max
    // (the module header's note), so the next allocate starts at 1 exactly
    // like a fresh file — the dispatches describe's empty-set bootstrap
    // below stays coherent.
    await db.delete(repoCounters).where(eq(repoCounters.repoId, SUITE_REPO_ID));
  });

  let jobId = 0;
  let foreignJobId = 0;

  it("serves the ActionWorkflowJob wire (200)", async () => {
    const fallbackRow = await drizzle(env.DB).select().from((await import("../../db/schema")).repositories).where(eq((await import("../../db/schema")).repositories.slug, "actions-fallback")).get();
    if (fallbackRow === undefined) throw new Error("fallback repo row missing");
    const { jobRows: jobRowsA } = await insertActionRun(env.DB, {
      repoId: SUITE_REPO_ID,
      ownerId: ALICE_ID,
      workflowId: "ci.yml",
      index: 900,
      triggerUserId: ALICE_ID,
      ref: "refs/heads/main",
      commitSha: "c".repeat(40),
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
      title: "job wire",
    }, [{ jobId: "build", name: "build (ubuntu-latest)", runsOn: ["ubuntu-latest"], workflowPayload: new TextEncoder().encode("jobs:\n  build: {}\n") }]);
    const { jobRows: jobRowsForeign } = await insertActionRun(env.DB, {
      repoId: fallbackRow.id,
      ownerId: ALICE_ID,
      workflowId: "deploy.yml",
      index: 1,
      triggerUserId: ALICE_ID,
      ref: "refs/heads/main",
      commitSha: "d".repeat(40),
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
      title: "foreign",
    }, [{ jobId: "deploy", runsOn: ["ubuntu-latest"], workflowPayload: new TextEncoder().encode("jobs:\n  deploy: {}\n") }]);
    jobId = jobRowsA[0]?.id ?? 0;
    foreignJobId = jobRowsForeign[0]?.id ?? 0;

    const res = await get(`${SUITE}/actions/jobs/${jobId}`, "alice-token");
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.id).toBe(jobId);
    expect(body.url).toBe(`${ORIGIN}/api/v1/repos/alice/actions-suite/actions/jobs/${jobId}`);
    expect(body.html_url).toBe(`${ORIGIN}/alice/actions-suite/actions/runs/${(await drizzle(env.DB).select().from(actionRunJobs).where(eq(actionRunJobs.id, jobId)).get())?.runId}/jobs/${jobId}`);
    expect(body.run_id).toBe((await drizzle(env.DB).select().from(actionRunJobs).where(eq(actionRunJobs.id, jobId)).get())?.runId);
    const runId = body.run_id as number;
    expect(body.run_url).toBe(`${ORIGIN}/api/v1/repos/alice/actions-suite/actions/runs/${runId}`);
    expect(body.name).toBe("build (ubuntu-latest)");
    expect(body.labels).toEqual(["ubuntu-latest"]);
    expect(body.run_attempt).toBe(1);
    expect(body.head_sha).toBe("c".repeat(40));
    expect(body.head_branch).toBe("main");
    expect(body.status).toBe("queued"); // waiting — ToActionsStatus
    expect(body.steps).toEqual([]); // no claimed task, no step rows
    expect(body.runner_id).toBeUndefined();
    expect(body.started_at).toBe("0001-01-01T00:00:00Z");
  });

  it("404s a foreign-repo job and a junk id with the bare not-found body", async () => {
    const foreign = await get(`${SUITE}/actions/jobs/${foreignJobId}`, "alice-token");
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ message: "not found", url: `${ORIGIN}/api/swagger` });

    const junk = await get(`${SUITE}/actions/jobs/not-a-number`, "alice-token");
    expect(junk.status).toBe(404);
    expect((await junk.json<{ message: string }>()).message).toBe("not found");
  });

  it("gates: 401 anonymous, 403 on the disabled unit", async () => {
    expect((await get(`${SUITE}/actions/jobs/${jobId}`)).status).toBe(401);
    expect((await get(`${EMPTY}/actions/jobs/1`, "bob-token")).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// downloadActionsRunJobLogs (actions_run.go:15-51 + common/actions.go:98-132)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs (downloadActionsRunJobLogs)", () => {
  afterAll(async () => {
    // D-8 (the v1.5.2 gate R3/R4 flake): under 466-worker load the harness
    // can re-execute this file against the same D1 — the small fixed
    // indexes this describe seeds (1/2/3) then collide on UNIQUE and every
    // later assert cascades off the stale rows. Wiping the actions tables
    // at the describe's END guarantees the next describe (and any
    // re-execution) starts from empty; this file's worker owns its D1
    // exclusively, so the unfiltered deletes touch nothing else.
    const db = drizzle(env.DB);
    await db.delete(actionRunAttempts);
    await db.delete(actionRunJobs);
    await db.delete(actionRuns);
    // the counter row goes too: nextRunIndex bootstraps at the repo max
    // (the module header's note), so the next allocate starts at 1 exactly
    // like a fresh file — the dispatches describe's empty-set bootstrap
    // below stays coherent.
    await db.delete(repoCounters).where(eq(repoCounters.repoId, SUITE_REPO_ID));
  });

  /** The (run, job, task, chunks) fixture: a claimed job with a hot log. */
  let logJobId = 0;
  let logTaskId = 0;
  let foreignJobId = 0;
  const CHUNK_ONE = "2026-01-01T00:00:00.0000000Z build started\n";
  const CHUNK_TWO = "2026-01-01T00:00:01.0000000Z build done\n";

  beforeAll(async () => {
    const db = drizzle(env.DB);
    const { jobRows } = await insertActionRun(env.DB, {
      repoId: SUITE_REPO_ID,
      ownerId: ALICE_ID,
      workflowId: "ci.yml",
      index: 901,
      triggerUserId: ALICE_ID,
      ref: "refs/heads/main",
      commitSha: "e".repeat(40),
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
      title: "logs wire",
    }, [{ jobId: "build", runsOn: ["ubuntu-latest"], workflowPayload: new TextEncoder().encode("jobs:\n  build: {}\n") }]);
    logJobId = jobRows[0]?.id ?? 0;
    const { jobRows: foreignRows } = await insertActionRun(env.DB, {
      repoId: (await db.select().from((await import("../../db/schema")).repositories).where(eq((await import("../../db/schema")).repositories.slug, "actions-fallback")).get())?.id ?? "",
      ownerId: ALICE_ID,
      workflowId: "deploy.yml",
      index: 2,
      triggerUserId: ALICE_ID,
      ref: "refs/heads/main",
      commitSha: "d".repeat(40),
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
      title: "foreign",
    }, [{ jobId: "deploy", runsOn: ["ubuntu-latest"], workflowPayload: new TextEncoder().encode("jobs:\n  deploy: {}\n") }]);
    foreignJobId = foreignRows[0]?.id ?? 0;

    const taskRows = await db
      .insert(actionTasks)
      .values({
        jobId: logJobId,
        attempt: 1,
        runnerId: 0,
        status: 1,
        repoId: SUITE_REPO_ID,
        ownerId: ALICE_ID,
        commitSha: "e".repeat(40),
        tokenHash: `log-suite-${logJobId}`,
        logFilename: `${OWNER}/actions-suite/${logJobId.toString(16).padStart(2, "0")}/9.log`,
        logLength: 2,
        logSize: CHUNK_ONE.length + CHUNK_TWO.length,
        created: new Date(),
        updated: new Date(),
      })
      .returning();
    logTaskId = taskRows[0]?.id ?? 0;
    await db.update(actionRunJobs).set({ taskId: logTaskId }).where(eq(actionRunJobs.id, logJobId));
    await db.insert(actionLogChunks).values([
      { taskId: logTaskId, seq: 0, bytes: new TextEncoder().encode(CHUNK_ONE) },
      { taskId: logTaskId, seq: 1, bytes: new TextEncoder().encode(CHUNK_TWO) },
    ]);
  });

  it("serves the concatenated chunk bytes as the attachment (200)", async () => {
    const res = await get(`${SUITE}/actions/jobs/${logJobId}/logs`, "alice-token");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    // FileNameJoinFields(PathBaseStem("ci.yml"), "build", taskID, ".log")
    // — PathBaseStem strips the extension, the fields join with "-"
    // (modules/util/filename.go:23-52 + path.go:32-34).
    expect(res.headers.get("content-disposition")).toContain(`ci-build-${logTaskId}.log`);
    expect(res.headers.get("content-length")).toBe(String(CHUNK_ONE.length + CHUNK_TWO.length));
    expect(await res.text()).toBe(CHUNK_ONE + CHUNK_TWO);
  });

  it("serves the sealed R2 object when the log has sealed (logInStorage)", async () => {
    const db = drizzle(env.DB);
    const sealedName = `${OWNER}/actions-suite/sealed.log`;
    await env.REPO_PACKS.put(`actions/logs/${sealedName}`, new TextEncoder().encode("sealed log bytes\n"));
    await db
      .update(actionTasks)
      .set({ logInStorage: true, logFilename: sealedName, logSize: "sealed log bytes\n".length })
      .where(eq(actionTasks.id, logTaskId));

    const res = await get(`${SUITE}/actions/jobs/${logJobId}/logs`, "alice-token");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("sealed log bytes\n");
    // Restore the hot form for any later reader.
    await db.update(actionTasks).set({ logInStorage: false, logFilename: `${OWNER}/actions-suite/${logJobId.toString(16).padStart(2, "0")}/9.log` }).where(eq(actionTasks.id, logTaskId));
  });

  it("404s: a foreign-repo job (the wrapped not-exist text), an unclaimed job, an expired log", async () => {
    const foreign = await get(`${SUITE}/actions/jobs/${foreignJobId}/logs`, "alice-token");
    expect(foreign.status).toBe(404);
    expect((await foreign.json<{ message: string }>()).message).toBe(
      `run job with id ${foreignJobId}: resource does not exist`,
    );

    const { jobRows } = await insertActionRun(env.DB, {
      repoId: SUITE_REPO_ID,
      ownerId: ALICE_ID,
      workflowId: "ci.yml",
      index: 902,
      triggerUserId: ALICE_ID,
      ref: "refs/heads/main",
      commitSha: "f".repeat(40),
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
      title: "unclaimed",
    }, [{ jobId: "build", runsOn: ["ubuntu-latest"], workflowPayload: new TextEncoder().encode("jobs:\n  build: {}\n") }]);
    const unclaimed = await get(`${SUITE}/actions/jobs/${jobRows[0]?.id}/logs`, "alice-token");
    expect(unclaimed.status).toBe(404);
    expect((await unclaimed.json<{ message: string }>()).message).toBe("job not started");

    await drizzle(env.DB).update(actionTasks).set({ logExpired: true }).where(eq(actionTasks.id, logTaskId));
    const expired = await get(`${SUITE}/actions/jobs/${logJobId}/logs`, "alice-token");
    expect(expired.status).toBe(404);
    expect((await expired.json<{ message: string }>()).message).toBe("logs have been cleaned up");
    await drizzle(env.DB).update(actionTasks).set({ logExpired: false }).where(eq(actionTasks.id, logTaskId));
  });

  it("gates: 401 anonymous, 403 on the disabled unit", async () => {
    expect((await get(`${SUITE}/actions/jobs/${logJobId}/logs`)).status).toBe(401);
    expect((await get(`${EMPTY}/actions/jobs/1/logs`, "bob-token")).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// The audit arms (v1.5.4 — workflow.go:49 / :192-193 through
// services/actions/audit-arms.ts): each successful write emits its row,
// origin "api", the requester as actor, the access-token credential; a
// failed write emits nothing.
// ---------------------------------------------------------------------------

describe("the audit arms (workflow.go:49/:192-193 — the API twins)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM audit_event").run();
  });

  afterAll(async () => {
    // D-8 (the v1.5.2 gate R3/R4 flake) posture — the end-of-describe wipe
    // the run-family describes carry: this file's worker owns its D1
    // exclusively, so the unfiltered deletes touch nothing else. The
    // defensive re-enable FIRST: the toggle pins leave ci.yml enabled on
    // success, and a mid-test failure's stranded disabled entry would poison
    // a re-execution's "active" state pins (repo_units survives the beforeAll
    // barrier). The re-enable's own audit row dies with the wipe after it.
    await put(`${SUITE}/actions/workflows/ci.yml/enable`, "alice-token");
    const db = drizzle(env.DB);
    await db.delete(actionRunAttempts);
    await db.delete(actionRunJobs);
    await db.delete(actionRuns);
    await db.delete(repoCounters).where(eq(repoCounters.repoId, SUITE_REPO_ID));
    await db.delete(auditEvents);
  });

  it("the disable arm emits actions:workflow:disable after the store write (204)", async () => {
    const res = await router()(`${SUITE}/actions/workflows/ci.yml/disable`, {
      method: "PUT",
      headers: { Authorization: "token alice-token", "cf-connecting-ip": "203.0.113.9" },
    });
    expect(res.status).toBe(204);
    const rows = await drizzle(env.DB).select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("actions:workflow:disable");
    expect(row.actorId).toBe(ALICE_ID); // the requester as actor
    expect(row.actorName).toBe(OWNER);
    expect(row.actorCredential).toBe("access-token:11"); // alice-token's rig row (the auditActorOf house derivation)
    expect(row.scopeType).toBe("repository");
    expect(row.scopeId).toBe(SUITE_REPO_ID);
    expect(row.scopeName).toBe("alice/actions-suite"); // ScopeFromRepository's FullName
    expect(row.origin).toBe("api"); // api.go:954's AuditOrigin(OriginAPI)
    expect(row.message).toBe("Disabled Actions workflow ci.yml in repository alice/actions-suite.");
    expect(JSON.parse(row.metadata ?? "null")).toEqual({ workflow: "ci.yml" });
    expect(row.ipAddress).toBe("203.0.113.9"); // the cf-connecting-ip pass-through
    // cleanup: hand the store back enabled (the enable's own row dies with
    // the next beforeEach wipe)
    expect((await put(`${SUITE}/actions/workflows/ci.yml/enable`, "alice-token")).status).toBe(204);
  });

  it("the enable arm flips the action id; the toggle pair rides in emit order", async () => {
    expect((await put(`${SUITE}/actions/workflows/ci.yml/disable`, "alice-token")).status).toBe(204);
    expect((await put(`${SUITE}/actions/workflows/ci.yml/enable`, "alice-token")).status).toBe(204);
    const rows = await drizzle(env.DB).select().from(auditEvents).all();
    expect(rows.map((r) => r.action)).toEqual(["actions:workflow:disable", "actions:workflow:enable"]);
    expect(rows[1]!.message).toBe("Enabled Actions workflow ci.yml in repository alice/actions-suite.");
    expect(JSON.parse(rows[1]!.metadata ?? "null")).toEqual({ workflow: "ci.yml" });
  });

  it("the dispatch arm emits actions:workflow:dispatch: the RAW ref + the numeric run_id", async () => {
    const res = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "main" }, "alice-token");
    expect(res.status).toBe(204);
    const rows = await drizzle(env.DB).select().from(auditEvents).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("actions:workflow:dispatch");
    expect(row.actorId).toBe(ALICE_ID);
    expect(row.actorCredential).toBe("access-token:11");
    expect(row.origin).toBe("api");
    expect(row.message).toBe("Dispatched Actions workflow ci.yml on main in repository alice/actions-suite.");
    const metadata = JSON.parse(row.metadata ?? "null") as { ref: string; run_id: number; workflow: string };
    // the RAW body ref, NOT the normalized branch ref the run row stores
    expect(metadata.ref).toBe("main");
    expect(metadata.workflow).toBe("ci.yml");
    const dispatched = (await drizzle(env.DB).select().from(actionRuns).where(eq(actionRuns.workflowId, "ci.yml")).all()).sort(
      (a, b) => b.index - a.index,
    )[0];
    expect(dispatched?.ref).toBe("refs/heads/main"); // the run row's normalization — the metadata's contrast
    expect(metadata.run_id).toBe(dispatched?.id); // numeric, upstream's int64 run.ID
  });

  it("the emit precedes the return_run_details branch (the 200 body's run id)", async () => {
    const res = await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "main" }, "alice-token", "?return_run_details=true");
    expect(res.status).toBe(200);
    const body = await res.json<{ workflow_run_id: number }>();
    const row = (await drizzle(env.DB).select().from(auditEvents).all())[0]!;
    expect(JSON.parse(row.metadata ?? "null")).toEqual({ ref: "main", run_id: body.workflow_run_id, workflow: "ci.yml" });
  });

  it("a failed write emits nothing (the 404/403 arms)", async () => {
    const auditRows = () => drizzle(env.DB).select().from(auditEvents).all();
    // the 404 workflow miss answers before the store write
    expect((await put(`${SUITE}/actions/workflows/ghost.yml/disable`, "alice-token")).status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
    // the writer-gate 403 never reaches the handler body
    expect((await put(`${SUITE}/actions/workflows/ci.yml/disable`, "bob-token")).status).toBe(403);
    expect(await auditRows()).toHaveLength(0);
    // the dispatch's ref miss 404s before the RecordAs tail
    expect((await post(`${SUITE}/actions/workflows/ci.yml/dispatches`, { ref: "nope" }, "alice-token")).status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
  });
});
