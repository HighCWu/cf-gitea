/**
 * The workflow DISPATCH producer — the ⑲A4 row's POST /actions/run arm
 * (docs/compat/v1.5.2-ledger.md §1.6), ported from upstream
 * services/actions/workflow.go:64-199 `DispatchActionWorkflow` (repo-level
 * arm) plus the view.go:1378-1419 `actions.Run` handler's input-processing
 * closure. The service carries the store + engine work; the route handler
 * (the orchestrator-owned ui/index.ts mount) owns the form parse and the
 * wire answers.
 *
 * Upstream pin (VERIFIED at fc4936884584a41931906553d96c2601d750e6ef):
 *   - DispatchActionWorkflow (workflow.go:64-199): the empty workflow/ref
 *     guards (:65-77 — translatable not-exist), the ActionsConfig disabled
 *     check (:85-99, IsWorkflowDisabled for repo-level workflows), the
 *     ref's commit resolution (:101-124 — refs/tags/* → GetTagCommit,
 *     refs/heads/* → GetBranchCommit, anything else re-read as a BRANCH
 *     name, a miss → form.target_ref_not_exist), the run skeleton
 *     (:126-144 — event/trigger_event "workflow_dispatch",
 *     IsForkPullRequest false, Title = the commit's MessageTitle, Ref = the
 *     NORMALIZED RefName), the content resolution (:193-214's repo-level
 *     arm — the workflow-dir walk, the exact-entry match), the
 *     WorkflowDispatchConfig presence check (:165-170 — the
 *     has_no_workflow_dispatch error), the processInputs closure
 *     (:167-172) + coerceDispatchInputTypes (:201-210 — boolean-typed
 *     inputs become real bools via ParseYamlBool), the
 *     WorkflowDispatchPayload JSON (:174-193 — workflow/ref/inputs/
 *     repository/sender, `inputs` stringified via CoerceToString), and
 *     PrepareRunAndInsert with the inputs threaded (:195-198 — the
 *     landed insertTriggeredRunSplit's new optional `inputs` parameter).
 *   - actions.Run's closure (view.go:1397-1404): per declared input —
 *     boolean → strconv.FormatBool(FormBool(name)); otherwise the POST form
 *     value when non-empty, else the declaration's default.
 *
 * ## Outcomes (the handler's three wires)
 *
 *   - "ok" — the run landed; the handler answers upstream's
 *     ctx.Flash.Success + ctx.Redirect (the no-session-flash reduction
 *     303s onto the actions-list URL, the secrets-family convention).
 *   - "translatable" — the user-facing failure upstream reports through
 *     Flash.Error + Redirect (workflow.go:186-191's ErrorAsTranslatable
 *     arm): disabled, unknown ref/workflow, invalid workflow, no dispatch
 *     trigger. The same 303 answers (the flash text has no session store
 *     to ride — the repoActionsSecretsSubmit posture); the message rides
 *     the outcome for tests and future flash plumbing.
 *   - "throw" — the ServerError arms (the empty workflow/ref guards, an
 *     unreadable engine surface): the handler throws into the 500 chrome.
 *
 * ## Documented reductions (§6 method — each cites its upstream arm)
 *
 * - The SCOPED arm (workflow.go:84's isScoped branch →
 *   resolveScopedDispatchContent's source-repo walk) has no store substrate
 *   in v1 (the scoped family is C10/post-M3, is_scoped_run is never
 *   written): a `scoped_workflow_source_repo_id` > 0 answers the
 *   dispatch-inputs fragment's same not-found reduction — never a
 *   fabricated source walk.
 * - The jobparser validation pass is the LIGHT check — the exact parser
 *   the dispatch-inputs fragment landed (repo-actions-dispatch-inputs.tsx's
 *   parseWorkflowDispatchInputs, imported here per the upload-staging
 *   precedent of a service consuming a page module's pure helper): the
 *   invalid_workflow_helper text carries the parse/needs/jobs arms the
 *   light pass sees; the reusable-`uses:` resolution and the
 *   expression-bearing static scan are M3's.
 * - The payload's `repository`/`sender` objects stay `{}`-shaped — the
 *   buildPushEventPayload convention (trigger.ts): the claim context reads
 *   the identity through its own dedicated fields, and the full webhook
 *   identity objects ride the webhook family's payloads.
 * - `run.WorkflowID` keeps the caller's id verbatim (upstream
 *   run.WorkflowID = workflowID, :139); the content match is on the entry's
 *   BASE name (upstream's TreeEntry.Name() — the fragment's baseSegment
 *   twin, tolerating a caller that passes a path-shaped id).
 */

import {
  insertTriggeredRunSplit,
  readWorkflowRawConcurrency,
  type TriggerRunOutcome,
} from "./trigger";
import { loadRepoActionsConfig, type RepoActionsConfig } from "./config";
import {
  parseWorkflowDispatchInputs,
  type WorkflowDispatchInput,
} from "../../ui/pages/repo-actions-dispatch-inputs";

// ---------------------------------------------------------------------------
// The en-US wires (workflow.go's ErrorWrapTranslatable keys at the pin)
// ---------------------------------------------------------------------------

export const workflowDispatchLocale = {
  targetRefNotExist: "Target ref does not exist %s", // "form.target_ref_not_exist"
  workflowNotFound: "Workflow '%s' not found.", // "actions.workflow.not_found"
  workflowDisabled: "Workflow is disabled.", // "actions.workflow.disabled"
  invalidWorkflow: "Workflow config file is invalid. Please check your config file: %s", // "actions.runs.invalid_workflow_helper"
  hasNoWorkflowDispatch: "Workflow '%s' has no workflow_dispatch event trigger.", // "actions.workflow.has_no_workflow_dispatch"
  runSuccess: "Workflow '%s' run successfully.", // "actions.workflow.run_success" (the dropped flash text)
} as const;

/** Go fmt %s substitution (TrString's arg arm — one string arg each). */
function tr(text: string, arg: string): string {
  return text.replace("%s", arg);
}

// ---------------------------------------------------------------------------
// The reads (the engine slice this service consumes — the dispatch-inputs
// fragment's DispatchInputsReads pair plus nothing else)
// ---------------------------------------------------------------------------

export interface WorkflowDispatchReads {
  readCommit(id?: string): Promise<{ oid: string; subject: string } | null>;
  listTree(ref?: string, path?: string): Promise<{ oid: string; entries: Array<{ name: string; type: string }> } | null>;
  readBlob(ref: string | undefined, path: string): Promise<{ oid: string; mode: string; data: Uint8Array } | null>;
}

/** The repo subset the caller resolves (the fragment loader's shape). */
export type WorkflowDispatchRepo = {
  id: string;
  ownerId: number | null;
  ownerNamespace: string;
  slug: string;
  defaultBranch: string;
};

export interface WorkflowDispatchInputRequest {
  d1: D1Database;
  reads: WorkflowDispatchReads;
  repo: WorkflowDispatchRepo;
  /** The `?workflow=` id (view.go:1382's FormString). */
  workflowId: string;
  /** The `ref` form value (view.go:1389's FormString — the RAW string; the
   *  payload carries it verbatim, workflow.go:179). */
  ref: string;
  /** `scoped_workflow_source_repo_id` (FormInt64 junk → 0) — the scoped arm
   *  is the documented not-found reduction (the module header). */
  scopedWorkflowSourceRepoId: number;
  /** The dispatch form's string map (the handler's readUrlEncodedForm
   *  product — PostFormValue's name→value universe). */
  form: Record<string, string>;
  /** ctx.Doer.ID. */
  triggerUserId: number;
  /** The instance origin (the github context's server_url). */
  appUrl: string;
}

export type WorkflowDispatchOutcome =
  | ({ status: "ok" } & TriggerRunOutcome)
  | { status: "translatable"; message: string }
  | { status: "throw"; reason: string };

/** setting.Actions.WorkflowDirs' default (the runs-list/fragment twin). */
const WORKFLOW_DIRS = [".gitea/workflows", ".github/workflows"];

/** FormBool (services/context/base_form.go:61-67): ParseBool's set plus the
 *  case-insensitive "on" — the HTML checkbox's posted value. */
function formBool(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const parsed = raw === "1" || raw === "t" || raw === "T" || raw === "TRUE" || raw === "true" || raw === "True";
  return parsed || raw.toLowerCase() === "on";
}

/** CoerceToString's dispatch-inputs arms (exprparser): the typed values at
 *  this point are strings and booleans only — bool renders "true"/"false". */
function coerceToString(value: string | boolean): string {
  return typeof value === "boolean" ? (value ? "true" : "false") : value;
}

/**
 * DispatchActionWorkflow's repo-level arm. On "ok" the run + its attempt-1
 * jobs are inserted (waiting/pending), the task version bumped and the
 * commit statuses posted — the landed insert's post-commit legs.
 */
export async function dispatchWorkflow(input: WorkflowDispatchInputRequest): Promise<WorkflowDispatchOutcome> {
  const { d1, reads, repo, workflowId, ref, scopedWorkflowSourceRepoId, form, triggerUserId, appUrl } = input;

  // The empty guards (workflow.go:65-77) — the Run handler pre-checks both
  // with ServerError (view.go:1384-1394); the service carries the same
  // translatable texts, the handler's guard answering first in practice.
  if (workflowId === "") {
    return { status: "throw", reason: "workflow dispatch: workflow is required" };
  }
  if (ref === "") {
    return { status: "throw", reason: "workflow dispatch: ref is required" };
  }
  if (scopedWorkflowSourceRepoId > 0) {
    // The scoped arm's documented reduction (the module header).
    return { status: "translatable", message: tr(workflowDispatchLocale.workflowNotFound, workflowId) };
  }

  // The ActionsConfig disabled check (workflow.go:85-99's repo-level arm).
  const cfg: RepoActionsConfig = await loadRepoActionsConfig(d1, repo.id);
  if (cfg.disabledWorkflows.includes(workflowId)) {
    return { status: "translatable", message: workflowDispatchLocale.workflowDisabled };
  }

  // The ref's commit resolution (workflow.go:101-124): tags and full branch
  // refs ride the engine's ref-aware readCommit; anything else re-reads as
  // a BRANCH name (RefNameFromBranch). A miss is the translatable ref arm.
  const refName = ref.startsWith("refs/tags/") || ref.startsWith("refs/heads/") ? ref : `refs/heads/${ref}`;
  const commit = await reads.readCommit(refName);
  if (commit === null) {
    return { status: "translatable", message: tr(workflowDispatchLocale.targetRefNotExist, ref) };
  }

  // The content resolution (workflow.go:193-207's repo-level arm): the
  // workflow-dir walk at the commit, the exact-entry match on the BASE
  // name. The engine's one-level listTree is the module-header reduction.
  let dir: string | null = null;
  let entries: Array<{ name: string; type: string }> = [];
  for (const candidate of WORKFLOW_DIRS) {
    const tree = await reads.listTree(refName, candidate);
    if (tree !== null) {
      dir = candidate;
      entries = tree.entries;
      break;
    }
  }
  const baseName = baseSegment(workflowId);
  const entryName = entries.find(
    (entry) => entry.type === "blob" && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")) && entry.name === baseName,
  )?.name;
  if (dir === null || entryName === undefined) {
    return { status: "translatable", message: tr(workflowDispatchLocale.workflowNotFound, workflowId) };
  }
  const blob = await reads.readBlob(refName, `${dir}/${entryName}`);
  if (blob === null) {
    // GetContentFromEntry's error arm — upstream's ServerError class.
    return { status: "throw", reason: `workflow dispatch: GetContentFromEntry ${dir}/${entryName} failed` };
  }
  const content = new TextDecoder().decode(blob.data);

  // The light validation + the dispatch-config presence (workflow.go:146-170
  // at the light-check stage — the module header).
  const parsed = parseWorkflowDispatchInputs(content);
  if (parsed.errMsg !== null) {
    return { status: "translatable", message: tr(workflowDispatchLocale.invalidWorkflow, parsed.errMsg) };
  }
  if (parsed.dispatch === null) {
    return { status: "translatable", message: tr(workflowDispatchLocale.hasNoWorkflowDispatch, workflowId) };
  }

  // processInputs (view.go:1397-1404) + coerceDispatchInputTypes
  // (workflow.go:201-210): booleans type FIRST (FormatBool(FormBool)), then
  // the declared boolean type re-coerces the string back to a real bool —
  // net: a typed bool. Everything else: the form value when non-empty,
  // else the declaration's default.
  const typed: Record<string, string | boolean> = {};
  for (const declared of parsed.dispatch.inputs) {
    typed[declared.name] = coerceDeclared(declared, form);
  }

  // The payload's `inputs` field — dispatchEventInputs (workflow.go:213-219),
  // CoerceToString's stringify.
  const eventInputs: Record<string, string> = {};
  for (const [name, value] of Object.entries(typed)) {
    eventInputs[name] = coerceToString(value);
  }

  // WorkflowDispatchPayload.JSONPayload (workflow.go:174-193) — the
  // repository/sender objects stay {}-shaped (the buildPushEventPayload
  // convention, the module header).
  const eventPayloadJson = JSON.stringify({
    workflow: workflowId,
    ref,
    inputs: eventInputs,
    repository: {},
    sender: {},
  });

  // PrepareRunAndInsert (workflow.go:195-198) with the inputs threaded —
  // the landed insert's optional `inputs` parameter (jobparser.WithInputs'
  // expression surface). Title = MessageTitle = the commit subject; Ref =
  // the NORMALIZED RefName (workflow.go:132/141).
  const outcome = await insertTriggeredRunSplit(
    d1,
    {
      repoId: repo.id,
      ownerId: repo.ownerId ?? 0,
      workflowId,
      triggerUserId,
      ref: refName,
      commitSha: commit.oid,
      isForkPullRequest: false,
      event: "workflow_dispatch",
      eventPayloadJson,
      triggerEvent: "workflow_dispatch",
      title: commit.subject,
      repoOwnerNamespace: repo.ownerNamespace,
      repoSlug: repo.slug,
      appUrl,
    },
    content,
    readWorkflowRawConcurrency(content),
    typed,
  );
  return { status: "ok", run: outcome.run, jobs: outcome.jobs };
}

/** One declared input's processInputs + coercion arm. */
function coerceDeclared(declared: WorkflowDispatchInput, form: Record<string, string>): string | boolean {
  if (declared.type === "boolean") {
    return formBool(form[declared.name]);
  }
  const value = form[declared.name];
  return value !== undefined && value !== "" ? value : declared.default;
}

/** The path/id's last segment (the fragment loader's twin). */
function baseSegment(id: string): string {
  const at = id.lastIndexOf("/");
  return at < 0 ? id : id.slice(at + 1);
}
