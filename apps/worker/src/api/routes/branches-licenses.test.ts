/**
 * The branch-create license arm (POST /repos/{owner}/{repo}/branches,
 * repoCreateBranch) — services/repo-licenses.ts's settle leg over the
 * API-created default branch.
 *
 * UPSTREAM CONDITION this arm ports: upstream's API CreateBranch
 * (routers/api/v1/repo/branch.go:170-287) lands its branch through
 * CreateNewBranchFromCommit's internal push (services/repository/branch.go
 * :391-412), which flows into the shared push pipeline — whose license
 * enqueuer fires ONLY for the repo's default branch
 * (services/repository/push.go:161-175, `branch == repo.DefaultBranch`
 * inside `!opts.IsDelRef()`). SetRepoDefaultBranch is the API-side twin
 * (services/repository/branch.go:731-737): a default-branch change on a
 * non-empty repo enqueues the same updater (`if !repo.IsEmpty`). So a POST
 * that creates `refs/heads/<defaultBranch>` recalculates the license rows;
 * every other created branch leaves the table alone. Our POST's
 * assertNotEmpty (404 on an empty repo) holds branch.go:732's
 * `!repo.IsEmpty` guard by construction.
 *
 * SCENARIO (deterministic without engine gymnastics): a non-empty repo
 * whose D1 default_branch names a branch that does not exist as a ref yet
 * — the unborn default, the exact state the walk's unborn-tip guard exists
 * for. Creating that branch via POST moves the default tip from unborn to
 * the source commit WITHOUT any push receive: the "default-branch tip
 * moves via the API" delta this arm exists for.
 *
 * The routes mount LOCALLY (the engine-read.test.ts pattern — router.ts
 * registration is the orchestrator's deferred one-liner). In-process
 * app.request has no executionCtx, so the leg's waitUntil deferral falls
 * back to its inline arm and the rows are readable right after the 201.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";

import { ensureSeededRepo, type SeedCommit } from "../../ui/testing/seed-repo";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { getRepoLicenses } from "../../services/repo-licenses";
import { LICENSE_CORPUS_TEXTS } from "../../services/license-corpus";
import { repositories, users } from "../../db/schema";
import {
  createOptionalTokenAuthMiddleware,
  createTokenAuthMiddleware,
  STUB_USER,
  type AuthResolver,
} from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerBranchRoutes } from "./branches";
import type { User } from "../models/user";

const ORIGIN = "https://licensearm.test";
const TOKEN = "license-arm-token";
const OWNER = "licensearm";
const SLUG = "arm";
const T0 = 1_760_000_000;

const MIT = LICENSE_CORPUS_TEXTS.find(([id]) => id === "MIT")![1];

const SEED_COMMITS: SeedCommit[] = [
  {
    message: "seed: license carrier",
    time: T0,
    files: [
      { path: "README.md", content: "# license arm\n" },
      { path: "LICENSE", content: MIT },
    ],
  },
];

let OWNER_ID = 1;
let REPO_ID = "";
let TIP = "";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyAuthD1Migrations();
  const seeded = await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits: SEED_COMMITS });
  TIP = seeded.tips[0] as string;
  const user = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get();
  if (user === undefined) throw new Error("seed owner missing");
  OWNER_ID = user.id;
  const repo = await drizzle(env.DB)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, SLUG)))
    .get();
  if (repo === undefined) throw new Error("seed repo missing");
  REPO_ID = repo.id;
  // The seed push's own onPush license settle rides the engine's waitUntil —
  // let it land (the seed commit carries the MIT LICENSE, so the push arm
  // writes a row), then clear the table: every test below starts from a
  // clean slate no background settle can re-write mid-test.
  for (let i = 0; i < 100 && (await licenseRows()).length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await env.DB.prepare("DELETE FROM repo_license").run();
});

function identity(): User {
  return { ...STUB_USER, id: OWNER_ID, login: OWNER, full_name: OWNER, created: new Date(T0 * 1000).toISOString() };
}

const resolver: AuthResolver = { resolveToken: (token) => Promise.resolve(token === TOKEN ? identity() : null) };

function app(): OpenAPIHono<ApiEnv> {
  const a = new OpenAPIHono<ApiEnv>();
  a.onError(giteaErrorHandler);
  registerBranchRoutes(a, createTokenAuthMiddleware(resolver), createOptionalTokenAuthMiddleware(resolver));
  return a;
}

const jsonInit = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** In-process request with the real bindings (the engine-read harness shape). */
const send = async (body: unknown): Promise<Response> =>
  app().fetch(new Request(`${ORIGIN}/repos/${OWNER}/${SLUG}/branches`, jsonInit(body)), env);

/** Point the D1 default_branch at an unborn branch name (the non-empty repo
 *  whose default does not exist as a ref yet). */
async function setDefaultBranch(branch: string): Promise<void> {
  await drizzle(env.DB).update(repositories).set({ defaultBranch: branch }).where(eq(repositories.id, REPO_ID));
}

async function licenseRows(): Promise<Array<{ license: string; licensePath: string; commitId: string | null }>> {
  const rows = await getRepoLicenses(env.DB, REPO_ID);
  return rows.map((row) => ({ license: row.license, licensePath: row.licensePath, commitId: row.commitId }));
}

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM repo_license").run();
});

describe("POST /repos/{owner}/{repo}/branches — the default-branch license arm", () => {
  it("creating the repo's (unborn) default branch recalculates the license rows at the new tip", async () => {
    await setDefaultBranch("reborn");
    const res = await send({ new_branch_name: "reborn", old_branch_name: "main" });
    expect(res.status).toBe(201);
    expect(await licenseRows()).toEqual([{ license: "MIT", licensePath: "LICENSE", commitId: TIP }]);
  });

  it("a non-default branch creation leaves the license table alone (push.go:161-175's else-arm)", async () => {
    await setDefaultBranch("reborn"); // stays unborn — "topic" is not it
    const res = await send({ new_branch_name: "topic", old_branch_name: "main" });
    expect(res.status).toBe(201);
    expect(await licenseRows()).toEqual([]);
  });
});
