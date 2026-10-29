/**
 * The repo Actions WORKFLOW-DISPATCH-INPUTS aux fragment — the ui-parity
 * survey's F-row tail GET #4 (docs/compat/ui-parity-survey.md's F actions
 * row): the dispatch modal's inputs body the official bundle fetches when
 * the branch dropdown changes. NOT a page and NOT JSON — upstream serves an
 * HTML template FRAGMENT (the survey brief's "aux JSON" is a description
 * slip: `ctx.HTML(http.StatusOK, tplDispatchInputsActions)` renders
 * `repo/actions/workflow_dispatch_inputs.tmpl`, the `#runWorkflowDispatchModalInputs`
 * div the `data-fetch-sync` consumer swaps in).
 *
 * Upstream pin (VERIFIED at fc4936884584a41931906553d96c2601d750e6ef):
 *
 *   - Route: web.go:1572 `m.Get("/workflow-dispatch-inputs",
 *     reqRepoActionsWriter, actions.WorkflowDispatchInputs)` — the /actions
 *     group's read ladder PLUS the writer gate (reqRepoActionsWriter's
 *     NotFound: an anonymous/not-authorized fetch 404-shells, never the
 *     login 303 — the C2 cancel arm's fetch posture).
 *   - Handler: routers/web/repo/actions/actions.go:173-204 — `?ref=` EMPTY
 *     → ctx.NotFound (404); the ref must be a FULL ref name —
 *     `refs/tags/*` → GetTagCommit, `refs/heads/*` → GetBranchCommit,
 *     anything else → ctx.ServerError("UnsupportedRefType") (500); a
 *     commit miss → ServerError (500). Then
 *     prepareWorkflowTemplate (actions.go:206-261: ListWorkflows at the
 *     commit, each content parsed with jobparser.ReadWorkflow +
 *     GetEventsFromContent, the invalid_workflow_helper ErrMsg texts) +
 *     prepareWorkflowDispatchTemplate (actions.go:400-…: the `?workflow=`
 *     id locates the current file, ActionsConfig's disabled check, then
 *     `WorkflowDispatchConfig()`/`WorkflowDispatchInputs()` (the act model:
 *     actionslib/pkg/model/workflow.go:139-178 — the `on:` mapping's
 *     `workflow_dispatch` entry, its inputs in DECLARATION order) fill
 *     the template data.
 *   - Template: repo/actions/workflow_dispatch_inputs.tmpl — the error
 *     message arm (`actions.workflow.not_found` when the workflow id is
 *     absent from the listed set; `has_no_workflow_dispatch` when it
 *     parses but declares no workflow_dispatch trigger), the per-input
 *     fields (choice → select+options; boolean → checkbox, checked on the
 *     exact `true`/`True`/`TRUE` default; number → type=number step=any;
 *     else the text input; `required` → the field class + attribute), the
 *     submit button ("actions.workflow.run"), and the current workflow's
 *     ErrMsg alert (octicon-alert, the tw-text-red class).
 *
 * ## Documented divergences (§6 method — each cites its upstream arm)
 *
 * - The jobparser validation pass is the LIGHT check (the runs-list
 *   module's `workflowInfoFromContent` precedent — the full act/jobparser
 *   port is M3's dispatch arm): unparseable YAML, a non-mapping root, or a
 *   `jobs:` that is not a mapping carry the invalid_workflow_helper text;
 *   the shallow needs scan ports the two structural ErrMsg arms that need
 *   no expression machinery (a workflow whose every job has `needs:` →
 *   "actions.runs.no_job_without_needs"; a workflow with only null jobs →
 *   "actions.runs.no_job", the later assignment winning exactly upstream's
 *   sequential ifs). The reusable-`uses:` resolution arm (actions.go:243)
 *   needs actions_service.ResolveUses — M3.
 * - The ActionsConfig disabled-workflow check (actions.go:415) rides the
 *   unlanded repo ActionsConfig store — always false here (the C1 module's
 *   same note); the early-return arm is unreachable.
 * - The scoped-workflow arm (`?scoped_workflow_source_repo_id` > 0,
 *   actions.go:409-423 → loadScopedWorkflowModel's source-repo walk) has no
 *   store substrate in v1 (the scoped family is C10/post-M3, isScopedRun is
 *   never written) → ctx.NotFound (404) — the documented reduction, never a
 *   fabricated source walk.
 * - Inputs parse through the landed `yaml` package (YAML 1.2 core — the
 *   `on:` key is the plain string; gopkg.in/yaml.v3's resolution, act's
 *   parser) with `mapAsMap` so input names keep DECLARATION order (JS
 *   objects would reorder numeric-like keys; Go's map+node-walk exists for
 *   the same reason). Merge keys resolve by the parser (upstream expands
 *   `<<:` in place — same result, different machinery).
 *
 * ## HANDOFF (the ui/index.ts mount — the integrator window's arms)
 *
 * 1. Interface: a NEW one-shape family:
 *
 *     export interface RepoActionsDispatchInputsRoute {
 *       family: "repo-actions-dispatch-inputs";
 *       owner: string;
 *       repo: string;
 *     }
 *
 * 2. Parse arm (the `/actions` block — BEFORE nothing in particular; the
 *    literal third segment is disjoint from `runs`/`workflows`):
 *    `if (head === "actions" && rest.length === 1 && rest[0] === "workflow-dispatch-inputs")
 *    return { family: "repo-actions-dispatch-inputs", owner, repo };`
 * 3. Import: `import { loadWorkflowDispatchInputsFragment }
 *    from "./pages/repo-actions-dispatch-inputs";`
 * 4. Handler (the C1 read ladder PLUS the writer gate — the C2 cancel
 *    arm's fetch posture; GET-only upstream so no sameOriginGuard):
 *
 *     async function repoActionsDispatchInputsRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
 *       const resolved = await resolveUiRequest(c);
 *       if (!resolved.ok) return resolved.response;
 *       const { ctx, url, viewer, repo, respond } = resolved;
 *       if (resolved.route.family !== "repo-actions-dispatch-inputs") return respond(await c.notFound()); // drift guard
 *       if (repo.isEmpty) return respond(c.html(renderNotFound(ctx), 404));
 *       const settings = await loadRepoSettings(c.env.DB, repo.id);
 *       if (!settings.hasActions) return respond(c.html(renderNotFound(ctx), 404));
 *       if (viewer.kind !== "user" || !(await canWriteRepo(c.env, repo, viewer))) {
 *         return respond(c.html(renderNotFound(ctx), 404)); // reqRepoActionsWriter's NotFound
 *       }
 *       const outcome = await loadWorkflowDispatchInputsFragment({
 *         reads: engineClient(c.env, `${repo.ownerNamespace}/${repo.slug}`),
 *         repo,
 *         ref: url.searchParams.get("ref") ?? "",
 *         workflow: url.searchParams.get("workflow") ?? "",
 *         scopedWorkflowSourceRepoId: formInt64(url.searchParams.get("scoped_workflow_source_repo_id")),
 *       });
 *       if (outcome.status === "not-found") return respond(c.html(renderNotFound(ctx), 404));
 *       if (outcome.status === "throw") throw new Error(outcome.reason); // upstream's ctx.ServerError arm
 *       return respond(c.html(outcome.html, 200));
 *     }
 *
 *    (formInt64: digits parse, junk → 0 — FormInt64's convention, the
 *    runs-list module's note.)
 * 5. Registration (the `/actions` group's block — web.go:1572 registers
 *    beside the group's static literals):
 *    `uiRouter.get("/:owner/:repo/actions/workflow-dispatch-inputs", (c) => repoActionsDispatchInputsRoute(c));`
 *    `uiRouter.post("/:owner/:repo/actions/workflow-dispatch-inputs", () => methodNotAllowed("GET"));`
 * 6. The neighbor suites' re-arm: pages/repo-actions-runs.matrix.test.tsx
 *    (the sibling-tails list, line ~1028) and pages/repo-actions-view.test.tsx
 *    (line ~252) BOTH pin `/actions/workflow-dispatch-inputs` UNCLAIMED —
 *    those pins flip when this registration lands (parse → the family, an
 *    authorized GET → the fragment/404/500 by arm).
 */

import { renderToString } from "hono/jsx/dom/server";
import { parse as yamlParse } from "yaml";

import { Icon } from "../shell";

// ---------------------------------------------------------------------------
// The fragment's locale (the template's ctx.Locale.Tr keys, en-US at the pin)
// ---------------------------------------------------------------------------

export const workflowDispatchInputsLocale = {
  notFound: "Workflow '%s' not found.", // "actions.workflow.not_found"
  hasNoWorkflowDispatch: "Workflow '%s' has no workflow_dispatch event trigger.", // "actions.workflow.has_no_workflow_dispatch"
  run: "Run Workflow", // "actions.workflow.run"
  invalidWorkflowHelper: "Workflow config file is invalid. Please check your config file: %s", // "actions.runs.invalid_workflow_helper"
  noJobWithoutNeeds: "The workflow must contain at least one job without dependencies.", // "actions.runs.no_job_without_needs"
  noJob: "The workflow must contain at least one job", // "actions.runs.no_job"
} as const;

/** Go fmt %s substitution (TrString's arg arm — one string arg each). */
function tr(text: string, arg: string): string {
  return text.replace("%s", arg);
}

// ---------------------------------------------------------------------------
// The workflow_dispatch parse (actionslib/pkg/model/workflow.go:105-178,
// over the landed yaml package)
// ---------------------------------------------------------------------------

/** WorkflowDispatchInput (workflow.go:105-112) — the modal's field model. */
export interface WorkflowDispatchInput {
  name: string;
  description: string;
  required: boolean;
  default: string;
  type: string;
  options: string[];
}

export interface WorkflowDispatchParse {
  /** The light-validation ErrMsg (the invalid_workflow_helper/no_job arms
   *  of prepareWorkflowTemplate) — null when the file parsed clean. */
  errMsg: string | null;
  /** WorkflowDispatchConfig() — the `on: workflow_dispatch` declaration,
   *  null when there is none (the has_no_workflow_dispatch arm). */
  dispatch: { inputs: WorkflowDispatchInput[] } | null;
}

/** The yaml package parses to `Map<any, any>` under `mapAsMap` — every map
 *  level re-types through this cast so no `any` ever flows out (the lint's
 *  no-unsafe-assignment rule). */
function asUnknownMap(value: unknown): Map<unknown, unknown> | null {
  return value instanceof Map ? (value as Map<unknown, unknown>) : null;
}

/** A YAML sequence of scalars → its string members (the act decode's
 *  options list; non-strings drop). */
function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item === "string") out.push(item);
  }
  return out;
}

/**
 * ReadWorkflow's light arm + WorkflowDispatchConfig/WorkflowDispatchInputs
 * over one workflow file's content. The `on:` shapes mirror the act model's
 * node walk: a sequence or scalar listing "workflow_dispatch" → a config
 * with NO inputs; a mapping → the `workflow_dispatch` entry decoded (null →
 * no inputs; a mapping → the inputs in declaration order; any other shape →
 * decode failure → no config).
 */
export function parseWorkflowDispatchInputs(content: string): WorkflowDispatchParse {
  const invalid = (detail: string): WorkflowDispatchParse => ({
    errMsg: tr(workflowDispatchInputsLocale.invalidWorkflowHelper, detail),
    dispatch: null,
  });

  let parsed: unknown;
  try {
    // mapAsMap: input names keep DECLARATION order (the module header's
    // note); merge keys resolve by the parser.
    parsed = yamlParse(content, { mapAsMap: true });
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  const root = asUnknownMap(parsed);
  if (root === null) {
    return invalid("not a mapping");
  }

  // The jobs light check (the runs-list module's workflowInfoFromContent
  // arm) + the shallow needs scan (actions.go:246-259's structural arms).
  const jobs = asUnknownMap(root.get("jobs"));
  if (jobs === null) {
    return invalid("jobs is not a mapping");
  }
  let hasJobWithoutNeeds = false;
  let emptyJobsNumber = 0;
  for (const job of jobs.values()) {
    const jobMap = asUnknownMap(job);
    if (jobMap === null) {
      emptyJobsNumber += 1;
      continue;
    }
    const needs: unknown = jobMap.get("needs");
    const needList = typeof needs === "string" ? [needs] : strArray(needs);
    if (needList.length === 0) hasJobWithoutNeeds = true;
  }

  const dispatch = parseDispatchConfig(root.get("on"));
  let errMsg: string | null = null;
  if (!hasJobWithoutNeeds) errMsg = workflowDispatchInputsLocale.noJobWithoutNeeds;
  if (emptyJobsNumber === jobs.size) errMsg = workflowDispatchInputsLocale.noJob;
  return { errMsg, dispatch };
}

/** WorkflowDispatchConfig (workflow.go:139-156) + the inputs walk
 *  (workflow.go:159-178 — declaration order, the module header's note). */
function parseDispatchConfig(on: unknown): { inputs: WorkflowDispatchInput[] } | null {
  if (Array.isArray(on)) {
    return (on as unknown[]).includes("workflow_dispatch") ? { inputs: [] } : null;
  }
  if (typeof on === "string") {
    // nodeAsStringSlice's scalar arm — `on: workflow_dispatch`.
    return on === "workflow_dispatch" ? { inputs: [] } : null;
  }
  const onMap = asUnknownMap(on);
  if (onMap !== null) {
    const entry: unknown = onMap.get("workflow_dispatch");
    if (entry === undefined) return null;
    if (entry === null) return { inputs: [] }; // `workflow_dispatch:` with no inputs
    const entryMap = asUnknownMap(entry);
    if (entryMap === null) return null; // the decode-failure arm
    // WorkflowDispatch's `inputs` FIELD (workflow.go:114-115) — the dispatch
    // entry is `{ inputs: { <name>: <input> } }`, not the inputs map itself.
    const inputsRaw: unknown = entryMap.get("inputs");
    if (inputsRaw === undefined || inputsRaw === null) return { inputs: [] };
    const inputsNode = asUnknownMap(inputsRaw);
    if (inputsNode === null) return null; // the decode-failure arm
    const inputs: WorkflowDispatchInput[] = [];
    for (const [name, raw] of inputsNode) {
      if (typeof name !== "string") continue;
      const rawMap = asUnknownMap(raw);
      const input: WorkflowDispatchInput = rawMap
        ? {
            name,
            description: strField(rawMap.get("description")),
            required: rawMap.get("required") === true,
            default: strField(rawMap.get("default")),
            type: strField(rawMap.get("type")),
            options: strArray(rawMap.get("options")),
          }
        : // A scalar entry decodes to the zero input (Go's decode keeps
          // the map key with a zero struct — the name still lists).
          { name, description: "", required: false, default: "", type: "", options: [] };
      inputs.push(input);
    }
    return { inputs };
  }
  // A bare `on:` (null) or `on: true` — the null node's Value "" and the
  // bool's "true" never equal the event name (workflow.go:142-147).
  return null;
}

function strField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------
// The fragment render (repo/actions/workflow_dispatch_inputs.tmpl, verbatim)
// ---------------------------------------------------------------------------

export interface WorkflowDispatchFragmentData {
  /** The `?workflow=` id (the error messages interpolate it raw). */
  curWorkflow: string;
  /** The current workflow's light-validation ErrMsg — null when clean. */
  errMsg: string | null;
  /** Whether the id is present in the commit's workflow list
   *  (prepareWorkflowDispatchTemplate's CurWorkflowExists). */
  curWorkflowExists: boolean;
  /** WorkflowDispatchConfig — null renders the error-message arm. */
  dispatch: { inputs: WorkflowDispatchInput[] } | null;
}

/** The modal inputs body (the template's `{{if not .WorkflowDispatchConfig}}`
 *  split, the input field arms, the submit field, the ErrMsg arm — the
 *  all-workflows range collapses to the one conditional: the fragment only
 *  ever serves ONE workflow's view). hono/jsx escapes interpolations (the
 *  Go html/template posture — five entities). */
export function renderWorkflowDispatchInputsFragment(data: WorkflowDispatchFragmentData): string {
  return renderToString(
    <div id="runWorkflowDispatchModalInputs">
      {data.dispatch === null ? (
        <div class="ui error message tw-block">
          {data.curWorkflowExists
            ? tr(workflowDispatchInputsLocale.hasNoWorkflowDispatch, data.curWorkflow)
            : tr(workflowDispatchInputsLocale.notFound, data.curWorkflow)}
        </div>
      ) : (
        <>
          {data.dispatch.inputs.map((input) => (
            <DispatchInputField input={input} />
          ))}
          <div class="ui field">
            <button class="ui tiny primary button" autofocus type="submit">
              {workflowDispatchInputsLocale.run}
            </button>
          </div>
        </>
      )}
      {data.errMsg !== null ? (
        <div class="ui field">
          <div>
            <Icon name="octicon-alert" size={16} class="tw-text-red" /> {data.errMsg}
          </div>
        </div>
      ) : null}
    </div>,
  );
}

/** One input field (the template's four arms — choice/boolean/number/else;
 *  `{{or .Description .Name}}` labels). */
function DispatchInputField({ input }: { input: WorkflowDispatchInput }) {
  const label = input.description !== "" ? input.description : input.name;
  if (input.type === "choice") {
    return (
      <div class={`ui field${input.required ? " required" : ""}`}>
        <label>{label}:</label>
        <select class="ui search selection dropdown" name={input.name}>
          {input.options.map((option) => (
            <option value={option} selected={input.default === option}>
              {option}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (input.type === "boolean") {
    return (
      <div class={`ui field${input.required ? " required" : ""}`}>
        <label class="tw-flex flex-text-inline">
          <input type="checkbox" name={input.name} checked={input.default === "true" || input.default === "True" || input.default === "TRUE"} />
          {label}
        </label>
      </div>
    );
  }
  if (input.type === "number") {
    return (
      <div class={`ui field${input.required ? " required" : ""}`}>
        <label>{label}:</label>
        <input type="number" step="any" name={input.name} value={input.default} required={input.required} />
      </div>
    );
  }
  return (
    <div class={`ui field${input.required ? " required" : ""}`}>
      <label>{label}:</label>
      <input name={input.name} value={input.default} required={input.required} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The loader (WorkflowDispatchInputs + prepare*Template over the engine)
// ---------------------------------------------------------------------------

/** The engine read slice this arm consumes (the structural pair the
 *  ui/api engine clients share). */
export interface DispatchInputsReads {
  readCommit(id?: string): Promise<{ oid: string } | null>;
  listTree(ref?: string, path?: string): Promise<{ oid: string; entries: Array<{ name: string; type: string }> } | null>;
  readBlob(ref: string | undefined, path: string): Promise<{ oid: string; mode: string; data: Uint8Array } | null>;
}

/** The loader's repo subset (the caller's resolved row). */
export type DispatchInputsRepo = { id: string; ownerNamespace: string; slug: string; defaultBranch: string };

export interface WorkflowDispatchInputsInput {
  /** The engine read slice (the structural pair the ui/api engine clients
   *  share) — the fragment's only data source (the store-backed arms are
   *  the documented-unreachable ActionsConfig/scoped pair). */
  reads: DispatchInputsReads;
  repo: DispatchInputsRepo;
  /** The `?ref=` value — a FULL ref name (refs/heads/* or refs/tags/*; the
   *  modal's branch dropdown composes exactly those two shapes). */
  ref: string;
  /** The `?workflow=` id. */
  workflow: string;
  /** The `?scoped_workflow_source_repo_id=` parse (FormInt64 — junk → 0). */
  scopedWorkflowSourceRepoId: number;
}

export type WorkflowDispatchInputsOutcome =
  | { status: "not-found" }
  | { status: "throw"; reason: string }
  | { status: "ok"; html: string };

/** setting.Actions.WorkflowDirs' default (the runs-list/workflow modules'
 *  twin constant). */
const WORKFLOW_DIRS = [".gitea/workflows", ".github/workflows"];

/**
 * The WorkflowDispatchInputs arm over one (ref, workflow) pair. The v1
 * fragment reads NOTHING from the store (the ActionsConfig disabled check
 * and the scoped walk are the documented-unreachable arms) — the engine
 * reads carry the whole answer.
 */
export async function loadWorkflowDispatchInputsFragment(input: WorkflowDispatchInputsInput): Promise<WorkflowDispatchInputsOutcome> {
  const { reads, ref, workflow, scopedWorkflowSourceRepoId } = input;

  if (ref === "") {
    return { status: "not-found" }; // actions.go:174-177's FormString miss
  }
  if (scopedWorkflowSourceRepoId > 0) {
    // The scoped arm's documented reduction (the module header): no source
    // substrate exists in v1, the walk is never fabricated.
    return { status: "not-found" };
  }

  // The ref-type parse (actions.go:178-185): tags and branches only.
  const isTag = ref.startsWith("refs/tags/");
  const isBranch = ref.startsWith("refs/heads/");
  if (!isTag && !isBranch) {
    return { status: "throw", reason: "WorkflowDispatchInputs: UnsupportedRefType" };
  }

  // GetTagCommit/GetBranchCommit (actions.go:186-198) — the engine's
  // readCommit accepts the full ref; a miss is upstream's ServerError.
  const commit = await reads.readCommit(ref);
  if (commit === null) {
    return { status: "throw", reason: "WorkflowDispatchInputs: GetTagCommit/GetBranchCommit not found" };
  }

  // prepareWorkflowTemplate's ListWorkflows walk (actions.go:210) — the
  // first existing dir wins, .yml/.yaml blobs (workflows.go:110-113).
  let dir: string | null = null;
  let entries: Array<{ name: string; type: string }> = [];
  for (const candidate of WORKFLOW_DIRS) {
    const tree = await reads.listTree(ref, candidate);
    if (tree !== null) {
      dir = candidate;
      entries = tree.entries;
      break;
    }
  }

  // The `?workflow=` id locates the current file (the base-segment match —
  // the repo-actions-workflow module's store-spelling divergence).
  const curExists =
    dir !== null &&
    entries.some(
      (entry) =>
        entry.type === "blob" &&
        (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) &&
        entry.name === baseSegment(workflow),
    );

  let errMsg: string | null = null;
  let dispatch: { inputs: WorkflowDispatchInput[] } | null = null;
  if (curExists && dir !== null) {
    // prepareWorkflowTemplate's per-file parse — the CURRENT file only (the
    // all-workflows walk feeds the page sidebar; the fragment renders one).
    const entryName = entries.find((entry) => entry.type === "blob" && entry.name === baseSegment(workflow))?.name;
    if (entryName !== undefined) {
      const blob = await reads.readBlob(ref, `${dir}/${entryName}`);
      if (blob === null) {
        // GetContentFromEntry's error arm is upstream's ServerError.
        return { status: "throw", reason: `WorkflowDispatchInputs: GetContentFromEntry ${dir}/${entryName} failed` };
      }
      const parsed = parseWorkflowDispatchInputs(new TextDecoder().decode(blob.data));
      errMsg = parsed.errMsg;
      dispatch = parsed.dispatch;
    }
  }

  return {
    status: "ok",
    html: renderWorkflowDispatchInputsFragment({
      curWorkflow: workflow,
      errMsg,
      curWorkflowExists: curExists,
      dispatch,
    }),
  };
}

/** The path/id's last segment (the repo-actions-workflow module's twin). */
function baseSegment(id: string): string {
  const at = id.lastIndexOf("/");
  return at < 0 ? id : id.slice(at + 1);
}
