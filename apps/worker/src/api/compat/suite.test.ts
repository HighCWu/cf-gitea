/**
 * The dynamic compat suite (SPEC-0004 §5 stage 3): every IMPLEMENTED tier-1
 * operation runs against the real router in-process and must PASS its golden
 * fixture assertions; unimplemented operations are SKIPPED with an explicit
 * list; the coverage counters equal `pnpm check:api`'s stage-(c) line by
 * construction (same generated OpenAPI document, same appendix-A fixtures,
 * same algorithm — asserted in the bookkeeping block below).
 *
 * Implemented-set discipline: the implemented set is enumerated DYNAMICALLY
 * from the router's own OpenAPI document and intersected with the fixtures, so
 * a parallel route batch landing more tier-1 paths is tolerated — but each new
 * implemented operation registers a LOUD "no scenario" failure until someone
 * extends SCENARIOS, keeping the suite at parity with the routes.
 *
 * Environment: real local D1 (migrations applied in beforeAll via the
 * src/auth/testing helper pattern, plus the org DDL bootstrap the org service
 * still carries until its drizzle migration lands), deterministic seeds
 * (fixed ids/dates, shared read fixtures, write ops on unique slugs). The
 * router mounts no auth middleware from src/index.ts here — the suite injects
 * its own resolver at the createApiRouter seam so the token resolves to the
 * seeded owner row.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import contractRaw from "../../compat/contract/v1-swagger.generated.json?raw";
import { milestones, repositories, users } from "../../db/schema";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { applyOrgsDdl } from "../../services/orgs/testing";
import { OrgService } from "../../services/orgs/orgs";
import { STUB_USER } from "../auth";
import { createRepoHook } from "../services/hooks";
import { createRepoLabel } from "../services/labels";
import { createCommitStatus } from "../services/commit-status";
import type { User } from "../models/user";
import { getGeneratedSpec } from "../openapi";
import { createApiRouter } from "../router";
import {
  TIER1_EXPECTED_OPERATIONS,
  TIER1_EXPECTED_PATHS,
  parseSwagger2Contract,
  parseTier1Fixtures,
  type Swagger2Method,
} from "./gen-fixtures";
import fixturesRaw from "./tier1-fixtures.json?raw";
import {
  formatCoverage,
  implementedOperations,
  operationKey,
  runCompatSuite,
  type CompatRequest,
  type CompatRequestSender,
  type CompatScenarioCase,
  type CompatScenarioContext,
  type CompatSuiteReport,
} from "./suite";

// ---------------------------------------------------------------------------
// Parsed inputs + the dynamically enumerated implemented set.
// ---------------------------------------------------------------------------

const contract = parseSwagger2Contract(contractRaw);
const fixtures = parseTier1Fixtures(fixturesRaw);
const implemented = implementedOperations(getGeneratedSpec());
const fixtureKeys = new Set(fixtures.operations.map((operation) => operationKey(operation)));

// ---------------------------------------------------------------------------
// Deterministic seeds (fixed ids/dates; writes below use unique slugs).
// ---------------------------------------------------------------------------

const ORIGIN = "https://compat.local";
const TOKEN = "compat-suite-token";
const OWNER = "CompatOwner";
const ORG = "CompatOrg";
/** Full-length commit id the status fixtures hang off (the api layer resolves
 * refs verbatim this wave — see routes/statuses.ts). */
const SEED_SHA = "0123456789abcdef0123456789abcdef01234567";
const SEED_NOW = new Date("2026-01-05T06:07:08Z");
const SHARED_REPO_ID = "9001";

/** Seed handles the scenarios interpolate into request paths. */
const seeds: Record<string, string | number> = {
  token: TOKEN,
  owner: OWNER,
  org: ORG,
  repoOwner: OWNER.toLowerCase(),
  repoSlug: "shared",
  sha: SEED_SHA,
};

/**
 * The api-layer identity the suite token resolves to — the seeded owner row
 * rendered through the contract User model (STUB_USER carries the exact
 * field set; id/login are re-pointed at the D1 row so doer-scoped routes —
 * /user/repos, /user/orgs, org-repo creation — see the seeded principal).
 */
function suiteIdentity(): User {
  const ownerId = seeds.ownerId;
  if (typeof ownerId !== "number") {
    throw new Error("suite seeds not applied — beforeAll has not run");
  }
  return { ...STUB_USER, id: ownerId, login: OWNER, full_name: OWNER, created: SEED_NOW.toISOString() };
}

/** Fresh in-process router per request, real test-worker bindings (no SELF.fetch). */
const send: CompatRequestSender = (request: CompatRequest): Promise<Response> => {
  const app = createApiRouter({
    auth: { resolveToken: (token) => Promise.resolve(token === TOKEN ? suiteIdentity() : null) },
  });
  return Promise.resolve(app.fetch(new Request(`${ORIGIN}${request.path}`, request.init), env));
};

async function seedUser(username: string): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      createdAt: SEED_NOW,
    })
    .returning({ id: users.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error(`user seed failed: ${username}`);
  return row.id;
}

async function seedRepo(id: string, ownerNamespace: string, slug: string): Promise<void> {
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    slug,
    visibility: "public",
    refsVersion: 0, // repoTestHook's early-204 (no commits) and empty:true stay deterministic
    backend: "self-hosted",
    numIssues: 3,
    numPulls: 1,
    createdAt: SEED_NOW,
  });
}

async function seedMilestone(repoId: string, name: string): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(milestones)
    .values({ repoId, name, content: "", createdAt: SEED_NOW, updatedAt: SEED_NOW })
    .returning({ id: milestones.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error(`milestone seed failed: ${name}`);
  return row.id;
}

async function seedHook(repoId: string, name: string, url: string, events: string[]): Promise<number> {
  const row = await createRepoHook(env.DB, repoId, {
    type: "gitea",
    branch_filter: "*",
    config: { url, content_type: "json" },
    events,
    active: false,
  });
  return row.id;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
  // Org tables are not in the generated migrations yet (schema.ts is owned by
  // another change) — the SPEC-0007 test-side DDL bootstrap fills the gap.
  await applyOrgsDdl();

  const ownerId = await seedUser(OWNER);
  await seedUser("CompatNeighbor"); // second user so /users/search paginates
  const orgs = new OrgService(env.DB);
  await orgs.createOrg({ name: ORG, ownerId, fullName: "Compat Org", now: SEED_NOW });

  await seedRepo(SHARED_REPO_ID, OWNER.toLowerCase(), "shared"); // the shared read fixture
  await seedRepo("9002", OWNER.toLowerCase(), "second"); // second repo → list pagination
  await seedRepo("9003", ORG.toLowerCase(), "org-shared"); // org listing fixture

  const labelA = await createRepoLabel(env.DB, SHARED_REPO_ID, {
    name: "alpha",
    exclusive: false,
    color: "#aa0000",
    description: "seed label alpha",
    isArchived: false,
    now: SEED_NOW,
  });
  const labelB = await createRepoLabel(env.DB, SHARED_REPO_ID, {
    name: "beta",
    exclusive: false,
    color: "#00aa00",
    description: "seed label beta",
    isArchived: false,
    now: SEED_NOW,
  });

  const milestoneA = await seedMilestone(SHARED_REPO_ID, "alpha");
  const milestoneB = await seedMilestone(SHARED_REPO_ID, "beta");

  const hookA = await seedHook(SHARED_REPO_ID, "push-hook", "https://hooks.invalid/compat-a", ["push"]);
  const hookB = await seedHook(SHARED_REPO_ID, "issues-hook", "https://hooks.invalid/compat-b", ["issues"]);

  await createCommitStatus(env.DB, {
    repoId: SHARED_REPO_ID,
    sha: SEED_SHA,
    state: "success",
    targetUrl: "https://ci.invalid/compat/1",
    description: "compat suite seed status",
    context: "ci/compat",
    creatorId: ownerId,
  });

  Object.assign(seeds, {
    ownerId,
    repoId: SHARED_REPO_ID,
    labelA: labelA.id,
    labelB: labelB.id,
    milestoneA,
    milestoneB,
    hookA,
    hookB,
  });
});

// ---------------------------------------------------------------------------
// Scenarios — one or more executable cases per IMPLEMENTED operationId.
// Each case drives a known status and is self-contained (write ops use their
// own entities so case order never matters). Extend this table — plus seeds —
// when a route batch lands; the harness fails an implemented-but-scenario-less
// operation loudly until then.
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" };

const repoPath = (ctx: CompatScenarioContext): string =>
  `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.repoSlug)}`;

const SCENARIOS: Readonly<Record<string, readonly CompatScenarioCase[]>> = {
  getVersion: [{ name: "instance version", status: 200, request: () => ({ path: "/version" }) }],

  userGetCurrent: [
    { name: "token identity", status: 200, request: (ctx) => ({ path: "/user", init: ctx.withAuth() }) },
    {
      // Runtime-only status: upstream reqToken() rejects anonymous callers and
      // the vendored swagger documents only 200 (RUNTIME_ONLY_RESPONSES).
      name: "anonymous → runtime-only 401",
      status: 401,
      request: () => ({ path: "/user" }),
    },
  ],
  userSearch: [
    {
      name: "first page",
      status: 200,
      linkRels: ["next", "last"],
      request: () => ({ path: "/users/search?limit=1" }),
    },
  ],
  userGet: [
    { name: "seeded owner", status: 200, request: (ctx) => ({ path: `/users/${String(ctx.seeds.owner)}` }) },
    {
      // The 404 empty family: the contract declares no body, but upstream's
      // APIErrorNotFound marshals {message, url} at runtime — the suite
      // accepts both (documented conversion in suite.ts).
      name: "missing user → runtime-body 404",
      status: 404,
      request: () => ({ path: "/users/ghost" }),
    },
  ],
  userListRepos: [
    {
      name: "first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: `/users/${String(ctx.seeds.repoOwner)}/repos?limit=1` }),
    },
  ],
  userCurrentListRepos: [
    {
      name: "first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: "/user/repos?limit=1", init: ctx.withAuth() }),
    },
  ],

  repoGet: [
    { name: "seeded repo", status: 200, request: (ctx) => ({ path: repoPath(ctx) }) },
    {
      name: "missing repo → runtime-body 404",
      status: 404,
      request: (ctx) => ({ path: `/repos/${String(ctx.seeds.repoOwner)}/ghost` }),
    },
  ],
  repoSearch: [
    {
      name: "two keyword hits, first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({
        path: `/repos/search?q=${String(ctx.seeds.repoOwner)}/shared,${String(ctx.seeds.repoOwner)}/second&limit=1`,
      }),
    },
    {
      name: "invalid mode",
      status: 422,
      request: () => ({ path: "/repos/search?mode=bogus" }),
    },
  ],
  repoGetByID: [
    {
      name: "seeded repo id",
      status: 200,
      request: (ctx) => ({ path: `/repositories/${String(ctx.seeds.repoId)}`, init: ctx.withAuth() }),
    },
  ],

  repoListStatuses: [
    {
      name: "seeded sha statuses",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/statuses/${String(ctx.seeds.sha)}?limit=1` }),
    },
  ],
  repoCreateStatus: [
    {
      name: "create on the seeded sha",
      status: 201,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/statuses/${String(ctx.seeds.sha)}`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ state: "success", context: "ci/suite", description: "compat suite status", target_url: "" }),
        }),
      }),
    },
  ],
  repoListStatusesByRef: [
    {
      name: "seeded sha as ref",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/commits/${String(ctx.seeds.sha)}/statuses?limit=1` }),
    },
  ],
  repoGetCombinedStatusByRef: [
    {
      name: "seeded sha as ref",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/commits/${String(ctx.seeds.sha)}/status?limit=1` }),
    },
  ],

  issueListLabels: [
    {
      name: "first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: `${repoPath(ctx)}/labels?limit=1` }),
    },
  ],
  issueCreateLabel: [
    {
      name: "create",
      status: 201,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/labels`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "compat-created", color: "#00aa00", description: "created by the compat suite" }),
        }),
      }),
    },
    {
      name: "invalid color",
      status: 422,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/labels`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "compat-invalid", color: "not-a-color" }),
        }),
      }),
    },
  ],
  issueGetLabel: [
    {
      name: "seeded label",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/labels/${String(ctx.seeds.labelA)}` }),
    },
  ],
  issueEditLabel: [
    {
      name: "edit seeded label",
      status: 200,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/labels/${String(ctx.seeds.labelA)}`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ description: "edited by the compat suite" }),
        }),
      }),
    },
  ],
  issueDeleteLabel: [
    {
      name: "delete seeded label",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/labels/${String(ctx.seeds.labelB)}`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],

  issueGetMilestonesList: [
    {
      name: "first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: `${repoPath(ctx)}/milestones?limit=1` }),
    },
  ],
  issueCreateMilestone: [
    {
      name: "create",
      status: 201,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/milestones`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ title: "compat-created", description: "created by the compat suite" }),
        }),
      }),
    },
  ],
  issueGetMilestone: [
    {
      name: "seeded milestone",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/milestones/${String(ctx.seeds.milestoneA)}` }),
    },
  ],
  issueEditMilestone: [
    {
      name: "edit seeded milestone",
      status: 200,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/milestones/${String(ctx.seeds.milestoneA)}`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ description: "edited by the compat suite" }),
        }),
      }),
    },
  ],
  issueDeleteMilestone: [
    {
      name: "delete seeded milestone",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/milestones/${String(ctx.seeds.milestoneB)}`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],

  repoListHooks: [
    {
      name: "first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: `${repoPath(ctx)}/hooks?limit=1`, init: ctx.withAuth() }),
    },
  ],
  repoCreateHook: [
    {
      name: "create",
      status: 201,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/hooks`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            type: "gitea",
            config: { url: "https://hooks.invalid/compat-created", content_type: "json" },
            events: ["push"],
          }),
        }),
      }),
    },
  ],
  repoGetHook: [
    {
      name: "seeded hook",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/hooks/${String(ctx.seeds.hookA)}`, init: ctx.withAuth() }),
    },
  ],
  repoEditHook: [
    {
      name: "edit seeded hook",
      status: 200,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/hooks/${String(ctx.seeds.hookA)}`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ events: ["push", "issues"] }),
        }),
      }),
    },
  ],
  repoDeleteHook: [
    {
      name: "delete seeded hook",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/hooks/${String(ctx.seeds.hookB)}`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],
  repoTestHook: [
    {
      name: "no commits → silent 204",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/hooks/${String(ctx.seeds.hookA)}/tests`,
        init: ctx.withAuth({ method: "POST" }),
      }),
    },
  ],
  repoListHookDeliveries: [
    {
      name: "seeded hook log",
      status: 200,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/hooks/${String(ctx.seeds.hookA)}/deliveries?limit=1`,
        init: ctx.withAuth(),
      }),
    },
  ],

  orgListCurrentUserOrgs: [
    {
      name: "owner membership",
      status: 200,
      request: (ctx) => ({ path: "/user/orgs?limit=1", init: ctx.withAuth() }),
    },
  ],
  orgListRepos: [
    {
      name: "seeded org repos",
      status: 200,
      request: (ctx) => ({ path: `/orgs/${String(ctx.seeds.org)}/repos?limit=1` }),
    },
  ],
  createOrgRepo: [
    {
      name: "create in the seeded org",
      status: 201,
      request: (ctx) => ({
        path: `/orgs/${String(ctx.seeds.org)}/repos`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "compat-org-write", description: "created by the compat suite", private: false }),
        }),
      }),
    },
  ],

  renderMarkdown: [
    {
      name: "render",
      status: 200,
      request: (ctx) => ({
        path: "/markdown",
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ Text: "# compat", Mode: "markdown" }),
        }),
      }),
    },
    {
      name: "invalid option",
      status: 422,
      request: (ctx) => ({
        path: "/markdown",
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ Text: 123 }),
        }),
      }),
    },
    {
      // Runtime-only status: unparseable JSON dies in hono's validator before
      // the route's 422 hook (documented divergence, RUNTIME_ONLY_RESPONSES).
      name: "malformed json → runtime-only 400",
      status: 400,
      request: (ctx) => ({
        path: "/markdown",
        init: ctx.withAuth({ method: "POST", headers: JSON_HEADERS, body: "{not json" }),
      }),
    },
  ],
  renderMarkdownRaw: [
    {
      name: "render raw",
      status: 200,
      request: (ctx) => ({
        path: "/markdown/raw",
        init: ctx.withAuth({ method: "POST", headers: { "Content-Type": "text/plain" }, body: "# compat raw" }),
      }),
    },
  ],
};

// ---------------------------------------------------------------------------
// The suite run + its bookkeeping/consistency assertions.
// ---------------------------------------------------------------------------

let report: CompatSuiteReport | undefined;

describe("dynamic compat suite — implemented tier-1 operations vs golden fixtures (SPEC-0004 §5.3)", () => {
  report = runCompatSuite({ contract, fixtures, implemented, scenarios: SCENARIOS, seeds, send });
});

describe("compat suite bookkeeping (check:api consistency)", () => {
  it("ran every implemented fixture operation and skipped exactly the unimplemented ones", () => {
    if (report === undefined) {
      throw new Error("compat suite did not run");
    }
    expect(report.ran.length + report.skipped.length).toBe(fixtures.operations.length);
    for (const key of report.ran) {
      expect(implemented.has(key), `${key} recorded as ran but not implemented`).toBe(true);
    }
    for (const key of report.skipped) {
      expect(implemented.has(key), `${key} recorded as skipped but implemented`).toBe(false);
    }
    // An implemented operation without a scenario registers its own loud
    // failure above; the report must stay empty for the suite to be green.
    expect(report.missingScenarios).toEqual([]);
  });

  it("counts tier-1 coverage exactly like pnpm check:api", () => {
    if (report === undefined) {
      throw new Error("compat suite did not run");
    }
    // Independent recomputation of check:api's stage (c): operations count
    // individually; a PATH counts only when every fixture method is served.
    let coveredPaths = 0;
    const paths = new Map<string, string[]>();
    for (const operation of fixtures.operations) {
      const methods = paths.get(operation.path) ?? [];
      methods.push(operation.method);
      paths.set(operation.path, methods);
    }
    for (const [path, methods] of paths) {
      if (methods.every((method) => implemented.has(`${method} ${path}`))) {
        coveredPaths += 1;
      }
    }
    const coveredOperations = [...fixtureKeys].filter((key) => implemented.has(key)).length;

    expect(report.coverage.coveredPaths).toBe(coveredPaths);
    expect(report.coverage.coveredOperations).toBe(coveredOperations);
    expect(report.coverage.coveredOperations).toBe(report.ran.length);
    expect(coveredOperations).toBeGreaterThan(0);

    // The totals are the SPEC-0004 appendix-A tier-1 sizes (the numbers
    // check:api denominates against).
    expect(report.coverage.totalPaths).toBe(TIER1_EXPECTED_PATHS);
    expect(report.coverage.totalOperations).toBe(TIER1_EXPECTED_OPERATIONS);
    // And the rendered line matches check:api's report format.
    expect(formatCoverage(report.coverage)).toMatch(
      new RegExp(`^${coveredPaths}/${TIER1_EXPECTED_PATHS} paths, ${coveredOperations}/${TIER1_EXPECTED_OPERATIONS} operations$`, "u"),
    );
  });

  it("stays inside the frozen contract, including implemented non-fixture additions", () => {
    if (report === undefined) {
      throw new Error("compat suite did not run");
    }
    // check:api stage (a), re-asserted at runtime: every served route exists
    // in the vendored contract (tier-2 landings by parallel batches show up
    // in report.outOfSuite and are tolerated — they simply have no fixture).
    for (const key of implemented) {
      const [method, path] = key.split(" ");
      if (!isHttpMethod(method) || path === undefined) {
        throw new Error(`malformed implemented-operation key: ${key}`);
      }
      expect(contract.paths[path]?.[method], `${key} is served without a frozen-contract entry`).toBeDefined();
    }
    for (const key of report.outOfSuite) {
      expect(fixtureKeys.has(key), `${key} reported out-of-suite but has a fixture`).toBe(false);
    }
  });
});

/** Methods that can carry an operation in a Swagger 2.0 paths object. */
const HTTP_METHODS: readonly string[] = ["get", "put", "post", "delete", "options", "head", "patch"];

function isHttpMethod(value: string | undefined): value is Swagger2Method {
  return value !== undefined && HTTP_METHODS.includes(value);
}
