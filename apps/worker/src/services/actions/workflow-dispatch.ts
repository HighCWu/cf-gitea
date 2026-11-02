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
 *     check (:85-99 — IsWorkflowDisabled for repo-level workflows, the
 *     IsScopedWorkflowOptedOut read for the scoped arm), the
 *     ref's commit resolution (:101-124 — refs/tags/* → GetTagCommit,
 *     refs/heads/* → GetBranchCommit, anything else re-read as a BRANCH
 *     name, a miss → form.target_ref_not_exist), the run skeleton
 *     (:126-144 — event/trigger_event "workflow_dispatch",
 *     IsForkPullRequest false, Title = the commit's MessageTitle, Ref = the
 *     NORMALIZED RefName), the content resolution (:193-236 — the
 *     repo-level arm is the workflow-dir walk with the exact-entry match;
 *     the scoped arm resolveScopedDispatchContent (:237-268) demands an
 *     EFFECTIVE source (IsScopedWorkflowSourceEffective), walks the SOURCE
 *     repo's default branch (LoadParsedScopedWorkflows) and records the
 *     content's (repo, commit) on the run: WorkflowRepoID = sourceRepo.ID,
 *     WorkflowCommitSHA = the source sha, IsScopedRun = true), the
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
 *     unreadable engine or store surface): the handler throws into the 500
 *     chrome.
 *
 * ## The scoped arm (the C10 half-stage — resolveScopedDispatchContent's
 * port, workflow.go:237-268)
 *
 * `scopedWorkflowSourceRepoId` carries the SOURCE repo's id; "" is the
 * repo-level arm. Upstream's form value is FormInt64 over an int64 repo id
 * space; ours is the TEXT repositories.id space verbatim (the schema's own
 * TEXT adaptation, schema.ts:3931). The landed wire keeps upstream's zero
 * semantics through config.ts's scopedSourceRepoParam: "" (absent) and "0"
 * (the landed page's dispatch form always posts it) are the repo-level
 * arm; every other nonempty value rides verbatim as a source-id candidate
 * (a bogus one dies on the effective-source gate below — the recorded
 * divergence from upstream's junk→0 fallback).
 * The arm:
 *   1. the opt-out disabled check (workflow.go:84-99's isScoped branch —
 *     config.ts's isScopedWorkflowOptedOut, the flagged-disabled AND
 *     not-required read with upstream's cheap early-out);
 *   2. the source must be EFFECTIVE for the consumer's owner
 *     (IsScopedWorkflowSourceEffective — a miss answers the same
 *     actions.workflow.not_found translatable, :241-249);
 *   3. the source repo row (GetRepositoryByID, :251-254 — the miss is the
 *     ServerError class upstream, our "throw" arm);
 *   4. the source's DEFAULT-BRANCH content walk (LoadParsedScopedWorkflows
 *     → ParseScopedWorkflows' ListScopedWorkflows — the SCOPED_WORKFLOW_DIRS
 *     walk at the source's default-branch HEAD, the entry-name match);
 *     a missing workflow answers not-found (:260-267);
 *   5. the run records its content source: WorkflowCommitSHA rides the
 *     shared insert's workflowSha input (upstream's pre-insert skeleton
 *     field, :139-142 — the SOURCE sha on this arm, the run commit on the
 *     repo-level arm), so github.workflow_sha (context.go:115) and the
 *     workflow_commit_sha column carry the content commit from birth; the
 *     post-insert UPDATE writes the remaining pair workflow_repo_id/
 *     is_scoped_run (:260-263 — the shared input carries no fields for
 *     them yet, so the scoped arm compensates right after — one extra
 *     UPDATE the repo-level arm never takes). The first PRODUCER of the
 *     is_scoped_run parity column (SPEC-0012 §1.4's "schema lands,
 *     nothing writes" note is superseded for this arm).
 *
 * The former `workflow_sha` residual is LANDED (SPEC-0013 §6): the shared
 * insert grew the workflowSha input, so a scoped run's github.workflow_sha
 * carries the SOURCE commit (context.go:115's run.WorkflowCommitSHA) while
 * github.sha / commit_sha keep the consumer ref's commit — upstream's
 * exact split (workflow.go:126-142 builds CommitSHA = runTargetCommit and
 * WorkflowCommitSHA = the content source as two independent skeleton
 * fields). A repo-level dispatch keeps them equal (workflow.go:136-137).
 *
 * ## Documented reductions (§6 method — each cites its upstream arm)
 *
 * - The source walk reads the SCOPED_WORKFLOW_DIRS entries and matches the
 *   entry name; upstream parses every file first (ParseScopedWorkflows'
 *   GetEventsFromContent pass — an undecodable `on:` file is dropped
 *   BEFORE the match, scoped_workflows.go:50-52) and returns the matched
 *   file's content. Ours matches first and applies the LIGHT validation
 *   after (the invalid/has_no_dispatch translatables below) — a file with
 *   a broken `on:` answers the invalid arm instead of not-found, the
 *   light-check class the module already records.
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
 *   identity objects ride the webhook family's payloads. (Upstream's
 *   scoped payload keeps the CONSUMER repo/sender — ours does too, shaped
 *   the same as the repo-level arm.)
 * - `run.WorkflowID` keeps the caller's id verbatim (upstream
 *   run.WorkflowID = workflowID, :139); the content match is on the entry's
 *   BASE name (upstream's TreeEntry.Name() — the fragment's baseSegment
 *   twin, tolerating a caller that passes a path-shaped id).
 * - No LRU cache: upstream's scopedWorkflowCache (scoped_workflow_cache.go)
 *   is a process-lru keyed by source id at the parsed HEAD; the Worker's
 *   per-request process makes every dispatch a fresh walk (correctness
 *   identical, cost bounded by the walk's three engine reads).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  insertTriggeredRunSplit,
  readWorkflowRawConcurrency,
  type TriggerRunOutcome,
} from "./trigger";
import { actionRuns, repositories } from "../../db/schema";
import {
  isScopedWorkflowOptedOut,
  isScopedWorkflowSourceEffective,
  loadRepoActionsConfig,
  scopedSourceRepoParam,
  type RepoActionsConfig,
} from "./config";
import { SCOPED_WORKFLOW_DIRS } from "./scoped-workflows";
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
  /** `scoped_workflow_source_repo_id` — the SOURCE repo's TEXT id; "" is
   *  the repo-level arm (upstream FormInt64's 0; the TEXT adaptation, the
   *  module header). */
  scopedWorkflowSourceRepoId: string;
  /** The engine reads for an arbitrary repo full name — the scoped arm's
   *  SOURCE walk (resolveScopedDispatchContent opens the source repo the
   *  way upstream's service does, LoadParsedScopedWorkflows). The repo-level
   *  arm never calls it. */
  sourceEngineFor: (fullName: string) => WorkflowDispatchReads;
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
 * DispatchActionWorkflow's port (the repo-level AND scoped arms). On "ok"
 * the run + its attempt-1 jobs are inserted (waiting/pending), the task
 * version bumped and the commit statuses posted — the landed insert's
 * post-commit legs; a scoped run additionally carries its content-source
 * columns (the module header's post-insert UPDATE).
 */
export async function dispatchWorkflow(input: WorkflowDispatchInputRequest): Promise<WorkflowDispatchOutcome> {
  const { d1, reads, repo, workflowId, ref, sourceEngineFor, form, triggerUserId, appUrl } = input;
  // The param's TEXT adaptation (scopedSourceRepoParam — the landed page's
  // dispatch form always posts "0", upstream FormInt64's repo-level zero).
  const scopedWorkflowSourceRepoId = scopedSourceRepoParam(input.scopedWorkflowSourceRepoId);
  const isScoped = scopedWorkflowSourceRepoId !== "";

  // The empty guards (workflow.go:65-77) — the Run handler pre-checks both
  // with ServerError (view.go:1384-1394); the service carries the same
  // translatable texts, the handler's guard answering first in practice.
  if (workflowId === "") {
    return { status: "throw", reason: "workflow dispatch: workflow is required" };
  }
  if (ref === "") {
    return { status: "throw", reason: "workflow dispatch: ref is required" };
  }

  // The ActionsConfig disabled check (workflow.go:85-99): the repo-level
  // arm reads DisabledWorkflows; the scoped arm reads the opt-out store
  // (IsScopedWorkflowOptedOut — flagged disabled AND not required, with
  // upstream's unflagged early-out).
  const cfg: RepoActionsConfig = await loadRepoActionsConfig(d1, repo.id);
  if (isScoped) {
    if (await isScopedWorkflowOptedOut(d1, cfg, repo.ownerId ?? 0, scopedWorkflowSourceRepoId, workflowId)) {
      return { status: "translatable", message: workflowDispatchLocale.workflowDisabled };
    }
  } else if (cfg.disabledWorkflows.includes(workflowId)) {
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

  // The content resolution (workflow.go:193-236's repo-level arm / the
  // scoped :237-268 arm). The engine's one-level listTree is the
  // module-header reduction.
  let content: string;
  let scopedSource: { repoId: string; sha: string } | null = null;
  if (isScoped) {
    const resolved = await resolveScopedDispatchContent(d1, repo, sourceEngineFor, scopedWorkflowSourceRepoId, workflowId);
    if (resolved.outcome !== null) return resolved.outcome;
    content = resolved.content;
    scopedSource = { repoId: resolved.sourceRepoId, sha: resolved.sourceSha };
  } else {
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
    content = new TextDecoder().decode(blob.data);
  }

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
  // the NORMALIZED RefName (workflow.go:132/141). workflowSha carries the
  // skeleton's WorkflowCommitSHA (workflow.go:137's runTargetCommit on the
  // repo-level arm — the run commit itself; workflow.go:266's source HEAD
  // on the scoped arm), so github.workflow_sha (context.go:115) and the
  // row's workflow_commit_sha column carry the content commit from birth.
  const outcome = await insertTriggeredRunSplit(
    d1,
    {
      repoId: repo.id,
      ownerId: repo.ownerId ?? 0,
      workflowId,
      triggerUserId,
      ref: refName,
      commitSha: commit.oid,
      workflowSha: scopedSource !== null ? scopedSource.sha : undefined,
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

  // The scoped run's remaining content-source columns (workflow.go:139-142's
  // WorkflowRepoID skeleton + :260-263's IsScopedRun): upstream sets the
  // fields on the run BEFORE PrepareRunAndInsert; the shared insert's input
  // carries the workflowSha half (above) but not these two, so the scoped
  // arm compensates right after (the module header). The in-memory row
  // mirrors the write.
  if (scopedSource !== null) {
    await drizzle(d1)
      .update(actionRuns)
      .set({ workflowRepoId: scopedSource.repoId, isScopedRun: true })
      .where(eq(actionRuns.id, outcome.run.id));
    outcome.run.workflowRepoId = scopedSource.repoId;
    outcome.run.isScopedRun = true;
  }
  return { status: "ok", run: outcome.run, jobs: outcome.jobs };
}

/**
 * resolveScopedDispatchContent (workflow.go:237-268): the source must be an
 * EFFECTIVE scoped source for the consumer's owner (a miss answers the same
 * actions.workflow.not_found translatable, :241-249), then the source repo
 * row (GetRepositoryByID — the miss is the ServerError class, our throw),
 * then the source's default-branch SCOPED_WORKFLOW_DIRS walk
 * (LoadParsedScopedWorkflows' ListScopedWorkflows half) with the entry-name
 * match. Returns the content plus the (repo, commit) the run records.
 */
async function resolveScopedDispatchContent(
  d1: D1Database,
  repo: WorkflowDispatchRepo,
  sourceEngineFor: (fullName: string) => WorkflowDispatchReads,
  sourceRepoId: string,
  workflowId: string,
): Promise<{ outcome: WorkflowDispatchOutcome | null; content: string; sourceRepoId: string; sourceSha: string }> {
  if (!(await isScopedWorkflowSourceEffective(d1, repo.ownerId ?? 0, sourceRepoId))) {
    return {
      outcome: { status: "translatable", message: tr(workflowDispatchLocale.workflowNotFound, workflowId) },
      content: "",
      sourceRepoId,
      sourceSha: "",
    };
  }

  // GetRepositoryByID (:251-254) — the row miss is upstream's ServerError
  // class (the error propagates un-translated).
  const sourceRows = await drizzle(d1)
    .select({ id: repositories.id, ownerNamespace: repositories.ownerNamespace, slug: repositories.slug, defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .where(eq(repositories.id, sourceRepoId))
    .limit(1);
  const sourceRepo = sourceRows[0];
  if (sourceRepo === undefined) {
    return {
      outcome: { status: "throw", reason: `workflow dispatch: GetRepositoryByID ${sourceRepoId} failed` },
      content: "",
      sourceRepoId,
      sourceSha: "",
    };
  }

  // LoadParsedScopedWorkflows (scoped_workflow_cache.go:39-70): the source's
  // default-branch HEAD, then ParseScopedWorkflows' ListScopedWorkflows —
  // the FIRST scoped dir that exists, its .yml/.yaml entries (the walk's
  // one-level reduction, the repo-level twin's note). An unresolvable
  // source HEAD is the GetBranchExisting error arm — the ServerError class.
  const sourceReads = sourceEngineFor(`${sourceRepo.ownerNamespace}/${sourceRepo.slug}`);
  const sourceRef = `refs/heads/${sourceRepo.defaultBranch}`;
  const sourceHead = await sourceReads.readCommit(sourceRef);
  if (sourceHead === null) {
    return {
      outcome: { status: "throw", reason: `workflow dispatch: source default branch ${sourceRepoId}@${sourceRef} unresolvable` },
      content: "",
      sourceRepoId,
      sourceSha: "",
    };
  }

  let dir: string | null = null;
  let entries: Array<{ name: string; type: string }> = [];
  for (const candidate of SCOPED_WORKFLOW_DIRS) {
    const tree = await sourceReads.listTree(sourceRef, candidate);
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
    // the parsed set has no such EntryName (:260-267's not-found)
    return {
      outcome: { status: "translatable", message: tr(workflowDispatchLocale.workflowNotFound, workflowId) },
      content: "",
      sourceRepoId,
      sourceSha: sourceHead.oid,
    };
  }
  const blob = await sourceReads.readBlob(sourceRef, `${dir}/${entryName}`);
  if (blob === null) {
    // GetContentFromEntry's error arm — upstream's ServerError class.
    return {
      outcome: { status: "throw", reason: `workflow dispatch: GetContentFromEntry ${dir}/${entryName} (source ${sourceRepoId}) failed` },
      content: "",
      sourceRepoId,
      sourceSha: sourceHead.oid,
    };
  }
  return { outcome: null, content: new TextDecoder().decode(blob.data), sourceRepoId: sourceRepo.id, sourceSha: sourceHead.oid };
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
