/**
 * The repo Actions WORKFLOW-FILE tail — the ui-parity survey's F-row tail
 * GET #2 (docs/compat/ui-parity-survey.md's F actions row): the run-viewer
 * "Workflow file" jump. NOT a page — a REDIRECT arm (the pulls-new-redirect
 * family shape); upstream renders no intermediate view either.
 *
 * Upstream pin (VERIFIED at fc4936884584a41931906553d96c2601d750e6ef):
 *
 *   - Route: web.go:1591 `m.Get("/workflow", actions.ViewWorkflowFile)`
 *     inside the `/runs/{run}` subgroup of the `/actions` group (group
 *     middleware `optSignIn, context.RepoAssignment, repo.MustBeNotEmpty,
 *     reqRepoActionsReader, actions.MustEnableActions`) — a READ arm.
 *   - Handler: view.go:242 `ViewWorkflowFile` → `getCurrentRunByPathParam`
 *     (view.go:60-73: "latest" → GetLatestRun, else GetRunByRepoAndID —
 *     ID-based only; the landed `resolveRunByPath` port) →
 *     - scoped runs (run.IsScopedRun) → `viewScopedWorkflowFile`
 *       (view.go:1421-1448): the SOURCE repo (run.WorkflowRepoID) is
 *       looked up, its code-unit read is permission-checked, and the
 *       redirect goes INTO THE SOURCE REPO at run.WorkflowCommitSHA;
 *     - plain runs: GetCommit(run.CommitSHA) →
 *       `actions.ListWorkflows` (modules/actions/workflows.go:75-115:
 *       the FIRST existing workflow dir of setting.Actions.WorkflowDirs —
 *       default `.gitea/workflows`, `.github/workflows` — its
 *       .yml/.yaml entries, upstream's recursive walk) → the entry whose
 *       `Name() == run.WorkflowID` →
 *       `ctx.Redirect("{repoLink}/src/commit/{sha}/{rpath}/{workflowID}")`
 *       (Base.Redirect's default — 303 See Other, base.go:157-168);
 *       NO match → ctx.NotFound (404); GetCommit miss → ctx.ServerError
 *       (500 — a deleted-commit run redirects nowhere, upstream does not
 *       soften it).
 *
 * ## The workflow-id spelling (the documented store divergence)
 *
 * Upstream stores run.WorkflowID as the workflow file's BARE name
 * ("ci.yml" — services/actions tests' fixtures) and matches
 * `entry.Name() == run.WorkflowID`. The M1a store's producers so far wrote
 * the PATH-spelled id (".github/workflows/ci.yml" — the model.ts test
 * harness, the fake-runner, the C2 fixtures). The match ports upstream's
 * comparison over the id's BASE SEGMENT (equal either way for upstream
 * spellings; path-spelled store rows resolve to their file), and the
 * redirect target is the MATCHED ENTRY's real path (`{rpath}/{entry.name}`)
 * — never the raw id — so both spellings land on the file view.
 *
 * ## The scoped arm (documented-unreachable in v1)
 *
 * v1 rows never carry isScopedRun (schema.ts default false, nothing sets
 * it — the C2 module's own note), and the scoped-workflow source family is
 * C10/post-M3. The arm is ported structurally against the landed columns
 * (workflow_repo_id + workflow_commit_sha): a missing source repo row is
 * upstream's GetRepositoryByID → ServerError (the `throw` outcome).
 * Upstream's `perm.CanRead(unit.TypeCode)` check has no landed unit-ACL
 * read seam (the run-viewer's grant posture — the grant IS the repo
 * resolution); the arm's permission gate is documented-unreachable with
 * the rest and rides C10.
 *
 * ## HANDOFF (the ui/index.ts mount — the integrator window's arms)
 *
 * 1. Interface: `RepoActionsRunViewRoute.family` gains
 *    `"actions-run-workflow"` (the tail shares the run-viewer's
 *    `{run}` shape).
 * 2. Parse arm (inside the `rest[0] === "runs"` block, beside the cancel
 *    literal): `if (rest.length === 3 && rest[2] === "workflow")
 *    return { family: "actions-run-workflow", owner, repo, run: rest[1] as string };`
 * 3. Import: `import { resolveActionsRunWorkflowFile }
 *    from "./pages/repo-actions-workflow";`
 * 4. Handler (the C2 read ladder; `actionsRunViewGate` is index.ts's shared
 *    helper):
 *
 *     async function actionsRunWorkflowRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
 *       const resolved = await resolveUiRequest(c);
 *       if (!resolved.ok) return resolved.response;
 *       const { ctx, repo, respond } = resolved;
 *       if (resolved.route.family !== "actions-run-workflow") return respond(await c.notFound()); // drift guard
 *       const gate = await actionsRunViewGate(c, resolved);
 *       if (gate !== null) return gate;
 *       const route = resolved.route;
 *       const outcome = await resolveActionsRunWorkflowFile(
 *         c.env.DB,
 *         engineReads(c.env, repo),
 *         repo,
 *         route.run ?? "",
 *         `/${repo.ownerNamespace}/${repo.slug}`,
 *       );
 *       if (outcome.outcome === "not-found") return respond(c.html(renderNotFound(ctx), 404));
 *       if (outcome.outcome === "throw") throw new Error(outcome.reason); // upstream's ctx.ServerError arm
 *       return respond(new Response(null, { status: 303, headers: { location: outcome.location } }));
 *     }
 *
 *    (`engineReads` is already imported in index.ts's api/services/engine
 *    line; the redirect is upstream's Base.Redirect 303 — NOT the 302 the
 *    legacy-index view arm uses, view.go's two Redirect calls differ.)
 * 5. Registration (the run-viewer subtree's block, static literals first):
 *    `uiRouter.get("/:owner/:repo/actions/runs/:run/workflow", (c) => actionsRunWorkflowRoute(c));`
 *    `uiRouter.post("/:owner/:repo/actions/runs/:run/workflow", () => methodNotAllowed("GET"));`
 * 6. The neighbor suite's re-arm: pages/repo-actions-view.test.tsx pins
 *    `/alice/demo/actions/runs/7/workflow` UNCLAIMED (the sibling-tails
 *    list, line ~245) — that pin flips when this registration lands
 *    (parse → the actions-run-workflow family, GET → 303/404/500 by arm).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories } from "../../db/schema";
import type { RunRow } from "../../services/actions/model";
import { pathEscapeSegments } from "../page-data";
import { resolveRunByPath } from "./repo-actions-view";

type D1 = D1Database;

/** setting.Actions.WorkflowDirs' default (actions.go:52 — the runs-list
 *  module's twin constant; kept in sync by shape). */
const WORKFLOW_DIRS = [".gitea/workflows", ".github/workflows"];

/** The engine read slice this arm consumes (the EngineClient/
 *  EngineReads shared shapes — structural, so either client fits). */
export interface WorkflowFileReads {
  readCommit(id?: string): Promise<{ oid: string } | null>;
  listTree(ref?: string, path?: string): Promise<{ oid: string; entries: Array<{ name: string; type: string }> } | null>;
}

/** The loader's repo subset (the caller's resolved row). */
export type WorkflowFileRepo = { id: string; ownerNamespace: string; slug: string; isEmpty: boolean };

export type ActionsRunWorkflowOutcome =
  | { outcome: "not-found" }
  | { outcome: "throw"; reason: string }
  | { outcome: "redirect"; location: string };

/**
 * The ViewWorkflowFile arm over one resolved run URL. The engine reads ride
 * the null-on-failure client: a transport `null` on the commit read is
 * upstream's GetCommit miss → the `throw` outcome (the ServerError class);
 * a `null` listTree is the dir miss upstream's SubTree walk continues from
 * (both dirs missing → the not-found arm).
 */
export async function resolveActionsRunWorkflowFile(
  d1: D1,
  reads: WorkflowFileReads,
  repo: WorkflowFileRepo,
  runRaw: string,
  repoLink: string,
): Promise<ActionsRunWorkflowOutcome> {
  // getCurrentRunByPathParam (view.go:60-73) — the landed resolution port.
  const run = await resolveRunByPath(d1, repo.id, runRaw);
  if (run === null) return { outcome: "not-found" };
  return resolveWorkflowFileForRun(d1, reads, repo, run, repoLink);
}

/** The handler body once the run row is in hand (the loader's second half,
 *  split so the scoped arm's source-repo read stays testable directly). */
async function resolveWorkflowFileForRun(
  d1: D1,
  reads: WorkflowFileReads,
  repo: WorkflowFileRepo,
  run: RunRow,
  repoLink: string,
): Promise<ActionsRunWorkflowOutcome> {
  if (run.isScopedRun) return viewScopedWorkflowFile(d1, reads, run);
  return plainWorkflowFileRedirect(reads, repo, run, repoLink);
}

/**
 * The plain arm (view.go:251-268): the commit read, the workflow-dir walk
 * (ListWorkflows — the first EXISTING dir wins, upstream's SubTree
 * miss-continues), the base-segment entry match, the 303 into
 * `/src/commit/{sha}/{rpath}/{file}`.
 */
async function plainWorkflowFileRedirect(
  reads: WorkflowFileReads,
  repo: WorkflowFileRepo,
  run: RunRow,
  repoLink: string,
): Promise<ActionsRunWorkflowOutcome> {
  // GetCommit (view.go:252-255) — a deleted/unborn commit is upstream's
  // ctx.ServerError, not a 404.
  const commit = await reads.readCommit(run.commitSha === "" ? undefined : run.commitSha);
  if (commit === null) {
    return { outcome: "throw", reason: `ViewWorkflowFile: GetCommit ${run.commitSha} not found` };
  }

  // ListWorkflows (workflows.go:75-115) — the engine's one-level listTree;
  // the nested-subdirectory case defers with the runs-list module's note.
  let dir: string | null = null;
  let entries: Array<{ name: string; type: string }> = [];
  for (const candidate of WORKFLOW_DIRS) {
    const tree = await reads.listTree(run.commitSha, candidate);
    if (tree !== null) {
      dir = candidate;
      entries = tree.entries;
      break;
    }
  }
  if (dir === null) return { outcome: "not-found" };

  // The entry match: upstream compares `entry.Name() == run.WorkflowID`
  // (both bare names); the store's path-spelled ids match on the base
  // segment (the module header's divergence note). The .yml/.yaml filter is
  // listWorkflowsInDirs' (workflows.go:110-113).
  const idBase = baseSegment(run.workflowId);
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml")) continue;
    if (entry.name !== idBase) continue;
    const location =
      `${repoLink}/src/commit/${encodeURIComponent(run.commitSha)}` +
      `/${pathEscapeSegments(dir)}/${pathEscapeSegments(entry.name)}`;
    return { outcome: "redirect", location };
  }
  return { outcome: "not-found" };
}

/** The path/id's last segment (upstream's bare-name identity). */
function baseSegment(id: string): string {
  const at = id.lastIndexOf("/");
  return at < 0 ? id : id.slice(at + 1);
}

/**
 * viewScopedWorkflowFile (view.go:1421-1448) — the redirect goes into the
 * SOURCE repo at the workflow commit. The source row's miss is upstream's
 * GetRepositoryByID → ServerError; the ListScopedWorkflows walk mirrors the
 * plain arm over the same default dirs (the scoped dirs are the C10 family's
 * landing — the module header's note).
 */
async function viewScopedWorkflowFile(
  d1: D1,
  reads: WorkflowFileReads,
  run: RunRow,
): Promise<ActionsRunWorkflowOutcome> {
  const sourceRows = await drizzle(d1)
    .select()
    .from(repositories)
    .where(eq(repositories.id, run.workflowRepoId))
    .limit(1);
  const source = sourceRows[0];
  if (source === undefined) {
    return { outcome: "throw", reason: `viewScopedWorkflowFile: GetRepositoryByID ${run.workflowRepoId} not found` };
  }
  const sourceLink = `/${source.ownerNamespace}/${source.slug}`;

  // GetCommit on the WORKFLOW commit (view.go:1435-1438).
  const commit = await reads.readCommit(run.workflowCommitSha === "" ? undefined : run.workflowCommitSha);
  if (commit === null) {
    return { outcome: "throw", reason: `viewScopedWorkflowFile: GetCommit ${run.workflowCommitSha} not found` };
  }

  let dir: string | null = null;
  let entries: Array<{ name: string; type: string }> = [];
  for (const candidate of WORKFLOW_DIRS) {
    const tree = await reads.listTree(run.workflowCommitSha, candidate);
    if (tree !== null) {
      dir = candidate;
      entries = tree.entries;
      break;
    }
  }
  if (dir === null) return { outcome: "not-found" };

  const idBase = baseSegment(run.workflowId);
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if (!entry.name.endsWith(".yml") && !entry.name.endsWith(".yaml")) continue;
    if (entry.name !== idBase) continue;
    const location =
      `${sourceLink}/src/commit/${encodeURIComponent(run.workflowCommitSha)}` +
      `/${pathEscapeSegments(dir)}/${pathEscapeSegments(entry.name)}`;
    return { outcome: "redirect", location };
  }
  return { outcome: "not-found" };
}
